"use strict";
const test = require("node:test");
const assert = require("node:assert");
const V = require("../src/views.revenue");
const { formatKRW } = require("../src/views");

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

test("revTabs: 개요 링크만 기간을 싣는다(목록 탭은 누적이라 기간이 없다)", () => {
  const html = V.revTabs({ tab: "payer", year: 2026, month: 7 });
  // tabBar가 href를 esc()하므로 '&'는 '&amp;'로 렌더된다(다른 revTabs/revStaffList href 검증과 동일 규약).
  assert.match(html, /href="\/revenue\?tab=overview&amp;year=2026&amp;month=7"/, "개요는 기간 유지");
  assert.match(html, /href="\/revenue\?tab=staff"/, "스탭별은 기간 없음");
  assert.match(html, /href="\/revenue\?tab=payer"/, "업체·개인별은 기간 없음");
});

test("revStaffList: 패널 링크(탭·id) + 순이익·건수 subline", () => {
  const html = V.revStaffList([{ id: 3, name: "김엔지", is_external: false, supply: 200000, profit: 150000, task_cnt: 2, session_cnt: 1 }], {});
  assert.match(html, /김엔지/);
  // revListRow가 esc(href)를 쓰므로 렌더 결과의 &는 &amp;다(올바른 HTML — 브라우저가 디코드한다).
  assert.match(html, /href="\/revenue\?tab=staff&amp;staff=3"/, "패널 URL(탭·선택 id, 기간 없음)");
  assert.match(html, /₩150,000/, "순이익 표시");
  assert.match(html, /작업 2 · 세션 1/, "건수 subline");
});

