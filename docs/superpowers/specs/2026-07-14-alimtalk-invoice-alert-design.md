# 청구 발행 알림톡(AlimTalk) 전환 — 설계

> 2026-07-14 · 카카오 '나에게 보내기'(2026-07-13 구현)를 **알림톡**으로 컷오버.
> 결정 근거: 나에게 보내기는 '나와의 채팅'(=메모장)으로 가서 **푸시 인지가 약하다**(사용자 판단).
> 알림톡은 채널에서 오는 정식 메시지라 일반 채팅처럼 푸시·소리·뱃지가 뜬다.

## 1. 목적과 범위

**하는 것**: 청구 발행(프로젝트 청구 탭 → 청구 생성) 시, 앱 로그인 계정 중 **'청구 알림 받기'가 켜진 내부 직원**의 휴대폰으로 알림톡을 보낸다.

**안 하는 것(의도적 제외)**
- 클라이언트(외부) 발송 — 내부 직원 전용(사용자 결정). 나중에 필요해지면 수신자 해석부만 확장.
- SMS 대체 발송 — 실패는 로그·경고로만 드러낸다(`disableSms: true`). 발신번호 사전등록·SMS 단가·문구 관리를 스코프에서 뺀다.
- 연체·자료 공유 등 다른 이벤트 — 알림톡은 **`invoice_issued` 하나만**. 기존 웹훅 채널은 그대로 유지(전 이벤트).

**제거**: 카카오 '나에게 보내기' 구현 전체(§6).

## 2. 선행 관문(사용자 작업 — 코드와 병렬)

코드는 심사와 무관하게 완성할 수 있고, 아래가 끝나면 **관리 화면에서 pfId·templateId만 입력하면 활성화**된다(재배포 불필요).

1. 카카오 **비즈 앱 전환**(사업자등록증) — 앱 소유 계정 = **studio@omgworks.kr**(사용자 결정)
2. **카카오톡 채널 개설**(같은 계정)
3. **솔라피(SOLAPI) 가입** → 채널 연동 → **발신프로필 `pfId`** 발급
4. **템플릿 등록·심사**(1~3영업일) → **`templateId`** 발급 — 문안 §5
5. 솔라피 잔액 충전(알림톡 건당 10원 안팎, 월 수백 원 규모)

## 3. 아키텍처

```
청구 생성(projects.routes)
  └─ notifyInvoiceIssued(inv)            ← 기존 진입점 그대로
       └─ notify.notifyAsync({type:"invoice_issued", ...})   ← fail-safe·비차단·SIGTERM 드레인 유지
            ├─ dispatchAlimtalk(event)   ← 카카오 디스패치를 대체(웹훅과 독립)
            │    └─ alimtalk.sendInvoiceIssued(...)  → SOLAPI REST
            └─ 웹훅(Slack/Discord) 발송  ← 무변경
```

`src/alimtalk.js` = 독립 연동 모듈(drive.js/calendar.js 격). OAuth·토큰 갱신이 없어 kakao.js보다 단순하다(단일 요청 + HMAC 헤더).

### 3.1 SOLAPI 호출 스펙(공식 문서 + 공식 SDK 소스 교차검증)

- 인증 헤더: `Authorization: HMAC-SHA256 apiKey={key}, date={ISO8601}, salt={32자 영숫자}, signature={hex}`
  - `signature = HMAC_SHA256(key=API_SECRET, data=date + salt)` (구분자 없이 concat, date 먼저)
  - `date = new Date().toISOString()`, `salt = crypto.randomBytes(16).toString("hex")`
- 엔드포인트: `POST https://api.solapi.com/messages/v4/send-many/detail` (단건도 `messages` 배열로)
- 메시지 본문:
```json
{
  "messages": [
    {
      "to": "01012345678",
      "type": "ATA",
      "kakaoOptions": {
        "pfId": "<발신프로필>",
        "templateId": "<승인 템플릿>",
        "disableSms": true,
        "variables": { "#{청구번호}": "OMG-202607-001", "#{청구처}": "…", "#{아티스트}": "…", "#{청구ID}": "42" },
        "buttons": [
          { "buttonType": "WL", "buttonName": "청구서 보기",
            "linkMo": "https://…/invoices/42", "linkPc": "https://…/invoices/42" }
        ]
      }
    }
  ]
}
```
  - **변수 키는 `#{…}`로 감싼 문자열 그대로**(SDK가 해주던 변환이 없으므로 직접), 값은 문자열.
  - 수신번호는 **하이픈 제거**(숫자만).
  - 수신자 N명은 `messages` 배열 N개로 **한 요청**에 보낸다.
