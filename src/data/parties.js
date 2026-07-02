"use strict";

/**
 * 당사자(Party) 통합 도메인 — parties(사람·조직·그룹) + 소속 이력(affiliations) + 담당자(project_managers) 연동.
 * clients(거래처) + contacts(사람)를 한 테이블로 통합해 정체성 이중화(source_contact_id 셸·'기타'·is_group)를 제거한다.
 *
 * 정체성 = parties.kind(person|company|group). "아티스트/청구처/담당자/디렉터/엔지니어"는 테이블이 아니라
 * parties.id 참조(역할). is_artist=아티스트 역할 플래그(person solo·group).
 *
 * cross-domain: 없음(다른 data 도메인 함수를 호출하지 않음). db·splitKoreanName·todayYmd만 import해 자기완결.
 * blankToNull·formatPhone·resolveDisplayName은 내부 전용(공개 미노출은 module.exports로 통제).
 */

const { db } = require("../db");
const { splitKoreanName } = require("../lib/korean-name");
const { todayYmd } = require("../lib/date");

const blankToNull = (v) => { const s = String(v == null ? "" : v).trim(); return s || null; };

/** 전화번호 정규화(contacts.formatPhone 이관): 11자리→010-####-####, 서울 10자리→02-####-####, 그 외 보존. */
const formatPhone = (v) => {
  const raw = String(v == null ? "" : v).trim();
  if (!raw) return null;
  const d = raw.replace(/\D/g, "");
  if (d.length === 11) return `${d.slice(0, 3)}-${d.slice(3, 7)}-${d.slice(7)}`;
  if (d.length === 10 && d.startsWith("02")) return `${d.slice(0, 2)}-${d.slice(2, 6)}-${d.slice(6)}`;
  return raw;
};

/** 표시명(name) 자동 생성(사람): 명시 name > 호칭+성+이름 > 활동명. 모두 없으면 예외. */
function resolveDisplayName({ name, honorific, family_name, given_name, activity_name } = {}) {
  const explicit = String(name || "").trim();
  if (explicit) return explicit;
  const full = `${String(family_name || "").trim()}${String(given_name || "").trim()}`;
  const h = String(honorific || "").trim();
  if (full || h) return [full, h].filter(Boolean).join(" ");
  const act = String(activity_name || "").trim();
  if (act) return act;
  throw new Error("PARTY_NAME_REQUIRED");
}

// 레거시 뷰 호환: 반환 행에 nickname 별칭(=activity_name) 부여(연락처 폼·상세가 c.nickname을 읽음). P4에서 제거.
const withLegacy = (r) => (r ? { ...r, nickname: r.activity_name } : r);

// ── 조회 ──

/**
 * 당사자 목록. filter:
 *  - kind: 'person'|'company'|'group'
 *  - artist: true → is_artist=1만
 *  - staff: true → 녹음실 스태프(user_id 연결)만, false → 비스태프만
 *  - q: 이름/활동명/전화 LIKE
 */
function listParties({ q, kind, artist, staff } = {}) {
  const where = [];
  const args = [];
  const term = String(q || "").trim();
  if (term) { where.push("(name LIKE ? OR activity_name LIKE ? OR phone LIKE ?)"); args.push(`%${term}%`, `%${term}%`, `%${term}%`); }
  if (kind) { where.push("kind = ?"); args.push(kind); }
  if (artist === true) where.push("is_artist = 1");
  if (staff === true) where.push("user_id IS NOT NULL");
  else if (staff === false) where.push("user_id IS NULL");
  const sql = "SELECT * FROM parties" + (where.length ? " WHERE " + where.join(" AND ") : "") + " ORDER BY name COLLATE NOCASE";
  return db().prepare(sql).all(...args).map(withLegacy);
}

function getParty(id) {
  return withLegacy(db().prepare("SELECT * FROM parties WHERE id = ?").get(Number(id)) || null);
}

/** kind별 개수(탭 배지). person/company/group + artist(교차). */
function partyKindCounts() {
  const rows = db().prepare("SELECT kind, COUNT(*) AS n FROM parties GROUP BY kind").all();
  const map = { person: 0, company: 0, group: 0 };
  for (const r of rows) map[r.kind] = r.n;
  map.artist = db().prepare("SELECT COUNT(*) AS n FROM parties WHERE is_artist = 1").get().n;
  return map;
}

// ── 생성/수정/삭제 ──

