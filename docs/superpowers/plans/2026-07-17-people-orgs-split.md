# 사람/조직 축 정리 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 분류 축을 하나로 통일한다 — **사람은 연락처(역할 필터 5탭), 조직은 업체·그룹(2탭)**. 사람 상세·편집을 연락처로 일원화하고 화면에서 '클라이언트' 표현을 없앤다.

**Architecture:** 데이터 이동이 없다(`parties` 한 테이블). 순수 화면 정리다. 연락처 라우트가 역할 필터를 갖고, 클라이언트 라우트는 조직만 남기며 사람 경로는 연락처로 리다이렉트한다. 아티스트 폼은 연락처 폼에 흡수되고(중복 필드 삭제 + 소속사=회사 통합), 마지막에 화면 문구를 문맥별로 정리한다.

**Tech Stack:** Node 20 / Express 4(CommonJS) / SQLite / 서버 렌더 HTML(`src/views*.js`) / Tailwind CLI / `node:test` + jsdom

## Global Constraints

- 스펙 원본: `docs/superpowers/specs/2026-07-17-people-orgs-split-design.md`
- **URL·코드 식별자·DB 컬럼은 불변**: `/clients` 경로, `clients.routes.js`·`views.clients.js` 파일명, `listClients`·`clientForm`·`client_id`·`client_files.client_id`. **사용자에게 보이는 문자열만** 바꾼다.
- **`POST /clients` 의 `type=artist` 분기는 유지한다** — 프로젝트 폼의 '새 아티스트' 간이 등록 모달(`public/js/app.js:1731`)이 `fetch("/clients", {type:"artist"})`로 쓰는 살아 있는 계약이다. 메뉴에서 아티스트 **생성 폼**만 없앤다.
- **그룹의 소속사는 유지**한다. `setPartyAgency`는 아티스트·그룹 공용(`type !== "company"`)이므로 아티스트 분기만 걷어낸다.
- CSP: 인라인 `style=`·`<script>`·`onclick` 금지. Tailwind 임의값 클래스는 리터럴, 새로 쓰면 `npm run build:css`.
- 사용자 데이터 `esc()` 필수. `?return=`·`?from=`은 서버에서 `safePath`/안전문자 정규식 검증.
- 커밋 메시지 마지막 줄: `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`
- `npm test`(현재 365개)가 항상 초록이어야 한다. 커밋 전 실행.
- **범위 밖**: 청구처(payer) 로직, 프로젝트 폼 콤보 동작, 업체 첨부, 그룹 멤버 관리 기능, `activity_form` 컬럼 드롭.

## 실측 기준값(프로덕션, 2026-07-17)

탭 개수 검증에 쓴다: 사람 전체 211(외부 202·외주 4·스태프 5) / 아티스트 73 / 관계자 151 / 업체 119 / 그룹 20.
**아티스트 73명·관계자 151명 전원이 이미 연락처에 있고, 22명은 아티스트∩관계자다.**

## File Structure

| 파일 | 책임 |
|---|---|
| `src/data/parties.js` (수정) | `listContacts({tab})`에 역할 필터 5분기 |
| `src/routes/contacts.routes.js` (수정) | 연락처 5탭 렌더(전체 기본) |
| `src/routes/clients.routes.js` (수정) | 조직 2탭·사람/옛탭 리다이렉트·드롭다운 2택·관계자 2단 제거 |
| `src/views.clients.js` (수정) | `clientForm` artist 분기 제거(업체·그룹 전용) |
| `src/routes/contacts.routes.js`(폼 부분) | 연락처 폼 '회사' → **'소속'** |
| `src/views.js`·기타 (수정) | 화면 문구 '클라이언트' 제거(문맥별) |
| `test/party.test.js` (수정) | `listContacts` 필터 계약 |
| `test/contacts-panes.test.js` (수정) | 5탭 렌더·리다이렉트, 관계자 2단 테스트 제거 |
| `test/guardrails-ui.test.js` (수정) | 화면 문구 '클라이언트' 금지 가드 |

---

### Task 1: `listContacts({tab})` — 역할 필터 5분기

**Files:**
- Modify: `src/data/parties.js` (`listContacts`, 730행 근처)
- Test: `test/party.test.js`

**Interfaces:**
- Consumes: 같은 파일의 `ASSOCIATE_ROLE_SUBQUERY`(관계자 역할 참조 서브쿼리 — `listAssociates`가 쓰는 것)
- Produces: `listContacts({ q, tab })` — `tab` ∈ `"all"|"artist"|"associate"|"worker"|"staff"`(그 외/미지정 = 전체). 반환은 기존과 동일(parties 행 배열, 이름 오름차순)

- [ ] **Step 1: 실패하는 테스트 작성**

`test/party.test.js` 끝에 추가:

