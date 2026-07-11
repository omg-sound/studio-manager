# 프로젝트 목록 재설계 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 프로젝트 목록을 회사·아티스트 정체성 + 다가오는 세션 중심으로 재편하고, 진행 중/청구 필요/완료 3탭으로 나눈다.

**Architecture:** 데이터 레이어는 그대로 두고(기존 파생 필드 재사용), 라우트에서 3탭 분류·정렬을, 뷰(`views.projects.js`)에서 카드 렌더를 바꾼다. 탭 분류는 순수 함수로 뽑아 단위 테스트한다.

**Tech Stack:** Node ≥20, Express 4(CommonJS), 서버 렌더 HTML(`src/views.js` 계열), `node:test`(devDep 없음), Tailwind CLI.

## Global Constraints

- 돈=정수(원), 날짜=`"YYYY-MM-DD"` 문자열. KST 오늘 = `todayYmd()`(`src/lib/date.js`).
- CSP: 인라인 스크립트 0. 카드 상호작용은 네이티브 `<details>`만(무JS).
- 테스트 실행 = `npm test`(= `node --test test/*.test.js`, 셸 확장 — `**` 글롭 금지). 빌드 = `npm run build:css`.
- 데이터 레이어(`src/data/projects.js`) 쿼리는 추가하지 않는다(기존 `next_session_date`·`unbilled_cnt`·`is_completed`·`sess_scheduled`·`task_pending` 재사용).
- 커밋은 각 태스크 끝에서. main=자동배포이므로 **작업은 새 브랜치에서** 진행(실행 시 worktree/branch 격리).
- 기존 스타일 준수: `esc()`로 이스케이프, `tabular`/`text-muted`/`badge` 유틸 사용, 함수는 파일 내 기존 컨벤션 따름.

---

## File Structure

- `src/data/projects.js` — **신규 순수 함수** `splitProjectTabs(rows)` 추가·export. 쿼리 무변경.
- `src/routes/projects.routes.js` — GET `/` 3탭 분리(splitProjectTabs 사용)·탭 라벨·빈 상태·`tab` 파라미터(`active`/`billing`/`done`)·`projectListRow` 호출 인자 정리. `POST /:id/created-at` 상세 복귀 지원(`safePath`). `renderProjectDetail`이 `projectMetaCard`에 chief 전달.
- `src/views.projects.js` — `projectListRow` 카드 재구성(정체성 줄·부제·다음 세션·토글 바 카운트·탭별 금액/배지·`dateRow` 제거), 신규 헬퍼 `projectIdentity(p)`, `projectSummaryHtml` 세션 upcoming-우선 재정렬 + export, `projectMetaCard`에 chief 작성일 편집 필드.
- `test/project-list.test.js` — **신규**: splitProjectTabs·projectIdentity·projectListRow·projectSummaryHtml·projectMetaCard 단위 테스트.
- `test/smoke.test.js` — 스모크 경로에 `/projects?tab=billing` 추가.

---

## Task 1: 탭 분류 순수 함수 `splitProjectTabs`

**Files:**
- Modify: `src/data/projects.js` (함수 추가 + `module.exports`)
- Test: `test/project-list.test.js` (신규)

**Interfaces:**
- Produces: `splitProjectTabs(rows) → { active: Row[], billing: Row[], done: Row[] }`. `Row`는 `listProjects`가 반환하는 객체(`is_completed:boolean`, `unbilled_cnt:number`, `next_session_date:string|null`, `created_at:string` 등). `active`는 다가오는 세션 임박순(`next_session_date` 오름차순, 없는 항목은 뒤로, 동률/양쪽 없음은 입력 순서=SQL `created_at DESC` 유지). `billing`/`done`은 입력 순서 유지.

- [ ] **Step 1: 실패 테스트 작성** — `test/project-list.test.js` 생성

