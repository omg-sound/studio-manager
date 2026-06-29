"use strict";

const express = require("express");
const { db } = require("../db");
const { requireInvoice, canInvoice } = require("../auth");
const { config, INVOICE_STATUSES, normalizeInvoiceStatus } = require("../config");
const {
  clientOptions,
  listInvoices,
  getInvoiceForUser,
  listInvoiceItemsForInvoice,
  balanceOf,
  payStatusOf,
  isOverdue,
  deleteInvoice,
  getStudioInfo,
  getClient,
  ensureInvoiceNumber,
} = require("../data");
const { layout, pageHeader, esc, formatKRW, flashBanner, errorPage, emptyState } = require("../views");
const { invoiceRow, invoiceBadge } = require("../views.invoices");
const { formatYmdShort, ddayLabel } = require("../lib/date");
const { parseMoney, cleanYmd } = require("../lib/forms");
const { asyncHandler } = require("../lib/async");
const { renderInvoicePdf } = require("../invoice-pdf");
const { notifyAsync } = require("../notify");

const router = express.Router();

/** 인보이스 발행 알림(신규 '발행' 전이 시). fail-safe·비차단. */
function notifyInvoiceIssued(user, id) {
  const inv = getInvoiceForUser(user, id);
  if (!inv) return;
  notifyAsync({
    type: "invoice_issued",
    title: `[청구 발행] ${inv.invoice_number || inv.title}`,
    text: `${formatKRW(inv.amount)} · ${inv.client_name || "실결제자 미지정"}`,
    fields: [{ label: "프로젝트", value: inv.project_title || "-" }],
    url: config.baseUrl ? `${config.baseUrl}/invoices/${inv.id}` : undefined,
  });
}

function projectOptions() {
  return db().prepare("SELECT id, title, client_id FROM projects ORDER BY created_at DESC").all();
}

function resolveInvoiceRefs(body) {
  const projectId = body.project_id ? Number(body.project_id) : null;
  let clientId = body.client_id ? Number(body.client_id) : null;

  if (projectId) {
    const p = db().prepare("SELECT id, client_id FROM projects WHERE id = ?").get(projectId);
    if (!p) return { error: "선택한 프로젝트를 찾을 수 없습니다." };
    if (p.client_id) clientId = p.client_id;
  }

  if (clientId) {
    const c = db().prepare("SELECT id FROM clients WHERE id = ?").get(clientId);
    if (!c) return { error: "선택한 실결제자를 찾을 수 없습니다." };
  }

  return { projectId, clientId };
}

// ── 목록(URL = 필터) ──
router.get("/", requireInvoice, (req, res) => {
  const user = req.user;
  const admin = canInvoice(user);
  const f = req.query.f || ""; // '', 미발행, 발행, 연체, 입금완료
  let rows;
  if (admin) {
    if (f === "연체") rows = listInvoices(user, { overdue: true });
    else if (INVOICE_STATUSES.includes(f)) rows = listInvoices(user, { status: f });
    else rows = listInvoices(user, {});
  } else {
    rows = listInvoices(user, {});
  }

  const totalDue = rows.reduce((s, i) => s + (i.status === "발행" ? balanceOf(i) : 0), 0);

  const chip = (label, val) => {
    const active = f === val || (!f && val === "");
    return `<a href="/invoices${val ? "?f=" + encodeURIComponent(val) : ""}" class="badge ${active ? "bg-primary text-primary-fg" : "bg-surface border border-border text-muted"}">${esc(label)}</a>`;
  };
  const filterBar = admin
    ? `<div class="mb-4 flex flex-wrap gap-2">
         ${chip("전체", "")}${chip("미발행", "미발행")}${chip("발행", "발행")}${chip("연체", "연체")}${chip("입금완료", "입금완료")}
       </div>`
    : "";

  const list = rows.length
    ? `<div class="card">${rows.map((i) => invoiceRow(i)).join("")}</div>`
    : emptyState(`청구 내역이 없습니다.${admin ? ' <a href="/invoices/new" class="text-primary hover:underline">새로 추가</a>' : ""}`, { card: true });

  const action = admin ? `<a href="/invoices/new" class="btn-primary">+ 새 청구</a>` : "";
  const dueNote = totalDue > 0
    ? `<div class="card mb-4 flex items-center justify-between"><span class="text-sm text-muted">미수금 합계</span><span class="text-lg font-bold text-danger">${formatKRW(totalDue)}</span></div>`
    : "";

  const body = `
    ${flashBanner(req.query)}
    ${pageHeader({ title: "청구", desc: admin ? "발행·입금·미수금" : "내 청구 내역", action })}
    ${dueNote}
    ${filterBar}
    ${list}`;
  res.send(layout({ title: "청구", user, current: "/invoices", body }));
});

