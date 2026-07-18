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

// 기간 매출·순이익 + 선택 년 월별 추세(순이익 포함) + 전월/전년 비교.
function revenueSummary({ year, month }) {
  const y = Number(year);
  const isYear = month === "all" || month == null || month === "";
  const supplyIn = (cond) => db().prepare(`SELECT COALESCE(SUM(i.amount - i.tax_amount),0) AS v FROM invoices i WHERE ${ISSUED} AND ${cond}`).get().v;
  const payoutIn = (cond) => {
    const taskPay = db().prepare(`SELECT COALESCE(SUM(t.worker_rate),0) AS v FROM invoice_items ii JOIN track_tasks t ON t.id = ii.task_id JOIN invoices i ON i.id = ii.invoice_id WHERE ${ISSUED} AND ${cond}`).get().v;
    const sessPay = db().prepare(`SELECT COALESCE(SUM(se.worker_rate),0) AS v FROM invoice_items ii JOIN sessions s ON s.id = ii.session_id JOIN session_engineers se ON se.session_id = s.id JOIN invoices i ON i.id = ii.invoice_id WHERE ${ISSUED} AND ${cond}`).get().v;
    return taskPay + sessPay;
  };
  const profitIn = (cond) => supplyIn(cond) - payoutIn(cond);
  const condOf = (p) => issuedInPeriodSql("i", p);
  const per = condOf({ year, month });
  const yr = condOf({ year, month: "all" });
  const periodSupply = supplyIn(per);
  const ytdSupply = supplyIn(yr);

  // 비교 기간(전월/전년 동월, 연간 선택은 전년 전체)
  const m = Number(month);
  const prevPeriod = isYear ? { year: y - 1, month: "all" } : (m === 1 ? { year: y - 1, month: 12 } : { year: y, month: m - 1 });
  const prevYear = isYear ? null : { year: y - 1, month: m };
  const cmp = {
    isYear,
    prevPeriodSupply: supplyIn(condOf(prevPeriod)),
    prevPeriodProfit: profitIn(condOf(prevPeriod)),
    prevYearSupply: prevYear ? supplyIn(condOf(prevYear)) : null,
    prevYearProfit: prevYear ? profitIn(condOf(prevYear)) : null,
  };

  // 월별 매출·순이익
  const groupByMonth = (sql) => new Map(db().prepare(sql).all().map((r) => [r.m, r.v]));
  const supM = groupByMonth(`SELECT CAST(substr(i.issued_date,6,2) AS INTEGER) AS m, COALESCE(SUM(i.amount - i.tax_amount),0) AS v FROM invoices i WHERE ${ISSUED} AND substr(i.issued_date,1,4) = '${y}' GROUP BY m`);
  const taskPayM = groupByMonth(`SELECT CAST(substr(i.issued_date,6,2) AS INTEGER) AS m, COALESCE(SUM(t.worker_rate),0) AS v FROM invoice_items ii JOIN track_tasks t ON t.id = ii.task_id JOIN invoices i ON i.id = ii.invoice_id WHERE ${ISSUED} AND substr(i.issued_date,1,4) = '${y}' GROUP BY m`);
  const sessPayM = groupByMonth(`SELECT CAST(substr(i.issued_date,6,2) AS INTEGER) AS m, COALESCE(SUM(se.worker_rate),0) AS v FROM invoice_items ii JOIN sessions s ON s.id = ii.session_id JOIN session_engineers se ON se.session_id = s.id JOIN invoices i ON i.id = ii.invoice_id WHERE ${ISSUED} AND substr(i.issued_date,1,4) = '${y}' GROUP BY m`);
  const monthly = Array.from({ length: 12 }, (_, k) => {
    const mm = k + 1;
    const sup = supM.get(mm) || 0;
    const pay = (taskPayM.get(mm) || 0) + (sessPayM.get(mm) || 0);
    return { month: mm, supply: sup, profit: sup - pay };
  });

  return { periodSupply, periodProfit: periodSupply - payoutIn(per), ytdSupply, ytdProfit: ytdSupply - payoutIn(yr), monthly, cmp };
}

// 세무 참고: 기간 VAT 합계 + 외주 원천징수 3.3% 예상(표시 참고용, lib/tax.js withholding33).
function revenueTax({ year, month }) {
  const { withholding33 } = require("../lib/tax");
  const per = issuedInPeriodSql("i", { year, month });
  const vatTotal = db().prepare(`SELECT COALESCE(SUM(i.tax_amount),0) AS v FROM invoices i WHERE ${ISSUED} AND ${per}`).get().v;
  const taskPay = db().prepare(`SELECT COALESCE(SUM(t.worker_rate),0) AS v FROM invoice_items ii JOIN track_tasks t ON t.id = ii.task_id JOIN invoices i ON i.id = ii.invoice_id WHERE ${ISSUED} AND ${per}`).get().v;
  const sessPay = db().prepare(`SELECT COALESCE(SUM(se.worker_rate),0) AS v FROM invoice_items ii JOIN sessions s ON s.id = ii.session_id JOIN session_engineers se ON se.session_id = s.id JOIN invoices i ON i.id = ii.invoice_id WHERE ${ISSUED} AND ${per}`).get().v;
  const payoutTotal = taskPay + sessPay;
  return { vatTotal, payoutTotal, withholding: withholding33(payoutTotal) };
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

// 결제자(업체·개인)별 매출 기여(공급가)·건수.
function revenueByPayer({ year, month }) {
  const per = issuedInPeriodSql("i", { year, month });
  return db().prepare(`SELECT i.payer_id AS id, c.kind, c.name, COALESCE(SUM(i.amount - i.tax_amount),0) AS supply, COUNT(*) AS invoice_cnt FROM invoices i JOIN parties c ON c.id = i.payer_id WHERE ${ISSUED} AND ${per} AND i.payer_id IS NOT NULL GROUP BY i.payer_id ORDER BY supply DESC`).all();
}

// 결제자 상세(기간 발행 청구서 목록 + 공급가 합계).
function revenueForPayer(id, { year, month }) {
  const party = db().prepare("SELECT * FROM parties WHERE id = ?").get(Number(id));
  if (!party) return null;
  const per = issuedInPeriodSql("i", { year, month });
  // payer_kind = 결제자 kind(현금영수증/계산서 배지용 taxBadge가 inv.payer_kind를 읽음). 전 청구서가 이 party라 party.kind 동일.
  const invoices = db().prepare(`SELECT i.id, i.invoice_number, i.issued_date, i.amount, i.tax_amount, i.tax_status, i.status, (i.amount - i.tax_amount) AS supply, c.kind AS payer_kind, p.title AS project_title FROM invoices i JOIN parties c ON c.id = i.payer_id LEFT JOIN projects p ON p.id = i.project_id WHERE ${ISSUED} AND ${per} AND i.payer_id = ? ORDER BY i.issued_date DESC, i.id DESC`).all(Number(id));
  const supply = invoices.reduce((a, r) => a + (r.supply || 0), 0);
  return { party, invoices, supply, invoice_cnt: invoices.length };
}

module.exports = {
  issuedInPeriodSql,
  revenueYears,
  revenueSummary,
  revenueTax,
  revenueByStaff,
  revenueForStaff,
  revenueByPayer,
  revenueForPayer,
};
