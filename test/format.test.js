"use strict";

// ── 전화·사업자등록번호 정규화(lib/format) 회귀 잠금 ──
// formatBizNo는 청구처 사업자번호(거래명세서 PDF·홈택스 복사 대상), formatPhone은 전 저장 경로 공통.
// 정규화가 회귀하면 잘못 포맷된 값이 세금 문서에 인쇄된다(무테스트였음). 순수 함수라 격리 DB 불필요.
process.env.NODE_ENV = "test";
const test = require("node:test");
const assert = require("node:assert");
const { formatPhone, formatBizNo } = require("../src/lib/format");

test("formatPhone: 11자리 휴대폰 → ###-####-#### (구분자 무관)", () => {
  assert.equal(formatPhone("01035485638"), "010-3548-5638");
  assert.equal(formatPhone("010 3548 5638"), "010-3548-5638");
  assert.equal(formatPhone("010.3548.5638"), "010-3548-5638");
  assert.equal(formatPhone("010-3548-5638"), "010-3548-5638");
});

test("formatPhone: 지역번호 — 02(9·10자리)·기타 10자리", () => {
  assert.equal(formatPhone("0212345678"), "02-1234-5678", "02 + 8자리 = 02-####-####");
  assert.equal(formatPhone("021234567"), "02-123-4567", "02 + 7자리 = 02-###-####");
  assert.equal(formatPhone("0311234567"), "031-123-4567", "031 등 10자리 = 0##-###-####");
  assert.equal(formatPhone("0511234567"), "051-123-4567");
});

test("formatPhone: 8자리(국번 없는 지역) → ####-####", () => {
  assert.equal(formatPhone("12345678"), "1234-5678");
});

test("formatPhone: 형식 불명(자릿수 다름)·빈 값", () => {
  assert.equal(formatPhone("1234"), "1234", "4자리 등은 원본 보존");
  assert.equal(formatPhone("+82 10-3548-5638"), "+82 10-3548-5638", "12자리는 원본 보존(해외·내선)");
  assert.equal(formatPhone(""), null);
  assert.equal(formatPhone(null), null);
  assert.equal(formatPhone("   "), null);
});

test("formatBizNo: 10자리 → 000-00-00000 (구분자 무관)", () => {
  assert.equal(formatBizNo("1234567890"), "123-45-67890");
  assert.equal(formatBizNo("123-45-67890"), "123-45-67890");
  assert.equal(formatBizNo("123 45 67890"), "123-45-67890");
});

test("formatBizNo: 자릿수 다름은 원본 보존·빈 값은 null", () => {
  assert.equal(formatBizNo("12345"), "12345");
  assert.equal(formatBizNo("123456789012"), "123456789012");
  assert.equal(formatBizNo(""), null);
  assert.equal(formatBizNo(null), null);
});
