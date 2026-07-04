"use strict";

/** 청구(인보이스) 렌더 — 목록 행/배지/프로젝트 상세 섹션. */

const { INVOICE_STATUS_BADGE, INVOICE_STATUSES, INVOICE_STATUS_LABELS, DOC_TYPES, docNumberWithType } = require("./config");
const { esc, formatKRW, emptyState, detailsChevron, copyable } = require("./views");
const { balanceOf, payStatusOf, isOverdue } = require("./data");
const { formatYmdShort, ddayLabel, todayYmd } = require("./lib/date");

/**
 * 청구처(클라이언트) 정보 카드 — 대표자·사업자등록번호(첨부 사업자등록증 링크)·주소·담당자 연락처.
 * 청구 상세/프로젝트 청구 탭에서 청구처 정보를 바로 확인. hasBizFile=true면 사업자번호를 클릭해 등록증 열람.
 */
function payerInfoCard(client, contacts = [], hasBizFile = false, { compact = false } = {}) {
  if (!client || !client.id) return "";
  const cell = (label, value) =>
    `<div class="flex items-start justify-between gap-3 py-0.5"><span class="text-xs text-muted">${esc(label)}</span><span class="text-right text-sm font-medium">${value}</span></div>`;
  const rows = [];
  if (client.kind) rows.push(cell("분류", client.kind === "company" ? "업체" : client.kind === "group" ? "그룹" : "개인")); // 내부 kind(company 등) 대신 우리 용어
  if (client.owner_name) rows.push(cell("대표자", esc(client.owner_name)));
  if (client.biz_no) {
    // 번호 클릭 = 클립보드 복사, 등록증 보기는 별도 링크로 분리.
    const viewLink = hasBizFile ? `<a href="/clients/${client.id}/files/biz_license/raw" target="_blank" rel="noopener" class="ml-2 whitespace-nowrap text-xs text-primary hover:underline">등록증 보기 ↗</a>` : "";
    rows.push(cell("사업자등록번호", `${copyable(client.biz_no, { cls: "font-medium" })}${viewLink}`));
  }
  if (client.address) rows.push(cell("주소", copyable(client.address, { cls: "font-medium" })));
  if (client.email) rows.push(cell("세금계산서 발행 이메일", copyable(client.email))); // 계산서 발행처 이메일(클릭 복사)
  if (client.cash_receipt_no) rows.push(cell("현금영수증", copyable(client.cash_receipt_no, { cls: "font-medium" }))); // 개인(사업자등록증 없음)
  if (contacts && contacts.length) {
    const c = contacts[0];
    const parts = [`<span class="font-medium">${esc(c.name)}</span>`];
    if (c.phone) parts.push(copyable(c.phone));
    if (c.email) parts.push(copyable(c.email));
    rows.push(cell("담당자", parts.join(" · ")));
  }
  const head = `<div class="mb-1 flex items-center justify-between gap-3"><h3 class="text-sm font-semibold">청구처 정보</h3><a href="/clients/${client.id}" class="text-xs text-muted hover:text-fg hover:underline">클라이언트 ↗</a></div>`;
  const inner = `${head}<div class="font-semibold">${esc(client.name)}</div>${rows.join("")}`;
  if (compact) return `<div class="rounded-lg border border-border bg-bg p-3 text-sm">${inner}</div>`;
  return `<div class="card mt-3"><div class="text-sm">${inner}</div></div>`;
}

/** 계산서·입금 축 표시 라벨(연체/부분납 파생 반영). */
function displayStatus(inv) {
  if (isOverdue(inv)) return "연체";
  if ((inv.paid_amount || 0) > 0 && balanceOf(inv) > 0) return "부분납";
  return inv.tax_status || "계산서 미발행";
}

/** 청구서(bill) 발행 배지 — 청구서 미발행 / 청구서 발행. */
function billBadge(inv) {
  const label = INVOICE_STATUS_LABELS[inv.status] || inv.status || "청구서 미발행";
  const cls = INVOICE_STATUS_BADGE[label] || "bg-muted/10 text-muted";
  return `<span class="badge ${cls}">${esc(label)}</span>`;
}

/** 청구처 유형에 따른 세무 문서명 — 개인(person)=현금영수증, 그 외(업체·그룹·미지정)=계산서. tax_status DB값(계산서 …)은 그대로, 표시만 치환. */
function taxDocOf(inv) {
  return inv && inv.payer_kind === "person" ? "현금영수증" : "계산서";
}

