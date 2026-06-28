"use strict";

const express = require("express");
const { requireAuth, requireEditor, canEdit } = require("../auth");
const {
  listProjectManagers,
  listRateItems,
  upcomingSessions,
  pastSessions,
  createSession,
  updateSession,
  setSessionStatus,
  deleteSession,
  createTaskFromSession,
  busySessionSlots,
} = require("../data");
const { SESSION_TIME_SLOTS } = require("../config");
const { layout, pageHeader, esc, flashBanner, errorPage } = require("../views");
const { sessionRow } = require("../views.sessions");
const { asyncHandler } = require("../lib/async");
const calendar = require("../calendar");

const router = express.Router();

/** 세션 시간 겹침 안내 페이지(409, 앱 내부 세션끼리). */
function sessionConflictMessage(c) {
  const when = [c.session_date, [c.start_time, c.end_time].filter(Boolean).join("–")].filter(Boolean).join(" ");
  return errorPage({
    code: 409,
    title: "세션 시간이 겹칩니다",
    message: `이미 같은 시간대에 ${c.session_type} 세션이 있습니다 — ${c.project_title} (${when}). 다른 시간으로 예약하세요.`,
    user: null,
  });
}

/** 외부(구글) 캘린더 일정과 겹칠 때 안내 페이지(409). */
function externalConflictMessage() {
  return errorPage({
    code: 409,
    title: "구글 캘린더 일정과 겹칩니다",
    message: "선택한 시간에 스튜디오 캘린더에 이미 잡힌 일정이 있습니다. 다른 시간으로 예약하세요.",
    user: null,
  });
}

// ── 전역 일정(다가오는 세션 + 지난 세션) ──
router.get("/sessions", requireAuth, (req, res) => {
  const editable = canEdit(req.user);
  const managers = editable ? listProjectManagers() : [];
  const rateItems = editable ? listRateItems() : [];
  const up = upcomingSessions(req.user, { limit: 50 });
  const past = pastSessions(req.user, { limit: 20 });

  const upList = up.length
    ? `<div class="card"><div class="space-y-2">${up.map((s) => sessionRow(s, { isAdmin: editable, managers, rateItems, showProject: true })).join("")}</div></div>`
    : `<div class="card text-center text-sm text-muted">다가오는 세션이 없습니다. 프로젝트 상세에서 세션을 추가하세요.</div>`;

  const pastList = past.length
    ? `<details class="card mt-3">
         <summary class="flex cursor-pointer list-none items-center justify-between gap-3">
           <h2 class="font-display text-base font-semibold">지난 세션 <span class="text-sm font-normal text-muted">${past.length}</span></h2>
           <span class="text-xs text-muted">열기</span>
         </summary>
         <div class="mt-3 space-y-2 border-t border-border pt-3">${past.map((s) => sessionRow(s, { isAdmin: editable, managers, rateItems, showProject: true })).join("")}</div>
       </details>`
    : "";

  const body = `
    ${flashBanner(req.query)}
    ${pageHeader({ title: "일정", desc: "스튜디오 세션(녹음 · 믹싱 · 마스터링)" })}
    ${upList}
    ${pastList}`;
  res.send(layout({ title: "일정", user: req.user, current: "/sessions", body }));
});

// ── 시간 슬롯 가용성(JSON) — 시작 버튼 그리드 비활성 표시용 ──
// 그 날짜에 이미 예약된(앱 DB 세션 + 구글 캘린더) 30분 슬롯을 반환. 외부 캘린더 오류는 fail-open([]).
router.get("/sessions/availability", requireEditor, asyncHandler(async (req, res) => {
  const date = String(req.query.date || "");
  const excludeId = Number(req.query.exclude) || null;
  const dbBusy = busySessionSlots(date, SESSION_TIME_SLOTS, { excludeId });
  const calBusy = await calendar.busySlotsForDate(date, SESSION_TIME_SLOTS);
  const busy = Array.from(new Set([...dbBusy, ...calBusy])).sort();
  res.json({ date, slots: SESSION_TIME_SLOTS, busy });
}));

