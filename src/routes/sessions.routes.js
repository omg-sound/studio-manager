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
  sessionAttendeeEmails,
  listSessionDirectors,
} = require("../data");
const { config, SESSION_TIME_SLOTS } = require("../config");
const { layout, pageHeader, esc, flashBanner, errorPage, emptyState, tabBar, searchBox } = require("../views");
const { sessionRow, monthCalendar } = require("../views.sessions");
const { todayYmd } = require("../lib/date");
const { asyncHandler } = require("../lib/async");
const calendar = require("../calendar");

const router = express.Router();

/** 세션+프로젝트 → 구글 캘린더 일정 입력(제목=제작사·아티스트, 제작사 없으면 레이블(소속사)·아티스트, 장소=관리 기본값). */
function eventInputForSession(session, project) {
  const company = project.production_company || project.artist_company; // 제작사 우선, 없으면 레이블(레이블 자체 제작분)
  const title = [company, project.artist].filter(Boolean).join(" · ") || project.title || "스튜디오 세션";
  // 담당 디렉터(다대다) 이름 — 활동명 우선. 캘린더 설명에 포함.
  const directors = session.id ? listSessionDirectors(session.id).map((d) => d.activity_name || d.name).filter(Boolean) : [];
  const description = [
    session.session_type ? `종류: ${session.session_type}` : "",
    session.booker_name ? `예약: ${session.booker_name}` : "",
    session.engineer_name ? `엔지니어: ${session.engineer_name}` : "",
    directors.length ? `디렉터: ${directors.join(", ")}` : "",
    session.memo ? `메모: ${session.memo}` : "",
    config.baseUrl ? `${config.baseUrl}/projects/${session.project_id}` : "",
  ].filter(Boolean).join("\n");
  const attendees = sessionAttendeeEmails(session, project); // 프로젝트 매니저·예약담당자·담당엔지니어 이메일(참석자)
  return { title, location: calendar.getStudioLocation(), description, attendees, date: session.session_date, start: session.start_time, end: session.end_time };
}

/**
 * 세션 저장 후 구글 캘린더 일정 동기화(생성/수정/삭제). fail-safe(예약은 안 막힘) + 결과 반환.
 * 반환 { synced:bool, reason?:string } — synced=false면 저장 후 사용자에게 이유 안내(설정 확인).
 */
async function syncSessionEvent(user, session) {
  const project = getProjectForUser(user, session.project_id);
  if (!project) return { synced: false, reason: "프로젝트를 찾을 수 없음" };
  if (session.status === "취소") {
    try { if (session.gcal_event_id) { await calendar.deleteEvent(session.gcal_event_id); setSessionEventId(session.id, null); } } catch (_e) {}
    return { synced: true }; // 취소는 삭제 동기화(또는 원래 없었음)
  }
  const st = calendar.syncStatus(); // 설정 수준 준비 상태(미연동/캘린더 미선택 등)
  if (!st.ok) return { synced: false, reason: st.reason };
  try {
    const newId = await calendar.updateEvent(session.gcal_event_id || null, eventInputForSession(session, project));
    if (newId && newId !== session.gcal_event_id) setSessionEventId(session.id, newId);
    if (!newId) return { synced: false, reason: "구글 캘린더 API 오류(서버 로그 확인)" };
    return { synced: true };
  } catch (e) {
    console.error("[sessions] 캘린더 동기화 실패 —", (e && e.message) || e);
    return { synced: false, reason: "동기화 중 오류(서버 로그 확인)" };
  }
}

/** 세션 시간 겹침 안내 페이지(409, 앱 내부 세션끼리 · 같은 룸). */
function sessionConflictMessage(c, user) {
  const when = [c.session_date, [c.start_time, c.end_time].filter(Boolean).join("–")].filter(Boolean).join(" ");
  const room = c.room_name || "룸 미지정";
  return errorPage({
    code: 409,
    title: "세션 시간이 겹칩니다",
    message: `같은 룸(${room})에 이미 같은 시간대 ${c.session_type} 세션이 있습니다 — ${c.project_title} (${when}). 다른 시간이나 다른 룸으로 예약하세요.`,
    user,
  });
}

