# OMG Studios Manager — Render 배포 런북

> Render Blueprint(`render.yaml`)로 **web(SQLite on Disk) + 일일 백업/연체 cron**을 배포한다.
> 코드·설정은 배포 준비 완료 상태다. 아래는 **사람이 직접 하는 단계**(계정·시크릿·OAuth)까지 포함한 절차다.
> 설계 배경은 [`CLAUDE.md`](./CLAUDE.md), 작업 이어가기는 [`WORKFLOW.md`](./WORKFLOW.md) 참조.

---

## ▶ 진행 상태 (2026-06-28 기준 · VSCode 이어가기용)

| 단계 | 상태 |
|---|---|
| 1. Git 저장소 + 푸시 | ✅ 완료 — `github.com/omg-sound/studio-manager` (main) |
| 2. Render Blueprint 연결 | ✅ 진행 — 두 서비스 인식됨 |
| 3. 시크릿 입력 | ⏳ **진행 중** — `ADMIN_EMAIL`✅ · `GOOGLE_CLIENT_ID`✅ · **`GOOGLE_CLIENT_SECRET` ❌(다음 작업)** · **`BACKUP_TOKEN`(web+cron 동일값) ❌** |
| 4. Apply → 빌드·배포 | ⬜ 대기 |
| 5. OAuth redirect URI(배포 도메인) | ⬜ 대기 |
| 6. 첫 로그인·검증·cron 트리거 | ⬜ 대기 |

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
| `BASE_URL` | 비움 → `RENDER_EXTERNAL_URL` 자동 사용 |
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
5. 발급된 Client ID/Secret을 3단계 web 서비스 env에 입력.

> redirect URI는 `{BASE_URL}/auth/google/callback`. Render는 `RENDER_EXTERNAL_URL`을 `BASE_URL`로
> 자동 도출하므로, **배포 후 확정된 onrender.com 도메인**으로 redirect URI를 맞춰야 한다.

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
