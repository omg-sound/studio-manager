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
test("createInvoiceFromTasks: 청구처 미지정 시 프로젝트 제작사>소속사>아티스트 party로 파생", () => {
  const artistId = D.createPerson({ name: "가창", nickname: "보컬A" });
  const agencyId = D.createCompany({ name: "소속C", biz_no: "123-45-67890" }); // 세금계산서 정보(회사 청구처 발행 요건)
  const proj = db()
    .prepare("INSERT INTO projects (title, project_type, rate, artist_id, agency_id) VALUES (?, 'task', 0, ?, ?)")
    .run("파생 테스트", artistId, agencyId);
  const projectId = Number(proj.lastInsertRowid);
  const tr = db().prepare("INSERT INTO project_tracks (project_id, title, content_type) VALUES (?, ?, 'Music')").run(projectId, "곡");
  const tk = db()
    .prepare("INSERT INTO track_tasks (track_id, task_type, billing_type, quantity, unit_price, total_price, status, is_invoiced) VALUES (?, 'Mixing', 'Fixed_Per_Track', 1, 500000, 500000, 'Completed', 0)")
    .run(Number(tr.lastInsertRowid));
  const inv = D.createInvoiceFromTasks(CHIEF, { projectId, taskIds: [Number(tk.lastInsertRowid)], issueDate: "2026-07-02" });
  assert.ok(inv, "인보이스 생성");
  // 청구처 미지정 → 제작사 없음·소속사(agencyId) 우선 파생
  const payerId = db().prepare("SELECT payer_id FROM invoices WHERE id=?").get(inv.id).payer_id;
  assert.equal(payerId, agencyId, "payer=소속사 party(제작사 없으므로)");
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
  assert.ok(D.createInvoiceFromTasks(CHIEF, { projectId: c3.pid, taskIds: [c3.tk], clientId: person, issueDate: "2026-07-02" }), "현금영수증 정보 채우면 청구 생성");
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