- 응답: `{ groupInfo, failedMessageList[], messageList[] }`. 개별 실패는 `failedMessageList[].statusCode`
  (`3104` 카카오톡 미사용자 · `3105` 미등록 템플릿 · `3101` 발신프로필 무효 · `3108` 발송 가능 시간 아님 · `3109` 잘못된 파라미터).
  HTTP 4xx는 `{ errorCode, errorMessage }`.

### 3.2 모듈 인터페이스 (`src/alimtalk.js`)

```js
isConfigured()            // API 키·시크릿·pfId·templateId 모두 있으면 true
getSettings()             // { pfId, templateId } — 설정 화면 표시·편집
setSettings({pfId, templateId})
buildAuthHeader(date, salt)   // 순수 함수(테스트 대상) — 서명 문자열
buildMessages(recipients, vars, linkUrl)  // 순수 함수(테스트 대상) — messages 배열
send(recipients, vars, linkUrl)  // → {ok, sent, failed[], skipped?} · 절대 throw 안 함
```
- 발송 실패·미설정은 `console.warn` + 반환값으로만 알린다(청구 생성 비차단).
- `AbortSignal.timeout(8000)`.

## 4. 데이터 모델 · 수신자

**`users`에 두 컬럼 추가**(마이그레이션 `addColumn` — 기존 패턴):
- `phone TEXT` — 알림 수신 번호. 저장 시 `formatPhone`(lib/format) 정규화.
- `alert_invoice INTEGER DEFAULT 0` — 청구 알림 수신 여부.

**발송 대상** = `SELECT name, phone FROM users WHERE active=1 AND alert_invoice=1 AND phone IS NOT NULL AND phone<>''`.
→ 대표·치프 동시 수신 가능(나에게 보내기의 '스튜디오 전체 1명' 제약 해소).

**UI**: 관리 > 담당자 탭의 계정 행 **'정보 수정'**(이미 있는 치프 전용 폼 `POST /settings/users/:id/edit`)에 **전화**와 **"청구 알림 받기"** 체크를 추가한다.
- 하우스 엔지니어(=`project_managers.user_id` 연결)는 지금처럼 **담당자 행 전화도 함께 갱신**(사용자에겐 입력칸 하나).
- 대표는 담당자 행이 없으므로 `users.phone`만 저장.

**설정 저장**
- `SOLAPI_API_KEY` / `SOLAPI_API_SECRET` = **env**(Render `sync:false`) — 배포 시크릿.
- `pfId` / `templateId` = **admin_state 평문**(`alimtalk_pf_id`, `alimtalk_template_id`) — 비밀이 아니라 식별자이고, 심사 후 발급되므로 화면에서 입력해 재배포 없이 갱신.

## 5. 템플릿(심사 제출안 — 사용자 확정)

```
[OMG Studios] 청구서
#{청구번호}
#{청구처}·#{아티스트}
```
버튼(WL): **청구서 보기** → `https://omg-studios-manager.onrender.com/invoices/#{청구ID}`

- 변수 4종: `청구번호`(없으면 인보이스 제목) · `청구처`(`client_name`, 미지정이면 "청구처 미지정") · `아티스트`(프로젝트 아티스트, 없으면 "-") · `청구ID`.
- `아티스트`를 위해 `getInvoiceForUser`의 프로젝트 조인에 `p.artist AS project_artist` 한 컬럼을 추가한다(다중 아티스트는 저장된 콤마 목록 그대로).
- 알림톡 변수는 **빈 값을 허용하지 않는다** → 값이 비면 대체 문자열을 넣는다(위 괄호).
- **심사 반려 시**: 등록된 템플릿은 수정 불가하므로, 정보성 근거를 보강한 문안(예: 마지막 줄 `청구서가 발행되었습니다.`)으로 **새 템플릿을 등록**하고 관리 화면에서 templateId만 교체한다. 코드 변경 없음.

## 6. 제거(컷오버) 범위

