"use strict";

/**
 * 외주 작업자 첨부 서류 도메인(주민등록증 사본·통장사본, 2026-07-06 사용자 요청) — worker_files 테이블.
 * client-files.js와 동일 구조(kind별 1개 교체식). 매직바이트 검증·인증 다운로드는 호출부(workers.routes)에서.
 * data.js에서 분리한 모듈(도메인 모듈화). data.js가 재export하므로 소비자 무변경.
 * 이 도메인은 db()만 사용해 완전 독립적이다(cross-domain 의존 없음).
 */

const { db } = require("../db");

/** kind에 해당하는 파일 행(없으면 null). */
function getWorkerFile(workerId, kind) {
  return db().prepare("SELECT * FROM worker_files WHERE worker_id = ? AND kind = ?").get(workerId, kind) || null;
}

/** 작업자의 모든 첨부 서류 행 목록. */
function listWorkerFiles(workerId) {
  return db().prepare("SELECT * FROM worker_files WHERE worker_id = ? ORDER BY kind").all(workerId);
}

/**
 * 파일 행 upsert(삽입 또는 갱신).
 * 기존 같은 kind가 있으면 {storage_backend, file_id}를 반환해 호출부가 storage.remove를 호출하게 한다.
 * 없으면 null 반환.
 */
function upsertWorkerFile(workerId, kind, { storage_backend, file_id, file_name, mime_type, file_size }) {
  const existing = db().prepare("SELECT storage_backend, file_id FROM worker_files WHERE worker_id = ? AND kind = ?").get(workerId, kind);
  if (existing) {
    db()
      .prepare(
        "UPDATE worker_files SET storage_backend=@storage_backend, file_id=@file_id, file_name=@file_name, mime_type=@mime_type, file_size=@file_size WHERE worker_id=@worker_id AND kind=@kind"
      )
      .run({ worker_id: workerId, kind, storage_backend, file_id, file_name, mime_type: mime_type || null, file_size: file_size || 0 });
  } else {
    db()
      .prepare(
        "INSERT INTO worker_files (worker_id, kind, storage_backend, file_id, file_name, mime_type, file_size) VALUES (@worker_id, @kind, @storage_backend, @file_id, @file_name, @mime_type, @file_size)"
      )
      .run({ worker_id: workerId, kind, storage_backend, file_id, file_name, mime_type: mime_type || null, file_size: file_size || 0 });
  }
  return existing || null;
}

/**
 * 파일 행 삭제. 삭제된 행의 {storage_backend, file_id} 반환(호출부가 storage.remove 호출).
 * 없으면 null 반환.
 */
function deleteWorkerFile(workerId, kind) {
  const existing = db().prepare("SELECT storage_backend, file_id FROM worker_files WHERE worker_id = ? AND kind = ?").get(workerId, kind);
  if (existing) {
    db().prepare("DELETE FROM worker_files WHERE worker_id = ? AND kind = ?").run(workerId, kind);
  }
  return existing || null;
}

module.exports = {
  getWorkerFile,
  listWorkerFiles,
  upsertWorkerFile,
  deleteWorkerFile,
};
