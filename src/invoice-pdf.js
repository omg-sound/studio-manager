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

/** 당사자 박스(공급자/공급받는 자). rows = [[label, value], ...]. */
function partyBox(x, y, w, title, rows) {
  const pad = 18;
  const headH = 40;
  const rowH = 36;
  const h = headH + rows.length * rowH + 12;
  let out = rect(x, y, w, h, { stroke: "#bdb8a8" });
  out += rect(x, y, w, headH, { fill: "#f0eee6", stroke: "#bdb8a8" });
  out += text(x + pad, y + 27, title, { size: 21, weight: 700 });
  let ry = y + headH + 26;
  for (const [label, value] of rows) {
    out += text(x + pad, ry, label, { size: 18, color: "#7c776c" });
    out += text(x + pad + 130, ry, truncate(value || "—", 28), { size: 18, weight: 500 });
    ry += rowH;
  }
  return out;
}

/** 거래명세서 A4 SVG(1240×1754 px, ~150dpi). */
function buildSvg({ studio, client, invoice, items }) {
  const W = 1240;
  const H = 1754;
  const M = 70;
  const right = W - M;
  const colW = (W - 2 * M - 20) / 2; // 두 당사자 박스 너비

  const supplyTotal = Math.max(0, (invoice.amount || 0) - (invoice.tax_amount || 0));
  const tax = invoice.tax_amount || 0;
  const grand = invoice.amount || 0;

  // 라인아이템: 단일 페이지 행 상한(초과 시 요약 행)
  const MAX_ROWS = 20;
  const shown = items.slice(0, MAX_ROWS);
  const overflow = items.length - shown.length;

  let svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">`;
  svg += `<rect width="${W}" height="${H}" fill="#ffffff" />`;

  // 제목
  svg += text(W / 2, 120, "거 래 명 세 서", { size: 46, weight: 700, anchor: "middle" });
  svg += text(W / 2, 154, "(공급받는 자 보관용 · 참고용)", { size: 17, anchor: "middle", color: "#9c9688" });

  // 메타(번호/발행일)
  svg += text(M, 200, `청구번호  ${invoice.invoice_number || "—"}`, { size: 19, weight: 500 });
  svg += text(right, 200, `발행일  ${invoice.issued_date || "—"}`, { size: 19, weight: 500, anchor: "end" });
  svg += line(M, 214, right, 214, "#bdb8a8", 1.5);

  // 당사자 박스
  const boxY = 240;
  svg += partyBox(M, boxY, colW, "공급자", [
    ["상호", studio.studio_biz_name],
    ["사업자번호", studio.studio_biz_no],
    ["대표자", studio.studio_owner_name],
    ["주소", studio.studio_address],
    ["업태/종목", [studio.studio_biz_type, studio.studio_biz_item].filter(Boolean).join(" / ")],
    ["연락처", studio.studio_tel],
  ]);
  svg += partyBox(M + colW + 20, boxY, colW, "공급받는 자", [
    ["상호", client.name],
    ["사업자번호", client.biz_no],
    ["대표자", client.owner_name],
    ["주소", client.address],
    ["", ""],
    ["", ""],
  ]);

  // 품목 표
  const tableY = boxY + 280;
  const headH = 46;
  const rowH = 42;
  // 컬럼 경계(x): 품목 | 수량 | 단가 | 공급가액
  const c0 = M;
  const c1 = M + 600; // 수량 시작
  const c2 = M + 710; // 단가 시작
  const c3 = M + 895; // 공급가액 시작
  const tableRight = right;

  svg += rect(c0, tableY, tableRight - c0, headH, { fill: "#f0eee6", stroke: "#bdb8a8" });
  svg += text(c0 + 18, tableY + 30, "품목", { size: 19, weight: 700 });
  svg += text(c1 + 70, tableY + 30, "수량", { size: 19, weight: 700, anchor: "end" });
  svg += text(c2 + 155, tableY + 30, "단가", { size: 19, weight: 700, anchor: "end" });
  svg += text(tableRight - 18, tableY + 30, "공급가액", { size: 19, weight: 700, anchor: "end" });

  let ry = tableY + headH;
  const bodyRows = Math.max(shown.length, 6); // 최소 높이 확보
  for (let i = 0; i < bodyRows; i++) {
    const it = shown[i];
    if (it) {
      const label = it.description || [it.track_title, it.task_type].filter(Boolean).join(" - ") || "작업";
      const qty = it.quantity == null ? "" : String(it.quantity).replace(/\.0+$/, "");
      svg += text(c0 + 18, ry + 28, truncate(label, 38), { size: 18 });
      svg += text(c1 + 70, ry + 28, qty, { size: 18, anchor: "end" });
      svg += text(c2 + 155, ry + 28, commas(it.unit_price), { size: 18, anchor: "end" });
      svg += text(tableRight - 18, ry + 28, commas(it.amount), { size: 18, anchor: "end" });
    }
    svg += line(c0, ry + rowH, tableRight, ry + rowH, "#e0dccf");
    ry += rowH;
  }
  if (overflow > 0) {
    svg += text(c0 + 18, ry + 28, `… 외 ${overflow}건 (상세는 청구서 참조)`, { size: 16, color: "#9c9688" });
    ry += rowH;
  }
  // 표 외곽 + 세로 구분선
  svg += rect(c0, tableY, tableRight - c0, ry - tableY, { stroke: "#bdb8a8" });
  for (const cx of [c1, c2, c3]) svg += line(cx, tableY, cx, ry, "#e0dccf");

  // 합계
  const sumX = c2;
  let sy = ry + 40;
  const sumRow = (label, value, bold) => {
    let r = text(sumX, sy, label, { size: 19, weight: bold ? 700 : 400, color: "#7c776c" });
    r += text(tableRight - 18, sy, value, { size: 20, weight: bold ? 700 : 500, anchor: "end" });
    sy += 40;
    return r;
  };
  svg += sumRow("공급가액", won(supplyTotal));
  svg += sumRow("부가세 (10%)", won(tax));
  svg += line(sumX, sy - 30, tableRight, sy - 30, "#bdb8a8");
  svg += sumRow("합계금액", won(grand), true);

  // 푸터
  svg += text(M, H - 70, "본 거래명세서는 참고용이며, 세금계산서는 별도(국세청 홈택스)로 발행됩니다.", {
    size: 16,
    color: "#9c9688",
  });

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
