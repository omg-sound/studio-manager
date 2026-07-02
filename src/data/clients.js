"use strict";

/**
 * 클라이언트(거래처=실결제자) + 작업 담당자(project_managers) 마스터 도메인.
 * 아티스트·소속사/레이블·제작사 자동 등록, 담당자↔청구처('기타') 매핑, 외주 정산 조회 등.
 * data.js에서 분리한 모듈(도메인 모듈화). data.js가 재export하므로 소비자 무변경.
 *
 * cross-domain: resolveContactByName만 contacts.createContact를 호출한다.
 * contacts는 clients 함수를 호출하지 않으므로(무순환) ./contacts를 직접 require한다.
 * getManagerByUserId·ensureClient는 내부 전용(공개 API 미노출; getManagerByUserId는 tracks가 사용).
 */

const { db } = require("../db");
const { normalizeClientKind } = require("../config");
const { todayYmd } = require("../lib/date");
const { createContact } = require("./contacts"); // 무순환(contacts는 clients를 호출하지 않음)

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

module.exports = {
  listClients,
  clientKindCounts,
  getClient,
  listProjectsForClient,
  listInvoicesForClientEntity,
  getWorker,
  getManagerByUserId, // 내부 전용(tracks createTask 기본 담당자) — data.js가 로컬 바인딩, 공개 API 미노출
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
};
