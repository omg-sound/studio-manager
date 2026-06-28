"use strict";

const crypto = require("crypto");
const express = require("express");
const { db } = require("../db");
const { requireChief } = require("../auth");
const { config, ROLES, ROLE_LABELS, normalizeRole, RECORDING_CATEGORIES } = require("../config");
const {
  listProjectManagers,
  listProjectServiceItems,
  listRateItems,
  createRateItem,
  updateRateItem,
  setRateItemActive,
  deleteRateItem,
} = require("../data");
const { layout, pageHeader, esc, flashBanner, formatKRW } = require("../views");
const { asyncHandler } = require("../lib/async");
const drive = require("../drive");
const calendar = require("../calendar");

const router = express.Router();

/** 부트스트랩 치프(ADMIN_EMAIL)는 강등/비활성 불가 — 잠금 방지. */
function isBootstrapChief(user) {
  return Boolean(config.adminEmail) && user && user.email === config.adminEmail;
}

function listUsers() {
  return db().prepare("SELECT * FROM users ORDER BY active DESC, role, email").all();
}

router.get("/", requireChief, asyncHandler(async (req, res) => {
  const managers = listProjectManagers({ includeInactive: true });
  const serviceItems = listProjectServiceItems({ includeInactive: true });
  const calSection = await studioCalendarSection();

  const managerRows = managers.length
    ? managers.map((m) => managerRow(m)).join("")
    : `<div class="py-3 text-sm text-muted">담당자가 없습니다.</div>`;
  const serviceRows = serviceItems.length
    ? serviceItems.map((s) => serviceItemRow(s)).join("")
    : `<div class="py-3 text-sm text-muted">작업 템플릿이 없습니다.</div>`;

  const users = listUsers();
  const userRows = users.length
    ? users.map((u) => userRow(u, req.user)).join("")
    : `<div class="py-3 text-sm text-muted">등록된 사용자가 없습니다.</div>`;

  const rates = listRateItems({ includeInactive: true });
  const rateRows = rates.length
    ? rates.map((r) => rateItemRow(r)).join("")
    : `<div class="py-3 text-sm text-muted">등록된 단가 항목이 없습니다.</div>`;

  const body = `
    ${flashBanner(req.query)}
    ${pageHeader({ title: "관리", desc: "사용자 · 담당자 · 작업 템플릿" })}
    <div class="space-y-3">
      <section class="card space-y-4">
        <div>
          <h2 class="font-display text-lg font-semibold">사용자(로그인 계정)</h2>
          <p class="mt-1 text-xs text-muted">여기에 등록한 Google 계정만 로그인할 수 있습니다. 치프는 전체, 스태프는 프로젝트·작업·자료까지.</p>
        </div>
        <form method="post" action="/settings/users" class="space-y-2">
          <input class="input" type="email" name="email" placeholder="Google 이메일" required />
          <div class="flex gap-2">
            <select class="input" name="role">
              ${ROLES.map((r) => `<option value="${esc(r)}" ${r === "staff" ? "selected" : ""}>${esc(ROLE_LABELS[r] || r)}</option>`).join("")}
            </select>
            <button class="btn-primary shrink-0" type="submit">사용자 추가</button>
          </div>
        </form>
        <div class="space-y-2">${userRows}</div>
      </section>

      ${calSection}

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
          <button class="btn-primary px-3 py-1.5 text-sm" type="submit">단가 항목 추가</button>
        </form>
        <div class="space-y-2">${rateRows}</div>
      </section>

      <section class="card space-y-4">
        <div>
          <h2 class="font-display text-lg font-semibold">담당자</h2>
        </div>
        <form method="post" action="/settings/managers" class="space-y-2">
          <input class="input" name="name" placeholder="이름" required />
          <div class="grid gap-2 sm:grid-cols-2">
            <input class="input" name="email" placeholder="이메일" />
            <input class="input" name="phone" placeholder="전화번호" />
          </div>
          <button class="btn-primary w-full" type="submit">담당자 추가</button>
        </form>
        <div class="space-y-2">${managerRows}</div>
      </section>

      <section class="card space-y-4">
        <div>
          <h2 class="font-display text-lg font-semibold">작업 템플릿</h2>
        </div>
        <form method="post" action="/settings/service-items" class="flex gap-2">
          <input class="input" name="label" placeholder="예: 보컬 디렉팅" required />
          <button class="btn-primary shrink-0" type="submit">추가</button>
        </form>
        <div class="space-y-2">${serviceRows}</div>
      </section>
    </div>`;

  res.send(layout({ title: "관리", user: req.user, current: "/settings", body, full: true }));
}));

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
        <button class="btn-primary shrink-0 px-3 py-1.5 text-sm" type="submit">저장</button>
      </form>
    </div>`;
  return `<section class="card space-y-4">${title}${inner}${location}</section>`;
}

// ── 스튜디오 캘린더 선택 저장 ──
router.post("/studio-calendar", requireChief, (req, res) => {
  calendar.setStudioCalendarId(req.body.calendar_id);
  res.redirect("/settings?flash=saved");
});

// ── 예약 일정 기본 장소 저장 ──
router.post("/studio-location", requireChief, (req, res) => {
  calendar.setStudioLocation(req.body.studio_location);
  res.redirect("/settings?flash=saved");
});

// ── 사용자(로그인 화이트리스트) 관리 ──
router.post("/users", requireChief, (req, res) => {
  const email = String(req.body.email || "").trim().toLowerCase();
  const role = normalizeRole(req.body.role);
  if (email && /^\S+@\S+\.\S+$/.test(email)) {
    const exists = db().prepare("SELECT id FROM users WHERE email = ?").get(email);
    if (exists) {
      db().prepare("UPDATE users SET role = ?, active = 1 WHERE id = ?").run(role, exists.id);
    } else {
      db().prepare("INSERT INTO users (email, role, name, active) VALUES (?, ?, '', 1)").run(email, role);
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

router.post("/users/:id/deactivate", requireChief, (req, res) => {
  const id = Number(req.params.id);
  const target = db().prepare("SELECT * FROM users WHERE id = ?").get(id);
  if (target && !isBootstrapChief(target) && target.id !== req.user.id) {
    db().prepare("UPDATE users SET active = 0 WHERE id = ?").run(id);
  }
  res.redirect("/settings?flash=saved");
});

router.post("/users/:id/activate", requireChief, (req, res) => {
  db().prepare("UPDATE users SET active = 1 WHERE id = ?").run(Number(req.params.id));
  res.redirect("/settings?flash=saved");
});

// ── 단가표(과금 항목) 관리 ──
router.post("/rate-items", requireChief, (req, res) => {
  try {
    createRateItem(req.body);
  } catch (e) {
    if (e.message !== "RATE_NAME_REQUIRED") throw e;
  }
  res.redirect("/settings?flash=saved");
});

router.post("/rate-items/:id", requireChief, (req, res) => {
  try {
    updateRateItem(Number(req.params.id), req.body);
  } catch (e) {
    if (e.message !== "RATE_NAME_REQUIRED") throw e;
  }
  res.redirect("/settings?flash=saved");
});

router.post("/rate-items/:id/toggle", requireChief, (req, res) => {
  setRateItemActive(Number(req.params.id), req.body.active === "1");
  res.redirect("/settings?flash=saved");
});

router.post("/rate-items/:id/delete", requireChief, (req, res) => {
  deleteRateItem(Number(req.params.id));
  res.redirect("/settings?flash=deleted");
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

router.post("/managers/:id/deactivate", requireChief, (req, res) => {
  db().prepare("UPDATE project_managers SET active = 0 WHERE id = ?").run(Number(req.params.id));
  res.redirect("/settings?flash=saved");
});

router.post("/managers/:id/activate", requireChief, (req, res) => {
  db().prepare("UPDATE project_managers SET active = 1 WHERE id = ?").run(Number(req.params.id));
  res.redirect("/settings?flash=saved");
});

router.post("/service-items", requireChief, (req, res) => {
  const label = String(req.body.label || "").trim();
  if (label) {
    const key = `custom_${crypto.randomBytes(5).toString("hex")}`;
    db()
      .prepare("INSERT INTO project_service_items (key, label, active) VALUES (?, ?, 1)")
      .run(key, label);
  }
  res.redirect("/settings?flash=saved");
});

router.post("/service-items/:id/deactivate", requireChief, (req, res) => {
  db().prepare("UPDATE project_service_items SET active = 0 WHERE id = ?").run(Number(req.params.id));
  res.redirect("/settings?flash=saved");
});

router.post("/service-items/:id/activate", requireChief, (req, res) => {
  db().prepare("UPDATE project_service_items SET active = 1 WHERE id = ?").run(Number(req.params.id));
  res.redirect("/settings?flash=saved");
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
  const toggle = locked
    ? ""
    : u.active
      ? toggleForm(`/settings/users/${u.id}/deactivate`, "비활성")
      : toggleForm(`/settings/users/${u.id}/activate`, "활성");
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
          ${toggle}
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
        <div class="flex shrink-0 items-center gap-1">
          <form method="post" action="/settings/rate-items/${r.id}/toggle">
            <input type="hidden" name="active" value="${r.active ? "0" : "1"}" />
            <button class="btn-ghost px-3 py-1 text-xs" type="submit">${r.active ? "비활성" : "활성"}</button>
          </form>
        </div>
      </div>
      <details class="mt-2 border-t border-border pt-2">
        <summary class="cursor-pointer list-none text-xs text-muted hover:text-fg">편집 / 삭제</summary>
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
          <button class="btn-primary px-3 py-1.5 text-xs" type="submit">저장</button>
        </form>
        <form method="post" action="/settings/rate-items/${r.id}/delete" data-confirm="이 단가 항목을 삭제할까요?" class="mt-2">
          <button class="btn-ghost px-3 py-1.5 text-xs text-danger" type="submit">삭제</button>
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
        ${toggleForm(`/settings/managers/${m.id}/${m.active ? "deactivate" : "activate"}`, m.active ? "비활성" : "활성")}
      </div>
    </div>`;
}

function serviceItemRow(s) {
  return `
    <div class="rounded-lg border border-border bg-bg p-3">
      <div class="flex items-center justify-between gap-3">
        <div>
          <div class="font-medium">${esc(s.label)}</div>
          <div class="mt-0.5 text-xs text-muted">${s.active ? "사용 중" : "비활성"}</div>
        </div>
        ${toggleForm(`/settings/service-items/${s.id}/${s.active ? "deactivate" : "activate"}`, s.active ? "비활성" : "활성")}
      </div>
    </div>`;
}

function toggleForm(action, label) {
  return `
    <form method="post" action="${action}">
      <button class="btn-ghost px-3 py-1.5 text-xs" type="submit">${label}</button>
    </form>`;
}

module.exports = router;
