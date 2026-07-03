"use strict";

/**
 * 서버 렌더 HTML 템플릿 헬퍼. Claude 스타일(크림 + 클레이 + 세리프 제목 + 라인아이콘).
 * 공통 레이아웃 + 사이드바(데스크탑 고정) + 모바일 상단바/드로어.
 */

const fs = require("fs");
const path = require("path");
const { PROJECT_SERVICE_LABELS, ROLE_LABELS } = require("./config");

/**
 * 캐시 버스팅 버전: 배포 때마다 새로 빌드되는 정적 자산(app.css·app.js)의 mtime+size로 산출.
 * `/css/app.css?v=...`처럼 붙여, CSS가 바뀌면 브라우저가 옛 캐시 대신 새 파일을 받게 한다.
 * (함정: 캐시 버스팅이 없으면 배포해도 브라우저가 옛 CSS를 써서 레이아웃이 깨져 보인다.)
 */
const ASSET_VERSION = (() => {
  try {
    const css = fs.statSync(path.join(__dirname, "../public/css/app.css"));
    const js = fs.statSync(path.join(__dirname, "../public/js/app.js"));
    return Math.floor(Math.max(css.mtimeMs, js.mtimeMs)).toString(36) + "-" + (css.size + js.size).toString(36);
  } catch (_e) {
    return Date.now().toString(36);
  }
})();

/** XSS 방지: HTML 이스케이프. 사용자 입력은 반드시 통과시킬 것. */
function esc(s) {
  if (s == null) return "";
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** 원 단위 정수 → "₩1,234,000" */
function formatKRW(amount) {
  const n = Number(amount || 0);
  return new Intl.NumberFormat("ko-KR", { style: "currency", currency: "KRW", maximumFractionDigits: 0 }).format(n);
}

/** 사람 표시명: 주명(보조명) — 보조명이 있고 주명과 다르면 괄호 병기. 연락처=본명(활동명), 아티스트=활동명(본명). 반환은 raw(호출부 esc 필요). */
function personLabel(main, alt) {
  const m = String(main == null ? "" : main).trim();
  const a = String(alt == null ? "" : alt).trim();
  return a && a !== m ? `${m} (${a})` : m;
}

/** bytes → "12.3 MB" 사람이 읽는 크기. */
function formatBytes(bytes) {
  const n = Number(bytes || 0);
  if (n <= 0) return "—";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let i = 0;
  let v = n;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v >= 100 || i === 0 ? Math.round(v) : v.toFixed(1)} ${units[i]}`;
}

function projectServices(project) {
  if (!project || !project.services) return [];
  try {
    const parsed = JSON.parse(project.services);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .map((item) => {
        if (typeof item === "string") return { key: item, label: PROJECT_SERVICE_LABELS[item] || item };
        if (!item || typeof item !== "object") return null;
        const key = String(item.key || "").trim();
        const label = String(item.label || PROJECT_SERVICE_LABELS[key] || "").trim();
        return label ? { ...item, key, label } : null;
      })
      .filter(Boolean);
  } catch {
    return [];
  }
}

function serviceBadges(project) {
  if (project && project.track_titles) {
    const titles = String(project.track_titles)
      .split("||")
      .map((title) => title.trim())
      .filter(Boolean);
    if (titles.length) {
      return titles.map((title) => `<span class="badge bg-bg text-muted">${esc(title)}</span>`).join("");
    }
  }
  const services = projectServices(project);
  if (!services.length) return `<span class="badge bg-muted/10 text-muted">곡·콘텐츠 미정</span>`;
  return services
    .map((s) => {
      const trackTitle = String(s.track_title || "").trim();
      const label = trackTitle ? `${s.label} · ${trackTitle}` : s.label;
      return `<span class="badge bg-bg text-muted">${esc(label)}</span>`;
    })
    .join("");
}

// ── 라인 아이콘(lucide 스타일, currentColor stroke) ──
const ICONS = {
  dashboard: '<rect x="3" y="3" width="7" height="9" rx="1"/><rect x="14" y="3" width="7" height="5" rx="1"/><rect x="14" y="12" width="7" height="9" rx="1"/><rect x="3" y="16" width="7" height="5" rx="1"/>',
  projects: '<line x1="21" y1="4" x2="14" y2="4"/><line x1="10" y1="4" x2="3" y2="4"/><line x1="21" y1="12" x2="12" y2="12"/><line x1="8" y1="12" x2="3" y2="12"/><line x1="21" y1="20" x2="16" y2="20"/><line x1="12" y1="20" x2="3" y2="20"/><line x1="14" y1="2" x2="14" y2="6"/><line x1="8" y1="10" x2="8" y2="14"/><line x1="16" y1="18" x2="16" y2="22"/>',
  deliverables: '<path d="m7.5 4.27 9 5.15"/><path d="M21 8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16Z"/><path d="m3.3 7 8.7 5 8.7-5"/><path d="M12 22V12"/>',
  sessions: '<rect x="3" y="4" width="18" height="18" rx="2" ry="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/>',
  invoices: '<path d="M4 2v20l2-1 2 1 2-1 2 1 2-1 2 1 2-1 2 1V2l-2 1-2-1-2 1-2-1-2 1-2-1-2 1Z"/><path d="M16 8h-6a2 2 0 1 0 0 4h4a2 2 0 1 1 0 4H8"/><path d="M12 17.5v-11"/>',
  contacts: '<path d="M16 18a4 4 0 0 0-8 0"/><rect width="18" height="18" x="3" y="4" rx="2"/><circle cx="12" cy="10" r="2"/><line x1="8" x2="8" y1="2" y2="4"/><line x1="16" x2="16" y1="2" y2="4"/>',
  clients: '<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/>',
  workers: '<path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z"/>',
  settings: '<path d="M12 20h9"/><path d="M3 20h3"/><path d="M18 4h3"/><path d="M3 4h9"/><path d="M15 7a3 3 0 1 0 0-6 3 3 0 0 0 0 6Z"/><path d="M9 23a3 3 0 1 0 0-6 3 3 0 0 0 0 6Z"/>',
  revenue: '<path d="M3 3v18h18"/><path d="M18 17V9"/><path d="M13 17V5"/><path d="M8 17v-3"/>',
};

/** 인라인 SVG 아이콘. size=tailwind w/h 클래스(기본 20px). */
function icon(name, cls = "h-5 w-5") {
  const path = ICONS[name];
  if (!path) return "";
  return `<svg class="${cls}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${path}</svg>`;
}

