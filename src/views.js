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
  clients: '<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/>',
  workers: '<path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z"/>',
  settings: '<path d="M12 20h9"/><path d="M3 20h3"/><path d="M18 4h3"/><path d="M3 4h9"/><path d="M15 7a3 3 0 1 0 0-6 3 3 0 0 0 0 6Z"/><path d="M9 23a3 3 0 1 0 0-6 3 3 0 0 0 0 6Z"/>',
};

/** 인라인 SVG 아이콘. size=tailwind w/h 클래스(기본 20px). */
function icon(name, cls = "h-5 w-5") {
  const path = ICONS[name];
  if (!path) return "";
  return `<svg class="${cls}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${path}</svg>`;
}

// 네비게이션 단일 정의(사이드바 + 대시보드 공유).
// access: all=전원 / invoice=치프·대표 / chief=치프 전용.
const NAV = [
  { href: "/", label: "대시보드", key: "dashboard", access: "all" },
  { href: "/projects", label: "프로젝트", key: "projects", access: "all" },
  { href: "/sessions", label: "일정", key: "sessions", access: "all" },
  { href: "/deliverables", label: "자료 전달", key: "deliverables", access: "editor" },
  { href: "/invoices", label: "청구", key: "invoices", access: "invoice" },
  { href: "/clients", label: "클라이언트", key: "clients", access: "chief" },
  { href: "/workers", label: "외주 작업자", key: "workers", access: "invoice" },
  { href: "/settings", label: "관리", key: "settings", access: "chief" },
];

function navItemsFor(user) {
  const role = user && user.role;
  const canInvoice = role === "chief" || role === "owner";
  const isChief = role === "chief";
  const canEditNav = role === "chief" || role === "staff"; // 편집자(대표 제외)
  return NAV.filter((i) => {
    if (i.access === "invoice") return canInvoice;
    if (i.access === "chief") return isChief;
    if (i.access === "editor") return canEditNav;
    return true; // all
  });
}

function sidebarLinks(user, current) {
  return navItemsFor(user)
    .map((i) => {
      const active = i.href === current;
      const cls = active
        ? "bg-primary/12 text-primary"
        : "text-fg/70 hover:bg-surface hover:text-fg";
      return `<a href="${i.href}" class="flex items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40 ${cls}">
        ${icon(i.key, "h-[18px] w-[18px] shrink-0")}<span>${esc(i.label)}</span></a>`;
    })
    .join("\n");
}

const WORDMARK = `<span class="font-display text-[17px] font-semibold text-fg">OMG Studios</span>`;

const FONT_LINKS = `<link rel="preconnect" href="https://fonts.googleapis.com" />
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
  <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=Noto+Serif+KR:wght@500;600;700&family=Source+Serif+4:opsz,wght@8..60,400;8..60,500;8..60,600;8..60,700&display=swap" rel="stylesheet" />`;

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
      <nav class="space-y-0.5">
        ${sidebarLinks(user, current)}
      </nav>
      <div class="mt-8 hidden border-t border-border pt-4 text-xs text-muted sm:block">
        <div class="mb-2 px-2">${who}</div>
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
};
function flashBanner(query) {
  const msg = query && FLASH_MESSAGES[query.flash];
  if (!msg) return "";
  return `<div data-flash class="mb-4 rounded-lg border border-success/30 bg-success/10 px-4 py-2 text-sm font-medium text-success">${esc(msg)}</div>`;
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
function pageHeader({ title, desc = "", action = "" }) {
  return `<div class="mb-6 flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
    <div>
      <h1 class="font-display text-2xl font-semibold text-fg">${esc(title)}</h1>
      ${desc ? `<p class="mt-1 text-sm text-muted">${esc(desc)}</p>` : ""}
    </div>
    ${action ? `<div class="shrink-0">${action}</div>` : ""}
  </div>`;
}

/**
 * 빈 상태 표시(목록·섹션 공통). 정렬·여백을 한 곳에서 통일.
 * @param {string} inner 이미 빌드된 HTML(동적값은 호출부에서 esc). 보통 "···가 없습니다." + 선택적 링크.
 * @param {{card?:boolean}} opts card=true면 카드로 감싼 페이지 상단 목록용, 아니면 섹션 내부용(여백 작게).
 */
function emptyState(inner, { card = false } = {}) {
  const cls = card ? "card py-12 text-center text-sm text-muted" : "py-8 text-center text-sm text-muted";
  return `<div class="${cls}">${inner}</div>`;
}

/** 접기 토글 chevron — `<details class="group">` 안 summary 우측에. 펼치면 180° 회전(group-open). */
function detailsChevron() {
  return `<svg class="h-4 w-4 shrink-0 text-muted transition-transform group-open:rotate-180" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M6 8l4 4 4-4" /></svg>`;
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

module.exports = { esc, formatKRW, formatBytes, projectServices, serviceBadges, icon, layout, pageHeader, emptyState, errorPage, flashBanner, navItemsFor, NAV, detailsChevron, projectTypeBadge, tabBar, filterChips };
