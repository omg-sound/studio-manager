# OMG Studios ERP — Render 배포 런북

> Render Blueprint(`render.yaml`)로 **web(SQLite on Disk) + 일일 백업/연체 cron**을 배포한다.
> 코드·설정은 배포 준비 완료 상태다. 아래는 **사람이 직접 하는 단계**(계정·시크릿·OAuth)까지 포함한 절차다.
> 설계 배경은 [`CLAUDE.md`](./CLAUDE.md), 작업 이어가기는 [`WORKFLOW.md`](./WORKFLOW.md) 참조.

---

## ▶ 진행 상태 (2026-06-28 기준)

| 단계 | 상태 |
|---|---|
| 1. Git 저장소 + 푸시 | ✅ 완료 — `github.com/omg-sound/studio-manager` (main) |
| 2. Render Blueprint 연결 | ✅ 완료 — web + cron 두 서비스 배포 중 |
| 3. 시크릿 입력 | ✅ 완료 — 전체 env 입력 완료 |
| 4. Apply → 빌드·배포 | ✅ 완료 — `https://omg-studios-manager.onrender.com` live |
| 5. OAuth redirect URI(배포 도메인) | ✅ 완료 — GCP 콘솔에 callback URI 등록 |
| 6. 첫 로그인·검증·cron 트리거 | ✅ 완료 — Google 로그인·`/healthz`·백업 cron 전부 통과 |

**배포 완전 완료 (2026-06-28 18:31 KST)**. 다음 선택 작업은 §7 운영 메모 참조.

