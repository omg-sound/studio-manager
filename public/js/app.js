// 클릭 복사([data-copy]) + 토스트 알림. 사업자등록번호 등 값을 눌러 클립보드에 복사.
// window.__toast(msg)로 다른 곳에서도 짧은 토스트를 띄울 수 있다(CSP-safe, 인라인 0).
(function () {
  "use strict";
  function showToast(msg) {
    var t = document.createElement("div");
    t.textContent = msg;
    t.setAttribute("role", "status");
    t.className = "fixed left-1/2 top-4 z-[60] -translate-x-1/2 rounded-lg border border-border bg-bg px-4 py-2 text-sm font-medium shadow-lg";
    t.style.transition = "opacity .3s";
    document.body.appendChild(t);
    setTimeout(function () { t.style.opacity = "0"; setTimeout(function () { if (t.parentNode) t.parentNode.removeChild(t); }, 320); }, 1400);
  }
  window.__toast = showToast;
  function fallbackCopy(text) {
    var ta = document.createElement("textarea");
    ta.value = text; ta.setAttribute("readonly", ""); ta.style.position = "fixed"; ta.style.top = "-1000px"; ta.style.opacity = "0";
    document.body.appendChild(ta); ta.select();
    var ok = false; try { ok = document.execCommand("copy"); } catch (e) { ok = false; }
    if (ta.parentNode) ta.parentNode.removeChild(ta);
    return ok;
  }
  document.addEventListener("click", function (e) {
    var el = e.target.closest && e.target.closest("[data-copy]");
    if (!el) return;
    e.preventDefault();
    var text = el.getAttribute("data-copy") || "";
    if (!text) return;
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(function () { showToast("클립보드에 복사되었습니다"); }).catch(function () { if (fallbackCopy(text)) showToast("클립보드에 복사되었습니다"); });
    } else if (fallbackCopy(text)) { showToast("클립보드에 복사되었습니다"); }
  });
})();

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

  // 미완료(대기 작업·예정 세션)를 청구 항목으로 체크하면 완료 여부 재확인 — 아니면 선택 해제(공급가·VAT 재계산).
  document.addEventListener("change", function (e) {
    var cb = e.target;
    if (!cb || cb.type !== "checkbox" || !cb.checked || !cb.hasAttribute || !cb.hasAttribute("data-confirm-pending")) return;
    if (!window.confirm("아직 완료되지 않은 항목입니다. 청구하면서 '완료'로 바꿀까요?")) {
      cb.checked = false;
      cb.dispatchEvent(new Event("change", { bubbles: true })); // 체크 해제 반영해 금액 미리보기 갱신
    }
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
  var conflictWarn = form.querySelector("[data-conflict-warn]");
  var overrideField = form.querySelector("[data-override-conflict]");
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
  // 시작 시간 가용성: 예약된(busy) 슬롯을 '주황(slot-busy)'으로 표시 — 비활성이 아니라 선택 가능(확인 후 등록).
  function applyStartState() {
    if (grid) Array.prototype.forEach.call(grid.querySelectorAll("input[data-slot]"), function (inp) {
      var b = !!busy[inp.getAttribute("data-slot")];
      var span = inp.nextElementSibling; // 라디오 다음 형제 = 표시용 span
      if (span) span.classList.toggle("slot-busy", b);
    });
    updateConflictWarn();
  }
  // 시작(HH:MM) → 자정 기준 분. 무효면 null.
  function toMin(hhmm) {
    var p = String(hhmm || "").split(":");
    if (p.length !== 2) return null;
    var h = parseInt(p[0], 10), m = parseInt(p[1], 10);
    return isNaN(h) || isNaN(m) ? null : h * 60 + m;
  }
  // 선택한 시작+소요 구간이 예약된 30분 슬롯(busy) 중 하나와 겹치는가(클라이언트 근사 — 서버가 최종 판정).
  function overlapDetected() {
    var start = currentStart();
    var sMin = toMin(start);
    if (sMin == null) return false;
    var dur = durationMinutes();
    var eMin = sMin + (dur > 0 ? dur : 30); // 소요 미설정이면 30분 블록으로 간주
    for (var slot in busy) {
      if (!busy[slot]) continue;
      var m = toMin(slot);
      if (m == null) continue;
      if (sMin < m + 30 && m < eMin) return true; // busy 슬롯 [m,m+30)과 겹침
    }
    return false;
  }
  function updateConflictWarn() {
    if (conflictWarn) conflictWarn.hidden = !overlapDetected();
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
    positionTicks();
  }
  // Pro 눈금을 슬라이더 값 위치에 맞춰 재배치: 1Pro=기준시간, 2Pro=×2…(기준=녹음 단가 기준시간, 없으면 스튜디오 기본).
  // 양 끝(0%/100%)은 잘리지 않게 정렬 기준(translateX)을 바꾼다. 서버 초기 렌더와 동일 규칙.
  function positionTicks() {
    var base = baseMinutes() || proDefaultMinutes();
    if (!(base > 0)) return;
    Array.prototype.forEach.call(presets, function (b) {
      var mult = parseInt(String(b.getAttribute("data-duration-preset") || "pro1").replace("pro", ""), 10) || 1;
      var pos = Math.min(100, (base * mult / SLIDER_MAX) * 100);
      var t = pos <= 5 ? "0" : pos >= 95 ? "-100%" : "-50%";
      b.style.left = pos + "%";
      b.style.transform = "translateX(" + t + ")";
    });
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
    updateConflictWarn();
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
  // 겹침이 감지되면 제출 직전 확인 → 승인 시 override_conflict=1로 그대로 등록(서버가 겹침 허용). 취소면 제출 중단.
  form.addEventListener("submit", function (e) {
    if (!overrideField) return;
    if (overlapDetected()) {
      if (!window.confirm("이미 스케쥴이 있습니다. 그래도 등록하시겠습니까?")) {
        e.preventDefault();
        return;
      }
      overrideField.value = "1";
    } else {
      overrideField.value = "";
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
      // flash(키형) + notice/notice_warn(자유 문구형: 동기화 결과 등) 모두 URL에서 제거(새로고침 시 배너 잔존 방지).
      var changed = false;
      ["flash", "notice", "notice_warn"].forEach(function (k) {
        if (url.searchParams.has(k)) { url.searchParams.delete(k); changed = true; }
      });
      if (changed) window.history.replaceState(null, "", url.pathname + url.search + url.hash);
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
    // 아티스트(개인)·그룹은 세금정보 없음(현금영수증만), 업체(소속사/제작사/기타)는 세금정보·첨부.
    var isArtist = kindSel.value === "아티스트" || kindSel.value === "그룹";
    tax.hidden = isArtist;
    if (cash) cash.hidden = !isArtist;
    if (filesBox) filesBox.hidden = isArtist;
  }
  kindSel.addEventListener("change", sync);
  sync();
})();

// 아티스트 폼: 소속 그룹 선택 시 소속사를 그룹 소속사로 자동 맞춤(연동). 그룹 소속사가 있을 때만 — 이후 개별 변경(오버라이드) 가능.
(function () {
  "use strict";
  document.addEventListener("change", function (ev) {
    var gsel = ev.target;
    if (!gsel || gsel.tagName !== "SELECT" || gsel.name !== "group_id") return;
    var form = gsel.form;
    if (!form) return;
    var asel = form.querySelector('select[name="agency_id"]');
    if (!asel) return;
    var opt = gsel.options[gsel.selectedIndex];
    var ag = opt ? opt.getAttribute("data-agency") || "" : "";
    if (gsel.value && ag) { asel.value = ag; asel.dispatchEvent(new Event("change", { bubbles: true })); } // 그룹 소속사로 맞춤(dirty 반영)
  });
})();

// [data-menu] <details> 드롭다운(예: 새 클라이언트 유형 선택): 바깥 클릭 시 닫기(네이티브 details는 summary 재클릭 전까지 열림).
(function () {
  "use strict";
  document.addEventListener("click", function (ev) {
    var open = document.querySelectorAll("details[data-menu][open]");
    for (var i = 0; i < open.length; i++) {
      if (!open[i].contains(ev.target)) open[i].removeAttribute("open");
    }
  });
})();

// [data-flash] 토스트: fixed로 떠 있어 레이아웃을 밀지 않음. 잠시 후 자동 페이드아웃·클릭 시 즉시 닫기.
(function () {
  "use strict";
  var el = document.querySelector("[data-flash]");
  if (!el) return;
  var warn = el.getAttribute("data-flash-warn") === "1";
  var timer;
  function hide() {
    if (timer) clearTimeout(timer);
    el.style.opacity = "0";
    setTimeout(function () { if (el.parentNode) el.parentNode.removeChild(el); }, 320);
  }
  el.addEventListener("click", hide);
  timer = setTimeout(hide, warn ? 6000 : 3500); // 경고는 조금 더 오래 유지
})();

// (옛 datalist 기반 syncCombo 콤보는 personCombo/payerCombo 커스텀 팝업으로 전면 대체 — 제거.)

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
      if (list && tpl && tpl.content) {
        list.appendChild(tpl.content.cloneNode(true));
        var last = list.lastElementChild;
        if (window.__initPersonCombos) window.__initPersonCombos(last); // 새 행의 personCombo 초기화(검색·모달·선택 닫힘)
        var inp = last && last.querySelector("[data-pc-input]"); if (inp) inp.focus();
      }
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
        if (t && t.content) { list2.appendChild(t.content.cloneNode(true)); if (window.__initPersonCombos) window.__initPersonCombos(list2.lastElementChild); }
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
    // 접힌 <details> 안의 폼이 변경되면(예: 작업 헤더 상태 select를 접은 채 수정) 자동으로 펼쳐
    // 저장 버튼·'저장되지 않은 변경사항' 힌트를 드러낸다 — 접힌 상태에서 저장을 놓치는 문제 방지.
    if (snapshot(r.form) !== r.initial && r.form.closest) {
      var det = r.form.closest("details");
      if (det && !det.open) det.open = true;
    }
  }
  document.addEventListener("input", onEvt);
  document.addEventListener("change", onEvt);
  // 네비게이션 가드용 전역 조회: 변경된(dirty) 폼이 있나 / 첫 dirty 폼.
  window.__hasDirty = function () { return recs.some(function (r) { return snapshot(r.form) !== r.initial; }); };
  window.__firstDirtyForm = function () { for (var i = 0; i < recs.length; i++) if (snapshot(recs[i].form) !== recs[i].initial) return recs[i].form; return null; };
})();