/** 사람(person) 생성. 성·이름 미지정 시 표시명에서 한국식 자동 분리. activity_name 있으면 is_artist=1. */
function createPerson(b = {}) {
  const name = resolveDisplayName({ ...b });
  let fam = blankToNull(b.family_name), giv = blankToNull(b.given_name);
  if (!fam && !giv) {
    const s = splitKoreanName(String(name).trim());
    if (s.family) { fam = s.family; giv = s.given || null; }
  }
  const info = db().prepare(
    `INSERT INTO parties (kind, name, activity_name, is_artist, phone, email, memo,
       family_name, given_name, honorific, department, job_title, cash_receipt_no)
     VALUES ('person', @name, @activity_name, @is_artist, @phone, @email, @memo,
       @family_name, @given_name, @honorific, @department, @job_title, @cash_receipt_no)`
  ).run({
    name,
    activity_name: blankToNull(b.activity_name),
    is_artist: b.is_artist || blankToNull(b.activity_name) ? 1 : 0,
    phone: formatPhone(b.phone), email: blankToNull(b.email), memo: blankToNull(b.memo),
    family_name: fam, given_name: giv, honorific: blankToNull(b.honorific),
    department: blankToNull(b.department), job_title: blankToNull(b.job_title),
    cash_receipt_no: blankToNull(b.cash_receipt_no),
  });
  return info.lastInsertRowid;
}

/** 조직(company) 생성. roles=겸업 CSV. */
function createCompany(b = {}) {
  const name = String(b.name || "").trim();
  if (!name) throw new Error("PARTY_NAME_REQUIRED");
  const info = db().prepare(
    `INSERT INTO parties (kind, name, phone, email, memo, biz_no, owner_name, owner_party_id, address, roles)
     VALUES ('company', @name, @phone, @email, @memo, @biz_no, @owner_name, @owner_party_id, @address, @roles)`
  ).run({
    name, phone: formatPhone(b.phone), email: blankToNull(b.email), memo: blankToNull(b.memo),
    biz_no: blankToNull(b.biz_no), owner_name: blankToNull(b.owner_name),
    owner_party_id: b.owner_party_id ? Number(b.owner_party_id) : null,
    address: blankToNull(b.address), roles: blankToNull(b.roles),
  });
  return info.lastInsertRowid;
}

/** 그룹(group) 아티스트 생성(사람 아님, is_artist=1). */
function createGroup(b = {}) {
  const name = String(b.name || "").trim();
  if (!name) throw new Error("PARTY_NAME_REQUIRED");
  const info = db().prepare(
    `INSERT INTO parties (kind, name, activity_name, is_artist, phone, email, memo, cash_receipt_no)
     VALUES ('group', @name, @activity_name, 1, @phone, @email, @memo, @cash_receipt_no)`
  ).run({
    name, activity_name: blankToNull(b.activity_name) || name,
    phone: formatPhone(b.phone), email: blankToNull(b.email), memo: blankToNull(b.memo),
    cash_receipt_no: blankToNull(b.cash_receipt_no),
  });
  return info.lastInsertRowid;
}

/** kind에 맞춰 생성 디스패치. */
function createParty(b = {}) {
  if (b.kind === "company") return createCompany(b);
  if (b.kind === "group") return createGroup(b);
  return createPerson(b);
}

/** 당사자 수정. kind는 불변(정체성). person/company/group 각 필드 갱신. */
function updateParty(id, b = {}) {
  const cur = getParty(id);
  if (!cur) return;
  if (cur.kind === "company") {
    const name = String(b.name || "").trim() || cur.name;
    db().prepare(
      `UPDATE parties SET name=?, phone=?, email=?, memo=?, biz_no=?, owner_name=?, owner_party_id=?, address=?, roles=? WHERE id=?`
    ).run(
      name, formatPhone(b.phone), blankToNull(b.email), blankToNull(b.memo),
      blankToNull(b.biz_no), blankToNull(b.owner_name), b.owner_party_id ? Number(b.owner_party_id) : null,
      blankToNull(b.address), blankToNull(b.roles), Number(id)
    );
    return;
  }
  // person / group
  const name = resolveDisplayName({ ...b, name: b.name || cur.name });
  const isArtist = b.is_artist != null ? (b.is_artist ? 1 : 0) : (blankToNull(b.activity_name) ? 1 : cur.is_artist);
  db().prepare(
    `UPDATE parties SET name=?, activity_name=?, is_artist=?, phone=?, email=?, memo=?,
       family_name=?, given_name=?, honorific=?, department=?, job_title=?, cash_receipt_no=? WHERE id=?`
  ).run(
    name, blankToNull(b.activity_name), isArtist,
    formatPhone(b.phone), blankToNull(b.email), blankToNull(b.memo),
    blankToNull(b.family_name), blankToNull(b.given_name), blankToNull(b.honorific),
    blankToNull(b.department), blankToNull(b.job_title), blankToNull(b.cash_receipt_no), Number(id)
  );
}

