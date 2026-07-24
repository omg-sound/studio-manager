# 믹싱/마스터링 세션 청구 레이더 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 믹싱/마스터링 세션만 마치고 곡·콘텐츠 작업을 아직 안 만든 프로젝트가 '완료'로 새지 않고 '청구 필요'에 잡히게 한다.

**Architecture:** `listProjects`의 `unbilled_cnt` 파생 SQL에 '후반작업 청구 미착수' 항(EXISTS→1)을 더한다. 청구 준비(작업·청구서)가 하나라도 생기면 자동으로 꺼져 기존 작업 기반 분류가 이어받는다. 청구 탭엔 왜 후보가 비었는지 안내 1줄을 추가한다.

**Tech Stack:** Node(CommonJS), SQLite(better-sqlite3/node:sqlite 어댑터), 서버 렌더 문자열 뷰, `node:test`.

## Global Constraints

- 돈=정수(원), 날짜=`"YYYY-MM-DD"` 문자열. 시간대 저장=UTC·표시=KST(`todayYmd()`는 KST).
- 세션 종류 하드코딩 비교 금지 — config 상수로(가드레일 ③, 기존 `RENTAL_SESSION_TYPES`/`RENTAL_IN` 패턴 준수).
- SQL IN절은 정적 config 값에서 조립(사용자 입력 아님). `@today` 파라미터는 `listProjects`에 이미 바인딩됨(`params = { today: todayYmd() }`).
- `is_completed` 판정·`listBillableSessionsForProject`·`computeInvoiceDraft`·대관(녹음·촬영·공연) 로직은 **변경 금지**. 이번 변경은 `unbilled_cnt`(탭 배정)와 청구 탭 안내 문구뿐.
- 설계 문서: `docs/superpowers/specs/2026-07-24-postprod-session-billing-radar-design.md`.

---

### Task 1: 후반작업 세션 '청구 미착수' 항 — 분류 수정(핵심)

**Files:**
- Modify: `src/config.js` — `POSTPROD_SESSION_TYPES` 상수 추가·export.
- Modify: `src/data/projects.js:15-16` (import·`POSTPROD_IN`), `src/data/projects.js:130-137` (`unbilled_cnt` SQL 항 추가).
- Test: `test/billing-radar.test.js` — 케이스 추가.

**Interfaces:**
- Consumes: `RENTAL_SESSION_TYPES`(기존), `todayYmd()`, `listProjects`, `splitProjectTabs`, `createSession`, `setSessionStatus`, `setSessionWaived`(테스트 헬퍼 이미 import됨).
- Produces: `POSTPROD_SESSION_TYPES`(config export, `["믹싱","마스터링"]`). `listProjects`의 각 행 `unbilled_cnt`가 후반작업 미착수 프로젝트에서 +1.

- [ ] **Step 1: config에 후반작업 세션 종류 상수 추가**

`src/config.js`의 `RENTAL_SESSION_TYPES = ["녹음", "촬영", "공연"];`(175줄 부근) 바로 아래에 추가:

```js
// 후반작업 세션 — 세션 자체는 청구 단위가 아니고 곡·콘텐츠 '작업'으로 청구한다.
// 세션만 마치고 작업을 안 만들면 청구할 게 없어 보여 완료로 샜다(2026-07-24) → unbilled_cnt에서 '청구 미착수' 신호로 쓴다.
const POSTPROD_SESSION_TYPES = ["믹싱", "마스터링"];
```

그리고 `module.exports`의 `RENTAL_SESSION_TYPES,` 바로 아래에 `POSTPROD_SESSION_TYPES,` 추가.

- [ ] **Step 2: projects.js에서 POSTPROD_IN 조립**

`src/data/projects.js:15-16`을 수정:

```js
const { RENTAL_SESSION_TYPES, POSTPROD_SESSION_TYPES } = require("../config");
const RENTAL_IN = RENTAL_SESSION_TYPES.map((t) => `'${t}'`).join(", "); // SQL IN절(정적 config 값 — 인젝션 무관)
const POSTPROD_IN = POSTPROD_SESSION_TYPES.map((t) => `'${t}'`).join(", "); // 후반작업(믹싱·마스터링) 세션 IN절
```

- [ ] **Step 3: 실패하는 테스트 작성**

