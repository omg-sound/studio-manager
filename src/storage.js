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
async function put({ filePath, name, mimeType }) {
  if (drive.isLinked()) {
    const fileId = await drive.uploadFile({ filePath, name, mimeType });
    return { backend: "drive", fileId };
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

module.exports = { activeBackend, put, stream, remove, sizeOf, localPath };
