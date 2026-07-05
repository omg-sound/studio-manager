"use strict";

// ── 격리 DB 셋업(다른 테스트와 동일 패턴) ──
process.env.NODE_ENV = "test";
const { tempDbPath, cleanupDb } = require("./helpers");
process.env.DB_PATH = tempDbPath();

const test = require("node:test");
const assert = require("node:assert");

const { init, db } = require("../src/db");
const { sessionRateAmount } = require("../src/data");
const { RENTAL_SESSION_TYPES, SESSION_TYPES, RECORDING_CATEGORIES, FILMING_CATEGORIES, PERFORMANCE_CATEGORIES, rateCategoryKind, SESSION_TYPE_RATE_KIND } = require("../src/config");

init();

// 대관 세션(녹음·촬영) 판정 회귀 테스트 — 2026-07-04 촬영 추가.
// 세션 자체가 단가표 시간제 청구 대상인 종류가 RENTAL_SESSION_TYPES 하나로 일원화됐는지 보증.

const rateId = Number(
  db()
    .prepare(
      `INSERT INTO rate_items (name, category, base_minutes, base_price, extra_minutes, extra_price, active)
       VALUES ('테스트 촬영 단가', '스튜디오 촬영', 240, 400000, 60, 100000, 1)`
    )
    .run().lastInsertRowid
);

const baseSession = { rate_item_id: rateId, start_time: "10:00", end_time: "14:00" }; // 240분=1Pro

test("config: 대관 종류·kind 매핑 정합", () => {
  assert.deepEqual(RENTAL_SESSION_TYPES, ["녹음", "촬영", "공연"], "대관 매출 세션 = 녹음·촬영·공연");
  for (const t of RENTAL_SESSION_TYPES) assert.ok(SESSION_TYPES.includes(t), `${t}는 세션 종류에 존재`);
  // 대관 종류마다 단가 kind가 정의돼야 세션폼 옵션 스왑이 동작한다.
  for (const t of RENTAL_SESSION_TYPES) assert.ok(SESSION_TYPE_RATE_KIND[t], `${t}의 단가 kind 정의`);
  // 카테고리 → kind 분기: 녹음=recording·촬영=filming·공연=performance.
  for (const c of RECORDING_CATEGORIES) assert.equal(rateCategoryKind(c), "recording");
  for (const c of FILMING_CATEGORIES) assert.equal(rateCategoryKind(c), "filming");
  for (const c of PERFORMANCE_CATEGORIES) assert.equal(rateCategoryKind(c), "performance");
});

test("sessionRateAmount: 녹음·촬영은 산정, 그 외 종류는 null", () => {
  for (const t of RENTAL_SESSION_TYPES) {
    const b = sessionRateAmount({ ...baseSession, session_type: t });
    assert.ok(b, `${t} 세션은 청구 산정`);
    assert.equal(b.amount, 400000, `${t} 240분=1Pro 기본가`);
  }
  for (const t of SESSION_TYPES.filter((t) => !RENTAL_SESSION_TYPES.includes(t))) {
    assert.equal(sessionRateAmount({ ...baseSession, session_type: t }), null, `${t} 세션은 세션 청구 아님(후반작업 청구)`);
  }
});

test("정액(회당)·가격 미정 항목: 산정 0원이지만 청구 후보 유지(null 아님) — 청구 시 금액 입력", () => {
  const flatId = Number(
    db()
      .prepare(
        `INSERT INTO rate_items (name, category, base_minutes, base_price, extra_minutes, extra_price, active)
         VALUES ('플레이백(금액 미정)', '공연', 0, 0, 60, 0, 1)`
      )
      .run().lastInsertRowid
  );
  const b = sessionRateAmount({ session_type: "공연", rate_item_id: flatId, start_time: "18:00", end_time: "20:00" });
  assert.ok(b, "billing 객체 반환(후보 노출)");
  assert.equal(b.amount, 0, "산정액 0 = 금액 미정(발행은 TASK_AMOUNT_REQUIRED 가드)");
});

test("종일(all_day): 시간 없어도 대관 세션 청구 가능(1 기준 블록·정액=base_price)", () => {
  // 정액(회당) 항목 — base_minutes=0, base_price=500000.
  const flatId = Number(
    db()
      .prepare(`INSERT INTO rate_items (name, category, base_minutes, base_price, extra_minutes, extra_price, active) VALUES ('종일 정액', '공연', 0, 500000, 60, 0, 1)`)
      .run().lastInsertRowid
  );
  const b = sessionRateAmount({ session_type: "공연", rate_item_id: flatId, all_day: 1, start_time: null, end_time: null });
  assert.ok(b, "종일 세션도 billing 객체(청구 후보)");
  assert.equal(b.allDay, true, "allDay 플래그");
  assert.equal(b.amount, 500000, "정액 회당 = base_price(시간 무관)");
  // 시간제 항목(base_minutes=210)이면 종일 = 1Pro.
  const proId = Number(
    db()
      .prepare(`INSERT INTO rate_items (name, category, base_minutes, base_price, extra_minutes, extra_price, active) VALUES ('종일 시간제', '공연', 210, 300000, 60, 100000, 1)`)
      .run().lastInsertRowid
  );
  const b2 = sessionRateAmount({ session_type: "공연", rate_item_id: proId, all_day: 1, start_time: null, end_time: null });
  assert.equal(b2.amount, 300000, "시간제 항목 종일 = 1Pro base_price");
});

