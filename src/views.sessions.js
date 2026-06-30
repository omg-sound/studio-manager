"use strict";

/** 세션(스튜디오 일정) 렌더 — 프로젝트 상세 섹션 + 전역 일정에서 공유. */

const { SESSION_TYPES, SESSION_STATUSES, SESSION_STATUS_BADGE, RECORDING_CATEGORIES } = require("./config");
const { esc, formatKRW, emptyState, detailsChevron } = require("./views");
const { formatYmdShort, ddayLabel, todayYmd, minutesBetween } = require("./lib/date");
const { listRooms, studioStartSlots } = require("./data");

/**
 * 룸 목록 보장 — 인자로 받으면 그대로, 아니면 활성 룸 조회(폴백).
 * projects.routes.js 등 rooms를 넘기지 않는 호출부에서도 룸 select가 채워지도록 한다(순환참조 없음: data는 views.sessions를 require하지 않음).
 */
function resolveRooms(rooms) {
  return Array.isArray(rooms) ? rooms : listRooms();
}

/** 룸 select. 현재값 선택. 룸이 1개뿐이고 현재값 없으면 그 룸 자동선택(단일룸 UX). 항상 '미지정' 옵션 제공. */
function roomSelect(rooms, currentId) {
  const cur = currentId == null || currentId === "" ? "" : String(currentId);
  const auto = rooms.length === 1 && cur === "" ? String(rooms[0].id) : cur;
  const opts = [`<option value="" ${auto === "" ? "selected" : ""}>룸 미지정</option>`];
  for (const r of rooms) {
    opts.push(`<option value="${r.id}" ${String(r.id) === auto ? "selected" : ""}>${esc(r.name)}</option>`);
  }
  return `<select class="input py-1.5 text-sm" name="room_id">${opts.join("")}</select>`;
}

/** 담당자 마스터 선택지. 현재값이 목록에 없으면 보존용으로 추가. 예약 담당자·담당 엔지니어 공용. */
function managerOptions(managers, current, placeholder = "담당자 미지정") {
  const names = managers.map((m) => m.name);
  const out = [`<option value="">${esc(placeholder)}</option>`];
  if (current && !names.includes(current)) {
    out.push(`<option value="${esc(current)}" selected>${esc(current)} (목록 외)</option>`);
  }
  for (const m of managers) {
    out.push(`<option value="${esc(m.name)}" ${m.name === current ? "selected" : ""}>${esc(m.name)}</option>`);
  }
  return out.join("");
}


function timeLabel(s) {
  if (s.start_time && s.end_time) return `${esc(s.start_time)}–${esc(s.end_time)}`;
  if (s.start_time) return esc(s.start_time);
  return "시간 미정";
}

/**
 * 시작 시간 30분 버튼 그리드(라디오, 기본 14:00~20:00). 비활성(예약됨) 표시는 app.js가 data-slot 기준 처리.
 * 그리드 밖 시간은 아래 '직접입력'(start_time_custom)으로 — 서버에서 직접입력이 있으면 우선한다.
 */
function startSlotGrid(current) {
  const slots = studioStartSlots(); // 환경설정 운영시간 기반 30분 슬롯(정적 SESSION_START_SLOTS 대체)
  const inGrid = slots.includes(current);
  const showCustom = !inGrid && !!current; // 편집 시 그리드 밖 값이면 직접입력 칸 펼침
  const cells = slots.map(
    (t) => `
      <label class="cursor-pointer">
        <input type="radio" name="start_time" value="${t}" class="peer sr-only" data-slot="${t}" ${t === current ? "checked" : ""} />
        <span class="flex min-h-[2.5rem] items-center justify-center rounded-md border border-border px-1 py-1.5 text-center text-sm peer-checked:border-primary peer-checked:bg-primary/10 peer-checked:text-primary peer-checked:font-semibold peer-checked:ring-1 peer-checked:ring-primary peer-disabled:cursor-not-allowed peer-disabled:border-border peer-disabled:bg-bg peer-disabled:text-muted/40 peer-disabled:line-through">${t}</span>
      </label>`
  ).join("");
  // 그리드 맨 뒤에 '직접입력' 버튼 — 클릭하면 아래 시간 입력칸을 펼친다(app.js).
  const customBtn = `<button type="button" class="flex min-h-[2.5rem] items-center justify-center rounded-md border border-border px-1 py-1.5 text-center text-sm hover:bg-elevated disabled:opacity-40 disabled:cursor-not-allowed" data-custom-start-toggle>직접입력</button>`;
  return `<div class="grid grid-cols-4 gap-1.5 sm:grid-cols-6" data-start-grid>${cells}${customBtn}</div>
    <div class="mt-1.5 flex items-center gap-1.5" data-custom-start-wrap ${showCustom ? "" : "hidden"}>
      <span class="text-xs text-muted">직접입력</span>
      <input class="input w-24 py-1.5 text-sm" type="text" inputmode="numeric" name="start_time_custom" data-custom-start
        placeholder="예: 14:25" pattern="([01]?[0-9]|2[0-3]):[0-5][0-9]" autocomplete="off" maxlength="5"
        value="${showCustom ? esc(current) : ""}" />
      <span class="text-xs text-muted">(시:분)</span>
    </div>`;
}

