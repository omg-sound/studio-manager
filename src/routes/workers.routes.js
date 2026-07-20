"use strict";

const fs = require("fs");
const express = require("express");
const { db, encrypt, decrypt } = require("../db");
const { requireInvoice, requireChief, isChief } = require("../auth");
const {
  listProjectManagers, getWorker, listTasksForWorker, listSessionsForWorker, setTaskPayout, taskTypeLabel, syncManagerToParty, ensurePartyForManager, formatPhone,
  listWorkerFiles, getWorkerFile, upsertWorkerFile, deleteWorkerFile,
  listSessionPayoutsForWorker, setSessionEngineerPayout, workerPayoutSummary,
} = require("../data");
const storage = require("../storage");
const { asyncHandler } = require("../lib/async");
const { logAudit } = require("../lib/audit"); // 파괴적·재무 액션 기록(fail-safe)
const { buildUpload, decodeName, detectMimeFromFile } = require("../lib/attachments"); // 첨부 보안 로직 공용(2026-07-09 통합)
const { layout, pageHeader, esc, flashBanner, emptyState, errorPage, formatKRW, tabBar, explain, fileViewerPage, copyable, dirtyActionRow, dateCombo } = require("../views");
const { contactPanes } = require("../views.contacts"); // 2단 골격 공용(연락처·업체·매출과 동일)
const { workerNameList, workerPayoutCard, workerEmptyPane } = require("../views.workers");
const { safePath } = require("../lib/nav");
const { TASK_STATUS_LABELS, TASK_STATUS_BADGE, SESSION_STATUS_BADGE } = require("../config");
const { formatYmdShort, todayYmd, isValidYmd, kstYmd } = require("../lib/date");
const { withholding33 } = require("../lib/tax"); // 외주 원천징수 3.3% 표시(2026-07-09 사용자 요청)

const router = express.Router();
// 권한 분리(2026-07-03, 사용자 결정): 열람·상세·정산(지급 처리/취소) = 치프·대표(requireInvoice, 재무 성격),
// 마스터(추가·삭제·정보수정) = 치프(requireChief). 스태프는 /workers 미노출 — 외주 지급단가(worker_rate)는
// 작업 편집(requireEditor)에서 입력하고, 실제 지급/정산은 대표·치프가 이 화면에서 실행한다.

// 첨부 서류 업로드(2026-07-06, clients.routes와 동일 패턴 — 디스크 multer + 매직바이트 검증).
const upload = buildUpload("omgwf_"); // 공용 첨부 업로더(lib/attachments — 매직바이트·한도 정책 단일화)

/** 첨부 서류 종류 목록(화이트리스트) — 주민등록증 사본·통장사본(2026-07-06 사용자 요청, 외주 정산·본인확인용). */
const FILE_KINDS = [
  { key: "id_card", label: "주민등록증 사본" },
  { key: "bankbook", label: "통장사본" },
];

/** 첨부 서류 업로드·교체 UI(clients.routes의 clientFileSection과 동일 구조). */
function workerFileSection(w, fileMap, fileErr, fileOk = {}) {
  const rows = FILE_KINDS.map(({ key, label }) => {
    const existing = fileMap[key];
    const ok = existing && fileOk[key] !== false;
    const backendTag = existing
      ? (existing.storage_backend === "drive" ? `<span class="text-xs text-muted">Drive</span>` : `<span class="text-xs text-warning" title="Drive 업로드 실패로 로컬(서버 디스크)에 저장됨">로컬 저장</span>`)
      : "";
    const existingRow = existing && ok
      ? `<div class="mb-2 flex flex-wrap items-center gap-3 text-sm">
            <a href="/workers/${w.id}/files/${key}/view" target="_blank" rel="noopener" data-popup-view class="font-medium text-primary hover:underline">${esc(label)} 보기</a>
            <span class="max-w-[12rem] truncate text-xs text-muted">${esc(existing.file_name)}</span>
            ${backendTag}
            <form method="post" action="/workers/${w.id}/files/${key}/delete" class="inline" data-confirm="${esc(label)}을 삭제할까요?">
              <button class="text-xs text-danger hover:underline" type="submit">삭제</button>
            </form>
          </div>`
      : existing && !ok
        ? `<div class="mb-2 flex flex-wrap items-center gap-3 text-sm">
            <span class="text-danger">⚠️ 파일을 찾을 수 없습니다</span>
            <span class="max-w-[12rem] truncate text-xs text-muted">${esc(existing.file_name)}</span>
            <form method="post" action="/workers/${w.id}/files/${key}/delete" class="inline" data-confirm="깨진 첨부 기록을 지울까요?">
              <button class="text-xs text-danger hover:underline" type="submit">기록 삭제</button>
            </form>
          </div>`
        : "";
    return `
    <div>
      <label class="label">${esc(label)}</label>
      ${existingRow}
      <form enctype="multipart/form-data" method="post" action="/workers/${w.id}/files/${key}" class="flex items-center gap-2">
        <div class="flex-1" data-dropzone>
          <input type="file" name="file" accept="image/png,image/jpeg,application/pdf" class="sr-only" />
          <div class="input flex cursor-pointer select-none items-center py-2 text-sm text-muted" data-dropzone-display tabindex="0" role="button" aria-label="파일 찾기 또는 붙여넣기(Ctrl+V)">
            <span data-dropzone-label>${existing && ok ? "다른 파일로 교체 — 클릭 후 붙여넣기(Ctrl+V) 또는 [파일 찾기]" : "클릭 후 붙여넣기(Ctrl+V) · 파일 선택은 [파일 찾기]"}</span>
          </div>
        </div>
        <button class="btn-ghost shrink-0" type="button" data-dropzone-pick>파일 찾기</button>
        <noscript><button class="btn-ghost shrink-0" type="submit">업로드</button></noscript>
      </form>
    </div>`;
  }).join("");

  return `
  <section class="card mt-3 space-y-4">
    <div>
      <h2 class="font-semibold">첨부 서류</h2>
      ${explain(`PNG · JPG · PDF · 최대 10MB. 치프 인증 열람(공개 링크 없음).`)}
    </div>
    ${fileErr ? `<p class="rounded-lg bg-danger/10 px-3 py-2 text-sm text-danger">${esc(fileErr)}</p>` : ""}
    ${rows}
  </section>`;
}

