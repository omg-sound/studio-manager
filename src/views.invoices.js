"use strict";

/** 청구(인보이스) 렌더 — 목록 행/배지/프로젝트 상세 섹션. */

const { INVOICE_STATUS_BADGE, INVOICE_STATUSES, DOC_TYPES } = require("./config");
const { esc, formatKRW, emptyState, detailsChevron, listRow } = require("./views");
const { balanceOf, payStatusOf, isOverdue } = require("./data");
const { formatYmdShort, ddayLabel } = require("./lib/date");

/**
 * 청구처(클라이언트) 정보 카드 — 대표자·사업자등록번호(첨부 사업자등록증 링크)·주소·담당자 연락처.
 * 청구 상세/프로젝트 청구 탭에서 청구처 정보를 바로 확인. hasBizFile=true면 사업자번호를 클릭해 등록증 열람.
 */
function payerInfoCard(client, contacts = [], hasBizFile = false, { compact = false } = {}) {
  if (!client || !client.id) return "";
  const cell = (label, value) =>
    `<div class="flex items-start justify-between gap-3 py-0.5"><span class="text-xs text-muted">${esc(label)}</span><span class="text-right text-sm font-medium">${value}</span></div>`;
  const rows = [];
  if (client.kind) rows.push(cell("분류", esc(client.kind)));
  if (client.owner_name) rows.push(cell("대표자", esc(client.owner_name)));
  if (client.biz_no) {
    const bn = esc(client.biz_no);
    rows.push(cell("사업자등록번호", hasBizFile
      ? `<a href="/clients/${client.id}/files/biz_license/raw" target="_blank" rel="noopener" class="text-primary hover:underline" title="첨부된 사업자등록증 보기">${bn} <span class="text-xs">↗</span></a>`
      : bn));
  }
  if (client.address) rows.push(cell("주소", esc(client.address)));
  if (client.cash_receipt_no) rows.push(cell("현금영수증", esc(client.cash_receipt_no))); // 개인(사업자등록증 없음)
  if (contacts && contacts.length) {
    const c = contacts[0];
    const parts = [`<span class="font-medium">${esc(c.name)}</span>`];
    if (c.phone) parts.push(`<a href="tel:${esc(String(c.phone).replace(/[^0-9+]/g, ""))}" class="text-info">${esc(c.phone)}</a>`);
    if (c.email) parts.push(`<a href="mailto:${esc(c.email)}" class="text-info">${esc(c.email)}</a>`);
    rows.push(cell("담당자", parts.join(" · ")));
  }
  const head = `<div class="mb-1 flex items-center justify-between gap-3"><h3 class="text-sm font-semibold">청구처 정보</h3><a href="/clients/${client.id}" class="text-xs text-muted hover:text-fg hover:underline">클라이언트 ↗</a></div>`;
  const inner = `${head}<div class="font-semibold">${esc(client.name)}</div>${rows.join("")}`;
  if (compact) return `<div class="rounded-lg border border-border bg-bg p-3 text-sm">${inner}</div>`;
  return `<div class="card mt-3"><div class="text-sm">${inner}</div></div>`;
}

/** 표시용 상태(연체/부분납 파생 반영). */
function displayStatus(inv) {
  if (isOverdue(inv)) return "연체";
  if (inv.status === "발행" && payStatusOf(inv) === "부분납") return "부분납";
  return inv.status;
}

function invoiceBadge(inv) {
  const label = displayStatus(inv);
  // 발행=badge-info(쿨톤), 나머지는 config 매핑
  if (label === "발행") return `<span class="badge-info">${esc(label)}</span>`;
  const cls = INVOICE_STATUS_BADGE[label] || "bg-muted/10 text-muted";
  return `<span class="badge ${cls}">${esc(label)}</span>`;
}

