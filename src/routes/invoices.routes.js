"use strict";

const express = require("express");
const { db } = require("../db");
const { requireBilling, canBill } = require("../auth");
const { INVOICE_STATUSES, INVOICE_STATUS_LABELS, TAX_STATUSES, normalizeInvoiceStatus, normalizeTaxStatus, normalizeDocType, DOC_TYPES, docNumberWithType } = require("../config");
const {
  clientOptions,
  contactOptions,
  listInvoices,
  getInvoiceForUser,
  listInvoiceItemsForInvoice,
  balanceOf,
  payStatusOf,
  isOverdue,
  deleteInvoice,
  getStudioInfo,
  getStudioLogo,
  getParty,
  getClientFile,
  listPersonsForOrg,
  snapshotPayer,
  ensureInvoiceNumber,
  listPayments,
  addPayment,
  deletePayment,
} = require("../data");
const { layout, pageHeader, esc, formatKRW, flashBanner, errorPage, emptyState, explain, payerCombo, tabBar } = require("../views");
const { invoiceRow, invoiceBadge, payerInfoCard, paymentHistory } = require("../views.invoices");
const { formatYmdShort, ddayLabel } = require("../lib/date");
const { parseMoney, cleanYmd } = require("../lib/forms");
const { asyncHandler } = require("../lib/async");
const { renderInvoicePdf } = require("../invoice-pdf");
const { notifyInvoiceIssued } = require("../notify");

const router = express.Router();

/** 내부 절대경로면 그대로, 아니면 null (open-redirect 차단: `//`·`/\` 거부, safeNext와 동일 규칙). */
function safePath(v) {
  return typeof v === "string" && /^\/(?![/\\])/.test(v) ? v : null;
}

/**
 * 변경 후 복귀 경로: 폼이 보낸 return(프로젝트 청구 탭)이 안전하면 그쪽, 아니면 fallback(청구 상세).
 * extra(예: {open: newId})를 쿼리에 덧붙이고 flash로 마무리. 프로젝트 청구 탭 인라인 경험 복귀용.
 */
function returnTo(req, fallback, flash, extra) {
  let path = safePath(req.body && req.body.return) || fallback;
  const params = Object.assign({}, extra, { flash });
  for (const [k, val] of Object.entries(params)) {
    path += (path.includes("?") ? "&" : "?") + k + "=" + encodeURIComponent(val);
  }
  return path;
}

function projectOptions() {
  return db().prepare("SELECT id, title, COALESCE(production_id, agency_id, artist_id) AS client_id FROM projects ORDER BY created_at DESC").all();
}

function resolveInvoiceRefs(body) {
  // 청구처(payer) = parties.id. client_id·payer_contact_id 둘 다 party id(콤보가 어느 쪽에 넣든 동일 의미).
  const projectId = body.project_id ? Number(body.project_id) : null;
  let clientId = (body.client_id ? Number(body.client_id) : null) || (body.payer_contact_id ? Number(body.payer_contact_id) : null);

  if (projectId) {
    const p = db().prepare("SELECT id, production_id, agency_id, artist_id FROM projects WHERE id = ?").get(projectId);
    if (!p) return { error: "선택한 프로젝트를 찾을 수 없습니다." };
    if (!clientId) clientId = p.production_id || p.agency_id || p.artist_id || null; // 미선택 시 프로젝트에서 파생
  }

  if (clientId) {
    const c = db().prepare("SELECT id FROM parties WHERE id = ?").get(clientId);
    if (!c) return { error: "선택한 청구처를 찾을 수 없습니다." };
  }

  return { projectId, clientId };
}

