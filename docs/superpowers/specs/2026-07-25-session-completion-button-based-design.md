# 세션 완료 판정을 버튼 기준으로 (작업과 대칭) — 설계

> 2026-07-25 · 완료 안 누른 세션이 날짜만 지나면 자동으로 '진행 중'을 벗어나던 것을, '완료' 버튼 기준으로 통일

## 문제

프로젝트 3탭 분류(`is_completed`)에서 **세션과 작업이 비대칭**이다:
- **작업(곡·콘텐츠)**: 완료 안 누른 작업(`status<>'Completed'`)이 있으면 → `open_tasks>0` → **진행 중**. **버튼 기준** ✅
- **세션**: 완료 버튼과 무관하게 **날짜만 지나면** '다가오는 세션'(`upcoming_cnt` = `session_date >= today AND status='예정'`)에서 빠져 → 진행 중을 벗어남. **날짜 기준** ⚠️

즉 작업은 "완료 눌러야 넘어감"인데 세션만 날짜로 자동 진행된다. 사용자가 완료를 누르지 않은 지난 세션이 프로젝트를 '완료'(또는 '청구 필요')로 밀어낸다 — 사용자 기대("완료 누르기 전엔 진행 중")와 어긋난다.

**사용자 확정 모델**: 완료 안 누른 세션(예정)이 하나라도 있으면 → **진행 중**. 마친 세션을 완료 누르고 청구할 게 있으면 → **청구 필요**. 청구까지 끝나면 → **완료**.

## 근본 원인

`is_completed`(`src/data/projects.js:173`) = `content_cnt > 0 && upcoming_cnt === 0 && open_tasks === 0`. `upcoming_cnt`는 **미래 예정 세션만** 센다(`session_date >= @today AND status='예정'`). 그래서 **지난 예정 세션(완료 안 누름)은 `upcoming_cnt`에 안 잡혀** 프로젝트가 is_completed=true가 된다.

## 설계

### 핵심: `is_completed` 게이트를 `upcoming_cnt` → `sess_scheduled`로

`listProjects`에는 이미 **`sess_scheduled`**(`src/data/projects.js:113`, `COUNT(sessions WHERE status='예정')` — **날짜 무관**)가 파생돼 있다. 이걸 재사용한다(새 컬럼 불필요):

```js
// 현재
is_completed: r.content_cnt > 0 && r.upcoming_cnt === 0 && r.open_tasks === 0,
// 변경
is_completed: r.content_cnt > 0 && r.sess_scheduled === 0 && r.open_tasks === 0,
```

`sess_scheduled === 0` = "예정 세션이 하나도 없음" = 모든 세션이 완료 또는 취소. 즉 **완료 안 누른 세션(예정)이 있으면 진행 중** — 작업의 `open_tasks`와 대칭.

- 미래 예정 세션 → `sess_scheduled>0` → 진행 중 (변화 없음).
- **지난 예정 세션(완료 안 누름) → `sess_scheduled>0` → 진행 중** (전엔 완료/청구필요로 샜음).
- 전부 완료/취소 + 작업도 끝남 → 완료 판정 가능.

**취소 세션은 안 센다**(`status='예정'`만) — 끝난 활동이므로 진행을 막지 않는다.

### `upcoming_cnt`·`next_session_date`는 유지

진행 중 탭 '다가오는 세션 임박순' 정렬과 다음 세션 표시에 계속 쓴다. **게이트만** `sess_scheduled`로 바꾼다. (지난 예정 세션만 가진 프로젝트는 `next_session_date=null`이라 진행 중 정렬에서 뒤로 간다 — 정상.)

### postprod 항·헬퍼 단순화 (2026-07-24 기능 정제)

2026-07-24에 넣은 `unbilled_cnt` 후반작업 항과 `hasPostprodSessionNeedingBilling` 헬퍼의 날짜 게이트 `(status='완료' OR session_date < @today)`에서 **`OR session_date < @today`를 제거** → **`status='완료'`만**.

