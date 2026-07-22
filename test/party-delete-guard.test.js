"use strict";

// ── 격리 DB 셋업: src/* require 이전에 환경변수부터 설정 ──
process.env.NODE_ENV = "test";
const { tempDbPath, cleanupDb } = require("./helpers");
process.env.DB_PATH = tempDbPath();

const test = require("node:test");
const assert = require("node:assert");

const { db, init } = require("../src/db");
const { createInvoiceFromTasks, createCompany, createPerson, partyHasIssuedInvoice, deleteParty, getParty } = require("../src/data");

init();

/**
 * 당사자(사람) 삭제 가드 — 2026-07-23 기능성 평가.
 *
 * `deleteParty`가 `invoices.payer_id`를 NULL로 만드는데, `/clients` 삭제는 발행 청구 가드로 막지만
 * **`/contacts` 삭제와 구글→앱 pull(meta.deleted)은 무방비**였다. 개인 청구처(현금영수증 발행 대상)를
 * 연락처에서 지우면 그 사람 기준 미수 추적(listInvoicesForParty)이 끊기고, payer_kind 소실로
 * taxDocOf가 현금영수증 건을 '계산서'로 오표시한다.
 * → 세 곳이 공유하는 판정 헬퍼 `partyHasIssuedInvoice(id)`로 일원화.
 */

const CHIEF = { id: 1, role: "chief", email: "chief@omg.test" };

let seq = 0;
/** 이 사람을 청구처로 하는 발행 청구서 1건. */
function seedIssuedInvoiceFor(payerId) {
  seq += 1;
  const pj = db().prepare("INSERT INTO projects (title, project_type, rate) VALUES (?, 'task', 0)").run(`발행가드${seq}`);
  const projectId = Number(pj.lastInsertRowid);
  const tr = db().prepare("INSERT INTO project_tracks (project_id, title, content_type) VALUES (?, '곡', 'Music')").run(projectId);
  const tk = db()
    .prepare(`INSERT INTO track_tasks (track_id, task_type, billing_type, quantity, unit_price, total_price, status, is_invoiced)
       VALUES (?, 'Mixing', 'Fixed_Per_Track', 1, 500000, 500000, 'Completed', 0)`)
    .run(Number(tr.lastInsertRowid));
  return createInvoiceFromTasks(CHIEF, { projectId, clientId: payerId, taskIds: [Number(tk.lastInsertRowid)], issueDate: "2026-06-15" });
}

test.after(() => cleanupDb(process.env.DB_PATH, db()));

// ── 판정 헬퍼 ──

test("partyHasIssuedInvoice: 발행 청구서의 청구처면 true, 삭제 후 false", () => {
  const co = createCompany({ name: "청구처회사", biz_no: "999-88-77777" });
  assert.strictEqual(partyHasIssuedInvoice(co), false, "청구서 없으면 false");

  const inv = seedIssuedInvoiceFor(co);
  assert.strictEqual(partyHasIssuedInvoice(co), true, "createInvoiceFromTasks는 status='발행' → 즉시 가드 대상");

  const { deleteInvoice } = require("../src/data");
  deleteInvoice(CHIEF, inv.id);
  assert.strictEqual(partyHasIssuedInvoice(co), false, "청구서 삭제(정정) 후엔 보존할 이유가 없다");
});

test("partyHasIssuedInvoice: 개인 청구처(현금영수증 발행 대상)도 동일하게 보호", () => {
  // 이 경로가 이번 수정의 핵심 동기 — 연락처에서 개인 청구처를 지우면 payer_kind 소실로
  // taxDocOf가 현금영수증 건을 '계산서'로 오표시한다.
  const person = createPerson({ name: "개인청구처", cash_receipt_no: "010-1234-5678" });
  seedIssuedInvoiceFor(person);
  assert.strictEqual(partyHasIssuedInvoice(person), true, "개인 청구처도 발행 청구가 있으면 보존");
});

