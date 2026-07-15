"use strict";

const express = require("express");
const { requireAuth, requireEditor, canEdit } = require("../auth");
const {
  listProjectManagers,
  listRateItems,
  getRateItem,
  listRooms,
  upcomingSessions,
  pastSessions,
  sessionsForMonth,
  getSessionCard,
  getProjectForUser,
  getSessionForUser,
  createSession,
  updateSession,
  setSessionStatus,
  setSessionWaived,
  setSessionAmount,
  setSessionEventId,
  deleteSession,
  busySessionSlots,
  sessionAttendeeEmails,
  listSessionDirectors,
  listSessionEngineers,
  contactOptions,
  partyOptions,
} = require("../data");
const { config, SESSION_TIME_SLOTS, RENTAL_SESSION_TYPES } = require("../config");
const { layout, pageHeader, esc, flashBanner, errorPage, emptyState, tabBar, searchBox, personLabel, personComboOptionsScript, personComboCompanyScript } = require("../views");
const { sessionProjectCard, monthCalendar, sessionCardModal } = require("../views.sessions");
const { safePath } = require("../lib/nav");
const { todayYmd } = require("../lib/date");
const { parseMoney } = require("../lib/forms");
const { asyncHandler } = require("../lib/async");
const calendar = require("../calendar");

const router = express.Router();

/** 세션+프로젝트 → 구글 캘린더 일정 입력(제목=제작사·아티스트, 제작사 없으면 레이블(소속사)·아티스트, 장소=관리 기본값). */
/**
 * 캘린더 이벤트 '종류' 표기 — 녹음이면 녹음 단가 항목명(예: '녹음 · 보컬녹음'),
 * 그 외 세션 종류는 '{종류} 세션'(믹싱 세션·마스터링 세션 등). 사용자 요청.
 */
function sessionTypeLabel(session) {
  const t = session.session_type;
  if (!t) return "";
  if (RENTAL_SESSION_TYPES.includes(t)) { // 녹음·촬영 = 대관 → 단가 항목명 병기
    const ri = session.rate_item_id ? getRateItem(session.rate_item_id) : null;
    return ri && ri.name ? `${t} · ${ri.name}` : `${t} 세션`;
  }
  if (t === "믹싱") return "믹스 세션"; // 사용자 표기 선호(믹싱 → 믹스)
  return `${t} 세션`;
}

function eventInputForSession(session, project) {
  const company = project.production_company || project.artist_company; // 제작사 우선, 없으면 레이블(레이블 자체 제작분)
  const baseTitle = [project.artist, company].filter(Boolean).join(" · ") || project.title || "스튜디오 세션"; // 아티스트 먼저(2026-07-05 사용자 요청 — 이전엔 회사가 먼저)
  // 취소된 세션은 캘린더에서 삭제하지 않고 제목에 '(취소)' prefix를 붙여 기록으로 남긴다(2026-07-15 사용자 요청).
  const title = session.status === "취소" ? `(취소) ${baseTitle}` : baseTitle;
  // 담당 디렉터(다대다) 이름 — 본명 (활동명) 병기(전면 병기 통일, 2026-07-05). 캘린더 설명에 포함.
  const directors = session.id ? listSessionDirectors(session.id).map((d) => personLabel(d.name, d.activity_name)).filter(Boolean) : [];
  // 담당 엔지니어(다대다, 2026-07-05) — 배정된 전원을 콤마로 병기(레거시 engineer_name은 첫 명뿐이라 여러 명일 때 누락됨).
  const engineers = session.id ? listSessionEngineers(session.id).map((e) => e.name).filter(Boolean) : [];
  const description = [
    project.title ? `프로젝트: ${project.title}` : "", // 맨 앞에 프로젝트명(2026-07-05 사용자 요청 — 캘린더 공유 시 식별용)
    session.session_type ? `종류: ${sessionTypeLabel(session)}` : "",
    session.booker_name ? `예약: ${session.booker_name}` : "",
    engineers.length ? `엔지니어: ${engineers.join(", ")}` : "",
    directors.length ? `디렉터: ${directors.join(", ")}` : "",
    session.memo ? `메모: ${session.memo}` : "",
    config.baseUrl ? `${config.baseUrl}/projects/${session.project_id}` : "",
  ].filter(Boolean).join("\n");
  const attendees = sessionAttendeeEmails(session, project); // 프로젝트 매니저·예약담당자·담당엔지니어 이메일(참석자)
  return { title, location: session.location || calendar.getStudioLocation(), description, attendees, date: session.session_date, start: session.start_time, end: session.end_time, endDate: session.all_day ? session.end_date : null };
}

