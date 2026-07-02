"use strict";

/**
 * 클라이언트 첨부 서류 도메인(사업자등록증·통장사본) — client_files 테이블.
 * kind별 1개(교체식). 매직바이트 검증·인증 다운로드는 호출부(clients.routes)에서.
 * data.js에서 분리한 모듈(도메인 모듈화). data.js가 재export하므로 소비자 무변경.
 * 이 도메인은 db()만 사용해 완전 독립적이다(cross-domain 의존 없음).
 */

const { db } = require("../db");

/** kind에 해당하는 파일 행(없으면 null). */
function getClientFile(clientId, kind) {
  return db().prepare("SELECT * FROM client_files WHERE client_id = ? AND kind = ?").get(clientId, kind) || null;
}

/** 클라이언트의 모든 첨부 서류 행 목록. */
function listClientFiles(clientId) {
  return db().prepare("SELECT * FROM client_files WHERE client_id = ? ORDER BY kind").all(clientId);
}

/**
 * 파일 행 upsert(삽입 또는 갱신).
 * 기존 같은 kind가 있으면 {storage_backend, file_id}를 반환해 호출부가 storage.remove를 호출하게 한다.
 * 없으면 null 반환.
 */
function upsertClientFile(clientId, kind, { storage_backend, file_id, file_name, mime_type, file_size }) {
  const existing = db().prepare("SELECT storage_backend, file_id FROM client_files WHERE client_id = ? AND kind = ?").get(clientId, kind);
  if (existing) {
    db()
      .prepare(
        "UPDATE client_files SET storage_backend=@storage_backend, file_id=@file_id, file_name=@file_name, mime_type=@mime_type, file_size=@file_size WHERE client_id=@client_id AND kind=@kind"
      )
      .run({ client_id: clientId, kind, storage_backend, file_id, file_name, mime_type: mime_type || null, file_size: file_size || 0 });
  } else {
    db()
      .prepare(
        "INSERT INTO client_files (client_id, kind, storage_backend, file_id, file_name, mime_type, file_size) VALUES (@client_id, @kind, @storage_backend, @file_id, @file_name, @mime_type, @file_size)"
      )
      .run({ client_id: clientId, kind, storage_backend, file_id, file_name, mime_type: mime_type || null, file_size: file_size || 0 });
  }
  return existing || null;
}

/**
 * 파일 행 삭제. 삭제된 행의 {storage_backend, file_id} 반환(호출부가 storage.remove 호출).
 * 없으면 null 반환.
 */
function deleteClientFile(clientId, kind) {
  const existing = db().prepare("SELECT storage_backend, file_id FROM client_files WHERE client_id = ? AND kind = ?").get(clientId, kind);
  if (existing) {
    db().prepare("DELETE FROM client_files WHERE client_id = ? AND kind = ?").run(clientId, kind);
  }
  return existing || null;
}

module.exports = {
  getClientFile,
  listClientFiles,
  upsertClientFile,
  deleteClientFile,
};
