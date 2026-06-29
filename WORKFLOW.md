# OMG Studios Manager — 작업 이어가기 가이드

> 녹음/믹싱 스튜디오 **내부 운영 웹앱**(프로젝트 관리 · 자료 전달 · 청구).
> 이 문서는 **다음 작업을 빠르게 이어받기 위한 현재 스냅샷 + 실행 가이드**다.
> 상세 설계 변천사·함정은 [`CLAUDE.md`](./CLAUDE.md) 참조.
>
> **현재 상태(2026-06-29)**: **프로덕션 라이브**(`omg-studios-manager.onrender.com`). MVP + 권한 3단계 +
> 세션(예약 그리드·겹침 차단·구글 캘린더 자동 연동·**녹음종류 필수 게이트**·**10분 직접입력**·테두리 강조) +
> 곡·콘텐츠(후반작업) + **작업 종류 카탈로그**(DB 관리·삭제-only) + **거래명세서 PDF**(resvg + 한글 폰트 번들) +
> **알림 채널**(웹훅·암호화·fail-safe) + 관리 항목 **삭제 기능** + 청구 '청구 대기'(**완료 안 해도 추가 즉시 노출**).
> **용어**: 녹음 종류 = 단가표 항목(rate_item) / 세션 종류 = session_type / 클라이언트(통칭)·실결제자(역할).
> 미완(검증): 프로덕션에서 PDF 렌더·알림 웹훅 동작 확인, Drive 실연동. 선택: 월 캘린더 뷰·알림 Gmail 어댑터.

---

## 1. 빠른 시작

```bash
npm install                 # 의존성 (better-sqlite3 실패 시 node:sqlite로 자동 폴백)
npm run seed                # 더미 데이터 + 로그인 계정 시드
DEV_LOGIN=1 npm run dev     # build:css 후 서버 (http://localhost:3000)
```

- **로그인**: 로컬은 `/login`의 dev 버튼(대표/치프/스태프). 실제 운영은 Google OAuth(화이트리스트).
- **시드 계정**: 치프 `studio@example.com` · 대표 `ceo@example.com` · 스태프 `engineer@example.com`/`manager@example.com`
- **환경변수**: `.env`(예시는 `.env.example`). 프로덕션은 `ADMIN_EMAIL`·강한 `SESSION_SECRET`/`TOKEN_ENC_KEY`·Google 자격증명 없으면 **부팅 실패(fail-fast)**.

> ⚠️ 검증 전 `pkill -f "src/server.js"`로 유휴 서버 정리(옛 코드가 응답하는 함정 회피).

---

## 2. 핵심 데이터 흐름

```
프로젝트(projects)
  └─ 곡·콘텐츠(project_tracks)        ← UI "곡 · 콘텐츠", 코드 track
       └─ 작업(track_tasks)           ← 믹싱/마스터링/녹음 등 모듈형, 엔지니어·단가·상태
            └─ 완료+미청구 작업 선택 → 청구(invoices) + invoice_items(스냅샷)
```

- 돈=정수(원), 날짜=`"YYYY-MM-DD"` 문자열(`src/lib/date.js`, KST).
- 청구번호 `INV-YYYYMM-###`, VAT=공급가 10% 자동.
- 청구 생성 시 작업은 `is_invoiced=1`로 잠금(수정·삭제 불가, 스냅샷 보존).
- **세션**(`sessions`): 프로젝트 하위 일정(녹음/믹싱/마스터링, 날짜·시간·엔지니어·상태). 사이드바 "일정"
  메뉴(`/sessions`)에서 전 프로젝트의 다가오는/지난 세션을 모아 본다. 청구 시간 산정의 기반.
- **세션→청구(3단계)**: **녹음** 세션이 `완료`+`시작·종료`+단가표(`rate_item_id`) 연결이면 진행분을
  `computeRatePrice`로 산정→**예상 청구액** 표시. 프로젝트 상세의 `이 세션으로 청구 작업 생성`(`POST /sessions/:id/bill`,
  치프/스태프)으로 곡·콘텐츠 하위 `track_task`(Time_Charge·Completed)를 만들어 위 청구 흐름에 합류
  (`track_tasks.session_id`로 추적, 세션당 1건). 믹싱/마스터링은 시간제 아님(건별 고정).

---

## 3. 역할 · 권한 (3단계)

| 기능 | 대표(owner) | 치프(chief) | 스태프(staff) |
|---|:---:|:---:|:---:|
| 프로젝트·곡콘텐츠·작업·자료 **보기** | ✅ | ✅ | ✅ |
| 프로젝트·곡콘텐츠·작업·자료 **편집** | ❌ 열람만 | ✅ | ✅ |
| **청구**(발행·입금·매출) | ✅ | ✅ | ❌ |
| 스태프·담당자·클라이언트·설정 **관리** | ❌ | ✅ | ❌ |

