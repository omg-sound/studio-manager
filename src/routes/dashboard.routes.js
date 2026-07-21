"use strict";

const express = require("express");
const { requireAuth, canBill } = require("../auth");
const { dashboardStats, upcomingSessions, listProjects } = require("../data");
const { layout, pageHeader, esc, formatKRW, emptyState, ddayPill } = require("../views");
const { todayYmd, formatYmdShort } = require("../lib/date");

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

  // 카드는 전부 드릴다운(href) — 넷이 똑같이 생겼는데 미수금만 클릭되던 어포던스 불일치 해소(2026-07-21 사용자 요청).
  const statCard = (label, value, sub = "", href = "") => {
    const tag = href ? "a" : "div";
    const attrs = href ? ` href="${esc(href)}" class="card row-link block` : ` class="card`;
    return `
    <${tag}${attrs} border-l-2 [border-left-color:rgb(var(--color-primary))]">
      <div class="text-sm text-muted">${esc(label)}</div>
      <div class="mt-1 font-display text-lg font-bold tabular">${esc(String(value))}</div>
      ${sub ? `<div class="mt-1 text-xs text-muted">${esc(sub)}</div>` : ""}
    </${tag}>`;
  };

  const moneyCard = (label, amount, danger = false, sub = "", href = "") => {
    const tag = href ? "a" : "div";
    const attrs = href ? ` href="${esc(href)}" class="card row-link block` : ` class="card`;
    return `
    <${tag}${attrs} border-l-2 ${danger ? "[border-left-color:rgb(var(--color-danger))]" : "[border-left-color:rgb(var(--color-success))]"}">
      <div class="text-sm text-muted">${esc(label)}</div>
      <div class="mt-1 font-display text-lg font-bold tabular ${danger && amount > 0 ? "text-danger" : ""}">${formatKRW(amount)}</div>
      ${sub ? `<div class="mt-1 text-xs text-muted">${esc(sub)}</div>` : ""}
    </${tag}>`;
  };

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
    cardItems.push(moneyCard("미수금", inv.receivable, true, "발행·미입금 잔금", "/invoices?filter=done"));
    cardItems.push(moneyCard("이번 달 발행", inv.thisMonthIssued, false, "", "/invoices"));
  }
  cardItems.push(statCard("프로젝트", s.total, "", "/projects"));
  if (s.isChief) cardItems.push(statCard("업체·그룹", s.clients, "", "/clients"));
  // 읽기 폭(768)로 좁힌 뒤(2026-07-16 사용자 '폭 조절') 카드는 2열 고정 — 좁은 폭에 4열이면 금액이 찌부.
  const cards = `<div class="grid grid-cols-2 gap-3">${cardItems.join("")}</div>`;

  const sessionList = weekSessions.length
    ? weekSessions
        .map(
          (ss) => `
      <a href="/projects/${ss.project_id}?tab=sessions" class="row-link flex items-center justify-between gap-3 border-b border-border py-2.5 last:border-0">
        <div class="min-w-0">
          <div class="truncate text-sm font-medium">${esc(ss.project_title)}</div>
          <div class="text-xs text-muted">${esc(ss.session_type)}${ss.engineer_name ? " · " + esc(ss.engineer_name) : ""}</div>
        </div>
        <div class="flex shrink-0 items-center gap-2">
          <div class="text-xs font-medium tabular text-muted">${esc(formatYmdShort(ss.session_date))}${ss.start_time ? " " + esc(ss.start_time) : ""}</div>
          ${ddayPill(ss.session_date)}
        </div>
      </a>`
        )
        .join("")
    : emptyState("이번 주 예정된 세션이 없습니다.", { icon: "sessions" });

  // 청구 필요 = 완료됐는데 미청구 항목이 남은 프로젝트(프로젝트 목록 '청구 필요' 탭 splitProjectTabs.billing과 동일 정의).
  // 청구 생성 권한자(canBill=치프·대표·스태프) 전원에게 — 스태프가 청구 생성 담당. 상위 5개 + 청구 필요 탭 전체 링크.
  let unbilledCard = "";
  if (canBill(user)) {
    const needBilling = listProjects(user, {}).filter((p) => p.is_completed && Number(p.unbilled_cnt) > 0);
    if (needBilling.length) {
      const rowsHtml = needBilling.slice(0, 5).map((p) => `
      <a href="/projects/${p.id}?tab=invoice" class="row-link flex items-center justify-between gap-3 border-b border-border py-2.5 last:border-0">
        <div class="min-w-0">
          <div class="truncate text-sm font-medium">${esc(p.title)}</div>
          <div class="truncate text-xs text-muted">${esc([p.artist, p.client_name].filter(Boolean).join(" · ") || "정보 미정")}</div>
        </div>
        <span class="badge shrink-0 bg-warning/10 text-warning">청구 필요 ${p.unbilled_cnt}</span>
      </a>`).join("");
      unbilledCard = `
    <div class="card mt-4">
      <div class="mb-2 flex items-center justify-between gap-2">
        <h2 class="font-display text-base font-semibold">청구 필요</h2>
        <a href="/projects?tab=billing" class="text-xs text-muted hover:text-fg hover:underline">청구 필요 탭에서 전체 보기 ${needBilling.length}건 ↗</a>
      </div>
      ${rowsHtml}
    </div>`;
    }
  }

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
    ${unbilledCard}`;

  res.send(layout({ title: "대시보드", user, current: "/", body })); // 읽기 폭(2026-07-16 사용자 '폭 조절' — 카드 2열)
});

module.exports = router;
