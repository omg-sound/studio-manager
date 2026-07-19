"use strict";
process.env.NODE_ENV = "test";
process.env.DEV_LOGIN = "1";
process.env.PORT = String(5000 + (process.pid % 200)); // 다른 서버 테스트와 겹치지 않는 대역(contacts-panes 4500~4799·clients-panes 4800~4999·smoke 3900~4399)
const { tempDbPath, cleanupDb } = require("./helpers");
process.env.DB_PATH = tempDbPath();

const test = require("node:test");
const assert = require("node:assert");

test("매출 마스터-디테일 라우트 계약: 구 드릴다운 리다이렉트 + 미선택 200 + 선택 hidden", async (t) => {
  const { db, init } = require("../src/db");
  init();
  db().prepare("INSERT INTO users (email, role, name, active) VALUES ('rev-chief@t.t','chief','치프',1)").run();
  const mgrId = db().prepare("INSERT INTO project_managers (name) VALUES ('김엔지')").run().lastInsertRowid;
  const payerId = db().prepare("INSERT INTO parties (kind, name) VALUES ('company', '도너츠컬처')").run().lastInsertRowid;
  // revenueByPayer()가 목록에 실으려면 발행 청구서가 있어야 한다(발행 청구서 없는 청구처는 목록에서 빠진다).
  db().prepare("INSERT INTO invoices (title, payer_id, amount, tax_amount, status, issued_date) VALUES ('테스트 청구', ?, 110000, 10000, '발행', '2026-01-15')").run(payerId);
  // revenueByStaff()도 마찬가지로 supply>0인 스탭만 목록에 싣는다(revenue.test.js seedInvoice와 동일 패턴) —
  // 담당자가 청구 라인(작업)을 하나도 안 가지면 마스터 목록에 아예 안 나타나 aria-current 결속 검증이 불가능하다.
  const proj = db().prepare("INSERT INTO projects (title, project_type, rate) VALUES ('P', 'task', 0)").run().lastInsertRowid;
  const trk = db().prepare("INSERT INTO project_tracks (project_id, title, content_type) VALUES (?, '곡', 'Music')").run(proj).lastInsertRowid;
  const taskId = db().prepare("INSERT INTO track_tasks (track_id, task_type, billing_type, quantity, unit_price, total_price, status, is_invoiced, engineer_id) VALUES (?, 'Mixing', 'Fixed_Per_Track', 1, 100000, 100000, 'Completed', 1, ?)").run(trk, mgrId).lastInsertRowid;
  const staffInv = db().prepare("INSERT INTO invoices (project_id, payer_id, title, amount, tax_amount, status, issued_date) VALUES (?, ?, '스탭 청구', 110000, 10000, '발행', '2026-01-15')").run(proj, payerId).lastInsertRowid;
  db().prepare("INSERT INTO invoice_items (invoice_id, task_id, description, quantity, unit_price, amount) VALUES (?, ?, 'Mixing', 1, 100000, 100000)").run(staffInv, taskId);

  const server = require("../src/server");
  await new Promise((r) => (server.listening ? r() : server.once("listening", r)));
  const base = `http://127.0.0.1:${server.address().port}`;
  const login = await fetch(base + "/dev-login", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", origin: base, "sec-fetch-site": "same-origin" }, body: "as=chief", redirect: "manual" });
  const cookie = (login.headers.getSetCookie() || []).map((c) => String(c).split(";")[0]).join("; ");
  const get = async (p) => { const r = await fetch(base + p, { headers: { cookie }, redirect: "manual" }); return { status: r.status, loc: r.headers.get("location"), html: r.status === 200 ? await r.text() : null }; };

  await t.test("구 드릴다운 GET /revenue/staff/:id → 302, 기간 보존 패널 URL로", async () => {
    const { status, loc } = await get(`/revenue/staff/${mgrId}?year=2026&month=6`);
    assert.equal(status, 302);
    assert.equal(loc, `/revenue?tab=staff&staff=${mgrId}&year=2026&month=6`);
  });

  await t.test("구 드릴다운 GET /revenue/payer/:id → 302, 기간 보존 패널 URL로", async () => {
    const { status, loc } = await get(`/revenue/payer/${payerId}?year=2026&month=6`);
    assert.equal(status, 302);
    assert.equal(loc, `/revenue?tab=payer&payer=${payerId}&year=2026&month=6`);
  });

  await t.test("존재하지 않는 큰 id 선택 → 200 미선택 화면(404 아님)", async () => {
    const { status, html } = await get("/revenue?tab=staff&staff=999999&year=2026&month=6");
    assert.equal(status, 200);
    assert.match(html, /스탭을 선택하세요/, "미선택 안내");
    assert.ok(!/name="staff"/.test(html), "미선택은 기간 폼에 staff hidden 없음");
  });

  await t.test("존재하지 않는 큰 payer id 선택 → 200 미선택 화면(404 아님)", async () => {
    const { status, html } = await get("/revenue?tab=payer&payer=999999&year=2026&month=6");
    assert.equal(status, 200);
    assert.match(html, /업체·개인을 선택하세요/, "미선택 안내");
    assert.ok(!/name="payer"/.test(html), "미선택은 기간 폼에 payer hidden 없음");
  });

  // 기간 렌즈 분리(2026-07-19) 이후 목록 탭엔 기간 폼 자체가 없다 — 선택 유지는 hidden 필드가 아니라
  // 마스터 목록의 aria-current(선택 행 강조)로 표현된다.
  await t.test("유효한 스탭 선택 → 목록에서 선택 행이 aria-current로 강조된다", async () => {
    const { status, html } = await get(`/revenue?tab=staff&staff=${mgrId}&year=2026&month=6`);
    assert.equal(status, 200);
    assert.match(html, /김엔지/, "선택된 스탭 이름 렌더");
    // aria-current="page"는 같은 화면의 tabBar(활성 탭)도 렌더하므로, 그 문자열만으로는
    // 목록 행의 선택 강조 로직이 깨져도 통과한다 — 반드시 그 행의 href(?staff=<id>)에 결속.
    assert.match(html, new RegExp(`href="[^"]*staff=${mgrId}"[^>]*aria-current="page"`), "선택한 그 행에 강조가 붙는다");
    assert.ok(!/name="staff"/.test(html), "목록 탭엔 기간 폼 자체가 없어 hidden staff 없음");
  });

  await t.test("유효한 청구처 선택 → 목록에서 선택 행이 aria-current로 강조된다", async () => {
    const { status, html } = await get(`/revenue?tab=payer&payer=${payerId}&year=2026&month=6`);
    assert.equal(status, 200);
    assert.match(html, /도너츠컬처/, "선택된 청구처 이름 렌더");
    // 같은 이유(위 스탭 서브테스트 주석 참조)로 tabBar와 구분되게 그 행의 href(?payer=<id>)에 결속.
    assert.match(html, new RegExp(`href="[^"]*payer=${payerId}"[^>]*aria-current="page"`), "선택한 그 행에 강조가 붙는다");
    assert.ok(!/name="payer"/.test(html), "목록 탭엔 기간 폼 자체가 없어 hidden payer 없음");
  });

  await t.test("개요 탭·미선택 상태엔 staff/payer hidden 없음", async () => {
    const { status, html } = await get("/revenue?tab=overview&year=2026&month=6");
    assert.equal(status, 200);
    assert.ok(!/name="staff"/.test(html) && !/name="payer"/.test(html), "개요 탭엔 선택 hidden 없음");
  });

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

  server.close();
  cleanupDb(process.env.DB_PATH, db());
});
