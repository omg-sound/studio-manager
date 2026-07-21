"use strict";

// 전역 통합 검색(2026-07-21) — 드롭다운 typeahead(`/search/suggest`) + 전체 결과 페이지(`/search`).
// 집계는 data/search.searchAll, 매핑({label,sub,href})은 여기서(뷰 헬퍼 personName/personLabel 필요).
// 스펙: docs/superpowers/specs/2026-07-21-global-search-design.md.
const express = require("express");
const { requireAuth } = require("../auth");
const { searchAll } = require("../data");
const { layout, pageHeader, emptyState, esc, personName, personLabel } = require("../views");

const router = express.Router();

// 카테고리별 행 → {label, sub, href}. 각 suggest 라우트의 기존 매핑과 동일 규약.
function toItem(key, row) {
  if (key === "projects") {
    return { label: row.title, sub: [row.artist, row.production_company || row.artist_company].filter(Boolean).join(" · "), href: `/projects/${row.id}` };
  }
  if (key === "contacts") {
    return { label: personName(row), sub: row.phone || "", href: `/contacts/${row.id}` };
  }
  if (key === "clients") {
    const label = row.is_artist && row.kind === "person" ? personLabel(row.activity_name || row.name, row.name) : row.name;
    const sub = row.kind === "company" ? "업체" : row.kind === "group" ? "그룹" : row.is_artist ? "아티스트" : "";
    return { label, sub, href: `/clients/${row.id}` };
  }
  if (key === "invoices") {
    return { label: row.invoice_number || row.title, sub: [row.client_name, row.tax_status].filter(Boolean).join(" · "), href: `/invoices/${row.id}` };
  }
  // sessions
  return { label: row.project_title || row.session_type, sub: [row.session_date, row.session_type, row.engineer_name].filter(Boolean).join(" · "), href: `/projects/${row.project_id}?tab=sessions` };
}

// 드롭다운 typeahead — 평면 [{cat,label,sub,href}](카테고리 있는 그룹만). app.js가 cat 바뀌는 곳에 헤더 삽입.
router.get("/suggest", requireAuth, (req, res) => {
  const q = String(req.query.q || "").trim();
  if (!q) return res.json([]);
  const out = [];
  for (const g of searchAll(req.user, q, 5)) {
    for (const row of g.rows) out.push({ cat: g.cat, ...toItem(g.key, row) });
  }
  res.json(out);
});

// 전체 결과 페이지 — 카테고리별 상위 20, 섹션 렌더. 매칭 0 카테고리는 생략.
router.get("/", requireAuth, (req, res) => {
  const q = String(req.query.q || "").trim();
  const groups = q ? searchAll(req.user, q, 20).filter((g) => g.rows.length) : [];
  const total = groups.reduce((n, g) => n + g.rows.length, 0);

  const section = (g) => `
    <section class="mb-5">
      <h2 class="mb-2 flex items-baseline gap-2 font-display text-sm font-semibold text-muted">
        ${esc(g.cat)}<span class="text-xs font-normal">${g.rows.length}</span>
      </h2>
      <div class="card divide-y divide-border/60 p-0">
        ${g.rows.map((row) => {
          const it = toItem(g.key, row);
          return `<a href="${esc(it.href)}" class="row-link flex items-center justify-between gap-3 px-4 py-2.5">
            <span class="min-w-0 truncate text-sm font-medium">${esc(it.label || "")}</span>
            ${it.sub ? `<span class="shrink-0 truncate text-xs text-muted">${esc(it.sub)}</span>` : ""}
          </a>`;
        }).join("")}
      </div>
    </section>`;

  const body = `
    ${pageHeader({ title: q ? `검색: ${q}` : "검색", back: "/" })}
    ${!q
      ? emptyState("검색어를 입력하세요.", { icon: "search" })
      : total === 0
        ? emptyState(`'${q}'에 대한 결과가 없습니다.`, { icon: "search" })
        : groups.map(section).join("")}`;
  res.send(layout({ title: q ? `검색: ${q}` : "검색", user: req.user, current: "", body, wide: true }));
});

module.exports = router;
