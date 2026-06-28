# OMG Studios Manager — 설계 일지 (CLAUDE.md)

> 녹음/믹싱 스튜디오 **프로젝트 관리 · 자료 전달 · 청구** 내부 웹앱.
> 녹음실 내부 전용 도구. 역할 3단계: **대표(owner)** = 전체 모니터링 + 청구 열람·관리,
> **치프 엔지니어(chief)** = 운영 전반(스태프·담당자·클라이언트·설정 관리 + 프로젝트 편집 + 청구),
> **스태프(staff, 엔지니어·매니저)** = 프로젝트·항목·작업·자료 편집까지. 전원 Google 화이트리스트
> 로그인(치프가 허용한 계정만). 거래처(실결제자)는 프로젝트 데이터로만 존속하고 로그인하지 않는다.
> 선행 플레이북 2종(`webapp-build-playbook.md`,
> `녹음실-앱-개발-경험-플레이북.md`)의 검증된 패턴·함정을 반영해 구축.
> 이 파일은 **살아있는 설계 일지**다(아키텍처·env·함정·검증 상태·TODO). 변경 시 갱신할 것.

## 현재 상태 (2026-06-28)

- **MVP 동작**: 인증(role 기반) + 프로젝트 관리 + 거래처 + 대시보드 end-to-end. 로컬 검증 완료.
- **자료 전달 동작**: 업로드(multer 디스크) → 스토리지(Drive/로컬 폴백) → 인증 다운로드(프록시) +
  공개 만료 토큰 링크 `/d/:token`(다운로드 카운트/철회/만료). 로컬 검증 완료.
- **청구 동작**: 인보이스 생성/수정, 입금 처리(부분→발행 유지·전액→입금완료 자동), 상태 전이
  (미발행→발행→입금완료), 연체 파생, 미수금/이번 달 발행/연체 대시보드, 프로젝트 하위 청구 섹션,
  URL 필터(전체/미발행/발행/연체/입금완료). 로컬 검증 완료.
- **트랙/작업 청구 동작**: 프로젝트 하위에 1..N개 트랙/콘텐츠(`project_tracks`)를 만들고, 각 트랙에
  모듈형 작업(`track_tasks`: Vocal_Recording, Mixing, Mastering, ADR 등)을 추가한다. 완료+미청구 작업만
  선택해 인보이스를 생성하면 `invoice_items` 라인아이템으로 복사되고 원 작업은 `is_invoiced=1`로 잠긴다.
  청구번호는 `INV-YYYYMM-###`, VAT는 공급가의 10%로 자동 계산한다.
- **항목 모델**: 프로젝트의 항목은 곧 트랙/콘텐츠(`project_tracks`)다. 항목 아래에 모듈형 작업
  (`track_tasks`: 녹음, 보컬튠, 믹싱, 마스터링, ADR 등)을 자유롭게 추가한다. 레거시 `projects.services`
  편집 UI는 제거했고, 기존 `services` 데이터는 트랙/콘텐츠가 없는 프로젝트에 한해 항목+작업으로 자동 보강한다.
- **프로젝트 상세 UX(2026-06-27 개편)**: 상세는 **보기 우선**이다. 진입 시 메타는 한 줄 요약
  (아티스트 · 거래처 · 담당자 / 견적 · 완료일)으로만 보이고, 편집 폼은 메타 카드의 `편집`(`<details>`)을
  펼쳐야 나온다(저장 검증 실패 시 `open`으로 자동 펼침). 핵심인 `항목 · 작업` 섹션을 메타 바로 아래로
  올렸고, `자료 전달`·`청구`는 접이식(`<details>`, 닫힌 상태에 개수/미수금 노출)으로 덜어냈다. 옛
  "세션 일정 안내" 카드는 제거. 클라이언트는 편집 없는 읽기 요약 + 동일한 접이식 섹션만 본다.
  토글은 전부 CSP 안전한 `<details>/<summary>`(JS 0).
- **미청구 작업 청구 생성 위치 이동(2026-06-27)**: "미청구 작업 청구 생성" 폼을 `항목 · 작업`
  섹션에서 `청구` 섹션 안(펼친 내용 맨 위)으로 옮겨 청구 관련 동작을 한 곳에 모았다. 청구 섹션은
  접이식이지만 **미청구 작업이 있으면 자동으로 펼치고**(`open`) 헤더에 `미청구 N` 배지를 띄운다.
  미청구가 0건이면 폼 자체를 렌더하지 않는다. `invoicesSection(unbilledForm, unbilledCount)` 인자로
  전달.
- **프로젝트 목록 UX(2026-06-27)**: 상세와 같은 한 줄 요약 방식으로 통일했다. 카드는 항목 제목
  뱃지를 전부 나열하던 방식을 버리고 `제목 / 메타 한 줄(아티스트 · 거래처 · 담당자) / 항목 N개`
  + 우측 `견적 · 완료일`로 축약한다(`projectListCard`, 항목 수는 `track_titles`에서 파생).
- **항목 분류(content_type) UI 제거(2026-06-27)**: 음악/영상·후시(Music/Video_Post) 분류 개념을
  UI에서 완전히 없앴다. 항목 추가/편집 폼의 셀렉트와 카드의 분류 라벨을 모두 제거하고, 항목명만
  입력받는다(placeholder도 `항목명`으로 단순화). 항목 추가 버튼은 입력칸 우측으로 이동. DB의
  `project_tracks.content_type` 컬럼은 마이그레이션 회피 위해 유지하되 `normalizeTrackContentType`이
  기본값 `Music`을 자동으로 채운다. `config.js`의 `TRACK_CONTENT_TYPES` 상수는 남겨두었으나 UI 미사용.
- **프로젝트 상세 필드**: 프로젝트 명, 아티스트, 아티스트 소속사, 제작사, 거래처, 담당자를 기본 메타로 둔다.
  항목은 프로젝트 상세의 `항목 · 작업` 섹션에서 직접 추가한다.
- **관리 페이지**: `/settings`에서 담당자와 작업 템플릿을 추가/활성/비활성 관리한다.
- **메인터넌스(2026-06-26)**: `googleapis` 173.0.0 업데이트로 `npm audit --omit=dev` 0건 확인.
  CSP가 `script-src-attr 'none'`을 적용하므로 상태 셀렉트 자동 제출은 인라인 `onchange` 대신
  `data-autosubmit` + `public/js/app.js` 리스너로 처리.
