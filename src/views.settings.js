"use strict";

/** 관리(/settings) 렌더 — 환경설정·콘텐츠·담당자·시스템 탭 섹션 + 행 렌더러. src/routes/settings.routes.js에서 분리(2026-07-09, views.sessions.js·views.invoices.js 컨벤션). */

const { db } = require("./db");
const { isChief } = require("./auth");
const { config, ROLES, ROLE_LABELS, BILLING_TYPES, BILLING_TYPE_LABELS, RECORDING_CATEGORIES } = require("./config");
const {
  listProjectManagers,
  listRooms,
  listRateItems,
  listRateCategories,
  listTaskTypes,
  getStudioInfo,
  getStudioLogo,
  getStudioHours,
  getProMinutes,
  getDefaultBooker,
} = require("./data");
const { esc, formatKRW, formatBytes, emptyState, detailsChevron, explain } = require("./views");
const drive = require("./drive");
const calendar = require("./calendar");
const alerts = require("./notify");
const { localFileCount, driveFileCount } = require("./lib/storage-migrate");
const fs = require("fs");
const path = require("path");
const { backupDir } = require("./lib/maintenance");
const { listAudit } = require("./lib/audit");
const { getState } = require("./db");

const RATE_KIND_LABELS = { recording: "녹음", filming: "촬영", performance: "공연" };

// 환경설정 그룹 카드 안의 섹션 블록(2026-07-09 사용자 요청 '스튜디오 운영·Google 연동이 자리를 너무 차지' —
// 섹션마다 .card 하나씩(p-5 × N)이던 것을 그룹당 카드 1개 + border-t 구분으로 압축, 제목도 text-lg→text-sm).
const SETTING_BLOCK = "space-y-3 border-t border-border pt-4 mt-4 first:mt-0 first:border-t-0 first:pt-0";

/** 단가 항목 카테고리 select 옵션 — kind(녹음/촬영/공연)별 optgroup, DB 분류 순서(2026-07-05 config 하드코딩에서 전환). current 선택 반영. */
function rateCategoryOptions(current = "") {
  const byKind = {};
  listRateCategories().forEach((c) => { (byKind[c.kind] = byKind[c.kind] || []).push(c); });
  return Object.keys(RATE_KIND_LABELS)
    .filter((k) => byKind[k] && byKind[k].length)
    .map((k) => `<optgroup label="${esc(RATE_KIND_LABELS[k])}">${byKind[k].map((c) => `<option value="${esc(c.name)}" ${c.name === current ? "selected" : ""}>${esc(c.name)}</option>`).join("")}</optgroup>`)
    .join("");
}

/** 부트스트랩 치프(ADMIN_EMAIL)는 강등/비활성 불가 — 잠금 방지. */
function isBootstrapChief(user) {
  return Boolean(config.adminEmail) && user && user.email === config.adminEmail;
}

function listUsers() {
  // 연계된 작업 담당자(project_managers)의 전화를 함께 — 하우스 엔지니어 정보 수정 폼에 표시
  return db().prepare(`SELECT u.*, pm.phone AS mgr_phone FROM users u
       LEFT JOIN project_managers pm ON pm.user_id = u.id
       ORDER BY u.active DESC, u.role, u.email`).all();
}

/** 담당자 탭: 하우스 엔지니어(로그인 계정) 관리. */
function peopleTab(currentUser) {
  const chief = isChief(currentUser); // 로그인 계정 관리(추가·역할변경·삭제)는 치프 전용 — 스태프는 열람만(권한 상승 방지)
  const users = listUsers();
  const userRows = users.length ? users.map((u) => userRow(u, currentUser, chief)).join("") : emptyState("등록된 사용자가 없습니다.");
  const addForm = chief
    ? `<form method="post" action="/settings/users" class="space-y-2">
          <div class="grid gap-2 sm:grid-cols-2">
            <input class="input" name="user_name" placeholder="이름 (작업 담당자 표시명)" autocomplete="off" />
            <input class="input" type="email" name="email" placeholder="Google 이메일" required />
          </div>
          <div class="flex gap-2">
            <select class="input" name="role">
              ${ROLES.map((r) => `<option value="${esc(r)}" ${r === "staff" ? "selected" : ""}>${esc(ROLE_LABELS[r] || r)}</option>`).join("")}
            </select>
            <button class="btn-primary shrink-0" type="submit">엔지니어 추가</button>
          </div>
        </form>`
    : `<p class="rounded-lg border border-border bg-bg px-3 py-2 text-xs text-muted">로그인 계정 추가·역할 변경·삭제는 <span class="text-fg">치프 엔지니어</span>만 할 수 있습니다(열람만 가능).</p>`;
  return `
      <section class="card space-y-4">
        <div>
          <h2 class="font-display text-lg font-semibold">하우스 엔지니어 <span class="text-sm font-normal text-muted">(로그인 계정)</span></h2>
          ${explain(`등록한 Google 계정만 로그인할 수 있고, <span class="text-fg">작업 담당자에 자동으로 포함</span>됩니다. 치프는 전체, 스태프는 프로젝트·작업·자료까지.`)}
        </div>
        ${addForm}
        <div class="space-y-2">${userRows}</div>
      </section>`;
      // (외주 작업자 안내 카드는 2026-07-09 제거 — /workers 일원화(07-01) 직후의 과도기 안내였고,
      //  사이드바에 외주 작업자 메뉴가 상시 노출돼 중복. 담당자 탭 = 로그인 계정 관리로 정체성 정리.)
}

/** 단가표 항목을 분류별로 묶어 접이식(<details>, 기본 접힘)으로 — 2026-07-05 사용자 요청. DB 분류 순서(kind→sort_order→이름) 따름. */
function ratesGroupedByCategory(rates) {
  if (!rates.length) return emptyState("등록된 단가 항목이 없습니다.");
  const order = listRateCategories().map((c) => c.name);
  const groups = {};
  rates.forEach((r) => { const c = r.category || order[0] || ""; (groups[c] = groups[c] || []).push(r); });
  const orderedCats = [...order.filter((c) => groups[c]), ...Object.keys(groups).filter((c) => !order.includes(c))];
  return orderedCats
    .map((c) => {
      const items = groups[c];
      const activeN = items.filter((r) => r.active).length;
      const countLabel = activeN !== items.length ? `${items.length}개 · 활성 ${activeN}` : `${items.length}개`;
      return `
        <details class="group rounded-lg border border-border">
          <summary class="flex cursor-pointer list-none items-center justify-between gap-2 px-3 py-2 text-sm font-medium hover:bg-elevated">
            <span>${esc(c)}</span>
            <span class="flex items-center gap-2 text-xs font-normal text-muted">${esc(countLabel)}${detailsChevron()}</span>
          </summary>
          <div class="space-y-2 border-t border-border p-3">${items.map((r) => rateItemRow(r)).join("")}</div>
        </details>`;
    })
    .join("");
}

