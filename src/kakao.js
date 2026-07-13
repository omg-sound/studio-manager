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

module.exports = {
  saveTokens,
  getLinkStatus,
  isLinked,
  disconnect,
  // 내부 상수(테스트·후속 태스크에서 참조)
  _keys: { K_REFRESH, K_ACCESS, K_EXPIRES, K_NICKNAME, K_LINKED_AT, K_EXPIRED },
};
