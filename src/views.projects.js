"use strict";

/** 프로젝트 상세/목록 렌더 — projects.routes.js에서 분리(2026-07-09, views.sessions.js·views.invoices.js 컨벤션과 동일). */

const { TASK_STATUS_LABELS, TASK_STATUS_BADGE, docNumberWithType } = require("./config");
const {
  esc,
  formatKRW,
  emptyState,
  detailsChevron,
  ddayPill,
  explain,
  dirtyActionRow,
  personCombo,
  payerCombo,
  companyCombo,
  dateCombo,
  pageHeader,
} = require("./views");
const { formatYmdShort, todayYmd } = require("./lib/date");
const {
  clientOptions,
  contactOptions,
  listProjectContacts,
  partyOptions,
  getParty,
  listProjectManagers,
  activeTaskTypes,
  taskTypeLabel,
  taskTypeUnitPrice,
  payerDocMeta,
  peekInvoiceNumber,
  listGroupsForPicker,
} = require("./data");

/** "+ 새 프로젝트" 버튼 — 유형 구분 없이 단일 진입(모든 프로젝트가 세션 일정+곡·콘텐츠 동일). */
function newProjectMenu() {
  return `<a href="/projects/new" class="btn-primary ml-auto">+ 새 프로젝트</a>`;
}


/**
 * 다음 방문(다가오는 세션) 한 줄 — `listProjects`가 파생하는 next_session_date(오늘 이후·취소 제외 최소일).
 * 임박(D-3 이내)하면 브랜드색으로 강조해 "다음 방문이 언제인지"를 목록에서 바로 파악.
 */
function nextSessionLine(p) {
  if (!p.next_session_date) return "";
  // 디데이만 임박도 색 단계로 강조(2026-07-11 사용자 요청 — PM 밑, 디데이만 눈에 띄게): 공용 ddayPill(views.js).
  // 3일 이내=빨강 / 2주 이내=주황 / 그 외=흐린 회색(멀리·뒤로 물러남). 옅은 보더 pill·크게(text-sm).
  return `<span class="proj-next inline-flex items-center gap-1.5 text-xs text-muted">
    <span>${esc(formatYmdShort(p.next_session_date))}</span>
    ${ddayPill(p.next_session_date)}
  </span>`;
}


/** 프로젝트의 항목(트랙) 개수. track_titles("||" 연결)에서 파생. */
function trackCount(p) {
  if (!p || !p.track_titles) return 0;
  return String(p.track_titles).split("||").map((s) => s.trim()).filter(Boolean).length;
}


/** 카드 정체성 줄: "아티스트 · 회사". 회사가 아티스트 본인으로 파생된 경우 아티스트만. 여러 아티스트면 "외 N". 둘 다 없으면 null(→ 제목 승격). */
function projectIdentity(p) {
  const artists = String(p.artist || "").split(",").map((s) => s.trim()).filter(Boolean);
  let artistPart = "";
  if (artists.length === 1) artistPart = artists[0];
  else if (artists.length > 1) artistPart = `${artists[0]} 외 ${artists.length - 1}`;
  const company = String(p.client_name || "").trim();
  const parts = [];
  if (artistPart) parts.push(artistPart);
  if (company && company !== artistPart && !artists.includes(company)) parts.push(company);
  return parts.length ? parts.join(" · ") : null;
}


/**
 * 목록 카드 → 상세 진입 탭(2026-07-14 사용자 요청 — "어차피 그거 보러 들어가는 것"):
 *  - 청구 필요 탭  → 청구 탭 직행
 *  - 진행 중 탭    → 세션 일정. 세션이 하나도 없고 곡·콘텐츠만 있으면 곡·콘텐츠 탭.
 *  - 완료 탭·그 외 → 기본(정보 탭)
 * 청구 탭은 canBill(치프·대표·스태프=전원)이라 권한으로 막히지 않는다.
 */
function projectRowHref(p, tab, listQuery = "") {
  const base = `/projects/${p.id}`;
  // 상세 백링크가 **보던 목록(탭·검색·내 프로젝트만)** 으로 돌아오도록 복귀 경로를 실어 보낸다
  // (2026-07-14 사용자 요청 — 완료 탭에서 들어갔다가 나오면 진행 중 탭으로 떨어지던 것). 청구 상세 return과 동일 패턴.
  const ret = listQuery ? `return=${encodeURIComponent(listQuery)}` : "";
  const with_ = (qs) => (qs ? `${base}?${qs}${ret ? `&${ret}` : ""}` : ret ? `${base}?${ret}` : base);
  if (tab === "billing") return with_("tab=invoice");
  if (tab === "active") {
    if (Number(p.sess_cnt) > 0) return with_("tab=sessions");
    if (trackCount(p) > 0) return with_("tab=tracks");
  }
  return with_("");
}


/** 아티스트 열(지메일의 '보낸사람') — 여러 명이면 "외 N", 아티스트가 없으면 회사, 둘 다 없으면 제목. */
function projectArtistLabel(p) {
  const artists = String(p.artist || "").split(",").map((s) => s.trim()).filter(Boolean);
  if (artists.length === 1) return artists[0];
  if (artists.length > 1) return `${artists[0]} 외 ${artists.length - 1}`;
  const company = String(p.client_name || "").trim();
  return company || String(p.title || "제목 없음");
}

/** 부제 열(지메일의 '제목·미리보기') — "제작사 · 프로젝트명". 아티스트 열이 이미 그 값이면 그 조각은 생략. */
function projectSubLabel(p) {
  const head = projectArtistLabel(p);
  const company = String(p.client_name || "").trim();
  const title = String(p.title || "").trim();
  const artists = String(p.artist || "").split(",").map((s) => s.trim()).filter(Boolean);
  const parts = [];
  if (company && company !== head && !artists.includes(company)) parts.push(company);
  if (title && title !== head) parts.push(title);
  return parts.join(" · ");
}


/** 아티스트만(폴백 없음) — 표의 아티스트 열용. 여러 명이면 "외 N", 없으면 빈 문자열(제작사·프로젝트명은 별도 열). */
function projectArtistOnly(p) {
  const a = String(p.artist || "").split(",").map((s) => s.trim()).filter(Boolean);
  return a.length > 1 ? `${a[0]} 외 ${a.length - 1}` : a[0] || "";
}

