# 발행 인보이스 → 한국식 거래명세서 PDF 렌더

## Context

청구 기능은 인보이스 생성·발행·입금·채번(`INV-YYYYMM-###`)·VAT 10%·라인아이템 스냅샷(`invoice_items`)까지 동작하지만,
발행된 인보이스를 **출력 가능한 문서**로 내보내는 수단이 없다(CLAUDE.md TODO §3 "청구서 PDF/이미지 렌더(resvg 패턴)").
스튜디오가 클라이언트에게 전달할 **거래명세서**(비공식, 법적 효력 없는 참고용 — 전자세금계산서는 홈택스 발급)를
A4 PDF로 렌더한다. 공급자=스튜디오, 공급받는 자=실결제자(`clients`)의 세금정보를 사용한다.

**결정(사용자 확인됨)**: 렌더 = resvg(SVG→PNG→PDF) · 문서 = 거래명세서만 · 공급자 정보 = 환경설정 탭 + `admin_state`.

## 데이터 출처 (기존 재사용)

- 인보이스 본문: `getInvoiceForUser(user, id)` (`src/data.js:626`) → `invoices.*` + `project_title` + `client_name`.
  단, **buyer 세금정보(`biz_no`/`owner_name`/`address`)는 미포함** → `client_id`로 `clients` 행을 별도 조회.
- 라인아이템 스냅샷: `listInvoiceItemsForInvoice(user, id)` (`src/data.js:442`) → `{ description, quantity, unit_price, amount, track_title, task_type }`.
- 금액: 공급가액 = `amount - tax_amount`, 세액 = `tax_amount`(공급가 10%), 합계 = `amount`. 모두 정수(원). `formatKRW`(`src/views.js`) 재사용.
- 채번: `nextInvoiceNumber(issueDate)` (`src/data.js:451`), `INV-YYYYMM-###`.
- 날짜: `formatYmdShort`(`src/lib/date.js`).

## 변경 사항

### 1. 공급자(스튜디오) 세금정보 저장 — 환경설정 탭
`studio_location`과 동일한 `admin_state` 키-값 패턴(`getState`/`setState`, `src/db.js:406`)을 그대로 따른다.
- 키: `studio_biz_name`(상호), `studio_biz_no`(사업자등록번호), `studio_owner_name`(대표자), `studio_address`(주소),
  `studio_biz_type`(업태), `studio_biz_item`(종목), `studio_tel`(선택).
- `src/routes/settings.routes.js`: `studioCalendarSection()`(line 158)에 공급자 정보 입력 `<form>` 섹션 추가
  + `POST /settings/studio-info`(`requireChief`) 핸들러 추가(기존 `/studio-location` 핸들러와 동형, line 201).
- 헬퍼는 `src/data.js`에 `getStudioInfo()`/`setStudioInfo(body)` 추가(여러 키를 한 번에 읽기·쓰기). 비밀 아님 → 평문 저장.

### 2. 채번 백필 (발행 시 번호 보장)
`nextInvoiceNumber`는 현재 `createInvoiceFromTasks`에서만 호출됨 → 수동 생성/상태변경으로 발행된 인보이스는 `invoice_number`가 없다.
- `src/data.js`에 `ensureInvoiceNumber(inv)` 추가: `status==="발행"` & `invoice_number` 없으면 `nextInvoiceNumber(issued_date)` 부여 후 저장.
- 호출 지점: 인보이스가 **발행으로 전이될 때** — `routes/invoices.routes.js`의 `POST /:id/status`·`POST /:id/pay`·생성/수정 경로에서 status가 발행이면 호출.
  (PDF 렌더 시에도 방어적으로 한 번 더 호출.)

