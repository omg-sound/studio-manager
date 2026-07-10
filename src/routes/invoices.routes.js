"use strict";

const express = require("express");
const { db } = require("../db");
const { requireBilling, requireInvoice, canBill, canInvoice } = require("../auth");
const { normalizeTaxStatus, normalizeDocType, DOC_TYPES, docNumberWithType } = require("../config");
const {
  listInvoices,
  getInvoiceForUser,
  listInvoiceItemsForInvoice,
  balanceOf,
  invoiceTaxTab,
  deleteInvoice,
  getStudioInfo,
  getStudioLogo,
  getParty,
  getClientFile,
  listOrgContacts,
  snapshotPayer,
  payerSnapshotChanged,
  ensureInvoiceNumber,
  recomputePaid,
} = require("../data");
const { layout, pageHeader, esc, formatKRW, flashBanner, errorPage, emptyState, capList, tabBar, copyable } = require("../views");
const { invoiceRow, payerInfoCard, taxToggleButtons } = require("../views.invoices");
const { formatYmdShort, todayYmd } = require("../lib/date"); // ddayLabel 미사용(마감일 개념 삭제, 2026-07-05)
const { asyncHandler } = require("../lib/async");
const { logAudit } = require("../lib/audit"); // 파괴적·재무 액션 기록(fail-safe)
const { safePath } = require("../lib/nav"); // open-redirect 차단(공용, test/nav.test.js)
const { renderInvoicePdf } = require("../invoice-pdf");

const router = express.Router();

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

// (수동 청구 생성 폼·resolveInvoiceRefs·projectOptions는 2026-07-08 폐지 — 청구는 프로젝트 청구 탭에서만 생성.
//  임의(커스텀) 청구가 필요해지면 그때 다시 빌드하기로 사용자 결정.)

// ── 목록(URL = 필터) ──
router.get("/", requireBilling, (req, res) => {
  const user = req.user;
  const admin = canBill(user);
  const invoicer = canInvoice(user); // 계산서·입금 처리(상태 토글) = 대표·치프만
  const q = (req.query.q || "").toString().trim();
  // 계산서/현금영수증 '발행 필요'(미발행) / '발행 완료'(계산서만 발행, 입금 전) / '입금완료' 3탭 분리
  // (2026-07-06 사용자 요청 — 이전엔 발행완료 탭이 입금완료까지 함께 묶여 있어 입금만 따로 볼 수 없었음).
  const tab = ["done", "paid"].includes(req.query.tab) ? req.query.tab : "todo";
  const allRows = listInvoices(user, {});
  const todoRows = allRows.filter((i) => invoiceTaxTab(i) === "todo");
  const doneRows = allRows.filter((i) => invoiceTaxTab(i) === "done");
  const paidRows = allRows.filter((i) => invoiceTaxTab(i) === "paid");
  let rows = tab === "done" ? doneRows : tab === "paid" ? paidRows : todoRows;

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
      { key: "paid", label: `입금완료 ${paidRows.length}` },
    ],
    activeKey: tab,
    hrefFn: (k) => `/invoices?tab=${k}${q ? "&q=" + encodeURIComponent(q) : ""}`,
  });

  // 검색바: GET form. 탭을 hidden으로 보존.
  const searchBar = `
    <form method="get" action="/invoices" class="mb-4 flex gap-2">
      <input type="hidden" name="tab" value="${esc(tab)}" />
      <input class="input min-w-0 flex-1" type="search" name="q" value="${esc(q)}" placeholder="제목 · 청구번호 · 클라이언트 검색" aria-label="청구 검색" />
      <button class="btn-primary shrink-0" type="submit">검색</button>
    </form>`;
  const resultNote = q
    ? `<div class="mb-3 text-sm text-muted">"${esc(q)}" 결과 ${rows.length}건 · <a href="/invoices?tab=${tab}" class="text-primary hover:underline">검색 초기화</a></div>`
    : "";

  const retPath = `/invoices?tab=${tab}${q ? "&q=" + encodeURIComponent(q) : ""}`;
  const openId = req.query.open ? Number(req.query.open) : null; // 토글 처리 후 그 카드의 '상태 처리' 펼침 유지(+스크롤)
  // 목록 상한(2026-07-09 스케일 점검) — 입금완료 탭은 해가 갈수록 누적되므로 기본 100건 + 더 보기.
  const cap = capList(rows, req.query, (n) => `${retPath}&limit=${n}`);
  const list = cap.shown.length
    ? `<div class="space-y-2">${cap.shown.map((i) => invoiceRow(i, { isAdmin: admin, isInvoicer: invoicer, ret: retPath, openId })).join("")}</div>${cap.more}`
    : q
      ? emptyState(`"${esc(q)}" 검색 결과가 없습니다.`, { card: true })
      : emptyState("청구 내역이 없습니다. 청구는 프로젝트의 청구 탭에서 생성합니다.", { card: true });

  const action = ""; // '+ 새 청구'(수동 청구) 폐지(2026-07-08) — 청구 생성은 프로젝트 청구 탭에서만
  const dueNote = totalDue > 0
    ? `<div class="card mb-4 flex items-center justify-between"><span class="text-sm text-muted">미수금 합계</span><span class="tabular text-lg font-bold text-danger">${formatKRW(totalDue)}</span></div>`
    : "";

  const body = `
    ${flashBanner(req.query)}
    ${pageHeader({ title: "청구", desc: admin ? "발행·입금" : "내 청구 내역", action })}
    ${dueNote}
    ${admin ? tabs : ""}
    ${searchBar}
    ${resultNote}
    ${list}`;
  res.send(layout({ title: "청구", user, current: "/invoices", body }));
});

