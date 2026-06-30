"use strict";

const express = require("express");
const { db } = require("../db");
const { requireAuth, requireEditor, requireChief, requireBilling, canEdit, canBill } = require("../auth");
const {
  TASK_GROUP_LABELS,
  TASK_STATUSES,
  TASK_STATUS_LABELS,
  TASK_STATUS_BADGE,
  normalizeProjectType,
} = require("../config");
const { config } = require("../config");
const {
  listProjects,
  distinctProjectFields,
  getProjectForUser,
  deleteProject,
  clientOptions,
  contactOptions,
  ensureClientsFromProject,
  listProjectManagers,
  listRateItems,
  activeTaskTypes,
  taskTypeLabel,
  taskTypeGroup,
  listDeliverablesForProject,
  listInvoicesForProject,
  listTracksForProject,
  listUnbilledTasksForProject,
  listBillableSessionsForProject,
  listSessionsForProject,
  createTrack,
  updateTrack,
  deleteTrack,
  createTask,
  updateTask,
  deleteTask,
  createInvoiceFromTasks,
  createContact,
} = require("../data");
const { layout, pageHeader, esc, formatKRW, flashBanner, errorPage, emptyState, detailsChevron, listGroup, listRow } = require("../views");
const { deliverablesSection } = require("../views.deliverables");
const { invoicesSection } = require("../views.invoices");
const { sessionsSection } = require("../views.sessions");
const { isValidYmd, formatYmdShort, todayYmd } = require("../lib/date");
const { parseMoney } = require("../lib/forms");
const { notifyInvoiceIssued } = require("../notify");

const router = express.Router();

function cleanYmd(v) {
  const s = String(v || "").trim();
  return isValidYmd(s) ? s : null;
}

/** 프로젝트 저장 정보로 청구처를 우선순위(제작사>소속사/레이블>아티스트)로 자동 선택. ensureClientsFromProject 후 호출. */
function resolveAutoClientId(b) {
  const candidates = [
    [String(b.production_company || "").trim(), "제작사"],
    [String(b.artist_company || "").trim(), "소속사/레이블"],
    [String(b.artist || "").trim(), "아티스트"],
  ];
  for (const [name, kind] of candidates) {
    if (!name) continue;
    const c = db().prepare("SELECT id FROM clients WHERE name = ? AND kind = ?").get(name, kind);
    if (c) return c.id;
  }
  return null;
}

function toArray(value) {
  if (value == null || value === "") return [];
  return Array.isArray(value) ? value : [value];
}

/** 고객측 담당자: contact_id(목록에서 선택) 우선, 없고 contact_name(목록 외 새 이름)만 있으면 이름으로 새 연락처 생성·연결. */
function resolveContactId(b) {
  if (b.contact_id) return Number(b.contact_id);
  const name = String(b.contact_name || "").trim();
  if (!name) return null;
  return createContact({ name });
}

// ── 목록(URL = 필터; 플레이북2 §3.7) ──
router.get("/", requireAuth, (req, res) => {
  const user = req.user;
  const canCreate = canEdit(user); // 대표(열람전용)는 새 프로젝트 버튼 숨김
  const q = (req.query.q || "").toString().trim();
  const rows = listProjects(user, { q });

  const searched = Boolean(q);
  const list = rows.length
    ? listGroup({ rows: rows.map(projectListRow) })
    : searched
      ? emptyState(`"${esc(q)}" 검색 결과가 없습니다.`, { card: true })
      : emptyState("프로젝트가 없습니다.", { card: true, icon: "projects", cta: canCreate ? { href: "/projects/new", label: "+ 새 프로젝트" } : null });

  const action = canCreate ? newProjectMenu() : "";

  const searchBar = `
    <form method="get" action="/projects" class="mb-4 flex gap-2">
      <input class="input min-w-0 flex-1" type="search" name="q" value="${esc(q)}" placeholder="프로젝트 · 아티스트 검색" aria-label="프로젝트 검색" />
      <button class="btn-primary shrink-0" type="submit">검색</button>
    </form>`;
  const resultNote = searched
    ? `<div class="mb-3 text-sm text-muted">"${esc(q)}" 결과 ${rows.length}건 · <a href="/projects" class="text-primary hover:underline">전체 보기</a></div>`
    : "";

  const body = `
    ${pageHeader({ title: "프로젝트", desc: "전체 프로젝트", action })}
    ${searchBar}
    ${resultNote}
    ${list}`;
  res.send(layout({ title: "프로젝트", user, current: "/projects", body }));
});

/** "+ 새 프로젝트" 버튼 — 유형 구분 없이 단일 진입(모든 프로젝트가 세션 일정+곡·콘텐츠 동일). */
function newProjectMenu() {
  return `<a href="/projects/new" class="btn-primary">+ 새 프로젝트</a>`;
}

/** 프로젝트의 항목(트랙) 개수. track_titles("||" 연결)에서 파생. */
function trackCount(p) {
  if (!p || !p.track_titles) return 0;
  return String(p.track_titles).split("||").map((s) => s.trim()).filter(Boolean).length;
}

/** 목록 행(listGroup 안 listRow): 제목 / 메타(아티스트·클라이언트) / 곡수 — 우측 금액·D-day(tabular). */
function projectListRow(p) {
  const metaLine = [p.artist, p.client_name, p.manager_name, contactMetaPart(p)].filter(Boolean).join(" · ") || "정보 미정";
  const n = trackCount(p);
  const left = `
    <div class="truncate font-semibold">${esc(p.title)}</div>
    <div class="mt-0.5 truncate text-sm text-fg/80">${esc(metaLine)}</div>
    <div class="mt-0.5 text-xs text-muted">${n ? `곡·콘텐츠 ${n}` : "곡·콘텐츠 미정"}</div>`;
  const amount = projectAmount(p)
    ? `<div class="text-sm font-medium tabular">${formatKRW(projectAmount(p))}</div>`
    : `<div class="text-sm text-muted">견적 미정</div>`;
  return listRow({ href: `/projects/${p.id}`, left, right: amount });
}

// ── 새 프로젝트 폼(관리자) — 유형 구분 없음(모든 신규=세션 취급) ──
router.get("/new", requireEditor, (req, res) => {
  res.send(layout({ title: "새 프로젝트", user: req.user, current: "/projects", body: projectForm() }));
});

