"use strict";

/**
 * 청구 발행 이메일 알림 — 지메일 API 발송(2026-07-14, 카카오/알림톡 폐기 후의 최종 채널).
 *
 * 설계(drive.js·calendar.js·people.js와 같은 격의 독립 연동 모듈):
 *  - 인증 = **스튜디오 계정 refresh token 재사용**(drive.getRefreshToken — Drive·캘린더·연락처와 동일 토큰).
 *    새 연동 화면이 없다. 단 `gmail.send` 스코프가 필요하므로 스튜디오 계정 1회 재로그인이 선행된다.
 *  - 수신자 = admin_state `alert_email_to`(콤마 구분·평문 — 비밀이 아님). 관리 > 환경설정 > 알림에서 치프가 지정.
 *  - fail-safe: 발송은 절대 throw하지 않는다(청구 생성 비차단). 실패는 console.warn만.
 *  - 로그에 수신 주소 전체를 남기지 않는다(앞 2글자 + 도메인만).
 */

const { google } = require("googleapis");
const { config } = require("./config");
const { oauthClient } = require("./auth");
const { getRefreshToken } = require("./drive");
const { getState, setState } = require("./db");

const STATE_TO = "alert_email_to"; // 콤마 구분 수신 주소(평문)
const FROM_NAME = "OMG Studios";

/** refresh token으로 인증된 Gmail 클라이언트. 미연동이면 null. */
function gmailClient() {
  const refresh = getRefreshToken();
  if (!config.googleConfigured || !refresh) return null;
  const auth = oauthClient();
  auth.setCredentials({ refresh_token: refresh });
  return google.gmail({ version: "v1", auth });
}

/** 저장된 원문(설정 화면 표시·편집용). */
function getRecipientsRaw() {
  return getState(STATE_TO) || "";
}

/** 정규화된 수신 주소 배열 — 콤마·줄바꿈·공백 분리, 소문자, dedup, 형식 불량 제외. */
function parseRecipients(raw) {
  const parts = String(raw || "").split(/[,\n;]/).map((s) => s.trim().toLowerCase()).filter(Boolean);
  const out = [];
  for (const p of parts) {
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(p)) continue;
    if (!out.includes(p)) out.push(p);
  }
  return out;
}

/** 현재 수신 주소 배열. */
function getRecipients() {
  return parseRecipients(getRecipientsRaw());
}

/** 형식이 잘못된 주소 목록(저장 거부·오류 표시용). */
function invalidRecipients(raw) {
  return String(raw || "").split(/[,\n;]/).map((s) => s.trim()).filter(Boolean)
    .filter((p) => !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(p));
}

/** 수신 주소 저장(원문 그대로 — 표시·편집 편의). 비우면 알림 끔. */
function setRecipients(raw) {
  const v = String(raw || "").trim();
  setState(STATE_TO, v || null);
}

/** 발송 준비 완료 = 구글 연동 O + 수신자 1명 이상. */
function isConfigured() {
  return Boolean(gmailClient()) && getRecipients().length > 0;
}

/** 로그용 마스킹 — 앞 2글자 + 도메인(수신 주소 전량 노출 금지). */
function maskEmail(addr) {
  const [user, domain] = String(addr).split("@");
  if (!domain) return "***";
  return `${user.slice(0, 2)}***@${domain}`;
}

/** 한글 제목 → RFC 2047(base64) 인코딩. ASCII만이면 그대로. */
function encodeSubject(subject) {
  const s = String(subject || "");
  // eslint-disable-next-line no-control-regex
  if (/^[\x00-\x7F]*$/.test(s)) return s;
  return `=?UTF-8?B?${Buffer.from(s, "utf8").toString("base64")}?=`;
}

/** RFC822 MIME 문자열(순수 함수 — 테스트 대상). 본문은 HTML(UTF-8·base64). */
function buildMime({ to, subject, html, from }) {
  const sender = from || config.studioDriveEmail;
  const body = Buffer.from(String(html || ""), "utf8").toString("base64").replace(/(.{76})/g, "$1\r\n");
  return [
    `From: ${FROM_NAME} <${sender}>`,
    `To: ${(to || []).join(", ")}`,
    `Subject: ${encodeSubject(subject)}`,
    "MIME-Version: 1.0",
    "Content-Type: text/html; charset=UTF-8",
    "Content-Transfer-Encoding: base64",
    "",
    body,
  ].join("\r\n");
}

