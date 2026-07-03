"use strict";

/**
 * 청구(invoices) 도메인 — 금액/상태 파생, 채번, 청구 초안·생성·삭제, 목록·통계, 청구 후보/스냅샷.
 * 돈=정수(원), VAT=공급가 10%(부가세 미포함 시 0). 발행=확정(수정 없음, 변경=삭제 후 재발행).
 * data.js에서 분리한 모듈(도메인 모듈화). data.js가 재export하므로 소비자 무변경.
 *
 * cross-domain: getProjectForUser(projects)·getClient(clients)·taskTypeLabel(task-types)는
 * 직접 require(무순환). sessionRateAmount(sessions)는 sessions↔invoices 상호의존이라
 * 함수 내부 지연 require("../data")로 해소(로드 시 순환 회피). computeInvoiceDraft는 내부 전용.
 */

const { db } = require("../db");
const { todayYmd, formatYmdShort } = require("../lib/date");
const { parseMoney } = require("../lib/forms");
const { canBill, canInvoice } = require("../auth");
const { getProjectForUser } = require("./projects"); // 무순환
const { getParty, listPersonsForOrg } = require("./parties"); // 무순환 — 청구처(payer)=parties.id

/**
 * 발행 시점 청구처(payer) 정보 스냅샷(JSON 문자열). 이후 클라이언트 정보가 바뀌어도 과거 청구서 표시/PDF가
 * 발행 당시 정보로 고정된다(회계·법적 기록 정확성). 표시·PDF는 스냅샷 우선, 없으면(레거시) 실시간 폴백.
 */
function snapshotPayer(payerId) {
  if (!payerId) return null;
  const p = getParty(payerId);
  if (!p) return null;
  const contacts = (listPersonsForOrg(payerId) || []).slice(0, 1);
  const c0 = contacts[0];
  return JSON.stringify({
    id: p.id,
    name: p.name || "",
    kind: p.kind || null,
    owner_name: p.owner_name || null,
    biz_no: p.biz_no || null,
    address: p.address || null,
    email: p.email || null,
    cash_receipt_no: p.cash_receipt_no || null,
    contacts: c0 ? [{ name: c0.name, phone: c0.phone || null, email: c0.email || null }] : [],
  });
}

/**
 * 청구처(payer) 후보별 발행 정보 — 회사=세금계산서 정보(사업자등록번호 biz_no) 보유, 개인=현금영수증 정보(cash_receipt_no) 보유 party id 집합.
 * 청구 생성 폼이 청구처 유형(회사=계산서 / 개인=현금영수증)·정보 누락 경고·차단에 쓴다.
 * (사업자등록증 파일은 첨부 서류일 뿐 세금계산서 발행 필수 아님 → biz_no 기준.)
 * @returns {{ taxInfoIds: number[], cashReceiptIds: number[] }}
 */
function payerDocMeta() {
  const taxInfoIds = db().prepare("SELECT id FROM parties WHERE kind='company' AND biz_no IS NOT NULL AND TRIM(biz_no) <> ''").all().map((r) => r.id);
  const cashReceiptIds = db().prepare("SELECT id FROM parties WHERE cash_receipt_no IS NOT NULL AND TRIM(cash_receipt_no) <> ''").all().map((r) => r.id);
  return { taxInfoIds, cashReceiptIds };
}

/**
 * 청구처 발행 정보 누락 검사 — 회사에 세금계산서 정보(biz_no)가 없거나, 개인에 현금영수증 정보(cash_receipt_no)가 없으면
 * 해당 에러 코드를 반환(청구 생성 차단용). 정보가 충분하면 null.
 * @returns {"PAYER_TAX_INFO_REQUIRED"|"PAYER_CASH_RECEIPT_REQUIRED"|null}
 */
function payerDocMissing(payer) {
  if (!payer) return null;
  const has = (v) => !!(v && String(v).trim());
  if (payer.kind === "company") return has(payer.biz_no) ? null : "PAYER_TAX_INFO_REQUIRED";
  return has(payer.cash_receipt_no) ? null : "PAYER_CASH_RECEIPT_REQUIRED"; // 개인·그룹 아티스트 등 = 현금영수증
}
const { taskTypeLabel } = require("./task-types"); // 무순환

