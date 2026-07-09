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
  // 담당자 이메일 변경도 감지(스냅샷 contacts[0] 비교)
  const person = D.createPerson({ name: "담당자김" });
  db().prepare("UPDATE parties SET email='dd@snap.kr' WHERE id=?").run(person);
  D.addAffiliation(person, { client_id: co, title: "과장" });
  assert.equal(D.payerSnapshotChanged(inv()), true, "담당자(이메일) 추가 = 변경 감지");
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
