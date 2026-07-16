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
const { splitProjectTabs, listProjects } = require("../src/data/projects");

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

test("projectListRow: 청구식 컬럼 셀(아티스트·제작사·프로젝트·PM·금액·작성일)", () => {
  const html = views.projectListRow(pRow({ task_total: 500000, created_at: "2026-07-01 10:00:00" }), emptySummary, { tab: "active" });
  assert.match(html, /class="pt-cell proj-link pt-artist font-medium" data-label="아티스트">아이유</);
  assert.match(html, /class="pt-cell proj-link pt-company text-muted" data-label="제작사">\(주\)이담</);
  assert.match(html, /class="pt-cell proj-link pt-title" data-label="프로젝트">루나 1집/);
  assert.match(html, /class="pt-cell pt-pm text-muted" data-label="PM">박수한</);
  assert.match(html, /class="pt-cell pt-amount tabular" data-label="금액">₩500,000/, "금액 열은 전 탭 버짓 표시");
  assert.match(html, /class="pt-cell pt-created tabular text-muted" data-label="작성일">2026-07-01</);
});

test("projectArtistOnly: 아티스트만(폴백 없음), 다중=외 N, 없으면 빈 문자열", () => {
  assert.strictEqual(views.projectArtistOnly(pRow()), "아이유");
  assert.strictEqual(views.projectArtistOnly(pRow({ artist: "아이유,태연,보아" })), "아이유 외 2");
  assert.strictEqual(views.projectArtistOnly(pRow({ artist: "" })), "", "없으면 빈(제작사는 별도 열)");
});

test("projectArtistLabel/SubLabel: 다중·중복·폴백", () => {
  assert.strictEqual(views.projectArtistLabel(pRow({ artist: "아이유,태연" })), "아이유 외 1");
  assert.strictEqual(views.projectArtistLabel(pRow({ artist: "" })), "(주)이담", "아티스트 없으면 회사 승격");
  assert.strictEqual(views.projectArtistLabel(pRow({ artist: "", client_name: "" })), "루나 1집 - 타이틀곡 '월광'", "둘 다 없으면 제목");
  assert.strictEqual(views.projectSubLabel(pRow({ client_name: "아이유" })), "루나 1집 - 타이틀곡 '월광'", "회사=아티스트면 회사 조각 생략");
  assert.strictEqual(views.projectSubLabel(pRow({ artist: "", client_name: "" })), "", "제목이 아티스트 열로 승격되면 부제 비움");
});

test("projectListRow: 헤더 + 행 컬럼 정렬(같은 grid 열)", () => {
  const head = views.projectTableHead();
  assert.match(head, /class="proj-thead">/);
  for (const label of ["아티스트", "제작사", "프로젝트", "PM", "다음 세션", "금액", "작성일"]) {
    assert.match(head, new RegExp(`<span class="pt-h[^"]*">${label}</span>`), `헤더 항목명: ${label}`);
  }
  // 행 셀 순서 = 헤더 순서
  const html = views.projectListRow(pRow({ next_session_date: "2099-01-01" }), emptySummary, { tab: "active" });
  const order = ["아티스트", "제작사", "프로젝트", "PM", "다음 세션", "금액", "작성일"].map((l) => html.indexOf(`data-label="${l}"`));
  for (let i = 1; i < order.length; i++) assert.ok(order[i - 1] < order[i], `컬럼 순서 ${i}`);
});