- **하드닝(2026-06-27)**: 프로덕션 기본 시크릿/`DEV_LOGIN` fail-fast, POST 동일 출처 검사, 관리자
  비밀번호 로그인 차단(클라이언트 전용), 인보이스-프로젝트-거래처 범위 정합성 보강, 자료 다운로드
  `no-store`, 실제 달력 기준 날짜 검증 적용.
- **프로젝트 항목(2026-06-27)**: UI 명칭을 정리해 `항목 = 트랙/콘텐츠`로 통일했다. 상단 레거시
  `services` 항목 편집은 숨기고, 프로젝트 상세에서는 `항목 · 작업` 섹션만 사용한다.
- **Track/Task/Invoicing(2026-06-27)**: 명세 기반으로 `project_tracks`, `track_tasks`, `invoice_items`를
  추가했다. HTML UI와 REST API(`/api/projects`, `/api/projects/:id/tracks`, `/api/tracks/:id/tasks`,
  `/api/projects/:id/unbilled-tasks`, `/api/invoices`)가 같은 데이터 헬퍼를 사용한다.
- **항목/작업 수정·삭제(2026-06-27)**: 프로젝트 상세에서 항목(트랙)·작업을 인라인 편집/삭제한다.
  CSP(인라인 스크립트 0) 제약 때문에 토글 UI는 JS 없이 동작하는 `<details>/<summary>`로 구현했다.
  라우트: `POST /projects/tracks/:trackId`(수정), `/projects/tracks/:trackId/delete`,
  `POST /projects/tasks/:taskId`(수정), `/projects/tasks/:taskId/delete`. 데이터 헬퍼는
  `updateTrack/deleteTrack/getTaskForUser/updateTask/deleteTask`. **정합성 가드**: 이미 청구된
  작업(`is_invoiced=1`)은 수정·삭제 모두 400으로 거부하고, 청구된 작업을 가진 항목은 삭제도 거부한다
  (invoice_items 스냅샷 보존). 트랙 삭제는 하위 작업을 CASCADE로 함께 제거한다.
- **인증 모델 개편(2026-06-27)**: 거래처 외부 열람(client/비밀번호)을 폐기하고 **내부 도구**로 전환.
  역할 = 치프(admin)/스태프(staff), 전원 Google 화이트리스트 로그인. 스태프는 프로젝트·항목·작업·자료까지,
  청구·거래처·설정·사용자관리는 치프 전용. `/settings`에 사용자(로그인 계정) 관리 섹션 추가. 로그인 화면은
  Google 버튼만(비밀번호 폼 제거). `data.js`의 거래처 범위 강제 로직 제거(직원 전체 열람). 대시보드의 청구
  통계는 치프에게만 노출. 자세한 내용은 아키텍처 핵심·환경변수 절 참고.
- **디자인 보완(2026-06-27)**: 제목 세리프(`Source Serif 4`)에 한글 글리프가 없어 한글 제목이 시스템
  폰트로 떨어지던 문제를, 폰트 스택에 `Noto Serif KR`을 추가해 한/영 제목 톤을 통일.
- **거래처 → 실결제자(공급받는 자) 개편(2026-06-28)**: 프로젝트의 "거래처" 항목을 "실결제자(공급받는 자)"로
  명칭 변경(아티스트/소속사/제작사 누구나 결제 주체가 될 수 있음). 데이터는 기존 `clients`(거래처 마스터)를
  실결제자 마스터로 그대로 사용하고, 세금계산서용 상세정보(`biz_no`·`owner_name`·`address`)를 추가했다.
  UI 라벨: `/clients` 페이지·대시보드 통계·프로젝트 폼·청구 폼은 "실결제자", **사이드바 메뉴만 "클라이언트"**.
  `clients` 테이블/코드 식별자는 유지(라벨만 변경).
- **권한 3단계 개편(2026-06-28)**: 2단계(admin/staff) → **owner(대표)/chief(치프)/staff** 3단계로 확장.
  대표=전체 열람(모니터링) + 청구 관리, 치프=운영 전반, 스태프=프로젝트·작업·자료 편집. 미들웨어를
  `requireEditor`(편집)·`requireChief`(관리)·`requireInvoice`(청구)로 세분화하고, `data.js`의 `isAdmin`을
  걷어내 권한 술어(`canEdit`/`canInvoice`/`isChief`)로 교체. NAV·대시보드·프로젝트 상세를 역할별로 분기.
  전방위 UI/UX 점검도 수행(용어 일관성·검색·저장 피드백·온보딩 등 개선 후보는 TODO에 반영).
- **세션(일정) 기능(2026-06-28)**: 프로젝트 하위 세션(`sessions`: 녹음/믹싱/마스터링, 날짜·시간·엔지니어·
  상태) CRUD + 사이드바 **일정** 메뉴(`/sessions`: 다가오는 + 지난 세션 접이식). 프로젝트 상세에 세션 섹션
  추가(곡·콘텐츠 다음). 엔지니어는 담당자 마스터 select. 권한: 보기=전원, 편집=치프/스태프(대표 열람전용
  403). `views.sessions.js`·`routes/sessions.routes.js`·data 헬퍼(`createSession`/`updateSession`/
  `setSessionStatus`/`deleteSession`/`upcomingSessions`/`pastSessions`).
- **클라이언트 분류 탭(2026-06-28)**: 거래처 분류를 `아티스트·소속사/레이블·제작사·기타`로 재정의(레이블→
  소속사/레이블, 대행사→제작사 마이그레이션). `/clients`에 탭(전체목록·아티스트·소속사/레이블·제작사,
  개수 배지) + `?kind=` 필터(`listClients({kind})`·`clientKindCounts`).
- **프로젝트 유형 분기(2026-06-28, 1단계)**: "+ 새 프로젝트"를 `<details>` 드롭다운으로 **녹음 세션 /
  믹스·작업 세션** 2유형 노출. `projects.project_type`(recording|mixing) 저장, 유형별 생성 폼 안내 +
  **상세 화면 순서 분기**(녹음=세션 먼저, 믹스=곡·콘텐츠 먼저). 목록 카드에 유형 배지.
