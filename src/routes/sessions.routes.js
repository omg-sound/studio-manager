"use strict";

const express = require("express");
const { requireAuth, requireEditor, canEdit } = require("../auth");
const {
  listProjectManagers,
  listRateItems,
  listRooms,
  upcomingSessions,
  pastSessions,
  sessionsForMonth,
  getProjectForUser,
  getSessionForUser,
  createSession,
  updateSession,
  setSessionStatus,
  setSessionEventId,
  deleteSession,
  busySessionSlots,
} = require("../data");
const { config, SESSION_TIME_SLOTS } = require("../config");
const { layout, pageHeader, esc, flashBanner, errorPage, emptyState, detailsChevron } = require("../views");
const { sessionRow, monthCalendar } = require("../views.sessions");
const { todayYmd } = require("../lib/date");
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

/** 세션 시간 겹침 안내 페이지(409, 앱 내부 세션끼리 · 같은 룸). */
function sessionConflictMessage(c) {
  const when = [c.session_date, [c.start_time, c.end_time].filter(Boolean).join("–")].filter(Boolean).join(" ");
  const room = c.room_name || "룸 미지정";
  return errorPage({
    code: 409,
    title: "세션 시간이 겹칩니다",
    message: `같은 룸(${room})에 이미 같은 시간대 ${c.session_type} 세션이 있습니다 — ${c.project_title} (${when}). 다른 시간이나 다른 룸으로 예약하세요.`,
    user: null,
  });
}

// ── 전역 일정(다가오는 세션 + 지난 세션) ──
router.get("/sessions", requireAuth, (req, res) => {
  const editable = canEdit(req.user);
  const view = req.query.view === "calendar" ? "calendar" : "list";
  const viewTab = (v, label) =>
    `<a href="/sessions?view=${v}" class="rounded-md px-3 py-1 text-sm ${view === v ? "bg-primary text-primary-fg" : "text-muted hover:text-fg"}">${label}</a>`;
  const viewToggle = `<div class="flex gap-0.5 rounded-lg border border-border p-0.5">${viewTab("list", "목록")}${viewTab("calendar", "캘린더")}</div>`;

  let content;
  if (view === "calendar") {
    const ym = /^\d{4}-\d{2}$/.test(req.query.month || "") ? req.query.month : todayYmd().slice(0, 7);
    content = `<div class="card">${monthCalendar(ym, sessionsForMonth(req.user, ym))}</div>`;
  } else {
    const managers = editable ? listProjectManagers() : [];
    const rateItems = editable ? listRateItems() : [];
    const rooms = editable ? listRooms() : [];
    const up = upcomingSessions(req.user, { limit: 50 });
    const past = pastSessions(req.user, { limit: 20 });
    const upList = up.length
      ? `<div class="card"><div class="space-y-2">${up.map((s) => sessionRow(s, { isAdmin: editable, managers, rateItems, rooms, showProject: true })).join("")}</div></div>`
      : emptyState("다가오는 세션이 없습니다. 프로젝트 상세에서 세션을 추가하세요.", { card: true });
    const pastList = past.length
      ? `<details class="card group mt-3">
           <summary class="flex cursor-pointer list-none items-center justify-between gap-3">
             <h2 class="font-display text-base font-semibold">지난 세션 <span class="text-sm font-normal text-muted">${past.length}</span></h2>
             ${detailsChevron()}
           </summary>
           <div class="mt-3 space-y-2 border-t border-border pt-3">${past.map((s) => sessionRow(s, { isAdmin: editable, managers, rateItems, rooms, showProject: true })).join("")}</div>
         </details>`
      : "";
    content = `${upList}${pastList}`;
  }

  const body = `
    ${flashBanner(req.query)}
    ${pageHeader({ title: "일정", desc: "스튜디오 세션(녹음 · 믹싱 · 마스터링)", action: viewToggle })}
    ${content}`;
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
  if (e.message === "SESSION_INVOICED") return res.status(400).send("이미 청구된 세션은 수정·삭제할 수 없습니다. 인보이스를 삭제한 뒤 시도하세요.");
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
  // 다중 룸 도입: 단일 스튜디오 캘린더는 룸을 구분하지 못해 다른 룸 일정으로 오탐 차단이 생긴다.
  // → 구글 FreeBusy 하드 차단은 비활성화하고, 룸별 겹침(앱 DB, createSession 내부 검사)을 정식 차단으로 삼는다.
  //   구글 캘린더 일정 자동 생성/수정/삭제 동기화는 그대로 유지.
  await syncSessionEvent(req.user, s); // 구글 캘린더에 일정 자동 생성
  res.redirect(`/projects/${s.project_id}?tab=sessions&flash=added`);
}));

// ── 세션 수정 ──
router.post("/sessions/:id", requireEditor, asyncHandler(async (req, res) => {
  let s;
  try {
    s = updateSession(req.user, Number(req.params.id), req.body);
  } catch (e) {
    if (e.message === "SESSION_INVOICED") {
      const ex = getSessionForUser(req.user, Number(req.params.id));
      return res.redirect(`/projects/${ex ? ex.project_id : ""}?tab=sessions&error=session_invoiced`);
    }
    return sessionInputError(e, res);
  }
  if (!s) return res.status(404).send("세션을 찾을 수 없습니다.");
  await syncSessionEvent(req.user, s); // 일정 수정(취소면 삭제, id 없으면 생성)
  res.redirect(`/projects/${s.project_id}?tab=sessions&flash=saved`);
}));

// ── 상태 토글(예정 ↔ 완료 ↔ 취소) ──
router.post("/sessions/:id/status", requireEditor, asyncHandler(async (req, res) => {
  let r;
  try {
    r = setSessionStatus(req.user, Number(req.params.id), req.body.status);
  } catch (e) {
    if (e.message === "SESSION_INVOICED") {
      const ex = getSessionForUser(req.user, Number(req.params.id));
      return res.redirect(`/projects/${ex ? ex.project_id : ""}?tab=sessions&error=session_invoiced`);
    }
    throw e;
  }
  if (!r) return res.status(404).send("세션을 찾을 수 없습니다.");
  await syncSessionEvent(req.user, r); // 상태변경(취소→일정 삭제) 캘린더 동기화
  res.redirect(`/projects/${r.project_id}?tab=sessions&flash=saved`);
}));

// ── 세션 삭제 ──
router.post("/sessions/:id/delete", requireEditor, asyncHandler(async (req, res) => {
  const id = Number(req.params.id);
  const existing = getSessionForUser(req.user, id); // 일정 삭제용 gcal_event_id 확보
  let r;
  try {
    r = deleteSession(req.user, id);
  } catch (e) {
    if (e.message === "SESSION_INVOICED") {
      return res.redirect(`/projects/${existing ? existing.project_id : ""}?tab=sessions&error=session_invoiced`);
    }
    return sessionInputError(e, res);
  }
  if (!r) return res.status(404).send("세션을 찾을 수 없습니다.");
  if (existing && existing.gcal_event_id) await calendar.deleteEvent(existing.gcal_event_id);
  res.redirect(`/projects/${r.project_id}?tab=sessions&flash=deleted`);
}));

module.exports = router;
