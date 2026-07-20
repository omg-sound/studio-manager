"use strict";

// ── 격리 DB 셋업(다른 테스트와 동일 패턴) ──
process.env.NODE_ENV = "test";
const { tempDbPath, cleanupDb } = require("./helpers");
process.env.DB_PATH = tempDbPath();

const test = require("node:test");
const assert = require("node:assert");

const { db, init, encrypt, decrypt } = require("../src/db");
const { listSessionsForWorker, getWorkerFile, upsertWorkerFile, deleteWorkerFile, listWorkerFiles } = require("../src/data");

init();

test.after(() => cleanupDb(process.env.DB_PATH, db()));

function seedWorker(name) {
  return Number(db().prepare("INSERT INTO project_managers (name, active) VALUES (?, 1)").run(name).lastInsertRowid);
}
function seedProjectAndSession(workerId, { viaJoinTable, engineerName } = {}) {
  const pj = db().prepare("INSERT INTO projects (title, project_type, rate) VALUES ('세션참여테스트', 'task', 0)").run();
  const projectId = Number(pj.lastInsertRowid);
  const s = db()
    .prepare(
      `INSERT INTO sessions (project_id, session_type, session_date, start_time, end_time, status, engineer_name)
       VALUES (?, '녹음', '2026-07-06', '10:00', '12:00', '완료', ?)`
    )
    .run(projectId, engineerName || null);
  const sessionId = Number(s.lastInsertRowid);
  if (viaJoinTable) db().prepare("INSERT INTO session_engineers (session_id, manager_id) VALUES (?, ?)").run(sessionId, workerId);
  return { projectId, sessionId };
}

// ── 외주 작업자 세션 참여(2026-07-06 사용자 리포트: 작업만 뜨고 세션 참여가 안 뜸) ──
test("listSessionsForWorker: session_engineers 다대다 매칭 + 레거시 engineer_name 폴백, 중복 없음", () => {
  const w = seedWorker("세션엔지니어");
  seedProjectAndSession(w, { viaJoinTable: true });
  const rows = listSessionsForWorker({ id: w, name: "세션엔지니어" });
  assert.strictEqual(rows.length, 1, "session_engineers 매칭으로 1건 노출");

  // 레거시 폴백: join 테이블에 없지만 engineer_name이 일치하는 경우도 노출.
  const w2 = seedWorker("레거시엔지니어");
  seedProjectAndSession(w2, { viaJoinTable: false, engineerName: "레거시엔지니어" });
  const rows2 = listSessionsForWorker({ id: w2, name: "레거시엔지니어" });
  assert.strictEqual(rows2.length, 1, "레거시 engineer_name 폴백으로도 노출");

  // 두 조건 모두 매칭돼도 DISTINCT로 중복 없음.
  const w3 = seedWorker("양쪽매칭");
  const { sessionId } = seedProjectAndSession(w3, { viaJoinTable: true, engineerName: "양쪽매칭" });
  const rows3 = listSessionsForWorker({ id: w3, name: "양쪽매칭" });
  assert.strictEqual(rows3.filter((r) => r.id === sessionId).length, 1, "join+engineer_name 둘 다 일치해도 중복 없음");
});

test("listSessionsForWorker: 담당 없는 세션은 노출 안 됨", () => {
  const w = seedWorker("무관계작업자");
  const rows = listSessionsForWorker({ id: w, name: "무관계작업자" });
  assert.strictEqual(rows.length, 0);
});

// ── 외주 작업자 첨부 서류(주민등록증 사본·통장사본, 2026-07-06 사용자 요청) ──
test("worker-files: upsert(교체)·조회·삭제 사이클", () => {
  const w = seedWorker("첨부테스트");
  assert.strictEqual(getWorkerFile(w, "id_card"), null);

  const first = upsertWorkerFile(w, "id_card", { storage_backend: "local", file_id: "f1", file_name: "id1.png", mime_type: "image/png", file_size: 100 });
  assert.strictEqual(first, null, "최초 삽입은 기존 파일 없음(null) 반환");
  assert.strictEqual(getWorkerFile(w, "id_card").file_name, "id1.png");

  const replaced = upsertWorkerFile(w, "id_card", { storage_backend: "local", file_id: "f2", file_name: "id2.png", mime_type: "image/png", file_size: 200 });
  assert.strictEqual(replaced.file_id, "f1", "교체 시 이전 파일 정보 반환(호출부가 storage.remove 하도록)");
  assert.strictEqual(getWorkerFile(w, "id_card").file_id, "f2");

  upsertWorkerFile(w, "bankbook", { storage_backend: "local", file_id: "f3", file_name: "bank.pdf", mime_type: "application/pdf", file_size: 300 });
  assert.strictEqual(listWorkerFiles(w).length, 2, "종류별 독립 저장");

  const deleted = deleteWorkerFile(w, "id_card");
  assert.strictEqual(deleted.file_id, "f2");
  assert.strictEqual(getWorkerFile(w, "id_card"), null);
  assert.strictEqual(listWorkerFiles(w).length, 1, "삭제 후 통장사본만 남음");
});