/** 소요시간 버튼([1Pro][2Pro][직접입력]) — 종료는 서버에서 시작+길이로 계산. */
// 소요 시간 = 슬라이더(30분 단위·0~12시간)가 주 입력. 아래 1Pro/2Pro 프리셋·직접입력(시간)은 슬라이더를 세팅한다.
// 전송값은 custom_hours + duration_mode=custom(hidden) → 서버 resolveEndTime이 그대로 산정(슬라이더 자체는 미전송 UI).
// minutesBetween은 ../lib/date 공용 유틸을 사용한다(중복 정의 제거).
function durationButtons(initMinutes = 0) {
  const m = Number(initMinutes) > 0 ? Math.round(Number(initMinutes)) : 0;
  const hours = m > 0 ? (m % 60 === 0 ? String(m / 60) : (m / 60).toFixed(1)) : "";
  const presetBtn = (val, label) =>
    `<button type="button" class="rounded-md border border-border px-3 py-1.5 text-sm hover:border-primary disabled:cursor-not-allowed disabled:text-muted/40" data-duration-preset="${val}">${label}</button>`;
  return `
    <div data-duration-group>
      <input type="range" min="0" max="720" step="30" value="${Math.min(m, 720)}" class="w-full cursor-pointer accent-primary" data-duration-slider aria-label="소요 시간" />
      <div class="mt-1 flex items-center justify-between text-xs">
        <span class="font-medium text-primary" data-duration-label>설정 안 함</span>
        <span class="text-muted">0 ~ 12시간 · 30분 단위</span>
      </div>
      <div class="mt-2 flex flex-wrap items-center gap-1.5">
        ${presetBtn("pro1", "1Pro")}${presetBtn("pro2", "2Pro")}
        <span class="ml-auto flex items-center gap-1.5">
          <input class="input w-20 py-1.5 text-sm" type="number" name="custom_hours" step="0.5" min="0" placeholder="직접" value="${hours}" data-custom-hours />
          <span class="text-xs text-muted">시간</span>
        </span>
      </div>
      <input type="hidden" name="duration_mode" value="custom" />
    </div>`;
}

/**
 * '녹음 종류' select — 단가표 항목(rate_items)을 분류(스튜디오/로케이션 녹음)로 묶는다. data-minutes로 1Pro 계산.
 * required=true면 data-rate-required(녹음 폼: 선택해야 시작 시간 입력 가능). 편집·믹스 폼은 false.
 */
function rateSelectGrouped(rateItems, currentId, required = false) {
  const groups = {};
  rateItems.forEach((r) => {
    const c = r.category || RECORDING_CATEGORIES[0];
    (groups[c] = groups[c] || []).push(r);
  });
  const cats = [...RECORDING_CATEGORIES.filter((c) => groups[c]), ...Object.keys(groups).filter((c) => !RECORDING_CATEGORIES.includes(c))];
  const opt = (r) => `<option value="${r.id}" data-minutes="${Number(r.base_minutes) || 0}" ${String(r.id) === String(currentId || "") ? "selected" : ""}>${esc(r.name)}</option>`;
  const body = cats.map((c) => `<optgroup label="${esc(c)}">${groups[c].map(opt).join("")}</optgroup>`).join("");
  return `<select class="input py-1.5 text-sm" name="rate_item_id" data-rate-select ${required ? "data-rate-required" : ""}>
      <option value="" data-minutes="0">녹음 단가 항목 미지정</option>
      ${body}
    </select>`;
}

