"use strict";

/**
 * 구글 Drive 스토리지 모듈 — 스캐폴드(플레이북1 §2.2~2.4).
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

const STATE_DRIVE_EMAIL = "drive_account_email"; // 현재 Drive 토큰이 어느 구글 계정 것인지(표시용, 평문)
function setDriveAccountEmail(email) { setState(STATE_DRIVE_EMAIL, String(email || "").trim() || null); }
function getDriveAccountEmail() { return getState(STATE_DRIVE_EMAIL) || null; }

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

/** 캐시된 폴더 id가 실재하고 휴지통이 아니면 true. 조회 실패(404 등)·휴지통이면 false. */
async function folderAlive(drive, id) {
  try {
    const { data } = await drive.files.get({ fileId: id, fields: "id,trashed" });
    return !data.trashed;
  } catch (_e) {
    return false;
  }
}

/** 앱이 볼 수 있는(=앱이 만든, drive.file) 루트 레벨 'omg-studios-manager' 폴더 목록. 생성일 오름차순(가장 오래된=원본). */
async function listRootFolders() {
  const drive = driveClient();
  const q = `name = '${ROOT_FOLDER_NAME.replace(/'/g, "\\'")}' and mimeType = 'application/vnd.google-apps.folder' and trashed = false and 'root' in parents`;
  const { data } = await drive.files.list({ q, fields: "files(id,name,createdTime)", orderBy: "createdTime", pageSize: 50, spaces: "drive" });
  return data.files || [];
}

/**
 * 루트 폴더(omg-studios-manager)를 lazy 생성·캐시.
 * 캐시가 있고 살아있으면 재사용. 캐시가 없거나 무효(삭제/휴지통/안 보임)면 **이름으로 기존 폴더를 먼저 검색**해
 * 재사용(중복 생성 방지 — 캐시 유실/토큰 변경으로 같은 이름 폴더가 여러 개 생기던 문제). 여러 개면 가장 오래된 것(원본).
 * 아무 것도 없을 때만 새로 만든다.
 */
async function ensureFolder() {
  const drive = driveClient();
  const cached = getState(STATE_ROOT_FOLDER);
  if (cached && (await folderAlive(drive, cached))) {
    if (!getState(STATE_ROOT_RENAMED)) {
      try { await drive.files.update({ fileId: cached, requestBody: { name: ROOT_FOLDER_NAME } }); } catch (_e) {}
      setState(STATE_ROOT_RENAMED, "done");
    }
    return cached;
  }
  if (cached) setState(STATE_ROOT_FOLDER, null); // 무효(삭제/휴지통/안 보임) 캐시 폐기
  // 새로 만들기 전에 앱이 볼 수 있는 기존 루트 폴더를 검색 — 있으면 재사용(가장 오래된 원본).
  try {
    const existing = await listRootFolders();
    if (existing.length) {
      setState(STATE_ROOT_FOLDER, existing[0].id);
      setState(STATE_ROOT_RENAMED, "done");
      return existing[0].id;
    }
  } catch (_e) { /* 검색 실패 시 생성으로 폴백 */ }
  const { data } = await drive.files.create({
    requestBody: { name: ROOT_FOLDER_NAME, mimeType: "application/vnd.google-apps.folder" },
    fields: "id",
  });
  setState(STATE_ROOT_FOLDER, data.id);
  setState(STATE_ROOT_RENAMED, "done"); // 신규 생성은 이미 새 이름
  return data.id;
}

/**
 * 중복 루트 폴더 감지·통합: 앱이 볼 수 있는 루트 폴더 중 **가장 오래된 것(원본)** 을 정본 캐시로 지정.
 * 이후 업로드·이관이 원본 폴더로 간다. 반환 { folders:[{id,createdTime}], canonical, duplicates }.
 * (파일 이동은 하지 않음 — 사용자가 Drive에서 빈 중복 폴더를 확인·삭제하도록 안내.)
 */
async function reconcileRootFolder() {
  const folders = await listRootFolders();
  if (!folders.length) return { folders: [], canonical: null, duplicates: 0, subDuplicates: 0 };
  const canonical = folders[0].id; // createdTime asc → 가장 오래된 원본
  setState(STATE_ROOT_FOLDER, canonical);
  setState(STATE_ROOT_RENAMED, "done");
  // 하위 폴더 중복도 통합: 정본 루트 아래 폴더를 이름별로 묶어 가장 오래된 것을 캐시로, 나머지는 중복 카운트.
  let subDuplicates = 0;
  try {
    const drive = driveClient();
    const { data } = await drive.files.list({
      q: `mimeType = 'application/vnd.google-apps.folder' and trashed = false and '${canonical}' in parents`,
      fields: "files(id,name,createdTime)", orderBy: "createdTime", pageSize: 100, spaces: "drive",
    });
    const byName = {};
    for (const f of data.files || []) (byName[f.name] = byName[f.name] || []).push(f);
    for (const nm of Object.keys(byName)) {
      const dupes = byName[nm]; // createdTime asc
      setState(STATE_FOLDER_PREFIX + "sub_" + nm, dupes[0].id); // 가장 오래된 원본으로 캐시 재지정
      subDuplicates += dupes.length - 1;
    }
  } catch (_e) { /* 하위 폴더 통합 실패는 무시(루트만이라도 통합) */ }
  return { folders, canonical, duplicates: folders.length - 1, subDuplicates };
}

