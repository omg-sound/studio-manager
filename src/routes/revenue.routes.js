"use strict";
const express = require("express");
const { requireInvoice } = require("../auth");
const { revenueSummary, revenueByStaff, revenueForStaff, revenueByPayer, revenueForPayer, revenueYears, revenueByType, revenueTax } = require("../data");
const { revPeriodControl, revTabs, revOverview, revStaffList, revPayerList, revStaffDetail, revPayerDetail } = require("../views.revenue");
const { contactPanes } = require("../views.contacts");
const { layout, pageHeader, esc, emptyState } = require("../views");
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

// 패널 고정 높이 = 뷰포트 − 상단(py-6 + pageHeader + 기간 컨트롤 + 탭바). 연락처(11rem)보다 기간 컨트롤 줄만큼 낮다.
// ⚠️ Tailwind는 소스 리터럴만 스캔하므로 동적 조립 금지(함정 #27). 값은 브라우저 실측으로 확정(Task 6).
const REV_PANE_H = "lg:h-[calc(100vh-15.5rem)]";

// 매출 메인(탭: 개요/스탭별/업체·개인별). 스탭별·업체개인별은 마스터-디테일(왼쪽 순위 목록 + 오른쪽 상세 패널).
router.get("/", requireInvoice, (req, res) => {
  const period = parsePeriod(req);
  const tab = ["overview", "staff", "payer"].includes(req.query.tab) ? req.query.tab : "overview";
  const years = revenueYears();
  let content;
  let sel = null; // 기간 폼이 유지할 선택(있을 때만)
  if (tab === "staff") {
    const selId = Number(req.query.staff) || 0;
    // 삭제된 id 등 유효하지 않으면 data=null → 미선택 화면. 404를 던지지 않는다(패널 안이라 목록은 살아 있어야 한다).
    const data = selId ? revenueForStaff(selId, period) : null;
    if (data) sel = { name: "staff", id: selId };
    const left = revStaffList(revenueByStaff(period), { ...period, selId: data ? selId : 0 });
    // 상세 뷰는 대상 이름을 렌더하지 않는다(기존엔 드릴다운 페이지의 pageHeader가 담당). 패널엔 pageHeader가 없어 여기서 붙인다.
    const right = data
      ? `<div class="mb-3">
           <h2 class="text-lg font-bold">${esc(data.manager.name)}</h2>
           <p class="text-sm text-muted">${data.manager.user_id ? "하우스 엔지니어" : "외주 작업자"}</p>
         </div>${revStaffDetail(data, period)}`
      : emptyState("스탭을 선택하세요.", { card: true });
    content = contactPanes({
      left, right,
      hasSelection: !!data,
      backHref: `/revenue?tab=staff&${periodQS(period)}`,
      backLabel: "매출",
      widthKey: "revListW",
      heightClass: REV_PANE_H,
      wideList: true,
    });
  } else if (tab === "payer") {
    const selId = Number(req.query.payer) || 0;
    const data = selId ? revenueForPayer(selId, period) : null;
    if (data) sel = { name: "payer", id: selId };
    const left = revPayerList(revenueByPayer(period), { ...period, selId: data ? selId : 0 });
    const right = data
      ? `<div class="mb-3">
           <h2 class="text-lg font-bold">${esc(data.party.name)}</h2>
           <p class="text-sm text-muted">이 청구처의 기간 매출 기여(공급가).</p>
         </div>${revPayerDetail(data, period)}`
      : emptyState("업체·개인을 선택하세요.", { card: true });
    content = contactPanes({
      left, right,
      hasSelection: !!data,
      backHref: `/revenue?tab=payer&${periodQS(period)}`,
      backLabel: "매출",
      widthKey: "revListW",
      heightClass: REV_PANE_H,
      wideList: true,
    });
  } else {
    const summary = revenueSummary(period);
    const topStaff = revenueByStaff(period).slice(0, 5);
    const topPayer = revenueByPayer(period).slice(0, 5);
    content = revOverview({ summary, topStaff, topPayer, byType: revenueByType(period), tax: revenueTax(period), ...period });
  }
  const body = `
    ${pageHeader({ title: "매출", desc: "공급가(VAT 제외)·발행일 기준. 순이익 = 매출 − 외주 지급." })}
    ${revPeriodControl({ ...period, years, tab, sel })}
    ${revTabs({ tab, ...period })}
    <div class="mt-4">${content}</div>`;
  // 세 탭 모두 넓게. 스탭별·업체개인별은 마스터-디테일이라 남는 폭을 상세 패널이 쓴다(contactPanes 내부가
  // 오른쪽을 max-w-content로 감싸 읽기 폭은 그대로 보장 — 2026-07-19, 698c596의 읽기 폭 결정을 대체).
  res.send(layout({ title: "매출", user: req.user, current: "/revenue", body, wide: true }));
});

// 구 드릴다운 경로 → 패널 URL 302(북마크·기존 링크 호환). 상세로 가는 길은 하나로 유지한다.
router.get("/staff/:id", requireInvoice, (req, res) => {
  res.redirect(302, `/revenue?tab=staff&staff=${Number(req.params.id) || 0}&${periodQS(parsePeriod(req))}`);
});
router.get("/payer/:id", requireInvoice, (req, res) => {
  res.redirect(302, `/revenue?tab=payer&payer=${Number(req.params.id) || 0}&${periodQS(parsePeriod(req))}`);
});

module.exports = router;
