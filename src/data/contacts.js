"use strict";

/**
 * 연락처(사람) 도메인 — contacts + 소속 이력(contact_affiliations) + 담당자(project_managers)↔연락처 연동.
 * 회사(clients)와 별개 '사람' 마스터. 소속은 타임라인(ended_on NULL=현재 소속).
 * data.js에서 분리한 모듈(도메인 모듈화). data.js가 재export하므로 소비자 무변경.
 *
 * 이 도메인은 다른 data 도메인의 함수를 호출하지 않는다(clients·sessions 등은 raw SQL로 접근).
 * 따라서 db·splitKoreanName·todayYmd만 import하면 자기완결적이다.
 * resolveContactName·blankToNull은 내부 전용(공개 API 미노출).
 */

const { db } = require("../db");
const { splitKoreanName } = require("../lib/korean-name");
const { todayYmd } = require("../lib/date");

const blankToNull = (v) => { const s = String(v == null ? "" : v).trim(); return s || null; };
// 전화번호 정규화: 숫자 11자리→010-####-####, 10자리→###-###-####, 그 외는 입력 보존. 빈값 null.
const formatPhone = (v) => {
  const raw = String(v == null ? "" : v).trim();
  if (!raw) return null;
  const d = raw.replace(/\D/g, "");
  if (d.length === 11) return `${d.slice(0, 3)}-${d.slice(3, 7)}-${d.slice(7)}`; // 010-####-####
  if (d.length === 10 && d.startsWith("02")) return `${d.slice(0, 2)}-${d.slice(2, 6)}-${d.slice(6)}`; // 서울 02-####-####
  return raw; // 그 외(지역번호 다양)는 입력 보존
};

// staff: true=녹음실 스태프(user_id 연결, owner 포함)만, false=외부/고객측(user_id 없음)만, undefined=전체.
function listContacts({ q, staff } = {}) {
  const where = [];
  const args = [];
  const term = String(q || "").trim();
  if (term) { where.push("(name LIKE ? OR phone LIKE ?)"); args.push(`%${term}%`, `%${term}%`); }
  if (staff === true) where.push("user_id IS NOT NULL");
  else if (staff === false) where.push("user_id IS NULL");
  const sql = "SELECT * FROM contacts" + (where.length ? " WHERE " + where.join(" AND ") : "") + " ORDER BY name COLLATE NOCASE";
  return db().prepare(sql).all(...args);
}

function getContact(id) {
  return db().prepare("SELECT * FROM contacts WHERE id = ?").get(Number(id)) || null;
}

/** 표시명(name) 자동 생성: honorific+family_name+given_name 조합, 없으면 nickname, 모두 없으면 예외. */
function resolveContactName({ name, honorific, family_name, given_name, nickname } = {}) {
  const explicit = String(name || "").trim();
  if (explicit) return explicit;
  const fullName = `${String(family_name || "").trim()}${String(given_name || "").trim()}`; // 한국식: 성+이름 붙임
  const h = String(honorific || "").trim();
  if (fullName || h) return [fullName, h].filter(Boolean).join(" "); // 호칭만 띄움 → "김보종 대표님"
  const nick = String(nickname || "").trim();
  if (nick) return nick;
  throw new Error("CONTACT_NAME_REQUIRED");
}