/**
 * 프로젝트 목록 표 헤더(2026-07-16 사용자 요청 — 청구 표처럼 항목명·칸칸이). 각 행 summary와 같은 grid 열.
 * 컬럼: 아티스트 · 제작사 · 프로젝트 · PM · 다음 세션 · 금액 · 작성일 · [⌄].
 */
function projectTableHead() {
  // 헤더 클래스(pt-h-pm/amount/created)는 좁을 때 해당 열을 행 셀과 함께 CSS로 숨기기 위함.
  // 열 순서 = 제작사 → 아티스트(2026-07-20 사용자 요청으로 맞바꿈).
  // **항목명 클릭 = 정렬**(2026-07-20 사용자 요청): 청구 목록과 같은 공용 코어(app.js wireSortHeaders)를 쓴다.
  // key는 행 셀의 data-sort-key와 짝이고(인덱스가 아니라 key로 찾으므로 열이 숨어도 안전), type은 비교 방식.
  const th = (label, key, type = "text", cls = "") =>
    `<span class="pt-h pt-sortable ${cls}" data-sort-key="${key}" data-sort-type="${type}" role="button" tabindex="0" aria-sort="none">${esc(label)}<span class="pt-sort-arrow" aria-hidden="true"></span></span>`;
  // 작성일이 맨 앞(2026-07-20 사용자 요청). 좁아지면 여전히 **작성일부터** 숨는다(자리만 앞으로 온 것).
  return `<div class="proj-thead">${th("작성일", "created", "date", "pt-h-created")}${th("제작사", "company")}${th("아티스트", "artist")}${th("프로젝트", "title")}${th("PM", "pm", "text", "pt-h-pm")}${th("다음 세션", "next", "date")}${th("금액", "amount", "num", "pt-h-amount")}<span aria-hidden="true"></span></div>`;
}

/**
 * 목록 행(2026-07-16 청구 표식 재설계 — 컬럼 정렬 + 항목명 헤더 + 작성일 열, 밀도 토글 폐지).
 *  - `<details>` 한 벌: summary=grid 셀(헤더와 같은 열).
 *  - **행 전체가 이동 링크**(2026-07-18 사용자 요청 — 모든 데이터 셀이 `projectRowHref`로 가는 `<a>`, 셀별 밑줄·색강조 없음·어포던스는 행 배경 호버만).
 *    `<summary>` 안의 `<a>`는 클릭 시 이동만 하고 토글 안 함(브라우저 기본), 유일하게 **오른쪽 끝 `.proj-toggle`(비인터랙티브 span)만 클릭 시 펼침**(세션·곡 요약 + 완료 토글).
 *  - 다음 세션=진행 중 탭만(디데이 pill), 금액=프로젝트 버짓(청구 필요 탭은 '청구 필요 N' 배지 병기), 작성일=전 탭.
 *  - 반응형: <640px면 thead 숨기고 아티스트·프로젝트 + 탭 값만 2줄 카드(제작사·PM·작성일 숨김).
 */
function projectListRow(p, summary, { tab = "active", isAdmin = false, openId = null, mine = false, listQuery = "" } = {}) {
  const href = projectRowHref(p, tab, listQuery);
  const dash = '<span class="text-muted">—</span>';
  // sortVal = 정렬 원값(헤더 클릭 정렬). **항상 명시한다** — 보이는 텍스트로 정렬하면 틀리는 열이 많다:
  // 금액 '₩1,200,000'(문자열 정렬 불가)·다음 세션 'D-3'(날짜순 아님)·빈 칸의 '—'(빈 값으로 안 쳐서 뒤로 안 감).
  // app.js는 빈 문자열을 방향 무관 뒤로 보내므로, 값 없는 칸은 ""를 넘겨야 의도대로 놓인다.
  const cellLink = (val, cls, label, key, sortVal) =>
    `<a href="${href}" class="pt-cell proj-link ${cls}" data-label="${esc(label)}" data-sort-key="${key}" data-sort-value="${esc(String(sortVal == null ? "" : sortVal))}">${val}</a>`;
  const artistRaw = projectArtistOnly(p);
  const companyRaw = String(p.client_name || "").trim();
  const titleRaw = String(p.title || "제목 없음").trim();
  const pmRaw = p.manager_name ? String(p.manager_name) : "";
  const artist = esc(artistRaw);
  const company = esc(companyRaw);
  const title = esc(titleRaw);
  const pm = esc(pmRaw);
  const next = tab === "active" ? nextSessionLine(p) : ""; // 다음 세션·디데이 = 진행 중 탭만(완료·청구필요는 next_session_date 없음)
  const amt = projectAmount(p);
  const amount = amt ? formatKRW(amt) : "";
  const billingBadge = tab === "billing" && Number(p.unbilled_cnt) > 0
    ? ` <span class="badge bg-warning/10 text-warning">청구 필요 ${p.unbilled_cnt}</span>` : "";
  const created = p.created_at ? esc(String(p.created_at).slice(0, 10)) : "";
  const isOpen = openId != null && Number(p.id) === Number(openId);
  return `
    <details class="proj-row group/proj"${isOpen ? " open" : ""} id="proj-${p.id}" data-sort-row>
      <summary class="proj-summary">
        ${cellLink(created, "pt-created tabular text-muted", "작성일", "created", created)}
        ${cellLink(company || dash, "pt-company text-muted", "제작사", "company", companyRaw)}
        ${cellLink(artist || dash, "pt-artist font-medium", "아티스트", "artist", artistRaw)}
        ${cellLink(title, "pt-title", "프로젝트", "title", titleRaw)}
        ${cellLink(pm || dash, "pt-pm text-muted", "PM", "pm", pmRaw)}
        ${cellLink(next, "pt-next", "다음 세션", "next", p.next_session_date || "")}
        ${cellLink(`${amount}${billingBadge}`, "pt-amount tabular", "금액", "amount", amt || "")}
        <span class="proj-toggle" aria-hidden="true" title="펼치기"><svg class="proj-chevron transition-transform group-open/proj:rotate-180" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M6 8l4 4 4-4" /></svg></span>
      </summary>
      <div class="proj-expand border-t border-border/40 bg-elevated/40 px-4 py-3 text-xs leading-relaxed">${projectSummaryHtml(summary, { isAdmin, projectId: p.id, tab, mine })}</div>
    </details>`;
}