// 네비게이션 단일 정의(사이드바 그룹 렌더 + navItemsFor 공유).
// access: all=전원 / editor=편집자(치프·스태프) / invoice=치프·대표 / chief=치프 전용.
// group: 사이드바 그룹 키(ops 운영 / billing 청구 / manage 관리) — navItemsFor 필터(access)와는 무관.
const NAV = [
  { href: "/", label: "대시보드", key: "dashboard", access: "all", group: "ops" },
  { href: "/projects", label: "프로젝트", key: "projects", access: "all", group: "ops" },
  { href: "/sessions", label: "일정", key: "sessions", access: "all", group: "ops" },
  { href: "/deliverables", label: "자료 전달", key: "deliverables", access: "editor", group: "ops" },
  { href: "/invoices", label: "청구", key: "invoices", access: "billing", group: "billing" },
  { href: "/contacts", label: "연락처", key: "contacts", access: "editor", group: "manage" },
  { href: "/clients", label: "클라이언트", key: "clients", access: "editor", group: "manage" },
  { href: "/workers", label: "외주 작업자", key: "workers", access: "editor", group: "billing" },
  { href: "/revenue", label: "매출", key: "revenue", access: "invoice", group: "billing" },
  { href: "/settings", label: "관리", key: "settings", access: "editor", group: "manage" },
];

// 사이드바 그룹 순서·소제목. navItemsFor 결과를 group 키로 묶어 렌더(빈 그룹은 자동 생략).
const NAV_GROUPS = [
  { key: "ops", label: "운영" },
  { key: "billing", label: "청구" },
  { key: "manage", label: "관리" },
];

function navItemsFor(user) {
  const role = user && user.role;
  const canInvoice = role === "chief" || role === "owner";
  const canBill = role === "chief" || role === "owner" || role === "staff"; // 청구서=전원(매출·정산은 invoice 유지)
  const isChief = role === "chief";
  const canEditNav = role === "chief" || role === "staff"; // 편집자(대표 제외)
  return NAV.filter((i) => {
    if (i.access === "billing") return canBill;
    if (i.access === "invoice") return canInvoice;
    if (i.access === "chief") return isChief;
    if (i.access === "editor") return canEditNav;
    return true; // all
  });
}

function sidebarLinks(user, current) {
  const items = navItemsFor(user);
  const renderLink = (i) => {
    const active = i.href === current;
    // 활성 표시 = 좌측 레일(border-l-2 border-primary). 비활성도 투명 레일로 폭을 맞춰 레이아웃 흔들림 방지.
    const cls = active
      ? "border-l-2 border-primary bg-primary/10 text-primary"
      : "border-l-2 border-transparent text-fg/70 hover:bg-surface hover:text-fg";
    return `<a href="${i.href}" class="flex items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40 ${cls}">
        ${icon(i.key, "h-[18px] w-[18px] shrink-0")}<span>${esc(i.label)}</span></a>`;
  };
  return NAV_GROUPS.map((g) => {
    const groupItems = items.filter((i) => i.group === g.key);
    if (!groupItems.length) return ""; // 권한상 빈 그룹은 소제목까지 숨김
    return `<div class="space-y-0.5">
      <div class="px-3 pb-1 text-[11px] font-medium uppercase tracking-wide text-muted">${esc(g.label)}</div>
      ${groupItems.map(renderLink).join("\n")}
    </div>`;
  })
    .filter(Boolean)
    .join("\n");
}