function createContact({ name, phone, email, memo, family_name, given_name, honorific, nickname, company, job_title, department } = {}) {
  const n = resolveContactName({ name, honorific, family_name, given_name, nickname });
  // 성·이름을 명시하지 않았고 표시명(이름)이 있으면 한국식으로 자동 분리(프로젝트 담당자 콤보 등 이름만으로 자동생성되는 연락처 보강).
  let fam = blankToNull(family_name), giv = blankToNull(given_name);
  if (!fam && !giv) {
    const s = splitKoreanName(String(name || "").trim());
    if (s.family) { fam = s.family; giv = s.given || null; }
  }
  return db().prepare(
    `INSERT INTO contacts (name, phone, email, memo, family_name, given_name, honorific, nickname, company, job_title, department)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    n,
    formatPhone(phone), blankToNull(email), blankToNull(memo),
    fam, giv, blankToNull(honorific),
    blankToNull(nickname), blankToNull(company), blankToNull(job_title), blankToNull(department)
  ).lastInsertRowid;
}

function updateContact(id, { name, phone, email, memo, family_name, given_name, honorific, nickname, company, job_title, department } = {}) {
  const n = resolveContactName({ name, honorific, family_name, given_name, nickname });
  db().prepare(
    `UPDATE contacts SET name = ?, phone = ?, email = ?, memo = ?,
     family_name = ?, given_name = ?, honorific = ?, nickname = ?,
     company = ?, job_title = ?, department = ? WHERE id = ?`
  ).run(
    n,
    formatPhone(phone), blankToNull(email), blankToNull(memo),
    blankToNull(family_name), blankToNull(given_name), blankToNull(honorific),
    blankToNull(nickname), blankToNull(company), blankToNull(job_title), blankToNull(department),
    Number(id)
  );
}

function deleteContact(id) {
  // 하드 삭제: affiliations는 CASCADE, projects.contact_id는 SET NULL([[delete-only-management]]).
  db().prepare("DELETE FROM contacts WHERE id = ?").run(Number(id));
}

/** Google People API resourceName·etag 저장(생성/수정 성공 후 호출). */
function setContactGoogleRef(id, resourceName, etag) {
  db().prepare("UPDATE contacts SET google_resource_name = ?, google_etag = ? WHERE id = ?")
    .run(resourceName || null, etag || null, Number(id));
}

/** google_resource_name으로 연락처 조회(역방향 동기화용). */
function getContactByResourceName(resourceName) {
  if (!resourceName) return null;
  return db().prepare("SELECT * FROM contacts WHERE google_resource_name = ?").get(resourceName) || null;
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

/**
 * 연락처 '회사' 텍스트를 소속 이력에 반영: 회사명으로 업체 클라이언트를 찾거나(없으면 소속사/레이블로 생성),
 * 현재 소속이 그 업체가 아니면 새 소속(이직)으로 등록한다. 회사가 비면 아무것도 안 함(종료는 수동).
 * 담당자 셸('기타' + source_contact_id)과 아티스트 클라이언트에는 연결하지 않는다.
 */
function syncCompanyAffiliation(contactId, companyName, title) {
  const n = String(companyName || "").trim();
  if (!n) return null;
  const row = db()
    .prepare(
      "SELECT id FROM clients WHERE name = ? AND kind <> '아티스트' AND source_contact_id IS NULL ORDER BY (kind = '기타') ASC, id LIMIT 1"
    )
    .get(n);
  const clientId = row ? row.id : db().prepare("INSERT INTO clients (name, kind) VALUES (?, '소속사/레이블')").run(n).lastInsertRowid;
  const cur = currentAffiliation(contactId);
  if (!cur || cur.client_id !== clientId) {
    addAffiliation(contactId, { client_id: clientId, title, closeCurrent: true });
  }
  return clientId;
}

function endAffiliation(affId, endedOn) {
  db().prepare("UPDATE contact_affiliations SET ended_on = ? WHERE id = ?").run(blankToNull(endedOn) || todayYmd(), Number(affId));
}

/** 소속 이력 행 수정(회사·직함·기간·메모). ended_on을 비우면 현재 소속으로. */
function updateAffiliation(affId, { client_id, title, started_on, ended_on, memo } = {}) {
  db().prepare(
    "UPDATE contact_affiliations SET client_id = ?, title = ?, started_on = ?, ended_on = ?, memo = ? WHERE id = ?"
  ).run(client_id ? Number(client_id) : null, blankToNull(title), blankToNull(started_on), blankToNull(ended_on), blankToNull(memo), Number(affId));
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
  // 다대다(session_directors) + 레거시(director_contact_id) 모두 포함해 참여 세션 조회.
  return db().prepare(
    `SELECT s.*, p.title AS project_title
       FROM sessions s
       JOIN projects p ON p.id = s.project_id
      WHERE s.director_contact_id = @cid
         OR EXISTS (SELECT 1 FROM session_directors sd WHERE sd.session_id = s.id AND sd.contact_id = @cid)
      ORDER BY s.session_date DESC, s.start_time DESC, s.id DESC`
  ).all({ cid: Number(contactId) });
}

// ── 담당자(project_managers) ↔ 연락처(contacts) 연동 ──

/** contact_id로 연결된 담당자(project_managers) 조회. 없으면 null. */
function getManagerByContactId(contactId) {
  // 대표(owner)는 작업 담당자가 아니므로 연동 대상에서 제외(연락처 '담당자 연동' 배지 오표시 방지).
  return (
    db()
      .prepare(
        `SELECT pm.* FROM project_managers pm
         LEFT JOIN users u ON u.id = pm.user_id
         WHERE pm.contact_id = ? AND (pm.user_id IS NULL OR u.role != 'owner')`
      )
      .get(Number(contactId)) || null
  );
}

/** 연락처 유형 배지 — 녹음실 스태프(내부 로그인)/외주 작업자/고객측 담당자 + 디렉터(세션 디렉팅 겸직). aff 주입 시 소속 재조회 생략(목록 N+1 완화). */
function classifyContact(contactId, aff) {
  const id = Number(contactId);
  const badges = [];
  // 대표(owner)는 작업 담당자가 아니므로 제외(getManagerByContactId 정책과 정렬) — owner를 '녹음실 스태프'로 오표시 방지.
  const m = db()
    .prepare(
      `SELECT pm.user_id FROM project_managers pm
       LEFT JOIN users u ON u.id = pm.user_id
       WHERE pm.contact_id = ? AND (pm.user_id IS NULL OR u.role != 'owner')`
    )
    .get(id);
  if (m) {
    badges.push(m.user_id != null ? { label: "녹음실 스태프", cls: "badge-info" } : { label: "외주 작업자", cls: "badge-neutral" });
  } else {
    // 담당자 없음: owner 등 로그인 계정에 직접 연결된 연락처(contacts.user_id)면 역할 배지.
    const u = db().prepare("SELECT u.role FROM contacts c JOIN users u ON u.id = c.user_id WHERE c.id = ?").get(id);
    if (u) {
      badges.push({ label: u.role === "owner" ? "대표" : "녹음실 스태프", cls: "badge-info" });
    } else {
      const a = aff !== undefined ? aff : currentAffiliation(id);
      if (a && a.client_id) badges.push({ label: "고객측 담당자", cls: "badge-success" });
    }
  }
  const director = db()
    .prepare("SELECT 1 FROM sessions WHERE director_contact_id = @cid UNION SELECT 1 FROM session_directors WHERE contact_id = @cid LIMIT 1")
    .get({ cid: id });
  if (director) badges.push({ label: "디렉터", cls: "badge-warning" });
  if (!badges.length) badges.push({ label: "지인·기타", cls: "badge-neutral" });
  return badges;
}

/**
 * 담당자(managerId)에 연동 연락처가 없으면 contacts 행을 생성해 contact_id 연결 후 contactId 반환.
 * 이미 연결되어 있으면 기존 contact_id 반환. 외주·하우스 공통. 멱등.
 */
function ensureContactForManager(managerId) {
  const m = db().prepare("SELECT * FROM project_managers WHERE id = ?").get(Number(managerId));
  if (!m) return null;
  const { family, given } = splitKoreanName(m.name); // 담당자 이름 → 성·이름 자동 분리(하우스·외주 연동 시)
  if (m.contact_id) {
    // 기존 연락처: 성·이름이 둘 다 비어있을 때만 자동 분리값으로 채움(수동 입력 보호).
    const c = db().prepare("SELECT family_name, given_name FROM contacts WHERE id = ?").get(m.contact_id);
    if (c && !String(c.family_name || "").trim() && !String(c.given_name || "").trim() && (family || given)) {
      db().prepare("UPDATE contacts SET family_name = ?, given_name = ? WHERE id = ?").run(family || null, given || null, m.contact_id);
    }
    return m.contact_id;
  }
  // 신규 연락처 생성 + 담당자 연결을 원자화(중간 예외 시 고아 연락처 방지).
  const d = db();
  d.exec("BEGIN IMMEDIATE;");
  try {
    const contactId = createContact({ name: m.name, family_name: family, given_name: given, phone: m.phone, email: m.email });
    d.prepare("UPDATE project_managers SET contact_id = ? WHERE id = ?").run(contactId, Number(managerId));
    d.exec("COMMIT;");
    return contactId;
  } catch (e) {
    d.exec("ROLLBACK;");
    throw e;
  }
}

/**
 * 로그인 계정(녹음실 스태프, owner 포함)을 연락처에 연결·생성. 멱등.
 *  - 이미 contacts.user_id로 연결된 행이 있으면 그 행(이메일 비었을 때만 보강).
 *  - 하우스(chief/staff): 담당자(project_managers) 연락처가 있으면 그 행에 user_id 링크(중복 방지).
 *  - 담당자 연락처가 없는 계정(owner): 새 연락처 생성 후 user_id 연결.
 */
function ensureContactForUser(user) {
  if (!user || !user.id || !user.active) return null;
  const name = String(user.name || "").trim();
  if (!name) return null;
  const d = db();
  let contactId;
  const existing = d.prepare("SELECT id FROM contacts WHERE user_id = ?").get(user.id);
  if (existing) {
    contactId = existing.id;
    if (user.email) d.prepare("UPDATE contacts SET email = COALESCE(NULLIF(email, ''), ?) WHERE id = ?").run(user.email, contactId);
  } else {
    const mc = d.prepare("SELECT contact_id FROM project_managers WHERE user_id = ? AND contact_id IS NOT NULL").get(user.id);
    if (mc && mc.contact_id) {
      contactId = mc.contact_id; // 하우스: 기존 담당자 연락처 재사용(중복 방지)
      d.prepare("UPDATE contacts SET user_id = ? WHERE id = ?").run(user.id, contactId);
    } else {
      const { family, given } = splitKoreanName(name);
      contactId = createContact({ name, family_name: family, given_name: given, email: user.email });
      d.prepare("UPDATE contacts SET user_id = ? WHERE id = ?").run(user.id, contactId);
    }
  }
  // 하우스 담당자가 있는데 아직 연락처 미연결이면 같은 연락처로 연결(로그인 시 새 담당자 생성분 중복 방지).
  const mgr = d.prepare("SELECT id, contact_id FROM project_managers WHERE user_id = ?").get(user.id);
  if (mgr && !mgr.contact_id) d.prepare("UPDATE project_managers SET contact_id = ? WHERE id = ?").run(contactId, mgr.id);
  return contactId;
}

/**
 * 연락처 수정 → 연결된 담당자(project_managers) 동기화.
 * 전화: 항상. 이메일: 외주(user_id IS NULL)만 — 하우스는 users.email 보호.
 * 루프 방지: 단순 UPDATE만 수행, syncManagerToContact 재호출 금지.
 */
function syncContactToManager(contactId) {
  const c = db().prepare("SELECT phone, email FROM contacts WHERE id = ?").get(Number(contactId));
  if (!c) return;
  const m = db().prepare("SELECT id, user_id FROM project_managers WHERE contact_id = ?").get(Number(contactId));
  if (!m) return;
  if (m.user_id == null) {
    // 외주: 전화 + 이메일 동기화
    db().prepare("UPDATE project_managers SET phone = ?, email = ? WHERE id = ?").run(c.phone, c.email, m.id);
  } else {
    // 하우스: 전화만 동기화(이메일은 users.email 보호)
    db().prepare("UPDATE project_managers SET phone = ? WHERE id = ?").run(c.phone, m.id);
  }
}

/**
 * 담당자 수정 → 연결된 연락처(contacts) 동기화.
 * 전화: 항상. 이메일: 외주(user_id IS NULL)만 — 하우스는 이메일 제외.
 * 루프 방지: 단순 UPDATE만 수행, syncContactToManager 재호출 금지.
 */
function syncManagerToContact(managerId) {
  const m = db().prepare("SELECT contact_id, phone, email, user_id FROM project_managers WHERE id = ?").get(Number(managerId));
  if (!m || !m.contact_id) return;
  if (m.user_id == null) {
    // 외주: 전화 + 이메일 동기화
    db().prepare("UPDATE contacts SET phone = ?, email = ? WHERE id = ?").run(m.phone, m.email, m.contact_id);
  } else {
    // 하우스: 전화만 동기화
    db().prepare("UPDATE contacts SET phone = ? WHERE id = ?").run(m.phone, m.contact_id);
  }
}

module.exports = {
  formatPhone,
  listContacts,
  getContact,
  createContact,
  updateContact,
  deleteContact,
  setContactGoogleRef,
  getContactByResourceName,
  currentAffiliation,
  listAffiliations,
  addAffiliation,
  syncCompanyAffiliation,
  endAffiliation,
  updateAffiliation,
  deleteAffiliation,
  contactOptions,
  listContactsForClient,
  listProjectsForContact,
  listSessionsForContact,
  getManagerByContactId,
  classifyContact,
  ensureContactForManager,
  ensureContactForUser,
  syncContactToManager,
  syncManagerToContact,
};
