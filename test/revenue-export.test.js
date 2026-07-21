"use strict";

// ── 회계 내보내기(매출 CSV) 회귀 잠금(2026-07-22) ──
// lib/csv(이스케이프·BOM·CRLF) + revenueCsv(발행/기간 필터·컬럼·정렬). 둘 다 순수 함수라 db 불필요.
const test = require("node:test");
const assert = require("node:assert");
const { toCsv, cell } = require("../src/lib/csv");
const { revenueCsv } = require("../src/data/revenue");
const { payoutCsv, PAYOUT_CSV_HEADERS } = require("../src/data/worker-summary");

test("csv.cell: 콤마·따옴표·개행만 따옴표로 감싸고 내부 따옴표는 이스케이프", () => {
  assert.equal(cell("가나다"), "가나다");
  assert.equal(cell("도너츠컬처, 주식회사"), '"도너츠컬처, 주식회사"');
  assert.equal(cell('그는 "왕"이다'), '"그는 ""왕""이다"');
  assert.equal(cell("줄1\n줄2"), '"줄1\n줄2"');
  assert.equal(cell(null), "");
  assert.equal(cell(0), "0");
});

test("csv.toCsv: BOM 선두 + CRLF 구분", () => {
  const s = toCsv(["a", "b"], [["1", "2"], ["3", "4"]]);
  assert.equal(s.codePointAt(0), 0xfeff, "UTF-8 BOM");
  assert.equal(s.slice(1), "a,b\r\n1,2\r\n3,4");
});

// 매출 CSV 입력 = listInvoices 형태(client_name·project_artist·amount·tax_amount 등 파생 완료).
function inv(o) {
  return { status: "발행", issued_date: "2026-07-10", invoice_number: "OMG-1", client_name: "루나", project_artist: "루나킴", amount: 110000, tax_amount: 10000, discount_amount: 0, paid_amount: 0, tax_status: "계산서 발행", id: 1, ...o };
}

test("revenueCsv: 미발행·기간 밖 제외, 공급가=합계−VAT, 미수금 파생", () => {
  const csv = revenueCsv(
    [
      inv({ id: 1, issued_date: "2026-07-10", amount: 110000, tax_amount: 10000, paid_amount: 0 }),
      inv({ id: 2, status: "미발행", issued_date: "2026-07-11" }), // 미발행 제외
      inv({ id: 3, issued_date: "2026-06-30" }), // 다른 달 제외(month=7)
      inv({ id: 4, issued_date: "2025-07-10" }), // 다른 해 제외
    ],
    { year: 2026, month: 7 }
  );
  const lines = csv.slice(1).split("\r\n"); // BOM 제거
  assert.equal(lines[0], "발행일,청구번호,청구처,아티스트,공급가,VAT,할인,합계,세금상태,미수금");
  assert.equal(lines.length, 2, "헤더 + 유효 1행(id=1만)");
  assert.equal(lines[1], "2026-07-10,OMG-1,루나,루나킴,100000,10000,0,110000,계산서 발행,110000", "공급가 100000·미수금 110000");
});

test("revenueCsv: month='all' 이면 그 해 전체, 발행일 오름차순 정렬", () => {
  const csv = revenueCsv(
    [
      inv({ id: 1, issued_date: "2026-09-01", invoice_number: "B" }),
      inv({ id: 2, issued_date: "2026-03-01", invoice_number: "A" }),
      inv({ id: 3, issued_date: "2025-12-31", invoice_number: "Z" }), // 다른 해 제외
    ],
    { year: 2026, month: "all" }
  );
  const lines = csv.slice(1).split("\r\n");
  assert.equal(lines.length, 3, "헤더 + 2행");
  assert.match(lines[1], /2026-03-01,A/, "3월이 먼저");
  assert.match(lines[2], /2026-09-01,B/);
});

test("revenueCsv: 청구처에 콤마 있으면 따옴표로 감싼다(Excel 열 분리 안 깨짐)", () => {
  const csv = revenueCsv([inv({ client_name: "도너츠컬처, 주식회사" })], { year: 2026, month: 7 });
  assert.match(csv, /"도너츠컬처, 주식회사"/);
});

test("revenueCsv: 빈 입력이면 헤더만", () => {
  const csv = revenueCsv([], { year: 2026, month: 7 });
  assert.equal(csv.slice(1), "발행일,청구번호,청구처,아티스트,공급가,VAT,할인,합계,세금상태,미수금");
});

// ── 정산 CSV(외주 원천징수) ──
test("payoutCsv: 헤더 + 원천세 분해 컬럼 매핑", () => {
  const csv = payoutCsv([
    { paidDate: "2026-07-05", worker: "김엔지", project: "루나 1집", label: "믹싱", gross: 500000, incomeTax: 15000, localTax: 1500, net: 483500 },
  ]);
  const lines = csv.slice(1).split("\r\n");
  assert.equal(lines[0], PAYOUT_CSV_HEADERS.join(","));
  assert.equal(lines[0], "지급일,작업자,프로젝트,항목,지급액,소득세,지방소득세,실지급");
  assert.equal(lines[1], "2026-07-05,김엔지,루나 1집,믹싱,500000,15000,1500,483500");
});

test("payoutCsv: 빈 입력이면 헤더만 + BOM", () => {
  const csv = payoutCsv([]);
  assert.equal(csv.codePointAt(0), 0xfeff);
  assert.equal(csv.slice(1), PAYOUT_CSV_HEADERS.join(","));
});
