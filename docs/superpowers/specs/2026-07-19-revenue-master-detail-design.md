# 매출 스탭별·업체개인별 탭 = 마스터-디테일 (설계, 2026-07-19)

> 사용자 승인 완료. 이 문서가 단일 진실원천이며, 같은 날 작성하던 핸드오프 문서(`…-revenue-master-detail-handoff.md`)는 여기에 흡수돼 삭제됐다.

## 목표

`/revenue`의 **스탭별·업체·개인별 두 탭**을 마스터-디테일로 전환한다. 왼쪽 순위 목록에서 항목을 고르면 오른쪽 패널에 그 대상의 기간 상세(스탭=작업·세션 내역, 청구처=발행 청구서)가 뜬다. 개요 탭은 대시보드 그대로 둔다.

**배경**: 직전 커밋(698c596)이 이 두 탭을 읽기 폭(768)으로 좁혔다. 순위 표만 있으니 넓은 폭이 시선만 분산시켰기 때문이다. 사용자 제안은 그 폭을 없애는 대신 **목적 있게 쓰자**는 것 — 빈 오른쪽을 상세 패널로 채운다. 연락처(2026-07-17)·업체그룹(2026-07-18)이 이미 같은 패턴으로 전환돼 있어 골격을 그대로 재사용한다.

## 재사용 조각 (신규 데이터 레이어 0)

| 조각 | 위치 | 용도 |
|---|---|---|
| `contactPanes({left, right, hasSelection, backHref, backLabel})` | `src/views.contacts.js` | 범용 2단 골격. lg 좌우 flex·드래그 폭조절·반응형 |
| `revenueByStaff/ByPayer(period)` | `src/data/revenue.js` | 왼쪽 순위 목록 데이터 |
| `revenueForStaff/ForPayer(id, period)` | `src/data/revenue.js` | 오른쪽 상세 데이터 |
| `revStaffDetail/revPayerDetail(data, period)` | `src/views.revenue.js` | 오른쪽 상세 렌더 |

**데이터 레이어는 한 줄도 바꾸지 않는다.** 확인 결과 `revenueForStaff/ForPayer`는 **대상이 존재하지 않을 때만** null이고, 존재하되 그 기간 실적이 0이면 빈 배열로 정상 반환한다(revenue.js:118·137). 따라서 아래 "기간 변경 시 선택 유지"에서 실적 0인 기간으로 이동해도 이름은 `data.manager.name`/`data.party.name`에서 그대로 나오고, 기존 상세 뷰가 이미 "작업 없음"·"세션 없음"·"이 기간 발행 청구서가 없습니다"를 렌더한다 — 빈 기간 전용 분기가 필요 없다.

## 설계

### 1. 왼쪽 컴팩트 순위 목록 (신규, `src/views.revenue.js`)

기존 `revStaffTable`/`revPayerTable`은 dataTable 전체 표라 2단의 왼쪽엔 넓다. 컴팩트 리스트 2개를 신설한다(연락처 목록 톤·`listGroup`/`listRow` 계열).

- **`revStaffList(rows, {year, month, selId})`** — 행 href = `/revenue?tab=staff&staff=<id>&<periodQS>`. 내용: 이름(+외주 배지) 굵게 / 오른쪽 매출 `formatKRW` / subline `순이익 … · 작업 N · 세션 M`(muted). 빈 배열 → `emptyState("이 기간 매출이 있는 스탭이 없습니다.", {card:true})`.
- **`revPayerList(rows, {year, month, selId})`** — 행 href = `/revenue?tab=payer&payer=<id>&<periodQS>`. 내용: 청구처명 굵게 + 구분 배지(개인/그룹/업체) / 오른쪽 매출 기여 / subline `청구 N건`. 빈 배열 → `emptyState("이 기간 매출이 있는 업체·개인이 없습니다.", {card:true})`.