/**
 * 세션 저장 후 구글 캘린더 일정 동기화(생성/수정/삭제). fail-safe(예약은 안 막힘) + 결과 반환.
 * 반환 { synced:bool, reason?:string } — synced=false면 저장 후 사용자에게 이유 안내(설정 확인).
 */
async function syncSessionEvent(user, session) {
  const project = getProjectForUser(user, session.project_id);
  if (!project) return { synced: false, reason: "프로젝트를 찾을 수 없음" };
  // 취소된 세션도 삭제하지 않고 '(취소)' 제목으로 업데이트해 기록으로 남긴다(eventInputForSession이 prefix 처리, 2026-07-15 사용자 요청).
  // 실제 세션 삭제(/delete)는 여전히 캘린더 일정도 삭제한다 — 취소(기록 유지) ≠ 삭제(제거).
  const st = calendar.syncStatus(); // 설정 수준 준비 상태(미연동/캘린더 미선택 등)
  if (!st.ok) return { synced: false, reason: st.reason };
  // 캘린더에 한 번도 올라간 적 없는(gcal_event_id NULL) 세션을 '취소'하면 새로 만들지 않는다.
  // updateEvent(null)이 createEvent로 폴백하므로, 미연동 중 만든 세션을 나중에 연동 후 취소하면
  // 없던 '(취소)' 일정이 새로 생기던 것 차단(전수 점검 2026-07-15). 이미 있는 일정만 '(취소)' 제목 반영.
  if (session.status === "취소" && !session.gcal_event_id) return { synced: true };
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
  const view = req.query.view === "list" ? "list" : "calendar"; // 기본=캘린더(서베이, 2026-07-11 사용자 요청)
  const viewTab = (v, label) =>
    `<a href="/sessions?view=${v}" class="rounded-md px-3 py-1 text-sm ${view === v ? "bg-primary text-primary-fg" : "text-muted hover:text-fg"}">${label}</a>`;
  const viewToggle = `<div class="ml-auto flex gap-0.5 rounded-lg border border-border p-0.5">${viewTab("list", "목록")}${viewTab("calendar", "캘린더")}</div>`;

  let content;
  if (view === "calendar") {
    const ym = /^\d{4}-\d{2}$/.test(req.query.month || "") ? req.query.month : todayYmd().slice(0, 7);
    content = monthCalendar(ym, sessionsForMonth(req.user, ym)); // 카드 래퍼 없이 — 캘린더는 그리드 라인으로 화면 끝까지(full)
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
    // 프로젝트별로 묶어 카드(판) 분리 — 같은 프로젝트 세션은 한 판, 다른 프로젝트는 다른 판(프로젝트 목록과 통일감).
    // 첫 등장 순서 유지 = 날짜순(가까운/최근 세션의 프로젝트가 위로).
    const groups = [];
    const gIdx = new Map();
    for (const s of activeSess) {
      if (!gIdx.has(s.project_id)) { gIdx.set(s.project_id, groups.length); groups.push([]); }
      groups[gIdx.get(s.project_id)].push(s);
    }
    // 연락처·회사 옵션 JSON은 페이지당 1회(공유 스크립트) — 행마다 편집 폼이 전체 임베드하면 목록이 수 MB로 불음(2026-07-09~10 스케일 점검).
    const optionsRef = editable && activeSess.length ? "pc-shared-contacts" : "";
    const sharedOpts = optionsRef ? personComboOptionsScript(optionsRef, contactOptions()) + personComboCompanyScript("pc-company-shared", partyOptions({ role: "company" })) : "";
    const listHtml = activeSess.length
      ? `${sharedOpts}<div class="space-y-3">${groups.map((g) => sessionProjectCard(g, { isAdmin: editable, managers, rateItems, rooms, optionsRef })).join("")}</div>`
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
  res.send(layout({ title: "일정", user: req.user, current: "/sessions", body, full: view === "calendar" }));
});

