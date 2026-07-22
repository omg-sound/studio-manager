"use strict";

// ── 격리 DB 셋업: src/* require 이전에 환경변수부터 설정(실 data/app.db 오염 방지) ──
process.env.NODE_ENV = "test";
const { tempDbPath, cleanupDb } = require("./helpers");
process.env.DB_PATH = tempDbPath();

const test = require("node:test");
const assert = require("node:assert");

const { db, init } = require("../src/db");
const { createInvoiceFromTasks, deleteInvoice, addPayment, listPayments, createCompany, invoiceIsSettled } = require("../src/data");

init();

/**
 * 청구 삭제 가드 회귀 — 2026-07-23 기능성 평가에서 확인된 결함.
 *
 * `deleteInvoice`가 `canBill`만 보고 `tax_status`·`paid_amount`를 검사하지 않아,
 * 홈택스에 계산서가 나갔거나 입금까지 끝난 청구서를 **스태프도** 지울 수 있었다.
 * `payments`가 FK CASCADE라 입금 이력까지 함께 소멸해 매출·미수가 소급 변한다.
 *
 * 정책(사용자 결정): '정정 = 삭제 후 재발행' 경로는 그대로 두되,
 * **확정 진행된 건(계산서 발행·입금 있음)은 치프·대표만** 삭제할 수 있게 승격한다.
 */

const PAYER = createCompany({ name: "청구처회사", biz_no: "123-45-67890" });

const CHIEF = { id: 1, role: "chief", email: "chief@omg.test" };
const OWNER = { id: 2, role: "owner", email: "owner@omg.test" };
const STAFF = { id: 3, role: "staff", email: "staff@omg.test" };

let seq = 0;
/** 프로젝트+트랙+완료 작업 시드 후 청구서 생성. */
function seedInvoice(totalPrice = 1_000_000) {
  seq += 1;
  const pj = db().prepare("INSERT INTO projects (title, project_type, rate) VALUES (?, 'task', 0)").run(`삭제가드${seq}`);
  const projectId = Number(pj.lastInsertRowid);
  const tr = db().prepare("INSERT INTO project_tracks (project_id, title, content_type) VALUES (?, '곡', 'Music')").run(projectId);
  const tk = db()
    .prepare(
      `INSERT INTO track_tasks (track_id, task_type, billing_type, quantity, unit_price, total_price, status, is_invoiced)
       VALUES (?, 'Mixing', 'Fixed_Per_Track', 1, ?, ?, 'Completed', 0)`
    )
    .run(Number(tr.lastInsertRowid), totalPrice, totalPrice);
  return createInvoiceFromTasks(CHIEF, { projectId, clientId: PAYER, taskIds: [Number(tk.lastInsertRowid)], issueDate: "2026-06-15" });
}

const reload = (id) => db().prepare("SELECT * FROM invoices WHERE id = ?").get(id);
const setTax = (id, tax) => db().prepare("UPDATE invoices SET tax_status = ? WHERE id = ?").run(tax, id);

test.after(() => cleanupDb(process.env.DB_PATH, db()));

// ── 판정 헬퍼 ──

test("invoiceIsSettled: 계산서가 나갔거나 입금이 있으면 '확정 진행'", () => {
  assert.strictEqual(invoiceIsSettled({ tax_status: "계산서 미발행", paid_amount: 0 }), false);
  assert.strictEqual(invoiceIsSettled({ tax_status: "계산서 발행", paid_amount: 0 }), true, "계산서 발행 = 홈택스에 이미 나감");
  assert.strictEqual(invoiceIsSettled({ tax_status: "입금완료", paid_amount: 1000 }), true);
  assert.strictEqual(invoiceIsSettled({ tax_status: "계산서 미발행", paid_amount: 500 }), true, "부분 입금만 있어도 확정 진행");
});

// ── 스태프 차단 ──

test("deleteInvoice: 계산서 발행된 청구서를 스태프가 지우려 하면 거부", () => {
  const inv = seedInvoice();
  setTax(inv.id, "계산서 발행");

  assert.throws(() => deleteInvoice(STAFF, inv.id), /INVOICE_SETTLED_FORBIDDEN/);
  assert.ok(reload(inv.id), "청구서가 남아 있어야 한다");
});

test("deleteInvoice: 입금이 있는 청구서를 스태프가 지우려 하면 거부 — 입금 이력도 보존", () => {
  const inv = seedInvoice();
  addPayment(inv.id, { amount: 400_000, paid_on: "2026-06-20" });

  assert.throws(() => deleteInvoice(STAFF, inv.id), /INVOICE_SETTLED_FORBIDDEN/);
  assert.ok(reload(inv.id));
  assert.strictEqual(listPayments(inv.id).length, 1, "입금 이력이 CASCADE로 사라지지 않아야 한다");
});

// ── 정상 경로 회귀(과잉 차단 아님) ──

test("deleteInvoice: 계산서 미발행·입금 0이면 스태프도 그대로 삭제(발행 직후 정정 경로 유지)", () => {
  const inv = seedInvoice();
  const r = deleteInvoice(STAFF, inv.id);
  assert.ok(r, "미발행·미입금 건은 기존대로 스태프가 정정 가능");
  assert.ok(!reload(inv.id));
});

test("deleteInvoice: 확정 진행된 건도 치프·대표는 삭제할 수 있다(정정=삭제 후 재발행 유지)", () => {
  const a = seedInvoice();
  setTax(a.id, "입금완료");
  addPayment(a.id, { amount: 1_100_000, paid_on: "2026-06-20" });
  assert.ok(deleteInvoice(CHIEF, a.id), "치프는 삭제 가능");
  assert.ok(!reload(a.id));

  const b = seedInvoice();
  setTax(b.id, "계산서 발행");
  assert.ok(deleteInvoice(OWNER, b.id), "대표도 삭제 가능");
  assert.ok(!reload(b.id));
});

test("deleteInvoice: 삭제 결과에 감사 로그용 금액·입금·세금상태가 담긴다", () => {
  const inv = seedInvoice(700_000);
  setTax(inv.id, "계산서 발행");
  addPayment(inv.id, { amount: 200_000, paid_on: "2026-06-21" });

  const r = deleteInvoice(CHIEF, inv.id);
  assert.strictEqual(r.id, inv.id);
  assert.strictEqual(r.amount, 770_000, "VAT 포함 총액");
  assert.strictEqual(r.paid_amount, 200_000, "삭제 시점 입금액 — 로그에 남아야 사후 추적이 된다");
  assert.strictEqual(r.tax_status, "계산서 발행");
  assert.ok(r.invoice_number, "청구번호");
});

test("deleteInvoice: 청구 권한 자체가 없으면 종전대로 null (권한 게이트 회귀)", () => {
  const inv = seedInvoice();
  assert.strictEqual(deleteInvoice({ id: 9, role: "guest" }, inv.id), null);
  assert.ok(reload(inv.id));
});
