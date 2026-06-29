"use strict";

const express = require("express");
const { db } = require("../db");
const { requireChief, syncUserToManager, findUserById } = require("../auth");
const { config, ROLES, ROLE_LABELS, normalizeRole, RECORDING_CATEGORIES, TASK_GROUPS, TASK_GROUP_LABELS, BILLING_TYPES, BILLING_TYPE_LABELS } = require("../config");
const {
  listProjectManagers,
  listRooms,
  createRoom,
  deleteRoom,
  listRateItems,
  createRateItem,
  updateRateItem,
  deleteRateItem,
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
} = require("../data");
const { layout, pageHeader, esc, flashBanner, formatKRW, emptyState, detailsChevron } = require("../views");
const { asyncHandler } = require("../lib/async");
const multer = require("multer");
const drive = require("../drive");

// 로고 업로드(작은 이미지) — 메모리 버퍼로 받아 base64 data URI로 저장. 2MB 제한.
const logoUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 2 * 1024 * 1024 } });
const calendar = require("../calendar");
const alerts = require("../notify");

const router = express.Router();

/** 부트스트랩 치프(ADMIN_EMAIL)는 강등/비활성 불가 — 잠금 방지. */
function isBootstrapChief(user) {
  return Boolean(config.adminEmail) && user && user.email === config.adminEmail;
}

function listUsers() {
  return db().prepare("SELECT * FROM users ORDER BY active DESC, role, email").all();
}

const SETTINGS_TABS = [
  { key: "people", label: "담당자" },
  { key: "content", label: "컨텐츠" },
  { key: "settings", label: "환경설정" },
];

router.get("/", requireChief, asyncHandler(async (req, res) => {
  const tab = SETTINGS_TABS.some((t) => t.key === req.query.tab) ? req.query.tab : "people";
  const tabBar = `<div class="mb-4 flex gap-1 overflow-x-auto border-b border-border">
      ${SETTINGS_TABS.map((t) => `<a href="/settings?tab=${t.key}" class="shrink-0 border-b-2 px-4 py-2 text-sm ${t.key === tab ? "border-primary font-semibold text-fg" : "border-transparent text-muted hover:text-fg"}">${esc(t.label)}</a>`).join("")}
    </div>`;

  let tabContent;
  if (tab === "people") tabContent = peopleTab(req.user);
  else if (tab === "content") tabContent = contentTab();
  else tabContent = (await studioCalendarSection()) + roomsSection() + studioHoursSection() + studioInfoSection() + alertWebhookSection(); // 환경설정 — 캘린더 + 룸 + 운영시간 + 공급자 + 알림

  const body = `
    ${flashBanner(req.query)}
    ${pageHeader({ title: "관리", desc: "담당자 · 컨텐츠 · 환경설정" })}
    ${tabBar}
    <div class="space-y-3">${tabContent}</div>`;

  res.send(layout({ title: "관리", user: req.user, current: "/settings", body, full: true }));
}));

