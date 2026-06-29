"use strict";

/** 세션(스튜디오 일정) 렌더 — 프로젝트 상세 섹션 + 전역 일정에서 공유. */

const { SESSION_TYPES, SESSION_STATUSES, SESSION_STATUS_BADGE, SESSION_TIME_SLOTS, SESSION_START_SLOTS, SESSION_CUSTOM_SLOTS, RECORDING_CATEGORIES } = require("./config");
const { esc, formatKRW, emptyState } = require("./views");
const { formatYmdShort, ddayLabel, todayYmd } = require("./lib/date");

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

/** 시작/종료 시간 select 옵션(편집 폼용). 목록 밖 기존값(레거시·야간)은 보존용으로 추가. */
function timeOptions(current) {
  const cur = current || "";
  const out = [`<option value="">선택</option>`];
  if (cur && !SESSION_TIME_SLOTS.includes(cur)) {
    out.push(`<option value="${esc(cur)}" selected>${esc(cur)}</option>`);
  }
  for (const t of SESSION_TIME_SLOTS) {
    out.push(`<option value="${t}" ${t === cur ? "selected" : ""}>${t}</option>`);
  }
  return out.join("");
}

/**
 * 세션 폼 필드(생성/편집 공유). 순서 = 예약 시 정하는 값 먼저, 실제 진행 시간(시작·종료)은 뒤.
 * 날짜·상태 → 예약 담당자·담당 엔지니어 → 녹음 종류·단가 → 시작·종료 → 메모.
 */
function sessionFields(s, managers, rateItems = []) {
  return `
    <div class="grid gap-2 sm:grid-cols-3">
      <div>
        <label class="label mb-0.5 text-xs">날짜</label>
        <input class="input py-1.5 text-sm" type="date" name="session_date" value="${esc(s.session_date || todayYmd())}" required />
      </div>
      <div>
        <label class="label mb-0.5 text-xs">예약 담당자</label>
        <select class="input py-1.5 text-sm" name="booker_name">${managerOptions(managers, s.booker_name || "", "예약 담당자 미지정")}</select>
      </div>
      <div>
        <label class="label mb-0.5 text-xs">상태</label>
        <select class="input py-1.5 text-sm" name="status">
          ${SESSION_STATUSES.map((st) => `<option value="${esc(st)}" ${st === (s.status || "예정") ? "selected" : ""}>${esc(st)}</option>`).join("")}
        </select>
      </div>
    </div>
    <div class="mt-2 grid gap-2 sm:grid-cols-2">
      <div>
        <label class="label mb-0.5 text-xs">녹음 종류 <span class="font-normal text-muted">(녹음 시간제 단가)</span></label>
        ${rateSelectGrouped(rateItems, s.rate_item_id)}
      </div>
      <div>
        <label class="label mb-0.5 text-xs">담당 엔지니어</label>
        <select class="input py-1.5 text-sm" name="engineer_name">${managerOptions(managers, s.engineer_name || "", "엔지니어 미지정")}</select>
      </div>
    </div>
    <div class="mt-2 grid gap-2 sm:grid-cols-3">
      <div>
        <label class="label mb-0.5 text-xs">세션 종류</label>
        <select class="input py-1.5 text-sm" name="session_type">
          ${SESSION_TYPES.map((t) => `<option value="${esc(t)}" ${t === s.session_type ? "selected" : ""}>${esc(t)}</option>`).join("")}
        </select>
      </div>
      <div>
        <label class="label mb-0.5 text-xs">시작</label>
        <select class="input py-1.5 text-sm" name="start_time">${timeOptions(s.start_time)}</select>
      </div>
      <div>
        <label class="label mb-0.5 text-xs">종료</label>
        <select class="input py-1.5 text-sm" name="end_time">${timeOptions(s.end_time)}</select>
      </div>
    </div>
    <input class="input mt-2 py-1.5 text-sm" name="memo" placeholder="메모(선택)" value="${esc(s.memo || "")}" />`;
}

