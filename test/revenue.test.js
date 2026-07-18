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