/** 분류 관리 행 — 기본(내장) 분류는 표시만(수정·삭제 불가), 치프가 추가한 분류만 이름·kind 수정 + 삭제. */
function rateCategoryManageRow(c) {
  if (c.locked) {
    return `<div class="flex items-center justify-between gap-2 rounded-lg border border-border bg-bg px-3 py-2 text-sm">
      <span>${esc(c.name)} <span class="badge bg-bg text-muted">${esc(RATE_KIND_LABELS[c.kind] || c.kind)}</span></span>
      <span class="flex items-center gap-2"><span class="text-xs text-muted">기본 분류 · 수정·삭제 불가</span><span class="flex shrink-0 gap-1">
      <form method="post" action="/settings/rate-categories/${c.id}/move"><input type="hidden" name="dir" value="up" /><button class="btn-ghost btn-xs px-2" type="submit" aria-label="위로 이동">↑</button></form>
      <form method="post" action="/settings/rate-categories/${c.id}/move"><input type="hidden" name="dir" value="down" /><button class="btn-ghost btn-xs px-2" type="submit" aria-label="아래로 이동">↓</button></form>
    </span></span>
    </div>`;
  }
  const kindOpts = Object.entries(RATE_KIND_LABELS).map(([k, l]) => `<option value="${k}" ${k === c.kind ? "selected" : ""}>${esc(l)}</option>`).join("");
  return `<div class="flex flex-wrap items-center gap-2 rounded-lg border border-border bg-bg px-3 py-2">
    <form method="post" action="/settings/rate-categories/${c.id}" class="flex flex-1 flex-wrap items-center gap-2" data-dirty-form>
      <input class="input py-1 text-sm w-40" name="cat_name" value="${esc(c.name)}" autocomplete="off" required />
      <select class="input py-1 text-sm" name="kind">${kindOpts}</select>
      <button class="btn-primary btn-xs transition" type="submit" data-dirty-save>저장</button>
    </form>
    <form method="post" action="/settings/rate-categories/${c.id}/delete" data-confirm="'${esc(c.name)}' 분류를 삭제할까요? 이 분류를 쓰는 단가 항목이 있으면 삭제할 수 없습니다.">
      <button class="btn-ghost btn-xs text-danger" type="submit">삭제</button>
    </form>
    <span class="flex shrink-0 gap-1">
      <form method="post" action="/settings/rate-categories/${c.id}/move"><input type="hidden" name="dir" value="up" /><button class="btn-ghost btn-xs px-2" type="submit" aria-label="위로 이동">↑</button></form>
      <form method="post" action="/settings/rate-categories/${c.id}/move"><input type="hidden" name="dir" value="down" /><button class="btn-ghost btn-xs px-2" type="submit" aria-label="아래로 이동">↓</button></form>
    </span>
  </div>`;
}

/** 분류 관리 섹션(접이식, 기본 접힘) — 추가 폼 + 목록(기본 분류/커스텀 분류). */
function rateCategoriesSection() {
  const cats = listRateCategories();
  const kindOpts = Object.entries(RATE_KIND_LABELS).map(([k, l]) => `<option value="${k}">${esc(l)}</option>`).join("");
  return `
    <details class="group mt-3 border-t border-border pt-3">
      <summary class="flex cursor-pointer list-none items-center gap-1.5 text-sm font-medium text-muted hover:text-fg">${detailsChevron()} 분류 관리</summary>
      <div class="mt-2 space-y-2">
        ${explain(`분류는 <b>녹음·촬영·공연</b> 중 하나에 속해 세션 종류에 맞는 단가 항목을 거르는 기준이 됩니다. <b>기본 분류(스튜디오/로케이션 녹음·스튜디오 촬영·공연)는 수정·삭제할 수 없습니다.</b> 새로 추가한 분류만 이름·소속을 바꾸거나(사용 중인 단가 항목도 함께 갱신) 삭제할 수 있어요(삭제는 그 분류를 쓰는 단가 항목이 없을 때만).`)}
        <form method="post" action="/settings/rate-categories" class="flex flex-wrap items-center gap-2 rounded-lg border border-border bg-bg p-3">
          <input class="input py-1.5 text-sm flex-1" name="cat_name" placeholder="새 분류명 (예: 야외 촬영)" autocomplete="off" required />
          <select class="input py-1.5 text-sm" name="kind">${kindOpts}</select>
          <button class="btn-primary btn-sm shrink-0" type="submit">분류 추가</button>
        </form>
        <div class="space-y-2">${cats.map(rateCategoryManageRow).join("")}</div>
      </div>
    </details>`;
}

/** 콘텐츠 탭: 단가표·녹음 종류 + 작업 종류 카탈로그. */
function contentTab() {
  const rates = listRateItems({ includeInactive: true });
  const taskTypes = listTaskTypes({ includeInactive: true });
  const taskTypeRows = taskTypes.length ? taskTypes.map((t) => taskTypeRow(t)).join("") : emptyState("등록된 작업 종류가 없습니다.");
  return `
      <section class="card space-y-4">
        <div>
          <h2 class="font-display text-lg font-semibold">단가표 · 녹음/촬영 종류</h2>
          ${explain(`대관 세션(녹음·촬영)의 시간제 단가 항목을 분류(스튜디오/로케이션 녹음·촬영)별로 추가합니다. 세션 폼의 '단가 항목'에 세션 종류(녹음/촬영)에 맞춰 분류로 묶여 표시됩니다. 기준 시간(1Pro) 안은 기준가, 초과는 단위 시간당 추가 과금. <b>기준 시간을 비우면 정액(회당)</b> — 시간과 무관하게 1회 = 기준 가격이며, 가격까지 비우면 <b>금액 미정</b>(플레이백 세션처럼 회당 가격이 매번 다른 항목 — 청구 생성 시 금액을 입력해 확정).`)}
        </div>
        <form method="post" action="/settings/rate-items" class="space-y-2 rounded-lg border border-border bg-bg p-3">
          <div class="grid gap-2 sm:grid-cols-2">
            <div><label class="label mb-0.5 text-xs">단가 항목명</label><input class="input py-1.5 text-sm" name="rate_name" placeholder="예: 보컬 녹음 · 뮤직비디오 촬영" autocomplete="off" required /></div>
            <div><label class="label mb-0.5 text-xs">분류</label><select class="input py-1.5 text-sm" name="category">${rateCategoryOptions()}</select></div>
          </div>
          <div class="grid gap-2 sm:grid-cols-2">
            <div>
              <label class="label mb-0.5 text-xs">기준 시간(1Pro, 시간)</label>
              <input class="input py-1.5 text-sm" name="base_hours" inputmode="decimal" placeholder="예: 3.5" />
            </div>
            <div>
              <label class="label mb-0.5 text-xs">기준 가격(원)</label>
              <input class="input py-1.5 text-sm" name="base_price" inputmode="numeric" placeholder="예: 300000" />
            </div>
            <div>
              <label class="label mb-0.5 text-xs">초과 단위(시간)</label>
              <input class="input py-1.5 text-sm" name="extra_hours" inputmode="decimal" placeholder="예: 1" value="1" />
            </div>
            <div>
              <label class="label mb-0.5 text-xs">초과 단가(원)</label>
              <input class="input py-1.5 text-sm" name="extra_price" inputmode="numeric" placeholder="예: 100000" />
            </div>
          </div>
          <button class="btn-primary btn-sm" type="submit">단가 항목 추가</button>
        </form>
        <div class="space-y-2">${ratesGroupedByCategory(rates)}</div>
        ${rateCategoriesSection()}
      </section>

      <section class="card space-y-4">
        <div>
          <h2 class="font-display text-lg font-semibold">작업 종류 <span class="text-sm font-normal text-muted">(곡·콘텐츠 후반작업)</span></h2>
          ${explain(`곡·콘텐츠의 작업 종류(보컬튠·믹싱·마스터링 등)와 기본 단가·과금을 관리합니다. '빠른추가'를 켜면 곡·콘텐츠의 빠른 추가 버튼에 노출됩니다.`)}
        </div>
        <form method="post" action="/settings/task-types" class="space-y-2 rounded-lg border border-border bg-bg p-3">
          <input class="input py-1.5 text-sm w-full" name="label" placeholder="작업 종류명 (예: 보컬튠)" required />
          <div class="grid gap-2 sm:grid-cols-2">
            <select class="input py-1.5 text-sm" name="billing_type">
              ${BILLING_TYPES.map((b) => `<option value="${esc(b)}">${esc(BILLING_TYPE_LABELS[b] || b)}</option>`).join("")}
            </select>
            <input class="input py-1.5 text-sm" name="unit_price" inputmode="numeric" placeholder="기본 단가(원)" />
          </div>
          <label class="flex items-center gap-2 text-sm text-muted"><input type="checkbox" name="is_quick" value="1" /> 곡·콘텐츠 '빠른 추가' 버튼에 노출</label>
          <button class="btn-primary btn-sm" type="submit">작업 종류 추가</button>
        </form>
        <div class="space-y-2">${taskTypeRows}</div>
      </section>`;
}

