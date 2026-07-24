# 세션 완료 판정 버튼 기준 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 완료 안 누른 세션(예정)이 하나라도 있으면 프로젝트가 '진행 중'에 머물게 한다(작업의 `open_tasks`와 대칭). 지난 예정 세션이 날짜만 지나면 '완료/청구필요'로 새던 것을 교정.

**Architecture:** `listProjects`의 `is_completed` 게이트를 `upcoming_cnt`(미래 예정만) → `sess_scheduled`(예정 전부·이미 존재하는 파생 카운트)로 바꾼다. 지난 예정 세션이 이제 진행 중에 머무므로, 2026-07-24 postprod 항·헬퍼의 날짜 게이트(`session_date < today`)를 제거해 `status='완료'`일 때만 트리거하게 단순화(완료도 안 누른 세션에 청구 배지가 뜨는 모순 제거).

**Tech Stack:** Node(CommonJS), SQLite, `node:test`.

## Global Constraints

- 파생 분류 변경(마이그레이션 없음). `is_completed`·`unbilled_cnt`는 `src/data/projects.js` `listProjects`가 매 조회 시 계산.
- `upcoming_cnt`·`next_session_date`(진행 중 정렬·다음 세션 표시)·대시보드 '오늘·이번 주 세션'·대관 세션 청구 흐름은 **변경 금지**. 바꾸는 건 `is_completed` 게이트와 postprod 항/헬퍼의 날짜 게이트뿐.
- 세션 상태는 예정/완료/취소. "완료 안 누름" = `status='예정'`. `sess_scheduled`는 이미 `COUNT(status='예정')`(날짜 무관)로 정의돼 있음(`src/data/projects.js:113`).
- 테스트는 격리 temp DB. 세션 충돌(같은 룸·같은 날짜·겹치는 시간) 회피 위해 **테스트마다 고유 날짜** 사용.
- 설계 문서: `docs/superpowers/specs/2026-07-25-session-completion-button-based-design.md`.

---

### Task 1: is_completed 게이트 + postprod 단순화

**Files:**
- Modify: `src/data/projects.js` — `is_completed` 파생(현재 :173 부근, `upcoming_cnt`→`sess_scheduled`) · postprod `unbilled_cnt` 항 날짜 게이트(:148) · `hasPostprodSessionNeedingBilling` 날짜 게이트(:384).
- Test: `test/billing-radar.test.js` — 케이스 추가.

**Interfaces:**
- Consumes: 기존 파생 카운트 `sess_scheduled`(`COUNT sessions status='예정'`), `content_cnt`, `open_tasks`. 테스트 헬퍼 `seedProject`, `projectRow`, `CHIEF`, `roomA`, `seedMixSession(pid,{date,done})`, `seedTask(pid,{waived,invoiced})`, `createSession`, `setSessionStatus`, `splitProjectTabs`(모두 이미 import/정의).
- Produces: 동작 변경 — 예정 세션(미래·지난 무관)이 있으면 `is_completed=false`. postprod 항/헬퍼는 `status='완료'` 세션만 반응.

- [ ] **Step 1: 실패하는 테스트 작성**

`test/billing-radar.test.js` 맨 아래(`test.after` 위, 기존 케이스 뒤)에 추가. 파일 상단 헬퍼(`seedProject`·`projectRow`·`seedMixSession`·`splitProjectTabs`·`setSessionStatus`·`db`)를 재사용. 각 테스트 고유 날짜 사용(충돌 회피):

```js
// ── ④ 세션 완료 판정 버튼 기준 (2026-07-25) ──

test("지난 예정 세션(완료 안 누름)은 진행 중에 머문다(전엔 완료/청구필요로 샜음)", () => {
  const pid = seedProject("버튼기준지난예정");
  seedMixSession(pid, { date: "2020-03-01", done: false }); // 지난 날짜·예정(완료 안 누름)
  const p = projectRow(pid);
  assert.equal(p.is_completed, false, "예정 세션 있으면 완료 아님(sess_scheduled>0)");
  assert.equal(Number(p.unbilled_cnt), 0, "완료 안 눌렀으니 청구 배지도 안 뜸(postprod status='완료'만)");
  const tabs = splitProjectTabs([p]);
  assert.equal(tabs.active.length, 1, "진행 중 탭");
  assert.equal(tabs.done.length, 0);
  assert.equal(tabs.billing.length, 0);
});

test("지난 예정 세션을 완료 처리하면 청구 필요로 간다(믹싱·작업0)", () => {
  const pid = seedProject("버튼기준완료전이");
  const s = seedMixSession(pid, { date: "2020-04-01", done: false });
  setSessionStatus(CHIEF, s.id, "완료"); // 명시적 완료
  const p = projectRow(pid);
  assert.equal(p.is_completed, true, "예정 세션 0(전부 완료) → 완료 판정 가능");
  assert.ok(Number(p.unbilled_cnt) > 0, "완료 믹싱 세션+작업0 → 후반작업 항 가산");
  assert.equal(splitProjectTabs([p]).billing.length, 1, "청구 필요 탭");
});

test("취소 세션은 완료 판정을 막지 않는다", () => {
  const pid = seedProject("버튼기준취소");
  const s = seedMixSession(pid, { date: "2020-05-01", done: false });
  db().prepare("UPDATE sessions SET status='취소' WHERE id=?").run(s.id); // 취소 처리
  const p = projectRow(pid);
  assert.equal(p.is_completed, true, "취소는 예정이 아니라 진행을 막지 않음(작업도 없으니 완료 판정)");
});
```

