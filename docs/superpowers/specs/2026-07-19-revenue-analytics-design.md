# 매출 섹션 고도화 — 설계 문서 (2026-07-19)

## 목표

현재 `/revenue`는 **담당 엔지니어별 전체기간 합계 목록**뿐이다. 이를 **기간(년·월)·축(스탭 / 업체·개인)·순이익**까지 보는 "현황 파악" 도구로 확장한다. 대표·치프가 "이번 달/올해 스튜디오가 얼마 벌었나", "누가 매출을 냈나", "어느 업체·개인이 매출에 얼마 기여했나", "실제로 얼마 남겼나(순이익)"를 한 화면에서 파악한다.

정체성: 경량 버티컬 ERP의 **회계/재무 모듈 강화**. 대형 BI를 흉내 내지 않는다(가장 가벼운 경로).

## 배경 — 현재 상태

- `src/data/revenue.js`: `revenueByEngineer()`(엔지니어별 합계, total>0 내림차순) · `revenueForEngineer(id)`(엔지니어 상세: 작업+세션 내역).
- `src/routes/revenue.routes.js`: `/revenue`(엔지니어 목록) · `/revenue/:id`(상세). 접근 = `requireInvoice`(대표·치프).
- 매출 집계 = **실제 청구된 것만**: 작업 `track_tasks.is_invoiced=1`의 `total_price`, 세션 `invoice_items` 스냅샷(`amount`). 담당 귀속 = 작업 `engineer_id`·세션 `engineer_name`.
- **없는 것**: 시간축(기간), 결제자(업체·개인)축, 순이익(외주 지급 차감), 추세.

데이터 재료(전부 존재): `invoices`(payer_id → parties, amount, tax_amount, discount_amount, status, issued_date) · `invoice_items`(invoice_id, task_id, session_id, amount) · `track_tasks`(engineer_id, total_price, worker_rate, is_invoiced) · `sessions`(engineer_name) · `session_engineers`(manager_id, worker_rate) · `parties`(kind: person/company/group).

## 확정 결정 (사용자 합의 2026-07-19)

### D1. 매출 정의 = 공급가액(VAT 제외), 발생(발행) 기준
- **발생 기준**: 발행된 청구서(`status <> '미발행'`)를 **발행일(`issued_date`)**로 기간에 귀속. 입금 여부 무관.
- **공급가액(VAT 제외)**: 매출 = `공급가 = amount − tax_amount`(청구서 단위, 할인 반영된 과세표준). VAT는 매출이 아니라 나라에 낼 부채라 제외. 세무상 매출액과 일치.

### D2. 순이익 = 매출 − 외주 지급(worker_rate)
- 순이익 = 매출(공급가) − 외주 지급단가 합계. 외주 지급 = 그 청구에 든 작업 `track_tasks.worker_rate` + 세션 `session_engineers.worker_rate`. 같은 청구서의 issued_date로 기간 귀속.
- 하우스 엔지니어는 worker_rate=0 → 매출≈순이익. 외주 비중 큰 작업만 마진이 드러난다.
- **다인(多人) 세션 귀속 = 모델 A(리드 귀속, 2026-07-19 사용자 확정)**: 한 세션에 엔지니어가 여러 명이면(session_engineers 다대다), 세션 **매출**은 리드(`sessions.engineer_name`=첫 엔지니어)에게 전액 귀속되고 세션 **외주지급도 그 세션 전체(Σ session_engineers.worker_rate)를 리드에게** 귀속한다(매출·비용을 리드가 함께 안아 세션 마진이 리드에게 일관 귀속). 공동 엔지니어는 그 세션에 별도 행으로 나타나지 않는다. **총 순이익(revenueSummary)은 정확**(세션 외주지급을 한 번만 합산 — 스탭 축 귀속과 무관). 대안(각자 본인 지급만·모델 B)은 매출 없는 마이너스 마진 행이 생겨 기각. 스탭별 표는 세션 마진이 리드에게 몰린다는 참고를 명시.
- **v1 근사**: worker_rate 자체의 원천징수(3.3%)·VAT는 무시(지급단가 그대로 차감). 실제 지급·정산은 `/workers`가 담당. 매출 화면의 순이익은 **마진 파악용 지표**.

### D3. 청구 화면 카드 개명 ('매출' → '발행액')
- 현재 `/invoices` 상단 카드 "이번 달 매출 / 올해 매출"은 실제로 **VAT 포함 발행액**(`inv.amount`). 이름을 **"이번 달 발행액 / 올해 발행액"**으로 바꾼다(VAT 포함 유지).
- 결과: "매출"(공급가)이라는 단어는 **매출 화면에만**, 청구 화면은 **발행액·입금·미수(전부 VAT 포함)** = 돈의 흐름. 역할이 갈린다. `/invoices` '미수금 합계' 카드는 그대로.
- 청구=거래액(VAT 포함, 실제 통장 금액), 매출=공급가(VAT 제외, 실제 번 돈)로 **의도적으로 분리**(회계 표준).

