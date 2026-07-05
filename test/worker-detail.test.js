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
