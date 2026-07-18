"use strict";
const express = require("express");
const { requireInvoice } = require("../auth");
const { revenueSummary, revenueByStaff, revenueForStaff, revenueByPayer, revenueForPayer, revenueYears, revenueByType, revenueTax } = require("../data");
const { revPeriodControl, revTabs, revOverview, revStaffTable, revPayerTable, revStaffDetail, revPayerDetail } = require("../views.revenue");
const { layout, pageHeader, esc, errorPage } = require("../views");
const { todayYmd } = require("../lib/date");

const router = express.Router();

// 쿼리 → { year, month }(month='all'|1~12). 기본 = 이번 년·월.
function parsePeriod(req) {
  const now = todayYmd();
  const year = Number(req.query.year) || Number(now.slice(0, 4));
  const month = req.query.month === "all" ? "all" : (Number(req.query.month) || Number(now.slice(5, 7)));
  return { year, month };
}
function periodQS({ year, month }) { return `year=${year}&month=${month === "all" ? "all" : month}`; }

// 매출 메인(탭: 개요/스탭별/업체·개인별).
router.get("/", requireInvoice, (req, res) => {
  const period = parsePeriod(req);
  const tab = ["overview", "staff", "payer"].includes(req.query.tab) ? req.query.tab : "overview";
  const years = revenueYears();
  let content;
  if (tab === "staff") {
    content = revStaffTable(revenueByStaff(period), period);
  } else if (tab === "payer") {
    content = revPayerTable(revenueByPayer(period), period);
  } else {
    const summary = revenueSummary(period);
    const topStaff = revenueByStaff(period).slice(0, 5);
    const topPayer = revenueByPayer(period).slice(0, 5);
    content = revOverview({ summary, topStaff, topPayer, byType: revenueByType(period), tax: revenueTax(period), ...period });
  }
  const body = `
    ${pageHeader({ title: "매출", desc: "공급가(VAT 제외)·발행일 기준. 순이익 = 매출 − 외주 지급." })}
    ${revPeriodControl({ ...period, years, tab })}
    ${revTabs({ tab, ...period })}
    <div class="mt-4">${content}</div>`;
  res.send(layout({ title: "매출", user: req.user, current: "/revenue", body, wide: true }));
});

// 스탭 드릴다운.
router.get("/staff/:id", requireInvoice, (req, res) => {
  const period = parsePeriod(req);
  const data = revenueForStaff(Number(req.params.id), period);
  if (!data) return res.status(404).send(errorPage({ code: 404, title: "스탭을 찾을 수 없습니다", message: "삭제되었거나 주소가 잘못되었습니다.", user: req.user }));
  const desc = data.manager.user_id ? "하우스 엔지니어" : "외주 작업자";
  const body = `
    ${pageHeader({ title: data.manager.name, desc, back: { href: `/revenue?tab=staff&${periodQS(period)}`, label: "매출" } })}
    ${revStaffDetail(data, period)}`;
  res.send(layout({ title: data.manager.name, user: req.user, current: "/revenue", body }));
});

// 결제자(업체·개인) 드릴다운.
router.get("/payer/:id", requireInvoice, (req, res) => {
  const period = parsePeriod(req);
  const data = revenueForPayer(Number(req.params.id), period);
  if (!data) return res.status(404).send(errorPage({ code: 404, title: "청구처를 찾을 수 없습니다", message: "삭제되었거나 주소가 잘못되었습니다.", user: req.user }));
  const body = `
    ${pageHeader({ title: data.party.name, desc: "이 청구처의 기간 매출 기여(공급가).", back: { href: `/revenue?tab=payer&${periodQS(period)}`, label: "매출" } })}
    ${revPayerDetail(data, period)}`;
  res.send(layout({ title: data.party.name, user: req.user, current: "/revenue", body }));
});

module.exports = router;
