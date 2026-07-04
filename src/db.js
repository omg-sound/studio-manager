"use strict";

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { config, TASK_TYPES } = require("./config");
const { openDatabase } = require("./sqlite");
const { splitKoreanName } = require("./lib/korean-name");

let _db = null;

/** SQLite 핸들(싱글톤). WAL 모드 + FK 활성화. PRAGMA는 두 드라이버 공통으로 exec 사용. */
function db() {
  if (_db) return _db;
  fs.mkdirSync(path.dirname(config.dbPath), { recursive: true });
  const { driver, handle } = openDatabase(config.dbPath);
  _db = handle;
  try {
    _db.exec("PRAGMA journal_mode = WAL;");
    _db.exec("PRAGMA foreign_keys = ON;");
  } catch (e) {
    console.warn("[db] PRAGMA 설정 경고:", e.message);
  }
  if (!db._logged) {
    console.log(`[db] driver=${driver} path=${config.dbPath}`);
    db._logged = true;
  }
  return _db;
}

/**
 * 스키마 생성 + idempotent 마이그레이션(플레이북 §2.8).
 * - CREATE TABLE IF NOT EXISTS, 컬럼 추가는 ALTER를 try/catch로 멱등 처리.
 * - 상태/카테고리 enum은 DB CHECK로 박지 않는다(코드 상수가 단일 진실원천).
 */
