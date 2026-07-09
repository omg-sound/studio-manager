"use strict";

/**
 * 발행 인보이스 → 한국식 거래명세서 A4 PDF.
 * 파이프라인: SVG 템플릿 → resvg(SVG→PNG) → pdf-lib(PNG→PDF 1장).
 * - 한글: resvg는 CDN 폰트를 못 읽으므로 public/fonts/의 로컬 TTF를 명시 로드(없으면 시스템 폰트 폴백).
 * - 모든 사용자 데이터는 SVG 전용 이스케이프(esc는 HTML용이라 별도).
 * - 비공식 참고용 문서(법적 효력은 전자세금계산서=홈택스).
 */

const fs = require("fs");
const path = require("path");
const { PDFDocument } = require("pdf-lib");
const { docNumberWithType } = require("./config"); // 문서 유형별 번호(견적서=OMG-EST-…·내역서=OMG-L-…·거래명세서=OMG-…)

// @resvg/resvg-js는 네이티브 모듈 — 배포 환경에 플랫폼 prebuilt가 없으면 require가 throw한다.
// 최상단 require면 invoice-pdf/invoices 라우트 전체가 로드 실패 → 청구 화면이 통째로 안 뜬다.
// 지연 로드로 감싸 **PDF 요청만** 명확한 에러로 실패하고 나머지 청구 기능은 정상 동작하게 한다.
let _Resvg;
function loadResvg() {
  if (_Resvg === undefined) {
    try { _Resvg = require("@resvg/resvg-js").Resvg; }
    catch (e) { _Resvg = null; console.error("[invoice-pdf] @resvg/resvg-js 로드 실패(PDF 비활성):", e && e.message); }
  }
  if (!_Resvg) throw new Error("PDF_RENDERER_UNAVAILABLE");
  return _Resvg;
}

const FONT_DIR = path.join(__dirname, "../public/fonts");
const FONT_FAMILY = "Noto Sans KR";