/** 계산서·입금 배지 — (계산서|현금영수증) 미발행 / 발행 / 입금완료(+연체·부분납 파생). */
function taxBadge(inv) {
  const label = displayStatus(inv).replace("계산서", taxDocOf(inv)); // 개인이면 '계산서'→'현금영수증' 표시
  if (label === "계산서 발행" || label === "현금영수증 발행") return `<span class="badge-info">${esc(label)}</span>`;
  const cls = INVOICE_STATUS_BADGE[displayStatus(inv)] || "bg-muted/10 text-muted";
  return `<span class="badge ${cls}">${esc(label)}</span>`;
}

/** 행/헤더 배지 — 청구서 축 + 계산서·입금 축을 함께 표시. */
function invoiceBadge(inv) {
  return `${billBadge(inv)} ${taxBadge(inv)}`;
}

/**
 * 펼침 본문(프로젝트 청구 탭 인라인): 금액 내역·청구 항목·관리자 폼(상태/입금/수정/삭제)·PDF·전체화면 링크.
 * 모든 변경 폼은 returnTo(프로젝트 청구 탭)로 복귀해 프로젝트를 벗어나지 않는다.
 * @param {object} inv 인보이스(+ paid_amount, tax_amount, discount_amount, status …)
 * @param {object} opts items=청구 항목, isAdmin=청구권자(폼 노출), returnTo=복귀 경로(open 포함)
 */
/**
 * 입금 이력 블록(이력 목록 + '입금 추가' 폼 + '완납'). 전체 화면·청구 탭 펼침 공용.
 * paid_amount는 SUM(payments) 파생이라 이 블록이 입금의 단일 편집 지점(추가·삭제).
 */
function paymentHistory(inv, payments = [], { ret = "", compact = false } = {}) {
  const sz = compact ? "py-1.5 text-sm" : "";
  const btn = compact ? "btn-sm" : "";
  const retHidden = ret ? `<input type="hidden" name="return" value="${esc(ret)}" />` : "";
  const rows = payments.length
    ? payments
        .map(
          (p) => `
        <div class="flex items-center justify-between gap-2 py-0.5">
          <div class="min-w-0 text-xs text-muted">${p.paid_on ? esc(formatYmdShort(p.paid_on)) : "날짜 미상"}${p.memo ? " · " + esc(p.memo) : ""}</div>
          <div class="flex shrink-0 items-center gap-2">
            <span class="tabular text-sm font-medium">${formatKRW(p.amount)}</span>
            <form method="post" action="/invoices/${inv.id}/payments/${p.id}/delete" data-confirm="이 입금 기록을 삭제할까요?">${retHidden}<button class="text-xs text-danger hover:underline" type="submit">삭제</button></form>
          </div>
        </div>`
        )
        .join("")
    : `<div class="text-xs text-muted">입금 내역 없음</div>`;
  const bal = balanceOf(inv);
  const settled = bal <= 0 && (inv.paid_amount || 0) > 0; // 완납(잔금 0 + 입금 있음)
  // 완납이면 추가 폼 대신 '완납 완료'만 — 초과 입금 방지. 정정은 이력 삭제로 재개.
  const addForm = settled
    ? `<div class="flex items-center gap-1.5 pt-1 text-xs text-success"><svg class="h-4 w-4" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M4 10l4 4 8-8"/></svg>완납 완료 — 정정하려면 위 이력을 삭제하세요.</div>`
    : `<form method="post" action="/invoices/${inv.id}/pay" class="flex flex-wrap items-stretch gap-2 pt-1">
        ${retHidden}
        <input class="input ${sz} min-w-0 flex-1 text-right tabular" name="amount" inputmode="numeric" placeholder="입금액(원)" />
        <input class="input ${sz} w-36" type="date" name="paid_on" value="${todayYmd()}" aria-label="입금일" />
        <button class="btn-ghost ${btn} shrink-0" type="submit">입금 추가</button>
        <button class="btn-ghost ${btn} shrink-0 border-success/40 bg-success/10 text-success" name="full" value="1" title="남은 잔금 ${formatKRW(bal)}을 전액 입금 처리">완납</button>
      </form>`;
  return `
    <div class="space-y-1">
      <div class="flex items-center justify-between gap-2">
        <label class="label mb-0 text-xs">입금 이력</label>
        <span class="text-xs text-muted">받은 총액 <b class="tabular text-fg">${formatKRW(inv.paid_amount)}</b>${bal > 0 ? ` · 미수 <b class="tabular text-danger">${formatKRW(bal)}</b>` : ""}</span>
      </div>
      <div class="space-y-0.5 rounded-lg border border-border bg-surface/40 p-2">${rows}</div>
      ${addForm}
    </div>`;
}

