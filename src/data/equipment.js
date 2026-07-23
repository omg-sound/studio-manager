"use strict";

/**
 * 장비 대장(equipment) 도메인 — 스튜디오 보유 장비의 참조용 마스터 목록.
 * 판매 재고(stock-flow)가 아니라 자산 대장: 매입가·시리얼·구매일·현재 장소를 CRUD로 관리.
 * data.js에서 분리한 모듈(도메인 모듈화). data.js가 재export하므로 소비자 무변경.
 */

const { db } = require("../db");
const { parseMoney, cleanYmd } = require("../lib/forms");
const { listRooms } = require("./rooms");

/** null/빈 문자열로 정리 — 선택 필드는 빈 입력을 NULL로 저장(빈 문자열 안 남김). */
function blankToNull(v) {
  const s = String(v == null ? "" : v).trim();
  return s || null;
}

/** 폼 입력 → 저장 필드. 장비명 필드는 equipment_name(가드레일 ① — bare name= 회피). */
function equipmentFields(input = {}) {
  const price = parseMoney(input.purchase_price);
  return {
    name: String(input.equipment_name != null ? input.equipment_name : input.name || "").trim(),
    category: blankToNull(input.category),
    serial_no: blankToNull(input.serial_no),
    purchase_price: price > 0 ? price : null, // 0/빈값 = 모름(NULL). parseMoney는 양수만 반환.
    purchased_on: cleanYmd(input.purchased_on), // 형식 불량/빈값 = null
    location: blankToNull(input.location),
    memo: blankToNull(input.memo),
  };
}

function listEquipment({ q } = {}) {
  const params = {};
  let where = "";
  const term = String(q || "").trim();
  if (term) {
    where = `WHERE name LIKE @kw OR IFNULL(category,'') LIKE @kw OR IFNULL(serial_no,'') LIKE @kw OR IFNULL(location,'') LIKE @kw`;
    params.kw = `%${term}%`;
  }
  // 종류 그룹 순(미분류=빈 종류 맨 뒤), 그 안 이름순.
  return db()
    .prepare(`SELECT * FROM equipment ${where} ORDER BY (category IS NULL OR category=''), category COLLATE NOCASE, name COLLATE NOCASE`)
    .all(params);
}

function getEquipment(id) {
  if (!id) return null;
  return db().prepare("SELECT * FROM equipment WHERE id = ?").get(Number(id)) || null;
}

function createEquipment(input = {}) {
  const f = equipmentFields(input);
  if (!f.name) throw new Error("EQUIPMENT_NAME_REQUIRED");
  const info = db()
    .prepare(`INSERT INTO equipment (name, category, serial_no, purchase_price, purchased_on, location, memo)
       VALUES (@name,@category,@serial_no,@purchase_price,@purchased_on,@location,@memo)`)
    .run(f);
  return getEquipment(info.lastInsertRowid);
}

function updateEquipment(id, input = {}) {
  const f = equipmentFields(input);
  if (!f.name) throw new Error("EQUIPMENT_NAME_REQUIRED");
  db()
    .prepare(`UPDATE equipment SET name=@name, category=@category, serial_no=@serial_no,
       purchase_price=@purchase_price, purchased_on=@purchased_on, location=@location, memo=@memo WHERE id=@id`)
    .run({ id: Number(id), ...f });
  return getEquipment(id);
}

function deleteEquipment(id) {
  db().prepare("DELETE FROM equipment WHERE id = ?").run(Number(id));
}

/** 장소 입력 제안 = 등록된 룸 이름 + 이미 쓰인 장소값(중복 제거·빈값 제외). */
function equipmentLocationSuggestions() {
  const rooms = listRooms().map((r) => r.name).filter(Boolean);
  const used = db().prepare("SELECT DISTINCT location FROM equipment WHERE location IS NOT NULL AND TRIM(location) <> ''").all().map((r) => r.location);
  const seen = new Set();
  const out = [];
  for (const v of [...rooms, ...used]) { if (!seen.has(v)) { seen.add(v); out.push(v); } }
  return out;
}

/** 종류 입력 제안 = 이미 쓰인 종류값(중복 제거·빈값 제외·이름순). */
function equipmentCategorySuggestions() {
  return db().prepare("SELECT DISTINCT category FROM equipment WHERE category IS NOT NULL AND TRIM(category) <> '' ORDER BY category COLLATE NOCASE").all().map((r) => r.category);
}

module.exports = {
  listEquipment,
  getEquipment,
  createEquipment,
  updateEquipment,
  deleteEquipment,
  equipmentLocationSuggestions,
  equipmentCategorySuggestions,
};
