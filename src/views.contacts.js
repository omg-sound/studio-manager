"use strict";
// 연락처 전용 뷰(2026-07-17 마스터-디테일 전환) — 왼쪽 이름 목록 + 오른쪽 읽기/편집 패널.
// 옛 표(contactTable)는 소비처가 0이 되어 제거됨 — 연락처는 '비교'가 아니라 '찾기' 화면이라 열 폭 튜닝이 계속 실패했다(설계 문서 참조).
const { esc, personName, listGroup, copyable, dataTable } = require("./views");

/**
 * 2단 골격. lg 이상 = [이름 목록 18rem | 상세]. 미만 = 한 단(선택 여부로 한쪽만).
 * 서버가 선택 여부를 알고 클래스를 정하므로 JS가 없다.
 * backHref/backLabel: 좁은 화면(<lg)은 왼쪽 목록이 숨겨져 목록으로 돌아갈 길이 없다 → 상세 위에 lg:hidden 뒤로가기.
 * (pageHeader의 back은 전 폭에서 보이므로 이건 lg:hidden이라야 데스크톱에서 중복되지 않는다.)
 * @param {{left:string, right:string, hasSelection:boolean, backHref?:string, backLabel?:string}} o
 */
function contactPanes({ left, right, hasSelection, backHref = "", backLabel = "" }) {
  const leftCls = hasSelection ? "hidden lg:block" : "block";
  const rightCls = hasSelection ? "block" : "hidden lg:block";
  const back = hasSelection && backHref
    ? `<a href="${esc(backHref)}" class="mb-3 inline-block text-sm text-primary hover:underline lg:hidden">← ${esc(backLabel)}</a>`
    : "";
  return `<div class="lg:grid lg:grid-cols-[18rem_minmax(0,1fr)] lg:gap-6 lg:items-start">
      <div class="${leftCls} lg:sticky lg:top-4">${left}</div>
      <div class="${rightCls} min-w-0">${back}${right}</div>
    </div>`;
}

/**
 * 이름만 있는 마스터 목록(애플 연락처식). 소속·역할·전화를 넣지 않는 게 요점 — 폭 경쟁이 사라진다.
 * `listGroup({filterList:true})`가 app.js 실시간 필터 계약(data-filter-list/data-filter-empty)을 제공한다.
 * @param {{rows:object[], selectedId?:number|null, hrefFn:(row:object)=>string}} o
 */
function contactNameList({ rows, selectedId = null, hrefFn }) {
  const items = rows.map((c) => {
    const active = Number(selectedId) === Number(c.id);
    const cls = active ? "bg-primary/10 font-semibold text-fg" : "text-fg";
    return `<a href="${esc(hrefFn(c))}" class="row-link block truncate px-3 py-2 text-sm ${cls}"${active ? ' aria-current="true"' : ""}>${esc(personName(c))}</a>`;
  });
  // data-contact-list = app.js 키보드 이동 마커(선택 행 포커스 + ↑↓로 앞뒤 사람 이동, 2026-07-17 사용자 요청).
  // lg에서 목록 자체가 스크롤 영역이다: 전 명단(202명)이 페이지와 함께 흐르면 아래쪽 사람을 고를 때 페이지가 그 위치까지
  // 내려가 오른쪽 상세 머리가 화면 밖으로 나간다. 자체 스크롤이면 선택 행만 목록 안에서 스크롤된다(모바일은 한 단이라 그대로).
  return `<div data-contact-list class="lg:max-h-[calc(100vh-11rem)] lg:overflow-y-auto">${listGroup({ rows: items, filterList: true })}</div>`;
}

/**
 * 읽기 뷰에서 **연락처 밖으로 나가는 링크**(회사·프로젝트·외주·환경설정)는 새 탭으로 연다(2026-07-17 사용자 요청).
 * 이유: 왼쪽 목록이 곧 작업 맥락인데, 같은 탭에서 프로젝트를 열면 그 화면의 백링크가 연락처가 아니라 프로젝트 목록이라
 * 보던 사람으로 돌아오기 번거롭다. 연락처 안에 머무는 링크([편집]·이름 목록)는 같은 탭 유지.
 */
const OUT = ' target="_blank" rel="noopener"';

/** 읽기 뷰 한 줄(라벨 + 값). 값은 이미 esc/copyable 처리된 HTML. */
function readRow(label, valueHtml) {
  return `<div class="border-t border-border/60 px-4 py-3 first:border-t-0">
      <div class="text-xs text-muted">${esc(label)}</div>
      <div class="mt-0.5 text-sm">${valueHtml}</div>
    </div>`;
}