- **인증**: 전원 Google OAuth + 화이트리스트(`users` 행). 비밀번호 로그인 폐기.
- **부트스트랩**: `ADMIN_EMAIL` = 최초 치프(자동 생성). 대표·스태프는 치프가 `/settings`에서 등록.
- **미들웨어**(`src/auth.js`): `requireAuth`(보기) · `requireEditor`(편집) · `requireChief`(관리) · `requireInvoice`(청구).
- **술어**: `isOwner`/`isChief`/`isStaffRole`/`canEdit`/`canInvoice`.

---

## 4. 데이터 모델 (SQLite, `src/db.js`)

| 테이블 | 역할 |
|---|---|
| `users` | 로그인 계정. `role[owner\|chief\|staff]`·`active`·`google_sub`. `password_hash`/`client_id`는 레거시 |
| `clients` | **클라이언트**(통칭: 아티스트·소속사·제작사). 그중 하나가 프로젝트/청구의 **실결제자**(`client_id`). `biz_no`·`owner_name`·`address`(세금계산서) |
| `projects` | 프로젝트 메타. `client_id`=실결제자, `manager_id`=담당자 |
| `project_tracks` | **곡·콘텐츠**. `content_type[Music\|Video_Post]` 상수·정규화는 있으나 **UI 미노출 → 현재 전부 Music** |
| `track_tasks` | **작업**. `task_type`·`billing_type`·`unit_price`·`engineer_name`·`status`·`is_invoiced` |
| `sessions` | **세션(일정)**. `session_type`·`session_date`·`start_time`/`end_time`·`booker_name`·`engineer_name`·`status`·`rate_item_id`·`gcal_event_id` |
| `invoices` / `invoice_items` | 청구 + 라인아이템 스냅샷 |
| `project_managers` | **담당자 마스터**. `user_id` 링크=하우스 엔지니어(로그인 자동 연계), null=외주 작업자. 세션·작업 담당 select 출처 |
| `task_types` | **작업 종류 카탈로그**(곡·콘텐츠 후반작업). config `TASK_TYPES` 1회 시드 후 DB 단일 출처. `track_tasks.task_type`이 key 보관(FK 아님), 라벨/그룹은 data.js 캐시. 삭제-only |
| `project_service_items` | 레거시(구 services JSON 라벨 호환). 관리 UI 폐기(작업 종류 카탈로그가 대체), 테이블만 잔존 |
| `deliverables` | 자료 전달(Drive/로컬, 토큰 공개링크) |
| `admin_state` | drive folder_id·refresh token(암호화)·테마 |

> 도메인 상수(역할·상태·작업종류)는 `src/config.js`가 단일 진실원천. **DB CHECK 제약 금지**(마이그레이션 지옥 회피).

---

## 5. 코드 맵

```
src/
  server.js              부트스트랩 · 미들웨어 순서(보안→인증→라우트→static) · 라우트 마운트
  config.js              env 검증(fail-fast) · 역할/상태/작업종류 상수 · normalize
  db.js                  스키마 · 멱등 마이그레이션 · AES-256-GCM 암호화
  auth.js                JWT 세션 · 권한 술어/미들웨어 · Google OAuth · 화이트리스트
  data.js                데이터 헬퍼(전 직원 전체 열람, 청구는 canInvoice 분기)
  views.js               레이아웃 · 사이드바(권한별 NAV) · flashBanner · 아이콘
  views.invoices.js      청구 행/배지/섹션
  views.deliverables.js  자료 행/섹션
  routes/
    auth.routes.js       /login · OAuth · /dev-login
    dashboard.routes.js  / (역할별 카드)
    projects.routes.js   목록(검색)·상세(곡콘텐츠·작업·자료·청구)·CRUD
    invoices.routes.js   청구 CRUD · 입금/상태
    sessions.routes.js   전역 일정(/sessions) + 세션 CRUD
    clients.routes.js    클라이언트 CRUD + 분류 탭 (치프)
    settings.routes.js   사용자·담당자·작업템플릿 관리 (치프)
    deliverables.routes.js  업로드·토큰링크·다운로드
    api.routes.js        REST blueprint
    maintenance.routes.js  /internal/cron/* (BACKUP_TOKEN 게이트, 백업+연체 스캔)
  jobs/cron-trigger.js   Render cron 진입점(내장 fetch로 web 트리거, 의존성 0)
  lib/date.js · lib/forms.js   날짜·폼 파서
  lib/maintenance.js     VACUUM INTO 백업 + 14일 prune + 연체 요약
  storage.js · drive.js  스토리지 추상화(Drive↔로컬 폴백)
public/js/app.js         최소 JS(드로어·복사·자동제출·삭제확인·flash 배너). CSP: 인라인 스크립트 0
```

---