function invoiceExpandBody(inv, { items = [], payments = [], isAdmin = false, returnTo = "" } = {}) {
  const bal = balanceOf(inv);
  const pdfTypes = DOC_TYPES; // 3종 모두 상태 무관 발행(미발행 초안도 견적서·내역서·거래명세서)
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

  // 프로젝트 청구 탭에는 계산서·현금영수증 발행·입금 처리를 두지 않는다(청구 메뉴에서만 — 사용자 요청).
  // 여기선 청구서 상태(발행/미발행)·삭제만. 실제 청구(계산서/입금) 프로세스는 /invoices로 안내.
  const adminControls = isAdmin
    ? `<div class="space-y-2 border-t border-border pt-2">
         <div class="flex flex-wrap items-end gap-3">
           <form method="post" action="/invoices/${inv.id}/status">
             <input type="hidden" name="return" value="${ret}" />
             <label class="label mb-0.5 text-xs">청구서 상태</label>
             <select name="status" class="input max-w-[10rem] py-1.5 text-sm" data-autosubmit>
               ${INVOICE_STATUSES.map((s) => `<option value="${esc(s)}" ${s === inv.status ? "selected" : ""}>${esc(INVOICE_STATUS_LABELS[s] || s)}</option>`).join("")}
             </select>
             <noscript><button class="btn-ghost btn-sm">변경</button></noscript>
           </form>
         </div>
         <div class="flex flex-wrap items-center gap-2 pt-0.5">
           <form method="post" action="/invoices/${inv.id}/delete" data-confirm="이 청구를 삭제할까요? 발행한 청구는 수정 대신 삭제 후 다시 발행합니다.">
             <input type="hidden" name="return" value="${ret}" />
             <button class="btn-ghost btn-sm text-danger">삭제</button>
           </form>
           <span class="text-xs text-muted">계산서·현금영수증 발행과 입금 처리는 <a href="/invoices?tab=todo" class="text-primary hover:underline">청구 메뉴</a>에서 합니다. 수정은 삭제 후 재발행.</span>
         </div>
       </div>`
    : "";

  const pdfAndFull = `
    <div class="flex flex-wrap items-center gap-1.5 border-t border-border pt-2">
      <span class="text-xs text-muted">PDF</span>
      ${pdfTypes
        .map((t) => `<a href="/invoices/${inv.id}/statement/${encodeURIComponent(docNumberWithType(inv.invoice_number, t) || t)}.pdf?type=${encodeURIComponent(t)}" class="btn-ghost btn-sm" target="_blank" rel="noopener">${esc(t)}</a>`)
        .join("")}
      <a href="/invoices/${inv.id}" class="ml-auto text-xs text-muted hover:text-fg hover:underline">전체 화면으로 ↗</a>
    </div>`;

  const payer = inv.payerCard || ""; // 라우트가 첨부한 청구처 정보 카드(compact)
  return `<div class="mt-1 space-y-3 rounded-lg bg-elevated p-3 text-sm">${amountGrid}${payer}${itemList}${adminControls}${pdfAndFull}</div>`;
}

/** 청구서 표시 청구처명: 발행 시점 스냅샷(payer_snapshot.name) 우선, 없으면(레거시) 실시간 client_name. */
function payerName(inv) {
  if (inv && inv.payer_snapshot) { try { const n = JSON.parse(inv.payer_snapshot).name; if (n) return n; } catch (_e) { /* 파싱 실패 폴백 */ } }
  return inv.client_name || "";
}

