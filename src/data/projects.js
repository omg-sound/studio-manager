"use strict";

/**
 * 프로젝트 도메인 — 목록·단건 조회·자동완성 필드. (생성/수정은 라우트에서 직접 처리, 삭제는 tracks 도메인.)
 * data.js에서 분리한 모듈(도메인 모듈화). data.js가 재export하므로 소비자 무변경.
 *
 * cross-domain: sessionAmountsByProject가 computeRatePrice(rate-items)를 호출한다.
 * rate-items는 projects를 호출하지 않으므로(무순환) ./rate-items를 직접 require한다.
 * sessionAmountsByProject는 내부 헬퍼(공개 API 미노출). getProjectForUser는 다수 도메인이 공유.
 */

const { db } = require("../db");
const { minutesBetween, todayYmd } = require("../lib/date");
const { computeRatePrice } = require("./rate-items"); // 무순환(rate-items는 projects를 호출하지 않음)
const { RENTAL_SESSION_TYPES } = require("../config");
const RENTAL_IN = RENTAL_SESSION_TYPES.map((t) => `'${t}'`).join(", "); // SQL IN절(정적 config 값 — 인젝션 무관)

/** 프로젝트 폼 자동완성용 — 기존 프로젝트의 아티스트·소속사/레이블·제작사 중복 제거 목록. */
function distinctProjectFields() {
  const col = (c) =>
    db()
      .prepare(`SELECT DISTINCT ${c} AS v FROM projects WHERE ${c} IS NOT NULL AND TRIM(${c}) <> '' ORDER BY ${c} COLLATE NOCASE`)
      .all()
      .map((r) => r.v);
  return { artists: col("artist"), companies: col("artist_company"), productions: col("production_company") };
}

/** 프로젝트 ID 배열의 녹음 세션 금액 합계 맵(단가표 산정, 취소 제외). 내부 헬퍼. */
function sessionAmountsByProject(projectIds) {
  if (!projectIds || !projectIds.length) return {};
  const placeholders = projectIds.map(() => "?").join(",");
  const sums = {};
  // ① 청구가 확정된(청구서에 걸린) 세션 = 협의 끝 → invoice_items의 확정 청구액 우선(예상 단가 산정 대신). 사용자 요청.
  const invoiced = db()
    .prepare(
      `SELECT s.project_id AS pid, ii.session_id AS sid, SUM(ii.amount) AS amt
       FROM invoice_items ii
       JOIN sessions s ON s.id = ii.session_id
       WHERE s.project_id IN (${placeholders}) AND ii.session_id IS NOT NULL
       GROUP BY ii.session_id`
    )
    .all(...projectIds);
  const invoicedSids = new Set();
  for (const r of invoiced) {
    invoicedSids.add(r.sid);
    sums[r.pid] = (sums[r.pid] || 0) + (r.amt || 0);
  }
  // ② 미청구 녹음 세션 = 예상 청구액(단가표 자동 산정).
  const rows = db()
    .prepare(
      `SELECT s.id, s.project_id, s.start_time, s.end_time,
              ri.base_minutes, ri.base_price, ri.extra_minutes, ri.extra_price
       FROM sessions s
       JOIN rate_items ri ON ri.id = s.rate_item_id
       WHERE s.project_id IN (${placeholders})
         AND s.session_type IN (${RENTAL_IN})
         AND s.rate_item_id IS NOT NULL
         AND s.start_time IS NOT NULL AND s.end_time IS NOT NULL
         AND s.status <> '취소'
         AND s.waived = 0`
    )
    .all(...projectIds);
  for (const row of rows) {
    if (invoicedSids.has(row.id)) continue; // 청구 확정분은 ①에서 확정액으로 반영
    const mins = minutesBetween(row.start_time, row.end_time);
    if (mins <= 0) continue;
    sums[row.project_id] = (sums[row.project_id] || 0) + computeRatePrice(row, mins);
  }
  return sums;
}

