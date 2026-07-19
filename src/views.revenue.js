"use strict";
// 매출 전용 뷰(2026-07-19) — 기간 컨트롤·탭·KPI·SVG 바 차트·순위 표·드릴다운.
const { esc, formatKRW, tabBar, emptyState, listGroup, listRow } = require("./views");

const MONTHS = Array.from({ length: 12 }, (_, k) => k + 1);
// 기간 쿼리 문자열(링크·폼 유지). month은 숫자 또는 'all'.
function periodQS({ year, month }) { return `year=${Number(year)}&month=${month === "all" ? "all" : Number(month)}`; }
// 순이익 색: 음수(외주지급>매출)면 danger, 아니면 success.
function profitCls(v) { return Number(v) < 0 ? "text-danger" : "text-success"; }

// 년·월 셀렉트(GET 폼). **개요 탭 전용** — 목록 탭은 기간 없이 전체 누적이라 이 컨트롤을 쓰지 않는다.
// 셀렉트를 바꾸면 바로 조회된다(app.js가 [data-auto-submit] 폼의 select change에서 제출).
// '보기' 버튼은 <noscript>로만 남겨 JS가 없을 때만 보인다.
function revPeriodControl({ year, month, years, tab }) {
  const yrs = years && years.length ? years : [Number(year)];
  const yOpts = yrs.map((y) => `<option value="${y}"${y === Number(year) ? " selected" : ""}>${y}년</option>`).join("");
  const mOpts = `<option value="all"${month === "all" ? " selected" : ""}>전체(연간)</option>` +
    MONTHS.map((m) => `<option value="${m}"${String(month) === String(m) ? " selected" : ""}>${m}월</option>`).join("");
  return `<form method="get" class="mb-4 flex flex-wrap items-center gap-2" data-auto-submit>
    <input type="hidden" name="tab" value="${esc(tab)}" />
    <select name="year" class="input w-auto">${yOpts}</select>
    <select name="month" class="input w-auto">${mOpts}</select>
    <noscript><button type="submit" class="btn-ghost btn-sm">보기</button></noscript>
  </form>`;
}

// 탭바(개요/스탭별/업체·개인별). 기간은 개요 링크에만 — 목록 탭은 전체 누적이라 기간 개념이 없다.
function revTabs({ tab, year, month }) {
  const qs = periodQS({ year, month });
  return tabBar({
    tabs: [{ key: "overview", label: "개요" }, { key: "staff", label: "스탭별" }, { key: "payer", label: "업체·개인별" }],
    activeKey: tab,
    hrefFn: (k) => (k === "overview" ? `/revenue?tab=overview&${qs}` : `/revenue?tab=${k}`),
  });
}

// 월별 매출·순이익 2막대 인라인 SVG(색=CSS 클래스 fill). monthly[k]={month,supply,profit}.
function revBarChart(monthly) {
  const max = Math.max(1, ...monthly.map((m) => m.supply));
  const W = 680, H = 168, base = H - 30, top = 14, n = monthly.length, slot = (W - 8) / n, bw = slot * 0.28;
  const bar = (x, v, cls) => { const h = Math.max(0, Math.round((v / max) * (base - top))); return `<rect x="${x.toFixed(1)}" y="${base - h}" width="${bw.toFixed(1)}" height="${h}" rx="2" class="${cls}"><title>${cls === "rev-bar" ? "매출" : "순이익"} ${formatKRW(v)}</title></rect>`; };
  const parts = monthly.map((m, k) => {
    const cx = 4 + k * slot + slot / 2;
    return bar(cx - bw - 1, m.supply, "rev-bar") + bar(cx + 1, m.profit, "rev-bar-profit")
      + `<text x="${cx.toFixed(1)}" y="${H - 14}" text-anchor="middle" class="rev-bar-label">${m.month}</text>`;
  }).join("");
  // 범례
  const legend = `<rect x="8" y="${H - 9}" width="9" height="9" class="rev-bar"/><text x="21" y="${H - 1}" class="rev-bar-label">매출</text>`
    + `<rect x="60" y="${H - 9}" width="9" height="9" class="rev-bar-profit"/><text x="73" y="${H - 1}" class="rev-bar-label">순이익</text>`;
  return `<svg viewBox="0 0 ${W} ${H}" class="w-full" role="img" aria-label="월별 매출·순이익 추세">${parts}${legend}</svg>`;
}

