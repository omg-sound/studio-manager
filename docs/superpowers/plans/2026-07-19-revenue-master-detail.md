# 매출 마스터-디테일 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `/revenue`의 스탭별·업체·개인별 탭을 왼쪽 순위 목록 + 오른쪽 상세 패널의 마스터-디테일로 전환한다.

**Architecture:** 연락처·업체그룹이 쓰는 공용 2단 골격 `contactPanes`를 재사용한다. 선택 상태는 URL 쿼리(`?tab=staff&staff=3`)로만 표현하므로 서버 렌더만으로 동작하고 신규 JS는 없다. 데이터 레이어(`src/data/revenue.js`)는 한 줄도 바꾸지 않는다 — 필요한 조회 함수가 이미 전부 있다.

**Tech Stack:** Node 20 + Express 4(CommonJS), 서버 렌더 HTML, Tailwind CLI, `node:test`.

## Global Constraints

- **브랜치**: `feat/revenue-master-detail`. main에 직접 커밋 금지(main = 자동 배포).
- **의존성 추가 금지.** 테스트 devDep은 jsdom 하나뿐이라는 기존 예외를 유지한다.
- **서버 렌더 인라인 `style=` 금지** — CSP `style-src`에 막혀 조용히 무시된다(함정 #27, 가드레일 ⑮). 치수·레이아웃은 CSS 클래스로.
- **Tailwind 임의값은 소스에 문자열 리터럴로 존재해야 한다.** `content: ["./src/**/*.js", "./public/**/*.{html,js}"]`만 스캔하므로 동적 조립(`` `lg:h-[${x}]` ``)은 클래스가 생성되지 않는다.
- **동적 텍스트는 `esc()` 처리** 후 HTML 조각으로 넘긴다.
- **키보드 핸들러에는 IME 가드**(`if (e.isComposing || e.keyCode === 229) return;`) — 함정 #18. (이 계획에서 keydown을 새로 만들진 않는다.)
- 테스트는 `npm test`로 전체 실행한다.

---

### Task 1: `contactPanes`에 `widthKey`·`heightClass` 파라미터 추가

`contactPanes`는 연락처·업체그룹이 이미 쓰는 공용 골격이다. 기본값을 현재 동작과 동일하게 두어 **기존 호출부를 건드리지 않는다**.

**Files:**
- Modify: `src/views.contacts.js:13-29` (`contactPanes`)
- Modify: `public/js/app.js:3097-3113` (리사이저 IIFE — 하드코딩된 `KEY = "clListW"`)
- Test: `test/contacts-views.test.js`

**Interfaces:**
- Consumes: (없음)
- Produces: `contactPanes({left, right, hasSelection, backHref, backLabel, widthKey = "clListW", heightClass = "lg:h-[calc(100vh-11rem)]"})` → HTML string. 루트 요소에 `data-cl-panes`와 `data-cl-width-key="<widthKey>"`를 렌더한다.

- [ ] **Step 1: 실패하는 테스트를 쓴다**

`test/contacts-views.test.js` 끝에 추가:

```js
test("contactPanes: widthKey 기본값 clListW, 지정하면 그 키를 data 속성으로", () => {
  const def = contactPanes({ left: "L", right: "R", hasSelection: false });
  assert.match(def, /data-cl-width-key="clListW"/, "기본 키 = clListW(연락처·업체그룹 무변경)");
  const rev = contactPanes({ left: "L", right: "R", hasSelection: false, widthKey: "revListW" });
  assert.match(rev, /data-cl-width-key="revListW"/, "지정 키 반영");
});

test("contactPanes: heightClass 기본값 유지 + 지정 시 교체", () => {
  const def = contactPanes({ left: "L", right: "R", hasSelection: false });
  assert.match(def, /lg:h-\[calc\(100vh-11rem\)\]/, "기본 높이 = 연락처 기준");
  const rev = contactPanes({ left: "L", right: "R", hasSelection: false, heightClass: "lg:h-[calc(100vh-15rem)]" });
  assert.match(rev, /lg:h-\[calc\(100vh-15rem\)\]/, "지정 높이 반영");
  assert.ok(!/lg:h-\[calc\(100vh-11rem\)\]/.test(rev), "기본 높이는 함께 남지 않는다");
});
```

- [ ] **Step 2: 실패를 확인한다**

Run: `node --test test/contacts-views.test.js`
Expected: FAIL — `data-cl-width-key` 없음.

- [ ] **Step 3: `contactPanes` 시그니처와 마크업을 고친다**

`src/views.contacts.js`의 함수 선언과 return 첫 줄만 바꾼다(본문 주석·나머지 줄은 그대로):

```js
function contactPanes({ left, right, hasSelection, backHref = "", backLabel = "", widthKey = "clListW", heightClass = "lg:h-[calc(100vh-11rem)]" }) {
```

return의 루트 `<div>`를 다음으로 교체한다:

```js
  return `<div class="cl-panes lg:flex lg:gap-2 ${heightClass}" data-cl-panes data-cl-width-key="${esc(widthKey)}">
```

주석 한 줄을 그 위에 덧붙인다(기존 높이 설명 주석 아래):

```js
  // 높이·폭 저장 키는 화면별로 다를 수 있어 파라미터화(기본값 = 연락처 기준). 매출은 기간 컨트롤 줄이 하나 더 있어 더 낮은 높이를 넘긴다.
```

- [ ] **Step 4: app.js 리사이저가 키를 속성에서 읽게 한다**

`public/js/app.js:3104`의 `var KEY = "clListW", MIN = 180, MAX = 560;`을 다음으로 바꾼다:

```js
  var KEY = panes.getAttribute("data-cl-width-key") || "clListW", MIN = 180, MAX = 560;
```

같은 IIFE 위 주석(3096행 `localStorage에 저장(연락처·업체·그룹 공유)`)을 사실에 맞게 고친다:

```js
// localStorage에 저장(키=data-cl-width-key — 연락처·업체그룹은 clListW 공유, 매출은 revListW로 분리).
```

- [ ] **Step 5: 테스트 통과를 확인한다**

Run: `npm test`
Expected: PASS (전체). 연락처·업체그룹 기존 테스트가 그대로 통과해야 한다 — 기본값 회귀가 이 태스크의 핵심이다.

- [ ] **Step 6: 커밋**

```bash
git add src/views.contacts.js public/js/app.js test/contacts-views.test.js
git commit -m "refactor(panes): contactPanes 폭 저장키·높이 파라미터화(기본값 무변경)"
```

---

### Task 2: 왼쪽 순위 목록 뷰 `revStaffList`·`revPayerList`

**Files:**
- Modify: `src/views.revenue.js` (신규 함수 3개 + exports)
- Test: `test/revenue-views.test.js:50-66` (표 테스트 3건을 리스트 테스트로 교체)

**Interfaces:**
- Consumes: `periodQS`, `profitCls`, `esc`, `formatKRW`, `listGroup`, `emptyState` (모두 `views.revenue.js`가 이미 가진 것)
- Produces:
  - `revStaffList(rows, {year, month, selId = 0})` → HTML. rows = `revenueByStaff()` 결과(`{id, name, is_external, supply, profit, task_cnt, session_cnt}`)
  - `revPayerList(rows, {year, month, selId = 0})` → HTML. rows = `revenueByPayer()` 결과(`{id, kind, name, supply, invoice_cnt}`)

- [ ] **Step 1: 실패하는 테스트를 쓴다**

`test/revenue-views.test.js`의 기존 3개 테스트(`revStaffTable: 매출·순이익…`, `revStaffTable: 음수 순이익…`, `revPayerTable: 업체/개인 배지…`)를 **삭제하고** 다음으로 교체한다:

```js
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
```

- [ ] **Step 2: 실패를 확인한다**

Run: `node --test test/revenue-views.test.js`
Expected: FAIL — `V.revStaffList is not a function`.

- [ ] **Step 3: 세 함수를 구현한다**

`src/views.revenue.js`의 `revPayerTable` 아래(드릴다운 뷰 위)에 추가한다:

```js
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
function revStaffList(rows, { year, month, selId = 0 }) {
  if (!rows.length) return emptyState("이 기간 매출이 있는 스탭이 없습니다.", { card: true });
  const qs = periodQS({ year, month });
  return listGroup({ rows: rows.map((r) => revListRow({
    href: `/revenue?tab=staff&staff=${Number(r.id)}&${qs}`,
    selected: Number(r.id) === Number(selId),
    title: `${esc(r.name)}${r.is_external ? ` <span class="badge badge-neutral">외주</span>` : ""}`,
    right: formatKRW(r.supply),
    sub: `순이익 <span class="${profitCls(r.profit)}">${formatKRW(r.profit)}</span> · 작업 ${r.task_cnt} · 세션 ${r.session_cnt}`,
  })) });
}

// 업체·개인 순위 목록(왼쪽 마스터).
function revPayerList(rows, { year, month, selId = 0 }) {
  if (!rows.length) return emptyState("이 기간 매출이 있는 업체·개인이 없습니다.", { card: true });
  const qs = periodQS({ year, month });
  const kindLabel = (k) => (k === "person" ? "개인" : k === "group" ? "그룹" : "업체");
  return listGroup({ rows: rows.map((r) => revListRow({
    href: `/revenue?tab=payer&payer=${Number(r.id)}&${qs}`,
    selected: Number(r.id) === Number(selId),
    title: `${esc(r.name)} <span class="badge badge-neutral">${kindLabel(r.kind)}</span>`,
    right: formatKRW(r.supply),
    sub: `청구 ${r.invoice_cnt}건`,
  })) });
}
```

- [ ] **Step 4: exports에 추가한다**

`src/views.revenue.js` 마지막 줄의 `module.exports`에 `revStaffList, revPayerList`를 넣는다(`revStaffTable`·`revPayerTable`은 Task 5에서 지우므로 **아직 그대로 둔다**):

```js
module.exports = { revPeriodControl, revTabs, revBarChart, revDeltaBadge, revTypeBreakdown, revTaxCard, revOverview, revStaffTable, revPayerTable, revStaffList, revPayerList, revStaffDetail, revPayerDetail };
```

- [ ] **Step 5: 테스트 통과를 확인한다**

Run: `npm test`
Expected: PASS.

- [ ] **Step 6: 커밋**

```bash
git add src/views.revenue.js test/revenue-views.test.js
git commit -m "feat(revenue): 마스터-디테일 왼쪽 순위 목록 뷰(revStaffList/revPayerList)"
```

---

### Task 3: 기간 폼이 선택을 유지하도록 `revPeriodControl`에 `sel` 추가

기간(년·월)을 바꿔도 보던 스탭/청구처가 유지돼야 한다 — 같은 대상을 달별로 비교하는 흐름이 잦다.

**Files:**
- Modify: `src/views.revenue.js:12-23` (`revPeriodControl`)
- Test: `test/revenue-views.test.js` (기존 `revPeriodControl` 테스트 아래에 추가)

**Interfaces:**
- Consumes: (없음)
- Produces: `revPeriodControl({year, month, years, tab, sel = null})` — `sel`은 `{name: "staff"|"payer", id: number}` 또는 null. null이면 hidden을 렌더하지 않는다.

- [ ] **Step 1: 실패하는 테스트를 쓴다**

`test/revenue-views.test.js`의 `revPeriodControl` 테스트 바로 아래에 추가:

```js
test("revPeriodControl: 선택된 대상을 hidden으로 실어 기간 변경 시 유지", () => {
  const html = V.revPeriodControl({ year: 2026, month: 7, years: [2026], tab: "staff", sel: { name: "staff", id: 3 } });
  assert.match(html, /<input type="hidden" name="staff" value="3"/, "선택 유지 hidden");
  const none = V.revPeriodControl({ year: 2026, month: 7, years: [2026], tab: "overview" });
  assert.ok(!/name="staff"/.test(none) && !/name="payer"/.test(none), "미선택·개요 탭은 hidden 없음");
});
```

- [ ] **Step 2: 실패를 확인한다**

Run: `node --test test/revenue-views.test.js`
Expected: FAIL — hidden 없음.

- [ ] **Step 3: 구현한다**

`src/views.revenue.js`의 `revPeriodControl` 선언을 바꾸고:

```js
function revPeriodControl({ year, month, years, tab, sel = null }) {
```

`mOpts` 계산 아래에 한 줄 추가:

```js
  // 선택된 스탭/청구처를 실어 보낸다 — 기간만 바꾸고 보던 대상은 유지(2026-07-19 사용자 결정).
  const selHidden = sel && sel.id ? `<input type="hidden" name="${esc(sel.name)}" value="${Number(sel.id)}" />` : "";
```

return의 `tab` hidden 바로 아래에 `${selHidden}`을 넣는다:

```js
    <input type="hidden" name="tab" value="${esc(tab)}" />
    ${selHidden}
```

- [ ] **Step 4: 테스트 통과를 확인한다**

Run: `npm test`
Expected: PASS.

- [ ] **Step 5: 커밋**

```bash
git add src/views.revenue.js test/revenue-views.test.js
git commit -m "feat(revenue): 기간 변경 시 선택된 스탭·청구처 유지"
```

---

### Task 4: 라우트를 2단 패널로 전환

**Files:**
- Modify: `src/routes/revenue.routes.js:1-42` (imports + GET `/`)

**Interfaces:**
- Consumes: Task 2의 `revStaffList`/`revPayerList`, Task 3의 `revPeriodControl({sel})`, Task 1의 `contactPanes({widthKey, heightClass})`
- Produces: `/revenue?tab=staff&staff=<id>` · `/revenue?tab=payer&payer=<id>` URL 계약

- [ ] **Step 1: import를 보강한다**

`src/routes/revenue.routes.js` 상단 require 3줄을 다음으로 바꾼다:

```js
const { revPeriodControl, revTabs, revOverview, revStaffList, revPayerList, revStaffDetail, revPayerDetail } = require("../views.revenue");
const { contactPanes } = require("../views.contacts");
const { layout, pageHeader, esc, errorPage, emptyState } = require("../views");
```

(`revStaffTable`·`revPayerTable`은 더 쓰지 않으므로 뺀다. `errorPage`는 Task 5까지 구 드릴다운 라우트가 쓰므로 남긴다.)

- [ ] **Step 2: 패널 높이 상수를 선언한다**

`periodQS` 함수 아래에 추가한다. **Tailwind가 스캔하는 리터럴이어야 하므로 문자열 상수로 둔다**(Global Constraints):

```js
// 패널 고정 높이 = 뷰포트 − 상단(py-6 + pageHeader + 기간 컨트롤 + 탭바). 연락처(11rem)보다 기간 컨트롤 줄만큼 낮다.
// ⚠️ Tailwind는 소스 리터럴만 스캔하므로 동적 조립 금지(함정 #27). 값은 브라우저 실측으로 확정(Task 6).
const REV_PANE_H = "lg:h-[calc(100vh-15rem)]";
```

- [ ] **Step 3: GET `/` 핸들러를 교체한다**

기존 핸들러 전체를 다음으로 바꾼다:

```js
// 매출 메인(탭: 개요/스탭별/업체·개인별). 스탭별·업체개인별은 마스터-디테일(왼쪽 순위 목록 + 오른쪽 상세 패널).
router.get("/", requireInvoice, (req, res) => {
  const period = parsePeriod(req);
  const tab = ["overview", "staff", "payer"].includes(req.query.tab) ? req.query.tab : "overview";
  const years = revenueYears();
  let content;
  let sel = null; // 기간 폼이 유지할 선택(있을 때만)
  if (tab === "staff") {
    const selId = Number(req.query.staff) || 0;
    // 삭제된 id 등 유효하지 않으면 data=null → 미선택 화면. 404를 던지지 않는다(패널 안이라 목록은 살아 있어야 한다).
    const data = selId ? revenueForStaff(selId, period) : null;
    if (data) sel = { name: "staff", id: selId };
    const left = revStaffList(revenueByStaff(period), { ...period, selId: data ? selId : 0 });
    // 상세 뷰는 대상 이름을 렌더하지 않는다(기존엔 드릴다운 페이지의 pageHeader가 담당). 패널엔 pageHeader가 없어 여기서 붙인다.
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
  } else if (tab === "payer") {
    const selId = Number(req.query.payer) || 0;
    const data = selId ? revenueForPayer(selId, period) : null;
    if (data) sel = { name: "payer", id: selId };
    const left = revPayerList(revenueByPayer(period), { ...period, selId: data ? selId : 0 });
    const right = data
      ? `<div class="mb-3">
           <h2 class="text-lg font-bold">${esc(data.party.name)}</h2>
           <p class="text-sm text-muted">이 청구처의 기간 매출 기여(공급가).</p>
         </div>${revPayerDetail(data, period)}`
      : emptyState("업체·개인을 선택하세요.", { card: true });
    content = contactPanes({
      left, right,
      hasSelection: !!data,
      backHref: `/revenue?tab=payer&${periodQS(period)}`,
      backLabel: "매출",
      widthKey: "revListW",
      heightClass: REV_PANE_H,
    });
  } else {
    const summary = revenueSummary(period);
    const topStaff = revenueByStaff(period).slice(0, 5);
    const topPayer = revenueByPayer(period).slice(0, 5);
    content = revOverview({ summary, topStaff, topPayer, byType: revenueByType(period), tax: revenueTax(period), ...period });
  }
  const body = `
    ${pageHeader({ title: "매출", desc: "공급가(VAT 제외)·발행일 기준. 순이익 = 매출 − 외주 지급." })}
    ${revPeriodControl({ ...period, years, tab, sel })}
    ${revTabs({ tab, ...period })}
    <div class="mt-4">${content}</div>`;
  // 세 탭 모두 넓게. 스탭별·업체개인별은 마스터-디테일이라 남는 폭을 상세 패널이 쓴다(contactPanes 내부가
  // 오른쪽을 max-w-content로 감싸 읽기 폭은 그대로 보장 — 2026-07-19, 698c596의 읽기 폭 결정을 대체).
  res.send(layout({ title: "매출", user: req.user, current: "/revenue", body, wide: true }));
});
```

- [ ] **Step 4: 서버를 띄워 눈으로 확인한다**

```bash
pkill -f "src/server.js" ; DEV_LOGIN=1 node src/server.js &
```

(함정 #5 — 이전 세션의 유휴 서버가 포트를 잡고 옛 코드로 응답할 수 있으므로 반드시 먼저 정리한다.)

브라우저에서 `/revenue?tab=staff` → 왼쪽 목록만·오른쪽 "스탭을 선택하세요", 항목 클릭 → 오른쪽에 이름 + 상세.

- [ ] **Step 5: 테스트 전체 통과를 확인한다**

Run: `npm test`
Expected: PASS. 스모크 테스트가 `/revenue`를 200으로 확인한다.

- [ ] **Step 6: 커밋**

```bash
git add src/routes/revenue.routes.js
git commit -m "feat(revenue): 스탭별·업체개인별 탭 마스터-디테일 전환"
```

---

### Task 5: 중복 경로 제거 — 구 드릴다운 302, 표 뷰 삭제

상세로 가는 길을 하나로 만든다. 연락처에서 '사람 상세가 두 벌'이 실제로 문제가 됐고 그 재발을 막는다.

**Files:**
- Modify: `src/views.revenue.js:109-110` (개요 Top5 링크), `src/views.revenue.js:119-166` (`revStaffTable`·`revPayerTable` 삭제), exports
- Modify: `src/routes/revenue.routes.js` (구 드릴다운 라우트 2개 → 302)
- Test: `test/revenue-views.test.js` (개요 링크 계약)

**Interfaces:**
- Consumes: Task 4의 URL 계약
- Produces: `/revenue/staff/:id`·`/revenue/payer/:id`는 302 리다이렉트로만 존재. `revStaffTable`·`revPayerTable`은 더 이상 export되지 않는다.

- [ ] **Step 1: 실패하는 테스트를 쓴다**

`test/revenue-views.test.js`의 `revOverview` 테스트 아래에 추가:

```js
test("revOverview: Top5 링크는 패널 URL(구 드릴다운 경로 아님)", () => {
  const summary = { periodSupply: 0, periodProfit: 0, ytdSupply: 0, ytdProfit: 0, monthly: Array.from({length:12},(_,k)=>({month:k+1,supply:0,profit:0})), cmp: { isYear: false, prevPeriodSupply: 0, prevPeriodProfit: 0, prevYearSupply: 0, prevYearProfit: 0 } };
  const html = V.revOverview({
    summary,
    topStaff: [{ id: 3, name: "김엔지", supply: 100 }],
    topPayer: [{ id: 5, name: "도너츠컬처", supply: 100 }],
    byType: [], tax: { vatTotal: 0, payoutTotal: 0, withholding: { total: 0, net: 0 } },
    year: 2026, month: 7,
  });
  // 개요의 mini()는 href를 esc 없이 그대로 넣으므로 여기선 & 가 raw다(revStaffList의 &amp;와 다름 — 둘 다 유효).
  assert.match(html, /\/revenue\?tab=staff&staff=3&/, "스탭 Top5 → 패널 URL");
  assert.match(html, /\/revenue\?tab=payer&payer=5&/, "청구처 Top5 → 패널 URL");
  assert.ok(!/href="\/revenue\/staff\//.test(html), "구 드릴다운 경로 링크 없음");
});

test("revStaffTable/revPayerTable: 제거됨(상세 경로 단일화)", () => {
  assert.equal(V.revStaffTable, undefined);
  assert.equal(V.revPayerTable, undefined);
});
```

- [ ] **Step 2: 실패를 확인한다**

Run: `node --test test/revenue-views.test.js`
Expected: FAIL — 구 링크가 남아 있고 표 함수가 아직 export된다.

- [ ] **Step 3: 개요 Top5 링크를 패널 URL로 바꾼다**

`src/views.revenue.js:109-110`의 `mini(...)` 첫 인자 뒤 `hrefFn`을 각각 교체한다:

```js
    <div><h2 class="mb-2 text-sm font-semibold text-muted">스탭별 매출</h2><div class="card p-0 overflow-hidden divide-y divide-border">${mini(topStaff, (r) => `/revenue?tab=staff&staff=${r.id}&${qs}`, `/revenue?tab=staff&${qs}`, "전체 보기")}</div></div>
    <div><h2 class="mb-2 text-sm font-semibold text-muted">업체·개인별 매출</h2><div class="card p-0 overflow-hidden divide-y divide-border">${mini(topPayer, (r) => `/revenue?tab=payer&payer=${r.id}&${qs}`, `/revenue?tab=payer&${qs}`, "전체 보기")}</div></div>
```

- [ ] **Step 4: 표 뷰 2개를 삭제한다**

`src/views.revenue.js`에서 `// 스탭 순위 표.` 주석부터 `revPayerTable` 함수 닫는 괄호까지(현재 119~166행)를 통째로 지운다. `module.exports`에서도 `revStaffTable, revPayerTable`을 뺀다:

```js
module.exports = { revPeriodControl, revTabs, revBarChart, revDeltaBadge, revTypeBreakdown, revTaxCard, revOverview, revStaffList, revPayerList, revStaffDetail, revPayerDetail };
```

`dataTable`·`listGroup`·`listRow` import는 **지우지 않는다** — `revPayerDetail`이 `dataTable`을, `revStaffDetail`이 `listGroup`/`listRow`를 계속 쓴다.

- [ ] **Step 5: 구 드릴다운 라우트를 302로 축소한다**

`src/routes/revenue.routes.js`의 `router.get("/staff/:id", ...)`와 `router.get("/payer/:id", ...)` 두 핸들러 전체를 다음으로 교체한다:

```js
// 구 드릴다운 경로 → 패널 URL 302(북마크·기존 링크 호환). 상세로 가는 길은 하나로 유지한다.
router.get("/staff/:id", requireInvoice, (req, res) => {
  res.redirect(302, `/revenue?tab=staff&staff=${Number(req.params.id)}&${periodQS(parsePeriod(req))}`);
});
router.get("/payer/:id", requireInvoice, (req, res) => {
  res.redirect(302, `/revenue?tab=payer&payer=${Number(req.params.id)}&${periodQS(parsePeriod(req))}`);
});
```

이제 `errorPage`를 쓰지 않으므로 상단 require에서 뺀다:

```js
const { layout, pageHeader, esc, emptyState } = require("../views");
```

- [ ] **Step 6: 테스트 통과를 확인한다**

Run: `npm test`
Expected: PASS. 스모크 테스트가 `/revenue/staff/:id`를 200 기대로 확인하고 있다면 302로 바뀌어 실패할 수 있다 — 그 경우 스모크의 기대값을 302로 고치고(리다이렉트가 의도된 계약), 왜 바뀌었는지 한 줄 주석을 남긴다.

- [ ] **Step 7: 커밋**

```bash
git add src/views.revenue.js src/routes/revenue.routes.js test/revenue-views.test.js
git commit -m "refactor(revenue): 구 드릴다운 302로 축소·순위 표 뷰 삭제(상세 경로 단일화)"
```

---

### Task 6: 패널 높이 실측 확정 + 전체 검증

`REV_PANE_H`는 계산이 아니라 **실측**으로 정한다.

**Files:**
- Modify: `src/routes/revenue.routes.js` (`REV_PANE_H` 값 확정)
- Modify: `CLAUDE.md`, `WORKFLOW.md` (현행화 — 프로젝트 필수 규칙)

- [ ] **Step 1: CSS를 빌드하고 서버를 띄운다**

```bash
pkill -f "src/server.js" ; npm run build:css && DEV_LOGIN=1 node src/server.js &
```

- [ ] **Step 2: 페이지 세로 스크롤이 0인지 실측한다**

`/revenue?tab=staff&staff=<존재하는 id>`를 lg 폭(≥1024)으로 열고 DevTools 콘솔에서:

```js
document.documentElement.scrollHeight - document.documentElement.clientHeight
```

Expected: `0` (페이지 자체는 스크롤되지 않는다). 양수면 그 값만큼 `REV_PANE_H`의 뺄셈 값을 키우고(`15rem` → `16rem` …) `npm run build:css` 후 재측정한다. **Tailwind가 생성하도록 소스의 리터럴을 고쳐야 한다** — DevTools에서 클래스만 바꿔 맞추면 안 된다.

- [ ] **Step 3: 나머지 검증 항목을 실측한다**

- 왼쪽 목록·오른쪽 상세가 각자 내부 스크롤된다
- 리사이저 드래그 → 새로고침 후 폭 유지 → **`/contacts`의 폭은 안 바뀐다**(키 분리 확인). 콘솔에서 `localStorage.revListW`와 `localStorage.clListW`가 별개인지 본다
- 기간을 다른 달로 바꿔도 선택이 유지되고, 실적 0인 달이면 이름은 남고 "작업 없음"·"세션 없음"이 뜬다
- `<1024`: 미선택=목록만 / 선택=상세만 + `← 매출` 백링크
- 390px 폭에서 가로 오버플로우 0:
  ```js
  document.documentElement.scrollWidth - document.documentElement.clientWidth
  ```
  Expected: `0`
- 개요 Top5 클릭 → 해당 항목이 선택된 패널로 이동
- 구 URL `/revenue/staff/3` → 302로 패널 URL 이동

- [ ] **Step 4: 전체 테스트를 돌린다**

Run: `npm test`
Expected: PASS (전체).

- [ ] **Step 5: 문서를 현행화한다**

`CLAUDE.md`의 매출 현황 섹션에서 다음을 갱신한다:
- 스탭별·업체·개인별 탭이 마스터-디테일이라는 것, 선택은 URL 쿼리(`?tab=staff&staff=<id>`)
- 세 탭 모두 `wide:true`(직전의 "스탭별·업체개인별은 읽기 폭" 서술을 대체 — **옛 서술을 남기면 다음 사람이 되돌린다**)
- 목록 폭 저장키가 `revListW`로 분리된 것
- 구 드릴다운 경로는 302 리다이렉트만 남았다는 것

`WORKFLOW.md`도 현재 작업 상태에 맞게 갱신한다.

- [ ] **Step 6: 커밋**

```bash
git add src/routes/revenue.routes.js CLAUDE.md WORKFLOW.md
git commit -m "docs: 매출 마스터-디테일 현행화 + 패널 높이 실측 확정"
```

- [ ] **Step 7: 브랜치를 푸시한다**

```bash
git push -u origin feat/revenue-master-detail
```

main 병합은 사용자 확인 후 별도로 한다(main = 자동 배포).
