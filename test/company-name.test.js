"use strict";
const test = require("node:test");
const assert = require("node:assert");
const { coreCompanyName, byCompanyName } = require("../src/lib/company-name");

// 2026-07-20 사용자 요청: 업체 목록을 법인 표기(주식회사·(주) 등) 빼고 상호 기준으로 정렬.
// 아래 형태는 전부 **프로덕션 실데이터에서 확인된 것**(121곳 중 73곳이 법인 표기 보유).
test("coreCompanyName: 실데이터의 6가지 표기 형태를 모두 뗀다", () => {
  const cases = [
    ["주식회사 뉴에라프로젝트", "뉴에라프로젝트"],       // 앞·공백 (39곳)
    ["(주)도너츠컬처", "도너츠컬처"],                     // 앞·붙음 (17곳)
    ["딜라잇 컴퍼니 주식회사", "딜라잇 컴퍼니"],           // 뒤 (7곳)
    ["(주) 미스틱스토리(MYSTIC STORY Inc.)", "미스틱스토리(MYSTIC STORY Inc.)"], // 앞·공백 괄호형 (5곳)
    ["뮤직팜엔터테인먼트(주)", "뮤직팜엔터테인먼트"],       // 뒤·괄호 (3곳)
    ["주식회사본부엔터테인먼트", "본부엔터테인먼트"],       // 앞·붙음 (2곳)
  ];
  cases.forEach(([input, want]) => assert.equal(coreCompanyName(input), want, input));
});

test("coreCompanyName: 법인 표기가 없으면 그대로", () => {
  assert.equal(coreCompanyName("꿈의엔진"), "꿈의엔진");
  assert.equal(coreCompanyName("드라마하우스"), "드라마하우스");
});

test("coreCompanyName: 유한회사·㈜도 뗀다(현재 데이터엔 없지만 실무에서 흔하다)", () => {
  assert.equal(coreCompanyName("유한회사 한빛"), "한빛");
  assert.equal(coreCompanyName("㈜카카오"), "카카오");
  assert.equal(coreCompanyName("한빛 유한회사"), "한빛");
});

test("coreCompanyName: 표기를 떼면 빈 이름이 되는 경우엔 원래 이름을 지킨다", () => {
  // 빈 문자열을 정렬 키로 쓰면 순서가 무의미해지고 초성도 못 구한다.
  assert.equal(coreCompanyName("주식회사"), "주식회사");
  assert.equal(coreCompanyName("(주)"), "(주)");
  assert.equal(coreCompanyName(""), "");
  assert.equal(coreCompanyName(null), "");
});

test("byCompanyName: 법인 표기를 무시하고 상호 가나다순, 한글이 영문·숫자보다 먼저", () => {
  const names = [
    "주식회사 99메이저",
    "ABC컴퍼니",
    "(주)도너츠컬처",
    "꿈의엔진",
    "주식회사 뉴에라프로젝트",
    "딜라잇 컴퍼니 주식회사",
  ];
  const sorted = names.map((name) => ({ name })).sort(byCompanyName).map((r) => r.name);
  assert.deepEqual(sorted, [
    "꿈의엔진",                  // ㄲ
    "주식회사 뉴에라프로젝트",    // ㄴ — '주'가 아니라 '뉴'로 정렬된다(이 변경의 핵심)
    "(주)도너츠컬처",            // ㄷ
    "딜라잇 컴퍼니 주식회사",     // ㄷ(딜) — 뒤에 붙은 표기도 무시된다
    "주식회사 99메이저",         // 한글 아님 → 뒤로
    "ABC컴퍼니",
  ]);
});

test("byCompanyName: 같은 상호면 표기 유무와 무관하게 인접한다", () => {
  const rows = [{ name: "한빛 주식회사" }, { name: "가나다" }, { name: "(주)한빛" }].sort(byCompanyName);
  assert.equal(rows[0].name, "가나다");
  assert.ok(rows[1].name.includes("한빛") && rows[2].name.includes("한빛"), "같은 상호끼리 붙는다");
});