function deleteParty(id) {
  // 하드 삭제([[delete-only-management]]): affiliations CASCADE. 역할 참조(FK 없음)는 코드가 SET NULL 의미로 정리.
  const pid = Number(id);
  const d = db();
  d.prepare("UPDATE invoices SET payer_id = NULL WHERE payer_id = ?").run(pid);
  d.prepare("UPDATE projects SET artist_id = NULL WHERE artist_id = ?").run(pid);
  d.prepare("UPDATE projects SET agency_id = NULL WHERE agency_id = ?").run(pid);
  d.prepare("UPDATE projects SET production_id = NULL WHERE production_id = ?").run(pid);
  d.prepare("UPDATE projects SET contact_party_id = NULL WHERE contact_party_id = ?").run(pid);
  d.prepare("UPDATE project_managers SET party_id = NULL WHERE party_id = ?").run(pid);
  d.prepare("UPDATE sessions SET director_party_id = NULL WHERE director_party_id = ?").run(pid);
  d.prepare("DELETE FROM session_directors WHERE party_id = ?").run(pid);
  d.prepare("UPDATE parties SET owner_party_id = NULL WHERE owner_party_id = ?").run(pid);
  d.prepare("DELETE FROM parties WHERE id = ?").run(pid);
}

// ── Google People 동기화 참조 ──
function setPartyGoogleRef(id, resourceName, etag) {
  db().prepare("UPDATE parties SET google_resource_name = ?, google_etag = ? WHERE id = ?").run(resourceName || null, etag || null, Number(id));
}
function getPartyByResourceName(resourceName) {
  if (!resourceName) return null;
  return db().prepare("SELECT * FROM parties WHERE google_resource_name = ?").get(resourceName) || null;
}

// ── 소속 이력(affiliations) — 사람 party 기준 ──

function currentAffiliation(personId) {
  return db().prepare(
    `SELECT a.*, o.name AS org_name, o.kind AS org_kind
       FROM affiliations a LEFT JOIN parties o ON o.id = a.org_id
      WHERE a.person_id = ? AND a.ended_on IS NULL
      ORDER BY a.started_on DESC, a.id DESC LIMIT 1`
  ).get(Number(personId)) || null;
}

function listAffiliations(personId) {
  return db().prepare(
    `SELECT a.*, o.name AS org_name, o.kind AS org_kind
       FROM affiliations a LEFT JOIN parties o ON o.id = a.org_id
      WHERE a.person_id = ?
      ORDER BY (a.ended_on IS NULL) DESC, COALESCE(a.started_on, '') DESC, a.id DESC`
  ).all(Number(personId));
}

/** 소속 추가. closeCurrent(기본 true)면 기존 현재 소속을 종료 후 새 소속 INSERT(이직). */
function addAffiliation(personId, { org_id, title, started_on, memo, closeCurrent = true } = {}) {
  const pid = Number(personId);
  const start = blankToNull(started_on);
  if (closeCurrent) {
    db().prepare("UPDATE affiliations SET ended_on = ? WHERE person_id = ? AND ended_on IS NULL").run(start || todayYmd(), pid);
  }
  return db().prepare(
    "INSERT INTO affiliations (person_id, org_id, title, started_on, memo) VALUES (?, ?, ?, ?, ?)"
  ).run(pid, org_id ? Number(org_id) : null, blankToNull(title), start, blankToNull(memo)).lastInsertRowid;
}

function endAffiliation(affId, endedOn) {
  db().prepare("UPDATE affiliations SET ended_on = ? WHERE id = ?").run(blankToNull(endedOn) || todayYmd(), Number(affId));
}

function updateAffiliation(affId, { org_id, title, started_on, ended_on, memo } = {}) {
  db().prepare(
    "UPDATE affiliations SET org_id = ?, title = ?, started_on = ?, ended_on = ?, memo = ? WHERE id = ?"
  ).run(org_id ? Number(org_id) : null, blankToNull(title), blankToNull(started_on), blankToNull(ended_on), blankToNull(memo), Number(affId));
}

