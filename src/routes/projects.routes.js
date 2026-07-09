"use strict";

const express = require("express");
const { db } = require("../db");
const { requireAuth, requireEditor, requireBilling, requireChief, canEdit, canBill, isChief, isStaffOrChief } = require("../auth");
const {
  TASK_STATUS_LABELS,
  TASK_STATUS_BADGE,
  normalizeProjectType,
  normalizeDocType,
  docNumberWithType,
} = require("../config");
const { config } = require("../config");
const { renderInvoicePdf } = require("../invoice-pdf");
const { asyncHandler } = require("../lib/async");
const { logAudit } = require("../lib/audit"); // 파괴적·재무 액션 기록(fail-safe)
const {
  listProjects,
  listProjectSummaries,
  getProjectForUser,
  deleteProject,
  createGroup,
  resolvePersonByName,
  getParty,
  listProjectManagers,
  listRateItems,
  taskTypeLabel,
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
  setTaskStatus,
  setTaskWaived,
  deleteTask,
  createInvoiceFromTasks,
  invoiceDraftForPdf,
  getClientFile,
  listPersonsForOrg,
  getStudioInfo,
  getStudioLogo,
  ensureCompanyParty,
  resolvePartyByDisplay,
  setProjectArtists,
} = require("../data");
const { layout, pageHeader, esc, formatKRW, flashBanner, errorPage, emptyState, tabBar: renderTabs, searchBox } = require("../views");
const { deliverablesSection } = require("../views.deliverables");
const { invoicesSection, payerInfoCard } = require("../views.invoices");
const { sessionsSection } = require("../views.sessions");
const {
  newProjectMenu,
  projectListRow,
  projectForm,
  projectMetaCard,
  projectMetaReadonly,
  tracksSection,
  unbilledInvoiceForm,
  sessionInvoicedModal,
} = require("../views.projects");
const { isValidYmd } = require("../lib/date");
const { parseMoney, formatBizNo } = require("../lib/forms");
const { notifyInvoiceIssued } = require("../notify");

const router = express.Router();

function cleanYmd(v) {
  const s = String(v || "").trim();
  return isValidYmd(s) ? s : null;
}

