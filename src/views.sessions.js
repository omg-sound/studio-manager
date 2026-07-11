"use strict";

/** 세션(스튜디오 일정) 렌더 — 프로젝트 상세 섹션 + 전역 일정에서 공유. */

const { config, SESSION_TYPES, RENTAL_SESSION_TYPES, SESSION_STATUS_BADGE, SESSION_TYPE_RATE_KIND } = require("./config");
const { esc, formatKRW, emptyState, detailsChevron, explain, dirtyActionRow, personCombo, personComboOptionsScript, personComboCompanyScript, personLabel } = require("./views");
const { formatYmdShort, ddayLabel, todayYmd, minutesBetween } = require("./lib/date");
const { listRooms, getDefaultBooker, getProMinutes, contactOptions, partyOptions, listSessionDirectors, listSessionEngineers, listRateCategories, rateCategoryKind } = require("./data");

/**
 * 룸 목록 보장 — 인자로 받으면 그대로, 아니면 활성 룸 조회(폴백).
 * projects.routes.js 등 rooms를 넘기지 않는 호출부에서도 룸 select가 채워지도록 한다(순환참조 없음: data는 views.sessions를 require하지 않음).
 */
function resolveRooms(rooms) {
  return Array.isArray(rooms) ? rooms : listRooms();
}

/** 장소(룸) select. 현재값 선택. 없으면 첫 장소(A룸)를 기본 선택. '장소 미지정'은 맨 아래. 외부 장소 옵션은 data-external=1(주소 필드 노출용). */
function roomSelect(rooms, currentId) {
  const cur = currentId == null || currentId === "" ? "" : String(currentId);
  const auto = cur === "" && rooms.length ? String(rooms[0].id) : cur; // 신규 예약은 첫 장소 기본
  const opts = [];
  for (const r of rooms) {
    opts.push(`<option value="${r.id}" data-external="${r.is_external ? 1 : 0}" ${String(r.id) === auto ? "selected" : ""}>${esc(r.name)}</option>`);
  }
  opts.push(`<option value="" data-external="0" ${auto === "" ? "selected" : ""}>장소 미지정</option>`); // 맨 아래
  return `<select class="input py-1.5 text-sm" name="room_id" data-room-select>${opts.join("")}</select>`;
}

/** 담당자 마스터 선택지. 현재값이 목록에 없으면 보존용으로 추가. 예약 담당자·담당 엔지니어 공용. */
function managerOptions(managers, current, placeholder = "담당자 미지정", { allowEmpty = true } = {}) {
  const names = managers.map((m) => m.name);
  const out = allowEmpty ? [`<option value="">${esc(placeholder)}</option>`] : []; // allowEmpty=false면 '미지정' 옵션 없음
  if (current && !names.includes(current)) {
    out.push(`<option value="${esc(current)}" selected>${esc(current)} (목록 외)</option>`);
  }
  for (const m of managers) {
    out.push(`<option value="${esc(m.name)}" ${m.name === current ? "selected" : ""}>${esc(m.name)}</option>`);
  }
  return out.join("");
}

/** 담당 엔지니어 다대다 행의 select 옵션 — value=담당자 마스터 id(이름 기반 managerOptions와 구분, 동명이인·이름변경에도 안전).
 *  data-external=외주 작업자(user_id 없음)면 1 — app.js가 그 행의 지급단가 칸 토글(작업 폼 engineerSelect와 동일 규칙). */
function managerOptionsById(managers, selectedId) {
  const cur = selectedId == null ? "" : String(selectedId);
  const out = [`<option value="">엔지니어 선택</option>`];
  for (const m of managers) out.push(`<option value="${m.id}" ${String(m.id) === cur ? "selected" : ""} data-external="${m.user_id ? "" : "1"}">${esc(m.name)}${m.user_id ? "" : " · 외주"}</option>`);
  return out.join("");
}

/**
 * 담당 엔지니어 한 행 — select+제거 버튼은 한 줄, 외주 지급단가는 **그 아래 줄에 전체 폭으로**(2026-07-06 사용자
 * 리포트 '레이아웃이 찌그러진다' — 좁은 우측 사이드 칼럼[~220px]에 select+금액칸+X버튼 셋을 한 줄에 넣으니
 * 이름이 "김오…"로 잘리고 금액칸도 비좁았음). selectedId 없으면 빈 선택(추가 행).
 */
function engineerRow(managers, selectedId, rate) {
  const external = selectedId != null && managers.some((m) => Number(m.id) === Number(selectedId) && !m.user_id);
  return `<div class="mt-1.5" data-engineer-row>
      <div class="flex items-center gap-1.5">
        <select class="input min-w-0 flex-1 py-1.5 text-sm" name="engineer_ids">${managerOptionsById(managers, selectedId)}</select>
        <button type="button" class="btn-ghost btn-xs shrink-0" data-engineer-remove aria-label="담당 엔지니어 제거">✕</button>
      </div>
      <div class="relative mt-1 ${external ? "" : "hidden"}" data-engineer-rate>
        <input class="input w-full py-1.5 pr-7 text-sm tabular" name="engineer_rates" inputmode="numeric" placeholder="외주 지급단가" value="${rate ? esc(String(rate)) : ""}" aria-label="외주 지급단가" />
        <span class="pointer-events-none absolute inset-y-0 right-2 flex items-center text-xs text-muted">원</span>
      </div>
    </div>`;
}


function timeLabel(s) {
  if (s.all_day) return s.end_date && s.end_date > s.session_date ? `종일 · ~${esc(formatYmdShort(s.end_date))}` : "종일"; // 다일이면 종료일 병기
  if (s.start_time && s.end_time) return `${esc(s.start_time)}–${esc(s.end_time)}`;
  if (s.start_time) return esc(s.start_time);
  return "시간 미정";
}