```js
"use strict";
const { test } = require("node:test");
const assert = require("node:assert");
const { splitProjectTabs } = require("../src/data/projects");

const row = (o) => ({ is_completed: false, unbilled_cnt: 0, next_session_date: null, created_at: "2026-07-01 10:00:00", ...o });

test("splitProjectTabs: 3그룹 상호 배타 + 합=전체", () => {
  const rows = [
    row({ id: 1, is_completed: false }),                       // active
    row({ id: 2, is_completed: true, unbilled_cnt: 2 }),       // billing
    row({ id: 3, is_completed: true, unbilled_cnt: 0 }),       // done
    row({ id: 4, is_completed: false, next_session_date: "2026-07-20" }), // active
  ];
  const { active, billing, done } = splitProjectTabs(rows);
  assert.deepStrictEqual(active.map((r) => r.id).sort(), [1, 4]);
  assert.deepStrictEqual(billing.map((r) => r.id), [2]);
  assert.deepStrictEqual(done.map((r) => r.id), [3]);
  assert.strictEqual(active.length + billing.length + done.length, rows.length, "합=전체");
});

test("splitProjectTabs: active는 다가오는 세션 임박순, 세션 없는 건 뒤로", () => {
  const rows = [
    row({ id: "none1" }),                                  // 세션 없음
    row({ id: "far", next_session_date: "2026-08-01" }),
    row({ id: "soon", next_session_date: "2026-07-15" }),
    row({ id: "none2" }),                                  // 세션 없음
  ];
  const { active } = splitProjectTabs(rows);
  assert.deepStrictEqual(active.map((r) => r.id), ["soon", "far", "none1", "none2"],
    "임박순 → 세션 없는 건 입력 순서로 뒤에");
});
```

- [ ] **Step 2: 테스트 실패 확인**

Run: `node --test test/project-list.test.js`
Expected: FAIL — `splitProjectTabs is not a function`

- [ ] **Step 3: 함수 구현** — `src/data/projects.js`에 추가(파일 하단 `module.exports` 직전 등 기존 함수들과 같은 위치)

```js
/**
 * 목록 rows를 진행 중(active)/청구 필요(billing)/완료(done) 3그룹으로 분류.
 *  - active  = !is_completed. 다가오는 세션 임박순(next_session_date ASC, 없으면 뒤로, 동률은 입력 순서=SQL created_at DESC 유지).
 *  - billing = is_completed && unbilled_cnt>0 (활동 끝났는데 미청구 — 지금 처리할 액션).
 *  - done    = is_completed && unbilled_cnt===0 (청구까지 끝난 아카이브).
 * Array.sort는 Node에서 안정 정렬이라 동률/양쪽 세션 없음은 SQL 순서를 보존한다.
 */
function splitProjectTabs(rows) {
  const list = rows || [];
  const active = list.filter((r) => !r.is_completed);
  const billing = list.filter((r) => r.is_completed && Number(r.unbilled_cnt) > 0);
  const done = list.filter((r) => r.is_completed && Number(r.unbilled_cnt) === 0);
  active.sort((a, b) => {
    const ad = a.next_session_date || "";
    const bd = b.next_session_date || "";
    if (ad && bd) return ad < bd ? -1 : ad > bd ? 1 : 0;
    if (ad) return -1; // a만 다가오는 세션 있음 → 앞
    if (bd) return 1;  // b만 있음 → a 뒤로
    return 0;          // 둘 다 없음 → 입력 순서 유지
  });
  return { active, billing, done };
}
```

그리고 `module.exports = { ... }`에 `splitProjectTabs`를 추가한다(기존 export 객체에 항목 추가).

- [ ] **Step 4: 테스트 통과 확인**

Run: `node --test test/project-list.test.js`
Expected: PASS (2 tests)

- [ ] **Step 5: 커밋**

```bash
git add src/data/projects.js test/project-list.test.js
git commit -m "feat(projects): splitProjectTabs 순수 함수(진행중/청구필요/완료 3분류·임박순)"
```

---

## Task 2: 라우트 GET `/` — 3탭 분리·정렬·라벨

**Files:**
- Modify: `src/routes/projects.routes.js:165-217` (목록 렌더 블록)

**Interfaces:**
- Consumes: `splitProjectTabs(rows)` (Task 1).
- Produces: 목록 페이지가 3탭(`active`/`billing`/`done`)을 렌더. `projectListRow(p, summary, { tab })` 호출 계약(Task 3에서 뷰가 이 시그니처를 구현).

- [ ] **Step 1: 3탭 분류·탭바·활성 목록 교체** — 기존 169~198행(진행 중/완료 2분류, `chief`, `projectListRow` 호출)을 아래로 교체