- **단가표/과금 항목(2026-06-28, 2단계)**: 관리 메뉴(`/settings`)에 단가표 섹션. 항목별 기준시간(1Pro,
  시간 입력→분 저장)·기준가·초과단위·초과단가 CRUD(치프 전용). `computeRatePrice`로 진행 분→금액 자동
  산정(보컬녹음 3.5h=30만·초과 1h당 10만·그룹 35만 시드). 단위 검증·권한·E2E 통과.
- **세션→청구 자동 산정(2026-06-28, 3단계)**: **녹음 세션만 시간제**(믹싱/마스터링은 건별 고정 유지). 세션에
  `rate_item_id`(단가표) 연결 컬럼 추가, `완료`+`시작·종료`+단가 항목이 있으면 진행분을 `computeRatePrice`로
  산정해 **예상 청구액**을 세션 행/전역 일정에 표시. 프로젝트 상세에서 `이 세션으로 청구 작업 생성` 폼(기존
  곡·콘텐츠 선택, 없으면 세션명 트랙 자동 생성)으로 `track_task`(billing_type=`Time_Charge`, status=`Completed`)를
  만들면 기존 `createInvoiceFromTasks` 청구 흐름에 그대로 합류. `track_tasks.session_id`로 세션↔작업 추적 +
  **부분 유니크 인덱스로 세션당 1건 중복 청구 차단**. 라우트 `POST /sessions/:id/bill`(requireEditor=치프/스태프,
  대표 403). 진행시간 헬퍼 `minutesBetween`(동일 시각=0분, end<start만 야간 자정 넘김), `createTaskFromSession`은
  `완료` 상태 강제·트랜잭션(고아 트랙 방지)·track 프로젝트 소속 검증(IDOR). 데이터계층 통합 + 브라우저 헤더
  E2E(생성 302·중복 400·대표 403·교차출처 403·CSP 인라인 0) 통과.
- **전방위 견고화(2026-06-28, 실브라우저 기준)**: curl이 아니라 **브라우저 헤더(Sec-Fetch-Site·Origin·
  multipart)로 전수 E2E** 점검. ① 동일 출처 검사를 **Sec-Fetch-Site 우선 + host(프로토콜 무시) 비교**로
  바꿔 로컬 http 폼 제출 403(함정 7) 해결, ② **asyncHandler** 래퍼로 deliverables async 라우트 에러
  누수 방지(Express 4), ③ **에러 페이지(404/403/500/413)를 raw 텍스트 → 스타일 레이아웃**(`errorPage`, 프로젝트·청구
  상세 404 포함), ④ 디버그 로깅 간결화, ⑤ 세션 폼 필드 순서를 `날짜·종류·엔지니어·상태·시작·종료`로
  (예약 시 정하는 값 먼저, 실제 진행 시간은 뒤). 접근성 label-for는 동적 폼 id 충돌·내부도구 특성상 보류. 실제 파일 업로드→인증/토큰 다운로드(내용 일치)→삭제 E2E·XSS 이스케이프·업로드
  용량 limit 검증 통과. (교훈: 메인터넌스는 반드시 브라우저 헤더로 폼 제출까지 E2E 검증할 것)
- **메인터넌스(2026-06-28)**: 전 파일 문법·`npm audit --omit=dev`(0건)·`build:css`·부팅·권한 스모크 통과,
  DB `integrity_check=ok`·FK 위반 0·WAL 체크포인트(1.3MB→0). UI 잔존 "거래처"→"실결제자"(청구 행·대시보드
  카드) 정리, 제거된 `isAdmin` 언급 주석 갱신, 레거시 backfill fallback "항목"→"곡·콘텐츠". 작업 이어가기용
  핸드오프 가이드는 `WORKFLOW.md`에 정리.
- **검색 + 저장 피드백(2026-06-28)**: 프로젝트 목록에 제목·아티스트 검색 폼 추가(`?q=`, listProjects가
  `title/artist LIKE`로 필터). 폼 저장/추가/삭제 후 `?flash=saved|created|added|deleted|paid`로 리다이렉트
  하면 `flashBanner`(views)가 성공 배너를 렌더하고 `public/js/app.js`가 2.5초 뒤 페이드 + URL에서 flash
  파라미터 제거(CSP 안전, 외부 스크립트). 프로젝트·청구·클라이언트·설정에 적용.
- **작업 엔지니어 선택 + 용어 직관화(2026-06-28)**: 작업의 `engineer_name`을 자유입력 → **담당자 마스터
  select**로 변경(`engineerSelect`, 이름 텍스트 저장 유지·과거 자유입력값은 "(목록 외)"로 보존). 담당자는
  `/settings`에서 치프가 관리. 프로젝트 하위 "**항목**" 용어를 **"곡 · 콘텐츠"**로 일괄 직관화(섹션 제목·
  버튼·placeholder·빈 상태·목록 카드·에러 메시지). 코드 식별자(`project_tracks`/`track`)는 유지.
- **네트워크 유실 복구 + 재검증(2026-06-28)**: 직전 세션이 네트워크 유실로 중단(`data.js`·`db.js`·
  `invoices.routes.js`·`projects.routes.js`가 문서 갱신 이후 수정됨). 코드 일관성·부팅·문법·DB 무결성
  점검 후 **중단됐던 최종 검증을 전수 재현**: 데이터계층 E2E(작업→청구 VAT 10%·채번·스냅샷·잠금·좀비방지·
  단가산정) 17/17, 권한 매트릭스(owner/chief/staff×6경로) 명세 일치, 라우트 배선(from-tasks·세션청구
  권한/검증·CSRF) 전부 통과. 미완 마커·편집기 잔여파일 없음 → **변경분은 일관·완성 상태로 확인**.
- **Render 배포 1단계: 백업/연체 cron 구현(2026-06-28)**: 문서상 "후속"이던 `BACKUP_TOKEN` cron을 구현.
  `src/lib/maintenance.js`(SQLite `VACUUM INTO` 일일 백업 + 14일 보존 prune + 연체 요약, `data.listInvoices`
  overdue 재사용), `src/routes/maintenance.routes.js`(`POST /internal/cron/daily`·`GET /internal/cron/overdue`,
  `BACKUP_TOKEN` 상수시간 게이트: 미설정→404·불일치→401), `src/jobs/cron-trigger.js`(Render cron 진입점,
  Node 내장 fetch만·의존성 0·성공0/실패1 종료코드). **Render Disk는 단일 서비스만 attach**되므로(공식
  문서 확인) cron이 SQLite에 직접 접근 못 함 → cron이 web을 HTTP 트리거하는 정석 구조. `render.yaml`에
  cron 서비스(`schedule "0 18 * * *"` UTC=03:00 KST, `fromService hostport`로 web 내부주소) 추가,
  `DEPLOY.md` 배포 런북(git init·시크릿·OAuth·검증) 신설. 로컬 E2E(토큰 401/200/404·백업 무결성+데이터
  보존·prune 14·트리거 종료코드·프로덕션 fail-fast) 통과. **실제 배포(GitHub 푸시·Render 계정·시크릿·GCP)는
  사용자 단계** — `DEPLOY.md` 참조.