/**
 * 펼침 본문(프로젝트 청구 탭 인라인): 금액 내역·청구 항목·관리자 폼(상태/입금/수정/삭제)·PDF·전체화면 링크.
 * 모든 변경 폼은 returnTo(프로젝트 청구 탭)로 복귀해 프로젝트를 벗어나지 않는다.
 * @param {object} inv 인보이스(+ paid_amount, tax_amount, discount_amount, status …)
 * @param {object} opts items=청구 항목, isAdmin=청구권자(폼 노출), returnTo=복귀 경로(open 포함)
 */
function invoiceExpandBody(inv, { items = [], isAdmin = false, returnTo = "" } = {}) {
  const bal = balanceOf(inv);
  const issued = inv.status === "발행" || inv.status === "입금완료";
  const pdfTypes = issued ? DOC_TYPES : ["견적서"]; // 미발행은 견적서 PDF만(상세 페이지 규칙과 일치)
  const ret = esc(returnTo);

  const cell = (label, value) =>
    `<div class="flex items-center justify-between gap-2"><dt class="text-muted">${esc(label)}</dt><dd class="tabular font-medium">${value}</dd></div>`;

  const amountGrid = `
    <dl class="grid grid-cols-1 gap-y-1.5 sm:grid-cols-2 sm:gap-x-8">
      ${cell("총액", formatKRW(inv.amount))}
      ${inv.discount_amount ? cell("할인", `<span class="text-success">-${formatKRW(inv.discount_amount)}</span>`) : ""}
      ${inv.tax_amount ? cell("VAT", formatKRW(inv.tax_amount)) : ""}
      ${cell("입금액", formatKRW(inv.paid_amount))}
      ${cell("미수금", `<span class="${bal > 0 ? "font-semibold text-danger" : ""}">${formatKRW(bal)}</span>`)}
      ${cell("납입 상태", esc(payStatusOf(inv)) + (isOverdue(inv) ? ' <span class="text-danger">(연체)</span>' : ""))}
      ${cell("발행일", inv.issued_date ? esc(formatYmdShort(inv.issued_date)) : '<span class="text-muted">미정</span>')}
      ${cell("마감일", inv.due_date ? `${esc(formatYmdShort(inv.due_date))} · ${esc(ddayLabel(inv.due_date))}` : '<span class="text-muted">미정</span>')}
    </dl>`;

  const itemList = items.length
    ? `<div class="border-t border-border pt-2">
         <div class="mb-1 text-xs text-muted">청구 항목</div>
         ${items
           .map(
             (it) => `
           <div class="flex items-start justify-between gap-3 py-1">
             <div class="min-w-0"><span class="font-medium">${esc(it.description)}</span><span class="ml-1 text-xs text-muted">${esc(String(it.quantity))} × ${formatKRW(it.unit_price)}</span></div>
             <div class="shrink-0 tabular font-semibold">${formatKRW(it.amount)}</div>
           </div>`
           )
           .join("")}
       </div>`
    : "";

  const adminControls = isAdmin
    ? `<div class="space-y-2 border-t border-border pt-2">
         <form method="post" action="/invoices/${inv.id}/status" class="flex items-center gap-2">
           <input type="hidden" name="return" value="${ret}" />
           <select name="status" class="input max-w-[10rem] py-1.5 text-sm" data-autosubmit>
             ${INVOICE_STATUSES.map((s) => `<option ${s === inv.status ? "selected" : ""}>${esc(s)}</option>`).join("")}
           </select>
           <noscript><button class="btn-ghost btn-sm">상태 변경</button></noscript>
         </form>
         <form method="post" action="/invoices/${inv.id}/pay" class="space-y-1">
           <input type="hidden" name="return" value="${ret}" />
           <label class="label mb-0.5 text-xs">지금까지 받은 총액(원)</label>
           <div class="flex items-stretch gap-2">
             <input class="input py-1.5 text-sm flex-1" name="paid_amount" inputmode="numeric" value="${inv.paid_amount || ""}" placeholder="0" />
             <button class="btn-ghost btn-sm shrink-0" type="submit">입력액으로 갱신</button>
             <button class="btn-primary btn-sm shrink-0" name="full" value="1">완납 처리</button>
           </div>
         </form>
         <div class="flex items-center gap-2 pt-0.5">
           <form method="post" action="/invoices/${inv.id}/delete" data-confirm="이 청구를 삭제할까요? 발행한 청구는 수정 대신 삭제 후 다시 발행합니다.">
             <input type="hidden" name="return" value="${ret}" />
             <button class="btn-ghost btn-sm text-danger">삭제</button>
           </form>
           <span class="text-xs text-muted">수정이 필요하면 삭제 후 다시 발행하세요.</span>
         </div>
       </div>`
    : "";

  const pdfAndFull = `
    <div class="flex flex-wrap items-center gap-1.5 border-t border-border pt-2">
      <span class="text-xs text-muted">PDF</span>
      ${pdfTypes
        .map((t) => `<a href="/invoices/${inv.id}/statement.pdf?type=${encodeURIComponent(t)}" class="btn-ghost btn-sm" target="_blank" rel="noopener">${esc(t)}</a>`)
        .join("")}
      <a href="/invoices/${inv.id}" class="ml-auto text-xs text-muted hover:text-fg hover:underline">전체 화면으로 ↗</a>
    </div>`;

  const payer = inv.payerCard || ""; // 라우트가 첨부한 청구처 정보 카드(compact)
  return `<div class="mt-1 space-y-3 rounded-lg bg-elevated p-3 text-sm">${amountGrid}${payer}${itemList}${adminControls}${pdfAndFull}</div>`;
}

