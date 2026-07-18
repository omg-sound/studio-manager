/* 테마 조기 적용(FOUC 방지) — <head>에서 CSS보다 먼저 동기 실행(defer 아님).
   저장된 data-theme(light/dark)·data-palette(claude/apple/linear)를 <html>에 즉시 세팅
   → 스타일시트가 그 속성 기준으로 렌더돼 새로고침 시 깜빡임 없음. CSP script-src 'self' 준수(외부 파일). */
(function () {
  try {
    // 기본 테마 = 라이트(미선택 사용자도 라이트 고정, 2026-07-18 사용자 요청). 저장값이 있으면 그대로.
    var t = localStorage.getItem("theme");
    document.documentElement.setAttribute("data-theme", t === "dark" ? "dark" : "light");
    // 기본 팔레트 = Linear(미선택 사용자도 Linear, 2026-07-18). claude(기본 :root)는 속성 없이 사용.
    var p = localStorage.getItem("palette");
    if (p === "apple" || p === "linear") document.documentElement.setAttribute("data-palette", p);
    else if (p !== "claude") document.documentElement.setAttribute("data-palette", "linear");
  } catch (e) {}
})();
