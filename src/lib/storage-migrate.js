"use strict";

/**
 * 로컬 디스크에 저장된 첨부(client_files)·자료(deliverables) 파일을 구글 Drive로 이관.
 * - Drive 미연동이면 아무것도 안 함(에러 반환). 연동 상태(drive.file scope + refresh token) 필요.
 * - 파일별 격리: 한 건 실패해도 나머지는 계속(실패 목록 반환). 성공 시 로컬 파일 삭제.
 * - storage_backend='local' 행만 대상. Drive 업로드 성공 후에만 DB를 drive로 갱신(부분 실패 안전).
 */

const fs = require("fs");
const { db } = require("../db");
const drive = require("../drive");
const storage = require("../storage");

const LOCAL_TABLES = ["client_files", "worker_files", "deliverables"]; // storage_backend/file_id 컬럼을 가진 테이블(고정 상수 — SQL 주입 아님). worker_files=외주 첨부(2026-07-06)

/** 저장 백엔드별 파일 수(상태·점검 표시용). backend='local'|'drive'. */
function fileCountByBackend(backend) {
  let n = 0;
  for (const t of LOCAL_TABLES) {
    try { n += db().prepare(`SELECT COUNT(*) c FROM ${t} WHERE storage_backend=?`).get(backend).c; } catch (_e) {}
  }
  return n;
}
/** 로컬 저장 파일 수(테이블별). 상태 표시용. */
function localFileCount() { return fileCountByBackend("local"); }
/** Drive 저장 파일 수. */
function driveFileCount() { return fileCountByBackend("drive"); }

const KIND_FOLDER = { biz_license: "사업자등록증", bankbook: "통장사본", id_card: "주민등록증 사본" }; // client_files·worker_files kind → Drive 하위 폴더명(새 업로드와 일치)

async function migrateLocalFilesToDrive() {
  if (!drive.isLinked()) return { ok: false, error: "DRIVE_NOT_LINKED" };
  const rows = [];
  for (const t of LOCAL_TABLES) {
    try {
      const cols = t === "client_files" || t === "worker_files" ? "id, file_id, file_name, mime_type, kind" : "id, file_id, file_name, mime_type";
      db().prepare(`SELECT ${cols} FROM ${t} WHERE storage_backend='local'`).all().forEach((r) => rows.push({ ...r, tbl: t }));
    } catch (_e) { /* 테이블 없으면 skip */ }
  }
  let migrated = 0;
  const failed = [];
  for (const r of rows) {
    const local = storage.localPath(r.file_id);
    try {
      if (!fs.existsSync(local)) { failed.push({ id: r.id, tbl: r.tbl, reason: "missing-local" }); continue; }
      const folder = r.tbl === "deliverables" ? "deliverables" : (KIND_FOLDER[r.kind] || null); // 새 업로드와 같은 하위 폴더로 이관
      const driveId = await drive.uploadFile({ filePath: local, name: r.file_name || r.file_id, mimeType: r.mime_type || "application/octet-stream", folder });
      db().prepare(`UPDATE ${r.tbl} SET storage_backend='drive', file_id=? WHERE id=?`).run(driveId, r.id);
      try { fs.unlinkSync(local); } catch (_e) { /* 로컬 삭제 실패는 비치명적(중복 보관) */ }
      migrated++;
    } catch (e) {
      failed.push({ id: r.id, tbl: r.tbl, reason: (e && e.message) || String(e) });
    }
  }
  return { ok: true, total: rows.length, migrated, failed };
}

module.exports = { migrateLocalFilesToDrive, localFileCount, driveFileCount, fileCountByBackend, LOCAL_TABLES };