/** 인라인 요약 본문 — 세션 일정(날짜·시간) + 곡·콘텐츠(아티스트·제목·작업자). data.listProjectSummaries 결과 1건. */
function projectSummaryHtml(s, { isAdmin = false, projectId = null, tab = "active", mine = false } = {}) {
  if (!s || (!s.sessions.length && !s.tracks.length)) {
    return `<span class="text-muted">등록된 세션·곡·콘텐츠가 없습니다.</span>`;
  }
  // 완료 후 목록으로 복귀하며 이 카드를 다시 펼친다(?open=). 스크롤은 app.js가 보존(경로 동일).
  // mine=1(내 프로젝트만 필터)이면 보존해 필터된 뷰를 유지(2026-07-12).
  const ret = `/projects?tab=${esc(tab)}${mine ? "&mine=1" : ""}${projectId ? `&open=${projectId}` : ""}`;
  // 프로젝트 목록 펼침에서 바로 완료(2026-07-11 사용자 요청 — 프로젝트 안 안 들어가고 완료). 편집 권한자·예정/완료 세션만.
  const sessToggle = (se) => {
    if (!isAdmin || (se.status !== "예정" && se.status !== "완료")) return "";
    const done = se.status === "완료";
    return `<form method="post" action="/sessions/${se.id}/status" class="shrink-0">
        <input type="hidden" name="status" value="${done ? "예정" : "완료"}" />
        <input type="hidden" name="return" value="${ret}" />
        <button class="btn-ghost btn-xs ${done ? "border-success/40 bg-success/10 text-success" : "text-success"}" type="submit" aria-pressed="${done}"><span aria-hidden="true" class="inline-block w-3 text-center ${done ? "" : "opacity-60"}">${done ? "✓" : "−"}</span>완료</button>
      </form>`;
  };
  // 곡·콘텐츠 작업(후반작업)도 목록 펼침에서 바로 완료(2026-07-11 사용자 요청 — 세션과 동일). status=Pending↔Completed.
  const taskToggle = (tk) => {
    if (!isAdmin) return "";
    const done = tk.status === "Completed";
    return `<form method="post" action="/projects/tasks/${tk.id}/status" class="shrink-0">
        <input type="hidden" name="status" value="${done ? "Pending" : "Completed"}" />
        <input type="hidden" name="return" value="${ret}" />
        <button class="btn-ghost btn-xs ${done ? "border-success/40 bg-success/10 text-success" : "text-success"}" type="submit" aria-pressed="${done}"><span aria-hidden="true" class="inline-block w-3 text-center ${done ? "" : "opacity-60"}">${done ? "✓" : "−"}</span>완료</button>
      </form>`;
  };
  const blocks = [];
  if (s.sessions.length) {
    // 다가오는 세션(오늘 이후) 먼저, 지난 세션은 그 뒤(최근 순)로 재정렬 — 지난 세션이 앞을 먹어 다가오는 게 잘리는 것 방지.
    const today = todayYmd();
    const upcoming = s.sessions.filter((se) => se.session_date >= today);
    const past = s.sessions.filter((se) => se.session_date < today).reverse();
    const ordered = [...upcoming, ...past];
    const items = ordered.slice(0, 8).map((se) => {
      const time = se.start_time ? ` ${esc(se.start_time)}${se.end_time ? "–" + esc(se.end_time) : ""}` : "";
      const st = se.status && se.status !== "예정" ? ` <span class="text-muted">· ${esc(se.status)}</span>` : "";
      const dateCls = se.session_date < today ? "text-muted" : "text-fg/80";
      const toggle = sessToggle(se);
      const info = `<span class="min-w-0 truncate"><span class="tabular ${dateCls}">${esc(formatYmdShort(se.session_date))}${time}</span> <span class="text-muted">· ${esc(se.session_type)}</span>${st}</span>`;
      return `<li class="flex items-center justify-between gap-2">${info}${toggle}</li>`;
    }).join("");
    const more = s.sessions.length > 8 ? `<li class="text-muted">외 ${s.sessions.length - 8}건</li>` : "";
    blocks.push(`<div><div class="mb-0.5 font-medium text-fg/60">세션 ${s.sessions.length}</div><ul class="space-y-0.5">${items}${more}</ul></div>`);
  }
  if (s.tracks.length) {
    // 곡별로 제목 + 그 아래 작업(믹싱·마스터링 등) 목록 — 각 작업에 완료 토글(세션과 동일). 편집 권한자만 토글, 완료는 '· 완료' 병기.
    const items = s.tracks.slice(0, 10).map((tr) => {
      const artist = tr.artist ? `<span class="text-muted">${esc(tr.artist)} · </span>` : "";
      const eng = tr.engineers.length ? ` <span class="text-muted">(${esc(tr.engineers.join(", "))})</span>` : "";
      const head = `<div class="truncate text-fg/80">${artist}${esc(tr.title)}${eng}</div>`;
      const taskLis = (tr.tasks || []).map((tk) => {
        const done = tk.status === "Completed";
        const st = done ? ` <span class="text-muted">· 완료</span>` : "";
        return `<li class="flex items-center justify-between gap-2 pl-3"><span class="min-w-0 truncate text-fg/70">${esc(tk.label)}${st}</span>${taskToggle(tk)}</li>`;
      }).join("");
      return `<li>${head}${taskLis ? `<ul class="mt-0.5 space-y-0.5">${taskLis}</ul>` : ""}</li>`;
    }).join("");
    const more = s.tracks.length > 10 ? `<li class="text-muted">외 ${s.tracks.length - 10}곡</li>` : "";
    blocks.push(`<div><div class="mb-0.5 font-medium text-fg/60">곡·콘텐츠 ${s.tracks.length}</div><ul class="space-y-1.5">${items}${more}</ul></div>`);
  }
  // 세로 스택(2026-07-11 사용자 요청): 세션 블록은 전폭(완료 토글이 행 오른쪽 끝에 정렬), 곡·콘텐츠는 다음 줄로.
  return `<div class="space-y-3">${blocks.join("")}</div>`;
}