// ── 외주 작업자 = 마스터-디테일(2026-07-20 사용자 결정) ──
// 왼쪽 이름 목록은 늘 있고, 고르면 오른쪽에 **정산 카드 + 기존 3탭 상세**가 뜬다.
// 전환 이유: 목록 카드가 이름·전화만 담아 폭을 다 쓰고 오른쪽이 비어 있었다(사용자 리포트).
// 폭을 넓히는 대신 행의 내용을 채우고, 연락처·업체·매출과 같은 골격(contactPanes)으로 통일했다.

/** 왼쪽 목록용 행 데이터 — 이름 + 정산 요약. 외주는 소수라 N+1 조회가 무해하다(기존 목록과 동일 전제). */
function workerRows() {
  return listProjectManagers({ includeInactive: true, externalOnly: true })
    .map((w) => ({ worker: w, summary: workerPayoutSummary(w) }));
}

/** 2단 렌더(renderContacts/renderClients와 대칭) — 왼쪽 이름 목록, 오른쪽 rightHtml(없으면 안내). */
function renderWorkers(req, sel, rightHtml) {
  const rows = workerRows();
  const left = rows.length
    ? workerNameList({ rows, selectedId: sel ? sel.id : null, hrefFn: (w) => `/workers/${w.id}?return=${encodeURIComponent(req.originalUrl)}` })
    : emptyState(`등록된 외주 작업자가 없습니다.${isChief(req.user) ? " 오른쪽에서 추가하세요." : ""}`, { card: true });
  // 추가 폼은 **미선택일 때 오른쪽**에 둔다 — 왼쪽은 목록만 남겨 스캔을 방해하지 않는다.
  const addForm = `
    <form method="post" action="/workers" class="card mt-3 space-y-2">
      <div class="text-sm font-medium">외주 작업자 추가</div>
      <div class="grid gap-2 sm:grid-cols-3">
        <input class="input py-1.5 text-sm" name="worker_name" placeholder="이름 (작업 담당자 표시명)" autocomplete="off" required />
        <input class="input py-1.5 text-sm" name="email" placeholder="이메일(선택)" />
        <input class="input py-1.5 text-sm" name="phone" autocomplete="off" placeholder="전화(선택)" />
      </div>
      <button class="btn-primary btn-sm" type="submit">추가</button>
    </form>`;
  const right = rightHtml || `${workerEmptyPane()}${isChief(req.user) ? addForm : ""}`;
  const body = `
    ${flashBanner(req.query)}
    ${pageHeader({ title: "외주 작업자", desc: "로그인 없이 작업 담당자로 쓰는 외부 인력. 작업 히스토리·정산 관리." })}
    ${contactPanes({ left, right, hasSelection: !!sel, backHref: safePath(req.query.return) || "/workers", backLabel: "외주 작업자" })}`;
  return layout({ title: sel ? sel.name : "외주 작업자", user: req.user, current: "/workers", body, wide: true });
}

router.get("/", requireInvoice, (req, res) => {
  res.send(renderWorkers(req, null));
});

router.post("/", requireChief, (req, res) => {
  const name = String(req.body.worker_name != null ? req.body.worker_name : req.body.name || "").trim(); // 폼 필드=worker_name(자동완성 회피)
  if (name) {
    const info = db()
      .prepare("INSERT INTO project_managers (name, email, phone, active) VALUES (?, ?, ?, 1)")
      .run(name, String(req.body.email || "").trim() || null, formatPhone(req.body.phone));
    ensurePartyForManager(info.lastInsertRowid); // 새 외주 작업자 → 연동 연락처+성·이름 자동 생성
  }
  res.redirect("/workers?flash=created");
});

