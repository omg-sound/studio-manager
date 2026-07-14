"use strict";

// ── 청구 발행 이메일 알림(2026-07-14) ──
// 순수 함수(수신자 파싱·MIME 조립·본문)와 fail-safe 계약을 잠근다. 외부 호출 0(gmail 클라이언트는 스텁).
process.env.NODE_ENV = "test";
process.env.BASE_URL = "https://erp.omgworks.kr";
const { tempDbPath, cleanupDb } = require("./helpers");
process.env.DB_PATH = tempDbPath();

const { test, after } = require("node:test");
const assert = require("node:assert");
const { db, init } = require("../src/db");
init();
after(() => cleanupDb(process.env.DB_PATH, db()));

const mailer = require("../src/mailer");

test("parseRecipients: 콤마·줄바꿈 분리, 소문자, dedup, 형식 불량 제외", () => {
  const got = mailer.parseRecipients(" Owner@OMGWORKS.kr , chief@omgworks.kr\nowner@omgworks.kr; 이상한주소 ,, ");
  assert.deepStrictEqual(got, ["owner@omgworks.kr", "chief@omgworks.kr"]);
  assert.deepStrictEqual(mailer.parseRecipients(""), []);
  assert.deepStrictEqual(mailer.invalidRecipients("a@b.c, 이상한주소"), ["이상한주소"]);
});

test("setRecipients/getRecipients 왕복 + 비우면 알림 끔", () => {
  mailer.setRecipients("owner@omgworks.kr, chief@omgworks.kr");
  assert.deepStrictEqual(mailer.getRecipients(), ["owner@omgworks.kr", "chief@omgworks.kr"]);
  mailer.setRecipients("");
  assert.deepStrictEqual(mailer.getRecipients(), []);
});

test("buildMime: 헤더·한글 제목 RFC2047·UTF-8 base64 본문", () => {
  const mime = mailer.buildMime({
    to: ["owner@omgworks.kr", "chief@omgworks.kr"],
    subject: "[청구 발행] OMG-202607-001 · 아이유",
    html: "<p>청구서가 발행되었습니다</p>",
    from: "studio@omgworks.kr",
  });
  assert.match(mime, /^From: OMG Studios <studio@omgworks\.kr>\r\n/);
  assert.match(mime, /^To: owner@omgworks\.kr, chief@omgworks\.kr$/m, "수신자 콤마 결합");
  assert.match(mime, /^Subject: =\?UTF-8\?B\?[A-Za-z0-9+/=]+\?=$/m, "한글 제목은 RFC2047 base64");
  assert.match(mime, /^Content-Type: text\/html; charset=UTF-8$/m);
  // 제목·본문이 원문으로 복원되는지(왕복)
  const subjB64 = mime.match(/^Subject: =\?UTF-8\?B\?(.+)\?=$/m)[1];
  assert.strictEqual(Buffer.from(subjB64, "base64").toString("utf8"), "[청구 발행] OMG-202607-001 · 아이유");
  const body = mime.split("\r\n\r\n")[1].replace(/\r\n/g, "");
  assert.strictEqual(Buffer.from(body, "base64").toString("utf8"), "<p>청구서가 발행되었습니다</p>");
});

test("encodeSubject: ASCII는 그대로", () => {
  assert.strictEqual(mailer.encodeSubject("OMG-202607-001"), "OMG-202607-001");
});

test("invoiceMail: 제목 + 청구처 정보(홈택스 입력값) + 청구 항목·합계 + 링크", () => {
  const inv = {
    id: 42, invoice_number: "OMG-202607-014", client_name: "(주)모스트콘텐츠",
    project_artist: "아이유", project_title: "모스트콘텐츠 경서", amount: 1430000, tax_amount: 130000,
    payer_snapshot: JSON.stringify({
      kind: "company", name: "(주)모스트콘텐츠", biz_no: "114-87-20378", owner_name: "유진오",
      address: "서울특별시 서초구 방배로 43, 4층", email: "ouenter@hometax.go.kr",
      contacts: [{ name: "신혜원", phone: "010-9366-1086", email: "shw412@mostcontents.com" }],
    }),
  };
  const payer = JSON.parse(inv.payer_snapshot);
  const items = [
    { description: "6월 4일 · 경서 · 보컬녹음", amount: 300000 },
    { description: "슈퍼스타 - 믹싱", amount: 1000000 },
  ];
  const { subject, html } = mailer.invoiceMail(inv, { payer, items });

  assert.strictEqual(subject, "[청구 발행] OMG-202607-014 · 아이유");
  // 청구처 정보(홈택스 공급받는자 입력값)
  assert.match(html, /사업자등록번호[\s\S]*114-87-20378/);
  assert.match(html, /\(주\)모스트콘텐츠/);
  assert.match(html, /성명\(대표자\)[\s\S]*유진오/);
  assert.match(html, /방배로 43/);
  assert.match(html, /ouenter@hometax\.go\.kr/);
  assert.match(html, /신혜원 · 010-9366-1086 · shw412@mostcontents\.com/);
  // 청구 항목 + 합계(소계·VAT·총액)
  assert.match(html, /보컬녹음[\s\S]*₩300,000/);
  assert.match(html, /슈퍼스타 - 믹싱[\s\S]*₩1,000,000/);
  assert.match(html, /소계[\s\S]*₩1,300,000/);
  assert.match(html, /VAT[\s\S]*₩130,000/);
  assert.match(html, /총액[\s\S]*₩1,430,000/);
  assert.match(html, /href="https:\/\/erp\.omgworks\.kr\/invoices\/42"/, "링크는 BASE_URL 기준");
});

