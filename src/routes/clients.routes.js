"use strict";

const fs = require("fs");
const express = require("express");
const { db } = require("../db");
const { requireEditor } = require("../auth");
const { COMPANY_ROLES } = require("../config");
const {
  listClients, getParty, listProjectsForParty,
  listInvoicesForParty,
  listClientFiles, getClientFile, upsertClientFile, deleteClientFile,
  setOrgContacts, setCompanyOwners, listCompanyOwners, listOrgContacts, listContacts, resolvePersonByName,
  listArtistsForAgency, artistPersonOptions,
  createCompany, createGroup, createPerson, updateParty, deleteParty,
  setPartyGroup, listGroupMembers,
  setPartyAgency, currentAgencyId, currentAgencyName, ensureCompanyParty, resolveCompanyByName, addCompanyRole,
} = require("../data");
const storage = require("../storage");
const { asyncHandler } = require("../lib/async");
const { logAudit } = require("../lib/audit"); // 파괴적·재무 액션 기록(fail-safe)
const { buildUpload, decodeName, detectMimeFromFile } = require("../lib/attachments"); // 첨부 보안 로직 공용(2026-07-09 통합)
const { formatBizNo } = require("../lib/forms");
const { stripTrailingTitle } = require("../lib/korean-name");
const { safePath } = require("../lib/nav"); // ?return= 복귀 경로 검증(공용)
const { layout, pageHeader, esc, personLabel, personName, flashBanner, emptyState, capList, errorPage, tabBar, listRowLinked, dataTable, explain, personCombo, copyable, searchBox, fileViewerPage } = require("../views");
const { FILE_KINDS, fileKindLabel, clientFilesBlock, clientForm, clientReadView, clientEditPane } = require("../views.clients");
const { contactPanes, contactNameList } = require("../views.contacts");

const router = express.Router();

router.use(requireEditor); // 클라이언트 전 라우트(목록·상세·편집·첨부 서류) 편집자(치프·스태프). 매출만 별도 제한(revenue).

// 첨부 서류 업로드: 디스크 스토리지(메모리 금지 — OOM 방지, 플레이북 §3-2), 10MB 제한
const upload = buildUpload("omgcf_"); // 공용 첨부 업로더(lib/attachments — 매직바이트·한도 정책 단일화)

/** 폼에서 업체 역할(CSV) 추출: 체크된 유효 roles만(없으면 null → 배지 '업체' 폴백). 업체 유형에서만 호출. */
function companyRolesFrom(b) {
  const checked = [].concat(b.roles || []).filter((r) => COMPANY_ROLES.includes(r));
  return checked.length ? checked.join(",") : null;
}

// ── 목록(2단: 왼쪽 업체/그룹 탭+검색+이름 목록, 오른쪽 빈 패널) ──
router.get("/", (req, res) => {
  // 사람 탭(관계자·아티스트)은 연락처로 이관됨(2026-07-17 사람/조직 축 정리) — 옛 링크·북마크는 그 필터로 보낸다.
  const legacyPeopleTab = { associate: "associate", artist: "artist" }[String(req.query.group || "")];
  if (legacyPeopleTab) {
    const q0 = String(req.query.q || "").trim();
    return res.redirect(`/contacts?tab=${legacyPeopleTab}${q0 ? `&q=${encodeURIComponent(q0)}` : ""}`);
  }
  res.send(renderClients(req, null));
});

// 신규 업체·그룹 드롭다운(페이지 이동 없이 유형 선택) — CSP 안전한 <details> 팝오버. 사람(관계자·아티스트)은 연락처 생성(2026-07-17).
function newClientMenuHtml() {
  return `
    <details class="relative inline-block" data-menu>
      <summary class="btn-primary cursor-pointer select-none list-none [&::-webkit-details-marker]:hidden">+ 새 업체·그룹</summary>
      <div class="absolute right-0 z-20 mt-1 w-56 overflow-hidden rounded-lg border border-border bg-bg py-1 text-left shadow-lg">
        <a href="/clients/new?type=company" class="block px-4 py-2 text-sm hover:bg-surface active:bg-surface"><span class="font-medium text-fg">업체</span> <span class="text-xs text-muted">소속사·제작사</span></a>
        <a href="/clients/new?type=group" class="block px-4 py-2 text-sm hover:bg-surface active:bg-surface"><span class="font-medium text-fg">그룹</span> <span class="text-xs text-muted">밴드·아이돌</span></a>
      </div>
    </details>`;
}

