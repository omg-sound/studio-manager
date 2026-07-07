"use strict";

const os = require("os");
const fs = require("fs");
const crypto = require("crypto");
const express = require("express");
const multer = require("multer");

const { config, DELIVERABLE_KINDS, normalizeDeliverableKind } = require("../config");
const { notifyAsync } = require("../notify");
const { db } = require("../db");
const { requireStaff, isStaffOrChief } = require("../auth");
const {
  getProjectForUser,
  listDeliverablesForProject,
  getDeliverableForUser,
  getDeliverableByToken,
  recentDeliverables,
} = require("../data");
const storage = require("../storage");
const { activeBackend } = storage;
const { asyncHandler } = require("../lib/async");
const { layout, pageHeader, esc, formatBytes, emptyState } = require("../views");
const { deliverablesSection, deliverableRow, linkStatus } = require("../views.deliverables");
const { todayYmd, isValidYmd, formatYmdShort } = require("../lib/date");

const router = express.Router();

// multer: 디스크 스토리지(메모리 금지 — OOM 방지, 플레이북 §3-2) + 크기 제한
const upload = multer({
  storage: multer.diskStorage({
    destination: (_req, _file, cb) => cb(null, os.tmpdir()),
    filename: (_req, _file, cb) => cb(null, "omgup_" + crypto.randomBytes(8).toString("hex")),
  }),
  limits: { fileSize: config.maxUploadMb * 1024 * 1024 },
});

/** multipart 파일명은 latin1로 오므로 UTF-8 복원(한글 깨짐 방지). */
function decodeName(name) {
  try {
    return Buffer.from(String(name || ""), "latin1").toString("utf8");
  } catch {
    return String(name || "");
  }
}

function cleanYmd(v) {
  const s = String(v || "").trim();
  return isValidYmd(s) ? s : null;
}

function newToken() {
  return crypto.randomBytes(24).toString("hex");
}

// ── 자료 타임라인(인증) — admin 전체 / client 자기 프로젝트 ──
router.get("/deliverables", requireStaff, (req, res) => {
  const rows = recentDeliverables(req.user);
  const admin = isStaffOrChief(req.user);
  const list = rows.length
    ? rows
        .map((dv) => {
          const st = linkStatus(dv);
          return `
        <a href="/projects/${dv.project_id}" class="flex items-center justify-between gap-3 border-b border-border py-3 last:border-0">
          <div class="min-w-0">
            <div class="truncate font-medium">${esc(dv.title)}${dv.version ? ` <span class="text-xs text-muted">${esc(dv.version)}</span>` : ""}</div>
            <div class="truncate text-xs text-muted">${esc(dv.project_title || "프로젝트 없음")}${dv.client_name ? " · " + esc(dv.client_name) : ""}</div>
          </div>
          <div class="shrink-0 text-right text-xs">
            <div class="text-muted">${esc(formatBytes(dv.file_size))} · ${esc((dv.created_at || "").slice(0, 10))}</div>
            <div class="${st.cls}">${st.label}${admin ? ` · ${dv.download_count}회` : ""}</div>
          </div>
        </a>`;
        })
        .join("")
    : emptyState("전달된 자료가 없습니다.");

  const backendNote = admin
    ? `<p class="mb-3 text-xs text-muted">스토리지: ${activeBackend() === "drive" ? "Google Drive(연동됨)" : "로컬 디스크(Drive 미연동 — 관리자 Google 로그인 시 Drive 사용)"}</p>`
    : "";

  const body = `
    ${pageHeader({ title: "자료 전달", desc: admin ? "최근 전달 기록" : "내게 전달된 자료" })}
    ${backendNote}
    <div class="card">${list}</div>`;
  res.send(layout({ title: "자료 전달", user: req.user, current: "/deliverables", body }));
});

// ── 업로드 폼(관리자) ──
router.get("/projects/:pid/deliverables/new", requireStaff, (req, res) => {
  const project = getProjectForUser(req.user, Number(req.params.pid));
  if (!project) return res.status(404).send("프로젝트를 찾을 수 없습니다.");
  res.send(layout({ title: "자료 업로드", user: req.user, current: "/deliverables", body: uploadForm(project) }));
});

