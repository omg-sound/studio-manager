"use strict";

const express = require("express");
const { db } = require("../db");
const { requireChief, requireStaff, isChief, syncUserToManager, findUserById } = require("../auth");
const { normalizeRole, config } = require("../config");
const {
  createRoom,
  deleteRoom,
  createRateItem,
  updateRateItem,
  deleteRateItem,
  createRateCategory,
  updateRateCategory,
  moveRateCategory,
  deleteRateCategory,
  createTaskType,
  updateTaskType,
  moveTaskType,
  deleteTaskType,
  setStudioInfo,
  setStudioLogo,
  setStudioHours,
  setProMinutes,
  setDefaultBooker,
  syncManagerToParty,
  ensurePartyForManager,
  ensurePartyForUser,
  formatPhone,
  getParty,
  setPartyGoogleRef,
} = require("../data");
const { layout, pageHeader, esc, flashBanner } = require("../views");
const {
  peopleTab,
  contentTab,
  driveStorageSection,
  studioCalendarSection,
  roomsSection,
  studioHoursSection,
  defaultBookerSection,
  studioInfoSection,
  alertWebhookSection,
  alertEmailSection,
  googleContactsSection,
  systemTab,
  systemWarnings,
  isBootstrapChief,
} = require("../views.settings");
const { asyncHandler } = require("../lib/async");
const { logAudit, listAudit } = require("../lib/audit"); // 파괴적·재무 액션 기록·열람(fail-safe)
const multer = require("multer");
const drive = require("../drive");
const { migrateLocalFilesToDrive, driveFileCount } = require("../lib/storage-migrate");

// 로고 업로드(작은 이미지) — 메모리 버퍼로 받아 base64 data URI로 저장. 2MB 제한.
const logoUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 2 * 1024 * 1024 } });
const calendar = require("../calendar");
const alerts = require("../notify");
const mailer = require("../mailer");
const { eventInputForSession } = require("./sessions.routes"); // 캘린더 재동기화 버튼 — 세션 캘린더 이벤트 입력(제목·설명) 재사용

const router = express.Router();

// 탭 순서·기본 탭 = 환경설정(2026-07-09 사용자 요청 — 이전 담당자 우선에서 전환).
const SETTINGS_TABS = [
  { key: "settings", label: "일반" },
  { key: "content", label: "콘텐츠" },
  { key: "people", label: "담당자" },
  { key: "system", label: "시스템" }, // 연동·백업·데이터 상태 + 감사 로그(2026-07-09 관리 개선) — 경고 있으면 라벨에 ⚠️
];

