# 업체·그룹 마스터-디테일 전환 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `/clients`(업체·그룹)를 연락처처럼 왼쪽 이름 목록 + 오른쪽 읽기 뷰(+[편집])의 마스터-디테일로 전환한다.

**Architecture:** 연락처(`/contacts`)가 이미 쓰는 `contactPanes`·`contactNameList`(views.contacts.js)를 그대로 재사용한다. 업체·그룹 전용 읽기 뷰(`clientReadView`)와 편집 패널(`clientEditPane`)만 `views.clients.js`에 새로 만들고, `clients.routes.js`의 목록/상세/편집 3라우트를 연락처와 대칭 구조로 재구성한다. 서버 렌더 유지(JS 0·CSP 무관·딥링크 공짜).

**Tech Stack:** Node ≥20 / Express 4 (CommonJS) / 서버 렌더 HTML(`src/views*.js`) / Tailwind CLI / `node:test` + jsdom. DB=SQLite(better-sqlite3). 돈=정수(원), 날짜="YYYY-MM-DD".

## Global Constraints

- 서버 렌더 HTML + 클래식 폼 POST + 최소 JS. 인라인 `on*`·`<script>`·인라인 `style` 치수 금지(CSP `style-src`/`script-src`). 치수는 CSS 클래스로(Tailwind 임의값은 **리터럴**로 써야 스캔됨).
- 새 Tailwind 임의값 클래스는 `npm run build:css` 후에만 적용된다(함정 #27) — 시각 검증 전 반드시 빌드.
- 사용자 노출 문자열에 **'클라이언트' 금지**(가드레일 ⑯) — 화면 용어는 '업체·그룹'/'청구처'. 코드 식별자·주석은 예외.
- 콤보의 **보이는 입력에 `name` 금지**(가드레일 ⑨·함정 #19) — 이 계획은 기존 콤보를 이동만 하므로 새 위반 없음.
- 백링크 규약: 상세는 `safePath(req.query.return)`(내부 절대경로만)로 복귀. 청구·프로젝트→업체·그룹 유입 `?return=`은 유지.
- `c.kind === "person"`(아티스트 포함)을 `/clients/:id`로 열면 `/contacts/:id`로 302(from·return 보존) — **유지**. 상세는 조직(company/group) 전용.
- 삭제 중심 관리: 발행/입금 인보이스 있는 업체 삭제는 409 거부(유지).
- 모든 동적 텍스트는 렌더 시 `esc()`. `dataTable`/`listGroup` 등 공용 헬퍼 재사용(중복 구현 금지).
- `npm test`는 격리 임시 DB로 자가정리. 각 태스크 끝에 전체 스위트 녹색 확인.

---

## 파일 구조

| 파일 | 책임 | 변경 |
|---|---|---|
| `src/views.clients.js` | 업체·그룹 렌더 | **추가**: `clientReadView`(읽기 뷰)·`clientEditPane`(편집 패널). 기존 `clientForm`/`clientFilesBlock`/`clientProjectCard`/`clientRoleList` 재사용 |
| `src/views.contacts.js` | 2단 골격·이름 목록 | **재사용만**(변경 없음): `contactPanes`·`contactNameList` import |
| `src/routes/clients.routes.js` | 목록/상세/편집 라우트 | **재구성**: `GET /`(2단), `GET /:id`(읽기 뷰), `GET /:id/edit`(편집), POST 복귀 경로. dataTable·배치조회·capList 제거 |
| `test/clients-panes.test.js` | 신규 2단 라우트 계약 | **신규** |
| `test/clients-views.test.js` | 신규 렌더러 계약 | **신규** |
| `test/contacts-panes.test.js` | 기존 계약 | **갱신**(그룹 담당자 열 테스트 삭제) |
| `test/nav.test.js` | 백링크 계약 | **갱신**(clients 행 링크 return 제거·[편집] 백링크) |
| `CLAUDE.md` | 설계 일지 | **갱신**(업체·그룹 섹션) |

**참고(읽기 전용, 재사용 패턴)**: `src/routes/contacts.routes.js`의 `renderContacts`(300–363)·`readPaneFor`(366–371)·`editPaneFor`(374~). `src/views.contacts.js`의 `contactReadView`(63–159)·`readRow`(50–55)·`OUT` 상수(47).

---

### Task 1: `clientReadView` 렌더러 (업체·그룹 읽기 뷰)

**Files:**
- Modify: `src/views.clients.js` (함수 추가 + export)
- Test: `test/clients-views.test.js` (신규)

**Interfaces:**
- Produces: `clientReadView(c, opts) → string`
  - `c`: party 객체 — `{ id, kind('company'|'group'), name, activity_name?, roles?, biz_no?, address?, email?, phone? }`
  - `opts`: `{ owners=[], contacts=[], artists=[], members=[], agencyName='', agencyId=null, groupContact=null, bizLicenseOk=false, projects=[], invoices=[], editHref }`
    - `owners`: `listCompanyOwners(id)` 결과 `[{id, name, family_name?, given_name?, honorific?, activity_name?}]`
    - `contacts`: `listOrgContacts(id)` 결과(담당자, 같은 형태)
    - `artists`: `listArtistsForAgency(id)` 결과 `[{id, name, real_name?}]`
    - `members`: `listGroupMembers(id)` 결과 `[{id, name, display_name?}]`
    - `agencyName`/`agencyId`: 그룹 소속사(`currentAgencyName`/`currentAgencyId`)
    - `groupContact`: 그룹 담당자 사람 party(`getParty(c.contact_party_id)`) 또는 null
    - `bizLicenseOk`: 사업자등록증 존재+접근가능(boolean)
    - `projects`: `listProjectsForParty(id)`, `invoices`: `listInvoicesForParty(id)`
    - `editHref`: [편집] 링크 목적지
- Consumes: `esc`, `copyable`, `formatKRW`, `pageHeader` 불필요. `personName`(views), `clientRoleList`·`companyRoleLabel`·`clientProjectCard`(같은 파일). `invoiceRow`(views.invoices) — 지연 require. `personLabel`(views).

- [ ] **Step 1: 실패 테스트 작성** — `test/clients-views.test.js`

```javascript
"use strict";
const test = require("node:test");
const assert = require("node:assert");
const { clientReadView } = require("../src/views.clients");

const company = { id: 10, kind: "company", name: "(주)도너츠컬처", roles: "제작사", biz_no: "261-81-02922", address: "서울시", email: "note@daum.net", phone: "010-1111-2222" };
const group = { id: 20, kind: "group", name: "더윈드", activity_name: "더윈드" };

test("clientReadView(company): 기본 정보·담당자·[편집], 읽기 전용(폼 없음)", () => {
  const html = clientReadView(company, {
    owners: [{ id: 5, name: "고영조" }],
    contacts: [{ id: 6, name: "김담당" }],
    artists: [{ id: 7, name: "아티스트A", real_name: "" }],
    bizLicenseOk: true,
    projects: [], invoices: [],
    editHref: "/clients/10/edit",
  });
  assert.match(html, /261-81-02922/, "사업자번호");
  assert.match(html, /계산서 발행 이메일/, "계산서 이메일 라벨");
  assert.match(html, /고영조/, "대표");
  assert.match(html, /김담당/, "담당자");
  assert.match(html, /아티스트A/, "소속 아티스트");
  assert.match(html, /href="\/clients\/10\/edit"[^>]*>편집</, "[편집] 링크");
  assert.doesNotMatch(html, /data-dirty-form/, "읽기 뷰엔 편집 폼 없음");
  assert.doesNotMatch(html, /클라이언트/, "화면 문구에 '클라이언트' 없음");
});

test("clientReadView(company): 사업자등록증 없으면 경고 아이콘", () => {
  const html = clientReadView(company, { owners: [], contacts: [], artists: [], bizLicenseOk: false, projects: [], invoices: [], editHref: "/clients/10/edit" });
  assert.match(html, /사업자등록증 미등록/, "미등록 경고");
});

test("clientReadView(group): 소속사·멤버·[편집]", () => {
  const html = clientReadView(group, {
    members: [{ id: 8, name: "멤버1", display_name: "멤버1" }],
    agencyName: "주식회사 팡스타", agencyId: 30,
    groupContact: { id: 9, name: "방재혁" },
    projects: [], invoices: [], editHref: "/clients/20/edit",
  });
  assert.match(html, /주식회사 팡스타/, "소속사");
  assert.match(html, /href="\/clients\/30"/, "소속사 링크(업체·그룹 내부=같은 탭)");
  assert.match(html, /멤버1/, "멤버");
  assert.match(html, /방재혁/, "담당자");
  assert.match(html, /더윈드/, "그룹명 헤더");
});

test("clientReadView: 빈 섹션(프로젝트·청구 0) 숨김", () => {
  const html = clientReadView(company, { owners: [], contacts: [], artists: [], bizLicenseOk: true, projects: [], invoices: [], editHref: "/clients/10/edit" });
  assert.doesNotMatch(html, /청구 합계/, "청구 0이면 섹션 없음");
});
```

- [ ] **Step 2: 실패 확인**

Run: `node --test test/clients-views.test.js`
Expected: FAIL — `clientReadView is not a function`

- [ ] **Step 3: `clientReadView` 구현** — `src/views.clients.js`

`views.clients.js` 상단 import에 `personName`, `personLabel`, `formatKRW`를 추가한다(6행 `require("./views")` 목록에 추가):

```javascript
const { esc, pageHeader, explain, dirtyActionRow, personCombo, companyCombo, projectTypeBadge, personName, personLabel, copyable, formatKRW } = require("./views");
```

파일에 아래 함수를 추가(예: `clientFilesBlock` 정의 뒤):

```javascript
// 읽기 뷰에서 업체·그룹 '밖으로' 나가는 링크(연락처·프로젝트)는 새 탭 — 왼쪽 목록이 작업 맥락이라 같은 탭에서 나가면 돌아오기 번거롭다.
// 업체·그룹 '안'에 머무는 링크(소속사=다른 업체)는 같은 탭(마스터-디테일 유지).
const OUT_CLIENT = ' target="_blank" rel="noopener"';

/** 읽기 뷰 한 줄(라벨 + 값 HTML). 값은 이미 esc/copyable 처리된 신뢰 HTML. */
function clientReadRow(label, valueHtml) {
  return `<div class="border-t border-border/60 px-4 py-3 first:border-t-0">
      <div class="text-xs text-muted">${esc(label)}</div>
      <div class="mt-0.5 text-sm">${valueHtml}</div>
    </div>`;
}

/** 사업자등록증 미등록 경고 아이콘(사업자번호 옆). */
const CERT_MISSING_ICON = ` <span title="사업자등록증 미등록" aria-label="사업자등록증 미등록" class="ml-0.5 inline-flex align-middle text-warning"><svg class="h-3.5 w-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0Z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg></span>`;

/**
 * 업체·그룹 읽기 뷰 — 탭 없이 한 화면 스크롤(연락처 contactReadView와 대칭). 빈 섹션은 헤딩까지 통째로 숨김.
 * 편집은 별도 경로(editHref) — 상세=바로 편집을 읽기 후 편집으로 뒤집음(2026-07-18, 연락처와 통일).
 */
function clientReadView(c, { owners = [], contacts = [], artists = [], members = [], agencyName = "", agencyId = null, groupContact = null, bizLicenseOk = false, projects = [], invoices = [], editHref } = {}) {
  const { invoiceRow } = require("./views.invoices"); // 지연 require(순환 회피)
  const dash = '<span class="text-muted">—</span>';
  const isCompany = c.kind === "company";

  // 헤더: 이름 + 배지 + [편집]
  const badges = isCompany
    ? (clientRoleList(c).length ? clientRoleList(c).map((r) => `<span class="badge badge-neutral">${esc(companyRoleLabel(r))}</span>`).join(" ") : `<span class="badge badge-neutral">업체</span>`)
    : `<span class="badge badge-info">그룹</span>`;
  const title = isCompany ? c.name : (c.activity_name || c.name);
  const header = `<div class="mb-4 flex items-start justify-between gap-3">
      <div class="min-w-0">
        <h1 class="truncate font-display text-2xl font-semibold text-fg">${esc(title)}</h1>
        <div class="mt-1 flex flex-wrap gap-1">${badges}</div>
      </div>
      <a href="${esc(editHref)}" class="btn-ghost btn-sm shrink-0">편집</a>
    </div>`;

  const personLink = (p) => `<a href="/contacts/${p.id}"${OUT_CLIENT} class="text-primary hover:underline">${esc(personName(p))} ↗</a>`;

  let infoCard, extraSections = "";
  if (isCompany) {
    const ownerLinks = owners.length ? owners.map(personLink).join(" · ") : dash;
    infoCard = `<div class="card p-0">
        ${clientReadRow("사업자등록번호", (c.biz_no ? copyable(c.biz_no) : dash) + (bizLicenseOk ? "" : CERT_MISSING_ICON))}
        ${clientReadRow("대표", ownerLinks)}
        ${clientReadRow("사업장 주소", c.address ? copyable(c.address) : dash)}
        ${clientReadRow("계산서 발행 이메일", c.email ? copyable(c.email) : dash)}
        ${clientReadRow("전화", c.phone ? copyable(c.phone) : dash)}
      </div>`;
    const contactsSec = contacts.length
      ? `<h2 class="mb-2 mt-6 font-display text-lg font-semibold text-fg">담당자 ${contacts.length}</h2><div class="card p-0">${contacts.map((p) => clientReadRow("", personLink(p))).join("")}</div>`
      : "";
    const artistsSec = artists.length
      ? `<h2 class="mb-2 mt-6 font-display text-lg font-semibold text-fg">소속 아티스트 ${artists.length}</h2><div class="card p-0">${artists.map((a) => clientReadRow("", `<a href="/contacts/${a.id}"${OUT_CLIENT} class="text-primary hover:underline">${esc(personLabel(a.name, a.real_name))} ↗</a>`)).join("")}</div>`
      : "";
    const filesSec = `<h2 class="mb-2 mt-6 font-display text-lg font-semibold text-fg">첨부 서류</h2><div class="card text-sm">${bizLicenseOk ? `<a href="/clients/${c.id}/files/biz_license/view" target="_blank" rel="noopener" data-popup-view class="text-primary hover:underline">사업자등록증 보기</a>` : `<span class="text-muted">사업자등록증 미등록</span>`}</div>`;
    extraSections = `${contactsSec}${artistsSec}${filesSec}`;
  } else {
    infoCard = `<div class="card p-0">
        ${clientReadRow("소속사", agencyId ? `<a href="/clients/${agencyId}" class="text-primary hover:underline">${esc(agencyName)}</a>` : (agencyName ? esc(agencyName) : dash))}
        ${clientReadRow("담당자", groupContact ? personLink(groupContact) : dash)}
      </div>`;
    const membersSec = members.length
      ? `<h2 class="mb-2 mt-6 font-display text-lg font-semibold text-fg">멤버 ${members.length}</h2><div class="card p-0">${members.map((m) => clientReadRow("", `<a href="/contacts/${m.id}"${OUT_CLIENT} class="text-primary hover:underline">${esc(personLabel(m.display_name || m.name, m.name))} ↗</a>`)).join("")}</div>`
      : "";
    extraSections = membersSec;
  }

  // 프로젝트·청구 — 있을 때만. 프로젝트=clientProjectCard(같은 파일), 청구=invoiceRow(공용) + 합계.
  const projectsSec = projects.length
    ? `<h2 class="mb-2 mt-6 font-display text-lg font-semibold text-fg">프로젝트 ${projects.length}</h2><div class="space-y-2">${projects.map((p) => clientProjectCard(p)).join("")}</div>`
    : "";
  let invoicesSec = "";
  if (invoices.length) {
    const total = invoices.reduce((s, i) => s + (i.amount || 0), 0);
    const paid = invoices.reduce((s, i) => s + (i.paid_amount || 0), 0);
    const due = total - paid;
    invoicesSec = `<h2 class="mb-2 mt-6 font-display text-lg font-semibold text-fg">청구·결제 ${invoices.length}</h2>
      <div class="card mb-3 flex flex-wrap gap-4 text-sm">
        <span>청구 합계 <b class="text-fg tabular">${formatKRW(total)}</b></span>
        <span>입금 <b class="text-success tabular">${formatKRW(paid)}</b></span>
        <span>미수 <b class="${due > 0 ? "text-danger" : "text-fg"} tabular">${formatKRW(due)}</b></span>
      </div>
      <div class="space-y-2">${invoices.map((i) => invoiceRow(i)).join("")}</div>`;
  }

  return `${header}
    ${infoCard}
    ${extraSections}
    ${projectsSec}
    ${invoicesSec}`;
}
```

export에 `clientReadView` 추가(177행 `module.exports`):

```javascript
module.exports = { FILE_KINDS, fileKindLabel, companyRoleLabel, clientRoleList, clientProjectCard, clientFileSection, clientFilesBlock, clientForm, clientReadView };
```

- [ ] **Step 4: 통과 확인**

Run: `node --test test/clients-views.test.js`
Expected: PASS (4 tests)

- [ ] **Step 5: 전체 스위트**

Run: `npm test 2>&1 | grep -E "pass |fail "`
Expected: fail 0

- [ ] **Step 6: 커밋**

```bash
git add src/views.clients.js test/clients-views.test.js
git commit -m "feat(clients): clientReadView 읽기 뷰 렌더러(업체·그룹)"
```

---

### Task 2: `clientEditPane` 렌더러 (편집 패널 — 현행 인라인 편집 내용 이동)

**Files:**
- Modify: `src/views.clients.js` (함수 추가 + export)
- Test: `test/clients-views.test.js` (테스트 추가)

**Interfaces:**
- Produces: `clientEditPane(c, opts) → string`
  - `opts`: `{ files=[], fileErr='', fileOk={}, contacts=[], companies=[], members=[], memberCandidates=[], crossRefsHtml='', cancelHref, returnTo=null }`
  - 반환: `clientForm(embedded, isEdit)` + (업체)첨부 블록 + (그룹)멤버 섹션 + 크로스링크. **취소 링크 포함**(`cancelHref`).
- Consumes: `clientForm`·`clientFilesBlock`(같은 파일), `listGroup`·`listRow`·`personCombo`·`emptyState`(views), `personLabel`. 현행 상세 라우트 620–626행 `infoContent` 조립을 그대로 옮긴 것.

> 참고: 멤버 섹션·크로스링크·첨부 블록 HTML은 현재 `clients.routes.js` 566–626행에서 라우트가 인라인으로 만든다. Task 5에서 라우트가 이 데이터를 조회해 `clientEditPane`에 넘긴다. 이 태스크는 **렌더 함수만** 만든다(라우트 배선은 Task 5).

- [ ] **Step 1: 실패 테스트 추가** — `test/clients-views.test.js` 하단에 추가

```javascript
const { clientEditPane } = require("../src/views.clients");

test("clientEditPane(company): 편집 폼(data-dirty-form)+취소", () => {
  const html = clientEditPane({ id: 10, kind: "company", name: "(주)도너츠컬처" }, {
    files: [], contacts: [], companies: [], cancelHref: "/clients/10",
  });
  assert.match(html, /data-dirty-form/, "편집 폼");
  assert.match(html, /href="\/clients\/10"[^>]*>← 취소</, "취소 링크");
  assert.match(html, /data-dropzone/, "업체 첨부 업로드");
});

test("clientEditPane(group): 멤버 추가/제거 폼", () => {
  const html = clientEditPane({ id: 20, kind: "group", name: "더윈드" }, {
    members: [{ id: 8, name: "멤버1", display_name: "멤버1" }],
    memberCandidates: [], cancelHref: "/clients/20",
  });
  assert.match(html, /멤버/, "멤버 섹션");
  assert.match(html, /\/clients\/20\/members/, "멤버 추가 폼 action");
  assert.match(html, /\/clients\/20\/members\/8\/remove/, "멤버 제거 폼");
});
```

- [ ] **Step 2: 실패 확인**

Run: `node --test test/clients-views.test.js`
Expected: FAIL — `clientEditPane is not a function`

- [ ] **Step 3: `clientEditPane` 구현** — `src/views.clients.js`

import에 `listGroup`, `listRow`, `emptyState`를 추가한다(이미 없으면). 그리고 함수 추가:

```javascript
/**
 * 편집 패널 — clientForm(dirty 저장) + (업체)첨부 + (그룹)멤버 섹션 + 크로스링크 + 취소.
 * 현행 상세 라우트의 infoContent 조립을 그대로 옮긴 것(2026-07-18 마스터-디테일 전환 — 편집을 /edit 경로로 분리).
 */
function clientEditPane(c, { files = [], fileErr = "", fileOk = {}, contacts = [], companies = [], members = [], memberCandidates = [], crossRefsHtml = "", cancelHref, returnTo = null } = {}) {
  const { listGroup, listRow, personCombo, emptyState } = require("./views");
  const isCompany = c.kind === "company";
  const cancel = `<a href="${esc(cancelHref)}" class="mb-3 inline-block text-sm text-primary hover:underline" data-no-guard>← 취소</a>`;
  const retInput = returnTo ? `<input type="hidden" name="return" value="${esc(returnTo)}" />` : "";
  const editCard = clientForm(c, true, files, fileErr, true, contacts, companies, true, false);
  const filesBlock = clientFilesBlock(c, files, fileErr, fileOk);
  const memberSection = c.kind === "group"
    ? `<div class="mb-6">
        <h3 class="mb-2 font-display text-lg font-semibold text-fg">멤버 <span class="text-sm font-normal text-muted">· 그룹 소속 아티스트</span></h3>
        ${members.length
          ? listGroup({ rows: members.map((m) => listRow({
              left: `<a href="/clients/${m.id}" class="font-medium text-fg hover:text-primary hover:underline">${esc(personLabel(m.display_name, m.name))}</a>`,
              right: `<form method="post" action="/clients/${c.id}/members/${m.id}/remove" data-confirm="${esc(m.display_name)} 님을 이 그룹에서 제거할까요? (아티스트 자체는 삭제되지 않고 그룹 연결만 해제)"><button class="btn-ghost btn-sm text-danger" type="submit">제거</button></form>`,
            })) })
          : emptyState("아직 등록된 멤버가 없습니다.", { card: true })}
        <form method="post" action="/clients/${c.id}/members" class="card mt-2 flex items-end gap-2">
          <div class="min-w-0 flex-1">
            <label class="label">멤버 추가 <span class="font-normal text-muted text-xs">(개인 아티스트 검색 또는 새로 등록)</span></label>
            ${personCombo({ idField: "member_id", nameField: "member_name", options: memberCandidates, companyOptions: companies, entityLabel: "멤버", placeholder: "멤버 검색 또는 새로 등록" })}
          </div>
          <button class="btn-primary shrink-0" type="submit">추가</button>
        </form>
      </div>`
    : "";
  return `${cancel}
    ${editCard}
    ${isCompany ? `<div class="mt-3">${filesBlock}</div>` : ""}
    ${crossRefsHtml ? `<div class="mt-3 space-y-1 text-sm">${crossRefsHtml}</div>` : ""}
    ${memberSection ? `<div class="mt-6">${memberSection}</div>` : ""}`;
}
```

> 주의: `clientForm`의 삭제 폼은 `returnTo`를 안 받지만 현행 그대로 둔다(삭제는 `/clients`로 복귀). `retInput`은 현재 미사용이나 향후 소속 폼 확장 대비로 선언만 — **미사용 변수 경고를 피하려면 이 줄을 빼도 된다**. 실제로는 빼라: `retInput` 선언 삭제.

export에 `clientEditPane` 추가.

- [ ] **Step 4: 통과 확인**

Run: `node --test test/clients-views.test.js`
Expected: PASS (6 tests)

- [ ] **Step 5: 커밋**

```bash
git add src/views.clients.js test/clients-views.test.js
git commit -m "feat(clients): clientEditPane 편집 패널 렌더러"
```

---

### Task 3: `GET /clients` 목록 → 2단(이름 목록 + 빈 패널)

**Files:**
- Modify: `src/routes/clients.routes.js` (43–210행 목록 라우트 재구성)
- Test: `test/clients-panes.test.js` (신규)

**Interfaces:**
- Consumes: `contactPanes`·`contactNameList`(views.contacts.js), `tabBar`·`searchBox`·`emptyState`·`pageHeader`·`flashBanner`·`layout`(views), `listClients`(data).
- Produces: `renderClients(req, sel, rightHtml)` 헬퍼(연락처 `renderContacts`와 대칭) — Task 4·5가 재사용. `sel`=선택된 조직 party 또는 null.

> `contactPanes`/`contactNameList`는 `views.contacts.js`가 export한다. clients.routes.js는 `require("../views.contacts")`로 가져온다.

- [ ] **Step 1: 실패 테스트 작성** — `test/clients-panes.test.js` (신규). **`test/contacts-panes.test.js`의 실제 패턴을 그대로 따른다**: 파일 하나 = `test()` 한 개 안에서 서버를 인라인 기동하고, 시드 후 `t.test()` 서브테스트로 나눈다. `get(p) → {status, html}`. 헬퍼(`withServer` 등) 없음. 아래 코드가 이 파일의 초기 형태다(Task 4·5가 서브테스트를 **이 test() 안에** 추가):

```javascript
"use strict";
process.env.NODE_ENV = "test";
process.env.DEV_LOGIN = "1";
process.env.PORT = String(4800 + (process.pid % 200)); // 다른 서버 테스트 대역과 겹치지 않게(contacts-panes=4500대)
const { tempDbPath } = require("./helpers");
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
});
```

> 시드 컬럼은 실제 `parties` 스키마에 맞춘다(위 컬럼명은 CLAUDE.md 데이터 모델 기준). 로드 에러 시 `node -e "require('./src/db').init()"`로 스키마 확인.

- [ ] **Step 2: 실패 확인**

Run: `node --test test/clients-panes.test.js`
Expected: FAIL(표가 아직 렌더됨 / 빈 패널 문구 없음)

- [ ] **Step 3: 목록 라우트 재구성** — `src/routes/clients.routes.js`

상단 import에 추가:
```javascript
const { contactPanes, contactNameList } = require("../views.contacts");
const { clientReadView, clientEditPane } = require("../views.clients"); // Task 4·5에서 사용(미리 추가 OK)
```

`GET /`(43–210행)를 아래 `renderClients` 호출로 축소한다. **레거시 사람 탭 302(45–49행)는 유지**. 그 아래 목록 조립(50–210행)을 삭제하고 `renderClients(req, null)` 반환으로 대체:

```javascript
router.get("/", (req, res) => {
  const legacyPeopleTab = { associate: "associate", artist: "artist" }[String(req.query.group || "")];
  if (legacyPeopleTab) {
    const q0 = String(req.query.q || "").trim();
    return res.redirect(`/contacts?tab=${legacyPeopleTab}${q0 ? `&q=${encodeURIComponent(q0)}` : ""}`);
  }
  res.send(renderClients(req, null));
});
```

파일 하단(라우트 정의부 뒤, `module.exports` 앞)에 `renderClients` 헬퍼 추가. 연락처 `renderContacts`(contacts.routes.js:300–363)를 업체·그룹용으로 옮긴 것:

```javascript
// 2단 렌더(연락처 renderContacts와 대칭) — 왼쪽 업체/그룹 탭+검색+이름 목록, 오른쪽 rightHtml(없으면 빈 패널).
function renderClients(req, sel, rightHtml) {
  const q = String(req.query.q || "").trim();
  const group = ["company", "group"].includes(req.query.group) ? req.query.group : "company";
  const all = listClients({});
  const companyCount = all.filter((c) => c.kind === "company").length;
  const groupCount = all.filter((c) => c.kind === "group").length;
  let rows = all.filter((c) => c.kind === group);
  if (q) { const ql = q.toLowerCase(); rows = rows.filter((c) => String(c.name || "").toLowerCase().includes(ql)); }
  const keep = `?group=${group}${q ? "&q=" + encodeURIComponent(q) : ""}`;

  const tabs = tabBar({
    tabs: [
      { key: "company", label: `업체 ${companyCount}` },
      { key: "group", label: `그룹 ${groupCount}` },
    ],
    activeKey: group,
    hrefFn: (k) => `/clients?group=${k}${q ? "&q=" + encodeURIComponent(q) : ""}`,
  });
  const searchBar = searchBox({
    action: "/clients", q, placeholder: group === "group" ? "그룹 검색" : "업체명 검색", label: group === "group" ? "그룹 검색" : "업체 검색",
    liveFilter: true, noButton: true, hidden: `<input type="hidden" name="group" value="${esc(group)}" />`,
  });
  const resultNote = q
    ? `<div class="mb-3 text-sm text-muted">"${esc(q)}" 결과 ${rows.length}건 · <a href="/clients?group=${group}" class="text-primary hover:underline">전체 보기</a></div>`
    : "";
  const list = rows.length
    ? contactNameList({ rows, selectedId: sel ? sel.id : null, hrefFn: (c) => `/clients/${c.id}${keep}` })
    : q
      ? emptyState(`"${esc(q)}" 검색 결과가 없습니다.`, { card: true, icon: "clients" })
      : group === "group"
        ? emptyState("등록된 그룹이 없습니다.", { card: true, icon: "clients", cta: { href: "/clients/new?type=group", label: "+ 새 그룹" } })
        : emptyState("등록된 업체가 없습니다.", { card: true, icon: "clients", cta: { href: "/clients/new?type=company", label: "+ 새 업체" } });

  const left = `${searchBar}${resultNote}${list}`;
  const right = rightHtml || (sel ? readPaneForClient(sel) : emptyState("업체·그룹을 선택하세요.", { card: true, icon: "clients" }));

  // 신규 업체·그룹 드롭다운(현행 [data-menu] 팝오버) — 헤더 우측 액션.
  const action = newClientMenuHtml(); // 아래 참조(현행 목록 라우트의 드롭다운 마크업을 그대로 옮긴다)
  const body = `
    ${flashBanner(req.query)}
    ${pageHeader({ title: "업체·그룹", action })}
    ${tabs}
    ${contactPanes({ left, right, hasSelection: !!sel, backHref: `/clients${keep}`, backLabel: "업체·그룹" })}`;
  return layout({ title: sel ? sel.name : "업체·그룹", user: req.user, current: "/clients", body, wide: true });
}
```

`newClientMenuHtml()` = 현행 목록 라우트(약 190–200행)의 `+ 새 업체·그룹` 드롭다운(`<details data-menu>` 팝오버) 마크업을 그대로 반환하는 작은 헬퍼로 추출한다(업체/그룹 2택, `/clients/new?type=company`·`/clients/new?type=group`). 그 마크업을 이 파일에서 찾아 그대로 옮길 것.

`readPaneForClient`·`editPaneForClient`는 Task 4·5에서 정의한다. Task 3에서는 `sel`이 항상 null이라 `readPaneForClient` 미호출 — 하지만 참조가 있으면 정의 필요하니, Task 3에서는 `const right = rightHtml || emptyState("업체·그룹을 선택하세요.", { card: true, icon: "clients" });`로 두고, Task 4에서 `sel ? readPaneForClient(sel) : ...`로 확장한다.

- [ ] **Step 4: CSS 빌드 + 통과 확인**

Run: `npm run build:css && node --test test/clients-panes.test.js`
Expected: PASS

- [ ] **Step 5: 전체 스위트**

Run: `npm test 2>&1 | grep -E "pass |fail "`
Expected: 일부 기존 clients 테스트(표 기대)·contacts-panes 그룹열 테스트가 **깨질 수 있음** — Task 6에서 정리. 이 태스크에선 `clients-panes.test.js` 신규만 녹색이면 진행.

- [ ] **Step 6: 커밋**

```bash
git add src/routes/clients.routes.js test/clients-panes.test.js
git commit -m "feat(clients): 목록을 2단(이름 목록+빈 패널)로 — dataTable 제거"
```

---

### Task 4: `GET /clients/:id` → 2단 읽기 뷰

**Files:**
- Modify: `src/routes/clients.routes.js` (상세 라우트 498–633행 재구성 + `readPaneForClient` 추가)
- Test: `test/clients-panes.test.js` (테스트 추가)

**Interfaces:**
- Consumes: `clientReadView`(views.clients), `getParty`·`listCompanyOwners`·`listOrgContacts`·`listArtistsForAgency`·`listGroupMembers`·`currentAgencyId`·`currentAgencyName`·`listProjectsForParty`·`listInvoicesForParty`·`listClientFiles`(data), `storage.exists`, `safePath`.
- Produces: `readPaneForClient(c) → string`(읽기 뷰 조립). `renderClients`가 `sel` 있을 때 호출.

- [ ] **Step 1: 실패 테스트 추가** — `test/clients-panes.test.js`의 `test()` 블록 안에 서브테스트 추가(companyId·personId·get·raw 재사용)

```javascript
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
```

- [ ] **Step 2: 실패 확인**

Run: `node --test test/clients-panes.test.js`
Expected: FAIL(상세가 아직 편집 폼을 렌더 → data-dirty-form 매칭)

- [ ] **Step 3: 상세 라우트 재구성** — `src/routes/clients.routes.js`

`GET /:id`(498–633행)에서 **사람 302 분기(503–511행)는 그대로 유지**. 그 아래 탭·편집 폼 조립(512–632행) 전체를 아래로 교체:

```javascript
  // 읽기 뷰 데이터 조회
  const from = String(req.query.from || "");
  const fromOk = from && /^[\w=&%.\-]*$/.test(from);
  const ret = safePath(String(req.query.return || ""));
  const clientsBackHref = ret || (fromOk ? `/clients?${from}` : "/clients");
  res.send(renderClients(req, c, readPaneForClient(c), clientsBackHref));
