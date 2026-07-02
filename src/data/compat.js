"use strict";

/**
 * 레거시 호환 어댑터(당사자 모델 이관 P2/P3용) — 라우트가 쓰던 clients/contacts 이름을 parties 함수로 매핑.
 * 목적: 라우트 대규모 재작성 없이 백엔드를 parties로 컷오버. **P4에서 통째로 삭제**(라우트가 party API를 직접 쓰게 되면).
 * data.js에서 **마지막에 spread**해 동일 이름을 덮어쓴다(파티 함수 우선순위 위).
 *
 * 순수 어댑터: parties 모듈 + db만 사용. 제거된 개념(아티스트 셸·'기타'·source_contact_id·본명 콤보)은
 * 여기서 흉내내지 않고 해당 라우트를 직접 수정한다.
 */

const { db } = require("../db");
const P = require("./parties");

// ── 직접 별칭(shape 동일) ──
const getContact = P.getParty;
const getClient = P.getParty;
// 연락처 폼은 활동명을 'nickname' 필드로 보냄 → party activity_name으로 매핑(아티스트 플래그 자동).
const createContact = (b = {}) => P.createPerson({ ...b, activity_name: b.activity_name || b.nickname });
const updateContact = (id, b = {}) => P.updateParty(id, { ...b, activity_name: b.activity_name || b.nickname });
const deleteContact = P.deleteParty;
const deleteClientEntity = P.deleteParty;
const setContactGoogleRef = P.setPartyGoogleRef;
const getContactByResourceName = P.getPartyByResourceName;
const listProjectsForContact = P.listProjectsForParty;
const listProjectsForClient = P.listProjectsForParty;
const listSessionsForContact = P.listSessionsForParty;
const listInvoicesForClientEntity = P.listInvoicesForParty;
const listContactsForClient = P.listPersonsForOrg;
const clientsWithOwnerContact = P.orgsWithOwnerParty;
const getManagerByContactId = P.getManagerByPartyId;
const classifyContact = (id) => P.classifyParty(id);
const syncContactToManager = P.syncPartyToManager;
const resolveContactByName = P.resolvePersonByName;
const endAffiliation = P.endAffiliation;
const deleteAffiliation = P.deleteAffiliation;
// 담당자↔연락처 연동(로그인·유저/외주 관리에서 호출) → party 버전 별칭.
const ensureContactForManager = P.ensurePartyForManager;
const ensureContactForUser = P.ensurePartyForUser;
const syncManagerToContact = P.syncManagerToParty;

// ── 사람 목록(연락처) — kind='person' 필터 ──
function listContacts({ q, staff } = {}) {
  return P.listParties({ q, kind: "person", staff });
}

// ── 클라이언트(거래처) 목록 — 조직·그룹·아티스트(사람 아티스트 포함). kind 필터는 레거시 라벨을 party 개념으로 매핑 ──
function listClients({ kind } = {}) {
  if (kind === "소속사/레이블" || kind === "제작사" || kind === "company" || kind === "조직") {
    return P.listParties({ kind: "company" });
  }
  if (kind === "아티스트" || kind === "artist") {
    return P.listParties({ artist: true });
  }
  if (kind === "group" || kind === "그룹") return P.listParties({ kind: "group" });
  // 전체: 조직 + 그룹 + 아티스트(사람)
  return db()
    .prepare("SELECT * FROM parties WHERE kind IN ('company','group') OR is_artist = 1 ORDER BY name COLLATE NOCASE")
    .all();
}

// ── 거래처 kind 카운트(탭 배지) — 레거시 라벨 키로 반환 ──
function clientKindCounts() {
  const c = P.partyKindCounts();
  return { "소속사/레이블": c.company, "제작사": 0, "아티스트": c.artist, "기타": 0, company: c.company, group: c.group, artist: c.artist };
}

// ── 소속 이력: 레거시는 client_* 필드명 → org_* 별칭 부여 ──
const affShape = (a) => (a ? { ...a, client_id: a.org_id, client_name: a.org_name, client_kind: a.org_kind } : a);
function currentAffiliation(personId) {
  return affShape(P.currentAffiliation(personId));
}
function listAffiliations(personId) {
  return P.listAffiliations(personId).map(affShape);
}
function addAffiliation(personId, { client_id, org_id, title, started_on, memo, closeCurrent = true } = {}) {
  return P.addAffiliation(personId, { org_id: org_id != null ? org_id : client_id, title, started_on, memo, closeCurrent });
}
function updateAffiliation(affId, { client_id, org_id, title, started_on, ended_on, memo } = {}) {
  return P.updateAffiliation(affId, { org_id: org_id != null ? org_id : client_id, title, started_on, ended_on, memo });
}
function syncCompanyAffiliation(personId, companyName, title) {
  return P.syncCompanyAffiliation(personId, companyName, title);
}

// ── 콤보 옵션: 담당자(사람) — {id,name,phone,email,current_client} 유지 ──
function contactOptions() {
  return db()
    .prepare(
      `SELECT p.id, p.name, p.phone, p.email,
              (SELECT o.name FROM affiliations a LEFT JOIN parties o ON o.id = a.org_id
                WHERE a.person_id = p.id AND a.ended_on IS NULL ORDER BY a.started_on DESC, a.id DESC LIMIT 1) AS current_client
         FROM parties p WHERE p.kind = 'person' ORDER BY p.name COLLATE NOCASE`
    )
    .all();
}

// ── 콤보 옵션: 청구처(전체 당사자) — {id,name,kind} 유지. 아티스트는 활동명 표시 ──
function clientOptions() {
  return db()
    .prepare(
      `SELECT id, COALESCE(NULLIF(activity_name,''), name) AS name, kind FROM parties
        WHERE kind IN ('company','group') OR is_artist = 1 ORDER BY name COLLATE NOCASE`
    )
    .all();
}

// ── 업체(조직) 소속 아티스트 — affiliations 기반 ──
function listArtistsForAgency(orgId) {
  return db()
    .prepare(
      `SELECT p.id, COALESCE(NULLIF(p.activity_name,''), p.name) AS name FROM affiliations a
         JOIN parties p ON p.id = a.person_id
        WHERE a.org_id = ? AND a.ended_on IS NULL AND p.is_artist = 1 ORDER BY p.name`
    )
    .all(Number(orgId));
}

// ── 이름으로 조직 찾기(자동 생성 안 함) ──
function resolveCompanyByName(name) {
  const n = String(name || "").trim();
  if (!n) return null;
  const ex = db().prepare("SELECT id FROM parties WHERE kind = 'company' AND name = ? ORDER BY id LIMIT 1").get(n);
  return ex ? ex.id : null;
}

module.exports = {
  getContact,
  getClient,
  createContact,
  updateContact,
  deleteContact,
  deleteClientEntity,
  setContactGoogleRef,
  getContactByResourceName,
  listProjectsForContact,
  listProjectsForClient,
  listSessionsForContact,
  listInvoicesForClientEntity,
  listContactsForClient,
  clientsWithOwnerContact,
  getManagerByContactId,
  classifyContact,
  syncContactToManager,
  resolveContactByName,
  endAffiliation,
  deleteAffiliation,
  listContacts,
  listClients,
  clientKindCounts,
  currentAffiliation,
  listAffiliations,
  addAffiliation,
  updateAffiliation,
  syncCompanyAffiliation,
  contactOptions,
  clientOptions,
  listArtistsForAgency,
  resolveCompanyByName,
  ensureContactForManager,
  ensureContactForUser,
  syncManagerToContact,
};
