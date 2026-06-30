"use strict";

const jwt = require("jsonwebtoken");
const { config } = require("./config");
const { db } = require("./db");

// 인증 = 전원 Google 화이트리스트 로그인. 비밀번호(scrypt) 계정은 폐기됨.

// ── 세션 = httpOnly 서명 JWT 쿠키(30일) ──

/** user → 서명된 JWT(클레임은 최소: id/role/email). */
function signToken(user) {
  return jwt.sign(
    { uid: user.id, role: user.role, email: user.email },
    config.sessionSecret,
    { expiresIn: "30d" }
  );
}

function setSessionCookie(res, user) {
  res.cookie(config.cookieName, signToken(user), {
    httpOnly: true,
    secure: config.isProd, // 프로덕션은 HTTPS 전용
    sameSite: "lax",
    maxAge: config.sessionMaxAgeMs,
    path: "/",
  });
}

function clearSessionCookie(res) {
  res.clearCookie(config.cookieName, { path: "/" });
}

// ── 사용자 조회/생성 ──

function findUserById(id) {
  return db().prepare("SELECT * FROM users WHERE id = ?").get(id);
}
function findUserByEmail(email) {
  return db()
    .prepare("SELECT * FROM users WHERE email = ?")
    .get(String(email || "").trim().toLowerCase());
}

/**
 * Google 로그인 화이트리스트 처리.
 * - ADMIN_EMAIL과 일치하면 부트스트랩 치프(admin)로 보장(없으면 생성).
 * - 그 외에는 관리자가 미리 등록한 활성 사용자(users 행)만 로그인 허용 — 등록된 role 그대로.
 * - 화이트리스트에 없거나 비활성이면 null(로그인 거부).
 * @returns {object|null} 로그인 허용 시 user, 아니면 null
 */
function upsertUserFromGoogle(profile) {
  const email = String(profile.email || "").trim().toLowerCase();
  if (!email) return null;
  const isBootstrapAdmin = Boolean(config.adminEmail) && email === config.adminEmail;
  const existing = findUserByEmail(email);

  if (existing) {
    if (!existing.active && !isBootstrapAdmin) return null; // 비활성 차단
    // ADMIN_EMAIL이라도 기존 역할 존중(스태프·대표로 강등 가능). 단 활성 치프가 0이면 락아웃 방지로 chief 복구.
    let role = existing.role;
    if (isBootstrapAdmin && existing.role !== "chief") {
      const otherChiefs = db().prepare("SELECT COUNT(*) AS n FROM users WHERE role = 'chief' AND active = 1 AND id != ?").get(existing.id).n;
      if (otherChiefs === 0) role = "chief";
    }
    db()
      .prepare("UPDATE users SET name=?, google_sub=?, role=?, active=1 WHERE id=?")
      .run(profile.name || existing.name || "", profile.sub || existing.google_sub || null, role, existing.id);
    const u = findUserById(existing.id);
    syncUserToManager(u); // 로그인 시 하우스 엔지니어 이름을 작업 담당자로 동기화
    return u;
  }

  // 신규: 부트스트랩 치프만 자동 생성, 그 외 미등록 이메일은 거부.
  if (!isBootstrapAdmin) return null;
  const info = db()
    .prepare("INSERT INTO users (email, role, name, google_sub, active) VALUES (?, 'chief', ?, ?, 1)")
    .run(email, profile.name || "", profile.sub || null);
  const u = findUserById(info.lastInsertRowid);
  syncUserToManager(u);
  return u;
}

/**
 * 하우스 엔지니어(로그인 사용자) → 작업 담당자(project_managers) 자동 동기화.
 * 활성 + 이름 있으면 링크 담당자 행 upsert(이름·이메일·활성), 비활성/이름없음이면 링크 담당자 비활성.
 * 외주 작업자(user_id=null)는 건드리지 않는다.
 */
function syncUserToManager(user) {
  if (!user || !user.id) return;
  const name = String(user.name || "").trim();
  const existing = db().prepare("SELECT * FROM project_managers WHERE user_id = ?").get(user.id);
  if (!name || !user.active) {
    if (existing) db().prepare("UPDATE project_managers SET active = 0 WHERE id = ?").run(existing.id);
    return;
  }
  if (existing) {
    db().prepare("UPDATE project_managers SET name = ?, email = ?, active = 1 WHERE id = ?").run(name, user.email || null, existing.id);
  } else {
    db().prepare("INSERT INTO project_managers (name, email, active, user_id) VALUES (?, ?, 1, ?)").run(name, user.email || null, user.id);
  }
}

