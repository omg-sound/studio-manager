"use strict";

const test = require("node:test");
const assert = require("node:assert");
const { withholding33 } = require("../src/lib/tax");

// ── 외주 원천징수 3.3%(사업소득) — 실무 절사 방식(소득세·지방세 각 10원 미만 절사) ──
test("withholding33: 딱 떨어지는 금액(50만) — 3.3% 그대로", () => {
  const r = withholding33(500000);
  assert.deepEqual(r, { gross: 500000, incomeTax: 15000, localTax: 1500, total: 16500, net: 483500 });
});

test("withholding33: 절사 발생 금액 — 단순 3.3%와 다름(홈택스 방식)", () => {
  const r = withholding33(333333);
  assert.equal(r.incomeTax, 9990, "3% = 9,999.99 → 10원 미만 절사 9,990");
  assert.equal(r.localTax, 990, "소득세×10% = 999 → 절사 990");
  assert.equal(r.total, 10980);
  assert.equal(r.net, 322353);
  assert.notEqual(r.total, Math.round(333333 * 0.033), "단순 3.3%(11,000)와 구분");
});

test("withholding33: 경계값 — 0·소액·비정상 입력", () => {
  assert.deepEqual(withholding33(0), { gross: 0, incomeTax: 0, localTax: 0, total: 0, net: 0 });
  assert.equal(withholding33(300).incomeTax, 0, "3%가 10원 미만이면 절사로 0");
  assert.equal(withholding33(-5000).gross, 0, "음수는 0으로");
  assert.equal(withholding33(null).net, 0);
  const r = withholding33(1000000);
  assert.equal(r.net + r.total, r.gross, "실지급+원천세 = 지급액(누수 없음)");
});
