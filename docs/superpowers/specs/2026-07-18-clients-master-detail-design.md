# 업체·그룹 마스터-디테일 전환 — 설계

> 2026-07-18 · 사용자 요청("업체·그룹도 연락처처럼 아이클라우드 연락처 스타일로 — 왼쪽 이름, 오른쪽 내용. 한 번에 여러 업체를 볼 이유가 없다")
> 대상: `/clients`(업체·그룹 메뉴, 업체/그룹 2탭)
> 참고 틀: `docs/superpowers/specs/2026-07-17-contacts-master-detail-design.md`(연락처 전환, 동일 패턴)

## 배경 · 문제

업체·그룹 목록은 `dataTable`(업체=이름·대표·사업자번호·전화·이메일 / 그룹=이름·소속·전화·이메일·담당자) 전폭 표다.
2026-07-16~18에만 열 조정이 반복됐다(유형 열 폐기, 사업자번호 폭·nowrap, 이름·이메일 유동, 그룹 담당자 열 추가, 이름·소속 균형, 담당자 맨 뒤로…). 방금도 "전화 삭제·이메일→계산서 이메일·담당자 열 추가"를 하던 중이었다.

근본 원인은 폭 계산이 아니라 **화면의 성격 오인**이다(연락처와 동일). 표는 여러 행을 나란히 비교·스캔할 때 값어치가 있는데, 업체·그룹에서 실제로 하는 일은 "이 업체 찾아서 사업자번호·계산서 이메일·대표·담당자 확인" 또는 "수정"이다. 사용자 판단: **한 번에 여러 업체 정보를 볼 이유가 딱히 없다.**

→ 이름 한 열(마스터) + 상세 패널(디테일)로 바꾸면 비교용 열이 사라져 **열 폭 문제 자체가 소멸**하고, 연락처와 UX가 통일된다. 진행 중이던 표 열 작업(전화 삭제·계산서 이메일·담당자 열)은 그 정보가 전부 오른쪽 상세에 담기므로 **폐기**한다.

## 목표 · 비목표

**목표**
- 업체·그룹(`/clients`)을 마스터-디테일(왼쪽 이름 목록 + 오른쪽 상세)로 전환
- 상세를 **읽기 뷰 + [편집]**으로(연락처와 완전 통일 — 사용자 결정). 지금의 "상세=바로 인라인 편집"을 뒤집는다
- 열 폭 튜닝이 필요한 지점을 이 화면에서 제거, 목록 상한 없이 전 명단 노출

**비목표(이번에 안 함)**
- 연락처 화면 — 이미 전환됨, 건드리지 않음
- 편집 폼(`clientForm`) 자체의 필드·저장 로직 변경 — 그대로 두고 편집 뷰로 옮기기만
- 프로젝트/청구 데이터 조회 로직 변경 — 표시 위치만 이동
- SPA화(오른쪽만 JS 교체) — 서버 렌더 유지(앱 원칙)
- 애플식 ㄱㄴㄷ 인덱스 레일 — 실시간 필터로 충분(YAGNI)

## 확정된 결정(사용자)

| 항목 | 결정 |
|---|---|
| 화면 구조 | 왼쪽 이름 목록 + 오른쪽 상세(마스터-디테일) |
| 상세 편집 방식 | **읽기 후 편집**(오른쪽=읽기 뷰 + [편집] 버튼, 연락처와 완전 통일) |
| 진행 중이던 표 열 작업 | **폐기**(정보는 읽기 뷰에 담김) |

## 접근 방식 — A안(채택, 연락처와 동일)

`/clients/:id` **자체를 2단 페이지로 만든다.** 새 URL 개념을 만들지 않고 기존 상세 경로의 렌더링만 바꾼다.

- 서버 렌더 그대로 → JS 0, CSP 무관, 뒤로가기·북마크·딥링크 공짜
- 선택 시 전체 페이지 로드 — 앱 전체가 이미 그 방식(연락처 포함)이라 이질감 없음
- `/clients`는 경로 파라미터(`/clients/:id`)라 연락처처럼 자연스럽게 A안. 관계자 탭 같은 `?sel=` 예외 불필요

