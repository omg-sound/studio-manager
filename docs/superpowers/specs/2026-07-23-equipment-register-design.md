# 장비 대장 (Equipment Register) — 설계 문서

- 날짜: 2026-07-23
- 상태: 승인됨 (사용자 확인 후 구현 대기)
- 관련: CLAUDE.md 제품 정체성 경계(재고/구매) 갱신 포함

## 배경·목적

스튜디오가 **보유·운용하는 장비**(마이크·프리앰프·아웃보드·모니터·악기 등)를 대장으로 관리한다.
"무엇을, 얼마에, 언제 샀고, 지금 어디 있나"를 한눈에 본다.

**판매 재고가 아니다.** 사용자 명시("물건을 파는 곳은 아니다"). 입출고·재주문·매출원가 같은 stock-flow는
범위 밖(CLAUDE.md에 이미 "재고/구매 = 범위 밖"으로 기록). 이번에 추가하는 건 **참조용 자산 대장**으로,
연락처·업체처럼 마스터데이터 목록에 가깝다 — 이 앱의 경량 사내 시스템 결과 맞다.

## 범위 (사용자 확정)

- **가벼운 대장**: 목록 + 필드 + 검색 CRUD만. 이동 이력·유지보수·감가상각은 **범위 밖**(나중에 필요하면 확장).
- **장소 = 단일 텍스트 필드**: 룸 제안 + 자유 입력을 한 칸에.
- **종류(category) 필드 포함**: 목록을 종류별 그룹으로 묶는다.
- **권한 = 전원**(대표·치프·스태프) 열람·편집. 매입가도 내부 공유(외부 비공개).
- **삭제 중심**: 하드 삭제(이 앱 철학). 장비는 청구·정산에 안 엮여 참조 잠금 걱정 없음.

## 데이터 모델

새 테이블 하나. `rooms`·삭제 중심 관리 철학을 따른다.

```sql
CREATE TABLE IF NOT EXISTS equipment (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  name           TEXT NOT NULL,                 -- 장비명 (예: "Neumann U87") — 유일 필수
  category       TEXT,                          -- 종류 (자유 텍스트: 마이크·프리앰프·아웃보드…). 비면 '미분류'
  serial_no      TEXT,                          -- 제품/시리얼 번호
  purchase_price INTEGER,                       -- 매입가 (정수·원). 모르면 NULL
  purchased_on   TEXT,                          -- 구매 시기 ('YYYY-MM-DD', 날짜만). 모르면 NULL
  location       TEXT,                          -- 현재 장소 (단일 텍스트 — 룸 이름 또는 자유). 비면 '장소 미지정'
  memo           TEXT,
  created_at     TEXT NOT NULL DEFAULT (datetime('now'))
);
```

**필드 필수/선택**: `name`만 필수. 나머지 전부 선택(오래된 장비는 매입가·구매일을 모를 수 있음).

**장소 모델(핵심 결정)**: `room_id` FK가 아니라 **단일 `location` TEXT**(사용자 결정 — 한 필드에 룸/자유 둘 다).
- 트레이드오프(수용): 텍스트라 **룸 개명 시 저장된 "A룸"은 자동으로 안 바뀐다**. 가벼운 대장이고 룸 개명은
  드물어 수용. (FK로 안 하는 이유 = 사용자가 "한 필드" 명시 + 창고·수리 중·외부 대여 같은 비-룸 장소도 자유롭게.)
- 표기 흔들림 방지: 입력 시 **룸 이름을 제안**해 골라 넣게 유도(아래 UI). 룸은 골라 넣으니 "A룸" 표기가 일정 →
  "A룸에 있는 장비" 텍스트 일치 집계가 성립. 자유 장소(창고 등)는 그 텍스트 그대로.

**종류(category)**: 관리하는 카탈로그로 만들지 않는다(그건 무겁다). 자유 텍스트 + 입력 시 **기존 값 제안**(자동완성).
목록은 이 값으로 그룹핑.

## 화면·입력 (한 화면)

### 목록 `GET /equipment`
- **종류별 그룹**으로 묶어 표시(사용자 확정). 그룹 헤더 = 종류명(비면 "미분류"), 그 아래 장비 행들.
- 각 행: 장비명 · 종류(맥락상 그룹 헤더에 있으니 행엔 생략 가능) · 장소 · 매입가 · 구매일.
- **검색 = 실시간 필터**(타이핑 즉시, 서버 왕복 없음): 장비명·종류·시리얼·장소 매칭. 이 앱 `liveFilter` 패턴 재사용.
- 넓은 목록이라 `layout({wide:true})` 후보(구현 시 실측으로 확정).

