"use strict";

const express = require("express");
const { db } = require("../db");
const { requireAuth, requireEditor, requireChief, requireInvoice, canEdit, canInvoice } = require("../auth");
const {
  TASK_GROUP_LABELS,
  TASK_STATUSES,
  TASK_STATUS_LABELS,
  TASK_STATUS_BADGE,
  PROJECT_TYPES,
  PROJECT_TYPE_LABELS,
  normalizeProjectType,
} = require("../config");
const { config } = require("../config");
const {
  listProjects,
  distinctProjectFields,
  getProjectForUser,
  deleteProject,
  clientOptions,
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
} = require("../data");
const { layout, pageHeader, esc, formatKRW, flashBanner, errorPage, emptyState, detailsChevron } = require("../views");
const { deliverablesSection } = require("../views.deliverables");
const { invoicesSection } = require("../views.invoices");
const { sessionsSection } = require("../views.sessions");
const { isValidYmd, formatYmdShort, todayYmd } = require("../lib/date");

const router = express.Router();

function cleanYmd(v) {
  const s = String(v || "").trim();
  return isValidYmd(s) ? s : null;
}

function toArray(value) {
  if (value == null || value === "") return [];
  return Array.isArray(value) ? value : [value];
}

// ── 목록(URL = 필터; 플레이북2 §3.7) ──
router.get("/", requireAuth, (req, res) => {
  const user = req.user;
  const canCreate = canEdit(user); // 대표(열람전용)는 새 프로젝트 버튼 숨김
  const filters = {
    service: String(req.query.service || "").trim(),
    clientId: req.query.clientId || "",
    q: (req.query.q || "").toString().trim(),
  };
  const rows = listProjects(user, filters);

  const searched = Boolean(filters.q);
  const list = rows.length
    ? rows.map((p) => projectListCard(p)).join("")
    : searched
      ? emptyState(`"${esc(filters.q)}" 검색 결과가 없습니다.`, { card: true })
      : emptyState(`프로젝트가 없습니다.${canCreate ? ' <a href="/projects/new" class="text-primary hover:underline">새로 추가</a>' : ""}`, { card: true });

  const action = canCreate ? newProjectMenu() : "";

  const searchBar = `
    <form method="get" action="/projects" class="mb-4 flex gap-2">
      <input class="input min-w-0 flex-1" type="search" name="q" value="${esc(filters.q)}" placeholder="프로젝트 · 아티스트 검색" />
      <button class="btn-primary shrink-0" type="submit">검색</button>
    </form>`;
  const resultNote = searched
    ? `<div class="mb-3 text-sm text-muted">"${esc(filters.q)}" 결과 ${rows.length}건 · <a href="/projects" class="text-primary hover:underline">전체 보기</a></div>`
    : "";

  const body = `
    ${pageHeader({ title: "프로젝트", desc: "전체 프로젝트", action })}
    ${searchBar}
    ${resultNote}
    ${list}`;
  res.send(layout({ title: "프로젝트", user, current: "/projects", body }));
});

/** "+ 새 프로젝트" 드롭다운 — 유형 2가지를 하위 버튼처럼 노출(JS 없이 <details>). */
function newProjectMenu() {
  return `
    <details class="relative inline-block text-left">
      <summary class="btn-primary cursor-pointer list-none">+ 새 프로젝트</summary>
      <div class="absolute right-0 z-20 mt-1 w-64 overflow-hidden rounded-lg border border-border bg-surface shadow-lg">
        ${PROJECT_TYPES.map(
          (t) => `<a href="/projects/new?type=${esc(t.key)}" class="block border-b border-border px-3 py-2.5 last:border-0 hover:bg-elevated">
            <div class="text-sm font-medium">${esc(t.menuLabel || t.label)}</div>
            <div class="text-xs text-muted">${esc(t.hint)}</div>
          </a>`
        ).join("")}
      </div>
    </details>`;
}

