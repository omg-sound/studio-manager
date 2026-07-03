"use strict";

const express = require("express");
const { requireEditor } = require("../auth");
const {
  listContacts,
  getParty,
  createPerson,
  updateParty,
  deleteParty,
  setPartyGoogleRef,
  currentAffiliation,
  listAffiliations,
  addAffiliation,
  syncCompanyAffiliation,
  endAffiliation,
  updateAffiliation,
  deleteAffiliation,
  listProjectsForParty,
  listSessionsForParty,
  listClients,
  orgsWithOwnerParty,
  getManagerByPartyId,
  classifyParty,
  syncPartyToManager,
  listGroupsForPicker,
  setPartyGroup,
} = require("../data");
const people = require("../people");
const { asyncHandler } = require("../lib/async"); // async 라우트 예외를 전역 핸들러로 전달(People API throw 시 요청 행 방지)
const { layout, pageHeader, esc, personLabel, flashBanner, emptyState, errorPage, listGroup, listRow, listRowLinked, projectTypeBadge, tabBar, detailsChevron, dirtyActionRow, copyable } = require("../views");

const router = express.Router();

// 연락처(클라이언트 측 담당자) 라우트는 편집자(치프·스태프) 전용 — 대표 차단
router.use(requireEditor);

// ── Google 연락처 역방향 동기화(수동 트리거) ──
router.post("/sync", asyncHandler(async (req, res) => {
  const r = await people.syncFromGoogle();
  let notice, warn = false;
  if (r.skipped) {
    notice = "미연동(Google 계정 연결 후 재시도)"; warn = true;
  } else if (r.error) {
    notice = `동기화 오류: ${r.error}`; warn = true;
  } else {
    notice = `동기화 완료 — 생성 ${r.created} · 수정 ${r.updated} · 삭제 ${r.deleted}`;
  }
  res.redirect(`/contacts?notice=${encodeURIComponent(notice)}${warn ? "&notice_warn=1" : ""}`);
}));

// ── 목록(이름·현재소속·전화 + ?q= 검색) ──
router.get("/", (req, res) => {
  const q = String(req.query.q || "").trim();
  const TABS = ["external", "worker", "staff"];
  const tab = TABS.includes(req.query.tab) ? req.query.tab : "external"; // 외부 연락처 / 외주 작업자 / 녹음실 스태프
  const rows = listContacts({ q: q || undefined, tab });

  const tabs = tabBar({
    tabs: [
      { key: "external", label: "외부 연락처" },
      { key: "worker", label: "외주 작업자" },
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
          const typeBadges = classifyParty(c.id, cur).map((t) => `<span class="badge ${t.cls}">${esc(t.label)}</span>`).join(" ");
          // 클라이언트 목록과 동일 흐름: 이름(→연락처)·소속 회사(→회사 상세)를 각각 링크(밑줄 분리), 직함은 텍스트.
          // 우측 전화·이메일은 비링크 → 드래그·복사해도 상세로 안 들어감.
          const nameLink = `<a href="/contacts/${c.id}" class="rounded font-semibold text-fg hover:text-primary hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40">${esc(personLabel(c.name, c.nickname))}</a>`;
          let orgPart = "";
          if (cur && cur.client_id) {
            const orgA = `<a href="/clients/${cur.client_id}" class="text-xs font-normal text-muted hover:text-primary hover:underline">${esc(cur.client_name || "")}</a>`;
            orgPart = ` <span class="text-xs font-normal text-muted">· </span>${orgA}${cur.title ? ` <span class="text-xs font-normal text-muted">· ${esc(cur.title)}</span>` : ""}`;
          }
          const right = (c.phone || c.email)
            ? `<div class="text-sm text-muted space-y-0.5">${c.phone ? `<div>${copyable(c.phone)}</div>` : ""}${c.email ? `<div>${copyable(c.email)}</div>` : ""}</div>`
            : "";
          return `<div class="flex items-start justify-between gap-4 px-4 py-3">
            <div class="min-w-0">
              <div class="truncate">${nameLink}${orgPart}</div>
              ${typeBadges ? `<div class="mt-1 flex flex-wrap gap-1">${typeBadges}</div>` : ""}
            </div>
            ${right ? `<div class="shrink-0 text-right">${right}</div>` : ""}
          </div>`;
        }),
      })
    : q
      ? emptyState(`"${esc(q)}" 검색 결과가 없습니다.`, { card: true, icon: "clients" })
      : tab === "staff"
        ? emptyState("녹음실 스태프 연락처가 없습니다. 관리 > 담당자에서 계정을 추가하면 자동 등록됩니다.", { card: true, icon: "clients" })
        : tab === "worker"
          ? emptyState("외주 작업자가 없습니다. 외주 작업자 메뉴에서 추가하면 자동 등록됩니다.", { card: true, icon: "clients" })
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
  res.send(layout({ title: "새 연락처", user: req.user, current: "/contacts", body: contactForm({}, false, listClients({}), null, false, listGroupsForPicker()) }));
});