test("종일 다일(end_date): 종료>시작일 때만 저장·시간 NULL·시간세션은 무시(createSession 경로)", () => {
  const { createSession } = require("../src/data");
  const user = { role: "chief" };
  const projId = Number(db().prepare("INSERT INTO projects (title, project_type, rate, created_at) VALUES ('다일종일', 'session', 0, datetime('now'))").run().lastInsertRowid);
  // 다일: 2/5~2/9 (시간값 동봉 — 종일이라 무시돼야)
  const multi = createSession(user, projId, { session_date: "2026-02-05", all_day: "1", end_date: "2026-02-09", start_time: "14:00", end_time: "18:00", session_type: "공연" });
  assert.equal(multi.all_day, 1);
  assert.equal(multi.end_date, "2026-02-09", "종료 날짜 저장");
  assert.equal(multi.start_time, null, "종일이라 시간 NULL");
  assert.equal(multi.end_time, null);
  // 단일일(종료=시작): end_date NULL
  const single = createSession(user, projId, { session_date: "2026-02-05", all_day: "1", end_date: "2026-02-05", session_type: "공연" });
  assert.equal(single.end_date, null, "종료=시작이면 단일일(NULL)");
  // 시간 세션은 end_date 무시
  const timed = createSession(user, projId, { session_date: "2026-02-10", end_date: "2026-02-14", start_time: "14:00", custom_hours: "2", duration_mode: "custom", session_type: "믹싱" });
  assert.equal(timed.all_day, 0);
  assert.equal(timed.end_date, null, "시간 세션은 end_date 미저장");
});

test("외부 장소: is_external 룸이면 주소(location) 저장, 스튜디오 룸이면 무시", () => {
  const { createSession } = require("../src/data");
  const user = { role: "chief" };
  const projId = Number(db().prepare("INSERT INTO projects (title, project_type, rate, created_at) VALUES ('장소테스트', 'session', 0, datetime('now'))").run().lastInsertRowid);
  const extRoom = Number(db().prepare("INSERT INTO rooms (name, sort_order, active, is_external) VALUES ('외부일정', 5, 1, 1)").run().lastInsertRowid);
  const studioRoom = Number(db().prepare("INSERT INTO rooms (name, sort_order, active, is_external) VALUES ('A룸', 6, 1, 0)").run().lastInsertRowid);
  // 외부 장소 + 주소 → 저장
  const ext = createSession(user, projId, { session_date: "2026-03-01", start_time: "14:00", custom_hours: "2", duration_mode: "custom", session_type: "믹싱", room_id: String(extRoom), location: "서울시 강남구 논현로 1" });
  assert.equal(ext.location, "서울시 강남구 논현로 1", "외부 장소는 주소 저장");
  // 스튜디오 룸 + 주소(오입력) → 무시(null)
  const studio = createSession(user, projId, { session_date: "2026-03-02", start_time: "14:00", custom_hours: "2", duration_mode: "custom", session_type: "믹싱", room_id: String(studioRoom), location: "무시될주소" });
  assert.equal(studio.location, null, "스튜디오 룸은 주소 무시(기본 장소 사용)");
});

test("sessionRateAmount: 단가 미선택·시간 없음은 null(결핍 사유 안내 대상)", () => {
  assert.equal(sessionRateAmount({ session_type: "촬영", rate_item_id: null, start_time: "10:00", end_time: "14:00" }), null);
  assert.equal(sessionRateAmount({ session_type: "촬영", rate_item_id: rateId, start_time: null, end_time: null }), null);
});

test.after(() => cleanupDb(process.env.DB_PATH));

// ── 디렉터 콤마 다중(2026-07-05): director_name 콤마 텍스트 → 이름별 해석(라벨 안전망·재사용·신규) ──
test("세션 디렉터: 콤마 텍스트(라벨 포함)를 이름별 해석 — 기존 재사용·신규 생성·dedup", () => {
  const D = require("../src/data");
  const CHIEF = { id: 1, role: "chief", email: "chief@omg.test" };
  const dirA = D.createPerson({ name: "표몽규", nickname: "몽규튠", honorific: "실장님" });
  const projId = Number(db().prepare("INSERT INTO projects (title, project_type, rate) VALUES ('디렉터콤마','session',0)").run().lastInsertRowid);
  const s = D.createSession(CHIEF, projId, {
    session_type: "믹싱", session_date: "2026-08-01", all_day: "1", status: "예정",
    director_contact_id: "", director_name: "표몽규 실장님 (몽규튠), 새디렉터갑, 표몽규", // 라벨 + 신규 + 중복(순수명)
  });
  const dirs = D.listSessionDirectors(s.id);
  assert.equal(dirs.length, 2, "라벨·순수명 중복은 1명으로(dedup) + 신규 1명");
  assert.ok(dirs.some((d) => d.id === dirA), "라벨 텍스트가 기존 사람으로 정확 해석(유령 생성 없음)");
  const newbie = dirs.find((d) => d.id !== dirA);
  assert.equal(newbie.name, "새디렉터갑", "새 이름만 생성");
  // 수정: 한 명만 남기기 → 통째 교체
  D.updateSession(CHIEF, s.id, { session_type: "믹싱", session_date: "2026-08-01", all_day: "1", status: "예정", director_contact_id: "", director_name: "표몽규 실장님 (몽규튠)" });
  assert.deepEqual(D.listSessionDirectors(s.id).map((d) => d.id), [dirA], "콤마 목록 수정 = 교체");
});
