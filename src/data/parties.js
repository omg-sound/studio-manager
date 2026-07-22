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
const { splitKoreanName, honorificFromTitle } = require("../lib/korean-name");
const { todayYmd } = require("../lib/date");
const { formatPhone, formatBizNo } = require("../lib/format"); // 전화·사업자번호 하이픈 정규화(전 저장 경로 공통, lib으로 승격 — studio·db 백필과 공유)

const blankToNull = (v) => { const s = String(v == null ? "" : v).trim(); return s || null; };

/** 표시명(name) 자동 생성(사람): 명시 name > 호칭+성+이름 > 활동명. 모두 없으면 예외. */
// name(표시명) = **순수 본명**(성+이름). 호칭은 name에 넣지 않고 honorific 컬럼에만 둔다(2026-07-05 통일 —
// 이전엔 '성이름 호칭'으로 조립해 연락처 폼 생성분만 name에 호칭이 박히고 대표자 자동등록분은 컬럼에만 있어
// 목록 표시가 갈렸다. 표시는 personName 헬퍼가 honorific 컬럼으로 일관되게 붙인다).
function resolveDisplayName({ name, honorific, family_name, given_name, activity_name } = {}) {
  const explicit = String(name || "").trim();
  if (explicit) return explicit;
  const full = `${String(family_name || "").trim()}${String(given_name || "").trim()}`;
  if (full) return full;
  const act = String(activity_name || "").trim();
  if (act) return act;
  const h = String(honorific || "").trim();
  if (h) return h; // 이름·활동명이 전혀 없을 때만 호칭이라도(엣지 폴백)
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
       family_name, given_name, honorific, department, job_title, cash_receipt_no, activity_form)
     VALUES ('person', @name, @activity_name, @is_artist, @phone, @email, @memo,
       @family_name, @given_name, @honorific, @department, @job_title, @cash_receipt_no, @activity_form)`
  ).run({
    name,
    activity_name: blankToNull(b.activity_name),
    is_artist: b.is_artist || blankToNull(b.activity_name) ? 1 : 0,
    phone: formatPhone(b.phone), email: blankToNull(b.email), memo: blankToNull(b.memo),
    // 호칭 미지정이면 직책에서 파생('실장'→'실장님') — 대표자 자동 '대표님'과 같은 흐름(2026-07-10).
    family_name: fam, given_name: giv, honorific: blankToNull(b.honorific) || honorificFromTitle(b.job_title),
    department: blankToNull(b.department), job_title: blankToNull(b.job_title),
    cash_receipt_no: formatPhone(b.cash_receipt_no), // 전화형이면 하이픈 정규화(카드번호 등 형식 불명은 원본 보존)
    activity_form: blankToNull(b.activity_form), // 아티스트 활동 형태(solo|group|both) — 비아티스트는 null
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
    biz_no: formatBizNo(b.biz_no), owner_name: blankToNull(b.owner_name),
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
    cash_receipt_no: formatPhone(b.cash_receipt_no), // 전화형이면 하이픈 정규화(카드번호 등 형식 불명은 원본 보존)
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

/**
 * 당사자 수정. kind는 불변(정체성). person/company/group 각 필드 갱신.
 *
 * **부분 갱신 계약(2026-07-04 전면 적용)**: 호출부가 보낸 필드(`undefined` 아님)만 갱신하고,
 * 안 보낸 필드는 기존값 보존. 빈 문자열 전송 = 의도적 비움(null 저장).
 * — 근거: Google 동기화(personToContactFields)·유형별 폼처럼 **일부 필드만 다루는 호출부**가
 *   나머지 필드를 조용히 지우던 데이터 손실 클래스(현금영수증에서 실증)의 근본 차단.
 *   urlencoded 폼은 폼에 있는 input을 전부 전송하므로 "폼에 없는 필드=미전송=보존"이 정확히 성립.
 */
function updateParty(id, b = {}) {
  const cur = getParty(id);
  if (!cur) return;
  // 미전송(undefined)=기존 보존, 전송=정규화 후 갱신(빈 문자열→null=비움).
  const pick = (key, norm = blankToNull) => (b[key] !== undefined ? norm(b[key]) : (cur[key] != null ? cur[key] : null));
  if (cur.kind === "company") {
    const name = String(b.name || "").trim() || cur.name;
    const ownerPartyId = b.owner_party_id !== undefined ? (b.owner_party_id ? Number(b.owner_party_id) : null) : (cur.owner_party_id || null);
    db().prepare(
      `UPDATE parties SET name=?, phone=?, email=?, memo=?, biz_no=?, owner_name=?, owner_party_id=?, address=?, roles=? WHERE id=?`
    ).run(
      name, pick("phone", formatPhone), pick("email"), pick("memo"),
      pick("biz_no", formatBizNo), pick("owner_name"), ownerPartyId,
      pick("address"), pick("roles"), Number(id)
    );
    return;
  }
  // person / group — 활동명은 nickname 별칭(연락처 폼) 수용: 둘 다 미전송이면 보존.
  const activityName = b.activity_name !== undefined ? blankToNull(b.activity_name)
    : b.nickname !== undefined ? blankToNull(b.nickname)
    : (cur.activity_name || null);
  // 표시명(name) 재구성: 성/이름을 편집하면 반영되게 **성+이름(현재값 반영)을 옛 name보다 우선**한다.
  // (2026-07-18 버그: `name: b.name || cur.name`이라 성/이름을 고쳐도 resolveDisplayName이 옛 name을 그대로 반환 → 목록 미반영.)
  // 우선순위: 명시 name(폼엔 없음) > 성+이름 > 기존 name(레거시 단일필드·이름 없는 부분수정 보존) > 활동명/호칭(resolveDisplayName 폴백).
  const fullName = `${String(pick("family_name") || "").trim()}${String(pick("given_name") || "").trim()}`;
  const name = resolveDisplayName({ ...b, activity_name: activityName, name: String(b.name || "").trim() || fullName || cur.name });
  // 그룹은 '그룹명=단일 정체성'이 불변식(group_activity_name_sync_v1) — 이름을 고치면 활동명도 따라가게 데이터층에서 강제(라우트 누락 대비, 감사 L1). 솔로는 본명≠활동명이 정상이라 제외.
  const activityNameFinal = cur.kind === "group" ? name : activityName;
  const isArtist = b.is_artist != null ? (b.is_artist ? 1 : 0) : (activityNameFinal ? 1 : cur.is_artist);
  const contactPartyId = b.contact_party_id !== undefined ? (b.contact_party_id ? Number(b.contact_party_id) : null) : (cur.contact_party_id || null);
  const jobTitle = pick("job_title");
  // 호칭이 비어 있을 때만 직책에서 파생(기존 호칭 존중 — 대표자 '대표님' 자동 부여와 같은 규칙, 2026-07-10).
  const honorific = pick("honorific") || honorificFromTitle(jobTitle);
  db().prepare(
    `UPDATE parties SET name=?, activity_name=?, is_artist=?, phone=?, email=?, memo=?,
       family_name=?, given_name=?, honorific=?, department=?, job_title=?, cash_receipt_no=?, contact_party_id=?, activity_form=? WHERE id=?`
  ).run(
    name, activityNameFinal, isArtist,
    pick("phone", formatPhone), pick("email"), pick("memo"),
    pick("family_name"), pick("given_name"), honorific,
    pick("department"), jobTitle, pick("cash_receipt_no", formatPhone), contactPartyId, pick("activity_form"), Number(id)
  );
}

function deleteParty(id) {
  // 하드 삭제([[delete-only-management]]): affiliations CASCADE. 역할 참조(FK 없음)는 코드가 SET NULL 의미로 정리.
  const pid = Number(id);
  const d = db();
  // 첨부 실파일(사업자등록증 등)도 함께 회수 — 행만 CASCADE 삭제하면 Drive/로컬에 스캔본이 고아로 남음(2026-07-09 PII 수명주기 점검).
  // DB 삭제 전에 목록 확보 → 삭제 후 best-effort 제거(storage.remove는 fail-safe라 삭제 흐름 비차단, 지연 require=순환 방지).
  const orphanFiles = d.prepare("SELECT storage_backend, file_id FROM client_files WHERE client_id = ?").all(pid);
  if (orphanFiles.length) setImmediate(() => {
    const storage = require("../storage");
    for (const f of orphanFiles) Promise.resolve(storage.remove(f.storage_backend, f.file_id)).catch((e) => console.warn("[deleteParty] 첨부 삭제 실패(고아 파일 잔존):", f.storage_backend, f.file_id, e && e.message));
  });
  // 역할 참조 정리 + 삭제를 한 트랜잭션으로 — 중간 실패 시 참조가 반쪽만 SET NULL/삭제된 채 남지 않게(감사 L3).
  d.exec("BEGIN IMMEDIATE;");
  try {
    d.prepare("UPDATE invoices SET payer_id = NULL WHERE payer_id = ?").run(pid);
    d.prepare("UPDATE projects SET artist_id = NULL WHERE artist_id = ?").run(pid);
    d.prepare("UPDATE projects SET agency_id = NULL WHERE agency_id = ?").run(pid);
    d.prepare("UPDATE projects SET production_id = NULL WHERE production_id = ?").run(pid);
    d.prepare("UPDATE projects SET contact_party_id = NULL WHERE contact_party_id = ?").run(pid);
    d.prepare("UPDATE project_managers SET party_id = NULL WHERE party_id = ?").run(pid);
    d.prepare("UPDATE sessions SET director_party_id = NULL WHERE director_party_id = ?").run(pid);
    d.prepare("DELETE FROM session_directors WHERE party_id = ?").run(pid);
    d.prepare("DELETE FROM project_artists WHERE party_id = ?").run(pid); // 다대다 아티스트 연결 해제(FK CASCADE 대비 명시)
    d.prepare("DELETE FROM project_contacts WHERE party_id = ?").run(pid); // 다대다 고객측 담당자 연결 해제(project_artists와 일관 — 감사 L3, FK CASCADE 있지만 명시)
    // 이 사람이 대표인 회사들 — 삭제 후 남은 대표로 레거시 컬럼(첫 대표 id·콤마 이름)을 재동기화(공동대표 승계).
    const ownedCompanies = d.prepare("SELECT company_id FROM company_owners WHERE party_id = ?").all(pid).map((r) => r.company_id);
    d.prepare("DELETE FROM company_owners WHERE party_id = ? OR company_id = ?").run(pid, pid);
    d.prepare("UPDATE parties SET owner_party_id = NULL WHERE owner_party_id = ?").run(pid);
    d.prepare("UPDATE parties SET group_id = NULL WHERE group_id = ?").run(pid); // 그룹 삭제 시 멤버 소속 해제
    d.prepare("UPDATE parties SET contact_party_id = NULL WHERE contact_party_id = ?").run(pid); // 그룹 담당자로 지정된 사람 삭제 시 댕글링 참조 방지(감사 M1)
    d.prepare("DELETE FROM parties WHERE id = ?").run(pid);
    for (const cid of ownedCompanies) syncCompanyOwnerColumns(cid);
    d.exec("COMMIT;");
  } catch (e) {
    d.exec("ROLLBACK;");
    throw e;
  }
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

/** 소속 추가. org_id(=client_id 별칭). closeCurrent(기본 true)면 기존 현재 소속을 종료 후 새 소속 INSERT(이직).
 *  is_contact=1이면 이 조직의 담당자로도 지정(기본 0 — 단순 재직. 담당자 지정은 setOrgContacts 경로에서만). */
function addAffiliation(personId, { org_id, client_id, title, started_on, memo, closeCurrent = true, is_contact = 0 } = {}) {
  if (org_id == null) org_id = client_id; // client_id 별칭(레거시 호출 호환)
  const pid = Number(personId);
  const start = blankToNull(started_on);
  if (closeCurrent) {
    db().prepare("UPDATE affiliations SET ended_on = ? WHERE person_id = ? AND ended_on IS NULL").run(start || todayYmd(), pid);
  }
  return db().prepare(
    "INSERT INTO affiliations (person_id, org_id, title, started_on, memo, is_contact) VALUES (?, ?, ?, ?, ?, ?)"
  ).run(pid, org_id ? Number(org_id) : null, blankToNull(title), start, blankToNull(memo), is_contact ? 1 : 0).lastInsertRowid;
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
  // 정규화 매칭(공백·대소문자 무시)으로 회사 재사용 — raw 정확일치는 "뮤직팜"≠"뮤직 팜"으로 중복 업체를 만든다(감사 M2, '뮤직팜 3중 등록' 버그 클래스).
  const orgId = ensureCompanyParty(n, "소속사/레이블");
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
  // 공동대표(company_owners) 기준 — 레거시 owner_party_id(첫 대표)만 보면 둘째 대표가 누락된다(2026-07-10).
  return db().prepare(
    `SELECT p.id, p.name, p.kind FROM parties p
      WHERE p.id IN (SELECT company_id FROM company_owners WHERE party_id = @pid)
         OR p.owner_party_id = @pid
      ORDER BY p.name`
  ).all({ pid: Number(personId) });
}

/**
 * 당사자가 관여한 프로젝트(아티스트/소속사/제작사/담당자/**세션 디렉터**).
 * 세션 디렉터 포함(2026-07-17 사용자 리포트 '세션에 참여했으면 프로젝트에도 연관된 것'):
 * 이전엔 프로젝트 단 역할만 봐서, 그 프로젝트의 고객측 담당자로는 등록 안 됐고 세션 디렉터로만 참여한 사람이
 * 연락처 상세에서 '세션 1 · 프로젝트 0'으로 보였다. 관계자 탭(ASSOCIATE_ROLE_SUBQUERY)도 세션 디렉터를 역할로 인정한다.
 * 레거시 단일 컬럼(sessions.director_party_id)과 다대다(session_directors) 둘 다 매칭.
 */
function listProjectsForParty(partyId) {
  const id = Number(partyId);
  return db().prepare(
    `SELECT DISTINCT p.* FROM projects p
      WHERE p.artist_id = @id OR p.agency_id = @id OR p.production_id = @id OR p.contact_party_id = @id
         OR p.id IN (SELECT project_id FROM project_artists WHERE party_id = @id)
         OR p.id IN (SELECT project_id FROM project_contacts WHERE party_id = @id)
         OR p.id IN (
              SELECT s.project_id FROM sessions s
               WHERE s.director_party_id = @id
                  OR EXISTS (SELECT 1 FROM session_directors sd WHERE sd.session_id = s.id AND sd.party_id = @id)
            )
      ORDER BY p.created_at DESC, p.id DESC`
  ).all({ id });
}

/**
 * 이 당사자가 **발행/진행된 청구의 청구처**인가 — 삭제하면 재무 추적이 끊기므로 삭제를 거부할 판정.
 *
 * `deleteParty`는 `invoices.payer_id`를 NULL로 만든다(역할 참조 정리). 그러면 그 사람 기준 미수
 * 추적(`listInvoicesForParty`)이 0건이 되고, `payer_kind` 소실로 현금영수증 건이 '계산서'로 오표시된다.
 * 그래서 발행됐거나(status) 계산서·입금이 진행된(tax_status) 청구가 있으면 청구처를 보존한다.
 *
 * ⚠️ **삭제 경로 세 곳이 이 하나를 공유해야 한다** — `/clients` 삭제(원래 여기에만 인라인 가드가 있었다),
 * `/contacts` 삭제, 구글→앱 pull(`people.js` meta.deleted). 판정이 갈리면 어느 문으로 들어오느냐에 따라
 * 같은 사람이 지워지거나 보존되는 비대칭이 생긴다(2026-07-23 기능성 평가). 회귀 `test/party-delete-guard.test.js`.
 */
function partyHasIssuedInvoice(partyId) {
  return !!db()
    .prepare("SELECT 1 FROM invoices WHERE payer_id = ? AND (status = '발행' OR tax_status IN ('계산서 발행', '입금완료')) LIMIT 1")
    .get(Number(partyId));
}

/** 당사자가 청구처(payer)인 인보이스 전체. */
function listInvoicesForParty(partyId) {
  // payer_kind 조인(2026-07-09 감사): 미제공 시 taxDocOf가 항상 '계산서'로 판정해 개인(아티스트) 청구처
  // 배지가 '현금영수증' 대신 '계산서'로 잘못 표시되던 것 — listInvoices와 동일하게 청구처 kind 반환.
  return db().prepare(
    `SELECT i.*, p.title AS project_title, c.kind AS payer_kind FROM invoices i
       LEFT JOIN projects p ON p.id = i.project_id
       LEFT JOIN parties c ON c.id = i.payer_id
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
    `SELECT p.id, p.name, p.activity_name, p.honorific, p.kind, p.is_artist,
            (SELECT o.name FROM affiliations a LEFT JOIN parties o ON o.id = a.org_id
              WHERE a.person_id = p.id AND a.ended_on IS NULL ORDER BY a.started_on DESC, a.id DESC LIMIT 1) AS company
       FROM parties p` + (where.length ? " WHERE " + where.join(" AND ") : "") + " ORDER BY p.name COLLATE NOCASE";
  return db().prepare(sql).all().map((p) => ({
    id: p.id, name: p.name, activity_name: p.activity_name, honorific: p.honorific || "", kind: p.kind, is_artist: p.is_artist,
    company: p.company || "", // 현재 소속사(affiliation) — 아티스트 선택 시 소속사 필드 자동 채움용
    sub: p.kind === "company" ? "조직" : p.kind === "group" ? "그룹" : (p.is_artist ? "아티스트" : (p.company || "사람")),
  }));
}

