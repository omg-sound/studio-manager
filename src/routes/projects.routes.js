"use strict";

const express = require("express");
const { db } = require("../db");
const { requireAuth, requireEditor, requireBilling, canEdit, canBill } = require("../auth");
const {
  TASK_STATUSES,
  TASK_STATUS_LABELS,
  TASK_STATUS_BADGE,
  normalizeProjectType,
  normalizeDocType,
} = require("../config");
const { config } = require("../config");
const { renderInvoicePdf } = require("../invoice-pdf");
const { asyncHandler } = require("../lib/async");
const {
  listProjects,
  listProjectSummaries,
  distinctProjectFields,
  getProjectForUser,
  deleteProject,
  clientOptions,
  contactOptions,
  partyOptions,
  createGroup,
  createCompany,
  resolvePersonByName,
  getParty,
  listProjectManagers,
  listRateItems,
  activeTaskTypes,
  taskTypeLabel,
  taskTypeUnitPrice,
  listDeliverablesForProject,
  listInvoicesForProject,
  listInvoiceItemsForInvoice,
  listTracksForProject,
  listUnbilledTasksForProject,
  listBillableSessionsForProject,
  listSessionsForProject,
  createTrack,
  updateTrack,
  deleteTrack,
  createTask,
  updateTask,
  setTaskAmount,
  deleteTask,
  createInvoiceFromTasks,
  payerDocMeta,
  invoiceDraftForPdf,
  getClientFile,
  listPersonsForOrg,
  getStudioInfo,
  getStudioLogo,
} = require("../data");
const { layout, pageHeader, esc, formatKRW, flashBanner, errorPage, emptyState, detailsChevron, explain, personCombo, payerCombo } = require("../views");
const { deliverablesSection } = require("../views.deliverables");
const { invoicesSection, payerInfoCard } = require("../views.invoices");
const { sessionsSection } = require("../views.sessions");
const { isValidYmd, formatYmdShort, todayYmd, daysUntilYmd } = require("../lib/date");
const { parseMoney } = require("../lib/forms");
const { notifyInvoiceIssued } = require("../notify");

const router = express.Router();

function cleanYmd(v) {
  const s = String(v || "").trim();
  return isValidYmd(s) ? s : null;
}

/** 조직(company) party를 이름으로 찾거나 생성. 소속사/제작사 공용(roles는 첫 등록 라벨). */
function ensureCompanyParty(name, role) {
  const n = String(name || "").trim();
  if (!n) return null;
  const ex = db().prepare("SELECT id FROM parties WHERE kind = 'company' AND name = ? ORDER BY id LIMIT 1").get(n);
  return ex ? ex.id : createCompany({ name: n, roles: role });
}

/** 사람 party를 아티스트로 표시(is_artist=1, 활동명 비어 있으면 채움). 그룹은 이미 is_artist라 무해. */
function markArtistParty(partyId, activityName) {
  db()
    .prepare("UPDATE parties SET is_artist = 1, activity_name = COALESCE(NULLIF(TRIM(activity_name), ''), ?) WHERE id = ?")
    .run(String(activityName || "").trim() || null, Number(partyId));
}

/**
 * 프로젝트 폼 → 당사자(party) 참조 해석. { contactId, artistId, agencyId, productionId }.
 *  - 아티스트: 그룹 체크→group party / 명시 선택(artist_contact_id=party id) / 이름(본명 우선)으로 사람 party. 개인은 is_artist·활동명 세팅.
 *  - 소속사·제작사: 조직 party 찾거나 생성. 고객측 담당자: 사람 party.
 */
function resolveProjectParties(b) {
  const contactId = b.contact_id
    ? Number(b.contact_id)
    : String(b.contact_name || "").trim()
      ? resolvePersonByName(b.contact_name.trim())
      : null;
  const artistName = String(b.artist || "").trim();
  let artistId = null;
  if (artistName) {
    if (b.artist_is_group) {
      const ex = db().prepare("SELECT id FROM parties WHERE kind = 'group' AND name = ? ORDER BY id LIMIT 1").get(artistName);
      artistId = ex ? ex.id : createGroup({ name: artistName });
    } else if (b.artist_contact_id) {
      artistId = Number(b.artist_contact_id);
      markArtistParty(artistId, artistName);
    } else {
      const realName = String(b.artist_real_name || "").trim();
      artistId = resolvePersonByName(realName || artistName);
      markArtistParty(artistId, artistName);
    }
  }
  return {
    contactId,
    artistId,
    agencyId: ensureCompanyParty(b.artist_company, "소속사/레이블"),
    productionId: ensureCompanyParty(b.production_company, "제작사"),
  };
}

function toArray(value) {
  if (value == null || value === "") return [];
  return Array.isArray(value) ? value : [value];
}