/** 소요시간 버튼([1Pro][2Pro][직접입력]) — 종료는 서버에서 시작+길이로 계산. */
// 소요 시간 = 슬라이더(30분 단위·0~16시간)가 주 입력. 아래 1~4Pro 프리셋·직접입력(시간)은 슬라이더를 세팅한다.
// 전송값은 custom_hours + duration_mode=custom(hidden) → 서버 resolveEndTime이 그대로 산정(슬라이더 자체는 미전송 UI).
// minutesBetween은 ../lib/date 공용 유틸을 사용한다(중복 정의 제거).
/** 소요 라벨(초기 렌더) — app.js fmtDuration과 동일 표기("7시간"/"3시간 30분"/"설정 안 함"). */
function fmtDurationKo(mins) {
  if (!(Number(mins) > 0)) return "설정 안 함";
  const hh = Math.floor(mins / 60), mm = Math.round(mins % 60);
  return ((hh ? hh + "시간" : "") + (mm ? (hh ? " " : "") + mm + "분" : "")) || "0분";
}
const DURATION_SLIDER_MAX = 960; // 슬라이더 최대(분) = 16시간. Pro 눈금 위치 계산의 기준(app.js SLIDER_MAX와 동일).
function durationButtons(initMinutes = 0) {
  const m = Number(initMinutes) > 0 ? Math.round(Number(initMinutes)) : 0;
  // 16h(960분) 초과(종일 23:59 등)는 custom_hours를 비워 둔다 — 채우면 서버 resolveEndTime이 960분으로 클램프해
  // 편집-저장 시 종료시각이 16h로 잘리는 왜곡. 빈 hours면 서버가 end_time을 그대로 사용(정확 보존).
  const hours = m > 0 && m <= 960 ? (m % 60 === 0 ? String(m / 60) : (m / 60).toFixed(1)) : "";
  const pro = getProMinutes();
  // Pro 프리셋을 슬라이더 트랙 위 '눈금'으로 절대배치: 1Pro=기준시간, 2Pro=×2… 위치에 표시
  // (예: 기준 3시간30분이면 1Pro가 슬라이더 3시간30분 지점). 인라인 style은 CSP(styleSrc unsafe-inline 없음)에 막히므로
  // 서버는 Tailwind 위치 클래스로 기본값(210분 기준 25/50/75/100%)만 렌더하고, app.js가 CSSOM으로 실제 기준시간에 맞춰 재배치한다.
  // 데스크톱(sm+): Pro를 슬라이더 위치에 맞춰 절대배치(app.js가 기준시간으로 재배치). 모바일: 절대배치 없이 앞에서부터 흐름 정렬(flex).
  const TICK_POS = { 1: "sm:left-1/4 sm:-translate-x-1/2", 2: "sm:left-1/2 sm:-translate-x-1/2", 3: "sm:left-3/4 sm:-translate-x-1/2", 4: "sm:left-full sm:-translate-x-full" };
  const tickBtn = (n) =>
    `<button type="button" class="static top-0 sm:absolute sm:top-0 ${TICK_POS[n]} whitespace-nowrap rounded-md border border-border bg-bg px-2 py-1 text-xs hover:border-primary disabled:cursor-not-allowed disabled:text-muted/40" data-duration-preset="pro${n}">${n}Pro</button>`;
  return `
    <div data-duration-group data-pro-default="${pro}">
      <div class="relative">
        <input type="range" min="0" max="${DURATION_SLIDER_MAX}" step="30" value="${Math.min(m, DURATION_SLIDER_MAX)}" class="w-full cursor-pointer accent-primary" data-duration-slider aria-label="소요 시간" />
        <div class="relative mt-1 flex h-8 flex-wrap items-center gap-1.5 sm:block" data-duration-ticks data-show-when="rec">${tickBtn(1)}${tickBtn(2)}${tickBtn(3)}${tickBtn(4)}</div>
      </div>
      <input type="hidden" name="custom_hours" value="${hours}" data-custom-hours />
      <input type="hidden" name="duration_mode" value="custom" />
    </div>`;
}

/**
 * '녹음 종류' select — 단가표 항목(rate_items)을 분류(스튜디오/로케이션 녹음)로 묶는다. data-minutes로 1Pro 계산.
 * required=true면 data-rate-required(녹음 폼: 선택해야 시작 시간 입력 가능). 편집·믹스 폼은 false.
 */
/** 단가 항목 옵션 HTML(미지정 + 카테고리별 optgroup). 세션 종류에 따라 녹음/촬영 항목만 넘겨 렌더 — app.js가 종류 변경 시 이 옵션을 통째로 교체. */
function rateOptionsHtml(rateItems, currentId) {
  const catOrder = listRateCategories().map((c) => c.name); // DB 순서(kind→sort_order→이름) — 2026-07-05 config 하드코딩에서 전환
  const groups = {};
  rateItems.forEach((r) => {
    const c = r.category || catOrder[0] || "";
    (groups[c] = groups[c] || []).push(r);
  });
  const cats = [...catOrder.filter((c) => groups[c]), ...Object.keys(groups).filter((c) => !catOrder.includes(c))];
  const opt = (r) => `<option value="${r.id}" data-minutes="${Number(r.base_minutes) || 0}" ${String(r.id) === String(currentId || "") ? "selected" : ""}>${esc(r.name)}</option>`;
  return `<option value="" data-minutes="0">미지정</option>` + cats.map((c) => `<optgroup label="${esc(c)}">${groups[c].map(opt).join("")}</optgroup>`).join("");
}
function rateSelectGrouped(rateItems, currentId, required = false) {
  return `<select class="input py-1.5 text-sm" name="rate_item_id" data-rate-select ${required ? "data-rate-required" : ""}>${rateOptionsHtml(rateItems, currentId)}</select>`;
}

