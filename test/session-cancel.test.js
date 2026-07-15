"use strict";

// ── 세션 취소 = 캘린더에서 삭제하지 않고 '(취소)' 제목 prefix로 기록 유지(2026-07-15 사용자 요청) ──
// eventInputForSession이 status==="취소"면 제목 앞에 "(취소) "를 붙이고, syncSessionEvent는 삭제 대신
// 이 제목으로 updateEvent(취소 분기 제거) — 취소(기록 유지) ≠ 세션 삭제(/delete는 여전히 이벤트 삭제).
process.env.NODE_ENV = "test";
const { tempDbPath, cleanupDb } = require("./helpers");
process.env.DB_PATH = tempDbPath();

const test = require("node:test");
const assert = require("node:assert");
const { init } = require("../src/db");
init();
const { eventInputForSession } = require("../src/routes/sessions.routes");
const { sessionCardModal, sessionProjectCard, monthCalendar } = require("../src/views.sessions");

const project = { title: "루나 1집", artist: "루나", production_company: "뮤직팜", project_id: 5 };
const base = { id: 0, project_id: 5, session_type: "녹음", session_date: "2026-08-01", start_time: "14:00", end_time: "18:00" };
const titleOf = (status) => eventInputForSession({ ...base, status }, project).title;

test("eventInputForSession: 취소면 제목에 '(취소)' prefix, 예정·완료는 없음", () => {
  assert.equal(titleOf("예정"), "루나 · 뮤직팜", "예정: prefix 없음");
  assert.equal(titleOf("완료"), "루나 · 뮤직팜", "완료: prefix 없음");
  assert.equal(titleOf("취소"), "(취소) 루나 · 뮤직팜", "취소: '(취소)' prefix");
});

test("sessionCardModal: 편집자 취소/취소 해제 버튼(상태별), 비편집자는 없음", () => {
  const modal = (status, canEdit) => sessionCardModal({ ...base, status, billing: null }, { title: "루나 · 뮤직팜", canEdit });
  const sched = modal("예정", true);
  assert.match(sched, /name="status" value="취소"/, "예정: status=취소 전송");
  assert.match(sched, />취소<\/button>/, "예정: '취소' 버튼");
  assert.match(sched, /data-confirm="이 세션을 취소할까요/, "예정: 취소 확인창");
  const cancelled = modal("취소", true);
  assert.match(cancelled, /name="status" value="예정"/, "취소: status=예정(되돌리기)");
  assert.match(cancelled, /취소 해제/, "취소: '취소 해제' 버튼");
  assert.doesNotMatch(modal("예정", false), />취소<\/button>/, "비편집자: 취소 버튼 없음");
});

test("sessionProjectCard: 취소된 세션 행은 흐리게(opacity-60), 예정은 아님", () => {
  const row = (status) => ({ id: 1, project_id: 5, status, session_date: "2026-08-01", session_type: "녹음", start_time: "14:00", end_time: "18:00", artist: "루나", production_company: "뮤직팜", billing: null });
  assert.match(sessionProjectCard([row("취소")], { isAdmin: true }), /bg-surface opacity-60/, "취소: 컨테이너 opacity-60");
  assert.doesNotMatch(sessionProjectCard([row("예정")], { isAdmin: true }), /bg-surface opacity-60/, "예정: 흐리지 않음");
});

test("monthCalendar: 취소된 세션 칩도 흐리게(opacity-60), 예정은 아님", () => {
  const chip = (status) => ({ id: 1, project_id: 5, status, session_date: "2026-08-15", session_type: "녹음", project_title: "루나 1집", start_time: "14:00", artist: "루나" });
  assert.match(monthCalendar("2026-08", [chip("취소")]), /sm:text-xs opacity-60/, "취소 칩: opacity-60");
  assert.doesNotMatch(monthCalendar("2026-08", [chip("예정")]), /opacity-60/, "예정 칩: 흐리지 않음");
});

// sessionsForMonth가 취소 세션을 포함해야 monthCalendar의 opacity-60 칩이 실제로 렌더된다
// (이전엔 status <> '취소'로 걸러 캘린더에서 아예 안 보여 흐리게 표시 코드가 죽어 있었음, 전수 점검 2026-07-15).
test("sessionsForMonth: 취소 세션도 캘린더 결과에 포함(흐리게 표시용)", () => {
  const { db } = require("../src/db");
  const d = db();
  const pid = Number(d.prepare("INSERT INTO projects (title, project_type) VALUES ('취소캘린더','session')").run().lastInsertRowid);
  d.prepare("INSERT INTO sessions (project_id, session_type, session_date, status) VALUES (?, '녹음', '2099-03-10', '예정')").run(pid);
  d.prepare("INSERT INTO sessions (project_id, session_type, session_date, status) VALUES (?, '녹음', '2099-03-11', '취소')").run(pid);
  const { sessionsForMonth } = require("../src/data/sessions");
  const rows = sessionsForMonth(null, "2099-03").filter((s) => s.project_id === pid);
  assert.equal(rows.length, 2, "예정+취소 둘 다 캘린더 결과에 포함");
  assert.ok(rows.some((s) => s.status === "취소"), "취소 세션 포함");
});

// 취소 세션 캘린더 동기화: gcal_event_id가 없으면(캘린더에 한 번도 없던 세션) updateEvent를 부르지 않는다.
// updateEvent(null)이 createEvent로 폴백해 없던 '(취소)' 일정을 새로 만들던 것 차단(전수 점검 2026-07-15).
test("syncSessionEvent: 취소+무id는 updateEvent 미호출(유령 일정 방지), id 있으면 호출", async () => {
  const { db } = require("../src/db");
  const calendar = require("../src/calendar");
  const { syncSessionEvent } = require("../src/routes/sessions.routes");
  const pid = Number(db().prepare("INSERT INTO projects (title, project_type, artist) VALUES ('취소싱크','session','루나')").run().lastInsertRowid);

  const origStatus = calendar.syncStatus, origUpdate = calendar.updateEvent;
  let updateCalls = 0;
  calendar.syncStatus = () => ({ ok: true });
  calendar.updateEvent = async () => { updateCalls++; return "evt-new"; };
  try {
    const noId = await syncSessionEvent(null, { id: 1, project_id: pid, status: "취소", gcal_event_id: null, session_date: "2099-01-01" });
    assert.deepEqual(noId, { synced: true }, "취소+무id: 정상 반환");
    assert.equal(updateCalls, 0, "취소+무id: updateEvent 미호출(유령 일정 안 만듦)");
    await syncSessionEvent(null, { id: 2, project_id: pid, status: "취소", gcal_event_id: "evt-123", session_date: "2099-01-01" });
    assert.equal(updateCalls, 1, "취소+id 있음: updateEvent 호출('(취소)' 제목 반영)");
  } finally {
    calendar.syncStatus = origStatus; calendar.updateEvent = origUpdate;
  }
});

test.after(() => cleanupDb());
