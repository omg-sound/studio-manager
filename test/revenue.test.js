"use strict";
process.env.NODE_ENV = "test";
const { tempDbPath, cleanupDb } = require("./helpers");
process.env.DB_PATH = tempDbPath();
const test = require("node:test");
const assert = require("node:assert");
const { db, init } = require("../src/db");
init();
test.after(() => cleanupDb(process.env.DB_PATH, db()));
const D = require("../src/data");

// 공용 픽스처: 회사 청구처 + VAT 포함 발행 청구서 1건(공급가 100000, VAT 10000, 총 110000).
// invoice_items에 작업 라인 1건(공급가 100000) + 그 작업에 외주 지급 30000.
function seedInvoice({ issued = "2026-07-10", payerName = "테스트컴퍼니", amount = 110000, tax = 10000, workerRate = 30000, engineerId = null } = {}) {
  const payer = db().prepare("INSERT INTO parties (kind, name) VALUES ('company', ?)").run(payerName).lastInsertRowid;
  const proj = db().prepare("INSERT INTO projects (title, project_type, rate) VALUES ('P', 'task', 0)").run().lastInsertRowid;
  const tr = db().prepare("INSERT INTO project_tracks (project_id, title, content_type) VALUES (?, '곡', 'Music')").run(proj).lastInsertRowid;
  const task = db().prepare("INSERT INTO track_tasks (track_id, task_type, billing_type, quantity, unit_price, total_price, status, is_invoiced, engineer_id, worker_rate) VALUES (?, 'Mixing', 'Fixed_Per_Track', 1, 100000, 100000, 'Completed', 1, ?, ?)").run(tr, engineerId, workerRate).lastInsertRowid;
  const inv = db().prepare("INSERT INTO invoices (project_id, payer_id, title, amount, tax_amount, status, issued_date) VALUES (?, ?, 'T', ?, ?, '발행', ?)").run(proj, payer, amount, tax, issued).lastInsertRowid;
  const supply = amount - tax;
  db().prepare("INSERT INTO invoice_items (invoice_id, task_id, description, quantity, unit_price, amount) VALUES (?, ?, 'Mixing', 1, ?, ?)").run(inv, task, supply, supply);
  return { payer, proj, task, inv };
}

test("revenueSummary: 공급가(VAT 제외)·발생 기준 + 순이익(매출−외주) + 월별 추세", () => {
  seedInvoice({ issued: "2026-07-10", amount: 110000, tax: 10000, workerRate: 30000 });
  seedInvoice({ issued: "2026-03-05", amount: 55000, tax: 5000, workerRate: 0 });
  const s = D.revenueSummary({ year: 2026, month: 7 });
  assert.equal(s.periodSupply, 100000, "7월 공급가 = 110000-10000");
  assert.equal(s.periodProfit, 70000, "7월 순이익 = 100000-30000");
  assert.equal(s.ytdSupply, 150000, "올해 공급가 = 100000(7월)+50000(3월)");
  assert.equal(s.ytdProfit, 120000, "올해 순이익 = 150000-30000");
  assert.equal(s.monthly.length, 12, "12개월");
  assert.equal(s.monthly[6].supply, 100000, "7월(index 6)");
  assert.equal(s.monthly[2].supply, 50000, "3월(index 2)");
  assert.equal(s.monthly[0].supply, 0, "1월 없음");
});

test("revenueSummary: month='all'이면 선택 년 전체 집계", () => {
  const s = D.revenueSummary({ year: 2026, month: "all" });
  assert.equal(s.periodSupply, s.ytdSupply, "연간 선택 = YTD와 동일");
});

test("revenueSummary: 미발행 청구서는 매출에서 제외", () => {
  const before = D.revenueSummary({ year: 2027, month: 1 }).periodSupply;
  const payer = db().prepare("INSERT INTO parties (kind, name) VALUES ('company','미발행사')").run().lastInsertRowid;
  db().prepare("INSERT INTO invoices (payer_id, title, amount, tax_amount, status, issued_date) VALUES (?, 'T', 99000, 9000, '미발행', '2027-01-05')").run(payer);
  assert.equal(D.revenueSummary({ year: 2027, month: 1 }).periodSupply, before, "미발행 제외");
});

test("revenueSummary: 세션 청구 라인의 session_engineers.worker_rate도 순이익에서 차감", () => {
  const payer = db().prepare("INSERT INTO parties (kind, name) VALUES ('company', ?)").run("세션청구컴퍼니").lastInsertRowid;
  const proj = db().prepare("INSERT INTO projects (title, project_type, rate) VALUES ('SP', 'task', 0)").run().lastInsertRowid;
  const mgr = db().prepare("INSERT INTO project_managers (name) VALUES ('세션엔지')").run().lastInsertRowid;
  const sess = db()
    .prepare("INSERT INTO sessions (project_id, session_type, session_date, engineer_name, status) VALUES (?, '녹음', '2026-11-05', '세션엔지', '완료')")
    .run(proj).lastInsertRowid;
  db().prepare("INSERT INTO session_engineers (session_id, manager_id, worker_rate) VALUES (?, ?, ?)").run(sess, mgr, 40000);
  const inv = db()
    .prepare("INSERT INTO invoices (project_id, payer_id, title, amount, tax_amount, status, issued_date) VALUES (?, ?, 'ST', 132000, 12000, '발행', '2026-11-05')")
    .run(proj, payer).lastInsertRowid;
  db().prepare("INSERT INTO invoice_items (invoice_id, session_id, description, quantity, unit_price, amount) VALUES (?, ?, '녹음', 1, 120000, 120000)").run(inv, sess);

  const s = D.revenueSummary({ year: 2026, month: 11 });
  assert.equal(s.periodSupply, 120000, "11월 공급가 = 132000-12000");
  assert.equal(s.periodProfit, 80000, "11월 순이익 = 120000-40000(세션 외주 지급단가)");
});