`test/billing-radar.test.js` 맨 아래(`test.after` 위쪽 아무 곳, 기존 테스트들 뒤)에 추가. 파일 상단 헬퍼(`seedProject`, `projectRow`, `CHIEF`, `roomA`)를 재사용한다. 후반작업 세션 생성 헬퍼와 케이스를 함께 추가:

```js
// ── ③ 후반작업(믹싱/마스터링) 세션 청구 레이더 (2026-07-24) ──

/** 믹싱 세션 1건. done=true면 완료 처리. */
function seedMixSession(projectId, { date = "2026-07-01", done = true } = {}) {
  const s = createSession(CHIEF, projectId, {
    session_type: "믹싱",
    session_date: date,
    start_time: "14:00",
    end_time: "18:00",
    room_id: roomA,
  });
  if (done) setSessionStatus(CHIEF, s.id, "완료");
  return s;
}

/** 프로젝트에 곡+작업 1건 직접 삽입(직접 INSERT = 이 파일 셋업 스타일). 반환=taskId. */
function seedTask(projectId, { waived = 0, invoiced = 0 } = {}) {
  const trackId = Number(
    db().prepare("INSERT INTO project_tracks (project_id, title, content_type) VALUES (?, '곡', 'Music')").run(projectId).lastInsertRowid
  );
  return Number(
    db()
      .prepare("INSERT INTO track_tasks (track_id, task_type, billing_type, quantity, unit_price, total_price, status, waived, is_invoiced) VALUES (?, 'Mixing', 'Fixed_Per_Track', 1, 0, 0, 'Completed', ?, ?)")
      .run(trackId, waived, invoiced).lastInsertRowid
  );
}

test("믹싱 세션만 완료 + 작업 0 + 청구서 0 → 청구 필요(완료로 안 감)", () => {
  const pid = seedProject("믹스레이더");
  seedMixSession(pid, { done: true });
  const p = projectRow(pid);
  assert.ok(p.is_completed, "다가오는 세션·미완료 작업 없음 → is_completed");
  assert.ok(p.unbilled_cnt > 0, "후반작업 청구 미착수 → unbilled_cnt>0");
  const tabs = splitProjectTabs([p]);
  assert.equal(tabs.billing.length, 1, "청구 필요 탭에 있어야");
  assert.equal(tabs.done.length, 0, "완료 탭엔 없어야");
});

test("곡·콘텐츠 작업이 생기면 후반작업 항이 꺼진다(작업 기반 분류가 이어받음)", () => {
  const pid = seedProject("믹스작업생김");
  seedMixSession(pid, { done: true });
  seedTask(pid, { waived: 0, invoiced: 0 }); // 미청구 작업
  const p = projectRow(pid);
  // 후반작업 항은 꺼지지만(작업 존재), 미청구 작업이 unbilled_cnt를 채운다 → 여전히 청구 필요
  assert.ok(p.unbilled_cnt > 0);
  const tabs = splitProjectTabs([p]);
  assert.equal(tabs.billing.length, 1);
});

test("작업을 '청구 안 함'(waive) 하면 완료로 간다", () => {
  const pid = seedProject("믹스무료");
  seedMixSession(pid, { done: true });
  seedTask(pid, { waived: 1, invoiced: 0 }); // 작업 존재(후반작업 항 꺼짐) + waived(작업 항 0)
  const p = projectRow(pid);
  assert.equal(p.unbilled_cnt, 0, "작업 존재로 후반작업 항 꺼짐 + waived로 작업 항 0");
  const tabs = splitProjectTabs([p]);
  assert.equal(tabs.done.length, 1, "완료 탭");
});

test("예정(미래) 믹싱 세션만 있으면 미가산(조기 청구 필요 방지)", () => {
  const pid = seedProject("믹스예정");
  seedMixSession(pid, { date: "2999-01-01", done: false }); // 미래·예정
  const p = projectRow(pid);
  // 다가오는 예정 세션이 있으니 is_completed=false → 진행 중, 후반작업 항 미가산
  assert.equal(p.is_completed, false, "다가오는 세션 있음 → 진행 중");
  const tabs = splitProjectTabs([p]);
  assert.equal(tabs.active.length, 1, "진행 중 탭");
});
```

- [ ] **Step 4: 테스트 실행 → 실패 확인**

Run: `DB_PATH= node --test test/billing-radar.test.js`
Expected: FAIL — "믹싱 세션만 완료…"에서 `unbilled_cnt>0` 단언 실패(아직 항 없음 → 0, 완료 탭으로 감).

