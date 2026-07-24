"use strict";

// ── 격리 DB 셋업: src/* require 이전에 환경변수부터 설정 ──
process.env.NODE_ENV = "test";
const { tempDbPath, cleanupDb } = require("./helpers");
process.env.DB_PATH = tempDbPath();

const test = require("node:test");
const assert = require("node:assert");

const { db, init } = require("../src/db");
const { createSession, setSessionStatus, setSessionWaived, listProjects, listBillableSessionsForProject, splitProjectTabs, hasPostprodSessionNeedingBilling } = require("../src/data");

init();

/**
 * '청구 빠뜨림 방지 엔진'이 실제로 청구를 빠뜨리던 두 경로 — 2026-07-23 기능성 평가.
 *
 * ① **단가 항목 미선택 완료 대관 세션**이 청구 후보와 미청구 집계 **양쪽에서 동시에** 사라져,
 *    프로젝트가 조용히 '완료' 탭으로 넘어갔다(매출이 소리 없이 빠짐).
 *    → 후보 목록에 **흐리게** 남기고(billing=null) 미청구 집계에도 넣는다. 탈출구는 '청구 안 함'(waived).
 * ② **진행 중 프로젝트의 미청구 완료 세션**은 다가오는 세션이 1건만 있어도 '청구 필요'에서 통째로 빠졌다
 *    (`is_completed`가 `upcoming_cnt===0`을 요구) → 장기 앨범일수록 청구가 늦어졌다.
 *    → 탭 3분류(상호배타)는 그대로 두고, `unbilled_cnt`를 **완료 여부와 무관하게** 신호로 쓴다(배지·대시보드).
 */

const CHIEF = { id: 1, role: "chief", email: "chief@omg.test" };

const roomA = Number(db().prepare("INSERT INTO rooms (name, active) VALUES ('A룸',1)").run().lastInsertRowid);
const rateItem = Number(
  db().prepare("INSERT INTO rate_items (name, category, base_minutes, base_price, extra_minutes, extra_price, active) VALUES ('보컬녹음','스튜디오 녹음',210,300000,60,100000,1)").run().lastInsertRowid
);

let seq = 0;
function seedProject(title) {
  seq += 1;
  return Number(db().prepare("INSERT INTO projects (title, project_type, rate) VALUES (?, 'session', 0)").run(`${title}${seq}`).lastInsertRowid);
}

/** 대관 세션 1건(rateItemId 생략 = 단가 항목 미선택). */
function seedSession(projectId, { date, rateItemId = null, done = true }) {
  const s = createSession(CHIEF, projectId, {
    session_type: "녹음",
    session_date: date,
    start_time: "14:00",
    end_time: "18:00",
    room_id: roomA,
    ...(rateItemId ? { rate_item_id: String(rateItemId) } : {}),
  });
  if (done) setSessionStatus(CHIEF, s.id, "완료");
  return s;
}

const projectRow = (id) => listProjects(CHIEF, {}).find((p) => p.id === id);

test.after(() => cleanupDb(process.env.DB_PATH, db()));

// ── ① 단가 항목 미선택 세션 ──

test("단가 미선택 완료 대관 세션이 청구 후보에 남는다(흐리게 — billing=null)", () => {
  const pid = seedProject("단가미선택");
  const s = seedSession(pid, { date: "2026-11-03" });

  const { rows } = listBillableSessionsForProject(CHIEF, pid);
  assert.strictEqual(rows.length, 1, "후보 목록에서 사라지면 사용자가 이유를 알 길이 없다");
  assert.strictEqual(rows[0].id, s.id);
  assert.strictEqual(rows[0].billing, null, "산정 불가 = billing null(청구 폼이 흐린 행으로 렌더)");
});

test("단가 미선택 완료 대관 세션이 미청구 집계에 잡힌다 — 프로젝트가 '완료'로 새지 않는다", () => {
  const pid = seedProject("단가미선택집계");
  seedSession(pid, { date: "2026-11-08" });

  const p = projectRow(pid);
  assert.strictEqual(Number(p.unbilled_cnt), 1, "미청구 집계에서 빠지면 프로젝트가 조용히 완료 탭으로 간다");
  assert.strictEqual(p.is_completed, true, "다가오는 세션·미완료 작업 없음 = 완료 상태 자체는 맞다");
  const { billing } = splitProjectTabs([p]);
  assert.strictEqual(billing.length, 1, "'청구 필요' 탭에 남아야 한다");
});

test("'청구 안 함'(무료 처리)이 탈출구 — 미청구 집계에서 빠진다", () => {
  const pid = seedProject("단가미선택무료");
  const s = seedSession(pid, { date: "2026-11-13" });
  assert.strictEqual(Number(projectRow(pid).unbilled_cnt), 1);

  setSessionWaived(CHIEF, s.id);
  assert.strictEqual(Number(projectRow(pid).unbilled_cnt), 0, "무료 처리하면 더 이상 '필요'하지 않다");
  const { rows } = listBillableSessionsForProject(CHIEF, pid);
  assert.strictEqual(rows.length, 1, "되돌릴 수 있게 폼에는 계속 노출(waived 배지)");
  assert.strictEqual(rows[0].waived, 1);
});

