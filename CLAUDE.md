# OMG Studios Manager — 설계 일지 (CLAUDE.md)

> 녹음/믹싱 스튜디오 **프로젝트 관리 · 자료 전달 · 청구** 내부 웹앱.
> 녹음실 내부 전용 도구. 역할 3단계: **대표(owner)** = 전체 모니터링 + 청구 열람·관리,
> **치프 엔지니어(chief)** = 운영 전반(스태프·담당자·클라이언트·설정 관리 + 프로젝트 편집 + 청구),
> **스태프(staff, 엔지니어·매니저)** = 프로젝트·곡·작업·자료 편집까지. 전원 Google 화이트리스트
> 로그인(치프가 허용한 계정만). 클라이언트(아티스트/소속사/제작사)는 프로젝트 데이터로 존속하고 로그인하지 않는다.
> 선행 플레이북 2종(`webapp-build-playbook.md`, `녹음실-앱-개발-경험-플레이북.md`)의 검증된 패턴·함정 반영.
> 이 파일은 **살아있는 설계 일지**다(현재 상태·아키텍처·데이터 모델·env·함정·TODO).
> **[필수] 모든 기능 추가·수정·삭제 커밋 직후, 사용자 요청이 없어도 이 파일과 `WORKFLOW.md`를 반드시 현행화한다** — 현재 상태·데이터 모델·env·변경 이력·완료(이번 세션) 섹션을 함께 갱신·커밋(2026-06-30 사용자 지시).
> 상세 변경 근거는 git 커밋 메시지에 있다. 배포 런북=`DEPLOY.md`, 작업 이어가기=`WORKFLOW.md`.

## 현재 상태 (2026-06-30)

**프로덕션 라이브**: `https://omg-studios-manager.onrender.com` (Render web + 일일 백업/연체 cron). 기능별 현재 동작:

### 인증 · 권한
- 전원 Google OAuth + 화이트리스트(`users`) 로그인 → httpOnly 서명 JWT(30일). 비밀번호 로그인 폐기.
- 3단계 역할: **대표(owner)**=전체 열람 + 청구 + **외주 정산(지급)**, **치프(chief)**=운영 전반, **스태프(staff)**=프로젝트·작업·자료 편집 **+ 청구서 발행**(매출·외주 정산 제외).
- 미들웨어: `requireAuth`(보기) / `requireEditor`(편집, 대표 차단) / `requireChief`(관리) / `requireBilling`(청구서 발행=전원) / `requireInvoice`(매출·외주 정산=치프·대표).
  내부 도구라 로그인 직원은 전 프로젝트 열람. 치프가 `/settings`에서 화이트리스트(이메일+역할) 운영.

### 프로젝트
- **유형 구분 없음**(2026-06-30 폐기): 세션 일정 자체가 클라이언트 방문·예약이고 녹음/믹스는 그 안에서 일어나므로 프로젝트 단에서 세션/작업을 나누지 않는다. **모든 프로젝트가 세션 일정 + 곡·콘텐츠를 동일하게** 갖는다. "+ 새 프로젝트"는 단일 진입. `project_type`/`PROJECT_TYPES`는 레거시 컬럼·상수로만 보존(신규=`session` 고정, 편집 시 기존값 유지, UI 미노출·드롭다운/배지 제거).
- 상세는 **탭**: `프로젝트(메타) / 세션 일정 / 곡·콘텐츠 / 자료 전달 / 청구`(청구 탭=치프·대표·스태프). 세션 일정 탭은 **전 프로젝트 노출**. 메타 편집은 **'프로젝트' 탭**(첫 탭·기본), URL `?tab=`.
- 메타('프로젝트' 탭): 프로젝트명·아티스트 / 아티스트·소속사/레이블·제작사 / **고객측 담당자**(연락처 콤보 `contactCombo` — 선택 시 **전화·이메일·소속 즉시 표시**, 목록에 없는 이름 입력 시 저장하면 **새 연락처 자동 생성·연결**) / **담당 엔지니어**(스튜디오 내부, `manager_id`) / 메모. **마감일 제거**(2026-06-30 — 프로젝트 마감일 개념 폐기, `due_date`는 레거시 컬럼·청구 입금마감일과 별개). **청구처(실결제자)도 메타에서 제거** — 청구 직전에 알게 되므로 **청구 섹션에서 결정**. `projects.client_id`는 저장 시 제작사›소속사›아티스트 우선순위로 **자동 파생**(표시·대시보드·클라이언트 연결용). 아티스트/소속사/제작사는 `<datalist>` 자동완성(브라우저 히스토리 끔).
- 목록=한 줄 요약 카드 + 검색(`?q=`). **결제 예정 금액 = 작업액 + 세션액**(작업액=Σ`COALESCE(NULLIF(total_price,0), task_types.unit_price)` — **확정 금액 없으면 종류 기본단가로 폴백**, 청구 폼 기본값과 동일; 세션액=`sessionAmountsByProject`). 2026-07-01 수정: 단가표 가격이 0일 때 만든 작업은 `total_price=0`이라 목록에서 빠지던 것(녹음 세션은 들어오는데 믹스 등 작업이 누락) → 종류 기본단가 폴백으로 청구 폼과 일치.
- 삭제=치프·스태프(`requireEditor`, 2026-07-01 스태프 개방; 상세 메타 하단, CASCADE: 트랙·세션·자료 / 인보이스는 `project_id=NULL` 보존). **청구된 작업·세션이 있으면 삭제 거부**(`PROJECT_HAS_INVOICED`).
- **곡 일괄 추가**: 줄바꿈으로 여러 곡명 한 번에 추가.

### 세션 일정(예약)
- 프로젝트 하위 세션 CRUD + 사이드바 `/sessions`(**목록/캘린더 뷰 전환** `?view=`; 목록=다가오는/지난, 캘린더=월 그리드 `?month=YYYY-MM`, `monthCalendar`/`sessionsForMonth`). 예약 담당자·담당 엔지니어 별개(담당자 마스터 select; **예약 담당자 '미지정' 옵션 제거 — 환경설정 기본 예약담당자 자동 선택**, `admin_state.default_booker`). **담당 디렉터 다대다(여러 명)**=고객측 연락처 콤보 반복 입력(`session_directors(session_id, contact_id)` 조인 테이블; 폼은 '+디렉터 추가'로 행 복제[template]·'✕'로 제거, app.js 콤보는 **위임 처리**라 동적 행도 자동 동작; 각 행 이름 입력·목록 선택, 목록 외 이름은 같은 이름 재사용 후 없으면 새 연락처 생성 `resolveDirectorIds`). 레거시 `sessions.director_contact_id`는 첫 디렉터로 동기화 보존. 연락처 상세 '참여 세션'은 조인+레거시 모두 조회(`listSessionsForContact`), `classifyContact` 디렉터 배지도 동일.
- **폼 레이아웃(추가·편집 완전 통일)**: 추가·편집 모두 `sessionBookingFields`(날짜·예약·상태 / 세션종류·**녹음 단가 항목**(세션 종류=녹음일 때만 노출)·엔지니어·**룸** / **시작 그리드+직접입력** / **소요 슬라이더**). 편집 폼은 기존 시간으로 슬라이더 초기화(`minutesBetween`), 저장 시 시작+소요로 종료 산정. `app.js`가 `[data-session-form]`을 **폼별로 초기화(멀티폼)**. **세션 종류(녹음/믹싱/마스터링/기타)는 항상 선택 가능**. 세션 저장 버튼도 추가 버튼처럼 full.
- **용어 통일**: `녹음 종류` = **단가표 항목**(`rate_item_id`, 스튜디오/로케이션 분류 optgroup, `rateSelectGrouped`).
  `세션 종류` = `session_type`(녹음/믹싱/마스터링/기타). 추가·편집 폼에서 동일 의미(이전 라벨 혼동 정리).
- 예약 폼=버튼 UX: 시작 시간 그리드(**운영시간 기반 동적 생성** — `studioStartSlots`가 `admin_state.studio_hours` 읽음; 예약된 슬롯 회색, **선택=테두리 강조**). 그리드 밖은 '직접입력' →
  **텍스트 직접입력**(HH:MM; 숫자만 입력하면 콜론 자동 삽입 `1425`→`14:25`, `pattern`+서버 `cleanTime` 검증). (이전의 '녹음 종류 미선택 시 시작 시간 비활성' 필수 게이트는 세션 종류 가변화로 **미사용** — 대신 세션 종류=녹음일 때만 녹음 단가 항목 select 노출로 대체. `rateSelectGrouped`의 `required`/`data-rate-required` 인터페이스 보존.)
- 소요시간 **슬라이더**(30분 단위·최대 12시간) + 아래 `[1Pro][2Pro][직접입력]` 프리셋(슬라이더와 양방향 동기화). 종료는 서버가 시작+길이로 계산(`custom_hours`+`duration_mode=custom`, 1Pro=녹음 종류 기준시간).
  폼 인터랙션은 `public/js/app.js`(CSP: 인라인 0).
- **다중 룸**: `rooms` 테이블 + `sessions.room_id`. 세션 폼에 룸 select(**첫 룸=A룸 기본 선택, '룸 미지정'은 맨 아래 옵션**). 겹침 검사를 `IFNULL(room_id,0)`으로 룸별 판정 — **같은 룸만 충돌, 다른 룸은 동시간 병렬 허용**(레거시 NULL끼리는 가상 룸 0으로 처리). 룸 CRUD는 `/settings` 환경설정 탭(`POST /settings/rooms`, `/:id/delete`). 기본 '메인 룸' 1회 시드.
- **겹침 차단**: **앱 DB 룸별 겹침이 정식 차단**(409) — **모든 세션 종류(녹음·믹싱·마스터링·기타)가 룸을 점유**(같은 룸·같은 시간 더블부킹 방지, `findSessionConflict`/`busySessionSlots` session_type 무관). 구글 FreeBusy 하드차단은 **비활성화** — 단일 캘린더로는 룸 구분 불가(캘린더 일정 자동 생성/수정/삭제 동기화는 유지).
- **구글 캘린더 자동 연동**: 예약 시 스튜디오 캘린더에 일정 자동 생성/수정/삭제(제목=제작사·아티스트, 장소=기본 장소,
  `gcal_event_id` 추적). 미연동/오류는 fail-safe(예약은 정상). 세션 '취소' 시에도 캘린더 일정 삭제 동기화. 역방향(캘린더→앱) 동기화는 미구현(보류).
- **예정 세션 1클릭 완료**: 세션 목록/상세에서 '예정' 상태 행에 완료 버튼 인라인 제공(별도 편집 폼 없이). **`/sessions` 목록 검색**(`?q=`) 지원. 청구 결핍 사유(미완료·단가 미선택·시간 없음)는 청구 생성 폼에 인라인 표시.