- **Render 실배포 완료(2026-06-28)**: `https://omg-studios-manager.onrender.com` live. Google OAuth 로그인·
  `/healthz`·일일 백업 cron 수동 트리거(172KB DB 생성·연체 스캔) 전부 통과. 빌드 함정: `tailwindcss`가
  `devDependencies`라 `NODE_ENV=production`에서 `npm ci`가 건너뜀(exit 127) → `npm install --include=dev`로
  변경해 해결. 세부 체크포인트 = `DEPLOY.md`(전 단계 ✅).
- **프로젝트 삭제(2026-06-28)**: 상세 메타 카드 편집 영역 하단에 `프로젝트 삭제`(치프 전용,
  `POST /projects/:id/delete`=requireChief, `data-confirm` 경고). 트랙·세션·자료는 CASCADE, 인보이스는
  `project_id=NULL`로 보존. 프로젝트 목록에는 삭제 버튼 없음(상세에서만).
- **마감일 제거(2026-06-28)**: 녹음은 세션 일정으로 관리하므로 프로젝트의 `마감일(완료 예정)` 입력·표시를
  새 폼·편집 폼·메타 요약·목록 카드에서 제거. DB `due_date` 컬럼·인보이스 연체 로직은 유지.
- **믹스 세션 섹션 접힘(2026-06-28)**: `sessionsSection`에서 `project_type==='mixing'`이면 세션 일정을
  `<details>` 기본 접힘으로(필요 시 펼침). 녹음은 세션이 핵심이라 항상 펼침.
- **녹음 프로젝트 작성 경험 개편(2026-06-28)**: ① 세션 폼 순서를 **날짜·상태 → 예약 담당자·담당 엔지니어 →
  녹음 종류·단가 → 시작·종료 → 메모**로 재배치(예약 시 정하는 값 먼저). ② `sessions.booker_name`(예약 담당자)
  컬럼 신설 — 담당 엔지니어와 별개 역할, 둘 다 담당자 마스터 select(`managerOptions`). ③ **구글 캘린더 '일정
  추가' 링크**(`googleCalendarLink`, `views.sessions.js`): 저장된 세션 행마다 제목·날짜·시간(KST)·상세가 채워진
  `calendar.google.com/.../render?action=TEMPLATE` 링크 노출. **OAuth 스코프/ Calendar API 불필요**(앱이 일정을
  만들지 않고 사용자가 새 탭에서 저장) → 재동의·GCP 변경 0. 시작·종료 둘 다 있으면 시간 일정, 없으면 종일(종료=익일).
  취소 세션은 링크 미노출. URLSearchParams 인코딩 + href `esc`로 XSS 안전. ④ 곡·콘텐츠 섹션에 녹음 의도 안내
  (일정 무관·한 세션 다곡·튠/믹스로 이어짐). 데이터 왕복·렌더·브라우저 헤더 통합 E2E(로그인 302·생성 302·예약
  담당자·캘린더 링크·시간 반영·폼 순서) 통과. **곡→튠/믹스 후속 워크플로·청구 연동은 추후(청구 개편과 함께).**
- **세션 시간 슬롯 + 겹침 예약 차단(2026-06-28)**: ① 시작·종료를 자유 `type=time`에서 **드롭다운(낮 12:00부터
  30분 단위 23:30까지, `SESSION_TIME_SLOTS`/`timeOptions`)**으로 단순화. 목록 밖 기존값(레거시·야간)은 selected
  옵션으로 보존. ② **시간 겹침 예약 차단**: `findSessionConflict`가 같은 날 시간대가 겹치는 다른 **녹음/믹싱**
  세션(스튜디오 전체·취소 제외)을 찾고, `createSession`/`updateSession`이 `assertNoSessionConflict`로 막는다
  (`SESSION_TIME_CONFLICT`→라우트 409 `errorPage`). 반열린구간[start,end) 겹침(경계 접촉 허용)·야간(자정 넘김)·
  update 자기 제외·시간 미정 생략. **검사 대상은 앱 DB의 세션**(곧 구글 캘린더로 푸시되는 동일 데이터) — 앱 밖
  구글 캘린더에 직접 만든 외부 일정까지 막으려면 Calendar API 읽기(스코프 재동의+GCP)가 별도로 필요(미구현, 사용자 결정 대기).
  데이터계층 12케이스 + 라우트 409 E2E 통과.
- **외부 구글 캘린더 겹침 차단(2026-06-28)**: 앱 밖(구글 캘린더에서 직접) 잡힌 일정과도 신규 세션 예약이
  겹치면 막는다. `src/calendar.js`(Drive와 동일 refresh token 재사용, **scope `calendar.readonly` 추가** →
  전 직원 재동의 필요): 치프가 `/settings`에서 고른 **전용 스튜디오 캘린더** 하나의 **FreeBusy**(바쁜 시간대만,
  일정 제목 미열람)를 읽어 겹치면 차단. `findExternalConflict`(RFC3339 KST·야간 익일·반열린 비교)를
  `POST /sessions`(신규만, `asyncHandler`)가 호출, 겹치면 409 `errorPage`. **미연동/권한없음/네트워크 오류는
  fail-open(통과)** — 검사 실패로 예약이 마비되지 않게. `studio_calendar_id`는 `admin_state` 저장,
  `/settings` "스튜디오 캘린더" 섹션에서 `calendarList`로 선택. **수정(update)에는 외부검사 미적용**(세션의 자체
  gcal 이벤트와 자기충돌 방지 — 이벤트 id 미추적). 앱 DB 세션끼리 겹침은 `findSessionConflict`(위 항목)가 담당.
  단위(상태 왕복·fail-open·검증·rfc3339·conflictFromFreebusy) + 부팅 통합(fail-open 302·설정 섹션·스코프) 통과.
  **사용자 사전작업: GCP에서 Calendar API 활성화 + 치프 재로그인(캘린더 권한 동의) + `/settings`에서 캘린더 선택.**
