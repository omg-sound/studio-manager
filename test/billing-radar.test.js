"use strict";

// ── 격리 DB 셋업: src/* require 이전에 환경변수부터 설정 ──
process.env.NODE_ENV = "test";
const { tempDbPath, cleanupDb } = require("./helpers");
process.env.DB_PATH = tempDbPath();

const test = require("node:test");
const assert = require("node:assert");

const { db, init } = require("../src/db");
const { createSession, setSessionStatus, setSessionWaived, listProjects, listBillableSessionsForProject, splitProjectTabs } = require("../src/data");

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

  assert.strictEqual(listBillableSessionsForProject(CHIEF, pid).rows.length, 0);
  assert.strictEqual(Number(projectRow(pid).unbilled_cnt), 0);
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