// 비교 증감 배지. prev>0이면 ((cur-prev)/prev*100) 반올림 + ▲/▼ + 색, 아니면 —.
function revDeltaBadge(cur, prev) {
  if (!prev || prev <= 0) return `<span class="text-xs text-muted">—</span>`;
  const pct = Math.round(((cur - prev) / prev) * 100);
  const up = pct >= 0;
  return `<span class="text-xs ${up ? "text-success" : "text-danger"}">${up ? "▲" : "▼"}${Math.abs(pct)}%</span>`;
}

// 종류별 매출 구성 가로 막대(비중 = amount/total). 막대=인라인 SVG(width=pct, viewBox 100 단위).
function revTypeBreakdown(rows) {
  if (!rows.length) return `<div class="card text-sm text-muted">이 기간 매출 구성이 없습니다.</div>`;
  const total = rows.reduce((s, r) => s + r.amount, 0) || 1;
  const items = rows.map((r) => {
    const pct = Math.round((r.amount / total) * 100);
    return `<div class="flex items-center gap-2 py-1">
      <span class="w-20 shrink-0 truncate text-sm">${esc(r.label)}</span>
      <svg viewBox="0 0 100 8" preserveAspectRatio="none" class="h-2 flex-1"><rect x="0" y="0" width="${pct}" height="8" rx="1" class="rev-bar"/></svg>
      <span class="w-10 shrink-0 text-right text-xs text-muted">${pct}%</span>
      <span class="w-24 shrink-0 text-right text-sm tabular">${formatKRW(r.amount)}</span>
    </div>`;
  }).join("");
  return `<div class="card">${items}</div>`;
}

// 세무 참고 카드: VAT 합계 + 외주 원천징수(실지급 병기).
function revTaxCard(tax) {
  const w = tax.withholding;
  return `<div class="card text-sm">
    <div class="mb-1 font-semibold">세무 참고</div>
    <div class="flex justify-between py-0.5"><span class="text-muted">VAT 합계</span><span class="tabular">${formatKRW(tax.vatTotal)}</span></div>
    <div class="flex justify-between py-0.5"><span class="text-muted">외주 지급</span><span class="tabular">${formatKRW(tax.payoutTotal)}</span></div>
    <div class="flex justify-between py-0.5"><span class="text-muted">원천징수(3.3%)</span><span class="tabular text-danger">−${formatKRW(w.total)}</span></div>
    <div class="flex justify-between py-0.5"><span class="text-muted">실지급</span><span class="tabular">${formatKRW(w.net)}</span></div>
    <div class="mt-1 text-xs text-muted">참고용 — 소액부징수·사업자 외주 예외 미반영.</div>
  </div>`;
}