/** 프로젝트의 항목(트랙) 개수. track_titles("||" 연결)에서 파생. */
function trackCount(p) {
  if (!p || !p.track_titles) return 0;
  return String(p.track_titles).split("||").map((s) => s.trim()).filter(Boolean).length;
}

/** 목록 카드: 상세와 같은 한 줄 요약 방식(메타 한 줄 + 항목 개수 / 견적·완료일). */
function projectListCard(p) {
  const metaLine = [p.artist, p.client_name, p.manager_name].filter(Boolean).join(" · ") || "정보 미정";
  const n = trackCount(p);
  const typeBadge = p.project_type === "session"
    ? `<span class="badge bg-warning/10 text-warning">세션</span>`
    : p.project_type === "task"
      ? `<span class="badge bg-primary/10 text-primary">작업</span>`
      : "";
  const amount = projectAmount(p)
    ? `<div class="text-sm font-medium">${formatKRW(projectAmount(p))}</div>`
    : `<div class="text-sm text-muted">견적 미정</div>`;
  return `
    <a href="/projects/${p.id}" class="card mb-3 flex items-center justify-between gap-4">
      <div class="min-w-0 flex-1">
        <div class="flex items-center gap-2"><span class="truncate font-semibold">${esc(p.title)}</span>${typeBadge}</div>
        <div class="mt-0.5 truncate text-sm text-muted">${esc(metaLine)}</div>
        <div class="mt-0.5 text-xs text-muted">${n ? `곡·콘텐츠 ${n}` : "곡·콘텐츠 미정"}</div>
      </div>
      <div class="shrink-0 text-right">
        ${amount}
      </div>
    </a>`;
}

// ── 새 프로젝트 폼(관리자) ──
router.get("/new", requireEditor, (req, res) => {
  const type = normalizeProjectType(req.query.type);
  res.send(layout({ title: "새 프로젝트", user: req.user, current: "/projects", body: projectForm({ project_type: type }) }));
});

// ── 생성(관리자) ──
router.post("/", requireEditor, (req, res) => {
  const b = req.body;
  const title = String(b.title || "").trim();
  const type = normalizeProjectType(b.project_type);
  if (!title) return res.send(layout({ title: "새 프로젝트", user: req.user, current: "/projects", body: projectForm({ ...b, project_type: type, _err: "프로젝트 명을 입력하세요." }) }));
  const info = db()
    .prepare(
      `INSERT INTO projects (title, project_type, artist, artist_company, production_company, client_id, manager_id, due_date, memo)
       VALUES (@title, @project_type, @artist, @artist_company, @production_company, @client_id, @manager_id, @due_date, @memo)`
    )
    .run({
      title,
      project_type: type,
      artist: String(b.artist || "").trim() || null,
      artist_company: String(b.artist_company || "").trim() || null,
      production_company: String(b.production_company || "").trim() || null,
      client_id: b.client_id ? Number(b.client_id) : null,
      manager_id: b.manager_id ? Number(b.manager_id) : null,
      due_date: cleanYmd(b.due_date),
      memo: String(b.memo || "").trim() || null,
    });
  ensureClientsFromProject(b); // 아티스트·소속사/레이블·제작사를 클라이언트 마스터에 자동 등록
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
  deleteProject(p.id);
  res.redirect("/projects?flash=deleted");
});