// ── 목록(URL = 필터) ──
router.get("/", requireBilling, (req, res) => {
  const user = req.user;
  const admin = canBill(user);
  const q = (req.query.q || "").toString().trim();
  // 계산서/현금영수증 '발행 필요'(미발행) / '발행 완료'(발행·입금완료) 탭 분리(사용자 요청).
  const tab = req.query.tab === "done" ? "done" : "todo";
  const allRows = listInvoices(user, {});
  const issued = (i) => i.tax_status === "계산서 발행" || i.tax_status === "입금완료";
  const todoRows = allRows.filter((i) => !issued(i));
  const doneRows = allRows.filter(issued);
  let rows = tab === "done" ? doneRows : todoRows;

  // 라우트 레벨 q 필터(제목·채번·클라이언트명 부분일치, 소문자 비교). data.js 수정 없음.
  if (q) {
    const ql = q.toLowerCase();
    rows = rows.filter(
      (i) =>
        (i.title || "").toLowerCase().includes(ql) ||
        (i.invoice_number || "").toLowerCase().includes(ql) ||
        (i.client_name || "").toLowerCase().includes(ql)
    );
  }

  const totalDue = allRows.reduce((s, i) => s + (i.status === "발행" ? balanceOf(i) : 0), 0); // 미수금 합계=전체 기준(탭 무관)

  const tabs = tabBar({
    tabs: [
      { key: "todo", label: `발행 필요 ${todoRows.length}` },
      { key: "done", label: `발행 완료 ${doneRows.length}` },
    ],
    activeKey: tab,
    hrefFn: (k) => `/invoices?tab=${k}${q ? "&q=" + encodeURIComponent(q) : ""}`,
  });

  // 검색바: GET form. 탭을 hidden으로 보존.
  const searchBar = `
    <form method="get" action="/invoices" class="mb-4 flex gap-2">
      <input type="hidden" name="tab" value="${esc(tab)}" />
      <input class="input min-w-0 flex-1" type="search" name="q" value="${esc(q)}" placeholder="제목 · 채번 · 클라이언트 검색" aria-label="청구 검색" />
      <button class="btn-primary shrink-0" type="submit">검색</button>
    </form>`;
  const resultNote = q
    ? `<div class="mb-3 text-sm text-muted">"${esc(q)}" 결과 ${rows.length}건 · <a href="/invoices?tab=${tab}" class="text-primary hover:underline">검색 초기화</a></div>`
    : "";

  const retPath = `/invoices?tab=${tab}${q ? "&q=" + encodeURIComponent(q) : ""}`;
  const list = rows.length
    ? `<div class="space-y-2">${rows.map((i) => invoiceRow(i, { isAdmin: admin, ret: retPath })).join("")}</div>`
    : q
      ? emptyState(`"${esc(q)}" 검색 결과가 없습니다.`, { card: true })
      : emptyState(`청구 내역이 없습니다.${admin ? ' <a href="/invoices/new" class="text-primary hover:underline">새로 추가</a>' : ""}`, { card: true });

  const action = admin ? `<a href="/invoices/new" class="btn-primary">+ 새 청구</a>` : "";
  const dueNote = totalDue > 0
    ? `<div class="card mb-4 flex items-center justify-between"><span class="text-sm text-muted">미수금 합계</span><span class="tabular text-lg font-bold text-danger">${formatKRW(totalDue)}</span></div>`
    : "";

  const body = `
    ${flashBanner(req.query)}
    ${pageHeader({ title: "청구", desc: admin ? "발행·입금·미수금" : "내 청구 내역", action })}
    ${dueNote}
    ${admin ? tabs : ""}
    ${searchBar}
    ${resultNote}
    ${list}`;
  res.send(layout({ title: "청구", user, current: "/invoices", body }));
});

// ── 새 청구(관리자) ──
router.get("/new", requireBilling, (req, res) => {
  const projectId = req.query.projectId ? Number(req.query.projectId) : null;
  const prefill = projectId ? { project_id: projectId } : {};
  const ret = projectId ? `/projects/${projectId}?tab=invoice` : ""; // 프로젝트에서 왔으면 그 청구 탭으로 복귀
  res.send(layout({ title: "새 청구", user: req.user, current: ret ? "/projects" : "/invoices", body: invoiceForm(prefill, "", ret) }));
});

