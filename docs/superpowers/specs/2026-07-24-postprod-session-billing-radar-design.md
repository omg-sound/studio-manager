# 믹싱/마스터링 세션 청구 레이더 — 설계

> 2026-07-24 · 세션만 마친 후반작업 프로젝트가 '완료'로 새는 문제

## 문제

믹싱 세션은 완료 처리했지만 곡·콘텐츠 탭에서 **작업/금액을 아직 안 만든** 프로젝트가 **'완료' 탭으로 직행**한다(실사례: 허영생·해로이키 믹스). 사용자 기대는 "청구까지 끝나야 완료"인데, 세션 한 번 마쳤을 뿐인 프로젝트가 완료로 간다.

## 근본 원인

프로젝트 3탭 분류(`src/data/projects.js` `listProjects`·`splitProjectTabs`):
- `is_completed` = 다가오는 예정 세션 없음(`upcoming_cnt=0`) AND 미완료 작업 없음(`open_tasks=0`) AND 활동 있었음(`content_cnt>0`).
- 탭 배정 = `is_completed && unbilled_cnt>0` → **청구 필요**, `is_completed && unbilled_cnt===0` → **완료**.
- `unbilled_cnt`(현재)= 미청구 작업 + **대관(녹음·촬영·공연) 세션**. **믹싱·마스터링 세션은 세지 않는다** — 설계상 후반작업은 세션이 아니라 곡·콘텐츠 '작업'으로 청구하기 때문(`RENTAL_SESSION_TYPES = ["녹음","촬영","공연"]`).

→ **믹싱 세션만 완료 + 작업 0건**: `is_completed=true`(세션 끝남), `unbilled_cnt=0`(믹싱 세션은 집계 대상 아님·작업 없음) → **완료 탭**. 시스템이 "청구할 게 없음 = 끝남"으로 오독.

코드 주석은 이미 `done = 청구까지 끝난 아카이브`라고 적혀 있다 — **설계 의도는 사용자 생각과 같다**. 버그는 `unbilled_cnt=0`이 "청구 끝남"과 "청구할 게 아직 안 만들어짐"을 구분 못 하는 것.

이 결함은 2026-07-23 '단가 미선택 대관 세션이 조용히 완료로 넘어가던' 버그와 **동일 클래스**다(그땐 대관 세션, 이번엔 후반작업 세션). 같은 원칙으로 고친다: **청구가 필요한데 아직 산정/생성이 안 됐을 뿐이면 여전히 '필요'하다. 진짜 안 받을 거면 waived가 탈출구.**

## 설계

### 핵심: `unbilled_cnt`에 '후반작업 청구 미착수' 항 추가

`listProjects`의 `unbilled_cnt` 파생에 항을 하나 더한다:

> **완료됐거나 지난(예정 미래 제외)·미취소·미waived 믹싱/마스터링 세션이 있고, 프로젝트에 청구 준비가 하나도 없으면**(곡·콘텐츠 작업 0건 **AND** 청구서 0건) → **+1**.

- **세션 개수가 아니라 '착수 여부' 플래그**(EXISTS→1). 후반작업 세션은 청구 '라인'이 아니라 "청구를 아직 시작 안 함"이라는 프로젝트 단위 신호이므로, 여러 개여도 +1(대관 세션은 라인이라 개별 카운트 유지 — 성격이 다름).
- **예정(미래) 세션은 제외**: `status='완료' OR session_date < @today`. 아직 안 한 믹싱 예약이 조기에 '청구 필요'로 뜨는 것 방지.

SQL 스케치(정확한 형태는 구현 계획에서, `@today`는 기존 쿼리에 이미 있음):

```sql
+ (CASE WHEN EXISTS (
    SELECT 1 FROM sessions s
     WHERE s.project_id = p.id
       AND s.session_type IN ('믹싱','마스터링')
       AND s.status <> '취소' AND s.waived = 0
       AND (s.status = '완료' OR s.session_date < @today)
       AND NOT EXISTS (SELECT 1 FROM track_tasks t2 JOIN project_tracks tr2 ON tr2.id=t2.track_id
                        WHERE tr2.project_id = p.id)
       AND NOT EXISTS (SELECT 1 FROM invoices i2 WHERE i2.project_id = p.id)
  ) THEN 1 ELSE 0 END)
```

