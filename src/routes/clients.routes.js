"use strict";

const express = require("express");
const { db } = require("../db");
const { requireChief } = require("../auth");
const { CLIENT_KINDS, normalizeClientKind } = require("../config");
const { listClients, clientKindCounts, getClient } = require("../data");
const { layout, pageHeader, esc, flashBanner, emptyState } = require("../views");

const router = express.Router();

// 모든 클라이언트 라우트는 치프 전용
router.use(requireChief);

// ── 목록(탭 = 분류 필터) ──
router.get("/", (req, res) => {
  const TAB_KINDS = ["아티스트", "소속사/레이블", "제작사"]; // "기타"는 전체에만 포함
  const activeKind = TAB_KINDS.includes(req.query.kind) ? req.query.kind : "";
  const rows = listClients(activeKind ? { kind: activeKind } : {});
  const counts = clientKindCounts();
  const total = Object.values(counts).reduce((a, b) => a + b, 0);

  const tab = (label, kind, count) => {
    const active = activeKind === kind;
    return `<a href="/clients${kind ? "?kind=" + encodeURIComponent(kind) : ""}" class="badge ${active ? "bg-primary text-primary-fg" : "bg-surface border border-border text-muted"}">${esc(label)} ${count}</a>`;
  };
  const tabBar = `<div class="mb-4 flex flex-wrap gap-2">
      ${tab("전체목록", "", total)}
      ${TAB_KINDS.map((k) => tab(k, k, counts[k] || 0)).join("")}
    </div>`;
  const list = rows.length
    ? rows
        .map((c) => {
          const taxLine = [c.biz_no ? "사업자 " + esc(c.biz_no) : "", c.owner_name ? "대표 " + esc(c.owner_name) : ""].filter(Boolean).join(" · ");
          return `
      <div class="card mb-3">
        <div class="flex items-start justify-between gap-3">
          <div class="min-w-0">
            <div class="flex items-center gap-2">
              <span class="badge bg-bg text-muted">${esc(c.kind)}</span>
              <span class="font-semibold">${esc(c.name)}</span>
            </div>
            ${taxLine ? `<div class="mt-1 text-xs text-muted">${taxLine}</div>` : ""}
            <div class="mt-0.5 text-sm text-muted">
              ${esc(c.email || "이메일 없음")}${c.phone ? " · " + esc(c.phone) : ""}
            </div>
          </div>
          <a href="/clients/${c.id}/edit" class="btn-ghost shrink-0 btn-xs">수정</a>
        </div>
      </div>`;
        })
        .join("")
    : emptyState(activeKind ? esc(activeKind) + " 분류의 클라이언트가 없습니다." : "클라이언트가 없습니다.", { card: true });

  const body = `
    ${flashBanner(req.query)}
    ${pageHeader({ title: "클라이언트", desc: "아티스트 · 소속사/레이블 · 제작사 (프로젝트에서 자동 등록). 실결제자가 될 수 있습니다.", action: `<a href="/clients/new" class="btn-primary">+ 새 클라이언트</a>` })}
    ${tabBar}
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
  const info = db()
    .prepare("INSERT INTO clients (name, kind, phone, email, memo, biz_no, owner_name, address) VALUES (@name,@kind,@phone,@email,@memo,@biz_no,@owner_name,@address)")
    .run({
      name,
      kind: normalizeClientKind(b.kind),
      phone: String(b.phone || "").trim() || null,
      email: String(b.email || "").trim().toLowerCase() || null,
      memo: String(b.memo || "").trim() || null,
      biz_no: String(b.biz_no || "").trim() || null,
      owner_name: String(b.owner_name || "").trim() || null,
      address: String(b.address || "").trim() || null,
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
  db()
    .prepare("UPDATE clients SET name=@name, kind=@kind, phone=@phone, email=@email, memo=@memo, biz_no=@biz_no, owner_name=@owner_name, address=@address WHERE id=@id")
    .run({
      id,
      name,
      kind: normalizeClientKind(b.kind),
      phone: String(b.phone || "").trim() || null,
      email: String(b.email || "").trim().toLowerCase() || null,
      memo: String(b.memo || "").trim() || null,
      biz_no: String(b.biz_no || "").trim() || null,
      owner_name: String(b.owner_name || "").trim() || null,
      address: String(b.address || "").trim() || null,
    });
  res.redirect("/clients?flash=saved#c" + id);
});

// ── 폼 ──
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
        <select name="kind" class="input">
          ${CLIENT_KINDS.map((k) => `<option ${k === (c.kind || CLIENT_KINDS[0]) ? "selected" : ""}>${esc(k)}</option>`).join("")}
        </select>
      </div>
      <div class="grid gap-3 sm:grid-cols-2">
        <div><label class="label">사업자등록번호</label><input class="input" name="biz_no" value="${esc(c.biz_no || "")}" placeholder="000-00-00000" /></div>
        <div><label class="label">대표자</label><input class="input" name="owner_name" value="${esc(c.owner_name || "")}" /></div>
      </div>
      <div><label class="label">사업장 주소</label><input class="input" name="address" value="${esc(c.address || "")}" /></div>
      <div class="grid gap-3 sm:grid-cols-2">
        <div><label class="label">이메일</label><input class="input" type="email" name="email" value="${esc(c.email || "")}" /></div>
        <div><label class="label">전화</label><input class="input" name="phone" value="${esc(c.phone || "")}" /></div>
      </div>
      <div><label class="label">메모</label><textarea class="input" name="memo" rows="2">${esc(c.memo || "")}</textarea></div>
      <div class="flex gap-2">
        <button class="btn-primary" type="submit">${isEdit ? "저장" : "추가"}</button>
        <a href="/clients" class="btn-ghost">취소</a>
      </div>
    </form>`;
}

module.exports = router;