/**
 * 메일 발송(fail-safe — 절대 throw하지 않음).
 * @param {{subject:string, html:string, client?:object}} opts client=테스트용 주입(기본 gmailClient()).
 * @returns {Promise<{ok:boolean, sent?:number, skipped?:string, error?:string}>}
 */
async function send({ subject, html, client }) {
  try {
    const gmail = client || gmailClient();
    if (!gmail) return { ok: false, skipped: "not_linked" };
    const to = getRecipients();
    if (!to.length) return { ok: false, skipped: "no_recipients" };
    const raw = Buffer.from(buildMime({ to, subject, html }), "utf8").toString("base64url");
    await gmail.users.messages.send({ userId: "me", requestBody: { raw } });
    return { ok: true, sent: to.length };
  } catch (e) {
    const msg = e && e.message ? e.message : String(e);
    // 스코프 누락(gmail.send)이 가장 흔한 원인 — 스튜디오 계정 재로그인 필요.
    console.warn(`[mailer] 발송 실패(무시): ${msg}${/insufficient|scope/i.test(msg) ? " — 스튜디오 계정 재로그인(gmail.send 스코프) 필요" : ""}`);
    return { ok: false, error: msg };
  }
}

/** 원화 표기(views와 동일 출력) — mailer를 뷰에 의존시키지 않으려 인라인. */
function formatKRW(amount) {
  return new Intl.NumberFormat("ko-KR", { style: "currency", currency: "KRW", maximumFractionDigits: 0 }).format(Number(amount || 0));
}

function esc(v) {
  return String(v == null ? "" : v).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

/** 청구 발행 메일 본문(순수 함수 — 테스트 대상). inv = getInvoiceForUser 형태 + project_artist. */
function invoiceMail(inv) {
  const number = inv.invoice_number || inv.title || "청구서";
  const artist = String(inv.project_artist || "").trim();
  const payer = inv.client_name || "청구처 미지정";
  const subject = `[청구 발행] ${number} · ${artist || payer}`;
  const url = config.baseUrl ? `${config.baseUrl}/invoices/${inv.id}` : "";
  const row = (label, value) =>
    `<tr><td style="padding:6px 16px 6px 0;color:#6E6A5F;white-space:nowrap">${esc(label)}</td><td style="padding:6px 0;color:#262421">${esc(value)}</td></tr>`;
  const html = `<div style="font-family:-apple-system,'Apple SD Gothic Neo',sans-serif;color:#262421;line-height:1.6">
  <h2 style="margin:0 0 12px;font-size:17px">청구서가 발행되었습니다</h2>
  <table style="border-collapse:collapse;font-size:14px">
    ${row("청구번호", number)}
    ${row("청구처", payer)}
    ${artist ? row("아티스트", artist) : ""}
    ${row("프로젝트", inv.project_title || "-")}
    ${row("금액", formatKRW(inv.amount))}
  </table>
  ${url ? `<p style="margin:20px 0 0"><a href="${esc(url)}" style="display:inline-block;padding:9px 16px;background:#C08457;color:#fff;border-radius:8px;text-decoration:none;font-size:14px">청구서 보기</a></p>` : ""}
  <p style="margin:24px 0 0;font-size:12px;color:#6E6A5F">OMG Studios 관리 시스템에서 자동 발송된 알림입니다.</p>
</div>`;
  return { subject, html };
}

/** 청구 발행 알림 발송(notify 디스패치에서 호출). fail-safe. */
async function sendInvoiceIssued(inv) {
  if (!inv) return { ok: false, skipped: "no_invoice" };
  const { subject, html } = invoiceMail(inv);
  return send({ subject, html });
}

module.exports = {
  gmailClient,
  getRecipients,
  getRecipientsRaw,
  setRecipients,
  parseRecipients,
  invalidRecipients,
  isConfigured,
  buildMime,
  encodeSubject,
  invoiceMail,
  send,
  sendInvoiceIssued,
  maskEmail,
};