/**
 * 예약(생성)용 폼 필드 — 시작 버튼 그리드 + 소요시간 버튼. 종료는 서버가 계산.
 * 녹음 프로젝트: '녹음 종류'(단가표 항목을 분류로 묶음) 한 필드 + session_type='녹음' 고정.
 * 그 외(믹스 등): '세션 종류'(session_type) + '녹음 종류'(단가표 항목) 두 필드. 라벨은 편집 폼과 통일.
 */
function sessionBookingFields(s, managers, rateItems = [], rooms, defaultBooker = "", pmName = "", optionsRef = "") {
  const initMins = s && s.start_time && s.end_time ? minutesBetween(s.start_time, s.end_time) : 0;
  const roomList = resolveRooms(rooms);
  // 담당 엔지니어 다대다(2026-07-05 — 여러 명 가능): 배정된 엔지니어 수만큼 행(select) + '담당 엔지니어 추가하기' 버튼(template 복제, app.js).
  const currentEngineers = s && s.id ? listSessionEngineers(s.id) : [];
  const engineerField = `
    <div>
      <label class="label-sm">담당 엔지니어 <span class="font-normal text-muted">(여러 명 가능)</span></label>
      <div data-engineer-list>${currentEngineers.map((e) => engineerRow(managers, e.id, e.worker_rate)).join("")}</div>
      <template data-engineer-template>${engineerRow(managers, null)}</template>
      <button type="button" class="btn-ghost btn-xs mt-1.5" data-engineer-add>+ 담당 엔지니어 추가하기</button>
    </div>`;
  // 세션 종류는 항상 선택 가능. 단가 항목은 대관 세션(녹음·촬영·공연)일 때만 노출(app.js data-show-when="rec").
  // 단가 항목은 세션 종류 kind에 맞는 항목만 보인다 — 서버는 현재 kind로 렌더 + kind별 <template> 임베드, app.js가 종류 변경 시 옵션 교체.
  const rateKinds = [...new Set(Object.values(SESSION_TYPE_RATE_KIND))]; // recording·filming·performance …(config가 단일 진실원천)
  const itemsByKind = Object.fromEntries(rateKinds.map((k) => [k, rateItems.filter((r) => rateCategoryKind(r.category) === k)]));
  const curKind = SESSION_TYPE_RATE_KIND[s.session_type] || "recording";
  const curItems = itemsByKind[curKind] || [];
  const rateKindsAttr = Object.entries(SESSION_TYPE_RATE_KIND).map(([k, v]) => `${k}:${v}`).join(","); // "녹음:recording,촬영:filming,공연:performance"
  const typeRateRow = `<div class="grid gap-2 sm:grid-cols-3">
         <div><label class="label-sm">세션 종류</label>
          <select class="input py-1.5 text-sm" name="session_type" data-rec-types="${esc(RENTAL_SESSION_TYPES.join(","))}" data-rate-kinds="${esc(rateKindsAttr)}">${SESSION_TYPES.map((t) => `<option value="${esc(t)}" ${t === s.session_type ? "selected" : ""}>${esc(t)}</option>`).join("")}</select></div>
         <div data-show-when="rec"><label class="label-sm">단가 항목</label>
          <select class="input py-1.5 text-sm" name="rate_item_id" data-rate-select>${rateOptionsHtml(curItems, s.rate_item_id)}</select>
          ${rateKinds.map((k) => `<template data-rate-opts-${k}>${rateOptionsHtml(itemsByKind[k], s.rate_item_id)}</template>`).join("")}</div>
         <div><label class="label-sm">장소</label>
          ${roomSelect(roomList, s.room_id)}</div>
       </div>
       <div class="mt-2" data-external-loc ${s.room_id && roomList.some((r) => Number(r.id) === Number(s.room_id) && r.is_external) ? "" : "hidden"}>
         <label class="label-sm">장소 주소 <span class="font-normal text-muted text-xs">(외부 장소 — 구글 지도용 주소${config && config.placesApiKey ? " · 타이핑하면 제안" : ""})</span></label>
         <div class="relative" ${config && config.placesApiKey ? 'data-place-suggest data-place-url="/sessions/place-suggest"' : ""}>
           <input class="input py-1.5 text-sm" name="location" value="${esc(s.location || "")}" placeholder="예: 서울시 강남구 … / 장소명" autocomplete="off" data-place-input />
           <div class="absolute left-0 right-0 z-30 mt-1 hidden max-h-64 overflow-auto rounded-lg border border-border bg-surface py-1 shadow-lg" data-place-pop role="listbox"></div>
         </div>
       </div>
       ${explain(`청구하려면 <b>세션 종류=녹음/촬영</b> + <b>단가 항목</b> 선택이 모두 필요합니다. (완료 처리 후 청구 탭에 노출)`)}`;
  // 담당 디렉터 — 콤마로 여러 명(2026-07-05, 아티스트 콤보와 동일 UX·옛 행 복제(+추가/✕) 폐지):
  // personCombo(multi) 하나 — 마지막 콤마 뒤 조각으로 검색, 선택·간이등록은 이어붙임, 제출=director_name 콤마 텍스트(라벨 포함).
  // 서버 resolveDirectorIds가 콤마 split 후 이름별 해석(resolvePersonByName 라벨 안전망 — '박수한 대표님 (워터멜론)'도 그 사람으로).
  const allContacts = contactOptions();
  // 회사 옵션도 optionsRef가 있으면(세션 목록 — 폼이 여럿) 페이지 공유 스크립트를 참조해 행마다 중복 임베드 안 함(2026-07-10 스케일 점검).
  const companyOpts = optionsRef ? [] : partyOptions({ role: "company" }); // '새 담당자 등록' 모달 회사칸 검색 콤보 — 기존 회사 타이핑 검색·오타/중복 방지
  const currentDirectors = s && s.id ? listSessionDirectors(s.id) : []; // 편집 프리필 = 칩 목록(제출은 칩 hidden id·본명 쌍)
  const directorField = `
    <div class="mt-2">
      <label class="label-sm">담당 디렉터 <span class="font-normal text-muted">(고객측 담당자 — 여러 명 가능)</span></label>
      ${personCombo({ idField: "director_contact_id", nameField: "director_name", selected: currentDirectors, options: allContacts, companyOptions: companyOpts, companyOptionsRef: optionsRef ? "pc-company-shared" : "", optionsRef, compact: true, multi: true, placeholder: currentDirectors.length ? "" : "담당 디렉터 — 검색 또는 새로 등록" })}
      ${explain(`이름을 검색해 고르면 배지로 담깁니다(여러 명 가능). 배지의 ✕ 또는 빈 칸에서 백스페이스로 한 명씩 뺍니다. 목록에 없는 이름은 저장 시 새 연락처로 등록됩니다.`)}
    </div>`;
  // 시간 입력 = 구글 캘린더식(2026-07-04 그리드 폐지): [날짜][시작]–[종료][종료날짜(자동)] 타이핑 + 종일 + 소요 슬라이더.
  // 시작/종료는 콜론 자동 삽입(1400→14:00, app.js). 종료·슬라이더는 양방향 동기(종료 입력→소요 재계산, 소요 변경→종료 갱신).
  // 종료 날짜는 저장 필드가 아니라 자동 표시(자정 넘김이면 +1일 — 스키마는 session_date 하나, 야간 세션은 end<start로 표현).
  // 시간 박스 = 타이핑 + 30분 단위 드롭다운(00:00~23:30, 구글식 — 포커스 시 전체선택·목록, app.js [data-time-combo]).
  // 보이는 입력은 name 없음(Chrome 과거값 제안·자동완성 원천 차단 — 함정 #19 패턴), 제출은 hidden(data-time-hidden, app.js 동기화).
  const timeBox = (name, val, ph, extra = "") => `<div class="relative" data-time-combo>
        <input type="hidden" name="${name}" value="${esc(val || "")}" data-time-hidden />
        <input class="input w-[5.5rem] py-1.5 text-center text-sm tabular" type="text" inputmode="numeric" value="${esc(val || "")}" placeholder="${ph}" maxlength="5" autocomplete="off" ${extra} />
        <!-- 30분 단위 시간 목록은 app.js가 초기화 시 생성(48개 × 폼당 2박스가 서버 HTML을 불리던 것 — 2026-07-09 스케일 점검) -->
        <div class="absolute left-0 z-30 mt-1 hidden max-h-56 w-24 overflow-auto rounded-lg border border-border bg-surface py-1 shadow-lg" data-time-pop role="listbox"></div>
      </div>`;
  const endDateInit = (() => {
    const d = s.session_date || todayYmd();
    if (s.all_day && s.end_date && s.end_date > d) return s.end_date; // 종일 다일 일정: 저장된 종료 날짜 복원
    if (s.start_time && s.end_time && s.end_time < s.start_time) { // 야간(자정 넘김) → +1일
      const t = new Date(d + "T00:00:00"); t.setDate(t.getDate() + 1); // 로컬 기준(+1일)
      const mm = t.getMonth() + 1, dd = t.getDate();
      return `${t.getFullYear()}-${mm < 10 ? "0" : ""}${mm}-${dd < 10 ? "0" : ""}${dd}`; // toISOString은 UTC라 KST 하루 밀림
    }
    return d;
  })();
  // 레이아웃 = 구글 캘린더 일정 편집기 모사(2026-07-04 사용자 요청 — 항목은 그대로, 배치만):
  //  ① 최상단 전폭 = 시간 블록(날짜 → 시작 시간 그리드 → 소요 슬라이더) — 구글의 날짜·시간 줄
  //  ② 좌측 상자 = '세션 세부정보'(종류·단가·룸·디렉터·메모) — 구글의 일정 세부정보 카드
  //  ③ 우측 사이드 = 사람(PM 표기[프로젝트에서 지정·읽기 전용] + 예약 담당자·담당 엔지니어) — 구글의 참석자 패널
  //  md 미만은 소스 순서대로 세로 스택(시간 → 세부정보 → 사람).
  return `
    <input type="hidden" name="status" value="${esc(s.status || "예정")}" />
    <div class="space-y-3" data-time-block>
      <div class="flex flex-wrap items-center gap-2">
        <input class="input w-auto py-1.5 text-sm" type="date" name="session_date" value="${esc(s.session_date || todayYmd())}" data-session-date data-datepick aria-label="날짜" required />
        ${timeBox("start_time", s.start_time, "14:00", 'data-start-input aria-label="시작 시간"')}
        <span class="text-muted">–</span>
        ${timeBox("end_time", s.end_time, "18:00", 'data-end-input aria-label="종료 시간"')}
        <input class="input w-auto py-1.5 text-sm" type="date" name="end_date" value="${endDateInit}" data-end-date data-datepick aria-label="종료 날짜" />
        <label class="flex w-fit cursor-pointer items-center gap-2 pl-1 text-sm">
          <input type="checkbox" name="all_day" value="1" class="h-4 w-4 rounded border-border text-primary" data-all-day ${s.all_day ? "checked" : ""} /> 종일
        </label>
      </div>
      <p class="text-xs text-warning" data-conflict-warn hidden>⚠ 이 시간대에 같은 장소 예약이 이미 있습니다.</p>
      <input type="hidden" name="override_conflict" value="" data-override-conflict />
      <div data-duration-wrap>
        <label class="label-sm">소요 시간 <span class="ml-1 font-medium text-primary" data-duration-label>${fmtDurationKo(initMins)}</span></label>
        ${durationButtons(initMins)}
      </div>
    </div>
    <div class="mt-4 grid gap-3 md:grid-cols-[minmax(0,1fr)_220px] md:items-start">
      <div class="rounded-lg border border-border bg-bg/40 p-3">
        <div class="mb-2 text-sm font-medium">세션 세부정보</div>
        ${typeRateRow}
        ${directorField}
        <input class="input mt-3 py-1.5 text-sm" name="memo" placeholder="메모(선택)" value="${esc(s.memo || "")}" />
      </div>
      <div class="space-y-3 rounded-lg border border-border bg-bg/40 p-3">
        ${pmName ? `<div>
          <div class="label-sm">PM</div>
          <div class="text-sm font-medium">${esc(pmName)}</div>
          <p class="mt-0.5 text-xs text-muted">프로젝트 담당 — 표기만</p>
        </div>` : ""}
        <div><label class="label-sm">예약 담당자</label>
          <select class="input py-1.5 text-sm" name="booker_name">${managerOptions(managers, s.booker_name || defaultBooker || getDefaultBooker() || "", "", { allowEmpty: false })}</select></div>
        ${engineerField}
      </div>
    </div>`;
}