기존:
```js
  const ongoing = rows.filter((r) => !r.is_completed);
  const done = rows.filter((r) => r.is_completed).sort((a, b) => (Number(b.unbilled_cnt) > 0 ? 1 : 0) - (Number(a.unbilled_cnt) > 0 ? 1 : 0));
  const tab = req.query.tab === "done" ? "done" : "active";
  const activeRows = tab === "done" ? done : ongoing;
  const projTabs = rows.length
    ? renderTabs({
        tabs: [
          { key: "active", label: `진행 중 ${ongoing.length}` },
          { key: "done", label: `완료 ${done.length}` },
        ],
        activeKey: tab,
        hrefFn: (k) => `/projects?tab=${k}${q ? "&q=" + encodeURIComponent(q) : ""}`,
      })
    : "";
```
교체 후:
```js
  const { active, billing, done } = splitProjectTabs(rows);
  const tabGroups = { active, billing, done };
  const tab = ["billing", "done"].includes(req.query.tab) ? req.query.tab : "active";
  const activeRows = tabGroups[tab];
  const projTabs = rows.length
    ? renderTabs({
        tabs: [
          { key: "active", label: `진행 중 ${active.length}` },
          { key: "billing", label: `청구 필요 ${billing.length}` },
          { key: "done", label: `완료 ${done.length}` },
        ],
        activeKey: tab,
        hrefFn: (k) => `/projects?tab=${k}${q ? "&q=" + encodeURIComponent(q) : ""}`,
      })
    : "";
```

- [ ] **Step 2: 빈 상태 문구·목록 호출 교체** — 기존 191~198행

기존:
```js
  } else if (!activeRows.length) {
    list = emptyState(tab === "done" ? "완료된 프로젝트가 없습니다." : "진행 중인 프로젝트가 없습니다.", { card: true });
  } else {
    const chief = isChief(req.user); // 치프만 목록에서 작성일 인라인 수정
    const cap = capList(activeRows, req.query, (n) => `/projects?tab=${tab}${q ? "&q=" + encodeURIComponent(q) : ""}&limit=${n}`);
    const summaries = listProjectSummaries(cap.shown.map((r) => r.id)); // 인라인 요약(배치 2쿼리)
    list = `<div class="space-y-2">${cap.shown.map((p) => projectListRow(p, summaries[p.id], { isChief: chief, tab, q })).join("")}</div>${cap.more}`;
  }
```
교체 후:
```js
  } else if (!activeRows.length) {
    const emptyMsg = { active: "진행 중인 프로젝트가 없습니다.", billing: "청구가 필요한 프로젝트가 없습니다.", done: "완료된 프로젝트가 없습니다." }[tab];
    list = emptyState(emptyMsg, { card: true });
  } else {
    const cap = capList(activeRows, req.query, (n) => `/projects?tab=${tab}${q ? "&q=" + encodeURIComponent(q) : ""}&limit=${n}`);
    const summaries = listProjectSummaries(cap.shown.map((r) => r.id)); // 인라인 요약(배치 2쿼리)
    list = `<div class="space-y-2">${cap.shown.map((p) => projectListRow(p, summaries[p.id], { tab })).join("")}</div>${cap.more}`;
  }
```

- [ ] **Step 3: import 정리** — `src/routes/projects.routes.js:17` 부근 `const { listProjects, listProjectSummaries, ... } = require("../data");` 구조분해에 `splitProjectTabs`를 추가한다(`src/data.js`가 `...projects`로 스프레드하므로 projects.js에 export만 있으면 흐른다 — Task 1에서 export 완료). `isChief`는 이미 `require("../auth")`에서 import돼 있고 상세(Task 5)에서 쓰므로 유지.

- [ ] **Step 4: 서버 기동 스모크** — DEV_LOGIN으로 3탭 200 확인

```bash
pkill -f "src/server.js" 2>/dev/null; sleep 1
DEV_LOGIN=1 NODE_ENV=development node src/server.js & sleep 2
COOKIE=$(curl -s -c - "http://localhost:3000/dev-login" -o /dev/null | grep omg_session | awk '{print $NF}')
for t in active billing done; do
  code=$(curl -s -o /dev/null -w "%{http_code}" -b "omg_session=$COOKIE" "http://localhost:3000/projects?tab=$t")
  echo "tab=$t → $code"
done
pkill -f "src/server.js"
```
Expected: 각 탭 `200` (dev-login 쿠키 이름·포트는 프로젝트 실제값에 맞춰 조정; 200이면 성공).

> 참고: dev-login 흐름이 다르면 `WORKFLOW.md`의 로컬 검증 절차를 따른다. 핵심은 3탭 각각 200.