**기각**: `?sel=` 쿼리(상세 URL 두 벌)·JS fetch 교체(History 직접관리+무JS 사망) — 연락처 설계와 동일 이유.

## 화면 · 라우트

### 1. `GET /clients` — 목록 + 빈 패널
- 왼쪽: `업체 / 그룹` 2탭(`tabBar`, 개수 라벨) + 검색(`searchBox liveFilter`) + **이름만 목록**
  - 업체 행 = `c.name` / 그룹 행 = `c.activity_name || c.name`
  - `+ 새 업체·그룹` 드롭다운(현행 `[data-menu]` 팝오버)은 왼쪽 상단 유지
- 오른쪽: `emptyState("업체·그룹을 선택하세요")`
- 좁은 화면(<1024): 왼쪽만

### 2. `GET /clients/:id` — 목록(선택 강조) + 읽기 뷰
- `c.kind === "person"`이면 현행대로 `/contacts/:id` 302(상세는 조직 전용, from·return 보존)
- 읽기 뷰 = **탭 없이 한 화면 스크롤**(연락처와 동일). 구성은 아래 [읽기 뷰 구성] 참조
- 좁은 화면(<1024): 오른쪽만 + '← 업체·그룹' 뒤로가기

### 3. `GET /clients/:id/edit` — 목록 유지 + 오른쪽만 편집 폼
- 지금은 상세로 리다이렉트만 하던 경로를 **편집 모드로 되살린다**(연락처 `/contacts/:id/edit`와 대칭)
- 내용 = 현행 상세 info 탭 그대로: `clientForm(embedded, isEdit)`(dirty 저장) + `clientFilesBlock`(업체 첨부 업로드/삭제) + `memberSection`(그룹 멤버 추가/제거) + 크로스링크
- 저장(`POST /clients/:id`) 후 → `/clients/:id` **읽기 뷰**(현재 `?flash=saved` 무탭 복귀를 읽기 뷰로). AJAX 자동저장(`X-Requested-With: fetch`)은 현행대로 `res.json` 후 페이지 유지
- 삭제(`POST /clients/:id/delete`) 후 → `/clients`
- 첨부 업로드/삭제(`POST /clients/:id/files*`)·멤버 추가/제거(`POST /clients/:id/members*`) 후 → `/clients/:id/edit`로 복귀(편집 모드 액션이므로. 현재는 상세로 복귀)
- 취소 → `/clients/:id` 읽기 뷰

## 읽기 뷰 구성 (`clientReadView`)

탭 없이 위에서부터. **빈 섹션은 헤딩까지 통째로 숨김**(연락처 규칙과 동일).

### 업체(company)
1. **헤더** — 업체명(큰 글씨) + 역할 배지(`clientRoleList` — 제작사/운영사·소속사/레이블), 우상단 **[편집]**
2. **기본 정보**(홈택스 공급받는자 순서) — 사업자등록번호(`biz_no`) · 대표(`listCompanyOwners` 성명, 각 `/contacts/:id` 새 탭 링크) · 사업장 주소(`address`) · 계산서 발행 이메일(`email`) · 전화(`phone`). 값은 `copyable`, 없으면 '—'. **사업자등록증 미등록이면 사업자번호 옆 경고 아이콘**(현행 목록 아이콘 재사용)
3. **담당자** — `listOrgContacts(id)` 목록(이름·`/contacts/:id` 새 탭 링크). 없으면 섹션 숨김
4. **소속 아티스트** — `listArtistsForAgency(id)` 목록(`/clients/:artistId`… → 사람이면 302로 `/contacts`행). 없으면 숨김
5. **첨부 서류** — 사업자등록증: 있으면 '보기'(인증 다운로드 링크, `storage.exists`로 존재 확인), 없으면 '미등록'. **읽기 전용**(업로드/삭제는 편집 뷰)
6. **프로젝트** — `listProjectsForParty(id)`, 있을 때만. 현행 `clientProjectCard`(views.clients.js) 재사용 — 표시 위치만 읽기 뷰 섹션으로 이동. 없으면 숨김
7. **청구·결제** — `listInvoicesForParty(id)`, 있을 때만. 합계 카드(청구합계/입금/미수 `formatKRW`) + `invoiceRow` 목록. 없으면 숨김
8. **연동 정보** — 대표자 연락처(공동대표 전원 `/contacts/:id` 새 탭). 나가는 링크는 연락처 읽기뷰처럼 **새 탭**(`target=_blank`)

