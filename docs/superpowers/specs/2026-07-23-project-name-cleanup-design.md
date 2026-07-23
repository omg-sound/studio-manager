# 프로젝트 이름 정리 — `omg-studios-manager` → `omg-studios-erp` (설계)

날짜: 2026-07-23 · 요청: 사용자("초기에 ERP를 omg-studios-manager로 불렀던 잔재 전수 정리")

## 배경

`omg-studios-manager`는 표준 호칭 'ERP' 확정(2026-07-17) 이전의 **초기 명명 잔재**다.
사용자 노출 UI는 이미 ERP / OMG Studios로 정리 완료됐고, 남은 잔재는 **개발·인프라·문서 계층**에만 있다.

## 핵심 원칙 — 이름은 하나가 아니라 계층별로 갈린다

| 계층 | 이름 | 상태 |
|---|---|---|
| 사용자 노출 UI·제품 호칭 | **ERP** (브랜드 워드마크 **OMG Studios** 유지) | 기존·불변 |
| 로컬·개발 정체성 (폴더·`package.json`/`package-lock.json` name·GitHub 저장소) | **`omg-studios-erp`** | ← 이번 통일 |
| 배포·데이터 인프라 (`render.yaml` 서비스명·`*.onrender.com` URL·Drive 루트 폴더) | **`omg-studios-manager`** | 동결(불변) |
| GCP 프로젝트 | `omg-studio-manager` | 동결(무관 자원) |

**왜 인프라는 동결하나:** Render 서비스명을 바꾸면 `omg-studios-manager.onrender.com`이 바뀌어
커스텀 도메인 `erp.omgworks.kr`의 CNAME 대상이 깨지고(DNS 재설정), Blueprint 이름 매칭이 어긋나며,
Drive 루트 폴더명을 바꾸면 앱이 빈 폴더를 새로 만들어 **프로덕션 첨부·자료를 못 본다**.
사용자에게 보이지 않는 계층이라 이득 0 · 순수 리스크. 그래서 로컬·개발 계층만 통일한다.

## 변경 목록

### in-repo (커밋)
- `package.json` — `"name"`: `omg-studios-manager` → `omg-studios-erp`
- `package-lock.json` — `"name"` 2곳(top·`packages[""]`): 동일 rename (package.json과 동기 → `npm ci` 정합)
- `CLAUDE.md` 표준호칭 섹션 — 동결 문구를 위 '계층별' 사실로 갱신
- `DEPLOY.md` — `github.com/omg-sound/studio-manager` → `…/omg-studios-erp` (L13·L32·L40)
- 이 spec 문서

### outward (외부 자원)
- **GitHub repo rename**: `gh repo rename omg-studios-erp -R omg-sound/studio-manager`
  - 되돌리기 가능 · GitHub가 옛 URL 자동 리다이렉트 · Render는 repo를 **ID**로 추적하므로 무영향 ·
    배포 hook은 **서비스 ID** 기반이라 무영향 · CI(`ci.yml`)에 repo명 하드코딩 없음
- **로컬 remote 갱신**: `git remote set-url origin https://github.com/omg-sound/omg-studios-erp.git`

### manual (사용자, 세션 밖)
- 폴더 rename: `mv ~/Projects/omg-studios-manager ~/Projects/omg-studios-erp` 후 새 경로에서 세션 재개
  - 캐비앗: Claude 프로젝트 메모리·세션 히스토리는 폴더 경로 기반 → 새 경로는 새 슬롯. (원하면
    `.claude/projects/<옛슬롯>/memory`를 새 슬롯으로 복사 가능 — 선택)
  - `.git`·node_modules·로컬 DB는 폴더와 함께 이동(원격·의존성 무영향). repo 내 폴더 절대경로 하드코딩 없음(확인 완료).

## 유지(동결) — 바꾸면 깨짐, 의도적으로 안 건드림

- `render.yaml` 서비스명 `omg-studios-manager` + cron `fromService.name`
- 문서·테스트의 `omg-studios-manager.onrender.com` URL 참조(동결 서비스에서 파생된 실주소 — 바꾸면 없는 주소를 가리킴)
- `src/drive.js` Drive 루트 폴더 + `deliverables.routes.js` 주석(프로덕션 데이터)
- `DEPLOY.md`의 Render 서비스명·CNAME·Drive 백업 경로 참조
- `src/seed.js`의 `studioManager` 변수(시드용 담당자 '스튜디오 관리자' — 프로젝트명과 무관)
- GCP 프로젝트 `omg-studio-manager`

## 실행 순서

1. in-repo 편집 → `npm test`(671) 통과 확인 → commit
2. `gh repo rename` → `git remote set-url` → `git push`(새 remote로 검증)
3. (사용자) 폴더 mv → 새 경로에서 세션 재개

## 리스크·검증

- 리스크: GitHub rename 저위험(리다이렉트·ID 추적). autoDeploy off라 push는 배포 아님.
- 검증: `npm test` 통과 유지(변경이 name 문자열뿐 런타임 무영향), `git push` 성공, `git remote -v` 새 URL 확인.