const parseWon = parseMoney; // 내부 호출명 parseWon 유지

// ── 인보이스 금액/상태 파생(플레이북2 §4 payStatus/balanceOf) ──

/** 잔금(미수금) = 총액 - 입금액(음수 없음). */
function balanceOf(inv) {
  return Math.max((inv.amount || 0) - (inv.paid_amount || 0), 0);
}

/** 납입 상태: 미납 | 부분납 | 완납. */
function payStatusOf(inv) {
  const paid = inv.paid_amount || 0;
  if (paid <= 0) return "미납";
  if (paid >= (inv.amount || 0)) return "완납";
  return "부분납";
}

/** 연체: 발행 상태 + 마감 경과 + 잔금 존재. */
function isOverdue(inv) {
  return inv.status === "발행" && !!inv.due_date && todayYmd() > inv.due_date && balanceOf(inv) > 0;
}

// ── 청구 후보(프로젝트 단위) + 채번 + 스냅샷 조회 ──

function listUnbilledTasksForProject(user, projectId) {
  const project = getProjectForUser(user, projectId);
  if (!project) return null;
  const rows = db()
    .prepare(
      `SELECT t.*, tr.title AS track_title, tr.content_type, tr.project_id
       FROM track_tasks t
       JOIN project_tracks tr ON tr.id = t.track_id
       WHERE tr.project_id = ?
         AND t.is_invoiced = 0
       ORDER BY tr.created_at ASC, tr.id ASC, t.created_at ASC, t.id ASC`
    )
    .all(project.id);
  return { project, rows };
}

/** 청구 가능 녹음 세션(**완료**·녹음+단가+시간) 중 아직 청구/전환 안 된 것 — 세션 직접 청구 후보(완료 처리해야 노출). */
function listBillableSessionsForProject(user, projectId) {
  const { sessionRateAmount } = require("../data"); // sessions와 상호의존 → 지연 require
  const project = getProjectForUser(user, projectId);
  if (!project) return null;
  const rows = db()
    .prepare(
      `SELECT s.* FROM sessions s
       WHERE s.project_id = ?
         AND s.status <> '취소'
         AND s.session_type = '녹음'
         AND s.rate_item_id IS NOT NULL
         AND s.start_time IS NOT NULL AND s.end_time IS NOT NULL
         AND NOT EXISTS (SELECT 1 FROM invoice_items ii WHERE ii.session_id = s.id)
         AND NOT EXISTS (SELECT 1 FROM track_tasks tt WHERE tt.session_id = s.id)
       ORDER BY s.created_at ASC, s.id ASC`
    )
    .all(project.id)
    .map((row) => ({ ...row, billing: sessionRateAmount(row) }))
    .filter((row) => row.billing && row.billing.amount > 0);
  return { project, rows };
}

/** 세션이 인보이스에 직접 청구되었는지(invoice_items 역참조). 세션 수정·삭제 잠금 판별. */
function isSessionInvoiced(sessionId) {
  return !!db().prepare("SELECT 1 FROM invoice_items WHERE session_id = ? LIMIT 1").get(sessionId);
}

function listInvoiceItemsForInvoice(user, invoiceId) {
  const inv = getInvoiceForUser(user, invoiceId);
  if (!inv) return null;
  const rows = db()
    .prepare("SELECT * FROM invoice_items WHERE invoice_id = ? ORDER BY id ASC")
    .all(inv.id);
  return { invoice: inv, rows };
}

function nextInvoiceNumber(issueDate) {
  const ym = String(issueDate || todayYmd()).slice(0, 7).replace("-", "");
  // 채번 = OMG-YYYYMM-###. 기존 INV-·신규 OMG- 접두 모두 고려해 최대 일련번호+1(접두 전환에도 번호 연속·중복 없음).
  const rows = db().prepare("SELECT invoice_number FROM invoices WHERE invoice_number LIKE ? OR invoice_number LIKE ?").all(`INV-${ym}-%`, `OMG-${ym}-%`);
  let max = 0;
  for (const r of rows) { const m = String(r.invoice_number || "").match(/-(\d+)$/); if (m) max = Math.max(max, parseInt(m[1], 10)); }
  return `OMG-${ym}-${String(max + 1).padStart(3, "0")}`;
}

