"use strict";

/**
 * 데이터 접근 헬퍼. 내부 도구이므로 로그인한 직원(staff/admin)은 모든 프로젝트를 열람한다.
 * 쓰기 권한은 라우트 미들웨어(requireEditor/requireChief/requireInvoice)가 분리해 강제한다.
 * 통계·표시 분기는 권한 술어(canInvoice/isChief, auth.js)로 판단한다(거래처 외부 열람은 폐기됨).
 */

const crypto = require("crypto");
const { db, getState, setState } = require("./db");
const { todayYmd, isValidYmd, formatYmdShort, minutesBetween } = require("./lib/date");
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

function parseWon(value) {
  const n = parseInt(String(value == null ? "" : value).replace(/[^\d-]/g, ""), 10);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

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
function clientOptions() {
  return db().prepare("SELECT id, name FROM clients ORDER BY name COLLATE NOCASE").all();
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
  db()
    .prepare(
      `UPDATE rate_items SET name=@name, category=@category, base_minutes=@base_minutes, base_price=@base_price,
       extra_minutes=@extra_minutes, extra_price=@extra_price WHERE id=@id`
    )
    .run({ id, ...f });
  return db().prepare("SELECT * FROM rate_items WHERE id = ?").get(id);
}

function setRateItemActive(id, active) {
  db().prepare("UPDATE rate_items SET active=? WHERE id=?").run(active ? 1 : 0, id);
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

function listProjects(_user, { service, clientId, q } = {}) {
  const where = [];
  const params = {};

  if (clientId) {
    where.push("p.client_id = @clientId");
    params.clientId = Number(clientId);
  }
  if (service) {
    where.push("p.services LIKE @service");
    params.service = `%"${service}"%`;
  }
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
  return db().prepare(sql).all(params);
}

/** 단건 조회 + 권한 검사. 권한 없으면 null(클라이언트가 타 프로젝트 접근 시도 시 404 처리용). */
function getProjectForUser(user, id) {
  const row = db()
    .prepare(
      `SELECT p.*, c.name AS client_name, m.name AS manager_name, tr_sum.track_titles, task_sum.task_total FROM projects p
       LEFT JOIN clients c ON c.id = p.client_id
       LEFT JOIN project_managers m ON m.id = p.manager_id
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
  return row || null;
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

/** 작업 수정. 이미 청구된 작업은 거부(라인아이템 스냅샷이 잠금). total_price는 재계산. */
function updateTask(user, taskId, input = {}) {
  const task = getTaskForUser(user, taskId);
  if (!task) return null;
  if (task.is_invoiced) throw new Error("TASK_LOCKED");
  // 후반작업은 전부 트랙/콘텐츠 고정(곡 1건당) — billing_type='Fixed_Per_Track'·quantity=1 고정, 금액(unit_price)만 직접 입력.
  const unitPrice = parseWon(input.unit_price);
  db()
    .prepare(
      `UPDATE track_tasks SET
         task_type = @task_type, billing_type = 'Fixed_Per_Track', quantity = 1,
         unit_price = @unit_price, total_price = @unit_price, engineer_name = @engineer_name,
         status = @status
       WHERE id = @id`
    )
    .run({
      id: task.id,
      task_type: normalizeTaskTypeDb(input.task_type),
      unit_price: unitPrice,
      engineer_name: String(input.engineer_name || "").trim() || null,
      status: normalizeTaskStatus(input.status),
    });
  return db().prepare("SELECT t.*, tr.project_id FROM track_tasks t JOIN project_tracks tr ON tr.id = t.track_id WHERE t.id = ?").get(task.id);
}

/** 작업 삭제. 이미 청구된 작업은 거부. */
function deleteProject(projectId) {
  db().prepare("DELETE FROM projects WHERE id = ?").run(Number(projectId));
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
  const info = db()
    .prepare(
      `INSERT INTO track_tasks
       (track_id, task_type, billing_type, quantity, unit_price, total_price, engineer_name, status, is_invoiced)
       VALUES (@track_id, @task_type, 'Fixed_Per_Track', 1, @unit_price, @unit_price, @engineer_name, @status, 0)`
    )
    .run({
      track_id: track.id,
      task_type: taskType,
      unit_price: unitPrice,
      engineer_name: String(input.engineer_name || "").trim() || null,
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
       ORDER BY tr.created_at ASC, tr.id ASC, t.created_at ASC, t.id ASC`
    )
    .all(project.id);
  return { project, rows };
}

/** 청구 가능 녹음 세션(녹음+단가+시간, 취소 제외) 중 아직 청구/전환 안 된 것 — 세션 직접 청구 후보. */
function listBillableSessionsForProject(user, projectId) {
  const project = getProjectForUser(user, projectId);
  if (!project) return null;
  const rows = db()
    .prepare(
      `SELECT s.* FROM sessions s
       WHERE s.project_id = ?
         AND s.status <> '취소'
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

/** 발행/입금완료로 전이 시 채번 보장(수동 발행분도 INV-YYYYMM-### 부여). 거래명세서에 번호 필수. */
function ensureInvoiceNumber(inv) {
  if (!inv || inv.invoice_number) return inv;
  if (inv.status !== "발행" && inv.status !== "입금완료") return inv;
  const number = nextInvoiceNumber(inv.issued_date || todayYmd());
  db().prepare("UPDATE invoices SET invoice_number=? WHERE id=?").run(number, inv.id);
  return { ...inv, invoice_number: number };
}

function createInvoiceFromTasks(user, { projectId, taskIds, sessionIds, issueDate, dueDate, title } = {}) {
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
           AND s.status <> '취소' AND s.session_type = '녹음'
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
        client_id: project.client_id || null,
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
  const today = todayYmd();
  // '다가오는 마감'은 오늘 이후만. 지난 마감은 별도 '지연' 목록으로 분리(임박 항목이 밀리지 않게).
  const upcoming = d
    .prepare(
      `SELECT p.*, c.name AS client_name FROM projects p
       LEFT JOIN clients c ON c.id = p.client_id
       WHERE p.due_date IS NOT NULL AND p.due_date <> '' AND p.due_date >= @today
       ORDER BY p.due_date ASC LIMIT 5`
    )
    .all({ today });
  const overdue = d
    .prepare(
      `SELECT p.*, c.name AS client_name FROM projects p
       LEFT JOIN clients c ON c.id = p.client_id
       WHERE p.due_date IS NOT NULL AND p.due_date <> '' AND p.due_date < @today
       ORDER BY p.due_date DESC LIMIT 5`
    )
    .all({ today });
  const showInvoices = canInvoice(user);
  const showClients = isChief(user);
  return {
    canInvoice: showInvoices,
    isChief: showClients,
    total,
    clients: showClients ? d.prepare("SELECT COUNT(*) AS n FROM clients").get().n : null,
    upcoming,
    overdue,
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
 * 종료시간 결정: 소요시간 모드(duration_mode)가 있으면 시작+길이로 계산, 없으면 입력된 end_time 사용.
 *  - pro1/pro2: 단가표 항목 기준시간(base_minutes)×1 또는 ×2. 단가 미선택/기준 0이면 SESSION_PRO_NEEDS_RATE.
 *  - custom: custom_hours(시간, 소수 가능)만큼.
 */
function resolveEndTime(input, start, rateItemId) {
  const mode = String(input.duration_mode || "");
  if (!start || !["pro1", "pro2", "custom"].includes(mode)) return cleanTime(input.end_time_custom) || cleanTime(input.end_time);
  if (mode === "custom") {
    const hours = parseFloat(input.custom_hours);
    return hours > 0 ? addMinutesToHHMM(start, Math.round(hours * 60)) : cleanTime(input.end_time);
  }
  const item = rateItemId ? db().prepare("SELECT base_minutes FROM rate_items WHERE id = ?").get(rateItemId) : null;
  const base = item && item.base_minutes > 0 ? item.base_minutes : 0;
  if (base <= 0) throw new Error("SESSION_PRO_NEEDS_RATE");
  return addMinutesToHHMM(start, mode === "pro2" ? base * 2 : base);
}

function sessionFields(input) {
  const date = String(input.session_date || "").trim();
  if (!isValidYmd(date)) throw new Error("SESSION_DATE_REQUIRED");
  // 직접입력(그리드 밖 시간)이 있으면 우선, 없으면 그리드에서 고른 시작.
  const start = cleanTime(input.start_time_custom) || cleanTime(input.start_time);
  const rateItemId = Number(input.rate_item_id) || null;
  return {
    session_type: normalizeSessionType(input.session_type),
    session_date: date,
    start_time: start,
    end_time: resolveEndTime(input, start, rateItemId),
    booker_name: String(input.booker_name || "").trim() || null,
    engineer_name: String(input.engineer_name || "").trim() || null,
    status: normalizeSessionStatus(input.status),
    rate_item_id: rateItemId,
    memo: String(input.memo || "").trim() || null,
  };
}

/**
 * 해당 날짜에 이미 예약된(녹음/믹싱, 취소 제외) 30분 시작 슬롯 목록 — 가용성 표시용.
 * slots = 후보 'HH:MM' 배열. 스튜디오 전체. excludeId로 수정 중 세션 제외.
 */
function busySessionSlots(date, slots, { excludeId = null } = {}) {
  if (!isValidYmd(date) || !Array.isArray(slots) || !slots.length) return [];
  const rows = db()
    .prepare(
      `SELECT start_time, end_time FROM sessions
       WHERE session_date = ? AND status <> '취소' AND session_type IN ('녹음','믹싱')
         AND start_time IS NOT NULL AND end_time IS NOT NULL AND id <> ?`
    )
    .all(date, excludeId == null ? -1 : excludeId);
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

/** 'HH:MM' → 자정 기준 분(유효하지 않으면 null). */
function timeToMin(hhmm) {
  const m = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(String(hhmm || ""));
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
}

/**
 * 같은 날 시간대가 겹치는 다른 녹음/믹싱 세션(스튜디오 전체, 취소 제외)을 찾는다.
 * 시간(시작·종료)이 둘 다 있어야 검사한다(미정이면 null). 반열린구간[start,end) 겹침 + 야간(자정 넘김) 처리.
 */
function findSessionConflict({ date, start, end, excludeId = null }) {
  const s = timeToMin(start);
  let e = timeToMin(end);
  if (!isValidYmd(date) || s == null || e == null) return null;
  if (e <= s) e += 1440; // end<=start면 야간(자정 넘김)
  const rows = db()
    .prepare(
      `SELECT s.*, p.title AS project_title FROM sessions s
       JOIN projects p ON p.id = s.project_id
       WHERE s.session_date = ? AND s.status <> '취소'
         AND s.session_type IN ('녹음','믹싱')
         AND s.start_time IS NOT NULL AND s.end_time IS NOT NULL
         AND s.id <> ?
       ORDER BY s.start_time`
    )
    .all(date, excludeId == null ? -1 : excludeId);
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
  const conflict = findSessionConflict({ date: f.session_date, start: f.start_time, end: f.end_time, excludeId });
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
      `INSERT INTO sessions (project_id, session_type, session_date, start_time, end_time, booker_name, engineer_name, status, rate_item_id, memo)
       VALUES (@project_id, @session_type, @session_date, @start_time, @end_time, @booker_name, @engineer_name, @status, @rate_item_id, @memo)`
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
       rate_item_id=@rate_item_id, memo=@memo WHERE id=@id`
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
  db().prepare("UPDATE sessions SET status=? WHERE id=?").run(normalizeSessionStatus(status), s.id);
  return { project_id: s.project_id };
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

module.exports = {
  listClients,
  clientKindCounts,
  getClient,
  clientOptions,
  ensureClientsFromProject,
  listProjectManagers,
  listRateItems,
  createRateItem,
  updateRateItem,
  setRateItemActive,
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
  sessionRateAmount,
};
