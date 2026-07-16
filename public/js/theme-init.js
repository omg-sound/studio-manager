/* 테마 조기 적용(FOUC 방지) — <head>에서 CSS보다 먼저 동기 실행(defer 아님).
   저장된 data-theme(light/dark)·data-palette(original/apple/material/linear)를 <html>에 즉시 세팅
   → 스타일시트가 그 속성 기준으로 렌더돼 새로고침 시 깜빡임 없음. CSP script-src 'self' 준수(외부 파일). */
(function () {
  try {
    var t = localStorage.getItem("theme");
    if (t === "dark" || t === "light") document.documentElement.setAttribute("data-theme", t);
    var p = localStorage.getItem("palette");
    // original(기본)은 속성 없이 :root 그대로 사용 — apple/material/linear만 표시.
    if (p === "apple" || p === "material" || p === "linear") document.documentElement.setAttribute("data-palette", p);
  } catch (e) {}
})();