// ── 생성(관리자) ──
router.post("/", requireEditor, (req, res) => {
  const b = req.body;
  const title = String(b.title || "").trim();
  const type = normalizeProjectType(b.project_type);
  if (!title) return res.send(layout({ title: "새 프로젝트", user: req.user, current: "/projects", body: projectForm({ ...b, project_type: type, _err: "프로젝트 명을 입력하세요." }) }));
  const info = db()
    .prepare(
      `INSERT INTO projects (title, project_type, artist, artist_company, production_company, client_id, manager_id, contact_id, memo)
       VALUES (@title, @project_type, @artist, @artist_company, @production_company, @client_id, @manager_id, @contact_id, @memo)`
    )
    .run({
      title,
      project_type: type,
      artist: String(b.artist || "").trim() || null,
      artist_company: String(b.artist_company || "").trim() || null,
      production_company: String(b.production_company || "").trim() || null,
      client_id: null,
      manager_id: b.manager_id ? Number(b.manager_id) : null,
      contact_id: resolveContactId(b),
      memo: String(b.memo || "").trim() || null,
    });
  ensureClientsFromProject(b); // 아티스트·소속사/레이블·제작사를 클라이언트 마스터에 자동 등록
  // 청구처는 메타 폼에서 받지 않고 항상 우선순위(제작사>소속사/레이블>아티스트)로 자동 파생
  const autoId = resolveAutoClientId(b);
  if (autoId) db().prepare("UPDATE projects SET client_id = ? WHERE id = ?").run(autoId, info.lastInsertRowid);
  res.redirect(`/projects/${info.lastInsertRowid}?flash=created`);
});

// ── 상세 ──
router.get("/:id", requireAuth, (req, res) => {
  const p = getProjectForUser(req.user, Number(req.params.id));
  if (!p) return res.status(404).send(errorPage({ code: 404, title: "프로젝트를 찾을 수 없습니다", message: "삭제되었거나 주소가 잘못되었습니다.", user: req.user }));
  renderProjectDetail(req, res, p);
});

// ── 프로젝트 삭제 (치프 전용) ──
router.post("/:id/delete", requireChief, (req, res) => {
  const p = getProjectForUser(req.user, Number(req.params.id));
  if (!p) return res.status(404).send(errorPage({ code: 404, title: "프로젝트를 찾을 수 없습니다", message: "삭제되었거나 주소가 잘못되었습니다.", user: req.user }));
  try {
    deleteProject(p.id);
  } catch (e) {
    if (e.message === "PROJECT_HAS_INVOICED") {
      return res.status(409).send(errorPage({ code: 409, title: "청구된 프로젝트는 삭제할 수 없습니다", message: "이 프로젝트에 청구된 작업·세션이 있습니다. 먼저 관련 청구서를 삭제한 뒤 다시 시도하세요(매출 추적 보존).", user: req.user }));
    }
    throw e;
  }
  res.redirect("/projects?flash=deleted");
});

function renderProjectDetail(req, res, p, formState = null, err = "") {
  const editable = canEdit(req.user); // 치프/스태프는 편집, 대표는 열람 전용
  const showInvoice = canBill(req.user); // 청구 섹션=치프·대표·스태프(청구서 발행)
  const managers = editable ? listProjectManagers() : []; // 작업·세션 엔지니어 선택용(담당자 마스터)

  const meta = editable
    ? projectMetaCard({ ...p, ...(formState || {}) }, err)
    : projectMetaReadonly(p);

  const desc = p.artist || p.client_name || "프로젝트";

  // ── 탭: 프로젝트 / 세션 일정 / 곡·콘텐츠 / 자료 전달 / 청구(청구권자만) ──
  // 메타 카드는 '프로젝트' 탭(첫 탭·기본). 유형 구분 없이 모든 프로젝트가 세션 일정 탭을 가진다.
  const tabs = [{ key: "project", label: "프로젝트" }];
  tabs.push({ key: "sessions", label: "세션 일정" });
  tabs.push({ key: "tracks", label: "곡 · 콘텐츠" });
  if (editable) tabs.push({ key: "deliverables", label: "자료 전달" }); // 자료 전달은 편집자(치프·스태프)만, 대표 제외
  if (showInvoice) tabs.push({ key: "invoice", label: "청구" });
  const validKeys = tabs.map((t) => t.key);
  const defaultTab = "project";
  const tab = validKeys.includes(req.query.tab) ? req.query.tab : defaultTab;
  const tabBar = `<div class="mb-3 mt-3 flex gap-1 overflow-x-auto border-b border-border">
      ${tabs.map((t) => `<a href="/projects/${p.id}?tab=${t.key}" class="shrink-0 border-b-2 px-4 py-2 text-sm ${t.key === tab ? "border-primary font-semibold text-fg" : "border-transparent text-muted hover:text-fg"}">${esc(t.label)}</a>`).join("")}
    </div>`;

  let tabContent = "";
  if (tab === "project") {
    tabContent = meta;
  } else if (tab === "tracks") {
    const trackBundle = listTracksForProject(req.user, p.id);
    tabContent = tracksSection({ project: p, tracks: trackBundle ? trackBundle.tracks : [], isAdmin: editable, managers, expandTaskId: Number(req.query.expand) || null });
  } else if (tab === "deliverables" && editable) {
    const deliv = listDeliverablesForProject(req.user, p.id);
    tabContent = deliverablesSection({ project: p, rows: deliv ? deliv.rows : [], isAdmin: editable, baseUrl: config.baseUrl, collapsed: false });
  } else if (tab === "invoice" && showInvoice) {
    const inv = listInvoicesForProject(req.user, p.id);
    const unbilled = listUnbilledTasksForProject(req.user, p.id);
    const unbilledRows = unbilled ? unbilled.rows : [];
    const billable = listBillableSessionsForProject(req.user, p.id);
    const sessionRows = billable ? billable.rows : [];
    const unbilledForm = (unbilledRows.length || sessionRows.length) ? unbilledInvoiceForm(p, unbilledRows, sessionRows) : "";
    tabContent = invoicesSection({ project: p, rows: inv ? inv.rows : [], isAdmin: showInvoice, collapsed: false, unbilledForm, unbilledCount: unbilledRows.length + sessionRows.length });
  } else {
    const rateItems = editable ? listRateItems() : [];
    const sessionBundle2 = listSessionsForProject(req.user, p.id);
    tabContent = sessionsSection({ project: p, rows: sessionBundle2 ? sessionBundle2.rows : [], isAdmin: editable, managers, rateItems });
  }

  const errorModal = req.query.error === "session_invoiced" ? sessionInvoicedModal(p.id) : "";
  const body = [flashBanner(req.query), errorModal, pageHeader({ title: p.title, desc, back: { href: "/projects", label: "프로젝트" } }), tabBar, tabContent].join("\n");
  res.send(layout({ title: p.title, user: req.user, current: "/projects", body }));
}