- [ ] **Step 5: 커밋**

```bash
git add src/routes/projects.routes.js
git commit -m "feat(projects): 목록 3탭(진행중/청구필요/완료)·진행중 임박순 정렬"
```

---

## Task 3: 카드 재구성 `projectListRow` + 정체성 헬퍼

**Files:**
- Modify: `src/views.projects.js` — `projectListRow`(63~116행) 재작성, `projectIdentity` 신규, `nextSessionLine` 오늘 색 강화(선택).
- Test: `test/project-list.test.js` (렌더 단언 추가)

**Interfaces:**
- Consumes: 라우트가 `projectListRow(p, summary, { tab })`로 호출(Task 2). `p`는 `listProjects` row(+`session_amount_total`).
- Produces: `projectIdentity(p) → string|null`. `projectListRow(p, summary, { tab }) → html`.

- [ ] **Step 1: 실패 테스트 추가** — `test/project-list.test.js`에 append

```js
const views = require("../src/views.projects");

const pRow = (o) => ({
  id: 7, title: "루나 1집 - 타이틀곡 '월광'", artist: "아이유", client_name: "(주)이담",
  contact_name: "김보종", contact_phone: "010-0000-0000", manager_name: "박수한",
  next_session_date: null, sess_scheduled: 0, sess_done: 0, task_cnt: 0, task_pending: 0, task_done: 0,
  unbilled_cnt: 0, track_titles: "", task_total: 0, session_amount_total: 0, rate: 0, invoice_discount_total: 0, ...o,
});
const emptySummary = { sessions: [], tracks: [], taskTypes: [] };

test("projectIdentity: 아티스트·회사, 중복·다중·폴백", () => {
  assert.strictEqual(views.projectIdentity(pRow()), "아이유 · (주)이담");
  assert.strictEqual(views.projectIdentity(pRow({ client_name: "아이유" })), "아이유", "회사=아티스트 중복 제외");
  assert.strictEqual(views.projectIdentity(pRow({ artist: "아이유,태연" })), "아이유 외 1 · (주)이담", "다중 아티스트 축약");
  assert.strictEqual(views.projectIdentity(pRow({ artist: "", client_name: "" })), null, "둘 다 없으면 null");
});

test("projectListRow 진행 중: 정체성 굵게·금액 없음·작성일 없음", () => {
  const html = views.projectListRow(pRow({ task_total: 500000 }), emptySummary, { tab: "active" });
  assert.match(html, /아이유 · \(주\)이담/);
  assert.doesNotMatch(html, /₩/, "진행 중 카드에 금액 없음");
  assert.doesNotMatch(html, /type="date"/, "작성일 입력 없음");
  assert.doesNotMatch(html, /곡·콘텐츠 미정/, "곡 없으면 '미정' 문구 없음");
});

test("projectListRow 청구 필요: 배지 + 금액 노출", () => {
  const html = views.projectListRow(pRow({ unbilled_cnt: 2, task_total: 500000 }), emptySummary, { tab: "billing" });
  assert.match(html, /청구 필요 2/);
  assert.match(html, /₩/, "청구 필요 탭엔 금액 표시");
});

test("projectListRow 다음 세션 없으면 줄 생략", () => {
  const html = views.projectListRow(pRow(), emptySummary, { tab: "active" });
  assert.doesNotMatch(html, /예정 세션 없음/);
  assert.doesNotMatch(html, /다음 세션/);
});
```

- [ ] **Step 2: 테스트 실패 확인**

Run: `node --test test/project-list.test.js`
Expected: FAIL — `views.projectIdentity is not a function` 및 렌더 단언 실패

- [ ] **Step 3: `projectIdentity` 헬퍼 추가** — `src/views.projects.js`의 `nextSessionLine` 근처(예: 55행 `trackCount` 아래)

```js
/** 카드 정체성 줄: "아티스트 · 회사". 회사가 아티스트 본인으로 파생된 경우 아티스트만. 여러 아티스트면 "외 N". 둘 다 없으면 null(→ 제목 승격). */
function projectIdentity(p) {
  const artists = String(p.artist || "").split(",").map((s) => s.trim()).filter(Boolean);
  let artistPart = "";
  if (artists.length === 1) artistPart = artists[0];
  else if (artists.length > 1) artistPart = `${artists[0]} 외 ${artists.length - 1}`;
  const company = String(p.client_name || "").trim();
  const parts = [];
  if (artistPart) parts.push(artistPart);
  if (company && company !== artistPart && !artists.includes(company)) parts.push(company);
  return parts.length ? parts.join(" · ") : null;
}
```

