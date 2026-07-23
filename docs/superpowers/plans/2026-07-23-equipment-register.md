# 장비 대장 (Equipment Register) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 스튜디오 보유 장비(매입가·시리얼·구매일·장소)를 종류별로 관리하는 가벼운 자산 대장을 추가한다.

**Architecture:** 새 `equipment` 테이블 + 전용 데이터 모듈·뷰·라우트. 연락처·단가표와 같은 마스터데이터 CRUD 패턴을 따른다. 장소는 단일 텍스트 필드(룸/기존 장소값 제안 칩). 목록은 종류별 그룹. 삭제 중심(하드).

**Tech Stack:** Node ≥20, Express 4(CommonJS), SQLite(better-sqlite3/node:sqlite 어댑터), 서버렌더 HTML(`src/views*.js`) + 최소 JS(`public/js/app.js`), node:test.

## Global Constraints

- 돈=정수(원). 금액 파싱 = `parseMoney`(src/lib/forms.js). 날짜 = `'YYYY-MM-DD'` 문자열.
- **보이는 `<input>`에 bare `name="name"`/`"company"`/`"address"` 금지**(Chrome 자동완성 강제 — 가드레일 ①). 장비명 필드 = `name="equipment_name"`, 라우트가 `req.body.equipment_name` 읽음.
- **금액칸 name은 app.js `MONEY` 정규식에 등록돼야 콤마 포맷**(가드레일 ⑫). 매입가 = `name="purchase_price"` → MONEY 정규식에 추가.
- **CSP: 인라인 스크립트·인라인 style 치수 금지**(가드레일 ⑩·⑮). 장소 제안 = datalist 아님(가드레일 ②), 클릭 칩 + app.js 핸들러.
- **사용자 노출 문자열에 '클라이언트' 금지**(가드레일 ⑯) — '장비'·'장소' 용어 사용(무관하나 준수).
- 파괴적 액션은 `logAudit(user, action, target)` 기록(fail-safe).
- 권한: 전 라우트 `requireEditor`(대표·치프·스태프). NAV `access:"editor"`, group `manage`.
- `npm test` 전건 통과 유지. 커밋 메시지 끝에 `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`.

---

## File Structure

- **Create** `src/data/equipment.js` — CRUD + 목록 + 제안(장소·종류). 단일 책임: 장비 데이터.
- **Create** `src/views.equipment.js` — `equipmentList`(종류별 그룹)·`equipmentForm`. 단일 책임: 장비 렌더.
- **Create** `src/routes/equipment.routes.js` — GET 목록/추가/편집, POST 생성/수정/삭제.
- **Create** `test/equipment.test.js` — 데이터 레이어 회귀.
- **Create** `test/equipment-views.test.js` — 뷰 계약 회귀.
- **Modify** `src/db.js` — `CREATE TABLE IF NOT EXISTS equipment`(init 블록, 멱등).
- **Modify** `src/data.js` — `const equipment = require("./data/equipment")` + `...equipment` 재export.
- **Modify** `src/server.js` — 라우터 require + `app.use("/equipment", equipmentRoutes)`(static 앞).
- **Modify** `src/views.js` — NAV 배열에 장비 항목 + 아이콘 SVG.
- **Modify** `public/js/app.js` — `MONEY` 정규식에 `purchase_price` 추가.
- **Modify** `test/smoke.test.js` — `/equipment` 200 + editor 권한.
- **Modify** `CLAUDE.md`·`HISTORY.md` — 정체성 경계 갱신 + 새 섹션 + 세션 이력.

---

## Task 1: 데이터 레이어 — 스키마 + CRUD + 제안

**Files:**
- Modify: `src/db.js` (init 스키마 블록에 CREATE TABLE 추가)
- Create: `src/data/equipment.js`
- Modify: `src/data.js` (재export)
- Test: `test/equipment.test.js`

**Interfaces:**
- Produces:
  - `listEquipment({ q } = {})` → rows[](종류 그룹 순 정렬: 미분류 맨 뒤, 그 안 이름순). q 있으면 name·category·serial_no·location LIKE 필터.
  - `getEquipment(id)` → row | null
  - `createEquipment(input)` → row (name 없으면 throw `EQUIPMENT_NAME_REQUIRED`)
  - `updateEquipment(id, input)` → row (name 없으면 throw)
  - `deleteEquipment(id)` → void
  - `equipmentLocationSuggestions()` → string[](룸 이름 + distinct equipment.location, 중복 제거, 빈 값 제외)
  - `equipmentCategorySuggestions()` → string[](distinct equipment.category, 빈 값 제외, 이름순)
- Consumes: `parseMoney`(src/lib/forms.js), `cleanYmd`(src/lib/forms.js), `listRooms`(src/data/rooms.js).

- [ ] **Step 1: 스키마 추가 (db.js)**

`src/db.js`의 init 스키마 블록에서 `CREATE TABLE IF NOT EXISTS rooms (...)` 바로 뒤에 추가:

```sql
    CREATE TABLE IF NOT EXISTS equipment (
      id             INTEGER PRIMARY KEY AUTOINCREMENT,
      name           TEXT NOT NULL,
      category       TEXT,
      serial_no      TEXT,
      purchase_price INTEGER,
      purchased_on   TEXT,
      location       TEXT,
      memo           TEXT,
      created_at     TEXT NOT NULL DEFAULT (datetime('now'))
    );
```

- [ ] **Step 2: 실패 테스트 작성 (test/equipment.test.js)**

```javascript
"use strict";
process.env.NODE_ENV = "test";
const { tempDbPath, cleanupDb } = require("./helpers");
process.env.DB_PATH = tempDbPath();

const test = require("node:test");
const assert = require("node:assert");
const { db, init } = require("../src/db");
init();
test.after(() => cleanupDb(process.env.DB_PATH, db()));

const {
  createEquipment, getEquipment, updateEquipment, deleteEquipment,
  listEquipment, equipmentLocationSuggestions, equipmentCategorySuggestions,
} = require("../src/data");

test("createEquipment: 장비명만으로 생성, 금액·날짜 파싱, 나머지 선택", () => {
  const e = createEquipment({ equipment_name: "Neumann U87", category: "마이크", serial_no: "SN-123", purchase_price: "3,200,000", purchased_on: "2024-05-10", location: "A룸", memo: "메인 보컬 마이크" });
  assert.ok(e.id);
  assert.strictEqual(e.name, "Neumann U87");
  assert.strictEqual(e.purchase_price, 3200000, "콤마 금액 → 정수");
  assert.strictEqual(e.purchased_on, "2024-05-10");
  assert.strictEqual(e.location, "A룸");
});

test("createEquipment: 장비명 없으면 EQUIPMENT_NAME_REQUIRED", () => {
  assert.throws(() => createEquipment({ equipment_name: "  " }), /EQUIPMENT_NAME_REQUIRED/);
});

test("createEquipment: 매입가·구매일·종류·장소 없이도 생성(오래된 장비)", () => {
  const e = createEquipment({ equipment_name: "정체불명 아웃보드" });
  assert.strictEqual(e.purchase_price, null);
  assert.strictEqual(e.purchased_on, null);
  assert.strictEqual(e.category, null);
});

test("updateEquipment: 필드 갱신, 장비명 없으면 throw", () => {
  const e = createEquipment({ equipment_name: "U47", category: "마이크" });
  const u = updateEquipment(e.id, { equipment_name: "U47 FET", category: "마이크", location: "창고", purchase_price: "5000000" });
  assert.strictEqual(u.name, "U47 FET");
  assert.strictEqual(u.location, "창고");
  assert.strictEqual(u.purchase_price, 5000000);
  assert.throws(() => updateEquipment(e.id, { equipment_name: "" }), /EQUIPMENT_NAME_REQUIRED/);
});

test("deleteEquipment: 하드 삭제", () => {
  const e = createEquipment({ equipment_name: "삭제대상" });
  deleteEquipment(e.id);
  assert.strictEqual(getEquipment(e.id), null);
});

test("listEquipment: 종류 그룹 순 정렬(미분류 맨 뒤), q 필터", () => {
  db().prepare("DELETE FROM equipment").run();
  createEquipment({ equipment_name: "SM7B", category: "마이크" });
  createEquipment({ equipment_name: "1176", category: "아웃보드" });
  createEquipment({ equipment_name: "이름없는종류", category: "" });
  const rows = listEquipment();
  assert.strictEqual(rows[rows.length - 1].name, "이름없는종류", "미분류(빈 종류)는 맨 뒤");
  const filtered = listEquipment({ q: "1176" });
  assert.strictEqual(filtered.length, 1);
  assert.strictEqual(filtered[0].name, "1176");
});

test("equipmentLocationSuggestions: 룸 이름 + 기존 장소값, 중복 제거·빈값 제외", () => {
  db().prepare("DELETE FROM equipment").run();
  db().prepare("INSERT INTO rooms (name, active) VALUES ('A룸', 1)").run();
  createEquipment({ equipment_name: "x", location: "창고" });
  createEquipment({ equipment_name: "y", location: "창고" }); // 중복
  createEquipment({ equipment_name: "z", location: "" });     // 빈값
  const s = equipmentLocationSuggestions();
  assert.ok(s.includes("A룸"), "룸 이름 포함");
  assert.ok(s.includes("창고"), "기존 장소 포함");
  assert.strictEqual(s.filter((v) => v === "창고").length, 1, "중복 1건");
  assert.ok(!s.includes(""), "빈값 제외");
});

test("equipmentCategorySuggestions: distinct 종류, 빈값 제외", () => {
  db().prepare("DELETE FROM equipment").run();
  createEquipment({ equipment_name: "a", category: "마이크" });
  createEquipment({ equipment_name: "b", category: "마이크" });
  createEquipment({ equipment_name: "c", category: "" });
  const s = equipmentCategorySuggestions();
  assert.deepStrictEqual(s, ["마이크"]);
});
```

