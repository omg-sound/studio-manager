"use strict";

// ── 격리 DB 셋업(다른 테스트와 동일 패턴) ──
process.env.NODE_ENV = "test";
const { tempDbPath, cleanupDb } = require("./helpers");
process.env.DB_PATH = tempDbPath();

const test = require("node:test");
const assert = require("node:assert");

const { db, init } = require("../src/db");
const { createTask, updateTask, setTaskStatus } = require("../src/data");

init();

const CHIEF = { id: 1, role: "chief", email: "chief@omg.test" };

function seedTrack() {
  const pj = db().prepare("INSERT INTO projects (title, project_type, rate) VALUES ('작업완료토글', 'task', 0)").run();
  const projectId = Number(pj.lastInsertRowid);
  const tr = db().prepare("INSERT INTO project_tracks (project_id, title, content_type) VALUES (?, '곡', 'Music')").run(projectId);
  return Number(tr.lastInsertRowid);
}

test.after(() => cleanupDb(process.env.DB_PATH, db()));

// ── 완료 토글(2026-07-05 사용자 요청 — 세션 완료 버튼과 동일 UX) ──
test("setTaskStatus: 대기↔완료 토글, 청구된 작업은 TASK_LOCKED", () => {
  const trackId = seedTrack();
  const task = createTask(CHIEF, trackId, { task_type: "Mixing" });
  assert.strictEqual(task.status, "Pending");

  const done = setTaskStatus(CHIEF, task.id, "Completed");
  assert.strictEqual(done.status, "Completed");

  const back = setTaskStatus(CHIEF, task.id, "Pending");
  assert.strictEqual(back.status, "Pending");

  db().prepare("UPDATE track_tasks SET is_invoiced = 1 WHERE id = ?").run(task.id);
  assert.throws(() => setTaskStatus(CHIEF, task.id, "Completed"), /TASK_LOCKED/);
});

// ── 회귀 가드: updateTask가 status 미전송 시 완료 상태를 대기로 리셋하지 않아야 한다 ──
// (2026-07-05 실제 발견한 버그: 완료 토글을 헤더 독립 버튼으로 분리하며 taskEditForm에서 status 필드를
//  뺐는데, updateTask가 normalizeTaskStatus(undefined)를 그대로 쓰면 fallback인 첫 값('Pending')으로
//  덮어써 '작업 저장' 버튼만 눌러도 완료 상태가 대기로 되돌아가던 것.)
test("updateTask: status 미전송이면 기존 상태(완료)를 그대로 보존한다", () => {
  const trackId = seedTrack();
  const task = createTask(CHIEF, trackId, { task_type: "Mixing" });
  setTaskStatus(CHIEF, task.id, "Completed");

  const saved = updateTask(CHIEF, task.id, { task_type: "Mastering", engineer_id: "" }); // status 필드 없음(현재 taskEditForm과 동일)
  assert.strictEqual(saved.status, "Completed", "status 미전송 시 완료 상태 보존");
  assert.strictEqual(saved.task_type, "Mastering", "다른 필드는 정상 갱신");
});

test("updateTask: status를 명시적으로 보내면 여전히 검증·반영된다(레거시 호출부 호환)", () => {
  const trackId = seedTrack();
  const task = createTask(CHIEF, trackId, { task_type: "Mixing" });
  const saved = updateTask(CHIEF, task.id, { task_type: "Mixing", status: "Completed" });
  assert.strictEqual(saved.status, "Completed");
});
