# 카카오톡 청구 발행 알림 — 설계

- 작성일: 2026-07-13
- 상태: 승인됨(설계) → 구현 계획 대기
- 관련 코드: `src/notify.js`, `src/routes/settings.routes.js`, `src/views.settings.js`, `src/routes/maintenance.routes.js`, `src/routes/auth.routes.js`(콜백)

## 1. 목적 · 한 줄 요약

청구 탭에서 **청구가 생성(발행)되는 순간**, 스튜디오가 지정한 **카카오 계정 한 곳**으로 카카오톡 알림을 보낸다. 대표가 슬랙·디스코드를 쓰지 않아 카카오톡을 알림 채널로 쓴다.

## 2. 확정된 결정 (브레인스토밍 결과)

| 항목 | 결정 |
|---|---|
| 채널 | 카카오 **"나에게 보내기"**(memo API `/v2/api/talk/memo/default/send`). 무료·템플릿 사전승인 불필요·토큰 소유자 본인에게 발송 |
| 수신자 | 앱을 카카오로 **인증한 그 계정**(스튜디오 전체 **1개**, admin_state 저장). 당분간 **치프**가 자기 카카오로 연동 |
| 수신자 변경 | 관리에서 `[연동 해제]` 후, 받을 사람이 **자기 카카오로** 다시 연동(본인이 직접 로그인해야 함 — send-to-me 제약) |
| 트리거 | 기존 `notifyInvoiceIssued` 훅(청구 탭 from-tasks 생성 = 발행). **파생 상태 트리거 신설 없음** |
| 범위 | 카카오는 **`invoice_issued` 이벤트만**. 자료 공유·연체는 카카오로 안 보냄(웹훅 경로는 무변경) |
| 토큰 | 자동 갱신(드라이브·캘린더와 동일 AES-256-GCM 저장·서버 자동 갱신). 일일 cron keep-alive로 침묵 기간에도 유지 |

### 명시적으로 범위 밖(YAGNI)

- 알림톡(사업자 채널·대행사·템플릿 승인·건당 과금) — 여러 명 수신이 필요해지면 그때 검토.
- 여러 명 동시 수신 — send-to-me는 1명 한계. 지금 요구는 1명이라 채택하지 않음.
- '청구 필요 진입'(파생 상태) 알림 — 사용자가 '청구 생성 시'를 택함. cron diff 트리거는 만들지 않는다.
- 카카오로 자료 공유·연체 알림 — 범위에서 제외.

## 3. 아키텍처

카카오를 **독립 연동 모듈**로 두고(`drive.js`·`calendar.js`·`people.js`와 같은 격), **`notify.js` 디스패치가 `invoice_issued`에서만 카카오로 라우팅**한다. 웹훅은 그대로 두고 카카오를 나란히 추가 → 기존 알림 흐름 무변경.

### 3.1 모듈 · 책임

- **`src/kakao.js`** (신규) — 카카오 연동 자기완결 모듈.
  - `getAuthUrl(state)` — 카카오 인증 URL 조립(scope `talk_message`).
  - `exchangeCode(code)` — 인가 코드 → 액세스+리프레시 토큰 교환, 프로필(닉네임) 조회, admin_state에 암호화 저장.
  - `getAccessToken()` — 저장된 액세스 토큰 반환. 만료(또는 근접)면 리프레시로 자동 갱신. 갱신 실패(`invalid_grant`)면 연동 만료 처리 후 null.
  - `sendToMe({ text, url, buttonTitle })` — 텍스트 템플릿으로 "나에게 보내기". fail-safe(throw 없음), 미연동·토큰 없음이면 skip.
  - `getLinkStatus()` — `{ linked, nickname, linkedAt, expired }` (설정 표시용).
  - `disconnect()` — 저장 토큰·닉네임 삭제(카카오 unlink API 호출은 best-effort).
  - `keepAlive()` — 액세스 토큰 강제 갱신(일일 cron용). 리프레시 회전 시 새 토큰 저장.
  - cross-domain: `db`(encrypt/decrypt·admin_state)·`config`(baseUrl·키)만 의존. 다른 도메인 함수 호출 없음(모듈 자기완결).