/** 청구된 세션 수정·삭제 차단 모달(?error=session_invoiced). app.js의 '확인'(data-modal-close)으로 닫는다. */
function sessionInvoicedModal(projectId) {
  return `
    <div data-modal class="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
      <div class="card w-full max-w-md">
        <h3 class="font-display text-base font-semibold">청구된 세션</h3>
        <p class="mt-2 text-sm text-muted">이미 청구된 세션은 수정·삭제할 수 없습니다. 인보이스를 삭제한 뒤 다시 시도하세요.</p>
        <div class="mt-4 flex justify-end gap-2">
          <a href="/projects/${projectId}?tab=invoice" class="btn-ghost btn-sm">청구 화면으로</a>
          <button class="btn-primary btn-sm" type="button" data-modal-close>확인</button>
        </div>
      </div>
    </div>`;
}

/** 메타 라인용 클라이언트 담당자 표기: "이름 (전화)" 또는 "이름", 없으면 null(filter(Boolean)로 제외). */
function contactMetaPart(p) {
  if (!p.contact_name) return null;
  return p.contact_phone ? `${p.contact_name} (${p.contact_phone})` : p.contact_name;
}

/** 메타 한 줄 요약(아티스트 · 거래처 · 담당자 / 견적 · 완료일). */
function projectMetaLine(p) {
  const left = [p.artist, p.client_name, p.manager_name, contactMetaPart(p)].filter(Boolean).join(" · ") || "정보 미정";
  const amount = projectAmount(p)
    ? `<div class="text-sm font-semibold">${formatKRW(projectAmount(p))}</div>`
    : `<div class="text-sm text-muted">견적 미정</div>`;
  return { left: esc(left), amount };
}

/** 클라이언트(읽기 전용) 메타 카드. */
function projectMetaReadonly(p) {
  const { left, amount } = projectMetaLine(p);
  const extra = [
    p.artist_company ? `소속사 ${esc(p.artist_company)}` : "",
    p.production_company ? `제작사 ${esc(p.production_company)}` : "",
  ].filter(Boolean).join(" · ");
  return `
    <div class="card">
      <div class="flex items-center justify-between gap-3">
        <div class="min-w-0 text-sm text-muted">${left}</div>
        <div class="shrink-0 text-right">${amount}</div>
      </div>
      ${extra ? `<div class="mt-1 text-xs text-muted">${extra}</div>` : ""}
      ${p.memo ? `<div class="mt-2 whitespace-pre-wrap border-t border-border pt-2 text-sm">${esc(p.memo)}</div>` : ""}
    </div>`;
}

/** 관리자 메타 카드(프로젝트 탭): 편집 폼을 항상 펼쳐서 표시(접기 없음 — 한 프로젝트만 보이므로). */
function projectMetaCard(p, err = "") {
  return `
    <div class="card">
      ${projectEditForm(p, err)}
      <div class="mt-4 border-t border-border pt-4">
        <form method="post" action="/projects/${p.id}/delete" data-confirm="프로젝트를 삭제하면 세션·곡·콘텐츠·자료가 모두 삭제됩니다. 정말 삭제할까요?">
          <button class="btn-ghost btn-xs text-danger" type="submit">프로젝트 삭제</button>
        </form>
      </div>
    </div>`;
}

function projectAmount(project) {
  const task = Number(project.task_total || 0);
  const sess = Number(project.session_amount_total || 0);
  const combined = task + sess;
  return combined || Number(project.rate || 0) || 0;
}

// ── 예전 수정 URL은 상세 편집 화면으로 정규화 ──
router.get("/:id/edit", requireEditor, (req, res) => {
  res.redirect(`/projects/${Number(req.params.id)}`);
});

// ── 수정 저장(관리자) ──
router.post("/:id", requireEditor, (req, res) => {
  const id = Number(req.params.id);
  const exists = db().prepare("SELECT id FROM projects WHERE id = ?").get(id);
  if (!exists) return res.status(404).send(errorPage({ code: 404, title: "프로젝트를 찾을 수 없습니다", message: "삭제되었거나 주소가 잘못되었습니다.", user: req.user }));
  const b = req.body;
  const title = String(b.title || "").trim();
  if (!title) {
    const p = getProjectForUser(req.user, id);
    return renderProjectDetail(req, res, p, { ...b, id }, "프로젝트 명을 입력하세요.");
  }
  // project_type은 UPDATE에서 제외 → 기존 DB 값 보존(유형 구분은 UI에서 제거, 레거시 컬럼은 건드리지 않음).
  ensureClientsFromProject(b); // 아티스트·소속사/레이블·제작사를 클라이언트 마스터에 자동 등록
  // 청구처는 메타 폼에서 받지 않고 항상 우선순위(제작사>소속사/레이블>아티스트)로 자동 파생(생성과 동일)
  db()
    .prepare(
      `UPDATE projects SET title=@title, artist=@artist, artist_company=@artist_company,
       production_company=@production_company, client_id=@client_id, manager_id=@manager_id,
       contact_id=@contact_id, memo=@memo WHERE id=@id`
    )
    .run({
      id,
      title,
      artist: String(b.artist || "").trim() || null,
      artist_company: String(b.artist_company || "").trim() || null,
      production_company: String(b.production_company || "").trim() || null,
      client_id: resolveAutoClientId(b),
      manager_id: b.manager_id ? Number(b.manager_id) : null,
      contact_id: resolveContactId(b),
      memo: String(b.memo || "").trim() || null,
    });
  res.redirect(`/projects/${id}?flash=saved`);
});

router.post("/:id/tracks", requireEditor, (req, res) => {
  const projectId = Number(req.params.id);
  // titles(textarea 다건) 또는 title(단건 하위호환) 모두 지원
  const raw = String(req.body.titles || req.body.title || "");
  const titles = raw.split("\n").map((s) => s.trim()).filter(Boolean);
  if (!titles.length) {
    return res.status(400).send(errorPage({ code: 400, title: "이름 필요", message: "곡·콘텐츠 이름을 입력하세요.", user: req.user }));
  }
  let lastTrack = null;
  for (const title of titles) {
    const track = createTrack(req.user, projectId, { title });
    if (!track) return res.status(404).send(errorPage({ code: 404, title: "프로젝트를 찾을 수 없습니다", message: "삭제되었거나 주소가 잘못되었습니다.", user: req.user }));
    lastTrack = track;
  }
  res.redirect(`/projects/${lastTrack.project_id}?tab=tracks&flash=added`);
});

