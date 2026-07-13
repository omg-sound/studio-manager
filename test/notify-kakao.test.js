"use strict";
process.env.NODE_ENV = "test";
const { tempDbPath, cleanupDb } = require("./helpers");
process.env.DB_PATH = tempDbPath();

const test = require("node:test");
const assert = require("node:assert");
const { db, init } = require("../src/db");
init();

const notify = require("../src/notify");
const kakao = require("../src/kakao");

test.after(() => cleanupDb(process.env.DB_PATH, db()));

test("formatKakaoText: 제목·본문·프로젝트 필드 조립", () => {
  const text = notify.formatKakaoText({
    type: "invoice_issued",
    title: "[청구 발행] OMG-202607-003",
    text: "₩1,100,000 · (주)월간윤종신",
    fields: [{ label: "프로젝트", value: "루나 1집" }],
  });
  assert.ok(text.includes("OMG-202607-003"));
  assert.ok(text.includes("(주)월간윤종신"));
  assert.ok(text.includes("루나 1집"));
});

test("notify: invoice_issued는 카카오 호출, 다른 타입은 미호출", async () => {
  kakao.saveTokens({ refreshToken: "RT1", accessToken: "AT", expiresInSec: 3600, nickname: "n" });
  const calls = [];
  const orig = kakao.sendToMe;
  kakao.sendToMe = async (arg) => { calls.push(arg); return { ok: true }; };
  const origFetch = global.fetch;
  global.fetch = async () => ({ ok: true, status: 200, json: async () => ({}) }); // 웹훅 mock(미설정이라 실제론 skip)
  try {
    await notify.notify({ type: "invoice_issued", title: "T", text: "X", url: "https://x/invoices/9", fields: [] });
    assert.equal(calls.length, 1, "invoice_issued → 카카오 1회");
    assert.equal(calls[0].buttonTitle, "청구서 보기");
    await notify.notify({ type: "deliverable_shared", title: "T2", text: "Y" });
    assert.equal(calls.length, 1, "다른 타입은 카카오 미호출");
  } finally {
    kakao.sendToMe = orig;
    global.fetch = origFetch;
  }
});

test("notify: 카카오 send가 throw해도 notify는 정상 반환(fail-safe)", async () => {
  kakao.saveTokens({ refreshToken: "RT1", accessToken: "AT", expiresInSec: 3600 });
  const orig = kakao.sendToMe;
  kakao.sendToMe = async () => { throw new Error("boom"); };
  try {
    const r = await notify.notify({ type: "invoice_issued", title: "T", text: "X", fields: [] });
    assert.ok(r, "throw 없이 반환");
  } finally {
    kakao.sendToMe = orig;
  }
});