test("revenueYears: 발행 청구서가 있는 년 내림차순", () => {
  const ys = D.revenueYears();
  assert.ok(ys.includes(2026), "2026 포함");
  for (let k = 1; k < ys.length; k++) assert.ok(ys[k - 1] >= ys[k], "내림차순");
});

test("revenueByStaff: 작업(engineer_id)+세션(engineer_name) 매출·순이익·건수, 기간·공급가", () => {
  // 담당자(하우스) 생성 — user_id는 users FK라 실제 사용자 행이 필요(브리프 원안의 하드코딩 1은 FK 위반)
  const u = db().prepare("INSERT INTO users (email, role, name) VALUES ('staff-rbs@test.com', 'staff', '김엔지')").run().lastInsertRowid;
  const mgr = db().prepare("INSERT INTO project_managers (name, active, user_id) VALUES ('김엔지', 1, ?)").run(u).lastInsertRowid;
  // 그 담당자의 작업이 든 발행 청구서(공급가 100000·외주 30000)
  seedInvoice({ issued: "2026-08-10", payerName: "스탭테스트사", amount: 110000, tax: 10000, workerRate: 30000, engineerId: mgr });
  const rows = D.revenueByStaff({ year: 2026, month: 8 });
  const me = rows.find((r) => r.id === mgr);
  assert.ok(me, "담당자 매출 노출");
  assert.equal(me.supply, 100000, "작업 라인 공급가");
  assert.equal(me.profit, 70000, "순이익 = 100000-30000");
  assert.equal(me.task_cnt, 1, "작업 1건");
  assert.equal(me.is_external, false, "하우스(user_id 있음)");
  // 다른 달 조회 시 제외
  assert.ok(!D.revenueByStaff({ year: 2026, month: 9 }).find((r) => r.id === mgr), "9월엔 없음");
});

test("revenueForStaff: 담당자 상세(기간 작업·세션 + 순이익), 없으면 null", () => {
  const u = db().prepare("INSERT INTO users (email, role, name) VALUES ('staff-rfs@test.com', 'staff', '박엔지')").run().lastInsertRowid;
  const mgr = db().prepare("INSERT INTO project_managers (name, active, user_id) VALUES ('박엔지', 1, ?)").run(u).lastInsertRowid;
  seedInvoice({ issued: "2026-06-10", payerName: "상세테스트사", amount: 220000, tax: 20000, workerRate: 50000, engineerId: mgr });
  const d = D.revenueForStaff(mgr, { year: 2026, month: 6 });
  assert.equal(d.supply, 200000, "공급가");
  assert.equal(d.payout, 50000, "외주 지급");
  assert.equal(d.profit, 150000, "순이익");
  assert.equal(d.tasks.length, 1, "작업 1건");
  assert.equal(D.revenueForStaff(999999, { year: 2026, month: 6 }), null, "없는 id는 null");
});

test("revenueByStaff/revenueForStaff: 다인 세션은 리드 엔지니어에게 전액 귀속", () => {
  // 모델 A(리드 귀속, 사용자 확정): 다인 세션의 전체 외주지급이 리드에게. 공동 엔지니어는 안 나타남.
  const payer = db().prepare("INSERT INTO parties (kind, name) VALUES ('company', ?)").run("다인세션컴퍼니").lastInsertRowid;
  const proj = db().prepare("INSERT INTO projects (title, project_type, rate) VALUES ('MP', 'task', 0)").run().lastInsertRowid;
  const lead = db().prepare("INSERT INTO project_managers (name) VALUES ('리드엔지')").run().lastInsertRowid;
  const co = db().prepare("INSERT INTO project_managers (name) VALUES ('공동엔지')").run().lastInsertRowid;
  const sess = db()
    .prepare("INSERT INTO sessions (project_id, session_type, session_date, engineer_name, status) VALUES (?, '녹음', '2026-12-05', '리드엔지', '완료')")
    .run(proj).lastInsertRowid;
  db().prepare("INSERT INTO session_engineers (session_id, manager_id, worker_rate) VALUES (?, ?, ?)").run(sess, lead, 10000);
  db().prepare("INSERT INTO session_engineers (session_id, manager_id, worker_rate) VALUES (?, ?, ?)").run(sess, co, 20000);
  const inv = db()
    .prepare("INSERT INTO invoices (project_id, payer_id, title, amount, tax_amount, status, issued_date) VALUES (?, ?, 'MT', 110000, 10000, '발행', '2026-12-05')")
    .run(proj, payer).lastInsertRowid;
  db().prepare("INSERT INTO invoice_items (invoice_id, session_id, description, quantity, unit_price, amount) VALUES (?, ?, '녹음', 1, 100000, 100000)").run(inv, sess);

  const d = D.revenueForStaff(lead, { year: 2026, month: 12 });
  assert.equal(d.supply, 100000, "리드 공급가 = 세션 청구액 전액");
  assert.equal(d.payout, 30000, "리드 외주지급 = 세션 전체 worker_rate 합(10000+20000)");
  assert.equal(d.profit, 70000, "순이익 = 100000-30000");

  const rows = D.revenueByStaff({ year: 2026, month: 12 });
  const leadRow = rows.find((r) => r.id === lead);
  assert.ok(leadRow, "리드 매출 노출");
  assert.equal(leadRow.supply, 100000, "리드 공급가");
  assert.equal(leadRow.profit, 70000, "리드 순이익");
  assert.equal(rows.find((r) => r.id === co), undefined, "공동 엔지니어는 별도 행으로 안 나타남(공급가 0 → 필터됨)");
});