// 개요 탭 — 대시보드 그리드: KPI 한 줄(선택 기간 2장=델타 배지·누적 2장=배지 없음) → [차트|세무] → [종류 구성|Top들].
function revOverview({ summary, topStaff, topPayer, byType, tax, year, month }) {
  const periodLabel = month === "all" ? `${year}년 전체` : `${year}년 ${Number(month)}월`;
  const c = summary.cmp;
  const deltas = (curKey, prevKey) => c.isYear
    ? `<div class="mt-0.5">전년 ${revDeltaBadge(summary[curKey], c["prevPeriod" + prevKey])}</div>`
    : `<div class="mt-0.5 flex gap-2"><span>전월 ${revDeltaBadge(summary[curKey], c["prevPeriod" + prevKey])}</span><span>전년 ${revDeltaBadge(summary[curKey], c["prevYear" + prevKey])}</span></div>`;
  const kpi = (label, value, tone, delta) => `<div class="card"><div class="text-sm text-muted">${label}</div><div class="tabular text-xl font-bold ${tone}">${formatKRW(value)}</div>${delta || ""}</div>`;
  const kpis = `<div class="mb-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
    ${kpi(`${esc(periodLabel)} 매출`, summary.periodSupply, "text-fg", deltas("periodSupply", "Supply"))}
    ${kpi(`${esc(periodLabel)} 순이익`, summary.periodProfit, profitCls(summary.periodProfit), deltas("periodProfit", "Profit"))}
    ${kpi("올해 누적 매출", summary.ytdSupply, "text-fg", "")}
    ${kpi("올해 누적 순이익", summary.ytdProfit, profitCls(summary.ytdProfit), "")}
  </div>`;
  const chart = `<div class="card"><div class="mb-1 text-sm font-semibold">${esc(year)}년 월별 매출·순이익</div>${revBarChart(summary.monthly)}</div>`;
  const typeSec = `<div><h2 class="mb-2 text-sm font-semibold text-muted">종류별 매출 구성</h2>${revTypeBreakdown(byType)}</div>`;
  // 상위 5개는 바로, 나머지는 <details> 펼침(무JS·CSP 안전). 기간 렌즈가 개요에 있으므로
  // "이 기간 누가 기여했나"를 여기서 전부 답한다 — 목록 탭은 누적 전용이라 '전체 보기' 링크는 없앴다
  // (7월을 보다 눌렀는데 전체 누적이 열리면 링크가 거짓말이 된다).
  const row = (r, hrefFn) => `<a href="${hrefFn(r)}" class="row-link flex items-center justify-between gap-2 px-3 py-2"><span class="truncate font-medium">${esc(r.name)}</span><span class="tabular font-semibold">${formatKRW(r.supply)}</span></a>`;
  // unit: 펼침 라벨의 개수 단위 — 스탭(사람)은 '명', 업체·개인은 '곳'(단위가 섞이면 어색하다, 2026-07-19).
  const mini = (rows, hrefFn, unit) => {
    if (!rows.length) return `<div class="text-sm text-muted">내역이 없습니다.</div>`;
    const head = rows.slice(0, 5).map((r) => row(r, hrefFn)).join("");
    const rest = rows.slice(5);
    if (!rest.length) return head;
    return `${head}<details class="border-t border-border/60">
        <summary class="cursor-pointer px-3 py-2 text-xs text-primary hover:underline">전체 ${rows.length}${unit} 보기</summary>
        <div class="divide-y divide-border border-t border-border/60">${rest.map((r) => row(r, hrefFn)).join("")}</div>
      </details>`;
  };
  const tops = `<div class="grid gap-4 sm:grid-cols-2">
    <div><h2 class="mb-2 text-sm font-semibold text-muted">스탭별 매출</h2><div class="card p-0 overflow-hidden divide-y divide-border">${mini(topStaff, (r) => `/revenue?tab=staff&staff=${r.id}`, "명")}</div></div>
    <div><h2 class="mb-2 text-sm font-semibold text-muted">업체·개인별 매출</h2><div class="card p-0 overflow-hidden divide-y divide-border">${mini(topPayer, (r) => `/revenue?tab=payer&payer=${r.id}`, "곳")}</div></div>
  </div>`;
  const note = `<p class="mt-4 text-xs text-muted">매출 = 공급가(VAT 제외)·발행일 기준. 순이익 = 매출 − 외주 지급. 스탭별 매출 합은 청구서 할인 시 총 매출과 다를 수 있음(라인 기준).</p>`;
  return `${kpis}
    <div class="mb-4 grid gap-4 lg:grid-cols-[2fr_1fr]">${chart}${revTaxCard(tax)}</div>
    <div class="grid gap-4 lg:grid-cols-2">${typeSec}${tops}</div>
    ${note}`;
}

