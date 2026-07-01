// 최소 클라이언트 인터랙션: 모바일 드로어 토글 + aria-expanded + 닫기 버튼.
(function () {
  "use strict";
  var toggle = document.getElementById("navToggle");
  var sidebar = document.getElementById("sidebar");
  var backdrop = document.getElementById("backdrop");
  var drawerClose = document.getElementById("navDrawerClose");
  if (!toggle || !sidebar || !backdrop) return;

  function open() {
    sidebar.classList.remove("hidden");
    sidebar.classList.add("block");
    backdrop.classList.remove("hidden");
    toggle.setAttribute("aria-expanded", "true");
  }
  function close() {
    sidebar.classList.add("hidden");
    sidebar.classList.remove("block");
    backdrop.classList.add("hidden");
    toggle.setAttribute("aria-expanded", "false");
  }
  toggle.addEventListener("click", function () {
    if (sidebar.classList.contains("hidden")) open();
    else close();
  });
  backdrop.addEventListener("click", close);
  if (drawerClose) drawerClose.addEventListener("click", close);
})();

// 테마 토글([data-theme-toggle]): 라이트↔다크 + localStorage["theme"] 저장.
// 로드 시 저장값 복원(없으면 OS 추종 = data-theme 속성 미설정).
// CSS 분기는 :root[data-theme="dark"] 선택자로 처리(src.css 레인).
(function () {
  "use strict";
  var saved = "";
  try { saved = localStorage.getItem("theme") || ""; } catch (e) {}
  if (saved === "dark" || saved === "light") {
    document.documentElement.setAttribute("data-theme", saved);
  }
  // 토글 라벨([data-theme-label])을 '누르면 갈 방향'으로 갱신: 현재 dark면 "라이트 모드", 아니면(라이트·미설정) "다크 모드".
  function syncThemeLabel(mode) {
    var text = mode === "dark" ? "라이트 모드" : "다크 모드";
    Array.prototype.forEach.call(document.querySelectorAll("[data-theme-label]"), function (el) {
      el.textContent = text;
    });
  }
  document.addEventListener("click", function (e) {
    var btn = e.target.closest && e.target.closest("[data-theme-toggle]");
    if (!btn) return;
    var current = document.documentElement.getAttribute("data-theme");
    var next = current === "dark" ? "light" : "dark";
    document.documentElement.setAttribute("data-theme", next);
    try { localStorage.setItem("theme", next); } catch (e) {}
    syncThemeLabel(next);
  });
  syncThemeLabel(document.documentElement.getAttribute("data-theme")); // 초기 로드 시 현재값 기준 1회 동기화
})();

// 복사 버튼([data-copy]) + 삭제 확인([data-confirm]) + 자동 제출([data-autosubmit]).
(function () {
  "use strict";
  document.addEventListener("change", function (e) {
    var field = e.target.closest && e.target.closest("[data-autosubmit]");
    if (field && field.form) { if (field.form.requestSubmit) field.form.requestSubmit(); else field.form.submit(); } // requestSubmit: submit 이벤트 발화(콤마정리·드래프트 핸들러 동작)
  });

  document.addEventListener("click", function (e) {
    var btn = e.target.closest && e.target.closest("[data-copy]");
    if (!btn) return;
    var text = btn.getAttribute("data-copy");
    var orig = btn.textContent;
    function flash() {
      btn.textContent = "복사됨";
      setTimeout(function () { btn.textContent = orig; }, 1200);
    }
    function legacyCopy() {
      var t = document.createElement("textarea");
      t.value = text;
      t.style.position = "fixed";
      t.style.opacity = "0";
      document.body.appendChild(t);
      t.select();
      var ok = false;
      try { ok = document.execCommand("copy"); } catch (err) {}
      document.body.removeChild(t);
      if (ok) flash();
      else { btn.textContent = "복사 실패"; setTimeout(function () { btn.textContent = orig; }, 1500); }
    }
    if (navigator.clipboard && navigator.clipboard.writeText) {
      // async clipboard 실패(권한·비보안 컨텍스트) 시 조용히 넘어가지 않고 레거시 복사로 폴백.
      navigator.clipboard.writeText(text).then(flash, legacyCopy);
    } else {
      legacyCopy();
    }
  });

  document.addEventListener("submit", function (e) {
    var msg = e.target.getAttribute && e.target.getAttribute("data-confirm");
    if (msg && !window.confirm(msg)) e.preventDefault();
  });
})();

