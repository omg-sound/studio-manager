# 매출 섹션 고도화 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `/revenue`를 기간(년·월)·축(스탭 / 업체·개인)·순이익까지 보는 현황 파악 도구로 확장한다.

**Architecture:** 데이터층(`src/data/revenue.js`) 확장 + 전용 뷰(`src/views.revenue.js` 신설, 인라인 SVG 바 차트) + 라우트(`src/routes/revenue.routes.js`) 탭·기간·드릴다운. 매출=공급가(VAT 제외)·발생(발행일) 기준, 순이익=매출−외주지급. 서버 렌더·무JS·의존성 0.

**Tech Stack:** Node/Express(CommonJS), better-sqlite3(`db()` 어댑터), 서버 렌더 HTML(`views.js` 헬퍼: `tabBar`·`dataTable`·`statCard`·`layout`·`pageHeader`·`formatKRW`·`esc`·`emptyState`), `node:test`, `test/helpers.js`(`tempDbPath`/`cleanupDb`). 스펙: `docs/superpowers/specs/2026-07-19-revenue-analytics-design.md`.

## Global Constraints

- **매출 = 공급가액(VAT 제외)** = `invoices.amount − invoices.tax_amount`(청구서 단위·할인 반영). **발생 기준** = `status <> '미발행' AND issued_date` 로 발행일 기간 귀속.
- **순이익 = 매출 − 외주 지급** = 매출 − Σ`worker_rate`(작업 `track_tasks.worker_rate` + 세션 `session_engineers.worker_rate`), 같은 청구서 발행일 기간.
- **스탭 축은 청구 항목(invoice_items.amount) 라인 기준**(할인 반영 전) — 청구서 할인 있으면 스탭 합이 총 매출과 할인액만큼 다를 수 있음(v1 근사, 화면에 참고 명시).
- 접근 = `requireInvoice`(대표·치프)만.
- 의존성 0: 외부 차트 라이브러리 금지 → **인라인 SVG 바 차트**(SVG 기하 속성은 CSP style-src 무관·함정 #27). 인라인 `style=` 금지, 색은 CSS 클래스(`fill`).
- 무JS: 기간 컨트롤은 `<form method="get">` + 셀렉트 + 제출 버튼.
- 레이아웃 = 기본 읽기 폭(`layout()` 기본, `max-w-content` 768). `wide` 미사용.
- 년·월 쿼리값은 라우트에서 **정수 파싱**(month은 `"all"` 허용) 후 데이터층에 전달(SQL 문자열 보간 주입 안전 — 정수/고정 문자열만).
- 커밋 메시지 말미: `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`.

## File Structure

- `src/data/revenue.js` — **확장**(기존 `revenueByEngineer`/`revenueForEngineer` 제거·대체). 기간·축별 집계 함수 6종 + 기간 SQL 헬퍼 + 년 목록.
- `src/views.revenue.js` — **신설**. 매출 전용 렌더(기간 컨트롤·탭·KPI·SVG 바 차트·순위 표·드릴다운 상세). `views.js`/`views.invoices.js` 헬퍼 재사용.
- `src/routes/revenue.routes.js` — **재작성**. 탭(개요/스탭별/업체·개인별)·기간 쿼리·드릴다운 2종(`/revenue/staff/:id`·`/revenue/payer/:id`).
- `src/routes/invoices.routes.js` — **수정**(카드 라벨 '매출'→'발행액', 값 불변).
- `public/css/src.css` — **수정**(SVG 바 차트 색 클래스).
- `test/revenue.test.js` — **신설**(데이터층 집계·기간·순이익·공급가).
- `test/invoice-list.test.js` 또는 신규 — 청구 카드 라벨 계약(라우트 소스 문자열 검사).
- `CLAUDE.md`·`WORKFLOW.md` — 현행화.

**data.js는 수정 불필요**: `const revenue = require("./data/revenue")` → `module.exports = { ...revenue }` 스프레드라 revenue.js가 export한 새 함수는 자동 노출.

---

### Task 1: 데이터층 — 기간 헬퍼 + `revenueSummary`

**Files:**
- Modify: `src/data/revenue.js`(전면 재작성 시작 — 이 태스크에서 파일 상단 헬퍼 + summary + module.exports 골격)
- Test: `test/revenue.test.js`(신설)

**Interfaces:**
- Produces:
  - `issuedInPeriodSql(alias, { year, month })` → string (SQL 조건, `<alias>.issued_date` 기준)
  - `revenueYears()` → `number[]`(발행 청구서가 있는 년 내림차순, 없으면 빈 배열)
  - `revenueSummary({ year, month })` → `{ periodSupply, periodProfit, ytdSupply, ytdProfit, monthly: [{ month, supply }] }`(monthly는 선택 년 1~12월)

- [ ] **Step 1: 실패 테스트 작성** — `test/revenue.test.js`

```js
"use strict";
process.env.NODE_ENV = "test";
const { tempDbPath, cleanupDb } = require("./helpers");
process.env.DB_PATH = tempDbPath();
const test = require("node:test");
const assert = require("node:assert");
const { db, init } = require("../src/db");
init();
test.after(() => cleanupDb(process.env.DB_PATH, db()));
const D = require("../src/data");

// 공용 픽스처: 회사 청구처 + VAT 포함 발행 청구서 1건(공급가 100000, VAT 10000, 총 110000).
// invoice_items에 작업 라인 1건(공급가 100000) + 그 작업에 외주 지급 30000.
function seedInvoice({ issued = "2026-07-10", payerName = "테스트컴퍼니", amount = 110000, tax = 10000, workerRate = 30000, engineerId = null } = {}) {
  const payer = db().prepare("INSERT INTO parties (kind, name) VALUES ('company', ?)").run(payerName).lastInsertRowid;
  const proj = db().prepare("INSERT INTO projects (title, project_type, rate) VALUES ('P', 'task', 0)").run().lastInsertRowid;
  const tr = db().prepare("INSERT INTO project_tracks (project_id, title, content_type) VALUES (?, '곡', 'Music')").run(proj).lastInsertRowid;
  const task = db().prepare("INSERT INTO track_tasks (track_id, task_type, billing_type, quantity, unit_price, total_price, status, is_invoiced, engineer_id, worker_rate) VALUES (?, 'Mixing', 'Fixed_Per_Track', 1, 100000, 100000, 'Completed', 1, ?, ?)").run(tr, engineerId, workerRate).lastInsertRowid;
  const inv = db().prepare("INSERT INTO invoices (project_id, payer_id, amount, tax_amount, status, issued_date) VALUES (?, ?, ?, ?, '발행', ?)").run(proj, payer, amount, tax, issued).lastInsertRowid;
  db().prepare("INSERT INTO invoice_items (invoice_id, task_id, description, quantity, unit_price, amount) VALUES (?, ?, 'Mixing', 1, 100000, 100000)").run(inv, task);
  return { payer, proj, task, inv };
}

test("revenueSummary: 공급가(VAT 제외)·발생 기준 + 순이익(매출−외주) + 월별 추세", () => {
  seedInvoice({ issued: "2026-07-10", amount: 110000, tax: 10000, workerRate: 30000 });
  seedInvoice({ issued: "2026-03-05", amount: 55000, tax: 5000, workerRate: 0 });
  const s = D.revenueSummary({ year: 2026, month: 7 });
  assert.equal(s.periodSupply, 100000, "7월 공급가 = 110000-10000");
  assert.equal(s.periodProfit, 70000, "7월 순이익 = 100000-30000");
  assert.equal(s.ytdSupply, 150000, "올해 공급가 = 100000(7월)+50000(3월)");
  assert.equal(s.ytdProfit, 120000, "올해 순이익 = 150000-30000");
  assert.equal(s.monthly.length, 12, "12개월");
  assert.equal(s.monthly[6].supply, 100000, "7월(index 6)");
  assert.equal(s.monthly[2].supply, 50000, "3월(index 2)");
  assert.equal(s.monthly[0].supply, 0, "1월 없음");
});

test("revenueSummary: month='all'이면 선택 년 전체 집계", () => {
  const s = D.revenueSummary({ year: 2026, month: "all" });
  assert.equal(s.periodSupply, s.ytdSupply, "연간 선택 = YTD와 동일");
});

test("revenueSummary: 미발행 청구서는 매출에서 제외", () => {
  const before = D.revenueSummary({ year: 2027, month: 1 }).periodSupply;
  const payer = db().prepare("INSERT INTO parties (kind, name) VALUES ('company','미발행사')").run().lastInsertRowid;
  db().prepare("INSERT INTO invoices (payer_id, amount, tax_amount, status, issued_date) VALUES (?, 99000, 9000, '미발행', '2027-01-05')").run(payer);
  assert.equal(D.revenueSummary({ year: 2027, month: 1 }).periodSupply, before, "미발행 제외");
});

test("revenueYears: 발행 청구서가 있는 년 내림차순", () => {
  const ys = D.revenueYears();
  assert.ok(ys.includes(2026), "2026 포함");
  for (let k = 1; k < ys.length; k++) assert.ok(ys[k - 1] >= ys[k], "내림차순");
});
```

- [ ] **Step 2: 실패 확인**

Run: `node --test test/revenue.test.js`
Expected: FAIL (`D.revenueSummary is not a function`).

- [ ] **Step 3: 구현** — `src/data/revenue.js`에 아래 헬퍼·함수를 **추가**한다(파일 전면 교체 금지). **기존 `revenueByEngineer`·`revenueForEngineer` 함수와 그 export는 그대로 둔다** — 라우트가 Task 5까지 사용하므로 지금 지우면 Task 3 전체 스위트(스모크가 `/revenue` 호출)가 500으로 깨진다. 아래 코드에서 `"use strict"`·`const { db } = require("../db")`는 이미 파일에 있으니 중복 추가하지 말고, `ISSUED`·`issuedInPeriodSql`·`revenueYears`·`revenueSummary`만 넣는다. module.exports는 **기존 두 이름에 새 이름을 병합**한다.

```js
"use strict";

/**
 * 매출 집계 도메인(2026-07-19 고도화) — 기간(년·월)·축(스탭/업체·개인)·순이익.
 * 매출 = 공급가액(VAT 제외) = invoices.amount − tax_amount, 발생(발행일) 기준(status<>'미발행').
 * 순이익 = 매출 − 외주 지급(track_tasks.worker_rate + session_engineers.worker_rate).
 * cross-domain(listProjectManagers)은 함수 내부 지연 require("../data")로 순환 회피.
 */
const { db } = require("../db");

// 발행 청구서 조건(별칭 i). issued_date NULL·미발행 제외.
const ISSUED = "i.status <> '미발행' AND i.issued_date IS NOT NULL";

// 발행일 기간 조건 SQL. year·month는 라우트에서 정수 파싱(month='all' 연간). 정수/고정문자열만 보간(주입 안전).
function issuedInPeriodSql(alias, { year, month }) {
  const y = Number(year);
  if (month === "all" || month == null || month === "") return `substr(${alias}.issued_date,1,4) = '${y}'`;
  const ym = `${y}-${String(Number(month)).padStart(2, "0")}`;
  return `substr(${alias}.issued_date,1,7) = '${ym}'`;
}

// 발행 청구서가 있는 년(내림차순).
function revenueYears() {
  return db()
    .prepare(`SELECT DISTINCT substr(issued_date,1,4) AS y FROM invoices WHERE status <> '미발행' AND issued_date IS NOT NULL ORDER BY y DESC`)
    .all()
    .map((r) => Number(r.y))
    .filter(Boolean);
}

// 기간 매출·순이익 + 선택 년 월별 추세.
function revenueSummary({ year, month }) {
  const y = Number(year);
  const per = issuedInPeriodSql("i", { year, month });
  const yr = issuedInPeriodSql("i", { year, month: "all" });
  const supplyIn = (cond) => db().prepare(`SELECT COALESCE(SUM(i.amount - i.tax_amount),0) AS v FROM invoices i WHERE ${ISSUED} AND ${cond}`).get().v;
  const payoutIn = (cond) => {
    const taskPay = db().prepare(`SELECT COALESCE(SUM(t.worker_rate),0) AS v FROM invoice_items ii JOIN track_tasks t ON t.id = ii.task_id JOIN invoices i ON i.id = ii.invoice_id WHERE ${ISSUED} AND ${cond}`).get().v;
    const sessPay = db().prepare(`SELECT COALESCE(SUM(se.worker_rate),0) AS v FROM invoice_items ii JOIN sessions s ON s.id = ii.session_id JOIN session_engineers se ON se.session_id = s.id JOIN invoices i ON i.id = ii.invoice_id WHERE ${ISSUED} AND ${cond}`).get().v;
    return taskPay + sessPay;
  };
  const periodSupply = supplyIn(per);
  const ytdSupply = supplyIn(yr);
  const monthRows = db().prepare(`SELECT CAST(substr(i.issued_date,6,2) AS INTEGER) AS m, COALESCE(SUM(i.amount - i.tax_amount),0) AS v FROM invoices i WHERE ${ISSUED} AND substr(i.issued_date,1,4) = '${y}' GROUP BY m`).all();
  const byMonth = new Map(monthRows.map((r) => [r.m, r.v]));
  const monthly = Array.from({ length: 12 }, (_, k) => ({ month: k + 1, supply: byMonth.get(k + 1) || 0 }));
  return { periodSupply, periodProfit: periodSupply - payoutIn(per), ytdSupply, ytdProfit: ytdSupply - payoutIn(yr), monthly };
}

// 기존 exports에 병합(옛 revenueByEngineer·revenueForEngineer 유지 — Task 5에서 라우트 교체 후 제거).
module.exports = { revenueByEngineer, revenueForEngineer, issuedInPeriodSql, revenueYears, revenueSummary };
```

- [ ] **Step 4: 통과 확인**

Run: `node --test test/revenue.test.js`
Expected: PASS(4 테스트).

- [ ] **Step 5: 커밋**

```bash
git add src/data/revenue.js test/revenue.test.js
git commit -m "feat(revenue): 기간 매출 요약(공급가·발생 기준)+순이익+월별 추세 데이터"
```

---

### Task 2: 데이터층 — `revenueByStaff` + `revenueForStaff`

**Files:**
- Modify: `src/data/revenue.js`(함수 2종 추가 + module.exports 확장)
- Test: `test/revenue.test.js`(테스트 추가)

**Interfaces:**
- Consumes: `issuedInPeriodSql`·`ISSUED`(Task 1), `listProjectManagers({ includeInactive })`(data.js — `{ id, name, user_id, active }[]`).
- Produces:
  - `revenueByStaff({ year, month })` → `[{ id, name, is_external, supply, profit, task_cnt, session_cnt }]`(supply>0, supply 내림차순)
  - `revenueForStaff(id, { year, month })` → `{ manager, tasks, sessions, supply, payout, profit }` 또는 `null`
    - tasks: `[{ id, task_type, amount, worker_rate, track_title, project_id, project_title, issued_date }]`
    - sessions: `[{ id, session_date, session_type, amount, project_id, project_title, issued_date }]`

- [ ] **Step 1: 실패 테스트 추가** — `test/revenue.test.js` 하단

```js
test("revenueByStaff: 작업(engineer_id)+세션(engineer_name) 매출·순이익·건수, 기간·공급가", () => {
  // 담당자(하우스) 생성
  const mgr = db().prepare("INSERT INTO project_managers (name, active, user_id) VALUES ('김엔지', 1, 1)").run().lastInsertRowid;
  // 그 담당자의 작업이 든 발행 청구서(공급가 100000·외주 30000)
  seedInvoice({ issued: "2026-08-10", payerName: "스탭테스트사", amount: 110000, tax: 10000, workerRate: 30000, engineerId: mgr });
  const rows = D.revenueByStaff({ year: 2026, month: 8 });
  const me = rows.find((r) => r.id === mgr);
  assert.ok(me, "담당자 매출 노출");
  assert.equal(me.supply, 100000, "작업 라인 공급가");
  assert.equal(me.profit, 70000, "순이익 = 100000-30000");
  assert.equal(me.task_cnt, 1, "작업 1건");
  assert.equal(me.is_external, false, "하우스(user_id 있음)");
  // 다른 달 조회 시 제외
  assert.ok(!D.revenueByStaff({ year: 2026, month: 9 }).find((r) => r.id === mgr), "9월엔 없음");
});

test("revenueForStaff: 담당자 상세(기간 작업·세션 + 순이익), 없으면 null", () => {
  const mgr = db().prepare("INSERT INTO project_managers (name, active, user_id) VALUES ('박엔지', 1, 1)").run().lastInsertRowid;
  seedInvoice({ issued: "2026-06-10", payerName: "상세테스트사", amount: 220000, tax: 20000, workerRate: 50000, engineerId: mgr });
  const d = D.revenueForStaff(mgr, { year: 2026, month: 6 });
  assert.equal(d.supply, 200000, "공급가");
  assert.equal(d.payout, 50000, "외주 지급");
  assert.equal(d.profit, 150000, "순이익");
  assert.equal(d.tasks.length, 1, "작업 1건");
  assert.equal(D.revenueForStaff(999999, { year: 2026, month: 6 }), null, "없는 id는 null");
});
```

- [ ] **Step 2: 실패 확인**

Run: `node --test test/revenue.test.js`
Expected: FAIL(`D.revenueByStaff is not a function`).

- [ ] **Step 3: 구현** — `src/data/revenue.js`에 함수 추가(module.exports 앞)

```js
// 스탭(엔지니어)별 매출·순이익. 작업=engineer_id·세션=engineer_name 라인 기준(공급가). 순이익=매출−외주지급.
function revenueByStaff({ year, month }) {
  const { listProjectManagers } = require("../data");
  const per = issuedInPeriodSql("i", { year, month });
  const q = (sql) => db().prepare(sql).all();
  const taskRev = q(`SELECT t.engineer_id AS id, COALESCE(SUM(ii.amount),0) AS supply, COUNT(*) AS cnt FROM invoice_items ii JOIN track_tasks t ON t.id = ii.task_id JOIN invoices i ON i.id = ii.invoice_id WHERE ${ISSUED} AND ${per} AND t.engineer_id IS NOT NULL GROUP BY t.engineer_id`);
  const taskPay = q(`SELECT t.engineer_id AS id, COALESCE(SUM(t.worker_rate),0) AS payout FROM invoice_items ii JOIN track_tasks t ON t.id = ii.task_id JOIN invoices i ON i.id = ii.invoice_id WHERE ${ISSUED} AND ${per} AND t.engineer_id IS NOT NULL GROUP BY t.engineer_id`);
  const sessRev = q(`SELECT s.engineer_name AS name, COALESCE(SUM(ii.amount),0) AS supply, COUNT(*) AS cnt FROM invoice_items ii JOIN sessions s ON s.id = ii.session_id JOIN invoices i ON i.id = ii.invoice_id WHERE ${ISSUED} AND ${per} AND s.engineer_name IS NOT NULL GROUP BY s.engineer_name`);
  const sessPay = q(`SELECT s.engineer_name AS name, COALESCE(SUM(se.worker_rate),0) AS payout FROM invoice_items ii JOIN sessions s ON s.id = ii.session_id JOIN session_engineers se ON se.session_id = s.id JOIN invoices i ON i.id = ii.invoice_id WHERE ${ISSUED} AND ${per} AND s.engineer_name IS NOT NULL GROUP BY s.engineer_name`);
  const trById = new Map(taskRev.map((r) => [r.id, r]));
  const tpById = new Map(taskPay.map((r) => [r.id, r.payout]));
  const srByName = new Map(sessRev.map((r) => [r.name, r]));
  const spByName = new Map(sessPay.map((r) => [r.name, r.payout]));
  return listProjectManagers({ includeInactive: true })
    .map((m) => {
      const tr = trById.get(m.id) || { supply: 0, cnt: 0 };
      const sr = srByName.get(m.name) || { supply: 0, cnt: 0 };
      const supply = (tr.supply || 0) + (sr.supply || 0);
      const payout = (tpById.get(m.id) || 0) + (spByName.get(m.name) || 0);
      return { id: m.id, name: m.name, is_external: !m.user_id, supply, profit: supply - payout, task_cnt: tr.cnt || 0, session_cnt: sr.cnt || 0 };
    })
    .filter((r) => r.supply > 0)
    .sort((a, b) => b.supply - a.supply);
}

// 스탭 상세(기간 작업·세션 + 순이익).
function revenueForStaff(id, { year, month }) {
  const manager = db().prepare("SELECT * FROM project_managers WHERE id = ?").get(Number(id));
  if (!manager) return null;
  const per = issuedInPeriodSql("i", { year, month });
  const tasks = db().prepare(`SELECT t.id, t.task_type, ii.amount AS amount, t.worker_rate, tr.title AS track_title, p.id AS project_id, p.title AS project_title, i.issued_date FROM invoice_items ii JOIN track_tasks t ON t.id = ii.task_id JOIN project_tracks tr ON tr.id = t.track_id JOIN projects p ON p.id = tr.project_id JOIN invoices i ON i.id = ii.invoice_id WHERE ${ISSUED} AND ${per} AND t.engineer_id = ? ORDER BY i.issued_date DESC, p.title COLLATE NOCASE`).all(Number(id));
  const sessions = db().prepare(`SELECT s.id, s.session_date, s.session_type, ii.amount AS amount, p.id AS project_id, p.title AS project_title, i.issued_date FROM invoice_items ii JOIN sessions s ON s.id = ii.session_id JOIN projects p ON p.id = s.project_id JOIN invoices i ON i.id = ii.invoice_id WHERE ${ISSUED} AND ${per} AND s.engineer_name = ? ORDER BY i.issued_date DESC, s.session_date DESC`).all(manager.name);
  const sessPayout = db().prepare(`SELECT COALESCE(SUM(se.worker_rate),0) AS v FROM invoice_items ii JOIN sessions s ON s.id = ii.session_id JOIN session_engineers se ON se.session_id = s.id JOIN invoices i ON i.id = ii.invoice_id WHERE ${ISSUED} AND ${per} AND s.engineer_name = ?`).get(manager.name).v;
  const supply = tasks.reduce((a, t) => a + (t.amount || 0), 0) + sessions.reduce((a, s) => a + (s.amount || 0), 0);
  const payout = tasks.reduce((a, t) => a + (t.worker_rate || 0), 0) + sessPayout;
  return { manager, tasks, sessions, supply, payout, profit: supply - payout };
}
```

`module.exports`를 확장(옛 두 이름 유지): `module.exports = { revenueByEngineer, revenueForEngineer, issuedInPeriodSql, revenueYears, revenueSummary, revenueByStaff, revenueForStaff };`

- [ ] **Step 4: 통과 확인**

Run: `node --test test/revenue.test.js`
Expected: PASS.

- [ ] **Step 5: 커밋**

```bash
git add src/data/revenue.js test/revenue.test.js
git commit -m "feat(revenue): 스탭별 매출·순이익 집계 + 스탭 상세(기간 스코프)"
```

---

### Task 3: 데이터층 — `revenueByPayer` + `revenueForPayer`

**Files:**
- Modify: `src/data/revenue.js`(함수 2종 추가 + exports 확장)
- Test: `test/revenue.test.js`(추가)

**Interfaces:**
- Consumes: `issuedInPeriodSql`·`ISSUED`(Task 1).
- Produces:
  - `revenueByPayer({ year, month })` → `[{ id, kind, name, supply, invoice_cnt }]`(supply 내림차순)
  - `revenueForPayer(id, { year, month })` → `{ party, invoices, supply, invoice_cnt }` 또는 `null`
    - invoices: `[{ id, invoice_number, issued_date, amount, tax_amount, tax_status, status, supply, project_title }]`

- [ ] **Step 1: 실패 테스트 추가**

```js
test("revenueByPayer: 결제자(업체/개인)별 공급가 기여·건수, 기간·kind", () => {
  const { payer } = seedInvoice({ issued: "2026-05-10", payerName: "기여도컴퍼니", amount: 330000, tax: 30000 });
  const rows = D.revenueByPayer({ year: 2026, month: 5 });
  const r = rows.find((x) => x.id === payer);
  assert.ok(r, "결제자 노출");
  assert.equal(r.supply, 300000, "공급가 = 330000-30000");
  assert.equal(r.invoice_cnt, 1, "1건");
  assert.equal(r.kind, "company", "업체 kind");
  assert.equal(r.name, "기여도컴퍼니");
});

test("revenueForPayer: 결제자 상세(기간 발행 청구서 목록), 없으면 null", () => {
  const { payer } = seedInvoice({ issued: "2026-04-10", payerName: "결제자상세사", amount: 110000, tax: 10000 });
  const d = D.revenueForPayer(payer, { year: 2026, month: 4 });
  assert.equal(d.supply, 100000, "공급가 합계");
  assert.equal(d.invoice_cnt, 1, "청구서 1건");
  assert.equal(d.invoices[0].supply, 100000, "라인 supply 파생");
  assert.equal(D.revenueForPayer(999999, { year: 2026, month: 4 }), null, "없는 id는 null");
});
```

- [ ] **Step 2: 실패 확인** — Run: `node --test test/revenue.test.js` → FAIL.

- [ ] **Step 3: 구현** — 함수 추가 + exports 확장

```js
// 결제자(업체·개인)별 매출 기여(공급가)·건수.
function revenueByPayer({ year, month }) {
  const per = issuedInPeriodSql("i", { year, month });
  return db().prepare(`SELECT i.payer_id AS id, c.kind, c.name, COALESCE(SUM(i.amount - i.tax_amount),0) AS supply, COUNT(*) AS invoice_cnt FROM invoices i JOIN parties c ON c.id = i.payer_id WHERE ${ISSUED} AND ${per} AND i.payer_id IS NOT NULL GROUP BY i.payer_id ORDER BY supply DESC`).all();
}

// 결제자 상세(기간 발행 청구서 목록 + 공급가 합계).
function revenueForPayer(id, { year, month }) {
  const party = db().prepare("SELECT * FROM parties WHERE id = ?").get(Number(id));
  if (!party) return null;
  const per = issuedInPeriodSql("i", { year, month });
  // payer_kind = 결제자 kind(현금영수증/계산서 배지용 taxBadge가 inv.payer_kind를 읽음). 전 청구서가 이 party라 party.kind 동일.
  const invoices = db().prepare(`SELECT i.id, i.invoice_number, i.issued_date, i.amount, i.tax_amount, i.tax_status, i.status, (i.amount - i.tax_amount) AS supply, c.kind AS payer_kind, p.title AS project_title FROM invoices i JOIN parties c ON c.id = i.payer_id LEFT JOIN projects p ON p.id = i.project_id WHERE ${ISSUED} AND ${per} AND i.payer_id = ? ORDER BY i.issued_date DESC, i.id DESC`).all(Number(id));
  const supply = invoices.reduce((a, r) => a + (r.supply || 0), 0);
  return { party, invoices, supply, invoice_cnt: invoices.length };
}
```

`module.exports = { revenueByEngineer, revenueForEngineer, issuedInPeriodSql, revenueYears, revenueSummary, revenueByStaff, revenueForStaff, revenueByPayer, revenueForPayer };`(옛 두 이름은 Task 5에서 함께 제거)

- [ ] **Step 4: 통과 확인** — Run: `node --test test/revenue.test.js` → PASS.

- [ ] **Step 5: 전체 스위트 + 커밋**

```bash
node --test test/*.test.js 2>&1 | grep -E "^ℹ (tests|pass|fail)"   # 기존 스위트 회귀 없음(옛 revenueByEngineer 소비처는 Task 5에서 라우트 교체 전이라 아직 안 깨짐: 라우트는 아직 옛 함수 참조 → 이 시점 서버 미기동 테스트만. 전체 pass 확인)
git add src/data/revenue.js test/revenue.test.js
git commit -m "feat(revenue): 업체·개인별 매출 기여 집계 + 결제자 상세"
```

> ⚠️ **주의(구현자)**: 이 태스크까지 `revenue.js`의 옛 `revenueByEngineer`/`revenueForEngineer` 함수·export를 **그대로 둔다**(Task 5에서 라우트를 새 함수로 바꾼 뒤 함께 제거). 지금 지우면 `revenue.routes.js`가 옛 이름을 호출해 스모크 테스트(`/revenue` 200)가 500으로 깨진다. 위 Step 3의 module.exports가 옛 두 이름을 포함하는지 확인.

---

### Task 4: 뷰 — `src/views.revenue.js`(기간 컨트롤·탭·KPI·SVG 차트·표·상세)

**Files:**
- Create: `src/views.revenue.js`
- Modify: `public/css/src.css`(SVG 바 색 클래스)
- Test: `test/revenue-views.test.js`(신설 — 순수 렌더 문자열 계약, DB 불필요)

**Interfaces:**
- Consumes: `views.js`(`esc`·`formatKRW`·`tabBar`·`dataTable`·`emptyState`·`pageHeader`), `views.invoices.js`(`taxBadge` — 결제자 상세 청구 상태 배지, 지연 require).
- Produces(전부 순수 함수, HTML 문자열 반환):
  - `revPeriodControl({ year, month, years, tab })` → `<form>`(년·월 셀렉트 + 보기 버튼, `?tab=`·기간 유지)
  - `revTabs({ tab, year, month })` → `tabBar`(개요/스탭별/업체·개인별, 기간 쿼리 보존)
  - `revBarChart(monthly)` → 인라인 SVG(월별 공급가 바)
  - `revOverview({ summary, topStaff, topPayer, year, month })` → 개요 탭 본문
  - `revStaffTable(rows, { year, month })` → 스탭 순위 표
  - `revPayerTable(rows, { year, month })` → 업체·개인 순위 표
  - `revStaffDetail(data, { year, month })` → 스탭 드릴다운 본문
  - `revPayerDetail(data, { year, month })` → 결제자 드릴다운 본문

- [ ] **Step 1: 실패 테스트 작성** — `test/revenue-views.test.js`

```js
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
```

- [ ] **Step 2: 실패 확인** — Run: `node --test test/revenue-views.test.js` → FAIL(모듈 없음).

- [ ] **Step 3: 구현** — `src/views.revenue.js` 신설

```js
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
```

CSS 추가 — `public/css/src.css`(적당한 위치, 예: `.cl-*` 블록 근처):

```css
/* 매출 월별 추세 SVG 바 차트(2026-07-19) — 색은 CSS 클래스(fill), 인라인 style 금지(CSP·함정 #27). */
.rev-bar { fill: rgb(var(--color-primary)); }
.rev-bar-label { fill: rgb(var(--color-muted)); font-size: 10px; }
```

- [ ] **Step 4: 통과 확인** — Run: `node --test test/revenue-views.test.js` → PASS.

- [ ] **Step 5: CSS 빌드 + 커밋**

```bash
npm run build:css
git add src/views.revenue.js public/css/src.css test/revenue-views.test.js
git commit -m "feat(revenue): 매출 전용 뷰(기간 컨트롤·탭·SVG 차트·순위 표·상세)"
```

---

### Task 5: 라우트 — `/revenue` 탭·기간·드릴다운

**Files:**
- Modify: `src/routes/revenue.routes.js`(전면 재작성)
- Modify: `src/data/revenue.js`(옛 `revenueByEngineer`/`revenueForEngineer` + module.exports에서 제거 — 이제 소비처 없음)
- Test: `test/smoke.test.js`가 이미 `/revenue`를 200 확인(치프 로그인). 추가 라우트 계약은 Task 6 or 스모크에 위임.

**Interfaces:**
- Consumes: `src/data`(`revenueSummary`·`revenueByStaff`·`revenueForStaff`·`revenueByPayer`·`revenueForPayer`·`revenueYears`), `src/views.revenue`(Task 4), `src/views`(`layout`·`pageHeader`·`errorPage`·`esc`), `src/lib/date`(`todayYmd`).

- [ ] **Step 1: 라우트 재작성** — `src/routes/revenue.routes.js`

```js
"use strict";
const express = require("express");
const { requireInvoice } = require("../auth");
const { revenueSummary, revenueByStaff, revenueForStaff, revenueByPayer, revenueForPayer, revenueYears } = require("../data");
const { revPeriodControl, revTabs, revOverview, revStaffTable, revPayerTable, revStaffDetail, revPayerDetail } = require("../views.revenue");
const { layout, pageHeader, esc, errorPage } = require("../views");
const { todayYmd } = require("../lib/date");

const router = express.Router();

// 쿼리 → { year, month }(month='all'|1~12). 기본 = 이번 년·월.
function parsePeriod(req) {
  const now = todayYmd();
  const year = Number(req.query.year) || Number(now.slice(0, 4));
  const month = req.query.month === "all" ? "all" : (Number(req.query.month) || Number(now.slice(5, 7)));
  return { year, month };
}
function periodQS({ year, month }) { return `year=${year}&month=${month === "all" ? "all" : month}`; }

// 매출 메인(탭: 개요/스탭별/업체·개인별).
router.get("/", requireInvoice, (req, res) => {
  const period = parsePeriod(req);
  const tab = ["overview", "staff", "payer"].includes(req.query.tab) ? req.query.tab : "overview";
  const years = revenueYears();
  let content;
  if (tab === "staff") {
    content = revStaffTable(revenueByStaff(period), period);
  } else if (tab === "payer") {
    content = revPayerTable(revenueByPayer(period), period);
  } else {
    const summary = revenueSummary(period);
    const topStaff = revenueByStaff(period).slice(0, 5);
    const topPayer = revenueByPayer(period).slice(0, 5);
    content = revOverview({ summary, topStaff, topPayer, ...period });
  }
  const body = `
    ${pageHeader({ title: "매출", desc: "공급가(VAT 제외)·발행일 기준. 순이익 = 매출 − 외주 지급." })}
    ${revPeriodControl({ ...period, years, tab })}
    ${revTabs({ tab, ...period })}
    <div class="mt-4">${content}</div>`;
  res.send(layout({ title: "매출", user: req.user, current: "/revenue", body }));
});

// 스탭 드릴다운.
router.get("/staff/:id", requireInvoice, (req, res) => {
  const period = parsePeriod(req);
  const data = revenueForStaff(Number(req.params.id), period);
  if (!data) return res.status(404).send(errorPage({ code: 404, title: "스탭을 찾을 수 없습니다", message: "삭제되었거나 주소가 잘못되었습니다.", user: req.user }));
  const desc = data.manager.user_id ? "하우스 엔지니어" : "외주 작업자";
  const body = `
    ${pageHeader({ title: data.manager.name, desc, back: { href: `/revenue?tab=staff&${periodQS(period)}`, label: "매출" } })}
    ${revStaffDetail(data, period)}`;
  res.send(layout({ title: data.manager.name, user: req.user, current: "/revenue", body }));
});

// 결제자(업체·개인) 드릴다운.
router.get("/payer/:id", requireInvoice, (req, res) => {
  const period = parsePeriod(req);
  const data = revenueForPayer(Number(req.params.id), period);
  if (!data) return res.status(404).send(errorPage({ code: 404, title: "청구처를 찾을 수 없습니다", message: "삭제되었거나 주소가 잘못되었습니다.", user: req.user }));
  const body = `
    ${pageHeader({ title: data.party.name, desc: "이 청구처의 기간 매출 기여(공급가).", back: { href: `/revenue?tab=payer&${periodQS(period)}`, label: "매출" } })}
    ${revPayerDetail(data, period)}`;
  res.send(layout({ title: data.party.name, user: req.user, current: "/revenue", body }));
});

module.exports = router;
```

- [ ] **Step 2: 옛 함수 제거** — `src/data/revenue.js`에서 `revenueByEngineer`·`revenueForEngineer` 함수 정의와 module.exports 항목을 삭제. 최종 exports: `module.exports = { issuedInPeriodSql, revenueYears, revenueSummary, revenueByStaff, revenueForStaff, revenueByPayer, revenueForPayer };`

- [ ] **Step 3: 서버 기동 확인(수동)** — 옛 이름 참조가 남았는지 검사

```bash
grep -rn "revenueByEngineer\|revenueForEngineer" src/   # 결과 0줄이어야 함
DEV_LOGIN=1 PORT=3899 DB_PATH=/tmp/rev-smoke.db node src/server.js &   # 기동만 확인(에러 없이 뜨는지)
sleep 2; curl -s -o /dev/null -w "%{http_code}\n" http://localhost:3899/  # 200/302; pkill -f "src/server.js"
```
Expected: grep 0줄, 서버 기동 성공.

- [ ] **Step 4: 전체 스위트(스모크 포함) 통과**

Run: `node --test test/*.test.js 2>&1 | grep -E "^ℹ (tests|pass|fail)"`
Expected: fail 0(스모크 `/revenue` 200 유지 — 스모크는 치프 로그인 후 주요 화면 200 확인).

- [ ] **Step 5: 커밋**

```bash
git add src/routes/revenue.routes.js src/data/revenue.js
git commit -m "feat(revenue): 탭(개요/스탭별/업체·개인별)+기간 컨트롤+드릴다운 라우트, 옛 엔지니어 목록 대체"
```

---

### Task 6: 청구 카드 '매출'→'발행액' 개명 + 문서 현행화

**Files:**
- Modify: `src/routes/invoices.routes.js:128-129`(라벨만)
- Test: `test/invoice-list.test.js`(라우트 소스 문자열 계약 — 있으면 추가)
- Modify: `CLAUDE.md`·`WORKFLOW.md`

**Interfaces:** 없음(라벨 텍스트만 변경, 값·로직 불변).

- [ ] **Step 1: 실패 테스트 추가** — `test/invoice-list.test.js` 하단(라우트 소스 계약 검사 패턴 재사용)

```js
test("청구 overview 카드: '매출'이 아니라 '발행액'(VAT 포함·매출은 매출 화면 전용)", () => {
  const fs = require("fs");
  const src = fs.readFileSync(require("path").join(__dirname, "..", "src", "routes", "invoices.routes.js"), "utf8");
  assert.match(src, /이번 달 발행액/, "이번 달 발행액 라벨");
  assert.match(src, /올해 발행액/, "올해 발행액 라벨");
  assert.doesNotMatch(src, /이번 달 매출|올해 매출/, "'매출'이라는 단어는 청구 카드에서 제거");
});
```

- [ ] **Step 2: 실패 확인** — Run: `node --test test/invoice-list.test.js` → FAIL.

- [ ] **Step 3: 라벨 개명** — `src/routes/invoices.routes.js`의 overview statCard 2줄

```js
      ${statCard(`이번 달 발행액 <span class="font-normal opacity-70">· ${esc(String(Number(thisMonth.slice(5, 7))))}월</span>`, thisMonthIssued)}
      ${statCard(`올해 발행액 <span class="font-normal opacity-70">· ${esc(thisYear)}</span>`, thisYearIssued)}
```
(주석의 '매출'도 '발행액(VAT 포함)'으로 정리 — 위 76·81·120번대 줄 주석.)

- [ ] **Step 4: 통과 확인** — Run: `node --test test/invoice-list.test.js` → PASS.

- [ ] **Step 5: 문서 현행화** — `CLAUDE.md`(매출 섹션 서술 확장·청구 카드 개명 반영·TODO의 '구현 대기'→완료 정리), `WORKFLOW.md`(현재 상태). `HISTORY.md`에 세션 완료 이력 1줄(스펙·구현). 구체 서술은 완료 코드 기준으로.

- [ ] **Step 6: 전체 스위트 + 커밋**

```bash
node --test test/*.test.js 2>&1 | grep -E "^ℹ (tests|pass|fail)"   # fail 0
git add -A
git commit -m "tweak(invoices): overview 카드 '매출'→'발행액'(VAT 포함) + 매출 고도화 문서 현행화"
```

---

## Self-Review (계획 작성자 확인)

**Spec coverage:**
- D1 매출=공급가·발생 → Task 1(supplyIn=amount−tax_amount, ISSUED). ✓
- D2 순이익=매출−외주 → Task 1(payoutIn)·2(staff payout). ✓
- D3 청구 카드 개명 → Task 6. ✓
- D4 접근 requireInvoice → Task 5(전 라우트). ✓
- 기간 컨트롤(년·월·전체) → Task 4 revPeriodControl·Task 5 parsePeriod. ✓
- 개요(KPI·추세·Top) → Task 4 revOverview·revBarChart. ✓
- 스탭별/업체·개인별 표 + 드릴다운 → Task 2·3(데이터)·4(표·상세)·5(라우트). ✓
- SVG 차트·의존성 0·CSP → Task 4(인라인 SVG·CSS fill·인라인 style 없음 테스트). ✓
- v1 근사(할인) → Task 4 개요 note + Global Constraints 명시. ✓
- 테스트 → Task 1~4 TDD + Task 6 계약. ✓

**Placeholder scan:** 없음(모든 코드 스텝에 실제 코드·SQL·assertion 포함). Task 6 문서 스텝은 "완료 코드 기준" 서술 지시(문서 작업 특성상 텍스트).

**Type consistency:**
- `{ year, month }` 시그니처 전 함수 일치. `revenueForStaff/Payer(id, { year, month })` 일치.
- 반환 필드명: staff `{ id, name, is_external, supply, profit, task_cnt, session_cnt }` — 뷰(revStaffTable)·테스트 일치. payer `{ id, kind, name, supply, invoice_cnt }` 일치. summary `{ periodSupply, periodProfit, ytdSupply, ytdProfit, monthly:[{month,supply}] }` 일치.
- `issuedInPeriodSql`·`ISSUED` Task 1 정의 → Task 2·3 사용(같은 파일). ✓
- 뷰 `periodQS`(views.revenue.js 로컬)와 라우트 `periodQS`(routes 로컬) 동일 로직·별개 정의(중복이나 파일 경계 — 허용). ✓

## Out of Scope (스펙과 동일)

입금(cash) 기준·수금률, 라인 단위 할인 안분, 정밀 순이익(원천징수/VAT), CSV 내보내기, 커스텀 기간 범위, 전년 동월 비교.
