"use strict";
// 매출 전용 뷰(2026-07-19) — 기간 컨트롤·탭·KPI·SVG 바 차트·순위 표·드릴다운.
const { esc, formatKRW, tabBar, dataTable, emptyState, listGroup, listRow } = require("./views");

const MONTHS = Array.from({ length: 12 }, (_, k) => k + 1);
// 기간 쿼리 문자열(링크·폼 유지). month은 숫자 또는 'all'.
function periodQS({ year, month }) { return `year=${Number(year)}&month=${month === "all" ? "all" : Number(month)}`; }
// 순이익 색: 음수(외주지급>매출)면 danger, 아니면 success.
function profitCls(v) { return Number(v) < 0 ? "text-danger" : "text-success"; }

// 년·월 셀렉트 + 보기 버튼(무JS GET 폼). 탭·기간·선택 대상 유지.
function revPeriodControl({ year, month, years, tab, sel = null }) {
  const yrs = years && years.length ? years : [Number(year)];
  const yOpts = yrs.map((y) => `<option value="${y}"${y === Number(year) ? " selected" : ""}>${y}년</option>`).join("");
  const mOpts = `<option value="all"${month === "all" ? " selected" : ""}>전체(연간)</option>` +
    MONTHS.map((m) => `<option value="${m}"${String(month) === String(m) ? " selected" : ""}>${m}월</option>`).join("");
  // 선택된 스탭/청구처를 실어 보낸다 — 기간만 바꾸고 보던 대상은 유지(2026-07-19 사용자 결정).
  const selHidden = sel && sel.id ? `<input type="hidden" name="${esc(sel.name)}" value="${Number(sel.id)}" />` : "";
  return `<form method="get" class="mb-4 flex flex-wrap items-center gap-2">
    <input type="hidden" name="tab" value="${esc(tab)}" />
    ${selHidden}
    <select name="year" class="input w-auto">${yOpts}</select>
    <select name="month" class="input w-auto">${mOpts}</select>
    <button type="submit" class="btn-ghost btn-sm">보기</button>
  </form>`;
}