// 2단 렌더(연락처 renderContacts와 대칭) — 왼쪽 업체/그룹 탭+검색+이름 목록, 오른쪽 rightHtml(없으면 빈 패널).
function renderClients(req, sel, rightHtml, backHref) {
  const q = String(req.query.q || "").trim();
  const group = ["company", "group"].includes(req.query.group) ? req.query.group : "company";
  const all = listClients({});
  const companyCount = all.filter((c) => c.kind === "company").length;
  const groupCount = all.filter((c) => c.kind === "group").length;
  let rows = all.filter((c) => c.kind === group);
  if (q) { const ql = q.toLowerCase(); rows = rows.filter((c) => String(c.name || "").toLowerCase().includes(ql)); }
  const keep = `?group=${group}${q ? "&q=" + encodeURIComponent(q) : ""}`;

  const tabs = tabBar({
    tabs: [
      { key: "company", label: `업체 ${companyCount}` },
      { key: "group", label: `그룹 ${groupCount}` },
    ],
    activeKey: group,
    hrefFn: (k) => `/clients?group=${k}${q ? "&q=" + encodeURIComponent(q) : ""}`,
  });
  const searchBar = searchBox({
    action: "/clients", q, placeholder: group === "group" ? "그룹 검색" : "업체명 검색", label: group === "group" ? "그룹 검색" : "업체 검색",
    liveFilter: true, noButton: true, hidden: `<input type="hidden" name="group" value="${esc(group)}" />`,
  });
  const resultNote = q
    ? `<div class="mb-3 text-sm text-muted">"${esc(q)}" 결과 ${rows.length}건 · <a href="/clients?group=${group}" class="text-primary hover:underline">전체 보기</a></div>`
    : "";
  const list = rows.length
    ? contactNameList({ rows, selectedId: sel ? sel.id : null, hrefFn: (c) => `/clients/${c.id}${keep}` })
    : q
      ? emptyState(`"${esc(q)}" 검색 결과가 없습니다.`, { card: true, icon: "clients" })
      : group === "group"
        ? emptyState("등록된 그룹이 없습니다.", { card: true, icon: "clients", cta: { href: "/clients/new?type=group", label: "+ 새 그룹" } })
        : emptyState("등록된 업체가 없습니다.", { card: true, icon: "clients", cta: { href: "/clients/new?type=company", label: "+ 새 업체" } });

  const left = `${searchBar}${resultNote}${list}`;
  const right = rightHtml || emptyState("업체·그룹을 선택하세요.", { card: true, icon: "clients" });

  const action = newClientMenuHtml();
  const body = `
    ${flashBanner(req.query)}
    ${pageHeader({ title: "업체·그룹", action })}
    ${tabs}
    ${contactPanes({ left, right, hasSelection: !!sel, backHref: backHref || `/clients${keep}`, backLabel: "업체·그룹" })}`;
  return layout({ title: sel ? sel.name : "업체·그룹", user: req.user, current: "/clients", body, wide: true });
}

// ── 검색 제안(typeahead JSON) — 반드시 /:id 앞에 등록. listClients는 q 미지원이라 이름/활동명 인메모리 필터 ──
router.get("/suggest", (req, res) => {
  const ql = String(req.query.q || "").trim().toLowerCase();
  if (!ql) return res.json([]);
  const rows = listClients({})
    .filter((c) => String(c.name || "").toLowerCase().includes(ql) || String(c.activity_name || "").toLowerCase().includes(ql))
    .slice(0, 8);
  res.json(rows.map((c) => ({
    label: c.is_artist && c.kind === "person" ? personLabel(c.activity_name || c.name, c.name) : c.name, // 아티스트=활동명 (본명) 병기
    sub: c.kind === "company" ? "업체" : c.kind === "group" ? "그룹" : c.is_artist ? "아티스트" : "",
    href: `/clients/${c.id}`,
  })));
});

// ── 새 클라이언트 ── 유형(업체/아티스트/그룹)은 목록의 드롭다운(또는 탭별 빈 상태 CTA)에서만 선택 → 유형별 폼.
const CLIENT_TYPES = ["company", "artist", "group"];
router.get("/new", (req, res) => {
  if (req.query.type === "artist") return res.redirect("/contacts/new"); // 사람 생성은 연락처(2026-07-17)
  const type = ["company", "group"].includes(req.query.type) ? req.query.type : null;
  if (!type) return res.redirect("/clients"); // 유형 선택 페이지 폐기(드롭다운만) — 유형 없는 진입은 목록으로
  const typeLabel = type === "company" ? "업체" : "그룹";
  const companies = listClients({}).filter((x) => x.kind === "company");
  res.send(layout({ title: `새 ${typeLabel}`, user: req.user, current: "/clients", body: clientForm({}, false, [], "", false, listContacts({}), companies, false, true, type) }));
});

