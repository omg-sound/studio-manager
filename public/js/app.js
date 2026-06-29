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

// 세션 예약 폼: 녹음 종류 게이트 + 시작 슬롯 가용성 + 소요시간(1Pro/2Pro→직접입력 채움) + 예상 종료.
(function () {
  "use strict";
  var form = document.querySelector("[data-session-form]");
  if (!form) return;
  var dateInput = form.querySelector("[data-session-date]");
  var grid = form.querySelector("[data-start-grid]");
  var rateSel = form.querySelector("[data-rate-select]");
  var rateRequired = !!(rateSel && rateSel.hasAttribute("data-rate-required"));
  var startHint = form.querySelector("[data-start-hint]");
  var customWrap = form.querySelector("[data-custom-wrap]");
  var customInput = form.querySelector("[data-custom-hours]");
  var customStart = form.querySelector("[data-custom-start]");
  var customStartWrap = form.querySelector("[data-custom-start-wrap]");
  var customStartToggle = form.querySelector("[data-custom-start-toggle]");
  var preview = form.querySelector("[data-end-preview]");
  var durationRadios = form.querySelectorAll("[data-duration]");
  var busy = {};

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
  // 녹음 종류 필수: 선택돼야 시작 시간 입력 가능(녹음 세션만 게이트).
  function startEnabled() { return !rateRequired || !!(rateSel && rateSel.value); }
  function currentStart() {
    if (customStart && customStart.value) return customStart.value;
    return checkedValue("start_time");
  }
  function clearGridStart() {
    if (!grid) return;
    Array.prototype.forEach.call(grid.querySelectorAll('input[name="start_time"]'), function (r) { r.checked = false; });
  }
  function addMin(hhmm, mins) {
    var p = String(hhmm).split(":");
    if (p.length !== 2) return "";
    var t = (parseInt(p[0], 10) * 60 + parseInt(p[1], 10) + mins) % 1440;
    if (t < 0) t += 1440;
    return pad(Math.floor(t / 60)) + ":" + pad(t % 60);
  }
  function fmtHours(h) { return h % 1 === 0 ? String(h) : h.toFixed(1); }
  function durationMinutes() {
    var mode = checkedValue("duration_mode");
    if (mode === "pro1") return baseMinutes();
    if (mode === "pro2") return baseMinutes() * 2;
    if (mode === "custom") { var h = parseFloat(customInput && customInput.value); return h > 0 ? Math.round(h * 60) : 0; }
    return 0;
  }
  // 시작 시간 활성/비활성: 녹음 종류 게이트 + 예약된(busy) 슬롯.
  function applyStartState() {
    var ok = startEnabled();
    if (grid) Array.prototype.forEach.call(grid.querySelectorAll("input[data-slot]"), function (inp) {
      var dis = !ok || !!busy[inp.getAttribute("data-slot")];
      inp.disabled = dis;
      if (dis && inp.checked) inp.checked = false;
    });
    if (customStartToggle) customStartToggle.disabled = !ok;
    if (customStart) customStart.disabled = !ok;
    if (!ok) {
      clearGridStart();
      if (customStart) customStart.value = "";
      if (customStartWrap) customStartWrap.hidden = true;
    }
    if (startHint) startHint.textContent = ok ? "" : " · 녹음 종류를 먼저 선택하세요";
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
  // 소요시간 표시: 소요시간을 고르면 직접입력 칸을 보이게, 1Pro/2Pro면 시간 자동 채움(확인·수정 가능).
  function syncDuration() {
    var mode = checkedValue("duration_mode");
    if (customWrap) customWrap.hidden = !mode;
    if ((mode === "pro1" || mode === "pro2") && customInput) {
      var mins = mode === "pro2" ? baseMinutes() * 2 : baseMinutes();
      customInput.value = mins > 0 ? fmtHours(mins / 60) : "";
    }
  }
  function updatePreview() {
    if (!preview) return;
    var mode = checkedValue("duration_mode");
    var start = currentStart();
    if ((mode === "pro1" || mode === "pro2") && baseMinutes() <= 0) {
      preview.textContent = "1Pro·2Pro는 녹음 종류를 먼저 고르세요.";
      return;
    }
    var mins = durationMinutes();
    if (start && mins > 0) {
      preview.textContent = "예상 종료: " + addMin(start, mins) + " (" + fmtHours(mins / 60) + "시간)";
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
        busy = {};
        data.busy.forEach(function (s) { busy[s] = true; });
        applyStartState();
        updatePreview();
      })
      .catch(function () {});
  }

  if (dateInput) dateInput.addEventListener("change", refreshAvailability);
  if (rateSel) rateSel.addEventListener("change", function () { applyStartState(); updateProAvailability(); syncDuration(); updatePreview(); });
  // 직접입력(소요시간) 수동 편집 → custom 모드로 전환(편집값이 적용되게).
  if (customInput) customInput.addEventListener("input", function () {
    var c = form.querySelector('input[name="duration_mode"][value="custom"]');
    if (c && !c.checked) c.checked = true;
    updatePreview();
  });
  // 그리드 '직접입력' 버튼 → 시간 입력칸 펼치고 네이티브 시간 선택기 바로 열기.
  if (customStartToggle) customStartToggle.addEventListener("click", function () {
    if (!startEnabled()) return;
    if (customStartWrap) customStartWrap.hidden = false;
    clearGridStart();
    if (customStart) { customStart.focus(); try { customStart.showPicker(); } catch (e) {} }
    updatePreview();
  });
  // 직접입력 시작 ↔ 그리드 시작은 상호 배타: 직접입력하면 그리드 선택 해제(서버도 직접입력 우선).
  if (customStart) customStart.addEventListener("input", function () { if (customStart.value) clearGridStart(); updatePreview(); });
  form.addEventListener("change", function (e) {
    if (!e.target) return;
    if (e.target.name === "start_time") {
      if (customStart) customStart.value = "";
      if (customStartWrap) customStartWrap.hidden = true; // 그리드 고르면 직접입력 칸 닫기
      updatePreview();
    } else if (e.target.name === "duration_mode") { syncDuration(); updatePreview(); }
  });

  applyStartState();
  updateProAvailability();
  syncDuration();
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