// ── 역할 배지 ──

/**
 * 당사자 역할 배지 — 조직/그룹/아티스트/스태프/외주/담당자/디렉터/대표.
 * @param party  party 객체(권장 — 목록 렌더 시 행마다 재조회 방지) 또는 party id.
 * @param preAff (선택) 이미 계산한 현재 소속(`currentAffiliation` 결과) — 목록에서 재사용해 행당 조회 1건 절약.
 *               넘기지 않으면 내부에서 조회. null(무소속)도 유효한 전달값이라 `arguments.length`로 구분.
 */
function classifyParty(party, preAff) {
  const hasPreAff = arguments.length > 1;
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
      const a = hasPreAff ? preAff : currentAffiliation(id);
      if (a && a.org_id) badges.push({ label: "고객측 담당자", cls: "badge-success" });
    }
  }
  const director = db().prepare(
    "SELECT 1 FROM sessions WHERE director_party_id = @id UNION SELECT 1 FROM session_directors WHERE party_id = @id LIMIT 1"
  ).get({ id });
  if (director) badges.push({ label: "디렉터", cls: "badge-warning" });
  // 개인이 프로젝트 제작/운영 주체로 참조(2026-07-05 — 제작/운영에 개인 허용). 회사는 '조직' 배지로 충분해 사람만.
  if (p.kind === "person" && db().prepare("SELECT 1 FROM projects WHERE production_id = ? LIMIT 1").get(id)) {
    badges.push({ label: "제작/운영", cls: "badge-success" });
  }
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
/** 표시 라벨 "본명 호칭 (활동명)" 파싱 — {base, activity}. 괄호 없으면 activity="". */
function parseDisplayLabel(text) {
  const t = String(text || "").trim();
  const m = t.match(/^(.+?)\s*\((.+)\)$/);
  return m ? { base: m[1].trim(), activity: m[2].trim() } : { base: t, activity: "" };
}