/**
 * 대표자 칩(공동대표 가능) 해석 — `owner_id`(당사자 id·신규는 빈값) + `owner_name`(순수 본명) 쌍의 인덱스 페어링.
 * id가 있으면 그대로, 없으면 이름으로 재사용/생성. 호칭 '대표님'·소속 연결은 setCompanyOwners가 처리.
 */
function resolveOwnerIds(b) {
  const asArr = (v) => (Array.isArray(v) ? v : v != null && v !== "" ? [v] : []);
  const ids = asArr(b.owner_id);
  const names = asArr(b.owner_name);
  const out = [];
  for (let i = 0; i < Math.max(ids.length, names.length); i++) {
    const pid = Number(ids[i]) || null;
    const resolved = pid || (String(names[i] || "").trim() ? resolvePersonByName(names[i]) : null);
    if (resolved && !out.includes(resolved)) out.push(resolved);
  }
  return out;
}

// 그룹 담당자(personCombo) 해석 — hidden contact_party_id 우선, 없으면 타이핑 이름으로 재사용/생성(resolvePersonByName), 비면 null.
function resolveContactPartyId(b) {
  if (b.contact_party_id) return Number(b.contact_party_id);
  const nm = String(b.contact_name || "").trim();
  return nm ? resolvePersonByName(nm) : null;
}

router.post("/", (req, res) => {
  const b = req.body;
  const type = CLIENT_TYPES.includes(b.type) ? b.type : "artist"; // 업체/아티스트/그룹(폼 hidden)
  const typeLabel = type === "company" ? "업체" : "그룹"; // 오류 재렌더용 표시 라벨(2026-07-17)
  const name = String(b.party_name != null ? b.party_name : b.name || "").trim(); // 폼 필드=party_name(Chrome name= 자동완성 회피 — 함정 #19·#21)
  if (!name) {
    const companies = listClients({}).filter((x) => x.kind === "company");
    return res.send(layout({ title: `새 ${typeLabel}`, user: req.user, current: "/clients", body: clientForm({ ...b, _err: "이름을 입력하세요." }, false, [], "", false, listContacts({}), companies, false, true, type) }));
  }
  let id;
  if (type === "group") {
    // 그룹 아티스트(밴드·아이돌 그룹) → group party(is_artist, 사람 아님). 담당자(멤버/관계자) 연결.
    id = createGroup({ name, phone: b.phone, email: b.email, memo: b.memo, cash_receipt_no: b.cash_receipt_no, contact_party_id: resolveContactPartyId(b) });
  } else if (type === "company") {
    const ownerIds = resolveOwnerIds(b); // 대표자 칩(공동대표) → 사람 party 목록
    const bizNo = formatBizNo(b.biz_no);
    // 같은 이름의 업체가 이미 있으면 **새로 만들지 않고 그 업체를 쓴다**(2026-07-14 — '뮤직팜'이 3개로 늘어난 사고:
    // 서버에 이름 중복 검사가 없어 같은 폼을 두 번 저장하면 그대로 두 party가 생겼다).
    // 단, 사업자등록번호가 서로 다르면 진짜 다른 회사이므로 새로 만든다(동명이업 허용).
    const existingId = resolveCompanyByName(name);
    const existing = existingId ? getParty(existingId) : null;
    const differentBiz = existing && existing.biz_no && bizNo && existing.biz_no !== bizNo;
    if (existing && !differentBiz) {
      id = existing.id;
      // 기존 값은 덮지 않고 **빈 칸만 채운다**(사용자가 새로 적어 온 정보는 살리되, 기존 정보는 보존).
      const fill = {};
      if (!existing.biz_no && bizNo) fill.biz_no = bizNo;
      const addr = b.biz_address != null ? b.biz_address : b.address;
      if (!existing.address && addr) fill.address = addr;
      if (!existing.phone && b.phone) fill.phone = b.phone;
      if (!existing.email && b.email) fill.email = b.email;
      if (!existing.memo && b.memo) fill.memo = b.memo;
      if (Object.keys(fill).length) updateParty(id, fill);
      for (const role of String(companyRolesFrom(b) || "").split(",").map((r) => r.trim()).filter(Boolean)) addCompanyRole(id, role);
      // 대표자는 **병합**(기존 공동대표 유지 + 새 대표 추가) — setCompanyOwners는 통째 교체라 그대로 부르면
      // 기존 공동대표가 해제되고 owner_name(세금계산서 '성명(대표자)' 원천)까지 덮인다(2026-07-15 점검).
      if (ownerIds.length) {
        const merged = [...new Set([...listCompanyOwners(id).map((o) => Number(o.id)), ...ownerIds.map(Number)])];
        setCompanyOwners(id, merged);
      }
      // 담당자 연동은 **폼에 담당자 필드가 있을 때만** — 간이 등록 모달(담당자 칸 없음)이 이 분기를 타면
      // linkClientContact가 빈 목록으로 setOrgContacts를 불러 기존 담당자 지정(is_contact)을 전원 해제한다(2026-07-15 점검).
      if (b.contact_id != null || b.contact_name != null) linkClientContact(id, b);
      if (req.get("X-Requested-With") === "fetch") {
        const pp = getParty(id);
        return res.json({ ok: true, id, name: pp.name, kind: pp.kind, existing: true });
      }
      return res.redirect("/clients?notice=" + encodeURIComponent(`같은 이름의 업체가 이미 있어 기존 '${name}'에 반영했습니다.`) + "#c" + id);
    }
    id = createCompany({
      name, phone: b.phone, email: b.email, memo: b.memo,
      biz_no: bizNo,
      address: b.biz_address != null ? b.biz_address : b.address, roles: companyRolesFrom(b),
    });
    setCompanyOwners(id, ownerIds); // 호칭 '대표님'·소속(직함 '대표')·레거시 owner_party_id/owner_name 동기화
  } else {
    // 아티스트(개인·솔로) → 사람 party. 본명(real_name) 있으면 name=본명·활동명=입력, 없으면 name=활동명=입력.
    const realName = String(b.real_name || b.artist_real_name || "").trim();
    id = createPerson({
      name: realName || name, phone: b.phone, email: b.email, memo: b.memo,
      activity_name: name, is_artist: 1, cash_receipt_no: b.cash_receipt_no,
    });
    if (b.group_id) setPartyGroup(id, b.group_id); // 아티스트 생성 시 소속 그룹 선택했으면 연결
  }
  if (type !== "company" && String(b.agency_company || "").trim()) setPartyAgency(id, ensureCompanyParty(b.agency_company, "소속사/레이블")); // 아티스트·그룹 소속사 연결(콤보 이름→업체 party, 없으면 생성; 빈값=no-op)
  if (type === "company") linkClientContact(id, b); // 업체만 담당자 연락처 연동
  if (req.get("X-Requested-With") === "fetch") { // 간이 등록(프로젝트 폼 모달 등) — 리다이렉트 대신 JSON
    const pp = getParty(id);
    return res.json({ ok: true, id, name: pp.activity_name || pp.name, kind: pp.kind });
  }
  res.redirect("/clients?flash=created#c" + id);
});

