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

/** 사람(person) 생성. 성·이름 미지정 시 표시명에서 한국식 자동 분리. activity_name(=nickname 별칭) 있으면 is_artist=1. */
function createPerson(b = {}) {
  b = { ...b, activity_name: b.activity_name || b.nickname }; // 연락처 폼은 활동명을 nickname 필드로 보냄
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
    `INSERT INTO parties (kind, name, activity_name, is_artist, phone, email, memo, cash_receipt_no, contact_party_id)
     VALUES ('group', @name, @activity_name, 1, @phone, @email, @memo, @cash_receipt_no, @contact_party_id)`
  ).run({
    name, activity_name: blankToNull(b.activity_name) || name,
    phone: formatPhone(b.phone), email: blankToNull(b.email), memo: blankToNull(b.memo),
    cash_receipt_no: blankToNull(b.cash_receipt_no),
    contact_party_id: b.contact_party_id ? Number(b.contact_party_id) : null, // 담당자(멤버/관계자 사람)
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
  b = { ...b, activity_name: b.activity_name != null ? b.activity_name : b.nickname }; // 활동명=nickname 별칭(연락처 폼)
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
  // 그룹 담당자(contact_party_id): 폼이 값을 보냈으면(undefined 아님) 갱신, 아니면 기존 보존(person 폼은 안 보냄).
  const contactPartyId = b.contact_party_id !== undefined ? (b.contact_party_id ? Number(b.contact_party_id) : null) : (cur.contact_party_id || null);
  db().prepare(
    `UPDATE parties SET name=?, activity_name=?, is_artist=?, phone=?, email=?, memo=?,
       family_name=?, given_name=?, honorific=?, department=?, job_title=?, cash_receipt_no=?, contact_party_id=? WHERE id=?`
  ).run(
    name, blankToNull(b.activity_name), isArtist,
    formatPhone(b.phone), blankToNull(b.email), blankToNull(b.memo),
    blankToNull(b.family_name), blankToNull(b.given_name), blankToNull(b.honorific),
    blankToNull(b.department), blankToNull(b.job_title), blankToNull(b.cash_receipt_no), contactPartyId, Number(id)
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
  d.prepare("UPDATE parties SET group_id = NULL WHERE group_id = ?").run(pid); // 그룹 삭제 시 멤버 소속 해제
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
// UI/뷰 호환: 반환 행에 client_* 별칭(org_*와 동일) 부여 — 소속 이력 렌더가 client_id/client_name/client_kind를 읽음.
const affShape = (a) => (a ? { ...a, client_id: a.org_id, client_name: a.org_name, client_kind: a.org_kind } : a);

function currentAffiliation(personId) {
  return affShape(db().prepare(
    `SELECT a.*, o.name AS org_name, o.kind AS org_kind
       FROM affiliations a LEFT JOIN parties o ON o.id = a.org_id
      WHERE a.person_id = ? AND a.ended_on IS NULL
      ORDER BY a.started_on DESC, a.id DESC LIMIT 1`
  ).get(Number(personId)) || null);
}

function listAffiliations(personId) {
  return db().prepare(
    `SELECT a.*, o.name AS org_name, o.kind AS org_kind
       FROM affiliations a LEFT JOIN parties o ON o.id = a.org_id
      WHERE a.person_id = ?
      ORDER BY (a.ended_on IS NULL) DESC, COALESCE(a.started_on, '') DESC, a.id DESC`
  ).all(Number(personId)).map(affShape);
}

/** 소속 추가. org_id(=client_id 별칭). closeCurrent(기본 true)면 기존 현재 소속을 종료 후 새 소속 INSERT(이직). */
function addAffiliation(personId, { org_id, client_id, title, started_on, memo, closeCurrent = true } = {}) {
  if (org_id == null) org_id = client_id; // client_id 별칭(레거시 호출 호환)
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

function updateAffiliation(affId, { org_id, client_id, title, started_on, ended_on, memo } = {}) {
  if (org_id == null) org_id = client_id; // client_id 별칭(레거시 호출 호환)
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

/** 외주 작업자가 담당한 작업(track_tasks) + 프로젝트/트랙 — 정산. 매칭: engineer_id 우선, 폴백 engineer_name. */
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

/** 외주 작업 지급 처리/해제(정산). */
function setTaskPayout(taskId, paid) {
  const p = paid ? 1 : 0;
  db().prepare("UPDATE track_tasks SET worker_paid = ?, worker_paid_date = ? WHERE id = ?").run(p, p ? todayYmd() : null, Number(taskId));
}

// ── UI 편의 조회(연락처=사람 뷰, 클라이언트=업체·아티스트 뷰) ──

/**
 * 연락처 목록 = 사람(person) party. tab:
 *  - 'staff'    → 녹음실 스태프(로그인 계정, user_id 연결)
 *  - 'worker'   → 외주 작업자(project_managers user_id NULL·party 연결, 스태프 아님)
 *  - 'external' → 외부 연락처(그 외 사람 — 스태프·외주 아님)
 *  - undefined  → 전체 사람. (레거시 staff:boolean도 허용)
 */
function listContacts({ q, tab, staff } = {}) {
  if (staff === true) tab = "staff";
  else if (staff === false && !tab) tab = undefined; // 레거시 staff:false=외부(외주 포함)와 구분 위해 tab 우선
  const where = ["p.kind = 'person'"];
  const args = [];
  const term = String(q || "").trim();
  if (term) { where.push("(p.name LIKE ? OR p.activity_name LIKE ? OR p.phone LIKE ?)"); args.push(`%${term}%`, `%${term}%`, `%${term}%`); }
  const workerSub = "p.id IN (SELECT party_id FROM project_managers WHERE user_id IS NULL AND party_id IS NOT NULL)";
  if (tab === "staff") where.push("p.user_id IS NOT NULL");
  else if (tab === "worker") where.push("p.user_id IS NULL AND " + workerSub);
  else if (tab === "external") where.push("p.user_id IS NULL AND NOT (" + workerSub + ")");
  const sql = "SELECT p.* FROM parties p WHERE " + where.join(" AND ") + " ORDER BY p.name COLLATE NOCASE";
  return db().prepare(sql).all(...args).map(withLegacy);
}

/**
 * 관계자(클라이언트 측 '사람' — 비아티스트): 대표·A&R·담당자·디렉터·작가 등.
 * person·is_artist=0·비스태프(user_id null)·비외주. 클라이언트 '관계자' 탭. 상세는 연락처(/contacts/:id).
 */
function listAssociates({ q } = {}) {
  const where = [
    "p.kind = 'person'", "p.is_artist = 0", "p.user_id IS NULL",
    "p.id NOT IN (SELECT party_id FROM project_managers WHERE user_id IS NULL AND party_id IS NOT NULL)",
  ];
  const args = [];
  const term = String(q || "").trim();
  if (term) { where.push("(p.name LIKE ? OR p.phone LIKE ?)"); args.push(`%${term}%`, `%${term}%`); }
  return db().prepare("SELECT p.* FROM parties p WHERE " + where.join(" AND ") + " ORDER BY p.name COLLATE NOCASE").all(...args).map(withLegacy);
}

/** 클라이언트 목록 = 업체(company)·그룹·아티스트(사람 포함). kind로 좁힘(레거시 라벨/파티 kind 모두 허용). */
function listClients({ kind } = {}) {
  if (kind === "소속사/레이블" || kind === "제작사" || kind === "company" || kind === "조직") return listParties({ kind: "company" });
  if (kind === "아티스트" || kind === "artist") return listParties({ artist: true });
  if (kind === "group" || kind === "그룹") return listParties({ kind: "group" });
  return db().prepare("SELECT * FROM parties WHERE kind IN ('company','group') OR is_artist = 1 ORDER BY name COLLATE NOCASE").all().map(withLegacy);
}

/** 거래처 kind 카운트(탭 배지) — 레거시 라벨 키 포함. */
function clientKindCounts() {
  const c = partyKindCounts();
  return { "소속사/레이블": c.company, "제작사": 0, "아티스트": c.artist, "기타": 0, company: c.company, group: c.group, artist: c.artist };
}

/** 콤보 옵션: 담당자(사람) — {id, name, phone, email, current_client(현재 소속)}. */
function contactOptions() {
  return db()
    .prepare(
      `SELECT p.id, p.name, p.phone, p.email,
              (SELECT o.name FROM affiliations a LEFT JOIN parties o ON o.id = a.org_id
                WHERE a.person_id = p.id AND a.ended_on IS NULL ORDER BY a.started_on DESC, a.id DESC LIMIT 1) AS current_client,
              (SELECT g.name FROM parties g WHERE g.id = p.group_id AND g.kind = 'group') AS group_name
         FROM parties p WHERE p.kind = 'person' ORDER BY p.name COLLATE NOCASE`
    )
    .all();
}

/** 콤보 옵션: 청구처(전체 당사자) — {id, name(아티스트=활동명), kind}. */
function clientOptions() {
  return db()
    .prepare(
      `SELECT p.id, COALESCE(NULLIF(p.activity_name,''), p.name) AS name, p.kind,
              (SELECT g.name FROM parties g WHERE g.id = p.group_id AND g.kind = 'group') AS group_name,
              (SELECT o.name FROM affiliations a LEFT JOIN parties o ON o.id = a.org_id
                WHERE a.person_id = p.id AND a.ended_on IS NULL ORDER BY a.started_on DESC, a.id DESC LIMIT 1) AS current_client
         FROM parties p WHERE p.kind IN ('company','group') OR p.is_artist = 1 ORDER BY name COLLATE NOCASE`
    )
    .all();
}

/** 업체(조직) 소속 아티스트 — affiliations 기반. */
function listArtistsForAgency(orgId) {
  return db()
    .prepare(
      `SELECT p.id, COALESCE(NULLIF(p.activity_name,''), p.name) AS name FROM affiliations a
         JOIN parties p ON p.id = a.person_id
        WHERE a.org_id = ? AND a.ended_on IS NULL AND p.is_artist = 1 ORDER BY p.name`
    )
    .all(Number(orgId));
}

/** 이름으로 조직 찾기(자동 생성 안 함). */
function resolveCompanyByName(name) {
  const n = String(name || "").trim();
  if (!n) return null;
  const ex = db().prepare("SELECT id FROM parties WHERE kind = 'company' AND name = ? ORDER BY id LIMIT 1").get(n);
  return ex ? ex.id : null;
}

// ── 그룹 ↔ 소속 멤버 연결(parties.group_id) ──

/** 사람(아티스트)의 소속 그룹 지정/해제. groupId=null이면 그룹에서 제거. group 파티만 유효(아니면 무시). */
function setPartyGroup(personId, groupId) {
  const pid = Number(personId);
  const prev = db().prepare("SELECT group_id FROM parties WHERE id = ?").get(pid);
  const prevGid = prev && prev.group_id ? Number(prev.group_id) : null;
  let gid = groupId ? Number(groupId) : null;
  if (gid) {
    const g = db().prepare("SELECT id FROM parties WHERE id = ? AND kind = 'group'").get(gid);
    if (!g) gid = null; // 그룹이 아니면 무시(오연결 방지)
  }
  db().prepare("UPDATE parties SET group_id = ? WHERE id = ? AND kind = 'person'").run(gid, pid);
  // **새로 그룹에 소속됐을 때만**(이전과 다른 그룹) 그룹 소속사를 기본 상속 — 같은 그룹 재저장 시 재상속·타임라인 오염 방지. 이후 멤버 개별 변경 가능.
  if (gid && gid !== prevGid) {
    const gAgency = currentAgencyId(gid);
    if (gAgency != null) setAgencyRaw(pid, gAgency);
  }
  return gid;
}

/** 그룹의 소속 멤버(사람) 목록 — 활동명 우선 표시. */
function listGroupMembers(groupId) {
  return db().prepare(
    `SELECT id, name, activity_name, COALESCE(NULLIF(activity_name,''), name) AS display_name, phone, email
       FROM parties WHERE group_id = ? AND kind = 'person' ORDER BY name COLLATE NOCASE`
  ).all(Number(groupId));
}

/** 사람의 소속 그룹 파티(없으면 null). */
function groupOfParty(personId) {
  const p = db().prepare("SELECT group_id FROM parties WHERE id = ?").get(Number(personId));
  if (!p || !p.group_id) return null;
  return getParty(p.group_id);
}

/**
 * 한 파티의 현재 소속사만 갱신(전파 없음, 내부용) — affiliations 재사용.
 * gid 있으면 현재 소속이 다를 때 이직(closeCurrent) 등록, 없음(null)이면 현재 소속 종료.
 */
function setAgencyRaw(pid, gid) {
  gid = gid ? Number(gid) : null;
  const cur = currentAffiliation(pid);
  if (gid) {
    const org = db().prepare("SELECT id FROM parties WHERE id = ? AND kind = 'company'").get(gid);
    if (!org) return; // 회사가 아니면 무시(오연결 방지)
    if (!cur || Number(cur.org_id) !== gid) addAffiliation(pid, { org_id: gid, closeCurrent: true });
  } else if (cur) {
    endAffiliation(cur.id, todayYmd()); // '없음' → 현재 소속 종료(이력 보존)
  }
}

/**
 * 아티스트(사람)·그룹의 소속사 지정/해제. company 파티만 유효.
 * **그룹이면**: 소속사를 *따르던* 멤버(현재 소속사 = 그룹의 이전 소속사)에게 전파. 개별 지정(오버라이드)한 멤버는 유지.
 * **개인(멤버)이면**: 그 사람만 갱신(오버라이드, 전파 없음).
 * 소속사 상세의 '소속 아티스트'(listArtistsForAgency)에 자동 반영.
 */
function setPartyAgency(partyId, agencyId) {
  const pid = Number(partyId);
  const gid = agencyId ? Number(agencyId) : null;
  const p = getParty(pid);
  if (!p) return;
  if (p.kind === "group") {
    const oldAgency = currentAgencyId(pid); // 변경 전 그룹 소속사
    setAgencyRaw(pid, gid);
    if (Number(oldAgency || 0) !== Number(gid || 0)) {
      // 그룹 소속사를 따르던 멤버(이전 그룹 소속사와 동일)만 새 소속사로 전파. 다른 소속사(오버라이드)는 유지.
      const members = db().prepare("SELECT id FROM parties WHERE group_id = ?").all(pid);
      for (const m of members) {
        const mAgency = currentAgencyId(m.id);
        const follows = Number(mAgency || 0) === Number(oldAgency || 0); // null==null(둘 다 없음)도 follows
        if (follows) setAgencyRaw(m.id, gid);
      }
    }
  } else {
    setAgencyRaw(pid, gid); // 개인 멤버 개별 소속사(오버라이드)
  }
}

/** 파티의 현재 소속사(company) id — 폼 select 기본값용. 없으면 null. */
function currentAgencyId(partyId) {
  const cur = currentAffiliation(partyId);
  return cur && cur.org_id ? cur.org_id : null;
}

/** 그룹 선택 콤보용 — 그룹(kind='group') 목록 {id, name, agency_id(현재 그룹 소속사)}. agency_id는 폼 연동(그룹 선택 시 소속사 자동 맞춤)용. */
function listGroupsForPicker() {
  return db().prepare(
    `SELECT p.id, COALESCE(NULLIF(p.activity_name,''), p.name) AS name,
       (SELECT a.org_id FROM affiliations a WHERE a.person_id = p.id AND a.ended_on IS NULL ORDER BY a.started_on DESC, a.id DESC LIMIT 1) AS agency_id
     FROM parties p WHERE p.kind = 'group' ORDER BY p.name COLLATE NOCASE`
  ).all();
}

/** 멤버 추가 콤보용 — 개인 아티스트(사람) 목록 {id, name, group_id}. 이미 이 그룹 소속이 아닌 사람만 후보로 쓰기 좋게 group_id 포함. */
function artistPersonOptions() {
  return db().prepare(
    `SELECT id, COALESCE(NULLIF(activity_name,''), name) AS name, group_id
       FROM parties WHERE kind = 'person' AND is_artist = 1 ORDER BY name COLLATE NOCASE`
  ).all();
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
  listTasksForWorker,
  setTaskPayout,
  listContacts,
  listAssociates,
  listClients,
  clientKindCounts,
  contactOptions,
  clientOptions,
  listArtistsForAgency,
  resolveCompanyByName,
  setPartyGroup,
  listGroupMembers,
  groupOfParty,
  listGroupsForPicker,
  artistPersonOptions,
  setPartyAgency,
  currentAgencyId,
};