/** 프로젝트 상세용 세션 추가 폼(버튼형 예약 UX). */
function sessionCreateForm(project, managers, rateItems = [], rooms, defaultBooker = "", pmName = "", optionsRef = "") {
  return `
    <form method="post" action="/sessions" class="rounded-lg border border-border bg-bg p-3" data-session-form>
      <input type="hidden" name="project_id" value="${project.id}" />
      ${sessionBookingFields({}, managers, rateItems, rooms, defaultBooker, pmName, optionsRef)}
      <div class="mt-4 flex justify-end">
        <button class="btn-primary btn-sm" type="submit">+ 세션 추가</button>
      </div>
    </form>`;
}

/** 세션 한 행. showProject=true면 프로젝트명 링크 표시(전역 일정). tracks 전달 시 청구 작업 생성 폼 노출. */
function sessionRow(s, { isAdmin = false, managers = [], rateItems = [], rooms, showProject = false, projectTitle = "", pmName = "", optionsRef = "" } = {}) {
  const typeBadge = `<span class="badge bg-bg text-muted">${esc(s.session_type)}</span>`;
  // 상태 배지: 예정·완료는 배지 없음(완료 버튼 토글이 상태를 나타냄 — 라벨 불필요). 취소 등만 배지 표시.
  const statusBadge = s.status === "예정" || s.status === "완료"
    ? ""
    : `<span class="badge ${SESSION_STATUS_BADGE[s.status] || "bg-muted/10 text-muted"}">${esc(s.status)}</span>`;
  const dday = s.status !== "취소" && s.session_date >= todayYmd() ? ` · ${esc(ddayLabel(s.session_date))}` : "";
  const directors = listSessionDirectors(s.id);
  // 하위 정보를 줄 단위로 쌓는다(사용자 요청): 회사 / 아티스트 / (예약·엔지니어 한 줄) / 디렉터 / 메모.
  const company = String(s.production_company || s.artist_company || "").trim(); // 제작사 우선, 없으면 소속사
  const artist = String(s.artist || "").trim();
  const projLink = (text) => `<a href="/projects/${s.project_id}" class="text-primary hover:underline">${esc(text)}</a>`;
  const infoLines = [];
  if (showProject) {
    // 회사·아티스트를 별도 줄로. 프로젝트 링크는 회사(없으면 아티스트, 둘 다 없으면 제목)에 건다.
    if (company) {
      infoLines.push(projLink(company));
      if (artist) infoLines.push(`<span class="text-fg/80">${esc(artist)}</span>`);
    } else if (artist) {
      infoLines.push(projLink(artist));
    } else if (s.project_title) {
      infoLines.push(projLink(s.project_title));
    }
  }
  const engineers = listSessionEngineers(s.id);
  const bookerEng = [
    s.booker_name ? `예약 ${esc(s.booker_name)}` : "",
    engineers.length ? `엔지니어 ${engineers.map((e) => esc(e.name)).join(", ")}` : "",
  ].filter(Boolean).join(" · ");
  if (bookerEng) infoLines.push(bookerEng); // 예약 담당자 · 담당 엔지니어 = 같은 줄
  if (directors.length) infoLines.push(`디렉터 ${directors.map((d) => esc(personLabel(d.name, d.activity_name))).join(", ")}`); // 디렉터 = 다음 줄, 아티스트면 본명 (활동명) 병기
  if (!bookerEng && !directors.length) infoLines.push("담당자 미정");
  if (s.memo) infoLines.push(esc(s.memo));
  const sub = infoLines.map((l) => `<div class="truncate">${l}</div>`).join("");
  // 녹음 세션은 청구 탭에서 직접 청구된다(곡·콘텐츠/버튼 없음). 여기선 예상액·청구상태만 표시.
  // 세 항목(예상 청구액 / 소요·종류 / 청구상태)을 flex-wrap 묶음으로 — 데스크톱 1줄, 좁아지면 항목 단위로 2·3줄(각 항목은 whitespace-nowrap로 안 찌그러짐).
  const billStatusChunk = s.invoiced
    ? '<span class="whitespace-nowrap text-muted">청구됨</span>'
    : s.billed_task_id
      ? '<span class="whitespace-nowrap text-muted">작업 생성됨</span>'
      : s.status === "완료"
        ? '<span class="whitespace-nowrap text-success">청구 가능</span>'
        : '<span class="whitespace-nowrap text-muted">완료 시 청구</span>';
  const billLine = s.billing
    ? `<div class="mt-1 flex flex-wrap items-baseline gap-x-2.5 gap-y-0.5 break-keep text-xs tabular">
         ${s.billing.amount > 0 ? `<span class="whitespace-nowrap text-success">예상 청구액 ${formatKRW(s.billing.amount)}</span>` : `<span class="whitespace-nowrap text-muted">청구액 미정 <span class="text-muted/70">(청구 시 입력)</span></span>`}
         <span class="break-keep text-muted">${s.billing.allDay ? "종일" : `${Math.floor(s.billing.minutes / 60)}시간 ${s.billing.minutes % 60}분`} · ${esc(s.billing.item.name)}</span>
         ${billStatusChunk}
       </div>`
    : "";
  // 청구 결핍 사유: 완료된 녹음 세션이 단가항목/시간이 없어 산정 불가하면 침묵하지 않고 사유를 옅게 안내(미청구·미전환 한정).
  const billReason = !s.billing && RENTAL_SESSION_TYPES.includes(s.session_type) && s.status === "완료" && !s.invoiced && !s.billed_task_id
    ? (!s.rate_item_id ? "청구하려면 단가 항목을 선택하세요" : "청구하려면 시작·소요 시간을 입력하세요")
    : "";
  const reasonLine = billReason ? `<div class="mt-0.5 text-xs text-muted/70">${esc(billReason)}</div>` : "";
  const header = `
        <div class="min-w-0">
          <div class="flex flex-wrap items-center gap-2">
            ${typeBadge}
            <span class="font-medium tabular">${esc(formatYmdShort(s.session_date))}</span>
            <span class="text-sm text-muted tabular">${timeLabel(s)}${dday}</span>
          </div>
          <div class="mt-0.5 space-y-0.5 text-xs text-muted">${sub}</div>
          ${billLine}
          ${reasonLine}
        </div>`;
  // 비관리자: 단순 행(접기 없음).
  if (!isAdmin) {
    return `
      <div class="row-link rounded-lg border border-border bg-surface p-3">
        <div class="flex items-start justify-between gap-2">
          ${header}
          <div class="flex shrink-0 items-center gap-1">${statusBadge}</div>
        </div>
      </div>`;
  }
  // 편집 가능: 행 헤더 전체가 접기 토글. 오른쪽 끝 접기 버튼(chevron), 그 앞에 완료 토글.
  // '완료' 버튼 = 토글: 예정일 때 누르면 완료(활성), 완료일 때 다시 누르면 예정으로 되돌림(비활성). 상태 배지 대신 버튼 상태가 완료 여부를 표시.
  // (summary 안 button은 자기 활성화만 일어나 details 토글을 유발하지 않으며, POST→리다이렉트라 전이 상태도 무관.)
  const isDone = s.status === "완료";
  const completeToggle = s.status === "예정" || s.status === "완료"
    ? `<form method="post" action="/sessions/${s.id}/status">
            <input type="hidden" name="status" value="${isDone ? "예정" : "완료"}" />
            <button class="btn-ghost btn-xs ${isDone ? "border-success/40 bg-success/10 text-success" : "text-success"}" type="submit" aria-pressed="${isDone}"><span aria-hidden="true" class="inline-block w-3.5 text-center ${isDone ? "" : "opacity-60"}">${isDone ? "✓" : "−"}</span>완료</button>
          </form>`
    : "";
  return `
    <details class="group overflow-hidden rounded-lg border border-border bg-surface">
      <summary class="row-link flex cursor-pointer list-none items-start justify-between gap-2 p-3">
        ${header}
        <span class="flex shrink-0 items-center gap-2">${completeToggle}${statusBadge}${detailsChevron()}</span>
      </summary>
      <div class="border-t border-border p-3">
        <form id="del-sess-${s.id}" method="post" action="/sessions/${s.id}/delete" data-confirm="이 세션을 삭제할까요?" class="hidden"></form>
        <form method="post" action="/sessions/${s.id}" data-session-form data-session-id="${s.id}" data-dirty-form>
          ${sessionBookingFields(s, managers, rateItems, rooms, "", pmName, optionsRef)}
          <div class="mt-3 border-t border-border/50"></div>
          ${dirtyActionRow({ deleteFormId: `del-sess-${s.id}`, deleteLabel: "삭제", saveLabel: "세션 저장" })}
        </form>
      </div>
    </details>`;
}

