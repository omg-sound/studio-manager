"use strict";
// 격리 DB 셋업(렌더 테스트 projectMetaCard가 contactOptions()·listProjectContacts()로 DB를 건드리므로 — 다른 테스트와 동일 패턴).
process.env.NODE_ENV = "test";
const { tempDbPath, cleanupDb } = require("./helpers");
process.env.DB_PATH = tempDbPath();
const { test, after } = require("node:test");
const assert = require("node:assert");
const { db, init } = require("../src/db");
init();
after(() => cleanupDb(process.env.DB_PATH, db()));
const { splitProjectTabs } = require("../src/data/projects");

const row = (o) => ({ is_completed: false, unbilled_cnt: 0, next_session_date: null, created_at: "2026-07-01 10:00:00", ...o });

test("splitProjectTabs: 3그룹 상호 배타 + 합=전체", () => {
  const rows = [
    row({ id: 1, is_completed: false }),                       // active
    row({ id: 2, is_completed: true, unbilled_cnt: 2 }),       // billing
    row({ id: 3, is_completed: true, unbilled_cnt: 0 }),       // done
    row({ id: 4, is_completed: false, next_session_date: "2026-07-20" }), // active
  ];
  const { active, billing, done } = splitProjectTabs(rows);
  assert.deepStrictEqual(active.map((r) => r.id).sort(), [1, 4]);
  assert.deepStrictEqual(billing.map((r) => r.id), [2]);
  assert.deepStrictEqual(done.map((r) => r.id), [3]);
  assert.strictEqual(active.length + billing.length + done.length, rows.length, "합=전체");
});

test("splitProjectTabs: active는 다가오는 세션 임박순, 세션 없는 건 뒤로", () => {
  const rows = [
    row({ id: "none1" }),                                  // 세션 없음
    row({ id: "far", next_session_date: "2026-08-01" }),
    row({ id: "soon", next_session_date: "2026-07-15" }),
    row({ id: "none2" }),                                  // 세션 없음
  ];
  const { active } = splitProjectTabs(rows);
  assert.deepStrictEqual(active.map((r) => r.id), ["soon", "far", "none1", "none2"],
    "임박순 → 세션 없는 건 입력 순서로 뒤에");
});

const views = require("../src/views.projects");

const pRow = (o) => ({
  id: 7, title: "루나 1집 - 타이틀곡 '월광'", artist: "아이유", client_name: "(주)이담",
  contact_name: "김보종", contact_phone: "010-0000-0000", manager_name: "박수한",
  next_session_date: null, sess_scheduled: 0, sess_done: 0, task_cnt: 0, task_pending: 0, task_done: 0,
  unbilled_cnt: 0, track_titles: "", task_total: 0, session_amount_total: 0, rate: 0, invoice_discount_total: 0, ...o,
});
const emptySummary = { sessions: [], tracks: [], taskTypes: [] };

test("projectIdentity: 아티스트·회사, 중복·다중·폴백", () => {
  assert.strictEqual(views.projectIdentity(pRow()), "아이유 · (주)이담");
  assert.strictEqual(views.projectIdentity(pRow({ client_name: "아이유" })), "아이유", "회사=아티스트 중복 제외");
  assert.strictEqual(views.projectIdentity(pRow({ artist: "아이유,태연" })), "아이유 외 1 · (주)이담", "다중 아티스트 축약");
  assert.strictEqual(views.projectIdentity(pRow({ artist: "", client_name: "" })), null, "둘 다 없으면 null");
});

test("projectListRow 진행 중: 정체성 굵게·금액 없음·작성일 없음", () => {
  const html = views.projectListRow(pRow({ task_total: 500000 }), emptySummary, { tab: "active" });
  assert.match(html, /아이유 · \(주\)이담/);
  assert.doesNotMatch(html, /₩/, "진행 중 카드에 금액 없음");
  assert.doesNotMatch(html, /type="date"/, "작성일 입력 없음");
  assert.doesNotMatch(html, /곡·콘텐츠 미정/, "곡 없으면 '미정' 문구 없음");
});

test("projectListRow 청구 필요: 배지 + 금액 노출", () => {
  const html = views.projectListRow(pRow({ unbilled_cnt: 2, task_total: 500000 }), emptySummary, { tab: "billing" });
  assert.match(html, /청구 필요 2/);
  assert.match(html, /₩/, "청구 필요 탭엔 금액 표시");
});

test("projectListRow 다음 세션 없으면 줄 생략", () => {
  const html = views.projectListRow(pRow(), emptySummary, { tab: "active" });
  assert.doesNotMatch(html, /예정 세션 없음/);
  assert.doesNotMatch(html, /다음 세션/);
});

const { todayYmd } = require("../src/lib/date");

test("projectMetaCard: 치프만 작성일 편집 필드", () => {
  const p = pRow({ created_at: "2026-07-01 10:00:00" });
  const chiefHtml = views.projectMetaCard(p, "", { chief: true });
  assert.match(chiefHtml, /\/projects\/7\/created-at/);
  assert.match(chiefHtml, /type="date"/);
  const plainHtml = views.projectMetaCard(p, "", { chief: false });
  assert.doesNotMatch(plainHtml, /\/projects\/7\/created-at/);
});

