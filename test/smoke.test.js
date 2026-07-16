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
      "/invoices", "/invoices?filter=done", "/invoices?filter=paid", "/invoices?filter=todo",
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

    // ── 치프 쓰기 경로(계정 관리·알림 설정) ──
    // 화면 GET만 보는 스모크로는 '라우트 안에서 참조하는 함수가 사라진' 류의 회귀가 안 잡힌다
    // (실제로 카카오 제거 커밋이 인접한 ensureContactForHouseUser 정의를 함께 지워 계정 추가·역할 변경이 500).
    // 관리 메뉴의 쓰기 액션을 실제로 POST해 302(성공 리다이렉트)인지 확인한다.
    const post = (path, body, cookie) =>
      fetch(base + path, {
        method: "POST",
        headers: {
          cookie,
          "content-type": "application/x-www-form-urlencoded",
          origin: base,
          "sec-fetch-site": "same-origin",
        },
        body,
        redirect: "manual",
      });

    const addUser = await post("/settings/users", "email=smoke-new@t.t&user_name=신규스태프&role=staff", chiefCookie);
    assert.equal(addUser.status, 302, `계정 추가 → ${addUser.status}(302 기대)`);
    const added = db().prepare("SELECT id FROM users WHERE email = 'smoke-new@t.t'").get();
    assert.ok(added, "계정 추가 반영");

    const roleChange = await post(`/settings/users/${added.id}/role`, "role=chief", chiefCookie);
    assert.equal(roleChange.status, 302, `역할 변경 → ${roleChange.status}(302 기대)`);
    assert.equal(db().prepare("SELECT role FROM users WHERE id = ?").get(added.id).role, "chief", "역할 변경 반영");

    const alertEmail = await post("/settings/alert-email", "alert_email=" + encodeURIComponent("boss@t.t"), chiefCookie);
    assert.equal(alertEmail.status, 302, `청구 알림 수신 주소 저장 → ${alertEmail.status}(302 기대)`);

    // ── 업체 이름 중복 재사용 분기: 기존 데이터 보존(2026-07-15 점검 — 파괴적 갱신 2건 잠금) ──
    // 간이 모달 페이로드(담당자 필드 없음)로 같은 이름을 재등록해도 ①기존 담당자 지정(is_contact)이 해제되지 않고
    // ②기존 공동대표가 교체 대신 병합돼야 한다(설계 원칙 '빈 칸만 채운다').
    {
      const D = require("../src/data");
      await post("/clients", "type=company&party_name=" + encodeURIComponent("보존테스트사") + "&contact_name=" + encodeURIComponent("담당김") + "&contact_id=&owner_name=" + encodeURIComponent("대표甲") + "&owner_id=", chiefCookie);
      await post("/clients", "type=company&name=" + encodeURIComponent("보존테스트사") + "&roles=" + encodeURIComponent("제작사") + "&owner_name=" + encodeURIComponent("대표乙") + "&owner_id=", chiefCookie);
      const cos = db().prepare("SELECT id FROM parties WHERE kind='company' AND name='보존테스트사'").all();
      assert.equal(cos.length, 1, "같은 이름 재등록 = 기존 재사용(중복 미생성)");
      assert.deepEqual(D.listOrgContacts(cos[0].id).map((c) => c.name), ["담당김"], "재등록해도 기존 담당자 지정 유지");
      assert.deepEqual(D.listCompanyOwners(cos[0].id).map((o) => o.name).sort(), ["대표甲", "대표乙"].sort(), "공동대표는 교체가 아니라 병합");
    }

    // 비로그인은 로그인으로 리다이렉트(인증 게이트가 살아있는지 — static 순서 회귀 감지)
    const anon = await fetch(base + "/projects", { redirect: "manual" });
    assert.equal(anon.status, 302, "비로그인 302");
  } finally {
    await new Promise((resolve) => server.close(resolve));
    cleanupDb(process.env.DB_PATH);
  }
});