// (GET /new·POST / 수동 청구 라우트는 2026-07-08 폐지 — 청구 생성은 프로젝트 청구 탭 from-tasks 경로만.)

// ── 상세 ──
// 청구처 정보: 발행 시점 스냅샷(payer_snapshot) 우선 — 이후 클라이언트 정보가 바뀌어도 과거 청구서 표시/PDF 고정.
// 없으면(레거시 청구서) 실시간 party 폴백. { client, contacts } 반환.
function payerView(inv) {
  if (inv && inv.payer_snapshot) {
    try { const s = JSON.parse(inv.payer_snapshot); return { client: s, contacts: s.contacts || [] }; }
    catch (_e) { /* 파싱 실패 시 실시간 폴백 */ }
  }
  const client = inv && inv.payer_id ? getParty(inv.payer_id) : null;
  return { client, contacts: client ? listOrgContacts(client.id) : [] }; // 담당자로 지정된 사람만
}

router.get("/:id", requireBilling, (req, res) => {
  const inv = getInvoiceForUser(req.user, Number(req.params.id));
  if (!inv) return res.status(404).send(errorPage({ code: 404, title: "청구를 찾을 수 없습니다", message: "삭제되었거나 주소가 잘못되었습니다.", user: req.user }));
  const admin = canBill(req.user); // 보기·삭제 권한(치프·대표·스태프)
  const canProcess = canInvoice(req.user); // 계산서·입금 처리 = 대표·치프
  // 목록에서 넘어온 복귀 경로(?return= — 보던 탭·검색·open 카드 보존, 2026-07-08 사용자 요청
  // '입금완료 탭에서 상세 갔다가 뒤로 가면 발행 필요로 떨어짐'). 내부 절대경로만(safePath), 없으면 기본 목록.
  const backHref = safePath(req.query.return) || "/invoices";
  // 상세에서 계산서·입금 토글 후에도 상세로 복귀하되 return을 유지해 백링크가 계속 원래 탭을 가리키게.
  const selfRet = `/invoices/${inv.id}` + (backHref !== "/invoices" ? `?return=${encodeURIComponent(backHref)}` : "");
  const itemBundle = listInvoiceItemsForInvoice(req.user, inv.id);
  const items = itemBundle ? itemBundle.rows : [];
  const pdfTypes = DOC_TYPES; // 3종 모두 상태 무관 발행 허용(미발행 초안도 견적서·내역서·거래명세서)
  // 청구처 정보(대표자·사업자번호·담당자 연락처) — 발행 시점 스냅샷 우선(payerView). biz_license 파일 링크만 실시간(현재 첨부).
  const { client: payerClient, contacts: payerContacts } = payerView(inv);
  // 발행 후 클라이언트 정보가 바뀐 경우에만 카드 우하단에 경고 + 새로고침(스냅샷만 현재 정보로 갱신 — 금액·항목·번호 불변, 2026-07-08 사용자 요청).
  const payerStaleFooter = payerSnapshotChanged(inv)
    ? `<div class="mt-2 flex flex-wrap items-center justify-end gap-2 border-t border-border pt-2">
         <span aria-hidden="true">⚠️</span>
         <span class="text-xs text-warning">청구처 정보가 업데이트되었습니다 — 아래는 발행 당시 정보입니다.</span>
         <form method="post" action="/invoices/${inv.id}/refresh-payer"><input type="hidden" name="return" value="${esc(selfRet)}" /><button class="btn-ghost btn-sm" type="submit">새로고침</button></form>
       </div>`
    : "";
  const payerCard = payerClient
    ? payerInfoCard(payerClient, payerContacts, payerClient.id ? !!getClientFile(payerClient.id, "biz_license") : false, { footer: payerStaleFooter, returnTo: selfRet })
    : "";

  // 행 자체엔 줄 없음(2026-07-08 사용자 요청 '청구번호-발행일, 소계-VAT-총액 사이 줄 없애줘') — 구분선은 그룹 래퍼(border)로만.
  const row = (label, value) =>
    `<div class="flex justify-between py-1.5"><span class="text-sm text-muted">${esc(label)}</span><span class="text-sm font-medium">${value}</span></div>`;

  // PDF 발행 + 계산서·입금 처리(대표·치프만)를 한 줄에(2026-07-06 사용자 요청 — 이전엔 각자 border-t로 줄이 나뉘어 있었음).
  // 왼쪽=PDF 발행(항상), 오른쪽=처리 토글 버튼 2개(canProcess만, 청구 목록 '발행 필요' 카드와 동일한 taxToggleButtons 공용).
  const pdfSection = `
      <div class="mt-4 flex flex-wrap items-center justify-between gap-2 border-t border-border pt-3">
        <div class="flex flex-wrap items-center gap-1.5">
          <span class="text-xs text-muted">PDF 발행:</span>
          ${pdfTypes.map((t) => `<a href="/invoices/${inv.id}/statement/${encodeURIComponent(docNumberWithType(inv.invoice_number, t) || t)}.pdf?type=${encodeURIComponent(t)}" class="btn-ghost btn-sm" target="_blank" rel="noopener">${esc(t)}</a>`).join("")}
        </div>
        ${canProcess ? `<div class="flex flex-wrap gap-2">${taxToggleButtons(inv, selfRet)}</div>` : ""}
      </div>`;
  // 삭제(치프·대표·스태프=canBill). 청구 생성자가 잘못 만든 청구를 정리.
  const deleteBlock = admin
    ? `
    <div class="card mt-3 flex flex-wrap items-center gap-2">
      <form method="post" action="/invoices/${inv.id}/delete" data-confirm="이 청구를 삭제할까요? 발행한 청구는 수정 대신 삭제 후 다시 발행합니다."><button class="btn-ghost btn-sm text-danger">삭제</button></form>
      <span class="text-xs text-muted">수정이 필요하면 삭제 후 다시 발행하세요.</span>
    </div>`
    : "";

  // 레이아웃(2026-07-05 사용자 요청, 2026-07-08 순서 재배치 '헷갈린다'): 청구처 정보 최상단 →
  // 통합 카드(청구번호 → 발행일 → 프로젝트 → 청구 항목 → 소계·할인·VAT·총액[영수증식 아래 합산] → PDF·처리) → 메모 → 삭제.
  const body = `
    ${flashBanner(req.query)}
    ${pageHeader({ title: inv.title, back: { href: backHref, label: "청구" } })}
    ${payerCard}
    <div class="card mt-3">
      <div class="border-b border-border pb-1">
        ${inv.invoice_number ? row("청구번호", esc(inv.invoice_number)) : ""}
        ${row("발행일", inv.issued_date ? esc(formatYmdShort(inv.issued_date)) : "<span class='text-muted'>미정</span>")}
        ${inv.project_title ? row("프로젝트", `<a href="/projects/${inv.project_id}" class="text-primary hover:underline">${esc(inv.project_title)}</a>`) : ""}
      </div>
      ${invoiceItemsSection(items)}
      <div${items.length ? ' class="border-t border-border pt-1"' : ' class="pt-1"'}>
        ${items.length ? row("소계", copyable(String(items.reduce((s, it) => s + (it.amount || 0), 0)), { display: formatKRW(items.reduce((s, it) => s + (it.amount || 0), 0)) })) : ""}
        ${inv.discount_amount ? row("할인", copyable(String(inv.discount_amount), { cls: "text-success", display: `-${formatKRW(inv.discount_amount)}` })) : ""}
        ${inv.tax_amount ? row("VAT", copyable(String(inv.tax_amount), { display: formatKRW(inv.tax_amount) })) : ""}
        ${row("총액", copyable(String(inv.amount || 0), { cls: "text-base font-semibold", display: formatKRW(inv.amount) }))}
      </div>
      ${pdfSection}
    </div>
    ${inv.memo ? `<div class="card mt-3"><div class="mb-1 text-sm text-muted">메모</div><div class="whitespace-pre-wrap text-sm">${esc(inv.memo)}</div></div>` : ""}
    ${deleteBlock}`;
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

/** 청구 항목 섹션 — 통합 카드 내부용(카드 래퍼 없음, 2026-07-05 재배치: 청구번호·금액과 같은 카드). */
function invoiceItemsSection(items) {
  if (!items.length) return "";
  const rows = items
    .map(
      (item) => `
      <div class="flex items-start justify-between gap-3 py-1.5">
        <div class="min-w-0">
          <div class="text-sm">${copyable(item.description, { cls: "font-medium" })}</div>
          <div class="mt-0.5 text-xs text-muted">${esc(String(item.quantity))} x ${formatKRW(item.unit_price)}</div>
        </div>
        ${copyable(String(item.amount || 0), { cls: "shrink-0 text-sm font-semibold", display: formatKRW(item.amount) })}
      </div>`
    )
    .join("");
  // border-t 없음(2026-07-06 사용자 리포트 '프로젝트랑 청구 항목 사이에 줄이 2개') — 바로 위 row()가 이미
  // border-b를 그리므로 여기서 또 border-t를 그으면 사실상 같은 자리에 선이 두 겹으로 겹쳐 보인다.
  // 헤더 우측 '공급가'는 제거(2026-07-08 사용자 요청) — 항목 아래 '소계' 행이 그 역할(supply는 라우트에서 소계 행으로 렌더).
  return `
    <div class="mt-3">
      <h2 class="mb-2 font-display text-base font-semibold">청구 항목</h2>
      ${rows}
    </div>`;
}

// ── 수정 라우트 없음: 발행=확정 원칙. 발행된 청구의 내용 변경은 삭제(POST /:id/delete) 후 다시 발행한다. ──

// (수동 입금(/pay)·입금 이력 삭제 라우트는 2026-07-05 폐기 — 입금 처리는 [입금완료] 토글(tax-status)만. payments 인프라는 토글의 자동 완납·되돌리기가 사용.)


// (청구서 상태 변경 라우트 폐기 — 생성=발행 단일 흐름이라 미발행↔발행 전환 UI·호출부 없음, 2026-07-04 죽은 라우트 제거)

// ── 청구처 스냅샷 새로고침 ── 발행 후 클라이언트 정보가 보강·수정된 경우 payer_snapshot만 현재 party 정보로 갱신.
// 금액·항목·청구번호·입금 상태는 불변(정보 보정일 뿐 재발행 아님). 변경 없으면 상세 카드에 버튼 자체가 안 뜬다(payerSnapshotChanged).
router.post("/:id/refresh-payer", requireBilling, (req, res) => {
  const inv = db().prepare("SELECT * FROM invoices WHERE id = ?").get(Number(req.params.id));
  if (!inv) return res.status(404).send(errorPage({ code: 404, title: "청구를 찾을 수 없습니다", message: "삭제되었거나 주소가 잘못되었습니다.", user: req.user }));
  if (inv.payer_id) db().prepare("UPDATE invoices SET payer_snapshot = ? WHERE id = ?").run(snapshotPayer(inv.payer_id), inv.id);
  res.redirect(returnTo(req, `/invoices/${inv.id}`, "saved"));
});

// ── 계산서·입금 상태 변경(관리자) ── 계산서 미발행 → 계산서 발행 → 입금완료(자유 선택). 입금완료 선택=완납, 벗어나면 입금액 0.
router.post("/:id/tax-status", requireInvoice, (req, res) => {
  const inv = db().prepare("SELECT * FROM invoices WHERE id = ?").get(Number(req.params.id));
  if (!inv) return res.status(404).send(errorPage({ code: 404, title: "청구를 찾을 수 없습니다", message: "삭제되었거나 주소가 잘못되었습니다.", user: req.user }));
  const tax = normalizeTaxStatus(req.body.tax_status);
  // 입금 이력 변경 + tax_status UPDATE + 채번을 **한 트랜잭션**으로(2026-07-09 감사 — 이전엔 addPayment/deletePayment가
  // 각자 커밋된 뒤 상태 UPDATE가 별도 트랜잭션이라, UPDATE 실패 시 자동 완납 입금만 남는 불일치 틈이 있었음).
  // addPayment/deletePayment 헬퍼는 자체 BEGIN IMMEDIATE라 중첩 불가 → 같은 로직(INSERT/DELETE + recomputePaid)을 인라인.
  const d = db();
  d.exec("BEGIN IMMEDIATE");
  try {
    // 입금완료 선택 → 완납. 잔금이 있으면 그만큼 자동 입금 1건(paid_amount는 SUM(payments) 재계산).
    if (tax === "입금완료") {
      const bal = balanceOf(inv);
      if (bal > 0) {
        d.prepare("INSERT INTO payments (invoice_id, amount, paid_on, memo) VALUES (?, ?, ?, ?)").run(inv.id, bal, todayYmd(), "입금완료 처리");
        recomputePaid(inv.id);
      }
    }
    // 입금완료 되돌리기 — 자동 완납 입금('입금완료 처리')만 제거해 잔금 복원(사용자 직접 입금 이력은 memo가 달라 보존).
    else if (inv.tax_status === "입금완료") {
      d.prepare("DELETE FROM payments WHERE invoice_id = ? AND memo = '입금완료 처리'").run(inv.id);
      recomputePaid(inv.id);
    }
    d.prepare("UPDATE invoices SET tax_status=? WHERE id=?").run(tax, inv.id);
    ensureInvoiceNumber({ ...inv, tax_status: tax }); // 계산서 발행/입금완료면 채번 보장(내부 트랜잭션 없음 — 여기 참여)
    d.exec("COMMIT");
  } catch (e) {
    try { d.exec("ROLLBACK"); } catch (_) { /* ignore */ }
    throw e;
  }
  logAudit(req.user, "invoice.tax", `#${inv.id} ${inv.title || ""} → ${tax}`);
  res.redirect(returnTo(req, `/invoices/${inv.id}`, "saved"));
});

// ── 삭제(관리자) ── 연결 작업의 청구 잠금을 먼저 해제(좀비 작업 방지). data.js deleteInvoice 트랜잭션.
router.post("/:id/delete", requireBilling, (req, res) => {
  const invDel = db().prepare("SELECT title, invoice_number FROM invoices WHERE id = ?").get(Number(req.params.id));
  deleteInvoice(req.user, Number(req.params.id));
  if (invDel) logAudit(req.user, "invoice.delete", `#${req.params.id} ${invDel.invoice_number || ""} ${invDel.title || ""}`.trim());
  // 삭제 후엔 인보이스가 없으니 청구 탭 복귀 시 open=ID는 무시됨(그 행 미생성). 기본은 청구 목록.
  res.redirect(returnTo(req, "/invoices", "deleted"));
});

module.exports = router;