/**
 * 시작 시간 30분 버튼 그리드(라디오, 기본 14:00~20:00). 비활성(예약됨) 표시는 app.js가 data-slot 기준 처리.
 * 그리드 밖 시간은 아래 '직접입력'(start_time_custom)으로 — 서버에서 직접입력이 있으면 우선한다.
 */
function startSlotGrid(current) {
  const inGrid = SESSION_START_SLOTS.includes(current);
  const showCustom = !inGrid && !!current; // 편집 시 그리드 밖 값이면 직접입력 칸 펼침
  const cells = SESSION_START_SLOTS.map(
    (t) => `
      <label class="cursor-pointer">
        <input type="radio" name="start_time" value="${t}" class="peer sr-only" data-slot="${t}" ${t === current ? "checked" : ""} />
        <span class="block rounded-md border border-border px-1 py-1.5 text-center text-sm peer-checked:border-primary peer-checked:text-primary peer-checked:font-semibold peer-checked:ring-1 peer-checked:ring-primary peer-disabled:cursor-not-allowed peer-disabled:border-border peer-disabled:bg-bg peer-disabled:text-muted/40 peer-disabled:line-through">${t}</span>
      </label>`
  ).join("");
  // 그리드 맨 뒤에 '직접입력' 버튼 — 클릭하면 아래 시간 입력칸을 펼친다(app.js).
  const customBtn = `<button type="button" class="rounded-md border border-border px-1 py-1.5 text-center text-sm hover:bg-elevated disabled:opacity-40 disabled:cursor-not-allowed" data-custom-start-toggle>직접입력</button>`;
  return `<div class="grid grid-cols-4 gap-1.5 sm:grid-cols-6" data-start-grid>${cells}${customBtn}</div>
    <div class="mt-1.5 flex items-center gap-1.5" data-custom-start-wrap ${showCustom ? "" : "hidden"}>
      <span class="text-xs text-muted">직접입력</span>
      <select class="input w-32 py-1.5 text-sm" name="start_time_custom" data-custom-start>
        <option value="">시간 선택</option>
        ${SESSION_CUSTOM_SLOTS.map((t) => `<option value="${t}" ${showCustom && t === current ? "selected" : ""}>${t}</option>`).join("")}
      </select>
    </div>`;
}