```js
// ── 연락처 역할 필터(2026-07-17 사람/조직 축 정리) ──
// 탭은 상호배타가 아니라 '필터'다: 전체 ⊇ 아티스트·관계자, 아티스트∩관계자 겹침 정상(겸업).
test("listContacts({tab}): 전체/아티스트/관계자/외주/스태프 필터", () => {
  const d = db();
  // 순수 관계자(프로젝트 고객측 담당자로 참조) · 아티스트 겸 관계자 · 순수 아티스트 · 외주 · 스태프
  const assoc = Number(d.prepare("INSERT INTO parties (kind,name) VALUES ('person','필터관계자')").run().lastInsertRowid);
  const both = Number(d.prepare("INSERT INTO parties (kind,name,activity_name,is_artist) VALUES ('person','필터겸업','겸업활동명',1)").run().lastInsertRowid);
  const pureArtist = Number(d.prepare("INSERT INTO parties (kind,name,activity_name,is_artist) VALUES ('person','필터아티스트','순수활동명',1)").run().lastInsertRowid);
  const pid = Number(d.prepare("INSERT INTO projects (title,project_type) VALUES ('필터검증작','session')").run().lastInsertRowid);
  d.prepare("INSERT INTO project_contacts (project_id,party_id) VALUES (?,?)").run(pid, assoc);
  d.prepare("INSERT INTO project_contacts (project_id,party_id) VALUES (?,?)").run(pid, both); // 겸업: 아티스트인데 담당자 역할도
  const worker = Number(d.prepare("INSERT INTO parties (kind,name) VALUES ('person','필터외주')").run().lastInsertRowid);
  d.prepare("INSERT INTO project_managers (name,party_id,active) VALUES ('필터외주',?,1)").run(worker);
  const uid = Number(d.prepare("INSERT INTO users (email,role,name,active) VALUES ('filter-staff@t.t','staff','필터스태프',1)").run().lastInsertRowid);
  const staff = Number(d.prepare("INSERT INTO parties (kind,name,user_id) VALUES ('person','필터스태프',?)").run(uid).lastInsertRowid);

  const ids = (tab) => new Set(D.listContacts(tab ? { tab } : {}).map((r) => r.id));
  const all = ids("all"), artist = ids("artist"), assocSet = ids("associate"), wrk = ids("worker"), stf = ids("staff");

  // 전체 = 사람 전부(외주·스태프 포함)
  [assoc, both, pureArtist, worker, staff].forEach((id) => assert.ok(all.has(id), `전체에 ${id}`));
  // 아티스트 = is_artist
  assert.ok(artist.has(pureArtist) && artist.has(both), "아티스트 필터");
  assert.ok(!artist.has(assoc), "비아티스트는 아티스트 필터에 없음");
  // 관계자 = 비스태프·비외주 + (비아티스트 or 역할 참조)
  assert.ok(assocSet.has(assoc), "순수 관계자");
  assert.ok(assocSet.has(both), "아티스트 겸 관계자도 관계자 필터에");
  assert.ok(!assocSet.has(pureArtist), "역할 없는 순수 아티스트는 관계자 아님");
  assert.ok(!assocSet.has(worker) && !assocSet.has(staff), "외주·스태프는 관계자 아님");
  // 외주·스태프는 서로 배타
  assert.ok(wrk.has(worker) && !wrk.has(staff), "외주 필터");
  assert.ok(stf.has(staff) && !stf.has(worker), "스태프 필터");
  // 겹침(겸업)은 정상 — 같은 사람이 아티스트·관계자 양쪽에
  assert.ok(artist.has(both) && assocSet.has(both), "겸업자는 두 필터 모두에");
  // 미지정·모르는 값 = 전체 폴백
  assert.equal(ids().size, all.size, "tab 미지정 = 전체");
  assert.equal(ids("몰라").size, all.size, "모르는 tab = 전체");
});

test("listContacts({tab, q}): 검색어와 필터가 함께 걸린다", () => {
  const only = D.listContacts({ tab: "artist", q: "순수활동명" });
  assert.ok(only.length >= 1 && only.every((r) => r.is_artist), "아티스트 필터 + 활동명 검색");
});
```

- [ ] **Step 2: 실패 확인**

Run: `node --test test/party.test.js`
Expected: FAIL — `tab:"artist"`/`"associate"`가 필터되지 않아 전체가 나옴(assert 실패)

- [ ] **Step 3: 구현**

`src/data/parties.js`의 `listContacts`를 교체한다. **관계자 조건은 `listAssociates`와 같은 규칙**을 쓴다(같은 파일 위쪽의 `ASSOCIATE_ROLE_SUBQUERY` 재사용 — 규칙이 갈리면 두 화면이 어긋난다):