const WORDMARK = `<span class="font-display text-[17px] font-semibold text-fg">OMG Studios</span>`;

const FONT_LINKS = `<link rel="preconnect" href="https://fonts.googleapis.com" />
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
  <link rel="preconnect" href="https://cdn.jsdelivr.net" crossorigin />
  <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=Noto+Serif+KR:wght@500;600;700&family=Source+Serif+4:opsz,wght@8..60,400;8..60,500;8..60,600;8..60,700&display=swap" rel="stylesheet" />
  <!-- Pretendard: Inter에 없는 한글 글리프 담당(본문 한글). CSP style-src(cdn.jsdelivr.net) 허용은 server.js에서 처리. -->
  <link rel="stylesheet" href="https://cdn.jsdelivr.net/gh/orioncactus/pretendard@1.3.9/dist/web/static/pretendard-dynamic-subset.min.css" />`;

/**
 * 전체 페이지 레이아웃.
 * @param {{title:string, user?:object, current?:string, body:string, full?:boolean}} opts
 */
function layout({ title, user, current = "", body, full = false }) {
  const roleLabel = user ? (ROLE_LABELS[user.role] || user.role) : "";
  const who = user ? `${esc(user.name || user.email)} · ${roleLabel}` : "";
  return `<!doctype html>
<html lang="ko">
<head>
  <meta charset="utf-8" />
  <title>${esc(title)} · OMG Studios</title>
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <meta name="theme-color" content="#faf9f5" media="(prefers-color-scheme: light)" />
  <meta name="theme-color" content="#1e1d1b" media="(prefers-color-scheme: dark)" />
  ${FONT_LINKS}
  <link rel="stylesheet" href="/css/app.css?v=${ASSET_VERSION}" />
</head>
<body class="min-h-screen bg-bg font-sans text-fg antialiased">
  ${
    user
      ? `
  <!-- 모바일 상단바 -->
  <header class="sticky top-0 z-30 flex items-center justify-between border-b border-border bg-elevated/80 px-4 py-3 backdrop-blur sm:hidden">
    <button id="navToggle" class="btn-ghost px-3 py-1.5" aria-label="메뉴" aria-expanded="false">
      <svg class="h-5 w-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round"><line x1="3" y1="6" x2="21" y2="6"/><line x1="3" y1="12" x2="21" y2="12"/><line x1="3" y1="18" x2="21" y2="18"/></svg>
    </button>
    ${WORDMARK}
    <a href="/logout" class="text-sm text-muted hover:text-fg">로그아웃</a>
  </header>

  <div class="mx-auto flex w-full max-w-content gap-8 px-4 py-6 sm:px-6">
    <!-- 사이드바(데스크탑) / 드로어(모바일) -->
    <aside id="sidebar" class="fixed inset-y-0 left-0 z-40 hidden w-64 transform border-r border-border bg-elevated p-4 transition sm:static sm:z-0 sm:block sm:w-56 sm:translate-x-0 sm:border-0 sm:bg-transparent sm:p-0">
      <!-- 모바일 드로어 헤더: 로고 + 닫기(X) 버튼 -->
      <div class="mb-4 flex items-center justify-between sm:hidden">
        ${WORDMARK}
        <button id="navDrawerClose" class="rounded-lg p-1.5 text-muted hover:bg-surface hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40" aria-label="닫기">
          <svg class="h-5 w-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
        </button>
      </div>
      <div class="mb-7 hidden items-center gap-2 px-2 sm:flex">${WORDMARK}</div>
      <nav class="space-y-6">
        ${sidebarLinks(user, current)}
      </nav>
      <div class="mt-8 hidden border-t border-border pt-4 text-xs text-muted sm:block">
        <div class="mb-2 px-2">${who}</div>
        <!-- 테마 토글: 마크업만(아이콘+라벨). 토글 로직=app.js([data-theme-toggle]), 다크 분기=src.css. CSP-safe(인라인 onclick 없음). -->
        <button type="button" data-theme-toggle aria-label="테마 전환" class="mb-2 flex w-full items-center gap-2 rounded-lg px-2 py-1.5 font-medium text-muted transition-colors hover:bg-surface hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40">
          <svg class="h-4 w-4 shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M12 3a9 9 0 0 0 0 18Z" fill="currentColor" stroke="none"/></svg>
          <span data-theme-label>테마</span>
        </button>
        <a href="/logout" class="px-2 text-primary hover:underline">로그아웃</a>
      </div>
    </aside>
    <div id="backdrop" class="fixed inset-0 z-30 hidden bg-black/30 sm:hidden"></div>

    <main class="min-w-0 flex-1 ${full ? "" : "max-w-3xl"}">
      ${body}
    </main>
  </div>
  <script src="/js/app.js?v=${ASSET_VERSION}" defer></script>
  `
      : `<main class="mx-auto w-full max-w-md px-4 py-12">${body}</main>`
  }
</body>
</html>`;
}

