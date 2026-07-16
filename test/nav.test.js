"use strict";

// ── 격리 DB 셋업(다른 테스트와 동일 패턴 — invoiceTaxTab이 data 모듈 경유라 config 가드 회피용) ──
process.env.NODE_ENV = "test";
const { tempDbPath, cleanupDb } = require("./helpers");
process.env.DB_PATH = tempDbPath();

const test = require("node:test");
const assert = require("node:assert");

const { safePath } = require("../src/lib/nav");
const { invoiceTaxTab } = require("../src/data/invoices");

test.after(() => cleanupDb(process.env.DB_PATH));

// ── safePath: ?return=/폼 return 복귀 경로의 open-redirect 차단(2026-07-09 감사 후속 — 보안 민감 로직 잠금) ──
test("safePath: 내부 절대경로만 통과", () => {
  assert.equal(safePath("/invoices"), "/invoices");
  assert.equal(safePath("/invoices?tab=paid&open=3"), "/invoices?tab=paid&open=3");
  assert.equal(safePath("/projects/1?tab=invoice"), "/projects/1?tab=invoice");
  assert.equal(safePath("/"), "/");
});

test("safePath: 외부·위장 경로 전부 거부(null)", () => {
  assert.equal(safePath("https://evil.com"), null, "절대 URL");
  assert.equal(safePath("//evil.com"), null, "protocol-relative");
  assert.equal(safePath("/\\evil.com"), null, "역슬래시(브라우저가 //로 정규화하는 우회)");
  assert.equal(safePath("evil.com/x"), null, "상대경로");
  assert.equal(safePath("javascript:alert(1)"), null, "스킴");
  assert.equal(safePath(""), null, "빈 문자열");
  assert.equal(safePath(null), null, "null");
  assert.equal(safePath(undefined), null, "undefined");
  assert.equal(safePath(123), null, "비문자열");
});

// ── invoiceTaxTab: 청구 목록 3탭 분류(발행 필요/발행 완료/입금완료) — 상호 배타 보장 ──
test("invoiceTaxTab: tax_status → todo/done/paid 상호 배타 분류", () => {
  assert.equal(invoiceTaxTab({ tax_status: "계산서 미발행" }), "todo");
  assert.equal(invoiceTaxTab({ tax_status: "계산서 발행" }), "done");
  assert.equal(invoiceTaxTab({ tax_status: "입금완료" }), "paid");
  assert.equal(invoiceTaxTab({ tax_status: null }), "todo", "레거시 null도 발행 필요로");
  assert.equal(invoiceTaxTab({}), "todo");
  assert.equal(invoiceTaxTab(null), "todo");
  // 상호 배타: 어떤 상태값이든 정확히 한 탭에만 속한다
  for (const s of ["계산서 미발행", "계산서 발행", "입금완료", null, undefined, "이상한값"]) {
    const tabs = ["todo", "done", "paid"].filter((t) => invoiceTaxTab({ tax_status: s }) === t);
    assert.equal(tabs.length, 1, `상태 '${s}'는 정확히 한 탭`);
  }
});

// ── 목록 → 상세 → 돌아가기 = 보던 목록으로 복귀(2026-07-14 사용자 요청 '모든 돌아가기를 이 방식으로') ──
// 라우트 소스 계약을 검사한다: ①목록 행 링크가 ?return=<현재 목록 주소>를 실어 보내고
// ②상세 백링크가 safePath(req.query.return)를 쓴다. 하나라도 빠지면 그 화면만 조용히 옛 동작(기본 목록)으로 돌아간다.
const fs = require("fs");
const path = require("path");
const R = (f) => fs.readFileSync(path.join(__dirname, "..", "src", "routes", f), "utf8");

test("전 목록: 상세 백링크가 return(safePath)으로 복귀 — 청구·프로젝트·연락처·클라이언트·외주", () => {
  const backContract = [
    ["invoices.routes.js", /safePath\(req\.query\.return\)\s*\|\|\s*"\/invoices"/],
    ["projects.routes.js", /safePath\(req\.query\.return\)\s*\|\|\s*"\/projects"/],
    ["workers.routes.js", /safePath\(req\.query\.return\)\s*\|\|\s*"\/workers"/],
  ];
  for (const [file, re] of backContract) assert.match(R(file), re, `${file}: 백링크가 return을 안 씀`);
  // 연락처·클라이언트는 return + 레거시 from(필터) 폴백을 함께 쓴다.
  assert.match(R("contacts.routes.js"), /const ret = safePath\(retQ\);/, "contacts: return 해석");
  assert.match(R("clients.routes.js"), /const ret = safePath\(retQ\);/, "clients: return 해석");
});

test("전 목록: 행 링크가 현재 목록 주소를 return으로 넘긴다", () => {
  assert.match(R("invoices.routes.js"), /invoiceTable\(shown, \{ isInvoicer: invoicer, ret[,)]/, "invoices: 행(넓은 표)에 목록 주소(ret) 전달");
  assert.match(R("projects.routes.js"), /listQuery/, "projects: 행에 listQuery 전달");
  assert.match(R("contacts.routes.js"), /contactTable\(cap\.shown, \{ returnTo: req\.originalUrl \}\)/, "contacts: 표에 returnTo");
  assert.match(R("clients.routes.js"), /return=\$\{encodeURIComponent\(req\.originalUrl\)\}/, "clients: 행에 return");
  assert.match(R("workers.routes.js"), /\/workers\/\$\{w\.id\}\?return=\$\{encodeURIComponent\(req\.originalUrl\)\}/, "workers: 행에 return");
});
test("상세 탭 링크가 return을 잃지 않는다 — 탭 한 번 누르면 백링크가 기본 목록으로 떨어지던 사각", () => {
  // 목록→상세 진입에 return을 실어도, 상세 안의 탭 링크가 그걸 버리면 탭을 한 번 누른 순간 백링크가 무효화된다
  // (프로젝트에서 실제 발생). 탭바를 가진 상세 화면은 탭 href에 return을 이어 붙여야 한다.
  assert.match(R("projects.routes.js"), /\?tab=\$\{t\.key\}\$\{keepRet\}/, "projects: 탭 링크가 return 보존");
  assert.match(R("clients.routes.js"), /keepQ/, "clients: 탭 링크가 from·return 보존");
});
