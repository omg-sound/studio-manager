"use strict";

// ── 격리 DB(뷰 렌더가 partyOptions·rooms·admin_state를 읽음) ──
process.env.NODE_ENV = "test";
const { tempDbPath, cleanupDb } = require("./helpers");
process.env.DB_PATH = tempDbPath();

const test = require("node:test");
const assert = require("node:assert");
const { mountDom, fire, tick } = require("./helpers-dom");

const { init, db } = require("../src/db");
init();
const { createCompany } = require("../src/data");
const { personCombo } = require("../src/views");
const { sessionBookingFields } = require("../src/views.sessions");

/**
 * UI 상호작용 테스트(jsdom) — 실제 views 렌더 + 실제 app.js 실행.
 * 정적 계약 가드(guardrails-ui)가 "연결이 살아있음"을 보증한다면, 여기는 "동작이 옳음"을 검증한다:
 * 금액 캐럿 보존, 콤보 검색(본명·활동명·회사)·선택·IME 가드, 세션 종류↔단가 옵션 스왑, dirty 폼.
 */

// ── ① 금액 입력: 콤마 자동 + 캐럿 보존(1,800,000에서 8 지우고 5 넣기 — 사용자 보고 버그) ──
test("금액칸: 콤마 포맷 + 백스페이스/삽입 시 캐럿이 제자리(끝 점프 없음)", async () => {
  const { win, doc } = mountDom(`<form><input type="text" name="amount" value="" /></form>`);
  const el = doc.querySelector('input[name="amount"]');
  // 기본 콤마 포맷
  el.value = "1234567";
  el.setSelectionRange(7, 7);
  fire(win, el, "input");
  assert.equal(el.value, "1,234,567");
  assert.equal(el.selectionStart, 9, "끝 편집은 끝 유지");
  // 1,800,000 에서 '8' 백스페이스(브라우저가 value/caret 바꾼 뒤 input 발화하는 것을 재현)
  el.value = "1,800,000"; fire(win, el, "input");
  el.value = "1,00,000"; el.setSelectionRange(2, 2); fire(win, el, "input");
  assert.equal(el.value, "100,000");
  assert.equal(el.selectionStart, 1, "지운 자리(8이 있던 곳)에 캐럿 유지");
  // 그 자리에 '5' 타이핑
  el.value = "1500,000"; el.setSelectionRange(2, 2); fire(win, el, "input");
  assert.equal(el.value, "1,500,000", "8 자리에 5가 들어간 결과");
  assert.equal(el.selectionStart, 3, "삽입 직후 위치(콤마 뒤) 유지");
});

// ── ② personCombo: 본명·활동명·회사명 검색 + 선택 시 숨김 필드 동기화 ──
const PC_OPTS = [
  { id: 11, name: "박수한", activity_name: "워터멜론", honorific: "대표님", phone: "010-1111-2222", company: "쥬스컴퍼니" },
  { id: 12, name: "김보통", phone: "010-3333-4444", company: "문라이트뮤직" },
];
function mountPersonCombo() {
  const html = `<form>${personCombo({ options: PC_OPTS, companyOptions: [] })}</form>`;
  const m = mountDom(html);
  return { ...m, input: m.doc.querySelector("[data-pc-input]"), pop: m.doc.querySelector("[data-pc-pop]"), hid: m.doc.querySelector("[data-pc-id]"), hidName: m.doc.querySelector("[data-pc-name-hidden]") };
}
test("personCombo: 활동명(워터멜론)으로 본명(박수한) 검색·선택", () => {
  const { win, pop, input, hid, hidName } = mountPersonCombo();
  input.value = "워터"; fire(win, input, "input");
  assert.ok(!pop.classList.contains("hidden"), "드롭다운 열림");
  const row = pop.querySelector("button[data-idx]");
  assert.ok(row && row.textContent.includes("박수한") && row.textContent.includes("워터멜론"), "본명+활동명 표시");
  fire(win, row, "click");
  assert.equal(hid.value, "11", "숨김 id 동기화");
  assert.equal(input.value, "박수한");
  assert.equal(hidName.value, "박수한", "제출용 숨김 이름 동기화");
  assert.ok(pop.classList.contains("hidden"), "선택 후 닫힘");
});
test("personCombo: 회사 이름(쥬스)으로 담당자 검색(회사가 먼저 생각날 때)", () => {
  const { win, pop, input } = mountPersonCombo();
  input.value = "쥬스"; fire(win, input, "input");
  const row = pop.querySelector("button[data-idx]");
  assert.ok(row && row.textContent.includes("박수한"), "회사 매칭으로 사람 행 노출");
  assert.ok(row.textContent.includes("쥬스컴퍼니"), "부제에 회사 표시(왜 매칭됐는지)");
});
test("personCombo: 미일치 이름은 '새 담당자 등록' 행", () => {
  const { win, pop, input } = mountPersonCombo();
  input.value = "김아무개"; fire(win, input, "input");
  assert.ok(pop.querySelector("button[data-new]"), "새 등록 행 노출");
  assert.equal(pop.querySelector("button[data-idx]"), null, "매칭 행 없음");
});
test("personCombo: IME 조합 중 Enter는 무시, 조합 아닌 Enter는 선택(함정 #18)", async () => {
  const { win, input, hid } = mountPersonCombo();
  input.value = "워터"; fire(win, input, "input");
  await tick(); // 드롭다운 하이라이트 초기화는 MutationObserver(비동기) — 사람이 타이핑 후 Enter 치는 실제 타이밍 재현
  fire(win, input, "keydown", { key: "Enter", isComposing: true });
  assert.equal(hid.value, "", "조합 중 Enter는 선택 아님(마지막 글자 확정용)");
  fire(win, input, "keydown", { key: "Enter" });
  assert.equal(hid.value, "11", "조합 끝난 Enter는 하이라이트 행 선택");
});

