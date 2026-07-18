"use strict";

/** 클라이언트(당사자) 렌더 — 목록 행·상세 편집 폼·첨부 서류 섹션. clients.routes.js에서 분리(2026-07-09, views.sessions.js·views.invoices.js 컨벤션 동일). */

const { COMPANY_ROLES } = require("./config");
const { esc, pageHeader, explain, dirtyActionRow, personCombo, companyCombo, personName, personLabel, copyable, formatKRW } = require("./views");
const { contactOptions, listOrgContacts, listCompanyOwners, listClients } = require("./data");

/** 첨부 서류 종류 목록(화이트리스트). 라우트(업로드·뷰어 검증)도 이 배열을 import해 공유(중복 정의 금지). */
const FILE_KINDS = [
  { key: "biz_license", label: "사업자등록증" },
  // 통장사본 폐기(2026-07-01): 스튜디오가 업체에 입금할 일이 없어 불필요. 과거 업로드분은 raw 열람만 가능(업로드 UI 없음).
];

function fileKindLabel(key) {
  const f = FILE_KINDS.find((k) => k.key === key);
  return f ? f.label : key;
}

/** 업체 역할 표시 라벨 — 내부값 '제작사'→'제작/운영', '소속사/레이블'→'소속/레이블'로 표기(저장값은 원본 유지, 프로젝트·마이그레이션 호환, 2026-07-05). */
function companyRoleLabel(role) { return role === "제작사" ? "제작/운영" : role === "소속사/레이블" ? "소속/레이블" : role; }
/** 업체 역할 배열(roles CSV 우선, 없으면 kind 폴백). 배지 표시용. */
function clientRoleList(c) {
  const r = String(c.roles || "").split(",").map((x) => x.trim()).filter(Boolean);
  return r; // roles CSV(겸업). 없으면 빈 배열 → 배지에서 '업체'로 폴백
}

/** 업체·그룹 상세용 프로젝트 행(목록형) — 한 줄: **작성일(약화) · 아티스트(강조) · 프로젝트명(약화)**.
 *  업체 상세 안이라 회사명은 생략(중복). 아티스트 없으면 프로젝트명을 강조로 폴백. 개별 카드 대신 목록(clientProjectList). */
function clientProjectRow(p) {
  const created = p.created_at ? String(p.created_at).slice(0, 10) : "";
  const artist = p.artist || "";
  const nameHtml = artist
    ? `<span class="shrink-0 font-semibold">${esc(artist)}</span><span class="truncate text-xs text-muted">${esc(p.title || "")}</span>`
    : `<span class="truncate font-semibold">${esc(p.title || "")}</span>`; // 아티스트 없으면 프로젝트명 강조
  // 업체 상세는 왼쪽 목록이 작업 맥락 — 프로젝트로 나갈 땐 새 탭(업체 창 유지, 연락처 읽기 뷰와 동일 규칙).
  return `<a href="/projects/${p.id}" target="_blank" rel="noopener" class="flex items-center justify-between gap-3 px-3 py-2.5 hover:bg-primary/5">
    <div class="flex min-w-0 items-center gap-2">${created ? `<span class="shrink-0 tabular text-xs text-muted">${created}</span>` : ""}${nameHtml}</div>
    <span class="shrink-0 text-xs text-muted">열기 ↗</span>
  </a>`;
}

/** 프로젝트 목록형 판 — 흰 바탕·바깥 테두리 + 행 사이 구분선 하나(개별 카드 보더 폐지). */
function clientProjectList(projects) {
  return `<div class="overflow-hidden rounded-lg border border-border/60 bg-surface divide-y divide-border/60">${projects.map((p) => clientProjectRow(p)).join("")}</div>`;
}

/** 업체 상세용 청구 행(목록형·링크) — 작성일·제목·상태배지·금액. 누르면 청구서(/invoices/:id)를 새 탭으로.
 *  인라인 펼침(invoiceRow) 대신 전용 링크 행: 업체 상세에선 청구서 전체 화면으로 넘어간다(2026-07-18). */