/** 사람 유일 매칭(0 또는 2+면 null) — 동명이인 임의 병합 방지(resolveContactForArtist와 동일 보수 정책). */
function uniquePersonWhere(clause, args) {
  const rows = db().prepare(`SELECT id FROM parties WHERE kind = 'person' AND ${clause}`).all(...args);
  return rows.length === 1 ? rows[0].id : null;
}

function resolvePersonByName(name, { createIfMissing = true } = {}) {
  const n = String(name || "").trim();
  if (!n) return null;
  const rows = db().prepare("SELECT id FROM parties WHERE kind = 'person' AND name = ?").all(n);
  if (rows.length === 1) return rows[0].id;
  // 표시 라벨 안전망(2026-07-05 전수점검): 콤보를 안 거치고 라벨 텍스트("박수한 대표님 (워터멜론)"·"박수한 대표님"·"워터멜론")가
  // 그대로 제출돼도 기존 사람을 찾는다 — 라벨 그대로인 유령 연락처 생성 방지. 전부 유일 매칭만(동명이인 보수).
  if (rows.length === 0) {
    const byHon = uniquePersonWhere("TRIM(name || ' ' || COALESCE(honorific,'')) = ?", [n]); // "본명 호칭"
    if (byHon) return byHon;
    const { base, activity } = parseDisplayLabel(n);
    if (activity) {
      const byLabel = uniquePersonWhere(
        "(name = @b OR TRIM(name || ' ' || COALESCE(honorific,'')) = @b) AND activity_name = @a",
        [{ b: base, a: activity }]
      ); // "본명[ 호칭] (활동명)"
      if (byLabel) return byLabel;
    }
    const byActivity = uniquePersonWhere("activity_name = ? AND TRIM(COALESCE(activity_name,'')) <> ''", [n]); // 활동명 단독
    if (byActivity) return byActivity;
    if (createIfMissing && activity) return createPerson({ name: base, nickname: activity }); // 라벨 형식 신규 = 본명+활동명으로 분해 저장
  }
  if (!createIfMissing) return null;
  return createPerson({ name: n });
}

