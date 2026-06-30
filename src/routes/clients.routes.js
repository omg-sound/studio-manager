"use strict";

const express = require("express");
const { db } = require("../db");
const { requireChief } = require("../auth");
const { CLIENT_KINDS, normalizeClientKind } = require("../config");
const { listClients, clientKindCounts, getClient, listProjectsForClient, listInvoicesForClientEntity, listContactsForClient } = require("../data");
const { layout, pageHeader, esc, flashBanner, emptyState, formatKRW, errorPage, tabBar, filterChips, projectTypeBadge, listGroup, listRow } = require("../views");
const { invoiceRow } = require("../views.invoices");

const router = express.Router();

// 모든 클라이언트 라우트는 치프 전용
router.use(requireChief);

// ── 목록(탭 = 분류 필터 + 이름 검색) ──
router.get("/", (req, res) => {
  const TAB_KINDS = ["아티스트", "소속사/레이블", "제작사"]; // "기타"는 전체에만 포함
  const activeKind = TAB_KINDS.includes(req.query.kind) ? req.query.kind : "";
  const q = String(req.query.q || "").trim();
  const rows = listClients(activeKind ? { kind: activeKind } : {});
  const counts = clientKindCounts();
  const total = Object.values(counts).reduce((a, b) => a + b, 0);

  // 라우트 레벨 이름 필터(data.js 수정 없이)
  const ql = q.toLowerCase();
  const displayed = q ? rows.filter((c) => c.name.toLowerCase().includes(ql)) : rows;

  const kindChips = filterChips({
    chips: [{ key: "", label: `전체목록 ${total}` }, ...TAB_KINDS.map((k) => ({ key: k, label: `${k} ${counts[k] || 0}` }))],
    activeKey: activeKind,
    hrefFn: (key) => {
      const base = key ? "/clients?kind=" + encodeURIComponent(key) : "/clients";
      return q ? base + "&q=" + encodeURIComponent(q) : base;
    },
  });

  const searchBar = `
    <form method="get" action="/clients" class="mb-4 flex gap-2">
      ${activeKind ? `<input type="hidden" name="kind" value="${esc(activeKind)}" />` : ""}
      <input class="input min-w-0 flex-1" type="search" name="q" value="${esc(q)}" placeholder="이름 검색" />
      <button class="btn-primary shrink-0" type="submit">검색</button>
    </form>`;

  const resultNote = q
    ? `<div class="mb-3 text-sm text-muted">"${esc(q)}" 결과 ${displayed.length}건 · <a href="/clients${activeKind ? "?kind=" + encodeURIComponent(activeKind) : ""}" class="text-primary hover:underline">전체 보기</a></div>`
    : "";

  const list = displayed.length
    ? displayed
        .map((c) => {
          const taxLine = [c.biz_no ? "사업자 " + esc(c.biz_no) : "", c.owner_name ? "대표 " + esc(c.owner_name) : ""].filter(Boolean).join(" · ");
          return `
      <div class="card mb-3 row-link">
        <div class="flex items-start justify-between gap-3">
          <a href="/clients/${c.id}" class="min-w-0">
            <div class="flex items-center gap-2">
              <span class="badge-neutral">${esc(c.kind)}</span>
              <span class="font-semibold">${esc(c.name)}</span>
            </div>
            ${taxLine ? `<div class="mt-1 text-xs text-muted">${taxLine}</div>` : ""}
            <div class="mt-0.5 text-sm text-muted">
              ${esc(c.email || "이메일 없음")}${c.phone ? " · " + esc(c.phone) : ""}
            </div>
          </a>
          <a href="/clients/${c.id}/edit" class="btn-ghost shrink-0 btn-xs">수정</a>
        </div>
      </div>`;
        })
        .join("")
    : q
      ? emptyState(`"${esc(q)}" 검색 결과가 없습니다.`, { card: true, icon: "clients" })
      : emptyState(activeKind ? esc(activeKind) + " 분류의 클라이언트가 없습니다." : "클라이언트가 없습니다.", {
          card: true,
          icon: "clients",
          cta: { href: "/clients/new", label: "+ 새 클라이언트" },
        });

  const body = `
    ${flashBanner(req.query)}
    ${pageHeader({ title: "클라이언트", desc: "아티스트 · 소속사/레이블 · 제작사 (프로젝트에서 자동 등록). 실결제자가 될 수 있습니다.", action: `<a href="/clients/new" class="btn-primary">+ 새 클라이언트</a>` })}
    ${searchBar}
    ${kindChips}
    ${resultNote}
    ${list}`;
  res.send(layout({ title: "클라이언트", user: req.user, current: "/clients", body }));
});

