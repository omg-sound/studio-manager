"use strict";

/**
 * 데이터 접근 헬퍼. 내부 도구이므로 로그인한 직원(staff/admin)은 모든 프로젝트를 열람한다.
 * 쓰기 권한은 라우트 미들웨어(requireEditor/requireChief/requireInvoice)가 분리해 강제한다.
 * 통계·표시 분기는 권한 술어(canInvoice/isChief, auth.js)로 판단한다(거래처 외부 열람은 폐기됨).
 */

const crypto = require("crypto");
const { db, getState, setState } = require("./db");
const { todayYmd, isValidYmd, formatYmdShort, timeToMin, minutesBetween } = require("./lib/date");
const { parseMoney } = require("./lib/forms");
const { canInvoice, isChief, canEdit } = require("./auth");
const {
  normalizeTrackContentType,
  normalizeBillingType,
  normalizeTaskStatus,
  normalizeSessionType,
  normalizeSessionStatus,
  normalizeRecordingCategory,
  normalizeClientKind,
  normalizeTaskGroup,
  timeSlots,
  SESSION_START_SLOTS,
} = require("./config");

/** 'HH:MM' 검증(아니면 null). */
function cleanTime(v) {
  const s = String(v || "").trim();
  return /^([01]\d|2[0-3]):[0-5]\d$/.test(s) ? s : null;
}

// ── 인보이스 금액/상태 파생(플레이북2 §4 payStatus/balanceOf) ──

/** 잔금(미수금) = 총액 - 입금액(음수 없음). */
function balanceOf(inv) {
  return Math.max((inv.amount || 0) - (inv.paid_amount || 0), 0);
}

/** 납입 상태: 미납 | 부분납 | 완납. */
function payStatusOf(inv) {
  const paid = inv.paid_amount || 0;
  if (paid <= 0) return "미납";
  if (paid >= (inv.amount || 0)) return "완납";
  return "부분납";
}

/** 연체: 발행 상태 + 마감 경과 + 잔금 존재. */
function isOverdue(inv) {
  return inv.status === "발행" && !!inv.due_date && todayYmd() > inv.due_date && balanceOf(inv) > 0;
}

// 금액 파싱은 lib/forms.parseMoney로 단일화(중복 구현 제거). 내부 호출명은 parseWon 유지.
const parseWon = parseMoney;

// ── 거래처(실결제자) ──
function listClients({ kind } = {}) {
  if (kind) {
    return db().prepare("SELECT * FROM clients WHERE kind = ? ORDER BY name COLLATE NOCASE").all(kind);
  }
  return db().prepare("SELECT * FROM clients ORDER BY name COLLATE NOCASE").all();
}

/** 분류별 거래처 수(탭 배지용). */
function clientKindCounts() {
  const rows = db().prepare("SELECT kind, COUNT(*) AS n FROM clients GROUP BY kind").all();
  const map = {};
  for (const r of rows) map[r.kind] = r.n;
  return map;
}
function getClient(id) {
  return db().prepare("SELECT * FROM clients WHERE id = ?").get(id);
}

/** 클라이언트가 관여한 프로젝트(아티스트/소속사/제작사 이름 매칭 또는 실결제자). */
function listProjectsForClient(client) {
  if (!client) return [];
  return db()
    .prepare(
      `SELECT p.*, c.name AS client_name FROM projects p
       LEFT JOIN clients c ON c.id = p.client_id
       WHERE p.artist = @name OR p.artist_company = @name OR p.production_company = @name OR p.client_id = @id
       ORDER BY p.created_at DESC, p.id DESC`
    )
    .all({ name: client.name, id: client.id });
}

/** 클라이언트가 실결제자(client_id)인 인보이스 전체 — 청구·결제 히스토리. */
function listInvoicesForClientEntity(client) {
  if (!client) return [];
  return db()
    .prepare(
      `SELECT i.*, p.title AS project_title FROM invoices i
       LEFT JOIN projects p ON p.id = i.project_id
       WHERE i.client_id = @id
       ORDER BY i.created_at DESC, i.id DESC`
    )
    .all({ id: client.id });
}

/** 외주 작업자 단건(project_managers 중 로그인 사용자와 미연결). */
function getWorker(id) {
  return db().prepare("SELECT * FROM project_managers WHERE id = ? AND user_id IS NULL").get(id) || null;
}

/** 외주 작업자가 담당한 작업(track_tasks) + 프로젝트/트랙 — 작업 히스토리·정산.
 *  매칭: engineer_id 우선(rename 내성), 폴백 (engineer_id IS NULL AND engineer_name = 이름)(레거시·미매칭분). */
function listTasksForWorker(worker) {
  if (!worker) return [];
  return db()
    .prepare(
      `SELECT t.*, tr.title AS track_title, p.id AS project_id, p.title AS project_title
       FROM track_tasks t
       JOIN project_tracks tr ON tr.id = t.track_id
       JOIN projects p ON p.id = tr.project_id
       WHERE t.engineer_id = @id OR (t.engineer_id IS NULL AND t.engineer_name = @name)
       ORDER BY t.created_at DESC, t.id DESC`
    )
    .all({ id: worker.id, name: worker.name });
}

/** 외주 작업자 작업의 지급 처리/해제(정산). 작업자 소속 확인 후 호출. */
function setTaskPayout(taskId, paid) {
  const p = paid ? 1 : 0;
  db().prepare("UPDATE track_tasks SET worker_paid = ?, worker_paid_date = ? WHERE id = ?").run(p, p ? todayYmd() : null, Number(taskId));
}
function clientOptions() {
  return db().prepare("SELECT id, name, kind FROM clients ORDER BY name COLLATE NOCASE").all();
}

/** 이름+분류로 클라이언트가 없으면 생성(있으면 무시). 프로젝트 입력값 자동 등록용. */
function ensureClient(name, kind) {
  const n = String(name || "").trim();
  if (!n) return;
  const k = normalizeClientKind(kind);
  const exists = db().prepare("SELECT id FROM clients WHERE name = ? AND kind = ?").get(n, k);
  if (!exists) db().prepare("INSERT INTO clients (name, kind) VALUES (?, ?)").run(n, k);
}

/** 프로젝트의 아티스트·소속사/레이블·제작사를 클라이언트 마스터에 자동 등록. */
function ensureClientsFromProject(p = {}) {
  ensureClient(p.artist, "아티스트");
  ensureClient(p.artist_company, "소속사/레이블");
  ensureClient(p.production_company, "제작사");
}

function listProjectManagers({ includeInactive = false, externalOnly = false } = {}) {
  const where = [];
  if (!includeInactive) where.push("active = 1");
  if (externalOnly) where.push("user_id IS NULL"); // 외주 작업자만(하우스 엔지니어 제외)
  return db()
    .prepare(
      `SELECT * FROM project_managers
       ${where.length ? "WHERE " + where.join(" AND ") : ""}
       ORDER BY active DESC, name COLLATE NOCASE`
    )
    .all();
}

// ── 연락처(클라이언트 측 담당자) + 소속 이력(이직 히스토리) ──
// 회사(clients)와 별개 '사람' 마스터. 소속은 contact_affiliations 타임라인(ended_on NULL=현재 소속).

const blankToNull = (v) => { const s = String(v == null ? "" : v).trim(); return s || null; };

function listContacts({ q } = {}) {
  const term = String(q || "").trim();
  if (term) {
    const like = `%${term}%`;
    return db().prepare("SELECT * FROM contacts WHERE name LIKE ? OR phone LIKE ? ORDER BY name COLLATE NOCASE").all(like, like);
  }
  return db().prepare("SELECT * FROM contacts ORDER BY name COLLATE NOCASE").all();
}

function getContact(id) {
  return db().prepare("SELECT * FROM contacts WHERE id = ?").get(Number(id)) || null;
}

function createContact({ name, phone, email, memo } = {}) {
  const n = String(name || "").trim();
  if (!n) throw new Error("CONTACT_NAME_REQUIRED");
  return db().prepare("INSERT INTO contacts (name, phone, email, memo) VALUES (?, ?, ?, ?)")
    .run(n, blankToNull(phone), blankToNull(email), blankToNull(memo)).lastInsertRowid;
}

