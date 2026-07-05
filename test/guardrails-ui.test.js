"use strict";

const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");

/**
 * UI(프론트엔드) 가드레일 — 서버 렌더 HTML ↔ app.js(CSP·위임) 사이의 **계약**을 기계 검사(2026-07-04).
 *
 * 이 앱의 프론트 버그는 대부분 "양쪽 드리프트"였다: 서버가 렌더하는 data-* 마커/옵션 JSON과
 * app.js가 찾는 셀렉터/키가 어긋나도 **아무 에러 없이 조용히 죽는다**(CSP 서버렌더 구조의 그늘).
 * → 브라우저 없이(의존성 0) 소스 양쪽을 파싱해 계약 자체를 검증한다. DB 불필요(순수 정적).
 */

const ROOT = path.join(__dirname, "..");
const SRC = path.join(ROOT, "src");
const APP = fs.readFileSync(path.join(ROOT, "public", "js", "app.js"), "utf8");

function srcFiles() {
  return fs
    .readdirSync(SRC, { recursive: true })
    .filter((f) => String(f).endsWith(".js"))
    .map((f) => path.join("src", String(f)));
}
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), "utf8");
const SRC_ALL = srcFiles().map((f) => ({ f, s: read(f) }));
const SRC_TEXT = SRC_ALL.map((x) => x.s).join("\n");
const escRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// ── ① data-* 마커 계약: app.js가 찾는 모든 마커는 어딘가에서 렌더돼야 한다 ──
// 사고 이력: 마커/옵션이 서버에서 안 나와 기능이 조용히 죽던 클래스(디렉터·대표자 콤보 회사칸,
// tracks 탭 datalist 미렌더로 자동완성 무동작 등). 양방향 리네임 드리프트를 한 검사로 잡는다:
// 서버가 마커를 바꾸면(또는 지우면) app.js 쿼리가 렌더 코퍼스에서 사라져 실패하고,
// app.js가 새 마커를 찾기 시작하면 서버가 렌더할 때까지 실패한다.
test("ui-guardrail: app.js가 참조하는 data-* 마커는 전부 렌더된다(서버 템플릿/app.js HTML)", () => {
  // 렌더 코퍼스: 서버 템플릿 전체 + app.js에서 HTML을 만들거나 속성을 세팅하는 줄.
  const appRenderLines = APP.split("\n").filter((l) => l.includes("<") || l.includes('setAttribute("data-'));
  const corpus = SRC_TEXT + "\n" + appRenderLines.join("\n");
  // app.js가 '찾는' 토큰: 셀렉터 [data-…] + getAttribute("data-…"). 끝이 '-'면 동적 접두(prefix).
  const queried = new Map(); // token → isPrefix
  for (const m of APP.matchAll(/\[data-([a-z0-9-]+)/g)) queried.set(m[1], m[1].endsWith("-") || queried.get(m[1]) || false);
  for (const m of APP.matchAll(/getAttribute\(\s*["']data-([a-z0-9-]+)["']/g)) if (!queried.has(m[1])) queried.set(m[1], false);
  const offenders = [];
  for (const [t, isPrefix] of queried) {
    const token = isPrefix ? t.replace(/-+$/, "") : t;
    const re = isPrefix
      ? new RegExp(`([^\\[])data-${escRe(token)}-([a-z0-9-]+|\\$\\{)`) // 접두: data-rate-opts-recording 또는 템플릿 변수 data-rate-opts-${k}
      : new RegExp(`([^\\[])data-${escRe(token)}(?![a-z0-9-])`); // 정확 일치, 쿼리 문맥([data-) 제외
    if (!re.test(corpus)) offenders.push(`data-${t}${isPrefix ? "* (접두)" : ""}`);
  }
  assert.deepEqual(offenders, [], "app.js가 찾지만 아무도 렌더하지 않는 마커(죽은 기능):\n" + offenders.join("\n"));
});

// ── ② 콤보 보이는 입력은 name 금지(함정 #19의 기계화) ──
// 사고 이력: 보이는 콤보 입력에 name이 있으면 Chrome 자동완성 팝업이 앱 드롭다운을 덮는다.
// 값은 숨김 필드로 제출하는 게 콤보 계약(personCombo·companyCombo·payerCombo 공통).
test("ui-guardrail: 콤보 보이는 입력(data-pc/cc/pk-input)에 name 속성 금지", () => {
  const offenders = [];
  for (const { f, s } of SRC_ALL) {
    s.split("\n").forEach((line, i) => {
      for (const m of line.matchAll(/<input\b[^>]*data-(pc|cc|pk)-input[^>]*/g)) {
        if (/\bname="/.test(m[0])) offenders.push(`${f}:${i + 1} ${m[0].slice(0, 80)}`);
      }
    });
  }
  assert.deepEqual(offenders, [], offenders.join("\n"));
});

// ── ③ CSP 계약: 인라인 스크립트/핸들러 금지 ──
// helmet CSP(인라인 0)라 onclick= 등은 배포에서 **조용히 무시**된다(로컬에서만 되는 척하는 최악의 드리프트).
// <script>는 외부 src(캐시버스팅 layout) 또는 데이터 임베드(type="application/json")만.
test("ui-guardrail: 인라인 이벤트 핸들러·javascript:·인라인 <script> 금지(CSP)", () => {
  const offenders = [];
  for (const { f, s } of SRC_ALL) {
    s.split("\n").forEach((line, i) => {
      if (/\son(click|change|input|submit|keydown|keyup|focus|blur|load|error|mouse[a-z]+)=["']/i.test(line)) offenders.push(`${f}:${i + 1} 인라인 핸들러`);
      if (/javascript:/i.test(line)) offenders.push(`${f}:${i + 1} javascript: URL`);
      if (/<script(?![^>]*(type="application\/json"|src="))/.test(line)) offenders.push(`${f}:${i + 1} 인라인 <script>`);
    });
  }
  assert.deepEqual(offenders, [], offenders.join("\n"));
});

// ── ④ 한글 IME 가드(함정 #18의 기계화) ──
// 사고 이력: 조합 중 엔터를 선택/등록/제출로 오인 → 모달 연쇄 오작동·글자 중복("김조한한").
// Enter/방향키를 다루는 keydown 핸들러는 반드시 isComposing(=keyCode 229) 가드로 시작해야 한다.
test("ui-guardrail: Enter/방향키 keydown 핸들러는 IME 조합 가드 필수", () => {
  const offenders = [];
  const parts = APP.split('addEventListener("keydown"');
  for (let i = 1; i < parts.length; i++) {
    const body = parts[i].slice(0, 700); // 핸들러 앞부분(가드는 맨 앞에 두는 관례)
    if (/(["']Enter["']|Arrow(Down|Up))/.test(body) && !/isComposing|keyCode === 229/.test(body)) {
      offenders.push(`keydown 핸들러 #${i}: ${body.slice(0, 70).replace(/\s+/g, " ")}…`);
    }
  }
  assert.deepEqual(offenders, [], "IME 가드(if (e.isComposing || e.keyCode === 229) return;)를 맨 앞에:\n" + offenders.join("\n"));
});

// ── ⑤ 금액 입력칸 ↔ 콤마 포맷터(MONEY) 계약 ──
// 사고 이력: 금액칸은 app.js MONEY 정규식에 name이 매칭돼야 콤마·캐럿 보정이 붙는다.
// 새 금액 필드를 추가하고 MONEY 갱신을 잊으면 그 칸만 조용히 포맷이 빠진다.
test("ui-guardrail: 금액성 입력(name에 price/amount/_rate)은 MONEY 정규식에 매칭", () => {
  const moneySrc = APP.match(/var MONEY = \/(.+)\/;/);
  assert.ok(moneySrc, "app.js MONEY 정의 존재");
  const MONEY = new RegExp(moneySrc[1]);
  const offenders = [];
  for (const { f, s } of SRC_ALL) {
    s.split("\n").forEach((line, i) => {
      for (const m of line.matchAll(/<input\b[^>]*/g)) {
        const tag = m[0];
        if (/type="hidden"/.test(tag)) continue;
        const nm = tag.match(/name="([a-z_]+(?:_\$\{[^}]+\})?)"/); // session_amount_${s.id} 형태 허용
        if (!nm) continue;
        const name = nm[1].replace(/_\$\{[^}]+\}/, "_1"); // 템플릿 id → 대표값으로 치환해 검사
        if (/(price|amount|_rate)\b|(^|_)rate$/.test(name) && !MONEY.test(name)) offenders.push(`${f}:${i + 1} name="${nm[1]}"`);
      }
    });
  }
  assert.deepEqual(offenders, [], "MONEY 정규식에 추가하거나 금액칸이 아니면 이름을 바꾸세요:\n" + offenders.join("\n"));
});

// ── ⑥ personCombo 옵션 JSON 키 계약(워터멜론·회사검색 회귀 잠금) ──
// 사고 이력: 옵션 JSON에 activity_name(alt)이 빠져 본명/활동명 검색 반쪽(워터멜론/박수한),
// company 미검색(회사 이름으로 담당자 찾기). 서버 임베드 키와 app.js 소비 키를 양쪽에서 고정.
test("ui-guardrail: personCombo 옵션 JSON 키 ↔ app.js 검색·표시 소비 정합", () => {
  const views = read(path.join("src", "views.js"));
  for (const key of ["alt:", "honorific:", "phone:", "email:", "company:", "job_title:", "group:"]) {
    const count = (views.match(new RegExp(escRe(key), "g")) || []).length;
    assert.ok(count >= 2, `views.js 옵션 매핑 2곳(personCombo 인라인·공유 스크립트)에 ${key} 임베드 (현재 ${count})`);
  }
  assert.ok(/o\.alt/.test(APP), "app.js 검색이 활동명(alt) 매칭");
  assert.ok(/o\.company/.test(APP), "app.js 검색이 소속 회사(company) 매칭");
  assert.ok(/o\.honorific/.test(APP), "app.js 라벨이 호칭(honorific) 표시");
});

// ── ⑥b companyCombo(사람 허용) 옵션 키 계약(제작/운영 개인 병기·자동채움 회귀 잠금, 2026-07-05) ──
// 사고 이력 클래스: 옵션 임베드 키 ↔ app.js 소비 키 드리프트(⑥과 동일 클래스 — pc에서 2회 재발해 가드化).
// 제작/운영 콤보는 회사+사람 혼합이라 kind로 사람 판별, alt(활동명)·honorific으로 병기 라벨(dispOf) 구성.
test("ui-guardrail: companyCombo 사람 옵션 키(kind/alt/honorific) ↔ app.js dispOf·자동채움 소비 정합", () => {
  const views = read(path.join("src", "views.js"));
  assert.ok(/kind:\s*"person",\s*alt:/.test(views), "views.js companyCombo 사람 옵션에 kind:'person' + alt(활동명) 임베드");
  assert.ok(/function dispOf/.test(APP), "app.js companyCombo dispOf(병기 라벨) 존재");
  assert.ok(/o\.kind\s*!==\s*"person"|o\.kind\s*===\s*"person"/.test(APP), "app.js가 옵션 kind로 사람/회사 판별");
  assert.ok(/__pcSetById/.test(APP), "app.js personCombo가 __pcSetById 노출(제작/운영→담당자 자동채움 계약)");
});