/**
 * 전역 일정 목록용 — 한 프로젝트의 세션들을 한 카드(판)에 묶는다(프로젝트 목록과 통일감, 2026-07-04 사용자 요청).
 * 헤더 = 프로젝트 제목 + 아티스트·회사 링크(프로젝트 목록 카드와 동일 톤), 본문 = 세션 행(showProject=false, 프로젝트는 헤더에).
 */
function sessionProjectCard(sessions, { isAdmin = false, managers = [], rateItems = [], rooms, optionsRef = "" } = {}) {
  const p = sessions[0] || {};
  const company = String(p.production_company || p.artist_company || "").trim();
  const artist = String(p.artist || "").trim();
  const meta = [artist, company].filter(Boolean).join(" · ");
  return `
    <div class="overflow-hidden rounded-xl border border-border/60 bg-surface">
      <div class="flex items-start justify-between gap-3 px-4 py-3">
        <div class="min-w-0">
          <div class="truncate font-semibold">${esc(p.project_title || "(제목 없음)")}</div>
          ${meta ? `<div class="mt-0.5 truncate text-sm text-fg/80">${esc(meta)}</div>` : ""}
        </div>
        <span class="shrink-0 pl-2 text-sm text-muted">세션 ${sessions.length}</span>
      </div>
      <div class="space-y-2 border-t border-border/40 p-3">
        ${sessions.map((s) => sessionRow(s, { isAdmin, managers, rateItems, rooms, showProject: false, optionsRef })).join("")}
      </div>
    </div>`;
}

