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

  await t.test("GET /clients/:id(업체) = 읽기 뷰(사업자번호·계산서 이메일·[편집]·폼 없음)", async () => {
    const { status, html } = await get(`/clients/${companyId}`);
    assert.equal(status, 200);
    assert.match(html, /111-11-11111/, "사업자번호");
    assert.match(html, /계산서 발행 이메일/, "계산서 이메일 라벨");
    assert.match(html, new RegExp(`href="/clients/${companyId}/edit"[^>]*>편집<`), "[편집] 링크");
    assert.ok(!/data-dirty-form/.test(html), "읽기 뷰엔 편집 폼 없음");
    assert.match(html, /data-filter-list/, "왼쪽 목록 유지");
  });

  await t.test("GET /clients/:id(사람) = /contacts/:id로 302", async () => {
    const { status, location } = await raw(`/clients/${personId}`);
    assert.equal(status, 302);
    assert.match(location, new RegExp(`^/contacts/${personId}`));
  });

  await t.test("GET /clients/:id/edit(업체) = 편집 폼(data-dirty-form)+취소", async () => {
    const { status, html } = await get(`/clients/${companyId}/edit`);
    assert.equal(status, 200);
    assert.match(html, /data-dirty-form/, "편집 폼");
    assert.match(html, /data-filter-list/, "왼쪽 목록 유지");
    assert.match(html, /← 취소/, "취소 링크");
  });

  await t.test("GET /clients/:id/edit(그룹) = 멤버 섹션", async () => {
    const { html } = await get(`/clients/${groupId}/edit`);
    assert.match(html, new RegExp(`/clients/${groupId}/members`), "멤버 추가 폼 action");
  });

  await t.test("GET /clients/:id/edit?ferr= = 업로드 오류 메시지 표시", async () => {
    const { html } = await get(`/clients/${companyId}/edit?ferr=${encodeURIComponent("업로드 실패 테스트")}`);
    assert.match(html, /업로드 실패 테스트/, "첨부 오류 메시지가 편집 화면에 표시");
  });

  server.close(); // 서버가 이벤트 루프를 붙잡아 node --test가 안 끝나는 것 방지(contacts-panes와 동일)
  t.after(() => cleanupDb(process.env.DB_PATH, db()));
});
