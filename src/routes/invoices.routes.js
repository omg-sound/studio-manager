"use strict";

const express = require("express");
const { db } = require("../db");
const { requireBilling, canBill } = require("../auth");
const { INVOICE_STATUSES, INVOICE_STATUS_LABELS, TAX_STATUSES, normalizeInvoiceStatus, normalizeTaxStatus, normalizeDocType, DOC_TYPES } = require("../config");
const {
  clientOptions,
  contactOptions,
  ensureClientFromContact,
  listInvoices,
  getInvoiceForUser,
  listInvoiceItemsForInvoice,
  balanceOf,
  payStatusOf,
  isOverdue,
  deleteInvoice,
  getStudioInfo,
  getStudioLogo,
  getClient,
  getClientFile,
  listContactsForClient,
  ensureInvoiceNumber,
} = require("../data");
const { layout, pageHeader, esc, formatKRW, flashBanner, errorPage, emptyState, listGroup, explain } = require("../views");
const { invoiceRow, invoiceBadge, payerInfoCard } = require("../views.invoices");
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
  const f = req.query.f || ""; // '', 미발행, 발행, 연체, 입금완료
  const q = (req.query.q || "").toString().trim();
  let rows;
  if (admin) {
    if (f === "연체") rows = listInvoices(user, { overdue: true });
    else if (INVOICE_STATUSES.includes(f) || f === "입금완료") rows = listInvoices(user, { status: f }); // 입금완료=계산서·입금 축 필터
    else rows = listInvoices(user, {});
  } else {
    rows = listInvoices(user, {});
  }

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

  const totalDue = rows.reduce((s, i) => s + (i.status === "발행" ? balanceOf(i) : 0), 0);

  // 칩 링크는 현재 q를 함께 전달해 필터와 공존.
  const chip = (label, val) => {
    const active = f === val || (!f && val === "");
    const href = val
      ? `/invoices?f=${encodeURIComponent(val)}${q ? "&q=" + encodeURIComponent(q) : ""}`
      : `/invoices${q ? "?q=" + encodeURIComponent(q) : ""}`;
    return `<a href="${href}" class="badge ${active ? "bg-primary text-primary-fg" : "bg-surface border border-border text-muted"}">${esc(label)}</a>`;
  };
  const filterBar = admin
    ? `<div class="mb-4 flex flex-wrap gap-2">
         ${chip("전체", "")}${chip("미발행", "미발행")}${chip("발행", "발행")}${chip("연체", "연체")}${chip("입금완료", "입금완료")}
       </div>`
    : "";

  // 검색바: GET form. f 필터가 선택된 경우 hidden으로 보존.
  const searchBar = `
    <form method="get" action="/invoices" class="mb-4 flex gap-2">
      ${f ? `<input type="hidden" name="f" value="${esc(f)}" />` : ""}
      <input class="input min-w-0 flex-1" type="search" name="q" value="${esc(q)}" placeholder="제목 · 채번 · 클라이언트 검색" aria-label="청구 검색" />
      <button class="btn-primary shrink-0" type="submit">검색</button>
    </form>`;
  const resultNote = q
    ? `<div class="mb-3 text-sm text-muted">"${esc(q)}" 결과 ${rows.length}건 · <a href="/invoices${f ? "?f=" + encodeURIComponent(f) : ""}" class="text-primary hover:underline">검색 초기화</a></div>`
    : "";

  const list = rows.length
    ? listGroup({ rows: rows.map((i) => invoiceRow(i)).join("") })
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
    ${searchBar}
    ${filterBar}
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
      `INSERT INTO invoices (project_id, payer_id, title, amount, tax_amount, discount_amount, paid_amount, status, tax_status, issued_date, due_date, memo)
       VALUES (@project_id,@payer_id,@title,@amount,@tax,@discount,@paid,@status,@tax_status,@issued_date,@due_date,@memo)`
    )
    .run({
      project_id: refs.projectId,
      payer_id: refs.clientId,
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
router.get("/:id", requireBilling, (req, res) => {
  const inv = getInvoiceForUser(req.user, Number(req.params.id));
  if (!inv) return res.status(404).send(errorPage({ code: 404, title: "청구를 찾을 수 없습니다", message: "삭제되었거나 주소가 잘못되었습니다.", user: req.user }));
  const admin = canBill(req.user);
  const bal = balanceOf(inv);
  const itemBundle = listInvoiceItemsForInvoice(req.user, inv.id);
  const items = itemBundle ? itemBundle.rows : [];
  const pdfTypes = DOC_TYPES; // 3종 모두 상태 무관 발행 허용(미발행 초안도 견적서·내역서·거래명세서)
  // 청구처 정보(대표자·사업자번호·담당자 연락처) — 청구처가 클라이언트일 때
  const payerClient = inv.payer_id ? getClient(inv.payer_id) : null;
  const payerCard = payerClient
    ? payerInfoCard(payerClient, listContactsForClient(payerClient.id), !!getClientFile(payerClient.id, "biz_license"))
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
      <form method="post" action="/invoices/${inv.id}/pay" class="space-y-1">
        <label class="label mb-0.5 text-xs">지금까지 받은 총액(원)</label>
        <div class="flex items-stretch gap-2">
          <input class="input flex-1" name="paid_amount" inputmode="numeric" value="${inv.paid_amount || ""}" placeholder="0" />
          <button class="btn-ghost shrink-0" type="submit">입력액으로 갱신</button>
          <button class="btn-primary shrink-0" name="full" value="1">완납 처리</button>
        </div>
        <p class="text-[11px] text-muted">누적 입금액 기준(부분납 가능)</p>
      </form>
      <div class="flex items-center gap-2 pt-1">
        <form method="post" action="/invoices/${inv.id}/delete" data-confirm="이 청구를 삭제할까요? 발행한 청구는 수정 대신 삭제 후 다시 발행합니다."><button class="btn-ghost text-danger">삭제</button></form>
        <span class="text-xs text-muted">수정이 필요하면 삭제 후 다시 발행하세요.</span>
      </div>
    </div>`
    : "";

  const body = `
    ${flashBanner(req.query)}
    ${pageHeader({ title: inv.title, desc: inv.client_name || "청구처 미지정", back: { href: "/invoices", label: "청구" }, action: invoiceBadge(inv) })}
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
        ${pdfTypes.map((t) => `<a href="/invoices/${inv.id}/statement.pdf?type=${encodeURIComponent(t)}" class="btn-ghost btn-sm" target="_blank" rel="noopener">${esc(t)}</a>`).join("")}
      </div>
    ${invoiceItemsCard(items)}
    ${inv.memo ? `<div class="card mt-3"><div class="mb-1 text-sm text-muted">메모</div><div class="whitespace-pre-wrap text-sm">${esc(inv.memo)}</div></div>` : ""}
    ${adminControls}`;
  res.send(layout({ title: inv.title, user: req.user, current: "/invoices", body }));
});

// ── 거래명세서 PDF (발행/입금완료 또는 견적서 타입은 미발행도 허용. PII → 인증 필수·no-store·즉석 스트리밍) ──
router.get("/:id/statement.pdf", requireBilling, asyncHandler(async (req, res) => {
  let inv = getInvoiceForUser(req.user, Number(req.params.id));
  if (!inv) return res.status(404).send(errorPage({ code: 404, title: "청구를 찾을 수 없습니다", message: "삭제되었거나 주소가 잘못되었습니다.", user: req.user }));
  const docType = normalizeDocType(req.query.type);
  inv = ensureInvoiceNumber(inv); // 수동 발행분도 채번 보장(발행/입금완료 한정, 내부 가드 있음)
  // 3종 문서(견적서·내역서·거래명세서) 모두 상태 무관 발행 허용 — 참고용 문서라 미발행 초안에서도 뽑을 수 있게(사용자 요청).
  const bundle = listInvoiceItemsForInvoice(req.user, inv.id);
  const items = bundle ? bundle.rows : [];
  const client = inv.payer_id ? getClient(inv.payer_id) || { name: inv.client_name || "" } : { name: inv.client_name || "" };
  const pdf = await renderInvoicePdf({ studio: getStudioInfo(), logo: getStudioLogo(), client, invoice: inv, items, docType });
  res.setHeader("Content-Type", "application/pdf");
  res.setHeader("Content-Disposition", `inline; filename*=UTF-8''${encodeURIComponent((inv.invoice_number || "statement") + ".pdf")}`);
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

// ── 입금 처리(관리자) ── 계산서·입금 축(tax_status)만 조정. 청구서 발행 상태(status)는 건드리지 않는다.
router.post("/:id/pay", requireBilling, (req, res) => {
  const inv = db().prepare("SELECT * FROM invoices WHERE id = ?").get(Number(req.params.id));
  if (!inv) return res.status(404).send(errorPage({ code: 404, title: "청구를 찾을 수 없습니다", message: "삭제되었거나 주소가 잘못되었습니다.", user: req.user }));
  const paid = req.body.full === "1" ? inv.amount : parseMoney(req.body.paid_amount);
  // 완납이면 계산서·입금 축을 입금완료로. 미완납인데 기존이 입금완료면 계산서 발행으로 강등(완납 취소 정합성). 그 외는 유지.
  let tax = inv.tax_status;
  if (inv.amount > 0 && paid >= inv.amount) tax = "입금완료";
  else if (inv.tax_status === "입금완료") tax = "계산서 발행";
  const d = db();
  d.exec("BEGIN IMMEDIATE");
  try {
    d.prepare("UPDATE invoices SET paid_amount=?, tax_status=? WHERE id=?").run(paid, tax, inv.id);
    ensureInvoiceNumber({ ...inv, tax_status: tax }); // 입금완료/계산서 발행이면 채번 보장
    d.exec("COMMIT");
  } catch (e) {
    try { d.exec("ROLLBACK"); } catch (_) { /* ignore */ }
    throw e;
  }
  res.redirect(returnTo(req, `/invoices/${inv.id}`, "paid"));
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
  let paid = inv.paid_amount;
  if (tax === "입금완료") paid = inv.amount; // 입금완료 선택 → 완납(입금액=총액)
  // 입금완료에서 다른 계산서 상태로 옮겨도 입금액은 보존한다(문서 단계 변경이 실제 입금 기록을 지우면 안 됨).
  // 완납 취소가 필요하면 '입금 처리'의 입력액 0/완납 취소로 명시 조정한다.
  const d = db();
  d.exec("BEGIN IMMEDIATE");
  try {
    d.prepare("UPDATE invoices SET tax_status=?, paid_amount=? WHERE id=?").run(tax, paid, inv.id);
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
  // 청구처 콤보(클라이언트 + 담당자) — from-tasks와 동일 UX. 담당자 선택 시 payer_contact_id → ensureClientFromContact로 개인 청구처 변환.
  const contactOpts = contactOptions();
  const selClient = inv.payer_id ? clients.find((c) => c.id === Number(inv.payer_id)) : null;
  const dlId = "dl-inv-clients";
  const clientSelect = `
    <div data-client-combo>
      <input type="hidden" name="client_id" value="${selClient ? selClient.id : ""}" data-client-id />
      <input type="hidden" name="payer_contact_id" value="" data-payer-contact-id />
      <input class="input" type="text" list="${dlId}" data-client-search autocomplete="off"
        placeholder="클라이언트·담당자 이름 일부 입력 후 선택…" value="${selClient ? esc(selClient.name + (selClient.kind ? " · " + selClient.kind : "")) : ""}" aria-label="청구처 검색" />
      <datalist id="${dlId}">
        ${clients.map((c) => `<option value="${esc(c.name + (c.kind ? " · " + c.kind : ""))}" data-id="${c.id}"></option>`).join("")}
        ${contactOpts.map((o) => `<option value="${esc(o.name)} · 담당자${o.current_client ? " · " + esc(o.current_client) : o.phone ? " · " + esc(o.phone) : " #" + o.id}" data-contact-id="${o.id}"></option>`).join("")}
      </datalist>
      ${explain(`클라이언트·담당자 이름 일부만 입력해도 좁혀집니다. 담당자를 고르면 개인 청구처로 등록됩니다. 비워 두면 자동/미지정.`)}
    </div>`;
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
