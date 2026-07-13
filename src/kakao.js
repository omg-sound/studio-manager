"use strict";

/**
 * 카카오톡 "나에게 보내기" 연동 — 청구 발행 알림 채널(대표가 슬랙·디스코드 미사용).
 * drive.js/calendar.js와 같은 격의 독립 연동 모듈. 토큰은 admin_state에 AES-256-GCM 암호화 저장.
 *
 * 설계 원칙:
 *  - fail-safe: 발송·갱신은 절대 throw하지 않는다(청구 생성·cron 비차단). 오류는 console.warn 흡수.
 *  - 수신자 = 앱을 카카오로 인증한 그 계정 본인(스튜디오 전체 1개, send-to-me 제약).
 *  - 토큰 자동 갱신(액세스 ~6h·리프레시 ~2개월), 갱신 실패 시 연동 만료 표시.
 */

const { getState, setState, encrypt, decrypt } = require("./db");
const { config } = require("./config");

const K_REFRESH = "kakao_refresh_token";       // 암호화
const K_ACCESS = "kakao_access_token";         // 암호화
const K_EXPIRES = "kakao_access_expires_at";   // ISO(평문)
const K_NICKNAME = "kakao_nickname";           // 평문(표시용)
const K_LINKED_AT = "kakao_linked_at";         // ISO(평문)
const K_EXPIRED = "kakao_expired";             // "1"이면 연동 만료(재연동 필요)

const AUTH_BASE = "https://kauth.kakao.com";
const API_BASE = "https://kapi.kakao.com";

const EXPIRY_MARGIN_MS = 5 * 60 * 1000; // 만료 5분 전이면 미리 갱신

/** 카카오 인가 URL — scope talk_message(나에게 보내기). state=CSRF 논스. */
function getAuthUrl(state) {
  const p = new URLSearchParams({
    client_id: config.kakao.restApiKey,
    redirect_uri: config.kakao.redirectUri,
    response_type: "code",
    scope: "talk_message",
    state: String(state || ""),
  });
  return `${AUTH_BASE}/oauth/authorize?${p.toString()}`;
}