test("projectRowHref: 목록 상태(탭·검색·mine)를 return으로 실어 보낸다(상세 백링크 복귀)", () => {
  const p = pRow({ sess_cnt: 1 });
  const listQuery = "/projects?tab=done&q=%EC%95%84%EC%9D%B4&mine=1";
  // 완료 탭 → 기본 탭 진입 + return
  const done = views.projectRowHref(p, "done", listQuery);
  assert.strictEqual(done, `/projects/7?return=${encodeURIComponent(listQuery)}`);
  // 진행 중(세션 탭 진입)에도 return이 붙는다
  const active = views.projectRowHref(p, "active", "/projects?tab=active");
  assert.strictEqual(active, "/projects/7?tab=sessions&return=" + encodeURIComponent("/projects?tab=active"));
  // 청구 필요
  const billing = views.projectRowHref(p, "billing", "/projects?tab=billing");
  assert.strictEqual(billing, "/projects/7?tab=invoice&return=" + encodeURIComponent("/projects?tab=billing"));
  // listQuery 없으면 기존 그대로(다른 진입점 호환)
  assert.strictEqual(views.projectRowHref(p, "done"), "/projects/7");
  // 카드 렌더에도 반영
  assert.match(views.projectListRow(p, emptySummary, { tab: "done", listQuery }), /return=/);
});

test("projectListRow: 작성일 열은 전 탭 표시(넓어진 표, 2026-07-16)", () => {
  for (const tab of ["active", "billing", "done"]) {
    const html = views.projectListRow(pRow({ created_at: "2026-07-01 10:00:00" }), emptySummary, { tab });
    assert.match(html, /class="pt-cell pt-created tabular text-muted" data-label="작성일">2026-07-01</, `${tab} 탭 작성일`);
    assert.doesNotMatch(html, /10:00:00/, "시각 미표시");
  }
});