### 추가/편집 폼
- 필드: 장비명 · 종류 · 시리얼 · 매입가 · 구매일 · 장소 · 메모.
- **매입가** = 공용 금액 포맷(콤마 자동·정수 원, `data-line-input` 계열 아님 — 단순 금액칸. app.js MONEY 정규식 매칭되게 `name`에 금액성 키).
- **구매일** = 공용 `dateCombo`.
- **종류** = 자유 텍스트 + 기존 종류값 제안(칩 또는 간단 제안).
- **장소** = 단일 텍스트 입력 + **제안 칩**: 기존 룸 이름(`listRooms`) + 이미 쓰인 장소값(distinct `equipment.location`)을
  클릭하면 입력칸에 채워진다(CSP-safe, datalist 안 씀 — 가드레일 ② 회피, 새 콤보 인프라 불필요).
- **dirty 저장 가드**(`data-dirty-form`) — 이 앱 폼 공통.

### 삭제
- 하드 삭제(`POST /equipment/:id/delete`). 참조 잠금 없음(장비는 청구·정산 비연결).
- 삭제는 감사 로그(`equipment.delete`) 기록 — 파괴적 액션 기록 관례.

## 권한·네비게이션

- 라우트 전부 `requireEditor`(대표·치프·스태프). NAV `access: "editor"`.
- 사이드바 **'관리' 그룹**에 새 메뉴 **`장비`**, 환경설정 앞. `navKey: "q"`(eQuipment — 미사용 문자).
- 아이콘 = 장비 느낌의 SVG(예: 슬라이더/박스).

## 파일 구성

- `src/data/equipment.js` — 신설. `listEquipment({q})`(종류별 그룹 파생 or 라우트가 그룹핑),
  `getEquipment(id)`, `createEquipment(b)`, `updateEquipment(id, b)`, `deleteEquipment(id)`,
  `equipmentLocationSuggestions()`(룸 이름 + distinct location), `equipmentCategorySuggestions()`(distinct category).
- `src/data.js` — 재export.
- `src/views.equipment.js` — 신설. `equipmentList(rows, {q})`(종류별 그룹), `equipmentForm(item, {rooms, categories, locations})`.
- `src/routes/equipment.routes.js` — 신설. GET 목록 / GET·POST 추가 / GET·POST 편집 / POST 삭제.
- `src/db.js` — CREATE TABLE equipment(신선 DB) + 1회 마이그레이션 게이트(기존 DB).
- `src/views.js` NAV — `{ href:"/equipment", label:"장비", key:"equipment", navKey:"q", access:"editor", group:"manage" }` + 아이콘.
- `src/server.js` — 라우터 마운트(정적 라우트라 순서 무관, `express.static` 앞).

## 정체성 경계 갱신 (CLAUDE.md)

제품 정체성 '의도적으로 안 지는 무게(경계)'의 "재고/구매" 문구를 명확화:
> ~~재고/구매~~ → **판매 재고·구매발주(입출고·재주문·매출원가) = 범위 밖. 단 보유 장비 대장(자산 참조 목록)은 포함**(2026-07-23).

이유: 이번 추가는 stock-flow(판매 재고)가 아니라 참조용 자산 대장이라, 경량 버티컬 정체성과 충돌하지 않는다.
경계는 여전히 유효하다 — 우리는 물건을 팔지 않고 입출고를 관리하지 않는다. 보유 장비 목록만 참조로 든다.

## 검증

- `test/equipment.test.js` — 데이터 레이어: CRUD, 종류별 그룹(미분류 포함), 장소·종류 제안(룸+기존값·중복 제거),
  검색 필터, name 필수(빈 이름 거부), 금액·날짜 파싱, 삭제.
- `test/equipment-views.test.js` — 뷰 계약: 목록이 종류별로 묶여 렌더(그룹 헤더·미분류), 폼 필드 존재,
  장소 제안 칩 렌더, 삭제 폼, 금액칸 name이 MONEY 정규식 매칭.
- 스모크(`test/smoke.test.js`) — `/equipment` 200 + editor 권한 배선(대표·치프·스태프 통과) 매트릭스에 추가.
- 실서버 E2E — 장비 등록 → 목록 종류별 표시 → 장소 수정 → 삭제(감사 로그) → 검색 필터.

## 명시적으로 범위 밖 (YAGNI)

이동 이력(타임라인) · 유지보수/수리 로그 · 보증 만료 · 감가상각/장부가 · 사진/영수증 첨부 ·
수량(qty>1, 동일 모델 여러 대는 개별 행으로) · 세션↔장비 연결 · QR/바코드. 필요 시 별도 스펙.