```js
/**
 * 사람(person) 목록 — 연락처 메뉴. tab = 역할 **필터**(상호배타 아님, 2026-07-17 사람/조직 축 정리):
 *  - all(기본·모르는 값 폴백) = 사람 전부(외주·스태프 포함)
 *  - artist    = is_artist(아티스트 역할)
 *  - associate = 관계자(비스태프·비외주 + [비아티스트 or 관계자 역할 참조]) — listAssociates와 같은 규칙
 *  - worker    = 외주 작업자 / staff = 로그인 스태프
 * 아티스트이면서 디렉터인 사람은 artist·associate 양쪽에 나온다(겸업 — 설계 의도).
 * 레거시 `staff:true/false`·`tab:"external"`은 폴백으로 흡수(external = 전체로 취급).
 */
function listContacts({ q, tab, staff } = {}) {
  if (staff === true) tab = "staff";
  const where = ["p.kind = 'person'"];
  const args = [];
  const term = String(q || "").trim();
  if (term) { where.push("(p.name LIKE ? OR p.activity_name LIKE ? OR p.phone LIKE ?)"); args.push(`%${term}%`, `%${term}%`, `%${term}%`); }
  const workerSub = "p.id IN (SELECT party_id FROM project_managers WHERE user_id IS NULL AND party_id IS NOT NULL)";
  if (tab === "staff") where.push("p.user_id IS NOT NULL");
  else if (tab === "worker") where.push("p.user_id IS NULL AND " + workerSub);
  else if (tab === "artist") where.push("p.is_artist = 1");
  else if (tab === "associate") {
    where.push("p.user_id IS NULL", "NOT (" + workerSub + ")", `(p.is_artist = 0 OR p.id IN (${ASSOCIATE_ROLE_SUBQUERY}))`);
  }
  const sql = "SELECT p.* FROM parties p WHERE " + where.join(" AND ") + " ORDER BY p.name COLLATE NOCASE";
  return db().prepare(sql).all(...args).map(withLegacy);
}
```

> `ASSOCIATE_ROLE_SUBQUERY`가 `listContacts`보다 아래에 정의돼 있어도 `const` 호이스팅 문제가 없는지 확인할 것(함수 실행 시점에 평가됨). 파일 상단 상수면 그대로 쓴다.

- [ ] **Step 4: 통과 확인**

Run: `node --test test/party.test.js`
Expected: PASS

- [ ] **Step 5: 전체 테스트**

Run: `npm test`
Expected: 전부 통과. `tab:"external"`을 쓰던 기존 호출부는 이제 '전체'를 받는다 — 연락처 라우트는 Task 2에서 바꾼다. 실패가 나면 그 호출부를 보고할 것.

- [ ] **Step 6: 커밋**

```bash
git add src/data/parties.js test/party.test.js
git commit -m "feat(contacts): listContacts에 역할 필터(전체·아티스트·관계자·외주·스태프)

관계자 조건은 listAssociates와 같은 규칙(ASSOCIATE_ROLE_SUBQUERY 재사용).
탭은 상호배타가 아니라 필터 — 아티스트 겸 디렉터는 양쪽에 나온다.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: 연락처 5탭 렌더

**Files:**
- Modify: `src/routes/contacts.routes.js` (`renderContacts` — TABS 307행·tabBar 313행 근처)
- Test: `test/contacts-panes.test.js`

**Interfaces:**
- Consumes: Task 1의 `listContacts({tab})`
- Produces: `/contacts?tab=all|artist|associate|worker|staff`(기본 all)

- [ ] **Step 1: 실패하는 테스트 추가**

`test/contacts-panes.test.js`의 정리 훅(`t.after`) 앞에 추가:

```js
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
```

- [ ] **Step 2: 실패 확인**

Run: `node --test test/contacts-panes.test.js`
Expected: FAIL — '전체'/'아티스트' 탭이 없고 '외부 연락처'가 있음

- [ ] **Step 3: 구현**

`src/routes/contacts.routes.js`의 `renderContacts`에서 탭 정의를 교체한다. **탭 라벨에 개수**를 붙인다(클라이언트 탭과 동일 관례):

```js
  const TABS = ["all", "artist", "associate", "worker", "staff"];
  const tab = TABS.includes(req.query.tab) ? req.query.tab : "all"; // 전체 기본 — 모르는 값(옛 external 포함)도 전체
  const rows = listContacts({ q: q || undefined, tab }); // 상한 없음(2026-07-17)
  const keep = `?tab=${tab}${q ? "&q=" + encodeURIComponent(q) : ""}`;

  // 탭 = 역할 **필터**(상호배타 아님): 전체 ⊇ 아티스트·관계자, 아티스트 겸 디렉터는 양쪽에 나온다.
  const count = (t) => listContacts({ q: q || undefined, tab: t }).length;
  const tabs = tabBar({
    tabs: [
      { key: "all", label: `전체 ${count("all")}` },
      { key: "artist", label: `아티스트 ${count("artist")}` },
      { key: "associate", label: `관계자 ${count("associate")}` },
      { key: "worker", label: `외주 ${count("worker")}` },
      { key: "staff", label: `스태프 ${count("staff")}` },
    ],
    activeKey: tab,
    hrefFn: (k) => `/contacts?tab=${k}${q ? "&q=" + encodeURIComponent(q) : ""}`,
  });