// ── 새 청구(관리자) ──
router.get("/new", requireInvoice, (req, res) => {
  const prefill = req.query.projectId ? { project_id: Number(req.query.projectId) } : {};
  res.send(layout({ title: "새 청구", user: req.user, current: "/invoices", body: invoiceForm(prefill) }));
});

router.post("/", requireInvoice, (req, res) => {
  const b = req.body;
  const title = String(b.title || "").trim();
  if (!title) return res.send(layout({ title: "새 청구", user: req.user, current: "/invoices", body: invoiceForm({ ...b, _err: "제목을 입력하세요." }) }));

  const refs = resolveInvoiceRefs(b);
  if (refs.error) {
    return res.send(layout({ title: "새 청구", user: req.user, current: "/invoices", body: invoiceForm({ ...b, _err: refs.error }) }));
  }
  const amount = parseMoney(b.amount);
  const status = normalizeInvoiceStatus(b.status);
  // 입금완료로 만들면 입금액=총액 자동
  const paid = status === "입금완료" ? amount : parseMoney(b.paid_amount);

  const info = db()
    .prepare(
      `INSERT INTO invoices (project_id, client_id, title, amount, paid_amount, status, issued_date, due_date, memo)
       VALUES (@project_id,@client_id,@title,@amount,@paid,@status,@issued_date,@due_date,@memo)`
    )
    .run({
      project_id: refs.projectId,
      client_id: refs.clientId,
      title,
      amount,
      paid,
      status,
      issued_date: cleanYmd(b.issued_date),
      due_date: cleanYmd(b.due_date),
      memo: String(b.memo || "").trim() || null,
    });
  res.redirect(`/invoices/${info.lastInsertRowid}?flash=created`);
});

