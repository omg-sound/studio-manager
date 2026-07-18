"use strict";
// 매출 전용 뷰(2026-07-19) — 기간 컨트롤·탭·KPI·SVG 바 차트·순위 표·드릴다운.
const { esc, formatKRW, tabBar, dataTable, emptyState, pageHeader, listGroup, listRow } = require("./views");

const MONTHS = Array.from({ length: 12 }, (_, k) => k + 1);
// 기간 쿼리 문자열(링크·폼 유지). month은 숫자 또는 'all'.
function periodQS({ year, month }) { return `year=${Number(year)}&month=${month === "all" ? "all" : Number(month)}`; }

// 년·월 셀렉트 + 보기 버튼(무JS GET 폼). 탭·기간 유지.
function revPeriodControl({ year, month, years, tab }) {
  const yrs = years && years.length ? years : [Number(year)];
  const yOpts = yrs.map((y) => `<option value="${y}"${y === Number(year) ? " selected" : ""}>${y}년</option>`).join("");
  const mOpts = `<option value="all"${month === "all" ? " selected" : ""}>전체(연간)</option>` +
    MONTHS.map((m) => `<option value="${m}"${String(month) === String(m) ? " selected" : ""}>${m}월</option>`).join("");
  return `<form method="get" class="mb-4 flex flex-wrap items-center gap-2">
    <input type="hidden" name="tab" value="${esc(tab)}" />
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

// 월별 공급가 인라인 SVG 바 차트(높이=월/최대월). 색=CSS 클래스(fill), 인라인 style 금지(CSP·함정 #27).
function revBarChart(monthly) {
  const max = Math.max(1, ...monthly.map((m) => m.supply));
  const W = 640, H = 150, base = H - 22, top = 12;
  const n = monthly.length, slot = (W - 8) / n, bw = slot * 0.56;
  const parts = monthly.map((m, k) => {
    const h = Math.round((m.supply / max) * (base - top));
    const x = 4 + k * slot + (slot - bw) / 2, y = base - h;
    return `<rect x="${x.toFixed(1)}" y="${y}" width="${bw.toFixed(1)}" height="${h}" rx="2" class="rev-bar"><title>${m.month}월 ${formatKRW(m.supply)}</title></rect>`
      + `<text x="${(x + bw / 2).toFixed(1)}" y="${H - 4}" text-anchor="middle" class="rev-bar-label">${m.month}</text>`;
  }).join("");
  return `<svg viewBox="0 0 ${W} ${H}" class="w-full" role="img" aria-label="월별 매출 추세">${parts}</svg>`;
}

// KPI 카드(청구 overview statCard와 동일 톤).
function kpiCard(label, value, tone = "text-fg") {
  return `<div class="card flex items-center justify-between gap-3"><span class="text-sm text-muted">${label}</span><span class="tabular text-lg font-bold ${tone}">${formatKRW(value)}</span></div>`;
}

// 이름·금액 미니 목록(Top N).
function miniList(rows, hrefFn, moreHref, moreLabel) {
  if (!rows.length) return `<div class="card text-sm text-muted">내역이 없습니다.</div>`;
  const items = rows.map((r) => listRow({ href: hrefFn(r), left: `<span class="font-medium">${esc(r.name)}</span>`, right: `<span class="tabular font-semibold">${formatKRW(r.supply)}</span>` }));
  return `${listGroup({ rows: items })}<div class="mt-1 text-right"><a href="${esc(moreHref)}" class="text-xs text-primary hover:underline">${esc(moreLabel)} →</a></div>`;
}

// 개요 탭.
function revOverview({ summary, topStaff, topPayer, year, month }) {
  const qs = periodQS({ year, month });
  const periodLabel = month === "all" ? `${year}년 전체` : `${year}년 ${Number(month)}월`;
  const kpis = `<div class="mb-4 grid gap-3 sm:grid-cols-2">
    ${kpiCard(`${esc(periodLabel)} 매출`, summary.periodSupply)}
    ${kpiCard(`${esc(periodLabel)} 순이익`, summary.periodProfit, "text-success")}
    ${kpiCard(`올해 누적 매출`, summary.ytdSupply)}
    ${kpiCard(`올해 누적 순이익`, summary.ytdProfit, "text-success")}
  </div>`;
  const chart = `<div class="card mb-4"><div class="mb-1 text-sm font-semibold">${esc(year)}년 월별 매출</div>${revBarChart(summary.monthly)}</div>`;
  const tops = `<div class="grid gap-4 sm:grid-cols-2">
    <div><h2 class="mb-2 text-sm font-semibold text-muted">Top 스탭</h2>${miniList(topStaff, (r) => `/revenue/staff/${r.id}?${qs}`, `/revenue?tab=staff&${qs}`, "스탭별 전체")}</div>
    <div><h2 class="mb-2 text-sm font-semibold text-muted">Top 업체·개인</h2>${miniList(topPayer, (r) => `/revenue/payer/${r.id}?${qs}`, `/revenue?tab=payer&${qs}`, "업체·개인별 전체")}</div>
  </div>`;
  const note = `<p class="mt-4 text-xs text-muted">매출 = 공급가(VAT 제외)·발행일 기준. 순이익 = 매출 − 외주 지급. Top 스탭 합은 청구서 할인 시 총 매출과 다를 수 있음(라인 기준).</p>`;
  return `${kpis}${chart}${tops}${note}`;
}

// 스탭 순위 표.
function revStaffTable(rows, { year, month }) {
  if (!rows.length) return emptyState("이 기간 매출이 있는 스탭이 없습니다.", { card: true });
  const qs = periodQS({ year, month });
  return dataTable(
    [
      { label: "스탭", primary: true, mCard: "tl" },
      { label: "매출", w: "w-[8rem]", right: true, nowrap: true, mCard: "tr" },
      { label: "순이익", w: "w-[8rem]", right: true, nowrap: true, mCard: "bl" },
      { label: "건수", w: "w-[7rem]", nowrap: true, hide: "sm", mCard: "br" },
    ],
    rows.map((r) => {
      const link = (inner, cls = "") => `<a href="/revenue/staff/${r.id}?${qs}" class="dt-link ${cls}">${inner}</a>`;
      const badge = r.is_external ? ` <span class="badge badge-neutral">외주</span>` : "";
      return { cells: [
        link(`${esc(r.name)}${badge}`, "font-medium"),
        link(formatKRW(r.supply), "tabular font-semibold"),
        link(formatKRW(r.profit), "tabular text-success"),
        link(`작업 ${r.task_cnt} · 세션 ${r.session_cnt}`, "text-muted"),
      ] };
    })
  );
}

// 업체·개인 순위 표.
function revPayerTable(rows, { year, month }) {
  if (!rows.length) return emptyState("이 기간 매출이 있는 업체·개인이 없습니다.", { card: true });
  const qs = periodQS({ year, month });
  const kindLabel = (k) => (k === "person" ? "개인" : k === "group" ? "그룹" : "업체");
  return dataTable(
    [
      { label: "청구처", primary: true, mCard: "tl" },
      { label: "구분", w: "w-[5rem]", hide: "sm", mCard: "bl" },
      { label: "매출 기여", w: "w-[9rem]", right: true, nowrap: true, mCard: "tr" },
      { label: "청구 건수", w: "w-[6rem]", right: true, nowrap: true, hide: "sm", mCard: "br" },
    ],
    rows.map((r) => {
      const link = (inner, cls = "") => `<a href="/revenue/payer/${r.id}?${qs}" class="dt-link ${cls}">${inner}</a>`;
      return { cells: [
        link(esc(r.name), "font-medium"),
        link(`<span class="badge badge-neutral">${kindLabel(r.kind)}</span>`),
        link(formatKRW(r.supply), "tabular font-semibold"),
        link(String(r.invoice_cnt), "tabular text-muted"),
      ] };
    })
  );
}

// 스탭 드릴다운.
function revStaffDetail(data, { year, month }) {
  const { manager, tasks, sessions, supply, payout, profit } = data;
  const summary = `<div class="card mb-4 flex flex-wrap gap-4 text-sm">
    <span>매출 <b class="tabular text-fg">${formatKRW(supply)}</b></span>
    <span>외주 지급 <b class="tabular text-fg">${formatKRW(payout)}</b></span>
    <span class="font-semibold">순이익 <b class="tabular text-success">${formatKRW(profit)}</b></span>
  </div>`;
  const taskRows = tasks.length ? listGroup({ rows: tasks.map((t) => listRow({ href: `/projects/${t.project_id}?tab=tracks`, left: `<span class="font-medium">${esc(t.task_type)}</span> <span class="text-xs text-muted">· ${esc(t.project_title)} / ${esc(t.track_title)} · ${esc(String(t.issued_date))}</span>`, right: formatKRW(t.amount) })) }) : emptyState("작업 없음", { card: true });
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

module.exports = { revPeriodControl, revTabs, revBarChart, revOverview, revStaffTable, revPayerTable, revStaffDetail, revPayerDetail };