```

빈 목록 안내(`emptyState`)의 탭별 분기도 새 키에 맞춘다:

```js
  const list = rows.length
    ? contactNameList({ rows, selectedId: sel ? sel.id : null, hrefFn: (c) => `/contacts/${c.id}${keep}` })
    : q
      ? emptyState(`"${esc(q)}" 검색 결과가 없습니다.`, { card: true, icon: "clients" })
      : tab === "staff"
        ? emptyState("녹음실 스태프가 없습니다. 환경설정 > 담당자에서 계정을 추가하면 자동 등록됩니다.", { card: true, icon: "clients" })
        : tab === "worker"
          ? emptyState("외주 작업자가 없습니다. 외주 작업자 메뉴에서 추가하면 자동 등록됩니다.", { card: true, icon: "clients" })
          : tab === "artist"
            ? emptyState("아티스트가 없습니다.", { card: true, icon: "clients", cta: { href: "/contacts/new", label: "+ 새 연락처" } })
            : tab === "associate"
              ? emptyState("관계자가 없습니다.", { card: true, icon: "clients", cta: { href: "/contacts/new", label: "+ 새 연락처" } })
              : emptyState("등록된 연락처가 없습니다.", { card: true, icon: "clients", cta: { href: "/contacts/new", label: "+ 새 연락처" } });
```

- [ ] **Step 4: 통과 확인**

Run: `node --test test/contacts-panes.test.js`
Expected: PASS

- [ ] **Step 5: 전체 테스트 + 커밋**

Run: `npm test` → 전부 통과

```bash
git add src/routes/contacts.routes.js test/contacts-panes.test.js
git commit -m "feat(contacts): 5탭(전체·아티스트·관계자·외주·스태프) — 전체 기본

탭은 역할 필터라 겹침이 정상(아티스트 겸 디렉터는 양쪽). 옛 '외부 연락처' 탭은
'전체'로 대체되고, 모르는 tab 값은 전체로 폴백해 옛 링크(?tab=external)도 살아난다.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 3: 업체·그룹 2탭 + 사람·옛탭 리다이렉트

**Files:**
- Modify: `src/routes/clients.routes.js` (탭 화이트리스트 48행·카운트 54~57·tabBar 87~90·드롭다운 248행 근처·사람 리다이렉트 553행 근처)
- Test: `test/contacts-panes.test.js`

**Interfaces:**
- Consumes: Task 2의 `/contacts?tab=` 키
- Produces: `/clients?group=company|group`(기본 company)

- [ ] **Step 1: 실패하는 테스트 추가**

`test/contacts-panes.test.js`의 `t.after` 앞에 추가:

```js
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
```

- [ ] **Step 2: 실패 확인**

Run: `node --test test/contacts-panes.test.js`
Expected: FAIL — 관계자·아티스트 탭이 아직 있고 리다이렉트가 없음

- [ ] **Step 3: 탭·리다이렉트 구현**

`src/routes/clients.routes.js` 목록 라우트 상단(48행 근처)에서 **옛 탭을 먼저 흡수**한 뒤 화이트리스트를 2개로 줄인다:

```js
  // 사람 탭(관계자·아티스트)은 연락처로 이관됨(2026-07-17 사람/조직 축 정리) — 옛 링크·북마크는 그 필터로 보낸다.
  const legacyPeopleTab = { associate: "associate", artist: "artist" }[String(req.query.group || "")];
  if (legacyPeopleTab) {
    const q = String(req.query.q || "").trim();
    return res.redirect(`/contacts?tab=${legacyPeopleTab}${q ? `&q=${encodeURIComponent(q)}` : ""}`);
  }
  const group = ["company", "group"].includes(req.query.group) ? req.query.group : "company"; // 조직 명부 — 업체/그룹
```

카운트·탭바(54~57·87~90행)에서 사람 항목을 제거한다:

```js
  const groupCount = allRows.filter((c) => c.kind === "group").length;
  const companyCount = allRows.filter((c) => c.kind === "company").length;
```

```js
      { key: "company", label: `업체 ${companyCount}` },
      { key: "group", label: `그룹 ${groupCount}` },
```

`artistCount`·`associateCount`·`isSoloArtist`가 다른 곳에서 안 쓰이면 함께 지운다(`grep -n "artistCount\|associateCount\|isSoloArtist" src/routes/clients.routes.js`로 확인).

`GET /clients/new`(280행)에서 아티스트 생성 폼을 연락처로 보낸다:

```js
router.get("/new", (req, res) => {
  if (req.query.type === "artist") return res.redirect("/contacts/new"); // 사람 생성은 연락처(2026-07-17)
  const type = ["company", "group"].includes(req.query.type) ? req.query.type : null;
  if (!type) return res.redirect("/clients"); // 유형 선택 페이지 폐기(드롭다운만)
  ...
});
```

사람 상세 리다이렉트(553행 근처)에서 **아티스트 예외를 없앤다**:

```js
  // 사람은 전부 연락처에서 본다(2026-07-17 사람/조직 축 정리 — 이전엔 비아티스트만 리다이렉트라
  // 같은 사람이 아티스트면 클라이언트 상세, 아니면 연락처로 갈리고 편집 폼도 두 벌이었다).
  if (c.kind === "person") {
```

'새 클라이언트' 드롭다운(248행 근처)에서 **관계자·아티스트 항목을 제거**한다(업체·그룹 두 항목만 남긴다). 사람 생성이 필요하면 연락처 메뉴에서 한다.

