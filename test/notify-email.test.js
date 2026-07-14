"use strict";

// ── notify → 이메일 채널 라우팅(2026-07-14) ──
// ①invoice_issued만 이메일로 ②이메일이 throw해도 notify는 흡수(fail-safe·청구 생성 비차단)
// ③웹훅과 **독립**(웹훅 미설정·SSRF 차단이어도 이메일은 나간다 — 카카오 때 최종 리뷰가 잡았던 결함 클래스).
process.env.NODE_ENV = "test";
const { tempDbPath, cleanupDb } = require("./helpers");
process.env.DB_PATH = tempDbPath();

const { test, after } = require("node:test");
const assert = require("node:assert");
const { db, init } = require("../src/db");
init();
after(() => cleanupDb(process.env.DB_PATH, db()));

const mailer = require("../src/mailer");
const notify = require("../src/notify");

/** mailer.sendInvoiceIssued를 가로채 호출 기록만 남긴다(외부 호출 0). */
function stubMailer(impl) {
  const orig = mailer.sendInvoiceIssued;
  mailer.sendInvoiceIssued = impl;
  return () => { mailer.sendInvoiceIssued = orig; };
}

test("invoice_issued만 이메일로 라우팅(다른 이벤트는 웹훅 전용)", async () => {
  const calls = [];
  const restore = stubMailer(async (inv) => { calls.push(inv); return { ok: true, sent: 1 }; });
  try {
    await notify.notify({ type: "invoice_issued", title: "[청구 발행] OMG-1", invoice: { id: 1, invoice_number: "OMG-1", amount: 100 } });
    await notify.notify({ type: "deliverable_shared", title: "[자료 공유] x" });
    await notify.notify({ type: "overdue", title: "[연체] x" });
    assert.strictEqual(calls.length, 1, "invoice_issued 1건만");
    assert.strictEqual(calls[0].invoice_number, "OMG-1");
  } finally { restore(); }
});

test("이메일 발송이 throw해도 notify는 흡수한다(청구 생성 비차단)", async () => {
  const restore = stubMailer(async () => { throw new Error("gmail down"); });
  try {
    const r = await notify.notify({ type: "invoice_issued", title: "t", invoice: { id: 1 } });
    assert.ok(r && typeof r === "object", "throw 없이 결과 반환");
  } finally { restore(); }
});

test("웹훅과 독립: 웹훅 미설정(skip)이어도 이메일은 발송된다", async () => {
  notify.setWebhookUrl(""); // 웹훅 끔
  let sent = 0;
  const restore = stubMailer(async () => { sent++; return { ok: true, sent: 1 }; });
  try {
    const r = await notify.notify({ type: "invoice_issued", title: "t", invoice: { id: 9 } });
    assert.strictEqual(r.skipped, "not_configured", "웹훅은 미설정 skip");
    assert.strictEqual(sent, 1, "그래도 이메일은 나감");
  } finally { restore(); }
});

test("웹훅과 독립: SSRF 차단(사설 IP 웹훅)이어도 이메일은 발송된다", async () => {
  notify.setWebhookUrl("http://127.0.0.1/hook");
  let sent = 0;
  const restore = stubMailer(async () => { sent++; return { ok: true, sent: 1 }; });
  try {
    const r = await notify.notify({ type: "invoice_issued", title: "t", invoice: { id: 9 } });
    assert.strictEqual(r.skipped, "ssrf_blocked");
    assert.strictEqual(sent, 1, "그래도 이메일은 나감");
  } finally {
    restore();
    notify.setWebhookUrl("");
  }
});

test("notifyInvoiceIssued가 인보이스 원본을 이벤트에 실어 보낸다(메일 본문 조립용)", async () => {
  const seen = [];
  const restore = stubMailer(async (inv) => { seen.push(inv); return { ok: true }; });
  try {
    notify.notifyInvoiceIssued({ id: 5, invoice_number: "OMG-5", amount: 330000, client_name: "(주)이담", project_title: "P" });
    await notify.drainNotifications(2000); // fire-and-forget 완료 대기
    assert.strictEqual(seen.length, 1);
    assert.strictEqual(seen[0].id, 5);
    assert.strictEqual(seen[0].client_name, "(주)이담");
  } finally { restore(); }
});