/** 프로젝트 상세용 세션 섹션. 유형 구분 없이 항상 펼친 <section>으로 렌더(목록 + '새 세션 추가' 폼). */
function sessionsSection({ project, rows, isAdmin, managers = [], rateItems = [], rooms, defaultBooker = "" }) {
  // PM(프로젝트 담당 엔지니어) — 세션 폼 우측 사이드에 읽기 전용 표기(구글 캘린더식 레이아웃, 수정은 프로젝트 탭에서).
  const pmName = (managers.find((m) => Number(m.id) === Number(project.manager_id)) || {}).name || "";
  const roomList = resolveRooms(rooms); // 룸 1회 조회 후 폼·행에 전달(호출부가 안 넘겨도 채워짐)
  const upcoming = rows.filter((s) => s.status !== "취소" && s.session_date >= todayYmd()).length;
  // 연락처·회사 옵션 JSON은 페이지당 1회(공유 스크립트) — 세션 폼(행 편집+추가)마다 전체 임베드가 페이지를 불리던 것(2026-07-09~10 스케일 점검).
  const optionsRef = isAdmin ? "pc-shared-contacts" : "";
  const sharedOpts = isAdmin ? personComboOptionsScript(optionsRef, contactOptions()) + personComboCompanyScript("pc-company-shared", partyOptions({ role: "company" })) : "";
  const list = rows.length
    ? rows.map((s) => sessionRow(s, { isAdmin, managers, rateItems, rooms: roomList, projectTitle: project.title, pmName, optionsRef })).join("")
    : emptyState("등록된 세션이 없습니다.");
  const badge = rows.length ? `<span class="text-sm font-normal text-muted">${upcoming ? "예정 " + upcoming : rows.length}</span>` : "";
  return `
    <section class="card mt-3 space-y-3">
      ${sharedOpts}
      <div class="flex items-center justify-between gap-3">
        <h2 class="font-display text-base font-semibold">세션 일정 ${badge}</h2>
      </div>
      <div class="space-y-2">${list}</div>
      ${isAdmin
        ? rows.length
          ? `<details class="group border-t border-border pt-3">
               <summary class="flex cursor-pointer list-none items-center gap-1.5 text-sm font-medium text-muted hover:text-fg">${detailsChevron()} 새 세션 추가</summary>
               <div class="mt-2">${sessionCreateForm(project, managers, rateItems, roomList, defaultBooker, pmName, optionsRef)}</div>
             </details>`
          : `<div class="border-t border-border pt-3"><div class="mb-2 text-sm font-medium text-muted">새 세션 추가</div>${sessionCreateForm(project, managers, rateItems, roomList, defaultBooker, pmName, optionsRef)}</div>`
        : ""}
    </section>`;
}