- [ ] **Step 4: 통과 확인**

Run: `node --test test/contacts-panes.test.js`
Expected: PASS(위 2개 서브테스트 포함)

- [ ] **Step 5: 전체 테스트 + 커밋**

Run: `npm test`
Expected: 관계자 2단 관련 옛 테스트가 실패할 수 있다 — **그 테스트는 Task 4에서 제거**하므로, 실패가 그것뿐인지 확인하고 보고할 것.

```bash
git add src/routes/clients.routes.js test/contacts-panes.test.js
git commit -m "feat(clients): 조직 명부로 축소 — 업체·그룹 2탭, 사람은 연락처로

- 관계자·아티스트 탭 제거 → /contacts?tab=associate|artist 리다이렉트(q 보존)
- 사람 id로 /clients/:id 진입 시 전부 /contacts/:id로(아티스트 예외 제거)
- /clients/new?type=artist → /contacts/new
- POST /clients type=artist는 유지(프로젝트 폼 '새 아티스트' 모달 계약)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 4: 죽은 렌더 코드 제거(관계자 2단·아티스트 열)

**Files:**
- Modify: `src/routes/clients.routes.js`(관계자 `associatePanes` 분기·아티스트 열 정의·활동 형태 배지·import)
- Modify: `test/contacts-panes.test.js`(관계자 2단 테스트 제거)

**Interfaces:**
- Consumes: 없음
- Produces: 없음(정리)

- [ ] **Step 1: 소비처 확인**

Run: `grep -n "associatePanes\|contactPanes\|contactNameList\|contactReadView\|contactExtras\|activity_form\|ARTIST_ACTIVITY_FORMS\|listAssociates" src/routes/clients.routes.js`
Expected: 관계자 2단 조립부·아티스트 열 분기에만 등장. **`src/views.contacts.js`와 `src/routes/contacts.routes.js`의 사용은 그대로 둔다**(연락처 전용으로 존속).

- [ ] **Step 2: 관계자 2단·아티스트 열 제거**

Task 3에서 관계자·아티스트 탭이 리다이렉트로 흡수됐으므로 이 코드는 도달 불가다. 제거 대상:
- `group === "associate"` 분기 전체(`associatePanes` 조립 — `contactNameList`/`contactReadView`/`contactPanes` 호출, `?sel=` 처리)
- 아티스트 탭 열 정의(`아티스트` cols·활동 형태 배지 계산 `const af = c.activity_form || ...`)
- 그로 인해 안 쓰이는 import: `contactPanes`·`contactNameList`·`contactReadView`·`contactExtras`·`listAssociates`·`ARTIST_ACTIVITY_FORMS`·`listAffiliations`·`listSessionsForParty` 중 **실제로 미사용이 된 것만**(각각 `grep`으로 확인 후 제거 — 다른 분기가 쓰고 있으면 남긴다)
- `test/contacts-panes.test.js`의 "관계자 탭: sel 없으면 목록만, 있으면 읽기 뷰" 테스트 삭제(그 화면이 없어짐)

- [ ] **Step 3: 전체 테스트**

Run: `npm test`
Expected: **전부 통과**(Task 3에서 예상됐던 관계자 2단 테스트 실패가 이 태스크로 해소). 실패가 남으면 보고.

- [ ] **Step 4: 커밋**

```bash
git add src/routes/clients.routes.js test/contacts-panes.test.js
git commit -m "refactor(clients): 관계자 2단·아티스트 열 제거 — 탭 이관으로 도달 불가

연락처가 그 역할을 하므로 렌더 코드는 죽었다. views.contacts.js의 렌더러는
연락처 전용으로 그대로 남는다.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 5: 아티스트 폼 흡수 — 연락처 '소속' 한 칸

**Files:**
- Modify: `src/views.clients.js`(`clientForm` — artist 분기 144~165행 근처)
- Modify: `src/routes/contacts.routes.js`(`contactForm`의 '회사' 라벨)
- Test: `test/party.test.js`(저장 경로 동등성), `test/contacts-panes.test.js`(폼 필드)

**Interfaces:**
- Consumes: 없음
- Produces: `clientForm(...)`은 업체·그룹 전용(`type` ∈ `company|group`)

- [ ] **Step 1: 저장 경로 동등성 테스트 먼저(위험 완화 — 스펙 '위험' 표)**

아티스트 소속사(`setPartyAgency`)와 연락처 회사(`syncCompanyAffiliation`)가 **같은 결과**를 만드는지 고정한다. `test/party.test.js`에 추가:

```js
// ── 2026-07-17: 아티스트 '소속사'와 연락처 '회사'는 같은 데이터(affiliations 현재 소속) ──
// 폼을 '소속' 한 칸으로 합치기 전에 두 저장 경로의 결과 동등성을 고정한다.
test("setPartyAgency와 syncCompanyAffiliation은 같은 현재 소속을 만든다", () => {
  const co = Number(db().prepare("INSERT INTO parties (kind,name) VALUES ('company','소속통합상사')").run().lastInsertRowid);
  const a = Number(db().prepare("INSERT INTO parties (kind,name,is_artist) VALUES ('person','소속아티스트',1)").run().lastInsertRowid);
  const b = Number(db().prepare("INSERT INTO parties (kind,name) VALUES ('person','소속관계자')").run().lastInsertRowid);

  D.setPartyAgency(a, co);                       // 아티스트 폼 경로
  D.syncCompanyAffiliation(b, "소속통합상사", ""); // 연락처 폼 경로(회사명 텍스트)

  const curA = D.currentAffiliation(a), curB = D.currentAffiliation(b);
  assert.equal(curA.org_id ?? curA.client_id, co, "아티스트 경로 → 그 업체가 현재 소속");
  assert.equal(curB.org_id ?? curB.client_id, co, "연락처 경로 → 같은 업체 재사용(새로 만들지 않음)");
  assert.equal(D.listAffiliations(a).filter((x) => !x.ended_on).length, 1, "현재 소속 1건");
  assert.equal(D.listAffiliations(b).filter((x) => !x.ended_on).length, 1, "현재 소속 1건");
});
```

Run: `node --test test/party.test.js`
Expected: PASS(둘 다 이미 `affiliations`를 쓰므로 통과해야 한다). **FAIL이면 통합하지 말고 보고할 것** — 스펙의 전제가 깨진 것이다.

- [ ] **Step 2: 폼 필드 테스트 추가(실패 확인용)**

`test/contacts-panes.test.js`의 `t.after` 앞:

```js
  await t.test("연락처 편집 폼: '소속' 한 칸 + 활동 형태 없음", async () => {
    const { html } = await get(`/contacts/${target}/edit`);
    assert.match(html, /<label[^>]*>소속/, "'소속' 라벨");
    assert.ok(!/>회사</.test(html), "옛 '회사' 라벨 없음");
    assert.ok(!/activity_form/.test(html), "활동 형태 필드 폐기");
  });
```

Run: `node --test test/contacts-panes.test.js`
Expected: FAIL — 아직 '회사' 라벨

- [ ] **Step 3: 연락처 폼 라벨 변경**

`src/routes/contacts.routes.js`의 `contactForm` 안 회사 칸:

```js
        <div><label class="label">소속 <span class="font-normal text-muted text-xs">(회사·소속사 — 검색 · 목록 외 이름은 새 업체 등록)</span></label>${companyCombo("company", c.company || "", "소속사/레이블", "소속")}</div>
```

> `companyCombo(fieldName, value, roleKey, label)` — 넷째 인자가 콤보 placeholder/라벨이다. hidden 필드명(`company`)·저장 경로(`syncCompanyAffiliation`)는 **그대로 둔다**(코드 식별자 불변 원칙).

- [ ] **Step 4: `clientForm`에서 artist 분기 제거**

`src/views.clients.js`:
- `type === "artist"` 블록 **전부 삭제**(현금영수증·활동 형태·소속 그룹)
- 소속사 블록의 조건 `type !== "company"` → **`type === "group"`**(그룹 소속사는 유지 — Global Constraints)
- `type` 계산(113행)을 업체·그룹 2택으로: `const type = formType || (c.kind === "company" ? "company" : "group");`
- 안 쓰이게 된 import(`ARTIST_ACTIVITY_FORMS`·`groupCombo` 등)는 **grep으로 미사용 확인 후** 제거

`src/routes/clients.routes.js`의 `updateParty`/`createGroup` 호출에서 `activity_form: b.activity_form`을 넘기던 줄(371·415행 근처)을 제거한다 — 폼에 필드가 없으므로 항상 undefined이고, `updateParty`는 미전송 필드를 보존하므로 안전하다.

- [ ] **Step 5: 통과 확인**

Run: `node --test test/contacts-panes.test.js test/party.test.js`
Expected: PASS

Run: `npm test`
Expected: 전부 통과. 아티스트 폼을 검증하던 옛 테스트가 있으면 그 화면이 사라졌으므로 삭제하고 보고할 것.

- [ ] **Step 6: 커밋**