test("revenueForStaff: 세션 행 payout — 다인 세션 전액을 리드가 흡수(모델 A), 항목 합 = 총계", () => {
  const payer = db().prepare("INSERT INTO parties (kind, name) VALUES ('company', ?)").run("세션지급사").lastInsertRowid;
  const proj = db().prepare("INSERT INTO projects (title, project_type, rate) VALUES ('PD', 'task', 0)").run().lastInsertRowid;
  const lead = db().prepare("INSERT INTO project_managers (name) VALUES ('지급리드')").run().lastInsertRowid;
  const co = db().prepare("INSERT INTO project_managers (name) VALUES ('지급공동')").run().lastInsertRowid;
  const sess = db().prepare("INSERT INTO sessions (project_id, session_type, session_date, engineer_name, status) VALUES (?, '녹음', '2026-08-08', '지급리드', '완료')").run(proj).lastInsertRowid;
  db().prepare("INSERT INTO session_engineers (session_id, manager_id, worker_rate) VALUES (?, ?, ?)").run(sess, lead, 10000);
  db().prepare("INSERT INTO session_engineers (session_id, manager_id, worker_rate) VALUES (?, ?, ?)").run(sess, co, 20000);
  const inv = db().prepare("INSERT INTO invoices (project_id, payer_id, title, amount, tax_amount, status, issued_date) VALUES (?, ?, 'PT', 220000, 20000, '발행', '2026-08-08')").run(proj, payer).lastInsertRowid;
  db().prepare("INSERT INTO invoice_items (invoice_id, session_id, description, quantity, unit_price, amount) VALUES (?, ?, '녹음', 1, 200000, 200000)").run(inv, sess);

  const data = D.revenueForStaff(lead);
  const s = data.sessions.find((r) => r.id === sess);
  assert.equal(s.payout, 30000, "그 세션 배정 전원의 지급단가 합(10000+20000)");
  const taskPayoutSum = data.tasks.reduce((a, t) => a + (t.worker_rate || 0), 0);
  const sessPayoutSum = data.sessions.reduce((a, r) => a + (r.payout || 0), 0);
  assert.equal(taskPayoutSum + sessPayoutSum, data.payout, "항목별 지급 합 = 전체 지급");
  assert.equal(data.supply - data.payout, data.profit, "순이익 정합");
  assert.equal(D.revenueForStaff(co).sessions.length, 0, "공동 엔지니어에겐 세션이 안 잡힌다(모델 A)");
});

test("revenueByPayer: 결제자(업체/개인)별 공급가 기여·건수, 기간·kind", () => {
  const { payer } = seedInvoice({ issued: "2026-05-10", payerName: "기여도컴퍼니", amount: 330000, tax: 30000 });
  const rows = D.revenueByPayer({ year: 2026, month: 5 });
  const r = rows.find((x) => x.id === payer);
  assert.ok(r, "결제자 노출");
  assert.equal(r.supply, 300000, "공급가 = 330000-30000");
  assert.equal(r.invoice_cnt, 1, "1건");
  assert.equal(r.kind, "company", "업체 kind");
  assert.equal(r.name, "기여도컴퍼니");
});

test("revenueForPayer: 결제자 상세(기간 발행 청구서 목록), 없으면 null", () => {
  const { payer } = seedInvoice({ issued: "2026-04-10", payerName: "결제자상세사", amount: 110000, tax: 10000 });
  const d = D.revenueForPayer(payer, { year: 2026, month: 4 });
  assert.equal(d.supply, 100000, "공급가 합계");
  assert.equal(d.invoice_cnt, 1, "청구서 1건");
  assert.equal(d.invoices[0].supply, 100000, "라인 supply 파생");
  assert.equal(D.revenueForPayer(999999, { year: 2026, month: 4 }), null, "없는 id는 null");
});

test("revenueSummary 확장: 월별 순이익 + 전월·전년 비교(cmp)", () => {
  // 2027년으로 격리(다른 테스트와 안 겹치게)
  seedInvoice({ issued: "2027-06-10", payerName: "확장6월", amount: 110000, tax: 10000, workerRate: 30000 }); // 6월 공급가 100000·순이익 70000
  seedInvoice({ issued: "2027-07-10", payerName: "확장7월", amount: 220000, tax: 20000, workerRate: 50000 }); // 7월 공급가 200000·순이익 150000
  // 주의: 2026-07은 파일 상단(줄 26) "revenueSummary: 공급가…" 테스트가 이미 공급가 100000·외주 30000(순이익 70000)을 심어둠 —
  // 브리프 원안은 2026-07을 비어있다고 가정했으나 공용 DB라 겹친다. 기대값은 그 기존분 + 이 테스트분 합으로 보정.
  seedInvoice({ issued: "2026-07-05", payerName: "확장전년7월", amount: 55000, tax: 5000, workerRate: 0 }); // 전년 7월 추가분 공급가 50000·순이익 50000
  const s = D.revenueSummary({ year: 2027, month: 7 });
  assert.equal(s.monthly[6].supply, 200000, "7월 매출");
  assert.equal(s.monthly[6].profit, 150000, "7월 순이익(200000-50000)");
  assert.equal(s.monthly[5].profit, 70000, "6월 순이익");
  assert.equal(s.cmp.isYear, false, "월 선택");
  assert.equal(s.cmp.prevPeriodSupply, 100000, "전월(6월) 매출");
  assert.equal(s.cmp.prevPeriodProfit, 70000, "전월 순이익");
  assert.equal(s.cmp.prevYearSupply, 150000, "전년 동월(2026-07) 매출 = 기존 100000 + 추가 50000");
  assert.equal(s.cmp.prevYearProfit, 120000, "전년 동월 순이익 = 기존 70000 + 추가 50000(외주 0)");
});