- **세션 예약 UX 버튼화(2026-06-28)**: 생성(예약) 폼의 시간 선택을 드롭다운 → **버튼 그리드**로. ① 시작 시간 =
  30분 슬롯 라디오 그리드(Tailwind `peer-checked`/`peer-disabled`, JS 없이 동작), **이미 예약된 슬롯은 회색
  비활성**(`peer-disabled:line-through`). ② 소요시간 = `[1Pro][2Pro][직접입력]` 라디오 → **종료는 서버가 시작+길이로
  계산**(`resolveEndTime`): 1Pro=단가 항목 기준시간(`base_minutes`), 2Pro=2배, custom=`custom_hours`. 단가 미선택
  +Pro는 `SESSION_PRO_NEEDS_RATE`(400). 야간(자정 넘김) `addMinutesToHHMM` 모듈러. ③ 비활성 표시는 `GET
  /sessions/availability?date=`(JSON: DB `busySessionSlots` ∪ 캘린더 `busySlotsForDate`, 외부 fail-open)를 `app.js`가
  fetch해 갱신(날짜 변경 시 재조회·예상 종료 미리보기·1Pro/2Pro는 단가 없으면 비활성). `SESSION_TIME_SLOTS`는
  `config.js`로 단일출처화. **편집 폼은 드롭다운 유지**(편집은 부차적, `end_time` 직접). 종료 자동계산 후에도
  겹침 차단·하위호환 유지. 데이터 11케이스 + 부팅 통합(가용성 JSON·생성 302·그리드 렌더·app.js 서빙) 통과.
- **정적 자산 캐시 버스팅(2026-06-28)**: `views.js ASSET_VERSION`(app.css·app.js mtime+size) → `/css/app.css?v=..`로
  참조. 캐시 버스팅이 없어 배포 후 브라우저가 옛 CSS를 재사용→레이아웃이 깨져 보이던 함정 해결(시작 그리드가
  한 줄씩 쌓이고 라디오 노출). **함정: 정적 자산 URL에 버전을 안 붙이면 배포해도 옛 CSS 캐시가 남는다.**
- **예약 시 구글 캘린더 자동 추가 + 그리드 14–20 + 직접입력(2026-06-28)**: ① 시작 그리드 기본 노출을
  **14:00~20:00**(`SESSION_START_SLOTS`)로 좁히고, 그 밖 시간은 **직접입력**(`start_time_custom`, 서버에서 우선).
  ② **예약하면 스튜디오 캘린더에 일정 자동 생성**(`calendar.createEvent`, 수정=`updateEvent`/취소·삭제=`deleteEvent`,
  `sessions.gcal_event_id` 추적). 제목=**제작사 · 아티스트**(`eventInputForSession`), 장소=관리에서 설정한
  `studio_location`(기본 장소). **OAuth 스코프 `calendar.readonly`→`calendar`(읽기+쓰기)**로 확대 → **전 직원 재동의 필요**.
  미연동/권한없음/오류는 **fail-safe**(일정 생성 건너뛰고 예약은 정상). 외부 겹침 검사는 **해석된 시작/종료**(직접입력·
  소요시간 반영) 기준으로 createSession 후 검사→겹치면 롤백. ③ 수동 "구글 캘린더에 추가" 링크는 자동화로 **제거**.
  ④ `/settings`에 **기본 장소** 입력. 단위 10케이스 + 부팅 통합(생성·직접입력·장소·full calendar 스코프·삭제 async) 통과.
  **사용자 사전작업: 치프 재로그인(쓰기 권한 동의) + `/settings`에서 기본 장소 입력.**
- **녹음 종류 = 단가표 분류(2026-06-28)**: ① 새 프로젝트 드롭다운 '녹음 세션'→'녹음 세션 작성하기'(`menuLabel`).
  ② `rate_items.category`(`RECORDING_CATEGORIES`=스튜디오 녹음/로케이션 녹음) 신설. 관리 단가표에 분류 select 추가,
  목록에 분류 배지. ③ **녹음 프로젝트 세션 폼**: 기존 종류(녹음/믹싱/마스터링) select를 빼고(`session_type='녹음'` 고정
  hidden), '단가 항목'을 **'녹음 종류'**로 바꿔 단가표 항목을 분류별 **optgroup**으로 묶어 표시(`rateSelectGrouped`).
  믹스 등 비-녹음 프로젝트는 기존 종류 select+단가 항목 유지(`sessionBookingFields(isRecording)` 분기). 1Pro 계산은
  녹음 종류 항목의 `base_minutes`(data-minutes) 사용. 단위(분류 저장/변경·녹음 폼 optgroup·믹스 폼 유지·세션 생성) +
  부팅 통합(분류 추가 302·녹음 폼 optgroup·종류 select 제거) 통과.
- **하우스 엔지니어 ↔ 작업 담당자 연계(2026-06-28)**: 관리의 '사용자(로그인)'→**'하우스 엔지니어'**로 개념화.
  `project_managers.user_id`로 로그인 사용자와 작업 담당자를 링크, **`auth.syncUserToManager`** 가 하우스
  엔지니어를 작업 담당자로 자동 생성/이름·이메일 동기화/활성 연동(비활성 사용자→담당자 비활성). 사용자 추가
  폼에 **이름** 필드 추가, 로그인 시 Google 이름으로 동기화. **외주 작업자**는 `user_id=null`로 관리에서 직접
  추가(이름·연락처·이메일), 관리의 '외주 작업자' 목록은 `listProjectManagers({externalOnly})`로 외주만 표시.
  세션·작업 담당 드롭다운은 하우스+외주 모두 포함. 기존 활성 사용자(이름 有)는 1회 백필
  (`house_engineer_backfill_v1`). 단위 8케이스 + 부팅 통합(추가·라벨·드롭다운 노출) 통과.
- **관리 페이지 탭 그룹화(2026-06-28)**: `/settings`를 **담당자**(하우스 엔지니어+외주 작업자)·**컨텐츠**(단가표·녹음
  종류+작업 템플릿)·**환경설정**(스튜디오 캘린더+기본 장소) 3탭으로. CSP 안전한 **URL 기반 탭**(`?tab=`, 링크
  전환, JS 0). 활성 탭만 렌더(환경설정 탭에서만 캘린더 API 호출). POST는 `?tab=...&flash=`로 같은 탭 복귀
  (people는 기본값). `peopleTab`/`contentTab`/`studioCalendarSection`.