### 그룹(group)
1. **헤더** — 그룹명 + 우상단 [편집]
2. **소속사** — `currentAgencyName`(있으면 `/clients/:agencyId` 링크). 없으면 '—'
3. **담당자** — `contact_party_id` 사람(`/contacts/:id` 새 탭). 없으면 숨김
4. **멤버** — `listGroupMembers(id)` 목록(각 멤버 `/contacts/:id` 또는 `/clients/:id`). 없으면 숨김
5. **프로젝트 / 청구·결제** — 업체와 동일(있을 때만)

> **나가는 링크 새 탭 규칙**: 연락처 읽기뷰와 동일 — 업체·그룹 밖으로 나가는 링크(대표자·담당자·멤버·소속 아티스트·프로젝트·청구·소속사)는 `target=_blank rel=noopener`+`↗`. 왼쪽 목록이 곧 작업 맥락이라 같은 탭에서 나가면 돌아오기 번거롭다.

## 편집 뷰 (`/clients/:id/edit`)

현행 상세 info 탭 본문을 **그대로** 편집 뷰로 옮긴다(신규 작성 아님):
- `clientForm(c, isEdit=true, files, fileErr, canFiles, contacts, companies, embedded=true, withExtras=false)` — dirty 저장·명시적 저장/취소(`dirtyActionRow`)·삭제 폼
- 업체: `clientFilesBlock`(사업자등록증 업로드/삭제). 그룹: `memberSection`(멤버 personCombo 추가·행 제거)
- 크로스링크(대표자 연락처 등)
- 취소·저장 후 복귀 = `/clients/:id` 읽기 뷰

## 컴포넌트 경계

| 단위 | 위치 | 책임 | 재사용/신규 |
|---|---|---|---|
| `contactPanes({left, right, hasSelection, backHref, backLabel})` | views.contacts.js | 2단 골격 + 반응형 | **재사용**(이미 범용) |
| `contactNameList({rows, selectedId, hrefFn})` | views.contacts.js | 이름만 목록 + 필터·키보드 마커 | **재사용** |
| `clientReadView(c, {...})` | views.clients.js | 업체/그룹 읽기 뷰(위 구성) | **신규** |
| `clientEditPane(c, {...})` | views.clients.js | 편집 폼+첨부+멤버 묶음(현행 infoContent 이동) | **신규(코드 이동)** |

- `contactPanes`/`contactNameList`는 이름만 `contact*`일 뿐 내용은 범용 — clients에서 import해 그대로 쓴다(범용 리네임은 비목표).
- 데이터 조회는 라우트가(현행처럼). 뷰는 순수 렌더.
- `clientReadView`는 `editHref`를 인자로 받아 [편집] 목적지를 호출부가 정한다(연락처 패턴과 동일).

## 반응형 규칙 (연락처와 동일)

