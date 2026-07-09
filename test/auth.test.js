"use strict";

// ── 격리 DB 셋업: src/* require 이전에 환경변수부터 설정 ──
// (canEdit/canInvoice/requireEditor 자체는 DB 미접근이지만, config 프로덕션 가드 회피 +
//  규약 일관성을 위해 동일 패턴 적용. DB 파일은 생성되지 않을 수 있으나 정리는 멱등.)
process.env.NODE_ENV = "test";
const { tempDbPath, cleanupDb } = require("./helpers");
process.env.DB_PATH = tempDbPath();

const test = require("node:test");
const assert = require("node:assert");

const { canEdit, isStaffOrChief, canInvoice, requireEditor, requireStaff, requireInvoice, attachUser, VIEWAS_COOKIE } = require("../src/auth");

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

test("canEdit: 치프·스태프·대표 true / 비로그인 false (2026-07-07 대표 개방)", () => {
  assert.strictEqual(canEdit(CHIEF), true);
  assert.strictEqual(canEdit(STAFF), true);
  assert.strictEqual(canEdit(OWNER), true); // 대표도 편집 전면 개방
  assert.strictEqual(canEdit(null), false);
  assert.strictEqual(canEdit(undefined), false);
  assert.strictEqual(canEdit({ role: "client" }), false);
});

test("isStaffOrChief: 치프·스태프 true / 대표 false (자료 전달·관리 숨김)", () => {
  assert.strictEqual(isStaffOrChief(CHIEF), true);
  assert.strictEqual(isStaffOrChief(STAFF), true);
  assert.strictEqual(isStaffOrChief(OWNER), false);
  assert.strictEqual(isStaffOrChief(null), false);
});

test("canInvoice: 치프·대표 true / 스태프·비로그인 false", () => {
  assert.strictEqual(canInvoice(CHIEF), true);
  assert.strictEqual(canInvoice(OWNER), true);
  assert.strictEqual(canInvoice(STAFF), false); // 스태프는 청구 제외
  assert.strictEqual(canInvoice(null), false);
});

test("requireEditor: 대표(owner)도 통과(2026-07-07 대표 개방)", () => {
  const r = runGate(requireEditor, OWNER, { path: "/projects/1/edit", accepts: () => "html" });
  assert.strictEqual(r.next, true, "owner 도 편집 통과");
  assert.strictEqual(r.status, null);
});

test("requireStaff: 대표(owner)는 403 차단(자료 전달·관리) / 치프·스태프 통과", () => {
  const owner = runGate(requireStaff, OWNER, { path: "/deliverables", accepts: () => "html" });
  assert.strictEqual(owner.next, false, "owner 는 자료 전달·관리 접근 불가");
  assert.strictEqual(owner.status, 403);
  const chief = runGate(requireStaff, CHIEF);
  const staff = runGate(requireStaff, STAFF);
  assert.strictEqual(chief.next, true);
  assert.strictEqual(staff.next, true);
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

// ── 보기 모드(2026-07-09): 치프만 축소 적용, 비치프 쿠키 조작은 무시(권한 상승 차단) ──
test("attachUser 보기 모드: 치프+쿠키(staff) → 역할 축소·real_role 보존 / 스태프+쿠키(owner) → 무시", () => {
  const jwt = require("jsonwebtoken");
  const { config } = require("../src/config");
  const { db, init } = require("../src/db");
  init();
  const chiefId = Number(db().prepare("INSERT INTO users (email, role, name, active) VALUES ('va-chief@t.t','chief','치프',1)").run().lastInsertRowid);
  const staffId = Number(db().prepare("INSERT INTO users (email, role, name, active) VALUES ('va-staff@t.t','staff','스태프',1)").run().lastInsertRowid);
  const tokenFor = (uid) => jwt.sign({ uid }, config.sessionSecret);
  const run = (uid, viewas) => {
    const req = { cookies: { [config.cookieName]: tokenFor(uid), ...(viewas ? { [VIEWAS_COOKIE]: viewas } : {}) } };
    attachUser(req, {}, () => {});
    return req.user;
  };
  const asStaff = run(chiefId, "staff");
  assert.equal(asStaff.role, "staff", "치프의 보기 모드=스태프");
  assert.equal(asStaff.real_role, "chief", "실제 역할 보존");
  const asOwner = run(chiefId, "owner");
  assert.equal(asOwner.role, "owner");
  assert.equal(run(chiefId, "chief").real_role, undefined, "무효 값은 원 역할 그대로");
  const hacked = run(staffId, "owner");
  assert.equal(hacked.role, "staff", "스태프가 쿠키를 조작해도 상승 불가");
  assert.equal(hacked.real_role, undefined);
});

test("requireInvoice: 대표 통과 / 스태프 403 차단", () => {
  const owner = runGate(requireInvoice, OWNER);
  const staff = runGate(requireInvoice, STAFF, { path: "/invoices", accepts: () => "html" });
  assert.strictEqual(owner.next, true);
  assert.strictEqual(staff.next, false);
  assert.strictEqual(staff.status, 403);
});
