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
const { Resvg } = require("@resvg/resvg-js");
const { PDFDocument } = require("pdf-lib");

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

/** 내역서(거래명세서) A4 SVG(1240×1754 px, ~150dpi). 좌측 타이틀·공급자 헤더 + 로고(우측), 청구처 박스, 품목|금액 표, 소계/VAT/합계, 납부하실금액 강조. */
function buildSvg({ studio, client, invoice, items, logo }) {
  const W = 1240;
  const H = 1754;
  const M = 80;
  const right = W - M;

  const supply = Math.max(0, (invoice.amount || 0) - (invoice.tax_amount || 0));
  const tax = invoice.tax_amount || 0;
  const grand = invoice.amount || 0;

  const MAX_ROWS = 22;
  const shown = items.slice(0, MAX_ROWS);
  const overflow = items.length - shown.length;

  let svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">`;
  svg += `<rect width="${W}" height="${H}" fill="#ffffff" />`;

  // 타이틀(좌측)
  svg += text(M, 132, "내역서", { size: 52, weight: 700 });

  // 공급자 헤더(좌측) + 로고(우측 상단)
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
    svg += `<image href="${svgEsc(logo)}" x="${right - 280}" y="185" width="280" height="130" preserveAspectRatio="xMaxYMin meet" />`;
  }

  // 청구처 / 번호·발행일 박스
  const boxY = 440;
  const boxH = 130;
  svg += `<rect x="${M}" y="${boxY}" width="${W - 2 * M}" height="${boxH}" rx="10" fill="none" stroke="#e2e0d8" stroke-width="1.5" />`;
  svg += text(M + 26, boxY + 42, "청구처", { size: 17, color: "#8a8678" });
  svg += text(M + 26, boxY + 88, truncate(client.name || "—", 28), { size: 26, weight: 700 });
  const metaLabelX = right - 320;
  svg += text(metaLabelX, boxY + 42, "내역서 번호", { size: 17, color: "#8a8678" });
  svg += text(right - 26, boxY + 42, invoice.invoice_number || "—", { size: 19, weight: 600, anchor: "end" });
  svg += text(metaLabelX, boxY + 90, "발행됨", { size: 17, color: "#8a8678" });
  svg += text(right - 26, boxY + 90, invoice.issued_date || "—", { size: 19, weight: 500, anchor: "end" });

  // 품목 표(품목 | 금액 — 수량/단가는 곡·세션 단위 고정이라 생략)
  const tableY = boxY + boxH + 60;
  const headH = 50;
  svg += `<rect x="${M}" y="${tableY}" width="${W - 2 * M}" height="${headH}" fill="#f4f3ee" />`;
  svg += text(M + 18, tableY + 33, "품목", { size: 18, weight: 700 });
  svg += text(right - 18, tableY + 33, "금액", { size: 18, weight: 700, anchor: "end" });

  let ry = tableY + headH;
  const lineRowH = 60;
  for (const it of shown) {
    const label = it.description || [it.track_title, it.task_type].filter(Boolean).join(" - ") || "작업";
    svg += text(M + 18, ry + 38, truncate(label, 44), { size: 19, weight: 600 });
    svg += text(right - 18, ry + 38, won(it.amount), { size: 19, weight: 600, anchor: "end" });
    ry += lineRowH;
    svg += line(M, ry, right, ry, "#ece9df");
  }
  if (overflow > 0) {
    svg += text(M + 18, ry + 38, `… 외 ${overflow}건 (상세는 청구서 참조)`, { size: 16, color: "#9c9688" });
    ry += lineRowH;
  }

  // 소계 / VAT / 합계(우측)
  const sumLabelX = right - 360;
  let sy = ry + 56;
  const sumRow = (label, value, bold) => {
    let r = text(sumLabelX, sy, label, { size: 18, color: bold ? "#1f1d1b" : "#6b6b6b", weight: bold ? 700 : 400 });
    r += text(right - 18, sy, value, { size: 19, weight: bold ? 700 : 500, anchor: "end" });
    sy += 44;
    return r;
  };
  svg += sumRow("소계", won(supply));
  svg += sumRow("VAT (10%)", won(tax));
  svg += sumRow("합계", won(grand));

  // 납부하실금액(강조)
  sy += 24;
  svg += line(sumLabelX, sy - 34, right, sy - 34, "#cfcabb", 1.5);
  svg += text(sumLabelX, sy + 14, "납부하실금액", { size: 27, weight: 700 });
  svg += text(right - 18, sy + 14, won(grand), { size: 31, weight: 700, anchor: "end" });

  // 푸터
  svg += text(M, H - 64, "본 내역서는 참고용이며, 세금계산서는 별도(국세청 홈택스)로 발행됩니다.", { size: 15, color: "#9c9688" });

  svg += `</svg>`;
  return svg;
}

/** 거래명세서 PDF 버퍼 생성(메모리, 디스크 임시파일 없음 — PII 최소화). */
async function renderInvoicePdf(data) {
  const svg = buildSvg(data);
  const fontFiles = bundledFontFiles();
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

  const doc = await PDFDocument.create();
  const A4 = [595.28, 841.89];
  const page = doc.addPage(A4);
  const img = await doc.embedPng(png);
  page.drawImage(img, { x: 0, y: 0, width: A4[0], height: A4[1] });
  doc.setTitle(`거래명세서 ${data.invoice.invoice_number || ""}`.trim());
  return Buffer.from(await doc.save());
}

module.exports = { renderInvoicePdf, buildSvg, won };
