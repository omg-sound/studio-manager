"use strict";
process.env.NODE_ENV = "test";
const test = require("node:test");
const assert = require("node:assert");
const { contactPanes, contactNameList } = require("../src/views.contacts");

const ROWS = [
  { id: 1, kind: "person", name: "Kim George Han", activity_name: "김조한", honorific: "" },
  { id: 2, kind: "person", name: "강병원", activity_name: "", honorific: "대표님" },
];

test("contactNameList: 이름만 렌더 + 선택 강조 + 실시간 필터 마커", () => {
  const html = contactNameList({ rows: ROWS, selectedId: 2, hrefFn: (c) => `/contacts/${c.id}` });
  assert.match(html, /data-filter-list/, "실시간 필터 컨테이너 마커");
  assert.match(html, /href="\/contacts\/1"/);
  assert.match(html, /Kim George Han \(김조한\)/, "활동명 병기(personName)");
  assert.match(html, /강병원 대표님/, "호칭 병기");
  // 선택된 행만 강조 + aria-current
  const rowOf = (id) => html.split(`href="/contacts/${id}"`)[1].split("</a>")[0];
  assert.match(rowOf(2), /aria-current="true"/, "선택 행 aria-current");
  assert.ok(!/aria-current/.test(rowOf(1)), "비선택 행엔 aria-current 없음");
  assert.match(rowOf(2), /bg-primary\/10/, "선택 행 강조");
  // 이름 외 정보(전화·소속·역할)는 목록에 없다 — 폭 문제의 원인이었음
  assert.ok(!/badge/.test(html), "역할 배지 없음");
});

test("contactNameList: 행 링크는 row-link(모바일 44px 터치 타깃)", () => {
  const html = contactNameList({ rows: ROWS, selectedId: null, hrefFn: (c) => `/contacts/${c.id}` });
  assert.match(html, /class="[^"]*row-link/);
});

test("contactPanes: 선택 없으면 목록만(좁은 화면), 선택 있으면 상세만", () => {
  const none = contactPanes({ left: "LEFT", right: "RIGHT", hasSelection: false });
  assert.match(none, /<div class="block[^"]*">LEFT/, "미선택: 왼쪽 항상 보임");
  assert.match(none, /<div class="hidden lg:block[^"]*">RIGHT/, "미선택: 오른쪽은 lg 이상만");
  const sel = contactPanes({ left: "LEFT", right: "RIGHT", hasSelection: true });
  assert.match(sel, /<div class="hidden lg:block[^"]*">LEFT/, "선택: 왼쪽은 lg 이상만");
  assert.match(sel, /<div class="block[^"]*">RIGHT/, "선택: 오른쪽 항상 보임");
  assert.match(sel, /lg:grid-cols-\[18rem_minmax\(0,1fr\)\]/, "2단 그리드(리터럴 클래스)");
});

test("contactPanes: 인라인 style 없음(CSP — 함정 #27)", () => {
  const html = contactPanes({ left: "L", right: "R", hasSelection: true });
  assert.ok(!/style="/.test(html));
});