// ── 목록(URL = 필터; 플레이북2 §3.7) ──
router.get("/", requireAuth, (req, res) => {
  const user = req.user;
  const canCreate = canEdit(user); // 대표(열람전용)는 새 프로젝트 버튼 숨김
  const q = (req.query.q || "").toString().trim();
  const rows = listProjects(user, { q });
  const summaries = listProjectSummaries(rows.map((r) => r.id)); // 인라인 요약(배치 2쿼리)

  const searched = Boolean(q);
  // 진행 중 / 완료로 분리. 완료 = 다가오는 세션 없음 + 미완료 작업 없음 + 활동 있었음(data.js is_completed).
  const ongoing = rows.filter((r) => !r.is_completed);
  const done = rows.filter((r) => r.is_completed);
  // 두 섹션 모두 접기 가능. 진행 중은 기본 펼침, 완료는 기본 접힘(완료가 쌓여도 목록을 짧게 유지 — 개수는 헤딩에 유지).
  // summary는 사이드바 메뉴처럼 은은하게 — 테두리·배경 없이 옅은 hover(bg-surface)만.
  const projectSection = (title, arr, { open = true } = {}) =>
    arr.length
      ? `<details class="group"${open ? " open" : ""}>
           <summary class="flex cursor-pointer list-none items-center justify-between gap-3 rounded-lg px-3 py-2 text-fg/80 transition-colors hover:bg-surface hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/30">
             <span class="flex items-baseline gap-2 font-display text-base font-semibold">${title}<span class="text-sm font-normal text-muted">${arr.length}</span></span>
             ${detailsChevron()}
           </summary>
           <div class="mt-2 space-y-2">${arr.map((p) => projectListRow(p, summaries[p.id])).join("")}</div>
         </details>`
      : "";
  let list;
  if (!rows.length) {
    list = searched
      ? emptyState(`"${esc(q)}" 검색 결과가 없습니다.`, { card: true })
      : emptyState("프로젝트가 없습니다.", { card: true, icon: "projects", cta: canCreate ? { href: "/projects/new", label: "+ 새 프로젝트" } : null });
  } else {
    const ongoingSec = projectSection("진행 중", ongoing);
    const doneSec = projectSection("완료", done, { open: false }); // 완료는 기본 접힘
    list = `${ongoingSec}${doneSec ? `<div class="${ongoingSec ? "mt-4" : ""}">${doneSec}</div>` : ""}`;
  }

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

/**
 * 다음 방문(다가오는 세션) 한 줄 — `listProjects`가 파생하는 next_session_date(오늘 이후·취소 제외 최소일).
 * 임박(D-3 이내)하면 브랜드색으로 강조해 "다음 방문이 언제인지"를 목록에서 바로 파악.
 */
function nextSessionLine(p) {
  if (!p.next_session_date) return "";
  const d = daysUntilYmd(p.next_session_date);
  const dday = d === 0 ? "오늘" : d > 0 ? `D-${d}` : `${-d}일 지남`;
  const cls = d != null && d <= 3 ? "font-medium text-primary" : "text-muted";
  return `<div class="mt-0.5 text-xs ${cls}">다음 세션 ${esc(formatYmdShort(p.next_session_date))} · ${dday}</div>`;
}

/** 프로젝트의 항목(트랙) 개수. track_titles("||" 연결)에서 파생. */
function trackCount(p) {
  if (!p || !p.track_titles) return 0;
  return String(p.track_titles).split("||").map((s) => s.trim()).filter(Boolean).length;
}

/**
 * 목록 행 — 두 클릭 영역:
 *  ① 상단(제목 / 아티스트·회사 / 우측 PM·금액) → 프로젝트 상세로 이동(<a>).
 *  ② 하단 요약 줄(곡·콘텐츠·예정/완료 세션 수) → 접기 토글, 펼치면 세션 일정·곡별 작업자 인라인 요약(프로젝트 안 안 가고 미리보기).
 */
function projectListRow(p, summary) {
  const metaLine = [p.artist, p.client_name, contactMetaPart(p)].filter(Boolean).join(" · ") || "정보 미정";
  const n = trackCount(p);
  const amt = projectAmount(p);
  const amountLine = amt
    ? `<div class="text-sm font-medium tabular">${formatKRW(amt)}</div>`
    : `<div class="text-sm text-muted">견적 미정</div>`;
  const pmLine = p.manager_name ? `<div class="text-xs text-muted">PM ${esc(p.manager_name)}</div>` : "";
  // 세션(예정·완료)을 앞에, 곡·콘텐츠 뒤에. 곡·콘텐츠 있으면 작업 개수 + 상태(대기/진행중/완료) 병기.
  const taskCnt = Number(p.task_cnt) || 0;
  const taskStatus = [
    Number(p.task_pending) ? `대기 ${p.task_pending}` : "",
    Number(p.task_prog) ? `진행중 ${p.task_prog}` : "",
    Number(p.task_done) ? `완료 ${p.task_done}` : "",
  ].filter(Boolean).join(" · ");
  const trackPart = n
    ? `곡·콘텐츠 ${n}${taskCnt ? ` · 작업 ${taskCnt}${taskStatus ? ` (${taskStatus})` : ""}` : ""}`
    : "곡·콘텐츠 미정";
  const counts = [
    Number(p.sess_scheduled) ? `예정 세션 ${p.sess_scheduled}` : "",
    Number(p.sess_done) ? `완료 세션 ${p.sess_done}` : "",
    trackPart,
  ].filter(Boolean).join(" · ");
  // 한 프로젝트 = 밝은 바탕(bg-surface=흰색) 라운드 블록 하나(제목행 + 요약 접기행). 블록 사이 여백(space-y)으로 구분.
  // 호버 강조는 두 영역(상단 링크 / 하단 요약 토글)에 각각 row-link(hover:bg-elevated/60)로 분리 — 위·아래가 따로 강조된다.
  // 내부 제목→요약 구분선은 옅게(border/40) 종속.
  return `
    <div class="overflow-hidden rounded-xl border border-border/60 bg-surface">
      <a href="/projects/${p.id}" class="row-link flex items-start justify-between gap-3 px-4 py-3">
        <div class="min-w-0">
          <div class="truncate font-semibold">${esc(p.title)}</div>
          <div class="mt-0.5 truncate text-sm text-fg/80">${esc(metaLine)}</div>
          ${nextSessionLine(p)}
        </div>
        <div class="shrink-0 pl-2 text-right">${pmLine}${amountLine}</div>
      </a>
      <details class="group/proj">
        <summary class="row-link flex cursor-pointer list-none items-center justify-between gap-2 border-t border-border/40 px-4 py-2 text-xs text-muted hover:text-fg">
          <span>${esc(counts)}</span>
          <svg class="h-3.5 w-3.5 shrink-0 transition-transform group-open/proj:rotate-180" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M6 8l4 4 4-4" /></svg>
        </summary>
        <div class="border-t border-border/40 bg-elevated/40 px-4 py-3 text-xs leading-relaxed">${projectSummaryHtml(summary)}</div>
      </details>
    </div>`;
}

/** 인라인 요약 본문 — 세션 일정(날짜·시간) + 곡·콘텐츠(아티스트·제목·작업자). data.listProjectSummaries 결과 1건. */
function projectSummaryHtml(s) {
  if (!s || (!s.sessions.length && !s.tracks.length)) {
    return `<span class="text-muted">등록된 세션·곡·콘텐츠가 없습니다.</span>`;
  }
  const blocks = [];
  if (s.sessions.length) {
    const items = s.sessions.slice(0, 8).map((se) => {
      const time = se.start_time ? ` ${esc(se.start_time)}${se.end_time ? "–" + esc(se.end_time) : ""}` : "";
      const st = se.status && se.status !== "예정" ? ` <span class="text-muted">· ${esc(se.status)}</span>` : "";
      return `<li><span class="tabular text-fg/80">${esc(formatYmdShort(se.session_date))}${time}</span> <span class="text-muted">· ${esc(se.session_type)}</span>${st}</li>`;
    }).join("");
    const more = s.sessions.length > 8 ? `<li class="text-muted">외 ${s.sessions.length - 8}건</li>` : "";
    blocks.push(`<div><div class="mb-0.5 font-medium text-fg/60">세션 ${s.sessions.length}</div><ul class="space-y-0.5">${items}${more}</ul></div>`);
  }
  if (s.tracks.length) {
    const items = s.tracks.slice(0, 10).map((tr) => {
      const artist = tr.artist ? `<span class="text-muted">${esc(tr.artist)} · </span>` : "";
      const eng = tr.engineers.length ? ` <span class="text-muted">(${esc(tr.engineers.join(", "))})</span>` : "";
      return `<li>${artist}<span class="text-fg/80">${esc(tr.title)}</span>${eng}</li>`;
    }).join("");
    const more = s.tracks.length > 10 ? `<li class="text-muted">외 ${s.tracks.length - 10}곡</li>` : "";
    // 작업 종류별 내역(튠 1 · 믹싱 1 · 마스터링 1) — 무슨 작업인지 한눈에.
    const typeSummary = s.taskTypes && s.taskTypes.length
      ? `<div class="mt-1 text-fg/70"><span class="text-muted">작업</span> ${s.taskTypes.map((t) => `${esc(t.label)} ${t.count}`).join(" · ")}</div>`
      : "";
    blocks.push(`<div><div class="mb-0.5 font-medium text-fg/60">곡·콘텐츠 ${s.tracks.length}</div><ul class="space-y-0.5">${items}${more}</ul>${typeSummary}</div>`);
  }
  return `<div class="grid gap-3 sm:grid-cols-2">${blocks.join("")}</div>`;
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
  const parties = resolveProjectParties(b); // 아티스트/소속사/제작사/담당자 → party 참조(+ 아티스트 표시·중복 방지)
  const info = db()
    .prepare(
      `INSERT INTO projects (title, project_type, artist, artist_company, production_company,
         artist_id, agency_id, production_id, contact_party_id, manager_id, memo)
       VALUES (@title, @project_type, @artist, @artist_company, @production_company,
         @artist_id, @agency_id, @production_id, @contact_party_id, @manager_id, @memo)`
    )
    .run({
      title,
      project_type: type,
      // 표시용 denormalized TEXT 유지(목록·요약 렌더). 정체성/청구는 party 참조가 진실원천.
      artist: String(b.artist || "").trim() || null,
      artist_company: String(b.artist_company || "").trim() || null,
      production_company: String(b.production_company || "").trim() || null,
      artist_id: parties.artistId,
      agency_id: parties.agencyId,
      production_id: parties.productionId,
      contact_party_id: parties.contactId,
      manager_id: b.manager_id ? Number(b.manager_id) : null,
      memo: String(b.memo || "").trim() || null,
    });
  res.redirect(`/projects/${info.lastInsertRowid}?flash=created`);
});

// ── 상세 ──
router.get("/:id", requireAuth, (req, res) => {
  const p = getProjectForUser(req.user, Number(req.params.id));
  if (!p) return res.status(404).send(errorPage({ code: 404, title: "프로젝트를 찾을 수 없습니다", message: "삭제되었거나 주소가 잘못되었습니다.", user: req.user }));
  renderProjectDetail(req, res, p);
});

// ── 프로젝트 삭제 (치프·스태프) ──
router.post("/:id/delete", requireEditor, (req, res) => {
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
    // 각 인보이스에 청구 항목을 붙여 청구 탭에서 펼쳐본다(입금·상태·삭제·PDF). 수정은 없음(발행=확정, 변경은 삭제 후 재발행). 프로젝트당 인보이스 소수라 N+1 무해.
    const invoiceRows = inv
      ? inv.rows.map((r) => {
          const pc = r.client_id ? getParty(r.client_id) : null;
          return {
            ...r,
            items: (listInvoiceItemsForInvoice(req.user, r.id) || {}).rows || [],
            // 청구처 정보(대표자·사업자번호·담당자) 카드 — 청구 탭 펼침에서 바로 확인. 프로젝트당 인보이스 소수라 N+1 무해.
            payerCard: pc ? payerInfoCard(pc, listPersonsForOrg(pc.id), !!getClientFile(pc.id, "biz_license"), { compact: true }) : "",
          };
        })
      : [];
    const unbilled = listUnbilledTasksForProject(req.user, p.id);
    const unbilledRows = unbilled ? unbilled.rows : [];
    const billable = listBillableSessionsForProject(req.user, p.id);
    const sessionRows = billable ? billable.rows : [];
    const unbilledForm = (unbilledRows.length || sessionRows.length) ? unbilledInvoiceForm(p, unbilledRows, sessionRows) : "";
    tabContent = invoicesSection({ project: p, rows: invoiceRows, isAdmin: showInvoice, collapsed: false, unbilledForm, unbilledCount: unbilledRows.length + sessionRows.length, openId: Number(req.query.open) || null });
  } else {
    const rateItems = editable ? listRateItems() : [];
    const sessionBundle2 = listSessionsForProject(req.user, p.id);
    tabContent = sessionsSection({ project: p, rows: sessionBundle2 ? sessionBundle2.rows : [], isAdmin: editable, managers, rateItems, defaultBooker: (req.user && req.user.name) || "" });
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
    p.production_company ? `제작사/운영사 ${esc(p.production_company)}` : "",
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
  const isFetch = req.get("X-Requested-With") === "fetch"; // 자동저장(AJAX)
  const title = String(b.title || "").trim();
  if (!title) {
    if (isFetch) return res.status(400).json({ ok: false, error: "프로젝트 명을 입력하세요." });
    const p = getProjectForUser(req.user, id);
    return renderProjectDetail(req, res, p, { ...b, id }, "프로젝트 명을 입력하세요.");
  }
  // project_type은 UPDATE에서 제외 → 기존 DB 값 보존(유형 구분은 UI에서 제거, 레거시 컬럼은 건드리지 않음).
  const parties = resolveProjectParties(b); // 아티스트/소속사/제작사/담당자 → party 참조
  db()
    .prepare(
      `UPDATE projects SET title=@title, artist=@artist, artist_company=@artist_company,
       production_company=@production_company, artist_id=@artist_id, agency_id=@agency_id,
       production_id=@production_id, contact_party_id=@contact_party_id, manager_id=@manager_id,
       memo=@memo WHERE id=@id`
    )
    .run({
      id,
      title,
      artist: String(b.artist || "").trim() || null,
      artist_company: String(b.artist_company || "").trim() || null,
      production_company: String(b.production_company || "").trim() || null,
      artist_id: parties.artistId,
      agency_id: parties.agencyId,
      production_id: parties.productionId,
      contact_party_id: parties.contactId,
      manager_id: b.manager_id ? Number(b.manager_id) : null,
      memo: String(b.memo || "").trim() || null,
    });
  if (isFetch) return res.json({ ok: true });
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
  const artist = String(req.body.artist || "").trim();
  let lastTrack = null;
  for (const title of titles) {
    const track = createTrack(req.user, projectId, { title, artist });
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
      // 자동저장(AJAX): 리다이렉트 대신 갱신된 헤더값 JSON 반환(종류 라벨·담당 엔지니어·금액).
      return res.json({
        ok: true,
        amount: task.is_invoiced && task.total_price ? formatKRW(task.total_price) : "",
        typeLabel: taskTypeLabel(task.task_type),
        engineerName: task.engineer_name || "",
        statusLabel: TASK_STATUS_LABELS[task.status] || task.status,
        statusCls: TASK_STATUS_BADGE[task.status] || "bg-muted/10 text-muted",
      });
    }
    res.redirect(`/projects/${task.project_id}?tab=tracks&flash=saved`);
  } catch (e) {
    if (e.message === "TASK_LOCKED") return res.status(400).send(errorPage({ code: 400, title: "수정 불가", message: "이미 청구된 작업은 수정할 수 없습니다.", user: req.user }));
    throw e;
  }
});