- [ ] **Step 2: 테스트 실행 → 실패 확인**

Run: `DB_PATH= node --test test/billing-radar.test.js`
Expected: FAIL — "지난 예정 세션…"에서 현재 코드는 `is_completed=true`(upcoming_cnt=0·지난 세션 미포함)·`unbilled_cnt=1`(postprod 날짜 게이트로 지난 세션 가산)이라 단언(false/0/active) 실패. RED가 세 단언 모두에서 나야 정상.

- [ ] **Step 3: is_completed 게이트 변경**

`src/data/projects.js`의 `is_completed` 파생(현재 :173 부근):

```js
    // 완료 = 실제 활동이 있었고(content_cnt>0) 예정 세션 없음(전부 완료/취소) + 미완료 작업 없음.
    // ⚠️ 세션도 작업(open_tasks)과 대칭 — 완료 안 누른 예정 세션이 있으면(미래든 지난이든) 진행 중(2026-07-25).
    //    이전엔 upcoming_cnt(미래 예정만)라 지난 예정 세션이 날짜만 지나면 완료/청구필요로 샜다.
    is_completed: r.content_cnt > 0 && r.sess_scheduled === 0 && r.open_tasks === 0,
```

- [ ] **Step 4: postprod `unbilled_cnt` 항 날짜 게이트 제거**

`src/data/projects.js`의 postprod 항(현재 :148): `AND (s2.status = '완료' OR s2.session_date < @today)` 을 아래로 교체:

```sql
              AND s2.status = '완료'
```

(믹싱 세션은 명시적 '완료'일 때만 청구 미착수 신호 — 지난 예정 세션은 이제 진행 중에 머물어 이 항이 필요 없고, 완료도 안 누른 세션에 청구 배지가 뜨는 모순도 제거. 위 주석의 "지난 예정 세션은 조기 신호 방지로 제외" 문구는 "명시적 완료 세션만 — 예정 세션은 진행 중에 머묾"으로 갱신.)

- [ ] **Step 5: 헬퍼 날짜 게이트 제거**

`src/data/projects.js`의 `hasPostprodSessionNeedingBilling`(현재 :384): `AND (s.status = '완료' OR s.session_date < @today)` 을 아래로 교체(항과 정합 유지):

```sql
          AND s.status = '완료'
```

- [ ] **Step 6: 테스트 실행 → 통과 확인**

Run: `DB_PATH= node --test test/billing-radar.test.js`
Expected: PASS — 신규 3케이스 + 기존 케이스 전부. ⚠️기존 2026-07-24 postprod 케이스 중 '예정 미래' 케이스(`is_completed=false`·`unbilled_cnt=0`)는 이제 `sess_scheduled` 기준으로도 동일 결과라 통과해야 함. 만약 기존 케이스가 '지난 예정 세션이 청구 필요' 전제를 썼다면(그런 케이스는 없어야 정상 — 2026-07-24 테스트는 `done:true`=완료를 썼음) 실패 시 보고할 것(BLOCKED, 계획 재검토).

- [ ] **Step 7: 전체 스위트 회귀 확인**

Run: `npm test`
Expected: fail 0. (`project-list.test.js` 등 다른 목록 테스트가 is_completed 변경에 걸리면 실패가 뜬다 — 그 경우 실패 내용을 보고할 것.)

- [ ] **Step 8: 커밋**

```bash
git add src/data/projects.js test/billing-radar.test.js
git commit -m "fix(projects): 세션 완료 판정을 버튼 기준으로 — 작업(open_tasks)과 대칭

is_completed 게이트를 upcoming_cnt(미래 예정만)→sess_scheduled(예정 전부)로.
완료 안 누른 세션이 있으면 진행 중에 머문다(지난 예정 세션이 날짜만 지나면
완료/청구필요로 새던 것 교정). postprod 항·헬퍼 날짜 게이트 제거(status='완료'만) —
완료도 안 누른 세션에 청구 배지가 뜨는 모순 제거. 파생 분류라 마이그레이션 없음."
```

---

## Controller notes (구현 태스크 밖)

- **CLAUDE.md 현행화**는 컨트롤러가 태스크 리뷰 통과 후 처리(직전 기능과 동일 패턴). 갱신 지점: ①"**완료 판정** `is_completed` … `upcoming_cnt=0`" 서술 → `sess_scheduled=0`(예정 세션 전부·작업과 대칭)으로. ②2026-07-24에 추가한 postprod 노트의 날짜 게이트 문구("예정(미래) 세션은 제외 … 날짜 게이트") → "명시적 완료 세션만(예정 세션은 진행 중에 머묾)"으로.

## Self-Review

**Spec coverage:**
- is_completed 게이트(upcoming_cnt→sess_scheduled) → Step 3 ✅
- postprod 항·헬퍼 날짜 게이트 제거 → Step 4·5 ✅
- 회귀(지난 예정→진행 중 / 완료→청구필요 / 미래 예정 회귀 / postprod 완료만 / 취소 안 막음) → Step 1 케이스 3 + 기존 케이스(미래 예정) + Step 6·7 회귀 ✅
- 범위 경계(upcoming_cnt·next_session_date·대시보드·대관 불변) → 미변경(코드 안 건드림), Step 7 전체 회귀로 확인 ✅
- CLAUDE.md → Controller notes ✅

**Placeholder scan:** 실제 코드·명령·기대 출력 존재. 플레이스홀더 없음 ✅

**Type consistency:** `sess_scheduled`(기존 파생·Step3 소비)·postprod 항과 헬퍼 술어 동일(Step4·5 둘 다 `status='완료'`만) ✅
