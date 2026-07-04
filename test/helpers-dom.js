"use strict";

/**
 * jsdom 마운트 헬퍼 — 실제 `public/js/app.js`를 실제 서버 렌더 HTML 위에서 실행해
 * 콤보·폼 **상호작용**을 검증한다(정적 계약 가드(guardrails-ui)가 못 보는 동작 계층).
 *
 * 유일한 테스트 devDependency = jsdom(2026-07-04 사용자 승인 — '의존성 0' 원칙의 명시적 예외).
 * app.js는 DOMContentLoaded에 의존하지 않는 즉시실행(IIFE) 구조라, DOM 구성 후
 * window.eval로 로드하면 실브라우저 로드와 동일한 초기화가 일어난다.
 */

const fs = require("fs");
const path = require("path");
const { JSDOM } = require("jsdom");

const APP_SRC = fs.readFileSync(path.join(__dirname, "..", "public", "js", "app.js"), "utf8");

/**
 * body HTML을 마운트하고 app.js를 실행한 window/document를 돌려준다.
 * - fetch: 기본 스텁(호출 기록만, ok/json:{}) — app.js의 모든 fetch 소비부는 null/무형 가드가 있어 안전.
 * - scrollIntoView·confirm 등 jsdom 미구현/차단 API 폴리필.
 */
function mountDom(bodyHtml, { url = "http://localhost/", fetchImpl } = {}) {
  const dom = new JSDOM(`<!doctype html><html><head></head><body>${bodyHtml}</body></html>`, {
    url,
    runScripts: "outside-only",
    pretendToBeVisual: true,
  });
  const win = dom.window;
  if (!win.Element.prototype.scrollIntoView) win.Element.prototype.scrollIntoView = function () {};
  const fetchCalls = [];
  win.fetch = function (input, init) {
    fetchCalls.push({ url: String(input), init: init || {} });
    if (fetchImpl) return fetchImpl(input, init);
    return Promise.resolve({ ok: true, status: 200, type: "basic", json: () => Promise.resolve({}), text: () => Promise.resolve("") });
  };
  win.confirm = () => true;
  win.eval(APP_SRC);
  return { dom, win, doc: win.document, fetchCalls };
}

/** 버블링 이벤트 디스패치(위임 핸들러용). Event/KeyboardEvent 등 win 컨텍스트 생성. */
function fire(win, el, type, init = {}) {
  const Ctor = type.startsWith("key") ? win.KeyboardEvent : win.Event;
  const ev = new Ctor(type, { bubbles: true, cancelable: true, ...init });
  // KeyboardEventInit의 isComposing을 jsdom이 무시할 수 있어 명시 고정(IME 가드 테스트용).
  if (init.isComposing) Object.defineProperty(ev, "isComposing", { value: true });
  el.dispatchEvent(ev);
  return ev;
}

/** setTimeout(0) 기반 초기화(dirty 스냅샷 등)·비동기 갱신 대기. */
const tick = (ms = 20) => new Promise((r) => setTimeout(r, ms));

module.exports = { mountDom, fire, tick };