router.post("/", requireBilling, (req, res) => {
  const b = req.body;
  const ret = safePath(b.return) || ""; // 프로젝트 청구 탭에서 온 복귀 경로(있으면 생성 후 그쪽으로 + 사이드바 프로젝트 유지)
  const reErr = (msg) => res.send(layout({ title: "새 청구", user: req.user, current: ret ? "/projects" : "/invoices", body: invoiceForm({ ...b, _err: msg }, "", ret) }));
  const title = String(b.title || "").trim();
  if (!title) return reErr("제목을 입력하세요.");
  const refs = resolveInvoiceRefs(b);
  if (refs.error) return reErr(refs.error);
  const amount = parseMoney(b.amount);
  if (amount <= 0) return reErr("청구 금액을 입력하세요.");
  const status = normalizeInvoiceStatus(b.status); // 청구서 축: 미발행 | 발행
  const taxStatus = normalizeTaxStatus(b.tax_status); // 계산서·입금 축
  // 계산서·입금이 입금완료면 입금액=총액 자동
  const paid = taxStatus === "입금완료" ? amount : parseMoney(b.paid_amount);

  const discount = parseMoney(b.discount_amount);
  const info = db()
    .prepare(
      `INSERT INTO invoices (project_id, payer_id, payer_snapshot, title, amount, tax_amount, discount_amount, paid_amount, status, tax_status, issued_date, due_date, memo)
       VALUES (@project_id,@payer_id,@payer_snapshot,@title,@amount,@tax,@discount,@paid,@status,@tax_status,@issued_date,@due_date,@memo)`
    )
    .run({
      project_id: refs.projectId,
      payer_id: refs.clientId,
      payer_snapshot: snapshotPayer(refs.clientId), // 발행 시점 청구처 정보 고정
      title,
      amount,
      tax: b.vat_included != null ? Math.round(amount - amount / 1.1) : 0, // 부가세 포함 체크 시 역산, 현금(미포함)이면 0
      discount,
      paid,
      status,
      tax_status: taxStatus,
      issued_date: cleanYmd(b.issued_date),
      due_date: cleanYmd(b.due_date),
      memo: String(b.memo || "").trim() || null,
    });
  const id = info.lastInsertRowid;
  // 수동 인보이스가 발행 상태로 생성되면 채번 보장 + 발행 알림(from-tasks·상태전이 경로와 일원화). 미발행이면 스킵.
  if (status === "발행" || taxStatus === "계산서 발행" || taxStatus === "입금완료") {
    ensureInvoiceNumber(db().prepare("SELECT * FROM invoices WHERE id = ?").get(id));
    notifyInvoiceIssued(getInvoiceForUser(req.user, id));
  }
  res.redirect(returnTo(req, `/invoices/${id}`, "created", { open: id }));
});

// ── 상세 ──
// 청구처 정보: 발행 시점 스냅샷(payer_snapshot) 우선 — 이후 클라이언트 정보가 바뀌어도 과거 청구서 표시/PDF 고정.
// 없으면(레거시 청구서) 실시간 party 폴백. { client, contacts } 반환.
function payerView(inv) {
  if (inv && inv.payer_snapshot) {
    try { const s = JSON.parse(inv.payer_snapshot); return { client: s, contacts: s.contacts || [] }; }
    catch (_e) { /* 파싱 실패 시 실시간 폴백 */ }
  }
  const client = inv && inv.payer_id ? getParty(inv.payer_id) : null;
  return { client, contacts: client ? listPersonsForOrg(client.id) : [] };
}