function renderProjectDetail(req, res, p, formState = null, err = "") {
  const editable = canEdit(req.user); // 치프/스태프는 편집, 대표는 열람 전용
  const showInvoice = canInvoice(req.user); // 청구 섹션은 치프/대표만
  const managers = editable ? listProjectManagers() : []; // 작업·세션 엔지니어 선택용(담당자 마스터)

  const meta = editable
    ? projectMetaCard({ ...p, ...(formState || {}) }, err)
    : projectMetaReadonly(p);

  const isSession = p.project_type === "session";
  const isTask = p.project_type === "task";
  const typeLabel = PROJECT_TYPE_LABELS[p.project_type] || "";
  const desc = [typeLabel, p.artist || p.client_name].filter(Boolean).join(" · ") || "프로젝트";

  // ── 탭: 프로젝트 / 세션 일정(작업형 제외) / 곡·콘텐츠 / 자료 전달 / 청구(청구권자만) ──
  // 메타 카드는 '프로젝트' 탭(첫 탭·기본). 작업형(task)만 세션 일정 탭을 숨긴다. 세션형·레거시(NULL)는 노출.
  const tabs = [{ key: "project", label: "프로젝트" }];
  if (!isTask) tabs.push({ key: "sessions", label: "세션 일정" });
  tabs.push({ key: "tracks", label: "곡 · 콘텐츠" });
  tabs.push({ key: "deliverables", label: "자료 전달" });
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
  } else if (tab === "deliverables") {
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
    tabContent = sessionsSection({ project: p, rows: sessionBundle2 ? sessionBundle2.rows : [], isAdmin: editable, managers, rateItems, expand: true });
  }

  const body = [flashBanner(req.query), pageHeader({ title: p.title, desc }), tabBar, tabContent].join("\n");
  res.send(layout({ title: p.title, user: req.user, current: "/projects", body }));
}

/** 메타 한 줄 요약(아티스트 · 거래처 · 담당자 / 견적 · 완료일). */
function projectMetaLine(p) {
  const left = [p.artist, p.client_name, p.manager_name].filter(Boolean).join(" · ") || "정보 미정";
  const amount = projectAmount(p)
    ? `<div class="text-sm font-semibold">${formatKRW(projectAmount(p))}</div>`
    : `<div class="text-sm text-muted">견적 미정</div>`;
  return { left: esc(left), amount, dueLine: "" };
}

/** 클라이언트(읽기 전용) 메타 카드. */
function projectMetaReadonly(p) {
  const { left, amount, dueLine } = projectMetaLine(p);
  const extra = [
    p.artist_company ? `소속사 ${esc(p.artist_company)}` : "",
    p.production_company ? `제작사 ${esc(p.production_company)}` : "",
  ].filter(Boolean).join(" · ");
  return `
    <div class="card">
      <div class="flex items-center justify-between gap-3">
        <div class="min-w-0 text-sm text-muted">${left}</div>
        <div class="shrink-0 text-right">${amount}${dueLine}</div>
      </div>
      ${extra ? `<div class="mt-1 text-xs text-muted">${extra}</div>` : ""}
      ${p.memo ? `<div class="mt-2 whitespace-pre-wrap border-t border-border pt-2 text-sm">${esc(p.memo)}</div>` : ""}
    </div>`;
}

/** 관리자 메타 카드: 요약 한 줄 + 펼치면 편집 폼(<details>). 오류 시 자동 펼침. */
function projectMetaCard(p, err = "") {
  const { left, amount, dueLine } = projectMetaLine(p);
  return `
    <details class="card group"${err ? " open" : ""}>
      <summary class="flex cursor-pointer list-none items-center justify-between gap-3">
        <div class="min-w-0 text-sm text-muted">${left}</div>
        <div class="flex shrink-0 items-center gap-3">
          <div class="text-right">${amount}${dueLine}</div>
          ${detailsChevron()}
        </div>
      </summary>
      <div class="mt-3 border-t border-border pt-3">
        ${projectEditForm(p, err)}
        <div class="mt-4 border-t border-border pt-4">
          <form method="post" action="/projects/${p.id}/delete" data-confirm="프로젝트를 삭제하면 세션·곡·콘텐츠·자료가 모두 삭제됩니다. 정말 삭제할까요?">
            <button class="btn-ghost btn-xs text-danger" type="submit">프로젝트 삭제</button>
          </form>
        </div>
      </div>
    </details>`;
}

function projectAmount(project) {
  return Number(project.task_total || 0) || Number(project.rate || 0) || 0;
}

// ── 예전 수정 URL은 상세 편집 화면으로 정규화 ──
router.get("/:id/edit", requireEditor, (req, res) => {
  res.redirect(`/projects/${Number(req.params.id)}`);
});

