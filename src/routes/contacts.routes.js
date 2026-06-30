"use strict";

const express = require("express");
const { requireEditor } = require("../auth");
const {
  listContacts,
  getContact,
  createContact,
  updateContact,
  deleteContact,
  setContactGoogleRef,
  currentAffiliation,
  listAffiliations,
  addAffiliation,
  endAffiliation,
  deleteAffiliation,
  listProjectsForContact,
  listSessionsForContact,
  listClients,
  getManagerByContactId,
  classifyContact,
  syncContactToManager,
} = require("../data");
const people = require("../people");
const { layout, pageHeader, esc, flashBanner, emptyState, errorPage, listGroup, listRow, projectTypeBadge, tabBar } = require("../views");

const router = express.Router();

// 연락처(클라이언트 측 담당자) 라우트는 편집자(치프·스태프) 전용 — 대표 차단
router.use(requireEditor);

// ── Google 연락처 역방향 동기화(수동 트리거) ──
router.post("/sync", async (req, res) => {
  const r = await people.syncFromGoogle();
  let flash;
  if (r.skipped) {
    flash = "미연동(Google 계정 연결 후 재시도)";
  } else if (r.error) {
    flash = `동기화 오류: ${r.error}`;
  } else {
    flash = `동기화 완료 — 생성 ${r.created} · 수정 ${r.updated} · 삭제 ${r.deleted}`;
  }
  res.redirect(`/contacts?flash=${encodeURIComponent(flash)}`);
});

// ── 목록(이름·현재소속·전화 + ?q= 검색) ──
router.get("/", (req, res) => {
  const q = String(req.query.q || "").trim();
  const tab = req.query.tab === "staff" ? "staff" : "external"; // 녹음실 스태프(로그인 계정) 탭 / 외부·고객측 연락처 탭
  const rows = listContacts({ q: q || undefined, staff: tab === "staff" });

  const tabs = tabBar({
    tabs: [
      { key: "external", label: "외부 연락처" },
      { key: "staff", label: "녹음실 스태프" },
    ],
    activeKey: tab,
    hrefFn: (k) => `/contacts?tab=${k}${q ? "&q=" + encodeURIComponent(q) : ""}`,
  });

  const searchBar = `
    <form method="get" action="/contacts" class="mb-4 flex gap-2">
      <input type="hidden" name="tab" value="${esc(tab)}" />
      <input class="input min-w-0 flex-1" type="search" name="q" value="${esc(q)}" placeholder="이름 · 전화 검색" aria-label="연락처 검색" />
      <button class="btn-primary shrink-0" type="submit">검색</button>
    </form>`;

  const resultNote = q
    ? `<div class="mb-3 text-sm text-muted">"${esc(q)}" 결과 ${rows.length}건 · <a href="/contacts?tab=${tab}" class="text-primary hover:underline">전체 보기</a></div>`
    : "";

  const list = rows.length
    ? listGroup({
        rows: rows.map((c) => {
          const cur = currentAffiliation(c.id);
          const typeBadges = classifyContact(c.id, cur).map((t) => `<span class="badge ${t.cls}">${esc(t.label)}</span>`).join(" ");
          const affBadge = cur && cur.client_id ? `<span class="badge badge-neutral">${esc(cur.client_name || "")}${cur.title ? " · " + esc(cur.title) : ""}</span>` : "";
          const left = `<div class="flex flex-wrap items-center gap-2"><span class="font-semibold">${esc(c.name)}</span>${typeBadges}${affBadge}</div>`;
          const right = c.phone ? `<span class="text-sm text-muted">${esc(c.phone)}</span>` : "";
          return listRow({ href: `/contacts/${c.id}`, left, right });
        }),
      })
    : q
      ? emptyState(`"${esc(q)}" 검색 결과가 없습니다.`, { card: true, icon: "clients" })
      : tab === "staff"
        ? emptyState("녹음실 스태프 연락처가 없습니다. 관리 > 담당자에서 계정을 추가하면 자동 등록됩니다.", { card: true, icon: "clients" })
        : emptyState("등록된 연락처가 없습니다.", { card: true, icon: "clients", cta: { href: "/contacts/new", label: "+ 새 연락처" } });

  const syncBtn = `
    <form method="post" action="/contacts/sync" class="inline">
      <button class="btn-ghost btn-sm" type="submit">Google 동기화</button>
    </form>`;

  const body = `
    ${flashBanner(req.query)}
    ${pageHeader({ title: "연락처", desc: "레이블/제작사 직원 · 프리 매니저 · 아티스트 지인 등 사람 마스터(소속 이력 포함).", action: `<div class="flex gap-2 items-center">${syncBtn}<a href="/contacts/new" class="btn-primary">+ 새 연락처</a></div>` })}
    ${tabs}
    ${searchBar}
    ${resultNote}
    ${list}`;
  res.send(layout({ title: "연락처", user: req.user, current: "/contacts", body }));
});