/** 소요시간 버튼([1Pro][2Pro][직접입력]) — 종료는 서버에서 시작+길이로 계산. */
function durationButtons() {
  const opt = (val, label) => `
      <label class="cursor-pointer">
        <input type="radio" name="duration_mode" value="${val}" class="peer sr-only" data-duration="${val}" />
        <span class="block rounded-md border border-border px-3 py-1.5 text-center text-sm peer-checked:border-primary peer-checked:text-primary peer-checked:font-semibold peer-checked:ring-1 peer-checked:ring-primary peer-disabled:cursor-not-allowed peer-disabled:text-muted/40">${label}</span>
      </label>`;
  return `<div class="flex flex-wrap gap-1.5" data-duration-group>${opt("pro1", "1Pro")}${opt("pro2", "2Pro")}${opt("custom", "직접입력")}</div>`;
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
      <option value="" data-minutes="0">녹음 종류 미지정</option>
      ${body}
    </select>`;
}

/**
 * 예약(생성)용 폼 필드 — 시작 버튼 그리드 + 소요시간 버튼. 종료는 서버가 계산.
 * 녹음 프로젝트: '녹음 종류'(단가표 항목을 분류로 묶음) 한 필드 + session_type='녹음' 고정.
 * 그 외(믹스 등): '세션 종류'(session_type) + '녹음 종류'(단가표 항목) 두 필드. 라벨은 편집 폼과 통일.
 */
function sessionBookingFields(s, managers, rateItems = [], isRecording = false) {
  const engineerField = `<div><label class="label mb-0.5 text-xs">담당 엔지니어</label>
        <select class="input py-1.5 text-sm" name="engineer_name">${managerOptions(managers, s.engineer_name || "", "엔지니어 미지정")}</select></div>`;
  const typeRateRow = isRecording
    ? `<input type="hidden" name="session_type" value="녹음" />
       <div class="mt-2 grid gap-2 sm:grid-cols-2">
         <div><label class="label mb-0.5 text-xs">녹음 종류 <span class="font-normal text-muted">(관리 → 단가표에서 추가)</span></label>
          ${rateSelectGrouped(rateItems, s.rate_item_id, true)}</div>
         ${engineerField}
       </div>`
    : `<div class="mt-2 grid gap-2 sm:grid-cols-3">
         <div><label class="label mb-0.5 text-xs">세션 종류</label>
          <select class="input py-1.5 text-sm" name="session_type">${SESSION_TYPES.map((t) => `<option value="${esc(t)}" ${t === s.session_type ? "selected" : ""}>${esc(t)}</option>`).join("")}</select></div>
         <div><label class="label mb-0.5 text-xs">녹음 종류 <span class="font-normal text-muted">(녹음 시간제 단가)</span></label>
          ${rateSelectGrouped(rateItems, s.rate_item_id)}</div>
         ${engineerField}
       </div>`;
  return `
    <div class="grid gap-2 sm:grid-cols-3">
      <div><label class="label mb-0.5 text-xs">날짜</label>
        <input class="input py-1.5 text-sm" type="date" name="session_date" value="${esc(s.session_date || todayYmd())}" data-session-date required /></div>
      <div><label class="label mb-0.5 text-xs">예약 담당자</label>
        <select class="input py-1.5 text-sm" name="booker_name">${managerOptions(managers, s.booker_name || "", "예약 담당자 미지정")}</select></div>
      <div><label class="label mb-0.5 text-xs">상태</label>
        <select class="input py-1.5 text-sm" name="status">${SESSION_STATUSES.map((st) => `<option value="${esc(st)}" ${st === (s.status || "예정") ? "selected" : ""}>${esc(st)}</option>`).join("")}</select></div>
    </div>
    ${typeRateRow}
    <div class="mt-3">
      <label class="label mb-1 text-xs">시작 시간 <span class="font-normal text-muted">(회색 = 이미 예약됨)</span><span class="font-normal text-warning" data-start-hint></span></label>
      ${startSlotGrid(s.start_time || "")}
    </div>
    <div class="mt-3">
      <label class="label mb-1 text-xs">소요 시간 <span class="font-normal text-muted">(1Pro = 녹음 종류 기준시간)</span></label>
      ${durationButtons()}
      <div class="mt-1.5 flex items-center gap-1.5" data-custom-wrap hidden>
        <input class="input w-24 py-1.5 text-sm" type="number" name="custom_hours" step="0.5" min="0" placeholder="3.5" data-custom-hours />
        <span class="text-xs text-muted">시간</span>
      </div>
      <div class="mt-1.5 text-xs text-success" data-end-preview></div>
    </div>
    <input class="input mt-3 py-1.5 text-sm" name="memo" placeholder="메모(선택)" value="${esc(s.memo || "")}" />`;
}

/** 프로젝트 상세용 세션 추가 폼(버튼형 예약 UX). */
function sessionCreateForm(project, managers, rateItems = []) {
  return `
    <form method="post" action="/sessions" class="rounded-lg border border-border bg-bg p-3" data-session-form>
      <input type="hidden" name="project_id" value="${project.id}" />
      ${sessionBookingFields({}, managers, rateItems, project.project_type === "recording")}
      <button class="btn-primary mt-4 w-full py-2.5 text-base" type="submit">+ 세션 추가</button>
    </form>`;
}

/** 세션 한 행. showProject=true면 프로젝트명 링크 표시(전역 일정). tracks 전달 시 청구 작업 생성 폼 노출. */
function sessionRow(s, { isAdmin = false, managers = [], rateItems = [], showProject = false, tracks = null, projectTitle = "" } = {}) {
  const typeBadge = `<span class="badge bg-bg text-muted">${esc(s.session_type)}</span>`;
  const statusBadge = `<span class="badge ${SESSION_STATUS_BADGE[s.status] || "bg-muted/10 text-muted"}">${esc(s.status)}</span>`;
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
  const billLine = s.billing
    ? `<div class="mt-0.5 text-xs text-success">예상 청구액 ${formatKRW(s.billing.amount)} <span class="text-muted">(${Math.floor(s.billing.minutes / 60)}시간 ${s.billing.minutes % 60}분 · ${esc(s.billing.item.name)})</span>${s.billed_task_id ? ' · <span class="text-muted">작업 생성됨</span>' : ""}</div>`
    : "";
  const controls = isAdmin ? sessionControls(s, managers, rateItems) : "";
  const billForm = (isAdmin && Array.isArray(tracks) && s.billing && s.status !== "취소" && !s.billed_task_id)
    ? `<form method="post" action="/sessions/${s.id}/bill" class="mt-2 flex flex-wrap items-end gap-2 border-t border-border pt-2">
         <div>
           <label class="label mb-0.5 text-xs">곡·콘텐츠</label>
           <select class="input py-1.5 text-sm" name="track_id">
             ${tracks.map((t) => `<option value="${t.id}">${esc(t.title)}</option>`).join("")}
             <option value="">(새로 만들기)</option>
           </select>
         </div>
         <input class="input py-1.5 text-sm" name="new_track_title" placeholder="새 곡·콘텐츠명(선택)" />
         <button class="btn-primary btn-sm" type="submit">이 세션으로 청구 작업 생성 (${formatKRW(s.billing.amount)})</button>
       </form>`
    : "";
  return `
    <div class="rounded-lg border border-border bg-surface p-3">
      <div class="flex flex-wrap items-center justify-between gap-2">
        <div class="min-w-0">
          <div class="flex flex-wrap items-center gap-2">
            ${typeBadge}
            <span class="font-medium">${esc(formatYmdShort(s.session_date))}</span>
            <span class="text-xs text-muted">${timeLabel(s)}${dday}</span>
          </div>
          <div class="mt-0.5 text-xs text-muted">${sub}</div>
          ${billLine}
        </div>
        <div class="flex shrink-0 items-center gap-1">${statusBadge}</div>
      </div>
      ${controls}
      ${billForm}
    </div>`;
}

function sessionControls(s, managers, rateItems = []) {
  const toggleTo = s.status === "완료" ? "예정" : "완료";
  return `
    <details class="mt-2 border-t border-border pt-2">
      <summary class="cursor-pointer list-none text-xs text-muted hover:text-fg">편집 / 완료 / 삭제</summary>
      <form method="post" action="/sessions/${s.id}" class="mt-2">
        ${sessionFields(s, managers, rateItems)}
        <button class="btn-primary mt-2 btn-xs" type="submit">세션 저장</button>
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
    </details>`;
}

/** 프로젝트 상세용 세션 섹션. expand=true(탭 안)면 믹스도 접지 않고 펼쳐 렌더. */
function sessionsSection({ project, rows, isAdmin, managers = [], rateItems = [], tracks = [], expand = false }) {
  const upcoming = rows.filter((s) => s.status !== "취소" && s.session_date >= todayYmd()).length;
  const list = rows.length
    ? rows.map((s) => sessionRow(s, { isAdmin, managers, rateItems, tracks, projectTitle: project.title })).join("")
    : emptyState("등록된 세션이 없습니다.");
  const badge = rows.length ? `<span class="text-sm font-normal text-muted">${upcoming ? "예정 " + upcoming : rows.length}</span>` : "";
  const isMixing = project && project.project_type === "mixing";
  if (isMixing && !expand) {
    return `
    <details class="card mt-3">
      <summary class="flex cursor-pointer list-none items-center justify-between gap-3">
        <h2 class="font-display text-base font-semibold">세션 일정 ${badge}</h2>
      </summary>
      <div class="mt-3 space-y-3 border-t border-border pt-3">
        ${isAdmin ? sessionCreateForm(project, managers, rateItems) : ""}
        <div class="space-y-2">${list}</div>
      </div>
    </details>`;
  }
  return `
    <section class="card mt-3 space-y-3">
      <div class="flex items-center justify-between gap-3">
        <h2 class="font-display text-base font-semibold">세션 일정 ${badge}</h2>
      </div>
      ${isAdmin ? sessionCreateForm(project, managers, rateItems) : ""}
      <div class="space-y-2">${list}</div>
    </section>`;
}

module.exports = { sessionRow, sessionsSection, sessionCreateForm };