- **`src/notify.js`** (수정) — 디스패치에 카카오 타깃 추가.
  - `notify(event)`가 웹훅 전송(기존) 후, `event.type === "invoice_issued"`이면 `kakao.sendToMe(...)`도 호출.
  - `notifyInvoiceIssued(inv)`가 만드는 이벤트 필드를 카카오 텍스트 템플릿으로 변환하는 `formatKakaoText(event)` 인라인 포매터(뷰 레이어 비의존).
  - 카카오 호출도 fail-safe·비차단(`notifyAsync` 경로 안에서 흡수).

- **`src/routes/auth.routes.js`** (수정) — 카카오 인증 시작·콜백.
  - `GET /auth/kakao` — state 랜덤 논스 생성 + httpOnly 쿠키 저장 → 카카오 인증으로 리다이렉트(구글 OAuth 논스 패턴 재사용). requireChief.
  - `GET /auth/kakao/callback` — 쿠키 state 대조(CSRF 방어) → `kakao.exchangeCode(code)` → `/settings`로 복귀(성공/실패 flash). requireChief.
  - **로그인과 별개**: 앱 로그인 세션을 바꾸지 않는다(`/auth/google?drive=1`이 드라이브만 인증하는 것과 동일).

- **`src/routes/settings.routes.js` + `src/views.settings.js`** (수정) — 관리 > 환경설정 알림 그룹에 "카카오 알림(청구 발행)" 섹션.
  - 미연동: `[카카오로 연동하기]`(→ `/auth/kakao`) + 안내.
  - 연동됨: "현재 수신: {닉네임}" + `[연동 해제]`(`POST /settings/kakao/disconnect`) + `[테스트 알림 보내기]`(`POST /settings/kakao/test`).
  - 연동 만료(갱신 실패): "⚠️ 연동 만료 — 재연동 필요" + 재연동 버튼.
  - requireChief(웹훅과 동일 — 외부 발송 경로라 민감).

- **`src/routes/maintenance.routes.js`** (수정) — 일일 cron(`/internal/cron/daily`)에 `kakao.keepAlive()` 추가(fail-safe·비차단).

### 3.2 환경변수 (사전 준비)

| 키 | 용도 |
|---|---|
| `KAKAO_REST_API_KEY` | 카카오 디벨로퍼스 앱 REST API 키(필수). 미설정 시 연동 버튼 비활성 + "미설정" 안내 |
| `KAKAO_CLIENT_SECRET` | (선택) 카카오 앱에서 client secret 사용 시 |

redirect URI는 `config.baseUrl` + `/auth/kakao/callback`으로 도출(Render는 `RENDER_EXTERNAL_URL` 자동).

## 4. 데이터 흐름

### 4.1 연동 (치프가 1회)

1. 관리 > 환경설정 > 카카오 알림 `[연동하기]` 클릭 → `GET /auth/kakao`.
2. state 논스 생성 + httpOnly 쿠키 저장 → 카카오 인증 페이지로 리다이렉트(scope `talk_message`, redirect_uri = baseUrl+/auth/kakao/callback).
3. 치프가 **자기 카카오로 로그인** + 메시지 동의 → 카카오가 `/auth/kakao/callback?code=…&state=…`로 복귀.
4. 콜백: 쿠키 state 대조(불일치 시 거부) → `exchangeCode`가 토큰 교환 + 프로필 닉네임 조회 → admin_state에 저장:
   - `kakao_refresh_token`(암호화), `kakao_access_token`(암호화), `kakao_access_expires_at`(ISO), `kakao_nickname`(평문·표시용), `kakao_linked_at`.
5. `/settings?notice=카카오 연동 완료`로 복귀.

### 4.2 발송 (청구 생성 시)

1. 청구 탭 from-tasks 청구 생성 → 라우트가 `notifyInvoiceIssued(inv)` 호출(**기존 동작·무변경**).
2. `notify` 디스패치:
   - (a) 웹훅 전송(기존).
   - (b) `event.type === "invoice_issued"` → `kakao.sendToMe({ text: formatKakaoText(event), url: {baseUrl}/invoices/{id}, buttonTitle: "청구서 보기" })`.
3. `sendToMe`: 연동 안 됐으면 조용히 skip. 연동됐으면 `getAccessToken()`(만료면 자동 갱신) → 카카오 memo API POST → 실패해도 흡수(청구 생성 무영향).

### 4.3 토큰 갱신

