# OMG Studios Manager — 작업 이어가기 가이드

> 녹음/믹싱 스튜디오 **운영–정산 통합 관리 시스템**(예약 → 작업 → 청구 → 정산). 기술 형태는 사내 웹앱.
> **제품 정체성 = 녹음 스튜디오 전용 버티컬 미니 ERP**(order-to-cash 흐름을 단일 데이터 모델로 통합). 스코프 기준·경계는 [`CLAUDE.md` 🎯 제품 정체성](./CLAUDE.md) 참조 — 신규 기능은 "이 스튜디오의 운영–정산 흐름에 속하나?"로 판단.
> 이 문서는 **다음 작업을 빠르게 이어받기 위한 현재 스냅샷 + 실행 가이드**다.
> 상세 설계 변천사·함정은 [`CLAUDE.md`](./CLAUDE.md) 참조.
>
> **현재 상태 — v1.0 (2026-07-01)**: **프로덕션 라이브**(`omg-studios-manager.onrender.com`). 한 챕터 종료. MVP + 권한 3단계 +
> 세션(예약 그리드·**다중 룸(룸별 겹침)**·구글 캘린더 자동 연동[제목=제작사 없으면 레이블]·텍스트 직접입력·소요 슬라이더[**1Pro/2Pro는 녹음만·종류별 기본값** 녹음=1Pro·믹싱 등=기본 세션 시간]·세션 종류 선택·**담당 디렉터 다대다**[`session_directors`]·**예정 완료 1클릭**·**목록 검색**·**운영시간 기반 동적 슬롯**·**세션 있으면 새 추가 접기**·일정 목록/캘린더 전환·청구 잠금) +
> 곡·콘텐츠(후반작업·**금액은 청구 탭에서 확정**[작업 폼=종류·담당·상태만, 청구 생성 폼에서 작업별 금액 입력·종류 기본단가 자동]·외주 지급단가 `worker_rate`·`engineer_id`·**완전 자동저장**[버튼 없음·변경 즉시 헤더 반영·상태 select 헤더에서 접힌 채 수정·새 작업 담당=로그인 계정·AJAX는 urlencoded]) + 작업 종류 카탈로그(DB 관리·삭제-only·**분류 폐기**[모두 후반작업]) + **거래명세서 PDF**(resvg + 한글 폰트 번들·문서명 3종) +
> 알림 채널(웹훅·암호화·fail-safe) + 관리 항목 삭제 + 녹음 세션 직접 청구(청구 탭 자동 노출·세션 잠금·**청구처는 청구 시점 결정**·발행후 변경 잠금·**세션 금액도 폼에서 수정**[`session_amount_<id>`]·**작성순 정렬**·**인보이스 인라인 펼침·생성**[생성('선택 항목으로 청구 생성' — **수동 청구는 2026-07-08 폐지, 청구는 프로젝트에서만**)·상세·입금·상태·PDF·삭제 전부 청구 탭에서 — 청구 메뉴 이탈 없이 프로젝트 내 완결, `return` 복귀·`?open=` 펼침; 청구 메뉴=모아보기]·**청구서 수정 폐기**[발행=확정, 변경은 삭제 후 재발행]) +
> 클라이언트 상세(진행 프로젝트 + 청구·결제 히스토리·**이름 검색**·**담당자 연락처**[폼에서 담당자 콤보로 연동]·**첨부 서류 스태프 개방**) + **연락처(담당자) 도메인**(`/contacts`, 소속 이력·이직·생성 시 소속·프로젝트 클라이언트 담당자·**로그인 계정 자동 등록**[owner 포함, `contacts.user_id`]·**'녹음실 스태프' 탭**) + **청구처 정보 카드**(대표자·사업자번호[→등록증]·담당자, 청구 상세·탭) + **외주 작업자 메뉴**(`/workers`, 일원화 완료·정산=Σworker_rate) +
> **UX**: 대시보드 오늘/이번 주 세션 카드·지표 강화, 곡 일괄추가·**고객측 담당자**(선택 시 정보표시·새 연락처 자동생성)·**청구처 검색 콤보**(청구 폼), 청구 검색·견적서·채번 원자화 +
> **디자인**: **Pretendard** 한글폰트(jsdelivr CDN, CSP 허용), 쿨톤 info색(`badge-info`), 사이드바 그룹화(운영/청구/관리), 수동 테마 토글(크림 기본, `html[data-theme]`+localStorage), `listGroup`/`listRow`/`emptyState` 공통 헬퍼 +
> **모바일(2026-07-04)**: 반응형 레이아웃(고정 그리드→breakpoint·`min-w-0` 오버플로우 차단·pageHeader flex-wrap) + 터치(**44px 탭 타깃 모바일 전용 `@media(max-width:639.98px)`·데스크톱 밀도 유지**·`active:` 눌림 피드백·콤보 `mousedown` 유지). 검증=오프스크린 iframe 390px로 15개 페이지 가로 오버플로우 0·콤보 터치 선택·드로어 백드롭 닫기. 라이브 배포·`app.css` 44px 반영 확인 +
> **보안 하드닝**: CSRF 기본거부·OAuth 논스·SSRF 차단·로고 매직바이트.
> **용어**: 프로젝트 = **유형 구분 없음**(`project_type` 레거시) / **청구처**(=실결제자, `client_id` — 청구 시점 결정, 메타엔 자동파생 기본값) / 녹음 종류 = 단가표 항목(rate_item) / 세션 종류 = session_type / 룸 = rooms / 클라이언트(회사)·**연락처(담당자·소속이력)**·고객 담당자(`contact_id`)·담당 엔지니어(`manager_id`).
> 미완(검증): 프로덕션에서 PDF 렌더·알림 웹훅 동작 확인(Drive 실연동은 라이브 완료). 선택: 알림 Gmail 어댑터. (**입금 이력 분리·인라인 아티스트 콤보 통일 = 2026-07-03 완료 · 구글 캘린더 역방향 동기화 = 2026-07-04 폐기(제거)**)
>
> **🏁 v1.0 마무리(2026-07-01) — 위 스냅샷의 최신 패러다임(이전 인라인 서술보다 우선)**:
> - **저장 = 명시적 dirty 버튼**(자동저장 전면 폐기): 편집 폼 전부 `[data-dirty-form]`+`[data-dirty-save]`(변경 없으면 흐리게·비활성, 변경 시 하이라이트). 프로젝트 메타·세션·곡·콘텐츠 작업·연락처·클라이언트·단가표·작업 종류 모두 적용.
> - **상세 = 바로 편집**: 연락처·클라이언트 상세가 곧 인라인 편집 화면('정보 수정' 폐기, `embedded`). 연락처 소속 이력 각 행 편집·'회사' 입력→소속 자동 반영. 클라이언트 상세 순서=청구·결제(탭)→상세정보→첨부→삭제, 담당자 콤보에 전화 표시, **통장사본 폐기**(사업자등록증만), **목록 필터+스크롤 복원**(`?from=`+sessionStorage).
> - **녹음 단가 Pro 블록 과금**: 3.5h(1Pro)마다 묶어 계산(10.5h=3Pro=90만), 슬라이더 0~14h·프리셋 1~4Pro.
> - **구글 캘린더 진단**: 연동 실패 사유 로깅 + 설정 자동연동 켜짐/꺼짐 배지('사용 안 함'=연동 끔).
> - 시작 시간 '직접입력' 인라인 전환·전화칸 자동완성 끔·'제작사→제작사/운영사'. 테스트 `node:test` 40개 + **GitHub Actions CI**(Node 20/22: `npm test`+`build:css`).
>
> **🏗 당사자(Party) 모델 — 정체성 통합(2026-07-02, P1–P3 배포)**: clients/contacts 이중화(source_contact_id 셸·'기타'·is_group)를 근본 제거하고 **`parties` 한 테이블**(person·company·group, is_artist 플래그)로 통합. 역할(아티스트·청구처·담당자·디렉터·엔지니어)=`parties.id` 참조(다형 없음, 단일 FK). `invoices.payer_id`·`projects.artist_id/agency_id/production_id/contact_party_id`·`project_managers.party_id`·`session_directors.party_id`. `src/data/parties.js`(+임시 `compat.js` 어댑터, **P4에서 제거**). 이관 게이트 `party_model_v1`·`session_directors_party_v1`·`client_files_party_v1`(원자·무중단). DEV_LOGIN E2E 전 경로+거래명세서 PDF 검증, 40 테스트 통과, orphan_payer=0. **P4 정리 + P4b 레거시 드롭 완료·배포**: 죽은 contacts.js/clients.js 삭제, linkClientContact/deliverables 잔여 수정, seed.js party화, 그리고 `legacy_drop_v1`이 레거시 테이블(clients/contacts/contact_affiliations)·FK 컬럼(invoices.client_id 등)을 **제거**(FK 컬럼 먼저 DROP → 테이블 DROP, 신선 DB는 CREATE 제거+hasLegacy 가드, 멱등·무중단). 신선/프로덕션형 사본 검증(전 경로 200·신규 INSERT·데이터 보존). **compat.js 제거 완료** — 라우트가 parties 함수 직접 사용(쿼리·호환별칭은 parties.js 네이티브 흡수, 순수 별칭 21종 리네임). **당사자(Party) 모델 재정리 완결**(clients/contacts 이중화 → parties 단일). ⚠️ 대규모 컷오버는 브랜치에서(중간 커밋 자동배포 주의).
>
> **후속 마무리(2026-07-02)**: 파티 모델 `node:test` 12개 추가(총 52) · 소소한 정리(clientForm 잔재 필드·Google 회사↔소속이력 동기화·CLAUDE 문서) · **거래명세서 PDF 견고화**(@resvg/resvg-js 지연 로드 — 네이티브 부재 시 청구 라우트 무중단·PDF만 503) · **구글 캘린더 역방향 동기화**(`/sessions` 수동 버튼: 구글 삭제→세션 취소·시간변경→갱신, 청구 세션 제외·루프 방지·KST 정규화).
>
> **클라이언트/연락처 UX·그룹 개편(2026-07-02)**: **Drive 루트 폴더 중복 방지**(이름 검색 폴백 + `/drive-check` reconcile·drive.file 토큰 변경 시 원본 미검색 해결). 연락처 3탭(외부/외주/스태프)·클라이언트 필터→탭. 목록 행 정보 재배치(회사/대표 text-xs·전화 위·이메일 아래·업체는 사업자→전화→이메일)·**이름만 링크**(`listRowLinked`, 우측 연락처 복사 시 상세 미이동). **클라이언트 '그룹' 분류 표면화**(kind='group' 탭·배지) → **그룹↔소속 멤버 연결**(`parties.group_id`·그룹 상세 멤버 관리·아티스트/연락처 상세 소속 그룹 select·`POST /clients/:id/members`) + **새 클라이언트 유형 3택 흐름**(업체/아티스트/그룹, `clientForm(formType)`·kind select 제거·'기타' 폐기·'제작사'→'제작사/운영사' 표기[저장값 유지]). 잔여 TODO=선택 항목뿐(Gmail 어댑터 등; 입금 이력 분리·인라인 아티스트 콤보 통일은 2026-07-03 완료). **Drive 실연동 라이브 완료**(studio@omgworks.kr 고정, 업로드·일일 백업 오프사이트 정상).

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
- 청구번호 `OMG-YYYYMM-###`(2026-07-03 INV→OMG), VAT=공급가 10% 자동.
- 청구 생성 시 작업은 `is_invoiced=1`로 잠금(수정·삭제 불가, 스냅샷 보존).
- **세션**(`sessions`): 프로젝트 하위 일정(녹음/믹싱/마스터링, 날짜·시간·엔지니어·상태). 사이드바 "일정"
  메뉴(`/sessions`)에서 전 프로젝트의 다가오는/지난 세션을 모아 본다. 청구 시간 산정의 기반.
