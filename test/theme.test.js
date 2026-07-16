"use strict";

// 테마 선택 기능(2026-07-17) 소스 계약 검사 — Original 보존 + 3팔레트 + 드롭다운·FOUC 스크립트 배선.
// app.css는 빌드 산출물(gitignore)이라 소스(src.css/views.js/app.js/theme-init.js)를 검사한다.

const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const R = (rel) => fs.readFileSync(path.join(ROOT, rel), "utf8");
const SRC_CSS = R("public/css/src.css");
const VIEWS = R("src/views.js");
const APP = R("public/js/app.js");

test("Original 보존: :root 기본 색 토큰이 그대로(크림 배경·클레이 액센트)", () => {
  // 기존 정체성 색이 바뀌지 않았는지(팔레트 추가가 Original을 건드리지 않았는지).
  assert.match(SRC_CSS, /--color-bg:\s*250 249 245/, "크림 배경 #FAF9F5 유지");
  assert.match(SRC_CSS, /--color-primary:\s*200 121 91/, "클레이 액센트 #C8795B 유지");
});

test("요구사항1: 폰트·radius·shadow가 CSS 변수로 추출됨(Original 값)", () => {
  assert.match(SRC_CSS, /--font-sans:\s*"Pretendard"/, "--font-sans 추출");
  assert.match(SRC_CSS, /--radius-card:\s*0\.75rem/, "--radius-card=rounded-xl 값");
  assert.match(SRC_CSS, /--radius-btn:\s*0\.5rem/, "--radius-btn=rounded-lg 값");
  assert.match(SRC_CSS, /--shadow-card:/, "--shadow-card 추출");
  // 컴포넌트가 변수를 참조
  assert.match(SRC_CSS, /border-radius:\s*var\(--radius-card\)/, ".card가 변수 참조");
  assert.match(SRC_CSS, /box-shadow:\s*var\(--shadow-card\)/, ".card 그림자가 변수 참조");
  assert.match(SRC_CSS, /border-radius:\s*var\(--radius-btn\)/, ".btn이 변수 참조");
});

test("3팔레트(apple·material·linear) 색·폰트·radius 오버라이드 존재", () => {
  for (const p of ["apple", "material", "linear"]) {
    assert.match(SRC_CSS, new RegExp(`data-palette="${p}"`), `${p} 팔레트 블록`);
    assert.match(SRC_CSS, new RegExp(`data-palette="${p}"\\]\\[data-theme="dark"`), `${p} 다크 변형`);
  }
  assert.match(SRC_CSS, /--color-primary:\s*0 122 255/, "Apple=iOS 블루");
  assert.match(SRC_CSS, /Roboto/, "Material=Roboto 폰트");
  assert.match(SRC_CSS, /--color-primary:\s*94 106 210/, "Linear=indigo 액센트");
});

test("스와치 아이콘·FOUC 스크립트 배선(views.js)", () => {
  // 팔레트 선택 = 특징색 스와치 아이콘(드롭다운 아님, 2026-07-17).
  for (const p of ["original", "apple", "material", "linear"]) {
    assert.match(VIEWS, new RegExp(`data-theme-swatch="${p}"`), `${p} 스와치`);
  }
  // theme-init.js를 CSS보다 먼저 동기 로드(FOUC 방지, CSP-safe 외부 파일)
  assert.match(VIEWS, /theme-init\.js/, "theme-init 스크립트 로드");
  const initIdx = VIEWS.indexOf('src="/js/theme-init.js');
  const cssIdx = VIEWS.indexOf('rel="stylesheet" href="/css/app.css'); // 실제 head <link>(주석·경로 문자열 제외)
  assert.ok(initIdx > 0 && initIdx < cssIdx, "theme-init가 app.css <link>보다 앞(FOUC 방지)");
  // 스와치 색은 CSP상 인라인 style 금지 → CSS 클래스로
  assert.match(SRC_CSS, /\.theme-swatch-apple\s*{\s*background:\s*#007AFF/i, "Apple 스와치 색 클래스");
});

test("app.js: 스와치 클릭 처리 + localStorage(팔레트가 라이트/다크 강제하지 않음)", () => {
  assert.match(APP, /data-theme-swatch/, "app.js가 스와치 클릭 처리");
  assert.match(APP, /localStorage\.setItem\("palette"/, "palette 저장");
  assert.match(APP, /aria-pressed/, "활성 스와치 aria-pressed 동기화");
  // Linear도 라이트 가능 — 팔레트 선택이 data-theme를 강제하지 않는다(2026-07-17 사용자 요청).
  assert.ok(!/theme-swatch[\s\S]{0,400}setTheme\("dark"\)/.test(APP), "스와치 클릭이 다크를 강제하지 않음");
});

test("theme-init.js: data-theme·data-palette 조기 적용(FOUC 방지)", () => {
  const init = R("public/js/theme-init.js");
  assert.match(init, /localStorage\.getItem\("theme"\)/, "저장 theme 읽기");
  assert.match(init, /localStorage\.getItem\("palette"\)/, "저장 palette 읽기");
  assert.match(init, /setAttribute\("data-theme"/, "data-theme 적용");
  assert.match(init, /setAttribute\("data-palette"/, "data-palette 적용");
});
