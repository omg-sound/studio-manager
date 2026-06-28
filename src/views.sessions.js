"use strict";

/** 세션(스튜디오 일정) 렌더 — 프로젝트 상세 섹션 + 전역 일정에서 공유. */

const { SESSION_TYPES, SESSION_STATUSES, SESSION_STATUS_BADGE } = require("./config");
const { esc, formatKRW } = require("./views");
const { formatYmdShort, ddayLabel, todayYmd } = require("./lib/date");

/** 엔지니어(담당자) 선택지. 현재값이 목록에 없으면 보존용으로 추가. */
function engineerOptions(managers, current) {
  const names = managers.map((m) => m.name);
  const out = [`<option value="">담당자 미지정</option>`];
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

/** 세션 폼 필드(생성/편집 공유). */
function sessionFields(s, managers, rateItems = []) {
  return `
    <div class="grid gap-2 sm:grid-cols-2">
      <div>
        <label class="label mb-0.5 text-xs">날짜</label>
        <input class="input py-1.5 text-sm" type="date" name="session_date" value="${esc(s.session_date || todayYmd())}" required />
      </div>
      <div>
        <label class="label mb-0.5 text-xs">종류</label>
        <select class="input py-1.5 text-sm" name="session_type">
          ${SESSION_TYPES.map((t) => `<option value="${esc(t)}" ${t === s.session_type ? "selected" : ""}>${esc(t)}</option>`).join("")}
        </select>
      </div>
      <div>
        <label class="label mb-0.5 text-xs">엔지니어</label>
        <select class="input py-1.5 text-sm" name="engineer_name">${engineerOptions(managers, s.engineer_name || "")}</select>
      </div>
      <div>
        <label class="label mb-0.5 text-xs">상태</label>
        <select class="input py-1.5 text-sm" name="status">
          ${SESSION_STATUSES.map((st) => `<option value="${esc(st)}" ${st === (s.status || "예정") ? "selected" : ""}>${esc(st)}</option>`).join("")}
        </select>
      </div>
      <div>
        <label class="label mb-0.5 text-xs">단가 항목 (녹음 시간제)</label>
        <select class="input py-1.5 text-sm" name="rate_item_id">
          <option value="">단가 미지정</option>
          ${rateItems.map((r) => `<option value="${r.id}" ${String(r.id) === String(s.rate_item_id || "") ? "selected" : ""}>${esc(r.name)}</option>`).join("")}
        </select>
      </div>
      <div>
        <label class="label mb-0.5 text-xs">시작</label>
        <input class="input py-1.5 text-sm" type="time" name="start_time" value="${esc(s.start_time || "")}" />
      </div>
      <div>
        <label class="label mb-0.5 text-xs">종료</label>
        <input class="input py-1.5 text-sm" type="time" name="end_time" value="${esc(s.end_time || "")}" />
      </div>
    </div>
    <input class="input mt-2 py-1.5 text-sm" name="memo" placeholder="메모(선택)" value="${esc(s.memo || "")}" />`;
}

/** 프로젝트 상세용 세션 추가 폼. */
function sessionCreateForm(project, managers, rateItems = []) {
  return `
    <form method="post" action="/sessions" class="rounded-lg border border-border bg-bg p-3">
      <input type="hidden" name="project_id" value="${project.id}" />
      ${sessionFields({}, managers, rateItems)}
      <button class="btn-primary mt-2 px-3 py-1.5 text-sm" type="submit">세션 추가</button>
    </form>`;
}

/** 세션 한 행. showProject=true면 프로젝트명 링크 표시(전역 일정). tracks 전달 시 청구 작업 생성 폼 노출. */
function sessionRow(s, { isAdmin = false, managers = [], rateItems = [], showProject = false, tracks = null } = {}) {
  const typeBadge = `<span class="badge bg-bg text-muted">${esc(s.session_type)}</span>`;
  const statusBadge = `<span class="badge ${SESSION_STATUS_BADGE[s.status] || "bg-muted/10 text-muted"}">${esc(s.status)}</span>`;
  const dday = s.status !== "취소" && s.session_date >= todayYmd() ? ` · ${esc(ddayLabel(s.session_date))}` : "";
  const sub = [
    showProject && s.project_title ? `<a href="/projects/${s.project_id}" class="text-primary hover:underline">${esc(s.project_title)}</a>` : "",
    s.engineer_name ? esc(s.engineer_name) : "담당자 미정",
    s.memo ? esc(s.memo) : "",
  ].filter(Boolean).join(" · ");
  const billLine = s.billing
    ? `<div class="mt-0.5 text-xs text-success">예상 청구액 ${formatKRW(s.billing.amount)} <span class="text-muted">(${Math.floor(s.billing.minutes / 60)}시간 ${s.billing.minutes % 60}분 · ${esc(s.billing.item.name)})</span>${s.billed_task_id ? ' · <span class="text-muted">작업 생성됨</span>' : ""}</div>`
    : "";
  const controls = isAdmin ? sessionControls(s, managers, rateItems) : "";
  const billForm = (isAdmin && Array.isArray(tracks) && s.billing && s.status === "완료" && !s.billed_task_id)
    ? `<form method="post" action="/sessions/${s.id}/bill" class="mt-2 flex flex-wrap items-end gap-2 border-t border-border pt-2">
         <div>
           <label class="label mb-0.5 text-xs">곡·콘텐츠</label>
           <select class="input py-1.5 text-sm" name="track_id">
             ${tracks.map((t) => `<option value="${t.id}">${esc(t.title)}</option>`).join("")}
             <option value="">(새로 만들기)</option>
           </select>
         </div>
         <input class="input py-1.5 text-sm" name="new_track_title" placeholder="새 곡·콘텐츠명(선택)" />
         <button class="btn-primary px-3 py-1.5 text-sm" type="submit">이 세션으로 청구 작업 생성 (${formatKRW(s.billing.amount)})</button>
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
        <button class="btn-primary mt-2 px-3 py-1.5 text-xs" type="submit">세션 저장</button>
      </form>
      <div class="mt-2 flex gap-2">
        <form method="post" action="/sessions/${s.id}/status">
          <input type="hidden" name="status" value="${toggleTo}" />
          <button class="btn-ghost px-3 py-1.5 text-xs" type="submit">${toggleTo} 처리</button>
        </form>
        <form method="post" action="/sessions/${s.id}/delete" data-confirm="이 세션을 삭제할까요?">
          <button class="btn-ghost px-3 py-1.5 text-xs text-danger" type="submit">삭제</button>
        </form>
      </div>
    </details>`;
}

/** 프로젝트 상세용 세션 섹션. */
function sessionsSection({ project, rows, isAdmin, managers = [], rateItems = [], tracks = [] }) {
  const upcoming = rows.filter((s) => s.status !== "취소" && s.session_date >= todayYmd()).length;
  const list = rows.length
    ? rows.map((s) => sessionRow(s, { isAdmin, managers, rateItems, tracks })).join("")
    : `<p class="py-4 text-center text-sm text-muted">등록된 세션이 없습니다.</p>`;
  const badge = rows.length ? `<span class="text-sm font-normal text-muted">${upcoming ? "예정 " + upcoming : rows.length}</span>` : "";
  const isMixing = project && project.project_type === "mixing";
  if (isMixing) {
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