/** 청구된 세션 수정·삭제 차단 모달(?error=session_invoiced). app.js의 '확인'(data-modal-close)으로 닫는다. */
function sessionInvoicedModal(projectId) {
  return `
    <div data-modal class="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
      <div class="card w-full max-w-md">
        <h3 class="font-display text-base font-semibold">청구된 세션</h3>
        <p class="mt-2 text-sm text-muted">이미 청구된 세션은 수정·삭제할 수 없습니다. 청구서를 삭제한 뒤 다시 시도하세요.</p>
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
    p.artist_company ? `소속 ${esc(p.artist_company)}` : "",
    p.production_company ? `제작/운영 ${esc(p.production_company)}` : "",
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
function projectMetaCard(p, err = "", { chief = false } = {}) {
  // 치프 전용 작성일(생성일) 편집 — 완료/청구 필요 탭 정렬(작성일순)에 영향. 목록에서 상세로 이동(2026-07-11).
  const dateStr = esc(String(p.created_at || "").slice(0, 10));
  const createdEdit = chief
    ? `<form method="post" action="/projects/${p.id}/created-at" class="mb-3 flex items-center gap-2 border-b border-border/40 pb-3">
         <input type="hidden" name="return" value="/projects/${p.id}?tab=project" />
         <label class="text-xs text-muted">작성일</label>
         ${dateCombo("created_at", dateStr, { label: "작성일", inputCls: "w-[8.5rem] rounded border border-border/70 bg-surface px-1.5 py-0.5 text-xs text-muted tabular focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary/30" })}
         <button type="submit" class="btn-primary btn-xs shrink-0">저장</button>
       </form>`
    : "";
  return `
    <div class="card">
      <form id="del-proj-${p.id}" method="post" action="/projects/${p.id}/delete" data-confirm="프로젝트를 삭제하면 세션·곡·콘텐츠·자료가 모두 삭제됩니다. 정말 삭제할까요?" class="hidden"></form>
      ${createdEdit}
      ${projectEditForm(p, err)}
    </div>`;
}


function projectAmount(project) {
  const task = Number(project.task_total || 0);
  const sess = Number(project.session_amount_total || 0);
  // 청구서 단위 할인(from-tasks 청구서)은 라인 금액에 분배되지 않으므로 여기서 차감 — 할인 반영 실수령 기준(2026-07-05 사용자 리포트).
  const disc = Number(project.invoice_discount_total || 0);
  const combined = task + sess;
  if (combined) return Math.max(0, combined - disc);
  return Number(project.rate || 0) || 0;
}


// ── 폼 렌더 ──
function projectForm(p = {}, err = "") {
  const e = err || p._err || "";
  const action = "/projects";
  return `
    ${pageHeader({ title: "새 프로젝트" })}
    <form method="post" action="${action}" class="card space-y-3">
      <input type="hidden" name="project_type" value="session" />
      ${e ? `<p class="rounded-lg bg-danger/10 px-3 py-2 text-sm text-danger">${esc(e)}</p>` : ""}
      <div class="grid gap-3 sm:grid-cols-2">
        <div>
          <label class="label">프로젝트 명</label>
          <input class="input" name="title" value="${esc(p.title || "")}" placeholder="예: OOO 세션 (가제)" required />
        </div>
        <div>
          <label class="label">프로젝트 매니저</label>
          ${managerSelect(p.manager_id)}
        </div>
      </div>
      <div>
        <label class="label">아티스트</label>
        ${artistCombo(p)}
      </div>
      <div>
        <label class="label">제작/운영</label>
        ${companyCombo("production_company", p.production_company, "제작사", "제작/운영", { partyIdField: "production_party_id", partyIdValue: p.production_id })}
      </div>
      <div>
        <label class="label">고객측 담당자</label>
        ${(() => { const sel = p.id ? listProjectContacts(p.id) : []; return personCombo({ multi: true, selected: sel, options: contactOptions(), companyOptions: partyOptions({ role: "company" }), placeholder: sel.length ? "" : "담당자 — 검색 또는 새로 등록" }); })()}
      </div>
      <div>
        <label class="label">메모</label>
        <textarea class="input" name="memo" rows="3" placeholder="비고">${esc(p.memo || "")}</textarea>
      </div>
      <div class="flex items-center justify-between gap-3 pt-1">
        <a href="/projects" class="btn-ghost btn-sm">취소</a>
        <button class="btn-primary" type="submit">추가</button>
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
          <label class="label">프로젝트 매니저</label>
          ${managerSelect(p.manager_id)}
        </div>
      </div>
      <div>
        <label class="label">아티스트</label>
        ${artistCombo(p)}
      </div>
      <div>
        <label class="label">제작/운영</label>
        ${companyCombo("production_company", p.production_company, "제작사", "제작/운영", { partyIdField: "production_party_id", partyIdValue: p.production_id })}
      </div>
      <div>
        <label class="label">고객측 담당자</label>
        ${(() => { const sel = p.id ? listProjectContacts(p.id) : []; return personCombo({ multi: true, selected: sel, options: contactOptions(), companyOptions: partyOptions({ role: "company" }), placeholder: sel.length ? "" : "담당자 — 검색 또는 새로 등록" }); })()}
      </div>
      <div>
        <label class="label">메모</label>
        <textarea class="input" name="memo" rows="3">${esc(p.memo || "")}</textarea>
      </div>
      ${dirtyActionRow({ deleteFormId: `del-proj-${p.id}`, deleteLabel: "프로젝트 삭제", cancelHref: "/projects" })}
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
  // 표시 이름 = artist TEXT 우선, 없으면 party 활동명/본명 폴백(TEXT denorm 비어도 콤보에 이름 표시).
  const artistName = p.artist || (artistParty ? artistParty.activity_name || artistParty.name || "" : "");
  // 콤마 다중("아이유, 태연")이면 단일 전용 메타(명시 id·그룹·본명) 비활성 — 서버가 이름별 해석(resolveProjectParties 다중 경로).
  const multi = artistName.includes(",");
  const meta = {
    contactId: !multi && artistParty ? artistParty.id : "",
    isGroup: !multi && artistParty ? artistParty.kind === "group" : false,
    realName: !multi && artistParty && artistParty.kind === "person" && artistParty.name && artistParty.name !== artistName ? artistParty.name : "",
  };
  // 아티스트 후보 = is_artist party(사람 solo + 그룹). 콤보 옵션 shape {name, contactId, realName, sub}.
  const opts = partyOptions({ role: "artist" }).map((o) => ({
    name: o.activity_name || o.name,
    contactId: o.id,
    realName: o.kind === "person" && o.activity_name && o.name && o.name !== o.activity_name ? o.name : "", // 본명(활동명과 다를 때)
    sub: o.sub,
    agency: o.company || "", // 현재 소속사 → 아티스트 선택 시 소속사/레이블 필드 자동 채움
  }));
  const json = JSON.stringify(opts).replace(/</g, "\\u003c"); // </script> 브레이크아웃 방지
  const companies = partyOptions({ role: "company" }); // 모달 소속사 미니콤보용
  const groups = listGroupsForPicker(); // 모달 소속 그룹 미니콤보용(개인 아티스트가 속한 밴드·팀)
  // Gmail식 칩(2026-07-10 — 콤마 텍스트 방식에서 전환, 담당자·디렉터·대표자와 통일).
  // **서버 계약 불변**: hidden `artist`=활동명 콤마 목록, `artist_contact_id`=단일 선택일 때만 명시 id.
  // 칩 라벨은 '활동명 (본명)' 병기(본명은 단일 프리필 또는 옵션에서 옴). app.js chipEl과 마크업 형식 동일.
  const names = artistName.split(",").map((x) => x.trim()).filter(Boolean);
  const chipHtml = names.map((nm, i) => {
    const rn = names.length === 1 ? meta.realName : ""; // 다중 프리필은 본명을 알 수 없음(표시 TEXT만 저장)
    const label = rn && rn !== nm ? `${nm} (${rn})` : nm;
    const cid = names.length === 1 ? meta.contactId || "" : "";
    return `<span class="inline-flex max-w-full items-center gap-1 rounded-full border border-border bg-elevated py-0.5 pl-2.5 pr-1 text-sm" data-artist-chip data-artist-chip-name="${esc(nm)}" data-artist-chip-cid="${esc(String(cid))}">
      <span class="truncate">${esc(label)}</span>
      <button type="button" class="flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-muted hover:bg-border hover:text-fg" data-artist-chip-remove aria-label="${esc(nm)} 제거">✕</button>
    </span>`;
  }).join("");
  return `
    <div data-artist-combo>
      <input type="hidden" name="artist_contact_id" value="${meta.contactId || ""}" data-artist-cid />
      <input type="hidden" name="artist" value="${esc(names.join(", "))}" data-artist-hidden />
      <div class="relative">
        <!-- 보이는 검색칸은 name 없음(제출은 위 hidden) — 칩이 값의 진실원천 -->
        <div class="input flex flex-wrap items-center gap-1.5 py-1.5" data-artist-chips>
          ${chipHtml}
          <input class="min-w-[3rem] flex-1 border-0 bg-transparent p-0 text-inherit outline-none focus:ring-0" type="text" size="1" data-artist-input autocomplete="off"
            role="combobox" aria-expanded="false" aria-autocomplete="list" placeholder="${names.length ? "" : "아티스트명 — 검색 또는 새로 등록"}" />
        </div>
        <div class="absolute left-0 z-30 mt-1 hidden max-h-64 w-max min-w-[14rem] max-w-full overflow-auto rounded-lg border border-border bg-surface py-1 shadow-lg" data-artist-pop role="listbox"></div>
      </div>
      <script type="application/json" data-artist-options>${json}</script>
      <!-- 간이 등록 모달(프로젝트 폼 이탈 없이 새 아티스트/그룹 등록). name 없음(프로젝트 폼과 분리), app.js가 fetch로 생성. -->
      <div data-artist-modal class="fixed inset-0 z-50 hidden items-center justify-center bg-black/40 p-4">
        <div class="w-full max-w-sm space-y-3 rounded-xl border border-border bg-bg p-4 shadow-xl" role="dialog" aria-modal="true">
          <div class="font-display text-lg font-semibold">새 아티스트 등록</div>
          <!-- 유형 먼저(2026-07-14 사용자 리포트 '그룹 체크가 [이 사람이 그룹 소속]인지 [이름 자체가 그룹]인지 불명확').
               개인=사람 party(활동명·본명·소속 그룹), 그룹=group party(그룹명). name 없는 select(폼 제출 안 됨·app.js가 읽음). -->
          <div><label class="label">등록 유형</label>
            <select class="input" data-am-type>
              <option value="artist" selected>개인 아티스트 (솔로·멤버)</option>
              <option value="group">그룹 (밴드 · 팀 자체)</option>
            </select>
          </div>
          <div><label class="label" data-am-name-label>활동명</label><input class="input" data-am-name placeholder="아티스트 활동명" /></div>
          <div data-am-real-wrap><label class="label">본명 <span class="text-xs font-normal text-muted">(활동명과 다르면)</span></label><input class="input" data-am-real placeholder="본명(선택)" /></div>
          <div data-am-group-wrap><label class="label">소속 그룹 <span class="text-xs font-normal text-muted">(선택 · 밴드·팀 멤버면)</span></label>
            <input type="hidden" data-am-group-id value="" />
            <div class="relative">
              <input class="input" data-am-group-input autocomplete="off" placeholder="그룹 검색 또는 새로 등록" role="combobox" aria-expanded="false" aria-autocomplete="list" />
              <div class="absolute left-0 right-0 z-10 mt-1 hidden max-h-40 overflow-auto rounded-lg border border-border bg-surface py-1 shadow-lg" data-am-group-pop role="listbox"></div>
            </div>
            <script type="application/json" data-am-group-options>${JSON.stringify(groups.map((g) => ({ id: g.id, name: g.name }))).replace(/</g, "\\u003c")}</script>
          </div>
          <div><label class="label">소속사 <span class="text-xs font-normal text-muted">(선택)</span></label>
            <div class="relative">
              <input class="input" data-am-agency-input autocomplete="off" placeholder="소속사 검색 또는 새로 등록" role="combobox" aria-expanded="false" aria-autocomplete="list" />
              <div class="absolute left-0 right-0 z-10 mt-1 hidden max-h-40 overflow-auto rounded-lg border border-border bg-surface py-1 shadow-lg" data-am-agency-pop role="listbox"></div>
            </div>
            <script type="application/json" data-am-agency-options>${JSON.stringify(companies.map((co) => ({ id: co.id, name: co.name }))).replace(/</g, "\\u003c")}</script>
          </div>
          <div data-am-person-only><label class="label">전화 <span class="text-xs font-normal text-muted">(선택)</span></label><input class="input" data-am-phone autocomplete="off" /></div>
          <div data-am-person-only><label class="label">이메일 <span class="text-xs font-normal text-muted">(선택)</span></label><input class="input" type="email" data-am-email autocomplete="off" /></div>
          <div class="flex items-center gap-2 pt-1">
            <button type="button" class="btn-primary" data-am-save>등록</button>
            <button type="button" class="btn-ghost" data-am-cancel>취소</button>
            <span class="ml-1 hidden text-xs text-danger" data-am-err></span>
          </div>
        </div>
      </div>
    </div>`;
}

