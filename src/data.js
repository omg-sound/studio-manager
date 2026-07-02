"use strict";

/**
 * 데이터 접근 헬퍼. 내부 도구이므로 로그인한 직원(staff/admin)은 모든 프로젝트를 열람한다.
 * 쓰기 권한은 라우트 미들웨어(requireEditor/requireChief/requireInvoice)가 분리해 강제한다.
 * 통계·표시 분기는 권한 술어(canInvoice/isChief, auth.js)로 판단한다(거래처 외부 열람은 폐기됨).
 */

const { db, getState, setState } = require("./db");
const { todayYmd, isValidYmd, formatYmdShort, cleanTime, timeToMin, minutesBetween } = require("./lib/date");
const studio = require("./data/studio"); // 스튜디오 설정 도메인(분리 모듈) — 아래에서 재export
const clientFiles = require("./data/client-files"); // 클라이언트 첨부 서류 도메인(분리 모듈) — 아래에서 재export
const revenue = require("./data/revenue"); // 매출 집계 도메인(분리 모듈) — 아래에서 재export
const deliverables = require("./data/deliverables"); // 자료 전달 도메인(분리 모듈) — 아래에서 재export
const rooms = require("./data/rooms"); // 룸 도메인(분리 모듈) — 아래에서 재export
const rateItems = require("./data/rate-items"); // 단가표 도메인(분리 모듈) — 아래에서 재export
const taskTypes = require("./data/task-types"); // 작업 종류 카탈로그 도메인(분리 모듈·캐시 포함) — 아래에서 재export
const contacts = require("./data/contacts"); // 연락처(사람)+소속 이력+담당자연동 도메인(분리 모듈) — 아래에서 재export
const { createContact } = contacts; // 내부 호출 유지용(clients resolveContactByName·sessions resolveDirectorIds)
const { listRooms } = rooms; // 내부 호출 유지용(세션 room_id 활성 검증)
const { computeRatePrice } = rateItems; // 내부 호출 유지용(프로젝트 세션액 합산·sessionRateAmount)
// 공개 재export + 내부 호출(taskTypeLabel·taskTypeUnitPrice·normalizeTaskTypeDb) 유지. normalizeTaskTypeDb는 내부 전용(공개 API 미노출).
const { listTaskTypes, activeTaskTypes, taskTypeLabel, taskTypeUnitPrice, createTaskType, updateTaskType, deleteTaskType, normalizeTaskTypeDb } = taskTypes;
const { parseMoney } = require("./lib/forms");
const { canInvoice, canBill, isChief, canEdit } = require("./auth");
const {
  normalizeTrackContentType,
  normalizeTaskStatus,
  normalizeSessionType,
  normalizeSessionStatus,
  normalizeClientKind,
} = require("./config");

// cleanTime('HH:MM' 검증)은 lib/date로 이전(공유 헬퍼). 위 import 참조.

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