```

`renderClients` 시그니처를 `(req, sel, rightHtml, backHref)`로 확장하고, `contactPanes`의 `backHref`에 `backHref || /clients${keep}`를 넘긴다. (Task 3에서 만든 `renderClients`의 `right`를 `rightHtml || (sel ? readPaneForClient(sel) : 빈패널)`로 두었으므로, 상세는 `rightHtml`을 직접 넘긴다.)

`renderClients` 아래에 `readPaneForClient` 추가:

```javascript
// 읽기 패널 — 상세 데이터 조회 + clientReadView 조립(연락처 readPaneFor와 대칭). c=조직 party.
async function readPaneForClient(c) { /* 아래 주의 참조 — 동기 버전 */ }
```

> **주의(async)**: `storage.exists`는 async다. 현행 상세 라우트는 `await`로 fileOk를 계산한다(519–522행). 읽기 뷰도 사업자등록증 접근 가능 여부가 필요하다. 따라서 `readPaneForClient`를 **async**로 만들고 상세 라우트에서 `await`한다:

```javascript
router.get("/:id", asyncHandler(async (req, res) => {
  const c = getParty(Number(req.params.id));
  if (!c) return res.status(404).send(errorPage({ code: 404, title: "업체·그룹을 찾을 수 없습니다", message: "삭제되었거나 주소가 잘못되었습니다.", user: req.user }));
  if (c.kind === "person") { /* 기존 302 분기 그대로 */ }
  const from = String(req.query.from || "");
  const fromOk = from && /^[\w=&%.\-]*$/.test(from);
  const ret = safePath(String(req.query.return || ""));
  const clientsBackHref = ret || (fromOk ? `/clients?${from}` : "/clients");
  const right = await readPaneForClient(c);
  res.send(renderClients(req, c, right, clientsBackHref));
}));