router.post("/tracks/:trackId", requireEditor, (req, res) => {
  try {
    const track = updateTrack(req.user, Number(req.params.trackId), req.body);
    if (!track) return res.status(404).send(errorPage({ code: 404, title: "곡·콘텐츠를 찾을 수 없습니다", message: "삭제되었거나 주소가 잘못되었습니다.", user: req.user }));
    res.redirect(`/projects/${track.project_id}?tab=tracks&flash=saved`);
  } catch (e) {
    if (e.message === "TRACK_TITLE_REQUIRED") return res.status(400).send(errorPage({ code: 400, title: "이름 필요", message: "곡·콘텐츠 이름을 입력하세요.", user: req.user }));
    throw e;
  }
});

router.post("/tracks/:trackId/delete", requireEditor, (req, res) => {
  try {
    const result = deleteTrack(req.user, Number(req.params.trackId));
    if (!result) return res.status(404).send(errorPage({ code: 404, title: "곡·콘텐츠를 찾을 수 없습니다", message: "삭제되었거나 주소가 잘못되었습니다.", user: req.user }));
    res.redirect(`/projects/${result.project_id}?tab=tracks&flash=deleted`);
  } catch (e) {
    if (e.message === "TRACK_HAS_INVOICED") {
      return res.status(400).send(errorPage({ code: 400, title: "삭제 불가", message: "이미 청구된 작업이 있는 곡·콘텐츠는 삭제할 수 없습니다.", user: req.user }));
    }
    throw e;
  }
});

router.post("/tracks/:trackId/tasks", requireEditor, (req, res) => {
  const task = createTask(req.user, Number(req.params.trackId), req.body);
  if (!task) return res.status(404).send(errorPage({ code: 404, title: "곡·콘텐츠를 찾을 수 없습니다", message: "삭제되었거나 주소가 잘못되었습니다.", user: req.user }));
  const track = db().prepare("SELECT project_id FROM project_tracks WHERE id = ?").get(task.track_id);
  res.redirect(track ? `/projects/${track.project_id}?tab=tracks&flash=added&expand=${task.id}#task-${task.id}` : "/projects");
});

router.post("/tasks/:taskId", requireEditor, (req, res) => {
  try {
    const task = updateTask(req.user, Number(req.params.taskId), req.body);
    if (!task) return res.status(404).send(errorPage({ code: 404, title: "작업을 찾을 수 없습니다", message: "삭제되었거나 주소가 잘못되었습니다.", user: req.user }));
    if (req.get("X-Requested-With") === "fetch") {
      // 자동저장(AJAX): 리다이렉트 대신 갱신된 헤더값 JSON 반환(금액·상태 배지).
      return res.json({ ok: true, amount: task.total_price ? formatKRW(task.total_price) : "", statusLabel: TASK_STATUS_LABELS[task.status] || task.status, statusCls: TASK_STATUS_BADGE[task.status] || "bg-muted/10 text-muted" });
    }
    res.redirect(`/projects/${task.project_id}?tab=tracks&flash=saved`);
  } catch (e) {
    if (e.message === "TASK_LOCKED") return res.status(400).send(errorPage({ code: 400, title: "수정 불가", message: "이미 청구된 작업은 수정할 수 없습니다.", user: req.user }));
    throw e;
  }
});

router.post("/tasks/:taskId/delete", requireEditor, (req, res) => {
  try {
    const result = deleteTask(req.user, Number(req.params.taskId));
    if (!result) return res.status(404).send(errorPage({ code: 404, title: "작업을 찾을 수 없습니다", message: "삭제되었거나 주소가 잘못되었습니다.", user: req.user }));
    res.redirect(`/projects/${result.project_id}?tab=tracks&flash=deleted`);
  } catch (e) {
    if (e.message === "TASK_LOCKED") return res.status(400).send(errorPage({ code: 400, title: "삭제 불가", message: "이미 청구된 작업은 삭제할 수 없습니다.", user: req.user }));
    throw e;
  }
});

router.post("/:id/invoices/from-tasks", requireBilling, (req, res) => {
  try {
    const inv = createInvoiceFromTasks(req.user, {
      projectId: Number(req.params.id),
      taskIds: toArray(req.body.task_id),
      sessionIds: toArray(req.body.session_id),
      clientId: req.body.client_id ? Number(req.body.client_id) : null,
      title: req.body.title,
      issueDate: cleanYmd(req.body.issued_date),
      dueDate: cleanYmd(req.body.due_date),
      discount: parseMoney(req.body.discount_amount),
      vatIncluded: req.body.vat_included != null, // 부가세 포함 체크박스(기본 체크) — 해제 시 미전송 → false(현금 거래)
    });
    if (!inv) return res.status(404).send(errorPage({ code: 404, title: "프로젝트를 찾을 수 없습니다", message: "삭제되었거나 주소가 잘못되었습니다.", user: req.user }));
    // createInvoiceFromTasks는 즉시 '발행' 상태로 생성 → 발행 알림 발송(notify는 fail-safe·비차단, 청구 흐름 비차단).
    notifyInvoiceIssued(inv);
    res.redirect(`/invoices/${inv.id}?flash=created`);
  } catch (e) {
    const known = { TASK_IDS_REQUIRED: "청구할 작업·세션을 선택하세요.", TASK_NOT_BILLABLE: "청구 가능한 작업·세션만 선택할 수 있습니다." };
    if (!known[e.message]) throw e; // 알 수 없는 오류(DB 등)는 전역 핸들러(500+로깅)로 — 검증 실패로 위장 방지
    return res.status(400).send(errorPage({ code: 400, title: "청구 오류", message: known[e.message], user: req.user }));
  }
});

// ── 폼 렌더 ──
function projectForm(p = {}, err = "") {
  const e = err || p._err || "";
  const action = "/projects";
  return `
    ${pageHeader({ title: "새 프로젝트" })}
    <form method="post" action="${action}" class="card space-y-3">
      <input type="hidden" name="project_type" value="session" />
      ${e ? `<p class="rounded-lg bg-danger/10 px-3 py-2 text-sm text-danger">${esc(e)}</p>` : ""}
      <div>
        <label class="label">프로젝트 명</label>
        <input class="input" name="title" value="${esc(p.title || "")}" placeholder="예: OOO 세션 (가제)" required />
      </div>
      <div class="grid gap-3 sm:grid-cols-3">
        <div>
          <label class="label">아티스트</label>
          <input class="input" name="artist" value="${esc(p.artist || "")}" list="dl-artists" autocomplete="off" />
        </div>
        <div>
          <label class="label">소속사/레이블</label>
          <input class="input" name="artist_company" value="${esc(p.artist_company || "")}" list="dl-companies" autocomplete="off" />
        </div>
        <div>
          <label class="label">제작사</label>
          <input class="input" name="production_company" value="${esc(p.production_company || "")}" list="dl-productions" autocomplete="off" />
        </div>
      </div>
      <div>
        <label class="label">고객측 담당자</label>
        ${contactCombo(p.contact_id)}
      </div>
      <div>
        <label class="label">담당 엔지니어</label>
        ${managerSelect(p.manager_id)}
      </div>
      <div>
        <label class="label">메모</label>
        <textarea class="input" name="memo" rows="3" placeholder="비고">${esc(p.memo || "")}</textarea>
      </div>
      ${projectFieldDatalists()}
      <div class="flex gap-2">
        <button class="btn-primary" type="submit">추가</button>
        <a href="/projects" class="btn-ghost">취소</a>
      </div>
    </form>`;
}