// 라우트는 filters 객체(service/clientId/q)를 넘기지만 목록 UI는 검색(q)만 사용 → q만 처리(나머지 인자는 무시).
function listProjects(_user, { q } = {}) {
  const where = [];
  const params = { today: todayYmd() };

  if (q) {
    // 제목·아티스트 외 소속사/레이블·제작사·메모·청구처(c.name)·담당 엔지니어(m.name)까지 검색.
    where.push(
      "(p.title LIKE @q OR p.artist LIKE @q OR p.artist_company LIKE @q OR p.production_company LIKE @q OR p.memo LIKE @q OR c.name LIKE @q OR m.name LIKE @q)"
    );
    params.q = `%${q}%`;
  }

  // 완료/진행 판정 신호:
  //  has_upcoming = 다가오는 세션(오늘 이후, 취소 제외) 존재
  //  open_tasks   = 미완료 작업(status <> 'Completed') 수 = 대기
  //  content_cnt  = 세션+작업 총량(0이면 아직 아무 내용 없는 빈 프로젝트) → 진행 중으로 취급
  const sql = `
    SELECT p.*, c.name AS client_name, m.name AS manager_name,
      (SELECT GROUP_CONCAT(tr.title, '||') FROM project_tracks tr WHERE tr.project_id = p.id) AS track_titles,
      (SELECT COALESCE(SUM(COALESCE(NULLIF(t.total_price, 0), tt.unit_price, 0)), 0)
       FROM track_tasks t
       JOIN project_tracks tr ON tr.id = t.track_id
       LEFT JOIN task_types tt ON tt.key = t.task_type
       WHERE tr.project_id = p.id AND t.waived = 0) AS task_total,
      (SELECT COUNT(*) FROM sessions s
       WHERE s.project_id = p.id AND s.session_date >= @today AND s.status <> '취소') AS upcoming_cnt,
      (SELECT MIN(s.session_date) FROM sessions s
       WHERE s.project_id = p.id AND s.session_date >= @today AND s.status <> '취소') AS next_session_date,
      (SELECT COUNT(*) FROM sessions s WHERE s.project_id = p.id AND s.status = '예정') AS sess_scheduled,
      (SELECT COUNT(*) FROM sessions s WHERE s.project_id = p.id AND s.status = '완료') AS sess_done,
      (SELECT COUNT(*) FROM track_tasks t
       JOIN project_tracks tr ON tr.id = t.track_id
       WHERE tr.project_id = p.id AND t.status <> 'Completed') AS open_tasks,
      (SELECT COUNT(*) FROM track_tasks t JOIN project_tracks tr ON tr.id = t.track_id WHERE tr.project_id = p.id) AS task_cnt,
      (SELECT COUNT(*) FROM track_tasks t JOIN project_tracks tr ON tr.id = t.track_id WHERE tr.project_id = p.id AND t.status = 'Pending') AS task_pending,
      (SELECT COUNT(*) FROM track_tasks t JOIN project_tracks tr ON tr.id = t.track_id WHERE tr.project_id = p.id AND t.status = 'Completed') AS task_done,
      ((SELECT COUNT(*) FROM sessions s WHERE s.project_id = p.id)
       + (SELECT COUNT(*) FROM track_tasks t JOIN project_tracks tr ON tr.id = t.track_id WHERE tr.project_id = p.id)) AS content_cnt,
      -- 미청구 항목 수 = 미청구 작업 + 미청구 청구가능 세션(listBillableSessionsForProject와 동일 조건).
      -- 완료 탭에서 '청구 생성 안 한 프로젝트'를 위로 올리는 정렬·배지용(2026-07-05 사용자 요청).
      -- 청구 안 함(waived) 처리한 항목은 더 이상 '필요'하지 않으므로 제외(2026-07-06 사용자 요청).
      ((SELECT COUNT(*) FROM track_tasks t JOIN project_tracks tr ON tr.id = t.track_id
         WHERE tr.project_id = p.id AND t.is_invoiced = 0 AND t.waived = 0)
       + (SELECT COUNT(*) FROM sessions s
           WHERE s.project_id = p.id AND s.status <> '취소' AND s.session_type IN (${RENTAL_IN})
             AND s.rate_item_id IS NOT NULL AND (s.all_day = 1 OR (s.start_time IS NOT NULL AND s.end_time IS NOT NULL))
             AND s.waived = 0
             AND NOT EXISTS (SELECT 1 FROM invoice_items ii WHERE ii.session_id = s.id)
             AND NOT EXISTS (SELECT 1 FROM track_tasks tt WHERE tt.session_id = s.id))) AS unbilled_cnt,
      -- 청구서 단위 할인 합계 — 작업·세션이 연결된(from-tasks) 청구서만. 수동 청구서 라인은 프로젝트 버짓에
      -- 안 잡히므로 그 할인을 빼면 이중 차감이 된다. 목록·상세 금액 표시에서 확정 라인 합계에서 차감(2026-07-05).
      (SELECT COALESCE(SUM(i.discount_amount), 0) FROM invoices i
        WHERE i.project_id = p.id
          AND EXISTS (SELECT 1 FROM invoice_items ii WHERE ii.invoice_id = i.id
                        AND (ii.task_id IS NOT NULL OR ii.session_id IS NOT NULL))) AS invoice_discount_total
    FROM projects p
    LEFT JOIN parties c ON c.id = COALESCE(p.production_id, p.agency_id, p.artist_id)
    LEFT JOIN project_managers m ON m.id = p.manager_id
    ${where.length ? "WHERE " + where.join(" AND ") : ""}
    ORDER BY
      -- 생성일 순(최신 생성이 위, 2026-07-04 사용자 요청). 동일 생성일은 id 역순으로 안정 정렬.
      p.created_at DESC, p.id DESC`;
  const rows = db().prepare(sql).all(params);
  if (!rows.length) return rows;
  const sessionAmounts = sessionAmountsByProject(rows.map((r) => r.id));
  return rows.map((r) => ({
    ...r,
    session_amount_total: sessionAmounts[r.id] || 0,
    // 완료 = 실제 활동이 있었고(content_cnt>0) 다가오는 세션 없음 + 미완료 작업 없음.
    is_completed: r.content_cnt > 0 && r.upcoming_cnt === 0 && r.open_tasks === 0,
  }));
}

