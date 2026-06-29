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

// 세션 예약 폼: 녹음 종류 게이트 + 시작 슬롯 가용성 + 소요시간 슬라이더(30분·최대 12시간, 1Pro/2Pro/직접입력 프리셋) + 예상 종료.
(function () {
  "use strict";
  var form = document.querySelector("[data-session-form]");
  if (!form) return;
  var dateInput = form.querySelector("[data-session-date]");
  var grid = form.querySelector("[data-start-grid]");
  var rateSel = form.querySelector("[data-rate-select]");
  var rateRequired = !!(rateSel && rateSel.hasAttribute("data-rate-required"));
  var startHint = form.querySelector("[data-start-hint]");
  var customStart = form.querySelector("[data-custom-start]");
  var customStartWrap = form.querySelector("[data-custom-start-wrap]");
  var customStartToggle = form.querySelector("[data-custom-start-toggle]");
  var preview = form.querySelector("[data-end-preview]");
  var slider = form.querySelector("[data-duration-slider]");
  var durLabel = form.querySelector("[data-duration-label]");
  var customInput = form.querySelector("[data-custom-hours]");
  var presets = form.querySelectorAll("[data-duration-preset]");
  var SLIDER_MAX = slider ? parseInt(slider.max, 10) || 720 : 720;
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
  // 소요시간(분): custom_hours(직접입력)가 진실원천. 슬라이더·프리셋이 이 값을 채운다.
  function durationMinutes() {
    var h = parseFloat(customInput && customInput.value);
    return h > 0 ? Math.round(h * 60) : 0;
  }
  function fmtDuration(mins) {
    if (!(mins > 0)) return "설정 안 함";
    var hh = Math.floor(mins / 60), mm = mins % 60;
    return ((hh ? hh + "시간" : "") + (mm ? (hh ? " " : "") + mm + "분" : "")) || "0분";
  }
  // 한 값을 custom_hours·슬라이더·라벨에 일괄 반영(프리셋·초기화용).
  function setDuration(mins) {
    if (!(mins > 0)) mins = 0;
    if (customInput) customInput.value = mins > 0 ? fmtHours(mins / 60) : "";
    if (slider) slider.value = Math.min(mins, SLIDER_MAX);
    refreshDuration();
  }
  function refreshDuration() {
    if (durLabel) durLabel.textContent = fmtDuration(durationMinutes());
    updatePreview();
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
  // 1Pro/2Pro 프리셋: 단가표 기준시간(base_minutes)이 있어야 활성.
  function updateProAvailability() {
    var base = baseMinutes();
    Array.prototype.forEach.call(presets, function (b) { b.disabled = base <= 0; });
  }
  function updatePreview() {
    if (!preview) return;
    var start = currentStart();
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
  if (rateSel) rateSel.addEventListener("change", function () { applyStartState(); updateProAvailability(); updatePreview(); });
  // 슬라이더 드래그(30분 단위) → custom_hours 동기화.
  if (slider) slider.addEventListener("input", function () {
    var mins = parseInt(slider.value, 10) || 0;
    if (customInput) customInput.value = mins > 0 ? fmtHours(mins / 60) : "";
    refreshDuration();
  });
  // 직접입력(시간) → 슬라이더 동기화(12시간 초과는 슬라이더 최대로 클램프, 입력값은 보존).
  if (customInput) customInput.addEventListener("input", function () {
    if (slider) slider.value = Math.min(durationMinutes(), SLIDER_MAX);
    refreshDuration();
  });
  // 1Pro/2Pro 프리셋 → 기준시간×1/×2로 슬라이더·직접입력 채움.
  Array.prototype.forEach.call(presets, function (b) {
    b.addEventListener("click", function () {
      var base = baseMinutes();
      if (base <= 0) return;
      setDuration(b.getAttribute("data-duration-preset") === "pro2" ? base * 2 : base);
    });
  });
  // 그리드 '직접입력' 버튼 → 시간 입력칸 펼치고 포커스(텍스트로 HH:MM 입력).
  if (customStartToggle) customStartToggle.addEventListener("click", function () {
    if (!startEnabled()) return;
    if (customStartWrap) customStartWrap.hidden = false;
    clearGridStart();
    if (customStart) customStart.focus();
    updatePreview();
  });
  // 직접입력 시작 시간: 숫자만 받아 HH:MM 자동 포맷("1425"→"14:25"). 입력 시 그리드 선택 해제(서버도 직접입력 우선).
  if (customStart) customStart.addEventListener("input", function () {
    var digits = customStart.value.replace(/[^0-9]/g, "").slice(0, 4);
    customStart.value = digits.length >= 3 ? digits.slice(0, 2) + ":" + digits.slice(2) : digits;
    if (customStart.value) clearGridStart();
    updatePreview();
  });
  form.addEventListener("change", function (e) {
    if (!e.target) return;
    if (e.target.name === "start_time") {
      if (customStart) customStart.value = "";
      if (customStartWrap) customStartWrap.hidden = true; // 그리드 고르면 직접입력 칸 닫기
      updatePreview();
    }
  });

  applyStartState();
  updateProAvailability();
  refreshDuration();
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

// 금액 입력 천단위 콤마: 표시용 콤마 + 제출 시 순수 숫자 복원(서버는 정수 '원'). 표시 텍스트는 formatKRW가 담당.
(function () {
  "use strict";
  var MONEY = /^(unit_price|base_price|extra_price|amount|paid_amount)$/;
  function fmt(v) {
    var d = String(v == null ? "" : v).replace(/[^\d]/g, "");
    return d ? Number(d).toLocaleString("en-US") : "";
  }
  function isMoney(el) {
    return el && el.tagName === "INPUT" && el.type !== "hidden" && MONEY.test(el.name || "");
  }
  Array.prototype.forEach.call(document.querySelectorAll("input"), function (el) {
    if (isMoney(el) && el.value) el.value = fmt(el.value);
  });
  document.addEventListener("input", function (e) {
    if (isMoney(e.target)) e.target.value = fmt(e.target.value);
  });
  // 제출 직전 콤마 제거(capture 단계에서 먼저 정리; 서버 parseWon도 방어하지만 amount 등 안전).
  document.addEventListener("submit", function (e) {
    if (!e.target || !e.target.querySelectorAll) return;
    Array.prototype.forEach.call(e.target.querySelectorAll("input"), function (el) {
      if (isMoney(el)) el.value = String(el.value).replace(/[^\d]/g, "");
    });
  }, true);
})();