/** 자료 저장(구글 Drive) 상태 + 로컬→Drive 이관. 최소 권한(drive.file)으로 앱 전용 폴더에만 저장. */
function driveStorageSection() {
  const linked = drive.isLinked();
  const studioAcct = config.studioDriveEmail; // 자료 저장 고정 계정
  const localN = localFileCount();
  let status;
  if (!config.googleConfigured) {
    status = `<p class="text-sm text-muted">Google OAuth가 설정되지 않았습니다.</p>`;
  } else if (linked) {
    const acct = drive.getDriveAccountEmail();
    const mismatch = acct && acct !== studioAcct;
    status = `<p class="text-sm"><span class="badge badge-success">연동됨</span> 첨부 서류·자료 전달 파일이 <span class="font-medium">Google Drive</span> 앱 전용 폴더에 저장됩니다.${acct ? ` <span class="text-muted">· 계정 <span class="font-medium text-fg">${esc(acct)}</span></span>` : ""}</p>
      ${mismatch
        ? `<p class="text-xs text-danger">⚠️ 현재 <span class="font-medium">${esc(acct)}</span>에 연결돼 있습니다. 자료 저장 계정은 <span class="font-medium">${esc(studioAcct)}</span>로 고정입니다 — 그 계정으로 로그인해 Drive를 다시 연결하세요.</p>`
        : `<p class="text-xs text-muted">자료 저장 계정은 <span class="text-fg">${esc(studioAcct)}</span> <span class="text-fg">한 곳</span>으로 고정입니다. 치프가 바뀌어도 이 계정 Drive에만 저장됩니다.</p>`}`;
  } else {
    status = `<p class="text-sm text-muted"><span class="badge badge-warning">미연동</span> 지금은 파일이 <span class="font-medium">서버 로컬 디스크</span>에 저장됩니다. <span class="font-medium text-fg">${esc(studioAcct)}</span> 계정으로 <a class="text-primary hover:underline" href="/auth/google">로그인</a>하면 Drive 저장이 켜집니다(자료 저장은 이 계정으로 고정).</p>`;
  }
  const driveN = linked ? driveFileCount() : 0;
  const migrate = linked && localN > 0
    ? `<form method="post" action="/settings/migrate-drive" data-confirm="로컬에 저장된 파일 ${localN}개를 Google Drive로 이관할까요? 업로드 성공 시 로컬 원본은 삭제됩니다."><button class="btn-primary btn-sm" type="submit">로컬 파일 ${localN}개 → Drive 이관</button></form>`
    : linked
      ? `<p class="text-xs text-muted">로컬에 남은 파일이 없습니다 · Drive 저장 ${driveN}개.</p>`
      : "";
  const check = linked
    ? `<div class="flex flex-wrap gap-2 border-t border-border pt-2"><a class="btn-ghost btn-sm" href="/settings/drive-check">Drive 연결 테스트 (폴더·업로드 확인) ↗</a><a class="btn-ghost btn-sm" href="/auth/google?drive=1">${esc(studioAcct)} 계정으로 다시 연결</a></div>`
    : `<div class="border-t border-border pt-2"><a class="btn-primary btn-sm" href="/auth/google?drive=1">${esc(studioAcct)} 계정으로 로그인해 Drive 연결</a></div>`;
  return `<div class="${SETTING_BLOCK}">
    <div>
      <h2 class="text-sm font-semibold">자료 저장 (구글 Drive)</h2>
      ${explain(`첨부 서류·자료 전달 파일의 실제 저장 위치. 최소 권한(<code>drive.file</code>)으로 앱이 만든 전용 폴더에만 접근합니다. 그 폴더를 원하는 위치로 옮기거나 공유해 쓰실 수 있습니다.`)}
    </div>
    ${status}${migrate}${check}
  </div>`;
}