**바로 다음 할 일**: GCP에서 `GOOGLE_CLIENT_SECRET`(=Client ID와 같은 OAuth 웹 클라이언트의 "클라이언트
보안 비밀", `GOCSPX-…`)을 복사해 Render web 서비스에 입력 → `BACKUP_TOKEN`을 web·cron 두 곳에 **동일한
강한 값**(`openssl rand -hex 32`) 입력 → **Apply**. 이후 §4~§6.

> ⚠️ 프로덕션 fail-fast: `GOOGLE_CLIENT_SECRET`·`BACKUP_TOKEN`이 비거나 약하면 web 부팅이 거부된다(`src/config.js`).

---

## 0. 사전 준비물

- **GitHub 저장소** — ✅ `github.com/omg-sound/studio-manager` (Render Blueprint는 Git 저장소에서 배포).
- **Render 계정** — https://render.com (Blueprint는 유료 Starter 플랜 기준: web + cron).
- **Google Cloud 프로젝트** — OAuth 클라이언트(웹) + Drive API. (로그인·자료 스토리지에 필요)

---

## 1. Git 저장소 (✅ 완료)

이미 초기화·푸시 완료: `github.com/omg-sound/studio-manager` (`main`). 이후 변경은 평소대로:

```bash
git add -A && git commit -m "..." && git push   # autoDeploy=commit → web/cron 자동 재배포
```

> `.env`, `data/*.db`, `data/backups/`, `data/uploads/`, `node_modules/`, `public/css/app.css`,
> `.claude/settings.local.json`은 `.gitignore`로 제외된다. **시크릿이 올라가지 않는지 `git status`로 확인**.

---

## 2. Render Blueprint 배포

1. Render 대시보드 → **New → Blueprint**.
2. 1단계의 GitHub 저장소를 연결하면 `render.yaml`을 자동 인식한다.
   - `omg-studios-manager` (web) + `omg-studios-cron` (cron) 두 서비스가 잡힌다.
3. **Apply** 누르면 `sync: false` 환경변수 입력을 요구한다(3단계).

### 2-1. 자동 처리되는 것 (render.yaml에 정의됨)

| 항목 | 값 |
|---|---|
| web 런타임/빌드 | Node · `npm ci && npm run build:css` · `node src/server.js` |
| 영속 Disk | `/var/data` 1GB (DB·업로드·백업 모두 이 디스크) |
| 헬스체크 | `/healthz` |
| `NODE_ENV` | `production` |
| `DB_PATH` | `/var/data/app.db` |
| `MAX_UPLOAD_MB` | `200` |
| `SESSION_SECRET` / `TOKEN_ENC_KEY` | `generateValue: true` (Render가 강한 랜덤값 자동 생성) |
| `BASE_URL` | 비움 → `RENDER_EXTERNAL_URL`(onrender.com) 자동 사용. **커스텀 도메인을 쓰면 반드시 그 주소로 명시**(§4.6) — 명시값이 자동 주입값을 이긴다 |
| cron 스케줄 | `0 18 * * *` (UTC) = **매일 03:00 KST** |
| cron → web 트리거 | `WEB_HOSTPORT`(private network host:port) 자동 주입 |

---

## 3. 시크릿 환경변수 입력 (`sync: false`)

Blueprint Apply 시 또는 각 서비스 **Environment** 탭에서 입력한다.

### web 서비스 (`omg-studios-manager`)

| 키 | 값 |
|---|---|
| `ADMIN_EMAIL` | 최초 **치프(chief)** Google 이메일(첫 로그인 계정). 이후 대표·스태프는 `/settings`에서 등록 |
| `GOOGLE_CLIENT_ID` | 4단계 OAuth 클라이언트 ID |
| `GOOGLE_CLIENT_SECRET` | 4단계 OAuth 클라이언트 시크릿 |
| `BACKUP_TOKEN` | cron 인증 토큰. 강한 랜덤값: `openssl rand -hex 32` |

### cron 서비스 (`omg-studios-cron`)

| 키 | 값 |
|---|---|
| `BACKUP_TOKEN` | **web과 똑같은 값**(반드시 동일해야 트리거 인증 통과) |

> ⚠️ `BACKUP_TOKEN`은 두 서비스에 같은 값을 넣는다. (Render `fromService`는 host/port만 공유 가능,
> 시크릿 값은 공유 불가 → 동일 값 수동 입력 또는 env group 사용.)

---

## 4. Google OAuth 설정

1. Google Cloud Console → **APIs & Services → Credentials → OAuth 클라이언트 ID(웹 애플리케이션)**.
2. **승인된 리디렉션 URI**에 다음 추가(배포 URL 확정 후):
   ```
   https://<your-app>.onrender.com/auth/google/callback
   ```
   - 로컬 검증용으로 `http://localhost:3000/auth/google/callback`도 함께 등록 가능.
3. **OAuth 동의 화면**: 내부 도구이므로 테스트 사용자에 로그인할 직원 이메일을 추가(또는 게시).
4. **Google Drive API 활성화**(자료 전달 스토리지가 local→drive로 자동 전환됨).
5. **Google Calendar API 활성화**(세션 겹침 검사용 — 아래 §6.5).
6. 발급된 Client ID/Secret을 3단계 web 서비스 env에 입력.

> redirect URI는 `{BASE_URL}/auth/google/callback`. `BASE_URL`을 비우면 Render가 주입하는
> `RENDER_EXTERNAL_URL`(onrender.com)이 쓰이므로 그 주소로 맞춘다. **커스텀 도메인을 붙이면 §4.6을 따라
> `BASE_URL`을 그 주소로 명시하고 redirect URI도 추가**해야 한다.

### 4-1. OAuth 스코프 변경 시 재동의

앱은 `openid·email·profile·drive.file·calendar`(캘린더 읽기+쓰기)·`contacts`·**`gmail.send`**(청구 발행 알림 메일) 스코프를 요청한다. **스코프를 바꾼 배포
이후에는 치프가 한 번 다시 로그인(구글 동의)** 해야 새 권한이 담긴 refresh token이 저장된다(기존 토큰엔 새 권한 없음).
`calendar`(전체)는 겹침 검사(FreeBusy 읽기) + **예약 시 일정 자동 생성/수정/삭제(쓰기)** 에 모두 쓰인다.

---

## 4.6. 커스텀 도메인 연결 (`erp.omgworks.kr`) — 선택

앱이 만드는 **모든 외부 링크**(구글 OAuth redirect_uri, 자료 전달 공개 링크 `/d/:token`, 청구 발행 알림, 캘린더 일정의 프로젝트 링크)가 `config.baseUrl`에서 나온다. 도메인만 붙이고 `BASE_URL`을 안 넣으면 링크가 계속 onrender.com으로 나가므로, **아래 3·4단계를 반드시 함께** 한다.

1. **Render** → 서비스 `omg-studios-manager` → Settings → **Custom Domains** → `erp.omgworks.kr` 추가. Render가 표시하는 **CNAME 대상**(`omg-studios-manager.onrender.com`)을 확인한다. TLS 인증서는 검증 후 자동 발급(Let's Encrypt).
2. **DNS(whois.co.kr 등 도메인 관리업체)** → DNS 관리에서 레코드 추가:
   `CNAME` / 호스트 `erp` / 값 `omg-studios-manager.onrender.com`
   - 서브도메인이라 CNAME으로 충분하다(루트 도메인이면 CNAME 불가 — ALIAS/ANAME 또는 A 레코드 필요).
   - **네임서버가 그 업체 DNS를 쓰고 있어야** 여기서 추가한 레코드가 적용된다(다른 곳으로 위임돼 있으면 그쪽에서 추가).
   - 전파 후 Render 대시보드의 도메인 상태가 **Verified**로 바뀐다(보통 수분~1시간).
3. **Render env**: `BASE_URL=https://erp.omgworks.kr` 추가 → 재배포.
   ⚠️ Render는 `RENDER_EXTERNAL_URL`(=onrender.com)을 **항상 주입하고 지울 수 없다**. `src/config.js`는 **BASE_URL을 우선**하도록 돼 있다(2026-07-14 수정, `test/config-baseurl.test.js`가 회귀 잠금). 이 순서가 뒤집히면 도메인을 붙여도 모든 링크가 옛 주소로 나간다.
4. **Google Cloud Console** → OAuth 클라이언트:
   - 승인된 리디렉션 URI에 `https://erp.omgworks.kr/auth/google/callback` **추가**(기존 onrender.com 항목은 롤백 대비로 남겨둔다)
   - 승인된 자바스크립트 원본에 `https://erp.omgworks.kr` 추가
   - 이걸 빠뜨리면 **로그인이 `redirect_uri_mismatch`로 실패**한다.

**부수 영향**
- 쿠키는 도메인별이라 새 주소에서 **전원 재로그인** 필요(데이터 영향 없음).
- 이미 발송한 `onrender.com/d/...` 자료 전달 링크는 **계속 동작**한다(Render가 두 도메인 모두 서비스).
- 기존 캘린더 일정 설명의 링크는 옛 주소 그대로다 — 새 주소로 갱신하려면 **관리 > 환경설정 > 기존 캘린더 일정 재동기화**.
- `trust proxy`·secure 쿠키·동일출처(CSRF) 검사는 Host 기준이라 코드 변경 없이 그대로 동작한다.

---

## 4.7. 청구 발행 알림 메일 (지메일 API) — 선택

프로젝트 청구 탭에서 **청구가 생성될 때** 지정한 주소로 알림 메일을 보낸다(발신 = 스튜디오 구글 계정 `STUDIO_DRIVE_EMAIL`). 새 의존성·외부 서비스·요금 없음. 설정 안 하면 이 기능만 조용히 꺼진다(청구 생성은 정상).

1. **GCP에서 Gmail API 활성화**(OAuth 클라이언트가 있는 프로젝트).
2. **스튜디오 계정으로 1회 재로그인** — `gmail.send`는 새 스코프라 기존 refresh token엔 없다. 관리 > 환경설정 > **자료 저장(구글 Drive)** 의 연결 버튼(`/auth/google?drive=1` — 계정 선택기가 스튜디오 계정을 강제)으로 다시 동의한다.
3. 관리 > 환경설정 > **알림 > 청구 알림 이메일**에 수신 주소 입력(**콤마로 여러 명**) → 저장 → **[테스트 메일 보내기]** 로 확인.

- 수신 주소는 비밀이 아니므로 `admin_state.alert_email_to`에 **평문** 저장(웹훅 URL은 암호화 유지).
- 메일 본문 = 청구번호·청구처·아티스트·프로젝트·금액 + **청구서 바로가기 링크**(`{BASE_URL}/invoices/:id` — §4.6의 커스텀 도메인이 적용된 주소). 첨부 없음.
- 수신 주소가 없으면 **관리 > 시스템 탭에 ⚠️ 경고**가 뜬다(청구가 발행돼도 아무에게도 안 가는 상태 = 조용한 장애).
- 발송 실패(스코프 누락 등)는 로그·테스트 버튼으로만 드러나고 **청구 생성을 막지 않는다**(fail-safe).

---

## 5. 첫 로그인 · 사용자 등록

1. 배포 완료 후 `https://<your-app>.onrender.com/login` 접속.
2. **`ADMIN_EMAIL`로 지정한 Google 계정**으로 로그인 → 자동으로 **치프(chief)** 생성.
3. 치프가 `/settings → 사용자` 에서 **대표(owner)** · **스태프(staff)** Google 이메일을 등록(화이트리스트).
   - 등록되지 않은 이메일은 로그인 거부된다.

---

## 6. 배포 검증 체크리스트

- [ ] `GET /healthz` → `{"ok":true}`
- [ ] 미인증 `/projects` → `/login` 리다이렉트(인증 우회 없음)
- [ ] `ADMIN_EMAIL` 계정 Google 로그인 → 치프 권한, 대시보드 청구 통계 노출
- [ ] 자료 업로드 → Drive로 저장(Drive 연동 시) 또는 `/var/data/uploads`(미연동 시)
- [ ] **cron 수동 트리거**(아래) → 200 + 백업 파일 생성 확인

### cron 수동 트리거(검증)

cron 서비스의 다음 실행을 기다리지 않고 즉시 검증하려면, web 서비스에 직접 호출한다:

```bash
curl -fsS -X POST \
  -H "Authorization: Bearer <BACKUP_TOKEN>" \
  https://<your-app>.onrender.com/internal/cron/daily
# → {"ok":true,"overdue":{...},"backup":{"file":"/var/data/backups/app-YYYY-MM-DD.db",...}}
```

- 연체만 확인(부수효과 없음): `GET /internal/cron/overdue` (같은 토큰).
- Render 대시보드 → cron 서비스 → **Trigger Run**으로 스케줄 실행을 즉시 테스트할 수도 있다.

---

## 6.5. 세션 겹침 검사(구글 캘린더) 활성화 — 선택

녹음·믹싱 세션을 **예약할 때 이미 잡힌 일정과 겹치면 막는** 기능. 앱 안의 세션끼리 겹침은 기본 동작(설정 불필요)이고,
**앱 밖(구글 캘린더에서 직접) 잡은 일정까지** 막으려면 아래를 설정한다.

1. GCP에서 **Google Calendar API 활성화**(§4-5).
2. **전용 스튜디오 캘린더 준비**: 구글 캘린더에서 스튜디오 일정만 모으는 캘린더를 하나 만든다(개인 일정과 분리 —
   섞이면 개인 일정 시간도 예약이 막힌다). 예약 시 일정이 이 캘린더에 자동 생성된다.
3. **치프 재로그인**(§4-1)으로 `calendar`(읽기+쓰기) 권한 동의.
4. 앱 **`/settings → 스튜디오 캘린더 (구글)`** 에서 그 캘린더를 선택하고, **기본 장소**(예약 일정에 들어갈 스튜디오 주소)도 입력.

동작:
- **예약 시 자동 추가**: 세션을 추가하면 그 캘린더에 일정을 자동 생성한다. 제목=**제작사 · 아티스트**, 장소=기본 장소,
  시간=시작~종료(KST). 세션 수정 시 일정도 수정, 삭제·취소 시 일정도 삭제된다(`gcal_event_id`로 추적).
- **겹침 차단**: 새 예약이 그 캘린더의 **바쁜 시간대**(FreeBusy)와 겹치면 409로 막는다.
- 미연동·권한없음·일시 오류는 **fail-safe**(일정 자동 생성은 건너뛰고 예약 자체는 정상 진행, 겹침 검사는 통과).
  캘린더를 "사용 안 함"으로 비우면 자동 추가·외부 겹침 검사가 모두 꺼진다(앱 내부 세션끼리 겹침 검사는 그대로 동작).

---

## 7. 운영 메모

- **백업**: 매일 03:00 KST에 `VACUUM INTO`로 `/var/data/backups/app-YYYY-MM-DD.db` 생성, **최근 14일분 유지**(자동 정리).
  - 디스크 백업은 Render Disk 안에 있다. 디스크 자체 유실 대비가 필요하면 후속으로 Drive/S3 오프사이트 업로드를 cron에 추가.
- **연체 리마인더**: 현재는 연체 인보이스를 집계·로그·JSON으로 노출한다(발행+마감경과+잔금). 메일/웹훅 발송은 후속(선택) TODO.
- **무중단 배포 주의**: Disk가 붙은 web 서비스는 Render의 zero-downtime deploy가 비활성(데이터 정합성). 배포 시 짧은 다운타임 발생 — 내부 도구라 허용.
- **시크릿 회전**: `BACKUP_TOKEN`을 바꾸면 web·cron 양쪽을 같이 갱신.

---

## 8. 트러블슈팅

| 증상 | 원인 / 조치 |
|---|---|
| 부팅 즉시 종료(Configuration error) | 프로덕션 fail-fast: `ADMIN_EMAIL` 누락, 약한 `SESSION_SECRET`/`TOKEN_ENC_KEY`(32자 미만/기본값), Google 자격증명 누락, `DEV_LOGIN` 켜짐 중 하나. 로그의 누락 키 확인 |
| cron 실행이 실패(빨강) | `BACKUP_TOKEN`이 web↔cron 불일치(401), 또는 web 서비스 다운. cron 로그의 상태코드 확인 |
| `/internal/cron/daily` 404 | `BACKUP_TOKEN` 미설정 → 라우트 비활성. web env에 토큰 입력 |
| OAuth `redirect_uri_mismatch` | Google 콘솔 redirect URI가 실제 onrender.com 도메인과 불일치. 4-2단계 재확인 |
| 자료가 local에 저장됨(Drive 아님) | Drive 미연동. OAuth + Drive API 활성화 후 admin이 최초 로그인하면 자동 전환 |

---

## 9. DB 복구 런북 (2026-07-09 리허설 검증 완료)

> Render 디스크 유실·데이터 사고 시 Drive 오프사이트 백업으로 복원하는 절차.
> **리허설 결과**: 실백업(app-2026-07-09.db)으로 전 절차 통과 — 무결성 ok·FK 위반 0·서버 기동 ~1초·
> 마이그레이션 멱등 통과·전 화면 200·쓰기 정상. 첨부는 전량 Drive 저장이라 DB만 복원하면 됨.

1. **백업 확보**: studio@omgworks.kr Drive → `omg-studios-manager/backups/` → 최신 `app-YYYY-MM-DD.db` 다운로드
   (매일 03:00 KST 생성, 14일 보존. Render 디스크가 살아 있으면 `/var/data/backups/`에서도 가능).
2. **무결성 확인**(로컬): `sqlite3 app-*.db "PRAGMA integrity_check; PRAGMA foreign_key_check;"` → `ok` + 위반 0 확인.
3. **배치**: Render Shell에서 서비스 중지 없이 안전하게 하려면 —
   ```
   # 기존 DB 옆으로 치우고(즉시 롤백 대비) 백업을 제자리에
   mv /var/data/app.db /var/data/app.db.broken
   rm -f /var/data/app.db-wal /var/data/app.db-shm   # WAL 잔재 제거(필수 — 옛 WAL이 새 DB에 적용되면 안 됨)
   # 백업 파일을 /var/data/app.db 로 업로드/복사
   ```
4. **재시작**: Render 대시보드에서 서비스 Restart → 기동 로그에서 마이그레이션 에러 없음 확인(백업은 VACUUM INTO 산출물이라 멱등 마이그레이션이 그대로 통과).
5. **검증**: `/healthz` → 로그인 → 청구·프로젝트 건수 눈으로 대조 → 아무 프로젝트 1개 생성·삭제(쓰기 확인).
6. **주의**: 백업 시점(전일 03:00) 이후 입력분은 유실 — 당일 작업분은 수기로 재입력. 첨부 파일은 Drive `drive.file` 앱 폴더에 그대로 있어 DB의 file_id 참조가 자동 복구된다(로컬 저장분이 있었다면 그것만 유실 — 관리›환경설정 '자료 저장'에서 로컬 잔존 여부 확인).
7. **⚠️ 서비스를 새로 만들 때(Blueprint 재적용·재프로비저닝)는 `SESSION_SECRET`·`TOKEN_ENC_KEY`를 반드시 원본 값으로 이관**한다(render.yaml이 `generateValue: true`라 그대로 두면 새 랜덤값 발급). `TOKEN_ENC_KEY`가 바뀌면 DB의 암호화 비밀(Drive·캘린더 refresh token, 알림 웹훅 URL, 외주 주민등록번호·계좌번호)이 전부 **조용히 복호화 실패**한다 — 재연동·재입력 전까지 무음이다. 복원 후 체크리스트: 시스템 탭 연동 배지(캘린더·Drive·연락처·웹훅) 확인.
