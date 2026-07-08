"use strict";
// 첨부 이미지 뷰어(팝업 전용, 2026-07-08) — 이미지 로드 후 실제 비율에 맞춰 팝업 창 크기를 스스로 조정.
// 오프너(app.js data-popup-view)는 A4 근사 세로창으로 열고, 여기서 naturalWidth/Height로 정확히 맞춰
// 여백(레터박스) 없이 이미지가 창을 꽉 채우게 한다. resizeTo/moveTo는 스크립트로 연 팝업에서만 동작(일반 탭이면 무시됨).
(function () {
  var img = document.querySelector("[data-viewer-img]");
  if (!img) return;
  function fit() {
    try {
      if (!img.naturalWidth || !img.naturalHeight) return;
      var s = window.screen || {};
      var aw = s.availWidth || s.width || 1280;
      var ah = s.availHeight || s.height || 800;
      var ratio = img.naturalWidth / img.naturalHeight;
      var ih = Math.round(ah * 0.92); // 목표 내부 높이 = 화면 92%
      var iw = Math.round(ih * ratio);
      var maxW = Math.round(aw * 0.9);
      if (iw > maxW) { iw = maxW; ih = Math.round(iw / ratio); } // 가로가 넘치면 폭 기준 축소
      var dw = Math.max(0, (window.outerWidth || 0) - (window.innerWidth || 0)); // 창 크롬(주소창 등) 보정
      var dh = Math.max(0, (window.outerHeight || 0) - (window.innerHeight || 0));
      var ow = iw + dw;
      var oh = ih + dh;
      window.resizeTo(ow, oh);
      window.moveTo((s.availLeft || 0) + aw - ow, s.availTop || 0); // 오른쪽 위 유지
    } catch (_e) { /* 팝업이 아니거나 브라우저가 거부하면 그대로 표시(object-contain 폴백) */ }
  }
  if (img.complete && img.naturalWidth) fit();
  else img.addEventListener("load", fit);
})();