// companyCombo는 views.js 공용 헬퍼로 이동(연락처 폼과 공유, 2026-07-04).


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
        <label class="label mb-1 text-xs">아티스트 <span class="font-normal text-muted">— 기본=프로젝트 아티스트(검색·새 등록 가능)</span></label>
        ${artistCombo({ artist: project.artist, artist_id: project.artist_id })}
      </div>
      <div>
        <label class="label mb-1 text-xs">곡·콘텐츠 이름 <span class="font-normal text-muted">— 여러 곡은 줄바꿈으로 구분(같은 아티스트)</span></label>
        <div class="flex gap-2">
          <textarea class="input flex-1 py-1.5 text-sm" name="titles" rows="2" placeholder="곡명 또는 콘텐츠명&#10;한 줄에 하나씩 입력"></textarea>
          <button class="btn-primary shrink-0 self-end px-4 py-1.5 text-sm" type="submit">추가</button>
        </div>
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
          <div class="font-medium">${esc(track.title)}${track.artist ? `<span class="ml-1.5 text-xs font-normal text-muted">${esc(track.artist)}</span>` : ""}</div>
        </div>
        ${isAdmin ? trackEditMenu(track, hasInvoiced) : ""}
      </div>
      ${trackProgressSummary(track.tasks)}
      <div class="space-y-2">${tasks}</div>
      ${isAdmin ? taskQuickAdd(track) : ""}
    </div>`;
}


/** 곡의 진행 요약: 단계 그룹별 가장 진전된 상태를 한 줄로(믹스 완료 · 마스터 대기). */
function trackProgressSummary(tasks) {
  if (!tasks || !tasks.length) return "";
  const order = { Pending: 0, Completed: 1 };
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
        <div><label class="label mb-0.5 text-xs">아티스트</label>${artistCombo({ artist: track.artist })}</div>
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
  // 완료 토글(2026-07-05 사용자 요청 — 세션 완료 버튼과 동일 UX): 배지 대신 버튼 활성/비활성이 상태를 표시.
  // 대기=비활성 '− 완료'(누르면 완료), 완료=활성 '✓ 완료'(다시 누르면 대기로). 독립 폼(POST /status)이라 접힌 채로도 즉시 전환.
  const isDone = task.status === "Completed";
  const completeToggle = `
    <form method="post" action="/projects/tasks/${task.id}/status">
      <input type="hidden" name="status" value="${isDone ? "Pending" : "Completed"}" />
      <button class="btn-ghost btn-xs ${isDone ? "border-success/40 bg-success/10 text-success" : "text-success"}" type="submit" aria-pressed="${isDone}"><span aria-hidden="true" class="inline-block w-3.5 text-center ${isDone ? "" : "opacity-60"}">${isDone ? "✓" : "−"}</span>완료</button>
    </form>`;
  return `
    <details id="task-${task.id}" class="group rounded-lg border border-border bg-surface"${open ? " open" : ""}>
      <summary class="flex cursor-pointer list-none items-center justify-between gap-2 p-2.5">
        ${title}
        <span class="flex shrink-0 items-center gap-2">
          ${amount}
          ${completeToggle}
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
  // 상태(완료 여부)는 헤더의 독립 토글 버튼(POST /tasks/:id/status)이 전담(2026-07-05) — 이 폼엔 상태 필드 없음(종류·담당·외주단가만).
  // 명시적 저장 버튼(변경 시 하이라이트) — app.js [data-dirty-form] 공통.
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
        <button class="btn-ghost btn-xs text-danger mr-auto" type="submit" form="del-task-${task.id}">작업 삭제</button>
        <span class="text-xs text-warning" data-dirty-hint hidden>저장되지 않은 변경사항</span>
        <button class="btn-primary btn-xs transition" type="submit" data-dirty-save>작업 저장</button>
      </div>
    </form>
    <form method="post" action="/projects/tasks/${task.id}/delete" id="del-task-${task.id}" data-confirm="이 작업을 삭제할까요?" class="hidden"></form>`;
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


/**
 * 청구처 추천 칩(2026-07-15 사용자 결정 — '청구처는 항상 직접 지정').
 * 기본 선택값·서버 자동 파생을 폐기하면서(제작/운영=결제자 가정이 실무와 어긋남 — 음악감독이 턴키로 받아 결제하는 경우),
 * 흔한 경우(제작사가 결제)를 1클릭으로 넣을 수 있게 이 프로젝트의 당사자를 칩으로 제시한다. 누르면 콤보에 채워질 뿐,
 * 아무것도 미리 선택되지 않는다(안 고르면 서버가 PAYER_REQUIRED로 차단).
 */
function payerSuggestChips(project) {
  const cand = [
    { id: project.production_id, role: "제작/운영", name: project.production_company },
    { id: project.agency_id, role: "소속/레이블", name: project.artist_company },
    { id: project.artist_id, role: "아티스트", name: String(project.artist || "").split(",")[0].trim() },
  ].filter((c) => c.id && c.name);
  const seen = new Set();
  const chips = cand.filter((c) => (seen.has(Number(c.id)) ? false : seen.add(Number(c.id))));
  if (!chips.length) return "";
  return `<div class="mt-1.5 flex flex-wrap items-center gap-1.5">
      <span class="text-xs text-muted">이 프로젝트의 당사자:</span>
      ${chips
        .map(
          (c) => `<button type="button" class="rounded-full border border-border px-2.5 py-1 text-xs hover:border-primary hover:text-primary"
             data-payer-suggest="${Number(c.id)}" data-payer-suggest-name="${esc(c.name)}">${esc(c.role)} ${esc(c.name)}</button>`
        )
        .join("")}
    </div>`;
}

function unbilledInvoiceForm(project, taskRows, sessionRows = []) {
  const tasks = taskRows || [];
  if (!tasks.length && !sessionRows.length) {
    return `<div class="rounded-lg border border-border bg-bg px-3 py-4 text-center text-sm text-muted">청구할 작업·세션이 없습니다.</div>`;
  }
  // 세션 '완료 강제'와 규칙 통일: 완료 상태 작업만 기본 체크. 미완료(대기)는 체크 해제·흐리게(선택은 가능).
  const isDone = (t) => t.status === "Completed";
  // 무료 처리(waived)한 항목은 청구 후보 계산·체크에서 제외 — 이 폼에서만 되돌리기 위해 계속 노출(2026-07-06 사용자 요청).
  const hasPending = tasks.some((t) => !t.waived && !isDone(t)) || sessionRows.some((s) => !s.waived && s.status !== "완료"); // 미완료 작업(대기) 또는 예정 세션
  // 작업 예상 금액 = 확정 total_price(>0) 우선, 없으면 종류 기본단가(taskTypeUnitPrice). 프로젝트 목록 합산과 동일 규칙.
  const taskAmt = (t) => (t.total_price > 0 ? t.total_price : taskTypeUnitPrice(t.task_type));
  const subtotal =
    tasks.filter((t) => !t.waived && isDone(t)).reduce((sum, task) => sum + taskAmt(task), 0) +
    sessionRows.filter((s) => !s.waived && s.status === "완료").reduce((sum, s) => sum + (s.billing ? s.billing.amount : 0), 0); // 완료 세션만 기본 집계(예정은 체크 시 합산)
  const tax = Math.round(subtotal * 0.1);
  // 무료 처리된 행 — 체크박스·금액칸 없이 배지 + 되돌리기 버튼만(2026-07-06). formaction으로 같은 폼에서 다른 라우트 제출(중첩 폼 회피).
  const waivedRow = (label, waiveAction) => `
    <div class="flex items-center gap-2 border-b border-border py-2 last:border-0 opacity-60" data-line-row>
      <span class="min-w-0 flex-1 text-sm">${label} <span class="badge bg-bg text-muted">무료 처리됨</span></span>
      <button type="submit" formaction="${waiveAction}" formmethod="post" data-waive-btn class="btn-ghost btn-xs shrink-0">되돌리기</button>
    </div>`;
  const taskList = tasks
    .map((task) => {
      const label = taskTypeLabel(task.task_type);
      const waiveAction = `/projects/tasks/${task.id}/waive`;
      if (task.waived) return waivedRow(`${esc(task.track_title)} · ${esc(label)}`, waiveAction);
      const done = isDone(task);
      const amt = taskAmt(task);
      const statusTag = done ? "" : ` <span class="text-xs font-normal text-warning">${esc(TASK_STATUS_LABELS[task.status] || task.status)}</span>`;
      return `
        <div class="flex items-center gap-2 border-b border-border py-2 last:border-0 ${done ? "" : "opacity-60"}" data-line-row>
          <input class="shrink-0" type="checkbox" name="task_id" value="${task.id}" data-line-amount="${amt}" ${done ? "checked" : "data-confirm-pending"} id="task-cb-${task.id}" />
          <label for="task-cb-${task.id}" class="min-w-0 flex-1 cursor-pointer text-sm font-medium">${esc(task.track_title)} · ${esc(label)}${statusTag}</label>
          <button type="submit" formaction="${waiveAction}" formmethod="post" data-waive-btn class="btn-ghost btn-xs shrink-0 text-muted">청구 안 함</button>
          <div class="relative w-28 shrink-0">
            <input class="input py-1 pr-7 text-right text-sm tabular" type="text" inputmode="numeric" name="task_amount_${task.id}" value="${amt || ""}" data-line-input placeholder="0" aria-label="${esc(label)} 금액" />
            <span class="pointer-events-none absolute inset-y-0 right-2 flex items-center text-xs text-muted">원</span>
          </div>
        </div>`;
    })
    .join("");
  // 녹음 세션 직접 청구 후보(곡·콘텐츠/버튼 없이 자동 노출). 완료 세션은 기본 체크, 예정은 흐리게·체크 시 완료 확인(작업과 동일 규칙).
  const sessionList = sessionRows
    .map((s) => {
      const label = [formatYmdShort(s.session_date), project.artist, s.billing.item.name].filter(Boolean).join(" · "); // 청구 항목 스냅샷과 동일 형식 "7월 8일 · 아티스트 · 보컬녹음"(2026-07-08 — 접두 제거·· 구분)
      const waiveAction = `/sessions/${s.id}/waive`;
      if (s.waived) return waivedRow(esc(label), waiveAction);
      const done = s.status === "완료";
      const mins = s.billing.minutes;
      const dur = `${Math.floor(mins / 60)}시간${mins % 60 ? " " + (mins % 60) + "분" : ""}`;
      const time = [s.start_time, s.end_time].filter(Boolean).join("–");
      const statusTag = done ? "" : ` <span class="text-xs font-normal text-warning">${esc(s.status)}</span>`;
      return `
        <div class="flex items-center gap-2 border-b border-border py-2 last:border-0 ${done ? "" : "opacity-60"}" data-line-row>
          <input class="shrink-0" type="checkbox" name="session_id" value="${s.id}" data-line-amount="${s.billing.amount}" ${done ? "checked" : "data-confirm-pending"} id="session-cb-${s.id}" />
          <label for="session-cb-${s.id}" class="min-w-0 flex-1 cursor-pointer">
            <span class="block text-sm font-medium">${esc(label)}${statusTag}</span>
            <span class="block text-xs text-muted">${esc(dur)}${time ? " · " + esc(time) : ""}${s.billing.fixed ? ` · <span class="text-success">확정 금액</span>` : ""}</span>
          </label>
          <button type="submit" formaction="${waiveAction}" formmethod="post" data-waive-btn class="btn-ghost btn-xs shrink-0 text-muted">청구 안 함</button>
          <div class="relative w-28 shrink-0">
            <input class="input py-1 pr-7 text-right text-sm tabular" type="text" inputmode="numeric" name="session_amount_${s.id}" value="${s.billing.amount == null ? "" : s.billing.amount}" data-line-input placeholder="0" aria-label="${esc(label)} 금액" />
            <span class="pointer-events-none absolute inset-y-0 right-2 flex items-center text-xs text-muted">원</span>
          </div>
        </div>`;
    })
    .join("");
  const total = subtotal + tax;
  return `
    <form method="post" action="/projects/${project.id}/invoices/from-tasks" class="rounded-lg border border-border bg-bg p-3" data-discount-form data-supply="${subtotal}">
      <button type="submit" disabled hidden aria-hidden="true"></button><!-- 기본(첫) submit 버튼을 비활성 sentinel로: 필드에서 엔터=암묵 제출이 견적서 미리보기(첫 버튼)를 열던 것 차단 — 표준상 기본 버튼 disabled면 엔터 무동작 -->
      <input type="hidden" name="confirm_zero_amount" value="0" data-confirm-zero-amount /><!-- 체크한 항목 중 0원이 있으면 app.js가 제출 전 확인(window.confirm) 후 1로 세팅 — 서버는 이 값 없으면 여전히 차단(JS 미동작 안전망) -->
      <div class="mb-2">
        <h3 class="text-sm font-semibold">청구 생성</h3>
      </div>
      <div class="mb-2">
        <label class="label mb-1 text-xs">청구 제목</label>
        <input class="input" name="title" value="${esc(project.title)} 청구" />
      </div>
      <div class="mb-2">
        <label class="label mb-1 text-xs">청구처 <span class="font-normal text-danger">*</span></label>
        ${payerCombo({ selectedId: null, clientOptions: clientOptions(), contactOptions: contactOptions(), ...payerDocMeta() })}
        ${payerSuggestChips(project)}
        <div data-payer-fix class="mt-1.5 hidden rounded-lg bg-warning/10 px-3 py-2">
          <p data-payer-warn class="text-sm text-warning"></p>
          <div class="mt-2 flex gap-2">
            <input type="text" data-payer-fix-input class="input flex-1 py-1.5 text-sm" autocomplete="off" />
            <button type="button" data-payer-fix-btn class="btn-primary btn-sm shrink-0">입력</button>
          </div>
          <p class="mt-1 text-xs text-muted">여기에 입력하면 청구처 정보에 저장됩니다.</p>
        </div>
      </div>
      <div class="label mb-1 text-xs">청구 항목</div>
      <div class="rounded-lg border border-border bg-surface px-3">${sessionList}${taskList}</div>
      ${hasPending ? explain(`미완료 항목(대기 작업·예정 세션)은 기본 선택에서 제외됩니다. 체크하면 완료로 바꿀지 확인 후 청구·완료 처리됩니다.`) : ""}
      <div class="mt-3 space-y-2">
        <div>
          <label class="label mb-1 text-xs">할인</label>
          <div class="flex gap-2">
            <div class="relative flex-1">
              <input class="input py-1.5 text-sm pr-8" inputmode="numeric" name="discount_amount" placeholder="0" data-discount-amount />
              <span class="pointer-events-none absolute inset-y-0 right-2 flex items-center text-xs text-muted">원</span>
            </div>
            <div class="relative w-24">
              <input class="input py-1.5 text-sm pr-6" inputmode="decimal" name="discount_pct" placeholder="0" data-discount-pct />
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
            ${dateCombo("issued_date", todayYmd(), { label: "발행일", inputCls: "input w-full py-1.5 text-sm" })}
          </div>
        </div>
        <div class="mb-2">
          <div class="mb-1 text-xs text-muted">문서 발행</div>
          ${(() => {
            // 미리보기 PDF: 다운로드 파일명 = 문서번호(견적서=OMG-EST-…). Chrome는 inline PDF에서 URL 마지막 경로를
            // 파일명으로 쓰고 '다운로드'는 같은 URL을 GET 재요청하므로, formmethod=get으로 폼을 GET 제출(선택은 쿼리로).
            // 유형·번호는 경로(:type/:name)에 — GET은 formaction의 쿼리를 폼 데이터로 대체하므로 유형을 경로에 둔다.
            const base = peekInvoiceNumber(todayYmd());
            const act = (t) => `/projects/${project.id}/invoices/preview/${encodeURIComponent(t)}/${encodeURIComponent(docNumberWithType(base, t))}.pdf`;
            return `<div class="grid grid-cols-1 gap-2 sm:grid-cols-3">
            <button class="btn-ghost btn-sm" type="submit" formmethod="get" formaction="${act("견적서")}" formtarget="_blank">견적서</button>
            <button class="btn-ghost btn-sm" type="submit" formmethod="get" formaction="${act("내역서")}" formtarget="_blank">내역서</button>
            <button class="btn-ghost btn-sm" type="submit" formmethod="get" formaction="${act("거래명세서")}" formtarget="_blank">거래명세서</button>
          </div>`;
          })()}
        </div>
        ${explain(`<span class="font-medium text-fg">계산서 발행</span>이 필요할 때 아래 '청구 생성'을 누르면 청구서가 만들어지고 바로 발행됩니다(발행 후 청구처 변경 불가).`, { cls: "mb-2" })}
        <div class="flex items-center justify-end gap-2">
          <button class="btn-ghost btn-sm" type="button" data-invoice-draft-save>임시저장</button>
          <button class="btn-primary btn-sm" type="submit" data-invoice-submit>선택 항목으로 청구 생성 <span data-inv-doc>(계산서 발행)</span></button>
        </div>
      </div>
    </form>`;
}

module.exports = { artistCombo,
  newProjectMenu,
  projectListRow,
  projectTableHead,
  projectArtistOnly,
  projectIdentity,
  projectArtistLabel,
  projectSubLabel,
  projectRowHref,
  projectSummaryHtml,
  projectForm,
  projectMetaCard,
  projectMetaReadonly,
  tracksSection,
  unbilledInvoiceForm,
  sessionInvoicedModal,
};