test("invoiceMail: 할인 청구서의 소계는 라인 합(할인 전) — 화면과 같은 산술(소계−할인+VAT=총액)", () => {
  // 회귀: 소계를 amount−tax(=이미 할인 빠진 과세표준)로 계산해 할인이 두 번 빠져 보이던 것.
  // 라인 100만 · 할인 10만 → 과세표준 90만 · VAT 9만 · 총액 99만.
  const inv = { id: 3, invoice_number: "OMG-D", client_name: "회사", amount: 990000, tax_amount: 90000, discount_amount: 100000 };
  const { html } = mailer.invoiceMail(inv, { items: [{ description: "믹싱", amount: 1000000 }] });
  assert.match(html, /소계[\s\S]*₩1,000,000/, "소계 = 라인 합(할인 전)");
  assert.match(html, /할인[\s\S]*-₩100,000/);
  assert.match(html, /VAT[\s\S]*₩90,000/);
  assert.match(html, /총액[\s\S]*₩990,000/);
});

test("invoiceMail: 라인 없는 레거시 청구서는 할인 행 없이 과세표준을 소계로(이중 차감 방지)", () => {
  const inv = { id: 4, invoice_number: "OMG-L", client_name: "회사", amount: 990000, tax_amount: 90000, discount_amount: 100000 };
  const { html } = mailer.invoiceMail(inv, { items: [] });
  assert.match(html, /소계[\s\S]*₩900,000/);
  assert.doesNotMatch(html, /할인/);
});

test("buildMime: 헤더 CRLF 주입 차단(제목이 ASCII라 인코딩을 안 타도)", () => {
  const raw = mailer.buildMime({
    to: ["a@b.c"],
    subject: "INV-1\r\nBcc: attacker@evil.com",
    html: "<p>x</p>",
  });
  assert.doesNotMatch(raw, /^Bcc:/im, "새 헤더 줄(Bcc)이 생기면 안 됨");
  assert.match(raw, /Subject: INV-1 Bcc: attacker@evil\.com/, "CRLF는 공백으로 무해화 — 제목 한 줄 안에 남음");
});

test("invoiceMail: 개인 청구처는 현금영수증·성명(대표자 행 없음), 아티스트 없으면 제목은 청구처", () => {
  const payer = { kind: "person", name: "박수한", cash_receipt_no: "010-1234-5678" };
  const { subject, html } = mailer.invoiceMail(
    { id: 7, invoice_number: "OMG-1", client_name: "박수한", amount: 110000, tax_amount: 10000 },
    { payer, items: [{ description: "믹싱", amount: 100000 }] }
  );
  assert.strictEqual(subject, "[청구 발행] OMG-1 · 박수한");
  assert.match(html, /현금영수증[\s\S]*010-1234-5678/);
  assert.doesNotMatch(html, /사업자등록번호/);
  assert.doesNotMatch(html, /성명\(대표자\)/);
});

test("invoiceMail: HTML 이스케이프(청구처·프로젝트명에 태그가 있어도 주입 안 됨)", () => {
  const { html } = mailer.invoiceMail({ id: 1, invoice_number: "X", client_name: '<script>alert(1)</script>', amount: 0 });
  assert.doesNotMatch(html, /<script>/);
  assert.match(html, /&lt;script&gt;/);
});

test("send: 미연동·수신자 0명은 조용히 skip(throw 없음)", async () => {
  mailer.setRecipients("");
  const r1 = await mailer.send({ subject: "s", html: "h" });
  assert.strictEqual(r1.ok, false);
  assert.ok(r1.skipped === "not_linked" || r1.skipped === "no_recipients", "skip 사유 반환");
});

test("send: gmail API가 throw해도 mailer는 throw하지 않는다(fail-safe)", async () => {
  mailer.setRecipients("owner@omgworks.kr");
  const failing = { users: { messages: { send: async () => { throw new Error("insufficient authentication scopes"); } } } };
  try {
    const r = await mailer.send({ subject: "s", html: "h", client: failing });
    assert.strictEqual(r.ok, false, "실패를 반환하되 throw는 안 함");
    assert.match(r.error, /insufficient/);
  } finally {
    mailer.setRecipients("");
  }
});

test("send: 정상 발송이면 수신자 수 반환 + raw는 base64url(MIME)", async () => {
  mailer.setRecipients("owner@omgworks.kr, chief@omgworks.kr");
  let captured = null;
  const ok = { users: { messages: { send: async (req) => { captured = req; return { data: { id: "x" } }; } } } };
  try {
    const r = await mailer.send({ subject: "제목", html: "<p>본문</p>", client: ok });
    assert.deepStrictEqual(r, { ok: true, sent: 2 });
    assert.strictEqual(captured.userId, "me");
    const mime = Buffer.from(captured.requestBody.raw, "base64url").toString("utf8");
    assert.match(mime, /^To: owner@omgworks\.kr, chief@omgworks\.kr$/m);
  } finally {
    mailer.setRecipients("");
  }
});

test("maskEmail: 로그에 수신 주소 전량 노출 금지", () => {
  assert.strictEqual(mailer.maskEmail("owner@omgworks.kr"), "ow***@omgworks.kr");
});
