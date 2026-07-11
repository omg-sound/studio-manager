"use strict";

/**
 * 알림 채널 추상화 — 연체·청구 발행·자료 공유가 공유하는 내부 팀 알림.
 * 현재 어댑터: 웹훅(Slack/Discord/범용 JSON POST). Gmail 등은 dispatch에 어댑터를 추가하면 된다.
 * 설계 원칙:
 *  - **fail-safe**: notify는 절대 throw하지 않는다(트리거 동작=청구·자료·cron을 막지 않음).
 *  - **fire-and-forget**: 호출부는 notifyAsync로 응답을 지연시키지 않는다.
 *  - **비밀 at-rest 암호화**(플레이북 §2.6): 웹훅 URL은 admin_state에 AES-256-GCM으로 저장.
 *    운영 오버라이드로 env `ALERT_WEBHOOK`을 우선 적용(이 경우 평문 env는 배포 시크릿이 관리).
 *  - **SSRF 방어**: 사설/링크로컬 IP 대역으로의 요청은 차단(조용히 skip + 로그).
 */

const dns = require("dns");
const { isIP } = require("net");
const { getState, setState, encrypt, decrypt } = require("./db");
const { config } = require("./config");

// 사설·링크로컬·루프백 IP 패턴(IPv4 + IPv6)
const PRIVATE_IP_PATTERNS = [
  /^127\./,                         // 127.0.0.0/8  루프백
  /^10\./,                          // 10.0.0.0/8   사설
  /^172\.(1[6-9]|2\d|3[01])\./,    // 172.16.0.0/12 사설
  /^192\.168\./,                    // 192.168.0.0/16 사설
  /^169\.254\./,                    // 169.254.0.0/16 링크로컬(IMDS 등)
  /^0\.0\.0\.0$/,                   // 0.0.0.0
  /^::1$/,                          // IPv6 루프백
  /^f[cde][0-9a-f]{2}:/i,           // fc00::/7 ULA(fc·fd — 첫 바이트 0xFC/0xFD) + fe00::/8(링크로컬·사이트로컬). 이전 [ce]는 fd 대역(흔한 ULA)을 통째로 놓쳤음(2026-07-11 감사 테스트로 검출)
  /^fe[89ab][0-9a-f]:/i,            // fe80::/10 링크로컬(위 fe 커버와 중복이나 명시 보존)
];

function isPrivateIp(ip) {
  // IPv4-mapped IPv6(::ffff:127.0.0.1)를 정규화해 IPv4 패턴도 재검사 — 매핑 우회 차단
  const v4 = String(ip).replace(/^::ffff:/i, "");
  return PRIVATE_IP_PATTERNS.some((r) => r.test(ip) || r.test(v4));
}

/**
 * SSRF 안전 검사: URL 호스트를 DNS 해석 후 사설 IP면 false 반환.
 * 파싱/DNS 실패도 false(차단).
 */
async function isSsrfSafe(url) {
  try {
    const { hostname } = new URL(url);
    const ip = isIP(hostname) ? hostname : (await dns.promises.lookup(hostname, { verbatim: false })).address;
    if (isPrivateIp(ip)) return false;
    return true;
  } catch {
    return false;
  }
}

const STATE_WEBHOOK = "alert_webhook_url"; // admin_state 키(암호화 저장)

/** 운영 적용 웹훅 URL: env 우선, 없으면 암호화 admin_state. 미설정이면 null. */
function getWebhookUrl() {
  const env = String(process.env.ALERT_WEBHOOK || "").trim();
  if (env) return env;
  const enc = getState(STATE_WEBHOOK);
  const url = enc ? decrypt(enc) : null;
  return url || null;
}

/** 설정 화면 표시·편집용(UI에서 설정한 값만; env 오버라이드는 별도 표기). */
function getConfiguredWebhook() {
  const enc = getState(STATE_WEBHOOK);
  return (enc && decrypt(enc)) || "";
}
function setWebhookUrl(url) {
  const v = String(url || "").trim();
  setState(STATE_WEBHOOK, v ? encrypt(v) : null);
}
function envWebhookActive() {
  return Boolean(String(process.env.ALERT_WEBHOOK || "").trim());
}
function isConfigured() {
  return Boolean(getWebhookUrl());
}

