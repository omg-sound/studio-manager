"use strict";
process.env.NODE_ENV = "test";
const { tempDbPath, cleanupDb } = require("./helpers");
process.env.DB_PATH = tempDbPath();

const test = require("node:test");
const assert = require("node:assert");
const { db, init } = require("../src/db");
init();
test.after(() => cleanupDb(process.env.DB_PATH, db()));

const {
  createEquipment, getEquipment, updateEquipment, deleteEquipment,
  listEquipment, equipmentLocationSuggestions, equipmentCategorySuggestions,
} = require("../src/data");

test("createEquipment: 장비명만으로 생성, 금액·날짜 파싱, 나머지 선택", () => {
  const e = createEquipment({ equipment_name: "Neumann U87", category: "마이크", serial_no: "SN-123", purchase_price: "3,200,000", purchased_on: "2024-05-10", location: "A룸", memo: "메인 보컬 마이크" });
  assert.ok(e.id);
  assert.strictEqual(e.name, "Neumann U87");
  assert.strictEqual(e.purchase_price, 3200000, "콤마 금액 → 정수");
  assert.strictEqual(e.purchased_on, "2024-05-10");
  assert.strictEqual(e.location, "A룸");
});

test("createEquipment: 장비명 없으면 EQUIPMENT_NAME_REQUIRED", () => {
  assert.throws(() => createEquipment({ equipment_name: "  " }), /EQUIPMENT_NAME_REQUIRED/);
});

test("createEquipment: 매입가·구매일·종류·장소 없이도 생성(오래된 장비)", () => {
  const e = createEquipment({ equipment_name: "정체불명 아웃보드" });
  assert.strictEqual(e.purchase_price, null);
  assert.strictEqual(e.purchased_on, null);
  assert.strictEqual(e.category, null);
});

test("updateEquipment: 필드 갱신, 장비명 없으면 throw", () => {
  const e = createEquipment({ equipment_name: "U47", category: "마이크" });
  const u = updateEquipment(e.id, { equipment_name: "U47 FET", category: "마이크", location: "창고", purchase_price: "5000000" });
  assert.strictEqual(u.name, "U47 FET");
  assert.strictEqual(u.location, "창고");
  assert.strictEqual(u.purchase_price, 5000000);
  assert.throws(() => updateEquipment(e.id, { equipment_name: "" }), /EQUIPMENT_NAME_REQUIRED/);
});

test("deleteEquipment: 하드 삭제", () => {
  const e = createEquipment({ equipment_name: "삭제대상" });
  deleteEquipment(e.id);
  assert.strictEqual(getEquipment(e.id), null);
});

test("listEquipment: 종류 그룹 순 정렬(미분류 맨 뒤), q 필터", () => {
  db().prepare("DELETE FROM equipment").run();
  createEquipment({ equipment_name: "SM7B", category: "마이크" });
  createEquipment({ equipment_name: "1176", category: "아웃보드" });
  createEquipment({ equipment_name: "이름없는종류", category: "" });
  const rows = listEquipment();
  assert.strictEqual(rows[rows.length - 1].name, "이름없는종류", "미분류(빈 종류)는 맨 뒤");
  const filtered = listEquipment({ q: "1176" });
  assert.strictEqual(filtered.length, 1);
  assert.strictEqual(filtered[0].name, "1176");
});

test("equipmentLocationSuggestions: 룸 이름 + 기존 장소값, 중복 제거·빈값 제외", () => {
  db().prepare("DELETE FROM equipment").run();
  db().prepare("INSERT INTO rooms (name, active) VALUES ('A룸', 1)").run();
  createEquipment({ equipment_name: "x", location: "창고" });
  createEquipment({ equipment_name: "y", location: "창고" }); // 중복
  createEquipment({ equipment_name: "z", location: "" });     // 빈값
  const s = equipmentLocationSuggestions();
  assert.ok(s.includes("A룸"), "룸 이름 포함");
  assert.ok(s.includes("창고"), "기존 장소 포함");
  assert.strictEqual(s.filter((v) => v === "창고").length, 1, "중복 1건");
  assert.ok(!s.includes(""), "빈값 제외");
});

test("equipmentCategorySuggestions: distinct 종류, 빈값 제외", () => {
  db().prepare("DELETE FROM equipment").run();
  createEquipment({ equipment_name: "a", category: "마이크" });
  createEquipment({ equipment_name: "b", category: "마이크" });
  createEquipment({ equipment_name: "c", category: "" });
  const s = equipmentCategorySuggestions();
  assert.deepStrictEqual(s, ["마이크"]);
});
