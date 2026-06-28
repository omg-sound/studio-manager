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

// 세션 예약 폼: 시작 슬롯 가용성(예약된 슬롯 비활성) + 소요시간 → 예상 종료 미리보기.
(function () {
  "use strict";
  var form = document.querySelector("[data-session-form]");
  if (!form) return;
  var dateInput = form.querySelector("[data-session-date]");
  var grid = form.querySelector("[data-start-grid]");
  var rateSel = form.querySelector("[data-rate-select]");
  var customWrap = form.querySelector("[data-custom-wrap]");
  var customInput = form.querySelector("[data-custom-hours]");
  var preview = form.querySelector("[data-end-preview]");
  var durationRadios = form.querySelectorAll("[data-duration]");

  function pad(n) { return (n < 10 ? "0" : "") + n; }
  function baseMinutes() {
    if (!rateSel) return 0;
    var o = rateSel.options[rateSel.selectedIndex];
    return o ? parseInt(o.getAttribute("data-minutes"), 10) || 0 : 0;
  }
  function checkedValue(name) {
    var r = form.querySelector('input[name="' + name + '"]:checked');
    return r ? r.value : "";
  }
  function addMin(hhmm, mins) {
    var p = String(hhmm).split(":");
    if (p.length !== 2) return "";
    var t = (parseInt(p[0], 10) * 60 + parseInt(p[1], 10) + mins) % 1440;
    if (t < 0) t += 1440;
    return pad(Math.floor(t / 60)) + ":" + pad(t % 60);
  }
  function durationMinutes() {
    var mode = checkedValue("duration_mode");
    if (mode === "pro1") return baseMinutes();
    if (mode === "pro2") return baseMinutes() * 2;
    if (mode === "custom") { var h = parseFloat(customInput && customInput.value); return h > 0 ? Math.round(h * 60) : 0; }
    return 0;
  }
  function updateProAvailability() {
    var base = baseMinutes();
    Array.prototype.forEach.call(durationRadios, function (r) {
      if (r.value === "pro1" || r.value === "pro2") {
        r.disabled = base <= 0;
        if (r.disabled && r.checked) r.checked = false;
      }
    });
  }
  function updatePreview() {
    if (customWrap) customWrap.hidden = checkedValue("duration_mode") !== "custom";
    if (!preview) return;
    var mode = checkedValue("duration_mode");
    var start = checkedValue("start_time");
    if ((mode === "pro1" || mode === "pro2") && baseMinutes() <= 0) {
      preview.textContent = "1Pro·2Pro는 단가 항목을 먼저 고르세요.";
      return;
    }
    var mins = durationMinutes();
    if (start && mins > 0) {
      var h = mins / 60;
      preview.textContent = "예상 종료: " + addMin(start, mins) + " (" + (h % 1 === 0 ? h : h.toFixed(1)) + "시간)";
    } else {
      preview.textContent = "";
    }
  }
  function refreshAvailability() {
    if (!grid || !dateInput || !dateInput.value) return;
    fetch("/sessions/availability?date=" + encodeURIComponent(dateInput.value), { headers: { Accept: "application/json" }, credentials: "same-origin" })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (data) {
        if (!data || !data.busy) return;
        var busy = {};
        data.busy.forEach(function (s) { busy[s] = true; });
        Array.prototype.forEach.call(grid.querySelectorAll("input[data-slot]"), function (inp) {
          var b = !!busy[inp.getAttribute("data-slot")];
          inp.disabled = b;
          if (b && inp.checked) inp.checked = false;
        });
        updatePreview();
      })
      .catch(function () {});
  }

  if (dateInput) dateInput.addEventListener("change", refreshAvailability);
  if (rateSel) rateSel.addEventListener("change", function () { updateProAvailability(); updatePreview(); });
  if (customInput) customInput.addEventListener("input", updatePreview);
  form.addEventListener("change", function (e) {
    if (e.target && (e.target.name === "start_time" || e.target.name === "duration_mode")) updatePreview();
  });

  updateProAvailability();
  updatePreview();
  refreshAvailability();
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
