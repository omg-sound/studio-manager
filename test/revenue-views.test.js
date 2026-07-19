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

test("revPeriodControl: select 변경 시 자동 제출(보기 버튼은 noscript 폴백)", () => {
  const html = V.revPeriodControl({ year: 2026, month: 7, years: [2026], tab: "staff" });
  assert.match(html, /<form[^>]*data-auto-submit/, "app.js 자동 제출 계약 마커");
  assert.match(html, /<noscript><button type="submit"[^>]*>보기<\/button><\/noscript>/, "보기 버튼은 noscript 안에만");
  assert.ok(!/<button type="submit"[^>]*>보기<\/button>(?![\s\S]*<\/noscript>)/.test(html.replace(/<noscript>[\s\S]*?<\/noscript>/, "")), "noscript 밖에 보기 버튼 없음");
});

test("revPeriodControl: 선택된 대상을 hidden으로 실어 기간 변경 시 유지", () => {
  const html = V.revPeriodControl({ year: 2026, month: 7, years: [2026], tab: "staff", sel: { name: "staff", id: 3 } });
  assert.match(html, /<input type="hidden" name="staff" value="3"/, "선택 유지 hidden");
  const none = V.revPeriodControl({ year: 2026, month: 7, years: [2026], tab: "overview" });
  assert.ok(!/name="staff"/.test(none) && !/name="payer"/.test(none), "미선택·개요 탭은 hidden 없음");
});

test("revStaffList: 패널 링크(탭·기간·id) + 순이익·건수 subline", () => {
  const html = V.revStaffList([{ id: 3, name: "김엔지", is_external: false, supply: 200000, profit: 150000, task_cnt: 2, session_cnt: 1 }], { year: 2026, month: 7 });
  assert.match(html, /김엔지/);
  // revListRow가 esc(href)를 쓰므로 렌더 결과의 &는 &amp;다(올바른 HTML — 브라우저가 디코드한다).
  assert.match(html, /href="\/revenue\?tab=staff&amp;staff=3&amp;year=2026&amp;month=7"/, "패널 URL(탭·기간·선택 id)");
  assert.match(html, /₩150,000/, "순이익 표시");
  assert.match(html, /작업 2 · 세션 1/, "건수 subline");
});

test("revStaffList: 선택 행만 aria-current", () => {
  const rows = [
    { id: 3, name: "김엔지", is_external: false, supply: 200000, profit: 150000, task_cnt: 1, session_cnt: 0 },
    { id: 4, name: "이엔지", is_external: true, supply: 100000, profit: 90000, task_cnt: 1, session_cnt: 0 },
  ];
  const html = V.revStaffList(rows, { year: 2026, month: 7, selId: 4 });
  assert.equal((html.match(/aria-current="page"/g) || []).length, 1, "선택 행 하나만");
  assert.match(html, /staff=4&amp;[^>]*aria-current="page"/, "선택된 id 행에 붙는다");
});

