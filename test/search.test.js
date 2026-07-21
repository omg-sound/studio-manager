"use strict";

// ── 전역 통합 검색 회귀 잠금(2026-07-21) ──
// searchAll이 5개 카테고리를 교차 매칭하고, searchInvoices가 번호·제목·청구처로 매칭하는지.
// 스펙: docs/superpowers/specs/2026-07-21-global-search-design.md.
process.env.NODE_ENV = "test";
const { tempDbPath, cleanupDb } = require("./helpers");
process.env.DB_PATH = tempDbPath();
const test = require("node:test");
const assert = require("node:assert");
const { db, init } = require("../src/db");
init();
test.after(() => cleanupDb(process.env.DB_PATH, db()));
const D = require("../src/data");

const K = "제브라"; // 충돌 없는 고유 키워드
const user = { id: 1, role: "chief" };

// 5개 엔티티에 키워드를 심는다.
const company = db().prepare("INSERT INTO parties (kind, name) VALUES ('company', ?)").run(`${K}엔터`).lastInsertRowid;
const person = db().prepare("INSERT INTO parties (kind, name, phone, is_artist) VALUES ('person', ?, '010-1234-5678', 1)").run(`${K}킴`).lastInsertRowid;
const proj = db().prepare("INSERT INTO projects (title, project_type, artist, rate) VALUES (?, 'session', ?, 0)").run(`${K} 프로젝트`, `${K}킴`).lastInsertRowid;
db().prepare("INSERT INTO sessions (project_id, session_type, session_date, engineer_name, status) VALUES (?, '녹음', '2026-08-01', '엔지', '예정')").run(proj);
const inv = db().prepare("INSERT INTO invoices (project_id, payer_id, title, invoice_number, amount, tax_amount, status, tax_status, issued_date) VALUES (?, ?, ?, 'OMG-202608-777', 110000, 10000, '발행', '계산서 발행', '2026-08-01')").run(proj, company, `${K} 작업비`).lastInsertRowid;

test("searchAll: 5개 카테고리 고정 순서로 반환", () => {
  const groups = D.searchAll(user, K, 5);
  assert.deepEqual(groups.map((g) => g.key), ["projects", "contacts", "clients", "invoices", "sessions"]);
  assert.deepEqual(groups.map((g) => g.cat), ["프로젝트", "연락처", "업체·그룹", "청구", "세션"]);
});

test("searchAll: 키워드가 5개 카테고리 전부에서 매칭", () => {
  const g = Object.fromEntries(D.searchAll(user, K, 5).map((x) => [x.key, x.rows]));
  assert.ok(g.projects.some((p) => p.id === proj), "프로젝트 매칭");
  assert.ok(g.contacts.some((c) => c.id === person), "연락처(사람) 매칭");
  assert.ok(g.clients.some((c) => c.id === company), "업체 매칭");
  assert.ok(g.invoices.some((i) => i.id === inv), "청구 매칭");
  assert.ok(g.sessions.some((s) => s.project_id === proj), "세션 매칭(프로젝트 제목 경유)");
});

test("searchAll: 빈 q는 빈 배열, 카테고리별 perCat 상한", () => {
  assert.deepEqual(D.searchAll(user, "", 5), []);
  assert.deepEqual(D.searchAll(user, "  ", 5), []);
  // perCat=1이면 각 카테고리 최대 1건
  for (const grp of D.searchAll(user, K, 1)) assert.ok(grp.rows.length <= 1, `${grp.key} perCat 상한`);
});

test("searchInvoices: 청구번호·제목·청구처명으로 매칭", () => {
  assert.ok(D.searchInvoices(user, "OMG-202608-777").some((i) => i.id === inv), "번호 매칭");
  assert.ok(D.searchInvoices(user, `${K} 작업비`).some((i) => i.id === inv), "제목 매칭");
  assert.ok(D.searchInvoices(user, `${K}엔터`).some((i) => i.id === inv), "청구처명 매칭");
  assert.deepEqual(D.searchInvoices(user, ""), [], "빈 q");
  assert.deepEqual(D.searchInvoices(user, "존재하지않는키워드zzz"), [], "무매칭");
});

test("searchAll: 무관한 키워드는 전 카테고리 0건", () => {
  const total = D.searchAll(user, "존재하지않는키워드zzz", 5).reduce((n, g) => n + g.rows.length, 0);
  assert.equal(total, 0);
});