- [ ] **Step 4: `projectListRow` 재작성** — 63~116행 전체를 교체

```js
function projectListRow(p, summary, { tab = "active" } = {}) {
  const isBilling = tab === "billing";
  // 정체성(주) / 부제(프로젝트명). 정체성 없으면 제목을 주 줄로 승격(부제 생략).
  const identity = projectIdentity(p);
  const mainLine = identity ? esc(identity) : esc(p.title || "제목 없음");
  const subtitle = identity && p.title ? `<div class="mt-0.5 truncate text-sm text-muted">${esc(p.title)}</div>` : "";

  // 다음 세션(진행 중에서만 의미 — 완료/청구필요는 next_session_date가 null이라 자연 생략).
  const nextLine = nextSessionLine(p);

  // PM(우측 유지). 금액은 청구 필요 탭에서만.
  const pmLine = p.manager_name ? `<div class="text-xs text-muted">PM ${esc(p.manager_name)}</div>` : "";
  const amt = projectAmount(p);
  const amountLine = isBilling && amt ? `<div class="text-sm font-medium tabular">${formatKRW(amt)}</div>` : "";
  const rightCol = pmLine || amountLine ? `<div class="shrink-0 pl-2 text-right">${pmLine}${amountLine}</div>` : "";

  // 청구 필요 배지(청구 필요 탭 전용).
  const billingBadge = isBilling && Number(p.unbilled_cnt) > 0
    ? `<div class="mt-1"><span class="badge bg-warning/10 text-warning">청구 필요 ${p.unbilled_cnt}</span></div>` : "";

  // 접힘 토글 바 카운트 — 0·곡 없음은 생략(문구 없음). 전부 비면 최소 라벨.
  const n = trackCount(p);
  const taskCnt = Number(p.task_cnt) || 0;
  const taskStatus = [
    Number(p.task_pending) ? `대기 ${p.task_pending}` : "",
    Number(p.task_done) ? `완료 ${p.task_done}` : "",
  ].filter(Boolean).join(" · ");
  const trackPart = n ? `곡·콘텐츠 ${n}${taskCnt ? ` · 작업 ${taskCnt}${taskStatus ? ` (${taskStatus})` : ""}` : ""}` : "";
  const counts = [
    Number(p.sess_scheduled) ? `예정 세션 ${p.sess_scheduled}` : "",
    Number(p.sess_done) ? `완료 세션 ${p.sess_done}` : "",
    trackPart,
  ].filter(Boolean).join(" · ") || "세션·곡 상세";

  return `
    <div class="overflow-hidden rounded-xl border border-border/60 bg-surface">
      <a href="/projects/${p.id}" class="row-link flex items-start justify-between gap-3 px-4 py-3">
        <div class="min-w-0">
          <div class="truncate font-semibold">${mainLine}</div>
          ${subtitle}
          ${billingBadge}
          ${nextLine}
        </div>
        ${rightCol}
      </a>
      <details class="group/proj">
        <summary class="row-link flex cursor-pointer list-none items-center justify-between gap-2 border-t border-border/40 px-4 py-2 text-xs text-muted hover:text-fg">
          <span>${esc(counts)}</span>
          <svg class="h-3.5 w-3.5 shrink-0 transition-transform group-open/proj:rotate-180" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M6 8l4 4 4-4" /></svg>
        </summary>
        <div class="border-t border-border/40 bg-elevated/40 px-4 py-3 text-xs leading-relaxed">${projectSummaryHtml(summary)}</div>
      </details>
    </div>`;
}
```

- [ ] **Step 5: export 추가** — `src/views.projects.js` `module.exports`에 `projectIdentity`, `projectSummaryHtml` 추가(Task 4 테스트에서도 projectSummaryHtml 사용).

- [ ] **Step 6: 테스트 통과 확인**

Run: `node --test test/project-list.test.js`
Expected: PASS

- [ ] **Step 7: 커밋**

```bash
git add src/views.projects.js test/project-list.test.js
git commit -m "feat(projects): 카드 재구성(정체성 주·이름 부제·금액 청구필요 탭만·작성일 제거)"
```

---

## Task 4: 펼침 세션 upcoming-우선 재정렬