/** 발행/입금완료로 전이 시 채번 보장(수동 발행분도 INV-YYYYMM-### 부여). 거래명세서에 번호 필수. */
function ensureInvoiceNumber(inv) {
  if (!inv || inv.invoice_number) return inv;
  // 청구서 발행 또는 계산서 발행/입금완료 — 어느 축이든 '발행됨'이면 채번(거래명세서/계산서 번호 필수).
  if (inv.status !== "발행" && inv.tax_status !== "계산서 발행" && inv.tax_status !== "입금완료") return inv;
  const number = nextInvoiceNumber(inv.issued_date || todayYmd());
  db().prepare("UPDATE invoices SET invoice_number=? WHERE id=?").run(number, inv.id);
  return { ...inv, invoice_number: number };
}

/**
 * 공급가·할인 기반 청구 금액 계산 헬퍼.
 * discount: 0 ~ supply 로 clamp(음수→0, 공급가 초과→공급가).
 * 반환: { discount(clamp됨), taxable, tax, total }
 * 돈=정수(원). VAT = round(taxable * 0.1).
 */
function invoiceAmountsFromSupply(supply, discount, vatIncluded = true) {
  const raw = Math.round(Number(discount) || 0);
  const d = Math.min(Math.max(0, raw), supply);
  const taxable = supply - d;
  const tax = vatIncluded ? Math.round(taxable * 0.1) : 0; // 부가세 미포함(현금 거래) 시 VAT 0
  const total = taxable + tax;
  return { discount: d, taxable, tax, total };
}

/**
 * 청구 초안 계산(읽기 전용, 쓰기 없음) — 청구서 생성과 미리보기 PDF가 공유.
 * 선택 작업/세션 + 폼 입력 금액 → 라인아이템·공급가·할인·VAT·총액·청구처 계산. 반환: null(권한 없음) 또는 draft 객체.
 */
