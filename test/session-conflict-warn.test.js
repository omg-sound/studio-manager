"use strict";

// ── 격리 DB 셋업: src/* require 이전에 환경변수부터 설정 ──
process.env.NODE_ENV = "test";
const { tempDbPath, cleanupDb } = require("./helpers");
process.env.DB_PATH = tempDbPath();

const test = require("node:test");
const assert = require("node:assert");

const { db, init } = require("../src/db");
const { createSession, busySessionRanges } = require("../src/data");

init();

/**
 * 겹침 **경고**(클라이언트)가 겹침 **차단**(서버)과 같은 판정을 내는지 — 2026-07-23 기능성 평가 결함.
 *
 * 옛 구조는 30분 슬롯 근사(`busySessionSlots` + 구글 FreeBusy 합산)라 세 가지가 동시에 틀렸다:
 *   ① FreeBusy가 룸 구분도 자기 일정 제외도 못 해 **항상 거짓 경고**(동기화된 세션을 편집할 때마다)
 *   ② 슬롯 창이 12:00~23:30 하드코딩이라 **오전 세션은 경고가 아예 안 뜸**
 *   ③ 거짓 경고를 승인하면 `override_conflict=1`이 서버의 진짜 같은 룸 검사를 **통째로 끔**
 * → 거짓 경고에 길들여진 사용자가 실제 이중 예약을 통과시키는 경로였다.
 *
 * `busySessionRanges`는 `findSessionConflict`와 **같은 조건·같은 분 축**으로 점유 구간을 반환한다.
 */

const CHIEF = { id: 1, role: "chief", email: "chief@omg.test" };

const roomA = Number(db().prepare("INSERT INTO rooms (name, active) VALUES ('룸 A', 1)").run().lastInsertRowid);
const roomB = Number(db().prepare("INSERT INTO rooms (name, active) VALUES ('룸 B', 1)").run().lastInsertRowid);
const projectId = Number(
  db().prepare("INSERT INTO projects (title, project_type, rate) VALUES ('겹침경고', 'session', 0)").run().lastInsertRowid
);

function create({ room, start, end, date, status = "예정", allDay = false }) {
  return createSession(CHIEF, projectId, {
    session_type: "녹음",
    session_date: date,
    start_time: start,
    end_time: end,
    room_id: room,
    status,
    ...(allDay ? { all_day: "1" } : {}),
  });
}

/** 선택 구간이 반환된 점유 구간과 겹치나(클라이언트 app.js가 하는 계산과 동일). */
function overlaps(ranges, startMin, durMin) {
  const e = startMin + durMin;
  return ranges.some((r) => startMin < r.end && r.start < e);
}

test.after(() => cleanupDb(process.env.DB_PATH, db()));

test("busySessionRanges: 같은 룸 점유를 분 구간 + 식별 정보로 반환", () => {
  create({ room: roomA, date: "2026-08-01", start: "14:00", end: "18:00" });
  const ranges = busySessionRanges("2026-08-01", { room: roomA });
  assert.strictEqual(ranges.length, 1);
  assert.strictEqual(ranges[0].start, 14 * 60, "14:00 → 840분");
  assert.strictEqual(ranges[0].end, 18 * 60, "18:00 → 1080분");
  assert.strictEqual(ranges[0].room_name, "룸 A");
  assert.strictEqual(ranges[0].project_title, "겹침경고");
});

test("busySessionRanges: 다른 룸은 제외 — 거짓 경고의 근본 원인", () => {
  create({ room: roomA, date: "2026-08-06", start: "14:00", end: "18:00" });
  assert.strictEqual(busySessionRanges("2026-08-06", { room: roomB }).length, 0, "B룸 예약 화면에 A룸 일정이 뜨면 안 된다");
  assert.strictEqual(busySessionRanges("2026-08-06", { room: roomA }).length, 1);
});

test("busySessionRanges: 편집 중인 자기 세션은 exclude로 빠진다", () => {
  const s = create({ room: roomA, date: "2026-08-11", start: "14:00", end: "18:00" });
  assert.strictEqual(busySessionRanges("2026-08-11", { room: roomA }).length, 1);
  assert.strictEqual(busySessionRanges("2026-08-11", { room: roomA, excludeId: s.id }).length, 0, "자기 일정을 자기 충돌로 보면 안 된다");
});

