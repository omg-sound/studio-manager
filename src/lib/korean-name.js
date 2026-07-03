"use strict";

// 표시명 말미에 붙는 호칭·직함 — 성·이름 분리 시 이름으로 오인되지 않게 제거.
// resolveContactName이 만든 "김보종 대표님" 같은 표시명이 다시 분리될 때 given="대표님"이 되던 것 방지.
const TRAILING_TITLES = new Set([
  "님", "씨", "군", "양", "대표", "대표님", "이사", "이사님", "부장", "부장님",
  "과장", "과장님", "팀장", "팀장님", "실장", "실장님", "대리", "감독", "감독님",
  "선생", "선생님", "프로", "피디", "PD", "엔지니어",
]);

/**
 * 한국식 성명 분리(순수 함수, DB 비의존 — data.js·db.js 공용).
 * 말미 호칭·직함을 먼저 떼고, 공백 있으면 첫 토큰=성·나머지=이름, 없으면 첫 글자=성·나머지=이름.
 * @param {string} full 표시명(예: "김준상", "김 보종", "김보종 대표님", "김준상님")
 * @returns {{ family: string, given: string }}
 */
function splitKoreanName(full) {
  let s = String(full || "").trim();
  if (!s) return { family: "", given: "" };
  // 1) 공백으로 분리되는 말미 호칭/직함 토큰 제거("김보종 대표님"→"김보종", "박 지성 프로"→"박 지성")
  let tokens = s.split(/\s+/);
  while (tokens.length > 1 && TRAILING_TITLES.has(tokens[tokens.length - 1])) tokens.pop();
  s = tokens.join(" ");
  // 2) 공백 없는 단일 토큰의 말미 '님'도 제거("김준상님"→"김준상"). '님'은 한국 이름 글자로 안 쓰임(안전).
  if (!s.includes(" ") && s.length >= 3 && s.endsWith("님")) s = s.slice(0, -1);
  if (s.includes(" ")) {
    const [f, ...rest] = s.split(/\s+/);
    return { family: f, given: rest.join(" ").trim() };
  }
  if (s.length >= 2) return { family: s.slice(0, 1), given: s.slice(1) };
  return { family: s, given: "" };
}

/**
 * 표시명 말미의 호칭·직함만 제거(성명 분리 없이). "최인구 대표님"→"최인구", "김준상님"→"김준상", "유진오"→"유진오".
 * '대표 {이름}'처럼 앞에 직함이 이미 있어 뒤 호칭이 중복될 때 표시용.
 */
function stripTrailingTitle(full) {
  let s = String(full || "").trim();
  if (!s) return "";
  let tokens = s.split(/\s+/);
  while (tokens.length > 1 && TRAILING_TITLES.has(tokens[tokens.length - 1])) tokens.pop();
  s = tokens.join(" ");
  if (!s.includes(" ") && s.length >= 3 && s.endsWith("님")) s = s.slice(0, -1);
  return s;
}

module.exports = { splitKoreanName, stripTrailingTitle };