/** event = { type, title, text?, fields?: [{label,value}], url? } → Slack(text)·Discord(content) 동시 호환 페이로드. */
function buildPayload(event) {
  const lines = [event.title, event.text].filter(Boolean);
  for (const f of event.fields || []) {
    if (f && f.value != null && String(f.value).trim() !== "") lines.push(`• ${f.label}: ${f.value}`);
  }
  if (event.url) lines.push(event.url);
  const text = lines.join("\n");
  return { text, content: text, type: event.type || "alert" };
}

/**
 * 알림 전송(fail-safe). 절대 throw하지 않음. 미설정이면 조용히 skip.
 * @returns {Promise<{ok:boolean, skipped?:string, status?:number, error?:string}>}
 */
async function notify(event) {
  try {
    const url = getWebhookUrl();
    if (!url) return { ok: false, skipped: "not_configured" };
    // SSRF 방어: 사설/링크로컬 IP 대역이면 차단
    const safe = await isSsrfSafe(url);
    if (!safe) {
      console.warn("[notify] SSRF 차단: 사설/내부 IP 대역 또는 잘못된 URL — 알림 skip");
      return { ok: false, skipped: "ssrf_blocked" };
    }
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(buildPayload(event)),
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) console.warn(`[notify] 웹훅 응답 ${res.status} (${event.type})`);
    return { ok: res.ok, status: res.status };
  } catch (e) {
    console.warn("[notify] 전송 실패(무시):", e && e.message ? e.message : String(e));
    return { ok: false, error: e && e.message ? e.message : String(e) };
  }
}

/** 비차단 호출 — 호출부에서 await 없이 사용(응답 지연·예외 전파 방지). */
function notifyAsync(event) {
  Promise.resolve()
    .then(() => notify(event))
    .catch(() => {});
}

/** 원화 표기(views.formatKRW와 동일 출력) — notify를 뷰 레이어에 의존시키지 않으려 인라인. */
function formatKRW(amount) {
  return new Intl.NumberFormat("ko-KR", { style: "currency", currency: "KRW", maximumFractionDigits: 0 }).format(Number(amount || 0));
}

/**
 * 인보이스 '발행' 알림(공용·fail-safe·비차단). 신규 '발행' 전이(자동 from-tasks·수동 발행)의 공통 진입점.
 * 절대 throw하지 않음 — 호출부 try/catch가 알림 실패를 청구 실패로 오인하지 않도록 내부에서 흡수.
 * @param {{id?:number, invoice_number?:string, title?:string, amount?:number, client_name?:string, project_title?:string}} inv
 *   getInvoiceForUser 형태의 인보이스 행(조인된 client_name·project_title 포함).
 */
function notifyInvoiceIssued(inv) {
  try {
    if (!inv) return;
    notifyAsync({
      type: "invoice_issued",
      title: `[청구 발행] ${inv.invoice_number || inv.title}`,
      text: `${formatKRW(inv.amount)} · ${inv.client_name || "청구처 미지정"}`,
      fields: [{ label: "프로젝트", value: inv.project_title || "-" }],
      url: config.baseUrl ? `${config.baseUrl}/invoices/${inv.id}` : undefined,
    });
  } catch (e) {
    console.warn("[notify] invoice_issued 구성 실패(무시):", e && e.message ? e.message : String(e));
  }
}

module.exports = {
  notify,
  notifyAsync,
  notifyInvoiceIssued,
  getWebhookUrl,
  getConfiguredWebhook,
  setWebhookUrl,
  envWebhookActive,
  isConfigured,
  isPrivateIp, // SSRF 대역 판정(순수 함수) — 테스트 노출(함정 #11 회귀 잠금)
  isSsrfSafe,
};
