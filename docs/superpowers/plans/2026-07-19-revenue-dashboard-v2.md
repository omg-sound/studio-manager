# 매출 화면 발전(v2) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development. Steps use checkbox (`- [ ]`) syntax.

**Goal:** 매출 v1을 넓은 경영 대시보드로 발전 — 비교 증감, 매출·순이익 2색 추세, 종류별 구성, 세무 참고.

**Architecture:** `src/data/revenue.js` 확장(summary 비교/월별 순이익 + 신규 byType·tax), `src/views.revenue.js` 확장(2색 차트·델타 배지·종류 구성·세무 카드·대시보드 그리드), 라우트 wide + 조회. 서버 렌더·무JS·인라인 SVG·의존성 0.

**Tech Stack:** Node/Express, better-sqlite3(`db()`), 서버 렌더(`views.js` 헬퍼), `node:test`. 세무=`src/lib/tax.js` `withholding33(gross)→{gross,incomeTax,localTax,total,net}`. 스펙: `docs/superpowers/specs/2026-07-19-revenue-dashboard-v2-design.md`. v1 코드가 이미 리포에 있으니(`src/data/revenue.js`·`src/views.revenue.js`·`src/routes/revenue.routes.js`) 확장 시 기존 패턴을 따른다.

## Global Constraints

