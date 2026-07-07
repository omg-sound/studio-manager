"use strict";

const express = require("express");
const { db } = require("../db");
const { requireChief, requireStaff, isChief, syncUserToManager, findUserById } = require("../auth");
const { config, ROLES, ROLE_LABELS, normalizeRole, BILLING_TYPES, BILLING_TYPE_LABELS } = require("../config");

const RATE_KIND_LABELS = { recording: "녹음", filming: "촬영", performance: "공연" };

/** 단가 항목 카테고리 select 옵션 — kind(녹음/촬영/공연)별 optgroup, DB 분류 순서(2026-07-05 config 하드코딩에서 전환). current 선택 반영. */
function rateCategoryOptions(current = "") {
  const byKind = {};
  listRateCategories().forEach((c) => { (byKind[c.kind] = byKind[c.kind] || []).push(c); });
  return Object.keys(RATE_KIND_LABELS)
    .filter((k) => byKind[k] && byKind[k].length)
    .map((k) => `<optgroup label="${esc(RATE_KIND_LABELS[k])}">${byKind[k].map((c) => `<option value="${esc(c.name)}" ${c.name === current ? "selected" : ""}>${esc(c.name)}</option>`).join("")}</optgroup>`)
    .join("");
}
const {
  listProjectManagers,
  listRooms,
  createRoom,
  deleteRoom,
  listRateItems,
  createRateItem,
  updateRateItem,
  deleteRateItem,
  listRateCategories,
  createRateCategory,
  updateRateCategory,
  deleteRateCategory,
  listTaskTypes,
  createTaskType,
  updateTaskType,
  deleteTaskType,
  getStudioInfo,
  setStudioInfo,
  getStudioLogo,
  setStudioLogo,
  getStudioHours,
  setStudioHours,
  getProMinutes,
  setProMinutes,
  getDefaultBooker,
  setDefaultBooker,
  syncManagerToParty,
  ensurePartyForManager,
  ensurePartyForUser,
  formatPhone,
} = require("../data");
const { layout, pageHeader, esc, flashBanner, formatKRW, emptyState, detailsChevron, explain } = require("../views");
const { asyncHandler } = require("../lib/async");
const multer = require("multer");
const drive = require("../drive");
const { migrateLocalFilesToDrive, localFileCount, driveFileCount } = require("../lib/storage-migrate");

// 로고 업로드(작은 이미지) — 메모리 버퍼로 받아 base64 data URI로 저장. 2MB 제한.
const logoUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 2 * 1024 * 1024 } });
const calendar = require("../calendar");
const alerts = require("../notify");
const { eventInputForSession } = require("./sessions.routes"); // 캘린더 재동기화 버튼 — 세션 캘린더 이벤트 입력(제목·설명) 재사용

const router = express.Router();

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

const SETTINGS_TABS = [
  { key: "people", label: "담당자" },
  { key: "content", label: "컨텐츠" },
  { key: "settings", label: "환경설정" },
];

router.get("/", requireStaff, asyncHandler(async (req, res) => {
  const tab = SETTINGS_TABS.some((t) => t.key === req.query.tab) ? req.query.tab : "people";
  const tabBar = `<div class="mb-4 flex gap-1 overflow-x-auto border-b border-border">
      ${SETTINGS_TABS.map((t) => `<a href="/settings?tab=${t.key}" class="shrink-0 border-b-2 px-4 py-2 text-sm ${t.key === tab ? "border-primary font-semibold text-fg" : "border-transparent text-muted hover:text-fg"}">${esc(t.label)}</a>`).join("")}
    </div>`;

  let tabContent;
  if (tab === "people") tabContent = peopleTab(req.user);
  else if (tab === "content") tabContent = contentTab();
  else tabContent = (await studioCalendarSection()) + driveStorageSection() + roomsSection() + studioHoursSection() + defaultBookerSection() + studioInfoSection() + alertWebhookSection(isChief(req.user)); // 환경설정 — 캘린더 + 자료저장(Drive) + 룸 + 운영시간 + 기본 예약담당자 + 공급자 + 알림

  const body = `
    ${flashBanner(req.query)}
    ${pageHeader({ title: "관리", desc: "담당자 · 컨텐츠 · 환경설정" })}
    ${tabBar}
    <div class="space-y-3">${tabContent}</div>`;

  res.send(layout({ title: "관리", user: req.user, current: "/settings", body, full: true }));
}));

