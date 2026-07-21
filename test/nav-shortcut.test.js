"use strict";

// ── 네비게이션 단축키(g + 문자) 회귀 잠금(2026-07-22) ──
// 실제 public/js/app.js를 jsdom에서 실행. 핵심 계약:
//  (1) g→문자로 해당 [data-nav-key] 사이드바 링크가 클릭된다(=이동).
//  (2) 입력/선택/contenteditable 포커스 중엔 절대 안 먹는다(사용자 요청).
//  (3) g 없이 단일 키·IME 조합·수식키 조합은 이동시키지 않는다.
// jsdom은 실제 페이지 내비게이션을 구현하지 않으므로, 대상 링크의 click 이벤트를 가로채(preventDefault) 검증한다.
const test = require("node:test");
const assert = require("node:assert");
const { mountDom, fire } = require("./helpers-dom");

const sidebar = `
  <aside>
    <a href="/" data-nav-key="h">대시보드</a>
    <a href="/projects" data-nav-key="p">프로젝트</a>
    <a href="/invoices" data-nav-key="i">청구</a>
  </aside>
  <input type="text" id="ti" />
  <textarea id="ta"></textarea>`;

function spyClicks(doc) {
  const hits = [];
  doc.querySelectorAll("[data-nav-key]").forEach((a) => {
    a.addEventListener("click", (e) => { e.preventDefault(); hits.push(a.getAttribute("href")); });
  });
  return hits;
}

test("g→p 는 프로젝트 링크로 이동(클릭)", () => {
  const { win, doc } = mountDom(sidebar);
  const hits = spyClicks(doc);
  fire(win, doc.body, "keydown", { key: "g" });
  fire(win, doc.body, "keydown", { key: "p" });
  assert.deepEqual(hits, ["/projects"]);
});

test("g→i 는 청구, 대소문자 무관", () => {
  const { win, doc } = mountDom(sidebar);
  const hits = spyClicks(doc);
  fire(win, doc.body, "keydown", { key: "G" }); // 대문자 g도 접두로 인식
  fire(win, doc.body, "keydown", { key: "I" });
  assert.deepEqual(hits, ["/invoices"]);
});

test("입력창 포커스 중엔 g→p 가 안 먹는다(핵심)", () => {
  const { win, doc } = mountDom(sidebar);
  const hits = spyClicks(doc);
  const input = doc.getElementById("ti");
  fire(win, input, "keydown", { key: "g" }); // e.target=input → editable → 무시
  fire(win, input, "keydown", { key: "p" });
  assert.deepEqual(hits, [], "이동 없음");
});

test("textarea 포커스 중에도 안 먹는다", () => {
  const { win, doc } = mountDom(sidebar);
  const hits = spyClicks(doc);
  const ta = doc.getElementById("ta");
  fire(win, ta, "keydown", { key: "g" });
  fire(win, ta, "keydown", { key: "p" });
  assert.deepEqual(hits, []);
});

test("g 없이 단일 키는 이동 안 함", () => {
  const { win, doc } = mountDom(sidebar);
  const hits = spyClicks(doc);
  fire(win, doc.body, "keydown", { key: "p" });
  assert.deepEqual(hits, []);
});

test("IME 조합 중 둘째 키는 무시", () => {
  const { win, doc } = mountDom(sidebar);
  const hits = spyClicks(doc);
  fire(win, doc.body, "keydown", { key: "g" });
  fire(win, doc.body, "keydown", { key: "p", isComposing: true }); // 조합 중 → 무시
  assert.deepEqual(hits, []);
});

test("수식키(Ctrl) 조합은 네비 단축키로 소비하지 않는다", () => {
  const { win, doc } = mountDom(sidebar);
  const hits = spyClicks(doc);
  fire(win, doc.body, "keydown", { key: "g" });
  fire(win, doc.body, "keydown", { key: "p", ctrlKey: true }); // Ctrl+p(인쇄 등) → 우리 것 아님
  assert.deepEqual(hits, []);
});

test("존재하지 않는 nav-key(g→z)는 아무 것도 안 함", () => {
  const { win, doc } = mountDom(sidebar);
  const hits = spyClicks(doc);
  fire(win, doc.body, "keydown", { key: "g" });
  fire(win, doc.body, "keydown", { key: "z" });
  assert.deepEqual(hits, []);
});
