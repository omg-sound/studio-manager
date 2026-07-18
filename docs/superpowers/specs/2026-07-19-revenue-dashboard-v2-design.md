# 매출 화면 발전(v2) — 넓은 대시보드 + 고급 지표 설계 문서 (2026-07-19)

## 목표

방금 배포한 매출 v1(`/revenue` 탭·기간·순이익)을 **여백을 적극 쓰는 넓은 경영 대시보드**로 발전시킨다. 요약 수준에서 "전문 대시보드"로: 비교 증감, 매출·순이익 2색 추세, 종류별 매출 구성, 세무 참고까지.

v1 스펙: `docs/superpowers/specs/2026-07-19-revenue-analytics-design.md`. 이 문서는 그 위에 얹는 확장이다(v1 결정—매출=공급가·발생 기준, 순이익=매출−외주지급, 다인 세션 모델 A—은 불변).

## 확정 결정 (사용자 합의 2026-07-19)

### A. 넓은 대시보드 레이아웃
- `/revenue` 메인(탭 3개)을 **`layout({wide:true})`**(전 폭, `max-w-wide` 1760)로. 드릴다운(`/revenue/staff|payer/:id`)은 기본 읽기 폭 유지(집중 상세).
- **개요 탭 = 대시보드 그리드**로 재배치:
  - **행 1**: KPI 카드 4장 한 줄(선택 기간 매출·순이익 / 올해 누적 매출·순이익). **비교 증감 배지(B1)는 선택 기간 KPI 2장(매출·순이익)에만** — 올해 누적 2장은 배지 없음(누적 대 누적 비교는 v2 밖, 모호성 회피).
  - **행 2 (2열)**: 좌=**월별 매출·순이익 2색 차트(B3, 크게)** · 우=**세무 참고 카드(B5)**.
  - **행 3 (2열)**: 좌=**종류별 매출 구성(B4)** · 우=**스탭별 매출 + 업체·개인별 매출**(2 서브컬럼, Top N + 전체 보기).
- **스탭별·업체·개인별 탭**도 넓은 폭에서 표를 여유 있게(열 구성 불변, 폭만).

### B1. 비교 증감
- KPI(매출·순이익)에 **전월 대비**·**전년 동월 대비** ▲/▼ %. 월 선택 시 두 비교, **연간(`month=all`) 선택 시 전년(전체) 대비** 하나.
- 전월: 선택 월의 직전 달(1월이면 전년 12월). 전년 동월: 선택 월의 1년 전 같은 달. 연간: 선택 년 −1의 전체.
- 색: 상승=`text-success`, 하락=`text-danger`, 0/비교불가(직전 기간 0)=회색·"—". 표기 예 `전월 ▲12% · 전년 ▲30%`.