function init() {
  const d = db();

  d.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      email         TEXT NOT NULL UNIQUE,
      role          TEXT NOT NULL DEFAULT 'staff',
      name          TEXT NOT NULL DEFAULT '',
      password_hash TEXT,
      google_sub    TEXT,
      created_at    TEXT NOT NULL DEFAULT (datetime('now'))
    );

    -- (레거시 clients/contacts/contact_affiliations 테이블은 당사자(parties) 모델로 이관 후 제거됨 — dropLegacyIdentity/legacy_drop_v1)

    CREATE TABLE IF NOT EXISTS projects (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      title      TEXT NOT NULL,
      artist     TEXT,
      artist_company TEXT,
      production_company TEXT,
      manager_id INTEGER REFERENCES project_managers(id) ON DELETE SET NULL,
      status     TEXT NOT NULL DEFAULT '녹음중',
      kind       TEXT NOT NULL DEFAULT '싱글',
      services   TEXT,                         -- JSON array: service items
      due_date   TEXT,                         -- latest completed_at, 'YYYY-MM-DD'
      rate       INTEGER NOT NULL DEFAULT 0,   -- 항목별 견적 합계(원)
      memo       TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS project_managers (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      name       TEXT NOT NULL,
      email      TEXT,
      phone      TEXT,
      active     INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS project_service_items (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      key        TEXT NOT NULL UNIQUE,
      label      TEXT NOT NULL,
      active     INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    -- 단가표(과금 항목). 1Pro 기준시간/기준가 + 초과 단위/단가. 세션 시간 → 자동 산정의 기준.
    CREATE TABLE IF NOT EXISTS rate_items (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      name          TEXT NOT NULL,                 -- 예: 보컬 녹음, 악기+보컬 녹음(그룹)
      base_minutes  INTEGER NOT NULL DEFAULT 0,    -- 기준 시간(분). 0이면 시간 무관 정액
      base_price    INTEGER NOT NULL DEFAULT 0,    -- 기준 가격(원)
      extra_minutes INTEGER NOT NULL DEFAULT 60,   -- 초과 단위(분)
      extra_price   INTEGER NOT NULL DEFAULT 0,    -- 초과 단위당 가격(원)
      active        INTEGER NOT NULL DEFAULT 1,
      created_at    TEXT NOT NULL DEFAULT (datetime('now'))
    );

    -- 작업 종류 카탈로그(곡·콘텐츠 후반작업 종류). config.TASK_TYPES를 1회 시드 후 DB가 단일 진실원천.
    -- track_tasks.task_type은 이 key를 문자열로 저장(FK 아님). CHECK 제약 없음(코드 상수가 분류·과금 정규화).
    CREATE TABLE IF NOT EXISTS task_types (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      key          TEXT NOT NULL UNIQUE,                       -- 안정 식별자(기존 Vocal_Recording… / 신규 tt_xxx)
      label        TEXT NOT NULL,                              -- 표시명(예: 보컬튠)
      task_group   TEXT NOT NULL DEFAULT 'Post_Production',    -- 분류(TASK_GROUPS 참조)
      billing_type TEXT NOT NULL DEFAULT 'Fixed_Per_Track',    -- 기본 과금(BILLING_TYPES)
      unit_price   INTEGER NOT NULL DEFAULT 0,                 -- 기본 단가(원)
      is_quick     INTEGER NOT NULL DEFAULT 0,                 -- 곡·콘텐츠 '빠른 추가' 버튼 노출
      sort_order   INTEGER NOT NULL DEFAULT 100,
      active       INTEGER NOT NULL DEFAULT 1,
      created_at   TEXT NOT NULL DEFAULT (datetime('now'))
    );

    -- 프로젝트 하위 트랙/콘텐츠. 한 프로젝트는 1..N개의 음악 트랙 또는 영상 콘텐츠를 가진다.
    CREATE TABLE IF NOT EXISTS project_tracks (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      project_id   INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      title        TEXT NOT NULL,
      content_type TEXT NOT NULL DEFAULT 'Music', -- Music | Video_Post
      created_at   TEXT NOT NULL DEFAULT (datetime('now'))
    );

    -- 모듈형 스튜디오 작업 단위. 청구 생성 시 완료+미청구 작업을 invoice_items로 복사한다.
    CREATE TABLE IF NOT EXISTS track_tasks (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      track_id      INTEGER NOT NULL REFERENCES project_tracks(id) ON DELETE CASCADE,
      task_type     TEXT NOT NULL, -- Vocal_Recording | Mixing | ...
      billing_type  TEXT NOT NULL DEFAULT 'Fixed_Per_Track', -- Time_Charge | Fixed_Per_Track
      quantity      REAL NOT NULL DEFAULT 1,
      unit_price    INTEGER NOT NULL DEFAULT 0,
      total_price   INTEGER NOT NULL DEFAULT 0,
      engineer_name TEXT,
      status        TEXT NOT NULL DEFAULT 'Pending', -- Pending | Completed ('진행중' 폐기)
      is_invoiced   INTEGER NOT NULL DEFAULT 0,
      invoice_id    INTEGER REFERENCES invoices(id) ON DELETE SET NULL,
      created_at    TEXT NOT NULL DEFAULT (datetime('now'))
    );

    -- 스튜디오 룸(공간). 룸별 시간 겹침 검사용(다른 룸이면 같은 시간 병렬 예약 허용).
    -- sessions.room_id가 이 행을 가리키지만 FK는 걸지 않는다(SQLite ALTER 한계 — 앱 레벨 정합, 삭제 시 코드가 NULL 처리).
    CREATE TABLE IF NOT EXISTS rooms (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      name       TEXT NOT NULL,
      sort_order INTEGER NOT NULL DEFAULT 0,
      active     INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    -- 스튜디오 세션(일정). 프로젝트 하위 녹음/믹싱/마스터링 예약. 청구 시간 산정의 기반.
    CREATE TABLE IF NOT EXISTS sessions (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      project_id    INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      session_type  TEXT NOT NULL DEFAULT '녹음', -- 녹음 | 믹싱 | 마스터링 | 기타
      session_date  TEXT NOT NULL,              -- 'YYYY-MM-DD'
      start_time    TEXT,                        -- 'HH:MM'
      end_time      TEXT,                        -- 'HH:MM'
      engineer_name TEXT,
      status        TEXT NOT NULL DEFAULT '예정', -- 예정 | 완료 | 취소
      memo          TEXT,
      created_at    TEXT NOT NULL DEFAULT (datetime('now'))
    );

    -- 자료 전달 기록(플레이북1 §2.3·§4.3). 파일은 Drive 또는 로컬에 저장, 메타는 여기.
    CREATE TABLE IF NOT EXISTS deliverables (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      project_id      INTEGER REFERENCES projects(id) ON DELETE CASCADE,
      title           TEXT NOT NULL,
      version         TEXT,                       -- v1, v2, final ...
      kind            TEXT NOT NULL DEFAULT '믹스', -- 믹스|스템|마스터|레퍼런스|기타
      storage_backend TEXT NOT NULL DEFAULT 'local', -- 'drive' | 'local'
      file_id         TEXT NOT NULL,              -- drive fileId 또는 로컬 파일명
      file_name       TEXT NOT NULL,              -- 원본 파일명(다운로드 시)
      file_size       INTEGER NOT NULL DEFAULT 0, -- bytes
      mime_type       TEXT,
      access_token    TEXT UNIQUE,                -- /d/:token 공개 다운로드(없으면 링크 비활성)
      expires_at      TEXT,                       -- 'YYYY-MM-DD' 만료(없으면 무기한)
      download_count  INTEGER NOT NULL DEFAULT 0,
      revoked         INTEGER NOT NULL DEFAULT 0, -- 1이면 철회(링크 무효)
      note            TEXT,
      created_at      TEXT NOT NULL DEFAULT (datetime('now'))
    );

    -- 청구(인보이스). 돈은 정수(원). 상태=발행 라이프사이클, paid_amount=실수령액(부분납 지원).
    CREATE TABLE IF NOT EXISTS invoices (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      project_id  INTEGER REFERENCES projects(id) ON DELETE SET NULL,
      title       TEXT NOT NULL,
      invoice_number TEXT UNIQUE,
      amount      INTEGER NOT NULL DEFAULT 0, -- 총액(원)
      tax_amount  INTEGER NOT NULL DEFAULT 0, -- 부가세(원, 10%)
      paid_amount INTEGER NOT NULL DEFAULT 0, -- 입금액(원)
      status      TEXT NOT NULL DEFAULT '미발행', -- 미발행|발행|입금완료
      issued_date TEXT,                       -- 'YYYY-MM-DD'
      due_date    TEXT,                       -- 'YYYY-MM-DD'
      memo        TEXT,
      created_at  TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS invoice_items (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      invoice_id  INTEGER NOT NULL REFERENCES invoices(id) ON DELETE CASCADE,
      task_id     INTEGER REFERENCES track_tasks(id) ON DELETE SET NULL,
      track_title TEXT,
      task_type   TEXT,
      description TEXT NOT NULL,
      quantity    REAL NOT NULL DEFAULT 1,
      unit_price  INTEGER NOT NULL DEFAULT 0,
      amount      INTEGER NOT NULL DEFAULT 0,
      created_at  TEXT NOT NULL DEFAULT (datetime('now'))
    );

    -- 입금 이력(payments_table_v1) — 청구 1건에 부분납 여러 건. invoices.paid_amount는 SUM(payments.amount) 파생 캐시(add/deletePayment가 유지).
    CREATE TABLE IF NOT EXISTS payments (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      invoice_id  INTEGER NOT NULL REFERENCES invoices(id) ON DELETE CASCADE,
      amount      INTEGER NOT NULL DEFAULT 0, -- 입금액(원)
      paid_on     TEXT,                       -- 'YYYY-MM-DD' 입금일
      memo        TEXT,
      created_at  TEXT NOT NULL DEFAULT (datetime('now'))
    );

    -- 앱 전역 상태(키-값): drive folder_id 캐시, refresh token(암호화), 테마 등.
    CREATE TABLE IF NOT EXISTS admin_state (
      key   TEXT PRIMARY KEY,
      value TEXT
    );

    -- (레거시 contacts/contact_affiliations는 parties/affiliations로 이관 후 제거 — legacy_drop_v1)

    -- ── 당사자(Party) 통합 모델 (party_model_v1) ──
    -- 사람·조직·그룹을 한 테이블로. "아티스트/청구처/담당자/디렉터/엔지니어"는 테이블이 아니라 party_id 참조(역할).
    -- contacts + clients를 이관해 정체성 이중화(source_contact_id 셸·'기타'·is_group)를 제거한다.
    CREATE TABLE IF NOT EXISTS parties (
      id             INTEGER PRIMARY KEY AUTOINCREMENT,
      kind           TEXT NOT NULL DEFAULT 'person',   -- person | company | group
      name           TEXT NOT NULL,                    -- 사람=본명, 조직=업체명, 그룹=팀명
      activity_name  TEXT,                             -- 활동명(아티스트). 오늘 contacts.nickname / 아티스트 client.name
      is_artist      INTEGER NOT NULL DEFAULT 0,       -- 아티스트 역할 플래그(person solo·group)
      group_id       INTEGER,                          -- 아티스트(사람)의 소속 그룹(parties.id, kind='group'). 그룹↔멤버 연결
      phone          TEXT,
      email          TEXT,
      memo           TEXT,
      -- person 속성
      family_name    TEXT,
      given_name     TEXT,
      honorific      TEXT,
      department     TEXT,
      job_title      TEXT,
      user_id        INTEGER,                          -- 로그인 계정(스태프). FK 없음(ALTER 한계 통일)
      google_resource_name TEXT,
      google_etag    TEXT,
      cash_receipt_no TEXT,                            -- 개인/솔로 아티스트 현금영수증(사업자 없는 경우)
      -- company 속성
      biz_no         TEXT,                             -- 사업자등록번호
      owner_name     TEXT,                             -- 대표자명
      owner_party_id INTEGER,                          -- 대표자를 사람 party와 연동(양방향)
      address        TEXT,
      roles          TEXT,                             -- 조직 역할 다중 CSV(소속사/레이블·제작사 겸업)
      created_at     TEXT NOT NULL DEFAULT (datetime('now'))
    );

    -- 소속 이력(이직 히스토리) — parties 기준으로 재작성(contact_affiliations 이관). org_id NULL = 무소속.
    CREATE TABLE IF NOT EXISTS affiliations (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      person_id  INTEGER NOT NULL REFERENCES parties(id) ON DELETE CASCADE,
      org_id     INTEGER REFERENCES parties(id) ON DELETE SET NULL,
      title      TEXT,
      started_on TEXT,
      ended_on   TEXT,
      memo       TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    -- 클라이언트 첨부 서류(사업자등록증·통장사본). 치프 전용, 인증 다운로드만. kind별 1개(교체 시 이전 파일 스토리지 정리).
    CREATE TABLE IF NOT EXISTS client_files (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      client_id       INTEGER NOT NULL REFERENCES parties(id) ON DELETE CASCADE, -- 조직(party) 첨부. 컬럼명은 레거시 유지(client_files_party_v1 재구성)
      kind            TEXT NOT NULL,                       -- 'biz_license' | 'bankbook'
      storage_backend TEXT NOT NULL DEFAULT 'local',       -- 'drive' | 'local'
      file_id         TEXT NOT NULL,                       -- drive fileId 또는 로컬 파일명
      file_name       TEXT NOT NULL,                       -- 원본 파일명(다운로드 시 사용)
      mime_type       TEXT,
      file_size       INTEGER NOT NULL DEFAULT 0,
      created_at      TEXT NOT NULL DEFAULT (datetime('now'))
    );

    -- 세션 담당 디렉터(다대다) — 한 세션에 고객측 디렉터 여러 명. 단일 sessions.director_contact_id는 레거시 보존.
    CREATE TABLE IF NOT EXISTS session_directors (
      session_id INTEGER NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
      contact_id INTEGER NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (session_id, contact_id)
    );

    CREATE INDEX IF NOT EXISTS idx_rate_items_active ON rate_items(active, name);
    CREATE INDEX IF NOT EXISTS idx_task_types_active ON task_types(active, sort_order, label);
    CREATE INDEX IF NOT EXISTS idx_project_tracks_project ON project_tracks(project_id);
    CREATE INDEX IF NOT EXISTS idx_track_tasks_track ON track_tasks(track_id);
    CREATE INDEX IF NOT EXISTS idx_track_tasks_invoice ON track_tasks(invoice_id, is_invoiced);
    CREATE INDEX IF NOT EXISTS idx_sessions_project ON sessions(project_id);
    CREATE INDEX IF NOT EXISTS idx_sessions_date ON sessions(session_date);
    CREATE INDEX IF NOT EXISTS idx_rooms_active ON rooms(active, sort_order, name);
    CREATE INDEX IF NOT EXISTS idx_deliverables_project ON deliverables(project_id);
    CREATE INDEX IF NOT EXISTS idx_deliverables_token ON deliverables(access_token);
    CREATE INDEX IF NOT EXISTS idx_invoices_project ON invoices(project_id);
    CREATE INDEX IF NOT EXISTS idx_invoices_status ON invoices(status);
    CREATE INDEX IF NOT EXISTS idx_invoice_items_invoice ON invoice_items(invoice_id);
    CREATE INDEX IF NOT EXISTS idx_invoice_items_task ON invoice_items(task_id);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_client_files_kind ON client_files(client_id, kind);
    CREATE INDEX IF NOT EXISTS idx_client_files_client ON client_files(client_id);
  `);

  addColumn("users", "active", "INTEGER NOT NULL DEFAULT 1");
  // 청구처(공급받는 자) 세금계산서 정보
  addColumn("clients", "biz_no", "TEXT");      // 사업자등록번호
  addColumn("clients", "owner_name", "TEXT");  // 대표자명
  addColumn("clients", "address", "TEXT");     // 사업장 주소
  addColumn("clients", "source_contact_id", "INTEGER"); // 담당자(연락처)를 청구처로 변환 시 출처 contact — 동명이인 병합 방지
  addColumn("clients", "cash_receipt_no", "TEXT"); // 현금영수증 발급번호(개인/아티스트 — 사업자등록증 없는 경우. 휴대폰 번호 또는 현금영수증 카드번호)
  addColumn("clients", "group_name", "TEXT"); // 소속그룹(아티스트가 속한 그룹·팀 등. 자유 텍스트)
  addColumn("clients", "agency_name", "TEXT"); // 소속사(아티스트의 소속사·레이블. 소속그룹과 별개)
  addColumn("clients", "owner_contact_id", "INTEGER REFERENCES contacts(id) ON DELETE SET NULL"); // 대표자를 연락처(사람)와 연동 — 양방향 링크
  addColumn("clients", "roles", "TEXT"); // 업체 역할 다중(CSV: 소속사/레이블·제작사 — 겸업 대응). kind는 1차 분류로 유지
  addColumn("clients", "is_group", "INTEGER NOT NULL DEFAULT 0"); // 아티스트가 그룹·밴드/팀(사람 아님)이면 1 → 연락처(사람) 연결 안 함. 개인 아티스트(0)는 연락처로 통합해 중복 방지
  addColumn("clients", "agency_client_id", "INTEGER REFERENCES clients(id) ON DELETE SET NULL"); // 아티스트의 소속 업체(소속사·제작사) — 업체 상세 소속 아티스트 목록
  // 거래처 외부 열람(client) 폐기 → 잔여 client 계정은 비활성화(로그인 차단).
  try {
    d.exec("UPDATE users SET active = 0 WHERE role = 'client'");
  } catch (_e) {
    /* role 컬럼/값이 없으면 무시 */
  }
  // 역할 2단계(admin/staff) → 3단계(owner/chief/staff): 기존 admin은 chief(치프)로 승계.
  try {
    d.exec("UPDATE users SET role = 'chief' WHERE role = 'admin'");
  } catch (_e) {
    /* 무시 */
  }
  // 클라이언트 분류 재정의: 레이블→소속사/레이블, 대행사→제작사.
  try {
    d.exec("UPDATE clients SET kind = '소속사/레이블' WHERE kind = '레이블'");
    d.exec("UPDATE clients SET kind = '제작사' WHERE kind = '대행사'");
  } catch (_e) {
    /* 무시 */
  }
  addColumn("projects", "project_type", "TEXT"); // session | task (null=레거시). 구 recording→session, mixing→task는 아래 rename 게이트에서 1회 전환
  addColumn("projects", "services", "TEXT");
  addColumn("projects", "artist", "TEXT");
  addColumn("projects", "artist_company", "TEXT");
  addColumn("projects", "production_company", "TEXT");
  addColumn("projects", "manager_id", "INTEGER REFERENCES project_managers(id) ON DELETE SET NULL");
  addColumn("projects", "contact_id", "INTEGER"); // 레거시(고객 담당 연락처) — FK 제거(contacts 드롭 대비), legacy_drop_v1이 제거
  addColumn("invoices", "invoice_number", "TEXT");
  addColumn("invoices", "tax_amount", "INTEGER NOT NULL DEFAULT 0");
  addColumn("invoices", "discount_amount", "INTEGER NOT NULL DEFAULT 0"); // 청구 전체 할인(원). 0=할인 없음.
  addColumn("invoices", "tax_status", "TEXT NOT NULL DEFAULT '계산서 미발행'"); // 계산서·입금 상태(청구서 발행과 별개 축): 계산서 미발행 | 계산서 발행 | 입금완료
  addColumn("rate_items", "category", "TEXT NOT NULL DEFAULT '스튜디오 녹음'"); // 단가표(녹음 종류) 분류: 스튜디오 녹음 | 로케이션 녹음
  addColumn("sessions", "rate_item_id", "INTEGER REFERENCES rate_items(id) ON DELETE SET NULL"); // 녹음 세션 시간제 단가표 연결
  addColumn("project_managers", "user_id", "INTEGER REFERENCES users(id) ON DELETE SET NULL"); // 하우스 엔지니어(로그인 사용자)와 링크. null=외주 작업자
  addColumn("project_managers", "contact_id", "INTEGER"); // 연동 연락처(contacts.id). null=미연동
  addColumn("sessions", "booker_name", "TEXT"); // 예약 담당자(담당자 마스터에서 선택, 담당 엔지니어와 별개)
  addColumn("sessions", "gcal_event_id", "TEXT"); // 예약 시 자동 생성한 구글 캘린더 일정 id(수정·삭제 추적)
  addColumn("sessions", "room_id", "INTEGER"); // 룸(스튜디오 공간). FK 없음(ALTER 한계) — 룸별 겹침 검사, 룸 삭제 시 코드가 NULL 처리(SET NULL 의미)
  addColumn("sessions", "director_contact_id", "INTEGER"); // 담당 디렉터(클라이언트 측 연락처). FK 없음(ALTER 한계) — 연락처 삭제 시 코드가 NULL 처리.
  // room_id 컬럼은 위 addColumn으로 보장되므로 의존 인덱스는 여기서 생성(big exec 블록보다 뒤).
  d.exec("CREATE INDEX IF NOT EXISTS idx_sessions_room ON sessions(room_id);");
  addColumn("project_tracks", "artist", "TEXT"); // 곡·콘텐츠별 아티스트(한 프로젝트에 여러 아티스트 가능). 미입력 시 프로젝트 아티스트.
  addColumn("track_tasks", "session_id", "INTEGER REFERENCES sessions(id) ON DELETE SET NULL"); // 세션에서 생성된 청구 작업 추적(레거시 전환분)
  addColumn("track_tasks", "worker_paid", "INTEGER NOT NULL DEFAULT 0"); // 외주 작업자 지급(정산) 여부
  addColumn("track_tasks", "worker_paid_date", "TEXT"); // 지급 처리일(YYYY-MM-DD)
  addColumn("track_tasks", "worker_rate", "INTEGER NOT NULL DEFAULT 0"); // 외주 지급단가(원). 정산 합계 기준(고객청구 total_price와 별개, 미입력=0)
  addColumn("track_tasks", "engineer_id", "INTEGER"); // 담당 엔지니어(project_managers 참조 의미·FK 없음). rename 내성 정산 매칭 키
  addColumn("invoice_items", "session_id", "INTEGER REFERENCES sessions(id) ON DELETE SET NULL"); // 녹음 세션 직접 청구 라인(곡·콘텐츠 안 거침). 청구 여부 = 이 컬럼 역참조
  // contacts 확장 필드 — Google People API 동기화 대비
  addColumn("contacts", "family_name", "TEXT");   // 성
  addColumn("contacts", "given_name",  "TEXT");   // 이름
  addColumn("contacts", "honorific",   "TEXT");   // 호칭(예: 님, 씨, 대표님)
  addColumn("contacts", "nickname",    "TEXT");   // 별명
  addColumn("contacts", "company",     "TEXT");   // 소속 회사명(직접 입력, contact_affiliations 이력과 별개)
  addColumn("contacts", "job_title",   "TEXT");   // 직책
  addColumn("contacts", "department",  "TEXT");   // 부서
  addColumn("contacts", "google_resource_name", "TEXT"); // Google People API resourceName (예: "people/c123")
  addColumn("contacts", "google_etag",          "TEXT"); // Google People API etag(충돌 방지)
  addColumn("contacts", "user_id", "INTEGER"); // 녹음실 스태프(로그인 계정)와 연결. FK 없음(ALTER 한계). null=외부/고객측 연락처. owner 포함 전 직원이 연락처에 노출
  // ── 당사자 모델 역할 참조 컬럼(party_model_v1, 휴면) — P1은 populate만, 읽기 경로는 P2에서 전환 ──
  addColumn("invoices", "payer_id", "INTEGER"); // 청구처 = parties.id(기존 client_id 대체). FK 없음(ALTER 한계)
  addColumn("invoices", "payer_snapshot", "TEXT"); // 발행 시점 청구처 정보 스냅샷(JSON) — 이후 클라이언트 정보 변경돼도 과거 청구서 표시 고정. NULL=레거시(실시간 폴백)
  addColumn("projects", "artist_id", "INTEGER"); // 공연 당사자(parties.id)
  addColumn("projects", "agency_id", "INTEGER"); // 소속사/레이블(parties.id, 기존 artist_company TEXT 대체)
  addColumn("projects", "production_id", "INTEGER"); // 제작사(parties.id, 기존 production_company TEXT 대체)
  addColumn("projects", "contact_party_id", "INTEGER"); // 고객측 담당자(parties.id, 기존 contact_id 대체)
  addColumn("project_managers", "party_id", "INTEGER"); // 작업 담당 엔지니어 = person party(기존 contact_id 대체)
  addColumn("sessions", "director_party_id", "INTEGER"); // 담당 디렉터 첫 명(parties.id, 레거시 director_contact_id 대체)
  addColumn("sessions", "all_day", "INTEGER NOT NULL DEFAULT 0"); // 종일(Google/Apple 개념 = 하루 종일·시간 없음). all_day=1이면 start/end NULL
  addColumn("session_directors", "party_id", "INTEGER"); // 다대다 디렉터(parties.id, 기존 contact_id 대체)
  addColumn("parties", "group_id", "INTEGER"); // 아티스트(사람)의 소속 그룹(parties.id, kind='group'). 그룹↔멤버 연결
  addColumn("parties", "contact_party_id", "INTEGER"); // 그룹의 담당자(parties.id, 사람 — 멤버 또는 관계자)
  d.exec("CREATE INDEX IF NOT EXISTS idx_parties_group ON parties(group_id);");
  d.exec("CREATE INDEX IF NOT EXISTS idx_parties_kind ON parties(kind, is_artist, name);");
  d.exec("CREATE INDEX IF NOT EXISTS idx_parties_user ON parties(user_id);");
  d.exec("CREATE INDEX IF NOT EXISTS idx_affiliations_person ON affiliations(person_id, ended_on);");
  d.exec("CREATE INDEX IF NOT EXISTS idx_affiliations_org ON affiliations(org_id, ended_on);");
  d.exec("CREATE INDEX IF NOT EXISTS idx_invoices_payer ON invoices(payer_id);");
  d.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_invoices_invoice_number ON invoices(invoice_number);");
  d.exec("CREATE INDEX IF NOT EXISTS idx_projects_manager ON projects(manager_id);");
  // 세션당 청구 작업 1건만(부분 유니크: NULL은 다중 허용). 중복 청구 방어 심층.
  d.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_track_tasks_session ON track_tasks(session_id) WHERE session_id IS NOT NULL;");
  d.exec("CREATE INDEX IF NOT EXISTS idx_invoice_items_session ON invoice_items(session_id);");
  // 레거시 정체성 테이블(clients/contacts) 존재 여부 — 아래 이관 게이트를 가드(드롭 후·신선 DB에선 스킵).
  const hasLegacy = tableExists("clients");
  // 프로젝트 유형 키 전환(1회): 구 recording→session, mixing→task. 멱등 게이트.
  // backfillProjectServices는 project_type IS NULL만 대상이라 본 전환과 충돌하지 않는다.
  if (!getState("project_type_rename_v1")) {
    d.exec("UPDATE projects SET project_type = 'session' WHERE project_type = 'recording'");
    d.exec("UPDATE projects SET project_type = 'task' WHERE project_type = 'mixing'");
    setState("project_type_rename_v1", "done");
  }
  // '진행중'(In_Progress) 상태 폐기 — 대기/완료 2단계로. 기존 진행중 작업은 대기(Pending)로 승계(멱등).
  if (!getState("task_status_drop_inprogress_v1")) {
    d.exec("UPDATE track_tasks SET status = 'Pending' WHERE status = 'In_Progress'");
    setState("task_status_drop_inprogress_v1", "done");
  }
  // 입금 이력 분리(payments_table_v1): 기존 paid_amount>0을 payments 이력 1건으로 백필(이력 없는 인보이스만). 이후 paid_amount는 SUM(payments) 파생 캐시.
  if (!getState("payments_backfill_v1")) {
    d.prepare(
      `INSERT INTO payments (invoice_id, amount, paid_on, memo)
       SELECT i.id, i.paid_amount, COALESCE(i.issued_date, date('now')), '기존 입금 이관'
       FROM invoices i
       WHERE i.paid_amount > 0 AND NOT EXISTS (SELECT 1 FROM payments p WHERE p.invoice_id = i.id)`
    ).run();
    setState("payments_backfill_v1", "done");
  }
  // 사업자등록번호 하이픈 정규화 1회 백필(000-00-00000) — 저장 경로는 formatBizNo가 상시 적용(lib/format).
  if (!getState("biz_no_format_v1")) {
    const { formatBizNo } = require("./lib/format"); // lib은 db를 require하지 않음(순환 없음)
    for (const r of d.prepare("SELECT id, biz_no FROM parties WHERE biz_no IS NOT NULL").all()) {
      const f = formatBizNo(r.biz_no);
      if (f && f !== r.biz_no) d.prepare("UPDATE parties SET biz_no = ? WHERE id = ?").run(f, r.id);
    }
    const sb = getState("studio_biz_no");
    if (sb) { const f = formatBizNo(sb); if (f && f !== sb) setState("studio_biz_no", f); }
    setState("biz_no_format_v1", "done");
  }
  seedDefaultCatalogs();
  // 기본 룸 1개 1회 시드(이후 치프가 /settings에서 CRUD). 멱등 게이트 + 기존 룸 있으면 건너뜀.
  if (!getState("rooms_seed_v1")) {
    const hasRoom = d.prepare("SELECT id FROM rooms LIMIT 1").get();
    if (!hasRoom) d.prepare("INSERT INTO rooms (name, sort_order, active) VALUES (?, 0, 1)").run("메인 룸");
    setState("rooms_seed_v1", "done");
  }
  // 레거시 마이그레이션은 1회만. 신규 프로젝트(project_type 있음)는 services=NULL이 정상이므로,
  // 매 부팅 재실행되면 memo 추론으로 유령 곡·작업을 주입한다 → admin_state 플래그로 1회 게이트.
  if (!getState("legacy_backfill_v1")) {
    backfillProjectServices();
    backfillLegacyServicesToTracks();
    setState("legacy_backfill_v1", "done");
  }
  // 업체 역할 백필(2026-07-01): 기존 업체(비아티스트)의 roles가 비면 kind를 첫 역할로 시드(겸업 태그 기반). 1회 게이트.
  if (hasLegacy && !getState("client_roles_backfill_v1")) {
    d.prepare("UPDATE clients SET roles = kind WHERE (roles IS NULL OR roles = '') AND kind <> '아티스트'").run();
    setState("client_roles_backfill_v1", "done");
  }
  // 청구 상태 2축 분리(2026-07-01): 기존 status='입금완료' → 청구서 발행 + 계산서 입금완료로 이관. 1회 게이트(멱등).
  if (!getState("invoice_tax_status_split_v1")) {
    d.prepare("UPDATE invoices SET tax_status='입금완료' WHERE status='입금완료'").run(); // 계산서 축에 입금완료 이관(먼저)
    d.prepare("UPDATE invoices SET status='발행' WHERE status='입금완료'").run();          // 청구서 축은 발행으로 축소
    setState("invoice_tax_status_split_v1", "done");
  }
  // 기존 프로젝트의 아티스트·소속사/레이블·제작사를 클라이언트 마스터에 1회 백필. 이후는 프로젝트 저장 시 자동 등록.
  if (hasLegacy && !getState("project_clients_backfill_v1")) {
    for (const [col, kind] of [["artist", "아티스트"], ["artist_company", "소속사/레이블"], ["production_company", "제작사"]]) {
      d.prepare(
        `INSERT INTO clients (name, kind)
         SELECT DISTINCT TRIM(p.${col}), ? FROM projects p
         WHERE p.${col} IS NOT NULL AND TRIM(p.${col}) <> ''
           AND NOT EXISTS (SELECT 1 FROM clients c WHERE c.name = TRIM(p.${col}) AND c.kind = ?)`
      ).run(kind, kind);
    }
    setState("project_clients_backfill_v1", "done");
  }
  // 하우스 엔지니어(이름 있는 활성 사용자)를 작업 담당자로 1회 백필. 이후는 로그인·관리에서 동기화.
  if (!getState("house_engineer_backfill_v1")) {
    d.prepare(
      `INSERT INTO project_managers (name, email, active, user_id)
       SELECT u.name, u.email, 1, u.id FROM users u
       WHERE u.active = 1 AND u.name IS NOT NULL AND TRIM(u.name) <> ''
         AND NOT EXISTS (SELECT 1 FROM project_managers pm WHERE pm.user_id = u.id)`
    ).run();
    setState("house_engineer_backfill_v1", "done");
  }
  // 기존 작업의 engineer_name을 담당자 마스터(project_managers.name)와 매칭해 engineer_id 1회 백필.
  // 동명이인 방지: 정확히 1건 매칭일 때만 채운다(0건·2건↑은 NULL 유지 → 정산은 이름 폴백으로 동작).
  // house_engineer_backfill 뒤에 둬서 하우스 엔지니어 이름도 매칭 대상에 포함된다.
  if (!getState("track_engineer_id_backfill_v1")) {
    d.exec(`
      UPDATE track_tasks
      SET engineer_id = (
        SELECT pm.id FROM project_managers pm WHERE pm.name = track_tasks.engineer_name
      )
      WHERE engineer_id IS NULL
        AND engineer_name IS NOT NULL AND TRIM(engineer_name) <> ''
        AND (SELECT COUNT(*) FROM project_managers pm2 WHERE pm2.name = track_tasks.engineer_name) = 1
    `);
    setState("track_engineer_id_backfill_v1", "done");
  }

  // 활성 담당자(project_managers) 중 연동 연락처가 없는 행에 contacts 행을 1회 생성.
  // 멱등: contact_id가 이미 있는 행은 건너뜀.
  if (hasLegacy && !getState("manager_contacts_backfill_v1")) {
    const managers = d.prepare("SELECT id, name, phone, email FROM project_managers WHERE active = 1 AND contact_id IS NULL").all();
    const insContact = d.prepare("INSERT INTO contacts (name, family_name, given_name, phone, email) VALUES (?, ?, ?, ?, ?)");
    const updMgr = d.prepare("UPDATE project_managers SET contact_id = ? WHERE id = ?");
    for (const m of managers) {
      if (!m.name || !String(m.name).trim()) continue;
      const { family, given } = splitKoreanName(m.name); // 담당자 이름 → 성·이름 자동 분리
      const info = insContact.run(m.name, family || null, given || null, m.phone || null, m.email || null);
      updMgr.run(info.lastInsertRowid, m.id);
    }
    setState("manager_contacts_backfill_v1", "done");
  }

  // 전 로그인 계정(owner 포함)을 연락처에 1회 연결: 하우스(chief/staff)는 기존 담당자 연락처에 user_id 링크,
  // 담당자 연락처가 없는 계정(owner)은 새 연락처 생성. 멱등(contacts.user_id 이미 있으면 건너뜀).
  if (hasLegacy && !getState("user_contacts_backfill_v1")) {
    const users = d.prepare("SELECT id, name, email FROM users WHERE active = 1").all();
    const findByUser = d.prepare("SELECT id FROM contacts WHERE user_id = ?");
    const mgrContact = d.prepare("SELECT contact_id FROM project_managers WHERE user_id = ? AND contact_id IS NOT NULL");
    const linkContact = d.prepare("UPDATE contacts SET user_id = ? WHERE id = ?");
    const insUserContact = d.prepare("INSERT INTO contacts (name, family_name, given_name, email, user_id) VALUES (?, ?, ?, ?, ?)");
    for (const u of users) {
      if (!u.name || !String(u.name).trim()) continue;
      if (findByUser.get(u.id)) continue;
      const mc = mgrContact.get(u.id);
      if (mc && mc.contact_id) { linkContact.run(u.id, mc.contact_id); continue; }
      const { family, given } = splitKoreanName(u.name);
      insUserContact.run(u.name, family || null, given || null, u.email || null, u.id);
    }
    setState("user_contacts_backfill_v1", "done");
  }

  // 기존 단일 담당 디렉터(sessions.director_contact_id)를 다대다 테이블(session_directors)로 1회 복사. 멱등(중복 무시).
  // 레거시 세션 디렉터(contact 기반)만 대상 — 신선 DB(contacts 없음)에선 스킵(session_directors.contact_id FK→contacts).
  if (hasLegacy && !getState("session_directors_backfill_v1")) {
    d.prepare(
      `INSERT OR IGNORE INTO session_directors (session_id, contact_id)
       SELECT id, director_contact_id FROM sessions WHERE director_contact_id IS NOT NULL`
    ).run();
    setState("session_directors_backfill_v1", "done");
  }

  // 이번 수정(2026-07-02) 전에 생긴 중복 정리: 연락처와 따로 만들어진 고아 아티스트 클라이언트
  // (source_contact_id IS NULL·개인)를 같은 이름 연락처에 1회 연결(source_contact_id 흡수).
  //  - 매칭: 연락처 name 또는 nickname = 아티스트명, 이미 다른 아티스트에 연결되지 않은 연락처.
  //  - **유일 매칭일 때만** 연결(동명이인 오연결 방지 — ⑤ 정책). 2+·0 매칭은 건너뜀(수동 처리 여지).
  //  - 연결 시 연락처 nickname(활동명)이 비면 아티스트명으로 채움. 멱등(orphan만 대상).
  if (hasLegacy && !getState("artist_contact_link_backfill_v1")) {
    const orphans = d
      .prepare("SELECT id, name FROM clients WHERE kind = '아티스트' AND source_contact_id IS NULL AND COALESCE(is_group,0) = 0")
      .all();
    const findContacts = d.prepare(
      `SELECT id, nickname FROM contacts
        WHERE (name = @nm OR nickname = @nm)
          AND id NOT IN (SELECT source_contact_id FROM clients WHERE source_contact_id IS NOT NULL AND kind = '아티스트')`
    );
    const linkArtist = d.prepare("UPDATE clients SET source_contact_id = ?, is_group = 0 WHERE id = ?");
    const setNick = d.prepare("UPDATE contacts SET nickname = ? WHERE id = ?");
    for (const a of orphans) {
      const nm = String(a.name || "").trim();
      if (!nm) continue;
      const matches = findContacts.all({ nm });
      if (matches.length !== 1) continue; // 유일 매칭만(모호하면 병합 금지)
      const ct = matches[0];
      linkArtist.run(ct.id, a.id);
      if (!String(ct.nickname || "").trim()) setNick.run(nm, ct.id);
    }
    setState("artist_contact_link_backfill_v1", "done");
  }

  // 기존 연락처 중 성·이름이 둘 다 비어있는 행을 표시명(name)으로 1회 백필(splitKoreanName).
  // manager_contacts_backfill 뒤에 둬서 새로 만든 담당자 연락처(이미 성·이름 채워짐)는 자연히 건너뛴다.
  if (hasLegacy && !getState("contact_family_name_backfill_v1")) {
    const rows = d
      .prepare(
        `SELECT id, name FROM contacts
          WHERE name IS NOT NULL AND TRIM(name) <> ''
            AND (family_name IS NULL OR TRIM(family_name) = '')
            AND (given_name IS NULL OR TRIM(given_name) = '')`
      )
      .all();
    const upd = d.prepare("UPDATE contacts SET family_name = ?, given_name = ? WHERE id = ?");
    for (const r of rows) {
      const { family, given } = splitKoreanName(r.name);
      if (family || given) upd.run(family || null, given || null, r.id);
    }
    setState("contact_family_name_backfill_v1", "done");
  }

  // ── 당사자(Party) 모델 이관(party_model_v1) — contacts+clients → parties, 역할 FK 재배선 ──
  // 위 모든 contacts/clients 백필 이후 실행(최종 상태를 이관). 순수 populate(읽기 경로 무변경, P2에서 전환).
  // 원자적(BEGIN/COMMIT: 게이트+데이터 일괄) + 부팅 안전(실패해도 앱은 레거시 clients/contacts로 무중단, 재배포 시 재시도).
  if (hasLegacy && !getState("party_model_v1")) {
    try {
      d.exec("BEGIN IMMEDIATE;");
      migrateToPartyModel(d);
      setState("party_model_v1", "done"); // 같은 트랜잭션 안 — 데이터와 게이트 원자화(부분 이관 방지)
      d.exec("COMMIT;");
    } catch (e) {
      try { d.exec("ROLLBACK;"); } catch (_e) { /* 이미 롤백/미개시 */ }
      console.error("[migrate party_model_v1] 실패 — 레거시(clients/contacts)로 무중단 계속, 재배포 시 재시도:", e && e.message);
    }
  }

  // session_directors를 party 기준으로 재구성(contact_id FK→contacts 제거, party_id FK→parties). party_model_v1이 party_id를 채운 뒤.
  //  FK 활성 상태라 contact_id에 party id filler를 넣을 수 없어(위반) 테이블 재작성이 필요. 원자·무중단.
  if (!getState("session_directors_party_v1")) {
    try {
      d.exec("BEGIN IMMEDIATE;");
      d.exec(`CREATE TABLE IF NOT EXISTS session_directors_new (
        session_id INTEGER NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        party_id   INTEGER NOT NULL REFERENCES parties(id) ON DELETE CASCADE,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        PRIMARY KEY (session_id, party_id)
      );`);
      d.exec("INSERT OR IGNORE INTO session_directors_new (session_id, party_id, created_at) SELECT session_id, party_id, created_at FROM session_directors WHERE party_id IS NOT NULL;");
      d.exec("DROP TABLE session_directors;");
      d.exec("ALTER TABLE session_directors_new RENAME TO session_directors;");
      d.exec("CREATE INDEX IF NOT EXISTS idx_session_directors_party ON session_directors(party_id);");
      setState("session_directors_party_v1", "done");
      d.exec("COMMIT;");
    } catch (e) {
      try { d.exec("ROLLBACK;"); } catch (_e) { /* noop */ }
      console.error("[migrate session_directors_party_v1] 실패 — 레거시 유지, 재배포 재시도:", e && e.message);
    }
  }

  // client_files를 party(조직) 기준으로 재구성: client_id 컬럼명은 유지하되 FK를 parties로 바꾸고 값을 조직 party id로 remap(이름 매칭).
  //  → 새 조직(party)에도 사업자등록증 첨부 가능. 이름 매칭 실패분(주로 사업자 아닌 첨부)은 드롭(사업자등록증=조직).
  if (hasLegacy && !getState("client_files_party_v1")) {
    try {
      d.exec("BEGIN IMMEDIATE;");
      d.exec(`CREATE TABLE IF NOT EXISTS client_files_new (
        id              INTEGER PRIMARY KEY AUTOINCREMENT,
        client_id       INTEGER NOT NULL REFERENCES parties(id) ON DELETE CASCADE,
        kind            TEXT NOT NULL,
        storage_backend TEXT NOT NULL DEFAULT 'local',
        file_id         TEXT NOT NULL,
        file_name       TEXT NOT NULL,
        mime_type       TEXT,
        file_size       INTEGER NOT NULL DEFAULT 0,
        created_at      TEXT NOT NULL DEFAULT (datetime('now'))
      );`);
      d.exec(`INSERT INTO client_files_new (id, client_id, kind, storage_backend, file_id, file_name, mime_type, file_size, created_at)
        SELECT cf.id, pp.id, cf.kind, cf.storage_backend, cf.file_id, cf.file_name, cf.mime_type, cf.file_size, cf.created_at
        FROM client_files cf
        JOIN clients c ON c.id = cf.client_id
        JOIN parties pp ON pp.kind = 'company' AND pp.name = c.name;`);
      d.exec("DROP TABLE client_files;");
      d.exec("ALTER TABLE client_files_new RENAME TO client_files;");
      d.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_client_files_kind ON client_files(client_id, kind);");
      d.exec("CREATE INDEX IF NOT EXISTS idx_client_files_client ON client_files(client_id);");
      setState("client_files_party_v1", "done");
      d.exec("COMMIT;");
    } catch (e) {
      try { d.exec("ROLLBACK;"); } catch (_e) { /* noop */ }
      console.error("[migrate client_files_party_v1] 실패 — 레거시 유지, 재배포 재시도:", e && e.message);
    }
  }

  // 레거시 정체성 테이블·FK 컬럼 최종 드롭(party_model 이관 완료 후에만). 존재검사로 멱등·실패 무중단.
  if (!getState("legacy_drop_v1") && getState("party_model_v1")) {
    try {
      dropLegacyIdentity(d);
      setState("legacy_drop_v1", "done");
    } catch (e) {
      console.error("[migrate legacy_drop_v1] 실패 — 레거시 유지(앱은 정상), 재배포 재시도:", e && e.message);
    }
  }

  // ── 후속 단계 테이블 자리(스키마만; 아직 미사용) ──
  // invoice_items / payments (라인아이템·입금 이력 분리가 필요해지면)

  return d;
}

function seedDefaultCatalogs() {
  const d = db();
  // project_service_items는 레거시(구 services JSON 라벨 호환) — 읽는 코드 없음(라벨은 config 상수). 시드 폐기, 테이블만 잔존.

  // 작업 종류 카탈로그 1회 시드(이후 치프의 편집·삭제가 영구히 유지되도록 플래그 게이트). ON CONFLICT으로 멱등.
  if (!getState("task_types_seed_v1")) {
    const insTaskType = d.prepare(
      `INSERT INTO task_types (key, label, task_group, billing_type, unit_price, is_quick, sort_order)
       VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(key) DO NOTHING`
    );
    TASK_TYPES.forEach((t, i) =>
      insTaskType.run(t.key, t.label, t.group, t.billing || "Fixed_Per_Track", t.price || 0, t.quick ? 1 : 0, (i + 1) * 10)
    );
    setState("task_types_seed_v1", "done");
  }

  const hasManager = d.prepare("SELECT id FROM project_managers LIMIT 1").get();
  if (!hasManager) {
    d.prepare("INSERT INTO project_managers (name, active) VALUES (?, 1)").run("스튜디오 관리자");
  }
}

/** 멱등 컬럼 추가: 이미 있으면 무시(플레이북 §2.8). 드롭된 레거시 테이블(clients/contacts) 대상이면 'no such table'도 무시(무해). */
function addColumn(table, column, typeSql) {
  try {
    db().exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${typeSql}`);
  } catch (e) {
    if (!/duplicate column name|no such table/i.test(e.message)) throw e;
  }
}

/** 테이블·컬럼 존재 여부(레거시 드롭 멱등 판정). */
function tableExists(name) {
  return !!db().prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name);
}
function columnExists(table, column) {
  if (!tableExists(table)) return false;
  return db().prepare(`PRAGMA table_info(${table})`).all().some((r) => r.name === column);
}

function backfillProjectServices() {
  // project_type이 있는 신규 프로젝트는 제외(services=NULL이 정상). 레거시 행만 추론 대상.
  const rows = db()
    .prepare("SELECT id, status, memo, services FROM projects WHERE (services IS NULL OR services = '') AND project_type IS NULL")
    .all();
  const update = db().prepare("UPDATE projects SET services = ? WHERE id = ?");
  for (const row of rows) {
    const text = `${row.status || ""} ${row.memo || ""}`;
    const services = [];
    if (/녹음/.test(text)) services.push("recording");
    if (/보컬\s*튠|보컬튠|튜닝|튠/.test(text)) services.push("vocal_tune");
    if (/믹싱|믹스/.test(text)) services.push("mixing");
    if (/마스터링|마스터/.test(text)) services.push("mastering");
    update.run(JSON.stringify([...new Set(services)]), row.id);
  }
}

function backfillLegacyServicesToTracks() {
  const rows = db()
    .prepare(
      `SELECT p.id, p.title, p.services
       FROM projects p
       WHERE p.services IS NOT NULL
         AND p.services <> ''
         AND NOT EXISTS (SELECT 1 FROM project_tracks tr WHERE tr.project_id = p.id)`
    )
    .all();
  const taskMap = {
    recording: "Vocal_Recording",
    vocal_tune: "Vocal_Tuning",
    mixing: "Mixing",
    mastering: "Mastering",
  };
  const insertTrack = db().prepare("INSERT INTO project_tracks (project_id, title, content_type) VALUES (?, ?, 'Music')");
  const insertTask = db().prepare(
    `INSERT INTO track_tasks
     (track_id, task_type, billing_type, quantity, unit_price, total_price, status, is_invoiced)
     VALUES (?, ?, 'Fixed_Per_Track', 1, ?, ?, ?, 0)`
  );

  for (const row of rows) {
    let services;
    try {
      services = JSON.parse(row.services);
    } catch {
      services = [];
    }
    if (!Array.isArray(services) || !services.length) continue;

    const grouped = new Map();
    for (const item of services) {
      const key = typeof item === "string" ? item : String(item && item.key ? item.key : "").trim();
      const taskType = taskMap[key];
      if (!taskType) continue;
      const title = String((item && item.track_title) || row.title || "곡·콘텐츠").trim();
      if (!grouped.has(title)) grouped.set(title, []);
      grouped.get(title).push({
        taskType,
        amount: parsePositiveInt(item && item.amount),
        status: item && item.completed_at ? "Completed" : "Pending",
      });
    }

    for (const [title, tasks] of grouped) {
      const info = insertTrack.run(row.id, title || row.title || "곡·콘텐츠");
      for (const task of tasks) {
        insertTask.run(info.lastInsertRowid, task.taskType, task.amount, task.amount, task.status);
      }
    }
  }
}

function parsePositiveInt(value) {
  const n = parseInt(String(value == null ? "" : value).replace(/[^\d-]/g, ""), 10);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

/**
 * 당사자(Party) 모델 이관(party_model_v1): contacts + clients를 parties로 모으고 역할 FK를 재배선한다.
 * **순수 populate** — 기존 contacts/clients/레거시 컬럼은 휴면 보존(P2에서 읽기 전환, P4에서 제거). 1회 게이트로 호출.
 * 매핑: contacts→person / 소속사·제작사→company / 그룹 아티스트→group /
 *       솔로 아티스트·'기타' 셸(source_contact_id)→해당 사람 party 병합(중복 제거의 핵심).
 */
function migrateToPartyModel(d) {
  const contactMap = new Map(); // contacts.id → parties.id
  const clientMap = new Map(); // clients.id → parties.id

  const insPerson = d.prepare(
    `INSERT INTO parties (kind, name, activity_name, is_artist, phone, email, memo,
       family_name, given_name, honorific, department, job_title, user_id, google_resource_name, google_etag, cash_receipt_no)
     VALUES ('person', @name, @activity_name, @is_artist, @phone, @email, @memo,
       @family_name, @given_name, @honorific, @department, @job_title, @user_id, @google_resource_name, @google_etag, @cash_receipt_no)`
  );
  const personRow = (o) => ({
    name: o.name, activity_name: o.activity_name || null, is_artist: o.is_artist ? 1 : 0,
    phone: o.phone || null, email: o.email || null, memo: o.memo || null,
    family_name: o.family_name || null, given_name: o.given_name || null, honorific: o.honorific || null,
    department: o.department || null, job_title: o.job_title || null, user_id: o.user_id || null,
    google_resource_name: o.google_resource_name || null, google_etag: o.google_etag || null,
    cash_receipt_no: o.cash_receipt_no || null,
  });

  // 1) contacts → person parties
  for (const c of d.prepare("SELECT * FROM contacts").all()) {
    const info = insPerson.run(personRow({ ...c, activity_name: c.nickname }));
    contactMap.set(c.id, info.lastInsertRowid);
  }

  // 2) clients → parties
  const insCompany = d.prepare(
    `INSERT INTO parties (kind, name, phone, email, memo, biz_no, owner_name, address, roles)
     VALUES ('company', @name, @phone, @email, @memo, @biz_no, @owner_name, @address, @roles)`
  );
  const insArtistParty = d.prepare(
    `INSERT INTO parties (kind, name, activity_name, is_artist, phone, email, memo, cash_receipt_no)
     VALUES (@kind, @name, @name, 1, @phone, @email, @memo, @cash_receipt_no)`
  );
  const markArtist = d.prepare(
    `UPDATE parties SET is_artist = 1,
       activity_name = COALESCE(NULLIF(TRIM(activity_name), ''), @activity_name),
       cash_receipt_no = COALESCE(cash_receipt_no, @cash_receipt_no) WHERE id = @id`
  );
  for (const c of d.prepare("SELECT * FROM clients").all()) {
    if (c.kind === "소속사/레이블" || c.kind === "제작사") {
      const info = insCompany.run({
        name: c.name, phone: c.phone || null, email: c.email || null, memo: c.memo || null,
        biz_no: c.biz_no || null, owner_name: c.owner_name || null, address: c.address || null, roles: c.roles || c.kind,
      });
      clientMap.set(c.id, info.lastInsertRowid);
    } else if (c.kind === "아티스트" && c.is_group) {
      const info = insArtistParty.run({
        kind: "group", name: c.name, phone: c.phone || null, email: c.email || null, memo: c.memo || null,
        cash_receipt_no: c.cash_receipt_no || null,
      });
      clientMap.set(c.id, info.lastInsertRowid);
    } else if (c.kind === "아티스트") {
      // 솔로 아티스트: source_contact_id 있으면 그 사람 party에 병합(중복 제거), 없으면 신규 person
      const pid = c.source_contact_id ? contactMap.get(c.source_contact_id) : null;
      if (pid) {
        markArtist.run({ id: pid, activity_name: c.name, cash_receipt_no: c.cash_receipt_no || null });
        clientMap.set(c.id, pid);
      } else {
        const info = insArtistParty.run({
          kind: "person", name: c.name, phone: c.phone || null, email: c.email || null, memo: c.memo || null,
          cash_receipt_no: c.cash_receipt_no || null,
        });
        clientMap.set(c.id, info.lastInsertRowid);
      }
    } else {
      // '기타'(담당자 셸 등): source_contact_id의 사람 party로 매핑(새 행 없음), 없으면 신규 person
      const pid = c.source_contact_id ? contactMap.get(c.source_contact_id) : null;
      if (pid) clientMap.set(c.id, pid);
      else clientMap.set(c.id, insPerson.run(personRow({ name: c.name, phone: c.phone, email: c.email, memo: c.memo })).lastInsertRowid);
    }
  }

  // 3) company owner_party_id(대표자 연동) ← clients.owner_contact_id
  const setOwner = d.prepare("UPDATE parties SET owner_party_id = ? WHERE id = ?");
  for (const c of d.prepare("SELECT id, owner_contact_id FROM clients WHERE owner_contact_id IS NOT NULL").all()) {
    const orgPid = clientMap.get(c.id);
    const ownerPid = contactMap.get(c.owner_contact_id);
    if (orgPid && ownerPid) setOwner.run(ownerPid, orgPid);
  }

  // 4) 소속 이력 이관: contact_affiliations → affiliations
  const insAff = d.prepare(
    `INSERT INTO affiliations (person_id, org_id, title, started_on, ended_on, memo, created_at)
     VALUES (@person_id, @org_id, @title, @started_on, @ended_on, @memo, @created_at)`
  );
  for (const a of d.prepare("SELECT * FROM contact_affiliations").all()) {
    const person = contactMap.get(a.contact_id);
    if (!person) continue;
    insAff.run({
      person_id: person, org_id: a.client_id ? clientMap.get(a.client_id) || null : null,
      title: a.title || null, started_on: a.started_on || null, ended_on: a.ended_on || null,
      memo: a.memo || null, created_at: a.created_at || null,
    });
  }

  // 5) 역할 FK 재배선(populate; 기존 컬럼 휴면 보존)
  const relink = (sql, rows, mapFn) => {
    const upd = d.prepare(sql);
    for (const r of rows) {
      const pid = mapFn(r);
      if (pid) upd.run(pid, r.id);
    }
  };
  relink("UPDATE invoices SET payer_id = ? WHERE id = ?", d.prepare("SELECT id, client_id FROM invoices WHERE client_id IS NOT NULL").all(), (r) => clientMap.get(r.client_id));
  relink("UPDATE projects SET contact_party_id = ? WHERE id = ?", d.prepare("SELECT id, contact_id FROM projects WHERE contact_id IS NOT NULL").all(), (r) => contactMap.get(r.contact_id));
  relink("UPDATE project_managers SET party_id = ? WHERE id = ?", d.prepare("SELECT id, contact_id FROM project_managers WHERE contact_id IS NOT NULL").all(), (r) => contactMap.get(r.contact_id));
  relink("UPDATE sessions SET director_party_id = ? WHERE id = ?", d.prepare("SELECT id, director_contact_id FROM sessions WHERE director_contact_id IS NOT NULL").all(), (r) => contactMap.get(r.director_contact_id));

  // projects.artist_id / agency_id / production_id ← artist/artist_company/production_company TEXT.
  //  project_clients_backfill_v1이 각 이름을 kind별 client로 등록했으므로 (name,kind)→client→party로 결정적 매핑.
  const artistByName = new Map();
  const companyByName = new Map();
  for (const c of d.prepare("SELECT id, name, kind FROM clients").all()) {
    const key = String(c.name || "").trim();
    if (!key) continue;
    if (c.kind === "아티스트") { if (!artistByName.has(key)) artistByName.set(key, clientMap.get(c.id)); }
    else companyByName.set(key + "|" + c.kind, clientMap.get(c.id));
  }
  const setArtist = d.prepare("UPDATE projects SET artist_id = ? WHERE id = ?");
  const setAgency = d.prepare("UPDATE projects SET agency_id = ? WHERE id = ?");
  const setProduction = d.prepare("UPDATE projects SET production_id = ? WHERE id = ?");
  for (const p of d.prepare("SELECT id, artist, artist_company, production_company FROM projects").all()) {
    const a = artistByName.get(String(p.artist || "").trim());
    const ag = companyByName.get(String(p.artist_company || "").trim() + "|소속사/레이블");
    const pr = companyByName.get(String(p.production_company || "").trim() + "|제작사");
    if (a) setArtist.run(a, p.id);
    if (ag) setAgency.run(ag, p.id);
    if (pr) setProduction.run(pr, p.id);
  }
  // session_directors.party_id ← contact_id (복합키라 별도). session_directors_party_v1 재구성 후엔 contact_id가 없으므로 방어.
  const sdHasContact = d.prepare("SELECT COUNT(*) AS n FROM pragma_table_info('session_directors') WHERE name = 'contact_id'").get().n;
  if (sdHasContact) {
    const setSd = d.prepare("UPDATE session_directors SET party_id = ? WHERE session_id = ? AND contact_id = ?");
    for (const sd of d.prepare("SELECT session_id, contact_id FROM session_directors").all()) {
      const pid = contactMap.get(sd.contact_id);
      if (pid) setSd.run(pid, sd.session_id, sd.contact_id);
    }
  }

  // 이관 리포트(관측성): orphan_payer는 0이어야 정상.
  const cnt = (sql) => d.prepare(sql).get().n;
  console.log(
    `[migrate party_model_v1] parties=${cnt("SELECT COUNT(*) n FROM parties")} ` +
      `person=${cnt("SELECT COUNT(*) n FROM parties WHERE kind='person'")} ` +
      `company=${cnt("SELECT COUNT(*) n FROM parties WHERE kind='company'")} ` +
      `group=${cnt("SELECT COUNT(*) n FROM parties WHERE kind='group'")} ` +
      `artist=${cnt("SELECT COUNT(*) n FROM parties WHERE is_artist=1")} ` +
      `affiliations=${cnt("SELECT COUNT(*) n FROM affiliations")} ` +
      `payer_mapped=${cnt("SELECT COUNT(*) n FROM invoices WHERE payer_id IS NOT NULL")} ` +
      `orphan_payer=${cnt("SELECT COUNT(*) n FROM invoices WHERE client_id IS NOT NULL AND payer_id IS NULL")}`
  );
}

/**
 * 레거시 정체성(clients/contacts) 최종 드롭 — party 이관 완료 후 잔재 제거.
 * 순서: 의존 인덱스 → FK 자식 컬럼(부모 참조 해제) → 레거시 테이블. 모두 존재검사로 멱등(부분 실패 후 재시도 안전).
 * FK 자식 컬럼을 먼저 없애야 부모 테이블 드롭 후 신규 INSERT가 'no such table: clients'로 깨지지 않는다(실증 검증).
 */
function dropLegacyIdentity(d) {
  const dropCol = (t, c) => { if (columnExists(t, c)) d.exec(`ALTER TABLE ${t} DROP COLUMN ${c}`); };
  ["idx_invoices_client", "idx_projects_client", "idx_users_client", "idx_contact_affiliations_contact", "idx_contact_affiliations_client"].forEach(
    (i) => d.exec(`DROP INDEX IF EXISTS ${i}`)
  );
  dropCol("invoices", "client_id");
  dropCol("projects", "client_id");
  dropCol("projects", "contact_id");
  dropCol("project_managers", "contact_id");
  dropCol("sessions", "director_contact_id");
  dropCol("users", "client_id");
  d.exec("DROP TABLE IF EXISTS contact_affiliations"); // clients/contacts 자식 → 먼저
  d.exec("DROP TABLE IF EXISTS contacts");
  d.exec("DROP TABLE IF EXISTS clients");
  console.log("[migrate legacy_drop_v1] 레거시 정체성 테이블·FK 컬럼 제거 완료");
}

// ── admin_state 키-값 헬퍼 ──
function getState(key) {
  const row = db().prepare("SELECT value FROM admin_state WHERE key = ?").get(key);
  return row ? row.value : null;
}
function setState(key, value) {
  db()
    .prepare(
      `INSERT INTO admin_state (key, value) VALUES (?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`
    )
    .run(key, value);
}

// ── AES-256-GCM at-rest 암호화(플레이북 §2.6). refresh token 등 비밀에 사용 ──
function encKey() {
  return crypto.createHash("sha256").update(String(config.tokenEncKey)).digest();
}

/** 평문 → base64(iv|tag|ciphertext). */
function encrypt(plaintext) {
  if (plaintext == null) return null;
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", encKey(), iv);
  const ct = Buffer.concat([cipher.update(String(plaintext), "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, ct]).toString("base64");
}

/** base64(iv|tag|ciphertext) → 평문. 실패 시 null. */
function decrypt(b64) {
  if (b64 == null) return null;
  try {
    const buf = Buffer.from(b64, "base64");
    const iv = buf.subarray(0, 12);
    const tag = buf.subarray(12, 28);
    const ct = buf.subarray(28);
    const decipher = crypto.createDecipheriv("aes-256-gcm", encKey(), iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ct), decipher.final()]).toString("utf8");
  } catch {
    return null;
  }
}

module.exports = {
  db,
  init,
  addColumn,
  getState,
  setState,
  encrypt,
  decrypt,
};