// ── 마스터-디테일 왼쪽 순위 목록(2026-07-19) ──
// 선택은 URL 쿼리로만 표현하므로 JS 없음(이동 자체는 링크). 선택 행 강조는 연락처와 같은 규약(aria-current + tint).
// tint는 클래스로 직접 주고, [data-nav-list] a[aria-current] CSS(포커스 링 제거·hover 시 tint 유지)도 함께 걸린다
// — 2026-07-19 마커를 붙이며 그 셀렉터를 aria-current 값 무관으로 넓혔다(연락처 "true" / 매출 "page" 둘 다 매칭).
// 2단 배치(2026-07-19 사용자 요청 '건수는 금액 밑으로·라벨은 이름 밑으로'): 왼쪽=이름/부가(배지·건수), 오른쪽=금액/부가.
// 이름 옆 인라인 배지·이름 아래 전폭 한 줄이던 이전 구조는 배지가 이름 폭을 먹고 숫자가 좌우로 흩어져 스캔이 어려웠다.
function revListRow({ href, selected, title, subLeft = "", right, subRight = "" }) {
  const cur = selected ? ` aria-current="page"` : "";
  const tint = selected ? " bg-primary/10 font-semibold" : "";
  return `<a href="${esc(href)}"${cur} class="block px-4 py-3 transition-colors hover:bg-surface active:bg-elevated focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40${tint}">
      <div class="flex items-start justify-between gap-3">
        <div class="min-w-0">
          <div class="truncate">${title}</div>
          ${subLeft ? `<div class="mt-0.5 truncate text-xs text-muted">${subLeft}</div>` : ""}
        </div>
        <div class="shrink-0 text-right">
          <div class="tabular text-sm font-semibold">${right}</div>
          ${subRight ? `<div class="mt-0.5 whitespace-nowrap text-xs text-muted">${subRight}</div>` : ""}
        </div>
      </div>
    </a>`;
}

// "2026-07-16" → "2026.7"(목록의 최근 거래월 표기). 값 없으면 빈 문자열.
function lastSeenLabel(ymd) {
  if (!ymd) return "";
  const s = String(ymd);
  return `최근 ${s.slice(0, 4)}.${Number(s.slice(5, 7))}`;
}

// 스탭 순위 목록(왼쪽 마스터) — 기간 없는 전체 누적(2026-07-19 렌즈 분리: 목록=전체, 드릴다운=기간).
// listGroup의 .card는 overflow-hidden이라 contactPanes의 고정 높이 패널 안에서 넘친 행이 잘리고
// 스크롤바도 없다(2026-07-19 최종 리뷰 지적 — 연락처 contactNameList와 동일하게 lg:overflow-y-auto 래퍼로 감싼다).
// data-nav-list = 키보드 이동 마커(로드 시 선택 행 포커스+scrollIntoView, ↑↓로 앞뒤 이동).
// 2026-07-19 사용자 요청('업체 선택하면 목록이 맨 위로 간다·화살표로 다니고 싶다')으로 매출에도 부착 —
// 마커 이름이 옛 data-contact-list에서 일반화된 이유가 이것이다(연락처·업체그룹·매출 3화면 공용).
// 선택 행 포커스가 스크롤 위치 문제도 함께 푼다: 서버 렌더라 선택=페이지 재로드인데, 포커스가
// 그 행을 scrollIntoView해 목록이 보던 위치를 유지한다(마커가 없으면 스크롤이 0으로 돌아간다).
function revStaffList(rows, { selId = 0 } = {}) {
  if (!rows.length) return emptyState("매출 기여가 있는 스탭이 없습니다.", { card: true });
  const list = listGroup({ rows: rows.map((r) => {
    const last = lastSeenLabel(r.last_issued);
    return revListRow({
      href: `/revenue?tab=staff&staff=${Number(r.id)}`,
      selected: Number(r.id) === Number(selId),
      title: esc(r.name),
      // 외주 배지는 이름 아래로(청구처 탭의 업체/개인 배지와 같은 규칙). 건수·최근 거래월도 배지 줄에 함께 둔다.
      subLeft: `${r.is_external ? `<span class="badge badge-neutral">외주</span> ` : ""}작업 ${r.task_cnt} · 세션 ${r.session_cnt}${last ? ` · ${esc(last)}` : ""}`,
      right: formatKRW(r.supply),
      subRight: `순이익 <span class="${profitCls(r.profit)}">${formatKRW(r.profit)}</span>`,
    });
  }) });
  return `<div data-nav-list class="lg:min-h-0 lg:flex-1 lg:overflow-y-auto">${list}</div>`;
}