// 세션 예약 폼: 세션 종류→녹음 종류 조건부 표시 + 시작 슬롯 가용성 + 소요시간 슬라이더(30분·최대 12시간, 1Pro/2Pro/직접입력 프리셋) + 예상 종료.
(function () {
  "use strict";
  // 추가 폼 + 각 세션 편집 폼이 모두 동일 인터랙션(그리드·슬라이더·가용성)을 갖도록 폼별로 초기화.
  Array.prototype.forEach.call(document.querySelectorAll("[data-session-form]"), initSessionForm);

  function initSessionForm(form) {
  var dateInput = form.querySelector("[data-session-date]");
  var grid = form.querySelector("[data-start-grid]");
  var rateSel = form.querySelector("[data-rate-select]");
  var customStart = form.querySelector("[data-custom-start]");
  var customStartToggle = form.querySelector("[data-custom-start-toggle]");
  var preview = form.querySelector("[data-end-preview]");
  var slider = form.querySelector("[data-duration-slider]");
  var durLabel = form.querySelector("[data-duration-label]");
  var customInput = form.querySelector("[data-custom-hours]");
  var presets = form.querySelectorAll("[data-duration-preset]");
  var sessionTypeSel = form.querySelector('select[name="session_type"]');
  var roomSel = form.querySelector('select[name="room_id"]');
  var showWhenRec = form.querySelectorAll('[data-show-when="rec"]');
  var SLIDER_MAX = slider ? parseInt(slider.max, 10) || 840 : 840;
  var busy = {};

  var durGroup = form.querySelector("[data-duration-group]");
  function pad(n) { return (n < 10 ? "0" : "") + n; }
  // 1Pro/2Pro 버튼 기준시간 = 녹음 단가 항목 기준시간(rateSel data-minutes). 버튼은 녹음일 때만 노출.
  function baseMinutes() {
    if (!rateSel) return 0;
    var o = rateSel.options[rateSel.selectedIndex];
    return o ? parseInt(o.getAttribute("data-minutes"), 10) || 0 : 0;
  }
  // 비녹음(믹싱 등) 슬라이더 기본 소요시간(분) — 스튜디오 설정(data-pro-default).
  function proDefaultMinutes() { return durGroup ? parseInt(durGroup.getAttribute("data-pro-default"), 10) || 0 : 0; }
  // 세션 종류별 슬라이더 기본값: 녹음=1Pro(녹음 단가 기준시간), 그 외=기본 세션 시간. 사용자가 조정해 쓴다.
  function applyTypeDefault() {
    var isRec = sessionTypeSel && sessionTypeSel.value === "녹음";
    var def = isRec ? baseMinutes() : proDefaultMinutes();
    if (def > 0) setDuration(def);
  }
  function checkedValue(name) {
    var r = form.querySelector('input[name="' + name + '"]:checked');
    return r ? r.value : "";
  }
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
  // 시작 시간 가용성: 예약된(busy) 슬롯만 비활성.
  function applyStartState() {
    if (grid) Array.prototype.forEach.call(grid.querySelectorAll("input[data-slot]"), function (inp) {
      var dis = !!busy[inp.getAttribute("data-slot")];
      inp.disabled = dis;
      if (dis && inp.checked) inp.checked = false;
    });
  }
  // 세션 종류=녹음일 때만 [data-show-when="rec"] 요소 표시(녹음 종류 select 등).
  function syncRecFields() {
    var isRec = sessionTypeSel && sessionTypeSel.value === "녹음";
    Array.prototype.forEach.call(showWhenRec, function (el) { el.hidden = !isRec; });
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
    // 편집 폼은 자기 세션을 exclude(자기 일정을 충돌로 보지 않음)하고, 선택한 룸으로 범위를 좁혀 조회(같은 룸만 충돌).
    // 둘 다 없으면(추가 폼·룸 미선택) 파라미터를 생략해 기존 동작 유지.
    var url = "/sessions/availability?date=" + encodeURIComponent(dateInput.value);
    var sid = form.getAttribute("data-session-id");
    if (sid) url += "&exclude=" + encodeURIComponent(sid);
    if (roomSel && roomSel.value) url += "&room=" + encodeURIComponent(roomSel.value);
    fetch(url, { headers: { Accept: "application/json" }, credentials: "same-origin" })
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
  if (roomSel) roomSel.addEventListener("change", refreshAvailability); // 룸 변경 시 해당 룸 기준으로 가용성 재조회(날짜 변경과 동일)
  if (rateSel) rateSel.addEventListener("change", function () { updateProAvailability(); applyTypeDefault(); updatePreview(); }); // 녹음 단가 바뀌면 슬라이더 기본=새 1Pro
  if (sessionTypeSel) sessionTypeSel.addEventListener("change", function () { syncRecFields(); updateProAvailability(); applyTypeDefault(); }); // 종류 바뀌면 단가 항목/버튼 노출 + 슬라이더 기본값(녹음=1Pro·그 외=기본시간)
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
  // 1~4Pro 프리셋 → 기준시간(1Pro)×N으로 슬라이더·직접입력 채움("pro3"→base×3).
  Array.prototype.forEach.call(presets, function (b) {
    b.addEventListener("click", function () {
      var base = baseMinutes();
      if (base <= 0) return;
      var mult = parseInt(String(b.getAttribute("data-duration-preset") || "pro1").replace("pro", ""), 10) || 1;
      setDuration(base * mult);
    });
  });
  // 그리드 '직접입력' 버튼 → 그 자리(같은 셀)를 시간 입력칸으로 교체(버튼 숨김·입력 노출·포커스).
  if (customStartToggle) customStartToggle.addEventListener("click", function () {
    customStartToggle.hidden = true;
    if (customStart) { customStart.hidden = false; customStart.focus(); }
    clearGridStart();
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
      if (customStart) { customStart.value = ""; customStart.hidden = true; } // 그리드 고르면 직접입력 칸 닫고
      if (customStartToggle) customStartToggle.hidden = false; // '직접입력' 버튼 복원
      updatePreview();
    }
  });

  applyStartState();
  updateProAvailability();
  syncRecFields();
  if (durationMinutes() === 0) applyTypeDefault(); // 새 세션(소요 미설정)이면 종류 기본값으로 시작(편집=저장값 유지)
  refreshDuration();
  refreshAvailability();
  }
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
  // 천단위 콤마 대상 금액칸: 청구 총액·입금·할인, 단가표, 외주 지급단가, 작업·세션별 청구 금액(task_amount_<id>·session_amount_<id> 동적 name).
  var MONEY = /^(unit_price|base_price|extra_price|amount|paid_amount|discount_amount|worker_rate|task_amount_\d+|session_amount_\d+)$/;
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
    if (e.submitter && e.submitter.getAttribute("formtarget") === "_blank") return; // 미리보기 PDF(새 탭) 제출은 현재 폼값을 건드리지 않음(콤마 유지)
    Array.prototype.forEach.call(e.target.querySelectorAll("input"), function (el) {
      if (isMoney(el)) el.value = String(el.value).replace(/[^\d]/g, "");
    });
  }, true);
})();

