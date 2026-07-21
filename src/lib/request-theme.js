"use strict";

/**
 * 요청별 테마/팔레트 컨텍스트(2026-07-21) — 서버가 `<html>`에 data-theme·data-palette를 **첫 페인트에** 렌더하기 위한 것.
 *
 * 왜: 테마(라이트/다크)·팔레트는 그동안 theme-init.js가 <head>에서 세팅했는데, dev는 그 파일을 매 이동마다
 * 다시 받고(캐시 max-age=0) 프로덕션도 첫 방문엔 캐시가 없어, 그 지연 동안 서버 기본(라이트)이 먼저 그려졌다
 * 다크로 바뀌는 깜빡임이 있었다(사용자 리포트). 값을 **쿠키**로 두면 서버가 첫 HTML에 바로 넣어 깜빡임이 없다.
 *
 * 30여 곳의 layout() 호출부를 안 건드리려고 AsyncLocalStorage로 요청 컨텍스트를 흘린다(Node 내장·의존성 0).
 * 미들웨어가 쿠키를 담아 다운스트림을 감싸고, layout()이 currentThemeAttrs()로 읽는다.
 * 테스트는 컨텍스트 없이 layout()을 직접 부르므로 기본값(팔레트 linear·테마 없음 = 기존 렌더와 동일)을 돌려준다.
 *
 * theme-init.js는 여전히 남는다 — 첫 방문(쿠키 없음)·OS 테마 변경·쿠키만 지운 경우의 폴백 + 쿠키 기록(다음 이동부터 서버가 앎).
 */
const { AsyncLocalStorage } = require("async_hooks");

const als = new AsyncLocalStorage();
const PALETTES = ["apple", "linear", "spotify", "pinterest"];

function runWithTheme(store, next) {
  return als.run(store || {}, next);
}

/**
 * `<html>`에 넣을 속성값. 쿠키가 없으면 기존 동작과 동일(팔레트 linear 기본·테마 미설정 = OS 추종을 CSS/theme-init에 위임).
 * claude는 **속성 없음**(:root)이라 palette=null로 돌려준다.
 */
function currentThemeAttrs() {
  const s = als.getStore() || {};
  const theme = s.theme === "dark" || s.theme === "light" ? s.theme : null;
  let palette;
  if (PALETTES.indexOf(s.palette) !== -1) palette = s.palette;
  else if (s.palette === "claude") palette = null; // 클레이 = :root 기본(속성 없음)
  else palette = "linear"; // 미설정 = 앱 기본
  return { theme, palette };
}

module.exports = { runWithTheme, currentThemeAttrs };
