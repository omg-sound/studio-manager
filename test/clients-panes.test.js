"use strict";
process.env.NODE_ENV = "test";
process.env.DEV_LOGIN = "1";
process.env.PORT = String(4800 + (process.pid % 200)); // 다른 서버 테스트 대역과 겹치지 않게(contacts-panes=4500대)
const { tempDbPath, cleanupDb } = require("./helpers");
process.env.DB_PATH = tempDbPath();

const test = require("node:test");
const assert = require("node:assert");

test("업체·그룹 2단: 목록/상세/편집", async (t) => {
  const { db, init } = require("../src/db");
  init();
  db().prepare("INSERT INTO users (email, role, name, active) VALUES ('c-chief@t.t','chief','치프',1)").run();
  const companyId = db().prepare("INSERT INTO parties (kind, name, roles, biz_no, email, phone, address) VALUES ('company', '(주)테스트', '제작사', '111-11-11111', 'a@b.com', '010-1', '서울') ").run().lastInsertRowid;
  const groupId = db().prepare("INSERT INTO parties (kind, name, activity_name) VALUES ('group', '더윈드', '더윈드')").run().lastInsertRowid;
  const personId = db().prepare("INSERT INTO parties (kind, name) VALUES ('person', '홍길동')").run().lastInsertRowid;

  const server = require("../src/server");
  await new Promise((r) => (server.listening ? r() : server.once("listening", r)));
  const base = `http://127.0.0.1:${server.address().port}`;
  const login = await fetch(base + "/dev-login", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", origin: base, "sec-fetch-site": "same-origin" }, body: "as=chief", redirect: "manual" });
  const cookie = (login.headers.getSetCookie() || []).map((c) => String(c).split(";")[0]).join("; ");
  const get = async (p) => { const r = await fetch(base + p, { headers: { cookie } }); return { status: r.status, html: await r.text() }; };
  const raw = async (p) => { const r = await fetch(base + p, { headers: { cookie }, redirect: "manual" }); return { status: r.status, location: r.headers.get("location") }; };

  await t.test("GET /clients = 2단(업체/그룹 탭 + 이름 목록 + 빈 패널)", async () => {
    const { status, html } = await get("/clients?group=company");
    assert.equal(status, 200);
    assert.match(html, /업체 \d+/, "업체 탭 개수");
    assert.match(html, /그룹 \d+/, "그룹 탭 개수");
    assert.match(html, /data-filter-list/, "이름 목록(마스터)");
    assert.match(html, /업체·그룹을 선택하세요/, "빈 패널");
    assert.ok(!/<table class="dt"/.test(html), "표(dataTable) 없음");
  });
  // Task 4·5가 여기 아래에 서브테스트를 추가한다(companyId·groupId·personId·get·raw 재사용).

  server.close(); // 서버가 이벤트 루프를 붙잡아 node --test가 안 끝나는 것 방지(contacts-panes와 동일)
  t.after(() => cleanupDb(process.env.DB_PATH, db()));
});
