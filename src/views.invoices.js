"use strict";

/** 청구(인보이스) 렌더 — 목록 행/배지/프로젝트 상세 섹션. */

const { INVOICE_STATUS_BADGE, DOC_TYPES, docNumberWithType } = require("./config");
const { esc, formatKRW, emptyState, detailsChevron, copyable, personLabel } = require("./views");
const { balanceOf, payStatusOf, isOverdue } = require("./data");
const { formatYmdShort } = require("./lib/date"); // todayYmd·ddayLabel 미사용(입금일·마감일 개념 제거, 2026-07-05)

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
  const inner = `${head}<div class="font-semibold">${esc(personLabel(client.name, client.activity_name))}</div>${rows.join("")}`; // 아티스트면 본명 (활동명) — 현금영수증 명의 오해 방지
  if (compact) return `<div class="rounded-lg border border-border bg-bg p-3 text-sm">${inner}</div>`;
  return `<div class="card mt-3"><div class="text-sm">${inner}</div></div>`;
}

/** 계산서·입금 축 표시 라벨(연체/부분납 파생 반영). */
function displayStatus(inv) {
  if (isOverdue(inv)) return "연체";
  if ((inv.paid_amount || 0) > 0 && balanceOf(inv) > 0) return "부분납";
  return inv.tax_status || "계산서 미발행";
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

/** 행/헤더 배지 — 계산서·입금 진행 단계만 표시(청구 생성=청구서 발행 단일화로 청구서 발행 배지는 제거). */
function invoiceBadge(inv) {
  return taxBadge(inv);
}

/**
 * (계산서|현금영수증) 발행 완료 / 입금완료 토글 버튼 2개 — 청구 목록 카드·청구 상세 공용(2026-07-05 상세도 select→버튼 통일).
 * 상태 반영(불): 완료=success 초록 tint(켜짐), 미완료=ghost+초록 텍스트(꺼짐). 둘 다 클릭 토글 — 잘못 누르면 다시 눌러 되돌린다.
 * 토글 대상: 발행 버튼=발행됨이면 미발행으로 되돌림·아니면 발행. 입금완료 버튼=입금완료면 계산서 발행으로 되돌림(자동 완납 입금은 서버가 제거)·아니면 입금완료.
 * 색 계열: 세션 완료 토글과 동일한 은은한 success(초록) 흐름. 무JS 동작(폼 제출).
 */
function taxToggleButtons(inv, retPath) {
  const retHidden = `<input type="hidden" name="return" value="${esc(retPath || "/invoices")}" />`;
  const taxDoc = taxDocOf(inv);
  const taxIssued = inv.tax_status === "계산서 발행" || inv.tax_status === "입금완료";
  const isPaid = inv.tax_status === "입금완료";
  const toggleBtn = (target, label, lit) =>
    `<form method="post" action="/invoices/${inv.id}/tax-status"><input type="hidden" name="tax_status" value="${esc(target)}" />${retHidden}<button class="btn-ghost btn-sm ${lit ? "border-success/40 bg-success/10 text-success" : "text-success"}" type="submit"><span aria-hidden="true" class="inline-block w-3.5 text-center ${lit ? "" : "opacity-60"}">${lit ? "✓" : "−"}</span>${esc(label)}</button></form>`;
  return `${toggleBtn(taxIssued ? "계산서 미발행" : "계산서 발행", `${taxDoc} 발행 완료`, taxIssued)}${toggleBtn(isPaid ? "계산서 발행" : "입금완료", "입금완료", isPaid)}`;
}

/**
 * 펼침 본문(프로젝트 청구 탭 인라인): 금액 내역·청구 항목·관리자 폼(상태/입금/수정/삭제)·PDF·전체화면 링크.
 * 모든 변경 폼은 returnTo(프로젝트 청구 탭)로 복귀해 프로젝트를 벗어나지 않는다.
 * @param {object} inv 인보이스(+ paid_amount, tax_amount, discount_amount, status …)
 * @param {object} opts items=청구 항목, isAdmin=청구권자(폼 노출), returnTo=복귀 경로(open 포함)
 */
// (입금 이력·수동 입금 UI는 2026-07-05 폐기 — 분납 없는 워크플로: 입금 처리는 [입금완료] 토글 하나.
//  payments 인프라(addPayment·deletePayment 등)는 토글의 자동 완납·되돌리기가 사용하므로 데이터 레이어에 잔존.)

function invoiceExpandBody(inv, { items = [], payments = [], isAdmin = false, returnTo = "" } = {}) {
  const pdfTypes = DOC_TYPES; // 3종 모두 상태 무관 발행(미발행 초안도 견적서·내역서·거래명세서)
  const ret = esc(returnTo);

  const cell = (label, value) =>
    `<div class="flex items-center justify-between gap-2"><dt class="text-muted">${esc(label)}</dt><dd class="tabular font-medium">${value}</dd></div>`;

  // 재배치(2026-07-05 사용자 요청): 발행일 → 청구 항목 → 총액·(할인)·VAT 순. 마감일·입금액·미수금·납입상태 개념 삭제.
  const issuedLine = `
    <dl class="grid grid-cols-1 gap-y-1.5">
      ${cell("발행일", inv.issued_date ? esc(formatYmdShort(inv.issued_date)) : '<span class="text-muted">미정</span>')}
    </dl>`;

  // 금액 블록 = 영수증식 우측 정렬 스택(2026-07-05 사용자 요청 — 'VAT 오른쪽 정렬, 줄바꿔서 총액'): (할인) → VAT → 총액(마지막·강조).
  // (입금액·미수금·납입상태 줄은 제거 — 분납 없는 워크플로: 배지(발행/입금완료)가 입금 상태를 대체. 미수는 합계(목록 상단·대시보드)만.)
  const amountGrid = `
    <div class="flex flex-col items-end gap-1 border-t border-border pt-2">
      ${inv.discount_amount ? `<div class="text-muted">할인 <span class="tabular ml-2 font-medium text-success">-${formatKRW(inv.discount_amount)}</span></div>` : ""}
      ${inv.tax_amount ? `<div class="text-muted">VAT <span class="tabular ml-2 font-medium text-fg">${formatKRW(inv.tax_amount)}</span></div>` : ""}
      <div class="text-muted">총액 <span class="tabular ml-2 text-base font-semibold text-fg">${formatKRW(inv.amount)}</span></div>
    </div>`;

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

  // 프로젝트 청구 탭엔 청구 처리 컨트롤을 두지 않는다 — 선택 항목으로 청구 생성이 곧 청구서 발행이라 상태 컨트롤 불필요(사용자 요청).
  // 여기선 보기·삭제만. 청구서 발행·계산서·현금영수증·입금 처리는 전부 청구 메뉴에서.
  const adminControls = isAdmin
    ? `<div class="space-y-2 border-t border-border pt-2">
         <div class="flex flex-wrap items-center gap-2">
           <form method="post" action="/invoices/${inv.id}/delete" data-confirm="이 청구를 삭제할까요? 발행한 청구는 수정 대신 삭제 후 다시 발행합니다.">
             <input type="hidden" name="return" value="${ret}" />
             <button class="btn-ghost btn-sm text-danger">삭제</button>
           </form>
           <span class="text-xs text-muted">청구서 발행·계산서·입금 처리는 <a href="/invoices?tab=todo" class="text-primary hover:underline">청구 메뉴</a>에서 합니다. 수정은 삭제 후 재발행.</span>
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
  // 순서(2026-07-05 사용자 요청): 청구처 → 발행일 → 청구 항목 → 총액·(할인)·VAT → PDF → 삭제.
  return `<div class="mt-1 space-y-3 rounded-lg bg-elevated p-3 text-sm">${payer}${issuedLine}${itemList}${amountGrid}${pdfAndFull}${adminControls}</div>`;
}

/** 청구서 표시 청구처명 = 본명 (활동명): 발행 시점 스냅샷(payer_snapshot) 우선, 없으면(레거시) 실시간 client_name(SQL이 이미 병기). 아티스트 현금영수증 명의(본명) 오해 방지(2026-07-05). */
function payerName(inv) {
  if (inv && inv.payer_snapshot) { try { const s = JSON.parse(inv.payer_snapshot); if (s.name) return personLabel(s.name, s.activity_name); } catch (_e) { /* 파싱 실패 폴백 */ } }
  return inv.client_name || "";
}

/** 목록 행(링크 카드). compact=프로젝트 상세 청구 탭용 — 클릭하면 그 자리에서 펼침(페이지 이동 없음). */
function invoiceRow(inv, { compact = false, items = [], isAdmin = false, isInvoicer = false, returnTo = "", openId = null, ret = "" } = {}) {
  const bal = balanceOf(inv);
  const pname = payerName(inv);
  const sub = compact
    ? esc(pname || "청구처 미지정")
    : `${esc(inv.project_title || "프로젝트 없음")}${pname ? " · " + esc(pname) : ""}`;
  // 마감일·미수/완납 줄 제거(2026-07-05 사용자 결정) — 배지(발행/입금완료)가 상태를 대체, 미수는 목록 상단 합계만.

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
    <div class="tabular text-sm font-semibold">${formatKRW(inv.amount)}</div>`;
  // 프로젝트 카드처럼 하단에 접고 펴는 '상태 처리' 섹션 — (계산서|현금영수증) 발행 완료 / 입금완료 2버튼(계산서·입금 처리 권한자=대표·치프만).
  // 토글 후 ?open=ID로 복귀 → 처리한 카드의 상태 처리를 펼친 채 유지 + 스크롤(app.js #inv-<id>) — 접혀버리던 문제 수정(2026-07-05 사용자 리포트).
  const listOpen = openId != null && Number(openId) === inv.id;
  const retBase = ret || "/invoices";
  const retWithOpen = retBase + (retBase.includes("?") ? "&" : "?") + "open=" + inv.id;
  const actions = isInvoicer
    ? `<details class="group"${listOpen ? " open" : ""}>
         <summary class="row-link flex cursor-pointer list-none items-center justify-between gap-2 border-t border-border/40 px-4 py-2 text-xs text-muted hover:text-fg">
           <span>상태 처리</span>${detailsChevron()}
         </summary>
         <div class="flex flex-wrap justify-end gap-2 border-t border-border/40 bg-elevated/40 px-4 py-3">
           ${taxToggleButtons(inv, retWithOpen)}
         </div>
       </details>`
    : "";
  return `
    <div id="inv-${inv.id}" class="overflow-hidden rounded-xl border border-border/60 bg-surface">
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

module.exports = { invoiceBadge, invoiceRow, invoicesSection, payerInfoCard, payerName, taxToggleButtons }; // displayStatus는 내부 전용; payerName=청구처 표시명(본명 (활동명)) 헬퍼