- [ ] **Step 3: 테스트 실패 확인**

Run: `node --test test/equipment.test.js`
Expected: FAIL — `createEquipment is not a function`

- [ ] **Step 4: 데이터 모듈 구현 (src/data/equipment.js)**

```javascript
"use strict";

/**
 * 장비 대장(equipment) 도메인 — 스튜디오 보유 장비의 참조용 마스터 목록.
 * 판매 재고(stock-flow)가 아니라 자산 대장: 매입가·시리얼·구매일·현재 장소를 CRUD로 관리.
 * data.js에서 분리한 모듈(도메인 모듈화). data.js가 재export하므로 소비자 무변경.
 */

const { db } = require("../db");
const { parseMoney, cleanYmd } = require("../lib/forms");
const { listRooms } = require("./rooms");

/** null/빈 문자열로 정리 — 선택 필드는 빈 입력을 NULL로 저장(빈 문자열 안 남김). */
function blankToNull(v) {
  const s = String(v == null ? "" : v).trim();
  return s || null;
}

/** 폼 입력 → 저장 필드. 장비명 필드는 equipment_name(가드레일 ① — bare name= 회피). */
function equipmentFields(input = {}) {
  const price = parseMoney(input.purchase_price);
  return {
    name: String(input.equipment_name != null ? input.equipment_name : input.name || "").trim(),
    category: blankToNull(input.category),
    serial_no: blankToNull(input.serial_no),
    purchase_price: price > 0 ? price : null, // 0/빈값 = 모름(NULL). parseMoney는 양수만 반환.
    purchased_on: cleanYmd(input.purchased_on), // 형식 불량/빈값 = null
    location: blankToNull(input.location),
    memo: blankToNull(input.memo),
  };
}

function listEquipment({ q } = {}) {
  const params = {};
  let where = "";
  const term = String(q || "").trim();
  if (term) {
    where = `WHERE name LIKE @kw OR IFNULL(category,'') LIKE @kw OR IFNULL(serial_no,'') LIKE @kw OR IFNULL(location,'') LIKE @kw`;
    params.kw = `%${term}%`;
  }
  // 종류 그룹 순(미분류=빈 종류 맨 뒤), 그 안 이름순.
  return db()
    .prepare(`SELECT * FROM equipment ${where} ORDER BY (category IS NULL OR category=''), category COLLATE NOCASE, name COLLATE NOCASE`)
    .all(params);
}

function getEquipment(id) {
  if (!id) return null;
  return db().prepare("SELECT * FROM equipment WHERE id = ?").get(Number(id)) || null;
}

function createEquipment(input = {}) {
  const f = equipmentFields(input);
  if (!f.name) throw new Error("EQUIPMENT_NAME_REQUIRED");
  const info = db()
    .prepare(`INSERT INTO equipment (name, category, serial_no, purchase_price, purchased_on, location, memo)
       VALUES (@name,@category,@serial_no,@purchase_price,@purchased_on,@location,@memo)`)
    .run(f);
  return getEquipment(info.lastInsertRowid);
}

function updateEquipment(id, input = {}) {
  const f = equipmentFields(input);
  if (!f.name) throw new Error("EQUIPMENT_NAME_REQUIRED");
  db()
    .prepare(`UPDATE equipment SET name=@name, category=@category, serial_no=@serial_no,
       purchase_price=@purchase_price, purchased_on=@purchased_on, location=@location, memo=@memo WHERE id=@id`)
    .run({ id: Number(id), ...f });
  return getEquipment(id);
}

function deleteEquipment(id) {
  db().prepare("DELETE FROM equipment WHERE id = ?").run(Number(id));
}

/** 장소 입력 제안 = 등록된 룸 이름 + 이미 쓰인 장소값(중복 제거·빈값 제외). */
function equipmentLocationSuggestions() {
  const rooms = listRooms().map((r) => r.name).filter(Boolean);
  const used = db().prepare("SELECT DISTINCT location FROM equipment WHERE location IS NOT NULL AND TRIM(location) <> ''").all().map((r) => r.location);
  const seen = new Set();
  const out = [];
  for (const v of [...rooms, ...used]) { if (!seen.has(v)) { seen.add(v); out.push(v); } }
  return out;
}

/** 종류 입력 제안 = 이미 쓰인 종류값(중복 제거·빈값 제외·이름순). */
function equipmentCategorySuggestions() {
  return db().prepare("SELECT DISTINCT category FROM equipment WHERE category IS NOT NULL AND TRIM(category) <> '' ORDER BY category COLLATE NOCASE").all().map((r) => r.category);
}

module.exports = {
  listEquipment,
  getEquipment,
  createEquipment,
  updateEquipment,
  deleteEquipment,
  equipmentLocationSuggestions,
  equipmentCategorySuggestions,
};
```

- [ ] **Step 5: data.js 재export**

`src/data.js`에서 require 목록(rooms 근처)에 추가:

```javascript
const equipment = require("./data/equipment"); // 장비 대장(보유 자산 목록)
```