// 저장/변경 후 플래시 배너(?flash=키). public/js/app.js가 잠시 뒤 숨기고 URL에서 파라미터를 제거.
const FLASH_MESSAGES = {
  saved: "저장되었습니다.",
  created: "생성되었습니다.",
  added: "추가되었습니다.",
  deleted: "삭제되었습니다.",
  paid: "입금이 반영되었습니다.",
  tested: "테스트 알림을 보냈습니다 — 채널을 확인하세요.",
  last_chief: "치프 엔지니어는 최소 1명 있어야 합니다 — 마지막 치프는 스태프·대표로 바꿀 수 없습니다.",
  drive_done: "로컬 파일을 Google Drive로 이관했습니다.",
  drive_partial: "일부 파일을 Drive로 이관했습니다 — 실패분은 로컬에 남아 있습니다(로그 확인).",
  drive_unlinked: "구글 Drive 연동이 필요합니다 — 구글 계정 연동 후 다시 시도하세요.",
  added_cal_off: "추가됨 · 구글 캘린더 자동 연동 안 됨 (관리 › 환경설정 › 스튜디오 캘린더 확인)",
  saved_cal_off: "저장됨 · 구글 캘린더 자동 연동 안 됨 (관리 › 환경설정 › 스튜디오 캘린더 확인)",
};
const FLASH_WARN = new Set(["last_chief", "drive_partial", "drive_unlinked", "added_cal_off", "saved_cal_off"]);
function flashBanner(query) {
  const key = query && query.flash;
  const msg = FLASH_MESSAGES[key];
  if (!msg) return "";
  const warn = FLASH_WARN.has(key);
  const tone = warn ? "border-warning/40 text-warning" : "border-success/40 text-success";
  // 토스트: fixed로 띄워 레이아웃을 밀지 않음(내용이 밀렸다 돌아오는 현상 방지). app.js가 잠시 후 페이드아웃·클릭 시 닫기. bg-bg로 불투명.
  return `<div data-flash data-flash-warn="${warn ? "1" : ""}" role="status" aria-live="polite"
    class="fixed left-1/2 top-4 z-50 max-w-[90vw] -translate-x-1/2 rounded-lg border ${tone} bg-bg px-4 py-2.5 text-sm font-medium shadow-lg transition-opacity duration-300">${esc(msg)}</div>`;
}

/** 스타일이 적용된 에러 페이지(404/403/500 등). raw 텍스트 대신 일관된 화면. */
function errorPage({ code = 500, title = "오류가 발생했습니다", message = "", user = null } = {}) {
  const body = `
    <div class="mx-auto max-w-md py-16 text-center">
      <div class="font-display text-6xl font-bold text-muted/50">${esc(String(code))}</div>
      <h1 class="mt-4 font-display text-xl font-semibold">${esc(title)}</h1>
      ${message ? `<p class="mt-2 text-sm text-muted">${esc(message)}</p>` : ""}
      <div class="mt-6 flex justify-center gap-2">
        <a href="${user ? "/" : "/login"}" class="btn-primary">${user ? "홈으로" : "로그인"}</a>
      </div>
    </div>`;
  return layout({ title: `${code} · ${title}`, user, body });
}

/** 페이지 헤더(세리프 제목 + 설명 + 우측 액션). 이모지 없이 깔끔하게. */
function pageHeader({ title, desc = "", action = "", back = null }) {
  // back={href,label}: 상세 페이지에서 목록으로 돌아가는 링크(제목 위).
  const backLink = back
    ? `<a href="${esc(back.href)}" class="mb-3 inline-flex items-center gap-1.5 rounded text-base font-medium text-muted transition-colors hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40">
        <svg class="h-5 w-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m15 18-6-6 6-6"/></svg>${esc(back.label || "목록")}</a>`
    : "";
  return `<div class="mb-6 flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
    <div>
      ${backLink}
      <h1 class="font-display text-2xl font-semibold text-fg">${esc(title)}</h1>
      ${desc ? `<p class="mt-1 text-sm text-muted">${esc(desc)}</p>` : ""}
    </div>
    ${action ? `<div class="shrink-0">${action}</div>` : ""}
  </div>`;
}

/**
 * 빈 상태 표시(목록·섹션 공통). 정렬·여백을 한 곳에서 통일.
 * @param {string} inner 이미 빌드된 HTML(동적값은 호출부에서 esc). 보통 "···가 없습니다." + 선택적 링크.
 * @param {{card?:boolean, icon?:string, cta?:{href:string,label?:string}}} opts
 *   card=true면 카드로 감싼 페이지 상단 목록용, 아니면 섹션 내부용(여백 작게).
 *   icon=ICONS 키(연한 라인아이콘을 위에 표시), cta={href,label}=아래 강조 링크(btn-primary). 둘 다 선택.
 */