test("revStaffList: 선택 행만 aria-current", () => {
  const rows = [
    { id: 3, name: "김엔지", is_external: false, supply: 200000, profit: 150000, task_cnt: 1, session_cnt: 0 },
    { id: 4, name: "이엔지", is_external: true, supply: 100000, profit: 90000, task_cnt: 1, session_cnt: 0 },
  ];
  const html = V.revStaffList(rows, { selId: 4 });
  assert.equal((html.match(/aria-current="page"/g) || []).length, 1, "선택 행 하나만");
  assert.match(html, /staff=4"[^>]*aria-current="page"/, "선택된 id 행에 붙는다");
});

test("revStaffList: 음수 순이익(외주지급>매출)은 danger 색(초록 아님)", () => {
  const html = V.revStaffList([{ id: 4, name: "적자엔지", is_external: true, supply: 100000, profit: -50000, task_cnt: 1, session_cnt: 0 }], {});
  assert.match(html, /text-danger">-₩50,000/, "음수 순이익 = text-danger");
  assert.match(html, /외주/, "외주 배지");
});

test("revPayerList: 패널 링크 + 구분 배지 + 청구 건수", () => {
  const html = V.revPayerList([{ id: 5, kind: "company", name: "도너츠컬처", supply: 300000, invoice_cnt: 2 }], {});
  assert.match(html, /도너츠컬처/);
  assert.match(html, /href="\/revenue\?tab=payer&amp;payer=5"/, "패널 URL(기간 없음)");
  assert.match(html, /업체/, "구분 배지");
  assert.match(html, /청구 2건/, "건수 subline");
});

// 2026-07-19 사용자 요청 배치: 왼쪽=이름 / 배지, 오른쪽=금액 / 건수.
// DOM 등장 순서로 단언한다(클래스 문자열에 묶으면 사소한 스타일 변경에도 깨진다).
test("revPayerList: 배지는 이름 아래, 건수는 금액 아래(등장 순서)", () => {
  const html = V.revPayerList([{ id: 5, kind: "company", name: "도너츠컬처", supply: 300000, invoice_cnt: 2 }], {});
  const iName = html.indexOf("도너츠컬처");
  const iBadge = html.indexOf("업체", iName);
  const iAmount = html.indexOf("₩300,000");
  const iCount = html.indexOf("청구 2건");
  assert.ok(iName < iBadge, "이름 다음에 배지(이름 줄에 인라인이 아니다)");
  assert.ok(iBadge < iAmount, "배지 다음에 금액");
  assert.ok(iAmount < iCount, "금액 다음에 건수(금액 아래 줄)");
});

test("revStaffList: 외주 배지·건수는 이름 아래, 순이익은 매출 아래(등장 순서)", () => {
  const html = V.revStaffList([{ id: 3, name: "김엔지", is_external: true, supply: 200000, profit: 150000, task_cnt: 2, session_cnt: 1 }], {});
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
  assert.match(V.revPayerList([{ id: 1, kind: "person", name: "김개인", supply: 1, invoice_cnt: 1 }], {}), /개인/);
  assert.match(V.revPayerList([{ id: 2, kind: "group", name: "밴드", supply: 1, invoice_cnt: 1 }], {}), /그룹/);
});

test("revStaffList/revPayerList: 빈 목록은 emptyState, 인라인 style 없음(함정 #27)", () => {
  const s = V.revStaffList([], {});
  const p = V.revPayerList([], {});
  assert.match(s, /매출 기여가 있는 스탭이 없습니다/);
  assert.match(p, /매출 기여가 있는 업체·개인이 없습니다/);
  assert.ok(!/ style="/.test(s) && !/ style="/.test(p), "서버 렌더 인라인 style 금지");
});

test("revStaffList/revPayerList: 목록 반환에 내부 스크롤 래퍼(lg:overflow-y-auto) — 고정 높이 패널에서 잘림 방지", () => {
  const staffRows = [{ id: 3, name: "김엔지", is_external: false, supply: 200000, profit: 150000, task_cnt: 2, session_cnt: 1 }];
  const payerRows = [{ id: 5, kind: "company", name: "도너츠컬처", supply: 300000, invoice_cnt: 2 }];
  const s = V.revStaffList(staffRows, {});
  const p = V.revPayerList(payerRows, {});
  assert.match(s, /lg:overflow-y-auto/, "스탭 목록: 내부 스크롤 래퍼");
  assert.match(p, /lg:overflow-y-auto/, "업체·개인 목록: 내부 스크롤 래퍼");
  // 빈 상태(emptyState)는 래퍼가 필요 없다 — 잘릴 내용 자체가 없으므로.
  const sEmpty = V.revStaffList([], {});
  const pEmpty = V.revPayerList([], {});
  assert.ok(!/lg:overflow-y-auto/.test(sEmpty), "빈 스탭 목록엔 스크롤 래퍼 없음");
  assert.ok(!/lg:overflow-y-auto/.test(pEmpty), "빈 업체·개인 목록엔 스크롤 래퍼 없음");
  // 키보드 이동 마커(data-nav-list) 부착 — 로드 시 선택 행 포커스로 스크롤 위치가 유지되고 ↑↓ 이동이 된다
  // (2026-07-19 사용자 요청). 옛 연락처 전용 이름(data-contact-list)은 3화면 공용이 되며 일반화됐다.
  assert.match(s, /data-nav-list/, "스탭 목록: 키보드 이동 마커");
  assert.match(p, /data-nav-list/, "업체·개인 목록: 키보드 이동 마커");
  assert.ok(!/data-contact-list/.test(s) && !/data-contact-list/.test(p), "옛 마커 이름은 남지 않음");
});

test("revStaffList/revPayerList: 기간 없는 href + 최근 거래월 표기", () => {
  const s = V.revStaffList([{ id: 3, name: "김엔지", is_external: false, supply: 200000, profit: 150000, task_cnt: 2, session_cnt: 1, last_issued: "2026-07-16" }], {});
  assert.match(s, /href="\/revenue\?tab=staff&amp;staff=3"/, "기간 파라미터 없는 href");
  assert.match(s, /최근 2026\.7/, "최근 거래월");
  const p = V.revPayerList([{ id: 5, kind: "company", name: "도너츠컬처", supply: 300000, invoice_cnt: 2, last_issued: "2026-03-08" }], {});
  assert.match(p, /href="\/revenue\?tab=payer&amp;payer=5"/);
  assert.match(p, /최근 2026\.3/);
});

test("revStaffList/revPayerList: last_issued 없으면 최근 표기를 생략한다", () => {
  const s = V.revStaffList([{ id: 3, name: "김엔지", is_external: false, supply: 1, profit: 1, task_cnt: 1, session_cnt: 0, last_issued: null }], {});
  assert.ok(!/최근/.test(s), "값 없으면 '최근' 문구 자체가 없다");
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

test("revOverview: 상위 5개 + 나머지 펼침, '전체 보기' 링크 없음", () => {
  const summary = { periodSupply: 0, periodProfit: 0, ytdSupply: 0, ytdProfit: 0, monthly: Array.from({length:12},(_,k)=>({month:k+1,supply:0,profit:0})), cmp: { isYear: false, prevPeriodSupply: 0, prevPeriodProfit: 0, prevYearSupply: 0, prevYearProfit: 0 } };
  const payers = Array.from({ length: 7 }, (_, k) => ({ id: k + 1, name: `업체${k + 1}`, supply: (7 - k) * 1000 }));
  const html = V.revOverview({ summary, topStaff: [], topPayer: payers, byType: [], tax: { vatTotal: 0, payoutTotal: 0, withholding: { total: 0, net: 0 } }, year: 2026, month: 7 });
  assert.match(html, /업체1/, "상위 항목");
  assert.match(html, /업체7/, "나머지도 펼침 안에 렌더된다");
  assert.match(html, /<details/, "펼침은 네이티브 details(무JS)");
  assert.match(html, /전체 7곳 보기/, "펼침 라벨에 총 개수");
  assert.match(html, /\/revenue\?tab=payer&payer=1"/, "행 링크는 기간 없는 상세 URL");
  assert.ok(!/전체 보기 →/.test(html), "옛 '전체 보기' 링크 없음");
  assert.ok(!/href="\/revenue\?tab=payer&year=/.test(html), "기간을 실은 목록 링크 없음");
});

test("revOverview: 스탭 펼침 라벨은 '명'(업체·개인 '곳'과 단위가 다르다)", () => {
  const summary = { periodSupply: 0, periodProfit: 0, ytdSupply: 0, ytdProfit: 0, monthly: Array.from({length:12},(_,k)=>({month:k+1,supply:0,profit:0})), cmp: { isYear: false, prevPeriodSupply: 0, prevPeriodProfit: 0, prevYearSupply: 0, prevYearProfit: 0 } };
  const staff = Array.from({ length: 7 }, (_, k) => ({ id: k + 1, name: `스탭${k + 1}`, supply: (7 - k) * 1000 }));
  const html = V.revOverview({ summary, topStaff: staff, topPayer: [], byType: [], tax: { vatTotal: 0, payoutTotal: 0, withholding: { total: 0, net: 0 } }, year: 2026, month: 7 });
  assert.match(html, /전체 7명 보기/, "스탭 펼침 라벨은 '명'");
  assert.ok(!/전체 7곳 보기/.test(html), "업체 단위 '곳'이 섞이지 않음");
});

test("revOverview: 5개 이하면 펼침을 만들지 않는다", () => {
  const summary = { periodSupply: 0, periodProfit: 0, ytdSupply: 0, ytdProfit: 0, monthly: Array.from({length:12},(_,k)=>({month:k+1,supply:0,profit:0})), cmp: { isYear: false, prevPeriodSupply: 0, prevPeriodProfit: 0, prevYearSupply: 0, prevYearProfit: 0 } };
  const payers = [{ id: 1, name: "업체1", supply: 100 }];
  const html = V.revOverview({ summary, topStaff: [], topPayer: payers, byType: [], tax: { vatTotal: 0, payoutTotal: 0, withholding: { total: 0, net: 0 } }, year: 2026, month: 7 });
  assert.ok(!/<details/.test(html), "더 볼 게 없으면 펼침 없음");
});

test("revStaffTable/revPayerTable: 제거됨(상세 경로 단일화)", () => {
  assert.equal(V.revStaffTable, undefined);
  assert.equal(V.revPayerTable, undefined);
});

test("revStaffDetail: 월별 그룹 + 월 안에서 작업·세션이 날짜순으로 섞인다", () => {
  const data = {
    manager: { id: 3, name: "김엔지", user_id: 1 },
    tasks: [
      { id: 1, task_type: "mixing", amount: 500000, worker_rate: 0, track_title: "곡A", project_id: 9, project_title: "프로젝트A", issued_date: "2026-07-20" },
      { id: 2, task_type: "mixing", amount: 300000, worker_rate: 0, track_title: "곡B", project_id: 9, project_title: "프로젝트A", issued_date: "2026-06-05" },
    ],
    sessions: [
      { id: 11, session_date: "2026-07-10", session_type: "녹음", amount: 200000, payout: 50000, project_id: 9, project_title: "프로젝트A", issued_date: "2026-07-25" },
    ],
    supply: 1000000, payout: 50000, profit: 950000,
  };
  const html = V.revStaffDetail(data);
  assert.match(html, /2026년 7월/, "7월 그룹 헤더");
  assert.match(html, /2026년 6월/, "6월 그룹 헤더");
  // 7월 그룹이 6월보다 먼저(최신 월 우선)
  assert.ok(html.indexOf("2026년 7월") < html.indexOf("2026년 6월"), "최신 월 우선");
  // 7월 안에서 세션(발행 7-25)이 작업(발행 7-20)보다 먼저 = 섞여서 날짜순
  const jul = html.slice(html.indexOf("2026년 7월"), html.indexOf("2026년 6월"));
  assert.ok(jul.indexOf("녹음") < jul.indexOf("곡A"), "월 안에서 작업·세션이 종류가 아니라 날짜순으로 섞인다");
  // 월 소계: 7월 매출 70만(50만+20만), 순이익 65만(-5만)
  assert.match(jul, /₩700,000/, "7월 매출 소계");
  assert.match(jul, /₩650,000/, "7월 순이익 소계");
});

test("revPayerDetail: 월별 그룹 + 월 매출 소계", () => {
  const data = {
    party: { id: 5, name: "도너츠컬처", kind: "company" },
    invoices: [
      { id: 1, invoice_number: "OMG-202607-018", issued_date: "2026-07-16", amount: 440000, tax_amount: 40000, supply: 400000, tax_status: "계산서 발행", status: "발행", payer_kind: "company", project_title: "프로젝트A" },
      { id: 2, invoice_number: "OMG-202606-001", issued_date: "2026-06-18", amount: 3300000, tax_amount: 300000, supply: 3000000, tax_status: "계산서 발행", status: "발행", payer_kind: "company", project_title: "프로젝트B" },
    ],
    supply: 3400000, invoice_cnt: 2,
  };
  const html = V.revPayerDetail(data);
  assert.match(html, /2026년 7월/);
  assert.match(html, /2026년 6월/);
  assert.ok(html.indexOf("2026년 7월") < html.indexOf("2026년 6월"), "최신 월 우선");
  assert.match(html, /₩400,000/, "7월 소계");
  assert.match(html, /₩3,000,000/, "6월 소계");
});

// [최종 리뷰 지적 4] 스펙(§2)의 상세 총계 = "총 매출·건수·최근 거래"(스탭은 순이익 포함) — 최근 거래월 누락 보완.
test("revStaffDetail: 요약 카드에 최근 거래월(가장 최신 발행일)", () => {
  const data = {
    manager: { id: 3, name: "김엔지", user_id: 1 },
    tasks: [
      { id: 1, task_type: "mixing", amount: 500000, worker_rate: 0, track_title: "곡A", project_id: 9, project_title: "프로젝트A", issued_date: "2026-06-05" },
    ],
    sessions: [
      { id: 11, session_date: "2026-07-10", session_type: "녹음", amount: 200000, payout: 50000, project_id: 9, project_title: "프로젝트A", issued_date: "2026-07-25" },
    ],
    supply: 700000, payout: 50000, profit: 650000,
  };
  const html = V.revStaffDetail(data);
  const summary = html.slice(0, html.indexOf("2026년 7월"));
  assert.match(summary, /최근 2026\.7/, "요약 카드에 가장 최근(7월) 발행일 표기");
});

test("revStaffDetail: 항목이 없으면 요약 카드에 최근 거래 표기를 생략한다", () => {
  const html = V.revStaffDetail({ manager: { id: 1, name: "김", user_id: 1 }, tasks: [], sessions: [], supply: 0, payout: 0, profit: 0 });
  assert.ok(!/최근/.test(html), "항목이 없으면 '최근' 문구 자체가 없다");
});

test("revPayerDetail: 요약 카드에 최근 거래월(가장 최신 발행일)", () => {
  const data = {
    party: { id: 5, name: "도너츠컬처", kind: "company" },
    invoices: [
      { id: 1, invoice_number: "OMG-202607-018", issued_date: "2026-07-16", amount: 440000, tax_amount: 40000, supply: 400000, tax_status: "계산서 발행", status: "발행", payer_kind: "company", project_title: "프로젝트A" },
      { id: 2, invoice_number: "OMG-202606-001", issued_date: "2026-06-18", amount: 3300000, tax_amount: 300000, supply: 3000000, tax_status: "계산서 발행", status: "발행", payer_kind: "company", project_title: "프로젝트B" },
    ],
    supply: 3400000, invoice_cnt: 2,
  };
  const html = V.revPayerDetail(data);
  const summary = html.slice(0, html.indexOf("2026년 7월"));
  assert.match(summary, /최근 2026\.7/, "요약 카드에 가장 최근(7월) 발행일 표기");
});

test("revPayerDetail: 청구서가 없으면 요약 카드에 최근 거래 표기를 생략한다", () => {
  const html = V.revPayerDetail({ party: { id: 1, name: "회사", kind: "company" }, invoices: [], supply: 0, invoice_cnt: 0 });
  assert.ok(!/최근/.test(html), "청구서가 없으면 '최근' 문구 자체가 없다");
});

test("revStaffDetail/revPayerDetail: 인라인 style 없음(CSP)", () => {
  const s = V.revStaffDetail({ manager: { id: 1, name: "김", user_id: 1 }, tasks: [], sessions: [], supply: 0, payout: 0, profit: 0 });
  const p = V.revPayerDetail({ party: { id: 1, name: "회사", kind: "company" }, invoices: [], supply: 0, invoice_cnt: 0 });
  assert.ok(!/ style="/.test(s) && !/ style="/.test(p));
});

// [리뷰 지적 1] 매출 패널 밖으로 나가는 링크(프로젝트·청구서)는 새 탭 — 연락처 마스터-디테일과 동일 규칙
// (백링크 없는 패널이라 같은 탭에서 나가면 보던 목록으로 못 돌아온다).
test("revStaffDetail: 프로젝트 링크는 새 탭(target=_blank rel=noopener) + 라벨에 ↗", () => {
  const data = {
    manager: { id: 3, name: "김엔지", user_id: 1 },
    tasks: [{ id: 1, task_type: "mixing", amount: 500000, worker_rate: 0, track_title: "곡A", project_id: 9, project_title: "프로젝트A", issued_date: "2026-07-20" }],
    sessions: [], supply: 500000, payout: 0, profit: 500000,
  };
  const html = V.revStaffDetail(data);
  assert.match(html, /<a href="\/projects\/9\?tab=tracks" target="_blank" rel="noopener"/, "프로젝트 링크 새 탭");
  assert.match(html, /mixing ↗/, "라벨(작업 종류)에 ↗ 표기(연락처 관례)");
});

test("revPayerDetail: 청구서 링크는 새 탭(target=_blank rel=noopener) + 라벨에 ↗", () => {
  const data = {
    party: { id: 5, name: "도너츠컬처", kind: "company" },
    invoices: [{ id: 1, invoice_number: "OMG-202607-018", issued_date: "2026-07-16", amount: 440000, tax_amount: 40000, supply: 400000, tax_status: "계산서 발행", status: "발행", payer_kind: "company", project_title: "프로젝트A" }],
    supply: 400000, invoice_cnt: 1,
  };
  const html = V.revPayerDetail(data);
  assert.match(html, /<a href="\/invoices\/1" target="_blank" rel="noopener"/, "청구서 링크 새 탭");
  assert.match(html, /프로젝트A ↗/, "라벨에 ↗ 표기");
});

// [리뷰 지적 2] revPayerDetail도 revStaffDetail처럼 groupByMonth 호출 전 방어적 정렬을 갖는다 —
// 데이터 레이어 SQL 정렬(issued_date DESC)이 바뀌어도(혹은 호출부가 순서를 실수로 흩트려도) 같은 달이
// 여러 그룹으로 쪼개지지 않아야 한다.
test("revPayerDetail: invoices 배열이 발행일순이 아니어도 같은 달은 한 그룹으로 묶인다", () => {
  const data = {
    party: { id: 5, name: "도너츠컬처", kind: "company" },
    invoices: [
      // 일부러 뒤섞은 순서(7월 → 6월 → 7월)
      { id: 1, invoice_number: "A", issued_date: "2026-07-05", amount: 110000, tax_amount: 10000, supply: 100000, tax_status: "발행", status: "발행", payer_kind: "company", project_title: "P1" },
      { id: 2, invoice_number: "B", issued_date: "2026-06-20", amount: 220000, tax_amount: 20000, supply: 200000, tax_status: "발행", status: "발행", payer_kind: "company", project_title: "P2" },
      { id: 3, invoice_number: "C", issued_date: "2026-07-16", amount: 330000, tax_amount: 30000, supply: 300000, tax_status: "발행", status: "발행", payer_kind: "company", project_title: "P3" },
    ],
    supply: 600000, invoice_cnt: 3,
  };
  const html = V.revPayerDetail(data);
  // "2026년 7월" 헤더가 정확히 한 번만 등장해야(뒤섞인 입력이 두 그룹으로 쪼개지면 두 번 등장) — 7월 소계도 합산(40만).
  assert.equal((html.match(/2026년 7월/g) || []).length, 1, "뒤섞인 입력이어도 7월 그룹은 하나");
  assert.match(html, /₩400,000/, "7월 소계(10만+30만) 정확히 합산");
});

// [리뷰 지적 3] monthLabel의 빈 ym 가드 — 현재는 ISSUED 조건(issued_date IS NOT NULL)이 막아 도달 불가하지만,
// 값이 없을 때 "년 NaN월" 대신 안전한 문구를 반환해야 한다.
test("revStaffDetail: issued_date가 비어도(방어) '년 NaN월' 대신 안전 문구", () => {
  const data = {
    manager: { id: 3, name: "김엔지", user_id: 1 },
    tasks: [{ id: 1, task_type: "mixing", amount: 100000, worker_rate: 0, track_title: "곡A", project_id: 9, project_title: "프로젝트A", issued_date: null }],
    sessions: [], supply: 100000, payout: 0, profit: 100000,
  };
  const html = V.revStaffDetail(data);
  assert.doesNotMatch(html, /NaN/, "NaN이 렌더되지 않는다");
  assert.match(html, /발행일 미상/, "안전 문구로 폴백");
});

// [리뷰 지적 4] "월 소계의 합 = 총계" 불변식. groupByMonth를 export해 뷰가 실제로 쓰는 함수의 결과로 검증하고,
// 렌더된 HTML에도 그 소계 금액이 그대로 나타나는지(뷰가 이 함수를 실제로 쓰는지)까지 함께 확인한다.
test("revStaffDetail: 월 소계의 합 = 요약 카드 총 매출·순이익(불변식)", () => {
  const data = {
    manager: { id: 3, name: "김엔지", user_id: 1 },
    tasks: [
      { id: 1, task_type: "mixing", amount: 500000, worker_rate: 0, track_title: "곡A", project_id: 9, project_title: "프로젝트A", issued_date: "2026-07-20" },
      { id: 2, task_type: "mixing", amount: 300000, worker_rate: 0, track_title: "곡B", project_id: 9, project_title: "프로젝트A", issued_date: "2026-06-05" },
    ],
    sessions: [
      { id: 11, session_date: "2026-07-10", session_type: "녹음", amount: 200000, payout: 50000, project_id: 9, project_title: "프로젝트A", issued_date: "2026-07-25" },
    ],
    supply: 1000000, payout: 50000, profit: 950000,
  };
  const items = [
    ...data.tasks.map((t) => ({ ym: String(t.issued_date).slice(0, 7), amount: t.amount, payout: t.worker_rate })),
    ...data.sessions.map((s) => ({ ym: String(s.issued_date).slice(0, 7), amount: s.amount, payout: s.payout })),
  ];
  const groups = V.groupByMonth(items);
  const supplySum = groups.reduce((a, g) => a + g.supply, 0);
  const profitSum = groups.reduce((a, g) => a + (g.supply - g.payout), 0);
  assert.equal(supplySum, data.supply, "월 소계 매출 합 = 총 매출");
  assert.equal(profitSum, data.profit, "월 소계 순이익 합 = 총 순이익");
  // 뷰가 실제로 groupByMonth 결과를 렌더에 쓰는지 — 각 그룹의 소계 금액이 렌더된 HTML에 그대로 나타나야 한다.
  const html = V.revStaffDetail(data);
  groups.forEach((g) => assert.match(html, new RegExp(formatKRW(g.supply).replace(/[₩,]/g, "\\$&")), `그룹(${g.ym}) 소계 ${formatKRW(g.supply)}가 렌더에 등장`));
});
