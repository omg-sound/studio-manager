"use strict";

/**
 * 자료 전달(deliverables) 목록/행 렌더. 프로젝트 상세와 타임라인에서 공유.
 */

const { esc, formatBytes, emptyState, detailsChevron } = require("./views");
const { todayYmd } = require("./lib/date");

const KIND_BADGE = {
  녹음본: "bg-primary/10 text-primary",
  튠본: "bg-primary/10 text-primary",
  믹스: "bg-primary/10 text-primary",
  스템: "bg-warning/10 text-warning",
  마스터: "bg-success/10 text-success",
  레퍼런스: "bg-muted/10 text-muted",
  기타: "bg-muted/10 text-muted",
};

/** 링크 상태 라벨(만료/철회/활성). */
function linkStatus(dv) {
  if (!dv.access_token) return { label: "링크 없음", cls: "text-muted", active: false };
  if (dv.revoked) return { label: "철회됨", cls: "text-danger", active: false };
  if (dv.expires_at && todayYmd() > dv.expires_at)
    return { label: `만료(${esc(dv.expires_at)})`, cls: "text-danger", active: false };
  return { label: dv.expires_at ? `~${esc(dv.expires_at)} 유효` : "무기한 유효", cls: "text-success", active: true };
}

function kindBadge(kind) {
  const cls = KIND_BADGE[kind] || "bg-muted/10 text-muted";
  return `<span class="badge ${cls}">${esc(kind)}</span>`;
}

/** 자료 한 행(관리자=관리 컨트롤, 클라이언트=다운로드만). */
function deliverableRow(dv, { isAdmin, baseUrl }) {
  const meta = `${dv.version ? esc(dv.version) + " · " : ""}${esc(formatBytes(dv.file_size))} · ${esc((dv.created_at || "").slice(0, 10))}`;
  const status = linkStatus(dv);
  const shareUrl = dv.access_token ? `${baseUrl}/d/${dv.access_token}` : "";

  const adminControls = isAdmin
    ? `
    <div class="mt-3 space-y-2 border-t border-border pt-3">
      ${
        dv.access_token
          ? `<div class="flex items-center gap-2">
               <input class="input flex-1 text-xs" readonly value="${esc(shareUrl)}" />
               <button type="button" class="btn-ghost btn-xs" data-copy="${esc(shareUrl)}">복사</button>
             </div>
             <div class="text-xs ${status.cls}">${status.label} · 다운로드 ${dv.download_count}회</div>`
          : `<div class="text-xs text-muted">공유 링크가 없습니다. 아래에서 발급하세요.</div>`
      }
      <div class="flex flex-wrap items-end gap-2">
        <form method="post" action="/deliverables/${dv.id}/token" class="flex items-end gap-2">
          <div>
            <label class="label mb-0.5 text-xs">만료일(선택)</label>
            <input type="date" name="expires_at" class="input py-1 text-xs" value="${esc(dv.expires_at || "")}" />
          </div>
          <button class="btn-ghost btn-xs">${dv.access_token ? "링크 갱신" : "링크 발급"}</button>
        </form>
        <form method="post" action="/deliverables/${dv.id}/revoke">
          <button class="btn-ghost btn-xs ${dv.revoked ? "text-success" : "text-danger"}">${dv.revoked ? "철회 해제" : "철회"}</button>
        </form>
        <form method="post" action="/deliverables/${dv.id}/delete" data-confirm="이 자료와 파일을 삭제할까요?">
          <button class="btn-ghost btn-xs text-danger">삭제</button>
        </form>
      </div>
    </div>`
    : status.active
      ? `<div class="mt-1 text-xs text-muted">${dv.expires_at ? `${esc(dv.expires_at)}까지 다운로드 가능` : "다운로드 가능"}</div>`
      : "";

  return `
    <div class="border-b border-border py-3 last:border-0">
      <div class="flex items-start justify-between gap-3">
        <div class="min-w-0">
          <div class="flex items-center gap-2">${kindBadge(dv.kind)}<span class="truncate font-medium">${esc(dv.title)}</span></div>
          <div class="mt-0.5 truncate text-xs text-muted">${esc(dv.file_name)} · ${meta}</div>
          ${dv.note ? `<div class="mt-1 text-xs text-muted">${esc(dv.note)}</div>` : ""}
        </div>
        <a href="/deliverables/${dv.id}/raw" class="btn-ghost shrink-0 btn-xs">다운로드</a>
      </div>
      ${adminControls}
    </div>`;
}

/** 프로젝트 상세용 자료 섹션(업로드 버튼 + 목록). collapsed=true면 접이식. */
function deliverablesSection({ project, rows, isAdmin, baseUrl, collapsed = false }) {
  const list = rows.length
    ? rows.map((dv) => deliverableRow(dv, { isAdmin, baseUrl })).join("")
    : emptyState("전달된 자료가 없습니다.");
  const uploadBtn = isAdmin
    ? `<a href="/projects/${project.id}/deliverables/new" class="btn-primary btn-sm">+ 자료 업로드</a>`
    : "";
  if (collapsed) {
    return `
    <details class="card group mt-3">
      <summary class="flex cursor-pointer list-none items-center justify-between gap-3">
        <h2 class="font-display text-base font-semibold">자료 전달 <span class="text-sm font-normal text-muted">${rows.length}</span></h2>
        ${detailsChevron()}
      </summary>
      <div class="mt-3 border-t border-border pt-3">
        ${uploadBtn ? `<div class="mb-2 flex justify-end">${uploadBtn}</div>` : ""}
        ${list}
      </div>
    </details>`;
  }
  return `
    <div class="card mt-3">
      <div class="mb-2 flex items-center justify-between">
        <h2 class="font-display text-base font-semibold">자료 전달</h2>
        ${uploadBtn}
      </div>
      ${list}
    </div>`;
}

module.exports = { deliverableRow, deliverablesSection, linkStatus, kindBadge };