/** 스튜디오 캘린더(구글) 선택 섹션 — 세션 겹침 검사 대상. */
async function studioCalendarSection() {
  const title = `<div>
      <h2 class="text-sm font-semibold">스튜디오 캘린더 (구글)</h2>
      ${explain(`<span class="text-fg font-medium">세션을 예약하면 이 캘린더에 일정이 자동 생성·수정·삭제됩니다.</span> <span class="text-warning font-medium">'사용 안 함'으로 두면 캘린더 자동 연동이 꺼집니다</span> — 구글 캘린더로 넘기려면 반드시 스튜디오 캘린더를 선택하세요. <span class="text-muted">스튜디오 전용 캘린더를 권장</span>합니다(개인 일정과 섞이지 않게).`)}
    </div>`;
  let inner;
  if (!config.googleConfigured) {
    inner = `<p class="text-sm text-muted">Google OAuth가 설정되지 않았습니다.</p>`;
  } else if (!drive.isLinked()) {
    inner = `<p class="text-sm text-muted">구글 계정 연동이 필요합니다. <a class="text-primary hover:underline" href="/auth/google">구글 계정 연동(캘린더 권한 포함)</a> 후 다시 시도하세요.</p>`;
  } else {
    const calendars = await calendar.listCalendars();
    const current = calendar.getStudioCalendarId();
    if (calendars.length === 0) {
      inner = `<p class="text-sm text-muted">캘린더 목록을 불러오지 못했습니다. 캘린더 읽기 권한이 없을 수 있습니다 — <a class="text-primary hover:underline" href="/auth/google">구글 계정 재연동</a>으로 권한을 다시 허용하세요.</p>`;
    } else {
      const statusBadge = current
        ? `<p class="mb-2 text-sm text-success">✓ 자동 연동 켜짐 — 새 세션이 이 캘린더에 자동 등록됩니다.</p>`
        : `<p class="mb-2 text-sm text-warning">⚠ 자동 연동 꺼짐 — 아래에서 스튜디오 캘린더를 선택해야 구글 캘린더로 넘어갑니다.</p>`;
      inner = `${statusBadge}<form method="post" action="/settings/studio-calendar" class="flex gap-2">
          <select class="input" name="calendar_id">
            <option value="" ${current ? "" : "selected"}>사용 안 함 (캘린더 자동 연동 끔)</option>
            ${calendars.map((c) => `<option value="${esc(c.id)}" ${c.id === current ? "selected" : ""}>${esc(c.summary)}${c.primary ? " · 기본" : ""}</option>`).join("")}
          </select>
          <button class="btn-primary shrink-0" type="submit">저장</button>
        </form>`;
      if (current) {
        // 이미 만들어진 캘린더 일정의 제목·설명을 현재 로직(예: 아티스트 먼저 표기)으로 다시 맞춘다 — 1회성 관리 액션.
        inner += `<form method="post" action="/settings/resync-calendar" class="mt-2 border-t border-border pt-3" data-confirm="예정된(취소 제외) 세션의 캘린더 일정을 지금 로직으로 전부 다시 씁니다. 계속할까요?">
            <button class="btn-ghost btn-sm" type="submit">기존 캘린더 일정 다시 동기화</button>
            <p class="mt-1 text-xs text-muted">제목·설명 표기 방식을 바꾼 뒤(예: 아티스트 표기 순서) 이미 등록된 일정에도 반영하고 싶을 때 누르세요.</p>
          </form>`;
      }
    }
  }
  const location = `
    <div class="border-t border-border pt-3">
      <label class="label mb-1 text-xs">기본 장소 <span class="font-normal text-muted">(예약 시 일정 장소로 자동 입력)</span></label>
      <form method="post" action="/settings/studio-location" class="flex gap-2">
        <input class="input py-1.5 text-sm" name="studio_location" value="${esc(calendar.getStudioLocation())}" placeholder="예: OMG 스튜디오 (서울 ...)" />
        <button class="btn-primary shrink-0 btn-sm" type="submit">저장</button>
      </form>
    </div>`;
  return `<div class="${SETTING_BLOCK}">${title}${inner}${location}</div>`;
}

/** 룸(스튜디오 공간) 관리 — 추가·삭제(단가표와 동일한 삭제-only 톤). 룸별 시간 겹침 검사의 기준. */
function roomsSection() {
  const rooms = listRooms({ includeInactive: true });
  const rows = rooms.length ? rooms.map((r) => roomRow(r)).join("") : emptyState("등록된 룸이 없습니다.");
  return `
    <div class="${SETTING_BLOCK}">
      <div>
        <h2 class="text-sm font-semibold">장소 (스튜디오 룸 · 외부)</h2>
        ${explain(`세션 예약 시 장소를 지정하면 <span class="text-fg">같은 장소끼리만 시간 겹침을 검사</span>합니다(다른 장소는 같은 시간 병렬 예약 허용). 장소를 삭제하면 그 장소로 잡힌 세션은 '장소 미지정'으로 바뀝니다. <span class="text-fg">외부 장소</span>로 표시하면 세션 폼에서 주소 입력칸이 나오고 캘린더 일정 장소로 쓰입니다.`)}
      </div>
      <form method="post" action="/settings/rooms" class="flex flex-wrap items-center gap-2">
        <input class="input py-1.5 text-sm" name="room_name" placeholder="장소 이름 (예: A룸 · 외부일정)" autocomplete="off" required />
        <label class="flex cursor-pointer items-center gap-1.5 text-sm"><input type="checkbox" name="is_external" value="1" class="h-4 w-4 rounded border-border text-primary" /> 외부 장소(주소 입력)</label>
        <button class="btn-primary shrink-0 btn-sm" type="submit">장소 추가</button>
      </form>
      <div class="space-y-2">${rows}</div>
    </div>`;
}

/** 룸 행(삭제-only). */
function roomRow(r) {
  return `
    <div class="rounded-lg border border-border bg-bg p-3">
      <div class="flex items-center justify-between gap-3">
        <div class="flex items-center gap-2"><span class="font-medium">${esc(r.name)}</span>${r.is_external ? `<span class="badge badge-info">외부</span>` : ""}</div>
        <form method="post" action="/settings/rooms/${r.id}/delete" data-confirm="'${esc(r.name)}' 장소를 삭제할까요? 이 장소로 예약된 세션은 '장소 미지정'으로 바뀝니다.">
          <button class="btn-ghost btn-xs text-danger" type="submit">삭제</button>
        </form>
      </div>
    </div>`;
}

/** 운영시간(예약 그리드 시간 범위) — admin_state 기반. setStudioHours로 저장. */
function studioHoursSection() {
  const { start, end } = getStudioHours();
  return `
    <div class="${SETTING_BLOCK}">
      <div>
        <h2 class="text-sm font-semibold">운영시간 <span class="text-xs font-normal text-muted">(예약 시작 그리드 범위)</span></h2>
        ${explain(`세션 예약 폼의 '시작 시간 그리드'에 표시되는 시간 범위입니다(30분 단위). 그리드 바깥 시각은 '직접입력'으로 예약할 수 있습니다.`)}
      </div>
      <form method="post" action="/settings/studio-hours" class="flex flex-wrap items-end gap-2">
        <div>
          <label class="label-sm">그리드 시작</label>
          <input class="input py-1.5 text-sm" name="hours_start" value="${esc(start)}" placeholder="14:00" pattern="([01][0-9]|2[0-3]):[0-5][0-9]" required />
        </div>
        <div>
          <label class="label-sm">그리드 종료</label>
          <input class="input py-1.5 text-sm" name="hours_end" value="${esc(end)}" placeholder="18:30" pattern="([01][0-9]|2[0-3]):[0-5][0-9]" required />
        </div>
        <button class="btn-primary btn-sm shrink-0" type="submit">저장</button>
      </form>
      <form method="post" action="/settings/pro-minutes" class="flex flex-wrap items-end gap-2 border-t border-border pt-4">
        <div>
          <label class="label-sm">기본 세션 시간 <span class="font-normal text-muted">(녹음 외 세션[믹싱·마스터링·기타]의 소요시간 슬라이더 기본값)</span></label>
          <input class="input w-28 py-1.5 text-sm" name="pro_hours" type="number" step="0.5" min="0.5" value="${esc(String(getProMinutes() / 60))}" placeholder="3.5" />
        </div>
        <span class="pb-2 text-sm text-muted">시간</span>
        <button class="btn-primary btn-sm shrink-0" type="submit">저장</button>
      </form>
    </div>`;
}