| 대상 | 처리 |
|---|---|
| `src/kakao.js` | 삭제 |
| `/auth/kakao`, `/auth/kakao/callback` (auth.routes) | 삭제(논스 쿠키 상수 포함) |
| `POST /settings/kakao/{disconnect,test}` (settings.routes) | 삭제 → 알림톡 라우트로 대체 |
| 관리 > 알림 '카카오 알림' 섹션 (views.settings) | 알림톡 섹션으로 교체 |
| 시스템 탭 카카오 경고·연동 배지 | 알림톡 미설정 경고·배지로 교체 |
| cron `kakao.keepAlive()` (lib/maintenance) | 삭제(알림톡은 유지할 토큰이 없다) |
| `config.kakao*`, `KAKAO_*` env (config·render.yaml·DEPLOY §3/§4.5/§9) | `SOLAPI_*`로 교체 |
| `admin_state`의 `kakao_*` 키 6종 | 1회 마이그레이션 `kakao_state_drop_v1`로 삭제(토큰 잔재 제거) |
| `test/kakao.test.js`·`kakao-routes.test.js`·`notify-kakao.test.js` | 삭제 → 알림톡 테스트로 대체 |
| notify.js의 `dispatchKakao`·`formatKakaoText` | `dispatchAlimtalk`으로 교체 |

**유지**: notify의 fail-safe·`notifyAsync`·`drainNotifications`(SIGTERM 드레인)·웹훅 채널·SSRF 방어.

## 7. 실패 처리 · 관측

- 미설정(키·pfId·templateId 없음) 또는 수신자 0명 → 조용히 skip(로그 1줄).
- 발송 실패(HTTP 4xx/5xx, `failedMessageList`) → `console.warn`에 statusCode·수신자 마스킹 로그. **청구 생성은 절대 안 막힌다.**
- 관리 > **시스템 탭**: 알림톡 연동 배지(설정됨/미설정) + 미설정 시 ⚠️ 경고(기존 `systemWarnings` 패턴 재사용).
- 관리 > **알림 섹션**: 키(env) 설정 여부 · pfId/templateId 입력 폼 · **수신자 N명**(이름 나열) · **[테스트 알림 보내기]**(치프 전용 — 등록 수신자 전원에게 실제 템플릿 + 더미 변수 `TEST-0000` 발송, 결과를 notice로 표시).
- **야간 발송 리스크**: 상태코드 `3108`(08:00~20:50)은 광고성 메시지 제한이고 정보성 알림톡은 24시간 발송이 원칙이지만, 스튜디오는 야간 청구 발행이 잦다. 템플릿을 **정보성(비광고)**으로 등록하고, 그래도 3108이 나오면 로그·시스템 경고로 드러난다(코드 대응 없음 — YAGNI).

## 8. 테스트 (node:test · 의존성 0)

`test/alimtalk.test.js`
- `buildAuthHeader`: 고정 date·salt·secret → 서명 hex 고정값 재현(HMAC 계약 잠금), 헤더 문자열 형식.
- `buildMessages`: 변수 키가 `#{…}`로 감싸짐 · 하이픈 제거 · `type:"ATA"` · `disableSms:true` · WL 버튼 linkMo/linkPc · 수신자 N명 → 배열 N개.
- `send`: 미설정 skip · 수신자 0명 skip · fetch 실패(throw)에도 throw 안 함 · `failedMessageList` 로깅 후 `{ok:false}`.
- 빈 변수값 대체("-", "청구처 미지정").

`test/notify-alimtalk.test.js`
- `invoice_issued`만 알림톡으로 라우팅(다른 이벤트는 웹훅만).
- 알림톡이 throw해도 notify가 흡수(fail-safe) · 웹훅 미설정·SSRF 차단과 **독립** 발송.

`test/settings-alimtalk.test.js`(라우트·렌더)
- 치프 전용: 스태프가 `POST /settings/alimtalk`·`/settings/alimtalk/test` → 403.
- 설정 화면 렌더: 미설정 배지 · 수신자 목록 · 테스트 버튼.
- users 전화·알림 체크 저장(정규화 확인) + 발송 대상 쿼리(수신 off·비활성 제외).

기존 `smoke.test.js` 권한 매트릭스에 알림톡 라우트를 추가하지 않는다(이미 requireChief 계열 커버).

## 9. 문서 갱신(필수 — 프로젝트 규칙)

`CLAUDE.md`(알림 문단·데이터 모델 `users` 컬럼·env 표·세션 이력) · `WORKFLOW.md`(코드맵·완료 이력·테스트 수) · `DEPLOY.md`(§3 env 표, §4.5를 알림톡 준비 절차로 재작성, §9 시크릿 이관 목록) · `render.yaml`(`KAKAO_*` → `SOLAPI_*`).
