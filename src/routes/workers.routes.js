"use strict";

const express = require("express");
const { db } = require("../db");
const { requireInvoice, requireChief, isChief } = require("../auth");
const { listProjectManagers, getWorker, listTasksForWorker, setTaskPayout, taskTypeLabel, syncManagerToParty, ensurePartyForManager, formatPhone } = require("../data");
const { layout, pageHeader, esc, flashBanner, emptyState, errorPage, formatKRW, tabBar } = require("../views");
const { TASK_STATUS_LABELS, TASK_STATUS_BADGE } = require("../config");

const router = express.Router();
// 권한 분리(2026-07-03, 사용자 결정): 열람·상세·정산(지급 처리/취소) = 치프·대표(requireInvoice, 재무 성격),
// 마스터(추가·삭제·정보수정) = 치프(requireChief). 스태프는 /workers 미노출 — 외주 지급단가(worker_rate)는
// 작업 편집(requireEditor)에서 입력하고, 실제 지급/정산은 대표·치프가 이 화면에서 실행한다.

// ── 외주 작업자 목록(치프는 추가 폼도) ──
router.get("/", requireInvoice, (req, res) => {
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
    : emptyState(`등록된 외주 작업자가 없습니다.${isChief(req.user) ? " 아래에서 추가하세요." : ""}`, { card: true });

  const addForm = `
    <form method="post" action="/workers" class="card mt-3 space-y-2">
      <div class="text-sm font-medium">외주 작업자 추가</div>
      <div class="grid gap-2 sm:grid-cols-3">
        <input class="input py-1.5 text-sm" name="name" placeholder="이름 (작업 담당자 표시명)" required />
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
  const name = String(req.body.name || "").trim();
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

// 외주 작업자 정보 수정(이름·전화·이메일) — 치프만(마스터 관리). user_id IS NULL로 외주만.
router.post("/:id/edit", requireChief, (req, res) => {
  const id = Number(req.params.id);
  const name = String(req.body.name || "").trim();
  if (name) {
    db().prepare("UPDATE project_managers SET name = ?, email = ?, phone = ? WHERE id = ? AND user_id IS NULL")
      .run(name, String(req.body.email || "").trim() || null, formatPhone(req.body.phone), id);
    db().prepare("UPDATE track_tasks SET engineer_name = ? WHERE engineer_id = ?").run(name, id); // 이름 변경 시 작업 스냅샷 동기화(정산 매칭 유지)
    syncManagerToParty(id); // 전화·이메일 → 연동 연락처 동기화
    ensurePartyForManager(id); // 미연결이면 연락처 생성·연결(+성·이름 백필)
  }
  res.redirect(`/workers/${id}?flash=saved`);
});

// ── 외주 작업자 상세(작업 히스토리 / 정산) ──
router.get("/:id", requireInvoice, (req, res) => {
  const w = getWorker(Number(req.params.id));
  if (!w) return res.status(404).send(errorPage({ code: 404, title: "외주 작업자를 찾을 수 없습니다", message: "삭제되었거나 주소가 잘못되었습니다.", user: req.user }));
  const tab = req.query.tab === "payout" ? "payout" : "tasks";
  const tasks = listTasksForWorker(w);

  const tabBarHtml = tabBar({
    tabs: [{ key: "tasks", label: `작업 히스토리 ${tasks.length}` }, { key: "payout", label: `정산 ${tasks.length}` }],
    activeKey: tab,
    hrefFn: (key) => `/workers/${w.id}?tab=${key}`,
  });

  const taskMeta = (t) => `<span class="text-xs text-muted"> · ${esc(t.project_title)} / ${esc(t.track_title)}</span>`;

  let content;
  if (!tasks.length) {
    content = emptyState("담당한 작업이 없습니다.", { card: true });
  } else if (tab === "payout") {
    // 정산 합계는 외주 지급단가(worker_rate) 기준. 고객청구(total_price)는 마진 가시화용 참고 표기.
    const payTotal = tasks.reduce((s, t) => s + (t.worker_rate || 0), 0);
    const paid = tasks.filter((t) => t.worker_paid).reduce((s, t) => s + (t.worker_rate || 0), 0);
    const unpaid = payTotal - paid;
    const clientTotal = tasks.reduce((s, t) => s + (t.total_price || 0), 0);
    const summary = `<div class="card mb-3 flex flex-wrap gap-4 text-sm">
        <span>지급 합계 <b class="text-fg">${formatKRW(payTotal)}</b></span>
        <span>지급완료 <b class="text-success">${formatKRW(paid)}</b></span>
        <span>미지급 <b class="${unpaid > 0 ? "text-danger" : "text-fg"}">${formatKRW(unpaid)}</b></span>
        <span class="text-muted">고객청구 ${formatKRW(clientTotal)} (참고)</span>
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
            <span class="text-sm font-semibold">${formatKRW(t.worker_rate || 0)}</span>
            ${t.total_price ? `<span class="text-xs text-muted">/ 고객 ${formatKRW(t.total_price)}</span>` : ""}
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

  const editForm = isChief(req.user)
    ? `<details class="card mb-3">
        <summary class="cursor-pointer text-sm font-medium text-muted hover:text-fg">정보 수정 (이름 · 전화 · 이메일)</summary>
        <form method="post" action="/workers/${w.id}/edit" class="mt-3 grid gap-2 sm:grid-cols-3">
          <input class="input py-1.5 text-sm" name="name" value="${esc(w.name || "")}" placeholder="이름" required />
          <input class="input py-1.5 text-sm" name="email" value="${esc(w.email || "")}" placeholder="이메일" />
          <input class="input py-1.5 text-sm" name="phone" autocomplete="off" value="${esc(w.phone || "")}" placeholder="전화" />
          <button class="btn-primary btn-sm sm:col-span-3" type="submit">저장</button>
        </form>
      </details>`
    : "";
  const body = `
    ${flashBanner(req.query)}
    ${pageHeader({ title: w.name, desc: "외주 작업자", back: { href: "/workers", label: "외주 작업자" }, action: isChief(req.user) ? `<form method="post" action="/workers/${w.id}/delete" data-confirm="${esc(w.name)} 외주 작업자를 삭제할까요?"><button class="btn-ghost btn-sm text-danger" type="submit">작업자 삭제</button></form>` : "" })}
    ${editForm}
    ${tabBarHtml}
    ${content}`;
  res.send(layout({ title: w.name, user: req.user, current: "/workers", body }));
});

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

module.exports = router;