// 업체·개인 순위 목록(왼쪽 마스터) — 기간 없는 전체 누적. 스크롤 래퍼는 revStaffList와 동일 이유.
function revPayerList(rows, { selId = 0 } = {}) {
  if (!rows.length) return emptyState("매출 기여가 있는 업체·개인이 없습니다.", { card: true });
  const kindLabel = (k) => (k === "person" ? "개인" : k === "group" ? "그룹" : "업체");
  const list = listGroup({ rows: rows.map((r) => {
    const last = lastSeenLabel(r.last_issued);
    return revListRow({
      href: `/revenue?tab=payer&payer=${Number(r.id)}`,
      selected: Number(r.id) === Number(selId),
      title: esc(r.name),
      subLeft: `<span class="badge badge-neutral">${kindLabel(r.kind)}</span>${last ? ` · ${esc(last)}` : ""}`,
      right: formatKRW(r.supply),
      subRight: `청구 ${r.invoice_cnt}건`,
    });
  }) });
  return `<div data-nav-list class="lg:min-h-0 lg:flex-1 lg:overflow-y-auto">${list}</div>`;
}

// "2026-07" → "2026년 7월". ym이 비면(발행일 없는 항목 — 현재 ISSUED 가드로 도달 불가하나 방어) 안전 문구.
function monthLabel(ym) {
  if (!ym) return "발행일 미상";
  const [y, m] = String(ym).split("-");
  return `${y}년 ${Number(m)}월`;
}

// 발행일 내림차순 배열을 월별로 묶는다(입력 순서 유지 = 최신 월 먼저).
// 각 항목은 {ym, amount, payout} 를 가져야 한다. 월 소계를 함께 계산한다.
function groupByMonth(items) {
  const out = [];
  let cur = null;
  items.forEach((it) => {
    if (!cur || cur.ym !== it.ym) {
      cur = { ym: it.ym, items: [], supply: 0, payout: 0 };
      out.push(cur);
    }
    cur.items.push(it);
    cur.supply += it.amount || 0;
    cur.payout += it.payout || 0;
  });
  return out;
}

// 월 그룹 헤더(월 이름 + 소계). profit=true면 순이익 소계도 함께.
function monthHeader(g, { profit = false } = {}) {
  const p = g.supply - g.payout;
  return `<div class="mt-4 flex items-baseline justify-between border-b border-border/60 pb-1">
      <h3 class="text-sm font-semibold">${esc(monthLabel(g.ym))}</h3>
      <div class="tabular text-sm">
        <span class="font-semibold">${formatKRW(g.supply)}</span>
        ${profit ? `<span class="ml-2 text-xs text-muted">순이익 <span class="${profitCls(p)}">${formatKRW(p)}</span></span>` : ""}
      </div>
    </div>`;
}

// "2026-01-31" → "1월 31일"(세션 실제 날짜 — 발행월과 다른 달일 수 있어 월까지 쓴다).
function sessionDayLabel(ymd) {
  const s = String(ymd || "");
  if (s.length < 10) return ""; // 형식이 다르면 'NaN월 NaN일' 대신 생략(issuedDayLabel과 같은 방어)
  return `${Number(s.slice(5, 7))}월 ${Number(s.slice(8, 10))}일`;
}

// "2026-03-08" → "8일"(월 헤더에 년·월이 이미 있으므로 일만 — 칸을 좁혀 이름에 폭을 준다).
function issuedDayLabel(ymd) {
  const s = String(ymd || "");
  return s.length >= 10 ? `${Number(s.slice(8, 10))}일` : "";
}

/**
 * 상세 항목 행(스탭·청구처 공용) — `발행일 | 가운데 | 이름 · 세부 ↗ | 금액` 4칸 정렬
 * (2026-07-19 사용자 요청 '항목별로 나눠'. 청구처 탭에도 2026-07-20 동일 적용).
 * 가운데 칸은 행마다 가장 갈리는 값: 스탭=일의 종류(믹싱·공연·녹음), 청구처=상태(발행·입금).
 * 폭은 `.rev-item` CSS 그리드가 잡는다(서버 렌더 인라인 style은 CSP에 막혀 조용히 무시된다 — 함정 #27).
 * 월 그룹이 여럿이라 표 헤더는 두지 않는다(그룹마다 반복되면 시끄럽고, 내용만으로 각 칸이 무엇인지 읽힌다).
 * @param {{href:string, date:string, mid:string, name:string, detail?:string, amount:number}} it
 *   `mid`는 **이미 빌드된 HTML**(배지 등) — 호출부가 esc 책임을 진다(listRow의 left/right와 같은 관례).
 */