// ── 수정 저장(관리자) ──
router.post("/:id", requireEditor, (req, res) => {
  const id = Number(req.params.id);
  const exists = db().prepare("SELECT id FROM projects WHERE id = ?").get(id);
  if (!exists) return res.status(404).send("프로젝트를 찾을 수 없습니다.");
  const b = req.body;
  const title = String(b.title || "").trim();
  if (!title) {
    const p = getProjectForUser(req.user, id);
    return renderProjectDetail(req, res, p, { ...b, id }, "프로젝트 명을 입력하세요.");
  }
  db()
    .prepare(
      `UPDATE projects SET title=@title, artist=@artist, artist_company=@artist_company,
       production_company=@production_company, client_id=@client_id, manager_id=@manager_id,
       due_date=@due_date, memo=@memo WHERE id=@id`
    )
    .run({
      id,
      title,
      artist: String(b.artist || "").trim() || null,
      artist_company: String(b.artist_company || "").trim() || null,
      production_company: String(b.production_company || "").trim() || null,
      client_id: b.client_id ? Number(b.client_id) : null,
      manager_id: b.manager_id ? Number(b.manager_id) : null,
      due_date: cleanYmd(b.due_date),
      memo: String(b.memo || "").trim() || null,
    });
  ensureClientsFromProject(b); // 아티스트·소속사/레이블·제작사를 클라이언트 마스터에 자동 등록
  res.redirect(`/projects/${id}?flash=saved`);
});

router.post("/:id/tracks", requireEditor, (req, res) => {
  try {
    const track = createTrack(req.user, Number(req.params.id), req.body);
    if (!track) return res.status(404).send("프로젝트를 찾을 수 없습니다.");
    res.redirect(`/projects/${track.project_id}?tab=tracks&flash=added`);
  } catch (e) {
    if (e.message === "TRACK_TITLE_REQUIRED") return res.status(400).send("곡·콘텐츠 이름을 입력하세요.");
    throw e;
  }
});

router.post("/tracks/:trackId", requireEditor, (req, res) => {
  try {
    const track = updateTrack(req.user, Number(req.params.trackId), req.body);
    if (!track) return res.status(404).send("곡·콘텐츠를 찾을 수 없습니다.");
    res.redirect(`/projects/${track.project_id}?tab=tracks&flash=saved`);
  } catch (e) {
    if (e.message === "TRACK_TITLE_REQUIRED") return res.status(400).send("곡·콘텐츠 이름을 입력하세요.");
    throw e;
  }
});

router.post("/tracks/:trackId/delete", requireEditor, (req, res) => {
  try {
    const result = deleteTrack(req.user, Number(req.params.trackId));
    if (!result) return res.status(404).send("곡·콘텐츠를 찾을 수 없습니다.");
    res.redirect(`/projects/${result.project_id}?tab=tracks&flash=deleted`);
  } catch (e) {
    if (e.message === "TRACK_HAS_INVOICED") {
      return res.status(400).send("이미 청구된 작업이 있는 곡·콘텐츠는 삭제할 수 없습니다.");
    }
    throw e;
  }
});

router.post("/tracks/:trackId/tasks", requireEditor, (req, res) => {
  const task = createTask(req.user, Number(req.params.trackId), req.body);
  if (!task) return res.status(404).send("곡·콘텐츠를 찾을 수 없습니다.");
  const track = db().prepare("SELECT project_id FROM project_tracks WHERE id = ?").get(task.track_id);
  res.redirect(track ? `/projects/${track.project_id}?tab=tracks&flash=added&expand=${task.id}#task-${task.id}` : "/projects");
});

router.post("/tasks/:taskId", requireEditor, (req, res) => {
  try {
    const task = updateTask(req.user, Number(req.params.taskId), req.body);
    if (!task) return res.status(404).send("작업을 찾을 수 없습니다.");
    res.redirect(`/projects/${task.project_id}?tab=tracks&flash=saved`);
  } catch (e) {
    if (e.message === "TASK_LOCKED") return res.status(400).send("이미 청구된 작업은 수정할 수 없습니다.");
    throw e;
  }
});

