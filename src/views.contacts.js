"use strict";
// 연락처 전용 뷰(2026-07-17 마스터-디테일 전환) — 왼쪽 이름 목록 + 오른쪽 읽기/편집 패널.
// 표(contactTable)를 걷어낸 이유: 연락처는 '비교'가 아니라 '찾기' 화면이라 열 폭 튜닝이 계속 실패했다(설계 문서 참조).
const { esc, personName, listGroup } = require("./views");

/**
 * 2단 골격. lg 이상 = [이름 목록 18rem | 상세]. 미만 = 한 단(선택 여부로 한쪽만).
 * 서버가 선택 여부를 알고 클래스를 정하므로 JS가 없다.
 * @param {{left:string, right:string, hasSelection:boolean}} o
 */
function contactPanes({ left, right, hasSelection }) {
  const leftCls = hasSelection ? "hidden lg:block" : "block";
  const rightCls = hasSelection ? "block" : "hidden lg:block";
  return `<div class="lg:grid lg:grid-cols-[18rem_minmax(0,1fr)] lg:gap-6 lg:items-start">
      <div class="${leftCls} lg:sticky lg:top-4">${left}</div>
      <div class="${rightCls} min-w-0">${right}</div>
    </div>`;
}

/**
 * 이름만 있는 마스터 목록(애플 연락처식). 소속·역할·전화를 넣지 않는 게 요점 — 폭 경쟁이 사라진다.
 * `listGroup({filterList:true})`가 app.js 실시간 필터 계약(data-filter-list/data-filter-empty)을 제공한다.
 * @param {{rows:object[], selectedId?:number|null, hrefFn:(row:object)=>string}} o
 */
function contactNameList({ rows, selectedId = null, hrefFn }) {
  const items = rows.map((c) => {
    const active = Number(selectedId) === Number(c.id);
    const cls = active ? "bg-primary/10 font-semibold text-fg" : "text-fg";
    return `<a href="${esc(hrefFn(c))}" class="row-link block truncate px-3 py-2 text-sm ${cls}"${active ? ' aria-current="true"' : ""}>${esc(personName(c))}</a>`;
  });
  return listGroup({ rows: items, filterList: true });
}

module.exports = { contactPanes, contactNameList };