### D4. 접근 권한
- `requireInvoice`(대표·치프) 유지. 스태프 접근 없음.

## 아키텍처

- **데이터**: `src/data/revenue.js` 확장(기존 함수는 새 구조로 대체·기간 인자 추가).
- **뷰**: `src/views.revenue.js` 신설(매출 전용 렌더 — KPI·바 차트·순위 표·상세). `views.js`가 커서 도메인 분리.
- **라우트**: `src/routes/revenue.routes.js` 확장(탭·기간 쿼리·드릴다운 2종).
- **의존성 0**: 외부 차트 라이브러리 없음 — **CSS 바 차트**(div width %). 서버 렌더 + 최소 JS(기간 셀렉트는 무JS `<form>` GET, 또는 select onchange 없이 제출 버튼/링크).

## 컴포넌트

### 1. 기간 컨트롤 (전 탭 공통, 상단)
- **년 ▾ · 월 ▾** 셀렉트. 월에 **"전체(연간)"** 옵션 포함.
- 쿼리 파라미터 `?year=YYYY&month=MM`(month=`all`이면 연간). 기본 = 현재 년·월.
- 무JS: `<form method="get">` + 셀렉트 + "보기" 버튼(또는 각 옵션이 링크). 탭 전환 시 기간 유지(탭 링크에 year·month 보존).
- 년 목록 = 청구서가 존재하는 년들(min~max issued_date 년, 없으면 올해).

### 2. 개요 탭 (`?tab=overview`, 기본)
- **KPI 카드 4개**(2×2 또는 flex): [선택 기간] 매출 · 순이익 / [올해 누적] 매출 · 순이익. (선택 월=특정 월이면 그 월, month=all이면 선택 년 전체. 올해 누적 = 현재 년 기준 YTD.)
- **월별 추세 바 차트**: 선택 년의 12개월 매출(공급가). CSS 가로/세로 바(각 월 `width`/`height` = 월매출/최대월 %). 무JS. 각 바에 월·금액 라벨(hover title).
- **Top 5 스탭** + **Top 5 업체·개인**: 각각 이름·매출(·순이익)·미니 바. 각 섹션에 "전체 보기"(→ 해당 탭) 링크. 0건이면 빈 안내.

### 3. 스탭별 탭 (`?tab=staff`)
- **엔지니어 순위 표**(`dataTable`): 이름(하우스/외주 배지) · 매출 · 순이익 · 작업 건수 · 세션 건수. 선택 기간 적용, 매출 내림차순. 매출 0인 스탭 제외.
- 행 클릭 → `/revenue/staff/:id`(기간 쿼리 보존).
- **드릴다운 `/revenue/staff/:id`**: 기존 `revenueForEngineer` 상세를 **기간·순이익** 반영해 강화 — 요약(매출·외주지급·순이익) + 작업 내역 + 세션 내역(각 프로젝트 링크). 기간 밖은 제외.

### 4. 업체·개인별 탭 (`?tab=payer`)
- **결제자 순위 표**(`dataTable`): 청구처명(업체/개인 배지) · 매출 기여 · 청구 건수 · (선택) 미수 힌트. 선택 기간 적용, 매출 내림차순.
- 행 클릭 → `/revenue/payer/:id`(기간 보존).
- **드릴다운 `/revenue/payer/:id`**: 그 업체·개인이 낸 **기간 내 발행 청구서 목록**(발행일·청구번호·청구·공급가·상태) + 합계. `clientBillingSection`과 유사하나 **공급가 기준·기간 스코프**. 청구서로 새 탭 링크(업체·연락처 상세와 동일 규칙).

## 데이터 함수 (`src/data/revenue.js`)

기간 인자 `{ year, month }`(month=`"all"` | 1~12). 내부적으로 issued_date 범위(`YYYY-MM-01` ~ 말일, 또는 연간 `YYYY-01-01`~`YYYY-12-31`)로 필터. 전부 `status <> '미발행'`.

- `revenueSummary({ year, month })` → `{ periodSupply, periodProfit, ytdSupply, ytdProfit, monthly: [{ month:1..12, supply }] }`.
  - `periodSupply` = Σ(청구서 공급가 `amount − tax_amount`) in 기간.
  - `periodProfit` = periodSupply − Σ(외주지급 in 기간).
  - `monthly` = 선택 년 12개월 각 공급가(추세 차트).
