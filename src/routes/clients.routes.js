"use strict";

const os = require("os");
const fs = require("fs");
const crypto = require("crypto");
const express = require("express");
const multer = require("multer");
const { db } = require("../db");
const { requireChief, requireEditor, isChief } = require("../auth");
const { CLIENT_KINDS, normalizeClientKind } = require("../config");
const {
  listClients, clientKindCounts, getClient, listProjectsForClient,
  listInvoicesForClientEntity, listContactsForClient,
  listClientFiles, getClientFile, upsertClientFile, deleteClientFile,
  contactOptions, createContact, addAffiliation,
} = require("../data");
const storage = require("../storage");
const { asyncHandler } = require("../lib/async");
const { formatBizNo } = require("../lib/forms");
const { layout, pageHeader, esc, flashBanner, emptyState, formatKRW, errorPage, tabBar, filterChips, projectTypeBadge, listGroup, listRow } = require("../views");
const { invoiceRow } = require("../views.invoices");

const router = express.Router();

// 모든 클라이언트 라우트는 치프 전용
router.use(requireEditor); // 목록·상세·기본정보 편집=치프·스태프. 첨부 서류(민감 금융정보) 라우트만 requireChief 개별 적용.

// 첨부 서류 업로드: 디스크 스토리지(메모리 금지 — OOM 방지, 플레이북 §3-2), 10MB 제한
const upload = multer({
  storage: multer.diskStorage({
    destination: (_req, _file, cb) => cb(null, os.tmpdir()),
    filename: (_req, _file, cb) => cb(null, "omgcf_" + crypto.randomBytes(8).toString("hex")),
  }),
  limits: { fileSize: 10 * 1024 * 1024 },
});

/** multipart 파일명 latin1 → UTF-8 복원(한글 파일명 보존). */
function decodeName(name) {
  try { return Buffer.from(String(name || ""), "latin1").toString("utf8"); } catch { return String(name || ""); }
}

/**
 * 파일 첫 4바이트 매직바이트로 실제 형식 검증(Content-Type 스푸핑 방어).
 * PNG(89 50 4E 47)·JPEG(FF D8 FF)·PDF(25 50 44 46) 만 허용.
 * 반환: 검증된 MIME 타입 문자열, 또는 null(불허).
 */
function detectMimeFromFile(filePath) {
  const buf = Buffer.alloc(4);
  let fd;
  try {
    fd = fs.openSync(filePath, "r");
    fs.readSync(fd, buf, 0, 4, 0);
  } catch { return null; } finally { if (fd !== undefined) { try { fs.closeSync(fd); } catch {} } }
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return "image/png";
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return "image/jpeg";
  if (buf[0] === 0x25 && buf[1] === 0x50 && buf[2] === 0x44 && buf[3] === 0x46) return "application/pdf";
  return null;
}

/** 첨부 서류 종류 목록(화이트리스트). */
const FILE_KINDS = [
  { key: "biz_license", label: "사업자등록증" },
  { key: "bankbook", label: "통장사본" },
];