// ── 수정 — 2단 편집 화면(왼쪽 목록 유지 + 오른쪽 편집 패널, 연락처 /contacts/:id/edit와 대칭) ──
// Express 라우팅: 정적 세그먼트 `/edit`가 `/:id`(GET, 아래)보다 먼저 매칭되도록 이 라우트를 위에 둔다.
router.get("/:id/edit", asyncHandler(async (req, res) => {
  const c = getParty(Number(req.params.id));
  if (!c) return res.status(404).send(errorPage({ code: 404, title: "업체·그룹을 찾을 수 없습니다", message: "삭제되었거나 주소가 잘못되었습니다.", user: req.user }));
  if (c.kind === "person") return res.redirect(`/contacts/${c.id}/edit`);
  const returnTo = safePath(String(req.query.return || "")) || null;
  res.send(renderClients(req, c, editPaneForClient(c, returnTo), `/clients/${c.id}`));
}));

// 편집 패널 — 데이터 조회 + clientEditPane 조립(연락처 editPaneFor와 대칭).
function editPaneForClient(c, returnTo = null) {
  const files = listClientFiles(c.id);
  const isCompany = c.kind === "company";
  const companies = listClients({}).filter((x) => x.kind === "company");
  if (!isCompany) { c.agency_id = currentAgencyId(c.id); c.agency_name = currentAgencyName(c.id); } // 소속사 콤보 기본값
  // 크로스링크(대표자 연락처) — 현행 상세 crossRefBlock의 대표자 부분만 유지(연락처로 보기·소속 그룹은 조직엔 무의미).
  const crossRefsHtml = (() => {
    const owners = isCompany ? listCompanyOwners(c.id) : [];
    if (!owners.length) return "";
    const links = owners.map((o) => `<a href="/contacts/${o.id}" class="text-primary hover:underline">${esc(personName(o))} ↗</a>`).join(" · ");
    return `<div><span class="text-muted">대표자 연락처</span> ${links}</div>`;
  })();
  return clientEditPane(c, {
    files,
    contacts: listContacts({}),
    companies,
    members: c.kind === "group" ? listGroupMembers(c.id) : [],
    memberCandidates: c.kind === "group" ? artistPersonOptions().filter((a) => Number(a.group_id) !== c.id) : [],
    crossRefsHtml,
    cancelHref: returnTo || `/clients/${c.id}`,
    returnTo,
  });
}

