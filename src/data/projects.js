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
      // 종일(all_day) 세션은 시간이 없지만 청구 후보이고 확정액도 가질 수 있다(sessionRateAmount와 동일 규칙:
      // 1 기준 블록으로 산정). 시간 필수 조건만 걸어 두면 종일 세션 금액이 프로젝트 예산에서 통째로 빠진다.
      `SELECT s.id, s.project_id, s.all_day, s.start_time, s.end_time, s.billing_amount,
              ri.base_minutes, ri.base_price, ri.extra_minutes, ri.extra_price
       FROM sessions s
       JOIN rate_items ri ON ri.id = s.rate_item_id
       WHERE s.project_id IN (${placeholders})
         AND s.session_type IN (${RENTAL_IN})
         AND s.rate_item_id IS NOT NULL
         AND (s.all_day = 1 OR (s.start_time IS NOT NULL AND s.end_time IS NOT NULL))
         AND s.status <> '취소'
         AND s.waived = 0
         AND NOT EXISTS (SELECT 1 FROM track_tasks tt WHERE tt.session_id = s.id)`
    )
    .all(...projectIds);
  for (const row of rows) {
    if (invoicedSids.has(row.id)) continue; // 청구 확정분은 ①에서 확정액으로 반영
    // 확정 청구액(청구 폼에서 고쳐 저장한 값)이 있으면 그것을, 없으면 단가표 산정치를 쓴다(2026-07-14).
    if (row.billing_amount != null) {
      sums[row.project_id] = (sums[row.project_id] || 0) + Math.round(row.billing_amount);
      continue;
    }
    const mins = row.all_day ? row.base_minutes || 0 : minutesBetween(row.start_time, row.end_time);
    if (!row.all_day && mins <= 0) continue;
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
  //  upcoming_cnt = 다가오는 세션(오늘 이후, **예정 상태만**) 존재.
  //    ⚠️ '완료'·'취소' 세션은 제외한다 — 오늘 녹음하고 완료로 눌러도 세션 날짜가 오늘이면
  //    '다가오는 세션'으로 잡혀 진행 중에 남던 버그(2026-07-15 사용자 리포트). 완료·취소는 끝난
  //    활동이므로 완료 판정을 막지 않는다. 지난 날짜의 예정 세션(오늘 이전)은 애초에 안 잡힘.
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
       WHERE s.project_id = p.id AND s.session_date >= @today AND s.status = '예정') AS upcoming_cnt,
      (SELECT MIN(s.session_date) FROM sessions s
       WHERE s.project_id = p.id AND s.session_date >= @today AND s.status = '예정') AS next_session_date,
      (SELECT COUNT(*) FROM sessions s WHERE s.project_id = p.id AND s.status = '예정') AS sess_scheduled,
      (SELECT COUNT(*) FROM sessions s WHERE s.project_id = p.id AND s.status = '완료') AS sess_done,
      -- 세션 총수(취소 포함) — 목록 카드 진입 탭 결정용(세션 있으면 세션 일정, 없고 곡만 있으면 곡·콘텐츠).
      (SELECT COUNT(*) FROM sessions s WHERE s.project_id = p.id) AS sess_cnt,
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
  for (const id of ids) out[id] = { sessions: [], tracks: [] };
  const sessions = db()
    .prepare(
      `SELECT id, project_id, session_date, start_time, end_time, session_type, status
       FROM sessions WHERE project_id IN (${ph}) AND status <> '취소'
       ORDER BY session_date ASC, start_time ASC, id ASC`
    )
    .all(...ids);
  for (const s of sessions) if (out[s.project_id]) out[s.project_id].sessions.push(s);
  const taskRows = db()
    .prepare(
      `SELECT tr.project_id, tr.id AS track_id, tr.title, tr.artist,
              t.id AS task_id, t.status AS task_status, t.engineer_name,
              COALESCE(NULLIF(tt.label, ''), t.task_type) AS type_label
       FROM project_tracks tr
       LEFT JOIN track_tasks t ON t.track_id = tr.id
       LEFT JOIN task_types tt ON tt.key = t.task_type
       WHERE tr.project_id IN (${ph})
       ORDER BY tr.created_at ASC, tr.id ASC, t.created_at ASC, t.id ASC`
    )
    .all(...ids);
  const trackMap = {};
  for (const r of taskRows) {
    let tk = trackMap[r.track_id];
    if (!tk) {
      tk = { id: r.track_id, title: r.title, artist: r.artist, engineers: [], tasks: [] };
      trackMap[r.track_id] = tk;
      if (out[r.project_id]) out[r.project_id].tracks.push(tk);
    }
    if (r.engineer_name && !tk.engineers.includes(r.engineer_name)) tk.engineers.push(r.engineer_name);
    if (r.task_id) tk.tasks.push({ id: r.task_id, label: r.type_label, status: r.task_status }); // 목록 펼침에서 작업 단위 완료 토글용
  }
  // (작업 종류별 집계 typeRows는 2026-07-11 제거 — 펼침이 이제 작업을 개별 표시하므로 aggregate 요약 불필요.)
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