test("revStaffList: 음수 순이익(외주지급>매출)은 danger 색(초록 아님)", () => {
  const html = V.revStaffList([{ id: 4, name: "적자엔지", is_external: true, supply: 100000, profit: -50000, task_cnt: 1, session_cnt: 0 }], { year: 2026, month: 7 });
  assert.match(html, /text-danger">-₩50,000/, "음수 순이익 = text-danger");
  assert.match(html, /외주/, "외주 배지");
});

test("revPayerList: 패널 링크 + 구분 배지 + 청구 건수", () => {
  const html = V.revPayerList([{ id: 5, kind: "company", name: "도너츠컬처", supply: 300000, invoice_cnt: 2 }], { year: 2026, month: 7 });
  assert.match(html, /도너츠컬처/);
  assert.match(html, /href="\/revenue\?tab=payer&amp;payer=5&amp;year=2026&amp;month=7"/, "패널 URL");
  assert.match(html, /업체/, "구분 배지");
  assert.match(html, /청구 2건/, "건수 subline");
});

// 2026-07-19 사용자 요청 배치: 왼쪽=이름 / 배지, 오른쪽=금액 / 건수.
// DOM 등장 순서로 단언한다(클래스 문자열에 묶으면 사소한 스타일 변경에도 깨진다).
test("revPayerList: 배지는 이름 아래, 건수는 금액 아래(등장 순서)", () => {
  const html = V.revPayerList([{ id: 5, kind: "company", name: "도너츠컬처", supply: 300000, invoice_cnt: 2 }], { year: 2026, month: 7 });
  const iName = html.indexOf("도너츠컬처");
  const iBadge = html.indexOf("업체", iName);
  const iAmount = html.indexOf("₩300,000");
  const iCount = html.indexOf("청구 2건");
  assert.ok(iName < iBadge, "이름 다음에 배지(이름 줄에 인라인이 아니다)");
  assert.ok(iBadge < iAmount, "배지 다음에 금액");
  assert.ok(iAmount < iCount, "금액 다음에 건수(금액 아래 줄)");
});

test("revStaffList: 외주 배지·건수는 이름 아래, 순이익은 매출 아래(등장 순서)", () => {
  const html = V.revStaffList([{ id: 3, name: "김엔지", is_external: true, supply: 200000, profit: 150000, task_cnt: 2, session_cnt: 1 }], { year: 2026, month: 7 });
  const iName = html.indexOf("김엔지");
  const iBadge = html.indexOf("외주", iName);
  const iCounts = html.indexOf("작업 2 · 세션 1");
  const iSupply = html.indexOf("₩200,000");
  const iProfit = html.indexOf("순이익");
  assert.ok(iName < iBadge && iBadge < iCounts, "이름 → 외주 배지 → 건수");
  assert.ok(iCounts < iSupply, "왼쪽 열이 끝난 뒤 매출");
  assert.ok(iSupply < iProfit, "매출 다음 줄에 순이익");
});

test("revPayerList: 개인·그룹 구분 배지", () => {
  assert.match(V.revPayerList([{ id: 1, kind: "person", name: "김개인", supply: 1, invoice_cnt: 1 }], { year: 2026, month: 7 }), /개인/);
  assert.match(V.revPayerList([{ id: 2, kind: "group", name: "밴드", supply: 1, invoice_cnt: 1 }], { year: 2026, month: 7 }), /그룹/);
});

test("revStaffList/revPayerList: 빈 기간은 emptyState, 인라인 style 없음(함정 #27)", () => {
  const s = V.revStaffList([], { year: 2026, month: 7 });
  const p = V.revPayerList([], { year: 2026, month: 7 });
  assert.match(s, /매출이 있는 스탭이 없습니다/);
  assert.match(p, /매출이 있는 업체·개인이 없습니다/);
  assert.ok(!/ style="/.test(s) && !/ style="/.test(p), "서버 렌더 인라인 style 금지");
});

test("revStaffList/revPayerList: 목록 반환에 내부 스크롤 래퍼(lg:overflow-y-auto) — 고정 높이 패널에서 잘림 방지", () => {
  const staffRows = [{ id: 3, name: "김엔지", is_external: false, supply: 200000, profit: 150000, task_cnt: 2, session_cnt: 1 }];
  const payerRows = [{ id: 5, kind: "company", name: "도너츠컬처", supply: 300000, invoice_cnt: 2 }];
  const s = V.revStaffList(staffRows, { year: 2026, month: 7 });
  const p = V.revPayerList(payerRows, { year: 2026, month: 7 });
  assert.match(s, /lg:overflow-y-auto/, "스탭 목록: 내부 스크롤 래퍼");
  assert.match(p, /lg:overflow-y-auto/, "업체·개인 목록: 내부 스크롤 래퍼");
  // 빈 상태(emptyState)는 래퍼가 필요 없다 — 잘릴 내용 자체가 없으므로.
  const sEmpty = V.revStaffList([], { year: 2026, month: 7 });
  const pEmpty = V.revPayerList([], { year: 2026, month: 7 });
  assert.ok(!/lg:overflow-y-auto/.test(sEmpty), "빈 스탭 목록엔 스크롤 래퍼 없음");
  assert.ok(!/lg:overflow-y-auto/.test(pEmpty), "빈 업체·개인 목록엔 스크롤 래퍼 없음");
  // 연락처 전용 키보드 이동 마커(data-contact-list)는 매출에 붙지 않아야 한다(그 IIFE가 의도치 않게 동작하는 것 방지).
  assert.ok(!/data-contact-list/.test(s) && !/data-contact-list/.test(p), "연락처 전용 마커 미부착");
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

test("revOverview: Top5 링크는 패널 URL(구 드릴다운 경로 아님)", () => {
  const summary = { periodSupply: 0, periodProfit: 0, ytdSupply: 0, ytdProfit: 0, monthly: Array.from({length:12},(_,k)=>({month:k+1,supply:0,profit:0})), cmp: { isYear: false, prevPeriodSupply: 0, prevPeriodProfit: 0, prevYearSupply: 0, prevYearProfit: 0 } };
  const html = V.revOverview({
    summary,
    topStaff: [{ id: 3, name: "김엔지", supply: 100 }],
    topPayer: [{ id: 5, name: "도너츠컬처", supply: 100 }],
    byType: [], tax: { vatTotal: 0, payoutTotal: 0, withholding: { total: 0, net: 0 } },
    year: 2026, month: 7,
  });
  // 현재 mini()는 href를 esc 없이 넣어 &가 raw다(브라우저 파싱엔 문제없음). mini()에 esc를 넣는 정리를
  // 하게 되면 이 단언을 &amp;로 바꾸면 된다 — 비대칭 자체가 계약은 아니다.
  assert.match(html, /\/revenue\?tab=staff&staff=3&/, "스탭 Top5 → 패널 URL");
  assert.match(html, /\/revenue\?tab=payer&payer=5&/, "청구처 Top5 → 패널 URL");
  assert.ok(!/href="\/revenue\/staff\//.test(html), "구 드릴다운 경로 링크 없음");
});

test("revStaffTable/revPayerTable: 제거됨(상세 경로 단일화)", () => {
  assert.equal(V.revStaffTable, undefined);
  assert.equal(V.revPayerTable, undefined);
});
