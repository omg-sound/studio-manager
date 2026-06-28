// 최소 클라이언트 인터랙션: 모바일 드로어 토글.
(function () {
  "use strict";
  var toggle = document.getElementById("navToggle");
  var sidebar = document.getElementById("sidebar");
  var backdrop = document.getElementById("backdrop");
  if (!toggle || !sidebar || !backdrop) return;

  function open() {
    sidebar.classList.remove("hidden");
    sidebar.classList.add("block");
    backdrop.classList.remove("hidden");
  }
  function close() {
    sidebar.classList.add("hidden");
    sidebar.classList.remove("block");
    backdrop.classList.add("hidden");
  }
  toggle.addEventListener("click", function () {
    if (sidebar.classList.contains("hidden")) open();
    else close();
  });
  backdrop.addEventListener("click", close);
})();

// 복사 버튼([data-copy]) + 삭제 확인([data-confirm]) + 자동 제출([data-autosubmit]).
(function () {
  "use strict";
  document.addEventListener("change", function (e) {
    var field = e.target.closest && e.target.closest("[data-autosubmit]");
    if (field && field.form) field.form.submit();
  });

  document.addEventListener("click", function (e) {
    var btn = e.target.closest && e.target.closest("[data-copy]");
    if (!btn) return;
    var text = btn.getAttribute("data-copy");
    function flash() {
      var old = btn.textContent;
      btn.textContent = "복사됨";
      setTimeout(function () {
        btn.textContent = old;
      }, 1200);
    }
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(flash, function () {});
    } else {
      var t = document.createElement("textarea");
      t.value = text;
      document.body.appendChild(t);
      t.select();
      try {
        document.execCommand("copy");
        flash();
      } catch (err) {}
      document.body.removeChild(t);
    }
  });

  document.addEventListener("submit", function (e) {
    var msg = e.target.getAttribute && e.target.getAttribute("data-confirm");
    if (msg && !window.confirm(msg)) e.preventDefault();
  });
})();

// 저장 플래시 배너([data-flash]): URL에서 flash 파라미터 제거 + 2.5초 후 페이드아웃.
(function () {
  "use strict";
  var flash = document.querySelector("[data-flash]");
  if (!flash) return;
  try {
    if (window.history && window.history.replaceState) {
      var url = new URL(window.location.href);
      if (url.searchParams.has("flash")) {
        url.searchParams.delete("flash");
        window.history.replaceState(null, "", url.pathname + url.search + url.hash);
      }
    }
  } catch (err) {}
  setTimeout(function () {
    flash.style.transition = "opacity .4s";
    flash.style.opacity = "0";
    setTimeout(function () {
      if (flash.parentNode) flash.parentNode.removeChild(flash);
    }, 400);
  }, 2500);
})();