test("partyHasIssuedInvoice: 계산서 발행·입금완료도 가드 대상(status 무관 tax_status)", () => {
  const co = createCompany({ name: "계산서회사", biz_no: "111-22-33333" });
  const inv = seedIssuedInvoiceFor(co);
  const person = co;
  // 발행 상태를 인위로 미발행으로 낮춰도 tax_status가 진행됐으면 보존
  db().prepare("UPDATE invoices SET status='미발행', tax_status='계산서 발행' WHERE id=?").run(inv.id);
  assert.strictEqual(partyHasIssuedInvoice(person), true, "계산서가 나갔으면 청구처 보존");

  db().prepare("UPDATE invoices SET tax_status='입금완료' WHERE id=?").run(inv.id);
  assert.strictEqual(partyHasIssuedInvoice(person), true, "입금완료도 보존");

  db().prepare("UPDATE invoices SET tax_status='계산서 미발행' WHERE id=?").run(inv.id);
  assert.strictEqual(partyHasIssuedInvoice(person), false, "미발행·미입금(계산서 미발행)은 정정 삭제 허용");
});

test("partyHasIssuedInvoice: /clients 라우트의 인라인 판정과 같은 결과(같은 SQL 공유 확인)", () => {
  const person = createCompany({ name: "동일판정회사", biz_no: "222-33-44444" });
  const inv = seedIssuedInvoiceFor(person);
  db().prepare("UPDATE invoices SET status='미발행', tax_status='계산서 발행' WHERE id=?").run(inv.id);
  // clients.routes.js가 쓰던 원래 조건과 동일해야 한다
  const legacy = db().prepare("SELECT 1 FROM invoices WHERE payer_id=? AND (status='발행' OR tax_status IN ('계산서 발행','입금완료')) LIMIT 1").get(person);
  assert.strictEqual(partyHasIssuedInvoice(person), Boolean(legacy), "헬퍼가 기존 인라인 가드를 그대로 대체");
});

// ── 세 삭제 경로가 모두 이 헬퍼를 부르는지(소스 계약) ──
// 판정이 헬퍼로 일원화된 뒤, 어느 한 곳이 헬퍼 호출을 빠뜨리면 그 문으로 들어온 삭제만 무방비가 된다.
// 실제 라우트 실행(권한·세션) 대신 소스에서 계약을 확인 — 라우트↔헬퍼 드리프트를 CI가 잡는다.
const fs = require("fs");
const path = require("path");
const read = (rel) => fs.readFileSync(path.join(__dirname, "..", rel), "utf8");

test("삭제 경로 계약: clients·contacts·people 모두 partyHasIssuedInvoice로 판정", () => {
  const clients = read("src/routes/clients.routes.js");
  const contacts = read("src/routes/contacts.routes.js");
  const people = read("src/people.js");

  assert.match(clients, /partyHasIssuedInvoice\(id\)/, "clients 삭제 라우트가 헬퍼로 판정");
  assert.match(contacts, /partyHasIssuedInvoice\(id\)/, "contacts 삭제 라우트가 헬퍼로 판정");
  assert.match(people, /partyHasIssuedInvoice\(existing\.id\)/, "구글 pull(meta.deleted)이 헬퍼로 판정");

  // 인라인 SQL 판정이 되살아나지 않았는지(헬퍼로 통일된 뒤 라우트에 직접 쿼리가 있으면 드리프트)
  for (const [name, src] of [["clients", clients], ["contacts", contacts], ["people", people]]) {
    assert.doesNotMatch(src, /status\s*=\s*'발행'\s+OR\s+tax_status/, `${name}에 인라인 청구처 판정이 남으면 안 된다(헬퍼 우회)`);
  }
});

test("삭제 경로 계약: people pull은 청구처 보존을 별도로 집계(조용히 건너뛰지 않게)", () => {
  const people = read("src/people.js");
  assert.match(people, /keptWithInvoice/, "보존한 건수를 세어 반환 — '삭제 0'과 '보존해서 안 지움'을 구분");
});
