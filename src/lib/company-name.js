"use strict";

/**
 * 업체 상호에서 **법인 표기**(주식회사·(주) 등)를 떼어내는 유틸.
 *
 * 왜: 2026-07-20 사용자 요청 — '주식회사나 (주) 같은 것들은 prefix 취급하고 회사명 기준으로 정렬되면 좋겠다'.
 * 실측 프로덕션 121곳 중 73곳(60%)이 법인 표기를 갖고 있어 그대로 두면 39곳이 'ㅈ'(주식회사) 한 덩어리로 몰린다.
 * **앞뿐 아니라 뒤에 붙은 것도 뗀다** — 실데이터에 `딜라잇 컴퍼니 주식회사`(7곳)·`뮤직팜엔터테인먼트(주)`(3곳)가 있다.
 *
 * 두 소비처가 **반드시 이 한 파일을 쓴다**: 정렬(byCompanyName)과 초성 그룹(keyFn). 규칙이 갈리면
 * 목록 순서와 초성 헤더가 어긋난다.
 */

// 법인격 표기. 현재 데이터엔 주식회사·(주)만 있으나 유한회사류는 실무에서 흔해 함께 둔다.
const MARKERS = ["주식회사", "유한회사", "(주)", "(유)", "㈜"];

/**
 * 상호를 `법인표기 + 상호 + 법인표기` 세 조각으로 나눈다.
 * **`pre + core + post`는 항상 원본(trim)과 정확히 같다** — 표시할 때 글자가 사라지거나 바뀌지 않는다는 보장.
 *
 * @param {string} name 원래 상호
 * @returns {{pre:string, core:string, post:string}} 예: "주식회사 뉴에라프로젝트" → {pre:"주식회사 ", core:"뉴에라프로젝트", post:""}
 *   표기를 떼면 빈 이름이 되는 경우(상호가 '주식회사'뿐)엔 core에 원본을 두고 pre/post를 비운다 —
 *   빈 키로 정렬하면 순서가 무의미해지고 초성도 못 구한다.
 */
function splitCompanyName(name) {
  const full = String(name || "").trim();
  if (!full) return { pre: "", core: "", post: "" };
  let start = 0, end = full.length;
  let changed = true;
  // 앞뒤 어느 쪽이든, 여러 겹이어도(예: "(주) 주식회사X") 더 뗄 게 없을 때까지 반복.
  while (changed) {
    changed = false;
    for (const m of MARKERS) {
      // 앞: 표기 + 뒤따르는 공백까지 pre로
      if (full.startsWith(m, start)) {
        let k = start + m.length;
        while (k < end && /\s/.test(full[k])) k += 1;
        if (k <= end) { start = k; changed = true; }
      }
      // 뒤: 앞서는 공백까지 post로
      if (end - m.length >= start && full.startsWith(m, end - m.length)) {
        let k = end - m.length;
        while (k > start && /\s/.test(full[k - 1])) k -= 1;
        if (k >= start) { end = k; changed = true; }
      }
    }
  }
  const core = full.slice(start, end);
  if (!core) return { pre: "", core: full, post: "" }; // 표기밖에 없는 이름은 원본을 지킨다
  return { pre: full.slice(0, start), core, post: full.slice(end) };
}

/** 정렬·초성 그룹에 쓰는 '법인 표기를 뗀 상호'. */
function coreCompanyName(name) {
  return splitCompanyName(name).core;
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

module.exports = { splitCompanyName, coreCompanyName, hangulRank, byCompanyName };