function computeInvoiceDraft(user, { projectId, taskIds, sessionIds, clientId, issueDate, dueDate, title, discount, vatIncluded = true, taskAmounts = {}, sessionAmounts = {} } = {}) {
  const { sessionRateAmount } = require("../data"); // sessions와 상호의존 → 지연 require
  const project = getProjectForUser(user, projectId);
  if (!project || !canBill(user)) return null;
  const d = db();
  const selectedTasks = Array.isArray(taskIds) ? taskIds.map(Number).filter(Boolean) : [];
  const selectedSessions = Array.isArray(sessionIds) ? sessionIds.map(Number).filter(Boolean) : [];
  if (!selectedTasks.length && !selectedSessions.length) throw new Error("TASK_IDS_REQUIRED");

  let tasks = [];
  if (selectedTasks.length) {
    const placeholders = selectedTasks.map(() => "?").join(",");
    tasks = d
      .prepare(
        `SELECT t.*, tr.title AS track_title, tr.artist AS track_artist, tr.content_type, tr.project_id
         FROM track_tasks t
         JOIN project_tracks tr ON tr.id = t.track_id
         WHERE tr.project_id = ? AND t.is_invoiced = 0 AND t.id IN (${placeholders})
         ORDER BY tr.created_at ASC, tr.id ASC, t.created_at ASC, t.id ASC`
      )
      .all(project.id, ...selectedTasks);
    if (tasks.length !== selectedTasks.length) throw new Error("TASK_NOT_BILLABLE");
  }
  tasks = tasks.map((t) => {
    const raw = taskAmounts[t.id] != null ? taskAmounts[t.id] : taskAmounts[String(t.id)];
    const amt = raw != null && String(raw).trim() !== "" ? parseWon(raw) : (t.total_price || 0);
    return { ...t, unit_price: amt, total_price: amt };
  });

  let billSessions = [];
  if (selectedSessions.length) {
    const placeholders = selectedSessions.map(() => "?").join(",");
    const rawSessions = d
      .prepare(
        `SELECT s.* FROM sessions s
         WHERE s.project_id = ? AND s.status <> '취소' AND s.session_type = '녹음'
           AND s.rate_item_id IS NOT NULL AND s.start_time IS NOT NULL AND s.end_time IS NOT NULL
           AND s.id IN (${placeholders})
           AND NOT EXISTS (SELECT 1 FROM invoice_items ii WHERE ii.session_id = s.id)
           AND NOT EXISTS (SELECT 1 FROM track_tasks tt WHERE tt.session_id = s.id)`
      )
      .all(project.id, ...selectedSessions);
    billSessions = rawSessions.map((s) => ({ session: s, calc: sessionRateAmount(s) })).filter((x) => x.calc && x.calc.amount > 0);
    if (billSessions.length !== selectedSessions.length) throw new Error("TASK_NOT_BILLABLE");
    billSessions = billSessions.map((x) => {
      const raw = sessionAmounts[x.session.id] != null ? sessionAmounts[x.session.id] : sessionAmounts[String(x.session.id)];
      const amount = raw != null && String(raw).trim() !== "" ? parseWon(raw) : x.calc.amount;
      return { ...x, amount };
    });
  }

  const subtotal = tasks.reduce((s, t) => s + (t.total_price || 0), 0) + billSessions.reduce((s, x) => s + x.amount, 0);
  const { discount: discountAmt, tax, total } = invoiceAmountsFromSupply(subtotal, discount || 0, vatIncluded);
  const issued = issueDate || todayYmd();
  const invoiceTitle = String(title || "").trim() || `${project.title} 청구`;
  // 청구처(payer) = parties.id. 폼 선택(clientId=party id) 우선, 없으면 프로젝트에서 제작사›소속사›아티스트 파생.
  const resolvedPayerId = (clientId ? Number(clientId) : null) || project.production_id || project.agency_id || project.artist_id || null;
  if (resolvedPayerId && !d.prepare("SELECT 1 FROM parties WHERE id = ?").get(resolvedPayerId)) throw new Error("CLIENT_NOT_FOUND");

  // 라인아이템(청구서·PDF 공용). 작업=곡명 - 종류, 세션=녹음 세션 라인.
  const items = [];
  for (const t of tasks) {
    items.push({ task_id: t.id, session_id: null, track_title: t.track_title, task_type: t.task_type, description: `${t.track_title} - ${taskTypeLabel(t.task_type)}`, quantity: t.quantity, unit_price: t.unit_price, amount: t.total_price });
  }
  for (const { session, calc, amount } of billSessions) {
    const hh = Math.floor(calc.minutes / 60), mm = calc.minutes % 60;
    items.push({ task_id: null, session_id: session.id, track_title: null, task_type: null, description: `녹음 세션 ${formatYmdShort(session.session_date)} · ${calc.item.name} (${hh}시간${mm ? " " + mm + "분" : ""})`, quantity: 1, unit_price: amount, amount });
  }
  return { project, tasks, billSessions, items, subtotal, discountAmt, tax, total, issued, dueDate: dueDate || null, invoiceTitle, resolvedPayerId };
}