test("revenueSummary 확장: 연간 선택은 전년 전체 비교(prevYear null)", () => {
  const s = D.revenueSummary({ year: 2027, month: "all" });
  assert.equal(s.cmp.isYear, true);
  assert.equal(s.cmp.prevPeriodSupply, D.revenueSummary({ year: 2026, month: "all" }).ytdSupply, "연간 전월비교=전년 전체");
  assert.equal(s.cmp.prevYearSupply, null, "연간은 전년동월 없음");
});

test("revenueSummary 확장: 1월 전월 비교는 전년 12월로 롤오버(cmp)", () => {
  // 2028/2029 격리 — 다른 테스트와 안 겹치게.
  seedInvoice({ issued: "2028-12-10", payerName: "롤오버12월", amount: 110000, tax: 10000, workerRate: 0 }); // 12월 공급가 100000
  seedInvoice({ issued: "2029-01-10", payerName: "롤오버1월", amount: 220000, tax: 20000, workerRate: 0 }); // 1월 공급가 200000
  const s = D.revenueSummary({ year: 2029, month: 1 });
  assert.equal(s.cmp.prevPeriodSupply, 100000, "전월(2028년 12월)로 롤오버");
});

test("revenueTax: VAT 합계 + 외주 원천징수 3.3%", () => {
  const { withholding33 } = require("../src/lib/tax");
  seedInvoice({ issued: "2027-09-10", payerName: "세무테스트", amount: 330000, tax: 30000, workerRate: 100000 });
  const t = D.revenueTax({ year: 2027, month: 9 });
  assert.equal(t.vatTotal, 30000, "VAT 합계=Σtax_amount");
  assert.equal(t.payoutTotal, 100000, "외주 지급 합");
  assert.deepEqual(t.withholding, withholding33(100000), "원천징수=withholding33(외주지급)");
  assert.equal(t.withholding.total, 3300, "3.3% (소득세 3000 + 지방세 300)");
});

test("revenueByType: 작업+세션 종류별 매출 통합(라벨 합산·정렬)", () => {
  // 작업(믹싱) 라인 + 세션(녹음) 라인 각각 발행
  seedInvoice({ issued: "2027-10-10", payerName: "구성작업", amount: 220000, tax: 20000, workerRate: 0 }); // task 'Mixing' 라인 공급가 200000 (seedInvoice의 task_type='Mixing')
  // 세션 라인 발행(별도)
  const payer = db().prepare("INSERT INTO parties (kind, name) VALUES ('company','구성세션')").run().lastInsertRowid;
  const proj = db().prepare("INSERT INTO projects (title, project_type, rate) VALUES ('CP','session',0)").run().lastInsertRowid;
  const sess = db().prepare("INSERT INTO sessions (project_id, session_type, session_date, status) VALUES (?, '녹음', '2027-10-12', '완료')").run(proj).lastInsertRowid;
  const inv = db().prepare("INSERT INTO invoices (project_id, payer_id, title, amount, tax_amount, status, issued_date) VALUES (?, ?, 'S', 110000, 10000, '발행', '2027-10-12')").run(proj, payer).lastInsertRowid;
  db().prepare("INSERT INTO invoice_items (invoice_id, session_id, description, quantity, unit_price, amount) VALUES (?, ?, '녹음', 1, 100000, 100000)").run(inv, sess);
  const rows = D.revenueByType({ year: 2027, month: 10 });
  const mix = rows.find((r) => r.label === D.taskTypeLabel("Mixing"));
  const rec = rows.find((r) => r.label === "녹음");
  assert.ok(mix && mix.amount === 200000, "믹싱(작업) 200000");
  assert.ok(rec && rec.amount === 100000, "녹음(세션) 100000");
  assert.ok(rows[0].amount >= rows[rows.length - 1].amount, "내림차순");
});

test("issuedInPeriodSql: 전체 기간 모드(년 없음/all) = 조건 없음", () => {
  const { issuedInPeriodSql } = require("../src/data/revenue");
  assert.equal(issuedInPeriodSql("i", undefined), "1=1");
  assert.equal(issuedInPeriodSql("i", {}), "1=1");
  assert.equal(issuedInPeriodSql("i", { year: "all" }), "1=1");
  assert.equal(issuedInPeriodSql("i", { year: 2026, month: "all" }), "substr(i.issued_date,1,4) = '2026'");
  assert.equal(issuedInPeriodSql("i", { year: 2026, month: 7 }), "substr(i.issued_date,1,7) = '2026-07'");
});

test("revenueByPayer: 기간 없이 호출하면 전 기간 누적 + last_issued(최근 발행일)", () => {
  const payer = db().prepare("INSERT INTO parties (kind, name) VALUES ('company', ?)").run("누적테스트사").lastInsertRowid;
  const proj = db().prepare("INSERT INTO projects (title, project_type, rate) VALUES ('AP', 'task', 0)").run().lastInsertRowid;
  const mk = (issued, amount, tax) => db()
    .prepare("INSERT INTO invoices (project_id, payer_id, title, amount, tax_amount, status, issued_date) VALUES (?, ?, 'AT', ?, ?, '발행', ?)")
    .run(proj, payer, amount, tax, issued);
  mk("2025-03-10", 1100000, 100000); // 공급가 100만
  mk("2026-06-18", 2200000, 200000); // 공급가 200만

  const all = D.revenueByPayer().find((r) => r.id === payer);
  assert.equal(all.supply, 3000000, "전 기간 누적 공급가");
  assert.equal(all.invoice_cnt, 2);
  assert.equal(all.last_issued, "2026-06-18", "최근 발행일 = 두 건 중 최신");
  const y2025 = D.revenueByPayer({ year: 2025, month: "all" }).find((r) => r.id === payer);
  assert.equal(y2025.supply, 1000000, "연도 필터는 그대로 동작");
});

