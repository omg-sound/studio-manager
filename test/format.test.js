"use strict";

// ── 전화·사업자등록번호 정규화(lib/format) 회귀 잠금 ──
// formatBizNo는 청구처 사업자번호(거래명세서 PDF·홈택스 복사 대상), formatPhone은 전 저장 경로 공통.
// 정규화가 회귀하면 잘못 포맷된 값이 세금 문서에 인쇄된다(무테스트였음). 순수 함수라 격리 DB 불필요.
process.env.NODE_ENV = "test";
const test = require("node:test");
const assert = require("node:assert");
const { formatPhone, formatBizNo } = require("../src/lib/format");

test("formatPhone: 11자리 휴대폰 → ###-####-#### (구분자 무관)", () => {
  assert.equal(formatPhone("01035485638"), "010-3548-5638");
  assert.equal(formatPhone("010 3548 5638"), "010-3548-5638");
  assert.equal(formatPhone("010.3548.5638"), "010-3548-5638");
  assert.equal(formatPhone("010-3548-5638"), "010-3548-5638");
});

test("formatPhone: 지역번호 — 02(9·10자리)·기타 10자리", () => {
  assert.equal(formatPhone("0212345678"), "02-1234-5678", "02 + 8자리 = 02-####-####");
  assert.equal(formatPhone("021234567"), "02-123-4567", "02 + 7자리 = 02-###-####");
  assert.equal(formatPhone("0311234567"), "031-123-4567", "031 등 10자리 = 0##-###-####");
  assert.equal(formatPhone("0511234567"), "051-123-4567");
});

test("formatPhone: 8자리(국번 없는 지역) → ####-####", () => {
  assert.equal(formatPhone("12345678"), "1234-5678");
});

test("formatPhone: 형식 불명(자릿수 다름)·빈 값", () => {
  assert.equal(formatPhone("1234"), "1234", "4자리 등은 원본 보존");
  assert.equal(formatPhone("+82 10-3548-5638"), "+82 10-3548-5638", "12자리는 원본 보존(해외·내선)");
  assert.equal(formatPhone(""), null);
  assert.equal(formatPhone(null), null);
  assert.equal(formatPhone("   "), null);
});

test("formatBizNo: 10자리 → 000-00-00000 (구분자 무관)", () => {
  assert.equal(formatBizNo("1234567890"), "123-45-67890");
  assert.equal(formatBizNo("123-45-67890"), "123-45-67890");
  assert.equal(formatBizNo("123 45 67890"), "123-45-67890");
});

test("formatBizNo: 자릿수 다름은 원본 보존·빈 값은 null", () => {
  assert.equal(formatBizNo("12345"), "12345");
  assert.equal(formatBizNo("123456789012"), "123456789012");
  assert.equal(formatBizNo(""), null);
  assert.equal(formatBizNo(null), null);
});

// ── DB 타임스탬프(UTC) → 한국 시간 표시(2026-07-20 사용자 요청 '시스템 시간대가 UTC인데 우리나라 시간으로') ──
// SQLite datetime('now')는 UTC다. 그대로 앞 10자를 자르면 **KST 00:00~08:59에 만든 것이 하루 이르게** 보인다
// (실측: 개발 DB 프로젝트 7건). 저장은 UTC 그대로 두고 표시에서만 +9h 한다.
const { kstYmd, kstDateTime } = require("../src/lib/date");

test("kstYmd: UTC 저녁 = KST 다음 날(작성일이 하루 이르게 보이던 버그)", () => {
  assert.equal(kstYmd("2026-07-19 23:30:00"), "2026-07-20", "UTC 19일 23:30 = KST 20일 08:30");
  assert.equal(kstYmd("2026-07-19 15:00:00"), "2026-07-20", "KST 자정 경계(UTC 15:00)");
  assert.equal(kstYmd("2026-07-19 14:59:59"), "2026-07-19", "경계 직전은 그대로");
});

test("kstDateTime: 시각까지 KST로(감사 로그)", () => {
  assert.equal(kstDateTime("2026-07-20 02:00:00"), "2026-07-20 11:00");
  assert.equal(kstDateTime("2026-07-19 23:30:00"), "2026-07-20 08:30");
});