// ── 상세 ──
router.get("/:id", requireInvoice, (req, res) => {
  const inv = getInvoiceForUser(req.user, Number(req.params.id));
  if (!inv) return res.status(404).send(errorPage({ code: 404, title: "청구를 찾을 수 없습니다", message: "삭제되었거나 주소가 잘못되었습니다.", user: req.user }));
  const admin = canInvoice(req.user);
  const bal = balanceOf(inv);
  const itemBundle = listInvoiceItemsForInvoice(req.user, inv.id);
  const items = itemBundle ? itemBundle.rows : [];

  const row = (label, value) =>
    `<div class="flex justify-between border-b border-border py-2 last:border-0"><span class="text-sm text-muted">${esc(label)}</span><span class="text-sm font-medium">${value}</span></div>`;

  const adminControls = admin
    ? `
    <div class="card mt-3 space-y-3">
      <h2 class="text-sm font-semibold">상태 · 입금 처리</h2>
      <form method="post" action="/invoices/${inv.id}/status" class="flex items-center gap-2">
        <select name="status" class="input max-w-[10rem]" data-autosubmit>
          ${INVOICE_STATUSES.map((s) => `<option ${s === inv.status ? "selected" : ""}>${esc(s)}</option>`).join("")}
        </select>
        <noscript><button class="btn-ghost">상태 변경</button></noscript>
      </form>
      <form method="post" action="/invoices/${inv.id}/pay" class="flex items-end gap-2">
        <div class="flex-1">
          <label class="label mb-0.5 text-xs">입금액(누적, 원)</label>
          <input class="input" name="paid_amount" inputmode="numeric" value="${inv.paid_amount || ""}" placeholder="0" />
        </div>
        <button class="btn-ghost">입금 반영</button>
        <button class="btn-primary" name="full" value="1">전액 입금</button>
      </form>
      <div class="flex gap-2 pt-1">
        <a href="/invoices/${inv.id}/edit" class="btn-ghost">수정</a>
        <form method="post" action="/invoices/${inv.id}/delete" data-confirm="이 청구를 삭제할까요?"><button class="btn-ghost text-danger">삭제</button></form>
      </div>
    </div>`
    : "";

  const body = `
    ${flashBanner(req.query)}
    ${pageHeader({ title: inv.title, desc: inv.client_name || "실결제자 미지정", action: invoiceBadge(inv) })}
    <div class="card">
      ${inv.invoice_number ? row("청구번호", esc(inv.invoice_number)) : ""}
      ${row("총액", formatKRW(inv.amount))}
      ${inv.tax_amount ? row("VAT", formatKRW(inv.tax_amount)) : ""}
      ${row("입금액", formatKRW(inv.paid_amount))}
      ${row("미수금", `<span class="${bal > 0 ? "text-danger font-semibold" : ""}">${formatKRW(bal)}</span>`)}
      ${row("납입 상태", esc(payStatusOf(inv)) + (isOverdue(inv) ? ' <span class="text-danger">(연체)</span>' : ""))}
      ${row("발행일", inv.issued_date ? esc(formatYmdShort(inv.issued_date)) : "<span class='text-muted'>미정</span>")}
      ${row("마감일", inv.due_date ? `${esc(formatYmdShort(inv.due_date))} · ${esc(ddayLabel(inv.due_date))}` : "<span class='text-muted'>미정</span>")}
      ${inv.project_title ? row("프로젝트", `<a href="/projects/${inv.project_id}" class="text-primary hover:underline">${esc(inv.project_title)}</a>`) : ""}
    </div>
    ${(inv.status === "발행" || inv.status === "입금완료") ? `<div class="mt-3"><a href="/invoices/${inv.id}/statement.pdf" class="btn-ghost btn-sm" target="_blank" rel="noopener">거래명세서 PDF 보기</a></div>` : ""}
    ${invoiceItemsCard(items)}
    ${inv.memo ? `<div class="card mt-3"><div class="mb-1 text-sm text-muted">메모</div><div class="whitespace-pre-wrap text-sm">${esc(inv.memo)}</div></div>` : ""}
    ${adminControls}`;
  res.send(layout({ title: inv.title, user: req.user, current: "/invoices", body }));
});

