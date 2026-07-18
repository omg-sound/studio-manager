"use strict";
const test = require("node:test");
const assert = require("node:assert");
const V = require("../src/views.revenue");

test("revBarChart: 12개월 막대 SVG(최대월 기준 높이·월 라벨·금액 title)", () => {
  const monthly = Array.from({ length: 12 }, (_, k) => ({ month: k + 1, supply: k === 6 ? 1000000 : 0 }));
  const svg = V.revBarChart(monthly);
  assert.match(svg, /<svg /, "SVG 루트");
  assert.match(svg, /<rect[^>]*class="rev-bar"/, "막대 = CSS 클래스 fill(인라인 style 금지)");
  assert.match(svg, /<title>7월/, "금액 title");
  assert.doesNotMatch(svg, /style="/, "인라인 style 없음(CSP)");
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