### 곡 · 콘텐츠 (녹음과 별개의 후반작업)
- 프로젝트 하위 곡/콘텐츠(`project_tracks`) + 모듈형 작업(`track_tasks`). **진행 단계 빠른 버튼**(보컬튠·오디오편집·믹싱·
  마스터링, +기타는 전체 종류 그룹 드롭다운), 곡별 **진행 요약** 한 줄, 작업 행 = **헤더 접기 토글**(`<details>`, 우측 chevron·**상태 select는 그 앞 — 접힌 채로도 수정 가능**[헤더에 `<select form="task-form-<id>">`로 본문 폼에 연결, `[data-no-toggle]`+app.js click preventDefault로 펼침 방지]; 펼치면 종류·담당·외주단가 편집 폼, **추가 시 자동 펼침** `?expand=`). 헤더의 종류 라벨·담당 엔지니어는 `data-row-type`/`data-row-engineer`로 **변경 즉시 갱신**(자동저장 응답의 typeLabel·engineerName). **후반작업은 전부 트랙/콘텐츠 고정·수량 1**(과금 유형·수량 선택 UI 폐기). **금액은 곡·콘텐츠 탭이 아니라 청구 탭에서 확정**(2026-07-01 — 세션 일정과 동일 철학: 작업 폼은 **종류·담당·상태만** 기록, 금액 칸 없음. 작업 생성·수정 시 종류 기본단가[`task_types.unit_price`]를 `total_price`에 **자동 적용**[`taskTypeUnitPrice`], 청구 생성 폼에서 작업별 금액 입력·조정해 최종 확정). 작업 행 헤더는 **청구된 작업의 확정액만** 표시(미청구는 숨김 — '기록만' 일관).
- 작업 폼에 **담당 엔지니어 select**(value=`project_managers.id`, 외주 포함) + **외주 지급단가**(`worker_rate`) 입력 — **담당 엔지니어가 외주 작업자일 때만 노출**(하우스 엔지니어=`user_id` 있으면 숨김·저장 시 0; engineerSelect `data-external`·app.js 토글). 저장 시 `engineer_id` 기록(→ `engineer_name` 동기 기록). 외주 정산 합계 = Σ`worker_rate`(고객 청구 `total_price`는 마진 참고 표기). **새 작업의 담당 엔지니어는 로그인 계정 기본 선택**(`createTask`가 `getManagerByUserId(user.id)`로 본인 담당자를 기본값 — 빠른 추가 시 본인 자동 배정; 명시 선택 시 우선).
- **작업 폼 자동저장**(저장 버튼 없음 — 변경 즉시 저장[select 즉시·텍스트 700ms 디바운스]). app.js가 **위임(delegation)**으로 처리(헤더 상태 select가 `form=`로 연결돼 폼 밖에 있으므로 `el.form`으로 폼 판정). POST `/tasks/:id`가 `X-Requested-With:fetch`면 redirect 대신 JSON(`typeLabel`·`engineerName`·`amount`) 응답 → app.js가 헤더 `data-row-type`/`data-row-engineer`/`data-row-amount` 갱신·'저장됨' 표시. **⚠️함정: 자동저장 body는 반드시 `URLSearchParams`(urlencoded)** — 서버가 `express.urlencoded`만 파싱하므로 `FormData`(multipart)로 보내면 req.body가 비어 **기본값으로 저장**됨(자동저장이 반영 안 되던 근본 원인, 2026-07-01 수정). JS 미동작 폴백=`<noscript>` 저장 버튼.
- **청구 폼 작업 금액 즉시 저장**(2026-07-01): 청구 생성 폼의 작업별 금액칸(`task_amount_<id>`)을 수정하고 포커스가 떠나면(change) **그 작업 `total_price`에 바로 저장**(`POST /projects/tasks/:id/amount`→`setTaskAmount`, 청구된 작업은 거부) — 초안이 아니라 즉시 기록되어 **프로젝트 목록 결제 예정 금액·청구 폼 기본값에 바로 반영**(청구서 생성 전에도). app.js가 `task_amount_<id>` change를 위임 처리(세션 금액칸은 제외 — 세션은 단가표 산정).
- **곡·콘텐츠 청구 완료요건**: 청구 생성 폼에서 **완료(Completed) 작업만 기본 체크**, 미완료 항목은 흐리게 표시·체크 해제 + 안내 메시지(녹음 세션 완료 강제와 동일 규칙 통일). **각 작업에 금액 입력칸**(`task_amount_<id>`, 기본값=종류 기본단가; 체크·금액 변경 시 공급가·VAT·총액 실시간 갱신 `data-line-row`/`data-line-input`, app.js `lineAmount`). 청구 생성 시 입력 금액으로 작업 `total_price` 확정(`createInvoiceFromTasks` `taskAmounts`), **0원은 청구 불가**(`TASK_AMOUNT_REQUIRED`). 미청구 후보는 `total_price>0` 조건 없이 노출(금액은 청구 시 정함).
- 청구된 작업(`is_invoiced=1`)은 수정·삭제 거부(invoice_items 스냅샷 보존). 트랙 삭제는 작업 CASCADE.

### 청구
- 인보이스 생성/수정/입금(부분→발행 유지·전액→입금완료)·상태 전이(미발행→발행→입금완료)·연체 파생.
  채번 `INV-YYYYMM-###`(원자화: `BEGIN/COMMIT/ROLLBACK`으로 중복 방지), VAT=공급가 10%, 돈=정수(원).
