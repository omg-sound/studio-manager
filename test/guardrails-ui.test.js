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

// ── ③-b 레이아웃 인라인 style 금지(함정 #27) ──
// CSP style-src(unsafe-inline 없음)라 서버 렌더 `style="width:…"`는 **브라우저가 파싱조차 안 함** → 조용히 무시.
// (dataTable <col style="width"> 가 안 먹어 6열 균등 분배로 렌더되던 사고, 2026-07-16.) 치수·레이아웃은 CSS 클래스로.
// display:none(JS 토글용)만 예외로 허용 — 나머지 치수/그리드/플렉스 속성은 인라인 금지.
test("ui-guardrail: 서버 렌더 인라인 style에 치수·레이아웃 속성 금지(CSP style-src)", () => {
  const offenders = [];
  const LAYOUT = /style="[^"]*(width|height|grid-template|grid-column|grid-row|flex-basis|max-width|min-width|max-height|min-height)\s*:/i;
  // 예외: 이메일 HTML(mailer)·PDF SVG(invoice-pdf)는 브라우저 페이지가 아니라 CSP 무관 + 인라인 style 필수(이메일 클라이언트가 요구).
  const EXEMPT = /(mailer|invoice-pdf)\.js$/;
  for (const { f, s } of SRC_ALL) {
    if (EXEMPT.test(f)) continue;
    s.split("\n").forEach((line, i) => {
      if (LAYOUT.test(line)) offenders.push(`${f}:${i + 1} ${line.match(/style="[^"]*"/)[0].slice(0, 70)}`);
    });
  }
  assert.deepEqual(offenders, [], "인라인 style 치수 → CSS 클래스로(CSP에 막힘):\n" + offenders.join("\n"));
});

