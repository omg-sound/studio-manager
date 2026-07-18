"use strict";

// ── 격리 DB 셋업(다른 테스트와 동일 패턴) ──
process.env.NODE_ENV = "test";
const { tempDbPath, cleanupDb } = require("./helpers");
process.env.DB_PATH = tempDbPath();

const test = require("node:test");
const assert = require("node:assert");

const { db, init } = require("../src/db");
const D = require("../src/data");

init();

const CHIEF = { id: 1, role: "chief", email: "chief@omg.test" };

test.after(() => cleanupDb(process.env.DB_PATH, db()));

// ── 스키마: 신선 DB는 레거시 정체성 테이블이 없다(당사자 통합 완료) ──
test("신선 DB 스키마: parties 존재·clients/contacts/contact_affiliations 없음", () => {
  const has = (n) => !!db().prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(n);
  assert.ok(has("parties"), "parties 테이블");
  assert.ok(has("affiliations"), "affiliations 테이블");
  assert.ok(!has("clients"), "clients 없음");
  assert.ok(!has("contacts"), "contacts 없음");
  assert.ok(!has("contact_affiliations"), "contact_affiliations 없음");
  const invCols = db().prepare("PRAGMA table_info(invoices)").all().map((r) => r.name);
  assert.ok(invCols.includes("payer_id"), "invoices.payer_id");
  assert.ok(!invCols.includes("client_id"), "invoices.client_id 제거됨");
});