function createInvoiceFromTasks(user, opts = {}) {
  const draft = computeInvoiceDraft(user, opts);
  if (!draft) return null;
  // 청구처 발행 정보 없으면 생성 차단(회사=세금계산서 정보 biz_no, 개인=현금영수증 정보). 폼에서도 막지만 서버가 최종 보루.
  if (draft.resolvedPayerId) {
    const miss = payerDocMissing(getParty(draft.resolvedPayerId));
    if (miss) throw new Error(miss);
  }
  const d = db();
  const invoiceNumber = nextInvoiceNumber(draft.issued);
  d.exec("BEGIN IMMEDIATE;");
  try {
    const info = d
      .prepare(
        `INSERT INTO invoices
         (project_id, payer_id, payer_snapshot, title, invoice_number, amount, tax_amount, discount_amount, paid_amount, status, issued_date, due_date, memo)
         VALUES (@project_id, @payer_id, @payer_snapshot, @title, @invoice_number, @amount, @tax_amount, @discount_amount, 0, '발행', @issued_date, @due_date, @memo)`
      )
      .run({
        project_id: draft.project.id,
        payer_id: draft.resolvedPayerId,
        payer_snapshot: snapshotPayer(draft.resolvedPayerId), // 발행 시점 청구처 정보 고정
        title: draft.invoiceTitle,
        invoice_number: invoiceNumber,
        amount: draft.total,
        tax_amount: draft.tax,
        discount_amount: draft.discountAmt,
        issued_date: draft.issued,
        due_date: draft.dueDate,
        memo: null, // 자동 메모 제거(사용자 요청) — 필요 시 수동 인보이스에서 입력
      });
    const invoiceId = info.lastInsertRowid;
    const insertItem = d.prepare(
      `INSERT INTO invoice_items (invoice_id, task_id, session_id, track_title, task_type, description, quantity, unit_price, amount)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    );
    // 청구 시 작업 잠금·확정 금액 반영 + 상태를 '완료'로(청구=완료 처리; 미완료 선택 시 폼에서 확인받음).
    const markTask = d.prepare("UPDATE track_tasks SET is_invoiced = 1, invoice_id = ?, unit_price = ?, total_price = ?, status = 'Completed' WHERE id = ?");
    const markSession = d.prepare("UPDATE sessions SET status = '완료' WHERE id = ? AND status <> '취소'"); // 청구 시 녹음 세션도 완료 처리(예정→완료)
    for (const it of draft.items) {
      insertItem.run(invoiceId, it.task_id, it.session_id, it.track_title, it.task_type, it.description, it.quantity, it.unit_price, it.amount);
      if (it.task_id) markTask.run(invoiceId, it.unit_price, it.amount, it.task_id); // 청구 시 확정 금액을 작업에도 반영
      if (it.session_id) markSession.run(it.session_id); // 청구=완료(예정 세션도 완료로)
    }
    d.exec("COMMIT;");
    return getInvoiceForUser(user, invoiceId);
  } catch (e) {
    d.exec("ROLLBACK;");
    throw e;
  }
}

/**
 * 청구서 생성 전 미리보기 PDF용 데이터(견적서·내역서·거래명세서) — 쓰기 없음. 선택 항목·금액을 그대로 문서화.
 * 반환: { client, invoice(미발행·번호 없음), items } 또는 null.
 */
function invoiceDraftForPdf(user, opts = {}) {
  const draft = computeInvoiceDraft(user, opts);
  if (!draft) return null;
  const client = draft.resolvedPayerId ? getParty(draft.resolvedPayerId) : null;
  const invoice = {
    title: draft.invoiceTitle,
    invoice_number: nextInvoiceNumber(draft.issued), // 미리보기(청구 생성 전)도 다음 번호를 표기(peek — 소비 안 함). PDF에서 유형 코드 삽입.
    amount: draft.total,
    tax_amount: draft.tax,
    discount_amount: draft.discountAmt,
    paid_amount: 0,
    status: "미발행",
    issued_date: draft.issued,
    due_date: draft.dueDate,
    client_id: draft.resolvedPayerId,
    client_name: client ? (client.activity_name || client.name) : "",
  };
  return { project: draft.project, client: client || { name: "" }, invoice, items: draft.items };
}

/**
 * 청구 삭제. 연결된 작업의 잠금(is_invoiced)을 먼저 해제한 뒤 삭제해야 좀비 작업이 안 생긴다.
 * (FK는 invoice_id만 SET NULL로 지울 뿐 is_invoiced=1은 남으므로 명시적 UPDATE 필요.)
 */
function deleteInvoice(user, id) {
  if (!canBill(user)) return null;
  const inv = db().prepare("SELECT id FROM invoices WHERE id = ?").get(id);
  if (!inv) return null;
  const d = db();
  d.exec("BEGIN IMMEDIATE;");
  try {
    d.prepare("UPDATE track_tasks SET is_invoiced = 0, invoice_id = NULL WHERE invoice_id = ?").run(id);
    d.prepare("DELETE FROM invoices WHERE id = ?").run(id); // invoice_items는 FK CASCADE
    d.exec("COMMIT;");
    return { id };
  } catch (e) {
    d.exec("ROLLBACK;");
    throw e;
  }
}

// ── 청구(invoices) 목록·통계 — 클라이언트 범위 강제 ──

/** 인보이스 목록(치프 전용 라우트에서 사용). 필터(status/overdue/clientId)는 옵션. */
function listInvoices(_user, { status, overdue, clientId } = {}) {
  const where = [];
  const params = {};
  if (status) {
    where.push(status === "입금완료" ? "i.tax_status = @status" : "i.status = @status"); // 입금완료는 계산서·입금 축(tax_status)
    params.status = status;
  }
  if (clientId) {
    where.push("i.payer_id = @clientId");
    params.clientId = Number(clientId);
  }
  const sql = `
    SELECT i.*, p.title AS project_title, COALESCE(NULLIF(c.activity_name, ''), c.name) AS client_name
    FROM invoices i
    LEFT JOIN projects p ON p.id = i.project_id
    LEFT JOIN parties c ON c.id = i.payer_id
    ${where.length ? "WHERE " + where.join(" AND ") : ""}
    ORDER BY
      CASE WHEN i.due_date IS NULL OR i.due_date = '' THEN 1 ELSE 0 END,
      i.due_date ASC, i.created_at DESC`;
  let rows = db().prepare(sql).all(params);
  if (overdue) rows = rows.filter(isOverdue); // 연체는 파생값이라 코드에서 필터
  return rows;
}

/** 단건 인보이스(치프 전용 라우트에서 사용). */
function getInvoiceForUser(_user, id) {
  const row = db()
    .prepare(
      `SELECT i.*, p.title AS project_title, COALESCE(NULLIF(c.activity_name, ''), c.name) AS client_name
       FROM invoices i
       LEFT JOIN projects p ON p.id = i.project_id
       LEFT JOIN parties c ON c.id = i.payer_id WHERE i.id = ?`
    )
    .get(id);
  return row || null;
}

/** 인보이스 요약 통계(미수금·이번 달 발행·연체). */
function invoiceStats(user) {
  const rows = listInvoices(user, {});
  const receivable = rows
    .filter((i) => i.status === "발행")
    .reduce((s, i) => s + balanceOf(i), 0);
  const month = todayYmd().slice(0, 7); // 'YYYY-MM'
  const thisMonthIssued = rows
    .filter((i) => i.status !== "미발행" && (i.issued_date || "").slice(0, 7) === month)
    .reduce((s, i) => s + (i.amount || 0), 0);
  const overdue = rows.filter(isOverdue);
  const overdueAmount = overdue.reduce((s, i) => s + balanceOf(i), 0);
  return { receivable, thisMonthIssued, overdueCount: overdue.length, overdueAmount, total: rows.length };
}

/** 프로젝트의 인보이스 목록(권한 검사). 권한 없으면 null. */
function listInvoicesForProject(user, projectId) {
  const project = getProjectForUser(user, projectId);
  if (!project) return null;
  const rows = db()
    .prepare(
      `SELECT i.*, COALESCE(NULLIF(c.activity_name, ''), c.name) AS client_name FROM invoices i
       LEFT JOIN parties c ON c.id = i.payer_id
       WHERE i.project_id = ? ORDER BY i.created_at DESC, i.id DESC`
    )
    .all(projectId);
  return { project, rows };
}

module.exports = {
  balanceOf,
  payStatusOf,
  isOverdue,
  listUnbilledTasksForProject,
  listBillableSessionsForProject,
  isSessionInvoiced,
  listInvoiceItemsForInvoice,
  ensureInvoiceNumber,
  peekInvoiceNumber: nextInvoiceNumber, // 청구 생성 전 미리보기 PDF 파일명(다음 번호 peek — 소비 안 함)
  invoiceAmountsFromSupply,
  createInvoiceFromTasks,
  snapshotPayer,
  payerDocMeta,
  payerDocMissing,
  invoiceDraftForPdf,
  deleteInvoice,
  listInvoices,
  getInvoiceForUser,
  invoiceStats,
  listInvoicesForProject,
};