// ── 전역 일정(다가오는 세션 + 지난 세션) ──
router.get("/sessions", requireAuth, (req, res) => {
  const editable = canEdit(req.user);
  const view = req.query.view === "calendar" ? "calendar" : "list";
  const viewTab = (v, label) =>
    `<a href="/sessions?view=${v}" class="rounded-md px-3 py-1 text-sm ${view === v ? "bg-primary text-primary-fg" : "text-muted hover:text-fg"}">${label}</a>`;
  const viewToggle = `<div class="ml-auto flex gap-0.5 rounded-lg border border-border p-0.5">${viewTab("list", "목록")}${viewTab("calendar", "캘린더")}</div>`;

  let content;
  if (view === "calendar") {
    const ym = /^\d{4}-\d{2}$/.test(req.query.month || "") ? req.query.month : todayYmd().slice(0, 7);
    content = `<div class="card">${monthCalendar(ym, sessionsForMonth(req.user, ym))}</div>`;
  } else {
    const managers = editable ? listProjectManagers() : [];
    const rateItems = editable ? listRateItems() : [];
    const rooms = editable ? listRooms() : [];
    // 이름/프로젝트 검색(?q=): 조회된 목록을 프로젝트명·예약자·엔지니어·종류·메모로 필터(인메모리, 대소문자 무시).
    const q = String(req.query.q || "").trim();
    const ql = q.toLowerCase();
    const matchesQ = (s) =>
      !ql ||
      [s.project_title, s.artist, s.artist_company, s.production_company, s.booker_name, s.engineer_name, s.session_type, s.memo]
        .filter(Boolean).join(" ").toLowerCase().includes(ql);
    const up = upcomingSessions(req.user, { limit: 50 }).filter(matchesQ);
    const past = pastSessions(req.user, { limit: 20 }).filter(matchesQ);
    // 접기 섹션 → 탭바(일정=다가오는 / 지난 세션). ?stab=upcoming(기본)/past, view=list·검색어 유지.
    const stab = req.query.stab === "past" ? "past" : "upcoming";
    const searchBoxHtml = searchBox({
      action: "/sessions", q, placeholder: "프로젝트 · 예약 담당자 · 엔지니어 검색", label: "세션 검색",
      suggestUrl: "/sessions/suggest",
      hidden: `<input type="hidden" name="view" value="list" /><input type="hidden" name="stab" value="${esc(stab)}" />`,
    });
    const resultNote = q
      ? `<div class="mb-3 text-sm text-muted">"${esc(q)}" 결과 ${up.length + past.length}건 · <a href="/sessions?view=list" class="text-primary hover:underline">전체 보기</a></div>`
      : "";
    const sessTabs = tabBar({
      tabs: [
        { key: "upcoming", label: `일정 ${up.length}` },
        { key: "past", label: `지난 세션 ${past.length}` },
      ],
      activeKey: stab,
      hrefFn: (k) => `/sessions?view=list&stab=${k}${q ? "&q=" + encodeURIComponent(q) : ""}`,
    });
    const activeSess = stab === "past" ? past : up;
    const listHtml = activeSess.length
      ? `<div class="card"><div class="space-y-2">${activeSess.map((s) => sessionRow(s, { isAdmin: editable, managers, rateItems, rooms, showProject: true })).join("")}</div></div>`
      : emptyState(
          stab === "past" ? "지난 세션이 없습니다." : q ? "검색 결과가 없습니다." : "다가오는 세션이 없습니다. 프로젝트 상세에서 세션을 추가하세요.",
          { card: true }
        );
    content = `${searchBoxHtml}${resultNote}${sessTabs}${listHtml}`;
  }

  const body = `
    ${flashBanner(req.query)}
    ${pageHeader({ title: "일정", desc: "스튜디오 세션(녹음 · 믹싱 · 마스터링)", action: viewToggle })}
    ${content}`;
  res.send(layout({ title: "일정", user: req.user, current: "/sessions", body }));
});