- **세션→청구(직접)**: **녹음** 세션이 `시작·종료`+단가표(`rate_item_id`) 연결이면 `computeRatePrice`로
  **예상 청구액**을 산정해 청구 탭 청구 생성 폼에 **자동 노출**(곡·콘텐츠/버튼 없음). 선택하면
  `invoice_items.session_id` 스냅샷으로 직접 청구되고 세션이 잠긴다(`isSessionInvoiced` → 수정·삭제 차단,
  인보이스 삭제 시 자동 복원). 믹싱/마스터링은 시간제 아님(건별 고정).

---

## 3. 역할 · 권한 (3단계)

| 기능 | 대표(owner) | 치프(chief) | 스태프(staff) |
|---|:---:|:---:|:---:|
| 프로젝트·곡콘텐츠·작업 **보기** | ✅ | ✅ | ✅ |
| 프로젝트·곡콘텐츠·작업·클라이언트(첨부 포함)·연락처 **편집**(`requireEditor`) | ✅ (2026-07-07 개방) | ✅ | ✅ |
| **자료 전달**(`/deliverables`·프로젝트 탭) `requireStaff` | ❌ 숨김 | ✅ | ✅ |
| **청구서 발행·입금·삭제**(`requireBilling`) | ✅ | ✅ | ✅ |
| **매출 현황**(`/revenue`)·**외주 정산**(`/workers` 열람·지급) `requireInvoice` | ✅ | ✅ | ❌ |
| 외주 작업자 **마스터**(추가·삭제·수정) `requireChief` | ❌ | ✅ | ❌ |
| **관리 메뉴**(`/settings`) `requireStaff` (계정·웹훅은 `requireChief`) | ❌ 숨김 | ✅ | 일부(설정 열람·편집) |

