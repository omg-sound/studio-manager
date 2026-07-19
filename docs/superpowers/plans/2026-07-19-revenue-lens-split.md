# 매출 기간 렌즈 분리 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `/revenue`에서 기간 컨트롤을 개요 탭에만 두고, 스탭별·업체개인별 탭은 기간 없이 전체 누적으로 보되 상세를 월별로 끊어 보여준다.

**Architecture:** 데이터 레이어에 '전체 기간' 모드와 '최근 거래월'을 더하고, 월별 그룹은 뷰에서 묶는다(데이터는 이미 발행일 내림차순). 개요는 그 기간 기여자 전체를 `<details>` 펼침으로 품어 "이번 달 누가 기여했나"를 흡수한다.

**Tech Stack:** Node ≥20 + Express 4(CommonJS), 서버 렌더 HTML, Tailwind CLI, SQLite, `node:test`.

## Global Constraints

- **브랜치에서 작업한다.** main 커밋 = 자동 배포이므로 중간 상태를 main에 올리지 않는다.
- **의존성 추가 금지.** 테스트 devDep은 jsdom 하나가 유일한 예외.
- **서버 렌더 인라인 `style=` 금지** — CSP `style-src`에 막혀 조용히 무시된다(함정 #27, 가드레일 ⑮). 치수·레이아웃은 CSS 클래스로.
- **Tailwind 임의값은 소스에 문자열 리터럴로** 존재해야 클래스가 생성된다(동적 조립 금지).
- **동적 텍스트는 `esc()` 처리.** `esc()`는 `&`→`&amp;`.
- **무JS 동작 유지** — 펼침은 네이티브 `<details>`를 쓴다(인라인 스크립트 0).
- **매출 정의 불변**: 매출 = 공급가(`amount − tax_amount`)·발행일 기준(`status <> '미발행' AND issued_date IS NOT NULL`), 순이익 = 매출 − 외주지급. 다인 세션은 **모델 A(리드 귀속)** 유지.
- 테스트는 `npm test`로 전체 실행한다.

---

### Task 1: 데이터 — 전체 기간 모드 + 최근 거래월

**Files:**
- Modify: `src/data/revenue.js` (`issuedInPeriodSql`, `revenueByStaff`, `revenueByPayer`)
- Test: `test/revenue.test.js`

**Interfaces:**
- Consumes: (없음)
- Produces:
  - `issuedInPeriodSql(alias, period)` — `period`가 `undefined`/`null`이거나 `period.year`가 없거나 `"all"`이면 `"1=1"`(전체 기간). 기존 년·월 동작은 불변.
  - `revenueByStaff(period)` 행에 `last_issued`(`"YYYY-MM-DD"` 또는 `null`) 추가. 기존 필드(`id,name,is_external,supply,profit,task_cnt,session_cnt`) 불변.
  - `revenueByPayer(period)` 행에 `last_issued` 추가. 기존 필드(`id,kind,name,supply,invoice_cnt`) 불변.
  - 두 함수 모두 `period` 없이 호출 가능(`revenueByPayer()`).

- [ ] **Step 1: 실패하는 테스트를 쓴다**

`test/revenue.test.js` 끝에 추가한다. 이 파일은 이미 `const D = require("../src/data")`와 `const { db } = require("../src/db")`를 갖고 있고, 데이터는 인라인 INSERT로 만드는 스타일이다(기존 `seedInvoice`는 호출마다 **새 청구처**를 만들므로 아래처럼 같은 청구처 2건은 직접 넣는다).

```js
test("issuedInPeriodSql: 전체 기간 모드(년 없음/all) = 조건 없음", () => {
  const { issuedInPeriodSql } = require("../src/data/revenue");
  assert.equal(issuedInPeriodSql("i", undefined), "1=1");
  assert.equal(issuedInPeriodSql("i", {}), "1=1");
  assert.equal(issuedInPeriodSql("i", { year: "all" }), "1=1");
  assert.equal(issuedInPeriodSql("i", { year: 2026, month: "all" }), "substr(i.issued_date,1,4) = '2026'");
  assert.equal(issuedInPeriodSql("i", { year: 2026, month: 7 }), "substr(i.issued_date,1,7) = '2026-07'");
});

test("revenueByPayer: 기간 없이 호출하면 전 기간 누적 + last_issued(최근 발행일)", () => {
  const payer = db().prepare("INSERT INTO parties (kind, name) VALUES ('company', ?)").run("누적테스트사").lastInsertRowid;
  const proj = db().prepare("INSERT INTO projects (title, project_type, rate) VALUES ('AP', 'task', 0)").run().lastInsertRowid;
  const mk = (issued, amount, tax) => db()
    .prepare("INSERT INTO invoices (project_id, payer_id, title, amount, tax_amount, status, issued_date) VALUES (?, ?, 'AT', ?, ?, '발행', ?)")
    .run(proj, payer, amount, tax, issued);
  mk("2025-03-10", 1100000, 100000); // 공급가 100만
  mk("2026-06-18", 2200000, 200000); // 공급가 200만

  const all = D.revenueByPayer().find((r) => r.id === payer);
  assert.equal(all.supply, 3000000, "전 기간 누적 공급가");
  assert.equal(all.invoice_cnt, 2);
  assert.equal(all.last_issued, "2026-06-18", "최근 발행일 = 두 건 중 최신");
  const y2025 = D.revenueByPayer({ year: 2025, month: "all" }).find((r) => r.id === payer);
  assert.equal(y2025.supply, 1000000, "연도 필터는 그대로 동작");
});

test("revenueByStaff: last_issued = 작업·세션 중 최신 발행일", () => {
  const payer = db().prepare("INSERT INTO parties (kind, name) VALUES ('company', ?)").run("스탭최근사").lastInsertRowid;
  const proj = db().prepare("INSERT INTO projects (title, project_type, rate) VALUES ('SL', 'task', 0)").run().lastInsertRowid;
  const mgr = db().prepare("INSERT INTO project_managers (name) VALUES ('최근엔지')").run().lastInsertRowid;
  // 작업 라인(발행 2026-02-01)
  const tr = db().prepare("INSERT INTO project_tracks (project_id, title, content_type) VALUES (?, '곡', 'Music')").run(proj).lastInsertRowid;
  const task = db().prepare("INSERT INTO track_tasks (track_id, task_type, billing_type, quantity, unit_price, total_price, status, is_invoiced, engineer_id, worker_rate) VALUES (?, 'Mixing', 'Fixed_Per_Track', 1, 100000, 100000, 'Completed', 1, ?, 0)").run(tr, mgr).lastInsertRowid;
  const inv1 = db().prepare("INSERT INTO invoices (project_id, payer_id, title, amount, tax_amount, status, issued_date) VALUES (?, ?, 'S1', 110000, 10000, '발행', '2026-02-01')").run(proj, payer).lastInsertRowid;
  db().prepare("INSERT INTO invoice_items (invoice_id, task_id, description, quantity, unit_price, amount) VALUES (?, ?, 'Mixing', 1, 100000, 100000)").run(inv1, task);
  // 세션 라인(발행 2026-09-09) — 이쪽이 더 최신
  const sess = db().prepare("INSERT INTO sessions (project_id, session_type, session_date, engineer_name, status) VALUES (?, '녹음', '2026-09-09', '최근엔지', '완료')").run(proj).lastInsertRowid;
  const inv2 = db().prepare("INSERT INTO invoices (project_id, payer_id, title, amount, tax_amount, status, issued_date) VALUES (?, ?, 'S2', 220000, 20000, '발행', '2026-09-09')").run(proj, payer).lastInsertRowid;
  db().prepare("INSERT INTO invoice_items (invoice_id, session_id, description, quantity, unit_price, amount) VALUES (?, ?, '녹음', 1, 200000, 200000)").run(inv2, sess);

  const row = D.revenueByStaff().find((r) => r.id === mgr);
  assert.equal(row.last_issued, "2026-09-09", "작업·세션 중 최신");
  assert.equal(row.supply, 300000, "전 기간 누적(작업 10만 + 세션 20만)");
});
```

- [ ] **Step 2: 실패를 확인한다**

Run: `node --test test/revenue.test.js`
Expected: FAIL — `issuedInPeriodSql is not a function`(미export) 또는 `last_issued` undefined.

- [ ] **Step 3: `issuedInPeriodSql`에 전체 기간 모드를 넣고 export한다**

`src/data/revenue.js`의 해당 함수를 교체한다:

```js
// 발행일 기간 조건. period 없음/year 없음/year==='all' = 전체 기간(조건 없음).
// ISSUED가 이미 issued_date IS NOT NULL을 포함하므로 '1=1'이어도 발행일 없는 행은 안 섞인다.
function issuedInPeriodSql(alias, period) {
  const p = period || {};
  if (!p.year || p.year === "all") return "1=1";
  const y = Number(p.year);
  const month = p.month;
  if (month === "all" || month == null || month === "") return `substr(${alias}.issued_date,1,4) = '${y}'`;
  const ym = `${y}-${String(Number(month)).padStart(2, "0")}`;
  return `substr(${alias}.issued_date,1,7) = '${ym}'`;
}
```

파일 맨 아래 `module.exports`에 `issuedInPeriodSql`을 추가한다(테스트가 직접 검증할 수 있게).

- [ ] **Step 4: 두 순위 함수에 `last_issued`를 넣고 period를 선택 인자로 만든다**

`revenueByPayer`를 교체한다(시그니처에서 구조분해를 없애 period 없이도 호출되게):

```js
// 결제자(업체·개인)별 매출 기여(공급가)·건수·최근 발행일. period 없으면 전 기간 누적.
function revenueByPayer(period) {
  const per = issuedInPeriodSql("i", period);
  return db().prepare(`SELECT i.payer_id AS id, c.kind, c.name, COALESCE(SUM(i.amount - i.tax_amount),0) AS supply, COUNT(*) AS invoice_cnt, MAX(i.issued_date) AS last_issued FROM invoices i JOIN parties c ON c.id = i.payer_id WHERE ${ISSUED} AND ${per} AND i.payer_id IS NOT NULL GROUP BY i.payer_id ORDER BY supply DESC`).all();
}
```

`revenueByStaff`는 4개 쿼리를 합치는 구조다. 시그니처를 `function revenueByStaff(period) {`로 바꾸고 `const per = issuedInPeriodSql("i", period);`로 고친 뒤, 작업·세션 쿼리에 각각 `MAX(i.issued_date)`를 더한다:

```js
  const taskRev = q(`SELECT t.engineer_id AS id, COALESCE(SUM(ii.amount),0) AS supply, COUNT(*) AS cnt, MAX(i.issued_date) AS last_issued FROM invoice_items ii JOIN track_tasks t ON t.id = ii.task_id JOIN invoices i ON i.id = ii.invoice_id WHERE ${ISSUED} AND ${per} AND t.engineer_id IS NOT NULL GROUP BY t.engineer_id`);
```

```js
  const sessRev = q(`SELECT s.engineer_name AS name, COALESCE(SUM(ii.amount),0) AS supply, COUNT(*) AS cnt, MAX(i.issued_date) AS last_issued FROM invoice_items ii JOIN sessions s ON s.id = ii.session_id JOIN invoices i ON i.id = ii.invoice_id WHERE ${ISSUED} AND ${per} AND s.engineer_name IS NOT NULL GROUP BY s.engineer_name`);
```

그리고 `.map(...)` 안에서 둘 중 큰 값을 고른다(문자열 `YYYY-MM-DD`는 사전순 비교가 곧 날짜순):

```js
      const supply = (tr.supply || 0) + (sr.supply || 0);
      const payout = (tpById.get(m.id) || 0) + (spByName.get(m.name) || 0);
      const last = [tr.last_issued, sr.last_issued].filter(Boolean).sort().pop() || null;
      return { id: m.id, name: m.name, is_external: !m.user_id, supply, profit: supply - payout, task_cnt: tr.cnt || 0, session_cnt: sr.cnt || 0, last_issued: last };
```

`revenueSummary` 등 `revenueByStaff({year, month})`를 넘기던 기존 호출부는 **그대로 동작한다**(객체를 그대로 받으므로).

- [ ] **Step 5: 테스트 통과를 확인한다**

Run: `npm test`
Expected: PASS 전체. 기존 매출 집계 테스트가 그대로 통과해야 한다 — 년·월 동작 회귀가 이 태스크의 위험 지점이다.

- [ ] **Step 6: 커밋**

```bash
git add src/data/revenue.js test/revenue.test.js
git commit -m "feat(revenue): 전체 기간 집계 모드 + 순위에 최근 거래일"
```

---

### Task 2: 데이터 — 스탭 상세의 세션별 외주지급

월 소계에 순이익을 넣으려면 세션 지급을 **세션별로** 알아야 한다. 지금은 합계로만 반환한다.

**Files:**
- Modify: `src/data/revenue.js` (`revenueForStaff`)
- Test: `test/revenue.test.js`

**Interfaces:**
- Consumes: Task 1의 `issuedInPeriodSql(alias, period)`
- Produces: `revenueForStaff(id, period)` — `sessions[]` 각 행에 `payout`(그 세션 `session_engineers.worker_rate` 합, 숫자) 추가. `period` 생략 가능. 반환 형태 나머지(`{manager, tasks, sessions, supply, payout, profit}`) 불변.

- [ ] **Step 1: 실패하는 테스트를 쓴다**

`test/revenue.test.js`에 추가한다. 다인 세션(리드 1만 + 공동 2만)을 만들어 **리드가 전체 3만을 흡수**하는지, 그리고 항목별 합이 총계와 맞는지 본다.

```js
test("revenueForStaff: 세션 행 payout — 다인 세션 전액을 리드가 흡수(모델 A), 항목 합 = 총계", () => {
  const payer = db().prepare("INSERT INTO parties (kind, name) VALUES ('company', ?)").run("세션지급사").lastInsertRowid;
  const proj = db().prepare("INSERT INTO projects (title, project_type, rate) VALUES ('PD', 'task', 0)").run().lastInsertRowid;
  const lead = db().prepare("INSERT INTO project_managers (name) VALUES ('지급리드')").run().lastInsertRowid;
  const co = db().prepare("INSERT INTO project_managers (name) VALUES ('지급공동')").run().lastInsertRowid;
  const sess = db().prepare("INSERT INTO sessions (project_id, session_type, session_date, engineer_name, status) VALUES (?, '녹음', '2026-08-08', '지급리드', '완료')").run(proj).lastInsertRowid;
  db().prepare("INSERT INTO session_engineers (session_id, manager_id, worker_rate) VALUES (?, ?, ?)").run(sess, lead, 10000);
  db().prepare("INSERT INTO session_engineers (session_id, manager_id, worker_rate) VALUES (?, ?, ?)").run(sess, co, 20000);
  const inv = db().prepare("INSERT INTO invoices (project_id, payer_id, title, amount, tax_amount, status, issued_date) VALUES (?, ?, 'PT', 220000, 20000, '발행', '2026-08-08')").run(proj, payer).lastInsertRowid;
  db().prepare("INSERT INTO invoice_items (invoice_id, session_id, description, quantity, unit_price, amount) VALUES (?, ?, '녹음', 1, 200000, 200000)").run(inv, sess);

  const data = D.revenueForStaff(lead);
  const s = data.sessions.find((r) => r.id === sess);
  assert.equal(s.payout, 30000, "그 세션 배정 전원의 지급단가 합(10000+20000)");
  const taskPayoutSum = data.tasks.reduce((a, t) => a + (t.worker_rate || 0), 0);
  const sessPayoutSum = data.sessions.reduce((a, r) => a + (r.payout || 0), 0);
  assert.equal(taskPayoutSum + sessPayoutSum, data.payout, "항목별 지급 합 = 전체 지급");
  assert.equal(data.supply - data.payout, data.profit, "순이익 정합");
  assert.equal(D.revenueForStaff(co).sessions.length, 0, "공동 엔지니어에겐 세션이 안 잡힌다(모델 A)");
});
```

- [ ] **Step 2: 실패를 확인한다**

Run: `node --test test/revenue.test.js`
Expected: FAIL — `s.payout`이 undefined라 합이 0이 되어 불일치.

- [ ] **Step 3: 세션 쿼리에 payout을 파생한다**

`revenueForStaff`의 시그니처를 `function revenueForStaff(id, period) {`로 바꾸고 `const per = issuedInPeriodSql("i", period);`로 고친다. 세션 쿼리를 다음으로 교체한다(상관 서브쿼리로 세션별 지급 합):

```js
  // payout = 그 세션에 배정된 전 엔지니어의 지급단가 합(모델 A: 리드가 전체를 흡수).
  const sessions = db().prepare(`SELECT s.id, s.session_date, s.session_type, ii.amount AS amount, p.id AS project_id, p.title AS project_title, i.issued_date,
      (SELECT COALESCE(SUM(se.worker_rate),0) FROM session_engineers se WHERE se.session_id = s.id) AS payout
    FROM invoice_items ii JOIN sessions s ON s.id = ii.session_id JOIN projects p ON p.id = s.project_id JOIN invoices i ON i.id = ii.invoice_id
    WHERE ${ISSUED} AND ${per} AND s.engineer_name = ? ORDER BY i.issued_date DESC, s.session_date DESC`).all(manager.name);
```

**`sessPayout` 집계 쿼리는 지우고** 세션 행 합으로 대체한다:

```js
  const supply = tasks.reduce((a, t) => a + (t.amount || 0), 0) + sessions.reduce((a, s) => a + (s.amount || 0), 0);
  const payout = tasks.reduce((a, t) => a + (t.worker_rate || 0), 0) + sessions.reduce((a, s) => a + (s.payout || 0), 0);
```

⚠️ 옛 `sessPayout` 쿼리는 `session_engineers`를 JOIN해 **세션이 엔지니어 수만큼 곱해질 수 있었다**(같은 세션이 invoice_items에 여러 줄이면 더 곱해진다). 서브쿼리 방식은 세션당 한 번만 더한다 — 값이 달라지면 **새 값이 맞다**. 기존 테스트가 옛 값을 단언하고 있으면 그 테스트의 기대값을 고치고, 왜 바뀌었는지 한 줄 주석을 남긴다.

`revenueForPayer`도 시그니처를 `function revenueForPayer(id, period) {`로 바꾸고 `issuedInPeriodSql("i", period)`를 쓰게 한다(전체 기간 호출을 받기 위해).

- [ ] **Step 4: 테스트 통과를 확인한다**

Run: `npm test`
Expected: PASS 전체.

- [ ] **Step 5: 커밋**

```bash
git add src/data/revenue.js test/revenue.test.js
git commit -m "feat(revenue): 스탭 상세에 세션별 외주지급 파생(월 소계 순이익용)"
```

---

### Task 3: 뷰 — 목록에 최근 거래월, 기간 인자 제거

**Files:**
- Modify: `src/views.revenue.js` (`revStaffList`, `revPayerList`)
- Test: `test/revenue-views.test.js`

**Interfaces:**
- Consumes: Task 1의 `last_issued`
- Produces:
  - `revStaffList(rows, { selId = 0 })` — **`{year, month}`를 더 받지 않는다.** 행 href = `/revenue?tab=staff&staff=<id>`(기간 없음).
  - `revPayerList(rows, { selId = 0 })` — href = `/revenue?tab=payer&payer=<id>`.
  - 두 목록 모두 `subLeft`에 `· 최근 YYYY.M` 표기(값이 없으면 생략).

- [ ] **Step 1: 실패하는 테스트를 쓴다**

`test/revenue-views.test.js`의 기존 `revStaffList`/`revPayerList` 테스트에서 **호출부의 `{ year: 2026, month: 7 }`를 `{}`로 바꾸고**, href 단언에서 기간을 뺀다. 그리고 다음을 추가한다:

```js
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
```

- [ ] **Step 2: 실패를 확인한다**

Run: `node --test test/revenue-views.test.js`
Expected: FAIL — href에 기간이 남아 있고 '최근' 표기가 없다.

- [ ] **Step 3: 구현한다**

`src/views.revenue.js`에 헬퍼를 추가한다(`revListRow` 위):

```js
// "2026-07-16" → "2026.7"(목록의 최근 거래월 표기). 값 없으면 빈 문자열.
function lastSeenLabel(ymd) {
  if (!ymd) return "";
  const s = String(ymd);
  return `최근 ${s.slice(0, 4)}.${Number(s.slice(5, 7))}`;
}
```

`revStaffList`를 교체한다:

```js
function revStaffList(rows, { selId = 0 } = {}) {
  if (!rows.length) return emptyState("매출 기여가 있는 스탭이 없습니다.", { card: true });
  const list = listGroup({ rows: rows.map((r) => {
    const last = lastSeenLabel(r.last_issued);
    return revListRow({
      href: `/revenue?tab=staff&staff=${Number(r.id)}`,
      selected: Number(r.id) === Number(selId),
      title: esc(r.name),
      subLeft: `${r.is_external ? `<span class="badge badge-neutral">외주</span> ` : ""}작업 ${r.task_cnt} · 세션 ${r.session_cnt}${last ? ` · ${esc(last)}` : ""}`,
      right: formatKRW(r.supply),
      subRight: `순이익 <span class="${profitCls(r.profit)}">${formatKRW(r.profit)}</span>`,
    });
  }) });
  return `<div class="lg:min-h-0 lg:flex-1 lg:overflow-y-auto">${list}</div>`;
}
```

`revPayerList`를 교체한다:

```js
function revPayerList(rows, { selId = 0 } = {}) {
  if (!rows.length) return emptyState("매출 기여가 있는 업체·개인이 없습니다.", { card: true });
  const kindLabel = (k) => (k === "person" ? "개인" : k === "group" ? "그룹" : "업체");
  const list = listGroup({ rows: rows.map((r) => {
    const last = lastSeenLabel(r.last_issued);
    return revListRow({
      href: `/revenue?tab=payer&payer=${Number(r.id)}`,
      selected: Number(r.id) === Number(selId),
      title: esc(r.name),
      subLeft: `<span class="badge badge-neutral">${kindLabel(r.kind)}</span>${last ? ` · ${esc(last)}` : ""}`,
      right: formatKRW(r.supply),
      subRight: `청구 ${r.invoice_cnt}건`,
    });
  }) });
  return `<div class="lg:min-h-0 lg:flex-1 lg:overflow-y-auto">${list}</div>`;
}
```

빈 상태 문구가 "이 기간 매출이 있는…"에서 바뀐 것에 유의한다 — 기간 개념이 없어졌다. 기존 빈 상태 테스트의 기대 문구도 함께 고친다.

- [ ] **Step 4: 테스트 통과를 확인한다**

Run: `npm test`
Expected: PASS 전체.

- [ ] **Step 5: 커밋**

```bash
git add src/views.revenue.js test/revenue-views.test.js
git commit -m "feat(revenue): 순위 목록에 최근 거래월 + 기간 없는 링크"
```

---

### Task 4: 뷰 — 상세를 월별 그룹으로

**Files:**
- Modify: `src/views.revenue.js` (`revStaffDetail`, `revPayerDetail` + 헬퍼 2개 신설)
- Test: `test/revenue-views.test.js`

**Interfaces:**
- Consumes: Task 2의 세션 `payout`
- Produces:
  - `monthLabel(ym)` — `"2026-07"` → `"2026년 7월"`
  - `groupByMonth(items)` — `[{ym, date, amount, payout, ...}]`(발행일 내림차순 입력) → `[{ym, items, supply, payout}]`
  - `revStaffDetail(data)` — **`{year, month}` 인자 제거**(받기만 하고 안 쓰던 죽은 인자였다). 월 그룹 안에 작업·세션을 날짜순으로 **섞어** 렌더, 월 헤더에 매출·순이익 소계.
  - `revPayerDetail(data)` — 인자 제거. 월 그룹 + 월 매출 소계.

- [ ] **Step 1: 실패하는 테스트를 쓴다**

```js
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

test("revStaffDetail/revPayerDetail: 인라인 style 없음(CSP)", () => {
  const s = V.revStaffDetail({ manager: { id: 1, name: "김", user_id: 1 }, tasks: [], sessions: [], supply: 0, payout: 0, profit: 0 });
  const p = V.revPayerDetail({ party: { id: 1, name: "회사", kind: "company" }, invoices: [], supply: 0, invoice_cnt: 0 });
  assert.ok(!/ style="/.test(s) && !/ style="/.test(p));
});
```

- [ ] **Step 2: 실패를 확인한다**

Run: `node --test test/revenue-views.test.js`
Expected: FAIL — 월 헤더가 없다.

- [ ] **Step 3: 헬퍼 2개를 추가한다**

`src/views.revenue.js`에 추가한다(`revStaffDetail` 위):

```js
// "2026-07" → "2026년 7월"
function monthLabel(ym) {
  const [y, m] = String(ym).split("-");
  return `${y}년 ${Number(m)}월`;
}

// 발행일 내림차순 배열을 월별로 묶는다(입력 순서 유지 = 최신 월 먼저).
// 각 항목은 {ym, amount, payout} 를 가져야 한다. 월 소계를 함께 계산한다.
function groupByMonth(items) {
  const out = [];
  let cur = null;
  items.forEach((it) => {
    if (!cur || cur.ym !== it.ym) {
      cur = { ym: it.ym, items: [], supply: 0, payout: 0 };
      out.push(cur);
    }
    cur.items.push(it);
    cur.supply += it.amount || 0;
    cur.payout += it.payout || 0;
  });
  return out;
}

// 월 그룹 헤더(월 이름 + 소계). profit=true면 순이익 소계도 함께.
function monthHeader(g, { profit = false } = {}) {
  const p = g.supply - g.payout;
  return `<div class="mt-4 flex items-baseline justify-between border-b border-border/60 pb-1">
      <h3 class="text-sm font-semibold">${esc(monthLabel(g.ym))}</h3>
      <div class="tabular text-sm">
        <span class="font-semibold">${formatKRW(g.supply)}</span>
        ${profit ? `<span class="ml-2 text-xs text-muted">순이익 <span class="${profitCls(p)}">${formatKRW(p)}</span></span>` : ""}
      </div>
    </div>`;
}
```

- [ ] **Step 4: `revStaffDetail`을 월별 그룹으로 교체한다**

```js
// 스탭 상세 — 월별 그룹(최신 월 우선). 월 안에서 작업·세션을 **섞어** 날짜순으로 둔다
// (2026-07-19 사용자 확정: 월별 리듬이 목적인데 종류로 먼저 가르면 리듬이 두 번 쪼개진다).
function revStaffDetail(data) {
  const { taskTypeLabel } = require("./data");
  const { tasks, sessions, supply, payout, profit } = data;
  const summary = `<div class="card flex flex-wrap gap-4 text-sm">
    <span>총 매출 <b class="tabular text-fg">${formatKRW(supply)}</b></span>
    <span>외주 지급 <b class="tabular text-fg">${formatKRW(payout)}</b></span>
    <span class="font-semibold">순이익 <b class="tabular ${profitCls(profit)}">${formatKRW(profit)}</b></span>
  </div>`;
  const items = [
    ...tasks.map((t) => ({
      ym: String(t.issued_date || "").slice(0, 7), date: String(t.issued_date || ""),
      kind: "작업", label: taskTypeLabel(t.task_type), sub: `${t.project_title} / ${t.track_title}`,
      href: `/projects/${t.project_id}?tab=tracks`, amount: t.amount || 0, payout: t.worker_rate || 0,
    })),
    ...sessions.map((s) => ({
      ym: String(s.issued_date || "").slice(0, 7), date: String(s.issued_date || ""),
      kind: "세션", label: `${s.session_date} ${s.session_type}`, sub: s.project_title,
      href: `/projects/${s.project_id}?tab=sessions`, amount: s.amount || 0, payout: s.payout || 0,
    })),
  ].sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));
  if (!items.length) return `${summary}${emptyState("내역이 없습니다.", { card: true })}`;
  const groups = groupByMonth(items).map((g) => `${monthHeader(g, { profit: true })}
    ${listGroup({ rows: g.items.map((it) => listRow({
      href: it.href,
      left: `<span class="badge badge-neutral">${esc(it.kind)}</span> <span class="font-medium">${esc(it.label)}</span> <span class="text-xs text-muted">· ${esc(it.sub)}</span>`,
      right: formatKRW(it.amount),
    })) })}`).join("");
  return `${summary}${groups}`;
}
```

- [ ] **Step 5: `revPayerDetail`을 월별 그룹으로 교체한다**

```js
// 청구처 상세 — 월별 그룹(최신 월 우선). 월 소계는 매출(공급가)만(청구처엔 외주지급 개념이 없다).
function revPayerDetail(data) {
  const { taxBadge } = require("./views.invoices");
  const { invoices, supply, invoice_cnt } = data;
  const summary = `<div class="card flex flex-wrap gap-4 text-sm"><span>총 매출 기여 <b class="tabular text-fg">${formatKRW(supply)}</b></span><span>청구 ${invoice_cnt}건</span></div>`;
  if (!invoices.length) return `${summary}${emptyState("발행 청구서가 없습니다.", { card: true })}`;
  const items = invoices.map((inv) => ({ ym: String(inv.issued_date || "").slice(0, 7), amount: inv.supply || 0, payout: 0, inv }));
  const groups = groupByMonth(items).map((g) => `${monthHeader(g)}
    ${listGroup({ rows: g.items.map(({ inv }) => listRow({
      href: `/invoices/${inv.id}`,
      left: `<span class="font-medium">${esc(inv.project_title || `청구 #${inv.id}`)}</span>
             <span class="text-xs text-muted">· ${esc(String(inv.issued_date).slice(0, 10))}${inv.invoice_number ? ` · ${esc(inv.invoice_number)}` : ""}</span>
             <span class="ml-1">${taxBadge(inv)}</span>`,
      right: formatKRW(inv.supply),
    })) })}`).join("");
  return `${summary}${groups}`;
}
```

⚠️ 청구서 링크는 지금 새 탭(`target="_blank"`)이었다. `listRow`는 새 탭 옵션이 없으므로 **같은 탭 이동으로 바뀐다**. 이 화면은 이제 목록이 왼쪽에 상시 있는 마스터-디테일이라 돌아오기가 쉽지만, 새 탭을 유지하고 싶으면 `listRow` 대신 기존 `dataTable` 링크 패턴을 쓰라. 구현자는 **같은 탭으로 진행**하고 보고서에 적어 리뷰가 판단하게 한다.

- [ ] **Step 6: 테스트 통과를 확인한다**

Run: `npm test`
Expected: PASS 전체. 라우트가 아직 `revStaffDetail(data, period)`로 호출해도 두 번째 인자는 무시되므로 깨지지 않는다(Task 5에서 정리).

- [ ] **Step 7: 커밋**

```bash
git add src/views.revenue.js test/revenue-views.test.js
git commit -m "feat(revenue): 상세를 월별 그룹으로(월 소계·작업/세션 혼합)"
```

---

### Task 5: 뷰 — 개요에 기간 기여자 전체 펼침, '전체 보기' 링크 제거

**Files:**
- Modify: `src/views.revenue.js` (`revOverview`의 `mini`/`tops`)
- Test: `test/revenue-views.test.js`

**Interfaces:**
- Consumes: (없음)
- Produces: `revOverview({summary, topStaff, topPayer, byType, tax, year, month})` — `topStaff`/`topPayer`는 이제 **자르지 않은 전체 배열**을 받는다. 상위 5개는 바로 보이고 나머지는 `<details>` 펼침. 행 링크는 기간 없는 상세 URL. '전체 보기' 링크 없음.

- [ ] **Step 1: 실패하는 테스트를 쓴다**

`test/revenue-views.test.js`의 기존 "revOverview: Top5 링크는 패널 URL" 테스트를 다음으로 교체한다:

```js
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

test("revOverview: 5개 이하면 펼침을 만들지 않는다", () => {
  const summary = { periodSupply: 0, periodProfit: 0, ytdSupply: 0, ytdProfit: 0, monthly: Array.from({length:12},(_,k)=>({month:k+1,supply:0,profit:0})), cmp: { isYear: false, prevPeriodSupply: 0, prevPeriodProfit: 0, prevYearSupply: 0, prevYearProfit: 0 } };
  const payers = [{ id: 1, name: "업체1", supply: 100 }];
  const html = V.revOverview({ summary, topStaff: [], topPayer: payers, byType: [], tax: { vatTotal: 0, payoutTotal: 0, withholding: { total: 0, net: 0 } }, year: 2026, month: 7 });
  assert.ok(!/<details/.test(html), "더 볼 게 없으면 펼침 없음");
});
```

- [ ] **Step 2: 실패를 확인한다**

Run: `node --test test/revenue-views.test.js`
Expected: FAIL — '전체 보기 →'가 아직 있고 `<details>`가 없다.

- [ ] **Step 3: `mini`를 교체한다**

`revOverview` 안의 `mini` 정의와 `tops`를 다음으로 교체한다:

```js
  // 상위 5개는 바로, 나머지는 <details> 펼침(무JS·CSP 안전). 기간 렌즈가 개요에 있으므로
  // "이 기간 누가 기여했나"를 여기서 전부 답한다 — 목록 탭은 누적 전용이라 '전체 보기' 링크는 없앴다
  // (7월을 보다 눌렀는데 전체 누적이 열리면 링크가 거짓말이 된다).
  const row = (r, hrefFn) => `<a href="${hrefFn(r)}" class="row-link flex items-center justify-between gap-2 px-3 py-2"><span class="truncate font-medium">${esc(r.name)}</span><span class="tabular font-semibold">${formatKRW(r.supply)}</span></a>`;
  const mini = (rows, hrefFn) => {
    if (!rows.length) return `<div class="text-sm text-muted">내역이 없습니다.</div>`;
    const head = rows.slice(0, 5).map((r) => row(r, hrefFn)).join("");
    const rest = rows.slice(5);
    if (!rest.length) return head;
    return `${head}<details class="border-t border-border/60">
        <summary class="cursor-pointer px-3 py-2 text-xs text-primary hover:underline">전체 ${rows.length}곳 보기</summary>
        <div class="divide-y divide-border border-t border-border/60">${rest.map((r) => row(r, hrefFn)).join("")}</div>
      </details>`;
  };
  const tops = `<div class="grid gap-4 sm:grid-cols-2">
    <div><h2 class="mb-2 text-sm font-semibold text-muted">스탭별 매출</h2><div class="card p-0 overflow-hidden divide-y divide-border">${mini(topStaff, (r) => `/revenue?tab=staff&staff=${r.id}`)}</div></div>
    <div><h2 class="mb-2 text-sm font-semibold text-muted">업체·개인별 매출</h2><div class="card p-0 overflow-hidden divide-y divide-border">${mini(topPayer, (r) => `/revenue?tab=payer&payer=${r.id}`)}</div></div>
  </div>`;
```

`qs` 변수가 `revOverview` 안에서 더 이상 쓰이지 않으면 그 선언도 지운다(고아 변수 방치 금지).

- [ ] **Step 4: 테스트 통과를 확인한다**

Run: `npm test`
Expected: PASS 전체.

- [ ] **Step 5: 커밋**

```bash
git add src/views.revenue.js test/revenue-views.test.js
git commit -m "feat(revenue): 개요에서 기간 기여자 전체 펼침('전체 보기' 링크 제거)"
```

---

### Task 6: 라우트 — 기간 렌즈 분리 배선

**Files:**
- Modify: `src/routes/revenue.routes.js` (GET `/`), `src/views.revenue.js` (`revPeriodControl`, `revTabs`)
- Test: `test/revenue-panes.test.js`, `test/revenue-views.test.js`

**Interfaces:**
- Consumes: Task 1~5 전부
- Produces:
  - 목록 탭은 `revenueByStaff()`/`revenueByPayer()`/`revenueForStaff(id)`/`revenueForPayer(id)`를 **period 없이** 호출한다.
  - `revPeriodControl({year, month, years, tab})` — **`sel` 파라미터 제거**(개요에만 렌더되므로 유지할 선택이 없다).
  - `revTabs({tab, year, month})` — 개요 링크만 기간을 싣는다. 목록 탭 링크는 `/revenue?tab=staff`.
  - 기간 컨트롤은 **개요 탭에서만** 렌더된다.

- [ ] **Step 1: 실패하는 테스트를 쓴다**

`test/revenue-views.test.js`에서 **`revPeriodControl` `sel` 테스트를 삭제**하고 다음을 추가한다:

```js
test("revTabs: 개요 링크만 기간을 싣는다(목록 탭은 누적이라 기간이 없다)", () => {
  const html = V.revTabs({ tab: "payer", year: 2026, month: 7 });
  assert.match(html, /href="\/revenue\?tab=overview&year=2026&month=7"/, "개요는 기간 유지");
  assert.match(html, /href="\/revenue\?tab=staff"/, "스탭별은 기간 없음");
  assert.match(html, /href="\/revenue\?tab=payer"/, "업체·개인별은 기간 없음");
});
```

`test/revenue-panes.test.js`는 **하나의 `test(...)` 안에 `await t.test(...)` 서브테스트를 쌓는 구조**이고, 서버 기동·로그인 후 `const get = async (p) => ({ status, loc, html })` 헬퍼를 쓴다. 그 안에 서브테스트 2개를 추가한다:

```js
  await t.test("목록 탭은 기간 컨트롤을 렌더하지 않는다(개요에만 있다)", async () => {
    const payer = await get("/revenue?tab=payer");
    assert.equal(payer.status, 200);
    assert.ok(!/name="month"/.test(payer.html), "목록 탭에 월 셀렉트 없음");
    const overview = await get("/revenue?tab=overview");
    assert.match(overview.html, /name="month"/, "개요에는 있음");
  });

  await t.test("목록 탭은 URL의 기간 파라미터를 무시한다(북마크 호환)", async () => {
    const withPeriod = await get("/revenue?tab=payer&year=2025&month=1");
    const without = await get("/revenue?tab=payer");
    assert.equal(withPeriod.status, 200);
    // 기간이 렌더에 영향을 주지 않는다 — 같은 청구처가 같은 누적 금액으로 나온다.
    assert.match(withPeriod.html, /도너츠컬처/, "기간을 붙여도 누적 목록이 그대로");
    assert.equal(/도너츠컬처/.test(without.html), /도너츠컬처/.test(withPeriod.html), "두 응답의 목록 구성이 같다");
  });
```

(이 파일 상단에서 이미 `도너츠컬처` 청구처를 시드하고 있다. 그 청구처에 발행 청구서가 없으면 목록에 안 뜨므로, 필요하면 이 파일의 시드 블록에 발행 청구서 1건을 더한다 — `revenueByPayer`는 발행 청구서가 있는 청구처만 반환한다.)

- [ ] **Step 2: 실패를 확인한다**

Run: `node --test test/revenue-views.test.js test/revenue-panes.test.js`
Expected: FAIL — 탭 링크에 기간이 있고 목록 탭에도 기간 컨트롤이 렌더된다.

- [ ] **Step 3: `revPeriodControl`에서 `sel`을 제거한다**

`src/views.revenue.js`:

```js
// 년·월 셀렉트(GET 폼). **개요 탭 전용** — 목록 탭은 기간 없이 전체 누적이라 이 컨트롤을 쓰지 않는다.
// 셀렉트를 바꾸면 바로 조회된다(app.js가 [data-auto-submit] 폼의 select change에서 제출).
// '보기' 버튼은 <noscript>로만 남겨 JS가 없을 때만 보인다.
function revPeriodControl({ year, month, years, tab }) {
```

`selHidden` 선언과 return 안의 `${selHidden}`을 지운다.

- [ ] **Step 4: `revTabs`가 개요에만 기간을 싣게 한다**

```js
// 탭바(개요/스탭별/업체·개인별). 기간은 개요 링크에만 — 목록 탭은 전체 누적이라 기간 개념이 없다.
function revTabs({ tab, year, month }) {
  const qs = periodQS({ year, month });
  return tabBar({
    tabs: [{ key: "overview", label: "개요" }, { key: "staff", label: "스탭별" }, { key: "payer", label: "업체·개인별" }],
    activeKey: tab,
    hrefFn: (k) => (k === "overview" ? `/revenue?tab=overview&${qs}` : `/revenue?tab=${k}`),
  });
}
```

- [ ] **Step 5: 라우트를 고친다**

`src/routes/revenue.routes.js` GET `/`에서:

1. 목록 분기의 데이터 호출에서 period를 뺀다.

```js
    const data = selId ? revenueForStaff(selId) : null;
    const left = revStaffList(revenueByStaff(), { selId: data ? selId : 0 });
```

```js
    const data = selId ? revenueForPayer(selId) : null;
    const left = revPayerList(revenueByPayer(), { selId: data ? selId : 0 });
```

2. 상세 뷰 호출에서 period 인자를 뺀다: `revStaffDetail(data)` / `revPayerDetail(data)`.

3. `backHref`에서 기간을 뺀다: `/revenue?tab=staff` · `/revenue?tab=payer`.

4. 개요 분기에서 `.slice(0, 5)`를 **없앤다**(뷰가 전체를 받아 상위 5 + 펼침을 만든다):

```js
    const topStaff = revenueByStaff(period);
    const topPayer = revenueByPayer(period);
```

5. `sel` 변수와 그 대입을 전부 제거하고, 기간 컨트롤을 개요에서만 렌더한다:

```js
  const body = `
    ${pageHeader({ title: "매출", desc: "공급가(VAT 제외)·발행일 기준. 순이익 = 매출 − 외주 지급." })}
    ${tab === "overview" ? revPeriodControl({ ...period, years, tab }) : ""}
    ${revTabs({ tab, ...period })}
    <div class="mt-4">${content}</div>`;
```

- [ ] **Step 6: 서버를 띄워 HTTP로 확인한다**

```bash
pkill -f "src/server.js" ; sleep 1
DEV_LOGIN=1 node src/server.js &
```

(함정 #5 — 유휴 서버가 포트를 잡고 **옛 코드로 응답**한다.)

치프로 로그인해 확인:
- `/revenue?tab=payer` → 200, 월 셀렉트 없음, 목록에 `최근 YYYY.M` 표기
- `/revenue?tab=payer&payer=<존재하는 id>` → 상세에 `N년 M월` 그룹 헤더
- `/revenue?tab=overview` → 200, 월 셀렉트 있음
- `/revenue/payer/<id>` → 302(구 경로 호환 유지 확인)

끝나면 `pkill -f "src/server.js"`로 정리한다.

- [ ] **Step 7: 테스트 전체 통과를 확인한다**

Run: `npm test`
Expected: PASS 전체.

- [ ] **Step 8: 커밋**

```bash
git add src/routes/revenue.routes.js src/views.revenue.js test/
git commit -m "feat(revenue): 기간 렌즈 분리 — 컨트롤은 개요만, 목록 탭은 누적"
```

---

### Task 7: 문서 현행화

**Files:**
- Modify: `CLAUDE.md`(매출 섹션), `WORKFLOW.md`(완료 목록 최상단), `HISTORY.md`(세션 이력 최상단)

- [ ] **Step 1: `CLAUDE.md` 매출 섹션을 고친다**

다음을 반영한다(옛 서술을 **대체**할 것 — 남기면 다음 사람이 되돌린다):
- 기간 컨트롤은 **개요 탭 전용**. 스탭별·업체개인별은 기간 없이 **전체 누적**.
- 목록 행에 **최근 거래월**(`최근 2026.7`), 링크는 기간 없는 URL.
- 상세는 **월별 그룹 + 월 소계**, 스탭 상세는 월 안에서 작업·세션을 **날짜순으로 섞는다**.
- 개요 Top 5 아래 **'전체 N곳 보기' 펼침**(`<details>`·무JS), 옛 '전체 보기' 링크 제거.
- `issuedInPeriodSql`의 **전체 기간 모드**(period 없음/year 없음/`"all"` → 조건 없음).
- `revenueForStaff`의 세션 행에 **`payout` 파생**(월 소계 순이익용, 모델 A 유지).
- 오늘 오전에 넣은 **"기간 변경 시 선택 유지"(`revPeriodControl` `sel`)는 제거**됐다는 것과 그 이유(기간 컨트롤이 개요로 옮겨가 유지할 선택이 없다).

- [ ] **Step 2: `WORKFLOW.md`·`HISTORY.md`에 이번 작업을 한 항목씩 추가한다**

두 파일 모두 최신 항목이 맨 위인 목록이다. 기존 항목의 서술 밀도를 따른다.

- [ ] **Step 3: 커밋**

```bash
git add CLAUDE.md WORKFLOW.md HISTORY.md
git commit -m "docs: 매출 기간 렌즈 분리 현행화"
```

---

## 검증 체크리스트 (완료 주장 전)

1. `npm test` 전체 통과.
2. 브라우저 실측(lg ≥1024):
   - 업체·개인별 탭에 기간 컨트롤이 없고, 목록이 전 기간 누적 순위이며 각 행에 최근 거래월이 보인다
   - 상세가 최신 월부터 월별로 끊기고 월 헤더에 소계가 있다
   - 스탭 상세에서 한 월 안에 작업·세션이 섞여 날짜순으로 있다
   - 개요에서 월을 바꾸면 즉시 조회되고, Top 5 아래 '전체 N곳 보기'를 펼치면 그 기간 기여자가 전부 나온다
   - 개요에서 업체를 누르면 그 업체의 **누적** 상세로 간다
   - 페이지 세로 스크롤 0(마스터-디테일 전제)·390px 가로 오버플로우 0
3. 구 URL `/revenue/payer/<id>` 302 유지.
