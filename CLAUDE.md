# OMG Studios Manager — 설계 일지 (CLAUDE.md)

> 녹음/믹싱 스튜디오 **프로젝트 관리 · 자료 전달 · 청구** 내부 웹앱.
> 녹음실 내부 전용 도구. 역할 3단계: **대표(owner)** = 전체 모니터링 + 청구 열람·관리,
> **치프 엔지니어(chief)** = 운영 전반(스태프·담당자·클라이언트·설정 관리 + 프로젝트 편집 + 청구),
> **스태프(staff, 엔지니어·매니저)** = 프로젝트·곡·작업·자료 편집까지. 전원 Google 화이트리스트
> 로그인(치프가 허용한 계정만). 클라이언트(아티스트/소속사/제작사)는 프로젝트 데이터로 존속하고 로그인하지 않는다.
> 선행 플레이북 2종(`webapp-build-playbook.md`, `녹음실-앱-개발-경험-플레이북.md`)의 검증된 패턴·함정 반영.
> 이 파일은 **살아있는 설계 일지**다(현재 상태·아키텍처·데이터 모델·env·함정·TODO). 변경 시 갱신할 것.
> 상세 변경 근거는 git 커밋 메시지에 있다. 배포 런북=`DEPLOY.md`, 작업 이어가기=`WORKFLOW.md`.

## 현재 상태 (2026-06-29)

**프로덕션 라이브**: `https://omg-studios-manager.onrender.com` (Render web + 일일 백업/연체 cron). 기능별 현재 동작:

### 인증 · 권한
- 전원 Google OAuth + 화이트리스트(`users`) 로그인 → httpOnly 서명 JWT(30일). 비밀번호 로그인 폐기.
- 3단계 역할: **대표(owner)**=전체 열람 + 청구, **치프(chief)**=운영 전반, **스태프(staff)**=프로젝트·작업·자료 편집.
- 미들웨어: `requireAuth`(보기) / `requireEditor`(편집, 대표 차단) / `requireChief`(관리) / `requireInvoice`(청구).
  내부 도구라 로그인 직원은 전 프로젝트 열람. 치프가 `/settings`에서 화이트리스트(이메일+역할) 운영.

### 프로젝트
- 유형 2종(핵심 모티브): **세션**(`session`, 클라이언트 방문·예약·실시간 작업) / **작업**(`task`, 예약 없이 항목만). "+ 새 프로젝트" 드롭다운.
  세션형은 **세션 일정 탭**이 기본, 작업형은 **세션 탭 없이** 곡·콘텐츠가 기본(레거시 `NULL`은 세션 탭 유지). 구 `recording→session`·`mixing→task`는 멱등 마이그레이션(`project_type_rename_v1`)으로 1회 전환.
- 상세는 **탭**: `세션 일정 / 곡·콘텐츠 / 자료 전달 / 청구`(청구는 청구권자만). 메타 카드는 탭 위 고정, URL `?tab=`.
- 메타: 프로젝트명·아티스트·소속사/레이블·제작사·실결제자·담당자(보기 우선, 편집은 `<details>`). 아티스트/소속사/제작사는
  기존값 기반 `<datalist>` 자동완성(브라우저 히스토리는 끔).
- 삭제=치프 전용(상세 메타 하단, CASCADE: 트랙·세션·자료 / 인보이스는 `project_id=NULL` 보존). 목록=한 줄 요약 카드 + 검색(`?q=`).

### 세션 일정(예약)
- 프로젝트 하위 세션 CRUD + 사이드바 `/sessions`(다가오는/지난). 예약 담당자·담당 엔지니어 별개(담당자 마스터 select).
- **폼 레이아웃(추가·편집 통일)**: 날짜·예약담당자·상태(3열) / 세션 종류·녹음 종류·담당 엔지니어(3열) / 시작·종료. **세션 종류(녹음/믹싱/마스터링/기타)는 항상 선택 가능**(세션형이 녹음에 국한되지 않음).
- **용어 통일**: `녹음 종류` = **단가표 항목**(`rate_item_id`, 스튜디오/로케이션 분류 optgroup, `rateSelectGrouped`).
  `세션 종류` = `session_type`(녹음/믹싱/마스터링/기타). 추가·편집 폼에서 동일 의미(이전 라벨 혼동 정리).
