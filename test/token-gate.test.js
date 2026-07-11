"use strict";

// ── 공개 다운로드 링크 게이트(tokenGate) 회귀 잠금 ──
// /d/:token(로그인 불필요)의 유일한 방어선 — 존재·철회·만료 판정이 하나라도 뒤집히면
// 철회·만료된 링크로 자료가 계속 다운로드된다(무테스트였음). 순수 함수라 격리 DB 불필요.
process.env.NODE_ENV = "test";
const test = require("node:test");
const assert = require("node:assert");
const { todayYmd } = require("../src/lib/date");
const { tokenGate } = require("../src/routes/deliverables.routes");

const PAST = "2000-01-01";   // 항상 오늘보다 과거(문자열 비교)
const FUTURE = "2999-12-31"; // 항상 오늘보다 미래
const VALID = { access_token: "tok_abc", revoked: 0, expires_at: FUTURE };

test("tokenGate: 유효한 링크는 통과(ok)", () => {
  assert.deepEqual(tokenGate(VALID), { ok: true });
  assert.deepEqual(tokenGate({ access_token: "tok_x", revoked: 0, expires_at: null }), { ok: true }, "만료일 없으면 무기한");
  assert.equal(tokenGate({ access_token: "tok_x", revoked: 0, expires_at: todayYmd() }).ok, true, "오늘 만료일은 오늘까지 유효(> 비교)");
});

test("tokenGate: 존재하지 않는/토큰 없는 링크는 차단(404)", () => {
  assert.equal(tokenGate(null).ok, false);
  assert.equal(tokenGate(null).code, 404);
  assert.equal(tokenGate(undefined).ok, false);
  assert.equal(tokenGate({ access_token: "" }).ok, false, "빈 토큰");
  assert.equal(tokenGate({ access_token: null }).ok, false, "토큰 null");
});

test("tokenGate: 철회된 링크는 차단", () => {
  const r = tokenGate({ ...VALID, revoked: 1 });
  assert.equal(r.ok, false);
  assert.equal(r.code, 404);
});

test("tokenGate: 만료된 링크는 차단", () => {
  const r = tokenGate({ ...VALID, expires_at: PAST });
  assert.equal(r.ok, false);
  assert.equal(r.code, 404);
});

test("tokenGate: 차단 판정에 우선순위 무관하게 하나라도 걸리면 막힘", () => {
  // 철회 + 만료 동시 → 차단(어느 조건이 먼저든 ok=false 보장).
  assert.equal(tokenGate({ access_token: "t", revoked: 1, expires_at: PAST }).ok, false);
});