function clientInvoiceRow(inv) {
  const { invoiceBadge } = require("./views.invoices"); // 지연 require(순환 회피)
  const created = inv.project_created_at ? String(inv.project_created_at).slice(0, 10) : "";
  return `<a href="/invoices/${inv.id}" target="_blank" rel="noopener" class="flex items-center justify-between gap-3 px-3 py-2.5 hover:bg-primary/5">
    <div class="flex min-w-0 items-center gap-2">${created ? `<span class="shrink-0 tabular text-xs text-muted">${created}</span>` : ""}<span class="truncate font-medium">${esc(inv.title)}</span></div>
    <div class="flex shrink-0 items-center gap-2">
      <div class="flex flex-wrap justify-end gap-1">${invoiceBadge(inv)}</div>
      <div class="tabular text-sm font-semibold">${formatKRW(inv.amount)}</div>
      <span class="text-xs text-muted">↗</span>
    </div>
  </a>`;
}

/** 청구 목록형 판 — 프로젝트 목록과 동일 톤. */
function clientInvoiceList(invoices) {
  return `<div class="overflow-hidden rounded-lg border border-border/60 bg-surface divide-y divide-border/60">${invoices.map((i) => clientInvoiceRow(i)).join("")}</div>`;
}

/** 첨부 서류 업로드·교체 UI 섹션(isEdit=true일 때만 렌더). */
function clientFileSection(c, fileMap, fileErr, fileOk = {}) {
  const rows = FILE_KINDS.map(({ key, label }) => {
    const existing = fileMap[key];
    const ok = existing && fileOk[key] !== false; // fileOk 미확인(undefined)이면 표시(기존 동작), 명시적 false(깨진 링크)만 숨김
    const backendTag = existing
      ? (existing.storage_backend === "drive"
          ? `<span class="text-xs text-muted">Drive</span>`
          : `<span class="text-xs text-warning" title="Drive 업로드 실패로 로컬(서버 디스크)에 저장됨 — 환경설정 › 일반 › 자료 저장에서 Drive로 이관하세요">로컬 저장</span>`)
      : "";
    const existingRow = existing && ok
      ? `<div class="mb-2 flex flex-wrap items-center gap-3 text-sm">
            <a href="/clients/${c.id}/files/${key}/view" target="_blank" rel="noopener" data-popup-view class="font-medium text-primary hover:underline">${esc(label)} 보기</a>
            <span class="max-w-[12rem] truncate text-xs text-muted">${esc(existing.file_name)}</span>
            ${backendTag}
            <form method="post" action="/clients/${c.id}/files/${key}/delete" class="inline" data-confirm="${esc(label)}을 삭제할까요?">
              <button class="text-xs text-danger hover:underline" type="submit">삭제</button>
            </form>
          </div>`
      : existing && !ok
        ? `<div class="mb-2 flex flex-wrap items-center gap-3 text-sm">
            <span class="text-danger">⚠️ 파일을 찾을 수 없습니다 (Drive에서 삭제/이동됨)</span>
            <span class="max-w-[12rem] truncate text-xs text-muted">${esc(existing.file_name)}</span>
            <form method="post" action="/clients/${c.id}/files/${key}/delete" class="inline" data-confirm="깨진 첨부 기록을 지울까요? (Drive 파일은 이미 없음)">
              <button class="text-xs text-danger hover:underline" type="submit">기록 삭제</button>
            </form>
          </div>`
        : "";
    return `
    <div>
      <label class="label">${esc(label)}</label>
      ${existingRow}
      <form enctype="multipart/form-data" method="post" action="/clients/${c.id}/files/${key}" class="flex items-center gap-2">
        <div class="flex-1" data-dropzone>
          <input type="file" name="file" accept="image/png,image/jpeg,application/pdf" class="sr-only" />
          <div class="input flex cursor-pointer select-none items-center py-2 text-sm text-muted" data-dropzone-display tabindex="0" role="button" aria-label="파일 찾기 또는 붙여넣기(Ctrl+V)">
            <span data-dropzone-label>${existing && ok ? "다른 파일로 교체 — 클릭 후 붙여넣기(Ctrl+V) 또는 [파일 찾기]" : "클릭 후 붙여넣기(Ctrl+V) · 파일 선택은 [파일 찾기]"}</span>
          </div>
        </div>
        <button class="btn-ghost shrink-0" type="button" data-dropzone-pick>파일 찾기</button>
        <noscript><button class="btn-ghost shrink-0" type="submit">업로드</button></noscript>
      </form>
    </div>`;
  }).join("");

  return `
  <section class="card mt-3 space-y-4">
    <div>
      <h2 class="font-semibold">첨부 서류</h2>
      ${explain(`PNG · JPG · PDF · 최대 10MB. 직원 인증 열람(공개 링크 없음).`)}
    </div>
    ${fileErr ? `<p class="rounded-lg bg-danger/10 px-3 py-2 text-sm text-danger">${esc(fileErr)}</p>` : ""}
    ${rows}
  </section>`;
}

