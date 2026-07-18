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

// 발행 청구서 조건(별칭 i). issued_date NULL·미발행 제외.
const ISSUED = "i.status <> '미발행' AND i.issued_date IS NOT NULL";

// 발행일 기간 조건 SQL. year·month는 라우트에서 정수 파싱(month='all' 연간). 정수/고정문자열만 보간(주입 안전).
function issuedInPeriodSql(alias, { year, month }) {
  const y = Number(year);
  if (month === "all" || month == null || month === "") return `substr(${alias}.issued_date,1,4) = '${y}'`;
  const ym = `${y}-${String(Number(month)).padStart(2, "0")}`;
  return `substr(${alias}.issued_date,1,7) = '${ym}'`;
}

// 발행 청구서가 있는 년(내림차순).
function revenueYears() {
  return db()
    .prepare(`SELECT DISTINCT substr(issued_date,1,4) AS y FROM invoices WHERE status <> '미발행' AND issued_date IS NOT NULL ORDER BY y DESC`)
    .all()
    .map((r) => Number(r.y))
    .filter(Boolean);
}

// 기간 매출·순이익 + 선택 년 월별 추세.
function revenueSummary({ year, month }) {
  const y = Number(year);
  const per = issuedInPeriodSql("i", { year, month });
  const yr = issuedInPeriodSql("i", { year, month: "all" });
  const supplyIn = (cond) => db().prepare(`SELECT COALESCE(SUM(i.amount - i.tax_amount),0) AS v FROM invoices i WHERE ${ISSUED} AND ${cond}`).get().v;
  const payoutIn = (cond) => {
    const taskPay = db().prepare(`SELECT COALESCE(SUM(t.worker_rate),0) AS v FROM invoice_items ii JOIN track_tasks t ON t.id = ii.task_id JOIN invoices i ON i.id = ii.invoice_id WHERE ${ISSUED} AND ${cond}`).get().v;
    const sessPay = db().prepare(`SELECT COALESCE(SUM(se.worker_rate),0) AS v FROM invoice_items ii JOIN sessions s ON s.id = ii.session_id JOIN session_engineers se ON se.session_id = s.id JOIN invoices i ON i.id = ii.invoice_id WHERE ${ISSUED} AND ${cond}`).get().v;
    return taskPay + sessPay;
  };
  const periodSupply = supplyIn(per);
  const ytdSupply = supplyIn(yr);
  const monthRows = db().prepare(`SELECT CAST(substr(i.issued_date,6,2) AS INTEGER) AS m, COALESCE(SUM(i.amount - i.tax_amount),0) AS v FROM invoices i WHERE ${ISSUED} AND substr(i.issued_date,1,4) = '${y}' GROUP BY m`).all();
  const byMonth = new Map(monthRows.map((r) => [r.m, r.v]));
  const monthly = Array.from({ length: 12 }, (_, k) => ({ month: k + 1, supply: byMonth.get(k + 1) || 0 }));
  return { periodSupply, periodProfit: periodSupply - payoutIn(per), ytdSupply, ytdProfit: ytdSupply - payoutIn(yr), monthly };
}

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

