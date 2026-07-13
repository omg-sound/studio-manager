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