/** 목록 행(링크 카드). compact=프로젝트 상세 청구 탭용 — 클릭하면 그 자리에서 펼침(페이지 이동 없음). */
function invoiceRow(inv, { compact = false, items = [], isAdmin = false, returnTo = "", openId = null } = {}) {
  const bal = balanceOf(inv);
  const sub = compact
    ? esc(inv.client_name || "청구처 미지정")
    : `${esc(inv.project_title || "프로젝트 없음")}${inv.client_name ? " · " + esc(inv.client_name) : ""}`;
  const dueLine = inv.due_date
    ? `${esc(formatYmdShort(inv.due_date))} · ${esc(ddayLabel(inv.due_date))}`
    : "마감 미정";
  // 발행+잔금일 때만 '미수', 완납이면 '완납', 미발행(견적)은 표시 안 함
  let balLine = "";
  if (inv.status === "입금완료" || (bal <= 0 && inv.status !== "미발행")) {
    balLine = `<div class="text-xs text-muted">완납</div>`;
  } else if (inv.status === "발행" && bal > 0) {
    balLine = `<div class="tabular text-xs text-danger">미수 ${formatKRW(bal)}</div>`;
  } else if (inv.status === "미발행") {
    balLine = `<div class="text-xs text-muted">미발행</div>`;
  }

  if (compact) {
    // 청구 탭 행: 클릭하면 그 자리에서 펼침(details). 처리 후 ?open=ID로 복귀하면 펼쳐진 채 유지.
    const isOpen = openId != null && Number(openId) === inv.id;
    return `
    <details id="inv-${inv.id}" class="group border-b border-border last:border-0"${isOpen ? " open" : ""}>
      <summary class="row-link flex cursor-pointer list-none items-center justify-between gap-3 py-3">
        <div class="min-w-0">
          <div class="flex items-center gap-2">${invoiceBadge(inv)}<span class="truncate font-medium">${esc(inv.title)}</span></div>
          <div class="mt-0.5 truncate text-xs text-muted">${sub}</div>
        </div>
        <div class="flex shrink-0 items-center gap-2">
          <div class="text-right">
            <div class="tabular text-sm font-semibold">${formatKRW(inv.amount)}</div>
            ${balLine}
          </div>
          ${detailsChevron()}
        </div>
      </summary>
      ${invoiceExpandBody(inv, { items, isAdmin, returnTo })}
    </details>`;
  }

  // 목록 페이지: listRow 활용(listGroup 래퍼와 함께 사용)
  const left = `
    <div class="flex items-center gap-2">${invoiceBadge(inv)}<span class="truncate font-medium">${esc(inv.title)}</span></div>
    <div class="mt-0.5 truncate text-xs text-muted">${sub}</div>`;
  const right = `
    <div class="tabular text-sm font-semibold">${formatKRW(inv.amount)}</div>
    ${balLine}
    <div class="text-[11px] text-muted">${dueLine}</div>`;
  return listRow({ href: `/invoices/${inv.id}`, left, right });
}

