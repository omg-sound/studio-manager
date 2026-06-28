"use strict";

const express = require("express");
const { requireAuth, requireEditor, canEdit } = require("../auth");
const {
  listProjectManagers,
  listRateItems,
  upcomingSessions,
  pastSessions,
  getProjectForUser,
  getSessionForUser,
  createSession,
  updateSession,
  setSessionStatus,
  setSessionEventId,
  deleteSession,
  createTaskFromSession,
  busySessionSlots,
} = require("../data");
const { config, SESSION_TIME_SLOTS } = require("../config");
const { layout, pageHeader, esc, flashBanner, errorPage } = require("../views");
const { sessionRow } = require("../views.sessions");
const { asyncHandler } = require("../lib/async");
const calendar = require("../calendar");

const router = express.Router();

/** 세션+프로젝트 → 구글 캘린더 일정 입력(제목=제작사·아티스트, 장소=관리 기본값). */
function eventInputForSession(session, project) {
  const title = [project.production_company, project.artist].filter(Boolean).join(" · ") || project.title || "스튜디오 세션";
  const description = [
    session.session_type ? `종류: ${session.session_type}` : "",
    session.booker_name ? `예약: ${session.booker_name}` : "",
    session.engineer_name ? `엔지니어: ${session.engineer_name}` : "",
    session.memo ? `메모: ${session.memo}` : "",
    config.baseUrl ? `${config.baseUrl}/projects/${session.project_id}` : "",
  ].filter(Boolean).join("\n");
  return { title, location: calendar.getStudioLocation(), description, date: session.session_date, start: session.start_time, end: session.end_time };
}

/** 세션 저장 후 구글 캘린더 일정 동기화(생성/수정/삭제). 미연동/오류는 조용히 무시(fail-safe). */
async function syncSessionEvent(user, session) {
  const project = getProjectForUser(user, session.project_id);
  if (!project) return;
  if (session.status === "취소") {
    if (session.gcal_event_id) {
      await calendar.deleteEvent(session.gcal_event_id);
      setSessionEventId(session.id, null);
    }
    return;
  }
  const newId = await calendar.updateEvent(session.gcal_event_id || null, eventInputForSession(session, project));
  if (newId && newId !== session.gcal_event_id) setSessionEventId(session.id, newId);
}

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

function sessionInputError(e, res) {
  if (e.message === "SESSION_DATE_REQUIRED") return res.status(400).send("세션 날짜를 입력하세요.");
  if (e.message === "SESSION_PRO_NEEDS_RATE") return res.status(400).send("1Pro·2Pro는 단가 항목을 먼저 선택하세요(기준시간 필요). 또는 '직접입력'을 쓰세요.");
  if (e.message === "SESSION_TIME_CONFLICT") return res.status(409).send(sessionConflictMessage(e.conflict));
  throw e;
}

// ── 세션 추가(프로젝트 하위) ──
router.post("/sessions", requireEditor, asyncHandler(async (req, res) => {
  let s;
  try {
    s = createSession(req.user, Number(req.body.project_id), req.body); // 내부 겹침 검사 + 종료 자동계산
  } catch (e) {
    return sessionInputError(e, res);
  }
  if (!s) return res.status(404).send("프로젝트를 찾을 수 없습니다.");
  // 외부(구글) 캘린더 겹침 — 해석된 시작/종료 기준. 겹치면 방금 만든 세션 롤백(fail-open: 미연동 시 통과).
  const ext = await calendar.findExternalConflict({ date: s.session_date, start: s.start_time, end: s.end_time });
  if (ext) {
    deleteSession(req.user, s.id);
    return res.status(409).send(externalConflictMessage());
  }
  await syncSessionEvent(req.user, s); // 구글 캘린더에 일정 자동 생성
  res.redirect(`/projects/${s.project_id}?tab=sessions&flash=added`);
}));

// ── 세션 수정 ──
router.post("/sessions/:id", requireEditor, asyncHandler(async (req, res) => {
  let s;
  try {
    s = updateSession(req.user, Number(req.params.id), req.body);
  } catch (e) {
    return sessionInputError(e, res);
  }
  if (!s) return res.status(404).send("세션을 찾을 수 없습니다.");
  await syncSessionEvent(req.user, s); // 일정 수정(취소면 삭제, id 없으면 생성)
  res.redirect(`/projects/${s.project_id}?tab=sessions&flash=saved`);
}));

// ── 상태 토글(예정 ↔ 완료) ──
router.post("/sessions/:id/status", requireEditor, (req, res) => {
  const r = setSessionStatus(req.user, Number(req.params.id), req.body.status);
  if (!r) return res.status(404).send("세션을 찾을 수 없습니다.");
  res.redirect(`/projects/${r.project_id}?tab=sessions&flash=saved`);
});

// ── 세션 삭제 ──
router.post("/sessions/:id/delete", requireEditor, asyncHandler(async (req, res) => {
  const id = Number(req.params.id);
  const existing = getSessionForUser(req.user, id); // 일정 삭제용 gcal_event_id 확보
  const r = deleteSession(req.user, id);
  if (!r) return res.status(404).send("세션을 찾을 수 없습니다.");
  if (existing && existing.gcal_event_id) await calendar.deleteEvent(existing.gcal_event_id);
  res.redirect(`/projects/${r.project_id}?tab=sessions&flash=deleted`);
}));

// ── 세션 → 청구 작업 생성(녹음 시간제) ──
router.post("/sessions/:id/bill", requireEditor, (req, res) => {
  try {
    const r = createTaskFromSession(req.user, Number(req.params.id), {
      trackId: req.body.track_id,
      newTrackTitle: req.body.new_track_title,
    });
    if (!r) return res.status(404).send("세션을 찾을 수 없습니다.");
    res.redirect(`/projects/${r.project_id}?tab=invoice&flash=billed`);
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