// ── 새 연락처 ──
router.get("/new", (req, res) => {
  res.send(layout({ title: "새 연락처", user: req.user, current: "/contacts", body: contactForm({}, false, listClients({})) }));
});

router.post("/", async (req, res) => {
  const b = req.body;
  try {
    const id = createContact({
      name: b.name, phone: b.phone, email: b.email, memo: b.memo,
      family_name: b.family_name, given_name: b.given_name, honorific: b.honorific,
      nickname: b.nickname, company: b.company, job_title: b.job_title, department: b.department,
    });
    // 생성 폼에서 현재 소속(회사/직함)을 같이 받았으면 첫 소속으로 등록.
    if (b.client_id || (b.title && String(b.title).trim())) {
      addAffiliation(id, { client_id: b.client_id || null, title: b.title, started_on: b.started_on, closeCurrent: false });
    }
    // Google People push — fail-safe: 실패해도 앱 정상.
    try {
      const contact = getContact(id);
      const ref = await people.createPerson(contact);
      if (ref) setContactGoogleRef(id, ref.resourceName, ref.etag);
    } catch (_e) {}
    res.redirect(`/contacts/${id}?flash=created`);
  } catch (_e) {
    res.send(layout({ title: "새 연락처", user: req.user, current: "/contacts", body: contactForm({ ...b, _err: "이름을 입력하세요." }, false, listClients({})) }));
  }
});

// ── 수정 ──
router.get("/:id/edit", (req, res) => {
  const c = getContact(Number(req.params.id));
  if (!c) return res.status(404).send(errorPage({ code: 404, title: "연락처를 찾을 수 없습니다", message: "삭제되었거나 주소가 잘못되었습니다.", user: req.user }));
  const linkedManager = getManagerByContactId(c.id);
  res.send(layout({ title: "연락처 수정", user: req.user, current: "/contacts", body: contactForm(c, true, [], linkedManager) }));
});

router.post("/:id", async (req, res) => {
  const id = Number(req.params.id);
  const c = getContact(id);
  if (!c) return res.status(404).send(errorPage({ code: 404, title: "연락처를 찾을 수 없습니다", message: "삭제되었거나 주소가 잘못되었습니다.", user: req.user }));
  // 하우스 엔지니어 연동 연락처면 이메일은 기존값 유지(users.email 보호)
  const linkedManager = getManagerByContactId(id);
  const isHouseEngineer = linkedManager && linkedManager.user_id != null;
  const b = req.body;
  try {
    updateContact(id, {
      name: b.name, phone: b.phone,
      email: isHouseEngineer ? c.email : b.email,  // 하우스: 기존 이메일 유지
      memo: b.memo,
      family_name: b.family_name, given_name: b.given_name, honorific: b.honorific,
      nickname: b.nickname, company: b.company, job_title: b.job_title, department: b.department,
    });
    // 담당자(project_managers) 동기화: 전화(항상) + 이메일(외주만)
    syncContactToManager(id);
    // Google People push — fail-safe: 실패해도 앱 정상.
    try {
      const updated = getContact(id);
      if (updated.google_resource_name) {
        const ref = await people.updatePerson(updated.google_resource_name, updated.google_etag, updated);
        if (ref) setContactGoogleRef(id, updated.google_resource_name, ref.etag);
      } else {
        const ref = await people.createPerson(updated);
        if (ref) setContactGoogleRef(id, ref.resourceName, ref.etag);
      }
    } catch (_e) {}
    res.redirect(`/contacts/${id}?flash=saved`);
  } catch (_e) {
    res.send(layout({ title: "연락처 수정", user: req.user, current: "/contacts", body: contactForm({ ...c, ...b, _err: "이름을 입력하세요." }, true, [], linkedManager) }));
  }
});