function projectEditForm(p = {}, err = "") {
  return `
    <form method="post" action="/projects/${p.id}" class="space-y-3">
      ${err ? `<p class="rounded-lg bg-danger/10 px-3 py-2 text-sm text-danger">${esc(err)}</p>` : ""}
      <div class="grid gap-3 sm:grid-cols-2">
        <div>
          <label class="label">프로젝트 명</label>
          <input class="input" name="title" value="${esc(p.title || "")}" required />
        </div>
        <div>
          <label class="label">아티스트</label>
          <input class="input" name="artist" value="${esc(p.artist || "")}" list="dl-artists" autocomplete="off" />
        </div>
      </div>
      <div class="grid gap-3 sm:grid-cols-2">
        <div>
          <label class="label">소속사/레이블</label>
          <input class="input" name="artist_company" value="${esc(p.artist_company || "")}" list="dl-companies" autocomplete="off" />
        </div>
        <div>
          <label class="label">제작사</label>
          <input class="input" name="production_company" value="${esc(p.production_company || "")}" list="dl-productions" autocomplete="off" />
        </div>
      </div>
      <div>
        <label class="label">고객측 담당자</label>
        ${contactCombo(p.contact_id)}
      </div>
      <div>
        <label class="label">담당 엔지니어</label>
        ${managerSelect(p.manager_id)}
      </div>
      <div>
        <label class="label">메모</label>
        <textarea class="input" name="memo" rows="3">${esc(p.memo || "")}</textarea>
      </div>
      ${projectFieldDatalists()}
      <div class="flex justify-end">
        <button class="btn-primary" type="submit">저장</button>
      </div>
    </form>`;
}

/** 아티스트·소속사/레이블·제작사 자동완성 datalist(기존 프로젝트 값 기반). */
function projectFieldDatalists() {
  const f = distinctProjectFields();
  const dl = (id, values) => `<datalist id="${id}">${values.map((v) => `<option value="${esc(v)}"></option>`).join("")}</datalist>`;
  return dl("dl-artists", f.artists) + dl("dl-companies", f.companies) + dl("dl-productions", f.productions);
}

/** 청구처 콤보 라벨: "이름 · 분류"(분류로 동명 구분, 검색 시 분류로도 좁혀짐). */
function clientComboLabel(c) {
  return c.kind ? `${c.name} · ${c.kind}` : c.name;
}

/**
 * 청구처 검색형 콤보박스: <input list>+<datalist>로 이름 일부만 입력해 필터, 선택값은 hidden client_id로 app.js가 동기화.
 * 클라이언트가 많아도 타이핑으로 좁힌다. 목록에 없으면 비워 두면 저장 시 자동 매칭(resolveAutoClientId: 제작사>소속사>아티스트).
 * CSP-safe: datalist/hidden은 정적, 값 동기화는 외부 app.js([data-client-combo]).
 */
function clientCombo(selectedId) {
  const opts = clientOptions();
  const sel = selectedId ? opts.find((c) => c.id === Number(selectedId)) : null;
  return `
    <div data-client-combo>
      <input type="hidden" name="client_id" value="${sel ? sel.id : ""}" data-client-id />
      <input class="input" type="text" list="dl-payer-clients" data-client-search autocomplete="off"
        placeholder="이름 일부 입력 후 목록에서 선택…" value="${sel ? esc(clientComboLabel(sel)) : ""}" aria-label="청구처 검색" />
      <datalist id="dl-payer-clients">
        ${opts.map((c) => `<option value="${esc(clientComboLabel(c))}" data-id="${c.id}"></option>`).join("")}
      </datalist>
      <p class="mt-1 text-xs text-muted">이름 일부만 입력해도 좁혀집니다. 비워 두면 저장 시 자동 연결.</p>
    </div>`;
}

/**
 * 클라이언트 담당자(연락처) 검색형 콤보박스: clientCombo와 동일 패턴.
 * <input list>+<datalist>로 이름 일부만 입력해 필터, 선택값은 hidden contact_id로 app.js([data-contact-combo])가 동기화.
 * 내부 담당자(managerSelect)와 별개 필드. 비워 두면 미연결. CSP-safe: datalist/hidden은 정적, 값 동기화는 외부 app.js.
 */
function contactCombo(selectedId) {
  const opts = contactOptions();
  const sel = selectedId ? opts.find((o) => o.id === Number(selectedId)) : null;
  // 선택 시 app.js가 전화·이메일·소속을 [data-contact-info]에 채운다. 목록에 없는 이름은 저장 시 새 연락처로 등록(E).
  return `
    <div data-contact-combo>
      <input type="hidden" name="contact_id" value="${sel ? sel.id : ""}" data-contact-id />
      <input class="input" type="text" name="contact_name" list="dl-contacts" data-contact-search autocomplete="off"
        placeholder="이름 입력 — 목록에서 선택하거나 새 이름" value="${sel ? esc(sel.name) : ""}" aria-label="고객측 담당자 검색" />
      <datalist id="dl-contacts">
        ${opts.map((o) => `<option value="${esc(o.name)}" data-id="${o.id}" data-phone="${esc(o.phone || "")}" data-email="${esc(o.email || "")}" data-client="${esc(o.current_client || "")}"></option>`).join("")}
      </datalist>
      <div class="mt-1.5 hidden text-sm text-muted" data-contact-info></div>
      <p class="mt-1 text-xs text-muted">목록에 없는 이름을 입력하면 저장 시 <span class="text-fg">새 연락처</span>로 등록됩니다. 비워 두면 미연결.</p>
    </div>`;
}

function managerSelect(selectedId) {
  const opts = listProjectManagers();
  return `
    <select name="manager_id" class="input">
      <option value="">담당 엔지니어 미지정</option>
      ${opts.map((m) => `<option value="${m.id}" ${Number(selectedId) === m.id ? "selected" : ""}>${esc(m.name)}</option>`).join("")}
    </select>`;
}