- [ ] **Step 5: unbilled_cnt SQL에 후반작업 항 추가**

`src/data/projects.js`의 `unbilled_cnt` 파생(130-137줄). 닫는 `)) AS unbilled_cnt,` 직전에 항을 더한다. 수정 후 전체 블록:

```js
      ((SELECT COUNT(*) FROM track_tasks t JOIN project_tracks tr ON tr.id = t.track_id
         WHERE tr.project_id = p.id AND t.is_invoiced = 0 AND t.waived = 0)
       + (SELECT COUNT(*) FROM sessions s
           WHERE s.project_id = p.id AND s.status <> '취소' AND s.session_type IN (${RENTAL_IN})
             AND (s.all_day = 1 OR (s.start_time IS NOT NULL AND s.end_time IS NOT NULL))
             AND s.waived = 0
             AND NOT EXISTS (SELECT 1 FROM invoice_items ii WHERE ii.session_id = s.id)
             AND NOT EXISTS (SELECT 1 FROM track_tasks tt WHERE tt.session_id = s.id))
       -- 후반작업(믹싱·마스터링)은 곡·콘텐츠 작업으로 청구하는데, 세션만 마치고 작업을 아직 안 만든
       -- 프로젝트는 청구할 게 없어 보여 조용히 '완료'로 넘어간다(2026-07-24). 청구 준비(작업·청구서)가
       -- 하나도 없을 때만 '청구 미착수' 플래그(+1)로 세어 '청구 필요'에 잡는다. 작업/청구서가 생기면
       -- 그쪽 로직이 이어받으므로 자동으로 꺼진다. 예정(미래) 세션은 조기 신호 방지로 제외.
       + (CASE WHEN EXISTS (
           SELECT 1 FROM sessions s2
            WHERE s2.project_id = p.id
              AND s2.session_type IN (${POSTPROD_IN})
              AND s2.status <> '취소' AND s2.waived = 0
              AND (s2.status = '완료' OR s2.session_date < @today)
              AND NOT EXISTS (SELECT 1 FROM track_tasks t3 JOIN project_tracks tr3 ON tr3.id = t3.track_id
                               WHERE tr3.project_id = p.id)
              AND NOT EXISTS (SELECT 1 FROM invoices i3 WHERE i3.project_id = p.id)
         ) THEN 1 ELSE 0 END)) AS unbilled_cnt,
```

- [ ] **Step 6: 테스트 실행 → 통과 확인**

Run: `DB_PATH= node --test test/billing-radar.test.js`
Expected: PASS — 신규 4케이스 + 기존 케이스 전부 통과(대관 로직 회귀 없음).

- [ ] **Step 7: 전체 테스트로 회귀 확인**

Run: `npm test`
Expected: 기존 통과 수 + 4, fail 0.

- [ ] **Step 8: 커밋**

```bash
git add src/config.js src/data/projects.js test/billing-radar.test.js
git commit -m "fix(projects): 믹싱/마스터링 세션만 마친 프로젝트가 완료로 새는 것 방지

세션만 하고 곡·콘텐츠 작업을 안 만들면 unbilled_cnt=0 → 완료로 직행하던 것을,
'청구 미착수'(완료·미waived 후반작업 세션 + 작업·청구서 0) 플래그로 잡아 청구 필요로.
작업/청구서가 생기면 자동 해제. 2026-07-23 대관 세션 버그와 동일 클래스."
```

---

### Task 2: 청구 탭 안내 문구 — 왜 후보가 비었는지

**Files:**
- Modify: `src/data/projects.js` — `hasPostprodSessionNeedingBilling(projectId)` 헬퍼 추가·export.
- Modify: `src/views.projects.js:798-802` — `unbilledInvoiceForm` 4번째 인자·안내 분기.
- Modify: `src/routes/projects.routes.js:447-448` — 헬퍼 호출·플래그 전달·카운트 반영, import 추가.
- Test: `test/billing-radar.test.js` — 헬퍼 정합 + 뷰 계약 케이스.

**Interfaces:**
- Consumes: Task 1의 `POSTPROD_IN`·`unbilled_cnt` 로직, `unbilledInvoiceForm`(기존 시그니처 `(project, taskRows, sessionRows)`).
- Produces: `hasPostprodSessionNeedingBilling(projectId): boolean` — Task 1 unbilled_cnt 후반작업 항과 **동일 조건**. `unbilledInvoiceForm(project, taskRows, sessionRows, opts?)` — `opts.hasPostprodSession` true면 후보 0일 때 안내 문구.

