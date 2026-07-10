// 스크롤 위치 보존 — 폼 제출 후 같은 페이지로 돌아올 때 맨 위로 튀지 않고 원래 보던 위치 유지.
// 2026-07-05 사용자 리포트 2건: ①프로젝트 목록에서 작성일 인라인 수정 시 목록이 재정렬되며 페이지 전체가
// 새로고침돼 맨 위로 튐 ②청구 목록의 계산서·입금 처리 토글도 동일 — 발행필요→발행완료로 카드가 탭을 옮기며
// 스크롤이 맨 위로, 같은 탭에 남는 토글도 재로드 자체는 일어나 깜빡이는 느낌. 제출 직전 스크롤 저장(전 폼 공통,
// PDF 미리보기 등 새 탭 제출은 현재 페이지가 안 바뀌므로 제외), 페이지 로드 시 같은 경로(pathname)면 1회
// 복원(쿼리의 flash= 등 차이는 무시) 후 삭제 — 일반 이동에는 영향 없음.
(function () {
  "use strict";
  var KEY = "scrollPos:" + location.pathname;
  try {
    var raw = sessionStorage.getItem(KEY);
    if (raw != null) {
      sessionStorage.removeItem(KEY);
      window.scrollTo(0, parseInt(raw, 10) || 0);
    }
  } catch (e) {}
  document.addEventListener("submit", function (e) {
    var f = e.target;
    if (!f || (e.submitter && e.submitter.getAttribute("formtarget") === "_blank")) return;
    try { sessionStorage.setItem("scrollPos:" + location.pathname, String(window.scrollY)); } catch (_e) {}
  }, true);
})();

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
    // requestSubmit: 실제 submit 이벤트 발화(콤마정리·드래프트 핸들러·스크롤 위치 저장 IIFE 전부 동작).
    if (field && field.form) { if (field.form.requestSubmit) field.form.requestSubmit(); else field.form.submit(); }
  });

  // ([data-copy] 클릭 복사는 상단 토스트 IIFE가 단일 담당 — 2026-07-09 감사: 여기 있던 두 번째 핸들러가
  //  복사 2회 실행 + 토스트/'복사됨' 이중 피드백을 내던 중복 등록이라 제거.)

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
  // 접힌 편집 폼(<details>)은 처음 펼칠 때 1회 초기화 — 대량 목록에서 로드 시 전 폼을 즉시 초기화하던 비용(시간목록·콤보·슬라이더 등) 회피(2026-07-10 스케일 점검).
  Array.prototype.forEach.call(document.querySelectorAll("[data-session-form]"), function (form) {
    var det = form.closest("details");
    if (det && !det.open) {
      det.addEventListener("toggle", function onOpen() {
        if (det.open) { det.removeEventListener("toggle", onOpen); initSessionForm(form); }
      });
    } else {
      initSessionForm(form); // 이미 보이는 폼(추가 폼·서버가 펼쳐 렌더한 편집 폼)은 즉시
    }
  });

  function initSessionForm(form) {
  var dateInput = form.querySelector("[data-session-date]");
  var rateSel = form.querySelector("[data-rate-select]");
  var startInput = form.querySelector("[data-start-input]"); // 구글식 시작 시간 타이핑 박스(name=start_time, 2026-07-04 그리드 폐지)
  var endInput = form.querySelector("[data-end-input]"); // 종료 시간 박스(name=end_time) — 슬라이더와 양방향 동기
  var endDate = form.querySelector("[data-end-date]"); // 종료 날짜(자동 표시 — 자정 넘김이면 +1일, 저장 필드 아님)
  var allDay = form.querySelector("[data-all-day]"); // 종일 토글 — 운영시간 전체로 시작·소요 세팅
  var durationWrap = form.querySelector("[data-duration-wrap]"); // 소요 시간 헤딩+슬라이더 블록(종일 시 숨김)
  var slider = form.querySelector("[data-duration-slider]");
  var durLabel = form.querySelector("[data-duration-label]");
  var customInput = form.querySelector("[data-custom-hours]");
  var presets = form.querySelectorAll("[data-duration-preset]");
  var sessionTypeSel = form.querySelector('select[name="session_type"]');
  var roomSel = form.querySelector('select[name="room_id"]');
  var externalLoc = form.querySelector("[data-external-loc]"); // 외부 장소 주소 입력(장소=외부일 때만 노출)
  var showWhenRec = form.querySelectorAll('[data-show-when="rec"]');
  var conflictWarn = form.querySelector("[data-conflict-warn]");
  var overrideField = form.querySelector("[data-override-conflict]");
  var SLIDER_MAX = slider ? parseInt(slider.max, 10) || 960 : 960;
  var busy = {};

  var durGroup = form.querySelector("[data-duration-group]");
  function pad(n) { return (n < 10 ? "0" : "") + n; }
  // 대관(단가 청구) 세션 판정 — 세션 종류 select의 data-rec-types(예: "녹음,촬영") 참조. 녹음 단가 필드·프리셋 노출 기준.
  function isRecType() {
    if (!sessionTypeSel) return false;
    var raw = sessionTypeSel.getAttribute("data-rec-types") || "녹음";
    return raw.split(",").indexOf(sessionTypeSel.value) !== -1;
  }
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
    // 1Pro 기본: 단가 기준시간 우선, 없으면(미지정 포함) 스튜디오 기본 블록 — 프리셋과 동일 폴백(새 작성 종료 프리필의 기준).
    var def = baseMinutes() || proDefaultMinutes();
    if (def > 0) setDuration(def);
  }
  function currentStart() { return startInput ? startInput.value : ""; }
  // 시간 값 기록: 보이는 입력 + 제출용 hidden(data-time-hidden) 동시(보이는 입력은 nameless — 자동완성 차단).
  function syncTimeHidden(el) {
    if (!el || !el.closest) return;
    var w = el.closest("[data-time-combo]");
    var h = w && w.querySelector("[data-time-hidden]");
    if (h) h.value = el.value;
  }
  function writeTime(el, v) { if (el) { el.value = v; syncTimeHidden(el); } }
  function addMin(hhmm, mins) {
    var p = String(hhmm).split(":");
    if (p.length !== 2) return "";
    var t = (parseInt(p[0], 10) * 60 + parseInt(p[1], 10) + mins) % 1440;
    if (t < 0) t += 1440;
    return pad(Math.floor(t / 60)) + ":" + pad(t % 60);
  }
  function fmtHours(h) { return h % 1 === 0 ? String(h) : h.toFixed(1); }
  // 소요시간(분) 단일 진실원천 = curDur. custom_hours는 ≤960(16h)일 때만 미러 —
  // 초과(종일 23:59 등)는 hours를 비워 서버가 end_time을 그대로 쓰게(960 클램프 왜곡 방지).
  var curDur = (function () {
    var h = parseFloat(customInput && customInput.value);
    if (h > 0) return Math.round(h * 60);
    var sm = toMin(startInput && startInput.value), em = toMin(endInput && endInput.value);
    if (sm != null && em != null) { var d = em - sm; if (d <= 0) d += 1440; return d; } // 야간 포함(편집 초기값)
    return 0;
  })();
  function durationMinutes() { return curDur; }
  function fmtDuration(mins) {
    if (!(mins > 0)) return "설정 안 함";
    var hh = Math.floor(mins / 60), mm = mins % 60;
    return ((hh ? hh + "시간" : "") + (mm ? (hh ? " " : "") + mm + "분" : "")) || "0분";
  }
  // 한 값을 curDur·custom_hours·슬라이더·라벨에 일괄 반영(프리셋·종료 역산·초기화용).
  function setDuration(mins) {
    curDur = mins > 0 ? Math.min(Math.round(mins), 1439) : 0; // 1439=24h-1분(스키마 표현 한계)
    if (customInput) customInput.value = curDur > 0 && curDur <= SLIDER_MAX ? fmtHours(curDur / 60) : ""; // hidden 제출값(>16h=빈값 → 서버 end_time 경로)
    if (slider) slider.value = Math.min(curDur, SLIDER_MAX);
    refreshDuration();
  }
  function refreshDuration() {
    if (durLabel) durLabel.textContent = allDay && allDay.checked ? "종일" : fmtDuration(curDur);
    updatePreview();
  }
  // (그리드 폐지 — busy 슬롯은 겹침 경고(overlapDetected) 계산에만 쓴다)
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
    if (conflictWarn) conflictWarn.hidden = (allDay && allDay.checked) || !overlapDetected(); // 종일은 시간 점유 없음 → 경고 없음
  }
  // 세션 종류 kind(녹음→recording·촬영→filming) — 세션 종류 select data-rate-kinds="녹음:recording,촬영:filming"
  function rateKindOf(type) {
    var raw = sessionTypeSel ? (sessionTypeSel.getAttribute("data-rate-kinds") || "") : "";
    var map = {};
    raw.split(",").forEach(function (p) { var kv = p.split(":"); if (kv[0]) map[kv[0].trim()] = (kv[1] || "").trim(); });
    return map[type] || "recording";
  }
  // 세션 종류에 맞춰 단가 select 옵션을 녹음/촬영 템플릿으로 교체 — 촬영 고르면 촬영 단가만 보이게.
  function swapRateOptions() {
    if (!rateSel || !sessionTypeSel) return;
    var tpl = form.querySelector("[data-rate-opts-" + rateKindOf(sessionTypeSel.value) + "]");
    if (tpl && rateSel.innerHTML !== tpl.innerHTML) rateSel.innerHTML = tpl.innerHTML;
  }
  // 대관 세션(녹음·촬영)일 때만 [data-show-when="rec"] 요소 표시 + 종류에 맞는 단가 옵션으로 교체.
  function syncRecFields() {
    swapRateOptions();
    var isRec = isRecType();
    Array.prototype.forEach.call(showWhenRec, function (el) { el.hidden = !isRec; });
  }
  // 1Pro~4Pro 프리셋: 녹음 단가 기준시간이 있으면 그걸, 없으면 스튜디오 기본 블록(proDefault)을 기준으로 항상 활성.
  // positionTicks도 같은 폴백으로 위치를 잡으므로 일관. 세션 종류·룸 예약과 무관하게 프리셋 클릭 가능(사용자 요청).
  function updateProAvailability() {
    var base = baseMinutes() || proDefaultMinutes();
    Array.prototype.forEach.call(presets, function (b) { b.disabled = base <= 0; });
    positionTicks();
  }
  // Pro 눈금을 슬라이더 값 위치에 맞춰 재배치: 1Pro=기준시간, 2Pro=×2…(기준=녹음 단가 기준시간, 없으면 스튜디오 기본).
  // 양 끝(0%/100%)은 잘리지 않게 정렬 기준(translateX)을 바꾼다. 서버 초기 렌더와 동일 규칙.
  function positionTicks() {
    // 모바일(<640px): 절대배치 안 함 — 인라인 위치 제거하고 정적 흐름(flex)으로 앞에서부터 정렬(사용자 요청).
    var desktop = !window.matchMedia || window.matchMedia("(min-width: 640px)").matches;
    var base = baseMinutes() || proDefaultMinutes();
    Array.prototype.forEach.call(presets, function (b) {
      if (!desktop) { b.style.left = ""; b.style.transform = ""; return; }
      if (!(base > 0)) return;
      var mult = parseInt(String(b.getAttribute("data-duration-preset") || "pro1").replace("pro", ""), 10) || 1;
      var pos = Math.min(100, (base * mult / SLIDER_MAX) * 100);
      var t = pos <= 5 ? "0" : pos >= 95 ? "-100%" : "-50%";
      b.style.left = pos + "%";
      b.style.transform = "translateX(" + t + ")";
    });
  }
  // YYYY-MM-DD에 일수 더하기(종료 날짜 자동 표시용).
  function addDays(ymd, days) {
    var t = new Date(String(ymd) + "T00:00:00"); // 로컬 자정 기준
    if (isNaN(t)) return ymd || "";
    t.setDate(t.getDate() + days);
    // toISOString은 UTC 변환이라 KST에서 하루 밀림 — 로컬 파트로 조립.
    var mm = t.getMonth() + 1, dd = t.getDate();
    return t.getFullYear() + "-" + (mm < 10 ? "0" : "") + mm + "-" + (dd < 10 ? "0" : "") + dd;
  }
  function updatePreview() {
    // 종일: 시간·종료날짜 자동 동기 안 함 — 종료 날짜는 사용자가 지정한 다일(예: 2/5~2/9) 값을 그대로 보존.
    if (allDay && allDay.checked) { updateConflictWarn(); return; }
    var start = currentStart();
    var mins = durationMinutes();
    var sMin = toMin(start);
    // 종료 박스·종료 날짜 자동 동기(구글식): 시작+소요 → 종료. 자정 넘김이면 종료 날짜 +1일. 사용자가 편집 중인 칸은 덮지 않음.
    if (endInput && sMin != null && mins > 0 && document.activeElement !== endInput) writeTime(endInput, addMin(start, mins));
    if (endDate && dateInput && document.activeElement !== endDate) endDate.value = sMin != null && mins > 0 && sMin + mins >= 1440 ? addDays(dateInput.value, 1) : dateInput.value || "";
    updateConflictWarn();
  }
  function refreshAvailability() {
    if (!dateInput || !dateInput.value) return;
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
        updatePreview();
      })
      .catch(function () {});
  }

  // 장소 = 외부 장소(선택 옵션 data-external=1)면 주소 입력 노출. 초기 + 변경 시 반영.
  function syncExternalLoc() {
    if (!externalLoc || !roomSel) return;
    var opt = roomSel.options[roomSel.selectedIndex];
    externalLoc.hidden = !(opt && opt.getAttribute("data-external") === "1");
  }
  if (roomSel) roomSel.addEventListener("change", syncExternalLoc);
  syncExternalLoc();
  if (dateInput) dateInput.addEventListener("change", function () { refreshAvailability(); updatePreview(); });
  // 날짜 입력(datepick): 클릭/포커스 시 네이티브 달력 팝업(showPicker — 아이콘은 CSS로 숨김, 타이핑은 그대로).
  Array.prototype.forEach.call(form.querySelectorAll("input[data-datepick]"), function (el) {
    var open = function () { if (el.showPicker && !el.readOnly) { try { el.showPicker(); } catch (_e) { /* 사용자 제스처 밖 등 — 무시 */ } } };
    el.addEventListener("click", open);
    el.addEventListener("focus", open);
  });
  // 종료 날짜 직접 편집(구글식): 시작 날짜와의 일수 차 + 종료 시각으로 소요 역산(<24h만 표현 가능 — 밖이면 자동 보정).
  if (endDate) endDate.addEventListener("change", function () {
    var sMin = toMin(currentStart()), eMin = toMin(endInput ? endInput.value : "");
    if (sMin == null || eMin == null || !dateInput || !dateInput.value || !endDate.value) return updatePreview();
    var dayDiff = Math.round((new Date(endDate.value + "T00:00:00") - new Date(dateInput.value + "T00:00:00")) / 86400000);
    var dur = dayDiff * 1440 + eMin - sMin;
    if (dur > 0 && dur < 1440) setDuration(dur);
    else updatePreview(); // 표현 불가(0 이하·24h 이상) → canonical로 되돌림
  });
  if (roomSel) roomSel.addEventListener("change", refreshAvailability); // 룸 변경 시 해당 룸 기준으로 가용성 재조회(날짜 변경과 동일)
  // 단가 항목 선택은 소요시간을 바꾸지 않는다(시간 흐름 우선·사용자 요청 2026-07-05). 1Pro는 프리셋 버튼으로 수동 적용.
  if (rateSel) rateSel.addEventListener("change", function () { updateProAvailability(); updatePreview(); }); // Pro 눈금 위치만 갱신
  // 세션 종류 변경: 단가 옵션/버튼 노출 갱신. 소요는 이미 잡혀 있으면(사용자 시간 흐름) 건드리지 않고, 미설정일 때만 기본값 채움.
  if (sessionTypeSel) sessionTypeSel.addEventListener("change", function () { syncRecFields(); updateProAvailability(); if (durationMinutes() === 0) applyTypeDefault(); });
  // 슬라이더 드래그(30분 단위) → curDur.
  if (slider) slider.addEventListener("input", function () { setDuration(parseInt(slider.value, 10) || 0); });
  // 1~4Pro 프리셋 → 기준시간(1Pro)×N으로 슬라이더·직접입력 채움("pro3"→base×3).
  Array.prototype.forEach.call(presets, function (b) {
    b.addEventListener("click", function () {
      var base = baseMinutes() || proDefaultMinutes(); // 단가 없으면 스튜디오 기본 블록 기준(녹음이면 단가 기준시간)
      if (base <= 0) return;
      var mult = parseInt(String(b.getAttribute("data-duration-preset") || "pro1").replace("pro", ""), 10) || 1;
      setDuration(base * mult);
    });
  });
  window.addEventListener("resize", positionTicks); // 모바일↔데스크톱 전환 시 Pro 눈금 재배치(모바일=흐름·데스크톱=위치정렬)
  // 시간 박스 공용: 숫자만 받아 HH:MM 자동 포맷("1425"→"14:25").
  function attachTimeFormat(el, onValid) {
    if (!el) return;
    el.addEventListener("input", function () {
      var digits = el.value.replace(/[^0-9]/g, "").slice(0, 4);
      el.value = digits.length >= 3 ? digits.slice(0, 2) + ":" + digits.slice(2) : digits;
      syncTimeHidden(el); // 제출용 hidden 동기화(보이는 입력은 nameless)
      if (onValid && toMin(el.value) != null) onValid();
      updatePreview();
    });
  }
  // 시간 콤보([data-time-combo]): 포커스 시 전체선택 + 30분 단위 목록(현재 값 근처로 스크롤), 선택=클릭.
  Array.prototype.forEach.call(form.querySelectorAll("[data-time-combo]"), function (wrap) {
    var inp = wrap.querySelector('input[type="text"]'); // 첫 input은 제출용 hidden — 보이는 텍스트 입력을 잡는다
    var pop = wrap.querySelector("[data-time-pop]");
    if (!inp || !pop) return;
    // 30분 단위 목록(00:00~23:30)은 여기서 생성 — 서버가 폼마다 96개 버튼을 렌더하면 세션 목록 HTML이 불어(스케일 점검) 빈 pop만 렌더한다.
    if (!pop.firstElementChild) {
      var timeHtml = "";
      for (var ti = 0; ti < 48; ti++) {
        var th = Math.floor(ti / 2);
        var tt = (th < 10 ? "0" + th : "" + th) + ":" + (ti % 2 ? "30" : "00");
        timeHtml += '<button type="button" class="block w-full px-3 py-1.5 text-center text-sm tabular hover:bg-elevated active:bg-elevated" data-time-opt="' + tt + '">' + tt + "</button>";
      }
      pop.innerHTML = timeHtml;
    }
    function openPop() {
      if (inp.readOnly) return;
      pop.classList.remove("hidden");
      var cur = toMin(inp.value);
      if (cur != null) {
        var near = pop.querySelector('[data-time-opt="' + (inp.value.length === 5 ? inp.value : "") + '"]');
        if (!near) { // 30분 격자 밖 값 → 가장 가까운 슬롯
          var slot = Math.round(cur / 30) * 30 % 1440;
          near = pop.querySelector('[data-time-opt="' + addMin("00:00", slot) + '"]');
        }
        if (near && near.scrollIntoView) near.scrollIntoView({ block: "start" }); // 미리 작성된 시간이 목록 최상단에 오게
      }
    }
    function closePop() { pop.classList.add("hidden"); }
    inp.addEventListener("focus", function () { inp.select(); openPop(); }); // 전체선택 → 타이핑만으로 교체
    inp.addEventListener("click", openPop);
    inp.addEventListener("blur", closePop);
    pop.addEventListener("mousedown", function (e) { e.preventDefault(); }); // 클릭 전 blur 방지
    pop.addEventListener("click", function (e) {
      var b = e.target.closest && e.target.closest("[data-time-opt]");
      if (!b) return;
      inp.value = b.getAttribute("data-time-opt");
      inp.dispatchEvent(new Event("input", { bubbles: true })); // 콜론 포맷·역산 파이프라인 재사용
      closePop();
      inp.blur();
    });
    inp.addEventListener("keydown", function (e) {
      if (e.isComposing || e.keyCode === 229) return; // IME 조합 중 무시(함정 #18)
      if (e.key === "Escape") closePop();
      else if (e.key === "Enter" && !pop.classList.contains("hidden")) { e.preventDefault(); closePop(); } // 목록 열린 채 Enter=닫기(폼 오제출 방지)
    });
  });
  attachTimeFormat(startInput); // 시작 변경 → 소요 유지, 종료 자동 재계산(updatePreview)
  // 종료 입력 → 소요 역산(자정 넘김 = 종료<시작이면 +24h). 슬라이더·직접입력과 양방향 동기.
  attachTimeFormat(endInput, function () {
    var sMin = toMin(currentStart()), eMin = toMin(endInput.value);
    if (sMin == null || eMin == null) return;
    var diff = eMin - sMin;
    if (diff <= 0) diff += 1440; // 야간(자정 넘김)
    setDuration(diff);
  });
  // 종일 = 구글/애플 캘린더와 동일 개념(하루 종일 · 시간 없음, 운영시간 무관 — 2026-07-04 재정정).
  // 서버가 all_day=1이면 start/end를 NULL로 저장(시간 미보유). JS는 UI만: 시간 박스·종료 날짜·소요 블록 숨김.
  // 체크박스(name="all_day")가 제출 소스라 시간값은 건드리지 않는다(해제 시 원래 시간 그대로 보존).
  function applyAllDay(on) {
    // 종일이면 시간(콤보)·소요 UI만 숨긴다. 날짜 2개(시작·종료)는 남겨 다일 일정(예: 2/5~2/9)을 지정할 수 있게(사용자 요청).
    Array.prototype.forEach.call(form.querySelectorAll("[data-time-combo]"), function (w) { w.hidden = on; });
    if (durationWrap) durationWrap.hidden = on;
    if (durLabel) durLabel.textContent = on ? "종일" : fmtDuration(curDur);
    if (on) updateConflictWarn(); // 시간 없음 → 겹침 경고 해제
  }
  if (allDay) allDay.addEventListener("change", function () { applyAllDay(allDay.checked); });
  // 편집 진입 시 서버가 체크(all_day 세션)해 뒀으면 UI 반영.
  if (allDay && allDay.checked) applyAllDay(true);
  // 겹침이 감지되면 제출 직전 확인 → 승인 시 override_conflict=1로 그대로 등록(서버가 겹침 허용). 취소면 제출 중단.
  form.addEventListener("submit", function (e) {
    if (!overrideField) return;
    if (overlapDetected()) {
      if (!window.confirm("이미 예약된 일정이 있습니다. 그래도 등록할까요?")) {
        e.preventDefault();
        return;
      }
      overrideField.value = "1";
    } else {
      overrideField.value = "";
    }
  });

  updateProAvailability();
  syncRecFields();
  // 새 작성(생성 폼: data-session-id 없음)이면 시작=지금 기준 다음 30분 슬롯 프리필(브라우저 로컬 시간 — 서버 TZ 무관).
  if (!form.getAttribute("data-session-id") && startInput && !startInput.value && !(allDay && allDay.checked)) {
    var nowT = new Date();
    var slot = (Math.ceil((nowT.getHours() * 60 + nowT.getMinutes()) / 30) * 30) % 1440;
    writeTime(startInput, addMin("00:00", slot));
  }
  if (durationMinutes() === 0) applyTypeDefault(); // 새 세션(소요 미설정)이면 1Pro(단가 기준시간, 없으면 스튜디오 기본) → 종료 자동 채움(편집=저장값 유지)
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
  var MONEY = /^(unit_price|base_price|extra_price|amount|paid_amount|discount_amount|worker_rate|engineer_rates|task_amount_\d+|session_amount_\d+)$/;
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
    var el = e.target;
    if (!isMoney(el)) return;
    // 캐럿 위치 보존: 콤마 재포맷 후 커서가 끝으로 튀지 않게, 커서 앞 '숫자 개수'를 세어 재포맷 후 같은 숫자 위치로 복원.
    // (예: 1,800,000에서 8을 지우면 커서가 그 자리에 남아 5를 그 자리에 넣을 수 있음 — 끝으로 점프 방지.)
    var caret = el.selectionStart === el.selectionEnd ? el.selectionStart : null;
    var digitsBefore = caret == null ? -1 : el.value.slice(0, caret).replace(/[^\d]/g, "").length;
    el.value = fmt(el.value);
    if (digitsBefore >= 0) {
      var pos = 0, seen = 0;
      if (digitsBefore > 0) {
        pos = el.value.length;
        for (var i = 0; i < el.value.length; i++) {
          if (/\d/.test(el.value.charAt(i))) { seen++; if (seen >= digitsBefore) { pos = i + 1; break; } }
        }
      }
      try { el.setSelectionRange(pos, pos); } catch (err) {}
    }
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
  // 3) 제출: 0원 항목 확인 → 통과 시 hidden confirm_zero_amount=1 세팅(서버가 이 값 없으면 여전히 차단) + 드래프트 정리.
  // (2026-07-05 버그수정: 이전엔 확인창만 띄우고 서버에 알리지 않아 '확인'을 눌러도 서버가 그대로 TASK_AMOUNT_REQUIRED로 되돌리던 것.)
  var zeroFlag = form.querySelector("[data-confirm-zero-amount]");
  form.addEventListener("submit", function (e) {
    if (e.submitter && e.submitter.getAttribute("formtarget") === "_blank") return; // 미리보기 PDF 제출은 드래프트·확인 건너뜀(청구 생성만 정리)
    if (e.submitter && e.submitter.hasAttribute("data-waive-btn")) return; // 청구 안 함/되돌리기 제출은 별도 라우트라 0원 확인·드래프트 정리 불필요(2026-07-06)
    var hasZero = false;
    Array.prototype.forEach.call(form.querySelectorAll('input[type="checkbox"][data-line-amount]'), function (cb) {
      if (cb.checked && !(lineVal(cb) > 0)) hasZero = true;
    });
    if (hasZero) {
      if (!window.confirm("금액이 0원인 청구 항목이 있습니다. 0원으로 청구할까요?")) { e.preventDefault(); return; }
      if (zeroFlag) zeroFlag.value = "1";
    } else if (zeroFlag) {
      zeroFlag.value = "0";
    }
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

// 소속 그룹 콤보([data-group-combo], 2026-07-05 — 아티스트 폼): 타이핑=기존 그룹 검색, 빈 입력=[＋새 그룹 등록].
// 값은 hidden(group_id, party id) 제출. '새 등록'=그룹명만 입력하는 간이 모달(fetch POST /clients type=group,
// companyCombo와 같은 엔드포인트·같은 JSON 응답 패턴 재사용). 그룹 선택 시 그 그룹의 소속사(agency)로 같은 폼의
// 소속사 companyCombo를 자동 채운다(그룹 소속사가 있을 때만 — 이전 <select> 동작과 동일, 이후 개별 변경 가능).
(function () {
  "use strict";
  function esc(s) { return String(s == null ? "" : s).replace(/[&<>"]/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]; }); }
  Array.prototype.forEach.call(document.querySelectorAll("[data-group-combo]"), function (root) {
    var input = root.querySelector("[data-gc-input]");
    var hid = root.querySelector("[data-gc-hidden]");
    var pop = root.querySelector("[data-gc-pop]");
    var dataEl = root.querySelector("[data-gc-options]");
    var modal = root.querySelector("[data-gc-modal]");
    if (!input || !hid || !pop || !dataEl) return;
    var opts = [];
    try { opts = JSON.parse(dataEl.textContent || "[]"); } catch (e) { opts = []; }
    document.addEventListener("party-created", function (e) { // 함정 #20 — 다른 콤보에서 만든 새 그룹도 즉시 검색
      var p = e.detail; if (!p || p.kind !== "group") return;
      if (opts.some(function (o) { return String(o.id) === String(p.id); })) return;
      opts.push({ id: p.id, name: p.name, agency: p.agency || "" });
    });
    var view = [];
    var rowCls = "flex w-full cursor-pointer items-center justify-between gap-2 px-3 py-2 text-left text-sm hover:bg-elevated";
    function hide() { pop.classList.add("hidden"); input.setAttribute("aria-expanded", "false"); }
    function show() { pop.classList.remove("hidden"); input.setAttribute("aria-expanded", "true"); }
    function fillAgency(agName) {
      if (!agName) return;
      var form = root.closest("form");
      var combo = form && form.querySelector("[data-company-combo]");
      if (!combo) return;
      var cHid = combo.querySelector("[data-cc-hidden]"), cVis = combo.querySelector("[data-cc-input]");
      if (cVis) cVis.value = agName;
      if (cHid) { cHid.value = agName; cHid.dispatchEvent(new Event("change", { bubbles: true })); } // dirty 반영
      if (combo.__ccOpts && !combo.__ccOpts.some(function (o) { return String(o.name) === agName; })) combo.__ccOpts.push({ name: agName, sub: "" });
    }
    function pick(o) {
      input.value = o.name; hid.value = o.id; hid.dispatchEvent(new Event("change", { bubbles: true }));
      fillAgency(o.agency); hide();
    }
    function newRow(nm) {
      var label = nm ? "'" + esc(nm) + "'(으)로 새 그룹 등록" : "새 그룹 등록";
      return '<button type="button" class="' + rowCls + ' text-primary" data-new="1"><span class="truncate">＋ ' + label + '</span><span class="shrink-0 text-xs text-muted">새로 등록</span></button>';
    }
    function render() {
      var q = input.value.trim().toLowerCase();
      view = (q ? comboRankSort(opts, q, function (o) { return [o.name]; }) : opts).slice(0, 12); // 정확 일치 우선(공용 랭킹)
      var html = view.map(function (o, i) { return '<button type="button" class="' + rowCls + '" data-idx="' + i + '"><span class="truncate text-fg">' + esc(o.name) + '</span></button>'; }).join("");
      if (q && !view.some(function (o) { return String(o.name).toLowerCase() === q; })) html += newRow(input.value.trim());
      else if (!q) html += newRow("");
      pop.innerHTML = html; show();
    }
    input.addEventListener("focus", render);
    input.addEventListener("input", function () { hid.value = ""; render(); }); // 타이핑 중엔 연결 해제(정확 일치 시 blur에서 복구)
    input.addEventListener("blur", function () {
      setTimeout(function () {
        var v = input.value.trim();
        var match = opts.filter(function (o) { return String(o.name) === v; })[0];
        hid.value = match ? match.id : "";
        hide();
      }, 150);
    });
    pop.addEventListener("mousedown", function (e) { e.preventDefault(); }); // blur보다 먼저 pick(터치 표준 패턴)
    pop.addEventListener("click", function (e) {
      var b = e.target.closest && e.target.closest("button"); if (!b) return;
      if (b.hasAttribute("data-idx")) pick(view[Number(b.getAttribute("data-idx"))]);
      else if (b.hasAttribute("data-new")) openModal();
    });
    input.addEventListener("keydown", function (e) { if (e.isComposing || e.keyCode === 229) return; if (e.key === "Escape") hide(); });
    function openModal() {
      if (!modal) { hide(); return; }
      var n = modal.querySelector("[data-gc-name]"); n.value = input.value.trim();
      modal.querySelector("[data-gc-err]").classList.add("hidden");
      modal.classList.remove("hidden"); modal.classList.add("flex"); hide(); n.focus();
    }
    if (modal) {
      var gSave = modal.querySelector("[data-gc-save]"), gCancel = modal.querySelector("[data-gc-cancel]");
      var closeModal = function () { modal.classList.add("hidden"); modal.classList.remove("flex"); };
      gCancel.addEventListener("click", closeModal);
      // 배경 클릭 닫기 — 단, 텍스트 드래그 선택이 모달 배경에서 끝난 경우(mousedown은 안쪽, mouseup=click은 배경)는
      // 닫지 않는다(2026-07-06 사용자 리포트: 이름 전체 선택하려 드래그했는데 마우스를 뗀 지점이 모달 밖이라 닫히던 버그).
      // click 이벤트의 target은 mousedown·mouseup의 공통 조상이라, 드래그가 배경까지 번지면 안쪽에서 시작했어도
      // target===modal이 될 수 있음 — mousedown도 배경에서 시작했을 때만 진짜 배경 클릭으로 간주.
      var mdOnBackdrop = false;
      modal.addEventListener("mousedown", function (e) { mdOnBackdrop = e.target === modal; });
      modal.addEventListener("click", function (e) { if (e.target === modal && mdOnBackdrop) closeModal(); });
      modal.addEventListener("keydown", function (e) {
        if (e.isComposing || e.keyCode === 229) return;
        if (e.key === "Enter") { e.preventDefault(); gSave.click(); }
      });
      gSave.addEventListener("click", function () {
        var nm = modal.querySelector("[data-gc-name]").value.trim();
        var err = modal.querySelector("[data-gc-err]");
        if (!nm) { err.textContent = "그룹명을 입력하세요."; err.classList.remove("hidden"); return; }
        var body = new URLSearchParams();
        body.append("type", "group"); body.append("party_name", nm);
        gSave.disabled = true; err.classList.add("hidden");
        fetch("/clients", { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded", "X-Requested-With": "fetch" }, body: body.toString() })
          .then(function (r) { return r.ok ? r.json() : null; })
          .then(function (d) {
            if (!d || !d.ok) throw new Error("fail");
            announceParty({ kind: "group", id: d.id, name: d.name });
            input.value = d.name; hid.value = d.id; hid.dispatchEvent(new Event("change", { bubbles: true }));
            closeModal(); hide();
            if (window.__toast) window.__toast(d.name + " 등록됨");
          })
          .catch(function () { err.textContent = "등록 실패 — 다시 시도하세요."; err.classList.remove("hidden"); })
          .then(function () { gSave.disabled = false; });
      });
    }
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

// (옛 세션 디렉터 행 복제(+추가/✕) UI는 콤마 다중 personCombo(multi)로 대체 — 2026-07-05 제거.)

// 세션 담당 엔지니어 반복 선택([data-engineer-list], 2026-07-05 — 여러 명 가능): '+ 담당 엔지니어 추가하기'로
// 행(select) 복제(template), '✕'로 제거. 디렉터와 달리 자유 텍스트 등록이 없어(담당자 마스터에서만 선택)
// personCombo 없이 단순 select 반복으로 충분 — 위임(delegation)으로 처리해 동적 추가 행도 자동 동작.
(function () {
  "use strict";
  // 행 추가/제거는 클릭이라 [data-dirty-form] 감시(input/change 위임)가 못 잡는다 — 폼에 합성 change를 쏴 동기화.
  function markDirty(form) { if (form) form.dispatchEvent(new Event("change", { bubbles: true })); }
  document.addEventListener("click", function (e) {
    var addBtn = e.target.closest && e.target.closest("[data-engineer-add]");
    if (addBtn) {
      var wrap = addBtn.parentNode;
      var list = wrap && wrap.querySelector("[data-engineer-list]");
      var tpl = wrap && wrap.querySelector("[data-engineer-template]");
      if (list && tpl && tpl.content) {
        list.appendChild(tpl.content.cloneNode(true));
        var last = list.lastElementChild;
        var sel = last && last.querySelector("select");
        if (sel) sel.focus();
      }
      return;
    }
    var rmBtn = e.target.closest && e.target.closest("[data-engineer-remove]");
    if (rmBtn) {
      var row = rmBtn.closest("[data-engineer-row]");
      var form = rmBtn.closest("form");
      if (row && row.parentNode) row.parentNode.removeChild(row);
      markDirty(form);
    }
  });
})();

// 세션 담당 엔지니어 행: 외주(data-external=1)일 때만 그 행의 지급단가 칸 표시(2026-07-06 — 작업 폼과 동일 규칙).
// 위임(delegation)으로 처리해 '+ 담당 엔지니어 추가하기'로 복제된 행도 자동 동작.
(function () {
  "use strict";
  function syncRow(sel) {
    var row = sel.closest("[data-engineer-row]");
    var wrap = row && row.querySelector("[data-engineer-rate]");
    if (!wrap) return;
    var opt = sel.options[sel.selectedIndex];
    var external = opt && opt.getAttribute("data-external") === "1";
    wrap.classList.toggle("hidden", !external);
  }
  Array.prototype.forEach.call(document.querySelectorAll('[data-engineer-row] select[name="engineer_ids"]'), syncRow);
  document.addEventListener("change", function (e) {
    if (e.target && e.target.tagName === "SELECT" && e.target.name === "engineer_ids") syncRow(e.target);
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
    if (a.target === "_blank" || a.hasAttribute("download")) return;
    // data-no-guard(예: '취소'=저장하지 않고 목록으로): 커스텀 모달은 건너뛰지만, bypass 없이 두면
    // 곧이어 일어날 실제 이동에서 beforeunload의 브라우저 기본 "나가시겠습니까?" 프롬프트가 그대로 뜬다
    // (2026-07-05 발견 — data-no-guard가 모달만 막고 beforeunload는 못 막던 잠복 결함). bypass로 둘 다 통과.
    if (a.hasAttribute("data-no-guard")) { bypass = true; setTimeout(function () { bypass = false; }, 1000); return; }
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

// (옛 작업 헤더 상태 select의 접힘 방지 가드는 완료 토글 버튼으로 대체 — 2026-07-05 제거.)

// 콤보 공용 키보드 내비게이션(방향키 이동·엔터 선택·ESC 닫기). 하이라이트 항목을 click 시뮬레이션 →
// 각 콤보의 기존 click 핸들러가 선택 처리(콤보별 pick 로직 몰라도 동작). pop 재렌더(MutationObserver)마다 첫 항목 하이라이트.
/**
 * 콤보 후보 랭킹(공용) — 검색어 매칭 강도. 작을수록 먼저, 99=미매칭.
 * fields는 우선순위 순서(앞 필드가 더 중요): 각 필드 안에서 정확 일치 > 앞부분 일치 > 중간 포함.
 * 필터만 하고 정렬을 안 하면 옵션 배열 순서(대개 가나다순)가 그대로 노출돼, 이름이 정확히 일치하는
 * 항목이 부분 일치 항목에 밀린다. 첫 항목이 하이라이트되므로 엔터로 엉뚱한 대상이 선택된다
 * (2026-07-10: 담당자·청구처·제작/운영·아티스트 콤보에서 같은 클래스로 재발 → 공용화 + 가드레일).
 */
function comboRank(q, fields) {
  var best = 99;
  for (var i = 0; i < fields.length; i++) {
    var v = fields[i];
    if (!v) continue;
    var t = String(v).toLowerCase();
    var r = t === q ? 0 : t.indexOf(q) === 0 ? 1 : t.indexOf(q) !== -1 ? 2 : 99;
    if (r < 99) best = Math.min(best, i * 10 + r);
  }
  return best;
}

/** 매칭 항목만 남기고 랭킹순 정렬(동점이면 원래 순서 유지 — 안정 정렬). fieldsOf(o)=우선순위 필드 배열. */
function comboRankSort(list, q, fieldsOf) {
  return list
    .map(function (o, i) { return { o: o, r: comboRank(q, fieldsOf(o)), i: i }; })
    .filter(function (x) { return x.r < 99; })
    .sort(function (a, b) { return a.r - b.r || a.i - b.i; })
    .map(function (x) { return x.o; });
}

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
    var chipBox = root.querySelector("[data-artist-chips]");   // Gmail식 칩 컨테이너(2026-07-10)
    var hidArtist = root.querySelector("[data-artist-hidden]"); // 제출값: 활동명 콤마 목록(서버 계약 불변)
    var opts = [];
    try { opts = JSON.parse(dataEl.textContent || "[]"); } catch (e) { opts = []; }
    // 어디서든 새 party 생성되면 아티스트·그룹은 이 콤보 옵션에 추가(재검색 인식)
    document.addEventListener("party-created", function (e) {
      var p = e.detail; if (!p || !(p.kind === "group" || (p.kind === "person" && p.isArtist))) return;
      if (opts.some(function (o) { return String(o.contactId) === String(p.id); })) return;
      opts.push({ name: p.name, contactId: p.id, realName: p.realName || "", sub: p.kind === "group" ? "그룹" : "아티스트", agency: p.agency || "" });
    });
    var view = []; // 현재 렌더된 후보(클릭 인덱스 매핑)

    // ── 칩(선택된 아티스트 한 덩어리) — 서버 렌더 마크업과 형식 동일 ──
    function chipList() { return chipBox ? Array.prototype.slice.call(chipBox.querySelectorAll("[data-artist-chip]")) : []; }
    function chipNames() { return chipList().map(function (c) { return c.getAttribute("data-artist-chip-name") || ""; }).filter(Boolean); }
    /** hidden 동기화: artist=활동명 콤마 목록, artist_contact_id=단일 선택일 때만 명시 id(다중은 서버가 이름별 해석). */
    function syncHidden() {
      var list = chipList();
      if (hidArtist) hidArtist.value = chipNames().join(", ");
      if (cid) cid.value = list.length === 1 ? (list[0].getAttribute("data-artist-chip-cid") || "") : "";
      if (input) input.placeholder = list.length ? "" : "아티스트명 — 검색 또는 새로 등록";
      fireInput(); // dirty 감지(칩 조작은 클릭이라 input/change가 안 뜬다 — 함정 #23)
    }
    function chipEl(name, realName, contactId) {
      var label = realName && realName !== name ? name + " (" + realName + ")" : name;
      var span = document.createElement("span");
      span.className = "inline-flex max-w-full items-center gap-1 rounded-full border border-border bg-elevated py-0.5 pl-2.5 pr-1 text-sm";
      span.setAttribute("data-artist-chip", "");
      span.setAttribute("data-artist-chip-name", name);
      span.setAttribute("data-artist-chip-cid", contactId ? String(contactId) : "");
      var t = document.createElement("span"); t.className = "truncate"; t.textContent = label; span.appendChild(t);
      var x = document.createElement("button"); x.type = "button";
      x.className = "flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-muted hover:bg-border hover:text-fg";
      x.setAttribute("data-artist-chip-remove", ""); x.setAttribute("aria-label", name + " 제거"); x.textContent = "✕";
      span.appendChild(x);
      return span;
    }
    function chipHas(name) { return chipNames().some(function (n) { return n.toLowerCase() === String(name).toLowerCase(); }); }
    function addChip(name, realName, contactId) {
      if (!chipBox || !name) return;
      if (!chipHas(name)) chipBox.insertBefore(chipEl(name, realName, contactId), input);
      input.value = "";
      syncHidden();
    }
    function removeChip(chip) { if (chip && chip.parentNode) { chip.parentNode.removeChild(chip); syncHidden(); } }

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
      var q = input.value.trim().toLowerCase(); // 칩 모드: 입력칸은 검색어 전용
      var html = "";
      if (!q) {
        view = [];
        html = newRow("새 아티스트 등록"); // 검색 안내 줄 폐기(타이핑하면 자동 검색)
      } else {
        view = comboRankSort(opts, q, function (o) { return [o.name, o.realName]; }).slice(0, 12); // 활동명 > 본명(공용 랭킹 — 정확 일치 우선)
        html = view.map(pickRow).join("");
        var exact = view.some(function (o) { return String(o.name).toLowerCase() === q || (o.realName && String(o.realName).toLowerCase() === q); });
        if (!exact) html += newRow("'" + input.value.trim() + "'(으)로 새 아티스트");
      }
      pop.innerHTML = html;
      show();
      setHi(0); // 첫 후보 하이라이트(방향키·엔터 대비)
    }
    function pick(o) {
      var first = chipList().length === 0;
      addChip(o.name, o.realName, o.contactId); // 칩 한 덩어리(제출은 hidden artist/cid — syncHidden)
      if (first || !currentAgencyValue()) fillAgency(o.agency); // 소속사 자동 채움은 첫 아티스트 우선(이미 채워졌으면 유지)
      hide();
    }
    // 현재 소속사/레이블 값(다중 아티스트 시 덮어쓰기 방지 판단용)
    function currentAgencyValue() {
      var form = root.closest ? root.closest("form") : null;
      var hidden = (form || document).querySelector('input[name="artist_company"]');
      return hidden ? hidden.value.trim() : "";
    }
    function asNew() { cid.value = ""; hide(); input.focus(); fireInput(); } // 새 아티스트: 연결 없음, 입력값 유지(모달 없을 때 폴백)

    // ── 간이 등록 모달: 프로젝트 폼 이탈 없이 새 아티스트/그룹 등록(fetch → 콤보 채움) ──
    var modal = root.querySelector("[data-artist-modal]");
    function openModal() {
      if (!modal) { asNew(); return; }
      var mName = modal.querySelector("[data-am-name]"), mGroup = modal.querySelector("[data-am-group]"),
          mRealWrap = modal.querySelector("[data-am-real-wrap]"), mReal = modal.querySelector("[data-am-real]"),
          mAgency = modal.querySelector("[data-am-agency]"), mPhone = modal.querySelector("[data-am-phone]"),
          mAgencyInput = modal.querySelector("[data-am-agency-input]"), mEmail = modal.querySelector("[data-am-email]"),
          mErr = modal.querySelector("[data-am-err]");
      mName.value = input.value.trim(); mGroup.checked = false; // 타이핑한 검색어 프리필
      if (mReal) mReal.value = ""; if (mAgency) mAgency.value = ""; if (mAgencyInput) mAgencyInput.value = ""; if (mPhone) mPhone.value = ""; if (mEmail) mEmail.value = "";
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
      // 배경 클릭 닫기 — 단, 텍스트 드래그 선택이 모달 배경에서 끝난 경우(mousedown은 안쪽, mouseup=click은 배경)는
      // 닫지 않는다(2026-07-06 사용자 리포트: 이름 전체 선택하려 드래그했는데 마우스를 뗀 지점이 모달 밖이라 닫히던 버그).
      // click 이벤트의 target은 mousedown·mouseup의 공통 조상이라, 드래그가 배경까지 번지면 안쪽에서 시작했어도
      // target===modal이 될 수 있음 — mousedown도 배경에서 시작했을 때만 진짜 배경 클릭으로 간주.
      var mdOnBackdrop = false;
      modal.addEventListener("mousedown", function (e) { mdOnBackdrop = e.target === modal; });
      modal.addEventListener("click", function (e) { if (e.target === modal && mdOnBackdrop) closeModal(); }); // 배경 클릭 닫기
      mSave.addEventListener("click", function () {
        var mName = modal.querySelector("[data-am-name]"), mReal = modal.querySelector("[data-am-real]"),
            mAgency = modal.querySelector("[data-am-agency]"), mPhone = modal.querySelector("[data-am-phone]"),
            mEmail = modal.querySelector("[data-am-email]"),
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
        if (mEmail && mEmail.value.trim()) body.append("email", mEmail.value.trim());
        fetch("/clients", { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded", "X-Requested-With": "fetch" }, body: body.toString() })
          .then(function (r) { return r.ok ? r.json() : null; })
          .then(function (d) {
            if (!d || !d.ok) throw new Error("fail");
            var rn = !mGroup.checked && mReal && mReal.value.trim() ? mReal.value.trim() : "";
            announceParty({ kind: mGroup.checked ? "group" : "person", id: d.id, name: d.name, isArtist: true, realName: rn, agency: agName || "" }); // 전역 브로드캐스트 → 이 콤보 포함 모든 콤보 옵션에 반영
            var first2 = chipList().length === 0;
            addChip(d.name, rn, d.id); // 등록한 아티스트를 칩으로
            if (first2 || !currentAgencyValue()) fillAgency(agName); // 소속사는 첫 아티스트 기준(이미 있으면 유지)
            closeModal(); hide(); // 등록 후 콤보 드롭다운 닫기
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
          agView = (q ? comboRankSort(agOpts, q, function (o) { return [o.name]; }) : agOpts).slice(0, 10); // 정확 일치 우선(공용 랭킹)
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
    input.addEventListener("input", render); // 칩 모드: 입력칸은 검색 전용(제출값은 칩 hidden)
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
    // 칩 ✕ 클릭(위임) + 빈 입력 백스페이스 = 마지막 칩 삭제(Gmail 동작).
    if (chipBox) {
      chipBox.addEventListener("click", function (e) {
        var x = e.target.closest("[data-artist-chip-remove]");
        if (x) { e.preventDefault(); removeChip(x.closest("[data-artist-chip]")); input.focus(); }
      });
      chipBox.addEventListener("mousedown", function (e) { if (e.target === chipBox) { e.preventDefault(); input.focus(); } });
      input.addEventListener("keydown", function (e) {
        if (e.isComposing || e.keyCode === 229) return; // 한글 IME 조합 중(함정 #18)
        if (e.key !== "Backspace" || input.value !== "") return;
        var list = chipList();
        if (list.length) { e.preventDefault(); removeChip(list[list.length - 1]); }
      });
    }
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
    var hidPid = root.querySelector("[data-cc-party-id]"); // (선택) 사람/회사 선택 시 party id — 제작/운영에 관계자·개인 허용
    var pop = root.querySelector("[data-cc-pop]");
    var dataEl = root.querySelector("[data-cc-options]");
    var modal = root.querySelector("[data-cc-modal]");
    if (!input || !pop || !dataEl) return;
    var opts = [];
    try { opts = JSON.parse(dataEl.textContent || "[]"); } catch (e) { opts = []; }
    root.__ccOpts = opts; // fillAgency 등 외부에서 새 소속사를 옵션에 추가할 수 있게 노출
    document.addEventListener("party-created", function (e) { // 어디서든 새 party 생성되면 이 콤보 옵션에 추가(함정 #20)
      var p = e.detail; if (!p) return;
      if (p.kind === "company") {
        if (opts.some(function (o) { return String(o.name) === String(p.name); })) return;
        opts.push({ id: p.id, name: p.name, sub: "조직", kind: "company" });
      } else if (p.kind === "person" && hidPid) {
        // 사람 허용 콤보(제작/운영)만 — 다른 콤보(담당자 등)에서 만든 새 사람도 즉시 검색되게(재검색 시 '새 업체 등록' 유도로 중복 생성되던 클래스).
        if (opts.some(function (o) { return String(o.id) === String(p.id) && o.kind === "person"; })) return;
        var nm = p.realName || p.name; // 간이 등록 브로드캐스트(name=활동명·realName=본명) 정규화 — personCombo 리스너와 동일
        var alt = p.realName ? p.name : (p.activity || "");
        opts.push({ id: p.id, name: nm, sub: p.company || "관계자", kind: "person", alt: alt, honorific: "" });
      }
    });
    var view = [];
    var rowCls = "flex w-full cursor-pointer items-center justify-between gap-2 px-3 py-2 text-left text-sm hover:bg-elevated";
    function hide() { pop.classList.add("hidden"); input.setAttribute("aria-expanded", "false"); }
    function show() { pop.classList.remove("hidden"); input.setAttribute("aria-expanded", "true"); }
    function fireInput() { input.dispatchEvent(new Event("input", { bubbles: true })); }
    // 사람(관계자·개인) 옵션 표시 라벨 = 본명 호칭 (활동명) — personCombo labelOf와 동일 형식(아티스트면 활동명 병기, 2026-07-05). 회사는 name 그대로.
    function dispOf(o) {
      if (!o || o.kind !== "person") return o ? String(o.name || "") : "";
      var n = String(o.name || ""); var h = o.honorific ? String(o.honorific).trim() : ""; var a = o.alt ? String(o.alt).trim() : "";
      var s = (h && n.slice(-h.length) !== h) ? n + " " + h : n;
      return a && a !== n ? s + " (" + a + ")" : s;
    }
    function newRow(nm) {
      var label = nm ? "'" + esc(nm) + "'(으)로 새 업체 등록" : "새 업체 등록";
      return '<button type="button" class="' + rowCls + ' text-primary" data-new="1"><span class="truncate">＋ ' + label + '</span><span class="shrink-0 text-xs text-muted">새로 등록</span></button>';
    }
    function render() {
      var q = input.value.trim().toLowerCase();
      var html = "";
      if (!q) { view = []; html = newRow(""); }
      else {
        // 이름 또는 표시 라벨(활동명 포함)로 검색 — 아티스트를 활동명으로도 찾게.
        view = comboRankSort(opts, q, function (o) { return [o.name, dispOf(o), o.alt]; }).slice(0, 12); // 이름 > 표시 라벨 > 활동명(공용 랭킹)
        html = view.map(function (o, i) { return '<button type="button" class="' + rowCls + '" data-idx="' + i + '"><span class="truncate text-fg">' + esc(dispOf(o)) + '</span><span class="shrink-0 text-xs text-muted">' + esc(o.sub || "") + '</span></button>'; }).join("");
        if (!view.some(function (o) { return String(o.name).toLowerCase() === q || dispOf(o).toLowerCase() === q; })) html += newRow(input.value.trim());
      }
      pop.innerHTML = html; show();
    }
    function openModal() {
      if (!modal) { hide(); return; }
      var n = modal.querySelector("[data-cc-name]"); n.value = input.value.trim();
      ["[data-cc-biz]", "[data-cc-owner]"].forEach(function (s) { var el = modal.querySelector(s); if (el) el.value = ""; });
      var ownBox0 = modal.querySelector("[data-cc-owner-chips]"); // 대표자 칩 초기화(공동대표)
      if (ownBox0) {
        Array.prototype.forEach.call(ownBox0.querySelectorAll("[data-cc-owner-chip]"), function (c) { c.remove(); });
        var ownIn0 = ownBox0.querySelector("[data-cc-owner]");
        if (ownIn0) ownIn0.placeholder = "이름 검색 또는 새로 등록"; // 칩 없으면 안내문 복구
      }
      var ownPop0 = modal.querySelector("[data-cc-owner-pop]"); if (ownPop0) ownPop0.classList.add("hidden");
      modal.querySelector("[data-cc-err]").classList.add("hidden");
      modal.classList.remove("hidden"); modal.classList.add("flex"); hide(); n.focus();
    }
    if (modal) {
      var cSave = modal.querySelector("[data-cc-save]"), cCancel = modal.querySelector("[data-cc-cancel]");
      var closeModal = function () { modal.classList.add("hidden"); modal.classList.remove("flex"); };
      cCancel.addEventListener("click", closeModal);
      // 배경 클릭 닫기 — 단, 텍스트 드래그 선택이 모달 배경에서 끝난 경우(mousedown은 안쪽, mouseup=click은 배경)는
      // 닫지 않는다(2026-07-06 사용자 리포트: 이름 전체 선택하려 드래그했는데 마우스를 뗀 지점이 모달 밖이라 닫히던 버그).
      // click 이벤트의 target은 mousedown·mouseup의 공통 조상이라, 드래그가 배경까지 번지면 안쪽에서 시작했어도
      // target===modal이 될 수 있음 — mousedown도 배경에서 시작했을 때만 진짜 배경 클릭으로 간주.
      var mdOnBackdrop = false;
      modal.addEventListener("mousedown", function (e) { mdOnBackdrop = e.target === modal; });
      modal.addEventListener("click", function (e) { if (e.target === modal && mdOnBackdrop) closeModal(); });
      cSave.addEventListener("click", function () {
        var nm = modal.querySelector("[data-cc-name]").value.trim();
        var err = modal.querySelector("[data-cc-err]");
        if (!nm) { err.textContent = "업체명을 입력하세요."; err.classList.remove("hidden"); return; }
        var body = new URLSearchParams();
        body.append("type", "company"); body.append("name", nm);
        if (modal.querySelector("[data-cc-agency]").checked) body.append("roles", "소속사/레이블");
        if (modal.querySelector("[data-cc-prod]").checked) body.append("roles", "제작사");
        var biz = modal.querySelector("[data-cc-biz]").value.trim(); if (biz) body.append("biz_no", biz);
        // 대표자 칩(공동대표) — 서버 resolveOwnerIds가 owner_id/owner_name 인덱스 페어링으로 해석.
        var ownBox1 = modal.querySelector("[data-cc-owner-chips]");
        if (ownBox1) Array.prototype.forEach.call(ownBox1.querySelectorAll("[data-cc-owner-chip]"), function (c) {
          body.append("owner_name", c.getAttribute("data-cc-owner-chip-name") || "");
          body.append("owner_id", c.getAttribute("data-cc-owner-chip-id") || "");
        }); // 대표자 콤보에서 선택/등록한 사람 id(정확 연결·중복 방지)
        cSave.disabled = true; err.classList.add("hidden");
        fetch("/clients", { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded", "X-Requested-With": "fetch" }, body: body.toString() })
          .then(function (r) { return r.ok ? r.json() : null; })
          .then(function (d) { if (!d || !d.ok) throw new Error("fail"); announceParty({ kind: "company", id: d.id, name: d.name }); if (ownerIdEl && ownerIdEl.value && owner) announceParty({ kind: "person", id: ownerIdEl.value, name: owner, company: d.name, job_title: "대표" }); input.value = d.name; closeModal(); fireInput(); if (hidPid) hidPid.value = d.id; hide(); if (window.__toast) window.__toast(d.name + " 등록됨"); }) // 회사 + 대표자 소속·직책(대표) 브로드캐스트 (새 회사 id를 party-id에도 — fireInput 뒤에)
          .catch(function () { err.textContent = "등록 실패 — 다시 시도하세요."; err.classList.remove("hidden"); })
          .then(function () { cSave.disabled = false; });
      });
      // 대표자 미니콤보(모달 내부): 타이핑 검색(사람) + '＋ 새 연락처 등록'. 선택은 칩으로 담긴다(공동대표, 2026-07-10).
      var ownInput = modal.querySelector("[data-cc-owner]"), ownBox = modal.querySelector("[data-cc-owner-chips]"),
          ownPop = modal.querySelector("[data-cc-owner-pop]"), ownOptsEl = modal.querySelector("[data-cc-owner-options]");
      var ownOpts = []; try { ownOpts = JSON.parse((ownOptsEl && ownOptsEl.textContent) || "[]"); } catch (e) { ownOpts = []; }
      document.addEventListener("party-created", function (e) { var p = e.detail; if (!p || p.kind !== "person") return; if (!ownOpts.some(function (o) { return String(o.id) === String(p.id); })) ownOpts.push({ id: p.id, name: p.name }); }); // 새 사람 → 대표자 미니콤보 옵션에 추가
      if (ownInput && ownBox && ownPop) {
        var ownRowCls = "flex w-full cursor-pointer items-center justify-between gap-2 px-3 py-2 text-left text-sm hover:bg-elevated";
        var ownView = [];
        function ownChips() { return Array.prototype.slice.call(ownBox.querySelectorAll("[data-cc-owner-chip]")); }
        function ownSyncPh() { ownInput.placeholder = ownChips().length ? "" : "이름 검색 또는 새로 등록"; } // 칩 있으면 안내문 숨김
        function ownAdd(name, id) {
          if (!name) return;
          if (ownChips().some(function (c) { return (c.getAttribute("data-cc-owner-chip-name") || "").toLowerCase() === name.toLowerCase(); })) { ownInput.value = ""; return; }
          var span = document.createElement("span");
          span.className = "inline-flex max-w-full items-center gap-1 rounded-full border border-border bg-elevated py-0.5 pl-2.5 pr-1 text-sm";
          span.setAttribute("data-cc-owner-chip", "");
          span.setAttribute("data-cc-owner-chip-name", name);
          span.setAttribute("data-cc-owner-chip-id", id ? String(id) : "");
          var t = document.createElement("span"); t.className = "truncate"; t.textContent = name; span.appendChild(t);
          var x = document.createElement("button"); x.type = "button";
          x.className = "flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-muted hover:bg-border hover:text-fg";
          x.setAttribute("data-cc-owner-chip-remove", ""); x.setAttribute("aria-label", name + " 제거"); x.textContent = "✕";
          span.appendChild(x);
          ownBox.insertBefore(span, ownInput);
          ownInput.value = "";
          ownSyncPh();
        }
        ownBox.addEventListener("click", function (e) {
          var x = e.target.closest("[data-cc-owner-chip-remove]");
          if (x) { e.preventDefault(); x.closest("[data-cc-owner-chip]").remove(); ownSyncPh(); ownInput.focus(); }
        });
        ownInput.addEventListener("keydown", function (e) {
          if (e.isComposing || e.keyCode === 229) return; // 한글 IME 조합 중(함정 #18)
          if (e.key !== "Backspace" || ownInput.value !== "") return;
          var list = ownChips();
          if (list.length) { e.preventDefault(); list[list.length - 1].remove(); ownSyncPh(); }
        });
        function ownHide() { ownPop.classList.add("hidden"); }
        function ownRender() {
          var q = ownInput.value.trim().toLowerCase();
          ownView = (q ? comboRankSort(ownOpts, q, function (o) { return [o.name]; }) : ownOpts).slice(0, 10); // 정확 일치 우선(공용 랭킹)
          var html = ownView.map(function (o, i) { return '<button type="button" class="' + ownRowCls + '" data-owneridx="' + i + '"><span class="truncate text-fg">' + esc(o.name) + '</span></button>'; }).join("");
          if (q && !ownView.some(function (o) { return String(o.name).toLowerCase() === q; })) html += '<button type="button" class="' + ownRowCls + ' text-primary" data-ownernew="1"><span class="truncate">＋ \'' + esc(ownInput.value.trim()) + '\'(으)로 새 연락처 등록</span><span class="shrink-0 text-xs text-muted">새로 등록</span></button>';
          ownPop.innerHTML = html || '<div class="px-3 py-2 text-sm text-muted">이름을 입력해 새 연락처로 등록</div>'; ownPop.classList.remove("hidden");
        }
        ownInput.addEventListener("focus", ownRender);
        ownInput.addEventListener("click", ownRender);
        ownInput.addEventListener("input", ownRender); // 입력칸은 검색 전용(값은 칩이 보유)
        ownInput.addEventListener("blur", function () { setTimeout(ownHide, 150); });
        ownPop.addEventListener("mousedown", function (e) { e.preventDefault(); });
        ownPop.addEventListener("click", function (e) {
          var b = e.target.closest("button"); if (!b) return;
          if (b.hasAttribute("data-owneridx")) { var o = ownView[Number(b.getAttribute("data-owneridx"))]; ownAdd(o.name, o.id); ownHide(); }
          else if (b.hasAttribute("data-ownernew")) {
            var nm = ownInput.value.trim(); if (!nm) return;
            b.disabled = true;
            var body2 = new URLSearchParams(); body2.append("name", nm);
            fetch("/contacts", { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded", "X-Requested-With": "fetch" }, body: body2.toString() })
              .then(function (r) { return r.ok ? r.json() : null; })
              .then(function (d) { if (!d || !d.ok) throw new Error("fail"); ownAdd(d.name, d.id); announceParty({ kind: "person", id: d.id, name: d.name }); ownHide(); })
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
    input.addEventListener("input", function () {
      if (hidCC) hidCC.value = input.value; // 제출용 숨김 업체명 동기화(타이핑·pick·모달 모두 fireInput로 도달)
      if (hidPid) {
        // 순수 이름/표시 라벨과 정확 일치(유일)하면 id 유지 — pick이 라벨을 넣거나 라벨을 직접 타이핑해도 선택이 안 풀리게(personCombo와 대칭).
        var v = input.value.trim().toLowerCase();
        var ms = v ? opts.filter(function (o) { return dispOf(o).toLowerCase() === v || String(o.name).toLowerCase() === v; }) : [];
        hidPid.value = ms.length === 1 && ms[0].id != null ? ms[0].id : "";
      }
      render();
    });
    input.addEventListener("blur", function () { setTimeout(hide, 150); });
    pop.addEventListener("mousedown", function (e) { e.preventDefault(); });
    pop.addEventListener("click", function (e) {
      var b = e.target.closest("button"); if (!b) return;
      if (b.hasAttribute("data-idx")) {
        var o = view[Number(b.getAttribute("data-idx"))];
        input.value = dispOf(o); fireInput(); if (hidPid) hidPid.value = o.id || ""; hide(); // fireInput이 hidPid를 지우므로 그 다음에 세팅(사람/회사 id 확정)
        // 제작/운영에 개인(사람) 선택 → 고객측 담당자 자동 채움(비어있을 때만 — 이미 지정한 담당자는 존중). 2026-07-05.
        if (o.kind === "person" && hidPid) {
          var form = root.closest && root.closest("form");
          var pc = form && form.querySelector("[data-person-combo]");
          if (pc && pc.__pcSetById && pc.__pcHasValue && !pc.__pcHasValue()) pc.__pcSetById(o.id);
        }
      } else if (b.hasAttribute("data-new")) openModal();
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
    // multi = Gmail식 칩 모드(2026-07-10, 옛 콤마 텍스트 방식 대체) — 선택된 사람은 한 덩어리 배지, ✕/백스페이스로 통째 삭제.
    // 제출은 칩마다 hidden(idField=당사자 id·신규는 빈값 / nameField=순수 본명) 쌍 → 서버가 인덱스 페어링으로 해석.
    var multi = root.hasAttribute("data-pc-multi");
    var chipBox = root.querySelector("[data-pc-chips]");
    var idField = root.getAttribute("data-pc-id-field") || "contact_id";
    var nameField = root.getAttribute("data-pc-name-field") || "contact_name";
    // 옵션: 인라인(data-pc-options) 또는 페이지 공유 스크립트(data-pc-options-ref로 참조, 중복 임베드 제거)
    var refId = root.getAttribute("data-pc-options-ref");
    var dataEl = refId ? document.getElementById(refId) : root.querySelector("[data-pc-options]");
    var modal = root.querySelector("[data-pc-modal]");
    if (!input || !pop || (!multi && !hid)) return; // dataEl 없어도 진행(옵션 빈 배열 — '새 등록'은 가능). multi는 hidden id 대신 칩이 값을 갖는다
    var opts = [];
    try { opts = JSON.parse((dataEl && dataEl.textContent) || "[]"); } catch (e) { opts = []; }
    document.addEventListener("party-created", function (e) { // 어디서든 새 사람 생성/갱신되면 이 담당자 콤보 옵션에 반영
      var p = e.detail; if (!p || p.kind !== "person") return;
      var ex = opts.filter(function (o) { return String(o.id) === String(p.id); })[0];
      if (ex) { if (p.company) ex.company = p.company; if (p.job_title) ex.job_title = p.job_title; if (p.phone) ex.phone = p.phone; if (p.realName && !ex.alt) ex.alt = p.realName; return; } // 기존 항목 갱신(소속·직책·본명 등)
      // 아티스트 간이 등록 브로드캐스트는 name=활동명·realName=본명 → 담당자는 본명 우선 표시, 활동명은 검색 보조(둘 다 검색되게).
      var pcPrimary = p.realName || p.name;
      var pcAlt = p.realName ? p.name : (p.activity || "");
      opts.push({ id: p.id, name: pcPrimary, alt: pcAlt, phone: p.phone || "", email: p.email || "", company: p.company || "", job_title: p.job_title || "", group: p.group || "" });
    });
    var view = [];
    var rowCls = "flex w-full cursor-pointer items-center justify-between gap-2 px-3 py-2 text-left text-sm hover:bg-elevated";
    function hide() { pop.classList.add("hidden"); input.setAttribute("aria-expanded", "false"); }
    function show() { pop.classList.remove("hidden"); input.setAttribute("aria-expanded", "true"); }
    function fireInput() { input.dispatchEvent(new Event("input", { bubbles: true })); }
    function subOf(o) { return [o.email || o.phone, o.group || o.company].filter(Boolean).join(" · "); } // Gmail식 2줄 부제: 이메일(없으면 전화) · 소속

    // ── 칩(선택된 사람 한 덩어리) — 서버 personChip(views.js)과 마크업 형식 동일 ──
    function chipEl(o) {
      var label = labelOf(o);
      var span = document.createElement("span");
      span.className = "inline-flex max-w-full items-center gap-1 rounded-full border border-border bg-elevated py-0.5 pl-2.5 pr-1 text-sm";
      span.setAttribute("data-pc-chip", "");
      var t = document.createElement("span"); t.className = "truncate"; t.textContent = label; span.appendChild(t);
      var hi = document.createElement("input"); hi.type = "hidden"; hi.name = idField; hi.value = o.id ? String(o.id) : ""; hi.setAttribute("data-pc-chip-id", ""); span.appendChild(hi);
      var hn = document.createElement("input"); hn.type = "hidden"; hn.name = nameField; hn.value = o.name || ""; hn.setAttribute("data-pc-chip-name", ""); span.appendChild(hn);
      var x = document.createElement("button"); x.type = "button";
      x.className = "flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-muted hover:bg-border hover:text-fg";
      x.setAttribute("data-pc-chip-remove", ""); x.setAttribute("aria-label", label + " 제거"); x.textContent = "✕";
      span.appendChild(x);
      return span;
    }
    function chipList() { return chipBox ? Array.prototype.slice.call(chipBox.querySelectorAll("[data-pc-chip]")) : []; }
    // 칩 변경은 클릭으로 폼 데이터를 바꾸므로 dirty 감시(input/change만 봄)에 수동 통지 — 함정 #23.
    function chipsChanged() { if (input.form) input.form.dispatchEvent(new Event("change", { bubbles: true })); }
    function addChip(o) {
      if (!chipBox || !o) return;
      if (chipHas(o)) { input.value = ""; return; } // 이미 담긴 사람은 중복 추가 안 함
      chipBox.insertBefore(chipEl(o), input);
      input.value = ""; chipsChanged();
    }
    function removeChip(chip) { if (chip && chip.parentNode) { chip.parentNode.removeChild(chip); chipsChanged(); } }
    function chipKeys(chip) {
      var id = chip.querySelector("[data-pc-chip-id]"), nm = chip.querySelector("[data-pc-chip-name]");
      return { id: id ? String(id.value || "") : "", name: nm ? String(nm.value || "").trim().toLowerCase() : "" };
    }
    /** 이 사람이 이미 칩으로 담겨 있나 — id 우선(정확), 신규(빈 id) 칩은 본명으로 비교. */
    function chipHas(o) {
      return chipList().some(function (c) {
        var k = chipKeys(c);
        if (k.id && o.id) return String(k.id) === String(o.id);
        return k.name && k.name === String(o.name || "").trim().toLowerCase();
      });
    }
    // 표시 라벨 = 본명 + 호칭 + (활동명) — 아티스트 병기 + 선택 후 필드에 호칭 표기(2026-07-05, 청구서 제외). 제출용 숨김 이름은 순수 본명(input 핸들러가 분리 동기화). 서버 shown과 형식 동일.
    // name 필드가 이미 호칭으로 끝나면(resolveDisplayName이 성+이름+호칭으로 조립한 경우) 중복 안 붙임.
    function labelOf(o) { if (!o) return ""; var n = String(o.name || ""); var h = o.honorific ? String(o.honorific).trim() : ""; var a = o.alt ? String(o.alt).trim() : ""; var s = (h && n.slice(-h.length) !== h) ? n + " " + h : n; return a && a !== n ? s + " (" + a + ")" : s; }
    function setInfo(o, isNew) {
      while (info.firstChild) info.removeChild(info.firstChild);
      var nodes = [];
      if (o && o.phone) { var a = document.createElement("button"); a.type = "button"; a.setAttribute("data-copy", o.phone); a.title = "클릭하면 복사됩니다"; a.textContent = "☎ " + o.phone; a.className = "copyable font-medium text-info"; nodes.push(a); }
      if (o && o.email) { var em = document.createElement("button"); em.type = "button"; em.setAttribute("data-copy", o.email); em.title = "클릭하면 복사됩니다"; em.textContent = "✉ " + o.email; em.className = "copyable text-info"; nodes.push(em); }
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
    // 이미 칩으로 담긴 사람은 후보에서 제외(회사명도 검색 대상이라 '윤종신'을 치면 회사가 '(주)월간윤종신'인
    // 엄유미까지 후보로 뜨던 것 — 2026-07-10 사용자 리포트).
    function isChosen(o) { return multi && chipHas(o); }
    // 후보 랭킹 필드(우선순위): 본명 > 활동명 > 표시 라벨 > 소속 회사. 공용 comboRank 사용.
    function pcFields(o) { return [o.name, o.alt, labelOf(o), o.company]; }

    // Gmail식 제안 행: 이름(+호칭·활동명) 굵게 / 이메일·소속 작게 2줄.
    var personRowCls = "flex w-full cursor-pointer flex-col items-start gap-0 px-3 py-1.5 text-left hover:bg-elevated active:bg-elevated";
    function render() {
      var raw = input.value.trim();
      var q = raw.toLowerCase();
      var html = "";
      if (!q) { view = []; html = newRow(""); }
      else {
        view = comboRankSort(opts.filter(function (o) { return !isChosen(o); }), q, pcFields).slice(0, 12); // 이미 담은 사람 제외 + 매칭 강도순
        html = view.map(function (o, i) {
          // 활동명이 본명과 같으면 괄호 병기 생략('윤종신 (윤종신)' 방지) — labelOf·서버 personName과 동일 규칙.
          var nm = esc(o.name) + (o.honorific ? ' <span class="font-normal text-muted">' + esc(o.honorific) + '</span>' : "") + (o.alt && o.alt !== o.name ? ' <span class="font-normal text-muted">(' + esc(o.alt) + ')</span>' : "");
          var sub = subOf(o);
          return '<button type="button" class="' + personRowCls + '" data-idx="' + i + '"><span class="max-w-full truncate text-sm font-medium text-fg">' + nm + '</span>' + (sub ? '<span class="max-w-full truncate text-xs text-muted">' + esc(sub) + '</span>' : "") + '</button>';
        }).join("");
        var exact = function (o) { return String(o.name).toLowerCase() === q || (o.alt && String(o.alt).toLowerCase() === q) || labelOf(o).toLowerCase() === q; };
        // 이미 담은 사람을 그대로 다시 타이핑한 경우 '새 등록'을 권하지 않는다(중복 생성 유도 방지) — 후보도 없으면 드롭다운을 닫는다.
        var dupe = multi && opts.some(function (o) { return isChosen(o) && exact(o); });
        if (!dupe && !view.some(exact)) html += newRow(raw);
      }
      if (!html) { hide(); return; }
      pop.innerHTML = html; show();
    }
    function pick(o) {
      if (multi) { addChip(o); fireInput(); hide(); return; } // 칩 한 덩어리로 담김(제출은 칩 hidden id·본명 쌍)
      input.value = labelOf(o); hid.value = o.id; setInfo(o, false); fireInput(); hide();
    }
    function openModal() {
      if (!modal) { hide(); return; }
      var n = modal.querySelector("[data-pc-name]"); n.value = input.value.trim(); // 타이핑한 이름 프리필(multi도 입력칸엔 검색어만 있음)
      ["[data-pc-activity]", "[data-pc-phone]", "[data-pc-email]", "[data-pc-company]", "[data-pc-job]"].forEach(function (s) { var el = modal.querySelector(s); if (el) el.value = ""; });
      modal.querySelector("[data-pc-err]").classList.add("hidden");
      modal.classList.remove("hidden"); modal.classList.add("flex"); hide(); n.focus();
    }
    if (modal) {
      var pSave = modal.querySelector("[data-pc-save]"), pCancel = modal.querySelector("[data-pc-cancel]");
      var closeModal = function () { modal.classList.add("hidden"); modal.classList.remove("flex"); };
      pCancel.addEventListener("click", closeModal);
      // 배경 클릭 닫기 — 단, 텍스트 드래그 선택이 모달 배경에서 끝난 경우(mousedown은 안쪽, mouseup=click은 배경)는
      // 닫지 않는다(2026-07-06 사용자 리포트: 이름 전체 선택하려 드래그했는데 마우스를 뗀 지점이 모달 밖이라 닫히던 버그).
      // click 이벤트의 target은 mousedown·mouseup의 공통 조상이라, 드래그가 배경까지 번지면 안쪽에서 시작했어도
      // target===modal이 될 수 있음 — mousedown도 배경에서 시작했을 때만 진짜 배경 클릭으로 간주.
      var mdOnBackdrop = false;
      modal.addEventListener("mousedown", function (e) { mdOnBackdrop = e.target === modal; });
      modal.addEventListener("click", function (e) { if (e.target === modal && mdOnBackdrop) closeModal(); });
      pSave.addEventListener("click", function () {
        var nm = modal.querySelector("[data-pc-name]").value.trim();
        var err = modal.querySelector("[data-pc-err]");
        if (!nm) { err.textContent = "이름을 입력하세요."; err.classList.remove("hidden"); return; }
        var actEl = modal.querySelector("[data-pc-activity]");
        var activity = actEl ? actEl.value.trim() : ""; // 활동명 입력 시 서버가 is_artist=1로 아티스트 등록(createPerson)
        // 회사·직책은 simpleModal(예: 대표자)에선 생략됨 — 요소 없으면 빈값(회사 연결은 업체 저장 시 owner 흐름이 처리).
        var coEl = modal.querySelector("[data-pc-company]"), jobEl = modal.querySelector("[data-pc-job]");
        var phone = modal.querySelector("[data-pc-phone]").value.trim(), email = modal.querySelector("[data-pc-email]").value.trim(),
            company = coEl ? coEl.value.trim() : "", job = jobEl ? jobEl.value.trim() : "";
        pSave.disabled = true; err.classList.add("hidden");
        var body = new URLSearchParams();
        body.append("name", nm);
        if (activity) body.append("nickname", activity); // nickname=활동명(별칭) → createPerson이 activity_name 저장 + is_artist
        if (phone) body.append("phone", phone);
        if (email) body.append("email", email);
        if (company) body.append("company", company);
        if (job) body.append("job_title", job);
        fetch("/contacts", { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded", "X-Requested-With": "fetch" }, body: body.toString() })
          .then(function (r) { return r.ok ? r.json() : null; })
          .then(function (d) { if (!d || !d.ok) throw new Error("fail"); var hon = job ? (/님$/.test(job) ? job : job + "님") : ""; announceParty({ kind: "person", id: d.id, name: d.name, activity: activity, phone: phone, email: email, company: company, job_title: job, honorific: hon, isArtist: !!activity }); if (multi) { addChip({ id: d.id, name: d.name, alt: activity, honorific: hon }); } else { input.value = labelOf({ name: d.name, alt: activity, honorific: hon }); hid.value = d.id; setInfo({ phone: phone, email: email, company: company }, true); } closeModal(); fireInput(); hide(); if (window.__toast) window.__toast(d.name + " 등록됨"); }) // 전역 브로드캐스트 + 드롭다운 닫기. 호칭은 서버가 직책에서 파생(honorificFromTitle)하므로 표시도 같은 규칙으로 즉시 반영
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
        // 회사 옵션: 모달 안 인라인 스크립트 우선, 없으면 페이지 공유 스크립트(data-pc-company-ref) 참조(세션 목록 중복 제거 — 스케일 점검).
        var coDataEl = modal.querySelector("[data-pc-company-options]") || document.getElementById(modal.getAttribute("data-pc-company-ref") || "");
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
          coView = (q ? comboRankSort(coOpts, q, function (o) { return [o.name]; }) : coOpts).slice(0, 10); // 정확 일치 우선(공용 랭킹)
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
      render();
      if (multi) return; // 칩 모드: 입력칸은 검색어 전용(제출값은 칩 hidden), 숨김 id·정보줄 미사용
      var v = input.value.trim().toLowerCase();
      // 순수 본명 또는 표시 라벨('본명 (활동명)')과 정확 일치하면 선택 유지 — pick이 라벨을 넣어도 id가 안 풀리게.
      var m = opts.filter(function (o) { return String(o.name).toLowerCase() === v || labelOf(o).toLowerCase() === v; })[0];
      if (hidName) hidName.value = m ? m.name : input.value; // 제출용 숨김 이름 = 순수 본명(라벨 그대로 저장돼 '박수한 (워터멜론)' 연락처가 생기는 것 방지) · 미일치 시 타이핑 텍스트
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
    if (multi && chipBox) {
      // 칩 ✕ 클릭(위임) — 칩 안 hidden까지 통째로 제거.
      chipBox.addEventListener("click", function (e) {
        var x = e.target.closest("[data-pc-chip-remove]");
        if (x) { e.preventDefault(); removeChip(x.closest("[data-pc-chip]")); input.focus(); }
      });
      // 빈 입력에서 백스페이스 → 마지막 칩 삭제(Gmail 동작). 텍스트가 있으면 평범한 글자 지우기.
      input.addEventListener("keydown", function (e) {
        if (e.isComposing || e.keyCode === 229) return; // 한글 IME 조합 중(함정 #18)
        if (e.key !== "Backspace" || input.value !== "") return;
        var list = chipList();
        if (list.length) { e.preventDefault(); removeChip(list[list.length - 1]); }
      });
      // 칩 영역 아무 데나 클릭하면 입력칸으로 포커스(입력칸이 칩 뒤에 밀려 있어도).
      chipBox.addEventListener("mousedown", function (e) { if (e.target === chipBox) { e.preventDefault(); input.focus(); } });
    }
    if (!multi && hid.value) { var init = opts.filter(function (o) { return String(o.id) === String(hid.value); })[0]; if (init) setInfo(init, false); } // 편집 초기값 정보
    // 프로그래매틱 세팅(다른 콤보 연동용) — 제작/운영에 개인 선택 시 고객측 담당자 자동 채움(2026-07-05).
    root.__pcSetById = function (id) {
      var m = opts.filter(function (o) { return String(o.id) === String(id); })[0];
      if (multi) { if (m) addChip(m); return; }
      if (m) { input.value = labelOf(m); hid.value = m.id; if (hidName) hidName.value = m.name; setInfo(m, false); }
      else { hid.value = id; } // 옵션에 없으면 id만(정보 표시는 생략)
    };
    root.__pcHasValue = function () { return multi ? chipList().length > 0 : !!(hid.value && String(hid.value).trim()); };
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
      // 이름(label) 우선, 소속·분류(sub)는 후순위 — 정확 일치가 부분 일치보다 먼저(공용 랭킹).
      view = (q ? comboRankSort(items, q, function (it) { return [it.label, it.sub]; }) : items).slice(0, 15);
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

    // 붙여넣기 단축키 OS 구분(2026-07-09 사용자 요청): 맥=⌘V, 그 외=Ctrl+V. 서버는 Ctrl+V로 렌더하고 맥에서만 치환.
    var isMac = /Mac|iPhone|iPad|iPod/.test(navigator.platform || "") || /Mac OS X/.test(navigator.userAgent || "");
    if (isMac && label && label.textContent.indexOf("Ctrl+V") !== -1) label.textContent = label.textContent.replace(/Ctrl\+V/g, "⌘V");
    if (isMac && display) {
      var aria = display.getAttribute("aria-label");
      if (aria && aria.indexOf("Ctrl+V") !== -1) display.setAttribute("aria-label", aria.replace(/Ctrl\+V/g, "⌘V"));
    }

    // 클릭 = 필드 포커스만(붙여넣기 Ctrl+V 준비) — 파일 선택 대화상자는 [파일 찾기] 버튼 전용
    // (2026-07-09 사용자 요청: 필드 클릭마다 대화상자가 떠서 붙여넣기 흐름을 방해하던 것. 대화상자는 버튼으로 충분).
    zone.addEventListener("click", function (e) {
      if (e.target === input) return;
      if (display && display.focus) display.focus();
    });

    // '파일 찾기' 버튼(폼 내부, 드롭존 형제) → 파일 선택 대화상자(윈도우 크롬 등 드래그 안 되는 환경 대안)
    var form0 = zone.closest("form");
    var pick = form0 && form0.querySelector("[data-dropzone-pick]");
    if (pick) pick.addEventListener("click", function () { input.click(); });

    // 붙여넣기(Ctrl+V): 필드에 포커스한 뒤 이미지/파일 붙여넣기 → 즉시 업로드(드래그앤드롭 대안).
    function handlePaste(e) {
      var cd = e.clipboardData || window.clipboardData;
      if (!cd) return;
      var f = null;
      if (cd.files && cd.files.length) f = cd.files[0];
      else if (cd.items) { for (var i = 0; i < cd.items.length; i++) { if (cd.items[i].kind === "file") { f = cd.items[i].getAsFile(); break; } } }
      if (!f) return;
      e.preventDefault();
      try { var dt = new DataTransfer(); dt.items.add(f); input.files = dt.files; } catch (_e) { /* DataTransfer 미지원 */ }
      if (label) label.textContent = (f.name || "붙여넣은 이미지") + " · 업로드 중…";
      autoSubmit();
    }
    zone.addEventListener("paste", handlePaste); // 포커스된 드롭존 필드에서 붙여넣기(버블링 포함)

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

// (수동 청구 폼의 VAT 토글 핸들러는 2026-07-08 수동 청구 폐지와 함께 제거 — from-tasks 청구 폼의 VAT 계산은 할인 폼 경로가 담당.)

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

// 모달 스크롤 잠금(전 모달 공통, 2026-07-04 사용자 요청): 모달이 열려 있으면 배경(문서) 스크롤을 잠근다.
// 모든 모달은 [data-*-modal]/[data-nav-guard] 마커를 갖고 '열림 = hidden 클래스 없음'(토글형) 또는 'DOM에 존재'(동적형).
// 하나라도 열리면 <html>·<body> overflow:hidden(+스크롤바 폭만큼 padding으로 레이아웃 점프 방지). 전부 닫히면 복원.
(function () {
  "use strict";
  var SEL = "[data-pc-modal],[data-cc-modal],[data-artist-modal],[data-nav-guard],[data-modal]";
  var locked = false, scheduled = false;
  function anyOpen() {
    var els = document.querySelectorAll(SEL);
    for (var i = 0; i < els.length; i++) if (!els[i].classList.contains("hidden")) return true;
    return false;
  }
  function apply() {
    scheduled = false;
    var open = anyOpen();
    if (open === locked) return;
    locked = open;
    if (open) {
      var sw = window.innerWidth - document.documentElement.clientWidth; // 스크롤바 폭
      document.documentElement.style.overflow = "hidden";
      document.body.style.overflow = "hidden";
      if (sw > 0) document.body.style.paddingRight = sw + "px";
    } else {
      document.documentElement.style.overflow = "";
      document.body.style.overflow = "";
      document.body.style.paddingRight = "";
    }
  }
  function schedule() { if (scheduled) return; scheduled = true; (window.requestAnimationFrame || setTimeout)(apply); }
  new MutationObserver(schedule).observe(document.documentElement, { childList: true, subtree: true, attributes: true, attributeFilter: ["class"] });
  schedule();
})();

// 검색 typeahead(2026-07-04): [data-search-suggest] 검색 인풋에 타이핑하면 서버(data-suggest-url)에서
// 매칭 결과를 받아 드롭다운으로 제안 → 클릭/엔터로 해당 상세로 이동. 하이라이트 없이 엔터면 폼 제출(전체 검색).
(function () {
  "use strict";
  function esc(s) { return String(s == null ? "" : s).replace(/[&<>"]/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]; }); }
  Array.prototype.forEach.call(document.querySelectorAll("[data-search-suggest]"), function (root) {
    var input = root.querySelector('input[name="q"]');
    var pop = root.querySelector("[data-suggest-pop]");
    var url = root.getAttribute("data-suggest-url");
    if (!input || !pop || !url) return;
    var items = [], hi = -1, timer = null, ctrl = null, lastQ = null;
    function hide() { pop.classList.add("hidden"); input.setAttribute("aria-expanded", "false"); hi = -1; }
    function show() { pop.classList.remove("hidden"); input.setAttribute("aria-expanded", "true"); }
    function setHi(i) {
      var rs = pop.children;
      if (!rs.length) { hi = -1; return; }
      hi = Math.max(0, Math.min(i, rs.length - 1));
      for (var k = 0; k < rs.length; k++) rs[k].classList.toggle("bg-elevated", k === hi);
      if (rs[hi] && rs[hi].scrollIntoView) rs[hi].scrollIntoView({ block: "nearest" });
    }
    function render() {
      if (!items.length) { pop.innerHTML = ""; hide(); return; }
      pop.innerHTML = items.map(function (it) {
        return '<a href="' + esc(it.href) + '" class="flex flex-col gap-0.5 px-3 py-2 hover:bg-elevated"><span class="truncate text-sm text-fg">' + esc(it.label) + "</span>" + (it.sub ? '<span class="truncate text-xs text-muted">' + esc(it.sub) + "</span>" : "") + "</a>";
      }).join("");
      hi = -1; show();
    }
    function fetchSuggest() {
      var q = input.value.trim();
      lastQ = q;
      if (q.length < 1) { items = []; render(); return; }
      if (ctrl && ctrl.abort) { try { ctrl.abort(); } catch (_e) {} }
      ctrl = window.AbortController ? new AbortController() : null;
      fetch(url + (url.indexOf("?") >= 0 ? "&" : "?") + "q=" + encodeURIComponent(q), { headers: { Accept: "application/json" }, credentials: "same-origin", signal: ctrl ? ctrl.signal : undefined })
        .then(function (r) { return r.ok ? r.json() : []; })
        .then(function (d) { if (input.value.trim() !== lastQ) return; items = Array.isArray(d) ? d : []; render(); })
        .catch(function () {});
    }
    input.addEventListener("input", function () { clearTimeout(timer); timer = setTimeout(fetchSuggest, 200); });
    input.addEventListener("focus", function () { if (items.length) show(); });
    input.addEventListener("blur", function () { setTimeout(hide, 150); });
    input.addEventListener("keydown", function (e) {
      if (e.isComposing || e.keyCode === 229) return; // 한글 IME 조합 중 키 무시
      var open = !pop.classList.contains("hidden");
      if (e.key === "ArrowDown") { if (open) { e.preventDefault(); setHi(hi + 1); } }
      else if (e.key === "ArrowUp") { if (open) { e.preventDefault(); setHi(hi - 1); } }
      else if (e.key === "Enter") { if (open && hi >= 0 && pop.children[hi]) { e.preventDefault(); pop.children[hi].click(); } } // 하이라이트 선택 이동, 없으면 폼 제출(전체 검색)
      else if (e.key === "Escape") { hide(); }
    });
    pop.addEventListener("mousedown", function (e) { e.preventDefault(); }); // 클릭 전 blur로 닫히는 것 방지
    pop.addEventListener("mousemove", function (e) { var a = e.target.closest("a"); if (!a) return; var rs = pop.children; for (var k = 0; k < rs.length; k++) if (rs[k] === a) { setHi(k); break; } });
  });
})();

// 장소 주소 자동완성([data-place-suggest], 2026-07-05): Google Places 백엔드 프록시(/sessions/place-suggest).
// 검색 typeahead와 달리 '이동'이 아니라 선택 시 입력칸을 채운다(fill 모드). 미설정(키 없음)이면 서버가 []라 조용히 무동작.
(function () {
  "use strict";
  function esc(s) { return String(s == null ? "" : s).replace(/[&<>"]/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]; }); }
  Array.prototype.forEach.call(document.querySelectorAll("[data-place-suggest]"), function (root) {
    var input = root.querySelector("[data-place-input]");
    var pop = root.querySelector("[data-place-pop]");
    var url = root.getAttribute("data-place-url");
    if (!input || !pop || !url) return;
    var items = [], hi = -1, timer = null, ctrl = null, lastQ = null;
    function hide() { pop.classList.add("hidden"); hi = -1; }
    function show() { pop.classList.remove("hidden"); }
    function setHi(i) {
      var rs = pop.children;
      if (!rs.length) { hi = -1; return; }
      hi = Math.max(0, Math.min(i, rs.length - 1));
      for (var k = 0; k < rs.length; k++) rs[k].classList.toggle("bg-elevated", k === hi);
      if (rs[hi] && rs[hi].scrollIntoView) rs[hi].scrollIntoView({ block: "nearest" });
    }
    function render() {
      if (!items.length) { pop.innerHTML = ""; hide(); return; }
      pop.innerHTML = items.map(function (it) {
        return '<button type="button" class="flex w-full flex-col gap-0.5 px-3 py-2 text-left hover:bg-elevated active:bg-elevated" data-place-val="' + esc(it.value) + '"><span class="truncate text-sm text-fg">' + esc(it.label) + "</span>" + (it.sub ? '<span class="truncate text-xs text-muted">' + esc(it.sub) + "</span>" : "") + "</button>";
      }).join("");
      hi = -1; show();
    }
    function pick(val) { input.value = val; input.dispatchEvent(new Event("change", { bubbles: true })); hide(); items = []; }
    function fetchSuggest() {
      var q = input.value.trim();
      lastQ = q;
      if (q.length < 2) { items = []; render(); return; }
      if (ctrl && ctrl.abort) { try { ctrl.abort(); } catch (_e) {} }
      ctrl = window.AbortController ? new AbortController() : null;
      fetch(url + "?q=" + encodeURIComponent(q), { headers: { Accept: "application/json" }, credentials: "same-origin", signal: ctrl ? ctrl.signal : undefined })
        .then(function (r) { return r.ok ? r.json() : []; })
        .then(function (d) { if (input.value.trim() !== lastQ) return; items = Array.isArray(d) ? d : []; render(); })
        .catch(function () {});
    }
    input.addEventListener("input", function () { clearTimeout(timer); timer = setTimeout(fetchSuggest, 250); });
    input.addEventListener("blur", function () { setTimeout(hide, 150); });
    input.addEventListener("keydown", function (e) {
      if (e.isComposing || e.keyCode === 229) return; // 한글 IME 조합 중 키 무시
      var open = !pop.classList.contains("hidden");
      if (e.key === "ArrowDown") { if (open) { e.preventDefault(); setHi(hi + 1); } }
      else if (e.key === "ArrowUp") { if (open) { e.preventDefault(); setHi(hi - 1); } }
      else if (e.key === "Enter") { if (open && hi >= 0 && pop.children[hi]) { e.preventDefault(); pick(pop.children[hi].getAttribute("data-place-val")); } }
      else if (e.key === "Escape") { hide(); }
    });
    pop.addEventListener("mousedown", function (e) { e.preventDefault(); }); // 클릭 전 blur 방지
    pop.addEventListener("click", function (e) { var b = e.target.closest("[data-place-val]"); if (b) pick(b.getAttribute("data-place-val")); });
    pop.addEventListener("mousemove", function (e) { var b = e.target.closest("[data-place-val]"); if (!b) return; var rs = pop.children; for (var k = 0; k < rs.length; k++) if (rs[k] === b) { setHi(k); break; } });
  });
})();

// ── 첨부 파일 '보기' 팝업(사업자등록증 등) — 새 창을 디스플레이 오른쪽 위에 50% 크기로(2026-07-08 사용자 요청).
// 탭(target=_blank)은 위치·크기 지정이 불가해 window.open 팝업으로. 팝업 차단 시 기존 새 탭 폴백(preventDefault 안 함).
(function () {
  document.addEventListener("click", function (e) {
    var a = e.target && e.target.closest ? e.target.closest("a[data-popup-view]") : null;
    if (!a) return;
    var s = window.screen || {};
    var sw = s.availWidth || s.width || 1280;
    var sh = s.availHeight || s.height || 800;
    // 세로 문서(사업자등록증 A4 스캔) 기본 비율로 크게(2026-07-08 사용자 요청 — 50%×50% 가로창은 작고 비율이 안 맞음).
    // 높이=화면 92%, 폭=높이×0.72(A4 근사). 실제 이미지 비율은 뷰어(viewer.js)가 로드 후 창을 재조정.
    var h = Math.round(sh * 0.92);
    var w = Math.min(Math.round(h * 0.72), Math.round(sw * 0.9));
    var left = (s.availLeft || 0) + sw - w; // 오른쪽 끝
    var top = s.availTop || 0; // 위쪽 끝
    var win = window.open(a.href, "attachmentView", "popup=yes,width=" + w + ",height=" + h + ",left=" + left + ",top=" + top);
    if (win) { e.preventDefault(); try { win.focus(); } catch (_e) {} }
  });
})();