/** 담당자 탭: 하우스 엔지니어 목록 + 외주 작업자 메뉴 안내. */
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
      </section>

      <section class="card space-y-4">
        <div>
          <h2 class="font-display text-lg font-semibold">외주 작업자</h2>
          <p class="mt-1 text-xs text-muted">
            로그인 없이 작업 담당자로만 쓰는 외부 인력은
            <a href="/workers" class="font-medium text-primary hover:underline">외주 작업자 메뉴</a>에서 추가·삭제·정산을 관리합니다.
          </p>
        </div>
      </section>`;
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
      <span class="text-xs text-muted">기본 분류 · 수정·삭제 불가</span>
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

/** 컨텐츠 탭: 단가표·녹음 종류 + 작업 종류 카탈로그. */
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
  return `<section class="card mt-3 space-y-2">
    <div>
      <h2 class="font-display text-lg font-semibold">자료 저장 (구글 Drive)</h2>
      ${explain(`첨부 서류·자료 전달 파일의 실제 저장 위치. 최소 권한(<code>drive.file</code>)으로 앱이 만든 전용 폴더에만 접근합니다. 그 폴더를 원하는 위치로 옮기거나 공유해 쓰실 수 있습니다.`)}
    </div>
    ${status}${migrate}${check}
  </section>`;
}

/** 스튜디오 캘린더(구글) 선택 섹션 — 세션 겹침 검사 대상. */
async function studioCalendarSection() {
  const title = `<div>
      <h2 class="font-display text-lg font-semibold">스튜디오 캘린더 (구글)</h2>
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
  return `<section class="card space-y-4">${title}${inner}${location}</section>`;
}