function emptyState(inner, { card = false, icon: iconName = "", cta = null } = {}) {
  const cls = card ? "card py-12 text-center text-sm text-muted" : "py-8 text-center text-sm text-muted";
  const iconHtml =
    iconName && ICONS[iconName]
      ? `<div class="mb-3 flex justify-center text-muted/40">${icon(iconName, "h-10 w-10")}</div>`
      : "";
  const ctaHtml =
    cta && cta.href
      ? `<div class="mt-4 flex justify-center"><a href="${esc(cta.href)}" class="btn-primary">${esc(cta.label || "")}</a></div>`
      : "";
  return `<div class="${cls}">${iconHtml}${inner}${ctaHtml}</div>`;
}

/** 접기 토글 chevron — `<details class="group">` 안 summary 우측에. 펼치면 180° 회전(group-open). */
function detailsChevron() {
  return `<svg class="h-4 w-4 shrink-0 text-muted transition-transform group-open:rotate-180" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M6 8l4 4 4-4" /></svg>`;
}

/**
 * 접이식 '설명' 블록 — 긴 안내/항목 설명을 기본 접힘으로(화면을 짧게). 네이티브 `<details>`(무JS·CSP 안전).
 * `content`는 이미 빌드된 HTML 조각(동적 값 포함 가능). 상태·오류·권한 문구가 아니라 '어떻게 동작하는지' 설명에만 쓴다.
 * @param {string} content HTML 조각. @param {{label?:string, cls?:string}} opts label=요약 라벨(기본 '설명').
 */
function explain(content, { label = "설명", cls = "mt-1" } = {}) {
  if (!content) return "";
  return `<details class="group ${cls} text-xs text-muted">
    <summary class="inline-flex w-fit cursor-pointer list-none items-center gap-1 rounded text-primary/70 hover:text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40">${esc(label)}<svg class="h-3 w-3 shrink-0 transition-transform group-open:rotate-180" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M6 8l4 4 4-4" /></svg></summary>
    <div class="mt-1 leading-relaxed">${content}</div>
  </details>`;
}

/**
 * 프로젝트 유형 배지 HTML.
 * @param {string} type "session" | "task" | 기타
 * @returns {string} HTML — .badge-primary(세션) | .badge-neutral(작업/미정)
 */
function projectTypeBadge(type) {
  if (type === "session") return `<span class="badge-primary">${esc("세션")}</span>`;
  if (type === "task") return `<span class="badge-neutral">${esc("작업")}</span>`;
  return `<span class="badge-neutral">${esc(type || "미정")}</span>`;
}

/**
 * 상세 페이지 밑줄 탭 바.
 * @param {{tabs:Array<{key:string,label:string}>, activeKey:string, hrefFn:(key:string)=>string}} opts
 * @returns {string} HTML — `<div class="mb-6 flex gap-1 border-b border-border">...</div>`
 */
function tabBar({ tabs, activeKey, hrefFn }) {
  const items = tabs
    .map(({ key, label }) => {
      const active = key === activeKey;
      const cls = active
        ? "border-b-2 border-primary font-semibold text-fg"
        : "border-b-2 border-transparent text-muted hover:border-border hover:text-fg";
      const ariaCurrent = active ? ' aria-current="page"' : "";
      return `<a href="${esc(hrefFn(key))}" class="px-4 py-2 text-sm transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40 ${cls}"${ariaCurrent}>${esc(label)}</a>`;
    })
    .join("");
  return `<div class="mb-6 flex gap-1 overflow-x-auto border-b border-border">${items}</div>`;
}

/**
 * 목록 페이지 필터 알약칩 그룹.
 * @param {{chips:Array<{key:string,label:string}>, activeKey:string, hrefFn:(key:string)=>string}} opts
 * @returns {string} HTML — `<div class="mb-4 flex flex-wrap gap-2">...</div>`
 */
function filterChips({ chips, activeKey, hrefFn }) {
  const items = chips
    .map(({ key, label }) => {
      const active = key === activeKey;
      const cls = active
        ? "badge-primary"
        : "badge-neutral hover:bg-primary/10 hover:text-primary transition-colors";
      const ariaCurrent = active ? ' aria-current="true"' : "";
      return `<a href="${esc(hrefFn(key))}" class="${cls} focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40"${ariaCurrent}>${esc(label)}</a>`;
    })
    .join("");
  return `<div class="mb-4 flex flex-wrap gap-2">${items}</div>`;
}

/**
 * 목록 그룹 컨테이너: 단일 `.card` 안에 구분선(divide-y)으로 나뉜 행 묶음.
 * `listRow`로 만든 행들을 받아 프로젝트·청구 등 목록을 통일된 카드형 리스트로 렌더한다.
 * @param {{rows:(string[]|string)}} opts rows=이미 빌드된 행 HTML 배열 또는 문자열(보통 listRow 결과).
 * @returns {string} HTML — `.card`(패딩 제거·모서리 클립) + `divide-y divide-border` 컨테이너.
 */