**Files:**
- Modify: `src/views.projects.js` — `projectSummaryHtml`(120~148행) 세션 정렬.
- Test: `test/project-list.test.js` (순서 단언 추가)

**Interfaces:**
- Consumes: `projectSummaryHtml(summary)` — `summary.sessions`는 `session_date ASC` 정렬된 배열(`listProjectSummaries`).
- Produces: 펼침 HTML에서 **다가오는 세션(오늘 이후)이 지난 세션보다 먼저** 렌더. 지난 세션은 `text-muted`.

- [ ] **Step 1: 실패 테스트 추가** — `test/project-list.test.js`에 append (오늘 기준은 `todayYmd`로 상대 계산)

```js
const { todayYmd } = require("../src/lib/date");

test("projectSummaryHtml: 다가오는 세션이 지난 세션보다 먼저", () => {
  const today = todayYmd();
  const y = Number(today.slice(0, 4));
  const past = `${y - 1}-01-01`;
  const future = `${y + 1}-12-31`;
  const summary = {
    sessions: [
      { session_date: past, start_time: "10:00", end_time: "12:00", session_type: "믹싱", status: "완료" },
      { session_date: future, start_time: "14:00", end_time: "16:00", session_type: "녹음", status: "예정" },
    ],
    tracks: [], taskTypes: [],
  };
  const html = views.projectSummaryHtml(summary);
  assert.ok(html.indexOf(String(y + 1)) < html.indexOf(String(y - 1)), "미래 세션이 과거 세션보다 앞에 렌더");
});
```

- [ ] **Step 2: 테스트 실패 확인**

Run: `node --test test/project-list.test.js`
Expected: FAIL — 현재는 `session_date ASC`라 과거가 앞 → 단언 실패

- [ ] **Step 3: `projectSummaryHtml` 세션 블록 수정** — 125~133행의 세션 처리 부분

기존:
```js
  if (s.sessions.length) {
    const items = s.sessions.slice(0, 8).map((se) => {
      const time = se.start_time ? ` ${esc(se.start_time)}${se.end_time ? "–" + esc(se.end_time) : ""}` : "";
      const st = se.status && se.status !== "예정" ? ` <span class="text-muted">· ${esc(se.status)}</span>` : "";
      return `<li><span class="tabular text-fg/80">${esc(formatYmdShort(se.session_date))}${time}</span> <span class="text-muted">· ${esc(se.session_type)}</span>${st}</li>`;
    }).join("");
    const more = s.sessions.length > 8 ? `<li class="text-muted">외 ${s.sessions.length - 8}건</li>` : "";
    blocks.push(`<div><div class="mb-0.5 font-medium text-fg/60">세션 ${s.sessions.length}</div><ul class="space-y-0.5">${items}${more}</ul></div>`);
  }
```
교체 후:
```js
  if (s.sessions.length) {
    // 다가오는 세션(오늘 이후) 먼저, 지난 세션은 그 뒤(최근 순)로 재정렬 — 지난 세션이 앞을 먹어 다가오는 게 잘리는 것 방지.
    const today = todayYmd();
    const upcoming = s.sessions.filter((se) => se.session_date >= today);
    const past = s.sessions.filter((se) => se.session_date < today).reverse();
    const ordered = [...upcoming, ...past];
    const items = ordered.slice(0, 8).map((se) => {
      const time = se.start_time ? ` ${esc(se.start_time)}${se.end_time ? "–" + esc(se.end_time) : ""}` : "";
      const st = se.status && se.status !== "예정" ? ` <span class="text-muted">· ${esc(se.status)}</span>` : "";
      const dateCls = se.session_date < today ? "text-muted" : "text-fg/80";
      return `<li><span class="tabular ${dateCls}">${esc(formatYmdShort(se.session_date))}${time}</span> <span class="text-muted">· ${esc(se.session_type)}</span>${st}</li>`;
    }).join("");
    const more = s.sessions.length > 8 ? `<li class="text-muted">외 ${s.sessions.length - 8}건</li>` : "";
    blocks.push(`<div><div class="mb-0.5 font-medium text-fg/60">세션 ${s.sessions.length}</div><ul class="space-y-0.5">${items}${more}</ul></div>`);
  }
```

- [ ] **Step 4: 테스트 통과 확인**

Run: `node --test test/project-list.test.js`
Expected: PASS

- [ ] **Step 5: 커밋**