/** 기본 예약 담당자 — 세션 예약 폼에서 예약 담당자로 기본 선택될 담당자(이름). */
function defaultBookerSection() {
  const cur = getDefaultBooker() || "";
  const managers = listProjectManagers();
  return `
    <div class="${SETTING_BLOCK}">
      <div>
        <h2 class="text-sm font-semibold">기본 예약 담당자</h2>
        ${explain(`새 세션 예약 폼에서 '예약 담당자'로 기본 선택됩니다.`)}
      </div>
      <form method="post" action="/settings/default-booker" class="flex flex-wrap items-end gap-2">
        <select class="input py-1.5 text-sm" name="default_booker">
          <option value="">지정 안 함</option>
          ${managers.map((m) => `<option value="${esc(m.name)}" ${m.name === cur ? "selected" : ""}>${esc(m.name)}</option>`).join("")}
        </select>
        <button class="btn-primary btn-sm shrink-0" type="submit">저장</button>
      </form>
    </div>`;
}

/** 공급자(스튜디오) 세금정보 — 거래명세서 PDF의 '공급자'란. */
function studioInfoSection() {
  const s = getStudioInfo();
  const logo = getStudioLogo();
  const field = (name, label, ph = "") =>
    `<div><label class="label mb-0.5 text-xs">${esc(label)}</label><input class="input py-1.5 text-sm" name="${esc(name)}" value="${esc(s[name] || "")}" placeholder="${esc(ph)}" /></div>`;
  return `
    <div class="${SETTING_BLOCK}">
      <div>
        <h2 class="text-sm font-semibold">공급자(스튜디오) 세금정보</h2>
        ${explain(`발행된 청구의 <span class="text-fg">거래명세서 PDF</span> '공급자'란에 들어갑니다. (세금계산서가 아닌 참고용 문서)`)}
      </div>
      <form method="post" action="/settings/studio-info" class="space-y-2">
        <div class="grid gap-2 sm:grid-cols-2">
          ${field("studio_biz_name", "상호", "OMG 스튜디오")}
          ${field("studio_biz_no", "사업자등록번호", "000-00-00000")}
          ${field("studio_owner_name", "대표자")}
          ${field("studio_tel", "연락처")}
          ${field("studio_biz_type", "업태", "서비스")}
          ${field("studio_biz_item", "종목", "음반녹음")}
        </div>
        <div><label class="label mb-0.5 text-xs">사업장 주소</label><input class="input py-1.5 text-sm" name="studio_address" value="${esc(s.studio_address || "")}" /></div>
        <button class="btn-primary btn-sm" type="submit">공급자 정보 저장</button>
      </form>
      <div class="border-t border-border pt-4">
        <label class="label mb-1 text-xs">로고 <span class="font-normal text-muted">(거래명세서 PDF 우측 상단 · PNG/JPG, 최대 2MB)</span></label>
        ${logo
          ? `<div class="mb-2"><img src="${esc(logo)}" alt="로고" class="max-h-20 rounded border border-border bg-white p-2" /></div>`
          : `<p class="mb-2 text-xs text-muted">등록된 로고가 없습니다.</p>`}
        <div class="flex flex-wrap items-center gap-2">
          <form method="post" action="/settings/studio-logo" enctype="multipart/form-data" class="flex items-center gap-2">
            <input class="text-sm" type="file" name="logo" accept="image/png,image/jpeg" required />
            <button class="btn-primary btn-sm" type="submit">로고 업로드</button>
          </form>
          ${logo ? `<form method="post" action="/settings/studio-logo/delete" data-confirm="로고를 삭제할까요?"><button class="btn-ghost btn-xs text-danger" type="submit">로고 삭제</button></form>` : ""}
        </div>
      </div>
    </div>`;
}

/** 알림 채널(웹훅) — 연체·청구 발행·자료 공유 팀 알림. URL은 암호화 저장. */
function alertWebhookSection(chief = true) {
  const url = alerts.getConfiguredWebhook();
  const envNote = alerts.envWebhookActive()
    ? `<p class="mt-1 text-xs text-warning">환경변수 ALERT_WEBHOOK가 설정되어 우선 적용됩니다(아래 입력값은 무시).</p>`
    : "";
  const canTest = url || alerts.envWebhookActive();
  // 웹훅 URL은 조직 보안 설정(알림이 외부로 나감) → 치프 전용. 스태프는 현재 설정 상태만 열람.
  const controls = chief
    ? `<form method="post" action="/settings/alert-webhook" class="flex gap-2">
        <input class="input py-1.5 text-sm" name="webhook_url" value="${esc(url)}" placeholder="https://hooks.slack.com/services/..." />
        <button class="btn-primary shrink-0 btn-sm" type="submit">저장</button>
      </form>
      ${canTest ? `<form method="post" action="/settings/alert-webhook/test"><button class="btn-ghost btn-sm" type="submit">테스트 알림 보내기</button></form>` : ""}`
    : `<p class="text-sm text-muted">${url || alerts.envWebhookActive() ? "알림 웹훅이 설정되어 있습니다." : "알림 웹훅 미설정."} 변경은 <span class="text-fg">치프 엔지니어</span>만 가능합니다(알림이 외부로 전송되는 보안 설정).</p>`;
  return `
    <div class="${SETTING_BLOCK}">
      <div>
        <h2 class="text-sm font-semibold">알림 (웹훅)</h2>
        ${explain(`연체·청구 발행·자료 공유 시 Slack/Discord 등으로 팀 알림을 보냅니다. Incoming Webhook URL을 넣으세요(비우면 알림 끔). 저장 시 암호화됩니다.`)}
        ${envNote}
      </div>
      ${controls}
    </div>`;
}

/** last_login(ISO UTC) → '오늘/어제/N일 전/미로그인' 상대 표시(계정 위생, 2026-07-09 관리 개선). */
function lastLoginLabel(iso) {
  if (!iso) return "";
  const then = new Date(String(iso).replace(" ", "T") + "Z").getTime();
  if (!isFinite(then)) return "";
  const days = Math.floor((Date.now() - then) / 86400000);
  const label = days <= 0 ? "오늘" : days === 1 ? "어제" : `${days}일 전`;
  return `<span class="whitespace-nowrap">로그인 ${label}</span>`;
}