**선택 행 강조**: `selId`와 일치하는 행에 `aria-current="page"` + `bg-primary/10 font-semibold`. 연락처의 `[data-contact-list] a[aria-current]` CSS는 셀렉터가 달라 적용되지 않으므로 클래스로 직접 준다(전용 셀렉터를 새로 만들지 않는다 — 강조 하나 때문에 CSS 표면을 늘릴 이유가 없다).

**음수 순이익은 `profitCls`로 danger 색**(기존 표에서 계승 — 외주지급>매출인 스탭을 초록으로 칠하면 오독한다).

두 함수를 `module.exports`에 추가한다.

### 2. 라우트 (`src/routes/revenue.routes.js` GET `/`)

`tab === "staff"` 분기:

```js
const selId = Number(req.query.staff) || 0;
const left = revStaffList(revenueByStaff(period), { ...period, selId });
const data = selId ? revenueForStaff(selId, period) : null;
const right = data
  ? `<div class="mb-3">
       <h2 class="text-lg font-bold">${esc(data.manager.name)}</h2>
       <p class="text-sm text-muted">${data.manager.user_id ? "하우스 엔지니어" : "외주 작업자"}</p>
     </div>${revStaffDetail(data, period)}`
  : emptyState("스탭을 선택하세요.", { card: true });
content = contactPanes({
  left, right,
  hasSelection: !!data,
  backHref: `/revenue?tab=staff&${periodQS(period)}`,
  backLabel: "매출",
  widthKey: "revListW",
  heightClass: REV_PANE_H,
});
```

`tab === "payer"`도 같은 구조(`req.query.payer` · `revenueByPayer` · `revPayerList` · `revenueForPayer` · `revPayerDetail`, 빈 문구 `"업체·개인을 선택하세요."`). 상세 헤더는 `data.party.name`.

**이름 헤더를 라우트에서 붙이는 이유**: `revStaffDetail`/`revPayerDetail`은 대상 이름을 렌더하지 않는다(기존엔 드릴다운 페이지의 `pageHeader`가 담당했다). 패널엔 pageHeader가 없으므로 라우트가 채운다.

**유효하지 않은 selId**(삭제된 id 등)는 `data === null`이 되어 자연히 미선택 화면이 된다. **404를 던지지 않는다** — 패널 안이므로 목록은 살아 있어야 한다.

### 3. 레이아웃 폭 — 세 탭 모두 `wide: true`

`layout({ …, wide: true })`로 조건을 제거한다. `contactPanes` 내부가 오른쪽 패널을 `max-w-content`(768)로 감싸므로 **읽기 폭은 그대로 보장**되고, 남는 폭만 상세가 쓴다. 698c596이 걱정한 시선 분산은 해소된 채 유지된다.

698c596이 남긴 주석("스탭별·업체·개인별은 단순 순위 표라 읽기 폭으로")은 **함께 갱신한다**. 사실이 아니게 된 근거 주석을 남기면 다음 사람이 그걸 읽고 되돌린다.

### 4. `contactPanes` 파라미터 2개 추가 (기본값으로 기존 호출부 무변경)

- **`widthKey = "clListW"`** — 목록 폭 localStorage 키. 매출은 `"revListW"`를 넘겨 **연락처·업체그룹과 분리**한다. 연락처는 '이름만' 있는 좁은 목록이고 매출 목록은 이름+금액+건수라 적정 폭이 다르다 — 공유하면 한쪽에 맞춘 폭이 다른 쪽에서 어색해지고, 사용자는 "왜 폭이 혼자 바뀌었지" 하게 된다. 리사이저를 읽는 app.js도 이 키를 속성으로 받아 쓰도록 고친다(현재 하드코딩).
- **`heightClass`** — 패널 고정 높이 클래스. 기본값은 현재 값(`lg:h-[calc(100vh-11rem)]`).

