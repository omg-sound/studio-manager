"use strict";

const fs = require("fs");
const path = require("path");
const { db } = require("../db");
const { config } = require("../config");
const { todayYmd } = require("./date");
const { listInvoices, balanceOf } = require("../data");
const { notifyAsync } = require("../notify");
const drive = require("../drive");

// 백업 디렉터리: DB와 같은 (영속) 디스크. 프로덕션 /var/data/backups, 로컬 ./data/backups.
function backupDir() {
  return path.join(path.dirname(config.dbPath), "backups");
}

const KEEP_BACKUPS = 14; // 최근 14일분 유지(일일 cron 기준 2주)

/**
 * 연체 인보이스 요약(발행 + 마감 경과 + 잔금 존재). 단일 진실원천인 data.isOverdue 필터 재사용.
 * 알림 채널(메일/웹훅)은 후속 TODO이며 현재는 집계·로그·JSON 응답으로 노출한다.
 */
function overdueSummary() {
  const rows = listInvoices(null, { overdue: true });
  const items = rows.map((i) => ({
    id: i.id,
    title: i.title,
    invoice_number: i.invoice_number || null,
    client_name: i.client_name || null,
    project_title: i.project_title || null,
    due_date: i.due_date,
    balance: balanceOf(i),
  }));
  const totalDue = items.reduce((sum, i) => sum + i.balance, 0);
  return { count: items.length, totalDue, items };
}

/**
 * SQLite 온라인 백업. VACUUM INTO는 잠금/WAL과 무관하게 일관된 스냅샷 단일 파일을 만든다.
 * 같은 날 재실행 시 대상 파일을 먼저 지워(VACUUM INTO는 기존 파일이면 실패) 최신본으로 갱신한다.
 */
