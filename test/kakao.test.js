"use strict";
process.env.NODE_ENV = "test";
const { tempDbPath, cleanupDb } = require("./helpers");
process.env.DB_PATH = tempDbPath();

const test = require("node:test");
const assert = require("node:assert");
const { db, init } = require("../src/db");
init();
const kakao = require("../src/kakao");

// baseline fetch 스텁 — disconnect의 best-effort unlink 등 개별 테스트가 모킹하지 않은 호출이
// 실제 카카오 API로 나가는 것 차단(CI 외부 네트워크 금지). 각 테스트의 origFetch 복원도 이 스텁으로 돌아온다.
global.fetch = async () => ({ ok: true, status: 200, json: async () => ({}) });

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

test("sendToMe: 미연동이면 skip, 연동이면 memo API에 텍스트 템플릿 전송", async () => {
  process.env.KAKAO_REST_API_KEY = "test_key";
  delete require.cache[require.resolve("../src/config")];
  delete require.cache[require.resolve("../src/kakao")];
  const k = require("../src/kakao");
  k.disconnect();
  assert.deepEqual(await k.sendToMe({ text: "hi" }), { ok: false, skipped: "not_linked" }, "미연동 skip");

  k.saveTokens({ refreshToken: "RT1", accessToken: "ATvalid", expiresInSec: 3600, nickname: "n" });
  const origFetch = global.fetch;
  let sent = null;
  global.fetch = async (url, init) => {
    sent = { url: String(url), body: init.body };
    return { ok: true, json: async () => ({ result_code: 0 }) };
  };
  try {
    const r = await k.sendToMe({ text: "청구 발행\nOMG-1", url: "https://x/invoices/1", buttonTitle: "청구서 보기" });
    assert.equal(r.ok, true);
    assert.ok(sent.url.includes("/v2/api/talk/memo/default/send"), "memo API 호출");
    const params = new URLSearchParams(sent.body);
    const tpl = JSON.parse(params.get("template_object"));
    assert.equal(tpl.object_type, "text");
    assert.ok(tpl.text.includes("OMG-1"));
    assert.equal(tpl.link.web_url, "https://x/invoices/1");
    assert.equal(tpl.button_title, "청구서 보기");
  } finally {
    global.fetch = origFetch;
  }
});

test("sendToMe: text 200자 초과 절단", async () => {
  process.env.KAKAO_REST_API_KEY = "test_key";
  delete require.cache[require.resolve("../src/config")];
  delete require.cache[require.resolve("../src/kakao")];
  const k = require("../src/kakao");
  k.saveTokens({ refreshToken: "RT1", accessToken: "ATvalid", expiresInSec: 3600 });
  const origFetch = global.fetch;
  let tplText = null;
  global.fetch = async (url, init) => { tplText = JSON.parse(new URLSearchParams(init.body).get("template_object")).text; return { ok: true, json: async () => ({}) }; };
  try {
    await k.sendToMe({ text: "가".repeat(300) });
    assert.ok(tplText.length <= 200, "200자 이하로 절단");
  } finally {
    global.fetch = origFetch;
  }
});

// ── 2026-07-13 전수 점검 회귀 잠금 ──────────────────────────────────────────────

const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?:^|[^\uD800-\uDBFF])[\uDC00-\uDFFF]/;
function freshKakao() {
  process.env.KAKAO_REST_API_KEY = "test_key";
  delete require.cache[require.resolve("../src/config")];
  delete require.cache[require.resolve("../src/kakao")];
  return require("../src/kakao");
}

test("exchangeCode 실패: 비200·refresh 없음 → ok:false·미연동(토큰 미저장)", async () => {
  const k = freshKakao();
  k.disconnect();
  const origFetch = global.fetch;
  global.fetch = async () => ({ ok: false, status: 400, json: async () => ({ error: "invalid_grant" }) });
  try {
    const r = await k.exchangeCode("bad_code");
    assert.equal(r.ok, false);
    assert.equal(k.isLinked(), false, "실패 시 토큰 미저장");
  } finally { global.fetch = origFetch; }
});

test("exchangeCode: 프로필 조회 실패해도 연동은 성립(닉네임 없이 저장)", async () => {
  const k = freshKakao();
  k.disconnect();
  const origFetch = global.fetch;
  global.fetch = async (url) => {
    if (String(url).includes("/oauth/token")) return { ok: true, json: async () => ({ access_token: "AT", refresh_token: "RT", expires_in: 21600, scope: "talk_message" }) };
    throw new Error("profile down");
  };
  try {
    const r = await k.exchangeCode("code");
    assert.equal(r.ok, true, "프로필 실패는 연동을 막지 않음");
    assert.equal(r.nickname, null);
    assert.equal(k.isLinked(), true);
  } finally { global.fetch = origFetch; }
});

