"use strict";

/**
 * 모든 날짜를 "YYYY-MM-DD" 문자열로 다룬다(타임존 함정 회피, KST 가정; 플레이북2 §4).
 */

const KST_OFFSET_MIN = 9 * 60;

/** 오늘(KST) "YYYY-MM-DD". */
function todayYmd() {
  const now = new Date();
  const kst = new Date(now.getTime() + (KST_OFFSET_MIN + now.getTimezoneOffset()) * 60000);
  return ymd(kst);
}

function ymd(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

/** "YYYY-MM-DD" 유효성. */
function isValidYmd(s) {
  if (typeof s !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const [y, m, d] = s.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}

/** target까지 남은 일수(오늘=0, 과거=음수). */
function daysUntilYmd(target) {
  if (!isValidYmd(target)) return null;
  const t = Date.UTC(...target.split("-").map((n, i) => (i === 1 ? Number(n) - 1 : Number(n))));
  const today = todayYmd();
  const c = Date.UTC(...today.split("-").map((n, i) => (i === 1 ? Number(n) - 1 : Number(n))));
  return Math.round((t - c) / 86400000);
}

/** D-day 라벨: "오늘", "D-3", "3일 지남". */
function ddayLabel(target) {
  const n = daysUntilYmd(target);
  if (n == null) return "";
  if (n === 0) return "오늘 마감";
  if (n > 0) return `D-${n}`;
  return `${-n}일 지남`;
}

/** "2026-06-26" → "6월 26일". */
function formatYmdShort(s) {
  if (!isValidYmd(s)) return s || "";
  const [, m, d] = s.split("-").map(Number);
  return `${m}월 ${d}일`;
}

/** 'HH:MM' 검증 → 그대로(아니면 null). 시간 입력 정규화 단일 출처. */
function cleanTime(v) {
  const s = String(v || "").trim();
  return /^([01]\d|2[0-3]):[0-5]\d$/.test(s) ? s : null;
}

/** 'HH:MM' → 자정 기준 분(유효하지 않으면 null). 시간 유틸 단일 출처. */
function timeToMin(hhmm) {
  const m = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(String(hhmm || ""));
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
}

/** 'HH:MM' 두 값 사이 분. end<start면 자정 넘김(+24h, 야간 세션). 동일 시각은 0분. 유효하지 않으면 0. */
function minutesBetween(start, end) {
  const s = timeToMin(start);
  let e = timeToMin(end);
  if (s == null || e == null) return 0;
  if (e < s) e += 24 * 60; // end<start만 자정 넘김. e===s(동일 시각)는 0분 → 과금 안 됨
  return e - s;
}

module.exports = { todayYmd, ymd, isValidYmd, daysUntilYmd, ddayLabel, formatYmdShort, cleanTime, timeToMin, minutesBetween };