test("projectListRow: 행=펼침(details/summary), 데이터 셀은 상세 링크", () => {
  const html = views.projectListRow(pRow({ sess_cnt: 1 }), emptySummary, { tab: "active" });
  assert.match(html, /<details class="proj-row/, "행 전체가 details");
  assert.match(html, /<summary class="proj-summary/, "행 클릭 = 펼침");
  assert.match(html, /<a href="\/projects\/7\?tab=sessions" class="pt-cell proj-link pt-artist/, "아티스트 셀 = 상세 링크");
  assert.match(html, /class="proj-expand/, "펼침 본문");
});

test("projectListRow 청구 필요: 금액 + '청구 필요 N' 배지", () => {
  const html = views.projectListRow(pRow({ unbilled_cnt: 2, task_total: 500000 }), emptySummary, { tab: "billing" });
  assert.match(html, /청구 필요 2/);
  assert.match(html, /₩500,000/, "금액 표시");
});

test("projectRowHref: 청구 필요=청구 탭, 진행 중=세션(없고 곡만 있으면 곡·콘텐츠), 완료=기본", () => {
  const withSess = pRow({ sess_cnt: 2, track_titles: "월광" });
  const trackOnly = pRow({ sess_cnt: 0, track_titles: "월광||야상곡" });
  const empty = pRow({ sess_cnt: 0, track_titles: "" });
  assert.strictEqual(views.projectRowHref(withSess, "billing"), "/projects/7?tab=invoice", "청구 필요는 세션 유무 무관 청구 탭");
  assert.strictEqual(views.projectRowHref(withSess, "active"), "/projects/7?tab=sessions");
  assert.strictEqual(views.projectRowHref(trackOnly, "active"), "/projects/7?tab=tracks", "세션 없고 곡만 있으면 곡·콘텐츠");
  assert.strictEqual(views.projectRowHref(empty, "active"), "/projects/7", "세션·곡 둘 다 없으면 기본");
  assert.strictEqual(views.projectRowHref(withSess, "done"), "/projects/7", "완료 탭은 기본(정보)");
  // 카드 렌더에도 반영
  assert.match(views.projectListRow(withSess, emptySummary, { tab: "active" }), /href="\/projects\/7\?tab=sessions"/);
  assert.match(views.projectListRow(withSess, emptySummary, { tab: "billing" }), /href="\/projects\/7\?tab=invoice"/);
});

test("projectListRow: 다음 세션 없으면 pt-next 셀 비움(진행 중 아니면 아예 비움)", () => {
  const active = views.projectListRow(pRow(), emptySummary, { tab: "active" });
  assert.match(active, /class="pt-cell pt-next" data-label="다음 세션"><\/span>/, "다음 세션 없으면 빈 셀");
  const done = views.projectListRow(pRow({ next_session_date: "2099-01-01" }), emptySummary, { tab: "done" });
  assert.match(done, /class="pt-cell pt-next" data-label="다음 세션"><\/span>/, "완료 탭은 다음 세션 열 비움");
});

const { todayYmd } = require("../src/lib/date");

test("projectMetaCard: 치프만 작성일 편집 필드", () => {
  const p = pRow({ created_at: "2026-07-01 10:00:00" });
  const chiefHtml = views.projectMetaCard(p, "", { chief: true });
  assert.match(chiefHtml, /\/projects\/7\/created-at/);
  // 날짜 칸 = 공용 날짜 콤보(브라우저 기본 date 입력 대체). 값은 hidden(name=created_at).
  // 자동 저장이 아니라 명시적 '저장' 버튼(앱 전반의 명시적 저장 패턴과 통일 — 사용자 요청).
  assert.match(chiefHtml, /data-date-combo/);
  assert.match(chiefHtml, /<input type="hidden" name="created_at" value="2026-07-01" data-date-hidden/);
  assert.doesNotMatch(chiefHtml, /name="created_at"[^>]*data-autosubmit/); // 자동 저장 제거
  assert.match(chiefHtml, /created-at[\s\S]*?<button type="submit"[^>]*>저장<\/button>/); // 명시적 저장 버튼
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

test("nextSessionLine(다음 세션 열 디데이 pill): 색 단계", () => {
  // 경계에서 멀찍이(1·10·30일) — 타임존 ±1일 오차에도 단계 안 바뀌게.
  const soon = views.projectListRow(pRow({ next_session_date: ymdPlusLocal(1) }), emptySummary, { tab: "active" });
  assert.match(soon, /text-danger/, "3일 이내 = 빨강(danger)");
  assert.match(soon, /border-border\/70[^"]*text-sm[^"]*font-bold/, "디데이 = 옅은 보더 pill·크게(text-sm 볼드)");
  assert.match(soon, /class="proj-next/, "다음 세션 pill 렌더");

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

// ── '내 프로젝트만' 필터(2026-07-12) ──
test("listProjectIdsForManager: PM·담당 세션·담당 작업 합집합 + 무관 제외", () => {
  const d = db();
  // 담당자 2명(하우스), 프로젝트 4개
  const me = Number(d.prepare("INSERT INTO project_managers (name, active) VALUES ('나', 1)").run().lastInsertRowid);
  const other = Number(d.prepare("INSERT INTO project_managers (name, active) VALUES ('남', 1)").run().lastInsertRowid);
  const pjPM = Number(d.prepare("INSERT INTO projects (title, project_type, manager_id) VALUES ('PM프로젝트','session',?)").run(me).lastInsertRowid);
  const pjSess = Number(d.prepare("INSERT INTO projects (title, project_type, manager_id) VALUES ('세션프로젝트','session',?)").run(other).lastInsertRowid);
  const pjTask = Number(d.prepare("INSERT INTO projects (title, project_type, manager_id) VALUES ('작업프로젝트','session',?)").run(other).lastInsertRowid);
  const pjNone = Number(d.prepare("INSERT INTO projects (title, project_type, manager_id) VALUES ('무관프로젝트','session',?)").run(other).lastInsertRowid);
  // ② 세션 담당(session_engineers): pjSess의 세션에 나를 배정
  const s = Number(d.prepare("INSERT INTO sessions (project_id, session_type, session_date, status) VALUES (?, '녹음', '2026-07-20', '예정')").run(pjSess).lastInsertRowid);
  d.prepare("INSERT INTO session_engineers (session_id, manager_id) VALUES (?, ?)").run(s, me);
  // ③ 작업 담당(track_tasks.engineer_id): pjTask의 트랙 작업에 나를 배정
  const tr = Number(d.prepare("INSERT INTO project_tracks (project_id, title, content_type) VALUES (?, '곡', 'Music')").run(pjTask).lastInsertRowid);
  d.prepare("INSERT INTO track_tasks (track_id, task_type, billing_type, quantity, unit_price, total_price, status, engineer_id) VALUES (?, 'Mixing', 'Fixed_Per_Track', 1, 0, 0, 'Pending', ?)").run(tr, me);

  const ids = D.listProjectIdsForManager(me);
  assert.ok(ids.has(pjPM), "PM 프로젝트 포함");
  assert.ok(ids.has(pjSess), "담당 세션 프로젝트 포함");
  assert.ok(ids.has(pjTask), "담당 작업 프로젝트 포함");
  assert.ok(!ids.has(pjNone), "무관 프로젝트 제외");
  assert.strictEqual(ids.size, 3, "합집합=3(중복 없음)");

  assert.strictEqual(D.listProjectIdsForManager(null).size, 0, "담당자 없으면 빈 집합");
  assert.strictEqual(D.listProjectIdsForManager(99999).size, 0, "관여 없는 담당자는 빈 집합");
});

test("projectSummaryHtml: mine=true면 완료 복귀 경로에 &mine=1 보존", () => {
  const summary = { sessions: [{ id: 42, session_date: "2999-07-15", start_time: "14:00", end_time: "17:30", session_type: "녹음", status: "예정" }], tracks: [], taskTypes: [] };
  const withMine = views.projectSummaryHtml(summary, { isAdmin: true, projectId: 7, tab: "active", mine: true });
  assert.match(withMine, /name="return" value="\/projects\?tab=active&mine=1&open=7"/, "mine 보존");
  const noMine = views.projectSummaryHtml(summary, { isAdmin: true, projectId: 7, tab: "active" });
  assert.doesNotMatch(noMine, /mine=1/, "mine 미지정이면 없음");
});

// ── 완료 판정: 오늘 날짜 세션의 상태 반영(2026-07-15 사용자 리포트) ──
// 오늘 녹음하고 '완료'로 눌러도 세션 날짜가 오늘이라 '다가오는 세션'으로 잡혀 진행 중에 남던 버그.
// '다가오는 세션' = 예정 상태만 세야 한다(완료·취소는 끝난 활동이라 완료 판정을 막지 않음).
test("listProjects: 오늘 날짜라도 '완료' 세션은 다가오는 세션에서 제외 → 완료 판정(청구 필요)", () => {
  const d = db();
  const today = todayYmd();
  const pid = Number(d.prepare("INSERT INTO projects (title, project_type) VALUES ('오늘완료세션','session')").run().lastInsertRowid);
  d.prepare("INSERT INTO sessions (project_id, session_type, session_date, start_time, end_time, status) VALUES (?, '녹음', ?, '14:00', '18:00', '완료')")
    .run(pid, today);
  const p = listProjects(null, {}).find((x) => x.id === pid);
  assert.strictEqual(p.upcoming_cnt, 0, "완료 세션은 다가오는 세션 아님");
  assert.strictEqual(p.next_session_date, null, "완료 세션은 '다음 세션'으로 잡히지 않음");
  assert.strictEqual(p.is_completed, true, "오늘 완료 세션만 있으면 진행 중이 아니라 완료(청구 필요)");
});

test("listProjects: 오늘 날짜 '예정' 세션은 여전히 다가오는 세션(진행 중)", () => {
  const d = db();
  const today = todayYmd();
  const pid = Number(d.prepare("INSERT INTO projects (title, project_type) VALUES ('오늘예정세션','session')").run().lastInsertRowid);
  d.prepare("INSERT INTO sessions (project_id, session_type, session_date, start_time, end_time, status) VALUES (?, '녹음', ?, '14:00', '18:00', '예정')")
    .run(pid, today);
  const p = listProjects(null, {}).find((x) => x.id === pid);
  assert.strictEqual(p.upcoming_cnt, 1, "예정 세션은 다가오는 세션");
  assert.strictEqual(p.is_completed, false, "예정 세션이 남아있으면 진행 중");
});