- 골격 `lg` 2단(`lg:grid lg:grid-cols-[18rem_minmax(0,1fr)]`), 미만 한 단
- 목록 URL(선택 없음): 왼쪽 `block`, 오른쪽 `hidden lg:block`
- 상세/편집 URL(선택 있음): 왼쪽 `hidden lg:block`, 오른쪽 `block`
- 서버가 선택 여부로 클래스 결정 → **JS 없음**. 페이지 `layout({wide:true})`
- ⚠️ 새 Tailwind 임의값 클래스는 리터럴로 쓰고 `npm run build:css` 후 실측(함정 #27·연락처 전환에서 밟음)

## 제거 · 정리

| 대상 | 처리 |
|---|---|
| `/clients` 목록의 `dataTable`(orgCols/orgRows 업체·그룹 두 분기) | 삭제 — 이름 목록으로 대체 |
| 배치 조회 `agencyByParty`·`contactByGroup`·`bizLicenseSet`(목록용) | 삭제(목록은 이름만) — 단 `bizLicenseSet`/소속사·담당자 조회는 **읽기 뷰**에서 단건으로 재사용 |
| 방금 하던 그룹/업체 표 열 작업(전화 삭제·계산서 이메일·담당자 열) | **폐기**(읽기 뷰가 대체) |
| 목록 `capList`(100건)·더보기·`searchBox({remote})` | 삭제 — 이름만이라 전 명단 노출(연락처와 동일). remote 불필요 |
| 목록 **행 링크**의 `?from=`·`?return=` | 제거(왼쪽에 목록 늘 있음). 단 ①청구·프로젝트→업체·그룹 유입 `?return=`과 ②[편집] 백링크는 **유지** |
| 상세 인라인 편집(진입 즉시 폼) | 읽기 뷰로 대체(편집은 `/edit`) |

## 데이터 · 규모(실측 2026-07-18)

업체 119 · 그룹 20 = 총 139. 이름만 렌더라 전 명단이 수십 KB 이하(연락처 202건보다 적음). 상한 없이 안전. 부담 임계(명단 2,000건대)는 연락처와 공유 — 그때 가상 스크롤 검토.

## 오류 · 예외

- `/clients/:id` 없는 id → 현행 404 `errorPage`(2단 아님)
- `c.kind === "person"` → `/contacts/:id` 302(유지)
- 빈 목록(탭별) → 왼쪽 `emptyState`(업체/그룹별 CTA — 그 탭 유형으로 새로 생성)
- 삭제된 업체 상세 열어둔 채 저장 → 현행 라우트 동작 유지
- 발행/입금 인보이스 있는 업체 삭제 → 현행 409 거부 유지

## 테스트

**기존 계약 갱신**
- `test/nav.test.js`(clients 분기): 상세 백링크 `safePath` 유지 + [편집] 백링크. 행 링크 `?return=` 제거에 맞게 계약 갱신(연락처와 동일 방식)
- `test/contacts-panes.test.js`: **그룹 담당자 열 테스트(231–234행) 삭제**(목록이 이름만이 됨). `/clients` 2탭·사람 302·`type=artist` POST 유지는 존치
- `test/guardrails-ui.test.js`: 읽기뷰 카피에 '클라이언트' 금지(⑯) 준수 / 편집 뷰의 data-* 마커(`data-dirty-form`·`data-dropzone`·`data-menu`) 렌더 검증(⑧)

**신규**(`test/clients-panes.test.js` — contacts-panes 패턴)
- `GET /clients` = 목록만 + 빈 패널(업체/그룹 탭)
- `GET /clients/:id`(업체) = 목록+읽기 뷰: 사업자번호·대표·계산서 이메일·담당자·[편집] 존재, **`data-dirty-form` 없음**(읽기)
- `GET /clients/:id`(그룹) = 소속사·멤버·[편집]
- `GET /clients/:id/edit` = 편집 폼(`data-dirty-form` 있음)+첨부/멤버
- 저장 후 `/clients/:id` 읽기 뷰 복귀, 사람 id → `/contacts` 302
- 반응형 클래스 분기(선택 유무 `hidden lg:block`)

**E2E(실브라우저)**: 1512/1024/900/390 2단·단일 전환·가로 오버플로우 0, 이름 클릭→읽기 뷰→[편집]→저장→읽기 뷰 복귀, 실시간 필터(업체 119·그룹 20), 첨부 '보기'·멤버 표시.

## 위험

| 위험 | 완화 |
|---|---|
| "상세=바로 편집"(2026-07-01) 뒤집기 — 이번엔 clients까지 | 연락처 선례 있음. CLAUDE.md에 근거·범위 명시. 편집 폼은 그대로 이동만(로직 무변경) |
| 프로젝트/청구가 큰 업체는 단일 스크롤이 길어짐 | 빈 섹션 숨김 + 합계 카드 요약. 대부분 소량. 길어지면 후속으로 접이식 검토(지금은 안 함) |
| 첨부/멤버 POST 복귀 경로가 상세→편집으로 바뀜 | 편집 모드 액션이라 편집 뷰 복귀가 맞음. 라우트별로 명시 |
| `contactPanes` 등 contact 이름 재사용의 명명 혼동 | 범용 프리미티브라 그대로 사용. 리네임은 비목표(별도 정리) |
| 새 Tailwind 임의값 클래스 재빌드 전 무시 | 구현 중 `build:css` 후 실측(함정 #27) |