/** 룸(스튜디오 공간) 관리 — 추가·삭제(단가표와 동일한 삭제-only 톤). 룸별 시간 겹침 검사의 기준. */
function roomsSection() {
  const rooms = listRooms({ includeInactive: true });
  const rows = rooms.length ? rooms.map((r) => roomRow(r)).join("") : emptyState("등록된 룸이 없습니다.");
  return `
    <section class="card space-y-4">
      <div>
        <h2 class="font-display text-lg font-semibold">장소 (스튜디오 룸 · 외부)</h2>
        ${explain(`세션 예약 시 장소를 지정하면 <span class="text-fg">같은 장소끼리만 시간 겹침을 검사</span>합니다(다른 장소는 같은 시간 병렬 예약 허용). 장소를 삭제하면 그 장소로 잡힌 세션은 '장소 미지정'으로 바뀝니다. <span class="text-fg">외부 장소</span>로 표시하면 세션 폼에서 주소 입력칸이 나오고 캘린더 일정 장소로 쓰입니다.`)}
      </div>
      <form method="post" action="/settings/rooms" class="flex flex-wrap items-center gap-2">
        <input class="input py-1.5 text-sm" name="room_name" placeholder="장소 이름 (예: A룸 · 외부일정)" autocomplete="off" required />
        <label class="flex cursor-pointer items-center gap-1.5 text-sm"><input type="checkbox" name="is_external" value="1" class="h-4 w-4 rounded border-border text-primary" /> 외부 장소(주소 입력)</label>
        <button class="btn-primary shrink-0 btn-sm" type="submit">장소 추가</button>
      </form>
      <div class="space-y-2">${rows}</div>
    </section>`;
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
    <section class="card space-y-4">
      <div>
        <h2 class="font-display text-lg font-semibold">운영시간 <span class="text-sm font-normal text-muted">(예약 시작 그리드 범위)</span></h2>
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
    </section>`;
}

/** 기본 예약 담당자 — 세션 예약 폼에서 예약 담당자로 기본 선택될 담당자(이름). */
function defaultBookerSection() {
  const cur = getDefaultBooker() || "";
  const managers = listProjectManagers();
  return `
    <section class="card space-y-4">
      <div>
        <h2 class="font-display text-lg font-semibold">기본 예약 담당자</h2>
        ${explain(`새 세션 예약 폼에서 '예약 담당자'로 기본 선택됩니다.`)}
      </div>
      <form method="post" action="/settings/default-booker" class="flex flex-wrap items-end gap-2">
        <select class="input py-1.5 text-sm" name="default_booker">
          <option value="">지정 안 함</option>
          ${managers.map((m) => `<option value="${esc(m.name)}" ${m.name === cur ? "selected" : ""}>${esc(m.name)}</option>`).join("")}
        </select>
        <button class="btn-primary btn-sm shrink-0" type="submit">저장</button>
      </form>
    </section>`;
}

/** 공급자(스튜디오) 세금정보 — 거래명세서 PDF의 '공급자'란. */
function studioInfoSection() {
  const s = getStudioInfo();
  const logo = getStudioLogo();
  const field = (name, label, ph = "") =>
    `<div><label class="label mb-0.5 text-xs">${esc(label)}</label><input class="input py-1.5 text-sm" name="${esc(name)}" value="${esc(s[name] || "")}" placeholder="${esc(ph)}" /></div>`;
  return `
    <section class="card space-y-4">
      <div>
        <h2 class="font-display text-lg font-semibold">공급자(스튜디오) 세금정보</h2>
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
    </section>`;
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
    <section class="card space-y-4">
      <div>
        <h2 class="font-display text-lg font-semibold">알림 (웹훅)</h2>
        ${explain(`연체·청구 발행·자료 공유 시 Slack/Discord 등으로 팀 알림을 보냅니다. Incoming Webhook URL을 넣으세요(비우면 알림 끔). 저장 시 암호화됩니다.`)}
        ${envNote}
      </div>
      ${controls}
    </section>`;
}

/** 파일 버퍼 매직바이트 검증(Content-Type 스푸핑 방어). */
function checkMagicBytes(buf, mime) {
  if (!buf || buf.length < 4) return false;
  if (/png/.test(mime)) return buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47;
  if (/jpe?g/.test(mime)) return buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff;
  return false;
}