function listGroup({ rows }) {
  const inner = Array.isArray(rows) ? rows.join("") : rows || "";
  return `<div class="card overflow-hidden p-0"><div class="divide-y divide-border">${inner}</div></div>`;
}

/**
 * 목록 행: 좌(주요 내용)·우(메타/금액) 2단 + 호버 강조. href가 있으면 링크 행, 없으면 정적 행.
 * `listGroup`과 함께 쓴다. 동적 텍스트는 호출부에서 esc 처리한 HTML을 left/right로 넘길 것.
 * @param {{href?:string, left:string, right?:string}} opts left/right=이미 빌드된 HTML 조각.
 * @returns {string} HTML — `px-4 py-3` 행(링크면 `<a>`, 아니면 `<div>`).
 */
function listRow({ href, left, right = "" }) {
  const inner = `<div class="flex items-center justify-between gap-4 px-4 py-3">
      <div class="min-w-0">${left}</div>
      ${right ? `<div class="shrink-0 text-right">${right}</div>` : ""}
    </div>`;
  if (href) {
    return `<a href="${esc(href)}" class="block transition-colors hover:bg-surface focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40">${inner}</a>`;
  }
  return `<div class="transition-colors hover:bg-surface">${inner}</div>`;
}

/**
 * 목록 행(제목만 링크): 행 전체가 아니라 **제목(이름)만** 상세 링크 → 우측 정보(이메일·전화·사업자 등)를
 * 드래그·복사해도 상세로 들어가지 않는다. title/badges/right는 이미 빌드된 HTML(호출부에서 esc).
 * @param {{href:string, title:string, badges?:string, right?:string}} opts
 */
function listRowLinked({ href, title, badges = "", right = "" }) {
  return `<div class="flex items-start justify-between gap-4 px-4 py-3">
      <div class="min-w-0">
        <a href="${esc(href)}" class="inline-block max-w-full truncate align-bottom font-semibold hover:text-primary hover:underline focus-visible:outline-none focus-visible:rounded focus-visible:ring-2 focus-visible:ring-primary/40">${title}</a>
        ${badges ? `<div class="mt-1 flex flex-wrap gap-1">${badges}</div>` : ""}
      </div>
      ${right ? `<div class="shrink-0 text-right">${right}</div>` : ""}
    </div>`;
}

/**
 * 사람(연락처) 검색 콤보 — 통일 UX(검색 + 선택 시 닫힘 + 새로 등록 모달 + 선택 정보 표시).
 * 프로젝트 고객측 담당자·세션 디렉터(동적 다중 행)·클라이언트 담당자 공용. CSP-safe(app.js [data-person-combo]).
 * @param {object} o
 * @param {string} [o.idField=contact_id] hidden id 입력 name(director_contact_id 등)
 * @param {string} [o.nameField=contact_name] 텍스트 입력 name(director_name 등)
 * @param {number|null} [o.selectedId] 현재 선택 party id
 * @param {Array} [o.options] [{id,name,phone,email,current_client|company}]
 * @param {boolean} [o.compact] 인라인(디렉터 다중 행)용 — 작게
 * @param {string} [o.placeholder]
 */
