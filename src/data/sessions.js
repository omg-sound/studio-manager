"use strict";

/**
 * 세션(스튜디오 일정) 도메인 — 예약 CRUD·룸별 겹침 검사·단가 자동 산정·담당 디렉터(다대다)·
 * 캘린더 참석자·다가오는/지난/월별 조회.
 * data.js에서 분리한 모듈(도메인 모듈화). data.js가 재export하므로 소비자 무변경.
 *
 * cross-domain: getProjectForUser(projects)·createContact(contacts)·listRooms(rooms)·
 * computeRatePrice(rate-items)는 직접 require(무순환). isSessionInvoiced(invoices)는
 * sessions↔invoices 상호의존이라 함수 내부 지연 require("../data")로 해소.
 * 다수 헬퍼(sessionFields·resolveDirectorIds·findSessionConflict 등)는 내부 전용(공개 미노출).
 */

const { db } = require("../db");
const { todayYmd, isValidYmd, cleanTime, timeToMin, minutesBetween } = require("../lib/date");
const { normalizeSessionType, normalizeSessionStatus } = require("../config");
const { getProjectForUser } = require("./projects"); // 무순환
const { resolvePersonByName } = require("./parties"); // 무순환 — 디렉터=parties.id(사람)
const { listRooms } = require("./rooms"); // 무순환
const { computeRatePrice } = require("./rate-items"); // 무순환

/** 프로젝트의 세션 목록(날짜순). 권한 없으면 null. */
function listSessionsForProject(user, projectId) {
  const { isSessionInvoiced } = require("../data"); // invoices와 상호의존 → 지연 require
  const project = getProjectForUser(user, projectId);
  if (!project) return null;
  const rows = db()
    .prepare("SELECT * FROM sessions WHERE project_id = ? ORDER BY created_at ASC, id ASC")
    .all(projectId);
  return {
    project,
    rows: rows.map((row) => ({
      ...row,
      billing: sessionRateAmount(row),
      billed_task_id: db().prepare("SELECT id FROM track_tasks WHERE session_id = ?").get(row.id)?.id || null,
      invoiced: isSessionInvoiced(row.id),
    })),
  };
}

/** 단건 세션(로그인 직원 전체 열람). */
function getSessionForUser(_user, sessionId) {
  return db().prepare("SELECT * FROM sessions WHERE id = ?").get(sessionId) || null;
}

/** 'HH:MM' + 분 → 'HH:MM'(24시간 모듈러, 자정 넘김 허용). 입력 무효면 null. */
function addMinutesToHHMM(hhmm, mins) {
  const m = timeToMin(hhmm);
  if (m == null || !Number.isFinite(mins)) return null;
  let t = (m + mins) % 1440;
  if (t < 0) t += 1440;
  return `${String(Math.floor(t / 60)).padStart(2, "0")}:${String(t % 60).padStart(2, "0")}`;
}

/**
 * 종료시간 결정: 소요시간(custom_hours)이 있으면 시작+길이로 계산, 없으면 입력된 end_time 사용.
 * 폼은 항상 duration_mode=custom + custom_hours를 전송한다(슬라이더/프리셋이 custom_hours를 채움).
 * custom_hours는 14시간(840분·4Pro) 상한으로 클램프 — addMinutesToHHMM의 %1440 감김으로 종료시각이 왜곡되지 않게.
 */
function resolveEndTime(input, start) {
  if (!start || String(input.duration_mode || "") !== "custom") {
    return cleanTime(input.end_time_custom) || cleanTime(input.end_time);
  }
  const hours = parseFloat(input.custom_hours);
  if (!(hours > 0)) return cleanTime(input.end_time);
  const mins = Math.min(Math.round(hours * 60), 840); // 상한 14시간(4Pro)
  return addMinutesToHHMM(start, mins);
}

/** 실재하는 룸 id면 그대로, 없거나(삭제됨) 비어 있으면 null로. 비활성 룸도 유지 —
 *  세션 편집 시 기존에 배정된 룸이 (비활성이라는 이유로) 사일런트하게 '미지정'으로 바뀌던 것 방지. */