// ── 업로드 처리(관리자) ──
router.post("/projects/:pid/deliverables", requireStaff, upload.single("file"), asyncHandler(async (req, res) => {
  const project = getProjectForUser(req.user, Number(req.params.pid));
  if (!project) {
    if (req.file) fs.promises.unlink(req.file.path).catch(() => {});
    return res.status(404).send("프로젝트를 찾을 수 없습니다.");
  }
  const b = req.body;
  const title = String(b.title || "").trim();
  if (!req.file || !title) {
    if (req.file) fs.promises.unlink(req.file.path).catch(() => {});
    return res.send(layout({ title: "자료 업로드", user: req.user, current: "/deliverables", body: uploadForm(project, { ...b, _err: "제목과 파일을 모두 지정하세요." }) }));
  }

  const originalName = decodeName(req.file.originalname);
  try {
    const { backend, fileId } = await storage.put({
      filePath: req.file.path,
      name: originalName,
      mimeType: req.file.mimetype,
      folder: "deliverables", // 자료 전달은 omg-studios-manager/deliverables 아래로
    });
    const makeLink = b.make_link === "on" || b.make_link === "1";
    db()
      .prepare(
        `INSERT INTO deliverables
         (project_id, title, version, kind, storage_backend, file_id, file_name, file_size, mime_type, access_token, expires_at, note)
         VALUES (@project_id,@title,@version,@kind,@backend,@file_id,@file_name,@file_size,@mime_type,@token,@expires_at,@note)`
      )
      .run({
        project_id: project.id,
        title,
        version: String(b.version || "").trim() || null,
        kind: normalizeDeliverableKind(b.kind),
        backend,
        file_id: fileId,
        file_name: originalName,
        file_size: req.file.size,
        mime_type: req.file.mimetype || null,
        token: makeLink ? newToken() : null,
        expires_at: cleanYmd(b.expires_at),
        note: String(b.note || "").trim() || null,
      });
    res.redirect(`/projects/${project.id}?tab=deliverables&flash=added`);
  } catch (e) {
    console.error("[deliverable upload]", e);
    const msg = e && e.code === "DRIVE_NOT_LINKED" ? "Drive 미연동(관리자 Google 로그인 필요)"
      : e && e.code === "DRIVE_UPLOAD_FAILED" ? "Google Drive 업로드 실패 — 로컬에 저장하지 않았습니다. 잠시 후 다시 시도하거나 Drive 연동을 확인하세요."
      : "업로드 실패: " + (e.message || "");
    res.send(layout({ title: "자료 업로드", user: req.user, current: "/deliverables", body: uploadForm(project, { ...b, _err: msg }) }));
  } finally {
    if (req.file) fs.promises.unlink(req.file.path).catch(() => {});
  }
}));

// ── 인증 다운로드(프록시 스트리밍, 범위 강제) ──
router.get("/deliverables/:id/raw", requireStaff, asyncHandler(async (req, res) => {
  const dv = getDeliverableForUser(req.user, Number(req.params.id));
  if (!dv) return res.status(404).send("자료를 찾을 수 없습니다.");
  await sendFile(dv, res);
}));

// ── 공유 토큰 발급/갱신(관리자) ──
router.post("/deliverables/:id/token", requireStaff, (req, res) => {
  const dv = db().prepare("SELECT * FROM deliverables WHERE id = ?").get(Number(req.params.id));
  if (!dv) return res.status(404).send("자료를 찾을 수 없습니다.");
  const isNew = !dv.access_token;
  const token = dv.access_token || newToken();
  db()
    .prepare("UPDATE deliverables SET access_token=?, expires_at=?, revoked=0 WHERE id=?")
    .run(token, cleanYmd(req.body.expires_at), dv.id);
  // 팀 알림(공개 토큰은 외부 채널에 노출하지 않고 내부 프로젝트 페이지로 링크). fail-safe·비차단.
  notifyAsync({
    type: "deliverable_shared",
    title: `[자료 공유] ${dv.title}${dv.version ? " " + dv.version : ""}`,
    text: isNew ? "공유 링크 발급" : "공유 링크 갱신",
    url: config.baseUrl ? `${config.baseUrl}/projects/${dv.project_id}?tab=deliverables` : undefined,
  });
  res.redirect(`/projects/${dv.project_id}?tab=deliverables&flash=saved`);
});

// ── 철회/복구 토글(관리자) ──
router.post("/deliverables/:id/revoke", requireStaff, (req, res) => {
  const dv = db().prepare("SELECT * FROM deliverables WHERE id = ?").get(Number(req.params.id));
  if (!dv) return res.status(404).send("자료를 찾을 수 없습니다.");
  db().prepare("UPDATE deliverables SET revoked=? WHERE id=?").run(dv.revoked ? 0 : 1, dv.id);
  res.redirect(`/projects/${dv.project_id}?tab=deliverables&flash=saved`);
});

// ── 삭제(관리자) — 파일 + 행 ──
router.post("/deliverables/:id/delete", requireStaff, asyncHandler(async (req, res) => {
  const dv = db().prepare("SELECT * FROM deliverables WHERE id = ?").get(Number(req.params.id));
  if (!dv) return res.status(404).send("자료를 찾을 수 없습니다.");
  await storage.remove(dv.storage_backend, dv.file_id);
  db().prepare("DELETE FROM deliverables WHERE id = ?").run(dv.id);
  res.redirect(dv.project_id ? `/projects/${dv.project_id}?tab=deliverables&flash=deleted` : "/deliverables");
}));

