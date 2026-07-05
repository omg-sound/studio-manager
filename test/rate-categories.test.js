"use strict";

// ── 격리 DB 셋업(다른 테스트와 동일 패턴) ──
process.env.NODE_ENV = "test";
const { tempDbPath, cleanupDb } = require("./helpers");
process.env.DB_PATH = tempDbPath();

const test = require("node:test");
const assert = require("node:assert");

const { init, db } = require("../src/db");
const {
  listRateCategories,
  createRateCategory,
  updateRateCategory,
  deleteRateCategory,
  rateCategoryKind,
  createRateItem,
} = require("../src/data");

init();

test.after(() => cleanupDb(process.env.DB_PATH, db()));

// ── 1회 시드: 기본 4개 분류가 locked=1로 들어와 있어야 한다 ──
test("시드: 기본 분류 4개(스튜디오/로케이션 녹음·스튜디오 촬영·공연)는 locked", () => {
  const cats = listRateCategories();
  const builtin = ["스튜디오 녹음", "로케이션 녹음", "스튜디오 촬영", "공연"];
  for (const name of builtin) {
    const c = cats.find((x) => x.name === name);
    assert.ok(c, `${name} 시드 존재`);
    assert.strictEqual(c.locked, 1, `${name}은 locked`);
  }
  assert.strictEqual(rateCategoryKind("스튜디오 녹음"), "recording");
  assert.strictEqual(rateCategoryKind("스튜디오 촬영"), "filming");
  assert.strictEqual(rateCategoryKind("공연"), "performance");
});

// ── 기본 분류는 수정·삭제 불가 ──
test("기본 분류는 수정·삭제 시 CATEGORY_LOCKED", () => {
  const c = listRateCategories().find((x) => x.name === "스튜디오 녹음");
  assert.throws(() => updateRateCategory(c.id, { name: "바뀐이름", kind: "recording" }), /CATEGORY_LOCKED/);
  assert.throws(() => deleteRateCategory(c.id), /CATEGORY_LOCKED/);
});

// ── 커스텀 분류는 추가·수정·삭제 가능 ──
test("커스텀 분류: 추가·수정(이름 변경 시 rate_items.category 함께 갱신)·삭제", () => {
  const created = createRateCategory({ name: "야외 촬영", kind: "filming" });
  assert.strictEqual(created.locked, 0);
  assert.strictEqual(created.kind, "filming");

  const item = createRateItem({ rate_name: "출장 촬영", category: "야외 촬영", base_hours: "2", base_price: "500000" });
  assert.strictEqual(item.category, "야외 촬영");

  const renamed = updateRateCategory(created.id, { name: "출장 촬영(분류)", kind: "filming" });
  assert.strictEqual(renamed.name, "출장 촬영(분류)");
  const reloadedItem = db().prepare("SELECT category FROM rate_items WHERE id = ?").get(item.id);
  assert.strictEqual(reloadedItem.category, "출장 촬영(분류)", "이름 변경 시 참조 중인 단가 항목도 함께 갱신");

  // 사용 중이므로 삭제 거부
  assert.throws(() => deleteRateCategory(created.id), /CATEGORY_IN_USE/);

  // 참조 제거 후에는 삭제 가능
  db().prepare("DELETE FROM rate_items WHERE id = ?").run(item.id);
  const del = deleteRateCategory(created.id);
  assert.strictEqual(del.id, created.id);
  assert.strictEqual(listRateCategories().find((x) => x.id === created.id), undefined);
});

test("createRateCategory: 이름 없으면 CATEGORY_NAME_REQUIRED, kind 미지정이면 recording 폴백", () => {
  assert.throws(() => createRateCategory({ name: "" }), /CATEGORY_NAME_REQUIRED/);
  const c = createRateCategory({ name: "분류미지정테스트" });
  assert.strictEqual(c.kind, "recording");
});
