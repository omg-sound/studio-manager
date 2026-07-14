"use strict";

// ── 청구 알림 이메일 설정 라우트(2026-07-14) ──
// 실서버 기동 후 **거부 경로 + 저장 경로**만 검증(외부 발송 없음 — /test 라우트는 호출하지 않는다).
process.env.NODE_ENV = "test";
process.env.DEV_LOGIN = "1";
process.env.PORT = String(3500 + (process.pid % 300)); // 다른 서버 테스트(3400·3900대)와 포트 충돌 회피
const { tempDbPath, cleanupDb } = require("./helpers");
process.env.DB_PATH = tempDbPath();

const test = require("node:test");
const assert = require("node:assert");

test("청구 알림 이메일: 치프만 저장, 형식 검증, 렌더", async () => {
  const { db, init } = require("../src/db");
  init();
  db().prepare("INSERT INTO users (email, role, name, active) VALUES ('se-chief@t.t','chief','치프',1)").run();
  db().prepare("INSERT INTO users (email, role, name, active) VALUES ('se-staff@t.t','staff','스태프',1)").run();

  const server = require("../src/server");
  await new Promise((r) => (server.listening ? r() : server.once("listening", r)));
  const base = `http://127.0.0.1:${server.address().port}`;
  const mailer = require("../src/mailer");

  const loginAs = async (role) => {
    const res = await fetch(base + "/dev-login", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", origin: base, "sec-fetch-site": "same-origin" },
      body: "as=" + role,
      redirect: "manual",
    });
    const cookies = res.headers.getSetCookie ? res.headers.getSetCookie() : [res.headers.get("set-cookie")];
    return cookies.filter(Boolean).map((c) => String(c).split(";")[0]).join("; ");
  };
  const post = (cookie, path, body) =>
    fetch(base + path, {
      method: "POST",
      headers: { cookie, "content-type": "application/x-www-form-urlencoded", origin: base, "sec-fetch-site": "same-origin" },
      body,
      redirect: "manual",
    });

  try {
    const chief = await loginAs("chief");
    const staff = await loginAs("staff");

    // ① 스태프는 저장·테스트 발송 모두 차단(외부로 나가는 알림 채널 = 치프 전용).
    for (const p of ["/settings/alert-email", "/settings/alert-email/test"]) {
      const r = await post(staff, p, "alert_email=x@y.z");
      assert.strictEqual(r.status, 403, `스태프 ${p} 차단`);
    }

    // ② 형식이 잘못된 주소는 저장 거부(경고 notice) — 기존 값 보존.
    const bad = await post(chief, "/settings/alert-email", "alert_email=" + encodeURIComponent("owner@omgworks.kr, 이상한주소"));
    assert.strictEqual(bad.status, 302);
    const loc = decodeURIComponent(String(bad.headers.get("location")));
    assert.match(loc, /형식이 올바르지 않습니다/);
    assert.match(loc, /notice_warn=1/);
    assert.deepStrictEqual(mailer.getRecipients(), [], "거부 시 저장 안 됨");

    // ③ 정상 저장 → 화면에 수신자 렌더.
    const ok = await post(chief, "/settings/alert-email", "alert_email=" + encodeURIComponent("owner@omgworks.kr, Chief@omgworks.kr"));
    assert.strictEqual(ok.status, 302);
    assert.deepStrictEqual(mailer.getRecipients(), ["owner@omgworks.kr", "chief@omgworks.kr"]);

    const page = await fetch(base + "/settings?tab=settings", { headers: { cookie: chief } });
    const html = await page.text();
    assert.match(html, /청구 알림 이메일/);
    assert.match(html, /owner@omgworks\.kr, chief@omgworks\.kr/);
    assert.match(html, /\/settings\/alert-email\/test/, "수신자 있으면 테스트 버튼 노출");

    // ④ 비우면 알림 끔 + 시스템 탭 경고.
    await post(chief, "/settings/alert-email", "alert_email=");
    assert.deepStrictEqual(mailer.getRecipients(), []);
    const sys = await (await fetch(base + "/settings?tab=system", { headers: { cookie: chief } })).text();
    assert.match(sys, /청구 알림 이메일 수신 주소가 없습니다/, "미설정은 시스템 탭 경고");
  } finally {
    await new Promise((r) => server.close(r));
    cleanupDb(process.env.DB_PATH, db());
  }
});