**높이를 파라미터화하는 이유**: 현재 값은 **연락처 화면의 상단 높이**(py-6 + pageHeader + 탭바) 기준으로 하드코딩돼 있다. 매출 화면은 그 위에 `revPeriodControl`(년·월 셀렉트 줄)이 하나 더 있어 더 높다. 그대로 쓰면 패널 하단이 뷰포트를 넘겨 **페이지 전체가 세로 스크롤**되고, 마스터-디테일의 요점("페이지는 안 움직이고 좌·우가 각자 내부 스크롤")이 깨진다.

`REV_PANE_H`의 정확한 값은 **브라우저 실측으로 확정**한다(초안 `lg:h-[calc(100vh-15rem)]`). Tailwind는 소스의 **리터럴만 스캔**하므로 임의값은 반드시 문자열 상수로 존재해야 한다 — 동적 조립 금지(함정 #27 계열).

### 5. 기간 변경 시 선택 유지

`revPeriodControl`에 현재 `staff`/`payer` 선택을 **hidden input으로 실어** GET 폼이 선택을 잃지 않게 한다. 같은 대상을 달별로 비교하는 흐름(김엔지의 7월 → 6월)이 실제로 잦다.

`revPeriodControl({ year, month, years, tab, sel })` — `sel`은 `{ name: "staff"|"payer", id }` 또는 null. 개요 탭은 null.

실적이 0인 기간으로 이동해도 위 "재사용 조각" 항에서 밝힌 대로 이름은 유지되고 상세는 빈 안내를 보여준다.

### 6. 중복 경로 정리

기존 드릴다운 `/revenue/staff/:id`·`/revenue/payer/:id`를 **302 리다이렉트**로 축소하고(기간 쿼리 보존), 개요 Top5 링크(views.revenue.js:109-110)를 패널 URL로 돌린다. 그 결과 소비처가 없어지는 `revStaffTable`·`revPayerTable`은 **삭제**한다.

상세로 가는 길을 하나로 유지하려는 것이다. 연락처에서 '사람 상세가 두 벌'(클라이언트 인라인 편집 + 연락처 읽기 뷰)이 실제로 문제가 됐고, 그 재발을 막는다. 리다이렉트는 북마크·기존 링크 호환용으로만 남긴다.

## 테스트

`test/revenue-views.test.js`의 표 계약 테스트 2건(`revStaffTable`·`revPayerTable`)을 리스트 계약 테스트로 **교체**한다:

- 링크 href에 탭·기간·선택 id가 모두 들어간다
- 선택 행에 `aria-current="page"`가 붙고 비선택 행엔 없다
- 음수 순이익이 danger 색이다(기존 57행 케이스 계승)
- 빈 배열이 `emptyState`다
- **인라인 style이 없다**(기존 revBarChart·revTypeBreakdown 테스트와 같은 계약 — 가드레일 ⑮/함정 #27)

`test/revenue.test.js`(데이터 집계)는 무변경. 연락처·업체그룹이 `contactPanes`를 계속 쓰므로 `test/contacts-views.test.js`가 기본값 회귀(파라미터 추가 후에도 기존 동작 유지)를 잡는지 확인한다.

## 검증 체크리스트 (완료 주장 전 필수)

1. `npm test` 전체 통과.
2. 실브라우저 실측:
   - lg(≥1024) 스탭별 탭에서 **페이지 자체가 세로 스크롤되지 않고** 좌·우가 각자 내부 스크롤 → 4번 `REV_PANE_H` 확정 근거
   - 리사이저 드래그 → 새로고침 후 폭 유지, **연락처 폭은 안 바뀜**(키 분리 확인)
   - <1024: 미선택=목록만 / 선택=상세만 + `← 매출` 백링크
   - 390px 가로 오버플로우 0
3. 기간 변경 후 선택 유지 + 실적 0인 기간에서 이름 유지·빈 안내 표시.
4. 개요 Top5 → 상세 진입 → 백링크가 원래 탭으로 복귀. 구 URL(`/revenue/staff/3`) 302 확인.

## 범위 밖

순이익률(마진%)·입금 기준 매출·다인 세션 분배 귀속(모델 A 유지)은 이번 작업에 포함하지 않는다.
