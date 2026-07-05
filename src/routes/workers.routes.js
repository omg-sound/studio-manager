"use strict";

const os = require("os");
const fs = require("fs");
const crypto = require("crypto");
const express = require("express");
const multer = require("multer");
const { db, encrypt, decrypt } = require("../db");
const { requireInvoice, requireChief, isChief } = require("../auth");
const {
  listProjectManagers, getWorker, listTasksForWorker, listSessionsForWorker, setTaskPayout, taskTypeLabel, syncManagerToParty, ensurePartyForManager, formatPhone,
  listWorkerFiles, getWorkerFile, upsertWorkerFile, deleteWorkerFile,
  listSessionPayoutsForWorker, setSessionEngineerPayout,
} = require("../data");
const storage = require("../storage");
const { asyncHandler } = require("../lib/async");
const { layout, pageHeader, esc, flashBanner, emptyState, errorPage, formatKRW, tabBar, explain } = require("../views");
const { TASK_STATUS_LABELS, TASK_STATUS_BADGE, SESSION_STATUS_BADGE } = require("../config");
const { formatYmdShort } = require("../lib/date");

const router = express.Router();
// 권한 분리(2026-07-03, 사용자 결정): 열람·상세·정산(지급 처리/취소) = 치프·대표(requireInvoice, 재무 성격),
// 마스터(추가·삭제·정보수정) = 치프(requireChief). 스태프는 /workers 미노출 — 외주 지급단가(worker_rate)는
// 작업 편집(requireEditor)에서 입력하고, 실제 지급/정산은 대표·치프가 이 화면에서 실행한다.

// 첨부 서류 업로드(2026-07-06, clients.routes와 동일 패턴 — 디스크 multer + 매직바이트 검증).
const upload = multer({
  storage: multer.diskStorage({
    destination: (_req, _file, cb) => cb(null, os.tmpdir()),
    filename: (_req, _file, cb) => cb(null, "omgwf_" + crypto.randomBytes(8).toString("hex")),
  }),
  limits: { fileSize: 10 * 1024 * 1024 },
});

/** multipart 파일명 latin1 → UTF-8 복원(한글 파일명 보존). */
function decodeName(name) {
  try { return Buffer.from(String(name || ""), "latin1").toString("utf8"); } catch { return String(name || ""); }
}

/** 파일 첫 4바이트 매직바이트로 실제 형식 검증(Content-Type 스푸핑 방어). PNG·JPEG·PDF만 허용. */
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

/** 첨부 서류 종류 목록(화이트리스트) — 주민등록증 사본·통장사본(2026-07-06 사용자 요청, 외주 정산·본인확인용). */
const FILE_KINDS = [
  { key: "id_card", label: "주민등록증 사본" },
  { key: "bankbook", label: "통장사본" },
];

