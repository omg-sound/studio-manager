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
  const name = String(input.name || "").trim();
  if (!name) throw new Error("ROOM_NAME_REQUIRED");
  const sort = Number.isFinite(Number(input.sort_order)) ? Number(input.sort_order) : 0;
  const info = db().prepare("INSERT INTO rooms (name, sort_order, active) VALUES (?, ?, 1)").run(name, sort);
  return db().prepare("SELECT * FROM rooms WHERE id = ?").get(info.lastInsertRowid);
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
  deleteRoom,
};
