"use strict";

/**
 * 매출 집계 도메인 — 담당 엔지니어별 매출(작업 + 세션).
 * 실제 청구된 것만 집계(작업=is_invoiced=1, 세션=invoice_items 스냅샷·실제 청구액).
 * data.js에서 분리한 모듈(도메인 모듈화). data.js가 재export하므로 소비자 무변경.
 *
 * cross-domain 의존(listProjectManagers)은 함수 내부에서 지연 require("../data")로 해소한다.
 * 로드 시점엔 data.js가 아직 module.exports를 재할당하기 전이라 순환이 깨지므로,
 * 호출 시점(런타임)에 캐시된 완성 모듈을 받는다.
 */

const { db } = require("../db");

/**
 * 전체 엔지니어별 매출 요약. 작업(engineer_id)·세션(engineer_name) 합산.
 * total > 0인 엔지니어만 반환, 합계 내림차순.
 */
function revenueByEngineer() {
  const { listProjectManagers } = require("../data");
  // 매출 = 실제 청구된 것만(사용자 결정). 작업=is_invoiced, 세션=invoice_items 스냅샷(청구된 세션·실제 청구액).
  // 1) 작업 집계 (engineer_id별, 청구 확정분만)
  const taskRows = db()
    .prepare(
      `SELECT engineer_id, SUM(total_price) AS task_total, COUNT(*) AS task_cnt
       FROM track_tasks WHERE engineer_id IS NOT NULL AND is_invoiced = 1 GROUP BY engineer_id`
    )
    .all();
  const taskByMgr = new Map(taskRows.map((r) => [r.engineer_id, r]));

  // 2) 세션 집계 (engineer_name별) — 청구된 세션의 실제 청구액(invoice_items.amount)
  const sessionRows = db()
    .prepare(
      `SELECT s.engineer_name, ii.amount
       FROM invoice_items ii JOIN sessions s ON s.id = ii.session_id
       WHERE ii.session_id IS NOT NULL AND s.engineer_name IS NOT NULL`
    )
    .all();
  const sessionByName = {};
  for (const row of sessionRows) {
    if (!sessionByName[row.engineer_name]) sessionByName[row.engineer_name] = { total: 0, cnt: 0 };
    sessionByName[row.engineer_name].total += row.amount || 0;
    sessionByName[row.engineer_name].cnt += 1;
  }

  // 3) 매니저 목록과 조합 (total > 0만, 내림차순)
  const managers = listProjectManagers({ includeInactive: true });
  return managers
    .map((m) => {
      const t = taskByMgr.get(m.id) || { task_total: 0, task_cnt: 0 };
      const s = sessionByName[m.name] || { total: 0, cnt: 0 };
      const task_total = t.task_total || 0;
      const task_cnt = t.task_cnt || 0;
      const session_total = s.total;
      const session_cnt = s.cnt;
      const total = task_total + session_total;
      return { id: m.id, name: m.name, is_external: !m.user_id, task_total, task_cnt, session_total, session_cnt, total };
    })
    .filter((r) => r.total > 0)
    .sort((a, b) => b.total - a.total);
}

/**
 * 특정 엔지니어(managerId) 상세 매출. 없으면 null.
 * tasks: track_tasks(engineer_id=id) + 프로젝트·곡 정보.
 * sessions: sessions(engineer_name=manager.name) + 프로젝트명·금액.
 */
function revenueForEngineer(managerId) {
  const manager = db().prepare("SELECT * FROM project_managers WHERE id = ?").get(Number(managerId));
  if (!manager) return null;

  // 실제 청구된 것만(사용자 결정): 작업=is_invoiced=1, 세션=청구된 invoice_items 스냅샷.
  const tasks = db()
    .prepare(
      `SELECT t.id, t.task_type, t.total_price, t.is_invoiced,
              tr.title AS track_title, p.id AS project_id, p.title AS project_title
       FROM track_tasks t
       JOIN project_tracks tr ON tr.id = t.track_id
       JOIN projects p ON p.id = tr.project_id
       WHERE t.engineer_id = ? AND t.is_invoiced = 1
       ORDER BY p.title COLLATE NOCASE, tr.title COLLATE NOCASE`
    )
    .all(Number(managerId));

  const sessions = db()
    .prepare(
      `SELECT s.id, s.session_date, s.session_type, s.start_time, s.end_time,
              p.id AS project_id, p.title AS project_title, ii.amount AS amount
       FROM invoice_items ii
       JOIN sessions s ON s.id = ii.session_id
       JOIN projects p ON p.id = s.project_id
       WHERE ii.session_id IS NOT NULL AND s.engineer_name = ?
       ORDER BY s.session_date DESC, s.start_time`
    )
    .all(manager.name);

  const task_total = tasks.reduce((s, t) => s + (t.total_price || 0), 0);
  const session_total = sessions.reduce((s, r) => s + r.amount, 0);
  return { manager, tasks, sessions, task_total, session_total, total: task_total + session_total };
}

module.exports = {
  revenueByEngineer,
  revenueForEngineer,
};
