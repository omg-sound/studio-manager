"use strict";

// ── 청구 계산서·입금 상태 일괄 처리(2026-07-16) ──
// applyTaxStatusTx(단건·일괄 공용)이 입금완료=완납(자동 입금 1건)·되돌리기=자동 입금만 제거·채번 보장을 하는지 검증.
// 일괄 라우트(POST /invoices/bulk-tax-status)는 이 헬퍼를 id마다 한 트랜잭션으로 적용한다(대표·치프=requireInvoice).
process.env.NODE_ENV = "test";
const { tempDbPath, cleanupDb } = require("./helpers");
process.env.DB_PATH = tempDbPath();

const test = require("node:test");
const assert = require("node:assert");
const { db, init } = require("../src/db");
init();
test.after(() => cleanupDb(process.env.DB_PATH, db()));

const { applyTaxStatusTx } = require("../src/routes/invoices.routes");
const { balanceOf, listPayments } = require("../src/data");

function mkInvoice(amount, tax_status) {
  const id = db()
    .prepare("INSERT INTO invoices (title, amount, paid_amount, status, tax_status) VALUES ('청구', ?, 0, '발행', ?)")
    .run(amount, tax_status).lastInsertRowid;
  return db().prepare("SELECT * FROM invoices WHERE id = ?").get(id);
}
const reget = (id) => db().prepare("SELECT * FROM invoices WHERE id = ?").get(id);

test("입금완료 처리: 잔금만큼 자동 입금 1건 + tax_status=입금완료(완납)", () => {
  const inv = mkInvoice(300000, "계산서 발행");
  applyTaxStatusTx(db(), inv, "입금완료");
  const after = reget(inv.id);
  assert.equal(after.tax_status, "입금완료");
  assert.equal(after.paid_amount, 300000, "완납(SUM(payments) 재계산)");
  assert.equal(balanceOf(after), 0, "잔금 0");
  const pays = listPayments(inv.id);
  assert.equal(pays.length, 1, "자동 완납 입금 1건");
  assert.equal(pays[0].memo, "입금완료 처리");
});

test("입금완료 되돌리기: 자동 완납 입금만 제거해 잔금 복원(사용자 입금 이력은 보존)", () => {
  const inv = mkInvoice(300000, "계산서 발행");
  applyTaxStatusTx(db(), inv, "입금완료"); // 자동 완납
  // 사용자 직접 입금 이력 1건(memo 다름) 추가 — 되돌려도 살아남아야 한다
  db().prepare("INSERT INTO payments (invoice_id, amount, paid_on, memo) VALUES (?, 50000, '2026-07-16', '계좌이체')").run(inv.id);
  applyTaxStatusTx(db(), reget(inv.id), "계산서 발행"); // 되돌리기
  const after = reget(inv.id);
  assert.equal(after.tax_status, "계산서 발행");
  const pays = listPayments(inv.id);
  assert.equal(pays.length, 1, "자동 완납만 제거, 사용자 입금은 보존");
  assert.equal(pays[0].memo, "계좌이체");
  assert.equal(after.paid_amount, 50000, "잔금 복원(50000만 입금)");
});

test("입금완료 멱등: 이미 완납이면 중복 입금 안 만든다(일괄에서 재선택 안전)", () => {
  const inv = mkInvoice(200000, "입금완료");
  db().prepare("INSERT INTO payments (invoice_id, amount, paid_on, memo) VALUES (?, 200000, '2026-07-16', '입금완료 처리')").run(inv.id);
  db().prepare("UPDATE invoices SET paid_amount = 200000 WHERE id = ?").run(inv.id);
  applyTaxStatusTx(db(), reget(inv.id), "입금완료");
  const pays = listPayments(inv.id);
  assert.equal(pays.length, 1, "잔금 0이라 새 입금 없음");
  assert.equal(reget(inv.id).tax_status, "입금완료");
});

test("계산서 발행: 채번 보장(발행되면 청구번호 채움)", () => {
  const inv = mkInvoice(100000, "계산서 미발행");
  assert.ok(!inv.invoice_number, "발행 전 번호 없음");
  applyTaxStatusTx(db(), inv, "계산서 발행");
  assert.ok(reget(inv.id).invoice_number, "발행 시 채번");
});

test("일괄 라우트: requireInvoice 게이트(대표·치프만) — 소스 계약", () => {
  const fs = require("fs");
  const src = fs.readFileSync(require("path").join(__dirname, "..", "src", "routes", "invoices.routes.js"), "utf8");
  assert.match(src, /router\.post\("\/bulk-tax-status", requireInvoice,/, "일괄 라우트 = requireInvoice");
  assert.match(src, /\.split\(","\)[\s\S]*Number\.isInteger/, "ids 콤마 파싱 + 정수 필터");
});