router.post("/:id/delete", requireChief, (req, res) => {
  const wDel = getWorker(Number(req.params.id));
  // 첨부 실파일(주민등록증·통장사본)도 함께 회수 — 행만 CASCADE 삭제하면 Drive/로컬에 PII 스캔본이 고아로 남음(2026-07-09 PII 수명주기 점검).
  // DB 삭제 전에 목록을 확보하고, 실제로 삭제됐을 때만(changes>0 — 하우스는 이 라우트로 안 지워짐) best-effort 제거(비동기 fail-safe·흐름 비차단).
  const orphanFiles = listWorkerFiles(Number(req.params.id));
  const r = db().prepare("DELETE FROM project_managers WHERE id = ? AND user_id IS NULL").run(Number(req.params.id));
  if (r.changes > 0) for (const f of orphanFiles) Promise.resolve(storage.remove(f.storage_backend, f.file_id)).catch((e) => console.warn("[worker.delete] 첨부 삭제 실패(고아 파일 잔존):", f.storage_backend, f.file_id, e && e.message));
  if (wDel && r.changes > 0) logAudit(req.user, "worker.delete", `#${wDel.id} ${wDel.name || ""}`);
  res.redirect("/workers?flash=deleted");
});

// 외주 작업자 정보 수정(이름·전화·이메일·정산 정보) — 치프만(마스터 관리). user_id IS NULL로 외주만.
// 주민등록번호·계좌번호는 암호화 저장(db.encrypt) — DB 유출 시에도 평문 노출 방지(2026-07-06 사용자 요청).
router.post("/:id/edit", requireChief, (req, res) => {
  const id = Number(req.params.id);
  const name = String(req.body.worker_name != null ? req.body.worker_name : req.body.name || "").trim(); // 폼 필드=worker_name(자동완성 회피)
  if (name) {
    db()
      .prepare(
        "UPDATE project_managers SET name=?, email=?, phone=?, id_number=?, bank_name=?, account_number=?, account_holder=? WHERE id=? AND user_id IS NULL"
      )
      .run(
        name,
        String(req.body.email || "").trim() || null,
        formatPhone(req.body.phone),
        encrypt(String(req.body.id_number || "").trim() || null),
        String(req.body.bank_name || "").trim() || null,
        encrypt(String(req.body.account_number || "").trim() || null),
        String(req.body.account_holder || "").trim() || null,
        id
      );
    db().prepare("UPDATE track_tasks SET engineer_name = ? WHERE engineer_id = ?").run(name, id); // 이름 변경 시 작업 스냅샷 동기화(정산 매칭 유지)
    syncManagerToParty(id); // 전화·이메일 → 연동 연락처 동기화
    ensurePartyForManager(id); // 미연결이면 연락처 생성·연결(+성·이름 백필)
  }
  res.redirect(`/workers/${id}?flash=saved`);
});