test("revenueByStaff: last_issued = 작업·세션 중 최신 발행일", () => {
  const payer = db().prepare("INSERT INTO parties (kind, name) VALUES ('company', ?)").run("스탭최근사").lastInsertRowid;
  const proj = db().prepare("INSERT INTO projects (title, project_type, rate) VALUES ('SL', 'task', 0)").run().lastInsertRowid;
  const mgr = db().prepare("INSERT INTO project_managers (name) VALUES ('최근엔지')").run().lastInsertRowid;
  // 작업 라인(발행 2026-02-01)
  const tr = db().prepare("INSERT INTO project_tracks (project_id, title, content_type) VALUES (?, '곡', 'Music')").run(proj).lastInsertRowid;
  const task = db().prepare("INSERT INTO track_tasks (track_id, task_type, billing_type, quantity, unit_price, total_price, status, is_invoiced, engineer_id, worker_rate) VALUES (?, 'Mixing', 'Fixed_Per_Track', 1, 100000, 100000, 'Completed', 1, ?, 0)").run(tr, mgr).lastInsertRowid;
  const inv1 = db().prepare("INSERT INTO invoices (project_id, payer_id, title, amount, tax_amount, status, issued_date) VALUES (?, ?, 'S1', 110000, 10000, '발행', '2026-02-01')").run(proj, payer).lastInsertRowid;
  db().prepare("INSERT INTO invoice_items (invoice_id, task_id, description, quantity, unit_price, amount) VALUES (?, ?, 'Mixing', 1, 100000, 100000)").run(inv1, task);
  // 세션 라인(발행 2026-09-09) — 이쪽이 더 최신
  const sess = db().prepare("INSERT INTO sessions (project_id, session_type, session_date, engineer_name, status) VALUES (?, '녹음', '2026-09-09', '최근엔지', '완료')").run(proj).lastInsertRowid;
  const inv2 = db().prepare("INSERT INTO invoices (project_id, payer_id, title, amount, tax_amount, status, issued_date) VALUES (?, ?, 'S2', 220000, 20000, '발행', '2026-09-09')").run(proj, payer).lastInsertRowid;
  db().prepare("INSERT INTO invoice_items (invoice_id, session_id, description, quantity, unit_price, amount) VALUES (?, ?, '녹음', 1, 200000, 200000)").run(inv2, sess);

  const row = D.revenueByStaff().find((r) => r.id === mgr);
  assert.equal(row.last_issued, "2026-09-09", "작업·세션 중 최신");
  assert.equal(row.supply, 300000, "전 기간 누적(작업 10만 + 세션 20만)");
});

// 2026-07-20: 업체·개인별 상세가 스탭별과 같은 내용(종류·곡/세션날짜)을 보여주려면 청구서마다
// '무슨 일이었는지'가 필요하다. 행 단위는 청구서 그대로 두므로(할인이 청구서 단위) 금액은 불변.
test("revenueForPayer: 청구서마다 work_kind·work_detail·item_count 파생(작업/세션)", () => {
  const payer = db().prepare("INSERT INTO parties (kind, name) VALUES ('company', ?)").run("일내용사").lastInsertRowid;
  const proj = db().prepare("INSERT INTO projects (title, project_type, rate) VALUES ('WP','task',0)").run().lastInsertRowid;

  // ① 작업 라인 1개(곡 제목)
  const tr = db().prepare("INSERT INTO project_tracks (project_id, title, content_type) VALUES (?, '곡가', 'Music')").run(proj).lastInsertRowid;
  const task = db().prepare("INSERT INTO track_tasks (track_id, task_type, billing_type, quantity, unit_price, total_price, status, is_invoiced) VALUES (?, 'Mixing','Fixed_Per_Track',1,100000,100000,'Completed',1)").run(tr).lastInsertRowid;
  const inv1 = db().prepare("INSERT INTO invoices (project_id,payer_id,title,amount,tax_amount,status,issued_date) VALUES (?,?,'W1',110000,10000,'발행','2026-07-16')").run(proj,payer).lastInsertRowid;
  db().prepare("INSERT INTO invoice_items (invoice_id, task_id, description, quantity, unit_price, amount, item_date) VALUES (?,?,'Mixing',1,100000,100000,'2026-07-16')").run(inv1,task);

  // ② 세션 라인 1개(세션 날짜)
  const sess = db().prepare("INSERT INTO sessions (project_id, session_type, session_date, status) VALUES (?, '녹음', '2026-07-15', '완료')").run(proj).lastInsertRowid;
  const inv2 = db().prepare("INSERT INTO invoices (project_id,payer_id,title,amount,tax_amount,status,issued_date) VALUES (?,?,'W2',220000,20000,'발행','2026-07-10')").run(proj,payer).lastInsertRowid;
  db().prepare("INSERT INTO invoice_items (invoice_id, session_id, description, quantity, unit_price, amount, item_date) VALUES (?,?,'녹음',1,200000,200000,'2026-07-15')").run(inv2,sess);

  // ③ 라인 2개(개수만 알린다)
  const tr2 = db().prepare("INSERT INTO project_tracks (project_id, title, content_type) VALUES (?, '곡나', 'Music')").run(proj).lastInsertRowid;
  const task2 = db().prepare("INSERT INTO track_tasks (track_id, task_type, billing_type, quantity, unit_price, total_price, status, is_invoiced) VALUES (?, 'Mixing','Fixed_Per_Track',1,50000,50000,'Completed',1)").run(tr2).lastInsertRowid;
  const task3 = db().prepare("INSERT INTO track_tasks (track_id, task_type, billing_type, quantity, unit_price, total_price, status, is_invoiced) VALUES (?, 'Mixing','Fixed_Per_Track',1,50000,50000,'Completed',1)").run(tr2).lastInsertRowid;
  const inv3 = db().prepare("INSERT INTO invoices (project_id,payer_id,title,amount,tax_amount,status,issued_date) VALUES (?,?,'W3',110000,10000,'발행','2026-07-05')").run(proj,payer).lastInsertRowid;
  db().prepare("INSERT INTO invoice_items (invoice_id, task_id, description, quantity, unit_price, amount, item_date) VALUES (?,?,'Mixing',1,50000,50000,'2026-07-05')").run(inv3,task2);
  db().prepare("INSERT INTO invoice_items (invoice_id, task_id, description, quantity, unit_price, amount, item_date) VALUES (?,?,'Mixing',1,50000,50000,'2026-07-06')").run(inv3,task3);

  const d = D.revenueForPayer(payer);
  const byId = new Map(d.invoices.map((r) => [r.id, r]));
  assert.equal(byId.get(inv1).work_kind, D.taskTypeLabel("Mixing"), "작업 = 작업 종류 라벨");
  assert.equal(byId.get(inv1).work_detail, "곡가", "작업 세부 = 곡 제목");
  assert.equal(byId.get(inv1).item_count, 1);
  assert.equal(byId.get(inv2).work_kind, "녹음", "세션 = 세션 종류");
  assert.equal(byId.get(inv2).work_detail, "2026-07-15", "세션 세부 = 세션 날짜(뷰가 '7월 15일'로 포맷)");
  assert.equal(byId.get(inv3).item_count, 2, "라인 개수");
  // 금액은 청구서 기준 그대로 — 행 단위를 안 바꿨으므로 총계 불변
  assert.equal(d.supply, 100000 + 200000 + 100000, "매출은 청구서 공급가 합(불변)");
});