- **프로젝트 메타 자동완성(2026-06-28)**: 새/편집 프로젝트 폼의 아티스트·소속사/레이블·제작사 입력에 브라우저
  히스토리(`autocomplete="off"`)를 끄고, **기존 프로젝트 값 기반 `<datalist>`**(`distinctProjectFields`→
  `projectFieldDatalists`, `dl-artists`/`dl-companies`/`dl-productions`)로 자동완성. 라벨 '아티스트 소속사'→
  '소속사/레이블'. CSP 안전(순수 HTML datalist, JS 0).
- **클라이언트 자동 등록 + 통칭 정리(2026-06-28)**: ① 프로젝트 저장 시 아티스트·소속사/레이블·제작사를
  **클라이언트 마스터에 분류별 자동 등록**(`ensureClientsFromProject`, 이름+분류 중복 제거). 기존 프로젝트는 1회
  백필(`project_clients_backfill_v1`). ② `/clients` 페이지의 **'실결제자' 표기를 '클라이언트'(통칭)로** 변경(제목·
  버튼·빈상태·수정), 대시보드 카드도 '클라이언트'. **실결제자는 클라이언트가 프로젝트/인보이스에서 갖는 결제
  역할**(`client_id` 선택)로 유지. 단위(자동 등록·중복·빈값·백필) + 부팅 통합(생성→분류 탭 반영·제목) 통과.

## 스택

| 영역 | 선택 |
|---|---|
| 런타임 | Node ≥20, Express 4 (CommonJS) |
| DB | SQLite — `better-sqlite3`(운영, prebuild) / `node:sqlite`(폴백) 어댑터(`src/sqlite.js`) |
| 인증 | 전원 Google OAuth + 화이트리스트(`users` 행) → httpOnly 서명 JWT 쿠키(30일). 비밀번호 로그인 폐기 |
| 저장소 | Google Drive(관리자 토큰 재사용, `drive.file`) — **자료 전달 단계에서 활성화** |
| 보안 | helmet(CSP, 인라인 스크립트 0) + express-rate-limit + 토큰 AES-256-GCM 암호화 |
| 프론트 | 서버 렌더 HTML(`src/views.js`) + 클래식 폼 POST + 최소 JS, Tailwind CLI 빌드 |
| 배포 | Render Blueprint(`render.yaml`) + Disk — 스캐폴드(자격증명 후 활성화) |

## 아키텍처 핵심

- **role 기반 게이트(3단계)**: `attachUser`(활성 + owner/chief/staff만 세션 인정) → 권한 술어
  `isOwner`/`isChief`/`isStaffRole`, 복합술어 `canEdit`(chief|staff)·`canInvoice`(chief|owner)
  (모두 `auth.js`). 미들웨어: `requireAuth`(로그인=보기), `requireEditor`(canEdit=프로젝트·항목·작업·자료
  편집, **대표 차단**), `requireChief`(치프 전용=스태프·담당자·클라이언트·설정), `requireInvoice`(canInvoice=
  청구). 내부 도구이므로 로그인 직원은 모든 프로젝트를 열람한다(거래처 범위 강제 폐기).
- **Google 화이트리스트(`auth.js upsertUserFromGoogle`)**: 로그인 Google 이메일이 `ADMIN_EMAIL`(부트스트랩
  **치프=chief**, 없으면 자동 생성)이거나 `users`에 등록된 활성 행이면 그 역할로 로그인, 아니면 거부. 치프는
  `/settings`에서 사용자(이메일+역할 owner/chief/staff) 추가·역할변경·활성/비활성으로 화이트리스트를
  운영한다(본인·부트스트랩 치프는 잠금 방지로 강등/비활성 불가). 대표 계정은 치프가 owner로 등록한다.
- **미들웨어 순서(플레이북 §3-1)**: helmet/ratelimit → cookie/body → `attachUser` → 라우트 →
  **`express.static`은 맨 뒤**(보호 HTML은 라우트, static은 css/js 자산만). 인증 우회 방지.
- **작업 옵션/상태값 = 코드 상수**(`config.js`)가 단일 진실원천. DB CHECK 제약 금지(§2.8 마이그레이션 지옥 회피).
- **돈=정수(원)**, 날짜=`"YYYY-MM-DD"` 문자열(`src/lib/date.js`).
- **at-rest 암호화**(`db.encrypt/decrypt`, AES-256-GCM): Drive refresh token 등 비밀.
- **모바일 UX(플레이북2 §5)**: 입력 16px(iOS 자동확대 방지), 반응형 카드, 콘텐츠 max-width 통일.

## 데이터 모델 (생성됨)

- `users(email, role[owner|chief|staff], name, google_sub?, active, client_id?[레거시], password_hash?[레거시])` —
  `active=0`이면 로그인 차단(화이트리스트 제거). 마이그레이션에서 기존 `admin`→`chief` 자동 승계.
  `password_hash`/`client_id`는 구 모델 잔재 컬럼(미사용).
- `clients(name, kind[아티스트|소속사/레이블|제작사|기타], phone?, email?, memo?, biz_no?, owner_name?, address?)` —
  UI상 **클라이언트**(통칭). 프로젝트의 아티스트·소속사/레이블·제작사가 저장 시 분류별로 자동 등록되고
  (`ensureClientsFromProject`), 그중 하나가 프로젝트/인보이스의 **실결제자(공급받는 자)** 역할로 선택된다(`client_id`).
  `biz_no`(사업자등록번호)·`owner_name`(대표자)·`address`(사업장 주소)는 세금계산서용 상세정보.
- `projects(title, artist?, artist_company?, production_company?, client_id?→clients ON DELETE SET NULL,
  manager_id?→project_managers ON DELETE SET NULL, services JSON, due_date?, rate, memo)` — `services`는
  `{key,label,track_title?,requested_at,completed_at,amount}` 배열. `rate`는 항목별 금액 합계,
  `due_date`는 가장 늦은 완료일.
  `status`, `kind` 컬럼은 기존 데이터 호환용으로만 유지.