// ensureCompanyParty는 parties.js 공용을 사용(로컬 중복 제거 — 2026-07-05 전수점검).

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
  // 아티스트 = 콤마로 여러 명 가능(2026-07-05 사용자 요청): "아이유, 태연" → 각 이름을 party로 해석해
  // project_artists(다대다)에 전부 기록, artist_id=첫(대표) 아티스트(청구처 파생·레거시 호환), artist TEXT=정규화된 콤마 목록(표시).
  const artistNames = String(b.artist || "").split(",").map((s) => s.trim()).filter(Boolean);
  let artistIds = [];
  if (artistNames.length === 1) {
    // 단일 = 기존 경로 그대로(그룹 체크·명시 선택 artist_contact_id·본명 입력칸 모두 유효)
    const artistName = artistNames[0];
    if (b.artist_is_group) {
      const ex = db().prepare("SELECT id FROM parties WHERE kind = 'group' AND name = ? ORDER BY id LIMIT 1").get(artistName);
      artistIds = [ex ? ex.id : createGroup({ name: artistName })];
    } else if (b.artist_contact_id) {
      artistIds = [Number(b.artist_contact_id)];
      markArtistParty(artistIds[0], artistName);
    } else {
      const realName = String(b.artist_real_name || "").trim();
      artistIds = [resolvePersonByName(realName || artistName)];
      markArtistParty(artistIds[0], artistName);
    }
  } else if (artistNames.length > 1) {
    // 다중 = 각 이름 독립 해석(그룹 체크·명시 id·본명칸은 단일 전용이라 무시 — 이름 안전망이 커버):
    // 기존 그룹 정확 일치 → 그 그룹 / 사람은 resolvePersonByName(유일·라벨·활동명 안전망, 없으면 생성) + 아티스트 마킹.
    for (const nm of artistNames) {
      const g = db().prepare("SELECT id FROM parties WHERE kind = 'group' AND name = ? ORDER BY id LIMIT 1").get(nm);
      if (g) { artistIds.push(g.id); continue; }
      const pid = resolvePersonByName(nm);
      markArtistParty(pid, nm);
      artistIds.push(pid);
    }
    artistIds = [...new Set(artistIds)]; // "아이유, 아이유" 같은 중복 제거
  }
  const artistId = artistIds[0] || null;
  const artistText = artistNames.join(", ") || null; // 표시 TEXT 정규화("아이유,태연"→"아이유, 태연")
  // 제작/운영: 콤보에서 사람(관계자·개인) 또는 회사를 선택하면 hidden production_party_id로 party id가 온다 → 그 party를 직접 사용
  // (개인이 제작·운영하는 경우 지원, 2026-07-05). 없으면(새 이름 타이핑·id 미확정) ①기존 party 표시명 해석(resolvePartyByDisplay —
  // 회사 상호·사람 본명/라벨/활동명; 사람 라벨 "조형우 (형우비트)"가 회사로 오생성되는 것 방지) ②그래도 없으면 새 회사 생성.
  // 다운스트림 client_id 파생은 kind 무관(COALESCE JOIN).
  const prodPartyId = b.production_party_id ? Number(b.production_party_id) : null;
  const prodText = String(b.production_company || "").trim();
  return {
    contactId,
    artistId,
    artistIds,
    artistText,
    agencyId: ensureCompanyParty(b.artist_company, "소속사/레이블"),
    productionId: prodPartyId || (prodText ? resolvePartyByDisplay(prodText) || ensureCompanyParty(prodText, "제작사") : null),
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
  // 완료 탭 = 청구 대기 큐(2026-07-05 사용자 요청): 미청구 항목 있는 프로젝트를 위로, 청구 끝난 것은 아래로.
  // 그룹 내 순서는 생성일 최신순 유지(Array.sort 안정 정렬 — SQL이 이미 created_at DESC).
  const done = rows.filter((r) => r.is_completed).sort((a, b) => (Number(b.unbilled_cnt) > 0 ? 1 : 0) - (Number(a.unbilled_cnt) > 0 ? 1 : 0));
  // 접기 섹션 → 탭바(연락처 방식). ?tab=active(기본)/done, 검색어 유지. 활성 탭 목록만 렌더.
  const tab = req.query.tab === "done" ? "done" : "active";
  const activeRows = tab === "done" ? done : ongoing;
  const projTabs = rows.length
    ? renderTabs({
        tabs: [
          { key: "active", label: `진행 중 ${ongoing.length}` },
          { key: "done", label: `완료 ${done.length}` },
        ],
        activeKey: tab,
        hrefFn: (k) => `/projects?tab=${k}${q ? "&q=" + encodeURIComponent(q) : ""}`,
      })
    : "";
  let list;
  if (!rows.length) {
    list = searched
      ? emptyState(`"${esc(q)}" 검색 결과가 없습니다.`, { card: true })
      : emptyState("프로젝트가 없습니다.", { card: true, icon: "projects", cta: canCreate ? { href: "/projects/new", label: "+ 새 프로젝트" } : null });
  } else if (!activeRows.length) {
    list = emptyState(tab === "done" ? "완료된 프로젝트가 없습니다." : "진행 중인 프로젝트가 없습니다.", { card: true });
  } else {
    const chief = isChief(req.user); // 치프만 목록에서 작성일 인라인 수정
    list = `<div class="space-y-2">${activeRows.map((p) => projectListRow(p, summaries[p.id], { isChief: chief, tab, q })).join("")}</div>`;
  }

  const action = canCreate ? newProjectMenu() : "";

  const searchBar = searchBox({
    action: "/projects", q, placeholder: "프로젝트 · 아티스트 검색", label: "프로젝트 검색",
    suggestUrl: "/projects/suggest", hidden: `<input type="hidden" name="tab" value="${esc(tab)}" />`,
  });
  const resultNote = searched
    ? `<div class="mb-3 text-sm text-muted">"${esc(q)}" 결과 ${rows.length}건 · <a href="/projects" class="text-primary hover:underline">전체 보기</a></div>`
    : "";

  const body = `
    ${pageHeader({ title: "프로젝트", desc: "전체 프로젝트", action })}
    ${searchBar}
    ${resultNote}
    ${projTabs}
    ${list}`;
  res.send(layout({ title: "프로젝트", user, current: "/projects", body }));
});

