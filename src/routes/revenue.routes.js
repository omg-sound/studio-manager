"use strict";
const express = require("express");
const { requireInvoice } = require("../auth");
const { revenueSummary, revenueByStaff, revenueForStaff, revenueUnattributed, revenueByPayer, revenueForPayer, revenueYears, revenueByType, revenueTax, revenueCsv, listInvoices } = require("../data");
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
  if (tab === "staff") {
    // staff=none = 미귀속(담당 없는 작업·세션). 사람이 아니라 id가 없으므로 문자열 키로 구분한다.
    const isNone = req.query.staff === "none";
    const selId = isNone ? "none" : (Number(req.query.staff) || 0);
    // 삭제된 id 등 유효하지 않으면 data=null → 미선택 화면. 404를 던지지 않는다(패널 안이라 목록은 살아 있어야 한다).
    // 목록 탭은 기간 없이 전체 누적(2026-07-19 기간 렌즈 분리) — period를 넘기지 않는다.
    const unattributed = revenueUnattributed();
    const data = isNone ? unattributed : (selId ? revenueForStaff(selId) : null);
    const left = revStaffList(revenueByStaff(), { selId: data ? selId : 0, unattributed });
    // 상세 뷰는 대상 이름을 렌더하지 않는다(기존엔 드릴다운 페이지의 pageHeader가 담당). 패널엔 pageHeader가 없어 여기서 붙인다.
    const head = (title, sub) => `<div class="mb-3"><h2 class="text-lg font-bold">${esc(title)}</h2><p class="text-sm text-muted">${esc(sub)}</p></div>`;
    const right = isNone
      ? `${head("미귀속", "담당 엔지니어가 지정되지 않아 스탭별 매출에 잡히지 않는 항목입니다. 세션·작업에 담당을 지정하면 그 스탭으로 옮겨갑니다.")}${revStaffDetail(data)}`
      : data
        ? `${head(data.manager.name, data.manager.user_id ? "하우스 엔지니어" : "외주 작업자")}${revStaffDetail(data)}`
        : emptyState("스탭을 선택하세요.", { card: true });
    content = contactPanes({
      left, right,
      hasSelection: !!data,
      backHref: `/revenue?tab=staff`,
      backLabel: "매출",
      widthKey: "revListW",
      heightClass: REV_PANE_H,
      wideList: true,
    });
  } else if (tab === "payer") {
    const selId = Number(req.query.payer) || 0;
    const data = selId ? revenueForPayer(selId) : null;
    const left = revPayerList(revenueByPayer(), { selId: data ? selId : 0 });
    const right = data
      ? `<div class="mb-3">
           <h2 class="text-lg font-bold">${esc(data.party.name)}</h2>
           <p class="text-sm text-muted">이 청구처의 전체 매출 기여(공급가).</p>
         </div>${revPayerDetail(data)}`
      : emptyState("업체·개인을 선택하세요.", { card: true });
    content = contactPanes({
      left, right,
      hasSelection: !!data,
      backHref: `/revenue?tab=payer`,
      backLabel: "매출",
      widthKey: "revListW",
      heightClass: REV_PANE_H,
      wideList: true,
    });
  } else {
    const summary = revenueSummary(period);
    const topStaff = revenueByStaff(period);
    const topPayer = revenueByPayer(period);
    content = revOverview({ summary, topStaff, topPayer, byType: revenueByType(period), tax: revenueTax(period), ...period });
  }
  const body = `
    ${pageHeader({ title: "매출", desc: "공급가(VAT 제외)·발행일 기준. 순이익 = 매출 − 외주 지급.", action: tab === "overview" ? `<a href="/revenue/export.csv?${periodQS(period)}" class="btn-ghost btn-sm">매출 CSV</a>` : "" })}
    ${tab === "overview" ? revPeriodControl({ ...period, years, tab }) : ""}
    ${revTabs({ tab, ...period })}
    <div class="mt-4">${content}</div>`;
  // 세 탭 모두 넓게. 스탭별·업체개인별은 마스터-디테일이라 남는 폭을 상세 패널이 쓴다(contactPanes 내부가
  // 오른쪽을 max-w-content로 감싸 읽기 폭은 그대로 보장 — 2026-07-19, 698c596의 읽기 폭 결정을 대체).
  res.send(layout({ title: "매출", user: req.user, current: "/revenue", body, wide: true }));
});

// 매출 CSV 내보내기(회계 — 세무사 전달·부가세 신고). 선택 기간의 발행 청구서. requireInvoice(치프·대표).
// 문자 라우트라 /:id 파라미터 라우트와 안 겹친다(그래도 위에 둔다).
router.get("/export.csv", requireInvoice, (req, res) => {
  const period = parsePeriod(req);
  const csv = revenueCsv(listInvoices(req.user, {}), period);
  const fname = `매출_${period.year}${period.month === "all" ? "_전체" : "-" + String(period.month).padStart(2, "0")}.csv`;
  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.setHeader("Content-Disposition", `attachment; filename*=UTF-8''${encodeURIComponent(fname)}`);
  res.setHeader("Cache-Control", "no-store"); // 매출액 = 민감, 캐시 금지
  res.send(csv);
});

// 구 드릴다운 경로 → 패널 URL 302(북마크·기존 링크 호환). 상세로 가는 길은 하나로 유지한다.
router.get("/staff/:id", requireInvoice, (req, res) => {
  res.redirect(302, `/revenue?tab=staff&staff=${Number(req.params.id) || 0}&${periodQS(parsePeriod(req))}`);
});
router.get("/payer/:id", requireInvoice, (req, res) => {
  res.redirect(302, `/revenue?tab=payer&payer=${Number(req.params.id) || 0}&${periodQS(parsePeriod(req))}`);
});

module.exports = router;