// 경고 모달([data-modal]): '확인'(data-modal-close)으로 닫고 URL의 error 파라미터를 제거.
(function () {
  "use strict";
  document.addEventListener("click", function (e) {
    var btn = e.target.closest && e.target.closest("[data-modal-close]");
    if (!btn) return;
    var modal = btn.closest("[data-modal]");
    if (modal && modal.parentNode) modal.parentNode.removeChild(modal);
    try {
      var url = new URL(window.location.href);
      if (url.searchParams.has("error")) {
        url.searchParams.delete("error");
        window.history.replaceState(null, "", url.pathname + url.search + url.hash);
      }
    } catch (err) {}
  });
})();

// 할인 폼([data-discount-form]): 정률(%) → 정액(원) 자동변환 + 공급가/할인/과세표준/VAT/총액 미리보기 갱신.
// 공급가는 체크된 항목(input[data-line-amount])의 합으로 동적 계산(항목 체크 변경 시 갱신). 체크박스가 없으면 data-supply 폴백.
(function () {
  "use strict";
  var form = document.querySelector("[data-discount-form]");
  if (!form) return;
  var amtInput = form.querySelector("[data-discount-amount]");
  var pctInput = form.querySelector("[data-discount-pct]");
  if (!amtInput || !pctInput) return;
  var boxes = form.querySelectorAll('input[type="checkbox"][data-line-amount]');
  var vatToggle = form.querySelector("[data-vat-toggle]");
  var supplyEl = form.querySelector("[data-amt-supply]");
  var discountRow = form.querySelector("[data-amt-discount-row]");
  var discountEl = form.querySelector("[data-amt-discount]");
  var vatEl = form.querySelector("[data-amt-vat]");
  var totalEl = form.querySelector("[data-amt-total]");

  function lineAmount(cb) {
    // 작업 행은 연결된 금액 input(data-line-input) 값으로, 세션 행은 고정 금액(data-line-amount)으로 합산.
    var row = cb.closest && cb.closest("[data-line-row]");
    var input = row && row.querySelector("[data-line-input]");
    if (input) return parseInt(String(input.value).replace(/[^\d]/g, "") || "0", 10) || 0;
    return parseInt(cb.getAttribute("data-line-amount") || "0", 10) || 0;
  }
  function supply() {
    if (!boxes.length) return parseInt(form.getAttribute("data-supply") || "0", 10) || 0;
    var s = 0;
    Array.prototype.forEach.call(boxes, function (cb) {
      if (cb.checked) s += lineAmount(cb);
    });
    return s;
  }
  function won(n) {
    return "₩" + String(Math.round(Number(n) || 0)).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  }
  function clamp(n) { return Math.min(Math.max(0, Math.round(n)), supply()); }

  function updatePreview() {
    var sup = supply();
    var discount = clamp(parseInt(String(amtInput.value).replace(/[^\d]/g, "") || "0", 10));
    var vatOn = !vatToggle || vatToggle.checked; // 부가세 포함 토글(기본 체크). 해제 시 VAT 0(현금).
    var taxable = sup - discount;
    var tax = vatOn ? Math.round(taxable * 0.1) : 0;
    if (supplyEl) supplyEl.textContent = won(sup);
    if (discountRow) discountRow.hidden = !(discount > 0);
    if (discountEl) discountEl.textContent = "-" + won(discount);
    if (vatEl) vatEl.textContent = won(tax);
    if (totalEl) totalEl.textContent = won(taxable + tax);
  }
  function applyPct() {
    var pct = parseFloat(pctInput.value) || 0;
    if (pct < 0) pct = 0;
    if (pct > 100) pct = 100;
    // 천단위 콤마 유지(프로그램 .value 대입은 input 이벤트가 안 떠 콤마 포맷터가 안 돎 → 직접 포맷).
    amtInput.value = clamp(Math.round(supply() * pct / 100)).toLocaleString("en-US");
    updatePreview();
  }

  amtInput.addEventListener("input", function () {
    pctInput.value = ""; // 정액 바뀌면 정률 초기화
    updatePreview();
  });
  pctInput.addEventListener("input", applyPct);
  if (vatToggle) vatToggle.addEventListener("change", updatePreview);
  Array.prototype.forEach.call(boxes, function (cb) {
    cb.addEventListener("change", function () {
      // 항목 선택이 바뀌면 공급가 변동 → 정률이면 재계산, 아니면 미리보기만 갱신(정액은 clamp).
      if (parseFloat(pctInput.value) > 0) applyPct(); else updatePreview();
    });
  });
  // 작업 금액 input(data-line-input) 변경 시 공급가·VAT·총액 즉시 갱신(금액은 청구 시 확정).
  Array.prototype.forEach.call(form.querySelectorAll("[data-line-input]"), function (inp) {
    inp.addEventListener("input", function () {
      if (parseFloat(pctInput.value) > 0) applyPct(); else updatePreview();
    });
  });
  updatePreview();
})();