// ── ④ 한글 IME 가드(함정 #18의 기계화) ──
// 사고 이력: 조합 중 엔터를 선택/등록/제출로 오인 → 모달 연쇄 오작동·글자 중복("김조한한").
// Enter/방향키를 다루는 keydown 핸들러는 반드시 isComposing(=keyCode 229) 가드로 시작해야 한다.
test("ui-guardrail: Enter/방향키 keydown 핸들러는 IME 조합 가드 필수", () => {
  const offenders = [];
  const parts = APP.split('addEventListener("keydown"');
  for (let i = 1; i < parts.length; i++) {
    const body = parts[i].slice(0, 700); // 핸들러 앞부분(가드는 맨 앞에 두는 관례)
    if (/(["']Enter["']|Arrow(Down|Up|Left|Right))/.test(body) && !/isComposing|keyCode === 229/.test(body)) {
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
  // ⚠️ **개수가 아니라 자리로 검사한다**(2026-07-20 메인터넌스 — 뮤테이션으로 결함 증명):
  // 예전엔 파일 전체에서 `alt:` 개수가 2 이상이면 통과했는데, companyCombo에도 `alt:`가 있어
  // **personCombo 두 자리 중 하나에서 키를 지워도 통과**했다. 그건 이 가드가 막으려던 바로 그 드리프트다.
  // → 두 임베드 함수의 **본문을 각각 잘라내** 그 안에 키가 있는지 본다.
  const bodyOf = (fnName) => {
    const start = views.indexOf(`function ${fnName}(`);
    assert.ok(start >= 0, `${fnName} 함수를 찾지 못함(개명됐다면 이 가드도 갱신할 것)`);
    const next = views.indexOf("\nfunction ", start + 1);
    return views.slice(start, next < 0 ? views.length : next);
  };
  const sites = { personCombo: bodyOf("personCombo"), personComboOptionsScript: bodyOf("personComboOptionsScript") };
  for (const key of ["alt:", "honorific:", "phone:", "email:", "company:", "job_title:", "group:"]) {
    for (const [name, body] of Object.entries(sites)) {
      assert.ok(body.includes(key), `${name}의 옵션 임베드에 ${key} 누락 — 한쪽만 빠지면 검색·표시가 반쪽이 된다`);
    }
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

// ── ⑦ 드롭다운 내부 스크롤은 컨테이너만 움직인다(2026-07-14 사용자 리포트) ──
// 사고: 시간 콤보가 현재 값을 목록 최상단에 올리려고 scrollIntoView를 써서 **페이지까지 함께 스크롤**,
// 늦은 시각(18:00 등)을 고르면 화면이 통째로 맨 아래로 튀었다. 팝업 내부 정렬은 scrollTop으로만.
test("ui-guardrail: 시간 콤보 팝업은 scrollIntoView가 아니라 scrollTop으로 정렬(페이지 튐 방지)", () => {
  const open = APP.slice(APP.indexOf("function openPop()"), APP.indexOf("function closePop()"));
  assert.ok(open.length > 0, "app.js 시간 콤보 openPop 존재");
  const code = open.replace(/\/\/[^\n]*/g, ""); // 주석 제거(설명문에 이름이 나오는 건 허용)
  assert.ok(!/\.scrollIntoView\s*\(/.test(code), "openPop에서 scrollIntoView 호출 금지(window까지 스크롤됨)");
  assert.ok(/pop\.scrollTop\s*=/.test(open), "팝업 자체의 scrollTop으로 정렬");
});

// ── 2026-07-17 사람/조직 축 정리: 화면 문구에서 '클라이언트' 제거 ──
// 코드 식별자·주석은 그대로 두므로(배포 안정성), **사용자 노출 문자열 리터럴**만 검사한다.
// 파일 목록을 손으로 유지하면(옛 9개 하드코딩) 새 파일이 가드 밖으로 새므로 src/ 전체를 훑는다.
const CLIENT_TERM_ALLOW = []; // 정당한 예외만(현재 없음). 레거시 DB 컬럼명(client_id 등)은 식별자라 애초에 안 걸린다.
test("가드: 사용자 노출 문자열에 '클라이언트'가 없다", () => {
  const offenders = [];
  SRC_ALL.filter(({ f }) => !CLIENT_TERM_ALLOW.includes(f)).forEach(({ f, s: raw }) => {
    const src = raw.replace(/\/\*[\s\S]*?\*\//g, ""); // 블록 주석 제거(라인 분할 전 — //만 제거하면 /** */ 오탐)
    src.split("\n").forEach((line, i) => {
      const code = line.replace(/\/\/.*$/, ""); // 한 줄 주석 제외
      if (!/클라이언트/.test(code)) return;
      // 문자열 리터럴(", ', `) 안의 '클라이언트'만 위반 — 식별자엔 한글이 없으므로 사실상 전부 노출 문구다.
      if (/["'`][^"'`]*클라이언트/.test(code)) offenders.push(`${f}:${i + 1} ${line.trim().slice(0, 80)}`);
    });
  });
  assert.deepEqual(offenders, [], "화면 문구에 '클라이언트' 잔존:\n" + offenders.join("\n"));
});

// 2026-07-20 사용자 요청 '사업자등록증 열기 — 작게 나와서 별로'(원 요청엔 '사이드탭 없이'도 있었다).
// PDF를 최상위로 열면 45%로 쪼그라들어 iframe + #view=FitH로 폭을 맞춘다.
// ⚠️<embed>/<object>는 CSP object-src 'none'에 막힌다.
// ⚠️**사이드탭은 이 방법으로 안 없어졌다**(사용자 확인) — 크롬이 사이드탭 열림 상태를 브라우저별로 기억한다.
//   그래서 이 테스트가 잠그는 건 '사이드탭 제거'가 아니라 **폭 맞춤 + CSP 안전한 태그** 두 가지다.
test("첨부 뷰어: PDF는 iframe + 폭 맞춤(embed/object 금지 — CSP object-src 'none')", () => {
  const { fileViewerPage } = require("../src/views");
  const pdf = fileViewerPage({ title: "사업자등록증", rawUrl: "/clients/3/files/biz_license/raw", pdf: true });
  assert.match(pdf, /<iframe src="\/clients\/3\/files\/biz_license\/raw#view=FitH"/, "iframe + 폭 맞춤");
  assert.match(pdf, /class="h-screen w-screen border-0"/, "창을 꽉 채운다");
  assert.ok(!/<embed|<object/.test(pdf), "embed/object는 CSP에 막혀 빈 화면이 된다");
  // 이미지는 기존 경로 그대로(뷰어 스크립트가 창 크기를 원본 비율로 맞춘다)
  const img = fileViewerPage({ title: "주민등록증", rawUrl: "/workers/1/files/id_card/raw" });
  assert.match(img, /<img [^>]*data-viewer-img/);
  assert.match(img, /viewer\.js/);
  assert.ok(!/<iframe/.test(img), "이미지는 iframe으로 감싸지 않는다");
});

test("첨부 뷰어 라우트: PDF도 뷰어로 감싼다(옛 raw 리다이렉트 잔존 없음)", () => {
  const fs = require("fs");
  const path = require("path");
  ["clients", "workers"].forEach((n) => {
    const src = fs.readFileSync(path.join(__dirname, "..", "src", "routes", `${n}.routes.js`), "utf8");
    // 한 줄 안에 뷰어 호출 + pdf 판정이 함께 있어야 한다(rawUrl 템플릿 리터럴에 }가 있어 블록 매칭은 못 쓴다).
    const call = src.split("\n").find((l) => l.includes("fileViewerPage({"));
    assert.ok(call && /pdf: \([a-z]+\.mime_type \|\| ""\)\.includes\("pdf"\)/.test(call), `${n}: mime로 pdf 판정 후 뷰어로`);
    assert.ok(!/includes\("pdf"\)\) return res\.redirect/.test(src), `${n}: 옛 raw 리다이렉트 잔존 없음`);
  });
});
