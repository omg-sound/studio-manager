"use strict";

// 이름 첫 글자의 초성 인덱스(애플 iCloud 연락처식 그룹핑·인덱스 레일용).
// 한글 음절 → 초성(쌍자음은 기본 자음으로 병합: ㄲ→ㄱ). 호환 자모 단독(예 'ㅌㅌㅌ') → 그 자음.
// 영문 → 대문자 한 글자. 그 외(숫자·기호·공백) → '#'.

const CHO = ["ㄱ", "ㄲ", "ㄴ", "ㄷ", "ㄸ", "ㄹ", "ㅁ", "ㅂ", "ㅃ", "ㅅ", "ㅆ", "ㅇ", "ㅈ", "ㅉ", "ㅊ", "ㅋ", "ㅌ", "ㅍ", "ㅎ"];
const MERGE = { "ㄲ": "ㄱ", "ㄸ": "ㄷ", "ㅃ": "ㅂ", "ㅆ": "ㅅ", "ㅉ": "ㅈ" };
const COMPAT = "ㄱㄲㄴㄷㄸㄹㅁㅂㅃㅅㅆㅇㅈㅉㅊㅋㅌㅍㅎ"; // 호환 자모 단독 자음(U+3131~)

function chosungOf(name) {
  const s = String(name == null ? "" : name).trim();
  if (!s) return "#";
  const ch = s[0];
  const code = ch.charCodeAt(0);
  if (code >= 0xac00 && code <= 0xd7a3) {
    const cho = CHO[Math.floor((code - 0xac00) / 588)];
    return MERGE[cho] || cho;
  }
  if (COMPAT.indexOf(ch) >= 0) return MERGE[ch] || ch;
  if (/[a-z]/i.test(ch)) return ch.toUpperCase();
  return "#";
}

module.exports = { chosungOf };