/** 클라이언트 담당자 연락처 콤보 — 공용 personCombo(multi, 콤마로 여러 명. 세션 디렉터와 동일 UX).
 *  담당자(affiliations.is_contact)는 재직과 별개 역할 — 프리필=담당자로 지정된 사람만, 저장 시 콤보에 남은 사람만 담당자(linkClientContact). */
function clientContactCombo(c, isEdit) {
  // 담당자로 지정된 사람만(재직 직원 전원이 아님 — is_contact). 대표자도 담당자로 지정했을 때만 뜨고, 빼면 담당자만 해제된다.
  const cur = isEdit && c.id ? listOrgContacts(c.id) : [];
  return `
    <div>
      <label class="label">담당자 연락처 <span class="font-normal text-muted text-xs">(이 업체 담당자 — 여러 명 가능)</span></label>
      ${personCombo({ idField: "contact_id", nameField: "contact_name", selected: cur, options: contactOptions(), companyOptions: listClients({}).filter((x) => x.kind === "company"), multi: true, placeholder: cur.length ? "" : "담당자 — 검색 또는 새로 등록" })}
      ${explain(`이름을 검색해 고르면 배지로 담깁니다(여러 명 가능). 배지의 ✕ 또는 빈 칸에서 백스페이스로 한 명씩 뺍니다. 목록에 없는 이름은 저장 시 새 연락처로 등록됩니다. 뺀 사람은 담당자 지정만 풀립니다 — 이 회사 재직(소속)과 연락처는 그대로 남습니다. 담당자가 아닌 직원은 연락처의 회사·소속 이력에서 관리합니다.`)}
    </div>`;
}