## 6. 검증 · 메인터넌스 명령

```bash
# 문법(전 파일)
for f in $(find src -name '*.js'); do node --check "$f"; done
npm audit --omit=dev          # 0 vulnerabilities 기대
npm run build:css

# DB 무결성 + WAL 정리
node -e 'const{db}=require("./src/db");const d=db();console.log(d.prepare("PRAGMA integrity_check").get());d.exec("PRAGMA wal_checkpoint(TRUNCATE);")'

# 권한 스모크(서버 기동 후, curl 절대경로 — 서브셸 PATH 함정 회피)
for r in owner chief staff; do /usr/bin/curl -s -c /tmp/$r.txt -X POST -H "Origin: http://localhost:3000" --data "as=$r" http://localhost:3000/dev-login -o /dev/null; done
# /invoices → owner 200·chief 200·staff 403 / /settings → chief만 200

# cron/백업 스모크(BACKUP_TOKEN=<t> 로 서버 기동 후)
/usr/bin/curl -s -X POST -H "Authorization: Bearer <t>" http://localhost:3000/internal/cron/daily   # 200 + 백업 생성
/usr/bin/curl -s -o /dev/null -w '%{http_code}\n' -X POST http://localhost:3000/internal/cron/daily  # 토큰없음 401(미설정 서버는 404)
ls data/backups/        # app-YYYY-MM-DD.db 생성 확인(최근 14일 보존)
BACKUP_TOKEN=<t> CRON_TRIGGER_URL=http://localhost:3000/internal/cron/daily node src/jobs/cron-trigger.js  # 종료코드 0
```

> 검증 함정: ① POST redirect에 `?flash=...`가 붙어 `grep '[0-9]+$'`로 ID 추출이 깨짐 → `grep -oE 'projects/[0-9]+'` 사용. ② curl을 `$(...)` 서브셸/함수 안에서 쓰면 PATH 손실 → `/usr/bin/curl` 절대경로. ③ 한글 쿼리스트링은 URL 인코딩.

---

## 7. 다음 작업 후보 (우선순위 순)

1. **프로덕션 검증(최우선)** — Render에서 거래명세서 PDF 렌더(`@resvg/resvg-js` prebuilt 설치·동작)·알림 웹훅 발송 확인.
   환경설정에 **공급자 세금정보**(PDF용)·**알림 웹훅 URL** 입력 필요.
2. (선택) 월 캘린더 그리드 뷰(현재 목록)·대시보드 임박 세션 카드.
3. (선택) 구글 캘린더 역방향 동기화(캘린더 삭제→앱 반영) — 보류 중.
4. Drive 실연동 검증.
5. (선택) 알림 Gmail 어댑터(현재 웹훅만; `notify.js` 어댑터 슬롯).

> 완료: Render 실배포·OAuth, 세션(그리드·겹침·캘린더 + 녹음종류 필수 게이트·10분 직접입력·테두리 강조 + 폼 레이아웃 통일),
> 녹음 종류=단가표(세션 종류와 라벨 분리), 클라이언트 자동 등록, 탭 그룹화, 청구 '청구 대기'(완료 요건 완화),
> 작업 종류 카탈로그(삭제-only), 관리 항목 삭제, **거래명세서 PDF**, **알림 채널(웹훅)**.

---

## 8. 용어 사전 (UI ↔ 코드)

| UI 표기 | 코드 식별자 | 비고 |
|---|---|---|
| 곡 · 콘텐츠 | `project_tracks` / `track` | 녹음과 별개의 후반작업 단위. `content_type`(Music\|Video_Post)은 UI 미노출(현재 전부 Music) |
| 작업 | `track_tasks` / `task` | 보컬튠·믹싱·마스터링 등 모듈 단위 |
| 일정 / 세션 | `sessions` | 녹음/믹싱/마스터링 예약. 사이드바 "일정" |
| 녹음 종류 | `rate_items` (`rate_item_id`) | **단가표 항목**(보컬녹음 등), 스튜디오/로케이션 분류 그룹. 녹음 세션 1Pro 산정. UI 라벨 통일 |
| 세션 종류 | `session_type` | 녹음/믹싱/마스터링/기타(세션 구분, 겹침검사 단위). '녹음 종류'와 다른 필드 |
| 작업 종류 카탈로그 | `task_types` | 곡·콘텐츠 작업 종류(보컬튠·믹싱…), DB 관리·삭제-only |
| 클라이언트 | `clients` | 통칭(아티스트·소속사·제작사). **실결제자**=프로젝트/청구의 결제 역할(`client_id`) |
| 하우스 엔지니어 / 외주 작업자 | `project_managers`(`user_id` 유/무) | 작업 담당자 select 출처, 치프가 관리 |
| 대표 / 치프 / 스태프 | `owner` / `chief` / `staff` | 권한 3단계 |