- **인증**: 전원 Google OAuth + 화이트리스트(`users` 행). 비밀번호 로그인 폐기.
- **부트스트랩**: `ADMIN_EMAIL` = 최초 치프(자동 생성). 대표·스태프는 치프가 `/settings`에서 등록.
- **미들웨어**(`src/auth.js`): `requireAuth`(보기) · `requireEditor`(편집=치프·스태프·대표[2026-07-07 개방]) · `requireStaff`(자료 전달·관리=치프·스태프, 대표 숨김) · `requireBilling`(청구서 발행=전원) · `requireInvoice`(매출·외주 정산=치프·대표) · `requireChief`(계정 관리·외주 마스터).
- **술어**: `isOwner`/`isChief`/`isStaffRole`/`canEdit`(대표 포함)/`isStaffOrChief`/`canBill`/`canInvoice`.
- **외주 작업자**(`/workers`, 2026-07-03): 열람·정산(지급) = 대표·치프(`requireInvoice`), 마스터(추가·삭제·수정) = 치프(`requireChief`). 스태프는 외주 지급단가를 작업 편집에서 입력만.

---

## 4. 데이터 모델 (SQLite, `src/db.js`)

| 테이블 | 역할 |
|---|---|
| `rooms` | **룸 마스터**. `name`·`sort_order`·`active`. 기본 '메인 룸' 시드. `/settings` 환경설정에서 CRUD |
| `users` | 로그인 계정. `role[owner\|chief\|staff]`·`active`·`google_sub`. `password_hash`/`client_id`는 레거시 |
| `clients` | **클라이언트**(통칭: 아티스트·소속사·제작사). 그중 하나가 청구의 **청구처**(=실결제자, `client_id`). `biz_no`·`owner_name`·`address`(세금계산서; **아티스트는 없음**). 상세 `/clients/:id` = 진행 프로젝트 + 청구·결제 + 담당자 연락처 |
| `projects` | 프로젝트 메타. `client_id`=청구처 자동파생(청구폼서 결정), `manager_id`=담당 엔지니어, `contact_id`=고객 담당자, `due_date`=마감일 |
| `project_tracks` | **곡·콘텐츠**. `content_type[Music\|Video_Post]` 상수·정규화는 있으나 **UI 미노출 → 현재 전부 Music** |
| `track_tasks` | **작업**. `task_type`·`billing_type`·`unit_price`·`engineer_name`·`engineer_id`→PM·`worker_rate`(외주 지급단가)·`status`·`is_invoiced`·`session_id`(세션 직접 청구)·`worker_paid`/`worker_paid_date`(외주 정산). 정산 합계=Σ`worker_rate` |
| `sessions` | **세션(일정)**. `session_type`·`session_date`·`start_time`/`end_time`·`booker_name`·`engineer_name`·`status`·`rate_item_id`·`room_id`→rooms·`gcal_event_id` |
| `invoices` / `invoice_items` | 청구 + 라인아이템 스냅샷. 채번 원자화(BEGIN/COMMIT). `paid_amount`=**`SUM(payments)` 파생 캐시** |
| `payments` | **입금 이력**(청구 1건에 부분납 여러 건, `invoice_id`·`amount`·`paid_on`·`memo`). `paid_amount`의 단일 편집 지점(add/deletePayment·recomputePaid). `payments_backfill_v1`로 기존 paid_amount 백필 |
| `project_managers` | **담당자 마스터**. `user_id` 링크=하우스 엔지니어(로그인 자동 연계), null=외주 작업자. 세션·작업 담당 select 출처. 외주 작업자는 **`/workers` 메뉴**(목록·작업 히스토리·정산)에서만 관리(일원화 완료) |
| `task_types` | **작업 종류 카탈로그**(곡·콘텐츠 후반작업). config `TASK_TYPES` 1회 시드 후 DB 단일 출처. `track_tasks.task_type`이 key 보관(FK 아님), 라벨/그룹은 data.js 캐시. 삭제-only |
| `project_service_items` | 레거시(구 services JSON 라벨 호환). 관리 UI 폐기(작업 종류 카탈로그가 대체), 테이블만 잔존 |
| `deliverables` | 자료 전달(Drive/로컬, 토큰 공개링크) |
| `admin_state` | drive folder_id·refresh token(암호화)·테마·studio_calendar_id·studio_location·**studio_hours(운영시간)**·studio_biz_*·studio_logo·alert_webhook_url |

> 도메인 상수(역할·상태·작업종류)는 `src/config.js`가 단일 진실원천. **DB CHECK 제약 금지**(마이그레이션 지옥 회피).

---

## 5. 코드 맵

```
src/
  server.js              부트스트랩 · 미들웨어 순서(보안→인증→라우트→static) · sameOriginRequest(무헤더 비안전 기본거부)
  config.js              env 검증(fail-fast) · 역할/상태/작업종류 상수 · normalize
  db.js                  스키마 · 멱등 마이그레이션 · AES-256-GCM 암호화
  auth.js                JWT 세션 · 권한 술어/미들웨어 · Google OAuth(논스+쿠키 대조) · 화이트리스트
  data.js                데이터 헬퍼(전 직원 전체 열람, 청구는 canInvoice 분기). listRooms/createRoom/deleteRoom. sessionAmountsByProject. 스튜디오 설정은 data/studio.js 재export
  data/studio.js         스튜디오(공급자) 설정 도메인(분리 착수 1차): getStudioInfo/getStudioLogo/**getStudioHours/setStudioHours/studioStartSlots**/getProMinutes/getDefaultBooker(운영시간·PDF 세금정보·기본값)
  notify.js              웹훅 알림(SSRF 방어: DNS→사설IP 차단, fail-safe)
  views.js               레이아웃 · **사이드바 그룹화**(운영/청구/관리, 권한별 NAV) · flashBanner · tabBar/filterChips/projectTypeBadge/**listGroup/listRow/emptyState** 헬퍼 · **테마 토글**
  views.invoices.js      청구 행/배지/섹션
  views.sessions.js      세션 폼(추가/편집 통일 그리드+슬라이더+룸 select)·세션 행 토글·월 캘린더 그리드
  views.projects.js      프로젝트 목록 행·메타/생성 폼·곡콘텐츠 섹션·청구 생성 폼(2026-07-09 라우트에서 분리 — 1328→627줄)
  views.clients.js       클라이언트 폼·첨부 블록·FILE_KINDS(2026-07-09 분리)
  views.settings.js      관리 4탭 섹션 렌더(환경설정·콘텐츠·담당자·시스템, 2026-07-09 분리 — 948→399줄)
  views.deliverables.js  자료 행/섹션
  routes/
    auth.routes.js       /login · OAuth(state 논스) · safeNext(역슬래시 차단) · /dev-login
    dashboard.routes.js  / (역할별 카드 + 오늘/이번 주 세션 카드)
    projects.routes.js   목록(검색·세션액 합산)·상세(곡콘텐츠·작업·자료·청구)·CRUD(곡일괄·마감일·삭제가드·클라이언트 담당자)
    contacts.routes.js   연락처 CRUD + 소속 이력(이직·종료)·생성 시 소속(requireEditor)
    invoices.routes.js   청구 CRUD(검색) · 입금/상태 · 채번 원자화 · 발행알림 첫전이
    sessions.routes.js   전역 일정(/sessions, **목록 검색·예정 세션 1클릭 완료**) + 세션 CRUD(룸별 겹침·취소 캘린더 동기화·상태잠금)
    clients.routes.js    클라이언트 CRUD + 분류 탭(filterChips) + 상세(진행 프로젝트·청구 히스토리) (치프)
    workers.routes.js    외주 작업자 목록·추가·삭제 + 상세(작업 히스토리·정산 지급 토글, worker_rate 기준) (치프)
    settings.routes.js   사용자·담당자(외주 안내링크)·작업종류·환경설정(**운영시간 studio-hours**·룸 CRUD·로고 매직바이트) 관리 (치프)
    deliverables.routes.js  업로드·토큰링크·다운로드
    api.routes.js        REST blueprint
    maintenance.routes.js  /internal/cron/* (BACKUP_TOKEN 게이트, 백업+연체 스캔)
  jobs/cron-trigger.js   Render cron 진입점(내장 fetch로 web 트리거, 의존성 0)
  lib/date.js · lib/forms.js   날짜·폼 파서
  lib/maintenance.js     VACUUM INTO 백업 + 14일 prune + 연체 요약
  storage.js · drive.js  스토리지 추상화(Drive↔로컬 폴백, 스트림 조기종료 FD 정리)
public/js/app.js         최소 JS(드로어·복사·자동제출·삭제확인·flash 배너·aria-expanded). CSP: 인라인 스크립트 0
public/css/src.css       Tailwind 소스. **Pretendard** 한글폰트 연결, **쿨톤 `--color-info`**(badge-info), 수동 **테마 토글**(`html[data-theme]`), muted #6E6A5F(AA 5.15:1), badge 변형 5종, btn-xs, focus-visible 링
```