function tracksSection({ project, tracks, isAdmin, managers = [], expandTaskId = null }) {
  const list = tracks.length
    ? tracks.map((track) => trackCard(track, { isAdmin, managers, expandTaskId })).join("")
    : emptyState("등록된 곡·콘텐츠가 없습니다.");
  const hint = isAdmin
    ? `<p class="text-xs text-muted">세션(예약·실시간 작업)과 <span class="text-muted">별개로</span> 곡·콘텐츠별 후반작업(보컬튠·믹싱·마스터링)을 관리합니다. 한 세션에 여러 곡을 넣을 수 있고, 각 곡은 단계별로 이어집니다.</p>`
    : "";
  return `
    <section class="card mt-3 space-y-4">
      <div class="flex items-center justify-between gap-3">
        <h2 class="font-display text-base font-semibold">곡 · 콘텐츠</h2>
      </div>
      ${hint}
      <div class="space-y-3">${list}</div>
      ${isAdmin ? `<div class="border-t border-border pt-4"><div class="mb-2 text-sm font-medium text-muted">곡·콘텐츠 추가</div>${trackCreateForm(project)}</div>` : ""}
    </section>`;
}

function trackCreateForm(project) {
  return `
    <form method="post" action="/projects/${project.id}/tracks" class="rounded-lg border border-border bg-bg p-3">
      <label class="label mb-1 text-xs">곡·콘텐츠 이름 <span class="font-normal text-muted">— 여러 곡은 줄바꿈으로 구분</span></label>
      <div class="flex gap-2">
        <textarea class="input flex-1 py-1.5 text-sm" name="titles" rows="2" placeholder="곡명 또는 콘텐츠명&#10;한 줄에 하나씩 입력"></textarea>
        <button class="btn-primary shrink-0 self-end px-4 py-1.5 text-sm" type="submit">추가</button>
      </div>
    </form>`;
}

function trackCard(track, { isAdmin, managers = [], expandTaskId = null }) {
  const tasks = track.tasks && track.tasks.length
    ? track.tasks.map((task) => taskRow(task, { isAdmin, managers, open: task.id === expandTaskId })).join("")
    : emptyState("아직 등록된 작업이 없습니다. 아래에서 진행 단계를 추가하세요.");
  const hasInvoiced = (track.tasks || []).some((t) => t.is_invoiced);
  return `
    <div class="rounded-lg border border-border bg-bg p-3">
      <div class="mb-2 flex items-start justify-between gap-3">
        <div class="min-w-0">
          <div class="font-medium">${esc(track.title)}</div>
        </div>
        ${isAdmin ? trackEditMenu(track, hasInvoiced) : ""}
      </div>
      ${trackProgressSummary(track.tasks)}
      <div class="space-y-2">${tasks}</div>
      ${isAdmin ? taskQuickAdd(track) : ""}
    </div>`;
}

/** 곡의 진행 요약: 단계 그룹별 가장 진전된 상태를 한 줄로(녹음 완료 · 후반 진행중 · 믹스·마스터 대기). */
function trackProgressSummary(tasks) {
  if (!tasks || !tasks.length) return "";
  const order = { Pending: 0, In_Progress: 1, Completed: 2 };
  const byGroup = {};
  for (const t of tasks) {
    const g = taskTypeGroup(t.task_type);
    if (byGroup[g] == null || (order[t.status] || 0) > (order[byGroup[g]] || 0)) byGroup[g] = t.status;
  }
  const parts = Object.keys(byGroup).map((g) => `${TASK_GROUP_LABELS[g] || g} ${TASK_STATUS_LABELS[byGroup[g]] || byGroup[g]}`);
  return parts.length ? `<div class="mb-2 text-xs text-muted">진행: ${esc(parts.join(" · "))}</div>` : "";
}

function trackEditMenu(track, hasInvoiced) {
  return `
    <details class="group shrink-0 text-right">
      <summary class="flex cursor-pointer list-none items-center justify-end text-xs text-muted hover:text-fg">${detailsChevron()}</summary>
      <form method="post" action="/projects/tracks/${track.id}" class="mt-2 flex gap-2 rounded-lg border border-border bg-surface p-3 text-left">
        <input class="input flex-1 py-1.5 text-sm" name="title" value="${esc(track.title)}" required />
        <button class="btn-primary shrink-0 btn-xs" type="submit">저장</button>
      </form>
      ${hasInvoiced
        ? `<p class="mt-2 text-xs text-muted">청구된 작업이 있어 삭제할 수 없습니다.</p>`
        : `<form method="post" action="/projects/tracks/${track.id}/delete" data-confirm="이 곡·콘텐츠와 하위 작업을 삭제할까요?" class="mt-2 text-left">
             <button class="btn-ghost btn-xs text-danger" type="submit">곡·콘텐츠 삭제</button>
           </form>`}
    </details>`;
}

function taskRow(task, { isAdmin, managers = [], open = false } = {}) {
  const label = taskTypeLabel(task.task_type);
  const status = TASK_STATUS_LABELS[task.status] || task.status;
  const statusCls = TASK_STATUS_BADGE[task.status] || "bg-muted/10 text-muted";
  const amount = `<span class="text-sm font-semibold" data-row-amount>${task.total_price ? formatKRW(task.total_price) : ""}</span>`;
  const title = `<span class="min-w-0 truncate text-sm"><span class="font-medium">${esc(label)}</span>${task.engineer_name ? `<span class="text-xs text-muted"> · ${esc(task.engineer_name)}</span>` : ""}</span>`;
  const statusBadge = `<span class="badge ${statusCls}" data-row-status>${esc(status)}</span>`;

  // 비관리자/청구된 작업: 편집 불가 → 단순 행(접기 없음).
  if (!isAdmin || task.is_invoiced) {
    const billed = task.is_invoiced ? `<span class="badge bg-success/10 text-success">청구됨</span>` : "";
    return `
      <div id="task-${task.id}" class="flex items-center justify-between gap-2 rounded-lg border border-border bg-surface p-2.5">
        ${title}
        <span class="flex shrink-0 items-center gap-1.5">${amount}${statusBadge}${billed}</span>
      </div>`;
  }
  // 편집 가능: 헤더 전체가 접기 토글. 오른쪽 끝에 접기 버튼(chevron), 그 앞에 상태 배지.
  return `
    <details id="task-${task.id}" class="group rounded-lg border border-border bg-surface"${open ? " open" : ""}>
      <summary class="flex cursor-pointer list-none items-center justify-between gap-2 p-2.5">
        ${title}
        <span class="flex shrink-0 items-center gap-2">
          ${amount}
          ${statusBadge}
          ${detailsChevron()}
        </span>
      </summary>
      <div class="border-t border-border p-2.5">
        ${taskEditForm(task, managers)}
      </div>
    </details>`;
}