- 청구 탭 **청구 생성 폼**: **청구처 선택**(`clientCombo`, 기본값=프로젝트 자동파생값, 미선택 시 폴백 — 청구처 결정 지점) + **완료** 작업 + **청구 가능 녹음 세션**(녹음+단가+시간, 취소 제외)을 함께 체크박스로 노출 → 선택해 청구서로. **생성 즉시 발행**(폼에 안내); 발행/입금완료 인보이스의 **청구처 변경은 409 잠금**(미발행만 변경, `resolveInvoiceRefs`는 폼 선택 우선·미제공 시에만 프로젝트 폴백). **할인**(선택): 청구서 단위(정액 원·정률 %), **공급가에서 차감 후 VAT 재계산**(과세표준=공급가−할인, VAT=과세표준×10%, `invoiceAmountsFromSupply`); 공급가는 **체크한 항목 합으로 동적**(app.js `[data-discount-form]`·`data-line-amount`), 거래명세서는 소계→할인→과세표준→VAT→합계. `invoices.discount_amount`, from-tasks 주 경로(수동 인보이스는 표시용 저장). **공급가·VAT·총금액 카드를 발행일 위에 강조**(app.js 줄별 갱신). **부가세 포함 토글**(기본 체크, 해제 시 VAT 0=현금 거래, `vatIncluded`→`invoiceAmountsFromSupply`/`createInvoiceFromTasks`). **담당자(연락처)도 청구처 선택 가능**(`clientCombo`에 담당자 옵션·`payer_contact_id`→`ensureClientFromContact`로 **`source_contact_id` contact별 '기타' 클라이언트 매핑**[동명이인 병합 방지]·콤보 라벨에 소속·전화·#id 식별자). **수동 인보이스도 VAT 포함 토글**(미체크 시 현금 VAT 0, 거래명세서 VAT 줄 생략)·**담당자 청구처 선택**(평면 select→콤보[클라이언트+담당자]·`payer_contact_id`→`resolveInvoiceRefs`에서 `ensureClientFromContact` 변환, from-tasks와 동일 UX).
  미완료 작업은 흐리게·체크 해제(세션 완료 강제와 동일 규칙). 청구 목록 **검색**(`?q=` 제목·채번·클라이언트).
  **녹음 세션은 곡·콘텐츠/버튼 없이 직접 청구**: **완료 처리한** 녹음 세션의 예상 청구액이 청구 탭에 자동 노출(예정은 '완료 시 청구' 힌트만), 선택 시 `invoice_items.session_id` 스냅샷으로 청구(곡·콘텐츠 안 거침). **세션 금액도 작업처럼 청구 폼에서 수정 가능**(`session_amount_<id>` 입력칸, 기본값=단가표 산정액 `s.billing.amount`; `data-line-input`로 공급가·VAT 실시간 갱신, 청구 시 입력값으로 `invoice_items` 스냅샷 확정[`createInvoiceFromTasks` `sessionAmounts`], **0원 가드 `TASK_AMOUNT_REQUIRED`**). 청구되면 세션 수정·삭제 잠금(`SESSION_INVOICED`), 인보이스 삭제 시 자동 미청구 복원. 관련: `listBillableSessionsForProject`(작성순 정렬 `created_at ASC`)·`unbilledInvoiceForm`·`createInvoiceFromTasks`(task+session 혼합)·`isSessionInvoiced`.
- **청구서 수정 폐기 — 발행=확정, 변경은 삭제 후 재발행**(2026-07-01): 청구서는 **발행이 곧 확정**이고 항목(invoice_items)은 스냅샷이므로 **수정 기능을 전부 제거**한다. 인라인 '✎ 청구서 수정' 폼·전체화면 '수정' 버튼·`GET /invoices/:id/edit`·`UPDATE` 라우트(`POST /invoices/:id`)·`invoiceForm` embed/isEdit 분기·`projects.routes`의 `editForm` 첨부·`invoiceForm` export 모두 삭제. 내용을 바꾸려면 **삭제(`/delete`) 후 다시 발행**(청구 탭·전체화면 모두 삭제 버튼 옆 안내문 '수정이 필요하면 삭제 후 다시 발행하세요'). `invoiceForm`은 **수동 생성 전용**(create-only)으로 단순화.
- **청구 탭 인보이스 인라인 펼침**: 청구 탭의 각 인보이스 행을 클릭하면 **그 자리에서 펼쳐**(`<details>`, `invoiceRow` compact=펼침형·`invoiceExpandBody`[views.invoices.js]) 금액 내역(총액·할인·VAT·입금·미수·납입상태·발행일·마감일)·**청구 항목**·**입금/상태 처리·삭제**(치프·대표·스태프)·**PDF**(거래명세서/내역서/견적서, 미발행은 견적서만)·'전체 화면으로 ↗'(`/invoices/:id`) 링크를 표시 — **청구 메뉴로 이탈하지 않고 프로젝트 안에서 청구 업무 완결**(수정은 없음, 변경=삭제 후 재발행). 입금(`/pay`)·상태(`/status`)·삭제(`/delete`) 폼은 `return` hidden(프로젝트 청구 탭, **open-redirect 차단=내부 절대경로만**·`returnTo` 헬퍼)으로 복귀하고 `?open=ID`로 **처리한 인보이스가 펼쳐진 채** 유지(app.js `?open=` 스크롤). 라우트는 각 인보이스에 `listInvoiceItemsForInvoice` 항목을 첨부해 넘긴다(프로젝트당 소수·N+1 무해). **청구 생성(from-tasks '선택 항목으로 청구 생성'·수동 '금액 직접 입력')도 같은 정책으로 프로젝트 청구 탭에 복귀**(`?open=새 id`로 새 청구를 펼친 채 노출). **수동 생성 폼만 별도 페이지**지만 `return`(쿼리/hidden)으로 사이드바·뒤로가기·저장/취소를 모두 프로젝트 청구 탭으로 유지(`returnTo` extra=`open`, `safePath` open-redirect 차단; 에러 재표시 때도 맥락 보존). → **청구 메뉴(`/invoices`)는 만들어진 청구를 모아 보는 곳**으로 역할 분리(프로젝트에서 시작한 청구의 생성·삭제는 프로젝트를 벗어나지 않는다).
- **견적서 발행 허용**: 미발행 상태 인보이스도 견적서 PDF 발행 가능 — **미발행 초안도 3종(견적서·내역서·거래명세서) PDF 발행 허용**(참고용 문서라 상태 무관). 발행알림은 미발행→발행/입금완료 **첫 전이에만** 발송. **청구 탭 from-tasks 주 경로 포함** 모든 발행이 `notify.js` 공용 `notifyInvoiceIssued(inv)`로 통지(수동·자동 경로 일원화).
- 프로젝트 삭제 시 청구된 작업·세션이 있으면 거부(`PROJECT_HAS_INVOICED`).
- 대시보드: 미수금·이번 달 발행·연체(치프/대표만) + **오늘·이번 주 세션 카드**(`upcomingSessions`).
- **매출 현황**(`/revenue`, 사이드바 청구 그룹, 대표·치프 `requireInvoice`): 담당 엔지니어별 매출 = 작업(`track_tasks.engineer_id`별 Σ`total_price`) + 세션(`engineer_name`별 Σ`computeRatePrice`, 취소 제외). 행 클릭 시 담당 작업·세션 내역(`revenueByEngineer`/`revenueForEngineer`).
- **거래명세서 PDF**: 발행/입금완료 인보이스 → A4 PDF(`GET /invoices/:id/statement.pdf`, resvg+pdf-lib, `src/invoice-pdf.js`).
  레이아웃: 좌측 **제목**(거래명세서/내역서/견적서 — `?type=`로 선택, `DOC_TYPES`) + 공급자 헤더·**로고**(우측), 청구처 박스, **품목|금액** 표(수량·단가 생략 — 곡/세션 단위 고정), 소계/VAT/합계, **납부하실금액** 강조(견적서는 '견적 금액'·전용 푸터).
  공급자=스튜디오 세금정보·로고(환경설정), 공급받는자=클라이언트. `requireInvoice`·`no-store`·즉석 스트리밍(PII 최소화). 한글 폰트 `public/fonts`(서브셋 TTF) 번들.

### 클라이언트
- 통칭 **클라이언트** 마스터(`clients`: 아티스트/소속사·레이블/제작사/기타, `?kind=` 탭 필터). 프로젝트 저장 시 분류별 자동 등록. **치프·스태프 모두 열람·편집**(`requireEditor`, NAV `access:"editor"`) — **첨부 서류도 스태프 개방**(2026-07-01, requireChief→requireEditor: 직원 업무 편의; 여전히 인증 다운로드·공개 링크 없음).
  **목록 이름 검색**(`?q=`). **상세**(`GET /clients/:id`): 탭 = 진행 프로젝트(이름 매칭 또는 청구처) / 청구·결제(청구처 인보이스 전체 + 합계·입금·미수).
  세금계산서 정보(`biz_no`·`owner_name`·`address`; **아티스트(개인)는 세금정보 대신 현금영수증 정보**[`cash_receipt_no` — 휴대폰 번호/현금영수증 카드번호] 입력. app.js `[data-client-kind]`가 분류=아티스트면 세금블록 숨기고 현금영수증블록 표시, 서버는 분류에 따라 반대 필드 null 강제). **청구처**(=실결제자, `client_id`)=클라이언트가 특정 인보이스에서 갖는 결제 역할(청구 생성 폼에서 결정).
- **상세에 담당자 연락처**: 회사(client) 상세 상단에 그 회사의 **현재 소속 연락처(직원)** 목록(`listContactsForClient`, `ended_on IS NULL`) 노출.
- **첨부 서류**(사업자등록증·통장사본): 클라이언트 수정 폼에서 **드래그앤드롭/파일선택 업로드 + 열람**(`client_files`, 종류별 1개 교체식). 매직바이트 검증(PNG/JPEG/PDF, Content-Type 무시)·10MB·치프 전용 인증 다운로드(`inline`·`no-store`·**공개 링크 없음** — 민감 금융정보). `POST /clients/:id/files/:kind`·`GET .../raw`·`.../delete`, app.js `[data-dropzone]`.

### 연락처 (클라이언트 측 담당자)
- 클라이언트 회사와 **별개의 '사람' 마스터**(`contacts`): 레이블/제작사 직원·프리 매니저·아티스트 지인 등. 사이드바 `/contacts` 독립 메뉴(NAV `access:"editor"`, 라우트 `requireEditor` — 치프·스태프 편집, **대표 제외·메뉴 미노출**). 목록·이름/전화 검색(`?q=`)·CRUD. 메뉴 아이콘=명함(클라이언트 '여러 사람'과 구분). **필드**: 성·이름·호칭·별명·회사·직책·부서·휴대전화·이메일·메모. 표시명(`name`)은 미입력 시 호칭+성+이름(또는 별명)으로 자동 생성(`resolveContactName`).
- **Google 연락처 양방향 동기화**(People API, **fail-safe**): 앱에서 생성/수정/삭제 시 Google에 push(`people.js`·`google_resource_name`/`etag`); **수동 'Google 동기화' 버튼**(`POST /contacts/sync`, `syncFromGoogle` syncToken 증분)으로 Google 변경(생성/수정/삭제)을 앱에 반영(**삭제 양방향**, 루프 방지=data.js 직접호출). scope `.../auth/contacts`(치프 재로그인 필요), 미연동 시 앱만 정상. 자동 cron은 사용자 요청으로 제거(수동 버튼만).
- **소속 이력(이직 히스토리)**: `contact_affiliations` 타임라인. `ended_on IS NULL`=현재 소속(가장 최근 1건), `client_id` NULL=무소속(프리·지인). **이직**=소속 추가 시 `closeCurrent`로 기존 현재 소속을 자동 종료(`ended_on`)하고 새 소속 INSERT. 상세에 현재(`badge-success`)/종료(`badge-neutral`) 타임라인 + 추가·이직/종료/삭제 + 연결 프로젝트.
- **생성 시 현재 소속 입력**: 새 연락처 폼에 소속 회사 select(무소속+`listClients`)+직함 → 생성과 동시에 첫 소속 등록(`addAffiliation`, `closeCurrent=false`) → 회사 상세 직원 목록에 즉시 반영.
- **프로젝트 연결**: 프로젝트 메타의 '고객측 담당자'(`contactCombo`, `projects.contact_id`) — 선택 시 전화·이메일·소속을 즉시 표시(`contactOptions`에 email 포함·datalist `data-*`·app.js `[data-contact-info]`), **목록에 없는 이름 입력 시 저장하면 새 연락처 자동 생성**(`resolveContactId`→`createContact`, 이름만; 전화·소속은 연락처 메뉴에서 보강). 내부 '담당 엔지니어'(`manager_id`)와 별개.
- **담당자(외주·하우스) 연동**: 전 담당자(`project_managers`)가 연락처에 **자동 노출**(`contact_id` 백필). 연락처에서 전화 수정→담당자 동기화(**양방향**), 이메일은 외주만 양방향·**하우스는 연락처에서도 잠금**(`users.email` 보호, 폼 readonly). 연락처 목록·상세에 외주/하우스 배지. **담당자→연락처 연동 시 이름을 성·이름 자동 분리**(`splitKoreanName`[`src/lib/korean-name.js`], 김준상→성 김·이름 준상). 담당자 **추가·수정 시 `ensureContactForManager` 런타임 호출**로 연락처+성이름 생성(settings/workers 4지점, 트랜잭션 원자화) + db.js 기동 백필도 family/given 채움(기존 연락처 1회 보강·수동 입력 보존). **대표(owner)는 작업 담당자가 아니므로 연동 제외**(`getManagerByContactId`가 owner 제외, `syncUserToManager`가 owner는 비활성). `ensureContactForManager`/`syncContactToManager`/`syncManagerToContact`.

### 자료 전달
- 업로드(multer 디스크) → Drive/로컬 폴백 → 인증 다운로드(프록시) + 공개 만료 토큰 링크 `/d/:token`(다운로드 카운트·철회·만료).
- **권한**: 자료 전달은 **편집자(치프·스태프)만** — 사이드바 메뉴·`/deliverables`·인증 다운로드·프로젝트 상세 '자료 전달' 탭 모두 **대표 제외**(NAV `access:"editor"`=canEdit, 라우트 `requireEditor`). 공개 토큰 링크 `/d/:token`만 인증 불필요(유지).

### 관리(/settings) — 3탭
- **담당자**: 하우스 엔지니어(로그인, 작업 담당자 자동 연계; **각 행 '정보 수정'으로 이름·전화 편집** `POST /settings/users/:id/edit` — 이름은 users+작업 담당자 동기화, 전화는 작업 담당자 행). **외주 작업자는 `/workers` 메뉴로 일원화 완료** — 이 탭에서는 안내 링크만 표시(기존 `/settings`의 외주 추가/삭제 폼 제거). **역할 변경**(`POST /users/:id/role`): 비본인은 역할 select(치프↔스태프↔대표) 노출 — **본인은 자기 역할 변경 불가**, **치프→비치프 강등 시 본인 제외 활성 치프 0이면 거부**(최소 1명, `flash=last_chief`). 삭제 잠금은 기본 치프·본인 유지(락아웃 방지).
- **`/workers` 권한 분리**: 목록·상세 열람 + **정산(지급 처리/취소)** = 대표·치프(`requireInvoice`), 작업자 **추가·삭제·정보수정**(마스터) = 치프(`requireChief`). 추가 폼·삭제·수정은 치프에게만 노출. 외주 **정보 수정**(이름·전화·이메일)=상세 `POST /workers/:id/edit`(이름 변경 시 `track_tasks.engineer_name` 동기화로 정산 매칭 유지). 외주 **지급단가**(`worker_rate`) 입력은 작업 편집(`requireEditor`=치프·스태프)이라 대표는 단가는 안 건드리고 **지급만** 실행. 흐름: 치프/스태프 외주단가 입력 → 완료 → 대표/치프 정산 탭 지급.
- **컨텐츠**: 단가표(녹음 종류)·**작업 종류 카탈로그**(곡·콘텐츠 후반작업 종류 + 기본단가·과금·빠른추가; **분류 개념 폐기** — 곡·콘텐츠 작업은 모두 후반작업이라 분류 선택 UI 제거, `task_group`은 레거시 컬럼으로만 보존). 모두 삭제-only.
- **환경설정**: 스튜디오 캘린더(자동 연동 대상)·예약 일정 기본 장소·**운영시간**(스튜디오 영업 시작·종료·간격, `POST /settings/studio-hours`, `admin_state.studio_hours` 백킹 → 예약 그리드 동적 생성)·**룸 CRUD**(추가/삭제, `POST /settings/rooms`, `/:id/delete`)·**공급자(스튜디오) 세금정보 + 로고**(거래명세서 PDF용; 로고는 PNG/JPG 업로드→base64, 매직바이트 검증)·알림 웹훅 URL.

### 배포 · 운영
- Render Blueprint(web + cron) + Disk. 일일 백업(`VACUUM INTO`·14일 보존)·연체 스캔 cron(`/internal/cron/daily`, `BACKUP_TOKEN`).
  정적 자산 캐시 버스팅(`?v=` mtime+size).
- **알림(웹훅)**: 연체·청구 발행·자료 공유 시 Slack/Discord 등 팀 알림(`src/notify.js`, fail-safe·비차단, 미설정 시 무음).
  URL은 환경설정에서 암호화 저장 또는 `ALERT_WEBHOOK`. 자료 공유는 공개 토큰 대신 내부 프로젝트 링크로 통지(PII 보호).

### 관리 항목 편집 = 삭제 중심 (활성/비활성 폐기)
- 하우스 엔지니어·외주 작업자·클라이언트·단가표·작업 종류 모두 토글 없이 **삭제(하드)**. 강제 삭제 시 참조 FK는 SET NULL(인보이스·프로젝트 등), 과거 작업의 종류 라벨은 key로 폴백 보존. 본인·부트스트랩 치프만 삭제 차단.

## 주요 변경 이력 (요약)

- MVP(인증·프로젝트·청구·자료) → Track/Task/Invoice 모델 → 인증 3단계(owner/chief/staff) 내부 도구화.
- 거래처 → 실결제자 → **클라이언트(통칭) + 실결제자(역할)** 로 정리, 자동 등록.
- 세션(일정) → 단가표(1Pro) → 세션 시간제 자동 산정 → 예약 버튼 UX(그리드/소요시간) → 겹침 차단(DB) → 구글 캘린더 자동 연동 → **다중 룸(룸별 겹침, FreeBusy 하드차단 폐기)**.
- 녹음 종류=단가표 분류(스튜디오/로케이션), 곡·콘텐츠=후반작업(튠·믹스·마스터링) 분리.
- 하우스 엔지니어↔작업 담당자 연계, 관리 페이지/프로젝트 상세 **탭** 그룹화, 청구 '청구 대기' 목록.
- Render 실배포 완료(빌드 함정: `tailwindcss` devDep → `npm install --include=dev`).
- **프로젝트 유형 재정의**: 녹음/믹스(recording/mixing) → **세션/작업(session/task)**. 세션=방문·예약·실시간, 작업=예약 없이 항목만(세션 탭 숨김). 세션 종류 항상 선택 가능(녹음 고정·필수 게이트 폐기).
- **녹음 세션 직접 청구**: 곡·콘텐츠/버튼 없이 세션이 곧 청구 라인(`invoice_items.session_id`). 생성 즉시 청구 탭 자동 노출·선택 청구·세션 잠금(`createTaskFromSession`/`청구 확정`/`/sessions/:id/bill` 폐기). 소요시간 입력은 슬라이더(30분·최대 12h, 1Pro/2Pro/직접입력 프리셋).
- **외주 지급단가 분리**: `track_tasks.worker_rate`·`engineer_id` 컬럼 추가. 정산 합계=Σ`worker_rate`(고객청구 `total_price`는 마진 참고). `listTasksForWorker`는 `engineer_id` 우선·이름 폴백.
- **청구 완료요건 통일**: 곡·콘텐츠 작업도 완료 상태만 기본 체크(세션 완료 강제와 동일).
- **정합·보안 보수**: 세션 상태 변경 청구잠금(`SESSION_INVOICED`), 프로젝트 삭제 청구가드(`PROJECT_HAS_INVOICED`), 세션 취소 시 캘린더 동기화, 발행 알림 입금완료 직행 누락 수정, 채번 원자화.
- **보안 하드닝**: `sameOriginRequest` 무헤더 비안전메서드 기본거부(Authorization/`/internal` cron 예외), OAuth state 랜덤 논스+httpOnly 쿠키 대조(로그인-CSRF 차단), 웹훅 SSRF 방어(DNS 해석 후 사설IP 차단), 로고 업로드 매직바이트(PNG/JPEG) 검증, 공개 토큰 로그 제거, 로컬 스트림 FD 누수 수정.
- **UX·공통 헬퍼**: 대시보드 오늘/이번 주 세션 카드, 프로젝트 마감일 D-day 복원·유형 변경·곡 일괄추가·실결제자 자동연결·목록 세션액 합산, 청구 검색·견적서 미발행 발행, muted 대비 AA(#6E6A5F), badge 변형 클래스, `tabBar`/`filterChips`/`projectTypeBadge` 헬퍼 신설(views.js).
- **외주 관리 일원화 완료**: `/settings` 담당자 탭 외주 추가/삭제 폼 제거 → `/workers` 안내 링크.
- **디자인 기반 정비**: Pretendard 한글폰트 도입(Inter→Pretendard, jsdelivr CDN + CSP 허용); 쿨톤 `--color-info`+`badge-info`(상태색/브랜드 클레이 분리); 사이드바 운영/청구/관리 그룹화(좌측 레일 활성표시); 수동 테마 토글(라이트/다크, 크림 기본, `html[data-theme]`+localStorage); `listGroup`/`listRow`/`emptyState` 공통 헬퍼 신설; tailwind `opacity.12` 추가(badge-* 빌드 실패 근본 수정).
- **백엔드 정리**: `resolveEndTime` pro1/2 죽은분기 제거·custom_hours 단일+720분 상한 클램프; 0원 작업 청구 가드(`total_price>0`); 죽은 코드 일괄 제거(calendar FreeBusy 3종·config 정규화 함수·`setRateItemActive`·`project_service_items` DB 시드·`listProjects` 필터 2종); `parseWon`=`parseMoney`·`timeToMin`→`lib/date` 통합; 운영시간 인프라 신설(`getStudioHours`/`setStudioHours`/`studioStartSlots`, `admin_state.studio_hours` 백킹).
- **라운드2 UX**: 세션폼 녹음 단가 항목 조건부 노출(종류=녹음일 때만), 예정 세션 1클릭 완료, 청구 결핍 사유 인라인 표시, `/sessions` 검색(`?q=`), 운영시간 기반 동적 시작슬롯; 프로젝트 실결제자 자동선택 `<details>` 가시화·빠른추가 금액 인라인·군더더기 제거·목록 `listRow` 통일; 청구 진입점 단일화·입금액 라벨 변경·상태배지 `badge-info`; 클라이언트 이름 검색(`?q=`); 설정 운영시간 폼(`POST /settings/studio-hours`); 대시보드 지표 강화.
- **프로젝트 유형 구분 폐기**: 세션/작업(session/task) 구분 제거 — 전 프로젝트가 세션 일정+곡·콘텐츠 동일. 드롭다운·목록 배지·유형 select 제거, `project_type`/`PROJECT_TYPES` 레거시 보존(신규=session, 편집 기존값 유지).
- **연락처(담당자) 도메인 신규**: `contacts`+`contact_affiliations`(소속 이력=이직 히스토리, `ended_on` NULL=현재, `closeCurrent` 자동 종료). `/contacts` 독립 메뉴(`requireEditor`·명함 아이콘), 생성 시 현재 소속 입력. 프로젝트 '클라이언트 담당자'(`contact_id`·`contactCombo`, 내부 `manager_id`와 별개), 클라이언트 상세 직원 목록.
- **실결제자 검색형 콤보**: 평면 select → `clientCombo`(`<input list>`+`<datalist>`, hidden id를 app.js가 동기화·분류 병기) — 클라이언트 다수 대비. `[data-client-combo]`/`[data-contact-combo]` 공용 IIFE.
- **UI 마무리**: 대시보드 지표 금액카드 넘침 수정(`text-lg`+좁은 화면 2열), 세션·곡콘텐츠 탭 목록↑·추가폼↓, 실결제자 필드 별도 행, 상세→목록 back 링크(`pageHeader.back`).
- **청구처 결정을 청구 시점으로**: 프로젝트 메타에서 실결제자(청구처) 입력 제거 → 청구 생성 폼에서 선택(미선택 시 자동파생 폴백, `createInvoiceFromTasks` clientId 인자). `resolveInvoiceRefs` 덮어쓰기 버그 수정(폼 선택 우선), 발행/입금완료 청구처 변경 409 잠금, 즉시발행 안내. 용어 통일 '실결제자→청구처'·'담당자(내부)→담당 엔지니어'·'클라이언트 담당자→고객 담당자'.
- **전방위 점검 개선(ultrawork)**: 🔴**세션 편집 시 시작/종료 유실** 수정(가용성 조회에 자기 세션 미제외 → `exclude`/`room` 전송[app.js]·편집폼 `data-session-id`·`busySessionSlots` 룸별 일치). **청구 탭(주 경로) 발행 알림 누락** → `notify.js` 공용 함수 통지. **클라이언트 삭제 가드**(발행 청구처면 409). 입금완료→발행 강등 시 `paid_amount` 리셋, 세션 `room_id` 활성 룸 검증. **죽은코드 제거**(미사용 `api.routes` 삭제·settings managers·`payerField`). UX: 미발행 견적서 PDF 버튼·세션 검색바 통일·테마 토글 현재모드 표시·클라이언트 목록 `listGroup`·입금폼 라벨('입력액으로 갱신'/'완납 처리')·빈상태 아이콘·캘린더 칩 상태색·검색 aria-label·세션 에러 `errorPage` 통일. `notifyInvoiceIssued` 일원화.
- **/audit 진단 후속**: 수동 인보이스 `tax_amount` 미산정(거래명세서 VAT ₩0) → amount에서 역산 저장(`round(amount-amount/1.1)`). 세션 겹침을 **전 세션 종류로 확장**(마스터링·기타도 룸 점유, session_type IN 절 제거). from-tasks 청구 에러 흡수 해제(알 수 없는 오류는 전역 핸들러로 throw). server.js 스테일 주석·시작시간 `pattern` 2자리 통일. **금전 핵심 단위 테스트 도입**(node:test 24개: 채번·VAT·세션겹침·권한, 의존성 0·격리 임시 DB).
- **프로젝트 폼 개선**: 마감일(`due_date`) UI 전부 제거(폼·목록 D-day·메타·대시보드 '임박한 마감'). '고객 담당자'→**'고객측 담당자'** + 선택 시 전화·이메일·소속 표시(`contactOptions` email·datalist `data-*`·app.js `[data-contact-info]`) + 목록 외 이름 저장 시 **새 연락처 자동 생성**(`resolveContactId`). 빠른 정합: body parser limit 1mb, 0원 단가 항목 생성 방지(`RATE_PRICE_REQUIRED`).
- **세션·담당자·매출 개선**: 세션 **담당 디렉터**(고객측 연락처 콤보·`sessions.director_contact_id`·목록 외 이름→새 연락처·연락처 상세 참여세션), **룸 기본 A·'미지정' 맨 아래**, **예약담당자 '미지정' 제거+환경설정 기본값**(`admin_state.default_booker`), **외주 지급단가 조건부**(담당이 하우스면 숨김·저장 0, `data-external` 토글), **하우스/외주 작업자 정보 수정**(이름·전화·이메일; 외주는 이름변경 시 작업 스냅샷 동기화), **매출 현황 메뉴**(`/revenue`, 엔지니어별 작업+세션 집계, 대표·치프), 연락처 정보표시 전화 `tel:`·이메일 `mailto:` 링크(app.js createElement).
- **클라이언트 첨부·연락처 확장·Google 동기화**: 클라이언트 **사업자등록증·통장사본** 드래그앤드롭 업로드/열람(`client_files`·매직바이트·치프 인증 다운로드·공개링크 없음). 연락처 **필드 확장**(성·이름·호칭·별명·회사·직책·부서·`resolveContactName`). **Google People API 양방향 동기화**(`people.js`·`google_resource_name`/`etag`·scope `contacts`): 앱→Google push(생성·수정·삭제) + **수동 'Google 동기화' 버튼**(`syncFromGoogle` syncToken 증분·삭제 양방향·루프방지=data 직접호출)·fail-safe·자동 cron 제거.
- **청구서 할인·담당자↔연락처 연동·매출 아이콘**: 청구서 단위 **할인**(정액+정률, 공급가 차감 후 VAT 재계산 `invoiceAmountsFromSupply`, 선택 항목 동적 공급가, 거래명세서 할인 라인, `invoices.discount_amount`). 외주/하우스 담당자를 **연락처에 자동 노출**(`project_managers.contact_id` 백필)·전화 양방향·외주 이메일 양방향·하우스 이메일 잠금. NAV **매출 아이콘**(ICONS `revenue`) 누락 수정.
- **연락처 폼·전화 정규화·치프 역할 전환**: 연락처 **표시명 항목 제거**(name 자동=성+이름 붙이고 호칭만 띄움 "김보종 대표님", `resolveContactName`). **전화 정규화**(`formatPhone`: 11자리→010-####-####·서울 10자리→02-####-####·그 외 보존) — 연락처·외주·하우스 저장 시 일관. **치프 역할 전환**: 비본인 역할 select 노출(본인 잠금)·**최소 1명 치프 보장**(마지막 치프 강등 거부 `last_chief` 경고). **ADMIN 기본 치프도 강등 유지**(`upsertUserFromGoogle` 기존 역할 존중 — 이전엔 로그인 시 chief 강제라 강등이 되돌아갔음; 활성 치프 0이면 락아웃 방지로 복구). 담당자 표시 '기본 계정(삭제 불가)'.

## 스택

| 영역 | 선택 |
|---|---|
| 런타임 | Node ≥20, Express 4 (CommonJS) |
| DB | SQLite — `better-sqlite3`(운영, prebuild) / `node:sqlite`(폴백) 어댑터(`src/sqlite.js`) |
| 인증 | 전원 Google OAuth + 화이트리스트(`users` 행) → httpOnly 서명 JWT 쿠키(30일). 비밀번호 로그인 폐기 |
| 저장소 | Google Drive(관리자 토큰 재사용, `drive.file`) — 자료 전달용. 미연동 시 로컬 디스크 폴백 |
| 캘린더 | Google Calendar(관리자 토큰, scope `calendar`) — 일정 자동 생성/수정/삭제(취소 포함). FreeBusy 하드차단은 비활성(다중 룸 도입으로 앱 DB 룸별 겹침이 정식 차단) |
| 보안 | helmet(CSP, 인라인 스크립트 0) + express-rate-limit + 토큰 AES-256-GCM 암호화 |
| 프론트 | 서버 렌더 HTML(`src/views.js`) + 클래식 폼 POST + 최소 JS(`public/js/app.js`), Tailwind CLI 빌드; **Pretendard** 한글폰트(jsdelivr CDN, CSP 허용); 크림·클레이 디자인 톤; 수동 라이트/다크 테마(`html[data-theme]`+localStorage) |
| 배포 | Render Blueprint(`render.yaml`) + Disk — **라이브** |
| 테스트 | Node 내장 `node:test`(의존성 0) — 금전 핵심 24개(채번·VAT·세션겹침·권한), `npm test`(격리 임시 DB 자가정리) |

## 아키텍처 핵심

- **role 기반 게이트(3단계)**: `attachUser`(활성 + owner/chief/staff만 세션 인정) → 권한 술어
  `isOwner`/`isChief`/`isStaffRole`, 복합술어 `canEdit`(chief|staff)·`canInvoice`(chief|owner)·`canBill`(chief|owner|staff=청구서 발행)
  (모두 `auth.js`). 미들웨어: `requireAuth`(로그인=보기), `requireEditor`(canEdit=프로젝트·곡·작업·자료·**연락처·클라이언트**(첨부 제외)
  편집, **대표 차단**), `requireChief`(치프 전용=스태프·담당자·설정 + **클라이언트 첨부 서류**), `requireBilling`(canBill=**청구서 발행**=치프·대표·스태프), `requireInvoice`(canInvoice=
  매출·외주 정산=치프·대표). 내부 도구이므로 로그인 직원은 모든 프로젝트를 열람한다(클라이언트 범위 강제 폐기).
- **Google 화이트리스트(`auth.js upsertUserFromGoogle`)**: 로그인 Google 이메일이 `ADMIN_EMAIL`(부트스트랩
  **치프=chief**, 없으면 자동 생성)이거나 `users`에 등록된 활성 행이면 그 역할로 로그인, 아니면 거부. 치프는
  `/settings`에서 사용자(이메일+역할 owner/chief/staff) 추가·역할변경·활성/비활성으로 화이트리스트를
  운영한다(본인·부트스트랩 치프는 잠금 방지로 강등/비활성 불가). 대표 계정은 치프가 owner로 등록한다.
- **미들웨어 순서(플레이북 §3-1)**: helmet/ratelimit → cookie/body → `attachUser` → 라우트 →
  **`express.static`은 맨 뒤**(보호 HTML은 라우트, static은 css/js 자산만). 인증 우회 방지.
- **작업 옵션/상태값 = 코드 상수**(`config.js`)가 단일 진실원천. DB CHECK 제약 금지(§2.8 마이그레이션 지옥 회피).
- **돈=정수(원)**, 날짜=`"YYYY-MM-DD"` 문자열(`src/lib/date.js`).
- **at-rest 암호화**(`db.encrypt/decrypt`, AES-256-GCM): Drive/Calendar refresh token 등 비밀.
- **CSRF 방어**: `sameOriginRequest`가 비안전 메서드(POST/PUT/PATCH/DELETE)에서 Sec-Fetch-Site 헤더 없으면 기본 거부. Authorization 헤더 요청과 `/internal` cron 경로만 예외.
- **OAuth 논스**: Google OAuth state에 랜덤 논스 포함 + httpOnly 쿠키 대조(로그인-CSRF 차단). `safeNext` 역슬래시(`\`) open-redirect 우회 차단.
- **모바일 UX(플레이북2 §5)**: 입력 16px(iOS 자동확대 방지), 반응형 카드, 콘텐츠 max-width 통일. 모바일 드로어 헤더(로고+X), 포커스링, theme-color 다크 대응.
- **UI 공통 헬퍼**(views.js): `tabBar`(aria-current 포함)·`filterChips`·`projectTypeBadge`·`listGroup`/`listRow`(목록 행 통일)·`emptyState`(아이콘·CTA). badge 변형 5종(`badge-neutral`·`badge-success`·`badge-warning`·`badge-error`·`badge-info`); 쿨톤 `--color-info`(상태색/브랜드 클레이 분리). 사이드바 그룹화(운영/청구/관리 섹션, 좌측 레일 활성표시). 수동 테마 토글(라이트/다크, 크림 기본, `html[data-theme]`+localStorage). muted 대비 AA 충족(#6E6A5F 5.15:1).

## 데이터 모델 (생성됨)

- `rooms(name, sort_order, active)` — **스튜디오 룸 마스터**. 기본 '메인 룸' 1회 시드. 치프가 `/settings` 환경설정 탭에서 CRUD. 삭제 시 `sessions.room_id` SET NULL.
- `users(email, role[owner|chief|staff], name, google_sub?, active, client_id?[레거시], password_hash?[레거시])` —
  `active=0`이면 로그인 차단(화이트리스트 제거). 마이그레이션에서 기존 `admin`→`chief` 자동 승계.
  `password_hash`/`client_id`는 구 모델 잔재 컬럼(미사용). **`name`은 기존값 보존**(치프가 `/settings`에서 수정한 한글 이름이 Google 프로필 영문 이름에 매 로그인 덮어쓰이지 않게; `users.name` 빈 경우만 Google 이름). 이름 수정 시 `project_managers.name`·`track_tasks.engineer_name`(작업 스냅샷)도 동기화.
- `clients(name, kind[아티스트|소속사/레이블|제작사|기타], phone?, email?, memo?, biz_no?, owner_name?, address?, cash_receipt_no?[개인/아티스트 현금영수증 발급번호 — 사업자등록증 없는 경우], source_contact_id?[담당자→청구처 변환 출처 contact, 동명이인 분리])` —
  UI상 **클라이언트**(통칭). 프로젝트의 아티스트·소속사/레이블·제작사가 저장 시 분류별로 자동 등록되고
  (`ensureClientsFromProject`), 그중 하나가 인보이스의 **청구처(공급받는 자)** 역할로 선택된다(`client_id`, 청구 생성 폼에서 결정). 프로젝트의 `client_id`는 자동 파생 기본값.
  `biz_no`(사업자등록번호)·`owner_name`(대표자)·`address`(사업장 주소)는 세금계산서용 상세정보.
- `client_files(client_id→clients CASCADE, kind['biz_license'|'bankbook'], storage_backend, file_id, file_name, mime_type, file_size, created_at)` — **클라이언트 첨부 서류**(사업자등록증·통장사본). client당 kind별 1개(`(client_id,kind)` UNIQUE, 교체식). 매직바이트(PNG/JPEG/PDF)·치프 전용 인증 다운로드(공개 링크 없음, 민감 금융정보).
- `contacts(name, family_name?, given_name?, honorific?, nickname?[아티스트명·활동명 — Google 별명(nicknames)로 동기화], company?, job_title?, department?, phone?, email?, memo?, google_resource_name?, google_etag?, user_id?, created_at)` — **연락처(사람)** 마스터(회사 `clients`와 별개). `name`=표시명(NOT NULL, 미입력 시 호칭+성+이름/별명 자동 `resolveContactName`). `google_resource_name`/`google_etag`=People API 동기화 추적. **`user_id`**=로그인 계정(녹음실 스태프, owner 포함)과 연결(FK 없음·`ensureContactForUser`가 보장, 하우스는 담당자 연락처 재사용해 중복 방지) → 연락처 '녹음실 스태프' 탭 필터(`listContacts({staff})`)·`classifyContact` owner=대표 배지. `/contacts`에서 `requireEditor`(치프·스태프)가 CRUD. 삭제 시 affiliations CASCADE·`projects.contact_id` SET NULL·**Google 연락처 삭제 동기화**.
- `contact_affiliations(contact_id→contacts CASCADE, client_id?→clients SET NULL, title?, started_on?, ended_on?, memo?, created_at)` — **소속 이력(이직 히스토리)**. `ended_on IS NULL`=현재 소속, `client_id` NULL=무소속(프리·지인). 이직 시 기존 현재 소속 종료 후 새 행. 헬퍼: `currentAffiliation`·`listAffiliations`·`addAffiliation(closeCurrent)`·`listContactsForClient`·`listProjectsForContact`.
- `projects(title, project_type[레거시·미사용], artist?, artist_company?, production_company?,
  client_id?→clients ON DELETE SET NULL, manager_id?→project_managers ON DELETE SET NULL, contact_id?→contacts ON DELETE SET NULL, services JSON, due_date?, rate, memo)` —
  `project_type`은 **레거시**(유형 구분 폐기 — 신규=session, UI 미노출). `contact_id`=고객측 담당자 연락처(내부 `manager_id`와 별개). `services`는 레거시 배열(편집 UI 제거). `status`·`kind`·**`due_date`는 레거시**(프로젝트 마감일 UI 폐기 — 청구 입금마감일과 무관한 잔재 컬럼).
- `project_managers(name, email?, phone?, active, user_id?→users, contact_id?→contacts, created_at)` — 작업 담당자 마스터.
  `user_id` 있으면 **하우스 엔지니어**(로그인 사용자와 링크, `auth.syncUserToManager`가 자동 생성·동기화),
  null이면 **외주 작업자**(로그인 없이 관리에서 직접 추가). 둘 다 세션·작업 담당 드롭다운에 노출. **`contact_id`=연동 연락처**(서버 기동 시 백필로 전 담당자 자동 연결): 전화는 연락처↔담당자 **양방향**, 이메일은 외주만 양방향·**하우스는 잠금**(`users.email` 보호). `ensureContactForManager`/`syncContactToManager`/`syncManagerToContact`(상호 재호출 없음=루프 방지).
- `task_types(key UNIQUE, label, task_group[레거시·분류 폐기], billing_type, unit_price, is_quick, sort_order, active)` — **작업 종류 카탈로그**
  (곡·콘텐츠 후반작업). config `TASK_TYPES`를 `task_types_seed_v1` 게이트로 1회 시드 후 DB가 단일 진실원천(기존 9 key 보존, 신규=`tt_<hex>`).
  `track_tasks.task_type`이 이 key를 문자열로 보관(FK 아님). 라벨 해석은 `data.js` 모듈 캐시(`taskTypeLabel`, 쓰기 시 무효화). **분류(`task_group`) 폐기**(2026-07-01 — 곡·콘텐츠 작업은 모두 후반작업이라 분류 무의미: 추가/수정 폼 select·행 배지·빠른추가 optgroup·진행요약 그룹묶음 제거[진행요약은 종류별로], 신규=`Post_Production` 고정, `taskTypeGroup` 헬퍼 제거. `TASK_GROUPS`/`TASK_GROUP_LABELS` config·컬럼만 레거시 보존).
  `is_quick`=곡·콘텐츠 빠른추가 버튼 노출, `unit_price`=빠른추가 기본 단가. 삭제-only(강제), 치프가 `/settings` 컨텐츠 탭 CRUD.
- `project_service_items(key UNIQUE, label, active, created_at)` — 레거시(구 services JSON 라벨 호환). **관리 UI·시드 폐기**(작업 종류 카탈로그가 대체), 테이블만 잔존.
- `rate_items(name, category[스튜디오 녹음|로케이션 녹음], base_minutes, base_price, extra_minutes, extra_price, active)` —
  **단가표 · 녹음 종류**. `category`(`RECORDING_CATEGORIES`)로 분류, 세션 폼의 '녹음 종류'에 분류별 optgroup으로
  묶여 표시된다. 기준 시간(1Pro) 안은 `base_price`, 초과는 `extra_minutes` 단위 올림으로 `extra_price` 과금
  (`base_minutes=0`이면 정액). `computeRatePrice(item, minutes)`가 산정. 관리 메뉴에서 치프가 CRUD.
- `project_tracks(project_id→projects CASCADE, title, artist?, content_type[Music|Video_Post], created_at)` —
  프로젝트 하위 곡·콘텐츠. **`artist`=곡별 아티스트**(한 프로젝트에 여러 아티스트 가능 — 곡·콘텐츠 추가/수정 폼에서 입력, 미입력 시 프로젝트 아티스트; 트랙 헤더에 표시). `content_type` 상수·정규화(`config.js`)는 있으나 **현재 UI 미노출 → 전부 Music**, 영상 구분은 향후 확장용.
- `track_tasks(track_id→project_tracks CASCADE, task_type, billing_type[Time_Charge|Fixed_Per_Track],
  quantity, unit_price, total_price, engineer_name?, engineer_id?→project_managers SET NULL,
  worker_rate?, status[Pending|In_Progress|Completed],
  is_invoiced, invoice_id?, session_id?→sessions SET NULL, worker_paid, worker_paid_date?)` — 실제 청구 가능한 모듈형 작업 단위.
  `engineer_id`: 담당 엔지니어 FK(저장 시 `engineer_name` 동기 기록). `worker_rate`: 외주 **지급단가**(고객청구 `total_price`와 별개 — 마진 산정용). `worker_paid`=외주 정산(지급) 여부(`/workers` 정산 탭). 정산 합계=Σ`worker_rate`.
  `session_id`는 녹음 세션에서 자동 생성된 작업 추적(부분 유니크: 세션당 1건).
- `deliverables(project_id→projects ON DELETE CASCADE, title, version, kind, storage_backend[drive|local],
  file_id, file_name, file_size, mime_type, access_token?, expires_at?, download_count, revoked, note)`
- `invoices(project_id?→projects SET NULL, client_id?→clients SET NULL, title, amount, paid_amount,
  invoice_number?, tax_amount, discount_amount, status[미발행|발행|입금완료], issued_date?, due_date?, memo)` —
  돈=정수(원), 연체·부분납은 코드 파생. `amount`는 VAT 포함 총액. `discount_amount`=청구서 할인(공급가에서 차감, `invoiceAmountsFromSupply`로 과세표준·VAT 재계산; from-tasks 주 경로).
- `invoice_items(invoice_id→invoices CASCADE, task_id?→track_tasks SET NULL, session_id?→sessions SET NULL, track_title, task_type,
  description, quantity, unit_price, amount)` — 청구서 라인아이템 스냅샷.
- `sessions(project_id→projects CASCADE, session_type[녹음|믹싱|마스터링|기타], session_date,
  start_time?, end_time? "HH:MM", booker_name?, engineer_name?, status[예정|완료|취소], memo,
  rate_item_id?→rate_items SET NULL, room_id?→rooms SET NULL, director_contact_id?(→contacts, 담당 디렉터 **레거시**·다대다는 `session_directors`), gcal_event_id?)` — 스튜디오 일정.
- `session_directors(session_id→sessions CASCADE, contact_id→contacts CASCADE, PRIMARY KEY(session_id, contact_id))` — **세션 담당 디렉터 다대다**(한 세션에 고객측 디렉터 여러 명). `sessions.director_contact_id`(첫 디렉터)는 레거시 동기화 보존. `setSessionDirectors`/`listSessionDirectors`/`resolveDirectorIds`, 기존 단일 디렉터는 `session_directors_backfill_v1`로 1회 복사.
  `booker_name`(예약 담당자)·`engineer_name`(담당 엔지니어)은 둘 다 담당자 마스터에서 선택(별개 역할).
  `rate_item_id`는 녹음 세션 시간제 자동 산정용 단가표 연결. `room_id`는 룸별 겹침 검사 단위(IFNULL 0으로 가상룸 처리). `gcal_event_id`는 자동 생성한 구글 캘린더 일정 id(수정·삭제 추적).
- `admin_state(key, value)` — drive folder_id·refresh token(암호화)·테마 캐시·`studio_calendar_id`(스튜디오 캘린더)·`studio_location`(기본 장소)·**`studio_hours`**(운영시간 JSON·예약 그리드 시작슬롯 소스)·`studio_biz_*`(공급자 세금정보, 거래명세서 PDF용, 평문)·`studio_logo`(거래명세서 로고, base64 data URI)·`alert_webhook_url`(알림 웹훅, 암호화)·**`default_booker`**(기본 예약 담당자 이름, 세션 폼 기본 선택).
- 후속(스키마 자리만): `payments`(입금 이력 분리 필요 시).

## 자료 전달 아키텍처 (플레이북1 §2.3·§4.3)

- **스토리지 추상화(`src/storage.js`)**: Drive 연동 시 Drive, 미연동 시 로컬 디스크(`config.uploadsDir`).
  SQLite 어댑터와 같은 폴백 전략 → Google 자격증명 없이도 전체 흐름 로컬 검증 가능.
- **업로드**: multer **디스크 스토리지**(메모리 금지, OOM 방지) → `storage.put` → 임시파일 정리.
  multipart 파일명은 latin1 → UTF-8 복원(한글 보존).
- **비공개 프록시 스트리밍**: 파일은 공개 URL 없음. 인증 다운로드 `/deliverables/:id/raw`(범위 강제) +
  공개 링크 `/d/:token`(로그인 불필요). 둘 다 백엔드가 프록시.
- **만료 토큰 링크**: 난수 `access_token`, `expires_at` 만료, `revoked` 철회, `download_count` 추적.
  게이트(`tokenGate`)가 존재/철회/만료를 검사.

## 환경변수

| 키 | 용도 |
|---|---|
| `ADMIN_EMAIL` | 부트스트랩 치프(chief) Google 이메일. 최초 로그인 시 자동 생성·chief 보장. 대표·스태프는 치프가 `/settings`에서 등록 |
| `SESSION_SECRET` | JWT 서명 |
| `TOKEN_ENC_KEY` | AES-256-GCM 키 파생(비밀 암호화) |
| `GOOGLE_CLIENT_ID`/`SECRET` | OAuth(로그인 + Drive + Calendar + **People/연락처**). scope: `openid·email·profile·drive.file·calendar·contacts`(연락처 동기화는 GCP People API 활성화 + 치프 재로그인 필요) |
| `BASE_URL` | 외부 URL(Render는 `RENDER_EXTERNAL_URL` 자동) |
| `PORT` / `DB_PATH` / `MAX_UPLOAD_MB` | 서버/DB/업로드 |
| `DEV_LOGIN` | =1 시 `/dev-login` 활성(로컬 검증용, **프로덕션 금지**) |
| `BACKUP_TOKEN` | cron이 `POST /internal/cron/daily`(백업+연체 스캔)를 트리거하는 인증 토큰. 미설정 시 라우트 비활성(404). web·cron 동일값 |
| `CRON_TRIGGER_URL` / `WEB_HOSTPORT` | (cron 서비스) 트리거 대상 web URL. `WEB_HOSTPORT`는 Render `fromService hostport` 자동 주입 |
| `ALERT_WEBHOOK` | (선택) 알림 웹훅 URL 운영 오버라이드. 미설정 시 `/settings` 환경설정에서 암호화 저장한 값 사용(Slack/Discord 등) |

프로덕션(`NODE_ENV=production`)에서는 `ADMIN_EMAIL`, 강한 `SESSION_SECRET`/`TOKEN_ENC_KEY`,
Google OAuth 자격증명이 없거나 `DEV_LOGIN`이 켜져 있으면 서버가 시작되지 않는다.

## 빠진 함정 (다음에 또 밟지 말 것)

1. **인증 게이트 → static 순서**(§3-1). 보호 HTML을 정적 파일로 두지 말 것.
2. **better-sqlite3 네이티브 빌드**: 최신 Node(예: 26)에서 컴파일 실패 가능 →
   `optionalDependencies` + `node:sqlite` 폴백(`src/sqlite.js`). Render(Node 20/22)는 prebuild 사용.
3. **헤드리스 full-page 스크린샷은 폭을 잘못 렌더**(플레이북2 §6) → CDP `setDeviceMetricsOverride`로 측정.
4. **OAuth state로 next 전달** 시 base64url + open-redirect 방지(`safeNext`, 내부 경로만, 역슬래시 우회 차단). **OAuth state에 랜덤 논스** 포함 + httpOnly 쿠키 대조로 로그인-CSRF 차단.
5. **유휴 백그라운드 서버가 포트 점유** — 이전 검증 세션의 `node src/server.js`가 살아 있으면 새 서버가
   바인딩 실패하고 **옛 코드가 응답**. 검증 전 `pkill -f "src/server.js"`로 정리하고 단일 프로세스 확인할 것.
6. **multipart 파일명 latin1** → `Buffer.from(name,'latin1').toString('utf8')`로 한글 복원.
7. **동일 출처 POST 검사 + CSP upgrade-insecure-requests**: 로컬 http에서 브라우저가 폼 제출 Origin을
   `https://`로 올려 보내 `req.protocol`(http)과 불일치 → 403. `server.js sameOriginRequest`를
   **Sec-Fetch-Site 우선 + host(프로토콜 무시) 비교**로 변경(외부 host는 여전히 차단해 CSRF 방어 유지).
8. **정적 자산 캐시 버스팅 필수**: `/css/app.css`에 버전을 안 붙이면 배포해도 브라우저가 옛 CSS 캐시를 재사용해
   레이아웃이 깨져 보인다. `views.js ASSET_VERSION`(mtime+size) → `?v=`로 해결.
9. **한글 쿼리스트링 인코딩**: curl로 `?kind=아티스트` 같은 한글 쿼리를 **인코딩 없이** 보내면 서버가 다른
   문자열로 받아 필터가 빈 결과(코드 버그 아님). 검증 시 `--data-urlencode` 또는 `-G --data-urlencode` 사용.
10. **메인터넌스는 브라우저 헤더로 E2E**: curl이 아니라 Sec-Fetch-Site·Origin·multipart 헤더로 폼 제출까지 검증할 것.
11. **웹훅 SSRF**: 알림 웹훅 URL을 그대로 fetch하면 내부망 공격 가능. `notify.js`에서 DNS 해석 후 사설IP 대역(`10.`, `172.16-31.`, `192.168.`, `127.`, `169.254.`, `::1`, fc00::/7, fe80::/10) 차단 후 전송. **IPv4-mapped IPv6(`::ffff:127.0.0.1`)는 `::ffff:` 제거 후 IPv4 패턴 재검사로 매핑 우회 차단**. OAuth 콜백은 `verified_email=false` 계정 거부.
12. **로고 업로드 매직바이트 검증**: Content-Type 헤더만 믿으면 안 됨. PNG(`\x89PNG`)·JPEG(`\xFF\xD8\xFF`) 매직바이트를 서버에서 확인 후 거부.
13. **Tailwind opacity.12 미등록**: `badge-*`(`bg-*/12` 같은 불투명도 변형 클래스)를 Tailwind 커스텀 색과 함께 쓸 때 opacity 스케일에 `12`가 없으면 CSS 빌드에서 제거된다. `tailwind.config.js`의 `theme.extend.opacity`에 `'12': '0.12'` 추가.
14. **AJAX 폼 전송은 `URLSearchParams`(urlencoded)로**: 서버 미들웨어가 `express.urlencoded`+`express.json`만 등록(multipart 파서 없음, multer는 파일 업로드 전용 라우트만). `fetch(url, { body: new FormData(form) })`는 **multipart/form-data**로 나가 파싱되지 않고 **req.body가 빈 객체** → 라우트가 기본값으로 저장(작업 자동저장이 작업 종류·담당을 기본값으로 덮어쓰던 근본 원인). 자동저장·AJAX POST는 `new URLSearchParams(); fd.forEach((v,k)=>p.append(k,v))`로 변환해 보낼 것.

## 검증 상태

- 로컬 E2E(DEV_LOGIN=1, 브라우저 헤더 기준): 인증·권한 3단계 매트릭스, 프로젝트/세션/곡·작업/청구 CRUD, 자료 업로드·
  토큰 다운로드, 작업→청구 VAT 10%·채번·스냅샷·잠금, 세션 시간제 산정·겹침 차단·예약 그리드, 클라이언트 자동 등록,
  하우스 엔지니어 연계, 탭 전환·리다이렉트, 청구 대기 전환 — 통과.
- **다중 룸**: 멱등 마이그레이션 2회, 룸별 겹침(같은 룸 차단·다른 룸 허용) 데이터 E2E, 룸 CRUD 통과.
- **외주 지급단가**: 마이그레이션 멱등·백필, `createTask` 저장·`listTasksForWorker` 매칭(engineer_id+이름 폴백) 단위, 작업폼·정산 페이지 E2E 통과.
- **보안 하드닝**: 격리 DB 단위(청구 잠금/가드 작동 + 미청구 정상), open-redirect 차단·권한 3종 스모크 통과.
- 프로덕션: Google OAuth 로그인·`/healthz`·일일 백업 cron 트리거 통과.
- **구글 캘린더 자동 연동**: 코드·fail-safe 검증 완료. 실제 동작은 사용자 사전작업(GCP Calendar API 활성화 +
  치프 재로그인(scope `calendar`) + `/settings`에서 캘린더 선택 + 기본 장소 입력) 후 확인.
- **Drive 실연동**: 미검증(자료 업로드 시 local→drive 자동 전환, 현재는 local 저장).
- **디자인·UX(라운드2)**: build:css exit 0, 폰트 로드·사이드바 그룹·테마 토글·조건부 녹음 단가·예정 완료1클릭·운영시간 그리드·검색·클라이언트 검색 E2E — 페이지 200 + 라이트 테마 시각 확인 통과.

## 다음 단계 TODO

1. Drive 실연동 검증.
2. **거래명세서 PDF 프로덕션 확인** — Render Linux에서 `@resvg/resvg-js` 네이티브 prebuilt 설치·렌더 동작 확인(로컬 검증 완료).
3. (선택) 구글 캘린더 역방향 동기화(캘린더에서 삭제→앱 반영) — 보류 중.
4. (선택) 알림 Gmail 어댑터 — 현재 웹훅만. 클라이언트 직접 메일 통지가 필요해지면 `notify.js`에 어댑터 추가.
5. (선택) 입금 이력 분리(`payments` 테이블) — 현재 `paid_amount` 단일 컬럼으로 부분납 처리.
6. (선택) 자료 다중 업로드(현재 단건).
7. (선택) 청구서 클라이언트 정보 스냅샷(현재 발행 시점 실시간 조회).
8. (선택) 백업 오프사이트 전송(현재 Render Disk 내 14일 보존만).
9. (미완, L) **data.js 모듈 분리** — 헬퍼 함수 증가로 단일 파일 부담; 도메인별 모듈화 검토.
10. (보류) **content_type/billing_type UI 노출** — `content_type[Music|Video_Post]`·`billing_type` 현재 UI 미노출/강제; 영상 구분·과금 유형 선택은 향후 확장 시 복원.

> **완료(이번 세션)**: 🔴**청구 탭 500 회귀 수정**(`taskTypeUnitPrice` export 누락 → 청구 항목 있는 프로젝트 500, 즉시 복구) · **프로젝트 결제 예정 금액에 미가격 작업 반영**(단가표 0으로 만든 작업 total_price=0이라 목록서 빠지던 것 → `COALESCE(NULLIF(total_price,0), task_types.unit_price)` 폴백, 청구 폼과 동일) · **세션 담당 디렉터 다대다**(`session_directors` 조인 테이블·'+디렉터 추가' 반복 입력·app.js 콤보 위임화·'참여 세션'/디렉터 배지 조인+레거시 조회) · **1Pro/2Pro는 녹음일 때만**(믹싱 등은 소요 슬라이더, 종류별 기본값[녹음=1Pro·그 외=기본 세션 시간 3.5h]·`applyTypeDefault`, `studio_pro_minutes` 설정) · **프로젝트 메타 폼 자동저장**(저장 버튼 제거·change/blur 저장으로 부분입력 마스터 중복 방지·`resolveContactId` 이름 재사용) · **스태프 프로젝트 삭제 허용**(requireEditor) · **청구 항목 세션을 작업 위로** · **세션 있으면 '새 세션 추가' 접기**(`<details>`) · **구글 캘린더 제목 제작사 없으면 레이블** · **개인(아티스트) 현금영수증 정보**(`clients.cash_receipt_no` — 사업자등록증 없는 개인은 분류=아티스트 시 세금정보 대신 현금영수증 번호[휴대폰/카드번호] 입력, app.js가 세금↔현금영수증 블록 토글·서버 분류별 null 강제, payerInfoCard에 현금영수증 행 표시; 아티스트=현금영수증·사업자=세금정보 토글 E2E·저장 영속 확인) · **운영 전반 UX·연동 11종**(① **세션 새 추가 예약 담당자=로그인 사용자 기본**[`sessionBookingFields` defaultBooker] · ② **클라이언트 첨부 서류(사업자등록증·통장사본) 스태프 개방**[requireChief→requireEditor·뷰 isChief 게이트 제거] · ③ **청구 생성 폼 청구 제목 글씨 크기를 청구처와 통일**[text-sm→input] · ④ **인보이스 입금 폼 줄맞춤**[입력칸·입력액 갱신·완납 처리 한 줄, items-stretch] · ⑤ **청구 항목 0원 허용 + '0원으로 청구?' 확인창**[서버 0원 가드 완화·app.js submit confirm] · ⑥ **청구 항목 작성 중 금액 localStorage 드래프트 자동저장**[이탈·새로고침 보존, 제출 시 정리] · ⑦ **로그인 계정(owner 포함) 연락처 자동 등록**[`contacts.user_id`·`ensureContactForUser`: 박광현 같은 대표가 연락처에 안 들어가던 문제 해결, 하우스는 기존 담당자 연락처 재사용해 중복 방지, 로그인·계정추가·역할변경 시 보장, db.js 백필] · ⑧ **연락처 '녹음실 스태프' 탭**[user_id 있는 계정만, classifyContact owner=대표 배지] · ⑨ **청구처 정보 카드**[`payerInfoCard` — 대표자·사업자등록번호·주소·담당자 연락처(tel/mailto), 청구 상세 + 프로젝트 청구 탭 펼침] · ⑩ **사업자등록번호 클릭 → 첨부 사업자등록증 열람**[biz_license 첨부 시 링크] · ⑪ **클라이언트 폼 담당자 연락처 콤보**[아티스트·소속사·제작사 공통, 선택/입력 시 이 클라이언트 소속으로 연락처 연동 `linkClientContact`]; 33 테스트 통과·owner 연락처/스태프 탭/청구처 카드/사업자번호 링크 E2E 확인) · **곡·콘텐츠 작업 편집 UX 개선 4종 + 자동저장 근본버그 수정**(① **작업 종류·담당 엔지니어 변경 즉시 헤더 반영**[`data-row-type`/`data-row-engineer`, 저장 응답 `typeLabel`/`engineerName`] · ② **새 작업 담당 엔지니어=로그인 계정 기본**[`createTask`가 `getManagerByUserId(user.id)`로 본인 담당자 기본 배정] · ③ **상태 select를 헤더로 — 접힌 채 수정 가능**[`<select form="task-form-<id>">` 폼 밖 연결·`[data-no-toggle]`+app.js click preventDefault로 `<details>` 펼침 방지] · ④ **작업 저장 버튼 제거·완전 자동저장**[`<noscript>` 폴백만]; 🔴**근본 원인 수정: 자동저장이 `FormData`(multipart)로 전송돼 `express.urlencoded`가 못 읽고 req.body가 비어 기본값으로 저장되던 것**[작업 종류·담당이 저장 안 되고 기본값으로 덮여 '저장 눌러야 반영'처럼 보임] → `URLSearchParams`로 전송; app.js 자동저장을 위임 방식으로 재작성; 33 테스트 통과·종류/담당/상태 즉시반영·작성 후 영속·접힘 유지·기본 엔지니어 E2E 확인) · **청구 생성 폼 개선 4종**(① **청구 제목을 청구처 위로** 이동[가장 먼저 입력] · ② 항목 체크리스트 위에 **'청구 항목' 헤더** 추가 · ③ **세션 정렬을 작성순으로**[`listBillableSessionsForProject`·`listSessionsForProject` `ORDER BY session_date`→`created_at ASC, id ASC` — 먼저 만든 세션이 위, 나중 세션이 아래] · ④ **녹음 세션 금액도 작업처럼 청구 폼에서 수정 가능**[`session_amount_<id>` 입력칸·`data-line-input`로 공급가·VAT 실시간 갱신·app.js MONEY 정규식에 `session_amount_\d+` 추가·`createInvoiceFromTasks` `sessionAmounts`로 스냅샷 확정·0원 가드 `TASK_AMOUNT_REQUIRED`·`extractAmountMap` 헬퍼로 task/session 추출 일원화]; 33 테스트 통과·작성순/수정금액 반영 E2E 확인) · **청구서 수정 기능 전면 폐기**(발행=확정 원칙 — 인라인 '✎ 청구서 수정'·전체화면 '수정' 버튼·`GET /:id/edit`·`POST /:id`[update]·`invoiceForm` embed/isEdit·`projects.routes` editForm 첨부·`invoiceForm` export 삭제, 변경은 **삭제 후 재발행**, 삭제 버튼 옆 안내문, `invoiceForm`=수동 생성 전용으로 단순화; 33 테스트 통과·edit/update 라우트 404·인라인 폼 제거 E2E 확인) · **작업 종류 분류 개념 폐기**(곡·콘텐츠 작업은 모두 후반작업 — 관리 컨텐츠 탭 추가/수정 폼 분류 select·행 배지 제거, 빠른추가 +기타 optgroup→평면 목록, 곡 진행요약 그룹묶음→**작업 종류별**, 신규 종류 `task_group=Post_Production` 고정, `taskTypeGroup`/`normalizeTaskGroup`/`TASK_GROUP_LABELS` orphan import 정리; `TASK_GROUPS` config 상수·`task_group` 컬럼은 레거시 보존) · **청구서 수정 부가세 토글 버그 수정**(수정/수동생성 `invoiceForm`에서 부가세 포함 토글이 총액에 반영 안 되던 것 — app.js `[data-vat-amount-form]`가 토글 시 `amount` ×1.1[포함]/÷1.1[해제]로 갱신, 서버 tax 역산[`amount−amount/1.1`]과 일치; 안내문 '해제 시 총액에서 VAT 차감'; **토글 시 천단위 콤마 유지**[프로그램 `.value` 대입은 input 이벤트가 안 떠 콤마 포맷터가 안 돎 → `toLocaleString` 직접 포맷, 그전엔 토글 후 총액이 `990000`처럼 콤마 없이 표시됐음]; **금액칸 콤마 포맷터 누락 필드 보강**[app.js `MONEY` 정규식이 `discount_amount`(할인)·`worker_rate`(외주 지급단가)·`task_amount_<id>`(작업별 청구 금액)를 안 잡아 이 칸들만 천단위 콤마가 전혀 없던 것 — 정규식에 추가해 로드·입력·제출(콤마 제거) 일관 적용, 할인 정률→정액 자동변환[`applyPct`]도 `toLocaleString`로 포맷; 서버 `parseMoney`가 콤마 제거 방어라 작업 자동저장 fetch 경로도 안전]) · **곡·콘텐츠 금액 흐름을 청구 탭으로 이동**(세션 일정과 동일 철학 — 작업 폼은 **종류·담당·상태만**[금액 칸 제거], 작업 생성·수정 시 **종류 기본단가 자동**[`taskTypeUnitPrice`], **청구 생성 폼에 작업별 금액 입력칸**[`task_amount_<id>`·기본단가 채움·체크/입력 시 공급가·VAT 실시간 갱신 `data-line-row`/`data-line-input`/app.js `lineAmount`]·청구 시 `total_price` 확정[`createInvoiceFromTasks` `taskAmounts`]·**0원 가드**[`TASK_AMOUNT_REQUIRED`]·미청구 후보 `total_price>0` 조건 제거·**작업 행 미청구 금액 숨김**[청구된 확정액만]·곡·콘텐츠 안내 '금액은 청구 탭에서') · **청구 목록을 생성 폼 위로**(만들어진 청구 먼저·새 청구 생성 폼 하단), **청구 탭 인보이스 인라인 펼침**(프로젝트 청구 탭에서 인보이스 행을 클릭하면 **그 자리에서 펼쳐** 금액 내역·청구 항목·입금/상태 처리·수정·삭제·PDF·'전체 화면으로' 링크 — **청구 메뉴 이탈 없이 프로젝트 안에서 청구 업무 완결**; **청구 생성·수정·입금·상태·삭제 전부** `return`으로 프로젝트 청구 탭 복귀(`?open=새 id`로 펼친 채 노출), **청구서 수정은 펼친 자리에서 인라인**(`invoiceForm` embed·'✎ 청구서 수정' details·datalist id 인보이스별 유니크·입금/상태는 빠른폼 담당 hidden·`projects.routes`가 `invoiceForm` import해 editForm 첨부), 수동 생성 폼만 별도 페이지(프로젝트 맥락 유지), open-redirect 내부경로만 허용, **청구 메뉴(`/invoices`)는 모아보기로 역할 분리**; `invoiceRow` compact=펼침형·`invoiceExpandBody`·`returnTo` 헬퍼·라우트가 인보이스별 항목 첨부, 33 테스트 통과·복귀/차단 E2E 확인), **적대적 검증(ultrawork) 메인터넌스**(**죽은코드 배선** — '담당자→연락처 성·이름 자동 분리'가 `ensureContactForManager` 호출자 0건이라 미작동이던 것을 settings/workers 4지점 런타임 호출 + db.js 백필에 연결[`splitKoreanName`을 `src/lib/korean-name.js`로 공용화·트랜잭션 원자화·기존 family 1회 백필]·**동명이인 청구처 분리**[`ensureClientFromContact`를 `source_contact_id` contact별 매핑, 콤보 라벨 식별자]·**수동 인보이스 VAT 토글**·거래명세서 현금 VAT 줄 생략·**작업 자동저장 폴백**[제출 버튼 복원]·**race 방지**[AbortController·reqId]·역할가드 우회[M1 `POST /users`·M2 `syncUserToManager` 누락]·owner 배지 3중뷰 정렬·class 중복), **청구·작업 UX 개선**(청구 폼 **공급가·VAT·총금액 카드를 발행일 위로** 강조·**부가세 포함 토글**[기본 체크·해제 시 VAT 0=현금, `invoiceAmountsFromSupply`/`createInvoiceFromTasks` vatIncluded]·**담당자(연락처)도 청구처**[`ensureClientFromContact`로 같은 이름 '기타' 클라이언트 변환·재사용, payer_contact_id]·**곡·콘텐츠 작업 자동저장**[저장 버튼 제거·디바운스 fetch·AJAX JSON으로 헤더 금액·상태 배지 갱신]), **연락처 유형 배지**(`classifyContact` — 녹음실 스태프/외주/고객측/디렉터 겸직), **스태프 청구서 발행 허용**(`canBill`/`requireBilling` 신설 — 청구서 생성·발행·수정·입금·삭제·PDF·프로젝트 청구 탭·from-tasks를 스태프에 개방; **매출 현황·외주 정산(지급)은 `requireInvoice`[치프·대표] 유지** — 매출 집계·돈 지급은 관리자), **연락처 표시·담당자 연동·클라이언트 권한**(상세 '성명' 줄 한국식[성+이름 붙이고 호칭 뒤]·**대표 연동 '하우스 엔지니어' 오배지 제거**[owner는 작업 담당자 아님 — `getManagerByContactId`·`syncUserToManager` 제외]·**담당자→연락처 성·이름 자동 분리**[`splitKoreanName`]·**클라이언트 메뉴 스태프 접근**[`requireEditor`·첨부 서류만 치프]), **연락처 표시명 제거·전화 정규화·치프 역할 전환**(표시명 항목 제거[name 자동="김보종 대표님" 한국식]·`formatPhone` 010-####-####·치프↔스태프 전환[본인 잠금·최소 1치프·ADMIN 강등 유지]), **청구서 할인**(정액+정률·공급가 차감 후 VAT 재계산·선택 항목 동적 공급가·거래명세서 할인 라인·`invoices.discount_amount`) + **외주/하우스 담당자↔연락처 양방향 연동**(자동 노출·전화 양방향·외주 이메일 양방향·하우스 이메일 잠금·`project_managers.contact_id`)·**매출 아이콘 수정**, **클라이언트 첨부 서류**(사업자등록증·통장사본 드래그앤드롭·매직바이트·치프 인증 다운로드·`client_files`) + **연락처 확장·Google People API 양방향 동기화**(성·이름·호칭·별명·회사·직책·부서; push+수동 'Google 동기화' 버튼·삭제 양방향·fail-safe·자동 cron 제거), **세션·담당자·매출 개선**(세션 **담당 디렉터**[연락처 콤보·참여세션]·**룸 기본 A**·**예약담당자 기본값**·**외주단가 조건부**[하우스 숨김]·**하우스/외주 작업자 정보수정**·**매출 현황 메뉴**[엔지니어별 작업+세션]·연락처 tel/mailto 링크), **프로젝트 폼 개선**(마감일 제거·**고객측 담당자** 정보표시[전화·이메일·소속]·목록 외 이름→**새 연락처 자동생성**·body limit·0원 단가 가드), **/audit 진단 후속**(수동 청구 VAT 역산·세션 겹침 전 타입·from-tasks 에러 정합 + **금전 핵심 테스트 24개** node:test)·**진단 프롬프트**(`docs/IMPROVEMENT_AUDIT_PROMPT.md`·`/audit`), **전방위 점검(ultrawork)**(세션 시간유실·발행알림 누락·삭제가드·죽은코드·UX·`notifyInvoiceIssued` 일원화), **청구처 청구시점 이동**·**용어 통일**(실결제자→청구처·담당 엔지니어·고객측 담당자)·**프로젝트 유형 구분 폐기**·**연락처(담당자) 도메인**, 문서 현행화.
> **직전 완료**: 디자인 기반(Pretendard·쿨톤 info색·사이드바 그룹화·테마 토글·listGroup/listRow/emptyState·opacity.12 수정), 백엔드 정리(resolveEndTime 단순화·0원 가드·죽은코드 제거·parseMoney/timeToMin 통합·운영시간 인프라), 라운드2 UX(세션폼 조건부 단가·완료1클릭·검색·운영시간 슬롯·실결제자 가시화·청구 진입점 단일화·클라이언트 검색·대시보드 강화).
> **이전 완료**: 다중 룸(룸별 겹침·FreeBusy 폐기·룸 CRUD), 외주 지급단가(`worker_rate`·`engineer_id`·정산), 청구 완료요건 통일, 정합보수(세션잠금·삭제가드·발행알림·채번원자화), 보안 하드닝(CSRF·OAuth 논스·SSRF·매직바이트), UX(대시보드 세션카드·마감일·유형변경·곡일괄·청구검색·견적서·세션액합산), UI 공통 헬퍼(tabBar·filterChips·projectTypeBadge·badge·AA대비), 외주 관리 일원화.
> **더 이전 완료**: Render 실배포·OAuth, 프로젝트 유형(세션/작업), 세션 UX(그리드·슬라이더·캘린더 뷰), 녹음 세션 직접 청구, 클라이언트 자동 등록·상세, 외주 작업자 메뉴, 탭 그룹화, 작업 종류 카탈로그, 거래명세서 PDF, 알림 채널(웹훅).
