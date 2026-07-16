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
function payerInfoCard(client, contacts = [], hasBizFile = false, { compact = false, footer = "", returnTo = "" } = {}) {
  if (!client || !client.id) return "";
  const clientHref = `/clients/${client.id}${returnTo ? `?return=${encodeURIComponent(returnTo)}` : ""}`; // return=보던 청구·프로젝트로 복귀(2026-07-08)
  const cell = (label, value) =>
    `<div class="flex items-start justify-between gap-3 py-0.5"><span class="text-xs text-muted">${esc(label)}</span><span class="text-right text-sm font-medium">${value}</span></div>`;
  // 행 순서 = 홈택스 세금계산서 '공급받는자' 입력 순서(2026-07-08 사용자 요청 — 대표가 발행 시 그대로 옮겨 적게, 배치만 동일):
  // 등록번호 → 상호·성명(대표자) → 사업장 주소 → 이메일(세금계산서 발행) → 이메일(담당자). 개인은 등록번호 자리에 현금영수증 번호.
  const rows = [];
  if (client.biz_no) {
    // 번호 클릭 = 클립보드 복사. 등록증 보기 링크는 번호 앞(2026-07-08 사용자 요청).
    const viewLink = hasBizFile ? `<a href="/clients/${client.id}/files/biz_license/view" target="_blank" rel="noopener" data-popup-view class="mr-2 whitespace-nowrap text-xs text-primary hover:underline">등록증 보기 ↗</a>` : "";
    rows.push(cell("사업자등록번호", `${viewLink}${copyable(client.biz_no, { cls: "font-medium" })}`));
  }
  if (client.cash_receipt_no) rows.push(cell("현금영수증", copyable(client.cash_receipt_no, { cls: "font-medium" }))); // 개인(사업자등록증 없음) — 발행 식별번호라 등록번호 자리
  rows.push(cell(client.kind === "person" ? "성명" : "상호", copyable(client.name, { cls: "font-semibold", display: personLabel(client.name, client.activity_name) }))); // 표시=본명 (활동명)(현금영수증 명의 오해 방지), 복사=순수 본명(홈택스 붙여넣기용, 2026-07-08)
  if (client.owner_name) rows.push(cell("성명(대표자)", copyable(client.owner_name, { cls: "font-medium" }))); // 클릭 복사(2026-07-08)
  if (client.address) rows.push(cell("사업장 주소", copyable(client.address, { cls: "font-medium" })));
  // 담당자 이메일 행은 삭제(2026-07-08 사용자 요청 — 아래 '담당자' 행의 이메일과 중복). 발행 이메일만 단독 행.
  if (client.email) rows.push(cell("세금계산서 발행 이메일", copyable(client.email)));
  if (contacts && contacts.length) {
    const c = contacts[0];
    // 담당자 이름도 클릭 복사 — 정렬 때문에도 필요하다(2026-07-15 사용자 리포트 '담당자만 밖으로 삐져나옴'):
    // 다른 값은 모두 copyable이라 hover 아이콘(⧉) 자리를 오른쪽에 상시 확보하는데, 이름만 순수 텍스트라
    // 그 여백이 없어 텍스트가 한 칸 더 오른쪽으로 나와 보였다.
    const parts = [copyable(c.name, { cls: "font-medium" })];
    if (c.phone) parts.push(copyable(c.phone));
    if (c.email) parts.push(copyable(c.email));
    rows.push(cell("담당자", parts.join(" · "))); // 이름·전화 확인용(홈택스 밖 부가 정보라 맨 아래)
  }
  // ('분류' 행은 2026-07-08 사용자 요청으로 삭제 — 세금계산서 기입에 안 쓰는 부가 메타)
  const head = `<div class="mb-1 flex items-center justify-between gap-3"><h3 class="text-sm font-semibold">청구처 정보</h3><a href="${clientHref}" class="text-xs text-muted hover:text-fg hover:underline">클라이언트 ↗</a></div>`;
  const inner = `${head}${rows.join("")}${footer}`; // footer=우하단 부가 블록(스냅샷 변경 경고+새로고침 — 청구 상세만 전달)
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

/** 목록 표 상태 컬럼용 **짧은** 배지(2026-07-16 사용자 요청 '입금·발행으로 줄이자' — 좁은 열 폭 절약):
 *  계산서/현금영수증 미발행→미발행 · 발행→발행 · 입금완료→입금(+연체·부분납은 그대로). 색은 full 기준 유지. */
function taxBadgeShort(inv) {
  const full = displayStatus(inv); // 계산서 미발행 / 계산서 발행 / 입금완료 / 연체 / 부분납
  const short = full === "입금완료" ? "입금" : full.replace(/^계산서 /, "");
  if (full === "계산서 발행") return `<span class="badge-info">${esc(short)}</span>`;
  const cls = INVOICE_STATUS_BADGE[full] || "bg-muted/10 text-muted";
  return `<span class="badge ${cls}">${esc(short)}</span>`;
}

/**
 * (계산서|현금영수증) 발행 완료 / 입금완료 토글 버튼 2개 — 청구 목록 카드·청구 상세 공용(2026-07-05 상세도 select→버튼 통일).
 * 상태 반영(불): 완료=success 초록 tint(켜짐), 미완료=ghost+초록 텍스트(꺼짐). 둘 다 클릭 토글 — 잘못 누르면 다시 눌러 되돌린다.
 * 토글 대상: 발행 버튼=발행됨이면 미발행으로 되돌림·아니면 발행. 입금완료 버튼=입금완료면 계산서 발행으로 되돌림(자동 완납 입금은 서버가 제거)·아니면 입금완료.
 * 색 계열: 세션 완료 토글과 동일한 은은한 success(초록) 흐름. 무JS 동작(폼 제출).
 */
function taxToggleButtons(inv, retPath, { iconOnly = false } = {}) {
  const retHidden = `<input type="hidden" name="return" value="${esc(retPath || "/invoices")}" />`;
  const taxDoc = taxDocOf(inv);
  const taxIssued = inv.tax_status === "계산서 발행" || inv.tax_status === "입금완료";
  const isPaid = inv.tax_status === "입금완료";
  // 두 표현:
  //  · 넓은 표의 '처리' 열(iconOnly, 2026-07-16) = **아이콘만**(정사각·열 폭 고정) + hover 툴팁(title)·aria-label로 의미 전달.
  //  · 그 외(청구 상세) = **글리프(✓/−) + 긴 라벨** 버튼.
  const DOC_ICON = `<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M11.5 2.5H6a1.5 1.5 0 0 0-1.5 1.5v12A1.5 1.5 0 0 0 6 17.5h8a1.5 1.5 0 0 0 1.5-1.5V6.5z" /><path d="M11.5 2.5v4h4M7.5 10.5h5M7.5 13.5h5" /></svg>`;
  const PAY_ICON = `<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true"><circle cx="10" cy="10" r="7.25" /><text x="10" y="13.5" text-anchor="middle" font-size="9" stroke="none" fill="currentColor">₩</text></svg>`;
  const face = (icon, long, lit) =>
    iconOnly
      ? `<span class="inv-icon">${icon}</span>`
      : `<span aria-hidden="true" class="inline-block w-3.5 text-center ${lit ? "" : "opacity-60"}">${lit ? "✓" : "−"}</span>${esc(long)}`;
  const sizeCls = iconOnly ? "btn-xs" : "btn-sm";
  const toggleBtn = (target, icon, long, lit) => {
    // 툴팁·스크린리더: 현재 상태 + 누르면 무엇이 되는지(되돌리기 포함) — 아이콘만 보일 때도 의미가 전달되게.
    const hint = lit ? `${long} (누르면 되돌리기)` : `${long}로 표시`;
    return `<form method="post" action="/invoices/${inv.id}/tax-status"><input type="hidden" name="tax_status" value="${esc(target)}" />${retHidden}<button class="btn-ghost ${sizeCls} ${lit ? "border-success/40 bg-success/10 text-success" : "text-success"}" type="submit" title="${esc(hint)}" aria-label="${esc(hint)}">${face(icon, long, lit)}</button></form>`;
  };
  return `${toggleBtn(taxIssued ? "계산서 미발행" : "계산서 발행", DOC_ICON, `${taxDoc} 발행 완료`, taxIssued)}${toggleBtn(isPaid ? "계산서 발행" : "입금완료", PAY_ICON, "입금완료", isPaid)}`;
}

/** 목록 행 첫 열 = 청구처(결제 주체). 미지정이면 청구 제목으로 폴백. */
function invoicePayerLabel(inv) {
  return payerName(inv) || String(inv.title || "청구처 미지정");
}

/**
 * 펼침 본문(프로젝트 청구 탭 인라인): 금액 내역·청구 항목·관리자 폼(상태/입금/수정/삭제)·PDF·전체화면 링크.
 * 모든 변경 폼은 returnTo(프로젝트 청구 탭)로 복귀해 프로젝트를 벗어나지 않는다.
 * @param {object} inv 인보이스(+ paid_amount, tax_amount, discount_amount, status …)
 * @param {object} opts items=청구 항목, isAdmin=청구권자(폼 노출), returnTo=복귀 경로(open 포함)
 */
// (입금 이력·수동 입금 UI는 2026-07-05 폐기 — 분납 없는 워크플로: 입금 처리는 [입금완료] 토글 하나.
//  payments 인프라(addPayment·deletePayment 등)는 토글의 자동 완납·되돌리기가 사용하므로 데이터 레이어에 잔존.)

function invoiceExpandBody(inv, { items = [], isAdmin = false, returnTo = "", inList = false } = {}) {
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
           ${inList ? `<span class="text-xs text-muted">수정은 삭제 후 재발행.</span>` : `<span class="text-xs text-muted">청구서 발행·계산서·입금 처리는 <a href="/invoices?tab=todo" class="text-primary hover:underline">청구 메뉴</a>에서 합니다. 수정은 삭제 후 재발행.</span>`}
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

/**
 * 목록 행(compact) = 프로젝트 상세 청구 탭 — 클릭하면 그 자리에서 펼침(청구 항목·PDF·삭제).
 * (/invoices 목록 페이지는 2026-07-16부터 넓은 표 invoiceTable를 쓴다 — 이 행은 프로젝트 탭·클라이언트 상세 전용.)
 */
function invoiceRow(inv, { items = [], isAdmin = false, returnTo = "", openId = null } = {}) {
  const sub = esc(payerName(inv) || "청구처 미지정");
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
      ${invoiceExpandBody(inv, { items, isAdmin, returnTo })}
    </details>`;
}

/**
 * 청구 목록 = 데스크톱 넓은 표(2026-07-16 사용자 요청 — bookipi 참고, 좁은 한 줄 행 대체).
 * 컬럼: [체크박스] 상태 · 청구번호 · 클라이언트 · 아티스트 · 프로젝트 · 금액 · 발행 · [처리].
 * 행(데이터 셀)을 누르면 상세 화면으로 이동(셀마다 <a> — tr을 a로 못 감싸므로). 체크박스·처리 열은 링크 아님.
 * 반응형: <640px면 CSS(.inv-table @media)가 각 행을 카드로 접는다(td[data-label]→::before 라벨). 좁은 화면은
 * 아티스트·프로젝트(lg)·발행(md)·번호(sm)를 점진 숨김(hidden … table-cell)해 카드가 5줄로 짧아진다.
 * isInvoicer(대표·치프)만 체크박스·처리 열·일괄 처리 대상. 스태프는 상태 배지만(읽기).
 */
function invoiceArtistLabel(inv) {
  const artists = String(inv.project_artist || "").split(",").map((s) => s.trim()).filter(Boolean);
  if (!artists.length) return "";
  return artists.length > 1 ? `${artists[0]} 외 ${artists.length - 1}` : artists[0];
}

function invoiceTable(rows, { isInvoicer = false, ret = "" } = {}) {
  const retBase = ret || "/invoices";
  const cellLink = (inv, inner, cls = "") => `<a href="/invoices/${inv.id}?return=${encodeURIComponent(retBase)}" class="inv-cell-link ${cls}">${inner}</a>`;
  const dash = '<span class="text-muted">—</span>';
  const head = `
    <thead>
      <tr>
        ${isInvoicer ? `<th class="inv-check"><input type="checkbox" data-inv-select-all aria-label="전체 선택" class="align-middle" /></th>` : ""}
        <th>상태</th>
        <th>청구번호</th>
        <th>클라이언트</th>
        <th class="hidden xl:table-cell">아티스트</th>
        <th class="hidden xl:table-cell">프로젝트</th>
        <th class="inv-amt-col">금액</th>
        <th>발행</th>
        ${isInvoicer ? `<th class="inv-act-col">처리</th>` : ""}
      </tr>
    </thead>`;
  const body = rows
    .map((inv) => {
      const payer = esc(invoicePayerLabel(inv));
      const artist = invoiceArtistLabel(inv);
      const project = String(inv.project_title || "").trim();
      const num = String(inv.invoice_number || "").trim();
      const issued = inv.issued_date ? esc(formatYmdShort(inv.issued_date)) : "";
      const check = isInvoicer
        ? `<td class="inv-check" data-label="선택"><input type="checkbox" data-inv-select value="${inv.id}" aria-label="선택" class="align-middle" /></td>`
        : "";
      const act = isInvoicer
        ? `<td class="inv-act-col" data-label="처리"><span class="inv-actions">${taxToggleButtons(inv, retBase, { iconOnly: true })}</span></td>`
        : "";
      return `
      <tr>
        ${check}
        <td class="inv-c-status" data-label="상태">${cellLink(inv, taxBadgeShort(inv))}</td>
        <td class="inv-c-num" data-label="청구번호">${cellLink(inv, num ? esc(num) : dash, "tabular text-muted")}</td>
        <td class="inv-c-client" data-label="클라이언트">${cellLink(inv, payer, "inv-cell-payer font-medium")}</td>
        <td class="inv-c-artist hidden xl:table-cell" data-label="아티스트">${cellLink(inv, artist ? esc(artist) : dash, "text-muted")}</td>
        <td class="inv-c-project hidden xl:table-cell" data-label="프로젝트">${cellLink(inv, project ? esc(project) : dash, "text-muted")}</td>
        <td class="inv-amt inv-c-amt" data-label="금액">${cellLink(inv, formatKRW(inv.amount), "tabular font-semibold")}</td>
        <td class="inv-c-issued" data-label="발행">${cellLink(inv, issued || dash, "tabular text-muted")}</td>
        ${act}
      </tr>`;
    })
    .join("");
  return `<table class="inv-table">${head}<tbody>${body}</tbody></table>`;
}

/**
 * 청구 목록 일괄 처리 바(2026-07-16) — 체크 시 상단에 뜸(선택 0이면 숨김, app.js sync가 style.display 제어).
 * 선택 행 id를 hidden ids에 모아 POST /invoices/bulk-tax-status로 계산서 발행/입금완료 일괄 처리(대표·치프).
 * 함정 #26: 숨김은 style.display(인라인)로 — .card가 없어도 flex 유틸을 확실히 이기게.
 */
function invoiceBulkBar(ret = "/invoices") {
  return `
    <form data-inv-bulk-form data-inv-bulk-bar method="post" action="/invoices/bulk-tax-status" style="display:none" class="inv-bulkbar card sticky top-2 z-20 mb-3 flex flex-wrap items-center justify-between gap-3 border-primary/40 bg-primary/5">
      <input type="hidden" name="ids" data-inv-bulk-ids />
      <input type="hidden" name="return" value="${esc(ret)}" />
      <span class="text-sm"><b class="tabular" data-inv-bulk-count>0</b>건 선택됨</span>
      <div class="flex flex-wrap items-center gap-2">
        <button type="submit" name="tax_status" value="계산서 발행" data-bulk-label="계산서 발행 완료" class="btn-ghost btn-sm border-success/40 text-success">계산서 발행 완료</button>
        <button type="submit" name="tax_status" value="입금완료" data-bulk-label="입금완료" class="btn-primary btn-sm">입금완료 처리</button>
        <button type="button" data-inv-bulk-clear class="btn-ghost btn-sm text-muted">선택 해제</button>
      </div>
    </form>`;
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
            items: i.items || [],
            isAdmin,
            returnTo: `/projects/${project.id}?tab=invoice&open=${i.id}`,
            openId,
          })
        )
        .join("")
    : emptyState("청구 내역이 없습니다.");
  // ('금액 직접 입력' 수동 청구 링크는 2026-07-08 폐지 — 청구는 이 탭의 청구 생성 체크리스트에서만.)
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
      </div>
      ${summary}
      ${list}
      ${unbilledForm ? `<div class="mt-4 border-t border-border pt-4">${unbilledForm}</div>` : ""}
    </div>`;
}

module.exports = { invoiceBadge, invoiceRow, invoiceTable, invoiceBulkBar, invoicesSection, payerInfoCard, payerName, taxToggleButtons }; // displayStatus는 내부 전용; payerName=청구처 표시명(본명 (활동명)) 헬퍼
