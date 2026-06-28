"use strict";

/**
 * Google Calendar 충돌 검사 모듈 — 전용 스튜디오 캘린더 FreeBusy 읽기.
 *
 * 목적: 앱 밖(구글 캘린더에서 직접)에서 잡은 일정과도 세션 예약이 겹치지 않게 막는다.
 *       앱 DB 안의 세션끼리 겹침은 data.findSessionConflict가 담당하고, 여기서는 외부 캘린더를 본다.
 *
 * 설계(Drive와 동일 패턴):
 * - 관리자(치프) OAuth refresh token을 재사용(drive.getRefreshToken), scope 'calendar.readonly' 추가 필요.
 * - 치프가 /settings에서 고른 "스튜디오 캘린더" 하나의 FreeBusy(바쁜 시간대)만 읽는다 → 일정 제목 미열람(프라이버시).
 * - 미연동/권한없음/네트워크 오류는 fail-open(null) — 검사 실패로 예약 자체가 마비되지 않게 한다.
 */

const { google } = require("googleapis");
const { config } = require("./config");
const { getState, setState } = require("./db");
const { oauthClient } = require("./auth");
const { getRefreshToken } = require("./drive"); // Drive와 같은 refresh token 재사용

const STATE_STUDIO_CALENDAR = "studio_calendar_id"; // admin_state에 저장된 스튜디오 캘린더 id

function getStudioCalendarId() {
  return getState(STATE_STUDIO_CALENDAR) || null;
}

function setStudioCalendarId(id) {
  setState(STATE_STUDIO_CALENDAR, String(id || "").trim() || null);
}

/** refresh token으로 인증된 Calendar 클라이언트. 미연동이면 null. */
function calendarClient() {
  const refresh = getRefreshToken();
  if (!config.googleConfigured || !refresh) return null;
  const auth = oauthClient();
  auth.setCredentials({ refresh_token: refresh });
  return google.calendar({ version: "v3", auth });
}

/** 캘린더 충돌 검사 활성 여부(토큰 + 스튜디오 캘린더 지정). */
function isCalendarLinked() {
  return Boolean(calendarClient() && getStudioCalendarId());
}

/** 치프의 캘린더 목록(스튜디오 캘린더 선택용). 실패 시 []. */
async function listCalendars() {
  const cal = calendarClient();
  if (!cal) return [];
  try {
    const { data } = await cal.calendarList.list({ minAccessRole: "reader", maxResults: 100 });
    return (data.items || []).map((c) => ({ id: c.id, summary: c.summary || c.id, primary: !!c.primary }));
  } catch (_e) {
    return [];
  }
}

const RE_DATE = /^\d{4}-\d{2}-\d{2}$/;
const RE_TIME = /^([01]\d|2[0-3]):[0-5]\d$/;

/** RFC3339(KST, +09:00) 타임스탬프. date='YYYY-MM-DD', time='HH:MM'. addDay>0이면 날짜를 더한다. */
function rfc3339Kst(date, time, addDay = 0) {
  let d = date;
  if (addDay) {
    const dt = new Date(`${date}T00:00:00Z`);
    dt.setUTCDate(dt.getUTCDate() + addDay);
    d = dt.toISOString().slice(0, 10);
  }
  return `${d}T${time}:00+09:00`;
}

/** FreeBusy 응답에서 해당 캘린더의 busy 블록 → 충돌 객체(있으면) 또는 null. */
function conflictFromFreebusy(data, calId) {
  const entry = (data && data.calendars && data.calendars[calId]) || {};
  const busy = Array.isArray(entry.busy) ? entry.busy : [];
  return busy.length > 0 ? { source: "google_calendar", calendarId: calId, busy } : null;
}

/**
 * 스튜디오 캘린더에서 [date start, end) 구간이 바쁜지 검사. 겹치면 충돌 객체, 아니면 null.
 * end<=start면 야간(종료를 익일로). 미연동/시간없음/오류는 fail-open(null) — 예약을 막지 않음.
 */
async function findExternalConflict({ date, start, end } = {}) {
  const cal = calendarClient();
  const calId = getStudioCalendarId();
  if (!cal || !calId || !RE_DATE.test(date) || !RE_TIME.test(start) || !RE_TIME.test(end)) return null;
  const overnight = end <= start; // 'HH:MM' 문자열 비교(고정 폭) — 종료가 시작 이하면 자정 넘김
  try {
    const { data } = await cal.freebusy.query({
      requestBody: {
        timeMin: rfc3339Kst(date, start),
        timeMax: rfc3339Kst(date, end, overnight ? 1 : 0),
        timeZone: "Asia/Seoul",
        items: [{ id: calId }],
      },
    });
    return conflictFromFreebusy(data, calId);
  } catch (_e) {
    return null; // fail-open: 검사 불가 시 예약 허용(차단으로 인한 업무 마비 방지)
  }
}

module.exports = {
  STATE_STUDIO_CALENDAR,
  getStudioCalendarId,
  setStudioCalendarId,
  calendarClient,
  isCalendarLinked,
  listCalendars,
  rfc3339Kst,
  conflictFromFreebusy,
  findExternalConflict,
};
