# 카카오톡 청구 발행 알림 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 청구 탭에서 청구가 생성(발행)되는 순간, 스튜디오가 지정한 카카오 계정 1곳으로 카카오톡 "나에게 보내기" 알림을 보낸다.

**Architecture:** 카카오 연동을 독립 모듈 `src/kakao.js`로 두고(drive.js/calendar.js와 같은 격), `notify.js` 디스패치가 `invoice_issued` 이벤트에서만 카카오로 라우팅한다. 웹훅 경로는 무변경. 토큰은 admin_state에 AES-256-GCM 암호화 저장·자동 갱신하고, 일일 cron이 keep-alive로 유지한다.

**Tech Stack:** Node ≥20, Express 4(CommonJS), better-sqlite3/node:sqlite, `node:test`(내장), 카카오 REST API(kauth.kakao.com·kapi.kakao.com), 전역 `fetch`.

## Global Constraints

- **fail-safe**: 카카오 관련 모든 함수는 절대 throw하지 않는다(청구 생성·cron을 막지 않음). 오류는 `console.warn`으로 흡수.
- **비밀 at-rest 암호화**: 토큰은 `db.encrypt`/`decrypt`(AES-256-GCM)로 admin_state에 저장. 평문 저장 금지(닉네임만 평문 표시용).
- **돈=정수(원)**, 날짜="YYYY-MM-DD" 문자열. 카카오 텍스트 `text`는 **≤ 200자**(초과 절단).
- **CSRF**: OAuth 콜백은 state 랜덤 논스 + httpOnly 쿠키 대조(구글 OAuth `_oauth_nonce` 패턴 재사용, 쿠키명 `_kakao_nonce`).
- **권한**: 카카오 연동·해제·테스트·인증 라우트는 전부 `requireChief`(외부 발송 경로라 민감, 웹훅과 동일).
- **테스트**: 실제 카카오 HTTP 호출은 mock(전역 `fetch` 대체). `npm test` = `node --test test/*.test.js`. 격리 임시 DB 셋업은 기존 테스트 헤더 패턴 사용.
- **의존성 0 원칙**: 새 npm 패키지 추가 금지(fetch·crypto 내장만 사용). 유일한 테스트 devDep은 기존 jsdom뿐.
- **커밋 메시지**: 끝에 `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`.
- **배포 주의**: main 커밋 = 자동배포. 이 계획은 격리 워크트리에서 완성 후 합친다(미완 상태 main 커밋 금지).

## File Structure

- **Create `src/kakao.js`** — 카카오 연동 자기완결 모듈. OAuth URL 조립·코드 교환·토큰 저장/갱신·`sendToMe`·연동 상태·해제·keep-alive. 의존: `db`(encrypt/decrypt/getState/setState)·`config`. 다른 도메인 함수 미호출.
- **Create `test/kakao.test.js`** — kakao 모듈 단위 테스트(격리 DB + fetch mock).
- **Modify `src/config.js`** — `config.kakao`(restApiKey·clientSecret·redirectUri getter) + `config.kakaoConfigured` 파생 플래그.
- **Modify `src/notify.js`** — `notify(event)`가 `invoice_issued`일 때 `kakao.sendToMe(...)`도 호출 + `formatKakaoText(event)` 인라인 포매터.
- **Create `test/notify-kakao.test.js`** — 디스패치 라우팅(invoice_issued만 카카오)·포매터·fail-safe 테스트.
- **Modify `src/routes/auth.routes.js`** — `GET /auth/kakao`(인증 시작·requireChief)·`GET /auth/kakao/callback`(state 대조·토큰 저장).
- **Modify `src/views.settings.js`** — `kakaoAlertSection(chief)` 렌더 함수 추가(웹훅 섹션 옆).
- **Modify `src/routes/settings.routes.js`** — 알림 탭에 카카오 섹션 배선 + `POST /settings/kakao/disconnect`·`POST /settings/kakao/test`.
- **Modify `src/lib/maintenance.js`** — `runDailyMaintenance`에 `kakao.keepAlive()` 추가(fail-safe·비차단).
- **Modify `CLAUDE.md`** — 데이터 모델(admin_state 카카오 키)·env(KAKAO_*)·알림 섹션 현행화.
- **Modify `.env.example`**(있으면) / `DEPLOY.md` — 카카오 앱 등록·env 안내(사전 준비).

---

## Task 1: config에 카카오 설정 노출

**Files:**
- Modify: `src/config.js` (config 객체에 `kakao` 추가 + 파생 플래그)

**Interfaces:**
- Consumes: 기존 `baseUrl`(module 상단 상수), `config` 객체.
- Produces:
  - `config.kakao.restApiKey: string`
  - `config.kakao.clientSecret: string`
  - `config.kakao.redirectUri: string`(getter, `{baseUrl}/auth/kakao/callback`)
  - `config.kakaoConfigured: boolean`(restApiKey 존재 여부)

- [ ] **Step 1: config.js에 kakao 블록 추가**

`src/config.js`에서 `google: { ... },` 블록 **바로 아래**에 추가:

```javascript
  kakao: {
    restApiKey: process.env.KAKAO_REST_API_KEY || "",
    clientSecret: process.env.KAKAO_CLIENT_SECRET || "", // 선택(카카오 앱에서 client secret 사용 시)
    get redirectUri() {
      return `${baseUrl.replace(/\/+$/, "")}/auth/kakao/callback`;
    },
  },
```

- [ ] **Step 2: 파생 플래그 추가**

`src/config.js`에서 `config.googleConfigured = Boolean(...)` 줄 **바로 아래**에 추가:

```javascript
config.kakaoConfigured = Boolean(config.kakao.restApiKey);
```

- [ ] **Step 3: 로드 확인**

Run: `node -e 'const {config}=require("./src/config");console.log("kakaoConfigured=",config.kakaoConfigured,"redirect=",config.kakao.redirectUri)'`
Expected: `kakaoConfigured= false redirect= http://localhost:3000/auth/kakao/callback` (env 미설정 기준)

- [ ] **Step 4: Commit**

```bash
git add src/config.js
git commit -m "feat(kakao): config에 카카오 REST 키·redirect·kakaoConfigured 노출

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 2: kakao.js — 토큰 저장/조회 + 연동 상태

**Files:**
- Create: `src/kakao.js`
- Test: `test/kakao.test.js`

**Interfaces:**
- Consumes: `config.kakao`·`config.kakaoConfigured`(Task 1), `db.getState/setState/encrypt/decrypt`.
- Produces (이 태스크 범위):
  - `saveTokens({ refreshToken, accessToken, expiresInSec, nickname }): void` — admin_state에 암호화 저장(refresh·access 암호화, nickname·linkedAt·expiresAt 평문/ISO). `kakao_expired` 플래그 해제.
  - `getLinkStatus(): { linked: boolean, nickname: string|null, linkedAt: string|null, expired: boolean, configured: boolean }`
  - `isLinked(): boolean` — refresh token 존재 && !expired.
  - `disconnect(): void` — 저장 키 전부 삭제.
  - admin_state 키 상수: `kakao_refresh_token`·`kakao_access_token`·`kakao_access_expires_at`·`kakao_nickname`·`kakao_linked_at`·`kakao_expired`.

- [ ] **Step 1: Write the failing test**

Create `test/kakao.test.js`:

```javascript
"use strict";
process.env.NODE_ENV = "test";
const { tempDbPath, cleanupDb } = require("./helpers");
process.env.DB_PATH = tempDbPath();

