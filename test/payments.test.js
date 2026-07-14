"use strict";

// ── 격리 DB 셋업: src/* require 이전에 환경변수부터 설정(실 data/app.db 오염 방지) ──
process.env.NODE_ENV = "test";
const { tempDbPath, cleanupDb } = require("./helpers");
process.env.DB_PATH = tempDbPath();

const test = require("node:test");
const assert = require("node:assert");

const { db, init } = require("../src/db");
const { createInvoiceFromTasks, listPayments, addPayment, deletePayment, recomputePaid, balanceOf, payStatusOf, createCompany } = require("../src/data");

init();

// 청구처는 항상 명시(2026-07-15 — 자동 파생 폐기)
const PAYER = createCompany({ name: "청구처회사", biz_no: "123-45-67890" });

const CHIEF = { id: 1, role: "chief", email: "chief@omg.test" };

/** 프로젝트+트랙+완료 작업 시드 후 청구서 생성 → 인보이스 반환(공급가 totalPrice, VAT 포함). */
function seedInvoice(totalPrice) {
  const pj = db().prepare("INSERT INTO projects (title, project_type, rate) VALUES (?, 'task', 0)").run("입금 테스트");
  const projectId = Number(pj.lastInsertRowid);
  const tr = db().prepare("INSERT INTO project_tracks (project_id, title, content_type) VALUES (?, '곡', 'Music')").run(projectId);
  const trackId = Number(tr.lastInsertRowid);
  const tk = db()
    .prepare(
      `INSERT INTO track_tasks (track_id, task_type, billing_type, quantity, unit_price, total_price, status, is_invoiced)
       VALUES (?, 'Mixing', 'Fixed_Per_Track', 1, ?, ?, 'Completed', 0)`
    )
    .run(trackId, totalPrice, totalPrice);
  return createInvoiceFromTasks(CHIEF, { projectId, clientId: PAYER, taskIds: [Number(tk.lastInsertRowid)], issueDate: "2026-06-15" });
}

function reload(id) {
  return db().prepare("SELECT * FROM invoices WHERE id = ?").get(id);
}

test.after(() => cleanupDb(process.env.DB_PATH, db()));

test("addPayment: 부분납 2건 누적 → paid_amount = 합계, 잔금·상태 파생", () => {
  const inv = seedInvoice(1_000_000); // amount 1,100,000
  addPayment(inv.id, { amount: 400_000, paid_on: "2026-06-20" });
  const paid = addPayment(inv.id, { amount: 300_000, paid_on: "2026-06-25" });
  assert.strictEqual(paid, 700_000, "누적 입금 = 400,000 + 300,000");
  const row = reload(inv.id);
  assert.strictEqual(row.paid_amount, 700_000, "paid_amount = SUM(payments)");
  assert.strictEqual(balanceOf(row), 400_000, "잔금 = 1,100,000 - 700,000");
  assert.strictEqual(payStatusOf(row), "부분납");
  assert.strictEqual(listPayments(inv.id).length, 2, "이력 2건");
});

test("addPayment: amount<=0은 이력에 남기지 않음(무시)", () => {
  const inv = seedInvoice(500_000);
  addPayment(inv.id, { amount: 0 });
  addPayment(inv.id, { amount: -100 });
  assert.strictEqual(listPayments(inv.id).length, 0, "0·음수는 기록 안 함");
  assert.strictEqual(reload(inv.id).paid_amount, 0);
});

test("deletePayment: 삭제 후 paid_amount 재계산", () => {
  const inv = seedInvoice(1_000_000);
  addPayment(inv.id, { amount: 600_000 });
  const p2 = listPayments(inv.id); // 1건
  addPayment(inv.id, { amount: 200_000 });
  const all = listPayments(inv.id); // 2건
  assert.strictEqual(reload(inv.id).paid_amount, 800_000);
  const r = deletePayment(all[1].id);
  assert.strictEqual(r.invoiceId, inv.id);
  assert.strictEqual(r.paid, 600_000, "삭제 후 남은 합계");
  assert.strictEqual(reload(inv.id).paid_amount, 600_000);
  assert.strictEqual(listPayments(inv.id).length, 1);
  assert.ok(p2); // lint 방지
});

test("recomputePaid: payments 합계로 paid_amount 강제 동기화", () => {
  const inv = seedInvoice(1_000_000);
  addPayment(inv.id, { amount: 300_000 });
  // paid_amount를 일부러 어긋나게 조작 후 recompute가 바로잡는지
  db().prepare("UPDATE invoices SET paid_amount = 999999 WHERE id = ?").run(inv.id);
  const sum = recomputePaid(inv.id);
  assert.strictEqual(sum, 300_000);
  assert.strictEqual(reload(inv.id).paid_amount, 300_000);
});

test("완납: 잔금 전액 입금 시 완납 상태", () => {
  const inv = seedInvoice(1_000_000); // 1,100,000
  const paid = addPayment(inv.id, { amount: 1_100_000 });
  assert.strictEqual(paid, 1_100_000);
  const row = reload(inv.id);
  assert.strictEqual(balanceOf(row), 0);
  assert.strictEqual(payStatusOf(row), "완납");
});