// ── 외주 작업자 상세(작업 히스토리 / 정산) ──
router.get("/:id", requireInvoice, asyncHandler(async (req, res) => {
  const w = getWorker(Number(req.params.id));
  if (!w) return res.status(404).send(errorPage({ code: 404, title: "외주 작업자를 찾을 수 없습니다", message: "삭제되었거나 주소가 잘못되었습니다.", user: req.user }));
  // 탭 3구성(2026-07-09 사용자 요청): 기본 정보(정보 수정+첨부 서류, 기본 탭) / 참여 내역 / 정산.
  const tab = ["info", "tasks", "payout"].includes(req.query.tab) ? req.query.tab : "info";
  const tasks = listTasksForWorker(w);
  const sessions = listSessionsForWorker(w); // 세션 참여(2026-07-06 — 작업만 뜨고 세션 참여가 안 뜨던 것 개선).
  const sessionPayouts = listSessionPayoutsForWorker(w); // 세션 정산 대상(session_engineers에 실제 배정+지급단가 있는 것만, 2026-07-06 사용자 상담)

  const tabBarHtml = tabBar({
    tabs: [
      { key: "info", label: "기본 정보" },
      { key: "tasks", label: `참여 내역 ${tasks.length + sessions.length}` },
      { key: "payout", label: `정산 ${tasks.length + sessionPayouts.length}` },
    ],
    activeKey: tab,
    hrefFn: (key) => `/workers/${w.id}?tab=${key}`,
  });

  // 정산·참여 내역 행의 항목 식별 정보(2026-07-06 사용자 리포트 — '정산할 때 어떤 항목인지 명확하지 않음'):
  // 프로젝트/트랙명만으론 부족해 아티스트·작업일을 덧붙인다(세션 행은 이미 날짜 있음, 작업 행에 통일).
  const taskMeta = (t) => `<span class="text-xs text-muted"> · ${t.track_artist ? `${esc(t.track_artist)} · ` : ""}${esc(t.project_title)} / ${esc(t.track_title)} · ${esc(formatYmdShort(kstYmd(t.created_at)))}</span>`;

  let content;
  if (tab === "payout") {
    if (!tasks.length && !sessionPayouts.length) {
      content = emptyState("담당한 작업·세션 정산 대상이 없습니다.", { card: true });
    } else {
      // 정산 재구성(2026-07-09 점검): ①이체 정보 ②합계 ③미지급(위·일괄 지급+지급일 소급) ④지급완료(지급월별 그룹 — 원천세 신고는 지급월 기준).
      // 작업·세션을 공통 아이템으로 통합해 한 목록에서 다룬다(worker_rate 기준, 고객청구는 작업만 참고 표기).
      const payItems = [
        ...tasks.map((t) => ({ kind: "task", id: t.id, label: taskTypeLabel(t.task_type), metaHtml: taskMeta(t), rate: t.worker_rate || 0, paid: !!t.worker_paid, paidDate: t.worker_paid_date || "", clientPrice: t.total_price || 0, sortDate: kstYmd(t.created_at) })),
        ...sessionPayouts.map((x) => ({ kind: "session", id: x.session_id, label: `${x.session_type || "녹음"} 세션`, metaHtml: `<span class="text-xs text-muted"> · ${esc(x.project_title)} / ${esc(formatYmdShort(x.session_date))}</span>`, rate: x.worker_rate || 0, paid: !!x.worker_paid, paidDate: x.worker_paid_date || "", clientPrice: 0, sortDate: x.session_date || "" })),
      ];
      const payTotal = payItems.reduce((s2, x) => s2 + x.rate, 0);
      const paidTotal = payItems.filter((x) => x.paid).reduce((s2, x) => s2 + x.rate, 0);
      const unpaid = payTotal - paidTotal;
      const clientTotal = tasks.reduce((s2, t) => s2 + (t.total_price || 0), 0);
      // 원천징수 3.3%(개인 사업소득 기준·표시 참고용 — 소액부징수·사업자 외주 예외 미반영, lib/tax)
      const whUnpaid = withholding33(unpaid);

      // ① 이체 정보 — 지급 실행 순간에 계좌를 바로 복사(2026-07-09 점검: '정보 수정' 폼 안에만 있어 이체 시 안 보이던 것).
      const acctNo = decrypt(w.account_number) || "";
      const transferCard = (w.bank_name || acctNo || w.account_holder)
        ? `<div class="card mb-3 flex flex-wrap items-center gap-x-4 gap-y-1 text-sm">
            <span class="text-xs font-medium text-muted">이체 정보</span>
            ${w.bank_name ? `<span>${esc(w.bank_name)}</span>` : ""}
            ${acctNo ? `<span>${copyable(acctNo, { cls: "tabular font-medium" })}</span>` : ""}
            ${w.account_holder ? `<span class="text-muted">예금주 ${copyable(w.account_holder)}</span>` : ""}
          </div>`
        : `<div class="card mb-3 text-sm text-muted"><span class="badge badge-warning mr-2">정산 정보 미입력</span>은행·계좌번호가 없습니다${isChief(req.user) ? ` — 위 '정보 수정'에서 입력하세요` : ""}.</div>`;

      const whLine = unpaid > 0
        ? `<div class="mt-1 w-full border-t border-border pt-1.5 text-xs text-muted">미지급 기준 원천징수 3.3%(소득세 ${formatKRW(whUnpaid.incomeTax)} + 지방소득세 ${formatKRW(whUnpaid.localTax)}) = <b class="text-fg">−${formatKRW(whUnpaid.total)}</b> → 실지급 <b class="text-fg">${formatKRW(whUnpaid.net)}</b> <span class="opacity-80">· 개인(사업소득) 기준, 사업자 외주(세금계산서)는 원천징수 없음</span></div>`
        : "";
      const summary = `<div class="card mb-3 flex flex-wrap gap-4 text-sm">
          <span>지급 합계 <b class="text-fg">${formatKRW(payTotal)}</b></span>
          <span>지급완료 <b class="text-success">${formatKRW(paidTotal)}</b></span>
          <span>미지급 <b class="${unpaid > 0 ? "text-danger" : "text-fg"}">${formatKRW(unpaid)}</b></span>
          <span class="text-muted">고객청구 ${formatKRW(clientTotal)} (참고)</span>
          ${whLine}
        </div>`;

      // 0원(단가 미입력)도 지급·정산 가능(2026-07-09 사용자 결정 — 무료로 도운 작업·세션도 정산 완료로 정리).
      // '단가 미입력' 배지는 누락 실수 감지용 정보 표시로 유지(버튼은 항상 제공).
      const payRow = (x) => `
          <div class="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-border bg-surface p-2.5">
            <div class="min-w-0 text-sm">
              <span class="font-medium">${esc(x.label)}</span>${x.metaHtml}
              ${x.paid ? `<span class="badge ml-1 bg-success/10 text-success">지급완료 ${esc(x.paidDate)}</span>` : `<span class="badge ml-1 bg-warning/10 text-warning">미지급</span>`}
              ${!x.paid && !(x.rate > 0) ? `<span class="badge ml-1 bg-warning/10 text-warning" title="지급단가가 입력되지 않았습니다 — 의도한 무료(0원)라면 그대로 지급 처리하세요. 아니라면 ${x.kind === "task" ? "작업" : "세션"} 편집에서 단가를 입력하세요.">단가 미입력</span>` : ""}
            </div>
            <div class="flex shrink-0 items-center gap-2">
              <span class="text-sm font-semibold">${formatKRW(x.rate)}</span>
              ${x.clientPrice ? `<span class="text-xs text-muted">/ 고객 ${formatKRW(x.clientPrice)}</span>` : ""}
              <form method="post" action="${x.kind === "task" ? `/workers/${w.id}/payout/${x.id}` : `/workers/${w.id}/session-payout/${x.id}`}">
                <button class="btn-ghost btn-xs ${x.paid ? "text-muted" : "text-primary"}" type="submit">${x.paid ? "지급 취소" : "지급 처리"}</button>
              </form>
            </div>
          </div>`;

      // ③ 미지급(위) — 최근 일자순. [전부 지급처리]에 지급일 입력(실제 이체일 소급 기록 가능).
      const unpaidItems = payItems.filter((x) => !x.paid).sort((a, b) => (b.sortDate || "").localeCompare(a.sortDate || ""));
      const noRateCnt = unpaidItems.filter((x) => !(x.rate > 0)).length; // 0원(단가 미입력)도 지급 대상 — 참고 표기만(2026-07-09 사용자 결정)
      const unpaidSection = unpaidItems.length
        ? `<div class="mb-4">
            <div class="mb-1.5 flex flex-wrap items-center justify-between gap-2">
              <div class="text-xs font-medium text-muted">미지급 ${unpaidItems.length}건 · ${formatKRW(unpaid)} <span class="font-normal">(실지급 ${formatKRW(whUnpaid.net)})</span>${noRateCnt ? ` <span class="font-normal text-warning">· 단가 미입력 ${noRateCnt}건 포함</span>` : ""}</div>
              <form method="post" action="/workers/${w.id}/payout-all" class="flex flex-wrap items-center gap-1.5" data-confirm="미지급 ${unpaidItems.length}건 · ${esc(formatKRW(unpaid))}을 전부 지급 처리할까요? (원천세 3.3% 제외 실지급 ${esc(formatKRW(whUnpaid.net))})">
                <input type="hidden" name="return" value="detail" />
                <span class="text-xs text-muted">지급일</span>
                ${dateCombo("paid_on", todayYmd(), { label: "지급일", inputCls: "input w-36 py-1 text-xs" })}
                <button class="btn-ghost btn-xs text-primary" type="submit">전부 지급 처리</button>
              </form>
            </div>
            <div class="space-y-2">${unpaidItems.map(payRow).join("")}</div>
          </div>`
        : `<div class="mb-4 rounded-lg border border-border bg-surface p-3 text-sm text-muted">미지급 항목이 없습니다 — 전부 정산 완료.</div>`;

      // ④ 지급완료 — 지급월별 그룹(최근 달만 펼침). 월 합계에 원천세·실지급(신고 시 그대로 옮겨 적는 용도).
      const paidItems = payItems.filter((x) => x.paid);
      const byMonth = new Map();
      for (const x of paidItems) {
        const key = (x.paidDate || "").slice(0, 7) || "날짜 미상";
        if (!byMonth.has(key)) byMonth.set(key, []);
        byMonth.get(key).push(x);
      }
      const months = [...byMonth.keys()].sort().reverse();
      const paidSection = months
        .map((m, i) => {
          const items = byMonth.get(m).sort((a, b) => (b.paidDate || "").localeCompare(a.paidDate || ""));
          const sum = items.reduce((s2, x) => s2 + x.rate, 0);
          const whM = withholding33(sum);
          const label = m === "날짜 미상" ? m : `${m.slice(0, 4)}년 ${Number(m.slice(5, 7))}월`;
          return `<details class="group rounded-lg border border-border"${i === 0 ? " open" : ""}>
            <summary class="flex cursor-pointer list-none flex-wrap items-center justify-between gap-2 px-3 py-2 text-sm">
              <span class="font-medium">${esc(label)} 지급 <span class="text-xs font-normal text-muted">${items.length}건</span></span>
              <span class="text-xs text-muted">지급 <b class="text-fg">${formatKRW(sum)}</b> · 원천세 −${formatKRW(whM.total)} · 실지급 <b class="text-fg">${formatKRW(whM.net)}</b></span>
            </summary>
            <div class="space-y-2 border-t border-border p-2">${items.map(payRow).join("")}</div>
          </details>`;
        })
        .join("");
      const paidBlock = paidItems.length
        ? `<div><div class="mb-1.5 text-xs font-medium text-muted">지급완료 — 지급월별 <span class="font-normal">(원천세 신고는 지급한 달 기준)</span></div><div class="space-y-2">${paidSection}</div></div>`
        : "";

      content = transferCard + summary + unpaidSection + paidBlock;
    }
  } else if (tab === "tasks" && !tasks.length && !sessions.length) {
    content = emptyState("담당한 작업·세션이 없습니다.", { card: true });
  } else if (tab === "tasks") {
    const taskRows = tasks
      .map(
        (t) => `
        <a href="/projects/${t.project_id}?tab=tracks" class="flex items-center justify-between gap-2 rounded-lg border border-border bg-surface p-2.5 hover:opacity-80">
          <div class="min-w-0 text-sm"><span class="font-medium">${esc(taskTypeLabel(t.task_type))}</span>${taskMeta(t)}</div>
          <div class="flex shrink-0 items-center gap-2">
            <span class="badge ${TASK_STATUS_BADGE[t.status] || "bg-muted/10 text-muted"}">${esc(TASK_STATUS_LABELS[t.status] || t.status)}</span>
            ${t.total_price ? `<span class="text-sm font-semibold">${formatKRW(t.total_price)}</span>` : ""}
          </div>
        </a>`
      )
      .join("");
    // 세션 참여(2026-07-06 신설) — 정산 대상이 아니라 배지·금액 없이 참고 표기만.
    const sessionRows = sessions
      .map(
        (s) => `
        <a href="/projects/${s.project_id}?tab=sessions" class="flex items-center justify-between gap-2 rounded-lg border border-border bg-surface p-2.5 hover:opacity-80">
          <div class="min-w-0 text-sm"><span class="font-medium">${esc(s.session_type || "녹음")} 세션</span> <span class="text-xs text-muted">· ${esc(s.project_title)} · ${esc(formatYmdShort(s.session_date))}</span></div>
          <span class="flex shrink-0 items-center gap-1">${s.my_assigned && !(s.my_rate > 0) ? `<span class="badge bg-warning/10 text-warning" title="지급단가가 입력되지 않았습니다 — 의도한 무료(0원)면 정산 탭에서 그대로 지급 처리, 아니면 세션 편집에서 단가를 입력하세요">지급단가 미입력</span>` : ""}<span class="badge ${SESSION_STATUS_BADGE[s.status] || "bg-muted/10 text-muted"}">${esc(s.status)}</span></span>
        </a>`
      )
      .join("");
    const taskSection = tasks.length ? `<div><div class="mb-1.5 text-xs font-medium text-muted">작업 ${tasks.length}</div><div class="space-y-2">${taskRows}</div></div>` : "";
    const sessionSection = sessions.length ? `<div class="${tasks.length ? "mt-4" : ""}"><div class="mb-1.5 text-xs font-medium text-muted">세션 ${sessions.length}</div><div class="space-y-2">${sessionRows}</div></div>` : "";
    content = taskSection + sessionSection;
  }

  // 삭제 경고용 미지급 합계(작업+세션) — 하드 삭제 정책은 유지하되 실수 방지 문구(2026-07-09 점검).
  const unpaidForDelete = tasks.filter((t) => !t.worker_paid && t.worker_rate > 0).reduce((s2, t) => s2 + t.worker_rate, 0)
    + sessionPayouts.filter((x) => !x.worker_paid && x.worker_rate > 0).reduce((s2, x) => s2 + x.worker_rate, 0);

  // 정보 수정 = 펼침 카드(2026-07-09 사용자 요청 — 접어 놓지 않음, 기본 정보 탭의 본문).
  const editForm = isChief(req.user)
    ? `<section class="card mb-3">
        <h2 class="text-sm font-semibold">정보 수정</h2>
        <form method="post" action="/workers/${w.id}/edit" class="mt-3 grid gap-2 sm:grid-cols-3" data-dirty-form>
          <div><label class="label">이름</label><input class="input py-1.5 text-sm" name="worker_name" value="${esc(w.name || "")}" placeholder="이름" autocomplete="off" required /></div>
          <div><label class="label">이메일</label><input class="input py-1.5 text-sm" name="email" value="${esc(w.email || "")}" placeholder="이메일" /></div>
          <div><label class="label">전화</label><input class="input py-1.5 text-sm" name="phone" autocomplete="off" value="${esc(w.phone || "")}" placeholder="전화" /></div>
          <div class="sm:col-span-3"><label class="label">주민등록번호 / 사업자등록번호</label><input class="input py-1.5 text-sm" name="id_number" value="${esc(decrypt(w.id_number) || "")}" placeholder="어느 쪽이든 한 칸에" autocomplete="off" /></div>
          <div><label class="label">은행</label><input class="input py-1.5 text-sm" name="bank_name" value="${esc(w.bank_name || "")}" placeholder="은행" autocomplete="off" /></div>
          <div><label class="label">계좌번호</label><input class="input py-1.5 text-sm" name="account_number" value="${esc(decrypt(w.account_number) || "")}" placeholder="계좌번호" autocomplete="off" /></div>
          <div><label class="label">입금자명(예금주)</label><input class="input py-1.5 text-sm" name="account_holder" value="${esc(w.account_holder || "")}" placeholder="입금자명(예금주)" autocomplete="off" /></div>
          ${explain(`주민등록번호·계좌번호는 암호화해 저장됩니다. 정산(지급) 시 참고용 — 세금신고·이체에 사용하세요.`)}
          <div class="sm:col-span-3">${dirtyActionRow({ saveLabel: "저장" })}</div>
        </form>
      </section>`
    : `<section class="card mb-3 space-y-1 text-sm">
        <h2 class="text-sm font-semibold">기본 정보</h2>
        ${w.email ? `<div><span class="text-muted">이메일</span> ${esc(w.email)}</div>` : ""}
        ${w.phone ? `<div><span class="text-muted">전화</span> ${esc(w.phone)}</div>` : ""}
        <p class="text-xs text-muted">정보 수정·첨부 서류 관리는 치프 전용입니다.</p>
      </section>`;

  // 첨부 서류(주민등록증 사본·통장사본) — 치프만(민감정보, 2026-07-06 사용자 요청).
  let filesBlock = "";
  if (isChief(req.user)) {
    const files = listWorkerFiles(w.id);
    const fileMap = {};
    files.forEach((f) => { fileMap[f.kind] = f; });
    const fileOk = {};
    for (const f of files) {
      try { fileOk[f.kind] = await storage.exists(f.storage_backend, f.file_id); } catch { fileOk[f.kind] = true; } // 확인 실패는 있음으로 간주(유효 파일 숨김 방지)
    }
    const fileErr = req.query.ferr ? String(req.query.ferr) : "";
    filesBlock = workerFileSection(w, fileMap, fileErr, fileOk);
  }

  // 기본 정보 탭 = 정보 수정(펼침) + 첨부 서류(2026-07-09 사용자 요청 — 탭으로 분리, 이전엔 탭 위에 상시 노출).
  if (tab === "info") content = editForm + filesBlock;

  // 오른쪽 패널 = **정산 카드**(사용자 결정: '작업자를 선택하면 오른쪽에 정산 카드 상세') + 기존 3탭 상세.
  // 카드는 탭과 무관하게 늘 위에 둔다 — 정산이 이 화면의 목적이고, 탭을 옮겨도 '얼마·보낼 수 있나'는 계속 보여야 한다.
  const summary = workerPayoutSummary(w);
  const right = `
    <div class="mb-3 flex items-start justify-between gap-3">
      <div class="min-w-0">
        <h1 class="truncate font-display text-2xl font-semibold text-fg">${esc(w.name)}</h1>
        ${w.party_id ? `<div class="mt-0.5 text-sm"><span class="text-muted">연락처로 보기</span> <a href="/contacts/${w.party_id}" target="_blank" rel="noopener" class="text-primary hover:underline">${esc(w.name)} ↗</a></div>` : ""}
      </div>
      ${isChief(req.user) ? `<form method="post" action="/workers/${w.id}/delete" class="shrink-0" data-confirm="${esc(w.name)} 외주 작업자를 삭제할까요?${unpaidForDelete > 0 ? esc(` ⚠️ 미지급 ${formatKRW(unpaidForDelete)} 기록이 함께 사라집니다.`) : ""}"><button class="btn-ghost btn-sm text-danger" type="submit">작업자 삭제</button></form>` : ""}
    </div>
    ${workerPayoutCard({ worker: w, summary, canPay: true })}
    <div class="mt-3">${tabBarHtml}</div>
    ${content}`;
  res.send(renderWorkers(req, w, right));
}));