router.post("/", asyncHandler(async (req, res) => {
  const b = req.body;
  try {
    const id = createPerson({
      name: b.name, phone: b.phone, email: b.email, memo: b.memo,
      family_name: b.family_name, given_name: b.given_name, honorific: b.honorific,
      nickname: b.nickname, company: b.company, job_title: b.job_title, department: b.department,
    });
    // 생성 폼에서 현재 소속(회사/직함)을 같이 받았으면 첫 소속으로 등록.
    if (b.client_id || (b.title && String(b.title).trim())) {
      addAffiliation(id, { client_id: b.client_id || null, title: b.title, started_on: b.started_on, closeCurrent: false });
    }
    if (!b.client_id) syncCompanyAffiliation(id, b.company, b.job_title); // '회사' 텍스트 입력 → 소속 이력 반영(업체 클라이언트 연결)
    if (b.group_id !== undefined) setPartyGroup(id, b.group_id); // 소속 그룹(밴드·아이돌) 연결
    // 활동명(nickname→activity_name)은 createPerson가 party에 저장하며 is_artist를 자동 세팅(별도 아티스트 셸 없음).
    // Google People push — fail-safe: 실패해도 앱 정상.
    try {
      const contact = getParty(id);
      const ref = await people.createPerson(contact);
      if (ref) setPartyGoogleRef(id, ref.resourceName, ref.etag);
    } catch (_e) {}
    if (req.get("X-Requested-With") === "fetch") { // 간이 등록(프로젝트 폼 모달) — 리다이렉트 대신 JSON
      const pp = getParty(id);
      return res.json({ ok: true, id, name: pp.name });
    }
    res.redirect(`/contacts/${id}?flash=created`);
  } catch (_e) {
    if (req.get("X-Requested-With") === "fetch") return res.status(400).json({ ok: false, error: "이름을 입력하세요." });
    res.send(layout({ title: "새 연락처", user: req.user, current: "/contacts", body: contactForm({ ...b, _err: "이름을 입력하세요." }, false, listClients({}), null, false, listGroupsForPicker()) }));
  }
}));

// ── 수정: 이제 상세(GET /:id)가 인라인 편집 화면이므로 옛 편집 경로는 상세로 리다이렉트(북마크 호환).
router.get("/:id/edit", (req, res) => {
  res.redirect(`/contacts/${Number(req.params.id)}`);
});