function revItemRow(it) {
  return `<a href="${esc(it.href)}" target="_blank" rel="noopener" class="rev-item row-link px-4 py-3">
      <span class="rev-item-day tabular text-xs text-muted">${esc(issuedDayLabel(it.date))}</span>
      <span class="rev-item-kind truncate text-sm">${it.mid}</span>
      <span class="rev-item-name min-w-0 truncate text-sm" title="${esc(it.detail ? `${it.name} · ${it.detail}` : it.name)}">
        <span class="font-medium">${esc(it.name)}</span>${it.detail ? ` <span class="text-muted">· ${esc(it.detail)}</span>` : ""} ↗
      </span>
      <span class="rev-item-amt tabular text-sm font-semibold">${formatKRW(it.amount)}</span>
    </a>`;
}

/**
 * 청구처 상세 행의 '세부' — 스탭 상세와 같은 자리(여럿 중 어느 것).
 * 라인 1개: 곡 제목(프로젝트명과 같으면 생략) 또는 세션 날짜. 여러 개: 'N개 항목'.
 */
function payerItemDetail(inv) {
  if (Number(inv.item_count) > 1) return `${inv.item_count}개 항목`;
  const d = inv.work_detail || "";
  if (!d) return "";
  // 세션이면 'YYYY-MM-DD' → '7월 15일', 작업이면 곡 제목(프로젝트명과 같으면 중복이라 생략).
  if (/^\d{4}-\d{2}-\d{2}$/.test(d)) return sessionDayLabel(d);
  return d === inv.project_title ? "" : d;
}

// 스탭 상세 — 월별 그룹(최신 월 우선). 월 안에서 작업·세션을 **섞어** 날짜순으로 둔다
// (2026-07-19 사용자 확정: 월별 리듬이 목적인데 종류로 먼저 가르면 리듬이 두 번 쪼개진다).
function revStaffDetail(data) {
  const { taskTypeLabel } = require("./data");
  const { tasks, sessions, supply, payout, profit } = data;
  // 종류(kind) = 실제 일의 종류. '작업'/'세션' 배지는 안 붙인다(2026-07-19 사용자 확정) —
  // 작업은 믹싱·보컬튠·스템제작, 세션은 녹음·공연·촬영이라 종류만으로 구분되고 배지는 자리만 먹는다.
  // detail = "여럿 중 어느 것"을 답하는 자리: 후반작업은 곡 제목, 세션은 실제 세션 날짜.
  //   세션 날짜가 여기 오는 이유 — 주 날짜는 **발행일**(매출 기준·월 그룹과 일치)인데, 앵콜 공연 이틀치가
  //   한 청구서에 묶이면 발행일만으론 두 행이 완전히 같아져 몇 건인지도 구분이 안 된다(실데이터 확인).
  const items = [
    ...tasks.map((t) => ({
      ym: String(t.issued_date || "").slice(0, 7), date: String(t.issued_date || ""),
      kind: taskTypeLabel(t.task_type), project: t.project_title,
      // 곡 제목이 프로젝트명과 같으면 같은 말 두 번(예: 'Inferno / Inferno') — 생략.
      detail: t.track_title && t.track_title !== t.project_title ? t.track_title : "",
      href: `/projects/${t.project_id}?tab=tracks`, amount: t.amount || 0, payout: t.worker_rate || 0,
    })),
    ...sessions.map((s) => ({
      ym: String(s.issued_date || "").slice(0, 7), date: String(s.issued_date || ""),
      kind: s.session_type, project: s.project_title, detail: sessionDayLabel(s.session_date),
      href: `/projects/${s.project_id}?tab=sessions`, amount: s.amount || 0, payout: s.payout || 0,
    })),
  ].sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));
  // 항목이 발행일 내림차순이라 첫 항목이 최근 거래(2026-07-19 스펙 §2 — 상단 총계에 최근 거래월 포함).
  const last = items.length ? lastSeenLabel(items[0].date) : "";
  const summary = `<div class="card flex flex-wrap gap-4 text-sm">
    <span>총 매출 <b class="tabular text-fg">${formatKRW(supply)}</b></span>
    <span>외주 지급 <b class="tabular text-fg">${formatKRW(payout)}</b></span>
    <span class="font-semibold">순이익 <b class="tabular ${profitCls(profit)}">${formatKRW(profit)}</b></span>
    ${last ? `<span class="text-muted">${esc(last)}</span>` : ""}
  </div>`;
  if (!items.length) return `${summary}${emptyState("내역이 없습니다.", { card: true })}`;
  const groups = groupByMonth(items).map((g) => `${monthHeader(g, { profit: true })}
    ${listGroup({ rows: g.items.map((it) => revItemRow({
      href: it.href, date: it.date, name: it.project, detail: it.detail, amount: it.amount,
      // 긴 커스텀 작업 종류는 칸에서 …로 잘리므로 title로 읽히게 한다.
      mid: `<span title="${esc(it.kind)}">${esc(it.kind)}</span>`,
    })) })}`).join("");
  return `${summary}${groups}`;
}