test("exchangeCode: scope에 talk_message 없으면 연동 거부(무늬만 연동 방지)", async () => {
  const k = freshKakao();
  k.disconnect();
  const origFetch = global.fetch;
  global.fetch = async (url) => {
    if (String(url).includes("/oauth/token")) return { ok: true, json: async () => ({ access_token: "AT", refresh_token: "RT", expires_in: 21600, scope: "profile_nickname" }) };
    return { ok: true, json: async () => ({}) };
  };
  try {
    const r = await k.exchangeCode("code");
    assert.equal(r.ok, false, "메시지 동의 없으면 거부");
    assert.ok(String(r.error).includes("talk_message"), "안내에 원인 명시");
    assert.equal(k.isLinked(), false, "토큰 미저장");
  } finally { global.fetch = origFetch; }
});

test("refreshAccess single-flight: 동시 갱신 2건이 토큰 요청 1회를 공유(경합 오판 방지)", async () => {
  const k = freshKakao();
  k.disconnect();
  k.saveTokens({ refreshToken: "RT1", accessToken: "AT_OLD", expiresInSec: 21600 });
  const { setState } = require("../src/db");
  setState("kakao_access_expires_at", new Date(Date.now() - 1000).toISOString()); // 만료 강제
  const origFetch = global.fetch;
  let tokenCalls = 0;
  global.fetch = async (url) => {
    if (String(url).includes("/oauth/token")) {
      tokenCalls++;
      await new Promise((r) => setTimeout(r, 20)); // in-flight 겹침 재현
      return { ok: true, json: async () => ({ access_token: "AT_NEW", expires_in: 21600 }) };
    }
    return { ok: true, json: async () => ({}) };
  };
  try {
    const [a, b] = await Promise.all([k.getAccessToken(), k.getAccessToken()]);
    assert.equal(a, "AT_NEW");
    assert.equal(b, "AT_NEW");
    assert.equal(tokenCalls, 1, "갱신 요청은 1회만(직렬화)");
  } finally { global.fetch = origFetch; }
});

test("sendToMe 401: 캐시 토큰 폐기 → 갱신 → 1회 재전송(6시간 무음 유실 방지)", async () => {
  const k = freshKakao();
  k.disconnect();
  k.saveTokens({ refreshToken: "RT1", accessToken: "AT_DEAD", expiresInSec: 21600 });
  const origFetch = global.fetch;
  const calls = [];
  global.fetch = async (url) => {
    const u = String(url);
    calls.push(u.includes("/talk/memo") ? "memo" : u.includes("/oauth/token") ? "token" : "etc");
    if (u.includes("/talk/memo") && calls.filter((c) => c === "memo").length === 1) {
      return { ok: false, status: 401, json: async () => ({}) }; // 서버측 무효화된 토큰
    }
    if (u.includes("/oauth/token")) return { ok: true, json: async () => ({ access_token: "AT_FRESH", expires_in: 21600 }) };
    return { ok: true, status: 200, json: async () => ({}) };
  };
  try {
    const r = await k.sendToMe({ text: "청구 발행" });
    assert.equal(r.ok, true, "재시도로 성공");
    assert.deepEqual(calls, ["memo", "token", "memo"], "401 → 갱신 → 재전송 1회");
  } finally { global.fetch = origFetch; }
});

test("sendToMe: 코드포인트 절단 — 경계 이모지에서 lone surrogate 생성 금지", async () => {
  const k = freshKakao();
  k.disconnect();
  k.saveTokens({ refreshToken: "RT1", accessToken: "AT", expiresInSec: 21600 });
  const origFetch = global.fetch;
  let sentText = null;
  global.fetch = async (url, init) => {
    if (String(url).includes("/talk/memo")) sentText = JSON.parse(new URLSearchParams(init.body).get("template_object")).text;
    return { ok: true, status: 200, json: async () => ({}) };
  };
  try {
    await k.sendToMe({ text: "가".repeat(199) + "😀😀" }); // 코드유닛 203 — 옛 slice(0,200)은 😀를 반토막 냈다
    assert.ok(sentText, "발송됨");
    assert.ok(!LONE_SURROGATE.test(sentText), "서로게이트 페어가 안 깨짐");
    assert.ok([...sentText].length <= 200, "코드포인트 200 이하");
    assert.ok(sentText.endsWith("😀"), "경계 이모지가 통째로 보존/절단됨");
  } finally { global.fetch = origFetch; }
});

