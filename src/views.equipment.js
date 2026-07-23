"use strict";

/**
 * 장비 대장 렌더 — 종류별 그룹 목록 + 추가/편집 폼.
 * 마스터데이터 CRUD(연락처·단가표) 결. 장소·종류는 제안 칩(클릭 시 입력칸에 채움, app.js).
 */

const { esc, formatKRW, searchBox, listGroup, emptyState, dateCombo } = require("./views");
const { formatYmdShort } = require("./lib/date");

/** 제안 칩 묶음 — 클릭하면 대상 입력칸(sel)에 값을 채운다(app.js [data-fill-target]). */
function suggestChips(values, targetSelector) {
  const chips = (values || []).filter(Boolean).map((v) =>
    `<button type="button" class="badge bg-bg text-muted hover:bg-surface" data-fill-value="${esc(v)}" data-fill-target="${esc(targetSelector)}">${esc(v)}</button>`
  ).join("");
  return chips ? `<div class="mt-1 flex flex-wrap gap-1">${chips}</div>` : "";
}

/** 한 장비 행(목록). 종류는 그룹 헤더에 있으니 행엔 생략, 장소·매입가·구매일. */
function equipmentRow(e) {
  const loc = e.location ? esc(e.location) : `<span class="text-muted">장소 미지정</span>`;
  const price = e.purchase_price != null ? formatKRW(e.purchase_price) : "";
  const bought = e.purchased_on ? esc(formatYmdShort(e.purchased_on)) : "";
  const meta = [bought].filter(Boolean).join("");
  return `<a href="/equipment/${e.id}/edit" class="block px-4 py-3 transition-colors hover:bg-surface active:bg-elevated" data-filter-row>
      <div class="flex items-center justify-between gap-4">
        <div class="min-w-0">
          <div class="truncate font-medium">${esc(e.name)}</div>
          <div class="truncate text-xs text-muted">${loc}${e.serial_no ? ` · ${esc(e.serial_no)}` : ""}</div>
        </div>
        <div class="shrink-0 text-right">
          <div class="tabular text-sm font-semibold">${price}</div>
          <div class="text-xs text-muted tabular">${meta}</div>
        </div>
      </div>
    </a>`;
}

function equipmentList(rows, { q = "" } = {}) {
  const search = searchBox({ action: "/equipment", q, placeholder: "장비명 · 종류 · 시리얼 · 장소 검색", label: "장비 검색", liveFilter: true, noButton: true });
  if (!rows.length) {
    return `${search}${emptyState("등록된 장비가 없습니다. '+ 새 장비'로 추가하세요.", { card: true })}`;
  }
  // 종류별 그룹(listEquipment가 이미 종류 순 정렬 — 연속 그룹핑). 빈 종류 = '미분류'.
  const groups = [];
  let cur = null;
  for (const e of rows) {
    const key = e.category && e.category.trim() ? e.category : "미분류";
    if (!cur || cur.key !== key) { cur = { key, items: [] }; groups.push(cur); }
    cur.items.push(e);
  }
  const body = groups.map((g) =>
    `<div class="mb-4" data-filter-group>
        <h3 class="mb-1 px-1 text-xs font-semibold text-muted">${esc(g.key)} <span class="font-normal">${g.items.length}</span></h3>
        ${listGroup({ rows: g.items.map(equipmentRow), filterList: true })}
      </div>`
  ).join("");
  return `${search}${body}`;
}

function equipmentForm(item, { rooms = [], categories = [], locations = [] } = {}) {
  const e = item || {};
  const isEdit = Boolean(item);
  const action = isEdit ? `/equipment/${e.id}` : "/equipment";
  const val = (v) => (v == null ? "" : esc(String(v)));
  // 장소 제안 = 룸 이름 + 기존 장소값(중복 제거는 데이터 레이어가 하지만 뷰도 방어적으로 Set).
  const roomNames = rooms.map((r) => r.name);
  const locSeen = new Set();
  const locSuggest = [...roomNames, ...locations].filter((v) => v && !locSeen.has(v) && locSeen.add(v));
  const del = isEdit
    ? `<form method="post" action="/equipment/${e.id}/delete" data-confirm="이 장비를 대장에서 삭제할까요?"><button class="btn-ghost btn-sm text-danger">삭제</button></form>`
    : "";
  return `<form method="post" action="${action}" class="space-y-3" data-dirty-form>
      <div>
        <label class="label mb-1 text-xs">장비명 <span class="text-danger">*</span></label>
        <input class="input" name="equipment_name" value="${val(e.name)}" autocomplete="off" required />
      </div>
      <div>
        <label class="label mb-1 text-xs">종류</label>
        <input class="input" name="category" value="${val(e.category)}" autocomplete="off" data-equip-category placeholder="예: 마이크 · 프리앰프 · 아웃보드" />
        ${suggestChips(categories, "[data-equip-category]")}
      </div>
      <div class="grid gap-3 sm:grid-cols-2">
        <div>
          <label class="label mb-1 text-xs">시리얼/제품번호</label>
          <input class="input" name="serial_no" value="${val(e.serial_no)}" autocomplete="off" />
        </div>
        <div>
          <label class="label mb-1 text-xs">매입가</label>
          <div class="relative">
            <input class="input pr-7 text-right tabular" type="text" inputmode="numeric" name="purchase_price" value="${e.purchase_price != null ? esc(String(e.purchase_price)) : ""}" placeholder="0" />
            <span class="pointer-events-none absolute inset-y-0 right-2 flex items-center text-xs text-muted">원</span>
          </div>
        </div>
      </div>
      <div class="grid gap-3 sm:grid-cols-2">
        <div>
          <label class="label mb-1 text-xs">구매 시기</label>
          ${dateCombo("purchased_on", e.purchased_on || "", { label: "구매 시기", inputCls: "input w-full py-1.5 text-sm" })}
        </div>
        <div>
          <label class="label mb-1 text-xs">현재 장소</label>
          <input class="input" name="location" value="${val(e.location)}" autocomplete="off" data-equip-location placeholder="룸을 고르거나 직접 입력" />
          ${suggestChips(locSuggest, "[data-equip-location]")}
        </div>
      </div>
      <div>
        <label class="label mb-1 text-xs">메모</label>
        <textarea class="input" name="memo" rows="2">${val(e.memo)}</textarea>
      </div>
      <div class="flex items-center justify-between gap-2 pt-1">
        ${del}
        <div class="ml-auto flex gap-2">
          <a href="/equipment" class="btn-ghost btn-sm" data-no-guard>취소</a>
          <button class="btn-primary btn-sm" type="submit">${isEdit ? "저장" : "추가"}</button>
        </div>
      </div>
    </form>`;
}

module.exports = { equipmentList, equipmentForm };