router.get("/:id", requireBilling, (req, res) => {
  const inv = getInvoiceForUser(req.user, Number(req.params.id));
  if (!inv) return res.status(404).send(errorPage({ code: 404, title: "청구를 찾을 수 없습니다", message: "삭제되었거나 주소가 잘못되었습니다.", user: req.user }));
  const admin = canBill(req.user);
  const bal = balanceOf(inv);
  const itemBundle = listInvoiceItemsForInvoice(req.user, inv.id);
  const items = itemBundle ? itemBundle.rows : [];
  const payments = admin ? listPayments(inv.id) : [];
  const pdfTypes = DOC_TYPES; // 3종 모두 상태 무관 발행 허용(미발행 초안도 견적서·내역서·거래명세서)
  // 청구처 정보(대표자·사업자번호·담당자 연락처) — 발행 시점 스냅샷 우선(payerView). biz_license 파일 링크만 실시간(현재 첨부).
  const { client: payerClient, contacts: payerContacts } = payerView(inv);
  const payerCard = payerClient
    ? payerInfoCard(payerClient, payerContacts, payerClient.id ? !!getClientFile(payerClient.id, "biz_license") : false)
    : "";

  const row = (label, value) =>
    `<div class="flex justify-between border-b border-border py-2 last:border-0"><span class="text-sm text-muted">${esc(label)}</span><span class="text-sm font-medium">${value}</span></div>`;

  const adminControls = admin
    ? `
    <div class="card mt-3 space-y-3">
      <h2 class="text-sm font-semibold">상태 · 입금 처리</h2>
      <div class="flex flex-wrap items-end gap-3">
        <form method="post" action="/invoices/${inv.id}/status">
          <label class="label mb-0.5 text-xs">청구서 상태</label>
          <select name="status" class="input max-w-[10rem]" data-autosubmit>
            ${INVOICE_STATUSES.map((s) => `<option value="${esc(s)}" ${s === inv.status ? "selected" : ""}>${esc(INVOICE_STATUS_LABELS[s] || s)}</option>`).join("")}
          </select>
          <noscript><button class="btn-ghost">변경</button></noscript>
        </form>
        <form method="post" action="/invoices/${inv.id}/tax-status">
          <label class="label mb-0.5 text-xs">계산서 · 입금</label>
          <select name="tax_status" class="input max-w-[10rem]" data-autosubmit>
            ${TAX_STATUSES.map((s) => `<option value="${esc(s)}" ${s === (inv.tax_status || "계산서 미발행") ? "selected" : ""}>${esc(s)}</option>`).join("")}
          </select>
          <noscript><button class="btn-ghost">변경</button></noscript>
        </form>
      </div>
      ${paymentHistory(inv, payments, {})}
      <div class="flex items-center gap-2 pt-1">
        <form method="post" action="/invoices/${inv.id}/delete" data-confirm="이 청구를 삭제할까요? 발행한 청구는 수정 대신 삭제 후 다시 발행합니다."><button class="btn-ghost text-danger">삭제</button></form>
        <span class="text-xs text-muted">수정이 필요하면 삭제 후 다시 발행하세요.</span>
      </div>
    </div>`
    : "";

  const body = `
    ${flashBanner(req.query)}
    ${pageHeader({ title: inv.title, desc: (payerClient && payerClient.name) || inv.client_name || "청구처 미지정", back: { href: "/invoices", label: "청구" }, action: invoiceBadge(inv) })}
    <div class="card">
      ${inv.invoice_number ? row("청구번호", esc(inv.invoice_number)) : ""}
      ${row("총액", formatKRW(inv.amount))}
      ${inv.discount_amount ? row("할인", `<span class="text-success">-${formatKRW(inv.discount_amount)}</span>`) : ""}
      ${inv.tax_amount ? row("VAT", formatKRW(inv.tax_amount)) : ""}
      ${row("입금액", formatKRW(inv.paid_amount))}
      ${row("미수금", `<span class="${bal > 0 ? "text-danger font-semibold" : ""}">${formatKRW(bal)}</span>`)}
      ${row("납입 상태", esc(payStatusOf(inv)) + (isOverdue(inv) ? ' <span class="text-danger">(연체)</span>' : ""))}
      ${row("발행일", inv.issued_date ? esc(formatYmdShort(inv.issued_date)) : "<span class='text-muted'>미정</span>")}
      ${row("마감일", inv.due_date ? `${esc(formatYmdShort(inv.due_date))} · ${esc(ddayLabel(inv.due_date))}` : "<span class='text-muted'>미정</span>")}
      ${inv.project_title ? row("프로젝트", `<a href="/projects/${inv.project_id}" class="text-primary hover:underline">${esc(inv.project_title)}</a>`) : ""}
    </div>
    ${payerCard}
    <div class="mt-3 flex flex-wrap items-center gap-1.5">
        <span class="text-xs text-muted">PDF 발행:</span>
        ${pdfTypes.map((t) => `<a href="/invoices/${inv.id}/statement/${encodeURIComponent(docNumberWithType(inv.invoice_number, t) || t)}.pdf?type=${encodeURIComponent(t)}" class="btn-ghost btn-sm" target="_blank" rel="noopener">${esc(t)}</a>`).join("")}
      </div>
    ${invoiceItemsCard(items)}
    ${inv.memo ? `<div class="card mt-3"><div class="mb-1 text-sm text-muted">메모</div><div class="whitespace-pre-wrap text-sm">${esc(inv.memo)}</div></div>` : ""}
    ${adminControls}`;
  res.send(layout({ title: inv.title, user: req.user, current: "/invoices", body }));
});