// ── 검색 제안(typeahead JSON) — 반드시 /:id 앞에 등록 ──
router.get("/suggest", requireAuth, (req, res) => {
  const q = String(req.query.q || "").trim();
  if (!q) return res.json([]);
  const rows = listProjects(req.user, { q }).slice(0, 8);
  res.json(rows.map((p) => ({
    label: p.title,
    sub: [p.artist, p.production_company || p.artist_company].filter(Boolean).join(" · "),
    href: `/projects/${p.id}`,
  })));
});

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
      artist: parties.artistText, // 콤마 다중 정규화("아이유, 태연")
      artist_company: String(b.artist_company || "").trim() || null,
      production_company: String(b.production_company || "").trim() || null,
      artist_id: parties.artistId,
      agency_id: parties.agencyId,
      production_id: parties.productionId,
      contact_party_id: parties.contactId,
      manager_id: b.manager_id ? Number(b.manager_id) : null,
      memo: String(b.memo || "").trim() || null,
    });
  setProjectArtists(info.lastInsertRowid, parties.artistIds); // 다대다 전체 기록(각 아티스트 상세 '연결 프로젝트' 매칭)
  res.redirect(`/projects/${info.lastInsertRowid}?flash=created`);
});

// ── 작성일(생성일) 수정 (치프 전용) — 목록에서 인라인 date 입력, 시각(HH:MM:SS)은 보존 ──
router.post("/:id/created-at", requireChief, (req, res) => {
  const id = Number(req.params.id);
  const date = String(req.body.created_at || "").trim();
  const p = db().prepare("SELECT created_at FROM projects WHERE id = ?").get(id);
  if (p && /^\d{4}-\d{2}-\d{2}$/.test(date)) {
    const timePart = String(p.created_at || "").slice(10); // " HH:MM:SS"(있으면 보존해 같은 날 정렬 안정)
    db().prepare("UPDATE projects SET created_at = ? WHERE id = ?").run(date + (timePart || " 00:00:00"), id);
  }
  const tab = req.body.tab === "done" ? "done" : "active";
  const q = String(req.body.q || "").trim();
  res.redirect(`/projects?tab=${tab}${q ? "&q=" + encodeURIComponent(q) : ""}`);
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
  logAudit(req.user, "project.delete", `#${req.params.id}`);
  res.redirect("/projects?flash=deleted");
});