function userRow(u, currentUser, chief = true) {
  const isSelf = u.id === currentUser.id;
  const delLocked = isBootstrapChief(u) || isSelf; // 삭제·비활성: 기본 치프·본인 보호(락아웃 방지). 역할 변경은 본인만 잠금.
  const status = !u.active
    ? `<span class="badge bg-muted/10 text-muted">비활성</span>`
    : u.google_sub
      ? `<span class="badge bg-success/10 text-success">활성</span>`
      : `<span class="badge bg-warning/10 text-warning">초대됨(미로그인)</span>`;
  const roleControl = (!chief || isSelf)
    ? `<span class="badge bg-bg text-muted">${esc(ROLE_LABELS[u.role] || u.role)}</span>` // 스태프 또는 본인 — 역할 변경 불가(배지만)
    : `<form method="post" action="/settings/users/${u.id}/role">
         <select class="input py-1 text-xs" name="role" data-autosubmit>
           ${ROLES.map((r) => `<option value="${esc(r)}" ${r === u.role ? "selected" : ""}>${esc(ROLE_LABELS[r] || r)}</option>`).join("")}
         </select>
       </form>`;
  const del = (!chief || delLocked)
    ? ""
    : `<form method="post" action="/settings/users/${u.id}/delete" data-confirm="${esc(u.name || u.email)} 계정을 삭제할까요? 로그인 화이트리스트와 작업 담당자에서 제거됩니다.">
         <button class="btn-ghost btn-xs text-danger" type="submit">삭제</button>
       </form>`;
  return `
    <div class="rounded-lg border border-border bg-bg p-3">
      <div class="flex items-start justify-between gap-3">
        <div class="min-w-0">
          <div class="truncate font-medium">${esc(u.name || u.email)}</div>
          <div class="mt-0.5 flex flex-wrap items-center gap-2 text-xs text-muted">
            <span class="truncate">${esc(u.email)}</span>${status}${lastLoginLabel(u.last_login)}${isSelf ? `<span class="text-muted">${esc(ROLE_LABELS[u.role] || u.role)} · 본인</span>` : isBootstrapChief(u) ? `<span class="text-muted">· 기본 계정(삭제 불가)</span>` : ""}
          </div>
        </div>
        <div class="flex shrink-0 items-center gap-2">
          ${roleControl}
          ${del}
        </div>
      </div>
      ${chief ? `<details class="mt-2">
        <summary class="cursor-pointer text-xs text-muted hover:text-fg">정보 수정 (이름 · 전화)</summary>
        <form method="post" action="/settings/users/${u.id}/edit" class="mt-2 grid gap-2 sm:grid-cols-2">
          <input class="input py-1.5 text-sm" name="user_name" value="${esc(u.name || "")}" placeholder="이름 (표시명)" autocomplete="off" />
          <input class="input py-1.5 text-sm" name="phone" autocomplete="off" value="${esc(u.mgr_phone || "")}" placeholder="전화" />
          <button class="btn-primary btn-sm sm:col-span-2" type="submit">저장</button>
        </form>
      </details>` : ""}
    </div>`;
}

/** 분 → "3시간 30분" / 0이면 "정액". */
function hourLabel(minutes) {
  if (!minutes || minutes <= 0) return "정액";
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return m ? `${h}시간 ${m}분` : `${h}시간`;
}

function rateItemRow(r) {
  const baseHours = r.base_minutes ? r.base_minutes / 60 : "";
  const extraHours = r.extra_minutes ? r.extra_minutes / 60 : 1;
  const summary = r.base_minutes
    ? `기준 ${hourLabel(r.base_minutes)} · ${formatKRW(r.base_price)} · 초과 ${hourLabel(r.extra_minutes)}당 ${formatKRW(r.extra_price)}`
    : r.base_price > 0 ? `정액(회당) ${formatKRW(r.base_price)}` : `정액(회당) · 금액 미정 — 청구 시 입력`;
  const cat = r.category || RECORDING_CATEGORIES[0];
  return `
    <div class="rounded-lg border border-border bg-bg p-3 ${r.active ? "" : "opacity-60"}">
      <div class="flex items-start justify-between gap-3">
        <div class="min-w-0">
          <div class="flex flex-wrap items-center gap-2"><span class="font-medium">${esc(r.name)}</span><span class="badge bg-bg text-muted">${esc(cat)}</span>${r.active ? "" : '<span class="text-xs text-muted">(비활성)</span>'}</div>
          <div class="mt-0.5 text-xs text-muted">${summary}</div>
        </div>
      </div>
      <details class="group mt-2 border-t border-border pt-2">
        <summary class="flex cursor-pointer list-none items-center justify-end text-xs text-muted hover:text-fg">${detailsChevron()}</summary>
        <form method="post" action="/settings/rate-items/${r.id}" class="mt-2 space-y-2" data-dirty-form>
          <div class="grid gap-2 sm:grid-cols-2">
            <div><label class="label mb-0.5 text-xs">단가 항목명</label><input class="input py-1.5 text-sm" name="rate_name" value="${esc(r.name)}" autocomplete="off" required /></div>
            <div><label class="label mb-0.5 text-xs">분류</label><select class="input py-1.5 text-sm" name="category">${rateCategoryOptions(cat)}</select></div>
          </div>
          <div class="grid gap-2 sm:grid-cols-2">
            <div><label class="label mb-0.5 text-xs">기준 시간(시간)</label><input class="input py-1.5 text-sm" name="base_hours" inputmode="decimal" value="${esc(String(baseHours))}" /></div>
            <div><label class="label mb-0.5 text-xs">기준 가격(원)</label><input class="input py-1.5 text-sm" name="base_price" inputmode="numeric" value="${esc(String(r.base_price || ""))}" /></div>
            <div><label class="label mb-0.5 text-xs">초과 단위(시간)</label><input class="input py-1.5 text-sm" name="extra_hours" inputmode="decimal" value="${esc(String(extraHours))}" /></div>
            <div><label class="label mb-0.5 text-xs">초과 단가(원)</label><input class="input py-1.5 text-sm" name="extra_price" inputmode="numeric" value="${esc(String(r.extra_price || ""))}" /></div>
          </div>
          <div class="flex items-center gap-2">
            <button class="btn-primary btn-xs transition" type="submit" data-dirty-save>저장</button>
            <span class="text-xs text-warning" data-dirty-hint hidden>저장되지 않은 변경사항</span>
          </div>
        </form>
        <form method="post" action="/settings/rate-items/${r.id}/delete" data-confirm="이 단가 항목을 삭제할까요?" class="mt-2">
          <button class="btn-ghost btn-xs text-danger" type="submit">삭제</button>
        </form>
      </details>
    </div>`;
}