/**
 * 예약(생성)용 폼 필드 — 시작 버튼 그리드 + 소요시간 버튼. 종료는 서버가 계산.
 * 녹음 프로젝트: '녹음 종류'(단가표 항목을 분류로 묶음) 한 필드 + session_type='녹음' 고정.
 * 그 외(믹스 등): '세션 종류'(session_type) + '녹음 종류'(단가표 항목) 두 필드. 라벨은 편집 폼과 통일.
 */
function sessionBookingFields(s, managers, rateItems = [], rooms) {
  const initMins = s && s.start_time && s.end_time ? minutesBetween(s.start_time, s.end_time) : 0;
  const roomList = resolveRooms(rooms);
  const engineerField = `<div><label class="label-sm">담당 엔지니어</label>
        <select class="input py-1.5 text-sm" name="engineer_name">${managerOptions(managers, s.engineer_name || "", "엔지니어 미지정")}</select></div>`;
  // 세션 종류(녹음/믹싱/마스터링/기타)는 항상 선택 가능. 녹음 단가 항목은 세션 종류=녹음일 때만 노출(app.js data-show-when="rec").
  // 룸 = 스튜디오 공간(같은 룸끼리만 시간 겹침 검사). 2x2 그리드로 세션종류/룸 · 녹음단가/엔지니어 배치.
  const typeRateRow = `<div class="mt-2 grid gap-2 sm:grid-cols-2">
         <div><label class="label-sm">세션 종류</label>
          <select class="input py-1.5 text-sm" name="session_type">${SESSION_TYPES.map((t) => `<option value="${esc(t)}" ${t === s.session_type ? "selected" : ""}>${esc(t)}</option>`).join("")}</select></div>
         <div><label class="label-sm">룸 <span class="font-normal text-muted">(같은 룸끼리만 겹침 검사)</span></label>
          ${roomSelect(roomList, s.room_id)}</div>
         <div data-show-when="rec"><label class="label-sm">녹음 단가 항목 <span class="font-normal text-muted">(시간제 단가)</span></label>
          ${rateSelectGrouped(rateItems, s.rate_item_id)}</div>
         ${engineerField}
       </div>
       <p class="mt-1 text-xs text-muted">청구하려면 <b>세션 종류=녹음</b> + <b>녹음 단가 항목</b> 선택이 모두 필요합니다. (완료 처리 후 청구 탭에 노출)</p>`;
  return `
    <div class="grid gap-2 sm:grid-cols-3">
      <div><label class="label-sm">날짜</label>
        <input class="input py-1.5 text-sm" type="date" name="session_date" value="${esc(s.session_date || todayYmd())}" data-session-date required /></div>
      <div><label class="label-sm">예약 담당자</label>
        <select class="input py-1.5 text-sm" name="booker_name">${managerOptions(managers, s.booker_name || "", "예약 담당자 미지정")}</select></div>
      <div><label class="label-sm">상태</label>
        <select class="input py-1.5 text-sm" name="status">${SESSION_STATUSES.map((st) => `<option value="${esc(st)}" ${st === (s.status || "예정") ? "selected" : ""}>${esc(st)}</option>`).join("")}</select></div>
    </div>
    ${typeRateRow}
    <div class="mt-3">
      <label class="label-sm">시작 시간 <span class="font-normal text-muted">(회색 = 이미 예약됨)</span></label>
      ${startSlotGrid(s.start_time || "")}
    </div>
    <div class="mt-3">
      <label class="label-sm">소요 시간 <span class="font-normal text-muted">(1Pro = 녹음 단가 항목 기준시간)</span></label>
      ${durationButtons(initMins)}
      <div class="mt-1.5 text-xs text-success" data-end-preview></div>
    </div>
    <input class="input mt-3 py-1.5 text-sm" name="memo" placeholder="메모(선택)" value="${esc(s.memo || "")}" />`;
}

/** 프로젝트 상세용 세션 추가 폼(버튼형 예약 UX). */
function sessionCreateForm(project, managers, rateItems = [], rooms) {
  return `
    <form method="post" action="/sessions" class="rounded-lg border border-border bg-bg p-3" data-session-form>
      <input type="hidden" name="project_id" value="${project.id}" />
      ${sessionBookingFields({}, managers, rateItems, rooms)}
      <button class="btn-primary mt-4 w-full py-2.5 text-base" type="submit">+ 세션 추가</button>
    </form>`;
}

