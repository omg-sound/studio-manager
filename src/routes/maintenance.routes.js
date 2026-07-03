"use strict";

// 내부 유지보수 엔드포인트(인증 세션이 아니라 BACKUP_TOKEN으로 보호).
// Render cron 서비스(디스크 미접근)가 web 서비스를 HTTP로 트리거해 백업/연체 스캔을 수행한다.
// (Render Disk는 단일 서비스에만 attach되므로 cron이 SQLite에 직접 접근할 수 없다.)

const crypto = require("crypto");
const express = require("express");
const { config } = require("../config");
const { asyncHandler } = require("../lib/async");
const { runDailyMaintenance, overdueSummary } = require("../lib/maintenance");

const router = express.Router();

/** 토큰 상수시간 비교(타이밍 공격 방어). 길이가 다르면 즉시 false. */
function validToken(provided) {
  const expected = config.backupToken;
  if (!expected) return false;
  const a = Buffer.from(String(provided || ""), "utf8");
  const b = Buffer.from(expected, "utf8");
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

/**
 * Authorization: Bearer <token> 또는 X-Backup-Token 헤더에서 토큰 추출.
 * 쿼리스트링(?token=)은 의도적으로 미지원 — 시크릿이 액세스/프록시 로그에 평문으로 남는 안티패턴(CWE-598).
 */
function extractToken(req) {
  const auth = req.get("authorization") || "";
  const m = /^Bearer\s+(.+)$/i.exec(auth);
  if (m) return m[1].trim();
  return req.get("x-backup-token") || "";
}

/** 토큰 게이트. 미설정 → 404(기능 노출 자체 차단). 불일치 → 401. */
function tokenGate(req, res, next) {
  if (!config.backupToken) return res.status(404).json({ error: "not_found" });
  if (!validToken(extractToken(req))) return res.status(401).json({ error: "unauthorized" });
  next();
}

// 일일 유지보수: DB 백업(VACUUM INTO) + 연체 스캔. Render cron이 트리거.
router.post("/internal/cron/daily", tokenGate, asyncHandler(async (req, res) => {
  const result = await runDailyMaintenance();
  const backupInfo = result.backup ? `${result.backup.file} (${result.backup.sizeBytes}B, pruned ${result.backup.pruned.length})` : `FAILED: ${result.backupError}`;
  const d = result.driveBackup;
  const driveInfo = d ? (d.skipped ? `drive=skip(${d.reason})` : d.ok ? `drive=ok(pruned ${d.pruned})` : `drive=ERR:${d.error}`) : "drive=none";
  // 로그에는 집계 수치만(고객명·잔액 등 PII는 응답 JSON에만, 토큰 보유자에게만).
  const overdueInfo = result.overdue ? `overdue=${result.overdue.count} due=${result.overdue.totalDue}` : `overdue=ERR:${result.overdueError}`;
  console.log(`[cron] daily — ${overdueInfo} backup=${backupInfo} ${driveInfo}`);
  res.status(result.ok ? 200 : 500).json(result);
}));

// 연체만 조회(부수효과 없음, 모니터링/디버그용).
router.get("/internal/cron/overdue", tokenGate, (req, res) => {
  res.json(overdueSummary());
});

module.exports = router;
