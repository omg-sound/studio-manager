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
const STATE_STUDIO_LOCATION = "studio_location"; // 예약 일정 기본 장소(관리에서 설정)

function getStudioCalendarId() {
  return getState(STATE_STUDIO_CALENDAR) || null;
}

function setStudioCalendarId(id) {
  setState(STATE_STUDIO_CALENDAR, String(id || "").trim() || null);
}

function getStudioLocation() {
  return getState(STATE_STUDIO_LOCATION) || "";
}

function setStudioLocation(v) {
  setState(STATE_STUDIO_LOCATION, String(v || "").trim() || null);
}

/** refresh token으로 인증된 Calendar 클라이언트. 미연동이면 null. */
function calendarClient() {
  const refresh = getRefreshToken();
  if (!config.googleConfigured || !refresh) return null;
  const auth = oauthClient();
  auth.setCredentials({ refresh_token: refresh });
  return google.calendar({ version: "v3", auth });
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

/**
 * 해당 날짜에 스튜디오 캘린더에서 바쁜 30분 시작 슬롯 목록(가용성 표시용). 미연동/오류는 [](fail-open).
 * slots = 후보 'HH:MM' 배열. 각 슬롯 [t, t+30)가 캘린더 busy 구간과 겹치면 포함.
 */
async function busySlotsForDate(date, slots) {
  const cal = calendarClient();
  const calId = getStudioCalendarId();
  if (!cal || !calId || !RE_DATE.test(date) || !Array.isArray(slots) || !slots.length) return [];
  try {
    const { data } = await cal.freebusy.query({
      requestBody: {
        timeMin: rfc3339Kst(date, "00:00"),
        timeMax: rfc3339Kst(date, "00:00", 1), // 그날 하루 전체(익일 00:00까지)
        timeZone: "Asia/Seoul",
        items: [{ id: calId }],
      },
    });
    const busy = (data.calendars && data.calendars[calId] && data.calendars[calId].busy) || [];
    const ranges = busy
      .map((b) => [Date.parse(b.start), Date.parse(b.end)])
      .filter(([s, e]) => Number.isFinite(s) && Number.isFinite(e));
    if (!ranges.length) return [];
    return slots.filter((slot) => {
      if (!RE_TIME.test(slot)) return false;
      const ss = Date.parse(rfc3339Kst(date, slot));
      const se = ss + 30 * 60000;
      return ranges.some(([bs, be]) => ss < be && bs < se); // 반열린 겹침
    });
  } catch (_e) {
    return [];
  }
}

/** 일정 시간 본문: 시작·종료 있으면 시간 일정(KST·야간 익일), 없으면 종일. */
function eventTimes(date, start, end) {
  if (RE_TIME.test(start) && RE_TIME.test(end)) {
    const overnight = end <= start;
    return {
      start: { dateTime: rfc3339Kst(date, start), timeZone: "Asia/Seoul" },
      end: { dateTime: rfc3339Kst(date, end, overnight ? 1 : 0), timeZone: "Asia/Seoul" },
    };
  }
  const dt = new Date(`${date}T00:00:00Z`);
  dt.setUTCDate(dt.getUTCDate() + 1);
  return { start: { date }, end: { date: dt.toISOString().slice(0, 10) } };
}

function eventBody({ title, location, description, date, start, end }) {
  const body = Object.assign({ summary: title || "스튜디오 세션" }, eventTimes(date, start, end));
  if (location) body.location = location;
  if (description) body.description = description;
  return body;
}

/** 스튜디오 캘린더에 일정 생성 → event id. 미연동/오류면 null(예약 자체는 막지 않음). */
async function createEvent(input = {}) {
  const cal = calendarClient();
  const calId = getStudioCalendarId();
  if (!cal || !calId || !RE_DATE.test(input.date)) return null;
  try {
    const { data } = await cal.events.insert({ calendarId: calId, requestBody: eventBody(input) });
    return data.id || null;
  } catch (_e) {
    return null;
  }
}

/** 기존 일정 수정(시간/제목/장소). 성공 true. 일정이 없으면(404) 새로 만들어 새 id 반환(string). */
async function updateEvent(eventId, input = {}) {
  const cal = calendarClient();
  const calId = getStudioCalendarId();
  if (!cal || !calId || !RE_DATE.test(input.date)) return null;
  if (!eventId) return createEvent(input); // 연동 후 처음 수정되는 옛 세션 → 새로 생성
  try {
    await cal.events.patch({ calendarId: calId, eventId, requestBody: eventBody(input) });
    return eventId;
  } catch (e) {
    if (e && e.code === 404) return createEvent(input); // 외부에서 지워졌으면 재생성
    return eventId; // 기타 오류는 기존 id 유지(fail-safe)
  }
}

/** 일정 삭제. 미연동/없음/오류는 조용히 무시. */
async function deleteEvent(eventId) {
  const cal = calendarClient();
  const calId = getStudioCalendarId();
  if (!cal || !calId || !eventId) return false;
  try {
    await cal.events.delete({ calendarId: calId, eventId });
    return true;
  } catch (_e) {
    return false;
  }
}

module.exports = {
  STATE_STUDIO_CALENDAR,
  STATE_STUDIO_LOCATION,
  getStudioCalendarId,
  setStudioCalendarId,
  getStudioLocation,
  setStudioLocation,
  calendarClient,
  listCalendars,
  rfc3339Kst,
  busySlotsForDate,
  eventBody,
  createEvent,
  updateEvent,
  deleteEvent,
};