// ── 새 클라이언트 ──
router.get("/new", (req, res) => {
  res.send(layout({ title: "새 클라이언트", user: req.user, current: "/clients", body: clientForm({}) }));
});

router.post("/", (req, res) => {
  const b = req.body;
  const name = String(b.name || "").trim();
  if (!name) return res.send(layout({ title: "새 클라이언트", user: req.user, current: "/clients", body: clientForm({ ...b, _err: "이름을 입력하세요." }) }));
  const kind = normalizeClientKind(b.kind);
  const artist = kind === "아티스트"; // 아티스트(개인)는 사업자등록번호·대표자·주소가 없음
  const info = db()
    .prepare("INSERT INTO clients (name, kind, phone, email, memo, biz_no, owner_name, address) VALUES (@name,@kind,@phone,@email,@memo,@biz_no,@owner_name,@address)")
    .run({
      name,
      kind,
      phone: String(b.phone || "").trim() || null,
      email: String(b.email || "").trim().toLowerCase() || null,
      memo: String(b.memo || "").trim() || null,
      biz_no: artist ? null : String(b.biz_no || "").trim() || null,
      owner_name: artist ? null : String(b.owner_name || "").trim() || null,
      address: artist ? null : String(b.address || "").trim() || null,
    });
  res.redirect("/clients?flash=created#c" + info.lastInsertRowid);
});

// ── 수정 ──
router.get("/:id/edit", (req, res) => {
  const c = getClient(Number(req.params.id));
  if (!c) return res.status(404).send("클라이언트를 찾을 수 없습니다.");
  res.send(layout({ title: "클라이언트 수정", user: req.user, current: "/clients", body: clientForm(c, true) }));
});

router.post("/:id", (req, res) => {
  const id = Number(req.params.id);
  const c = getClient(id);
  if (!c) return res.status(404).send("클라이언트를 찾을 수 없습니다.");
  const b = req.body;
  const name = String(b.name || "").trim();
  if (!name) return res.send(layout({ title: "클라이언트 수정", user: req.user, current: "/clients", body: clientForm({ ...c, ...b, _err: "이름을 입력하세요." }, true) }));
  const kind = normalizeClientKind(b.kind);
  const artist = kind === "아티스트"; // 아티스트(개인)는 세금정보 없음
  db()
    .prepare("UPDATE clients SET name=@name, kind=@kind, phone=@phone, email=@email, memo=@memo, biz_no=@biz_no, owner_name=@owner_name, address=@address WHERE id=@id")
    .run({
      id,
      name,
      kind,
      phone: String(b.phone || "").trim() || null,
      email: String(b.email || "").trim().toLowerCase() || null,
      memo: String(b.memo || "").trim() || null,
      biz_no: artist ? null : String(b.biz_no || "").trim() || null,
      owner_name: artist ? null : String(b.owner_name || "").trim() || null,
      address: artist ? null : String(b.address || "").trim() || null,
    });
  res.redirect("/clients?flash=saved#c" + id);
});

// ── 삭제(강제: 연결된 프로젝트·청구서·사용자의 client_id는 SET NULL로 자동 해제) ──
router.post("/:id/delete", (req, res) => {
  db().prepare("DELETE FROM clients WHERE id = ?").run(Number(req.params.id));
  res.redirect("/clients?flash=deleted");
});

