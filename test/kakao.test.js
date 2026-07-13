"use strict";
process.env.NODE_ENV = "test";
const { tempDbPath, cleanupDb } = require("./helpers");
process.env.DB_PATH = tempDbPath();

const test = require("node:test");
const assert = require("node:assert");
const { db, init } = require("../src/db");
init();
const kakao = require("../src/kakao");

test.after(() => cleanupDb(process.env.DB_PATH, db()));

test("saveTokens·getLinkStatus·disconnect 왕복", () => {
  assert.equal(kakao.isLinked(), false, "초기 미연동");
  assert.deepEqual(
    { linked: kakao.getLinkStatus().linked, expired: kakao.getLinkStatus().expired },
    { linked: false, expired: false }
  );
  kakao.saveTokens({ refreshToken: "rt_abc", accessToken: "at_xyz", expiresInSec: 21600, nickname: "김보종" });
  assert.equal(kakao.isLinked(), true, "저장 후 연동됨");
  const st = kakao.getLinkStatus();
  assert.equal(st.linked, true);
  assert.equal(st.nickname, "김보종");
  assert.equal(st.expired, false);
  assert.ok(st.linkedAt, "linkedAt 기록");
  // 저장은 암호화(admin_state 평문에 원문 노출 안 됨)
  const raw = db().prepare("SELECT value FROM admin_state WHERE key='kakao_refresh_token'").get().value;
  assert.ok(!String(raw).includes("rt_abc"), "refresh token 암호화 저장");
  kakao.disconnect();
  assert.equal(kakao.isLinked(), false, "해제 후 미연동");
  assert.equal(kakao.getLinkStatus().nickname, null);
});

test("getAuthUrl: scope talk_message + redirect + state 포함", () => {
  process.env.KAKAO_REST_API_KEY = "test_key";
  delete require.cache[require.resolve("../src/config")];
  delete require.cache[require.resolve("../src/kakao")];
  const k = require("../src/kakao");
  const url = k.getAuthUrl("nonce123");
  assert.ok(url.startsWith("https://kauth.kakao.com/oauth/authorize?"));
  assert.ok(url.includes("scope=talk_message"));
  assert.ok(url.includes("response_type=code"));
  assert.ok(url.includes("state=nonce123"));
  assert.ok(url.includes("client_id=test_key"));
});

test("exchangeCode: 토큰 교환 + 프로필 닉네임 저장(fetch mock)", async () => {
  process.env.KAKAO_REST_API_KEY = "test_key";
  delete require.cache[require.resolve("../src/config")];
  delete require.cache[require.resolve("../src/kakao")];
  const k = require("../src/kakao");
  const origFetch = global.fetch;
  global.fetch = async (url) => {
    if (String(url).includes("/oauth/token")) {
      return { ok: true, json: async () => ({ access_token: "AT1", refresh_token: "RT1", expires_in: 21600 }) };
    }
    if (String(url).includes("/v2/user/me")) {
      return { ok: true, json: async () => ({ properties: { nickname: "치프엔지" } }) };
    }
    throw new Error("unexpected url " + url);
  };
  try {
    const r = await k.exchangeCode("code_abc");
    assert.equal(r.ok, true);
    assert.equal(r.nickname, "치프엔지");
    assert.equal(k.getLinkStatus().nickname, "치프엔지");
    assert.equal(k.isLinked(), true);
  } finally {
    global.fetch = origFetch;
  }
});

test("getAccessToken: 유효하면 그대로, 만료면 갱신, invalid_grant면 만료 표시", async () => {
  process.env.KAKAO_REST_API_KEY = "test_key";
  delete require.cache[require.resolve("../src/config")];
  delete require.cache[require.resolve("../src/kakao")];
  const k = require("../src/kakao");
  // 유효 토큰 저장(1시간 남음) → 갱신 안 함
  k.saveTokens({ refreshToken: "RT1", accessToken: "ATvalid", expiresInSec: 3600, nickname: "n" });
  const origFetch = global.fetch;
  let refreshCalls = 0;
  global.fetch = async () => { refreshCalls++; return { ok: true, json: async () => ({ access_token: "ATnew", expires_in: 21600 }) }; };
  try {
    assert.equal(await k.getAccessToken(), "ATvalid", "유효하면 갱신 없이 반환");
    assert.equal(refreshCalls, 0);
    // 만료로 강제 → 갱신 호출
    const { setState } = require("../src/db");
    setState("kakao_access_expires_at", new Date(Date.now() - 1000).toISOString());
    assert.equal(await k.getAccessToken(), "ATnew", "만료면 갱신 후 새 토큰");
    assert.equal(refreshCalls, 1);
    // invalid_grant → 만료 표시 + null
    setState("kakao_access_expires_at", new Date(Date.now() - 1000).toISOString());
    global.fetch = async () => ({ ok: false, status: 400, json: async () => ({ error: "invalid_grant" }) });
    assert.equal(await k.getAccessToken(), null, "갱신 실패 시 null");
    assert.equal(k.getLinkStatus().expired, true, "연동 만료 표시");
    assert.equal(k.isLinked(), false);
  } finally {
    global.fetch = origFetch;
  }
});
