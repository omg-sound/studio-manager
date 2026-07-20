"use strict";

/**
 * 감사 로그(2026-07-09 관리 개선) — 파괴적·재무 액션만 가볍게 기록.
 * 하드 삭제 중심 정책(관리 항목 삭제-only)의 보완: "누가 언제 뭘 지웠/바꿨나"를 추적해 실수 복기를 돕는다.
 * append-only 표시용이며 **절대 본 흐름을 막지 않는다**(fail-safe — 기록 실패는 무시).
 * 대상(target)은 짧은 요약 텍스트만(민감정보 금지 — 계좌·주민번호 등을 넣지 말 것).
 */
const { db } = require("../db");

/**
 * action 예: invoice.delete / invoice.create / invoice.tax / project.delete / party.delete / worker.delete / worker.payout / user.role / user.delete
 * 인증 계열: auth.login / auth.access / auth.deny(2026-07-20)
 * @returns {boolean} 기록 성공 여부. **호출부는 무시해도 된다**(기존 호출부 전부 그렇다) — 실패해도 던지지 않는다.
 *   logAccessDaily만 이 값을 본다: 실패한 걸 성공으로 착각하고 캐시를 세우면 그날 접속이 영영 안 남기 때문.
 */
function logAudit(user, action, target) {
  try {
    db().prepare("INSERT INTO audit_log (user_email, action, target) VALUES (?, ?, ?)")
      .run(user && user.email ? String(user.email) : null, String(action || ""), target != null ? String(target).slice(0, 200) : null);
    return true;
  } catch (_e) { return false; /* 표시용 — 기록 실패는 본 흐름 비차단 */ }
}

/**
 * 최근 감사 로그(기본 50건, 최신순).
 *
 * @param {"work"|"auth"|"all"} [kind] 기본 `work`(변경 이력 = `auth.*` 제외) / `auth`(접속·로그인) / `all`.
 *   **왜 갈랐나**(2026-07-20): 화면이 최근 50건 고정이라 접속 기록을 같은 목록에 섞으면
 *   삭제·청구 같은 파괴적 기록이 며칠 만에 창 밖으로 밀려난다. 카드를 둘로 나누는 대신
 *   필터 UI를 얹는 방법도 있었지만, 두 목록은 보는 목적 자체가 달라 나누는 편이 단순하다.
 */
function listAudit(limit = 50, kind = "work") {
  try {
    const n = Math.min(Number(limit) || 50, 200);
    const where = kind === "auth" ? "WHERE action LIKE 'auth.%'"
      : kind === "all" ? ""
        : "WHERE action NOT LIKE 'auth.%'";
    return db().prepare(`SELECT * FROM audit_log ${where} ORDER BY id DESC LIMIT ?`).all(n);
  } catch (_e) { return []; }
}

/**
 * 접속 기록 — **사람당 하루 첫 1건만**(2026-07-20 사용자 결정).
 *
 * 로그인 쿠키가 30일짜리라 실제 로그인(`auth.login`)은 사람당 한 달에 한 번꼴이고, 사용자가 실제로 보고 싶어한
 * '브라우저 켜서 ERP를 열 때'는 로그인 이벤트가 아니다. 그렇다고 요청마다 남기면 하루 수백 줄이 된다 →
 * 사람·날짜 조합당 한 줄로 접는다.
 *
 * 중복 판정은 **메모리 캐시 + DB 확인 2단**이다. 캐시만 쓰면 배포·재시작마다 그날 첫 줄이 다시 찍히고,
 * DB만 쓰면 매 요청 쿼리가 늘기 때문. 캐시가 맞으면 쿼리 자체가 없고, 캐시 미스일 때만 하루 한 번 확인한다.
 * 전부 fail-safe — 이 함수는 모든 인증 요청 경로에 있으므로 절대 예외를 밖으로 내보내지 않는다.
 */
const accessSeen = new Map(); // email → 'YYYY-MM-DD'(마지막으로 기록한 날, 프로세스 로컬)
const KST_OFFSET_MS = 9 * 60 * 60 * 1000;

/**
 * '하루'의 경계 = **KST 자정**(2026-07-20 리뷰 지적으로 UTC에서 교정).
 * `audit_log.at`은 UTC(datetime('now'))라 UTC 자정을 쓰면 형식은 맞지만, 그 경계가 **한국 오전 9시**다 →
 * 08:30에 출근해 열고 09:00을 넘겨 아무 페이지나 눌렀을 뿐인데 30분 간격으로 두 줄이 찍히고,
 * 10시 출근자는 늘 한 줄이라 같은 규칙이 사람마다 다르게 동작한다.
 * @returns {{day:string, sinceUtc:string}} KST 날짜 키 + 그 자정에 해당하는 UTC 시각(`at` 비교용).
 */
function kstDay(now = Date.now()) {
  const day = new Date(now + KST_OFFSET_MS).toISOString().slice(0, 10);
  const sinceUtc = new Date(Date.parse(`${day}T00:00:00Z`) - KST_OFFSET_MS)
    .toISOString().slice(0, 19).replace("T", " "); // 'YYYY-MM-DD HH:MM:SS' — at 컬럼과 같은 형식
  return { day, sinceUtc };
}

function logAccessDaily(user, device) {
  try {
    if (!user || !user.email) return;
    const email = String(user.email);
    const { day, sinceUtc } = kstDay();
    if (accessSeen.get(email) === day) return; // 이 프로세스에서 오늘 이미 기록
    const dup = db().prepare(
      "SELECT 1 FROM audit_log WHERE user_email = ? AND action = 'auth.access' AND at >= ? LIMIT 1"
    ).get(email, sinceUtc);
    if (dup) { accessSeen.set(email, day); return; } // 재시작 전에 다른 프로세스가 이미 기록
    const role = user.role ? roleLabel(user.role) : "";
    // 캐시는 **기록에 성공했을 때만** 세운다 — 무조건 세우면 디스크 풀·SQLITE_BUSY로 INSERT가 조용히 실패했을 때
    // 캐시만 '기록됨'으로 남아 DB가 회복돼도 그 사람의 그날 접속이 영영 안 남는다.
    // (logAudit은 던지지 않고 false를 돌려주므로 반환값을 봐야 한다 — 안 보면 이 분기가 무의미해진다.)
    if (logAudit(user, "auth.access", [role, device].filter(Boolean).join(" · "))) accessSeen.set(email, day);
  } catch (_e) { /* 표시용 — 기록 실패는 본 흐름 비차단 */ }
}

/** 감사 로그에 보일 역할 이름(화면 용어와 통일). */
function roleLabel(role) {
  return role === "chief" ? "치프" : role === "owner" ? "대표" : role === "staff" ? "스태프" : String(role || "");
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

module.exports = { logAudit, listAudit, pruneAudit, logAccessDaily, roleLabel, kstDay };
