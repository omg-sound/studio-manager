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
const { sessionCardModal } = require("../src/views.sessions");

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

test.after(() => cleanupDb());
