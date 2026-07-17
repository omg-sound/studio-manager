"use strict";
process.env.NODE_ENV = "test";
const { tempDbPath, cleanupDb } = require("./helpers");
process.env.DB_PATH = tempDbPath();

const test = require("node:test");
const assert = require("node:assert");
const { init } = require("../src/db");
const { contactPanes, contactNameList } = require("../src/views.contacts");

init(); // 스키마/마이그레이션 보장(contactReadView가 classifyParty로 project_managers 등을 조회)
test.after(() => cleanupDb(process.env.DB_PATH));

const ROWS = [
  { id: 1, kind: "person", name: "Kim George Han", activity_name: "김조한", honorific: "" },
  { id: 2, kind: "person", name: "강병원", activity_name: "", honorific: "대표님" },
];

test("contactNameList: 이름만 렌더 + 선택 강조 + 실시간 필터 마커", () => {
  const html = contactNameList({ rows: ROWS, selectedId: 2, hrefFn: (c) => `/contacts/${c.id}` });
  assert.match(html, /data-filter-list/, "실시간 필터 컨테이너 마커");
  assert.match(html, /href="\/contacts\/1"/);
  assert.match(html, /Kim George Han \(김조한\)/, "활동명 병기(personName)");
  assert.match(html, /강병원 대표님/, "호칭 병기");
  // 선택된 행만 강조 + aria-current
  const rowOf = (id) => html.split(`href="/contacts/${id}"`)[1].split("</a>")[0];
  assert.match(rowOf(2), /aria-current="true"/, "선택 행 aria-current");
  assert.ok(!/aria-current/.test(rowOf(1)), "비선택 행엔 aria-current 없음");
  assert.match(rowOf(2), /bg-primary\/10/, "선택 행 강조");
  // 이름 외 정보(전화·소속·역할)는 목록에 없다 — 폭 문제의 원인이었음
  assert.ok(!/badge/.test(html), "역할 배지 없음");
});

test("contactNameList: 행 링크는 row-link(모바일 44px 터치 타깃)", () => {
  const html = contactNameList({ rows: ROWS, selectedId: null, hrefFn: (c) => `/contacts/${c.id}` });
  assert.match(html, /class="[^"]*row-link/);
});

test("contactPanes: 선택 없으면 목록만(좁은 화면), 선택 있으면 상세만", () => {
  const none = contactPanes({ left: "LEFT", right: "RIGHT", hasSelection: false });
  assert.match(none, /<div class="block[^"]*">LEFT/, "미선택: 왼쪽 항상 보임");
  assert.match(none, /<div class="hidden lg:block[^"]*">RIGHT/, "미선택: 오른쪽은 lg 이상만");
  const sel = contactPanes({ left: "LEFT", right: "RIGHT", hasSelection: true });
  assert.match(sel, /<div class="hidden lg:block[^"]*">LEFT/, "선택: 왼쪽은 lg 이상만");
  assert.match(sel, /<div class="block[^"]*">RIGHT/, "선택: 오른쪽 항상 보임");
  assert.match(sel, /lg:grid-cols-\[18rem_minmax\(0,1fr\)\]/, "2단 그리드(리터럴 클래스)");
});

test("contactPanes: 인라인 style 없음(CSP — 함정 #27)", () => {
  const html = contactPanes({ left: "L", right: "R", hasSelection: true });
  assert.ok(!/style="/.test(html));
});

const { contactReadView } = require("../src/views.contacts");

const PARTY = { id: 2, kind: "person", name: "강병원", activity_name: "", honorific: "대표님",
  phone: "010-8765-4321", email: "bw@undefined-ent.co.kr", cash_receipt_no: "010-1111-2222",
  job_title: "대표", department: "", memo: "야간 연락 가능" };
const AFFS = [
  { id: 9, client_id: 5, client_name: "언디파인드엔터테인먼트주식회사", title: "대표", started_on: "2025-01-01", ended_on: null, memo: "" },
  { id: 8, client_id: 6, client_name: "옛회사", title: "팀장", started_on: "2020-01-01", ended_on: "2024-12-31", memo: "" },
];
const PROJECTS = [{ id: 3, title: "소울 4집", artist: "김조한", production_company: "소울패밀리", artist_company: "", created_at: "2026-07-02 11:20:00" }];
const SESSIONS = [{ id: 4, project_id: 3, project_title: "소울 4집", session_date: "2026-07-09", start_time: "14:00", end_time: "17:30", all_day: 0, session_type: "녹음", status: "완료" }];
const read = (o = {}) => contactReadView(PARTY, { affs: AFFS, projects: PROJECTS, sessions: SESSIONS, editHref: "/contacts/2/edit", extras: "", ...o });

test("contactReadView: 헤더 이름 + 편집 버튼", () => {
  const html = read();
  assert.match(html, /강병원 대표님/);
  assert.match(html, /href="\/contacts\/2\/edit"/, "[편집] 목적지는 호출부가 정함");
});

test("contactReadView: 전화·이메일·현금영수증은 클릭 복사", () => {
  const html = read();
  assert.match(html, /data-copy="010-8765-4321"/, "전화");
  assert.match(html, /data-copy="bw@undefined-ent\.co\.kr"/, "이메일");
  assert.match(html, /data-copy="010-1111-2222"/, "현금영수증(전화와 다른 값이라야 실제 렌더 여부를 구분할 수 있다)");
});

test("contactReadView: 소속 이력은 읽기 전용(편집 폼·저장 버튼 없음)", () => {
  const html = read();
  assert.match(html, /언디파인드엔터테인먼트주식회사/);
  assert.match(html, /옛회사/);
  assert.ok(!/<form/.test(html), "읽기 뷰엔 폼이 없다");
  assert.ok(!/data-dirty-form/.test(html));
});

test("contactReadView: 참여 내역 = 프로젝트·세션 표(작성일 포함)", () => {
  const html = read();
  assert.match(html, /프로젝트 1/);
  assert.match(html, /세션 1/);
  assert.match(html, /2026-07-02/, "프로젝트 작성일");
  assert.match(html, /href="\/projects\/3"/);
  assert.match(html, /href="\/projects\/3\?tab=sessions"/);
});

test("contactReadView: 참여 내역 없으면 빈 안내", () => {
  const html = read({ projects: [], sessions: [] });
  assert.match(html, /연결된 프로젝트가 없습니다/);
  assert.match(html, /지정된 세션이 없습니다/);
});

test("contactReadView: 탭 없음(한 화면 스크롤)", () => {
  const html = read();
  assert.ok(!/\?tab=activity/.test(html), "옛 2탭 잔재 없음");
});