### 3. 거래명세서 렌더 파이프라인 — `src/invoice-pdf.js` (신규)
- **SVG 템플릿**: A4(595×842pt 또는 1240×1754px@150dpi) 고정 그리드 문자열을 자바스크립트 템플릿 리터럴로 작성.
  상단: 문서명("거래명세서") + 청구번호 + 발행일. 좌/우 박스: 공급자 / 공급받는 자(상호·사업자번호·대표자·주소·업태/종목).
  중단: 라인아이템 표(품목=`description`/`track_title`, 수량, 단가, 공급가액) — 행 높이 고정, N행 페이지네이션은 **단일 페이지 + 행 수 상한**으로 시작(초과 시 폰트 축소/생략 표기, `log`로 경고).
  하단: 공급가액 합계 · 부가세(10%) · 합계금액 + 한글 금액 표기(선택). 모든 사용자 데이터는 **SVG 이스케이프**(`&<>"`; 기존 `esc`는 HTML용이라 SVG용 별도 이스케이프 함수 필요 — `&`,`<`,`>`,`"`,`'` 처리).
- **resvg 렌더**: `@resvg/resvg-js`의 `Resvg(svg, { font: { fontFiles, defaultFontFamily }, fitTo })` → `render().asPng()`로 PNG 버퍼.
- **PDF 래핑**: `pdf-lib`로 A4 PDF 1장 생성 → `embedPng` → 페이지 전체에 배치 → `save()`로 PDF 버퍼.
  (이미지 임베드 = 텍스트 비선택. 사용자 합의됨.)

### 4. 한글 폰트 처리 (핵심)
- 현재 폰트는 **전부 Google Fonts CDN**(`src/views.js` `FONT_LINKS`) — resvg는 CDN을 못 읽으므로 **로컬 TTF 번들 필수**.
- `public/fonts/`(신규)에 한글 TTF 1종 배치: **Noto Sans KR**(또는 Pretendard) Regular/Bold. 라이선스=OFL(재배포 가능).
  - 용량 절감: 필요한 굵기(Regular/Bold)만, 가능하면 `pyftsubset`로 한글 상용 + 라틴 + 숫자 + 기호 서브셋(수십 KB~수백 KB).
  - 단, 클라이언트명/주소에 희귀 한자·특수문자가 올 수 있어 **과한 서브셋은 □(두부) 위험** → 한글 전체(KS X 1001 11,172자)는 유지 권장, 라틴/한자만 신중히.
- resvg에 `fontFiles: [Regular, Bold]` 명시 로드, `defaultFontFamily: "Noto Sans KR"`. SVG `font-family`도 동일 지정.
- 빌드 영향 없음(Tailwind와 무관). Render Disk가 아닌 **레포 커밋 자산**으로 배포(정적 자산처럼).

### 5. 라우트 · 보안
- `GET /invoices/:id/statement.pdf` (`requireInvoice`) 추가(`src/routes/invoices.routes.js`):
  - `getInvoiceForUser` → 없으면 404. **`status !== "발행"`이면 거부**(미발행 견적은 명세서 발급 불가)하거나 경고 — 요구사항은 "발행 인보이스".
  - `ensureInvoiceNumber` → buyer `clients` 조회 → `getStudioInfo()` → 아이템 → `src/invoice-pdf.js`로 버퍼 생성.
  - 응답 헤더: `Content-Type: application/pdf`,
    `Content-Disposition: inline; filename*=UTF-8''${encodeURIComponent(번호)}.pdf`,
    **`Cache-Control: private, no-store`**(deliverables `sendFile` 패턴, `routes/deliverables.routes.js:229` 참고).
- 상세 화면(`routes/invoices.routes.js:141` adminControls)에 **"거래명세서 PDF"** 링크 버튼 추가(발행 상태일 때만 노출).

### 6. CSP / 미들웨어 영향
- **HTML→PDF가 아니므로 CSP 무관**: 응답은 `application/pdf` 바이너리. helmet CSP(`src/server.js`)의 `styleSrc`/`scriptSrc` 예외 **불필요**.
- 라우트는 `express.static`보다 앞(이미 `/invoices` 라우터가 static 앞에 마운트됨). 동일출처 검사는 GET이라 무관.

