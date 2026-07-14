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

test("invoiceMail: 제목·본문·바로가기 링크(BASE_URL 기준)", () => {
  const inv = {
    id: 42, invoice_number: "OMG-202607-001", client_name: "(주)이담",
    project_artist: "아이유", project_title: "루나 1집", amount: 1320000,
  };
  const { subject, html } = mailer.invoiceMail(inv);
  assert.strictEqual(subject, "[청구 발행] OMG-202607-001 · 아이유");
  assert.match(html, /OMG-202607-001/);
  assert.match(html, /\(주\)이담/);
  assert.match(html, /아이유/);
  assert.match(html, /루나 1집/);
  assert.match(html, /₩1,320,000/);
  assert.match(html, /href="https:\/\/erp\.omgworks\.kr\/invoices\/42"/, "링크는 BASE_URL 기준");

  // 아티스트 없으면 제목은 청구처로 폴백, 아티스트 행은 생략
  const noArtist = mailer.invoiceMail({ id: 7, invoice_number: "OMG-1", client_name: "(주)이담", amount: 0 });
  assert.strictEqual(noArtist.subject, "[청구 발행] OMG-1 · (주)이담");
  assert.doesNotMatch(noArtist.html, /아티스트/);
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