// ── 검색 제안(typeahead JSON) — 다가오는+지난 세션에서 매칭 → 프로젝트 세션 탭으로 이동 ──
router.get("/sessions/suggest", requireAuth, (req, res) => {
  const ql = String(req.query.q || "").trim().toLowerCase();
  if (!ql) return res.json([]);
  const all = [...upcomingSessions(req.user, { limit: 100 }), ...pastSessions(req.user, { limit: 100 })];
  const match = (s) =>
    [s.project_title, s.artist, s.artist_company, s.production_company, s.booker_name, s.engineer_name, s.session_type, s.memo]
      .filter(Boolean).join(" ").toLowerCase().includes(ql);
  const rows = all.filter(match).slice(0, 8);
  res.json(rows.map((s) => ({
    label: s.project_title || s.session_type,
    sub: [s.session_date, s.session_type, s.engineer_name].filter(Boolean).join(" · "),
    href: `/projects/${s.project_id}?tab=sessions`,
  })));
});

// ── 시간 슬롯 가용성(JSON) — 시작 버튼 그리드 비활성 표시용 ──
// 그 날짜에 이미 예약된(앱 DB 세션 + 구글 캘린더) 30분 슬롯을 반환. 외부 캘린더 오류는 fail-open([]).
router.get("/sessions/availability", requireEditor, asyncHandler(async (req, res) => {
  const date = String(req.query.date || "");
  const excludeId = Number(req.query.exclude) || null;
  const room = req.query.room !== undefined && req.query.room !== "" ? Number(req.query.room) : undefined;
  const dbBusy = busySessionSlots(date, SESSION_TIME_SLOTS, { excludeId, room });
  const calBusy = await calendar.busySlotsForDate(date, SESSION_TIME_SLOTS);
  const busy = Array.from(new Set([...dbBusy, ...calBusy])).sort();
  res.json({ date, slots: SESSION_TIME_SLOTS, busy });
}));

function sessionInputError(e, res, user) {
  if (e.message === "SESSION_DATE_REQUIRED")
    return res.status(400).send(errorPage({ code: 400, title: "세션 날짜가 필요합니다", message: "세션 날짜를 입력하세요.", user }));
  if (e.message === "SESSION_TIME_CONFLICT") return res.status(409).send(sessionConflictMessage(e.conflict, user));
  if (e.message === "SESSION_INVOICED")
    return res.status(400).send(errorPage({ code: 400, title: "이미 청구된 세션", message: "이미 청구된 세션은 수정·삭제할 수 없습니다. 인보이스를 삭제한 뒤 시도하세요.", user }));
  throw e;
}

// ── 세션 추가(프로젝트 하위) ──
router.post("/sessions", requireEditor, asyncHandler(async (req, res) => {
  let s;
  try {
    s = createSession(req.user, Number(req.body.project_id), req.body); // 내부 겹침 검사 + 종료 자동계산
  } catch (e) {
    return sessionInputError(e, res, req.user);
  }
  if (!s) return res.status(404).send("프로젝트를 찾을 수 없습니다.");
  // 다중 룸 도입: 단일 스튜디오 캘린더는 룸을 구분하지 못해 다른 룸 일정으로 오탐 차단이 생긴다.
  // → 구글 FreeBusy 하드 차단은 비활성화하고, 룸별 겹침(앱 DB, createSession 내부 검사)을 정식 차단으로 삼는다.
  //   구글 캘린더 일정 자동 생성/수정/삭제 동기화는 그대로 유지.
  const cal = await syncSessionEvent(req.user, s); // 구글 캘린더에 일정 자동 생성 + 결과
  res.redirect(`/projects/${s.project_id}?tab=sessions&flash=${cal && cal.synced === false ? "added_cal_off" : "added"}`);
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
    return sessionInputError(e, res, req.user);
  }
  if (!s) return res.status(404).send("세션을 찾을 수 없습니다.");
  const cal = await syncSessionEvent(req.user, s); // 일정 수정(취소면 삭제, id 없으면 생성) + 결과
  res.redirect(`/projects/${s.project_id}?tab=sessions&flash=${cal && cal.synced === false ? "saved_cal_off" : "saved"}`);
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
    return sessionInputError(e, res, req.user);
  }
  if (!r) return res.status(404).send("세션을 찾을 수 없습니다.");
  if (existing && existing.gcal_event_id) await calendar.deleteEvent(existing.gcal_event_id);
  res.redirect(`/projects/${r.project_id}?tab=sessions&flash=deleted`);
}));

module.exports = router;
