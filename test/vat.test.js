"use strict";

// ── 격리 DB 셋업: src/* require 이전에 환경변수부터 설정(실 data/app.db 오염 방지) ──
process.env.NODE_ENV = "test";
const { tempDbPath, cleanupDb } = require("./helpers");
process.env.DB_PATH = tempDbPath();

const test = require("node:test");
const assert = require("node:assert");

const { db, init } = require("../src/db");
const { createInvoiceFromTasks } = require("../src/data");

init();

const CHIEF = { id: 1, role: "chief", email: "chief@omg.test" };
const STAFF = { id: 2, role: "staff", email: "staff@omg.test" };

/** 프로젝트 + 트랙 + 작업(미청구) 시드. total_price 원하는 값으로. taskId 반환. */
function seedTask(totalPrice) {
  const pj = db()
    .prepare("INSERT INTO projects (title, project_type, rate) VALUES (?, 'task', 0)")
    .run("VAT 테스트 프로젝트");
  const projectId = Number(pj.lastInsertRowid);
  const tr = db()
    .prepare("INSERT INTO project_tracks (project_id, title, content_type) VALUES (?, ?, 'Music')")
    .run(projectId, "곡 A");
  const trackId = Number(tr.lastInsertRowid);
  const tk = db()
    .prepare(
      `INSERT INTO track_tasks (track_id, task_type, billing_type, quantity, unit_price, total_price, status, is_invoiced)
       VALUES (?, 'Mixing', 'Fixed_Per_Track', 1, ?, ?, 'Completed', 0)`
    )
    .run(trackId, totalPrice, totalPrice);
  return { projectId, taskId: Number(tk.lastInsertRowid) };
}

test.after(() => cleanupDb(process.env.DB_PATH, db()));

test("VAT: 공급가 1,000,000 → tax 100,000 · 총액 1,100,000 저장", () => {
  const { projectId, taskId } = seedTask(1_000_000);
  const inv = createInvoiceFromTasks(CHIEF, { projectId, taskIds: [taskId], issueDate: "2026-06-15" });
  assert.ok(inv, "인보이스가 생성되어야 한다");
  assert.strictEqual(inv.amount, 1_100_000, "amount = 공급가 + VAT");
  assert.strictEqual(inv.tax_amount, 100_000, "tax_amount = round(공급가 * 0.1)");
  assert.strictEqual(inv.amount - inv.tax_amount, 1_000_000, "공급가 = amount - tax");
});

test("VAT: 반올림 케이스 — 공급가 333,333 → tax 33,333 · 총액 366,666", () => {
  const { projectId, taskId } = seedTask(333_333); // 333333 * 0.1 = 33333.3 → round 33333
  const inv = createInvoiceFromTasks(CHIEF, { projectId, taskIds: [taskId], issueDate: "2026-06-15" });
  assert.strictEqual(inv.tax_amount, 33_333);
  assert.strictEqual(inv.amount, 366_666);
});

test("VAT: 여러 작업 합산 후 과세 — 600,000 + 400,000 → tax 100,000 · 총액 1,100,000", () => {
  const pj = db().prepare("INSERT INTO projects (title, project_type, rate) VALUES (?, 'task', 0)").run("합산 프로젝트");
  const projectId = Number(pj.lastInsertRowid);
  const tr = db().prepare("INSERT INTO project_tracks (project_id, title, content_type) VALUES (?, '곡', 'Music')").run(projectId);
  const trackId = Number(tr.lastInsertRowid);
  const mk = (price) =>
    Number(
      db()
        .prepare(
          `INSERT INTO track_tasks (track_id, task_type, billing_type, quantity, unit_price, total_price, status, is_invoiced)
           VALUES (?, 'Mixing', 'Fixed_Per_Track', 1, ?, ?, 'Completed', 0)`
        )
        .run(trackId, price, price).lastInsertRowid
    );
  const t1 = mk(600_000);
  const t2 = mk(400_000);
  const inv = createInvoiceFromTasks(CHIEF, { projectId, taskIds: [t1, t2], issueDate: "2026-06-15" });
  assert.strictEqual(inv.tax_amount, 100_000);
  assert.strictEqual(inv.amount, 1_100_000);
});

test("청구 권한 가드: 스태프(canInvoice=false)는 청구 생성 불가(null)", () => {
  const { projectId, taskId } = seedTask(500_000);
  const inv = createInvoiceFromTasks(STAFF, { projectId, taskIds: [taskId], issueDate: "2026-06-15" });
  assert.strictEqual(inv, null);
});

// ── 순수 VAT 공식 검증(소스 비의존): round(amount - amount/1.1) ──
// VAT 포함 총액에서 부가세 추출 공식. 대표 케이스가 정수로 떨어지는지 확인.
test("순수 공식 round(amount - amount/1.1): 대표 케이스", () => {
  const vat = (amount) => Math.round(amount - amount / 1.1);
  assert.strictEqual(vat(1_100_000), 100_000);
  assert.strictEqual(vat(0), 0);
  assert.strictEqual(vat(11_000), 1_000);
  assert.strictEqual(vat(550_000), 50_000);
});