/**
 * 표시 텍스트 → 기존 party 해석(생성 없음): ①회사 상호 정확 ②사람 본명/라벨/활동명(유일) 순.
 * 프로젝트 제작/운영처럼 회사·개인이 함께 들어가는 칸의 서버 안전망 — 콤보 미선택(hidden id 없음)으로
 * 사람 라벨 텍스트가 오면 회사로 오생성하지 않고 그 사람을 재사용. 못 찾으면 null(호출부가 회사 생성 등 후속).
 */
function resolvePartyByDisplay(text) {
  const n = String(text || "").trim();
  if (!n) return null;
  const co = resolveCompanyByName(n);
  if (co) return co;
  return resolvePersonByName(n, { createIfMissing: false });
}

/**
 * 대표자(회사 owner) → 사람 party 해석 + 호칭 '대표님' 세팅. 이름 기반 재사용/생성(resolvePersonByName와 동일 매칭 → 중복 없음).
 * 호칭이 비어 있을 때만 '대표님'을 넣는다(기존 호칭 존중). 이름 필드는 그대로(재조회 매칭 유지).
 */
function resolveOwnerParty(name, ownerId) {
  // 대표자 콤보에서 선택/등록한 사람 id 우선(정확 연결·동명이인 오연결 방지), 없으면 이름 기반 재사용/생성.
  const id = ownerId ? Number(ownerId) : (String(name || "").trim() ? resolvePersonByName(name) : null);
  if (id) {
    const p = db().prepare("SELECT honorific FROM parties WHERE id = ? AND kind = 'person'").get(id);
    if (p && !String(p.honorific || "").trim()) db().prepare("UPDATE parties SET honorific = '대표님' WHERE id = ?").run(id);
  }
  return id;
}

