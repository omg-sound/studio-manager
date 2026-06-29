"use strict";

/** 청구(인보이스) 렌더 — 목록 행/배지/프로젝트 상세 섹션. */

const { INVOICE_STATUS_BADGE } = require("./config");
const { esc, formatKRW, emptyState, detailsChevron, listRow } = require("./views");
const { balanceOf, payStatusOf, isOverdue } = require("./data");
const { formatYmdShort, ddayLabel } = require("./lib/date");

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

/** 목록 행(링크 카드). compact=프로젝트 상세용 축약. */
function invoiceRow(inv, { compact = false } = {}) {
  const bal = balanceOf(inv);
  const sub = compact
    ? esc(inv.client_name || "실결제자 미지정")
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
    // 섹션 내 축약 행: 기존 border-b 구분선 방식 유지 + row-link hover + tabular 금액
    return `
    <a href="/invoices/${inv.id}" class="row-link flex items-center justify-between gap-3 border-b border-border py-3 last:border-0">
      <div class="min-w-0">
        <div class="flex items-center gap-2">${invoiceBadge(inv)}<span class="truncate font-medium">${esc(inv.title)}</span></div>
        <div class="mt-0.5 truncate text-xs text-muted">${sub}</div>
      </div>
      <div class="shrink-0 text-right">
        <div class="tabular text-sm font-semibold">${formatKRW(inv.amount)}</div>
        ${balLine}
      </div>
    </a>`;
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
function invoicesSection({ project, rows, isAdmin, collapsed = false, unbilledForm = "", unbilledCount = 0 }) {
  const list = rows.length
    ? rows.map((i) => invoiceRow(i, { compact: true })).join("")
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
      ${unbilledForm ? `<div class="mb-3">${unbilledForm}</div>` : ""}
      ${manualLink ? `<div class="mb-2 flex justify-end">${manualLink}</div>` : ""}
      ${summary}
      ${list}`;
    return `
    <details class="card group mt-3"${open}>
      <summary class="flex cursor-pointer list-none items-center justify-between gap-3">
        <h2 class="font-display text-base font-semibold">청구 <span class="text-sm font-normal text-muted">${rows.length}</span></h2>
        <span class="flex items-center gap-3">${unbilledHint}${dueHint}${detailsChevron()}</span>
      </summary>
      <div class="mt-3 border-t border-border pt-3">${body}</div>
    </details>`;
  }

  return `
    <div class="card mt-3">
      <div class="mb-2 flex items-center justify-between">
        <h2 class="font-display text-base font-semibold">청구</h2>
        ${manualLink}
      </div>
      ${unbilledForm ? `<div class="mb-3">${unbilledForm}</div>` : ""}
      ${summary}
      ${list}</div>`;
}

module.exports = { invoiceBadge, invoiceRow, invoicesSection, displayStatus };
