"use strict";
// 2026-07-20 사용자 요청: "감사로그에 로그인 기록도 볼 수 있게 — 브라우저 켜서 ERP를 열 때".
// 핵심 제약: 로그인 쿠키가 30일이라 '브라우저를 켜서 여는 것'은 로그인 이벤트가 아니다 →
// 접속(auth.access)을 사람당 하루 1건으로 접어 기록한다. 거부(auth.deny)는 지금까지 아무 데도 안 남았다.
process.env.DB_PATH = require("path").join(require("os").tmpdir(), `omg-audit-auth-${process.pid}.db`);
process.env.SESSION_SECRET = "test-secret-audit-auth";
process.env.TOKEN_ENC_KEY = "test-enc-key-audit-auth";

const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const { init, db } = require("../src/db");
init();

const { logAudit, listAudit, logAccessDaily, roleLabel } = require("../src/lib/audit");
const { deviceLabel } = require("../src/lib/user-agent");

test.after(() => {
  for (const s of ["", "-wal", "-shm"]) { try { fs.unlinkSync(process.env.DB_PATH + s); } catch (_e) { /* 없으면 그만 */ } }
});

const clear = () => db().prepare("DELETE FROM audit_log").run();
const rows = (kind) => listAudit(50, kind);

// ── 기기 이름 ──────────────────────────────────────────────
// IP를 남기지 않기로 했으므로 기기가 '내가 아닌 접속'을 가려낼 유일한 단서다.
test("deviceLabel: 실제 UA에서 브라우저/OS를 뽑는다", () => {
  const cases = [
    ["Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36", "크롬/맥"],
    ["Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1", "사파리/아이폰"],
    ["Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36 Edg/126.0", "엣지/윈도우"],
    ["Mozilla/5.0 (Linux; Android 14; SM-S918N) AppleWebKit/537.36 (KHTML, like Gecko) SamsungBrowser/25.0 Chrome/121.0 Mobile Safari/537.36", "삼성브라우저/안드로이드"],
  ];
  cases.forEach(([ua, want]) => assert.equal(deviceLabel(ua), want, ua.slice(0, 40)));
});

test("deviceLabel: 넓은 쪽을 먼저 매칭하면 전부 크롬/사파리로 뭉개진다 — 좁은 것부터 본다", () => {
  // 엣지 UA엔 Chrome과 Safari가 둘 다 들어 있고, 크롬 UA엔 Safari가 들어 있다.
  const edge = "Mozilla/5.0 (Macintosh) AppleWebKit/537.36 Chrome/126.0 Safari/537.36 Edg/126.0";
  assert.equal(deviceLabel(edge), "엣지/맥", "엣지가 크롬으로 잡히면 안 된다");
  const chrome = "Mozilla/5.0 (Macintosh) AppleWebKit/537.36 Chrome/126.0 Safari/537.36";
  assert.equal(deviceLabel(chrome), "크롬/맥", "크롬이 사파리로 잡히면 안 된다");
  // iPad는 iPadOS 13+부터 UA에 Macintosh를 쓴다 — 맥보다 먼저 봐야 한다.
  const ipad = "Mozilla/5.0 (iPad; CPU OS 17_5 like Mac OS X) AppleWebKit/605.1.15 Version/17.5 Safari/604.1";
  assert.equal(deviceLabel(ipad), "사파리/아이패드");
});

test("deviceLabel: 모르는/빈 UA는 빈 문자열(호출부가 그 조각만 생략할 수 있게)", () => {
  assert.equal(deviceLabel(""), "");
  assert.equal(deviceLabel(null), "");
  assert.equal(deviceLabel("curl/8.4.0"), "");
});

// ── 접속 기록: 사람당 하루 1건 ──────────────────────────────
test("logAccessDaily: 같은 사람이 하루에 여러 번 열어도 1건만 남는다", () => {
  clear();
  const u = { email: "staff@omgworks.kr", role: "staff" };
  for (let i = 0; i < 20; i += 1) logAccessDaily(u, "크롬/맥");
  const got = rows("auth");
  assert.equal(got.length, 1, "20번 요청해도 1건");
  assert.equal(got[0].action, "auth.access");
  assert.match(got[0].target, /스태프 · 크롬\/맥/, "역할 · 기기");
});

test("logAccessDaily: 사람이 다르면 각각 남는다", () => {
  clear();
  logAccessDaily({ email: "a@omgworks.kr", role: "chief" }, "크롬/맥");
  logAccessDaily({ email: "b@omgworks.kr", role: "owner" }, "사파리/아이폰");
  assert.equal(rows("auth").length, 2);
});

test("logAccessDaily: 재시작(메모리 캐시 소실) 후에도 그날 중복 기록 안 함", () => {
  // 캐시만 믿으면 배포·재시작마다 그날 첫 줄이 다시 찍힌다 → DB 확인이 2단 방어.
  clear();
  logAccessDaily({ email: "restart@omgworks.kr", role: "chief" }, "크롬/맥");
  delete require.cache[require.resolve("../src/lib/audit")]; // 새 프로세스처럼 모듈(=캐시) 재적재
  const fresh = require("../src/lib/audit");
  fresh.logAccessDaily({ email: "restart@omgworks.kr", role: "chief" }, "크롬/맥");
  assert.equal(rows("auth").length, 1, "DB에 오늘 기록이 있으면 다시 안 쓴다");
});

