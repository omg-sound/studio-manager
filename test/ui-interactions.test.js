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
const { personCombo, companyCombo } = require("../src/views");
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
      <div class="relative">
        <input class="input" type="text" name="artist" value="" data-artist-input autocomplete="off" role="combobox" />
        <span class="hidden" data-artist-realname>(<span data-artist-realname-val></span>)</span>
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
test("artistCombo: 단일 선택은 기존 동작(교체·cid·소속사 채움) 유지", () => {
  const { win, doc, input, pop, cid } = mountArtistCombo(ARTIST_OPTS);
  input.value = "아이"; fire(win, input, "input");
  fire(win, pop.querySelector("button[data-idx]"), "click");
  assert.equal(input.value, "아이유", "단일 = 교체");
  assert.equal(cid.value, "31", "단일 = 명시 id");
  assert.equal(doc.querySelector('input[name="artist_company"]').value, "이담", "소속사 자동 채움");
});
test("artistCombo: 콤마 뒤 조각으로 검색·선택 이어붙임 + cid 비움 + 소속사 유지", () => {
  const { win, doc, input, pop, cid } = mountArtistCombo(ARTIST_OPTS);
  // 첫 아티스트 선택(소속사 '이담' 채워짐)
  input.value = "아이"; fire(win, input, "input");
  fire(win, pop.querySelector("button[data-idx]"), "click");
  // 콤마 찍고 둘째 검색 — 마지막 조각(태)으로만 검색
  input.value = "아이유, 태"; fire(win, input, "input");
  const row = pop.querySelector("button[data-idx]");
  assert.ok(row && row.textContent.includes("태연"), "마지막 조각으로 둘째 검색");
  fire(win, row, "click");
  assert.equal(input.value, "아이유, 태연", "선택은 이어붙임(교체 아님)");
  assert.equal(cid.value, "", "다중이면 명시 id 비움(서버가 이름별 해석)");
  assert.equal(doc.querySelector('input[name="artist_company"]').value, "이담", "이미 채워진 소속사는 유지(첫 아티스트 우선)");
  // 새등록 행 라벨도 조각 기준
  input.value = "아이유, 태연, 신인"; fire(win, input, "input");
  const nw = pop.querySelector("button[data-new]");
  assert.ok(nw && nw.textContent.includes("'신인'"), "새 아티스트 라벨 = 마지막 조각");
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
