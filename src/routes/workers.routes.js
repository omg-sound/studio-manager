"use strict";

const fs = require("fs");
const express = require("express");
const { db, encrypt, decrypt } = require("../db");
const { requireInvoice, requireChief, isChief } = require("../auth");
const {
  listProjectManagers, getWorker, listTasksForWorker, listSessionsForWorker, setTaskPayout, taskTypeLabel, syncManagerToParty, ensurePartyForManager, formatPhone,
  listWorkerFiles, getWorkerFile, upsertWorkerFile, deleteWorkerFile,
  listSessionPayoutsForWorker, setSessionEngineerPayout,
} = require("../data");
const storage = require("../storage");
const { asyncHandler } = require("../lib/async");
const { buildUpload, decodeName, detectMimeFromFile } = require("../lib/attachments"); // 첨부 보안 로직 공용(2026-07-09 통합)
const { layout, pageHeader, esc, flashBanner, emptyState, errorPage, formatKRW, tabBar, explain, fileViewerPage, copyable, dirtyActionRow } = require("../views");
const { TASK_STATUS_LABELS, TASK_STATUS_BADGE, SESSION_STATUS_BADGE } = require("../config");
const { formatYmdShort, todayYmd, isValidYmd } = require("../lib/date");
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

// ── 외주 작업자 목록(치프는 추가 폼도) ──
router.get("/", requireInvoice, (req, res) => {
  const workers = listProjectManagers({ includeInactive: true, externalOnly: true });
  // 카드 밑 지급 요약 줄(2026-07-06 사용자 요청) — 미지급 건수·금액 한 줄(작업+세션 합산) + 오른쪽 끝 일괄 지급처리.
  // 소수 외주 작업자 대상 N+1은 무해(listTasksForWorker/listSessionPayoutsForWorker 재사용, 페이지당 소수).
  const list = workers.length
    ? workers
        .map((w) => {
          const tasks = listTasksForWorker(w);
          const sessionPayouts = listSessionPayoutsForWorker(w);
          const unpaid = tasks.filter((t) => !t.worker_paid && t.worker_rate > 0);
          const unpaidSessions = sessionPayouts.filter((s) => !s.worker_paid && s.worker_rate > 0);
          const unpaidAmt = unpaid.reduce((s, t) => s + (t.worker_rate || 0), 0) + unpaidSessions.reduce((s, x) => s + (x.worker_rate || 0), 0);
          const unpaidCount = unpaid.length + unpaidSessions.length;
          // 미지급 항목 미리보기(2026-07-06 사용자 요청 — 건수·금액만으론 뭔지 몰라 대략 어떤 항목인지 한 줄 더).
          // 작업 라벨에 날짜 추가(2026-07-06 후속 — 종류만으론 같은 종류 작업이 여럿일 때 구분이 안 돼 '정산할 때 어떤 항목인지 명확하지 않다'는 리포트).
          // 프로젝트명 추가(2026-07-06 후속 — 어느 프로젝트 작업인지도 보여야 정산 시 헷갈리지 않음).
          const itemLabels = [
            ...unpaid.map((t) => `${t.project_title} · ${taskTypeLabel(t.task_type)} ${formatYmdShort(String(t.created_at || "").slice(0, 10))}`),
            ...unpaidSessions.map((s) => `${s.project_title} · ${s.session_type || "녹음"} 세션 ${formatYmdShort(s.session_date)}`),
          ];
          const PREVIEW_MAX = 3;
          const itemPreview = itemLabels.slice(0, PREVIEW_MAX).join(", ") + (itemLabels.length > PREVIEW_MAX ? ` 외 ${itemLabels.length - PREVIEW_MAX}건` : "");
          const wh = withholding33(unpaidAmt); // 원천징수 3.3%(사업소득) — 표시 참고용(lib/tax)
          const payoutBar = unpaidCount
            ? `<div class="mt-1.5 border-t border-border pt-1.5 text-sm">
                <div class="flex items-center justify-between gap-2">
                  <span class="text-muted">미지급 <b class="text-danger">${formatKRW(unpaidAmt)}</b> (${unpaidCount}건)</span>
                  <form method="post" action="/workers/${w.id}/payout-all" data-confirm="미지급 ${unpaidCount}건 · ${esc(formatKRW(unpaidAmt))}을 전부 지급 처리할까요? (원천세 3.3% ${esc(formatKRW(wh.total))} 제외 시 실지급 ${esc(formatKRW(wh.net))})">
                    <button class="btn-ghost btn-xs text-primary" type="submit">지급처리</button>
                  </form>
                </div>
                ${wh.total ? `<div class="mt-0.5 text-xs text-muted">원천세 3.3% −${formatKRW(wh.total)} → 실지급 <b class="text-fg">${formatKRW(wh.net)}</b></div>` : ""}
                <div class="mt-0.5 truncate text-xs text-muted">${esc(itemPreview)}</div>
              </div>`
            : "";
          return `
        <div class="card mb-2">
          <a href="/workers/${w.id}" class="flex items-center justify-between gap-3 hover:opacity-80">
            <div class="min-w-0">
              <span class="font-semibold">${esc(w.name)}</span>
              ${w.email || w.phone ? `<div class="mt-0.5 text-xs text-muted">${esc(w.email || "")}${w.email && w.phone ? " · " : ""}${esc(w.phone || "")}</div>` : ""}
            </div>
            <span class="shrink-0 text-xs text-muted">작업 · 정산 ›</span>
          </a>
          ${payoutBar}
        </div>`;
        })
        .join("")
    : emptyState(`등록된 외주 작업자가 없습니다.${isChief(req.user) ? " 아래에서 추가하세요." : ""}`, { card: true });

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

  const body = `
    ${flashBanner(req.query)}
    ${pageHeader({ title: "외주 작업자", desc: "로그인 없이 작업 담당자로 쓰는 외부 인력. 작업 히스토리·정산 관리." })}
    ${list}
    ${isChief(req.user) ? addForm : ""}`;
  res.send(layout({ title: "외주 작업자", user: req.user, current: "/workers", body }));
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
  db().prepare("DELETE FROM project_managers WHERE id = ? AND user_id IS NULL").run(Number(req.params.id));
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
  const tab = req.query.tab === "payout" ? "payout" : "tasks";
  const tasks = listTasksForWorker(w);
  const sessions = listSessionsForWorker(w); // 세션 참여(2026-07-06 — 작업만 뜨고 세션 참여가 안 뜨던 것 개선).
  const sessionPayouts = listSessionPayoutsForWorker(w); // 세션 정산 대상(session_engineers에 실제 배정+지급단가 있는 것만, 2026-07-06 사용자 상담)

  const tabBarHtml = tabBar({
    tabs: [{ key: "tasks", label: `참여 내역 ${tasks.length + sessions.length}` }, { key: "payout", label: `정산 ${tasks.length + sessionPayouts.length}` }],
    activeKey: tab,
    hrefFn: (key) => `/workers/${w.id}?tab=${key}`,
  });

  // 정산·참여 내역 행의 항목 식별 정보(2026-07-06 사용자 리포트 — '정산할 때 어떤 항목인지 명확하지 않음'):
  // 프로젝트/트랙명만으론 부족해 아티스트·작업일을 덧붙인다(세션 행은 이미 날짜 있음, 작업 행에 통일).
  const taskMeta = (t) => `<span class="text-xs text-muted"> · ${t.track_artist ? `${esc(t.track_artist)} · ` : ""}${esc(t.project_title)} / ${esc(t.track_title)} · ${esc(formatYmdShort(String(t.created_at || "").slice(0, 10)))}</span>`;

  let content;
  if (tab === "payout") {
    if (!tasks.length && !sessionPayouts.length) {
      content = emptyState("담당한 작업·세션 정산 대상이 없습니다.", { card: true });
    } else {
      // 정산 재구성(2026-07-09 점검): ①이체 정보 ②합계 ③미지급(위·일괄 지급+지급일 소급) ④지급완료(지급월별 그룹 — 원천세 신고는 지급월 기준).
      // 작업·세션을 공통 아이템으로 통합해 한 목록에서 다룬다(worker_rate 기준, 고객청구는 작업만 참고 표기).
      const payItems = [
        ...tasks.map((t) => ({ kind: "task", id: t.id, label: taskTypeLabel(t.task_type), metaHtml: taskMeta(t), rate: t.worker_rate || 0, paid: !!t.worker_paid, paidDate: t.worker_paid_date || "", clientPrice: t.total_price || 0, sortDate: String(t.created_at || "").slice(0, 10) })),
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

      // 단가 0 미지급 = '단가 미입력'(지급할 금액이 없어 일괄 지급에서도 제외됨) — 배지로 구분하고 지급 버튼 대신 입력 안내(2026-07-09).
      const payRow = (x) => `
          <div class="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-border bg-surface p-2.5">
            <div class="min-w-0 text-sm">
              <span class="font-medium">${esc(x.label)}</span>${x.metaHtml}
              ${x.paid ? `<span class="badge ml-1 bg-success/10 text-success">지급완료 ${esc(x.paidDate)}</span>` : x.rate > 0 ? `<span class="badge ml-1 bg-warning/10 text-warning">미지급</span>` : `<span class="badge ml-1 bg-warning/10 text-warning" title="${x.kind === "task" ? "작업 편집에서 외주 지급단가를 입력해야 지급할 수 있습니다" : "세션 편집에서 이 작업자의 지급단가를 입력해야 지급할 수 있습니다"}">단가 미입력</span>`}
            </div>
            <div class="flex shrink-0 items-center gap-2">
              <span class="text-sm font-semibold">${formatKRW(x.rate)}</span>
              ${x.clientPrice ? `<span class="text-xs text-muted">/ 고객 ${formatKRW(x.clientPrice)}</span>` : ""}
              ${x.paid || x.rate > 0 ? `<form method="post" action="${x.kind === "task" ? `/workers/${w.id}/payout/${x.id}` : `/workers/${w.id}/session-payout/${x.id}`}">
                <button class="btn-ghost btn-xs ${x.paid ? "text-muted" : "text-primary"}" type="submit">${x.paid ? "지급 취소" : "지급 처리"}</button>
              </form>` : ""}
            </div>
          </div>`;

      // ③ 미지급(위) — 최근 일자순. [전부 지급처리]에 지급일 입력(실제 이체일 소급 기록 가능).
      const unpaidItems = payItems.filter((x) => !x.paid).sort((a, b) => (b.sortDate || "").localeCompare(a.sortDate || ""));
      const payableCnt = unpaidItems.filter((x) => x.rate > 0).length;
      const noRateCnt = unpaidItems.length - payableCnt;
      const unpaidSection = unpaidItems.length
        ? `<div class="mb-4">
            <div class="mb-1.5 flex flex-wrap items-center justify-between gap-2">
              <div class="text-xs font-medium text-muted">미지급 ${payableCnt}건 · ${formatKRW(unpaid)} <span class="font-normal">(실지급 ${formatKRW(whUnpaid.net)})</span>${noRateCnt ? ` <span class="font-normal text-warning">· 단가 미입력 ${noRateCnt}건</span>` : ""}</div>
              <form method="post" action="/workers/${w.id}/payout-all" class="flex flex-wrap items-center gap-1.5" data-confirm="미지급 ${payableCnt}건 · ${esc(formatKRW(unpaid))}을 전부 지급 처리할까요? (원천세 3.3% 제외 실지급 ${esc(formatKRW(whUnpaid.net))})">
                <input type="hidden" name="return" value="detail" />
                <label class="text-xs text-muted" for="payall-date">지급일</label>
                <input id="payall-date" class="input w-36 py-1 text-xs" type="date" name="paid_on" value="${todayYmd()}" />
                <button class="btn-ghost btn-xs text-primary" type="submit">전부 지급처리</button>
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
  } else if (!tasks.length && !sessions.length) {
    content = emptyState("담당한 작업·세션이 없습니다.", { card: true });
  } else {
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
          <span class="flex shrink-0 items-center gap-1">${s.my_assigned && !(s.my_rate > 0) ? `<span class="badge bg-warning/10 text-warning" title="세션 편집에서 이 작업자의 지급단가를 입력해야 정산 대상이 됩니다">지급단가 미입력</span>` : ""}<span class="badge ${SESSION_STATUS_BADGE[s.status] || "bg-muted/10 text-muted"}">${esc(s.status)}</span></span>
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

  const editForm = isChief(req.user)
    ? `<details class="card mb-3">
        <summary class="cursor-pointer text-sm font-medium text-muted hover:text-fg">정보 수정 (이름 · 전화 · 이메일 · 정산 정보)</summary>
        <form method="post" action="/workers/${w.id}/edit" class="mt-3 grid gap-2 sm:grid-cols-3" data-dirty-form>
          <input class="input py-1.5 text-sm" name="worker_name" value="${esc(w.name || "")}" placeholder="이름" autocomplete="off" required />
          <input class="input py-1.5 text-sm" name="email" value="${esc(w.email || "")}" placeholder="이메일" />
          <input class="input py-1.5 text-sm" name="phone" autocomplete="off" value="${esc(w.phone || "")}" placeholder="전화" />
          <input class="input py-1.5 text-sm sm:col-span-3" name="id_number" value="${esc(decrypt(w.id_number) || "")}" placeholder="주민등록번호 또는 사업자등록번호" autocomplete="off" />
          <input class="input py-1.5 text-sm" name="bank_name" value="${esc(w.bank_name || "")}" placeholder="은행" autocomplete="off" />
          <input class="input py-1.5 text-sm" name="account_number" value="${esc(decrypt(w.account_number) || "")}" placeholder="계좌번호" autocomplete="off" />
          <input class="input py-1.5 text-sm" name="account_holder" value="${esc(w.account_holder || "")}" placeholder="입금자명(예금주)" autocomplete="off" />
          ${explain(`주민등록번호·계좌번호는 암호화해 저장됩니다. 정산(지급) 시 참고용 — 세금신고·이체에 사용하세요.`)}
          <div class="sm:col-span-3">${dirtyActionRow({ saveLabel: "저장" })}</div>
        </form>
      </details>`
    : "";

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

  const body = `
    ${flashBanner(req.query)}
    ${pageHeader({ title: w.name, desc: "외주 작업자", back: { href: "/workers", label: "외주 작업자" }, action: isChief(req.user) ? `<form method="post" action="/workers/${w.id}/delete" data-confirm="${esc(w.name)} 외주 작업자를 삭제할까요?${unpaidForDelete > 0 ? esc(` ⚠️ 미지급 ${formatKRW(unpaidForDelete)} 기록이 함께 사라집니다.`) : ""}"><button class="btn-ghost btn-sm text-danger" type="submit">작업자 삭제</button></form>` : "" })}
    ${w.party_id ? `<div class="-mt-3 mb-3 text-sm"><span class="text-muted">연락처로 보기</span> <a href="/contacts/${w.party_id}" class="text-primary hover:underline">${esc(w.name)} ↗</a></div>` : ""}
    ${editForm}
    ${filesBlock}
    ${tabBarHtml}
    ${content}`;
  res.send(layout({ title: w.name, user: req.user, current: "/workers", body }));
}));

// ── 작업 지급 처리/해제(정산) ──
router.post("/:id/payout/:taskId", requireInvoice, (req, res) => {
  const w = getWorker(Number(req.params.id));
  if (!w) return res.status(404).send("외주 작업자를 찾을 수 없습니다.");
  // 소속 확인: engineer_id 우선(rename 내성), 폴백 (engineer_id IS NULL AND engineer_name = 이름)(레거시·미매칭분).
  const task = db()
    .prepare("SELECT id, worker_paid FROM track_tasks WHERE id = ? AND (engineer_id = ? OR (engineer_id IS NULL AND engineer_name = ?))")
    .get(Number(req.params.taskId), w.id, w.name);
  if (task) setTaskPayout(task.id, !task.worker_paid);
  res.redirect(`/workers/${w.id}?tab=payout`);
});

// ── 세션 지급 처리/해제(정산, 2026-07-06 사용자 상담 — 작업과 동일 구조) ──
router.post("/:id/session-payout/:sessionId", requireInvoice, (req, res) => {
  const w = getWorker(Number(req.params.id));
  if (!w) return res.status(404).send("외주 작업자를 찾을 수 없습니다.");
  const sessionId = Number(req.params.sessionId);
  const eng = db().prepare("SELECT worker_paid FROM session_engineers WHERE session_id = ? AND manager_id = ?").get(sessionId, w.id);
  if (eng) setSessionEngineerPayout(sessionId, w.id, !eng.worker_paid);
  res.redirect(`/workers/${w.id}?tab=payout`);
});

// ── 미지급 전체 일괄 지급 처리(목록 카드 요약 줄의 [지급처리] 버튼, 2026-07-06 사용자 요청) ──
router.post("/:id/payout-all", requireInvoice, (req, res) => {
  const w = getWorker(Number(req.params.id));
  if (!w) return res.status(404).send("외주 작업자를 찾을 수 없습니다.");
  // 지급일 소급(2026-07-09): 상세 정산 탭의 일괄 지급 폼이 paid_on(기본 오늘)을 보냄 — 실제 이체일 기록.
  const paidOn = isValidYmd(String(req.body.paid_on || "")) ? String(req.body.paid_on) : null;
  const tasks = listTasksForWorker(w).filter((t) => !t.worker_paid && t.worker_rate > 0);
  tasks.forEach((t) => setTaskPayout(t.id, true, paidOn));
  const sessionPayouts = listSessionPayoutsForWorker(w).filter((s) => !s.worker_paid && s.worker_rate > 0);
  sessionPayouts.forEach((s) => setSessionEngineerPayout(s.session_id, w.id, true, paidOn));
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
      ? "Google Drive 업로드에 실패했습니다 — 로컬에 저장하지 않았습니다. 잠시 후 다시 시도하세요."
      : "업로드에 실패했습니다.";
    res.redirect(`/workers/${id}?ferr=${encodeURIComponent(msg)}`);
  } finally {
    if (req.file) fs.promises.unlink(req.file.path).catch(() => {});
  }
}));

// ── 첨부 서류 인증 다운로드(치프 인증 후 프록시 — 공개 URL 없음) ──
// ── 첨부 서류 뷰어(팝업 전용, 2026-07-08) — 이미지가 팝업 창을 꽉 채우게. PDF는 내장 뷰어가 이미 꽉 채워 raw로 리다이렉트.
router.get("/:id/files/:kind/view", requireChief, (req, res) => {
  const id = Number(req.params.id);
  const kind = req.params.kind;
  const meta = FILE_KINDS.find((k) => k.key === kind);
  if (!meta) return res.status(404).send("파일을 찾을 수 없습니다.");
  const wf = getWorkerFile(id, kind);
  if (!wf) return res.status(404).send(errorPage({ code: 404, title: "파일이 없습니다", message: "아직 업로드된 파일이 없습니다.", user: req.user }));
  if ((wf.mime_type || "").includes("pdf")) return res.redirect(`/workers/${id}/files/${kind}/raw`);
  res.setHeader("Cache-Control", "private, no-store");
  res.send(fileViewerPage({ title: meta.label, rawUrl: `/workers/${id}/files/${kind}/raw` }));
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