- `project_managers(name, email?, phone?, active, user_id?→users, created_at)` — 작업 담당자 마스터.
  `user_id` 있으면 **하우스 엔지니어**(로그인 사용자와 링크, `auth.syncUserToManager`가 자동 생성·동기화),
  null이면 **외주 작업자**(로그인 없이 관리에서 직접 추가). 둘 다 세션·작업 담당 드롭다운에 노출.
- `project_service_items(key UNIQUE, label, active, created_at)` — 작업 템플릿/레거시 호환용. 기본값은 녹음/보컬튠/믹싱/마스터링.
- `rate_items(name, category[스튜디오 녹음|로케이션 녹음], base_minutes, base_price, extra_minutes, extra_price, active)` —
  **단가표 · 녹음 종류**. `category`(`RECORDING_CATEGORIES`)로 분류, 녹음 세션 폼의 '녹음 종류'에 분류별 optgroup으로
  묶여 표시된다. 기준 시간(1Pro) 안은 `base_price`, 초과는 `extra_minutes` 단위 올림으로 `extra_price` 과금
  (`base_minutes=0`이면 정액). `computeRatePrice(item, minutes)`가 산정. 관리 메뉴에서 치프가 CRUD.
- `project_tracks(project_id→projects CASCADE, title, content_type[Music|Video_Post], created_at)` —
  프로젝트 하위 곡/영상 콘텐츠.
- `track_tasks(track_id→project_tracks CASCADE, task_type, billing_type[Time_Charge|Fixed_Per_Track],
  quantity, unit_price, total_price, engineer_name?, status[Pending|In_Progress|Completed],
  is_invoiced, invoice_id?, session_id?→sessions SET NULL)` — 실제 청구 가능한 모듈형 작업 단위.
  `session_id`는 녹음 세션에서 자동 생성된 작업 추적(부분 유니크: 세션당 1건).
- `deliverables(project_id→projects ON DELETE CASCADE, title, version, kind, storage_backend[drive|local],
  file_id, file_name, file_size, mime_type, access_token?, expires_at?, download_count, revoked, note)`
- `invoices(project_id?→projects SET NULL, client_id?→clients SET NULL, title, amount, paid_amount,
  invoice_number?, tax_amount, status[미발행|발행|입금완료], issued_date?, due_date?, memo)` —
  돈=정수(원), 연체·부분납은 코드 파생. `amount`는 VAT 포함 총액.
- `invoice_items(invoice_id→invoices CASCADE, task_id?→track_tasks SET NULL, track_title, task_type,
  description, quantity, unit_price, amount)` — 청구서 라인아이템 스냅샷.
- `sessions(project_id→projects CASCADE, session_type[녹음|믹싱|마스터링|기타], session_date,
  start_time?, end_time? "HH:MM", booker_name?, engineer_name?, status[예정|완료|취소], memo, gcal_event_id?)` —
  스튜디오 일정. `gcal_event_id`는 예약 시 자동 생성한 구글 캘린더 일정 id(수정·삭제 추적).
  `booker_name`(예약 담당자)·`engineer_name`(담당 엔지니어)은 둘 다 담당자 마스터에서 선택(별개 역할).
  청구 시간 산정의 기반. `rate_item_id`(→rate_items SET NULL)는 녹음 세션 시간제 자동 산정용 단가표 연결(3단계).
- `admin_state(key, value)` — drive folder_id·refresh token(암호화)·테마 캐시·`studio_calendar_id`(스튜디오 캘린더)·`studio_location`(예약 일정 기본 장소)
- 후속(스키마 자리만): `payments`(입금 이력 분리 필요 시)

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
| `ADMIN_EMAIL` | 부트스트랩 치프(chief) Google 이메일. 최초 로그인 시 자동 생성·chief 보장. 대표(owner)·스태프는 치프가 `/settings`에서 등록 |
| `SESSION_SECRET` | JWT 서명 |
| `TOKEN_ENC_KEY` | AES-256-GCM 키 파생(비밀 암호화) |
| `GOOGLE_CLIENT_ID`/`SECRET` | OAuth(관리자 로그인 + Drive) |
| `BASE_URL` | 외부 URL(Render는 `RENDER_EXTERNAL_URL` 자동) |
| `PORT` / `DB_PATH` / `MAX_UPLOAD_MB` | 서버/DB/업로드 |
| `DEV_LOGIN` | =1 시 `/dev-login` 활성(로컬 검증용, **프로덕션 금지**) |
| `BACKUP_TOKEN` | cron이 `POST /internal/cron/daily`(백업+연체 스캔)를 트리거하는 인증 토큰. 미설정 시 라우트 비활성(404). web·cron 동일값 |
| `CRON_TRIGGER_URL` / `WEB_HOSTPORT` | (cron 서비스) 트리거 대상 web URL. `WEB_HOSTPORT`는 Render `fromService hostport` 자동 주입 |

프로덕션(`NODE_ENV=production`)에서는 `ADMIN_EMAIL`, 강한 `SESSION_SECRET`/`TOKEN_ENC_KEY`,
Google OAuth 자격증명이 없거나 `DEV_LOGIN`이 켜져 있으면 서버가 시작되지 않는다.

## 빠진 함정 (다음에 또 밟지 말 것)

1. **인증 게이트 → static 순서**(§3-1). 보호 HTML을 정적 파일로 두지 말 것.
2. **better-sqlite3 네이티브 빌드**: 최신 Node(예: 26)에서 컴파일 실패 가능 →
   `optionalDependencies` + `node:sqlite` 폴백(`src/sqlite.js`). Render(Node 20/22)는 prebuild 사용.
3. **헤드리스 full-page 스크린샷은 폭을 잘못 렌더**(플레이북2 §6) → CDP `setDeviceMetricsOverride`로 측정.
   (로그인/다운로드 화면이 잘려 보였으나 실측 overflow=0, 입력 16px 확인.)
4. **OAuth state로 next 전달** 시 base64url + open-redirect 방지(`safeNext`, 내부 경로만).
5. **유휴 백그라운드 서버가 포트 점유** — 이전 검증 세션의 `node src/server.js`가 살아 있으면 새
   서버가 3000 바인딩 실패하고 **옛 코드가 응답**(delete 라우트가 404로 보였던 원인). 검증 전
   `pkill -f "src/server.js"`로 정리하고 단일 프로세스 확인할 것.
