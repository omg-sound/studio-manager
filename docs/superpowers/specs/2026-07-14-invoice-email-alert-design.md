# 청구 발행 이메일 알림 — 설계

> 2026-07-14 · 카카오('나에게 보내기')·알림톡 폐기 후의 최종 채널. **청구 생성(=발행) 시 지정한 이메일로 알림.**
> 사용자 결정: 발송=**지메일 API(studio@omgworks.kr)** / 수신자=**관리 화면에 주소 입력(콤마로 여러 명)** / 내용=**요약 + 바로가기 링크**.

## 1. 결정 사항

| 항목 | 결정 | 이유 |
|---|---|---|
| 발송 수단 | **지메일 API**(googleapis, 이미 의존성에 있음) | 새 의존성·외부 서비스·요금 0. 발신자가 studio@omgworks.kr라 수신함 신뢰도↑, SPF/DKIM 설정 불필요 |
| 인증 | 기존 **스튜디오 계정 refresh token 재사용**(`drive.getRefreshToken()` — Drive·캘린더·연락처와 동일 토큰) | 별도 연동 화면 없음. `gmail.send` 스코프만 추가 후 studio 계정 1회 재로그인 |
| 수신자 | `admin_state.alert_email_to`(콤마 구분 문자열) | 로그인 계정과 분리 → 외부 회계·세무사도 넣을 수 있고, `users` 스키마 변경 없음 |
| 이벤트 | **`invoice_issued` 하나만** | 웹훅 채널은 지금처럼 전 이벤트 유지 |
| 내용 | 요약 + '청구서 보기' 링크 | 금액·명세는 앱에서 보는 게 정확. 메일은 알림에 집중(첨부 없음) |

## 2. 선행 조건(사용자 작업)

1. **GCP에서 Gmail API 활성화**(프로젝트 `omg-studio-manager`)
2. 배포 후 **studio@omgworks.kr 계정으로 1회 재로그인**(관리 > 환경설정 > 자료 저장(구글 Drive)의 연결 버튼 = `/auth/google?drive=1` — 계정 선택기가 studio 계정을 강제한다). 새 스코프(`gmail.send`)가 담긴 refresh token이 저장된다.
   - 재로그인 전까지는 발송이 `insufficient scope`로 실패한다 → 조용히 skip + 관리 > 시스템 탭 경고.

## 3. 아키텍처

```
청구 생성(projects.routes) → notifyInvoiceIssued(inv)      ← 기존 진입점 그대로
   └─ notify.notifyAsync({type:"invoice_issued", ...})     ← fail-safe·비차단·SIGTERM 드레인(유지)
        ├─ dispatchEmail(event)   ← 카카오 디스패치가 있던 자리(웹훅과 독립)
        │    └─ mailer.sendInvoiceIssued(inv)  → Gmail API users.messages.send
        └─ 웹훅(Slack/Discord)    ← 무변경
```

### `src/mailer.js` (신규 · drive.js/calendar.js와 같은 격)

```js
gmailClient()                    // studio refresh token으로 인증된 gmail 클라이언트. 미연동이면 null
getRecipients()                  // admin_state 문자열 → 정규화된 주소 배열(콤마·공백 분리·소문자·dedup·형식 검증)
setRecipients(raw)               // 저장(문자열 그대로). 잘못된 주소가 있으면 라우트에서 에러 표시
isConfigured()                   // 구글 연동 O + 수신 주소 1개 이상
buildMime({ to, subject, html })  // 순수 함수(테스트) → RFC822 문자열
send({ subject, html })          // → {ok, sent} · 절대 throw 안 함(console.warn만)
```

- **MIME**: `From: OMG Studios <studio@omgworks.kr>` / `To:` 콤마 목록 / `Subject:` **RFC 2047 base64**(한글) / `Content-Type: text/html; charset=UTF-8` / `Content-Transfer-Encoding: base64`.
- **전송**: `gmail.users.messages.send({ userId: "me", requestBody: { raw: base64url(mime) } })`.
- 미연동·수신자 0명 → 조용히 skip. 실패는 `console.warn`(청구 생성 비차단).

### 메일 내용

- **제목**: `[청구 발행] {청구번호} · {아티스트 또는 청구처}`
- **본문**(HTML, 단순 표):
  - 청구번호 / 청구처 / 아티스트 / 프로젝트 / 금액(₩, VAT 포함 총액)
  - **[청구서 보기]** 버튼 → `{BASE_URL}/invoices/{id}` (도메인 정리 완료 → `https://erp.omgworks.kr/...`)
  - 꼬리말: "OMG Studios 관리 시스템에서 자동 발송된 알림입니다."
- `아티스트`는 인보이스 조회에 `projects.artist` 한 컬럼을 추가해 공급(`getInvoiceForUser`).

## 4. UI

**관리 > 환경설정 > 알림**에 '청구 알림 이메일' 블록(웹훅 블록 아래):
- 수신 주소 입력(콤마로 여러 명) + 저장(치프 전용). 형식이 잘못된 주소는 저장 거부하고 그 주소를 표시.
- 현재 수신자 목록 표시(`N명`), 미설정이면 안내.
- **[테스트 메일 보내기]**(치프) → 실제 발송 후 성공/실패를 notice로.
- 구글 미연동·스코프 없음이면 "studio 계정 재로그인 필요" 안내.

**관리 > 시스템 탭**: 연동 배지에 `청구 알림 메일 (설정됨/미설정)` 추가 + 수신 주소 미설정 시 ⚠️ 경고(기존 `systemWarnings` 패턴).

## 5. 보안·프라이버시

- 수신 주소는 비밀이 아니므로 **평문**(`admin_state`)로 저장. 웹훅 URL은 지금처럼 암호화 유지.
- 메일 본문에 **금액과 청구처명**이 들어간다(내부 직원 대상이라 허용 — 사용자 결정). 명세·PDF는 첨부하지 않는다.
- 발송 실패 로그에 **수신 주소 전체를 남기지 않는다**(앞 2글자 + 도메인만).

## 6. 테스트

`test/mailer.test.js`
- `buildMime`: 헤더 순서·한글 제목 RFC2047 인코딩·`text/html; charset=UTF-8`·본문 base64 왕복·다중 수신자 콤마 결합.
- `getRecipients`: 콤마/공백/줄바꿈 분리·소문자화·dedup·형식 불량 제외.
- `send`: 미연동 skip · 수신자 0명 skip · gmail API가 throw해도 **throw 안 함**.

`test/notify-email.test.js`
- `invoice_issued`만 이메일로 라우팅(다른 이벤트는 웹훅만).
- 이메일이 throw해도 notify가 흡수(fail-safe) · 웹훅 미설정·SSRF 차단과 **독립** 발송.

`test/settings-email.test.js`(라우트)
- 스태프가 `POST /settings/alert-email`·`/settings/alert-email/test` → 403(치프 전용).
- 잘못된 주소 저장 거부 · 정상 저장 후 목록 렌더.

## 7. 문서(필수)

`CLAUDE.md`(알림 문단·admin_state 키·세션 이력·테스트 수) · `WORKFLOW.md`(코드맵 `mailer.js`·완료 이력) · `DEPLOY.md`(§4.7 지메일 API 활성화 + studio 계정 재로그인 절차, OAuth 스코프 목록 갱신).
