"use strict";

/**
 * 전역 통합 검색 집계(2026-07-21) — 5개 엔티티를 **기존 조회로 모아** 카테고리 순서 고정으로 반환.
 * 스펙: docs/superpowers/specs/2026-07-21-global-search-design.md.
 *
 * 여기선 raw rows만 낸다 — `{label,sub,href}` 매핑은 뷰 헬퍼(personName/personLabel)가 필요해 라우트에서 수행.
 * 크로스 도메인 require는 형제 모듈 직접(무순환 — 이 모듈을 되부르는 곳 없음).
 */
const { listProjects } = require("./projects");
const { listContacts, listClients } = require("./parties");
const { searchInvoices } = require("./invoices");
const { upcomingSessions, pastSessions } = require("./sessions");

// listClients는 q 인자가 없어 clients/suggest처럼 이름·활동명으로 JS 필터(기존 패턴 유지).
function searchClientsBy(q, limit) {
  const ql = q.toLowerCase();
  return listClients({})
    .filter((c) => String(c.name || "").toLowerCase().includes(ql) || String(c.activity_name || "").toLowerCase().includes(ql))
    .slice(0, limit);
}

// 세션은 다가오는+지난을 합쳐 여러 필드로 매칭(sessions/suggest와 동일 규칙).
function searchSessionsBy(user, q, limit) {
  const ql = q.toLowerCase();
  const all = [...upcomingSessions(user, { limit: 100 }), ...pastSessions(user, { limit: 100 })];
  return all
    .filter((s) => [s.project_title, s.artist, s.artist_company, s.production_company, s.booker_name, s.engineer_name, s.session_type, s.memo]
      .filter(Boolean).join(" ").toLowerCase().includes(ql))
    .slice(0, limit);
}

/**
 * 5개 카테고리 집계. 순서 고정(프로젝트→연락처→업체·그룹→청구→세션). rows는 카테고리별 상위 perCat건.
 * @returns {Array<{cat:string, key:string, rows:object[]}>}
 */
function searchAll(user, q, perCat = 5) {
  const query = String(q || "").trim();
  if (!query) return [];
  return [
    { cat: "프로젝트", key: "projects", rows: listProjects(user, { q: query }).slice(0, perCat) },
    { cat: "연락처", key: "contacts", rows: listContacts({ q: query }).slice(0, perCat) },
    { cat: "업체·그룹", key: "clients", rows: searchClientsBy(query, perCat) },
    { cat: "청구", key: "invoices", rows: searchInvoices(user, query, perCat) },
    { cat: "세션", key: "sessions", rows: searchSessionsBy(user, query, perCat) },
  ];
}

module.exports = { searchAll };
