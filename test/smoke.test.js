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

test("스모크: 치프 로그인 후 주요 화면 전부 200 + 역할별 권한 배선 매트릭스", async () => {
  const { db, init } = require("../src/db");
  init();
  // 3역할 유저 시드(dev-login은 해당 역할의 활성 유저가 있어야 로그인됨).
  db().prepare("INSERT INTO users (email, role, name, active) VALUES ('smoke-chief@t.t','chief','스모크치프',1)").run();
  db().prepare("INSERT INTO users (email, role, name, active) VALUES ('smoke-owner@t.t','owner','스모크대표',1)").run();
  db().prepare("INSERT INTO users (email, role, name, active) VALUES ('smoke-staff@t.t','staff','스모크스태프',1)").run();

  const server = require("../src/server");
  await new Promise((resolve) => (server.listening ? resolve() : server.once("listening", resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;

  // dev-login(CSRF 가드: same-origin 헤더 필요) → 세션 쿠키 반환.
  const loginAs = async (role) => {
    const login = await fetch(base + "/dev-login", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", origin: base, "sec-fetch-site": "same-origin" },
      body: "as=" + role,
      redirect: "manual",
    });
    assert.equal(login.status, 302, `dev-login(${role}) 리다이렉트`);
    const setCookies = login.headers.getSetCookie ? login.headers.getSetCookie() : [login.headers.get("set-cookie")];
    const cookie = setCookies.filter(Boolean).map((c) => String(c).split(";")[0]).join("; ");
    assert.ok(/=/.test(cookie), `${role} 세션 쿠키 발급`);
    return cookie;
  };

  try {
    const chiefCookie = await loginAs("chief");

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
      const r = await fetch(base + p, { headers: { cookie: chiefCookie }, redirect: "manual" });
      assert.equal(r.status, 200, `${p} → ${r.status}`);
      const body = await r.text();
      assert.ok(body.length > 500, `${p} 본문 렌더(${body.length}B)`);
    }

    // ── 역할별 권한 배선 매트릭스 ──
    // 라우트↔미들웨어 배선 드리프트는 실제 발생 이력이 있음(/workers 권한 문서-코드 불일치). 스모크(치프만)로는
    // 잡히지 않아 owner/staff로도 "차단돼야 할 경로 403·보여야 할 경로 200"을 기계 검증한다(정보 노출 회귀 잠금).
    //  - /revenue·/workers = requireInvoice(치프·대표) → owner 200 / staff 403
    //  - /settings·/deliverables = requireStaff(치프·스태프) → owner 403 / staff 200
    const matrix = [
      { role: "owner", allow: ["/revenue", "/workers", "/projects", "/clients"], deny: ["/settings", "/deliverables"] },
      { role: "staff", allow: ["/settings", "/deliverables", "/projects", "/clients"], deny: ["/revenue", "/workers"] },
    ];
    for (const { role, allow, deny } of matrix) {
      const cookie = await loginAs(role);
      for (const p of allow) {
        const r = await fetch(base + p, { headers: { cookie }, redirect: "manual" });
        assert.equal(r.status, 200, `${role} 허용 ${p} → ${r.status}(200 기대)`);
      }
      for (const p of deny) {
        const r = await fetch(base + p, { headers: { cookie }, redirect: "manual" });
        assert.equal(r.status, 403, `${role} 차단 ${p} → ${r.status}(403 기대)`);
      }
    }

    // 비로그인은 로그인으로 리다이렉트(인증 게이트가 살아있는지 — static 순서 회귀 감지)
    const anon = await fetch(base + "/projects", { redirect: "manual" });
    assert.equal(anon.status, 302, "비로그인 302");
  } finally {
    await new Promise((resolve) => server.close(resolve));
    cleanupDb(process.env.DB_PATH);
  }
});