router.post("/:id", asyncHandler(async (req, res) => {
  const id = Number(req.params.id);
  const c = getParty(id);
  if (!c) return res.status(404).send(errorPage({ code: 404, title: "연락처를 찾을 수 없습니다", message: "삭제되었거나 주소가 잘못되었습니다.", user: req.user }));
  // 하우스 엔지니어 연동 연락처면 이메일은 기존값 유지(users.email 보호)
  const linkedManager = getManagerByPartyId(id);
  const isHouseEngineer = linkedManager && linkedManager.user_id != null;
  const b = req.body;
  try {
    updateParty(id, {
      name: b.name, phone: b.phone,
      email: isHouseEngineer ? c.email : b.email,  // 하우스: 기존 이메일 유지
      memo: b.memo,
      family_name: b.family_name, given_name: b.given_name, honorific: b.honorific,
      nickname: b.nickname, company: b.company, job_title: b.job_title, department: b.department,
    });
    syncCompanyAffiliation(id, b.company, b.job_title); // '회사' 텍스트 → 소속 이력 반영(현재 소속과 다르면 이직으로 등록)
    if (b.group_id !== undefined) setPartyGroup(id, b.group_id); // 소속 그룹(밴드·아이돌) 연결
    // 담당자(project_managers) 동기화: 전화(항상) + 이메일(외주만)
    syncPartyToManager(id);
    // 활동명 변경은 updateParty가 party activity_name·is_artist에 반영(별도 아티스트 셸 없음).
    // Google People push — fail-safe: 실패해도 앱 정상.
    try {
      const updated = getParty(id);
      if (updated.google_resource_name) {
        const ref = await people.updatePerson(updated.google_resource_name, updated.google_etag, updated);
        if (ref) setPartyGoogleRef(id, updated.google_resource_name, ref.etag);
      } else {
        const ref = await people.createPerson(updated);
        if (ref) setPartyGoogleRef(id, ref.resourceName, ref.etag);
      }
    } catch (_e) {}
    res.redirect(`/contacts/${id}?flash=saved`);
  } catch (_e) {
    res.send(layout({ title: "연락처 수정", user: req.user, current: "/contacts", body: contactForm({ ...c, ...b, _err: "이름을 입력하세요." }, true, listClients({}), linkedManager, false, listGroupsForPicker()) }));
  }
}));

// ── 삭제(하드: affiliations CASCADE, projects.contact_id SET NULL) ──
router.post("/:id/delete", asyncHandler(async (req, res) => {
  const id = Number(req.params.id);
  // DB 삭제 전 resourceName 확보 — 삭제 후에는 조회 불가.
  const contact = getParty(id);
  const resourceName = contact && contact.google_resource_name;
  deleteParty(id);
  // DB 삭제 후 People 삭제 — fail-safe: 실패해도 앱 정상.
  if (resourceName) {
    try { await people.deletePerson(resourceName); } catch (_e) {}
  }
  res.redirect("/contacts?flash=deleted");
}));