// ── 거래명세서 PDF (발행/입금완료 또는 견적서 타입은 미발행도 허용. PII → 인증 필수·no-store·즉석 스트리밍) ──
router.get(["/:id/statement.pdf", "/:id/statement/:name"], requireBilling, asyncHandler(async (req, res) => {
  let inv = getInvoiceForUser(req.user, Number(req.params.id));
  if (!inv) return res.status(404).send(errorPage({ code: 404, title: "청구를 찾을 수 없습니다", message: "삭제되었거나 주소가 잘못되었습니다.", user: req.user }));
  const docType = normalizeDocType(req.query.type);
  inv = ensureInvoiceNumber(inv); // 수동 발행분도 채번 보장(발행/입금완료 한정, 내부 가드 있음)
  // 3종 문서(견적서·내역서·거래명세서) 모두 상태 무관 발행 허용 — 참고용 문서라 미발행 초안에서도 뽑을 수 있게(사용자 요청).
  const bundle = listInvoiceItemsForInvoice(req.user, inv.id);
  const items = bundle ? bundle.rows : [];
  const client = payerView(inv).client || { name: inv.client_name || "" }; // 발행 시점 스냅샷 우선(레거시=실시간/JOIN 폴백)
  let pdf;
  try {
    pdf = await renderInvoicePdf({ studio: getStudioInfo(), logo: getStudioLogo(), client, invoice: inv, items, docType });
  } catch (e) {
    if (e && e.message === "PDF_RENDERER_UNAVAILABLE") {
      return res.status(503).send(errorPage({ code: 503, title: "PDF 생성 일시 불가", message: "서버 PDF 렌더러(@resvg/resvg-js)가 로드되지 않았습니다. 배포 환경의 네이티브 모듈 설치를 확인하세요. 청구 내역 자체는 정상입니다.", user: req.user }));
    }
    throw e;
  }
  res.setHeader("Content-Type", "application/pdf");
  const fname = (docNumberWithType(inv.invoice_number, docType) || docType) + ".pdf"; // 다운로드 파일명 = 문서번호(견적서=OMG-EST-…), 미발행 초안은 유형명
  res.setHeader("Content-Disposition", `inline; filename="${fname}"; filename*=UTF-8''${encodeURIComponent(fname)}`);
  res.setHeader("Cache-Control", "private, no-store");
  res.send(pdf);
}));