function fileKindLabel(key) {
  const f = FILE_KINDS.find((k) => k.key === key);
  return f ? f.label : key;
}

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
    ? listGroup({
        rows: displayed.map((c) => {
          const taxLine = [c.biz_no ? "사업자 " + esc(c.biz_no) : "", c.owner_name ? "대표 " + esc(c.owner_name) : ""].filter(Boolean).join(" · ");
          const left = `<div class="flex items-center gap-2"><span class="badge-neutral">${esc(c.kind)}</span><span class="font-semibold">${esc(c.name)}</span></div>${taxLine ? `<div class="mt-1 text-xs text-muted">${taxLine}</div>` : ""}`;
          const right = `<span class="text-sm text-muted">${esc(c.email || "이메일 없음")}${c.phone ? " · " + esc(c.phone) : ""}</span>`;
          return listRow({ href: `/clients/${c.id}`, left, right });
        }),
      })
    : q
      ? emptyState(`"${esc(q)}" 검색 결과가 없습니다.`, { card: true, icon: "clients" })
      : emptyState(activeKind ? esc(activeKind) + " 분류의 클라이언트가 없습니다." : "클라이언트가 없습니다.", {
          card: true,
          icon: "clients",
          cta: { href: "/clients/new", label: "+ 새 클라이언트" },
        });

  const body = `
    ${flashBanner(req.query)}
    ${pageHeader({ title: "클라이언트", desc: "아티스트 · 소속사/레이블 · 제작사 (프로젝트에서 자동 등록). 청구처가 될 수 있습니다.", action: `<a href="/clients/new" class="btn-primary">+ 새 클라이언트</a>` })}
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
    .prepare("INSERT INTO clients (name, kind, phone, email, memo, biz_no, owner_name, address, cash_receipt_no, group_name) VALUES (@name,@kind,@phone,@email,@memo,@biz_no,@owner_name,@address,@cash_receipt_no,@group_name)")
    .run({
      name,
      kind,
      phone: String(b.phone || "").trim() || null,
      email: String(b.email || "").trim().toLowerCase() || null,
      memo: String(b.memo || "").trim() || null,
      biz_no: artist ? null : formatBizNo(b.biz_no),
      owner_name: artist ? null : String(b.owner_name || "").trim() || null,
      address: artist ? null : String(b.address || "").trim() || null,
      cash_receipt_no: artist ? String(b.cash_receipt_no || "").trim() || null : null, // 개인만 현금영수증 정보
      group_name: artist ? String(b.group_name || "").trim() || null : null, // 소속그룹(아티스트만)
    });
  linkClientContact(info.lastInsertRowid, b); // 담당자 연락처 입력 시 이 클라이언트 소속으로 연동
  res.redirect("/clients?flash=created#c" + info.lastInsertRowid);
});

// ── 수정 ──
router.get("/:id/edit", (req, res) => {
  const c = getClient(Number(req.params.id));
  if (!c) return res.status(404).send(errorPage({ code: 404, title: "클라이언트를 찾을 수 없습니다", message: "삭제되었거나 주소가 잘못되었습니다.", user: req.user }));
  const files = listClientFiles(c.id);
  const fileErr = String(req.query.ferr || "").trim();
  res.send(layout({ title: "클라이언트 수정", user: req.user, current: "/clients", body: clientForm(c, true, files, fileErr, true) }));
});

router.post("/:id", (req, res) => {
  const id = Number(req.params.id);
  const c = getClient(id);
  if (!c) return res.status(404).send(errorPage({ code: 404, title: "클라이언트를 찾을 수 없습니다", message: "삭제되었거나 주소가 잘못되었습니다.", user: req.user }));
  const b = req.body;
  const name = String(b.name || "").trim();
  if (!name) {
    const files = listClientFiles(id);
    return res.send(layout({ title: "클라이언트 수정", user: req.user, current: "/clients", body: clientForm({ ...c, ...b, _err: "이름을 입력하세요." }, true, files, "", true) }));
  }
  const kind = normalizeClientKind(b.kind);
  const artist = kind === "아티스트"; // 아티스트(개인)는 세금정보 없음
  db()
    .prepare("UPDATE clients SET name=@name, kind=@kind, phone=@phone, email=@email, memo=@memo, biz_no=@biz_no, owner_name=@owner_name, address=@address, cash_receipt_no=@cash_receipt_no, group_name=@group_name WHERE id=@id")
    .run({
      id,
      name,
      kind,
      phone: String(b.phone || "").trim() || null,
      email: String(b.email || "").trim().toLowerCase() || null,
      memo: String(b.memo || "").trim() || null,
      biz_no: artist ? null : formatBizNo(b.biz_no),
      owner_name: artist ? null : String(b.owner_name || "").trim() || null,
      address: artist ? null : String(b.address || "").trim() || null,
      cash_receipt_no: artist ? String(b.cash_receipt_no || "").trim() || null : null, // 개인만 현금영수증 정보
      group_name: artist ? String(b.group_name || "").trim() || null : null, // 소속그룹(아티스트만)
    });
  linkClientContact(id, b); // 담당자 연락처 입력 시 이 클라이언트 소속으로 연동
  res.redirect(`/clients/${id}?flash=saved`); // 수정 후 그 클라이언트 상세로 복귀(목록 아님)
});

// ── 삭제(강제: 연결된 프로젝트·청구서·사용자의 client_id는 SET NULL으로 자동 해제) ──
// 단, 발행/입금완료 인보이스가 있으면 청구처 보존을 위해 삭제 거부
router.post("/:id/delete", (req, res) => {
  const id = Number(req.params.id);
  const active = db().prepare("SELECT 1 FROM invoices WHERE client_id=? AND (status='발행' OR tax_status IN ('계산서 발행','입금완료')) LIMIT 1").get(id); // 청구서 발행 또는 계산서·입금 진행분이면 청구처 보존
  if (active) return res.status(409).send(errorPage({ code: 409, title: "청구처로 발행된 청구가 있어 삭제할 수 없습니다", message: "발행·입금완료된 청구의 청구처입니다. 관련 청구를 먼저 정리하세요(매출 추적 보존).", user: req.user }));
  db().prepare("DELETE FROM clients WHERE id = ?").run(id);
  res.redirect("/clients?flash=deleted");
});

// ── 첨부 서류 업로드(치프·스태프 — requireEditor) ──
// 보안: 디스크 multer + 매직바이트 검증(PNG·JPEG·PDF) + 인증 다운로드만(공개 링크 없음).
router.post("/:id/files/:kind", requireEditor, upload.single("file"), asyncHandler(async (req, res) => {
  const id = Number(req.params.id);
  const kind = req.params.kind;
  const c = getClient(id);
  if (!c) {
    if (req.file) fs.promises.unlink(req.file.path).catch(() => {});
    return res.status(404).send(errorPage({ code: 404, title: "클라이언트를 찾을 수 없습니다", message: "", user: req.user }));
  }
  if (!FILE_KINDS.find((k) => k.key === kind)) {
    if (req.file) fs.promises.unlink(req.file.path).catch(() => {});
    return res.redirect(`/clients/${id}/edit?ferr=${encodeURIComponent("알 수 없는 서류 종류입니다.")}`);
  }
  if (!req.file) {
    return res.redirect(`/clients/${id}/edit?ferr=${encodeURIComponent("파일을 선택하세요.")}`);
  }

  // 매직바이트 검증: Content-Type 헤더를 신뢰하지 않고 파일 첫 바이트로 직접 확인
  const detectedMime = detectMimeFromFile(req.file.path);
  if (!detectedMime) {
    fs.promises.unlink(req.file.path).catch(() => {});
    return res.redirect(`/clients/${id}/edit?ferr=${encodeURIComponent("PNG, JPG, PDF 파일만 업로드할 수 있습니다.")}`);
  }

  const originalName = decodeName(req.file.originalname);
  try {
    const { backend, fileId } = await storage.put({ filePath: req.file.path, name: originalName, mimeType: detectedMime });
    // 기존 같은 kind 파일을 교체하는 경우 이전 파일 스토리지 정리
    const old = upsertClientFile(id, kind, { storage_backend: backend, file_id: fileId, file_name: originalName, mime_type: detectedMime, file_size: req.file.size });
    if (old) await storage.remove(old.storage_backend, old.file_id);
    res.redirect(`/clients/${id}/edit?flash=saved`);
  } catch (e) {
    console.error("[client file upload]", e);
    res.redirect(`/clients/${id}/edit?ferr=${encodeURIComponent("업로드에 실패했습니다.")}`);
  } finally {
    if (req.file) fs.promises.unlink(req.file.path).catch(() => {});
  }
}));

// ── 첨부 서류 인증 다운로드(치프·스태프 인증 후 프록시 — 공개 URL 없음) ──
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
  if (!FILE_KINDS.find((k) => k.key === kind)) return res.redirect(`/clients/${id}/edit`);
  const old = deleteClientFile(id, kind);
  if (old) await storage.remove(old.storage_backend, old.file_id);
  res.redirect(`/clients/${id}/edit?flash=deleted`);
}));

// ── 클라이언트 상세(프로젝트 + 청구·결제 히스토리 + 첨부 서류 링크) ──
router.get("/:id", (req, res) => {
  const c = getClient(Number(req.params.id));
  if (!c) return res.status(404).send(errorPage({ code: 404, title: "클라이언트를 찾을 수 없습니다", message: "삭제되었거나 주소가 잘못되었습니다.", user: req.user }));
  const tab = req.query.tab === "invoices" ? "invoices" : "projects";
  const projects = listProjectsForClient(c);
  const invoices = listInvoicesForClientEntity(c);
  const contacts = listContactsForClient(c.id);
  const files = listClientFiles(c.id);
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
      content = emptyState("이 클라이언트가 청구처인 청구 내역이 없습니다.", { card: true });
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

  // 첨부 서류 열람 링크(있으면만 표시, 공개 URL 없음)
  const filesSection = files.length
    ? `<div class="mb-4">
        <h3 class="mb-2 text-sm font-medium text-muted">첨부 서류</h3>
        <div class="flex flex-wrap gap-2">
          ${files.map((f) => `<a href="/clients/${c.id}/files/${f.kind}/raw" target="_blank" rel="noopener" class="btn-ghost btn-sm">${esc(fileKindLabel(f.kind))} 보기</a>`).join("")}
        </div>
      </div>`
    : "";

  const body = `
    ${flashBanner(req.query)}
    ${pageHeader({ title: c.name, desc: c.kind + (c.group_name ? ` · 소속그룹 ${c.group_name}` : ""), back: { href: "/clients", label: "클라이언트" }, action: `<a href="/clients/${c.id}/edit" class="btn-ghost btn-sm">정보 수정</a>` })}
    <div class="mb-4">
      <h3 class="mb-2 text-sm font-medium text-muted">담당자 연락처</h3>
      ${contactsSection}
    </div>
    ${filesSection}
    ${tabBarHtml}
    ${content}`;
  res.send(layout({ title: c.name, user: req.user, current: "/clients", body }));
});

// ── 헬퍼 함수 ──

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
function clientFileSection(c, fileMap, fileErr) {
  const rows = FILE_KINDS.map(({ key, label }) => {
    const existing = fileMap[key];
    const existingRow = existing
      ? `<div class="mb-2 flex items-center gap-3 text-sm">
            <a href="/clients/${c.id}/files/${key}/raw" target="_blank" rel="noopener" class="font-medium text-primary hover:underline">${esc(label)} 보기</a>
            <span class="max-w-[12rem] truncate text-xs text-muted">${esc(existing.file_name)}</span>
            <form method="post" action="/clients/${c.id}/files/${key}/delete" class="inline" data-confirm="${esc(label)}을 삭제할까요?">
              <button class="text-xs text-danger hover:underline" type="submit">삭제</button>
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
          <div class="input flex cursor-pointer select-none items-center py-2 text-sm text-muted" data-dropzone-display>
            <span data-dropzone-label>${existing ? "다른 파일로 교체" : "파일 끌어놓기 또는 클릭"}</span>
          </div>
        </div>
        <button class="btn-ghost shrink-0" type="submit">업로드</button>
      </form>
    </div>`;
  }).join("");

  return `
  <section class="card mt-3 space-y-4">
    <div>
      <h2 class="font-semibold">첨부 서류</h2>
      <p class="mt-1 text-xs text-muted">PNG · JPG · PDF · 최대 10MB. 직원 인증 열람(공개 링크 없음).</p>
    </div>
    ${fileErr ? `<p class="rounded-lg bg-danger/10 px-3 py-2 text-sm text-danger">${esc(fileErr)}</p>` : ""}
    ${rows}
  </section>`;
}

/** 클라이언트 담당자 연락처 콤보 — 이름 선택/입력 시 연락처에 연동(이 클라이언트 소속으로). 프로젝트 contactCombo와 동일 패턴(app.js 처리). */
function clientContactCombo(c, isEdit) {
  const opts = contactOptions();
  const cur = isEdit && c.id ? (listContactsForClient(c.id)[0] || null) : null;
  return `
    <div>
      <label class="label">담당자 연락처 <span class="font-normal text-muted text-xs">(이 클라이언트 담당자 — 연락처에 연동)</span></label>
      <div data-contact-combo>
        <input type="hidden" name="contact_id" value="${cur ? cur.id : ""}" data-contact-id />
        <input class="input" type="text" name="contact_name" list="dl-client-contacts" data-contact-search autocomplete="off"
          placeholder="이름 입력 — 목록에서 선택하거나 새 이름" value="${cur ? esc(cur.name) : ""}" aria-label="담당자 검색" />
        <datalist id="dl-client-contacts">
          ${opts.map((o) => `<option value="${esc(o.name)}" data-id="${o.id}" data-phone="${esc(o.phone || "")}" data-email="${esc(o.email || "")}" data-client="${esc(o.current_client || "")}"></option>`).join("")}
        </datalist>
        <div class="mt-1 hidden text-sm text-muted" data-contact-info></div>
        <p class="mt-0.5 text-xs text-muted">목록에 없는 이름을 입력하면 새 연락처로 등록되고 이 클라이언트 담당자로 연결됩니다.</p>
      </div>
    </div>`;
}

/** 클라이언트 담당자(연락처) 연동: 선택/입력된 담당자를 이 클라이언트 소속으로 연결(이미 현 소속이면 생략). */
function linkClientContact(clientId, body) {
  let contactId = body.contact_id ? Number(body.contact_id) : null;
  if (!contactId) {
    const name = String(body.contact_name || "").trim();
    if (!name) return;
    contactId = createContact({ name });
  }
  if (!contactId) return;
  const already = db()
    .prepare("SELECT 1 FROM contact_affiliations WHERE contact_id = ? AND client_id = ? AND ended_on IS NULL LIMIT 1")
    .get(contactId, Number(clientId));
  if (!already) addAffiliation(contactId, { client_id: Number(clientId), closeCurrent: false }); // 다른 소속을 끊지 않고 이 클라이언트 담당으로 추가
}

function clientForm(c = {}, isEdit = false, files = [], fileErr = "", canFiles = false) {
  const e = c._err || "";
  const action = isEdit ? `/clients/${c.id}` : "/clients";
  const isArtist = (c.kind || CLIENT_KINDS[0]) === "아티스트"; // 개인 → 세금정보 숨김·현금영수증 표시(초기 렌더, app.js가 분류 변경 시 토글)
  const fileMap = {};
  files.forEach((f) => { fileMap[f.kind] = f; });

  return `
    ${pageHeader({ title: isEdit ? "클라이언트 수정" : "새 클라이언트", desc: "분류 · 연락처 · 세금계산서 정보(청구처가 될 경우)", back: isEdit && c.id ? { href: `/clients/${c.id}`, label: "클라이언트 상세" } : { href: "/clients", label: "클라이언트" } })}
    <form method="post" action="${action}" class="card space-y-4">
      ${e ? `<p class="rounded-lg bg-danger/10 px-3 py-2 text-sm text-danger">${esc(e)}</p>` : ""}
      <div><label class="label">상호(이름)</label><input class="input" name="name" value="${esc(c.name || "")}" required /></div>
      <div>
        <label class="label">분류</label>
        <select name="kind" class="input" data-client-kind>
          ${CLIENT_KINDS.map((k) => `<option ${k === (c.kind || CLIENT_KINDS[0]) ? "selected" : ""}>${esc(k)}</option>`).join("")}
        </select>
      </div>
      <div data-client-tax class="space-y-4"${isArtist ? " hidden" : ""}>
        <div class="grid gap-3 sm:grid-cols-2">
          <div><label class="label">사업자등록번호</label><input class="input" name="biz_no" value="${esc(c.biz_no || "")}" placeholder="000-00-00000" /></div>
          <div><label class="label">대표자</label><input class="input" name="owner_name" value="${esc(c.owner_name || "")}" /></div>
        </div>
        <div><label class="label">사업장 주소</label><input class="input" name="address" value="${esc(c.address || "")}" /></div>
      </div>
      <div data-client-cash${isArtist ? "" : " hidden"} class="space-y-4">
        <div>
          <label class="label">소속그룹 <span class="font-normal text-muted text-xs">(속한 그룹·소속사·팀 — 있으면)</span></label>
          <input class="input" name="group_name" value="${esc(c.group_name || "")}" placeholder="예: 소속 그룹·소속사명" />
        </div>
        <div>
          <label class="label">현금영수증 정보 <span class="font-normal text-muted text-xs">(개인 — 사업자등록증 없는 경우)</span></label>
          <input class="input" name="cash_receipt_no" value="${esc(c.cash_receipt_no || "")}" placeholder="휴대폰 번호(010-0000-0000) 또는 현금영수증 카드번호" />
        </div>
      </div>
      <div class="grid gap-3 sm:grid-cols-2">
        <div><label class="label">세금계산서 발행 이메일</label><input class="input" type="email" name="email" value="${esc(c.email || "")}" placeholder="계산서 받을 이메일" /></div>
        <div><label class="label">전화</label><input class="input" name="phone" value="${esc(c.phone || "")}" /></div>
      </div>
      ${clientContactCombo(c, isEdit)}
      <div><label class="label">메모</label><textarea class="input" name="memo" rows="2">${esc(c.memo || "")}</textarea></div>
      <div class="flex gap-2">
        <button class="btn-primary" type="submit">${isEdit ? "저장" : "추가"}</button>
        <a href="${isEdit && c.id ? `/clients/${c.id}` : "/clients"}" class="btn-ghost">취소</a>
      </div>
    </form>
    ${isEdit && canFiles ? `<div data-client-files${isArtist ? " hidden" : ""}>${clientFileSection(c, fileMap, fileErr)}</div>` : ""}
    ${isEdit ? `
    <form method="post" action="/clients/${c.id}/delete" data-confirm="${esc(c.name || "이 클라이언트")}를 삭제할까요? 연결된 프로젝트·청구서에서는 자동으로 '미지정' 처리됩니다." class="mt-3">
      <button class="btn-ghost text-danger" type="submit">클라이언트 삭제</button>
    </form>` : ""}`;
}

module.exports = router;