/**
 * 프로젝트 상세용 청구 섹션. collapsed=true면 접이식(닫힌 상태에 미수금 노출).
 * unbilledForm: 미청구 작업 + 청구 가능 녹음 세션 청구 생성 폼 HTML(있으면 펼친 내용 맨 위에 표시).
 * unbilledCount: 미청구 작업·세션 수(>0이면 섹션 자동 펼침 + 헤더 배지).
 */
function invoicesSection({ project, rows, isAdmin, collapsed = false, unbilledForm = "", unbilledCount = 0, openId = null }) {
  const list = rows.length
    ? rows
        .map((i) =>
          invoiceRow(i, {
            compact: true,
            items: i.items || [],
            isAdmin,
            returnTo: `/projects/${project.id}?tab=invoice&open=${i.id}`,
            openId,
          })
        )
        .join("")
    : emptyState("청구 내역이 없습니다.");
  // 수동 경로: unbilledForm 체크리스트가 주 진입점, 직접 입력 폼은 보조 링크로 격하
  const manualLink = isAdmin
    ? `<a href="/invoices/new?projectId=${project.id}" class="text-xs text-muted hover:text-fg hover:underline">금액 직접 입력</a>`
    : "";
  const total = rows.reduce((s, i) => s + (i.amount || 0), 0);
  const due = rows.reduce((s, i) => s + (i.status === "발행" ? balanceOf(i) : 0), 0);
  const summary = rows.length
    ? `<div class="mb-2 flex gap-4 text-xs text-muted">
         <span>합계 <b class="tabular text-fg">${formatKRW(total)}</b></span>
         <span>미수 <b class="tabular ${due > 0 ? "text-danger" : "text-fg"}">${formatKRW(due)}</b></span>
       </div>`
    : "";

  if (collapsed) {
    const open = unbilledCount > 0 ? " open" : "";
    const unbilledHint = unbilledCount > 0
      ? `<span class="badge bg-warning/10 text-warning">미청구 ${unbilledCount}</span>`
      : "";
    const dueHint = due > 0 ? `<span class="tabular text-xs text-danger">미수 ${formatKRW(due)}</span>` : "";
    const body = `
      ${summary}
      ${list}
      ${manualLink ? `<div class="mt-2 flex justify-end">${manualLink}</div>` : ""}
      ${unbilledForm ? `<div class="mt-4 border-t border-border pt-4">${unbilledForm}</div>` : ""}`;
    return `
    <details class="card group mt-3"${open}>
      <summary class="flex cursor-pointer list-none items-center justify-between gap-3">
        <h2 class="font-display text-base font-semibold">청구 <span class="text-sm font-normal text-muted">${rows.length}</span></h2>
        <span class="flex items-center gap-3">${unbilledHint}${dueHint}${detailsChevron()}</span>
      </summary>
      <div class="mt-3 border-t border-border pt-3">${body}</div>
    </details>`;
  }

  // 만들어진 청구(목록)를 위로, 새 청구 생성 폼은 아래로(사용자 요청 — 이미 만든 청구를 먼저 보고, 새로 만들 땐 하단 폼).
  return `
    <div class="card mt-3">
      <div class="mb-2 flex items-center justify-between">
        <h2 class="font-display text-base font-semibold">청구</h2>
        ${manualLink}
      </div>
      ${summary}
      ${list}
      ${unbilledForm ? `<div class="mt-4 border-t border-border pt-4">${unbilledForm}</div>` : ""}
    </div>`;
}

module.exports = { invoiceBadge, invoiceRow, invoicesSection, displayStatus, payerInfoCard };
