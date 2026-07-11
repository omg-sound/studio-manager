"use strict";

// ── 구글 캘린더 이벤트 시간 조립(eventTimes) 회귀 잠금 ──
// 종일 end.date는 배타적(마지막 날+1)이고 다일·야간 익일 산술이 KST에서 하루 밀리기 쉬운 클래스
// (toISOString은 UTC — T00:00:00Z + setUTCDate로 순수 날짜 연산이라 안 밀리지만 무테스트였음).
// 앱→구글 단방향 푸시라 fail-safe로 무음 처리 → 하루 밀린 일정이 조용히 나가도 감지 안 됨.
process.env.NODE_ENV = "test";
const test = require("node:test");
const assert = require("node:assert");
const { eventTimes } = require("../src/calendar");

test("eventTimes: 시간 세션 → KST dateTime(+09:00)", () => {
  const r = eventTimes("2026-02-05", "14:00", "17:00");
  assert.deepEqual(r, {
    start: { dateTime: "2026-02-05T14:00:00+09:00", timeZone: "Asia/Seoul" },
    end: { dateTime: "2026-02-05T17:00:00+09:00", timeZone: "Asia/Seoul" },
  });
});

test("eventTimes: 야간(종료<=시작) → 종료는 익일", () => {
  const r = eventTimes("2026-02-05", "22:00", "02:00");
  assert.equal(r.start.dateTime, "2026-02-05T22:00:00+09:00");
  assert.equal(r.end.dateTime, "2026-02-06T02:00:00+09:00", "익일 02:00");
});

test("eventTimes: 단일 종일 → end.date 배타적(다음날)", () => {
  const r = eventTimes("2026-02-05", null, null);
  assert.deepEqual(r, { start: { date: "2026-02-05" }, end: { date: "2026-02-06" } });
});

test("eventTimes: 다일 종일(2/5~2/9) → end.date = 종료+1(배타적)", () => {
  const r = eventTimes("2026-02-05", "", "", "2026-02-09");
  assert.deepEqual(r, { start: { date: "2026-02-05" }, end: { date: "2026-02-10" } });
});

test("eventTimes: KST 월·연 경계에서 +1일이 밀리지 않음", () => {
  assert.equal(eventTimes("2026-02-28", null, null).end.date, "2026-03-01", "2월 28일(비윤년) → 3월 1일");
  assert.equal(eventTimes("2026-12-31", null, null).end.date, "2027-01-01", "연말 → 다음해 1월 1일");
  assert.equal(eventTimes("2028-02-28", null, null).end.date, "2028-02-29", "윤년 2월 28일 → 2월 29일");
});

test("eventTimes: 종료<시작 문자열 순서가 아닌 다일 종일은 endDate 무시(단일 취급)", () => {
  // endDate가 date보다 앞이면(비정상) 단일 종일로 폴백.
  const r = eventTimes("2026-02-05", null, null, "2026-02-01");
  assert.deepEqual(r, { start: { date: "2026-02-05" }, end: { date: "2026-02-06" } });
});