function personCombo({ idField = "contact_id", nameField = "contact_name", selectedId = null, options = [], compact = false, placeholder = "담당자 — 검색 또는 새로 등록", optionsRef = "", companyOptions = [], entityLabel = "담당자" } = {}) {
  const sel = selectedId ? options.find((o) => Number(o.id) === Number(selectedId)) : null;
  // 모달 '회사' 입력 autocomplete용 datalist(기존 클라이언트 검색 → 오타·중복 방지). 유니크 id로 중복 방지.
  const coListId = companyOptions && companyOptions.length ? "pcco_" + Math.random().toString(36).slice(2, 9) : "";
  const companyDatalist = coListId ? `<datalist id="${coListId}">${companyOptions.map((c) => `<option value="${esc(c.name || c)}"></option>`).join("")}</datalist>` : "";
  // optionsRef 지정 시 옵션 JSON을 인라인 임베드하지 않고 페이지의 공유 스크립트(id=optionsRef)를 참조 →
  // 같은 옵션(연락처 목록)을 쓰는 콤보가 여러 개인 폼(세션 디렉터 다중 행 등)에서 중복 임베드 제거(페이지 축소).
  const inlineJson = optionsRef ? "" : `<script type="application/json" data-pc-options>${JSON.stringify(options.map((o) => ({ id: o.id, name: o.name, phone: o.phone || "", email: o.email || "", company: o.current_client || o.company || "", group: o.group_name || o.group || "" }))).replace(/</g, "\\u003c")}</script>`;
  const inputCls = compact ? "input py-1.5 pr-9 text-sm" : "input pr-9";
  const rootCls = compact ? " class=\"min-w-0 flex-1\"" : "";
  return `
    <div data-person-combo${rootCls}${optionsRef ? ` data-pc-options-ref="${esc(optionsRef)}"` : ""} data-pc-entity="${esc(entityLabel)}">
      <input type="hidden" name="${idField}" value="${sel ? sel.id : ""}" data-pc-id />
      <input type="hidden" name="${nameField}" value="${sel ? esc(sel.name) : ""}" data-pc-name-hidden />
      <div class="relative">
        <!-- 보이는 검색칸은 name 없음(Chrome 자동완성 팝업이 앱 드롭다운을 덮는 것 방지) — 값은 위 숨김 필드로 제출, app.js가 동기화 -->
        <input class="${inputCls}" type="text" value="${sel ? esc(sel.name) : ""}" data-pc-input autocomplete="off"
          role="combobox" aria-expanded="false" aria-autocomplete="list" placeholder="${esc(placeholder)}" />
        <svg class="pointer-events-none absolute right-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M6 8l4 4 4-4" /></svg>
        <div class="absolute left-0 right-0 z-30 mt-1 hidden max-h-64 overflow-auto rounded-lg border border-border bg-surface py-1 shadow-lg" data-pc-pop role="listbox"></div>
      </div>
      <div class="mt-1.5 hidden ${compact ? "text-xs" : "text-sm"} text-muted" data-pc-info></div>
      ${inlineJson}
      <div data-pc-modal class="fixed inset-0 z-50 hidden items-center justify-center bg-black/40 p-4">
        <div class="w-full max-w-sm space-y-3 rounded-xl border border-border bg-bg p-4 shadow-xl" role="dialog" aria-modal="true">
          <div class="font-display text-lg font-semibold">새 ${esc(entityLabel)} 등록</div>
          <div><label class="label">이름</label><input class="input" data-pc-name placeholder="${esc(entityLabel)} 이름" /></div>
          <div class="grid gap-3 sm:grid-cols-2">
            <div><label class="label">전화</label><input class="input" data-pc-phone autocomplete="off" /></div>
            <div><label class="label">이메일</label><input class="input" type="email" data-pc-email autocomplete="off" /></div>
          </div>
          <div class="grid gap-3 sm:grid-cols-2">
            <div><label class="label">회사</label><input class="input" data-pc-company autocomplete="off"${coListId ? ` list="${coListId}" placeholder="기존 클라이언트 검색"` : ""} />${companyDatalist}</div>
            <div><label class="label">직책</label><input class="input" data-pc-job autocomplete="off" /></div>
          </div>
          <div class="flex items-center gap-2 pt-1">
            <button type="button" class="btn-primary" data-pc-save>등록</button>
            <button type="button" class="btn-ghost" data-pc-cancel>취소</button>
            <span class="ml-1 hidden text-xs text-danger" data-pc-err></span>
          </div>
        </div>
      </div>
    </div>`;
}

/** personCombo 공유 옵션 스크립트 — 같은 옵션을 여러 콤보가 optionsRef로 참조(중복 임베드 제거). 페이지당 1회 렌더. */
function personComboOptionsScript(id, options) {
  const jopts = (options || []).map((o) => ({ id: o.id, name: o.name, phone: o.phone || "", email: o.email || "", company: o.current_client || o.company || "", group: o.group_name || o.group || "" }));
  return `<script type="application/json" id="${esc(id)}" data-pc-shared-options>${JSON.stringify(jopts).replace(/</g, "\\u003c")}</script>`;
}

/**
 * 청구처(payer) 검색 콤보 — 클라이언트(업체/아티스트) + 담당자(연락처)를 함께 검색, 선택 시 닫힘.
 * 다른 콤보와 동일 UX(커스텀 팝업). 단 '새로 등록'은 없음(청구처는 기존에서 고름). 선택 시 client_id 또는
 * payer_contact_id 하나만 세팅(다른 쪽 클리어). 비워 두면 서버 자동 매칭. CSP-safe(app.js [data-picker-combo]).
 * @param {object} o
 * @param {number|null} [o.selectedId] 현재 청구처 party id(클라이언트)
 * @param {Array} [o.clientOptions] [{id,name,kind}]
 * @param {Array} [o.contactOptions] [{id,name,current_client,phone}]
 * @param {string} [o.hint] explain 안내문(생략 시 기본)
 */