test("worker-files: 작업자 삭제 시 첨부도 CASCADE 삭제", () => {
  const w = seedWorker("캐스케이드테스트");
  upsertWorkerFile(w, "id_card", { storage_backend: "local", file_id: "fc1", file_name: "x.png", mime_type: "image/png", file_size: 10 });
  db().prepare("DELETE FROM project_managers WHERE id = ?").run(w);
  assert.strictEqual(getWorkerFile(w, "id_card"), null, "작업자 삭제 시 첨부 기록도 함께 삭제(CASCADE)");
});

// ── 외주 작업자 정산 정보(주민등록번호/사업자등록번호·계좌) 암호화 저장(2026-07-06 사용자 요청) ──
test("project_managers: id_number·account_number는 db.encrypt로 저장 → decrypt 시 원문 복원, DB 원본은 평문 아님", () => {
  const w = seedWorker("암호화테스트");
  const rawId = "900101-1234567";
  const rawAcct = "110-234-567890";
  db()
    .prepare("UPDATE project_managers SET id_number=?, account_number=?, bank_name=?, account_holder=? WHERE id=?")
    .run(encrypt(rawId), encrypt(rawAcct), "국민은행", "홍길동", w);

  const row = db().prepare("SELECT * FROM project_managers WHERE id = ?").get(w);
  assert.notStrictEqual(row.id_number, rawId, "DB에는 암호문만 저장(평문 아님)");
  assert.notStrictEqual(row.account_number, rawAcct);
  assert.strictEqual(decrypt(row.id_number), rawId, "decrypt로 원문 복원");
  assert.strictEqual(decrypt(row.account_number), rawAcct);
  assert.strictEqual(row.bank_name, "국민은행", "은행명·예금주는 평문(민감도 낮음)");
  assert.strictEqual(row.account_holder, "홍길동");
});

// ── 정산 요약(2026-07-20 마스터-디테일 전환) ────────────────────────────────────────────
// 목록 왼쪽 행과 오른쪽 정산 카드가 같은 값을 쓰므로, 계산은 여기서 한 번만 잠근다.
const { workerPayoutSummary } = require("../src/data");
const { workerNameList, workerPayoutCard, monthDot } = require("../src/views.workers");

function seedTask(workerId, { rate, paid, paidDate } = {}) {
  const pj = Number(db().prepare("INSERT INTO projects (title, project_type, rate) VALUES ('정산요약', 'task', 0)").run().lastInsertRowid);
  const tr = Number(db().prepare("INSERT INTO project_tracks (project_id, title) VALUES (?, '곡')").run(pj).lastInsertRowid);
  return Number(db().prepare(
    `INSERT INTO track_tasks (track_id, task_type, billing_type, quantity, unit_price, total_price, engineer_id, worker_rate, worker_paid, worker_paid_date, status)
     VALUES (?, 'mixing', 'Fixed_Per_Track', 1, 0, 0, ?, ?, ?, ?, 'Completed')`
  ).run(tr, workerId, rate || 0, paid ? 1 : 0, paidDate || null).lastInsertRowid);
}

test("workerPayoutSummary: 미지급 합계·건수 / 누적 지급 / 최근 지급월", () => {
  const id = seedWorker("정산요약대상");
  const w = db().prepare("SELECT * FROM project_managers WHERE id = ?").get(id);
  seedTask(id, { rate: 300000 });                                     // 미지급
  seedTask(id, { rate: 200000 });                                     // 미지급
  seedTask(id, { rate: 500000, paid: true, paidDate: "2026-06-15" }); // 지급
  seedTask(id, { rate: 100000, paid: true, paidDate: "2026-05-02" }); // 지급(더 이전)
  const s = workerPayoutSummary(w);
  assert.equal(s.unpaidAmt, 500000);
  assert.equal(s.unpaidCount, 2);
  assert.equal(s.paidTotal, 600000, "누적 지급 = 지급완료분 합");
  assert.equal(s.lastPaidMonth, "2026-06", "최근 지급월 = 가장 최신 지급일의 YYYY-MM");
});

test("workerPayoutSummary: 0원(단가 미입력)도 미지급 건수에 든다(2026-07-09 결정)", () => {
  const id = seedWorker("영원단가");
  const w = db().prepare("SELECT * FROM project_managers WHERE id = ?").get(id);
  seedTask(id, { rate: 0 });
  const s = workerPayoutSummary(w);
  assert.equal(s.unpaidCount, 1, "금액이 0이어도 정산해야 할 건");
  assert.equal(s.unpaidAmt, 0);
});

