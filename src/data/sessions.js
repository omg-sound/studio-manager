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
const { parseMoney } = require("../lib/forms");
const { normalizeSessionType, normalizeSessionStatus, RENTAL_SESSION_TYPES } = require("../config");
const { getProjectForUser } = require("./projects"); // 무순환
const { resolvePersonByName } = require("./parties"); // 무순환 — 디렉터=parties.id(사람)
const { listRooms } = require("./rooms"); // 무순환
const { computeRatePrice } = require("./rate-items"); // 무순환

/** 프로젝트의 세션 목록(날짜순). 권한 없으면 null. */
function listSessionsForProject(user, projectId) {
  const { isSessionInvoiced } = require("../data"); // invoices와 상호의존 → 지연 require
  const project = getProjectForUser(user, projectId);
  if (!project) return null;
  // 항상 날짜순(2026-07-05 사용자 요청 — 이전 작성순 created_at에서 전환). 같은 날은 시작 시각순, 동률은 id로 안정 정렬.
  const rows = db()
    .prepare("SELECT * FROM sessions WHERE project_id = ? ORDER BY session_date ASC, start_time ASC, id ASC")
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
 * custom_hours는 16시간(960분) 상한으로 클램프 — addMinutesToHHMM의 %1440 감김으로 종료시각이 왜곡되지 않게.
 */
function resolveEndTime(input, start) {
  if (!start || String(input.duration_mode || "") !== "custom") {
    return cleanTime(input.end_time_custom) || cleanTime(input.end_time);
  }
  const hours = parseFloat(input.custom_hours);
  if (!(hours > 0)) return cleanTime(input.end_time);
  const mins = Math.min(Math.round(hours * 60), 960); // 상한 16시간
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
  // 종일(Google/Apple 개념 = 하루 종일·시간 없음). 체크 시 시작·종료를 NULL로 저장(시간 미보유). 서버 권위: 클라 시간값 무시.
  const allDay = input.all_day === "1" || input.all_day === "on" || input.all_day === true;
  // 종일 다일 일정: 종료 날짜(end_date)가 시작보다 뒤일 때만 저장(단일일이면 NULL). 시간 세션은 end_date 무시(야간=end<start로 표현).
  const endDateRaw = String(input.end_date || "").trim();
  const endDate = allDay && isValidYmd(endDateRaw) && endDateRaw > date ? endDateRaw : null;
  // 직접입력(그리드 밖 시간)이 있으면 우선, 없으면 그리드에서 고른 시작.
  const start = allDay ? null : cleanTime(input.start_time_custom) || cleanTime(input.start_time);
  const rateItemId = Number(input.rate_item_id) || null;
  const roomId = validRoomId(input.room_id); // 활성 룸 검증 — 없거나 삭제된 id는 null
  const { isExternalRoom } = require("./rooms"); // 무순환(rooms는 sessions를 require하지 않음)
  // 외부 장소(is_external)일 때만 주소(location) 저장 — 스튜디오 룸이면 null(기본 장소 사용).
  const location = roomId && isExternalRoom(roomId) ? String(input.location || "").trim() || null : null;
  // 담당 디렉터·담당 엔지니어는 다대다(session_directors·session_engineers)로 별도 처리 — 여기선 레거시 컬럼 자리만 null(caller가 첫 명으로 채움).
  return {
    session_type: normalizeSessionType(input.session_type),
    session_date: date,
    all_day: allDay ? 1 : 0,
    end_date: endDate,
    start_time: start,
    end_time: allDay ? null : resolveEndTime(input, start),
    booker_name: String(input.booker_name || "").trim() || null,
    engineer_name: null,
    status: normalizeSessionStatus(input.status),
    rate_item_id: rateItemId,
    room_id: roomId,
    location,
    director_party_id: null,
    memo: String(input.memo || "").trim() || null,
  };
}

/** 세션 담당 디렉터(다대다): director_name(콤마 여러 명 텍스트) + director_contact_id(레거시 단일 id)를 당사자 id 배열로 해석(중복 제거).
 *  콤마 다중(2026-07-05 — 아티스트 콤보와 동일 UX): 각 조각을 resolvePersonByName로 해석 — 라벨 안전망이
 *  '박수한 대표님 (워터멜론)' 같은 표시 라벨도 그 사람으로 정확 매칭(유일), 새 이름만 생성. 레거시 행 UI(배열+id)도 그대로 지원. */
function resolveDirectorIds(input) {
  const asArr = (v) => (Array.isArray(v) ? v : v != null && v !== "" ? [v] : []);
  const ids = asArr(input.director_contact_id);
  const names = asArr(input.director_name);
  const n = Math.max(ids.length, names.length);
  const out = [];
  const seen = new Set();
  const push = (pid) => { if (pid && !seen.has(pid)) { seen.add(pid); out.push(pid); } };
  for (let i = 0; i < n; i++) {
    const nm = String(names[i] || "").trim();
    const explicitId = Number(ids[i]) || null;
    // 명시 id + 콤마 없는 단일 이름(레거시 행 UI·정확 연결) = id 우선. 콤마가 있으면 이름 목록이 명시적 → 이름별 해석.
    if (explicitId && !nm.includes(",")) { push(explicitId); continue; }
    if (!nm) continue;
    for (const part of nm.split(",")) {
      const one = part.trim();
      if (one) push(resolvePersonByName(one));
    }
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

/** 세션 담당 엔지니어(다대다, 2026-07-05): engineer_ids[](담당자 마스터 id, 반복 select) → 유효 id 배열(중복 제거).
 *  디렉터와 달리 자유 텍스트 등록이 없다(담당자 마스터에서만 선택) — 존재하지 않는(삭제된) id만 걸러내고,
 *  비활성 담당자는 유지(기존 배정 보존 — validRoomId와 동일 철학: 목록에 안 보여도 이미 배정된 건 안 지운다). */
function resolveEngineerIds(input) {
  return resolveEngineerAssignments(input).map((a) => a.id);
}

/**
 * 세션 담당 엔지니어 배정 + 외주 지급단가(2026-07-06 사용자 상담 — track_tasks와 동일 구조로 세션도 정산).
 * engineer_ids[]/engineer_rates[]를 같은 인덱스로 페어링(폼의 반복 행과 1:1), 유효 id만·중복 제거(첫 값 유지).
 * 하우스 엔지니어 행은 rate 입력이 폼에서 숨겨져 있어 보통 0으로 온다 — setSessionEngineers가 저장 시 무해.
 */
function resolveEngineerAssignments(input) {
  const asArr = (v) => (Array.isArray(v) ? v : v != null && v !== "" ? [v] : []);
  const idsRaw = asArr(input.engineer_ids);
  const ratesRaw = asArr(input.engineer_rates);
  const seen = new Set();
  const pairs = [];
  idsRaw.forEach((v, i) => {
    const id = Number(v);
    if (!id || seen.has(id)) return;
    seen.add(id);
    pairs.push({ id, rate: parseMoney(ratesRaw[i]) });
  });
  if (!pairs.length) return [];
  const placeholders = pairs.map(() => "?").join(",");
  const valid = new Set(db().prepare(`SELECT id FROM project_managers WHERE id IN (${placeholders})`).all(...pairs.map((p) => p.id)).map((r) => r.id));
  return pairs.filter((p) => valid.has(p.id));
}

/**
 * 세션의 담당 엔지니어 배정을 교체(다대다) — 단, 계속 배정된 엔지니어의 worker_rate/worker_paid는 보존한다
 * (2026-07-06 — 이전엔 DELETE 후 재삽입이라 매 저장마다 지급단가·지급상태가 초기화되던 문제).
 * assignments = resolveEngineerAssignments 결과([{id, rate}]). sessions.engineer_name=첫 엔지니어 이름 동기화.
 */
function setSessionEngineers(sessionId, assignments) {
  const d = db();
  const existing = new Map(d.prepare("SELECT manager_id, worker_paid FROM session_engineers WHERE session_id = ?").all(sessionId).map((r) => [r.manager_id, r]));
  const nextIds = new Set(assignments.map((a) => a.id));
  for (const mid of existing.keys()) {
    if (!nextIds.has(mid)) d.prepare("DELETE FROM session_engineers WHERE session_id = ? AND manager_id = ?").run(sessionId, mid);
  }
  const insert = d.prepare("INSERT INTO session_engineers (session_id, manager_id, worker_rate) VALUES (?, ?, ?)");
  const updateRate = d.prepare("UPDATE session_engineers SET worker_rate = ? WHERE session_id = ? AND manager_id = ?");
  for (const a of assignments) {
    if (existing.has(a.id)) updateRate.run(a.rate, sessionId, a.id); // 이미 배정된 엔지니어 — worker_paid 보존, 단가만 갱신
    else insert.run(sessionId, a.id, a.rate); // 새로 배정 — worker_paid=0(컬럼 기본값)
  }
  const first = assignments.length ? d.prepare("SELECT name FROM project_managers WHERE id = ?").get(assignments[0].id) : null;
  d.prepare("UPDATE sessions SET engineer_name = ? WHERE id = ?").run(first ? first.name : null, sessionId);
}

/** 세션의 담당 엔지니어(담당자 마스터 + 세션별 지급단가/지급상태) 목록. */
function listSessionEngineers(sessionId) {
  return db()
    .prepare(
      `SELECT pm.*, se.worker_rate, se.worker_paid, se.worker_paid_date FROM session_engineers se JOIN project_managers pm ON pm.id = se.manager_id
       WHERE se.session_id = ? ORDER BY se.created_at, pm.name COLLATE NOCASE`
    )
    .all(Number(sessionId));
}

/** 외주 작업자의 세션 정산 대상(session_engineers에 실제 배정된 것만 — 레거시 engineer_name 폴백 매칭은 지급단가가 없어 제외). */
function listSessionPayoutsForWorker(worker) {
  if (!worker) return [];
  return db()
    .prepare(
      `SELECT s.id AS session_id, s.session_type, s.session_date, s.project_id, p.title AS project_title,
              se.worker_rate, se.worker_paid, se.worker_paid_date
       FROM session_engineers se
       JOIN sessions s ON s.id = se.session_id
       JOIN projects p ON p.id = s.project_id
       WHERE se.manager_id = ?
       ORDER BY s.session_date DESC, s.id DESC`
    )
    .all(worker.id);
}

/** 외주 세션 지급 처리/해제(정산) — track_tasks의 setTaskPayout과 동일 규칙. */
function setSessionEngineerPayout(sessionId, managerId, paid, paidOn) {
  const p = paid ? 1 : 0;
  db().prepare("UPDATE session_engineers SET worker_paid = ?, worker_paid_date = ? WHERE session_id = ? AND manager_id = ?").run(p, p ? (paidOn || todayYmd()) : null, Number(sessionId), Number(managerId));
}

/** 세션 캘린더 참석자 이메일 — 프로젝트 매니저(project.manager_id)·예약담당자(booker_name)·담당엔지니어(전원, 다대다)의 이메일(중복·빈값 제거). */
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
  for (const eng of listSessionEngineers(session.id)) add(eng);
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
function sessionRateAmount(session, itemOverride) {
  if (!session || !RENTAL_SESSION_TYPES.includes(session.session_type) || !session.rate_item_id) return null;
  // itemOverride: 목록 조회가 rate_items를 한 번만 로드해 넘기는 배치 경로(2026-07-09 감사 — 행당 단건 조회 N+1 제거).
  const item = itemOverride || db().prepare("SELECT * FROM rate_items WHERE id = ?").get(session.rate_item_id);
  if (!item) return null;
  // 종일 세션은 시간이 없어 시간제 산정 불가 → 1 기준 블록으로 취급(정액 항목=base_price, 시간제 항목=1Pro). 금액은 청구 시 조정.
  if (session.all_day) {
    const mins = item.base_minutes || 0;
    return { item, minutes: mins, amount: computeRatePrice(item, mins), allDay: true };
  }
  const minutes = minutesBetween(session.start_time, session.end_time);
  if (minutes <= 0) return null;
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

function assertNoSessionConflict(f, excludeId, allowConflict = false) {
  // 사용자가 '그래도 등록'을 확인하면(override) 겹침을 허용해 예약을 진행한다(같은 룸 더블부킹 명시 승인).
  if (allowConflict) return;
  // 취소된 세션은 룸을 점유하지 않으므로 겹침 검사 제외(점유 슬롯에도 취소 세션 기록·다른 활성 세션과의 오탐 차단 허용).
  if (f.status === "취소") return;
  const conflict = findSessionConflict({ date: f.session_date, start: f.start_time, end: f.end_time, excludeId, room: f.room_id });
  if (conflict) {
    const err = new Error("SESSION_TIME_CONFLICT");
    err.conflict = conflict;
    throw err;
  }
}

/** 폼의 override_conflict 플래그(="1")면 겹침을 허용(사용자가 '그래도 등록' 확인). */
function conflictOverride(input) {
  return String(input && input.override_conflict) === "1";
}

function createSession(user, projectId, input = {}) {
  const project = getProjectForUser(user, projectId);
  if (!project) return null;
  const f = sessionFields(input);
  const directorIds = resolveDirectorIds(input);
  f.director_party_id = directorIds[0] || null; // 첫 디렉터(party id)
  const engineerAssignments = resolveEngineerAssignments(input);
  const firstEngineer = engineerAssignments.length ? db().prepare("SELECT name FROM project_managers WHERE id = ?").get(engineerAssignments[0].id) : null;
  f.engineer_name = firstEngineer ? firstEngineer.name : null; // 첫 엔지니어 이름(레거시 컬럼 동기화)
  assertNoSessionConflict(f, null, conflictOverride(input));
  // 세션 행 + 다대다 디렉터·엔지니어를 한 트랜잭션으로 — 중간 실패 시 반쪽 세션(디렉터·엔지니어 없는)이 남지 않게.
  const d = db();
  let newId;
  d.exec("BEGIN IMMEDIATE;");
  try {
    const info = d
      .prepare(
        `INSERT INTO sessions (project_id, session_type, session_date, all_day, end_date, start_time, end_time, booker_name, engineer_name, status, rate_item_id, room_id, location, director_party_id, memo)
         VALUES (@project_id, @session_type, @session_date, @all_day, @end_date, @start_time, @end_time, @booker_name, @engineer_name, @status, @rate_item_id, @room_id, @location, @director_party_id, @memo)`
      )
      .run({ project_id: project.id, ...f });
    newId = info.lastInsertRowid;
    setSessionDirectors(newId, directorIds); // 다대다 디렉터 저장
    setSessionEngineers(newId, engineerAssignments); // 다대다 엔지니어 저장(+ 외주 지급단가)
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
  const engineerAssignments = resolveEngineerAssignments(input);
  const firstEngineer = engineerAssignments.length ? db().prepare("SELECT name FROM project_managers WHERE id = ?").get(engineerAssignments[0].id) : null;
  f.engineer_name = firstEngineer ? firstEngineer.name : null; // 첫 엔지니어 이름(레거시 컬럼 동기화)
  assertNoSessionConflict(f, s.id, conflictOverride(input));
  // UPDATE + 디렉터·엔지니어 교체를 한 트랜잭션으로(디렉터·엔지니어만 지워지고 세션은 옛값으로 남는 반쪽 갱신 방지).
  const d = db();
  d.exec("BEGIN IMMEDIATE;");
  try {
    d
      .prepare(
        `UPDATE sessions SET session_type=@session_type, session_date=@session_date, all_day=@all_day, end_date=@end_date, start_time=@start_time,
         end_time=@end_time, booker_name=@booker_name, engineer_name=@engineer_name, status=@status,
         rate_item_id=@rate_item_id, room_id=@room_id, location=@location, director_party_id=@director_party_id, memo=@memo WHERE id=@id`
      )
      .run({ id: s.id, ...f });
    setSessionDirectors(s.id, directorIds); // 다대다 디렉터 교체
    setSessionEngineers(s.id, engineerAssignments); // 다대다 엔지니어 교체(+ 외주 지급단가, worker_paid 보존)
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

/**
 * '청구 안 함'(무료 처리) 토글(2026-07-06 사용자 요청 — 리허설 등 의도적 무료 세션). 청구 후보 화면에서만
 * 노출·되돌리기 가능한 표시 플래그. 예산·미청구 집계(sessionAmountsByProject·unbilled_cnt)에서 waived=1 제외.
 * 폼 필드 없이 현재값을 뒤집는 순수 토글(청구 생성 폼 안 여러 행이 한 폼을 공유해 이름 충돌 없이 안전).
 */
function setSessionWaived(user, sessionId) {
  const { isSessionInvoiced } = require("../data"); // invoices와 상호의존 → 지연 require
  const s = getSessionForUser(user, sessionId);
  if (!s) return null;
  if (isSessionInvoiced(s.id)) throw new Error("SESSION_INVOICED");
  db().prepare("UPDATE sessions SET waived = ? WHERE id = ?").run(s.waived ? 0 : 1, s.id);
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

/** rate_items를 1회 로드해 행별 billing을 계산하는 mapper — 목록 .map(sessionRateAmount) N+1 제거(2026-07-09 감사). */
function withBilling() {
  const items = rateItemsById();
  return (row) => ({ ...row, billing: sessionRateAmount(row, items.get(row.rate_item_id)) });
}

/** rate_items 전체를 id Map으로 1회 로드(소형 테이블). */
function rateItemsById() {
  const m = new Map();
  for (const r of db().prepare("SELECT * FROM rate_items").all()) m.set(r.id, r);
  return m;
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
    .map(withBilling());
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
    .map(withBilling());
}

/** 특정 월(YYYY-MM)의 세션(취소 제외) + 프로젝트명 — 캘린더 뷰용. */
function sessionsForMonth(_user, ym) {
  if (!/^\d{4}-\d{2}$/.test(String(ym || ""))) return [];
  return db()
    .prepare(
      `SELECT s.*, p.title AS project_title, p.artist, p.artist_company, p.production_company FROM sessions s
       JOIN projects p ON p.id = s.project_id
       WHERE s.session_date LIKE ? AND s.status <> '취소'
       ORDER BY s.session_date ASC, s.start_time ASC, s.id ASC`
    )
    .all(String(ym) + "-%")
    .map(withBilling());
}

module.exports = {
  listSessionsForProject,
  getSessionForUser,
  sessionAttendeeEmails,
  listSessionDirectors,
  listSessionEngineers,
  listSessionPayoutsForWorker,
  setSessionEngineerPayout,
  busySessionSlots,
  sessionRateAmount,
  createSession,
  updateSession,
  setSessionEventId,
  setSessionStatus,
  setSessionWaived,
  deleteSession,
  upcomingSessions,
  pastSessions,
  sessionsForMonth,
};
