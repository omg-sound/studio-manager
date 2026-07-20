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

  // 2026-07-20 사용자 리포트 '연락처에서 처음 선택할 때만 스크롤이 바뀐다'.
  // 목록과 상세가 **같은 스크롤 키**를 받아야 첫 이동에서도 복원된다(app.js가 [data-nav-list] 값을 그대로 쓴다).
  // 옛 방식(app.js가 URL로 키 생성)은 목록 `/contacts`(탭 쿼리 없음) ≠ 상세 `?tab=all`이라 첫 이동만 실패했다.
  await t.test("스크롤 키: 목록과 상세가 같다(첫 이동에서도 복원)", async () => {
    const keyOf = (html) => (html.match(/data-nav-list="([^"]*)"/) || [])[1];
    const list = await get("/contacts");
    const id = Number((list.html.match(/href="\/contacts\/(\d+)/) || [])[1]);
    assert.ok(id, "행이 하나는 있어야 한다");
    const detail = await get(`/contacts/${id}?tab=all`);
    assert.equal(keyOf(list.html), "contacts:all", "목록도 활성 탭(기본 all)을 키에 담는다");
    assert.equal(keyOf(detail.html), keyOf(list.html), "목록·상세 동일 키");
  });

  await t.test("스크롤 키: 탭이 다르면 키도 다르다(탭별로 따로 기억)", async () => {
    const keyOf = (html) => (html.match(/data-nav-list="([^"]*)"/) || [])[1];
    // 행이 없는 탭은 emptyState라 목록 자체가 없다(마커도 없음) → 행이 있는 탭으로 비교한다.
    assert.equal(keyOf((await get("/contacts?tab=associate")).html), "contacts:associate");
    assert.notEqual(keyOf((await get("/contacts?tab=associate")).html), keyOf((await get("/contacts")).html));
  });

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

  await t.test("없는 id 편집 = 404", async () => {
    const { status } = await get("/contacts/999999/edit");
    assert.equal(status, 404);
  });

  await t.test("조직(업체/그룹) id = 404 — 연락처는 사람 전용(상세·편집 모두)", async () => {
    db().prepare("INSERT INTO parties (kind, name) VALUES ('company', '조직테스트')").run();
    const orgId = db().prepare("SELECT id FROM parties WHERE name = '조직테스트'").get().id;
    assert.equal((await get(`/contacts/${orgId}`)).status, 404, "조직 상세는 404");
    assert.equal((await get(`/contacts/${orgId}/edit`)).status, 404, "조직 편집도 404");
  });

  await t.test("편집: 외부 return은 safePath가 걸러 폼·링크에 안 박힌다", async () => {
    const { status, html } = await get(`/contacts/${target}/edit?return=${encodeURIComponent("https://evil.example.com")}`);
    assert.equal(status, 200);
    assert.ok(!/evil\.example\.com/.test(html), "외부 return은 렌더에 남지 않음");
    assert.ok(!/name="return"/.test(html), "hidden return도 세우지 않음(폴백=읽기 뷰)");
  });

  await t.test("좁은 화면 뒤로가기: 선택 있으면 lg:hidden '← 연락처', 목록만이면 없음", async () => {
    const sel = await get(`/contacts/${target}?tab=worker&q=외부인001`);
    assert.match(sel.html, /<a href="\/contacts\?tab=worker&amp;q=[^"]*" class="[^"]*lg:hidden[^"]*">← 연락처<\/a>/, "탭·검색어 보존한 목록으로");
    const list = await get("/contacts?tab=worker");
    assert.ok(!/← 연락처/.test(list.html), "목록만 볼 땐 없음");
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

  await t.test("소속 이력 폼은 편집 화면에 머문다(읽기 뷰로 안 튕김)", async () => {
    const post = async (path, body) => fetch(base + path, {
      method: "POST", redirect: "manual",
      headers: { cookie, "content-type": "application/x-www-form-urlencoded", origin: base, "sec-fetch-site": "same-origin" },
      body: new URLSearchParams(body).toString(),
    });
    // 추가 → 편집 화면 복귀
    const add = await post(`/contacts/${target}/affiliations`, { affiliation_company: "테스트소속사", title: "매니저" });
    assert.equal(add.status, 302);
    assert.match(add.headers.get("location"), new RegExp(`^/contacts/${target}/edit\\?flash=added`), "추가 후 편집 화면");

    const aid = db().prepare("SELECT id FROM affiliations WHERE person_id = ? ORDER BY id DESC").get(target).id;
    // 삭제 → 편집 화면 복귀 + return(관계자 탭) 보존
    const ret = "/contacts?tab=associate";
    const del = await post(`/contacts/${target}/affiliations/${aid}/delete`, { return: ret });
    assert.equal(del.status, 302);
    assert.equal(del.headers.get("location"), `/contacts/${target}/edit?flash=deleted&return=${encodeURIComponent(ret)}`, "삭제 후 편집 화면 + return 보존");
  });

  await t.test("편집 진입 시 return= 실어오면 폼이 hidden으로 보존", async () => {
    const ret = "/contacts?tab=associate";
    const retHtml = ret.replace(/&/g, "&amp;"); // esc()가 & → &amp;로 렌더(HTML 속성값)
    const { status, html } = await get(`/contacts/${target}/edit?return=${encodeURIComponent(ret)}`);
    assert.equal(status, 200);
    assert.ok(html.includes(`name="return" value="${retHtml}"`), "hidden return 보존");
    assert.ok(html.includes(`href="${retHtml}" class="text-sm text-primary hover:underline" data-no-guard>← 취소`), "취소 링크도 return으로");
  });

  await t.test("return을 실어 저장하면 그 관계자 탭으로 복귀", async () => {
    const ret = "/contacts?tab=associate";
    const r = await fetch(`${base}/contacts/${target}`, {
      method: "POST", redirect: "manual",
      headers: { cookie, "content-type": "application/x-www-form-urlencoded", origin: base, "sec-fetch-site": "same-origin" },
      body: new URLSearchParams({ family_name: "외", given_name: "부인001", name: "외부인001", phone: "010-0000-0001", return: ret }).toString(),
    });
    assert.equal(r.status, 302);
    assert.equal(r.headers.get("location"), ret, "관계자 탭으로 복귀(flash 없음)");
  });

  await t.test("open-redirect 차단: 외부 return은 무시하고 읽기 뷰로 폴백", async () => {
    for (const evil of ["https://evil.example.com", "//evil.example.com"]) {
      const r = await fetch(`${base}/contacts/${target}`, {
        method: "POST", redirect: "manual",
        headers: { cookie, "content-type": "application/x-www-form-urlencoded", origin: base, "sec-fetch-site": "same-origin" },
        body: new URLSearchParams({ family_name: "외", given_name: "부인001", name: "외부인001", phone: "010-0000-0001", return: evil }).toString(),
      });
      assert.equal(r.status, 302);
      assert.match(r.headers.get("location"), new RegExp(`^/contacts/${target}\\?flash=saved`), `외부 return(${evil})은 폴백`);
    }
  });

  await t.test("연락처 5탭 — 전체 기본 + 개수 라벨 + 필터 동작", async () => {
    // 아티스트 1명 시드(전체 121 중 1명)
    db().prepare("INSERT INTO parties (kind, name, activity_name, is_artist) VALUES ('person','탭검증아티스트','탭활동명',1)").run();
    const { status, html } = await get("/contacts");
    assert.equal(status, 200);
    ["전체", "아티스트", "관계자", "외주", "스태프"].forEach((label) => assert.match(html, new RegExp(label), `${label} 탭`));
    assert.ok(!/외부 연락처/.test(html), "옛 '외부 연락처' 탭 없음");
    // 기본 = 전체(aria-current가 전체 탭에)
    const activeTab = html.match(/<a[^>]*aria-current="page"[^>]*>([^<]*)</);
    assert.ok(activeTab && /전체/.test(activeTab[1]), `기본 탭이 전체여야 함(현재: ${activeTab && activeTab[1]})`);
    // 아티스트 탭 = 그 1명만
    const artistHtml = (await get("/contacts?tab=artist")).html;
    assert.match(artistHtml, /탭검증아티스트/);
    assert.ok(!/외부인001/.test(artistHtml), "비아티스트는 아티스트 탭에 없음");
    // 모르는 탭 = 전체 폴백
    const bogus = (await get("/contacts?tab=몰라")).html;
    assert.match(bogus, /외부인001/, "모르는 탭은 전체");
  });

  await t.test("업체·그룹: 2탭 + 옛 탭·사람 상세는 연락처로 리다이렉트", async () => {
    const artistId = db().prepare("SELECT id FROM parties WHERE is_artist = 1 AND kind = 'person' LIMIT 1").get().id;
    const raw = async (p) => { const r = await fetch(base + p, { headers: { cookie }, redirect: "manual" }); return { status: r.status, loc: r.headers.get("location") }; };

    const { status, html } = await get("/clients");
    assert.equal(status, 200);
    assert.match(html, /업체 \d+/, "업체 탭");
    assert.match(html, /그룹 \d+/, "그룹 탭");
    assert.ok(!/관계자 \d+/.test(html), "관계자 탭 없음");
    assert.ok(!/아티스트 \d+/.test(html), "아티스트 탭 없음");

    // 옛 탭 → 연락처 필터로(검색어 보존)
    assert.deepEqual(await raw("/clients?group=associate"), { status: 302, loc: "/contacts?tab=associate" });
    assert.deepEqual(await raw("/clients?group=artist"), { status: 302, loc: "/contacts?tab=artist" });
    assert.deepEqual(await raw("/clients?group=artist&q=%EA%B9%80"), { status: 302, loc: "/contacts?tab=artist&q=%EA%B9%80" });

    // 사람 id → 연락처 상세(아티스트도 — 이전엔 아티스트만 클라이언트 상세에 남았다)
    assert.deepEqual(await raw(`/clients/${artistId}`), { status: 302, loc: `/contacts/${artistId}` });

    // '새 클라이언트' 드롭다운 = 업체·그룹만
    assert.ok(!/\/clients\/new\?type=artist/.test(html), "아티스트 생성 폼 링크 없음");
    assert.match(html, /\/clients\/new\?type=company/);
    assert.match(html, /\/clients\/new\?type=group/);
    // 아티스트 생성 폼 경로는 목록으로 되돌린다(사람 생성은 연락처)
    assert.deepEqual(await raw("/clients/new?type=artist"), { status: 302, loc: "/contacts/new" });
  });

  await t.test("POST /clients type=artist는 유지 — 프로젝트 폼 '새 아티스트' 모달 계약", async () => {
    const r = await fetch(base + "/clients", {
      method: "POST",
      headers: { cookie, "content-type": "application/x-www-form-urlencoded", origin: base, "sec-fetch-site": "same-origin", "X-Requested-With": "fetch" },
      body: new URLSearchParams({ type: "artist", name: "모달신규아티스트" }).toString(),
    });
    assert.equal(r.status, 200, "fetch 간이 등록은 JSON 200");
    const j = await r.json();
    assert.ok(j.ok && j.id, "생성된 아티스트 id 반환");
    const row = db().prepare("SELECT kind, is_artist FROM parties WHERE id = ?").get(j.id);
    assert.equal(row.kind, "person");
    assert.equal(row.is_artist, 1);
  });

  await t.test("연락처 편집 폼: '소속' 한 칸 + 활동 형태 없음", async () => {
    const { html } = await get(`/contacts/${target}/edit`);
    assert.match(html, /<label[^>]*>소속/, "'소속' 라벨");
    assert.ok(!/>회사</.test(html), "옛 '회사' 라벨 없음");
    assert.ok(!/activity_form/.test(html), "활동 형태 필드 폐기");
  });

  // 2026-07-18 사용자 요청: 아티스트명은 남의 활동명을 목록에서 고를 게 아니라 이 사람 활동명을 직접 입력.
  await t.test("연락처 폼: 아티스트명은 자유 입력(datalist 없음), 소속 그룹은 검색+간이등록 콤보", async () => {
    const { html } = await get("/contacts/new");
    // 아티스트명 — 옛 datalist('목록에서 선택') 제거
    assert.ok(!/contact-artist-clients/.test(html), "아티스트명 datalist 제거");
    assert.ok(!/목록에서 선택/.test(html), "'목록에서 선택' 안내 없음");
    assert.match(html, /name="nickname"[^>]*placeholder="예: 아티스트 활동명"/, "활동명 자유 입력 placeholder");
    // 소속 그룹 — <select>가 아니라 groupCombo(검색 + 새 그룹 간이 등록)
    assert.ok(!/<select name="group_id"/.test(html), "옛 select 제거");
    assert.match(html, /data-group-combo/, "groupCombo 마커");
    assert.match(html, /<input type="hidden" name="group_id"/, "group_id는 hidden으로 제출(계약 유지)");
    assert.match(html, /새 그룹 등록/, "간이 등록 모달");
  });

  server.close();
  t.after(() => cleanupDb(process.env.DB_PATH, db()));
});