router.post("/tasks/:taskId/delete", requireEditor, (req, res) => {
  try {
    const result = deleteTask(req.user, Number(req.params.taskId));
    if (!result) return res.status(404).send("작업을 찾을 수 없습니다.");
    res.redirect(`/projects/${result.project_id}?tab=tracks&flash=deleted`);
  } catch (e) {
    if (e.message === "TASK_LOCKED") return res.status(400).send("이미 청구된 작업은 삭제할 수 없습니다.");
    throw e;
  }
});

router.post("/:id/invoices/from-tasks", requireInvoice, (req, res) => {
  try {
    const inv = createInvoiceFromTasks(req.user, {
      projectId: Number(req.params.id),
      taskIds: toArray(req.body.task_id),
      sessionIds: toArray(req.body.session_id),
      title: req.body.title,
      issueDate: cleanYmd(req.body.issued_date),
      dueDate: cleanYmd(req.body.due_date),
    });
    if (!inv) return res.status(404).send("청구할 프로젝트를 찾을 수 없습니다.");
    res.redirect(`/invoices/${inv.id}?flash=created`);
  } catch (e) {
    const message = e.message === "TASK_IDS_REQUIRED" ? "청구할 작업·세션을 선택하세요." : "청구 가능한 작업·세션만 선택할 수 있습니다.";
    return res.status(400).send(message);
  }
});