- 예약 폼=버튼 UX: 시작 시간 30분 그리드(14:00–18:30, 예약된 슬롯 회색, **선택=테두리 강조**). 그리드 밖은 '직접입력' →
  **텍스트 직접입력**(HH:MM; 숫자만 입력하면 콜론 자동 삽입 `1425`→`14:25`, `pattern`+서버 `cleanTime` 검증). (이전의 '녹음 종류 미선택 시 시작 시간 비활성' 필수 게이트는 세션 종류 가변화로 **미사용** — `rateSelectGrouped`의 `required`/`data-rate-required` 인터페이스만 보존, 향후 세션 종류='녹음' 시 동적 복원 가능.)
- 소요시간 **슬라이더**(30분 단위·최대 12시간) + 아래 `[1Pro][2Pro][직접입력]` 프리셋(슬라이더와 양방향 동기화). 종료는 서버가 시작+길이로 계산(`custom_hours`+`duration_mode=custom`, 1Pro=녹음 종류 기준시간).
  폼 인터랙션은 `public/js/app.js`(CSP: 인라인 0).
- **겹침 차단**: 앱 DB 세션 + (연동 시) 구글 캘린더 FreeBusy로 같은 시간 녹음/믹싱 충돌이면 409.
- **구글 캘린더 자동 연동**: 예약 시 스튜디오 캘린더에 일정 자동 생성/수정/삭제(제목=제작사·아티스트, 장소=기본 장소,
  `gcal_event_id` 추적). 미연동/오류는 fail-safe(예약은 정상). 역방향(캘린더→앱) 동기화는 미구현(보류).

### 곡 · 콘텐츠 (녹음과 별개의 후반작업)
- 프로젝트 하위 곡/콘텐츠(`project_tracks`) + 모듈형 작업(`track_tasks`). **진행 단계 빠른 버튼**(보컬튠·오디오편집·믹싱·
  마스터링, +기타는 전체 종류 그룹 드롭다운), 곡별 **진행 요약** 한 줄, 작업 행 컴팩트(상세는 행 '편집', **추가 시 자동 펼침** `?expand=`). **후반작업은 전부 트랙/콘텐츠 고정·수량 1 — 금액(`unit_price`=`total_price`)만 직접 입력**(과금 유형·수량 선택 UI 폐기, 라벨 표기).
- 청구된 작업(`is_invoiced=1`)은 수정·삭제 거부(invoice_items 스냅샷 보존). 트랙 삭제는 작업 CASCADE.

### 청구
- 인보이스 생성/수정/입금(부분→발행 유지·전액→입금완료)·상태 전이(미발행→발행→입금완료)·연체 파생.
  채번 `INV-YYYYMM-###`, VAT=공급가 10%, 돈=정수(원).
- 청구 탭 **청구 생성 폼**: 미청구 작업 + **청구 가능 녹음 세션**(녹음+단가+시간, 취소 제외)을 함께 체크박스로 노출 → 선택해 청구서로.
  **녹음 세션은 곡·콘텐츠/버튼 없이 직접 청구**: 세션 생성 즉시 예상 청구액이 청구 탭에 자동 반영, 선택 시 `invoice_items.session_id` 스냅샷으로 청구(곡·콘텐츠 안 거침). 청구되면 세션 수정·삭제 잠금(`SESSION_INVOICED`), 인보이스 삭제 시 자동 미청구 복원. 관련: `listBillableSessionsForProject`·`unbilledInvoiceForm`·`createInvoiceFromTasks`(task+session 혼합)·`isSessionInvoiced`.
- 대시보드: 미수금·이번 달 발행·연체(치프/대표만).
- **거래명세서 PDF**: 발행/입금완료 인보이스 → A4 PDF(`GET /invoices/:id/statement.pdf`, resvg+pdf-lib, `src/invoice-pdf.js`).
  레이아웃: 좌측 '내역서' 타이틀 + 공급자 헤더·**로고**(우측), 청구처 박스, **품목|금액** 표(수량·단가 생략 — 곡/세션 단위 고정), 소계/VAT/합계, **납부하실금액** 강조.
  공급자=스튜디오 세금정보·로고(환경설정), 공급받는자=클라이언트. `requireInvoice`·`no-store`·즉석 스트리밍(PII 최소화). 한글 폰트 `public/fonts`(서브셋 TTF) 번들.

### 클라이언트
- 통칭 **클라이언트** 마스터(`clients`: 아티스트/소속사·레이블/제작사/기타, `?kind=` 탭 필터). 프로젝트 저장 시 분류별 자동 등록.
  세금계산서 정보(`biz_no`·`owner_name`·`address`). **실결제자**=클라이언트가 특정 프로젝트/인보이스에서 갖는 결제 역할(`client_id`).

### 자료 전달
- 업로드(multer 디스크) → Drive/로컬 폴백 → 인증 다운로드(프록시) + 공개 만료 토큰 링크 `/d/:token`(다운로드 카운트·철회·만료).