`module.exports` 스프레드에 추가(`...rooms,` 뒤):

```javascript
  ...equipment, // src/data/equipment.js — 장비 대장
```

- [ ] **Step 6: 테스트 통과 확인**

Run: `node --test test/equipment.test.js`
Expected: PASS (8건)

- [ ] **Step 7: 커밋**

```bash
git add src/db.js src/data/equipment.js src/data.js test/equipment.test.js
git commit -m "feat: 장비 대장 데이터 레이어 — equipment 테이블 + CRUD + 장소/종류 제안

$(printf 'Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>')"
```

---

## Task 2: 뷰 — 종류별 그룹 목록 + 폼

**Files:**
- Create: `src/views.equipment.js`
- Test: `test/equipment-views.test.js`

**Interfaces:**
- Consumes: `esc`,`formatKRW`,`searchBox`,`listGroup`,`emptyState`,`dateCombo`(src/views.js). `formatYmdShort`(src/lib/date.js) 필요 시.
- Produces:
  - `equipmentList(rows, { q })` → HTML(검색박스 + 종류별 그룹. 각 그룹 = 헤더(종류 or "미분류") + 행들. 각 행 = 장비명·장소·매입가·구매일. `listGroup` filterList로 실시간 검색. 빈 목록 = emptyState).
  - `equipmentForm(item, { rooms, categories, locations })` → HTML(추가/편집 폼. item=null이면 신규. 필드: equipment_name·category·serial_no·purchase_price·purchased_on·location·memo. 장소·종류 제안 칩. dirty 가드.).

- [ ] **Step 1: 실패 테스트 작성 (test/equipment-views.test.js)**

```javascript
"use strict";
const test = require("node:test");
const assert = require("node:assert");
const { equipmentList, equipmentForm } = require("../src/views.equipment");

test("equipmentList: 종류별 그룹 + 미분류, 검색박스", () => {
  const rows = [
    { id: 1, name: "SM7B", category: "마이크", location: "A룸", purchase_price: 500000, purchased_on: "2024-01-02" },
    { id: 2, name: "U87", category: "마이크", location: "B룸", purchase_price: null, purchased_on: null },
    { id: 3, name: "종류없음", category: null, location: null, purchase_price: null, purchased_on: null },
  ];
  const html = equipmentList(rows, { q: "" });
  assert.match(html, /마이크/, "종류 그룹 헤더");
  assert.match(html, /미분류/, "빈 종류 = 미분류 그룹");
  assert.match(html, /SM7B/);
  assert.match(html, /data-live-filter/, "실시간 검색 입력");
  assert.match(html, /data-filter-list/, "필터 대상 목록");
  assert.match(html, /장소 미지정/, "장소 빈 행 표기");
});

test("equipmentList: 빈 목록이면 emptyState", () => {
  const html = equipmentList([], { q: "" });
  assert.match(html, /장비가 없습니다|등록된 장비/, "빈 안내");
});

test("equipmentForm: 신규 폼 필드 존재(equipment_name·purchase_price 등), dirty 가드", () => {
  const html = equipmentForm(null, { rooms: [{ id: 1, name: "A룸" }], categories: ["마이크"], locations: ["A룸", "창고"] });
  assert.match(html, /name="equipment_name"/, "장비명은 bare name= 회피(가드레일 ①)");
  assert.doesNotMatch(html, /name="name"/, "bare name= 금지");
  assert.match(html, /name="purchase_price"/, "매입가 name = MONEY 정규식 매칭 키");
  assert.match(html, /name="category"/);
  assert.match(html, /name="serial_no"/);
  assert.match(html, /name="location"/);
  assert.match(html, /name="memo"/);
  assert.match(html, /purchased_on/, "구매일 날짜 콤보");
  assert.match(html, /data-dirty-form/, "dirty 저장 가드");
  assert.match(html, /창고/, "장소 제안(기존 값)");
  assert.match(html, /action="\/equipment"/, "신규 = POST /equipment");
});

test("equipmentForm: 편집 폼은 값 프리필 + 삭제 폼 + POST /equipment/:id", () => {
  const item = { id: 7, name: "1176", category: "아웃보드", serial_no: "S1", purchase_price: 2000000, purchased_on: "2023-03-03", location: "랙실", memo: "" };
  const html = equipmentForm(item, { rooms: [], categories: ["아웃보드"], locations: ["랙실"] });
  assert.match(html, /value="1176"/);
  assert.match(html, /action="\/equipment\/7"/, "편집 = POST /equipment/:id");
  assert.match(html, /\/equipment\/7\/delete/, "삭제 폼");
});
```

- [ ] **Step 2: 테스트 실패 확인**

Run: `node --test test/equipment-views.test.js`
Expected: FAIL — `Cannot find module '../src/views.equipment'`

- [ ] **Step 3: 뷰 모듈 구현 (src/views.equipment.js)**

