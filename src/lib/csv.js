"use strict";

// 의존성 0 CSV 직렬화. RFC4180(따옴표·콤마·개행 이스케이프) + Excel 한글용 UTF-8 BOM.
// 회계 내보내기(매출·정산)의 공용 빌더 — 세무사 전달·부가세/원천세 신고에 쓴다.

/** 한 셀 이스케이프. 콤마·따옴표·개행이 있으면 따옴표로 감싸고 내부 따옴표는 "" 로 이스케이프. */
function cell(v) {
  const s = v == null ? "" : String(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/**
 * @param {string[]} headers 첫 줄 헤더
 * @param {Array<Array<*>>} rows 각 행(셀 배열)
 * @returns {string} BOM + CRLF 구분 CSV (Excel이 UTF-8 한글을 안 깨게 BOM 선두)
 */
function toCsv(headers, rows) {
  const lines = [headers.map(cell).join(",")];
  for (const r of rows) lines.push(r.map(cell).join(","));
  return "﻿" + lines.join("\r\n"); // ﻿ = UTF-8 BOM (Excel 한글 인코딩 인식용)
}

module.exports = { toCsv, cell };