// 저장하지 않은 변경사항 가드: dirty 폼이 있는데 다른 탭·섹션(링크)으로 이동하거나 탭을 닫으려 하면
// 저장/무시(이동)/취소를 묻는다. 링크 클릭=커스텀 모달(3택), 하드 언로드(탭 닫기·새로고침·주소창)=브라우저 기본 경고.
(function () {
  "use strict";
  var bypass = false; // 의도된 이동(폼 제출·모달 '이동') 시 가드·경고 우회
  function hasDirty() { return !!(window.__hasDirty && window.__hasDirty()); }
  // 폼 제출(저장·완료 토글·삭제 등)은 의도된 동작 → beforeunload 경고 억제.
  document.addEventListener("submit", function () { bypass = true; setTimeout(function () { bypass = false; }, 2000); }, true);
  // 하드 언로드(탭 닫기·새로고침·주소 입력·외부 이동) 안전망 — 브라우저 기본 "나가시겠습니까?".
  window.addEventListener("beforeunload", function (e) {
    if (bypass || !hasDirty()) return;
    e.preventDefault();
    e.returnValue = "";
  });
  // 인앱 링크(사이드바·탭·상세 링크) 클릭 → 저장/무시/취소 모달.
  document.addEventListener("click", function (e) {
    if (bypass || !hasDirty()) return;
    var a = e.target.closest && e.target.closest("a[href]");
    if (!a) return;
    var href = a.getAttribute("href");
    if (!href || href.charAt(0) === "#" || /^(javascript:|mailto:|tel:)/i.test(href)) return;
    if (a.target === "_blank" || a.hasAttribute("download") || a.hasAttribute("data-no-guard")) return;
    e.preventDefault();
    openGuardModal(href);
  }, true);
  function openGuardModal(href) {
    if (document.querySelector("[data-nav-guard]")) return; // 중복 방지
    var wrap = document.createElement("div");
    wrap.setAttribute("data-nav-guard", "");
    wrap.className = "fixed inset-0 z-[60] flex items-center justify-center bg-black/40 p-4";
    wrap.innerHTML =
      '<div class="w-full max-w-sm space-y-3 rounded-xl border border-border bg-bg p-4 shadow-xl" role="dialog" aria-modal="true">' +
        '<div class="font-display text-lg font-semibold">저장하지 않은 변경사항</div>' +
        '<p class="text-sm text-muted">저장하지 않은 변경사항이 있습니다. 저장할까요?</p>' +
        '<div class="flex flex-wrap items-center justify-end gap-2 pt-1">' +
          '<button type="button" class="btn-ghost btn-sm" data-g-discard>저장하지 않음</button>' +
          '<button type="button" class="btn-primary btn-sm" data-g-save>저장</button>' +
        '</div>' +
      '</div>';
    document.body.appendChild(wrap);
    function close() { if (wrap.parentNode) wrap.parentNode.removeChild(wrap); }
    wrap.addEventListener("click", function (e) { if (e.target === wrap) close(); }); // 배경 클릭 = 편집으로 복귀(이동 안 함)
    wrap.querySelector("[data-g-discard]").addEventListener("click", function () { bypass = true; close(); window.location.href = href; }); // 저장하지 않고 이동
    wrap.querySelector("[data-g-save]").addEventListener("click", function () { // 저장 성공 후 원래 목적지로 이동
      var f = window.__firstDirtyForm && window.__firstDirtyForm();
      close();
      if (!f) { bypass = true; window.location.href = href; return; }
      var action = f.getAttribute("action") || (window.location.pathname + window.location.search);
      // 함정#14: urlencoded로 전송(multipart 금지). form= 로 연결된 폼 밖 컨트롤도 FormData에 포함됨.
      var body = new URLSearchParams();
      new FormData(f).forEach(function (v, k) { body.append(k, v); });
      bypass = true; // 저장/이동 동안 beforeunload 억제
      // X-Requested-With 없이 보내 서버가 JSON이 아닌 정상 302 리다이렉트로 응답 → 성공 판정(opaqueredirect).
      fetch(action, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: body.toString(), redirect: "manual", credentials: "same-origin" })
        .then(function (r) {
          if (r.type === "opaqueredirect") { window.location.href = href; } // 저장 성공(서버 리다이렉트) → 원래 클릭한 목적지로
          else { // 검증 오류·충돌 등 — 정상 제출로 폴백해 오류/확인을 그대로 노출(사용자가 처리 후 재시도)
            var sb = f.querySelector("[data-dirty-save]"); if (sb) { sb.disabled = false; sb.click(); } else if (f.requestSubmit) f.requestSubmit(); else f.submit();
          }
        })
        .catch(function () { var sb = f.querySelector("[data-dirty-save]"); if (sb) { sb.disabled = false; sb.click(); } else f.submit(); });
    });
    var saveBtn = wrap.querySelector("[data-g-save]"); if (saveBtn) saveBtn.focus();
  }
})();

// 헤더 상태 select 등 [data-no-toggle] 요소를 클릭/조작해도 <details> 펼침이 토글되지 않게(접힌 채 상태 수정).
(function () {
  "use strict";
  function guard(e) { if (e.target.closest && e.target.closest("[data-no-toggle]")) e.preventDefault(); }
  document.addEventListener("click", guard); // 클릭의 기본동작(summary 토글) 취소 — select 드롭다운은 mousedown이라 영향 없음
})();

// 콤보 공용 키보드 내비게이션(방향키 이동·엔터 선택·ESC 닫기). 하이라이트 항목을 click 시뮬레이션 →
// 각 콤보의 기존 click 핸들러가 선택 처리(콤보별 pick 로직 몰라도 동작). pop 재렌더(MutationObserver)마다 첫 항목 하이라이트.
function comboKbdNav(input, pop) {
  if (!input || !pop) return;
  var hi = -1;
  function rowEls() { return pop.querySelectorAll("button"); }
  function setHi(i) {
    var rs = rowEls();
    if (!rs.length) { hi = -1; return; }
    hi = Math.max(0, Math.min(i, rs.length - 1));
    Array.prototype.forEach.call(rs, function (b, idx) { b.classList.toggle("bg-elevated", idx === hi); });
    if (rs[hi] && rs[hi].scrollIntoView) rs[hi].scrollIntoView({ block: "nearest" });
  }
  new MutationObserver(function () { if (!pop.classList.contains("hidden")) setHi(0); }).observe(pop, { childList: true });
  input.addEventListener("keydown", function (e) {
    if (e.isComposing || e.keyCode === 229) return; // 한글 IME 조합 중 키(엔터=조합 확정 등)는 무시
    var open = !pop.classList.contains("hidden");
    if (e.key === "ArrowDown") { e.preventDefault(); if (open) setHi(hi + 1); }
    else if (e.key === "ArrowUp") { e.preventDefault(); if (open) setHi(hi - 1); }
    else if (e.key === "Enter" && open) {
      var rs = rowEls();
      if (hi >= 0 && rs[hi]) { e.preventDefault(); rs[hi].dispatchEvent(new MouseEvent("mousedown", { bubbles: true })); rs[hi].click(); }
    } else if (e.key === "Escape") { pop.classList.add("hidden"); }
  });
  pop.addEventListener("mousemove", function (e) { var b = e.target.closest("button"); if (!b) return; var rs = rowEls(); for (var i = 0; i < rs.length; i++) if (rs[i] === b) { if (i !== hi) setHi(i); break; } });
}