// ── 거래명세서 로고 업로드/삭제(base64 data URI, admin_state) ──
router.post("/studio-logo", requireStaff, logoUpload.single("logo"), (req, res) => {
  const f = req.file;
  if (f && f.buffer && f.buffer.length) {
    const mime = f.mimetype || "";
    if (!/^image\/(png|jpe?g)$/.test(mime)) return res.status(400).send("PNG 또는 JPG 이미지만 업로드할 수 있습니다.");
    if (!checkMagicBytes(f.buffer, mime)) return res.status(400).send("PNG 또는 JPG 이미지만 업로드할 수 있습니다.");
    setStudioLogo(`data:${mime};base64,${f.buffer.toString("base64")}`);
  }
  res.redirect("/settings?tab=settings&flash=saved");
});
router.post("/default-booker", requireStaff, (req, res) => {
  setDefaultBooker(req.body.default_booker);
  res.redirect("/settings?tab=settings&flash=saved");
});
// Drive 저장 폴더 점검 — 실제 Drive API로 폴더 존재 확인 + 바로가기 링크. 없으면 생성.
router.get("/drive-check", requireStaff, asyncHandler(async (req, res) => {
  if (!drive.isLinked()) return res.redirect("/settings?tab=settings&flash=drive_unlinked");
  const driveN = driveFileCount();
  let card;
  try {
    // ① 중복 루트/하위 폴더 감지·통합 — 가장 오래된 원본을 정본 캐시로(캐시 유실/토큰 변경으로 생긴 빈 중복 방지).
    const rec = await drive.reconcileRootFolder();
    const dupTotal = (rec.duplicates || 0) + (rec.subDuplicates || 0);
    const dupWarn = dupTotal > 0
      ? `<div class="rounded-lg border border-warning/40 bg-warning/5 p-3 text-sm">
           <p class="font-medium text-warning">⚠️ 중복 폴더 ${dupTotal}개 감지 — 통합했습니다.${rec.duplicates > 0 ? ` (루트 ${rec.folders.length}개)` : ""}${rec.subDuplicates > 0 ? ` (사업자등록증 등 하위 폴더 중복 ${rec.subDuplicates}개)` : ""}</p>
           <p class="mt-1 text-muted">가장 <span class="text-fg">오래된 원본 폴더</span>(기존 파일이 든 곳)를 기준으로 통합했습니다. 앞으로 업로드·이관은 원본으로 갑니다. Drive에서 <span class="text-fg">비어 있는 나머지 중복 폴더는 직접 삭제</span>해 주세요.</p>
         </div>`
      : "";
    const f = await drive.checkFolder(); // 통합된 원본 폴더 메타
    // ② 실제 업로드 파이프라인(첨부 저장 경로) 왕복 검증.
    let probeBadge;
    try { await drive.probeUpload(); probeBadge = '<span class="badge badge-success">업로드 테스트 통과</span>'; }
    catch (pe) { probeBadge = `<span class="badge badge-error">업로드 테스트 실패</span>`; console.warn("[drive-check] probe 실패:", pe && pe.message); }
    const link = f.webViewLink
      ? `<a href="${esc(f.webViewLink)}" target="_blank" rel="noopener" class="text-primary hover:underline">Drive에서 폴더 열기 ↗</a>`
      : `<span class="text-muted">링크 없음(폴더 ID: ${esc(f.id)})</span>`;
    card = `${dupWarn}<div class="card space-y-2">
      <div class="flex flex-wrap items-center gap-2"><span class="badge badge-success">폴더 확인됨</span>${probeBadge}${f.created ? '<span class="badge badge-info">방금 생성</span>' : ""}${f.trashed ? '<span class="badge badge-error">휴지통</span>' : ""}</div>
      <div class="text-sm"><span class="text-muted">폴더명</span> <span class="font-medium">${esc(f.name)}</span> <span class="text-muted">(원본 · 통합 기준)</span></div>
      <div class="text-sm"><span class="text-muted">폴더 ID</span> <code class="text-xs">${esc(f.id)}</code></div>
      <div class="text-sm"><span class="text-muted">Drive 저장 파일(앱 기록)</span> ${driveN}개</div>
      <div class="pt-1">${link}</div>
      <p class="text-xs text-muted">업로드 테스트는 작은 파일을 올렸다 즉시 삭제해 실제 첨부 저장 경로를 확인합니다.</p>
      ${f.trashed ? '<p class="text-xs text-danger">⚠️ 폴더가 휴지통에 있습니다 — Drive에서 복원하세요.</p>' : ""}
    </div>`;
  } catch (e) {
    card = `<div class="card space-y-2"><span class="badge badge-error">점검 실패</span>
      <p class="text-sm text-muted">Drive 폴더를 확인하지 못했습니다: ${esc((e && e.message) || String(e))}</p>
      <p class="text-xs text-muted">Drive 권한이 만료됐을 수 있습니다 — <a class="text-primary hover:underline" href="/auth/google">구글 계정 재연동</a> 후 다시 시도하세요.</p></div>`;
  }
  const body = `
    ${pageHeader({ title: "Drive 폴더 점검", desc: "첨부·자료 파일이 저장되는 실제 Google Drive 폴더", back: { href: "/settings?tab=settings", label: "관리" } })}
    ${card}`;
  res.send(layout({ title: "Drive 폴더 점검", user: req.user, current: "/settings", body }));
}));