async function readPaneForClient(c) {
  const isCompany = c.kind === "company";
  const files = listClientFiles(c.id);
  let bizOk = false;
  const biz = files.find((f) => f.kind === "biz_license");
  if (biz) { try { bizOk = await storage.exists(biz.storage_backend, biz.file_id); } catch (_e) { bizOk = true; } }
  const opts = {
    projects: listProjectsForParty(c.id),
    invoices: listInvoicesForParty(c.id),
    editHref: `/clients/${c.id}/edit`,
  };
  if (isCompany) {
    opts.owners = listCompanyOwners(c.id);
    opts.contacts = listOrgContacts(c.id);
    opts.artists = listArtistsForAgency(c.id);
    opts.bizLicenseOk = bizOk;
  } else {
    opts.members = listGroupMembers(c.id);
    opts.agencyId = currentAgencyId(c.id);
    opts.agencyName = currentAgencyName(c.id);
    opts.groupContact = c.contact_party_id ? getParty(c.contact_party_id) : null;
  }
  return clientReadView(c, opts);
}
```

`renderClients`의 `backHref` 인자 반영: `function renderClients(req, sel, rightHtml, backHref) { ... contactPanes({ ..., backHref: backHref || `/clients${keep}`, backLabel: "업체·그룹" }) ... }`.

- [ ] **Step 4: 통과 확인**

Run: `npm run build:css && node --test test/clients-panes.test.js`
Expected: PASS

- [ ] **Step 5: 커밋**

```bash
git add src/routes/clients.routes.js test/clients-panes.test.js
git commit -m "feat(clients): 상세를 2단 읽기 뷰로(사람은 연락처 302 유지)"
```

---

### Task 5: `GET /clients/:id/edit` + POST 복귀 경로 → 2단 편집

**Files:**
- Modify: `src/routes/clients.routes.js` (`/:id/edit` 라우트 되살리기 + `editPaneForClient` + POST 복귀 경로)
- Test: `test/clients-panes.test.js` (테스트 추가)

**Interfaces:**
- Consumes: `clientEditPane`(views.clients), `listClientFiles`·`listContacts`·`listClients`·`listGroupMembers`·`artistPersonOptions`·`listCompanyOwners`·`currentAgencyId`·`currentAgencyName`(data), `personName`.
- Produces: `editPaneForClient(c, returnTo) → string`.

- [ ] **Step 1: 실패 테스트 추가** — `test/clients-panes.test.js`의 `test()` 블록 안에 서브테스트 추가

```javascript
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
```

- [ ] **Step 2: 실패 확인**

Run: `node --test test/clients-panes.test.js`
Expected: FAIL — `/clients/:id/edit`가 아직 상세로 리다이렉트하거나 편집 폼 없음

- [ ] **Step 3: 편집 라우트 구현** — `src/routes/clients.routes.js`

현행 `/:id/edit`(있다면 상세로 redirect하는 것)를 아래로 교체(없으면 `GET /:id` 앞에 추가 — Express는 정적 세그먼트 `/edit`가 `/:id`보다 먼저 매칭되도록 **`/:id/edit`를 `/:id`보다 위**에 둘 것):

```javascript
router.get("/:id/edit", asyncHandler(async (req, res) => {
  const c = getParty(Number(req.params.id));
  if (!c) return res.status(404).send(errorPage({ code: 404, title: "업체·그룹을 찾을 수 없습니다", message: "삭제되었거나 주소가 잘못되었습니다.", user: req.user }));
  if (c.kind === "person") return res.redirect(`/contacts/${c.id}/edit`);
  const returnTo = safePath(String(req.query.return || "")) || null;
  res.send(renderClients(req, c, editPaneForClient(c, returnTo), `/clients/${c.id}`));
}));
```

`editPaneForClient` 추가:

```javascript
// 편집 패널 — 데이터 조회 + clientEditPane 조립(연락처 editPaneFor와 대칭).
function editPaneForClient(c, returnTo = null) {
  const files = listClientFiles(c.id);
  const isCompany = c.kind === "company";
  const companies = listClients({}).filter((x) => x.kind === "company");
  if (!isCompany) { c.agency_id = currentAgencyId(c.id); c.agency_name = currentAgencyName(c.id); } // 소속사 콤보 기본값
  // 크로스링크(대표자 연락처) — 현행 상세 crossRefBlock의 대표자 부분만 유지(연락처로 보기·소속 그룹은 조직엔 무의미).
  const crossRefsHtml = (() => {
    const owners = isCompany ? listCompanyOwners(c.id) : [];
    if (!owners.length) return "";
    const links = owners.map((o) => `<a href="/contacts/${o.id}" class="text-primary hover:underline">${esc(personName(o))} ↗</a>`).join(" · ");
    return `<div><span class="text-muted">대표자 연락처</span> ${links}</div>`;
  })();
  return clientEditPane(c, {
    files,
    contacts: listContacts({}),
    companies,
    members: c.kind === "group" ? listGroupMembers(c.id) : [],
    memberCandidates: c.kind === "group" ? artistPersonOptions().filter((a) => Number(a.group_id) !== c.id) : [],
    crossRefsHtml,
    cancelHref: returnTo || `/clients/${c.id}`,
    returnTo,
  });
}
```

**POST 복귀 경로 변경**(편집 모드 액션이므로 편집 뷰로 복귀):
- `POST /:id`(저장, 342–375행): noscript 복귀를 `/clients/:id?flash=saved`(읽기 뷰) 유지 — 저장은 **읽기 뷰**로. AJAX(`X-Requested-With`) 응답은 무변경.
- `POST /:id/files/:kind` 및 `/delete`(첨부, 490–495행 등): 복귀를 `/clients/:id` → **`/clients/:id/edit`**로 변경(`res.redirect(`/clients/${id}/edit?ferr=...` 또는 `?flash=deleted`)). 편집 화면에서 업로드하므로.
- `POST /:id/members`·`/:id/members/:mid/remove`(멤버): 복귀를 `/clients/:id` → **`/clients/:id/edit`**로 변경.
- `POST /:id/delete`(삭제): `/clients?flash=deleted` 유지.