// 새 party(사람·회사·그룹) 생성 브로드캐스트 — 어느 콤보/모달에서 만들든 모든 콤보가 듣고 자기 옵션에 추가(재검색 즉시 인식·중복 방지).
// detail: { kind:'person'|'company'|'group', id, name, isArtist?, realName?, agency?, phone?, email?, company? }
function announceParty(detail) { if (detail && detail.id && detail.name) document.dispatchEvent(new CustomEvent("party-created", { detail: detail })); }

// 아티스트 콤보([data-artist-combo]): 타이핑=기존 아티스트·사람 검색, 빈 입력=[검색]/[새 아티스트] 팝업(전체 목록 덤프 방지).
// 기존 사람 선택 → hidden artist_contact_id 연결(저장 시 중복 사람 방지). '그룹' 체크는 밴드/팀(연락처 미연결).
(function () {
  "use strict";
  function esc(s) { return String(s == null ? "" : s).replace(/[&<>"]/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]; }); }
  Array.prototype.forEach.call(document.querySelectorAll("[data-artist-combo]"), function (root) {
    var input = root.querySelector("[data-artist-input]");
    var cid = root.querySelector("[data-artist-cid]");
    var pop = root.querySelector("[data-artist-pop]");
    var dataEl = root.querySelector("[data-artist-options]");
    if (!input || !pop || !dataEl) return;
    var realDisp = root.querySelector("[data-artist-realname]"), realVal = root.querySelector("[data-artist-realname-val]"); // 선택 아티스트 본명 표시(입력 아님)
    var opts = [];
    try { opts = JSON.parse(dataEl.textContent || "[]"); } catch (e) { opts = []; }
    // 어디서든 새 party 생성되면 아티스트·그룹은 이 콤보 옵션에 추가(재검색 인식)
    document.addEventListener("party-created", function (e) {
      var p = e.detail; if (!p || !(p.kind === "group" || (p.kind === "person" && p.isArtist))) return;
      if (opts.some(function (o) { return String(o.contactId) === String(p.id); })) return;
      opts.push({ name: p.name, contactId: p.id, realName: p.realName || "", sub: p.kind === "group" ? "그룹" : "아티스트", agency: p.agency || "" });
    });
    var view = []; // 현재 렌더된 후보(클릭 인덱스 매핑)
    function showReal(rn) { if (!realDisp) return; if (rn) { if (realVal) realVal.textContent = rn; realDisp.classList.remove("hidden"); } else realDisp.classList.add("hidden"); }

    function hide() { pop.classList.add("hidden"); input.setAttribute("aria-expanded", "false"); }
    function show() { pop.classList.remove("hidden"); input.setAttribute("aria-expanded", "true"); }
    var hi = -1; // 키보드 하이라이트 인덱스(방향키 이동, -1=없음)
    function rowEls() { return pop.querySelectorAll("button"); }
    function setHi(i) {
      var rs = rowEls();
      if (!rs.length) { hi = -1; return; }
      hi = Math.max(0, Math.min(i, rs.length - 1));
      Array.prototype.forEach.call(rs, function (b, idx) { b.classList.toggle("bg-elevated", idx === hi); });
      if (rs[hi] && rs[hi].scrollIntoView) rs[hi].scrollIntoView({ block: "nearest" });
    }
    function fireInput() { input.dispatchEvent(new Event("input", { bubbles: true })); } // dirty 감지 트리거
    // 아티스트의 소속사를 프로젝트 '소속사/레이블' companyCombo에 자동 채움(같은 폼 안에 있을 때만·비면 유지).
    // companyCombo는 nameless라 name=artist_company는 숨김 제출 필드 → 숨김·보이는 칸 둘 다 세팅.
    function fillAgency(name) {
      if (!name) return;
      var form = root.closest ? root.closest("form") : null;
      var hidden = (form || document).querySelector('input[name="artist_company"]');
      if (!hidden) return;
      hidden.value = name;
      var combo = hidden.closest && hidden.closest("[data-company-combo]");
      var vis = combo && combo.querySelector("[data-cc-input]");
      if (vis) vis.value = name; // 보이는 칸도 채움(companyCombo render는 트리거 안 함)
      // 새로 만든 소속사를 companyCombo 옵션에 추가 → 소속사 필드 재검색 시 '새로 등록' 대신 기존 항목 인식(중복 방지)
      if (combo && combo.__ccOpts && !combo.__ccOpts.some(function (o) { return String(o.name) === name; })) combo.__ccOpts.push({ name: name, sub: "" });
      hidden.dispatchEvent(new Event("change", { bubbles: true })); // dirty 감지
    }

    var rowCls = "flex w-full cursor-pointer items-center justify-between gap-2 px-3 py-2 text-left text-sm hover:bg-elevated";
    function pickRow(o, i) {
      var nm = esc(o.name) + (o.realName ? ' <span class="text-muted">(' + esc(o.realName) + ')</span>' : ""); // 본명 병기
      return '<button type="button" class="' + rowCls + '" data-idx="' + i + '">' +
        '<span class="truncate text-fg">' + nm + '</span>' +
        '<span class="shrink-0 text-xs text-muted">' + esc(o.sub || "") + '</span></button>';
    }
    function newRow(label) {
      return '<button type="button" class="' + rowCls + ' text-primary" data-new="1">' +
        '<span class="truncate">＋ ' + esc(label) + '</span><span class="shrink-0 text-xs text-muted">새로 등록</span></button>';
    }
    function render() {
      var q = input.value.trim().toLowerCase();
      var html = "";
      if (!q) {
        view = [];
        html = newRow("새 아티스트 등록"); // 검색 안내 줄 폐기(타이핑하면 자동 검색)
      } else {
        view = opts.filter(function (o) { return String(o.name).toLowerCase().indexOf(q) !== -1 || (o.realName && String(o.realName).toLowerCase().indexOf(q) !== -1); }).slice(0, 12); // 활동명·본명 둘 다 검색
        html = view.map(pickRow).join("");
        var exact = view.some(function (o) { return String(o.name).toLowerCase() === q || (o.realName && String(o.realName).toLowerCase() === q); });
        if (!exact) html += newRow("'" + input.value.trim() + "'(으)로 새 아티스트");
      }
      pop.innerHTML = html;
      show();
      setHi(0); // 첫 후보 하이라이트(방향키·엔터 대비)
    }
    function pick(o) {
      input.value = o.name;
      cid.value = o.contactId || "";
      showReal(o.realName);
      fillAgency(o.agency); // 소속사/레이블 자동 채움(그 아티스트의 현재 소속사)
      fireInput();
      hide(); // fireInput 뒤에 닫아야 재렌더로 다시 열리지 않음(선택됨이 보이게)
    }
    function asNew() { cid.value = ""; hide(); input.focus(); fireInput(); } // 새 아티스트: 연결 없음, 입력값 유지(모달 없을 때 폴백)

    // ── 간이 등록 모달: 프로젝트 폼 이탈 없이 새 아티스트/그룹 등록(fetch → 콤보 채움) ──
    var modal = root.querySelector("[data-artist-modal]");
    function openModal() {
      if (!modal) { asNew(); return; }
      var mName = modal.querySelector("[data-am-name]"), mGroup = modal.querySelector("[data-am-group]"),
          mRealWrap = modal.querySelector("[data-am-real-wrap]"), mReal = modal.querySelector("[data-am-real]"),
          mAgency = modal.querySelector("[data-am-agency]"), mPhone = modal.querySelector("[data-am-phone]"),
          mAgencyInput = modal.querySelector("[data-am-agency-input]"),
          mErr = modal.querySelector("[data-am-err]");
      mName.value = input.value.trim(); mGroup.checked = false;
      if (mReal) mReal.value = ""; if (mAgency) mAgency.value = ""; if (mAgencyInput) mAgencyInput.value = ""; if (mPhone) mPhone.value = "";
      mErr.classList.add("hidden"); mRealWrap.classList.remove("hidden");
      modal.classList.remove("hidden"); modal.classList.add("flex");
      hide(); mName.focus();
    }
    if (modal) {
      var mGroup = modal.querySelector("[data-am-group]"), mRealWrap = modal.querySelector("[data-am-real-wrap]"),
          mSave = modal.querySelector("[data-am-save]"), mCancel = modal.querySelector("[data-am-cancel]");
      function closeModal() { modal.classList.add("hidden"); modal.classList.remove("flex"); }
      mGroup.addEventListener("change", function () { mRealWrap.classList.toggle("hidden", mGroup.checked); });
      mCancel.addEventListener("click", closeModal);
      modal.addEventListener("click", function (e) { if (e.target === modal) closeModal(); }); // 배경 클릭 닫기
      mSave.addEventListener("click", function () {
        var mName = modal.querySelector("[data-am-name]"), mReal = modal.querySelector("[data-am-real]"),
            mAgency = modal.querySelector("[data-am-agency]"), mPhone = modal.querySelector("[data-am-phone]"),
            mAgencyInput = modal.querySelector("[data-am-agency-input]"), mErr = modal.querySelector("[data-am-err]");
        var agName = mAgencyInput ? mAgencyInput.value.trim() : ""; // 모달에서 입력·선택한 소속사명 → 등록 후 프로젝트 소속사 필드에 반영
        var nm = mName.value.trim();
        if (!nm) { mErr.textContent = "활동명을 입력하세요."; mErr.classList.remove("hidden"); return; }
        mSave.disabled = true; mErr.classList.add("hidden");
        var body = new URLSearchParams();
        body.append("type", mGroup.checked ? "group" : "artist"); body.append("name", nm);
        if (!mGroup.checked && mReal && mReal.value.trim()) body.append("real_name", mReal.value.trim());
        if (mAgency && mAgency.value) body.append("agency_id", mAgency.value);
        if (mPhone && mPhone.value.trim()) body.append("phone", mPhone.value.trim());
        fetch("/clients", { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded", "X-Requested-With": "fetch" }, body: body.toString() })
          .then(function (r) { return r.ok ? r.json() : null; })
          .then(function (d) {
            if (!d || !d.ok) throw new Error("fail");
            var rn = !mGroup.checked && mReal && mReal.value.trim() ? mReal.value.trim() : "";
            announceParty({ kind: mGroup.checked ? "group" : "person", id: d.id, name: d.name, isArtist: true, realName: rn, agency: agName || "" }); // 전역 브로드캐스트 → 이 콤보 포함 모든 콤보 옵션에 반영
            input.value = d.name; cid.value = d.id;
            showReal(rn); // 모달 입력 본명(개인) 표시
            fillAgency(agName); // 모달에서 지정한 소속사를 프로젝트 소속사/레이블 필드에 즉시 반영
            closeModal(); fireInput(); hide(); // 등록 후 콤보 드롭다운 닫기(fireInput 재렌더로 다시 열리는 것 방지)
            if (window.__toast) window.__toast(d.name + " 등록됨");
          })
          .catch(function () { mErr.textContent = "등록 실패 — 다시 시도하세요."; mErr.classList.remove("hidden"); })
          .then(function () { mSave.disabled = false; });
      });

      // 소속사 미니 콤보(모달 내부): 타이핑 검색 + '＋ 새 소속사 등록'(fetch → data-am-agency hidden id 채움).
      var agInput = modal.querySelector("[data-am-agency-input]"), agHid = modal.querySelector("[data-am-agency]"),
          agPop = modal.querySelector("[data-am-agency-pop]"), agOptsEl = modal.querySelector("[data-am-agency-options]");
      var agOpts = []; try { agOpts = JSON.parse((agOptsEl && agOptsEl.textContent) || "[]"); } catch (e) { agOpts = []; }
      document.addEventListener("party-created", function (e) { var p = e.detail; if (!p || p.kind !== "company") return; if (!agOpts.some(function (o) { return String(o.id) === String(p.id); })) agOpts.push({ id: p.id, name: p.name }); }); // 새 회사 → 소속사 미니콤보 옵션에 추가
      if (agInput && agHid && agPop) {
        var agRowCls = "flex w-full cursor-pointer items-center justify-between gap-2 px-3 py-2 text-left text-sm hover:bg-elevated";
        var agView = [];
        function agHide() { agPop.classList.add("hidden"); }
        function agRender() {
          var q = agInput.value.trim().toLowerCase();
          agView = (q ? agOpts.filter(function (o) { return String(o.name).toLowerCase().indexOf(q) !== -1; }) : agOpts).slice(0, 10);
          var html = agView.map(function (o, i) { return '<button type="button" class="' + agRowCls + '" data-agidx="' + i + '"><span class="truncate text-fg">' + esc(o.name) + '</span></button>'; }).join("");
          if (q && !agView.some(function (o) { return String(o.name).toLowerCase() === q; })) html += '<button type="button" class="' + agRowCls + ' text-primary" data-agnew="1"><span class="truncate">＋ \'' + esc(agInput.value.trim()) + '\'(으)로 새 소속사 등록</span><span class="shrink-0 text-xs text-muted">새로 등록</span></button>';
          agPop.innerHTML = html || '<div class="px-3 py-2 text-sm text-muted">이름을 입력해 새 소속사로 등록</div>'; agPop.classList.remove("hidden");
        }
        agInput.addEventListener("focus", agRender);
        agInput.addEventListener("click", agRender);
        agInput.addEventListener("input", function () { agHid.value = ""; agRender(); }); // 타이핑 중 id 해제(선택·등록으로만 확정)
        agInput.addEventListener("blur", function () { setTimeout(agHide, 150); });
        agPop.addEventListener("mousedown", function (e) { e.preventDefault(); });
        agPop.addEventListener("click", function (e) {
          var b = e.target.closest("button"); if (!b) return;
          if (b.hasAttribute("data-agidx")) { var o = agView[Number(b.getAttribute("data-agidx"))]; agInput.value = o.name; agHid.value = o.id; agHide(); }
          else if (b.hasAttribute("data-agnew")) {
            var nm = agInput.value.trim(); if (!nm) return;
            b.disabled = true;
            var body = new URLSearchParams(); body.append("type", "company"); body.append("name", nm);
            fetch("/clients", { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded", "X-Requested-With": "fetch" }, body: body.toString() })
              .then(function (r) { return r.ok ? r.json() : null; })
              .then(function (d) { if (!d || !d.ok) throw new Error("fail"); agHid.value = d.id; agInput.value = d.name; announceParty({ kind: "company", id: d.id, name: d.name }); agHide(); })
              .catch(function () { b.disabled = false; });
          }
        });
        comboKbdNav(agInput, agPop); // 소속사 미니콤보도 방향키·엔터 선택
      }
      // 모달 안에서 엔터 → 바깥 프로젝트 폼 제출 방지 + '등록'(mSave) 실행(소속사 콤보가 이미 처리했으면 스킵)
      modal.addEventListener("keydown", function (e) {
        if (e.isComposing || e.keyCode === 229) return; // 한글 IME 조합 중 엔터(조합 확정용)는 무시
        if (e.key !== "Enter" || e.defaultPrevented || (e.target && e.target.tagName === "TEXTAREA")) return;
        e.preventDefault(); mSave.click();
      });
    }

    input.addEventListener("focus", render);
    input.addEventListener("click", render);
    input.addEventListener("input", render);
    // 방향키 이동 + 엔터 선택(ESC 닫기). 드롭다운 열려 있을 때만 가로챔 — 아니면 폼 기본 동작.
    input.addEventListener("keydown", function (e) {
      if (e.isComposing || e.keyCode === 229) return; // 한글 IME 조합 중 키(엔터=조합 확정 등)는 무시
      if (e.key === "ArrowDown") { e.preventDefault(); if (pop.classList.contains("hidden")) render(); else setHi(hi + 1); }
      else if (e.key === "ArrowUp") { e.preventDefault(); if (!pop.classList.contains("hidden")) setHi(hi - 1); }
      else if (e.key === "Enter" && !pop.classList.contains("hidden")) {
        var rs = rowEls();
        if (hi >= 0 && rs[hi]) {
          e.preventDefault(); // 폼 제출 방지하고 하이라이트 항목 선택
          var b = rs[hi];
          if (b.hasAttribute("data-idx")) pick(view[Number(b.getAttribute("data-idx"))]);
          else if (b.hasAttribute("data-new")) openModal();
        }
      } else if (e.key === "Escape") { hide(); }
    });
    input.addEventListener("blur", function () { setTimeout(hide, 150); }); // 항목 클릭 여유
    pop.addEventListener("mousedown", function (e) { e.preventDefault(); }); // 클릭 전 blur 방지
    pop.addEventListener("mousemove", function (e) { var b = e.target.closest("button"); if (!b) return; var rs = rowEls(); for (var i = 0; i < rs.length; i++) if (rs[i] === b && i !== hi) { setHi(i); break; } }); // 마우스 올린 항목으로 하이라이트 동기화
    pop.addEventListener("click", function (e) {
      var b = e.target.closest("button"); if (!b) return;
      if (b.hasAttribute("data-idx")) pick(view[Number(b.getAttribute("data-idx"))]);
      else if (b.hasAttribute("data-new")) openModal(); // 새 아티스트 등록 → 간이 모달
      else if (b.hasAttribute("data-search")) input.focus();
    });
    // 직접 타이핑으로 이름을 바꾸면(선택 안 함) 연결 해제 — 저장 시 이름 매칭으로만 dedup.
    input.addEventListener("input", function () {
      var v = input.value.trim().toLowerCase();
      var match = opts.filter(function (o) { return String(o.name).toLowerCase() === v || (o.realName && String(o.realName).toLowerCase() === v); })[0]; // 활동명·본명 정확 일치
      if (match) { cid.value = match.contactId || ""; showReal(match.realName); }
      else { cid.value = ""; showReal(""); }
    });
  });
})();

// 업체 콤보([data-company-combo]): 소속사/레이블·제작사/운영사 — 타이핑=기존 업체 검색, 빈 입력=[＋새 등록].
// 값은 업체명 TEXT(저장 시 ensureCompanyParty가 찾/생성). '새 등록'=간이 모달(fetch 생성 → 이름 채움).
(function () {
  "use strict";
  function esc(s) { return String(s == null ? "" : s).replace(/[&<>"]/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]; }); }
  Array.prototype.forEach.call(document.querySelectorAll("[data-company-combo]"), function (root) {
    var input = root.querySelector("[data-cc-input]");
    var hidCC = root.querySelector("[data-cc-hidden]"); // 제출용 업체명(보이는 칸은 name 없음 — Chrome 자동완성 회피)
    var pop = root.querySelector("[data-cc-pop]");
    var dataEl = root.querySelector("[data-cc-options]");
    var modal = root.querySelector("[data-cc-modal]");
    if (!input || !pop || !dataEl) return;
    var opts = [];
    try { opts = JSON.parse(dataEl.textContent || "[]"); } catch (e) { opts = []; }
    root.__ccOpts = opts; // fillAgency 등 외부에서 새 소속사를 옵션에 추가할 수 있게 노출
    document.addEventListener("party-created", function (e) { // 어디서든 새 회사 생성되면 이 콤보 옵션에 추가
      var p = e.detail; if (!p || p.kind !== "company") return;
      if (opts.some(function (o) { return String(o.name) === String(p.name); })) return;
      opts.push({ name: p.name, sub: "" });
    });
    var view = [];
    var rowCls = "flex w-full cursor-pointer items-center justify-between gap-2 px-3 py-2 text-left text-sm hover:bg-elevated";
    function hide() { pop.classList.add("hidden"); input.setAttribute("aria-expanded", "false"); }
    function show() { pop.classList.remove("hidden"); input.setAttribute("aria-expanded", "true"); }
    function fireInput() { input.dispatchEvent(new Event("input", { bubbles: true })); }
    function newRow(nm) {
      var label = nm ? "'" + esc(nm) + "'(으)로 새 업체 등록" : "새 업체 등록";
      return '<button type="button" class="' + rowCls + ' text-primary" data-new="1"><span class="truncate">＋ ' + label + '</span><span class="shrink-0 text-xs text-muted">새로 등록</span></button>';
    }
    function render() {
      var q = input.value.trim().toLowerCase();
      var html = "";
      if (!q) { view = []; html = newRow(""); }
      else {
        view = opts.filter(function (o) { return String(o.name).toLowerCase().indexOf(q) !== -1; }).slice(0, 12);
        html = view.map(function (o, i) { return '<button type="button" class="' + rowCls + '" data-idx="' + i + '"><span class="truncate text-fg">' + esc(o.name) + '</span><span class="shrink-0 text-xs text-muted">' + esc(o.sub || "") + '</span></button>'; }).join("");
        if (!view.some(function (o) { return String(o.name).toLowerCase() === q; })) html += newRow(input.value.trim());
      }
      pop.innerHTML = html; show();
    }
    function openModal() {
      if (!modal) { hide(); return; }
      var n = modal.querySelector("[data-cc-name]"); n.value = input.value.trim();
      ["[data-cc-biz]", "[data-cc-owner]", "[data-cc-owner-id]"].forEach(function (s) { var el = modal.querySelector(s); if (el) el.value = ""; });
      var ownPop0 = modal.querySelector("[data-cc-owner-pop]"); if (ownPop0) ownPop0.classList.add("hidden");
      modal.querySelector("[data-cc-err]").classList.add("hidden");
      modal.classList.remove("hidden"); modal.classList.add("flex"); hide(); n.focus();
    }
    if (modal) {
      var cSave = modal.querySelector("[data-cc-save]"), cCancel = modal.querySelector("[data-cc-cancel]");
      var closeModal = function () { modal.classList.add("hidden"); modal.classList.remove("flex"); };
      cCancel.addEventListener("click", closeModal);
      modal.addEventListener("click", function (e) { if (e.target === modal) closeModal(); });
      cSave.addEventListener("click", function () {
        var nm = modal.querySelector("[data-cc-name]").value.trim();
        var err = modal.querySelector("[data-cc-err]");
        if (!nm) { err.textContent = "업체명을 입력하세요."; err.classList.remove("hidden"); return; }
        var body = new URLSearchParams();
        body.append("type", "company"); body.append("name", nm);
        if (modal.querySelector("[data-cc-agency]").checked) body.append("roles", "소속사/레이블");
        if (modal.querySelector("[data-cc-prod]").checked) body.append("roles", "제작사");
        var biz = modal.querySelector("[data-cc-biz]").value.trim(); if (biz) body.append("biz_no", biz);
        var owner = modal.querySelector("[data-cc-owner]").value.trim(); if (owner) body.append("owner_name", owner);
        var ownerIdEl = modal.querySelector("[data-cc-owner-id]"); if (ownerIdEl && ownerIdEl.value) body.append("owner_id", ownerIdEl.value); // 대표자 콤보에서 선택/등록한 사람 id(정확 연결·중복 방지)
        cSave.disabled = true; err.classList.add("hidden");
        fetch("/clients", { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded", "X-Requested-With": "fetch" }, body: body.toString() })
          .then(function (r) { return r.ok ? r.json() : null; })
          .then(function (d) { if (!d || !d.ok) throw new Error("fail"); announceParty({ kind: "company", id: d.id, name: d.name }); if (ownerIdEl && ownerIdEl.value && owner) announceParty({ kind: "person", id: ownerIdEl.value, name: owner, company: d.name, job_title: "대표" }); input.value = d.name; closeModal(); fireInput(); hide(); if (window.__toast) window.__toast(d.name + " 등록됨"); }) // 회사 + 대표자 소속·직책(대표) 브로드캐스트
          .catch(function () { err.textContent = "등록 실패 — 다시 시도하세요."; err.classList.remove("hidden"); })
          .then(function () { cSave.disabled = false; });
      });
      // 대표자 미니콤보(모달 내부): 타이핑 검색(사람) + '＋ 새 연락처 등록'(fetch /contacts → data-cc-owner-id 채움).
      var ownInput = modal.querySelector("[data-cc-owner]"), ownHid = modal.querySelector("[data-cc-owner-id]"),
          ownPop = modal.querySelector("[data-cc-owner-pop]"), ownOptsEl = modal.querySelector("[data-cc-owner-options]");
      var ownOpts = []; try { ownOpts = JSON.parse((ownOptsEl && ownOptsEl.textContent) || "[]"); } catch (e) { ownOpts = []; }
      document.addEventListener("party-created", function (e) { var p = e.detail; if (!p || p.kind !== "person") return; if (!ownOpts.some(function (o) { return String(o.id) === String(p.id); })) ownOpts.push({ id: p.id, name: p.name }); }); // 새 사람 → 대표자 미니콤보 옵션에 추가
      if (ownInput && ownHid && ownPop) {
        var ownRowCls = "flex w-full cursor-pointer items-center justify-between gap-2 px-3 py-2 text-left text-sm hover:bg-elevated";
        var ownView = [];
        function ownHide() { ownPop.classList.add("hidden"); }
        function ownRender() {
          var q = ownInput.value.trim().toLowerCase();
          ownView = (q ? ownOpts.filter(function (o) { return String(o.name).toLowerCase().indexOf(q) !== -1; }) : ownOpts).slice(0, 10);
          var html = ownView.map(function (o, i) { return '<button type="button" class="' + ownRowCls + '" data-owneridx="' + i + '"><span class="truncate text-fg">' + esc(o.name) + '</span></button>'; }).join("");
          if (q && !ownView.some(function (o) { return String(o.name).toLowerCase() === q; })) html += '<button type="button" class="' + ownRowCls + ' text-primary" data-ownernew="1"><span class="truncate">＋ \'' + esc(ownInput.value.trim()) + '\'(으)로 새 연락처 등록</span><span class="shrink-0 text-xs text-muted">새로 등록</span></button>';
          ownPop.innerHTML = html || '<div class="px-3 py-2 text-sm text-muted">이름을 입력해 새 연락처로 등록</div>'; ownPop.classList.remove("hidden");
        }
        ownInput.addEventListener("focus", ownRender);
        ownInput.addEventListener("click", ownRender);
        ownInput.addEventListener("input", function () { ownHid.value = ""; ownRender(); }); // 타이핑 중 id 해제(선택·등록으로만 확정)
        ownInput.addEventListener("blur", function () { setTimeout(ownHide, 150); });
        ownPop.addEventListener("mousedown", function (e) { e.preventDefault(); });
        ownPop.addEventListener("click", function (e) {
          var b = e.target.closest("button"); if (!b) return;
          if (b.hasAttribute("data-owneridx")) { var o = ownView[Number(b.getAttribute("data-owneridx"))]; ownInput.value = o.name; ownHid.value = o.id; ownHide(); }
          else if (b.hasAttribute("data-ownernew")) {
            var nm = ownInput.value.trim(); if (!nm) return;
            b.disabled = true;
            var body2 = new URLSearchParams(); body2.append("name", nm);
            fetch("/contacts", { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded", "X-Requested-With": "fetch" }, body: body2.toString() })
              .then(function (r) { return r.ok ? r.json() : null; })
              .then(function (d) { if (!d || !d.ok) throw new Error("fail"); ownHid.value = d.id; ownInput.value = d.name; announceParty({ kind: "person", id: d.id, name: d.name }); ownHide(); })
              .catch(function () { b.disabled = false; });
          }
        });
        comboKbdNav(ownInput, ownPop); // 방향키·엔터 선택
      }
      // 모달 안에서 엔터 → 바깥 폼 제출 방지 + '등록'(cSave) 실행
      modal.addEventListener("keydown", function (e) {
        if (e.isComposing || e.keyCode === 229) return; // 한글 IME 조합 중 엔터(조합 확정용)는 무시
        if (e.key !== "Enter" || e.defaultPrevented || (e.target && e.target.tagName === "TEXTAREA")) return;
        e.preventDefault(); cSave.click();
      });
    }
    input.addEventListener("focus", render);
    input.addEventListener("click", render);
    input.addEventListener("input", function () { if (hidCC) hidCC.value = input.value; render(); }); // 제출용 숨김 업체명 동기화(타이핑·pick·모달 모두 fireInput로 도달)
    input.addEventListener("blur", function () { setTimeout(hide, 150); });
    pop.addEventListener("mousedown", function (e) { e.preventDefault(); });
    pop.addEventListener("click", function (e) {
      var b = e.target.closest("button"); if (!b) return;
      if (b.hasAttribute("data-idx")) { input.value = view[Number(b.getAttribute("data-idx"))].name; fireInput(); hide(); }
      else if (b.hasAttribute("data-new")) openModal();
    });
    comboKbdNav(input, pop); // 방향키 이동·엔터 선택
  });
})();

// 사람(연락처) 검색 콤보([data-person-combo]): 타이핑=기존 담당자 검색(전화·소속 표시), 빈 입력=[＋새 담당자 등록].
// 고객측 담당자·세션 디렉터(동적 다중 행)·클라이언트 담당자 공용. hidden id 동기화, '새 등록'=모달(fetch POST /contacts).
// window.__initPersonCombos(container)로 정적/동적 행 모두 초기화(디렉터 '+추가' clone도).
(function () {
  "use strict";
  function esc(s) { return String(s == null ? "" : s).replace(/[&<>"]/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]; }); }
  function initOne(root) {
    if (root.__pcInit) return; // 중복 초기화 방지(동적 행 재스캔 대비)
    root.__pcInit = true;
    var input = root.querySelector("[data-pc-input]");
    var hid = root.querySelector("[data-pc-id]");
    var hidName = root.querySelector("[data-pc-name-hidden]"); // 제출용 이름(보이는 칸은 name 없음 — Chrome 자동완성 회피)
    var pop = root.querySelector("[data-pc-pop]");
    var info = root.querySelector("[data-pc-info]");
    // 옵션: 인라인(data-pc-options) 또는 페이지 공유 스크립트(data-pc-options-ref로 참조, 중복 임베드 제거)
    var refId = root.getAttribute("data-pc-options-ref");
    var dataEl = refId ? document.getElementById(refId) : root.querySelector("[data-pc-options]");
    var modal = root.querySelector("[data-pc-modal]");
    if (!input || !hid || !pop) return; // dataEl 없어도 진행(옵션 빈 배열 — '새 등록'은 가능)
    var opts = [];
    try { opts = JSON.parse((dataEl && dataEl.textContent) || "[]"); } catch (e) { opts = []; }
    document.addEventListener("party-created", function (e) { // 어디서든 새 사람 생성/갱신되면 이 담당자 콤보 옵션에 반영
      var p = e.detail; if (!p || p.kind !== "person") return;
      var ex = opts.filter(function (o) { return String(o.id) === String(p.id); })[0];
      if (ex) { if (p.company) ex.company = p.company; if (p.job_title) ex.job_title = p.job_title; if (p.phone) ex.phone = p.phone; return; } // 기존 항목 갱신(소속·직책 등)
      opts.push({ id: p.id, name: p.name, phone: p.phone || "", email: p.email || "", company: p.company || "", job_title: p.job_title || "", group: p.group || "" });
    });
    var view = [];
    var rowCls = "flex w-full cursor-pointer items-center justify-between gap-2 px-3 py-2 text-left text-sm hover:bg-elevated";
    function hide() { pop.classList.add("hidden"); input.setAttribute("aria-expanded", "false"); }
    function show() { pop.classList.remove("hidden"); input.setAttribute("aria-expanded", "true"); }
    function fireInput() { input.dispatchEvent(new Event("input", { bubbles: true })); }
    function subOf(o) { return [o.group, o.company, o.phone].filter(Boolean).join(" · "); } // 소속 그룹·회사·전화로 식별
    function setInfo(o, isNew) {
      while (info.firstChild) info.removeChild(info.firstChild);
      var nodes = [];
      if (o && o.phone) { var a = document.createElement("button"); a.type = "button"; a.setAttribute("data-copy", o.phone); a.title = "클릭하면 복사됩니다"; a.textContent = "☎ " + o.phone; a.className = "font-medium text-info hover:underline"; nodes.push(a); }
      if (o && o.email) { var em = document.createElement("button"); em.type = "button"; em.setAttribute("data-copy", o.email); em.title = "클릭하면 복사됩니다"; em.textContent = "✉ " + o.email; em.className = "text-info hover:underline"; nodes.push(em); }
      // 소속 = 그룹 또는 회사 + 직책(예: '(주)크레오엔터테인먼트 대표')
      var org = o ? (o.group || o.company || "") : "";
      var aff = (org + (o && o.job_title ? " " + o.job_title : "")).trim();
      if (aff) { var s = document.createElement("span"); s.textContent = "소속: " + aff; nodes.push(s); }
      if (nodes.length) { nodes.forEach(function (n, i) { if (i > 0) info.appendChild(document.createTextNode("   ·   ")); info.appendChild(n); }); info.classList.remove("hidden"); }
      else if (isNew) { info.textContent = "새 연락처로 등록됩니다."; info.classList.remove("hidden"); }
      else { info.classList.add("hidden"); }
    }
    var entity = root.getAttribute("data-pc-entity") || "담당자";
    function newRow(nm) {
      var label = nm ? "'" + esc(nm) + "'(으)로 새 " + esc(entity) + " 등록" : "새 " + esc(entity) + " 등록";
      return '<button type="button" class="' + rowCls + ' text-primary" data-new="1"><span class="truncate">＋ ' + label + '</span><span class="shrink-0 text-xs text-muted">새로 등록</span></button>';
    }
    function render() {
      var q = input.value.trim().toLowerCase();
      var html = "";
      if (!q) { view = []; html = newRow(""); }
      else {
        view = opts.filter(function (o) { return String(o.name).toLowerCase().indexOf(q) !== -1; }).slice(0, 12);
        html = view.map(function (o, i) { return '<button type="button" class="' + rowCls + '" data-idx="' + i + '"><span class="truncate text-fg">' + esc(o.name) + '</span><span class="shrink-0 text-xs text-muted">' + esc(subOf(o)) + '</span></button>'; }).join("");
        if (!view.some(function (o) { return String(o.name).toLowerCase() === q; })) html += newRow(input.value.trim());
      }
      pop.innerHTML = html; show();
    }
    function pick(o) { input.value = o.name; hid.value = o.id; setInfo(o, false); fireInput(); hide(); }
    function openModal() {
      if (!modal) { hide(); return; }
      var n = modal.querySelector("[data-pc-name]"); n.value = input.value.trim();
      ["[data-pc-phone]", "[data-pc-email]", "[data-pc-company]", "[data-pc-job]"].forEach(function (s) { var el = modal.querySelector(s); if (el) el.value = ""; });
      modal.querySelector("[data-pc-err]").classList.add("hidden");
      modal.classList.remove("hidden"); modal.classList.add("flex"); hide(); n.focus();
    }
    if (modal) {
      var pSave = modal.querySelector("[data-pc-save]"), pCancel = modal.querySelector("[data-pc-cancel]");
      var closeModal = function () { modal.classList.add("hidden"); modal.classList.remove("flex"); };
      pCancel.addEventListener("click", closeModal);
      modal.addEventListener("click", function (e) { if (e.target === modal) closeModal(); });
      pSave.addEventListener("click", function () {
        var nm = modal.querySelector("[data-pc-name]").value.trim();
        var err = modal.querySelector("[data-pc-err]");
        if (!nm) { err.textContent = "이름을 입력하세요."; err.classList.remove("hidden"); return; }
        var phone = modal.querySelector("[data-pc-phone]").value.trim(), email = modal.querySelector("[data-pc-email]").value.trim(),
            company = modal.querySelector("[data-pc-company]").value.trim(), job = modal.querySelector("[data-pc-job]").value.trim();
        pSave.disabled = true; err.classList.add("hidden");
        var body = new URLSearchParams();
        body.append("name", nm);
        if (phone) body.append("phone", phone);
        if (email) body.append("email", email);
        if (company) body.append("company", company);
        if (job) body.append("job_title", job);
        fetch("/contacts", { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded", "X-Requested-With": "fetch" }, body: body.toString() })
          .then(function (r) { return r.ok ? r.json() : null; })
          .then(function (d) { if (!d || !d.ok) throw new Error("fail"); announceParty({ kind: "person", id: d.id, name: d.name, phone: phone, email: email, company: company }); input.value = d.name; hid.value = d.id; setInfo({ phone: phone, email: email, company: company }, true); closeModal(); fireInput(); hide(); if (window.__toast) window.__toast(d.name + " 등록됨"); }) // 전역 브로드캐스트 + 드롭다운 닫기
          .catch(function () { err.textContent = "등록 실패 — 다시 시도하세요."; err.classList.remove("hidden"); })
          .then(function () { pSave.disabled = false; });
      });
      // 모달 안에서 엔터 → 바깥 폼 제출 방지 + '등록'(pSave) 실행
      modal.addEventListener("keydown", function (e) {
        if (e.isComposing || e.keyCode === 229) return; // 한글 IME 조합 중 엔터(조합 확정용)는 무시
        if (e.key !== "Enter" || e.defaultPrevented || (e.target && e.target.tagName === "TEXTAREA")) return;
        e.preventDefault(); pSave.click();
      });
      // 모달 '회사' 검색 콤보 — 기존 업체 검색 + '＋ …(으)로 새 업체 등록'(입력 이름 유지, 저장 시 서버가 소속 회사 생성/연결).
      var coInput = modal.querySelector("[data-pc-company]"), coPop = modal.querySelector("[data-pc-company-pop]");
      if (coInput && coPop) {
        var coDataEl = modal.querySelector("[data-pc-company-options]");
        var coOpts = [];
        try { coOpts = JSON.parse((coDataEl && coDataEl.textContent) || "[]"); } catch (e2) { coOpts = []; }
        document.addEventListener("party-created", function (e) { var p = e.detail; if (!p || p.kind !== "company" || !p.name) return; if (!coOpts.some(function (o) { return String(o.name) === String(p.name); })) coOpts.push({ name: p.name }); }); // 새 업체 생성 시 옵션 반영
        var coView = [];
        var coHide = function () { coPop.classList.add("hidden"); coInput.setAttribute("aria-expanded", "false"); };
        var coShow = function () { coPop.classList.remove("hidden"); coInput.setAttribute("aria-expanded", "true"); };
        var coNewRow = function (nm) {
          var label = nm ? "'" + esc(nm) + "'(으)로 새 업체 등록" : "새 업체 등록";
          return '<button type="button" class="' + rowCls + ' text-primary" data-co-new="1"><span class="truncate">＋ ' + label + '</span><span class="shrink-0 text-xs text-muted">새로 등록</span></button>';
        };
        var coRender = function () {
          var q = coInput.value.trim().toLowerCase();
          coView = (q ? coOpts.filter(function (o) { return String(o.name).toLowerCase().indexOf(q) !== -1; }) : coOpts).slice(0, 10);
          var html = coView.map(function (o, i) { return '<button type="button" class="' + rowCls + '" data-co-idx="' + i + '"><span class="truncate text-fg">' + esc(o.name) + '</span><span class="shrink-0 text-xs text-muted">조직</span></button>'; }).join("");
          if (!coView.some(function (o) { return String(o.name).toLowerCase() === q; })) html += coNewRow(coInput.value.trim());
          coPop.innerHTML = html; coShow();
        };
        coInput.addEventListener("focus", coRender);
        coInput.addEventListener("click", coRender);
        coInput.addEventListener("input", coRender);
        coInput.addEventListener("blur", function () { setTimeout(coHide, 150); });
        coPop.addEventListener("mousedown", function (e) { e.preventDefault(); }); // 클릭 전 blur 방지
        coPop.addEventListener("click", function (e) {
          var b = e.target.closest("button"); if (!b) return;
          if (b.hasAttribute("data-co-idx")) coInput.value = coView[Number(b.getAttribute("data-co-idx"))].name; // 기존 업체 선택
          coHide(); // '새 업체 등록'은 입력한 이름 그대로 유지
        });
        comboKbdNav(coInput, coPop); // 방향키·엔터(하이라이트 선택 시 preventDefault → 모달 엔터 제출과 충돌 없음)
      }
    }
    input.addEventListener("focus", render);
    input.addEventListener("click", render);
    input.addEventListener("input", function () {
      if (hidName) hidName.value = input.value; // 제출용 숨김 이름 동기화(타이핑·pick·모달 모두 fireInput로 여기 도달)
      render();
      var v = input.value.trim().toLowerCase();
      var m = opts.filter(function (o) { return String(o.name).toLowerCase() === v; })[0];
      if (m) { hid.value = m.id; setInfo(m, false); } else { hid.value = ""; setInfo(null, !!v); }
    });
    input.addEventListener("blur", function () { setTimeout(hide, 150); });
    pop.addEventListener("mousedown", function (e) { e.preventDefault(); });
    pop.addEventListener("click", function (e) {
      var b = e.target.closest("button"); if (!b) return;
      if (b.hasAttribute("data-idx")) pick(view[Number(b.getAttribute("data-idx"))]);
      else if (b.hasAttribute("data-new")) openModal();
    });
    comboKbdNav(input, pop); // 방향키 이동·엔터 선택
    if (hid.value) { var init = opts.filter(function (o) { return String(o.id) === String(hid.value); })[0]; if (init) setInfo(init, false); } // 편집 초기값 정보
  }
  // 정적 + 동적(디렉터 '+추가' clone 등) 행 모두 초기화. container 지정 시 그 안(또는 자신)의 콤보만.
  window.__initPersonCombos = function (container) {
    var scope = container || document;
    Array.prototype.forEach.call(scope.querySelectorAll("[data-person-combo]"), initOne);
    if (container && container.matches && container.matches("[data-person-combo]")) initOne(container);
  };
  window.__initPersonCombos(document);
})();

// 청구처 콤보([data-picker-combo]): 클라이언트+담당자 검색, 선택 시 client_id 또는 payer_contact_id 세팅(다른 쪽 클리어)·닫힘.
// 다른 콤보와 동일 UX지만 '새로 등록'은 없음(청구처는 기존에서 고름). 정확 일치 없으면 둘 다 비움(서버 자동 매칭).
(function () {
  "use strict";
  function esc(s) { return String(s == null ? "" : s).replace(/[&<>"]/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]; }); }
  Array.prototype.forEach.call(document.querySelectorAll("[data-picker-combo]"), function (root) {
    var input = root.querySelector("[data-pk-input]");
    var cid = root.querySelector("[data-pk-cid]");
    var pid = root.querySelector("[data-pk-pid]");
    var pop = root.querySelector("[data-pk-pop]");
    var dataEl = root.querySelector("[data-pk-options]");
    if (!input || !cid || !pid || !pop || !dataEl) return;
    var items = [];
    try { items = JSON.parse(dataEl.textContent || "[]"); } catch (e) { items = []; }
    var view = [];
    // 청구처 유형에 따른 문서 라벨(회사=계산서 / 개인=현금영수증) + 발행 정보 누락 경고 + 인라인 입력(같은 폼 안 요소가 있을 때만).
    var form = root.closest ? root.closest("form") : null;
    var docLabel = form ? form.querySelector("[data-inv-doc]") : null;
    var fixBox = form ? form.querySelector("[data-payer-fix]") : null; // 경고+입력 컨테이너
    var warnEl = form ? form.querySelector("[data-payer-warn]") : null;
    var fixInput = form ? form.querySelector("[data-payer-fix-input]") : null;
    var fixBtn = form ? form.querySelector("[data-payer-fix-btn]") : null;
    function applyDoc(it) {
      if (docLabel) docLabel.textContent = (it && !it.co) ? "(현금영수증 발행)" : "(계산서 발행)";
      if (fixBox) {
        if (it && it.warn) {
          if (warnEl) warnEl.textContent = "⚠️ " + it.warn;
          if (fixInput) { fixInput.placeholder = it.co ? "사업자등록번호 (예: 000-00-00000)" : "현금영수증 정보 (휴대폰 번호 등)"; fixInput.value = ""; }
          fixBox.classList.remove("hidden");
        } else fixBox.classList.add("hidden");
      }
    }
    // 발행 정보 인라인 저장 — 경고 아래 입력칸+버튼. 저장되면 버튼 하이라이트 후 경고 숨김·차단 해제.
    if (fixBtn) {
      fixBtn.addEventListener("click", function () {
        var partyId = cid.value || pid.value;
        var value = (fixInput && fixInput.value ? fixInput.value : "").trim();
        if (!partyId || !value) { if (fixInput) fixInput.focus(); return; }
        fixBtn.disabled = true;
        var body = new URLSearchParams(); body.append("party_id", partyId); body.append("value", value);
        fetch("/projects/payer-info", { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded", "X-Requested-With": "fetch" }, body: body.toString() })
          .then(function (r) { return r.ok ? r.json() : null; })
          .then(function (d) {
            if (!d || !d.ok) throw new Error("fail");
            var it = items.filter(function (x) { return (cid.value && String(x.cid) === String(cid.value)) || (pid.value && String(x.pid) === String(pid.value)); })[0];
            if (it) it.warn = ""; // 차단 해제
            var orig = fixBtn.textContent;
            fixBtn.textContent = "저장됨 ✓";
            fixBtn.style.transition = "box-shadow .2s";
            fixBtn.style.boxShadow = "0 0 0 4px rgba(74,222,128,0.7)"; // 눈에 띄는 하이라이트 한번
            if (window.__toast) window.__toast("청구처 정보에 저장되었습니다");
            setTimeout(function () { fixBtn.style.boxShadow = ""; fixBtn.textContent = orig; if (fixBox) fixBox.classList.add("hidden"); }, 1300);
          })
          .catch(function () { if (window.__toast) window.__toast("저장 실패 — 다시 시도하세요"); })
          .then(function () { fixBtn.disabled = false; });
      });
    }
    // 청구 생성 버튼 제출 차단 — 발행 정보 누락(경고 표시 중)이면 생성 불가(PDF 프리뷰 버튼은 formaction이라 허용).
    if (form) {
      form.addEventListener("submit", function (e) {
        if (e.submitter && e.submitter.hasAttribute && e.submitter.hasAttribute("data-invoice-submit") && fixBox && !fixBox.classList.contains("hidden")) {
          e.preventDefault();
          window.alert(((warnEl && warnEl.textContent) || "청구처 발행 정보가 없습니다.").replace(/^⚠️\s*/, "") + "\n\n아래 칸에 정보를 입력해 저장한 뒤 청구할 수 있습니다.");
        }
      });
    }
    var rowCls = "flex w-full cursor-pointer items-center justify-between gap-2 px-3 py-2 text-left text-sm hover:bg-elevated";
    function hide() { pop.classList.add("hidden"); input.setAttribute("aria-expanded", "false"); }
    function show() { pop.classList.remove("hidden"); input.setAttribute("aria-expanded", "true"); }
    function fireInput() { input.dispatchEvent(new Event("input", { bubbles: true })); }
    function labelFull(it) { return it.sub ? it.label + " · " + it.sub : it.label; }
    function render() {
      var q = input.value.trim().toLowerCase();
      view = (q ? items.filter(function (it) { return String(it.label).toLowerCase().indexOf(q) !== -1 || String(it.sub || "").toLowerCase().indexOf(q) !== -1; }) : items).slice(0, 15);
      pop.innerHTML = view.length
        ? view.map(function (it, i) { return '<button type="button" class="' + rowCls + '" data-idx="' + i + '"><span class="truncate text-fg">' + esc(it.label) + '</span><span class="shrink-0 text-xs text-muted">' + esc(it.sub || "") + '</span></button>'; }).join("")
        : '<div class="px-3 py-2 text-sm text-muted">검색 결과 없음 · 비워 두면 자동 연결</div>';
      show();
    }
    function pick(it) { if (!it) return; input.value = labelFull(it); cid.value = it.cid || ""; pid.value = it.pid || ""; applyDoc(it); fireInput(); hide(); }
    input.addEventListener("focus", render);
    input.addEventListener("click", render);
    input.addEventListener("input", function () {
      render();
      var v = input.value.trim().toLowerCase();
      var m = items.filter(function (it) { return labelFull(it).toLowerCase() === v || String(it.label).toLowerCase() === v; })[0];
      if (m) { cid.value = m.cid || ""; pid.value = m.pid || ""; } else { cid.value = ""; pid.value = ""; } // 정확 일치 아니면 비움(자동 매칭)
      applyDoc(m);
    });
    input.addEventListener("blur", function () { setTimeout(hide, 150); });
    pop.addEventListener("mousedown", function (e) { e.preventDefault(); });
    pop.addEventListener("click", function (e) { var b = e.target.closest("button"); if (!b) return; if (b.hasAttribute("data-idx")) pick(view[Number(b.getAttribute("data-idx"))]); });
    comboKbdNav(input, pop); // 방향키 이동·엔터 선택
    // 초기 선택(서버 렌더된 기본 청구처)에 맞춰 문서 라벨·경고 표시
    applyDoc(items.filter(function (it) { return (cid.value && String(it.cid) === String(cid.value)) || (pid.value && String(it.pid) === String(pid.value)); })[0]);
  });
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

// 클라이언트 목록: 상세 갔다 돌아오면 스크롤 위치 복원(필터는 서버 ?from= 로 백링크에 유지).
// 상세 링크 클릭 시 현재 목록 URL+스크롤을 저장하고, 같은 URL로 목록이 다시 로드되면 스크롤 복원.
(function () {
  "use strict";
  if (!/^\/clients\/?$/.test(location.pathname)) return;
  var KEY = "clientsScroll";
  var here = location.pathname + location.search;
  try {
    var raw = sessionStorage.getItem(KEY);
    if (raw) {
      var o = JSON.parse(raw);
      if (o && o.url === here) window.scrollTo(0, o.y || 0);
      sessionStorage.removeItem(KEY);
    }
  } catch (e) {}
  document.addEventListener("click", function (e) {
    var a = e.target.closest && e.target.closest('a[href^="/clients/"]');
    if (a) { try { sessionStorage.setItem(KEY, JSON.stringify({ url: here, y: window.scrollY })); } catch (_e) {} }
  });
})();