test("init() 멱등: 재실행해도 안전(스키마 불변)", () => {
  assert.doesNotThrow(() => init(), "init 재실행");
  assert.ok(db().prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='parties'").get());
});

// ── 당사자 생성: kind·is_artist·활동명 ──
test("createPerson: 활동명(nickname 별칭) 있으면 is_artist=1", () => {
  const solo = D.createPerson({ name: "김철수", nickname: "레미" }); // nickname → activity_name
  const p = D.getParty(solo);
  assert.equal(p.kind, "person");
  assert.equal(p.is_artist, 1);
  assert.equal(p.activity_name, "레미");
  const plain = D.createPerson({ name: "이담당" });
  assert.equal(D.getParty(plain).is_artist, 0, "활동명 없으면 비아티스트");
});

test("createCompany / createGroup: kind·roles·is_artist", () => {
  const co = D.createCompany({ name: "와이지", roles: "소속사/레이블,제작사", biz_no: "123" });
  assert.equal(D.getParty(co).kind, "company");
  assert.equal(D.getParty(co).roles, "소속사/레이블,제작사");
  const grp = D.createGroup({ name: "밴드ABC" });
  assert.equal(D.getParty(grp).kind, "group");
  assert.equal(D.getParty(grp).is_artist, 1, "그룹은 아티스트");
});

test("listClients: 업체·그룹·아티스트만(담당자 사람 제외), listContacts: 사람만", () => {
  const artists = D.listParties({ artist: true }).length;
  assert.ok(artists >= 2, "레미 + 밴드ABC 등");
  // 비아티스트 사람(이담당)은 클라이언트 목록에 없어야
  const clientNames = D.listClients({}).map((c) => c.name);
  assert.ok(!clientNames.includes("이담당"), "담당자는 클라이언트 아님");
  const contactNames = D.listContacts({}).map((c) => c.name);
  assert.ok(contactNames.includes("이담당"), "담당자는 연락처 사람");
});

// ── 동명이인 오연결 방지 ──
test("resolvePersonByName: 유일 매칭 재사용, 2+ 동명이인은 새로 생성", () => {
  const a = D.createPerson({ name: "홍길동" });
  assert.equal(D.resolvePersonByName("홍길동"), a, "유일 → 재사용");
  const b = D.createPerson({ name: "홍길동" }); // 동명이인
  const r = D.resolvePersonByName("홍길동");
  assert.ok(r !== a && r !== b, "2+ → 새 party(임의 병합 금지)");
});

// ── 소속 이력(affiliations): 추가·현재·이직(closeCurrent) ──
test("소속 이력: addAffiliation·currentAffiliation, 이직 시 이전 소속 종료", () => {
  const person = D.createPerson({ name: "박매니저" });
  const org1 = D.createCompany({ name: "구소속" });
  const org2 = D.createCompany({ name: "신소속" });
  D.addAffiliation(person, { org_id: org1, title: "매니저", closeCurrent: false });
  assert.equal(D.currentAffiliation(person).org_id, org1);
  assert.equal(D.currentAffiliation(person).client_id, org1, "client_id 별칭(뷰 호환)");
  D.addAffiliation(person, { org_id: org2, closeCurrent: true }); // 이직
  assert.equal(D.currentAffiliation(person).org_id, org2, "현재 소속=신소속");
  const all = D.listAffiliations(person);
  assert.equal(all.length, 2);
  assert.equal(all.filter((a) => a.ended_on == null).length, 1, "현재 소속 1건만");
});

// ── 담당자(project_managers) ↔ party 연동 ──
test("ensurePartyForManager: 외주 담당자 → 연동 party 생성(멱등)", () => {
  const info = db().prepare("INSERT INTO project_managers (name, phone, active) VALUES (?,?,1)").run("최외주", "01011112222");
  const mid = Number(info.lastInsertRowid);
  const pid = D.ensurePartyForManager(mid);
  assert.ok(pid, "party 생성");
  assert.equal(D.ensurePartyForManager(mid), pid, "멱등(같은 party)");
  const linked = db().prepare("SELECT party_id FROM project_managers WHERE id=?").get(mid).party_id;
  assert.equal(linked, pid, "담당자.party_id 연결");
});

// ── 역할 배지 ──
test("classifyParty: 아티스트·조직·그룹 배지", () => {
  const artist = D.createPerson({ name: "가수", nickname: "STAR" });
  assert.ok(D.classifyParty(artist).map((b) => b.label).includes("아티스트"));
  const co = D.createCompany({ name: "레이블B" });
  assert.ok(D.classifyParty(co).map((b) => b.label).includes("조직"));
});

// ── 청구처(payer) 파생: 프로젝트 party 참조 → 인보이스 payer_id ──
// 청구처는 **항상 명시**(2026-07-15 사용자 결정) — '제작/운영 = 결제자' 자동 파생 폐기.
// 배경: 음악감독이 턴키로 받아 감독 개인이 결제하는 등, 결제 주체가 제작사가 아닌 경우가 실제로 발생.
// 조용한 기본값이 오발행을 부르므로 미선택이면 생성 자체를 막는다(폼은 당사자를 '추천 칩'으로만 제시).
test("createInvoiceFromTasks: 청구처 미지정이면 PAYER_REQUIRED로 차단(자동 파생 없음)", () => {
  const artistId = D.createPerson({ name: "가창", nickname: "보컬A" });
  const agencyId = D.createCompany({ name: "소속C", biz_no: "123-45-67890" });
  const proj = db()
    .prepare("INSERT INTO projects (title, project_type, rate, artist_id, agency_id) VALUES (?, 'task', 0, ?, ?)")
    .run("파생 없음 테스트", artistId, agencyId);
  const projectId = Number(proj.lastInsertRowid);
  const tr = db().prepare("INSERT INTO project_tracks (project_id, title, content_type) VALUES (?, ?, 'Music')").run(projectId, "곡");
  const tk = db()
    .prepare("INSERT INTO track_tasks (track_id, task_type, billing_type, quantity, unit_price, total_price, status, is_invoiced) VALUES (?, 'Mixing', 'Fixed_Per_Track', 1, 500000, 500000, 'Completed', 0)")
    .run(Number(tr.lastInsertRowid));
  const taskId = Number(tk.lastInsertRowid);

  // 소속사(agency)가 있어도 자동으로 청구처가 되지 않는다
  assert.throws(() => D.createInvoiceFromTasks(CHIEF, { projectId, taskIds: [taskId], issueDate: "2026-07-02" }), /PAYER_REQUIRED/);
  assert.equal(db().prepare("SELECT COUNT(*) AS n FROM invoices WHERE project_id = ?").get(projectId).n, 0, "인보이스 생성 안 됨");

  // 명시하면 그 party로 발행(제작사가 아닌 사람도 가능 — 예: 턴키로 받은 음악감독)
  const director = D.createPerson({ name: "음악감독", cash_receipt_no: "010-1234-5678" });
  const inv = D.createInvoiceFromTasks(CHIEF, { projectId, taskIds: [taskId], clientId: director, issueDate: "2026-07-02" });
  assert.equal(db().prepare("SELECT payer_id FROM invoices WHERE id=?").get(inv.id).payer_id, director, "payer=명시한 개인(음악감독)");
});

test("createInvoiceFromTasks: 명시 청구처(clientId=party) 우선", () => {
  const payer = D.createCompany({ name: "직접청구처", biz_no: "123-45-67890" }); // 세금계산서 정보(회사 청구처 발행 요건)
  const proj = db().prepare("INSERT INTO projects (title, project_type, rate) VALUES ('명시청구', 'task', 0)").run();
  const projectId = Number(proj.lastInsertRowid);
  const tr = db().prepare("INSERT INTO project_tracks (project_id, title, content_type) VALUES (?, '곡', 'Music')").run(projectId);
  const tk = db()
    .prepare("INSERT INTO track_tasks (track_id, task_type, billing_type, quantity, unit_price, total_price, status, is_invoiced) VALUES (?, 'Mixing', 'Fixed_Per_Track', 1, 100000, 100000, 'Completed', 0)")
    .run(Number(tr.lastInsertRowid));
  const inv = D.createInvoiceFromTasks(CHIEF, { projectId, taskIds: [Number(tk.lastInsertRowid)], clientId: payer, issueDate: "2026-07-02" });
  assert.equal(db().prepare("SELECT payer_id FROM invoices WHERE id=?").get(inv.id).payer_id, payer);
});

// ── deleteParty: 역할 참조 정리 ──
test("deleteParty: payer_id 참조를 SET NULL로 정리(인보이스 보존)", () => {
  const payer = D.createCompany({ name: "삭제될청구처" });
  const info = db().prepare("INSERT INTO invoices (title, amount, payer_id, status) VALUES (?,?,?,?)").run("보존청구", 1000, payer, "발행");
  const invId = Number(info.lastInsertRowid);
  D.deleteParty(payer);
  assert.equal(D.getParty(payer), null, "party 삭제됨");
  const inv = db().prepare("SELECT payer_id FROM invoices WHERE id=?").get(invId);
  assert.ok(inv, "인보이스는 보존");
  assert.equal(inv.payer_id, null, "payer_id는 NULL로 정리");
});

test("deleteParty: 다대다 담당자(project_contacts)·아티스트 연결 정리 + 프로젝트 컬럼 SET NULL (감사 L3)", () => {
  const person = D.createPerson({ name: "삭제될담당자" });
  const pj = db().prepare("INSERT INTO projects (title, project_type, contact_party_id) VALUES (?,?,?)").run("프로젝트X", "session", person);
  const projectId = Number(pj.lastInsertRowid);
  D.setProjectContacts(projectId, [person]); // 다대다 조인에 기록
  D.setProjectArtists(projectId, [person]);
  assert.equal(db().prepare("SELECT COUNT(*) c FROM project_contacts WHERE party_id=?").get(person).c, 1, "선행: 조인에 기록됨");
  D.deleteParty(person);
  assert.equal(D.getParty(person), null, "party 삭제됨");
  assert.equal(db().prepare("SELECT COUNT(*) c FROM project_contacts WHERE party_id=?").get(person).c, 0, "project_contacts 정리");
  assert.equal(db().prepare("SELECT COUNT(*) c FROM project_artists WHERE party_id=?").get(person).c, 0, "project_artists 정리");
  assert.equal(db().prepare("SELECT contact_party_id FROM projects WHERE id=?").get(projectId).contact_party_id, null, "contact_party_id SET NULL");
});

// ── 그룹 소속사 ↔ 멤버 소속사 연동(상속·전파·오버라이드) ──
test("그룹 소속사: 멤버 상속·따르던 멤버 전파·개별 오버라이드 유지", () => {
  const A = D.createCompany({ name: "레이블A", roles: "소속사/레이블" });
  const B = D.createCompany({ name: "레이블B", roles: "소속사/레이블" });
  const C = D.createCompany({ name: "레이블C", roles: "소속사/레이블" });
  const g = D.createGroup({ name: "밴드기억" });
  D.setPartyAgency(g, A); // 그룹 소속사 = A
  const kim = D.createPerson({ name: "김멤버", is_artist: 1 });
  const lee = D.createPerson({ name: "이멤버", is_artist: 1 });
  // 멤버 추가 → 그룹 소속사 A 상속
  D.setPartyGroup(kim, g);
  D.setPartyGroup(lee, g);
  assert.equal(D.currentAgencyId(kim), A, "김: 그룹 소속사 A 상속");
  assert.equal(D.currentAgencyId(lee), A, "이: 그룹 소속사 A 상속");
  // 이멤버 개별 오버라이드 → B
  D.setPartyAgency(lee, B);
  assert.equal(D.currentAgencyId(lee), B, "이: 개별 오버라이드 B");
  // 그룹 소속사 A→C 변경: 따르던 김만 C, 오버라이드 이는 B 유지
  D.setPartyAgency(g, C);
  assert.equal(D.currentAgencyId(kim), C, "김(따름) → C 전파");
  assert.equal(D.currentAgencyId(lee), B, "이(오버라이드) → B 유지");
  assert.equal(D.currentAgencyId(g), C, "그룹 소속사 = C");
  // 소속사 상세 '소속 아티스트'에 그룹·따르는 멤버 노출(is_artist)
  const rosterC = D.listArtistsForAgency(C).map((r) => r.id);
  assert.ok(rosterC.includes(g) && rosterC.includes(kim), "레이블C 소속에 그룹·김");
});

// ── 회귀: 클라이언트 상세 '연결된 프로젝트' — 제작사/소속사/아티스트로 연결된 프로젝트를 찾는다 ──
// (버그: clients.routes가 listProjectsForParty에 party '객체'를 넘겨 Number(obj)=NaN → 매칭 0.
//  호출부는 c.id를 넘겨야 함. 아래는 쿼리 계약 + 객체 인자 함정을 문서화한다.)
test("listProjectsForParty(id): 제작사(production_id)·소속사(agency_id)로 연결된 프로젝트를 찾는다", () => {
  const coId = db().prepare("INSERT INTO parties (kind, name) VALUES ('company','회귀제작사')").run().lastInsertRowid;
  db().prepare("INSERT INTO projects (title, project_type, production_id) VALUES ('제작사연결','session',?)").run(coId);
  db().prepare("INSERT INTO projects (title, project_type, agency_id) VALUES ('소속사연결','session',?)").run(coId);
  const titles = D.listProjectsForParty(coId).map((r) => r.title);
  assert.ok(titles.includes("제작사연결"), "production_id로 연결된 프로젝트 노출");
  assert.ok(titles.includes("소속사연결"), "agency_id로 연결된 프로젝트 노출");
  // 함정 가드: id가 아닌 party 객체를 넘기면 Number(obj)=NaN → 0행(호출부가 c 대신 c.id를 넘겨야 하는 이유).
  assert.equal(D.listProjectsForParty(D.getParty(coId)).length, 0, "party 객체 인자는 매칭 0(NaN)");
});

// ── 회귀: 세션 디렉터로만 참여한 프로젝트도 '연결 프로젝트'에 뜬다(2026-07-17 사용자 리포트) ──
// (버그: listProjectsForParty가 프로젝트 단 역할[아티스트·소속사·제작사·고객측 담당자]만 봐서,
//  그 프로젝트의 담당자로는 등록 안 됐고 세션 디렉터로만 참여한 사람은 '세션 1 · 프로젝트 0'으로 보였다.
//  세션에 참여했으면 그 프로젝트에 관여한 것 — 관계자 탭도 세션 디렉터를 관계자 역할로 인정한다.)
test("listProjectsForParty: 세션 디렉터 참여도 연결 프로젝트로 잡는다(다대다·레거시 컬럼 둘 다)", () => {
  const pid = Number(db().prepare("INSERT INTO projects (title, project_type) VALUES ('디렉터참여작','session')").run().lastInsertRowid);
  const dir = Number(db().prepare("INSERT INTO parties (kind, name) VALUES ('person','디렉터김')").run().lastInsertRowid);
  const sid = Number(db().prepare("INSERT INTO sessions (project_id, session_type, session_date, status) VALUES (?,'녹음','2026-07-09','완료')").run(pid).lastInsertRowid);
  db().prepare("INSERT INTO session_directors (session_id, party_id) VALUES (?,?)").run(sid, dir);
  assert.ok(D.listProjectsForParty(dir).some((p) => p.id === pid), "session_directors 다대다로 참여한 프로젝트 노출");

  // 레거시 단일 컬럼(sessions.director_party_id)만 있는 옛 데이터도 동일하게 잡혀야 한다.
  const pid2 = Number(db().prepare("INSERT INTO projects (title, project_type) VALUES ('레거시디렉터작','session')").run().lastInsertRowid);
  const dir2 = Number(db().prepare("INSERT INTO parties (kind, name) VALUES ('person','디렉터박')").run().lastInsertRowid);
  db().prepare("INSERT INTO sessions (project_id, session_type, session_date, status, director_party_id) VALUES (?,'녹음','2026-07-10','완료',?)").run(pid2, dir2);
  assert.ok(D.listProjectsForParty(dir2).some((p) => p.id === pid2), "레거시 director_party_id로 참여한 프로젝트 노출");

  // 무관한 사람은 여전히 안 잡힌다(과다 매칭 방지).
  const other = Number(db().prepare("INSERT INTO parties (kind, name) VALUES ('person','무관자')").run().lastInsertRowid);
  assert.equal(D.listProjectsForParty(other).length, 0, "참여 없는 사람은 0건");
});

// ── 회귀: 청구처 발행 정보(회사=세금계산서 biz_no / 개인=현금영수증 cash_receipt_no) 없으면 청구 생성 차단 ──
test("createInvoiceFromTasks: 청구처 발행 정보 없으면 차단, 채우면 통과", () => {
  const mkBillable = (title) => {
    const pid = Number(db().prepare("INSERT INTO projects (title, project_type, rate) VALUES (?, 'task', 0)").run(title).lastInsertRowid);
    const tr = db().prepare("INSERT INTO project_tracks (project_id, title, content_type) VALUES (?, '곡', 'Music')").run(pid);
    const tk = db().prepare("INSERT INTO track_tasks (track_id, task_type, billing_type, quantity, unit_price, total_price, status, is_invoiced) VALUES (?, 'Mixing', 'Fixed_Per_Track', 1, 100000, 100000, 'Completed', 0)").run(Number(tr.lastInsertRowid));
    return { pid, tk: Number(tk.lastInsertRowid) };
  };
  // 회사(사업자번호 없음) → 차단
  const co = D.createCompany({ name: "발행정보없는회사" });
  const c1 = mkBillable("차단회사");
  assert.throws(() => D.createInvoiceFromTasks(CHIEF, { projectId: c1.pid, taskIds: [c1.tk], clientId: co, issueDate: "2026-07-02" }), /PAYER_TAX_INFO_REQUIRED/);
  // 개인(현금영수증 없음) → 차단, 채우면 통과
  const person = D.createPerson({ name: "발행정보없는개인" });
  const c2 = mkBillable("차단개인");
  assert.throws(() => D.createInvoiceFromTasks(CHIEF, { projectId: c2.pid, taskIds: [c2.tk], clientId: person, issueDate: "2026-07-02" }), /PAYER_CASH_RECEIPT_REQUIRED/);
  db().prepare("UPDATE parties SET cash_receipt_no='010-1234-5678' WHERE id=?").run(person);
  const c3 = mkBillable("허용개인");
  const inv3 = D.createInvoiceFromTasks(CHIEF, { projectId: c3.pid, taskIds: [c3.tk], clientId: person, issueDate: "2026-07-02" });
  assert.ok(inv3, "현금영수증 정보 채우면 청구 생성");
  // 상세도 payer_kind를 실어 '현금영수증'으로 판정(목록만 맞고 상세 토글은 '계산서'로 뜨던 버그 회귀).
  assert.equal(inv3.payer_kind, "person", "createInvoiceFromTasks/getInvoiceForUser 반환에 payer_kind 포함");
  assert.equal(D.getInvoiceForUser(CHIEF, inv3.id).payer_kind, "person", "청구 상세 재조회도 payer_kind='person'");
  // 프로젝트 청구 탭 목록도 payer_kind를 실어야 함(개인 청구처가 '계산서'로 오표시되던 버그 회귀, 2026-07-19).
  const projInvs = D.listInvoicesForProject(CHIEF, c3.pid);
  assert.equal(projInvs.rows[0].payer_kind, "person", "listInvoicesForProject 행에 payer_kind 포함");
});

// ── 회귀(2026-07-05): 관계자에 아티스트 활동명을 넣어도 관계자 역할이 있으면 관계자 탭 유지 ──
// 원인: updateParty가 활동명 입력 시 is_artist=1로 전환 → 관계자 탭(listAssociates)이 is_artist=0만 노출해 사라짐.
// 해결: is_artist=0 OR 관계자 역할 참조(프로젝트 담당자·세션 디렉터·회사 대표·그룹 담당자)면 노출.
test("listAssociates: 관계자→아티스트 전환 시 역할 있으면 유지, 순수 아티스트는 제외", () => {
  const inAssoc = (id) => D.listAssociates({}).some((p) => p.id === id);

  // ① 순수 관계자(활동명 없음) → 관계자 탭 노출
  const plain = D.createPerson({ name: "박관계자" });
  assert.ok(inAssoc(plain), "순수 관계자(is_artist=0) 노출");

  // ② 관계자 + 세션 디렉터 참조 → 활동명 넣어 is_artist=1이 돼도 관계자 탭 유지(김정환 케이스)
  const dir = D.createPerson({ name: "김정환" });
  const proj = Number(db().prepare("INSERT INTO projects (title, project_type, rate) VALUES ('디렉터프로젝트','session',0)").run().lastInsertRowid);
  const sess = Number(db().prepare("INSERT INTO sessions (project_id, session_type, session_date, status) VALUES (?, '녹음', '2026-07-20', '예정')").run(proj).lastInsertRowid);
  db().prepare("INSERT INTO session_directors (session_id, party_id) VALUES (?, ?)").run(sess, dir);
  assert.ok(inAssoc(dir), "디렉터로 참조된 관계자 노출");
  D.updateParty(dir, { activity_name: "정환비트" }); // 활동명 → is_artist=1
  assert.equal(D.getParty(dir).is_artist, 1, "활동명 입력으로 아티스트 전환");
  assert.ok(inAssoc(dir), "아티스트가 됐어도 디렉터 역할이 있으면 관계자 탭 유지");

  // ③ 순수 솔로 아티스트(아무 관계자 역할 없음) → 관계자 탭 제외(오염 방지)
  const soloArtist = D.createPerson({ name: "이아이유", nickname: "아이유" }); // 활동명 → is_artist=1
  assert.equal(D.getParty(soloArtist).is_artist, 1);
  assert.ok(!inAssoc(soloArtist), "역할 없는 순수 아티스트는 관계자 탭 제외");

  // ④ 프로젝트 고객측 담당자 참조로도 유지
  const contactArtist = D.createPerson({ name: "최담당", nickname: "쵸이" });
  assert.ok(!inAssoc(contactArtist), "참조 전에는 순수 아티스트라 제외");
  db().prepare("UPDATE projects SET contact_party_id = ? WHERE id = ?").run(contactArtist, proj);
  assert.ok(inAssoc(contactArtist), "프로젝트 담당자로 참조되면 관계자 탭 노출");
});

// ── 회귀(2026-07-05): 사람 name 호칭 정규화 — createPerson이 name에 호칭 안 박음, personName이 컬럼으로 붙임 ──
test("createPerson: 성+이름+호칭 → name은 순수 본명, honorific은 컬럼(표시는 personName이 조립)", () => {
  const { personName } = require("../src/views");
  // 성/이름/호칭으로 생성(연락처 폼 경로) → name에 호칭 안 박힘
  const id = D.createPerson({ family_name: "이", given_name: "민우", honorific: "대표님" });
  const p = D.getParty(id);
  assert.equal(p.name, "이민우", "name = 순수 본명(호칭 미포함)");
  assert.equal(p.honorific, "대표님", "호칭은 컬럼에");
  assert.equal(personName(p), "이민우 대표님", "표시 = 본명 호칭");

  // 호칭만 컬럼에 있는 사람(대표자 자동등록 유형)도 동일 표시
  const id2 = D.createPerson({ name: "박준서", honorific: "대표님" });
  assert.equal(D.getParty(id2).name, "박준서", "명시 name은 그대로(순수)");
  assert.equal(personName(D.getParty(id2)), "박준서 대표님", "컬럼 호칭으로 동일 표기");

  // 호칭 없는 사람 → 호칭 안 붙음
  const id3 = D.createPerson({ name: "명승원" });
  assert.equal(personName(D.getParty(id3)), "명승원", "호칭 없으면 본명만");

  // 활동명 병기 + 호칭
  const id4 = D.createPerson({ family_name: "박", given_name: "수한", honorific: "대표님", nickname: "워터멜론" });
  assert.equal(D.getParty(id4).name, "박수한", "name 순수");
  assert.equal(personName(D.getParty(id4)), "박수한 대표님 (워터멜론)", "본명 호칭 (활동명)");
});

// ── 회귀: name에 호칭이 박힌 레거시 데이터 → personName 중복 안 붙임(마이그레이션 전 방어) ──
test("personName: 레거시 name에 호칭 박혀 있어도 중복 안 붙임", () => {
  const { personName } = require("../src/views");
  assert.equal(personName({ name: "이민우 대표님", honorific: "대표님" }), "이민우 대표님", "중복 방지");
  assert.equal(personName({ name: "이민우", honorific: "대표님" }), "이민우 대표님", "컬럼으로 붙임");
});

// ── 회귀(2026-07-05): 청구처가 아티스트면 표시 = 본명 (활동명) — 현금영수증 명의(본명) 오해 방지 ──
test("청구처 표시: 아티스트는 본명 (활동명), 회사는 상호 그대로", () => {
  const { payerName } = require("../src/views.invoices");
  // 아티스트 청구처(현금영수증 정보 필요)
  const artist = D.createPerson({ name: "조형우", nickname: "형우비트" });
  db().prepare("UPDATE parties SET cash_receipt_no='010-9999-8888' WHERE id=?").run(artist);
  const pid = Number(db().prepare("INSERT INTO projects (title, project_type, rate) VALUES ('청구처표기','task',0)").run().lastInsertRowid);
  const tr = Number(db().prepare("INSERT INTO project_tracks (project_id, title, content_type) VALUES (?, '곡', 'Music')").run(pid).lastInsertRowid);
  const tk = Number(db().prepare("INSERT INTO track_tasks (track_id, task_type, billing_type, quantity, unit_price, total_price, status, is_invoiced) VALUES (?, 'Mixing', 'Fixed_Per_Track', 1, 100000, 100000, 'Completed', 0)").run(tr).lastInsertRowid);
  const { id: invId } = D.createInvoiceFromTasks(CHIEF, { projectId: pid, taskIds: [tk], clientId: artist, issueDate: "2026-07-05" });
  // 목록 client_name = 본명 (활동명)
  const listed = D.listInvoices(CHIEF, {}).find((i) => i.id === invId);
  assert.equal(listed.client_name, "조형우 (형우비트)", "목록 청구처명 = 본명 (활동명)");
  // 스냅샷 = name(본명) + activity_name(활동명) → payerName 병기
  const inv = db().prepare("SELECT * FROM invoices WHERE id=?").get(invId);
  const snap = JSON.parse(inv.payer_snapshot);
  assert.equal(snap.name, "조형우", "스냅샷 상호 = 본명(현금영수증 명의·PDF용)");
  assert.equal(snap.activity_name, "형우비트", "스냅샷에 활동명도 보존(화면 병기용)");
  assert.equal(payerName(inv), "조형우 (형우비트)", "payerName = 본명 (활동명)");

  // 회사 청구처는 상호 그대로(병기 없음)
  const co = D.createCompany({ name: "무지개레코드", roles: "제작사", biz_no: "123-45-67890" });
  const pid2 = Number(db().prepare("INSERT INTO projects (title, project_type, rate) VALUES ('회사청구','task',0)").run().lastInsertRowid);
  const tr2 = Number(db().prepare("INSERT INTO project_tracks (project_id, title, content_type) VALUES (?, '곡', 'Music')").run(pid2).lastInsertRowid);
  const tk2 = Number(db().prepare("INSERT INTO track_tasks (track_id, task_type, billing_type, quantity, unit_price, total_price, status, is_invoiced) VALUES (?, 'Mixing', 'Fixed_Per_Track', 1, 100000, 100000, 'Completed', 0)").run(tr2).lastInsertRowid);
  const { id: invId2 } = D.createInvoiceFromTasks(CHIEF, { projectId: pid2, taskIds: [tk2], clientId: co, issueDate: "2026-07-05" });
  const listed2 = D.listInvoices(CHIEF, {}).find((i) => i.id === invId2);
  assert.equal(listed2.client_name, "무지개레코드", "회사는 상호 그대로");
});

// ── 청구처 스냅샷 변경 감지(2026-07-08): 발행 후 클라이언트 정보 변경 시에만 새로고침 노출 ──
test("payerSnapshotChanged: 변경 없으면 false, 주소·이메일 보강 시 true, 새로고침 후 다시 false, 레거시(스냅샷 없음) false", () => {
  const co = D.createCompany({ name: "스냅샷검사사", roles: "제작사", biz_no: "555-66-77788" });
  const pid = Number(db().prepare("INSERT INTO projects (title, project_type, rate) VALUES ('스냅샷','task',0)").run().lastInsertRowid);
  const tr = Number(db().prepare("INSERT INTO project_tracks (project_id, title, content_type) VALUES (?, '곡', 'Music')").run(pid).lastInsertRowid);
  const tk = Number(db().prepare("INSERT INTO track_tasks (track_id, task_type, billing_type, quantity, unit_price, total_price, status, is_invoiced) VALUES (?, 'Mixing', 'Fixed_Per_Track', 1, 100000, 100000, 'Completed', 0)").run(tr).lastInsertRowid);
  const { id: invId } = D.createInvoiceFromTasks(CHIEF, { projectId: pid, taskIds: [tk], clientId: co, issueDate: "2026-07-08" });
  const inv = () => db().prepare("SELECT * FROM invoices WHERE id=?").get(invId);
  assert.equal(D.payerSnapshotChanged(inv()), false, "발행 직후 = 변경 없음");
  // 발행 후 주소·이메일 보강 → 변경 감지
  db().prepare("UPDATE parties SET address='서울시 마포구', email='tax@snap.kr' WHERE id=?").run(co);
  assert.equal(D.payerSnapshotChanged(inv()), true, "주소·이메일 보강 = 변경 감지");
  // 새로고침(스냅샷 재저장) → 다시 false
  db().prepare("UPDATE invoices SET payer_snapshot=? WHERE id=?").run(D.snapshotPayer(co), invId);
  assert.equal(D.payerSnapshotChanged(inv()), false, "새로고침 후 = 변경 없음");
  // 담당자 이메일 변경도 감지(스냅샷 contacts[0] 비교). 담당자=is_contact 지정된 사람(2026-07-10) —
  // 소속만 추가한 직원은 담당자가 아니라 스냅샷에 안 들어간다.
  const person = D.createPerson({ name: "담당자김" });
  db().prepare("UPDATE parties SET email='dd@snap.kr' WHERE id=?").run(person);
  D.addAffiliation(person, { client_id: co, title: "과장" }); // 재직만 — 담당자 아님
  assert.equal(D.payerSnapshotChanged(inv()), false, "재직 직원 추가만으론 청구처 담당자 변경 아님");
  D.setOrgContacts(co, [person]); // 담당자로 지정
  assert.equal(D.payerSnapshotChanged(inv()), true, "담당자(이메일) 지정 = 변경 감지");
  // 레거시(스냅샷 없음)=실시간 표시라 대상 아님
  db().prepare("UPDATE invoices SET payer_snapshot=NULL WHERE id=?").run(invId);
  assert.equal(D.payerSnapshotChanged(inv()), false, "스냅샷 없는 레거시 = false");
});

// ── 회귀(2026-07-05 전수점검): 이름 해석 안전망 — 표시 라벨 텍스트가 유령 party를 만들지 않게 ──
test("resolvePersonByName: 라벨('본명 호칭'·'본명 (활동명)'·활동명) 텍스트도 기존 사람으로 해석", () => {
  const p = D.createPerson({ name: "한도윤", nickname: "도윤사운드", honorific: "실장님" });
  assert.equal(D.resolvePersonByName("한도윤"), p, "순수 본명");
  assert.equal(D.resolvePersonByName("한도윤 실장님"), p, "본명+호칭 라벨");
  assert.equal(D.resolvePersonByName("한도윤 (도윤사운드)"), p, "본명 (활동명) 라벨");
  assert.equal(D.resolvePersonByName("한도윤 실장님 (도윤사운드)"), p, "본명 호칭 (활동명) 전체 라벨");
  assert.equal(D.resolvePersonByName("도윤사운드"), p, "활동명 단독(유일)");
  // 동명이인 2+ 활동명은 보수(생성) — 유일 매칭만 재사용
  D.createPerson({ name: "김중복", nickname: "겹침" });
  D.createPerson({ name: "이중복", nickname: "겹침" });
  const created = D.resolvePersonByName("겹침");
  assert.ok(created && D.getParty(created).name === "겹침", "2+ 매칭이면 임의 병합 대신 신규(보수)");
  // 라벨 형식 신규는 본명·활동명으로 분해 저장
  const parsed = D.resolvePersonByName("신규인물 (뉴비트)");
  const np = D.getParty(parsed);
  assert.equal(np.name, "신규인물", "라벨 신규 → name=본명");
  assert.equal(np.activity_name, "뉴비트", "라벨 신규 → 활동명 분해 저장");
});

test("resolvePartyByDisplay: 회사 상호·사람 라벨 해석(생성 없음), 제작/운영 오생성 방지", () => {
  const co = D.createCompany({ name: "표시해석상사" });
  const pe = D.createPerson({ name: "표진표", nickname: "표비트" });
  assert.equal(D.resolvePartyByDisplay("표시해석상사"), co, "회사 상호 정확");
  assert.equal(D.resolvePartyByDisplay("표진표 (표비트)"), pe, "사람 라벨 → 그 사람(회사 오생성 없음)");
  assert.equal(D.resolvePartyByDisplay("표비트"), pe, "활동명 단독");
  assert.equal(D.resolvePartyByDisplay("전혀없는이름XYZ"), null, "미지 텍스트 = null(생성 없음 — 호출부가 결정)");
  const before = db().prepare("SELECT COUNT(*) n FROM parties").get().n;
  D.resolvePartyByDisplay("표진표 (표비트)");
  assert.equal(db().prepare("SELECT COUNT(*) n FROM parties").get().n, before, "해석 경로는 party를 만들지 않음");
});

test("관계자 역할에 제작/운영 포함 + classifyParty 배지", () => {
  const producer = D.createPerson({ name: "차제작", nickname: "차피디" }); // 아티스트 겸 개인 제작자
  db().prepare("INSERT INTO projects (title, project_type, rate, production_id) VALUES ('개인제작역할','session',0,?)").run(producer);
  assert.ok(D.listAssociates({}).some((p) => p.id === producer), "제작/운영으로 참조된 아티스트도 관계자 탭 유지");
  const labels = D.classifyParty(producer).map((b) => b.label);
  assert.ok(labels.includes("제작/운영"), "classifyParty에 제작/운영 배지");
  assert.ok(labels.includes("아티스트"), "아티스트 배지 병존");
});

// ── 프로젝트 아티스트 다대다(2026-07-05 — 콤마 여러 명): setProjectArtists·연결 프로젝트·삭제 정리 ──
test("project_artists: 다중 기록·교체·dedup·연결 프로젝트 매칭·party 삭제 정리", () => {
  const a1 = D.createPerson({ name: "권보라", nickname: "보라빛" });
  const a2 = D.createPerson({ name: "정노을", nickname: "노을템포" });
  const g1 = D.createGroup({ name: "새벽밴드" });
  const pid = Number(db().prepare("INSERT INTO projects (title, project_type, rate, artist, artist_id) VALUES ('다중아티스트','session',0,'보라빛, 노을템포, 새벽밴드',?)").run(a1).lastInsertRowid);
  D.setProjectArtists(pid, [a1, a2, g1, a2]); // dedup 포함
  const listed = D.listProjectArtists(pid).map((p) => p.id);
  assert.deepEqual(listed.sort(), [a1, a2, g1].sort(), "3명 기록(중복 제거)");
  // 모든 아티스트의 '연결 프로젝트'에 매칭(artist_id=첫째만이던 한계 해소)
  assert.ok(D.listProjectsForParty(a2).some((p) => p.id === pid), "둘째 아티스트도 연결 프로젝트 매칭");
  assert.ok(D.listProjectsForParty(g1).some((p) => p.id === pid), "그룹 아티스트도 매칭");
  // 목록 교체
  D.setProjectArtists(pid, [a1]);
  assert.deepEqual(D.listProjectArtists(pid).map((p) => p.id), [a1], "통째 교체");
  assert.ok(!D.listProjectsForParty(a2).some((p) => p.id === pid), "빠진 아티스트는 매칭 해제");
  // party 삭제 시 조인 정리
  D.setProjectArtists(pid, [a1, a2]);
  D.deleteParty(a2);
  assert.deepEqual(D.listProjectArtists(pid).map((p) => p.id), [a1], "party 삭제 → 조인 행 정리");
});

test("addCompanyRole: 회사 roles에 역할 추가(멱등)·사람은 no-op — 프로젝트 제작/운영이 클라이언트 역할에 반영", () => {
  // 소속사로 등록된 회사를 제작/운영으로도 지정하면 roles에 '제작사'가 더해진다(2026-07-10 사용자 요청).
  const co = D.createCompany({ name: "달빛레이블", roles: "소속사/레이블" });
  D.addCompanyRole(co, "제작사");
  let roles = D.getParty(co).roles.split(",").map((s) => s.trim()).sort();
  assert.deepEqual(roles, ["소속사/레이블", "제작사"], "기존 역할 유지 + 제작사 추가");
  // 멱등 — 다시 호출해도 중복 안 됨
  D.addCompanyRole(co, "제작사");
  assert.equal(D.getParty(co).roles, "소속사/레이블,제작사", "중복 추가 없음");
  // 역할 없던 회사 = 새 역할만
  const co2 = D.createCompany({ name: "빈역할사" });
  D.addCompanyRole(co2, "제작사");
  assert.equal(D.getParty(co2).roles, "제작사", "역할 없던 회사에 첫 역할");
  // 사람은 무시(roles 미사용 — production_id 참조로 classifyParty가 배지 파생)
  const person = D.createPerson({ name: "박제작" });
  D.addCompanyRole(person, "제작사");
  assert.ok(!D.getParty(person).roles, "사람은 roles 안 건드림");
});

// ── 업체 담당자 = 재직(소속)과 분리된 역할(2026-07-10 사용자 결정) ──
// 담당자 칸은 '재직 직원 전원'이 아니라 '담당자로 지정된 사람'만. 칸에서 빼면 담당자 지정만 풀리고
// 재직(affiliations.ended_on)은 그대로 — 담당자 해제가 퇴사 처리가 되면 안 된다.
test("setOrgContacts: 여러 담당자 지정 — listOrgContacts에 전원, 재직도 함께 생김", () => {
  const org = D.createCompany({ name: "다담당㈜" });
  const a = D.createPerson({ name: "담당가" });
  const b = D.createPerson({ name: "담당나" });
  D.setOrgContacts(org, [a, b]);
  assert.deepEqual(D.listOrgContacts(org).map((p) => p.name).sort(), ["담당가", "담당나"]);
  assert.deepEqual(D.listPersonsForOrg(org).map((p) => p.name).sort(), ["담당가", "담당나"], "재직 소속도 연결");
});

test("setOrgContacts: 담당자에서 빼도 재직은 유지(퇴사 처리 아님)", () => {
  const org = D.createCompany({ name: "교체㈜" });
  const keep = D.createPerson({ name: "유지자" });
  const drop = D.createPerson({ name: "제외자" });
  D.setOrgContacts(org, [keep, drop]);
  D.setOrgContacts(org, [keep]); // 제외자를 담당자 칸에서 지움
  assert.deepEqual(D.listOrgContacts(org).map((p) => p.id), [keep], "담당자=유지자만");
  assert.deepEqual(D.listPersonsForOrg(org).map((p) => p.name).sort(), ["유지자", "제외자"], "제외자 재직 유지");
  const aff = D.listAffiliations(drop).find((x) => x.org_id === org);
  assert.equal(aff.ended_on, null, "소속 종료되지 않음");
  const keepRows = D.listAffiliations(keep).filter((x) => x.org_id === org);
  assert.equal(keepRows.length, 1, "유지자 소속 행 중복 없음");
});

test("setOrgContacts: 연락처 '회사'로만 등록된 직원은 담당자가 아니다", () => {
  const org = D.createCompany({ name: "직원㈜" });
  const staff = D.createPerson({ name: "그냥직원" });
  D.addAffiliation(staff, { org_id: org, closeCurrent: false }); // 연락처 폼 '회사' 입력 경로(syncCompanyAffiliation)
  assert.deepEqual(D.listPersonsForOrg(org).map((p) => p.name), ["그냥직원"], "재직");
  assert.deepEqual(D.listOrgContacts(org), [], "담당자 아님 — 담당자 칸에 안 뜸");
});

test("setOrgContacts: 대표자를 담당자에서 빼도 소속 유지(담당자 지정만 해제)", () => {
  const owner = D.createPerson({ name: "대표자" });
  const org = D.createCompany({ name: "대표㈜", owner_party_id: owner });
  D.ensureOwnerAffiliation(owner, org);
  const staff = D.createPerson({ name: "직원" });
  D.setOrgContacts(org, [owner, staff]); // 대표도 담당자로 지정 가능
  assert.equal(D.listOrgContacts(org).length, 2);
  D.setOrgContacts(org, [staff]); // 대표를 담당자에서 뺌
  assert.deepEqual(D.listOrgContacts(org).map((p) => p.id), [staff], "담당자=직원만");
  assert.ok(D.listPersonsForOrg(org).map((p) => p.id).includes(owner), "대표 재직 유지");
});

test("setOrgContacts: 빈 목록이면 담당자 전원 해제(재직은 전원 유지)", () => {
  const org = D.createCompany({ name: "해제㈜" });
  const staff = D.createPerson({ name: "해제직원" });
  D.setOrgContacts(org, [staff]);
  D.setOrgContacts(org, []);
  assert.deepEqual(D.listOrgContacts(org), [], "담당자 없음");
  assert.deepEqual(D.listPersonsForOrg(org).map((p) => p.name), ["해제직원"], "재직 유지");
});

// ── 직책 → 호칭 자동 파생(2026-07-10 사용자 결정: '대표 직책 → 대표님 호칭' 흐름을 전 직책으로) ──
const { honorificFromTitle } = require("../src/lib/korean-name");
test("honorificFromTitle: 직책에 '님'을 붙이되 이미 있으면 그대로, 빈값은 null", () => {
  assert.equal(honorificFromTitle("대표"), "대표님");
  assert.equal(honorificFromTitle("실장"), "실장님");
  assert.equal(honorificFromTitle("실장님"), "실장님", "이미 님으로 끝나면 중복 안 붙임");
  assert.equal(honorificFromTitle(" 팀장 "), "팀장님", "공백 정리");
  assert.equal(honorificFromTitle(""), null);
  assert.equal(honorificFromTitle(null), null);
});

test("createPerson: 직책만 넣으면 호칭 자동 파생, 명시 호칭은 존중", () => {
  const a = D.getParty(D.createPerson({ name: "엄유미", job_title: "실장" }));
  assert.equal(a.honorific, "실장님", "직책 → 호칭 파생");
  assert.equal(a.job_title, "실장", "직책 원본 보존");
  const b = D.getParty(D.createPerson({ name: "김직함", job_title: "부장", honorific: "선생님" }));
  assert.equal(b.honorific, "선생님", "명시 호칭 우선");
  const c = D.getParty(D.createPerson({ name: "무직책" }));
  assert.equal(c.honorific, null, "직책 없으면 호칭도 없음");
});

test("updateParty: 나중에 직책을 넣으면 호칭 파생, 기존 호칭은 안 덮음", () => {
  const id = D.createPerson({ name: "나중직책" });
  D.updateParty(id, { job_title: "과장" });
  assert.equal(D.getParty(id).honorific, "과장님", "직책 추가 → 호칭 파생");
  D.updateParty(id, { job_title: "차장" }); // 이미 호칭 있음 — 존중(사용자가 호칭을 따로 관리할 수 있게)
  assert.equal(D.getParty(id).honorific, "과장님", "기존 호칭 유지");
});

// ── 회사 대표자 다대다(공동대표, 2026-07-10 사용자 요청 '대표자가 2명인 경우도 있다') ──
// company_owners 조인 테이블이 진실원천. parties.owner_party_id=첫 대표(레거시 참조)·owner_name=콤마 목록
// (청구처 카드 '성명(대표자)'·거래명세서 스냅샷이 쓰는 표시 텍스트) 동기화.
test("setCompanyOwners: 공동대표 2명 — 조인 저장 + 레거시 첫 대표·콤마 이름 동기화", () => {
  const co = D.createCompany({ name: "공동대표㈜" });
  const a = D.createPerson({ name: "김대표" });
  const b = D.createPerson({ name: "박대표" });
  D.setCompanyOwners(co, [a, b]);
  assert.deepEqual(D.listCompanyOwners(co).map((p) => p.id), [a, b], "조인 순서 보존");
  const row = D.getParty(co);
  assert.equal(row.owner_party_id, a, "레거시 owner_party_id = 첫 대표");
  assert.equal(row.owner_name, "김대표, 박대표", "owner_name = 콤마 목록(청구처 카드·PDF 표시)");
});

test("setCompanyOwners: 대표에게 '대표님' 호칭 + 이 회사 소속 자동 연결", () => {
  const co = D.createCompany({ name: "호칭㈜" });
  const a = D.createPerson({ name: "무호칭" });
  D.setCompanyOwners(co, [a]);
  assert.equal(D.getParty(a).honorific, "대표님", "대표 호칭 자동");
  assert.equal(D.currentAffiliation(a).org_id, co, "대표 소속 = 이 회사");
});

test("setCompanyOwners: 통째 교체 — 빠진 대표는 대표에서만 빠지고 연락처·소속은 유지", () => {
  const co = D.createCompany({ name: "교체대표㈜" });
  const a = D.createPerson({ name: "유임대표" });
  const b = D.createPerson({ name: "사임대표" });
  D.setCompanyOwners(co, [a, b]);
  D.setCompanyOwners(co, [a]);
  assert.deepEqual(D.listCompanyOwners(co).map((p) => p.id), [a], "대표=유임대표만");
  assert.ok(D.getParty(b), "사임대표 연락처 보존");
  assert.equal(D.getParty(co).owner_name, "유임대표");
  assert.equal(D.currentAffiliation(b).org_id, co, "재직은 유지(대표 해제≠퇴사)");
});

test("setCompanyOwners: 빈 목록이면 대표 전원 해제(레거시 컬럼도 비움)", () => {
  const co = D.createCompany({ name: "무대표㈜" });
  const a = D.createPerson({ name: "전대표" });
  D.setCompanyOwners(co, [a]);
  D.setCompanyOwners(co, []);
  assert.deepEqual(D.listCompanyOwners(co), []);
  const row = D.getParty(co);
  assert.equal(row.owner_party_id, null);
  assert.equal(row.owner_name, null);
});

test("공동대표 전원이 역참조·관계자 탭에 노출(첫 대표만이 아니라)", () => {
  const co = D.createCompany({ name: "배지㈜" });
  const a = D.createPerson({ name: "일대표" });
  const b = D.createPerson({ name: "이대표" });
  D.setCompanyOwners(co, [a, b]);
  for (const pid of [a, b]) {
    assert.ok(D.orgsWithOwnerParty(pid).map((o) => o.id).includes(co), `${pid}: 대표인 회사 역참조(연락처 상세 크로스링크)`);
  }
  const assoc = D.listAssociates({}).map((p) => p.id);
  assert.ok(assoc.includes(a) && assoc.includes(b), "둘 다 관계자 탭(둘째 대표 누락 금지)");
});

test("deleteParty: 대표를 삭제하면 남은 대표가 승계되고 레거시 컬럼도 재동기화", () => {
  const co = D.createCompany({ name: "삭제대표㈜" });
  const a = D.createPerson({ name: "떠날대표" });
  const b = D.createPerson({ name: "남을대표" });
  D.setCompanyOwners(co, [a, b]);
  D.deleteParty(a);
  assert.deepEqual(D.listCompanyOwners(co).map((p) => p.id), [b], "남은 대표만");
  const row = D.getParty(co);
  assert.equal(row.owner_party_id, b, "둘째 대표가 첫 대표로 승계");
  assert.equal(row.owner_name, "남을대표", "owner_name 재동기화(삭제된 이름 잔존 금지)");
});

// ── 업체 이름 중복 방지(2026-07-14 — 프로덕션에서 같은 '뮤직팜'이 3개로 늘어난 사고) ──
test("ensureCompanyParty: 공백·대소문자 차이는 같은 회사로 재사용(중복 생성 안 함)", () => {
  const D = require("../src/data");
  const id = D.ensureCompanyParty("뮤직팜", "소속사/레이블");
  assert.ok(id);
  assert.equal(D.ensureCompanyParty("뮤직팜", "제작사"), id, "같은 이름 재사용");
  assert.equal(D.ensureCompanyParty(" 뮤직팜 ", null), id, "앞뒤 공백 무시");
  assert.equal(D.ensureCompanyParty("뮤직 팜", null), id, "가운데 공백 무시");
  assert.equal(D.resolveCompanyByName("MusicFarm"), null, "다른 이름은 매칭 안 됨");
  const cnt = require("../src/db").db().prepare("SELECT COUNT(*) AS n FROM parties WHERE kind='company' AND name LIKE '%뮤직%'").get().n;
  assert.equal(cnt, 1, "업체는 하나만 생성");
});

test("resolveCompanyByName: 전각 공백·NBSP·비ASCII 대문자가 든 저장 이름도 매칭(SQL/JS 정규화 일원화)", () => {
  const D = require("../src/data");
  // 전각 공백(U+3000)이 든 이름으로 저장 — 옛 SQL 정규화는 이 문자를 못 지워 자기 자신과도 매칭 실패했다
  const a = D.createCompany({ name: "스타　뮤직" }); // U+3000
  assert.equal(D.resolveCompanyByName("스타뮤직"), a, "전각 공백 무시 매칭");
  assert.equal(D.ensureCompanyParty("스타 뮤직", null), a, "일반 공백 입력도 같은 회사");
  const b = D.createCompany({ name: "ＣＪミュージック" }); // 전각 라틴 대문자
  assert.equal(D.resolveCompanyByName("ｃｊミュージック"), b, "유니코드 소문자화 매칭");
});

// ── 아티스트 활동 형태(2026-07-16 사용자 요청) — 솔로/그룹/솔로+그룹 수동 필드 + 백필/폴백 ──
test("활동 형태: createPerson/updateParty가 activity_form을 저장·부분 갱신 보존", () => {
  const id = D.createPerson({ name: "테스트아티스트", activity_name: "테스트아티스트", is_artist: 1, activity_form: "both" });
  assert.equal(D.getParty(id).activity_form, "both", "생성 시 activity_form 저장");
  // 부분 갱신: activity_form 미전송이면 보존(다른 필드만 수정)
  D.updateParty(id, { name: "테스트아티스트", phone: "010-1111-2222" });
  assert.equal(D.getParty(id).activity_form, "both", "미전송 시 기존값 보존(부분 갱신 계약)");
  // 명시 변경
  D.updateParty(id, { name: "테스트아티스트", activity_form: "group" });
  assert.equal(D.getParty(id).activity_form, "group", "명시 전송 시 갱신");
  // 비아티스트(관계자)는 null
  const cid = D.createPerson({ name: "관계자김", job_title: "실장" });
  assert.equal(D.getParty(cid).activity_form, null, "활동 형태 미전송 관계자는 null");
});

// ── 그룹 정체성: 그룹명 수정 시 activity_name 동기화(2026-07-16 사용자 리포트 '옛이름 (새이름)'으로 표시됨) ──
test("그룹명 수정 → activity_name 동기화(표시가 '옛이름 (새이름)' 안 됨)", () => {
  const { personLabel } = require("../src/views");
  const id = D.createGroup({ name: "cutthecrap" });
  assert.equal(D.getParty(id).activity_name, "cutthecrap", "생성 시 activity_name=name");
  // 라우트 계약: 그룹은 activity_name을 새 name과 동기화해 넘긴다(clients.routes POST /:id).
  const newName = "컷더크랩(cutthecrap)";
  D.updateParty(id, { name: newName, activity_name: newName, is_artist: 1 });
  const g = D.getParty(id);
  assert.equal(g.name, newName, "그룹명 갱신");
  assert.equal(g.activity_name, newName, "activity_name도 새 이름으로 동기화");
  assert.equal(personLabel(g.activity_name || g.name, g.name), newName, "표시=단일 이름(괄호 병기 없음)");
});

// ── 솔로 아티스트도 그룹과 같은 정체성 버그(2026-07-16 사용자 요청 확인) — 이름==활동명이면 동기화, 본명≠활동명이면 보존 ──
test("솔로 아티스트 이름 수정: 이름==활동명이면 activity_name 동기화·본명≠활동명이면 활동명 보존", () => {
  const { personLabel } = require("../src/views");
  // 라우트(POST /:id) 규칙 재현: (그룹 || 옛 name==activity_name) ? 새 name : 옛 activity_name
  const routeAct = (c, newName) => (c.kind === "group" || c.name === c.activity_name) ? newName : c.activity_name;
  // ① 이름==활동명(본명 없음) → 동기화, 이중 표시 없음
  const a = D.createPerson({ name: "루나", activity_name: "루나", is_artist: 1 });
  let c = D.getParty(a);
  D.updateParty(a, { name: "루나(에이스)", activity_name: routeAct(c, "루나(에이스)"), is_artist: 1 });
  c = D.getParty(a);
  assert.equal(c.activity_name, "루나(에이스)", "동기화");
  assert.equal(personLabel(c.activity_name, c.name), "루나(에이스)", "이중 표시 없음");
  // ② 본명≠활동명(모달 등록) → 활동명 보존, 이름(본명)만 변경
  const b = D.createPerson({ name: "김루나", activity_name: "루나", is_artist: 1 });
  c = D.getParty(b);
  D.updateParty(b, { name: "김에이스", activity_name: routeAct(c, "김에이스"), is_artist: 1 });
  c = D.getParty(b);
  assert.equal(c.name, "김에이스", "본명 변경");
  assert.equal(c.activity_name, "루나", "활동명 보존");
  assert.equal(personLabel(c.activity_name, c.name), "루나 (김에이스)", "활동명 (본명) 정상 병기");
});

// ── 연락처 역할 필터(2026-07-17 사람/조직 축 정리) ──
// 탭은 상호배타가 아니라 '필터'다: 전체 ⊇ 아티스트·관계자, 아티스트∩관계자 겹침 정상(겸업).
test("listContacts({tab}): 전체/아티스트/관계자/외주/스태프 필터", () => {
  const d = db();
  // 순수 관계자(프로젝트 고객측 담당자로 참조) · 아티스트 겸 관계자 · 순수 아티스트 · 외주 · 스태프
  const assoc = Number(d.prepare("INSERT INTO parties (kind,name) VALUES ('person','필터관계자')").run().lastInsertRowid);
  const both = Number(d.prepare("INSERT INTO parties (kind,name,activity_name,is_artist) VALUES ('person','필터겸업','겸업활동명',1)").run().lastInsertRowid);
  const pureArtist = Number(d.prepare("INSERT INTO parties (kind,name,activity_name,is_artist) VALUES ('person','필터아티스트','순수활동명',1)").run().lastInsertRowid);
  const pid = Number(d.prepare("INSERT INTO projects (title,project_type) VALUES ('필터검증작','session')").run().lastInsertRowid);
  d.prepare("INSERT INTO project_contacts (project_id,party_id) VALUES (?,?)").run(pid, assoc);
  d.prepare("INSERT INTO project_contacts (project_id,party_id) VALUES (?,?)").run(pid, both); // 겸업: 아티스트인데 담당자 역할도
  const worker = Number(d.prepare("INSERT INTO parties (kind,name) VALUES ('person','필터외주')").run().lastInsertRowid);
  d.prepare("INSERT INTO project_managers (name,party_id,active) VALUES ('필터외주',?,1)").run(worker);
  const uid = Number(d.prepare("INSERT INTO users (email,role,name,active) VALUES ('filter-staff@t.t','staff','필터스태프',1)").run().lastInsertRowid);
  const staff = Number(d.prepare("INSERT INTO parties (kind,name,user_id) VALUES ('person','필터스태프',?)").run(uid).lastInsertRowid);

  const ids = (tab) => new Set(D.listContacts(tab ? { tab } : {}).map((r) => r.id));
  const all = ids("all"), artist = ids("artist"), assocSet = ids("associate"), wrk = ids("worker"), stf = ids("staff");

  // 전체 = 사람 전부(외주·스태프 포함)
  [assoc, both, pureArtist, worker, staff].forEach((id) => assert.ok(all.has(id), `전체에 ${id}`));
  // 아티스트 = is_artist
  assert.ok(artist.has(pureArtist) && artist.has(both), "아티스트 필터");
  assert.ok(!artist.has(assoc), "비아티스트는 아티스트 필터에 없음");
  // 관계자 = 비스태프·비외주 + (비아티스트 or 역할 참조)
  assert.ok(assocSet.has(assoc), "순수 관계자");
  assert.ok(assocSet.has(both), "아티스트 겸 관계자도 관계자 필터에");
  assert.ok(!assocSet.has(pureArtist), "역할 없는 순수 아티스트는 관계자 아님");
  assert.ok(!assocSet.has(worker) && !assocSet.has(staff), "외주·스태프는 관계자 아님");
  // 외주·스태프는 서로 배타
  assert.ok(wrk.has(worker) && !wrk.has(staff), "외주 필터");
  assert.ok(stf.has(staff) && !stf.has(worker), "스태프 필터");
  // 겹침(겸업)은 정상 — 같은 사람이 아티스트·관계자 양쪽에
  assert.ok(artist.has(both) && assocSet.has(both), "겸업자는 두 필터 모두에");
  // 미지정·모르는 값 = 전체 폴백
  assert.equal(ids().size, all.size, "tab 미지정 = 전체");
  assert.equal(ids("몰라").size, all.size, "모르는 tab = 전체");
});

test("listContacts({tab, q}): 검색어와 필터가 함께 걸린다", () => {
  const only = D.listContacts({ tab: "artist", q: "순수활동명" });
  assert.ok(only.length >= 1 && only.every((r) => r.is_artist), "아티스트 필터 + 활동명 검색");
});

// ── 2026-07-17: 아티스트 '소속사'와 연락처 '회사'는 같은 데이터(affiliations 현재 소속) ──
// 폼을 '소속' 한 칸으로 합치기 전에 두 저장 경로의 결과 동등성을 고정한다.
test("setPartyAgency와 syncCompanyAffiliation은 같은 현재 소속을 만든다", () => {
  const co = Number(db().prepare("INSERT INTO parties (kind,name) VALUES ('company','소속통합상사')").run().lastInsertRowid);
  const a = Number(db().prepare("INSERT INTO parties (kind,name,is_artist) VALUES ('person','소속아티스트',1)").run().lastInsertRowid);
  const b = Number(db().prepare("INSERT INTO parties (kind,name) VALUES ('person','소속관계자')").run().lastInsertRowid);

  D.setPartyAgency(a, co);                       // 아티스트 폼 경로
  D.syncCompanyAffiliation(b, "소속통합상사", ""); // 연락처 폼 경로(회사명 텍스트)

  const curA = D.currentAffiliation(a), curB = D.currentAffiliation(b);
  assert.equal(curA.org_id ?? curA.client_id, co, "아티스트 경로 → 그 업체가 현재 소속");
  assert.equal(curB.org_id ?? curB.client_id, co, "연락처 경로 → 같은 업체 재사용(새로 만들지 않음)");
  assert.equal(D.listAffiliations(a).filter((x) => !x.ended_on).length, 1, "현재 소속 1건");
  assert.equal(D.listAffiliations(b).filter((x) => !x.ended_on).length, 1, "현재 소속 1건");
});

test("updateParty: 성/이름 편집 시 표시명(name) 재구성 — 옛 name에 막히지 않음(2026-07-18 버그)", () => {
  // 단일필드 이름 '내원'(활동명도 내원)으로 생성 → 성=공, 이름=내원 편집 → name이 '공내원'으로 반영돼야.
  const id = D.createPerson({ name: "내원", nickname: "내원" });
  assert.equal(D.getParty(id).name, "내원", "생성 직후 단일필드 이름");
  D.updateParty(id, { family_name: "공", given_name: "내원", nickname: "내원" });
  assert.equal(D.getParty(id).name, "공내원", "성+이름으로 재구성");
  assert.equal(D.getParty(id).family_name, "공");
  assert.equal(D.getParty(id).given_name, "내원");
});

test("updateParty: 이름 필드 미전송(전화만 수정)이면 표시명 보존", () => {
  const id = D.createPerson({ name: "홍길동", family_name: "홍", given_name: "길동" });
  D.updateParty(id, { phone: "010-1234-5678" }); // 이름 분리 필드 미전송
  assert.equal(D.getParty(id).name, "홍길동", "이름 미전송 시 기존 표시명 보존");
});

test("updateParty: 레거시 단일필드 이름 + 이름 필드 미전송이면 보존(재구성으로 지워지지 않음)", () => {
  const id = D.createPerson({ name: "외자" }); // family/given 없음
  D.updateParty(id, { memo: "메모만" });
  assert.equal(D.getParty(id).name, "외자", "성/이름 없는 단일필드 이름 보존");
});