// ── 캘린더 세션 카드(팝오버 조각) — 칩 클릭 시 app.js가 fetch해 중앙 모달로 표시(2026-07-11) ──
router.get("/sessions/:id/card", requireAuth, (req, res) => {
  const s = getSessionCard(req.user, Number(req.params.id));
  if (!s) return res.status(404).send('<div class="card m-4 text-sm text-muted">세션을 찾을 수 없습니다.</div>');
  res.send(sessionCardModal(s, { canEdit: canEdit(req.user) }));
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

// ── 장소 주소 자동완성(JSON) — Google Places API(New) 백엔드 프록시 ──
// 클라가 구글 스크립트를 직접 부르지 않고(=CSP 그대로) 서버가 대신 호출·API 키 미노출. 미설정/오류는 fail-safe([]).
// 반환: [{ label(주요), sub(보조), value(채울 전체 주소) }] — app.js [data-place-suggest]가 드롭다운으로 표시·클릭 시 채움.
router.get("/sessions/place-suggest", requireEditor, asyncHandler(async (req, res) => {
  const q = String(req.query.q || "").trim();
  if (!config.placesApiKey || q.length < 2) return res.json([]);
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 4000); // 4s 타임아웃(느린 외부 API가 요청을 막지 않게)
    const r = await fetch("https://places.googleapis.com/v1/places:autocomplete", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Goog-Api-Key": config.placesApiKey },
      body: JSON.stringify({ input: q, languageCode: "ko" }),
      signal: ctrl.signal,
    });
    clearTimeout(timer);
    if (!r.ok) { console.error("[places] autocomplete 실패 HTTP " + r.status); return res.json([]); }
    const data = await r.json();
    const out = (data.suggestions || [])
      .map((s) => s.placePrediction)
      .filter(Boolean)
      .map((p) => ({
        label: (p.structuredFormat && p.structuredFormat.mainText && p.structuredFormat.mainText.text) || (p.text && p.text.text) || "",
        sub: (p.structuredFormat && p.structuredFormat.secondaryText && p.structuredFormat.secondaryText.text) || "",
        value: (p.text && p.text.text) || (p.structuredFormat && p.structuredFormat.mainText && p.structuredFormat.mainText.text) || "",
      }))
      .filter((x) => x.value)
      .slice(0, 6);
    res.json(out);
  } catch (e) {
    if (e.name !== "AbortError") console.error("[places] autocomplete 오류: " + (e && e.message)); // fail-safe
    res.json([]);
  }
}));

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
    return res.status(400).send(errorPage({ code: 400, title: "이미 청구된 세션", message: "이미 청구된 세션은 수정·삭제할 수 없습니다. 청구서를 삭제한 뒤 시도하세요.", user }));
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
  await syncSessionEvent(req.user, r); // 상태변경 캘린더 동기화(취소→'(취소)' 제목 업데이트, 삭제 아님)
  const back = safePath(req.body.return); // 캘린더 팝오버에서 완료 시 캘린더로 복귀(내부 경로만)
  res.redirect(back || `/projects/${r.project_id}?tab=sessions&flash=saved`);
}));

// ── 세션 확정 청구액 즉시 저장(2026-07-14) ── 청구 폼의 세션 금액칸을 고치면 그 자리에서 DB에 반영된다.
// 작업 금액(POST /projects/tasks/:id/amount)과 대칭. 빈 값이면 NULL로 되돌려 단가표 자동 산정으로 복귀.
// 청구된 세션은 거부(invoice_items 스냅샷이 잠금). app.js가 change 이벤트로 fetch 호출(응답은 JSON).
router.post("/sessions/:id/amount", requireEditor, (req, res) => {
  const raw = String(req.body.amount == null ? "" : req.body.amount).trim();
  const amount = raw === "" ? null : parseMoney(raw);
  try {
    const s = setSessionAmount(req.user, Number(req.params.id), amount);
    if (!s) return res.status(404).json({ ok: false });
    return res.json({ ok: true, amount: s.billing_amount });
  } catch (e) {
    if (e.message === "SESSION_INVOICED") return res.status(409).json({ ok: false, error: "SESSION_INVOICED" });
    throw e;
  }
});

// ── 세션 '청구 안 함'(무료 처리) 토글(2026-07-06 사용자 요청 — 리허설 등 의도적 무료 세션) ──
// 청구 생성 폼(청구 후보 목록)에서만 노출·되돌리기 가능.
router.post("/sessions/:id/waive", requireEditor, (req, res) => {
  let r;
  try {
    r = setSessionWaived(req.user, Number(req.params.id));
  } catch (e) {
    if (e.message === "SESSION_INVOICED") {
      const ex = getSessionForUser(req.user, Number(req.params.id));
      return res.redirect(`/projects/${ex ? ex.project_id : ""}?tab=invoice`);
    }
    throw e;
  }
  if (!r) return res.status(404).send("세션을 찾을 수 없습니다.");
  res.redirect(`/projects/${r.project_id}?tab=invoice`);
});

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
module.exports.eventInputForSession = eventInputForSession; // settings.routes.js 캘린더 재동기화 버튼에서 재사용(제목 포맷 통일)
module.exports.syncSessionEvent = syncSessionEvent; // 회귀 테스트(취소+무id 유령 일정 가드) 재사용
