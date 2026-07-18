"use strict";
const test = require("node:test");
const assert = require("node:assert");
const V = require("../src/views.revenue");

test("revBarChart: 월당 매출·순이익 2막대 + 범례, 인라인 style 없음", () => {
  const monthly = Array.from({ length: 12 }, (_, k) => ({ month: k + 1, supply: k === 6 ? 1000000 : 0, profit: k === 6 ? 700000 : 0 }));
  const svg = V.revBarChart(monthly);
  assert.match(svg, /class="rev-bar"/, "매출 막대");
  assert.match(svg, /class="rev-bar-profit"/, "순이익 막대");
  assert.match(svg, /매출/, "범례 매출");
  assert.match(svg, /순이익/, "범례 순이익");
  assert.doesNotMatch(svg, /style="/, "인라인 style 없음(CSP)");
});

test("revDeltaBadge: 상승 초록·하락 빨강·비교불가 —", () => {
  assert.match(V.revDeltaBadge(130, 100), /▲.*30%/s, "상승 30%");
  assert.match(V.revDeltaBadge(130, 100), /text-success/, "상승=초록");
  assert.match(V.revDeltaBadge(80, 100), /▼.*20%/s, "하락 20%");
  assert.match(V.revDeltaBadge(80, 100), /text-danger/, "하락=빨강");
  assert.match(V.revDeltaBadge(100, 0), /—/, "prev 0=비교불가");
});

test("revTypeBreakdown: 종류·비중 막대(width=pct)·금액, 인라인 style 없음", () => {
  const html = V.revTypeBreakdown([{ label: "믹싱", amount: 800000 }, { label: "녹음", amount: 200000 }]);
  assert.match(html, /믹싱/);
  assert.match(html, /80%/, "믹싱 비중 80%");
  assert.match(html, /<rect[^>]*width="80"/, "SVG 막대 width=pct(viewBox 100 기준)");
  assert.doesNotMatch(html, /style="/, "인라인 style 없음");
});

test("revTaxCard: VAT 합계 + 원천징수(실지급 병기)", () => {
  const html = V.revTaxCard({ vatTotal: 30000, payoutTotal: 100000, withholding: { gross: 100000, incomeTax: 3000, localTax: 300, total: 3300, net: 96700 } });
  assert.match(html, /VAT 합계/);
  assert.match(html, /₩30,000/);
  assert.match(html, /원천징수/);
  assert.match(html, /₩3,300/, "원천세");
  assert.match(html, /₩96,700/, "실지급");
});

test("revPeriodControl: 년·월 셀렉트 + 탭·기간 유지 GET 폼", () => {
  const html = V.revPeriodControl({ year: 2026, month: 7, years: [2026, 2025], tab: "staff" });
  assert.match(html, /<form method="get"/, "GET 폼");
  assert.match(html, /name="year"/, "년 셀렉트");
  assert.match(html, /name="month"/, "월 셀렉트");
  assert.match(html, /value="all"[^>]*>전체/, "월 전체 옵션");
  assert.match(html, /name="tab" value="staff"/, "현재 탭 유지");
});

test("revStaffTable: 매출·순이익·건수 컬럼 + 상세 링크(기간 보존)", () => {
  const html = V.revStaffTable([{ id: 3, name: "김엔지", is_external: false, supply: 200000, profit: 150000, task_cnt: 2, session_cnt: 1 }], { year: 2026, month: 7 });
  assert.match(html, /김엔지/);
  assert.match(html, /\/revenue\/staff\/3\?year=2026&month=7/, "상세 링크 기간 보존");
  assert.match(html, /₩150,000/, "순이익 표시");
});

test("revPayerTable: 업체/개인 배지 + 매출 기여 + 상세 링크", () => {
  const html = V.revPayerTable([{ id: 5, kind: "company", name: "도너츠컬처", supply: 300000, invoice_cnt: 2 }], { year: 2026, month: 7 });
  assert.match(html, /도너츠컬처/);
  assert.match(html, /\/revenue\/payer\/5\?year=2026&month=7/, "상세 링크");
});

test("revOverview: 대시보드 그리드 + KPI 델타(선택 기간만) + 명칭 '스탭별 매출'/'업체·개인별 매출'", () => {
  const summary = { periodSupply: 200, periodProfit: 150, ytdSupply: 500, ytdProfit: 400, monthly: Array.from({length:12},(_,k)=>({month:k+1,supply:0,profit:0})), cmp: { isYear: false, prevPeriodSupply: 100, prevPeriodProfit: 100, prevYearSupply: 100, prevYearProfit: 50 } };
  const html = V.revOverview({ summary, topStaff: [], topPayer: [], byType: [{label:"믹싱",amount:200}], tax: { vatTotal: 20, payoutTotal: 50, withholding: { total: 1, net: 49 } }, year: 2027, month: 7 });
  assert.match(html, /스탭별 매출/, "명칭 변경");
  assert.match(html, /업체·개인별 매출/, "명칭 변경");
  assert.match(html, /종류별 매출 구성|믹싱/, "종류 구성");
  assert.match(html, /세무 참고|VAT 합계/, "세무 카드");
  assert.match(html, /전월/, "선택 기간 KPI 델타(전월)");
  assert.doesNotMatch(html, /올해 누적[^<]*전월/s, "누적 KPI엔 델타 없음(느슨 검사)");
});