```bash
git add src/views.clients.js src/routes/contacts.routes.js src/routes/clients.routes.js test/party.test.js test/contacts-panes.test.js
git commit -m "refactor(clients): 아티스트 폼 흡수 — 연락처 '소속' 한 칸, 활동 형태 폐기

아티스트의 소속사와 연락처의 회사는 같은 데이터(affiliations 현재 소속)라
칸 하나로 합치고 라벨을 '소속'으로. 통합 전 두 저장 경로의 동등성을 테스트로 고정.
활동 형태는 유일한 표시처(아티스트 탭 열)가 사라져 UI 폐기(컬럼은 레거시 보존).
clientForm은 업체·그룹 전용이 되고, 그룹 소속사는 유지.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 6: 화면 용어 정리 — '클라이언트' 제거

**Files:**
- Modify: `src/views.js`(NAV 라벨 151행), `src/routes/clients.routes.js`, `src/views.clients.js`, `src/views.invoices.js`, `src/views.contacts.js`, `src/routes/contacts.routes.js`, `src/routes/invoices.routes.js`, `src/routes/projects.routes.js`, `public/js/app.js` 중 **사용자 노출 문자열만**
- Test: `test/guardrails-ui.test.js`

**Interfaces:**
- Consumes: 없음
- Produces: 없음

- [ ] **Step 1: 문맥별 치환 표(스펙 그대로)**

| 문맥 | 지금 | 바꿀 말 |
|---|---|---|
| 사이드바 메뉴·페이지 제목 | 클라이언트 | **업체·그룹** |
| 백링크 라벨 | 클라이언트 | **업체·그룹** |
| 개별 대상 지칭(수정·삭제·404) | 클라이언트 수정/삭제/찾을 수 없음 | **업체**/**그룹**(유형별) |
| 연락처 읽기 뷰 파생정보 | 대표 클라이언트 | **대표 업체** |
| **청구 맥락**(청구 목록 열·검색 placeholder·발행 오류·청구처 카드 링크) | 클라이언트 | **청구처** |

**절대 바꾸지 않는 것**: URL·함수명·변수명·DB 컬럼·주석·`data-*` 속성·CSS 클래스(`inv-c-client` 등).

- [ ] **Step 2: 후보 전수 확인**

Run: `grep -rn "클라이언트" src/ public/js/app.js`
각 줄이 (a) 사용자 노출 문자열인지 (b) 주석·식별자인지 분류한다. (b)는 건드리지 않는다.

- [ ] **Step 3: 치환**

위 표대로 문자열만 고친다. 주요 지점:
- `src/views.js` NAV: `{ href: "/clients", label: "업체·그룹", key: "clients", ... }`
- `src/routes/clients.routes.js`: 페이지 제목·`새 클라이언트` 버튼(→ `+ 새 업체·그룹` 또는 드롭다운 라벨 `추가`)·빈 상태·404 문구·삭제 confirm
- `src/views.invoices.js`·`src/routes/invoices.routes.js`: 청구 목록 열 라벨·검색 placeholder·발행 오류 → **청구처**
- `src/views.contacts.js`: `대표 클라이언트` → `대표 업체`
- 백링크 라벨 판정(`ret.startsWith("/clients") ? "클라이언트" : ...`) → `"업체·그룹"`

- [ ] **Step 4: 가드 테스트 추가(반복 실수 클래스 → 기계 가드, 함정 #21 정책)**

`test/guardrails-ui.test.js`에 추가:

```js
// ── 2026-07-17 사람/조직 축 정리: 화면 문구에서 '클라이언트' 제거 ──
// 코드 식별자·주석은 그대로 두므로(배포 안정성), **사용자 노출 문자열 리터럴**만 검사한다.
test("가드: 사용자 노출 문자열에 '클라이언트'가 없다", () => {
  const files = ["views.js", "views.clients.js", "views.contacts.js", "views.invoices.js",
    "routes/clients.routes.js", "routes/contacts.routes.js", "routes/invoices.routes.js"];
  const offenders = [];
  files.forEach((f) => {
    const src = fs.readFileSync(path.join(__dirname, "..", "src", f), "utf8");
    src.split("\n").forEach((line, i) => {
      const code = line.replace(/\/\/.*$/, ""); // 주석 제외
      if (!/클라이언트/.test(code)) return;
      // 문자열 리터럴(", ', `) 안의 '클라이언트'만 위반 — 식별자엔 한글이 없으므로 사실상 전부 노출 문구다.
      if (/["'`][^"'`]*클라이언트/.test(code)) offenders.push(`${f}:${i + 1} ${line.trim().slice(0, 80)}`);
    });
  });
  assert.deepEqual(offenders, [], "화면 문구에 '클라이언트' 잔존:\n" + offenders.join("\n"));
});
```

`fs`·`path`가 이미 그 파일에 import돼 있는지 확인하고 없으면 추가한다.

- [ ] **Step 5: 통과 확인**

Run: `node --test test/guardrails-ui.test.js`
Expected: PASS(치환이 끝났으면). 위반이 나오면 그 줄을 표에 따라 고친다.

Run: `npm test`
Expected: 전부 통과. 문구를 검사하던 기존 테스트(예: 백링크 라벨 `"클라이언트"`)가 실패하면 새 문구로 갱신한다.

- [ ] **Step 6: 커밋**

```bash
git add -A
git commit -m "refactor(ui): 화면에서 '클라이언트' 표현 제거 — 문맥별 정리

메뉴·백링크=업체·그룹 / 개별 대상=업체·그룹(유형별) / 대표 클라이언트=대표 업체 /
청구 맥락=청구처(개인도 청구처가 되므로 '업체'로 바꾸면 틀림).
URL·함수명·DB 컬럼·주석은 불변. 재발 방지 가드 테스트 추가.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 7: 실브라우저 검증 + 문서 현행화

**Files:**
- Modify: `CLAUDE.md`(연락처·클라이언트 섹션·스택 표 테스트 수), `HISTORY.md`
- Build: `public/css/app.css`(gitignore — 커밋 대상 아님)

- [ ] **Step 1: CSS 재빌드**

Run: `npm run build:css`
(이번 작업은 새 임의값 클래스를 쓰지 않을 가능성이 높지만, 라벨·탭 변경으로 새 클래스가 생겼을 수 있다.)

- [ ] **Step 2: 실브라우저 검증**

로컬 서버를 띄우고 확인한다. **프로덕션 실측치와 대조**(사람 211·아티스트 73·관계자 151은 프로덕션 기준이므로, 로컬은 시드 기준으로 '전체 ⊇ 아티스트·관계자' 관계만 확인):

1. `/contacts` = 5탭, 전체 기본, 각 탭 개수 라벨
2. 아티스트 탭에서 사람을 열어 **'소속' 수정 → 저장** → 그 업체 상세의 '소속 아티스트'에 반영
3. `/clients` = 업체·그룹 2탭만
4. 옛 링크: `/clients?group=artist` → 연락처 아티스트 탭 / 아티스트 `/clients/:id` → 연락처 상세
5. 프로젝트 폼에서 **'＋ 새 아티스트' 모달로 아티스트 생성**(POST /clients type=artist 계약이 살아 있는지 — 이게 죽으면 프로젝트 작성이 막힌다)
6. 사이드바·페이지에 '클라이언트' 문구가 없는지
7. 1512/390px 가로 오버플로우 0

- [ ] **Step 3: 문서 현행화**

`CLAUDE.md`:
- '연락처' 섹션: 5탭(역할 필터·겹침 정상·전체 기본), 사람 상세·편집 일원화, '소속' 한 칸
- '클라이언트' 섹션: **업체·그룹(조직 명부)**으로 재서술, 관계자·아티스트 탭 제거와 리다이렉트, `POST /clients type=artist` 유지 이유
- 용어: 화면에서 '클라이언트' 제거(청구 맥락='청구처') + 메뉴명 '업체·그룹'
- 활동 형태: UI 폐기(컬럼 레거시)
- 스택 표 테스트 개수 갱신(`npm test` 실제 값)

`HISTORY.md` 맨 위에 이번 작업 요약(중복 실측 수치·근본 원인[축 혼재]·결정 6개·제거 목록·검증)

- [ ] **Step 4: 최종 테스트 + 푸시**

Run: `npm test` → 전부 통과

```bash
git add CLAUDE.md HISTORY.md
git commit -m "docs: 사람/조직 축 정리 반영

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Self-Review

**스펙 커버리지**

| 스펙 항목 | 태스크 |
|---|---|
| 연락처 5탭(전체 기본·겹침 인정) | Task 1(데이터)·Task 2(화면) |
| 업체·그룹 2탭 | Task 3 |
| 옛 탭·사람 id 리다이렉트 | Task 3 |
| '새 클라이언트' 2택 + 아티스트 생성 폼 이관 | Task 3 |
| 아티스트 폼 흡수 · '소속' 라벨 | Task 5 |
| 활동 형태 UI 폐기 | Task 5 |
| 관계자 2단·아티스트 열 제거 | Task 4 |
| 화면 '클라이언트' 제거(문맥별) | Task 6 |
| `POST /clients type=artist` 유지 | Global Constraints + Task 3 테스트 + Task 7 E2E |
| 그룹 소속사 유지 | Global Constraints + Task 5 |
| 저장 경로 동등성 확인 | Task 5 Step 1(통합 **전** 고정) |
| `fillAgency`(그룹→소속사 자동 채움) | **아래 참조** |
| 테스트·문서 | Task 1~7 |

**자체 점검에서 고친 것**
1. `POST /clients` 의 `type=artist`를 지울 뻔했다 — 프로젝트 폼 '새 아티스트' 모달이 쓰는 계약이라 Global Constraints·테스트·E2E 3중으로 못박았다(이게 죽으면 프로젝트 작성이 막힌다).
2. 소속사 블록 조건이 `type !== "company"`라 artist 분기만 지우면 **그룹 소속사까지 사라진다** — Task 5에서 `type === "group"`으로 바꾸도록 명시했다.
3. 스펙의 `fillAgency` 위험: 연락처 폼엔 그룹 select(단순)만 있고 소속사 콤보가 없어 app.js `fillAgency`가 no-op이다. **이번 범위에서 연락처 폼에 그룹→소속 자동 채움을 새로 구현하지 않는다**(YAGNI — 아티스트 폼에서만 쓰이던 편의). Task 5 이후에도 사용자가 '소속'을 직접 고르면 되고, 자동 채움이 필요하면 별도 작업으로 다룬다. 스펙의 해당 위험 줄은 이 결정으로 닫힌다.

**이름 일관성**: `listContacts({q, tab})` 탭 키(`all|artist|associate|worker|staff`)가 Task 1 정의와 Task 2·3 사용처에서 동일하다. `clientForm(..., formType)`의 `type` ∈ `company|group`이 Task 5 정의와 Task 3의 `/clients/new` 화이트리스트와 일치한다.