// 스탭(엔지니어)별 매출·순이익. 작업=engineer_id·세션=engineer_name 라인 기준(공급가). 순이익=매출−외주지급.
function revenueByStaff({ year, month }) {
  const { listProjectManagers } = require("../data");
  const per = issuedInPeriodSql("i", { year, month });
  const q = (sql) => db().prepare(sql).all();
  const taskRev = q(`SELECT t.engineer_id AS id, COALESCE(SUM(ii.amount),0) AS supply, COUNT(*) AS cnt FROM invoice_items ii JOIN track_tasks t ON t.id = ii.task_id JOIN invoices i ON i.id = ii.invoice_id WHERE ${ISSUED} AND ${per} AND t.engineer_id IS NOT NULL GROUP BY t.engineer_id`);
  const taskPay = q(`SELECT t.engineer_id AS id, COALESCE(SUM(t.worker_rate),0) AS payout FROM invoice_items ii JOIN track_tasks t ON t.id = ii.task_id JOIN invoices i ON i.id = ii.invoice_id WHERE ${ISSUED} AND ${per} AND t.engineer_id IS NOT NULL GROUP BY t.engineer_id`);
  const sessRev = q(`SELECT s.engineer_name AS name, COALESCE(SUM(ii.amount),0) AS supply, COUNT(*) AS cnt FROM invoice_items ii JOIN sessions s ON s.id = ii.session_id JOIN invoices i ON i.id = ii.invoice_id WHERE ${ISSUED} AND ${per} AND s.engineer_name IS NOT NULL GROUP BY s.engineer_name`);
  const sessPay = q(`SELECT s.engineer_name AS name, COALESCE(SUM(se.worker_rate),0) AS payout FROM invoice_items ii JOIN sessions s ON s.id = ii.session_id JOIN session_engineers se ON se.session_id = s.id JOIN invoices i ON i.id = ii.invoice_id WHERE ${ISSUED} AND ${per} AND s.engineer_name IS NOT NULL GROUP BY s.engineer_name`);
  const trById = new Map(taskRev.map((r) => [r.id, r]));
  const tpById = new Map(taskPay.map((r) => [r.id, r.payout]));
  const srByName = new Map(sessRev.map((r) => [r.name, r]));
  const spByName = new Map(sessPay.map((r) => [r.name, r.payout]));
  return listProjectManagers({ includeInactive: true })
    .map((m) => {
      const tr = trById.get(m.id) || { supply: 0, cnt: 0 };
      const sr = srByName.get(m.name) || { supply: 0, cnt: 0 };
      const supply = (tr.supply || 0) + (sr.supply || 0);
      const payout = (tpById.get(m.id) || 0) + (spByName.get(m.name) || 0);
      return { id: m.id, name: m.name, is_external: !m.user_id, supply, profit: supply - payout, task_cnt: tr.cnt || 0, session_cnt: sr.cnt || 0 };
    })
    .filter((r) => r.supply > 0)
    .sort((a, b) => b.supply - a.supply);
}

// 스탭 상세(기간 작업·세션 + 순이익).
function revenueForStaff(id, { year, month }) {
  const manager = db().prepare("SELECT * FROM project_managers WHERE id = ?").get(Number(id));
  if (!manager) return null;
  const per = issuedInPeriodSql("i", { year, month });
  const tasks = db().prepare(`SELECT t.id, t.task_type, ii.amount AS amount, t.worker_rate, tr.title AS track_title, p.id AS project_id, p.title AS project_title, i.issued_date FROM invoice_items ii JOIN track_tasks t ON t.id = ii.task_id JOIN project_tracks tr ON tr.id = t.track_id JOIN projects p ON p.id = tr.project_id JOIN invoices i ON i.id = ii.invoice_id WHERE ${ISSUED} AND ${per} AND t.engineer_id = ? ORDER BY i.issued_date DESC, p.title COLLATE NOCASE`).all(Number(id));
  const sessions = db().prepare(`SELECT s.id, s.session_date, s.session_type, ii.amount AS amount, p.id AS project_id, p.title AS project_title, i.issued_date FROM invoice_items ii JOIN sessions s ON s.id = ii.session_id JOIN projects p ON p.id = s.project_id JOIN invoices i ON i.id = ii.invoice_id WHERE ${ISSUED} AND ${per} AND s.engineer_name = ? ORDER BY i.issued_date DESC, s.session_date DESC`).all(manager.name);
  const sessPayout = db().prepare(`SELECT COALESCE(SUM(se.worker_rate),0) AS v FROM invoice_items ii JOIN sessions s ON s.id = ii.session_id JOIN session_engineers se ON se.session_id = s.id JOIN invoices i ON i.id = ii.invoice_id WHERE ${ISSUED} AND ${per} AND s.engineer_name = ?`).get(manager.name).v;
  const supply = tasks.reduce((a, t) => a + (t.amount || 0), 0) + sessions.reduce((a, s) => a + (s.amount || 0), 0);
  const payout = tasks.reduce((a, t) => a + (t.worker_rate || 0), 0) + sessPayout;
  return { manager, tasks, sessions, supply, payout, profit: supply - payout };
}

module.exports = {
  revenueByEngineer,
  revenueForEngineer,
  issuedInPeriodSql,
  revenueYears,
  revenueSummary,
  revenueByStaff,
  revenueForStaff,
};