function backupDatabase({ keep = KEEP_BACKUPS } = {}) {
  const dir = backupDir();
  fs.mkdirSync(dir, { recursive: true });
  const stamp = todayYmd(); // 'YYYY-MM-DD' (KST)
  const file = path.join(dir, `app-${stamp}.db`);
  fs.rmSync(file, { force: true });
  // 경로는 서버가 생성한 값(사용자 입력 아님). 방어적으로 작은따옴표만 이스케이프.
  const safe = file.replace(/'/g, "''");
  db().exec(`VACUUM INTO '${safe}'`);
  const sizeBytes = fs.statSync(file).size;
  const pruned = pruneOldBackups(dir, keep);
  return { file, sizeBytes, pruned };
}

/**
 * 첨부 파일(uploads) 폴더를 날짜별 스냅샷으로 백업(DB와 같은 백업 디렉터리에 uploads-YYYY-MM-DD/).
 * 로컬 저장 백엔드의 실제 파일 바이트는 DB 백업에 안 들어가므로 별도 스냅샷(우발적 삭제·교체 복구용).
 * Drive 저장분은 Drive 자체가 원본이라 로컬 폴더가 비어 있으면 skip. keep개(일)만 보존.
 */
const KEEP_UPLOAD_SNAPSHOTS = 3; // 첨부 스냅샷은 소수만 보존(디스크 보호). DB 백업은 14일 유지.
const MAX_UPLOADS_SNAPSHOT_BYTES = 300 * 1024 * 1024; // 업로드 합계가 이보다 크면 스냅샷 생략(1GB 디스크 포화→DB 백업 실패 연쇄 방지)

function backupUploads({ keep = KEEP_UPLOAD_SNAPSHOTS } = {}) {
  const src = config.uploadsDir;
  if (!fs.existsSync(src)) return { skipped: true, reason: "no-uploads-dir" };
  const files = fs.readdirSync(src).filter((f) => fs.statSync(path.join(src, f)).isFile());
  if (!files.length) return { skipped: true, reason: "empty" };
  let sizeBytes = 0;
  for (const f of files) { try { sizeBytes += fs.statSync(path.join(src, f)).size; } catch (_e) {} }
  // 대용량(예: 200MB 자료 파일 다수)이면 14벌 대신 스냅샷 자체를 생략 — 디스크를 지켜 DB 백업(내구성 핵심)을 보호.
  if (sizeBytes > MAX_UPLOADS_SNAPSHOT_BYTES) return { skipped: true, reason: "too-large", sizeBytes, fileCount: files.length };
  const dir = backupDir();
  fs.mkdirSync(dir, { recursive: true });
  const stamp = todayYmd();
  const dest = path.join(dir, `uploads-${stamp}`);
  fs.rmSync(dest, { recursive: true, force: true }); // 같은 날 재실행 시 최신본으로 갱신
  fs.cpSync(src, dest, { recursive: true });
  const pruned = pruneOldUploadSnapshots(dir, keep);
  return { dest, fileCount: files.length, sizeBytes, pruned };
}

/** uploads-YYYY-MM-DD 스냅샷 디렉터리를 사전식 정렬해 최근 keep개만 남기고 제거. */
function pruneOldUploadSnapshots(dir, keep) {
  let names;
  try { names = fs.readdirSync(dir); } catch (_e) { return []; }
  const all = names.filter((f) => /^uploads-\d{4}-\d{2}-\d{2}$/.test(f)).sort();
  const remove = all.slice(0, Math.max(0, all.length - keep));
  for (const f of remove) { try { fs.rmSync(path.join(dir, f), { recursive: true, force: true }); } catch (_e) {} }
  return remove;
}

/** app-YYYY-MM-DD.db 파일명을 사전식(=시간순) 정렬해 최근 keep개만 남기고 오래된 것 제거. */
function pruneOldBackups(dir, keep) {
  let names;
  try {
    names = fs.readdirSync(dir);
  } catch (_e) {
    return [];
  }
  const all = names.filter((f) => /^app-\d{4}-\d{2}-\d{2}\.db$/.test(f)).sort();
  const remove = all.slice(0, Math.max(0, all.length - keep));
  for (const f of remove) {
    try {
      fs.rmSync(path.join(dir, f), { force: true });
    } catch (_e) {
      /* 정리 실패는 치명적이지 않음 */
    }
  }
  return remove;
}

/**
 * 일일 유지보수: DB 백업 + 연체 스캔. cron이 HTTP로 트리거(maintenance.routes).
 * 백업(내구성 핵심)을 먼저, 그리고 두 작업을 각자 try/catch로 격리한다 → 한쪽 실패가 다른 쪽을
 * 막지 않는다(연체 읽기 오류로 백업이 건너뛰는 우선순위 역전 방지). ok는 백업 성공 기준.
 */
async function runDailyMaintenance(opts = {}) {
  const ranAt = new Date().toISOString();
  let backup = null;
  let backupError = null;
  try {
    backup = backupDatabase(opts);
  } catch (e) {
    backupError = e && e.message ? e.message : String(e);
  }
  // 오프사이트: DB 백업을 Drive로 사본 전송(Render 디스크가 유일 백업처인 단일 장애점 완화). fail-safe·비차단.
  let driveBackup = null;
  try {
    if (backup && backup.file) driveBackup = await drive.backupToDrive(backup.file, { keep: KEEP_BACKUPS });
  } catch (e) {
    driveBackup = { ok: false, error: e && e.message ? e.message : String(e) };
  }
  // 첨부 파일 스냅샷(DB 백업과 별개·격리). 실패해도 DB 백업/연체엔 영향 없음.
  let uploadsBackup = null;
  let uploadsBackupError = null;
  try {
    uploadsBackup = backupUploads(opts);
  } catch (e) {
    uploadsBackupError = e && e.message ? e.message : String(e);
  }
  let overdue = null;
  let overdueError = null;
  try {
    overdue = overdueSummary();
  } catch (e) {
    overdueError = e && e.message ? e.message : String(e);
  }
  // 연체가 있으면 팀 알림(fail-safe·비차단). 미설정이면 조용히 skip.
  if (overdue && overdue.count > 0) {
    notifyAsync({
      type: "overdue",
      title: `[연체] 미수 인보이스 ${overdue.count}건`,
      text: `미수금 합계 ${overdue.totalDue.toLocaleString("ko-KR")}원`,
      fields: overdue.items.slice(0, 5).map((i) => ({
        label: i.invoice_number || i.title,
        value: `${i.balance.toLocaleString("ko-KR")}원${i.client_name ? " · " + i.client_name : ""} (마감 ${i.due_date})`,
      })),
    });
  }
  // 감사 로그 보존(180일·최대 2만 건) — 무한 증가로 DB·백업이 커지는 것 방지(2026-07-09 스케일 점검). fail-safe.
  let auditPruned = 0;
  try { auditPruned = require("./audit").pruneAudit().pruned; } catch (_e) { /* 비차단 */ }
  return { ok: !backupError, ranAt, backup, backupError, driveBackup, uploadsBackup, uploadsBackupError, overdue, overdueError, auditPruned };
}

module.exports = {
  runDailyMaintenance,
  overdueSummary,
  backupDatabase,
  backupUploads,
  pruneOldBackups,
  pruneOldUploadSnapshots,
  backupDir,
  KEEP_BACKUPS,
};