/** SVG 텍스트/속성 이스케이프(& < > " '). */
function svgEsc(s) {
  return String(s == null ? "" : s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** 정수 → "1,234,000"(로케일 비의존). */
function commas(n) {
  return String(Math.round(Number(n) || 0)).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}
function won(n) {
  return "₩" + commas(n);
}

/** SVG 텍스트는 자동 줄바꿈이 없으므로 과도하게 긴 값은 말줄임해 컬럼 밖 오버플로를 막는다. */
function truncate(s, n) {
  const str = String(s == null ? "" : s);
  return str.length > n ? str.slice(0, n - 1) + "…" : str;
}

/** public/fonts 의 ttf/otf 목록(배포 번들). 없으면 빈 배열 → 시스템 폰트 폴백. */
function bundledFontFiles() {
  try {
    return fs
      .readdirSync(FONT_DIR)
      .filter((f) => /\.(ttf|otf)$/i.test(f))
      .map((f) => path.join(FONT_DIR, f));
  } catch (_e) {
    return [];
  }
}

function text(x, y, s, { size = 22, weight = 400, anchor = "start", color = "#1f1d1b" } = {}) {
  return `<text x="${x}" y="${y}" font-size="${size}" font-weight="${weight}" text-anchor="${anchor}" fill="${color}" font-family="${FONT_FAMILY}, sans-serif">${svgEsc(s)}</text>`;
}
function line(x1, y1, x2, y2, color = "#cfcabb", w = 1) {
  return `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="${color}" stroke-width="${w}" />`;
}
function rect(x, y, w, h, { fill = "none", stroke = "#cfcabb", sw = 1 } = {}) {
  return `<rect x="${x}" y="${y}" width="${w}" height="${h}" fill="${fill}" stroke="${stroke}" stroke-width="${sw}" />`;
}

/**
 * 내역서(거래명세서) A4 SVG 페이지 배열(1240×1754 px, ~150dpi).
 * 항목이 한 페이지를 넘으면 여러 페이지로 나눈다(2026-07-10 스케일 점검 — 이전 'MAX_ROWS=22 + 외 N건' 클램프는
 * 실제 페이지 용량(~11행)을 넘어서 12항목부터 합계·납부금액이 페이지 밖으로 잘리고 푸터와 겹치던 잠복 결함).
 * 1페이지 = 타이틀·공급자·로고·청구처 박스 + 표. 이후 페이지 = 축약 헤더 + 표 이어서. 합계·납부금액 = 마지막 페이지(공간 없으면 전용 페이지).
 */
function buildSvgPages({ studio, client, invoice, items, logo, docType }) {
  const W = 1240;
  const H = 1754;
  const M = 80;
  const right = W - M;
  const title = docType || "거래명세서";
  const isQuote = title === "견적서";
  const payLabel = isQuote ? "견적 금액" : "납부하실금액";
  const footerText = isQuote
    ? "본 견적서는 참고용이며, 실제 청구 시 금액이 변동될 수 있습니다."
    : `본 ${title}는 참고용이며, 세금계산서는 별도(국세청 홈택스)로 발행됩니다.`;

  // discount_amount > 0이면: 소계(=라인 합산 공급가) → 할인 → 과세표준 → VAT → 합계.
  // discount_amount = 0이면: 기존 소계/VAT/합계 3줄 레이아웃 유지.
  const discountAmt = Math.max(0, invoice.discount_amount || 0);
  const tax = invoice.tax_amount || 0;
  const grand = invoice.amount || 0;
  // 소계(공급가): discount 있으면 라인 합산, 없으면 역산(amount-tax)과 동일. 라인이 없는 수동 인보이스는 역산 기준.
  const lineTotal = items.reduce((s, it) => s + (it.amount || 0), 0);
  const supply = discountAmt > 0 && lineTotal > 0
    ? lineTotal                                     // 할인 있음: 라인 합산(과세표준 = lineTotal - discountAmt)
    : Math.max(0, (invoice.amount || 0) - tax);     // 할인 없음: 역산(기존 동작 유지)

  const ROW_H = 60;
  const HEAD_H = 50;
  const footerY = H - 64;
  const rowsEnd = footerY - 40; // 행이 침범하면 안 되는 하한(푸터 위 여유)
  const number = docNumberWithType(invoice.invoice_number, docType) || "—";

  // 표 머리(품목|금액) — 페이지마다 반복.
  const tableHead = (y) => `<rect x="${M}" y="${y}" width="${W - 2 * M}" height="${HEAD_H}" fill="#f4f3ee" />`
    + text(M + 18, y + 33, "품목", { size: 18, weight: 700 })
    + text(right - 18, y + 33, "금액", { size: 18, weight: 700, anchor: "end" });

  // 페이지 헤더: 1페이지=풀 헤더(타이틀·공급자·로고·청구처 박스), 이후=축약(타이틀 소 + 번호).
  function pageHeader(first) {
    if (!first) {
      let svg = text(M, 100, title, { size: 30, weight: 700 });
      svg += text(right, 100, `${number} · 이어서`, { size: 17, color: "#8a8678", anchor: "end" });
      return { svg, tableY: 150 };
    }
    let svg = text(M, 132, title, { size: 52, weight: 700 });
    svg += text(M, 210, studio.studio_biz_name || "공급자", { size: 27, weight: 700 });
    let hy = 250;
    const supplierLines = [
      studio.studio_address,
      studio.studio_tel,
      studio.studio_biz_no ? `사업자등록번호 : ${studio.studio_biz_no}` : "",
      studio.studio_owner_name ? `대표 : ${studio.studio_owner_name}` : "",
    ].filter(Boolean);
    for (const ln of supplierLines) {
      svg += text(M, hy, truncate(ln, 54), { size: 18, color: "#6b6b6b" });
      hy += 30;
    }
    if (logo) {
      // 로고를 타이틀(거래명세서)과 같은 높이로 — 우측 상단, 타이틀 상단선에 맞춰 정렬(YMin 앵커).
      svg += `<image href="${svgEsc(logo)}" x="${right - 280}" y="78" width="280" height="130" preserveAspectRatio="xMaxYMin meet" />`;
    }
    // 청구처 / 번호·발행일 박스
    const boxY = 440;
    const boxH = 130;
    svg += `<rect x="${M}" y="${boxY}" width="${W - 2 * M}" height="${boxH}" rx="10" fill="none" stroke="#e2e0d8" stroke-width="1.5" />`;
    svg += text(M + 26, boxY + 42, "청구처", { size: 17, color: "#8a8678" });
    svg += text(M + 26, boxY + 88, truncate(client.name || "—", 28), { size: 26, weight: 700 });
    const metaLabelX = right - 320;
    svg += text(metaLabelX, boxY + 42, `${title} 번호`, { size: 17, color: "#8a8678" });
    svg += text(right - 26, boxY + 42, number, { size: 19, weight: 600, anchor: "end" });
    svg += text(metaLabelX, boxY + 90, "발행됨", { size: 17, color: "#8a8678" });
    svg += text(right - 26, boxY + 90, invoice.issued_date || "—", { size: 19, weight: 500, anchor: "end" });
    return { svg, tableY: boxY + boxH + 60 };
  }

  // 합계 블록에 필요한 높이(마지막 페이지에서 확보): 여백 + 합계행들 + 납부하실금액.
  const sumRowsCount = discountAmt > 0 && lineTotal > 0 ? (tax > 0 ? 5 : 4) : (tax > 0 ? 3 : 2);
  const totalsNeed = 56 + sumRowsCount * 44 + 24 + 60;

  // ① 행을 페이지별로 채운다(페이지 용량 = rowsEnd까지).
  const pages = [];
  let idx = 0;
  do {
    const { svg: head, tableY } = pageHeader(pages.length === 0);
    let svg = head + tableHead(tableY);
    let ry = tableY + HEAD_H;
    while (idx < items.length && ry + ROW_H <= rowsEnd) {
      const it = items[idx];
      const label = it.description || [it.track_title, it.task_type].filter(Boolean).join(" - ") || "작업";
      svg += text(M + 18, ry + 38, truncate(label, 44), { size: 19, weight: 600 });
      svg += text(right - 18, ry + 38, won(it.amount), { size: 19, weight: 600, anchor: "end" });
      ry += ROW_H;
      svg += line(M, ry, right, ry, "#ece9df");
      idx++;
    }
    pages.push({ svg, ry });
  } while (idx < items.length);

  // ② 합계·납부는 마지막 페이지에 — 남은 공간이 부족하면 전용 페이지 추가.
  let last = pages[pages.length - 1];
  if (last.ry + totalsNeed > rowsEnd) {
    const { svg: head, tableY } = pageHeader(false);
    last = { svg: head, ry: tableY };
    pages.push(last);
  }
  {
    const sumLabelX = right - 360;
    let sy = last.ry + 56;
    const sumRow = (label, value, bold, color) => {
      const c = color || (bold ? "#1f1d1b" : "#6b6b6b");
      let r = text(sumLabelX, sy, label, { size: 18, color: c, weight: bold ? 700 : 400 });
      r += text(right - 18, sy, value, { size: 19, weight: bold ? 700 : 500, anchor: "end", color: c });
      sy += 44;
      return r;
    };
    let svg = "";
    if (discountAmt > 0 && lineTotal > 0) {
      // 라인아이템이 있는 청구(from-tasks)에서만 할인 레이아웃 — 수동 인보이스(lineTotal=0, 할인은 표시용)는 소계/VAT/합계로 폴백해 과세표준·VAT·합계 불일치 방지.
      const taxable = supply - discountAmt;
      svg += sumRow("소계(공급가)", won(supply));
      svg += sumRow("할인", "- " + won(discountAmt), false, "#16a34a");
      svg += sumRow("과세표준", won(taxable));
      if (tax > 0) svg += sumRow("VAT (10%)", won(tax)); // 현금(VAT 0)이면 줄 생략
      svg += sumRow("합계", won(grand));
    } else {
      svg += sumRow("소계", won(supply));
      if (tax > 0) svg += sumRow("VAT (10%)", won(tax)); // 현금(VAT 0)이면 줄 생략
      svg += sumRow("합계", won(grand));
    }
    // 납부하실금액(강조)
    sy += 24;
    svg += line(sumLabelX, sy - 34, right, sy - 34, "#cfcabb", 1.5);
    svg += text(sumLabelX, sy + 14, payLabel, { size: 27, weight: 700 });
    svg += text(right - 18, sy + 14, won(grand), { size: 31, weight: 700, anchor: "end" });
    last.svg += svg;
  }

  // ③ 각 페이지 마무리: 배경·푸터·페이지 번호(<svg> 래핑).
  return pages.map((p, i) => {
    let svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">`;
    svg += `<rect width="${W}" height="${H}" fill="#ffffff" />`;
    svg += p.svg;
    svg += text(M, H - 64, footerText, { size: 15, color: "#9c9688" });
    if (pages.length > 1) svg += text(right, H - 64, `${i + 1} / ${pages.length}`, { size: 15, color: "#9c9688", anchor: "end" });
    svg += `</svg>`;
    return svg;
  });
}

/** 첫 페이지 SVG(하위 호환 — 미리보기·테스트용). */
function buildSvg(data) {
  return buildSvgPages(data)[0];
}

/** 거래명세서 PDF 버퍼 생성(메모리, 디스크 임시파일 없음 — PII 최소화). */
async function renderInvoicePdf(data) {
  const Resvg = loadResvg(); // 지연 로드(네이티브 모듈 부재 시 PDF_RENDERER_UNAVAILABLE)
  const fontFiles = bundledFontFiles();
  const doc = await PDFDocument.create();
  const A4 = [595.28, 841.89];
  // 항목 수에 따라 여러 페이지(2026-07-10 — 12항목부터 합계가 잘리던 단일 페이지 클램프 폐기).
  for (const svg of buildSvgPages(data)) {
    const resvg = new Resvg(svg, {
      font: {
        fontFiles,
        // 번들 폰트가 있으면 시스템 폰트 끔(결정적 렌더 — 배포 Linux/로컬 동일). 번들 없을 때만 시스템 폴백.
        loadSystemFonts: fontFiles.length === 0,
        defaultFontFamily: FONT_FAMILY,
      },
      fitTo: { mode: "width", value: 1240 },
    });
    const png = resvg.render().asPng();
    const page = doc.addPage(A4);
    const img = await doc.embedPng(png);
    page.drawImage(img, { x: 0, y: 0, width: A4[0], height: A4[1] });
  }
  doc.setTitle(`${data.docType || "거래명세서"} ${docNumberWithType(data.invoice.invoice_number, data.docType) || ""}`.trim());
  return Buffer.from(await doc.save());
}

module.exports = { renderInvoicePdf, buildSvg, buildSvgPages, won };
