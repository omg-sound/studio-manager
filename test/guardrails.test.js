"use strict";

// ── 격리 DB 셋업(다른 테스트와 동일 패턴) ──
process.env.NODE_ENV = "test";
const { tempDbPath, cleanupDb } = require("./helpers");
process.env.DB_PATH = tempDbPath();

const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");

/**
 * 가드레일 — **반복 실수 클래스를 기계 검사로 승격**한 테스트(2026-07-04, 사용자 요청 '아예 무결하게').
 * 정책: 같은 실수가 두 번 나오면 여기에 스캔/행동 검사를 추가한다(CLAUDE.md 함정 목록의 실행형).
 * 각 검사 주석에 실제 사고 이력을 남겨 왜 존재하는지 알 수 있게 한다.
 */

const ROOT = path.join(__dirname, "..");
const SRC = path.join(ROOT, "src");

/** src/**\/*.js 전체(재귀) + 경로 상대화. */
function srcFiles() {
  return fs
    .readdirSync(SRC, { recursive: true })
    .filter((f) => String(f).endsWith(".js"))
    .map((f) => path.join("src", String(f)));
}
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), "utf8");

// ── ① Chrome 자동완성 카테고리 필드명 금지 ──
// 사고 이력: 단가 항목명 name="name"에 사람이름 자동완성(2026-07-04), 콤보 보이는 입력 name=contact_name/*_company(함정 #19).
// Chrome은 name/organization/address 카테고리로 매칭되는 필드에서 autocomplete="off"를 무시한다.
// → 보이는 <input>은 bare name="name|company|address" 금지(hidden 제출 필드는 허용 — 화면에 안 뜸).
test("guardrail: 보이는 input에 자동완성 카테고리 필드명(name·company·address) 금지", () => {
  const offenders = [];
  for (const f of srcFiles()) {
    const lines = read(f).split("\n");
    lines.forEach((line, i) => {
      for (const m of line.matchAll(/<input\b[^>]*/g)) {
        const tag = m[0];
        if (/name="(name|company|address)"/.test(tag) && !/type="hidden"/.test(tag)) {
          offenders.push(`${f}:${i + 1} ${tag.slice(0, 90)}`);
        }
      }
    });
  }
  assert.deepEqual(offenders, [], "개명하고(name→*_name 등) 핸들러에 폴백을 두세요:\n" + offenders.join("\n"));
});

// ── ② datalist 허용목록 ──
// 사고 이력: 콤보(personCombo·companyCombo)로 통일한 뒤에도 연락처 회사칸·업체 대표자칸이 datalist로 남아
// 검색/새 등록이 안 되던 구식 필드 잔존(2026-07-04 ×2). 신규 datalist는 의도 확인 후 여기에 등록.
test("guardrail: datalist는 허용목록만(신규 콤보는 personCombo/companyCombo 사용)", () => {
  const ALLOWED = ["contact-artist-clients"]; // 연락처 '아티스트명' — 자기 활동명 free text + 제안(엔티티 선택기 아님, 의도적 유지)
  const offenders = [];
  for (const f of srcFiles()) {
    const lines = read(f).split("\n");
    lines.forEach((line, i) => {
      const m = line.match(/list="([^"$]+)"/); // 템플릿 변수(list="${…}")는 제외
      if (m && !ALLOWED.includes(m[1]) && !/role="listbox"/.test(line)) offenders.push(`${f}:${i + 1} list="${m[1]}"`);
    });
  }
  assert.deepEqual(offenders, [], offenders.join("\n"));
});