test("kstYmd/kstDateTime: 날짜만 있는 값은 그대로(이미 KST 기준으로 고른 날짜)", () => {
  // session_date·issued_date 등은 사용자가 고른 KST 날짜다 — 여기에 +9h를 먹이면 하루 밀린다.
  assert.equal(kstYmd("2026-07-20"), "2026-07-20");
  assert.equal(kstDateTime("2026-07-20"), "2026-07-20");
});

test("kstYmd/kstDateTime: 빈 값·형식 불명은 조용히 통과(표시용이라 던지지 않는다)", () => {
  assert.equal(kstYmd(""), "");
  assert.equal(kstYmd(null), "");
  assert.equal(kstDateTime(undefined), "");
  assert.equal(kstYmd("이상한값"), "이상한값".slice(0, 10));
});

test("kstDate: ISO(Z·오프셋 표기)도 이해한다", () => {
  const { kstDate } = require("../src/lib/date");
  assert.equal(kstDate("2026-07-19T23:30:00Z").getUTCHours(), 8, "Z 표기");
  assert.equal(kstDate("2026-07-20") , null, "날짜만이면 변환 대상 아님");
});

// ── KST 표시가 **호출부에서도** 살아있는지(2026-07-20 메인터넌스 — 뮤테이션으로 공백 증명) ──
// 헬퍼 테스트만 있으면 호출부를 옛 `slice(0,10)`으로 되돌려도 전 테스트가 통과한다(실측).
// 그래서 화면 렌더 결과를 직접 본다: UTC 저녁 타임스탬프가 **다음 날**로 보여야 한다.
test("표시 호출부: 프로젝트 목록 작성일이 KST로 렌더된다", () => {
  const { projectListRow } = require("../src/views.projects");
  const row = {
    id: 1, title: "P", artist: "루나", client_name: "C", manager_name: "",
    next_session_date: null, sess_scheduled: 0, sess_done: 0, task_cnt: 0, task_pending: 0, task_done: 0,
    unbilled_cnt: 0, track_titles: "", task_total: 0, session_amount_total: 0, rate: 0, invoice_discount_total: 0,
    created_at: "2026-07-19 23:30:00", // UTC 저녁 = KST 20일 아침
  };
  const html = projectListRow(row, { sessions: [], tracks: [], taskTypes: [] }, { tab: "active" });
  assert.match(html, /2026-07-20/, "KST 날짜로 표시");
  assert.ok(!/2026-07-19/.test(html), "UTC 날짜가 새어나오면 안 된다(표시·정렬값 모두)");
});

test("표시 호출부: 감사 로그가 KST 시각으로 렌더된다", () => {
  const { kstDateTime } = require("../src/lib/date");
  // views.settings는 DB·설정을 폭넓게 건드려 단독 렌더가 무거우므로, 감사 행이 쓰는 변환만 계약으로 고정한다.
  const src = require("fs").readFileSync(require("path").join(__dirname, "..", "src", "views.settings.js"), "utf8");
  assert.match(src, /kstDateTime\(a\.at\)/, "감사 로그 시각은 kstDateTime으로");
  assert.ok(!/String\(a\.at \|\| ""\)\.replace\("T", " "\)\.slice\(0, 16\)/.test(src), "옛 UTC 절단 잔존 없음");
  assert.equal(kstDateTime("2026-07-20 02:00:00"), "2026-07-20 11:00");
});

test("표시 호출부: 업체·연락처 상세의 프로젝트 표도 KST", () => {
  const fs = require("fs"); const path = require("path");
  for (const f of ["views.clients.js", "views.contacts.js"]) {
    const src = fs.readFileSync(path.join(__dirname, "..", "src", f), "utf8");
    assert.match(src, /kstYmd\((p|pr)\.created_at\)/, `${f}: 작성일 KST 변환`);
    assert.ok(!/created_at \|\| ""\)\.slice\(0, 10\)/.test(src), `${f}: 옛 UTC 절단 잔존 없음`);
  }
});
