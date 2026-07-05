"use strict";

/**
 * 단가표 분류(rate_categories) 도메인 — 2026-07-05 신설.
 * config의 RECORDING/FILMING/PERFORMANCE_CATEGORIES는 1회 시드 데이터일 뿐(db.js seedDefaultCatalogs),
 * 이후 이 테이블이 단일 진실원천이다. 시드된 4개 분류는 locked=1(수정·삭제 불가 — 세션 종류↔kind 매핑 등
 * 코드가 이름에 의존). 치프가 새로 추가하는 분류만 locked=0으로 자유롭게 수정·삭제할 수 있다.
 */

const { db } = require("../db");

const KINDS = ["recording", "filming", "performance"];

/** 전체 분류(kind→sort_order→이름순). 세션 폼·관리 화면 공용. */
function listRateCategories() {
  return db().prepare("SELECT * FROM rate_categories ORDER BY kind, sort_order, name COLLATE NOCASE").all();
}

function getRateCategory(id) {
  return db().prepare("SELECT * FROM rate_categories WHERE id = ?").get(Number(id)) || null;
}

/** 분류명 → kind(recording|filming|performance). 등록 안 된 이름은 recording으로 폴백(레거시 데이터 방어). */
function rateCategoryKind(name) {
  const row = db().prepare("SELECT kind FROM rate_categories WHERE name = ?").get(String(name || ""));
  return row ? row.kind : "recording";
}

function createRateCategory({ name, kind } = {}) {
  const nm = String(name || "").trim();
  if (!nm) throw new Error("CATEGORY_NAME_REQUIRED");
  const k = KINDS.includes(kind) ? kind : "recording";
  const info = db().prepare("INSERT INTO rate_categories (name, kind, locked, sort_order) VALUES (?, ?, 0, 999)").run(nm, k);
  return getRateCategory(info.lastInsertRowid);
}

/** 이름을 바꾸면 그 이름을 참조 중인 rate_items.category도 함께 갱신(텍스트 컬럼이라 끊어지지 않게). */
function updateRateCategory(id, { name, kind } = {}) {
  const cat = getRateCategory(id);
  if (!cat) return null;
  if (cat.locked) throw new Error("CATEGORY_LOCKED");
  const nm = String(name || "").trim();
  if (!nm) throw new Error("CATEGORY_NAME_REQUIRED");
  const k = KINDS.includes(kind) ? kind : cat.kind;
  db().prepare("UPDATE rate_categories SET name = ?, kind = ? WHERE id = ?").run(nm, k, cat.id);
  if (nm !== cat.name) db().prepare("UPDATE rate_items SET category = ? WHERE category = ?").run(nm, cat.name);
  return getRateCategory(id);
}

/** 사용 중인(rate_items가 참조하는) 분류는 삭제 거부 — 오연결/유령 분류 방지. */
function deleteRateCategory(id) {
  const cat = getRateCategory(id);
  if (!cat) return null;
  if (cat.locked) throw new Error("CATEGORY_LOCKED");
  const inUse = db().prepare("SELECT COUNT(*) AS n FROM rate_items WHERE category = ?").get(cat.name).n;
  if (inUse > 0) throw new Error("CATEGORY_IN_USE");
  db().prepare("DELETE FROM rate_categories WHERE id = ?").run(cat.id);
  return { id: cat.id };
}

module.exports = {
  listRateCategories,
  getRateCategory,
  rateCategoryKind,
  createRateCategory,
  updateRateCategory,
  deleteRateCategory,
};
