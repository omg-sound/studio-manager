"use strict";

// ── 전역 검색 "최근 방문" 회귀 잠금(2026-07-22) ──
// 상세 페이지가 layout에 렌더한 [data-recent-item]을 app.js가 localStorage(omg:recent)에 쌓고,
// 전역 검색(data-global-search) 입력이 빈 상태로 포커스되면 그 최근 목록을 드롭다운에 띄우는지.
// 실제 public/js/app.js를 jsdom에서 실행(helpers-dom) — 정적 계약이 못 보는 동작 계층.
const test = require("node:test");
const assert = require("node:assert");
const { mountDom, fire } = require("./helpers-dom");

const globalBox = `
  <div data-search-suggest data-suggest-url="/search/suggest">
    <input name="q" data-global-search />
    <div data-suggest-pop class="hidden"></div>
  </div>`;

test("recorder: [data-recent-item]을 omg:recent 맨 앞에 기록(중복 제거·최대 8)", () => {
  // 기존 목록에 같은 href(/projects/12)와 9건을 심어 dedupe·cap을 함께 검증.
  const seeded = [{ cat: "청구", label: "OMG-old", href: "/projects/12" }];
  for (let i = 0; i < 9; i++) seeded.push({ cat: "연락처", label: "n" + i, href: "/contacts/" + i });
  const { win } = mountDom(
    `<span data-recent-item='{"cat":"프로젝트","label":"루나 1집","href":"/projects/12"}' hidden></span>`,
    { storage: { "omg:recent": JSON.stringify(seeded) } }
  );
  const list = JSON.parse(win.localStorage.getItem("omg:recent"));
  assert.equal(list[0].href, "/projects/12", "방금 방문이 맨 앞");
  assert.equal(list[0].label, "루나 1집", "최신 라벨로 갱신");
  assert.equal(list[0].cat, "프로젝트");
  assert.equal(list.filter((x) => x.href === "/projects/12").length, 1, "중복 없음");
  assert.ok(list.length <= 8, "최대 8건 상한");
});

test("recorder: 마커 없으면 기존 목록을 건드리지 않는다", () => {
  const seeded = [{ cat: "프로젝트", label: "그대로", href: "/projects/9" }];
  const { win } = mountDom(globalBox, { storage: { "omg:recent": JSON.stringify(seeded) } });
  assert.deepEqual(JSON.parse(win.localStorage.getItem("omg:recent")), seeded);
});

test("전역 검색: 빈 입력으로 포커스하면 '최근'을 드롭다운에 렌더", () => {
  const seeded = [
    { cat: "프로젝트", label: "루나 1집", href: "/projects/12" },
    { cat: "청구", label: "OMG-202607-1", href: "/invoices/3" },
  ];
  const { win, doc } = mountDom(globalBox, { storage: { "omg:recent": JSON.stringify(seeded) } });
  const input = doc.querySelector("input[name='q']");
  const pop = doc.querySelector("[data-suggest-pop]");
  fire(win, input, "focus");
  assert.ok(!pop.classList.contains("hidden"), "드롭다운 열림");
  assert.match(pop.innerHTML, /최근/, "그룹 헤더 '최근'");
  assert.match(pop.innerHTML, /루나 1집/, "최근 항목 라벨");
  assert.match(pop.innerHTML, /href="\/projects\/12"/, "항목 링크");
  assert.equal(pop.querySelectorAll("a").length, 2, "항목 2개(헤더 제외)");
});

test("비-전역 suggest 박스는 빈 입력에서 최근을 보여주지 않는다", () => {
  const projectBox = `
    <div data-search-suggest data-suggest-url="/projects/suggest">
      <input name="q" />
      <div data-suggest-pop class="hidden"></div>
    </div>`;
  const seeded = [{ cat: "프로젝트", label: "루나", href: "/projects/12" }];
  const { win, doc } = mountDom(projectBox, { storage: { "omg:recent": JSON.stringify(seeded) } });
  const input = doc.querySelector("input[name='q']");
  const pop = doc.querySelector("[data-suggest-pop]");
  fire(win, input, "focus");
  assert.ok(pop.classList.contains("hidden"), "드롭다운 닫힘(최근 미표시)");
  assert.equal(pop.innerHTML, "", "빈 팝업");
});