test("revenueForPayer: 라인이 없는 청구서(수동 청구)는 종류·세부가 빈 값", () => {
  const payer = db().prepare("INSERT INTO parties (kind, name) VALUES ('company', ?)").run("수동청구사").lastInsertRowid;
  const inv = db().prepare("INSERT INTO invoices (project_id,payer_id,title,amount,tax_amount,status,issued_date) VALUES (NULL,?,'M',110000,10000,'발행','2026-07-01')").run(payer).lastInsertRowid;
  const d = D.revenueForPayer(payer);
  const row = d.invoices.find((r) => r.id === inv);
  assert.equal(row.work_kind, "");
  assert.equal(row.work_detail, "");
  assert.equal(row.item_count, 0);
});

// ── 미귀속(담당 없는 작업·세션) ───────────────────────────────────────────────
// 2026-07-20 실DB 점검에서 담당 엔지니어 없이 청구된 세션 2건(65만원)이 스탭별 화면 어디에도
// 안 뜨는 것을 발견 → 그 매출이 조용히 사라지지 않게 별도 집계로 드러낸다.
test("revenueUnattributed: 담당 없는 작업·세션을 모으고, 담당 있는 것은 제외", () => {
  const payer = db().prepare("INSERT INTO parties (kind, name) VALUES ('company','미귀속사')").run().lastInsertRowid;
  const proj = db().prepare("INSERT INTO projects (title, project_type, rate, artist) VALUES ('UP','task',0,'아티스트')").run().lastInsertRowid;
  const tr = db().prepare("INSERT INTO project_tracks (project_id, title, content_type) VALUES (?, '무담당곡','Music')").run(proj).lastInsertRowid;
  const mgr = db().prepare("INSERT INTO project_managers (name) VALUES ('있는담당')").run().lastInsertRowid;
  // ① 담당 없는 작업
  const taskNo = db().prepare("INSERT INTO track_tasks (track_id, task_type, billing_type, quantity, unit_price, total_price, status, is_invoiced, engineer_id, worker_rate) VALUES (?, 'Mixing','Fixed_Per_Track',1,70000,70000,'Completed',1,NULL,0)").run(tr).lastInsertRowid;
  // ② 담당 있는 작업(제외돼야 함)
  const taskYes = db().prepare("INSERT INTO track_tasks (track_id, task_type, billing_type, quantity, unit_price, total_price, status, is_invoiced, engineer_id, worker_rate) VALUES (?, 'Mixing','Fixed_Per_Track',1,50000,50000,'Completed',1,?,0)").run(tr, mgr).lastInsertRowid;
  // ③ engineer_name이 빈 세션
  const sessNo = db().prepare("INSERT INTO sessions (project_id, session_type, session_date, engineer_name, status) VALUES (?,'녹음','2026-09-03',NULL,'완료')").run(proj).lastInsertRowid;
  // ④ engineer_name이 있으나 담당자 마스터에 없는 이름(개명 드리프트 안전망)
  const sessGhost = db().prepare("INSERT INTO sessions (project_id, session_type, session_date, engineer_name, status) VALUES (?,'녹음','2026-09-04','사라진이름','완료')").run(proj).lastInsertRowid;
  // ⑤ 담당 있는 세션(제외돼야 함)
  const sessYes = db().prepare("INSERT INTO sessions (project_id, session_type, session_date, engineer_name, status) VALUES (?,'녹음','2026-09-05','있는담당','완료')").run(proj).lastInsertRowid;
  // 무할인 정합 청구서: amount = 라인 합(70000+50000+300000+200000+400000=1,020,000), VAT 0 → 공급가=라인 합.
  // (배분식이 i.amount를 읽으므로 실제 데이터처럼 amount가 라인 합과 맞아야 한다 — 옛 코드는 ii.amount만 봐 무관했음.)
  const inv = db().prepare("INSERT INTO invoices (project_id,payer_id,title,amount,tax_amount,status,issued_date) VALUES (?,?,'U',1020000,0,'발행','2026-09-10')").run(proj, payer).lastInsertRowid;
  const line = (col, id, amt) => db().prepare(`INSERT INTO invoice_items (invoice_id, ${col}, description, quantity, unit_price, amount) VALUES (?,?,'x',1,?,?)`).run(inv, id, amt, amt);
  line("task_id", taskNo, 70000);
  line("task_id", taskYes, 50000);
  line("session_id", sessNo, 300000);
  line("session_id", sessGhost, 200000);
  line("session_id", sessYes, 400000);

  const u = D.revenueUnattributed({ year: 2026, month: 9 });
  assert.equal(u.supply, 570000, "미귀속 = 70000(작업) + 300000 + 200000(세션)");
  assert.equal(u.task_cnt, 1, "담당 있는 작업은 제외");
  assert.equal(u.session_cnt, 2, "빈 이름 + 마스터에 없는 이름");
  assert.equal(u.last_issued, "2026-09-10");
  assert.ok(u.sessions.some((s) => s.id === sessGhost), "개명으로 끊긴 세션도 잡힌다");
  assert.ok(!u.sessions.some((s) => s.id === sessYes), "담당 있는 세션은 빠진다");
});