test("단가가 있는 세션은 종전대로 산정액이 붙는다(회귀)", () => {
  const pid = seedProject("단가있음");
  seedSession(pid, { date: "2026-11-18", rateItemId: rateItem });

  const { rows } = listBillableSessionsForProject(CHIEF, pid);
  assert.strictEqual(rows.length, 1);
  assert.ok(rows[0].billing, "단가 항목이 있으면 billing 산정");
  assert.strictEqual(rows[0].billing.amount, 400000, "240분 = 1Pro(210분) 30만 + 자투리 30분(60분 단위 올림) 10만");
});

test("비대관 세션(믹싱)은 여전히 청구 후보가 아니다 — 후반작업은 곡·콘텐츠로 청구(회귀)", () => {
  const pid = seedProject("믹싱세션");
  const s = createSession(CHIEF, pid, { session_type: "믹싱", session_date: "2026-11-23", start_time: "14:00", end_time: "18:00", room_id: roomA });
  setSessionStatus(CHIEF, s.id, "완료");

  assert.strictEqual(listBillableSessionsForProject(CHIEF, pid).rows.length, 0, "믹싱은 여전히 청구 후보 목록 대상이 아니다(곡·콘텐츠로 청구)");
  // 완료된 믹싱 세션 + 작업 0 + 청구서 0 = '청구 미착수'(2026-07-24 신설) → unbilled_cnt=1로 잡혀야
  // 조용히 '완료' 탭으로 새지 않는다(아래 ③ 후반작업 청구 레이더 케이스와 동일 시나리오).
  assert.strictEqual(Number(projectRow(pid).unbilled_cnt), 1);
});

// ── ② 진행 중 프로젝트의 미청구 완료 세션 ──

test("다가오는 세션이 있어도 완료 세션의 미청구는 unbilled_cnt에 잡힌다", () => {
  const pid = seedProject("장기앨범");
  seedSession(pid, { date: "2026-11-28", rateItemId: rateItem }); // 완료·미청구
  createSession(CHIEF, pid, { session_type: "녹음", session_date: "2099-12-31", start_time: "14:00", end_time: "18:00", room_id: roomA, rate_item_id: String(rateItem) }); // 다가오는 예정

  const p = projectRow(pid);
  assert.strictEqual(p.is_completed, false, "다가오는 세션이 있으니 프로젝트는 진행 중");
  assert.ok(Number(p.unbilled_cnt) >= 1, "그래도 청구할 게 있다는 신호는 살아 있어야 한다(배지·대시보드가 이걸 쓴다)");

  // 탭 3분류는 상호배타 유지 — 진행 중에 남고 청구 필요 탭엔 안 뜬다(사용자 결정).
  const { active, billing, done } = splitProjectTabs([p]);
  assert.strictEqual(active.length, 1, "진행 중 탭에 남는다");
  assert.strictEqual(billing.length, 0, "탭 정의는 바꾸지 않는다");
  assert.strictEqual(done.length, 0);
});

// ── 뷰 계약 ──
const { projectListRow, unbilledInvoiceForm } = require("../src/views.projects");

const listRow = (over) => projectListRow(
  { id: 1, title: "장기앨범", artist: "루나", client_name: "뮤직팜", manager_name: "김엔지니어", created_at: "2026-07-01 10:00:00", task_total: 0, session_amount_total: 0, ...over },
  { sessions: [], tracks: [], taskTypes: [] },
  { tab: over && over.__tab ? over.__tab : "active" }
);

test("projectListRow: 진행 중 탭에서도 '청구 필요 N' 배지가 뜬다", () => {
  assert.match(listRow({ unbilled_cnt: 3 }), /청구 필요 3/, "진행 중 프로젝트의 미청구가 목록에서 보여야 한다");
  assert.doesNotMatch(listRow({ unbilled_cnt: 0 }), /청구 필요/, "미청구 0이면 배지 없음");
});

test("unbilledInvoiceForm: 단가 미선택 세션은 체크박스 없이 사유 + '청구 안 함'만", () => {
  const project = { id: 7, artist: "루나" };
  const s = { id: 42, session_date: "2026-11-03", session_type: "녹음", status: "완료", waived: 0, billing: null };
  const html = unbilledInvoiceForm(project, [], [s]);

  assert.match(html, /단가 항목을 선택해야 청구할 수 있습니다/, "왜 청구가 안 되는지 그 자리에서 알려준다");
  assert.doesNotMatch(html, /name="session_id" value="42"/, "체크박스가 없어야 실수로 발행되지 않는다");
  assert.doesNotMatch(html, /session_amount_42/, "금액칸도 없다");
  assert.match(html, /\/sessions\/42\/waive/, "'청구 안 함' 탈출구는 남긴다");
});

