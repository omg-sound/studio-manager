"use strict";

const express = require("express");
const { requireInvoice } = require("../auth");
const { revenueByEngineer, revenueForEngineer, taskTypeLabel } = require("../data");
const { layout, pageHeader, esc, emptyState, errorPage, formatKRW, listGroup, listRow } = require("../views");

const router = express.Router();

// ── 엔지니어별 매출 목록(대표·치프 전용) ──
router.get("/", requireInvoice, (req, res) => {
  const rows = revenueByEngineer();

  const listHtml = rows.length
    ? listGroup({
        rows: rows.map((r) =>
          listRow({
            href: `/revenue/${r.id}`,
            left: `<span class="font-semibold">${esc(r.name)}</span>${r.is_external ? ` <span class="badge badge-neutral ml-1.5">외주</span>` : ""}
              <div class="mt-0.5 text-xs text-muted">작업 ${r.task_cnt}건 · 세션 ${r.session_cnt}건</div>`,
            right: `<span class="font-semibold">${formatKRW(r.total)}</span>`,
          })
        ),
      })
    : emptyState("매출 내역이 있는 엔지니어가 없습니다.", { card: true });

  const body = `
    ${pageHeader({ title: "매출", desc: "담당 엔지니어별 작업·세션 고객 청구액 합계." })}
    ${listHtml}`;
  res.send(layout({ title: "매출", user: req.user, current: "/revenue", body })); // 읽기 폭(2026-07-16 사용자 '폭 넓어 시선 분산')
});

// ── 엔지니어 매출 상세 ──
router.get("/:id", requireInvoice, (req, res) => {
  const data = revenueForEngineer(Number(req.params.id));
  if (!data) {
    return res.status(404).send(
      errorPage({ code: 404, title: "엔지니어를 찾을 수 없습니다", message: "삭제되었거나 주소가 잘못되었습니다.", user: req.user })
    );
  }

  const { manager, tasks, sessions, task_total, session_total, total } = data;

  const summaryCard = `
    <div class="card mb-4 flex flex-wrap gap-4 text-sm">
      <span>작업 매출 <b class="text-fg">${formatKRW(task_total)}</b></span>
      <span>세션 매출 <b class="text-fg">${formatKRW(session_total)}</b></span>
      <span class="font-semibold">합계 <b class="text-fg">${formatKRW(total)}</b></span>
    </div>`;

  const taskSection = tasks.length
    ? listGroup({
        rows: tasks.map((t) =>
          listRow({
            href: `/projects/${t.project_id}?tab=tracks`,
            left: `<span class="font-medium">${esc(taskTypeLabel(t.task_type))}</span>
              <span class="text-xs text-muted ml-1"> · ${esc(t.project_title)} / ${esc(t.track_title)}</span>
              ${t.is_invoiced ? `<span class="badge badge-info ml-1.5">청구완료</span>` : ""}`,
            right: formatKRW(t.total_price || 0),
          })
        ),
      })
    : emptyState("담당 작업이 없습니다.", { card: true });

  const sessionSection = sessions.length
    ? listGroup({
        rows: sessions.map((s) =>
          listRow({
            href: `/projects/${s.project_id}?tab=sessions`,
            left: `<span class="font-medium">${esc(s.session_date)} ${esc(s.session_type)}</span>
              <span class="text-xs text-muted ml-1"> · ${esc(s.project_title)}</span>`,
            right: formatKRW(s.amount),
          })
        ),
      })
    : emptyState("담당 세션이 없습니다.", { card: true });

  const desc = manager.user_id ? "하우스 엔지니어" : "외주 작업자";
  const body = `
    ${pageHeader({ title: manager.name, desc, back: { href: "/revenue", label: "매출" } })}
    ${summaryCard}
    <h2 class="mb-2 mt-4 text-sm font-semibold text-muted">작업 내역 (${tasks.length}건)</h2>
    ${taskSection}
    <h2 class="mb-2 mt-4 text-sm font-semibold text-muted">세션 내역 (${sessions.length}건)</h2>
    ${sessionSection}`;
  res.send(layout({ title: manager.name, user: req.user, current: "/revenue", body }));
});

module.exports = router;
