"use strict";

// ── 청구 목록 = 데스크톱 넓은 표(2026-07-16 사용자 요청, bookipi 참고) ──
// 컬럼: [체크박스] 상태·청구번호·클라이언트·아티스트·프로젝트·금액·발행·[처리]. 행(데이터 셀)=상세 링크.
// 체크 시 상단 일괄 처리 바(계산서 발행/입금완료). 순수 렌더 계약만 검사(DB 불필요).
process.env.NODE_ENV = "test";
const { tempDbPath, cleanupDb } = require("./helpers");
process.env.DB_PATH = tempDbPath();

const test = require("node:test");
const assert = require("node:assert");
const { db, init } = require("../src/db");
init();
test.after(() => cleanupDb(process.env.DB_PATH, db()));

const { invoiceTable, invoiceBulkBar } = require("../src/views.invoices");

const INV = {
  id: 7,
  title: "도너츠컬처 진혁 청구",
  invoice_number: "OMG-202607-014",
  issued_date: "2026-07-14",
  amount: 220000,
  paid_amount: 0,
  status: "발행",
  tax_status: "계산서 발행",
  client_name: "(주)도너츠컬처",
  payer_kind: "company",
  project_title: "도너츠컬처 진혁",
  project_production: "도너츠컬처",
  project_artist: "진혁",
};
const opts = { isInvoicer: true, ret: "/invoices?filter=done" };

test("청구 목록 표: 헤더(전체선택) + 행 컬럼(상태·번호·클라이언트·아티스트·프로젝트·금액·발행)", () => {
  const html = invoiceTable([INV], opts);
  assert.match(html, /<table class="inv-table">/, "넓은 표");
  assert.match(html, /data-inv-select-all/, "전체 선택 체크박스(헤더)");
  assert.match(html, /<input type="checkbox" data-inv-select value="7"/, "행 체크박스");
  // 데이터 셀 = 상세 링크(행 클릭 → 상세)
  assert.match(html, /<a href="\/invoices\/7\?return=[^"]*" class="inv-cell-link inv-cell-payer font-medium">\(주\)도너츠컬처</, "클라이언트 = 상세 링크");
  assert.match(html, /data-label="청구번호"[^>]*>.*OMG-202607-014/s, "청구번호");
  assert.match(html, /data-label="아티스트"[^>]*>.*진혁/s, "아티스트");
  assert.match(html, /data-label="프로젝트"[^>]*>.*도너츠컬처 진혁/s, "프로젝트명");
  assert.match(html, /data-label="금액"[^>]*>.*₩220,000/s, "금액");
  assert.match(html, /data-label="발행"[^>]*>.*7월 14일/s, "발행일(formatYmdShort)");
});

// 헤더 클릭 정렬(Finder식, 2026-07-18): 정렬 가능 th에 data-sort-key/type + aria-sort, 각 셀에 data-sort-value(원값).
test("청구 목록 표: 헤더 클릭 정렬 계약(data-sort-key/type·aria-sort + 셀 data-sort-value)", () => {
  const html = invoiceTable([INV], opts);
  // 정렬 가능 헤더(상태·금액=num, 발행=date, 청구처=text)
  assert.match(html, /<th class="inv-w-status inv-sortable" data-sort-key="status" data-sort-type="num" aria-sort="none" tabindex="0">/, "상태=num 정렬 헤더");
  assert.match(html, /data-sort-key="amount" data-sort-type="num"/, "금액=num");
  assert.match(html, /data-sort-key="issued" data-sort-type="date"/, "발행=date");
  assert.match(html, /data-sort-key="payer" data-sort-type="text"/, "청구처=text");
  // 셀 원값: 상태=순위(발행→1), 금액=정수, 발행=ISO(표시는 '7월 14일'이라 문자열 정렬 불가 → ISO 원값 필요)
  assert.match(html, /data-label="상태" data-sort-value="1"/, "상태 셀=순위");
  assert.match(html, /data-label="금액" data-sort-value="220000"/, "금액 셀=정수 원값");
  assert.match(html, /data-label="발행" data-sort-value="2026-07-14"/, "발행 셀=ISO 원값");
});

