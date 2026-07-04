"use strict";

/**
 * 단가표(과금 항목) 도메인 — 녹음 종류(rate_items). 스튜디오/로케이션 분류.
 * 녹음 세션 1Pro(기준시간) 블록 산정(computeRatePrice). 치프가 관리 메뉴에서 CRUD.
 * data.js에서 분리한 모듈(도메인 모듈화). data.js가 재export하므로 소비자 무변경.
 */

const { db } = require("../db");
const { normalizeRecordingCategory } = require("../config");
const { parseMoney } = require("../lib/forms");

const parseWon = parseMoney; // 내부 호출명 parseWon 유지(data.js와 동일 별칭)

/** 시간(소수, "3.5") → 분. 빈 값/0 이하면 0. */
function parseHoursToMinutes(v) {
  const n = Number(String(v == null ? "" : v).replace(",", "."));
  return Number.isFinite(n) && n > 0 ? Math.round(n * 60) : 0;
}

function rateFields(input) {
  return {
    name: String(input.rate_name != null ? input.rate_name : input.name || "").trim(), // 폼 필드=rate_name(Chrome이 name= 필드에 사람이름 자동완성을 강제 — 함정 #19)
    category: normalizeRecordingCategory(input.category),
    base_minutes: parseHoursToMinutes(input.base_hours),
    base_price: parseWon(input.base_price),
    extra_minutes: parseHoursToMinutes(input.extra_hours) || 60,
    extra_price: parseWon(input.extra_price),
  };
}

function listRateItems({ includeInactive = false } = {}) {
  return db()
    .prepare(
      `SELECT * FROM rate_items
       ${includeInactive ? "" : "WHERE active = 1"}
       ORDER BY active DESC, name COLLATE NOCASE`
    )
    .all();
}

function createRateItem(input = {}) {
  const f = rateFields(input);
  if (!f.name) throw new Error("RATE_NAME_REQUIRED");
  // 시간제(기준 시간 있음)는 가격 필수. 정액(기준 시간 0=회당)은 가격 0 허용 — '금액 미정' 항목(예: 플레이백 세션), 청구 시 금액 입력(2026-07-04 사용자 결정).
  if (f.base_minutes > 0 && !f.base_price && !f.extra_price) throw new Error("RATE_PRICE_REQUIRED");
  const info = db()
    .prepare(
      `INSERT INTO rate_items (name, category, base_minutes, base_price, extra_minutes, extra_price, active)
       VALUES (@name,@category,@base_minutes,@base_price,@extra_minutes,@extra_price,1)`
    )
    .run(f);
  return db().prepare("SELECT * FROM rate_items WHERE id = ?").get(info.lastInsertRowid);
}

function updateRateItem(id, input = {}) {
  const f = rateFields(input);
  if (!f.name) throw new Error("RATE_NAME_REQUIRED");
  // 시간제(기준 시간 있음)는 가격 필수. 정액(기준 시간 0=회당)은 가격 0 허용 — '금액 미정' 항목(예: 플레이백 세션), 청구 시 금액 입력(2026-07-04 사용자 결정).
  if (f.base_minutes > 0 && !f.base_price && !f.extra_price) throw new Error("RATE_PRICE_REQUIRED");
  db()
    .prepare(
      `UPDATE rate_items SET name=@name, category=@category, base_minutes=@base_minutes, base_price=@base_price,
       extra_minutes=@extra_minutes, extra_price=@extra_price WHERE id=@id`
    )
    .run({ id, ...f });
  return db().prepare("SELECT * FROM rate_items WHERE id = ?").get(id);
}

function deleteRateItem(id) {
  db().prepare("DELETE FROM rate_items WHERE id = ?").run(id);
}

/** id로 단가 항목 1건(없으면 null) — 캘린더 이벤트 종류 표기 등. */
function getRateItem(id) {
  if (!id) return null;
  return db().prepare("SELECT * FROM rate_items WHERE id = ?").get(id) || null;
}

/**
 * 진행 분(minutes)에 대한 자동 산정 금액(3단계에서 사용).
 * - 기준 시간 이내 → 기준가. 초과분은 초과 단위(분)로 올림하여 단위당 과금.
 * - base_minutes=0이면 시간 무관 정액(base_price).
 */
function computeRatePrice(item, minutes) {
  if (!item) return 0;
  const m = Math.max(0, Number(minutes) || 0);
  const baseMin = item.base_minutes;
  // 정액(base_minutes=0) 또는 1Pro(기준시간) 이내 → 기본가.
  if (baseMin <= 0 || m <= baseMin) return item.base_price;
  // 기준시간(1Pro)마다 묶어서 계산: 완전한 Pro 블록은 각각 기본가(base_price),
  // 마지막 1Pro 미만 자투리만 추가요금(extra_minutes 단위 올림)으로 과금.
  // 예) 1Pro=210분·30만 / 초과 60분·10만 → 630분(3Pro)=90만, 240분=1Pro+30분=40만.
  const fullPros = Math.floor(m / baseMin);
  const remainder = m - fullPros * baseMin;
  let price = fullPros * item.base_price;
  if (remainder > 0) {
    const unit = item.extra_minutes > 0 ? item.extra_minutes : 60;
    price += Math.ceil(remainder / unit) * item.extra_price;
  }
  return price;
}

module.exports = {
  listRateItems,
  getRateItem,
  createRateItem,
  updateRateItem,
  deleteRateItem,
  computeRatePrice,
};