function validRoomId(raw) {
  const id = Number(raw) || null;
  if (!id) return null;
  return listRooms({ includeInactive: true }).some((r) => r.id === id) ? id : null;
}

function sessionFields(input) {
  const date = String(input.session_date || "").trim();
  if (!isValidYmd(date)) throw new Error("SESSION_DATE_REQUIRED");
  // 직접입력(그리드 밖 시간)이 있으면 우선, 없으면 그리드에서 고른 시작.
  const start = cleanTime(input.start_time_custom) || cleanTime(input.start_time);
  const rateItemId = Number(input.rate_item_id) || null;
  // 담당 디렉터는 다대다(session_directors)로 별도 처리 — 여기선 레거시 컬럼 자리만 null(caller가 첫 디렉터로 채움).
  return {
    session_type: normalizeSessionType(input.session_type),
    session_date: date,
    start_time: start,
    end_time: resolveEndTime(input, start),
    booker_name: String(input.booker_name || "").trim() || null,
    engineer_name: String(input.engineer_name || "").trim() || null,
    status: normalizeSessionStatus(input.status),
    rate_item_id: rateItemId,
    room_id: validRoomId(input.room_id), // 활성 룸 검증 — 없거나 삭제된 id는 null
    director_party_id: null,
    memo: String(input.memo || "").trim() || null,
  };
}

/** 세션 담당 디렉터(다대다): director_contact_id[](목록 선택=party id) + director_name[](새/입력 이름)을 당사자 id 배열로 해석(중복 제거).
 *  콤보 hidden 필드명은 레거시 유지하되 값=parties.id. id 우선, 없으면 같은 이름 사람 재사용(유일 매칭), 없으면 생성. */
function resolveDirectorIds(input) {
  const asArr = (v) => (Array.isArray(v) ? v : v != null && v !== "" ? [v] : []);
  const ids = asArr(input.director_contact_id);
  const names = asArr(input.director_name);
  const n = Math.max(ids.length, names.length);
  const out = [];
  const seen = new Set();
  for (let i = 0; i < n; i++) {
    let pid = Number(ids[i]) || null;
    if (!pid) {
      const nm = String(names[i] || "").trim();
      if (!nm) continue;
      pid = resolvePersonByName(nm); // 유일 매칭 재사용·아니면 새 사람 party
    }
    if (pid && !seen.has(pid)) { seen.add(pid); out.push(pid); }
  }
  return out;
}

/** 세션의 담당 디렉터 목록을 통째로 교체(다대다, party 기준). sessions.director_party_id=첫 디렉터(레거시 단일 참조 동기화). */
function setSessionDirectors(sessionId, ids) {
  const d = db();
  d.prepare("DELETE FROM session_directors WHERE session_id = ?").run(sessionId);
  const ins = d.prepare("INSERT OR IGNORE INTO session_directors (session_id, party_id) VALUES (?, ?)");
  for (const pid of ids) ins.run(sessionId, pid);
  d.prepare("UPDATE sessions SET director_party_id = ? WHERE id = ?").run(ids[0] || null, sessionId);
}

/** 세션 캘린더 참석자 이메일 — 프로젝트 매니저(project.manager_id)·예약담당자(booker_name)·담당엔지니어(engineer_name)의 이메일(중복·빈값 제거). */
function sessionAttendeeEmails(session, project) {
  const d = db();
  const emails = new Set();
  const add = (row) => {
    const e = row && row.email ? String(row.email).trim() : "";
    if (e && /^\S+@\S+\.\S+$/.test(e)) emails.add(e);
  };
  const byName = d.prepare("SELECT email FROM project_managers WHERE name = ? AND email IS NOT NULL AND TRIM(email) <> '' LIMIT 1");
  if (project && project.manager_id) add(d.prepare("SELECT email FROM project_managers WHERE id = ?").get(project.manager_id));
  if (session.booker_name) add(byName.get(session.booker_name));
  if (session.engineer_name) add(byName.get(session.engineer_name));
  return [...emails];
}

/** 세션의 담당 디렉터(연락처) 목록. */
function listSessionDirectors(sessionId) {
  return db()
    .prepare(
      `SELECT ct.* FROM session_directors sd JOIN parties ct ON ct.id = sd.party_id
       WHERE sd.session_id = ? ORDER BY sd.created_at, ct.name COLLATE NOCASE`
    )
    .all(Number(sessionId));
}