6. **multipart 파일명 latin1** → `Buffer.from(name,'latin1').toString('utf8')`로 한글 복원.
7. **동일 출처 POST 검사 + CSP upgrade-insecure-requests(2026-06-28)**: 로컬 http에서 브라우저가 폼
   제출 Origin을 `https://`로 올려 보내면 `req.protocol`(http)과 불일치해 "요청 출처를 확인할 수 없습니다"
   403이 났다(http Origin은 통과, https만 차단). → `server.js sameOriginRequest`를 **host(도메인:포트)
   기준 비교**로 변경(프로토콜 무시, 외부 host는 여전히 차단해 CSRF 방어 유지).

## 검증 상태 (로컬, DEV_LOGIN=1)

- [x] 부팅 + `/healthz`, 미인증 `/projects`→로그인 리다이렉트(우회 없음)
- [x] 관리자: 전체 7건, `/clients` 200, 프로젝트 생성/금액 콤마 파싱(₩1,200,000), 항목 필터/표시
- [x] 클라이언트: 자기 프로젝트만(3건), `/clients` 403, 타 거래처 프로젝트 404, `/projects/new` 403
- [x] 비밀번호 로그인, 양쪽 대시보드 200
- [x] 모바일 CDP: overflow=0, input font 16px
- [x] **자료 전달**: 멀티파트 업로드(한글 파일명 보존, 바이트 일치), 인증 다운로드(미인증→로그인),
      관리자 업로드 폼 클라이언트 차단(403), 공개 토큰 다운로드+카운트 증가, 철회/만료 차단, 삭제(행+파일)
- [x] **청구**: 생성·수정·삭제, 부분/전액 입금 처리(상태 자동 보정), 미수금 합계(₩2,900,000 계산 검증),
      연체 1건 파생, 대시보드 미수금/연체 노출, URL 필터, 클라이언트 범위(3건/404/403), 모바일 overflow=0
- [x] **프로젝트 상세/관리**: 프로젝트 명·담당자 메타 편집, `항목 · 작업` 섹션에서 항목 직접 추가,
      `/settings` 담당자/작업 템플릿 관리, 로컬 시드 및 렌더 검증
- [x] **트랙/작업/API 청구**: REST로 프로젝트→트랙→작업 2건 생성, `/api/projects/:id/unbilled-tasks`
      완료+미청구 필터 확인, `/api/invoices` 생성 시 `invoice_items` 2건 생성·작업 `is_invoiced=1`
      전환·VAT 10% 계산 검증
- [x] **항목/작업 수정·삭제(2026-06-27)**: 작업 단가/엔지니어 인라인 수정(₩500,000→₩750,000)·
      작업 삭제(DB 확인) 검증, 청구 생성 후 해당 작업 편집 메뉴 사라짐, 잠긴 작업 직접 수정/삭제 및
      청구된 작업 보유 트랙 삭제 모두 400 거부 확인. `<details>` 토글이 CSP 위반 없이 렌더
- [x] **하드닝 스모크(2026-06-27)**: JS 문법 검사, `npm run build:css`, `npm audit --omit=dev`,
      `/healthz`, 동일 출처 POST 허용/교차 출처 POST 403, 관리자 비밀번호 로그인 차단, 클라이언트
      `/clients` 403 및 자기 프로젝트/청구 범위 확인
- [x] **인증 개편(2026-06-27)**: 화이트리스트 로직(치프=admin, 등록 스태프=staff, 미등록/비활성=거부)
      단위 검증, 치프 전체 메뉴·청구 섹션, 스태프 `/invoices`·`/settings`·`/clients` 403·청구 섹션 숨김·
      from-tasks 직접 POST 403·프로젝트 7건 전체 열람·편집폼 노출, 로그인 화면 비밀번호 input 0·Google
      버튼, 잔여 client 계정 active=0, `/settings` 사용자 추가/역할변경/비활성, 부트스트랩 치프 비활성
      무효(잠금 방지), 한글 세리프 폰트 링크 로드 확인
- [x] **권한 3단계 검증(2026-06-28)**: owner/chief/staff dev-login, GET 매트릭스(대표 새프로젝트/클라이언트/
      설정 403·청구 200, 스태프 청구/클라이언트/설정 403), POST 쓰기(대표 편집 403·치프/스태프 302), 청구
      생성(스태프 403·치프/대표 권한통과), 대표 청구 상태변경 302, 역할별 대시보드 카드, admin→chief 마이그레이션
- [x] **Google OAuth 실연동(2026-06-28)**: GCP redirect URI 등록 → `studio@omgworks.kr` 치프 로그인 성공.
      Drive 연동은 후속(자료 업로드 시 local→drive 자동 전환, 현재는 local 저장).

## 다음 단계 TODO

1. ~~`sessions`: 캘린더 일정~~ **완료(2026-06-28)**. ~~세션 시간→작업 청구 자동 산정 연동~~ **완료(3단계,
   2026-06-28)**. 후속(선택): 월 캘린더 그리드 뷰(현재는 목록), 대시보드 임박 세션 카드, 세션 행 N+1 조회
   배치 최적화(내부 도구라 현재는 허용).
2. ~~Render 배포~~ **완료(2026-06-28)**: `https://omg-studios-manager.onrender.com` — Google 로그인·
   healthz·cron 백업 전부 통과. 세부 = `DEPLOY.md`.
3. (선택) 연체 cron이 현재는 집계·로그·JSON만 → 메일/웹훅 발송 연결(Gmail API 또는 `ALERT_WEBHOOK`).
   자료 전달/청구 발행 시 클라이언트 알림도 동일 채널 재사용.
4. (선택) 청구서 PDF/이미지 렌더(resvg 패턴) + 채번(2026-001).
5. Drive 실연동 검증.
6. **UX 점검 후속(2026-06-28 진단)**: ① 프로젝트 목록 검색·② 폼 저장 피드백·④ 작업 엔지니어 담당자
   선택·⑤ "항목"→"곡·콘텐츠" 용어 **완료**. ③ 첫 사용 온보딩 안내는 **불필요로 결정(2026-06-28)** — 전체 종료.

## 함정 보강 — 한글 쿼리스트링

curl로 `?f=연체` 같은 한글 쿼리를 **인코딩 없이** 보내면 서버가 다른 문자열로 받아 필터가 빈 결과가
된다(코드 버그 아님). 브라우저는 `encodeURIComponent`로 보내 정상. curl 검증 시 `--data-urlencode`
또는 `%EC%97%B0%EC%B2%B4`처럼 인코딩할 것.
