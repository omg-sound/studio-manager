"use strict";

// ── 청구 목록 지메일식 한 줄 행(2026-07-15 사용자 요청) ──
// 좌측 = 청구처 · (제작사 · 아티스트) / 우측 = 금액 + 상태 pill 2개. 행=펼침 / 청구처(제목)=상세.
// 순수 렌더 계약만 검사(DB 불필요) — 밀도는 CSS 전환이라 넓게 전용 요소가 **항상 렌더**돼야 한다.
process.env.NODE_ENV = "test";
const { tempDbPath, cleanupDb } = require("./helpers");
process.env.DB_PATH = tempDbPath();

const test = require("node:test");
const assert = require("node:assert");
const { db, init } = require("../src/db");
init();
test.after(() => cleanupDb(process.env.DB_PATH, db()));

const { invoiceRow } = require("../src/views.invoices");

const INV = {
  id: 7,
  title: "도너츠컬처 진혁 청구",
  invoice_number: "OMG-202607-014",
  issued_date: "2026-07-14",
  amount: 220000,
  paid_amount: 0,
  status: "발행",
  tax_status: "계산서 발행",
  client_name: "(주)도너츠컬처",
  payer_kind: "company",
  project_title: "도너츠컬처 진혁",
  project_production: "도너츠컬처",
  project_artist: "진혁",
};
const opts = { isInvoicer: true, ret: "/invoices?tab=done" };