// ── 작업 지급 처리/해제(정산) ──
router.post("/:id/payout/:taskId", requireInvoice, (req, res) => {
  const w = getWorker(Number(req.params.id));
  if (!w) return res.status(404).send("외주 작업자를 찾을 수 없습니다.");
  // 소속 확인: engineer_id 우선(rename 내성), 폴백 (engineer_id IS NULL AND engineer_name = 이름)(레거시·미매칭분).
  const task = db()
    .prepare("SELECT id, worker_paid FROM track_tasks WHERE id = ? AND (engineer_id = ? OR (engineer_id IS NULL AND engineer_name = ?))")
    .get(Number(req.params.taskId), w.id, w.name);
  if (task) { setTaskPayout(task.id, !task.worker_paid); logAudit(req.user, "worker.payout", `${w.name} 작업#${task.id} ${task.worker_paid ? "지급 취소" : "지급"}`); }
  res.redirect(`/workers/${w.id}?tab=payout`);
});

// ── 세션 지급 처리/해제(정산, 2026-07-06 사용자 상담 — 작업과 동일 구조) ──
router.post("/:id/session-payout/:sessionId", requireInvoice, (req, res) => {
  const w = getWorker(Number(req.params.id));
  if (!w) return res.status(404).send("외주 작업자를 찾을 수 없습니다.");
  const sessionId = Number(req.params.sessionId);
  const eng = db().prepare("SELECT worker_paid FROM session_engineers WHERE session_id = ? AND manager_id = ?").get(sessionId, w.id);
  if (eng) { setSessionEngineerPayout(sessionId, w.id, !eng.worker_paid); logAudit(req.user, "worker.payout", `${w.name} 세션#${sessionId} ${eng.worker_paid ? "지급 취소" : "지급"}`); }
  res.redirect(`/workers/${w.id}?tab=payout`);
});