/** 첨부 서류 업로드·교체 UI(clients.routes의 clientFileSection과 동일 구조). */
function workerFileSection(w, fileMap, fileErr, fileOk = {}) {
  const rows = FILE_KINDS.map(({ key, label }) => {
    const existing = fileMap[key];
    const ok = existing && fileOk[key] !== false;
    const backendTag = existing
      ? (existing.storage_backend === "drive" ? `<span class="text-xs text-muted">Drive</span>` : `<span class="text-xs text-warning" title="Drive 업로드 실패로 로컬(서버 디스크)에 저장됨">로컬 저장</span>`)
      : "";
    const existingRow = existing && ok
      ? `<div class="mb-2 flex flex-wrap items-center gap-3 text-sm">
            <a href="/workers/${w.id}/files/${key}/raw" target="_blank" rel="noopener" class="font-medium text-primary hover:underline">${esc(label)} 보기</a>
            <span class="max-w-[12rem] truncate text-xs text-muted">${esc(existing.file_name)}</span>
            ${backendTag}
            <form method="post" action="/workers/${w.id}/files/${key}/delete" class="inline" data-confirm="${esc(label)}을 삭제할까요?">
              <button class="text-xs text-danger hover:underline" type="submit">삭제</button>
            </form>
          </div>`
      : existing && !ok
        ? `<div class="mb-2 flex flex-wrap items-center gap-3 text-sm">
            <span class="text-danger">⚠️ 파일을 찾을 수 없습니다</span>
            <span class="max-w-[12rem] truncate text-xs text-muted">${esc(existing.file_name)}</span>
            <form method="post" action="/workers/${w.id}/files/${key}/delete" class="inline" data-confirm="깨진 첨부 기록을 지울까요?">
              <button class="text-xs text-danger hover:underline" type="submit">기록 삭제</button>
            </form>
          </div>`
        : "";
    return `
    <div>
      <label class="label">${esc(label)}</label>
      ${existingRow}
      <form enctype="multipart/form-data" method="post" action="/workers/${w.id}/files/${key}" class="flex items-center gap-2">
        <div class="flex-1" data-dropzone>
          <input type="file" name="file" accept="image/png,image/jpeg,application/pdf" class="sr-only" />
          <div class="input flex cursor-pointer select-none items-center py-2 text-sm text-muted" data-dropzone-display tabindex="0" role="button" aria-label="파일 찾기 또는 붙여넣기(Ctrl+V)">
            <span data-dropzone-label>${existing && ok ? "다른 파일로 교체 — 클릭 또는 붙여넣기(Ctrl+V)" : "클릭해서 파일 찾기 · 또는 붙여넣기(Ctrl+V)"}</span>
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
      ${explain(`PNG · JPG · PDF · 최대 10MB. 치프 인증 열람(공개 링크 없음).`)}
    </div>
    ${fileErr ? `<p class="rounded-lg bg-danger/10 px-3 py-2 text-sm text-danger">${esc(fileErr)}</p>` : ""}
    ${rows}
  </section>`;
}

// ── 외주 작업자 목록(치프는 추가 폼도) ──
router.get("/", requireInvoice, (req, res) => {
  const workers = listProjectManagers({ includeInactive: true, externalOnly: true });
  // 카드 밑 지급 요약 줄(2026-07-06 사용자 요청) — 미지급 건수·금액 한 줄(작업+세션 합산) + 오른쪽 끝 일괄 지급처리.
  // 소수 외주 작업자 대상 N+1은 무해(listTasksForWorker/listSessionPayoutsForWorker 재사용, 페이지당 소수).
  const list = workers.length
    ? workers
        .map((w) => {
          const tasks = listTasksForWorker(w);
          const sessionPayouts = listSessionPayoutsForWorker(w);
          const unpaid = tasks.filter((t) => !t.worker_paid && t.worker_rate > 0);
          const unpaidSessions = sessionPayouts.filter((s) => !s.worker_paid && s.worker_rate > 0);
          const unpaidAmt = unpaid.reduce((s, t) => s + (t.worker_rate || 0), 0) + unpaidSessions.reduce((s, x) => s + (x.worker_rate || 0), 0);
          const unpaidCount = unpaid.length + unpaidSessions.length;
          const payoutBar = unpaidCount
            ? `<div class="mt-1.5 flex items-center justify-between gap-2 border-t border-border pt-1.5 text-sm">
                <span class="text-muted">미지급 <b class="text-danger">${formatKRW(unpaidAmt)}</b> (${unpaidCount}건)</span>
                <form method="post" action="/workers/${w.id}/payout-all" data-confirm="미지급 ${unpaidCount}건 · ${esc(formatKRW(unpaidAmt))}을 전부 지급 처리할까요?">
                  <button class="btn-ghost btn-xs text-primary" type="submit">지급처리</button>
                </form>
              </div>`
            : "";
          return `
        <div class="card mb-2">
          <a href="/workers/${w.id}" class="flex items-center justify-between gap-3 hover:opacity-80">
            <div class="min-w-0">
              <span class="font-semibold">${esc(w.name)}</span>
              ${w.email || w.phone ? `<div class="mt-0.5 text-xs text-muted">${esc(w.email || "")}${w.email && w.phone ? " · " : ""}${esc(w.phone || "")}</div>` : ""}
            </div>
            <span class="shrink-0 text-xs text-muted">작업 · 정산 ›</span>
          </a>
          ${payoutBar}
        </div>`;
        })
        .join("")
    : emptyState(`등록된 외주 작업자가 없습니다.${isChief(req.user) ? " 아래에서 추가하세요." : ""}`, { card: true });

  const addForm = `
    <form method="post" action="/workers" class="card mt-3 space-y-2">
      <div class="text-sm font-medium">외주 작업자 추가</div>
      <div class="grid gap-2 sm:grid-cols-3">
        <input class="input py-1.5 text-sm" name="worker_name" placeholder="이름 (작업 담당자 표시명)" autocomplete="off" required />
        <input class="input py-1.5 text-sm" name="email" placeholder="이메일(선택)" />
        <input class="input py-1.5 text-sm" name="phone" autocomplete="off" placeholder="전화(선택)" />
      </div>
      <button class="btn-primary btn-sm" type="submit">추가</button>
    </form>`;

  const body = `
    ${flashBanner(req.query)}
    ${pageHeader({ title: "외주 작업자", desc: "로그인 없이 작업 담당자로 쓰는 외부 인력. 작업 히스토리·정산 관리." })}
    ${list}
    ${isChief(req.user) ? addForm : ""}`;
  res.send(layout({ title: "외주 작업자", user: req.user, current: "/workers", body }));
});

router.post("/", requireChief, (req, res) => {
  const name = String(req.body.worker_name != null ? req.body.worker_name : req.body.name || "").trim(); // 폼 필드=worker_name(자동완성 회피)
  if (name) {
    const info = db()
      .prepare("INSERT INTO project_managers (name, email, phone, active) VALUES (?, ?, ?, 1)")
      .run(name, String(req.body.email || "").trim() || null, formatPhone(req.body.phone));
    ensurePartyForManager(info.lastInsertRowid); // 새 외주 작업자 → 연동 연락처+성·이름 자동 생성
  }
  res.redirect("/workers?flash=created");
});

router.post("/:id/delete", requireChief, (req, res) => {
  db().prepare("DELETE FROM project_managers WHERE id = ? AND user_id IS NULL").run(Number(req.params.id));
  res.redirect("/workers?flash=deleted");
});

// 외주 작업자 정보 수정(이름·전화·이메일·정산 정보) — 치프만(마스터 관리). user_id IS NULL로 외주만.
// 주민등록번호·계좌번호는 암호화 저장(db.encrypt) — DB 유출 시에도 평문 노출 방지(2026-07-06 사용자 요청).
router.post("/:id/edit", requireChief, (req, res) => {
  const id = Number(req.params.id);
  const name = String(req.body.worker_name != null ? req.body.worker_name : req.body.name || "").trim(); // 폼 필드=worker_name(자동완성 회피)
  if (name) {
    db()
      .prepare(
        "UPDATE project_managers SET name=?, email=?, phone=?, id_number=?, bank_name=?, account_number=?, account_holder=? WHERE id=? AND user_id IS NULL"
      )
      .run(
        name,
        String(req.body.email || "").trim() || null,
        formatPhone(req.body.phone),
        encrypt(String(req.body.id_number || "").trim() || null),
        String(req.body.bank_name || "").trim() || null,
        encrypt(String(req.body.account_number || "").trim() || null),
        String(req.body.account_holder || "").trim() || null,
        id
      );
    db().prepare("UPDATE track_tasks SET engineer_name = ? WHERE engineer_id = ?").run(name, id); // 이름 변경 시 작업 스냅샷 동기화(정산 매칭 유지)
    syncManagerToParty(id); // 전화·이메일 → 연동 연락처 동기화
    ensurePartyForManager(id); // 미연결이면 연락처 생성·연결(+성·이름 백필)
  }
  res.redirect(`/workers/${id}?flash=saved`);
});

// ── 외주 작업자 상세(작업 히스토리 / 정산) ──
router.get("/:id", requireInvoice, asyncHandler(async (req, res) => {
  const w = getWorker(Number(req.params.id));
  if (!w) return res.status(404).send(errorPage({ code: 404, title: "외주 작업자를 찾을 수 없습니다", message: "삭제되었거나 주소가 잘못되었습니다.", user: req.user }));
  const tab = req.query.tab === "payout" ? "payout" : "tasks";
  const tasks = listTasksForWorker(w);
  const sessions = listSessionsForWorker(w); // 세션 참여(2026-07-06 — 작업만 뜨고 세션 참여가 안 뜨던 것 개선).
  const sessionPayouts = listSessionPayoutsForWorker(w); // 세션 정산 대상(session_engineers에 실제 배정+지급단가 있는 것만, 2026-07-06 사용자 상담)

  const tabBarHtml = tabBar({
    tabs: [{ key: "tasks", label: `참여 내역 ${tasks.length + sessions.length}` }, { key: "payout", label: `정산 ${tasks.length + sessionPayouts.length}` }],
    activeKey: tab,
    hrefFn: (key) => `/workers/${w.id}?tab=${key}`,
  });

  const taskMeta = (t) => `<span class="text-xs text-muted"> · ${esc(t.project_title)} / ${esc(t.track_title)}</span>`;

  let content;
  if (tab === "payout") {
    if (!tasks.length && !sessionPayouts.length) {
      content = emptyState("담당한 작업·세션 정산 대상이 없습니다.", { card: true });
    } else {
      // 정산 합계 = 작업(worker_rate) + 세션(worker_rate) 통합. 고객청구(total_price)는 작업만 마진 가시화용 참고 표기.
      const taskPayTotal = tasks.reduce((s, t) => s + (t.worker_rate || 0), 0);
      const taskPaid = tasks.filter((t) => t.worker_paid).reduce((s, t) => s + (t.worker_rate || 0), 0);
      const sessPayTotal = sessionPayouts.reduce((s, x) => s + (x.worker_rate || 0), 0);
      const sessPaid = sessionPayouts.filter((x) => x.worker_paid).reduce((s, x) => s + (x.worker_rate || 0), 0);
      const payTotal = taskPayTotal + sessPayTotal;
      const paid = taskPaid + sessPaid;
      const unpaid = payTotal - paid;
      const clientTotal = tasks.reduce((s, t) => s + (t.total_price || 0), 0);
      const summary = `<div class="card mb-3 flex flex-wrap gap-4 text-sm">
          <span>지급 합계 <b class="text-fg">${formatKRW(payTotal)}</b></span>
          <span>지급완료 <b class="text-success">${formatKRW(paid)}</b></span>
          <span>미지급 <b class="${unpaid > 0 ? "text-danger" : "text-fg"}">${formatKRW(unpaid)}</b></span>
          <span class="text-muted">고객청구 ${formatKRW(clientTotal)} (참고)</span>
        </div>`;
      const taskRows = tasks
        .map(
          (t) => `
          <div class="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-border bg-surface p-2.5">
            <div class="min-w-0 text-sm">
              <span class="font-medium">${esc(taskTypeLabel(t.task_type))}</span>${taskMeta(t)}
              ${t.worker_paid ? `<span class="badge ml-1 bg-success/10 text-success">지급완료 ${esc(t.worker_paid_date || "")}</span>` : `<span class="badge ml-1 bg-warning/10 text-warning">미지급</span>`}
            </div>
            <div class="flex shrink-0 items-center gap-2">
              <span class="text-sm font-semibold">${formatKRW(t.worker_rate || 0)}</span>
              ${t.total_price ? `<span class="text-xs text-muted">/ 고객 ${formatKRW(t.total_price)}</span>` : ""}
              <form method="post" action="/workers/${w.id}/payout/${t.id}">
                <button class="btn-ghost btn-xs ${t.worker_paid ? "text-muted" : "text-primary"}" type="submit">${t.worker_paid ? "지급 취소" : "지급 처리"}</button>
              </form>
            </div>
          </div>`
        )
        .join("");
      // 세션 정산 행(2026-07-06 신설) — 작업 행과 동일 톤, 라벨만 세션 종류+날짜.
      const sessionRows = sessionPayouts
        .map(
          (s) => `
          <div class="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-border bg-surface p-2.5">
            <div class="min-w-0 text-sm">
              <span class="font-medium">${esc(s.session_type || "녹음")} 세션</span><span class="text-xs text-muted"> · ${esc(s.project_title)} / ${esc(formatYmdShort(s.session_date))}</span>
              ${s.worker_paid ? `<span class="badge ml-1 bg-success/10 text-success">지급완료 ${esc(s.worker_paid_date || "")}</span>` : `<span class="badge ml-1 bg-warning/10 text-warning">미지급</span>`}
            </div>
            <div class="flex shrink-0 items-center gap-2">
              <span class="text-sm font-semibold">${formatKRW(s.worker_rate || 0)}</span>
              <form method="post" action="/workers/${w.id}/session-payout/${s.session_id}">
                <button class="btn-ghost btn-xs ${s.worker_paid ? "text-muted" : "text-primary"}" type="submit">${s.worker_paid ? "지급 취소" : "지급 처리"}</button>
              </form>
            </div>
          </div>`
        )
        .join("");
      content = summary + `<div class="space-y-2">${taskRows}${sessionRows}</div>`;
    }
  } else if (!tasks.length && !sessions.length) {
    content = emptyState("담당한 작업·세션이 없습니다.", { card: true });
  } else {
    const taskRows = tasks
      .map(
        (t) => `
        <a href="/projects/${t.project_id}?tab=tracks" class="flex items-center justify-between gap-2 rounded-lg border border-border bg-surface p-2.5 hover:opacity-80">
          <div class="min-w-0 text-sm"><span class="font-medium">${esc(taskTypeLabel(t.task_type))}</span>${taskMeta(t)}</div>
          <div class="flex shrink-0 items-center gap-2">
            <span class="badge ${TASK_STATUS_BADGE[t.status] || "bg-muted/10 text-muted"}">${esc(TASK_STATUS_LABELS[t.status] || t.status)}</span>
            ${t.total_price ? `<span class="text-sm font-semibold">${formatKRW(t.total_price)}</span>` : ""}
          </div>
        </a>`
      )
      .join("");
    // 세션 참여(2026-07-06 신설) — 정산 대상이 아니라 배지·금액 없이 참고 표기만.
    const sessionRows = sessions
      .map(
        (s) => `
        <a href="/projects/${s.project_id}?tab=sessions" class="flex items-center justify-between gap-2 rounded-lg border border-border bg-surface p-2.5 hover:opacity-80">
          <div class="min-w-0 text-sm"><span class="font-medium">${esc(s.session_type || "녹음")} 세션</span> <span class="text-xs text-muted">· ${esc(s.project_title)} · ${esc(formatYmdShort(s.session_date))}</span></div>
          <span class="badge shrink-0 ${SESSION_STATUS_BADGE[s.status] || "bg-muted/10 text-muted"}">${esc(s.status)}</span>
        </a>`
      )
      .join("");
    const taskSection = tasks.length ? `<div><div class="mb-1.5 text-xs font-medium text-muted">작업 ${tasks.length}</div><div class="space-y-2">${taskRows}</div></div>` : "";
    const sessionSection = sessions.length ? `<div class="${tasks.length ? "mt-4" : ""}"><div class="mb-1.5 text-xs font-medium text-muted">세션 ${sessions.length}</div><div class="space-y-2">${sessionRows}</div></div>` : "";
    content = taskSection + sessionSection;
  }

  const editForm = isChief(req.user)
    ? `<details class="card mb-3">
        <summary class="cursor-pointer text-sm font-medium text-muted hover:text-fg">정보 수정 (이름 · 전화 · 이메일 · 정산 정보)</summary>
        <form method="post" action="/workers/${w.id}/edit" class="mt-3 grid gap-2 sm:grid-cols-3">
          <input class="input py-1.5 text-sm" name="worker_name" value="${esc(w.name || "")}" placeholder="이름" autocomplete="off" required />
          <input class="input py-1.5 text-sm" name="email" value="${esc(w.email || "")}" placeholder="이메일" />
          <input class="input py-1.5 text-sm" name="phone" autocomplete="off" value="${esc(w.phone || "")}" placeholder="전화" />
          <input class="input py-1.5 text-sm sm:col-span-3" name="id_number" value="${esc(decrypt(w.id_number) || "")}" placeholder="주민등록번호 또는 사업자등록번호" autocomplete="off" />
          <input class="input py-1.5 text-sm" name="bank_name" value="${esc(w.bank_name || "")}" placeholder="은행" autocomplete="off" />
          <input class="input py-1.5 text-sm" name="account_number" value="${esc(decrypt(w.account_number) || "")}" placeholder="계좌번호" autocomplete="off" />
          <input class="input py-1.5 text-sm" name="account_holder" value="${esc(w.account_holder || "")}" placeholder="입금자명(예금주)" autocomplete="off" />
          ${explain(`주민등록번호·계좌번호는 암호화해 저장됩니다. 정산(지급) 시 참고용 — 세금신고·이체에 사용하세요.`)}
          <button class="btn-primary btn-sm sm:col-span-3" type="submit">저장</button>
        </form>
      </details>`
    : "";

  // 첨부 서류(주민등록증 사본·통장사본) — 치프만(민감정보, 2026-07-06 사용자 요청).
  let filesBlock = "";
  if (isChief(req.user)) {
    const files = listWorkerFiles(w.id);
    const fileMap = {};
    files.forEach((f) => { fileMap[f.kind] = f; });
    const fileOk = {};
    for (const f of files) {
      try { fileOk[f.kind] = await storage.exists(f.storage_backend, f.file_id); } catch { fileOk[f.kind] = true; } // 확인 실패는 있음으로 간주(유효 파일 숨김 방지)
    }
    const fileErr = req.query.ferr ? String(req.query.ferr) : "";
    filesBlock = workerFileSection(w, fileMap, fileErr, fileOk);
  }

  const body = `
    ${flashBanner(req.query)}
    ${pageHeader({ title: w.name, desc: "외주 작업자", back: { href: "/workers", label: "외주 작업자" }, action: isChief(req.user) ? `<form method="post" action="/workers/${w.id}/delete" data-confirm="${esc(w.name)} 외주 작업자를 삭제할까요?"><button class="btn-ghost btn-sm text-danger" type="submit">작업자 삭제</button></form>` : "" })}
    ${editForm}
    ${filesBlock}
    ${tabBarHtml}
    ${content}`;
  res.send(layout({ title: w.name, user: req.user, current: "/workers", body }));
}));

// ── 작업 지급 처리/해제(정산) ──
router.post("/:id/payout/:taskId", requireInvoice, (req, res) => {
  const w = getWorker(Number(req.params.id));
  if (!w) return res.status(404).send("외주 작업자를 찾을 수 없습니다.");
  // 소속 확인: engineer_id 우선(rename 내성), 폴백 (engineer_id IS NULL AND engineer_name = 이름)(레거시·미매칭분).
  const task = db()
    .prepare("SELECT id, worker_paid FROM track_tasks WHERE id = ? AND (engineer_id = ? OR (engineer_id IS NULL AND engineer_name = ?))")
    .get(Number(req.params.taskId), w.id, w.name);
  if (task) setTaskPayout(task.id, !task.worker_paid);
  res.redirect(`/workers/${w.id}?tab=payout`);
});

// ── 세션 지급 처리/해제(정산, 2026-07-06 사용자 상담 — 작업과 동일 구조) ──
router.post("/:id/session-payout/:sessionId", requireInvoice, (req, res) => {
  const w = getWorker(Number(req.params.id));
  if (!w) return res.status(404).send("외주 작업자를 찾을 수 없습니다.");
  const sessionId = Number(req.params.sessionId);
  const eng = db().prepare("SELECT worker_paid FROM session_engineers WHERE session_id = ? AND manager_id = ?").get(sessionId, w.id);
  if (eng) setSessionEngineerPayout(sessionId, w.id, !eng.worker_paid);
  res.redirect(`/workers/${w.id}?tab=payout`);
});

// ── 미지급 전체 일괄 지급 처리(목록 카드 요약 줄의 [지급처리] 버튼, 2026-07-06 사용자 요청) ──
router.post("/:id/payout-all", requireInvoice, (req, res) => {
  const w = getWorker(Number(req.params.id));
  if (!w) return res.status(404).send("외주 작업자를 찾을 수 없습니다.");
  const tasks = listTasksForWorker(w).filter((t) => !t.worker_paid && t.worker_rate > 0);
  tasks.forEach((t) => setTaskPayout(t.id, true));
  const sessionPayouts = listSessionPayoutsForWorker(w).filter((s) => !s.worker_paid && s.worker_rate > 0);
  sessionPayouts.forEach((s) => setSessionEngineerPayout(s.session_id, w.id, true));
  res.redirect("/workers?flash=saved");
});

// ── 첨부 서류 업로드(주민등록증 사본·통장사본) — 치프만(민감정보) ──
router.post("/:id/files/:kind", requireChief, upload.single("file"), asyncHandler(async (req, res) => {
  const id = Number(req.params.id);
  const kind = req.params.kind;
  const w = getWorker(id);
  if (!w) {
    if (req.file) fs.promises.unlink(req.file.path).catch(() => {});
    return res.status(404).send(errorPage({ code: 404, title: "외주 작업자를 찾을 수 없습니다", message: "", user: req.user }));
  }
  if (!FILE_KINDS.find((k) => k.key === kind)) {
    if (req.file) fs.promises.unlink(req.file.path).catch(() => {});
    return res.redirect(`/workers/${id}?ferr=${encodeURIComponent("알 수 없는 서류 종류입니다.")}`);
  }
  if (!req.file) return res.redirect(`/workers/${id}?ferr=${encodeURIComponent("파일을 선택하세요.")}`);

  const detectedMime = detectMimeFromFile(req.file.path);
  if (!detectedMime) {
    fs.promises.unlink(req.file.path).catch(() => {});
    return res.redirect(`/workers/${id}?ferr=${encodeURIComponent("PNG, JPG, PDF 파일만 업로드할 수 있습니다.")}`);
  }

  const originalName = decodeName(req.file.originalname);
  try {
    const kindLabel = FILE_KINDS.find((k) => k.key === kind).label;
    const { backend, fileId } = await storage.put({ filePath: req.file.path, name: originalName, mimeType: detectedMime, folder: kindLabel });
    const old = upsertWorkerFile(id, kind, { storage_backend: backend, file_id: fileId, file_name: originalName, mime_type: detectedMime, file_size: req.file.size });
    if (old) await storage.remove(old.storage_backend, old.file_id);
    res.redirect(`/workers/${id}?flash=saved`);
  } catch (e) {
    console.error("[worker file upload]", e);
    const msg = e && e.code === "DRIVE_UPLOAD_FAILED"
      ? "Google Drive 업로드에 실패했습니다 — 로컬에 저장하지 않았습니다. 잠시 후 다시 시도하세요."
      : "업로드에 실패했습니다.";
    res.redirect(`/workers/${id}?ferr=${encodeURIComponent(msg)}`);
  } finally {
    if (req.file) fs.promises.unlink(req.file.path).catch(() => {});
  }
}));

// ── 첨부 서류 인증 다운로드(치프 인증 후 프록시 — 공개 URL 없음) ──
router.get("/:id/files/:kind/raw", requireChief, asyncHandler(async (req, res) => {
  const id = Number(req.params.id);
  const kind = req.params.kind;
  if (!FILE_KINDS.find((k) => k.key === kind)) return res.status(404).send("파일을 찾을 수 없습니다.");
  const wf = getWorkerFile(id, kind);
  if (!wf) return res.status(404).send(errorPage({ code: 404, title: "파일이 없습니다", message: "아직 업로드된 파일이 없습니다.", user: req.user }));
  res.setHeader("Cache-Control", "private, no-store");
  res.setHeader("Content-Type", wf.mime_type || "application/octet-stream");
  res.setHeader("Content-Disposition", `inline; filename*=UTF-8''${encodeURIComponent(wf.file_name)}`);
  if (wf.file_size > 0) res.setHeader("Content-Length", wf.file_size);
  try {
    await storage.stream(wf.storage_backend, wf.file_id, res);
  } catch (e) {
    console.error("[worker file stream]", e);
    if (!res.headersSent) res.status(502).send("파일을 가져오지 못했습니다.");
    else res.destroy();
  }
}));

// ── 첨부 서류 삭제 ──
router.post("/:id/files/:kind/delete", requireChief, asyncHandler(async (req, res) => {
  const id = Number(req.params.id);
  const kind = req.params.kind;
  if (!FILE_KINDS.find((k) => k.key === kind)) return res.redirect(`/workers/${id}`);
  const old = deleteWorkerFile(id, kind);
  if (old) await storage.remove(old.storage_backend, old.file_id);
  res.redirect(`/workers/${id}?flash=deleted`);
}));

module.exports = router;