router.post("/:id", (req, res) => {
  const id = Number(req.params.id);
  const c = getParty(id);
  if (!c) return res.status(404).send(errorPage({ code: 404, title: "업체·그룹을 찾을 수 없습니다", message: "삭제되었거나 주소가 잘못되었습니다.", user: req.user }));
  const isFetch = req.get("X-Requested-With") === "fetch"; // 자동저장(AJAX)
  const b = req.body;
  const name = String(b.party_name != null ? b.party_name : b.name || "").trim(); // 폼 필드=party_name(Chrome name= 자동완성 회피 — 함정 #19·#21)
  const typeLabel = c.kind === "group" ? "그룹" : "업체"; // 오류 재렌더용 표시 라벨(2026-07-17)
  if (!name) {
    if (isFetch) return res.status(400).json({ ok: false, error: "이름을 입력하세요." });
    const files = listClientFiles(id);
    return res.send(layout({ title: `${typeLabel} 수정`, user: req.user, current: "/clients", body: clientForm({ ...c, ...b, _err: "이름을 입력하세요." }, true, files, "", true, listContacts({}), listClients({}).filter((x) => x.kind === "company"), false, true) }));
  }
  // kind는 party 정체성이라 불변 — 폼 유형 고정, 현재 party.kind 기준으로 필드 갱신(updateParty가 분기).
  updateParty(id, {
    name, phone: b.phone, email: b.email, memo: b.memo,
    // company 필드
    biz_no: formatBizNo(b.biz_no), // owner_name/owner_party_id는 미전송(보존) — 아래 setCompanyOwners가 조인 테이블 기준으로 동기화
    address: b.biz_address != null ? b.biz_address : b.address, roles: c.kind === "company" ? companyRolesFrom(b) : null,
    // 정체성 단일화(2026-07-16): **그룹은 항상**, **솔로 아티스트도 편집 전 이름==활동명이었으면**(본명 따로 없는 흔한 경우)
    // activity_name을 새 name과 동기화 → 옛 activity_name이 남아 '옛이름 (새이름)'으로 병기되던 버그 방지.
    // 본명≠활동명(모달 등록 등)이면 activity_name 보존(이름 필드=본명 편집이므로 활동명 유지). 그 외 person도 보존.
    activity_name: (c.kind === "group" || c.name === c.activity_name) ? name : c.activity_name, is_artist: c.is_artist,
    cash_receipt_no: c.kind === "group" ? c.cash_receipt_no : b.cash_receipt_no, // 그룹은 폼에 필드 없음 → 기존값 보존(개인 아티스트만 현금영수증)
    // 그룹 담당자(멤버/관계자) — 그룹일 때만 폼에서 전송(person은 undefined로 보존)
    contact_party_id: c.kind === "group" ? resolveContactPartyId(b) : undefined,
  });
  if (b.group_id !== undefined) setPartyGroup(id, b.group_id); // 개인 아티스트의 소속 그룹 연결
  if (c.kind !== "company" && b.agency_company !== undefined) setPartyAgency(id, String(b.agency_company).trim() ? ensureCompanyParty(b.agency_company, "소속사/레이블") : null); // 아티스트·그룹 소속사 콤보(이름→party, 비우면 해제)
  if (c.kind === "company") linkClientContact(id, b); // 업체만 담당자 연락처 연동
  if (c.kind === "company") setCompanyOwners(id, resolveOwnerIds(b)); // 대표자 칩(공동대표) — 호칭·소속·레거시 컬럼 동기화. 빈 목록이면 대표 전원 해제
  if (isFetch) return res.json({ ok: true }); // 자동저장 — 페이지 유지
  res.redirect(`/clients/${id}?flash=saved`); // 수동 저장(noscript): 상세로 복귀
});