function clientForm(c = {}, isEdit = false, files = [], fileErr = "", canFiles = false, contacts = [], companies = [], embedded = false, withExtras = true, formType = null) {
  const e = c._err || "";
  const action = isEdit ? `/clients/${c.id}` : "/clients";
  // 유형: 편집=party.kind 매핑, 생성=formType 인자(company/group). 업체·그룹 2개념 — 아티스트는 연락처 폼으로 흡수됨.
  const type = formType || (c.kind === "company" ? "company" : "group");
  const typeLabel = type === "company" ? "업체" : "그룹";
  const nameLabel = type === "company" ? "상호(업체명)" : "그룹명";
  const desc = type === "company" ? "업체 · 소속/레이블 · 제작/운영" : "그룹 · 밴드·아이돌 그룹";
  const fileMap = {};
  files.forEach((f) => { fileMap[f.kind] = f; });

  // embedded=상세 페이지에 인라인으로 넣을 때 — 폼 자체 pageHeader 생략(상단 이름 헤더가 이미 있음).
  return `
    ${embedded ? "" : pageHeader({ title: isEdit ? `${typeLabel} 수정` : `새 ${typeLabel}`, desc, back: isEdit && c.id ? { href: `/clients/${c.id}`, label: `${typeLabel} 상세` } : { href: "/clients", label: "업체·그룹" } })}
    <form method="post" action="${action}" class="card space-y-4"${isEdit ? " data-dirty-form" : ""}>
      ${e ? `<p class="rounded-lg bg-danger/10 px-3 py-2 text-sm text-danger">${esc(e)}</p>` : ""}
      <input type="hidden" name="type" value="${type}" />
      <div class="flex items-center gap-2"><span class="badge ${type === "company" ? "badge-neutral" : "badge-info"}">${typeLabel}</span>${isEdit ? `<span class="text-xs text-muted">유형은 변경할 수 없습니다</span>` : ""}</div>
      <div><label class="label">${nameLabel}</label><input class="input" name="party_name" value="${esc(c.name || "")}" autocomplete="off" required /></div>
      ${type === "company" ? `
      <div class="space-y-4">
        <div>
          <label class="label">역할 <span class="font-normal text-muted text-xs">(겸업 가능 — 복수 선택)</span></label>
          <div class="flex flex-wrap gap-4">
            ${COMPANY_ROLES.map((r) => `<label class="flex items-center gap-1.5 text-sm"><input type="checkbox" name="roles" value="${esc(r)}" ${clientRoleList(c).includes(r) ? "checked" : ""} /> ${esc(companyRoleLabel(r))}</label>`).join("")}
          </div>
        </div>
        <div class="grid gap-3 sm:grid-cols-2">
          <div><label class="label">사업자등록번호</label><input class="input" name="biz_no" value="${esc(c.biz_no || "")}" placeholder="000-00-00000" /></div>
          <div><label class="label">대표자 <span class="font-normal text-muted text-xs">(연락처 연동 · 공동대표 가능)</span></label>
            ${(() => { const owners = isEdit && c.id ? listCompanyOwners(c.id) : []; return personCombo({ idField: "owner_id", nameField: "owner_name", selected: owners, options: contactOptions(), entityLabel: "대표자", placeholder: owners.length ? "" : "대표자 — 검색 또는 새로 등록", simpleModal: true, multi: true }); })()}
          </div>
        </div>
        <div><label class="label">사업장 주소</label><input class="input" name="biz_address" value="${esc(c.address || "")}" autocomplete="off" /></div>
      </div>` : ""}
      ${type === "group" ? `
      <div>
        <label class="label">소속사 <span class="font-normal text-muted text-xs">(검색 · 없으면 비움 · 목록 외 이름은 새 업체 등록)</span></label>
        ${companyCombo("agency_company", c.agency_name || "", "소속사/레이블", "소속사")}
      </div>` : ""}
      ${type === "group" ? `
      <div>
        <label class="label">담당자 <span class="font-normal text-muted text-xs">(관계자 또는 멤버 중 한 명 · 선택)</span></label>
        ${personCombo({ idField: "contact_party_id", nameField: "contact_name", selectedId: c.contact_party_id || null, options: contactOptions(), companyOptions: companies })}
      </div>` : ""}
      ${type === "group" && isEdit ? `<p class="text-xs text-muted">멤버는 아래 <span class="text-fg">멤버</span> 섹션에서 연결·관리합니다.</p>` : ""}
      <div class="grid gap-3 sm:grid-cols-2">
        <div><label class="label">${type === "company" ? "세금계산서 발행 이메일" : "이메일"}</label><input class="input" type="email" name="email" value="${esc(c.email || "")}" placeholder="${type === "company" ? "계산서 받을 이메일" : ""}" /></div>
        <div><label class="label">전화</label><input class="input" name="phone" autocomplete="off" value="${esc(c.phone || "")}" /></div>
      </div>
      ${type === "company" ? clientContactCombo(c, isEdit) : ""}
      <div><label class="label">메모</label><textarea class="input" name="memo" rows="2">${esc(c.memo || "")}</textarea></div>
      ${isEdit
        ? dirtyActionRow({ deleteFormId: `del-client-${c.id}`, deleteLabel: `${typeLabel} 삭제` })
        : dirtyActionRow({ cancelHref: "/clients", saveLabel: "추가", dirty: false })}
    </form>
    ${withExtras && isEdit && canFiles && type === "company" ? `<div>${clientFileSection(c, fileMap, fileErr)}</div>` : ""}
    ${isEdit ? `<form id="del-client-${c.id}" method="post" action="/clients/${c.id}/delete" data-confirm="${esc(c.name || `이 ${typeLabel}`)}${c.name ? "를" : type === "company" ? "를" : "을"} 삭제할까요? 연결된 프로젝트·청구서에서는 자동으로 '미지정' 처리됩니다." class="hidden"></form>` : ""}`;
}

/** 첨부 서류 카드(상세에서 분리 배치용). 업체(company)만 표시(아티스트·그룹은 첨부 없음). fileOk=실제 접근 가능 여부(깨진 링크 경고). */
function clientFilesBlock(c, files, fileErr, fileOk = {}) {
  if (c.kind !== "company") return "";
  const fileMap = {};
  files.forEach((f) => { fileMap[f.kind] = f; });
  return `<div>${clientFileSection(c, fileMap, fileErr, fileOk)}</div>`;
}

// 읽기 뷰에서 업체·그룹 '밖으로' 나가는 링크(연락처·프로젝트)는 새 탭 — 왼쪽 목록이 작업 맥락이라 같은 탭에서 나가면 돌아오기 번거롭다.
// 업체·그룹 '안'에 머무는 링크(소속사=다른 업체)는 같은 탭(마스터-디테일 유지).
const OUT_CLIENT = ' target="_blank" rel="noopener"';

