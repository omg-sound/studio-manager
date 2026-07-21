/* 테마 조기 적용(FOUC 방지) — <head>에서 CSS보다 먼저 동기 실행(defer 아님).
   저장된 data-theme(light/dark)·data-palette(claude/apple/linear/spotify/pinterest)를 <html>에 즉시 세팅
   → 스타일시트가 그 속성 기준으로 렌더돼 새로고침 시 깜빡임 없음. CSP script-src 'self' 준수(외부 파일). */
(function () {
  try {
    // 테마(라이트/다크)는 OS 설정 추종(2026-07-18 사용자 요청) — 저장값 있으면 그대로, 없으면 로드 시점 OS 설정을 스냅샷해 data-theme로 세팅.
    // (팔레트 다크 변형이 [data-theme="dark"] 속성으로 게이트돼 있어, 속성을 안 걸면 base media 다크가 팔레트 라이트에 밀려 OS 다크가 무시됐다 — 2026-07-19 전수 점검 수정.)
    var t = localStorage.getItem("theme");
    if (t !== "dark" && t !== "light") {
      try { t = window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light"; } catch (e) { t = null; }
    }
    if (t === "dark" || t === "light") document.documentElement.setAttribute("data-theme", t);
    // 기본 팔레트 = Linear(미선택 사용자도 Linear, 2026-07-18). claude(기본 :root)는 속성 없이 사용.
    // ⚠️ 서버가 `<html>`에 data-theme·data-palette를 쿠키 기준으로 먼저 렌더한다(FOUC 방지, 2026-07-21) — 그래서 여기서
    //    claude는 **속성을 지워** :root로 되돌리고, 미선택/기타는 linear로 확정한다(서버값과 같아 전환 없음).
    var p = localStorage.getItem("palette");
    if (p === "apple" || p === "linear" || p === "spotify" || p === "pinterest") document.documentElement.setAttribute("data-palette", p);
    else if (p === "claude") document.documentElement.removeAttribute("data-palette");
    else { document.documentElement.setAttribute("data-palette", "linear"); p = "linear"; }
    // 쿠키에 기록 → **다음 페이지부터 서버가 <html>에 첫 페인트로 렌더**(FOUC 방지). 기존 localStorage 사용자도 쿠키 없이 들어와 여기서 맞춰진다.
    // theme 쿠키는 명시 선택(또는 OS 스냅샷) t가 있을 때만. path=/ · 1년 · lax.
    try {
      if (t === "dark" || t === "light") document.cookie = "theme=" + t + "; path=/; max-age=31536000; samesite=lax";
      document.cookie = "palette=" + p + "; path=/; max-age=31536000; samesite=lax";
    } catch (e) {}
  } catch (e) {}
})();
