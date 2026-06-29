"use strict";

const express = require("express");
const { db } = require("../db");
const { requireChief } = require("../auth");
const { listProjectManagers, getWorker, listTasksForWorker, setTaskPayout, taskTypeLabel } = require("../data");
const { layout, pageHeader, esc, flashBanner, emptyState, errorPage, formatKRW } = require("../views");
const { TASK_STATUS_LABELS, TASK_STATUS_BADGE } = require("../config");

const router = express.Router();
router.use(requireChief); // 외주 작업자 관리·정산은 치프 전용

// ── 외주 작업자 목록 + 추가 ──
router.get("/", (req, res) => {
  const workers = listProjectManagers({ includeInactive: true, externalOnly: true });
  const list = workers.length
    ? workers
        .map(
          (w) => `
        <a href="/workers/${w.id}" class="card mb-2 flex items-center justify-between gap-3 hover:opacity-80">
          <div class="min-w-0">
            <span class="font-semibold">${esc(w.name)}</span>
            ${w.email || w.phone ? `<div class="mt-0.5 text-xs text-muted">${esc(w.email || "")}${w.email && w.phone ? " · " : ""}${esc(w.phone || "")}</div>` : ""}
          </div>
          <span class="shrink-0 text-xs text-muted">작업 · 정산 ›</span>
        </a>`
        )
        .join("")
    : emptyState("등록된 외주 작업자가 없습니다. 아래에서 추가하세요.", { card: true });

  const addForm = `
    <form method="post" action="/workers" class="card mt-3 space-y-2">
      <div class="text-sm font-medium">외주 작업자 추가</div>
      <div class="grid gap-2 sm:grid-cols-3">
        <input class="input py-1.5 text-sm" name="name" placeholder="이름 (작업 담당자 표시명)" required />
        <input class="input py-1.5 text-sm" name="email" placeholder="이메일(선택)" />
        <input class="input py-1.5 text-sm" name="phone" placeholder="전화(선택)" />
      </div>
      <button class="btn-primary btn-sm" type="submit">추가</button>
    </form>`;

  const body = `
    ${flashBanner(req.query)}
    ${pageHeader({ title: "외주 작업자", desc: "로그인 없이 작업 담당자로 쓰는 외부 인력. 작업 히스토리·정산 관리." })}
    ${list}
    ${addForm}`;
  res.send(layout({ title: "외주 작업자", user: req.user, current: "/workers", body }));
});

router.post("/", (req, res) => {
  const name = String(req.body.name || "").trim();
  if (name) {
    db()
      .prepare("INSERT INTO project_managers (name, email, phone, active) VALUES (?, ?, ?, 1)")
      .run(name, String(req.body.email || "").trim() || null, String(req.body.phone || "").trim() || null);
  }
  res.redirect("/workers?flash=created");
});

router.post("/:id/delete", (req, res) => {
  db().prepare("DELETE FROM project_managers WHERE id = ? AND user_id IS NULL").run(Number(req.params.id));
  res.redirect("/workers?flash=deleted");
});

// ── 외주 작업자 상세(작업 히스토리 / 정산) ──
router.get("/:id", (req, res) => {
  const w = getWorker(Number(req.params.id));
  if (!w) return res.status(404).send(errorPage({ code: 404, title: "외주 작업자를 찾을 수 없습니다", message: "삭제되었거나 주소가 잘못되었습니다.", user: req.user }));
  const tab = req.query.tab === "payout" ? "payout" : "tasks";
  const tasks = listTasksForWorker(w);

  const tabLink = (key, label, n) =>
    `<a href="/workers/${w.id}?tab=${key}" class="shrink-0 border-b-2 px-4 py-2 text-sm ${tab === key ? "border-primary font-semibold text-fg" : "border-transparent text-muted hover:text-fg"}">${label} ${n}</a>`;
  const tabBar = `<div class="mb-3 mt-3 flex gap-1 overflow-x-auto border-b border-border">${tabLink("tasks", "작업 히스토리", tasks.length)}${tabLink("payout", "정산", tasks.length)}</div>`;

  const taskMeta = (t) => `<span class="text-xs text-muted"> · ${esc(t.project_title)} / ${esc(t.track_title)}</span>`;

  let content;
  if (!tasks.length) {
    content = emptyState("담당한 작업이 없습니다.", { card: true });
  } else if (tab === "payout") {
    const total = tasks.reduce((s, t) => s + (t.total_price || 0), 0);
    const paid = tasks.filter((t) => t.worker_paid).reduce((s, t) => s + (t.total_price || 0), 0);
    const unpaid = total - paid;
    const summary = `<div class="card mb-3 flex flex-wrap gap-4 text-sm">
        <span>작업 합계 <b class="text-fg">${formatKRW(total)}</b></span>
        <span>지급완료 <b class="text-success">${formatKRW(paid)}</b></span>
        <span>미지급 <b class="${unpaid > 0 ? "text-danger" : "text-fg"}">${formatKRW(unpaid)}</b></span>
      </div>`;
    const rows = tasks
      .map(
        (t) => `
        <div class="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-border bg-surface p-2.5">
          <div class="min-w-0 text-sm">
            <span class="font-medium">${esc(taskTypeLabel(t.task_type))}</span>${taskMeta(t)}
            ${t.worker_paid ? `<span class="badge ml-1 bg-success/10 text-success">지급완료 ${esc(t.worker_paid_date || "")}</span>` : `<span class="badge ml-1 bg-warning/10 text-warning">미지급</span>`}
          </div>
          <div class="flex shrink-0 items-center gap-2">
            <span class="text-sm font-semibold">${formatKRW(t.total_price)}</span>
            <form method="post" action="/workers/${w.id}/payout/${t.id}">
              <button class="btn-ghost btn-xs ${t.worker_paid ? "text-muted" : "text-primary"}" type="submit">${t.worker_paid ? "지급 취소" : "지급 처리"}</button>
            </form>
          </div>
        </div>`
      )
      .join("");
    content = summary + `<div class="space-y-2">${rows}</div>`;
  } else {
    const rows = tasks
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
    content = `<div class="space-y-2">${rows}</div>`;
  }

  const body = `
    ${flashBanner(req.query)}
    ${pageHeader({ title: esc(w.name), desc: "외주 작업자", action: `<form method="post" action="/workers/${w.id}/delete" data-confirm="${esc(w.name)} 외주 작업자를 삭제할까요?"><button class="btn-ghost btn-sm text-danger" type="submit">작업자 삭제</button></form>` })}
    ${tabBar}
    ${content}`;
  res.send(layout({ title: w.name, user: req.user, current: "/workers", body }));
});

// ── 작업 지급 처리/해제(정산) ──
router.post("/:id/payout/:taskId", (req, res) => {
  const w = getWorker(Number(req.params.id));
  if (!w) return res.status(404).send("외주 작업자를 찾을 수 없습니다.");
  const task = db().prepare("SELECT id, worker_paid FROM track_tasks WHERE id = ? AND engineer_name = ?").get(Number(req.params.taskId), w.name);
  if (task) setTaskPayout(task.id, !task.worker_paid);
  res.redirect(`/workers/${w.id}?tab=payout`);
});

module.exports = router;