/** 담당자 탭: 하우스 엔지니어 목록 + 외주 작업자 메뉴 안내. */
function peopleTab(currentUser) {
  const users = listUsers();
  const userRows = users.length ? users.map((u) => userRow(u, currentUser)).join("") : emptyState("등록된 사용자가 없습니다.");
  return `
      <section class="card space-y-4">
        <div>
          <h2 class="font-display text-lg font-semibold">하우스 엔지니어 <span class="text-sm font-normal text-muted">(로그인 계정)</span></h2>
          <p class="mt-1 text-xs text-muted">등록한 Google 계정만 로그인할 수 있고, <span class="text-fg">작업 담당자에 자동으로 포함</span>됩니다. 치프는 전체, 스태프는 프로젝트·작업·자료까지.</p>
        </div>
        <form method="post" action="/settings/users" class="space-y-2">
          <div class="grid gap-2 sm:grid-cols-2">
            <input class="input" name="name" placeholder="이름 (작업 담당자 표시명)" />
            <input class="input" type="email" name="email" placeholder="Google 이메일" required />
          </div>
          <div class="flex gap-2">
            <select class="input" name="role">
              ${ROLES.map((r) => `<option value="${esc(r)}" ${r === "staff" ? "selected" : ""}>${esc(ROLE_LABELS[r] || r)}</option>`).join("")}
            </select>
            <button class="btn-primary shrink-0" type="submit">엔지니어 추가</button>
          </div>
        </form>
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

/** 컨텐츠 탭: 단가표·녹음 종류 + 작업 종류 카탈로그. */
function contentTab() {
  const rates = listRateItems({ includeInactive: true });
  const rateRows = rates.length ? rates.map((r) => rateItemRow(r)).join("") : emptyState("등록된 단가 항목이 없습니다.");
  const taskTypes = listTaskTypes({ includeInactive: true });
  const taskTypeRows = taskTypes.length ? taskTypes.map((t) => taskTypeRow(t)).join("") : emptyState("등록된 작업 종류가 없습니다.");
  return `
      <section class="card space-y-4">
        <div>
          <h2 class="font-display text-lg font-semibold">단가표 · 녹음 종류</h2>
          <p class="mt-1 text-xs text-muted">분류(스튜디오 녹음 / 로케이션 녹음)별로 녹음 종류(보컬 녹음, 악기 녹음 등)를 추가합니다. 녹음 세션 폼의 '녹음 종류'에 이 항목이 분류로 묶여 표시됩니다. 기준 시간(1Pro) 안은 기준가, 초과는 단위 시간당 추가 과금.</p>
        </div>
        <form method="post" action="/settings/rate-items" class="space-y-2 rounded-lg border border-border bg-bg p-3">
          <div class="grid gap-2 sm:grid-cols-2">
            <input class="input py-1.5 text-sm" name="name" placeholder="녹음 종류명 (예: 보컬 녹음)" required />
            <select class="input py-1.5 text-sm" name="category">
              ${RECORDING_CATEGORIES.map((c) => `<option value="${esc(c)}">${esc(c)}</option>`).join("")}
            </select>
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
        <div class="space-y-2">${rateRows}</div>
      </section>

      <section class="card space-y-4">
        <div>
          <h2 class="font-display text-lg font-semibold">작업 종류 <span class="text-sm font-normal text-muted">(곡·콘텐츠 후반작업)</span></h2>
          <p class="mt-1 text-xs text-muted">곡·콘텐츠의 작업 종류(보컬튠·믹싱·마스터링 등)와 기본 단가·과금·분류를 관리합니다. '빠른추가'를 켜면 곡·콘텐츠의 빠른 추가 버튼에 노출됩니다.</p>
        </div>
        <form method="post" action="/settings/task-types" class="space-y-2 rounded-lg border border-border bg-bg p-3">
          <div class="grid gap-2 sm:grid-cols-2">
            <input class="input py-1.5 text-sm" name="label" placeholder="작업 종류명 (예: 보컬튠)" required />
            <select class="input py-1.5 text-sm" name="task_group">
              ${TASK_GROUPS.map((g) => `<option value="${esc(g)}">${esc(TASK_GROUP_LABELS[g] || g)}</option>`).join("")}
            </select>
          </div>
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

/** 스튜디오 캘린더(구글) 선택 섹션 — 세션 겹침 검사 대상. */
async function studioCalendarSection() {
  const title = `<div>
      <h2 class="font-display text-lg font-semibold">스튜디오 캘린더 (구글)</h2>
      <p class="mt-1 text-xs text-muted">선택한 캘린더에 이미 잡힌 일정과 겹치면 녹음·믹싱 세션 예약을 막습니다. 일정 제목은 읽지 않고 바쁜 시간대만 확인합니다. <span class="text-muted">스튜디오 전용 캘린더를 권장</span>합니다(개인 일정이 섞이면 그 시간도 막힙니다).</p>
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
      inner = `<form method="post" action="/settings/studio-calendar" class="flex gap-2">
          <select class="input" name="calendar_id">
            <option value="">사용 안 함 (외부 캘린더 겹침 검사 끔)</option>
            ${calendars.map((c) => `<option value="${esc(c.id)}" ${c.id === current ? "selected" : ""}>${esc(c.summary)}${c.primary ? " · 기본" : ""}</option>`).join("")}
          </select>
          <button class="btn-primary shrink-0" type="submit">저장</button>
        </form>`;
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
        <h2 class="font-display text-lg font-semibold">룸 (스튜디오 공간)</h2>
        <p class="mt-1 text-xs text-muted">세션 예약 시 룸을 지정하면 <span class="text-fg">같은 룸끼리만 시간 겹침을 검사</span>합니다(다른 룸은 같은 시간 병렬 예약 허용). 룸을 삭제하면 그 룸으로 잡힌 세션은 '룸 미지정'으로 바뀝니다.</p>
      </div>
      <form method="post" action="/settings/rooms" class="flex gap-2">
        <input class="input py-1.5 text-sm" name="name" placeholder="룸 이름 (예: A룸)" required />
        <button class="btn-primary shrink-0 btn-sm" type="submit">룸 추가</button>
      </form>
      <div class="space-y-2">${rows}</div>
    </section>`;
}

/** 룸 행(삭제-only). */
function roomRow(r) {
  return `
    <div class="rounded-lg border border-border bg-bg p-3">
      <div class="flex items-center justify-between gap-3">
        <div class="font-medium">${esc(r.name)}</div>
        <form method="post" action="/settings/rooms/${r.id}/delete" data-confirm="'${esc(r.name)}' 룸을 삭제할까요? 이 룸으로 예약된 세션은 '룸 미지정'으로 바뀝니다.">
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
        <p class="mt-1 text-xs text-muted">세션 예약 폼의 '시작 시간 그리드'에 표시되는 시간 범위입니다(30분 단위). 그리드 바깥 시각은 '직접입력'으로 예약할 수 있습니다.</p>
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
        <p class="mt-1 text-xs text-muted">발행된 청구의 <span class="text-fg">거래명세서 PDF</span> '공급자'란에 들어갑니다. (세금계산서가 아닌 참고용 문서)</p>
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
function alertWebhookSection() {
  const url = alerts.getConfiguredWebhook();
  const envNote = alerts.envWebhookActive()
    ? `<p class="mt-1 text-xs text-warning">환경변수 ALERT_WEBHOOK가 설정되어 우선 적용됩니다(아래 입력값은 무시).</p>`
    : "";
  const canTest = url || alerts.envWebhookActive();
  return `
    <section class="card space-y-4">
      <div>
        <h2 class="font-display text-lg font-semibold">알림 (웹훅)</h2>
        <p class="mt-1 text-xs text-muted">연체·청구 발행·자료 공유 시 Slack/Discord 등으로 팀 알림을 보냅니다. Incoming Webhook URL을 넣으세요(비우면 알림 끔). 저장 시 암호화됩니다.</p>
        ${envNote}
      </div>
      <form method="post" action="/settings/alert-webhook" class="flex gap-2">
        <input class="input py-1.5 text-sm" name="webhook_url" value="${esc(url)}" placeholder="https://hooks.slack.com/services/..." />
        <button class="btn-primary shrink-0 btn-sm" type="submit">저장</button>
      </form>
      ${canTest ? `<form method="post" action="/settings/alert-webhook/test"><button class="btn-ghost btn-sm" type="submit">테스트 알림 보내기</button></form>` : ""}
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
router.post("/studio-logo", requireChief, logoUpload.single("logo"), (req, res) => {
  const f = req.file;
  if (f && f.buffer && f.buffer.length) {
    const mime = f.mimetype || "";
    if (!/^image\/(png|jpe?g)$/.test(mime)) return res.status(400).send("PNG 또는 JPG 이미지만 업로드할 수 있습니다.");
    if (!checkMagicBytes(f.buffer, mime)) return res.status(400).send("PNG 또는 JPG 이미지만 업로드할 수 있습니다.");
    setStudioLogo(`data:${mime};base64,${f.buffer.toString("base64")}`);
  }
  res.redirect("/settings?tab=settings&flash=saved");
});
router.post("/studio-logo/delete", requireChief, (req, res) => {
  setStudioLogo(null);
  res.redirect("/settings?tab=settings&flash=deleted");
});

// ── 스튜디오 캘린더 선택 저장 ──
router.post("/studio-calendar", requireChief, (req, res) => {
  calendar.setStudioCalendarId(req.body.calendar_id);
  res.redirect("/settings?tab=settings&flash=saved");
});

// ── 예약 일정 기본 장소 저장 ──
router.post("/studio-location", requireChief, (req, res) => {
  calendar.setStudioLocation(req.body.studio_location);
  res.redirect("/settings?tab=settings&flash=saved");
});

// ── 운영시간(예약 그리드 범위) 저장 ──
router.post("/studio-hours", requireChief, (req, res) => {
  setStudioHours(req.body.hours_start, req.body.hours_end);
  res.redirect("/settings?tab=settings&flash=saved");
});

// ── 공급자(스튜디오) 세금정보 저장 — 거래명세서 PDF용. 평문 admin_state ──
router.post("/studio-info", requireChief, (req, res) => {
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

// ── 하우스 엔지니어(로그인 화이트리스트) 관리 — 작업 담당자 자동 동기화 ──
router.post("/users", requireChief, (req, res) => {
  const email = String(req.body.email || "").trim().toLowerCase();
  const name = String(req.body.name || "").trim();
  const role = normalizeRole(req.body.role);
  if (email && /^\S+@\S+\.\S+$/.test(email)) {
    const exists = db().prepare("SELECT id FROM users WHERE email = ?").get(email);
    if (exists) {
      // 이름은 비어있지 않을 때만 갱신(로그인으로 받은 Google 이름 보존)
      if (name) db().prepare("UPDATE users SET role = ?, name = ?, active = 1 WHERE id = ?").run(role, name, exists.id);
      else db().prepare("UPDATE users SET role = ?, active = 1 WHERE id = ?").run(role, exists.id);
      syncUserToManager(findUserById(exists.id));
    } else {
      const info = db().prepare("INSERT INTO users (email, role, name, active) VALUES (?, ?, ?, 1)").run(email, role, name);
      syncUserToManager(findUserById(info.lastInsertRowid));
    }
  }
  res.redirect("/settings?flash=saved");
});

router.post("/users/:id/role", requireChief, (req, res) => {
  const id = Number(req.params.id);
  const role = normalizeRole(req.body.role);
  const target = db().prepare("SELECT * FROM users WHERE id = ?").get(id);
  // 본인·부트스트랩 치프는 강등 금지(자기 잠금/락아웃 방지)
  if (target && !isBootstrapChief(target) && target.id !== req.user.id) {
    db().prepare("UPDATE users SET role = ? WHERE id = ?").run(role, id);
  }
  res.redirect("/settings?flash=saved");
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

// ── 단가표(과금 항목) 관리 ──
router.post("/rate-items", requireChief, (req, res) => {
  try {
    createRateItem(req.body);
  } catch (e) {
    if (e.message !== "RATE_NAME_REQUIRED") throw e;
  }
  res.redirect("/settings?tab=content&flash=saved");
});

router.post("/rate-items/:id", requireChief, (req, res) => {
  try {
    updateRateItem(Number(req.params.id), req.body);
  } catch (e) {
    if (e.message !== "RATE_NAME_REQUIRED") throw e;
  }
  res.redirect("/settings?tab=content&flash=saved");
});

router.post("/rate-items/:id/delete", requireChief, (req, res) => {
  deleteRateItem(Number(req.params.id));
  res.redirect("/settings?tab=content&flash=deleted");
});

// ── 룸(스튜디오 공간) 관리(추가·삭제) ──
router.post("/rooms", requireChief, (req, res) => {
  try {
    createRoom(req.body);
  } catch (e) {
    if (e.message !== "ROOM_NAME_REQUIRED") throw e;
  }
  res.redirect("/settings?tab=settings&flash=saved");
});

router.post("/rooms/:id/delete", requireChief, (req, res) => {
  deleteRoom(Number(req.params.id)); // 참조 세션 room_id → NULL 후 행 삭제(data.deleteRoom)
  res.redirect("/settings?tab=settings&flash=deleted");
});

router.post("/managers", requireChief, (req, res) => {
  const name = String(req.body.name || "").trim();
  if (name) {
    db()
      .prepare("INSERT INTO project_managers (name, email, phone, active) VALUES (?, ?, ?, 1)")
      .run(name, clean(req.body.email), clean(req.body.phone));
  }
  res.redirect("/settings?flash=saved");
});

router.post("/managers/:id/delete", requireChief, (req, res) => {
  db().prepare("DELETE FROM project_managers WHERE id = ?").run(Number(req.params.id)); // projects.manager_id → SET NULL
  res.redirect("/settings?flash=deleted");
});

// ── 작업 종류 카탈로그 관리(삭제-only) ──
router.post("/task-types", requireChief, (req, res) => {
  try {
    createTaskType(req.body);
  } catch (e) {
    if (e.message !== "TASK_TYPE_LABEL_REQUIRED") throw e;
  }
  res.redirect("/settings?tab=content&flash=saved");
});

router.post("/task-types/:id", requireChief, (req, res) => {
  try {
    updateTaskType(Number(req.params.id), req.body);
  } catch (e) {
    if (e.message !== "TASK_TYPE_LABEL_REQUIRED") throw e;
  }
  res.redirect("/settings?tab=content&flash=saved");
});

router.post("/task-types/:id/delete", requireChief, (req, res) => {
  deleteTaskType(Number(req.params.id));
  res.redirect("/settings?tab=content&flash=deleted");
});

function clean(value) {
  return String(value || "").trim() || null;
}

function userRow(u, currentUser) {
  const locked = isBootstrapChief(u) || u.id === currentUser.id; // 강등/비활성 불가
  const status = !u.active
    ? `<span class="badge bg-muted/10 text-muted">비활성</span>`
    : u.google_sub
      ? `<span class="badge bg-success/10 text-success">활성</span>`
      : `<span class="badge bg-warning/10 text-warning">초대됨(미로그인)</span>`;
  const roleControl = locked
    ? `<span class="badge bg-bg text-muted">${esc(ROLE_LABELS[u.role] || u.role)}</span>`
    : `<form method="post" action="/settings/users/${u.id}/role">
         <select class="input py-1 text-xs" name="role" data-autosubmit>
           ${ROLES.map((r) => `<option value="${esc(r)}" ${r === u.role ? "selected" : ""}>${esc(ROLE_LABELS[r] || r)}</option>`).join("")}
         </select>
       </form>`;
  const del = locked
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
            <span class="truncate">${esc(u.email)}</span>${status}${locked ? `<span class="text-muted">${esc(ROLE_LABELS[u.role] || u.role)}${isBootstrapChief(u) ? " · 기본 치프" : " · 본인"}</span>` : ""}
          </div>
        </div>
        <div class="flex shrink-0 items-center gap-2">
          ${locked ? "" : roleControl}
          ${del}
        </div>
      </div>
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
    : `정액 ${formatKRW(r.base_price)}`;
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
        <form method="post" action="/settings/rate-items/${r.id}" class="mt-2 space-y-2">
          <div class="grid gap-2 sm:grid-cols-2">
            <input class="input py-1.5 text-sm" name="name" value="${esc(r.name)}" required />
            <select class="input py-1.5 text-sm" name="category">
              ${RECORDING_CATEGORIES.map((c) => `<option value="${esc(c)}" ${c === cat ? "selected" : ""}>${esc(c)}</option>`).join("")}
            </select>
          </div>
          <div class="grid gap-2 sm:grid-cols-2">
            <div><label class="label mb-0.5 text-xs">기준 시간(시간)</label><input class="input py-1.5 text-sm" name="base_hours" inputmode="decimal" value="${esc(String(baseHours))}" /></div>
            <div><label class="label mb-0.5 text-xs">기준 가격(원)</label><input class="input py-1.5 text-sm" name="base_price" inputmode="numeric" value="${esc(String(r.base_price || ""))}" /></div>
            <div><label class="label mb-0.5 text-xs">초과 단위(시간)</label><input class="input py-1.5 text-sm" name="extra_hours" inputmode="decimal" value="${esc(String(extraHours))}" /></div>
            <div><label class="label mb-0.5 text-xs">초과 단가(원)</label><input class="input py-1.5 text-sm" name="extra_price" inputmode="numeric" value="${esc(String(r.extra_price || ""))}" /></div>
          </div>
          <button class="btn-primary btn-xs" type="submit">저장</button>
        </form>
        <form method="post" action="/settings/rate-items/${r.id}/delete" data-confirm="이 단가 항목을 삭제할까요?" class="mt-2">
          <button class="btn-ghost btn-xs text-danger" type="submit">삭제</button>
        </form>
      </details>
    </div>`;
}

function managerRow(m) {
  return `
    <div class="rounded-lg border border-border bg-bg p-3">
      <div class="flex items-start justify-between gap-3">
        <div class="min-w-0">
          <div class="font-medium">${esc(m.name)}</div>
          <div class="mt-0.5 truncate text-xs text-muted">${esc([m.email, m.phone].filter(Boolean).join(" · ") || "연락처 없음")}</div>
        </div>
        <form method="post" action="/settings/managers/${m.id}/delete" data-confirm="${esc(m.name)} (외주 작업자)를 삭제할까요?">
          <button class="btn-ghost btn-xs text-danger" type="submit">삭제</button>
        </form>
      </div>
    </div>`;
}

/** 작업 종류 카탈로그 행(삭제-only). 편집/삭제는 details 안. */
function taskTypeRow(t) {
  const groupLabel = TASK_GROUP_LABELS[t.task_group] || t.task_group;
  const billLabel = BILLING_TYPE_LABELS[t.billing_type] || t.billing_type;
  const priceLabel = t.unit_price ? formatKRW(t.unit_price) : "단가 미정";
  return `
    <div class="rounded-lg border border-border bg-bg p-3">
      <div class="flex items-start justify-between gap-3">
        <div class="min-w-0">
          <div class="flex flex-wrap items-center gap-2">
            <span class="font-medium">${esc(t.label)}</span>
            <span class="badge bg-bg text-muted">${esc(groupLabel)}</span>
            ${t.is_quick ? '<span class="badge bg-primary/10 text-primary">빠른추가</span>' : ""}
          </div>
          <div class="mt-0.5 text-xs text-muted">${esc(billLabel)} · ${priceLabel}</div>
        </div>
      </div>
      <details class="group mt-2 border-t border-border pt-2">
        <summary class="flex cursor-pointer list-none items-center justify-end text-xs text-muted hover:text-fg">${detailsChevron()}</summary>
        <form method="post" action="/settings/task-types/${t.id}" class="mt-2 space-y-2">
          <div class="grid gap-2 sm:grid-cols-2">
            <input class="input py-1.5 text-sm" name="label" value="${esc(t.label)}" required />
            <select class="input py-1.5 text-sm" name="task_group">
              ${TASK_GROUPS.map((g) => `<option value="${esc(g)}" ${g === t.task_group ? "selected" : ""}>${esc(TASK_GROUP_LABELS[g] || g)}</option>`).join("")}
            </select>
          </div>
          <div class="grid gap-2 sm:grid-cols-2">
            <select class="input py-1.5 text-sm" name="billing_type">
              ${BILLING_TYPES.map((b) => `<option value="${esc(b)}" ${b === t.billing_type ? "selected" : ""}>${esc(BILLING_TYPE_LABELS[b] || b)}</option>`).join("")}
            </select>
            <input class="input py-1.5 text-sm" name="unit_price" inputmode="numeric" value="${esc(String(t.unit_price || ""))}" placeholder="기본 단가(원)" />
          </div>
          <label class="flex items-center gap-2 text-sm text-muted"><input type="checkbox" name="is_quick" value="1" ${t.is_quick ? "checked" : ""} /> 빠른 추가 노출</label>
          <button class="btn-primary btn-xs" type="submit">저장</button>
        </form>
        <form method="post" action="/settings/task-types/${t.id}/delete" data-confirm="'${esc(t.label)}' 작업 종류를 삭제할까요? 이 종류로 만든 기존 작업은 유지되지만 종류명이 코드값으로 표시됩니다." class="mt-2">
          <button class="btn-ghost btn-xs text-danger" type="submit">삭제</button>
        </form>
      </details>
    </div>`;
}

module.exports = router;