// ── 삭제(강제: 연결된 프로젝트·청구서·사용자의 client_id는 SET NULL으로 자동 해제) ──
// 단, 발행/입금완료 인보이스가 있으면 청구처 보존을 위해 삭제 거부
router.post("/:id/delete", (req, res) => {
  const id = Number(req.params.id);
  const active = db().prepare("SELECT 1 FROM invoices WHERE payer_id=? AND (status='발행' OR tax_status IN ('계산서 발행','입금완료')) LIMIT 1").get(id); // 청구서 발행 또는 계산서·입금 진행분이면 청구처 보존
  if (active) return res.status(409).send(errorPage({ code: 409, title: "청구처로 발행된 청구가 있어 삭제할 수 없습니다", message: "발행·입금완료된 청구의 청구처입니다. 관련 청구를 먼저 정리하세요(매출 추적 보존).", user: req.user }));
  logAudit(req.user, "party.delete", `#${id} ${(getParty(id) || {}).name || ""}`.trim());
  deleteParty(id); // 하드 삭제(파티) — 역할 참조 정리·첨부 CASCADE
  res.redirect("/clients?flash=deleted");
});

// ── 그룹 멤버 연결/해제(그룹 아티스트 ↔ 개인 아티스트) ──
router.post("/:id/members", (req, res) => {
  const id = Number(req.params.id);
  const g = getParty(id);
  if (!g || g.kind !== "group") return res.status(404).send(errorPage({ code: 404, title: "그룹을 찾을 수 없습니다", message: "그룹 아티스트만 멤버를 가질 수 있습니다.", user: req.user }));
  // personCombo: 선택 id 우선, 없으면 타이핑한 이름으로 재사용/생성(resolvePersonByName). 새 멤버 추가.
  let memberId = Number(req.body.member_id) || 0;
  if (!memberId) { const nm = String(req.body.member_name || "").trim(); if (nm) memberId = resolvePersonByName(nm); }
  if (memberId) {
    db().prepare("UPDATE parties SET is_artist = 1 WHERE id = ? AND kind = 'person'").run(memberId); // 그룹 멤버 = 개인 아티스트
    setPartyGroup(memberId, id); // 개인 아티스트를 이 그룹 소속으로(다른 그룹이면 이동)
  }
  res.redirect(`/clients/${id}/edit`); // 멤버 편집은 편집 화면 액션 — 편집 뷰로 복귀
});
router.post("/:id/members/:mid/remove", (req, res) => {
  const id = Number(req.params.id);
  const mid = Number(req.params.mid);
  const m = getParty(mid);
  if (m && Number(m.group_id) === id) setPartyGroup(mid, null); // 이 그룹 소속일 때만 해제
  res.redirect(`/clients/${id}/edit`);
});

// ── 첨부 서류 업로드(치프·스태프 — requireEditor) ──
// 보안: 디스크 multer + 매직바이트 검증(PNG·JPEG·PDF) + 인증 다운로드만(공개 링크 없음).
router.post("/:id/files/:kind", requireEditor, upload.single("file"), asyncHandler(async (req, res) => {
  const id = Number(req.params.id);
  const kind = req.params.kind;
  const c = getParty(id);
  if (!c) {
    if (req.file) fs.promises.unlink(req.file.path).catch(() => {});
    return res.status(404).send(errorPage({ code: 404, title: "업체·그룹을 찾을 수 없습니다", message: "", user: req.user }));
  }
  if (!FILE_KINDS.find((k) => k.key === kind)) {
    if (req.file) fs.promises.unlink(req.file.path).catch(() => {});
    return res.redirect(`/clients/${id}/edit?ferr=${encodeURIComponent("알 수 없는 서류 종류입니다.")}`);
  }
  if (!req.file) {
    return res.redirect(`/clients/${id}/edit?ferr=${encodeURIComponent("파일을 선택하세요.")}`);
  }

  // 매직바이트 검증: Content-Type 헤더를 신뢰하지 않고 파일 첫 바이트로 직접 확인
  const detectedMime = detectMimeFromFile(req.file.path);
  if (!detectedMime) {
    fs.promises.unlink(req.file.path).catch(() => {});
    return res.redirect(`/clients/${id}/edit?ferr=${encodeURIComponent("PNG, JPG, PDF 파일만 업로드할 수 있습니다.")}`);
  }

  const originalName = decodeName(req.file.originalname);
  try {
    const { backend, fileId } = await storage.put({ filePath: req.file.path, name: originalName, mimeType: detectedMime, folder: fileKindLabel(kind) }); // 사업자등록증·통장사본 하위 폴더로
    // 기존 같은 kind 파일을 교체하는 경우 이전 파일 스토리지 정리
    const old = upsertClientFile(id, kind, { storage_backend: backend, file_id: fileId, file_name: originalName, mime_type: detectedMime, file_size: req.file.size });
    if (old) await storage.remove(old.storage_backend, old.file_id);
    res.redirect(`/clients/${id}/edit?flash=saved`);
  } catch (e) {
    console.error("[client file upload]", e);
    const msg = e && e.code === "DRIVE_UPLOAD_FAILED"
      ? "구글 Drive 업로드에 실패했습니다 — 로컬에 저장하지 않았습니다. 잠시 후 다시 시도하거나 환경설정 › 일반 › 자료 저장에서 Drive 연동을 확인하세요."
      : "업로드에 실패했습니다.";
    res.redirect(`/clients/${id}/edit?ferr=${encodeURIComponent(msg)}`);
  } finally {
    if (req.file) fs.promises.unlink(req.file.path).catch(() => {});
  }
}));