// 로컬 저장 파일(client_files·deliverables)을 Google Drive로 이관. Drive 연동 필요.
router.post("/migrate-drive", requireStaff, asyncHandler(async (req, res) => {
  const r = await migrateLocalFilesToDrive();
  if (!r.ok) return res.redirect("/settings?tab=settings&flash=drive_unlinked");
  // 결과는 섹션 재렌더(남은 로컬 수)로 확인. 실패분이 있으면 로그.
  if (r.failed.length) console.warn("[migrate-drive] failed:", JSON.stringify(r.failed));
  res.redirect(`/settings?tab=settings&flash=${r.failed.length ? "drive_partial" : "drive_done"}`);
}));
router.post("/studio-logo/delete", requireStaff, (req, res) => {
  setStudioLogo(null);
  res.redirect("/settings?tab=settings&flash=deleted");
});

// ── 스튜디오 캘린더 선택 저장 ──
router.post("/studio-calendar", requireStaff, (req, res) => {
  calendar.setStudioCalendarId(req.body.calendar_id);
  res.redirect("/settings?tab=settings&flash=saved");
});

// ── 기존 캘린더 일정 재동기화(1회성 관리 액션) — 제목·설명 포맷을 최신 로직으로 다시 적용 ──
// gcal_event_id가 있는(=이미 구글 캘린더에 올라간) 취소 제외 세션 전부를 순회해 updateEvent만 다시 호출한다.
// 실패는 개별 건너뛰고 계속(전체 중단 방지) — fail-safe. 결과는 notice로 안내.
router.post("/resync-calendar", requireChief, asyncHandler(async (req, res) => {
  const rows = db().prepare("SELECT * FROM sessions WHERE gcal_event_id IS NOT NULL AND status <> '취소'").all();
  let ok = 0, fail = 0;
  for (const s of rows) {
    const project = db().prepare("SELECT * FROM projects WHERE id = ?").get(s.project_id);
    if (!project) { fail++; continue; }
    try {
      const newId = await calendar.updateEvent(s.gcal_event_id, eventInputForSession(s, project));
      if (newId) ok++; else fail++;
    } catch (e) {
      fail++;
    }
  }
  const notice = `캘린더 재동기화 완료 — 성공 ${ok}건${fail ? ` · 실패 ${fail}건` : ""}(총 ${rows.length}건)`;
  res.redirect(`/settings?tab=settings&notice=${encodeURIComponent(notice)}${fail ? "&notice_warn=1" : ""}`);
}));

// ── 예약 일정 기본 장소 저장 ──
router.post("/studio-location", requireStaff, (req, res) => {
  calendar.setStudioLocation(req.body.studio_location);
  res.redirect("/settings?tab=settings&flash=saved");
});

// ── 기본 1Pro 시간(분) 저장 — 시간 입력 → 분 변환 ──
router.post("/pro-minutes", requireStaff, (req, res) => {
  const hours = parseFloat(req.body.pro_hours);
  setProMinutes(Number.isFinite(hours) && hours > 0 ? Math.round(hours * 60) : null);
  res.redirect("/settings?tab=settings&flash=saved");
});

// ── 운영시간(예약 그리드 범위) 저장 ──
router.post("/studio-hours", requireStaff, (req, res) => {
  setStudioHours(req.body.hours_start, req.body.hours_end);
  res.redirect("/settings?tab=settings&flash=saved");
});

// ── 공급자(스튜디오) 세금정보 저장 — 거래명세서 PDF용. 평문 admin_state ──
router.post("/studio-info", requireStaff, (req, res) => {
  setStudioInfo(req.body);
  res.redirect("/settings?tab=settings&flash=saved");
});

