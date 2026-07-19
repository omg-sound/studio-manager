"use strict";
process.env.NODE_ENV = "test";
process.env.DEV_LOGIN = "1";
process.env.PORT = String(4700 + (process.pid % 300)); // 다른 대역과 충돌 방지(contacts-panes 4500대·smoke 3900~4399대)
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

  await t.test("유효한 스탭 선택 → 기간 폼에 hidden staff 유지", async () => {
    const { status, html } = await get(`/revenue?tab=staff&staff=${mgrId}&year=2026&month=6`);
    assert.equal(status, 200);
    assert.match(html, new RegExp(`<input type="hidden" name="staff" value="${mgrId}"`), "선택 유지 hidden");
    assert.match(html, /김엔지/, "선택된 스탭 이름 렌더");
  });

  await t.test("유효한 청구처 선택 → 기간 폼에 hidden payer 유지", async () => {
    const { status, html } = await get(`/revenue?tab=payer&payer=${payerId}&year=2026&month=6`);
    assert.equal(status, 200);
    assert.match(html, new RegExp(`<input type="hidden" name="payer" value="${payerId}"`), "선택 유지 hidden");
    assert.match(html, /도너츠컬처/, "선택된 청구처 이름 렌더");
  });

  await t.test("개요 탭·미선택 상태엔 staff/payer hidden 없음", async () => {
    const { status, html } = await get("/revenue?tab=overview&year=2026&month=6");
    assert.equal(status, 200);
    assert.ok(!/name="staff"/.test(html) && !/name="payer"/.test(html), "개요 탭엔 선택 hidden 없음");
  });

  server.close();
  cleanupDb(process.env.DB_PATH, db());
});