// ── 미지급 전체 일괄 지급 처리(목록 카드 요약 줄의 [지급처리] 버튼, 2026-07-06 사용자 요청) ──
router.post("/:id/payout-all", requireInvoice, (req, res) => {
  const w = getWorker(Number(req.params.id));
  if (!w) return res.status(404).send("외주 작업자를 찾을 수 없습니다.");
  // 지급일 소급(2026-07-09): 상세 정산 탭의 일괄 지급 폼이 paid_on(기본 오늘)을 보냄 — 실제 이체일 기록.
  const paidOn = isValidYmd(String(req.body.paid_on || "")) ? String(req.body.paid_on) : null;
  // 0원(단가 미입력)도 포함해 전부 지급 처리(2026-07-09 사용자 결정 — 무료 작업도 정산 완료로 정리).
  const tasks = listTasksForWorker(w).filter((t) => !t.worker_paid);
  tasks.forEach((t) => setTaskPayout(t.id, true, paidOn));
  const sessionPayouts = listSessionPayoutsForWorker(w).filter((s) => !s.worker_paid);
  sessionPayouts.forEach((s) => setSessionEngineerPayout(s.session_id, w.id, true, paidOn));
  logAudit(req.user, "worker.payout", `${w.name} 일괄 지급 ${tasks.length + sessionPayouts.length}건${paidOn ? ` (지급일 ${paidOn})` : ""}`);
  // 상세 정산 탭에서 눌렀으면 그 자리로 복귀(목록 카드의 버튼은 기존대로 목록).
  if (req.body.return === "detail") return res.redirect(`/workers/${w.id}?tab=payout&flash=saved`);
  res.redirect("/workers?flash=saved");
});

