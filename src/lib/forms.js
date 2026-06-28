"use strict";

/** 입력 방어 파싱 유틸(플레이북2 §3.4). */

const { isValidYmd } = require("./date");

/** 금액 문자열 → 정수(원). 콤마/공백/기타 문자 제거. 음수 불가. */
function parseMoney(v) {
  const n = parseInt(String(v == null ? "" : v).replace(/[^\d-]/g, ""), 10);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

/** "YYYY-MM-DD"만 통과, 아니면 null. */
function cleanYmd(v) {
  const s = String(v || "").trim();
  return isValidYmd(s) ? s : null;
}

module.exports = { parseMoney, cleanYmd };