### B3. 월별 차트 강화 (매출 + 순이익 2색)
- 개요 월별 차트를 **월당 2색 막대**(매출=연한 primary, 순이익=진한 primary·또는 success)로 — 마진 추세까지. 범례 표기.
- 인라인 SVG(색=CSS 클래스 `fill`, 기하=SVG 속성; 인라인 style 금지·CSP 함정 #27). `revBarChart(monthly)`가 `monthly:[{month, supply, profit}]`를 받아 월당 2막대 렌더.

### B4. 종류별 매출 구성 (작업 + 세션 종류)
- 발행 청구 항목(공급가)을 **작업 종류(task_type) + 세션 종류(session_type) 통합**으로 묶어 종류별 매출·비중.
  - 작업 라인: `invoice_items.task_id → track_tasks.task_type` → `taskTypeLabel(key)` 표시.
  - 세션 라인: `invoice_items.session_id → sessions.session_type`(녹음/믹싱/마스터링/촬영/공연/기타).
- **가로 막대 목록**: 종류명 · 막대(비중 %) · 금액. 비중 내림차순. 막대 = 각 행 인라인 SVG(`<rect width="${pct}">`, viewBox 0~100 단위 = %; 인라인 style 없음). 라벨·금액은 HTML 텍스트(한글·₩ 정상).
- 기간 필터(발행일), `status<>'미발행'`.

### B5. 세무 참고
- 작은 **세무 참고 카드** — 기간(발행일) 기준:
  - **VAT 합계** = Σ`invoices.tax_amount`(발행분, 부가세 예정/확정 신고 참고 — 매출[공급가]과 별개, 현금거래는 0).
  - **외주 원천징수 예상** = 기간 외주지급(worker_rate 합)에 대한 **3.3%**(`lib/tax.js` `withholding33` 재사용 — 소득세 3%·지방소득세 0.3%·각 10원 절사) + **실지급**(외주지급 − 원천세) 병기.
- "참고용" 명시(소액부징수·사업자 외주 예외 미반영 — v1 워커 화면과 동일 문구 톤).

### 명칭
- 개요의 상위 목록 블록: **"스탭별 매출"** · **"업체·개인별 매출"**(v1의 "Top 스탭"/"Top 업체·개인"에서 개명, 사용자 요청). 각 블록 상위 N + "전체 보기 →" 링크 유지.

## 아키텍처

- 데이터: `src/data/revenue.js` — `revenueSummary` 확장(전월·전년 비교 + 월별 순이익) + 신규 `revenueByType({year,month})`·`revenueTax({year,month})`.
- 뷰: `src/views.revenue.js` — `revBarChart` 2-series로 교체, 신규 `revDeltaBadge`·`revTypeBreakdown`·`revTaxCard`, `revOverview` 대시보드 그리드 재배치. KPI 카드가 델타 배지 수용.
- 라우트: `src/routes/revenue.routes.js` — 개요에서 `revenueByType`·`revenueTax` 조회, `layout({wide:true})`.
- 세무: `src/lib/tax.js`(`withholding33`) 재사용.
- 무JS·인라인 SVG·의존성 0. 접근 `requireInvoice` 불변.

## 데이터 함수 (`src/data/revenue.js`)

- `revenueSummary({ year, month })` **확장** → 기존 필드 + `monthly:[{ month, supply, profit }]`(순이익 추가) + `cmp:{ prevPeriodSupply, prevPeriodProfit, prevYearSupply, prevYearProfit, isYear }`. (뷰가 델타 % 계산: `(cur−prev)/prev`, prev=0이면 비교 불가.)
  - 전월/전년 비교 기간 계산은 데이터층에서 `{year,month}` 파생(월: 직전 달·1년 전 같은 달; 연간: 선택 년−1). 각 supply/profit는 기존 supplyIn/payoutIn 재사용.
- `revenueByType({ year, month })` → `[{ label, kind:'task'|'session', amount }]`(amount 내림차순, amount>0). 라벨 = 작업은 `taskTypeLabel(task_type)`·세션은 `session_type`. (뷰가 total 대비 pct 계산.)
- `revenueTax({ year, month })` → `{ vatTotal, payoutTotal, withholding }`. `vatTotal`=Σtax_amount(발행·기간). `payoutTotal`=기간 외주지급(task+session worker_rate — `revenueSummary`의 payoutIn과 동일 산식). `withholding`=`withholding33(payoutTotal)` = `{ gross, incomeTax, localTax, total, net }`(`lib/tax.js` 기존 함수, 반환 형태 확정).

## 뷰 (`src/views.revenue.js`)

- `revBarChart(monthly)` — 월당 **2막대**(supply·profit) + 범례. `monthly[k]={month,supply,profit}`. 색: 매출=`.rev-bar`(primary), 순이익=`.rev-bar-profit`(진한/success). 인라인 style 없음.
- `revDeltaBadge(cur, prev)` — `prev>0`이면 `((cur-prev)/prev*100)` 반올림 + ▲/▼ + 색; `prev<=0`이면 "—"(회색). 작은 배지.
- `revTypeBreakdown(rows)` — 가로 막대 목록(종류명·SVG 막대[width=pct]·금액·비중%). 빈 배열이면 빈 안내.
- `revTaxCard(tax)` — VAT 합계·원천징수 예상(실지급 병기)·참고 문구.
- `revOverview({...})` — 대시보드 그리드(위 A 레이아웃). KPI에 `revDeltaBadge`. 기존 `revStaffTable`/`revPayerTable`/`revBarChart`는 재사용(차트만 2-series 교체).
- 명칭: 개요 블록 "스탭별 매출"·"업체·개인별 매출".

## 렌더/CSS

- `public/css/src.css`: `.rev-bar-profit`(순이익 막대 색), 필요 시 대시보드 그리드는 Tailwind 유틸(`grid`·`sm:grid-cols-*`·`gap`)로. 가로 막대 SVG는 `.rev-bar` 재사용.

## 테스트 (`test/revenue.test.js` · `revenue-views.test.js`)

- `revenueSummary`: monthly에 profit 포함, cmp(전월·전년) 값(선택 월·연간 분기), prev=0 처리.
- `revenueByType`: 작업+세션 종류 통합·라벨·금액·정렬·기간.
- `revenueTax`: vatTotal(Σtax_amount)·원천징수 3.3%(withholding33 연동)·기간.
- 뷰: `revBarChart` 2막대(supply·profit rect 2개/월·범례)·no-inline-style, `revDeltaBadge`(상승/하락/비교불가 3케이스), `revTypeBreakdown`(막대 width=pct·비중), `revTaxCard`, `revOverview` 대시보드 그리드(wide) + 명칭.

## 범위 밖 (v2도 제외)

- 순이익률(마진 %) 열(사용자 미선택).
- 입금(cash) 기준·수금률, 커스텀 기간 범위, CSV 내보내기, 목표 대비.
- 라인 단위 할인 안분(v1 근사 유지).

## 건드리는 파일

`src/data/revenue.js`(확장) · `src/views.revenue.js`(확장·차트 교체·그리드) · `src/routes/revenue.routes.js`(wide·byType·tax 조회) · `public/css/src.css`(순이익 막대 색) · `test/revenue.test.js`·`test/revenue-views.test.js`(확장) · `CLAUDE.md`·`HISTORY.md`(현행화). `src/lib/tax.js`는 읽기만(재사용).