/**
 * 읽기 뷰 — 탭 없이 한 화면 스크롤(2026-07-17 사용자 결정).
 * 순서: 헤더 → 연락 정보 → 소속(+이력) → 메모 → 참여 내역 → 연동 정보.
 * 편집은 별도 경로(editHref) — '상세=바로 편집'은 연락처에서만 '읽기 후 편집'으로 뒤집었다(클라이언트 상세는 그대로).
 * @param {string} [o.extras] 신뢰 HTML — esc 없이 그대로 삽입된다(호출부가 esc 책임). 사용자 입력을 그대로 흘려보내지 말 것.
 */
function contactReadView(p, { affs = [], projects = [], sessions = [], editHref, extras = "" } = {}) {
  const { classifyParty } = require("./data"); // 지연 require(순환 회피)
  const dash = '<span class="text-muted">—</span>';
  const cur = affs.find((a) => !a.ended_on);
  const badges = classifyParty(p, cur).map((t) => `<span class="badge ${t.cls}">${esc(t.label)}</span>`).join(" ");
  const header = `<div class="mb-4 flex items-start justify-between gap-3">
      <div class="min-w-0">
        <h1 class="truncate font-display text-2xl font-semibold text-fg">${esc(personName(p))}</h1>
        ${badges ? `<div class="mt-1 flex flex-wrap gap-1">${badges}</div>` : ""}
      </div>
      <a href="${esc(editHref)}" class="btn-ghost btn-sm shrink-0">편집</a>
    </div>`;

  const contact = `<div class="card p-0">
      ${readRow("전화", p.phone ? copyable(p.phone) : dash)}
      ${readRow("이메일", p.email ? copyable(p.email) : dash)}
      ${p.cash_receipt_no ? readRow("현금영수증 정보", copyable(p.cash_receipt_no)) : ""}
    </div>`;

  const orgLine = cur && cur.client_id
    ? `<a href="/clients/${cur.client_id}"${OUT} class="text-primary hover:underline">${esc(cur.client_name || "")} ↗</a>`
    : dash;
  const timeline = affs.length
    ? `<div class="divide-y divide-border/60">${affs.map((a) => `
        <div class="flex items-center justify-between gap-3 px-4 py-2 text-sm">
          <div class="min-w-0">
            <span class="badge ${a.ended_on ? "badge-neutral" : "badge-success"}">${a.ended_on ? "종료" : "현재"}</span>
            <span class="font-medium">${esc(a.client_name || "무소속")}</span>
            ${a.title ? `<span class="text-muted">${esc(a.title)}</span>` : ""}
          </div>
          <span class="shrink-0 text-xs text-muted">${esc(a.started_on || "?")} ~ ${esc(a.ended_on || "현재")}</span>
        </div>`).join("")}</div>`
    : "";
  const org = `<div class="card p-0">
      ${readRow("회사", orgLine)}
      ${readRow("직책", p.job_title ? esc(p.job_title) : dash)}
      ${p.department ? readRow("부서", esc(p.department)) : ""}
      ${timeline ? `<div class="border-t border-border/60 pt-2"><div class="px-4 text-xs text-muted">소속 이력</div>${timeline}</div>` : ""}
    </div>`;

  const memo = p.memo ? `<div class="card"><div class="text-xs text-muted">메모</div><div class="mt-0.5 whitespace-pre-wrap text-sm">${esc(p.memo)}</div></div>` : "";

  // 참여 내역 — 2026-07-17 만든 표를 그대로 재사용(열 순서·작성일 표기는 프로젝트 목록과 통일).
  // **참여가 0이면 그 섹션(헤딩·빈 안내)을 통째로 숨긴다**(2026-07-17 사용자 요청, 세션→프로젝트 순으로 확장):
  // 관계자·연락처 대다수가 프로젝트·세션 참여가 없어 '0 + 빈 안내'가 매번 자리만 차지했다. 둘 다 0이면 참여 내역 영역 자체가 없다.
  const projectTable = !projects.length
    ? ""
    : dataTable(
        [
          { label: "아티스트", w: "w-[10rem]", hide: "sm", mCard: "tl" },
          { label: "제작사", w: "w-[10rem]", hide: "lg", mobileHide: true },
          { label: "프로젝트", primary: true, mCard: "bl" },
          { label: "작성일", w: "w-[6.5rem]", nowrap: true, mCard: "tr" },
        ],
        projects.map((pr) => {
          const link = (inner, cls = "") => `<a href="/projects/${pr.id}"${OUT} class="dt-link ${cls}">${inner}</a>`;
          const company = pr.production_company || pr.artist_company || "";
          return { cells: [
            pr.artist ? link(esc(pr.artist), "font-medium") : dash,
            company ? link(esc(company), "text-muted") : dash,
            link(esc(pr.title), "font-medium"),
            link(esc(String(pr.created_at || "").slice(0, 10)), "text-muted"),
          ] };
        })
      );
  const sessionTable = !sessions.length
    ? ""
    : dataTable(
        [
          { label: "날짜", w: "w-[7rem]", nowrap: true, mCard: "tl" },
          { label: "시간", w: "w-[7.5rem]", hide: "md", nowrap: true, mobileHide: true },
          { label: "종류", w: "w-[6rem]", hide: "sm", mCard: "tr" },
          { label: "프로젝트", primary: true, mCard: "bl" },
          { label: "상태", w: "w-[5rem]", mCard: "br" },
        ],
        sessions.map((s) => {
          const link = (inner, cls = "") => `<a href="/projects/${s.project_id}?tab=sessions"${OUT} class="dt-link ${cls}">${inner}</a>`;
          const time = s.all_day ? "종일" : s.start_time ? `${s.start_time}${s.end_time ? `–${s.end_time}` : ""}` : "";
          return { cells: [
            link(esc(s.session_date), "font-medium"),
            time ? link(esc(time), "text-muted") : dash,
            link(esc(s.session_type), "text-muted"),
            link(esc(s.project_title || ""), "font-medium"),
            link(esc(s.status), "text-muted"),
          ] };
        })
      );

  const section = (label, count, table) =>
    table ? `<h2 class="mb-2 mt-6 font-display text-lg font-semibold text-fg">${label} ${count}</h2>${table}` : "";
  const activity = `${section("프로젝트", projects.length, projectTable)}${section("세션", sessions.length, sessionTable)}`;

  return `${header}
    <div class="space-y-3">${contact}${org}${memo}</div>
    ${activity}
    ${extras ? `<div class="mt-6 space-y-1 text-sm">${extras}</div>` : ""}`;
}