### 관리(/settings) — 3탭
- **담당자**: 하우스 엔지니어(로그인, 작업 담당자 자동 연계)·외주 작업자(로그인 없이 직접 추가). 편집=추가/삭제(토글 폐기).
- **컨텐츠**: 단가표(녹음 종류)·**작업 종류 카탈로그**(곡·콘텐츠 후반작업 종류 + 기본단가·과금·분류·빠른추가). 모두 삭제-only.
- **환경설정**: 스튜디오 캘린더(겹침 검사·자동 연동 대상)·예약 일정 기본 장소·**공급자(스튜디오) 세금정보 + 로고**(거래명세서 PDF용; 로고는 PNG/JPG 업로드→base64).

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
- 세션(일정) → 단가표(1Pro) → 세션 시간제 자동 산정 → 예약 버튼 UX(그리드/소요시간) → 겹침 차단(DB+구글) → 구글 캘린더 자동 연동.
- 녹음 종류=단가표 분류(스튜디오/로케이션), 곡·콘텐츠=후반작업(튠·믹스·마스터링) 분리.
- 하우스 엔지니어↔작업 담당자 연계, 관리 페이지/프로젝트 상세 **탭** 그룹화, 청구 '청구 대기' 목록.
- Render 실배포 완료(빌드 함정: `tailwindcss` devDep → `npm install --include=dev`).
- **프로젝트 유형 재정의**: 녹음/믹스(recording/mixing) → **세션/작업(session/task)**. 세션=방문·예약·실시간, 작업=예약 없이 항목만(세션 탭 숨김). 세션 종류 항상 선택 가능(녹음 고정·필수 게이트 폐기).
- **녹음 세션 직접 청구**: 곡·콘텐츠/버튼 없이 세션이 곧 청구 라인(`invoice_items.session_id`). 생성 즉시 청구 탭 자동 노출·선택 청구·세션 잠금(`createTaskFromSession`/`청구 확정`/`/sessions/:id/bill` 폐기). 소요시간 입력은 슬라이더(30분·최대 12h, 1Pro/2Pro/직접입력 프리셋).

## 스택

| 영역 | 선택 |
|---|---|
| 런타임 | Node ≥20, Express 4 (CommonJS) |
| DB | SQLite — `better-sqlite3`(운영, prebuild) / `node:sqlite`(폴백) 어댑터(`src/sqlite.js`) |
| 인증 | 전원 Google OAuth + 화이트리스트(`users` 행) → httpOnly 서명 JWT 쿠키(30일). 비밀번호 로그인 폐기 |
| 저장소 | Google Drive(관리자 토큰 재사용, `drive.file`) — 자료 전달용. 미연동 시 로컬 디스크 폴백 |
| 캘린더 | Google Calendar(관리자 토큰, scope `calendar`) — 세션 겹침 검사(FreeBusy) + 일정 자동 생성/수정/삭제 |
| 보안 | helmet(CSP, 인라인 스크립트 0) + express-rate-limit + 토큰 AES-256-GCM 암호화 |
| 프론트 | 서버 렌더 HTML(`src/views.js`) + 클래식 폼 POST + 최소 JS(`public/js/app.js`), Tailwind CLI 빌드 |
| 배포 | Render Blueprint(`render.yaml`) + Disk — **라이브** |

## 아키텍처 핵심

- **role 기반 게이트(3단계)**: `attachUser`(활성 + owner/chief/staff만 세션 인정) → 권한 술어
  `isOwner`/`isChief`/`isStaffRole`, 복합술어 `canEdit`(chief|staff)·`canInvoice`(chief|owner)
  (모두 `auth.js`). 미들웨어: `requireAuth`(로그인=보기), `requireEditor`(canEdit=프로젝트·곡·작업·자료
  편집, **대표 차단**), `requireChief`(치프 전용=스태프·담당자·클라이언트·설정), `requireInvoice`(canInvoice=
  청구). 내부 도구이므로 로그인 직원은 모든 프로젝트를 열람한다(클라이언트 범위 강제 폐기).
- **Google 화이트리스트(`auth.js upsertUserFromGoogle`)**: 로그인 Google 이메일이 `ADMIN_EMAIL`(부트스트랩
  **치프=chief**, 없으면 자동 생성)이거나 `users`에 등록된 활성 행이면 그 역할로 로그인, 아니면 거부. 치프는
  `/settings`에서 사용자(이메일+역할 owner/chief/staff) 추가·역할변경·활성/비활성으로 화이트리스트를
  운영한다(본인·부트스트랩 치프는 잠금 방지로 강등/비활성 불가). 대표 계정은 치프가 owner로 등록한다.
