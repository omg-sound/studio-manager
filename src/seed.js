"use strict";

/**
 * 더미 데이터 시드: 치프 1 + 스태프 + 거래처 + 프로젝트(빈/밀집 점검용).
 * 전원 Google 로그인(화이트리스트) 모델 — 비밀번호 계정 없음.
 * 실행: npm run seed
 * 멱등성: 이메일/이름 기준으로 중복 생성 방지.
 */

const fs = require("fs");
const pathm = require("path");
const crypto = require("crypto");
const { config } = require("./config");
const { init, db } = require("./db");
const { todayYmd, ymd } = require("./lib/date");

init();
const d = db();

function addDays(n) {
  const t = new Date();
  t.setDate(t.getDate() + n);
  return ymd(t);
}

function ensureClient(name, kind, email, phone) {
  let c = d.prepare("SELECT * FROM clients WHERE name = ?").get(name);
  if (!c) {
    const info = d
      .prepare("INSERT INTO clients (name, kind, email, phone) VALUES (?,?,?,?)")
      .run(name, kind, email, phone);
    c = d.prepare("SELECT * FROM clients WHERE id = ?").get(info.lastInsertRowid);
    console.log("  + 거래처:", name);
  }
  return c;
}

function ensureUser(email, role, name) {
  let u = d.prepare("SELECT * FROM users WHERE email = ?").get(email);
  if (!u) {
    d.prepare("INSERT INTO users (email, role, name, active) VALUES (?,?,?,1)").run(email, role, name);
    console.log(`  + 사용자(${role}):`, email);
  }
}

function ensureManager(name, email, phone) {
  let manager = d.prepare("SELECT * FROM project_managers WHERE name = ?").get(name);
  if (!manager) {
    const info = d
      .prepare("INSERT INTO project_managers (name, email, phone, active) VALUES (?,?,?,1)")
      .run(name, email || null, phone || null);
    manager = d.prepare("SELECT * FROM project_managers WHERE id = ?").get(info.lastInsertRowid);
    console.log("  + 담당자:", name);
  }
  return manager;
}

function svc(key, label, amount, requestedOffset = -14, completedOffset = null) {
  return {
    key,
    label,
    amount,
    requested_at: addDays(requestedOffset),
    completed_at: completedOffset == null ? "" : addDays(completedOffset),
    custom: key.startsWith("custom:"),
  };
}

function ensureProject(title, artist, artistCompany, productionCompany, clientId, managerId, services, memo) {
  const exists = d.prepare("SELECT id, services, manager_id FROM projects WHERE title = ?").get(title);
  const encodedServices = JSON.stringify(services || []);
  const dueDate = (services || []).map((s) => s.completed_at).filter(Boolean).sort().pop() || null;
  const rate = (services || []).reduce((sum, s) => sum + (s.amount || 0), 0);
  if (!exists) {
    d.prepare(
      `INSERT INTO projects (title, artist, artist_company, production_company, client_id, manager_id, services, due_date, rate, memo)
       VALUES (?,?,?,?,?,?,?,?,?,?)`
    ).run(title, artist, artistCompany, productionCompany, clientId, managerId, encodedServices, dueDate, rate, memo);
    console.log("  + 프로젝트:", title);
  } else if (exists.services !== encodedServices || Number(exists.manager_id || 0) !== Number(managerId || 0)) {
    d.prepare(
      `UPDATE projects SET artist=?, artist_company=?, production_company=?, client_id=?, manager_id=?,
       services=?, due_date=?, rate=?, memo=? WHERE id=?`
    ).run(artist, artistCompany, productionCompany, clientId, managerId, encodedServices, dueDate, rate, memo, exists.id);
  }
}

console.log("🌱 시드 시작...");

// 치프 엔지니어(부트스트랩). 실제 운영은 Google OAuth, DEV_LOGIN 검증을 위해 chief 행을 둔다.
const adminEmail = config.adminEmail || "studio@example.com";
ensureUser(adminEmail, "chief", "치프 엔지니어");