// ── 폼 ──
// ── 클라이언트 상세(프로젝트 + 청구·결제 히스토리) ──
router.get("/:id", (req, res) => {
  const c = getClient(Number(req.params.id));
  if (!c) return res.status(404).send(errorPage({ code: 404, title: "클라이언트를 찾을 수 없습니다", message: "삭제되었거나 주소가 잘못되었습니다.", user: req.user }));
  const tab = req.query.tab === "invoices" ? "invoices" : "projects";
  const projects = listProjectsForClient(c);
  const invoices = listInvoicesForClientEntity(c);
  const contacts = listContactsForClient(c.id);
  const tabBarHtml = tabBar({
    tabs: [{ key: "projects", label: `프로젝트 ${projects.length}` }, { key: "invoices", label: `청구·결제 ${invoices.length}` }],
    activeKey: tab,
    hrefFn: (key) => `/clients/${c.id}?tab=${key}`,
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
        <div class="space-y-2">${invoices.map((i) => invoiceRow(i, { compact: true })).join("")}</div>`;
    } else {
      content = emptyState("이 클라이언트가 실결제자인 청구 내역이 없습니다.", { card: true });
    }
  } else {
    content = projects.length
      ? `<div class="space-y-2">${projects.map((p) => clientProjectCard(p)).join("")}</div>`
      : emptyState("연결된 프로젝트가 없습니다.", { card: true });
  }

  const contactsSection = contacts.length
    ? listGroup({
        rows: contacts.map((ct) =>
          listRow({
            href: `/contacts/${ct.id}`,
            left: `<span class="font-medium">${esc(ct.name)}</span>${ct.aff_title ? `<span class="ml-1.5 text-xs text-muted">${esc(ct.aff_title)}</span>` : ""}`,
            right: ct.phone ? `<span class="text-sm text-muted">${esc(ct.phone)}</span>` : "",
          })
        ),
      })
    : `<p class="text-sm text-muted">등록된 담당자 연락처가 없습니다.</p>`;

  const body = `
    ${flashBanner(req.query)}
    ${pageHeader({ title: c.name, desc: c.kind, back: { href: "/clients", label: "클라이언트" }, action: `<a href="/clients/${c.id}/edit" class="btn-ghost btn-sm">정보 수정</a>` })}
    <div class="mb-4">
      <h3 class="mb-2 text-sm font-medium text-muted">담당자 연락처</h3>
      ${contactsSection}
    </div>
    ${tabBarHtml}
    ${content}`;
  res.send(layout({ title: c.name, user: req.user, current: "/clients", body }));
});

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

function clientForm(c = {}, isEdit = false) {
  const e = c._err || "";
  const action = isEdit ? `/clients/${c.id}` : "/clients";
  return `
    ${pageHeader({ title: isEdit ? "클라이언트 수정" : "새 클라이언트", desc: "분류 · 연락처 · 세금계산서 정보(실결제자가 될 경우)" })}
    <form method="post" action="${action}" class="card space-y-4">
      ${e ? `<p class="rounded-lg bg-danger/10 px-3 py-2 text-sm text-danger">${esc(e)}</p>` : ""}
      <div><label class="label">상호(이름)</label><input class="input" name="name" value="${esc(c.name || "")}" required /></div>
      <div>
        <label class="label">분류</label>
        <select name="kind" class="input" data-client-kind>
          ${CLIENT_KINDS.map((k) => `<option ${k === (c.kind || CLIENT_KINDS[0]) ? "selected" : ""}>${esc(k)}</option>`).join("")}
        </select>
      </div>
      <div data-client-tax class="space-y-4">
        <div class="grid gap-3 sm:grid-cols-2">
          <div><label class="label">사업자등록번호</label><input class="input" name="biz_no" value="${esc(c.biz_no || "")}" placeholder="000-00-00000" /></div>
          <div><label class="label">대표자</label><input class="input" name="owner_name" value="${esc(c.owner_name || "")}" /></div>
        </div>
        <div><label class="label">사업장 주소</label><input class="input" name="address" value="${esc(c.address || "")}" /></div>
      </div>
      <div class="grid gap-3 sm:grid-cols-2">
        <div><label class="label">이메일</label><input class="input" type="email" name="email" value="${esc(c.email || "")}" /></div>
        <div><label class="label">전화</label><input class="input" name="phone" value="${esc(c.phone || "")}" /></div>
      </div>
      <div><label class="label">메모</label><textarea class="input" name="memo" rows="2">${esc(c.memo || "")}</textarea></div>
      <div class="flex gap-2">
        <button class="btn-primary" type="submit">${isEdit ? "저장" : "추가"}</button>
        <a href="/clients" class="btn-ghost">취소</a>
      </div>
    </form>
    ${isEdit ? `
    <form method="post" action="/clients/${c.id}/delete" data-confirm="${esc(c.name || "이 클라이언트")}를 삭제할까요? 연결된 프로젝트·청구서에서는 자동으로 '미지정' 처리됩니다." class="mt-3">
      <button class="btn-ghost text-danger" type="submit">클라이언트 삭제</button>
    </form>` : ""}`;
}

module.exports = router;