function updateContact(id, { name, phone, email, memo } = {}) {
  const n = String(name || "").trim();
  if (!n) throw new Error("CONTACT_NAME_REQUIRED");
  db().prepare("UPDATE contacts SET name = ?, phone = ?, email = ?, memo = ? WHERE id = ?")
    .run(n, blankToNull(phone), blankToNull(email), blankToNull(memo), Number(id));
}

function deleteContact(id) {
  // 하드 삭제: affiliations는 CASCADE, projects.contact_id는 SET NULL([[delete-only-management]]).
  db().prepare("DELETE FROM contacts WHERE id = ?").run(Number(id));
}

/** 현재 소속(ended_on IS NULL, 가장 최근 1건) — 회사명·분류 조인. 무소속이면 client_* NULL. */
function currentAffiliation(contactId) {
  return db().prepare(
    `SELECT a.*, c.name AS client_name, c.kind AS client_kind
       FROM contact_affiliations a LEFT JOIN clients c ON c.id = a.client_id
      WHERE a.contact_id = ? AND a.ended_on IS NULL
      ORDER BY a.started_on DESC, a.id DESC LIMIT 1`
  ).get(Number(contactId)) || null;
}

/** 소속 이력 타임라인(현재 먼저, 그다음 시작일 최근순). */
function listAffiliations(contactId) {
  return db().prepare(
    `SELECT a.*, c.name AS client_name, c.kind AS client_kind
       FROM contact_affiliations a LEFT JOIN clients c ON c.id = a.client_id
      WHERE a.contact_id = ?
      ORDER BY (a.ended_on IS NULL) DESC, COALESCE(a.started_on, '') DESC, a.id DESC`
  ).all(Number(contactId));
}

/** 소속 추가. closeCurrent=true(기본)면 기존 현재 소속을 시작일(또는 오늘)로 종료 후 새 소속 INSERT — 이직 처리. */
function addAffiliation(contactId, { client_id, title, started_on, memo, closeCurrent = true } = {}) {
  const cid = Number(contactId);
  const start = blankToNull(started_on);
  if (closeCurrent) {
    db().prepare("UPDATE contact_affiliations SET ended_on = ? WHERE contact_id = ? AND ended_on IS NULL")
      .run(start || todayYmd(), cid);
  }
  return db().prepare(
    "INSERT INTO contact_affiliations (contact_id, client_id, title, started_on, memo) VALUES (?, ?, ?, ?, ?)"
  ).run(cid, client_id ? Number(client_id) : null, blankToNull(title), start, blankToNull(memo)).lastInsertRowid;
}

function endAffiliation(affId, endedOn) {
  db().prepare("UPDATE contact_affiliations SET ended_on = ? WHERE id = ?").run(blankToNull(endedOn) || todayYmd(), Number(affId));
}

function deleteAffiliation(affId) {
  db().prepare("DELETE FROM contact_affiliations WHERE id = ?").run(Number(affId));
}

/** 콤보용: 연락처 + 현재 소속 회사명(라벨 병기). */
function contactOptions() {
  return db().prepare(
    `SELECT ct.id, ct.name, ct.phone, ct.email,
            (SELECT c.name FROM contact_affiliations a LEFT JOIN clients c ON c.id = a.client_id
              WHERE a.contact_id = ct.id AND a.ended_on IS NULL
              ORDER BY a.started_on DESC, a.id DESC LIMIT 1) AS current_client
       FROM contacts ct ORDER BY ct.name COLLATE NOCASE`
  ).all();
}

/** 회사(client)의 현재 소속 연락처 — 클라이언트 상세용. */
function listContactsForClient(clientId) {
  return db().prepare(
    `SELECT ct.*, a.title AS aff_title FROM contact_affiliations a
       JOIN contacts ct ON ct.id = a.contact_id
      WHERE a.client_id = ? AND a.ended_on IS NULL
      ORDER BY ct.name COLLATE NOCASE`
  ).all(Number(clientId));
}

/** 연락처가 클라이언트 담당으로 연결된 프로젝트(연락처 상세용). */
function listProjectsForContact(contactId) {
  return db().prepare("SELECT * FROM projects WHERE contact_id = ? ORDER BY created_at DESC, id DESC").all(Number(contactId));
}

/** 연락처가 담당 디렉터로 지정된 세션(연락처 상세 '참여 세션' 섹션용). 최근순. */
function listSessionsForContact(contactId) {
  return db().prepare(
    `SELECT s.*, p.title AS project_title
       FROM sessions s
       JOIN projects p ON p.id = s.project_id
      WHERE s.director_contact_id = ?
      ORDER BY s.session_date DESC, s.start_time DESC, s.id DESC`
  ).all(Number(contactId));
}

// ── 룸(스튜디오 공간) — 룸별 겹침 검사. 치프가 /settings에서 CRUD ──

/** 활성(또는 전체) 룸 목록. 정렬: sort_order → 이름. */
function listRooms({ includeInactive = false } = {}) {
  return db()
    .prepare(
      `SELECT * FROM rooms
       ${includeInactive ? "" : "WHERE active = 1"}
       ORDER BY sort_order ASC, name COLLATE NOCASE`
    )
    .all();
}

function createRoom(input = {}) {
  const name = String(input.name || "").trim();
  if (!name) throw new Error("ROOM_NAME_REQUIRED");
  const sort = Number.isFinite(Number(input.sort_order)) ? Number(input.sort_order) : 0;
  const info = db().prepare("INSERT INTO rooms (name, sort_order, active) VALUES (?, ?, 1)").run(name, sort);
  return db().prepare("SELECT * FROM rooms WHERE id = ?").get(info.lastInsertRowid);
}

/** 룸 삭제(하드). FK가 없으므로 참조 세션의 room_id를 먼저 NULL로(SET NULL 의미) 정리한 뒤 행 삭제. */
function deleteRoom(id) {
  const rid = Number(id);
  const d = db();
  d.exec("BEGIN IMMEDIATE;");
  try {
    d.prepare("UPDATE sessions SET room_id = NULL WHERE room_id = ?").run(rid);
    d.prepare("DELETE FROM rooms WHERE id = ?").run(rid);
    d.exec("COMMIT;");
  } catch (e) {
    d.exec("ROLLBACK;");
    throw e;
  }
}

// ── 단가표(과금 항목) ──

/** 시간(소수, "3.5") → 분. 빈 값/0 이하면 0. */
function parseHoursToMinutes(v) {
  const n = Number(String(v == null ? "" : v).replace(",", "."));
  return Number.isFinite(n) && n > 0 ? Math.round(n * 60) : 0;
}

function rateFields(input) {
  return {
    name: String(input.name || "").trim(),
    category: normalizeRecordingCategory(input.category),
    base_minutes: parseHoursToMinutes(input.base_hours),
    base_price: parseWon(input.base_price),
    extra_minutes: parseHoursToMinutes(input.extra_hours) || 60,
    extra_price: parseWon(input.extra_price),
  };
}

function listRateItems({ includeInactive = false } = {}) {
  return db()
    .prepare(
      `SELECT * FROM rate_items
       ${includeInactive ? "" : "WHERE active = 1"}
       ORDER BY active DESC, name COLLATE NOCASE`
    )
    .all();
}

function createRateItem(input = {}) {
  const f = rateFields(input);
  if (!f.name) throw new Error("RATE_NAME_REQUIRED");
  if (!f.base_price && !f.extra_price) throw new Error("RATE_PRICE_REQUIRED"); // 기준가·초과가 모두 0인 단가 항목 생성 방지
  const info = db()
    .prepare(
      `INSERT INTO rate_items (name, category, base_minutes, base_price, extra_minutes, extra_price, active)
       VALUES (@name,@category,@base_minutes,@base_price,@extra_minutes,@extra_price,1)`
    )
    .run(f);
  return db().prepare("SELECT * FROM rate_items WHERE id = ?").get(info.lastInsertRowid);
}