/** 읽기 뷰 한 줄(라벨 + 값 HTML). 값은 이미 esc/copyable 처리된 신뢰 HTML. */
function clientReadRow(label, valueHtml) {
  return `<div class="border-t border-border/60 px-4 py-3 first:border-t-0">
      <div class="text-xs text-muted">${esc(label)}</div>
      <div class="mt-0.5 text-sm">${valueHtml}</div>
    </div>`;
}

/** 사업자등록증 미등록 경고 아이콘(사업자번호 옆). */
const CERT_MISSING_ICON = ` <span title="사업자등록증 미등록" aria-label="사업자등록증 미등록" class="ml-0.5 inline-flex align-middle text-warning"><svg class="h-3.5 w-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0Z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg></span>`;

/**
 * 업체·그룹 읽기 뷰 — 탭 없이 한 화면 스크롤(연락처 contactReadView와 대칭). 빈 섹션은 헤딩까지 통째로 숨김.
 * 편집은 별도 경로(editHref) — 상세=바로 편집을 읽기 후 편집으로 뒤집음(2026-07-18, 연락처와 통일).
 */
function clientReadView(c, { owners = [], contacts = [], artists = [], members = [], agencyName = "", agencyId = null, groupContact = null, bizLicenseOk = false, projects = [], invoices = [], editHref } = {}) {
  const dash = '<span class="text-muted">—</span>';
  const isCompany = c.kind === "company";

  // 헤더: 이름 + 배지 + [편집]
  const badges = isCompany
    ? (clientRoleList(c).length ? clientRoleList(c).map((r) => `<span class="badge badge-neutral">${esc(companyRoleLabel(r))}</span>`).join(" ") : `<span class="badge badge-neutral">업체</span>`)
    : `<span class="badge badge-info">그룹</span>`;
  const title = isCompany ? c.name : (c.activity_name || c.name);
  const header = `<div class="mb-4 flex items-start justify-between gap-3">
      <div class="min-w-0">
        <h1 class="truncate font-display text-2xl font-semibold text-fg">${esc(title)}</h1>
        <div class="mt-1 flex flex-wrap gap-1">${badges}</div>
      </div>
      <a href="${esc(editHref)}" class="btn-ghost btn-sm shrink-0">편집</a>
    </div>`;

  const personLink = (p) => `<a href="/contacts/${p.id}"${OUT_CLIENT} class="text-primary hover:underline">${esc(personName(p))} ↗</a>`;

  let infoCard, extraSections = "";
  if (isCompany) {
    const ownerLinks = owners.length ? owners.map(personLink).join(" · ") : dash;
    infoCard = `<div class="card p-0">
        ${clientReadRow("사업자등록번호", (c.biz_no ? copyable(c.biz_no) : dash) + (bizLicenseOk ? "" : CERT_MISSING_ICON))}
        ${clientReadRow("대표", ownerLinks)}
        ${clientReadRow("사업장 주소", c.address ? copyable(c.address) : dash)}
        ${clientReadRow("계산서 발행 이메일", c.email ? copyable(c.email) : dash)}
        ${clientReadRow("전화", c.phone ? copyable(c.phone) : dash)}
      </div>`;
    const contactsSec = contacts.length
      ? `<h2 class="mb-2 mt-6 font-display text-lg font-semibold text-fg">담당자 ${contacts.length}</h2><div class="card p-0">${contacts.map((p) => clientReadRow("", personLink(p))).join("")}</div>`
      : "";
    const artistsSec = artists.length
      ? `<h2 class="mb-2 mt-6 font-display text-lg font-semibold text-fg">소속 아티스트 ${artists.length}</h2><div class="card p-0">${artists.map((a) => clientReadRow("", `<a href="/contacts/${a.id}"${OUT_CLIENT} class="text-primary hover:underline">${esc(personLabel(a.name, a.real_name))} ↗</a>`)).join("")}</div>`
      : "";
    const filesSec = `<h2 class="mb-2 mt-6 font-display text-lg font-semibold text-fg">첨부 서류</h2><div class="card text-sm">${bizLicenseOk ? `<a href="/clients/${c.id}/files/biz_license/view" target="_blank" rel="noopener" data-popup-view class="text-primary hover:underline">사업자등록증 보기</a>` : `<span class="text-muted">사업자등록증 미등록</span>`}</div>`;
    extraSections = `${contactsSec}${artistsSec}${filesSec}`;
  } else {
    infoCard = `<div class="card p-0">
        ${clientReadRow("소속사", agencyId ? `<a href="/clients/${agencyId}" class="text-primary hover:underline">${esc(agencyName)}</a>` : (agencyName ? esc(agencyName) : dash))}
        ${clientReadRow("담당자", groupContact ? personLink(groupContact) : dash)}
      </div>`;
    const membersSec = members.length
      ? `<h2 class="mb-2 mt-6 font-display text-lg font-semibold text-fg">멤버 ${members.length}</h2><div class="card p-0">${members.map((m) => clientReadRow("", `<a href="/contacts/${m.id}"${OUT_CLIENT} class="text-primary hover:underline">${esc(personLabel(m.display_name || m.name, m.name))} ↗</a>`)).join("")}</div>`
      : "";
    extraSections = membersSec;
  }

  // 프로젝트·청구 — 있을 때만. 프로젝트=목록형(clientProjectList), 청구=목록형 링크(clientInvoiceList·새 탭) + 합계.
  const projectsSec = projects.length
    ? `<h2 class="mb-2 mt-6 font-display text-lg font-semibold text-fg">프로젝트 ${projects.length}</h2>${clientProjectList(projects)}`
    : "";
  let invoicesSec = "";
  if (invoices.length) {
    const total = invoices.reduce((s, i) => s + (i.amount || 0), 0);
    const paid = invoices.reduce((s, i) => s + (i.paid_amount || 0), 0);
    const due = total - paid;
    invoicesSec = `<h2 class="mb-2 mt-6 font-display text-lg font-semibold text-fg">청구·결제 ${invoices.length}</h2>
      <div class="card mb-3 flex flex-wrap gap-4 text-sm">
        <span>청구 합계 <b class="text-fg tabular">${formatKRW(total)}</b></span>
        <span>입금 <b class="text-success tabular">${formatKRW(paid)}</b></span>
        <span>미수 <b class="${due > 0 ? "text-danger" : "text-fg"} tabular">${formatKRW(due)}</b></span>
      </div>
      ${clientInvoiceList(invoices)}`;
  }

  return `${header}
    ${infoCard}
    ${extraSections}
    ${projectsSec}
    ${invoicesSec}`;
}

