"use strict";

// ── 전 화면 스모크(2026-07-10 CI 자동화) ──
// 실서버를 임시 DB·전용 포트로 기동해 치프 로그인 후 주요 화면이 전부 200으로 렌더되는지 확인.
// 목적: People API 리네임 사건(fail-safe catch가 TypeError를 삼켜 기능이 통째로 죽은 채 은폐)처럼
// '조용히 죽는' 회귀를 사람이 아니라 CI가 검출하게 한다. 이전엔 매번 수동 DEV_LOGIN curl이었음.
process.env.NODE_ENV = "test";
process.env.DEV_LOGIN = "1";
process.env.PORT = String(3900 + (process.pid % 500)); // 병렬 테스트 파일과 포트 충돌 회피
const { tempDbPath, cleanupDb } = require("./helpers");
process.env.DB_PATH = tempDbPath();

const test = require("node:test");
const assert = require("node:assert");

test("스모크: 치프 로그인 후 주요 화면 전부 200", async () => {
  const { db, init } = require("../src/db");
  init();
  db().prepare("INSERT INTO users (email, role, name, active) VALUES ('smoke@t.t','chief','스모크치프',1)").run();

  const server = require("../src/server");
  await new Promise((resolve) => (server.listening ? resolve() : server.once("listening", resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;

  try {
    // dev-login (CSRF 가드: same-origin 헤더 필요)
    const login = await fetch(base + "/dev-login", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", origin: base, "sec-fetch-site": "same-origin" },
      body: "as=chief",
      redirect: "manual",
    });
    assert.equal(login.status, 302, "dev-login 리다이렉트");
    const setCookies = login.headers.getSetCookie ? login.headers.getSetCookie() : [login.headers.get("set-cookie")];
    const cookie = setCookies.filter(Boolean).map((c) => String(c).split(";")[0]).join("; ");
    assert.ok(/=/.test(cookie), "세션 쿠키 발급");

    // 주요 화면(각 메뉴 + 대표 탭). 리다이렉트 없이 200이어야 한다(403/500/302=회귀).
    const pages = [
      "/", "/projects", "/projects?tab=billing", "/projects?tab=done", "/projects/new",
      "/sessions", "/sessions?view=calendar", "/sessions?view=list&stab=past",
      "/invoices", "/invoices?tab=done", "/invoices?tab=paid",
      "/clients", "/clients?group=artist", "/contacts", "/contacts/new",
      "/workers", "/revenue", "/deliverables",
      "/settings", "/settings?tab=content", "/settings?tab=people", "/settings?tab=system",
    ];
    for (const p of pages) {
      const r = await fetch(base + p, { headers: { cookie }, redirect: "manual" });
      assert.equal(r.status, 200, `${p} → ${r.status}`);
      const body = await r.text();
      assert.ok(body.length > 500, `${p} 본문 렌더(${body.length}B)`);
    }

    // 비로그인은 로그인으로 리다이렉트(인증 게이트가 살아있는지 — static 순서 회귀 감지)
    const anon = await fetch(base + "/projects", { redirect: "manual" });
    assert.equal(anon.status, 302, "비로그인 302");
  } finally {
    await new Promise((resolve) => server.close(resolve));
    cleanupDb(process.env.DB_PATH);
  }
});