// ── 프로젝트 고객측 담당자 다대다(2026-07-11 — 콤마로 여러 명, project_artists 패턴) ── contact_party_id=첫(대표), 전체=project_contacts.

/** 프로젝트 담당자 목록을 통째로 교체(project_artists 패턴). ids=party id 배열(dedup·falsy 제거·순서 보존). */
function setProjectContacts(projectId, ids) {
  const pid = Number(projectId);
  const d = db();
  d.prepare("DELETE FROM project_contacts WHERE project_id = ?").run(pid);
  const ins = d.prepare("INSERT OR IGNORE INTO project_contacts (project_id, party_id) VALUES (?, ?)");
  const seen = new Set();
  for (const id of ids || []) {
    const n = Number(id);
    if (!n || seen.has(n)) continue;
    seen.add(n);
    ins.run(pid, n);
  }
}

/** 프로젝트의 담당자 party 목록(등록 순서) — personCombo(multi) 칩 프리필용. */
function listProjectContacts(projectId) {
  return db()
    .prepare(
      `SELECT p.* FROM project_contacts pc JOIN parties p ON p.id = pc.party_id
        WHERE pc.project_id = ? ORDER BY pc.created_at, p.name COLLATE NOCASE`
    )
    .all(Number(projectId));
}

/**
 * 담당자(project_managers.id)가 '관여한' 프로젝트 id 집합(2026-07-12 — '내 프로젝트만' 필터).
 * 관여 = PM(projects.manager_id) OR 담당 세션(session_engineers) OR 담당 작업(track_tasks.engineer_id).
 * 한 쿼리(UNION)로 id만 뽑아 Set 반환 — 라우트가 listProjects 결과를 이 집합으로 거른다(listProjects 무변경).
 */
function listProjectIdsForManager(managerId) {
  const mid = Number(managerId);
  if (!mid) return new Set();
  const rows = db()
    .prepare(
      `SELECT id AS project_id FROM projects WHERE manager_id = @mid
       UNION SELECT s.project_id FROM session_engineers se JOIN sessions s ON s.id = se.session_id WHERE se.manager_id = @mid
       UNION SELECT tr.project_id FROM track_tasks t JOIN project_tracks tr ON tr.id = t.track_id WHERE t.engineer_id = @mid`
    )
    .all({ mid });
  return new Set(rows.map((r) => r.project_id));
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
  // 프로젝트 삭제는 트랙·작업·세션·배정을 CASCADE로 쓸어간다 — 이미 이체한 지급 기록이 남아 있으면 거부.
  const paidTask = db()
    .prepare("SELECT 1 FROM track_tasks t JOIN project_tracks tr ON tr.id = t.track_id WHERE tr.project_id = ? AND t.worker_paid = 1 LIMIT 1")
    .get(pid);
  const paidSession = db()
    .prepare("SELECT 1 FROM session_engineers se JOIN sessions s ON s.id = se.session_id WHERE s.project_id = ? AND se.worker_paid = 1 LIMIT 1")
    .get(pid);
  if (paidTask || paidSession) throw new Error("PAYOUT_LOCKED");
  db().prepare("DELETE FROM projects WHERE id = ?").run(pid);
}

module.exports = {
  distinctProjectFields,
  listProjects,
  listProjectSummaries,
  getProjectForUser,
  setProjectArtists,
  listProjectArtists,
  setProjectContacts,
  listProjectContacts,
  splitProjectTabs,
  listProjectIdsForManager,
  deleteProject,
};
