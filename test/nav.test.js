"use strict";

// ── 격리 DB 셋업(다른 테스트와 동일 패턴 — invoiceTaxTab이 data 모듈 경유라 config 가드 회피용) ──
process.env.NODE_ENV = "test";
const { tempDbPath, cleanupDb } = require("./helpers");
process.env.DB_PATH = tempDbPath();

const test = require("node:test");
const assert = require("node:assert");

const { safePath } = require("../src/lib/nav");
const { invoiceTaxTab } = require("../src/data/invoices");

test.after(() => cleanupDb(process.env.DB_PATH));

// ── safePath: ?return=/폼 return 복귀 경로의 open-redirect 차단(2026-07-09 감사 후속 — 보안 민감 로직 잠금) ──
test("safePath: 내부 절대경로만 통과", () => {
  assert.equal(safePath("/invoices"), "/invoices");
  assert.equal(safePath("/invoices?tab=paid&open=3"), "/invoices?tab=paid&open=3");
  assert.equal(safePath("/projects/1?tab=invoice"), "/projects/1?tab=invoice");
  assert.equal(safePath("/"), "/");
});

test("safePath: 외부·위장 경로 전부 거부(null)", () => {
  assert.equal(safePath("https://evil.com"), null, "절대 URL");
  assert.equal(safePath("//evil.com"), null, "protocol-relative");
  assert.equal(safePath("/\\evil.com"), null, "역슬래시(브라우저가 //로 정규화하는 우회)");
  assert.equal(safePath("evil.com/x"), null, "상대경로");
  assert.equal(safePath("javascript:alert(1)"), null, "스킴");
  assert.equal(safePath(""), null, "빈 문자열");
  assert.equal(safePath(null), null, "null");
  assert.equal(safePath(undefined), null, "undefined");
  assert.equal(safePath(123), null, "비문자열");
});

// ── invoiceTaxTab: 청구 목록 3탭 분류(발행 필요/발행 완료/입금완료) — 상호 배타 보장 ──
test("invoiceTaxTab: tax_status → todo/done/paid 상호 배타 분류", () => {
  assert.equal(invoiceTaxTab({ tax_status: "계산서 미발행" }), "todo");
  assert.equal(invoiceTaxTab({ tax_status: "계산서 발행" }), "done");
  assert.equal(invoiceTaxTab({ tax_status: "입금완료" }), "paid");
  assert.equal(invoiceTaxTab({ tax_status: null }), "todo", "레거시 null도 발행 필요로");
  assert.equal(invoiceTaxTab({}), "todo");
  assert.equal(invoiceTaxTab(null), "todo");
  // 상호 배타: 어떤 상태값이든 정확히 한 탭에만 속한다
  for (const s of ["계산서 미발행", "계산서 발행", "입금완료", null, undefined, "이상한값"]) {
    const tabs = ["todo", "done", "paid"].filter((t) => invoiceTaxTab({ tax_status: s }) === t);
    assert.equal(tabs.length, 1, `상태 '${s}'는 정확히 한 탭`);
  }
});
