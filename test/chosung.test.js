"use strict";
// 초성 인덱스(iCloud식 이름 그룹핑·레일) — 한글 음절/쌍자음 병합·호환자모·영문·기타.
const test = require("node:test");
const assert = require("node:assert");
const { chosungOf } = require("../src/lib/chosung");

test("chosungOf: 한글 음절 첫 자의 초성", () => {
  assert.equal(chosungOf("강기민"), "ㄱ");
  assert.equal(chosungOf("김보종"), "ㄱ");
  assert.equal(chosungOf("루나"), "ㄹ");
  assert.equal(chosungOf("하영"), "ㅎ");
  assert.equal(chosungOf("박수한 대표님"), "ㅂ"); // 호칭 병기 이름도 첫 자 기준
});

test("chosungOf: 쌍자음은 기본 자음으로 병합", () => {
  assert.equal(chosungOf("까치"), "ㄱ");
  assert.equal(chosungOf("따오기"), "ㄷ");
  assert.equal(chosungOf("빠름"), "ㅂ");
  assert.equal(chosungOf("싸이"), "ㅅ");
  assert.equal(chosungOf("짜장"), "ㅈ");
});

test("chosungOf: 호환 자모 단독(ㅌㅌㅌ)·영문·기타", () => {
  assert.equal(chosungOf("ㅌㅌㅌ"), "ㅌ");
  assert.equal(chosungOf("Various Artists"), "V");
  assert.equal(chosungOf("apple"), "A");
  assert.equal(chosungOf("365데이"), "#");
  assert.equal(chosungOf(""), "#");
  assert.equal(chosungOf(null), "#");
  assert.equal(chosungOf("  김"), "ㄱ"); // 앞 공백 trim
});