// ── 알림 웹훅 설정/테스트 ──
router.post("/alert-webhook", requireChief, (req, res) => {
  alerts.setWebhookUrl(req.body.webhook_url); // 암호화 저장(또는 비우면 해제)
  res.redirect("/settings?tab=settings&flash=saved");
});

router.post("/alert-webhook/test", requireChief, asyncHandler(async (req, res) => {
  await alerts.notify({ type: "test", title: "[테스트] OMG Studios 알림", text: "알림 채널이 정상 연결되었습니다." });
  res.redirect("/settings?tab=settings&flash=tested");
}));

// 로그인 계정(owner 포함) → 연락처 보장(+하우스 담당자 연결은 ensurePartyForUser가 자체 처리). 담당자 있으면 성·이름 보강.
function ensureContactForHouseUser(userId) {
  ensurePartyForUser(findUserById(userId)); // user_id 연결 연락처 생성/보장 + 담당자 연락처 연결(중복 방지)
  const mgr = db().prepare("SELECT id FROM project_managers WHERE user_id = ? AND active = 1").get(userId);
  if (mgr) ensurePartyForManager(mgr.id); // 성·이름 자동 분리 보강
}

// ── 하우스 엔지니어(로그인 화이트리스트) 관리 — 작업 담당자 자동 동기화 ──
router.post("/users", requireChief, (req, res) => {
  const email = String(req.body.email || "").trim().toLowerCase();
  const name = String(req.body.user_name != null ? req.body.user_name : req.body.name || "").trim(); // 폼 필드=user_name(자동완성 회피)
  const role = normalizeRole(req.body.role);
  if (email && /^\S+@\S+\.\S+$/.test(email)) {
    const exists = db().prepare("SELECT id, role FROM users WHERE email = ?").get(email);
    if (exists) {
      // /role과 동일 불변식: 본인 역할은 강등 불가(현재 역할 유지) + 마지막 활성 치프 강등 거부(락아웃 방지)
      let nextRole = role;
      if (exists.id === req.user.id) nextRole = req.user.role;
      if (exists.role === "chief" && nextRole !== "chief") {
        const others = db().prepare("SELECT COUNT(*) AS n FROM users WHERE role = 'chief' AND active = 1 AND id != ?").get(exists.id).n;
        if (others === 0) return res.redirect("/settings?tab=people&flash=last_chief");
      }
      // 이름은 비어있지 않을 때만 갱신(로그인으로 받은 Google 이름 보존)
      if (name) db().prepare("UPDATE users SET role = ?, name = ?, active = 1 WHERE id = ?").run(nextRole, name, exists.id);
      else db().prepare("UPDATE users SET role = ?, active = 1 WHERE id = ?").run(nextRole, exists.id);
      syncUserToManager(findUserById(exists.id));
      ensureContactForHouseUser(exists.id); // 하우스 엔지니어 → 연동 연락처+성·이름 보장
    } else {
      const info = db().prepare("INSERT INTO users (email, role, name, active) VALUES (?, ?, ?, 1)").run(email, role, name);
      syncUserToManager(findUserById(info.lastInsertRowid));
      ensureContactForHouseUser(info.lastInsertRowid); // 하우스 엔지니어 → 연동 연락처+성·이름 보장
    }
  }
  res.redirect("/settings?flash=saved");
});