function updateRateItem(id, input = {}) {
  const f = rateFields(input);
  if (!f.name) throw new Error("RATE_NAME_REQUIRED");
  if (!f.base_price && !f.extra_price) throw new Error("RATE_PRICE_REQUIRED"); // 기준가·초과가 모두 0인 단가 항목 생성 방지
  db()
    .prepare(
      `UPDATE rate_items SET name=@name, category=@category, base_minutes=@base_minutes, base_price=@base_price,
       extra_minutes=@extra_minutes, extra_price=@extra_price WHERE id=@id`
    )
    .run({ id, ...f });
  return db().prepare("SELECT * FROM rate_items WHERE id = ?").get(id);
}

function deleteRateItem(id) {
  db().prepare("DELETE FROM rate_items WHERE id = ?").run(id);
}

/**
 * 진행 분(minutes)에 대한 자동 산정 금액(3단계에서 사용).
 * - 기준 시간 이내 → 기준가. 초과분은 초과 단위(분)로 올림하여 단위당 과금.
 * - base_minutes=0이면 시간 무관 정액(base_price).
 */
function computeRatePrice(item, minutes) {
  if (!item) return 0;
  const m = Math.max(0, Number(minutes) || 0);
  if (item.base_minutes <= 0 || m <= item.base_minutes) return item.base_price;
  const unit = item.extra_minutes > 0 ? item.extra_minutes : 60;
  const units = Math.ceil((m - item.base_minutes) / unit);
  return item.base_price + units * item.extra_price;
}

// ── 작업 종류 카탈로그(task_types) — config.TASK_TYPES 시드, DB가 단일 진실원천 ──
// 라벨·그룹 해석은 자주 호출되므로 모듈 캐시(쓰기 시 무효화)로 동기 접근.
let _taskTypeCache = null;
function taskTypeCache() {
  if (_taskTypeCache) return _taskTypeCache;
  const rows = db().prepare("SELECT * FROM task_types ORDER BY active DESC, sort_order, label COLLATE NOCASE").all();
  _taskTypeCache = { rows, byKey: new Map(rows.map((r) => [r.key, r])) };
  return _taskTypeCache;
}
function invalidateTaskTypeCache() {
  _taskTypeCache = null;
}
/** 관리용 전체 목록(설정 화면). 캐시 사용. */
function listTaskTypes({ includeInactive = false } = {}) {
  const rows = taskTypeCache().rows;
  return includeInactive ? rows : rows.filter((r) => r.active);
}
/** 활성 종류(작업 폼 옵션·빠른추가 출처). */
function activeTaskTypes() {
  return taskTypeCache().rows.filter((r) => r.active);
}
/** key → 표시 라벨(없으면 key 폴백 — 삭제된 종류의 과거 작업도 깨지지 않게). */
function taskTypeLabel(key) {
  const r = taskTypeCache().byKey.get(key);
  return (r && r.label) || key;
}
/** key → 분류(그룹). 없으면 '기타'. */
function taskTypeGroup(key) {
  const r = taskTypeCache().byKey.get(key);
  return (r && r.task_group) || "기타";
}
/** 카탈로그에 있는 key면 통과, 없으면 첫 활성 종류로 폴백(없으면 raw 유지). 신규 종류도 정규화 통과. */
function normalizeTaskTypeDb(key) {
  const k = String(key || "").trim();
  if (taskTypeCache().byKey.has(k)) return k;
  const first = activeTaskTypes()[0];
  return first ? first.key : k;
}

function taskTypeFields(input) {
  return {
    label: String(input.label || "").trim(),
    task_group: normalizeTaskGroup(input.task_group),
    billing_type: normalizeBillingType(input.billing_type),
    unit_price: parseWon(input.unit_price),
    is_quick: input.is_quick ? 1 : 0,
    sort_order: Number.isFinite(Number(input.sort_order)) ? Number(input.sort_order) : 100,
  };
}
function createTaskType(input = {}) {
  const f = taskTypeFields(input);
  if (!f.label) throw new Error("TASK_TYPE_LABEL_REQUIRED");
  const key = `tt_${crypto.randomBytes(5).toString("hex")}`; // 안정 불투명 key(라벨 변경에도 불변)
  db()
    .prepare(
      `INSERT INTO task_types (key, label, task_group, billing_type, unit_price, is_quick, sort_order, active)
       VALUES (@key,@label,@task_group,@billing_type,@unit_price,@is_quick,@sort_order,1)`
    )
    .run({ key, ...f });
  invalidateTaskTypeCache();
}
function updateTaskType(id, input = {}) {
  const f = taskTypeFields(input);
  if (!f.label) throw new Error("TASK_TYPE_LABEL_REQUIRED");
  db()
    .prepare(
      `UPDATE task_types SET label=@label, task_group=@task_group, billing_type=@billing_type,
       unit_price=@unit_price, is_quick=@is_quick, sort_order=@sort_order WHERE id=@id`
    )
    .run({ id, ...f });
  invalidateTaskTypeCache();
}
/** 강제 삭제(연결 가드 없음, 사용자 결정). 과거 track_tasks는 key 문자열을 유지(라벨만 폴백). */
function deleteTaskType(id) {
  db().prepare("DELETE FROM task_types WHERE id = ?").run(id);
  invalidateTaskTypeCache();
}

// ── 프로젝트(클라이언트 범위 강제) ──

/**
 * 프로젝트 목록(로그인 직원 전체 열람). 필터(service/clientId/q)는 옵션.
 * @returns {Array}
 */
/** 프로젝트 폼 자동완성용 — 기존 프로젝트의 아티스트·소속사/레이블·제작사 중복 제거 목록. */
function distinctProjectFields() {
  const col = (c) =>
    db()
      .prepare(`SELECT DISTINCT ${c} AS v FROM projects WHERE ${c} IS NOT NULL AND TRIM(${c}) <> '' ORDER BY ${c} COLLATE NOCASE`)
      .all()
      .map((r) => r.v);
  return { artists: col("artist"), companies: col("artist_company"), productions: col("production_company") };
}

/** 프로젝트 ID 배열의 녹음 세션 금액 합계 맵(단가표 산정, 취소 제외). 내부 헬퍼. */
function sessionAmountsByProject(projectIds) {
  if (!projectIds || !projectIds.length) return {};
  const placeholders = projectIds.map(() => "?").join(",");
  const rows = db()
    .prepare(
      `SELECT s.project_id, s.start_time, s.end_time,
              ri.base_minutes, ri.base_price, ri.extra_minutes, ri.extra_price
       FROM sessions s
       JOIN rate_items ri ON ri.id = s.rate_item_id
       WHERE s.project_id IN (${placeholders})
         AND s.session_type = '녹음'
         AND s.rate_item_id IS NOT NULL
         AND s.start_time IS NOT NULL AND s.end_time IS NOT NULL
         AND s.status <> '취소'`
    )
    .all(...projectIds);
  const sums = {};
  for (const row of rows) {
    const mins = minutesBetween(row.start_time, row.end_time);
    if (mins <= 0) continue;
    sums[row.project_id] = (sums[row.project_id] || 0) + computeRatePrice(row, mins);
  }
  return sums;
}

// 라우트는 filters 객체(service/clientId/q)를 넘기지만 목록 UI는 검색(q)만 사용 → q만 처리(나머지 인자는 무시).
function listProjects(_user, { q } = {}) {
  const where = [];
  const params = {};

  if (q) {
    where.push("(p.title LIKE @q OR p.artist LIKE @q)");
    params.q = `%${q}%`;
  }

  const sql = `
    SELECT p.*, c.name AS client_name, m.name AS manager_name,
      (SELECT GROUP_CONCAT(tr.title, '||') FROM project_tracks tr WHERE tr.project_id = p.id) AS track_titles,
      (SELECT COALESCE(SUM(t.total_price), 0)
       FROM track_tasks t
       JOIN project_tracks tr ON tr.id = t.track_id
       WHERE tr.project_id = p.id) AS task_total
    FROM projects p
    LEFT JOIN clients c ON c.id = p.client_id
    LEFT JOIN project_managers m ON m.id = p.manager_id
    ${where.length ? "WHERE " + where.join(" AND ") : ""}
    ORDER BY
      CASE WHEN p.due_date IS NULL OR p.due_date = '' THEN 1 ELSE 0 END,
      p.due_date ASC,
      p.created_at DESC`;
  const rows = db().prepare(sql).all(params);
  if (!rows.length) return rows;
  const sessionAmounts = sessionAmountsByProject(rows.map((r) => r.id));
  return rows.map((r) => ({ ...r, session_amount_total: sessionAmounts[r.id] || 0 }));
}