/** 로그인 사용자(하우스 엔지니어)와 연결된 담당자 마스터 행 — 새 작업의 담당 엔지니어 기본값용. */
function getManagerByUserId(userId) {
  if (!userId) return null;
  return db().prepare("SELECT * FROM project_managers WHERE user_id = ?").get(Number(userId)) || null;
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

/** 연락처(담당자)를 청구처로 쓸 때: **contact별** '기타' 클라이언트 재사용(source_contact_id) 또는 생성 후 client_id 반환. 이름이 아닌 출처 contact로 매핑해 동명이인이 한 클라이언트로 병합되지 않게 한다. */
function ensureClientFromContact(contactId) {
  const id = Number(contactId);
  const c = db().prepare("SELECT id, name, phone, email FROM contacts WHERE id = ?").get(id);
  if (!c || !String(c.name || "").trim()) return null;
  const existing = db().prepare("SELECT id FROM clients WHERE source_contact_id = ? AND kind = '기타'").get(id); // 아티스트 링크와 분리(kind별)
  if (existing) {
    db().prepare("UPDATE clients SET name = ?, phone = ?, email = ? WHERE id = ?").run(c.name, c.phone || null, c.email || null, existing.id); // 재사용 시 연락처의 최신 이름·전화·이메일 반영(리네임 반영)
    return existing.id;
  }
  const info = db()
    .prepare("INSERT INTO clients (name, kind, phone, email, source_contact_id) VALUES (?, '기타', ?, ?, ?)")
    .run(c.name, c.phone || null, c.email || null, id);
  return info.lastInsertRowid;
}

/** 연락처의 아티스트명(nickname)을 아티스트 클라이언트로 등록·동기화(양방향 연동, source_contact_id로 매핑). 아티스트명 없으면 새로 만들지 않음(기존 링크는 유지). 반환: client id | null. */
function syncArtistClientForContact(contactId) {
  const id = Number(contactId);
  const c = db().prepare("SELECT id, nickname, phone, email FROM contacts WHERE id = ?").get(id);
  if (!c) return null;
  const artist = String(c.nickname || "").trim();
  const existing = db().prepare("SELECT id FROM clients WHERE source_contact_id = ? AND kind = '아티스트'").get(id);
  if (!artist) return existing ? existing.id : null; // 아티스트명 비면 생성 안 함
  if (existing) {
    db().prepare("UPDATE clients SET name = ?, phone = ?, email = ? WHERE id = ?").run(artist, c.phone || null, c.email || null, existing.id); // 이름·연락처 동기화
    return existing.id;
  }
  const info = db()
    .prepare("INSERT INTO clients (name, kind, phone, email, source_contact_id) VALUES (?, '아티스트', ?, ?, ?)")
    .run(artist, c.phone || null, c.email || null, id);
  return info.lastInsertRowid;
}

/** 연락처에 연동된 아티스트 클라이언트(있으면). 연락처 상세에서 링크 표시용. */
function artistClientForContact(contactId) {
  return db().prepare("SELECT id, name FROM clients WHERE source_contact_id = ? AND kind = '아티스트'").get(Number(contactId)) || null;
}

/** 이름으로 연락처(사람) 찾기 — 정확히 일치하면 재사용, 없으면 새 연락처 생성(한국식 성·이름 자동 분리). 대표자 연락처 연동 등에 사용. */
function resolveContactByName(name) {
  const n = String(name || "").trim();
  if (!n) return null;
  const ex = db().prepare("SELECT id FROM contacts WHERE name = ? ORDER BY id LIMIT 1").get(n);
  return ex ? ex.id : createContact({ name: n });
}

/** 이 연락처를 대표자로 둔 클라이언트들(양방향 표시용 — 연락처 상세에서 '대표 클라이언트'). */
function clientsWithOwnerContact(contactId) {
  return db().prepare("SELECT id, name, kind FROM clients WHERE owner_contact_id = ? ORDER BY name").all(Number(contactId));
}

/** 업체(소속사·제작사)에 소속된 아티스트 클라이언트 목록(업체 상세 '소속 아티스트'). */
function listArtistsForAgency(companyId) {
  return db().prepare("SELECT id, name FROM clients WHERE agency_client_id = ? AND kind = '아티스트' ORDER BY name").all(Number(companyId));
}

/** 이름으로 업체(비아티스트) 클라이언트 찾기 — 정확 일치 재사용, 없으면 null(자동 생성 안 함). 아티스트 소속 업체 링크용. */
function resolveCompanyByName(name) {
  const n = String(name || "").trim();
  if (!n) return null;
  // 실제 업체(소속사/제작사)만 매칭 — '기타' 담당자 셸 클라이언트(ensureClientFromContact 생성)에 잘못 연결되지 않게.
  const ex = db().prepare("SELECT id FROM clients WHERE name = ? AND kind IN ('소속사/레이블','제작사') ORDER BY id LIMIT 1").get(n);
  return ex ? ex.id : null;
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

// ── 연락처(사람) + 소속 이력 + 담당자↔연락처 연동 도메인은 src/data/contacts.js로 분리. module.exports에서 `...contacts` 재export. ──
// ── 룸 도메인은 src/data/rooms.js로, 단가표 도메인은 src/data/rate-items.js로 분리. module.exports에서 `...rooms`·`...rateItems` 재export. ──

// ── 작업 종류 카탈로그 도메인은 src/data/task-types.js로 분리(모듈 캐시 포함). module.exports에서 `...taskTypes` 재export. ──

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
         AND s.status <> '취소'
         AND NOT EXISTS (SELECT 1 FROM invoice_items ii WHERE ii.session_id = s.id)`
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
      (SELECT COALESCE(SUM(COALESCE(NULLIF(t.total_price, 0), tt.unit_price, 0)), 0)
       FROM track_tasks t
       JOIN project_tracks tr ON tr.id = t.track_id
       LEFT JOIN task_types tt ON tt.key = t.task_type
       WHERE tr.project_id = p.id AND t.is_invoiced = 0) AS task_total
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
         SELECT tr.project_id, COALESCE(SUM(COALESCE(NULLIF(t.total_price, 0), tt.unit_price, 0)), 0) AS task_total
         FROM project_tracks tr
         LEFT JOIN track_tasks t ON t.track_id = tr.id AND t.is_invoiced = 0
         LEFT JOIN task_types tt ON tt.key = t.task_type
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
  const artist = String(input.artist || "").trim() || project.artist || null; // 곡별 아티스트, 미입력 시 프로젝트 아티스트
  const info = db()
    .prepare("INSERT INTO project_tracks (project_id, title, artist, content_type) VALUES (?, ?, ?, ?)")
    .run(project.id, title, artist, normalizeTrackContentType(input.content_type));
  return db().prepare("SELECT * FROM project_tracks WHERE id = ?").get(info.lastInsertRowid);
}

function updateTrack(user, trackId, input = {}) {
  const track = getTrackForUser(user, trackId);
  if (!track) return null;
  const title = String(input.title || "").trim();
  if (!title) throw new Error("TRACK_TITLE_REQUIRED");
  const artist = input.artist !== undefined ? (String(input.artist || "").trim() || null) : track.artist; // 폼에 아티스트 있으면 갱신
  db()
    .prepare("UPDATE project_tracks SET title = ?, artist = ?, content_type = ? WHERE id = ?")
    .run(title, artist, normalizeTrackContentType(input.content_type), track.id);
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

/** 청구 폼에서 입력한 작업 금액을 즉시 작업에 저장(초안이 아니라 기록 — 목록·청구 폼 기본값 반영). 청구된 작업은 거부. */
function setTaskAmount(user, taskId, amount) {
  const task = getTaskForUser(user, taskId);
  if (!task) return null;
  if (task.is_invoiced) throw new Error("TASK_LOCKED");
  const amt = amount > 0 ? Math.round(amount) : 0;
  db().prepare("UPDATE track_tasks SET unit_price = ?, total_price = ? WHERE id = ?").run(amt, amt, task.id);
  return db().prepare("SELECT t.*, tr.project_id FROM track_tasks t JOIN project_tracks tr ON tr.id = t.track_id WHERE t.id = ?").get(task.id);
}

/** 작업 수정. 이미 청구된 작업은 거부(라인아이템 스냅샷이 잠금). total_price는 재계산. */
function updateTask(user, taskId, input = {}) {
  const task = getTaskForUser(user, taskId);
  if (!task) return null;
  if (task.is_invoiced) throw new Error("TASK_LOCKED");
  // 금액은 청구 탭에서 확정 — 곡·콘텐츠 탭엔 금액 칸 없음. 입력값 있으면 우선, 없으면 확정 금액(total_price>0) 보존, 그것도 0이면 종류 기본단가.
  const taskType = normalizeTaskTypeDb(input.task_type);
  const hasPrice = input.unit_price != null && String(input.unit_price).trim() !== "";
  const unitPrice = hasPrice ? parseWon(input.unit_price) : (task.total_price > 0 ? task.total_price : taskTypeUnitPrice(taskType)); // 자동저장(상태·담당만 변경) 시 확정 금액 리셋 방지
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
      task_type: taskType,
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
  // 후반작업은 트랙/콘텐츠 고정(billing_type·quantity). 금액은 청구 탭에서 확정 — 생성 시엔 종류 기본단가 자동(입력값 있으면 우선).
  const taskType = normalizeTaskTypeDb(input.task_type);
  const hasPrice = input.unit_price != null && String(input.unit_price).trim() !== "";
  const unitPrice = hasPrice ? parseWon(input.unit_price) : taskTypeUnitPrice(taskType);
  const eng = resolveTaskEngineer(input);
  // 담당 엔지니어 미지정 시 로그인한 계정(하우스 엔지니어)을 기본값으로(빠른 추가 시 본인 자동 선택).
  if (!eng.engineer_id && !eng.engineer_name) {
    const mine = getManagerByUserId(user.id);
    if (mine) { eng.engineer_id = mine.id; eng.engineer_name = mine.name; eng.is_external = !mine.user_id; }
  }
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
       ORDER BY s.created_at ASC, s.id ASC`
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

// ── 스튜디오(공급자) 설정 도메인은 src/data/studio.js로 분리(도메인 모듈화 착수). 아래 module.exports에서 `...studio`로 재export. ──

/** 발행/입금완료로 전이 시 채번 보장(수동 발행분도 INV-YYYYMM-### 부여). 거래명세서에 번호 필수. */
function ensureInvoiceNumber(inv) {
  if (!inv || inv.invoice_number) return inv;
  // 청구서 발행 또는 계산서 발행/입금완료 — 어느 축이든 '발행됨'이면 채번(거래명세서/계산서 번호 필수).
  if (inv.status !== "발행" && inv.tax_status !== "계산서 발행" && inv.tax_status !== "입금완료") return inv;
  const number = nextInvoiceNumber(inv.issued_date || todayYmd());
  db().prepare("UPDATE invoices SET invoice_number=? WHERE id=?").run(number, inv.id);
  return { ...inv, invoice_number: number };
}

/**
 * 공급가·할인 기반 청구 금액 계산 헬퍼.
 * discount: 0 ~ supply 로 clamp(음수→0, 공급가 초과→공급가).
 * 반환: { discount(clamp됨), taxable, tax, total }
 * 돈=정수(원). VAT = round(taxable * 0.1).
 */
function invoiceAmountsFromSupply(supply, discount, vatIncluded = true) {
  const raw = Math.round(Number(discount) || 0);
  const d = Math.min(Math.max(0, raw), supply);
  const taxable = supply - d;
  const tax = vatIncluded ? Math.round(taxable * 0.1) : 0; // 부가세 미포함(현금 거래) 시 VAT 0
  const total = taxable + tax;
  return { discount: d, taxable, tax, total };
}

/**
 * 청구 초안 계산(읽기 전용, 쓰기 없음) — 청구서 생성과 미리보기 PDF가 공유.
 * 선택 작업/세션 + 폼 입력 금액 → 라인아이템·공급가·할인·VAT·총액·청구처 계산. 반환: null(권한 없음) 또는 draft 객체.
 */
function computeInvoiceDraft(user, { projectId, taskIds, sessionIds, clientId, issueDate, dueDate, title, discount, vatIncluded = true, taskAmounts = {}, sessionAmounts = {} } = {}) {
  const project = getProjectForUser(user, projectId);
  if (!project || !canBill(user)) return null;
  const d = db();
  const selectedTasks = Array.isArray(taskIds) ? taskIds.map(Number).filter(Boolean) : [];
  const selectedSessions = Array.isArray(sessionIds) ? sessionIds.map(Number).filter(Boolean) : [];
  if (!selectedTasks.length && !selectedSessions.length) throw new Error("TASK_IDS_REQUIRED");

  let tasks = [];
  if (selectedTasks.length) {
    const placeholders = selectedTasks.map(() => "?").join(",");
    tasks = d
      .prepare(
        `SELECT t.*, tr.title AS track_title, tr.artist AS track_artist, tr.content_type, tr.project_id
         FROM track_tasks t
         JOIN project_tracks tr ON tr.id = t.track_id
         WHERE tr.project_id = ? AND t.is_invoiced = 0 AND t.id IN (${placeholders})
         ORDER BY tr.created_at ASC, tr.id ASC, t.created_at ASC, t.id ASC`
      )
      .all(project.id, ...selectedTasks);
    if (tasks.length !== selectedTasks.length) throw new Error("TASK_NOT_BILLABLE");
  }
  tasks = tasks.map((t) => {
    const raw = taskAmounts[t.id] != null ? taskAmounts[t.id] : taskAmounts[String(t.id)];
    const amt = raw != null && String(raw).trim() !== "" ? parseWon(raw) : (t.total_price || 0);
    return { ...t, unit_price: amt, total_price: amt };
  });

  let billSessions = [];
  if (selectedSessions.length) {
    const placeholders = selectedSessions.map(() => "?").join(",");
    const rawSessions = d
      .prepare(
        `SELECT s.* FROM sessions s
         WHERE s.project_id = ? AND s.status = '완료' AND s.session_type = '녹음'
           AND s.rate_item_id IS NOT NULL AND s.start_time IS NOT NULL AND s.end_time IS NOT NULL
           AND s.id IN (${placeholders})
           AND NOT EXISTS (SELECT 1 FROM invoice_items ii WHERE ii.session_id = s.id)
           AND NOT EXISTS (SELECT 1 FROM track_tasks tt WHERE tt.session_id = s.id)`
      )
      .all(project.id, ...selectedSessions);
    billSessions = rawSessions.map((s) => ({ session: s, calc: sessionRateAmount(s) })).filter((x) => x.calc && x.calc.amount > 0);
    if (billSessions.length !== selectedSessions.length) throw new Error("TASK_NOT_BILLABLE");
    billSessions = billSessions.map((x) => {
      const raw = sessionAmounts[x.session.id] != null ? sessionAmounts[x.session.id] : sessionAmounts[String(x.session.id)];
      const amount = raw != null && String(raw).trim() !== "" ? parseWon(raw) : x.calc.amount;
      return { ...x, amount };
    });
  }

  const subtotal = tasks.reduce((s, t) => s + (t.total_price || 0), 0) + billSessions.reduce((s, x) => s + x.amount, 0);
  const { discount: discountAmt, tax, total } = invoiceAmountsFromSupply(subtotal, discount || 0, vatIncluded);
  const issued = issueDate || todayYmd();
  const invoiceTitle = String(title || "").trim() || `${project.title} 청구`;
  const resolvedClientId = (clientId ? Number(clientId) : null) || project.client_id || null;
  if (resolvedClientId && !d.prepare("SELECT 1 FROM clients WHERE id = ?").get(resolvedClientId)) throw new Error("CLIENT_NOT_FOUND");

  // 라인아이템(청구서·PDF 공용). 작업=곡명 - 종류, 세션=녹음 세션 라인.
  const items = [];
  for (const t of tasks) {
    items.push({ task_id: t.id, session_id: null, track_title: t.track_title, task_type: t.task_type, description: `${t.track_title} - ${taskTypeLabel(t.task_type)}`, quantity: t.quantity, unit_price: t.unit_price, amount: t.total_price });
  }
  for (const { session, calc, amount } of billSessions) {
    const hh = Math.floor(calc.minutes / 60), mm = calc.minutes % 60;
    items.push({ task_id: null, session_id: session.id, track_title: null, task_type: null, description: `녹음 세션 ${formatYmdShort(session.session_date)} · ${calc.item.name} (${hh}시간${mm ? " " + mm + "분" : ""})`, quantity: 1, unit_price: amount, amount });
  }
  return { project, tasks, billSessions, items, subtotal, discountAmt, tax, total, issued, dueDate: dueDate || null, invoiceTitle, resolvedClientId };
}

function createInvoiceFromTasks(user, opts = {}) {
  const draft = computeInvoiceDraft(user, opts);
  if (!draft) return null;
  const d = db();
  const invoiceNumber = nextInvoiceNumber(draft.issued);
  d.exec("BEGIN IMMEDIATE;");
  try {
    const info = d
      .prepare(
        `INSERT INTO invoices
         (project_id, client_id, title, invoice_number, amount, tax_amount, discount_amount, paid_amount, status, issued_date, due_date, memo)
         VALUES (@project_id, @client_id, @title, @invoice_number, @amount, @tax_amount, @discount_amount, 0, '발행', @issued_date, @due_date, @memo)`
      )
      .run({
        project_id: draft.project.id,
        client_id: draft.resolvedClientId,
        title: draft.invoiceTitle,
        invoice_number: invoiceNumber,
        amount: draft.total,
        tax_amount: draft.tax,
        discount_amount: draft.discountAmt,
        issued_date: draft.issued,
        due_date: draft.dueDate,
        memo: null, // 자동 메모 제거(사용자 요청) — 필요 시 수동 인보이스에서 입력
      });
    const invoiceId = info.lastInsertRowid;
    const insertItem = d.prepare(
      `INSERT INTO invoice_items (invoice_id, task_id, session_id, track_title, task_type, description, quantity, unit_price, amount)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    );
    const markTask = d.prepare("UPDATE track_tasks SET is_invoiced = 1, invoice_id = ?, unit_price = ?, total_price = ? WHERE id = ?");
    for (const it of draft.items) {
      insertItem.run(invoiceId, it.task_id, it.session_id, it.track_title, it.task_type, it.description, it.quantity, it.unit_price, it.amount);
      if (it.task_id) markTask.run(invoiceId, it.unit_price, it.amount, it.task_id); // 청구 시 확정 금액을 작업에도 반영
    }
    d.exec("COMMIT;");
    return getInvoiceForUser(user, invoiceId);
  } catch (e) {
    d.exec("ROLLBACK;");
    throw e;
  }
}

/**
 * 청구서 생성 전 미리보기 PDF용 데이터(견적서·내역서·거래명세서) — 쓰기 없음. 선택 항목·금액을 그대로 문서화.
 * 반환: { client, invoice(미발행·번호 없음), items } 또는 null.
 */
function invoiceDraftForPdf(user, opts = {}) {
  const draft = computeInvoiceDraft(user, opts);
  if (!draft) return null;
  const client = draft.resolvedClientId ? getClient(draft.resolvedClientId) : null;
  const invoice = {
    title: draft.invoiceTitle,
    invoice_number: null, // 미발행(초안) — 채번 전
    amount: draft.total,
    tax_amount: draft.tax,
    discount_amount: draft.discountAmt,
    paid_amount: 0,
    status: "미발행",
    issued_date: draft.issued,
    due_date: draft.dueDate,
    client_id: draft.resolvedClientId,
    client_name: client ? client.name : "",
  };
  return { project: draft.project, client: client || { name: "" }, invoice, items: draft.items };
}

/**
 * 청구 삭제. 연결된 작업의 잠금(is_invoiced)을 먼저 해제한 뒤 삭제해야 좀비 작업이 안 생긴다.
 * (FK는 invoice_id만 SET NULL로 지울 뿐 is_invoiced=1은 남으므로 명시적 UPDATE 필요.)
 */
function deleteInvoice(user, id) {
  if (!canBill(user)) return null;
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
    where.push(status === "입금완료" ? "i.tax_status = @status" : "i.status = @status"); // 입금완료는 계산서·입금 축(tax_status)
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
    director_contact_id: null,
    memo: String(input.memo || "").trim() || null,
  };
}

/** 세션 담당 디렉터(다대다): director_contact_id[](목록 선택) + director_name[](새/입력 이름)을 연락처 id 배열로 해석(중복 제거).
 *  id 우선, 없으면 같은 이름 연락처 재사용, 그래도 없으면 새로 생성. */
function resolveDirectorIds(input) {
  const asArr = (v) => (Array.isArray(v) ? v : v != null && v !== "" ? [v] : []);
  const ids = asArr(input.director_contact_id);
  const names = asArr(input.director_name);
  const n = Math.max(ids.length, names.length);
  const out = [];
  const seen = new Set();
  for (let i = 0; i < n; i++) {
    let cid = Number(ids[i]) || null;
    if (!cid) {
      const nm = String(names[i] || "").trim();
      if (!nm) continue;
      const existing = db().prepare("SELECT id FROM contacts WHERE name = ? LIMIT 1").get(nm);
      cid = existing ? existing.id : createContact({ name: nm });
    }
    if (cid && !seen.has(cid)) { seen.add(cid); out.push(cid); }
  }
  return out;
}

/** 세션의 담당 디렉터 목록을 통째로 교체(다대다). 레거시 sessions.director_contact_id도 첫 디렉터로 동기화. */
function setSessionDirectors(sessionId, ids) {
  const d = db();
  d.prepare("DELETE FROM session_directors WHERE session_id = ?").run(sessionId);
  const ins = d.prepare("INSERT OR IGNORE INTO session_directors (session_id, contact_id) VALUES (?, ?)");
  for (const cid of ids) ins.run(sessionId, cid);
  d.prepare("UPDATE sessions SET director_contact_id = ? WHERE id = ?").run(ids[0] || null, sessionId);
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
      `SELECT ct.* FROM session_directors sd JOIN contacts ct ON ct.id = sd.contact_id
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
  f.director_contact_id = directorIds[0] || null; // 레거시 컬럼=첫 디렉터
  assertNoSessionConflict(f, null);
  // 세션 행 + 다대다 디렉터를 한 트랜잭션으로 — 중간 실패 시 반쪽 세션(디렉터 없는)이 남지 않게.
  const d = db();
  let newId;
  d.exec("BEGIN IMMEDIATE;");
  try {
    const info = d
      .prepare(
        `INSERT INTO sessions (project_id, session_type, session_date, start_time, end_time, booker_name, engineer_name, status, rate_item_id, room_id, director_contact_id, memo)
         VALUES (@project_id, @session_type, @session_date, @start_time, @end_time, @booker_name, @engineer_name, @status, @rate_item_id, @room_id, @director_contact_id, @memo)`
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
  const s = getSessionForUser(user, sessionId);
  if (!s) return null;
  if (isSessionInvoiced(s.id)) throw new Error("SESSION_INVOICED");
  const f = sessionFields(input);
  const directorIds = resolveDirectorIds(input);
  f.director_contact_id = directorIds[0] || null; // 레거시 컬럼=첫 디렉터
  assertNoSessionConflict(f, s.id);
  // UPDATE + 디렉터 교체를 한 트랜잭션으로(디렉터만 지워지고 세션은 옛값으로 남는 반쪽 갱신 방지).
  const d = db();
  d.exec("BEGIN IMMEDIATE;");
  try {
    d
      .prepare(
        `UPDATE sessions SET session_type=@session_type, session_date=@session_date, start_time=@start_time,
         end_time=@end_time, booker_name=@booker_name, engineer_name=@engineer_name, status=@status,
         rate_item_id=@rate_item_id, room_id=@room_id, director_contact_id=@director_contact_id, memo=@memo WHERE id=@id`
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

// ── 자료 전달(deliverables) 도메인은 src/data/deliverables.js로 분리. 아래 module.exports에서 `...deliverables`로 재export. ──

// ── 매출 집계 도메인은 src/data/revenue.js로 분리. 아래 module.exports에서 `...revenue`로 재export. ──

// ── 클라이언트 첨부 서류 도메인은 src/data/client-files.js로 분리. 아래 module.exports에서 `...clientFiles`로 재export. ──

module.exports = {
  ...contacts, // 연락처 도메인 재export(src/data/contacts.js): formatPhone·listContacts·getContact·createContact·updateContact·deleteContact·setContactGoogleRef·getContactByResourceName·currentAffiliation·listAffiliations·addAffiliation·syncCompanyAffiliation·endAffiliation·updateAffiliation·deleteAffiliation·contactOptions·listContactsForClient·listProjectsForContact·listSessionsForContact·getManagerByContactId·classifyContact·ensureContactForManager·ensureContactForUser·syncContactToManager·syncManagerToContact
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
  ensureClientFromContact,
  syncArtistClientForContact,
  artistClientForContact,
  resolveContactByName,
  clientsWithOwnerContact,
  listArtistsForAgency,
  resolveCompanyByName,
  listProjectManagers,
  ...rooms, // 룸 도메인 재export(src/data/rooms.js): listRooms·createRoom·deleteRoom
  ...rateItems, // 단가표 도메인 재export(src/data/rate-items.js): listRateItems·createRateItem·updateRateItem·deleteRateItem·computeRatePrice
  listTaskTypes,
  activeTaskTypes,
  taskTypeLabel,
  taskTypeUnitPrice,
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
  setTaskAmount,
  deleteTask,
  listUnbilledTasksForProject,
  listBillableSessionsForProject,
  isSessionInvoiced,
  listInvoiceItemsForInvoice,
  invoiceAmountsFromSupply,
  createInvoiceFromTasks,
  invoiceDraftForPdf,
  deleteInvoice,
  dashboardStats,
  ...deliverables, // 자료 전달 도메인 재export(src/data/deliverables.js): listDeliverablesForProject·getDeliverableForUser·getDeliverableByToken·recentDeliverables
  balanceOf,
  payStatusOf,
  isOverdue,
  listInvoices,
  getInvoiceForUser,
  ...studio, // 스튜디오 설정 도메인 재export(src/data/studio.js): getStudioInfo/setStudioInfo·getStudioLogo/setStudioLogo·getStudioHours/setStudioHours·getProMinutes/setProMinutes·getDefaultBooker/setDefaultBooker·studioStartSlots
  ensureInvoiceNumber,
  invoiceStats,
  listInvoicesForProject,
  listSessionsForProject,
  listSessionDirectors,
  sessionAttendeeEmails,
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
  ...revenue, // 매출 집계 도메인 재export(src/data/revenue.js): revenueByEngineer·revenueForEngineer
  ...clientFiles, // 클라이언트 첨부 서류 도메인 재export(src/data/client-files.js): getClientFile·listClientFiles·upsertClientFile·deleteClientFile
};