/**
 * 편집 패널 — clientForm(dirty 저장) + (업체)첨부 + (그룹)멤버 섹션 + 크로스링크 + 취소.
 * 현행 상세 라우트의 infoContent 조립을 그대로 옮긴 것(2026-07-18 마스터-디테일 전환 — 편집을 /edit 경로로 분리).
 */
function clientEditPane(c, { files = [], fileErr = "", fileOk = {}, contacts = [], companies = [], members = [], memberCandidates = [], crossRefsHtml = "", cancelHref, returnTo = null } = {}) {
  const { listGroup, listRow, personCombo, emptyState } = require("./views");
  const isCompany = c.kind === "company";
  const cancel = `<a href="${esc(cancelHref)}" class="mb-3 inline-block text-sm text-primary hover:underline" data-no-guard>← 취소</a>`;
  const editCard = clientForm(c, true, files, fileErr, true, contacts, companies, true, false);
  const filesBlock = clientFilesBlock(c, files, fileErr, fileOk);
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
            ${personCombo({ idField: "member_id", nameField: "member_name", options: memberCandidates, companyOptions: companies, entityLabel: "멤버", placeholder: "멤버 검색 또는 새로 등록" })}
          </div>
          <button class="btn-primary shrink-0" type="submit">추가</button>
        </form>
      </div>`
    : "";
  return `${cancel}
    ${editCard}
    ${isCompany ? `<div class="mt-3">${filesBlock}</div>` : ""}
    ${crossRefsHtml ? `<div class="mt-3 space-y-1 text-sm">${crossRefsHtml}</div>` : ""}
    ${memberSection ? `<div class="mt-6">${memberSection}</div>` : ""}`;
}

module.exports = { FILE_KINDS, fileKindLabel, companyRoleLabel, clientRoleList, clientProjectRow, clientProjectList, clientInvoiceRow, clientInvoiceList, clientFileSection, clientFilesBlock, clientForm, clientReadView, clientEditPane };