/**
 * 대표자(owner)의 직장(소속)을 그 회사로 설정 — 현재 소속이 이 회사가 아니면 이직(closeCurrent)으로 등록(직함 '대표').
 * 이미 이 회사가 현재 소속이면 no-op. 업체 등록/수정 시 대표자↔회사 소속 자동 연결용.
 */
function ensureOwnerAffiliation(ownerId, companyId) {
  if (!ownerId || !companyId) return;
  const cur = currentAffiliation(ownerId);
  if (!cur || Number(cur.org_id) !== Number(companyId)) addAffiliation(ownerId, { org_id: companyId, title: "대표", closeCurrent: true });
}

/** 이 회사의 대표자(공동대표 포함, 등록 순서). company_owners가 진실원천. */
function listCompanyOwners(companyId) {
  return db().prepare(
    `SELECT p.* FROM company_owners co JOIN parties p ON p.id = co.party_id
      WHERE co.company_id = ? ORDER BY co.sort_order, co.rowid`
  ).all(Number(companyId)).map(withLegacy);
}

/**
 * 이 회사의 대표자 목록을 통째로 교체(공동대표 여러 명 — 2026-07-10 사용자 요청 '대표자가 2명인 경우도 있다').
 * 각 대표에게 '대표님' 호칭(비어 있을 때만)·이 회사 소속(직함 '대표')을 부여하고,
 * 레거시 `parties.owner_party_id`(첫 대표)·`owner_name`(콤마 목록 — 청구처 카드 '성명(대표자)'·거래명세서 스냅샷)을 동기화.
 * 대표에서 빠진 사람은 대표 역할만 해제 — 연락처·재직(소속)은 그대로(담당자 해제와 같은 규칙).
 */
function setCompanyOwners(companyId, personIds) {
  const cid = Number(companyId);
  if (!cid) return;
  const ids = [];
  for (const raw of personIds || []) { const pid = Number(raw); if (pid && !ids.includes(pid)) ids.push(pid); }
  const d = db();
  d.prepare("DELETE FROM company_owners WHERE company_id = ?").run(cid);
  const ins = d.prepare("INSERT OR IGNORE INTO company_owners (company_id, party_id, sort_order) VALUES (?, ?, ?)");
  ids.forEach((pid, i) => {
    ins.run(cid, pid, i);
    const p = d.prepare("SELECT honorific FROM parties WHERE id = ? AND kind = 'person'").get(pid);
    if (p && !String(p.honorific || "").trim()) d.prepare("UPDATE parties SET honorific = '대표님' WHERE id = ?").run(pid);
    ensureOwnerAffiliation(pid, cid);
  });
  syncCompanyOwnerColumns(cid);
}

/** 레거시 컬럼(첫 대표 id·콤마 이름) 재동기화 — company_owners 변경 후 항상 호출. */
function syncCompanyOwnerColumns(companyId) {
  const owners = listCompanyOwners(companyId);
  db().prepare("UPDATE parties SET owner_party_id = ?, owner_name = ? WHERE id = ?")
    .run(owners[0] ? owners[0].id : null, owners.length ? owners.map((o) => o.name).join(", ") : null, Number(companyId));
}

/** 이 조직의 담당자(is_contact=1인 현재 소속). 재직 전원(listPersonsForOrg)과 구별 — 담당자는 그중 지정된 사람만. */
function listOrgContacts(orgId) {
  return db().prepare(
    `SELECT p.*, a.title AS aff_title FROM affiliations a
       JOIN parties p ON p.id = a.person_id
      WHERE a.org_id = ? AND a.ended_on IS NULL AND a.is_contact = 1
      ORDER BY p.name COLLATE NOCASE`
  ).all(Number(orgId));
}

/**
 * 이 조직의 담당자 목록을 통째로 교체(클라이언트 폼 '담당자 연락처' 콤마 다중 — 세션 디렉터와 같은 UX).
 * **담당자는 재직과 별개 역할**(2026-07-10 사용자 결정): 칸에서 빼면 `is_contact=0`으로 담당자 지정만 풀리고
 * 재직(ended_on)은 그대로 둔다 — 담당자 해제가 퇴사 처리가 되면 안 되기 때문(연락처의 소속 이력은 그 화면에서 관리).
 * 담당자로 새로 지정한 사람은 이 조직 소속이 없으면 재직도 함께 등록(다른 소속은 끊지 않음).
 */