// ── 첨부 서류 업로드(주민등록증 사본·통장사본) — 치프만(민감정보) ──
router.post("/:id/files/:kind", requireChief, upload.single("file"), asyncHandler(async (req, res) => {
  const id = Number(req.params.id);
  const kind = req.params.kind;
  const w = getWorker(id);
  if (!w) {
    if (req.file) fs.promises.unlink(req.file.path).catch(() => {});
    return res.status(404).send(errorPage({ code: 404, title: "외주 작업자를 찾을 수 없습니다", message: "", user: req.user }));
  }
  if (!FILE_KINDS.find((k) => k.key === kind)) {
    if (req.file) fs.promises.unlink(req.file.path).catch(() => {});
    return res.redirect(`/workers/${id}?ferr=${encodeURIComponent("알 수 없는 서류 종류입니다.")}`);
  }
  if (!req.file) return res.redirect(`/workers/${id}?ferr=${encodeURIComponent("파일을 선택하세요.")}`);

  const detectedMime = detectMimeFromFile(req.file.path);
  if (!detectedMime) {
    fs.promises.unlink(req.file.path).catch(() => {});
    return res.redirect(`/workers/${id}?ferr=${encodeURIComponent("PNG, JPG, PDF 파일만 업로드할 수 있습니다.")}`);
  }

  const originalName = decodeName(req.file.originalname);
  try {
    const kindLabel = FILE_KINDS.find((k) => k.key === kind).label;
    const { backend, fileId } = await storage.put({ filePath: req.file.path, name: originalName, mimeType: detectedMime, folder: kindLabel });
    const old = upsertWorkerFile(id, kind, { storage_backend: backend, file_id: fileId, file_name: originalName, mime_type: detectedMime, file_size: req.file.size });
    if (old) await storage.remove(old.storage_backend, old.file_id);
    res.redirect(`/workers/${id}?flash=saved`);
  } catch (e) {
    console.error("[worker file upload]", e);
    const msg = e && e.code === "DRIVE_UPLOAD_FAILED"
      ? "구글 Drive 업로드에 실패했습니다 — 로컬에 저장하지 않았습니다. 잠시 후 다시 시도하세요."
      : "업로드에 실패했습니다.";
    res.redirect(`/workers/${id}?ferr=${encodeURIComponent(msg)}`);
  } finally {
    if (req.file) fs.promises.unlink(req.file.path).catch(() => {});
  }
}));