---

## 6. 검증 · 메인터넌스 명령

### 6-0. 테스트 체계 — 3층 방어선 (`npm test`, 142개, CI Node 20/22 동일 실행)

> **철학(2026-07-04, 사용자 '아예 무결하게' 지시)**: 반복 실수는 주의력이 아니라 구조 문제.
> **같은 실수 클래스가 2번 나오면 "조심"이 아니라 가드레일 테스트로 승격**한다(CLAUDE.md 함정 #21).
> 모든 테스트는 격리 임시 DB(자가정리)·의존성은 **jsdom 1개**(상호작용 계층 전용, 명시적 예외).

| 층 | 파일 | 개수 | 검증 대상 |
|---|---|---|---|
| **① 단위** | `invoice-number`·`vat`·`rate-price`·`session-conflict`·`auth`·`party`·`payments`·`rental-session`·`task-status`·`rate-categories`·`waive`·`worker-detail` | 99 | 금전 로직(채번·VAT·Pro블록 단가·할인·**프로젝트 금액 할인 차감**[invoice_discount_total — from-tasks만, 수동 제외]·**0원 항목 confirmZero 청구**·**청구 항목 날짜순**[item_date])·세션 겹침(야간교차·취소예외)·권한·당사자 모델·입금 이력·대관 세션(녹음/촬영/공연 kind 매핑·금액 미정 정액)·**세션 담당 엔지니어 다대다**(session_engineers 저장·교체·유효id 필터·dedup)·**세션 외주 정산**(worker_rate 저장·재저장 시 worker_paid 보존·새 엔지니어는 미지급 시작·payout 조회)·**작업 완료 토글**(setTaskStatus·updateTask 상태보존 회귀)·**단가표 분류**(locked 가드·이름변경 cascade·사용중 삭제거부)·**청구 안 함(waive) 토글**(예산·미청구 집계 제외·되돌리기 시 원 금액 복원·이미 청구된 항목 잠금)·**외주 작업자**(listSessionsForWorker 다대다+레거시 폴백·중복없음, worker_files CRUD+CASCADE, id_number/account_number 암호화 저장·복원) |
| **② 정적 계약 가드** | `guardrails.test.js`(백엔드) + `guardrails-ui.test.js`(UI — companyCombo 옵션 키 ⑭ 포함) | 16 | 소스 양쪽을 스캔해 **반복 실수 클래스가 코드에 존재할 수 없게** — 아래 목록 |
| **③ 상호작용(jsdom)** | `ui-interactions.test.js` + `helpers-dom.js` | 28 | 실제 views 렌더 위에서 **실제 app.js를 실행**해 동작 검증 — 금액 캐럿 보존·콤보 검색(본명/활동명/회사)·선택/새등록 모달·IME 가드·세션 종류↔단가 옵션 스왑·종일 토글·구글식 시간 콤보·디렉터 프리필·simpleModal·외부 장소 토글·**이름 병기**(라벨 pick·라벨 재열람 유지·서버 렌더 주석)·dirty 폼·**네비게이션 가드**(일반 링크 가로채기·`data-no-guard` 통과)·**모달 배경클릭 드래그 구분**(mousedown 안쪽+click 배경=안 닫힘, 둘 다 배경=닫힘) |

**② 가드 목록** (각 가드에 사고 이력 주석 있음 — 왜 존재하는지 파일에서 확인):

- 백엔드(`guardrails.test.js`): ①보이는 input에 자동완성 카테고리 필드명(`name|company|address`) 금지(개명 완료: `party_name`/`worker_name`/`user_name`/`room_name`/`rate_name`/`biz_address`, 핸들러 구명 폴백) ②datalist 허용목록(`contact-artist-clients`만) ③'녹음' 하드코딩 비교/IN 금지(config `RENTAL_SESSION_TYPES`/`RENTAL_IN`만) ④에러코드 메시지 맵↔실제 구현 교차검증 ⑤app.js fetch body FormData 금지(함정 #14) ⑥personCombo 기본 companyOptions 임베드 ⑦`updateParty` 부분 갱신 계약(미전송=보존·빈 문자열=비움) ⑧모달 배경클릭 닫기의 mousedown 확인(함정 #25 — 드래그로 텍스트 선택 후 배경에서 마우스를 떼도 안 닫히게)
- UI(`guardrails-ui.test.js`): ⑧**data-\* 마커 계약**(app.js가 찾는 모든 마커는 어딘가에서 렌더돼야 — 서버/JS 어느 쪽 리네임 드리프트든 실패. 도입 첫 실행에서 죽은 참조 5건 검출·제거) ⑨콤보 보이는 입력(data-pc/cc/pk-input) name 금지 ⑩CSP 계약(인라인 핸들러·`<script>` 금지 — 배포에서만 조용히 죽는 드리프트) ⑪IME 가드 강제(Enter/방향키 keydown엔 isComposing 필수) ⑫금액칸↔MONEY 정규식 계약 ⑬personCombo 옵션 JSON 키↔app.js 소비 정합

**새 코드 쓸 때 가드에 걸리지 않는 법(=관례)**:
- 새 금액 입력칸 → name을 app.js `MONEY` 정규식에 추가(또는 매칭되는 이름 사용)
- 새 사람/회사 선택 UI → datalist 금지, `personCombo`/`companyCombo` 재사용(회사 옵션은 자동)
- 새 세션 종류/대관 규칙 → `config.js`만 수정(SQL·뷰는 `RENTAL_IN`·`SESSION_TYPE_RATE_KIND`에서 파생)
- 새 keydown 핸들러(Enter/방향키) → 맨 앞에 `if (e.isComposing || e.keyCode === 229) return;`
- 새 에러코드 → throw(구현)와 라우트 메시지 맵을 **짝으로** 추가
- 이름·주소류 보이는 input → bare `name="name|company|address"` 금지(`*_name` 등으로)
- updateParty 호출 → 폼에 없는 필드는 안 보내면 보존됨(전량 재전송 불필요)
- 보조 submit(미리보기 등)이 주 버튼보다 앞서는 폼 → 맨 앞에 `<button type="submit" disabled hidden>` sentinel(엔터 암묵 제출이 보조 버튼을 누르는 것 차단, 함정 #22)

**③ 작성 팁**(`test/helpers-dom.js`): `mountDom(html)`이 fetch 스텁·폴리필 포함해 실제 app.js를 window.eval로 실행(app.js는 DOMContentLoaded 무의존 IIFE라 실브라우저와 동일 초기화). 드롭다운 하이라이트는 MutationObserver(비동기)라 타이핑→Enter 사이 `await tick()` 필요. IME는 `fire(win, el, "keydown", { key:"Enter", isComposing:true })`.

```bash
npm test                                   # 전체 142개(단위+가드+상호작용)
node --test test/guardrails*.test.js       # 가드만 빠르게
node --test test/ui-interactions.test.js   # 상호작용만
node --test test/smoke.test.js             # 실서버 기동 스모크(주요 화면 21개 200 — '조용히 죽는' 회귀 검출)
```

```bash
# 문법(전 파일)
for f in $(find src -name '*.js'); do node --check "$f"; done
npm audit --omit=dev          # 0 vulnerabilities 기대
npm run build:css

# DB 무결성 + WAL 정리
node -e 'const{db}=require("./src/db");const d=db();console.log(d.prepare("PRAGMA integrity_check").get());d.exec("PRAGMA wal_checkpoint(TRUNCATE);")'

# 권한 스모크(서버 기동 후, curl 절대경로 — 서브셸 PATH 함정 회피)
for r in owner chief staff; do /usr/bin/curl -s -c /tmp/$r.txt -X POST -H "Origin: http://localhost:3000" --data "as=$r" http://localhost:3000/dev-login -o /dev/null; done
# /invoices → 전원 200(requireBilling) / /settings·/deliverables → chief·staff 200, owner 403(requireStaff) / /revenue → owner·chief 200, staff 403

# cron/백업 스모크(BACKUP_TOKEN=<t> 로 서버 기동 후)
/usr/bin/curl -s -X POST -H "Authorization: Bearer <t>" http://localhost:3000/internal/cron/daily   # 200 + 백업 생성
/usr/bin/curl -s -o /dev/null -w '%{http_code}\n' -X POST http://localhost:3000/internal/cron/daily  # 토큰없음 401(미설정 서버는 404)
ls data/backups/        # app-YYYY-MM-DD.db 생성 확인(최근 14일 보존)
BACKUP_TOKEN=<t> CRON_TRIGGER_URL=http://localhost:3000/internal/cron/daily node src/jobs/cron-trigger.js  # 종료코드 0
```

> 검증 함정: ① POST redirect에 `?flash=...`가 붙어 `grep '[0-9]+$'`로 ID 추출이 깨짐 → `grep -oE 'projects/[0-9]+'` 사용. ② curl을 `$(...)` 서브셸/함수 안에서 쓰면 PATH 손실 → `/usr/bin/curl` 절대경로. ③ 한글 쿼리스트링은 URL 인코딩.

---

## 7. 다음 작업 후보 (우선순위 순)

1. **프로덕션 검증** — Render에서 거래명세서 PDF 렌더(`@resvg/resvg-js` prebuilt 설치·동작)·알림 웹훅 발송 확인.
   환경설정에 **공급자 세금정보**(PDF용)·**알림 웹훅 URL** 입력 필요.
2. ~~Drive 실연동 검증~~ **완료 — 라이브**(업로드·일일 백업 오프사이트 정상).
3. ~~구글 캘린더 역방향 동기화(캘린더 삭제→앱 반영)~~ **폐기(2026-07-04)** — 보류 끝에 확정 제거. 앱→구글 단방향 자동 연동만 유지.
4. (선택) 알림 Gmail 어댑터(현재 웹훅만; `notify.js` 어댑터 슬롯).
5. ~~입금 이력 분리(`payments` 테이블)~~ **완료(2026-07-03)** — `payments` 테이블 + `paid_amount` 파생 캐시(SUM). 입금 건별 추가·이력 삭제·완납, `payments_backfill_v1` 백필. `paymentHistory` UI(전체화면·청구 탭 공용).
6. (선택) 자료 다중 업로드·백업 오프사이트 전송.
7. ✅ (완료) **data.js 모듈 분리** — 2049→58줄 순수 재export 허브 + 14개 도메인 모듈(`src/data/*.js`). 공개 export 124개 분리 전후 동일(매 커밋 대조). 상호의존(invoices↔sessions)만 지연 require, 나머지는 형제 모듈 직접 require. CLAUDE.md TODO 9 참조.
8. (보류) **content_type/billing_type UI 노출** — `content_type[Music|Video_Post]`·`billing_type` 현재 미노출/강제; 영상 구분·과금 유형 선택은 향후 확장 시 복원.

> **완료(이번 세션·2026-07-11g 최신)**: **프로젝트 목록 카드 펼침에서 바로 세션 완료**(사용자 요청 — 목록 펼침 미리보기엔 완료가 없어 프로젝트 상세·일정으로 들어가던 2중3중) — `projectSummaryHtml` 펼침 세션에 완료 토글, `POST /sessions/:id/status`+`return=/projects?open=projectId` → 완료 후 그 카드 재펼침(`<details open>`)·스크롤 보존, 일반 리로드는 접힘. `listProjectSummaries` 세션 id 추가. `src/data/projects.js`·`src/views.projects.js`·`src/routes/projects.routes.js`. 199 테스트·E2E·실브라우저 검증.
> **완료(2026-07-11f)**: **일정 캘린더 기본(서베이) + 칩 클릭 팝오버에 완료**(사용자 요청 — 완료가 프로젝트 세션 탭·일정 목록 2중3중) — `/sessions` 기본 뷰 목록→캘린더, 칩 클릭 시 이동 대신 중앙 모달 팝오버(구글식 상세 + 완료 처리 + 프로젝트 링크). `data-session-card`→app.js fetch `GET /sessions/:id/card`, 완료=폼 POST(return=캘린더). 신규 `getSessionCard`·`sessionCardModal`·카드 라우트·status return. 프로젝트 타임라인 무변경, 목록 완료 유지. `src/data/sessions.js`·`src/views.sessions.js`·`src/routes/sessions.routes.js`·`public/js/app.js`. 198 테스트·HTTP E2E·실브라우저(팝오버·완료 복귀) 검증.
> **완료(2026-07-11e)**: **고객측 담당자 여러 명(칩) + 라벨 설명 제거**(사용자 요청) — 고객측 담당자를 아티스트처럼 personCombo multi 칩으로(`project_contacts` 다대다 신설·백필, `contact_party_id`=첫 호환, `resolveContactIds` 인덱스 페어링, `listProjectsForParty`·`ASSOCIATE_ROLE_SUBQUERY` UNION 확장). 라벨 괄호 설명 삭제. 제작/운영은 단일 유지. 격리 결함 수정(project-list.test.js 실 dev DB 접촉→임시 DB). `src/db.js`·`src/data/{projects,parties}.js`·`src/routes/projects.routes.js`·`src/views.projects.js`. 198 테스트·HTTP E2E·실렌더(칩) 검증.
> **완료(2026-07-11d)**: **프로젝트 폼 소속/레이블 필드 폐기 → 아티스트에서 파생**(사용자 검토 요청) — 소속/레이블은 아티스트 속성이라 프로젝트가 임의 입력하지 않고 저장 시 첫(대표) 아티스트의 현재 소속(`currentAffiliation`)에서 `agency_id`·표시 `artist_company` 파생(다중=첫 기준·무소속=null). 폼에서 필드 제거→아티스트 전폭. 소속 지정은 아티스트/연락처·간이 등록에서. 제작/운영은 프로젝트 속성이라 유지. `src/views.projects.js`·`src/routes/projects.routes.js`. 197 테스트·HTTP E2E 검증.
> **완료(2026-07-11c)**: **새 프로젝트 폼 레이아웃 재설계**(브레인스토밍) — 1줄 `프로젝트명|프로젝트 매니저` · 2줄 `아티스트|소속/레이블(아티스트 소속)` · 전폭 `제작/운영`·`고객측 담당자`·`메모`. 소속/레이블을 아티스트 옆으로 옮겨 착오 해소, 담당자(고객 PM)는 어느 회사에서든 오므로 전폭 독립, 세션 '담당 엔지니어'와 겹쳐 프로젝트 단은 '프로젝트 매니저(PM)' 유지. 배치·라벨만(필드·저장 불변), 생성·편집 동일. `src/views.projects.js`. 197 테스트·DEV_LOGIN 실렌더.
> **완료(2026-07-11 최신)**: **프로젝트 목록 재설계**(브레인스토밍→설계문서→계획→subagent-driven 실행) — 회사·아티스트 정체성 + 다가오는 세션 중심으로 재편. **3탭**(진행 중/청구 필요/완료, `splitProjectTabs` 순수 함수·상호 배타) + **정체성 카드**(`projectIdentity`=`아티스트 · 회사` 주·프로젝트명 부제·담당자/작성일/금액 앞면에서 내림) + **진행 중 임박순 정렬** + **작성일 카드 제거→상세 치프 편집**(`safePath` 복귀) + **금액은 청구 필요 탭에서만** + **다음 세션·곡 없으면 표기 생략** + **펼침 세션 upcoming-우선 재정렬** + **다음 세션 PM 밑 이동·디데이 임박도 3단계 색·옅은 보더 pill·크게**(3일내 빨강/2주내 주황/멀리 흐린 회색, 디데이만 pill로 강조). 데이터 쿼리 추가 0. `src/data/projects.js`(splitProjectTabs)·`src/views.projects.js`(projectListRow·projectIdentity·projectSummaryHtml·projectMetaCard·nextSessionLine)·`src/routes/projects.routes.js`. 197 테스트(project-list 7 신규)·build green·DEV_LOGIN 3탭 200·디데이 3단계 실렌더 확인. 설계·계획=`docs/superpowers/{specs,plans}/2026-07-11-*`.
> **완료(2026-07-06 최신)**: **세금계산서 발행 이메일에 담당자 이메일 병기**(사용자 요청 '담당자가 받아야 하는 경우도 있네'): `listInvoices`에 `payer_email`(청구처 자체)·`contact_email`(업체면 현재 담당자, affiliations 조회) 파생 → 청구 목록 카드(`invoiceRow`)·청구 상세·프로젝트 청구 탭(`payerInfoCard` 공용)의 "세금계산서 발행 이메일" 줄에 둘 다 표시(`이메일 · 담당자이메일 (담당자)`, 클릭 복사). `src/data/invoices.js`·`src/views.invoices.js`. 142 테스트·DEV_LOGIN 실렌더(임시 DB, 업체+현재 담당자 이메일 조합) 확인.
> **완료(이번 세션·2026-07-06 재후속)**: **외주 미지급 미리보기에 프로젝트명 추가**(사용자 요청 '어느 프로젝트에 어느 작업을 했는지가 보이면 좋겠다'): `/workers` 목록 카드 미리보기 라벨을 `프로젝트명 · 작업종류/세션종류 날짜`로 확장 — `listTasksForWorker`/`listSessionPayoutsForWorker`가 이미 조회하던 `project_title`을 앞에 붙이기만 함(새 쿼리 없음). `src/routes/workers.routes.js`. 142 테스트·DEV_LOGIN 실렌더(임시 검증 DB, 2개 프로젝트 항목 구분 확인) 통과.
> **완료(이번 세션·2026-07-06 후속)**: **외주 정산 항목 식별 정보 보강**(사용자 리포트 '정산할 때 어떤 항목인지 명확하지 않다' — 앞선 미리보기 한 줄 추가만으론 부족, 같은 종류 작업이 여러 건이면 여전히 구분 안 됨): `listTasksForWorker`가 `track_artist`(트랙 아티스트, 없으면 프로젝트 아티스트 폴백) 추가 조회, `/workers` 목록 카드 미지급 미리보기·`/workers/:id` 정산·참여 내역 탭의 작업 행에 **아티스트 + 작업일(생성일)** 표시(`taskTypeLabel(t.task_type) 7월 1일`·`보컬튠 · 곡아티스트 · 프로젝트/트랙 · 7월 1일`). 세션 항목은 원래 날짜가 있어 무변경. `src/data/parties.js`·`src/routes/workers.routes.js`. 142 테스트·DEV_LOGIN 실렌더(수동 데이터) 확인.
> **완료(이번 세션·2026-07-06)**: **청구 목록 카드 UX 수정**(사용자 요청) — 카드 전체 링크+접이식 '상태 처리' `<details>` → **제목만 링크(상세보기) + 상태 처리(계산서·입금 토글)를 금액 바로 밑에 항상 노출**(접기 폐기, 카드 전체 링크와 버튼 히트영역 겹침 해소). `src/views.invoices.js` `invoiceRow` 비compact 분기. 142 테스트·DEV_LOGIN 실렌더 확인.

> **완료(이번 세션·2026-07-04~05)**: ①**세션 폼 구글 캘린더식 개편**(시간 콤보·진짜 종일 `all_day`·다일 `end_date`) ②**룸→장소 + 외부 주소**(Google Places 자동완성 백엔드 프록시 `/sessions/place-suggest`·`GOOGLE_PLACES_API_KEY`) ③**가드레일 3계층 테스트 체계**(정적 가드 14 + jsdom 상호작용 — §6-0) ④**담당자 이름 전면 병기(2026-07-05 사용자 요청)**: 청구서 계열(payerCombo·PDF·거래명세서) 제외 전 표면 `본명 (활동명)` — personCombo **선택 표시=라벨**·**제출 숨김 이름=순수 본명 분리**(라벨이 연락처로 저장되는 것 방지)·**필드 밑 소속(회사) 주석 서버 렌더**(`data-pc-info`)·세션 목록/캘린더 설명 디렉터·그룹 멤버·업체 소속 아티스트·연락처/클라이언트 suggest 병기·dirRow `options` 전달(sel 라벨 조회). 98 테스트·DEV_LOGIN E2E(프로젝트 담당자·디렉터·suggest·무JS 재저장 회귀). 상세는 git·CLAUDE.md 프로젝트 메타 섹션.
> **직전 완료(2026-07-04)**: **UI 전면 개편(25커밋·라이브 배포)** — 사용자 요청 연속 반영. **목록 통일**: 프로젝트·일정·청구 목록을 프로젝트 카드 톤으로 통일(`rounded-xl border-border/60 bg-surface`), 각각 **탭 분리**(프로젝트 진행중/완료·일정 일정/지난·청구 발행필요/발행완료, `tabBar`). **세션**: 예정·완료 배지 제거→**완료 버튼 토글**(예정↔완료·글리프 −/✓·고정폭 크기불변)·폼 **상태 필드 제거**(hidden 보존)·담당 엔지니어를 상태 자리로·룸↔녹음단가 스왑(3열)·청구라인 `break-keep` wrap·소요 16h·모바일 프리셋 흐름정렬·시작 **직접입력 박스**(콜론 자동)·디렉터 X 버튼 정렬·일정 목록 프로젝트별 카드(헤더 비링크). **캘린더**: `.card` 제거+**그리드 라인**+`-mx`로 **화면 끝까지(full-bleed)**·모바일 시간숨김·칩 라벨=아티스트/프로젝트. **청구**: 카드별 접이식 '상태 처리'([계산서/현금영수증 발행 완료][입금완료] **토글**·상태 반영 불·**되돌리기 시 자동 완납입금만 제거**·색은 세션 완료 토글의 success 흐름)·청구처 유형별 계산서/현금영수증 구분. **검색 typeahead**(프로젝트·세션·클라이언트·연락처 `/suggest`)·**모달 스크롤 잠금**(전 모달)·**저장 안 한 변경 이탈 가드**(저장/저장하지 않음→목적지 이동, `beforeunload`)·personCombo **활동명 필드**(→is_artist)·회사 검색 콤보·프로젝트 **생성일 표시·정렬**. 연락처 수동 'Google 동기화' 버튼 제거. 61 테스트·build green, DEV_LOGIN 브라우저 E2E(탭·토글·되돌리기·full-bleed·typeahead) 검증. 상세는 git 커밋(`d929172`~`fc556cc`).
> **직전 완료**: **세션 겹침 = 하드 차단(409) → 경고+확인 후 강행**(사용자 요청). 같은 룸·같은 시간 겹침을 막지 않고 **확인 후 등록 허용**: 시작 시간 그리드의 예약 슬롯을 회색 비활성 대신 **주황(`slot-busy`)·선택 가능**으로, 선택 구간이 겹치면 **시작 시간 아래 경고**(`[data-conflict-warn]`·`overlapDetected`), **제출 시 confirm("이미 스케줄이 있습니다. 그래도 등록하시겠습니까?")** → 승인 시 hidden `override_conflict=1` → 서버 `assertNoSessionConflict(...allowConflict)`가 검사 스킵(`conflictOverride`, create·update 공통). override 없는 겹침은 여전히 409(무JS·경합 안전망). 회귀 테스트 1건 추가(총 61). DEV_LOGIN E2E: 기준 세션 302 → 겹침 override 없음 409 → override=1 302 확인. src.css `.slot-busy`(components 레이어라 peer-checked가 위에서 우선)·build:css 반영.
> **그 전 완료**: **data.js 모듈 분리 완료**(TODO 7) — `data.js` **2049→58줄**, 함수 본문 0의 **순수 재export 허브** + **14개 도메인 모듈**(`src/data/*.js`). 2차(client-files·revenue·deliverables·rooms·rate-items·task-types) 후 코어까지 전량 분리: `contacts`(사람+소속+담당자연동)·`clients`(거래처+담당자 마스터)·`projects`(deleteProject 포함)·`tracks`(트랙/작업 CRUD)·`invoices`(금액 파생·채번·초안/생성/삭제·목록/통계)·`dashboard`·`sessions`. **공개 export 124개 분리 전후 완전 동일**(매 커밋 HEAD 대조·added/removed 0). **패턴**: 형제 모듈 직접 require(무순환 대다수), 상호의존(invoices↔sessions: invoices→sessionRateAmount / sessions→isSessionInvoiced) 양방향만 함수 내부 지연 require("../data")로 순환 회피. 내부전용 헬퍼(normalizeTaskTypeDb·getManagerByUserId·nextInvoiceNumber·computeInvoiceDraft·resolveTaskEngineer·sessionFields 등) 공개 미노출. 고아 import 전량 정리(db·lib/date·config·auth·crypto·잔여 바인딩). 도메인별 개별 커밋·push, 각 40개 테스트 + 머니패스 스모크(VAT 110만/10만·채번 INV-·1Pro 30만·3Pro 90만·세션 겹침 차단·세션청구 33만·청구 잠금 양방향·dashboardStats 미수금) + 라우트 전체 로드 통과. **+ DEV_LOGIN 브라우저 E2E 검증**(치프·임시 DB·실데이터 무변경): 세션 목록·**생성**(운영시간 그리드→새 세션 추가 성공)·청구 목록/통계·인라인 상세·**입금 '완납 처리' 쓰기**(미수금 ₩250만→0·입금완료)·대시보드 교차모듈(dashboardStats→invoiceStats·upcomingSessions)·세션↔청구 상호의존(invoiced 플래그) — 읽기·쓰기·교차모듈 무회귀 확인.
> **그 전 완료**: **v1.0 릴리스 위생 점검(/audit Top5)** — 버전 0.1.0→1.0.0·description 현행화, **GitHub Actions CI 신설**(Node 20/22: `npm test`+`build:css`, `checkout@v5`·`setup-node@v5`), 죽은 코드 제거(미사용 `issued`+2축 분리 후 죽은 `status==="입금완료"` 비교), **세션 겹침 검사 '취소' 예외**(취소 세션 룸 미점유·회귀 테스트 2건→총 40개), **data.js 모듈 분리 1차**(스튜디오 설정→`src/data/studio.js` 재export 허브·`cleanTime`→`lib/date` 공유); **모바일 목록 찌그러짐 전수 개선**(`.badge` `whitespace-nowrap`, 청구·클라이언트·연락처 목록 '제목 전폭→배지 줄→메타' 재구성, 375/390px 검증 — 함정 17); **긴 안내문 전수 접기**(`explain()` 헬퍼 — 설정 항목 설명·폼 안내를 기본 접힘 '설명' 토글로, 상태·오류·모달 경고는 유지).
> **그 이전 완료**: **연락처 표시명 제거·전화 010-####-#### 정규화·치프 역할 전환**(본인 잠금·최소 1치프), **청구서 할인**(정액+정률·공급가 차감 후 VAT 재계산·선택 항목 동적 공급가·거래명세서 할인 라인) + **외주/하우스 담당자↔연락처 양방향 연동**(자동 노출·전화 양방향·외주 이메일 양방향·하우스 이메일 잠금)·매출 아이콘 수정, **클라이언트 첨부 서류**(사업자등록증·통장사본 드래그앤드롭·매직바이트·치프 인증 다운로드), **연락처 확장 + Google People API 양방향 동기화**(성·이름·호칭·별명·회사·직책·부서; push+수동 'Google 동기화' 버튼·삭제 양방향·fail-safe·cron 제거), **세션·담당자·매출 개선**(담당 디렉터·룸 기본 A·예약담당자 기본값·외주단가 조건부·하우스/외주 정보수정·매출 메뉴·연락처 tel 링크), **프로젝트 폼 개선**(마감일 제거·고객측 담당자 정보표시·목록 외 이름→새 연락처 자동생성·body limit·0원 단가 가드), **/audit 진단 후속**(수동 청구 VAT 역산·세션 겹침 전 타입·from-tasks 에러 정합 + **금전 핵심 테스트 24개**[node:test]·`/audit` 진단 프롬프트), **전방위 점검(ultrawork)**(세션 시간유실·발행알림 누락·삭제가드·죽은코드 제거·UX·notify 일원화), **청구처 청구시점 이동·용어 통일(청구처/담당 엔지니어/고객측 담당자)·프로젝트 유형 폐기·연락처(담당자) 도메인**.
> **그 이전 완료**: 디자인 기반(Pretendard·쿨톤 info색·사이드바 그룹화·테마 토글·listGroup/listRow/emptyState·opacity.12), 백엔드 정리(resolveEndTime·0원 가드·죽은코드·parseMoney/timeToMin·운영시간 인프라), 라운드2 UX(세션폼 조건부 단가·완료1클릭·검색·운영시간 슬롯·청구 진입점·클라이언트 검색·대시보드).
> **이전 완료**: 다중 룸(룸별 겹침·FreeBusy 폐기·룸 CRUD), 외주 지급단가(`worker_rate`·`engineer_id`·정산), 청구 완료요건 통일, 정합보수(세션잠금·삭제가드·발행알림·채번원자화), 보안 하드닝(CSRF·OAuth 논스·SSRF·매직바이트), UX(대시보드 세션카드·마감일·유형변경·곡일괄·청구검색·견적서·세션액합산), UI 공통 헬퍼(tabBar·filterChips·projectTypeBadge·badge·AA대비), 외주 관리 일원화.
> **더 이전 완료**: Render 실배포·OAuth, 세션 UX(그리드·슬라이더·캘린더 뷰·청구잠금), 녹음 세션 직접 청구, 클라이언트 자동 등록·상세, 외주 작업자 메뉴, 탭 그룹화, 작업 종류 카탈로그, 거래명세서 PDF, 알림 채널(웹훅).

---

## 8. 용어 사전 (UI ↔ 코드)

| UI 표기 | 코드 식별자 | 비고 |
|---|---|---|
| ~~세션 / 작업~~ | `project_type` (레거시) | **유형 구분 폐기**(2026-06-30) — 전 프로젝트가 세션 일정+곡·콘텐츠 동일. `project_type`은 레거시 컬럼(신규=session, UI 미노출) |
| 연락처 / 소속 | `contacts` / `contact_affiliations` | 클라이언트 측 담당자 + 소속 이력(이직). `ended_on` NULL=현재, 무소속=`client_id` NULL. 프로젝트 `contact_id`로 연결 |
| 곡 · 콘텐츠 | `project_tracks` / `track` | 녹음과 별개의 후반작업 단위. `content_type`(Music\|Video_Post)은 UI 미노출(현재 전부 Music) |
| 작업 | `track_tasks` / `task` | 보컬튠·믹싱·마스터링 등 모듈 단위 |
| 일정 / 세션 | `sessions` | 녹음/믹싱/마스터링 예약. 사이드바 "일정" |
| 녹음 종류 | `rate_items` (`rate_item_id`) | **단가표 항목**(보컬녹음 등), 스튜디오/로케이션 분류 그룹. 녹음 세션 1Pro 산정. UI 라벨 통일 |
| 세션 종류 | `session_type` | 녹음/믹싱/마스터링/기타(세션 구분, 겹침검사 단위). '녹음 종류'와 다른 필드 |
| 작업 종류 카탈로그 | `task_types` | 곡·콘텐츠 작업 종류(보컬튠·믹싱…), DB 관리·삭제-only |
| 클라이언트 | `clients` | 통칭(아티스트·소속사·제작사). **청구처**(=실결제자)=청구의 결제 역할(`client_id`, 청구폼서 결정) |
| 하우스 엔지니어 / 외주 작업자 | `project_managers`(`user_id` 유/무) | 작업 담당자 select 출처. 외주는 **`/workers` 메뉴** 단독 관리(일원화 완료). 정산 합계=Σ`worker_rate` |
| 룸 | `rooms` / `room_id` | 스튜디오 룸. 세션별 지정. 겹침 검사 단위(같은 룸만 충돌, 다른 룸 병렬 허용) |
| 지급단가 / 고객청구 | `worker_rate` / `total_price` | 작업 단위. 정산=Σworker_rate, total_price는 마진 산정용 참고 |
| 대표 / 치프 / 스태프 | `owner` / `chief` / `staff` | 권한 3단계 |
