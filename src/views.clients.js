"use strict";

/** 클라이언트(당사자) 렌더 — 목록 행·상세 편집 폼·첨부 서류 섹션. clients.routes.js에서 분리(2026-07-09, views.sessions.js·views.invoices.js 컨벤션 동일). */

const { COMPANY_ROLES } = require("./config");
const { esc, pageHeader, explain, dirtyActionRow, personCombo, personName, companyCombo, groupCombo, projectTypeBadge } = require("./views");
const { contactOptions, listOrgContacts, listClients } = require("./data");

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

/** 클라이언트 상세용 프로젝트 카드(제목·유형·메타 → 프로젝트 상세 링크). */
function clientProjectCard(p) {
  const meta = [p.artist, p.artist_company, p.production_company].filter(Boolean).join(" · ");
  return `<a href="/projects/${p.id}" class="card flex items-center justify-between gap-3 hover:opacity-80">
    <div class="min-w-0">
      <div class="flex items-center gap-2"><span class="truncate font-semibold">${esc(p.title)}</span>${projectTypeBadge(p.project_type)}</div>
      ${meta ? `<div class="mt-0.5 truncate text-xs text-muted">${esc(meta)}</div>` : ""}
    </div>
    <span class="shrink-0 text-xs text-muted">열기 ›</span>
  </a>`;
}

/** 첨부 서류 업로드·교체 UI 섹션(isEdit=true일 때만 렌더). */
function clientFileSection(c, fileMap, fileErr, fileOk = {}) {
  const rows = FILE_KINDS.map(({ key, label }) => {
    const existing = fileMap[key];
    const ok = existing && fileOk[key] !== false; // fileOk 미확인(undefined)이면 표시(기존 동작), 명시적 false(깨진 링크)만 숨김
    const backendTag = existing
      ? (existing.storage_backend === "drive"
          ? `<span class="text-xs text-muted">Drive</span>`
          : `<span class="text-xs text-warning" title="Drive 업로드 실패로 로컬(서버 디스크)에 저장됨 — 관리 › 환경설정 › 자료 저장에서 Drive로 이관하세요">로컬 저장</span>`)
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
      <label class="label">담당자 연락처 <span class="font-normal text-muted text-xs">(이 클라이언트 담당자 — 콤마로 여러 명)</span></label>
      ${personCombo({ idField: "contact_id", nameField: "contact_name", initialName: cur.map((p) => personName(p)).join(", "), options: contactOptions(), companyOptions: listClients({}).filter((x) => x.kind === "company"), multi: true, placeholder: "담당자 — 검색 또는 새로 등록, 콤마로 여러 명" })}
      ${explain(`콤마(,)로 여러 명을 이어서 입력합니다. 목록에 없는 이름은 저장 시 새 연락처로 등록되고 이 클라이언트 담당자로 연결됩니다. 칸에서 지운 사람은 담당자 지정만 풀립니다 — 이 회사 재직(소속)과 연락처는 그대로 남습니다. 담당자가 아닌 직원은 연락처의 회사·소속 이력에서 관리합니다.`)}
    </div>`;
}

function clientForm(c = {}, isEdit = false, files = [], fileErr = "", canFiles = false, contacts = [], companies = [], embedded = false, withExtras = true, groups = [], formType = null) {
  const e = c._err || "";
  const action = isEdit ? `/clients/${c.id}` : "/clients";
  // 유형: 편집=party.kind 매핑, 생성=formType 인자(company/artist/group). 서로 섞이지 않는 3개념 — '기타' 없음.
  const type = formType || (c.kind === "company" ? "company" : c.kind === "group" ? "group" : "artist");
  const typeLabel = type === "company" ? "업체" : type === "group" ? "그룹" : "아티스트";
  const nameLabel = type === "company" ? "상호(업체명)" : type === "group" ? "그룹명" : "이름 · 활동명";
  const desc = type === "company" ? "업체 · 소속/레이블 · 제작/운영" : type === "group" ? "그룹 · 밴드·아이돌 그룹" : "아티스트 · 개인(솔로)";
  const fileMap = {};
  files.forEach((f) => { fileMap[f.kind] = f; });

  // embedded=상세 페이지에 인라인으로 넣을 때 — 폼 자체 pageHeader 생략(상단 이름 헤더가 이미 있음).
  return `
    ${embedded ? "" : pageHeader({ title: isEdit ? "클라이언트 수정" : `새 ${typeLabel}`, desc, back: isEdit && c.id ? { href: `/clients/${c.id}`, label: "클라이언트 상세" } : { href: "/clients", label: "클라이언트" } })}
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
          <div><label class="label">대표자 <span class="font-normal text-muted text-xs">(연락처 연동)</span></label>
            ${personCombo({ idField: "owner_id", nameField: "owner_name", selectedId: c.owner_party_id || null, initialName: c.owner_name || "", options: contactOptions(), entityLabel: "대표자", placeholder: "대표자 — 검색 또는 새로 등록", simpleModal: true })}
          </div>
        </div>
        <div><label class="label">사업장 주소</label><input class="input" name="biz_address" value="${esc(c.address || "")}" autocomplete="off" /></div>
      </div>` : ""}
      ${type === "artist" ? `
      <div>
        <label class="label">현금영수증 정보 <span class="font-normal text-muted text-xs">(사업자등록증 없는 경우)</span></label>
        <input class="input" name="cash_receipt_no" value="${esc(c.cash_receipt_no || "")}" placeholder="휴대폰 번호(010-0000-0000) 또는 현금영수증 카드번호" />
      </div>` : ""}
      ${type !== "company" ? `
      <div>
        <label class="label">소속사 <span class="font-normal text-muted text-xs">(검색 · 없으면 비움 · 목록 외 이름은 새 업체 등록)</span></label>
        ${companyCombo("agency_company", c.agency_name || "", "소속사/레이블", "소속사")}
      </div>` : ""}
      ${type === "artist" ? `
      <div>
        <label class="label">소속 그룹 <span class="font-normal text-muted text-xs">(밴드·아이돌 그룹 멤버일 때 — 선택 시 소속사 자동 연동)</span></label>
        ${groupCombo("group_id", c.group_id || "", (groups.find((g) => Number(c.group_id) === g.id) || {}).name || "", groups)}
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
        ? dirtyActionRow({ deleteFormId: `del-client-${c.id}`, deleteLabel: "클라이언트 삭제" })
        : dirtyActionRow({ cancelHref: "/clients", saveLabel: "추가", dirty: false })}
    </form>
    ${withExtras && isEdit && canFiles && type === "company" ? `<div>${clientFileSection(c, fileMap, fileErr)}</div>` : ""}
    ${isEdit ? `<form id="del-client-${c.id}" method="post" action="/clients/${c.id}/delete" data-confirm="${esc(c.name || "이 클라이언트")}를 삭제할까요? 연결된 프로젝트·청구서에서는 자동으로 '미지정' 처리됩니다." class="hidden"></form>` : ""}`;
}

/** 첨부 서류 카드(상세에서 분리 배치용). 업체(company)만 표시(아티스트·그룹은 첨부 없음). fileOk=실제 접근 가능 여부(깨진 링크 경고). */
function clientFilesBlock(c, files, fileErr, fileOk = {}) {
  if (c.kind !== "company") return "";
  const fileMap = {};
  files.forEach((f) => { fileMap[f.kind] = f; });
  return `<div>${clientFileSection(c, fileMap, fileErr, fileOk)}</div>`;
}

module.exports = { FILE_KINDS, fileKindLabel, companyRoleLabel, clientRoleList, clientProjectCard, clientFileSection, clientFilesBlock, clientForm };
