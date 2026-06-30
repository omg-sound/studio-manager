"use strict";

/**
 * 한국식 성명 분리(순수 함수, DB 비의존 — data.js·db.js 공용).
 * 공백 있으면 첫 토큰=성·나머지=이름, 없으면 첫 글자=성·나머지=이름. 복성은 사용자가 보강.
 * @param {string} full 표시명(예: "김준상", "김 보종")
 * @returns {{ family: string, given: string }}
 */
function splitKoreanName(full) {
  const s = String(full || "").trim();
  if (!s) return { family: "", given: "" };
  if (s.includes(" ")) {
    const [f, ...rest] = s.split(/\s+/);
    return { family: f, given: rest.join(" ").trim() };
  }
  if (s.length >= 2) return { family: s.slice(0, 1), given: s.slice(1) };
  return { family: s, given: "" };
}

module.exports = { splitKoreanName };
