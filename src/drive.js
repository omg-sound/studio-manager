"use strict";

/**
 * Google Drive 스토리지 모듈 — 스캐폴드(플레이북1 §2.2~2.4).
 * MVP(프로젝트 관리)에서는 미사용. 자료 전달 단계에서 업로드/프록시 스트리밍을 활성화한다.
 *
 * 핵심 설계:
 * - 관리자 OAuth refresh token을 재사용(별도 서비스 계정 없음), 최소권한 scope 'drive.file'.
 * - refresh token은 admin_state에 AES-256-GCM 암호화 저장(db.encrypt/decrypt).
 * - 업로드 파일은 공개하지 않고 백엔드가 프록시 스트리밍(/api/assets/:id/raw).
 */

const { google } = require("googleapis");
const { config } = require("./config");
const { getState, setState, encrypt, decrypt } = require("./db");
const { oauthClient } = require("./auth");

const STATE_REFRESH_TOKEN = "drive_refresh_token"; // 암호화 저장
const STATE_FOLDER_PREFIX = "drive_folder_"; // kind별 folder_id 캐시

class DriveNotLinkedError extends Error {
  constructor() {
    super("DRIVE_NOT_LINKED");
    this.code = "DRIVE_NOT_LINKED";
  }
}

/** 관리자 OAuth 콜백에서 받은 refresh token을 암호화 저장. */
function saveRefreshToken(refreshToken) {
  if (!refreshToken) return;
  setState(STATE_REFRESH_TOKEN, encrypt(refreshToken));
}

function getRefreshToken() {
  return decrypt(getState(STATE_REFRESH_TOKEN));
}

function isLinked() {
  return Boolean(config.googleConfigured && getRefreshToken());
}

/** refresh token으로 인증된 Drive 클라이언트. 미연결 시 DriveNotLinkedError. */
function driveClient() {
  const refresh = getRefreshToken();
  if (!config.googleConfigured || !refresh) throw new DriveNotLinkedError();
  const auth = oauthClient();
  auth.setCredentials({ refresh_token: refresh });
  return google.drive({ version: "v3", auth });
}

const fs = require("fs");

const STATE_ROOT_FOLDER = STATE_FOLDER_PREFIX + "root";
const STATE_ROOT_RENAMED = "drive_root_renamed_omg_v1"; // 루트 폴더명 1회 변경 게이트(구 'OMG Studios Deliverables' → omg-studios-manager)
const ROOT_FOLDER_NAME = "omg-studios-manager";

/** 루트 폴더(omg-studios-manager)를 lazy 생성·캐시. 기존 폴더가 있으면 재사용(이름이 바뀌었으면 1회 rename). */
async function ensureFolder() {
  const drive = driveClient();
  const cached = getState(STATE_ROOT_FOLDER);
  if (cached) {
    if (!getState(STATE_ROOT_RENAMED)) {
      // 기존 루트를 새 이름으로 1회 변경(파일·하위폴더 그대로 유지, ID 불변). 실패해도 업로드 비차단.
      try { await drive.files.update({ fileId: cached, requestBody: { name: ROOT_FOLDER_NAME } }); } catch (_e) {}
      setState(STATE_ROOT_RENAMED, "done");
    }
    return cached;
  }
  const { data } = await drive.files.create({
    requestBody: { name: ROOT_FOLDER_NAME, mimeType: "application/vnd.google-apps.folder" },
    fields: "id",
  });
  setState(STATE_ROOT_FOLDER, data.id);
  setState(STATE_ROOT_RENAMED, "done"); // 신규 생성은 이미 새 이름
  return data.id;
}

/** 루트 아래 하위 폴더(이름별)를 lazy 생성·캐시. 반환 folder id. */
async function ensureSubfolder(name) {
  const key = STATE_FOLDER_PREFIX + "sub_" + name;
  const cached = getState(key);
  if (cached) return cached;
  const drive = driveClient();
  const root = await ensureFolder();
  const { data } = await drive.files.create({
    requestBody: { name, mimeType: "application/vnd.google-apps.folder", parents: [root] },
    fields: "id",
  });
  setState(key, data.id);
  return data.id;
}

/** 로컬 파일 → Drive 업로드(스트리밍). folder(하위 폴더명) 지정 시 그 아래, 없으면 루트. drive fileId 반환. */
async function uploadFile({ filePath, name, mimeType, folder }) {
  const drive = driveClient();
  const parent = folder ? await ensureSubfolder(folder) : await ensureFolder();
  const { data } = await drive.files.create({
    requestBody: { name, parents: [parent] },
    media: { mimeType: mimeType || "application/octet-stream", body: fs.createReadStream(filePath) },
    fields: "id",
  });
  return data.id;
}

/** Drive 파일을 res로 프록시 스트리밍(공개 URL 없이, 백엔드가 비공개 유지). */
async function streamFile(fileId, res) {
  const drive = driveClient();
  const resp = await drive.files.get({ fileId, alt: "media" }, { responseType: "stream" });
  await new Promise((resolve, reject) => {
    resp.data.on("end", resolve).on("error", reject).pipe(res);
  });
}

async function deleteFile(fileId) {
  const drive = driveClient();
  await drive.files.delete({ fileId });
}

/** 캐시된 폴더 id(첫 업로드 전이면 null). 점검용 — 생성은 안 함. */
function getFolderId() {
  return getState(STATE_ROOT_FOLDER) || null;
}

/** Drive 파일/폴더 메타(존재 확인·바로가기 링크). 없으면(404 등) 예외. */
async function getFileMeta(fileId) {
  const drive = driveClient();
  const { data } = await drive.files.get({ fileId, fields: "id,name,webViewLink,mimeType,trashed,createdTime" });
  return data;
}

/**
 * 저장 폴더 점검: 폴더가 있으면 그대로, 없으면 생성 후 메타(id·name·webViewLink) 반환.
 * 반환: { id, name, webViewLink, created(신규생성 여부) } 또는 미연동 시 예외.
 */
async function checkFolder() {
  const before = getFolderId();
  const id = await ensureFolder(); // 캐시 있으면 그대로, 없으면 생성
  const meta = await getFileMeta(id);
  return { id: meta.id, name: meta.name, webViewLink: meta.webViewLink || null, trashed: !!meta.trashed, created: !before };
}

module.exports = {
  DriveNotLinkedError,
  STATE_REFRESH_TOKEN,
  STATE_FOLDER_PREFIX,
  saveRefreshToken,
  getRefreshToken,
  isLinked,
  driveClient,
  ensureFolder,
  ensureSubfolder,
  getFolderId,
  getFileMeta,
  checkFolder,
  uploadFile,
  streamFile,
  deleteFile,
};