// ── 세션 추가(프로젝트 하위) ──
router.post("/sessions", requireEditor, asyncHandler(async (req, res) => {
  try {
    // 신규 예약: 외부(구글) 캘린더 겹침 먼저 검사(미연동/오류는 fail-open).
    const ext = await calendar.findExternalConflict({
      date: req.body.session_date,
      start: req.body.start_time,
      end: req.body.end_time,
    });
    if (ext) return res.status(409).send(externalConflictMessage());
    const s = createSession(req.user, Number(req.body.project_id), req.body);
    if (!s) return res.status(404).send("프로젝트를 찾을 수 없습니다.");
    res.redirect(`/projects/${s.project_id}?flash=added`);
  } catch (e) {
    if (e.message === "SESSION_DATE_REQUIRED") return res.status(400).send("세션 날짜를 입력하세요.");
    if (e.message === "SESSION_PRO_NEEDS_RATE") return res.status(400).send("1Pro·2Pro는 단가 항목을 먼저 선택하세요(기준시간 필요). 또는 '직접입력'을 쓰세요.");
    if (e.message === "SESSION_TIME_CONFLICT") return res.status(409).send(sessionConflictMessage(e.conflict));
    throw e;
  }
}));

// ── 세션 수정 ──
router.post("/sessions/:id", requireEditor, (req, res) => {
  try {
    const s = updateSession(req.user, Number(req.params.id), req.body);
    if (!s) return res.status(404).send("세션을 찾을 수 없습니다.");
    res.redirect(`/projects/${s.project_id}?flash=saved`);
  } catch (e) {
    if (e.message === "SESSION_DATE_REQUIRED") return res.status(400).send("세션 날짜를 입력하세요.");
    if (e.message === "SESSION_PRO_NEEDS_RATE") return res.status(400).send("1Pro·2Pro는 단가 항목을 먼저 선택하세요(기준시간 필요). 또는 '직접입력'을 쓰세요.");
    if (e.message === "SESSION_TIME_CONFLICT") return res.status(409).send(sessionConflictMessage(e.conflict));
    throw e;
  }
});

// ── 상태 토글(예정 ↔ 완료) ──
router.post("/sessions/:id/status", requireEditor, (req, res) => {
  const r = setSessionStatus(req.user, Number(req.params.id), req.body.status);
  if (!r) return res.status(404).send("세션을 찾을 수 없습니다.");
  res.redirect(`/projects/${r.project_id}?flash=saved`);
});

// ── 세션 삭제 ──
router.post("/sessions/:id/delete", requireEditor, (req, res) => {
  const r = deleteSession(req.user, Number(req.params.id));
  if (!r) return res.status(404).send("세션을 찾을 수 없습니다.");
  res.redirect(`/projects/${r.project_id}?flash=deleted`);
});

// ── 세션 → 청구 작업 생성(녹음 시간제) ──
router.post("/sessions/:id/bill", requireEditor, (req, res) => {
  try {
    const r = createTaskFromSession(req.user, Number(req.params.id), {
      trackId: req.body.track_id,
      newTrackTitle: req.body.new_track_title,
    });
    if (!r) return res.status(404).send("세션을 찾을 수 없습니다.");
    res.redirect(`/projects/${r.project_id}?flash=billed`);
  } catch (e) {
    const map = {
      SESSION_NOT_COMPLETED: "완료된 세션만 청구 작업으로 만들 수 있습니다.",
      SESSION_NOT_BILLABLE: "녹음 세션에 단가 항목과 진행시간(시작·종료)이 있어야 청구 작업을 만들 수 있습니다.",
      SESSION_ALREADY_BILLED: "이미 이 세션으로 청구 작업을 생성했습니다.",
      TRACK_NOT_FOUND: "곡·콘텐츠를 찾을 수 없습니다.",
    };
    if (map[e.message]) return res.status(400).send(map[e.message]);
    throw e;
  }
});

module.exports = router;