// 청구처 상세 — 월별 그룹(최신 월 우선). 월 소계는 매출(공급가)만(청구처엔 외주지급 개념이 없다).
function revPayerDetail(data) {
  const { invoices, supply, invoice_cnt } = data;
  // 방어적 정렬(발행일 내림차순) — revStaffDetail과 동일 수준: 데이터 레이어 SQL 정렬(ORDER BY issued_date DESC)이
  // 진실원천이지만, 그게 바뀌어도 같은 달이 여러 그룹으로 쪼개지는 조용한 회귀가 나지 않게 뷰에서도 보장한다.
  const sorted = [...invoices].sort((a, b) => (a.issued_date < b.issued_date ? 1 : a.issued_date > b.issued_date ? -1 : 0));
  // 정렬된 배열의 첫 항목이 최근 거래(2026-07-19 스펙 §2 — 상단 총계에 최근 거래월 포함).
  const last = sorted.length ? lastSeenLabel(sorted[0].issued_date) : "";
  const summary = `<div class="card flex flex-wrap gap-4 text-sm"><span>총 매출 기여 <b class="tabular text-fg">${formatKRW(supply)}</b></span><span>청구 ${invoice_cnt}건</span>${last ? `<span class="text-muted">${esc(last)}</span>` : ""}</div>`;
  if (!invoices.length) return `${summary}${emptyState("발행 청구서가 없습니다.", { card: true })}`;
  const items = sorted.map((inv) => ({ ym: String(inv.issued_date || "").slice(0, 7), amount: inv.supply || 0, payout: 0, inv }));
  // 스탭 상세와 **같은 칸·같은 내용**(2026-07-20 사용자 요청 '일관성이 떨어진다'):
  // 가운데 = 일의 종류(믹싱·녹음·공연), 세부 = 곡 제목 또는 세션 날짜.
  // 행 단위는 청구서 그대로 — 할인이 청구서 단위라 라인 합 ≠ 매출이기 때문(revenueForPayer 주석 참조).
  // 그래서 **금액은 청구서 매출(할인 반영)** 이고 종류·세부만 그 청구서의 첫 라인에서 온다.
  // 라인이 여러 개면 세부를 'N개 항목'으로 접는다(실측 18건 중 1건뿐이라 드문 경우).
  const groups = groupByMonth(items).map((g) => `${monthHeader(g)}
    ${listGroup({ rows: g.items.map(({ inv }) => revItemRow({
      href: `/invoices/${inv.id}`,
      date: inv.issued_date,
      mid: `<span title="${esc(inv.work_kind || "")}">${esc(inv.work_kind || "")}</span>`,
      name: inv.project_title || `청구 #${inv.id}`,
      detail: payerItemDetail(inv),
      amount: inv.supply,
    })) })}`).join("");
  return `${summary}${groups}`;
}

module.exports = { revPeriodControl, revTabs, revBarChart, revDeltaBadge, revTypeBreakdown, revTaxCard, revOverview, revStaffList, revPayerList, revStaffDetail, revPayerDetail, groupByMonth };