/** 작업 종류 카탈로그 행(삭제-only). 편집/삭제는 details 안. */
function taskTypeRow(t) {
  const billLabel = BILLING_TYPE_LABELS[t.billing_type] || t.billing_type;
  const priceLabel = t.unit_price ? formatKRW(t.unit_price) : "단가 미정";
  return `
    <div class="rounded-lg border border-border bg-bg p-3">
      <div class="flex items-start justify-between gap-3">
        <div class="min-w-0">
          <div class="flex flex-wrap items-center gap-2">
            <span class="font-medium">${esc(t.label)}</span>
            ${t.is_quick ? '<span class="badge bg-primary/10 text-primary">빠른추가</span>' : ""}
          </div>
          <div class="mt-0.5 text-xs text-muted">${esc(billLabel)} · ${priceLabel}</div>
        </div>
        <span class="flex shrink-0 gap-1">
      <form method="post" action="/settings/task-types/${t.id}/move"><input type="hidden" name="dir" value="up" /><button class="btn-ghost btn-xs px-2" type="submit" aria-label="위로 이동">↑</button></form>
      <form method="post" action="/settings/task-types/${t.id}/move"><input type="hidden" name="dir" value="down" /><button class="btn-ghost btn-xs px-2" type="submit" aria-label="아래로 이동">↓</button></form>
    </span>
      </div>
      <details class="group mt-2 border-t border-border pt-2">
        <summary class="flex cursor-pointer list-none items-center justify-end text-xs text-muted hover:text-fg">${detailsChevron()}</summary>
        <form method="post" action="/settings/task-types/${t.id}" class="mt-2 space-y-2" data-dirty-form>
          <input class="input py-1.5 text-sm w-full" name="label" value="${esc(t.label)}" required />
          <div class="grid gap-2 sm:grid-cols-2">
            <select class="input py-1.5 text-sm" name="billing_type">
              ${BILLING_TYPES.map((b) => `<option value="${esc(b)}" ${b === t.billing_type ? "selected" : ""}>${esc(BILLING_TYPE_LABELS[b] || b)}</option>`).join("")}
            </select>
            <input class="input py-1.5 text-sm" name="unit_price" inputmode="numeric" value="${esc(String(t.unit_price || ""))}" placeholder="기본 단가(원)" />
          </div>
          <label class="flex items-center gap-2 text-sm text-muted"><input type="checkbox" name="is_quick" value="1" ${t.is_quick ? "checked" : ""} /> 빠른 추가 노출</label>
          <div class="flex items-center gap-2">
            <button class="btn-primary btn-xs transition" type="submit" data-dirty-save>저장</button>
            <span class="text-xs text-warning" data-dirty-hint hidden>저장되지 않은 변경사항</span>
          </div>
        </form>
        <form method="post" action="/settings/task-types/${t.id}/delete" data-confirm="'${esc(t.label)}' 작업 종류를 삭제할까요? 이 종류로 만든 기존 작업은 유지되지만 종류명이 코드값으로 표시됩니다." class="mt-2">
          <button class="btn-ghost btn-xs text-danger" type="submit">삭제</button>
        </form>
      </details>
    </div>`;
}

/**
 * Google 연락처 동기화 섹션(환경설정, 2026-07-09 사용자 요청) — 미연동 연락처 일괄 내보내기.
 * People 푸시가 죽어 있던 기간(party 리네임 회귀, 2026-07-09 수정) + 연동 이전 생성분은 구글 주소록에 없음.
 * 개별 수정 시 자동 생성되지만(contacts.routes 폴백), 한 번에 올리는 버튼을 제공. 버튼=치프 전용(연락처 권한 재로그인 필요할 수 있음).
 */
function googleContactsSection(chief) {
  const total = db().prepare("SELECT COUNT(*) c FROM parties WHERE kind='person'").get().c;
  const linked = db().prepare("SELECT COUNT(*) c FROM parties WHERE kind='person' AND google_resource_name IS NOT NULL").get().c;
  const unlinked = total - linked;
  const status = unlinked
    ? `<p class="text-sm">연락처 <b>${total}</b>명 중 <b class="text-warning">${unlinked}명</b>이 아직 구글 주소록에 없습니다. <span class="text-muted">(연동됨 ${linked}명 — 앱에서 연락처를 수정하면 개별 자동 생성)</span></p>`
    : `<p class="text-sm"><span class="badge badge-success">완료</span> 연락처 ${total}명 전원이 구글 주소록에 연동돼 있습니다.</p>`;
  const action = chief && unlinked
    ? `<form method="post" action="/settings/push-contacts" data-confirm="미연동 연락처 ${unlinked}명을 구글 주소록으로 내보낼까요? (구글에 새 연락처가 생성됩니다)">
         <button class="btn-ghost btn-sm" type="submit">구글로 일괄 내보내기 (${unlinked}명)</button>
       </form>`
    : "";
  return `
  <div class="${SETTING_BLOCK}">
    <div>
      <h2 class="text-sm font-semibold">Google 연락처</h2>
      ${explain(`앱에서 연락처를 만들거나 수정하면 구글 주소록에 자동 반영(push)됩니다. 아래 버튼은 아직 구글에 없는 기존 연락처를 한 번에 내보내는 1회성 작업입니다. 실패분은 서버 로그([people])에 남습니다.`)}
    </div>
    ${status}
    ${action}
  </div>`;
}


// ── 시스템 탭(2026-07-09 관리 개선) — 연동·백업·데이터 상태를 한눈에 + 감사 로그 열람 ──

/** 최신 DB 백업 정보(backups/app-*.db 최대 mtime). 없으면 null. */
function lastBackupInfo() {
  try {
    const dir = backupDir();
    const files = fs.readdirSync(dir).filter((f) => /^app-\d{4}-\d{2}-\d{2}\.db$/.test(f));
    if (!files.length) return { count: 0, latest: null };
    let latest = null;
    for (const f of files) {
      const st = fs.statSync(path.join(dir, f));
      if (!latest || st.mtimeMs > latest.mtimeMs) latest = { name: f, mtimeMs: st.mtimeMs, size: st.size };
    }
    return { count: files.length, latest };
  } catch (_e) { return { count: 0, latest: null }; }
}

/**
 * 시스템 경고 목록(탭 배지·상태 카드 공용). 조용히 죽는 것들의 가시화가 목적:
 * 백업이 26시간 넘게 없으면(cron 침묵 실패) / Drive 미연동 / 캘린더 자동 연동 꺼짐.
 */
function systemWarnings() {
  const warns = [];
  const b = lastBackupInfo();
  if (!b.latest) warns.push("DB 백업 파일이 없습니다 — 일일 백업(cron)이 아직 안 돌았거나 실패 중입니다.");
  else if (Date.now() - b.latest.mtimeMs > 26 * 3600 * 1000) warns.push(`마지막 DB 백업이 ${Math.floor((Date.now() - b.latest.mtimeMs) / 3600000)}시간 전입니다 — 일일 cron 실패 여부를 확인하세요.`);
  if (config.googleConfigured && !drive.isLinked()) warns.push("Google Drive 미연동 — 첨부·백업 오프사이트가 로컬에만 저장됩니다.");
  if (!getState("studio_calendar_id")) warns.push("스튜디오 캘린더 미설정 — 세션의 구글 캘린더 자동 연동이 꺼져 있습니다.");
  return warns;
}