test("projectSummaryHtml: 다가오는 세션이 지난 세션보다 먼저", () => {
  const today = todayYmd();
  const y = Number(today.slice(0, 4));
  const past = `${y - 1}-01-01`;
  const future = `${y + 1}-12-31`;
  const summary = {
    sessions: [
      { session_date: past, start_time: "10:00", end_time: "12:00", session_type: "믹싱", status: "완료" },
      { session_date: future, start_time: "14:00", end_time: "16:00", session_type: "녹음", status: "예정" },
    ],
    tracks: [], taskTypes: [],
  };
  const html = views.projectSummaryHtml(summary);
  // formatYmdShort는 연도를 렌더링하지 않아("M월 D일") 연도 문자열로는 순서를 판별할 수 없다.
  // 대신 두 세션을 구분하는 session_type(미래=녹음·과거=믹싱) 등장 순서로 검증.
  assert.ok(html.indexOf("녹음") < html.indexOf("믹싱"), "미래 세션이 과거 세션보다 앞에 렌더");
});

// 다음 세션: 디데이 색 단계(2026-07-11) — 3일내 빨강 / 2주내 주황 / 멀리 검정, PM 밑 우측 열.
function ymdPlusLocal(days) {
  const d = new Date();
  d.setDate(d.getDate() + days);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const da = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${da}`;
}

test("nextSessionLine: 디데이 색 단계 + PM 밑 우측 열", () => {
  // 경계에서 멀찍이(1·10·30일) — 타임존 ±1일 오차에도 단계 안 바뀌게.
  const soon = views.projectListRow(pRow({ manager_name: "박수한", next_session_date: ymdPlusLocal(1) }), emptySummary, { tab: "active" });
  assert.match(soon, /text-danger/, "3일 이내 = 빨강(danger)");
  assert.match(soon, /border-border\/70[^"]*text-sm[^"]*font-bold/, "디데이 = 옅은 보더 pill·크게(text-sm 볼드)");
  assert.match(soon, /다음 세션/, "다음 세션 줄 렌더");
  assert.ok(soon.indexOf("PM 박수한") < soon.indexOf("다음 세션"), "다음 세션이 PM 밑(뒤)에 온다");

  const mid = views.projectListRow(pRow({ next_session_date: ymdPlusLocal(10) }), emptySummary, { tab: "active" });
  assert.match(mid, /text-warning/, "2주 이내 = 주황(warning)");

  const far = views.projectListRow(pRow({ next_session_date: ymdPlusLocal(30) }), emptySummary, { tab: "active" });
  assert.doesNotMatch(far, /text-danger/, "멀리 = 빨강 아님");
  assert.doesNotMatch(far, /text-warning/, "멀리 = 주황 아님");
});

// 프로젝트 고객측 담당자 다대다(2026-07-11): set/list 라운드트립 + 연결 프로젝트 매칭 + 관계자 노출.
const D = require("../src/data");
test("project_contacts: set/list + 연결 프로젝트 + 관계자", () => {
  const p1 = D.createPerson({ name: "담당갑" });
  const p2 = D.createPerson({ name: "담당을" });
  const info = db().prepare("INSERT INTO projects (title, project_type) VALUES ('멀티담당', 'session')").run();
  const pid = Number(info.lastInsertRowid);
  D.setProjectContacts(pid, [p1, p2]);
  assert.deepStrictEqual(D.listProjectContacts(pid).map((x) => x.id).sort((a, b) => a - b), [p1, p2].sort((a, b) => a - b), "set→list 라운드트립");
  assert.ok(D.listProjectsForParty(p1).some((pr) => pr.id === pid), "담당갑 연결 프로젝트");
  assert.ok(D.listProjectsForParty(p2).some((pr) => pr.id === pid), "담당을 연결 프로젝트");
  assert.ok(D.listAssociates({}).some((a) => a.id === p2), "담당자는 관계자 탭에 노출");
  D.setProjectContacts(pid, [p2]); // 통째 교체
  assert.deepStrictEqual(D.listProjectContacts(pid).map((x) => x.id), [p2], "교체 반영");
});

test("projectSummaryHtml: 편집자면 목록 펼침 세션에 완료 토글(?open= 복귀)", () => {
  const y = Number(todayYmd().slice(0, 4));
  const summary = { sessions: [{ id: 42, session_date: `${y + 1}-07-15`, start_time: "14:00", end_time: "17:30", session_type: "녹음", status: "예정" }], tracks: [], taskTypes: [] };
  const admin = views.projectSummaryHtml(summary, { isAdmin: true, projectId: 7, tab: "active" });
  assert.match(admin, /\/sessions\/42\/status/, "완료 폼 액션");
  assert.match(admin, /name="return" value="\/projects\?tab=active&open=7"/, "완료 후 그 카드 재펼침 복귀");
  const plain = views.projectSummaryHtml(summary, { isAdmin: false, projectId: 7 });
  assert.doesNotMatch(plain, /\/sessions\/42\/status/, "비편집자는 완료 토글 없음");
});

test("projectSummaryHtml: 편집자면 곡·콘텐츠 작업에도 완료 토글(?open= 복귀)", () => {
  const summary = { sessions: [], tracks: [{ id: 1, title: "월광", artist: "추화정", engineers: ["박수한"], tasks: [{ id: 99, label: "믹싱", status: "Pending" }] }], taskTypes: [] };
  const admin = views.projectSummaryHtml(summary, { isAdmin: true, projectId: 7, tab: "active" });
  assert.match(admin, /\/projects\/tasks\/99\/status/, "작업 완료 폼 액션");
  assert.match(admin, /name="return" value="\/projects\?tab=active&open=7"/, "완료 후 그 카드 재펼침 복귀");
  assert.match(admin, /믹싱/, "작업 라벨 표시");
  const plain = views.projectSummaryHtml(summary, { isAdmin: false, projectId: 7 });
  assert.doesNotMatch(plain, /\/projects\/tasks\/99\/status/, "비편집자는 작업 토글 없음");
  assert.match(plain, /믹싱/, "비편집자도 작업 라벨은 표시");
});