/** 단건 조회 + 권한 검사. 권한 없으면 null(클라이언트가 타 프로젝트 접근 시도 시 404 처리용). */
function getProjectForUser(user, id) {
  const row = db()
    .prepare(
      `SELECT p.*, c.name AS client_name, m.name AS manager_name, ct.name AS contact_name, ct.phone AS contact_phone, tr_sum.track_titles, task_sum.task_total FROM projects p
       LEFT JOIN clients c ON c.id = p.client_id
       LEFT JOIN project_managers m ON m.id = p.manager_id
       LEFT JOIN contacts ct ON ct.id = p.contact_id
       LEFT JOIN (
         SELECT project_id, GROUP_CONCAT(title, '||') AS track_titles
         FROM project_tracks
         GROUP BY project_id
       ) tr_sum ON tr_sum.project_id = p.id
       LEFT JOIN (
         SELECT tr.project_id, COALESCE(SUM(t.total_price), 0) AS task_total
         FROM project_tracks tr
         LEFT JOIN track_tasks t ON t.track_id = tr.id
         GROUP BY tr.project_id
       ) task_sum ON task_sum.project_id = p.id
       WHERE p.id = ?`
    )
    .get(id);
  if (!row) return null;
  const sessionAmounts = sessionAmountsByProject([row.id]);
  return { ...row, session_amount_total: sessionAmounts[row.id] || 0 };
}

// ── 트랙/콘텐츠 + 모듈형 작업(Task) ──

function listTracksForProject(user, projectId) {
  const project = getProjectForUser(user, projectId);
  if (!project) return null;
  const tracks = db()
    .prepare("SELECT * FROM project_tracks WHERE project_id = ? ORDER BY created_at ASC, id ASC")
    .all(project.id);
  const tasks = db()
    .prepare(
      `SELECT t.*, tr.project_id, tr.title AS track_title, tr.content_type
       FROM track_tasks t
       JOIN project_tracks tr ON tr.id = t.track_id
       WHERE tr.project_id = ?
       ORDER BY tr.created_at ASC, tr.id ASC, t.created_at ASC, t.id ASC`
    )
    .all(project.id);
  const byTrack = new Map();
  for (const task of tasks) {
    if (!byTrack.has(task.track_id)) byTrack.set(task.track_id, []);
    byTrack.get(task.track_id).push(task);
  }
  return { project, tracks: tracks.map((track) => ({ ...track, tasks: byTrack.get(track.id) || [] })) };
}

function getTrackForUser(user, trackId) {
  const track = db()
    .prepare(
      `SELECT tr.*, p.client_id, p.title AS project_title
       FROM project_tracks tr
       JOIN projects p ON p.id = tr.project_id
       WHERE tr.id = ?`
    )
    .get(trackId);
  return track || null;
}

function createTrack(user, projectId, input = {}) {
  const project = getProjectForUser(user, projectId);
  if (!project) return null;
  const title = String(input.title || "").trim();
  if (!title) throw new Error("TRACK_TITLE_REQUIRED");
  const info = db()
    .prepare("INSERT INTO project_tracks (project_id, title, content_type) VALUES (?, ?, ?)")
    .run(project.id, title, normalizeTrackContentType(input.content_type));
  return db().prepare("SELECT * FROM project_tracks WHERE id = ?").get(info.lastInsertRowid);
}

function updateTrack(user, trackId, input = {}) {
  const track = getTrackForUser(user, trackId);
  if (!track) return null;
  const title = String(input.title || "").trim();
  if (!title) throw new Error("TRACK_TITLE_REQUIRED");
  db()
    .prepare("UPDATE project_tracks SET title = ?, content_type = ? WHERE id = ?")
    .run(title, normalizeTrackContentType(input.content_type), track.id);
  return db().prepare("SELECT * FROM project_tracks WHERE id = ?").get(track.id);
}

/** 트랙 삭제. 청구된 작업이 하나라도 있으면 거부(인보이스 스냅샷 정합성). */
function deleteTrack(user, trackId) {
  const track = getTrackForUser(user, trackId);
  if (!track) return null;
  const invoiced = db()
    .prepare("SELECT COUNT(*) AS n FROM track_tasks WHERE track_id = ? AND is_invoiced = 1")
    .get(track.id).n;
  if (invoiced > 0) throw new Error("TRACK_HAS_INVOICED");
  db().prepare("DELETE FROM project_tracks WHERE id = ?").run(track.id); // track_tasks는 CASCADE
  return { project_id: track.project_id };
}

function getTaskForUser(user, taskId) {
  const task = db()
    .prepare(
      `SELECT t.*, tr.project_id, tr.title AS track_title, tr.content_type, p.client_id
       FROM track_tasks t
       JOIN project_tracks tr ON tr.id = t.track_id
       JOIN projects p ON p.id = tr.project_id
       WHERE t.id = ?`
    )
    .get(taskId);
  return task || null;
}

/**
 * 작업 폼의 engineer_id(담당자 마스터 id) → { engineer_id, engineer_name } 결정.
 *  - 숫자 id면 그 manager로 id+name 동기 기록(표시·정산 매칭·레거시 호환).
 *  - 'legacy'면 제출된 engineer_name(레거시 자유입력) 보존(engineer_id는 NULL → 이름 폴백 정산).
 *  - 그 외(빈 값·미지정)면 둘 다 NULL.
 */
function resolveTaskEngineer(input) {
  const raw = String(input.engineer_id == null ? "" : input.engineer_id).trim();
  if (/^\d+$/.test(raw)) {
    const m = db().prepare("SELECT id, name, user_id FROM project_managers WHERE id = ?").get(Number(raw));
    if (m) return { engineer_id: m.id, engineer_name: m.name, is_external: !m.user_id }; // user_id 없으면 외주 작업자
  }
  if (raw === "legacy") {
    return { engineer_id: null, engineer_name: String(input.engineer_name || "").trim() || null, is_external: true };
  }
  return { engineer_id: null, engineer_name: null, is_external: false };
}

/** 작업 수정. 이미 청구된 작업은 거부(라인아이템 스냅샷이 잠금). total_price는 재계산. */
function updateTask(user, taskId, input = {}) {
  const task = getTaskForUser(user, taskId);
  if (!task) return null;
  if (task.is_invoiced) throw new Error("TASK_LOCKED");
  // 후반작업은 전부 트랙/콘텐츠 고정(곡 1건당) — billing_type='Fixed_Per_Track'·quantity=1 고정, 금액(unit_price)만 직접 입력.
  const unitPrice = parseWon(input.unit_price);
  const eng = resolveTaskEngineer(input);
  db()
    .prepare(
      `UPDATE track_tasks SET
         task_type = @task_type, billing_type = 'Fixed_Per_Track', quantity = 1,
         unit_price = @unit_price, total_price = @unit_price, engineer_name = @engineer_name,
         engineer_id = @engineer_id, worker_rate = @worker_rate, status = @status
       WHERE id = @id`
    )
    .run({
      id: task.id,
      task_type: normalizeTaskTypeDb(input.task_type),
      unit_price: unitPrice,
      engineer_name: eng.engineer_name,
      engineer_id: eng.engineer_id,
      worker_rate: eng.is_external ? parseWon(input.worker_rate) : 0, // 하우스 엔지니어·미지정은 외주 지급단가 없음(0, NOT NULL 컬럼)
      status: normalizeTaskStatus(input.status),
    });
  return db().prepare("SELECT t.*, tr.project_id FROM track_tasks t JOIN project_tracks tr ON tr.id = t.track_id WHERE t.id = ?").get(task.id);
}