// ── 소속 이력: 추가/이직 · 종료 · 삭제 ──
router.post("/:id/affiliations", (req, res) => {
  const id = Number(req.params.id);
  if (!getParty(id)) return res.status(404).send(errorPage({ code: 404, title: "연락처를 찾을 수 없습니다", message: "삭제되었거나 주소가 잘못되었습니다.", user: req.user }));
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

// 소속 이력 행 수정(회사·직함·기간·메모). ended_on 비우면 현재 소속.
router.post("/:id/affiliations/:aid", (req, res) => {
  const b = req.body;
  updateAffiliation(Number(req.params.aid), {
    client_id: b.client_id || null,
    title: b.title,
    started_on: b.started_on,
    ended_on: b.ended_on,
    memo: b.memo,
  });
  res.redirect(`/contacts/${Number(req.params.id)}?flash=saved`);
});

router.post("/:id/affiliations/:aid/delete", (req, res) => {
  deleteAffiliation(Number(req.params.aid));
  res.redirect(`/contacts/${Number(req.params.id)}?flash=deleted`);
});

// ── 상세(연락처 정보 + 소속 이력 타임라인 + 추가/이직 폼 + 연결 프로젝트) ──
// 주의: GET /:id 는 GET /new·GET /:id/edit 보다 뒤에 등록해 경로 충돌을 피한다.
router.get("/:id", (req, res) => {
  const c = getParty(Number(req.params.id));
  if (!c) return res.status(404).send(errorPage({ code: 404, title: "연락처를 찾을 수 없습니다", message: "삭제되었거나 주소가 잘못되었습니다.", user: req.user }));
  const affs = listAffiliations(c.id);
  const projects = listProjectsForParty(c.id);
  const sessions = listSessionsForParty(c.id);
  const clients = listClients({});
  const linkedManager = getManagerByPartyId(c.id);

  const nameDetail = [`${String(c.family_name || "").trim()}${String(c.given_name || "").trim()}`, c.honorific].filter(Boolean).join(" "); // 한국식: 성+이름 붙이고 호칭 뒤
  const managerBadge = linkedManager
    ? `<div class="text-sm"><span class="text-muted">담당자 연동</span> ${
        linkedManager.user_id != null
          ? `<span class="badge badge-info">하우스 엔지니어</span> <a href="/settings?tab=people" class="text-primary hover:underline">${esc(linkedManager.name)}</a>`
          : `<span class="badge badge-neutral">외주 작업자</span> <a href="/workers/${linkedManager.id}" class="text-primary hover:underline">${esc(linkedManager.name)}</a>`
      }</div>`
    : "";
  const ownerClients = orgsWithOwnerParty(c.id); // 이 연락처가 대표자인 클라이언트(양방향 링크)
  const cur = currentAffiliation(c.id); // 현재 소속 — 회사칸 기본값(담당자로만 등록돼 company 텍스트가 비어 있던 경우 반영)
  // 상세로 들어오면 바로 수정 가능한 화면 — 읽기전용 카드+'정보 수정' 버튼 대신 인라인 편집 폼(변경 시 하이라이트 저장).
  const editCard = contactForm({ ...c, company: c.company || (cur && cur.client_name) || "" }, true, clients, linkedManager, true, listGroupsForPicker());
  const derivedBits = [
    nameDetail && nameDetail !== c.name ? `<div><span class="text-muted">성명</span> ${esc(nameDetail)}</div>` : "",
    c.nickname ? `<div><span class="text-muted">아티스트명</span> ${esc(c.nickname)}${c.is_artist ? ` · <a href="/clients/${c.id}" class="text-primary hover:underline">아티스트로 보기 ↗</a>` : ""}</div>` : "",
    ownerClients.length ? `<div><span class="text-muted">대표 클라이언트</span> ${ownerClients.map((oc) => `<a href="/clients/${oc.id}" class="text-primary hover:underline">${esc(oc.name)}</a>`).join(", ")}</div>` : "",
    managerBadge,
  ].filter(Boolean).join("");
  const infoCard = `
    ${editCard}
    ${derivedBits ? `<div class="mt-3 space-y-1 text-sm">${derivedBits}</div>` : ""}`;

  const timeline = affs.length
    ? `<div class="space-y-2">${affs
        .map((a) => {
          const isCurrent = !a.ended_on;
          const badge = isCurrent ? `<span class="badge badge-success">현재</span>` : `<span class="badge badge-neutral">종료</span>`;
          const company = a.client_name || "무소속";
          const period = `${a.started_on ? esc(a.started_on) : "?"} ~ ${a.ended_on ? esc(a.ended_on) : "현재"}`;
          // 각 소속 행을 펼치면(details) 회사·직함·기간·메모를 직접 수정(dirty 저장). 종료·삭제도 그 안에.
          const editForm = `
            <form method="post" action="/contacts/${c.id}/affiliations/${a.id}" class="mt-2 space-y-2 border-t border-border pt-2" data-dirty-form>
              <div class="grid gap-2 sm:grid-cols-2">
                <div>
                  <label class="label mb-0.5 text-xs">소속 회사</label>
                  <select name="client_id" class="input py-1.5 text-sm">
                    <option value="">무소속</option>
                    ${clients.map((cl) => `<option value="${cl.id}" ${String(a.client_id || "") === String(cl.id) ? "selected" : ""}>${esc(cl.name)}${cl.kind ? " (" + esc(cl.kind) + ")" : ""}</option>`).join("")}
                  </select>
                </div>
                <div><label class="label mb-0.5 text-xs">직함</label><input class="input py-1.5 text-sm" name="title" value="${esc(a.title || "")}" placeholder="예: A&amp;R · 매니저" /></div>
                <div><label class="label mb-0.5 text-xs">시작일</label><input class="input py-1.5 text-sm" type="date" name="started_on" value="${esc(a.started_on || "")}" /></div>
                <div><label class="label mb-0.5 text-xs">종료일 <span class="font-normal text-muted">(비우면 현재)</span></label><input class="input py-1.5 text-sm" type="date" name="ended_on" value="${esc(a.ended_on || "")}" /></div>
              </div>
              <div><label class="label mb-0.5 text-xs">메모</label><input class="input py-1.5 text-sm" name="memo" value="${esc(a.memo || "")}" /></div>
              <div class="flex items-center gap-2">
                <button class="btn-primary btn-xs transition" type="submit" data-dirty-save>저장</button>
                <span class="text-xs text-warning" data-dirty-hint hidden>저장되지 않은 변경사항</span>
              </div>
            </form>
            <div class="mt-2 flex gap-1 border-t border-border pt-2">
              ${isCurrent ? `<form method="post" action="/contacts/${c.id}/affiliations/${a.id}/end"><button class="btn-ghost btn-xs" type="submit">종료 처리</button></form>` : ""}
              <form method="post" action="/contacts/${c.id}/affiliations/${a.id}/delete" data-confirm="이 소속 이력을 삭제할까요?"><button class="btn-ghost btn-xs text-danger" type="submit">삭제</button></form>
            </div>`;
          return `<div class="card">
            <details class="group">
              <summary class="flex cursor-pointer list-none items-start justify-between gap-3">
                <div class="min-w-0">
                  <div class="flex items-center gap-2">${badge}<span class="font-semibold">${esc(company)}</span>${a.title ? `<span class="text-sm text-muted">${esc(a.title)}</span>` : ""}</div>
                  <div class="mt-0.5 text-xs text-muted">${period}</div>
                  ${a.memo ? `<div class="mt-1 text-sm">${esc(a.memo)}</div>` : ""}
                </div>
                <span class="shrink-0 text-xs text-muted hover:text-fg">${detailsChevron()}</span>
              </summary>
              ${editForm}
            </details>
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

  // 클라이언트 '관계자' 탭 등에서 넘어왔으면 그 필터로 복귀(?from=쿼리스트링, 안전문자만). 아니면 연락처 목록.
  const from = String(req.query.from || "");
  const backHref = from && /^[\w=&%.\-]*$/.test(from) ? `/clients?${from}` : "/contacts";
  const backLabel = from ? "클라이언트" : "연락처";
  const body = `
    ${flashBanner(req.query)}
    ${pageHeader({ title: personLabel(c.name, c.nickname), desc: `연락처 · ${classifyParty(c.id).map((t) => t.label).join(" · ")}`, back: { href: backHref, label: backLabel } })}
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
function contactForm(c = {}, isEdit = false, clients = [], manager = null, embedded = false, groups = []) {
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
  // embedded=상세 페이지에 인라인으로 들어갈 때 — 페이지 헤더(연락처 수정/상세 back) 생략(상단 이름 헤더가 이미 있음).
  return `
    ${embedded ? "" : pageHeader({ title: isEdit ? "연락처 수정" : "새 연락처", desc: "이름 · 연락처 · 소속", back: { href: cancelHref, label: isEdit ? "연락처 상세" : "연락처" } })}
    <form method="post" action="${action}" class="card space-y-4"${isEdit ? " data-dirty-form" : ""}>
      ${e ? `<p class="rounded-lg bg-danger/10 px-3 py-2 text-sm text-danger">${esc(e)}</p>` : ""}
      ${managerBanner}
      <div class="rounded-lg border border-border bg-bg/40 p-3 space-y-3">
        <div class="text-sm font-medium">이름 <span class="font-normal text-muted">— 성·이름·호칭으로 표시됩니다</span></div>
        <div class="grid gap-3 sm:grid-cols-3">
          <div><label class="label">성</label><input class="input" name="family_name" value="${esc(c.family_name || "")}" placeholder="예: 김" /></div>
          <div><label class="label">이름</label><input class="input" name="given_name" value="${esc(c.given_name || "")}" placeholder="예: 지훈" /></div>
          <div><label class="label">호칭</label><input class="input" name="honorific" value="${esc(c.honorific || "")}" placeholder="예: 대표님 · 팀장님" /></div>
        </div>
        <div class="grid gap-3 sm:grid-cols-2">
          <div><label class="label">아티스트명 <span class="font-normal text-muted text-xs">(활동명 · 클라이언트로 등록·연동)</span></label>
            <input class="input" name="nickname" value="${esc(c.nickname || "")}" placeholder="예: 아티스트 활동명 · 목록에서 선택" list="contact-artist-clients" autocomplete="off" />
            <datalist id="contact-artist-clients">${clients.filter((cl) => cl.is_artist).map((cl) => `<option value="${esc(cl.name)}"></option>`).join("")}</datalist>
          </div>
          <div><label class="label">소속 그룹 <span class="font-normal text-muted text-xs">(밴드·아이돌 그룹 멤버일 때)</span></label>
            <select name="group_id" class="input">
              <option value="">— 소속 그룹 없음 —</option>
              ${groups.map((g) => `<option value="${g.id}"${Number(c.group_id) === g.id ? " selected" : ""}>${esc(g.name)}</option>`).join("")}
            </select>
          </div>
        </div>
      </div>
      <div class="grid gap-3 sm:grid-cols-3">
        <div><label class="label">회사</label><input class="input" name="company" value="${esc(c.company || "")}" placeholder="소속 회사명 · 클라이언트에서 검색" list="contact-company-clients" autocomplete="off" />
          <datalist id="contact-company-clients">${clients.map((cl) => `<option value="${esc(cl.name)}"></option>`).join("")}</datalist>
        </div>
        <div><label class="label">직책</label><input class="input" name="job_title" value="${esc(c.job_title || "")}" placeholder="예: 대표 · 팀장" /></div>
        <div><label class="label">부서</label><input class="input" name="department" value="${esc(c.department || "")}" placeholder="예: A&R팀" /></div>
      </div>
      <div class="grid gap-3 sm:grid-cols-2">
        <div><label class="label">휴대전화</label><input class="input" name="phone" autocomplete="off" value="${esc(c.phone || "")}" placeholder="010-0000-0000" /></div>
        <div>
          <label class="label">이메일${isHouseEngineer ? ` <span class="font-normal text-muted">(로그인 계정)</span>` : ""}</label>
          <input class="input${isHouseEngineer ? " opacity-60 cursor-not-allowed" : ""}" type="email" name="email" value="${esc(c.email || "")}"${isHouseEngineer ? ' readonly aria-readonly="true"' : ""} />
          ${isHouseEngineer ? `<p class="mt-0.5 text-xs text-muted">하우스 엔지니어 로그인 계정 이메일이라 변경 불가합니다.</p>` : ""}
        </div>
      </div>
      <div><label class="label">메모</label><textarea class="input" name="memo" rows="2">${esc(c.memo || "")}</textarea></div>
      ${affBlock}
      ${isEdit
        ? dirtyActionRow({ deleteFormId: `del-contact-${c.id}`, deleteLabel: "연락처 삭제" })
        : dirtyActionRow({ cancelHref: cancelHref, saveLabel: "추가", dirty: false })}
    </form>
    ${isEdit ? `<form id="del-contact-${c.id}" method="post" action="/contacts/${c.id}/delete" data-confirm="${esc(c.name)} 연락처를 삭제할까요? 소속 이력도 함께 삭제됩니다." class="hidden"></form>` : ""}`;
}

module.exports = router;