// ── 공개 토큰 링크(로그인 불필요) ──
router.get("/d/:token", (req, res) => {
  const dv = getDeliverableByToken(req.params.token);
  const gate = tokenGate(dv);
  if (!gate.ok) return res.status(gate.code).send(layout({ title: "다운로드", body: gate.html }));
  res.setHeader("Cache-Control", "private, no-store");
  const body = `
    <div class="mb-6 text-center">
      <div class="font-display text-sm font-semibold text-muted">OMG Studios</div>
      <h1 class="mt-1 font-display text-2xl font-semibold">${esc(dv.title)}</h1>
      <p class="mt-1 text-sm text-muted">자료 전달</p>
    </div>
    <div class="card space-y-2">
      <div class="flex justify-between text-sm"><span class="text-muted">파일</span><span class="font-medium">${esc(dv.file_name)}</span></div>
      <div class="flex justify-between text-sm"><span class="text-muted">자료 구분</span><span>${esc(dv.kind)}${dv.version ? " · " + esc(dv.version) : ""}</span></div>
      <div class="flex justify-between text-sm"><span class="text-muted">크기</span><span>${esc(formatBytes(dv.file_size))}</span></div>
      ${dv.expires_at ? `<div class="flex justify-between text-sm"><span class="text-muted">유효기한</span><span>${esc(formatYmdShort(dv.expires_at))}</span></div>` : ""}
      <a href="/d/${esc(dv.access_token)}/raw" class="btn-primary mt-3 w-full">다운로드</a>
    </div>`;
  res.send(layout({ title: dv.title, body }));
});

// ── 공개 다운로드(카운트 증가) ──
router.get("/d/:token/raw", asyncHandler(async (req, res) => {
  const dv = getDeliverableByToken(req.params.token);
  const gate = tokenGate(dv);
  if (!gate.ok) return res.status(gate.code).send(layout({ title: "다운로드", body: gate.html }));
  db().prepare("UPDATE deliverables SET download_count = download_count + 1 WHERE id = ?").run(dv.id);
  await sendFile(dv, res);
}));

// ── 헬퍼 ──

/** 토큰 유효성 게이트(존재/철회/만료). */
function tokenGate(dv) {
  const fail = (msg) => ({
    ok: false,
    code: 404,
    html: `<div class="card text-center"><p class="text-sm text-muted">${esc(msg)}</p></div>`,
  });
  if (!dv || !dv.access_token) return fail("유효하지 않은 링크입니다.");
  if (dv.revoked) return fail("철회된 링크입니다.");
  if (dv.expires_at && todayYmd() > dv.expires_at) return fail("만료된 링크입니다.");
  return { ok: true };
}

/** 자료를 res로 프록시 스트리밍(헤더 설정 후). */
async function sendFile(dv, res) {
  res.setHeader("Cache-Control", "private, no-store");
  res.setHeader("Content-Type", dv.mime_type || "application/octet-stream");
  res.setHeader(
    "Content-Disposition",
    `attachment; filename*=UTF-8''${encodeURIComponent(dv.file_name)}`
  );
  if (dv.file_size > 0) res.setHeader("Content-Length", dv.file_size);
  try {
    await storage.stream(dv.storage_backend, dv.file_id, res);
  } catch (e) {
    console.error("[stream]", e);
    if (!res.headersSent) res.status(502).send("파일을 가져오지 못했습니다.");
    else res.destroy();
  }
}

function uploadForm(project, b = {}) {
  const e = b._err || "";
  return `
    ${pageHeader({ title: "자료 업로드", desc: project.title })}
    <form method="post" action="/projects/${project.id}/deliverables" enctype="multipart/form-data" class="card space-y-4">
      ${e ? `<p class="rounded-lg bg-danger/10 px-3 py-2 text-sm text-danger">${esc(e)}</p>` : ""}
      <div>
        <label class="label">파일 (최대 ${config.maxUploadMb}MB)</label>
        <input class="input" type="file" name="file" required />
      </div>
      <div>
        <label class="label">제목</label>
        <input class="input" name="title" value="${esc(b.title || "")}" placeholder="예: Mix v2 stems" required />
      </div>
      <div class="grid gap-3 sm:grid-cols-2">
        <div>
          <label class="label">자료 구분</label>
          <select name="kind" class="input">
            ${DELIVERABLE_KINDS.map((k) => `<option ${k === (b.kind || DELIVERABLE_KINDS[0]) ? "selected" : ""}>${esc(k)}</option>`).join("")}
          </select>
        </div>
        <div>
          <label class="label">버전(선택)</label>
          <input class="input" name="version" value="${esc(b.version || "")}" placeholder="v1, v2, final" />
        </div>
      </div>
      <div class="grid gap-3 sm:grid-cols-2">
        <div>
          <label class="label">공유 링크 만료일(선택)</label>
          <input class="input" type="date" name="expires_at" value="${esc(b.expires_at || "")}" />
        </div>
        <div class="flex items-end">
          <label class="flex items-center gap-2 text-sm"><input type="checkbox" name="make_link" checked /> 업로드 즉시 공유 링크 발급</label>
        </div>
      </div>
      <div>
        <label class="label">메모(선택)</label>
        <textarea class="input" name="note" rows="2">${esc(b.note || "")}</textarea>
      </div>
      <div class="flex gap-2">
        <button class="btn-primary" type="submit">업로드</button>
        <a href="/projects/${project.id}" class="btn-ghost">취소</a>
      </div>
    </form>`;
}

module.exports = router;