test("logAccessDaily: 사용자가 없거나 이메일이 없으면 아무것도 안 남는다", () => {
  clear();
  logAccessDaily(null, "크롬/맥");
  logAccessDaily({ role: "chief" }, "크롬/맥");
  assert.equal(rows("auth").length, 0);
});

test("logAccessDaily: 기기를 모르면 역할만 남는다(빈 구분자 · 안 붙음)", () => {
  clear();
  logAccessDaily({ email: "nodev@omgworks.kr", role: "owner" }, "");
  assert.equal(rows("auth")[0].target, "대표");
});

// ── '하루'의 경계 = KST 자정 ────────────────────────────────
// 2026-07-20 리뷰 지적: UTC 자정은 한국 오전 9시라 근무일 한가운데를 지난다.
test("kstDay: 경계가 KST 자정이다 — 한국 오전 9시(UTC 자정)에 날이 바뀌지 않는다", () => {
  const { kstDay } = require("../src/lib/audit");
  // 2026-07-20 08:30 KST = 2026-07-19 23:30 UTC (UTC 기준이면 '어제'로 갈리던 시각)
  const morning = Date.parse("2026-07-19T23:30:00Z");
  // 2026-07-20 09:30 KST = 2026-07-20 00:30 UTC (UTC 자정을 막 넘긴 시각)
  const afterNine = Date.parse("2026-07-20T00:30:00Z");
  assert.equal(kstDay(morning).day, "2026-07-20", "8시 반 출근도 그날로 친다");
  assert.equal(kstDay(afterNine).day, "2026-07-20", "9시를 넘겨도 같은 날 — 두 줄로 갈리지 않는다");
  assert.equal(kstDay(morning).day, kstDay(afterNine).day, "출근 시간에 따라 규칙이 달라지면 안 된다");
});

test("kstDay: dup 비교 하한은 그 KST 자정의 UTC 시각(at 컬럼과 같은 형식)", () => {
  const { kstDay } = require("../src/lib/audit");
  const { day, sinceUtc } = kstDay(Date.parse("2026-07-20T00:30:00Z"));
  assert.equal(day, "2026-07-20");
  assert.equal(sinceUtc, "2026-07-19 15:00:00", "KST 자정 = 전날 15:00 UTC");
  assert.match(sinceUtc, /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/, "at 컬럼과 같은 형식이라야 문자열 비교가 성립");
});

test("logAccessDaily: 기록에 실패하면 캐시를 세우지 않아 회복 후 다시 시도한다", () => {
  // 캐시를 INSERT 앞에 세우면, 디스크 풀 등으로 조용히 실패했을 때 그 사람의 그날 접속이 영영 안 남는다.
  clear();
  const u = { email: "retry@omgworks.kr", role: "chief" };
  const real = db().prepare.bind(db());
  db().prepare = (sql) => { if (/INSERT INTO audit_log/.test(sql)) throw new Error("디스크 풀"); return real(sql); };
  try { logAccessDaily(u, "크롬/맥"); } finally { db().prepare = real; }
  assert.equal(rows("auth").length, 0, "실패했으니 아직 없다");
  logAccessDaily(u, "크롬/맥"); // DB 회복 후 같은 날 재시도
  assert.equal(rows("auth").length, 1, "회복되면 그날 접속이 남는다");
});

// ── 목록 분리 ─────────────────────────────────────────────
// 화면이 최근 50건 고정이라, 안 나누면 접속 기록이 삭제·청구 기록을 창 밖으로 밀어낸다.
test("listAudit: 기본은 변경 이력(auth.* 제외), 'auth'는 인증만, 'all'은 전부", () => {
  clear();
  logAudit({ email: "chief@omgworks.kr" }, "invoice.delete", "OMG-202607-001");
  logAudit({ email: "chief@omgworks.kr" }, "project.delete", "루나 1집");
  logAccessDaily({ email: "chief@omgworks.kr", role: "chief" }, "크롬/맥");
  logAudit({ email: "nobody@gmail.com" }, "auth.deny", "미등록 계정 · 크롬/윈도우");

  const work = rows("work").map((r) => r.action);
  assert.deepEqual(work, ["project.delete", "invoice.delete"], "인증 기록이 변경 이력을 밀어내지 않는다");
  assert.deepEqual(rows(undefined).map((r) => r.action), work, "인자 없으면 변경 이력이 기본");
  assert.deepEqual(rows("auth").map((r) => r.action), ["auth.deny", "auth.access"]);
  assert.equal(rows("all").length, 4);
});

test("roleLabel: 화면 용어와 같은 한글 이름", () => {
  assert.equal(roleLabel("chief"), "치프");
  assert.equal(roleLabel("owner"), "대표");
  assert.equal(roleLabel("staff"), "스태프");
  assert.equal(roleLabel(""), "", "모르는 값은 그대로(화면이 깨지지 않게)");
});

// ── fail-safe: 기록이 로그인·요청 흐름을 막지 않는다 ──────────
test("감사 기록은 절대 예외를 밖으로 내보내지 않는다(로그인 흐름 비차단)", () => {
  const orig = db().prepare;
  db().prepare = () => { throw new Error("DB 폭발"); };
  try {
    assert.doesNotThrow(() => logAccessDaily({ email: "x@omgworks.kr", role: "chief" }, "크롬/맥"));
    assert.doesNotThrow(() => logAudit({ email: "x@omgworks.kr" }, "auth.login", "치프 · 크롬/맥"));
    assert.doesNotThrow(() => listAudit(50, "auth"));
  } finally {
    db().prepare = orig;
  }
});