- **미들웨어 순서(플레이북 §3-1)**: helmet/ratelimit → cookie/body → `attachUser` → 라우트 →
  **`express.static`은 맨 뒤**(보호 HTML은 라우트, static은 css/js 자산만). 인증 우회 방지.
- **작업 옵션/상태값 = 코드 상수**(`config.js`)가 단일 진실원천. DB CHECK 제약 금지(§2.8 마이그레이션 지옥 회피).
- **돈=정수(원)**, 날짜=`"YYYY-MM-DD"` 문자열(`src/lib/date.js`).
- **at-rest 암호화**(`db.encrypt/decrypt`, AES-256-GCM): Drive/Calendar refresh token 등 비밀.
- **모바일 UX(플레이북2 §5)**: 입력 16px(iOS 자동확대 방지), 반응형 카드, 콘텐츠 max-width 통일.

## 데이터 모델 (생성됨)

- `users(email, role[owner|chief|staff], name, google_sub?, active, client_id?[레거시], password_hash?[레거시])` —
  `active=0`이면 로그인 차단(화이트리스트 제거). 마이그레이션에서 기존 `admin`→`chief` 자동 승계.
  `password_hash`/`client_id`는 구 모델 잔재 컬럼(미사용).
- `clients(name, kind[아티스트|소속사/레이블|제작사|기타], phone?, email?, memo?, biz_no?, owner_name?, address?)` —
  UI상 **클라이언트**(통칭). 프로젝트의 아티스트·소속사/레이블·제작사가 저장 시 분류별로 자동 등록되고
  (`ensureClientsFromProject`), 그중 하나가 프로젝트/인보이스의 **실결제자(공급받는 자)** 역할로 선택된다(`client_id`).
  `biz_no`(사업자등록번호)·`owner_name`(대표자)·`address`(사업장 주소)는 세금계산서용 상세정보.
- `projects(title, project_type[session|task], artist?, artist_company?, production_company?,
  client_id?→clients ON DELETE SET NULL, manager_id?→project_managers ON DELETE SET NULL, services JSON, due_date?, rate, memo)` —
  `services`는 레거시 `{key,label,...}` 배열(편집 UI 제거). `status`·`kind`·`due_date`는 호환용으로만 유지.
- `project_managers(name, email?, phone?, active, user_id?→users, created_at)` — 작업 담당자 마스터.
  `user_id` 있으면 **하우스 엔지니어**(로그인 사용자와 링크, `auth.syncUserToManager`가 자동 생성·동기화),
  null이면 **외주 작업자**(로그인 없이 관리에서 직접 추가). 둘 다 세션·작업 담당 드롭다운에 노출.
- `task_types(key UNIQUE, label, task_group, billing_type, unit_price, is_quick, sort_order, active)` — **작업 종류 카탈로그**
  (곡·콘텐츠 후반작업). config `TASK_TYPES`를 `task_types_seed_v1` 게이트로 1회 시드 후 DB가 단일 진실원천(기존 9 key 보존, 신규=`tt_<hex>`).
  `track_tasks.task_type`이 이 key를 문자열로 보관(FK 아님). 라벨·그룹 해석은 `data.js` 모듈 캐시(`taskTypeLabel`/`taskTypeGroup`, 쓰기 시 무효화).
  `is_quick`=곡·콘텐츠 빠른추가 버튼 노출, `unit_price`=빠른추가 기본 단가. 삭제-only(강제), 치프가 `/settings` 컨텐츠 탭 CRUD.
- `project_service_items(key UNIQUE, label, active, created_at)` — 레거시(구 services JSON 라벨 호환). **관리 UI 폐기**(작업 종류 카탈로그가 대체), 테이블만 잔존.
- `rate_items(name, category[스튜디오 녹음|로케이션 녹음], base_minutes, base_price, extra_minutes, extra_price, active)` —
  **단가표 · 녹음 종류**. `category`(`RECORDING_CATEGORIES`)로 분류, 세션 폼의 '녹음 종류'에 분류별 optgroup으로
  묶여 표시된다. 기준 시간(1Pro) 안은 `base_price`, 초과는 `extra_minutes` 단위 올림으로 `extra_price` 과금
  (`base_minutes=0`이면 정액). `computeRatePrice(item, minutes)`가 산정. 관리 메뉴에서 치프가 CRUD.