function invoiceItemsCard(items) {
  if (!items.length) return "";
  const supply = items.reduce((sum, item) => sum + (item.amount || 0), 0);
  const rows = items
    .map(
      (item) => `
      <div class="flex items-start justify-between gap-3 border-b border-border py-2 last:border-0">
        <div class="min-w-0">
          <div class="text-sm font-medium">${esc(item.description)}</div>
          <div class="mt-0.5 text-xs text-muted">${esc(String(item.quantity))} x ${formatKRW(item.unit_price)}</div>
        </div>
        <div class="shrink-0 text-sm font-semibold">${formatKRW(item.amount)}</div>
      </div>`
    )
    .join("");
  return `
    <div class="card mt-3">
      <div class="mb-2 flex items-center justify-between gap-3">
        <h2 class="font-display text-base font-semibold">청구 항목</h2>
        <span class="text-xs text-muted">공급가 ${formatKRW(supply)}</span>
      </div>
      ${rows}
    </div>`;
}

// ── 수정 라우트 없음: 발행=확정 원칙. 발행된 청구의 내용 변경은 삭제(POST /:id/delete) 후 다시 발행한다. ──

// ── 입금 추가(관리자) ── 입금 1건을 이력(payments)에 추가한다(부분납 누적). paid_amount는 SUM(payments) 파생.
router.post("/:id/pay", requireBilling, (req, res) => {
  const inv = db().prepare("SELECT * FROM invoices WHERE id = ?").get(Number(req.params.id));
  if (!inv) return res.status(404).send(errorPage({ code: 404, title: "청구를 찾을 수 없습니다", message: "삭제되었거나 주소가 잘못되었습니다.", user: req.user }));
  // '완납 처리'=남은 잔금 한 건 입금. 그 외=입력액 1건. 이력 방식이라 기존 입금은 그대로 두고 더한다.
  const add = req.body.full === "1" ? balanceOf(inv) : parseMoney(req.body.amount);
  const paid = addPayment(inv.id, { amount: add, paid_on: cleanYmd(req.body.paid_on), memo: req.body.pay_memo });
  // 완납이면 계산서·입금 축을 입금완료로 자동 승격(강등은 이력 삭제 시). 누적 입금이 총액 이상.
  if (inv.amount > 0 && paid >= inv.amount && inv.tax_status !== "입금완료") {
    db().prepare("UPDATE invoices SET tax_status='입금완료' WHERE id=?").run(inv.id);
    ensureInvoiceNumber({ ...inv, tax_status: "입금완료" });
  }
  res.redirect(returnTo(req, `/invoices/${inv.id}`, "paid"));
});

// ── 입금 이력 1건 삭제(관리자) ── 삭제 후 잔금이 생기면 입금완료→계산서 발행으로 강등(완납 취소 정합성).
router.post("/:id/payments/:pid/delete", requireBilling, (req, res) => {
  const inv = db().prepare("SELECT * FROM invoices WHERE id = ?").get(Number(req.params.id));
  if (!inv) return res.status(404).send(errorPage({ code: 404, title: "청구를 찾을 수 없습니다", message: "삭제되었거나 주소가 잘못되었습니다.", user: req.user }));
  const p = db().prepare("SELECT invoice_id FROM payments WHERE id = ?").get(Number(req.params.pid));
  if (p && Number(p.invoice_id) === inv.id) {
    const r = deletePayment(req.params.pid);
    if (r && inv.tax_status === "입금완료" && r.paid < inv.amount) {
      db().prepare("UPDATE invoices SET tax_status='계산서 발행' WHERE id=?").run(inv.id);
    }
  }
  res.redirect(returnTo(req, `/invoices/${inv.id}`, "saved"));
});

// ── 청구서 상태 변경(관리자) ── 미발행 ↔ 발행. 계산서·입금과 독립.
router.post("/:id/status", requireBilling, (req, res) => {
  const inv = db().prepare("SELECT * FROM invoices WHERE id = ?").get(Number(req.params.id));
  if (!inv) return res.status(404).send(errorPage({ code: 404, title: "청구를 찾을 수 없습니다", message: "삭제되었거나 주소가 잘못되었습니다.", user: req.user }));
  const status = normalizeInvoiceStatus(req.body.status); // 미발행 | 발행
  const d = db();
  d.exec("BEGIN IMMEDIATE");
  try {
    d.prepare("UPDATE invoices SET status=? WHERE id=?").run(status, inv.id);
    ensureInvoiceNumber({ ...inv, status }); // 청구서 발행 시 채번 보장
    d.exec("COMMIT");
  } catch (e) {
    try { d.exec("ROLLBACK"); } catch (_) { /* ignore */ }
    throw e;
  }
  if (inv.status === "미발행" && status === "발행") notifyInvoiceIssued(getInvoiceForUser(req.user, inv.id)); // 청구서 미발행→발행 첫 전이 알림
  res.redirect(returnTo(req, `/invoices/${inv.id}`, "saved"));
});