- [ ] **Step 1: 실패하는 테스트 작성(헬퍼 정합 + 뷰 계약)**

`test/billing-radar.test.js` 상단 require에 추가: `hasPostprodSessionNeedingBilling`은 `../src/data`에서, `unbilledInvoiceForm`은 뷰에서.

```js
// 파일 상단 require 블록에 추가
const { hasPostprodSessionNeedingBilling } = require("../src/data");
const { unbilledInvoiceForm } = require("../src/views.projects");
```

Task 1 케이스들 뒤에 추가:

```js
test("hasPostprodSessionNeedingBilling: unbilled_cnt 후반작업 항과 정합", () => {
  const pid = seedProject("헬퍼정합");
  seedMixSession(pid, { done: true });
  assert.equal(hasPostprodSessionNeedingBilling(pid), true, "세션만·작업0·청구서0 → true");
  seedTask(pid, { waived: 0, invoiced: 0 });
  assert.equal(hasPostprodSessionNeedingBilling(pid), false, "작업 생기면 false(청구 준비 시작)");
});

test("unbilledInvoiceForm: 후보 0 + 후반작업 플래그 → 안내 문구 렌더", () => {
  const proj = { id: 1, artist: "허영생" };
  const withFlag = unbilledInvoiceForm(proj, [], [], { hasPostprodSession: true });
  assert.ok(withFlag.includes("곡·콘텐츠 탭에서 작업을 만들어"), "안내 문구 있어야");
  const noFlag = unbilledInvoiceForm(proj, [], [], { hasPostprodSession: false });
  assert.ok(noFlag.includes("청구할 작업·세션이 없습니다"), "플래그 없으면 기존 문구");
  assert.ok(!noFlag.includes("곡·콘텐츠 탭에서 작업을 만들어"), "플래그 없으면 안내 없음");
});
```

- [ ] **Step 2: 테스트 실행 → 실패 확인**

Run: `DB_PATH= node --test test/billing-radar.test.js`
Expected: FAIL — `hasPostprodSessionNeedingBilling`가 export 안 됨(undefined) / `unbilledInvoiceForm`가 4번째 인자 무시해 안내 문구 없음.

- [ ] **Step 3: 헬퍼 추가**

`src/data/projects.js`에 함수 추가(파일 내 다른 export 함수들 근처) 후 `module.exports`에 `hasPostprodSessionNeedingBilling` 추가:

```js
/**
 * 후반작업(믹싱/마스터링) 세션은 마쳤지만 청구 준비(곡·콘텐츠 작업·청구서)가 하나도 없는 상태인가?
 * = listProjects unbilled_cnt의 '청구 미착수' 항과 동일 조건. 청구 탭 안내 문구 노출 판정용.
 */
function hasPostprodSessionNeedingBilling(projectId) {
  const row = db()
    .prepare(
      `SELECT 1 FROM sessions s
        WHERE s.project_id = @pid
          AND s.session_type IN (${POSTPROD_IN})
          AND s.status <> '취소' AND s.waived = 0
          AND (s.status = '완료' OR s.session_date < @today)
          AND NOT EXISTS (SELECT 1 FROM track_tasks t JOIN project_tracks tr ON tr.id = t.track_id
                           WHERE tr.project_id = @pid)
          AND NOT EXISTS (SELECT 1 FROM invoices i WHERE i.project_id = @pid)
        LIMIT 1`
    )
    .get({ pid: projectId, today: todayYmd() });
  return !!row;
}
```

- [ ] **Step 4: `src/data` 자동 재노출 확인(스프레드 — 추가 작업 없음)**

`src/data.js:54`가 `...projects`(spread re-export)라, Step 3에서 `projects.js`의 `module.exports`에 `hasPostprodSessionNeedingBilling`만 추가하면 `require("../src/data")`로 **자동 노출**된다. 색인 파일 편집 불필요.

Run: `node -e "console.log(typeof require('./src/data').hasPostprodSessionNeedingBilling)"`
Expected: `function`

- [ ] **Step 5: unbilledInvoiceForm에 안내 분기 추가**

`src/views.projects.js:798-802`을 수정:

```js
function unbilledInvoiceForm(project, taskRows, sessionRows = [], opts = {}) {
  const tasks = taskRows || [];
  if (!tasks.length && !sessionRows.length) {
    if (opts.hasPostprodSession) {
      return `<div class="rounded-lg border border-border bg-bg px-3 py-4 text-sm text-muted">믹싱/마스터링 세션이 있습니다. <span class="font-medium text-fg">곡·콘텐츠 탭에서 작업을 만들어</span> 청구하세요.<span class="mt-1 block text-xs">무료로 처리할 거면 작업을 만든 뒤 '청구 안 함'을 누르세요.</span></div>`;
    }
    return `<div class="rounded-lg border border-border bg-bg px-3 py-4 text-center text-sm text-muted">청구할 작업·세션이 없습니다.</div>`;
  }
```

(이후 함수 본문은 변경 없음.)

- [ ] **Step 6: 라우트에서 플래그 전달**

`src/routes/projects.routes.js`의 import에 `hasPostprodSessionNeedingBilling` 추가(기존 `unbilledInvoiceForm` import 블록·`../data`에서 오는 함수 목록에 맞춰). 그리고 447-448줄을 수정:

```js
    const needsPostprodBilling = hasPostprodSessionNeedingBilling(p.id);
    const unbilledForm = (unbilledRows.length || sessionRows.length || needsPostprodBilling)
      ? unbilledInvoiceForm(p, unbilledRows, sessionRows, { hasPostprodSession: needsPostprodBilling })
      : "";
    tabContent = invoicesSection({ project: p, rows: invoiceRows, isAdmin: showInvoice, collapsed: false, unbilledForm, unbilledCount: unbilledRows.length + sessionRows.length + (needsPostprodBilling ? 1 : 0), openId: Number(req.query.open) || null });
```

- [ ] **Step 7: 테스트 실행 → 통과 확인**

Run: `DB_PATH= node --test test/billing-radar.test.js`
Expected: PASS — 헬퍼 정합·뷰 계약 통과.

- [ ] **Step 8: 스모크로 라우트 회귀 확인**

Run: `npm test`
Expected: fail 0. (스모크가 `/projects/:id?tab=invoice` 렌더를 태우므로 라우트 배선 오류가 있으면 여기서 잡힌다.)

- [ ] **Step 9: 커밋**

```bash
git add src/data/projects.js src/views.projects.js src/routes/projects.routes.js test/billing-radar.test.js
git commit -m "feat(projects): 청구 탭 안내 — 믹싱/마스터링 세션은 곡·콘텐츠 작업으로 청구

세션만 마쳐 청구 후보가 빈 프로젝트의 청구 탭에 '곡·콘텐츠 탭에서 작업을 만들어
청구하세요' 안내. hasPostprodSessionNeedingBilling 헬퍼는 unbilled_cnt 후반작업 항과
동일 조건(정합 테스트로 잠금)."
```

---

## Self-Review

**Spec coverage:**
- 핵심 로직(unbilled_cnt 후반작업 항) → Task 1 ✅
- 동작(작업/청구서 생기면 자동 해제) → Task 1 Step 3 케이스 2·3 ✅
- 예정 세션 제외 → Task 1 Step 3 케이스 4 ✅
- UI 안내 → Task 2 ✅
- 범위 경계(is_completed·대관·후보목록 불변) → 대관 회귀는 기존 billing-radar 케이스가 커버(Task 1 Step 7), is_completed·후보목록 SQL은 미변경 ✅
- 회귀 6케이스 → Task 1의 4 + Task 2의 2 = 6 ✅

**Placeholder scan:** 모든 스텝에 실제 코드·명령·기대 출력. 플레이스홀더 없음 ✅

**Type consistency:** `hasPostprodSessionNeedingBilling`(Task 2 정의·Task 2 사용)·`POSTPROD_SESSION_TYPES`/`POSTPROD_IN`(Task 1 정의·Task 1·2 사용)·`unbilledInvoiceForm` 4번째 인자 `opts.hasPostprodSession`(Task 2 정의·라우트 사용) 일치 ✅

**주의(구현자용):** Task 2 Step 4·6은 실제 파일의 export/​import 방식을 먼저 확인하고 맞춘다(색인 파일이 명시 나열이면 이름 추가, spread면 자동). `src/data.js` vs `src/data/index.js` 경로는 grep으로 확인.
