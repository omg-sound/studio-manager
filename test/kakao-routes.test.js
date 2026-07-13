"use strict";

// ── 카카오 연동 라우트 보안 게이트 회귀 잠금(2026-07-13 전수 점검) ──
// /auth/kakao 콜백의 CSRF state·논스 대조는 신설 보안 게이트인데 어떤 테스트로도 잠겨 있지 않았다
// (이 저장소 관례: 보안 게이트는 auth.test.js류 회귀로 잠금 — viewas 상승 불가 등).
// 실서버를 기동하되 **거부 경로만** 검증해 외부(kauth/kapi) 호출이 없다 — CI 오프라인 안전.
process.env.NODE_ENV = "test";
process.env.DEV_LOGIN = "1";
process.env.KAKAO_REST_API_KEY = "route_test_key"; // config 게이트 통과(연동 버튼·인가 URL 생성)
process.env.PORT = String(3400 + (process.pid % 500)); // 병렬 테스트 파일과 포트 충돌 회피(smoke는 3900대)
const { tempDbPath, cleanupDb } = require("./helpers");
process.env.DB_PATH = tempDbPath();

const test = require("node:test");
const assert = require("node:assert");

test("카카오 라우트: CSRF 논스·취소·코드누락·권한 게이트", async () => {
  const { db, init } = require("../src/db");
  init();
  db().prepare("INSERT INTO users (email, role, name, active) VALUES ('kr-chief@t.t','chief','치프',1)").run();
  db().prepare("INSERT INTO users (email, role, name, active) VALUES ('kr-staff@t.t','staff','스태프',1)").run();

  const server = require("../src/server");
  await new Promise((resolve) => (server.listening ? resolve() : server.once("listening", resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;

  const loginAs = async (role) => {
    const login = await fetch(base + "/dev-login", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", origin: base, "sec-fetch-site": "same-origin" },
      body: "as=" + role,
      redirect: "manual",
    });
    assert.equal(login.status, 302, `dev-login(${role})`);
    const setCookies = login.headers.getSetCookie ? login.headers.getSetCookie() : [login.headers.get("set-cookie")];
    return setCookies.filter(Boolean).map((c) => String(c).split(";")[0]).join("; ");
  };
  const locOf = (res) => String(res.headers.get("location") || "");

  try {
    const chief = await loginAs("chief");

    // ① 인가 시작: kauth로 302 + _kakao_nonce httpOnly 쿠키 발급(아웃바운드 호출 없음 — Location만 생성).
    const start = await fetch(base + "/auth/kakao", { headers: { cookie: chief }, redirect: "manual" });
    assert.equal(start.status, 302, "인가 시작 302");
    assert.ok(locOf(start).startsWith("https://kauth.kakao.com/oauth/authorize?"), "kauth 인가 URL");
    const startCookies = start.headers.getSetCookie ? start.headers.getSetCookie() : [start.headers.get("set-cookie")];
    const nonceCookie = startCookies.filter(Boolean).map(String).find((c) => c.startsWith("_kakao_nonce="));
    assert.ok(nonceCookie, "_kakao_nonce 쿠키 발급");
    assert.ok(/httponly/i.test(nonceCookie), "httpOnly 논스");
    const nonce = nonceCookie.split(";")[0].split("=")[1];
    assert.ok(locOf(start).includes(`state=${nonce}`), "state=쿠키 논스 일치");

    // ② 콜백 CSRF: state 불일치 → 검증 실패(교환 시도 없음 — '연동에 실패' 아님).
    const bad = await fetch(base + `/auth/kakao/callback?state=WRONG&code=x`, {
      headers: { cookie: `${chief}; _kakao_nonce=${nonce}` }, redirect: "manual",
    });
    assert.equal(bad.status, 302);
    assert.ok(decodeURIComponent(locOf(bad)).includes("검증에 실패"), "state 불일치 거부");
    assert.ok(locOf(bad).includes("notice_warn=1"), "경고 톤");

    // ③ 콜백 CSRF: 논스 쿠키 부재 → 거부.
    const noCookie = await fetch(base + `/auth/kakao/callback?state=${nonce}&code=x`, {
      headers: { cookie: chief }, redirect: "manual",
    });
    assert.ok(decodeURIComponent(locOf(noCookie)).includes("검증에 실패"), "쿠키 논스 부재 거부");

    // ④ 동의 화면 취소: error=access_denied → 중립 안내(원시 토큰 에러 노출 금지·경고 톤 아님).
    const denied = await fetch(base + `/auth/kakao/callback?error=access_denied&state=${nonce}`, {
      headers: { cookie: `${chief}; _kakao_nonce=${nonce}` }, redirect: "manual",
    });
    assert.ok(decodeURIComponent(locOf(denied)).includes("취소했습니다"), "취소 안내");
    assert.ok(!locOf(denied).includes("notice_warn"), "취소는 경고 아님");

    // ⑤ 논스는 통과했지만 code 누락 → 교환 발사 없이 안내.
    const start2 = await fetch(base + "/auth/kakao", { headers: { cookie: chief }, redirect: "manual" });
    const nonce2 = (start2.headers.getSetCookie ? start2.headers.getSetCookie() : [start2.headers.get("set-cookie")])
      .filter(Boolean).map(String).find((c) => c.startsWith("_kakao_nonce=")).split(";")[0].split("=")[1];
    const noCode = await fetch(base + `/auth/kakao/callback?state=${nonce2}`, {
      headers: { cookie: `${chief}; _kakao_nonce=${nonce2}` }, redirect: "manual",
    });
    assert.ok(decodeURIComponent(locOf(noCode)).includes("인가 코드"), "code 누락 안내");

    // ⑥ 권한: 스태프는 인가 시작·해제·테스트 발송 전부 차단(외부 발송 채널 — 치프 전용).
    const staff = await loginAs("staff");
    const g1 = await fetch(base + "/auth/kakao", { headers: { cookie: staff }, redirect: "manual" });
    assert.equal(g1.status, 403, "스태프 /auth/kakao 차단");
    for (const p of ["/settings/kakao/disconnect", "/settings/kakao/test"]) {
      const r = await fetch(base + p, {
        method: "POST",
        headers: { cookie: staff, origin: base, "sec-fetch-site": "same-origin" },
        redirect: "manual",
      });
      assert.equal(r.status, 403, `스태프 ${p} 차단`);
    }
  } finally {
    await new Promise((resolve) => server.close(resolve));
    cleanupDb(process.env.DB_PATH, db());
  }
});