// 청구 폼에서 입력한 작업 금액을 즉시 작업에 저장(AJAX) — 초안이 아니라 바로 기록되어 목록·청구 폼 기본값에 반영.
router.post("/tasks/:taskId/amount", requireEditor, (req, res) => {
  try {
    const task = setTaskAmount(req.user, Number(req.params.taskId), parseMoney(req.body.amount));
    if (!task) return res.status(404).json({ ok: false });
    return res.json({ ok: true, amount: task.total_price });
  } catch (e) {
    if (e.message === "TASK_LOCKED") return res.status(400).json({ ok: false, error: "이미 청구된 작업은 금액을 바꿀 수 없습니다." });
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

/** req.body에서 `${prefix}_<id>` 금액 필드를 {id: 금액} 맵으로 추출(청구 폼에서 작업·세션별로 입력/조정한 금액). */
function extractAmountMap(body, prefix) {
  const out = {};
  const re = new RegExp(`^${prefix}_(\\d+)$`);
  for (const k of Object.keys(body || {})) {
    const m = re.exec(k);
    if (m) out[m[1]] = body[k];
  }
  return out;
}

router.post("/:id/invoices/from-tasks", requireBilling, (req, res) => {
  try {
    const inv = createInvoiceFromTasks(req.user, {
      projectId: Number(req.params.id),
      taskIds: toArray(req.body.task_id),
      sessionIds: toArray(req.body.session_id),
      clientId: (req.body.client_id ? Number(req.body.client_id) : null) || (req.body.payer_contact_id ? Number(req.body.payer_contact_id) : null), // 청구처=party id(콤보 어느 hidden이든 동일 의미)
      title: req.body.title,
      issueDate: cleanYmd(req.body.issued_date),
      dueDate: cleanYmd(req.body.due_date),
      discount: parseMoney(req.body.discount_amount),
      vatIncluded: req.body.vat_included != null, // 부가세 포함 체크박스(기본 체크) — 해제 시 미전송 → false(현금 거래)
      taskAmounts: extractAmountMap(req.body, "task_amount"), // 금액은 청구 시점 확정 — 작업별 입력/조정 금액
      sessionAmounts: extractAmountMap(req.body, "session_amount"), // 녹음 세션도 작업처럼 금액 수정 가능
    });
    if (!inv) return res.status(404).send(errorPage({ code: 404, title: "프로젝트를 찾을 수 없습니다", message: "삭제되었거나 주소가 잘못되었습니다.", user: req.user }));
    // createInvoiceFromTasks는 즉시 '발행' 상태로 생성 → 발행 알림 발송(notify는 fail-safe·비차단, 청구 흐름 비차단).
    notifyInvoiceIssued(inv);
    // 청구 메뉴로 이탈하지 않고 프로젝트 청구 탭으로 복귀 + 방금 만든 인보이스를 펼친 채(open) 노출.
    res.redirect(`/projects/${req.params.id}?tab=invoice&open=${inv.id}&flash=created`);
  } catch (e) {
    const known = { TASK_IDS_REQUIRED: "청구할 작업·세션을 선택하세요.", TASK_NOT_BILLABLE: "청구 가능한 작업·세션만 선택할 수 있습니다.", CLIENT_NOT_FOUND: "선택한 청구처를 찾을 수 없습니다.", TASK_AMOUNT_REQUIRED: "청구할 작업·세션의 금액을 입력하세요(0원은 청구할 수 없습니다).", PAYER_TAX_INFO_REQUIRED: "청구처(회사)에 세금계산서 정보(사업자등록번호)가 없습니다. 클라이언트 상세에서 입력한 뒤 청구하세요.", PAYER_CASH_RECEIPT_REQUIRED: "청구처(개인)에 현금영수증 정보가 없습니다. 청구처 상세에서 입력한 뒤 청구하세요." };
    if (!known[e.message]) throw e; // 알 수 없는 오류(DB 등)는 전역 핸들러(500+로깅)로 — 검증 실패로 위장 방지
    return res.status(400).send(errorPage({ code: 400, title: "청구 오류", message: known[e.message], user: req.user }));
  }
});

// 청구서 생성 전 미리보기 PDF 발행(견적서·내역서·거래명세서) — 청구서 레코드를 만들지 않고 선택 항목·금액을 그대로 문서화.
// 계산서(세금계산서) 발행이 필요할 때 '선택 항목으로 청구 생성'을 눌러 인보이스를 만든다(발행=확정).
router.post("/:id/invoices/preview.pdf", requireBilling, asyncHandler(async (req, res) => {
  const b = req.body;
  let draft;
  try {
    draft = invoiceDraftForPdf(req.user, {
      projectId: Number(req.params.id),
      taskIds: toArray(b.task_id),
      sessionIds: toArray(b.session_id),
      clientId: (b.client_id ? Number(b.client_id) : null) || (b.payer_contact_id ? Number(b.payer_contact_id) : null),
      title: b.title,
      issueDate: cleanYmd(b.issued_date),
      dueDate: cleanYmd(b.due_date),
      discount: parseMoney(b.discount_amount),
      vatIncluded: b.vat_included != null,
      taskAmounts: extractAmountMap(b, "task_amount"),
      sessionAmounts: extractAmountMap(b, "session_amount"),
    });
  } catch (e) {
    const known = { TASK_IDS_REQUIRED: "문서로 만들 작업·세션을 선택하세요.", TASK_NOT_BILLABLE: "청구 가능한 작업·세션만 선택할 수 있습니다.", CLIENT_NOT_FOUND: "선택한 청구처를 찾을 수 없습니다." };
    if (!known[e.message]) throw e;
    return res.status(400).send(errorPage({ code: 400, title: "문서 오류", message: known[e.message], user: req.user }));
  }
  if (!draft) return res.status(404).send(errorPage({ code: 404, title: "프로젝트를 찾을 수 없습니다", message: "삭제되었거나 주소가 잘못되었습니다.", user: req.user }));
  const docType = normalizeDocType(req.query.type);
  let pdf;
  try {
    pdf = await renderInvoicePdf({ studio: getStudioInfo(), logo: getStudioLogo(), client: draft.client, invoice: draft.invoice, items: draft.items, docType });
  } catch (e) {
    if (e && e.message === "PDF_RENDERER_UNAVAILABLE") {
      return res.status(503).send(errorPage({ code: 503, title: "PDF 생성 일시 불가", message: "서버 PDF 렌더러(@resvg/resvg-js)가 로드되지 않았습니다. 배포 환경의 네이티브 모듈 설치를 확인하세요.", user: req.user }));
    }
    throw e;
  }
  res.setHeader("Content-Type", "application/pdf");
  res.setHeader("Content-Disposition", `inline; filename*=UTF-8''${encodeURIComponent((draft.invoice.title || docType) + ".pdf")}`);
  res.setHeader("Cache-Control", "private, no-store");
  res.send(pdf);
}));

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
          ${artistCombo(p)}
        </div>
        <div>
          <label class="label">소속사/레이블</label>
          ${companyCombo("artist_company", p.artist_company, "소속사/레이블", "소속사/레이블")}
        </div>
        <div>
          <label class="label">제작사/운영사</label>
          ${companyCombo("production_company", p.production_company, "제작사", "제작사/운영사")}
        </div>
      </div>
      <div>
        <label class="label">고객측 담당자</label>
        ${personCombo({ selectedId: p.contact_party_id, options: contactOptions(), companyOptions: partyOptions({ role: "company" }) })}
      </div>
      <div>
        <label class="label">프로젝트 매니저</label>
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
  // 명시적 저장 버튼(변경 시 하이라이트) — app.js [data-dirty-form] 공통 처리.
  return `
    <form method="post" action="/projects/${p.id}" class="space-y-3" data-dirty-form>
      ${err ? `<p class="rounded-lg bg-danger/10 px-3 py-2 text-sm text-danger">${esc(err)}</p>` : ""}
      <div class="grid gap-3 sm:grid-cols-2">
        <div>
          <label class="label">프로젝트 명</label>
          <input class="input" name="title" value="${esc(p.title || "")}" required />
        </div>
        <div>
          <label class="label">아티스트</label>
          ${artistCombo(p)}
        </div>
      </div>
      <div class="grid gap-3 sm:grid-cols-2">
        <div>
          <label class="label">소속사/레이블</label>
          ${companyCombo("artist_company", p.artist_company, "소속사/레이블", "소속사/레이블")}
        </div>
        <div>
          <label class="label">제작사/운영사</label>
          ${companyCombo("production_company", p.production_company, "제작사", "제작사/운영사")}
        </div>
      </div>
      <div>
        <label class="label">고객측 담당자</label>
        ${personCombo({ selectedId: p.contact_party_id, options: contactOptions(), companyOptions: partyOptions({ role: "company" }) })}
      </div>
      <div>
        <label class="label">프로젝트 매니저</label>
        ${managerSelect(p.manager_id)}
      </div>
      <div>
        <label class="label">메모</label>
        <textarea class="input" name="memo" rows="3">${esc(p.memo || "")}</textarea>
      </div>
      ${projectFieldDatalists()}
      <div class="flex items-center justify-end gap-3">
        <span class="text-xs text-warning" data-dirty-hint hidden>저장되지 않은 변경사항</span>
        <button type="submit" class="btn-primary transition" data-dirty-save>저장</button>
      </div>
    </form>`;
}

/**
 * 아티스트 콤보(커스텀) — 타이핑=기존 아티스트·사람 검색, 빈 입력=[검색]/[새 아티스트] 팝업(전체 목록 덤프 방지).
 * 기존 사람을 고르면 hidden artist_contact_id로 연결(저장 시 중복 사람 방지). '그룹' 체크=밴드/팀(연락처 연결 안 함).
 * CSP-safe: 옵션은 <script type="application/json">로 정적 임베드, 상호작용은 app.js([data-artist-combo]).
 */
function artistCombo(p = {}) {
  // 현재 아티스트 party(있으면)에서 콤보 초기값 파생: 연결 party id·그룹 여부·본명(활동명과 다르면).
  const artistParty = p.artist_id ? getParty(p.artist_id) : null; // getParty=getParty(compat)
  const meta = {
    contactId: artistParty ? artistParty.id : "",
    isGroup: artistParty ? artistParty.kind === "group" : false,
    realName: artistParty && artistParty.kind === "person" && artistParty.name && artistParty.name !== String(p.artist || "") ? artistParty.name : "",
  };
  // 아티스트 후보 = is_artist party(사람 solo + 그룹). 콤보 옵션 shape {name, contactId, realName, sub}.
  const opts = partyOptions({ role: "artist" }).map((o) => ({
    name: o.activity_name || o.name,
    contactId: o.id,
    realName: o.kind === "person" && o.activity_name && o.name && o.name !== o.activity_name ? o.name : "", // 본명(활동명과 다를 때)
    sub: o.sub,
  }));
  const json = JSON.stringify(opts).replace(/</g, "\\u003c"); // </script> 브레이크아웃 방지
  const companies = partyOptions({ role: "company" }); // 모달 소속사 select용
  return `
    <div data-artist-combo>
      <input type="hidden" name="artist_contact_id" value="${meta.contactId || ""}" data-artist-cid />
      <div class="relative">
        <input class="input pr-9" type="text" name="artist" value="${esc(p.artist || "")}" data-artist-input autocomplete="off"
          role="combobox" aria-expanded="false" aria-autocomplete="list" placeholder="아티스트명 — 검색 또는 새로 등록" />
        <span class="pointer-events-none absolute right-9 top-1/2 max-w-[45%] -translate-y-1/2 truncate text-sm text-muted${meta.realName ? "" : " hidden"}" data-artist-realname title="본명">(<span data-artist-realname-val>${esc(meta.realName || "")}</span>)</span>
        <svg class="pointer-events-none absolute right-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M6 8l4 4 4-4" /></svg>
        <div class="absolute left-0 right-0 z-30 mt-1 hidden max-h-64 overflow-auto rounded-lg border border-border bg-surface py-1 shadow-lg" data-artist-pop role="listbox"></div>
      </div>
      <script type="application/json" data-artist-options>${json}</script>
      <!-- 간이 등록 모달(프로젝트 폼 이탈 없이 새 아티스트/그룹 등록). name 없음(프로젝트 폼과 분리), app.js가 fetch로 생성. -->
      <div data-artist-modal class="fixed inset-0 z-50 hidden items-center justify-center bg-black/40 p-4">
        <div class="w-full max-w-sm space-y-3 rounded-xl border border-border bg-bg p-4 shadow-xl" role="dialog" aria-modal="true">
          <div class="font-display text-lg font-semibold">새 아티스트 등록</div>
          <div><label class="label">활동명(이름)</label><input class="input" data-am-name placeholder="아티스트 활동명" /></div>
          <label class="flex w-fit cursor-pointer items-center gap-1.5 text-sm text-muted"><input type="checkbox" data-am-group class="h-4 w-4 rounded border-border text-primary" /> 그룹(밴드·팀)</label>
          <div data-am-real-wrap><label class="label">본명 <span class="text-xs font-normal text-muted">(활동명과 다르면 · 개인)</span></label><input class="input" data-am-real placeholder="본명(선택)" /></div>
          <div><label class="label">소속사 <span class="text-xs font-normal text-muted">(선택)</span></label>
            <select class="input" data-am-agency><option value="">없음</option>${companies.map((co) => `<option value="${co.id}">${esc(co.name)}</option>`).join("")}</select></div>
          <div><label class="label">전화 <span class="text-xs font-normal text-muted">(선택)</span></label><input class="input" data-am-phone autocomplete="off" /></div>
          <div class="flex items-center gap-2 pt-1">
            <button type="button" class="btn-primary" data-am-save>등록</button>
            <button type="button" class="btn-ghost" data-am-cancel>취소</button>
            <span class="ml-1 hidden text-xs text-danger" data-am-err></span>
          </div>
        </div>
      </div>
    </div>`;
}

/**
 * 업체(소속사/레이블·제작사/운영사) 콤보 — 아티스트 콤보와 동일 UX(검색 + 새로 등록 모달).
 * 값은 업체명 TEXT(fieldName). 저장 시 ensureCompanyParty가 이름으로 찾/생성(중복 방지). CSP-safe(app.js [data-company-combo]).
 * @param {string} fieldName artist_company | production_company
 * @param {string} value 현재 업체명
 * @param {string} roleKey 기본 역할("소속사/레이블" | "제작사") — 모달 체크박스 기본값
 * @param {string} label 표시 라벨(소속사/레이블 · 제작사/운영사)
 */
function companyCombo(fieldName, value, roleKey, label) {
  const opts = partyOptions({ role: "company" }).map((o) => ({ name: o.name, sub: o.sub || "" }));
  const json = JSON.stringify(opts).replace(/</g, "\\u003c");
  const isProd = roleKey === "제작사";
  return `
    <div data-company-combo>
      <div class="relative">
        <input class="input pr-9" type="text" name="${fieldName}" value="${esc(value || "")}" data-cc-input autocomplete="off"
          role="combobox" aria-expanded="false" aria-autocomplete="list" placeholder="${esc(label)} — 검색 또는 새로 등록" />
        <svg class="pointer-events-none absolute right-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M6 8l4 4 4-4" /></svg>
        <div class="absolute left-0 right-0 z-30 mt-1 hidden max-h-64 overflow-auto rounded-lg border border-border bg-surface py-1 shadow-lg" data-cc-pop role="listbox"></div>
      </div>
      <script type="application/json" data-cc-options>${json}</script>
      <!-- 간이 등록 모달(name 없음 → 프로젝트 폼과 분리, app.js가 fetch로 생성). -->
      <div data-cc-modal class="fixed inset-0 z-50 hidden items-center justify-center bg-black/40 p-4">
        <div class="w-full max-w-sm space-y-3 rounded-xl border border-border bg-bg p-4 shadow-xl" role="dialog" aria-modal="true">
          <div class="font-display text-lg font-semibold">새 ${esc(label)} 등록</div>
          <div><label class="label">업체명</label><input class="input" data-cc-name placeholder="상호(업체명)" /></div>
          <div><label class="label">역할 <span class="text-xs font-normal text-muted">(겸업 가능)</span></label>
            <div class="flex flex-wrap gap-4">
              <label class="flex items-center gap-1.5 text-sm"><input type="checkbox" data-cc-agency ${isProd ? "" : "checked"} class="h-4 w-4 rounded border-border text-primary" /> 소속사/레이블</label>
              <label class="flex items-center gap-1.5 text-sm"><input type="checkbox" data-cc-prod ${isProd ? "checked" : ""} class="h-4 w-4 rounded border-border text-primary" /> 제작사/운영사</label>
            </div>
          </div>
          <div class="grid gap-3 sm:grid-cols-2">
            <div><label class="label">사업자등록번호</label><input class="input" data-cc-biz placeholder="000-00-00000" autocomplete="off" /></div>
            <div><label class="label">대표자</label><input class="input" data-cc-owner autocomplete="off" /></div>
          </div>
          <div class="grid gap-3 sm:grid-cols-2">
            <div><label class="label">이메일</label><input class="input" type="email" data-cc-email autocomplete="off" /></div>
            <div><label class="label">전화</label><input class="input" data-cc-phone autocomplete="off" /></div>
          </div>
          <div class="flex items-center gap-2 pt-1">
            <button type="button" class="btn-primary" data-cc-save>등록</button>
            <button type="button" class="btn-ghost" data-cc-cancel>취소</button>
            <span class="ml-1 hidden text-xs text-danger" data-cc-err></span>
          </div>
        </div>
      </div>
    </div>`;
}

/** 아티스트·소속사/레이블·제작사 자동완성 datalist(기존 프로젝트 값 기반). */
function projectFieldDatalists() {
  const f = distinctProjectFields();
  const dl = (id, values) => `<datalist id="${id}">${values.map((v) => `<option value="${esc(v)}"></option>`).join("")}</datalist>`;
  return dl("dl-artists", f.artists) + dl("dl-companies", f.companies) + dl("dl-productions", f.productions);
}

/** 내부 담당자(프로젝트 매니저) 선택 — 하우스/외주 엔지니어 목록. 고객측 담당자(personCombo)와 별개 필드. */
function managerSelect(selectedId) {
  const opts = listProjectManagers();
  return `
    <select name="manager_id" class="input">
      <option value="">프로젝트 매니저 미지정</option>
      ${opts.map((m) => `<option value="${m.id}" ${Number(selectedId) === m.id ? "selected" : ""}>${esc(m.name)}</option>`).join("")}
    </select>`;
}

function tracksSection({ project, tracks, isAdmin, managers = [], expandTaskId = null }) {
  const list = tracks.length
    ? tracks.map((track) => trackCard(track, { isAdmin, managers, expandTaskId })).join("")
    : emptyState("등록된 곡·콘텐츠가 없습니다.");
  const hint = isAdmin
    ? explain(`세션(예약·실시간 작업)과 <span class="text-muted">별개로</span> 곡·콘텐츠별 후반작업(보컬튠·믹싱·마스터링)을 관리합니다. 여기선 <span class="text-fg">종류·담당·진행 상태</span>만 기록하고, <span class="text-fg">금액은 청구 탭에서</span> 정합니다.`)
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
    <form method="post" action="/projects/${project.id}/tracks" class="rounded-lg border border-border bg-bg p-3 space-y-2">
      <div>
        <label class="label mb-1 text-xs">아티스트 <span class="font-normal text-muted">— 비우면 프로젝트 아티스트</span></label>
        <input class="input py-1.5 text-sm" name="artist" list="dl-artists" autocomplete="off" value="${esc(project.artist || "")}" placeholder="이 곡·콘텐츠의 아티스트" />
      </div>
      <div>
        <label class="label mb-1 text-xs">곡·콘텐츠 이름 <span class="font-normal text-muted">— 여러 곡은 줄바꿈으로 구분(같은 아티스트)</span></label>
        <div class="flex gap-2">
          <textarea class="input flex-1 py-1.5 text-sm" name="titles" rows="2" placeholder="곡명 또는 콘텐츠명&#10;한 줄에 하나씩 입력"></textarea>
          <button class="btn-primary shrink-0 self-end px-4 py-1.5 text-sm" type="submit">추가</button>
        </div>
      </div>
      ${projectFieldDatalists()}
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
          <div class="font-medium">${esc(track.title)}${track.artist ? `<span class="ml-1.5 text-xs font-normal text-muted">${esc(track.artist)}</span>` : ""}</div>
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
  // 분류 폐기 — 작업 종류별(보컬튠·믹싱 등)로 최고 진행 상태를 요약(이전 그룹 묶음 대체).
  const byType = {};
  for (const t of tasks) {
    const label = taskTypeLabel(t.task_type);
    if (byType[label] == null || (order[t.status] || 0) > (order[byType[label]] || 0)) byType[label] = t.status;
  }
  const parts = Object.keys(byType).map((label) => `${label} ${TASK_STATUS_LABELS[byType[label]] || byType[label]}`);
  return parts.length ? `<div class="mb-2 text-xs text-muted">진행: ${esc(parts.join(" · "))}</div>` : "";
}

function trackEditMenu(track, hasInvoiced) {
  return `
    <details class="group shrink-0 text-right">
      <summary class="flex cursor-pointer list-none items-center justify-end text-xs text-muted hover:text-fg">${detailsChevron()}</summary>
      <form method="post" action="/projects/tracks/${track.id}" class="mt-2 space-y-2 rounded-lg border border-border bg-surface p-3 text-left">
        <div><label class="label mb-0.5 text-xs">아티스트</label><input class="input py-1.5 text-sm" name="artist" list="dl-artists" autocomplete="off" value="${esc(track.artist || "")}" placeholder="비우면 프로젝트 아티스트" /></div>
        <div class="flex gap-2"><input class="input flex-1 py-1.5 text-sm" name="title" value="${esc(track.title)}" required />
        <button class="btn-primary shrink-0 btn-xs self-end" type="submit">저장</button></div>
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
  // 금액은 청구 탭에서 확정 — 작업 행엔 청구된 작업의 확정액만 표시(미청구는 숨김, '기록만' 일관).
  const amount = `<span class="text-sm font-semibold" data-row-amount>${task.is_invoiced && task.total_price ? formatKRW(task.total_price) : ""}</span>`;
  // 종류·담당은 작업 종류/엔지니어 변경 시 자동저장이 즉시 갱신(data-row-type/data-row-engineer).
  const title = `<span class="min-w-0 truncate text-sm"><span class="font-medium" data-row-type>${esc(label)}</span><span class="text-xs text-muted" data-row-engineer>${task.engineer_name ? " · " + esc(task.engineer_name) : ""}</span></span>`;
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
  // 편집 가능: 헤더 전체가 접기 토글. 상태 select는 헤더에 두어 접힌 채로도 수정 가능(form= 로 본문 폼에 연결, [data-no-toggle]로 펼침 방지).
  const statusSelect = `
    <span data-no-toggle>
      <select class="input w-24 py-1 text-xs" name="status" form="task-form-${task.id}" aria-label="상태">
        ${TASK_STATUSES.map((s) => `<option value="${esc(s)}" ${s === task.status ? "selected" : ""}>${esc(TASK_STATUS_LABELS[s] || s)}</option>`).join("")}
      </select>
    </span>`;
  return `
    <details id="task-${task.id}" class="group rounded-lg border border-border bg-surface"${open ? " open" : ""}>
      <summary class="flex cursor-pointer list-none items-center justify-between gap-2 p-2.5">
        ${title}
        <span class="flex shrink-0 items-center gap-2">
          ${amount}
          ${statusSelect}
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
  // 상태(status) select는 헤더에 있고 form= 로 이 폼에 연결됨(접힌 채 수정). 본문엔 종류·담당·외주단가만.
  // 명시적 저장 버튼(변경 시 하이라이트) — app.js [data-dirty-form] 공통. form.elements로 헤더 상태 select 변경도 감지.
  return `
    <form method="post" action="/projects/tasks/${task.id}" id="task-form-${task.id}" class="grid gap-2 sm:grid-cols-2" data-dirty-form>
      <div>
        <label class="label mb-0.5 text-xs">작업 종류</label>
        <select class="input py-1.5 text-sm" name="task_type">${taskTypeOptions(task.task_type)}</select>
      </div>
      <div>
        <label class="label mb-0.5 text-xs">담당 엔지니어</label>
        <select class="input py-1.5 text-sm" name="engineer_id">${engineerSelect(managers, task)}</select>
      </div>
      <div data-worker-rate>
        <label class="label mb-0.5 text-xs">외주 지급단가 <span class="font-normal text-muted">(정산 기준 · 원)</span></label>
        <input class="input py-1.5 text-sm" name="worker_rate" inputmode="numeric" placeholder="0" value="${esc(String(task.worker_rate || ""))}" />
      </div>
      ${legacyName ? `<input type="hidden" name="engineer_name" value="${esc(legacyName)}" />` : ""}
      <div class="flex items-center justify-end gap-2 sm:col-span-2">
        <span class="text-xs text-warning" data-dirty-hint hidden>저장되지 않은 변경사항</span>
        <button class="btn-primary btn-xs transition" type="submit" data-dirty-save>작업 저장</button>
      </div>
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
      <input type="hidden" name="status" value="Pending" />
      <button class="rounded-md border border-border bg-bg btn-xs hover:border-primary hover:text-primary" type="submit">${esc(t.label)}</button>
    </form>`;
  const flatOptions = types.map((t) => `<option value="${esc(t.key)}">${esc(t.label)}</option>`).join(""); // 분류 폐기 — optgroup 없이 평면 목록
  const other = `
    <details class="align-top">
      <summary class="cursor-pointer list-none rounded-md border border-border bg-bg btn-xs hover:border-primary hover:text-primary">+ 기타</summary>
      <form method="post" action="/projects/tracks/${track.id}/tasks" class="mt-2 flex flex-wrap items-center gap-2 rounded-lg border border-border bg-surface p-2">
        <select class="input py-1.5 text-sm" name="task_type">${flatOptions}</select>
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
  // 작업 예상 금액 = 확정 total_price(>0) 우선, 없으면 종류 기본단가(taskTypeUnitPrice). 프로젝트 목록 합산과 동일 규칙.
  const taskAmt = (t) => (t.total_price > 0 ? t.total_price : taskTypeUnitPrice(t.task_type));
  const subtotal =
    tasks.filter(isDone).reduce((sum, task) => sum + taskAmt(task), 0) +
    sessionRows.reduce((sum, s) => sum + (s.billing ? s.billing.amount : 0), 0);
  const tax = Math.round(subtotal * 0.1);
  const taskList = tasks
    .map((task) => {
      const label = taskTypeLabel(task.task_type);
      const done = isDone(task);
      const amt = taskAmt(task);
      const statusTag = done ? "" : ` <span class="text-xs font-normal text-warning">${esc(TASK_STATUS_LABELS[task.status] || task.status)}</span>`;
      return `
        <div class="flex items-center gap-2 border-b border-border py-2 last:border-0 ${done ? "" : "opacity-60"}" data-line-row>
          <input class="shrink-0" type="checkbox" name="task_id" value="${task.id}" data-line-amount="${amt}" ${done ? "checked" : "data-confirm-pending"} id="task-cb-${task.id}" />
          <label for="task-cb-${task.id}" class="min-w-0 flex-1 cursor-pointer text-sm font-medium">${esc(task.track_title)} · ${esc(label)}${statusTag}</label>
          <div class="relative w-28 shrink-0">
            <input class="input py-1 pr-7 text-right text-sm tabular" type="text" inputmode="numeric" name="task_amount_${task.id}" value="${amt || ""}" data-line-input placeholder="0" aria-label="${esc(label)} 금액" />
            <span class="pointer-events-none absolute inset-y-0 right-2 flex items-center text-xs text-muted">원</span>
          </div>
        </div>`;
    })
    .join("");
  // 녹음 세션 직접 청구 후보(곡·콘텐츠/버튼 없이 자동 노출). 체크하면 인보이스 라인으로 들어간다.
  const sessionList = sessionRows
    .map((s) => {
      const mins = s.billing.minutes;
      const dur = `${Math.floor(mins / 60)}시간${mins % 60 ? " " + (mins % 60) + "분" : ""}`;
      const time = [s.start_time, s.end_time].filter(Boolean).join("–");
      const label = `녹음 세션 ${formatYmdShort(s.session_date)} · ${s.billing.item.name}`;
      return `
        <div class="flex items-center gap-2 border-b border-border py-2 last:border-0" data-line-row>
          <input class="shrink-0" type="checkbox" name="session_id" value="${s.id}" data-line-amount="${s.billing.amount}" checked id="session-cb-${s.id}" />
          <label for="session-cb-${s.id}" class="min-w-0 flex-1 cursor-pointer">
            <span class="block text-sm font-medium">${esc(label)}</span>
            <span class="block text-xs text-muted">${esc(dur)}${time ? " · " + esc(time) : ""}</span>
          </label>
          <div class="relative w-28 shrink-0">
            <input class="input py-1 pr-7 text-right text-sm tabular" type="text" inputmode="numeric" name="session_amount_${s.id}" value="${s.billing.amount || ""}" data-line-input placeholder="0" aria-label="${esc(label)} 금액" />
            <span class="pointer-events-none absolute inset-y-0 right-2 flex items-center text-xs text-muted">원</span>
          </div>
        </div>`;
    })
    .join("");
  const total = subtotal + tax;
  return `
    <form method="post" action="/projects/${project.id}/invoices/from-tasks" class="rounded-lg border border-border bg-bg p-3" data-discount-form data-supply="${subtotal}">
      <div class="mb-2">
        <h3 class="text-sm font-semibold">청구 생성 <span class="text-xs font-normal text-muted">(미청구 작업 · 녹음 세션)</span></h3>
      </div>
      <div class="mb-2">
        <label class="label mb-1 text-xs">청구 제목</label>
        <input class="input" name="title" value="${esc(project.title)} 청구" />
      </div>
      <div class="mb-2">
        <label class="label mb-1 text-xs">청구처 <span class="font-normal text-muted">— 미선택 시 자동(제작사 › 소속사 › 아티스트)</span></label>
        ${payerCombo({ selectedId: project.production_id || project.agency_id || project.artist_id, clientOptions: clientOptions(), contactOptions: contactOptions(), ...payerDocMeta() })}
        <p data-payer-warn class="mt-1.5 hidden rounded-lg bg-warning/10 px-3 py-2 text-sm text-warning"></p>
      </div>
      <div class="label mb-1 text-xs">청구 항목</div>
      <div class="rounded-lg border border-border bg-surface px-3">${sessionList}${taskList}</div>
      ${hasPending ? explain(`미완료(대기·진행중) 작업은 기본 선택에서 제외됩니다. 필요하면 직접 체크하세요.`) : ""}
      <div class="mt-3 space-y-2">
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
        <div class="mb-2">
          <div class="mb-1 text-xs text-muted">문서 발행 <span class="font-normal">— 청구서를 만들지 않고 선택 항목으로 PDF만</span></div>
          <div class="grid grid-cols-3 gap-2">
            <button class="btn-ghost btn-sm" type="submit" formaction="/projects/${project.id}/invoices/preview.pdf?type=${encodeURIComponent("견적서")}" formtarget="_blank">견적서</button>
            <button class="btn-ghost btn-sm" type="submit" formaction="/projects/${project.id}/invoices/preview.pdf?type=${encodeURIComponent("내역서")}" formtarget="_blank">내역서</button>
            <button class="btn-ghost btn-sm" type="submit" formaction="/projects/${project.id}/invoices/preview.pdf?type=${encodeURIComponent("거래명세서")}" formtarget="_blank">거래명세서</button>
          </div>
        </div>
        ${explain(`<span class="font-medium text-fg">계산서 발행</span>이 필요할 때 아래 '청구 생성'을 누르면 청구서가 만들어지고 바로 발행됩니다(발행 후 청구처 변경 불가).`, { cls: "mb-2" })}
        <button class="btn-primary w-full btn-sm" type="submit" data-invoice-submit>선택 항목으로 청구 생성 <span data-inv-doc>(계산서 발행)</span></button>
      </div>
    </form>`;
}

module.exports = router;
