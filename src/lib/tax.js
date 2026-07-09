"use strict";

/**
 * 외주(개인 사업소득) 원천징수 3.3% 계산(2026-07-09 사용자 요청 — 정산 화면 표시용).
 * 실무 방식: 소득세 = 지급액 × 3%(10원 미만 절사, 국고금 단수계산), 지방소득세 = 소득세 × 10%(10원 미만 절사),
 * 실지급 = 지급액 − 소득세 − 지방소득세. 단순 지급액×3.3%와 절사 때문에 최대 수십 원 차이가 날 수 있으며
 * 이 절사 방식이 홈택스 원천세 신고와 일치한다.
 *
 * ⚠️ 표시 참고용 — 소액부징수(건별 소득세 1,000원 미만 원천징수 면제)·사업자등록 외주(세금계산서 발행 시
 * 원천징수 대상 아님) 등 예외는 반영하지 않는다. 실제 신고·이체는 세무 기준으로 확인.
 */
function withholding33(gross) {
  const g = Math.max(0, Math.round(Number(gross) || 0));
  const incomeTax = Math.floor((g * 0.03) / 10) * 10; // 소득세 3%, 10원 미만 절사
  const localTax = Math.floor((incomeTax * 0.1) / 10) * 10; // 지방소득세 = 소득세의 10%, 10원 미만 절사
  const total = incomeTax + localTax;
  return { gross: g, incomeTax, localTax, total, net: g - total };
}

module.exports = { withholding33 };