function payerCombo({ selectedId = null, clientOptions = [], contactOptions = [], hint = "", taxInfoIds = [], cashReceiptIds = [] } = {}) {
  const sel = selectedId ? clientOptions.find((c) => Number(c.id) === Number(selectedId)) : null;
  // 청구처 유형(co=회사 여부)·발행 정보 누락 경고(warn) — 회사=세금계산서 정보(사업자등록번호), 개인=현금영수증. app.js가 라벨·경고·차단 처리.
  const taxSet = new Set((taxInfoIds || []).map(Number));
  const cashSet = new Set((cashReceiptIds || []).map(Number));
  const CO_WARN = "세금계산서 정보(사업자등록번호)가 없습니다.";
  const PS_WARN = "현금영수증 정보가 없습니다.";
  // 아티스트(개인)는 clientOptions(is_artist)에도, contactOptions(kind=person)에도 들어가 같은 party가 콤보에 두 번 뜬다 →
  // 이미 클라이언트로 노출된 사람은 담당자 중복 제외(중복 제거). 둘 다 같은 party.id라 청구처 결과는 동일.
  const clientIds = new Set(clientOptions.map((c) => Number(c.id)));
  const kindLabel = (k) => (k === "company" ? "업체" : k === "group" ? "그룹" : "아티스트"); // 내부 kind(person 등) 대신 우리 용어. person client=아티스트
  const items = [
    ...clientOptions.map((c) => {
      const co = c.kind === "company" ? 1 : 0;
      const warn = co ? (taxSet.has(Number(c.id)) ? "" : CO_WARN) : (cashSet.has(Number(c.id)) ? "" : PS_WARN);
      const aff = [c.group_name, c.current_client].filter(Boolean).join(" · "); // 소속 그룹·회사로 식별
      const sub = kindLabel(c.kind) + (aff ? " · " + aff : "");
      return { label: c.name, sub, cid: c.id, pid: 0, co, warn };
    }),
    ...contactOptions.filter((o) => !clientIds.has(Number(o.id))).map((o) => {
      const aff = [o.group_name, o.current_client].filter(Boolean).join(" · "); // 소속 그룹·회사로 식별
      return { label: o.name, sub: "담당자" + (aff ? " · " + aff : o.phone ? " · " + o.phone : ""), cid: 0, pid: o.id, co: 0, warn: cashSet.has(Number(o.id)) ? "" : PS_WARN };
    }),
  ];
  const json = JSON.stringify(items).replace(/</g, "\\u003c");
  // 미리 선택된 입력칸 값도 드롭다운 항목과 동일 형식(우리 용어 + 소속)으로 — raw kind('person') 노출 방지.
  const selItem = sel ? items.find((it) => Number(it.cid) === Number(sel.id)) : null;
  const selLabel = selItem ? (selItem.sub ? `${selItem.label} · ${selItem.sub}` : selItem.label) : "";
  return `
    <div data-picker-combo>
      <input type="hidden" name="client_id" value="${sel ? sel.id : ""}" data-pk-cid />
      <input type="hidden" name="payer_contact_id" value="" data-pk-pid />
      <div class="relative">
        <input class="input pr-9" type="text" data-pk-input autocomplete="off" role="combobox" aria-expanded="false" aria-autocomplete="list"
          placeholder="클라이언트·담당자 검색…" value="${esc(selLabel)}" aria-label="청구처 검색" />
        <svg class="pointer-events-none absolute right-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M6 8l4 4 4-4" /></svg>
        <div class="absolute left-0 right-0 z-30 mt-1 hidden max-h-64 overflow-auto rounded-lg border border-border bg-surface py-1 shadow-lg" data-pk-pop role="listbox"></div>
      </div>
      <script type="application/json" data-pk-options>${json}</script>
      ${explain(hint || `클라이언트·담당자 이름 일부만 입력해도 좁혀집니다. 담당자를 고르면 개인 청구처로 등록됩니다. 비워 두면 자동 연결.`)}
    </div>`;
}

/**
 * 클릭 복사 값 — 전화·이메일·주소·사업자번호 등 식별 정보. 클릭 시 클립보드 복사 + '복사되었습니다' 토스트(app.js [data-copy]).
 * 내부 도구라 tel:/mailto: 링크 대신 복사가 더 유용. 작은 복사 아이콘으로 복사 가능 표시. CSP-safe.
 * @param {string} value 복사될 값(표시값과 동일, display 지정 시 표시만 다름)
 * @param {{cls?:string, display?:string}} [opts]
 */
function copyable(value, { cls = "", display = "" } = {}) {
  if (value == null || value === "") return "";
  const v = esc(String(value));
  const shown = display ? esc(String(display)) : v;
  // 아이콘 없이 값만 — 클릭 시 복사(hover 밑줄로 복사 가능 암시, title 툴팁). app.js [data-copy].
  return `<button type="button" data-copy="${v}" class="rounded text-left hover:text-primary hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40 ${cls}" title="클릭하면 복사됩니다">${shown}</button>`;
}

module.exports = { esc, formatKRW, personLabel, formatBytes, projectServices, serviceBadges, icon, layout, pageHeader, emptyState, errorPage, flashBanner, navItemsFor, NAV, detailsChevron, explain, projectTypeBadge, tabBar, filterChips, listGroup, listRow, listRowLinked, personCombo, personComboOptionsScript, payerCombo, copyable };