// ── 삭제(하드: affiliations CASCADE, projects.contact_id SET NULL) ──
router.post("/:id/delete", async (req, res) => {
  const id = Number(req.params.id);
  // DB 삭제 전 resourceName 확보 — 삭제 후에는 조회 불가.
  const contact = getContact(id);
  const resourceName = contact && contact.google_resource_name;
  deleteContact(id);
  // DB 삭제 후 People 삭제 — fail-safe: 실패해도 앱 정상.
  if (resourceName) {
    try { await people.deletePerson(resourceName); } catch (_e) {}
  }
  res.redirect("/contacts?flash=deleted");
});

// ── 소속 이력: 추가/이직 · 종료 · 삭제 ──
router.post("/:id/affiliations", (req, res) => {
  const id = Number(req.params.id);
  if (!getContact(id)) return res.status(404).send(errorPage({ code: 404, title: "연락처를 찾을 수 없습니다", message: "삭제되었거나 주소가 잘못되었습니다.", user: req.user }));
  const b = req.body;
  addAffiliation(id, {
    client_id: b.client_id || null,
    title: b.title,
    started_on: b.started_on,
    memo: b.memo,
    closeCurrent: b.closeCurrent === "1",
  });
  res.redirect(`/contacts/${id}?flash=added`);
});

router.post("/:id/affiliations/:aid/end", (req, res) => {
  endAffiliation(Number(req.params.aid));
  res.redirect(`/contacts/${Number(req.params.id)}?flash=saved`);
});

router.post("/:id/affiliations/:aid/delete", (req, res) => {
  deleteAffiliation(Number(req.params.aid));
  res.redirect(`/contacts/${Number(req.params.id)}?flash=deleted`);
});