test("revenueUnattributed: 수동 청구서 라인(작업·세션 없음)은 대상 아님", () => {
  const payer = db().prepare("INSERT INTO parties (kind, name) VALUES ('company','수동미귀속사')").run().lastInsertRowid;
  const inv = db().prepare("INSERT INTO invoices (payer_id,title,amount,tax_amount,status,issued_date) VALUES (?,'M',110000,10000,'발행','2026-10-02')").run(payer).lastInsertRowid;
  db().prepare("INSERT INTO invoice_items (invoice_id, description, quantity, unit_price, amount) VALUES (?,'수동',1,100000,100000)").run(inv);
  const u = D.revenueUnattributed({ year: 2026, month: 10 });
  assert.equal(u.supply, 0, "일 기록이 없는 라인은 사람에 붙을 대상이 아니다(업체·개인별 탭이 제자리)");
});

test("revenueUnattributed + revenueByStaff 합 = 일 라인 귀속 공급가 총합(누락 없음)", () => {
  const per = { year: 2026, month: 9 };
  const staffSum = D.revenueByStaff(per).reduce((a, r) => a + r.supply, 0);
  // 2026-09 픽스처는 무할인이라 귀속 공급가 = 라인 원금(ii.amount)과 같다.
  // 배분식과 같은 값을 SQL로도 계산해 대조(할인이 들어와도 항등식이 유지되도록 배분 기준으로 잠금).
  const lineSum = db().prepare(`SELECT COALESCE(SUM(ROUND(ii.amount*1.0*(i.amount-i.tax_amount)/NULLIF(ilt.line_total,0))),0) s
      FROM invoice_items ii JOIN invoices i ON i.id=ii.invoice_id
      JOIN (SELECT invoice_id, SUM(amount) AS line_total FROM invoice_items GROUP BY invoice_id) ilt ON ilt.invoice_id=ii.invoice_id
      WHERE i.status<>'미발행' AND substr(i.issued_date,1,7)='2026-09' AND (ii.task_id IS NOT NULL OR ii.session_id IS NOT NULL)`).get().s;
  assert.equal(staffSum + D.revenueUnattributed(per).supply, lineSum, "스탭 합 + 미귀속 = 일 라인 귀속 공급가 총합");
});