function deleteAffiliation(affId) {
  db().prepare("DELETE FROM affiliations WHERE id = ?").run(Number(affId));
}

/**
 * '회사' 텍스트를 소속 이력에 반영: 회사명으로 company party를 찾거나(없으면 생성), 현재 소속이 그 회사가 아니면 이직 등록.
 * 회사 비면 no-op. clients.syncCompanyAffiliation 이관(party 기준).
 */
function syncCompanyAffiliation(personId, companyName, title) {
  const n = String(companyName || "").trim();
  if (!n) return null;
  const row = db().prepare("SELECT id FROM parties WHERE name = ? AND kind = 'company' ORDER BY id LIMIT 1").get(n);
  const orgId = row ? row.id : createCompany({ name: n, roles: "소속사/레이블" });
  const cur = currentAffiliation(personId);
  if (!cur || cur.org_id !== orgId) addAffiliation(personId, { org_id: orgId, title, closeCurrent: true });
  return orgId;
}

// ── 관계 조회 ──

/** 조직에 현재 소속된 사람(조직 상세 '담당자/직원'). */
function listPersonsForOrg(orgId) {
  return db().prepare(
    `SELECT p.*, a.title AS aff_title FROM affiliations a
       JOIN parties p ON p.id = a.person_id
      WHERE a.org_id = ? AND a.ended_on IS NULL
      ORDER BY p.name COLLATE NOCASE`
  ).all(Number(orgId));
}

/** 이 사람을 대표자로 둔 조직들(양방향 표시). */
function orgsWithOwnerParty(personId) {
  return db().prepare("SELECT id, name, kind FROM parties WHERE owner_party_id = ? ORDER BY name").all(Number(personId));
}

/** 당사자가 관여한 프로젝트(아티스트/소속사/제작사/담당자). */
function listProjectsForParty(partyId) {
  const id = Number(partyId);
  return db().prepare(
    `SELECT DISTINCT p.* FROM projects p
      WHERE p.artist_id = @id OR p.agency_id = @id OR p.production_id = @id OR p.contact_party_id = @id
      ORDER BY p.created_at DESC, p.id DESC`
  ).all({ id });
}

/** 당사자가 청구처(payer)인 인보이스 전체. */
function listInvoicesForParty(partyId) {
  return db().prepare(
    `SELECT i.*, p.title AS project_title FROM invoices i
       LEFT JOIN projects p ON p.id = i.project_id
      WHERE i.payer_id = ?
      ORDER BY i.created_at DESC, i.id DESC`
  ).all(Number(partyId));
}

/** 당사자가 디렉터로 지정된 세션(당사자 상세 '참여 세션'). */
function listSessionsForParty(partyId) {
  return db().prepare(
    `SELECT s.*, p.title AS project_title FROM sessions s
       JOIN projects p ON p.id = s.project_id
      WHERE s.director_party_id = @id
         OR EXISTS (SELECT 1 FROM session_directors sd WHERE sd.session_id = s.id AND sd.party_id = @id)
      ORDER BY s.session_date DESC, s.start_time DESC, s.id DESC`
  ).all({ id: Number(partyId) });
}

// ── 콤보/피커 옵션 ──

/**
 * 통합 당사자 콤보 옵션. role:
 *  - 'artist'  → is_artist 우선(사람 solo + 그룹)
 *  - 'company' → 조직만
 *  - 'person'  → 사람만
 *  - 'payer'/undefined → 전체(청구처)
 * 반환: [{ id, name, activity_name, kind, is_artist, sub(분류·소속 힌트) }] 이름 오름차순.
 */
function partyOptions({ role } = {}) {
  const where = [];
  if (role === "artist") where.push("is_artist = 1");
  else if (role === "company") where.push("kind = 'company'");
  else if (role === "person") where.push("kind IN ('person')");
  const sql =
    `SELECT p.id, p.name, p.activity_name, p.kind, p.is_artist,
            (SELECT o.name FROM affiliations a LEFT JOIN parties o ON o.id = a.org_id
              WHERE a.person_id = p.id AND a.ended_on IS NULL ORDER BY a.started_on DESC, a.id DESC LIMIT 1) AS company
       FROM parties p` + (where.length ? " WHERE " + where.join(" AND ") : "") + " ORDER BY p.name COLLATE NOCASE";
  return db().prepare(sql).all().map((p) => ({
    id: p.id, name: p.name, activity_name: p.activity_name, kind: p.kind, is_artist: p.is_artist,
    sub: p.kind === "company" ? "조직" : p.kind === "group" ? "그룹" : (p.is_artist ? "아티스트" : (p.company || "사람")),
  }));
}