```javascript
"use strict";

/**
 * 장비 대장 렌더 — 종류별 그룹 목록 + 추가/편집 폼.
 * 마스터데이터 CRUD(연락처·단가표) 결. 장소·종류는 제안 칩(클릭 시 입력칸에 채움, app.js).
 */

const { esc, formatKRW, searchBox, listGroup, emptyState, dateCombo } = require("./views");
const { formatYmdShort } = require("./lib/date");

/** 제안 칩 묶음 — 클릭하면 대상 입력칸(sel)에 값을 채운다(app.js [data-fill-target]). */
function suggestChips(values, targetSelector) {
  const chips = (values || []).filter(Boolean).map((v) =>
    `<button type="button" class="badge bg-bg text-muted hover:bg-surface" data-fill-value="${esc(v)}" data-fill-target="${esc(targetSelector)}">${esc(v)}</button>`
  ).join("");
  return chips ? `<div class="mt-1 flex flex-wrap gap-1">${chips}</div>` : "";
}

/** 한 장비 행(목록). 종류는 그룹 헤더에 있으니 행엔 생략, 장소·매입가·구매일. */
function equipmentRow(e) {
  const loc = e.location ? esc(e.location) : `<span class="text-muted">장소 미지정</span>`;
  const price = e.purchase_price != null ? formatKRW(e.purchase_price) : "";
  const bought = e.purchased_on ? esc(formatYmdShort(e.purchased_on)) : "";
  const meta = [bought].filter(Boolean).join("");
  return `<a href="/equipment/${e.id}/edit" class="block px-4 py-3 transition-colors hover:bg-surface active:bg-elevated" data-filter-row>
      <div class="flex items-center justify-between gap-4">
        <div class="min-w-0">
          <div class="truncate font-medium">${esc(e.name)}</div>
          <div class="truncate text-xs text-muted">${loc}${e.serial_no ? ` · ${esc(e.serial_no)}` : ""}</div>
        </div>
        <div class="shrink-0 text-right">
          <div class="tabular text-sm font-semibold">${price}</div>
          <div class="text-xs text-muted tabular">${meta}</div>
        </div>
      </div>
    </a>`;
}

function equipmentList(rows, { q = "" } = {}) {
  const search = searchBox({ action: "/equipment", q, placeholder: "장비명 · 종류 · 시리얼 · 장소 검색", label: "장비 검색", liveFilter: true, noButton: true });
  if (!rows.length) {
    return `${search}${emptyState("등록된 장비가 없습니다. '+ 새 장비'로 추가하세요.", { card: true })}`;
  }
  // 종류별 그룹(listEquipment가 이미 종류 순 정렬 — 연속 그룹핑). 빈 종류 = '미분류'.
  const groups = [];
  let cur = null;
  for (const e of rows) {
    const key = e.category && e.category.trim() ? e.category : "미분류";
    if (!cur || cur.key !== key) { cur = { key, items: [] }; groups.push(cur); }
    cur.items.push(e);
  }
  const body = groups.map((g) =>
    `<div class="mb-4" data-filter-group>
        <h3 class="mb-1 px-1 text-xs font-semibold text-muted">${esc(g.key)} <span class="font-normal">${g.items.length}</span></h3>
        ${listGroup({ rows: g.items.map(equipmentRow), filterList: true })}
      </div>`
  ).join("");
  return `${search}${body}`;
}

function equipmentForm(item, { rooms = [], categories = [], locations = [] } = {}) {
  const e = item || {};
  const isEdit = Boolean(item);
  const action = isEdit ? `/equipment/${e.id}` : "/equipment";
  const val = (v) => (v == null ? "" : esc(String(v)));
  // 장소 제안 = 룸 이름 + 기존 장소값(중복 제거는 데이터 레이어가 하지만 뷰도 방어적으로 Set).
  const roomNames = rooms.map((r) => r.name);
  const locSeen = new Set();
  const locSuggest = [...roomNames, ...locations].filter((v) => v && !locSeen.has(v) && locSeen.add(v));
  const del = isEdit
    ? `<form method="post" action="/equipment/${e.id}/delete" data-confirm="이 장비를 대장에서 삭제할까요?"><button class="btn-ghost btn-sm text-danger">삭제</button></form>`
    : "";
  return `<form method="post" action="${action}" class="space-y-3" data-dirty-form>
      <div>
        <label class="label mb-1 text-xs">장비명 <span class="text-danger">*</span></label>
        <input class="input" name="equipment_name" value="${val(e.name)}" autocomplete="off" required />
      </div>
      <div>
        <label class="label mb-1 text-xs">종류</label>
        <input class="input" name="category" value="${val(e.category)}" autocomplete="off" data-equip-category placeholder="예: 마이크 · 프리앰프 · 아웃보드" />
        ${suggestChips(categories, "[data-equip-category]")}
      </div>
      <div class="grid gap-3 sm:grid-cols-2">
        <div>
          <label class="label mb-1 text-xs">시리얼/제품번호</label>
          <input class="input" name="serial_no" value="${val(e.serial_no)}" autocomplete="off" />
        </div>
        <div>
          <label class="label mb-1 text-xs">매입가</label>
          <div class="relative">
            <input class="input pr-7 text-right tabular" type="text" inputmode="numeric" name="purchase_price" value="${e.purchase_price != null ? esc(String(e.purchase_price)) : ""}" placeholder="0" />
            <span class="pointer-events-none absolute inset-y-0 right-2 flex items-center text-xs text-muted">원</span>
          </div>
        </div>
      </div>
      <div class="grid gap-3 sm:grid-cols-2">
        <div>
          <label class="label mb-1 text-xs">구매 시기</label>
          ${dateCombo("purchased_on", e.purchased_on || "", { label: "구매 시기", inputCls: "input w-full py-1.5 text-sm" })}
        </div>
        <div>
          <label class="label mb-1 text-xs">현재 장소</label>
          <input class="input" name="location" value="${val(e.location)}" autocomplete="off" data-equip-location placeholder="룸을 고르거나 직접 입력" />
          ${suggestChips(locSuggest, "[data-equip-location]")}
        </div>
      </div>
      <div>
        <label class="label mb-1 text-xs">메모</label>
        <textarea class="input" name="memo" rows="2">${val(e.memo)}</textarea>
      </div>
      <div class="flex items-center justify-between gap-2 pt-1">
        ${del}
        <div class="ml-auto flex gap-2">
          <a href="/equipment" class="btn-ghost btn-sm" data-no-guard>취소</a>
          <button class="btn-primary btn-sm" type="submit">${isEdit ? "저장" : "추가"}</button>
        </div>
      </div>
    </form>`;
}

module.exports = { equipmentList, equipmentForm };
```

