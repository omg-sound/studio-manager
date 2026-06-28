"use strict";

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { config } = require("./config");
const { openDatabase } = require("./sqlite");

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
      client_id     INTEGER REFERENCES clients(id) ON DELETE SET NULL,
      created_at    TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS clients (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      name       TEXT NOT NULL,
      kind       TEXT NOT NULL DEFAULT '아티스트',
      phone      TEXT,
      email      TEXT,
      memo       TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS projects (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      title      TEXT NOT NULL,
      artist     TEXT,
      artist_company TEXT,
      production_company TEXT,
      client_id  INTEGER REFERENCES clients(id) ON DELETE SET NULL,
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
      status        TEXT NOT NULL DEFAULT 'Pending', -- Pending | In_Progress | Completed
      is_invoiced   INTEGER NOT NULL DEFAULT 0,
      invoice_id    INTEGER REFERENCES invoices(id) ON DELETE SET NULL,
      created_at    TEXT NOT NULL DEFAULT (datetime('now'))
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
      client_id   INTEGER REFERENCES clients(id) ON DELETE SET NULL,
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

    -- 앱 전역 상태(키-값): drive folder_id 캐시, refresh token(암호화), 테마 등.
    CREATE TABLE IF NOT EXISTS admin_state (
      key   TEXT PRIMARY KEY,
      value TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_projects_client ON projects(client_id);
    CREATE INDEX IF NOT EXISTS idx_users_client ON users(client_id);
    CREATE INDEX IF NOT EXISTS idx_project_service_items_active ON project_service_items(active, label);
    CREATE INDEX IF NOT EXISTS idx_rate_items_active ON rate_items(active, name);
    CREATE INDEX IF NOT EXISTS idx_project_tracks_project ON project_tracks(project_id);
    CREATE INDEX IF NOT EXISTS idx_track_tasks_track ON track_tasks(track_id);
    CREATE INDEX IF NOT EXISTS idx_track_tasks_invoice ON track_tasks(invoice_id, is_invoiced);
    CREATE INDEX IF NOT EXISTS idx_sessions_project ON sessions(project_id);
    CREATE INDEX IF NOT EXISTS idx_sessions_date ON sessions(session_date);
    CREATE INDEX IF NOT EXISTS idx_deliverables_project ON deliverables(project_id);
    CREATE INDEX IF NOT EXISTS idx_deliverables_token ON deliverables(access_token);
    CREATE INDEX IF NOT EXISTS idx_invoices_client ON invoices(client_id);
    CREATE INDEX IF NOT EXISTS idx_invoices_project ON invoices(project_id);
    CREATE INDEX IF NOT EXISTS idx_invoices_status ON invoices(status);
    CREATE INDEX IF NOT EXISTS idx_invoice_items_invoice ON invoice_items(invoice_id);
    CREATE INDEX IF NOT EXISTS idx_invoice_items_task ON invoice_items(task_id);
  `);

  addColumn("users", "active", "INTEGER NOT NULL DEFAULT 1");
  // 실결제자(공급받는 자) 세금계산서 정보
  addColumn("clients", "biz_no", "TEXT");      // 사업자등록번호
  addColumn("clients", "owner_name", "TEXT");  // 대표자명
  addColumn("clients", "address", "TEXT");     // 사업장 주소
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
  addColumn("projects", "project_type", "TEXT"); // recording | mixing (null=기존, 믹스 흐름)
  addColumn("projects", "services", "TEXT");
  addColumn("projects", "artist", "TEXT");
  addColumn("projects", "artist_company", "TEXT");
  addColumn("projects", "production_company", "TEXT");
  addColumn("projects", "manager_id", "INTEGER REFERENCES project_managers(id) ON DELETE SET NULL");
  addColumn("invoices", "invoice_number", "TEXT");
  addColumn("invoices", "tax_amount", "INTEGER NOT NULL DEFAULT 0");
  addColumn("rate_items", "category", "TEXT NOT NULL DEFAULT '스튜디오 녹음'"); // 단가표(녹음 종류) 분류: 스튜디오 녹음 | 로케이션 녹음
  addColumn("sessions", "rate_item_id", "INTEGER REFERENCES rate_items(id) ON DELETE SET NULL"); // 녹음 세션 시간제 단가표 연결
  addColumn("project_managers", "user_id", "INTEGER REFERENCES users(id) ON DELETE SET NULL"); // 하우스 엔지니어(로그인 사용자)와 링크. null=외주 작업자
  addColumn("sessions", "booker_name", "TEXT"); // 예약 담당자(담당자 마스터에서 선택, 담당 엔지니어와 별개)
  addColumn("sessions", "gcal_event_id", "TEXT"); // 예약 시 자동 생성한 구글 캘린더 일정 id(수정·삭제 추적)
  addColumn("track_tasks", "session_id", "INTEGER REFERENCES sessions(id) ON DELETE SET NULL"); // 세션에서 생성된 청구 작업 추적
  d.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_invoices_invoice_number ON invoices(invoice_number);");
  d.exec("CREATE INDEX IF NOT EXISTS idx_projects_manager ON projects(manager_id);");
  // 세션당 청구 작업 1건만(부분 유니크: NULL은 다중 허용). 중복 청구 방어 심층.
  d.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_track_tasks_session ON track_tasks(session_id) WHERE session_id IS NOT NULL;");
  seedDefaultCatalogs();
  // 레거시 마이그레이션은 1회만. 신규 프로젝트(project_type 있음)는 services=NULL이 정상이므로,
  // 매 부팅 재실행되면 memo 추론으로 유령 곡·작업을 주입한다 → admin_state 플래그로 1회 게이트.
  if (!getState("legacy_backfill_v1")) {
    backfillProjectServices();
    backfillLegacyServicesToTracks();
    setState("legacy_backfill_v1", "done");
  }
  // 기존 프로젝트의 아티스트·소속사/레이블·제작사를 클라이언트 마스터에 1회 백필. 이후는 프로젝트 저장 시 자동 등록.
  if (!getState("project_clients_backfill_v1")) {
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

  // ── 후속 단계 테이블 자리(스키마만; 아직 미사용) ──
  // sessions(project_id, kind, session_date, hours, done)
  // invoice_items / payments (라인아이템·입금 이력 분리가 필요해지면)

  return d;
}

function seedDefaultCatalogs() {
  const d = db();
  const services = [
    ["recording", "녹음"],
    ["vocal_tune", "보컬튠"],
    ["mixing", "믹싱"],
    ["mastering", "마스터링"],
  ];
  const upsertService = d.prepare(
    `INSERT INTO project_service_items (key, label, active) VALUES (?, ?, 1)
     ON CONFLICT(key) DO UPDATE SET label = excluded.label`
  );
  for (const [key, label] of services) upsertService.run(key, label);

  const hasManager = d.prepare("SELECT id FROM project_managers LIMIT 1").get();
  if (!hasManager) {
    d.prepare("INSERT INTO project_managers (name, active) VALUES (?, 1)").run("스튜디오 관리자");
  }
}

/** 멱등 컬럼 추가: 이미 있으면 무시(플레이북 §2.8). */
function addColumn(table, column, typeSql) {
  try {
    db().exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${typeSql}`);
  } catch (e) {
    if (!/duplicate column name/i.test(e.message)) throw e;
  }
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
