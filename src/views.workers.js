"use strict";
/**
 * 외주 작업자 전용 뷰(2026-07-20 마스터-디테일 전환) — 왼쪽 이름 목록 + 오른쪽 정산 카드·상세.
 *
 * 배경: 목록이 카드 한 장에 **이름·전화만** 담아 700px를 다 쓰고 오른쪽이 비어 있었다(사용자 리포트).
 * 폭을 넓히는 건 답이 아니었다 — 외주는 4명 남짓이라 넓힐수록 빈 공간이 늘어난다. 채울 것은 **행의 내용**이고,
 * 사용자 결정으로 연락처·업체·매출과 같은 **마스터-디테일**(왼쪽 목록 유지 + 오른쪽 정산 카드)로 간다.
 *
 * 골격(contactPanes)·키보드 이동(data-nav-list)은 그 화면들과 공유한다.
 */
const { esc, formatKRW, listGroup, emptyState } = require("./views");
const { withholding33 } = require("./lib/tax");

/** "2026-06" → "2026.6"(최근 지급월 표기 — 매출 lastSeenLabel과 같은 톤). */
function monthDot(ym) {
  if (!ym) return "";
  const [y, m] = String(ym).split("-");
  return `${y}.${Number(m)}`;
}

/**
 * 왼쪽 이름 목록(마스터). 연락처의 `contactNameList`를 쓰지 않는 이유: 그쪽은 초성 헤더+인덱스 레일이 붙는데
 * 외주는 몇 명 수준이라 헤더가 목록보다 커진다. 대신 **한 줄에 정산 상태**를 담는다(미지급이 목록의 존재 이유).
 * @param {{rows:{worker:object,summary:object}[], selectedId?:number, hrefFn:(w:object)=>string}} o
 */
function workerNameList({ rows, selectedId = null, hrefFn }) {
  const items = rows.map(({ worker: w, summary: s }) => {
    const active = Number(selectedId) === Number(w.id);
    const cls = active ? "bg-primary/10" : "";
    // 오른쪽 = 미지급(정산 화면의 주인공). 없으면 조용히 비운다 — '0원'을 쓰면 눈이 매번 걸린다.
    const right = s.unpaidCount
      ? `<div class="shrink-0 text-right">
           <div class="tabular text-sm font-semibold text-danger">${formatKRW(s.unpaidAmt)}</div>
           <div class="text-xs text-muted">미지급 ${s.unpaidCount}건</div>
         </div>`
      : "";
    // 계좌 미등록은 지급을 막는 조건이라 목록에서 바로 보이게(번호는 노출하지 않는다 — 사용자 결정).
    const warn = s.hasAccount ? "" : ` <span class="badge badge-warning">계좌 미등록</span>`;
    return `<a href="${esc(hrefFn(w))}" class="row-link flex items-center justify-between gap-3 px-3 py-2 ${cls}"${active ? ' aria-current="true"' : ""}>
        <span class="min-w-0">
          <span class="block truncate text-sm font-medium">${esc(w.name)}${w.active ? "" : ` <span class="badge badge-neutral">비활성</span>`}</span>
          <span class="block truncate text-xs text-muted">${esc(w.phone || w.email || "연락처 없음")}${warn}</span>
        </span>
        ${right}
      </a>`;
  });
  return `<div data-nav-list="workers" class="lg:min-h-0 lg:flex-1 lg:overflow-y-auto">${listGroup({ rows: items })}</div>`;
}

/**
 * 오른쪽 상단 **정산 카드** — "이 사람에게 지금 얼마를, 보낼 수 있는가"에 한 화면으로 답한다.
 * 미지급(금액·건수·실지급) → 일괄 지급 → 이체 준비 상태(계좌·서류) → 누적/최근 지급/참여 건수 순.
 * 카드의 [전부 지급 처리]는 **오늘 날짜**로 처리한다(빠른 경로). 지급일을 소급하려면 정산 탭의 폼을 쓴다 —
 * 그래서 둘이 공존한다(카드=한 번에, 탭=날짜 지정).
 * @param {{worker:object, summary:object, canPay:boolean}} o
 */
function workerPayoutCard({ worker, summary: s, canPay = false }) {
  const wh = withholding33(s.unpaidAmt);
  const payBtn = canPay && s.unpaidCount
    ? `<form method="post" action="/workers/${worker.id}/payout-all" class="shrink-0"
             data-confirm="미지급 ${s.unpaidCount}건 · ${esc(formatKRW(s.unpaidAmt))}을 전부 지급 처리할까요? (원천세 3.3% ${esc(formatKRW(wh.total))} 제외 시 실지급 ${esc(formatKRW(wh.net))})">
         <input type="hidden" name="return" value="detail" />
         <button class="btn-primary btn-sm" type="submit">전부 지급 처리</button>
       </form>`
    : "";
  // 미지급 헤드라인 — 없으면 '없음'으로 명시(빈칸이면 '못 불러온 건가' 싶다).
  const head = s.unpaidCount
    ? `<div>
         <div class="text-xs text-muted">미지급</div>
         <div class="tabular text-2xl font-bold text-danger">${formatKRW(s.unpaidAmt)}</div>
         <div class="mt-0.5 text-xs text-muted">${s.unpaidCount}건 · 원천세 3.3% −${formatKRW(wh.total)} → 실지급 <b class="text-fg">${formatKRW(wh.net)}</b></div>
       </div>`
    : `<div>
         <div class="text-xs text-muted">미지급</div>
         <div class="text-lg font-semibold text-muted">없음</div>
       </div>`;
  // 이체 준비 = 계좌·서류 등록 여부만(번호는 상세 편집 폼에서만 복호화 표시).
  const ready = (ok, label) => `<span class="badge ${ok ? "badge-success" : "badge-warning"}">${ok ? "✓" : "⚠"} ${esc(label)}</span>`;
  const stat = (label, value) => `<div><div class="text-xs text-muted">${esc(label)}</div><div class="tabular text-sm">${value}</div></div>`;
  return `<div class="card">
      <div class="flex items-start justify-between gap-3">${head}${payBtn}</div>
      <div class="mt-3 flex flex-wrap items-center gap-1 border-t border-border pt-3">
        ${ready(s.hasAccount, "계좌")}${ready(s.hasFiles, "서류")}
        ${s.hasAccount ? "" : `<span class="text-xs text-muted">계좌를 등록해야 이체할 수 있습니다.</span>`}
      </div>
      <div class="mt-3 grid grid-cols-2 gap-3 border-t border-border pt-3 sm:grid-cols-3">
        ${stat("누적 지급", formatKRW(s.paidTotal))}
        ${stat("최근 지급", s.lastPaidMonth ? esc(monthDot(s.lastPaidMonth)) : '<span class="text-muted">—</span>')}
        ${stat("정산 대상", `작업 ${s.taskCnt} · 세션 ${s.sessionCnt}`)}
      </div>
    </div>`;
}

/** 목록만 있을 때(미선택) 오른쪽 빈 패널 안내. */
function workerEmptyPane() {
  return emptyState("작업자를 선택하면 정산 현황이 여기 표시됩니다.", { card: true });
}

module.exports = { workerNameList, workerPayoutCard, workerEmptyPane, monthDot };
