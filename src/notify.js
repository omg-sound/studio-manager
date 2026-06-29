"use strict";

/**
 * 알림 채널 추상화 — 연체·청구 발행·자료 공유가 공유하는 내부 팀 알림.
 * 현재 어댑터: 웹훅(Slack/Discord/범용 JSON POST). Gmail 등은 dispatch에 어댑터를 추가하면 된다.
 * 설계 원칙:
 *  - **fail-safe**: notify는 절대 throw하지 않는다(트리거 동작=청구·자료·cron을 막지 않음).
 *  - **fire-and-forget**: 호출부는 notifyAsync로 응답을 지연시키지 않는다.
 *  - **비밀 at-rest 암호화**(플레이북 §2.6): 웹훅 URL은 admin_state에 AES-256-GCM으로 저장.
 *    운영 오버라이드로 env `ALERT_WEBHOOK`을 우선 적용(이 경우 평문 env는 배포 시크릿이 관리).
 */

const { getState, setState, encrypt, decrypt } = require("./db");

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

module.exports = {
  notify,
  notifyAsync,
  getWebhookUrl,
  getConfiguredWebhook,
  setWebhookUrl,
  envWebhookActive,
  isConfigured,
};
