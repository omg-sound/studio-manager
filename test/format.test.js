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

// ── DB 타임스탬프(UTC) → 한국 시간 표시(2026-07-20 사용자 요청 '시스템 시간대가 UTC인데 우리나라 시간으로') ──
// SQLite datetime('now')는 UTC다. 그대로 앞 10자를 자르면 **KST 00:00~08:59에 만든 것이 하루 이르게** 보인다
// (실측: 개발 DB 프로젝트 7건). 저장은 UTC 그대로 두고 표시에서만 +9h 한다.
const { kstYmd, kstDateTime } = require("../src/lib/date");

test("kstYmd: UTC 저녁 = KST 다음 날(작성일이 하루 이르게 보이던 버그)", () => {
  assert.equal(kstYmd("2026-07-19 23:30:00"), "2026-07-20", "UTC 19일 23:30 = KST 20일 08:30");
  assert.equal(kstYmd("2026-07-19 15:00:00"), "2026-07-20", "KST 자정 경계(UTC 15:00)");
  assert.equal(kstYmd("2026-07-19 14:59:59"), "2026-07-19", "경계 직전은 그대로");
});

test("kstDateTime: 시각까지 KST로(감사 로그)", () => {
  assert.equal(kstDateTime("2026-07-20 02:00:00"), "2026-07-20 11:00");
  assert.equal(kstDateTime("2026-07-19 23:30:00"), "2026-07-20 08:30");
});

test("kstYmd/kstDateTime: 날짜만 있는 값은 그대로(이미 KST 기준으로 고른 날짜)", () => {
  // session_date·issued_date 등은 사용자가 고른 KST 날짜다 — 여기에 +9h를 먹이면 하루 밀린다.
  assert.equal(kstYmd("2026-07-20"), "2026-07-20");
  assert.equal(kstDateTime("2026-07-20"), "2026-07-20");
});

test("kstYmd/kstDateTime: 빈 값·형식 불명은 조용히 통과(표시용이라 던지지 않는다)", () => {
  assert.equal(kstYmd(""), "");
  assert.equal(kstYmd(null), "");
  assert.equal(kstDateTime(undefined), "");
  assert.equal(kstYmd("이상한값"), "이상한값".slice(0, 10));
});

test("kstDate: ISO(Z·오프셋 표기)도 이해한다", () => {
  const { kstDate } = require("../src/lib/date");
  assert.equal(kstDate("2026-07-19T23:30:00Z").getUTCHours(), 8, "Z 표기");
  assert.equal(kstDate("2026-07-20") , null, "날짜만이면 변환 대상 아님");
});