```bash
git add src/views.projects.js test/project-list.test.js
git commit -m "feat(projects): 펼침 세션을 다가오는 세션 우선으로 재정렬"
```

---

## Task 5: 작성일 편집을 프로젝트 상세로 이동

**Files:**
- Modify: `src/views.projects.js` — `projectMetaCard(p, err, opts)`에 chief 작성일 편집 필드.
- Modify: `src/routes/projects.routes.js` — `renderProjectDetail`이 chief 전달; `POST /:id/created-at`이 상세 복귀 지원(`safePath`).
- Test: `test/project-list.test.js` (projectMetaCard 렌더 단언)

**Interfaces:**
- Consumes: `isChief(user)`(auth), `safePath(v)`(`../lib/nav`).
- Produces: `projectMetaCard(p, err, { chief }) → html`. chief면 작성일 `type="date"` 폼(action `/projects/:id/created-at`, hidden `return=/projects/:id?tab=project`) 포함.

- [ ] **Step 1: 실패 테스트 추가** — `test/project-list.test.js`에 append

```js
test("projectMetaCard: 치프만 작성일 편집 필드", () => {
  const p = pRow({ created_at: "2026-07-01 10:00:00" });
  const chiefHtml = views.projectMetaCard(p, "", { chief: true });
  assert.match(chiefHtml, /\/projects\/7\/created-at/);
  assert.match(chiefHtml, /type="date"/);
  const plainHtml = views.projectMetaCard(p, "", { chief: false });
  assert.doesNotMatch(plainHtml, /\/projects\/7\/created-at/);
});
```

- [ ] **Step 2: 테스트 실패 확인**

Run: `node --test test/project-list.test.js`
Expected: FAIL — 현재 `projectMetaCard`는 작성일 필드 없음

- [ ] **Step 3: `projectMetaCard` 수정** — 204~210행

기존:
```js
function projectMetaCard(p, err = "") {
  return `
    <div class="card">
      <form id="del-proj-${p.id}" method="post" action="/projects/${p.id}/delete" data-confirm="프로젝트를 삭제하면 세션·곡·콘텐츠·자료가 모두 삭제됩니다. 정말 삭제할까요?" class="hidden"></form>
      ${projectEditForm(p, err)}
    </div>`;
}
```
교체 후:
```js
function projectMetaCard(p, err = "", { chief = false } = {}) {
  // 치프 전용 작성일(생성일) 편집 — 완료/청구 필요 탭 정렬(작성일순)에 영향. 목록에서 상세로 이동(2026-07-11).
  const dateStr = esc(String(p.created_at || "").slice(0, 10));
  const createdEdit = chief
    ? `<form method="post" action="/projects/${p.id}/created-at" class="mb-3 flex items-center gap-2 border-b border-border/40 pb-3">
         <input type="hidden" name="return" value="/projects/${p.id}?tab=project" />
         <label class="text-xs text-muted">작성일</label>
         <input type="date" name="created_at" value="${dateStr}" data-autosubmit class="rounded border border-border/70 bg-surface px-1.5 py-0.5 text-xs text-muted tabular focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary/30" />
       </form>`
    : "";
  return `
    <div class="card">
      <form id="del-proj-${p.id}" method="post" action="/projects/${p.id}/delete" data-confirm="프로젝트를 삭제하면 세션·곡·콘텐츠·자료가 모두 삭제됩니다. 정말 삭제할까요?" class="hidden"></form>
      ${createdEdit}
      ${projectEditForm(p, err)}
    </div>`;
}
```

- [ ] **Step 4: `renderProjectDetail`에서 chief 전달** — `src/routes/projects.routes.js:313`

기존:
```js
  const meta = editable
    ? projectMetaCard({ ...p, ...(formState || {}) }, err)
    : projectMetaReadonly(p);
```
교체 후:
```js
  const meta = editable
    ? projectMetaCard({ ...p, ...(formState || {}) }, err, { chief: isChief(req.user) })
    : projectMetaReadonly(p);
```

- [ ] **Step 5: `POST /:id/created-at` 상세 복귀 지원** — `src/routes/projects.routes.js:270-282`