/**
 * 읽기 뷰 '연동 정보'(extras) 조립 — 아티스트로 보기 · 대표 클라이언트 · 담당자 연동 배지.
 * 연락처 메뉴와 관계자 탭이 같은 읽기 뷰를 쓰므로(설계 §4) 이 파생 정보도 한곳에서 만든다.
 * extras는 contactReadView에 **esc 없이** 삽입되므로 사용자 데이터(이름 등)의 esc는 이 함수 책임이다.
 * @param {object} p 사람 party
 */
function contactExtras(p) {
  const { orgsWithOwnerParty, getManagerByPartyId } = require("./data"); // 지연 require(순환 회피 — classifyParty와 동일 패턴)
  const linkedManager = getManagerByPartyId(p.id);
  const ownerClients = orgsWithOwnerParty(p.id);
  return [
    p.activity_name ? `<div><span class="text-muted">아티스트명</span> ${esc(p.activity_name)}${p.is_artist ? ` · <a href="/clients/${p.id}"${OUT} class="text-primary hover:underline">아티스트로 보기 ↗</a>` : ""}</div>` : "",
    ownerClients.length ? `<div><span class="text-muted">대표 클라이언트</span> ${ownerClients.map((oc) => `<a href="/clients/${oc.id}"${OUT} class="text-primary hover:underline">${esc(oc.name)} ↗</a>`).join(", ")}</div>` : "",
    linkedManager
      ? `<div><span class="text-muted">담당자 연동</span> ${linkedManager.user_id != null
          ? `<span class="badge badge-info">하우스 엔지니어</span> <a href="/settings?tab=people"${OUT} class="text-primary hover:underline">${esc(linkedManager.name)} ↗</a>`
          : `<span class="badge badge-neutral">외주 작업자</span> <a href="/workers/${linkedManager.id}"${OUT} class="text-primary hover:underline">${esc(linkedManager.name)} ↗</a>`}</div>`
      : "",
  ].filter(Boolean).join("");
}

module.exports = { contactPanes, contactNameList, contactReadView, contactExtras };