// 대표(owner) — 전체 모니터링 + 청구 열람·관리
ensureUser("ceo@example.com", "owner", "OMG 대표");

// 스태프(엔지니어/매니저) — 화이트리스트 로그인 검증용
ensureUser("engineer@example.com", "staff", "녹음 엔지니어");
ensureUser("manager@example.com", "staff", "스튜디오 매니저");

// 거래처(프로젝트 데이터로만 존속 — 로그인 안 함)
const blue = ensureClient("블루노트 레코즈", "레이블", "label@bluenote.example", "02-1234-5678");
const luna = ensureClient("아티스트 루나", "아티스트", "luna@example.com", "010-0000-1111");
const adco = ensureClient("MADE 광고대행", "대행사", "ad@made.example", null);

// 담당자
const studioManager = ensureManager("스튜디오 관리자", adminEmail, null);
const mixManager = ensureManager("믹스 담당", null, null);

// 프로젝트(밀집 화면 + 마감 임박/지남 다양하게)
ensureProject("루나 1집 - 타이틀곡 '월광'", "루나", "문라이트뮤직", "블루노트 레코즈", luna.id, studioManager.id, [svc("recording", "녹음", 900000), svc("vocal_tune", "보컬튠", 500000), svc("mixing", "믹싱", 1100000)], "보컬 튜닝 후 믹스 v2 진행");
ensureProject("루나 - 어쿠스틱 싱글", "루나", "", "", luna.id, studioManager.id, [svc("recording", "녹음", 800000)], null);
ensureProject("루나 - 리믹스 EP", "루나", "", "", luna.id, mixManager.id, [svc("mixing", "믹싱", 1200000, -20, -6), svc("mastering", "마스터링", 600000, -12, -5)], "납품 완료");
ensureProject("블루노트 컴필레이션 Vol.3", "Various Artists", "", "블루노트 레코즈", blue.id, mixManager.id, [svc("mastering", "마스터링", 4200000)], "마스터링 8트랙");
ensureProject("블루노트 신인 데모 패키지", "블루노트 신인팀", "", "블루노트 레코즈", blue.id, studioManager.id, [svc("recording", "녹음", 0), svc("vocal_tune", "보컬튠", 0)], "예산 협의 중");
ensureProject("MADE - 자동차 광고 BGM", "세션 보컬", "", "MADE 광고대행", adco.id, studioManager.id, [svc("recording", "녹음", 700000), svc("mixing", "믹싱", 800000)], "30초/15초 2버전");
ensureProject("미지정 거래처 데모 작업", "미정", "", "", null, studioManager.id, [svc("recording", "녹음", 300000)], "거래처 미지정 예시");

// 샘플 자료 전달(로컬 백엔드) — 토큰 링크 검증용. 루나 1집 프로젝트에 연결.
function ensureSampleDeliverable() {
  const proj = d.prepare("SELECT * FROM projects WHERE title LIKE '루나 1집%'").get();
  if (!proj) return;
  if (d.prepare("SELECT id FROM deliverables WHERE title = ?").get("월광 Mix v2 (샘플)")) return;
  fs.mkdirSync(config.uploadsDir, { recursive: true });
  const fileId = crypto.randomBytes(16).toString("hex");
  const content = Buffer.from("OMG Studios 샘플 자료\n월광 Mix v2\n(시드 데이터 — 실제 오디오 아님)\n", "utf8");
  fs.writeFileSync(pathm.join(config.uploadsDir, fileId), content);
  const token = crypto.randomBytes(24).toString("hex");
  d.prepare(
    `INSERT INTO deliverables (project_id,title,version,kind,storage_backend,file_id,file_name,file_size,mime_type,access_token)
     VALUES (?,?,?,?,?,?,?,?,?,?)`
  ).run(proj.id, "월광 Mix v2 (샘플)", "v2", "믹스", "local", fileId, "월광_mix_v2.txt", content.length, "text/plain", token);
  console.log("  + 자료(샘플): 월광 Mix v2 → /d/" + token);
}
ensureSampleDeliverable();

