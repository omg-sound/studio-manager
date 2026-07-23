"use strict";
const test = require("node:test");
const assert = require("node:assert");
const { equipmentList, equipmentForm } = require("../src/views.equipment");

test("equipmentList: 종류별 그룹 + 미분류, 검색박스", () => {
  const rows = [
    { id: 1, name: "SM7B", category: "마이크", location: "A룸", purchase_price: 500000, purchased_on: "2024-01-02" },
    { id: 2, name: "U87", category: "마이크", location: "B룸", purchase_price: null, purchased_on: null },
    { id: 3, name: "종류없음", category: null, location: null, purchase_price: null, purchased_on: null },
  ];
  const html = equipmentList(rows, { q: "" });
  assert.match(html, /마이크/, "종류 그룹 헤더");
  assert.match(html, /미분류/, "빈 종류 = 미분류 그룹");
  assert.match(html, /SM7B/);
  assert.match(html, /data-live-filter/, "실시간 검색 입력");
  assert.match(html, /data-filter-list/, "필터 대상 목록");
  assert.match(html, /장소 미지정/, "장소 빈 행 표기");
  assert.strictEqual((html.match(/data-filter-list/g) || []).length, 1, "필터 컨테이너는 하나(그룹마다 나누면 첫 그룹만 필터됨)");
  assert.match(html, /data-equip-group-head/, "종류 헤더 마커");
});

test("equipmentList: 빈 목록이면 emptyState", () => {
  const html = equipmentList([], { q: "" });
  assert.match(html, /장비가 없습니다|등록된 장비/, "빈 안내");
});

test("equipmentForm: 신규 폼 필드 존재(equipment_name·purchase_price 등), dirty 가드", () => {
  const html = equipmentForm(null, { rooms: [{ id: 1, name: "A룸" }], categories: ["마이크"], locations: ["A룸", "창고"] });
  assert.match(html, /name="equipment_name"/, "장비명은 bare name= 회피(가드레일 ①)");
  assert.doesNotMatch(html, /name="name"/, "bare name= 금지");
  assert.match(html, /name="purchase_price"/, "매입가 name = MONEY 정규식 매칭 키");
  assert.match(html, /name="category"/);
  assert.match(html, /name="serial_no"/);
  assert.match(html, /name="location"/);
  assert.match(html, /name="memo"/);
  assert.match(html, /purchased_on/, "구매일 날짜 콤보");
  assert.match(html, /data-dirty-form/, "dirty 저장 가드");
  assert.match(html, /창고/, "장소 제안(기존 값)");
  assert.match(html, /action="\/equipment"/, "신규 = POST /equipment");
});

test("equipmentForm: 편집 폼은 값 프리필 + 삭제 폼(형제, 중첩 아님) + POST /equipment/:id", () => {
  const item = { id: 7, name: "1176", category: "아웃보드", serial_no: "S1", purchase_price: 2000000, purchased_on: "2023-03-03", location: "랙실", memo: "" };
  const html = equipmentForm(item, { rooms: [], categories: ["아웃보드"], locations: ["랙실"] });
  assert.match(html, /value="1176"/);
  assert.match(html, /action="\/equipment\/7"/, "편집 = POST /equipment/:id");
  // 삭제 폼은 수정 폼과 형제(HTML은 <form> 중첩 금지 — 중첩하면 브라우저가 안쪽 폼을 버려
  // 삭제 클릭이 바깥 수정 폼으로 샌다). 편집 폼의 </form> 뒤에 별도 <form id=equip-del-7>이 온다.
  const editFormEnd = html.indexOf("</form>");
  const delFormStart = html.indexOf('<form id="equip-del-7"');
  assert.ok(editFormEnd >= 0 && delFormStart > editFormEnd, "삭제 폼은 편집 폼의 </form> 뒤에(형제)");
  assert.match(html, /<form id="equip-del-7" method="post" action="\/equipment\/7\/delete"/, "삭제 폼 action");
  assert.match(html, /data-confirm="[^"]*삭제[^"]*"/, "삭제 확인 다이얼로그");
  assert.match(html, /form="equip-del-7"/, "삭제 버튼이 form= 속성으로 삭제 폼을 가리킴");
});