function setOrgContacts(orgId, personIds) {
  const org = Number(orgId);
  if (!org) return;
  const keep = new Set((personIds || []).map(Number).filter(Boolean));
  const current = new Set(listPersonsForOrg(org).map((p) => Number(p.id))); // 재직 전원(담당자 여부 무관)
  for (const pid of keep) if (!current.has(pid)) addAffiliation(pid, { org_id: org, closeCurrent: false, is_contact: 1 });
  const mark = db().prepare("UPDATE affiliations SET is_contact = ? WHERE person_id = ? AND org_id = ? AND ended_on IS NULL");
  for (const pid of keep) if (current.has(pid)) mark.run(1, pid, org);
  for (const pid of current) if (!keep.has(pid)) mark.run(0, pid, org); // 담당자 해제 — 재직은 유지
}

/** 프로젝트 저장 시 아티스트/소속사/제작사를 party로 보장(이름 기반). 반환 없음(프로젝트가 party_id로 저장). */
function listProjectManagers({ includeInactive = false, externalOnly = false } = {}) {
  const where = [];
  if (!includeInactive) where.push("active = 1");
  if (externalOnly) where.push("user_id IS NULL");
  // 정렬: 활성 우선 → 하우스 엔지니어(user_id 있음) 먼저·외주(user_id 없음) 나중 → 그룹 내 가나다순
  // (2026-07-06 사용자 요청 — 이전엔 하우스·외주 구분 없이 전체 가나다순이라 보기 불편했음).
  return db().prepare(
    `SELECT * FROM project_managers ${where.length ? "WHERE " + where.join(" AND ") : ""} ORDER BY active DESC, (user_id IS NULL) ASC, name COLLATE NOCASE`
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
      `SELECT t.*, tr.title AS track_title, COALESCE(NULLIF(tr.artist, ''), p.artist) AS track_artist, p.id AS project_id, p.title AS project_title
       FROM track_tasks t
       JOIN project_tracks tr ON tr.id = t.track_id
       JOIN projects p ON p.id = tr.project_id
       WHERE t.engineer_id = @id OR (t.engineer_id IS NULL AND t.engineer_name = @name)
       ORDER BY t.created_at DESC, t.id DESC`
    )
    .all({ id: worker.id, name: worker.name });
}

/**
 * 외주 작업자가 담당한 세션 — 참여 내역(2026-07-06 사용자 리포트: 작업 참여는 뜨는데 세션 참여가 안 뜸).
 * 매칭: 다대다 session_engineers(manager_id) 우선 + 레거시 engineer_name 폴백(DISTINCT로 중복 제거).
 * 세션은 worker_rate/정산 개념이 없어(스튜디오 자체 예약) 참고용 목록으로만 노출, 지급 처리 대상 아님.
 */
function listSessionsForWorker(worker) {
  if (!worker) return [];
  // my_assigned·my_rate(2026-07-09 점검): 본인 배정 여부와 지급단가 — 외주가 배정됐는데 단가 0이면
  // 정산 목록(listSessionPayoutsForWorker는 배정분 전체를 반환하나 단가 0이면 지급할 금액이 없음)에서
  // 조용히 누락되므로 참여 내역에서 '지급단가 미입력' 경고를 띄우기 위한 필드.
  return db()
    .prepare(
      `SELECT DISTINCT s.*, p.id AS project_id, p.title AS project_title,
              (se.manager_id IS NOT NULL) AS my_assigned, COALESCE(se.worker_rate, 0) AS my_rate
       FROM sessions s
       JOIN projects p ON p.id = s.project_id
       LEFT JOIN session_engineers se ON se.session_id = s.id AND se.manager_id = @id
       WHERE se.manager_id IS NOT NULL
          OR s.engineer_name = @name
       ORDER BY s.session_date DESC, s.id DESC`
    )
    .all({ id: worker.id, name: worker.name });
}

/** 외주 작업 지급 처리/해제(정산). paidOn(YYYY-MM-DD)을 주면 그 날짜로 소급 기록(일괄 지급의 실제 이체일, 2026-07-09). */
function setTaskPayout(taskId, paid, paidOn) {
  const p = paid ? 1 : 0;
  db().prepare("UPDATE track_tasks SET worker_paid = ?, worker_paid_date = ? WHERE id = ?").run(p, p ? (paidOn || todayYmd()) : null, Number(taskId));
}

// ── UI 편의 조회(연락처=사람 뷰, 클라이언트=업체·아티스트 뷰) ──

/**
 * 사람(person) 목록 — 연락처 메뉴. tab = 역할 **필터**(상호배타 아님, 2026-07-17 사람/조직 축 정리):
 *  - all(기본·모르는 값 폴백) = 사람 전부(외주·스태프 포함)
 *  - artist    = is_artist(아티스트 역할)
 *  - associate = 관계자(비스태프·비외주 + [비아티스트 or 관계자 역할 참조]) — listAssociates와 같은 규칙
 *  - worker    = 외주 작업자 / staff = 로그인 스태프
 * 아티스트이면서 디렉터인 사람은 artist·associate 양쪽에 나온다(겸업 — 설계 의도).
 * 레거시 `staff:true/false`·`tab:"external"`은 폴백으로 흡수(external = 전체로 취급).
 */
// 한글 우선 이름 정렬(iCloud식, 2026-07-18 사용자 요청) — 한글 음절(가~힣)·호환 자모(ㄱ~ㆎ) 먼저, 그 다음 영문·숫자·기호.
// unicode(col)=이름 첫 글자의 코드포인트. 한글이면 rank 0, 아니면 1로 묶고 각 묶음 안은 이름순(한글=가나다).
function hangulFirstOrder(col) {
  return `(CASE WHEN unicode(${col}) BETWEEN 44032 AND 55203 OR unicode(${col}) BETWEEN 12593 AND 12686 THEN 0 ELSE 1 END), ${col} COLLATE NOCASE`;
}

