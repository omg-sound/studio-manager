"use strict";
process.env.NODE_ENV = "test";
process.env.DEV_LOGIN = "1";
process.env.PORT = String(4500 + (process.pid % 300)); // 기존 서버 테스트(settings-email 3500대·smoke 3900~4399대)와 겹치지 않는 대역
const { tempDbPath, cleanupDb } = require("./helpers");
process.env.DB_PATH = tempDbPath();

const test = require("node:test");
const assert = require("node:assert");

test("연락처 2단: 목록/상세/편집 렌더 + 상한 없음", async (t) => {
  const { db, init } = require("../src/db");
  init();
  db().prepare("INSERT INTO users (email, role, name, active) VALUES ('p-chief@t.t','chief','치프',1)").run();
  // 상한(옛 100건)을 넘겨 전 명단이 나오는지 확인 — 120명 시드
  for (let i = 1; i <= 120; i++) {
    db().prepare("INSERT INTO parties (kind, name, phone) VALUES ('person', ?, ?)").run(`외부인${String(i).padStart(3, "0")}`, `010-0000-${String(i).padStart(4, "0")}`);
  }
  const target = db().prepare("SELECT id FROM parties WHERE name = '외부인001'").get().id;

  const server = require("../src/server");
  await new Promise((r) => (server.listening ? r() : server.once("listening", r)));
  const base = `http://127.0.0.1:${server.address().port}`;
  const login = await fetch(base + "/dev-login", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", origin: base, "sec-fetch-site": "same-origin" }, body: "as=chief", redirect: "manual" });
  const cookie = (login.headers.getSetCookie() || []).map((c) => String(c).split(";")[0]).join("; ");
  const get = async (p) => { const r = await fetch(base + p, { headers: { cookie } }); return { status: r.status, html: await r.text() }; };

  await t.test("GET /contacts = 목록 + 빈 패널(선택 없음)", async () => {
    const { status, html } = await get("/contacts");
    assert.equal(status, 200);
    assert.match(html, /data-filter-list/, "이름 목록");
    assert.match(html, /연락처를 선택하세요/, "오른쪽 안내");
    assert.match(html, /<div class="block[^"]*">/, "미선택: 왼쪽 항상 노출");
  });

  await t.test("상한 없음 — 120명 전부 렌더, '더 보기' 없음", async () => {
    const { html } = await get("/contacts");
    const count = (html.match(/외부인\d{3}/g) || []).length;
    assert.equal(count, 120, `전 명단 노출(실제 ${count})`);
    assert.ok(!/더 보기/.test(html), "더 보기 링크 없음");
    assert.ok(!/limit=/.test(html), "limit 링크 없음");
  });

  await t.test("GET /contacts/:id = 목록(선택 강조) + 읽기 뷰", async () => {
    const { status, html } = await get(`/contacts/${target}`);
    assert.equal(status, 200);
    assert.match(html, /data-filter-list/, "왼쪽 목록 유지");
    assert.match(html, /aria-current="true"/, "선택 강조");
    assert.match(html, new RegExp(`href="/contacts/${target}/edit"`), "[편집] 버튼");
    assert.match(html, /010-0000-0001/, "읽기 뷰 전화");
    assert.ok(!/data-dirty-form/.test(html), "읽기 뷰엔 편집 폼 없음");
  });

  await t.test("없는 id = 404", async () => {
    const { status } = await get("/contacts/999999");
    assert.equal(status, 404);
  });

  await t.test("GET /contacts/:id/edit = 목록 + 편집 폼", async () => {
    const { status, html } = await get(`/contacts/${target}/edit`);
    assert.equal(status, 200);
    assert.match(html, /data-filter-list/, "왼쪽 목록 유지");
    assert.match(html, /data-dirty-form/, "편집 폼(dirty 저장)");
    assert.match(html, /name="family_name"/, "이름 필드");
    assert.match(html, /소속 추가 \/ 이직/, "소속 이력 관리");
    assert.match(html, /연락처 삭제/, "삭제는 편집 화면에");
  });

  await t.test("저장하면 읽기 뷰로 복귀", async () => {
    const r = await fetch(`${base}/contacts/${target}`, {
      method: "POST", redirect: "manual",
      headers: { cookie, "content-type": "application/x-www-form-urlencoded", origin: base, "sec-fetch-site": "same-origin" },
      body: new URLSearchParams({ family_name: "외", given_name: "부인001", name: "외부인001", phone: "010-0000-0001" }).toString(),
    });
    assert.equal(r.status, 302);
    assert.match(r.headers.get("location"), new RegExp(`^/contacts/${target}\\?flash=saved`), "읽기 뷰로");
  });

  await t.test("관계자 탭: sel 없으면 목록만, 있으면 읽기 뷰", async () => {
    // 관계자 = 프로젝트 고객측 담당자로 참조된 사람
    const pid = db().prepare("INSERT INTO projects (title, contact_party_id) VALUES ('관계자검증', ?)").run(target).lastInsertRowid;
    db().prepare("INSERT INTO project_contacts (project_id, party_id) VALUES (?, ?)").run(pid, target);

    const none = await get("/clients?group=associate");
    assert.equal(none.status, 200);
    assert.match(none.html, /data-filter-list/, "이름 목록");
    assert.match(none.html, /관계자를 선택하세요/, "오른쪽 안내");

    const sel = await get(`/clients?group=associate&sel=${target}`);
    assert.equal(sel.status, 200);
    assert.match(sel.html, /aria-current="true"/, "선택 강조");
    assert.match(sel.html, new RegExp(`href="/contacts/${target}/edit\\?return=`), "[편집]은 연락처 메뉴로(return 보존)");

    const bad = await get("/clients?group=associate&sel=999999");
    assert.equal(bad.status, 200, "없는 id여도 탭 자체는 유효(404 아님)");
    assert.match(bad.html, /관계자를 선택하세요/);
  });

  server.close();
  t.after(() => cleanupDb(process.env.DB_PATH, db()));
});