test("unbilledInvoiceForm: 단가가 있는 세션은 종전대로 체크박스·금액칸(회귀)", () => {
  const project = { id: 7, artist: "루나" };
  const s = {
    id: 43, session_date: "2026-11-03", session_type: "녹음", status: "완료", waived: 0,
    start_time: "14:00", end_time: "18:00",
    billing: { item: { name: "보컬녹음" }, minutes: 240, amount: 400000, fixed: false },
  };
  const html = unbilledInvoiceForm(project, [], [s]);
  assert.match(html, /name="session_id" value="43"/);
  assert.match(html, /session_amount_43/);
  assert.match(html, /보컬녹음/);
});

// ── 모바일 레이아웃 계약(2026-07-23 사용자 리포트 — 실측 후 수정) ──
// 한 줄 flex에 [체크박스·라벨·'청구 안 함'·금액칸 112px]를 다 넣으면 390px에서 라벨에 42px만 남고,
// 한글은 음절 단위로 줄바꿈돼 행 높이가 221px로 부풀었다(실측). 구조가 되돌아가면 같은 증상이 재발한다.
// ⚠️ jsdom엔 레이아웃이 없어 폭은 못 잰다 — 여기선 **마크업 계약**만 잠그고, 실제 폭은 브라우저 실측으로 확인했다.
test("청구 항목 행: 컨트롤을 한 덩어리로 묶어 모바일에서 둘째 줄로 내린다(라벨 짜부라짐 방지)", () => {
  const project = { id: 7, artist: "루나" };
  const s = {
    id: 43, session_date: "2026-11-03", session_type: "녹음", status: "완료", waived: 0,
    start_time: "14:00", end_time: "18:00",
    billing: { item: { name: "보컬녹음" }, minutes: 240, amount: 400000, fixed: false },
  };
  const html = unbilledInvoiceForm(project, [], [s]);

  assert.match(html, /flex flex-wrap items-start[^"]*/, "행이 래핑 가능해야 컨트롤이 둘째 줄로 내려간다");
  assert.match(html, /class="flex w-full items-center justify-between gap-2 sm:w-auto/, "'청구 안 함'+금액칸이 한 컨테이너(모바일 전폭·sm+ 인라인)");
  assert.match(html, /min-w-0 flex-1 break-keep/, "라벨 break-keep — 한글이 음절 단위로 쪼개지지 않게(공백에서만 줄바꿈)");
  // 금액칸이 라벨과 같은 flex 레벨에 직접 놓이면 다시 라벨을 짜부라뜨린다
  assert.doesNotMatch(html, /break-keep[^>]*>[\s\S]{0,400}?<button[^>]*data-waive-btn[\s\S]{0,80}?<div class="relative w-28 shrink-0">(?![\s\S]*<\/div>\s*<\/div>)/, "금액칸은 컨트롤 컨테이너 안에");
});

test("하단 액션: 넘칠 때만 접히고 라벨은 안 쪼개진다", () => {
  const html = unbilledInvoiceForm({ id: 7, artist: "루나" }, [], [{ id: 1, session_date: "2026-11-03", session_type: "녹음", status: "완료", waived: 0, billing: null }]);
  assert.match(html, /flex flex-wrap items-center justify-end gap-2">\s*<button class="btn-ghost btn-sm whitespace-nowrap"/, "임시저장이 '임시저\\n장'으로 깨지지 않게 nowrap");
  assert.match(html, /data-invoice-submit>청구 생성 /, "라벨을 줄여 390px 한 줄에 들어간다");
  assert.match(html, /grid grid-cols-3 gap-2/, "문서 발행 3버튼은 모바일에서도 3열(전폭 3스택은 148px를 먹었다)");
});

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
  seedMixSession(pid, { date: "2026-07-05", done: true }); // roomA 시간 겹침 방지 — 다른 날짜
  seedTask(pid, { waived: 0, invoiced: 0 }); // 미청구 작업
  const p = projectRow(pid);
  // 후반작업 항은 꺼지지만(작업 존재), 미청구 작업이 unbilled_cnt를 채운다 → 여전히 청구 필요
  assert.ok(p.unbilled_cnt > 0);
  const tabs = splitProjectTabs([p]);
  assert.equal(tabs.billing.length, 1);
});

test("작업을 '청구 안 함'(waive) 하면 완료로 간다", () => {
  const pid = seedProject("믹스무료");
  seedMixSession(pid, { date: "2026-07-10", done: true }); // roomA 시간 겹침 방지 — 다른 날짜
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

// ── ④ 청구 탭 안내 문구 (2026-07-25) ──

test("hasPostprodSessionNeedingBilling: unbilled_cnt 후반작업 항과 정합", () => {
  const pid = seedProject("헬퍼정합");
  seedMixSession(pid, { date: "2026-07-15", done: true }); // roomA 시간 겹침 방지 — 다른 날짜
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