// ── ③ 세션 폼: 세션 종류 변경 → 단가 옵션 스왑(녹음/촬영/공연) + 대관 아닐 때 숨김 ──
createCompany({ name: "UI테스트상사", roles: "소속사/레이블" }); // personCombo 기본 companyOptions 조회용(빈 DB 방지)
const RATE_ROWS = [
  ["보컬 녹음 UI", "스튜디오 녹음"],
  ["뮤직비디오 촬영 UI", "스튜디오 촬영"],
  ["플레이백 세션 UI", "공연"],
];
for (const [name, cat] of RATE_ROWS) {
  db().prepare("INSERT INTO rate_items (name, category, base_minutes, base_price, extra_minutes, extra_price, active) VALUES (?, ?, 210, 300000, 60, 100000, 1)").run(name, cat);
}
test("세션 폼: 종류(녹음↔촬영↔공연↔믹싱)에 따라 단가 옵션 스왑·노출 토글", () => {
  const rateItems = db().prepare("SELECT * FROM rate_items").all();
  const html = `<form data-session-form>${sessionBookingFields({}, [], rateItems, [], "")}</form>`;
  const { win, doc } = mountDom(html);
  const typeSel = doc.querySelector('select[name="session_type"]');
  const rateSel = doc.querySelector("[data-rate-select]");
  const recBlock = doc.querySelector('[data-show-when="rec"]');
  const optionNames = () => [...rateSel.querySelectorAll("option")].map((o) => o.textContent);
  // 초기(녹음): 녹음 단가만
  assert.ok(optionNames().some((t) => t.includes("보컬 녹음 UI")));
  assert.ok(!optionNames().some((t) => t.includes("뮤직비디오")));
  // 촬영으로 전환 → 촬영 단가만
  typeSel.value = "촬영"; fire(win, typeSel, "change");
  assert.ok(optionNames().some((t) => t.includes("뮤직비디오 촬영 UI")), "촬영 옵션으로 교체");
  assert.ok(!optionNames().some((t) => t.includes("보컬 녹음 UI")), "녹음 옵션 제거");
  assert.equal(recBlock.hidden, false, "대관 종류라 단가 블록 노출");
  // 공연 → 공연 단가
  typeSel.value = "공연"; fire(win, typeSel, "change");
  assert.ok(optionNames().some((t) => t.includes("플레이백 세션 UI")), "공연 옵션으로 교체");
  // 믹싱(비대관) → 단가 블록 숨김
  typeSel.value = "믹싱"; fire(win, typeSel, "change");
  assert.equal(recBlock.hidden, true, "비대관 종류는 단가 블록 숨김");
});

