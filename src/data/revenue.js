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

// 발행일 기간 조건 SQL. period 없음/year 없음/year==='all' = 전체 기간(조건 없음).
// ISSUED가 이미 issued_date IS NOT NULL을 포함하므로 '1=1'이어도 발행일 없는 행은 안 섞인다.
// year·month는 라우트에서 정수 파싱(month='all' 연간). 정수/고정문자열만 보간(주입 안전).
function issuedInPeriodSql(alias, period) {
  const p = period || {};
  if (!p.year || p.year === "all") return "1=1";
  const y = Number(p.year);
  const month = p.month;
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
// period 없으면 전 기간 누적. last_issued=작업·세션 중 최신 발행일.
function revenueByStaff(period) {
  const { listProjectManagers } = require("../data");
  const per = issuedInPeriodSql("i", period);
  const q = (sql) => db().prepare(sql).all();
  const taskRev = q(`SELECT t.engineer_id AS id, COALESCE(SUM(ii.amount),0) AS supply, COUNT(*) AS cnt, MAX(i.issued_date) AS last_issued FROM invoice_items ii JOIN track_tasks t ON t.id = ii.task_id JOIN invoices i ON i.id = ii.invoice_id WHERE ${ISSUED} AND ${per} AND t.engineer_id IS NOT NULL GROUP BY t.engineer_id`);
  const taskPay = q(`SELECT t.engineer_id AS id, COALESCE(SUM(t.worker_rate),0) AS payout FROM invoice_items ii JOIN track_tasks t ON t.id = ii.task_id JOIN invoices i ON i.id = ii.invoice_id WHERE ${ISSUED} AND ${per} AND t.engineer_id IS NOT NULL GROUP BY t.engineer_id`);
  const sessRev = q(`SELECT s.engineer_name AS name, COALESCE(SUM(ii.amount),0) AS supply, COUNT(*) AS cnt, MAX(i.issued_date) AS last_issued FROM invoice_items ii JOIN sessions s ON s.id = ii.session_id JOIN invoices i ON i.id = ii.invoice_id WHERE ${ISSUED} AND ${per} AND s.engineer_name IS NOT NULL GROUP BY s.engineer_name`);
  const sessPay = q(`SELECT s.engineer_name AS name, COALESCE(SUM(se.worker_rate),0) AS payout FROM invoice_items ii JOIN sessions s ON s.id = ii.session_id JOIN session_engineers se ON se.session_id = s.id JOIN invoices i ON i.id = ii.invoice_id WHERE ${ISSUED} AND ${per} AND s.engineer_name IS NOT NULL GROUP BY s.engineer_name`);
  const trById = new Map(taskRev.map((r) => [r.id, r]));
  const tpById = new Map(taskPay.map((r) => [r.id, r.payout]));
  const srByName = new Map(sessRev.map((r) => [r.name, r]));
  const spByName = new Map(sessPay.map((r) => [r.name, r.payout]));
  return listProjectManagers({ includeInactive: true })
    .map((m) => {
      const tr = trById.get(m.id) || { supply: 0, cnt: 0, last_issued: null };
      const sr = srByName.get(m.name) || { supply: 0, cnt: 0, last_issued: null };
      const supply = (tr.supply || 0) + (sr.supply || 0);
      const payout = (tpById.get(m.id) || 0) + (spByName.get(m.name) || 0);
      const last = [tr.last_issued, sr.last_issued].filter(Boolean).sort().pop() || null;
      return { id: m.id, name: m.name, is_external: !m.user_id, supply, profit: supply - payout, task_cnt: tr.cnt || 0, session_cnt: sr.cnt || 0, last_issued: last };
    })
    .filter((r) => r.supply > 0)
    .sort((a, b) => b.supply - a.supply);
}

// 스탭 상세(기간 작업·세션 + 순이익). 세션 행에 payout(그 세션 전 엔지니어 지급단가 합)을 파생 — 월 소계 순이익 산정용.
function revenueForStaff(id, period) {
  const manager = db().prepare("SELECT * FROM project_managers WHERE id = ?").get(Number(id));
  if (!manager) return null;
  const per = issuedInPeriodSql("i", period);
  const tasks = db().prepare(`SELECT t.id, t.task_type, ii.amount AS amount, t.worker_rate, tr.title AS track_title, p.id AS project_id, p.title AS project_title, COALESCE(NULLIF(tr.artist, ''), p.artist) AS artist, i.issued_date FROM invoice_items ii JOIN track_tasks t ON t.id = ii.task_id JOIN project_tracks tr ON tr.id = t.track_id JOIN projects p ON p.id = tr.project_id JOIN invoices i ON i.id = ii.invoice_id WHERE ${ISSUED} AND ${per} AND t.engineer_id = ? ORDER BY i.issued_date DESC, p.title COLLATE NOCASE`).all(Number(id));
  // payout = 그 세션에 배정된 전 엔지니어의 지급단가 합(모델 A: 리드가 전체를 흡수).
  const sessions = db().prepare(`SELECT s.id, s.session_date, s.session_type, ii.amount AS amount, p.id AS project_id, p.title AS project_title, p.artist AS artist, i.issued_date,
      (SELECT COALESCE(SUM(se.worker_rate),0) FROM session_engineers se WHERE se.session_id = s.id) AS payout
    FROM invoice_items ii JOIN sessions s ON s.id = ii.session_id JOIN projects p ON p.id = s.project_id JOIN invoices i ON i.id = ii.invoice_id
    WHERE ${ISSUED} AND ${per} AND s.engineer_name = ? ORDER BY i.issued_date DESC, s.session_date DESC`).all(manager.name);
  const supply = tasks.reduce((a, t) => a + (t.amount || 0), 0) + sessions.reduce((a, s) => a + (s.amount || 0), 0);
  const payout = tasks.reduce((a, t) => a + (t.worker_rate || 0), 0) + sessions.reduce((a, s) => a + (s.payout || 0), 0);
  return { manager, tasks, sessions, supply, payout, profit: supply - payout };
}

// 결제자(업체·개인)별 매출 기여(공급가)·건수·최근 발행일. period 없으면 전 기간 누적.
function revenueByPayer(period) {
  const per = issuedInPeriodSql("i", period);
  return db().prepare(`SELECT i.payer_id AS id, c.kind, c.name, COALESCE(SUM(i.amount - i.tax_amount),0) AS supply, COUNT(*) AS invoice_cnt, MAX(i.issued_date) AS last_issued FROM invoices i JOIN parties c ON c.id = i.payer_id WHERE ${ISSUED} AND ${per} AND i.payer_id IS NOT NULL GROUP BY i.payer_id ORDER BY supply DESC`).all();
}

// 결제자 상세(기간 발행 청구서 목록 + 공급가 합계).
function revenueForPayer(id, period) {
  const party = db().prepare("SELECT * FROM parties WHERE id = ?").get(Number(id));
  if (!party) return null;
  const per = issuedInPeriodSql("i", period);
  // payer_kind = 결제자 kind(현금영수증/계산서 배지용 taxBadge가 inv.payer_kind를 읽음). 전 청구서가 이 party라 party.kind 동일.
  const invoices = db().prepare(`SELECT i.id, i.invoice_number, i.issued_date, i.amount, i.tax_amount, i.tax_status, i.status, (i.amount - i.tax_amount) AS supply, c.kind AS payer_kind, p.title AS project_title, p.artist AS artist FROM invoices i JOIN parties c ON c.id = i.payer_id LEFT JOIN projects p ON p.id = i.project_id WHERE ${ISSUED} AND ${per} AND i.payer_id = ? ORDER BY i.issued_date DESC, i.id DESC`).all(Number(id));
  // 각 청구서가 '무슨 일'이었는지(작업 종류/세션 종류 + 곡·세션날짜) — 스탭 상세와 같은 칸을 채우기 위해.
  // 행 단위는 **청구서 그대로** 둔다(2026-07-20 사용자 결정): 할인이 청구서 단위라 라인 금액 합 ≠ 매출이고
  // (실측 도너츠컬처 18건 중 17건이 할인, 30만 라인이 실제 매출 20만), 돈 화면에서 그 어긋남은 허용할 수 없다.
  // 라인이 1개인 청구서가 대부분(17/18)이라 사실상 라인 단위와 같은 화면이 되고, 여러 개면 개수만 알린다.
  attachWorkSummary(invoices);
  const supply = invoices.reduce((a, r) => a + (r.supply || 0), 0);
  return { party, invoices, supply, invoice_cnt: invoices.length };
}

/**
 * 청구서 배열에 `work_kind`(종류)·`work_detail`(곡 제목 또는 세션 날짜 'YYYY-MM-DD')·`item_count`를 붙인다(제자리 변경).
 * 첫 라인 기준 — 여러 라인이면 뷰가 '개 항목'으로 접는다. 원본 작업·세션이 삭제돼 참조가 끊긴 라인은
 * 종류·세부가 빈 값이 되고(스냅샷 description은 형식이 제각각이라 칸으로 못 쪼갠다) 뷰가 알아서 생략한다.
 */
function attachWorkSummary(invoices) {
  if (!invoices.length) return;
  const ids = invoices.map((r) => Number(r.id));
  const rows = db().prepare(`SELECT ii.invoice_id, ii.id AS item_id, ii.item_date,
      t.task_type, tr.title AS track_title, NULLIF(tr.artist, '') AS track_artist,
      s.session_type, s.session_date
    FROM invoice_items ii
    LEFT JOIN track_tasks t ON t.id = ii.task_id
    LEFT JOIN project_tracks tr ON tr.id = t.track_id
    LEFT JOIN sessions s ON s.id = ii.session_id
    WHERE ii.invoice_id IN (${ids.map(() => "?").join(",")})
    ORDER BY ii.invoice_id, (ii.item_date IS NULL), ii.item_date, ii.id`).all(...ids);
  const byInvoice = new Map();
  rows.forEach((r) => {
    const cur = byInvoice.get(r.invoice_id);
    if (cur) { cur.count += 1; return; } // 첫 라인만 종류·세부로 쓴다(정렬이 항목 날짜순이라 첫 라인 = 가장 이른 항목)
    byInvoice.set(r.invoice_id, { first: r, count: 1 });
  });
  const { taskTypeLabel } = require("../data"); // 지연 require(순환 회피)
  invoices.forEach((inv) => {
    const g = byInvoice.get(inv.id);
    if (!g) { inv.work_kind = ""; inv.work_detail = ""; inv.item_count = 0; return; }
    const f = g.first;
    inv.item_count = g.count;
    if (f.task_type) { inv.work_kind = taskTypeLabel(f.task_type); inv.work_detail = f.track_title || ""; if (f.track_artist) inv.artist = f.track_artist; }
    else if (f.session_type) { inv.work_kind = f.session_type; inv.work_detail = f.session_date || ""; }
    else { inv.work_kind = ""; inv.work_detail = ""; }
  });
}

// 종류별 매출 구성(B4): 작업 종류(taskTypeLabel) + 세션 종류(session_type) 통합, 같은 라벨 합산.
function revenueByType({ year, month }) {
  const { taskTypeLabel } = require("../data");
  const per = issuedInPeriodSql("i", { year, month });
  const taskRows = db().prepare(`SELECT t.task_type AS key, COALESCE(SUM(ii.amount),0) AS amount FROM invoice_items ii JOIN track_tasks t ON t.id = ii.task_id JOIN invoices i ON i.id = ii.invoice_id WHERE ${ISSUED} AND ${per} GROUP BY t.task_type`).all();
  const sessRows = db().prepare(`SELECT s.session_type AS label, COALESCE(SUM(ii.amount),0) AS amount FROM invoice_items ii JOIN sessions s ON s.id = ii.session_id JOIN invoices i ON i.id = ii.invoice_id WHERE ${ISSUED} AND ${per} GROUP BY s.session_type`).all();
  const byLabel = new Map();
  const add = (label, amount) => { if (amount > 0) byLabel.set(label, (byLabel.get(label) || 0) + amount); };
  taskRows.forEach((r) => add(taskTypeLabel(r.key), r.amount));
  sessRows.forEach((r) => add(r.label || "세션", r.amount));
  return Array.from(byLabel, ([label, amount]) => ({ label, amount })).sort((a, b) => b.amount - a.amount);
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
  revenueByType,
};
