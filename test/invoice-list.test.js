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

test("청구 목록 행: 상태 pill 2개(권한자) — 켜짐/꺼짐 + 짧은·긴 라벨 모두 렌더(밀도 CSS 전환)", () => {
  const html = invoiceRow(INV, opts); // tax_status='계산서 발행' → 계산서 켜짐, 입금 꺼짐
  assert.match(html, /data-row-action/, "행 액션 컨테이너(app.js가 펼침 토글을 막고 폼만 제출)");
  assert.match(html, /action="\/invoices\/7\/tax-status"/, "상태 토글 폼");
  assert.match(html, /<span class="inv-narrow-only">계산서<\/span><span class="inv-comfy-only">계산서 발행 완료<\/span>/, "짧은·긴 라벨 둘 다 렌더");
  assert.match(html, /<span class="inv-narrow-only">입금<\/span><span class="inv-comfy-only">입금완료<\/span>/);
  assert.match(html, /bg-success\/10 text-success[^>]*>.*✓.*계산서/s, "발행됨 = 켜짐(불)");
  // 넓게 전용(청구번호·발행일)은 항상 렌더 — CSS로만 숨긴다(전환에 서버 왕복 0)
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