/** 루트(또는 지정 부모) 아래 같은 이름의 하위 폴더 목록. 생성일 오름차순(가장 오래된=원본). */
async function listSubfolders(name, parentId) {
  const drive = driveClient();
  const q = `name = '${String(name).replace(/'/g, "\\'")}' and mimeType = 'application/vnd.google-apps.folder' and trashed = false and '${parentId}' in parents`;
  const { data } = await drive.files.list({ q, fields: "files(id,name,createdTime)", orderBy: "createdTime", pageSize: 50, spaces: "drive" });
  return data.files || [];
}

/**
 * 루트 아래 하위 폴더(이름별)를 lazy 생성·캐시. 캐시가 삭제/휴지통/안 보임이면 **이름으로 기존 폴더를 먼저 검색**해
 * 재사용(중복 생성 방지 — 루트 캐시 변경/토큰 변경으로 같은 이름 하위 폴더가 여러 개 생기던 문제). 여러 개면 가장 오래된 것.
 */
async function ensureSubfolder(name) {
  const key = STATE_FOLDER_PREFIX + "sub_" + name;
  const drive = driveClient();
  const cached = getState(key);
  if (cached && (await folderAlive(drive, cached))) return cached;
  if (cached) setState(key, null); // 무효 캐시 폐기
  const root = await ensureFolder();
  // 새로 만들기 전에 루트 아래 같은 이름의 기존 하위 폴더 검색 — 있으면 재사용(가장 오래된 원본).
  try {
    const existing = await listSubfolders(name, root);
    if (existing.length) { setState(key, existing[0].id); return existing[0].id; }
  } catch (_e) { /* 검색 실패 시 생성 폴백 */ }
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
    res.on("close", () => { try { resp.data.destroy(); } catch (_e) {} }); // 클라이언트 중단 시 업스트림 파괴(FD/소켓 누수 방지) — 로컬 스트림과 동일
    resp.data.on("end", resolve).on("error", reject).pipe(res);
  });
}

async function deleteFile(fileId) {
  const drive = driveClient();
  // 영구삭제 대신 휴지통으로 이동 — 첨부 교체·오삭제 시 30일 복구 창 확보(민감 금융서류 보호).
  await drive.files.update({ fileId, requestBody: { trashed: true } });
}

/**
 * DB 백업 파일을 Drive 'backups' 하위 폴더로 오프사이트 전송(Render 디스크 단일 장애점 완화).
 * 같은 이름(같은 날) 기존본은 교체, 이름(=날짜) 사전순 최신 keep개만 보존. 미연동이면 skip.
 * @returns {Promise<{ok?:boolean, skipped?:boolean, reason?:string, fileId?:string, pruned?:number}>}
 */
async function backupToDrive(filePath, { keep = 14 } = {}) {
  if (!filePath || !isLinked()) return { skipped: true, reason: "no-drive" };
  const path = require("path");
  const drive = driveClient();
  const parent = await ensureSubfolder("backups");
  const name = path.basename(filePath);
  const { data } = await drive.files.list({
    q: `'${parent}' in parents and trashed = false`,
    fields: "files(id,name)", orderBy: "name", pageSize: 200, spaces: "drive",
  });
  const files = (data.files || []).filter((f) => /^app-\d.*\.db$/.test(f.name));
  for (const f of files) { if (f.name === name) { try { await deleteFile(f.id); } catch (_e) {} } } // 같은 날 재실행 중복 제거
  const { data: up } = await drive.files.create({
    requestBody: { name, parents: [parent] },
    media: { mimeType: "application/x-sqlite3", body: fs.createReadStream(filePath) },
    fields: "id",
  });
  // 정리: 이름(app-YYYY-MM-DD.db) 사전순 = 날짜순 → 최신 keep개만 보존, 나머지 휴지통.
  const remaining = files.filter((f) => f.name !== name).map((f) => ({ id: f.id, name: f.name }));
  remaining.push({ id: up.id, name });
  remaining.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  let pruned = 0;
  for (const f of remaining.slice(0, Math.max(0, remaining.length - keep))) { try { await deleteFile(f.id); pruned++; } catch (_e) {} }
  return { ok: true, fileId: up.id, pruned };
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

/**
 * 업로드 왕복 프로브: 작은 임시 파일을 Drive에 업로드→메타 확인→삭제. 실제 첨부 저장 경로(uploadFile)를
 * 그대로 검증한다(폴더 접근만 보는 checkFolder보다 강함). 성공 { ok:true, fileId } / 실패 시 예외.
 */
async function probeUpload() {
  const fs = require("fs");
  const os = require("os");
  const path = require("path");
  const tmp = path.join(os.tmpdir(), `omg-drive-probe-${Date.now()}.txt`);
  fs.writeFileSync(tmp, "OMG Studios Drive 연결 테스트 — 자동 삭제됩니다.\n");
  let fileId;
  try {
    fileId = await uploadFile({ filePath: tmp, name: "_연결테스트.txt", mimeType: "text/plain" });
    await getFileMeta(fileId); // 읽기 확인
    return { ok: true, fileId };
  } finally {
    try { fs.unlinkSync(tmp); } catch (_e) { /* noop */ }
    if (fileId) { try { await deleteFile(fileId); } catch (_e) { /* 삭제 실패는 무해(휴지통 처리) */ } }
  }
}

module.exports = {
  DriveNotLinkedError,
  STATE_REFRESH_TOKEN,
  STATE_FOLDER_PREFIX,
  saveRefreshToken,
  getRefreshToken,
  setDriveAccountEmail,
  getDriveAccountEmail,
  isLinked,
  driveClient,
  ensureFolder,
  ensureSubfolder,
  getFolderId,
  getFileMeta,
  checkFolder,
  probeUpload,
  listRootFolders,
  listSubfolders,
  reconcileRootFolder,
  uploadFile,
  streamFile,
  deleteFile,
  backupToDrive,
};