/**
 * 해당 날짜에 이미 예약된(녹음/믹싱, 취소 제외) 30분 시작 슬롯 목록 — 가용성 표시용(정보성 그리드).
 * slots = 후보 'HH:MM' 배열. excludeId로 수정 중 세션 제외.
 * room 미지정(undefined)이면 전 룸 합산(기존 동작), 지정 시 같은 룸만(IFNULL=0=레거시/미지정 가상룸).
 */
function busySessionSlots(date, slots, { excludeId = null, room } = {}) {
  if (!isValidYmd(date) || !Array.isArray(slots) || !slots.length) return [];
  const params = { date, excludeId: excludeId == null ? -1 : excludeId };
  let roomClause = "";
  if (room !== undefined) {
    roomClause = "AND IFNULL(room_id, 0) = @room";
    params.room = Number(room) || 0;
  }
  const rows = db()
    .prepare(
      `SELECT session_date, start_time, end_time FROM sessions
       WHERE session_date IN (date(@date, '-1 day'), @date, date(@date, '+1 day')) AND status <> '취소'
         AND start_time IS NOT NULL AND end_time IS NOT NULL AND id <> @excludeId ${roomClause}`
    )
    .all(params);
  const ranges = rows
    .map((r) => {
      const off = dayOffsetMin(r.session_date, date); // 야간 세션이 인접일로 넘어가므로 절대 분축으로 정규화
      const s = timeToMin(r.start_time);
      let e = timeToMin(r.end_time);
      if (s == null || e == null) return null;
      if (e <= s) e += 1440;
      return [s + off, e + off];
    })
    .filter(Boolean);
  if (!ranges.length) return [];
  return slots.filter((slot) => {
    const m = timeToMin(slot);
    return m != null && ranges.some(([s, e]) => m < e && s < m + 30);
  });
}

/** 녹음 세션의 진행시간 → 단가표 자동 산정. 시간제 대상(녹음+단가+시간)이 아니면 null. */
function sessionRateAmount(session) {
  if (!session || session.session_type !== "녹음" || !session.rate_item_id) return null;
  const minutes = minutesBetween(session.start_time, session.end_time);
  if (minutes <= 0) return null;
  const item = db().prepare("SELECT * FROM rate_items WHERE id = ?").get(session.rate_item_id);
  if (!item) return null;
  return { item, minutes, amount: computeRatePrice(item, minutes) };
}

/**
 * 같은 날 + **같은 룸**에서 시간대가 겹치는 다른 녹음/믹싱 세션(취소 제외)을 찾는다.
 * 시간(시작·종료)이 둘 다 있어야 검사한다(미정이면 null). 반열린구간[start,end) 겹침 + 야간(자정 넘김) 처리.
 * room 비교는 IFNULL(room_id,0) — 레거시/미지정(NULL)끼리는 같은 가상룸으로 충돌, 다른 룸이면 병렬 허용.
 */
/** 두 'YYYY-MM-DD' 날짜 차이를 분(minute)으로. 기준일 자정 대비 오프셋(예: 전날=-1440, 다음날=+1440). 무효 시 0. */
function dayOffsetMin(rowDate, baseDate) {
  const a = Date.parse(rowDate + "T00:00:00Z"), b = Date.parse(baseDate + "T00:00:00Z");
  if (!Number.isFinite(a) || !Number.isFinite(b)) return 0;
  return Math.round((a - b) / 86400000) * 1440;
}

