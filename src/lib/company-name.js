"use strict";

/**
 * 업체 상호에서 **법인 표기를 뗀 정렬용 이름**(2026-07-20 사용자 요청 — '주식회사·(주) 같은 건 prefix 취급하고
 * 회사명 기준으로 정렬되면 좋겠다'). 실측 프로덕션 121곳 중 73곳(60%)이 법인 표기를 갖고 있어
 * 그대로 두면 39곳이 'ㅈ'(주식회사) 한 덩어리로 몰린다.
 *
 * **앞뿐 아니라 뒤에 붙은 것도 뗀다** — 실데이터에 `딜라잇 컴퍼니 주식회사`(7곳)·`뮤직팜엔터테인먼트(주)`(3곳)가 있다.
 * 표시는 바꾸지 않는다(사용자 결정) — 이 함수는 **정렬·초성 그룹 키 전용**이다.
 * 정렬과 초성이 서로 다른 규칙을 쓰면 목록 순서와 헤더가 어긋나므로, 양쪽이 반드시 이 한 함수를 쓴다.
 */

// 법인격 표기. 현재 데이터엔 주식회사·(주)만 있으나 유한회사류는 실무에서 흔해 함께 둔다.
const MARKERS = ["주식회사", "유한회사", "(주)", "(유)", "㈜", "㈜"];

/**
 * @param {string} name 원래 상호(예: "주식회사 뉴에라프로젝트", "(주)도너츠컬처", "뮤직팜엔터테인먼트(주)")
 * @returns {string} 정렬용 이름(예: "뉴에라프로젝트", "도너츠컬처", "뮤직팜엔터테인먼트"). 표기를 떼면 빈 문자열이
 *   되는 경우(상호가 '주식회사'뿐)엔 원래 이름을 그대로 돌려준다 — 빈 키로 정렬하면 순서가 무의미해진다.
 */
function coreCompanyName(name) {
  let s = String(name || "").trim();
  if (!s) return "";
  let changed = true;
  // 앞뒤 어느 쪽이든, 여러 겹이어도(예: "(주) 주식회사X") 더 뗄 게 없을 때까지 반복.
  while (changed) {
    changed = false;
    for (const m of MARKERS) {
      if (s.startsWith(m)) { s = s.slice(m.length).trim(); changed = true; }
      if (s.endsWith(m)) { s = s.slice(0, -m.length).trim(); changed = true; }
    }
  }
  return s || String(name || "").trim();
}

/** 첫 글자가 한글(음절 또는 호환 자모)이면 0, 아니면 1 — 한글 우선 정렬(SQL hangulFirstOrder와 같은 규칙). */
function hangulRank(s) {
  const c = String(s || "").charCodeAt(0);
  return (c >= 44032 && c <= 55203) || (c >= 12593 && c <= 12686) ? 0 : 1;
}

/**
 * 업체 목록 정렬 비교자 — 법인 표기를 뗀 상호로, 한글 먼저(가나다) 그다음 영문·숫자·기호.
 * ⚠️ 100개 상한(`capList`)이 JS에서 걸리므로 **상한을 적용하기 전에** 정렬해야 한다(뒤에 정렬하면 잘린 뒤 순서라 틀린다).
 */
function byCompanyName(a, b) {
  const ka = coreCompanyName(a && a.name), kb = coreCompanyName(b && b.name);
  const ra = hangulRank(ka), rb = hangulRank(kb);
  if (ra !== rb) return ra - rb;
  return ka.localeCompare(kb, "ko");
}

module.exports = { coreCompanyName, hangulRank, byCompanyName };