// ── 첨부 서류 인증 다운로드(치프·스태프 인증 후 프록시 — 공개 URL 없음) ──
// ── 첨부 서류 뷰어(팝업 전용, 2026-07-08) — 이미지가 팝업 창을 꽉 채우게. PDF는 내장 뷰어가 이미 꽉 채워 raw로 리다이렉트.
router.get("/:id/files/:kind/view", requireEditor, (req, res) => {
  const id = Number(req.params.id);
  const kind = req.params.kind;
  const meta = FILE_KINDS.find((k) => k.key === kind);
  if (!meta) return res.status(404).send("파일을 찾을 수 없습니다.");
  const cf = getClientFile(id, kind);
  if (!cf) return res.status(404).send(errorPage({ code: 404, title: "파일이 없습니다", message: "아직 업로드된 파일이 없습니다.", user: req.user }));
  if ((cf.mime_type || "").includes("pdf")) return res.redirect(`/clients/${id}/files/${kind}/raw`);
  res.setHeader("Cache-Control", "private, no-store");
  res.send(fileViewerPage({ title: meta.label, rawUrl: `/clients/${id}/files/${kind}/raw` }));
});

router.get("/:id/files/:kind/raw", requireEditor, asyncHandler(async (req, res) => {
  const id = Number(req.params.id);
  const kind = req.params.kind;
  if (!FILE_KINDS.find((k) => k.key === kind)) return res.status(404).send("파일을 찾을 수 없습니다.");
  const cf = getClientFile(id, kind);
  if (!cf) return res.status(404).send(errorPage({ code: 404, title: "파일이 없습니다", message: "아직 업로드된 파일이 없습니다.", user: req.user }));
  res.setHeader("Cache-Control", "private, no-store");
  res.setHeader("Content-Type", cf.mime_type || "application/octet-stream");
  // inline: 이미지·PDF를 브라우저에서 직접 표시(다운로드 강제 없음)
  res.setHeader("Content-Disposition", `inline; filename*=UTF-8''${encodeURIComponent(cf.file_name)}`);
  if (cf.file_size > 0) res.setHeader("Content-Length", cf.file_size);
  try {
    await storage.stream(cf.storage_backend, cf.file_id, res);
  } catch (e) {
    console.error("[client file stream]", e);
    if (!res.headersSent) res.status(502).send("파일을 가져오지 못했습니다.");
    else res.destroy();
  }
}));

// ── 첨부 서류 삭제 ──
router.post("/:id/files/:kind/delete", requireEditor, asyncHandler(async (req, res) => {
  const id = Number(req.params.id);
  const kind = req.params.kind;
  if (!FILE_KINDS.find((k) => k.key === kind)) return res.redirect(`/clients/${id}/edit`);
  const old = deleteClientFile(id, kind);
  if (old) await storage.remove(old.storage_backend, old.file_id);
  res.redirect(`/clients/${id}/edit?flash=deleted`);
}));