각 POST 핸들러에서 `res.redirect(`/clients/${id}...`)`를 찾아 위 규칙대로 `/edit` 추가(첨부·멤버만; 저장·삭제는 그대로).

- [ ] **Step 4: 통과 확인**

Run: `npm run build:css && node --test test/clients-panes.test.js`
Expected: PASS

- [ ] **Step 5: 커밋**

```bash
git add src/routes/clients.routes.js test/clients-panes.test.js
git commit -m "feat(clients): 편집을 /clients/:id/edit 2단으로 분리 + POST 복귀 경로"
```

---

### Task 6: 정리 · 기존 계약 갱신 · 문서

**Files:**
- Modify: `src/routes/clients.routes.js`(죽은 코드 제거), `test/contacts-panes.test.js`(그룹 담당자 열 테스트 삭제), `test/nav.test.js`(clients 계약), `CLAUDE.md`
- Test: 전체 스위트

**Interfaces:** 없음(정리·문서).

- [ ] **Step 1: 죽은 코드 제거** — `src/routes/clients.routes.js`
  - 목록 라우트에서 이미 제거됐어야 할 잔재 확인: `dataTable`·`orgCols`·`orgRows`·`agencyByParty`·`contactByGroup`·`bizLicenseSet`·`bizLicenseMissingIcon`(목록용)·`capList`·`searchBox({remote})`·`?from=`·`?return=` 행 링크 파라미터가 목록 경로에 남아 있으면 삭제. (읽기 뷰에서 쓰는 `listArtistsForAgency` 등 조회는 유지.)
  - 사용 안 하게 된 import 정리(`dataTable`·`capList`·`copyable`(목록에서만 썼다면) 등) — 단 다른 곳에서 쓰면 유지.
  - `import` 그대로 두고 `grep`으로 미사용 확인: `node -e "require('./src/routes/clients.routes.js')"` 로드 에러 없어야.

