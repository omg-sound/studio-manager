"use strict";

/**
 * 룸(스튜디오 공간) 도메인 — 룸별 겹침 검사 단위. 치프가 /settings에서 CRUD.
 * data.js에서 분리한 모듈(도메인 모듈화). data.js가 재export하므로 소비자 무변경.
 * db()만 사용해 완전 독립적이다.
 */

const { db } = require("../db");

/** 활성(또는 전체) 룸 목록. 정렬: sort_order → 이름. */
function listRooms({ includeInactive = false } = {}) {
  return db()
    .prepare(
      `SELECT * FROM rooms
       ${includeInactive ? "" : "WHERE active = 1"}
       ORDER BY sort_order ASC, name COLLATE NOCASE`
    )
    .all();
}

function createRoom(input = {}) {
  const name = String(input.room_name != null ? input.room_name : input.name || "").trim();
  if (!name) throw new Error("ROOM_NAME_REQUIRED");
  const sort = Number.isFinite(Number(input.sort_order)) ? Number(input.sort_order) : 0;
  const isExternal = input.is_external === "1" || input.is_external === "on" || input.is_external === true ? 1 : 0;
  const info = db().prepare("INSERT INTO rooms (name, sort_order, active, is_external) VALUES (?, ?, 1, ?)").run(name, sort, isExternal);
  return db().prepare("SELECT * FROM rooms WHERE id = ?").get(info.lastInsertRowid);
}

/** 장소(룸)가 외부 장소(주소 입력 대상)인지. 세션 저장 시 location 저장 여부 판정. */
function isExternalRoom(roomId) {
  if (!roomId) return false;
  const r = db().prepare("SELECT is_external FROM rooms WHERE id = ?").get(Number(roomId));
  return !!(r && r.is_external);
}

/** 룸 삭제(하드). FK가 없으므로 참조 세션의 room_id를 먼저 NULL로(SET NULL 의미) 정리한 뒤 행 삭제. */
function deleteRoom(id) {
  const rid = Number(id);
  const d = db();
  d.exec("BEGIN IMMEDIATE;");
  try {
    d.prepare("UPDATE sessions SET room_id = NULL WHERE room_id = ?").run(rid);
    d.prepare("DELETE FROM rooms WHERE id = ?").run(rid);
    d.exec("COMMIT;");
  } catch (e) {
    d.exec("ROLLBACK;");
    throw e;
  }
}

module.exports = {
  listRooms,
  createRoom,
  isExternalRoom,
  deleteRoom,
};