// ── 클라이언트 상세(프로젝트 + 청구·결제 히스토리 + 첨부 서류 링크) ──
router.get("/:id", asyncHandler(async (req, res) => {
  const c = getParty(Number(req.params.id));
  if (!c) return res.status(404).send(errorPage({ code: 404, title: "업체·그룹을 찾을 수 없습니다", message: "삭제되었거나 주소가 잘못되었습니다.", user: req.user }));
  // 사람은 전부 연락처에서 본다(2026-07-17 사람/조직 축 정리 — 이전엔 비아티스트만 리다이렉트라
  // 같은 사람이 아티스트면 클라이언트 상세, 아니면 연락처로 갈리고 편집 폼도 두 벌이었다).
  if (c.kind === "person") {
    const from = String(req.query.from || "");
    const retQ = String(req.query.return || "");
    const qs = [
      from && /^[\w=&%.\-]*$/.test(from) ? `from=${from}` : "",
      safePath(retQ) ? `return=${encodeURIComponent(retQ)}` : "", // 청구·프로젝트 복귀 경로 보존(2026-07-08)
    ].filter(Boolean).join("&");
    return res.redirect(`/contacts/${c.id}${qs ? `?${qs}` : ""}`);
  }
  // 읽기 뷰 데이터 조회 — 목록에서 넘어왔으면 그 필터로(?from=), 청구·프로젝트에서 넘어왔으면 ?return=(내부 절대경로만)으로 복귀.
  const from = String(req.query.from || "");
  const fromOk = from && /^[\w=&%.\-]*$/.test(from);
  const retQ = String(req.query.return || "");
  const ret = safePath(retQ);
  const clientsBackHref = ret || (fromOk ? `/clients?${from}` : "/clients");
  const right = await readPaneForClient(c);
  res.send(renderClients(req, c, right, clientsBackHref));
}));

// 읽기 패널 — 상세 데이터 조회 + clientReadView 조립(연락처 readPaneFor와 대칭). c=조직 party. storage.exists가 async라 이 함수도 async.
async function readPaneForClient(c) {
  const isCompany = c.kind === "company";
  const files = listClientFiles(c.id);
  let bizLicenseOk = false;
  const biz = files.find((f) => f.kind === "biz_license");
  if (biz) {
    try { bizLicenseOk = await storage.exists(biz.storage_backend, biz.file_id); }
    catch (_e) { bizLicenseOk = true; } // 확실한 부재(404/휴지통)만 false, 불확실은 true(깨진 링크 오탐 방지)
  }
  const opts = {
    projects: listProjectsForParty(c.id), // c.id(숫자)를 넘겨야 함 — 객체를 넘기면 Number(c)=NaN이라 매칭 0
    invoices: listInvoicesForParty(c.id),
    editHref: `/clients/${c.id}/edit`,
  };
  if (isCompany) {
    opts.owners = listCompanyOwners(c.id);
    opts.contacts = listOrgContacts(c.id);
    opts.artists = listArtistsForAgency(c.id);
    opts.bizLicenseOk = bizLicenseOk;
  } else {
    opts.members = listGroupMembers(c.id);
    opts.agencyId = currentAgencyId(c.id);
    opts.agencyName = currentAgencyName(c.id);
    opts.groupContact = c.contact_party_id ? getParty(c.contact_party_id) : null;
  }
  return clientReadView(c, opts);
}

// ── 헬퍼 함수 ──
// 렌더 함수(clientProjectCard·clientFileSection·clientContactCombo·clientForm·clientFilesBlock)는
// src/views.clients.js로 이동(2026-07-09) — 여기 남은 건 req/db가 얽힌 쓰기 로직만.

/**
 * 클라이언트 담당자(연락처) 연동 — 콤보에 남은 사람만 이 클라이언트 담당자로 통째 교체(2026-07-10 사용자 결정).
 * 제출 = 칩마다 `contact_id`(당사자 id·신규는 빈값) + `contact_name`(순수 본명) 쌍(personCombo multi, 인덱스 페어링).
 * id가 있으면 그대로 쓰고(표시 라벨 파싱 없음 — '엄유미 실장님'이 새 사람으로 등록될 여지 없음),
 * 신규 칩은 이름으로 재사용/생성(resolvePersonByName). 담당자 해제(재직 유지)는 setOrgContacts가 처리.
 */
function linkClientContact(clientId, body) {
  const asArr = (v) => (Array.isArray(v) ? v : v != null && v !== "" ? [v] : []);
  const rawIds = asArr(body.contact_id);
  const rawNames = asArr(body.contact_name);
  const ids = [];
  const push = (pid) => { if (pid && !ids.includes(pid)) ids.push(pid); };
  for (let i = 0; i < Math.max(rawIds.length, rawNames.length); i++) {
    const pid = Number(rawIds[i]) || null;
    if (pid) { push(pid); continue; }
    const nm = String(rawNames[i] || "").trim();
    if (nm) push(resolvePersonByName(nm)); // 목록에 없는 이름 → 기존 재사용 또는 새 연락처 생성
  }
  setOrgContacts(Number(clientId), ids);
}

module.exports = router;
