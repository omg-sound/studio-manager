"use strict";

const express = require("express");
const { config } = require("../config");
const { db } = require("../db");
const {
  setSessionCookie,
  clearSessionCookie,
  upsertUserFromGoogle,
  oauthClient,
} = require("../auth");
const { saveRefreshToken } = require("../drive");
const { layout, esc } = require("../views");

const router = express.Router();

/** 로그인 화면. 전원 Google 로그인(관리자가 허용한 계정만). next=리다이렉트 대상. */
router.get("/login", (req, res) => {
  if (req.user) return res.redirect("/");
  const next = typeof req.query.next === "string" ? req.query.next : "/";
  const err = req.query.err ? `<p class="mb-4 rounded-lg bg-danger/10 px-3 py-2 text-sm text-danger">${esc(String(req.query.err))}</p>` : "";
  const googleBtn = config.googleConfigured
    ? `<a href="/auth/google?next=${encodeURIComponent(next)}" class="btn-primary w-full">Google 계정으로 로그인</a>`
    : `<p class="rounded-lg border border-border bg-bg px-3 py-2 text-center text-xs text-muted">Google OAuth 미설정 — <code>.env</code>에 자격증명 설정 후 사용</p>`;
  const devBtn = config.devLogin
    ? `<form method="post" action="/dev-login" class="mt-3 space-y-2 rounded-lg border border-warning/40 bg-warning/5 p-3">
         <p class="text-xs font-medium text-warning">개발 전용 로그인</p>
         <input type="hidden" name="next" value="${esc(next)}" />
         <button name="as" value="owner" class="btn-ghost w-full text-sm">대표로 로그인(dev)</button>
         <button name="as" value="chief" class="btn-ghost w-full text-sm">치프로 로그인(dev)</button>
         <button name="as" value="staff" class="btn-ghost w-full text-sm">스태프로 로그인(dev)</button>
       </form>`
    : "";

  const body = `
    <div class="mb-8 text-center">
      <h1 class="font-display text-3xl font-semibold">OMG Studios</h1>
      <p class="mt-2 text-sm text-muted">녹음 · 믹싱 스튜디오 관리</p>
    </div>
    <div class="card">
      ${err}
      ${googleBtn}
      <p class="mt-3 text-center text-xs text-muted">치프 엔지니어가 허용한 Google 계정만 로그인할 수 있습니다.</p>
      ${devBtn}
    </div>`;
  res.send(layout({ title: "로그인", body }));
});

router.get("/logout", (req, res) => {
  clearSessionCookie(res);
  res.redirect("/login");
});

// ── Google OAuth(관리자) ──
router.get("/auth/google", (req, res) => {
  if (!config.googleConfigured) return res.redirect("/login?err=" + encodeURIComponent("Google OAuth 미설정"));
  const next = safeNext(req.query.next);
  const client = oauthClient();
  const url = client.generateAuthUrl({
    access_type: "offline", // refresh token 수령
    prompt: "consent",
    scope: [
      "openid",
      "email",
      "profile",
      "https://www.googleapis.com/auth/drive.file", // 자료 전달 스토리지용 최소권한
      "https://www.googleapis.com/auth/calendar.readonly", // 세션 겹침 검사용 스튜디오 캘린더 읽기(FreeBusy)
    ],
    state: Buffer.from(JSON.stringify({ next })).toString("base64url"),
  });
  res.redirect(url);
});

router.get("/auth/google/callback", async (req, res) => {
  try {
    if (!config.googleConfigured) return res.redirect("/login?err=" + encodeURIComponent("Google OAuth 미설정"));
    const code = req.query.code;
    if (!code) return res.redirect("/login?err=" + encodeURIComponent("인증 코드 없음"));

    const client = oauthClient();
    const { tokens } = await client.getToken(code);
    client.setCredentials(tokens);

    // 사용자 프로필 조회
    const { google } = require("googleapis");
    const oauth2 = google.oauth2({ version: "v2", auth: client });
    const { data: profile } = await oauth2.userinfo.get();
    const email = String(profile.email || "").trim().toLowerCase();

    // 화이트리스트: 치프(ADMIN_EMAIL) 또는 관리자가 등록한 활성 사용자만 허용.
    const user = upsertUserFromGoogle({ email, name: profile.name, sub: profile.id });
    if (!user) {
      return res.redirect("/login?err=" + encodeURIComponent("로그인이 허용되지 않은 계정입니다. 치프 엔지니어에게 등록을 요청하세요."));
    }

    // refresh token이 오면 Drive 구동용으로 암호화 저장(없으면 기존 유지)
    if (tokens.refresh_token) saveRefreshToken(tokens.refresh_token);

    setSessionCookie(res, user);
    let next = "/";
    try {
      next = safeNext(JSON.parse(Buffer.from(String(req.query.state || ""), "base64url").toString()).next);
    } catch {}
    res.redirect(next);
  } catch (e) {
    console.error("[oauth callback]", e);
    res.redirect("/login?err=" + encodeURIComponent("Google 로그인 실패"));
  }
});

// ── 개발 전용 로그인(OAuth 자격증명 없이 검증) ──
router.post("/dev-login", (req, res) => {
  if (!config.devLogin) return res.status(404).send("not found");
  const as = ["owner", "chief", "staff"].includes(req.body.as) ? req.body.as : "chief";
  const user = db().prepare("SELECT * FROM users WHERE role=? AND active=1 ORDER BY id LIMIT 1").get(as);
  if (!user) {
    return res.redirect("/login?err=" + encodeURIComponent(`dev ${as} 계정이 없습니다. npm run seed 먼저 실행하세요.`));
  }
  setSessionCookie(res, user);
  res.redirect(safeNext(req.body.next));
});

/** open-redirect 방지: 내부 경로만 허용. */
function safeNext(next) {
  const v = typeof next === "string" ? next : "";
  return v.startsWith("/") && !v.startsWith("//") ? v : "/";
}

module.exports = router;
