"use strict";
// ⚠️ 격리 DB 셋업(2026-07-20 CI 적색 수리): 이 파일의 렌더 함수들은 **지연 조회로 DB를 건드린다**
// (revStaffDetail→taskTypeLabel→task_types / clientEditPane→parties·company_owners).
// DB_PATH를 안 잡으면 개발 머신에선 `./data/app.db`(테이블이 이미 있는 개발 DB)를 조용히 써서 통과하고,
// **CI에는 그 파일이 없어 'no such table'로 실패**한다 — 로컬만 보고 푸시하면 안 보이는 클래스다.
process.env.NODE_ENV = "test";
const { tempDbPath, cleanupDb } = require("./helpers");
process.env.DB_PATH = tempDbPath();

const test = require("node:test");
const assert = require("node:assert");
const { init } = require("../src/db");
init();
test.after(() => cleanupDb(process.env.DB_PATH));
const { clientReadView, clientEditPane } = require("../src/views.clients");

const company = { id: 10, kind: "company", name: "(주)도너츠컬처", roles: "제작사", biz_no: "261-81-02922", address: "서울시", email: "note@daum.net", phone: "010-1111-2222" };
const group = { id: 20, kind: "group", name: "더윈드", activity_name: "더윈드" };

test("clientReadView(company): 기본 정보·담당자·[편집], 읽기 전용(폼 없음)", () => {
  const html = clientReadView(company, {
    owners: [{ id: 5, name: "고영조" }],
    contacts: [{ id: 6, name: "김담당" }],
    artists: [{ id: 7, name: "아티스트A", real_name: "" }],
    bizLicenseOk: true,
    projects: [], invoices: [],
    editHref: "/clients/10/edit",
  });
  assert.match(html, /261-81-02922/, "사업자번호");
  assert.match(html, /계산서 발행 이메일/, "계산서 이메일 라벨");
  assert.match(html, /고영조/, "대표");
  assert.match(html, /김담당/, "담당자");
  assert.match(html, /아티스트A/, "소속 아티스트");
  assert.match(html, /href="\/clients\/10\/edit"[^>]*>편집</, "[편집] 링크");
  assert.doesNotMatch(html, /data-dirty-form/, "읽기 뷰엔 편집 폼 없음");
  assert.doesNotMatch(html, /클라이언트/, "화면 문구에 '클라이언트' 없음");
});

test("clientReadView(company): 사업자등록증 없으면 경고 아이콘", () => {
  const html = clientReadView(company, { owners: [], contacts: [], artists: [], bizLicenseOk: false, projects: [], invoices: [], editHref: "/clients/10/edit" });
  assert.match(html, /사업자등록증 미등록/, "미등록 경고");
});

test("clientReadView(group): 소속사·멤버·[편집]", () => {
  const html = clientReadView(group, {
    members: [{ id: 8, name: "멤버1", display_name: "멤버1" }],
    agencyName: "주식회사 팡스타", agencyId: 30,
    groupContact: { id: 9, name: "방재혁" },
    projects: [], invoices: [], editHref: "/clients/20/edit",
  });
  assert.match(html, /주식회사 팡스타/, "소속사");
  assert.match(html, /href="\/clients\/30"/, "소속사 링크(업체·그룹 내부=같은 탭)");
  assert.match(html, /멤버1/, "멤버");
  assert.match(html, /방재혁/, "담당자");
  assert.match(html, /더윈드/, "그룹명 헤더");
});

test("clientReadView: 빈 섹션(프로젝트·청구 0) 숨김", () => {
  const html = clientReadView(company, { owners: [], contacts: [], artists: [], bizLicenseOk: true, projects: [], invoices: [], editHref: "/clients/10/edit" });
  assert.doesNotMatch(html, /청구 합계/, "청구 0이면 섹션 없음");
});

test("clientEditPane(company): 편집 폼(data-dirty-form)+취소", () => {
  const html = clientEditPane({ id: 10, kind: "company", name: "(주)도너츠컬처" }, {
    files: [], contacts: [], companies: [], cancelHref: "/clients/10",
  });
  assert.match(html, /data-dirty-form/, "편집 폼");
  assert.match(html, /href="\/clients\/10"[^>]*>← 취소</, "취소 링크");
  assert.match(html, /data-dropzone/, "업체 첨부 업로드");
});

test("clientEditPane(group): 멤버 추가/제거 폼", () => {
  const html = clientEditPane({ id: 20, kind: "group", name: "더윈드" }, {
    members: [{ id: 8, name: "멤버1", display_name: "멤버1" }],
    memberCandidates: [], cancelHref: "/clients/20",
  });
  assert.match(html, /멤버/, "멤버 섹션");
  assert.match(html, /\/clients\/20\/members/, "멤버 추가 폼 action");
  assert.match(html, /\/clients\/20\/members\/8\/remove/, "멤버 제거 폼");
});
