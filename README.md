# OMG Studios Manager

녹음/믹싱 스튜디오 **프로젝트 관리 · 자료 전달 · 청구** 내부 운영 웹앱.

- **스택**: Node 20 / Express 4(CommonJS) / SQLite(`better-sqlite3` ↔ `node:sqlite` 폴백) / Google OAuth·Drive /
  서버 렌더 HTML + Tailwind / helmet CSP(인라인 스크립트 0).
- **인증**: 전원 **Google OAuth + 화이트리스트**(치프가 허용한 계정만). 비밀번호 로그인 없음. 권한 3단계:
  - **대표(owner)** — 전체 모니터링 + 청구 열람·관리(편집은 안 함)
  - **치프(chief)** — 운영 전반(스태프·담당자·클라이언트·설정 관리 + 프로젝트 편집 + 청구)
  - **스태프(staff)** — 프로젝트·곡/콘텐츠·작업·자료 편집
  - **거래처(실결제자)** 는 프로젝트 데이터로만 존재하며 **로그인하지 않습니다.**
- **데이터 흐름**: 프로젝트 → 곡·콘텐츠(트랙) → 모듈형 작업(Task) → 완료+미청구 작업을 라인아이템 청구서로 생성.
  세션(일정)·자료 전달(Drive/로컬)·연체 파생·VAT 10%·`INV-YYYYMM-###` 채번 포함.
- 설계·아키텍처·검증 상태는 [`CLAUDE.md`](./CLAUDE.md)(살아있는 설계 일지), 이어가기는 [`WORKFLOW.md`](./WORKFLOW.md),
  배포는 [`DEPLOY.md`](./DEPLOY.md) 참고.

## 빠른 시작 (로컬)

```bash
cp .env.example .env       # 값 채우기(로컬 검증은 DEV_LOGIN=1 권장)
npm install                # better-sqlite3 빌드 실패해도 node:sqlite로 동작
npm run build:css          # Tailwind 빌드(public/css/app.css)
npm run seed               # 더미 사용자·거래처·프로젝트

# 개발 로그인 활성으로 실행
DEV_LOGIN=1 npm start
# → http://localhost:3000/login  (대표/치프/스태프 dev 버튼)
```

`DEV_LOGIN=1`이면 `/login`에 역할별 dev 로그인 버튼이 뜹니다. `npm run seed`가 만드는 더미 계정:

| 역할 | 이메일 |
|---|---|
| 치프(chief) | `studio@example.com` |
| 대표(owner) | `ceo@example.com` |
| 스태프(staff) | `engineer@example.com` · `manager@example.com` |

> 실제 운영은 전원 **Google OAuth**로 로그인합니다. 최초 로그인 = `ADMIN_EMAIL`(자동으로 치프 생성),
> 이후 대표·스태프는 치프가 `/settings → 사용자`에서 Google 이메일로 등록(화이트리스트)합니다.
> `DEV_LOGIN`은 자격증명 없이 검증할 때만 쓰고 **프로덕션에서는 반드시 끄세요**(켜져 있으면 부팅 거부).

## 스크립트

| 명령 | 설명 |
|---|---|
| `npm start` | `prestart`에서 CSS 빌드 후 서버 기동 |
| `npm run dev` | CSS 빌드 + 서버 |
| `npm run watch:css` | Tailwind watch |
| `npm run seed` | 더미 데이터 |

## REST API 요약

인증 쿠키가 필요합니다. 편집 API는 **치프/스태프**, 청구 API는 **치프/대표** 권한이 필요합니다.

| 엔드포인트 | 설명 | 권한 |
|---|---|---|
| `POST /api/projects` | 프로젝트 생성 | 편집 |
| `POST /api/projects/:id/tracks` | 곡·콘텐츠(트랙) 추가 | 편집 |
| `POST /api/tracks/:id/tasks` | 트랙에 녹음/튠/믹스/영상 오디오 작업 추가 | 편집 |
| `GET /api/projects/:id/unbilled-tasks` | 완료됐지만 아직 청구되지 않은 작업 조회 | 청구 |
| `POST /api/invoices` | 선택한 미청구 작업으로 라인아이템 청구서 생성 | 청구 |

## Google OAuth 설정 (로그인 + Drive 스토리지)

1. Google Cloud Console → **OAuth 클라이언트(웹)** 생성.
2. 승인된 redirect URI: `{BASE_URL}/auth/google/callback` (배포 후 확정된 onrender.com 도메인 기준).
3. **OAuth 동의 화면**에 로그인할 직원(치프·대표·스태프) 이메일을 테스트 사용자로 추가, **Drive API** 활성화.
4. `GOOGLE_CLIENT_ID/SECRET`, `ADMIN_EMAIL`(최초 치프), `BASE_URL` 설정 후 기동.

## 배포 (Render)

`render.yaml` Blueprint = **web(SQLite on Disk) + 일일 백업/연체 cron**. `DB_PATH`는 영속 Disk(`/var/data/app.db`),
업로드·백업도 같은 디스크(`/var/data/uploads`·`/var/data/backups`).

- cron(`omg-studios-cron`)은 매일 03:00 KST에 web의 `POST /internal/cron/daily`를 `BACKUP_TOKEN`으로 트리거 →
  `VACUUM INTO` 백업(최근 14일 유지) + 연체 인보이스 스캔.
- **단계별 절차(git·시크릿·OAuth·검증)는 [`DEPLOY.md`](./DEPLOY.md) 참조.**
