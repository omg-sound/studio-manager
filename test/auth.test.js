"use strict";

// ── 격리 DB 셋업: src/* require 이전에 환경변수부터 설정 ──
// (canEdit/canInvoice/requireEditor 자체는 DB 미접근이지만, config 프로덕션 가드 회피 +
//  규약 일관성을 위해 동일 패턴 적용. DB 파일은 생성되지 않을 수 있으나 정리는 멱등.)
process.env.NODE_ENV = "test";
const { tempDbPath, cleanupDb } = require("./helpers");
process.env.DB_PATH = tempDbPath();

const test = require("node:test");
const assert = require("node:assert");

const { canEdit, canInvoice, requireEditor, requireInvoice } = require("../src/auth");

const OWNER = { role: "owner" };
const CHIEF = { role: "chief" };
const STAFF = { role: "staff" };

/** 미들웨어를 가벼운 req/res/next 목으로 1회 실행하고 결과 기록. */
function runGate(mw, user, { path = "/projects", accepts = () => false } = {}) {
  const out = { status: null, body: null, redirect: null, next: false };
  const res = {
    status(c) {
      out.status = c;
      return this;
    },
    json(o) {
      out.body = o;
      return this;
    },
    send(s) {
      out.body = s;
      return this;
    },
    redirect(u) {
      out.redirect = u;
      return this;
    },
  };
  mw({ user, path, accepts }, res, () => {
    out.next = true;
  });
  return out;
}

test.after(() => cleanupDb(process.env.DB_PATH));

test("canEdit: 치프·스태프 true / 대표·비로그인 false", () => {
  assert.strictEqual(canEdit(CHIEF), true);
  assert.strictEqual(canEdit(STAFF), true);
  assert.strictEqual(canEdit(OWNER), false); // 대표는 열람만
  assert.strictEqual(canEdit(null), false);
  assert.strictEqual(canEdit(undefined), false);
  assert.strictEqual(canEdit({ role: "client" }), false);
});

test("canInvoice: 치프·대표 true / 스태프·비로그인 false", () => {
  assert.strictEqual(canInvoice(CHIEF), true);
  assert.strictEqual(canInvoice(OWNER), true);
  assert.strictEqual(canInvoice(STAFF), false); // 스태프는 청구 제외
  assert.strictEqual(canInvoice(null), false);
});

test("requireEditor: 대표(owner)는 403 차단(next 미호출)", () => {
  const r = runGate(requireEditor, OWNER, { path: "/projects/1/edit", accepts: () => "html" });
  assert.strictEqual(r.next, false, "owner 는 통과하면 안 된다");
  assert.strictEqual(r.status, 403);
});

test("requireEditor: 치프·스태프는 통과(next 호출)", () => {
  const chief = runGate(requireEditor, CHIEF);
  const staff = runGate(requireEditor, STAFF);
  assert.strictEqual(chief.next, true);
  assert.strictEqual(chief.status, null);
  assert.strictEqual(staff.next, true);
});

test("requireEditor: 비로그인은 401(API 경로)", () => {
  const r = runGate(requireEditor, null, { path: "/api/projects", accepts: () => false });
  assert.strictEqual(r.next, false);
  assert.strictEqual(r.status, 401);
});

test("requireInvoice: 대표 통과 / 스태프 403 차단", () => {
  const owner = runGate(requireInvoice, OWNER);
  const staff = runGate(requireInvoice, STAFF, { path: "/invoices", accepts: () => "html" });
  assert.strictEqual(owner.next, true);
  assert.strictEqual(staff.next, false);
  assert.strictEqual(staff.status, 403);
});