function findSessionConflict({ date, start, end, excludeId = null, room = null }) {
  const s = timeToMin(start);
  let e = timeToMin(end);
  if (!isValidYmd(date) || s == null || e == null) return null;
  if (e <= s) e += 1440; // end<=start면 야간(자정 넘김) — 최대 12시간이라 다음날 아침까지만 넘어감
  const roomKey = Number(room) || 0;
  // 전날 야간분이 오늘 아침으로, 오늘 야간분이 다음날 아침으로 넘어갈 수 있으므로 D-1·D·D+1을 함께 조회해 절대 분축으로 비교.
  const rows = db()
    .prepare(
      `SELECT s.*, p.title AS project_title, rm.name AS room_name FROM sessions s
       JOIN projects p ON p.id = s.project_id
       LEFT JOIN rooms rm ON rm.id = s.room_id
       WHERE s.session_date IN (date(?, '-1 day'), ?, date(?, '+1 day')) AND s.status <> '취소'
         AND s.start_time IS NOT NULL AND s.end_time IS NOT NULL
         AND IFNULL(s.room_id, 0) = ?
         AND s.id <> ?
       ORDER BY s.session_date, s.start_time`
    )
    .all(date, date, date, roomKey, excludeId == null ? -1 : excludeId);
  for (const r of rows) {
    const off = dayOffsetMin(r.session_date, date); // 그 세션이 속한 날의 기준일 대비 오프셋(-1440|0|+1440)
    let bs = timeToMin(r.start_time);
    let be = timeToMin(r.end_time);
    if (bs == null || be == null) continue;
    if (be <= bs) be += 1440;
    bs += off; be += off; // 기준일 자정 절대축으로 이동
    if (s < be && bs < e) return r; // 겹침
  }
  return null;
}

function assertNoSessionConflict(f, excludeId) {
  // 취소된 세션은 룸을 점유하지 않으므로 겹침 검사 제외(점유 슬롯에도 취소 세션 기록·다른 활성 세션과의 오탐 차단 허용).
  if (f.status === "취소") return;
  const conflict = findSessionConflict({ date: f.session_date, start: f.start_time, end: f.end_time, excludeId, room: f.room_id });
  if (conflict) {
    const err = new Error("SESSION_TIME_CONFLICT");
    err.conflict = conflict;
    throw err;
  }
}

function createSession(user, projectId, input = {}) {
  const project = getProjectForUser(user, projectId);
  if (!project) return null;
  const f = sessionFields(input);
  const directorIds = resolveDirectorIds(input);
  f.director_party_id = directorIds[0] || null; // 첫 디렉터(party id)
  assertNoSessionConflict(f, null);
  // 세션 행 + 다대다 디렉터를 한 트랜잭션으로 — 중간 실패 시 반쪽 세션(디렉터 없는)이 남지 않게.
  const d = db();
  let newId;
  d.exec("BEGIN IMMEDIATE;");
  try {
    const info = d
      .prepare(
        `INSERT INTO sessions (project_id, session_type, session_date, start_time, end_time, booker_name, engineer_name, status, rate_item_id, room_id, director_party_id, memo)
         VALUES (@project_id, @session_type, @session_date, @start_time, @end_time, @booker_name, @engineer_name, @status, @rate_item_id, @room_id, @director_party_id, @memo)`
      )
      .run({ project_id: project.id, ...f });
    newId = info.lastInsertRowid;
    setSessionDirectors(newId, directorIds); // 다대다 디렉터 저장
    d.exec("COMMIT;");
  } catch (e) {
    d.exec("ROLLBACK;");
    throw e;
  }
  return d.prepare("SELECT * FROM sessions WHERE id = ?").get(newId);
}

function updateSession(user, sessionId, input = {}) {
  const { isSessionInvoiced } = require("../data"); // invoices와 상호의존 → 지연 require
  const s = getSessionForUser(user, sessionId);
  if (!s) return null;
  if (isSessionInvoiced(s.id)) throw new Error("SESSION_INVOICED");
  const f = sessionFields(input);
  const directorIds = resolveDirectorIds(input);
  f.director_party_id = directorIds[0] || null; // 첫 디렉터(party id)
  assertNoSessionConflict(f, s.id);
  // UPDATE + 디렉터 교체를 한 트랜잭션으로(디렉터만 지워지고 세션은 옛값으로 남는 반쪽 갱신 방지).
  const d = db();
  d.exec("BEGIN IMMEDIATE;");
  try {
    d
      .prepare(
        `UPDATE sessions SET session_type=@session_type, session_date=@session_date, start_time=@start_time,
         end_time=@end_time, booker_name=@booker_name, engineer_name=@engineer_name, status=@status,
         rate_item_id=@rate_item_id, room_id=@room_id, director_party_id=@director_party_id, memo=@memo WHERE id=@id`
      )
      .run({ id: s.id, ...f });
    setSessionDirectors(s.id, directorIds); // 다대다 디렉터 교체
    d.exec("COMMIT;");
  } catch (e) {
    d.exec("ROLLBACK;");
    throw e;
  }
  return { ...d.prepare("SELECT * FROM sessions WHERE id = ?").get(s.id), project_id: s.project_id };
}

