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

/**
 * 분류 순서 이동(같은 kind 안에서 위/아래 한 칸, 2026-07-09 관리 개선 — 정렬 UI).
 * 현재 표시 순서(kind→sort_order→이름)를 물질화해 이웃과 자리를 바꾸고 sort_order를 10 간격으로 재부여
 * (999 기본값 중복 상태에서도 결정적으로 동작). 잠긴 기본 분류도 순서 이동은 허용(잠금=이름·삭제 보호).
 */
function moveRateCategory(id, dir) {
  const cur = db().prepare("SELECT * FROM rate_categories WHERE id = ?").get(Number(id));
  if (!cur) return;
  const rows = db().prepare("SELECT id FROM rate_categories WHERE kind = ? ORDER BY sort_order, name COLLATE NOCASE").all(cur.kind);
  const i = rows.findIndex((r) => r.id === cur.id);
  const j = dir === "up" ? i - 1 : i + 1;
  if (i < 0 || j < 0 || j >= rows.length) return;
  [rows[i], rows[j]] = [rows[j], rows[i]];
  const upd = db().prepare("UPDATE rate_categories SET sort_order = ? WHERE id = ?");
  rows.forEach((r, idx) => upd.run((idx + 1) * 10, r.id));
}

module.exports = {
  listRateCategories,
  getRateCategory,
  rateCategoryKind,
  createRateCategory,
  updateRateCategory,
  moveRateCategory,
  deleteRateCategory,
};