- [ ] **Step 2: `contacts-panes.test.js` 갱신**
  - 그룹 탭 **담당자 열** 검증 테스트(231–234행 부근)를 삭제한다(목록이 이름만이 되어 열이 없음). `/clients` 2탭·사람 302·`type=artist` POST 유지 테스트는 존치.

Run: `node --test test/contacts-panes.test.js`
Expected: PASS

- [ ] **Step 3: `nav.test.js` 갱신**
  - clients 분기: 상세 백링크 `safePath` 사용은 유지. **목록 행 링크의 `return=${encodeURIComponent(req.originalUrl)}` 계약**은 2단 전환으로 제거됐으므로 해당 assert를 삭제/완화. [편집] 링크·읽기↔편집 왕복만 확인하도록 갱신.

Run: `node --test test/nav.test.js`
Expected: PASS

- [ ] **Step 4: guardrails 확인**

Run: `node --test test/guardrails-ui.test.js`
Expected: PASS — 읽기 뷰·2단 라우트에 '클라이언트' 문구 없음(⑯), 편집 패널 data-* 마커 정상(⑧).

- [ ] **Step 5: 전체 스위트 + CSS 빌드**

Run: `npm run build:css && npm test 2>&1 | grep -E "tests |pass |fail "`
Expected: fail 0