router.post("/users/:id/role", requireChief, (req, res) => {
  const id = Number(req.params.id);
  const role = normalizeRole(req.body.role);
  const target = db().prepare("SELECT * FROM users WHERE id = ?").get(id);
  if (!target || target.id === req.user.id) return res.redirect("/settings?tab=people&flash=saved"); // 본인 역할은 변경 불가
  // 최소 1명의 치프 유지: 치프를 비치프로 강등 시, 본인 제외 활성 치프가 0이면 거부
  if (target.role === "chief" && role !== "chief") {
    const others = db().prepare("SELECT COUNT(*) AS n FROM users WHERE role = 'chief' AND active = 1 AND id != ?").get(id).n;
    if (others === 0) return res.redirect("/settings?tab=people&flash=last_chief");
  }
  db().prepare("UPDATE users SET role = ? WHERE id = ?").run(role, id);
  syncUserToManager(findUserById(id)); // 역할 변경(owner↔치프/스태프) 시 작업 담당자 활성/이름 즉시 동기화
  ensureContactForHouseUser(id); // owner↔하우스 전환 시 연락처 연결 유지(담당자 없어도 owner 연락처 보존)
  res.redirect("/settings?tab=people&flash=saved");
});

router.post("/users/:id/delete", requireChief, (req, res) => {
  const id = Number(req.params.id);
  const target = db().prepare("SELECT * FROM users WHERE id = ?").get(id);
  // 본인·부트스트랩 치프는 삭제 금지(자기 잠금/락아웃 방지)
  if (target && !isBootstrapChief(target) && target.id !== req.user.id) {
    db().prepare("DELETE FROM project_managers WHERE user_id = ?").run(id); // 하우스 엔지니어 링크 제거(projects.manager_id → SET NULL)
    db().prepare("DELETE FROM users WHERE id = ?").run(id);
  }
  res.redirect("/settings?flash=deleted");
});

// 하우스 엔지니어 정보 수정(이름·전화) — 이름은 users + 작업 담당자 동기화, 전화는 작업 담당자 행에 저장.
router.post("/users/:id/edit", requireChief, (req, res) => {
  const id = Number(req.params.id);
  const name = String(req.body.user_name != null ? req.body.user_name : req.body.name || "").trim(); // 폼 필드=user_name(자동완성 회피)
  if (name) db().prepare("UPDATE users SET name = ? WHERE id = ?").run(name, id);
  syncUserToManager(findUserById(id)); // users.name·email·active → 작업 담당자(project_managers) 동기화
  const mgr = db().prepare("SELECT id FROM project_managers WHERE user_id = ?").get(id);
  if (mgr) {
    db().prepare("UPDATE project_managers SET phone = ? WHERE id = ?").run(formatPhone(req.body.phone), mgr.id);
    if (name) db().prepare("UPDATE track_tasks SET engineer_name = ? WHERE engineer_id = ?").run(name, mgr.id); // 이름 변경 시 기존 작업 스냅샷 동기화(헤더 표시·매출 매칭) — 외주와 동일
    syncManagerToParty(mgr.id); // 전화 → 연동 연락처 동기화(하우스는 이메일 제외)
    ensurePartyForManager(mgr.id); // 미연결이면 연락처 생성·연결(+성·이름 백필)
  }
  res.redirect("/settings?tab=people&flash=saved");
});

// ── 단가표(과금 항목) 관리 ──
router.post("/rate-items", requireStaff, (req, res) => {
  try {
    createRateItem(req.body);
  } catch (e) {
    if (!["RATE_NAME_REQUIRED", "RATE_PRICE_REQUIRED"].includes(e.message)) throw e; // 이름·가격 누락은 조용히 생성 안 함
  }
  res.redirect("/settings?tab=content&flash=saved");
});

router.post("/rate-items/:id", requireStaff, (req, res) => {
  try {
    updateRateItem(Number(req.params.id), req.body);
  } catch (e) {
    if (!["RATE_NAME_REQUIRED", "RATE_PRICE_REQUIRED"].includes(e.message)) throw e; // 이름·가격 누락은 조용히 생성 안 함
  }
  res.redirect("/settings?tab=content&flash=saved");
});

router.post("/rate-items/:id/delete", requireStaff, (req, res) => {
  deleteRateItem(Number(req.params.id));
  res.redirect("/settings?tab=content&flash=deleted");
});

