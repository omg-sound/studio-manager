"use strict";

/**
 * 대시보드 통계 도메인.
 * 전 직원이 프로젝트/마감을 본다. 청구(미수금·연체)는 청구권자(치프/대표), 클라이언트 수는 치프에게 노출.
 * data.js에서 분리한 모듈(도메인 모듈화). data.js가 재export하므로 소비자 무변경.
 * cross-domain: invoiceStats(invoices)를 직접 require(무순환 — invoices는 dashboard를 호출하지 않음).
 */

const { db } = require("../db");
const { canInvoice, isChief } = require("../auth");
const { invoiceStats } = require("./invoices"); // 무순환
const { getManagerByUserId } = require("./parties");
const { todayYmd } = require("../lib/date");

function dashboardStats(user) {
  const d = db();
  const total = d.prepare("SELECT COUNT(*) AS n FROM projects").get().n;
  const showInvoices = canInvoice(user);
  const showClients = isChief(user);
  return {
    canInvoice: showInvoices,
    isChief: showClients,
    total,
    clients: showClients ? d.prepare("SELECT COUNT(*) AS n FROM parties WHERE kind IN ('company','group') OR is_artist = 1").get().n : null,
    invoices: showInvoices ? invoiceStats(user) : null,
  };
}

/**
 * 로그인한 사람의 '내 할 일'(개인 렌즈) — 담당 다가오는 세션 + 미완료 작업.
 * 담당자 행이 없는 계정(작업에 안 붙는 대표 등)은 null → 대시보드가 섹션 자체를 숨긴다.
 * 대시보드의 '오늘·이번 주 세션'(전체)·'청구 필요'(전체)와 달리 **나에게 배정된 것만** 본다.
 */
function myTodo(user) {
  if (!user || !user.id) return null;
  const me = getManagerByUserId(user.id);
  if (!me) return null;
  const d = db();
  const today = todayYmd();
  // 내 담당 다가오는 세션: 다대다 배정(session_engineers) 또는 레거시 첫 엔지니어(engineer_name), 예정·오늘 이후.
  const sessions = d
    .prepare(
      `SELECT DISTINCT s.id, s.session_date, s.session_type, s.all_day, s.start_time,
              p.id AS project_id, p.title AS project_title, p.artist
         FROM sessions s
         JOIN projects p ON p.id = s.project_id
         LEFT JOIN session_engineers se ON se.session_id = s.id
        WHERE (se.manager_id = @id OR s.engineer_name = @name)
          AND s.status = '예정' AND s.session_date >= @today
        ORDER BY s.session_date ASC, s.start_time ASC, s.id ASC
        LIMIT 6`
    )
    .all({ id: me.id, name: me.name, today });
  // 내 미완료 작업: engineer_id=나 · 완료 아님 · 무료처리(waived) 아님.
  const tasks = d
    .prepare(
      `SELECT t.id, t.task_type, tr.title AS track_title,
              p.id AS project_id, p.title AS project_title, COALESCE(NULLIF(tr.artist, ''), p.artist) AS artist
         FROM track_tasks t
         JOIN project_tracks tr ON tr.id = t.track_id
         JOIN projects p ON p.id = tr.project_id
        WHERE t.engineer_id = @id AND t.status <> 'Completed' AND COALESCE(t.waived, 0) = 0
        ORDER BY t.created_at DESC, t.id DESC
        LIMIT 6`
    )
    .all({ id: me.id });
  return { name: me.name, sessions, tasks };
}

module.exports = {
  dashboardStats,
  myTodo,
};