const test = require("node:test");
const assert = require("node:assert");
const { db, init } = require("../src/db");
init();
const kakao = require("../src/kakao");

test.after(() => cleanupDb(process.env.DB_PATH, db()));

test("saveTokens·getLinkStatus·disconnect 왕복", () => {
  assert.equal(kakao.isLinked(), false, "초기 미연동");
  assert.deepEqual(
    { linked: kakao.getLinkStatus().linked, expired: kakao.getLinkStatus().expired },
    { linked: false, expired: false }
  );
  kakao.saveTokens({ refreshToken: "rt_abc", accessToken: "at_xyz", expiresInSec: 21600, nickname: "김보종" });
  assert.equal(kakao.isLinked(), true, "저장 후 연동됨");
  const st = kakao.getLinkStatus();
  assert.equal(st.linked, true);
  assert.equal(st.nickname, "김보종");
  assert.equal(st.expired, false);
  assert.ok(st.linkedAt, "linkedAt 기록");
  // 저장은 암호화(admin_state 평문에 원문 노출 안 됨)
  const raw = db().prepare("SELECT value FROM admin_state WHERE key='kakao_refresh_token'").get().value;
  assert.ok(!String(raw).includes("rt_abc"), "refresh token 암호화 저장");
  kakao.disconnect();
  assert.equal(kakao.isLinked(), false, "해제 후 미연동");
  assert.equal(kakao.getLinkStatus().nickname, null);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/kakao.test.js`
Expected: FAIL — `Cannot find module '../src/kakao'`

- [ ] **Step 3: Create src/kakao.js with storage layer**

Create `src/kakao.js`:

```javascript
"use strict";

/**
 * 카카오톡 "나에게 보내기" 연동 — 청구 발행 알림 채널(대표가 슬랙·디스코드 미사용).
 * drive.js/calendar.js와 같은 격의 독립 연동 모듈. 토큰은 admin_state에 AES-256-GCM 암호화 저장.
 *
 * 설계 원칙:
 *  - fail-safe: 발송·갱신은 절대 throw하지 않는다(청구 생성·cron 비차단). 오류는 console.warn 흡수.
 *  - 수신자 = 앱을 카카오로 인증한 그 계정 본인(스튜디오 전체 1개, send-to-me 제약).
 *  - 토큰 자동 갱신(액세스 ~6h·리프레시 ~2개월), 갱신 실패 시 연동 만료 표시.
 */

const { getState, setState, encrypt, decrypt } = require("./db");
const { config } = require("./config");

const K_REFRESH = "kakao_refresh_token";       // 암호화
const K_ACCESS = "kakao_access_token";         // 암호화
const K_EXPIRES = "kakao_access_expires_at";   // ISO(평문)
const K_NICKNAME = "kakao_nickname";           // 평문(표시용)
const K_LINKED_AT = "kakao_linked_at";         // ISO(평문)
const K_EXPIRED = "kakao_expired";             // "1"이면 연동 만료(재연동 필요)

/** 토큰·프로필 저장(연동/갱신 공통). expiresInSec 기준으로 만료 시각 계산. */
function saveTokens({ refreshToken, accessToken, expiresInSec, nickname } = {}) {
  if (refreshToken) setState(K_REFRESH, encrypt(refreshToken)); // 카카오는 회전 시에만 새 refresh 발급 → 있을 때만 갱신
  if (accessToken) setState(K_ACCESS, encrypt(accessToken));
  if (expiresInSec) setState(K_EXPIRES, new Date(Date.now() + Number(expiresInSec) * 1000).toISOString());
  if (nickname != null) setState(K_NICKNAME, String(nickname));
  if (!getState(K_LINKED_AT)) setState(K_LINKED_AT, new Date().toISOString());
  setState(K_EXPIRED, null); // 성공 저장 = 만료 해제
}

function getRefreshToken() { return decrypt(getState(K_REFRESH)); }

function isLinked() {
  return Boolean(getRefreshToken()) && getState(K_EXPIRED) !== "1";
}

function getLinkStatus() {
  return {
    configured: config.kakaoConfigured,
    linked: isLinked(),
    nickname: getState(K_NICKNAME) || null,
    linkedAt: getState(K_LINKED_AT) || null,
    expired: getState(K_EXPIRED) === "1",
  };
}

/** 연동 해제 — 저장 키 전부 삭제(카카오 unlink API는 Task에서 best-effort로 추가). */
function disconnect() {
  [K_REFRESH, K_ACCESS, K_EXPIRES, K_NICKNAME, K_LINKED_AT, K_EXPIRED].forEach((k) => setState(k, null));
}

module.exports = {
  saveTokens,
  getLinkStatus,
  isLinked,
  disconnect,
  // 내부 상수(테스트·후속 태스크에서 참조)
  _keys: { K_REFRESH, K_ACCESS, K_EXPIRES, K_NICKNAME, K_LINKED_AT, K_EXPIRED },
};
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/kakao.test.js`
Expected: PASS (1 test)

- [ ] **Step 5: Commit**

```bash
git add src/kakao.js test/kakao.test.js
git commit -m "feat(kakao): 토큰 암호화 저장·연동 상태·해제(saveTokens/getLinkStatus/disconnect)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 3: kakao.js — OAuth URL 조립 + 코드 교환

**Files:**
- Modify: `src/kakao.js`
- Test: `test/kakao.test.js` (테스트 추가)

**Interfaces:**
- Consumes: Task 2의 `saveTokens`, `config.kakao`.
- Produces:
  - `getAuthUrl(state: string): string` — 카카오 인가 URL(`https://kauth.kakao.com/oauth/authorize?...scope=talk_message`).
  - `async exchangeCode(code: string): Promise<{ ok: boolean, nickname?: string, error?: string }>` — 코드→토큰 교환 + 프로필 조회 + `saveTokens`. fail-safe(throw 없음).

- [ ] **Step 1: Write the failing test (fetch mock)**

`test/kakao.test.js`에 추가:

```javascript
test("getAuthUrl: scope talk_message + redirect + state 포함", () => {
  process.env.KAKAO_REST_API_KEY = "test_key";
  delete require.cache[require.resolve("../src/config")];
  delete require.cache[require.resolve("../src/kakao")];
  const k = require("../src/kakao");
  const url = k.getAuthUrl("nonce123");
  assert.ok(url.startsWith("https://kauth.kakao.com/oauth/authorize?"));
  assert.ok(url.includes("scope=talk_message"));
  assert.ok(url.includes("response_type=code"));
  assert.ok(url.includes("state=nonce123"));
  assert.ok(url.includes("client_id=test_key"));
});

test("exchangeCode: 토큰 교환 + 프로필 닉네임 저장(fetch mock)", async () => {
  process.env.KAKAO_REST_API_KEY = "test_key";
  delete require.cache[require.resolve("../src/config")];
  delete require.cache[require.resolve("../src/kakao")];
  const k = require("../src/kakao");
  const origFetch = global.fetch;
  global.fetch = async (url) => {
    if (String(url).includes("/oauth/token")) {
      return { ok: true, json: async () => ({ access_token: "AT1", refresh_token: "RT1", expires_in: 21600 }) };
    }
    if (String(url).includes("/v2/user/me")) {
      return { ok: true, json: async () => ({ properties: { nickname: "치프엔지" } }) };
    }
    throw new Error("unexpected url " + url);
  };
  try {
    const r = await k.exchangeCode("code_abc");
    assert.equal(r.ok, true);
    assert.equal(r.nickname, "치프엔지");
    assert.equal(k.getLinkStatus().nickname, "치프엔지");
    assert.equal(k.isLinked(), true);
  } finally {
    global.fetch = origFetch;
  }
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/kakao.test.js`
Expected: FAIL — `k.getAuthUrl is not a function`

- [ ] **Step 3: Add getAuthUrl + exchangeCode to src/kakao.js**

`src/kakao.js`의 상수 정의 아래에 추가:

```javascript
const AUTH_BASE = "https://kauth.kakao.com";
const API_BASE = "https://kapi.kakao.com";

/** 카카오 인가 URL — scope talk_message(나에게 보내기). state=CSRF 논스. */
function getAuthUrl(state) {
  const p = new URLSearchParams({
    client_id: config.kakao.restApiKey,
    redirect_uri: config.kakao.redirectUri,
    response_type: "code",
    scope: "talk_message",
    state: String(state || ""),
  });
  return `${AUTH_BASE}/oauth/authorize?${p.toString()}`;
}

/** 인가 코드 → 토큰 교환 + 프로필 닉네임 조회 + 저장. fail-safe(throw 없음). */
async function exchangeCode(code) {
  try {
    const body = new URLSearchParams({
      grant_type: "authorization_code",
      client_id: config.kakao.restApiKey,
      redirect_uri: config.kakao.redirectUri,
      code: String(code || ""),
    });
    if (config.kakao.clientSecret) body.append("client_secret", config.kakao.clientSecret);
    const tokRes = await fetch(`${AUTH_BASE}/oauth/token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: body.toString(),
      signal: AbortSignal.timeout(8000),
    });
    const tok = await tokRes.json();
    if (!tokRes.ok || !tok.refresh_token) {
      return { ok: false, error: `token ${tokRes.status} ${tok.error || ""}` };
    }
    // 프로필(닉네임) — 표시용. 실패해도 연동은 성립(닉네임 없이 저장).
    let nickname = null;
    try {
      const meRes = await fetch(`${API_BASE}/v2/user/me`, {
        method: "GET",
        headers: { Authorization: `Bearer ${tok.access_token}` },
        signal: AbortSignal.timeout(8000),
      });
      const me = await meRes.json();
      nickname = (me && me.properties && me.properties.nickname) || null;
    } catch (_e) { /* 닉네임 없이 진행 */ }
    saveTokens({ refreshToken: tok.refresh_token, accessToken: tok.access_token, expiresInSec: tok.expires_in, nickname });
    return { ok: true, nickname };
  } catch (e) {
    console.warn("[kakao] exchangeCode 실패:", e && e.message ? e.message : String(e));
    return { ok: false, error: e && e.message ? e.message : String(e) };
  }
}
```

module.exports에 `getAuthUrl, exchangeCode,` 추가.

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/kakao.test.js`
Expected: PASS (3 tests)