기존 마지막 redirect:
```js
  const tab = req.body.tab === "done" ? "done" : "active";
  const q = String(req.body.q || "").trim();
  res.redirect(`/projects?tab=${tab}${q ? "&q=" + encodeURIComponent(q) : ""}`);
```
교체 후:
```js
  const back = safePath(req.body.return);
  if (back) return res.redirect(back);
  const tab = ["billing", "done"].includes(req.body.tab) ? req.body.tab : "active";
  const q = String(req.body.q || "").trim();
  res.redirect(`/projects?tab=${tab}${q ? "&q=" + encodeURIComponent(q) : ""}`);
```
그리고 파일 상단 import에 `const { safePath } = require("../lib/nav");` 추가(없으면).

- [ ] **Step 6: 테스트 통과 확인**

Run: `node --test test/project-list.test.js`
Expected: PASS

- [ ] **Step 7: 커밋**

```bash
git add src/views.projects.js src/routes/projects.routes.js test/project-list.test.js
git commit -m "feat(projects): 작성일 편집을 목록에서 상세(치프 전용)로 이동"
```

---

## Task 6: 스모크 경로 갱신 + 전체 검증

**Files:**
- Modify: `test/smoke.test.js:40` (`/projects?tab=billing` 추가)

- [ ] **Step 1: 스모크 경로에 billing 탭 추가** — 40행

기존:
```js
      "/", "/projects", "/projects?tab=done", "/projects/new",
```
교체 후:
```js
      "/", "/projects", "/projects?tab=billing", "/projects?tab=done", "/projects/new",
```

- [ ] **Step 2: 전체 테스트 실행**

Run: `npm test`
Expected: 전체 PASS(신규 project-list 6종 + 기존 스모크·단위·가드). 실패 시 해당 태스크로 돌아가 수정.

- [ ] **Step 3: CSS 빌드 확인**

Run: `npm run build:css`
Expected: exit 0(새 유틸 클래스 사용분 포함 정상 빌드).

- [ ] **Step 4: DEV_LOGIN 실렌더 확인** — 3탭 시각 검증

```bash
pkill -f "src/server.js" 2>/dev/null; sleep 1
DEV_LOGIN=1 NODE_ENV=development node src/server.js & sleep 2
# 3탭 200 + 카드에 회사·아티스트 굵게, 진행중 금액 없음, 청구필요 배지·금액, 작성일 미표시 육안 확인
pkill -f "src/server.js"
```
Expected: 3탭 각 200. 진행 중 카드 = 정체성 굵게 + 다음 세션(있으면) + 접힘 카운트, 금액·작성일 없음. 청구 필요 카드 = '청구 필요 N' 배지 + 금액. 완료 카드 = 정체성 + 부제만.

- [ ] **Step 5: 문서 현행화** — `CLAUDE.md`(프로젝트 목록 섹션·완료 이력)와 `WORKFLOW.md`를 이번 변경(3탭·정체성 카드·금액 청구필요 탭만·작성일 상세 이동·펼침 세션 재정렬)으로 갱신. (프로젝트 규약: 기능 변경 커밋 직후 필수 현행화.)

- [ ] **Step 6: 커밋**

```bash
git add test/smoke.test.js CLAUDE.md WORKFLOW.md
git commit -m "test(projects): 스모크 billing 탭 + 목록 재설계 문서 현행화"
```

---

## Self-Review (작성자 체크)

- **Spec 커버리지**: 식별(정체성 주·이름 부제)=Task 3 / 정렬 임박순=Task 1·2 / 작성일 제거·상세 이동=Task 3·5 / 금액 청구필요 탭만=Task 3 / 3탭=Task 1·2 / 다음 세션·곡 없으면 생략=Task 3 / 펼침 세션 재정렬=Task 4 / 완료 탭 통일=Task 3(탭 무관 동일 카드). ✅ 전 항목 태스크 매핑됨.
- **범위 밖 준수**: 작업 마감일 미도입, 대시보드 카드 무변경, 완료/청구필요 임박순 미적용 — 계획에 포함 안 함. ✅
- **타입/시그니처 일관**: `splitProjectTabs(rows)→{active,billing,done}`, `projectListRow(p, summary, {tab})`, `projectIdentity(p)→string|null`, `projectMetaCard(p, err, {chief})` — 태스크 간 동일하게 사용. ✅
- **플레이스홀더**: 없음(모든 스텝에 실제 코드·명령·기대값). ✅
- **주의**: 라우트의 데이터 함수 import 경로(`../data` vs 개별 모듈)는 파일 실제 구조에 맞춰 `splitProjectTabs` 추가(Task 2 Step 3). dev-login 스모크 명령의 쿠키/포트는 프로젝트 실제 값으로 조정.
