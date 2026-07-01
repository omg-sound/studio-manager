"use strict";

// ── 격리 DB 셋업(다른 테스트와 동일 패턴) ──
process.env.NODE_ENV = "test";
const { tempDbPath, cleanupDb } = require("./helpers");
process.env.DB_PATH = tempDbPath();

const test = require("node:test");
const assert = require("node:assert");

const { init } = require("../src/db");
const { computeRatePrice } = require("../src/data");

init();

// 보컬녹음 예시: 1Pro=210분(3.5h)·30만, 초과 60분 단위·10만.
const ITEM = { base_minutes: 210, base_price: 300000, extra_minutes: 60, extra_price: 100000 };

test("Pro 블록 단가: 3.5h마다 1Pro로 묶어 완전 블록은 기본가", () => {
  assert.equal(computeRatePrice(ITEM, 210), 300000, "정확히 1Pro=기본가");
  assert.equal(computeRatePrice(ITEM, 180), 300000, "1Pro 미만도 최소 1Pro(기본가)");
  assert.equal(computeRatePrice(ITEM, 420), 600000, "정확히 2Pro=기본가×2");
  assert.equal(computeRatePrice(ITEM, 630), 900000, "정확히 3Pro=기본가×3 (사용자 보고 케이스: 10.5h→90만)");
  assert.equal(computeRatePrice(ITEM, 840), 1200000, "정확히 4Pro=기본가×4");
});

test("Pro 블록 단가: 마지막 1Pro 미만 자투리만 초과요금", () => {
  // 240분 = 1Pro(210) + 30분 자투리 → 30만 + ceil(30/60)×10만 = 40만
  assert.equal(computeRatePrice(ITEM, 240), 400000);
  // 480분 = 2Pro(420) + 60분 자투리 → 60만 + 1×10만 = 70만
  assert.equal(computeRatePrice(ITEM, 480), 700000);
  // 700분 = 3Pro(630) + 70분 자투리 → 90만 + ceil(70/60)=2×10만 = 110만
  assert.equal(computeRatePrice(ITEM, 700), 1100000);
});

test("정액 단가(base_minutes=0)는 시간과 무관하게 기본가", () => {
  const flat = { base_minutes: 0, base_price: 500000, extra_minutes: 60, extra_price: 0 };
  assert.equal(computeRatePrice(flat, 60), 500000);
  assert.equal(computeRatePrice(flat, 600), 500000);
});

test("0분/음수는 기본가 규칙 내(가드)", () => {
  assert.equal(computeRatePrice(ITEM, 0), 300000, "0분도 최소 1Pro 취급(m<=base)");
  assert.equal(computeRatePrice(null, 100), 0, "item 없으면 0");
});

test.after(() => cleanupDb());
