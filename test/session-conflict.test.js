"use strict";

// ── 격리 DB 셋업: src/* require 이전에 환경변수부터 설정 ──
process.env.NODE_ENV = "test";
const { tempDbPath, cleanupDb } = require("./helpers");
process.env.DB_PATH = tempDbPath();

const test = require("node:test");
const assert = require("node:assert");

const { db, init } = require("../src/db");
// findSessionConflict 는 미export → 실제 소비자 createSession/updateSession 으로 검증.
// 충돌 시 createSession 이 Error('SESSION_TIME_CONFLICT')(err.conflict=상대 행)를 throw,
// 충돌 없으면 세션 행을 반환한다(= findSessionConflict null 경로).
const { createSession, updateSession } = require("../src/data");

init();

const CHIEF = { id: 1, role: "chief", email: "chief@omg.test" };

// 룸 2개 + 프로젝트 1개 시드(테스트 간 날짜를 분리해 상호 간섭 방지).
const roomA = Number(db().prepare("INSERT INTO rooms (name, active) VALUES ('룸 A', 1)").run().lastInsertRowid);
const roomB = Number(db().prepare("INSERT INTO rooms (name, active) VALUES ('룸 B', 1)").run().lastInsertRowid);
const projectId = Number(
  db().prepare("INSERT INTO projects (title, project_type, rate) VALUES ('세션 테스트', 'session', 0)").run().lastInsertRowid
);

/** createSession 래퍼 — 명시 start/end(duration_mode 미사용 → end_time 그대로). */
function create({ room, type = "녹음", start, end, date, status = "예정" }) {
  return createSession(CHIEF, projectId, {
    session_type: type,
    session_date: date,
    start_time: start,
    end_time: end,
    room_id: room,
    status,
  });
}

/** 충돌 throw 단언 + 상대 행 반환. */
function expectConflict(fn) {
  let thrown = null;
  try {
    fn();
  } catch (e) {
    thrown = e;
  }
  assert.ok(thrown, "충돌이 발생해야 한다(throw)");
  assert.strictEqual(thrown.message, "SESSION_TIME_CONFLICT");
  assert.ok(thrown.conflict && thrown.conflict.id, "err.conflict 에 상대 세션 행이 붙어야 한다");
  return thrown.conflict;
}

test.after(() => cleanupDb(process.env.DB_PATH, db()));

test("같은 룸 + 겹치는 시간 → 충돌(상대 행 반환)", () => {
  const a = create({ room: roomA, start: "14:00", end: "16:00", date: "2026-06-01" });
  const conflict = expectConflict(() => create({ room: roomA, start: "15:00", end: "17:00", date: "2026-06-01" }));
  assert.strictEqual(conflict.id, a.id, "충돌 행은 먼저 만든 세션이어야 한다");
});

test("다른 룸 + 같은 시간 → 충돌 없음(병렬 허용)", () => {
  create({ room: roomA, start: "14:00", end: "16:00", date: "2026-06-02" });
  const b = create({ room: roomB, start: "14:00", end: "16:00", date: "2026-06-02" });
  assert.ok(b && b.id, "다른 룸은 같은 시간에 생성되어야 한다");
});

test("같은 룸 + 인접(반열린구간 [start,end)) → 충돌 없음", () => {
  create({ room: roomA, start: "14:00", end: "16:00", date: "2026-06-03" });
  const b = create({ room: roomA, start: "16:00", end: "18:00", date: "2026-06-03" });
  assert.ok(b && b.id, "16:00 시작은 16:00 종료와 겹치지 않아야 한다");
});

test("회귀 안전망: 마스터링·기타 세션도 충돌 검사 대상(session_type 무관)", () => {
  create({ room: roomA, type: "마스터링", start: "14:00", end: "16:00", date: "2026-06-04" });
  // 과거엔 IN절이 녹음/믹싱만 봤음 → 마스터링/기타가 빠져나갔다. 지금은 전 타입 충돌.
  expectConflict(() => create({ room: roomA, type: "기타", start: "15:00", end: "17:00", date: "2026-06-04" }));
});

test("야간 경계(자정 넘김, end<start): 22:00–02:00 vs 23:00–01:00 → 충돌", () => {
  const night = create({ room: roomA, start: "22:00", end: "02:00", date: "2026-06-05" });
  assert.strictEqual(night.end_time, "02:00", "end<start 도 그대로 저장(자정 넘김)");
  expectConflict(() => create({ room: roomA, start: "23:00", end: "01:00", date: "2026-06-05" }));
  // 같은 날 오전(야간 세션 전)은 충돌 아님 — 정상 생성.
  const morning = create({ room: roomA, start: "10:00", end: "11:00", date: "2026-06-05" });
  assert.ok(morning && morning.id);
});

test("updateSession: 자기 자신과는 충돌하지 않는다(excludeId)", () => {
  const s = create({ room: roomA, start: "14:00", end: "16:00", date: "2026-06-06" });
  const updated = updateSession(CHIEF, s.id, {
    session_type: "녹음",
    session_date: "2026-06-06",
    start_time: "14:30", // 자기 시간과 겹치지만 자기 자신은 제외돼야 함
    end_time: "16:30",
    room_id: roomA,
    status: "예정",
  });
  assert.ok(updated && updated.id === s.id, "자기 세션 수정은 충돌 없이 성공해야 한다");
  assert.strictEqual(updated.start_time, "14:30");
});