test("청구 목록 행: 청구처가 첫 열, 부제는 '제작사 · 아티스트'", () => {
  const html = invoiceRow(INV, opts);
  assert.match(html, /class="inv-payer">\(주\)도너츠컬처</, "청구처 = 첫 열");
  assert.match(html, /class="inv-sub">도너츠컬처 · 진혁</, "부제 = 제작사 · 아티스트");
  assert.match(html, /class="inv-amount tabular">₩220,000/, "금액");
  assert.match(html, /<details id="inv-7" class="inv-row/, "행 = details(펼침)");
  assert.match(html, /<a href="\/invoices\/7\?return=[^"]*" class="inv-main"/, "청구처(제목)만 상세 링크");
});

test("청구 목록 행: 제작사가 청구처와 같으면 부제에서 생략(같은 이름 두 번 방지)", () => {
  const html = invoiceRow({ ...INV, client_name: "도너츠컬처", project_production: "도너츠컬처" }, opts);
  assert.match(html, /class="inv-sub">진혁</, "제작사 조각 생략, 아티스트만");
});

test("청구 목록 행: 아티스트 여러 명은 '외 N', 프로젝트 없으면 부제 비움", () => {
  const many = invoiceRow({ ...INV, project_artist: "아이유, 태연, 진혁" }, opts);
  assert.match(many, /class="inv-sub">도너츠컬처 · 아이유 외 2</);
  const manual = invoiceRow({ ...INV, project_title: null, project_production: null, project_artist: null }, opts);
  assert.match(manual, /class="inv-sub"><\/span>/, "프로젝트 없는 청구서는 부제 없음");
  assert.match(manual, /class="inv-payer">\(주\)도너츠컬처</, "청구처는 그대로");
});

test("청구 목록 행: 상태 버튼 — 좁게=아이콘(툴팁), 넓게=라벨. 두 표현 모두 렌더(CSS 전환)", () => {
  const html = invoiceRow(INV, opts); // tax_status='계산서 발행' → 계산서 켜짐, 입금 꺼짐
  assert.match(html, /data-row-action/, "행 액션 컨테이너(app.js가 펼침 토글을 막고 폼만 제출)");
  assert.match(html, /action="\/invoices\/7\/tax-status"/, "상태 토글 폼");
  // 좁게 = 아이콘만(라벨 없음) — 폭이 고정돼 금액 열이 안 밀린다
  assert.match(html, /<span class="inv-icon inv-narrow-only"><svg/, "아이콘(좁게 전용)");
  // 무엇인지는 툴팁·스크린리더 라벨로 (아이콘만 보여도 의미 전달)
  assert.match(html, /title="계산서 발행 완료 \(누르면 되돌리기\)" aria-label="계산서 발행 완료 \(누르면 되돌리기\)"/, "켜진 계산서 툴팁");
  assert.match(html, /title="입금완료로 표시" aria-label="입금완료로 표시"/, "꺼진 입금 툴팁");
  // 넓게 = 글리프 + 긴 라벨(항상 렌더, CSS로만 표시 전환)
  assert.match(html, /<span class="inv-comfy-only">.*✓.*계산서 발행 완료<\/span>/s, "넓게 라벨(켜짐 ✓)");
  assert.match(html, /<span class="inv-comfy-only">.*−.*입금완료<\/span>/s, "넓게 라벨(꺼짐 −)");
  assert.match(html, /bg-success\/10 text-success/, "발행됨 = 켜짐(불)");
  assert.match(html, /class="inv-doc inv-comfy-only">OMG-202607-014 · 2026-07-14/);
});

test("청구 목록 행: 권한 없으면(스태프) 상태 pill 대신 배지만", () => {
  const html = invoiceRow(INV, { ...opts, isInvoicer: false });
  assert.doesNotMatch(html, /data-row-action/, "처리 버튼 없음");
  assert.doesNotMatch(html, /tax-status/, "상태 변경 폼 없음");
  assert.match(html, /badge/, "상태 배지는 보임");
});

test("청구 목록 행: ?open=<id>면 그 행만 펼친 채 렌더", () => {
  const open = invoiceRow(INV, { ...opts, openId: 7 });
  assert.match(open, /<details id="inv-7"[^>]* open>/);
  const closed = invoiceRow(INV, { ...opts, openId: 99 });
  assert.doesNotMatch(closed, /<details id="inv-7"[^>]* open>/);
});

// ── 청구처 정보 카드: 값 열 정렬(2026-07-15 사용자 리포트 '담당자 황예지만 밖으로 삐져나옴') ──
// 다른 값은 모두 copyable(클릭 복사)이라 hover 아이콘(⧉) 자리를 오른쪽에 상시 확보하는데, 담당자 이름만
// 순수 텍스트라 그 여백이 없어 텍스트가 한 칸 더 오른쪽으로 나와 보였다 → 담당자 이름도 copyable로 통일.
test("청구처 정보 카드: 담당자 이름도 클릭 복사(값 열 오른쪽 끝 정렬 일치)", () => {
  const { payerInfoCard } = require("../src/views.invoices");
  const html = payerInfoCard(
    { id: 1, kind: "company", name: "(주)도너츠컬처", biz_no: "261-81-02922", owner_name: "고영조", address: "서울", email: "a@b.c" },
    [{ name: "황예지", phone: "010-1111-2222" }]
  );
  assert.match(html, /담당자<\/span><span class="text-right text-sm font-medium"><button type="button" data-copy="황예지"/, "담당자 이름 = copyable");
  assert.doesNotMatch(html, /<span class="font-medium">황예지<\/span>/, "순수 텍스트(정렬 어긋남)로 렌더되면 안 됨");
});

// ── invoiceItemsByInvoiceIds: 목록 페이지 N+1 제거(행마다 2쿼리 → 표시분 전체 1쿼리) ──
test("invoiceItemsByInvoiceIds: 여러 청구서 항목을 한 번에, 청구서별 그룹·날짜순", () => {
  const { invoiceItemsByInvoiceIds } = require("../src/data");
  const d = db();
  const i1 = d.prepare("INSERT INTO invoices (title, amount, status) VALUES ('A', 100, '발행')").run().lastInsertRowid;
  const i2 = d.prepare("INSERT INTO invoices (title, amount, status) VALUES ('B', 200, '발행')").run().lastInsertRowid;
  const ins = d.prepare("INSERT INTO invoice_items (invoice_id, description, quantity, unit_price, amount, item_date) VALUES (?,?,1,?,?,?)");
  ins.run(i1, "나중", 70, 70, "2026-08-01");
  ins.run(i1, "먼저", 30, 30, "2026-07-01");
  ins.run(i2, "단독", 200, 200, null);
  const by = invoiceItemsByInvoiceIds([i1, i2, 99999]);
  assert.equal(by[i1].length, 2);
  assert.equal(by[i1][0].description, "먼저", "청구서 안에서 날짜순");
  assert.equal(by[i2].length, 1);
  assert.equal(by[99999], undefined, "없는 id는 키 없음");
  assert.deepEqual(invoiceItemsByInvoiceIds([]), {}, "빈 입력 안전");
});

// ── 청구 목록 복귀 경로: '더 보기'(limit) 상태 보존 — 프로젝트 목록과 동일 클래스(2026-07-15 점검) ──
test("청구 목록 라우트: 행 복귀 경로(ret)에 limit 보존(소스 계약)", () => {
  const fs = require("fs");
  const src = fs.readFileSync(require("path").join(__dirname, "..", "src", "routes", "invoices.routes.js"), "utf8");
  assert.match(src, /ret: retPath \+ limitQ/, "행 ret = retPath + limitQ(더 보기 상태 유지)");
  assert.match(src, /invoiceItemsByInvoiceIds\(cap\.shown/, "항목은 배치 1쿼리");
});

test("청구 목록 행: 개인 청구처의 병기 이름과 같은 아티스트는 부제에서 생략(같은 사람 두 번 방지)", () => {
  // 아티스트=활동명, 프로젝트명=본명 — 둘 다 청구처 병기("본명 (활동명)")의 조각이라 부제가 완전히 비어야 한다
  const html = invoiceRow({ ...INV, client_name: "조형우 (형우비트)", payer_kind: "person", project_title: "조형우", project_production: null, project_artist: "형우비트" }, opts);
  assert.match(html, /class="inv-payer">조형우 \(형우비트\)</);
  assert.match(html, /class="inv-sub"><\/span>/, "같은 사람(활동명·본명)은 부제 생략");
  // 프로젝트명이 별개 텍스트면 부제로 보여준다(중복 아님 — 정당한 맥락)
  const withTitle = invoiceRow({ ...INV, client_name: "조형우 (형우비트)", payer_kind: "person", project_production: null, project_artist: "형우비트" }, opts);
  assert.match(withTitle, /class="inv-sub">도너츠컬처 진혁</, "남는 프로젝트명은 폴백 표시");
  // 회사 상호의 (주) 접두는 분해하지 않는다 — "(주)도너츠컬처" 청구처가 제작사 "도너츠컬처"를 억제하면 안 됨
  const co = invoiceRow(INV, opts);
  assert.match(co, /class="inv-sub">도너츠컬처 · 진혁</);
});
