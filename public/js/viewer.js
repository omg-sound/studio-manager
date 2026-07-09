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
      // 크기 규칙(2026-07-09 사용자 리포트 — 통장사본이 과하게 커지고 주민등록증에 검은 여백):
      // ①원본 크기 이상으로 키우지 않음(작은 스캔을 화면 92%까지 업스케일하던 것) ②상한 박스 = 높이 85%·폭 60%
      // (가로 문서가 화면을 다 먹지 않게) ③하한 360px(원본이 그보다 작으면 원본대로).
      var maxH = Math.round(ah * 0.85);
      var maxW = Math.round(aw * 0.6);
      var ih = Math.min(img.naturalHeight, maxH);
      var iw = Math.round(ih * ratio);
      if (iw > maxW) { iw = maxW; ih = Math.round(iw / ratio); } // 가로가 넘치면 폭 기준 축소
      var minSide = Math.min(360, img.naturalHeight);
      if (ih < minSide) { ih = minSide; iw = Math.round(ih * ratio); }
      var dw = Math.max(0, (window.outerWidth || 0) - (window.innerWidth || 0)); // 창 크롬(주소창 등) 보정
      var dh = Math.max(0, (window.outerHeight || 0) - (window.innerHeight || 0));
      var ow = iw + dw;
      var oh = ih + dh;
      window.resizeTo(ow, oh);
      window.moveTo((s.availLeft || 0) + aw - ow, s.availTop || 0); // 오른쪽 위 유지
    } catch (_e) { /* 팝업이 아니거나 브라우저가 거부하면 그대로 표시(object-contain 폴백) */ }
  }
  function fitRetry() { fit(); setTimeout(fit, 250); } // 창 크롬 치수가 초기엔 0일 수 있어 1회 재시도(리사이즈 무시 환경 보정)
  if (img.complete && img.naturalWidth) fitRetry();
  else img.addEventListener("load", fitRetry);
})();