// 샘플 인보이스(상태 다양화: 발행미납/연체부분납/입금완료/미발행)
function ensureInvoice(title, projectLike, clientName, amount, paid, status, issuedOffset, dueOffset) {
  if (d.prepare("SELECT id FROM invoices WHERE title = ?").get(title)) return;
  const proj = projectLike ? d.prepare("SELECT id FROM projects WHERE title LIKE ?").get(projectLike) : null;
  const cli = clientName ? d.prepare("SELECT id FROM clients WHERE name = ?").get(clientName) : null;
  d.prepare(
    `INSERT INTO invoices (project_id, client_id, title, amount, paid_amount, status, issued_date, due_date)
     VALUES (?,?,?,?,?,?,?,?)`
  ).run(
    proj ? proj.id : null,
    cli ? cli.id : null,
    title,
    amount,
    paid,
    status,
    issuedOffset == null ? null : addDays(issuedOffset),
    dueOffset == null ? null : addDays(dueOffset)
  );
  console.log("  + 청구:", title, `(${status})`);
}

ensureInvoice("루나 1집 믹싱비", "루나 1집%", "아티스트 루나", 2500000, 0, "발행", -2, 10);
ensureInvoice("루나 어쿠스틱 싱글 녹음비", "루나 - 어쿠스틱%", "아티스트 루나", 800000, 400000, "발행", -20, -3); // 연체 부분납
ensureInvoice("블루노트 컴필 마스터링비", "블루노트 컴필%", "블루노트 레코즈", 4200000, 4200000, "입금완료", -20, -5);
ensureInvoice("루나 리믹스 EP 작업비", "루나 - 리믹스%", "아티스트 루나", 1800000, 1800000, "입금완료", -8, 0);
ensureInvoice("MADE 광고 BGM 견적", "MADE - 자동차%", "MADE 광고대행", 1500000, 0, "미발행", null, null);

// 샘플 세션(전역 일정 데모) — 루나 1집 프로젝트에 다가오는/지난 세션
function ensureSessions() {
  const proj = d.prepare("SELECT id FROM projects WHERE title LIKE '루나 1집%'").get();
  if (!proj) return;
  if (d.prepare("SELECT id FROM sessions WHERE project_id = ?").get(proj.id)) return;
  const ins = d.prepare(
    `INSERT INTO sessions (project_id, session_type, session_date, start_time, end_time, engineer_name, status, memo)
     VALUES (?,?,?,?,?,?,?,?)`
  );
  ins.run(proj.id, "녹음", addDays(2), "13:00", "17:00", "믹스 담당", "예정", "보컬 추가 녹음");
  ins.run(proj.id, "믹싱", addDays(5), "10:00", "19:00", "믹스 담당", "예정", null);
  ins.run(proj.id, "녹음", addDays(-6), "14:00", "18:00", "스튜디오 관리자", "완료", "기본 트랙 녹음");
  console.log("  + 세션 3건(루나 1집)");
}
ensureSessions();

// 단가표(과금 항목) 기본값 — 보컬녹음 1Pro 3.5h=30만, 초과 1h당 10만 / 그룹 35만
function ensureRateItems() {
  if (d.prepare("SELECT id FROM rate_items LIMIT 1").get()) return;
  const ins = d.prepare(
    "INSERT INTO rate_items (name, base_minutes, base_price, extra_minutes, extra_price, active) VALUES (?,?,?,?,?,1)"
  );
  ins.run("보컬 녹음", 210, 300000, 60, 100000);
  ins.run("악기+보컬 녹음(그룹)", 210, 350000, 60, 100000);
  console.log("  + 단가 항목 2건(보컬 녹음 · 그룹)");
}
ensureRateItems();

console.log("✅ 시드 완료.");
console.log("");
console.log("로그인 정보(전원 Google 화이트리스트 / DEV_LOGIN=1 권장):");
console.log(`  치프:   /dev-login(치프) 또는 Google OAuth(${adminEmail})`);
console.log("  대표:   /dev-login(대표) — ceo@example.com");
console.log("  스태프: /dev-login(스태프) — engineer@example.com · manager@example.com");
