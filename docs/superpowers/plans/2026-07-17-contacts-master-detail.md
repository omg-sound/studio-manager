# 연락처 마스터-디테일 전환 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 연락처·관계자 목록을 6열 표에서 애플 연락처식 2단(왼쪽 이름 목록 + 오른쪽 읽기 뷰)으로 바꿔 열 폭 문제를 없앤다.

**Architecture:** 새 URL 개념 없이 기존 `/contacts/:id`의 렌더링만 2단으로 바꾼다(설계 A안). 순수 렌더러 4개를 `src/views.contacts.js`에 신설하고 라우트는 조회+조립만 한다. 좁은 화면 분기는 서버가 선택 여부를 알고 클래스를 정하므로 JS가 없다. 관계자 탭은 같은 렌더러를 `?sel=<id>`로 재사용한다.

**Tech Stack:** Node 20 / Express 4(CommonJS) / SQLite / 서버 렌더 HTML(`src/views*.js`) / Tailwind CLI / `node:test`

## Global Constraints

- 스펙 원본: `docs/superpowers/specs/2026-07-17-contacts-master-detail-design.md`
- **CSP**: 인라인 `style=` · 인라인 `<script>` · `onclick` 금지. 치수·레이아웃은 CSS 클래스로만(함정 #27).
- **Tailwind 임의값 클래스는 리터럴로** 작성한다(`lg:grid-cols-[18rem_minmax(0,1fr)]`). 동적 조립(`w-${x}`) 금지 — 스캐너가 못 잡는다. 새 클래스를 쓴 뒤에는 **반드시 `npm run build:css`** 후 실측(2026-07-17에 밟은 함정: 재빌드 전엔 그 열이 조용히 유동 폭으로 렌더됨).
- **JS로 숨길 때는 인라인 `style.display`**, 서버 렌더 숨김은 Tailwind `hidden`(함정 #26).
- 돈=정수(원), 날짜=`"YYYY-MM-DD"` 문자열.
- 테스트는 `npm test`(현재 326개 통과)가 항상 초록이어야 한다. 커밋 전 실행.
- 커밋 메시지: 한국어 본문 + `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>` 마지막 줄.
- **범위 밖(건드리지 말 것)**: 클라이언트 상세(업체·아티스트·그룹)의 인라인 편집, 클라이언트 업체/아티스트/그룹 탭의 `dataTable`, `searchBox({remote})` 구현 자체.

## File Structure

| 파일 | 책임 |
|---|---|
| `src/views.contacts.js` (신설) | 연락처 전용 순수 렌더러 — `contactPanes` · `contactNameList` · `contactReadView` · `contactEditPane` |
| `src/routes/contacts.routes.js` (수정) | `GET /` · `GET /:id` · `GET /:id/edit` 를 2단으로. 조회+조립만 |
| `src/routes/clients.routes.js` (수정) | 관계자 탭(`group=associate`)을 2단(`?sel=`)으로 |
| `src/views.js` (수정) | `contactTable` 삭제 + export 정리 |
| `test/contacts-views.test.js` (신설) | 순수 렌더러 단위 테스트 |
| `test/contacts-panes.test.js` (신설) | 라우트 렌더 테스트(실서버 기동) |
| `test/nav.test.js` (수정) | `contactTable` 계약 → 새 목록 계약 |

---

### Task 1: `views.contacts.js` — 2단 골격 + 이름 목록

**Files:**
- Create: `src/views.contacts.js`
- Test: `test/contacts-views.test.js`

**Interfaces:**
- Consumes: `src/views.js`의 `esc`, `personName`, `listGroup`
- Produces:
  - `contactPanes({ left, right, hasSelection }) -> string`
  - `contactNameList({ rows, selectedId, hrefFn }) -> string` — `rows`=parties 배열(`{id, name, activity_name, honorific, ...}`), `hrefFn(row) -> string`

- [ ] **Step 1: 실패하는 테스트 작성**

`test/contacts-views.test.js` 신규 작성:

```js
"use strict";
process.env.NODE_ENV = "test";
const test = require("node:test");
const assert = require("node:assert");
const { contactPanes, contactNameList } = require("../src/views.contacts");

const ROWS = [
  { id: 1, kind: "person", name: "Kim George Han", activity_name: "김조한", honorific: "" },
  { id: 2, kind: "person", name: "강병원", activity_name: "", honorific: "대표님" },
];

test("contactNameList: 이름만 렌더 + 선택 강조 + 실시간 필터 마커", () => {
  const html = contactNameList({ rows: ROWS, selectedId: 2, hrefFn: (c) => `/contacts/${c.id}` });
  assert.match(html, /data-filter-list/, "실시간 필터 컨테이너 마커");
  assert.match(html, /href="\/contacts\/1"/);
  assert.match(html, /Kim George Han \(김조한\)/, "활동명 병기(personName)");
  assert.match(html, /강병원 대표님/, "호칭 병기");
  // 선택된 행만 강조 + aria-current
  const rowOf = (id) => html.split(`href="/contacts/${id}"`)[1].split("</a>")[0];
  assert.match(rowOf(2), /aria-current="true"/, "선택 행 aria-current");
  assert.ok(!/aria-current/.test(rowOf(1)), "비선택 행엔 aria-current 없음");
  assert.match(rowOf(2), /bg-primary\/10/, "선택 행 강조");
  // 이름 외 정보(전화·소속·역할)는 목록에 없다 — 폭 문제의 원인이었음
  assert.ok(!/badge/.test(html), "역할 배지 없음");
});

test("contactNameList: 행 링크는 row-link(모바일 44px 터치 타깃)", () => {
  const html = contactNameList({ rows: ROWS, selectedId: null, hrefFn: (c) => `/contacts/${c.id}` });
  assert.match(html, /class="[^"]*row-link/);
});

test("contactPanes: 선택 없으면 목록만(좁은 화면), 선택 있으면 상세만", () => {
  const none = contactPanes({ left: "LEFT", right: "RIGHT", hasSelection: false });
  assert.match(none, /<div class="block[^"]*">LEFT/, "미선택: 왼쪽 항상 보임");
  assert.match(none, /<div class="hidden lg:block[^"]*">RIGHT/, "미선택: 오른쪽은 lg 이상만");
  const sel = contactPanes({ left: "LEFT", right: "RIGHT", hasSelection: true });
  assert.match(sel, /<div class="hidden lg:block[^"]*">LEFT/, "선택: 왼쪽은 lg 이상만");
  assert.match(sel, /<div class="block[^"]*">RIGHT/, "선택: 오른쪽 항상 보임");
  assert.match(sel, /lg:grid-cols-\[18rem_minmax\(0,1fr\)\]/, "2단 그리드(리터럴 클래스)");
});

test("contactPanes: 인라인 style 없음(CSP — 함정 #27)", () => {
  const html = contactPanes({ left: "L", right: "R", hasSelection: true });
  assert.ok(!/style="/.test(html));
});
```

- [ ] **Step 2: 실패 확인**

Run: `node --test test/contacts-views.test.js`
Expected: FAIL — `Cannot find module '../src/views.contacts'`

- [ ] **Step 3: 최소 구현**

`src/views.contacts.js` 신규 작성:

```js
"use strict";
// 연락처 전용 뷰(2026-07-17 마스터-디테일 전환) — 왼쪽 이름 목록 + 오른쪽 읽기/편집 패널.
// 표(contactTable)를 걷어낸 이유: 연락처는 '비교'가 아니라 '찾기' 화면이라 열 폭 튜닝이 계속 실패했다(설계 문서 참조).
const { esc, personName, listGroup } = require("./views");

/**
 * 2단 골격. lg 이상 = [이름 목록 18rem | 상세]. 미만 = 한 단(선택 여부로 한쪽만).
 * 서버가 선택 여부를 알고 클래스를 정하므로 JS가 없다.
 * @param {{left:string, right:string, hasSelection:boolean}} o
 */
function contactPanes({ left, right, hasSelection }) {
  const leftCls = hasSelection ? "hidden lg:block" : "block";
  const rightCls = hasSelection ? "block" : "hidden lg:block";
  return `<div class="lg:grid lg:grid-cols-[18rem_minmax(0,1fr)] lg:gap-6 lg:items-start">
      <div class="${leftCls} lg:sticky lg:top-4">${left}</div>
      <div class="${rightCls} min-w-0">${right}</div>
    </div>`;
}

/**
 * 이름만 있는 마스터 목록(애플 연락처식). 소속·역할·전화를 넣지 않는 게 요점 — 폭 경쟁이 사라진다.
 * `listGroup({filterList:true})`가 app.js 실시간 필터 계약(data-filter-list/data-filter-empty)을 제공한다.
 * @param {{rows:object[], selectedId?:number|null, hrefFn:(row:object)=>string}} o
 */
function contactNameList({ rows, selectedId = null, hrefFn }) {
  const items = rows.map((c) => {
    const active = Number(selectedId) === Number(c.id);
    const cls = active ? "bg-primary/10 font-semibold text-fg" : "text-fg";
    return `<a href="${esc(hrefFn(c))}" class="row-link block truncate px-3 py-2 text-sm ${cls}"${active ? ' aria-current="true"' : ""}>${esc(personName(c))}</a>`;
  });
  return listGroup({ rows: items, filterList: true });
}

module.exports = { contactPanes, contactNameList };
```

- [ ] **Step 4: 통과 확인**

Run: `node --test test/contacts-views.test.js`
Expected: PASS (4 tests)

- [ ] **Step 5: 커밋**

```bash
git add src/views.contacts.js test/contacts-views.test.js
git commit -m "feat(contacts): 2단 골격·이름 목록 렌더러 신설

애플 연락처식 마스터-디테일의 순수 렌더러 2종.
- contactPanes: lg 이상 2단, 미만은 선택 여부로 한쪽만(JS 없음)
- contactNameList: 이름만(personName) + 선택 강조 + 실시간 필터 마커

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: `contactReadView` — 읽기 뷰(탭 없이 한 화면)

**Files:**
- Modify: `src/views.contacts.js`
- Test: `test/contacts-views.test.js`

**Interfaces:**
- Consumes: Task 1의 모듈, `src/views.js`의 `esc`·`personName`·`copyable`·`emptyState`·`dataTable`·`icon`, `src/data`의 `classifyParty`(지연 require — 순환 회피)
- Produces: `contactReadView(party, { affs, projects, sessions, editHref, extras }) -> string`
  - `party`: parties 행 / `affs`: `listAffiliations(id)` 결과(`{id,client_id,client_name,title,started_on,ended_on,memo}`)
  - `projects`: `listProjectsForParty(id)` / `sessions`: `listSessionsForParty(id)`
  - `editHref`: [편집] 목적지(관계자 탭은 연락처 메뉴로 보냄) / `extras`: 연동 정보 HTML(라우트가 조립)

- [ ] **Step 1: 실패하는 테스트 작성**

`test/contacts-views.test.js` 하단에 추가:

```js
const { contactReadView } = require("../src/views.contacts");

const PARTY = { id: 2, kind: "person", name: "강병원", activity_name: "", honorific: "대표님",
  phone: "010-8765-4321", email: "bw@undefined-ent.co.kr", cash_receipt_no: "010-8765-4321",
  company: "언디파인드엔터테인먼트주식회사", job_title: "대표", department: "", memo: "야간 연락 가능" };
const AFFS = [
  { id: 9, client_id: 5, client_name: "언디파인드엔터테인먼트주식회사", title: "대표", started_on: "2025-01-01", ended_on: null, memo: "" },
  { id: 8, client_id: 6, client_name: "옛회사", title: "팀장", started_on: "2020-01-01", ended_on: "2024-12-31", memo: "" },
];
const PROJECTS = [{ id: 3, title: "소울 4집", artist: "김조한", production_company: "소울패밀리", artist_company: "", created_at: "2026-07-02 11:20:00" }];
const SESSIONS = [{ id: 4, project_id: 3, project_title: "소울 4집", session_date: "2026-07-09", start_time: "14:00", end_time: "17:30", all_day: 0, session_type: "녹음", status: "완료" }];
const read = (o = {}) => contactReadView(PARTY, { affs: AFFS, projects: PROJECTS, sessions: SESSIONS, editHref: "/contacts/2/edit", extras: "", ...o });

test("contactReadView: 헤더 이름 + 편집 버튼", () => {
  const html = read();
  assert.match(html, /강병원 대표님/);
  assert.match(html, /href="\/contacts\/2\/edit"/, "[편집] 목적지는 호출부가 정함");
});

test("contactReadView: 전화·이메일·현금영수증은 클릭 복사", () => {
  const html = read();
  assert.match(html, /data-copy="010-8765-4321"/);
  assert.match(html, /data-copy="bw@undefined-ent\.co\.kr"/);
});

test("contactReadView: 소속 이력은 읽기 전용(편집 폼·저장 버튼 없음)", () => {
  const html = read();
  assert.match(html, /언디파인드엔터테인먼트주식회사/);
  assert.match(html, /옛회사/);
  assert.ok(!/<form/.test(html), "읽기 뷰엔 폼이 없다");
  assert.ok(!/data-dirty-form/.test(html));
});

test("contactReadView: 참여 내역 = 프로젝트·세션 표(작성일 포함)", () => {
  const html = read();
  assert.match(html, /프로젝트 1/);
  assert.match(html, /세션 1/);
  assert.match(html, /2026-07-02/, "프로젝트 작성일");
  assert.match(html, /href="\/projects\/3"/);
  assert.match(html, /href="\/projects\/3\?tab=sessions"/);
});

test("contactReadView: 참여 내역 없으면 빈 안내", () => {
  const html = read({ projects: [], sessions: [] });
  assert.match(html, /연결된 프로젝트가 없습니다/);
  assert.match(html, /세션이 없습니다/);
});

test("contactReadView: 탭 없음(한 화면 스크롤)", () => {
  const html = read();
  assert.ok(!/\?tab=activity/.test(html), "옛 2탭 잔재 없음");
});
```

- [ ] **Step 2: 실패 확인**

Run: `node --test test/contacts-views.test.js`
Expected: FAIL — `contactReadView is not a function`

- [ ] **Step 3: 구현**

`src/views.contacts.js`의 require 줄을 교체하고 함수 추가:

```js
const { esc, personName, personLabel, listGroup, copyable, emptyState, dataTable, icon } = require("./views");
```

```js
/** 읽기 뷰 한 줄(아이콘 + 라벨 + 값). 값은 이미 esc/copyable 처리된 HTML. */
function readRow(label, valueHtml) {
  return `<div class="border-t border-border/60 px-4 py-3 first:border-t-0">
      <div class="text-xs text-muted">${esc(label)}</div>
      <div class="mt-0.5 text-sm">${valueHtml}</div>
    </div>`;
}

/**
 * 읽기 뷰 — 탭 없이 한 화면 스크롤(2026-07-17 사용자 결정).
 * 순서: 헤더 → 연락 정보 → 소속(+이력) → 메모 → 참여 내역 → 연동 정보.
 * 편집은 별도 경로(editHref) — '상세=바로 편집'은 연락처에서만 '읽기 후 편집'으로 뒤집었다(클라이언트 상세는 그대로).
 */
function contactReadView(p, { affs = [], projects = [], sessions = [], editHref, extras = "" } = {}) {
  const { classifyParty } = require("./data"); // 지연 require(순환 회피)
  const dash = '<span class="text-muted">—</span>';
  const badges = classifyParty(p.id).map((t) => `<span class="badge ${t.cls}">${esc(t.label)}</span>`).join(" ");
  const header = `<div class="mb-4 flex items-start justify-between gap-3">
      <div class="min-w-0">
        <h1 class="truncate font-display text-2xl font-semibold text-fg">${esc(personName(p))}</h1>
        ${badges ? `<div class="mt-1 flex flex-wrap gap-1">${badges}</div>` : ""}
      </div>
      <a href="${esc(editHref)}" class="btn-ghost btn-sm shrink-0">편집</a>
    </div>`;

  const contact = `<div class="card p-0">
      ${readRow("전화", p.phone ? copyable(p.phone) : dash)}
      ${readRow("이메일", p.email ? copyable(p.email) : dash)}
      ${p.cash_receipt_no ? readRow("현금영수증 정보", copyable(p.cash_receipt_no)) : ""}
    </div>`;

  const cur = affs.find((a) => !a.ended_on);
  const orgLine = cur && cur.client_id
    ? `<a href="/clients/${cur.client_id}" class="text-primary hover:underline">${esc(cur.client_name || "")}</a>`
    : (p.company ? esc(p.company) : dash);
  const timeline = affs.length
    ? `<div class="divide-y divide-border/60">${affs.map((a) => `
        <div class="flex items-center justify-between gap-3 px-4 py-2 text-sm">
          <div class="min-w-0">
            <span class="badge ${a.ended_on ? "badge-neutral" : "badge-success"}">${a.ended_on ? "종료" : "현재"}</span>
            <span class="font-medium">${esc(a.client_name || "무소속")}</span>
            ${a.title ? `<span class="text-muted">${esc(a.title)}</span>` : ""}
          </div>
          <span class="shrink-0 text-xs text-muted">${esc(a.started_on || "?")} ~ ${esc(a.ended_on || "현재")}</span>
        </div>`).join("")}</div>`
    : "";
  const org = `<div class="card p-0">
      ${readRow("회사", orgLine)}
      ${readRow("직책", p.job_title ? esc(p.job_title) : dash)}
      ${p.department ? readRow("부서", esc(p.department)) : ""}
      ${timeline ? `<div class="border-t border-border/60 pt-2"><div class="px-4 text-xs text-muted">소속 이력</div>${timeline}</div>` : ""}
    </div>`;

  const memo = p.memo ? `<div class="card"><div class="text-xs text-muted">메모</div><div class="mt-0.5 whitespace-pre-wrap text-sm">${esc(p.memo)}</div></div>` : "";

  // 참여 내역 — 2026-07-17 만든 표를 그대로 재사용(열 순서·작성일 표기는 프로젝트 목록과 통일).
  const projectTable = projects.length
    ? dataTable(
        [
          { label: "아티스트", w: "w-[10rem]", hide: "sm", mCard: "tl" },
          { label: "제작사", w: "w-[10rem]", hide: "lg", mobileHide: true },
          { label: "프로젝트", primary: true, mCard: "bl" },
          { label: "작성일", w: "w-[6.5rem]", nowrap: true, mCard: "tr" },
        ],
        projects.map((pr) => {
          const link = (inner, cls = "") => `<a href="/projects/${pr.id}" class="dt-link ${cls}">${inner}</a>`;
          const company = pr.production_company || pr.artist_company || "";
          return { cells: [
            pr.artist ? link(esc(pr.artist), "font-medium") : dash,
            company ? link(esc(company), "text-muted") : dash,
            link(esc(pr.title), "font-medium"),
            link(esc(String(pr.created_at || "").slice(0, 10)), "text-muted"),
          ] };
        })
      )
    : emptyState("연결된 프로젝트가 없습니다.", { card: true });
  const sessionTable = sessions.length
    ? dataTable(
        [
          { label: "날짜", w: "w-[7rem]", nowrap: true, mCard: "tl" },
          { label: "시간", w: "w-[7.5rem]", hide: "md", nowrap: true, mobileHide: true },
          { label: "종류", w: "w-[6rem]", hide: "sm", mCard: "tr" },
          { label: "프로젝트", primary: true, mCard: "bl" },
          { label: "상태", w: "w-[5rem]", mCard: "br" },
        ],
        sessions.map((s) => {
          const link = (inner, cls = "") => `<a href="/projects/${s.project_id}?tab=sessions" class="dt-link ${cls}">${inner}</a>`;
          const time = s.all_day ? "종일" : s.start_time ? `${s.start_time}${s.end_time ? `–${s.end_time}` : ""}` : "";
          return { cells: [
            link(esc(s.session_date), "font-medium"),
            time ? link(esc(time), "text-muted") : dash,
            link(esc(s.session_type), "text-muted"),
            link(esc(s.project_title || ""), "font-medium"),
            link(esc(s.status), "text-muted"),
          ] };
        })
      )
    : emptyState("담당 디렉터로 지정된 세션이 없습니다.", { card: true });

  const activity = `
    <h2 class="mb-2 mt-6 font-display text-lg font-semibold text-fg">프로젝트 ${projects.length}</h2>
    ${projectTable}
    <h2 class="mb-2 mt-6 font-display text-lg font-semibold text-fg">세션 ${sessions.length}</h2>
    ${sessionTable}`;

  return `${header}
    <div class="space-y-3">${contact}${org}${memo}</div>
    ${activity}
    ${extras ? `<div class="mt-6 space-y-1 text-sm">${extras}</div>` : ""}`;
}
```

`module.exports`를 갱신:

```js
module.exports = { contactPanes, contactNameList, contactReadView };
```

- [ ] **Step 4: 통과 확인**

Run: `node --test test/contacts-views.test.js`
Expected: PASS (10 tests). 실패 시: `emptyState`의 빈 세션 문구가 테스트의 `/세션이 없습니다/`와 다르면 **테스트가 아니라 문구를 맞출 것**(문구=`"담당 디렉터로 지정된 세션이 없습니다."`이므로 테스트 정규식을 `/지정된 세션이 없습니다/`로 수정).

- [ ] **Step 5: 커밋**

```bash
git add src/views.contacts.js test/contacts-views.test.js
git commit -m "feat(contacts): 읽기 뷰 렌더러 — 탭 없이 한 화면

전화·이메일 클릭 복사, 소속 이력 읽기 전용, 참여 내역 표 재사용.
[편집] 목적지는 호출부가 정한다(관계자 탭은 연락처 메뉴로 보냄).

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 3: `/contacts` · `/contacts/:id` 2단 전환 + 목록 상한 제거

**Files:**
- Modify: `src/routes/contacts.routes.js:56-103`(목록), `src/routes/contacts.routes.js:256-...`(상세 — Task 3에서 읽기 뷰로 교체)
- Test: `test/contacts-panes.test.js`

**Interfaces:**
- Consumes: Task 1·2의 `contactPanes`·`contactNameList`·`contactReadView`
- Produces: 없음(라우트)

- [ ] **Step 1: 실패하는 테스트 작성**

`test/contacts-panes.test.js` 신규 작성(스모크 테스트와 동일한 실서버 기동 패턴):

```js
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

  server.close();
  cleanupDb();
});
```

- [ ] **Step 2: 실패 확인**

Run: `node --test test/contacts-panes.test.js`
Expected: FAIL — "연락처를 선택하세요" 없음(현재는 표 렌더)

- [ ] **Step 3: 목록 라우트 교체**

`src/routes/contacts.routes.js`의 `GET /`(56~103행)에서 `capList`·`contactTable` 사용을 걷어내고 2단으로:

```js
router.get("/", (req, res) => {
  res.send(renderContacts(req, null)); // 선택 없음 = 빈 패널
});
```

그리고 파일 하단(모듈 스코프)에 공용 렌더 함수를 추가한다 — 목록·상세·편집이 같은 왼쪽 목록을 공유하므로 한 곳에서 조립한다:

```js
/**
 * 연락처 2단 렌더(2026-07-17) — 목록·읽기·편집이 같은 왼쪽 목록을 공유한다.
 * @param {object} req
 * @param {object|null} sel 선택된 party(없으면 빈 패널)
 * @param {string} [rightHtml] 오른쪽 패널 HTML(미지정 시 읽기 뷰)
 */
function renderContacts(req, sel, rightHtml) {
  const q = String(req.query.q || "").trim();
  const TABS = ["external", "worker", "staff"];
  const tab = TABS.includes(req.query.tab) ? req.query.tab : "external";
  const rows = listContacts({ q: q || undefined, tab }); // 상한 없음(2026-07-17) — 이름만 렌더라 전 명단도 수십 KB
  const keep = `?tab=${tab}${q ? "&q=" + encodeURIComponent(q) : ""}`;

  const tabs = tabBar({
    tabs: [
      { key: "external", label: "외부 연락처" },
      { key: "worker", label: "외주 작업자" },
      { key: "staff", label: "녹음실 스태프" },
    ],
    activeKey: tab,
    hrefFn: (k) => `/contacts?tab=${k}${q ? "&q=" + encodeURIComponent(q) : ""}`,
  });
  const searchBar = searchBox({
    action: "/contacts", q, placeholder: "이름 검색", label: "연락처 검색", liveFilter: true, noButton: true,
    hidden: `<input type="hidden" name="tab" value="${esc(tab)}" />`,
  });
  const list = rows.length
    ? contactNameList({ rows, selectedId: sel ? sel.id : null, hrefFn: (c) => `/contacts/${c.id}${keep}` })
    : q
      ? emptyState(`"${esc(q)}" 검색 결과가 없습니다.`, { card: true, icon: "clients" })
      : tab === "staff"
        ? emptyState("녹음실 스태프 연락처가 없습니다. 환경설정 > 담당자에서 계정을 추가하면 자동 등록됩니다.", { card: true, icon: "clients" })
        : tab === "worker"
          ? emptyState("외주 작업자가 없습니다. 외주 작업자 메뉴에서 추가하면 자동 등록됩니다.", { card: true, icon: "clients" })
          : emptyState("등록된 연락처가 없습니다.", { card: true, icon: "clients", cta: { href: "/contacts/new", label: "+ 새 연락처" } });

  const left = `${tabs}${searchBar}${list}`;
  const right = rightHtml || (sel ? readPaneFor(req, sel) : emptyState("연락처를 선택하세요.", { card: true, icon: "clients" }));

  // 백링크 규약(CLAUDE.md): 청구·프로젝트·클라이언트에서 ?return=(내부 절대경로)로 들어오면 그 화면으로 복귀.
  // 목록 행 링크의 return은 2단이라 불필요해졌지만, **외부 유입 return은 유지**한다(스펙 '제거·정리' 표).
  const ret = safePath(String(req.query.return || ""));
  const back = ret
    ? { href: ret, label: ret.startsWith("/invoices") ? "청구" : ret.startsWith("/projects") ? "프로젝트" : ret.startsWith("/clients") ? "클라이언트" : "돌아가기" }
    : undefined;
  const body = `
    ${flashBanner(req.query)}
    ${pageHeader({ title: "연락처", back, action: `<a href="/contacts/new" class="btn-primary">+ 새 연락처</a>` })}
    ${contactPanes({ left, right, hasSelection: !!sel })}`;
  return layout({ title: sel ? sel.name : "연락처", user: req.user, current: "/contacts", body, wide: true });
}

/** 읽기 패널 — 상세 데이터 조회 + 연동 정보(파생) 조립. */
function readPaneFor(req, c) {
  const affs = listAffiliations(c.id);
  const projects = listProjectsForParty(c.id);
  const sessions = listSessionsForParty(c.id);
  const linkedManager = getManagerByPartyId(c.id);
  const ownerClients = orgsWithOwnerParty(c.id);
  const extras = [
    c.activity_name ? `<div><span class="text-muted">아티스트명</span> ${esc(c.activity_name)}${c.is_artist ? ` · <a href="/clients/${c.id}" class="text-primary hover:underline">아티스트로 보기 ↗</a>` : ""}</div>` : "",
    ownerClients.length ? `<div><span class="text-muted">대표 클라이언트</span> ${ownerClients.map((oc) => `<a href="/clients/${oc.id}" class="text-primary hover:underline">${esc(oc.name)}</a>`).join(", ")}</div>` : "",
    linkedManager
      ? `<div><span class="text-muted">담당자 연동</span> ${linkedManager.user_id != null
          ? `<span class="badge badge-info">하우스 엔지니어</span> <a href="/settings?tab=people" class="text-primary hover:underline">${esc(linkedManager.name)}</a>`
          : `<span class="badge badge-neutral">외주 작업자</span> <a href="/workers/${linkedManager.id}" class="text-primary hover:underline">${esc(linkedManager.name)}</a>`}</div>`
      : "",
  ].filter(Boolean).join("");
  return contactReadView(c, { affs, projects, sessions, editHref: `/contacts/${c.id}/edit`, extras });
}
```

import 줄에 새 렌더러를 추가한다(`src/routes/contacts.routes.js` 34행 근처):

```js
const { contactPanes, contactNameList, contactReadView } = require("../views.contacts");
```

- [ ] **Step 4: 상세 라우트(`GET /:id`) 교체**

`router.get("/:id", ...)`의 본문 전체를 다음으로 교체한다(옛 2탭·인라인 편집 폼·소속 이력 폼은 Task 4에서 편집 패널로 옮기므로 여기선 삭제):

```js
router.get("/:id", (req, res) => {
  const c = getParty(Number(req.params.id));
  if (!c) return res.status(404).send(errorPage({ code: 404, title: "연락처를 찾을 수 없습니다", message: "삭제되었거나 주소가 잘못되었습니다.", user: req.user }));
  res.send(renderContacts(req, c));
});
```

- [ ] **Step 5: 통과 확인**

Run: `node --test test/contacts-panes.test.js`
Expected: PASS (4 subtests). 이 시점엔 `/contacts/:id/edit`가 아직 상세로 리다이렉트라 [편집] 링크만 존재하면 통과한다.

- [ ] **Step 6: 커밋**

```bash
git add src/routes/contacts.routes.js test/contacts-panes.test.js
git commit -m "feat(contacts): 목록·상세를 2단으로 전환 + 목록 상한 제거

/contacts=목록+빈 패널, /contacts/:id=목록(선택 강조)+읽기 뷰.
왼쪽 목록은 세 화면이 공유(renderContacts 한 곳에서 조립).
capList(100건) 제거 — 이름만 렌더라 202건 전체도 수십 KB(실측).

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 4: `/contacts/:id/edit` — 편집 패널 되살리기

**Files:**
- Modify: `src/routes/contacts.routes.js:157-159`(리다이렉트 → 편집 렌더), 그리고 옛 상세에 있던 `contactForm`·소속 이력 편집 코드를 편집 패널로 이동
- Test: `test/contacts-panes.test.js`

**Interfaces:**
- Consumes: Task 3의 `renderContacts(req, sel, rightHtml)`
- Produces: 없음(라우트)

- [ ] **Step 1: 실패하는 테스트 추가**

`test/contacts-panes.test.js`의 `server.close()` 앞에 추가:

```js
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
```

- [ ] **Step 2: 실패 확인**

Run: `node --test test/contacts-panes.test.js`
Expected: FAIL — `/contacts/:id/edit`가 302 리다이렉트(200 아님)

- [ ] **Step 3: 편집 라우트 구현**

`router.get("/:id/edit", ...)`(157행)를 교체:

```js
// 편집(2026-07-17 마스터-디테일): 읽기 뷰의 [편집]이 여기로. 왼쪽 목록은 유지하고 오른쪽만 폼.
// (옛 '상세=바로 편집'은 연락처에서만 '읽기 후 편집'으로 바뀜 — 클라이언트 상세는 인라인 편집 유지.)
router.get("/:id/edit", (req, res) => {
  const c = getParty(Number(req.params.id));
  if (!c) return res.status(404).send(errorPage({ code: 404, title: "연락처를 찾을 수 없습니다", message: "삭제되었거나 주소가 잘못되었습니다.", user: req.user }));
  res.send(renderContacts(req, c, editPaneFor(req, c)));
});
```

`editPaneFor`를 파일 하단(모듈 스코프)에 추가한다.

**`timeline`·`affForm` 두 블록은 새로 쓰지 말고 옛 코드를 문자 그대로 옮긴다.** 출처가 정확히 특정된다:

```bash
# 전환 직전 커밋의 상세 라우트 — `const timeline = affs.length` 부터 `affForm` 정의 끝(</form>`;)까지
git show 637e939:src/routes/contacts.routes.js | sed -n '/const timeline = affs.length/,/소속 추가<\/button>/p'
```

이 블록들(각 소속 행 `<details>` + `POST /contacts/:id/affiliations/:aid` 폼 + 종료 처리 + 삭제 + 소속 추가/이직 폼)은
`dateCombo`·`companyCombo`·`data-dirty-form` 계약이 이미 검증된 코드다. 재작성하면 그 계약이 조용히 깨진다.
옮길 때 바꾸는 것은 **없다** — 변수 `c`·`affs`가 이 함수 스코프에도 같은 이름으로 존재한다.

```js
/** 편집 패널 — 폼 + 소속 이력 인라인 편집 + 소속 추가/이직 + 삭제(옛 '상세 정보' 탭 내용을 그대로 이동). */
function editPaneFor(req, c) {
  const affs = listAffiliations(c.id);
  const clients = listClients({});
  const linkedManager = getManagerByPartyId(c.id);
  const cur = currentAffiliation(c.id);
  // 취소 = 저장하지 않고 읽기 뷰로. data-no-guard + app.js가 bypass도 세워 beforeunload까지 통과(함정 #24).
  const cancel = `<a href="/contacts/${c.id}" class="text-sm text-primary hover:underline" data-no-guard>← 취소</a>`;
  const form = contactForm({ ...c, company: c.company || (cur && cur.client_name) || "" }, true, clients, linkedManager, true, listGroupsForPicker());

  const timeline = /* ⬅ git show 637e939 에서 그대로 붙여넣기(위 명령 참조) */ "";
  const affForm  = /* ⬅ git show 637e939 에서 그대로 붙여넣기(위 명령 참조) */ "";

  return `<div class="mb-3">${cancel}</div>
    ${form}
    <h2 class="mb-2 mt-6 font-display text-lg font-semibold text-fg">소속 이력</h2>
    ${timeline}
    ${affForm}`;
}
```

옛 상세에 있던 파생정보 카드(`derivedBits`)는 **읽기 뷰의 `extras`로 이미 옮겨졌으므로 편집 패널에는 넣지 않는다**(중복 방지).

- [ ] **Step 4: 통과 확인**

Run: `node --test test/contacts-panes.test.js`
Expected: PASS (6 subtests)

- [ ] **Step 5: 전체 테스트**

Run: `npm test`
Expected: 실패는 `test/nav.test.js`의 `contactTable` 계약 1건만(Task 6에서 정리). 그 외 초록.

- [ ] **Step 6: 커밋**

```bash
git add src/routes/contacts.routes.js test/contacts-panes.test.js
git commit -m "feat(contacts): /contacts/:id/edit 편집 패널 — 목록 유지, 오른쪽만 폼

읽기 뷰의 [편집]이 여기로. 폼·소속 이력 편집·추가·삭제는 옛 상세 코드를 그대로 이동.
저장하면 읽기 뷰(/contacts/:id)로 복귀.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 5: 관계자 탭 2단(`?sel=`)

**Files:**
- Modify: `src/routes/clients.routes.js:190-212`(관계자 렌더 분기)
- Test: `test/contacts-panes.test.js`

**Interfaces:**
- Consumes: `contactPanes`·`contactNameList`·`contactReadView`
- Produces: 없음(라우트)

- [ ] **Step 1: 실패하는 테스트 추가**

`test/contacts-panes.test.js`의 `server.close()` 앞에 추가:

```js
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
```

- [ ] **Step 2: 실패 확인**

Run: `node --test test/contacts-panes.test.js`
Expected: FAIL — "관계자를 선택하세요" 없음(현재 `contactTable` 렌더)

- [ ] **Step 3: 구현**

`src/routes/clients.routes.js` import에 추가:

```js
const { contactPanes, contactNameList, contactReadView } = require("../views.contacts");
```

관계자 분기(`group === "associate"`)에서 `contactTable(...)` 대신 2단을 만든다. 목록 조립부(`const list = displayed.length ? (group === "associate" ? contactTable(...) : dataTable(...)) + capped.more : ...`)를 다음처럼 나눈다:

```js
  // 관계자 탭 = 연락처와 같은 2단(2026-07-17). 선택은 ?sel=<party id> — 이 라우트는 탭 쿼리 기반이라 경로 파라미터를 못 쓴다.
  // 행 링크는 폭과 무관하게 항상 ?sel= 하나(서버는 href를 하나만 렌더하므로 뷰포트별 목적지 분기는 불가).
  let associatePanes = "";
  if (group === "associate") {
    const selId = Number(req.query.sel || 0) || null;
    const sel = selId ? displayed.find((r) => Number(r.id) === selId) || null : null;
    const keep = `group=associate${q ? "&q=" + encodeURIComponent(q) : ""}`;
    const left = displayed.length
      ? contactNameList({ rows: displayed, selectedId: sel ? sel.id : null, hrefFn: (c) => `/clients?${keep}&sel=${c.id}` })
      : emptyState("관계자가 없습니다.", { card: true, icon: "clients", cta: { href: "/contacts/new", label: "+ 새 관계자" } });
    const right = sel
      ? contactReadView(sel, {
          affs: listAffiliations(sel.id),
          projects: listProjectsForParty(sel.id),
          sessions: listSessionsForParty(sel.id),
          editHref: `/contacts/${sel.id}/edit?return=${encodeURIComponent(req.originalUrl)}`, // 편집 폼은 연락처 메뉴에 하나만
          extras: "",
        })
      : emptyState("관계자를 선택하세요.", { card: true, icon: "clients" });
    associatePanes = contactPanes({ left, right, hasSelection: !!sel });
  }
```

그리고 기존 `list` 계산에서 관계자 분기를 제거한다:

```js
  const list = group === "associate"
    ? associatePanes
    : displayed.length
      ? dataTable(orgCols, orgRows, { filterList: true }) + capped.more
      : emptyState(/* 기존 업체·아티스트·그룹 빈 상태 그대로 */);
```

> `listAffiliations`·`listProjectsForParty`·`listSessionsForParty`가 `clients.routes.js`에 import돼 있지 않으면 상단 `require("../data")` 구조 분해에 추가한다.
> 관계자 탭의 `capped`(상한)는 이 분기에서 쓰지 않는다 — 설계상 관계자도 전 명단 노출.

- [ ] **Step 4: 통과 확인**

Run: `node --test test/contacts-panes.test.js`
Expected: PASS (7 subtests)

- [ ] **Step 5: 커밋**

```bash
git add src/routes/clients.routes.js test/contacts-panes.test.js
git commit -m "feat(clients): 관계자 탭도 2단(?sel=) — 연락처와 같은 읽기 뷰

편집은 /contacts/:id/edit?return=으로 보내 폼을 한 곳에만 둔다.
관계자도 상한 없이 전 명단(실측 151건).

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 6: `contactTable` 제거 + 계약 테스트 갱신

**Files:**
- Modify: `src/views.js:604-636`(함수 삭제), `src/views.js:971`(export에서 제거)
- Modify: `test/nav.test.js:73`
- Modify: `src/routes/clients.routes.js:25`·`src/routes/contacts.routes.js:34`(import 정리)

**Interfaces:**
- Consumes: 없음
- Produces: 없음(정리)

- [ ] **Step 1: 소비처 0 확인**

Run: `grep -rn "contactTable" src/ test/`
Expected: `src/views.js`(정의·export)와 `test/nav.test.js:73`만 남아 있어야 한다. 라우트에 남아 있으면 Task 3·5가 덜 된 것이다.

- [ ] **Step 2: nav.test 계약 갱신**

`test/nav.test.js:73`을 교체한다. 옛 계약(표에 returnTo 전달)은 사라졌고, 새 계약은 **이름 목록이 실시간 필터 마커를 렌더**하는 것이다:

```js
  assert.match(R("contacts.routes.js"), /contactNameList\(\{ rows, selectedId/, "contacts: 이름 목록 2단 렌더");
```

- [ ] **Step 3: 실패 확인**

Run: `node --test test/nav.test.js`
Expected: PASS(갱신된 계약). 만약 FAIL이면 Task 3의 `contactNameList({ rows, selectedId: ... })` 호출 형태가 정규식과 다른 것 — **정규식이 아니라 실제 호출을 확인**할 것.

- [ ] **Step 4: `contactTable` 삭제**

`src/views.js`에서 `contactTable` 함수 정의(604~636행)와 `module.exports`의 `contactTable,` 를 삭제한다. 각 라우트 import 줄에서도 `contactTable`을 뺀다.

- [ ] **Step 5: 전체 테스트**

Run: `npm test`
Expected: 전부 PASS. `contactTable is not defined` 류가 나오면 import 정리가 덜 된 것.

- [ ] **Step 6: 커밋**

```bash
git add src/views.js src/routes/contacts.routes.js src/routes/clients.routes.js test/nav.test.js
git commit -m "refactor(views): contactTable 제거 — 마스터-디테일로 대체

소비처 2곳(연락처 목록·관계자 탭)이 모두 2단으로 전환돼 유일 소비처가 사라짐.
nav.test 계약도 새 이름 목록 기준으로 갱신.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 7: CSS 빌드 + 실브라우저 검증 + 문서 현행화

**Files:**
- Modify: `CLAUDE.md`(연락처 섹션·UI 공통 헬퍼 항목), `HISTORY.md`(세션 이력 맨 위)
- Build: `public/css/app.css`(gitignore — 커밋 대상 아님)

- [ ] **Step 1: CSS 재빌드**

Run: `npm run build:css`
그리고 새 임의값 클래스가 실제로 생성됐는지 확인:

Run: `grep -oF 'lg\:grid-cols-\[18rem_minmax(0,1fr)\]' public/css/app.css`
Expected: 한 줄 출력. **빈 출력이면 클래스가 리터럴이 아니거나 스캔 경로 밖**이다(함정 #27 재발) — 고치고 다시 빌드.

- [ ] **Step 2: 실서버 기동 + 실브라우저 검증**

로컬 검증 서버(스크래치패드)로 띄우고 Chrome으로 확인한다. 확인 항목:

1. `1512px`: 왼쪽 이름 목록 + 오른쪽 읽기 뷰가 나란히, 선택 행 강조
2. `1512px`: 이름 클릭 → 읽기 뷰 전환 → [편집] → 폼 → 저장 → 읽기 뷰 복귀
3. `1512px`: 검색창 타이핑 → 왼쪽 목록 실시간 필터(전 명단 대상)
4. `900px`·`390px`: 목록 URL=목록만, 상세 URL=상세만 + 뒤로가기
5. 전 폭에서 `document.documentElement.scrollWidth - clientWidth === 0`(가로 오버플로우 없음)
6. 관계자 탭(`/clients?group=associate`) 동일 확인

Expected: 6개 항목 모두 통과. 스크린샷 1512·390 저장.

- [ ] **Step 3: 문서 현행화**

`CLAUDE.md`:
- '연락처' 섹션의 `상세 = 2탭` 문단을 **마스터-디테일** 설명으로 교체(2단 구조·읽기 뷰 6섹션·`/contacts/:id/edit` 편집·관계자 탭 `?sel=`·상한 제거·"상세=바로 편집"을 연락처에서만 뒤집은 근거와 범위)
- 'UI 공통 헬퍼' 항목에서 `contactTable` 설명 삭제 → `views.contacts.js`(contactPanes·contactNameList·contactReadView) 추가
- 스택 표의 테스트 개수 갱신

`HISTORY.md`: 세션 이력 맨 위에 이번 작업 요약(요청 배경=폭 튜닝 반복 → 화면 성격 오인, 실측 수치, 제거된 것, 검증)

- [ ] **Step 4: 최종 테스트**

Run: `npm test`
Expected: 전부 PASS

- [ ] **Step 5: 커밋 + 푸시**

```bash
git add CLAUDE.md HISTORY.md
git commit -m "docs: 연락처 마스터-디테일 전환 반영

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
git push origin main
```

---

## Self-Review

**스펙 커버리지**

| 스펙 항목 | 담당 태스크 |
|---|---|
| `/contacts` 목록+빈 패널 | Task 3 |
| `/contacts/:id` 읽기 뷰(6섹션) | Task 2·3 |
| `/contacts/:id/edit` 편집 패널 | Task 4 |
| 관계자 탭 `?sel=` 2단 | Task 5 |
| 왼쪽 이름만 · 선택 강조 | Task 1 |
| 반응형(<1024 한쪽만) | Task 1(골격)·Task 7(실측) |
| 목록 상한 제거 | Task 3(연락처)·Task 5(관계자) |
| `contactTable`·2탭·capList 제거 | Task 3·6 |
| `?return=` 규약(청구·프로젝트 유입) | Task 3(`renderContacts`의 `safePath` back) |
| `?return=` 규약(관계자 → 편집 → 복귀) | Task 5(editHref에 return) |
| 테스트(라우트·계약·E2E) | Task 3~7 |
| 문서 | Task 7 |

**자체 점검에서 고친 것**
1. 청구·프로젝트에서 `/contacts/:id?return=`으로 오는 백링크가 어느 태스크에도 없었다 → Task 3의 `renderContacts`에 `safePath` back 로직을 넣었다(스펙 '제거·정리' 표의 유지 항목).
2. Task 4의 `timeline`·`affForm`이 주석 자리표시자였다(컴파일 불가) → 출처 커밋·추출 명령·"그대로 옮기고 아무것도 바꾸지 않는다"는 근거를 명시했다.

**이름 일관성 확인**: `contactPanes({left,right,hasSelection})` · `contactNameList({rows,selectedId,hrefFn})` · `contactReadView(party,{affs,projects,sessions,editHref,extras})` — Task 1·2 정의와 Task 3·5 호출부가 일치한다. `renderContacts(req, sel, rightHtml)` · `readPaneFor(req, c)` · `editPaneFor(req, c)`도 Task 3·4에서 같은 시그니처다.