test("workerPayoutSummary: 계좌·서류는 '등록 여부'만(번호는 담지 않는다)", () => {
  const id = seedWorker("계좌보유자");
  db().prepare("UPDATE project_managers SET bank_name='국민', account_number=? WHERE id=?").run(encrypt("110-1234"), id);
  const w = db().prepare("SELECT * FROM project_managers WHERE id = ?").get(id);
  const s = workerPayoutSummary(w);
  assert.equal(s.hasAccount, true);
  assert.equal(s.hasFiles, false, "첨부 없음");
  // 요약 객체에 계좌번호 원문/암호문이 실려 나가지 않는다(목록·카드로 번호가 새지 않게).
  assert.ok(!JSON.stringify(s).includes("110-1234"));
  assert.ok(!Object.prototype.hasOwnProperty.call(s, "account_number"));
});

test("workerPayoutSummary: 은행만 있고 계좌번호가 없으면 이체 준비 안 됨", () => {
  const id = seedWorker("은행만");
  db().prepare("UPDATE project_managers SET bank_name='국민' WHERE id=?").run(id);
  const w = db().prepare("SELECT * FROM project_managers WHERE id = ?").get(id);
  assert.equal(workerPayoutSummary(w).hasAccount, false);
});

// ── 왼쪽 목록·정산 카드 렌더 계약 ──────────────────────────────────────────────────────
const SUM = { unpaidAmt: 800000, unpaidCount: 2, paidTotal: 1500000, lastPaidMonth: "2026-06", taskCnt: 3, sessionCnt: 1, hasAccount: true, hasFiles: false, items: [] };
const W = { id: 7, name: "믹스 담당", phone: "010-1234-5678", active: 1 };

test("workerNameList: 한 줄에 이름·연락처·미지급(이름만 있던 옛 목록 대체)", () => {
  const html = workerNameList({ rows: [{ worker: W, summary: SUM }], selectedId: 7, hrefFn: (w) => `/workers/${w.id}` });
  assert.match(html, /data-nav-list="workers"/, "키보드 이동·스크롤 보존 키");
  assert.match(html, /믹스 담당/);
  assert.match(html, /010-1234-5678/);
  assert.match(html, /₩800,000/, "미지급 금액");
  assert.match(html, /미지급 2건/);
  assert.match(html, /aria-current="true"/, "선택 행 표시");
});

test("workerNameList: 계좌 미등록이면 목록에서 바로 경고(지급을 막는 조건)", () => {
  const noAcct = workerNameList({ rows: [{ worker: W, summary: { ...SUM, hasAccount: false } }], hrefFn: () => "/x" });
  assert.match(noAcct, /계좌 미등록/);
  const ok = workerNameList({ rows: [{ worker: W, summary: SUM }], hrefFn: () => "/x" });
  assert.ok(!/계좌 미등록/.test(ok), "등록돼 있으면 조용히");
});

test("workerNameList: 미지급 0이면 금액 칸을 비운다('₩0'을 매번 보여주지 않는다)", () => {
  const html = workerNameList({ rows: [{ worker: W, summary: { ...SUM, unpaidAmt: 0, unpaidCount: 0 } }], hrefFn: () => "/x" });
  assert.ok(!/미지급 0건/.test(html));
});

test("workerPayoutCard: 미지급·실지급·이체 준비·누적/최근/참여", () => {
  const html = workerPayoutCard({ worker: W, summary: SUM, canPay: true });
  assert.match(html, /₩800,000/, "미지급 헤드라인");
  assert.match(html, /원천세 3\.3%/);
  assert.match(html, /₩773,600/, "실지급(800,000 − 26,400)");
  assert.match(html, /✓ 계좌/);
  assert.match(html, /⚠ 서류/);
  assert.match(html, /₩1,500,000/, "누적 지급");
  assert.match(html, /2026\.6/, "최근 지급월");
  assert.match(html, /작업 3 · 세션 1/);
  assert.match(html, /action="\/workers\/7\/payout-all"/, "일괄 지급");
  assert.match(html, /name="return" value="detail"/, "지급 후 상세로 복귀(라우트 계약)");
});

test("workerPayoutCard: 미지급이 없으면 '없음' + 지급 버튼도 없다", () => {
  const html = workerPayoutCard({ worker: W, summary: { ...SUM, unpaidAmt: 0, unpaidCount: 0 }, canPay: true });
  assert.match(html, /없음/);
  assert.ok(!/payout-all/.test(html), "지급할 게 없으면 버튼도 없다");
});

test("workerPayoutCard: 권한 없으면(canPay=false) 지급 버튼 없음", () => {
  assert.ok(!/payout-all/.test(workerPayoutCard({ worker: W, summary: SUM, canPay: false })));
});

test("monthDot: 2026-06 → 2026.6, 빈 값은 빈 문자열", () => {
  assert.equal(monthDot("2026-06"), "2026.6");
  assert.equal(monthDot(""), "");
});