test("busySessionRanges: 취소·종일 세션은 시간을 점유하지 않는다", () => {
  create({ room: roomA, date: "2026-08-16", start: "14:00", end: "18:00", status: "취소" });
  create({ room: roomA, date: "2026-08-16", allDay: true });
  assert.strictEqual(busySessionRanges("2026-08-16", { room: roomA }).length, 0);
});

test("busySessionRanges: 오전 세션도 잡힌다 (옛 슬롯 창 12:00~23:30 사각지대)", () => {
  create({ room: roomA, date: "2026-08-21", start: "09:00", end: "11:00" });
  const ranges = busySessionRanges("2026-08-21", { room: roomA });
  assert.strictEqual(ranges.length, 1, "오전 예약이 경고 대상에서 빠지면 안 된다");
  assert.strictEqual(ranges[0].start, 9 * 60);
  assert.ok(overlaps(ranges, 10 * 60, 60), "10:00+1h는 겹친다");
  assert.ok(!overlaps(ranges, 11 * 60, 60), "11:00 시작은 안 겹친다(반열린 구간)");
});

test("busySessionRanges: 자정 넘긴 전날 야간 세션이 다음날 조회에 음수 구간으로 잡힌다", () => {
  create({ room: roomA, date: "2026-08-26", start: "22:00", end: "02:00" });
  const ranges = busySessionRanges("2026-08-27", { room: roomA });
  assert.strictEqual(ranges.length, 1, "전날 야간분이 다음날 새벽을 점유한다");
  assert.strictEqual(ranges[0].start, -120, "전날 22:00 = 기준일 -120분");
  assert.strictEqual(ranges[0].end, 120, "다음날 02:00 = 기준일 +120분");
  assert.ok(overlaps(ranges, 60, 60), "01:00+1h는 겹친다");
  assert.ok(!overlaps(ranges, 180, 60), "03:00+1h는 안 겹친다");
});

// ── 핵심 불변식: 경고(구간 겹침) ≡ 차단(서버 createSession) ──
test("경고와 서버 차단이 일치한다 — 룸·시간대 매트릭스", () => {
  const date = "2026-09-02";
  create({ room: roomA, date, start: "13:00", end: "15:00" });

  const cases = [
    { room: roomA, start: "09:00", end: "10:00", expect: false, why: "오전·안 겹침" },
    { room: roomA, start: "09:00", end: "13:30", expect: true, why: "오전에서 걸쳐 들어옴(옛 슬롯 방식이 놓치던 케이스)" },
    { room: roomA, start: "14:00", end: "16:00", expect: true, why: "부분 겹침" },
    { room: roomA, start: "15:00", end: "17:00", expect: false, why: "경계 맞닿음(반열린)" },
    { room: roomB, start: "14:00", end: "16:00", expect: false, why: "다른 룸은 병렬 허용" },
  ];

  for (const c of cases) {
    const ranges = busySessionRanges(date, { room: c.room });
    const toMin = (t) => Number(t.slice(0, 2)) * 60 + Number(t.slice(3, 5));
    const warned = overlaps(ranges, toMin(c.start), toMin(c.end) - toMin(c.start));
    assert.strictEqual(warned, c.expect, `경고: ${c.why}`);

    // 서버 차단도 같은 판정이어야 한다(override 없이 시도).
    let blocked = false;
    try {
      create({ room: c.room, date, start: c.start, end: c.end });
    } catch (e) {
      blocked = e.message === "SESSION_TIME_CONFLICT";
    }
    assert.strictEqual(blocked, c.expect, `서버 차단: ${c.why}`);
    if (!blocked) db().prepare("DELETE FROM sessions WHERE session_date = ? AND start_time = ? AND IFNULL(room_id,0) = ?").run(date, c.start, c.room);
  }
});

test("busySessionRanges: 기준일 자정 전에 끝난 전날 주간분은 싣지 않는다(겹칠 수 없는 노이즈)", () => {
  create({ room: roomA, date: "2026-09-10", start: "14:00", end: "18:00" }); // 전날 주간
  create({ room: roomA, date: "2026-09-10", start: "22:00", end: "02:00" }); // 전날 야간(자정 넘김)
  const ranges = busySessionRanges("2026-09-11", { room: roomA });
  assert.strictEqual(ranges.length, 1, "자정을 넘긴 야간분만 다음날에 영향을 준다");
  assert.strictEqual(ranges[0].end, 120);
});