// ── 미들웨어 ──

/** 쿠키 검증 → req.user 채움(없으면 null). 비활성 계정은 차단. 라우트를 막지는 않음. */
function attachUser(req, _res, next) {
  req.user = null;
  const token = req.cookies && req.cookies[config.cookieName];
  if (token) {
    try {
      const payload = jwt.verify(token, config.sessionSecret);
      const user = findUserById(payload.uid);
      // 활성 + 유효 역할(owner/chief/staff)만 세션 인정. 비활성화/역할 박탈 시 즉시 로그아웃 효과.
      if (user && user.active && isLoggedInRole(user)) req.user = user;
    } catch {
      /* 만료/위조 토큰은 무시 */
    }
  }
  next();
}

// ── 권한 술어(역할 3단계) ──
function isOwner(user) {
  return Boolean(user) && user.role === "owner";
}
function isChief(user) {
  return Boolean(user) && user.role === "chief";
}
function isStaffRole(user) {
  return Boolean(user) && user.role === "staff";
}
/** 로그인 가능한 내부 역할(owner/chief/staff). */
function isLoggedInRole(user) {
  return isOwner(user) || isChief(user) || isStaffRole(user);
}
/** 프로젝트·항목·작업·자료 편집 권한(치프/스태프). 대표는 열람만. */
function canEdit(user) {
  return isChief(user) || isStaffRole(user);
}
/** 청구(발행·입금·매출) 권한(치프/대표). 스태프는 제외. */
function canInvoice(user) {
  return isChief(user) || isOwner(user);
}

/** 로그인 필수. 아니면 로그인 페이지로(브라우저) 또는 401(API). */
function requireAuth(req, res, next) {
  if (req.user) return next();
  if (req.path && req.path.startsWith("/api")) return res.status(401).json({ error: "unauthorized" });
  if (req.accepts("html")) return res.redirect("/login?next=" + encodeURIComponent(req.originalUrl));
  return res.status(401).json({ error: "unauthorized" });
}

/** 권한 게이트 공통 처리: 미로그인=401/로그인 리다이렉트, 권한부족=403. */
function gate(predicate, denyMessage) {
  return function (req, res, next) {
    if (req.user && predicate(req.user)) return next();
    if (!req.user) {
      if (req.path && req.path.startsWith("/api")) return res.status(401).json({ error: "unauthorized" });
      if (req.accepts("html")) return res.redirect("/login?next=" + encodeURIComponent(req.originalUrl));
      return res.status(401).json({ error: "unauthorized" });
    }
    if (req.path && req.path.startsWith("/api")) return res.status(403).json({ error: "forbidden" });
    if (req.accepts("html")) return res.status(403).send(denyMessage);
    return res.status(403).json({ error: "forbidden" });
  };
}

/** 치프/스태프 — 프로젝트·항목·작업·자료 편집(대표 열람전용 차단). */
const requireEditor = gate(canEdit, "권한이 없습니다(편집 권한 필요).");
/** 치프 전용 — 스태프·담당자·클라이언트·설정 관리. */
const requireChief = gate(isChief, "권한이 없습니다(치프 엔지니어 전용).");
/** 치프/대표 — 청구(발행·입금·매출). */
const requireInvoice = gate(canInvoice, "권한이 없습니다(청구 권한 필요).");

// ── Google OAuth2 클라이언트 ──
function oauthClient() {
  const { google } = require("googleapis");
  return new google.auth.OAuth2(
    config.google.clientId,
    config.google.clientSecret,
    config.google.redirectUri
  );
}

module.exports = {
  signToken,
  setSessionCookie,
  clearSessionCookie,
  findUserById,
  findUserByEmail,
  upsertUserFromGoogle,
  syncUserToManager,
  attachUser,
  isOwner,
  isChief,
  isStaffRole,
  isLoggedInRole,
  canEdit,
  canInvoice,
  requireAuth,
  requireEditor,
  requireChief,
  requireInvoice,
  oauthClient,
};