test("disconnect: 카카오 unlink를 best-effort 호출하고, 실패해도 로컬 키는 삭제", async () => {
  const k = freshKakao();
  k.saveTokens({ refreshToken: "RT1", accessToken: "AT_LIVE", expiresInSec: 21600, nickname: "n" });
  const origFetch = global.fetch;
  const unlinkCalls = [];
  global.fetch = async (url, init) => {
    if (String(url).includes("/v1/user/unlink")) {
      unlinkCalls.push((init && init.headers && init.headers.Authorization) || "");
      throw new Error("network down"); // 실패해도 무시돼야
    }
    return { ok: true, status: 200, json: async () => ({}) };
  };
  try {
    k.disconnect();
    await new Promise((r) => setImmediate(r)); // fire-and-forget 소진
    await new Promise((r) => setImmediate(r));
    assert.equal(unlinkCalls.length, 1, "unlink 1회 시도");
    assert.ok(unlinkCalls[0].includes("AT_LIVE"), "지우기 전 확보한 토큰으로 호출");
    assert.equal(k.isLinked(), false, "실패해도 로컬 해제는 완료");
    assert.equal(k.getLinkStatus().nickname, null);
  } finally { global.fetch = origFetch; }
});

test("getLinkStatus: 저장값은 있는데 복호화 실패(TOKEN_ENC_KEY 불일치)면 expired로 표면화", () => {
  const k = freshKakao();
  k.disconnect();
  const { setState } = require("../src/db");
  setState("kakao_refresh_token", "garbage-not-encrypted"); // 키 불일치·손상 재현
  const st = k.getLinkStatus();
  assert.equal(st.linked, false);
  assert.equal(st.expired, true, "'처음부터 미연동'으로 위장되지 않고 재연동 필요로 표시");
  k.disconnect();
});

test("keepAlive: 연동 상태면 강제 갱신 1회, 미연동이면 skip", async () => {
  const k = freshKakao();
  k.disconnect();
  assert.deepEqual(await k.keepAlive(), { ok: false, skipped: "not_linked" });
  k.saveTokens({ refreshToken: "RT1", accessToken: "AT", expiresInSec: 21600 });
  const origFetch = global.fetch;
  let tokenCalls = 0;
  global.fetch = async (url) => {
    if (String(url).includes("/oauth/token")) { tokenCalls++; return { ok: true, json: async () => ({ access_token: "AT2", expires_in: 21600 }) }; }
    return { ok: true, json: async () => ({}) };
  };
  try {
    const r = await k.keepAlive();
    assert.equal(r.ok, true);
    assert.equal(tokenCalls, 1, "액세스가 유효해도 강제 갱신(리프레시 수명 연장 목적)");
  } finally { global.fetch = origFetch; }
});

test("설정 렌더: 연동됨=닉네임·해제·테스트 노출 / 만료=재연동 경고 / 시스템 탭=경고·배지(2026-07-13 점검)", () => {
  process.env.KAKAO_REST_API_KEY = "test_key";
  delete require.cache[require.resolve("../src/config")];
  delete require.cache[require.resolve("../src/kakao")];
  delete require.cache[require.resolve("../src/views.settings")];
  const k = require("../src/kakao");
  const vs = require("../src/views.settings");
  const { setState } = require("../src/db");

  // 연동됨 상태 — smoke는 미설정 분기만 지나가므로 이 분기는 여기서 잠근다.
  k.disconnect();
  k.saveTokens({ refreshToken: "RT1", accessToken: "AT", expiresInSec: 21600, nickname: "김보종" });
  const linkedHtml = vs.kakaoAlertSection(true);
  assert.ok(linkedHtml.includes("김보종"), "수신자 닉네임 표시");
  assert.ok(linkedHtml.includes("/settings/kakao/disconnect"), "해제 폼");
  assert.ok(linkedHtml.includes("/settings/kakao/test"), "테스트 발송 폼");
  assert.ok(vs.systemTab(true).includes("카카오 알림"), "시스템 탭 연동 배지에 카카오 존재");
  assert.ok(!vs.systemWarnings().some((w) => w.includes("카카오")), "정상 연동이면 경고 없음");

  // 만료 상태 — 경고 카드·재연동 버튼.
  setState("kakao_expired", "1");
  const expiredHtml = vs.kakaoAlertSection(true);
  assert.ok(expiredHtml.includes("만료"), "만료 경고 문구");
  assert.ok(expiredHtml.includes("/auth/kakao"), "재연동 버튼");
  assert.ok(vs.systemWarnings().some((w) => w.includes("카카오")), "시스템 탭 경고에 카카오 만료 노출");
  k.disconnect();
});