// ── 역할 배지 ──

/** 당사자 역할 배지 — 조직/그룹/아티스트/스태프/외주/담당자/디렉터/대표. */
function classifyParty(party) {
  const p = typeof party === "object" ? party : getParty(party);
  if (!p) return [{ label: "미상", cls: "badge-neutral" }];
  const id = p.id;
  const badges = [];
  if (p.kind === "company") badges.push({ label: "조직", cls: "badge-neutral" });
  if (p.kind === "group") badges.push({ label: "그룹", cls: "badge-info" });
  if (p.is_artist) badges.push({ label: "아티스트", cls: "badge-info" });
  // 담당자(엔지니어) 연동
  const m = db().prepare(
    `SELECT pm.user_id FROM project_managers pm LEFT JOIN users u ON u.id = pm.user_id
      WHERE pm.party_id = ? AND (pm.user_id IS NULL OR u.role != 'owner')`
  ).get(id);
  if (m) badges.push(m.user_id != null ? { label: "녹음실 스태프", cls: "badge-info" } : { label: "외주 작업자", cls: "badge-neutral" });
  else {
    const u = p.user_id ? db().prepare("SELECT role FROM users WHERE id = ?").get(p.user_id) : null;
    if (u) badges.push({ label: u.role === "owner" ? "대표" : "녹음실 스태프", cls: "badge-info" });
    else {
      const a = currentAffiliation(id);
      if (a && a.org_id) badges.push({ label: "고객측 담당자", cls: "badge-success" });
    }
  }
  const director = db().prepare(
    "SELECT 1 FROM sessions WHERE director_party_id = @id UNION SELECT 1 FROM session_directors WHERE party_id = @id LIMIT 1"
  ).get({ id });
  if (director) badges.push({ label: "디렉터", cls: "badge-warning" });
  if (!badges.length) badges.push({ label: "지인·기타", cls: "badge-neutral" });
  return badges;
}

// ── 담당자(project_managers) ↔ party 연동 ──

function getManagerByUserId(userId) {
  if (!userId) return null;
  return db().prepare("SELECT * FROM project_managers WHERE user_id = ?").get(Number(userId)) || null;
}

/** party_id로 연결된 담당자(owner 제외). */
function getManagerByPartyId(partyId) {
  return db().prepare(
    `SELECT pm.* FROM project_managers pm LEFT JOIN users u ON u.id = pm.user_id
      WHERE pm.party_id = ? AND (pm.user_id IS NULL OR u.role != 'owner')`
  ).get(Number(partyId)) || null;
}

/** 담당자에 연동 party가 없으면 person party 생성·연결 후 party id 반환. 멱등. */
function ensurePartyForManager(managerId) {
  const m = db().prepare("SELECT * FROM project_managers WHERE id = ?").get(Number(managerId));
  if (!m) return null;
  const { family, given } = splitKoreanName(m.name);
  if (m.party_id) {
    const p = db().prepare("SELECT family_name, given_name FROM parties WHERE id = ?").get(m.party_id);
    if (p && !String(p.family_name || "").trim() && !String(p.given_name || "").trim() && (family || given)) {
      db().prepare("UPDATE parties SET family_name = ?, given_name = ? WHERE id = ?").run(family || null, given || null, m.party_id);
    }
    return m.party_id;
  }
  const d = db();
  d.exec("BEGIN IMMEDIATE;");
  try {
    const partyId = createPerson({ name: m.name, family_name: family, given_name: given, phone: m.phone, email: m.email });
    d.prepare("UPDATE project_managers SET party_id = ? WHERE id = ?").run(partyId, Number(managerId));
    d.exec("COMMIT;");
    return partyId;
  } catch (e) {
    d.exec("ROLLBACK;");
    throw e;
  }
}