router.get("/", requireStaff, asyncHandler(async (req, res) => {
  const tab = SETTINGS_TABS.some((t) => t.key === req.query.tab) ? req.query.tab : "settings";
  const warnCount = systemWarnings().length; // 시스템 탭 경고 배지(백업 침묵·연동 꺼짐 등 — 조용한 장애 가시화)
  const tabBar = `<div class="mb-4 flex gap-1 overflow-x-auto border-b border-border">
      ${SETTINGS_TABS.map((t) => `<a href="/settings?tab=${t.key}" class="shrink-0 border-b-2 px-4 py-2 text-sm ${t.key === tab ? "border-primary font-semibold text-fg" : "border-transparent text-muted hover:text-fg"}">${esc(t.label)}${t.key === "system" && warnCount ? ` <span class="text-warning">⚠️${warnCount}</span>` : ""}</a>`).join("")}
    </div>`;

  let tabContent;
  if (tab === "people") tabContent = peopleTab(req.user);
  else if (tab === "content") tabContent = contentTab();
  else if (tab === "system") tabContent = systemTab(isChief(req.user));
  else {
    // 환경설정 = 성격별 4그룹(2026-07-09 관리 개선 — 8개 섹션 한 줄 스크롤이라 찾기 어렵던 것):
    // 스튜디오 운영 / 구글 연동 / 문서·청구 / 알림. 상단 앵커 네비로 점프.
    const groups = [
      { id: "ops", label: "스튜디오 운영", html: roomsSection() + studioHoursSection() + defaultBookerSection() },
      { id: "google", label: "구글 연동", html: (await studioCalendarSection(isChief(req.user))) + driveStorageSection() + googleContactsSection(isChief(req.user)) },
      { id: "docs", label: "문서 · 청구", html: studioInfoSection() },
      { id: "alerts", label: "알림", html: alertWebhookSection(isChief(req.user)) + alertEmailSection(isChief(req.user)) },
    ];
    const anchorNav = `<nav class="mb-1 flex flex-wrap gap-1.5" aria-label="환경설정 바로가기">
        ${groups.map((g) => `<a href="#set-${g.id}" class="badge badge-neutral hover:text-fg">${esc(g.label)}</a>`).join("")}
      </nav>`;
    // 그룹당 카드 1개(섹션은 SETTING_BLOCK border-t 구분) — 섹션마다 카드+큰 제목이라 자리를 너무 차지하던 것 압축(2026-07-09 사용자 요청).
    tabContent = anchorNav + groups
      .map((g) => `<div id="set-${g.id}" class="scroll-mt-4">
          <h2 class="mb-2 mt-5 border-b border-border pb-1.5 font-display text-base font-semibold">${esc(g.label)}</h2>
          <section class="card">${g.html}</section>
        </div>`)
      .join("");
  }

  const body = `
    ${flashBanner(req.query)}
    ${pageHeader({ title: "환경설정", desc: "일반 · 콘텐츠 · 담당자 · 시스템" })}
    ${tabBar}
    <div class="space-y-3">${tabContent}</div>`;

  res.send(layout({ title: "환경설정", user: req.user, current: "/settings", body })); // 읽기 폭(max-w-content 768) — 폼·설정 카드(2026-07-16 통일, 사용자 선택=읽기 폭. 1024→768 시선 집중)
}));

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
    ${pageHeader({ title: "Drive 폴더 점검", desc: "첨부·자료 파일이 저장되는 실제 구글 Drive 폴더", back: { href: "/settings?tab=settings", label: "환경설정" } })}
    ${card}`;
  res.send(layout({ title: "Drive 폴더 점검", user: req.user, current: "/settings", body }));
}));

// 로컬 저장 파일(client_files·deliverables)을 구글 Drive로 이관. Drive 연동 필요.
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
  const url = String(req.body.webhook_url || "").trim();
  let host = "해제";
  if (url) { try { host = new URL(url).host; } catch { host = "(형식 오류)"; } }
  logAudit(req.user, "settings.alert_webhook", host); // 외부로 나가는 채널 — URL 전체는 비밀이라 host만
  res.redirect("/settings?tab=settings&flash=saved");
});

router.post("/alert-webhook/test", requireChief, asyncHandler(async (req, res) => {
  await alerts.notify({ type: "test", title: "[테스트] OMG Studios 알림", text: "알림 채널이 정상 연결되었습니다." });
  res.redirect("/settings?tab=settings&flash=tested");
}));

// ── 청구 알림 이메일(2026-07-14) — 수신 주소 저장/테스트. 치프 전용(외부로 나가는 알림 채널). ──
router.post("/alert-email", requireChief, (req, res) => {
  const raw = String(req.body.alert_email || "");
  const bad = mailer.invalidRecipients(raw);
  if (bad.length) {
    const msg = `이메일 형식이 올바르지 않습니다: ${bad.slice(0, 3).join(", ")}`;
    return res.redirect("/settings?tab=settings&notice=" + encodeURIComponent(msg) + "&notice_warn=1");
  }
  mailer.setRecipients(raw);
  const to = mailer.getRecipients();
  // 청구 PII가 상시 나가는 채널이라 변경 이력을 남긴다(주소는 마스킹 — 감사 로그에 평문 금지).
  logAudit(req.user, "settings.alert_email", to.length ? to.map(mailer.maskEmail).join(", ") : "해제");
  res.redirect("/settings?tab=settings&flash=saved");
});

router.post("/alert-email/test", requireChief, asyncHandler(async (req, res) => {
  const r = await mailer.send({
    subject: "[테스트] OMG Studios 청구 알림",
    html: `<p>청구 알림 메일이 정상 연결되었습니다.</p><p style="font-size:12px;color:#6E6A5F">OMG Studios ERP에서 자동 발송된 알림입니다.</p>`,
  });
  const msg = r.ok
    ? `테스트 메일을 보냈습니다(${r.sent}명) — 수신함을 확인하세요.`
    : `테스트 메일 발송 실패: ${r.skipped === "not_linked" ? "구글 미연동" : r.skipped === "no_recipients" ? "수신 주소 없음" : "메일 권한을 확인하세요(스튜디오 계정 재로그인)"}`;
  res.redirect("/settings?tab=settings&notice=" + encodeURIComponent(msg) + (r.ok ? "" : "&notice_warn=1"));
}));

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
  res.redirect("/settings?tab=people&flash=saved"); // 기본 탭=환경설정으로 바뀌어(2026-07-09) 담당자 탭 명시 복귀
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
  if (target.role !== role) logAudit(req.user, "user.role", `${target.email} ${target.role} → ${role}`);
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
    logAudit(req.user, "user.delete", `${target.email} (${target.role})`);
  }
  res.redirect("/settings?tab=people&flash=deleted");
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

// 분류 순서 이동(위/아래) — 정렬 UI(2026-07-09 관리 개선). 잠긴 기본 분류도 순서는 이동 가능.
router.post("/rate-categories/:id/move", requireStaff, (req, res) => {
  moveRateCategory(Number(req.params.id), req.body.dir === "up" ? "up" : "down");
  res.redirect("/settings?tab=content");
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

// 작업 종류 순서 이동(위/아래) — 곡·콘텐츠 빠른추가·드롭다운 순서에 반영.
router.post("/task-types/:id/move", requireStaff, (req, res) => {
  moveTaskType(Number(req.params.id), req.body.dir === "up" ? "up" : "down");
  res.redirect("/settings?tab=content");
});

router.post("/task-types/:id/delete", requireStaff, (req, res) => {
  deleteTaskType(Number(req.params.id));
  res.redirect("/settings?tab=content&flash=deleted");
});

// ── 구글 연락처 일괄 내보내기(치프) ── 미연동(google_resource_name NULL) 연락처를 구글 주소록에 push(1회성, 2026-07-09 사용자 요청).
// 실패해도 계속(건별 fail-safe — people.createPerson이 null 반환·[people] 로그), 성공분만 resourceName/etag 기록. 재실행 멱등(연동분은 대상 제외).
router.post("/push-contacts", requireChief, asyncHandler(async (req, res) => {
  const people = require("../people");
  if (!people.peopleClient()) {
    return res.redirect("/settings?tab=settings&notice=" + encodeURIComponent("구글 연락처 미연동 — 치프 계정으로 재로그인(연락처 권한 동의) 후 다시 시도하세요.") + "&notice_warn=1");
  }
  const rows = db().prepare("SELECT id FROM parties WHERE kind='person' AND google_resource_name IS NULL ORDER BY id").all();
  let ok = 0, fail = 0;
  for (const r of rows) {
    const ref = await people.createPerson(getParty(r.id));
    if (ref) { setPartyGoogleRef(r.id, ref.resourceName, ref.etag); ok++; }
    else fail++;
  }
  const msg = `구글 내보내기 완료 — 성공 ${ok}명${fail ? ` · 실패 ${fail}명(서버 로그 확인)` : ""}`;
  res.redirect(`/settings?tab=settings&notice=${encodeURIComponent(msg)}${fail ? "&notice_warn=1" : ""}`);
}));

// ── 수동 DB 백업(치프, 2026-07-09 관리 개선) — cron과 동일 산출물(VACUUM INTO + uploads 스냅샷 + Drive 오프사이트 fail-safe).
router.post("/backup-now", requireChief, asyncHandler(async (req, res) => {
  const { backupDatabase, backupUploads } = require("../lib/maintenance");
  const drive = require("../drive");
  let notice, warn = false;
  try {
    const b = backupDatabase();
    try { backupUploads(); } catch (_e) { /* 첨부 스냅샷 실패는 비차단 */ }
    let off = "";
    if (drive.isLinked() && b && b.file) {
      try { await drive.backupToDrive(b.file); off = " · Drive 오프사이트 완료"; } catch (_e) { off = " · Drive 업로드 실패(로그 확인)"; warn = true; }
    }
    logAudit(req.user, "system.backup", (b && b.file ? require("path").basename(b.file) : "") + off.trim());
    notice = `백업 완료 — ${b && b.file ? require("path").basename(b.file) : "생성됨"}${off}`;
  } catch (e) {
    notice = `백업 실패: ${e.message}`; warn = true;
  }
  res.redirect(`/settings?tab=system&notice=${encodeURIComponent(notice)}${warn ? "&notice_warn=1" : ""}`);
}));

module.exports = router;