// ── 청구서 할인의 라인 배분(2026-07-23 기능성 평가 — 스탭 축 과대 수정) ──
// 스탭·종류·미귀속 축이 라인 원금(ii.amount)을 쓰면, 청구서 단위 할인 시 라인 합 > 실매출이라
// 스탭별 매출이 부풀었다(사례 +33%). → 할인을 금액 비례로 라인에 배분해 청구처 축·개요와 일치시킨다.
test("revenueByStaff: 다라인 할인 청구서를 금액 비례로 배분 — 스탭 합 = 청구서 공급가", () => {
  // 엔지니어 2명 + 한 청구서에 각자 라인(원금 30만·10만, 합 40만) + 청구서 할인 8만 → 공급가 32만.
  const uA = db().prepare("INSERT INTO users (email, role, name) VALUES ('disc-a@test.com','staff','할인A')").run().lastInsertRowid;
  const uB = db().prepare("INSERT INTO users (email, role, name) VALUES ('disc-b@test.com','staff','할인B')").run().lastInsertRowid;
  const mA = db().prepare("INSERT INTO project_managers (name, active, user_id) VALUES ('할인A',1,?)").run(uA).lastInsertRowid;
  const mB = db().prepare("INSERT INTO project_managers (name, active, user_id) VALUES ('할인B',1,?)").run(uB).lastInsertRowid;
  const payer = db().prepare("INSERT INTO parties (kind, name) VALUES ('company','할인청구사')").run().lastInsertRowid;
  const proj = db().prepare("INSERT INTO projects (title, project_type, rate) VALUES ('DP','task',0)").run().lastInsertRowid;
  const tr = db().prepare("INSERT INTO project_tracks (project_id, title, content_type) VALUES (?, '곡','Music')").run(proj).lastInsertRowid;
  const tA = db().prepare("INSERT INTO track_tasks (track_id, task_type, billing_type, quantity, unit_price, total_price, status, is_invoiced, engineer_id, worker_rate) VALUES (?, 'Mixing','Fixed_Per_Track',1,300000,300000,'Completed',1,?,0)").run(tr, mA).lastInsertRowid;
  const tB = db().prepare("INSERT INTO track_tasks (track_id, task_type, billing_type, quantity, unit_price, total_price, status, is_invoiced, engineer_id, worker_rate) VALUES (?, 'Vocal_Tuning','Fixed_Per_Track',1,100000,100000,'Completed',1,?,0)").run(tr, mB).lastInsertRowid;
  // 라인 합 40만, 할인 8만 → 과세표준 32만, VAT 3.2만, amount 35.2만. 공급가(amount−tax)=32만.
  const inv = db().prepare("INSERT INTO invoices (project_id, payer_id, title, amount, tax_amount, discount_amount, status, issued_date) VALUES (?,?,'DT',352000,32000,80000,'발행','2027-03-10')").run(proj, payer).lastInsertRowid;
  db().prepare("INSERT INTO invoice_items (invoice_id, task_id, description, quantity, unit_price, amount) VALUES (?,?,'Mixing',1,300000,300000)").run(inv, tA);
  db().prepare("INSERT INTO invoice_items (invoice_id, task_id, description, quantity, unit_price, amount) VALUES (?,?,'Vocal_Tuning',1,100000,100000)").run(inv, tB);

  const rows = D.revenueByStaff({ year: 2027, month: 3 });
  const a = rows.find((r) => r.id === mA), b = rows.find((r) => r.id === mB);
  assert.equal(a.supply, 240000, "할인A = 30만 × 32만/40만 = 24만(라인 원금 30만이 아니라)");
  assert.equal(b.supply, 80000, "할인B = 10만 × 32만/40만 = 8만");
  assert.equal(a.supply + b.supply, 320000, "스탭 합 = 청구서 공급가(할인 반영) — 개요·청구처 축과 일치");

  // 개요 KPI(청구처 축과 같은 i.amount−i.tax_amount)와도 일치
  const summary = D.revenueSummary({ year: 2027, month: 3 });
  assert.equal(summary.periodSupply, 320000, "개요 공급가도 32만");
});

test("revenueForStaff: 상세 라인 금액도 할인 반영(행 합 = 소계 = 총계)", () => {
  const u = db().prepare("INSERT INTO users (email, role, name) VALUES ('disc-detail@test.com','staff','할인상세')").run().lastInsertRowid;
  const m = db().prepare("INSERT INTO project_managers (name, active, user_id) VALUES ('할인상세',1,?)").run(u).lastInsertRowid;
  const payer = db().prepare("INSERT INTO parties (kind, name) VALUES ('company','할인상세사')").run().lastInsertRowid;
  const proj = db().prepare("INSERT INTO projects (title, project_type, artist, rate) VALUES ('DDP','task','루나',0)").run().lastInsertRowid;
  const tr = db().prepare("INSERT INTO project_tracks (project_id, title, content_type) VALUES (?, '곡','Music')").run(proj).lastInsertRowid;
  // 이 사람 라인 30만 + 다른(담당 없는) 라인 10만, 할인 8만 → 공급가 32만. 이 사람 몫 = 30만×32/40 = 24만.
  const tMine = db().prepare("INSERT INTO track_tasks (track_id, task_type, billing_type, quantity, unit_price, total_price, status, is_invoiced, engineer_id, worker_rate) VALUES (?, 'Mixing','Fixed_Per_Track',1,300000,300000,'Completed',1,?,60000)").run(tr, m).lastInsertRowid;
  const tOther = db().prepare("INSERT INTO track_tasks (track_id, task_type, billing_type, quantity, unit_price, total_price, status, is_invoiced, engineer_id, worker_rate) VALUES (?, 'Vocal_Tuning','Fixed_Per_Track',1,100000,100000,'Completed',1,NULL,0)").run(tr).lastInsertRowid;
  const inv = db().prepare("INSERT INTO invoices (project_id, payer_id, title, amount, tax_amount, discount_amount, status, issued_date) VALUES (?,?,'DDT',352000,32000,80000,'발행','2027-04-10')").run(proj, payer).lastInsertRowid;
  db().prepare("INSERT INTO invoice_items (invoice_id, task_id, description, quantity, unit_price, amount) VALUES (?,?,'Mixing',1,300000,300000)").run(inv, tMine);
  db().prepare("INSERT INTO invoice_items (invoice_id, task_id, description, quantity, unit_price, amount) VALUES (?,?,'Vocal_Tuning',1,100000,100000)").run(inv, tOther);

  const d = D.revenueForStaff(m, { year: 2027, month: 4 });
  assert.equal(d.tasks.length, 1, "이 사람 라인만");
  assert.equal(d.tasks[0].amount, 240000, "행 금액도 할인 반영(30만×32/40=24만)");
  assert.equal(d.supply, 240000, "상세 공급가 = 행 합");

  // 담당 없는 라인은 미귀속으로 — 이것도 할인 반영(10만×32/40=8만)
  const un = D.revenueUnattributed({ year: 2027, month: 4 });
  assert.equal(un.tasks.find((t) => t.id === tOther).amount, 80000, "미귀속 라인도 배분");
});