- 매출=공급가(`amount−tax_amount`)·발생(`status<>'미발행' AND issued_date`) 기준. 순이익=매출−외주지급(task `track_tasks.worker_rate` + session `session_engineers.worker_rate`). 다인 세션=모델 A(v1 불변).
- 인라인 `style=` 금지(CSP·함정 #27) — SVG 색=CSS 클래스 fill·기하=SVG 속성. 무JS. 의존성 0(외부 차트 없음).
- year/month는 라우트에서 정수 파싱(month='all' 연간) 후 데이터층 전달(정수/고정문자열만 SQL 보간).
- 접근 `requireInvoice`(대표·치프) 불변. 메인 `/revenue`만 `layout({wide:true})`, 드릴다운은 기본 읽기 폭.
- 증감 배지는 **선택 기간 KPI(매출·순이익) 2장에만**(올해 누적 2장은 배지 없음).
- 커밋 메시지 끝: `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`.

## File Structure

- `src/data/revenue.js` — `revenueSummary` 확장(월별 profit + cmp) + 신규 `revenueByType`·`revenueTax`. exports 확장.
- `src/views.revenue.js` — `revBarChart` 2-series 교체 + 신규 `revDeltaBadge`·`revTypeBreakdown`·`revTaxCard` + `revOverview` 그리드 재배치 + 개요 블록 명칭. exports 확장.
- `src/routes/revenue.routes.js` — 개요에서 `revenueByType`·`revenueTax` 조회, `layout({wide:true})`.
- `public/css/src.css` — `.rev-bar-profit`(순이익 막대 색).
- `test/revenue.test.js`·`test/revenue-views.test.js` — 확장.

---

### Task 1: 데이터 — `revenueSummary` 확장(월별 순이익 + 비교) + `revenueTax`

**Files:** Modify `src/data/revenue.js` · Test `test/revenue.test.js`

**Interfaces — Produces:**
- `revenueSummary({year,month})` 확장 → 기존 `{periodSupply,periodProfit,ytdSupply,ytdProfit}` + `monthly:[{month,supply,profit}]` + `cmp:{isYear, prevPeriodSupply, prevPeriodProfit, prevYearSupply|null, prevYearProfit|null}`.
- `revenueTax({year,month})` → `{ vatTotal, payoutTotal, withholding:{gross,incomeTax,localTax,total,net} }`.

- [ ] **Step 1: 실패 테스트 추가** — `test/revenue.test.js` 하단(기존 `seedInvoice` 재사용; `seedInvoice`는 발행 invoice + task 라인 + worker_rate를 만든다)

```js
test("revenueSummary 확장: 월별 순이익 + 전월·전년 비교(cmp)", () => {
  // 2027년으로 격리(다른 테스트와 안 겹치게)
  seedInvoice({ issued: "2027-06-10", payerName: "확장6월", amount: 110000, tax: 10000, workerRate: 30000 }); // 6월 공급가 100000·순이익 70000
  seedInvoice({ issued: "2027-07-10", payerName: "확장7월", amount: 220000, tax: 20000, workerRate: 50000 }); // 7월 공급가 200000·순이익 150000
  seedInvoice({ issued: "2026-07-05", payerName: "확장전년7월", amount: 55000, tax: 5000, workerRate: 0 }); // 전년 7월 공급가 50000·순이익 50000
  const s = D.revenueSummary({ year: 2027, month: 7 });
  assert.equal(s.monthly[6].supply, 200000, "7월 매출");
  assert.equal(s.monthly[6].profit, 150000, "7월 순이익(200000-50000)");
  assert.equal(s.monthly[5].profit, 70000, "6월 순이익");
  assert.equal(s.cmp.isYear, false, "월 선택");
  assert.equal(s.cmp.prevPeriodSupply, 100000, "전월(6월) 매출");
  assert.equal(s.cmp.prevPeriodProfit, 70000, "전월 순이익");
  assert.equal(s.cmp.prevYearSupply, 50000, "전년 동월(2026-07) 매출");
  assert.equal(s.cmp.prevYearProfit, 50000, "전년 동월 순이익");
});

test("revenueSummary 확장: 연간 선택은 전년 전체 비교(prevYear null)", () => {
  const s = D.revenueSummary({ year: 2027, month: "all" });
  assert.equal(s.cmp.isYear, true);
  assert.equal(s.cmp.prevPeriodSupply, D.revenueSummary({ year: 2026, month: "all" }).ytdSupply, "연간 전월비교=전년 전체");
  assert.equal(s.cmp.prevYearSupply, null, "연간은 전년동월 없음");
});

test("revenueTax: VAT 합계 + 외주 원천징수 3.3%", () => {
  const { withholding33 } = require("../src/lib/tax");
  seedInvoice({ issued: "2027-09-10", payerName: "세무테스트", amount: 330000, tax: 30000, workerRate: 100000 });
  const t = D.revenueTax({ year: 2027, month: 9 });
  assert.equal(t.vatTotal, 30000, "VAT 합계=Σtax_amount");
  assert.equal(t.payoutTotal, 100000, "외주 지급 합");
  assert.deepEqual(t.withholding, withholding33(100000), "원천징수=withholding33(외주지급)");
  assert.equal(t.withholding.total, 3300, "3.3% (소득세 3000 + 지방세 300)");
});
```

- [ ] **Step 2: 실패 확인** — `node --test test/revenue.test.js` → FAIL(profit/cmp/revenueTax 없음).

- [ ] **Step 3: 구현** — `src/data/revenue.js`. 먼저 기존 `revenueSummary`를 아래로 교체(월별 payout + cmp 추가). `supplyIn`/`payoutIn`는 기존 그대로 재사용하되 `profitIn` 추가:

```js
function revenueSummary({ year, month }) {
  const y = Number(year);
  const isYear = month === "all" || month == null || month === "";
  const supplyIn = (cond) => db().prepare(`SELECT COALESCE(SUM(i.amount - i.tax_amount),0) AS v FROM invoices i WHERE ${ISSUED} AND ${cond}`).get().v;
  const payoutIn = (cond) => {
    const taskPay = db().prepare(`SELECT COALESCE(SUM(t.worker_rate),0) AS v FROM invoice_items ii JOIN track_tasks t ON t.id = ii.task_id JOIN invoices i ON i.id = ii.invoice_id WHERE ${ISSUED} AND ${cond}`).get().v;
    const sessPay = db().prepare(`SELECT COALESCE(SUM(se.worker_rate),0) AS v FROM invoice_items ii JOIN sessions s ON s.id = ii.session_id JOIN session_engineers se ON se.session_id = s.id JOIN invoices i ON i.id = ii.invoice_id WHERE ${ISSUED} AND ${cond}`).get().v;
    return taskPay + sessPay;
  };
  const profitIn = (cond) => supplyIn(cond) - payoutIn(cond);
  const condOf = (p) => issuedInPeriodSql("i", p);
  const per = condOf({ year, month });
  const yr = condOf({ year, month: "all" });
  const periodSupply = supplyIn(per);
  const ytdSupply = supplyIn(yr);

  // 비교 기간(B1)
  const m = Number(month);
  const prevPeriod = isYear ? { year: y - 1, month: "all" } : (m === 1 ? { year: y - 1, month: 12 } : { year: y, month: m - 1 });
  const prevYear = isYear ? null : { year: y - 1, month: m };
  const cmp = {
    isYear,
    prevPeriodSupply: supplyIn(condOf(prevPeriod)),
    prevPeriodProfit: profitIn(condOf(prevPeriod)),
    prevYearSupply: prevYear ? supplyIn(condOf(prevYear)) : null,
    prevYearProfit: prevYear ? profitIn(condOf(prevYear)) : null,
  };

  // 월별 매출·순이익(B3)
  const groupByMonth = (sql) => new Map(db().prepare(sql).all().map((r) => [r.m, r.v]));
  const supM = groupByMonth(`SELECT CAST(substr(i.issued_date,6,2) AS INTEGER) AS m, COALESCE(SUM(i.amount - i.tax_amount),0) AS v FROM invoices i WHERE ${ISSUED} AND substr(i.issued_date,1,4) = '${y}' GROUP BY m`);
  const taskPayM = groupByMonth(`SELECT CAST(substr(i.issued_date,6,2) AS INTEGER) AS m, COALESCE(SUM(t.worker_rate),0) AS v FROM invoice_items ii JOIN track_tasks t ON t.id = ii.task_id JOIN invoices i ON i.id = ii.invoice_id WHERE ${ISSUED} AND substr(i.issued_date,1,4) = '${y}' GROUP BY m`);
  const sessPayM = groupByMonth(`SELECT CAST(substr(i.issued_date,6,2) AS INTEGER) AS m, COALESCE(SUM(se.worker_rate),0) AS v FROM invoice_items ii JOIN sessions s ON s.id = ii.session_id JOIN session_engineers se ON se.session_id = s.id JOIN invoices i ON i.id = ii.invoice_id WHERE ${ISSUED} AND substr(i.issued_date,1,4) = '${y}' GROUP BY m`);
  const monthly = Array.from({ length: 12 }, (_, k) => {
    const mm = k + 1;
    const sup = supM.get(mm) || 0;
    const pay = (taskPayM.get(mm) || 0) + (sessPayM.get(mm) || 0);
    return { month: mm, supply: sup, profit: sup - pay };
  });

  return { periodSupply, periodProfit: periodSupply - payoutIn(per), ytdSupply, ytdProfit: ytdSupply - payoutIn(yr), monthly, cmp };
}

// 세무 참고(B5): 기간 VAT 합계 + 외주 원천징수 3.3% 예상.
function revenueTax({ year, month }) {
  const { withholding33 } = require("../lib/tax");
  const per = issuedInPeriodSql("i", { year, month });
  const vatTotal = db().prepare(`SELECT COALESCE(SUM(i.tax_amount),0) AS v FROM invoices i WHERE ${ISSUED} AND ${per}`).get().v;
  const taskPay = db().prepare(`SELECT COALESCE(SUM(t.worker_rate),0) AS v FROM invoice_items ii JOIN track_tasks t ON t.id = ii.task_id JOIN invoices i ON i.id = ii.invoice_id WHERE ${ISSUED} AND ${per}`).get().v;
  const sessPay = db().prepare(`SELECT COALESCE(SUM(se.worker_rate),0) AS v FROM invoice_items ii JOIN sessions s ON s.id = ii.session_id JOIN session_engineers se ON se.session_id = s.id JOIN invoices i ON i.id = ii.invoice_id WHERE ${ISSUED} AND ${per}`).get().v;
  const payoutTotal = taskPay + sessPay;
  return { vatTotal, payoutTotal, withholding: withholding33(payoutTotal) };
}
```

`module.exports`에 `revenueTax` 추가(기존 이름 전부 유지).

- [ ] **Step 4: 통과 확인** — `node --test test/revenue.test.js` → PASS.
- [ ] **Step 5: 커밋** — `git add src/data/revenue.js test/revenue.test.js && git commit -m "feat(revenue): summary 월별 순이익·전월/전년 비교 + revenueTax(VAT·원천징수)"`

---

### Task 2: 데이터 — `revenueByType`(종류별 구성)

**Files:** Modify `src/data/revenue.js` · Test `test/revenue.test.js`

**Interfaces — Produces:** `revenueByType({year,month})` → `[{ label, amount }]`(같은 라벨의 작업+세션 매출 합산, amount 내림차순, amount>0).

- [ ] **Step 1: 실패 테스트 추가**

```js
test("revenueByType: 작업+세션 종류별 매출 통합(라벨 합산·정렬)", () => {
  // 작업(믹싱) 라인 + 세션(녹음) 라인 각각 발행
  seedInvoice({ issued: "2027-10-10", payerName: "구성작업", amount: 220000, tax: 20000, workerRate: 0 }); // task 'Mixing' 라인 공급가 200000 (seedInvoice의 task_type='Mixing')
  // 세션 라인 발행(별도)
  const payer = db().prepare("INSERT INTO parties (kind, name) VALUES ('company','구성세션')").run().lastInsertRowid;
  const proj = db().prepare("INSERT INTO projects (title, project_type, rate) VALUES ('CP','session',0)").run().lastInsertRowid;
  const sess = db().prepare("INSERT INTO sessions (project_id, session_type, session_date, status) VALUES (?, '녹음', '2027-10-12', '완료')").run(proj).lastInsertRowid;
  const inv = db().prepare("INSERT INTO invoices (project_id, payer_id, title, amount, tax_amount, status, issued_date) VALUES (?, ?, 'S', 110000, 10000, '발행', '2027-10-12')").run(proj, payer).lastInsertRowid;
  db().prepare("INSERT INTO invoice_items (invoice_id, session_id, description, quantity, unit_price, amount) VALUES (?, ?, '녹음', 1, 100000, 100000)").run(inv, sess);
  const rows = D.revenueByType({ year: 2027, month: 10 });
  const mix = rows.find((r) => r.label === D.taskTypeLabel("Mixing"));
  const rec = rows.find((r) => r.label === "녹음");
  assert.ok(mix && mix.amount === 200000, "믹싱(작업) 200000");
  assert.ok(rec && rec.amount === 100000, "녹음(세션) 100000");
  assert.ok(rows[0].amount >= rows[rows.length - 1].amount, "내림차순");
});
```

- [ ] **Step 2: 실패 확인** — FAIL(`revenueByType` 없음).

- [ ] **Step 3: 구현** — `src/data/revenue.js`

```js
// 종류별 매출 구성(B4): 작업 종류(taskTypeLabel) + 세션 종류(session_type) 통합, 같은 라벨 합산.
function revenueByType({ year, month }) {
  const { taskTypeLabel } = require("../data");
  const per = issuedInPeriodSql("i", { year, month });
  const taskRows = db().prepare(`SELECT t.task_type AS key, COALESCE(SUM(ii.amount),0) AS amount FROM invoice_items ii JOIN track_tasks t ON t.id = ii.task_id JOIN invoices i ON i.id = ii.invoice_id WHERE ${ISSUED} AND ${per} GROUP BY t.task_type`).all();
  const sessRows = db().prepare(`SELECT s.session_type AS label, COALESCE(SUM(ii.amount),0) AS amount FROM invoice_items ii JOIN sessions s ON s.id = ii.session_id JOIN invoices i ON i.id = ii.invoice_id WHERE ${ISSUED} AND ${per} GROUP BY s.session_type`).all();
  const byLabel = new Map();
  const add = (label, amount) => { if (amount > 0) byLabel.set(label, (byLabel.get(label) || 0) + amount); };
  taskRows.forEach((r) => add(taskTypeLabel(r.key), r.amount));
  sessRows.forEach((r) => add(r.label || "세션", r.amount));
  return Array.from(byLabel, ([label, amount]) => ({ label, amount })).sort((a, b) => b.amount - a.amount);
}
```

`module.exports`에 `revenueByType` 추가.

- [ ] **Step 4: 통과 확인** — `node --test test/revenue.test.js` → PASS.
- [ ] **Step 5: 커밋** — `git commit -m "feat(revenue): 종류별 매출 구성(revenueByType — 작업+세션 통합)"`

---

### Task 3: 뷰 — 2색 차트·델타 배지·종류 구성·세무 카드 + CSS

**Files:** Modify `src/views.revenue.js` · Modify `public/css/src.css` · Test `test/revenue-views.test.js`

**Interfaces:**
- Consumes: `esc`·`formatKRW` from `./views`.
- Produces (신규/변경): `revBarChart(monthly)`(2막대·`monthly[k]={month,supply,profit}`), `revDeltaBadge(cur, prev)`, `revTypeBreakdown(rows)`, `revTaxCard(tax)`.

- [ ] **Step 1: 실패 테스트 추가** — `test/revenue-views.test.js`. 기존 `revBarChart` 테스트가 있으면 2막대 형태로 갱신(단일 supply→{supply,profit}).

```js
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
```

- [ ] **Step 2: 실패 확인** — `node --test test/revenue-views.test.js` → FAIL.

- [ ] **Step 3: 구현** — `src/views.revenue.js`. `revBarChart`를 2막대로 교체 + 3 신규 함수. (기존 파일 상단 import·다른 함수는 유지.)

```js
// 월별 매출·순이익 2막대 인라인 SVG(색=CSS 클래스 fill). monthly[k]={month,supply,profit}.
function revBarChart(monthly) {
  const max = Math.max(1, ...monthly.map((m) => m.supply));
  const W = 680, H = 168, base = H - 30, top = 14, n = monthly.length, slot = (W - 8) / n, bw = slot * 0.28;
  const bar = (x, v, cls) => { const h = Math.round((v / max) * (base - top)); return `<rect x="${x.toFixed(1)}" y="${base - h}" width="${bw.toFixed(1)}" height="${h}" rx="2" class="${cls}"><title>${cls === "rev-bar" ? "매출" : "순이익"} ${formatKRW(v)}</title></rect>`; };
  const parts = monthly.map((m, k) => {
    const cx = 4 + k * slot + slot / 2;
    return bar(cx - bw - 1, m.supply, "rev-bar") + bar(cx + 1, m.profit, "rev-bar-profit")
      + `<text x="${cx.toFixed(1)}" y="${H - 14}" text-anchor="middle" class="rev-bar-label">${m.month}</text>`;
  }).join("");
  // 범례
  const legend = `<rect x="8" y="${H - 9}" width="9" height="9" class="rev-bar"/><text x="21" y="${H - 1}" class="rev-bar-label">매출</text>`
    + `<rect x="60" y="${H - 9}" width="9" height="9" class="rev-bar-profit"/><text x="73" y="${H - 1}" class="rev-bar-label">순이익</text>`;
  return `<svg viewBox="0 0 ${W} ${H}" class="w-full" role="img" aria-label="월별 매출·순이익 추세">${parts}${legend}</svg>`;
}

// 비교 증감 배지. prev>0이면 ((cur-prev)/prev*100) 반올림 + ▲/▼ + 색, 아니면 —.
function revDeltaBadge(cur, prev) {
  if (!prev || prev <= 0) return `<span class="text-xs text-muted">—</span>`;
  const pct = Math.round(((cur - prev) / prev) * 100);
  const up = pct >= 0;
  return `<span class="text-xs ${up ? "text-success" : "text-danger"}">${up ? "▲" : "▼"}${Math.abs(pct)}%</span>`;
}

// 종류별 매출 구성 가로 막대(비중 = amount/total). 막대=인라인 SVG(width=pct, viewBox 100 단위).
function revTypeBreakdown(rows) {
  if (!rows.length) return `<div class="card text-sm text-muted">이 기간 매출 구성이 없습니다.</div>`;
  const total = rows.reduce((s, r) => s + r.amount, 0) || 1;
  const items = rows.map((r) => {
    const pct = Math.round((r.amount / total) * 100);
    return `<div class="flex items-center gap-2 py-1">
      <span class="w-20 shrink-0 truncate text-sm">${esc(r.label)}</span>
      <svg viewBox="0 0 100 8" preserveAspectRatio="none" class="h-2 flex-1"><rect x="0" y="0" width="${pct}" height="8" rx="1" class="rev-bar"/></svg>
      <span class="w-10 shrink-0 text-right text-xs text-muted">${pct}%</span>
      <span class="w-24 shrink-0 text-right text-sm tabular">${formatKRW(r.amount)}</span>
    </div>`;
  }).join("");
  return `<div class="card">${items}</div>`;
}

// 세무 참고 카드: VAT 합계 + 외주 원천징수(실지급 병기).
function revTaxCard(tax) {
  const w = tax.withholding;
  return `<div class="card text-sm">
    <div class="mb-1 font-semibold">세무 참고</div>
    <div class="flex justify-between py-0.5"><span class="text-muted">VAT 합계</span><span class="tabular">${formatKRW(tax.vatTotal)}</span></div>
    <div class="flex justify-between py-0.5"><span class="text-muted">외주 지급</span><span class="tabular">${formatKRW(tax.payoutTotal)}</span></div>
    <div class="flex justify-between py-0.5"><span class="text-muted">원천징수(3.3%)</span><span class="tabular text-danger">−${formatKRW(w.total)}</span></div>
    <div class="flex justify-between py-0.5"><span class="text-muted">실지급</span><span class="tabular">${formatKRW(w.net)}</span></div>
    <div class="mt-1 text-xs text-muted">참고용 — 소액부징수·사업자 외주 예외 미반영.</div>
  </div>`;
}
```

`module.exports`에 `revDeltaBadge`·`revTypeBreakdown`·`revTaxCard` 추가(기존 유지).

CSS 추가 — `public/css/src.css`(기존 `.rev-bar` 근처):
```css
.rev-bar-profit { fill: rgb(var(--color-success)); }
```

- [ ] **Step 4: 통과 확인** — `node --test test/revenue-views.test.js` → PASS. `npm run build:css`.
- [ ] **Step 5: 커밋** — `git commit -m "feat(revenue): 2색 차트·델타 배지·종류 구성·세무 카드 뷰"`

---

### Task 4: 뷰+라우트 — 개요 대시보드 그리드(wide) 재배치 + 조회 배선 + 명칭

**Files:** Modify `src/views.revenue.js`(`revOverview`) · Modify `src/routes/revenue.routes.js` · Test `test/revenue-views.test.js`(개요 계약)

**Interfaces — Consumes:** Task 1-3 함수. `revOverview` 시그니처 확장: `revOverview({ summary, topStaff, topPayer, byType, tax, year, month })`.

- [ ] **Step 1: 실패 테스트 추가** — `test/revenue-views.test.js`

```js
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
```

- [ ] **Step 2: 실패 확인** — FAIL.

- [ ] **Step 3: 구현** — `src/views.revenue.js` `revOverview` 교체(대시보드 그리드). KPI는 선택 기간 2장에 `revDeltaBadge`(월: 전월+전년, 연간: 전년만), 누적 2장은 배지 없음. 블록 명칭 변경. `revBarChart`(2색)·`revStaffTable`/`revPayerTable`의 상위 N은 기존 `miniList`(v1) 재사용하되 헤딩만 "스탭별 매출"/"업체·개인별 매출".

```js
function revOverview({ summary, topStaff, topPayer, byType, tax, year, month }) {
  const qs = periodQS({ year, month });
  const periodLabel = month === "all" ? `${year}년 전체` : `${year}년 ${Number(month)}월`;
  const c = summary.cmp;
  const deltas = (curKey, prevKey) => c.isYear
    ? `<div class="mt-0.5">전년 ${revDeltaBadge(summary[curKey], c["prevPeriod" + prevKey])}</div>`
    : `<div class="mt-0.5 flex gap-2"><span>전월 ${revDeltaBadge(summary[curKey], c["prevPeriod" + prevKey])}</span><span>전년 ${revDeltaBadge(summary[curKey], c["prevYear" + prevKey])}</span></div>`;
  const kpi = (label, value, tone, delta) => `<div class="card"><div class="text-sm text-muted">${label}</div><div class="tabular text-xl font-bold ${tone}">${formatKRW(value)}</div>${delta || ""}</div>`;
  const kpis = `<div class="mb-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
    ${kpi(`${esc(periodLabel)} 매출`, summary.periodSupply, "text-fg", deltas("periodSupply", "Supply"))}
    ${kpi(`${esc(periodLabel)} 순이익`, summary.periodProfit, "text-success", deltas("periodProfit", "Profit"))}
    ${kpi("올해 누적 매출", summary.ytdSupply, "text-fg", "")}
    ${kpi("올해 누적 순이익", summary.ytdProfit, "text-success", "")}
  </div>`;
  const chart = `<div class="card"><div class="mb-1 text-sm font-semibold">${esc(year)}년 월별 매출·순이익</div>${revBarChart(summary.monthly)}</div>`;
  const typeSec = `<div><h2 class="mb-2 text-sm font-semibold text-muted">종류별 매출 구성</h2>${revTypeBreakdown(byType)}</div>`;
  const mini = (rows, hrefFn, moreHref, moreLabel) => rows.length
    ? `${rows.map((r) => `<a href="${hrefFn(r)}" class="row-link flex items-center justify-between gap-2 px-3 py-2"><span class="truncate font-medium">${esc(r.name)}</span><span class="tabular font-semibold">${formatKRW(r.supply)}</span></a>`).join("")}<div class="mt-1 text-right"><a href="${moreHref}" class="text-xs text-primary hover:underline">${moreLabel} →</a></div>`
    : `<div class="text-sm text-muted">내역이 없습니다.</div>`;
  const tops = `<div class="grid gap-4 sm:grid-cols-2">
    <div><h2 class="mb-2 text-sm font-semibold text-muted">스탭별 매출</h2><div class="card p-0 overflow-hidden divide-y divide-border">${mini(topStaff, (r) => `/revenue/staff/${r.id}?${qs}`, `/revenue?tab=staff&${qs}`, "전체 보기")}</div></div>
    <div><h2 class="mb-2 text-sm font-semibold text-muted">업체·개인별 매출</h2><div class="card p-0 overflow-hidden divide-y divide-border">${mini(topPayer, (r) => `/revenue/payer/${r.id}?${qs}`, `/revenue?tab=payer&${qs}`, "전체 보기")}</div></div>
  </div>`;
  const note = `<p class="mt-4 text-xs text-muted">매출 = 공급가(VAT 제외)·발행일 기준. 순이익 = 매출 − 외주 지급. 스탭별 매출 합은 청구서 할인 시 총 매출과 다를 수 있음(라인 기준).</p>`;
  // 대시보드 그리드: KPI 한 줄 → [차트 | 세무] → [종류 구성 | Top들]
  return `${kpis}
    <div class="mb-4 grid gap-4 lg:grid-cols-[2fr_1fr]">${chart}${revTaxCard(tax)}</div>
    <div class="grid gap-4 lg:grid-cols-2">${typeSec}${tops}</div>
    ${note}`;
}
```

- [ ] **Step 4: 라우트** — `src/routes/revenue.routes.js`. 개요에서 `revenueByType`·`revenueTax` 조회 + `revOverview`에 전달, 메인 라우트 `layout({wide:true})`.

```js
// import에 revenueByType, revenueTax 추가
const { revenueSummary, revenueByStaff, revenueForStaff, revenueByPayer, revenueForPayer, revenueYears, revenueByType, revenueTax } = require("../data");
```
개요 분기:
```js
  } else {
    const summary = revenueSummary(period);
    const topStaff = revenueByStaff(period).slice(0, 5);
    const topPayer = revenueByPayer(period).slice(0, 5);
    content = revOverview({ summary, topStaff, topPayer, byType: revenueByType(period), tax: revenueTax(period), ...period });
  }
```
메인 `res.send`를 `layout({ title: "매출", user: req.user, current: "/revenue", body, wide: true })`로(드릴다운 2개는 wide 없이 그대로).

- [ ] **Step 5: 통과 확인** — `node --test test/revenue-views.test.js` → PASS. 전체 `node --test test/*.test.js` → fail 0(스모크 `/revenue` 200). 서버 기동 확인(선택).
- [ ] **Step 6: 커밋** — `git commit -m "feat(revenue): 개요 대시보드 그리드(wide)+델타 KPI+구성/세무 배치, 블록 명칭 변경"`

---

## Self-Review (계획 작성자)

**Spec coverage:** A(wide+그리드)=Task4 / B1(증감)=Task1 cmp+Task3 revDeltaBadge+Task4 KPI / B3(2색)=Task1 monthly.profit+Task3 revBarChart / B4(구성)=Task2+Task3 revTypeBreakdown+Task4 / B5(세무)=Task1 revenueTax+Task3 revTaxCard+Task4 / 명칭=Task4. ✓
**Placeholder scan:** 모든 코드 스텝에 실제 코드·SQL·assertion. ✓
**Type consistency:** `revOverview({summary,topStaff,topPayer,byType,tax,year,month})` Task3/4 일치. `monthly[{month,supply,profit}]` Task1↔3. `cmp` 필드명 Task1↔4(`prevPeriodSupply`·`prevYearProfit` 등). `withholding{total,net}` Task1↔3. revBarChart 2막대 시그니처 변경은 Task3에서 기존 테스트 갱신(단일→2막대). ✓
**주의:** `revBarChart`는 v1의 단일-막대에서 2-막대로 **파괴적 변경** — Task3에서 기존 `revBarChart` 테스트(있으면)를 2막대로 갱신, `revOverview`(Task4)가 `summary.monthly`(profit 포함) 전달. v1 `miniList`가 있으면 재사용(없으면 Task4 코드의 `mini` 인라인 사용).

## Out of Scope
순이익률(마진%) 열, 입금 기준, 커스텀 기간, 목표 대비, 라인 할인 안분.
