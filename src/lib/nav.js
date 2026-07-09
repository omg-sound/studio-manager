"use strict";

/**
 * 내부 경로 안전 검증(open-redirect 차단) — ?return=/폼 hidden return 복귀 경로 공용(2026-07-09 감사 후 일원화).
 * 내부 절대경로만 통과: `/`로 시작하되 `//`(protocol-relative)·`/\`(브라우저가 //로 정규화) 거부.
 * 그 외(외부 URL·상대경로·비문자열)는 null. (auth.js의 safeNext는 폴백 "/" 계약이 달라 별도 유지.)
 */
function safePath(v) {
  return typeof v === "string" && /^\/(?![/\\])/.test(v) ? v : null;
}

module.exports = { safePath };