// 탭바(개요/스탭별/업체·개인별) — 기간 유지.
function revTabs({ tab, year, month }) {
  const qs = periodQS({ year, month });
  return tabBar({
    tabs: [{ key: "overview", label: "개요" }, { key: "staff", label: "스탭별" }, { key: "payer", label: "업체·개인별" }],
    activeKey: tab,
    hrefFn: (k) => `/revenue?tab=${k}&${qs}`,
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
  const qs = periodQS({ year, month });
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
  const mini = (rows, hrefFn, moreHref, moreLabel) => rows.length
    ? `${rows.map((r) => `<a href="${hrefFn(r)}" class="row-link flex items-center justify-between gap-2 px-3 py-2"><span class="truncate font-medium">${esc(r.name)}</span><span class="tabular font-semibold">${formatKRW(r.supply)}</span></a>`).join("")}<div class="px-3 pb-2 pt-1 text-right"><a href="${moreHref}" class="text-xs text-primary hover:underline">${moreLabel} →</a></div>`
    : `<div class="text-sm text-muted">내역이 없습니다.</div>`;
  const tops = `<div class="grid gap-4 sm:grid-cols-2">
    <div><h2 class="mb-2 text-sm font-semibold text-muted">스탭별 매출</h2><div class="card p-0 overflow-hidden divide-y divide-border">${mini(topStaff, (r) => `/revenue?tab=staff&staff=${r.id}&${qs}`, `/revenue?tab=staff&${qs}`, "전체 보기")}</div></div>
    <div><h2 class="mb-2 text-sm font-semibold text-muted">업체·개인별 매출</h2><div class="card p-0 overflow-hidden divide-y divide-border">${mini(topPayer, (r) => `/revenue?tab=payer&payer=${r.id}&${qs}`, `/revenue?tab=payer&${qs}`, "전체 보기")}</div></div>
  </div>`;
  const note = `<p class="mt-4 text-xs text-muted">매출 = 공급가(VAT 제외)·발행일 기준. 순이익 = 매출 − 외주 지급. 스탭별 매출 합은 청구서 할인 시 총 매출과 다를 수 있음(라인 기준).</p>`;
  return `${kpis}
    <div class="mb-4 grid gap-4 lg:grid-cols-[2fr_1fr]">${chart}${revTaxCard(tax)}</div>
    <div class="grid gap-4 lg:grid-cols-2">${typeSec}${tops}</div>
    ${note}`;
}

// ── 마스터-디테일 왼쪽 순위 목록(2026-07-19) ──
// 선택은 URL 쿼리로만 표현하므로 JS 없음. 선택 행 강조는 연락처와 같은 규약(aria-current + tint)이되,
// 연락처의 [data-contact-list] CSS는 셀렉터가 달라 안 걸리므로 클래스로 직접 준다(강조 하나에 CSS 표면을 늘리지 않는다).
function revListRow({ href, selected, title, right, sub }) {
  const cur = selected ? ` aria-current="page"` : "";
  const tint = selected ? " bg-primary/10 font-semibold" : "";
  return `<a href="${esc(href)}"${cur} class="block px-4 py-3 transition-colors hover:bg-surface active:bg-elevated focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40${tint}">
      <div class="flex items-center justify-between gap-3">
        <span class="min-w-0 truncate">${title}</span>
        <span class="shrink-0 tabular text-sm font-semibold">${right}</span>
      </div>
      <div class="mt-0.5 truncate text-xs text-muted">${sub}</div>
    </a>`;
}

// 스탭 순위 목록(왼쪽 마스터).
// listGroup의 .card는 overflow-hidden이라 contactPanes의 고정 높이 패널 안에서 넘친 행이 잘리고
// 스크롤바도 없다(2026-07-19 최종 리뷰 지적 — 연락처 contactNameList와 동일하게 lg:overflow-y-auto 래퍼로 감싼다).
// data-contact-list 마커는 붙이지 않는다 — 그건 연락처 전용 키보드 이동(↑↓) IIFE의 마커라 매출에도 붙으면 의도치 않게 동작한다.
function revStaffList(rows, { year, month, selId = 0 }) {
  if (!rows.length) return emptyState("이 기간 매출이 있는 스탭이 없습니다.", { card: true });
  const qs = periodQS({ year, month });
  const list = listGroup({ rows: rows.map((r) => revListRow({
    href: `/revenue?tab=staff&staff=${Number(r.id)}&${qs}`,
    selected: Number(r.id) === Number(selId),
    title: `${esc(r.name)}${r.is_external ? ` <span class="badge badge-neutral">외주</span>` : ""}`,
    right: formatKRW(r.supply),
    sub: `순이익 <span class="${profitCls(r.profit)}">${formatKRW(r.profit)}</span> · 작업 ${r.task_cnt} · 세션 ${r.session_cnt}`,
  })) });
  return `<div class="lg:min-h-0 lg:flex-1 lg:overflow-y-auto">${list}</div>`;
}

// 업체·개인 순위 목록(왼쪽 마스터). 스크롤 래퍼는 revStaffList와 동일 이유.
function revPayerList(rows, { year, month, selId = 0 }) {
  if (!rows.length) return emptyState("이 기간 매출이 있는 업체·개인이 없습니다.", { card: true });
  const qs = periodQS({ year, month });
  const kindLabel = (k) => (k === "person" ? "개인" : k === "group" ? "그룹" : "업체");
  const list = listGroup({ rows: rows.map((r) => revListRow({
    href: `/revenue?tab=payer&payer=${Number(r.id)}&${qs}`,
    selected: Number(r.id) === Number(selId),
    title: `${esc(r.name)} <span class="badge badge-neutral">${kindLabel(r.kind)}</span>`,
    right: formatKRW(r.supply),
    sub: `청구 ${r.invoice_cnt}건`,
  })) });
  return `<div class="lg:min-h-0 lg:flex-1 lg:overflow-y-auto">${list}</div>`;
}

// 스탭 드릴다운.
function revStaffDetail(data, { year, month }) {
  const { taskTypeLabel } = require("./data");
  const { manager, tasks, sessions, supply, payout, profit } = data;
  const summary = `<div class="card mb-4 flex flex-wrap gap-4 text-sm">
    <span>매출 <b class="tabular text-fg">${formatKRW(supply)}</b></span>
    <span>외주 지급 <b class="tabular text-fg">${formatKRW(payout)}</b></span>
    <span class="font-semibold">순이익 <b class="tabular ${profitCls(profit)}">${formatKRW(profit)}</b></span>
  </div>`;
  const taskRows = tasks.length ? listGroup({ rows: tasks.map((t) => listRow({ href: `/projects/${t.project_id}?tab=tracks`, left: `<span class="font-medium">${esc(taskTypeLabel(t.task_type))}</span> <span class="text-xs text-muted">· ${esc(t.project_title)} / ${esc(t.track_title)} · ${esc(String(t.issued_date))}</span>`, right: formatKRW(t.amount) })) }) : emptyState("작업 없음", { card: true });
  const sessRows = sessions.length ? listGroup({ rows: sessions.map((s) => listRow({ href: `/projects/${s.project_id}?tab=sessions`, left: `<span class="font-medium">${esc(s.session_date)} ${esc(s.session_type)}</span> <span class="text-xs text-muted">· ${esc(s.project_title)}</span>`, right: formatKRW(s.amount) })) }) : emptyState("세션 없음", { card: true });
  return `${summary}<h2 class="mb-2 mt-4 text-sm font-semibold text-muted">작업 (${tasks.length})</h2>${taskRows}<h2 class="mb-2 mt-4 text-sm font-semibold text-muted">세션 (${sessions.length})</h2>${sessRows}`;
}

// 결제자 드릴다운(기간 발행 청구서 — 공급가). 청구서로 새 탭 링크.
function revPayerDetail(data, { year, month }) {
  const { taxBadge } = require("./views.invoices");
  const { invoices, supply, invoice_cnt } = data;
  const summary = `<div class="card mb-4 flex flex-wrap gap-4 text-sm"><span>매출 기여 <b class="tabular text-fg">${formatKRW(supply)}</b></span><span>청구 ${invoice_cnt}건</span></div>`;
  if (!invoices.length) return `${summary}${emptyState("이 기간 발행 청구서가 없습니다.", { card: true })}`;
  const table = dataTable(
    [
      { label: "발행일", w: "w-[6.5rem]", nowrap: true, mCard: "tr" },
      { label: "청구번호", w: "w-[10rem]", nowrap: true, hide: "md", mobileHide: true },
      { label: "청구", primary: true, mCard: "tl" },
      { label: "상태", w: "w-[7rem]", mCard: "bl" },
      { label: "매출(공급가)", w: "w-[8rem]", right: true, nowrap: true, mCard: "br" },
    ],
    invoices.map((inv) => {
      const link = (inner, cls = "") => `<a href="/invoices/${inv.id}" target="_blank" rel="noopener" class="dt-link ${cls}">${inner}</a>`;
      return { cells: [
        inv.issued_date ? link(esc(String(inv.issued_date).slice(0, 10)), "text-muted") : `<span class="text-muted">—</span>`,
        inv.invoice_number ? link(esc(inv.invoice_number), "text-xs text-muted") : `<span class="text-muted">—</span>`,
        link(esc(inv.project_title || `청구 #${inv.id}`), "font-medium"),
        taxBadge(inv),
        link(formatKRW(inv.supply), "tabular font-semibold"),
      ] };
    })
  );
  return `${summary}${table}`;
}

module.exports = { revPeriodControl, revTabs, revBarChart, revDeltaBadge, revTypeBreakdown, revTaxCard, revOverview, revStaffList, revPayerList, revStaffDetail, revPayerDetail };
