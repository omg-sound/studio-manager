"use strict";

const fs = require("fs");
const express = require("express");
const { db } = require("../db");
const { requireEditor } = require("../auth");
const { COMPANY_ROLES, ARTIST_ACTIVITY_FORM_LABELS } = require("../config");
const {
  listClients, getParty, listProjectsForParty,
  listInvoicesForParty,
  listClientFiles, getClientFile, upsertClientFile, deleteClientFile,
  setOrgContacts, setCompanyOwners, listCompanyOwners, listContacts, listAssociates, resolvePersonByName,
  listArtistsForAgency,
  createCompany, createGroup, createPerson, updateParty, deleteParty,
  listGroupsForPicker, setPartyGroup, listGroupMembers, artistPersonOptions, groupOfParty,
  setPartyAgency, currentAgencyId, currentAgencyName, ensureCompanyParty, resolveCompanyByName, addCompanyRole,
} = require("../data");
const storage = require("../storage");
const { asyncHandler } = require("../lib/async");
const { logAudit } = require("../lib/audit"); // 파괴적·재무 액션 기록(fail-safe)
const { buildUpload, decodeName, detectMimeFromFile } = require("../lib/attachments"); // 첨부 보안 로직 공용(2026-07-09 통합)
const { formatBizNo } = require("../lib/forms");
const { stripTrailingTitle } = require("../lib/korean-name");
const { safePath } = require("../lib/nav"); // ?return= 복귀 경로 검증(공용)
const { layout, pageHeader, esc, personLabel, personName, flashBanner, emptyState, capList, formatKRW, errorPage, tabBar, listGroup, listRow, listRowLinked, dataTable, contactTable, explain, personCombo, copyable, searchBox, fileViewerPage } = require("../views");
const { invoiceRow } = require("../views.invoices");
const { FILE_KINDS, fileKindLabel, clientProjectCard, clientFilesBlock, clientForm } = require("../views.clients");

const router = express.Router();

router.use(requireEditor); // 클라이언트 전 라우트(목록·상세·편집·첨부 서류) 편집자(치프·스태프). 매출만 별도 제한(revenue).

// 첨부 서류 업로드: 디스크 스토리지(메모리 금지 — OOM 방지, 플레이북 §3-2), 10MB 제한
const upload = buildUpload("omgcf_"); // 공용 첨부 업로더(lib/attachments — 매직바이트·한도 정책 단일화)

/** 폼에서 업체 역할(CSV) 추출: 체크된 유효 roles만(없으면 null → 배지 '업체' 폴백). 업체 유형에서만 호출. */
function companyRolesFrom(b) {
  const checked = [].concat(b.roles || []).filter((r) => COMPANY_ROLES.includes(r));
  return checked.length ? checked.join(",") : null;
}