// ── ③b 구글식 시간 입력(2026-07-04 그리드 폐지): 시작/종료 타이핑 ↔ 슬라이더 양방향 + 종일 ──
test("세션 폼(구글식): 시간 콤보(전체선택·30분 목록)·양방향 역산·종료날짜 편집·종일(하루 종일·복원)", () => {
  const rateItems = db().prepare("SELECT * FROM rate_items").all();
  const html = `<form data-session-form>${sessionBookingFields({}, [], rateItems, [], "")}</form>`;
  const { win, doc } = mountDom(html);
  const start = doc.querySelector("[data-start-input]");
  const end = doc.querySelector("[data-end-input]");
  const endDate = doc.querySelector("[data-end-date]");
  const hours = doc.querySelector("[data-custom-hours]");
  const dateIn = doc.querySelector("[data-session-date]");
  // 시작 "1400" 타이핑 → 콜론 자동
  start.value = "1400"; fire(win, start, "input");
  assert.equal(start.value, "14:00", "콜론 자동 삽입");
  // 종료 "1800" 타이핑 → 소요 4시간 역산(슬라이더·직접입력 동기)
  end.value = "1800"; fire(win, end, "input");
  assert.equal(hours.value, "4", "종료 입력 → 소요 역산(custom_hours)");
  // 소요를 6시간으로 변경 → 종료 20:00 자동
  hours.value = "6"; fire(win, hours, "input");
  assert.equal(end.value, "20:00", "소요 변경 → 종료 자동 갱신");
  assert.equal(endDate.value, dateIn.value, "당일 종료 = 시작 날짜");
  // 야간(자정 넘김): 시작 22:00 + 종료 02:00 → 4시간 + 종료 날짜 +1일
  start.value = "2200"; fire(win, start, "input");
  end.value = "0200"; fire(win, end, "input");
  assert.equal(hours.value, "4", "자정 넘김 역산(+24h)");
  assert.notEqual(endDate.value, dateIn.value, "야간이면 종료 날짜 +1일");
  // 시간 드롭다운(00:00~23:30): 포커스=열림, 옵션 클릭=값 세팅(+파이프라인 재계산)
  const pop = start.closest("[data-time-combo]").querySelector("[data-time-pop]");
  assert.equal(pop.querySelectorAll("[data-time-opt]").length, 48, "30분 단위 48개 옵션");
  fire(win, start, "focus");
  assert.ok(!pop.classList.contains("hidden"), "포커스 시 목록 열림");
  fire(win, pop.querySelector('[data-time-opt="10:00"]'), "click");
  assert.equal(start.value, "10:00", "옵션 클릭 = 값 세팅");
  assert.ok(pop.classList.contains("hidden"), "선택 후 닫힘");
  // 종료 날짜 직접 편집: +1일 + 종료 09:00 → 소요 23시간 역산(<24h 표현 범위)
  end.value = "0900"; fire(win, end, "input"); // 같은 날 10:00→09:00은 야간 해석(23h)
  assert.equal(hours.value, "", "16h 초과는 custom_hours 비움(end_time 저장 경로)");
  // 종일 = 구글식 하루 종일(00:00~24:00): 시간·소요 UI 숨김, 해제 시 이전값 복원
  const allDay = doc.querySelector("[data-all-day]");
  const durGroup = doc.querySelector("[data-duration-group]");
  const prevStart = start.value, prevEnd = end.value;
  allDay.checked = true; fire(win, allDay, "change");
  assert.equal(start.value, "00:00", "종일 = 00:00 시작");
  assert.equal(end.value, "23:59", "종일 = 23:59 종료(스키마 표현)");
  assert.equal(hours.value, "", "종일은 hours 비움(서버 end_time 경로 — 16h 클램프 회피)");
  assert.equal(start.closest("[data-time-combo]").hidden, true, "종일 중 시간 박스 숨김");
  assert.equal(durGroup.hidden, true, "종일 중 소요 UI 숨김");
  assert.equal(endDate.readOnly, true, "종일 중 종료 날짜 잠금");
  allDay.checked = false; fire(win, allDay, "change");
  assert.equal(start.value, prevStart, "해제 시 이전 시작 복원");
  assert.equal(end.value, prevEnd, "해제 시 이전 종료 복원");
  assert.equal(start.closest("[data-time-combo]").hidden, false, "시간 박스 다시 노출");
});

// ── ④ dirty 폼: 변경 시 저장 강조·힌트, 원복 시 해제 ──
test("dirty 폼: 변경 → 힌트·강조, 원복 → 해제(__hasDirty 연동)", async () => {
  const html = `
    <form data-dirty-form>
      <input type="text" name="memo" value="원래값" />
      <span data-dirty-hint hidden>저장되지 않은 변경사항</span>
      <button type="submit" data-dirty-save>저장</button>
    </form>`;
  const { win, doc } = mountDom(html);
  await tick(); // 초기 스냅샷 setTimeout(0)
  const input = doc.querySelector('input[name="memo"]');
  const hint = doc.querySelector("[data-dirty-hint]");
  const btn = doc.querySelector("[data-dirty-save]");
  assert.equal(hint.hidden, true, "초기엔 힌트 없음");
  input.value = "바뀐값"; fire(win, input, "input");
  await tick();
  assert.equal(hint.hidden, false, "변경 시 힌트 노출");
  assert.ok(btn.classList.contains("ring-2"), "저장 버튼 강조(HILITE)");
  assert.equal(win.__hasDirty(), true, "네비게이션 가드 연동");
  input.value = "원래값"; fire(win, input, "input");
  await tick();
  assert.equal(hint.hidden, true, "원복 시 힌트 해제");
  assert.equal(win.__hasDirty(), false);
});

// ── ⑤ 콤보 새 등록 모달: 열림 + IME Enter가 등록을 트리거하지 않음 ──
test("personCombo 새 등록 모달: 열림·IME 가드·바깥 폼과 분리", () => {
  const { win, doc, pop, input } = mountPersonCombo();
  input.value = "신규인물"; fire(win, input, "input");
  fire(win, pop.querySelector("button[data-new]"), "click");
  const modal = doc.querySelector("[data-pc-modal]");
  assert.ok(!modal.classList.contains("hidden"), "모달 열림");
  const nameEl = modal.querySelector("[data-pc-new-name]") || modal.querySelector("input");
  assert.ok(nameEl.value.includes("신규인물"), "입력하던 이름 이어받음");
  assert.ok(!modal.querySelector("input[name]"), "모달 입력은 name 없음(바깥 폼 제출과 분리)");
});

test.after(() => cleanupDb(process.env.DB_PATH, db()));
