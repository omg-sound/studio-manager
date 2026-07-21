"use strict";

// ── 테마/팔레트 서버 렌더(FOUC 방지) 회귀 잠금(2026-07-21) ──
// 다크 사용자가 페이지 이동 시 라이트로 첫 페인트됐다 다크로 바뀌는 깜빡임을 없애려고,
// 쿠키를 요청 컨텍스트(AsyncLocalStorage)로 흘려 layout()이 <html>에 첫 페인트로 렌더한다.
// 이 계약이 깨지면(속성 누락·잘못된 기본값) 깜빡임이 조용히 되살아난다.
process.env.NODE_ENV = "test";
const test = require("node:test");
const assert = require("node:assert");
const { runWithTheme, currentThemeAttrs } = require("../src/lib/request-theme");
const { layout } = require("../src/views");

test("컨텍스트 없음(테스트·정적) = 기본: 팔레트 linear·테마 없음(기존 렌더와 동일)", () => {
  assert.deepEqual(currentThemeAttrs(), { theme: null, palette: "linear" });
});

test("쿠키 값 반영: theme·palette", () => {
  runWithTheme({ theme: "dark", palette: "spotify" }, () => {
    assert.deepEqual(currentThemeAttrs(), { theme: "dark", palette: "spotify" });
  });
});

test("claude = 속성 없음(:root)", () => {
  runWithTheme({ palette: "claude" }, () => {
    assert.deepEqual(currentThemeAttrs(), { theme: null, palette: null });
  });
});

test("모르는 값 방어: 팔레트는 linear로, 테마는 무시(null)", () => {
  runWithTheme({ theme: "weird", palette: "material" }, () => {
    assert.deepEqual(currentThemeAttrs(), { theme: null, palette: "linear" });
  });
});

test("layout(): 컨텍스트 밖은 data-palette=linear만(테마 없음)", () => {
  const html = layout({ title: "T", user: null, body: "" });
  assert.match(html, /<html lang="ko" data-palette="linear">/);
  assert.ok(!/data-theme=/.test(html.slice(0, html.indexOf("<head>"))), "테마 속성 없음");
});

test("layout(): 다크 쿠키면 <html>에 data-theme=dark 렌더(첫 페인트 다크)", () => {
  runWithTheme({ theme: "dark", palette: "linear" }, () => {
    const html = layout({ title: "T", user: null, body: "" });
    assert.match(html, /<html lang="ko" data-palette="linear" data-theme="dark">/);
  });
});

test("layout(): claude 쿠키면 <html>에 팔레트 속성 없음", () => {
  runWithTheme({ palette: "claude" }, () => {
    const html = layout({ title: "T", user: null, body: "" });
    assert.match(html, /<html lang="ko">/);
  });
});
