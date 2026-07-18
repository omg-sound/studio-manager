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
  assert.match(sel, /<div class="hidden lg:flex[^"]*">LEFT/, "선택: 왼쪽은 lg 이상만(flex-col)");
  assert.match(sel, /<div class="block[^"]*">RIGHT/, "선택: 오른쪽 항상 보임");
  // 고정 높이 flex 영역(2단) — 페이지 스크롤 대신 좌·우 내부 스크롤(2026-07-18 재설계, 리터럴 클래스).
  assert.match(sel, /lg:flex lg:gap-6 lg:h-\[calc\(100vh-11rem\)\]/, "고정 높이 flex 컨테이너");
  assert.match(sel, /lg:flex-1 lg:min-h-0 lg:overflow-y-auto/, "오른쪽 내부 스크롤");
});

test("contactPanes: 좁은 화면 뒤로가기 — 선택 있을 때만 lg:hidden 링크", () => {
  // <lg에선 왼쪽 목록이 hidden이라 이 링크가 목록으로 돌아갈 유일한 길이다.
  const sel = contactPanes({ left: "LEFT", right: "RIGHT", hasSelection: true, backHref: "/contacts?tab=external", backLabel: "연락처" });
  assert.match(sel, /<a href="\/contacts\?tab=external" class="[^"]*lg:hidden[^"]*">← 연락처<\/a>/, "선택 시 lg:hidden 뒤로가기");
  assert.ok(sel.indexOf("← 연락처") < sel.indexOf("RIGHT"), "상세 위에 위치");
  // 목록만 보이는 화면(선택 없음)에선 돌아갈 곳이 이미 화면이라 렌더하지 않는다.
  const none = contactPanes({ left: "LEFT", right: "RIGHT", hasSelection: false, backHref: "/contacts?tab=external", backLabel: "연락처" });
  assert.ok(!/← 연락처/.test(none), "미선택(목록만)엔 뒤로가기 없음");
  // backHref 미전달(기본값)이면 링크 없음 — 호출부가 명시할 때만.
  assert.ok(!/lg:hidden/.test(contactPanes({ left: "L", right: "R", hasSelection: true })));
});