- [ ] **Step 6: CLAUDE.md 갱신**
  - '업체·그룹' 섹션: "상세 = 인라인 편집" → "상세 = 2단 읽기 뷰 + [편집](연락처와 통일, 2026-07-18)"로 갱신. dataTable 목록 서술 → 이름 목록(마스터-디테일) 서술. 아키텍처 '레이아웃 통일'/'돌아가기 규약'에 clients 2단 반영. `views.clients.js` `clientReadView`/`clientEditPane` 추가 기술.
  - "상세=바로 편집(2026-07-01)" 언급에 clients도 읽기 후 편집으로 뒤집었음을 명시(연락처에 이어).

- [ ] **Step 7: 커밋**

```bash
git add -A
git commit -m "chore(clients): 마스터-디테일 전환 정리 — 죽은 코드·테스트 계약·CLAUDE.md"
```

---

## Self-Review 결과(작성자 확인)

- **Spec 커버리지**: 화면·라우트(목록/상세/편집 3분기)=Task 3/4/5 ✓. 읽기 뷰 구성(업체/그룹 항목)=Task 1 ✓. 편집 뷰=Task 2+5 ✓. 반응형(contactPanes 재사용)=Task 3 ✓. 제거·정리(dataTable·capList·행 return·그룹 담당자 열)=Task 6 ✓. 사람 302·백링크·삭제 409=Task 4/5 유지 ✓. 나가는 링크 새 탭=Task 1(OUT_CLIENT) ✓.
- **비목표 준수**: clientForm 필드·저장 로직 무변경(이동만), 데이터 조회 무변경, SPA화 안 함, 연락처 화면 안 건드림 ✓.
- **타입 일관성**: `clientReadView`/`clientEditPane` 시그니처가 Task 4/5 호출부(`readPaneForClient`/`editPaneForClient`)와 일치. `renderClients(req, sel, rightHtml, backHref)` 시그니처 Task 3→4→5 확장 일관.
- **주의(구현자)**: ①`readPaneForClient`는 async(storage.exists) — 상세 라우트에서 await. ②`/:id/edit`를 `/:id`보다 위에 등록(라우트 순서). ③새 Tailwind 임의값 없음(contactPanes의 `lg:grid-cols-[18rem_...]`는 연락처가 이미 생성) — 그래도 각 태스크에서 `build:css` 실행. ④첨부·멤버 POST만 `/edit` 복귀, 저장·삭제는 읽기 뷰·목록.
- **E2E(구현 후 별도)**: 실브라우저 1512/1024/900/390 2단·단일 전환, 이름 클릭→읽기→편집→저장→읽기, 실시간 필터(업체 119) — finishing 전에 수행.
