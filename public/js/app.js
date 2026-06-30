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
  var customStartWrap = form.querySelector("[data-custom-start-wrap]");
  var customStartToggle = form.querySelector("[data-custom-start-toggle]");
  var preview = form.querySelector("[data-end-preview]");
  var slider = form.querySelector("[data-duration-slider]");
  var durLabel = form.querySelector("[data-duration-label]");
  var customInput = form.querySelector("[data-custom-hours]");
  var presets = form.querySelectorAll("[data-duration-preset]");
  var sessionTypeSel = form.querySelector('select[name="session_type"]');
  var roomSel = form.querySelector('select[name="room_id"]');
  var showWhenRec = form.querySelectorAll('[data-show-when="rec"]');
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
  if (rateSel) rateSel.addEventListener("change", function () { updateProAvailability(); updatePreview(); });
  if (sessionTypeSel) sessionTypeSel.addEventListener("change", syncRecFields);
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
  syncRecFields();
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
    amtInput.value = clamp(Math.round(supply() * pct / 100));
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

// 클라이언트 폼: 아티스트(개인)는 사업자등록번호·대표자·주소가 없으므로 분류=아티스트면 세금정보 숨김.
(function () {
  "use strict";
  var kindSel = document.querySelector("[data-client-kind]");
  var tax = document.querySelector("[data-client-tax]");
  if (!kindSel || !tax) return;
  function sync() { tax.hidden = kindSel.value === "아티스트"; }
  kindSel.addEventListener("change", sync);
  sync();
})();

// 검색형 콤보박스(실결제자·클라이언트 담당자): <input list> 검색값 ↔ hidden id 동기화. 목록 라벨과 정확히 일치할 때만 id 설정(아니면 미지정).
// [data-client-combo](client_id)·[data-contact-combo](contact_id) 둘 다 같은 로직으로 처리(셀렉터 OR).
(function () {
  "use strict";
  var combos = document.querySelectorAll("[data-client-combo], [data-contact-combo]");
  if (!combos.length) return;
  Array.prototype.forEach.call(combos, function (wrap) {
    var search = wrap.querySelector("[data-client-search], [data-contact-search]");
    var hidden = wrap.querySelector("[data-client-id], [data-contact-id]");
    var listEl = search ? document.getElementById(search.getAttribute("list")) : null;
    var info = wrap.querySelector("[data-contact-info]"); // 고객측 담당자 콤보에만 있음(전화·이메일·소속 표시)
    var payerContact = wrap.querySelector("[data-payer-contact-id]"); // 청구처 콤보에만(담당자를 청구처로 선택 시 contact_id)
    if (!search || !hidden || !listEl) return;
    function sync() {
      var v = search.value.trim();
      var id = "", contactId = "", matched = null;
      for (var i = 0; i < listEl.options.length; i++) {
        if (listEl.options[i].value === v) { matched = listEl.options[i]; id = matched.getAttribute("data-id") || ""; contactId = matched.getAttribute("data-contact-id") || ""; break; }
      }
      hidden.value = id;
      if (payerContact) payerContact.value = contactId;
      if (info) {
        while (info.firstChild) info.removeChild(info.firstChild); // CSP-safe: innerHTML 대신 노드 생성
        if (matched) {
          var ph = matched.getAttribute("data-phone");
          var em = matched.getAttribute("data-email");
          var cl = matched.getAttribute("data-client");
          var nodes = [];
          if (ph) { var an = document.createElement("a"); an.href = "tel:" + ph.replace(/[^0-9+]/g, ""); an.textContent = "☎ " + ph; an.className = "font-medium text-info"; nodes.push(an); }
          if (em) { var ae = document.createElement("a"); ae.href = "mailto:" + em; ae.textContent = "✉ " + em; ae.className = "text-info"; nodes.push(ae); }
          if (cl) { var sp = document.createElement("span"); sp.textContent = "소속: " + cl; nodes.push(sp); }
          nodes.forEach(function (node, idx) { if (idx > 0) info.appendChild(document.createTextNode("   ·   ")); info.appendChild(node); });
          info.classList.toggle("hidden", nodes.length === 0);
        } else if (v) {
          info.textContent = "목록에 없는 이름 — 저장 시 새 연락처로 등록됩니다.";
          info.classList.remove("hidden");
        } else {
          info.classList.add("hidden");
        }
      }
    }
    search.addEventListener("input", sync);
    search.addEventListener("change", sync);
    search.addEventListener("blur", sync);
    sync(); // 초기 로드 시 기존 선택값 정보 표시
  });
})();