- [ ] **Step 5: Commit**

```bash
git add src/kakao.js test/kakao.test.js
git commit -m "feat(kakao): OAuth 인가 URL·코드 교환(getAuthUrl/exchangeCode) fetch mock 테스트

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 4: kakao.js — 액세스 토큰 자동 갱신

**Files:**
- Modify: `src/kakao.js`
- Test: `test/kakao.test.js`

**Interfaces:**
- Consumes: Task 2/3 저장 키·`saveTokens`·`getRefreshToken`.
- Produces:
  - `async getAccessToken(): Promise<string|null>` — 유효 액세스 토큰 반환. 만료(또는 5분 이내 근접)면 리프레시로 갱신. 갱신 실패(`invalid_grant`)면 `kakao_expired=1` 세팅 후 null. 미연동이면 null.
  - `async keepAlive(): Promise<{ ok: boolean, skipped?: string }>` — 강제 갱신(cron용). 미연동이면 skip.

- [ ] **Step 1: Write the failing test**

`test/kakao.test.js`에 추가:

```javascript
test("getAccessToken: 유효하면 그대로, 만료면 갱신, invalid_grant면 만료 표시", async () => {
  process.env.KAKAO_REST_API_KEY = "test_key";
  delete require.cache[require.resolve("../src/config")];
  delete require.cache[require.resolve("../src/kakao")];
  const k = require("../src/kakao");
  // 유효 토큰 저장(1시간 남음) → 갱신 안 함
  k.saveTokens({ refreshToken: "RT1", accessToken: "ATvalid", expiresInSec: 3600, nickname: "n" });
  const origFetch = global.fetch;
  let refreshCalls = 0;
  global.fetch = async () => { refreshCalls++; return { ok: true, json: async () => ({ access_token: "ATnew", expires_in: 21600 }) }; };
  try {
    assert.equal(await k.getAccessToken(), "ATvalid", "유효하면 갱신 없이 반환");
    assert.equal(refreshCalls, 0);
    // 만료로 강제 → 갱신 호출
    const { setState } = require("../src/db");
    setState("kakao_access_expires_at", new Date(Date.now() - 1000).toISOString());
    assert.equal(await k.getAccessToken(), "ATnew", "만료면 갱신 후 새 토큰");
    assert.equal(refreshCalls, 1);
    // invalid_grant → 만료 표시 + null
    setState("kakao_access_expires_at", new Date(Date.now() - 1000).toISOString());
    global.fetch = async () => ({ ok: false, status: 400, json: async () => ({ error: "invalid_grant" }) });
    assert.equal(await k.getAccessToken(), null, "갱신 실패 시 null");
    assert.equal(k.getLinkStatus().expired, true, "연동 만료 표시");
    assert.equal(k.isLinked(), false);
  } finally {
    global.fetch = origFetch;
  }
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/kakao.test.js`
Expected: FAIL — `k.getAccessToken is not a function`

- [ ] **Step 3: Add getAccessToken + refresh + keepAlive**

`src/kakao.js`에 추가:

```javascript
const EXPIRY_MARGIN_MS = 5 * 60 * 1000; // 만료 5분 전이면 미리 갱신

function accessValid() {
  const at = decrypt(getState(K_ACCESS));
  const exp = getState(K_EXPIRES);
  if (!at || !exp) return null;
  return Date.parse(exp) - Date.now() > EXPIRY_MARGIN_MS ? at : null;
}

/** 리프레시 토큰으로 액세스 토큰 갱신. 성공 시 저장, 실패 시 만료 표시. 반환=새 토큰 또는 null. */
async function refreshAccess() {
  const refresh = getRefreshToken();
  if (!refresh) return null;
  try {
    const body = new URLSearchParams({
      grant_type: "refresh_token",
      client_id: config.kakao.restApiKey,
      refresh_token: refresh,
    });
    if (config.kakao.clientSecret) body.append("client_secret", config.kakao.clientSecret);
    const res = await fetch(`${AUTH_BASE}/oauth/token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: body.toString(),
      signal: AbortSignal.timeout(8000),
    });
    const tok = await res.json();
    if (!res.ok || !tok.access_token) {
      // invalid_grant = 사용자 해제 or 리프레시 만료 → 재연동 필요
      if (tok && tok.error === "invalid_grant") setState(K_EXPIRED, "1");
      console.warn("[kakao] 토큰 갱신 실패:", res.status, tok && tok.error);
      return null;
    }
    // 카카오는 리프레시 토큰이 1개월 미만 남았을 때만 새 refresh_token 발급 → 있을 때만 교체.
    saveTokens({ refreshToken: tok.refresh_token, accessToken: tok.access_token, expiresInSec: tok.expires_in });
    return tok.access_token;
  } catch (e) {
    console.warn("[kakao] 토큰 갱신 예외:", e && e.message ? e.message : String(e));
    return null;
  }
}

/** 유효 액세스 토큰 반환(만료면 자동 갱신). 미연동·갱신 실패면 null. */
async function getAccessToken() {
  if (!isLinked()) return null;
  return accessValid() || (await refreshAccess());
}

/** cron용 keep-alive 강제 갱신 — 청구가 오래 없어도 리프레시 토큰을 2개월 안에 계속 연장. */
async function keepAlive() {
  if (!isLinked()) return { ok: false, skipped: "not_linked" };
  const at = await refreshAccess();
  return { ok: Boolean(at) };
}
```

module.exports에 `getAccessToken, keepAlive,` 추가.

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/kakao.test.js`
Expected: PASS (4 tests)

- [ ] **Step 5: Commit**

```bash
git add src/kakao.js test/kakao.test.js
git commit -m "feat(kakao): 액세스 토큰 자동 갱신·keepAlive(만료 판정·invalid_grant 만료 표시)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 5: kakao.js — sendToMe(나에게 보내기)

**Files:**
- Modify: `src/kakao.js`
- Test: `test/kakao.test.js`

**Interfaces:**
- Consumes: Task 4 `getAccessToken`.
- Produces:
  - `async sendToMe({ text: string, url?: string, buttonTitle?: string }): Promise<{ ok: boolean, skipped?: string }>` — 텍스트 템플릿으로 카카오 memo API 전송. text는 200자 절단. 미연동·토큰 없음이면 skip. fail-safe.

- [ ] **Step 1: Write the failing test**

`test/kakao.test.js`에 추가:

```javascript
test("sendToMe: 미연동이면 skip, 연동이면 memo API에 텍스트 템플릿 전송", async () => {
  process.env.KAKAO_REST_API_KEY = "test_key";
  delete require.cache[require.resolve("../src/config")];
  delete require.cache[require.resolve("../src/kakao")];
  const k = require("../src/kakao");
  k.disconnect();
  assert.deepEqual(await k.sendToMe({ text: "hi" }), { ok: false, skipped: "not_linked" }, "미연동 skip");

  k.saveTokens({ refreshToken: "RT1", accessToken: "ATvalid", expiresInSec: 3600, nickname: "n" });
  const origFetch = global.fetch;
  let sent = null;
  global.fetch = async (url, init) => {
    sent = { url: String(url), body: init.body };
    return { ok: true, json: async () => ({ result_code: 0 }) };
  };
  try {
    const r = await k.sendToMe({ text: "청구 발행\nOMG-1", url: "https://x/invoices/1", buttonTitle: "청구서 보기" });
    assert.equal(r.ok, true);
    assert.ok(sent.url.includes("/v2/api/talk/memo/default/send"), "memo API 호출");
    const params = new URLSearchParams(sent.body);
    const tpl = JSON.parse(params.get("template_object"));
    assert.equal(tpl.object_type, "text");
    assert.ok(tpl.text.includes("OMG-1"));
    assert.equal(tpl.link.web_url, "https://x/invoices/1");
    assert.equal(tpl.button_title, "청구서 보기");
  } finally {
    global.fetch = origFetch;
  }
});

test("sendToMe: text 200자 초과 절단", async () => {
  process.env.KAKAO_REST_API_KEY = "test_key";
  delete require.cache[require.resolve("../src/config")];
  delete require.cache[require.resolve("../src/kakao")];
  const k = require("../src/kakao");
  k.saveTokens({ refreshToken: "RT1", accessToken: "ATvalid", expiresInSec: 3600 });
  const origFetch = global.fetch;
  let tplText = null;
  global.fetch = async (url, init) => { tplText = JSON.parse(new URLSearchParams(init.body).get("template_object")).text; return { ok: true, json: async () => ({}) }; };
  try {
    await k.sendToMe({ text: "가".repeat(300) });
    assert.ok(tplText.length <= 200, "200자 이하로 절단");
  } finally {
    global.fetch = origFetch;
  }
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/kakao.test.js`
Expected: FAIL — `k.sendToMe is not a function`

- [ ] **Step 3: Add sendToMe**

`src/kakao.js`에 추가:

```javascript
const MEMO_SEND_URL = `${API_BASE}/v2/api/talk/memo/default/send`;
const TEXT_MAX = 200;

/** 카카오 "나에게 보내기"(텍스트 템플릿). 미연동·토큰 없음이면 skip. fail-safe(throw 없음). */
async function sendToMe({ text, url, buttonTitle } = {}) {
  if (!isLinked()) return { ok: false, skipped: "not_linked" };
  const token = await getAccessToken();
  if (!token) return { ok: false, skipped: "no_token" };
  try {
    const template = {
      object_type: "text",
      text: String(text || "").slice(0, TEXT_MAX),
      link: url ? { web_url: url, mobile_web_url: url } : {},
    };
    if (url && buttonTitle) template.button_title = buttonTitle;
    const body = new URLSearchParams({ template_object: JSON.stringify(template) });
    const res = await fetch(MEMO_SEND_URL, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/x-www-form-urlencoded" },
      body: body.toString(),
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) {
      console.warn("[kakao] sendToMe 응답", res.status);
      return { ok: false, error: `send ${res.status}` };
    }
    return { ok: true };
  } catch (e) {
    console.warn("[kakao] sendToMe 실패:", e && e.message ? e.message : String(e));
    return { ok: false, error: e && e.message ? e.message : String(e) };
  }
}
```

module.exports에 `sendToMe,` 추가.

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/kakao.test.js`
Expected: PASS (6 tests)

- [ ] **Step 5: Commit**

```bash
git add src/kakao.js test/kakao.test.js
git commit -m "feat(kakao): sendToMe 나에게 보내기(텍스트 템플릿·200자 절단·미연동 skip)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 6: notify.js — invoice_issued만 카카오로 라우팅

**Files:**
- Modify: `src/notify.js`
- Test: `test/notify-kakao.test.js`

**Interfaces:**
- Consumes: `kakao.sendToMe`(Task 5), 기존 `notify(event)`·`buildPayload`.
- Produces:
  - `notify(event)`가 `event.type === "invoice_issued"`일 때 웹훅에 더해 `kakao.sendToMe(...)`도 호출(비차단·fail-safe).
  - `formatKakaoText(event): string` — event(title·text·fields)를 카카오 텍스트로 변환.

- [ ] **Step 1: Write the failing test**

Create `test/notify-kakao.test.js`:

```javascript
"use strict";
process.env.NODE_ENV = "test";
const { tempDbPath, cleanupDb } = require("./helpers");
process.env.DB_PATH = tempDbPath();

const test = require("node:test");
const assert = require("node:assert");
const { db, init } = require("../src/db");
init();

const notify = require("../src/notify");
const kakao = require("../src/kakao");

test.after(() => cleanupDb(process.env.DB_PATH, db()));

test("formatKakaoText: 제목·본문·프로젝트 필드 조립", () => {
  const text = notify.formatKakaoText({
    type: "invoice_issued",
    title: "[청구 발행] OMG-202607-003",
    text: "₩1,100,000 · (주)월간윤종신",
    fields: [{ label: "프로젝트", value: "루나 1집" }],
  });
  assert.ok(text.includes("OMG-202607-003"));
  assert.ok(text.includes("(주)월간윤종신"));
  assert.ok(text.includes("루나 1집"));
});

test("notify: invoice_issued는 카카오 호출, 다른 타입은 미호출", async () => {
  kakao.saveTokens({ refreshToken: "RT1", accessToken: "AT", expiresInSec: 3600, nickname: "n" });
  const calls = [];
  const orig = kakao.sendToMe;
  kakao.sendToMe = async (arg) => { calls.push(arg); return { ok: true }; };
  const origFetch = global.fetch;
  global.fetch = async () => ({ ok: true, status: 200, json: async () => ({}) }); // 웹훅 mock(미설정이라 실제론 skip)
  try {
    await notify.notify({ type: "invoice_issued", title: "T", text: "X", url: "https://x/invoices/9", fields: [] });
    assert.equal(calls.length, 1, "invoice_issued → 카카오 1회");
    assert.equal(calls[0].buttonTitle, "청구서 보기");
    await notify.notify({ type: "deliverable_shared", title: "T2", text: "Y" });
    assert.equal(calls.length, 1, "다른 타입은 카카오 미호출");
  } finally {
    kakao.sendToMe = orig;
    global.fetch = origFetch;
  }
});

test("notify: 카카오 send가 throw해도 notify는 정상 반환(fail-safe)", async () => {
  kakao.saveTokens({ refreshToken: "RT1", accessToken: "AT", expiresInSec: 3600 });
  const orig = kakao.sendToMe;
  kakao.sendToMe = async () => { throw new Error("boom"); };
  try {
    const r = await notify.notify({ type: "invoice_issued", title: "T", text: "X", fields: [] });
    assert.ok(r, "throw 없이 반환");
  } finally {
    kakao.sendToMe = orig;
  }
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/notify-kakao.test.js`
Expected: FAIL — `notify.formatKakaoText is not a function`

- [ ] **Step 3: Add kakao routing + formatKakaoText to notify.js**

`src/notify.js` 상단 require 목록에 추가:

```javascript
const kakao = require("./kakao");
```

`formatKRW` 함수 위(또는 근처)에 추가:

```javascript
/** notify 이벤트 → 카카오 텍스트(제목/본문/프로젝트 필드 조립). 200자 절단은 kakao.sendToMe가 처리. */
function formatKakaoText(event) {
  const lines = [event.title, event.text];
  for (const f of event.fields || []) if (f && f.value) lines.push(`${f.label}: ${f.value}`);
  return lines.filter(Boolean).join("\n");
}
```

`notify(event)` 함수의 **`try` 블록 안, 웹훅 fetch 뒤 `return` 앞**에 카카오 분기 추가. 기존:

```javascript
    if (!res.ok) console.warn(`[notify] 웹훅 응답 ${res.status} (${event.type})`);
    return { ok: res.ok, status: res.status };
```

를 아래로 교체:

```javascript
    if (!res.ok) console.warn(`[notify] 웹훅 응답 ${res.status} (${event.type})`);
    await dispatchKakao(event); // 청구 발행만 카카오로(fail-safe)
    return { ok: res.ok, status: res.status };
```

그리고 **웹훅 미설정으로 조기 return 하던 경로도 카카오는 타야 하므로**, `notify` 시작부의 `if (!url) return {...}`를 아래로 교체:

```javascript
    const url = getWebhookUrl();
    if (!url) { await dispatchKakao(event); return { ok: false, skipped: "not_configured" }; }
```

`notify` 함수 **바로 위**에 헬퍼 추가:

```javascript
/** 카카오 채널 — invoice_issued 이벤트만. fail-safe(throw 없음·notify 흐름 비차단). */
async function dispatchKakao(event) {
  try {
    if (!event || event.type !== "invoice_issued") return;
    await kakao.sendToMe({ text: formatKakaoText(event), url: event.url, buttonTitle: "청구서 보기" });
  } catch (e) {
    console.warn("[notify] 카카오 전송 실패(무시):", e && e.message ? e.message : String(e));
  }
}
```

module.exports에 `formatKakaoText,` 추가.

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/notify-kakao.test.js`
Expected: PASS (3 tests)

- [ ] **Step 5: 전체 테스트로 회귀 확인**

Run: `npm test 2>&1 | grep -E "^. (tests|pass|fail)"`
Expected: `fail 0`

- [ ] **Step 6: Commit**

```bash
git add src/notify.js test/notify-kakao.test.js
git commit -m "feat(kakao): notify 디스패치가 invoice_issued만 카카오로 라우팅 + formatKakaoText

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 7: OAuth 라우트 — /auth/kakao + 콜백

**Files:**
- Modify: `src/routes/auth.routes.js`

**Interfaces:**
- Consumes: `kakao.getAuthUrl`·`kakao.exchangeCode`(Task 3), `config.kakaoConfigured`, 기존 `crypto`·`requireChief`(auth). requireChief import 필요.
- Produces:
  - `GET /auth/kakao` — requireChief. 논스 생성 + `_kakao_nonce` 쿠키 + 카카오 인가로 리다이렉트.
  - `GET /auth/kakao/callback` — requireChief. state↔쿠키 논스 대조 후 `exchangeCode` → `/settings`로 flash 복귀.

- [ ] **Step 1: import 추가**

`src/routes/auth.routes.js`는 이미 `../auth`를 구조분해로 require한다(`setSessionCookie, clearSessionCookie, upsertUserFromGoogle, oauthClient, touchLastLogin, VIEWAS_COOKIE`). **새 require 줄을 만들지 말고** 그 구조분해 목록에 `requireChief`를 추가한다:

```javascript
const {
  setSessionCookie,
  clearSessionCookie,
  upsertUserFromGoogle,
  oauthClient,
  touchLastLogin,
  VIEWAS_COOKIE,
  requireChief,
} = require("../auth");
```

그리고 kakao 모듈 require 추가(`const { config } = require("../config");` 아래 등):

```javascript
const kakao = require("../kakao");
```

- [ ] **Step 2: /auth/kakao 라우트 추가**

`src/routes/auth.routes.js`의 `router.get("/auth/google", ...)` 라우트 **뒤**에 추가:

```javascript
// 카카오 알림 연동(로그인과 별개 — /auth/google?drive=1과 동일 구조). 치프 전용.
router.get("/auth/kakao", requireChief, (req, res) => {
  if (!config.kakaoConfigured) return res.redirect("/settings?tab=settings&notice=" + encodeURIComponent("카카오 REST API 키(KAKAO_REST_API_KEY)가 설정되지 않았습니다.") + "&notice_warn=1");
  const nonce = crypto.randomBytes(16).toString("hex");
  res.cookie("_kakao_nonce", nonce, { httpOnly: true, secure: config.isProd, sameSite: "lax", maxAge: 10 * 60 * 1000, path: "/" });
  res.redirect(kakao.getAuthUrl(nonce));
});

router.get("/auth/kakao/callback", requireChief, async (req, res) => {
  const cookieNonce = req.cookies && req.cookies["_kakao_nonce"];
  res.clearCookie("_kakao_nonce", { path: "/" });
  if (!req.query.state || !cookieNonce || req.query.state !== cookieNonce) {
    return res.redirect("/settings?tab=settings&notice=" + encodeURIComponent("카카오 연동 검증에 실패했습니다(다시 시도하세요).") + "&notice_warn=1");
  }
  const r = await kakao.exchangeCode(req.query.code);
  if (!r.ok) {
    return res.redirect("/settings?tab=settings&notice=" + encodeURIComponent("카카오 연동에 실패했습니다: " + (r.error || "")) + "&notice_warn=1");
  }
  res.redirect("/settings?tab=settings&notice=" + encodeURIComponent(`카카오 알림 연동 완료 — 수신: ${r.nickname || "연결됨"}`));
});
```

- [ ] **Step 3: 라우트 로드·구문 확인**

Run: `node -e 'require("./src/routes/auth.routes");console.log("auth routes OK")'`
Expected: `auth routes OK`

- [ ] **Step 4: 전체 테스트 회귀**

Run: `npm test 2>&1 | grep -E "^. (tests|pass|fail)"`
Expected: `fail 0`

- [ ] **Step 5: Commit**

```bash
git add src/routes/auth.routes.js
git commit -m "feat(kakao): /auth/kakao 인증 시작·콜백(논스 CSRF·치프 전용·설정 복귀)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 8: 설정 UI — 카카오 알림 섹션 + 해제·테스트 라우트

**Files:**
- Modify: `src/views.settings.js` (섹션 렌더 추가)
- Modify: `src/routes/settings.routes.js` (탭 배선 + disconnect/test 라우트)

**Interfaces:**
- Consumes: `kakao.getLinkStatus`·`kakao.disconnect`·`kakao.sendToMe`(Task 2/5), 기존 `SETTING_BLOCK`·`explain`·`esc`·`isChief`·`requireChief`.
- Produces:
  - `kakaoAlertSection(chief: boolean): string`(views.settings.js) — 미설정/미연동/연동됨/만료 상태별 렌더.
  - `POST /settings/kakao/disconnect`(requireChief) — 연동 해제.
  - `POST /settings/kakao/test`(requireChief) — 테스트 알림 발송.

- [ ] **Step 1: views.settings.js에 kakao 모듈 require + 섹션 함수 추가**

`src/views.settings.js` 상단 require들 근처(`const alerts = require("./notify");` 아래)에 추가:

```javascript
const kakao = require("./kakao");
```

`alertWebhookSection` 함수 **바로 아래**에 추가:

```javascript
/** 카카오 알림(청구 발행) — '나에게 보내기' 연동. 스튜디오 전체 1개 수신자. 치프 전용 관리. */
function kakaoAlertSection(chief = true) {
  const st = kakao.getLinkStatus();
  let controls;
  if (!st.configured) {
    controls = `<p class="text-sm text-muted">환경변수 <span class="text-fg">KAKAO_REST_API_KEY</span> 미설정 — 카카오 앱 등록 후 배포 설정에 추가하세요.</p>`;
  } else if (!chief) {
    controls = `<p class="text-sm text-muted">${st.linked ? `현재 수신: <span class="text-fg">${esc(st.nickname || "연결됨")}</span>` : "카카오 알림 미연동."} 변경은 <span class="text-fg">치프 엔지니어</span>만 가능합니다.</p>`;
  } else if (st.linked) {
    controls = `
      <p class="text-sm">현재 수신: <span class="font-semibold text-fg">${esc(st.nickname || "연결됨")}</span> <span class="text-xs text-muted">(이 카카오 계정으로 청구 발행 알림이 옵니다)</span></p>
      <div class="flex gap-2">
        <form method="post" action="/settings/kakao/test"><button class="btn-ghost btn-sm" type="submit">테스트 알림 보내기</button></form>
        <form method="post" action="/settings/kakao/disconnect" data-confirm="카카오 알림 연동을 해제할까요?"><button class="btn-ghost btn-sm text-danger" type="submit">연동 해제</button></form>
      </div>`;
  } else {
    const expiredNote = st.expired ? `<p class="mb-1 text-xs text-warning">⚠️ 연동이 만료되었습니다 — 다시 연동해 주세요.</p>` : "";
    controls = `${expiredNote}<a href="/auth/kakao" class="btn-primary btn-sm inline-block">카카오로 연동하기</a>`;
  }
  return `
    <div class="${SETTING_BLOCK}">
      <div>
        <h2 class="text-sm font-semibold">카카오 알림 (청구 발행)</h2>
        ${explain(`청구 탭에서 청구가 생성될 때, 연동한 카카오 계정으로 카카오톡 알림을 보냅니다("나에게 보내기"). 받을 사람이 직접 자기 카카오로 연동해야 합니다.`)}
      </div>
      ${controls}
    </div>`;
}
```

module.exports에 `kakaoAlertSection,` 추가.

- [ ] **Step 2: 렌더 확인(미설정 상태)**

Run: `node -e 'process.env.NODE_ENV="test";process.env.DB_PATH=require("./test/helpers").tempDbPath();require("./src/db").init();const v=require("./src/views.settings");console.log(v.kakaoAlertSection(true).includes("KAKAO_REST_API_KEY")?"미설정 렌더 OK":"FAIL")'`
Expected: `미설정 렌더 OK`

- [ ] **Step 3: settings.routes.js — 탭 배선**

`src/routes/settings.routes.js`에서 `alertWebhookSection`를 import하는 구조분해에 `kakaoAlertSection` 추가:

```javascript
  alertWebhookSection,
  kakaoAlertSection,
```

그리고 알림 탭 배열(`{ id: "alerts", label: "알림", html: alertWebhookSection(isChief(req.user)) }`)을 아래로 교체:

```javascript
      { id: "alerts", label: "알림", html: alertWebhookSection(isChief(req.user)) + kakaoAlertSection(isChief(req.user)) },
```

- [ ] **Step 4: settings.routes.js — disconnect/test 라우트 + kakao require**

`src/routes/settings.routes.js` 상단에 kakao require 추가(다른 모듈 require 근처):

```javascript
const kakao = require("../kakao");
```

`POST /alert-webhook/test` 라우트 **뒤**에 추가:

```javascript
router.post("/kakao/disconnect", requireChief, (req, res) => {
  kakao.disconnect();
  res.redirect("/settings?tab=settings&notice=" + encodeURIComponent("카카오 알림 연동을 해제했습니다."));
});

router.post("/kakao/test", requireChief, asyncHandler(async (req, res) => {
  const r = await kakao.sendToMe({ text: "🧾 테스트 알림\nOMG Studios 카카오 알림이 정상 연동되었습니다.", url: config.baseUrl || undefined, buttonTitle: config.baseUrl ? "열기" : undefined });
  const msg = r.ok ? "테스트 알림을 보냈습니다 — 카카오톡을 확인하세요." : "테스트 알림 발송 실패(연동 상태를 확인하세요).";
  res.redirect("/settings?tab=settings&notice=" + encodeURIComponent(msg) + (r.ok ? "" : "&notice_warn=1"));
}));
```

`config`가 settings.routes.js에 import돼 있는지 확인(없으면 `const { config } = require("../config");` 추가).

- [ ] **Step 5: 라우트 로드·전체 테스트**

Run: `node -e 'require("./src/routes/settings.routes");console.log("settings OK")' && npm test 2>&1 | grep -E "^. (tests|pass|fail)"`
Expected: `settings OK` + `fail 0`

- [ ] **Step 6: Commit**

```bash
git add src/views.settings.js src/routes/settings.routes.js
git commit -m "feat(kakao): 관리 알림 탭 카카오 섹션(연동 상태·해제·테스트 발송)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 9: 일일 cron keep-alive

**Files:**
- Modify: `src/lib/maintenance.js` (`runDailyMaintenance`에 keepAlive 추가)

**Interfaces:**
- Consumes: `kakao.keepAlive`(Task 4).
- Produces: `runDailyMaintenance` 반환 객체에 `kakaoKeepAlive` 필드 추가(진단용).

- [ ] **Step 1: kakao require 추가**

`src/lib/maintenance.js` 상단 require들 근처에 추가:

```javascript
const kakao = require("../kakao");
```

- [ ] **Step 2: runDailyMaintenance에 keepAlive 추가**

`src/lib/maintenance.js`의 `runDailyMaintenance` 안, `auditPruned` 계산 **뒤**·`return` **앞**에 추가:

```javascript
  // 카카오 토큰 keep-alive — 청구가 오래 없어도 리프레시 토큰이 2개월 안에 계속 연장되게(fail-safe·비차단).
  let kakaoKeepAlive = null;
  try { kakaoKeepAlive = await kakao.keepAlive(); } catch (_e) { kakaoKeepAlive = { ok: false }; }
```

그리고 return 객체에 `kakaoKeepAlive` 추가:

```javascript
  return { ok: !backupError, ranAt, backup, backupError, driveBackup, uploadsBackup, uploadsBackupError, overdue, overdueError, auditPruned, kakaoKeepAlive };
```

- [ ] **Step 3: 로드·전체 테스트**

Run: `node -e 'require("./src/lib/maintenance");console.log("maintenance OK")' && npm test 2>&1 | grep -E "^. (tests|pass|fail)"`
Expected: `maintenance OK` + `fail 0`

- [ ] **Step 4: Commit**

```bash
git add src/lib/maintenance.js
git commit -m "feat(kakao): 일일 cron에 토큰 keep-alive 추가(침묵 기간에도 연동 유지)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 10: DEV_LOGIN E2E — 청구 생성 시 카카오 발송 경로

**Files:**
- 없음(수동 E2E 검증 태스크). 검증만 하고 코드 변경 없음.

**Interfaces:**
- Consumes: 전체 배선(Task 1~9).

- [ ] **Step 1: 격리 서버 기동(카카오 키 mock)**

기존 실행 중 서버 정리 후:

```bash
pkill -f "src/server.js" 2>/dev/null; sleep 0.5
S=$(node -e 'console.log(require("os").tmpdir())')/kakao-e2e
rm -rf "$S"; mkdir -p "$S"
DB_PATH="$S/e2e.db" ADMIN_EMAIL=chief@omg.test node src/seed.js
DEV_LOGIN=1 NODE_ENV=development DB_PATH="$S/e2e.db" PORT=3999 \
  SESSION_SECRET=x TOKEN_ENC_KEY=y KAKAO_REST_API_KEY=e2e_key \
  node src/server.js > "$S/srv.log" 2>&1 &
sleep 2.5
curl -s -o /dev/null -w "healthz=%{http_code}\n" http://localhost:3999/healthz
```

Expected: `healthz=200`

- [ ] **Step 2: 설정 화면에 카카오 섹션 노출 확인**

```bash
S=$(node -e 'console.log(require("os").tmpdir())')/kakao-e2e
curl -s -c "$S/c.txt" -o /dev/null -X POST http://localhost:3999/dev-login -H "Sec-Fetch-Site: same-origin" --data "as=chief"
curl -s -b "$S/c.txt" "http://localhost:3999/settings?tab=settings" | grep -o "카카오로 연동하기" | head -1
```

Expected: `카카오로 연동하기` (미연동·설정됨 상태이므로 연동 버튼 노출)

- [ ] **Step 3: 카카오 연동 상태를 강제 주입 + 청구 생성이 sendToMe를 태우는지 확인**

카카오 실제 인증 없이 발송 경로만 검증하려면, 저장 토큰을 직접 주입하고 `notify.formatKakaoText`가 만든 텍스트를 로그로 본다. 아래 스크립트로 확인:

```bash
S=$(node -e 'console.log(require("os").tmpdir())')/kakao-e2e
DB_PATH="$S/e2e.db" node -e '
  const kakao=require("./src/kakao");
  kakao.saveTokens({refreshToken:"RT",accessToken:"AT",expiresInSec:3600,nickname:"치프"});
  console.log("linked=",kakao.isLinked(),"nickname=",kakao.getLinkStatus().nickname);
'
```

Expected: `linked= true nickname= 치프`

- [ ] **Step 4: 실제 청구 생성 → 서버 로그에 카카오 전송 시도 확인**

seed 프로젝트에 완료 작업이 있으면 청구 생성. (seed 데이터에 따라 프로젝트 id·작업 id는 다를 수 있음 — `/projects` 목록에서 청구 필요 프로젝트를 찾아 청구 탭에서 생성.) 발송 시 카카오 API는 mock 키라 실패하지만, **로그에 `[kakao] sendToMe 응답` 또는 전송 시도가 남고 청구 생성은 성공(302)**해야 한다(fail-safe 검증).

```bash
S=$(node -e 'console.log(require("os").tmpdir())')/kakao-e2e
grep -E "\[kakao\]|\[notify\]" "$S/srv.log" | tail -5
echo "→ 카카오 전송 실패 로그가 있어도 청구 생성은 302로 성공해야 함(fail-safe)"
```

Expected: 카카오 전송 실패/응답 로그가 있어도 청구 생성 흐름은 정상(에러 페이지·500 없음).

- [ ] **Step 5: 서버 정리**

```bash
pkill -f "src/server.js"; sleep 0.5
pgrep -f "src/server.js" >/dev/null && echo "서버 잔존!" || echo "서버 정리됨"
```

Expected: `서버 정리됨`

- [ ] **Step 6: (검증 태스크 — 커밋 없음)**

E2E 통과 확인만. 코드 변경 없으므로 커밋하지 않는다.

---

## Task 11: 문서 현행화 (CLAUDE.md · DEPLOY.md)

**Files:**
- Modify: `CLAUDE.md` (Read → Edit로만 수정 — python in-place 재작성 금지, [[careful-doc-file-rewrites]])
- Modify: `DEPLOY.md` (카카오 앱 등록 사전 준비)

**Interfaces:** 없음(문서).

- [ ] **Step 1: CLAUDE.md — 환경변수 표에 카카오 추가**

`CLAUDE.md`의 환경변수 표(`| 키 | 용도 |`)에 행 추가(Read로 위치 확인 후 Edit):

```
| `KAKAO_REST_API_KEY` | (선택) 카카오톡 청구 발행 알림('나에게 보내기'). 카카오 디벨로퍼스 앱 REST 키. 미설정 시 연동 버튼 비활성 |
| `KAKAO_CLIENT_SECRET` | (선택) 카카오 앱에서 client secret 사용 시 |
```

- [ ] **Step 2: CLAUDE.md — 알림 섹션에 카카오 채널 서술**

`### 배포 · 운영`의 알림(웹훅) 항목 근처에 Edit로 한 줄 추가:

```
- **카카오 알림(청구 발행, 2026-07-13)**: 청구 탭 청구 생성 시 연동한 카카오 계정 1곳으로 '나에게 보내기'(`src/kakao.js`). notify 디스패치가 `invoice_issued`만 카카오로 라우팅(웹훅과 병렬). 토큰 admin_state 암호화 저장·자동 갱신·일일 cron keep-alive. 관리>환경설정>알림에서 치프가 연동/해제/테스트. `KAKAO_REST_API_KEY` 필요. 수신자 변경=해제 후 받을 사람이 자기 카카오로 재연동(send-to-me 제약).
```

- [ ] **Step 3: CLAUDE.md — admin_state 데이터 모델에 카카오 키 추가**

`admin_state(key, value)` 서술 줄에 Edit로 `kakao_*`(refresh/access 암호화·nickname·linked_at·expired) 추가.

- [ ] **Step 4: DEPLOY.md — 카카오 앱 등록 사전 준비 섹션 추가**

`DEPLOY.md`에 섹션 추가(Read로 형식 확인 후 Edit):

```markdown
## 카카오 알림(청구 발행) 사전 준비

1. developers.kakao.com에서 애플리케이션 등록 → **REST API 키** 확보.
2. [카카오 로그인] 활성화 + Redirect URI 등록: `{BASE_URL}/auth/kakao/callback`(로컬·프로덕션 각각).
3. [카카오 로그인 > 동의항목]에서 **카카오톡 메시지 전송(talk_message)** 활성화("나에게 보내기"는 개인 개발자 앱에서도 가능).
4. Render env: `KAKAO_REST_API_KEY`(+ 필요 시 `KAKAO_CLIENT_SECRET`).
5. 배포 후 관리 > 환경설정 > 알림 > 카카오 알림에서 [연동하기] → [테스트 알림 보내기]로 확인.
```

- [ ] **Step 5: 문서 로드 확인(빌드 영향 없음) + 전체 테스트**

Run: `npm test 2>&1 | grep -E "^. (tests|pass|fail)"`
Expected: `fail 0`

- [ ] **Step 6: Commit**

```bash
git add CLAUDE.md DEPLOY.md
git commit -m "docs: 카카오 청구 발행 알림 — env·알림 섹션·admin_state·배포 사전준비 현행화

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Self-Review 결과(작성자 점검)

- **Spec coverage**: 설계 §3 모듈(kakao.js=T2~5, notify=T6, auth 콜백=T7, settings=T8, cron=T9, config=T1), §4 흐름(연동=T7, 발송=T6, 갱신=T4), §5 메시지(T5/T6), §6 오류(fail-safe 전 태스크), §7 테스트(T2~6·10), §8 사전준비(T11) — 전부 태스크로 커버.
- **Placeholder scan**: TBD/TODO/"적절히" 없음. 모든 코드 스텝에 실제 코드.
- **Type consistency**: `saveTokens({refreshToken,accessToken,expiresInSec,nickname})`·`sendToMe({text,url,buttonTitle})`·`getLinkStatus()→{configured,linked,nickname,linkedAt,expired}`·`formatKakaoText(event)`·`getAuthUrl(state)`·`exchangeCode(code)→{ok,nickname,error}` — 태스크 간 시그니처 일치.
- **주의(구현자용)**: config·kakao는 module 캐시라 테스트에서 env 바꿀 때 `delete require.cache[...]` 후 재require(테스트에 반영됨). settings.routes에 `config` import 여부 먼저 확인(Task 8 Step 4).