// ── 계산서·입금 상태 변경(관리자) ── 계산서 미발행 → 계산서 발행 → 입금완료(자유 선택). 입금완료 선택=완납, 벗어나면 입금액 0.
router.post("/:id/tax-status", requireBilling, (req, res) => {
  const inv = db().prepare("SELECT * FROM invoices WHERE id = ?").get(Number(req.params.id));
  if (!inv) return res.status(404).send(errorPage({ code: 404, title: "청구를 찾을 수 없습니다", message: "삭제되었거나 주소가 잘못되었습니다.", user: req.user }));
  const tax = normalizeTaxStatus(req.body.tax_status);
  // 입금완료 선택 → 완납. 잔금이 있으면 그만큼 입금 이력 1건 추가(paid_amount는 SUM(payments)로 자동 반영).
  if (tax === "입금완료") { const bal = balanceOf(inv); if (bal > 0) addPayment(inv.id, { amount: bal, memo: "입금완료 처리" }); }
  // 입금완료에서 다른 계산서 상태로 옮겨도 입금 이력은 보존한다(문서 단계 변경이 실제 입금 기록을 지우면 안 됨).
  // 완납 취소가 필요하면 입금 이력에서 해당 건을 삭제한다.
  const d = db();
  d.exec("BEGIN IMMEDIATE");
  try {
    d.prepare("UPDATE invoices SET tax_status=? WHERE id=?").run(tax, inv.id);
    ensureInvoiceNumber({ ...inv, tax_status: tax }); // 계산서 발행/입금완료면 채번 보장
    d.exec("COMMIT");
  } catch (e) {
    try { d.exec("ROLLBACK"); } catch (_) { /* ignore */ }
    throw e;
  }
  res.redirect(returnTo(req, `/invoices/${inv.id}`, "saved"));
});

// ── 삭제(관리자) ── 연결 작업의 청구 잠금을 먼저 해제(좀비 작업 방지). data.js deleteInvoice 트랜잭션.
router.post("/:id/delete", requireBilling, (req, res) => {
  deleteInvoice(req.user, Number(req.params.id));
  // 삭제 후엔 인보이스가 없으니 청구 탭 복귀 시 open=ID는 무시됨(그 행 미생성). 기본은 청구 목록.
  res.redirect(returnTo(req, "/invoices", "deleted"));
});