// ── 상세(연락처 정보 + 소속 이력 타임라인 + 추가/이직 폼 + 연결 프로젝트) ──
// 주의: GET /:id 는 GET /new·GET /:id/edit 보다 뒤에 등록해 경로 충돌을 피한다.
router.get("/:id", (req, res) => {
  const c = getContact(Number(req.params.id));
  if (!c) return res.status(404).send(errorPage({ code: 404, title: "연락처를 찾을 수 없습니다", message: "삭제되었거나 주소가 잘못되었습니다.", user: req.user }));
  const affs = listAffiliations(c.id);
  const projects = listProjectsForContact(c.id);
  const sessions = listSessionsForContact(c.id);
  const clients = listClients({});
  const linkedManager = getManagerByContactId(c.id);

  const nameDetail = [`${String(c.family_name || "").trim()}${String(c.given_name || "").trim()}`, c.honorific].filter(Boolean).join(" "); // 한국식: 성+이름 붙이고 호칭 뒤
  const managerBadge = linkedManager
    ? `<div class="text-sm"><span class="text-muted">담당자 연동</span> ${
        linkedManager.user_id != null
          ? `<span class="badge badge-info">하우스 엔지니어</span> <a href="/settings?tab=people" class="text-primary hover:underline">${esc(linkedManager.name)}</a>`
          : `<span class="badge badge-neutral">외주 작업자</span> <a href="/workers/${linkedManager.id}" class="text-primary hover:underline">${esc(linkedManager.name)}</a>`
      }</div>`
    : "";
  const infoCard = `
    <div class="card mb-6 space-y-2">
      ${nameDetail && nameDetail !== c.name ? `<div class="text-sm"><span class="text-muted">성명</span> ${esc(nameDetail)}</div>` : ""}
      ${c.nickname ? `<div class="text-sm"><span class="text-muted">별명</span> ${esc(c.nickname)}</div>` : ""}
      ${c.company ? `<div class="text-sm"><span class="text-muted">회사</span> ${esc(c.company)}</div>` : ""}
      ${c.job_title ? `<div class="text-sm"><span class="text-muted">직책</span> ${esc(c.job_title)}${c.department ? " · " + esc(c.department) : ""}</div>` : c.department ? `<div class="text-sm"><span class="text-muted">부서</span> ${esc(c.department)}</div>` : ""}
      <div class="text-sm"><span class="text-muted">휴대전화</span> ${c.phone ? esc(c.phone) : `<span class="text-muted">없음</span>`}</div>
      <div class="text-sm"><span class="text-muted">이메일</span> ${c.email ? esc(c.email) : `<span class="text-muted">없음</span>`}${linkedManager && linkedManager.user_id != null ? ` <span class="text-xs text-muted">(로그인 계정)</span>` : ""}</div>
      ${c.memo ? `<div class="text-sm"><span class="text-muted">메모</span> ${esc(c.memo)}</div>` : ""}
      ${managerBadge}
      <div class="flex gap-2 pt-1">
        <a href="/contacts/${c.id}/edit" class="btn-ghost btn-sm">정보 수정</a>
        <form method="post" action="/contacts/${c.id}/delete" data-confirm="${esc(c.name)} 연락처를 삭제할까요? 소속 이력도 함께 삭제됩니다.">
          <button class="btn-ghost btn-sm text-danger" type="submit">삭제</button>
        </form>
      </div>
    </div>`;

  const timeline = affs.length
    ? `<div class="space-y-2">${affs
        .map((a) => {
          const isCurrent = !a.ended_on;
          const badge = isCurrent ? `<span class="badge badge-success">현재</span>` : `<span class="badge badge-neutral">종료</span>`;
          const company = a.client_name || "무소속";
          const period = `${a.started_on ? esc(a.started_on) : "?"} ~ ${a.ended_on ? esc(a.ended_on) : "현재"}`;
          return `<div class="card flex items-start justify-between gap-3">
            <div class="min-w-0">
              <div class="flex items-center gap-2">${badge}<span class="font-semibold">${esc(company)}</span>${a.title ? `<span class="text-sm text-muted">${esc(a.title)}</span>` : ""}</div>
              <div class="mt-0.5 text-xs text-muted">${period}</div>
              ${a.memo ? `<div class="mt-1 text-sm">${esc(a.memo)}</div>` : ""}
            </div>
            <div class="flex shrink-0 gap-1">
              ${isCurrent ? `<form method="post" action="/contacts/${c.id}/affiliations/${a.id}/end"><button class="btn-ghost btn-xs" type="submit">종료</button></form>` : ""}
              <form method="post" action="/contacts/${c.id}/affiliations/${a.id}/delete" data-confirm="이 소속 이력을 삭제할까요?"><button class="btn-ghost btn-xs text-danger" type="submit">삭제</button></form>
            </div>
          </div>`;
        })
        .join("")}</div>`
    : emptyState("소속 이력이 없습니다.", { card: true });

  const affForm = `
    <form method="post" action="/contacts/${c.id}/affiliations" class="card mt-3 space-y-3">
      <div class="font-semibold">소속 추가 / 이직</div>
      <div class="grid gap-3 sm:grid-cols-2">
        <div>
          <label class="label">소속 회사</label>
          <select name="client_id" class="input">
            <option value="">무소속</option>
            ${clients.map((cl) => `<option value="${cl.id}">${esc(cl.name)}${cl.kind ? " (" + esc(cl.kind) + ")" : ""}</option>`).join("")}
          </select>
        </div>
        <div><label class="label">직함</label><input class="input" name="title" placeholder="예: A&amp;R · 매니저" /></div>
      </div>
      <div><label class="label">시작일</label><input class="input" type="date" name="started_on" /></div>
      <label class="flex items-center gap-2 text-sm"><input type="checkbox" name="closeCurrent" value="1" checked /> 기존 현재 소속 종료(이직)</label>
      <button class="btn-primary" type="submit">소속 추가</button>
    </form>`;

  const projectList = projects.length
    ? listGroup({
        rows: projects.map((p) => {
          const meta = [p.artist, p.artist_company, p.production_company].filter(Boolean).join(" · ");
          const left = `<div class="flex items-center gap-2"><span class="font-semibold">${esc(p.title)}</span>${projectTypeBadge(p.project_type)}</div>${meta ? `<div class="mt-0.5 text-xs text-muted">${esc(meta)}</div>` : ""}`;
          return listRow({ href: `/projects/${p.id}`, left, right: `<span class="text-xs text-muted">열기 ›</span>` });
        }),
      })
    : emptyState("연결된 프로젝트가 없습니다.", { card: true });

  const sessionList = sessions.length
    ? listGroup({
        rows: sessions.map((s) => {
          const timeStr = s.start_time ? ` ${esc(s.start_time)}${s.end_time ? "–" + esc(s.end_time) : ""}` : "";
          const left = `<div class="flex flex-wrap items-center gap-2"><span class="font-semibold">${esc(s.session_date)}${timeStr}</span><span class="badge bg-bg text-muted">${esc(s.session_type)}</span></div><div class="mt-0.5 text-xs text-muted">${esc(s.project_title || "")}</div>`;
          const right = `<span class="text-xs text-muted">${esc(s.status)}</span>`;
          return listRow({ href: `/projects/${s.project_id}?tab=sessions`, left, right });
        }),
      })
    : emptyState("담당 디렉터로 지정된 세션이 없습니다.", { card: true });

  const body = `
    ${flashBanner(req.query)}
    ${pageHeader({ title: c.name, desc: `연락처 · ${classifyContact(c.id).map((t) => t.label).join(" · ")}`, back: { href: "/contacts", label: "연락처" } })}
    ${infoCard}
    <h2 class="mb-2 mt-6 font-display text-lg font-semibold text-fg">소속 이력</h2>
    ${timeline}
    ${affForm}
    <h2 class="mb-2 mt-6 font-display text-lg font-semibold text-fg">참여 세션</h2>
    ${sessionList}
    <h2 class="mb-2 mt-6 font-display text-lg font-semibold text-fg">연결 프로젝트</h2>
    ${projectList}`;
  res.send(layout({ title: c.name, user: req.user, current: "/contacts", body }));
});

