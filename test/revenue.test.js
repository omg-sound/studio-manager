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