- 이유: 지난 예정 믹싱 세션은 이제 `sess_scheduled>0`이라 **진행 중에 머문다**(is_completed=false). 그러면 billing/done 분기 자체가 적용 안 되고, 게다가 그 상태에서 '청구 필요 N' 배지가 뜨면(07-23 규칙: unbilled_cnt>0이면 어느 탭에서든 배지) **완료도 안 누른 세션에 청구 배지**가 뜨는 모순이 된다. `status='완료'`만 트리거하면 이 모순이 사라진다.
- **여전히 필요**: "믹싱 세션 완료 눌렀는데 곡·콘텐츠 작업 0 → 청구 필요"(2026-07-24 수정의 본질)는 그대로 동작한다.

### 동작 요약

| 세션 상태 | 프로젝트 위치 |
|---|---|
| 예정(미래·지난 무관, 완료 안 누름) | **진행 중** |
| 완료 + 청구할 것 있음(작업 미청구 or 완료 믹싱 세션+작업0) | 청구 필요 |
| 완료 + 청구까지 끝남 | 완료 |
| 취소 | 진행 막지 않음(끝난 활동) |

세션 상태 자체는 **자동으로 안 바뀐다** — 완료 안 누르면 계속 '예정' 표시(분류만 이 상태를 반영).

## 범위 경계 (안 바꾸는 것)

- `upcoming_cnt`·`next_session_date` 정의·소비처(진행 중 정렬·다음 세션 표시·대시보드 '오늘·이번 주 세션') 불변.
- 대시보드 '청구 필요' 카드는 `unbilled_cnt`(완료 여부 무관) 기반이라 직접 영향 없음.
- 대관(녹음·촬영·공연) 세션 청구 흐름 불변 — 지난 예정 대관 세션도 같은 규칙으로 진행 중에 머물고(청구 필요 배지는 뜸), 청구하면 자동 완료 전환(07-23) 그대로.
- `open_tasks`·작업 분류 로직 불변.

## 기존 데이터

**마이그레이션 없음**(파생 분류라 배포 즉시 자동 재계산). 단 **완료 안 누른 지난 세션을 가진 기존 프로젝트가 '완료/청구 필요' → '진행 중'으로 이동**(눈에 보이는 재분류). 사용자 감수 확정 — 잘못이 아니라 '완료 안 눌렀으니 진행 중'으로 교정.

## 검증(회귀)

`test/billing-radar.test.js`(또는 `project-list.test.js`)에 추가:
1. **지난 예정 세션(완료 안 누름) + 작업 없음** → `is_completed=false` → `splitProjectTabs` **진행 중**(전엔 완료).
2. **그 세션 완료 처리** → `is_completed=true`, 믹싱이면 후반작업 항으로 **청구 필요** / 대관이면 unbilled 세션으로 청구 필요.
3. **미래 예정 세션** → 진행 중(회귀 불변).
4. **postprod 항: 지난 예정 믹싱 세션은 미가산**(status='완료' 아니므로) — `unbilled_cnt=0`(진행 중이라 배지도 안 뜸). **완료 처리하면 가산** → 청구 필요.
5. **취소 세션만** → 진행 막지 않음(완료 판정 가능, 작업 조건 충족 시).
6. 기존 billing-radar·project-list 케이스 회귀 불변(단, 2026-07-24 postprod 테스트 중 '지난 예정' 전제를 쓰던 것이 있으면 '완료' 전제로 갱신 — 구현 시 확인).

## 파일

- `src/data/projects.js` — `is_completed` 파생(`upcoming_cnt`→`sess_scheduled`) + postprod 항 날짜 게이트 제거 + `hasPostprodSessionNeedingBilling` 날짜 게이트 제거.
- `test/billing-radar.test.js` — 회귀 케이스.
- `CLAUDE.md` — 완료 판정 서술 현행화(세션도 버튼 기준·작업과 대칭).

## 열린 결정(없음)

방향·기존 데이터 이동 감수 사용자 승인 완료. 정밀 설계(sess_scheduled 재사용·postprod 단순화) 확정.