/** 세션에 자동 생성한 구글 캘린더 일정 id 저장(null이면 해제). */
function setSessionEventId(sessionId, eventId) {
  db().prepare("UPDATE sessions SET gcal_event_id = ? WHERE id = ?").run(eventId || null, sessionId);
}

function setSessionStatus(user, sessionId, status) {
  const { isSessionInvoiced } = require("../data"); // invoices와 상호의존 → 지연 require
  const s = getSessionForUser(user, sessionId);
  if (!s) return null;
  if (isSessionInvoiced(s.id)) throw new Error("SESSION_INVOICED"); // 청구된 세션은 상태 되돌리기 금지(매출 정합)
  db().prepare("UPDATE sessions SET status=? WHERE id=?").run(normalizeSessionStatus(status), s.id);
  return { ...db().prepare("SELECT * FROM sessions WHERE id = ?").get(s.id), project_id: s.project_id };
}

function deleteSession(user, sessionId) {
  const { isSessionInvoiced } = require("../data"); // invoices와 상호의존 → 지연 require
  const s = getSessionForUser(user, sessionId);
  if (!s) return null;
  if (isSessionInvoiced(s.id)) throw new Error("SESSION_INVOICED");
  db().prepare("DELETE FROM sessions WHERE id = ?").run(s.id);
  return { project_id: s.project_id };
}

/** 다가오는 세션(오늘 이후, 취소 제외) — 전역 일정/대시보드. */
function upcomingSessions(_user, { limit = 50 } = {}) {
  return db()
    .prepare(
      `SELECT s.*, p.title AS project_title, p.artist, p.artist_company, p.production_company FROM sessions s
       JOIN projects p ON p.id = s.project_id
       WHERE s.session_date >= ? AND s.status <> '취소'
       ORDER BY s.session_date ASC, s.start_time ASC, s.id ASC LIMIT ?`
    )
    .all(todayYmd(), limit)
    .map((row) => ({ ...row, billing: sessionRateAmount(row) }));
}

/** 지난 세션(오늘 이전) — 전역 일정. */
function pastSessions(_user, { limit = 30 } = {}) {
  return db()
    .prepare(
      `SELECT s.*, p.title AS project_title, p.artist, p.artist_company, p.production_company FROM sessions s
       JOIN projects p ON p.id = s.project_id
       WHERE s.session_date < ?
       ORDER BY s.session_date DESC, s.start_time DESC, s.id DESC LIMIT ?`
    )
    .all(todayYmd(), limit)
    .map((row) => ({ ...row, billing: sessionRateAmount(row) }));
}

/** 특정 월(YYYY-MM)의 세션(취소 제외) + 프로젝트명 — 캘린더 뷰용. */
function sessionsForMonth(_user, ym) {
  if (!/^\d{4}-\d{2}$/.test(String(ym || ""))) return [];
  return db()
    .prepare(
      `SELECT s.*, p.title AS project_title FROM sessions s
       JOIN projects p ON p.id = s.project_id
       WHERE s.session_date LIKE ? AND s.status <> '취소'
       ORDER BY s.session_date ASC, s.start_time ASC, s.id ASC`
    )
    .all(String(ym) + "-%")
    .map((row) => ({ ...row, billing: sessionRateAmount(row) }));
}

module.exports = {
  listSessionsForProject,
  getSessionForUser,
  sessionAttendeeEmails,
  listSessionDirectors,
  busySessionSlots,
  sessionRateAmount,
  createSession,
  updateSession,
  setSessionEventId,
  setSessionStatus,
  deleteSession,
  upcomingSessions,
  pastSessions,
  sessionsForMonth,
};
