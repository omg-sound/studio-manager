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

/**
 * 날짜 콤보 표시 형식 "2026. 3. 17. (화)" — 서버 초기 렌더와 app.js가 **같은 형식**을 써야 한다
 * (다르면 페이지 로드 직후 값이 튄다). 요일은 UTC 파싱으로 계산 — 서버 TZ(Render=UTC)와 무관하게 고정.
 */
const WEEKDAYS_KO = ["일", "월", "화", "수", "목", "금", "토"];
function formatYmdCombo(s) {
  if (!isValidYmd(s)) return "";
  const [y, m, d] = s.split("-").map(Number);
  const wd = WEEKDAYS_KO[new Date(Date.UTC(y, m - 1, d)).getUTCDay()];
  return `${y}. ${m}. ${d}. (${wd})`;
}

/**
 * DB 타임스탬프(UTC) → **한국 시간(KST)** 표시(2026-07-20 사용자 요청 '시스템 시간대가 UTC인데 우리나라 시간으로').
 *
 * SQLite `datetime('now')`는 **UTC**를 쓴다(`created_at`·`audit_log.at`·`users.last_login`).
 * 그걸 그대로 자르면 **KST 00:00~08:59에 만든 것이 하루 이르게** 보인다(실측: 개발 DB 프로젝트 7건).
 * 저장은 UTC 그대로 두고(표준·이식성) **표시에서만 +9h** 한다 — 저장 형식을 바꾸면 기존 데이터와 섞인다.
 *
 * @param {string} v 'YYYY-MM-DD HH:MM:SS' 또는 'YYYY-MM-DDTHH:MM:SS(.sss)(Z)'
 * @returns {Date|null} 시각이 없는 날짜 문자열(길이 10)·빈 값·형식 불명은 null(호출부가 원본을 그대로 쓴다)
 */
function kstDate(v) {
  const s = String(v || "").trim();
  if (!/^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}/.test(s)) return null; // 날짜만 있으면 변환 대상 아님
  const iso = s.replace(" ", "T");
  const ms = Date.parse(/[zZ]$|[+-]\d{2}:?\d{2}$/.test(iso) ? iso : iso + "Z"); // 표기 없으면 UTC로 해석
  if (Number.isNaN(ms)) return null;
  return new Date(ms + KST_OFFSET_MIN * 60000);
}

/** DB UTC 타임스탬프 → KST 날짜 'YYYY-MM-DD'. 시각이 없으면 원본 앞 10자(이미 날짜라 변환 불필요). */
function kstYmd(v) {
  const d = kstDate(v);
  if (!d) return String(v || "").slice(0, 10);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}`;
}

/** DB UTC 타임스탬프 → KST 'YYYY-MM-DD HH:MM'(감사 로그처럼 시각까지 보여주는 곳). */
function kstDateTime(v) {
  const d = kstDate(v);
  if (!d) return String(v || "").replace("T", " ").slice(0, 16);
  const hh = String(d.getUTCHours()).padStart(2, "0");
  const mi = String(d.getUTCMinutes()).padStart(2, "0");
  return `${kstYmd(v)} ${hh}:${mi}`;
}

module.exports = { todayYmd, ymd, isValidYmd, daysUntilYmd, ddayLabel, formatYmdShort, formatYmdCombo, cleanTime, timeToMin, minutesBetween, kstDate, kstYmd, kstDateTime };