### 7. 비밀 · 암호화 영향
- **at-rest 암호화 불필요**: 공급자 정보(상호·사업자번호 등)는 비밀이 아님 → `db.encrypt`(AES-256-GCM, refresh token 전용) 대상 아님. 평문 `admin_state` 저장(`studio_location`과 동급).
- **PII 주의**: PDF에 buyer 사업자번호·주소·금액 포함 → 민감. 따라서
  - **공개 토큰 링크(`/d/:token`) 흐름 재사용 금지** — 인증 없는 노출 위험. 반드시 `requireInvoice` 게이트.
  - `Cache-Control: private, no-store`로 프록시/브라우저 캐시 방지.
  - Drive/`deliverables` 테이블에 영속 저장하지 않고 **요청 시 즉석 생성·스트리밍**(영속 PII 사본 최소화). 디스크 임시파일 없이 메모리 버퍼.
- 새 env/비밀 추가 없음.

### 8. 의존성
- `@resvg/resvg-js`(prebuilt 네이티브, Render Node 20/22 호환), `pdf-lib`(순수 JS). `package.json` `dependencies`에 추가.
  - better-sqlite3 함정(§빠진 함정 2)과 동일하게 prebuilt 우선 — resvg는 플랫폼별 prebuilt 제공. 빌드 실패 시 `optionalDependencies` 고려는 보류(렌더 핵심 기능이라 필수 의존).

## 변경 파일 요약
- `src/invoice-pdf.js` — 신규: SVG 템플릿 + resvg 렌더 + pdf-lib 래핑 + SVG 이스케이프.
- `src/data.js` — `getStudioInfo`/`setStudioInfo`, `ensureInvoiceNumber` 추가.
- `src/routes/invoices.routes.js` — `GET /:id/statement.pdf` 라우트 + 상세 PDF 버튼 + 발행 전이 시 채번.
- `src/routes/settings.routes.js` — 환경설정 탭 공급자 정보 폼 + `POST /studio-info`.
- `public/fonts/NotoSansKR-Regular.ttf`·`-Bold.ttf` — 신규 번들(OFL).
- `package.json` — `@resvg/resvg-js`, `pdf-lib` 추가.

## 검증 (CLAUDE.md §검증 패턴 준수)
1. **로컬 기동**: 기존 유휴 서버 정리(`pkill -f "src/server.js"`, 함정 §5) → `DEV_LOGIN=1 npm start`.
2. **공급자 정보 입력**: `/settings?tab=settings`에서 상호·사업자번호·대표자·주소 저장 → `admin_state` 반영 확인.
3. **데이터 준비**: 작업→청구 생성으로 발행 인보이스 + `invoice_items` 스냅샷 확보(또는 수동 생성 후 발행). 채번(`INV-YYYYMM-###`) 부여 확인.
4. **PDF 렌더**: 브라우저 헤더(Sec-Fetch-Site·쿠키)로 `GET /invoices/:id/statement.pdf` 호출 → 200 + `application/pdf`.
   - 저장해 PDF 뷰어로 열어 **한글(상호·아티스트·품목)이 □ 없이** 표시되는지 확인(폰트 번들 핵심 검증).
   - 공급가액 + VAT(10%) = 합계 산식, 청구번호, 발행일, 공급자/공급받는자 세금정보, 라인아이템 일치 확인.
5. **권한**: 비로그인/`requireInvoice` 미충족 시 거부, 미발행 인보이스는 발급 거부 확인.
6. **헤더**: `Cache-Control: private, no-store`, `Content-Disposition: inline; filename*=UTF-8''...` 확인.
7. **회귀**: 기존 인보이스 목록/상세/입금/상태 전이 정상 동작(채번 백필이 기존 흐름 깨지 않는지).
