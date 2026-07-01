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

/** 사업자등록번호: 숫자 10자리면 ###-##-##### 서식, 그 외(자릿수 다름)는 입력 보존(trim). 빈값→null. */
function formatBizNo(v) {
  const s = String(v == null ? "" : v).trim();
  if (!s) return null;
  const d = s.replace(/\D/g, "");
  if (d.length === 10) return `${d.slice(0, 3)}-${d.slice(3, 5)}-${d.slice(5)}`;
  return s; // 자릿수가 안 맞으면 원본 보존(부분 입력·해외 등)
}

module.exports = { parseMoney, cleanYmd, formatBizNo };