function listContacts({ q, tab, staff } = {}) {
  if (staff === true) tab = "staff";
  const where = ["p.kind = 'person'"];
  const args = [];
  const term = String(q || "").trim();
  if (term) { where.push("(p.name LIKE ? OR p.activity_name LIKE ? OR p.phone LIKE ?)"); args.push(`%${term}%`, `%${term}%`, `%${term}%`); }
  const workerSub = "p.id IN (SELECT party_id FROM project_managers WHERE user_id IS NULL AND party_id IS NOT NULL)";
  if (tab === "staff") where.push("p.user_id IS NOT NULL");
  else if (tab === "worker") where.push("p.user_id IS NULL AND " + workerSub);
  else if (tab === "artist") where.push("p.is_artist = 1");
  else if (tab === "associate") {
    where.push("p.user_id IS NULL", "NOT (" + workerSub + ")", `(p.is_artist = 0 OR p.id IN (${ASSOCIATE_ROLE_SUBQUERY}))`);
  }
  const sql = "SELECT p.* FROM parties p WHERE " + where.join(" AND ") + " ORDER BY " + hangulFirstOrder("p.name");
  return db().prepare(sql).all(...args).map(withLegacy);
}

/**
 * 관계자(클라이언트 측 '사람'): 대표·A&R·담당자·디렉터·작가 등.
 * person·비스태프(user_id null)·비외주. 클라이언트 '관계자' 탭. 상세는 연락처(/contacts/:id).
 *
 * **is_artist=0(순수 관계자) 또는 관계자 역할로 참조된 사람**을 노출한다(2026-07-05 사용자 요청):
 * 관계자에게 아티스트 활동명을 넣으면 `updateParty`가 is_artist=1로 바꿔 관계자 탭에서 사라지던 문제 해결.
 * '아티스트 겸 관계자'(예: 김정환 — 디렉터인데 활동명도 있음)를 두 탭 모두에 노출.
 * 관계자 역할 = 프로젝트 고객측 담당자(projects.contact_party_id·project_contacts 다대다)·세션 디렉터(session_directors.party_id)·
 * 회사 대표(parties.owner_party_id)·그룹 담당자(parties.contact_party_id). 순수 솔로 아티스트(역할 없음)는
 * 관계자 탭에 안 나온다(아티스트 탭 전용) — 관계자 목록이 아티스트로 오염되는 것 방지.
 */
const ASSOCIATE_ROLE_SUBQUERY = `SELECT contact_party_id AS pid FROM projects WHERE contact_party_id IS NOT NULL
        UNION SELECT party_id FROM project_contacts
        UNION SELECT production_id FROM projects WHERE production_id IS NOT NULL
        UNION SELECT party_id FROM session_directors WHERE party_id IS NOT NULL
        UNION SELECT owner_party_id FROM parties WHERE owner_party_id IS NOT NULL
        UNION SELECT party_id FROM company_owners
        UNION SELECT contact_party_id FROM parties WHERE contact_party_id IS NOT NULL`;
function listAssociates({ q } = {}) {
  const where = [
    "p.kind = 'person'", "p.user_id IS NULL",
    "p.id NOT IN (SELECT party_id FROM project_managers WHERE user_id IS NULL AND party_id IS NOT NULL)",
    `(p.is_artist = 0 OR p.id IN (${ASSOCIATE_ROLE_SUBQUERY}))`,
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
  return db().prepare("SELECT * FROM parties WHERE kind IN ('company','group') OR is_artist = 1 ORDER BY " + hangulFirstOrder("name")).all().map(withLegacy);
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
      `SELECT p.id, p.name, p.activity_name, p.honorific, p.phone, p.email,
              (SELECT o.name FROM affiliations a LEFT JOIN parties o ON o.id = a.org_id
                WHERE a.person_id = p.id AND a.ended_on IS NULL ORDER BY a.started_on DESC, a.id DESC LIMIT 1) AS current_client,
              (SELECT a.title FROM affiliations a
                WHERE a.person_id = p.id AND a.ended_on IS NULL ORDER BY a.started_on DESC, a.id DESC LIMIT 1) AS current_title,
              (SELECT g.name FROM parties g WHERE g.id = p.group_id AND g.kind = 'group') AS group_name
         FROM parties p WHERE p.kind = 'person' ORDER BY p.name COLLATE NOCASE`
    )
    .all();
}

/** 콤보 옵션: 청구처(전체 당사자) — {id, name(아티스트=활동명), kind}. */
function clientOptions() {
  return db()
    .prepare(
      `SELECT p.id, COALESCE(NULLIF(p.activity_name,''), p.name) AS name, p.name AS real_name, p.activity_name, p.kind,
              (SELECT g.name FROM parties g WHERE g.id = p.group_id AND g.kind = 'group') AS group_name,
              (SELECT o.name FROM affiliations a LEFT JOIN parties o ON o.id = a.org_id
                WHERE a.person_id = p.id AND a.ended_on IS NULL ORDER BY a.started_on DESC, a.id DESC LIMIT 1) AS current_client
         FROM parties p WHERE p.kind IN ('company','group') OR p.is_artist = 1 ORDER BY name COLLATE NOCASE`
    )
    .all();
}

/** 업체(조직) 소속 아티스트 — affiliations 기반. real_name=본명(표시 병기용: 활동명 (본명)). */
function listArtistsForAgency(orgId) {
  return db()
    .prepare(
      `SELECT p.id, COALESCE(NULLIF(p.activity_name,''), p.name) AS name, p.name AS real_name FROM affiliations a
         JOIN parties p ON p.id = a.person_id
        WHERE a.org_id = ? AND a.ended_on IS NULL AND p.is_artist = 1 ORDER BY p.name`
    )
    .all(Number(orgId));
}

