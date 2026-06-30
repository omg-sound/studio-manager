---
description: 종합 개선점 진단 — 8축 점검·파일:라인 근거·심각도·Top5 (코드 수정 없음)
---

당신은 OMG Studios Manager 코드베이스를 점검하는 시니어 코드 감사자입니다.
목표: 이 레포의 개선점을 "종합적으로" 찾아, 우선순위가 매겨진 리포트를 작성합니다.
코드는 수정하지 말고 진단 리포트만 작성하세요.

## 프로젝트 컨텍스트 (먼저 숙지 — 오탐 방지)
- 스택: Node ≥20, Express 4 (CommonJS), SQLite(better-sqlite3 / node:sqlite 폴백),
  서버 렌더 HTML(src/views*.js) + 클래식 폼 POST + 최소 JS(public/js/app.js), Tailwind.
- 인증: Google OAuth + 화이트리스트, 3단계(owner/chief/staff), httpOnly JWT.
  requireAuth / requireEditor(대표 차단) / requireChief / requireInvoice.
- **내부 전용 도구**: 로그인 직원의 전 프로젝트 열람은 의도된 설계(인가 누락 아님).
- 의도적 설계 — 무조건 지적 금지: better-sqlite3 **동기 API**(소규모 내부도구),
  CSP 인라인 스크립트 0(모든 JS는 app.js), DB CHECK 미사용(config.js 상수가 enum 진실원천),
  돈=정수(원)·날짜="YYYY-MM-DD".
- 이미 처리된 것 재지적 금지: CLAUDE.md "빠진 함정"·"주요 변경 이력"을 먼저 읽을 것
  (CSRF 기본거부·OAuth 논스·SSRF 차단·채번 원자화·세션 청구잠금 등은 이미 해결).

## 작업 방식
1. 레포 구조 파악: CLAUDE.md·WORKFLOW.md·package.json·src/ 전체.
2. 아래 8개 축을 빠짐없이 점검(발견 없으면 "발견 없음" 명시).
3. 모든 지적에 `파일경로:라인` 인용 필수. 인용 없는 지적 금지.
4. 추측 금지. 확인 안 되면 "확인 필요". 없는 문제를 지어내지 말 것.

## 점검 축 (각 축을 표제로)
1. 정확성/버그: 엣지케이스(빈값·음수·중복·null), async/콜백, off-by-one, 깨진 흐름, 폼↔라우트 파라미터 불일치.
2. 보안: 인증/인가 우회(미들웨어 빠진 라우트), SQL 인젝션, 입력 검증 누락, 세션/시크릿, XSS(esc 누락)·CSRF, 업로드/경로.
3. 데이터 무결성: 트랜잭션 경계, 동시 쓰기, 멱등 마이그레이션, FK·CASCADE·SET NULL 정합, 삭제 가드, 스냅샷 일관성.
4. 성능: N+1 쿼리(반복문 안 쿼리), 누락 인덱스, 큰 결과셋, 불필요한 재조회·렌더링.
5. 코드 품질/구조: 비대 파일·함수(특히 src/data.js 1459줄·projects.routes.js 890줄), 중복, 네이밍, 죽은 코드, 모듈 분리.
6. 에러 처리/관측성: 누락 try/catch, 삼켜진 예외, 로깅, 사용자 에러 메시지, fail-safe(알림·외부연동) 검증.
7. 테스트/CI: 테스트·린트·포맷·CI 전무 — 어디부터 테스트가 가장 가치 있는지(청구 채번·VAT·세션 겹침·권한 매트릭스).
8. UX/접근성 + 문서: UI 일관성(공통 헬퍼), 빈/로딩/에러 상태, 모바일(16px)·aria·대비, 문서-코드 불일치.

## 출력 형식
각 항목: **[Critical/High/Medium/Low] 한 줄 요약** → 위치(`파일:라인`) / 문제 / 영향(시나리오) /
제안(코드 스케치 가능) / 확신도(확실·확인 필요).
마지막에 **심각도별 요약 표**와 **Top 5 우선 조치**(영향 대비 수정비용 순).

로컬 확인이 필요하면: `pkill -f "src/server.js"` 후 `DEV_LOGIN=1 node src/server.js`,
POST는 `-H "Origin: http://localhost:3000" -H "Sec-Fetch-Site: same-origin"`, 한글 쿼리는 `--data-urlencode`.
