"use strict";

/**
 * 트랙/콘텐츠 + 모듈형 작업(Task) CRUD 도메인.
 * 청구 후보·채번 등 빌링 헬퍼는 invoices 도메인, 프로젝트 삭제는 projects 도메인으로 분리됨.
 * data.js에서 분리한 모듈(도메인 모듈화). data.js가 재export하므로 소비자 무변경.
 *
 * cross-domain: getProjectForUser(projects)·getManagerByUserId(clients)·normalizeTaskTypeDb/
 * taskTypeUnitPrice(task-types)를 호출한다. 이 도메인들은 tracks를 호출하지 않으므로(무순환)
 * 형제 모듈을 직접 require한다. resolveTaskEngineer는 내부 전용(공개 API 미노출).
 */

const { db } = require("../db");
const { normalizeTrackContentType, normalizeTaskStatus } = require("../config");
const { parseMoney } = require("../lib/forms");
const { getProjectForUser } = require("./projects"); // 무순환
const { getManagerByUserId } = require("./parties"); // 무순환
const { normalizeTaskTypeDb, taskTypeUnitPrice } = require("./task-types"); // 무순환

const parseWon = parseMoney; // 내부 호출명 parseWon 유지

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
      `SELECT tr.*, COALESCE(p.production_id, p.agency_id, p.artist_id) AS client_id, p.title AS project_title
       FROM project_tracks tr
       JOIN projects p ON p.id = tr.project_id
       WHERE tr.id = ?`
    )
    .get(trackId);
  return track || null;
}

/** 콤마 다중 아티스트 표시 정규화("아이유,태연 " → "아이유, 태연") — 프로젝트 artist TEXT와 동일 규칙(2026-07-05). */
function normalizeArtistList(value) {
  return String(value || "").split(",").map((s) => s.trim()).filter(Boolean).join(", ");
}

function createTrack(user, projectId, input = {}) {
  const project = getProjectForUser(user, projectId);
  if (!project) return null;
  const title = String(input.title || "").trim();
  if (!title) throw new Error("TRACK_TITLE_REQUIRED");
  const artist = normalizeArtistList(input.artist) || project.artist || null; // 곡별 아티스트(콤마 여러 명·정규화), 미입력 시 프로젝트 아티스트
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
  const artist = input.artist !== undefined ? (normalizeArtistList(input.artist) || null) : track.artist; // 폼에 아티스트 있으면 갱신(콤마 정규화)
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
      `SELECT t.*, tr.project_id, tr.title AS track_title, tr.content_type, COALESCE(p.production_id, p.agency_id, p.artist_id) AS client_id
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

module.exports = {
  listTracksForProject,
  getTrackForUser,
  createTrack,
  updateTrack,
  deleteTrack,
  getTaskForUser,
  setTaskAmount,
  updateTask,
  deleteTask,
  createTask,
};