### 동작(사용자 흐름과 정합)

- **세션만 하고 아무것도 안 만듦** → `unbilled_cnt>0` → **청구 필요**(완료로 안 감). ← 해결.
- **곡·콘텐츠 작업을 만들면** → `NOT EXISTS task`가 거짓 → 후반작업 항 자동 **꺼짐**. 이후는 **작업 기반 분류가 이어받음**(미청구 작업이면 청구 필요·다 청구되면 완료). 사용자 실제 흐름(세션 → 나중에 작업+금액 → 청구)과 정확히 맞음.
- **무료 처리** → 곡·콘텐츠 작업을 만든 뒤 **'청구 안 함'**(기존 task waive 버튼) → 작업 존재로 후반작업 항 꺼지고 waived로 작업 항도 0 → **완료**. 별도 세션 waive UI 불필요(기존 흐름 재사용).
- **수동 청구서로 청구** → `NOT EXISTS invoice`가 거짓 → 항 꺼짐(이미 청구함).

### UI 안내(1줄)

이런 프로젝트의 **청구 탭**을 열면 청구 후보가 비어 보인다(믹싱 세션은 라인이 아니고 작업이 없으므로). 그 이유를 알려준다:

> "믹싱/마스터링 세션이 있습니다. **곡·콘텐츠 탭에서 작업을 만들어** 청구하세요(무료면 작업을 만든 뒤 '청구 안 함')."

- 위치: `unbilledInvoiceForm`(`src/views.projects.js:798`). 청구 탭 라우트가 '완료·미waived 후반작업 세션 존재' 플래그를 전달하고, **청구 후보(작업·세션)가 하나도 없을 때만** 이 안내를 렌더.

## 범위 경계(안 바꾸는 것)

- **`is_completed` 판정 불변** — 세션은 끝난 게 맞다. 바꾸는 건 **탭 배정(`unbilled_cnt`)뿐**.
- **믹싱/마스터링 세션은 여전히 청구 후보 목록·청구 폼에 직접 라인으로 안 뜬다**(`listBillableSessionsForProject`·`computeInvoiceDraft` 불변). 단가 항목도 안 붙인다. 후반작업은 작업으로 청구하는 설계 유지.
- **대관 세션(녹음·촬영·공연) 07-23 로직 불변**.
- 대시보드 '청구 필요' 카드·목록 '청구 필요 N' 배지는 `unbilled_cnt`를 그대로 소비하므로 자동 반영(별도 변경 없음).

## 검증(회귀)

`test/billing-radar.test.js`에 케이스 추가:
1. **믹싱 세션 완료 + 작업 0 + 청구서 0** → `unbilled_cnt>0` → `splitProjectTabs`에서 **청구 필요**(완료 아님).
2. **곡·콘텐츠 작업 생성** → 후반작업 항 꺼짐(작업 존재) → 작업 미청구면 청구 필요·작업이 유일 신호.
3. **작업 생성 후 '청구 안 함'(waive)** → `unbilled_cnt===0` → **완료**.
4. **예정(미래) 믹싱 세션만** → 항 미가산(조기 '청구 필요' 방지) → 그 프로젝트는 `is_completed=false`라 진행 중(회귀 확인).
5. **대관 세션 로직 불변** — 기존 케이스 전부 통과.
6. (뷰 계약) `unbilledInvoiceForm` 후보 0 + 후반작업 플래그 → 안내 문구 렌더 / 후보 있으면 미렌더.

## 파일

- `src/data/projects.js` — `listProjects` unbilled_cnt SQL에 항 추가.
- `src/views.projects.js` — `unbilledInvoiceForm` 안내 문구 + 호출 라우트(`src/routes/projects.routes.js` 청구 탭)에서 플래그 전달.
- `test/billing-radar.test.js` — 회귀 케이스.

## 열린 결정(없음)

브레인스토밍에서 방향·해제 semantics(작업/청구서 생기면 자동 해제) 사용자 승인 완료.