/** 프로젝트 삭제. 청구된 작업·세션이 있으면 거부(매출 추적 보존, deleteTrack과 정합). */
function deleteProject(projectId) {
  const pid = Number(projectId);
  const invoicedTask = db()
    .prepare("SELECT 1 FROM track_tasks t JOIN project_tracks tr ON tr.id = t.track_id WHERE tr.project_id = ? AND t.is_invoiced = 1 LIMIT 1")
    .get(pid);
  const invoicedSession = db()
    .prepare("SELECT 1 FROM invoice_items ii JOIN sessions s ON s.id = ii.session_id WHERE s.project_id = ? LIMIT 1")
    .get(pid);
  if (invoicedTask || invoicedSession) throw new Error("PROJECT_HAS_INVOICED");
  db().prepare("DELETE FROM projects WHERE id = ?").run(pid);
}

function deleteTask(user, taskId) {
  const task = getTaskForUser(user, taskId);
  if (!task) return null;
  if (task.is_invoiced) throw new Error("TASK_LOCKED");
  db().prepare("DELETE FROM track_tasks WHERE id = ?").run(task.id);
  return { project_id: task.project_id };
}

function createTask(user, trackId, input = {}) {
  const track = getTrackForUser(user, trackId);
  if (!track) return null;
  // 후반작업은 전부 트랙/콘텐츠 고정 — billing_type·quantity 고정, 금액(unit_price=total_price)만 직접 입력.
  const unitPrice = parseWon(input.unit_price);
  const taskType = normalizeTaskTypeDb(input.task_type);
  const eng = resolveTaskEngineer(input);
  const info = db()
    .prepare(
      `INSERT INTO track_tasks
       (track_id, task_type, billing_type, quantity, unit_price, total_price, engineer_name, engineer_id, worker_rate, status, is_invoiced)
       VALUES (@track_id, @task_type, 'Fixed_Per_Track', 1, @unit_price, @unit_price, @engineer_name, @engineer_id, @worker_rate, @status, 0)`
    )
    .run({
      track_id: track.id,
      task_type: taskType,
      unit_price: unitPrice,
      engineer_name: eng.engineer_name,
      engineer_id: eng.engineer_id,
      worker_rate: eng.is_external ? parseWon(input.worker_rate) : 0, // 하우스 엔지니어·미지정은 외주 지급단가 없음(0, NOT NULL 컬럼)
      status: normalizeTaskStatus(input.status),
    });
  return db().prepare("SELECT * FROM track_tasks WHERE id = ?").get(info.lastInsertRowid);
}

function listUnbilledTasksForProject(user, projectId) {
  const project = getProjectForUser(user, projectId);
  if (!project) return null;
  const rows = db()
    .prepare(
      `SELECT t.*, tr.title AS track_title, tr.content_type, tr.project_id
       FROM track_tasks t
       JOIN project_tracks tr ON tr.id = t.track_id
       WHERE tr.project_id = ?
         AND t.is_invoiced = 0
         AND t.total_price > 0
       ORDER BY tr.created_at ASC, tr.id ASC, t.created_at ASC, t.id ASC`
    )
    .all(project.id);
  return { project, rows };
}

/** 청구 가능 녹음 세션(**완료**·녹음+단가+시간) 중 아직 청구/전환 안 된 것 — 세션 직접 청구 후보(완료 처리해야 노출). */
function listBillableSessionsForProject(user, projectId) {
  const project = getProjectForUser(user, projectId);
  if (!project) return null;
  const rows = db()
    .prepare(
      `SELECT s.* FROM sessions s
       WHERE s.project_id = ?
         AND s.status = '완료'
         AND s.session_type = '녹음'
         AND s.rate_item_id IS NOT NULL
         AND s.start_time IS NOT NULL AND s.end_time IS NOT NULL
         AND NOT EXISTS (SELECT 1 FROM invoice_items ii WHERE ii.session_id = s.id)
         AND NOT EXISTS (SELECT 1 FROM track_tasks tt WHERE tt.session_id = s.id)
       ORDER BY s.session_date ASC, s.start_time ASC, s.id ASC`
    )
    .all(project.id)
    .map((row) => ({ ...row, billing: sessionRateAmount(row) }))
    .filter((row) => row.billing && row.billing.amount > 0);
  return { project, rows };
}

/** 세션이 인보이스에 직접 청구되었는지(invoice_items 역참조). 세션 수정·삭제 잠금 판별. */
function isSessionInvoiced(sessionId) {
  return !!db().prepare("SELECT 1 FROM invoice_items WHERE session_id = ? LIMIT 1").get(sessionId);
}

function listInvoiceItemsForInvoice(user, invoiceId) {
  const inv = getInvoiceForUser(user, invoiceId);
  if (!inv) return null;
  const rows = db()
    .prepare("SELECT * FROM invoice_items WHERE invoice_id = ? ORDER BY id ASC")
    .all(inv.id);
  return { invoice: inv, rows };
}

function nextInvoiceNumber(issueDate) {
  const ym = String(issueDate || todayYmd()).slice(0, 7).replace("-", "");
  const prefix = `INV-${ym}-`;
  const row = db()
    .prepare("SELECT invoice_number FROM invoices WHERE invoice_number LIKE ? ORDER BY invoice_number DESC LIMIT 1")
    .get(prefix + "%");
  const last = row && row.invoice_number ? parseInt(row.invoice_number.slice(prefix.length), 10) : 0;
  return prefix + String((Number.isFinite(last) ? last : 0) + 1).padStart(3, "0");
}

// ── 공급자(스튜디오) 세금정보 — admin_state 평문(비밀 아님, studio_location과 동급) ──
const STUDIO_INFO_KEYS = ["studio_biz_name", "studio_biz_no", "studio_owner_name", "studio_address", "studio_biz_type", "studio_biz_item", "studio_tel"];
function getStudioInfo() {
  const out = {};
  for (const k of STUDIO_INFO_KEYS) out[k] = getState(k) || "";
  return out;
}
function setStudioInfo(body = {}) {
  for (const k of STUDIO_INFO_KEYS) setState(k, String(body[k] || "").trim() || null);
}

/** 거래명세서 로고 — base64 data URI(admin_state.studio_logo). 없으면 null. */
function getStudioLogo() {
  return getState("studio_logo") || null;
}
function setStudioLogo(dataUri) {
  setState("studio_logo", dataUri ? String(dataUri) : null);
}

// ── 스튜디오 운영시간(예약 그리드 범위) — admin_state 평문. 환경설정에서 조정(UI는 다른 레인) ──
const DEFAULT_STUDIO_HOURS = { start: "14:00", end: "18:30" }; // 기존 SESSION_START_SLOTS와 동일 기본값

/** 예약 그리드 시작/종료 시각('HH:MM'). 미설정/무효면 기본값. */
function getStudioHours() {
  return {
    start: cleanTime(getState("studio_hours_start")) || DEFAULT_STUDIO_HOURS.start,
    end: cleanTime(getState("studio_hours_end")) || DEFAULT_STUDIO_HOURS.end,
  };
}

/** 운영시간 저장(형식 검증만; 무효값은 null로 → 기본값 폴백). */
function setStudioHours(start, end) {
  setState("studio_hours_start", cleanTime(start) || null);
  setState("studio_hours_end", cleanTime(end) || null);
}

/** 기본 예약 담당자(이름) — 세션 폼에서 예약 담당자 기본 선택. 미설정이면 null. */
function getDefaultBooker() {
  return getState("default_booker") || null;
}
function setDefaultBooker(name) {
  setState("default_booker", String(name || "").trim() || null);
}

/** 운영시간 기반 30분 시작 슬롯 배열(예약 그리드). 무효/역전 범위면 기본 그리드(SESSION_START_SLOTS). */
function studioStartSlots() {
  const { start, end } = getStudioHours();
  const sm = timeToMin(start), em = timeToMin(end);
  if (sm == null || em == null || em < sm) return [...SESSION_START_SLOTS];
  return timeSlots(sm, em);
}

/** 발행/입금완료로 전이 시 채번 보장(수동 발행분도 INV-YYYYMM-### 부여). 거래명세서에 번호 필수. */
function ensureInvoiceNumber(inv) {
  if (!inv || inv.invoice_number) return inv;
  if (inv.status !== "발행" && inv.status !== "입금완료") return inv;
  const number = nextInvoiceNumber(inv.issued_date || todayYmd());
  db().prepare("UPDATE invoices SET invoice_number=? WHERE id=?").run(number, inv.id);
  return { ...inv, invoice_number: number };
}