/** 로그인 계정(스태프·owner)을 party에 연결·생성. 멱등. 하우스는 담당자 party 재사용(중복 방지). */
function ensurePartyForUser(user) {
  if (!user || !user.id || !user.active) return null;
  const name = String(user.name || "").trim();
  if (!name) return null;
  const d = db();
  let partyId;
  const existing = d.prepare("SELECT id FROM parties WHERE user_id = ?").get(user.id);
  if (existing) {
    partyId = existing.id;
    if (user.email) d.prepare("UPDATE parties SET email = COALESCE(NULLIF(email, ''), ?) WHERE id = ?").run(user.email, partyId);
  } else {
    const mc = d.prepare("SELECT party_id FROM project_managers WHERE user_id = ? AND party_id IS NOT NULL").get(user.id);
    if (mc && mc.party_id) {
      partyId = mc.party_id;
      d.prepare("UPDATE parties SET user_id = ? WHERE id = ?").run(user.id, partyId);
    } else {
      const { family, given } = splitKoreanName(name);
      partyId = createPerson({ name, family_name: family, given_name: given, email: user.email });
      d.prepare("UPDATE parties SET user_id = ? WHERE id = ?").run(user.id, partyId);
    }
  }
  const mgr = d.prepare("SELECT id, party_id FROM project_managers WHERE user_id = ?").get(user.id);
  if (mgr && !mgr.party_id) d.prepare("UPDATE project_managers SET party_id = ? WHERE id = ?").run(partyId, mgr.id);
  return partyId;
}

/** party 수정 → 연결 담당자 동기화(전화 항상, 이메일은 외주만). 루프 방지. */
function syncPartyToManager(partyId) {
  const p = db().prepare("SELECT phone, email FROM parties WHERE id = ?").get(Number(partyId));
  if (!p) return;
  const m = db().prepare("SELECT id, user_id FROM project_managers WHERE party_id = ?").get(Number(partyId));
  if (!m) return;
  if (m.user_id == null) db().prepare("UPDATE project_managers SET phone = ?, email = ? WHERE id = ?").run(p.phone, p.email, m.id);
  else db().prepare("UPDATE project_managers SET phone = ? WHERE id = ?").run(p.phone, m.id);
}

/** 담당자 수정 → 연결 party 동기화(전화 항상, 이메일은 외주만). 루프 방지. */
function syncManagerToParty(managerId) {
  const m = db().prepare("SELECT party_id, phone, email, user_id FROM project_managers WHERE id = ?").get(Number(managerId));
  if (!m || !m.party_id) return;
  if (m.user_id == null) db().prepare("UPDATE parties SET phone = ?, email = ? WHERE id = ?").run(m.phone, m.email, m.party_id);
  else db().prepare("UPDATE parties SET phone = ? WHERE id = ?").run(m.phone, m.party_id);
}

/** 이름으로 사람 party 찾기 — 유일 매칭만 재사용(동명이인 오연결 방지), 아니면 새로 생성. 아티스트/담당자 연결용. */
function resolvePersonByName(name, { createIfMissing = true } = {}) {
  const n = String(name || "").trim();
  if (!n) return null;
  const rows = db().prepare("SELECT id FROM parties WHERE kind = 'person' AND name = ?").all(n);
  if (rows.length === 1) return rows[0].id;
  if (!createIfMissing) return null;
  return createPerson({ name: n });
}

/** 프로젝트 저장 시 아티스트/소속사/제작사를 party로 보장(이름 기반). 반환 없음(프로젝트가 party_id로 저장). */
function listProjectManagers({ includeInactive = false, externalOnly = false } = {}) {
  const where = [];
  if (!includeInactive) where.push("active = 1");
  if (externalOnly) where.push("user_id IS NULL");
  return db().prepare(
    `SELECT * FROM project_managers ${where.length ? "WHERE " + where.join(" AND ") : ""} ORDER BY active DESC, name COLLATE NOCASE`
  ).all();
}

/** 외주 작업자 단건. */
function getWorker(id) {
  return db().prepare("SELECT * FROM project_managers WHERE id = ? AND user_id IS NULL").get(Number(id)) || null;
}

module.exports = {
  formatPhone,
  listParties,
  getParty,
  partyKindCounts,
  createParty,
  createPerson,
  createCompany,
  createGroup,
  updateParty,
  deleteParty,
  setPartyGoogleRef,
  getPartyByResourceName,
  currentAffiliation,
  listAffiliations,
  addAffiliation,
  endAffiliation,
  updateAffiliation,
  deleteAffiliation,
  syncCompanyAffiliation,
  listPersonsForOrg,
  orgsWithOwnerParty,
  listProjectsForParty,
  listInvoicesForParty,
  listSessionsForParty,
  partyOptions,
  classifyParty,
  getManagerByUserId,
  getManagerByPartyId,
  ensurePartyForManager,
  ensurePartyForUser,
  syncPartyToManager,
  syncManagerToParty,
  resolvePersonByName,
  listProjectManagers,
  getWorker,
};