test("청구 목록 표: 아티스트 여러 명은 '외 N', 없으면 —", () => {
  const many = invoiceTable([{ ...INV, project_artist: "아이유, 태연, 진혁" }], opts);
  assert.match(many, /아이유 외 2/);
  const none = invoiceTable([{ ...INV, project_artist: null, project_title: null }], opts);
  assert.match(none, /data-label="아티스트"[^>]*><a[^>]*><span class="text-muted">—/, "아티스트 없으면 —");
});

test("청구 목록 표: 처리 열 = 아이콘 토글(대표·치프) + 상태 배지", () => {
  const html = invoiceTable([INV], opts); // tax_status='계산서 발행' → 계산서 켜짐, 입금 꺼짐
  assert.match(html, /data-label="처리"/, "처리 열");
  assert.match(html, /class="inv-actions"/, "처리 컨테이너");
  assert.match(html, /action="\/invoices\/7\/tax-status"/, "상태 토글 폼");
  assert.match(html, /<span class="inv-icon"><svg/, "아이콘 전용(iconOnly — 밀도 무관)");
  // 툴팁·스크린리더로 의미 전달
  assert.match(html, /title="계산서 발행 완료 \(누르면 되돌리기\)" aria-label="계산서 발행 완료 \(누르면 되돌리기\)"/, "켜진 계산서 툴팁");
  assert.match(html, /title="입금완료로 표시"/, "꺼진 입금 툴팁");
  // 버튼별 의미색(테마 토큰, 배지와 동일 스킴): 계산서 발행=info, 입금완료=success. 계산서 발행됨 → 계산서 버튼 켜짐(info tint), 입금 버튼 꺼짐(success 텍스트).
  assert.match(html, /border-info\/40 bg-info\/10 text-info/, "계산서 발행됨 = info 켜짐(불)");
  assert.match(html, /class="btn-ghost btn-xs text-success"/, "입금완료 버튼 = success 색(꺼짐)");
  assert.match(html, /class="badge/, "상태 배지");
});

test("청구 목록 표: 스태프(비청구권자)는 체크박스·처리 열 없음, 배지만", () => {
  const html = invoiceTable([INV], { isInvoicer: false, ret: "/invoices" });
  assert.doesNotMatch(html, /data-inv-select/, "체크박스 없음");
  assert.doesNotMatch(html, /tax-status/, "상태 변경 폼 없음");
  assert.match(html, /class="badge/, "상태 배지는 보임");
});

test("청구 목록 일괄 처리 바: ids 수집 폼 + 계산서/입금 액션 + 선택 해제(기본 숨김)", () => {
  const html = invoiceBulkBar("/invoices?filter=done");
  assert.match(html, /data-inv-bulk-form/, "일괄 처리 폼");
  assert.match(html, /style="display:none"/, "기본 숨김(선택 0)");
  assert.match(html, /<input type="hidden" name="ids" data-inv-bulk-ids/, "선택 id 수집 hidden");
  assert.match(html, /name="return" value="\/invoices\?filter=done"/, "복귀 경로");
  assert.match(html, /data-inv-bulk-count/, "선택 개수 표시");
  assert.match(html, /name="tax_status" value="계산서 발행" data-bulk-label="계산서 발행 완료"/, "계산서 발행 일괄");
  assert.match(html, /name="tax_status" value="입금완료" data-bulk-label="입금완료"/, "입금완료 일괄");
  assert.match(html, /data-inv-bulk-clear/, "선택 해제");
});

// ── 청구처 정보 카드: 값 열 정렬(2026-07-15 사용자 리포트 '담당자만 밖으로 삐져나옴') ──
// 다른 값은 모두 copyable(클릭 복사)이라 hover 아이콘(⧉) 자리를 오른쪽에 상시 확보하는데, 담당자 이름만
// 순수 텍스트라 그 여백이 없어 텍스트가 한 칸 더 오른쪽으로 나와 보였다 → 담당자 이름도 copyable로 통일.
test("청구처 정보 카드: 담당자 이름도 클릭 복사(값 열 오른쪽 끝 정렬 일치)", () => {
  const { payerInfoCard } = require("../src/views.invoices");
  const html = payerInfoCard(
    { id: 1, kind: "company", name: "(주)도너츠컬처", biz_no: "261-81-02922", owner_name: "고영조", address: "서울", email: "a@b.c" },
    [{ name: "황예지", phone: "010-1111-2222" }]
  );
  assert.match(html, /담당자<\/span><span class="text-right text-sm font-medium"><button type="button" data-copy="황예지"/, "담당자 이름 = copyable");
  assert.doesNotMatch(html, /<span class="font-medium">황예지<\/span>/, "순수 텍스트(정렬 어긋남)로 렌더되면 안 됨");
});

// ── invoiceItemsByInvoiceIds: 데이터 배치 조회(청구서별 그룹·날짜순) ──
test("invoiceItemsByInvoiceIds: 여러 청구서 항목을 한 번에, 청구서별 그룹·날짜순", () => {
  const { invoiceItemsByInvoiceIds } = require("../src/data");
  const d = db();
  const i1 = d.prepare("INSERT INTO invoices (title, amount, status) VALUES ('A', 100, '발행')").run().lastInsertRowid;
  const i2 = d.prepare("INSERT INTO invoices (title, amount, status) VALUES ('B', 200, '발행')").run().lastInsertRowid;
  const ins = d.prepare("INSERT INTO invoice_items (invoice_id, description, quantity, unit_price, amount, item_date) VALUES (?,?,1,?,?,?)");
  ins.run(i1, "나중", 70, 70, "2026-08-01");
  ins.run(i1, "먼저", 30, 30, "2026-07-01");
  ins.run(i2, "단독", 200, 200, null);
  const by = invoiceItemsByInvoiceIds([i1, i2, 99999]);
  assert.equal(by[i1].length, 2);
  assert.equal(by[i1][0].description, "먼저", "청구서 안에서 날짜순");
  assert.equal(by[i2].length, 1);
  assert.equal(by[99999], undefined, "없는 id는 키 없음");
  assert.deepEqual(invoiceItemsByInvoiceIds([]), {}, "빈 입력 안전");
});

// ── 청구 목록 라우트: 상태 필터 + 넓은 표 + 일괄 바 + 복귀 경로 limit 보존(소스 계약) ──
test("청구 목록 라우트: 필터·표·일괄 바·ret limit 보존(소스 계약)", () => {
  const fs = require("fs");
  const src = fs.readFileSync(require("path").join(__dirname, "..", "src", "routes", "invoices.routes.js"), "utf8");
  assert.match(src, /const ret = retPath \+ limitQ/, "행 ret = retPath + limitQ(더 보기 상태 유지)");
  assert.match(src, /invoiceTable\(shown, \{ isInvoicer: invoicer, ret[,)]/, "넓은 표 렌더");
  assert.match(src, /invoiceBulkBar\(ret\)/, "일괄 처리 바(대표·치프)");
  assert.match(src, /\["todo", "done", "paid"\]\.includes\(req\.query\.filter\)/, "상태 필터 파라미터");
});

test("청구 overview 카드: '매출'이 아니라 '발행액'(VAT 포함·매출은 매출 화면 전용)", () => {
  const fs = require("fs");
  const src = fs.readFileSync(require("path").join(__dirname, "..", "src", "routes", "invoices.routes.js"), "utf8");
  assert.match(src, /이번 달 발행액/, "이번 달 발행액 라벨");
  assert.match(src, /올해 발행액/, "올해 발행액 라벨");
  assert.doesNotMatch(src, /이번 달 매출|올해 매출/, "'매출'이라는 단어는 청구 카드에서 제거");
});