/** 시스템 탭 — 연동 상태 / 백업 / 데이터 / 앱 정보 / 감사 로그(최근 50). chief=수동 백업 버튼 노출. */
function systemTab(chief) {
  const warns = systemWarnings();
  const warnCard = warns.length
    ? `<section class="card border-warning/40"><h2 class="mb-2 text-sm font-semibold text-warning">⚠️ 확인 필요 ${warns.length}건</h2><ul class="list-disc space-y-1 pl-5 text-sm">${warns.map((w) => `<li>${esc(w)}</li>`).join("")}</ul></section>`
    : `<section class="card"><p class="text-sm"><span class="badge badge-success mr-2">정상</span>연동·백업에 확인이 필요한 항목이 없습니다.</p></section>`;

  // 연동 상태 — 각 설정 섹션(환경설정 탭)에 흩어져 있던 것을 배지로 요약.
  const linked = drive.isLinked();
  const calSet = !!getState("studio_calendar_id");
  let peopleOn = false;
  try { peopleOn = !!require("./people").peopleClient(); } catch (_e) { peopleOn = false; }
  const badge = (ok, onLabel, offLabel) => ok ? `<span class="badge badge-success">${esc(onLabel)}</span>` : `<span class="badge badge-warning">${esc(offLabel)}</span>`;
  const integrations = `<section class="card">
      <h2 class="mb-2 text-sm font-semibold">연동 상태</h2>
      <div class="flex flex-wrap gap-x-6 gap-y-1.5 text-sm">
        <span>구글 캘린더 ${badge(calSet, "자동 연동", "꺼짐")}</span>
        <span>구글 Drive ${badge(linked, "연동됨", "미연동")}</span>
        <span>구글 연락처 ${badge(peopleOn, "푸시 가능", "미연동")}</span>
        <span>알림 웹훅 ${badge(alerts.isConfigured(), "설정됨", "미설정")}</span>
      </div>
      <p class="mt-2 text-xs text-muted">세부 설정·연결은 환경설정 탭에서.</p>
    </section>`;

  // 백업 — 마지막 백업 시각·크기·보관 개수 + 수동 백업(치프).
  const b = lastBackupInfo();
  const backupLine = b.latest
    ? `마지막 백업 <b class="text-fg">${esc(new Date(b.latest.mtimeMs).toLocaleString("ko-KR", { timeZone: "Asia/Seoul" }))}</b> · ${esc(b.latest.name)} (${formatBytes(b.latest.size)}) · 보관 ${b.count}개`
    : `<span class="text-warning">백업 파일 없음</span>`;
  const backupCard = `<section class="card">
      <div class="flex flex-wrap items-center justify-between gap-2">
        <h2 class="text-sm font-semibold">DB 백업</h2>
        ${chief ? `<form method="post" action="/settings/backup-now"><button class="btn-ghost btn-sm" type="submit">지금 백업</button></form>` : ""}
      </div>
      <p class="mt-1 text-sm text-muted">${backupLine}</p>
      ${explain(`매일 03:00 KST cron이 VACUUM INTO 스냅샷을 만들고(14일 보존) Drive 연동 시 오프사이트 사본을 올립니다. 복구 절차는 DEPLOY.md §9.`)}
    </section>`;

  // 데이터 현황 — DB 크기·주요 테이블 카운트·로컬 잔존 파일.
  let dbSize = 0, walSize = 0;
  try { dbSize = fs.statSync(config.dbPath).size; } catch (_e) { /* 없음 */ }
  try { walSize = fs.statSync(config.dbPath + "-wal").size; } catch (_e) { /* 없음 */ }
  const cnt = (t) => { try { return db().prepare(`SELECT COUNT(*) c FROM ${t}`).get().c; } catch (_e) { return 0; } };
  const dataCard = `<section class="card">
      <h2 class="mb-2 text-sm font-semibold">데이터 현황</h2>
      <div class="flex flex-wrap gap-x-6 gap-y-1.5 text-sm text-muted">
        <span>DB <b class="text-fg">${formatBytes(dbSize)}</b>${walSize ? ` <span class="text-xs">(+WAL ${formatBytes(walSize)})</span>` : ""}</span>
        <span>프로젝트 <b class="text-fg">${cnt("projects")}</b></span>
        <span>청구 <b class="text-fg">${cnt("invoices")}</b></span>
        <span>클라이언트·연락처 <b class="text-fg">${cnt("parties")}</b></span>
        <span>세션 <b class="text-fg">${cnt("sessions")}</b></span>
        <span>로컬 저장 첨부 <b class="${localFileCount() ? "text-warning" : "text-fg"}">${localFileCount()}</b>개</span>
      </div>
    </section>`;

  // 앱 정보
  let version = "";
  try { version = require("../package.json").version || ""; } catch (_e) { /* 무시 */ }
  const upMin = Math.floor(process.uptime() / 60);
  const appCard = `<section class="card">
      <h2 class="mb-2 text-sm font-semibold">앱 정보</h2>
      <div class="flex flex-wrap gap-x-6 gap-y-1.5 text-sm text-muted">
        <span>버전 <b class="text-fg">${esc(version)}</b></span>
        <span>Node <b class="text-fg">${esc(process.version)}</b></span>
        <span>가동 <b class="text-fg">${upMin >= 60 ? `${Math.floor(upMin / 60)}시간 ${upMin % 60}분` : `${upMin}분`}</b></span>
        <span>환경 <b class="text-fg">${config.isProd ? "프로덕션" : "개발"}</b></span>
      </div>
    </section>`;

  // 감사 로그(최근 50) — 파괴적·재무 액션 추적(삭제 중심 정책 보완).
  const audits = listAudit(50);
  const auditRows = audits.length
    ? audits.map((a) => `<div class="flex flex-wrap items-baseline gap-x-3 gap-y-0.5 border-b border-border py-1.5 text-sm last:border-0">
        <span class="shrink-0 tabular text-xs text-muted">${esc(String(a.at || "").replace("T", " ").slice(0, 16))} UTC</span>
        <span class="shrink-0 badge badge-neutral">${esc(a.action)}</span>
        <span class="min-w-0 flex-1 truncate">${esc(a.target || "")}</span>
        <span class="shrink-0 text-xs text-muted">${esc(a.user_email || "")}</span>
      </div>`).join("")
    : `<p class="text-sm text-muted">기록이 없습니다 — 삭제·역할 변경·지급·청구 상태 변경 같은 액션이 여기 남습니다.</p>`;
  const auditCard = `<section class="card">
      <h2 class="mb-2 text-sm font-semibold">감사 로그 <span class="text-xs font-normal text-muted">최근 ${audits.length}건 — 삭제·역할·지급·청구 상태</span></h2>
      ${auditRows}
    </section>`;

  return warnCard + integrations + backupCard + dataCard + appCard + auditCard;
}

module.exports = {
  peopleTab,
  contentTab,
  driveStorageSection,
  studioCalendarSection,
  roomsSection,
  studioHoursSection,
  defaultBookerSection,
  studioInfoSection,
  alertWebhookSection,
  googleContactsSection,
  systemTab,
  systemWarnings,
  isBootstrapChief,
}; // 내부 전용: rateCategoryOptions·listUsers·ratesGroupedByCategory·rateCategoryManageRow·rateCategoriesSection·roomRow·userRow·hourLabel·rateItemRow·taskTypeRow(위 export 함수들이 클로저로 사용)
