"use strict";

/**
 * 외주 작업자 **정산 요약** — 목록·상세 오른쪽 '정산 카드'가 한눈에 보여줄 값들(2026-07-20 사용자 요청
 * '이름·전화만으로 공간을 다 쓰는 건 낭비 — 오른쪽을 정산 카드로').
 *
 * 세 모듈(작업·세션·첨부)에 흩어진 조회를 여기서 합친다. 이 파일은 **소비만 하는 잎 모듈**이라
 * parties↔sessions 같은 순환이 생기지 않는다.
 *
 * ⚠️ 계좌·주민번호는 **등록 여부만** 본다(사용자 결정) — 목록에 번호를 흘리면 화면을 열어둔 채로
 * 어깨너머 노출되고, 정산 직전 알아야 할 건 '이체할 수 있나' 뿐이다(값은 상세 편집 폼에서만 복호화 표시).
 */
const { listTasksForWorker } = require("./parties");
const { listSessionPayoutsForWorker } = require("./sessions");
const { listWorkerFiles } = require("./worker-files");

/**
 * @param {object} worker project_managers 행(외주)
 * @returns {{unpaidAmt:number, unpaidCount:number, paidTotal:number, lastPaidMonth:string,
 *            taskCnt:number, sessionCnt:number, hasAccount:boolean, hasFiles:boolean, items:object[]}}
 *   items = 미지급 항목(최근순) — 카드 미리보기용. 라벨 조립은 뷰 책임(여기선 원값만).
 */
function workerPayoutSummary(worker) {
  if (!worker) {
    return { unpaidAmt: 0, unpaidCount: 0, paidTotal: 0, lastPaidMonth: "", taskCnt: 0, sessionCnt: 0, hasAccount: false, hasFiles: false, items: [] };
  }
  const tasks = listTasksForWorker(worker);
  const sessions = listSessionPayoutsForWorker(worker);

  // 작업·세션을 한 종류로 통합 — 정산은 둘을 구분하지 않고 '지급할 건'으로 다룬다(상세 정산 탭과 같은 관점).
  // 0원(단가 미입력)도 지급 대상이다(2026-07-09 사용자 결정) — 그래서 rate>0 필터를 두지 않는다.
  const items = [
    ...tasks.map((t) => ({
      kind: "task", id: t.id, rate: t.worker_rate || 0, paid: !!t.worker_paid, paidDate: t.worker_paid_date || "",
      project: t.project_title || "", label: t.task_type || "", date: String(t.created_at || "").slice(0, 10),
    })),
    ...sessions.map((s) => ({
      kind: "session", id: s.session_id != null ? s.session_id : s.id, rate: s.worker_rate || 0, paid: !!s.worker_paid, paidDate: s.worker_paid_date || "",
      project: s.project_title || "", label: `${s.session_type || "녹음"} 세션`, date: s.session_date || "",
    })),
  ];
  const unpaidItems = items.filter((x) => !x.paid).sort((a, b) => String(b.date).localeCompare(String(a.date)));
  const paidItems = items.filter((x) => x.paid);
  // 최근 지급월 = 지급일 중 가장 최신의 'YYYY-MM'(지급일이 없는 레거시 지급분은 제외).
  const lastPaidDate = paidItems.map((x) => x.paidDate).filter(Boolean).sort().pop() || "";

  return {
    unpaidAmt: unpaidItems.reduce((s, x) => s + x.rate, 0),
    unpaidCount: unpaidItems.length,
    paidTotal: paidItems.reduce((s, x) => s + x.rate, 0),
    lastPaidMonth: lastPaidDate ? lastPaidDate.slice(0, 7) : "",
    taskCnt: tasks.length,
    sessionCnt: sessions.length,
    // 이체에 필요한 최소 조건 = 은행 + 계좌번호(예금주는 없으면 이름으로 보내는 실무가 있어 필수로 보지 않는다).
    hasAccount: Boolean(worker.bank_name && worker.account_number),
    hasFiles: listWorkerFiles(worker.id).length > 0,
    items: unpaidItems,
  };
}

module.exports = { workerPayoutSummary };