- `project_tracks(project_id→projects CASCADE, title, content_type[Music|Video_Post], created_at)` —
  프로젝트 하위 곡·콘텐츠. `content_type` 상수·정규화(`config.js`)는 있으나 **현재 UI 미노출 → 전부 Music**, 영상 구분은 향후 확장용.
- `track_tasks(track_id→project_tracks CASCADE, task_type, billing_type[Time_Charge|Fixed_Per_Track],
  quantity, unit_price, total_price, engineer_name?, status[Pending|In_Progress|Completed],
  is_invoiced, invoice_id?, session_id?→sessions SET NULL)` — 실제 청구 가능한 모듈형 작업 단위.
  `session_id`는 녹음 세션에서 자동 생성된 작업 추적(부분 유니크: 세션당 1건).
- `deliverables(project_id→projects ON DELETE CASCADE, title, version, kind, storage_backend[drive|local],
  file_id, file_name, file_size, mime_type, access_token?, expires_at?, download_count, revoked, note)`
- `invoices(project_id?→projects SET NULL, client_id?→clients SET NULL, title, amount, paid_amount,
  invoice_number?, tax_amount, status[미발행|발행|입금완료], issued_date?, due_date?, memo)` —
  돈=정수(원), 연체·부분납은 코드 파생. `amount`는 VAT 포함 총액.
- `invoice_items(invoice_id→invoices CASCADE, task_id?→track_tasks SET NULL, session_id?→sessions SET NULL, track_title, task_type,
  description, quantity, unit_price, amount)` — 청구서 라인아이템 스냅샷.
- `sessions(project_id→projects CASCADE, session_type[녹음|믹싱|마스터링|기타], session_date,
  start_time?, end_time? "HH:MM", booker_name?, engineer_name?, status[예정|완료|취소], memo,
  rate_item_id?→rate_items SET NULL, gcal_event_id?)` — 스튜디오 일정.
  `booker_name`(예약 담당자)·`engineer_name`(담당 엔지니어)은 둘 다 담당자 마스터에서 선택(별개 역할).
  `rate_item_id`는 녹음 세션 시간제 자동 산정용 단가표 연결. `gcal_event_id`는 자동 생성한 구글 캘린더 일정 id(수정·삭제 추적).
- `admin_state(key, value)` — drive folder_id·refresh token(암호화)·테마 캐시·`studio_calendar_id`(스튜디오 캘린더)·`studio_location`(기본 장소)·`studio_biz_*`(공급자 세금정보, 거래명세서 PDF용, 평문)·`studio_logo`(거래명세서 로고, base64 data URI)·`alert_webhook_url`(알림 웹훅, 암호화).
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
| `GOOGLE_CLIENT_ID`/`SECRET` | OAuth(로그인 + Drive + Calendar). scope: `openid·email·profile·drive.file·calendar` |
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
4. **OAuth state로 next 전달** 시 base64url + open-redirect 방지(`safeNext`, 내부 경로만).
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

## 검증 상태

- 로컬 E2E(DEV_LOGIN=1, 브라우저 헤더 기준): 인증·권한 3단계 매트릭스, 프로젝트/세션/곡·작업/청구 CRUD, 자료 업로드·
  토큰 다운로드, 작업→청구 VAT 10%·채번·스냅샷·잠금, 세션 시간제 산정·겹침 차단·예약 그리드, 클라이언트 자동 등록,
  하우스 엔지니어 연계, 탭 전환·리다이렉트, 청구 대기 전환 — 통과.
- 프로덕션: Google OAuth 로그인·`/healthz`·일일 백업 cron 트리거 통과.
- **구글 캘린더 자동 연동/겹침 검사**: 코드·fail-safe 검증 완료. 실제 동작은 사용자 사전작업(GCP Calendar API 활성화 +
  치프 재로그인(scope `calendar`) + `/settings`에서 캘린더 선택 + 기본 장소 입력) 후 확인.
- **Drive 실연동**: 미검증(자료 업로드 시 local→drive 자동 전환, 현재는 local 저장).

## 다음 단계 TODO

1. (선택) 월 캘린더 그리드 뷰(현재는 목록), 대시보드 임박 세션 카드.
2. (선택) 구글 캘린더 역방향 동기화(캘린더에서 삭제→앱 반영) — 보류 중.
3. Drive 실연동 검증.
4. **거래명세서 PDF 프로덕션 확인** — Render Linux에서 `@resvg/resvg-js` 네이티브 prebuilt 설치·렌더 동작 확인(로컬 검증 완료).
5. (선택) 알림 Gmail 어댑터 — 현재 웹훅만. 클라이언트 직접 메일 통지가 필요해지면 `notify.js`에 어댑터 추가.