/** 캘린더 칩 색 — 목록 상태 배지와 같은 기조(예정=info, 완료=success, 취소=muted). */
function calendarChipColor(status) {
  if (status === "예정") return "bg-info/10 text-info";
  return SESSION_STATUS_BADGE[status] || "bg-muted/10 text-muted";
}

/** 월 캘린더 그리드(YYYY-MM). 날짜별 세션을 셀에 배치하고 이전/다음 월로 이동. */
function monthCalendar(ym, sessions) {
  const [y, mo] = String(ym).split("-").map(Number);
  const pad2 = (n) => String(n).padStart(2, "0");
  const startDow = new Date(y, mo - 1, 1).getDay(); // 0=일
  const daysInMonth = new Date(y, mo, 0).getDate();
  const prevYm = mo === 1 ? `${y - 1}-12` : `${y}-${pad2(mo - 1)}`;
  const nextYm = mo === 12 ? `${y + 1}-01` : `${y}-${pad2(mo + 1)}`;
  const today = todayYmd();
  const byDate = {};
  for (const s of sessions) (byDate[s.session_date] = byDate[s.session_date] || []).push(s);
  const dows = ["일", "월", "화", "수", "목", "금", "토"];

  // 셀 경계는 개별 라운드 테두리·간격 대신 그리드 라인(border-b/border-r)으로 통합 — 카드·꾸밈 없이 화면 폭을 꽉 채운다(사용자 요청).
  let cells = "";
  const CELL = "min-h-[104px] min-w-0 border-b border-r border-border/50 p-1";
  for (let i = 0; i < startDow; i++) cells += `<div class="${CELL} bg-bg/30"></div>`;
  for (let d = 1; d <= daysInMonth; d++) {
    const date = `${y}-${pad2(mo)}-${pad2(d)}`;
    const ds = byDate[date] || [];
    const isToday = date === today;
    const items = ds
      .map((s) => {
        // 칩 라벨 = 아티스트/회사/프로젝트(누구·무엇인지 식별). 시간은 데스크톱에서만(모바일은 좁아 내용이 가려짐 — 사용자 요청).
        const label = esc(String(s.artist || s.production_company || s.artist_company || s.project_title || s.session_type).trim());
        const t = s.start_time ? esc(s.start_time) : "";
        // data-session-card: app.js가 클릭 가로채 GET .../card 조각을 중앙 모달로(서베이 흐름 유지). 무JS 폴백=프로젝트 세션 탭 링크.
        return `<a href="/projects/${s.project_id}?tab=sessions" data-session-card="/sessions/${s.id}/card" class="block truncate rounded ${calendarChipColor(s.status)} px-1.5 py-0.5 text-[11px] font-medium leading-snug hover:opacity-80 sm:text-xs" title="${esc(s.session_type)} · ${esc(s.project_title || "")}${t ? " · " + t : ""}">${t ? `<span class="hidden font-normal opacity-70 sm:inline">${t} </span>` : ""}${label}</a>`;
      })
      .join("");
    cells += `<div class="${CELL} ${isToday ? "bg-primary/5" : ""}">
      <div class="mb-0.5 text-xs ${isToday ? "font-semibold text-primary" : "text-muted"}">${d}</div>
      <div class="space-y-0.5">${items}</div>
    </div>`;
  }
  // 요일 헤더도 같은 그리드 라인. 컨테이너는 상·좌 테두리(border-t/border-l)로 격자 마감. -mx로 콘텐츠 패딩을 상쇄해 화면 끝까지.
  const dowRow = dows
    .map((d, i) => `<div class="border-b border-r border-border/50 py-1 text-center text-xs font-medium ${i === 0 ? "text-danger" : i === 6 ? "text-primary" : "text-muted"}">${d}</div>`)
    .join("");
  return `
    <div class="mb-3 flex items-center justify-between">
      <a href="/sessions?view=calendar&month=${prevYm}" class="btn-ghost btn-sm">‹ 이전</a>
      <h2 class="font-display text-lg font-semibold">${y}년 ${mo}월</h2>
      <a href="/sessions?view=calendar&month=${nextYm}" class="btn-ghost btn-sm">다음 ›</a>
    </div>
    <div class="-mx-4 border-t border-border/50 sm:-mx-6">
      <div class="grid grid-cols-7 border-l border-border/50">
        ${dowRow}
        ${cells}
      </div>
    </div>`;
}

