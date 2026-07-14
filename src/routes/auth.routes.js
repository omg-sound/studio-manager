"use strict";

const crypto = require("crypto");
const express = require("express");
const { config } = require("../config");
const { db } = require("../db");
const {
  setSessionCookie,
  clearSessionCookie,
  upsertUserFromGoogle,
  oauthClient,
  touchLastLogin,
  VIEWAS_COOKIE,
  requireChief,
} = require("../auth");
const { saveRefreshToken, setDriveAccountEmail } = require("../drive");
const { layout, esc } = require("../views");

const router = express.Router();

/** 로그인 화면. 전원 Google 로그인(관리자가 허용한 계정만). next=리다이렉트 대상. */
router.get("/login", (req, res) => {
  if (req.user) return res.redirect("/");
  const next = typeof req.query.next === "string" ? req.query.next : "/";
  const err = req.query.err ? `<p class="mb-4 rounded-lg bg-danger/10 px-3 py-2 text-sm text-danger">${esc(String(req.query.err))}</p>` : "";
  const googleBtn = config.googleConfigured
    ? `<a href="/auth/google?next=${encodeURIComponent(next)}" class="btn-primary w-full">구글 계정으로 로그인</a>`
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
      <p class="mt-3 text-center text-xs text-muted">치프 엔지니어가 허용한 구글 계정만 로그인할 수 있습니다.</p>
      ${devBtn}
    </div>`;
  res.send(layout({ title: "로그인", body }));
});

router.get("/logout", (req, res) => {
  clearSessionCookie(res);
  res.clearCookie(VIEWAS_COOKIE, { path: "/" }); // 보기 모드도 해제(다음 로그인에 잔류 방지)
  res.redirect("/login");
});

// ── 보기 모드 전환(2026-07-09 사용자 요청) — 치프가 권한 변경 없이 대표/스태프 화면을 미리보는 모드.
// 실제 role=chief만 사용 가능(attachUser가 chief일 때만 쿠키를 적용하므로 상승 불가·축소 전용).
// 전환 후 대시보드로(현재 페이지가 새 모드에서 403일 수 있어 전 역할 공통 경로로 복귀).
router.post("/viewas", (req, res) => {
  const isRealChief = req.user && (req.user.role === "chief" || req.user.real_role === "chief");
  if (!isRealChief) return res.status(403).send("권한이 없습니다(치프 전용).");
  const role = String(req.body.role || "chief");
  if (role === "owner" || role === "staff") {
    res.cookie(VIEWAS_COOKIE, role, { httpOnly: true, sameSite: "lax", secure: config.isProd, maxAge: 12 * 3600 * 1000, path: "/" });
  } else {
    res.clearCookie(VIEWAS_COOKIE, { path: "/" }); // chief = 원래대로
  }
  res.redirect("/");
});

// ── Google OAuth(관리자) ──
router.get("/auth/google", (req, res) => {
  if (!config.googleConfigured) return res.redirect("/login?err=" + encodeURIComponent("Google OAuth 미설정"));
  const next = safeNext(req.query.next);
  // 자료 저장 Drive 연결(설정 버튼): 고정 스튜디오 계정을 선택하도록 계정 선택기를 강제한다.
  // (활성 Google 세션이 다른 계정이면 자동 선택돼 Drive가 안 바뀌는 것 방지 — email 불일치로 토큰 미저장.)
  const driveConnect = req.query.drive === "1";
  // 로그인 CSRF 방어: 랜덤 논스를 state + httpOnly 쿠키에 동시 저장 → 콜백에서 대조.
  const nonce = crypto.randomBytes(16).toString("hex");
  const client = oauthClient();
  const authParams = {
    access_type: "offline", // refresh token 수령
    prompt: driveConnect ? "select_account consent" : "consent", // Drive 연결 시 계정 선택기 강제
    scope: [
      "openid",
      "email",
      "profile",
      "https://www.googleapis.com/auth/drive.file", // 자료 전달 스토리지용 최소권한
      "https://www.googleapis.com/auth/calendar", // 예약 시 일정 자동 생성/수정/삭제(FreeBusy 하드차단은 다중 룸 도입으로 폐기)
      "https://www.googleapis.com/auth/contacts", // Google People API — 연락처 앱→Google push
      "https://www.googleapis.com/auth/gmail.send", // 청구 발행 알림 메일 발송(스튜디오 계정 명의, 2026-07-14)
    ],
    state: Buffer.from(JSON.stringify({ next, nonce })).toString("base64url"),
  };
  if (driveConnect) authParams.login_hint = config.studioDriveEmail; // 스튜디오 계정 프리셀렉트
  const url = client.generateAuthUrl(authParams);
  res.cookie("_oauth_nonce", nonce, {
    httpOnly: true,
    secure: config.isProd,
    sameSite: "lax",
    maxAge: 10 * 60 * 1000, // 10분 — OAuth 라운드트립 시간
    path: "/",
  });
  res.redirect(url);
});

router.get("/auth/google/callback", async (req, res) => {
  try {
    if (!config.googleConfigured) return res.redirect("/login?err=" + encodeURIComponent("Google OAuth 미설정"));
    const code = req.query.code;
    if (!code) return res.redirect("/login?err=" + encodeURIComponent("인증 코드 없음"));

    // ── CSRF 방어: state 논스 ↔ 쿠키 논스 대조(불일치 즉시 거부) ──
    let stateNext = "/";
    try {
      const stateData = JSON.parse(Buffer.from(String(req.query.state || ""), "base64url").toString());
      const cookieNonce = req.cookies && req.cookies["_oauth_nonce"];
      res.clearCookie("_oauth_nonce", { path: "/" }); // 단발 검증 후 즉시 만료
      if (!stateData.nonce || !cookieNonce || stateData.nonce !== cookieNonce) {
        return res.redirect("/login?err=" + encodeURIComponent("인증 상태 불일치(보안 오류). 다시 로그인하세요."));
      }
      stateNext = safeNext(stateData.next);
    } catch {
      return res.redirect("/login?err=" + encodeURIComponent("인증 상태 파싱 오류. 다시 로그인하세요."));
    }

    const client = oauthClient();
    const { tokens } = await client.getToken(code);
    client.setCredentials(tokens);

    // 사용자 프로필 조회
    const { google } = require("googleapis");
    const oauth2 = google.oauth2({ version: "v2", auth: client });
    const { data: profile } = await oauth2.userinfo.get();
    const email = String(profile.email || "").trim().toLowerCase();
    // 이메일 미인증 구글 계정 거부(화이트리스트 신뢰 경계 하드닝). verified_email 누락(undefined)은 호환 위해 통과.
    if (profile.verified_email === false) {
      return res.redirect("/login?err=" + encodeURIComponent("이메일이 인증되지 않은 구글 계정입니다."));
    }

    // 화이트리스트: 치프(ADMIN_EMAIL) 또는 관리자가 등록한 활성 사용자만 허용.
    const user = upsertUserFromGoogle({ email, name: profile.name, sub: profile.id });
    if (!user) {
      return res.redirect("/login?err=" + encodeURIComponent("로그인이 허용되지 않은 계정입니다. 치프 엔지니어에게 등록을 요청하세요."));
    }

    // Drive 구동용 refresh token은 **고정 스튜디오 계정(config.studioDriveEmail)으로 로그인할 때만** 저장한다.
    // 치프·대표·스태프 누구로 로그인하든, 이 계정이 아니면 Drive 토큰을 건드리지 않는다 →
    // 자료는 **항상 studio@omgworks.kr Drive 한 곳**에만 저장된다(치프가 바뀌어도 고정).
    // (이전엔 모든/치프 로그인이 덮어써서 개인 Drive로 흩어지고 폴더 중복·'파일 없음'이 생기던 근본 원인.)
    if (tokens.refresh_token && email === config.studioDriveEmail) {
      saveRefreshToken(tokens.refresh_token);
      setDriveAccountEmail(email); // 연결 계정 기록(설정에 표시)
    }

    setSessionCookie(res, user);
    touchLastLogin(user.id); // 마지막 로그인 기록(계정 위생 표시, fail-safe)
    res.redirect(stateNext);
  } catch (e) {
    console.error("[oauth callback]", e);
    res.redirect("/login?err=" + encodeURIComponent("Google 로그인 실패"));
  }
});

router.post("/dev-login", (req, res) => {
  if (!config.devLogin) return res.status(404).send("not found");
  const as = ["owner", "chief", "staff"].includes(req.body.as) ? req.body.as : "chief";
  const user = db().prepare("SELECT * FROM users WHERE role=? AND active=1 ORDER BY id LIMIT 1").get(as);
  if (!user) {
    return res.redirect("/login?err=" + encodeURIComponent(`dev ${as} 계정이 없습니다. npm run seed 먼저 실행하세요.`));
  }
  setSessionCookie(res, user);
    touchLastLogin(user.id); // 마지막 로그인 기록(계정 위생 표시, fail-safe)
  res.redirect(safeNext(req.body.next));
});

/** open-redirect 방지: 내부 절대경로만 허용. 역슬래시(\)는 브라우저가 //로 정규화해 protocol-relative 우회가 되므로 차단. */
function safeNext(next) {
  const v = typeof next === "string" ? next : "";
  return /^\/(?![/\\])/.test(v) ? v : "/";
}

module.exports = router;