- 발송 직전 `getAccessToken()`이 `kakao_access_expires_at`을 보고 만료(또는 5분 이내 근접)면 리프레시 토큰으로 갱신.
- 카카오가 리프레시 토큰을 회전(남은 유효기간 1개월 미만일 때)하면 새 값 저장.
- 갱신 실패(`invalid_grant` = 사용자 해제 or 리프레시 만료): 저장 토큰 무효 표시(`kakao_expired=1`) → 설정에 "재연동 필요" 노출. throw 없음.
- 일일 cron `keepAlive()`: 하루 1회 강제 갱신 → 청구가 오래 없어도 리프레시 토큰이 2개월 안에 계속 연장돼 안 죽음.

## 5. 메시지 형식

카카오 "나에게 보내기" **텍스트 템플릿**(`template_object`):

- `object_type: "text"`
- `text`(≤ 200자): 여러 줄 조립 후 초과 시 절단.
  ```
  🧾 청구 발행
  OMG-202607-003
  ₩1,100,000 · (주)월간윤종신
  프로젝트: 루나 1집 - 타이틀곡 '월광'
  ```
- `link: { web_url, mobile_web_url }` = `{baseUrl}/invoices/{id}`
- `button_title: "청구서 보기"`

`formatKakaoText(event)`가 `notifyInvoiceIssued`의 기존 필드(`title`·`text`·`fields[프로젝트]`)를 위 문자열로 변환. baseUrl 없으면 링크·버튼 생략(텍스트만).

## 6. 오류 처리 (전부 fail-safe)

- **미연동**: `sendToMe`가 조용히 skip(정상 흐름, 오류 아님).
- **`KAKAO_REST_API_KEY` 미설정**: 연동 버튼 비활성 + "미설정" 안내. 발송 경로는 skip.
- **토큰 갱신 실패**: 연동 만료 표시 + 설정 재연동 안내 + `console.warn`. 청구 생성 무영향.
- **카카오 API 오류(4xx/5xx·네트워크)**: `console.warn`으로 로그, throw 없음, 청구 생성 무영향.
- **SSRF**: 불필요(카카오 고정 호스트 `kauth.kakao.com`·`kapi.kakao.com`, 사용자 입력 URL 아님).
- **CSRF**: 콜백 state 논스+httpOnly 쿠키 대조(구글 OAuth와 동일).

## 7. 테스트 (실제 카카오 호출은 mock — 기존 notify 테스트 방식)

- **단위**:
  - `formatKakaoText(event)`: 필드 조립·200자 절단·버튼 url·baseUrl 없을 때 링크 생략.
  - 토큰 갱신 판정: 만료/근접이면 갱신 시도, 유효하면 그대로.
  - 디스패치 라우팅: `invoice_issued`는 카카오 호출, `deliverable_shared`는 카카오 미호출(웹훅만).
  - fail-safe: `kakao.sendToMe`가 throw해도 `notify`/`notifyInvoiceIssued`는 정상 반환(청구 생성 무영향).
  - 갱신 실패(`invalid_grant`) → 만료 표시, throw 없음.
- **연동 상태 표시**: `getLinkStatus`가 미연동/연동됨(닉네임)/만료를 정확히 반환.
- 실제 OAuth·발송은 사용자 사전작업(카카오 앱 등록) 후 수동 확인. 로컬 테스트는 fetch mock.

## 8. 사전 준비 (대표/치프가 1회 — 구글 OAuth 설정과 동일 격)

1. 카카오 디벨로퍼스(developers.kakao.com)에서 애플리케이션 등록 → **REST API 키** 확보.
2. 카카오 로그인 활성화 + Redirect URI 등록: `{BASE_URL}/auth/kakao/callback`(로컬·프로덕션 각각).
3. 동의항목에서 **카카오톡 메시지 전송(`talk_message`)** 활성화(비즈 앱 전환 없이 "나에게 보내기"는 개인 개발자 앱에서도 가능).
4. Render env에 `KAKAO_REST_API_KEY`(필요 시 `KAKAO_CLIENT_SECRET`) 설정.
5. 배포 후 관리 > 환경설정 > 카카오 알림에서 `[연동하기]`로 인증 + `[테스트 알림 보내기]`로 확인.

## 9. 미해결 · 후속

- 카카오 개인 개발자 앱의 "나에게 보내기" 일일 쿼터(무료 한도)는 청구 발행 빈도상 문제없을 것으로 보이나, 실제 앱 등록 후 한도 재확인.
- 여러 명 수신·아무 번호 발송이 필요해지면 알림톡(대행사) 별도 설계(현재 범위 밖).
