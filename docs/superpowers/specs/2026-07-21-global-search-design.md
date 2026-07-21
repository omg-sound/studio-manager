# 전역 통합 검색 설계 (2026-07-21)

> 사용자 요청: "아티스트명은 아는데 어느 메뉴인지 모를 때, 메뉴를 먼저 골라 각각 검색해야 한다 → 통합 검색 하나."
> 결정(2026-07-21): **사이드바 상시 + 단축키** · **5개 엔티티 전부** · **엔터 시 전체 결과 페이지**.

## 목표

로그인한 직원이 **한 검색창**에서 프로젝트·연락처·업체·청구·세션을 한 번에 찾아 바로 이동한다. 메뉴를 먼저 고르지 않는다.

## 핵심 원칙 — 있는 것을 조립한다

새로 만드는 것은 **집계 엔드포인트 하나**뿐. 나머지는 전부 재사용:

- **typeahead 드롭다운**: `searchBox({suggestUrl})`(views.js) + app.js IIFE(`[data-search-suggest]`)가 이미 완성 — 타이핑 디바운스·↑↓ 이동·엔터 선택 이동·엔터 무선택 시 폼 제출·IME 가드(#18)·AbortController 취소. **무변경으로 재사용**하되, 카테고리 그룹 헤더만 소폭 확장(아래 §4).
- **엔티티별 조회**: `listProjects(user,{q})`·`listClients({})`·`listContacts({})`·세션 검색은 이미 존재. 각 suggest 엔드포인트(`/projects/suggest` 등)가 `[{label, sub, href}]`를 반환하는 계약도 이미 있음 → 로직을 데이터 레이어로 추출해 공유.
- **청구만 검색 함수 부재** → `searchInvoices(user, q)` 신설(번호·청구처·제목·아티스트 매칭).

## 구성 요소

### 1. 집계 엔드포인트 `GET /search/suggest?q=` (신설)

- `requireAuth`. `q` 없으면 `[]`.
- 5개 엔티티를 각각 조회해 **카테고리별 상위 5건**으로 잘라 합침. 반환 = 평면 배열 `[{cat, label, sub, href}]`, 순서 고정:
  1. `프로젝트` — `listProjects(user,{q})`, sub=아티스트·제작사, href=`/projects/:id`
  2. `연락처` — 사람(parties) 이름/활동명 매칭, sub=역할·소속, href=`/contacts/:id`
  3. `업체·그룹` — `listClients` 이름/활동명, sub=업체/그룹/아티스트, href=`/clients/:id`
  4. `청구` — `searchInvoices`(번호·청구처·제목), sub=청구처·상태, href=`/invoices/:id`
  5. `세션` — 날짜/종류/아티스트 매칭, sub=날짜·종류, href=`/projects/:id?tab=sessions`
- **권한**: 5개 엔티티 모두 전 역할이 접근 가능(프로젝트·세션=전원, 연락처·업체=`requireEditor`=owner/chief/staff 전원, 청구=`canBill`=전원). 매출·자료전달은 엔티티가 아니라 제외 → **결과가 곧 접근 가능**이라 별도 role 필터 불필요(클릭 후 403 없음). 단 새 게이트가 생기면 재검토.
- **재사용**: 각 suggest 라우트의 기존 매핑 로직을 데이터 헬퍼(`searchProjects`/`searchContacts`/`searchClients`/`searchSessions`/`searchInvoices`)로 추출하고, 기존 `/projects/suggest` 등은 그 헬퍼를 호출하도록 리팩터(중복 제거·계약 불변).

### 2. 전체 결과 페이지 `GET /search?q=` (신설)

- `requireAuth`. 같은 5개 집계를 **카테고리당 상위 20건**으로(드롭다운보다 많이).
- 렌더 = 카테고리별 섹션(`listGroup`), 각 섹션 헤더에 카테고리명 + 건수, 각 행은 `label`/`sub`/href. 매칭 0인 카테고리는 섹션 생략. `q` 없거나 전체 0이면 `emptyState`.
- `layout({wide:true})`(목록형). pageHeader title=`"검색: {q}"`.

### 3. 검색창 배치

- **데스크톱 사이드바**: 워드마크(`WORDMARK`, views.js ~279) **아래·`sidebarLinks` 위**에 검색 박스.
  `searchBox({ action:"/search", suggestUrl:"/search/suggest", placeholder:"검색 (⌘K)", ... })`.
  드롭다운은 사이드바 폭(224px)에서 좁으므로 팝오버가 사이드바보다 넓게 뜨도록 확인(app.js 팝오버는 입력 폭 기준 — 필요 시 `min-w` 조정).
- **모바일 상단바**(`sm:hidden` header, views.js ~261): 좁아서 typeahead 부적합 → **검색 아이콘 버튼**을 햄버거 옆에 두고 `GET /search`로 이동(전체 페이지가 자체 검색창 보유). 드로어 안 사이드바 검색창도 그대로 존재(햄버거로 열면 사용 가능).

### 4. app.js 드롭다운 — 카테고리 그룹 헤더 (소폭 확장)

- 현재 app.js typeahead는 `[{label, sub, href}]`를 평면 렌더. `cat` 필드가 있으면 **카테고리가 바뀌는 지점에 그룹 헤더 행**(비선택·muted) 삽입.
- 키보드 ↑↓는 헤더를 **건너뛴다**(선택 가능한 항목만 순회 — 연락처 마스터-디테일 `data-nav-list`가 `<div>` 헤더를 건너뛰는 것과 같은 패턴).
- `cat` 없는 기존 suggest(프로젝트·세션 단일 카테고리)는 헤더 없이 그대로 → **하위 호환**.

### 5. 단축키 (app.js, 신설 IIFE)

- 전역 `keydown`: **⌘K(맥)/Ctrl+K** 또는 **`/`**(입력 포커스 아닐 때) → 사이드바 검색 입력에 포커스(`[data-global-search]` 마커, `preventDefault`).
- IME 조합 중 무시(#18). 입력·textarea·contenteditable에 포커스돼 있으면 `/`는 통과(타이핑 방해 금지), ⌘K는 항상 동작.
- 모바일(터치)엔 단축키 무의미 — 상단바 검색 아이콘으로.

## 데이터 레이어 (신설·추출)

| 헬퍼 | 위치 | 내용 |
|---|---|---|
| `searchInvoices(user, q, limit)` | src/data/invoices.js | `invoice_number`·청구처명(PAYER_DISPLAY_SQL)·`title`·프로젝트 `artist` LIKE, 발행일 최신순 |
| `searchProjects/Contacts/Clients/Sessions` | 각 data 모듈 | 기존 suggest 라우트 로직 추출(계약 `[{label,sub,href}]` 불변) |
| `globalSearch(user, q, {perCat})` | src/data/search.js(신설) | 위 5개를 호출해 `{cat, items}[]` 반환. 라우트 2곳(suggest·page) 공용 |

## 함정·주의

- **CSP**: 서버 렌더·인라인 핸들러 0·app.js 외부. 새 인라인 style/script 금지(#27·⑩).
- **드롭다운 innerHTML 교체 안전**: 결과 행이 링크라 안전(청구 목록 remote와 동일 판단).
- **성능**: 5개 조회를 매 타이핑(디바운스 후) 실행. 각각 상위 5건 LIMIT·인덱스 활용. 프로덕션 규모(당사자 354·프로젝트 107·청구 93)에서 문제없음(단건 렌더 1~5ms 실측). 필요 시 `q` 2자 미만 무시.
- **랭킹**: v1 = 카테고리 고정 순서 + 카테고리 내 기존 정렬(최신/관련). 정확·접두 일치 우선순위는 후속.

## 테스트 (회귀)

- `test/search.test.js`: `globalSearch`가 5개 카테고리 교차 매칭·카테고리별 cap·`searchInvoices` 번호/청구처/제목 매칭·빈 q.
- 라우트: `/search/suggest` JSON 그룹·`/search` 페이지 카테고리 섹션 렌더.
- (선택) jsdom: 단축키 포커스·드롭다운 카테고리 헤더 ↑↓ 건너뜀.

## 범위 밖 (v1)

- 퍼지/오타 보정, 최근 검색어 기록, 검색 결과 하이라이트, 자료전달·매출(엔티티 아님) 검색.

## 파일 변경 요약

- 신설: `src/data/search.js`, `src/routes/search.routes.js`(또는 기존 라우트에 통합), `test/search.test.js`, 이 스펙.
- 수정: `src/data/invoices.js`(searchInvoices), 각 data 모듈(search 헬퍼 추출), `src/views.js`(사이드바 검색창·모바일 아이콘), `public/js/app.js`(카테고리 헤더·단축키), 기존 suggest 라우트(헬퍼 호출로 리팩터), `src/server.js`(라우트 마운트).