// 청구 생성 폼([data-discount-form]) 항목 금액 드래프트 자동저장(localStorage) + 0원 항목 제출 확인.
// 작성 중이던 금액을 새로고침/이탈 후에도 보존, 제출 성공 시 정리. 0원 항목이 체크돼 있으면 제출 직전 확인창.
(function () {
  "use strict";
  var form = document.querySelector("[data-discount-form]");
  if (!form) return;
  var m = (form.getAttribute("action") || "").match(/\/projects\/(\d+)\//);
  var prefix = m ? "omgdraft:inv:" + m[1] + ":" : null;
  var inputs = form.querySelectorAll("[data-line-input]");
  function lineVal(cb) {
    var row = cb.closest && cb.closest("[data-line-row]");
    var inp = row && row.querySelector("[data-line-input]");
    if (inp) return parseInt(String(inp.value).replace(/[^\d]/g, "") || "0", 10) || 0;
    return parseInt(cb.getAttribute("data-line-amount") || "0", 10) || 0;
  }
  var TTL_MS = 7 * 24 * 60 * 60 * 1000; // 초안 7일 만료 — 오래 방치된 금액이 되살아나 잘못 청구되는 것 방지
  function purgeDraft() {
    if (!prefix) return;
    Array.prototype.forEach.call(inputs, function (inp) { try { localStorage.removeItem(prefix + inp.name); } catch (_e) {} });
    try { localStorage.removeItem(prefix + "__ts"); } catch (_e) {}
  }
  // 1) 드래프트 복원(+ input 디스패치로 콤마 포맷·미리보기 갱신). 단, TTL 지난 초안은 폐기하고 복원 생략.
  if (prefix) {
    var savedTs = 0;
    try { savedTs = parseInt(localStorage.getItem(prefix + "__ts") || "0", 10) || 0; } catch (e) {}
    if (savedTs && Date.now() - savedTs > TTL_MS) {
      purgeDraft();
    } else {
      Array.prototype.forEach.call(inputs, function (inp) {
        try { var v = localStorage.getItem(prefix + inp.name); if (v != null && v !== "") inp.value = v; } catch (e) {}
      });
      Array.prototype.forEach.call(inputs, function (inp) { inp.dispatchEvent(new Event("input", { bubbles: true })); });
    }
    // 2) 입력 시 저장(순수 숫자) + 타임스탬프 갱신
    form.addEventListener("input", function (e) {
      if (e.target && e.target.getAttribute && e.target.getAttribute("data-line-input") != null) {
        try { localStorage.setItem(prefix + e.target.name, String(e.target.value).replace(/[^\d]/g, "")); localStorage.setItem(prefix + "__ts", String(Date.now())); } catch (e2) {}
      }
    });
  }
  // 3) 제출: 0원 항목 확인 → 통과 시 드래프트 정리
  form.addEventListener("submit", function (e) {
    if (e.submitter && e.submitter.getAttribute("formtarget") === "_blank") return; // 미리보기 PDF 제출은 드래프트·확인 건너뜀(청구 생성만 정리)
    var hasZero = false;
    Array.prototype.forEach.call(form.querySelectorAll('input[type="checkbox"][data-line-amount]'), function (cb) {
      if (cb.checked && !(lineVal(cb) > 0)) hasZero = true;
    });
    if (hasZero && !window.confirm("금액이 0원인 청구 항목이 있습니다. 0원으로 청구할까요?")) { e.preventDefault(); return; }
    purgeDraft();
  });
})();

// 사업자등록번호 입력칸([name="biz_no"]): 숫자만 입력해도 ###-##-##### 서식 자동 삽입.
(function () {
  "use strict";
  function fmt(v) {
    var d = String(v).replace(/\D/g, "").slice(0, 10);
    if (d.length < 4) return d;
    if (d.length < 6) return d.slice(0, 3) + "-" + d.slice(3);
    return d.slice(0, 3) + "-" + d.slice(3, 5) + "-" + d.slice(5);
  }
  document.addEventListener("input", function (e) {
    if (e.target && e.target.name === "biz_no") e.target.value = fmt(e.target.value);
  });
  Array.prototype.forEach.call(document.querySelectorAll('input[name="biz_no"]'), function (el) { if (el.value) el.value = fmt(el.value); });
})();

// 휴대전화/전화 입력칸([name="phone"]): 숫자만 입력해도 010-####-#### 서식 자동 삽입(서버 formatPhone과 일치).
// 02(서울) 지역번호는 02-###-####/02-####-####, 그 외 3자리 국번은 ###-###-####(10자리)·###-####-####(11자리).
(function () {
  "use strict";
  function fmtPhone(v) {
    var d = String(v).replace(/\D/g, "");
    if (d.indexOf("02") === 0) { // 서울 지역번호(2자리 국번)
      d = d.slice(0, 10);
      if (d.length <= 2) return d;
      if (d.length <= 5) return d.slice(0, 2) + "-" + d.slice(2);
      if (d.length <= 9) return d.slice(0, 2) + "-" + d.slice(2, d.length - 4) + "-" + d.slice(d.length - 4);
      return d.slice(0, 2) + "-" + d.slice(2, 6) + "-" + d.slice(6);
    }
    d = d.slice(0, 11); // 휴대폰/그 외(3자리 국번)
    if (d.length < 4) return d;
    if (d.length < 7) return d.slice(0, 3) + "-" + d.slice(3);
    if (d.length <= 10) return d.slice(0, 3) + "-" + d.slice(3, 6) + "-" + d.slice(6); // 10자리: 3-3-4
    return d.slice(0, 3) + "-" + d.slice(3, 7) + "-" + d.slice(7); // 11자리: 3-4-4
  }
  document.addEventListener("input", function (e) {
    if (e.target && e.target.name === "phone") e.target.value = fmtPhone(e.target.value);
  });
  Array.prototype.forEach.call(document.querySelectorAll('input[name="phone"]'), function (el) { if (el.value) el.value = fmtPhone(el.value); });
})();

// 청구 폼 작업 금액 즉시 저장: task_amount_<id> 변경(포커스 이탈) 시 해당 작업 total_price에 바로 반영(초안 아님 → 목록·기본값 반영).
(function () {
  "use strict";
  document.addEventListener("change", function (e) {
    var el = e.target;
    if (!el || !el.name) return;
    var m = /^task_amount_(\d+)$/.exec(el.name);
    if (!m) return;
    var body = new URLSearchParams();
    body.append("amount", String(el.value).replace(/[^\d]/g, ""));
    fetch("/projects/tasks/" + m[1] + "/amount", { method: "POST", body: body, headers: { "X-Requested-With": "fetch" }, credentials: "same-origin" }).catch(function () {});
  });
})();

// 클라이언트 폼: 아티스트(개인)는 사업자등록번호·대표자·주소가 없으므로 분류=아티스트면 세금정보 숨김.
(function () {
  "use strict";
  var kindSel = document.querySelector("[data-client-kind]");
  var tax = document.querySelector("[data-client-tax]");
  var cash = document.querySelector("[data-client-cash]"); // 개인(아티스트)=현금영수증·소속그룹(세금정보와 반대로 표시)
  var filesBox = document.querySelector("[data-client-files]"); // 아티스트는 첨부 서류(사업자등록증·통장사본) 불필요 → 숨김
  if (!kindSel || !tax) return;
  function sync() {
    var isArtist = kindSel.value === "아티스트";
    tax.hidden = isArtist;
    if (cash) cash.hidden = !isArtist;
    if (filesBox) filesBox.hidden = isArtist;
  }
  kindSel.addEventListener("change", sync);
  sync();
})();

// 검색형 콤보박스(실결제자·클라이언트/세션 디렉터 담당자): <input list> 검색값 ↔ hidden id 동기화. 목록 라벨과 정확히 일치할 때만 id 설정.
// 위임(delegation)으로 처리 → 동적으로 추가되는 행(세션 디렉터 '+추가')도 자동 동작.
(function () {
  "use strict";
  function syncCombo(wrap) {
    var search = wrap.querySelector("[data-client-search], [data-contact-search]");
    var hidden = wrap.querySelector("[data-client-id], [data-contact-id]");
    var listEl = search ? document.getElementById(search.getAttribute("list")) : null;
    var info = wrap.querySelector("[data-contact-info]"); // 고객측 담당자 콤보에만(전화·이메일·소속 표시)
    var payerContact = wrap.querySelector("[data-payer-contact-id]"); // 청구처 콤보에만
    if (!search || !hidden || !listEl) return;
    var v = search.value.trim();
    var id = "", contactId = "", matched = null;
    for (var i = 0; i < listEl.options.length; i++) {
      if (listEl.options[i].value === v) { matched = listEl.options[i]; id = matched.getAttribute("data-id") || ""; contactId = matched.getAttribute("data-contact-id") || ""; break; }
    }
    hidden.value = id;
    if (payerContact) payerContact.value = contactId;
    if (info) {
      while (info.firstChild) info.removeChild(info.firstChild); // CSP-safe
      if (matched) {
        var ph = matched.getAttribute("data-phone"), em = matched.getAttribute("data-email"), cl = matched.getAttribute("data-client");
        var nodes = [];
        if (ph) { var an = document.createElement("a"); an.href = "tel:" + ph.replace(/[^0-9+]/g, ""); an.textContent = "☎ " + ph; an.className = "font-medium text-info"; nodes.push(an); }
        if (em) { var ae = document.createElement("a"); ae.href = "mailto:" + em; ae.textContent = "✉ " + em; ae.className = "text-info"; nodes.push(ae); }
        if (cl) { var sp = document.createElement("span"); sp.textContent = "소속: " + cl; nodes.push(sp); }
        nodes.forEach(function (node, idx) { if (idx > 0) info.appendChild(document.createTextNode("   ·   ")); info.appendChild(node); });
        info.classList.toggle("hidden", nodes.length === 0);
      } else if (v) { info.textContent = "목록에 없는 이름 — 저장 시 새 연락처로 등록됩니다."; info.classList.remove("hidden"); }
      else { info.classList.add("hidden"); }
    }
  }
  function comboOf(el) { return el && el.closest ? el.closest("[data-client-combo], [data-contact-combo]") : null; }
  function isSearch(el) { return el && el.matches && el.matches("[data-client-search], [data-contact-search]"); }
  document.addEventListener("input", function (e) { if (isSearch(e.target)) { var w = comboOf(e.target); if (w) syncCombo(w); } });
  document.addEventListener("change", function (e) { if (isSearch(e.target)) { var w = comboOf(e.target); if (w) syncCombo(w); } });
  document.addEventListener("blur", function (e) { if (isSearch(e.target)) { var w = comboOf(e.target); if (w) syncCombo(w); } }, true); // blur는 캡처
  Array.prototype.forEach.call(document.querySelectorAll("[data-client-combo], [data-contact-combo]"), syncCombo); // 초기값 표시
})();

// 세션 담당 디렉터 반복 입력([data-director-list]): '+ 디렉터 추가'로 행 복제(template), '✕'로 제거.
(function () {
  "use strict";
  document.addEventListener("click", function (e) {
    // 안정 앵커: [data-director-wrap] 기준으로 list·template를 찾음(마크업 중첩이 바뀌어도 안전).
    var addBtn = e.target.closest && e.target.closest("[data-director-add]");
    if (addBtn) {
      var wrap = addBtn.closest("[data-director-wrap]");
      var list = wrap && wrap.querySelector("[data-director-list]");
      var tpl = wrap && wrap.querySelector("[data-director-template]");
      if (list && tpl && tpl.content) { list.appendChild(tpl.content.cloneNode(true)); var last = list.lastElementChild; var inp = last && last.querySelector("[data-contact-search]"); if (inp) inp.focus(); }
      return;
    }
    var rmBtn = e.target.closest && e.target.closest("[data-director-remove]");
    if (rmBtn) {
      var wrap2 = rmBtn.closest("[data-director-wrap]");
      var list2 = wrap2 && wrap2.querySelector("[data-director-list]");
      var row = rmBtn.closest("[data-director-row]");
      if (row && row.parentNode) row.parentNode.removeChild(row);
      // 마지막 행까지 지우면 빈 행 하나 남겨 계속 추가 가능하게
      if (list2 && !list2.querySelector("[data-director-row]")) {
        var t = wrap2.querySelector("[data-director-template]");
        if (t && t.content) list2.appendChild(t.content.cloneNode(true));
      }
    }
  });
})();

// 곡·콘텐츠 작업 폼: 담당 엔지니어가 외주(data-external=1)일 때만 외주 지급단가 표시(하우스 엔지니어는 숨김).
// (작업 폼은 이제 [data-dirty-form] — engineer_id+worker-rate가 있는 폼만 처리하고 나머지는 가드로 무시.)
(function () {
  "use strict";
  var forms = document.querySelectorAll("[data-dirty-form]");
  Array.prototype.forEach.call(forms, function (form) {
    var sel = form.querySelector('select[name="engineer_id"]');
    var wrap = form.querySelector("[data-worker-rate]");
    if (!sel || !wrap) return;
    function toggle() {
      var opt = sel.options[sel.selectedIndex];
      var external = opt && opt.getAttribute("data-external") === "1";
      wrap.classList.toggle("hidden", !external);
    }
    sel.addEventListener("change", toggle);
    toggle();
  });
})();

// 저장 폼 공통([data-dirty-form] + [data-dirty-save]): 변경이 없으면 저장 버튼이 흐리게(비활성),
// 변경이 생기면 강조(하이라이트 링)로 저장을 유도. [data-dirty-hint]가 있으면 '저장되지 않은 변경사항' 표시.
// form.elements를 스냅샷 비교 → form= 속성으로 폼 밖에 연결된 컨트롤(작업 헤더 상태 select 등)도 감지.
// 문서 위임(document)으로 처리 → 폼 밖 연결 컨트롤의 이벤트도 잡는다.
(function () {
  "use strict";
  var HILITE = ["ring-2", "ring-primary", "ring-offset-2"];
  var recs = [];
  function snapshot(form) {
    var p = [];
    Array.prototype.forEach.call(form.elements, function (el) {
      if (!el.name) return;
      var t = el.type;
      if (t === "submit" || t === "button" || t === "reset") return;
      if (t === "checkbox" || t === "radio") { if (el.checked) p.push(el.name + "\x1f" + el.value); }
      else p.push(el.name + "\x1f" + el.value);
    });
    return p.join("\x1e");
  }
  function refresh(rec) {
    var dirty = snapshot(rec.form) !== rec.initial;
    rec.btn.disabled = !dirty;
    rec.btn.classList.toggle("opacity-40", !dirty);
    HILITE.forEach(function (c) { rec.btn.classList.toggle(c, dirty); });
    if (rec.hint) rec.hint.hidden = !dirty;
  }
  Array.prototype.forEach.call(document.querySelectorAll("[data-dirty-form]"), function (form) {
    var btn = form.querySelector("[data-dirty-save]");
    if (!btn) return;
    var rec = { form: form, btn: btn, hint: form.querySelector("[data-dirty-hint]"), initial: snapshot(form) };
    recs.push(rec);
    // 슬라이더/프리셋/콤보 등 다른 init이 값을 세팅한 뒤로 기준 스냅샷을 다시 잡는다(로드 직후 오탐 방지).
    setTimeout(function () { rec.initial = snapshot(form); refresh(rec); }, 0);
    refresh(rec);
  });
  function recOf(el) { var f = el && el.form; if (!f) return null; for (var i = 0; i < recs.length; i++) if (recs[i].form === f) return recs[i]; return null; }
  function onEvt(e) {
    var r = recOf(e.target);
    if (!r) return;
    refresh(r);
    setTimeout(function () { refresh(r); }, 0); // 콤보 hidden id 등 비동기 갱신 반영
  }
  document.addEventListener("input", onEvt);
  document.addEventListener("change", onEvt);
})();

// 헤더 상태 select 등 [data-no-toggle] 요소를 클릭/조작해도 <details> 펼침이 토글되지 않게(접힌 채 상태 수정).
(function () {
  "use strict";
  function guard(e) { if (e.target.closest && e.target.closest("[data-no-toggle]")) e.preventDefault(); }
  document.addEventListener("click", guard); // 클릭의 기본동작(summary 토글) 취소 — select 드롭다운은 mousedown이라 영향 없음
})();

// 드롭존([data-dropzone]): 파일 끌어놓기 또는 클릭 선택. CSP-safe(인라인 0, 외부 JS 파일).
// [data-dropzone] 클릭 → 내부 input[type=file].click(). dragover/drop → input.files 할당 + 파일명 표시.
(function () {
  "use strict";
  Array.prototype.forEach.call(document.querySelectorAll("[data-dropzone]"), function (zone) {
    var input = zone.querySelector('input[type="file"]');
    if (!input) return;
    var label = zone.querySelector("[data-dropzone-label]");
    var display = zone.querySelector("[data-dropzone-display]");

    // 클릭 시 파일 선택 대화상자 열기(input 자체 클릭은 무시)
    zone.addEventListener("click", function (e) {
      if (e.target === input) return;
      input.click();
    });

    // 드래그 시 시각적 하이라이트
    function highlight(on) {
      if (display) display.style.boxShadow = on ? "0 0 0 2px var(--color-primary, currentColor)" : "";
    }
    // 파일 선택/드롭 즉시 업로드 폼 자동 제출(별도 '업로드' 클릭 불필요 — 자동 저장). requestSubmit 미지원 시 submit 폴백.
    function autoSubmit() {
      var form = zone.closest("form");
      if (!form || !(input.files && input.files.length)) return;
      if (label) label.textContent = (input.files[0].name || "") + " · 업로드 중…";
      if (form.requestSubmit) form.requestSubmit(); else form.submit();
    }
    zone.addEventListener("dragover", function (e) { e.preventDefault(); highlight(true); });
    zone.addEventListener("dragenter", function (e) { e.preventDefault(); highlight(true); });
    zone.addEventListener("dragleave", function () { highlight(false); });

    // 드롭: input.files에 할당 + 파일명 표시(DataTransfer API, 현대 브라우저) + 자동 업로드
    zone.addEventListener("drop", function (e) {
      e.preventDefault();
      highlight(false);
      var droppedFiles = e.dataTransfer && e.dataTransfer.files;
      if (!droppedFiles || !droppedFiles.length) return;
      try {
        var dt = new DataTransfer();
        dt.items.add(droppedFiles[0]);
        input.files = dt.files;
      } catch (_e) { /* DataTransfer 미지원 환경에서는 파일명 표시만 */ }
      if (label) label.textContent = droppedFiles[0].name;
      autoSubmit(); // 드롭 즉시 업로드
    });

    // 파일 선택(클릭) 후 파일명 표시 + 자동 업로드
    input.addEventListener("change", function () {
      if (input.files && input.files[0]) {
        if (label) label.textContent = input.files[0].name;
        autoSubmit();
      }
    });
  });
})();

// 프로젝트 청구 탭 펼침 복귀(?open=ID): 입금·상태 처리 후 그 인보이스 행으로 스크롤(서버가 details를 open으로 렌더).
(function () {
  "use strict";
  var m = (location.search || "").match(/[?&]open=(\d+)/);
  if (!m) return;
  var el = document.getElementById("inv-" + m[1]);
  if (!el || !el.scrollIntoView) return;
  // 레이아웃 안정(폰트·이미지 로드) 후 중앙 정렬 스크롤.
  setTimeout(function () { el.scrollIntoView({ block: "center" }); }, 60);
})();

// 청구 수정/수동 생성 폼([data-vat-amount-form]): 부가세 포함 토글 시 총액(amount)에 VAT 가감.
// 포함=공급가×1.1(VAT 더함), 해제=÷1.1(총액에서 VAT 제거) → 부가세 토글이 총액에 즉시 반영(서버 저장도 일치).
(function () {
  "use strict";
  Array.prototype.forEach.call(document.querySelectorAll("[data-vat-amount-form]"), function (form) {
    var vat = form.querySelector('input[name="vat_included"]');
    var amount = form.querySelector('input[name="amount"]');
    if (!vat || !amount) return;
    vat.addEventListener("change", function () {
      var v = parseInt(String(amount.value).replace(/[^\d]/g, "") || "0", 10) || 0;
      if (!v) return;
      // 천단위 콤마 유지(프로그램 .value 대입은 input 이벤트가 안 떠 콤마 포맷터가 안 돎 → 직접 포맷).
      amount.value = (vat.checked ? Math.round(v * 1.1) : Math.round(v / 1.1)).toLocaleString("en-US");
    });
  });
})();