/**
 * 담당 엔지니어 select 옵션(담당자 마스터, value=manager.id). 선택 기준은 task.engineer_id.
 * 레거시(engineer_id 없이 engineer_name만 있는) 작업은 value='legacy' 보존 옵션으로 표시 — 저장 시 이름이 유지된다.
 */
function engineerSelect(managers, task) {
  const curId = task && task.engineer_id ? Number(task.engineer_id) : null;
  const legacyName = !curId && task && task.engineer_name ? String(task.engineer_name) : "";
  const out = [`<option value="">담당자 미지정</option>`];
  if (legacyName) {
    out.push(`<option value="legacy" selected>${esc(legacyName)} (목록 외)</option>`);
  }
  for (const m of managers) {
    // data-external: 외주 작업자(user_id 없음)=1 → app.js가 외주 지급단가 토글. 하우스 엔지니어는 단가 숨김.
    out.push(`<option value="${m.id}" ${curId === m.id ? "selected" : ""} data-external="${m.user_id ? "" : "1"}">${esc(m.name)}${m.user_id ? "" : " · 외주"}</option>`);
  }
  return out.join("");
}

/** 작업 종류 select 옵션 — 활성 종류 + 현재값이 비활성/삭제됐으면 보존용 옵션(과거 작업 깨짐 방지). */
function taskTypeOptions(current) {
  const types = activeTaskTypes();
  const out = types.map((t) => `<option value="${esc(t.key)}" ${t.key === current ? "selected" : ""}>${esc(t.label)}</option>`);
  if (current && !types.some((t) => t.key === current)) {
    out.unshift(`<option value="${esc(current)}" selected>${esc(taskTypeLabel(current))} (삭제됨)</option>`);
  }
  return out.join("");
}

function taskEditForm(task, managers = []) {
  const legacyName = !task.engineer_id && task.engineer_name ? String(task.engineer_name) : "";
  return `
    <form method="post" action="/projects/tasks/${task.id}" class="grid gap-2 sm:grid-cols-2" data-task-form>
      <div>
        <label class="label mb-0.5 text-xs">작업 종류</label>
        <select class="input py-1.5 text-sm" name="task_type">${taskTypeOptions(task.task_type)}</select>
      </div>
      <div>
        <label class="label mb-0.5 text-xs">금액 <span class="font-normal text-muted">(고객 청구 · 원)</span></label>
        <input class="input py-1.5 text-sm" name="unit_price" inputmode="numeric" placeholder="0" value="${esc(String(task.unit_price || ""))}" />
      </div>
      <div>
        <label class="label mb-0.5 text-xs">담당 엔지니어</label>
        <select class="input py-1.5 text-sm" name="engineer_id">${engineerSelect(managers, task)}</select>
      </div>
      <div data-worker-rate>
        <label class="label mb-0.5 text-xs">외주 지급단가 <span class="font-normal text-muted">(정산 기준 · 원)</span></label>
        <input class="input py-1.5 text-sm" name="worker_rate" inputmode="numeric" placeholder="0" value="${esc(String(task.worker_rate || ""))}" />
      </div>
      <div>
        <label class="label mb-0.5 text-xs">상태</label>
        <select class="input py-1.5 text-sm" name="status">
          ${TASK_STATUSES.map((status) => `<option value="${esc(status)}" ${status === task.status ? "selected" : ""}>${esc(TASK_STATUS_LABELS[status] || status)}</option>`).join("")}
        </select>
      </div>
      ${legacyName ? `<input type="hidden" name="engineer_name" value="${esc(legacyName)}" />` : ""}
      <div class="text-right text-xs text-muted sm:col-span-2" data-save-state aria-live="polite"></div>
    </form>
    <form method="post" action="/projects/tasks/${task.id}/delete" data-confirm="이 작업을 삭제할까요?" class="mt-2">
      <button class="btn-ghost btn-xs text-danger" type="submit">작업 삭제</button>
    </form>`;
}

/** 다음 단계 빠른 추가 — is_quick 종류 버튼(기본 단가 주입), +기타는 전체 활성 종류 그룹 + 금액 인라인 입력(0원 강제 방지). 추가하면 편집이 펼쳐져 조정할 수 있다. */
function taskQuickAdd(track) {
  const types = activeTaskTypes();
  const quickTypes = types.filter((t) => t.is_quick);
  const quick = (t) => `
    <form method="post" action="/projects/tracks/${track.id}/tasks">
      <input type="hidden" name="task_type" value="${esc(t.key)}" />
      <input type="hidden" name="unit_price" value="${t.unit_price || 0}" />
      <input type="hidden" name="status" value="Pending" />
      <button class="rounded-md border border-border bg-bg btn-xs hover:border-primary hover:text-primary" type="submit">${esc(t.label)}</button>
    </form>`;
  const groups = {};
  for (const t of types) (groups[t.task_group] = groups[t.task_group] || []).push(t);
  const grouped = Object.keys(groups)
    .map((g) => `<optgroup label="${esc(TASK_GROUP_LABELS[g] || g)}">${groups[g].map((t) => `<option value="${esc(t.key)}">${esc(t.label)}</option>`).join("")}</optgroup>`)
    .join("");
  const other = `
    <details class="align-top">
      <summary class="cursor-pointer list-none rounded-md border border-border bg-bg btn-xs hover:border-primary hover:text-primary">+ 기타</summary>
      <form method="post" action="/projects/tracks/${track.id}/tasks" class="mt-2 flex flex-wrap items-center gap-2 rounded-lg border border-border bg-surface p-2">
        <select class="input py-1.5 text-sm" name="task_type">${grouped}</select>
        <input class="input w-28 py-1.5 text-sm" name="unit_price" inputmode="numeric" placeholder="금액(원)" />
        <input type="hidden" name="status" value="Pending" />
        <button class="btn-primary btn-xs" type="submit">추가</button>
      </form>
    </details>`;
  return `
    <div class="mt-3">
      <div class="mb-1.5 text-xs text-muted">다음 단계 추가</div>
      <div class="flex flex-wrap items-center gap-1.5">${quickTypes.map(quick).join("")}${other}</div>
    </div>`;
}