/**
 * 캘린더 세션 팝오버(중앙 모달) — 칩 클릭 시 app.js가 GET /sessions/:id/card로 불러와 표시(2026-07-11 사용자 요청).
 * 구글 캘린더식 상세: 아티스트·프로젝트 / 날짜·시간·종류 / 예약·엔지니어·디렉터 / 예상 청구액·소요 / 메모 + 완료 토글 + 프로젝트 링크.
 * 완료는 폼 POST → 캘린더로 복귀(return, 리로드). 서베이(캘린더)에서 안 떠나고 처리.
 */
function sessionCardModal(s, { canEdit = false } = {}) {
  const ret = `/sessions?view=calendar&month=${esc(String(s.session_date || "").slice(0, 7))}`;
  const directors = listSessionDirectors(s.id);
  const engineers = listSessionEngineers(s.id);
  const title = [String(s.artist || "").trim(), String(s.production_company || s.artist_company || "").trim()].filter(Boolean).join(" · ") || s.project_title || "세션";
  const lines = [];
  const bookerEng = [
    s.booker_name ? `예약 ${esc(s.booker_name)}` : "",
    engineers.length ? `엔지니어 ${engineers.map((e) => esc(e.name)).join(", ")}` : "",
  ].filter(Boolean).join(" · ");
  if (bookerEng) lines.push(bookerEng);
  if (directors.length) lines.push(`디렉터 ${directors.map((d) => esc(personLabel(d.name, d.activity_name))).join(", ")}`);
  if (s.memo) lines.push(esc(s.memo));
  const bill = s.billing
    ? `${s.billing.amount > 0 ? `예상 청구액 ${formatKRW(s.billing.amount)}` : "청구액 미정"} · ${s.billing.allDay ? "종일" : `${Math.floor(s.billing.minutes / 60)}시간 ${s.billing.minutes % 60}분`} · ${esc(s.billing.item.name)}`
    : "";
  const isDone = s.status === "완료";
  const canToggle = canEdit && (s.status === "예정" || s.status === "완료");
  const statusBadge = s.status !== "예정" && s.status !== "완료"
    ? `<span class="badge ${SESSION_STATUS_BADGE[s.status] || "bg-muted/10 text-muted"}">${esc(s.status)}</span>` : "";
  const completeForm = canToggle
    ? `<form method="post" action="/sessions/${s.id}/status">
         <input type="hidden" name="status" value="${isDone ? "예정" : "완료"}" />
         <input type="hidden" name="return" value="${ret}" />
         <button class="btn-ghost btn-sm ${isDone ? "border-success/40 bg-success/10 text-success" : "text-success"}" type="submit" aria-pressed="${isDone}"><span aria-hidden="true" class="inline-block w-3.5 text-center ${isDone ? "" : "opacity-60"}">${isDone ? "✓" : "−"}</span>완료</button>
       </form>`
    : "";
  // 모달 위치 = 전체 화면 가운데가 아니라 콘텐츠(캘린더) 영역 가운데(2026-07-11 사용자 요청):
  // 데스크톱은 사이드바(sm:w-56=14rem) 폭만큼 왼쪽을 비워(sm:left-64) 캘린더 열 안에서 중앙 정렬. 모바일(드로어)은 left-0 전폭.
  return `
    <div data-modal data-session-modal class="fixed inset-y-0 right-0 left-0 z-50 flex items-center justify-center bg-black/50 p-4 sm:left-64">
      <div class="card w-full max-w-md">
        <div class="flex items-start justify-between gap-2">
          <div class="min-w-0">
            <div class="flex flex-wrap items-center gap-2">
              <span class="badge bg-bg text-muted">${esc(s.session_type)}</span>${statusBadge}
            </div>
            <div class="mt-1 truncate font-display text-base font-semibold">${esc(title)}</div>
            <div class="mt-0.5 text-sm text-muted tabular">${esc(formatYmdShort(s.session_date))} · ${timeLabel(s)}</div>
          </div>
          <button type="button" class="btn-ghost btn-xs shrink-0" data-modal-close aria-label="닫기">✕</button>
        </div>
        ${lines.length ? `<div class="mt-2 space-y-0.5 text-sm text-muted">${lines.map((l) => `<div>${l}</div>`).join("")}</div>` : ""}
        ${bill ? `<div class="mt-2 text-sm tabular ${s.billing.amount > 0 ? "text-success" : "text-muted"}">${bill}</div>` : ""}
        <div class="mt-3 flex items-center justify-between gap-2 border-t border-border pt-3">
          <a href="/projects/${s.project_id}?tab=sessions" class="btn-ghost btn-sm">프로젝트로 ↗</a>
          ${completeForm || "<span></span>"}
        </div>
      </div>
    </div>`;
}

module.exports = { sessionProjectCard, sessionsSection, monthCalendar, sessionBookingFields, sessionCardModal }; // sessionRow·sessionCreateForm은 내부 전용. sessionBookingFields는 UI 상호작용 테스트(test/ui-interactions)가 세션 폼을 단독 마운트하는 용도로만 노출.
