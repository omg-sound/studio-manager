"use strict";

// ── baseUrl 우선순위 회귀 잠금(2026-07-14 커스텀 도메인 erp.omgworks.kr 연결) ──
// Render는 RENDER_EXTERNAL_URL(=*.onrender.com)을 **항상** 주입하고 지울 수 없다. 그 값이 BASE_URL보다
// 우선하면 커스텀 도메인을 붙여도 앱이 만드는 모든 링크(OAuth redirect_uri·자료 전달 공개 링크·청구 알림·
// 캘린더 일정 링크)가 옛 주소로 나간다 — 조용히 틀리는 클래스라 테스트로 잠근다.
process.env.NODE_ENV = "test";
const test = require("node:test");
const assert = require("node:assert");
const path = require("path");

const CONFIG_PATH = require.resolve("../src/config");

/** env를 갈아끼우고 config를 새로 로드(모듈 캐시 무효화).
 *  '미설정'은 **빈 문자열**로 표현한다 — config가 dotenv를 부르므로 키를 지우면 로컬 `.env`의 값이 다시
 *  주입돼 테스트가 오염된다(dotenv는 이미 존재하는 키는 덮어쓰지 않으므로 ""로 두면 그대로 유지된다). */
function loadConfig(env) {
  const saved = {};
  for (const k of ["BASE_URL", "RENDER_EXTERNAL_URL", "PORT"]) {
    saved[k] = process.env[k];
    process.env[k] = env[k] === undefined ? "" : env[k];
  }
  delete require.cache[CONFIG_PATH];
  const { config } = require("../src/config");
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  delete require.cache[CONFIG_PATH]; // 다른 테스트 파일에 오염 남기지 않음
  return config;
}

test("baseUrl 우선순위: BASE_URL(명시) > RENDER_EXTERNAL_URL(자동 주입) > 로컬", () => {
  // 커스텀 도메인 시나리오 — Render가 onrender.com을 주입해도 BASE_URL이 이긴다.
  const custom = loadConfig({
    BASE_URL: "https://erp.omgworks.kr",
    RENDER_EXTERNAL_URL: "https://omg-studios-manager.onrender.com",
  });
  assert.strictEqual(custom.baseUrl, "https://erp.omgworks.kr");
  assert.strictEqual(custom.google.redirectUri, "https://erp.omgworks.kr/auth/google/callback");

  // BASE_URL 미설정(현행 Render 기본) — RENDER_EXTERNAL_URL 사용.
  const render = loadConfig({ BASE_URL: undefined, RENDER_EXTERNAL_URL: "https://omg-studios-manager.onrender.com" });
  assert.strictEqual(render.baseUrl, "https://omg-studios-manager.onrender.com");

  // 둘 다 없으면 로컬(PORT 반영).
  const local = loadConfig({ PORT: "3999" });
  assert.strictEqual(local.baseUrl, "http://localhost:3999");
});

test("baseUrl 끝 슬래시는 정규화(링크 조립 시 // 방지)", () => {
  const c = loadConfig({ BASE_URL: "https://erp.omgworks.kr/", RENDER_EXTERNAL_URL: undefined });
  assert.strictEqual(c.baseUrl, "https://erp.omgworks.kr");
  assert.strictEqual(c.google.redirectUri, "https://erp.omgworks.kr/auth/google/callback");
});