- [ ] **Step 4: 테스트 통과 확인**

Run: `node --test test/equipment-views.test.js`
Expected: PASS (4건)

- [ ] **Step 5: 커밋**

```bash
git add src/views.equipment.js test/equipment-views.test.js
git commit -m "feat: 장비 대장 뷰 — 종류별 그룹 목록 + 추가/편집 폼(제안 칩)

$(printf 'Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>')"
```

---

## Task 3: 라우트 + 배선(메뉴·MONEY·제안 칩 JS)

**Files:**
- Create: `src/routes/equipment.routes.js`
- Modify: `src/server.js` (require + mount)
- Modify: `src/views.js` (NAV 항목 + 아이콘)
- Modify: `public/js/app.js` (MONEY 정규식 + 제안 칩 채움 핸들러)
- Modify: `test/smoke.test.js` (/equipment 200 + editor)

**Interfaces:**
- Consumes: `listEquipment`,`getEquipment`,`createEquipment`,`updateEquipment`,`deleteEquipment`,`equipmentLocationSuggestions`,`equipmentCategorySuggestions`,`listRooms`(../data); `equipmentList`,`equipmentForm`(../views.equipment); `layout`,`pageHeader`,`errorPage`(../views); `requireEditor`(../auth); `logAudit`(../lib/audit).
- Produces: Express Router. 라우트: `GET /` · `GET /new` · `POST /` · `GET /:id/edit` · `POST /:id` · `POST /:id/delete`.

- [ ] **Step 1: 라우트 구현 (src/routes/equipment.routes.js)**

```javascript
"use strict";

const express = require("express");
const { requireEditor } = require("../auth");
const {
  listEquipment, getEquipment, createEquipment, updateEquipment, deleteEquipment,
  equipmentLocationSuggestions, equipmentCategorySuggestions, listRooms,
} = require("../data");
const { layout, pageHeader, errorPage } = require("../views");
const { equipmentList, equipmentForm } = require("../views.equipment");
const { logAudit } = require("../lib/audit");

const router = express.Router();
router.use(requireEditor); // 전 라우트 = 대표·치프·스태프

function formOpts() {
  return { rooms: listRooms(), categories: equipmentCategorySuggestions(), locations: equipmentLocationSuggestions() };
}

// 목록
router.get("/", (req, res) => {
  const q = String(req.query.q || "").trim();
  const rows = listEquipment({ q });
  const body = `${pageHeader({ title: "장비", desc: "스튜디오 보유 장비 대장", action: `<a href="/equipment/new" class="btn-primary btn-sm">+ 새 장비</a>` })}
    ${equipmentList(rows, { q })}`;
  res.send(layout({ title: "장비", user: req.user, current: "equipment", body, wide: true }));
});

// 추가 폼
router.get("/new", (req, res) => {
  const body = `${pageHeader({ title: "새 장비", back: "/equipment" })}<div class="card">${equipmentForm(null, formOpts())}</div>`;
  res.send(layout({ title: "새 장비", user: req.user, current: "equipment", body }));
});

// 생성
router.post("/", (req, res) => {
  try {
    createEquipment(req.body);
  } catch (e) {
    if (e.message === "EQUIPMENT_NAME_REQUIRED") return res.status(400).send(errorPage({ code: 400, title: "장비명이 필요합니다", message: "장비명을 입력하세요.", user: req.user }));
    throw e;
  }
  res.redirect("/equipment?flash=created");
});

// 편집 폼
router.get("/:id/edit", (req, res) => {
  const item = getEquipment(Number(req.params.id));
  if (!item) return res.status(404).send(errorPage({ code: 404, title: "장비를 찾을 수 없습니다", message: "삭제되었거나 주소가 잘못되었습니다.", user: req.user }));
  const body = `${pageHeader({ title: item.name, back: "/equipment" })}<div class="card">${equipmentForm(item, formOpts())}</div>`;
  res.send(layout({ title: item.name, user: req.user, current: "equipment", body }));
});

// 수정
router.post("/:id", (req, res) => {
  const item = getEquipment(Number(req.params.id));
  if (!item) return res.status(404).send(errorPage({ code: 404, title: "장비를 찾을 수 없습니다", message: "삭제되었거나 주소가 잘못되었습니다.", user: req.user }));
  try {
    updateEquipment(item.id, req.body);
  } catch (e) {
    if (e.message === "EQUIPMENT_NAME_REQUIRED") return res.status(400).send(errorPage({ code: 400, title: "장비명이 필요합니다", message: "장비명을 입력하세요.", user: req.user }));
    throw e;
  }
  res.redirect("/equipment?flash=saved");
});

// 삭제(하드) — 감사 로그
router.post("/:id/delete", (req, res) => {
  const item = getEquipment(Number(req.params.id));
  if (item) {
    deleteEquipment(item.id);
    logAudit(req.user, "equipment.delete", `#${item.id} ${item.name || ""}`.trim());
  }
  res.redirect("/equipment?flash=deleted");
});

