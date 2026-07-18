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
  db().prepare("INSERT INTO invoice_items (invoice_id, task_id, description, quantity, unit_price, amount) VALUES (?, ?, 'Mixing', 1, 100000, 100000)").run(inv, task);
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

test("revenueYears: 발행 청구서가 있는 년 내림차순", () => {
  const ys = D.revenueYears();
  assert.ok(ys.includes(2026), "2026 포함");
  for (let k = 1; k < ys.length; k++) assert.ok(ys[k - 1] >= ys[k], "내림차순");
});