test("contactPanes: 인라인 style 없음(CSP — 함정 #27)", () => {
  const html = contactPanes({ left: "L", right: "R", hasSelection: true });
  assert.ok(!/style="/.test(html));
});

const { contactReadView, contactExtras } = require("../src/views.contacts");

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

// 2026-07-17 사용자 요청: 참여가 0인 섹션은 헤딩·빈 안내까지 통째로 숨긴다(관계자·연락처 대다수가 0이라 자리만 차지).
test("contactReadView: 프로젝트·세션 둘 다 0이면 참여 내역 영역 자체가 없다", () => {
  const html = read({ projects: [], sessions: [] });
  assert.ok(!/프로젝트 0/.test(html), "프로젝트 헤딩 없음");
  assert.ok(!/연결된 프로젝트가 없습니다/.test(html), "프로젝트 빈 안내 없음");
  assert.ok(!/세션 0/.test(html), "세션 헤딩 없음");
  assert.ok(!/지정된 세션이 없습니다/.test(html), "세션 빈 안내 없음");
  assert.match(html, /강병원 대표님/, "헤더·연락 정보는 그대로");
});

test("contactReadView: 프로젝트 0이면 프로젝트 섹션만 숨기고 세션은 남는다", () => {
  const html = read({ projects: [] });
  assert.ok(!/프로젝트 0/.test(html));
  assert.match(html, /세션 1/, "세션 섹션은 유지");
});

test("contactReadView: 세션 0이면 세션 섹션 자체를 숨긴다(헤딩·빈 안내 없음)", () => {
  const html = read({ sessions: [] });
  assert.ok(!/세션 0/.test(html), "세션 헤딩 없음");
  assert.ok(!/지정된 세션이 없습니다/.test(html), "빈 안내도 없음");
  assert.match(html, /프로젝트 1/, "프로젝트 섹션은 그대로");
});

test("contactReadView: 세션이 있으면 세션 섹션 표시", () => {
  const html = read();
  assert.match(html, /세션 1/);
  assert.match(html, /href="\/projects\/3\?tab=sessions"/);
});

test("extras = 신뢰 HTML 삽입점 — 그대로 통과하되 사용자 데이터 esc는 contactExtras 책임", () => {
  // (1) extras 문자열은 읽기 뷰에 esc 없이 삽입된다(호출부가 만든 링크·배지 HTML이 살아야 하므로).
  const html = read({ extras: '<div id="trusted-extra">ok</div>' });
  assert.match(html, /<div id="trusted-extra">ok<\/div>/, "신뢰 HTML은 그대로 통과");
  // (2) 그래서 사용자 데이터를 끼워 넣는 조립 함수가 esc 책임을 진다 — 안 하면 곧 XSS.
  const extras = contactExtras({ id: 999999, activity_name: '<script>alert(1)</script>', is_artist: 1 });
  assert.match(extras, /&lt;script&gt;/, "활동명은 이스케이프되어 나온다");
  assert.ok(!/<script>/.test(extras), "생 스크립트 태그 없음");
  // (3) 그 extras를 읽기 뷰에 넣어도(=downstream 재이스케이프 없음) 여전히 안전.
  assert.ok(!/<script>/.test(read({ extras })), "읽기 뷰 삽입 후에도 안전");
});

test("contactReadView: 탭 없음(한 화면 스크롤)", () => {
  const html = read();
  assert.ok(!/\?tab=activity/.test(html), "옛 2탭 잔재 없음");
});

// 2026-07-17 사용자 요청: "연락처에서 프로젝트를 보다가 연락처 상세로 들어가니까 연락처로 돌아오기 번거롭다"
// → 읽기 뷰에서 **연락처 밖으로 나가는 링크는 새 탭**, 안에 머무는 링크([편집])는 같은 탭.
test("contactReadView: 회사·프로젝트·세션 링크는 새 탭(target=_blank rel=noopener)", () => {
  const html = read();
  const linkFor = (href) => { const i = html.indexOf(`href="${href}"`); return i < 0 ? "" : html.slice(i, html.indexOf(">", i)); };
  assert.match(linkFor("/clients/5"), /target="_blank" rel="noopener"/, "회사(현재 소속)");
  assert.match(linkFor("/projects/3"), /target="_blank" rel="noopener"/, "프로젝트 표");
  assert.match(linkFor("/projects/3?tab=sessions"), /target="_blank" rel="noopener"/, "세션 표(→프로젝트)");
});

test("contactReadView: [편집]은 같은 탭(연락처 안에 머무는 링크)", () => {
  const html = read();
  const i = html.indexOf('href="/contacts/2/edit"');
  assert.ok(i > 0);
  assert.ok(!/target="_blank"/.test(html.slice(i, html.indexOf(">", i))), "편집은 새 탭이 아니다");
});

test("contactExtras: 대표 업체·담당자 연동도 새 탭", () => {
  // 파생 링크(orgsWithOwnerParty)가 실제로 걸리도록 temp DB에 대표자 관계를 심는다.
  const { createPerson, createCompany, setCompanyOwners } = require("../src/data");
  const pid = createPerson({ name: "감성소녀", activity_name: "감성소녀" });
  const cid = createCompany({ name: "감성레코드" });
  setCompanyOwners(cid, [pid]);
  const html = contactExtras({ id: pid, activity_name: "감성소녀", is_artist: 1 });
  assert.match(html, /대표 업체/, "대표 업체 파생 정보 렌더");
  // 파생 링크가 하나라도 있으면 전부 새 탭이어야 한다(연동 정보 블록 안에서 규칙이 갈리면 안 됨).
  const anchors = html.match(/<a [^>]*>/g) || [];
  assert.ok(anchors.length > 0, "대표 업체 링크 존재");
  anchors.forEach((a) => assert.match(a, /target="_blank" rel="noopener"/, `새 탭: ${a}`));
});