// ── 첨부 서류 인증 다운로드(치프 인증 후 프록시 — 공개 URL 없음) ──
// ── 첨부 서류 뷰어(팝업 전용, 2026-07-08) — 이미지·PDF가 팝업 창을 꽉 채우게(PDF는 iframe+#view=FitH로 폭 맞춤, 2026-07-20).
router.get("/:id/files/:kind/view", requireChief, (req, res) => {
  const id = Number(req.params.id);
  const kind = req.params.kind;
  const meta = FILE_KINDS.find((k) => k.key === kind);
  if (!meta) return res.status(404).send("파일을 찾을 수 없습니다.");
  const wf = getWorkerFile(id, kind);
  if (!wf) return res.status(404).send(errorPage({ code: 404, title: "파일이 없습니다", message: "아직 업로드된 파일이 없습니다.", user: req.user }));
  res.setHeader("Cache-Control", "private, no-store");
  res.send(fileViewerPage({ title: meta.label, rawUrl: `/workers/${id}/files/${kind}/raw`, pdf: (wf.mime_type || "").includes("pdf") }));
});

router.get("/:id/files/:kind/raw", requireChief, asyncHandler(async (req, res) => {
  const id = Number(req.params.id);
  const kind = req.params.kind;
  if (!FILE_KINDS.find((k) => k.key === kind)) return res.status(404).send("파일을 찾을 수 없습니다.");
  const wf = getWorkerFile(id, kind);
  if (!wf) return res.status(404).send(errorPage({ code: 404, title: "파일이 없습니다", message: "아직 업로드된 파일이 없습니다.", user: req.user }));
  res.setHeader("Cache-Control", "private, no-store");
  res.setHeader("Content-Type", wf.mime_type || "application/octet-stream");
  res.setHeader("Content-Disposition", `inline; filename*=UTF-8''${encodeURIComponent(wf.file_name)}`);
  if (wf.file_size > 0) res.setHeader("Content-Length", wf.file_size);
  try {
    await storage.stream(wf.storage_backend, wf.file_id, res);
  } catch (e) {
    console.error("[worker file stream]", e);
    if (!res.headersSent) res.status(502).send("파일을 가져오지 못했습니다.");
    else res.destroy();
  }
}));

// ── 첨부 서류 삭제 ──
router.post("/:id/files/:kind/delete", requireChief, asyncHandler(async (req, res) => {
  const id = Number(req.params.id);
  const kind = req.params.kind;
  if (!FILE_KINDS.find((k) => k.key === kind)) return res.redirect(`/workers/${id}`);
  const old = deleteWorkerFile(id, kind);
  if (old) await storage.remove(old.storage_backend, old.file_id);
  res.redirect(`/workers/${id}?flash=deleted`);
}));

module.exports = router;
