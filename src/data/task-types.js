"use strict";

/**
 * 작업 종류 카탈로그 도메인(task_types) — 곡·콘텐츠 후반작업 종류.
 * config.TASK_TYPES를 1회 시드 후 DB가 단일 진실원천. 치프가 /settings 컨텐츠 탭 CRUD.
 * data.js에서 분리한 모듈(도메인 모듈화). data.js가 재export하므로 소비자 무변경.
 *
 * 라벨·기본단가 해석은 자주 호출되므로 모듈 캐시(쓰기 시 무효화)로 동기 접근한다.
 * 캐시와 모든 쓰기(create/update/delete·invalidate)가 이 모듈에 함께 있어 캐시 정합이 유지된다.
 * normalizeTaskTypeDb는 내부 정규화용(data.js가 로컬 바인딩으로만 사용, 공개 API에는 미노출).
 */

const crypto = require("crypto");
const { db } = require("../db");
const { normalizeBillingType } = require("../config");
const { parseMoney } = require("../lib/forms");

const parseWon = parseMoney; // 내부 호출명 parseWon 유지(data.js와 동일 별칭)

let _taskTypeCache = null;
function taskTypeCache() {
  if (_taskTypeCache) return _taskTypeCache;
  const rows = db().prepare("SELECT * FROM task_types ORDER BY active DESC, sort_order, label COLLATE NOCASE").all();
  _taskTypeCache = { rows, byKey: new Map(rows.map((r) => [r.key, r])) };
  return _taskTypeCache;
}
function invalidateTaskTypeCache() {
  _taskTypeCache = null;
}
/** 관리용 전체 목록(설정 화면). 캐시 사용. */
function listTaskTypes({ includeInactive = false } = {}) {
  const rows = taskTypeCache().rows;
  return includeInactive ? rows : rows.filter((r) => r.active);
}
/** 활성 종류(작업 폼 옵션·빠른추가 출처). */
function activeTaskTypes() {
  return taskTypeCache().rows.filter((r) => r.active);
}
/** key → 표시 라벨(없으면 key 폴백 — 삭제된 종류의 과거 작업도 깨지지 않게). */
function taskTypeLabel(key) {
  const r = taskTypeCache().byKey.get(key);
  return (r && r.label) || key;
}
/** key → 작업 종류 기본단가(없으면 0). 작업 생성·수정 시 금액 자동 적용(청구 탭에서 조정). */
function taskTypeUnitPrice(key) {
  const r = taskTypeCache().byKey.get(key);
  return (r && r.unit_price) || 0;
}
/** 카탈로그에 있는 key면 통과, 없으면 첫 활성 종류로 폴백(없으면 raw 유지). 신규 종류도 정규화 통과. */
function normalizeTaskTypeDb(key) {
  const k = String(key || "").trim();
  if (taskTypeCache().byKey.has(k)) return k;
  const first = activeTaskTypes()[0];
  return first ? first.key : k;
}

function taskTypeFields(input) {
  return {
    label: String(input.label || "").trim(),
    task_group: "Post_Production", // 분류 개념 폐기 — 곡·콘텐츠 작업은 모두 후반작업(task_group은 레거시 컬럼으로만 보존)
    billing_type: normalizeBillingType(input.billing_type),
    unit_price: parseWon(input.unit_price),
    is_quick: input.is_quick ? 1 : 0,
    sort_order: Number.isFinite(Number(input.sort_order)) ? Number(input.sort_order) : 100,
  };
}
function createTaskType(input = {}) {
  const f = taskTypeFields(input);
  if (!f.label) throw new Error("TASK_TYPE_LABEL_REQUIRED");
  const key = `tt_${crypto.randomBytes(5).toString("hex")}`; // 안정 불투명 key(라벨 변경에도 불변)
  db()
    .prepare(
      `INSERT INTO task_types (key, label, task_group, billing_type, unit_price, is_quick, sort_order, active)
       VALUES (@key,@label,@task_group,@billing_type,@unit_price,@is_quick,@sort_order,1)`
    )
    .run({ key, ...f });
  invalidateTaskTypeCache();
}
function updateTaskType(id, input = {}) {
  const f = taskTypeFields(input);
  if (!f.label) throw new Error("TASK_TYPE_LABEL_REQUIRED");
  db()
    .prepare(
      `UPDATE task_types SET label=@label, task_group=@task_group, billing_type=@billing_type,
       unit_price=@unit_price, is_quick=@is_quick, sort_order=@sort_order WHERE id=@id`
    )
    .run({ id, ...f });
  invalidateTaskTypeCache();
}
/** 강제 삭제(연결 가드 없음, 사용자 결정). 과거 track_tasks는 key 문자열을 유지(라벨만 폴백). */
function deleteTaskType(id) {
  db().prepare("DELETE FROM task_types WHERE id = ?").run(id);
  invalidateTaskTypeCache();
}

module.exports = {
  listTaskTypes,
  activeTaskTypes,
  taskTypeLabel,
  taskTypeUnitPrice,
  normalizeTaskTypeDb, // 내부 정규화용(data.js 로컬 바인딩) — 공개 API 미노출
  createTaskType,
  updateTaskType,
  deleteTaskType,
};