// ── 폼(추가/수정 공용) ──
function contactForm(c = {}, isEdit = false, clients = [], manager = null) {
  const e = c._err || "";
  const action = isEdit ? `/contacts/${c.id}` : "/contacts";
  const cancelHref = isEdit ? `/contacts/${c.id}` : "/contacts";
  const isHouseEngineer = manager && manager.user_id != null;
  // 생성 시에만 '현재 소속'을 같이 입력(첫 소속 등록). 수정 시 소속은 상세의 이력에서 관리(이직 등).
  const affBlock = isEdit ? "" : `
      <div class="rounded-lg border border-border bg-bg/40 p-3 space-y-3">
        <div class="text-sm font-medium">현재 소속 <span class="font-normal text-muted">— 선택(나중에 상세에서 추가·이직 가능)</span></div>
        <div class="grid gap-3 sm:grid-cols-2">
          <div>
            <label class="label">소속 회사</label>
            <select class="input" name="client_id">
              <option value="">무소속 (프리·지인)</option>
              ${clients.map((cl) => `<option value="${cl.id}" ${String(c.client_id || "") === String(cl.id) ? "selected" : ""}>${esc(cl.name)} · ${esc(cl.kind)}</option>`).join("")}
            </select>
          </div>
          <div>
            <label class="label">직함 <span class="font-normal text-muted">(선택)</span></label>
            <input class="input" name="title" value="${esc(c.title || "")}" placeholder="예: A&R · 매니저" />
          </div>
        </div>
      </div>`;
  const managerBanner = manager
    ? `<div class="rounded-lg px-3 py-2 text-sm ${isHouseEngineer ? "bg-info/10 text-info" : "bg-neutral/10 text-fg"}">
        ${isHouseEngineer
          ? `<span class="badge badge-info">하우스 엔지니어</span> <strong>${esc(manager.name)}</strong> 연동 연락처 — 이메일은 로그인 계정이라 변경할 수 없습니다.`
          : `<span class="badge badge-neutral">외주 작업자</span> <strong>${esc(manager.name)}</strong> 연동 연락처 — 전화·이메일이 양방향으로 동기화됩니다.`}
      </div>`
    : "";
  return `
    ${pageHeader({ title: isEdit ? "연락처 수정" : "새 연락처", desc: "이름 · 연락처 · 소속", back: { href: cancelHref, label: isEdit ? "연락처 상세" : "연락처" } })}
    <form method="post" action="${action}" class="card space-y-4">
      ${e ? `<p class="rounded-lg bg-danger/10 px-3 py-2 text-sm text-danger">${esc(e)}</p>` : ""}
      ${managerBanner}
      <div class="rounded-lg border border-border bg-bg/40 p-3 space-y-3">
        <div class="text-sm font-medium">이름 <span class="font-normal text-muted">— 성·이름·호칭으로 표시됩니다</span></div>
        <div class="grid gap-3 sm:grid-cols-3">
          <div><label class="label">성</label><input class="input" name="family_name" value="${esc(c.family_name || "")}" placeholder="예: 김" /></div>
          <div><label class="label">이름</label><input class="input" name="given_name" value="${esc(c.given_name || "")}" placeholder="예: 지훈" /></div>
          <div><label class="label">호칭</label><input class="input" name="honorific" value="${esc(c.honorific || "")}" placeholder="예: 대표님 · 팀장님" /></div>
        </div>
        <div class="sm:max-w-xs"><label class="label">별명</label><input class="input" name="nickname" value="${esc(c.nickname || "")}" placeholder="예: 준, 해피" /></div>
      </div>
      <div class="grid gap-3 sm:grid-cols-3">
        <div><label class="label">회사</label><input class="input" name="company" value="${esc(c.company || "")}" placeholder="소속 회사명" /></div>
        <div><label class="label">직책</label><input class="input" name="job_title" value="${esc(c.job_title || "")}" placeholder="예: 대표 · 팀장" /></div>
        <div><label class="label">부서</label><input class="input" name="department" value="${esc(c.department || "")}" placeholder="예: A&R팀" /></div>
      </div>
      <div class="grid gap-3 sm:grid-cols-2">
        <div><label class="label">휴대전화</label><input class="input" name="phone" value="${esc(c.phone || "")}" placeholder="010-0000-0000" /></div>
        <div>
          <label class="label">이메일${isHouseEngineer ? ` <span class="font-normal text-muted">(로그인 계정)</span>` : ""}</label>
          <input class="input${isHouseEngineer ? " opacity-60 cursor-not-allowed" : ""}" type="email" name="email" value="${esc(c.email || "")}"${isHouseEngineer ? ' readonly aria-readonly="true"' : ""} />
          ${isHouseEngineer ? `<p class="mt-0.5 text-xs text-muted">하우스 엔지니어 로그인 계정 이메일이라 변경 불가합니다.</p>` : ""}
        </div>
      </div>
      <div><label class="label">메모</label><textarea class="input" name="memo" rows="2">${esc(c.memo || "")}</textarea></div>
      ${affBlock}
      <div class="flex gap-2">
        <button class="btn-primary" type="submit">${isEdit ? "저장" : "추가"}</button>
        <a href="${cancelHref}" class="btn-ghost">취소</a>
      </div>
    </form>`;
}

module.exports = router;
