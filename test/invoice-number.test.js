"use strict";

// ── 격리 DB 셋업: src/* require 이전에 환경변수부터 설정 ──
process.env.NODE_ENV = "test";
const { tempDbPath, cleanupDb } = require("./helpers");
process.env.DB_PATH = tempDbPath();

const test = require("node:test");
const assert = require("node:assert");

const { db, init } = require("../src/db");
// ensureInvoiceNumber 는 내부의 nextInvoiceNumber 채번 로직을 통해
// 미발행→발행 전이 시 INV-YYYYMM-### 를 부여한다(nextInvoiceNumber 는 미export → 이 경로로 검증).
const { ensureInvoiceNumber } = require("../src/data");

init();

/** invoice_number 없는 인보이스 한 건 시드 후 행 객체 반환. */
function seedInvoice({ status = "발행", issued = "2026-06-15" } = {}) {
  const info = db()
    .prepare(
      `INSERT INTO invoices (title, amount, tax_amount, paid_amount, status, issued_date)
       VALUES (?, 0, 0, 0, ?, ?)`
    )
    .run("청구", status, issued);
  return db().prepare("SELECT * FROM invoices WHERE id = ?").get(Number(info.lastInsertRowid));
}

test.after(() => cleanupDb(process.env.DB_PATH, db()));

test("형식: INV-YYYYMM-001 (issued_date 의 연·월)", () => {
  const inv = ensureInvoiceNumber(seedInvoice({ issued: "2026-06-15" }));
  assert.match(inv.invoice_number, /^INV-202606-\d{3}$/);
  assert.strictEqual(inv.invoice_number, "INV-202606-001");
});

test("같은 달 연속 증가: 001 → 002 → 003", () => {
  const a = ensureInvoiceNumber(seedInvoice({ issued: "2026-07-01" }));
  const b = ensureInvoiceNumber(seedInvoice({ issued: "2026-07-20" }));
  const c = ensureInvoiceNumber(seedInvoice({ issued: "2026-07-31" }));
  assert.strictEqual(a.invoice_number, "INV-202607-001");
  assert.strictEqual(b.invoice_number, "INV-202607-002");
  assert.strictEqual(c.invoice_number, "INV-202607-003");
});

test("월이 바뀌면 일련번호 리셋: 다른 달은 001 부터", () => {
  const aug = ensureInvoiceNumber(seedInvoice({ issued: "2026-08-10" }));
  assert.strictEqual(aug.invoice_number, "INV-202608-001");
});

test("중복 없음: 같은 달 다건 채번이 모두 유일", () => {
  for (let i = 0; i < 5; i++) ensureInvoiceNumber(seedInvoice({ issued: "2026-09-05" }));
  const rows = db()
    .prepare("SELECT invoice_number FROM invoices WHERE invoice_number LIKE 'INV-202609-%'")
    .all()
    .map((r) => r.invoice_number);
  assert.strictEqual(rows.length, 5);
  assert.strictEqual(new Set(rows).size, 5, "채번된 번호에 중복이 없어야 한다");
});

test("가드: 미발행 상태는 채번하지 않는다(invoice_number=null 유지)", () => {
  const inv = ensureInvoiceNumber(seedInvoice({ status: "미발행", issued: "2026-10-01" }));
  assert.strictEqual(inv.invoice_number, null);
});

test("가드: 이미 번호가 있으면 그대로 반환(재채번 안 함)", () => {
  const row = seedInvoice({ issued: "2026-11-01" });
  const once = ensureInvoiceNumber(row);
  const twice = ensureInvoiceNumber(once); // 이미 번호 있음
  assert.strictEqual(once.invoice_number, twice.invoice_number);
  assert.strictEqual(twice.invoice_number, "INV-202611-001");
});

test("입금완료 상태도 채번 대상", () => {
  const inv = ensureInvoiceNumber(seedInvoice({ status: "입금완료", issued: "2026-12-24" }));
  assert.strictEqual(inv.invoice_number, "INV-202612-001");
});