/** 인가 코드 → 토큰 교환 + 프로필 닉네임 조회 + 저장. fail-safe(throw 없음). */
async function exchangeCode(code) {
  try {
    const body = new URLSearchParams({
      grant_type: "authorization_code",
      client_id: config.kakao.restApiKey,
      redirect_uri: config.kakao.redirectUri,
      code: String(code || ""),
    });
    if (config.kakao.clientSecret) body.append("client_secret", config.kakao.clientSecret);
    const tokRes = await fetch(`${AUTH_BASE}/oauth/token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: body.toString(),
      signal: AbortSignal.timeout(8000),
    });
    const tok = await tokRes.json();
    if (!tokRes.ok || !tok.refresh_token) {
      return { ok: false, error: `token ${tokRes.status} ${tok.error || ""}` };
    }
    // 프로필(닉네임) — 표시용. 실패해도 연동은 성립(닉네임 없이 저장).
    let nickname = null;
    try {
      const meRes = await fetch(`${API_BASE}/v2/user/me`, {
        method: "GET",
        headers: { Authorization: `Bearer ${tok.access_token}` },
        signal: AbortSignal.timeout(8000),
      });
      const me = await meRes.json();
      nickname = (me && me.properties && me.properties.nickname) || null;
    } catch (_e) { /* 닉네임 없이 진행 */ }
    saveTokens({ refreshToken: tok.refresh_token, accessToken: tok.access_token, expiresInSec: tok.expires_in, nickname });
    return { ok: true, nickname };
  } catch (e) {
    console.warn("[kakao] exchangeCode 실패:", e && e.message ? e.message : String(e));
    return { ok: false, error: e && e.message ? e.message : String(e) };
  }
}

/** 토큰·프로필 저장(연동/갱신 공통). expiresInSec 기준으로 만료 시각 계산. */
function saveTokens({ refreshToken, accessToken, expiresInSec, nickname } = {}) {
  if (refreshToken) setState(K_REFRESH, encrypt(refreshToken)); // 카카오는 회전 시에만 새 refresh 발급 → 있을 때만 갱신
  if (accessToken) setState(K_ACCESS, encrypt(accessToken));
  if (expiresInSec) setState(K_EXPIRES, new Date(Date.now() + Number(expiresInSec) * 1000).toISOString());
  if (nickname != null) setState(K_NICKNAME, String(nickname));
  if (!getState(K_LINKED_AT)) setState(K_LINKED_AT, new Date().toISOString());
  setState(K_EXPIRED, null); // 성공 저장 = 만료 해제
}

function getRefreshToken() { return decrypt(getState(K_REFRESH)); }

function isLinked() {
  return Boolean(getRefreshToken()) && getState(K_EXPIRED) !== "1";
}

function getLinkStatus() {
  return {
    configured: config.kakaoConfigured,
    linked: isLinked(),
    nickname: getState(K_NICKNAME) || null,
    linkedAt: getState(K_LINKED_AT) || null,
    expired: getState(K_EXPIRED) === "1",
  };
}

/** 연동 해제 — 저장 키 전부 삭제(카카오 unlink API는 Task에서 best-effort로 추가). */
function disconnect() {
  [K_REFRESH, K_ACCESS, K_EXPIRES, K_NICKNAME, K_LINKED_AT, K_EXPIRED].forEach((k) => setState(k, null));
}

function accessValid() {
  const at = decrypt(getState(K_ACCESS));
  const exp = getState(K_EXPIRES);
  if (!at || !exp) return null;
  return Date.parse(exp) - Date.now() > EXPIRY_MARGIN_MS ? at : null;
}

/** 리프레시 토큰으로 액세스 토큰 갱신. 성공 시 저장, 실패 시 만료 표시. 반환=새 토큰 또는 null. */
async function refreshAccess() {
  const refresh = getRefreshToken();
  if (!refresh) return null;
  try {
    const body = new URLSearchParams({
      grant_type: "refresh_token",
      client_id: config.kakao.restApiKey,
      refresh_token: refresh,
    });
    if (config.kakao.clientSecret) body.append("client_secret", config.kakao.clientSecret);
    const res = await fetch(`${AUTH_BASE}/oauth/token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: body.toString(),
      signal: AbortSignal.timeout(8000),
    });
    const tok = await res.json();
    if (!res.ok || !tok.access_token) {
      // invalid_grant = 사용자 해제 or 리프레시 만료 → 재연동 필요
      if (tok && tok.error === "invalid_grant") setState(K_EXPIRED, "1");
      console.warn("[kakao] 토큰 갱신 실패:", res.status, tok && tok.error);
      return null;
    }
    // 카카오는 리프레시 토큰이 1개월 미만 남았을 때만 새 refresh_token 발급 → 있을 때만 교체.
    saveTokens({ refreshToken: tok.refresh_token, accessToken: tok.access_token, expiresInSec: tok.expires_in });
    return tok.access_token;
  } catch (e) {
    console.warn("[kakao] 토큰 갱신 예외:", e && e.message ? e.message : String(e));
    return null;
  }
}

/** 유효 액세스 토큰 반환(만료면 자동 갱신). 미연동·갱신 실패면 null. */
async function getAccessToken() {
  if (!isLinked()) return null;
  return accessValid() || (await refreshAccess());
}

/** cron용 keep-alive 강제 갱신 — 청구가 오래 없어도 리프레시 토큰을 2개월 안에 계속 연장. */
async function keepAlive() {
  if (!isLinked()) return { ok: false, skipped: "not_linked" };
  const at = await refreshAccess();
  return { ok: Boolean(at) };
}

module.exports = {
  getAuthUrl,
  exchangeCode,
  saveTokens,
  getLinkStatus,
  isLinked,
  disconnect,
  getAccessToken,
  keepAlive,
  // 내부 상수(테스트·후속 태스크에서 참조)
  _keys: { K_REFRESH, K_ACCESS, K_EXPIRES, K_NICKNAME, K_LINKED_AT, K_EXPIRED },
};