/** 단건 조회 + 권한 검사. 권한 없으면 null(클라이언트가 타 프로젝트 접근 시도 시 404 처리용). */
function getProjectForUser(user, id) {
  const row = db()
    .prepare(
      `SELECT p.*, c.name AS client_name, m.name AS manager_name, ct.name AS contact_name, ct.phone AS contact_phone, tr_sum.track_titles, task_sum.task_total,
         (SELECT COALESCE(SUM(i.discount_amount), 0) FROM invoices i
           WHERE i.project_id = p.id
             AND EXISTS (SELECT 1 FROM invoice_items ii WHERE ii.invoice_id = i.id
                           AND (ii.task_id IS NOT NULL OR ii.session_id IS NOT NULL))) AS invoice_discount_total
       FROM projects p
       LEFT JOIN parties c ON c.id = COALESCE(p.production_id, p.agency_id, p.artist_id)
       LEFT JOIN project_managers m ON m.id = p.manager_id
       LEFT JOIN parties ct ON ct.id = p.contact_party_id
       LEFT JOIN (
         SELECT project_id, GROUP_CONCAT(title, '||') AS track_titles
         FROM project_tracks
         GROUP BY project_id
       ) tr_sum ON tr_sum.project_id = p.id
       LEFT JOIN (
         SELECT tr.project_id, COALESCE(SUM(COALESCE(NULLIF(t.total_price, 0), tt.unit_price, 0)), 0) AS task_total
         FROM project_tracks tr
         LEFT JOIN track_tasks t ON t.track_id = tr.id AND t.waived = 0
         LEFT JOIN task_types tt ON tt.key = t.task_type
         GROUP BY tr.project_id
       ) task_sum ON task_sum.project_id = p.id
       WHERE p.id = ?`
    )
    .get(id);
  if (!row) return null;
  const sessionAmounts = sessionAmountsByProject([row.id]);
  return { ...row, session_amount_total: sessionAmounts[row.id] || 0 };
}

/**
 * 프로젝트 목록 인라인 요약(펼침용) — 여러 프로젝트를 **배치 2쿼리**로 한 번에(N+1 회피).
 * 반환: { [projectId]: { sessions:[{session_date,start_time,end_time,session_type,status}],
 *                        tracks:[{id,title,artist,engineers:[이름...]}] } }.
 * 세션은 취소 제외·날짜순, 트랙은 작성순 + 작업자(engineer_name) 중복 제거.
 */
function listProjectSummaries(projectIds) {
  const ids = (projectIds || []).map(Number).filter(Boolean);
  if (!ids.length) return {};
  const ph = ids.map(() => "?").join(",");
  const out = {};
  for (const id of ids) out[id] = { sessions: [], tracks: [], taskTypes: [] };
  const sessions = db()
    .prepare(
      `SELECT project_id, session_date, start_time, end_time, session_type, status
       FROM sessions WHERE project_id IN (${ph}) AND status <> '취소'
       ORDER BY session_date ASC, start_time ASC, id ASC`
    )
    .all(...ids);
  for (const s of sessions) if (out[s.project_id]) out[s.project_id].sessions.push(s);
  const taskRows = db()
    .prepare(
      `SELECT tr.project_id, tr.id AS track_id, tr.title, tr.artist, t.engineer_name
       FROM project_tracks tr
       LEFT JOIN track_tasks t ON t.track_id = tr.id
       WHERE tr.project_id IN (${ph})
       ORDER BY tr.created_at ASC, tr.id ASC, t.created_at ASC, t.id ASC`
    )
    .all(...ids);
  const trackMap = {};
  for (const r of taskRows) {
    let tk = trackMap[r.track_id];
    if (!tk) {
      tk = { id: r.track_id, title: r.title, artist: r.artist, engineers: [] };
      trackMap[r.track_id] = tk;
      if (out[r.project_id]) out[r.project_id].tracks.push(tk);
    }
    if (r.engineer_name && !tk.engineers.includes(r.engineer_name)) tk.engineers.push(r.engineer_name);
  }
  // 작업 종류별 집계(펼침 요약 '튠 1 · 믹싱 1 · 마스터링 1'). 라벨은 task_types JOIN(삭제 종류는 key 폴백).
  const typeRows = db()
    .prepare(
      `SELECT tr.project_id, COALESCE(NULLIF(tt.label, ''), t.task_type) AS type_label, COUNT(*) AS cnt
       FROM track_tasks t
       JOIN project_tracks tr ON tr.id = t.track_id
       LEFT JOIN task_types tt ON tt.key = t.task_type
       WHERE tr.project_id IN (${ph})
       GROUP BY tr.project_id, t.task_type
       ORDER BY tr.project_id, MIN(t.created_at), MIN(t.id)`
    )
    .all(...ids);
  for (const r of typeRows) if (out[r.project_id]) out[r.project_id].taskTypes.push({ label: r.type_label, count: r.cnt });
  return out;
}

