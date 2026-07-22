"use strict";

// ── 격리 DB 셋업: src/* require 이전에 환경변수부터 설정(실 data/app.db 오염 방지) ──
process.env.NODE_ENV = "test";
const { tempDbPath, cleanupDb } = require("./helpers");
process.env.DB_PATH = tempDbPath();

const test = require("node:test");
const assert = require("node:assert");

const { db, init } = require("../src/db");
const {
  createTask,
  deleteTask,
  deleteTrack,
  deleteProject,
  createSession,
  updateSession,
  deleteSession,
  setTaskPayout,
  setSessionEngineerPayout,
  listSessionEngineers,
} = require("../src/data");

init();

const CHIEF = { id: 1, role: "chief", email: "chief@omg.test" };

/**
 * 지급 잠금(PAYOUT_LOCKED) 회귀 — 2026-07-23 기능성 평가에서 확인된 결함.
 *
 * 청구 축(is_invoiced)에는 촘촘한 잠금이 있는데 **지급 축(worker_paid)에는 없어서**,
 * 이미 외주에게 이체한 돈의 기록을 삭제로 소급 소멸시킬 수 있었다.
 * 정산 CSV·지급월 이력이 라이브 행 파생이라 원천세 신고 근거가 함께 사라진다.
 * 정책(사용자 결정): **차단** — 지우려면 먼저 지급을 취소해야 한다.
 */

function seedWorker(name) {
  // user_id NULL = 외주 작업자(하우스 엔지니어는 지급단가 개념이 없다)
  const r = db().prepare("INSERT INTO project_managers (name, active) VALUES (?, 1)").run(name);
  return Number(r.lastInsertRowid);
}

function seedProject(title) {
  const r = db().prepare("INSERT INTO projects (title, project_type, rate) VALUES (?, 'session', 0)").run(title);
  return Number(r.lastInsertRowid);
}

function seedTrack(projectId) {
  const r = db().prepare("INSERT INTO project_tracks (project_id, title, content_type) VALUES (?, '곡', 'Music')").run(projectId);
  return Number(r.lastInsertRowid);
}

/** 외주 담당·지급단가가 붙은 작업 1건. */
function seedPaidTask(trackId, workerId, { paid = true } = {}) {
  const task = createTask(CHIEF, trackId, { task_type: "Mixing", engineer_id: String(workerId), worker_rate: "300000" });
  if (paid) setTaskPayout(task.id, true, "2026-07-01");
  return task;
}

/** 외주 엔지니어가 배정된 세션 1건. */
function seedSession(projectId, workerId, { paid = true, date = "2026-07-10" } = {}) {
  const s = createSession(CHIEF, projectId, {
    session_date: date,
    start_time: "14:00",
    custom_hours: "2",
    duration_mode: "custom",
    session_type: "믹싱",
    engineer_ids: [String(workerId)],
    engineer_rates: ["200000"],
  });
  if (paid) setSessionEngineerPayout(s.id, workerId, true, "2026-07-01");
  return s;
}

test.after(() => cleanupDb(process.env.DB_PATH, db()));

// ── 작업 ──

test("deleteTask: 지급 완료된 작업은 PAYOUT_LOCKED로 거부, 지급 취소 후엔 삭제된다", () => {
  const projectId = seedProject("지급잠금-작업");
  const trackId = seedTrack(projectId);
  const workerId = seedWorker("외주작업자A");
  const task = seedPaidTask(trackId, workerId);

  assert.throws(() => deleteTask(CHIEF, task.id), /PAYOUT_LOCKED/, "이미 이체한 작업은 삭제 불가");
  assert.ok(db().prepare("SELECT 1 FROM track_tasks WHERE id = ?").get(task.id), "행이 남아 있어야 한다");

  setTaskPayout(task.id, false); // 지급 취소가 유일한 해제 경로
  assert.ok(deleteTask(CHIEF, task.id), "지급 취소 후엔 삭제 가능");
  assert.ok(!db().prepare("SELECT 1 FROM track_tasks WHERE id = ?").get(task.id));
});

test("deleteTask: 미지급 작업은 그대로 삭제된다(과잉 차단 아님)", () => {
  const projectId = seedProject("지급잠금-미지급작업");
  const trackId = seedTrack(projectId);
  const workerId = seedWorker("외주작업자B");
  const task = seedPaidTask(trackId, workerId, { paid: false });

  assert.ok(deleteTask(CHIEF, task.id), "지급 이력이 없으면 기존대로 삭제");
});