// ── ③ 대관 세션 종류 하드코딩 금지 ──
// 사고 이력: '녹음' 단독 비교/IN이 SQL·뷰에 흩어져 촬영·공연 추가 때마다 누락 위험(2026-07-04 일반화).
// RENTAL_SESSION_TYPES / RENTAL_IN(config 파생)만 사용.
test("guardrail: '녹음' 하드코딩 비교/IN 금지(config RENTAL_SESSION_TYPES로)", () => {
  const patterns = [/IN \('녹음'/, /= '녹음'/, /=== ?["']녹음["']/, /!== ?["']녹음["']/, /== ?["']녹음["']/];
  const offenders = [];
  for (const f of srcFiles()) {
    if (f.endsWith("config.js")) continue; // 단일 진실원천
    const lines = read(f).split("\n");
    lines.forEach((line, i) => {
      if (patterns.some((p) => p.test(line))) offenders.push(`${f}:${i + 1} ${line.trim().slice(0, 90)}`);
    });
  }
  assert.deepEqual(offenders, [], offenders.join("\n"));
});

// ── ④ 에러코드: 메시지 맵에 있으면 구현(throw/return)도 있어야 ──
// 사고 이력: TASK_AMOUNT_REQUIRED가 안내 문구·문서에만 있고 어디서도 throw되지 않던 잠복 결함(2026-07-04 발견).
test("guardrail: 라우트 에러 메시지 맵의 코드는 전부 실제 구현이 있어야 한다", () => {
  const all = srcFiles().map((f) => ({ f, s: read(f) }));
  const mapCodes = new Set();
  for (const { s } of all) for (const m of s.matchAll(/\b([A-Z][A-Z0-9_]{4,}):\s*"/g)) mapCodes.add(m[1]);
  // 맵 항목(CODE: ") 자체를 제거한 본문에서 "CODE" 리터럴(throw·return·비교) 존재 여부 확인
  const stripped = all.map(({ s }) => s.replace(/\b[A-Z][A-Z0-9_]{4,}:\s*"[^"]*"/g, "")).join("\n");
  const missing = [...mapCodes].filter((c) => !stripped.includes(`"${c}"`));
  assert.deepEqual(missing, [], "메시지만 있고 구현이 없는 코드(가드를 실제로 심으세요): " + missing.join(", "));
});

// ── ⑤ AJAX 전송은 URLSearchParams(함정 #14) ──
// 사고 이력: fetch body에 FormData(multipart) → req.body가 비어 기본값 저장(작업 자동저장 무반영의 근본 원인).
test("guardrail: app.js fetch body에 FormData 금지(urlencoded만)", () => {
  const s = read(path.join("public", "js", "app.js"));
  assert.ok(!/body:\s*new FormData/.test(s), "fetch body는 URLSearchParams로 변환할 것(함정 #14)");
});

// ── ⑥ 행동: personCombo는 companyOptions 미전달이어도 모달 회사 검색이 산다 ──
// 사고 이력: 세션 디렉터·업체 대표자 콤보가 companyOptions 미전달로 모달 회사칸이 평문(×2 재발) → 기본값화(2026-07-04).
const { init, db } = require("../src/db");
init();
const { createCompany, createPerson, updateParty, getParty } = require("../src/data");
const { personCombo } = require("../src/views");

test("guardrail: personCombo 기본 companyOptions — 미전달 호출도 회사 옵션 임베드", () => {
  createCompany({ name: "가드레일상사", roles: "소속사/레이블" });
  const html = personCombo({ options: [] }); // companyOptions 미전달
  assert.ok(html.includes("data-pc-company-options"), "회사 옵션 스크립트 존재");
  assert.ok(html.includes("가드레일상사"), "실제 업체 목록이 기본 임베드");
});

// ── ⑦ 행동: updateParty 부분 갱신 계약(미전송=보존, 빈 문자열=비움) ──
// 사고 이력: Google 동기화 등 일부 필드만 보내는 호출부가 나머지를 지움(cash_receipt_no 실증, memo·전화도 동일 구조).
test("guardrail: updateParty — 미전송 필드 보존·빈 문자열 비움(사람)", () => {
  const id = createPerson({
    family_name: "가", given_name: "드레", honorific: "님", phone: "010-1234-5678", email: "g@x.kr",
    memo: "메모보존", department: "A&R", job_title: "팀장", cash_receipt_no: "010-1234-5678", nickname: "가드",
  });
  const before = getParty(id);
  updateParty(id, { name: before.name }); // 최소 업데이트(Google 동기화 시나리오)
  const after = getParty(id);
  for (const k of ["phone", "email", "memo", "family_name", "given_name", "honorific", "department", "job_title", "cash_receipt_no", "activity_name", "is_artist"]) {
    assert.equal(after[k], before[k], `${k} 보존`);
  }
  updateParty(id, { memo: "" }); // 빈 문자열 = 의도적 비움
  assert.equal(getParty(id).memo, null, "빈 문자열 전송은 비움");
  assert.equal(getParty(id).phone, before.phone, "다른 필드는 여전히 보존");
});

test("guardrail: updateParty — 미전송 필드 보존(업체: 사업자·대표자·주소·역할)", () => {
  const id = createCompany({ name: "보존상사", biz_no: "123-45-67890", owner_name: "김대표", address: "서울", roles: "제작사", phone: "02-123-4567" });
  const before = getParty(id);
  updateParty(id, { name: "보존상사" });
  const after = getParty(id);
  for (const k of ["biz_no", "owner_name", "owner_party_id", "address", "roles", "phone"]) {
    assert.equal(after[k], before[k], `${k} 보존`);
  }
});

test.after(() => cleanupDb(process.env.DB_PATH, db()));