// ── 폼 렌더 ──
function projectForm(p = {}, err = "") {
  const e = err || p._err || "";
  const action = "/projects";
  const type = p.project_type === "session" ? "session" : "task";
  const typeLabel = PROJECT_TYPE_LABELS[type] || "프로젝트";
  const typeHint = type === "session"
    ? "클라이언트 방문·예약으로 세션을 잡고, 진행되면 곡·콘텐츠를 채웁니다."
    : "예약 없이 곡·콘텐츠를 등록하고 튠·믹스·마스터링 작업을 추가합니다.";
  return `
    ${pageHeader({ title: `새 프로젝트 · ${typeLabel}`, desc: typeHint })}
    <form method="post" action="${action}" class="card space-y-4">
      <input type="hidden" name="project_type" value="${esc(type)}" />
      ${e ? `<p class="rounded-lg bg-danger/10 px-3 py-2 text-sm text-danger">${esc(e)}</p>` : ""}
      <div>
        <label class="label">프로젝트 명</label>
        <input class="input" name="title" value="${esc(p.title || "")}" placeholder="${type === "session" ? "예: OOO 세션 (가제)" : "예: OOO 1집 - 타이틀곡"}" required />
      </div>
      <div class="grid gap-3 sm:grid-cols-2">
        <div>
          <label class="label">아티스트</label>
          <input class="input" name="artist" value="${esc(p.artist || "")}" list="dl-artists" autocomplete="off" />
        </div>
        <div>
          <label class="label">소속사/레이블</label>
          <input class="input" name="artist_company" value="${esc(p.artist_company || "")}" list="dl-companies" autocomplete="off" />
        </div>
      </div>
      <div class="grid gap-3 sm:grid-cols-2">
        <div>
          <label class="label">제작사</label>
          <input class="input" name="production_company" value="${esc(p.production_company || "")}" list="dl-productions" autocomplete="off" />
        </div>
        <div>
          <label class="label">실결제자(공급받는 자)</label>
          ${clientSelect(p.client_id)}
        </div>
      </div>
      <div>
        <label class="label">담당자</label>
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
    <form method="post" action="/projects/${p.id}" class="space-y-4">
      ${err ? `<p class="rounded-lg bg-danger/10 px-3 py-2 text-sm text-danger">${esc(err)}</p>` : ""}
      <div>
        <label class="label">프로젝트 명</label>
        <input class="input" name="title" value="${esc(p.title || "")}" required />
      </div>
      <div class="grid gap-3 sm:grid-cols-2">
        <div>
          <label class="label">아티스트</label>
          <input class="input" name="artist" value="${esc(p.artist || "")}" list="dl-artists" autocomplete="off" />
        </div>
        <div>
          <label class="label">소속사/레이블</label>
          <input class="input" name="artist_company" value="${esc(p.artist_company || "")}" list="dl-companies" autocomplete="off" />
        </div>
      </div>
      <div class="grid gap-3 sm:grid-cols-2">
        <div>
          <label class="label">제작사</label>
          <input class="input" name="production_company" value="${esc(p.production_company || "")}" list="dl-productions" autocomplete="off" />
        </div>
        <div>
          <label class="label">실결제자(공급받는 자)</label>
          ${clientSelect(p.client_id)}
        </div>
      </div>
      <div>
        <label class="label">담당자</label>
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

function clientSelect(selectedId) {
  const opts = clientOptions();
  return `
    <select name="client_id" class="input">
      <option value="">실결제자 미지정</option>
      ${opts.map((c) => `<option value="${c.id}" ${Number(selectedId) === c.id ? "selected" : ""}>${esc(c.name)}</option>`).join("")}
    </select>`;
}

function managerSelect(selectedId) {
  const opts = listProjectManagers();
  return `
    <select name="manager_id" class="input">
      <option value="">담당자 미지정</option>
      ${opts.map((m) => `<option value="${m.id}" ${Number(selectedId) === m.id ? "selected" : ""}>${esc(m.name)}</option>`).join("")}
    </select>`;
}

function tracksSection({ project, tracks, isAdmin, managers = [], expandTaskId = null }) {
  const list = tracks.length
    ? tracks.map((track) => trackCard(track, { isAdmin, managers, expandTaskId })).join("")
    : emptyState("등록된 곡·콘텐츠가 없습니다.");
  const isSession = project && project.project_type === "session";
  const hint = isSession && isAdmin
    ? `<p class="text-xs text-muted">세션(예약·실시간 작업)과 <span class="text-muted">별개로</span> 곡·콘텐츠별 후반작업(보컬튠·믹싱·마스터링)을 관리합니다. 한 세션에 여러 곡을 넣을 수 있고, 각 곡은 단계별로 이어집니다.</p>`
    : "";
  return `
    <section class="card mt-3 space-y-4">
      <div class="flex items-center justify-between gap-3">
        <h2 class="font-display text-base font-semibold">곡 · 콘텐츠</h2>
      </div>
      ${hint}
      ${isAdmin ? trackCreateForm(project) : ""}
      <div class="space-y-3">${list}</div>
    </section>`;
}

function trackCreateForm(project) {
  return `
    <form method="post" action="/projects/${project.id}/tracks" class="rounded-lg border border-border bg-bg p-3">
      <div class="flex gap-2">
        <input class="input flex-1 py-1.5 text-sm" name="title" placeholder="곡·콘텐츠 이름(곡명 또는 영상 콘텐츠명)" required />
        <button class="btn-primary shrink-0 px-4 py-1.5 text-sm" type="submit">곡·콘텐츠 추가</button>
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
  const amount = task.total_price ? `<span class="text-sm font-semibold">${formatKRW(task.total_price)}</span>` : "";
  const title = `<span class="min-w-0 truncate text-sm"><span class="font-medium">${esc(label)}</span>${task.engineer_name ? `<span class="text-xs text-muted"> · ${esc(task.engineer_name)}</span>` : ""}</span>`;
  const statusBadge = `<span class="badge ${statusCls}">${esc(status)}</span>`;

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

/** 작업 엔지니어 선택지(담당자 마스터). 현재값이 목록에 없으면 보존용 옵션으로 추가. */
function engineerSelect(managers, current) {
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
  return `
    <form method="post" action="/projects/tasks/${task.id}" class="grid gap-2 sm:grid-cols-2">
      <div>
        <label class="label mb-0.5 text-xs">작업 종류</label>
        <select class="input py-1.5 text-sm" name="task_type">${taskTypeOptions(task.task_type)}</select>
      </div>
      <div>
        <label class="label mb-0.5 text-xs">금액 <span class="font-normal text-muted">(원)</span></label>
        <input class="input py-1.5 text-sm" name="unit_price" inputmode="numeric" placeholder="0" value="${esc(String(task.unit_price || ""))}" />
      </div>
      <div>
        <label class="label mb-0.5 text-xs">담당자</label>
        <select class="input py-1.5 text-sm" name="engineer_name">${engineerSelect(managers, task.engineer_name || "")}</select>
      </div>
      <div>
        <label class="label mb-0.5 text-xs">상태</label>
        <select class="input py-1.5 text-sm" name="status">
          ${TASK_STATUSES.map((status) => `<option value="${esc(status)}" ${status === task.status ? "selected" : ""}>${esc(TASK_STATUS_LABELS[status] || status)}</option>`).join("")}
        </select>
      </div>
      <button class="btn-primary btn-xs sm:col-span-2" type="submit">작업 저장</button>
    </form>
    <form method="post" action="/projects/tasks/${task.id}/delete" data-confirm="이 작업을 삭제할까요?" class="mt-2">
      <button class="btn-ghost btn-xs text-danger" type="submit">작업 삭제</button>
    </form>`;
}

/** 다음 단계 빠른 추가 — is_quick 작업 종류 버튼(기본 단가 주입), +기타는 전체 활성 종류 그룹. 추가하면 편집이 펼쳐져 금액을 입력한다. */
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
  const subtotal =
    tasks.reduce((sum, task) => sum + (task.total_price || 0), 0) +
    sessionRows.reduce((sum, s) => sum + (s.billing ? s.billing.amount : 0), 0);
  const tax = Math.round(subtotal * 0.1);
  const taskList = tasks
    .map((task) => {
      const label = taskTypeLabel(task.task_type);
      return `
        <label class="flex items-start gap-2 border-b border-border py-2 last:border-0">
          <input class="mt-1" type="checkbox" name="task_id" value="${task.id}" checked />
          <span class="min-w-0 flex-1">
            <span class="block text-sm font-medium">${esc(task.track_title)} · ${esc(label)}</span>
            <span class="block text-xs text-muted">${esc(formatQuantity(task.quantity))} x ${formatKRW(task.unit_price)}</span>
          </span>
          <span class="text-sm font-semibold">${formatKRW(task.total_price)}</span>
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
          <input class="mt-1" type="checkbox" name="session_id" value="${s.id}" checked />
          <span class="min-w-0 flex-1">
            <span class="block text-sm font-medium">녹음 세션 ${esc(formatYmdShort(s.session_date))} · ${esc(s.billing.item.name)}</span>
            <span class="block text-xs text-muted">${esc(dur)}${time ? " · " + esc(time) : ""}</span>
          </span>
          <span class="text-sm font-semibold">${formatKRW(s.billing.amount)}</span>
        </label>`;
    })
    .join("");
  return `
    <form method="post" action="/projects/${project.id}/invoices/from-tasks" class="rounded-lg border border-border bg-bg p-3">
      <div class="mb-2 flex items-center justify-between gap-3">
        <h3 class="text-sm font-semibold">청구 생성 <span class="text-xs font-normal text-muted">(미청구 작업 · 녹음 세션)</span></h3>
        <div class="text-right text-xs text-muted">공급가 ${formatKRW(subtotal)} · VAT ${formatKRW(tax)}</div>
      </div>
      <div class="rounded-lg border border-border bg-surface px-3">${taskList}${sessionList}</div>
      <div class="mt-3 space-y-2">
        <div>
          <label class="label mb-1 text-xs">청구 제목</label>
          <input class="input py-1.5 text-sm" name="title" value="${esc(project.title)} 청구" />
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
        <button class="btn-primary w-full btn-sm" type="submit">선택 항목으로 청구 생성</button>
      </div>
    </form>`;
}

function formatQuantity(value) {
  const n = Number(value || 0);
  return Number.isInteger(n) ? String(n) : String(n).replace(/0+$/, "").replace(/\.$/, "");
}

module.exports = router;
