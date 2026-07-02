"use strict";

/**
 * 자료 전달 도메인(deliverables) — 프로젝트 범위 강제.
 * 인증 다운로드/공개 토큰 링크 게이트는 호출부(deliverables.routes)에서.
 * data.js에서 분리한 모듈(도메인 모듈화). data.js가 재export하므로 소비자 무변경.
 *
 * cross-domain 의존(getProjectForUser)은 함수 내부에서 지연 require("../data")로 해소한다
 * (로드 시 순환 회피, 호출 시 캐시된 완성 모듈 사용).
 */

const { db } = require("../db");

/** 프로젝트의 자료 목록(권한 검사: 클라이언트는 자기 프로젝트만). 권한 없으면 null. */
function listDeliverablesForProject(user, projectId) {
  const { getProjectForUser } = require("../data");
  const project = getProjectForUser(user, projectId);
  if (!project) return null; // 404 처리용
  const rows = db()
    .prepare("SELECT * FROM deliverables WHERE project_id = ? ORDER BY created_at DESC, id DESC")
    .all(projectId);
  return { project, rows };
}

/** 단건 자료(로그인 직원 전체 열람). 소속 프로젝트가 있으면 존재만 확인. */
function getDeliverableForUser(user, id) {
  const { getProjectForUser } = require("../data");
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
  listDeliverablesForProject,
  getDeliverableForUser,
  getDeliverableByToken,
  recentDeliverables,
};
