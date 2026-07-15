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
const { personCombo, companyCombo, searchBox, listGroup } = require("../src/views");
const { sessionBookingFields } = require("../src/views.sessions");
const { unbilledInvoiceForm } = require("../src/views.projects");

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
  assert.equal(input.value, "박수한 대표님 (워터멜론)", "표시 = 본명 호칭 (활동명) 병기(2026-07-05)");
  assert.equal(hidName.value, "박수한", "제출용 숨김 이름은 순수 본명(라벨 그대로 저장 방지)");
  assert.ok(pop.classList.contains("hidden"), "선택 후 닫힘");
});
test("personCombo: 라벨('본명 호칭 (활동명)') 상태로 재열람해도 매칭 행 유지 + id 안 풀림", () => {
  const { win, pop, input, hid } = mountPersonCombo();
  input.value = "워터"; fire(win, input, "input");
  fire(win, pop.querySelector("button[data-idx]"), "click"); // 선택 → 라벨 입력됨
  assert.equal(input.value, "박수한 대표님 (워터멜론)", "선택 후 필드에 호칭 포함");
  fire(win, input, "click"); // 재열람(클릭) — q = 라벨 전체
  assert.ok(pop.querySelector("button[data-idx]"), "라벨 값으로도 그 사람 행이 뜬다(새 등록 행으로 밀리지 않음)");
  assert.equal(pop.querySelector("button[data-new]"), null, "라벨 정확 일치 → '새 등록' 행 없음");
  assert.equal(hid.value, "11", "id 유지");
});
test("personCombo: selectedId 서버 렌더 — 입력 라벨 병기(호칭 포함)·숨김 순수명·필드 밑 소속(회사) 주석", () => {
  const html = `<form>${personCombo({ selectedId: 11, options: PC_OPTS, companyOptions: [] })}</form>`;
  const { doc } = mountDom(html);
  assert.equal(doc.querySelector("[data-pc-input]").value, "박수한 대표님 (워터멜론)", "편집 진입 시에도 본명 호칭 (활동명)");
  assert.equal(doc.querySelector("[data-pc-name-hidden]").value, "박수한", "제출 숨김 이름 = 순수 본명");
  const info = doc.querySelector("[data-pc-info]");
  assert.ok(!info.classList.contains("hidden"), "정보줄 노출(무JS·초기 렌더)");
  assert.ok(info.textContent.includes("쥬스컴퍼니"), "소속 회사 주석 표시");
  assert.ok(info.textContent.includes("010-1111-2222"), "전화 표시");
});
test("personCombo: 호칭만 있고 활동명 없으면 '본명 호칭'만(제출은 순수 본명)", () => {
  const html = `<form>${personCombo({ selectedId: 21, options: [{ id: 21, name: "김보종", honorific: "대표님" }], companyOptions: [] })}</form>`;
  const { doc } = mountDom(html);
  assert.equal(doc.querySelector("[data-pc-input]").value, "김보종 대표님", "본명 호칭");
  assert.equal(doc.querySelector("[data-pc-name-hidden]").value, "김보종", "제출은 순수 본명");
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
  // 소요를 6시간으로 변경(슬라이더 — 커스텀 입력은 hidden 제출값으로만 존재) → 종료 20:00 자동
  const slider = doc.querySelector("[data-duration-slider]");
  slider.value = "360"; fire(win, slider, "input");
  assert.equal(end.value, "20:00", "소요 변경 → 종료 자동 갱신");
  assert.equal(hours.value, "6", "hidden custom_hours 미러");
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
  // 종일 = 구글/애플 개념(하루 종일·시간 없음): 시간·소요·종료날짜 UI 숨김, 시간 값은 안 건드림(서버가 NULL로 저장).
  const allDay = doc.querySelector("[data-all-day]");
  const durationWrap = doc.querySelector("[data-duration-wrap]");
  const prevStart = start.value, prevEnd = end.value;
  assert.equal(allDay.getAttribute("name"), "all_day", "체크박스가 제출 소스(name=all_day)");
  allDay.checked = true; fire(win, allDay, "change");
  assert.equal(start.closest("[data-time-combo]").hidden, true, "종일 중 시간 박스 숨김");
  assert.equal(durationWrap.hidden, true, "종일 중 소요 블록 숨김");
  assert.equal(endDate.hidden, false, "종일 중에도 종료 날짜는 남음(다일 일정 지정용)");
  assert.equal(start.value, prevStart, "종일이 시간값을 건드리지 않음(서버가 NULL로 저장)");
  // 다일 종료 날짜를 바꿔도 자동동기가 덮어쓰지 않음(사용자 지정 보존)
  const dv = doc.querySelector("[data-session-date]");
  const multiEnd = dv.value.slice(0, 8) + "28";
  endDate.value = multiEnd; fire(win, endDate, "change");
  fire(win, dv, "change"); // 시작 날짜 이벤트가 종료 날짜를 덮지 않아야
  assert.equal(endDate.value, multiEnd, "종일 다일 종료 날짜 보존(updatePreview가 안 덮음)");
  allDay.checked = false; fire(win, allDay, "change");
  assert.equal(start.value, prevStart, "해제 후에도 시간 그대로");
  assert.equal(start.closest("[data-time-combo]").hidden, false, "시간 박스 다시 노출");
});

// ── ③b1 날짜/시간 콤보 팝오버 버튼 = tabindex=-1(날짜 타이핑 후 Tab이 팝오버 버튼 아닌 다음 필드[시간]로) ──
test("세션 폼: 날짜·시간 콤보 팝오버 버튼은 tabindex=-1(Tab이 다음 필드로 넘어감)", () => {
  const rateItems = db().prepare("SELECT * FROM rate_items").all();
  const html = `<form data-session-form>${sessionBookingFields({}, [], rateItems, [], "")}</form>`;
  const { doc } = mountDom(html);
  // 날짜 콤보(session_date): 포커스 → 월 그리드 팝오버 렌더 → 버튼(‹ › 및 날짜) 전부 tab 순서 밖
  const dcWrap = doc.querySelector("[data-session-date]").closest("[data-date-combo]");
  const dateInput = dcWrap.querySelector("[data-date-input]");
  dateInput.focus();
  const dateBtns = dcWrap.querySelector("[data-date-pop]").querySelectorAll("button");
  assert.ok(dateBtns.length > 0, "날짜 팝오버 버튼 렌더됨");
  assert.ok(Array.prototype.every.call(dateBtns, (b) => b.getAttribute("tabindex") === "-1"), "날짜 팝오버 버튼 전부 tabindex=-1");
  assert.equal(dateInput.getAttribute("tabindex"), null, "날짜 입력칸 자체는 tab 가능");
  // 시간 콤보(start_time): 48개 옵션 버튼도 tab 순서 밖(시작→종료시간 Tab도 팝오버 안 걸림)
  const timeBtns = doc.querySelector("[data-start-input]").closest("[data-time-combo]").querySelectorAll("[data-time-opt]");
  assert.equal(timeBtns.length, 48, "시간 옵션 48개");
  assert.ok(Array.prototype.every.call(timeBtns, (b) => b.getAttribute("tabindex") === "-1"), "시간 옵션 전부 tabindex=-1");
});

// ── ③b2 단가 항목 선택은 소요시간을 바꾸지 않는다(시간 흐름 우선 — 2026-07-05 사용자 요청) ──
test("세션 폼: 단가 항목을 골라도 사용자가 잡은 소요시간이 유지됨", () => {
  const rateItems = db().prepare("SELECT * FROM rate_items").all();
  const html = `<form data-session-form>${sessionBookingFields({}, [], rateItems, [], "")}</form>`;
  const { win, doc } = mountDom(html);
  const start = doc.querySelector("[data-start-input]");
  const end = doc.querySelector("[data-end-input]");
  const rateSel = doc.querySelector("[data-rate-select]");
  // 사용자가 시간 먼저 잡음: 14:00~16:00(2시간)
  start.value = "1400"; fire(win, start, "input");
  end.value = "1600"; fire(win, end, "input");
  assert.equal(doc.querySelector("[data-custom-hours]").value, "2", "사용자 소요 2시간");
  // 단가 항목(1Pro=210분=3.5h) 선택 → 소요는 그대로 2시간, 종료도 16:00 유지
  const opt = [...rateSel.querySelectorAll("option")].find((o) => o.value && o.textContent.includes("보컬 녹음 UI"));
  rateSel.value = opt.value; fire(win, rateSel, "change");
  assert.equal(doc.querySelector("[data-custom-hours]").value, "2", "단가 항목 선택해도 소요 불변");
  assert.equal(end.value, "16:00", "종료 시간도 그대로");
});

// ── ③f 장소=외부 선택 시 주소 입력 노출(2026-07-05) ──
test("세션 폼: 장소가 외부(is_external)면 주소 입력 노출, 스튜디오 룸이면 숨김", () => {
  const rooms = [{ id: 1, name: "A룸", is_external: 0 }, { id: 2, name: "외부일정", is_external: 1 }];
  const html = `<form data-session-form>${sessionBookingFields({}, [], [], rooms, "")}</form>`;
  const { win, doc } = mountDom(html);
  const roomSel = doc.querySelector('select[name="room_id"]');
  const locWrap = doc.querySelector("[data-external-loc]");
  // 초기: 첫 장소(A룸=스튜디오) → 주소 숨김
  assert.equal(locWrap.hidden, true, "스튜디오 룸이면 주소 숨김");
  // 외부일정 선택 → 주소 노출
  roomSel.value = "2"; fire(win, roomSel, "change");
  assert.equal(locWrap.hidden, false, "외부 장소 선택 시 주소 노출");
  assert.ok(locWrap.querySelector('input[name="location"]'), "location 입력 존재");
  // 다시 스튜디오 룸 → 숨김
  roomSel.value = "1"; fire(win, roomSel, "change");
  assert.equal(locWrap.hidden, true, "다시 숨김");
});

// ── ③c 새 작성 프리필 + 자동완성 차단(hidden 제출) ──
test("세션 폼(새 작성): 시작=지금 기준 30분 슬롯 프리필·종료=+1Pro 자동, 보이는 입력 nameless+hidden 동기", () => {
  const rateItems = db().prepare("SELECT * FROM rate_items").all();
  const html = `<form data-session-form>${sessionBookingFields({}, [], rateItems, [], "")}</form>`; // data-session-id 없음 = 생성 폼
  const { doc, win } = mountDom(html);
  const start = doc.querySelector("[data-start-input]");
  const end = doc.querySelector("[data-end-input]");
  const hidStart = doc.querySelector('input[type="hidden"][name="start_time"]');
  const hidEnd = doc.querySelector('input[type="hidden"][name="end_time"]');
  // 프리필: 시작=HH:MM(지금 기준 다음 30분 슬롯), 종료=시작+기본 1Pro(스튜디오 기본 블록)
  assert.match(start.value, /^([01][0-9]|2[0-3]):(00|30)$/, "시작이 30분 슬롯으로 프리필");
  assert.ok(end.value, "종료 자동 채움(+1Pro)");
  // 자동완성 차단: 보이는 입력은 name 없음, 제출은 hidden(값 동기)
  assert.equal(start.getAttribute("name"), null, "보이는 시작 입력 nameless(브라우저 제안 차단)");
  assert.equal(hidStart.value, start.value, "hidden 시작 동기");
  assert.equal(hidEnd.value, end.value, "hidden 종료 동기");
  // 타이핑 후에도 hidden 동기 유지
  start.value = "0930"; fire(win, start, "input");
  assert.equal(hidStart.value, "09:30", "타이핑 → hidden 갱신");
});