module.exports = router;
```

- [ ] **Step 2: server.js 마운트**

`src/server.js` require 목록(다른 라우트 require 근처)에 추가:

```javascript
const equipmentRoutes = require("./routes/equipment.routes");
```

`app.use("/settings", settingsRoutes);` 근처(정적 자산 `express.static` 앞)에 추가:

```javascript
app.use("/equipment", equipmentRoutes); // requireEditor(대표·치프·스태프) — 보유 장비 대장 CRUD
```

- [ ] **Step 3: NAV 항목 + 아이콘 (src/views.js)**

NAV 배열에서 `{ href: "/clients", ... group: "manage" }` 뒤에 추가:

```javascript
  { href: "/equipment", label: "장비", key: "equipment", navKey: "q", access: "editor", group: "manage" },
```

아이콘 맵(다른 아이콘들 근처, `settings:` 아이콘 옆)에 `equipment` 키 추가(슬라이더/장비 느낌):

```javascript
  equipment: '<path d="M4 5h16"/><path d="M4 12h16"/><path d="M4 19h16"/><circle cx="8" cy="5" r="2"/><circle cx="16" cy="12" r="2"/><circle cx="10" cy="19" r="2"/>',
```

(아이콘 맵의 정확한 위치·형식은 기존 `dashboard`/`settings` 키 렌더 방식을 따를 것. `current="equipment"`가 이 키로 활성 표시된다.)

- [ ] **Step 4: MONEY 정규식에 purchase_price 추가 (public/js/app.js)**

기존:

```javascript
  var MONEY = /^(unit_price|base_price|extra_price|amount|paid_amount|discount_amount|worker_rate|engineer_rates|task_amount_\d+|session_amount_\d+)$/;
```

로 변경:

```javascript
  var MONEY = /^(unit_price|base_price|extra_price|amount|paid_amount|discount_amount|worker_rate|engineer_rates|purchase_price|task_amount_\d+|session_amount_\d+)$/;
```

- [ ] **Step 5: 제안 칩 채움 핸들러 (public/js/app.js)**

app.js에 위임 클릭 핸들러 추가(다른 IIFE/위임 핸들러 근처, 파일 스코프). 클릭 시 대상 입력칸을 채우고 dirty 통지:

```javascript
// 제안 칩([data-fill-value][data-fill-target]) 클릭 → 대상 입력칸 채움 + dirty 통지(장비 종류·장소).
document.addEventListener("click", function (e) {
  var chip = e.target.closest ? e.target.closest("[data-fill-value][data-fill-target]") : null;
  if (!chip) return;
  var form = chip.form || (chip.closest ? chip.closest("form") : null);
  var input = form ? form.querySelector(chip.getAttribute("data-fill-target")) : document.querySelector(chip.getAttribute("data-fill-target"));
  if (!input) return;
  input.value = chip.getAttribute("data-fill-value");
  input.dispatchEvent(new Event("input", { bubbles: true }));
  input.dispatchEvent(new Event("change", { bubbles: true })); // dirty 감시 통지(함정 #23)
});
```

- [ ] **Step 6: 스모크 테스트에 /equipment 추가 (test/smoke.test.js)**

`pages` 배열(치프 200 확인)에 `"/equipment"` 추가. 그리고 editor 권한 매트릭스에서 스태프·대표도 `/equipment` 200을 확인하는 곳이 있으면 추가(기존 `/contacts`·`/clients` editor 검증과 같은 패턴). 정확한 배열 위치는 기존 스모크 구조를 따를 것:

```javascript
    // pages 배열에 추가
    "/contacts", "/contacts/new", "/equipment",