function unbilledInvoiceForm(project, taskRows, sessionRows = []) {
  const tasks = taskRows || [];
  if (!tasks.length && !sessionRows.length) {
    return `<div class="rounded-lg border border-border bg-bg px-3 py-4 text-center text-sm text-muted">청구할 작업·세션이 없습니다.</div>`;
  }
  // 세션 '완료 강제'와 규칙 통일: 완료 상태 작업만 기본 체크. 미완료(대기·진행중)는 체크 해제·흐리게(선택은 가능).
  const isDone = (t) => t.status === "Completed";
  const hasPending = tasks.some((t) => !isDone(t));
  const subtotal =
    tasks.filter(isDone).reduce((sum, task) => sum + (task.total_price || 0), 0) +
    sessionRows.reduce((sum, s) => sum + (s.billing ? s.billing.amount : 0), 0);
  const tax = Math.round(subtotal * 0.1);
  const taskList = tasks
    .map((task) => {
      const label = taskTypeLabel(task.task_type);
      const done = isDone(task);
      const statusTag = done ? "" : ` <span class="text-xs font-normal text-warning">${esc(TASK_STATUS_LABELS[task.status] || task.status)}</span>`;
      return `
        <label class="flex items-start gap-2 border-b border-border py-2 last:border-0 ${done ? "" : "opacity-60"}">
          <input class="mt-1" type="checkbox" name="task_id" value="${task.id}" data-line-amount="${task.total_price || 0}" ${done ? "checked" : ""} />
          <span class="min-w-0 flex-1">
            <span class="block text-sm font-medium">${esc(task.track_title)} · ${esc(label)}${statusTag}</span>
          </span>
          <span class="text-sm font-semibold tabular">${formatKRW(task.total_price)}</span>
        </label>`;
    })
    .join("");
  // 녹음 세션 직접 청구 후보(곡·콘텐츠/버튼 없이 자동 노출). 체크하면 인보이스 라인으로 들어간다.
  const sessionList = sessionRows
    .map((s) => {
      const mins = s.billing.minutes;
      const dur = `${Math.floor(mins / 60)}시간${mins % 60 ? " " + (mins % 60) + "분" : ""}`;
      const time = [s.start_time, s.end_time].filter(Boolean).join("–");
      return `
        <label class="flex items-start gap-2 border-b border-border py-2 last:border-0">
          <input class="mt-1" type="checkbox" name="session_id" value="${s.id}" data-line-amount="${s.billing.amount}" checked />
          <span class="min-w-0 flex-1">
            <span class="block text-sm font-medium">녹음 세션 ${esc(formatYmdShort(s.session_date))} · ${esc(s.billing.item.name)}</span>
            <span class="block text-xs text-muted">${esc(dur)}${time ? " · " + esc(time) : ""}</span>
          </span>
          <span class="text-sm font-semibold tabular">${formatKRW(s.billing.amount)}</span>
        </label>`;
    })
    .join("");
  const total = subtotal + tax;
  return `
    <form method="post" action="/projects/${project.id}/invoices/from-tasks" class="rounded-lg border border-border bg-bg p-3" data-discount-form data-supply="${subtotal}">
      <div class="mb-2">
        <h3 class="text-sm font-semibold">청구 생성 <span class="text-xs font-normal text-muted">(미청구 작업 · 녹음 세션)</span></h3>
      </div>
      <div class="mb-2">
        <label class="label mb-1 text-xs">청구처 <span class="font-normal text-muted">— 미선택 시 자동(제작사 › 소속사 › 아티스트)</span></label>
        ${clientCombo(project.client_id)}
      </div>
      <div class="rounded-lg border border-border bg-surface px-3">${taskList}${sessionList}</div>
      ${hasPending ? `<p class="mt-1.5 text-xs text-muted">미완료(대기·진행중) 작업은 기본 선택에서 제외됩니다. 필요하면 직접 체크하세요.</p>` : ""}
      <div class="mt-3 space-y-2">
        <div>
          <label class="label mb-1 text-xs">청구 제목</label>
          <input class="input py-1.5 text-sm" name="title" value="${esc(project.title)} 청구" />
        </div>
        <div>
          <label class="label mb-1 text-xs">할인 <span class="font-normal text-muted">(선택 — 체크한 항목 공급가 기준)</span></label>
          <div class="flex gap-2">
            <div class="relative flex-1">
              <input class="input py-1.5 text-sm pr-8" inputmode="numeric" name="discount_amount" value="0" placeholder="0" data-discount-amount />
              <span class="pointer-events-none absolute inset-y-0 right-2 flex items-center text-xs text-muted">원</span>
            </div>
            <div class="relative w-24">
              <input class="input py-1.5 text-sm pr-6" inputmode="decimal" placeholder="0" data-discount-pct />
              <span class="pointer-events-none absolute inset-y-0 right-2 flex items-center text-xs text-muted">%</span>
            </div>
          </div>
        </div>
        <div class="rounded-lg border border-border bg-surface p-3">
          <div class="flex items-center justify-between text-sm"><span class="text-muted">공급가</span><span class="font-medium tabular" data-amt-supply>${formatKRW(subtotal)}</span></div>
          <div class="mt-1 flex items-center justify-between text-sm" data-amt-discount-row hidden><span class="text-muted">할인</span><span class="font-medium tabular text-danger" data-amt-discount></span></div>
          <label class="mt-1.5 flex cursor-pointer items-center justify-between text-sm">
            <span class="flex items-center gap-1.5"><input type="checkbox" name="vat_included" value="1" checked data-vat-toggle /> 부가세(VAT 10%) 포함</span>
            <span class="font-medium tabular" data-amt-vat>${formatKRW(tax)}</span>
          </label>
          <div class="mt-1.5 flex items-center justify-between border-t border-border pt-1.5 text-base font-bold"><span>총 금액</span><span class="tabular" data-amt-total>${formatKRW(total)}</span></div>
        </div>
        <div class="grid gap-2 sm:grid-cols-2">
          <div>
            <label class="label mb-1 text-xs">발행일</label>
            <input class="input py-1.5 text-sm" type="date" name="issued_date" value="${esc(todayYmd())}" />
          </div>
          <div>
            <label class="label mb-1 text-xs">입금 마감일<span class="font-normal text-muted"> (선택)</span></label>
            <input class="input py-1.5 text-sm" type="date" name="due_date" />
          </div>
        </div>
        <p class="mb-2 text-xs text-muted">생성하면 바로 <span class="font-medium text-fg">발행</span>됩니다. 발행 후에는 청구처를 바꿀 수 없어요(미발행 상태에서만 변경).</p>
        <button class="btn-primary w-full btn-sm" type="submit">선택 항목으로 청구 생성</button>
      </div>
    </form>`;
}

module.exports = router;