/**
 * 목록 rows를 진행 중(active)/청구 필요(billing)/완료(done) 3그룹으로 분류.
 *  - active  = !is_completed. 다가오는 세션 임박순(next_session_date ASC, 없으면 뒤로, 동률은 입력 순서=SQL created_at DESC 유지).
 *  - billing = is_completed && unbilled_cnt>0 (활동 끝났는데 미청구 — 지금 처리할 액션).
 *  - done    = is_completed && unbilled_cnt===0 (청구까지 끝난 아카이브).
 * Array.sort는 Node에서 안정 정렬이라 동률/양쪽 세션 없음은 SQL 순서를 보존한다.
 */
function splitProjectTabs(rows) {
  const list = rows || [];
  const active = list.filter((r) => !r.is_completed);
  const billing = list.filter((r) => r.is_completed && Number(r.unbilled_cnt) > 0);
  const done = list.filter((r) => r.is_completed && Number(r.unbilled_cnt) === 0);
  active.sort((a, b) => {
    const ad = a.next_session_date || "";
    const bd = b.next_session_date || "";
    if (ad && bd) return ad < bd ? -1 : ad > bd ? 1 : 0;
    if (ad) return -1; // a만 다가오는 세션 있음 → 앞
    if (bd) return 1;  // b만 있음 → a 뒤로
    return 0;          // 둘 다 없음 → 입력 순서 유지
  });
  return { active, billing, done };
}

// ── 프로젝트 아티스트 다대다(2026-07-05 — 콤마로 여러 명) ── artist TEXT=콤마 표시 목록, artist_id=첫(대표), 전체=project_artists.

/** 프로젝트 아티스트 목록을 통째로 교체(session_directors 패턴). ids=party id 배열(dedup·falsy 제거). */
function setProjectArtists(projectId, ids) {
  const pid = Number(projectId);
  const d = db();
  d.prepare("DELETE FROM project_artists WHERE project_id = ?").run(pid);
  const ins = d.prepare("INSERT OR IGNORE INTO project_artists (project_id, party_id) VALUES (?, ?)");
  const seen = new Set();
  for (const id of ids || []) {
    const n = Number(id);
    if (!n || seen.has(n)) continue;
    seen.add(n);
    ins.run(pid, n);
  }
}

/** 프로젝트의 아티스트 party 목록(등록 순서). */
function listProjectArtists(projectId) {
  return db()
    .prepare(
      `SELECT p.* FROM project_artists pa JOIN parties p ON p.id = pa.party_id
        WHERE pa.project_id = ? ORDER BY pa.created_at, p.name COLLATE NOCASE`
    )
    .all(Number(projectId));
}

/** 프로젝트 삭제. 청구된 작업·세션이 있으면 거부(매출 추적 보존, deleteTrack과 정합). */
function deleteProject(projectId) {
  const pid = Number(projectId);
  const invoicedTask = db()
    .prepare("SELECT 1 FROM track_tasks t JOIN project_tracks tr ON tr.id = t.track_id WHERE tr.project_id = ? AND t.is_invoiced = 1 LIMIT 1")
    .get(pid);
  const invoicedSession = db()
    .prepare("SELECT 1 FROM invoice_items ii JOIN sessions s ON s.id = ii.session_id WHERE s.project_id = ? LIMIT 1")
    .get(pid);
  if (invoicedTask || invoicedSession) throw new Error("PROJECT_HAS_INVOICED");
  db().prepare("DELETE FROM projects WHERE id = ?").run(pid);
}

module.exports = {
  distinctProjectFields,
  listProjects,
  listProjectSummaries,
  getProjectForUser,
  setProjectArtists,
  listProjectArtists,
  splitProjectTabs,
  deleteProject,
};