/**
 * 이름으로 조직 찾기(자동 생성 안 함).
 * 공백·대소문자 차이는 같은 회사로 본다("뮤직팜 " = "뮤직 팜" = "뮤직팜") — 콤보에서 띄어쓰기만 다르게 쳐도
 * 새 업체가 하나 더 생기던 중복 경로 차단(2026-07-14 뮤직팜 3중 등록 점검).
 */
function normalizeCompanyName(name) {
  return String(name || "").replace(/\s+/g, "").toLowerCase();
}
function resolveCompanyByName(name) {
  const key = normalizeCompanyName(name);
  if (!key) return null;
  // 매칭은 JS 정규화 하나로 일원화(2026-07-15 점검) — 이전의 SQL REPLACE 체인은 JS(\s+ 전체·유니코드 소문자)보다
  // 좁아서(전각 공백 U+3000·NBSP·CR 미제거, SQLite LOWER는 ASCII 전용) 그런 문자가 든 저장 이름은 자기 자신과도
  // 매칭이 안 돼 중복 방지가 조용히 실패했다. 업체 수는 수십 개라 전량 로드 비교로 충분하다.
  const rows = db().prepare("SELECT id, name FROM parties WHERE kind = 'company' ORDER BY id").all();
  const hit = rows.find((r) => normalizeCompanyName(r.name) === key);
  return hit ? hit.id : null;
}

/** 회사명 → 업체 party id(있으면 재사용, 없으면 생성). 빈 이름=null. companyCombo(이름 제출) 저장 경로 공용. */
function ensureCompanyParty(name, role) {
  const n = String(name || "").trim();
  if (!n) return null;
  return resolveCompanyByName(n) || createCompany({ name: n, roles: role || null });
}

/**
 * 회사 party의 역할(roles CSV)에 role을 추가 — 이미 있으면 no-op, 회사가 아니면 무시(사람은 roles 개념 없음).
 * 프로젝트에서 소속사·제작사로 지정된 기존 회사의 클라이언트 역할에도 그 역할을 반영하기 위함(2026-07-10 사용자 요청 —
 * 예: 소속사로 등록된 회사를 프로젝트 제작/운영 필드에 넣으면 그 회사도 '제작/운영' 역할을 갖게).
 */
function addCompanyRole(partyId, role) {
  const pid = Number(partyId);
  const r = String(role || "").trim();
  if (!pid || !r) return;
  const p = db().prepare("SELECT kind, roles FROM parties WHERE id = ?").get(pid);
  if (!p || p.kind !== "company") return; // 사람(개인 제작자)은 production_id 참조로 classifyParty가 배지 파생 — roles 미사용
  const roles = String(p.roles || "").split(",").map((s) => s.trim()).filter(Boolean);
  if (roles.includes(r)) return; // 멱등
  roles.push(r);
  db().prepare("UPDATE parties SET roles = ? WHERE id = ?").run(roles.join(","), pid);
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

/** 현재 소속사 이름(companyCombo 초기값). 없으면 "". */
function currentAgencyName(partyId) {
  const id = currentAgencyId(partyId);
  if (!id) return "";
  const p = getParty(id);
  return p ? p.name : "";
}

/** 그룹 선택 콤보용 — 그룹(kind='group') 목록 {id, name, agency_id(현재 그룹 소속사)}. agency_id는 폼 연동(그룹 선택 시 소속사 자동 맞춤)용. */
function listGroupsForPicker() {
  return db().prepare(
    `SELECT p.id, COALESCE(NULLIF(p.activity_name,''), p.name) AS name,
       (SELECT a.org_id FROM affiliations a WHERE a.person_id = p.id AND a.ended_on IS NULL ORDER BY a.started_on DESC, a.id DESC LIMIT 1) AS agency_id,
       (SELECT o.name FROM affiliations a JOIN parties o ON o.id = a.org_id WHERE a.person_id = p.id AND a.ended_on IS NULL ORDER BY a.started_on DESC, a.id DESC LIMIT 1) AS agency_name
     FROM parties p WHERE p.kind = 'group' ORDER BY p.name COLLATE NOCASE`
  ).all();
}

/** 멤버 추가 콤보용 — 개인 아티스트(사람) 목록 {id, name(활동명 우선), alt(본명 — 검색·병기), group_id}. 이미 이 그룹 소속이 아닌 사람만 후보로 쓰기 좋게 group_id 포함. */
function artistPersonOptions() {
  return db().prepare(
    `SELECT id, COALESCE(NULLIF(activity_name,''), name) AS name, name AS alt, group_id
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
  partyHasIssuedInvoice,
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
  resolvePartyByDisplay,
  resolveOwnerParty,
  ensureOwnerAffiliation,
  setOrgContacts,
  listOrgContacts,
  setCompanyOwners,
  listCompanyOwners,
  listProjectManagers,
  getWorker,
  listTasksForWorker,
  listSessionsForWorker,
  setTaskPayout,
  listContacts,
  listAssociates,
  listClients,
  clientKindCounts,
  contactOptions,
  clientOptions,
  listArtistsForAgency,
  resolveCompanyByName,
  ensureCompanyParty,
  addCompanyRole,
  currentAgencyName,
  setPartyGroup,
  listGroupMembers,
  groupOfParty,
  listGroupsForPicker,
  artistPersonOptions,
  setPartyAgency,
  currentAgencyId,
};