function renderProjectDetail(req, res, p, formState = null, err = "") {
  const editable = canEdit(req.user); // 치프/스태프/대표 편집(2026-07-07 대표 개방)
  const showDeliverables = isStaffOrChief(req.user); // 자료 전달 탭은 치프·스태프만(대표 숨김)
  const showInvoice = canBill(req.user); // 청구 섹션=치프·대표·스태프(청구서 발행)
  const managers = editable ? listProjectManagers() : []; // 작업·세션 엔지니어 선택용(담당자 마스터)

  const meta = editable
    ? projectMetaCard({ ...p, ...(formState || {}) }, err)
    : projectMetaReadonly(p);

  const desc = p.artist || p.client_name || "프로젝트";

  // ── 탭: 프로젝트 / 세션 일정 / 곡·콘텐츠 / 자료 전달 / 청구(청구권자만) ──
  // 메타 카드는 '프로젝트' 탭(첫 탭·기본). 유형 구분 없이 모든 프로젝트가 세션 일정 탭을 가진다.
  const tabs = [{ key: "project", label: "정보" }];
  tabs.push({ key: "sessions", label: "세션 일정" });
  tabs.push({ key: "tracks", label: "곡 · 콘텐츠" });
  if (showDeliverables) tabs.push({ key: "deliverables", label: "자료 전달" }); // 자료 전달은 치프·스태프만, 대표 제외
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
  } else if (tab === "deliverables" && showDeliverables) {
    const deliv = listDeliverablesForProject(req.user, p.id);
    tabContent = deliverablesSection({ project: p, rows: deliv ? deliv.rows : [], isAdmin: editable, baseUrl: config.baseUrl, collapsed: false });
  } else if (tab === "invoice" && showInvoice) {
    const inv = listInvoicesForProject(req.user, p.id);
    // 각 인보이스에 청구 항목을 붙여 청구 탭에서 펼쳐본다(입금·상태·삭제·PDF). 수정은 없음(발행=확정, 변경은 삭제 후 재발행). 프로젝트당 인보이스 소수라 N+1 무해.
    const invoiceRows = inv
      ? inv.rows.map((r) => {
          const pc = r.payer_id ? getParty(r.payer_id) : null; // 청구처=payer_id(2026-07-09 감사 — 드롭된 레거시 client_id 참조로 카드가 항상 빈 값이던 회귀 수정)
          return {
            ...r,
            items: (listInvoiceItemsForInvoice(req.user, r.id) || {}).rows || [],
            // 청구처 정보(대표자·사업자번호·담당자) 카드 — 청구 탭 펼침에서 바로 확인. 프로젝트당 인보이스 소수라 N+1 무해.
            payerCard: pc ? payerInfoCard(pc, listPersonsForOrg(pc.id), !!getClientFile(pc.id, "biz_license"), { compact: true, returnTo: `/projects/${p.id}?tab=invoice&open=${r.id}` }) : "",
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

// ── 예전 수정 URL은 상세 편집 화면으로 정규화 ──
router.get("/:id/edit", requireEditor, (req, res) => {
  res.redirect(`/projects/${Number(req.params.id)}`);
});

// 청구처 발행 정보 인라인 저장(청구 폼의 경고 아래 입력) — 회사=사업자등록번호, 개인=현금영수증 정보. requireBilling.
// **`/:id`보다 위에 등록**(literal 라우트가 param `/:id`보다 먼저 매칭되도록).
router.post("/payer-info", requireBilling, (req, res) => {
  const id = Number(req.body.party_id);
  const value = String(req.body.value || "").trim();
  const p = id ? getParty(id) : null;
  if (!p) return res.status(404).json({ ok: false, error: "청구처를 찾을 수 없습니다." });
  if (!value) return res.status(400).json({ ok: false, error: "값을 입력하세요." });
  if (p.kind === "company") {
    db().prepare("UPDATE parties SET biz_no = ? WHERE id = ?").run(formatBizNo(value), id); // 세금계산서 정보
    return res.json({ ok: true, field: "biz_no" });
  }
  db().prepare("UPDATE parties SET cash_receipt_no = ? WHERE id = ?").run(value, id); // 현금영수증(휴대폰/카드번호)
  return res.json({ ok: true, field: "cash_receipt_no" });
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
      artist: parties.artistText, // 콤마 다중 정규화
      artist_company: String(b.artist_company || "").trim() || null,
      production_company: String(b.production_company || "").trim() || null,
      artist_id: parties.artistId,
      agency_id: parties.agencyId,
      production_id: parties.productionId,
      contact_party_id: parties.contactId,
      manager_id: b.manager_id ? Number(b.manager_id) : null,
      memo: String(b.memo || "").trim() || null,
    });
  setProjectArtists(id, parties.artistIds); // 다대다 목록 통째 교체
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

// ── 작업 완료 토글(2026-07-05 사용자 요청 — 세션 완료 버튼과 동일 UX: '−완료'/'✓완료' 즉시 전환) ──
// 독립 라우트로 상태만 바꾼다 — 일반 수정 라우트(/tasks/:taskId)는 종류·담당·단가를 함께 요구해
// 상태만 담긴 요청이 오면 그 필드들이 리셋될 위험이 있어 별도로 분리(세션의 /sessions/:id/status와 동일 이유).
router.post("/tasks/:taskId/status", requireEditor, (req, res) => {
  try {
    const task = setTaskStatus(req.user, Number(req.params.taskId), req.body.status);
    if (!task) return res.status(404).send(errorPage({ code: 404, title: "작업을 찾을 수 없습니다", message: "삭제되었거나 주소가 잘못되었습니다.", user: req.user }));
    res.redirect(`/projects/${task.project_id}?tab=tracks&flash=saved`);
  } catch (e) {
    if (e.message === "TASK_LOCKED") return res.status(400).send(errorPage({ code: 400, title: "수정 불가", message: "이미 청구된 작업은 수정할 수 없습니다.", user: req.user }));
    throw e;
  }
});

// ── 작업 '청구 안 함'(무료 처리) 토글(2026-07-06 사용자 요청 — 리허설 등 의도적 무료 작업) ──
// 청구 생성 폼(청구 후보 목록)에서만 노출·되돌리기 가능. total_price는 안 건드려(되돌리면 원래 금액 보존).
// 폼 필드 없는 순수 토글(같은 청구 생성 폼 안 여러 행이 formaction으로 이 라우트를 공유해도 이름 충돌 없음).
router.post("/tasks/:taskId/waive", requireEditor, (req, res) => {
  try {
    const task = setTaskWaived(req.user, Number(req.params.taskId));
    if (!task) return res.status(404).send(errorPage({ code: 404, title: "작업을 찾을 수 없습니다", message: "삭제되었거나 주소가 잘못되었습니다.", user: req.user }));
    res.redirect(`/projects/${task.project_id}?tab=invoice`);
  } catch (e) {
    if (e.message === "TASK_LOCKED") return res.status(400).send(errorPage({ code: 400, title: "처리 불가", message: "이미 청구된 작업은 청구 안 함으로 바꿀 수 없습니다.", user: req.user }));
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
      confirmZero: req.body.confirm_zero_amount === "1", // 0원 항목 확인 후 청구(폼이 window.confirm 후 세팅)
    });
    if (!inv) return res.status(404).send(errorPage({ code: 404, title: "프로젝트를 찾을 수 없습니다", message: "삭제되었거나 주소가 잘못되었습니다.", user: req.user }));
    // createInvoiceFromTasks는 즉시 '발행' 상태로 생성 → 발행 알림 발송(notify는 fail-safe·비차단, 청구 흐름 비차단).
    notifyInvoiceIssued(inv);
    logAudit(req.user, "invoice.create", `#${inv.id} ${inv.title || ""} ${formatKRW(inv.amount || 0)}`);
    // 청구 메뉴로 이탈하지 않고 프로젝트 청구 탭으로 복귀 + 방금 만든 인보이스를 펼친 채(open) 노출.
    res.redirect(`/projects/${req.params.id}?tab=invoice&open=${inv.id}&flash=created`);
  } catch (e) {
    const known = { TASK_IDS_REQUIRED: "청구할 작업·세션을 선택하세요.", TASK_NOT_BILLABLE: "청구 가능한 작업·세션만 선택할 수 있습니다.", CLIENT_NOT_FOUND: "선택한 청구처를 찾을 수 없습니다.", TASK_AMOUNT_REQUIRED: "0원인 항목이 있습니다. 그대로 청구하려면 확인 후 다시 시도하세요.", PAYER_TAX_INFO_REQUIRED: "청구처(회사)에 세금계산서 정보(사업자등록번호)가 없습니다. 클라이언트 상세에서 입력한 뒤 청구하세요.", PAYER_CASH_RECEIPT_REQUIRED: "청구처(개인)에 현금영수증 정보가 없습니다. 청구처 상세에서 입력한 뒤 청구하세요." };
    if (!known[e.message]) throw e; // 알 수 없는 오류(DB 등)는 전역 핸들러(500+로깅)로 — 검증 실패로 위장 방지
    return res.status(400).send(errorPage({ code: 400, title: "청구 오류", message: known[e.message], user: req.user }));
  }
});

// 청구서 생성 전 미리보기 PDF 발행(견적서·내역서·거래명세서) — 청구서 레코드를 만들지 않고 선택 항목·금액을 그대로 문서화.
// 계산서(세금계산서) 발행이 필요할 때 '선택 항목으로 청구 생성'을 눌러 인보이스를 만든다(발행=확정).
// GET(폼 formmethod=get)으로 받는다 — Chrome PDF 뷰어의 '다운로드'는 같은 URL을 GET 재요청하므로, GET이어야
// 뷰·다운로드가 모두 동작한다(POST면 재요청이 404). 선택은 URL 쿼리로, 문서 유형·번호는 경로(:type/:name)로.
router.get("/:id/invoices/preview/:type/:name", requireBilling, asyncHandler(async (req, res) => {
  const b = req.query;
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
  const docType = normalizeDocType(req.params.type);
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
  const fname = (docNumberWithType(draft.invoice.invoice_number, docType) || docType) + ".pdf"; // 다운로드 파일명 = 문서번호(ASCII)
  res.setHeader("Content-Disposition", `inline; filename="${fname}"; filename*=UTF-8''${encodeURIComponent(fname)}`);
  res.setHeader("Cache-Control", "private, no-store");
  res.send(pdf);
}));

module.exports = router;
