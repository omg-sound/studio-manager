"use strict";

/**
 * 파일 스토리지 추상화.
 * - Drive 연동 시(관리자 OAuth refresh token 존재) → Google Drive(비공개, 프록시 스트리밍).
 * - 미연동 시 → 로컬 디스크 폴백(config.uploadsDir). 자격증명 없이 전체 흐름 검증 가능.
 *
 * 어느 백엔드든 파일은 공개되지 않으며, 다운로드는 항상 백엔드 라우트가 프록시한다.
 */

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { config } = require("./config");
const drive = require("./drive");

function localDir() {
  fs.mkdirSync(config.uploadsDir, { recursive: true });
  return config.uploadsDir;
}
function localPath(fileId) {
  return path.join(localDir(), fileId);
}

/** 현재 활성 백엔드 이름(표시용). */
function activeBackend() {
  return drive.isLinked() ? "drive" : "local";
}

/**
 * 임시 업로드 파일을 영구 스토리지로 이동.
 * @returns {Promise<{backend:'drive'|'local', fileId:string}>}
 */
async function put({ filePath, name, mimeType, folder }) {
  if (drive.isLinked()) {
    try {
      const fileId = await drive.uploadFile({ filePath, name, mimeType, folder }); // folder=하위 폴더명(사업자등록증·통장사본·deliverables). 미지정 시 루트.
      return { backend: "drive", fileId };
    } catch (e) {
      // Drive 오류(토큰 만료·API 비활성·폴더 삭제 등) 시 파일 유실 방지 — 로컬로 폴백(추후 '로컬→Drive 이관'으로 재이관 가능).
      console.error("[storage.put] Drive 업로드 실패 → 로컬 폴백:", (e && e.message) || e);
    }
  }
  // 로컬: 랜덤 id로 이동(원본 파일명은 DB에 별도 보관)
  const id = crypto.randomBytes(16).toString("hex");
  const dest = localPath(id);
  await fs.promises.copyFile(filePath, dest);
  return { backend: "local", fileId: id };
}

/** 백엔드에서 res로 바이트 스트리밍(헤더는 호출부가 설정). */
async function stream(backend, fileId, res) {
  if (backend === "drive") {
    return drive.streamFile(fileId, res);
  }
  await new Promise((resolve, reject) => {
    const rs = fs.createReadStream(localPath(fileId));
    rs.on("error", reject).on("end", resolve);
    // 클라이언트 조기 종료(연결 끊김) 시 읽기 스트림을 명시적으로 닫아 FD 누수 방지.
    res.on("close", () => rs.destroy());
    rs.pipe(res);
  });
}

async function remove(backend, fileId) {
  try {
    if (backend === "drive") return await drive.deleteFile(fileId);
    await fs.promises.unlink(localPath(fileId));
  } catch (e) {
    // 이미 없으면 무시
    if (e && e.code !== "ENOENT") console.warn("[storage.remove]", e.message);
  }
}

/** 로컬 파일 크기(bytes). drive는 0 반환(메타는 DB에 저장됨). */
function sizeOf(backend, fileId) {
  if (backend !== "local") return 0;
  try {
    return fs.statSync(localPath(fileId)).size;
  } catch {
    return 0;
  }
}

/**
 * 파일이 실제로 접근 가능한지 확인(깨진 첨부 링크 감지). Drive=files.get(휴지통/404면 없음), 로컬=존재 여부.
 * 불확실(네트워크 오류 등)이면 true 반환(유효 파일을 숨기지 않도록) — 확실한 부재(404/410/휴지통)만 false.
 */
async function exists(backend, fileId) {
  if (!fileId) return false;
  if (backend === "drive") {
    // drive.file 범위는 앱이 만든 파일만 접근 → 재인증(토큰 변경)·권한으로 404가 '삭제'인지 '접근 불가'인지 구분 불가.
    // 유효 파일을 잘못 숨기지 않도록 **명시적 휴지통(trashed)만 없음**으로 판정, 404/오류는 존재로 간주.
    try {
      const m = await drive.getFileMeta(fileId);
      return !m.trashed;
    } catch (_e) {
      return true; // 404/권한/네트워크 → 불확실 → 존재로 간주(Drive 파일 오탐 방지)
    }
  }
  try { return fs.existsSync(localPath(fileId)); } catch (_e) { return true; }
}

module.exports = { activeBackend, put, stream, remove, sizeOf, localPath, exists };