// ── ③d 편집 폼 디렉터 프리필(칩 콤보, 2026-07-10): 기존 디렉터들이 칩으로 렌더 + 제출 hidden 쌍 ──
test("세션 편집 폼: 기존 담당 디렉터가 칩으로 채워짐(id·본명 hidden 쌍)", () => {
  const { createPerson } = require("../src/data");
  const p1 = createPerson({ family_name: "전", given_name: "범선", honorific: "대표님" });
  const p2 = createPerson({ name: "감초아", nickname: "초아비트" }); // 아티스트 겸 디렉터
  const projId = Number(db().prepare("INSERT INTO projects (title, project_type, rate, created_at) VALUES ('디렉터폼', 'session', 0, datetime('now'))").run().lastInsertRowid);
  const sid = Number(db().prepare("INSERT INTO sessions (project_id, session_type, session_date, all_day, start_time, end_time, status, director_party_id) VALUES (?, '공연', '2026-07-20', 1, NULL, NULL, '예정', ?)").run(projId, p1).lastInsertRowid);
  db().prepare("INSERT INTO session_directors (session_id, party_id) VALUES (?, ?)").run(sid, p1);
  db().prepare("INSERT INTO session_directors (session_id, party_id) VALUES (?, ?)").run(sid, p2);

  const s = db().prepare("SELECT * FROM sessions WHERE id = ?").get(sid);
  const html = `<form data-session-form data-session-id="${sid}">${sessionBookingFields(s, [], [], [], "")}</form>`;
  const { doc } = mountDom(html);
  const combo = doc.querySelector("[data-person-combo][data-pc-multi]");
  assert.ok(combo, "디렉터 = 칩 personCombo 하나(행 UI 없음)");
  assert.equal(doc.querySelector("[data-director-row]"), null, "옛 행 마크업 제거");
  // 칩 프리필: 기존 디렉터가 배지로(라벨=본명 호칭 (활동명)), 제출은 칩 hidden id + 순수 본명 쌍
  const chips = [...combo.querySelectorAll("[data-pc-chip]")];
  assert.deepEqual(chips.map((c) => c.querySelector("span").textContent), ["감초아 (초아비트)", "전범선 대표님"], "칩 라벨(이름순)");
  assert.deepEqual(chips.map((c) => c.querySelector("[data-pc-chip-id]").value), [String(p2), String(p1)], "칩 hidden id = 당사자 id");
  assert.deepEqual(chips.map((c) => c.querySelector("[data-pc-chip-name]").value), ["감초아", "전범선"], "칩 hidden 이름 = 순수 본명");
  assert.equal(chips[0].querySelector("[data-pc-chip-id]").name, "director_contact_id", "제출 필드명(인덱스 페어링)");
  assert.equal(combo.querySelector("[data-pc-name-hidden]"), null, "칩 모드엔 단일 hidden 없음");
  assert.equal(combo.querySelector("[data-pc-input]").value, "", "검색칸은 비어 있음");
  // 종일 세션이므로 시간 UI는 숨김, 종일 체크됨
  assert.equal(doc.querySelector("[data-all-day]").checked, true, "종일 세션 → 체크");
});
test("personCombo simpleModal(대표자): 회사·직책·활동명 필드 없음, 이름만으로 등록 동작", () => {
  const html = `<form>${personCombo({ idField: "owner_id", nameField: "owner_name", options: [], entityLabel: "대표자", simpleModal: true })}</form>`;
  const fetchCalls = [];
  const { win, doc } = mountDom(html, { fetchImpl: (url, init) => { fetchCalls.push({ url: String(url), body: init && init.body }); return Promise.resolve({ ok: true, json: () => Promise.resolve({ ok: true, id: 99, name: "김대표" }) }); } });
  const modal = doc.querySelector("[data-pc-modal]");
  // 대표자 모달엔 회사·직책·활동명 없음(이 업체 대표로 자동)
  assert.equal(modal.querySelector("[data-pc-company]"), null, "회사 필드 없음");
  assert.equal(modal.querySelector("[data-pc-job]"), null, "직책 필드 없음");
  assert.equal(modal.querySelector("[data-pc-activity]"), null, "활동명 필드 없음");
  assert.ok(modal.querySelector("[data-pc-phone]") && modal.querySelector("[data-pc-email]"), "전화·이메일은 있음");
  // 새 등록 열고 이름 입력 → 저장(회사/직책 읽기가 null이어도 안 깨지고 fetch)
  const input = doc.querySelector("[data-pc-input]");
  input.value = "김대표"; fire(win, input, "input");
  fire(win, doc.querySelector("[data-pc-pop]").querySelector("[data-new]"), "click");
  modal.querySelector("[data-pc-name]").value = "김대표";
  fire(win, modal.querySelector("[data-pc-save]"), "click");
  assert.equal(fetchCalls.length, 1, "POST /contacts 호출(예외 없이)");
  assert.ok(fetchCalls[0].url.indexOf("/contacts") !== -1);
  assert.ok(fetchCalls[0].body.indexOf("company=") === -1, "회사 파라미터 미포함(업체 저장 시 owner 흐름이 연결)");
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

// ── ④-b 네비게이션 가드: 일반 링크=클릭 가로채 모달, data-no-guard 링크(취소)=모달 없이 통과 ──
// 2026-07-05 발견 버그: data-no-guard가 커스텀 모달만 막고 beforeunload 프롬프트는 못 막던 것 —
// 여기선 커스텀 모달·preventDefault 동작만 검증(네이티브 beforeunload 다이얼로그는 jsdom이 표시하지 않아 검증 불가 —
// 실제 크롬 E2E로 확인: 취소 클릭 시 네이티브 프롬프트 없이 목록으로 이동).
test("네비게이션 가드: 일반 링크는 dirty일 때 가로채 모달, data-no-guard(취소)는 통과", async () => {
  const html = `
    <form data-dirty-form>
      <input type="text" name="memo" value="원래값" />
      <button type="submit" data-dirty-save>저장</button>
    </form>
    <a href="/other">다른 링크</a>
    <a href="/projects" data-no-guard>취소</a>`;
  const { win, doc } = mountDom(html);
  await tick();
  const input = doc.querySelector('input[name="memo"]');
  input.value = "바뀐값"; fire(win, input, "input");
  await tick();
  assert.equal(win.__hasDirty(), true);

  const plainLink = doc.querySelector('a[href="/other"]');
  const ev1 = fire(win, plainLink, "click");
  assert.equal(ev1.defaultPrevented, true, "일반 링크는 dirty 상태에서 기본 동작 차단");
  assert.ok(doc.querySelector("[data-nav-guard]"), "커스텀 저장/저장하지않음 모달 노출");
  doc.querySelector("[data-nav-guard]").remove(); // 다음 검증을 위해 정리

  const cancelLink = doc.querySelector('a[href="/projects"]');
  const ev2 = fire(win, cancelLink, "click");
  assert.equal(ev2.defaultPrevented, false, "data-no-guard 링크는 기본 동작(이동)을 막지 않음");
  assert.ok(!doc.querySelector("[data-nav-guard]"), "커스텀 모달 없음");
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

// ── ⑤-b 새 등록 모달: 텍스트 드래그 선택이 배경에서 끝나도 닫히지 않아야 한다(2026-07-06 사용자 리포트) ──
// 실제 버그: 이름 칸에서 드래그로 전체 선택 중 마우스를 모달 배경 위에서 떼면, click 이벤트의 target이
// (mousedown=안쪽, mouseup=배경의 공통 조상인) 배경 자신이 되어 '배경 클릭 닫기'가 오작동해 모달이 닫혔다.
// mousedown도 배경에서 시작했을 때만 진짜 배경 클릭으로 보는 수정 검증.
test("personCombo 새 등록 모달: 안쪽에서 시작한 드래그가 배경에서 끝나도(mousedown≠배경) 안 닫힘, 진짜 배경 클릭은 닫힘", () => {
  const { win, doc, pop, input } = mountPersonCombo();
  input.value = "신규인물"; fire(win, input, "input");
  fire(win, pop.querySelector("button[data-new]"), "click");
  const modal = doc.querySelector("[data-pc-modal]");
  const nameEl = modal.querySelector("[data-pc-new-name]") || modal.querySelector("input");
  assert.ok(!modal.classList.contains("hidden"), "모달 열림(사전조건)");

  // 드래그 시뮬레이션: mousedown은 이름 입력칸(안쪽), click은 배경(모달 자신)에서 발생.
  fire(win, nameEl, "mousedown");
  fire(win, modal, "click");
  assert.ok(!modal.classList.contains("hidden"), "안쪽에서 시작한 드래그면 배경 클릭으로 안 쳐서 안 닫힘");

  // 진짜 배경 클릭: mousedown·click 둘 다 배경(모달 자신)에서 발생 → 정상적으로 닫힘.
  fire(win, modal, "mousedown");
  fire(win, modal, "click");
  assert.ok(modal.classList.contains("hidden"), "mousedown·click 둘 다 배경이면 닫힘(정상 동작 보존)");
});

test.after(() => cleanupDb(process.env.DB_PATH, db()));

// ── ④ 제작/운영 companyCombo: 사람(관계자·개인) 선택 → hidden party-id 세팅(2026-07-05) ──
test("companyCombo 제작/운영: 관계자(사람) 검색·선택 시 party-id + 이름 세팅, 타이핑은 party-id 해제", () => {
  const { createPerson } = require("../src/data");
  const pid = createPerson({ name: "제작피디" }); // 관계자(개인 제작자)
  const html = `<form>${companyCombo("production_company", "", "제작사", "제작/운영", { partyIdField: "production_party_id", partyIdValue: "" })}</form>`;
  const { win, doc } = mountDom(html);
  const input = doc.querySelector("[data-cc-input]");
  const hidName = doc.querySelector("[data-cc-hidden]");
  const hidPid = doc.querySelector("[data-cc-party-id]");
  assert.ok(hidPid, "party-id hidden 필드 존재(제작/운영만)");
  // 사람 검색
  input.value = "제작피디"; fire(win, input, "input");
  const pop = doc.querySelector("[data-cc-pop]");
  const row = pop.querySelector("button[data-idx]");
  assert.ok(row && row.textContent.includes("제작피디"), "관계자가 드롭다운에 노출");
  assert.ok(row.textContent.includes("관계자"), "부제에 관계자 표기");
  fire(win, row, "click");
  assert.equal(input.value, "제작피디", "선택 시 이름 채움");
  assert.equal(hidName.value, "제작피디", "제출용 이름(production_company) 동기화");
  assert.equal(String(hidPid.value), String(pid), "party-id = 그 사람 party id");
  // 다시 타이핑하면 party-id 해제(선택으로만 확정)
  input.value = "다른회사"; fire(win, input, "input");
  assert.equal(hidPid.value, "", "타이핑 시 party-id 해제");
});
test("companyCombo 소속/레이블: partyIdField 없으면 party-id 필드도 없음(회사 전용)", () => {
  const html = `<form>${companyCombo("artist_company", "", "소속사/레이블", "소속/레이블")}</form>`;
  const { doc } = mountDom(html);
  assert.equal(doc.querySelector("[data-cc-party-id]"), null, "소속/레이블은 party-id 없음(회사만)");
});

// ── ④b 제작/운영에 아티스트(개인) 선택: 활동명 병기 + 고객측 담당자 자동채움(2026-07-05) ──
test("companyCombo 제작/운영: 아티스트는 활동명 병기 표시, 선택 시 담당자 비어있으면 자동채움", () => {
  const { createPerson, contactOptions } = require("../src/data");
  const aid = createPerson({ name: "조형우", nickname: "형우비트" }); // 아티스트(활동명) 겸 제작
  const { personCombo: pc } = require("../src/views");
  // 폼에 제작/운영(companyCombo+people) + 고객측 담당자(personCombo) 함께
  const html = `<form>
    ${companyCombo("production_company", "", "제작사", "제작/운영", { partyIdField: "production_party_id" })}
    ${pc({ options: contactOptions() })}
  </form>`;
  const { win, doc } = mountDom(html);
  const cc = doc.querySelector("[data-company-combo]");
  const ccInput = cc.querySelector("[data-cc-input]");
  const ccPid = cc.querySelector("[data-cc-party-id]");
  const pcRoot = doc.querySelector("[data-person-combo]");
  const pcId = pcRoot.querySelector("[data-pc-id]");
  const pcInput = pcRoot.querySelector("[data-pc-input]");
  // 아티스트 검색(활동명으로도)
  ccInput.value = "형우"; fire(win, ccInput, "input");
  const row = cc.querySelector("[data-cc-pop] button[data-idx]");
  assert.ok(row && row.textContent.includes("조형우") && row.textContent.includes("형우비트"), "드롭다운에 본명+활동명 병기");
  fire(win, row, "click");
  assert.equal(ccInput.value, "조형우 (형우비트)", "선택 시 필드에 활동명 병기");
  assert.equal(String(ccPid.value), String(aid), "production_party_id = 그 사람");
  // 담당자 자동채움(비어있었으므로)
  assert.equal(String(pcId.value), String(aid), "고객측 담당자 자동채움 = 같은 개인");
  assert.ok(pcInput.value.includes("조형우"), "담당자 필드에 이름 표시");
});
test("companyCombo 제작/운영: 담당자가 이미 있으면 자동채움 안 함(존중)", () => {
  const { createPerson, contactOptions } = require("../src/data");
  const producer = createPerson({ name: "제작자갑" });
  const other = createPerson({ name: "기존담당자을" });
  const { personCombo: pc } = require("../src/views");
  // 담당자 personCombo에 기존 선택(selectedId) 세팅
  const html = `<form>
    ${companyCombo("production_company", "", "제작사", "제작/운영", { partyIdField: "production_party_id" })}
    ${pc({ selectedId: other, options: contactOptions() })}
  </form>`;
  const { win, doc } = mountDom(html);
  const cc = doc.querySelector("[data-company-combo]");
  const ccInput = cc.querySelector("[data-cc-input]");
  const pcId = doc.querySelector("[data-person-combo] [data-pc-id]");
  assert.equal(String(pcId.value), String(other), "초기 담당자 = 기존담당자을");
  ccInput.value = "제작자갑"; fire(win, ccInput, "input");
  fire(win, cc.querySelector("[data-cc-pop] button[data-idx]"), "click");
  assert.equal(String(pcId.value), String(other), "이미 담당자 있으면 자동채움 안 함(존중)");
});

// ── ④c 전수점검(2026-07-05): 제작/운영 콤보 — 라벨 재타이핑 시 id 유지 + 새 사람 브로드캐스트 수신 ──
test("companyCombo 제작/운영: 병기 라벨 정확 재입력 시 party-id 유지(선택 안 풀림)", () => {
  const { createPerson } = require("../src/data");
  const pid = createPerson({ name: "표길동", nickname: "길동비트" });
  const html = `<form>${companyCombo("production_company", "", "제작사", "제작/운영", { partyIdField: "production_party_id" })}</form>`;
  const { win, doc } = mountDom(html);
  const input = doc.querySelector("[data-cc-input]");
  const hidPid = doc.querySelector("[data-cc-party-id]");
  input.value = "길동비트"; fire(win, input, "input");
  fire(win, doc.querySelector("[data-cc-pop] button[data-idx]"), "click");
  assert.equal(String(hidPid.value), String(pid), "선택으로 id 확정");
  // 라벨 그대로 재입력(예: 전체선택 후 동일 텍스트 붙여넣기) → 정확 일치 유일 → id 유지
  input.value = "표길동 (길동비트)"; fire(win, input, "input");
  assert.equal(String(hidPid.value), String(pid), "정확 라벨 재입력에도 id 유지");
  input.value = "표길동 (길동비"; fire(win, input, "input");
  assert.equal(hidPid.value, "", "부분 문자열은 id 해제(선택으로만 확정)");
});
test("companyCombo 제작/운영: 다른 콤보(personCombo 모달)에서 만든 새 사람이 즉시 검색됨(party-created)", () => {
  const html = `<form>${companyCombo("production_company", "", "제작사", "제작/운영", { partyIdField: "production_party_id" })}</form>`;
  const { win, doc } = mountDom(html);
  // personCombo 간이 등록이 쏘는 브로드캐스트 재현(name=본명·activity)
  win.eval(`document.dispatchEvent(new CustomEvent("party-created", { detail: { kind: "person", id: 777, name: "새담당제작", activity: "새비트" } }))`);
  const input = doc.querySelector("[data-cc-input]");
  input.value = "새비트"; fire(win, input, "input");
  const row = doc.querySelector("[data-cc-pop] button[data-idx]");
  assert.ok(row && row.textContent.includes("새담당제작") && row.textContent.includes("새비트"), "브로드캐스트로 즉시 검색·병기");
  fire(win, row, "click");
  assert.equal(doc.querySelector("[data-cc-party-id]").value, "777", "선택 시 그 사람 id");
});

// ── ⑤ artistCombo 콤마 다중(2026-07-05): 마지막 조각 검색 + 선택 이어붙임 ──
function mountArtistCombo(optsJson) {
  const html = `<form>
    <div data-artist-combo>
      <input type="hidden" name="artist_contact_id" value="" data-artist-cid />
      <input type="hidden" name="artist" value="" data-artist-hidden />
      <div class="relative">
        <div class="input" data-artist-chips>
          <input class="input" type="text" data-artist-input autocomplete="off" role="combobox" />
        </div>
        <div class="hidden" data-artist-pop role="listbox"></div>
      </div>
      <script type="application/json" data-artist-options>${JSON.stringify(optsJson)}</script>
    </div>
    <div data-company-combo>
      <input type="hidden" name="artist_company" value="" data-cc-hidden />
      <input class="input" type="text" data-cc-input autocomplete="off" />
      <div class="hidden" data-cc-pop></div>
      <script type="application/json" data-cc-options>[]</script>
    </div>
  </form>`;
  const m = mountDom(html);
  return { ...m, input: m.doc.querySelector("[data-artist-input]"), pop: m.doc.querySelector("[data-artist-pop]"), cid: m.doc.querySelector("[data-artist-cid]") };
}
const ARTIST_OPTS = [
  { name: "아이유", contactId: 31, realName: "이지은", sub: "아티스트", agency: "이담" },
  { name: "태연", contactId: 32, realName: "", sub: "아티스트", agency: "SM" },
];
test("artistCombo(칩): 단일 선택 = 칩 1개 + 명시 cid + 소속사 자동 채움", () => {
  const { win, doc, input, pop, cid } = mountArtistCombo(ARTIST_OPTS);
  input.value = "아이"; fire(win, input, "input");
  fire(win, pop.querySelector("button[data-idx]"), "click");
  assert.deepEqual([...doc.querySelectorAll("[data-artist-chip]")].map((c) => c.querySelector("span").textContent.trim()), ["아이유 (이지은)"]);
  assert.equal(doc.querySelector('input[name="artist"]').value, "아이유", "제출 = 활동명");
  assert.equal(cid.value, "31", "단일 = 명시 id");
  assert.equal(doc.querySelector('input[name="artist_company"]').value, "이담", "소속사 자동 채움");
});
test("artistCombo(칩): 둘째 선택 = 칩 추가·cid 비움·소속사는 첫 아티스트 유지", () => {
  const { win, doc, input, pop, cid } = mountArtistCombo(ARTIST_OPTS);
  input.value = "아이"; fire(win, input, "input");
  fire(win, pop.querySelector("button[data-idx]"), "click");
  input.value = "태"; fire(win, input, "input"); // 검색칸은 비워졌으므로 새로 타이핑
  const row = pop.querySelector("button[data-idx]");
  assert.ok(row && row.textContent.includes("태연"), "둘째 검색");
  fire(win, row, "click");
  assert.equal(doc.querySelector('input[name="artist"]').value, "아이유, 태연", "제출 = 콤마 목록(서버 계약)");
  assert.equal(cid.value, "", "다중이면 명시 id 비움(서버가 이름별 해석)");
  assert.equal(doc.querySelector('input[name="artist_company"]').value, "이담", "이미 채워진 소속사는 유지(첫 아티스트 우선)");
});
// ── personCombo(multi) = Gmail식 칩(2026-07-10 사용자 요청) ──
// 선택하면 한 덩어리 배지(칩)로 담기고, ✕/백스페이스로 통째 삭제. 제출은 칩 hidden(id·순수 본명) 쌍.
const PC_DUP_OPTS = [
  { id: 21, name: "엄유미", honorific: "실장님", email: "yumi@wyjs.kr", company: "(주)월간윤종신" },
  { id: 22, name: "윤종신", alt: "윤종신", company: "(주)월간윤종신" },
];
function mountChips(selected = []) {
  const html = `<form>${personCombo({ options: PC_DUP_OPTS, companyOptions: [], multi: true, selected })}</form>`;
  const m = mountDom(html);
  return { ...m, input: m.doc.querySelector("[data-pc-input]"), pop: m.doc.querySelector("[data-pc-pop]"), box: m.doc.querySelector("[data-pc-chips]") };
}
const chipNames = (doc) => [...doc.querySelectorAll("[data-pc-chip]")].map((c) => c.querySelector("span").textContent);
const chipPairs = (doc) => [...doc.querySelectorAll("[data-pc-chip]")].map((c) => [c.querySelector("[data-pc-chip-id]").value, c.querySelector("[data-pc-chip-name]").value]);

test("personCombo(multi): 선택하면 칩으로 담기고 제출값은 id+순수 본명 쌍(라벨 아님)", () => {
  const { win, doc, input, pop } = mountChips();
  input.value = "엄유미"; fire(win, input, "input");
  fire(win, pop.querySelector("button[data-idx]"), "click");
  assert.deepEqual(chipNames(doc), ["엄유미 실장님"], "칩 라벨엔 호칭 병기");
  assert.deepEqual(chipPairs(doc), [["21", "엄유미"]], "제출은 id + 순수 본명(라벨 텍스트 아님)");
  assert.equal(input.value, "", "검색칸은 비워짐");
});

test("personCombo(multi): 칩 ✕ 클릭 = 한 덩어리 삭제(텍스트 단위 아님)", () => {
  const { win, doc, input, pop } = mountChips();
  input.value = "엄유미"; fire(win, input, "input");
  fire(win, pop.querySelector("button[data-idx]"), "click");
  input.value = "윤종"; fire(win, input, "input");
  fire(win, pop.querySelector("button[data-idx]"), "click");
  assert.equal(chipNames(doc).length, 2, "두 명 담김");
  fire(win, doc.querySelector("[data-pc-chip] [data-pc-chip-remove]"), "click");
  assert.deepEqual(chipNames(doc), ["윤종신"], "첫 칩만 통째로 제거");
});

test("personCombo(multi): 빈 입력에서 백스페이스 = 마지막 칩 삭제, 글자 있으면 평범한 삭제", () => {
  const { win, doc, input } = mountChips(PC_DUP_OPTS);
  assert.equal(chipNames(doc).length, 2, "서버 렌더 칩 프리필");
  input.value = "아무거나";
  fire(win, input, "keydown", { key: "Backspace" });
  assert.equal(chipNames(doc).length, 2, "입력에 글자가 있으면 칩 안 지움");
  input.value = "";
  fire(win, input, "keydown", { key: "Backspace" });
  assert.deepEqual(chipNames(doc), ["엄유미 실장님"], "마지막 칩 삭제");
});

test("personCombo(multi): 이미 담긴 사람은 후보에서 제외(회사명 매칭으로 재등장 금지)", () => {
  // 옛 버그: 검색이 회사명도 매칭해 '윤종신'을 치면 회사가 '(주)월간윤종신'인 엄유미까지 후보로 떴고,
  // 그걸 고르면 마지막 조각(윤종신)이 엄유미로 교체됐다.
  const { win, doc, input, pop } = mountChips([PC_DUP_OPTS[0]]);
  input.value = "윤종신"; fire(win, input, "input");
  const labels = [...pop.querySelectorAll("button[data-idx]")].map((b) => b.textContent);
  assert.ok(!labels.some((l) => l.includes("엄유미")), `이미 담긴 엄유미는 후보에 없어야 함 — ${JSON.stringify(labels)}`);
  assert.ok(labels.some((l) => l.includes("윤종신")), "검색 대상은 후보에 있어야 함");
  assert.deepEqual(chipNames(doc), ["엄유미 실장님"], "기존 칩 그대로");
});

test("personCombo(multi): 칩 추가·삭제가 dirty 감시에 change로 통지됨(함정 #23)", () => {
  const { win, doc, input, pop } = mountChips();
  const form = doc.querySelector("form");
  let changes = 0;
  form.addEventListener("change", () => changes++);
  input.value = "엄유미"; fire(win, input, "input");
  fire(win, pop.querySelector("button[data-idx]"), "click");
  assert.ok(changes >= 1, "칩 추가 → change");
  const before = changes;
  fire(win, doc.querySelector("[data-pc-chip-remove]"), "click");
  assert.ok(changes > before, "칩 삭제 → change");
});

test("personCombo(multi): 드롭다운 행은 Gmail식 2줄(이름·호칭 / 이메일·소속)", () => {
  const { win, input, pop } = mountChips();
  input.value = "엄유미"; fire(win, input, "input");
  const row = pop.querySelector("button[data-idx]");
  const lines = [...row.querySelectorAll("span")].map((x) => x.textContent.trim());
  assert.ok(row.textContent.includes("실장님"), "호칭 표시");
  assert.ok(lines.some((l) => l.includes("yumi@wyjs.kr") && l.includes("(주)월간윤종신")), `2번째 줄=이메일·소속 — ${JSON.stringify(lines)}`);
});

// ── 검색 후보 랭킹(2026-07-10 사용자 리포트 '윤종신을 검색했는데 다른 이름이 더 우선 추천된다') ──
// 필터만 하고 정렬이 없어, 옵션이 이름 가나다순이라 회사명('(주)월간윤종신')으로 매칭된 엄유미가
// 정작 이름이 일치하는 윤종신보다 앞에 떴다. 엔터(첫 항목 선택)로 엉뚱한 사람이 담기는 문제.
// 행의 '이름 줄'(첫 span)만 본다 — 부제(이메일·소속)에 검색어가 섞여 오탐하지 않게.
const rowNames = (pop) => [...pop.querySelectorAll("button[data-idx]")].map((b) => b.querySelector("span").textContent.trim());

test("personCombo: 이름 일치가 회사명 일치보다 먼저 추천됨", () => {
  const { win, input, pop } = mountChips(); // 옵션 순서: 엄유미(회사=(주)월간윤종신) → 윤종신
  input.value = "윤종신"; fire(win, input, "input");
  const names = rowNames(pop);
  assert.equal(names[0], "윤종신", `첫 후보=이름 일치 — 실제: ${JSON.stringify(names)}`); // 활동명=본명이라 괄호 병기 없음
  assert.ok(names.some((n) => n.startsWith("엄유미")), "회사명 매칭도 후보엔 남음(뒤로)");
});

test("personCombo: 이름 앞부분 일치가 중간 포함보다 먼저", () => {
  // 서버 contactOptions는 name 가나다순 → 김종신이 종신철보다 앞에 온다(정렬 없으면 그대로 노출).
  const OPTS = [
    { id: 31, name: "김종신" },   // 중간 포함
    { id: 32, name: "종신철" },   // 앞부분 일치
  ];
  const html = `<form>${personCombo({ options: OPTS, companyOptions: [], multi: true })}</form>`;
  const { win, doc } = mountDom(html);
  const input = doc.querySelector("[data-pc-input]");
  const pop = doc.querySelector("[data-pc-pop]");
  input.value = "종신"; fire(win, input, "input");
  const names = rowNames(pop);
  assert.equal(names[0], "종신철", `앞부분 일치 우선 — 실제: ${JSON.stringify(names)}`);
});

test("personCombo: 이름 정확 일치가 앞부분 일치보다 먼저", () => {
  const OPTS = [{ id: 41, name: "종신철" }, { id: 42, name: "종신" }];
  const html = `<form>${personCombo({ options: OPTS, companyOptions: [], multi: true })}</form>`;
  const { win, doc } = mountDom(html);
  const input = doc.querySelector("[data-pc-input]");
  const pop = doc.querySelector("[data-pc-pop]");
  input.value = "종신"; fire(win, input, "input");
  assert.equal(rowNames(pop)[0], "종신", "정확 일치 최우선");
});

// ── 콤보 후보 정렬 공통화(2026-07-10) ─────────────────────────────────────────
// personCombo에서 고친 '필터만 하고 정렬 없음'이 청구처·제작/운영·아티스트 콤보에도 남아 있었다.
// 옵션 배열 순서가 그대로 노출돼, 이름이 정확히 일치하는 항목이 부분 일치 항목에 밀린다.
// 첫 항목이 하이라이트되므로 엔터를 치면 엉뚱한 대상이 선택된다(청구처는 금전 직결).
const { payerCombo } = require("../src/views");
const { artistCombo } = require("../src/views.projects");
const firstRows = (pop, sel = "button") => [...pop.querySelectorAll(sel)].map((b) => (b.querySelector("span") || b).textContent.trim());

test("청구처 콤보: 이름 정확 일치가 부분 일치 회사보다 먼저", () => {
  const clientOptions = [{ id: 1, name: "엄유미기획", kind: "company" }];      // 부분 일치(앞 순서)
  const contactOptions = [{ id: 2, name: "엄유미", current_client: "다른회사" }]; // 정확 일치
  const { win, doc } = mountDom(`<form>${payerCombo({ clientOptions, contactOptions })}</form>`);
  const input = doc.querySelector("[data-pk-input]");
  const pop = doc.querySelector("[data-pk-pop]");
  input.value = "엄유미"; fire(win, input, "input");
  assert.equal(firstRows(pop)[0], "엄유미", `정확 일치가 첫 후보 — 실제: ${JSON.stringify(firstRows(pop))}`);
});

test("companyCombo(제작/운영): 이름 정확 일치가 부분 일치보다 먼저", () => {
  createCompany({ name: "ㄱ달빛" });  // 부분 일치인데 가나다순 앞 → 정렬 없으면 먼저
  createCompany({ name: "달빛" });    // 정확 일치
  const { win, doc } = mountDom(`<form>${companyCombo("production_company", "", "제작사", "제작/운영")}</form>`);
  const input = doc.querySelector("[data-cc-input]");
  const pop = doc.querySelector("[data-cc-pop]");
  input.value = "달빛"; fire(win, input, "input");
  assert.equal(firstRows(pop)[0], "달빛", `정확 일치가 첫 후보 — 실제: ${JSON.stringify(firstRows(pop))}`);
});

test("아티스트 콤보: 이름 정확 일치가 부분 일치보다 먼저", () => {
  const { createPerson } = require("../src/data");
  createPerson({ name: "가루나", nickname: "가루나" }); // 부분 일치인데 가나다순으로 앞 → 정렬 없으면 먼저 노출
  createPerson({ name: "루나", nickname: "루나" });     // 정확 일치
  const { win, doc } = mountDom(`<form>${artistCombo({})}</form>`);
  const input = doc.querySelector("[data-artist-input]");
  const pop = doc.querySelector("[data-artist-pop]");
  input.value = "루나"; fire(win, input, "input");
  const rows = firstRows(pop, "button[data-idx]");
  assert.equal(rows[0], "루나", `정확 일치가 첫 후보 — 실제: ${JSON.stringify(rows)}`);
});

// ── 활동명이 본명과 같으면 괄호 병기 생략(2026-07-10) ──
// labelOf·서버 personName/personLabel엔 `a !== n` 조건이 있는데 드롭다운 행 렌더에만 없어서
// 활동명=본명인 사람이 '윤종신 (윤종신)'으로 겹쳐 보였다(선택된 값·칩은 정상).
test("personCombo 드롭다운: 활동명이 본명과 같으면 괄호를 붙이지 않음", () => {
  const OPTS = [
    { id: 51, name: "윤종신", alt: "윤종신" },          // 활동명 = 본명
    { id: 52, name: "박수한", alt: "워터멜론" },        // 활동명 ≠ 본명
  ];
  const html = `<form>${personCombo({ options: OPTS, companyOptions: [], multi: true })}</form>`;
  const { win, doc } = mountDom(html);
  const input = doc.querySelector("[data-pc-input]");
  const pop = doc.querySelector("[data-pc-pop]");
  input.value = "윤종신"; fire(win, input, "input");
  const row = pop.querySelector("button[data-idx] span").textContent.replace(/\s+/g, " ").trim();
  assert.equal(row, "윤종신", `중복 병기 금지 — 실제: "${row}"`);
  input.value = "박수한"; fire(win, input, "input");
  const row2 = pop.querySelector("button[data-idx] span").textContent.replace(/\s+/g, " ").trim();
  assert.equal(row2, "박수한 (워터멜론)", "다른 활동명은 병기 유지");
});

// ── 아티스트 콤보 = Gmail식 칩(2026-07-10, 콤마 텍스트 방식에서 전환) ──
// 담당자·디렉터·대표자와 입력 방식을 통일. **서버 계약은 불변**: hidden `artist`에 활동명 콤마 목록,
// 단일 선택일 때만 `artist_contact_id`(명시 id). 칩 라벨은 '활동명 (본명)' 병기.
function mountArtist(p = {}) {
  const m = mountDom(`<form>${artistCombo(p)}</form>`);
  return { ...m, input: m.doc.querySelector("[data-artist-input]"), pop: m.doc.querySelector("[data-artist-pop]"), box: m.doc.querySelector("[data-artist-chips]") };
}
const aChips = (doc) => [...doc.querySelectorAll("[data-artist-chip]")].map((c) => c.querySelector("span").textContent.trim());
const aHidden = (doc) => ({
  artist: doc.querySelector('input[name="artist"]').value,
  cid: doc.querySelector('input[name="artist_contact_id"]').value,
});

test("아티스트 콤보(칩): 선택하면 칩으로 담기고 hidden artist=활동명, cid=명시 id", () => {
  const { createPerson } = require("../src/data");
  const id = createPerson({ name: "이지은", nickname: "아이유" });
  const { win, doc, input, pop } = mountArtist();
  input.value = "아이유"; fire(win, input, "input");
  fire(win, pop.querySelector("button[data-idx]"), "click");
  assert.deepEqual(aChips(doc), ["아이유 (이지은)"], "칩 라벨=활동명 (본명)");
  assert.deepEqual(aHidden(doc), { artist: "아이유", cid: String(id) }, "제출=활동명 + 명시 id");
});

test("아티스트 콤보(칩): 두 명이면 artist=콤마 목록, cid는 비움(서버가 이름별 해석)", () => {
  const { createPerson } = require("../src/data");
  createPerson({ name: "김태연", nickname: "태연" });
  const { win, doc, input, pop } = mountArtist();
  input.value = "아이유"; fire(win, input, "input");
  fire(win, pop.querySelector("button[data-idx]"), "click");
  input.value = "태연"; fire(win, input, "input");
  fire(win, pop.querySelector("button[data-idx]"), "click");
  assert.equal(aChips(doc).length, 2);
  const h = aHidden(doc);
  assert.equal(h.artist, "아이유, 태연", "콤마 목록(서버 계약 유지)");
  assert.equal(h.cid, "", "다중이면 명시 id 비움");
});

test("아티스트 콤보(칩): ✕·백스페이스로 한 명씩 제거, hidden 동기화", () => {
  const { win, doc, input, pop } = mountArtist();
  input.value = "아이유"; fire(win, input, "input");
  fire(win, pop.querySelector("button[data-idx]"), "click");
  input.value = "태연"; fire(win, input, "input");
  fire(win, pop.querySelector("button[data-idx]"), "click");
  fire(win, doc.querySelector("[data-artist-chip] [data-artist-chip-remove]"), "click");
  assert.deepEqual(aChips(doc), ["태연 (김태연)"], "✕로 첫 칩 제거");
  input.value = "";
  fire(win, input, "keydown", { key: "Backspace" });
  assert.deepEqual(aChips(doc), [], "백스페이스로 마지막 칩 제거");
  assert.equal(aHidden(doc).artist, "", "hidden 비워짐");
});

test("아티스트 콤보(칩): 편집 진입 시 기존 artist TEXT가 칩으로 프리필", () => {
  const { win, doc } = mountArtist({ artist: "아이유, 태연" });
  assert.deepEqual(aChips(doc), ["아이유", "태연"], "콤마 목록 → 칩");
  assert.equal(aHidden(doc).artist, "아이유, 태연", "제출값 보존");
});

// ── 업체 생성 모달의 대표자도 공동대표(칩, 2026-07-10) ──
// 상세 폼은 칩인데 이 모달만 대표자 1명이라, 새 업체를 만들 때는 공동대표를 못 넣었다.
// 저장은 fetch(POST /clients)에 owner_id/owner_name 쌍을 칩 수만큼 실어 보낸다(서버 resolveOwnerIds가 인덱스 페어링).
test("업체 생성 모달: 대표자를 칩으로 여러 명 담고, 저장 시 owner 쌍을 모두 전송", async () => {
  createCompany({ name: "칩업체㈜" });
  const { createPerson } = require("../src/data");
  const a = createPerson({ name: "김대표" });
  const b = createPerson({ name: "박대표" });
  const html = `<form>${companyCombo("production_company", "", "제작사", "제작/운영")}</form>`;
  const { win, doc, fetchCalls } = mountDom(html, { fetchImpl: () => Promise.resolve({ ok: true, json: () => Promise.resolve({ ok: true, id: 99, name: "새업체" }) }) });

  // 새 업체 등록 모달 열기
  const input = doc.querySelector("[data-cc-input]");
  input.value = "새업체"; fire(win, input, "input");
  fire(win, doc.querySelector("[data-cc-pop] button[data-new]"), "click");

  // 대표자 칩 2개 담기
  const own = doc.querySelector("[data-cc-owner]");
  const ownPop = doc.querySelector("[data-cc-owner-pop]");
  own.value = "김대표"; fire(win, own, "input");
  fire(win, ownPop.querySelector("button[data-owneridx]"), "click"); // 대표자 미니콤보 행 마커
  own.value = "박대표"; fire(win, own, "input");
  fire(win, ownPop.querySelector("button[data-owneridx]"), "click");
  const chips = [...doc.querySelectorAll("[data-cc-owner-chip]")].map((c) => c.querySelector("span").textContent.trim());
  assert.deepEqual(chips, ["김대표", "박대표"], "대표자 칩 2개");

  // 저장 → fetch body에 owner 쌍 2개
  fire(win, doc.querySelector("[data-cc-save]"), "click");
  await tick();
  const call = fetchCalls.find((c) => String(c.url).includes("/clients"));
  assert.ok(call, "POST /clients 호출");
  const body = new URLSearchParams(call.init.body);
  assert.deepEqual(body.getAll("owner_name"), ["김대표", "박대표"], "이름 쌍 전송");
  assert.deepEqual(body.getAll("owner_id"), [String(a), String(b)], "id 쌍 전송(인덱스 페어링)");
});

// ── 새 아티스트 등록 모달: 유형(개인/그룹) 선택 + 소속 그룹(2026-07-14 사용자 리포트) ──
// 이전엔 '그룹(밴드·팀)' 체크박스뿐이라 "이 사람이 그룹 소속인가" vs "이 이름 자체가 그룹인가"가 불명확했다.
// 이제 유형을 먼저 고르고(라벨·필드가 그에 맞게 바뀜), 개인이면 '소속 그룹'을 그 자리에서 지정한다.
test("아티스트 모달: 유형=그룹이면 라벨이 '그룹명'이 되고 사람 항목(본명·소속 그룹·전화·이메일)이 숨는다", () => {
  const { win, doc, input, pop } = mountArtist();
  input.value = "세븐틴"; fire(win, input, "input");
  fire(win, pop.querySelector("button[data-new]"), "click"); // 새 아티스트 등록 → 모달
  const modal = doc.querySelector("[data-artist-modal]");
  assert.ok(!modal.classList.contains("hidden"), "모달 열림");
  const type = modal.querySelector("[data-am-type]");
  const label = modal.querySelector("[data-am-name-label]");
  const realWrap = modal.querySelector("[data-am-real-wrap]");
  const groupWrap = modal.querySelector("[data-am-group-wrap]");
  const personOnly = [...modal.querySelectorAll("[data-am-person-only]")];

  // 기본 = 개인 아티스트
  assert.equal(type.value, "artist");
  assert.equal(label.textContent, "활동명");
  assert.ok(!realWrap.classList.contains("hidden"), "개인: 본명 보임");
  assert.ok(!groupWrap.classList.contains("hidden"), "개인: 소속 그룹 보임");
  assert.ok(personOnly.every((el) => !el.classList.contains("hidden")), "개인: 전화·이메일 보임");

  // 그룹으로 전환
  type.value = "group"; fire(win, type, "change");
  assert.equal(label.textContent, "그룹명");
  assert.ok(realWrap.classList.contains("hidden"), "그룹: 본명 숨김");
  assert.ok(groupWrap.classList.contains("hidden"), "그룹: 소속 그룹 숨김(그룹이 그룹에 속하지 않음)");
  assert.ok(personOnly.every((el) => el.classList.contains("hidden")), "그룹: 전화·이메일 숨김");
});

test("아티스트 모달: 개인 등록 시 소속 그룹·소속사가 payload에 담긴다(group_id·agency_company)", async () => {
  const { createGroup, createCompany } = require("../src/data");
  const gid = createGroup({ name: "세븐틴" });
  createCompany({ name: "플레디스" });
  const { win, doc, input, pop } = mountArtist();
  let sent = null;
  win.fetch = (url, opt) => { sent = { url, body: String(opt.body) }; return Promise.resolve({ ok: true, json: () => Promise.resolve({ ok: true, id: 999, name: "예린", kind: "person" }) }); };

  input.value = "예린"; fire(win, input, "input");
  fire(win, pop.querySelector("button[data-new]"), "click");
  const modal = doc.querySelector("[data-artist-modal]");
  modal.querySelector("[data-am-name]").value = "예린";
  modal.querySelector("[data-am-real]").value = "김예린";
  // 소속 그룹 선택(미니 콤보)
  const gIn = modal.querySelector("[data-am-group-input]");
  gIn.value = "세븐틴"; fire(win, gIn, "input");
  fire(win, modal.querySelector("[data-am-group-pop] button[data-gridx]"), "click");
  assert.equal(modal.querySelector("[data-am-group-id]").value, String(gid), "그룹 id 확정");
  // 소속사 선택
  const aIn = modal.querySelector("[data-am-agency-input]");
  aIn.value = "플레디스"; fire(win, aIn, "input");
  fire(win, modal.querySelector("[data-am-agency-pop] button[data-agidx]"), "click");

  fire(win, modal.querySelector("[data-am-save]"), "click");
  await new Promise((r) => setTimeout(r, 0));
  assert.ok(sent, "등록 fetch 발사");
  const p = new URLSearchParams(sent.body);
  assert.equal(p.get("type"), "artist");
  assert.equal(p.get("name"), "예린");
  assert.equal(p.get("real_name"), "김예린");
  assert.equal(p.get("group_id"), String(gid), "소속 그룹 전달");
  assert.equal(p.get("agency_company"), "플레디스", "소속사는 이름으로 전달(서버가 재사용/생성)");
});

// ── 날짜 콤보(2026-07-14 사용자 요청 — 브라우저 기본 date 입력이 타이핑을 방해하던 것) ──
// 자유 타이핑 파싱 + 월 그리드 팝오버 + 키보드 이동. 값은 hidden(YYYY-MM-DD, 기존 로직·서버 계약 불변).
test("세션 폼: 날짜 콤보 — 자유 타이핑(317·12/31·3월 17일) → hidden YYYY-MM-DD", () => {
  const rateItems = db().prepare("SELECT * FROM rate_items").all();
  const html = `<form data-session-form>${sessionBookingFields({ session_date: "2026-03-05" }, [], rateItems, [], "")}</form>`;
  const { win, doc } = mountDom(html);
  const combo = doc.querySelector("[data-date-combo]");
  const inp = combo.querySelector("[data-date-input]");
  const hid = combo.querySelector("[data-date-hidden]");

  assert.equal(hid.getAttribute("name"), "session_date", "제출은 hidden(서버 계약 불변)");
  assert.equal(inp.getAttribute("name"), null, "보이는 입력엔 name 없음(함정 #19)");
  assert.equal(inp.value, "2026. 3. 5. (목)", "서버 렌더 표시 형식");

  const type = (text) => {
    inp.focus();
    inp.value = text;
    fire(win, inp, "input");
    const e = new win.KeyboardEvent("keydown", { key: "Enter", bubbles: true });
    inp.dispatchEvent(e);
  };
  type("317");
  assert.equal(hid.value, "2026-03-17", "317 → 3월 17일(연도는 현재 값 기준)");
  assert.equal(inp.value, "2026. 3. 17. (화)");
  type("12/31");
  assert.equal(hid.value, "2026-12-31");
  type("3월 17일");
  assert.equal(hid.value, "2026-03-17");
  type("2027-01-02");
  assert.equal(hid.value, "2027-01-02");
  // 파싱 불가(2월 31일)는 무시하고 원래 값 유지 — 잘못된 날짜가 조용히 저장되지 않게
  type("2월 31일");
  assert.equal(hid.value, "2027-01-02", "롤오버 날짜 거부");
});

test("세션 폼: 날짜 콤보 — 월 그리드 팝오버(클릭·‹ ›)와 키보드 이동(↓ +7일, Enter 확정)", () => {
  const rateItems = db().prepare("SELECT * FROM rate_items").all();
  const html = `<form data-session-form>${sessionBookingFields({ session_date: "2026-03-05" }, [], rateItems, [], "")}</form>`;
  const { win, doc } = mountDom(html);
  const combo = doc.querySelector("[data-date-combo]");
  const inp = combo.querySelector("[data-date-input]");
  const hid = combo.querySelector("[data-date-hidden]");
  const pop = combo.querySelector("[data-date-pop]");

  inp.focus();
  fire(win, inp, "focus");
  assert.ok(!pop.classList.contains("hidden"), "포커스에 팝오버 열림");
  assert.equal(pop.querySelectorAll("[data-dc-day]").length, 31, "3월 = 31일");

  pop.querySelector('[data-dc-day="2026-03-20"]').dispatchEvent(new win.MouseEvent("click", { bubbles: true }));
  assert.equal(hid.value, "2026-03-20", "날짜 클릭 = 선택");
  assert.ok(pop.classList.contains("hidden"), "선택 후 닫힘");

  inp.focus(); fire(win, inp, "focus");
  pop.querySelector("[data-dc-prev]").dispatchEvent(new win.MouseEvent("click", { bubbles: true }));
  assert.match(pop.textContent, /2026년 2월/, "‹ = 이전 달");

  // 키보드: ↓(+7일) → 칸에 미리보기 → Enter 확정(옛 텍스트를 다시 파싱하지 않아야 함)
  inp.focus(); fire(win, inp, "focus");
  inp.dispatchEvent(new win.KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
  assert.equal(inp.value, "2026. 3. 27. (금)", "↓ 이동이 칸에도 미리보기");
  inp.dispatchEvent(new win.KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
  assert.equal(hid.value, "2026-03-27", "Enter = 확정");
});

test("세션 폼: 날짜 콤보 — IME 조합 중 Enter는 무시(함정 #18)", () => {
  const rateItems = db().prepare("SELECT * FROM rate_items").all();
  const html = `<form data-session-form>${sessionBookingFields({ session_date: "2026-03-05" }, [], rateItems, [], "")}</form>`;
  const { win, doc } = mountDom(html);
  const inp = doc.querySelector("[data-date-combo] [data-date-input]");
  const hid = doc.querySelector("[data-date-combo] [data-date-hidden]");
  inp.focus();
  inp.value = "317";
  fire(win, inp, "input");
  inp.dispatchEvent(new win.KeyboardEvent("keydown", { key: "Enter", bubbles: true, isComposing: true }));
  assert.equal(hid.value, "2026-03-05", "조합 중 Enter는 확정하지 않음");
});

// ── 이중 제출 방지(2026-07-14 — 같은 업체가 3개로 늘어난 사고: 저장 버튼을 두 번 누르면 그대로 두 번 POST) ──
test("전 폼 공통: 두 번째 제출은 차단되고 저장 버튼이 잠긴다(새 탭 제출은 예외)", () => {
  const { win, doc } = mountDom(`
    <form id="f" action="/clients" method="post"><button type="submit" id="save">저장</button></form>
    <form id="g" action="/x" method="post"><button type="submit" formtarget="_blank" id="pdf">미리보기</button></form>`);
  const f = doc.getElementById("f");
  const save = doc.getElementById("save");

  const first = new win.Event("submit", { bubbles: true, cancelable: true });
  f.dispatchEvent(first);
  assert.equal(first.defaultPrevented, false, "첫 제출은 통과");

  const second = new win.Event("submit", { bubbles: true, cancelable: true });
  f.dispatchEvent(second);
  assert.equal(second.defaultPrevented, true, "두 번째 제출은 차단(중복 레코드 방지)");

  // 새 탭 제출(PDF 미리보기)은 현재 페이지가 안 바뀌므로 잠그지 않는다
  const g = doc.getElementById("g");
  const pdf1 = new win.Event("submit", { bubbles: true, cancelable: true });
  Object.defineProperty(pdf1, "submitter", { value: doc.getElementById("pdf") });
  g.dispatchEvent(pdf1);
  const pdf2 = new win.Event("submit", { bubbles: true, cancelable: true });
  Object.defineProperty(pdf2, "submitter", { value: doc.getElementById("pdf") });
  g.dispatchEvent(pdf2);
  assert.equal(pdf2.defaultPrevented, false, "새 탭 제출은 반복 가능");
  assert.equal(save.disabled, false, "버튼 잠금은 setTimeout(0) — 제출 payload에 name/value가 실린 뒤");
});

// ── 간이 등록 모달의 '저장 성공' 경로가 실제로 성공 처리되는지(2026-07-15 사용자 리포트 '등록 실패'가 뜸) ──
// 사고: 업체 모달의 성공 핸들러가 **삭제된 변수(ownerIdEl·owner)를 참조**해 ReferenceError → 아래 catch로 빠지며
// 서버는 정상 생성했는데 화면엔 '등록 실패'. 사용자가 다시 누를수록 같은 업체가 하나씩 더 생겼다(뮤직팜 3중 등록의 진짜 원인).
// 정적 검사로는 안 잡히는 클래스라, 모달 저장을 실제로 눌러 성공 처리(콤보 값 세팅·에러 숨김)를 확인한다.
test("업체 등록 모달: 저장 성공 시 콤보에 반영되고 '등록 실패'가 뜨지 않는다", async () => {
  const { companyCombo } = require("../src/views");
  const html = `<form>${companyCombo("production_company", "", "제작사", "제작/운영", { partyIdField: "production_party_id" })}</form>`;
  const calls = [];
  const { win, doc } = mountDom(html, {
    fetchImpl: (url, init) => {
      calls.push({ url, body: String(init && init.body) });
      return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ ok: true, id: 77, name: "(주)두오버엔터테인먼트", kind: "company" }) });
    },
  });

  const input = doc.querySelector("[data-cc-input]");
  input.value = "(주)두오버엔터테인먼트";
  fire(win, input, "input");
  const newBtn = doc.querySelector("[data-cc-pop] [data-new]");
  assert.ok(newBtn, "'＋ 새 업체 등록' 행");
  newBtn.dispatchEvent(new win.MouseEvent("click", { bubbles: true }));

  const modal = doc.querySelector("[data-cc-modal]");
  assert.ok(!modal.classList.contains("hidden"), "모달 열림");
  modal.querySelector("[data-cc-name]").value = "(주)두오버엔터테인먼트";
  modal.querySelector("[data-cc-biz]").value = "705-86-03260";
  modal.querySelector("[data-cc-prod]").checked = true;
  modal.querySelector("[data-cc-save]").dispatchEvent(new win.MouseEvent("click", { bubbles: true }));
  await tick();
  await tick();

  const err = modal.querySelector("[data-cc-err]");
  assert.ok(err.classList.contains("hidden"), "'등록 실패'가 뜨면 안 됨(성공 경로가 예외로 빠지던 회귀)");
  assert.equal(calls.length, 1, "POST /clients 1회");
  assert.match(calls[0].body, /type=company/);
  assert.equal(doc.querySelector("[data-cc-hidden]").value, "(주)두오버엔터테인먼트", "콤보 hidden에 회사명");
  assert.equal(doc.querySelector('input[name="production_party_id"]').value, "77", "party id 세팅");
  assert.ok(modal.classList.contains("hidden"), "모달 닫힘");
});

// ── 청구 목록 한 줄 행: 상태 pill 클릭이 행 펼침을 건드리지 않는다(2026-07-15) ──
// <summary> 안의 버튼은 클릭하면 펼침이 함께 일어나는 게 기본 동작. app.js가 기본 동작을 막고 폼만 직접 제출한다.
test("청구 목록 행: 상태 pill 클릭 = 폼 제출만(행은 안 펼쳐짐), 행 여백 클릭 = 펼침", () => {
  const { invoiceRow } = require("../src/views.invoices");
  const inv = {
    id: 7, title: "청구", invoice_number: "OMG-1", issued_date: "2026-07-14",
    amount: 220000, paid_amount: 0, status: "발행", tax_status: "계산서 발행",
    client_name: "(주)도너츠컬처", payer_kind: "company",
    project_title: "진혁", project_production: "도너츠컬처", project_artist: "진혁",
  };
  const { win, doc } = mountDom(invoiceRow(inv, { isInvoicer: true, ret: "/invoices?tab=done" }));
  const details = doc.querySelector("details.inv-row");
  const pill = doc.querySelector("[data-row-action] button");
  assert.ok(pill, "상태 pill");

  let submitted = null;
  const form = pill.closest("form");
  form.addEventListener("submit", (e) => { e.preventDefault(); submitted = form.getAttribute("action"); });
  form.requestSubmit = form.requestSubmit || function (b) { this.dispatchEvent(new win.Event("submit", { bubbles: true, cancelable: true })); }; // jsdom 미구현 폴백

  assert.equal(details.open, false, "처음엔 접힘");
  const click = new win.MouseEvent("click", { bubbles: true, cancelable: true });
  pill.dispatchEvent(click);
  assert.equal(details.open, false, "pill을 눌러도 행이 펼쳐지면 안 됨");
  assert.equal(click.defaultPrevented, true, "기본 동작(펼침·암묵 제출) 차단");
  assert.equal(submitted, "/invoices/7/tax-status", "폼은 직접 제출됨");
});

// ── 2026-07-15 전수 점검(4렌즈) 확정 결함 회귀 ──────────────────────────────

// [1] 날짜 콤보 blur 120ms 지연 커밋 ↔ 폼 제출 경합: 타이핑 직후 저장을 누르면 옛 hidden 값으로 POST되던 것.
// 제출 직전(capture) 동기 flush + required 빈 값 차단(hidden required는 브라우저가 검증하지 않음).
test("날짜 콤보: 제출 직전 타이핑 값 동기 flush + required 빈 값 차단", () => {
  const { dateCombo } = require("../src/views");
  const html = `<form>${dateCombo("session_date", "2026-03-05", { label: "날짜", required: true })}<button type="submit">저장</button></form>`;
  const { win, doc } = mountDom(html);
  const form = doc.querySelector("form");
  const inp = doc.querySelector("[data-date-input]");
  const hid = doc.querySelector("[data-date-hidden]");

  // 타이핑만 하고(blur 타이머 안 돎) 곧장 제출 → flush가 hidden을 갱신해야 한다
  inp.focus();
  inp.value = "0805";
  fire(win, inp, "input");
  const e1 = new win.Event("submit", { bubbles: true, cancelable: true });
  form.dispatchEvent(e1);
  assert.equal(hid.value, "2026-08-05", "제출 직전 flush로 타이핑 값 반영(경합 제거)");
  assert.equal(e1.defaultPrevented, false, "값 있으면 제출 통과");

  // 비우고 제출 → required 차단
  inp.value = "";
  fire(win, inp, "input");
  const e2 = new win.Event("submit", { bubbles: true, cancelable: true });
  form.dispatchEvent(e2);
  assert.equal(e2.defaultPrevented, true, "required 빈 값이면 제출 차단(옛 native 검증 복원)");
});

// [2] commit 무변경 change 억제: 작성일(data-autosubmit) 칸을 포커스만 갔다 떼도 POST+리로드되던 것.
test("날짜 콤보: 값이 안 바뀐 blur 커밋은 change를 쏘지 않는다(autosubmit 오발 방지)", async () => {
  const { dateCombo } = require("../src/views");
  const html = `<form>${dateCombo("created_at", "2026-07-01", { label: "작성일", marker: "data-autosubmit" })}</form>`;
  const { win, doc } = mountDom(html);
  const inp = doc.querySelector("[data-date-input]");
  const hid = doc.querySelector("[data-date-hidden]");
  let changes = 0;
  hid.addEventListener("change", () => changes++);

  // 포커스 → 아무 것도 안 바꾸고 Enter(=commit 같은 값)
  inp.focus();
  inp.dispatchEvent(new win.KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
  assert.equal(changes, 0, "무변경 커밋은 change 없음");
  assert.equal(hid.value, "2026-07-01");

  // 실제로 바꾸면 change 발화
  inp.focus(); inp.value = "0715"; fire(win, inp, "input");
  inp.dispatchEvent(new win.KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
  assert.equal(changes, 1, "변경 커밋만 change");
  assert.equal(hid.value, "2026-07-15");
});

// [3] data-confirm 취소 ↔ 이중 제출 가드: 확인창에서 '취소'해도 폼이 8초 잠기고 버튼이 비활성화되던 것.
test("이중 제출 가드: 뒤 리스너(data-confirm 취소)가 제출을 막으면 잠그지 않는다", async () => {
  const { win, doc } = mountDom(`<form id="f" data-confirm="지울까요?" action="/x" method="post"><button type="submit" id="b">삭제</button></form>`);
  win.confirm = () => false; // 취소
  const form = doc.getElementById("f");
  const btn = doc.getElementById("b");
  const e = new win.Event("submit", { bubbles: true, cancelable: true });
  form.dispatchEvent(e);
  assert.equal(e.defaultPrevented, true, "confirm 취소 = 제출 차단");
  await tick(); // 가드의 setTimeout(0) 이후
  assert.equal(btn.disabled, false, "취소했으면 버튼이 잠기지 않는다");
  // 바로 다시 제출(승인) 가능해야 한다
  win.confirm = () => true;
  const e2 = new win.Event("submit", { bubbles: true, cancelable: true });
  form.dispatchEvent(e2);
  assert.equal(e2.defaultPrevented, false, "재시도 제출 통과(8초 잠김 없음)");
});

// [4] 청구처 추천 칩 폴백(콤보 옵션에 없는 당사자): fireInput의 '정확 일치 아니면 비움' 동기화가
// 방금 세팅한 id를 되지워 분기가 자기 파괴로 죽어 있던 것.
test("청구처 추천 칩: 콤보 옵션에 없는 당사자도 id가 유지된다(폴백 자기 파괴 회귀)", () => {
  const { payerCombo } = require("../src/views");
  const combo = payerCombo({ selectedId: null, clientOptions: [{ id: 5, name: "다른회사", kind: "company" }], contactOptions: [] });
  const chip = `<div class="mt-1.5"><button type="button" data-payer-suggest="77" data-payer-suggest-name="김감독">아티스트 김감독</button></div>`;
  const { win, doc } = mountDom(`<form>${combo}${chip}</form>`);
  doc.querySelector("[data-payer-suggest]").dispatchEvent(new win.MouseEvent("click", { bubbles: true }));
  assert.equal(doc.querySelector("[data-pk-cid]").value, "77", "옵션 밖 당사자 id 유지");
  assert.equal(doc.querySelector("[data-pk-input]").value, "김감독", "이름 표시");
});

// [5] data-confirm: 이미 막힌 제출엔 확인창을 띄우지 않는다(2026-07-15 검증 워크플로 잠복 엣지).
// 날짜 콤보 required 빈 값 등이 먼저 preventDefault한 폼에 data-confirm까지 있으면, 진행 불가한 액션에 confirm이 떠서는 안 된다.
test("data-confirm: 이미 preventDefault된 제출엔 확인창 미표시", () => {
  const { win, doc } = mountDom(`<form data-confirm="지울까요?" action="/x" method="post"><button type="submit">삭제</button></form>`);
  let confirmCalls = 0;
  win.confirm = () => { confirmCalls++; return true; };
  const form = doc.querySelector("form");
  // 앞선 리스너가 먼저 막았다고 가정(다른 콤보 가드 흉내)
  form.addEventListener("submit", (e) => e.preventDefault(), true);
  form.dispatchEvent(new win.Event("submit", { bubbles: true, cancelable: true }));
  assert.equal(confirmCalls, 0, "이미 막힌 제출엔 confirm을 띄우지 않는다");

  // 막히지 않은 정상 폼은 여전히 확인창(회귀 아님)
  const { win: w2, doc: d2 } = mountDom(`<form data-confirm="지울까요?" action="/y" method="post"><button type="submit">삭제</button></form>`);
  let calls2 = 0;
  w2.confirm = () => { calls2++; return false; };
  const e2 = new w2.Event("submit", { bubbles: true, cancelable: true });
  d2.querySelector("form").dispatchEvent(e2);
  assert.equal(calls2, 1, "정상 폼은 확인창 표시");
  assert.equal(e2.defaultPrevented, true, "취소 시 제출 차단");
});

// ── 청구 생성 폼: 금액칸 Tab = 다음 금액칸으로(행 DOM 순서상 기본 Tab은 다음 행 체크박스로 가던 것) ──
test("청구 금액칸: Tab/Shift+Tab이 금액칸끼리 이동, 처음/마지막은 기본 동작·IME 무시", () => {
  const row = (n, amt) =>
    `<div data-line-row><input type="checkbox" name="task_id" value="${n}" data-line-amount="${amt}" checked /><button type="submit" data-waive-btn>청구 안 함</button><input type="text" name="task_amount_${n}" value="${amt}" data-line-input id="amt${n}" /></div>`;
  const html = `<form data-discount-form data-supply="0" action="/projects/1/invoices/from-tasks">
    ${row(1, 100)}${row(2, 200)}${row(3, 300)}
    <input name="discount_amount" value="0" data-discount-amount /><input name="discount_pct" data-discount-pct />
    <span data-amt-supply></span><span data-amt-discount-row hidden><span data-amt-discount></span></span><span data-amt-vat></span><span data-amt-total></span>
    <input type="checkbox" data-vat-toggle checked /></form>`;
  const { win, doc } = mountDom(html);
  const [a1, a2, a3] = [1, 2, 3].map((n) => doc.getElementById("amt" + n));

  a1.focus();
  let e = fire(win, a1, "keydown", { key: "Tab" });
  assert.equal(doc.activeElement, a2, "Tab: amt1 → amt2");
  assert.equal(e.defaultPrevented, true, "Tab: 기본 동작(다음 체크박스) 차단");

  a3.focus();
  e = fire(win, a3, "keydown", { key: "Tab" });
  assert.equal(e.defaultPrevented, false, "마지막 금액칸은 기본 Tab(할인으로) 유지");

  a2.focus();
  fire(win, a2, "keydown", { key: "Tab", shiftKey: true });
  assert.equal(doc.activeElement, a1, "Shift+Tab: amt2 → amt1");

  a1.focus();
  fire(win, a1, "keydown", { key: "Tab", isComposing: true });
  assert.equal(doc.activeElement, a1, "IME 조합 중 Tab 무시(함정 #18)");
});

// ── 전화 입력 자동 서식(휴대전화 양식): name="phone"·studio_tel·모달(data-pc/am-phone) 라이브 하이픈 ──
test("전화칸: 숫자 입력 시 휴대전화 양식 하이픈 자동(name=phone·studio_tel·모달), 비-전화 필드는 무변경", () => {
  const { win, doc } = mountDom(`<form>
    <input name="phone" id="p1" />
    <input name="studio_tel" id="p2" />
    <input data-pc-phone id="p3" />
    <input data-am-phone id="p4" />
    <input name="email" id="other" />
  </form>`);
  const type = (id, raw) => { const el = doc.getElementById(id); el.value = raw; fire(win, el, "input"); return el.value; };
  assert.equal(type("p1", "01012345678"), "010-1234-5678", "name=phone 모바일 11자리");
  assert.equal(type("p2", "0212345678"), "02-1234-5678", "studio_tel 02 지역번호");
  assert.equal(type("p3", "01055554444"), "010-5555-4444", "모달 data-pc-phone");
  assert.equal(type("p4", "01033332222"), "010-3333-2222", "모달 data-am-phone");
  assert.equal(type("p2", "15441234"), "1544-1234", "8자리 대표번호 → ####-#### (서버 formatPhone과 일치)");
  assert.equal(type("other", "01012345678"), "01012345678", "비-전화 필드(email)는 서식 안 함");
});

// ── 청구 생성 폼 임시저장(초안): 금액 제외 폼 필드(청구처·할인·발행일·VAT·제목) localStorage 저장/복원/삭제 ──
test("청구 초안: 폼 필드 localStorage 저장·복원·발행 시 삭제, 금액(즉시DB)은 초안 제외", () => {
  const project = { id: 7, title: "테스트 프로젝트" };
  const tasks = [{ id: 1, task_type: "vocal_tune", track_title: "곡A", status: "Completed", total_price: 100000, waived: 0 }];
  const formHtml = unbilledInvoiceForm(project, tasks, []);

  // 저장 + 금액 제외 + 발행 시 삭제
  const { win, doc } = mountDom(formHtml);
  const disc = doc.querySelector("[data-discount-amount]");
  disc.value = "10000"; fire(win, disc, "input");
  let draft = JSON.parse(win.localStorage.getItem("invdraft:7") || "null");
  assert.ok(draft && String(draft.da).replace(/\D/g, "") === "10000", "할인 변경 → 초안 저장");
  assert.equal(Object.keys(draft).sort().join(","), "d,da,dp,p,t,vat", "초안 키 = 금액 없는 폼 필드만(p·da·dp·vat·t·d)");
  const amt = doc.querySelector('[name="task_amount_1"]');
  amt.value = "55555"; fire(win, amt, "input");
  draft = JSON.parse(win.localStorage.getItem("invdraft:7") || "null");
  assert.ok(!JSON.stringify(draft).includes("55555"), "금액칸 변경은 초안에 안 들어감(금액=DB 진실원천)");
  doc.querySelector("[data-picker-combo]").__pkSet({ cid: "999", label: "테스트 청구처" }); // 청구처 세팅(미선택 제출 차단 방지)
  const ev = new win.Event("submit", { bubbles: true, cancelable: true });
  Object.defineProperty(ev, "submitter", { value: doc.querySelector("[data-invoice-submit]") });
  doc.querySelector("[data-discount-form]").dispatchEvent(ev);
  assert.equal(win.localStorage.getItem("invdraft:7"), null, "청구 생성(발행) 제출 시 초안 삭제");

  // 복원(로드 시) — localStorage 시드 후 app.js 실행. 발행일은 오늘·미래만 복원(먼 미래로 시간 취약성 회피).
  const seed = { p: { cid: "42", pid: "", label: "복원청구처" }, da: "20000", dp: "", vat: false, t: "복원 제목", d: "2099-08-15" };
  const r = mountDom(formHtml, { storage: { "invdraft:7": JSON.stringify(seed) } });
  assert.equal(String(r.doc.querySelector("[data-discount-amount]").value).replace(/\D/g, ""), "20000", "복원: 할인");
  assert.equal(r.doc.querySelector("[data-pk-cid]").value, "42", "복원: 청구처 cid");
  assert.equal(r.doc.querySelector('input[name="title"]').value, "복원 제목", "복원: 제목");
  assert.equal(r.doc.querySelector("[data-vat-toggle]").checked, false, "복원: VAT 해제 상태");
  assert.equal(r.doc.querySelector('[name="issued_date"]').value, "2099-08-15", "복원: 오늘·미래 발행일은 복원");
});

// 발행일 초안 staleness 가드: 며칠 전 만든 초안의 옛 발행일(이제 과거)은 복원하지 않는다(과거 일자 자동 발행 방지).
// 사용자 요청 '발행일 임시저장'은 오늘·미래 범위에서 유지(위 테스트). 전수 점검 2026-07-15.
test("청구 초안: 과거 발행일은 복원 안 함(서버 기본=오늘 유지), 미래는 복원", () => {
  const project = { id: 7, title: "테스트 프로젝트" };
  const tasks = [{ id: 1, task_type: "vocal_tune", track_title: "곡A", status: "Completed", total_price: 100000, waived: 0 }];
  const formHtml = unbilledInvoiceForm(project, tasks, []);
  const seed = { p: { cid: "42", pid: "", label: "x" }, da: "", dp: "", vat: true, t: "", d: "2000-01-01" };
  const r = mountDom(formHtml, { storage: { "invdraft:7": JSON.stringify(seed) } });
  assert.notEqual(r.doc.querySelector('[name="issued_date"]').value, "2000-01-01", "과거 발행일은 초안에서 복원하지 않음");
});

// ── 금액칸 포커스 시 전체선택(타이핑=새 금액). 단 이미 포커스된 칸 클릭(특정 숫자)·드래그 범위는 존중 ──
test("금액칸: 포커스 전체선택 — Tab·클릭포커스는 전체선택, 이미 포커스+클릭·드래그는 캐럿/범위 유지", () => {
  const { win, doc } = mountDom(`<form><input name="amount" id="a" value="100000" /></form>`);
  const a = doc.getElementById("a");
  assert.equal(a.value, "100,000", "초기 콤마 포맷");
  const selAll = () => a.selectionStart === 0 && a.selectionEnd === a.value.length;
  // (a) Tab 포커스 → 전체선택
  a.blur(); a.focus();
  assert.ok(selAll(), "Tab 포커스 → 전체선택");
  // (b) 이미 포커스된 칸을 클릭(특정 숫자) → 캐럿 유지
  a.setSelectionRange(3, 3);
  fire(win, a, "mousedown"); fire(win, a, "mouseup");
  assert.ok(a.selectionStart === 3 && a.selectionEnd === 3, "이미 포커스+클릭 → 캐럿 유지");
  // (c) 클릭 포커스(unfocused→클릭, 드래그 없음) → 전체선택
  a.blur();
  fire(win, a, "mousedown"); a.focus(); a.setSelectionRange(2, 2); fire(win, a, "mouseup");
  assert.ok(selAll(), "클릭 포커스(드래그 없음) → 전체선택");
  // (d) 드래그로 범위 선택 → 유지
  a.blur();
  fire(win, a, "mousedown"); a.focus(); a.setSelectionRange(1, 4); fire(win, a, "mouseup");
  assert.ok(a.selectionStart === 1 && a.selectionEnd === 4, "드래그 선택 → 범위 유지");
});

// ── 장소 자동완성: 제안 열린 채 Enter는 폼 제출(세션 추가)로 새지 않게 — 하이라이트 선택 or 목록만 닫음 ──
test("장소 콤보: 제안 열림+Enter=폼 제출 차단(하이라이트 선택/없으면 텍스트 유지·닫힘), 닫힘+Enter=정상", () => {
  const mount = () => {
    const { win, doc } = mountDom(`<form action="/x" method="post"><div data-place-suggest data-place-url="/sessions/place-suggest"><input data-place-input value="강남" /><div data-place-pop class="hidden"></div></div></form>`);
    const input = doc.querySelector("[data-place-input]");
    const pop = doc.querySelector("[data-place-pop]");
    pop.innerHTML = '<button type="button" data-place-val="서울 강남구 테헤란로 1">강남역</button><button type="button" data-place-val="서울 강남구 삼성로 2">삼성</button>';
    pop.classList.remove("hidden");
    return { win, input, pop };
  };
  // 제안 열림 + Enter(하이라이트 없음) → 제출 차단 + 목록 닫힘 + 타이핑 텍스트 유지(오선택 없음)
  let s = mount();
  let e = fire(s.win, s.input, "keydown", { key: "Enter" });
  assert.ok(e.defaultPrevented, "제안 열림+Enter → 폼 제출(세션 추가) 차단");
  assert.ok(s.pop.classList.contains("hidden"), "하이라이트 없음 → 목록 닫힘");
  assert.equal(s.input.value, "강남", "타이핑 텍스트 유지");
  // ArrowDown으로 하이라이트 후 Enter → 그 제안 선택
  s = mount();
  fire(s.win, s.input, "keydown", { key: "ArrowDown" });
  e = fire(s.win, s.input, "keydown", { key: "Enter" });
  assert.ok(e.defaultPrevented && s.input.value === "서울 강남구 테헤란로 1", "하이라이트+Enter → 제안 선택");
  // 제안 닫힘 + Enter → 기본동작 유지(폼 제출 정상)
  s = mount(); s.pop.classList.add("hidden");
  assert.ok(!fire(s.win, s.input, "keydown", { key: "Enter" }).defaultPrevented, "제안 닫힘+Enter → 기본동작 유지");
  // IME 조합 중 Enter 무시(함정 #18)
  s = mount();
  assert.ok(!fire(s.win, s.input, "keydown", { key: "Enter", isComposing: true }).defaultPrevented, "IME 조합 중 Enter 무시");
});

// ── 목록 실시간 필터: [data-live-filter] 검색 입력 타이핑 → [data-filter-list] 행을 즉시 필터(클라이언트 목록) ──
test("목록 실시간 필터: 타이핑하면 매칭 행만 남고, 매칭 0이면 '결과 없음'", () => {
  const html = searchBox({ action: "/clients", liveFilter: true, placeholder: "이름" })
    + listGroup({ filterList: true, rows: ["<div>김철수 · 010-1111</div>", "<div>이영희 · 010-2222</div>", "<div>박민수 · 010-3333</div>"] });
  const { win, doc } = mountDom(html);
  const input = doc.querySelector("[data-live-filter]");
  const rows = doc.querySelectorAll("[data-filter-list] > *");
  const empty = doc.querySelector("[data-filter-empty]");
  const type = (v) => { input.value = v; fire(win, input, "input"); };
  // 숨김은 인라인 style.display로 한다(행 class="flex"라 [hidden] 속성이 밀림). jsdom은 CSS 미적용이라 style로 검증.
  const vis = (r) => r.style.display !== "none";
  type("김");
  assert.ok(vis(rows[0]) && !vis(rows[1]) && !vis(rows[2]), "'김' → 김철수만 남음");
  assert.ok(empty.hidden, "매칭 있으면 '결과 없음' 숨김");
  type("2222");
  assert.ok(!vis(rows[0]) && vis(rows[1]) && !vis(rows[2]), "'2222' → 이영희만(전화 텍스트 매칭)");
  type("없는이름");
  assert.ok(!vis(rows[0]) && !vis(rows[1]) && !vis(rows[2]) && !empty.hidden, "매칭 0 → 전부 숨김 + '결과 없음'");
  type("");
  assert.ok(vis(rows[0]) && vis(rows[1]) && vis(rows[2]) && empty.hidden, "빈 검색 → 전부 표시");
});

// ── 청구 할인 정액칸: 미리 채운 '0' 없이 placeholder만(빈칸=0, 타이핑 시 바로 입력) ──
test("청구 할인 정액칸: value='0' 없이 placeholder만", () => {
  const html = unbilledInvoiceForm({ id: 7, title: "테스트" }, [{ id: 1, task_type: "vocal_tune", track_title: "곡A", status: "Completed", total_price: 100000, waived: 0 }], []);
  assert.match(html, /name="discount_amount" placeholder="0"/, "할인 정액=placeholder만");
  assert.doesNotMatch(html, /name="discount_amount" value="0"/, "미리 채운 value='0' 없음");
});