- `revenueByStaff({ year, month })` → `[{ id, name, is_external, supply, profit, task_cnt, session_cnt }]`(supply 내림차순, supply>0).
  - 스탭 귀속은 **청구 항목(invoice_items) 라인** 기준: task_id→track_tasks.engineer_id, session_id→sessions.engineer_name. 부모 청구서 issued_date로 기간 필터.
  - 스탭 순이익 = 스탭 매출 − 스탭 외주지급(그 스탭의 worker_rate 합).
- `revenueByPayer({ year, month })` → `[{ id, name, kind, supply, invoice_cnt }]`(supply 내림차순).
  - 청구서를 payer_id로 그룹, 공급가 합·건수. kind로 업체/개인 배지.
- `revenueForStaff(id, { year, month })` → `{ manager, supply, payout, profit, tasks[], sessions[] }` 또는 null.
- `revenueForPayer(id, { year, month })` → `{ party, supply, invoice_cnt, invoices[] }` 또는 null.

### 집계 정합 주의 (v1 근사)
- **총계·업체별 = 청구서 단위 공급가**(할인 반영·post-discount, 정확). **스탭별 = 청구 항목 라인 금액**(할인 반영 전·pre-discount). 청구서 단위 할인이 있으면 **스탭별 라인 합이 청구서 공급가보다 할인액만큼 클 수 있다**(스탭 합 ≠ 총 매출). 할인은 드물어 v1 근사 허용, 향후 라인 안분 검토. 스펙·화면에 이 기준을 명시(개요 Top 스탭은 참고용).
- 라인 금액(`invoice_items.amount`)은 VAT 이전 공급가라 스탭 축도 공급가 정합.

## 청구 화면 카드 개명 (D3)

- `src/routes/invoices.routes.js`의 overview strip: `statCard("이번 달 매출 …")` → `"이번 달 발행액 …"`, `"올해 매출 …"` → `"올해 발행액 …"`. 값(`thisMonthIssued`/`thisYearIssued` = VAT 포함 `inv.amount` 합)은 불변, 라벨만.
- `invoice-list.test.js`(있으면 라벨 검사) 갱신.

## 렌더 (`src/views.revenue.js`)

- `tabBar`(개요/스탭별/업체·개인별) · KPI `statCard`(청구 overview와 동일 톤) · `dataTable`(순위 표) · **`revBarChart(months)`**(월별 추세) · 기간 셀렉트(`<form>` GET, 무JS).
- **레이아웃 = 기본 읽기 폭**(`layout()` 기본, `max-w-content` 768 — 앱 전반 '시선 분산' 선호와 통일). 순위 표(스탭 5열·업체 4열)·KPI·차트 모두 768에서 무리 없음. wide 미사용.
- **월별 추세 = 인라인 SVG 바 차트**: 동적 높이(월매출/최대월 %)를 인라인 `style`로 줄 수 없다(CSP style-src·함정 #27). `<div>`+동적 Tailwind 임의값도 스캔 불가. → **뷰 내 인라인 SVG**(`<rect height=…>` 속성은 CSP style-src 무관, 청구서 PDF가 이미 SVG 사용 — 패턴 존재)로 그린다. `revBarChart(months)`가 SVG 문자열 반환(막대·월 라벨·금액 title). 색은 `currentColor`/토큰 클래스로 팔레트 적응.

## 테스트 (`test/revenue.test.js`)

- 기간 필터: 특정 월/연간/빈 기간(0원).
- 매출=공급가(amount−tax_amount) 검증(VAT 포함 총액과 구분).
- 축별 집계: 스탭 귀속(작업 engineer_id·세션 engineer_name)·업체 귀속(payer_id)·kind 배지.
- 순이익 = 매출 − worker_rate.
- 발생 기준(issued_date, 미발행 제외).
- 개요 monthly 추세 배열(12개월).
- (계약) 청구 카드 '발행액' 라벨.

## 범위 밖 / TODO

- 입금(cash) 기준 매출·수금률·회수기간 분석 — 발생 기준만(사용자 결정).
- 라인 단위 할인 안분(v1은 청구서 단위 할인 근사).
- 원천징수·VAT 반영한 정밀 순이익(정산은 `/workers`).
- CSV/엑셀 내보내기, 커스텀 기간 범위(년·월 선택만).
- 목표 대비·전년 동월 비교 등 고급 BI(향후).

## 건드리는 파일

- `src/data/revenue.js`(확장) · `src/views.revenue.js`(신설) · `src/routes/revenue.routes.js`(확장) · `src/routes/invoices.routes.js`(카드 라벨) · `public/css/src.css`(바 차트, 필요 시) · `test/revenue.test.js`(신설) · `test/invoice-list.test.js`(라벨, 필요 시) · `CLAUDE.md`/`WORKFLOW.md`(현행화).