// ── 목록(서브메뉴 = 업체/아티스트 우선 분리 + 업체 내 분류 · 이름 검색) ──
router.get("/", (req, res) => {
  // 당사자 모델 분류(서로 섞이지 않음): 업체(company) / 관계자(사람·비아티스트: 대표·A&R·담당자·디렉터·작가) / 아티스트(개인 솔로) / 그룹(밴드·아이돌).
  // '전체' 탭 폐기(2026-07-03). 기본 진입 = 업체. 관계자 상세는 연락처(/contacts/:id).
  const group = ["company", "associate", "artist", "group"].includes(req.query.group) ? req.query.group : "company";
  const activeKind = ""; // 레거시 2차 필터 제거(호환용 빈값 유지)
  const q = String(req.query.q || "").trim();

  const isSoloArtist = (c) => c.is_artist && c.kind === "person";
  const allRows = listClients({});
  const artistCount = allRows.filter(isSoloArtist).length;
  const groupCount = allRows.filter((c) => c.kind === "group").length;
  const companyCount = allRows.filter((c) => c.kind === "company").length;
  const associateCount = listAssociates({}).length;

  // 표시 행: 관계자 탭은 사람(비아티스트) 소스, 나머지는 클라이언트(업체/아티스트/그룹).
  let displayed;
  if (group === "associate") {
    displayed = listAssociates({ q }); // 이름/전화 검색 포함
  } else {
    let rows = allRows;
    if (group === "artist") rows = allRows.filter(isSoloArtist);
    else if (group === "group") rows = allRows.filter((c) => c.kind === "group");
    else rows = allRows.filter((c) => c.kind === "company");
    const ql = q.toLowerCase();
    displayed = q ? rows.filter((c) => c.name.toLowerCase().includes(ql)) : rows;
  }
  // 목록 상한(2026-07-09 스케일 점검) — 아티스트·관계자 탭이 계속 누적되므로 기본 100건 + 더 보기(검색·개수 라벨은 전체 기준).
  const capTotal = displayed.length;
  const capped = capList(displayed, req.query, (n) => `/clients?group=${group}${q ? "&q=" + encodeURIComponent(q) : ""}&limit=${n}`);
  displayed = capped.shown;

  const qs = (params) => {
    const p = Object.entries(params).filter(([, v]) => v).map(([k, v]) => `${k}=${encodeURIComponent(v)}`);
    if (q) p.push("q=" + encodeURIComponent(q));
    return p.length ? "/clients?" + p.join("&") : "/clients";
  };
  // 1차 서브메뉴(업체/관계자/아티스트/그룹) — 탭 스타일(연락처 탭과 통일). '전체' 폐기.
  const groupChips = tabBar({
    tabs: [
      { key: "company", label: `업체 ${companyCount}` },
      { key: "associate", label: `관계자 ${associateCount}` },
      { key: "artist", label: `아티스트 ${artistCount}` },
      { key: "group", label: `그룹 ${groupCount}` },
    ],
    activeKey: group,
    hrefFn: (key) => qs({ group: key }),
  });
  const kindChips = ""; // 2차 분류 필터 폐기(당사자 모델 — 조직 겸업은 roles 배지로 표시)

  // 검색 문구는 탭별 명사(2026-07-16 사용자 요청 '이름 검색→업체명 검색').
  const searchNoun = { company: "업체명", associate: "관계자", artist: "아티스트", group: "그룹" }[group] || "이름";
  const searchBar = searchBox({
    action: "/clients", q, placeholder: `${searchNoun} 검색`, label: "클라이언트 검색", liveFilter: true,
    hidden: `${group ? `<input type="hidden" name="group" value="${esc(group)}" />` : ""}${activeKind ? `<input type="hidden" name="kind" value="${esc(activeKind)}" />` : ""}`,
  });

  const clearQHref = group === "company" && activeKind ? `/clients?group=company&kind=${encodeURIComponent(activeKind)}` : group ? `/clients?group=${group}` : "/clients";
  const resultNote = q
    ? `<div class="mb-3 text-sm text-muted">"${esc(q)}" 결과 ${capTotal}건 · <a href="${clearQHref}" class="text-primary hover:underline">전체 보기</a></div>`
    : "";

  // 상세로 넘어갈 때 현재 필터를 from으로 전달 → 상세의 '← 클라이언트' 백링크가 같은 필터로 복귀.
  const fromQ = [group ? `group=${encodeURIComponent(group)}` : "", activeKind ? `kind=${encodeURIComponent(activeKind)}` : "", q ? `q=${encodeURIComponent(q)}` : ""].filter(Boolean).join("&");
  const fromParam = fromQ ? `?from=${encodeURIComponent(fromQ)}` : "";
  // 복귀 경로(2026-07-14 — 상세 백링크가 보던 탭·검색으로 돌아오게. 전 목록 공통 방식).
  const retParam = `${fromParam ? "&" : "?"}return=${encodeURIComponent(req.originalUrl)}`;
  // 아티스트/그룹 행: 이름 뒤에 소속사·소속 그룹 표시(업체 '대표'와 동일 톤). 배치 조회로 N+1 회피.
  const artistRows = displayed.filter((c) => c.is_artist);
  const agencyByParty = {};
  const groupNameByParty = {};
  if (artistRows.length) {
    const ids = artistRows.map((c) => c.id);
    const ph = ids.map(() => "?").join(",");
    for (const r of db().prepare(`SELECT a.person_id AS pid, o.name AS agency FROM affiliations a JOIN parties o ON o.id = a.org_id WHERE a.ended_on IS NULL AND o.kind = 'company' AND a.person_id IN (${ph}) ORDER BY a.started_on DESC, a.id DESC`).all(...ids)) {
      if (!agencyByParty[r.pid]) agencyByParty[r.pid] = r.agency; // 현재(최근) 소속사
    }
    const gids = [...new Set(artistRows.filter((c) => c.group_id).map((c) => Number(c.group_id)))];
    if (gids.length) {
      const gmap = {};
      for (const g of db().prepare(`SELECT id, COALESCE(NULLIF(activity_name,''), name) AS name FROM parties WHERE id IN (${gids.map(() => "?").join(",")})`).all(...gids)) gmap[g.id] = g.name;
      for (const c of artistRows) if (c.group_id && gmap[c.group_id]) groupNameByParty[c.id] = gmap[c.group_id];
    }
  }
  // 업체 행: 사업자등록증(client_files kind='biz_license') 업로드 여부 배치 조회(있음/없음 배지). 목록은 기록 존재만 확인(파일 실제 접근은 상세에서).
  const bizLicenseSet = new Set();
  const companyIds = displayed.filter((c) => c.kind === "company").map((c) => c.id);
  if (companyIds.length) {
    for (const r of db().prepare(`SELECT DISTINCT client_id FROM client_files WHERE kind = 'biz_license' AND client_id IN (${companyIds.map(() => "?").join(",")})`).all(...companyIds)) bizLicenseSet.add(r.client_id);
  }
  // 청구·프로젝트식 컬럼 표(2026-07-16 사용자 요청 '넓어진 화면에 정보 많이'). 관계자=연락처 표 공용, 나머지=업체/아티스트 표.
  const dash = '<span class="text-muted">—</span>';
  // 사업자등록증 미업로드 표시 아이콘(경고 삼각형) — 유형 배지 대신 사업자번호 뒤 작은 아이콘(2026-07-16 사용자 요청).
  const bizLicenseMissingIcon = ` <span title="사업자등록증 미등록" aria-label="사업자등록증 미등록" class="ml-0.5 inline-flex align-middle text-warning"><svg class="h-3.5 w-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0Z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg></span>`;
  // 탭별 컬럼(2026-07-16 사용자 요청): 유형 열 폐기(전 탭) / 아티스트=솔로·그룹 형태 표시·사업자번호 없음 / 그룹=사업자번호 없음.
  // 폭 배분(청구 표처럼): 식별 열 **이름·이메일=유동**(남는 폭 나눠 채움). 나머지=고정 rem. 좁아지면 전화 먼저 숨김(xl). 모바일 카드(<640)=2열 그리드(mCard 슬롯 tl/tr/bl/br).
  const link = (id, inner, cls = "") => `<a href="/clients/${id}${fromParam}${retParam}" class="dt-link ${cls}">${inner}</a>`;
  let orgCols, orgRows;
  if (group === "artist") {
    orgCols = [
      { label: "이름", primary: true, mCard: "tl" },
      { label: "형태", w: "w-[6.5rem]", hide: "sm", mCard: "tr" },
      { label: "소속", w: "w-[13rem]", hide: "sm", mCard: "bl" },
      { label: "전화", w: "w-[9.5rem]", hide: "xl", mobileHide: true },
      { label: "이메일", hide: "sm", mCard: "br" },
    ];
    orgRows = displayed.map((c) => {
      // 활동 형태: 수동 필드(activity_form) 우선, 없으면 소속 그룹 유무로 자동 판별(레거시 폴백). solo=회색·group/both=파랑.
      const af = c.activity_form || (groupNameByParty[c.id] ? "group" : "solo");
      const form = `<span class="${af === "solo" ? "badge-neutral" : "badge-info"}">${esc(ARTIST_ACTIVITY_FORM_LABELS[af] || "솔로")}</span>`;
      const meta = [agencyByParty[c.id], groupNameByParty[c.id]].filter(Boolean).map((x) => esc(x)).join(" · ");
      return { cells: [
        link(c.id, esc(personLabel(c.activity_name || c.name, c.name)), "font-medium"),
        form,
        meta || dash,
        c.phone ? copyable(c.phone) : dash,
        c.email ? copyable(c.email) : dash,
      ] };
    });
  } else if (group === "group") {
    orgCols = [
      { label: "이름", primary: true, mCard: "tl" },
      { label: "소속", w: "w-[13rem]", hide: "sm", mCard: "tr" },
      { label: "전화", w: "w-[9.5rem]", hide: "sm", mCard: "bl" },
      { label: "이메일", hide: "sm", mCard: "br" },
    ];
    orgRows = displayed.map((c) => ({ cells: [
      link(c.id, esc(personLabel(c.activity_name || c.name, c.name)), "font-medium"),
      agencyByParty[c.id] ? esc(agencyByParty[c.id]) : dash, // 그룹 소속사
      c.phone ? copyable(c.phone) : dash,
      c.email ? copyable(c.email) : dash,
    ] }));
  } else {
    // 업체(company)
    orgCols = [
      { label: "이름", primary: true, mCard: "tl" },
      { label: "대표", w: "w-[11rem]", hide: "sm", mCard: "tr" },
      { label: "사업자번호", w: "w-[9.5rem]", hide: "sm", mCard: "bl" },
      { label: "전화", w: "w-[9.5rem]", hide: "xl", mobileHide: true },
      { label: "이메일", hide: "sm", mCard: "br" },
    ];
    orgRows = displayed.map((c) => {
      const certMissing = !bizLicenseSet.has(c.id); // 사업자등록증 미업로드 → 사업자번호 뒤 경고 아이콘
      const ownerLabel = stripTrailingTitle(c.owner_name); // 대표(말미 호칭 제거)
      const ownerCell = ownerLabel
        ? (c.owner_party_id ? `<a href="/contacts/${c.owner_party_id}${fromParam}${retParam}" class="dt-link text-muted">${esc(ownerLabel)}</a>` : `<span class="text-muted">${esc(ownerLabel)}</span>`)
        : dash;
      return { cells: [
        link(c.id, esc(c.name), "font-medium"),
        ownerCell,
        (c.biz_no ? copyable(c.biz_no) : dash) + (certMissing ? bizLicenseMissingIcon : ""),
        c.phone ? copyable(c.phone) : dash,
        c.email ? copyable(c.email) : dash,
      ] };
    });
  }
  const list = displayed.length
    ? (group === "associate"
        ? contactTable(displayed, { fromParam, returnTo: req.originalUrl, filterList: true, hideTitle: true })
        : dataTable(orgCols, orgRows, { filterList: true })) + capped.more
    : q
      ? emptyState(`"${esc(q)}" 검색 결과가 없습니다.`, { card: true, icon: "clients" })
      : emptyState(group === "artist" ? "아티스트가 없습니다." : group === "group" ? "그룹이 없습니다." : group === "associate" ? "관계자가 없습니다." : group === "company" ? "업체가 없습니다." : "클라이언트가 없습니다.", {
          card: true,
          icon: "clients",
          // 유형 선택 페이지 폐기 — 빈 상태 CTA는 현재 탭 유형으로 바로 생성(탭=유형). 나머지 유형은 상단 드롭다운.
          cta: group === "associate" ? { href: "/contacts/new", label: "+ 새 관계자" }
            : group === "artist" ? { href: "/clients/new?type=artist", label: "+ 새 아티스트" }
            : group === "group" ? { href: "/clients/new?type=group", label: "+ 새 그룹" }
            : { href: "/clients/new?type=company", label: "+ 새 업체" },
        });

  // '새 클라이언트' = 작은 선택 드롭다운(페이지 이동 없이 유형 선택) — CSP 안전한 <details> 팝오버. 관계자=연락처 생성.
  const newMenu = `
    <details class="relative inline-block" data-menu>
      <summary class="btn-primary cursor-pointer select-none list-none [&::-webkit-details-marker]:hidden">+ 새 클라이언트</summary>
      <div class="absolute right-0 z-20 mt-1 w-56 overflow-hidden rounded-lg border border-border bg-bg py-1 text-left shadow-lg">
        <a href="/clients/new?type=company" class="block px-4 py-2 text-sm hover:bg-surface active:bg-surface"><span class="font-medium text-fg">업체</span> <span class="text-xs text-muted">소속사·제작사</span></a>
        <a href="/contacts/new" class="block px-4 py-2 text-sm hover:bg-surface active:bg-surface"><span class="font-medium text-fg">관계자</span> <span class="text-xs text-muted">대표·A&amp;R·디렉터 등</span></a>
        <a href="/clients/new?type=artist" class="block px-4 py-2 text-sm hover:bg-surface active:bg-surface"><span class="font-medium text-fg">아티스트</span> <span class="text-xs text-muted">개인·솔로</span></a>
        <a href="/clients/new?type=group" class="block px-4 py-2 text-sm hover:bg-surface active:bg-surface"><span class="font-medium text-fg">그룹</span> <span class="text-xs text-muted">밴드·아이돌</span></a>
      </div>
    </details>`;
  const body = `
    ${flashBanner(req.query)}
    ${pageHeader({ title: "클라이언트", action: newMenu })}
    ${groupChips}
    ${kindChips}
    ${searchBar}
    ${resultNote}
    ${list}`;
  res.send(layout({ title: "클라이언트", user: req.user, current: "/clients", body, wide: true }));
});

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
  const type = CLIENT_TYPES.includes(req.query.type) ? req.query.type : null;
  if (!type) return res.redirect("/clients"); // 유형 선택 페이지 폐기(드롭다운만) — 유형 없는 진입은 목록으로
  const companies = listClients({}).filter((x) => x.kind === "company");
  res.send(layout({ title: "새 클라이언트", user: req.user, current: "/clients", body: clientForm({}, false, [], "", false, listContacts({}), companies, false, true, listGroupsForPicker(), type) }));
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
  const name = String(b.party_name != null ? b.party_name : b.name || "").trim(); // 폼 필드=party_name(Chrome name= 자동완성 회피 — 함정 #19·#21)
  if (!name) {
    const companies = listClients({}).filter((x) => x.kind === "company");
    return res.send(layout({ title: "새 클라이언트", user: req.user, current: "/clients", body: clientForm({ ...b, _err: "이름을 입력하세요." }, false, [], "", false, listContacts({}), companies, false, true, listGroupsForPicker(), type) }));
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
      activity_form: b.activity_form, // 활동 형태(솔로/그룹/솔로+그룹)
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

// ── 수정 ──
// 이제 상세(GET /:id)가 인라인 편집 화면 — 옛 편집 경로는 상세로 리다이렉트(첨부 오류 ferr 보존, 북마크 호환).
router.get("/:id/edit", (req, res) => {
  const id = Number(req.params.id);
  const ferr = String(req.query.ferr || "").trim();
  res.redirect(`/clients/${id}${ferr ? "?ferr=" + encodeURIComponent(ferr) : ""}`);
});

router.post("/:id", (req, res) => {
  const id = Number(req.params.id);
  const c = getParty(id);
  if (!c) return res.status(404).send(errorPage({ code: 404, title: "클라이언트를 찾을 수 없습니다", message: "삭제되었거나 주소가 잘못되었습니다.", user: req.user }));
  const isFetch = req.get("X-Requested-With") === "fetch"; // 자동저장(AJAX)
  const b = req.body;
  const name = String(b.party_name != null ? b.party_name : b.name || "").trim(); // 폼 필드=party_name(Chrome name= 자동완성 회피 — 함정 #19·#21)
  if (!name) {
    if (isFetch) return res.status(400).json({ ok: false, error: "이름을 입력하세요." });
    const files = listClientFiles(id);
    return res.send(layout({ title: "클라이언트 수정", user: req.user, current: "/clients", body: clientForm({ ...c, ...b, _err: "이름을 입력하세요." }, true, files, "", true, listContacts({}), listClients({}).filter((x) => x.kind === "company"), false, true, listGroupsForPicker()) }));
  }
  // kind는 party 정체성이라 불변 — 폼 유형 고정, 현재 party.kind 기준으로 필드 갱신(updateParty가 분기).
  updateParty(id, {
    name, phone: b.phone, email: b.email, memo: b.memo,
    // company 필드
    biz_no: formatBizNo(b.biz_no), // owner_name/owner_party_id는 미전송(보존) — 아래 setCompanyOwners가 조인 테이블 기준으로 동기화
    address: b.biz_address != null ? b.biz_address : b.address, roles: c.kind === "company" ? companyRolesFrom(b) : null,
    // person 필드(활동명·is_artist는 보존, 현금영수증만 갱신). 단 **그룹은 그룹명=단일 정체성**이라 activity_name을 새 name과 동기화
    // (안 그러면 옛 activity_name이 남아 목록·상세가 '옛이름 (새이름)'으로 표시되던 버그 — 2026-07-16 사용자 리포트).
    activity_name: c.kind === "group" ? name : c.activity_name, is_artist: c.is_artist,
    cash_receipt_no: c.kind === "group" ? c.cash_receipt_no : b.cash_receipt_no, // 그룹은 폼에 필드 없음 → 기존값 보존(개인 아티스트만 현금영수증)
    activity_form: b.activity_form, // 활동 형태(아티스트 폼에만 있음 — 그룹·업체는 undefined로 보존)
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
  res.redirect(`/clients/${id}`);
});
router.post("/:id/members/:mid/remove", (req, res) => {
  const id = Number(req.params.id);
  const mid = Number(req.params.mid);
  const m = getParty(mid);
  if (m && Number(m.group_id) === id) setPartyGroup(mid, null); // 이 그룹 소속일 때만 해제
  res.redirect(`/clients/${id}`);
});

// ── 첨부 서류 업로드(치프·스태프 — requireEditor) ──
// 보안: 디스크 multer + 매직바이트 검증(PNG·JPEG·PDF) + 인증 다운로드만(공개 링크 없음).
router.post("/:id/files/:kind", requireEditor, upload.single("file"), asyncHandler(async (req, res) => {
  const id = Number(req.params.id);
  const kind = req.params.kind;
  const c = getParty(id);
  if (!c) {
    if (req.file) fs.promises.unlink(req.file.path).catch(() => {});
    return res.status(404).send(errorPage({ code: 404, title: "클라이언트를 찾을 수 없습니다", message: "", user: req.user }));
  }
  if (!FILE_KINDS.find((k) => k.key === kind)) {
    if (req.file) fs.promises.unlink(req.file.path).catch(() => {});
    return res.redirect(`/clients/${id}?ferr=${encodeURIComponent("알 수 없는 서류 종류입니다.")}`);
  }
  if (!req.file) {
    return res.redirect(`/clients/${id}?ferr=${encodeURIComponent("파일을 선택하세요.")}`);
  }

  // 매직바이트 검증: Content-Type 헤더를 신뢰하지 않고 파일 첫 바이트로 직접 확인
  const detectedMime = detectMimeFromFile(req.file.path);
  if (!detectedMime) {
    fs.promises.unlink(req.file.path).catch(() => {});
    return res.redirect(`/clients/${id}?ferr=${encodeURIComponent("PNG, JPG, PDF 파일만 업로드할 수 있습니다.")}`);
  }

  const originalName = decodeName(req.file.originalname);
  try {
    const { backend, fileId } = await storage.put({ filePath: req.file.path, name: originalName, mimeType: detectedMime, folder: fileKindLabel(kind) }); // 사업자등록증·통장사본 하위 폴더로
    // 기존 같은 kind 파일을 교체하는 경우 이전 파일 스토리지 정리
    const old = upsertClientFile(id, kind, { storage_backend: backend, file_id: fileId, file_name: originalName, mime_type: detectedMime, file_size: req.file.size });
    if (old) await storage.remove(old.storage_backend, old.file_id);
    res.redirect(`/clients/${id}?flash=saved`);
  } catch (e) {
    console.error("[client file upload]", e);
    const msg = e && e.code === "DRIVE_UPLOAD_FAILED"
      ? "구글 Drive 업로드에 실패했습니다 — 로컬에 저장하지 않았습니다. 잠시 후 다시 시도하거나 환경설정 › 일반 › 자료 저장에서 Drive 연동을 확인하세요."
      : "업로드에 실패했습니다.";
    res.redirect(`/clients/${id}?ferr=${encodeURIComponent(msg)}`);
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
  if (!FILE_KINDS.find((k) => k.key === kind)) return res.redirect(`/clients/${id}`);
  const old = deleteClientFile(id, kind);
  if (old) await storage.remove(old.storage_backend, old.file_id);
  res.redirect(`/clients/${id}?flash=deleted`);
}));

// ── 클라이언트 상세(프로젝트 + 청구·결제 히스토리 + 첨부 서류 링크) ──
router.get("/:id", asyncHandler(async (req, res) => {
  const c = getParty(Number(req.params.id));
  if (!c) return res.status(404).send(errorPage({ code: 404, title: "클라이언트를 찾을 수 없습니다", message: "삭제되었거나 주소가 잘못되었습니다.", user: req.user }));
  // 비아티스트 개인(관계자)은 클라이언트 화면이 아니라 연락처 상세가 정 화면(관계자 탭 링크와 동일 규칙) —
  // 청구처 정보 카드 '클라이언트 ↗' 등이 관계자 청구처를 이 경로로 보낼 때 아티스트 편집 폼이 뜨던 어색함 제거(2026-07-05 전수점검).
  if (c.kind === "person" && !c.is_artist) {
    const from = String(req.query.from || "");
    const retQ = String(req.query.return || "");
    const qs = [
      from && /^[\w=&%.\-]*$/.test(from) ? `from=${from}` : "",
      safePath(retQ) ? `return=${encodeURIComponent(retQ)}` : "", // 청구·프로젝트 복귀 경로 보존(2026-07-08)
    ].filter(Boolean).join("&");
    return res.redirect(`/contacts/${c.id}${qs ? `?${qs}` : ""}`);
  }
  // 탭 3구성(2026-07-08 사용자 요청): 상세 정보(기본) / 프로젝트 / 청구·결제 — 이전엔 프로젝트·청구 2탭 아래 상세 폼이 항상 붙어 길었음.
  const tab = ["info", "projects", "invoices"].includes(req.query.tab) ? req.query.tab : "info";
  const projects = listProjectsForParty(c.id); // c.id(숫자)를 넘겨야 함 — 객체를 넘기면 Number(c)=NaN이라 매칭 0(연결 프로젝트/청구 안 뜨던 버그)
  const invoices = listInvoicesForParty(c.id);
  const files = listClientFiles(c.id);
  // 첨부 파일 실제 접근 가능 여부(깨진 링크는 '있음'으로 안 보이게). 확실한 부재(404/휴지통)만 false, 불확실은 true.
  const fileOk = {};
  for (const f of files) {
    try { fileOk[f.kind] = await storage.exists(f.storage_backend, f.file_id); }
    catch (_e) { fileOk[f.kind] = true; }
  }
  // 목록에서 넘어왔으면 그 필터로 복귀(?from=쿼리스트링, 안전문자만 허용).
  // 청구·프로젝트 청구처 카드에서 넘어왔으면 ?return=(내부 절대경로만)으로 그 화면 복귀(2026-07-08 사용자 요청).
  const from = String(req.query.from || "");
  const fromOk = from && /^[\w=&%.\-]*$/.test(from);
  const retQ = String(req.query.return || "");
  const ret = safePath(retQ);
  const clientsBackHref = ret || (fromOk ? `/clients?${from}` : "/clients");
  const backLabel = ret
    ? ret.startsWith("/invoices") ? "청구" : ret.startsWith("/projects") ? "프로젝트" : ret.startsWith("/contacts") ? "연락처" : ret.startsWith("/clients") ? "클라이언트" : "돌아가기"
    : "클라이언트";
  const keepQ = [fromOk ? `from=${from}` : "", ret ? `return=${encodeURIComponent(ret)}` : ""].filter(Boolean).join("&"); // 탭 전환 시 복귀 경로 유실 방지
  const tabBarHtml = tabBar({
    tabs: [
      { key: "info", label: "상세 정보" },
      { key: "projects", label: `프로젝트 ${projects.length}` },
      { key: "invoices", label: `청구·결제 ${invoices.length}` },
    ],
    activeKey: tab,
    hrefFn: (key) => `/clients/${c.id}?tab=${key}${keepQ ? `&${keepQ}` : ""}`,
  });

  let content;
  if (tab === "invoices") {
    if (invoices.length) {
      const total = invoices.reduce((s, i) => s + (i.amount || 0), 0);
      const paid = invoices.reduce((s, i) => s + (i.paid_amount || 0), 0);
      const due = total - paid;
      content = `<div class="card mb-3 flex flex-wrap gap-4 text-sm">
          <span>청구 합계 <b class="text-fg tabular">${formatKRW(total)}</b></span>
          <span>입금 <b class="text-success tabular">${formatKRW(paid)}</b></span>
          <span>미수 <b class="${due > 0 ? "text-danger" : "text-fg"} tabular">${formatKRW(due)}</b></span>
        </div>
        <div class="space-y-2">${invoices.map((i) => invoiceRow(i)).join("")}</div>`;
    } else {
      content = emptyState("이 클라이언트가 청구처인 청구 내역이 없습니다.", { card: true });
    }
  } else {
    content = projects.length
      ? `<div class="space-y-2">${projects.map((p) => clientProjectCard(p)).join("")}</div>`
      : emptyState("연결된 프로젝트가 없습니다.", { card: true });
  }

  // 그룹(group): 소속 멤버(개인 아티스트) 목록 + 추가/제거.
  const members = c.kind === "group" ? listGroupMembers(c.id) : [];
  const memberCandidates = c.kind === "group" ? artistPersonOptions().filter((a) => Number(a.group_id) !== c.id) : [];
  const memberSection = c.kind === "group"
    ? `<div class="mb-6">
        <h3 class="mb-2 font-display text-lg font-semibold text-fg">멤버 <span class="text-sm font-normal text-muted">· 그룹 소속 아티스트</span></h3>
        ${members.length
          ? listGroup({ rows: members.map((m) => listRow({
              left: `<a href="/clients/${m.id}" class="font-medium text-fg hover:text-primary hover:underline">${esc(personLabel(m.display_name, m.name))}</a>`,
              right: `<form method="post" action="/clients/${c.id}/members/${m.id}/remove" data-confirm="${esc(m.display_name)} 님을 이 그룹에서 제거할까요? (아티스트 자체는 삭제되지 않고 그룹 연결만 해제)"><button class="btn-ghost btn-sm text-danger" type="submit">제거</button></form>`,
            })) })
          : emptyState("아직 등록된 멤버가 없습니다.", { card: true })}
        <form method="post" action="/clients/${c.id}/members" class="card mt-2 flex items-end gap-2">
          <div class="min-w-0 flex-1">
            <label class="label">멤버 추가 <span class="font-normal text-muted text-xs">(개인 아티스트 검색 또는 새로 등록)</span></label>
            ${personCombo({ idField: "member_id", nameField: "member_name", options: memberCandidates, companyOptions: listClients({}).filter((x) => x.kind === "company"), entityLabel: "멤버", placeholder: "멤버 검색 또는 새로 등록" })}
          </div>
          <button class="btn-primary shrink-0" type="submit">추가</button>
        </form>
      </div>`
    : "";

  // 업체(company): 소속 아티스트 목록(affiliations 기반). 아티스트: 소속 업체 링크는 소속 이력에서.
  const roster = c.kind === "company" ? listArtistsForAgency(c.id) : [];
  const rosterSection = c.kind === "company" && roster.length
    ? `<div class="mb-4">
        <h3 class="mb-2 text-sm font-medium text-muted">소속 아티스트</h3>
        ${listGroup({ rows: roster.map((a) => listRow({ href: `/clients/${a.id}`, left: `<span class="font-medium">${esc(personLabel(a.name, a.real_name))}</span>` })) })}
      </div>`
    : "";
  const agencyLink = "";

  // 상세로 들어오면 바로 편집 — '정보 수정' 버튼 폐기, 인라인 편집 폼(dirty 저장). 첨부·삭제는 분리 배치.
  const companies = listClients({}).filter((x) => x.kind === "company");
  if (c.kind !== "company") { c.agency_id = currentAgencyId(c.id); c.agency_name = currentAgencyName(c.id); } // 아티스트·그룹: 소속사 콤보 기본값(이름)
  const fileErr = String(req.query.ferr || "").trim(); // 첨부 업로드 오류(파일 라우트가 ?ferr= 로 복귀)
  // 폼의 대표자/담당자 콤보는 전체 연락처(contactOptions)를 내부에서 조회(상세의 contacts는 이 클라이언트 소속만이라 별도).
  const editCard = clientForm(c, true, files, fileErr, true, listContacts({}), companies, true, false, listGroupsForPicker()); // withExtras=false — 첨부·삭제 제외
  const crossRefs = [
    // 아티스트(사람) party는 연락처와 동일 레코드 — '연락처로 보기' 링크(같은 party를 연락처 화면에서).
    c.kind === "person" ? `<div><span class="text-muted">연락처로 보기</span> <a href="/contacts/${c.id}" class="text-primary hover:underline">${esc(c.name)} ↗</a></div>` : "",
    (() => { const g = c.kind === "person" && c.is_artist ? groupOfParty(c.id) : null; return g ? `<div><span class="text-muted">소속 그룹</span> <a href="/clients/${g.id}" class="text-primary hover:underline">${esc(g.activity_name || g.name)} ↗</a></div>` : ""; })(),
    // 대표자 연락처 — 공동대표 전원 링크(첫 대표만 나오던 것, 2026-07-10)
    (() => {
      const owners = c.kind === "company" ? listCompanyOwners(c.id) : [];
      if (!owners.length) return "";
      const links = owners.map((o) => `<a href="/contacts/${o.id}" class="text-primary hover:underline">${esc(personName(o))} ↗</a>`).join(" · ");
      return `<div><span class="text-muted">대표자 연락처</span> ${links}</div>`;
    })(),
  ].filter(Boolean).join("");
  const crossRefBlock = crossRefs ? `<div class="mt-3 space-y-1 text-sm">${crossRefs}</div>` : "";
  const filesBlock = clientFilesBlock(c, files, fileErr, fileOk); // 자체 '첨부 서류' 헤딩 포함 · 깨진 링크는 경고
  // 삭제는 편집 폼(clientForm)의 저장 줄 왼쪽 버튼으로 이동(UI 통일: 저장 우측·삭제 좌측·같은 줄).

  // 탭 3구성(2026-07-08): 상세 정보(편집 폼·첨부·멤버·소속 아티스트, 기본 탭) / 프로젝트 / 청구·결제 — 한 화면에 다 쌓지 않고 탭으로 분리.
  const infoContent = `
    ${editCard}
    <div class="mt-3">${filesBlock}</div>
    ${crossRefBlock}
    ${memberSection ? `<div class="mt-6">${memberSection}</div>` : ""}
    ${agencyLink ? `<div class="mt-3">${agencyLink}</div>` : ""}
    ${rosterSection}`;
  const body = `
    ${flashBanner(req.query)}
    ${pageHeader({ title: c.is_artist ? personLabel(c.activity_name || c.name, c.name) : c.name, desc: c.is_artist ? (c.kind === "group" ? "그룹 아티스트" : "아티스트") : "업체", back: { href: clientsBackHref, label: backLabel } })}
    ${tabBarHtml}
    ${tab === "info" ? infoContent : content}`;
  res.send(layout({ title: c.name, user: req.user, current: "/clients", body }));
}));

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