/** 목록 행(링크 카드). compact=프로젝트 상세 청구 탭용 — 클릭하면 그 자리에서 펼침(페이지 이동 없음). */
function invoiceRow(inv, { compact = false, items = [], isAdmin = false, returnTo = "", openId = null, ret = "" } = {}) {
  const bal = balanceOf(inv);
  const pname = payerName(inv);
  const sub = compact
    ? esc(pname || "청구처 미지정")
    : `${esc(inv.project_title || "프로젝트 없음")}${pname ? " · " + esc(pname) : ""}`;
  const dueLine = inv.due_date
    ? `${esc(formatYmdShort(inv.due_date))} · ${esc(ddayLabel(inv.due_date))}`
    : "마감 미정";
  // 완납(입금완료 또는 잔금 0+입금 있음)이면 '완납', 청구서 발행+잔금이면 '미수'. 배지가 상태를 이미 보여줘 미발행 텍스트는 생략.
  let balLine = "";
  if (inv.tax_status === "입금완료" || (bal <= 0 && (inv.paid_amount || 0) > 0)) {
    balLine = `<div class="text-xs text-muted">완납</div>`;
  } else if (inv.status === "발행" && bal > 0) {
    balLine = `<div class="tabular text-xs text-danger">미수 ${formatKRW(bal)}</div>`;
  }

  if (compact) {
    // 청구 탭 행: 클릭하면 그 자리에서 펼침(details). 처리 후 ?open=ID로 복귀하면 펼쳐진 채 유지.
    const isOpen = openId != null && Number(openId) === inv.id;
    return `
    <details id="inv-${inv.id}" class="group border-b border-border last:border-0"${isOpen ? " open" : ""}>
      <summary class="row-link flex cursor-pointer list-none items-center justify-between gap-3 py-3">
        <div class="min-w-0">
          <div class="truncate font-medium">${esc(inv.title)}</div>
          <div class="mt-1 flex flex-wrap gap-1">${invoiceBadge(inv)}</div>
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
      ${invoiceExpandBody(inv, { items, payments: inv.payments || [], isAdmin, returnTo })}
    </details>`;
  }

  // 목록 페이지: 프로젝트 목록처럼 각 청구서를 개별 카드로(사용자 요청). 프로젝트 카드와 동일 톤(rounded-xl·border-border/60·row-link 호버).
  const left = `
    <div class="truncate font-medium">${esc(inv.title)}</div>
    <div class="mt-1 flex flex-wrap gap-1">${invoiceBadge(inv)}</div>
    <div class="mt-0.5 truncate text-xs text-muted">${sub}</div>`;
  const right = `
    <div class="tabular text-sm font-semibold">${formatKRW(inv.amount)}</div>
    ${balLine}
    <div class="text-[11px] text-muted">${dueLine}</div>`;
  // 프로젝트 카드처럼 하단에 접고 펴는 '상태 처리' 섹션 — (계산서|현금영수증) 발행 완료 / 입금완료 2버튼(청구서 발행 권한자만).
  // 상태 반영(불): 완료=success 초록 tint(켜짐), 미완료=ghost+초록 텍스트(꺼짐). 둘 다 클릭 토글 — 잘못 누르면 다시 눌러 되돌린다(사용자 요청).
  // 토글 대상: 발행 버튼=발행됨이면 미발행으로 되돌림·아니면 발행. 입금완료 버튼=입금완료면 계산서 발행으로 되돌림(자동 완납 입금은 서버가 제거)·아니면 입금완료.
  const retPath = ret || "/invoices";
  const retHidden = `<input type="hidden" name="return" value="${esc(retPath)}" />`;
  const taxDoc = taxDocOf(inv);
  const taxIssued = inv.tax_status === "계산서 발행" || inv.tax_status === "입금완료";
  const isPaid = inv.tax_status === "입금완료";
  // 색 계열: 세션 완료 토글과 동일한 은은한 success(초록) 흐름 — 완료=초록 tint, 미완료=ghost+초록 텍스트(앰버/btn-primary는 너무 강해 배제, 사용자 요청).
  const toggleBtn = (target, label, lit) =>
    `<form method="post" action="/invoices/${inv.id}/tax-status"><input type="hidden" name="tax_status" value="${esc(target)}" />${retHidden}<button class="btn-ghost btn-sm ${lit ? "border-success/40 bg-success/10 text-success" : "text-success"}" type="submit"><span aria-hidden="true" class="inline-block w-3.5 text-center ${lit ? "" : "opacity-60"}">${lit ? "✓" : "−"}</span>${esc(label)}</button></form>`;
  const actions = isAdmin
    ? `<details class="group">
         <summary class="row-link flex cursor-pointer list-none items-center justify-between gap-2 border-t border-border/40 px-4 py-2 text-xs text-muted hover:text-fg">
           <span>상태 처리</span>${detailsChevron()}
         </summary>
         <div class="flex flex-wrap justify-end gap-2 border-t border-border/40 bg-elevated/40 px-4 py-3">
           ${toggleBtn(taxIssued ? "계산서 미발행" : "계산서 발행", `${taxDoc} 발행 완료`, taxIssued)}
           ${toggleBtn(isPaid ? "계산서 발행" : "입금완료", "입금완료", isPaid)}
         </div>
       </details>`
    : "";
  return `
    <div class="overflow-hidden rounded-xl border border-border/60 bg-surface">
      <a href="/invoices/${inv.id}" class="row-link flex items-start justify-between gap-4 px-4 py-3">
        <div class="min-w-0">${left}</div>
        <div class="shrink-0 pl-2 text-right">${right}</div>
      </a>
      ${actions}
    </div>`;
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

module.exports = { invoiceBadge, invoiceRow, invoicesSection, displayStatus, payerInfoCard, paymentHistory };