// ── 단가표 분류 관리(2026-07-05) — 기본 분류는 잠금(locked), 치프가 추가한 분류만 수정·삭제 ──
router.post("/rate-categories", requireStaff, (req, res) => {
  try {
    createRateCategory({ name: req.body.cat_name, kind: req.body.kind });
  } catch (e) {
    if (e.message !== "CATEGORY_NAME_REQUIRED") throw e; // 이름 누락은 조용히 생성 안 함
  }
  res.redirect("/settings?tab=content&flash=saved");
});

router.post("/rate-categories/:id", requireStaff, (req, res) => {
  try {
    updateRateCategory(Number(req.params.id), { name: req.body.cat_name, kind: req.body.kind });
  } catch (e) {
    if (e.message === "CATEGORY_NAME_REQUIRED") return res.redirect("/settings?tab=content");
    if (e.message === "CATEGORY_LOCKED") return res.redirect("/settings?tab=content&notice=" + encodeURIComponent("기본 분류는 수정할 수 없습니다.") + "&notice_warn=1");
    throw e;
  }
  res.redirect("/settings?tab=content&flash=saved");
});

router.post("/rate-categories/:id/delete", requireStaff, (req, res) => {
  try {
    deleteRateCategory(Number(req.params.id));
  } catch (e) {
    if (e.message === "CATEGORY_LOCKED") return res.redirect("/settings?tab=content&notice=" + encodeURIComponent("기본 분류는 삭제할 수 없습니다.") + "&notice_warn=1");
    if (e.message === "CATEGORY_IN_USE") return res.redirect("/settings?tab=content&notice=" + encodeURIComponent("이 분류를 쓰는 단가 항목이 있어 삭제할 수 없습니다. 먼저 그 항목들을 다른 분류로 옮기거나 삭제하세요.") + "&notice_warn=1");
    throw e;
  }
  res.redirect("/settings?tab=content&flash=deleted");
});

// ── 룸(스튜디오 공간) 관리(추가·삭제) ──
router.post("/rooms", requireStaff, (req, res) => {
  try {
    createRoom(req.body);
  } catch (e) {
    if (e.message !== "ROOM_NAME_REQUIRED") throw e;
  }
  res.redirect("/settings?tab=settings&flash=saved");
});

router.post("/rooms/:id/delete", requireStaff, (req, res) => {
  deleteRoom(Number(req.params.id)); // 참조 세션 room_id → NULL 후 행 삭제(data.deleteRoom)
  res.redirect("/settings?tab=settings&flash=deleted");
});

// ── 작업 종류 카탈로그 관리(삭제-only) ──
router.post("/task-types", requireStaff, (req, res) => {
  try {
    createTaskType(req.body);
  } catch (e) {
    if (e.message !== "TASK_TYPE_LABEL_REQUIRED") throw e;
  }
  res.redirect("/settings?tab=content&flash=saved");
});

router.post("/task-types/:id", requireStaff, (req, res) => {
  const isFetch = req.get("X-Requested-With") === "fetch"; // 자동저장(AJAX)
  try {
    updateTaskType(Number(req.params.id), req.body);
  } catch (e) {
    if (e.message !== "TASK_TYPE_LABEL_REQUIRED") throw e;
    if (isFetch) return res.status(400).json({ ok: false, error: "이름을 입력하세요." });
  }
  if (isFetch) return res.json({ ok: true });
  res.redirect("/settings?tab=content&flash=saved");
});

router.post("/task-types/:id/delete", requireStaff, (req, res) => {
  deleteTaskType(Number(req.params.id));
  res.redirect("/settings?tab=content&flash=deleted");
});

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
            <span class="truncate">${esc(u.email)}</span>${status}${isSelf ? `<span class="text-muted">${esc(ROLE_LABELS[u.role] || u.role)} · 본인</span>` : isBootstrapChief(u) ? `<span class="text-muted">· 기본 계정(삭제 불가)</span>` : ""}
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

module.exports = router;
