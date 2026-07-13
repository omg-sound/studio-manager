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

test("formatKakaoText: 설계 §5 형식 — 🧾 2줄 헤더 + 본문·프로젝트 필드", () => {
  const text = notify.formatKakaoText({
    type: "invoice_issued",
    title: "[청구 발행] OMG-202607-003",
    text: "₩1,100,000 · (주)월간윤종신",
    fields: [{ label: "프로젝트", value: "루나 1집" }],
  });
  const lines = text.split("\n");
  assert.equal(lines[0], "🧾 청구 발행", "1줄=이모지+분류(설계 §5·테스트 발송 문구와 모양 일치)");
  assert.equal(lines[1], "OMG-202607-003", "2줄=청구번호");
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

// 카카오는 웹훅과 독립 — 웹훅 분기(ssrf 차단·throw 등) 결과와 무관하게 invoice_issued는 카카오로 발송돼야 한다.
// (최종 브랜치 리뷰 Important: dispatchKakao가 웹훅 제어 흐름에 묶여 ssrf_blocked/catch 분기에서 카카오가 누락되던 것.)
test("notify: 웹훅이 사설 IP(ssrf 차단)여도 invoice_issued는 카카오로 발송(웹훅과 독립)", async () => {
  kakao.saveTokens({ refreshToken: "RT1", accessToken: "AT", expiresInSec: 3600, nickname: "n" });
  notify.setWebhookUrl("http://127.0.0.1:9/hook"); // 사설 IP → isSsrfSafe=false → ssrf_blocked 분기
  const calls = [];
  const orig = kakao.sendToMe;
  kakao.sendToMe = async (arg) => { calls.push(arg); return { ok: true }; };
  try {
    const r = await notify.notify({ type: "invoice_issued", title: "T", text: "X", url: "https://x/invoices/7", fields: [] });
    assert.equal(r.skipped, "ssrf_blocked", "웹훅은 ssrf로 차단됨(분기 확인)");
    assert.equal(calls.length, 1, "그래도 카카오는 발송됨(웹훅 분기와 독립)");
  } finally {
    kakao.sendToMe = orig;
    notify.setWebhookUrl("");
  }
});

// SIGTERM 드레인(2026-07-13 점검): fire-and-forget 전송이 재시작 순간 죽어 알림이 무음 유실되던 것 —
// notifyAsync가 in-flight로 추적되고 drainNotifications가 완료를 기다리는지 잠금.
test("drainNotifications: notifyAsync 진행 중 전송을 기다린 뒤 반환", async () => {
  kakao.saveTokens({ refreshToken: "RT1", accessToken: "AT", expiresInSec: 3600 });
  let finished = false;
  const orig = kakao.sendToMe;
  kakao.sendToMe = async () => { await new Promise((r) => setTimeout(r, 40)); finished = true; return { ok: true }; };
  try {
    notify.notifyAsync({ type: "invoice_issued", title: "T", text: "X", fields: [] });
    assert.equal(finished, false, "발사 직후엔 미완료(비차단)");
    const r = await notify.drainNotifications(2000);
    assert.ok(r.drained >= 1, "진행 중 1건 이상 대기");
    assert.equal(finished, true, "드레인 후 전송 완료 보장");
  } finally {
    kakao.sendToMe = orig;
  }
});
