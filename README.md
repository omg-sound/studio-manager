# OMG Studios Manager

녹음/믹싱 스튜디오 **프로젝트 관리 · 자료 전달 · 청구** 내부 웹앱.
1인 관리자 운영 + 거래처(클라이언트) 열람.

- 스택: Node/Express + SQLite + Google OAuth/Drive + Tailwind. 서버 렌더 HTML.
- 인증: 관리자=Google OAuth, 클라이언트=이메일/비밀번호. role 기반 접근 제어.
- 프로젝트는 트랙/콘텐츠와 모듈형 작업(Task)을 가질 수 있고, 완료+미청구 작업을 라인아이템 청구서로 생성합니다.
- 설계·아키텍처·검증 상태는 [`CLAUDE.md`](./CLAUDE.md) 참고(살아있는 설계 일지).

## 빠른 시작 (로컬)

```bash
cp .env.example .env       # 값 채우기(로컬 검증은 DEV_LOGIN=1 권장)
npm install                # better-sqlite3 빌드 실패해도 node:sqlite로 동작
npm run build:css          # Tailwind 빌드(public/css/app.css)
npm run seed               # 더미 관리자/거래처/클라이언트/프로젝트

# 개발 로그인 활성으로 실행
DEV_LOGIN=1 npm start
# → http://localhost:3000/login
```

기본 더미 로그인(`npm run seed` 후):

| 역할 | 이메일 | 비밀번호 |
|---|---|---|
| 관리자 | `/dev-login` 사용(`DEV_LOGIN=1`) 또는 Google OAuth | - |
| 클라이언트(루나) | `luna@example.com` | `client123` |

> 관리자는 실제 운영 시 **Google OAuth**로 로그인합니다(`ADMIN_EMAIL` 일치 필요).
> 일반 비밀번호 로그인은 클라이언트 계정 전용입니다.
> `DEV_LOGIN`은 자격증명 없이 검증할 때만 쓰고 **프로덕션에서는 끄세요**.

## 스크립트

| 명령 | 설명 |
|---|---|
| `npm start` | `prestart`에서 CSS 빌드 후 서버 기동 |
| `npm run dev` | CSS 빌드 + 서버 |
| `npm run watch:css` | Tailwind watch |
| `npm run seed` | 더미 데이터 |

## REST API 요약

인증 쿠키가 필요하며, 생성/청구 API는 관리자 권한이 필요합니다.

| 엔드포인트 | 설명 |
|---|---|
| `POST /api/projects` | 프로젝트 생성 |
| `POST /api/projects/:id/tracks` | 프로젝트에 항목(트랙/콘텐츠) 추가 |
| `POST /api/tracks/:id/tasks` | 트랙에 녹음/튠/믹스/영상 오디오 작업 추가 |
| `GET /api/projects/:id/unbilled-tasks` | 완료됐지만 아직 청구되지 않은 작업 조회 |
| `POST /api/invoices` | 선택한 미청구 작업으로 라인아이템 청구서 생성 |

## Google OAuth 설정(관리자 + Drive)

1. Google Cloud Console → OAuth 클라이언트(웹) 생성.
2. 승인된 redirect URI: `{BASE_URL}/auth/google/callback`.
3. 동의화면에 테스트 사용자(관리자 이메일) 추가, Drive API 활성화.
4. `.env`의 `GOOGLE_CLIENT_ID/SECRET`, `ADMIN_EMAIL`, `BASE_URL` 설정 후 재기동.

## 배포 (Render)

`render.yaml` Blueprint = **web(SQLite on Disk) + 일일 백업/연체 cron**. `DB_PATH`는 영속 Disk(`/var/data/app.db`),
업로드·백업도 같은 디스크(`/var/data/uploads`·`/var/data/backups`).

- cron(`omg-studios-cron`)은 매일 03:00 KST에 web의 `POST /internal/cron/daily`를 `BACKUP_TOKEN`으로 트리거 →
  `VACUUM INTO` 백업(최근 14일 유지) + 연체 인보이스 스캔.
- **단계별 절차(git init·시크릿·OAuth·검증)는 [`DEPLOY.md`](./DEPLOY.md) 참조.**
