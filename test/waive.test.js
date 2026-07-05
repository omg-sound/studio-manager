"use strict";

// ── 격리 DB 셋업(다른 테스트와 동일 패턴) ──
process.env.NODE_ENV = "test";
const { tempDbPath, cleanupDb } = require("./helpers");
process.env.DB_PATH = tempDbPath();

const test = require("node:test");
const assert = require("node:assert");

const { db, init } = require("../src/db");
const { createTask, setTaskWaived, setSessionWaived, listProjects, sessionRateAmount } = require("../src/data");

init();

const CHIEF = { id: 1, role: "chief", email: "chief@omg.test" };

// ── '청구 안 함'(무료 처리, 2026-07-06 사용자 요청 — 리허설 등 의도적 무료 작업/세션) ──
// 청구 필요 집계(unbilled_cnt)·프로젝트 예산(task_total)에서 제외하되, total_price는 안 건드려 되돌리기 가능해야 한다.

function seedProject(title) {
  return Number(db().prepare("INSERT INTO projects (title, project_type, rate) VALUES (?, 'task', 0)").run(title).lastInsertRowid);
}

test.after(() => cleanupDb(process.env.DB_PATH, db()));

test("setTaskWaived: 토글 + 예산·미청구 집계에서 제외, 되돌리면 원래 금액 그대로 복원", () => {
  const projectId = seedProject("무료작업테스트");
  const tr = db().prepare("INSERT INTO project_tracks (project_id, title, content_type) VALUES (?, '곡', 'Music')").run(projectId);
  const trackId = Number(tr.lastInsertRowid);
  const task = createTask(CHIEF, trackId, { task_type: "Mixing" });
  db().prepare("UPDATE track_tasks SET total_price = 300000, status = 'Completed' WHERE id = ?").run(task.id);

  let rows = listProjects(CHIEF, {});
  let row = rows.find((r) => r.id === projectId);
  assert.strictEqual(row.task_total, 300000, "무료 처리 전에는 예산에 포함");
  assert.strictEqual(row.unbilled_cnt, 1, "무료 처리 전에는 미청구 1건");

  const waived = setTaskWaived(CHIEF, task.id);
  assert.strictEqual(waived.waived, 1, "토글 시 waived=1");
  assert.strictEqual(waived.total_price, 300000, "total_price는 건드리지 않음(되돌리기 대비)");

  rows = listProjects(CHIEF, {});
  row = rows.find((r) => r.id === projectId);
  assert.strictEqual(row.task_total, 0, "무료 처리 후 예산 제외");
  assert.strictEqual(row.unbilled_cnt, 0, "무료 처리 후 미청구 집계 제외");

  // 되돌리기(같은 토글 재호출) — 원래 금액 그대로 복원.
  const restored = setTaskWaived(CHIEF, task.id);
  assert.strictEqual(restored.waived, 0);
  assert.strictEqual(restored.total_price, 300000, "되돌리면 원래 금액 그대로");
  rows = listProjects(CHIEF, {});
  row = rows.find((r) => r.id === projectId);
  assert.strictEqual(row.task_total, 300000, "되돌리면 예산도 복원");
  assert.strictEqual(row.unbilled_cnt, 1);

  // 청구된 작업은 무료 처리 불가.
  db().prepare("UPDATE track_tasks SET is_invoiced = 1 WHERE id = ?").run(task.id);
  assert.throws(() => setTaskWaived(CHIEF, task.id), /TASK_LOCKED/);
});

test("setSessionWaived: 토글 + 미청구 집계에서 제외, 청구된 세션은 SESSION_INVOICED", () => {
  const projectId = seedProject("무료세션테스트");
  const rate = db()
    .prepare(
      `INSERT INTO rate_items (name, category, base_minutes, base_price, extra_minutes, extra_price, active)
       VALUES ('테스트 녹음', '스튜디오 녹음', 210, 300000, 60, 100000, 1)`
    )
    .run();
  const rateId = Number(rate.lastInsertRowid);
  const s = db()
    .prepare(
      `INSERT INTO sessions (project_id, session_type, session_date, start_time, end_time, status, rate_item_id)
       VALUES (?, '녹음', '2026-07-06', '10:00', '13:30', '완료', ?)`
    )
    .run(projectId, rateId);
  const sessionId = Number(s.lastInsertRowid);

  let rows = listProjects(CHIEF, {});
  let row = rows.find((r) => r.id === projectId);
  assert.strictEqual(row.unbilled_cnt, 1, "무료 처리 전에는 미청구 1건");
  assert.ok(row.session_amount_total > 0, "무료 처리 전에는 세션 예산 포함");

  const waived = setSessionWaived(CHIEF, sessionId);
  assert.strictEqual(waived.waived, 1);

  rows = listProjects(CHIEF, {});
  row = rows.find((r) => r.id === projectId);
  assert.strictEqual(row.unbilled_cnt, 0, "무료 처리 후 미청구 집계 제외");
  assert.strictEqual(row.session_amount_total, 0, "무료 처리 후 세션 예산 제외");

  const restored = setSessionWaived(CHIEF, sessionId);
  assert.strictEqual(restored.waived, 0);
  rows = listProjects(CHIEF, {});
  row = rows.find((r) => r.id === projectId);
  assert.strictEqual(row.unbilled_cnt, 1, "되돌리면 미청구 집계 복원");
  assert.ok(row.session_amount_total > 0, "되돌리면 세션 예산도 복원");

  const inv = db().prepare("INSERT INTO invoices (title, amount, paid_amount, status, tax_status) VALUES ('테스트 청구', 0, 0, '발행', '계산서 미발행')").run();
  db().prepare("INSERT INTO invoice_items (invoice_id, session_id, track_title, task_type, description, quantity, unit_price, amount) VALUES (?, ?, '', '', '', 1, 0, 0)").run(Number(inv.lastInsertRowid), sessionId);
  assert.throws(() => setSessionWaived(CHIEF, sessionId), /SESSION_INVOICED/);
});
