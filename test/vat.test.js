"use strict";

// ── 격리 DB 셋업: src/* require 이전에 환경변수부터 설정(실 data/app.db 오염 방지) ──
process.env.NODE_ENV = "test";
const { tempDbPath, cleanupDb } = require("./helpers");
process.env.DB_PATH = tempDbPath();

const test = require("node:test");
const assert = require("node:assert");

const { db, init } = require("../src/db");
const { createInvoiceFromTasks, invoiceAmountsFromSupply, listProjects, getProjectForUser } = require("../src/data");

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

test("청구 권한: 스태프(canBill)도 청구서 생성 가능(스태프 청구 허용)", () => {
  const { projectId, taskId } = seedTask(500_000);
  const inv = createInvoiceFromTasks(STAFF, { projectId, taskIds: [taskId], issueDate: "2026-06-15" });
  assert.ok(inv, "스태프도 청구서 발행 가능");
  assert.strictEqual(inv.amount, 550_000); // 공급가 500,000 + VAT 50,000
});

test("청구 권한 가드: 무권한(로그인 역할 아님)은 청구 생성 불가(null)", () => {
  const { projectId, taskId } = seedTask(500_000);
  const inv = createInvoiceFromTasks({ id: 99, role: "none", email: "x@x.test" }, { projectId, taskIds: [taskId], issueDate: "2026-06-15" });
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

// ── invoiceAmountsFromSupply 할인 헬퍼 ──
test("할인 헬퍼: 공급가 1,000,000 · 할인 100,000 → taxable 900,000 · tax 90,000 · total 990,000", () => {
  const r = invoiceAmountsFromSupply(1_000_000, 100_000);
  assert.strictEqual(r.discount, 100_000);
  assert.strictEqual(r.taxable, 900_000);
  assert.strictEqual(r.tax, 90_000);
  assert.strictEqual(r.total, 990_000);
});

test("할인 헬퍼: 정률 10% — 공급가 1,000,000 · 할인 100,000 동일 결과", () => {
  const discount = Math.round(1_000_000 * 10 / 100);
  const r = invoiceAmountsFromSupply(1_000_000, discount);
  assert.strictEqual(r.discount, 100_000);
  assert.strictEqual(r.taxable, 900_000);
  assert.strictEqual(r.tax, 90_000);
  assert.strictEqual(r.total, 990_000);
});

test("할인 헬퍼 clamp: 할인 > 공급가 → 공급가로 제한(taxable=0·tax=0·total=0)", () => {
  const r = invoiceAmountsFromSupply(500_000, 999_999);
  assert.strictEqual(r.discount, 500_000, "할인은 공급가로 clamp");
  assert.strictEqual(r.taxable, 0);
  assert.strictEqual(r.tax, 0);
  assert.strictEqual(r.total, 0);
});

test("할인 헬퍼 clamp: 음수 할인 → 0(clamp)", () => {
  const r = invoiceAmountsFromSupply(500_000, -100_000);
  assert.strictEqual(r.discount, 0);
  assert.strictEqual(r.taxable, 500_000);
  assert.strictEqual(r.tax, 50_000);
  assert.strictEqual(r.total, 550_000);
});

test("할인 포함 createInvoiceFromTasks: 공급가 1,000,000 · 할인 100,000 → amount=990,000 · tax=90,000 · discount_amount=100,000", () => {
  const { projectId, taskId } = seedTask(1_000_000);
  const inv = createInvoiceFromTasks(CHIEF, { projectId, taskIds: [taskId], issueDate: "2026-06-15", discount: 100_000 });
  assert.ok(inv, "인보이스가 생성되어야 한다");
  assert.strictEqual(inv.discount_amount, 100_000, "discount_amount 저장");
  assert.strictEqual(inv.tax_amount, 90_000, "VAT = 900,000 * 0.1");
  assert.strictEqual(inv.amount, 990_000, "총액 = 900,000 + 90,000");
});

// ── 부가세 토글(vatIncluded=false = 현금/부가세 미포함) ──
test("VAT off: 부가세 미포함(현금) — tax 0, total=공급가", () => {
  const r = invoiceAmountsFromSupply(1_000_000, 0, false);
  assert.strictEqual(r.tax, 0, "현금 거래는 VAT 0");
  assert.strictEqual(r.total, 1_000_000, "총액 = 공급가");
});

test("VAT off + 할인: 공급가 1,000,000 · 할인 100,000 → taxable 900,000 · tax 0 · total 900,000", () => {
  const r = invoiceAmountsFromSupply(1_000_000, 100_000, false);
  assert.strictEqual(r.taxable, 900_000);
  assert.strictEqual(r.tax, 0);
  assert.strictEqual(r.total, 900_000);
});

test("createInvoiceFromTasks vatIncluded=false: 현금 청구 — tax_amount 0 · amount=공급가", () => {
  const { projectId, taskId } = seedTask(500_000);
  const inv = createInvoiceFromTasks(CHIEF, { projectId, taskIds: [taskId], issueDate: "2026-06-15", vatIncluded: false });
  assert.ok(inv);
  assert.strictEqual(inv.tax_amount, 0);
  assert.strictEqual(inv.amount, 500_000);
});

// ── 프로젝트 목록·상세 금액의 청구서 할인 차감(2026-07-05 사용자 리포트: 할인 적용 전 금액이 표시되던 버그) ──
// projectAmount(라우트) = task_total + session_amount_total − invoice_discount_total.
// 데이터 파생을 잠근다: 라인(작업·세션) 연결된 from-tasks 청구서 할인만 합산.
// 수동 청구서(라인 무연결)는 프로젝트 버짓에 라인 자체가 안 잡히므로 그 할인을 빼면 이중 차감 — 제외.
test("프로젝트 금액 할인 차감: from-tasks 청구서 할인만 invoice_discount_total로 파생", () => {
  const { projectId, taskId } = seedTask(1_000_000);
  createInvoiceFromTasks(CHIEF, { projectId, taskIds: [taskId], issueDate: "2026-06-15", discount: 150_000 });
  // 수동 청구서(항목 무연결) 할인 990,000 — 파생에 포함되면 안 됨.
  db()
    .prepare(
      "INSERT INTO invoices (project_id, title, amount, tax_amount, discount_amount, status, issued_date) VALUES (?, '수동 청구', 110000, 10000, 990000, '발행', '2026-06-15')"
    )
    .run(projectId);
  const row = listProjects(CHIEF, {}).find((p) => p.id === projectId);
  assert.strictEqual(Number(row.task_total), 1_000_000, "확정 라인 합은 할인 전 그대로");
  assert.strictEqual(Number(row.invoice_discount_total), 150_000, "라인 연결 청구서 할인만 파생(수동 제외)");
  const one = getProjectForUser(CHIEF, projectId);
  assert.strictEqual(Number(one.invoice_discount_total), 150_000, "단건 조회(상세)도 동일 파생");
});
