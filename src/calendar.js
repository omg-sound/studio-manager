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
const { getState, setState, db } = require("./db");
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

function eventBody({ title, location, description, date, start, end, attendees }) {
  const body = Object.assign({ summary: title || "스튜디오 세션" }, eventTimes(date, start, end));
  if (location) body.location = location;
  if (description) body.description = description;
  // 참석자(프로젝트 매니저·예약담당자·담당엔지니어 이메일). 초대 메일은 안 보냄(캘린더 이벤트에만 표시) — sendUpdates 미지정(기본 none).
  if (Array.isArray(attendees) && attendees.length) body.attendees = attendees.map((email) => ({ email }));
  return body;
}

// 연동이 안 됐거나 실패한 이유를 로그로 남긴다(연동은 여전히 fail-safe라 예약은 안 막힌다).
// "왜 캘린더로 안 넘어갔나"를 Render 로그에서 바로 확인할 수 있게 하는 진단용.
function skipReason(cal, calId, date) {
  if (!config.googleConfigured) return "googleConfigured=false(OAuth 미설정)";
  if (!getRefreshToken()) return "refresh_token 없음(Drive/Calendar 미연동 — 치프 재로그인 필요)";
  if (!cal) return "calendarClient null";
  if (!calId) return "studio_calendar_id 미선택(/settings 환경설정에서 스튜디오 캘린더 선택 필요)";
  if (!RE_DATE.test(date)) return `날짜 형식 오류(${date})`;
  return "";
}

/** 현재 캘린더 자동연동 준비 상태(설정 수준, 특정 날짜와 무관). { ok, reason }. ok면 세션 저장 시 자동 연동됨. */
function syncStatus() {
  const reason = skipReason(calendarClient(), getStudioCalendarId(), "2999-01-01");
  return { ok: !reason, reason };
}

/** 스튜디오 캘린더에 일정 생성 → event id. 미연동/오류면 null(예약 자체는 막지 않음). */
async function createEvent(input = {}) {
  const cal = calendarClient();
  const calId = getStudioCalendarId();
  if (!cal || !calId || !RE_DATE.test(input.date)) {
    console.warn(`[calendar] createEvent 스킵 — ${skipReason(cal, calId, input.date)}`);
    return null;
  }
  try {
    const { data } = await cal.events.insert({ calendarId: calId, requestBody: eventBody(input) });
    return data.id || null;
  } catch (e) {
    console.error(`[calendar] createEvent 실패 — code=${e && e.code} status=${e && e.status} msg=${e && e.message}`);
    return null;
  }
}

/** 기존 일정 수정(시간/제목/장소). 성공 true. 일정이 없으면(404) 새로 만들어 새 id 반환(string). */
async function updateEvent(eventId, input = {}) {
  const cal = calendarClient();
  const calId = getStudioCalendarId();
  if (!cal || !calId || !RE_DATE.test(input.date)) {
    console.warn(`[calendar] updateEvent 스킵 — ${skipReason(cal, calId, input.date)}`);
    return null;
  }
  if (!eventId) return createEvent(input); // 연동 후 처음 수정되는 옛 세션 → 새로 생성
  try {
    await cal.events.patch({ calendarId: calId, eventId, requestBody: eventBody(input) });
    return eventId;
  } catch (e) {
    if (e && e.code === 404) return createEvent(input); // 외부에서 지워졌으면 재생성
    console.error(`[calendar] updateEvent 실패 — code=${e && e.code} status=${e && e.status} msg=${e && e.message}`);
    return eventId; // 기타 오류는 기존 id 유지(fail-safe)
  }
}

/** 단일 이벤트 조회. { skipped } | { event } (event=null이면 삭제됨) | { error }. */
async function getEvent(eventId) {
  const cal = calendarClient();
  const calId = getStudioCalendarId();
  if (!cal || !calId || !eventId) return { skipped: true };
  try {
    const { data } = await cal.events.get({ calendarId: calId, eventId });
    return { event: data };
  } catch (e) {
    if (e && (e.code === 404 || e.code === 410)) return { event: null }; // 외부에서 삭제됨
    return { error: (e && e.message) || "unknown" };
  }
}

/** RFC3339 datetime → KST(+09:00) { date:'YYYY-MM-DD', time:'HH:MM' }. 어떤 오프셋이든 KST로 정규화. */
function toKstParts(dateTime) {
  const dt = new Date(dateTime);
  if (isNaN(dt.getTime())) return null;
  const kst = new Date(dt.getTime() + 9 * 3600 * 1000).toISOString();
  return { date: kst.slice(0, 10), time: kst.slice(11, 16) };
}

/**
 * 역방향 동기화(수동): 구글 캘린더에서 직접 삭제/시간 변경한 것을 앱 세션에 반영.
 *  - 이벤트 삭제/취소 → 세션 '취소'. 시작/종료 변경 → 세션 날짜·시간 갱신.
 * 안전: 미연동/청구된 세션/이미 취소된 세션·종일 이벤트는 건너뜀. **db 직접 갱신**(앱→구글 push 훅 안 거침=루프 방지).
 * 반환: { skipped } | { cancelled, updated, checked }.
 */
async function syncSessionsFromCalendar() {
  const cal = calendarClient();
  const calId = getStudioCalendarId();
  if (!cal || !calId) return { skipped: true };
  const d = db();
  const sessions = d
    .prepare("SELECT id, gcal_event_id, session_date, start_time, end_time FROM sessions WHERE gcal_event_id IS NOT NULL AND status <> '취소'")
    .all();
  const invoicedStmt = d.prepare("SELECT 1 FROM invoice_items WHERE session_id = ? LIMIT 1");
  const cancelStmt = d.prepare("UPDATE sessions SET status = '취소' WHERE id = ?");
  const timeStmt = d.prepare("UPDATE sessions SET session_date = ?, start_time = ?, end_time = ? WHERE id = ?");
  let cancelled = 0, updated = 0, checked = 0;
  for (const s of sessions) {
    if (invoicedStmt.get(s.id)) continue; // 청구된 세션은 스냅샷 보존(변경 금지)
    const r = await getEvent(s.gcal_event_id);
    if (r.skipped || r.error) continue;
    checked++;
    if (r.event === null || r.event.status === "cancelled") {
      cancelStmt.run(s.id);
      cancelled++;
      continue;
    }
    const st = r.event.start && r.event.start.dateTime; // 종일 이벤트(date만)면 undefined → 시간 반영 생략
    if (!st) continue;
    const sp = toKstParts(st);
    const ep = r.event.end && r.event.end.dateTime ? toKstParts(r.event.end.dateTime) : null;
    if (!sp) continue;
    const newEnd = ep ? ep.time : s.end_time;
    if (sp.date !== s.session_date || sp.time !== s.start_time || newEnd !== s.end_time) {
      timeStmt.run(sp.date, sp.time, newEnd, s.id);
      updated++;
    }
  }
  return { cancelled, updated, checked };
}

/** 일정 삭제. 미연동/없음/오류는 조용히 무시. */
async function deleteEvent(eventId) {
  const cal = calendarClient();
  const calId = getStudioCalendarId();
  if (!cal || !calId || !eventId) return false;
  try {
    await cal.events.delete({ calendarId: calId, eventId });
    return true;
  } catch (e) {
    if (e && e.code !== 404 && e && e.code !== 410) console.error(`[calendar] deleteEvent 실패 — code=${e && e.code} msg=${e && e.message}`);
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
  getEvent,
  syncSessionsFromCalendar,
  syncStatus,
};