// ── 수동 청구 생성 폼(금액 직접 입력 경로) ── 수정 폼은 폐기(발행=확정, 변경은 삭제 후 재발행).
function invoiceForm(inv = {}, err = "", returnPath = "") {
  const e = err || inv._err || "";
  const action = "/invoices";
  const clients = clientOptions();
  const projects = projectOptions();
  const projSelect = `
    <select name="project_id" class="input">
      <option value="">프로젝트 미지정</option>
      ${projects.map((p) => `<option value="${p.id}" ${Number(inv.project_id) === p.id ? "selected" : ""}>${esc(p.title)}</option>`).join("")}
    </select>`;
  // 청구처 콤보(클라이언트 + 담당자) — from-tasks와 동일 공용 payerCombo. 담당자 선택 시 payer_contact_id → ensureClientFromContact로 개인 청구처 변환.
  const contactOpts = contactOptions();
  const clientSelect = payerCombo({ selectedId: inv.payer_id, clientOptions: clients, contactOptions: contactOpts, hint: `클라이언트·담당자 이름 일부만 입력해도 좁혀집니다. 담당자를 고르면 개인 청구처로 등록됩니다. 비워 두면 자동/미지정.` });
  const retHidden = returnPath ? `<input type="hidden" name="return" value="${esc(returnPath)}" />` : "";
  const errBox = e ? `<p class="rounded-lg bg-danger/10 px-3 py-2 text-sm text-danger">${esc(e)}</p>` : "";
  const payField = `<div class="grid gap-3 sm:grid-cols-2"><div><label class="label">입금액(원)</label><input class="input" name="paid_amount" inputmode="numeric" value="${inv.paid_amount ? esc(String(inv.paid_amount)) : ""}" placeholder="0" /></div></div>`;
  const statusField = `<div class="grid gap-3 sm:grid-cols-2">
      <div><label class="label">청구서 상태</label><select name="status" class="input">${INVOICE_STATUSES.map((s) => `<option value="${esc(s)}" ${s === (inv.status || INVOICE_STATUSES[0]) ? "selected" : ""}>${esc(INVOICE_STATUS_LABELS[s] || s)}</option>`).join("")}</select></div>
      <div><label class="label">계산서 · 입금</label><select name="tax_status" class="input">${TAX_STATUSES.map((s) => `<option value="${esc(s)}" ${s === (inv.tax_status || TAX_STATUSES[0]) ? "selected" : ""}>${esc(s)}</option>`).join("")}</select></div>
    </div>`;
  const fields = `
      <div><label class="label">제목</label><input class="input" name="title" value="${esc(inv.title || "")}" placeholder="예: 루나 1집 믹싱비" required /></div>
      <div><label class="label">프로젝트</label>${projSelect}</div>
      <div><label class="label">청구처(프로젝트 선택 시 자동)</label>${clientSelect}</div>
      <div class="grid gap-3 sm:grid-cols-2">
        <div><label class="label">총액(원) <span class="font-normal text-muted text-xs">입력 금액 기준</span></label><input class="input" name="amount" inputmode="numeric" value="${inv.amount ? esc(String(inv.amount)) : ""}" placeholder="0" /></div>
        <div><label class="label">할인(원) <span class="font-normal text-muted text-xs">선택 — 표시용</span></label><input class="input" name="discount_amount" inputmode="numeric" value="${inv.discount_amount ? esc(String(inv.discount_amount)) : ""}" placeholder="0" /></div>
      </div>
      <label class="flex items-center gap-1.5 text-sm">
        <input type="checkbox" name="vat_included" value="1" checked /> 부가세(VAT 10%) 포함 <span class="text-xs text-muted">— 해제 시 총액에서 VAT를 빼고 현금 거래로(VAT 0)</span>
      </label>
      ${payField}
      <div class="grid gap-3 sm:grid-cols-2">
        <div><label class="label">발행일</label><input class="input" type="date" name="issued_date" value="${esc(inv.issued_date || "")}" /></div>
        <div><label class="label">마감일</label><input class="input" type="date" name="due_date" value="${esc(inv.due_date || "")}" /></div>
      </div>
      ${statusField}
      <div><label class="label">메모</label><textarea class="input" name="memo" rows="2">${esc(inv.memo || "")}</textarea></div>`;
  return `
    ${pageHeader({ title: "새 청구", back: returnPath ? { href: returnPath, label: "프로젝트 청구" } : null })}
    <form method="post" action="${action}" class="card space-y-4" data-vat-amount-form>
      ${retHidden}${errBox}
      ${explain(`프로젝트 청구 탭의 청구 생성 체크리스트에서 항목을 선택하면 청구서를 자동으로 만들 수 있습니다. 이 폼은 금액을 직접 입력하는 수동 경로입니다.`)}
      ${fields}
      <div class="flex gap-2">
        <button class="btn-primary" type="submit">추가</button>
        <a href="${returnPath || "/invoices"}" class="btn-ghost">취소</a>
      </div>
    </form>`;
}

module.exports = router;
