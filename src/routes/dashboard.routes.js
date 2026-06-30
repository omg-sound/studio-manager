"use strict";

const express = require("express");
const { requireAuth } = require("../auth");
const { dashboardStats, upcomingSessions } = require("../data");
const { layout, pageHeader, esc, serviceBadges, formatKRW, emptyState } = require("../views");
const { ddayLabel, todayYmd, formatYmdShort } = require("../lib/date");

const router = express.Router();

router.get("/", requireAuth, (req, res) => {
  const user = req.user;
  const s = dashboardStats(user);
  const today = todayYmd();
  // 이번 주: 오늘부터 6일 이내(오늘 포함 7일)
  const weekEnd = (() => {
    const d = new Date(today + "T00:00:00Z");
    d.setUTCDate(d.getUTCDate() + 6);
    return d.toISOString().slice(0, 10);
  })();
  const allSessions = upcomingSessions(user, { limit: 30 });
  const todaySessions = allSessions.filter((ss) => ss.session_date === today);
  const weekSessions = allSessions.filter((ss) => ss.session_date >= today && ss.session_date <= weekEnd);

  const statCard = (label, value, sub = "") => `
    <div class="card border-l-2 [border-left-color:rgb(var(--color-primary))]">
      <div class="text-sm text-muted">${esc(label)}</div>
      <div class="mt-1 font-display text-xl font-bold tabular">${esc(String(value))}</div>
      ${sub ? `<div class="mt-1 text-xs text-muted">${esc(sub)}</div>` : ""}
    </div>`;

  const upcomingList = s.upcoming.length
    ? s.upcoming
        .map(
          (p) => `
      <a href="/projects/${p.id}" class="row-link flex items-center justify-between gap-3 border-b border-border py-3 last:border-0">
        <div class="min-w-0">
          <div class="truncate font-medium">${esc(p.title)}</div>
          <div class="mt-1 flex flex-wrap gap-1">${serviceBadges(p)}</div>
          <div class="text-xs text-muted">${esc(p.client_name || "실결제자 미지정")}</div>
        </div>
        <div class="flex shrink-0 items-center gap-2">
          <span class="text-xs tabular text-muted">${esc(ddayLabel(p.due_date))}</span>
        </div>
      </a>`
        )
        .join("")
    : emptyState("임박한 마감이 없습니다.");

  const moneyCard = (label, amount, danger = false, sub = "") => `
    <div class="card border-l-2 ${danger ? "[border-left-color:rgb(var(--color-danger))]" : "[border-left-color:rgb(var(--color-success))]"}">
      <div class="text-sm text-muted">${esc(label)}</div>
      <div class="mt-1 font-display text-xl font-bold tabular ${danger && amount > 0 ? "text-danger" : ""}">${formatKRW(amount)}</div>
      ${sub ? `<div class="mt-1 text-xs text-muted">${esc(sub)}</div>` : ""}
    </div>`;

  const inv = s.invoices; // 청구권자(치프/대표)만 존재, staff는 null
  const overdueBanner =
    inv && inv.overdueCount > 0
      ? `<a href="/invoices?f=연체" class="card mb-4 flex items-center justify-between border-danger/40 bg-danger/5">
           <span class="flex items-center gap-2 text-sm font-medium text-danger"><span class="inline-block h-2 w-2 rounded-full bg-danger"></span>연체 ${inv.overdueCount}건</span>
           <span class="text-sm font-bold text-danger">${formatKRW(inv.overdueAmount)}</span>
         </a>`
      : "";

  const cardItems = [];
  if (s.canInvoice) {
    cardItems.push(moneyCard("미수금", inv.receivable, true, "발행·미입금 잔금"));
    cardItems.push(moneyCard("이번 달 발행", inv.thisMonthIssued));
  }
  cardItems.push(statCard("프로젝트", s.total));
  if (s.isChief) cardItems.push(statCard("클라이언트", s.clients));
  if (!s.canInvoice) cardItems.push(statCard("임박한 마감", s.upcoming.length));
  const cols = cardItems.length >= 4 ? "sm:grid-cols-4" : cardItems.length === 3 ? "sm:grid-cols-3" : "";
  const cards = `<div class="grid grid-cols-2 gap-3 ${cols}">${cardItems.join("")}</div>`;

  const sessionList = weekSessions.length
    ? weekSessions
        .map(
          (ss) => `
      <a href="/projects/${ss.project_id}?tab=sessions" class="row-link flex items-center justify-between gap-3 border-b border-border py-2.5 last:border-0">
        <div class="min-w-0">
          <div class="truncate text-sm font-medium">${esc(ss.project_title)}</div>
          <div class="text-xs text-muted">${esc(ss.session_type)}${ss.engineer_name ? " · " + esc(ss.engineer_name) : ""}</div>
        </div>
        <div class="shrink-0 text-right">
          <div class="text-xs font-medium tabular">${esc(formatYmdShort(ss.session_date))}${ss.start_time ? " " + esc(ss.start_time) : ""}</div>
          <div class="text-xs text-muted">${ss.session_date === today ? "오늘" : ""}</div>
        </div>
      </a>`
        )
        .join("")
    : emptyState("이번 주 예정된 세션이 없습니다.", { icon: "sessions" });

  const body = `
    ${pageHeader({
      title: "대시보드",
      desc: s.canInvoice ? "스튜디오 전체 현황" : "스튜디오 현황",
    })}
    ${overdueBanner}
    ${cards}
    <div class="card mt-4">
      <div class="mb-2 flex items-center justify-between gap-2">
        <h2 class="font-display text-base font-semibold">오늘 · 이번 주 세션</h2>
        <span class="text-xs text-muted">오늘 ${todaySessions.length}건 · 이번 주 ${weekSessions.length}건</span>
      </div>
      ${sessionList}
    </div>
    <div class="card mt-4">
      <h2 class="mb-2 font-display text-base font-semibold">임박한 마감</h2>
      ${upcomingList}
    </div>`;

  res.send(layout({ title: "대시보드", user, current: "/", body }));
});

module.exports = router;