// ── 거래명세서 PDF (발행/입금완료만, PII → 인증 필수·no-store·영속 저장 없이 즉석 스트리밍) ──
router.get("/:id/statement.pdf", requireInvoice, asyncHandler(async (req, res) => {
  let inv = getInvoiceForUser(req.user, Number(req.params.id));
  if (!inv) return res.status(404).send("청구를 찾을 수 없습니다.");
  inv = ensureInvoiceNumber(inv); // 수동 발행분도 채번 보장
  if (inv.status !== "발행" && inv.status !== "입금완료") {
    return res.status(400).send(errorPage({ code: 400, title: "발행된 청구만 명세서를 만들 수 있습니다", message: "먼저 청구를 '발행' 상태로 전환하세요.", user: req.user }));
  }
  const bundle = listInvoiceItemsForInvoice(req.user, inv.id);
  const items = bundle ? bundle.rows : [];
  const client = inv.client_id ? getClient(inv.client_id) || { name: inv.client_name || "" } : { name: inv.client_name || "" };
  const pdf = await renderInvoicePdf({ studio: getStudioInfo(), client, invoice: inv, items });
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

// ── 수정(관리자) ──
router.get("/:id/edit", requireInvoice, (req, res) => {
  const inv = db().prepare("SELECT * FROM invoices WHERE id = ?").get(Number(req.params.id));
  if (!inv) return res.status(404).send("청구를 찾을 수 없습니다.");
  res.send(layout({ title: "청구 수정", user: req.user, current: "/invoices", body: invoiceForm(inv, true) }));
});

router.post("/:id", requireInvoice, (req, res) => {
  const id = Number(req.params.id);
  const inv = db().prepare("SELECT id FROM invoices WHERE id = ?").get(id);
  if (!inv) return res.status(404).send("청구를 찾을 수 없습니다.");
  const b = req.body;
  const title = String(b.title || "").trim();
  if (!title) return res.send(layout({ title: "청구 수정", user: req.user, current: "/invoices", body: invoiceForm({ ...b, id }, true, "제목을 입력하세요.") }));
  const refs = resolveInvoiceRefs(b);
  if (refs.error) {
    return res.send(layout({ title: "청구 수정", user: req.user, current: "/invoices", body: invoiceForm({ ...b, id, _err: refs.error }, true) }));
  }
  const amount = parseMoney(b.amount);
  const status = normalizeInvoiceStatus(b.status);
  const paid = status === "입금완료" ? amount : parseMoney(b.paid_amount);
  db()
    .prepare(
      `UPDATE invoices SET project_id=@project_id, client_id=@client_id, title=@title, amount=@amount,
       paid_amount=@paid, status=@status, issued_date=@issued_date, due_date=@due_date, memo=@memo WHERE id=@id`
    )
    .run({
      id,
      project_id: refs.projectId,
      client_id: refs.clientId,
      title,
      amount,
      paid,
      status,
      issued_date: cleanYmd(b.issued_date),
      due_date: cleanYmd(b.due_date),
      memo: String(b.memo || "").trim() || null,
    });
  res.redirect(`/invoices/${id}?flash=saved`);
});

// ── 입금 처리(관리자) ──
router.post("/:id/pay", requireInvoice, (req, res) => {
  const inv = db().prepare("SELECT * FROM invoices WHERE id = ?").get(Number(req.params.id));
  if (!inv) return res.status(404).send("청구를 찾을 수 없습니다.");
  const paid = req.body.full === "1" ? inv.amount : parseMoney(req.body.paid_amount);
  // 입금액에 따라 상태 자동 보정: 전액→입금완료, 일부>0→발행(미발행이면 발행 승격).
  // 입금액이 총액 미만이면 입금완료로 남지 않도록 발행으로 강등(부분 환불·완납 취소 정합성).
  let status = inv.status;
  if (inv.amount > 0 && paid >= inv.amount) status = "입금완료";
  else if (paid > 0) status = inv.status === "미발행" ? "발행" : inv.status === "입금완료" ? "발행" : inv.status;
  else status = inv.status === "입금완료" ? "발행" : inv.status; // paid=0 완납 취소 시 발행으로
  db().prepare("UPDATE invoices SET paid_amount=?, status=? WHERE id=?").run(paid, status, inv.id);
  ensureInvoiceNumber({ ...inv, status }); // 발행/입금완료로 승격 시 채번 보장
  if (status === "발행" && inv.status !== "발행") notifyInvoiceIssued(req.user, inv.id);
  res.redirect(`/invoices/${inv.id}?flash=paid`);
});

// ── 상태 변경(관리자) ──
router.post("/:id/status", requireInvoice, (req, res) => {
  const inv = db().prepare("SELECT * FROM invoices WHERE id = ?").get(Number(req.params.id));
  if (!inv) return res.status(404).send("청구를 찾을 수 없습니다.");
  const status = normalizeInvoiceStatus(req.body.status);
  // 입금완료로 변경 시 입금액=총액 자동
  const paid = status === "입금완료" ? inv.amount : inv.paid_amount;
  db().prepare("UPDATE invoices SET status=?, paid_amount=? WHERE id=?").run(status, paid, inv.id);
  ensureInvoiceNumber({ ...inv, status }); // 발행/입금완료로 전이 시 채번 보장
  if (status === "발행" && inv.status !== "발행") notifyInvoiceIssued(req.user, inv.id);
  res.redirect(`/invoices/${inv.id}?flash=saved`);
});

// ── 삭제(관리자) ── 연결 작업의 청구 잠금을 먼저 해제(좀비 작업 방지). data.js deleteInvoice 트랜잭션.
router.post("/:id/delete", requireInvoice, (req, res) => {
  deleteInvoice(req.user, Number(req.params.id));
  res.redirect("/invoices?flash=deleted");
});

// ── 폼 ──
function invoiceForm(inv = {}, isEdit = false, err = "") {
  const e = err || inv._err || "";
  const action = isEdit ? `/invoices/${inv.id}` : "/invoices";
  const clients = clientOptions();
  const projects = projectOptions();
  const projSelect = `
    <select name="project_id" class="input">
      <option value="">프로젝트 미지정</option>
      ${projects.map((p) => `<option value="${p.id}" ${Number(inv.project_id) === p.id ? "selected" : ""}>${esc(p.title)}</option>`).join("")}
    </select>`;
  const clientSelect = `
    <select name="client_id" class="input">
      <option value="">실결제자 자동(프로젝트 기준) / 미지정</option>
      ${clients.map((c) => `<option value="${c.id}" ${Number(inv.client_id) === c.id ? "selected" : ""}>${esc(c.name)}</option>`).join("")}
    </select>`;
  return `
    ${pageHeader({ title: isEdit ? "청구 수정" : "새 청구" })}
    <form method="post" action="${action}" class="card space-y-4">
      ${e ? `<p class="rounded-lg bg-danger/10 px-3 py-2 text-sm text-danger">${esc(e)}</p>` : ""}
      <div><label class="label">제목</label><input class="input" name="title" value="${esc(inv.title || "")}" placeholder="예: 루나 1집 믹싱비" required /></div>
      <div><label class="label">프로젝트</label>${projSelect}</div>
      <div><label class="label">실결제자(프로젝트 선택 시 자동)</label>${clientSelect}</div>
      <div class="grid gap-3 sm:grid-cols-2">
        <div><label class="label">총액(원)</label><input class="input" name="amount" inputmode="numeric" value="${inv.amount ? esc(String(inv.amount)) : ""}" placeholder="0" /></div>
        <div><label class="label">입금액(원)</label><input class="input" name="paid_amount" inputmode="numeric" value="${inv.paid_amount ? esc(String(inv.paid_amount)) : ""}" placeholder="0" /></div>
      </div>
      <div class="grid gap-3 sm:grid-cols-2">
        <div><label class="label">발행일</label><input class="input" type="date" name="issued_date" value="${esc(inv.issued_date || "")}" /></div>
        <div><label class="label">마감일</label><input class="input" type="date" name="due_date" value="${esc(inv.due_date || "")}" /></div>
      </div>
      <div>
        <label class="label">상태</label>
        <select name="status" class="input">
          ${INVOICE_STATUSES.map((s) => `<option ${s === (inv.status || INVOICE_STATUSES[0]) ? "selected" : ""}>${esc(s)}</option>`).join("")}
        </select>
      </div>
      <div><label class="label">메모</label><textarea class="input" name="memo" rows="2">${esc(inv.memo || "")}</textarea></div>
      <div class="flex gap-2">
        <button class="btn-primary" type="submit">${isEdit ? "저장" : "추가"}</button>
        <a href="${isEdit ? `/invoices/${inv.id}` : "/invoices"}" class="btn-ghost">취소</a>
      </div>
    </form>`;
}

module.exports = router;