function createInvoiceFromTasks(user, { projectId, taskIds, sessionIds, clientId, issueDate, dueDate, title } = {}) {
  const project = getProjectForUser(user, projectId);
  if (!project || !canInvoice(user)) return null;
  const selectedTasks = Array.isArray(taskIds) ? taskIds.map(Number).filter(Boolean) : [];
  const selectedSessions = Array.isArray(sessionIds) ? sessionIds.map(Number).filter(Boolean) : [];
  if (!selectedTasks.length && !selectedSessions.length) throw new Error("TASK_IDS_REQUIRED");

  let tasks = [];
  if (selectedTasks.length) {
    const placeholders = selectedTasks.map(() => "?").join(",");
    tasks = db()
      .prepare(
        `SELECT t.*, tr.title AS track_title, tr.content_type, tr.project_id
         FROM track_tasks t
         JOIN project_tracks tr ON tr.id = t.track_id
         WHERE tr.project_id = ?
           AND t.is_invoiced = 0
           AND t.id IN (${placeholders})
         ORDER BY tr.created_at ASC, tr.id ASC, t.created_at ASC, t.id ASC`
      )
      .all(project.id, ...selectedTasks);
    if (tasks.length !== selectedTasks.length) throw new Error("TASK_NOT_BILLABLE");
  }

  // 녹음 세션 직접 청구분: 청구 가능(녹음+단가+시간)·미청구·미전환만 허용. 금액은 단가표로 재산정(스냅샷).
  let billSessions = [];
  if (selectedSessions.length) {
    const placeholders = selectedSessions.map(() => "?").join(",");
    const rawSessions = db()
      .prepare(
        `SELECT s.* FROM sessions s
         WHERE s.project_id = ?
           AND s.status = '완료' AND s.session_type = '녹음'
           AND s.rate_item_id IS NOT NULL AND s.start_time IS NOT NULL AND s.end_time IS NOT NULL
           AND s.id IN (${placeholders})
           AND NOT EXISTS (SELECT 1 FROM invoice_items ii WHERE ii.session_id = s.id)
           AND NOT EXISTS (SELECT 1 FROM track_tasks tt WHERE tt.session_id = s.id)`
      )
      .all(project.id, ...selectedSessions);
    billSessions = rawSessions
      .map((s) => ({ session: s, calc: sessionRateAmount(s) }))
      .filter((x) => x.calc && x.calc.amount > 0);
    if (billSessions.length !== selectedSessions.length) throw new Error("TASK_NOT_BILLABLE");
  }

  const d = db();
  const subtotal =
    tasks.reduce((sum, task) => sum + (task.total_price || 0), 0) +
    billSessions.reduce((sum, x) => sum + x.calc.amount, 0);
  const tax = Math.round(subtotal * 0.1);
  const total = subtotal + tax;
  const issued = issueDate || todayYmd();
  const invoiceTitle = String(title || "").trim() || `${project.title} 청구`;
  const invoiceNumber = nextInvoiceNumber(issued);

  d.exec("BEGIN IMMEDIATE;");
  try {
    const info = d
      .prepare(
        `INSERT INTO invoices
         (project_id, client_id, title, invoice_number, amount, tax_amount, paid_amount, status, issued_date, due_date, memo)
         VALUES (@project_id, @client_id, @title, @invoice_number, @amount, @tax_amount, 0, '발행', @issued_date, @due_date, @memo)`
      )
      .run({
        project_id: project.id,
        client_id: (clientId ? Number(clientId) : null) || project.client_id || null,
        title: invoiceTitle,
        invoice_number: invoiceNumber,
        amount: total,
        tax_amount: tax,
        issued_date: issued,
        due_date: dueDate || null,
        memo: "완료된 미청구 작업에서 자동 생성",
      });
    const invoiceId = info.lastInsertRowid;
    const insertItem = d.prepare(
      `INSERT INTO invoice_items
       (invoice_id, task_id, session_id, track_title, task_type, description, quantity, unit_price, amount)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    );
    const markTask = d.prepare("UPDATE track_tasks SET is_invoiced = 1, invoice_id = ? WHERE id = ?");
    for (const task of tasks) {
      const taskLabel = taskTypeLabel(task.task_type);
      const description = `${task.track_title} - ${taskLabel}`;
      insertItem.run(
        invoiceId, task.id, null,
        task.track_title, task.task_type, description,
        task.quantity, task.unit_price, task.total_price
      );
      markTask.run(invoiceId, task.id);
    }
    // 녹음 세션 직접 청구 라인: 곡·콘텐츠 없이 invoice_items에 스냅샷(session_id로 잠김). quantity=1·unit_price=amount.
    for (const { session, calc } of billSessions) {
      const hh = Math.floor(calc.minutes / 60), mm = calc.minutes % 60;
      const description = `녹음 세션 ${formatYmdShort(session.session_date)} · ${calc.item.name} (${hh}시간${mm ? " " + mm + "분" : ""})`;
      insertItem.run(invoiceId, null, session.id, null, null, description, 1, calc.amount, calc.amount);
    }
    d.exec("COMMIT;");
    return getInvoiceForUser(user, invoiceId);
  } catch (e) {
    d.exec("ROLLBACK;");
    throw e;
  }
}

/**
 * 청구 삭제. 연결된 작업의 잠금(is_invoiced)을 먼저 해제한 뒤 삭제해야 좀비 작업이 안 생긴다.
 * (FK는 invoice_id만 SET NULL로 지울 뿐 is_invoiced=1은 남으므로 명시적 UPDATE 필요.)
 */
function deleteInvoice(user, id) {
  if (!canInvoice(user)) return null;
  const inv = db().prepare("SELECT id FROM invoices WHERE id = ?").get(id);
  if (!inv) return null;
  const d = db();
  d.exec("BEGIN IMMEDIATE;");
  try {
    d.prepare("UPDATE track_tasks SET is_invoiced = 0, invoice_id = NULL WHERE invoice_id = ?").run(id);
    d.prepare("DELETE FROM invoices WHERE id = ?").run(id); // invoice_items는 FK CASCADE
    d.exec("COMMIT;");
    return { id };
  } catch (e) {
    d.exec("ROLLBACK;");
    throw e;
  }
}

// ── 대시보드 통계 ──
// 전 직원이 프로젝트/마감을 본다. 청구(미수금·연체)는 청구권자(치프/대표), 클라이언트 수는 치프에게 노출.
function dashboardStats(user) {
  const d = db();
  const total = d.prepare("SELECT COUNT(*) AS n FROM projects").get().n;
  const showInvoices = canInvoice(user);
  const showClients = isChief(user);
  return {
    canInvoice: showInvoices,
    isChief: showClients,
    total,
    clients: showClients ? d.prepare("SELECT COUNT(*) AS n FROM clients").get().n : null,
    invoices: showInvoices ? invoiceStats(user) : null,
  };
}

// ── 청구(invoices) — 클라이언트 범위 강제 ──

/** 인보이스 목록(치프 전용 라우트에서 사용). 필터(status/overdue/clientId)는 옵션. */
function listInvoices(_user, { status, overdue, clientId } = {}) {
  const where = [];
  const params = {};
  if (status) {
    where.push("i.status = @status");
    params.status = status;
  }
  if (clientId) {
    where.push("i.client_id = @clientId");
    params.clientId = Number(clientId);
  }
  const sql = `
    SELECT i.*, p.title AS project_title, c.name AS client_name
    FROM invoices i
    LEFT JOIN projects p ON p.id = i.project_id
    LEFT JOIN clients c ON c.id = i.client_id
    ${where.length ? "WHERE " + where.join(" AND ") : ""}
    ORDER BY
      CASE WHEN i.due_date IS NULL OR i.due_date = '' THEN 1 ELSE 0 END,
      i.due_date ASC, i.created_at DESC`;
  let rows = db().prepare(sql).all(params);
  if (overdue) rows = rows.filter(isOverdue); // 연체는 파생값이라 코드에서 필터
  return rows;
}

/** 단건 인보이스(치프 전용 라우트에서 사용). */
function getInvoiceForUser(_user, id) {
  const row = db()
    .prepare(
      `SELECT i.*, p.title AS project_title, c.name AS client_name
       FROM invoices i
       LEFT JOIN projects p ON p.id = i.project_id
       LEFT JOIN clients c ON c.id = i.client_id WHERE i.id = ?`
    )
    .get(id);
  return row || null;
}

/** 인보이스 요약 통계(미수금·이번 달 발행·연체). */
function invoiceStats(user) {
  const rows = listInvoices(user, {});
  const receivable = rows
    .filter((i) => i.status === "발행")
    .reduce((s, i) => s + balanceOf(i), 0);
  const month = todayYmd().slice(0, 7); // 'YYYY-MM'
  const thisMonthIssued = rows
    .filter((i) => i.status !== "미발행" && (i.issued_date || "").slice(0, 7) === month)
    .reduce((s, i) => s + (i.amount || 0), 0);
  const overdue = rows.filter(isOverdue);
  const overdueAmount = overdue.reduce((s, i) => s + balanceOf(i), 0);
  return { receivable, thisMonthIssued, overdueCount: overdue.length, overdueAmount, total: rows.length };
}

/** 프로젝트의 인보이스 목록(권한 검사). 권한 없으면 null. */
function listInvoicesForProject(user, projectId) {
  const project = getProjectForUser(user, projectId);
  if (!project) return null;
  const rows = db()
    .prepare(
      `SELECT i.*, c.name AS client_name FROM invoices i
       LEFT JOIN clients c ON c.id = i.client_id
       WHERE i.project_id = ? ORDER BY i.created_at DESC, i.id DESC`
    )
    .all(projectId);
  return { project, rows };
}

// ── 세션(스튜디오 일정) ──

/** 프로젝트의 세션 목록(날짜순). 권한 없으면 null. */
function listSessionsForProject(user, projectId) {
  const project = getProjectForUser(user, projectId);
  if (!project) return null;
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
 * custom_hours는 12시간(720분) 상한으로 클램프 — addMinutesToHHMM의 %1440 감김으로 종료시각이 왜곡되지 않게.
 */
function resolveEndTime(input, start) {
  if (!start || String(input.duration_mode || "") !== "custom") {
    return cleanTime(input.end_time_custom) || cleanTime(input.end_time);
  }
  const hours = parseFloat(input.custom_hours);
  if (!(hours > 0)) return cleanTime(input.end_time);
  const mins = Math.min(Math.round(hours * 60), 720); // 상한 12시간
  return addMinutesToHHMM(start, mins);
}

/** 활성 룸 id 집합에 있으면 그대로, 없거나 비어 있으면 null로. */
function validRoomId(raw) {
  const id = Number(raw) || null;
  if (!id) return null;
  return listRooms().some((r) => r.id === id) ? id : null;
}

function sessionFields(input) {
  const date = String(input.session_date || "").trim();
  if (!isValidYmd(date)) throw new Error("SESSION_DATE_REQUIRED");
  // 직접입력(그리드 밖 시간)이 있으면 우선, 없으면 그리드에서 고른 시작.
  const start = cleanTime(input.start_time_custom) || cleanTime(input.start_time);
  const rateItemId = Number(input.rate_item_id) || null;
  // 담당 디렉터(클라이언트 측 연락처): director_contact_id(목록 선택) 우선, 없고 director_name(새 이름) 있으면 새 연락처 생성.
  let directorContactId = Number(input.director_contact_id) || null;
  if (!directorContactId) {
    const dirName = String(input.director_name || "").trim();
    if (dirName) directorContactId = createContact({ name: dirName });
  }
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
    director_contact_id: directorContactId,
    memo: String(input.memo || "").trim() || null,
  };
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
      `SELECT start_time, end_time FROM sessions
       WHERE session_date = @date AND status <> '취소'
         AND start_time IS NOT NULL AND end_time IS NOT NULL AND id <> @excludeId ${roomClause}`
    )
    .all(params);
  const ranges = rows
    .map((r) => {
      const s = timeToMin(r.start_time);
      let e = timeToMin(r.end_time);
      if (s == null || e == null) return null;
      if (e <= s) e += 1440;
      return [s, e];
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
function findSessionConflict({ date, start, end, excludeId = null, room = null }) {
  const s = timeToMin(start);
  let e = timeToMin(end);
  if (!isValidYmd(date) || s == null || e == null) return null;
  if (e <= s) e += 1440; // end<=start면 야간(자정 넘김)
  const roomKey = Number(room) || 0;
  const rows = db()
    .prepare(
      `SELECT s.*, p.title AS project_title, rm.name AS room_name FROM sessions s
       JOIN projects p ON p.id = s.project_id
       LEFT JOIN rooms rm ON rm.id = s.room_id
       WHERE s.session_date = ? AND s.status <> '취소'
         AND s.start_time IS NOT NULL AND s.end_time IS NOT NULL
         AND IFNULL(s.room_id, 0) = ?
         AND s.id <> ?
       ORDER BY s.start_time`
    )
    .all(date, roomKey, excludeId == null ? -1 : excludeId);
  for (const r of rows) {
    const bs = timeToMin(r.start_time);
    let be = timeToMin(r.end_time);
    if (bs == null || be == null) continue;
    if (be <= bs) be += 1440;
    if (s < be && bs < e) return r; // 겹침
  }
  return null;
}

function assertNoSessionConflict(f, excludeId) {
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
  assertNoSessionConflict(f, null);
  const info = db()
    .prepare(
      `INSERT INTO sessions (project_id, session_type, session_date, start_time, end_time, booker_name, engineer_name, status, rate_item_id, room_id, director_contact_id, memo)
       VALUES (@project_id, @session_type, @session_date, @start_time, @end_time, @booker_name, @engineer_name, @status, @rate_item_id, @room_id, @director_contact_id, @memo)`
    )
    .run({ project_id: project.id, ...f });
  return db().prepare("SELECT * FROM sessions WHERE id = ?").get(info.lastInsertRowid);
}

function updateSession(user, sessionId, input = {}) {
  const s = getSessionForUser(user, sessionId);
  if (!s) return null;
  if (isSessionInvoiced(s.id)) throw new Error("SESSION_INVOICED");
  const f = sessionFields(input);
  assertNoSessionConflict(f, s.id);
  db()
    .prepare(
      `UPDATE sessions SET session_type=@session_type, session_date=@session_date, start_time=@start_time,
       end_time=@end_time, booker_name=@booker_name, engineer_name=@engineer_name, status=@status,
       rate_item_id=@rate_item_id, room_id=@room_id, director_contact_id=@director_contact_id, memo=@memo WHERE id=@id`
    )
    .run({ id: s.id, ...f });
  return { ...db().prepare("SELECT * FROM sessions WHERE id = ?").get(s.id), project_id: s.project_id };
}

/** 세션에 자동 생성한 구글 캘린더 일정 id 저장(null이면 해제). */
function setSessionEventId(sessionId, eventId) {
  db().prepare("UPDATE sessions SET gcal_event_id = ? WHERE id = ?").run(eventId || null, sessionId);
}

function setSessionStatus(user, sessionId, status) {
  const s = getSessionForUser(user, sessionId);
  if (!s) return null;
  if (isSessionInvoiced(s.id)) throw new Error("SESSION_INVOICED"); // 청구된 세션은 상태 되돌리기 금지(매출 정합)
  db().prepare("UPDATE sessions SET status=? WHERE id=?").run(normalizeSessionStatus(status), s.id);
  return { ...db().prepare("SELECT * FROM sessions WHERE id = ?").get(s.id), project_id: s.project_id };
}

function deleteSession(user, sessionId) {
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
      `SELECT s.*, p.title AS project_title FROM sessions s
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
      `SELECT s.*, p.title AS project_title FROM sessions s
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

// ── 자료 전달(deliverables) — 프로젝트 범위 강제 ──

/** 프로젝트의 자료 목록(권한 검사: 클라이언트는 자기 프로젝트만). 권한 없으면 null. */
function listDeliverablesForProject(user, projectId) {
  const project = getProjectForUser(user, projectId);
  if (!project) return null; // 404 처리용
  const rows = db()
    .prepare("SELECT * FROM deliverables WHERE project_id = ? ORDER BY created_at DESC, id DESC")
    .all(projectId);
  return { project, rows };
}

/** 단건 자료(로그인 직원 전체 열람). 소속 프로젝트가 있으면 존재만 확인. */
function getDeliverableForUser(user, id) {
  const row = db().prepare("SELECT * FROM deliverables WHERE id = ?").get(id);
  if (!row) return null;
  if (row.project_id != null && !getProjectForUser(user, row.project_id)) return null;
  return row;
}

/** 공개 토큰으로 단건 조회(로그인 불필요). 철회/만료 검사는 호출부에서. */
function getDeliverableByToken(token) {
  if (!token) return null;
  return db().prepare("SELECT * FROM deliverables WHERE access_token = ?").get(token);
}

/** 최근 자료 타임라인(로그인 직원 전체 열람). */
function recentDeliverables(_user, limit = 50) {
  return db()
    .prepare(
      `SELECT dv.*, p.title AS project_title, c.name AS client_name
       FROM deliverables dv
       LEFT JOIN projects p ON p.id = dv.project_id
       LEFT JOIN clients c ON c.id = p.client_id
       ORDER BY dv.created_at DESC, dv.id DESC LIMIT ?`
    )
    .all(limit);
}

// ── 매출: 담당 엔지니어별 집계 ──

/**
 * 전체 엔지니어별 매출 요약. 작업(engineer_id)·세션(engineer_name) 합산.
 * total > 0인 엔지니어만 반환, 합계 내림차순.
 */
function revenueByEngineer() {
  // 1) 작업 집계 (engineer_id별)
  const taskRows = db()
    .prepare(
      `SELECT engineer_id, SUM(total_price) AS task_total, COUNT(*) AS task_cnt
       FROM track_tasks WHERE engineer_id IS NOT NULL GROUP BY engineer_id`
    )
    .all();
  const taskByMgr = new Map(taskRows.map((r) => [r.engineer_id, r]));

  // 2) 세션 집계 (engineer_name별, 취소 제외·단가·시간 있음)
  const sessionRows = db()
    .prepare(
      `SELECT s.engineer_name, s.start_time, s.end_time,
              ri.base_minutes, ri.base_price, ri.extra_minutes, ri.extra_price
       FROM sessions s
       JOIN rate_items ri ON ri.id = s.rate_item_id
       WHERE s.status <> '취소'
         AND s.rate_item_id IS NOT NULL
         AND s.start_time IS NOT NULL AND s.end_time IS NOT NULL
         AND s.engineer_name IS NOT NULL`
    )
    .all();
  const sessionByName = {};
  for (const row of sessionRows) {
    const mins = minutesBetween(row.start_time, row.end_time);
    if (mins <= 0) continue;
    if (!sessionByName[row.engineer_name]) sessionByName[row.engineer_name] = { total: 0, cnt: 0 };
    sessionByName[row.engineer_name].total += computeRatePrice(row, mins);
    sessionByName[row.engineer_name].cnt += 1;
  }

  // 3) 매니저 목록과 조합 (total > 0만, 내림차순)
  const managers = listProjectManagers({ includeInactive: true });
  return managers
    .map((m) => {
      const t = taskByMgr.get(m.id) || { task_total: 0, task_cnt: 0 };
      const s = sessionByName[m.name] || { total: 0, cnt: 0 };
      const task_total = t.task_total || 0;
      const task_cnt = t.task_cnt || 0;
      const session_total = s.total;
      const session_cnt = s.cnt;
      const total = task_total + session_total;
      return { id: m.id, name: m.name, is_external: !m.user_id, task_total, task_cnt, session_total, session_cnt, total };
    })
    .filter((r) => r.total > 0)
    .sort((a, b) => b.total - a.total);
}

/**
 * 특정 엔지니어(managerId) 상세 매출. 없으면 null.
 * tasks: track_tasks(engineer_id=id) + 프로젝트·곡 정보.
 * sessions: sessions(engineer_name=manager.name) + 프로젝트명·금액.
 */
function revenueForEngineer(managerId) {
  const manager = db().prepare("SELECT * FROM project_managers WHERE id = ?").get(Number(managerId));
  if (!manager) return null;

  const tasks = db()
    .prepare(
      `SELECT t.id, t.task_type, t.total_price, t.is_invoiced,
              tr.title AS track_title, p.id AS project_id, p.title AS project_title
       FROM track_tasks t
       JOIN project_tracks tr ON tr.id = t.track_id
       JOIN projects p ON p.id = tr.project_id
       WHERE t.engineer_id = ?
       ORDER BY p.title COLLATE NOCASE, tr.title COLLATE NOCASE`
    )
    .all(Number(managerId));

  const sessionRows = db()
    .prepare(
      `SELECT s.id, s.session_date, s.session_type, s.start_time, s.end_time,
              p.id AS project_id, p.title AS project_title,
              ri.base_minutes, ri.base_price, ri.extra_minutes, ri.extra_price
       FROM sessions s
       JOIN projects p ON p.id = s.project_id
       JOIN rate_items ri ON ri.id = s.rate_item_id
       WHERE s.engineer_name = ?
         AND s.status <> '취소'
         AND s.rate_item_id IS NOT NULL
         AND s.start_time IS NOT NULL AND s.end_time IS NOT NULL
       ORDER BY s.session_date DESC, s.start_time`
    )
    .all(manager.name);

  const sessions = sessionRows.map((row) => {
    const mins = minutesBetween(row.start_time, row.end_time);
    return { ...row, amount: computeRatePrice(row, mins) };
  });

  const task_total = tasks.reduce((s, t) => s + (t.total_price || 0), 0);
  const session_total = sessions.reduce((s, r) => s + r.amount, 0);
  return { manager, tasks, sessions, task_total, session_total, total: task_total + session_total };
}

module.exports = {
  listClients,
  clientKindCounts,
  getClient,
  listProjectsForClient,
  listInvoicesForClientEntity,
  getWorker,
  listTasksForWorker,
  setTaskPayout,
  clientOptions,
  ensureClientsFromProject,
  listProjectManagers,
  listContacts,
  getContact,
  createContact,
  updateContact,
  deleteContact,
  currentAffiliation,
  listAffiliations,
  addAffiliation,
  endAffiliation,
  deleteAffiliation,
  contactOptions,
  listContactsForClient,
  listProjectsForContact,
  listSessionsForContact,
  listRooms,
  createRoom,
  deleteRoom,
  listRateItems,
  createRateItem,
  updateRateItem,
  deleteRateItem,
  computeRatePrice,
  listTaskTypes,
  activeTaskTypes,
  taskTypeLabel,
  taskTypeGroup,
  createTaskType,
  updateTaskType,
  deleteTaskType,
  listProjects,
  distinctProjectFields,
  getProjectForUser,
  deleteProject,
  listTracksForProject,
  getTrackForUser,
  getTaskForUser,
  createTrack,
  updateTrack,
  deleteTrack,
  createTask,
  updateTask,
  deleteTask,
  listUnbilledTasksForProject,
  listBillableSessionsForProject,
  isSessionInvoiced,
  listInvoiceItemsForInvoice,
  createInvoiceFromTasks,
  deleteInvoice,
  dashboardStats,
  listDeliverablesForProject,
  getDeliverableForUser,
  getDeliverableByToken,
  recentDeliverables,
  balanceOf,
  payStatusOf,
  isOverdue,
  listInvoices,
  getInvoiceForUser,
  getStudioInfo,
  setStudioInfo,
  getStudioLogo,
  setStudioLogo,
  getStudioHours,
  setStudioHours,
  getDefaultBooker,
  setDefaultBooker,
  studioStartSlots,
  ensureInvoiceNumber,
  invoiceStats,
  listInvoicesForProject,
  listSessionsForProject,
  getSessionForUser,
  createSession,
  updateSession,
  setSessionEventId,
  busySessionSlots,
  setSessionStatus,
  deleteSession,
  upcomingSessions,
  pastSessions,
  sessionsForMonth,
  sessionRateAmount,
  revenueByEngineer,
  revenueForEngineer,
};