// 곡·콘텐츠 작업 폼: 담당 엔지니어가 외주(data-external=1)일 때만 외주 지급단가 표시(하우스 엔지니어는 숨김).
(function () {
  "use strict";
  var forms = document.querySelectorAll("[data-task-form]");
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

// 곡·콘텐츠 작업 폼 자동저장([data-task-form]): 입력 변경 시 디바운스 후 저장. progressive-enhancement(JS 등록 성공 시 제출 버튼 숨김·실패 시 폴백 유지).
(function () {
  "use strict";
  try {
    var forms = document.querySelectorAll("[data-task-form]");
    if (!forms.length) return;
    Array.prototype.forEach.call(forms, function (form) {
      var details = form.closest("details");
      var amountEl = details && details.querySelector("[data-row-amount]");
      var statusEl = details && details.querySelector("[data-row-status]");
      var state = form.querySelector("[data-save-state]");
      var btn = form.querySelector("[data-task-save-btn]");
      var timer = null, ctrl = null, reqId = 0;
      function save() {
        if (state) state.textContent = "저장 중…";
        if (ctrl) ctrl.abort(); // 직전 in-flight 요청 취소(race 방지)
        ctrl = new AbortController();
        var myId = ++reqId;
        fetch(form.getAttribute("action"), { method: "POST", body: new FormData(form), headers: { "X-Requested-With": "fetch" }, signal: ctrl.signal })
          .then(function (r) { return r.ok ? r.json() : Promise.reject(r.status); })
          .then(function (j) {
            if (myId !== reqId) return; // 더 최신 저장이 진행 중이면 stale 응답 무시
            if (amountEl && j.amount != null) amountEl.textContent = j.amount;
            if (statusEl) { if (j.statusLabel != null) statusEl.textContent = j.statusLabel; if (j.statusCls) statusEl.className = "badge " + j.statusCls; }
            if (state) { state.textContent = "저장됨"; setTimeout(function () { if (state.textContent === "저장됨") state.textContent = ""; }, 1500); }
          })
          .catch(function (e) { if (e && e.name === "AbortError") return; if (state) state.textContent = "저장 실패 — 잠시 후 다시"; });
      }
      function schedule() { clearTimeout(timer); timer = setTimeout(save, 700); }
      form.addEventListener("input", schedule);
      form.addEventListener("change", function (e) {
        if (e.target && e.target.tagName === "SELECT") { clearTimeout(timer); save(); } else schedule(); // select(종류·담당·상태)는 즉시, 텍스트는 디바운스
      });
      if (btn) btn.hidden = true; // 핸들러 등록 성공 후 수동 버튼 숨김(등록 실패 시 버튼이 폴백)
    });
  } catch (err) { /* 자동저장 초기화 실패 시 폼 제출 버튼(data-task-save-btn)이 폴백으로 동작 */ }
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
    zone.addEventListener("dragover", function (e) { e.preventDefault(); highlight(true); });
    zone.addEventListener("dragenter", function (e) { e.preventDefault(); highlight(true); });
    zone.addEventListener("dragleave", function () { highlight(false); });

    // 드롭: input.files에 할당 + 파일명 표시(DataTransfer API, 현대 브라우저)
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
    });

    // 파일 선택(클릭) 후 파일명 표시
    input.addEventListener("change", function () {
      if (input.files && input.files[0] && label) label.textContent = input.files[0].name;
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