/** 세션 한 행. showProject=true면 프로젝트명 링크 표시(전역 일정). tracks 전달 시 청구 작업 생성 폼 노출. */
function sessionRow(s, { isAdmin = false, managers = [], rateItems = [], rooms, showProject = false, projectTitle = "" } = {}) {
  const typeBadge = `<span class="badge bg-bg text-muted">${esc(s.session_type)}</span>`;
  // 상태 배지: 예정은 쿨톤 badge-info, 그 외(완료/취소)는 config 매핑 색.
  const statusBadge = s.status === "예정"
    ? `<span class="badge-info">${esc(s.status)}</span>`
    : `<span class="badge ${SESSION_STATUS_BADGE[s.status] || "bg-muted/10 text-muted"}">${esc(s.status)}</span>`;
  const dday = s.status !== "취소" && s.session_date >= todayYmd() ? ` · ${esc(ddayLabel(s.session_date))}` : "";
  const people = [
    s.booker_name ? `예약 ${esc(s.booker_name)}` : "",
    s.engineer_name ? `엔지니어 ${esc(s.engineer_name)}` : "",
  ].filter(Boolean).join(" · ") || "담당자 미정";
  const sub = [
    showProject && s.project_title ? `<a href="/projects/${s.project_id}" class="text-primary hover:underline">${esc(s.project_title)}</a>` : "",
    people,
    s.memo ? esc(s.memo) : "",
  ].filter(Boolean).join(" · ");
  // 녹음 세션은 청구 탭에서 직접 청구된다(곡·콘텐츠/버튼 없음). 여기선 예상액·청구상태만 표시.
  const billStatus = s.invoiced
    ? ' · <span class="text-muted">청구됨</span>'
    : s.billed_task_id
      ? ' · <span class="text-muted">작업 생성됨</span>'
      : s.status === "완료"
        ? ' · <span class="text-success">청구 가능</span>'
        : ' · <span class="text-muted">완료 시 청구</span>';
  const billLine = s.billing
    ? `<div class="mt-0.5 text-xs text-success tabular">예상 청구액 ${formatKRW(s.billing.amount)} <span class="text-muted">(${Math.floor(s.billing.minutes / 60)}시간 ${s.billing.minutes % 60}분 · ${esc(s.billing.item.name)})</span>${billStatus}</div>`
    : "";
  // 청구 결핍 사유: 완료된 녹음 세션이 단가항목/시간이 없어 산정 불가하면 침묵하지 않고 사유를 옅게 안내(미청구·미전환 한정).
  const billReason = !s.billing && s.session_type === "녹음" && s.status === "완료" && !s.invoiced && !s.billed_task_id
    ? (!s.rate_item_id ? "청구하려면 녹음 단가 항목을 선택하세요" : "청구하려면 시작·소요 시간을 입력하세요")
    : "";
  const reasonLine = billReason ? `<div class="mt-0.5 text-xs text-muted/70">${esc(billReason)}</div>` : "";
  const header = `
        <div class="min-w-0">
          <div class="flex flex-wrap items-center gap-2">
            ${typeBadge}
            <span class="font-medium tabular">${esc(formatYmdShort(s.session_date))}</span>
            <span class="text-xs text-muted tabular">${timeLabel(s)}${dday}</span>
          </div>
          <div class="mt-0.5 text-xs text-muted">${sub}</div>
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
  // 편집 가능: 행 헤더 전체가 접기 토글. 오른쪽 끝 접기 버튼(chevron), 그 앞에 상태 배지.
  // 예정 세션은 펼치지 않고 1클릭 '완료' 토글(POST /sessions/:id/status)을 상태 배지 옆에 노출.
  // (summary 안 button은 자기 활성화만 일어나 details 토글을 유발하지 않으며, POST→리다이렉트라 전이 상태도 무관.)
  const toggleTo = s.status === "완료" ? "예정" : "완료";
  const quickComplete = s.status === "예정"
    ? `<form method="post" action="/sessions/${s.id}/status">
            <input type="hidden" name="status" value="완료" />
            <button class="btn-ghost btn-xs text-success" type="submit">완료</button>
          </form>`
    : "";
  return `
    <details class="group overflow-hidden rounded-lg border border-border bg-surface">
      <summary class="row-link flex cursor-pointer list-none items-start justify-between gap-2 p-3">
        ${header}
        <span class="flex shrink-0 items-center gap-2">${quickComplete}${statusBadge}${detailsChevron()}</span>
      </summary>
      <div class="border-t border-border p-3">
        <form method="post" action="/sessions/${s.id}" data-session-form data-session-id="${s.id}">
          ${sessionBookingFields(s, managers, rateItems, rooms)}
          <button class="btn-primary mt-4 w-full py-2.5 text-base" type="submit">세션 저장</button>
        </form>
        <div class="mt-2 flex gap-2">
          <form method="post" action="/sessions/${s.id}/status">
            <input type="hidden" name="status" value="${toggleTo}" />
            <button class="btn-ghost btn-xs" type="submit">${toggleTo} 처리</button>
          </form>
          <form method="post" action="/sessions/${s.id}/delete" data-confirm="이 세션을 삭제할까요?">
            <button class="btn-ghost btn-xs text-danger" type="submit">삭제</button>
          </form>
        </div>
      </div>
    </details>`;
}

/** 프로젝트 상세용 세션 섹션. 유형 구분 없이 항상 펼친 <section>으로 렌더(목록 + '새 세션 추가' 폼). */
function sessionsSection({ project, rows, isAdmin, managers = [], rateItems = [], rooms }) {
  const roomList = resolveRooms(rooms); // 룸 1회 조회 후 폼·행에 전달(호출부가 안 넘겨도 채워짐)
  const upcoming = rows.filter((s) => s.status !== "취소" && s.session_date >= todayYmd()).length;
  const list = rows.length
    ? rows.map((s) => sessionRow(s, { isAdmin, managers, rateItems, rooms: roomList, projectTitle: project.title })).join("")
    : emptyState("등록된 세션이 없습니다.");
  const badge = rows.length ? `<span class="text-sm font-normal text-muted">${upcoming ? "예정 " + upcoming : rows.length}</span>` : "";
  return `
    <section class="card mt-3 space-y-3">
      <div class="flex items-center justify-between gap-3">
        <h2 class="font-display text-base font-semibold">세션 일정 ${badge}</h2>
      </div>
      <div class="space-y-2">${list}</div>
      ${isAdmin ? `<div class="border-t border-border pt-3"><div class="mb-2 text-sm font-medium text-muted">새 세션 추가</div>${sessionCreateForm(project, managers, rateItems, roomList)}</div>` : ""}
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

  let cells = "";
  for (let i = 0; i < startDow; i++) cells += `<div class="min-h-[88px] rounded-md border border-border/40 bg-bg/40"></div>`;
  for (let d = 1; d <= daysInMonth; d++) {
    const date = `${y}-${pad2(mo)}-${pad2(d)}`;
    const ds = byDate[date] || [];
    const isToday = date === today;
    const items = ds
      .map((s) => {
        const t = s.start_time ? esc(s.start_time) + " " : "";
        return `<a href="/projects/${s.project_id}?tab=sessions" class="block truncate rounded ${calendarChipColor(s.status)} px-1 py-0.5 text-[11px] hover:opacity-80" title="${esc(s.session_type)} · ${esc(s.project_title || "")}">${t}${esc(s.session_type)}</a>`;
      })
      .join("");
    cells += `<div class="min-h-[88px] rounded-md border ${isToday ? "border-primary" : "border-border/40"} p-1">
      <div class="mb-0.5 text-xs ${isToday ? "font-semibold text-primary" : "text-muted"}">${d}</div>
      <div class="space-y-0.5">${items}</div>
    </div>`;
  }
  return `
    <div class="mb-3 flex items-center justify-between">
      <a href="/sessions?view=calendar&month=${prevYm}" class="btn-ghost btn-sm">‹ 이전</a>
      <h2 class="font-display text-lg font-semibold">${y}년 ${mo}월</h2>
      <a href="/sessions?view=calendar&month=${nextYm}" class="btn-ghost btn-sm">다음 ›</a>
    </div>
    <div class="grid grid-cols-7 gap-1">
      ${dows.map((d, i) => `<div class="pb-1 text-center text-xs font-medium ${i === 0 ? "text-danger" : i === 6 ? "text-primary" : "text-muted"}">${d}</div>`).join("")}
      ${cells}
    </div>`;
}

module.exports = { sessionRow, sessionsSection, sessionCreateForm, monthCalendar };
