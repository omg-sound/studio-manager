"use strict";

/**
 * 감사 로그(2026-07-09 관리 개선) — 파괴적·재무 액션만 가볍게 기록.
 * 하드 삭제 중심 정책(관리 항목 삭제-only)의 보완: "누가 언제 뭘 지웠/바꿨나"를 추적해 실수 복기를 돕는다.
 * append-only 표시용이며 **절대 본 흐름을 막지 않는다**(fail-safe — 기록 실패는 무시).
 * 대상(target)은 짧은 요약 텍스트만(민감정보 금지 — 계좌·주민번호 등을 넣지 말 것).
 */
const { db } = require("../db");

/** action 예: invoice.delete / invoice.create / invoice.tax / project.delete / party.delete / worker.delete / worker.payout / user.role / user.delete */
function logAudit(user, action, target) {
  try {
    db().prepare("INSERT INTO audit_log (user_email, action, target) VALUES (?, ?, ?)")
      .run(user && user.email ? String(user.email) : null, String(action || ""), target != null ? String(target).slice(0, 200) : null);
  } catch (_e) { /* 표시용 — 기록 실패는 본 흐름 비차단 */ }
}

/** 최근 감사 로그(기본 50건, 최신순). */
function listAudit(limit = 50) {
  try {
    return db().prepare("SELECT * FROM audit_log ORDER BY id DESC LIMIT ?").all(Math.min(Number(limit) || 50, 200));
  } catch (_e) { return []; }
}

/**
 * 감사 로그 보존 정책(2026-07-09 스케일 점검 — 보존 정책 없이 무한 증가하던 것): 일일 cron에서 호출.
 * 180일 지난 기록 삭제 + 안전 상한(최신 20,000건 초과분 삭제 — 폭주 시 디스크 보호). fail-safe.
 */
function pruneAudit({ days = 180, max = 20000 } = {}) {
  try {
    const d = db();
    const aged = d.prepare("DELETE FROM audit_log WHERE at < datetime('now', ?)").run(`-${Math.max(1, Number(days) || 180)} days`).changes;
    const over = d.prepare("DELETE FROM audit_log WHERE id <= (SELECT id FROM audit_log ORDER BY id DESC LIMIT 1 OFFSET ?)").run(Math.max(100, Number(max) || 20000)).changes;
    return { pruned: aged + over };
  } catch (_e) { return { pruned: 0 }; }
}

module.exports = { logAudit, listAudit, pruneAudit };