```

- [ ] **Step 7: 전체 테스트 + 스모크 통과 확인**

Run: `npm test`
Expected: PASS(전건). 특히 `test/smoke.test.js`의 `/equipment` 200, `test/guardrails-ui.test.js`(MONEY 계약·data-* 마커·bare name 금지) 통과.

- [ ] **Step 8: 실서버 E2E 확인**

임시 스크립트로 dev-login(chief/staff/owner) 후: 장비 등록(POST /equipment) → 목록(GET /equipment)에 종류별 표시 → 장소 수정(POST /equipment/:id) → 삭제(POST /equipment/:id/delete, 감사 로그) → 검색(GET /equipment?q=). 각 단계 상태코드·DB 확인. (`test/smoke.test.js` 패턴의 dev-login 헤더 재사용.)

- [ ] **Step 9: 커밋**

```bash
git add src/routes/equipment.routes.js src/server.js src/views.js public/js/app.js test/smoke.test.js
git commit -m "feat: 장비 대장 라우트 + 메뉴 배선 — /equipment CRUD, 관리 그룹 새 메뉴

$(printf 'Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>')"
```

---

## Task 4: 정체성 경계 갱신 + 문서

**Files:**
- Modify: `CLAUDE.md` (정체성 경계 + 새 섹션 + 테스트 수)
- Modify: `HISTORY.md` (세션 이력)

- [ ] **Step 1: 정체성 경계 명확화 (CLAUDE.md)**

제품 정체성 '의도적으로 안 지는 무게(경계)'의 "재고/구매" 문구를 갱신:

> **판매 재고·구매발주(입출고·재주문·매출원가) = 범위 밖.** 단 **보유 장비 대장(자산 참조 목록)**은 포함(2026-07-23) — stock-flow가 아니라 참조용이라 경량 정체성과 충돌 안 함. 우리는 여전히 물건을 팔거나 입출고를 관리하지 않는다.

- [ ] **Step 2: 장비 대장 섹션 추가 (CLAUDE.md)**

현재 상태 기능 목록에 장비 대장 섹션 추가(간결히): 새 `equipment` 테이블(장비명·종류·시리얼·매입가·구매일·장소·메모), `/equipment` 종류별 그룹 목록 + 실시간 검색, 장소=단일 텍스트+룸/기존값 제안 칩(FK 아님 — 룸 개명 시 미전파 트레이드오프 수용), 전원 편집(`requireEditor`)·삭제 중심(감사 `equipment.delete`), 관리 그룹 메뉴(navKey `q`). 회귀 `equipment.test.js`·`equipment-views.test.js`. 테스트 수 갱신.

- [ ] **Step 3: HISTORY.md 세션 이력 추가**

상단에 이번 세션 요약 1줄(브레인스토밍→스펙→계획→구현, 자산 대장 vs 판매 재고 구분, 정체성 경계 명확화).

- [ ] **Step 4: 최종 전체 테스트**

Run: `npm test`
Expected: PASS(전건).

- [ ] **Step 5: 커밋 + 푸시**

```bash
git add CLAUDE.md HISTORY.md
git commit -m "docs: 장비 대장 — 정체성 경계 명확화(자산 대장 포함) + 현행화

$(printf 'Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>')"
git push
```

---

## Self-Review 결과

**Spec coverage:** 스펙 각 절 → 태스크 매핑 확인:
- 데이터 모델(테이블·필드·장소 단일 텍스트·종류) → Task 1 ✓
- 목록 종류별 그룹 + 검색 → Task 2(뷰)·Task 3(라우트) ✓
- 장소 제안 칩(룸+기존값, datalist 안 씀) → Task 1(데이터)·Task 2(칩 렌더)·Task 3(app.js 채움) ✓
- 필드 필수/선택(name만 필수) → Task 1 ✓
- 돈/날짜 공용 헬퍼 → Task 1(parseMoney·cleanYmd)·Task 2(dateCombo)·Task 3(MONEY 정규식) ✓
- 삭제 중심 + 감사 로그 → Task 3 ✓
- 권한 전원(requireEditor)·관리 그룹 메뉴 → Task 3 ✓
- 정체성 경계 갱신 → Task 4 ✓
- 테스트(데이터·뷰·스모크·E2E) → Task 1·2·3 ✓

**Placeholder scan:** "TBD/TODO/appropriate/etc" 없음(아이콘 SVG·스모크 배열 위치는 "기존 방식 따를 것"으로 명시, 실제 코드는 제공).

**Type consistency:** `equipment_name`(폼)↔`req.body.equipment_name`(라우트)↔`input.equipment_name`(equipmentFields) 일관. `purchase_price` 폼·MONEY 정규식·필드 일관. 함수명 `listEquipment`/`getEquipment`/`createEquipment`/`updateEquipment`/`deleteEquipment`/`equipmentLocationSuggestions`/`equipmentCategorySuggestions` 전 태스크 동일.