test("deleteTrack: 하위 작업에 지급 완료가 있으면 PAYOUT_LOCKED (작업 CASCADE 우회 차단)", () => {
  const projectId = seedProject("지급잠금-트랙");
  const trackId = seedTrack(projectId);
  const workerId = seedWorker("외주작업자C");
  seedPaidTask(trackId, workerId);

  assert.throws(() => deleteTrack(CHIEF, trackId), /PAYOUT_LOCKED/, "트랙을 지워 작업을 CASCADE로 없애는 우회 경로 차단");
});

// ── 세션 ──

test("deleteSession: 배정 엔지니어가 지급 완료면 PAYOUT_LOCKED (session_engineers CASCADE 우회 차단)", () => {
  const projectId = seedProject("지급잠금-세션");
  const workerId = seedWorker("외주엔지니어A");
  const s = seedSession(projectId, workerId);

  assert.throws(() => deleteSession(CHIEF, s.id), /PAYOUT_LOCKED/);
  assert.ok(db().prepare("SELECT 1 FROM session_engineers WHERE session_id = ?").get(s.id), "지급 이력 행이 남아야 한다");

  setSessionEngineerPayout(s.id, workerId, false);
  assert.ok(deleteSession(CHIEF, s.id), "지급 취소 후엔 삭제 가능");
});

test("updateSession: 지급 완료된 엔지니어를 배정에서 빼면 PAYOUT_LOCKED", () => {
  const projectId = seedProject("지급잠금-세션편집");
  const workerId = seedWorker("외주엔지니어B");
  const other = seedWorker("외주엔지니어C");
  const s = seedSession(projectId, workerId);

  // 지급완료 엔지니어를 다른 사람으로 교체 = 그 지급 이력 행이 DELETE된다(돈은 나갔는데 기록 소멸)
  assert.throws(
    () => updateSession(CHIEF, s.id, {
      session_date: "2026-07-10", start_time: "14:00", custom_hours: "2", duration_mode: "custom", session_type: "믹싱",
      engineer_ids: [String(other)], engineer_rates: ["100000"],
    }),
    /PAYOUT_LOCKED/
  );
  const engs = listSessionEngineers(s.id);
  assert.strictEqual(engs.length, 1, "배정이 그대로여야 한다");
  assert.strictEqual(engs[0].worker_paid, 1, "지급 상태 보존");
});

test("updateSession: 지급 완료 엔지니어를 유지한 채 시간만 바꾸는 건 허용(정상 편집 회귀)", () => {
  const projectId = seedProject("지급잠금-세션시간변경");
  const workerId = seedWorker("외주엔지니어D");
  const s = seedSession(projectId, workerId, { date: "2026-07-11" });

  const saved = updateSession(CHIEF, s.id, {
    session_date: "2026-07-11", start_time: "16:00", custom_hours: "3", duration_mode: "custom", session_type: "믹싱",
    engineer_ids: [String(workerId)], engineer_rates: ["200000"],
  });
  assert.strictEqual(saved.start_time, "16:00", "지급 이력이 있어도 세션 편집 자체는 막지 않는다");
  assert.strictEqual(listSessionEngineers(s.id)[0].worker_paid, 1, "지급 상태 보존");
});

// ── 프로젝트 ──

test("deleteProject: 하위에 지급 완료 작업·세션이 있으면 PAYOUT_LOCKED", () => {
  const projectId = seedProject("지급잠금-프로젝트");
  const trackId = seedTrack(projectId);
  const workerId = seedWorker("외주작업자D");
  seedPaidTask(trackId, workerId);

  assert.throws(() => deleteProject(projectId), /PAYOUT_LOCKED/, "프로젝트 삭제로 지급 이력을 통째로 없애는 경로 차단");

  const sProjectId = seedProject("지급잠금-프로젝트세션");
  const w2 = seedWorker("외주엔지니어E");
  seedSession(sProjectId, w2, { date: "2026-07-12" });
  assert.throws(() => deleteProject(sProjectId), /PAYOUT_LOCKED/, "세션 지급 이력도 동일하게 보호");
});
