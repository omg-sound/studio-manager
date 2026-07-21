"use strict";

// ── calendarMonthCells 회귀 잠금(2026-07-21 구글식 앞뒤 달 넘침) ──
// 뷰(monthCalendar)와 데이터(sessionsForCalendar)가 이 하나를 공유하므로, 격자 셀 목록이 곧 세션 조회 범위다.
// 여기가 어긋나면 이웃 달 세션이 조회는 됐는데 셀이 없거나(유령), 셀은 있는데 세션이 안 잡힌다.
process.env.NODE_ENV = "test";
const test = require("node:test");
const assert = require("node:assert");
const { calendarMonthCells } = require("../src/lib/date");

test("항상 완전한 주(7칸 배수)로 채운다", () => {
  for (const ym of ["2026-01", "2026-02", "2026-07", "2026-08", "2028-02"]) {
    const cells = calendarMonthCells(ym);
    assert.equal(cells.length % 7, 0, `${ym}: 7칸 배수`);
    assert.ok(cells.length === 35 || cells.length === 42 || cells.length === 28, `${ym}: 4~6주(${cells.length})`);
  }
});

test("첫 셀은 일요일(앞 달 넘침), 마지막 셀은 토요일(뒷 달 넘침)", () => {
  // 2026-07: 1일이 수요일 → 앞에 6/28·29·30, 끝에 8/1
  const c = calendarMonthCells("2026-07");
  assert.equal(c[0].ymd, "2026-06-28", "첫 셀 = 이전 달 말일들의 시작(일요일)");
  assert.equal(c[0].inMonth, false);
  assert.equal(c[c.length - 1].ymd, "2026-08-01", "마지막 셀 = 다음 달 초(토요일)");
  assert.equal(c[c.length - 1].inMonth, false);
  // 이번 달 1일~31일은 정확히 inMonth=true, 그 수는 31
  assert.equal(c.filter((x) => x.inMonth).length, 31, "7월 = 31일");
});

test("inMonth 경계 — 이번 달 첫날/말일만 참", () => {
  const c = calendarMonthCells("2026-08"); // 8/1=토요일 → 앞 넘침 6칸, 6주
  const inMonth = c.filter((x) => x.inMonth);
  assert.equal(inMonth[0].ymd, "2026-08-01");
  assert.equal(inMonth[0].day, 1);
  assert.equal(inMonth[inMonth.length - 1].ymd, "2026-08-31");
  assert.equal(inMonth.length, 31);
  // 앞 넘침은 7월, 뒤 넘침은 9월
  assert.ok(c[0].ymd.startsWith("2026-07"), "앞 넘침 = 7월");
  assert.ok(c[c.length - 1].ymd.startsWith("2026-09"), "뒤 넘침 = 9월");
});

test("연말 경계 — 12월은 다음 해 1월로 넘친다", () => {
  const c = calendarMonthCells("2026-12"); // 12/1=화 → 앞 6/29·11/30, 끝 1월
  assert.ok(c[c.length - 1].ymd.startsWith("2027-01"), "12월 뒤 넘침 = 이듬해 1월");
  assert.equal(c.filter((x) => x.inMonth && x.ymd.startsWith("2026-12")).length, 31);
});

test("연속·중복 없는 날짜(하루씩 증가)", () => {
  const c = calendarMonthCells("2026-07");
  for (let i = 1; i < c.length; i++) {
    const prev = new Date(c[i - 1].ymd + "T00:00:00Z").getTime();
    const cur = new Date(c[i].ymd + "T00:00:00Z").getTime();
    assert.equal(cur - prev, 86400000, `${c[i - 1].ymd} → ${c[i].ymd} 하루 차이`);
  }
});
