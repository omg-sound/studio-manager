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

/**
 * 청구 발행 메일 본문(순수 함수 — 테스트 대상).
 * 수신자(대표)가 이 메일만 보고 **홈택스 세금계산서를 발행**할 수 있게, 청구 상세 화면과 같은 정보를 담는다
 * (2026-07-14 사용자 요청 — "업무를 메일에서 한 번에"). 앱 링크는 확인이 필요할 때만 쓰는 보조.
 * @param {object} inv getInvoiceForUser 형태(+project_artist)
 * @param {{payer?:object, items?:Array}} extra payer=발행 시점 스냅샷(payer_snapshot 파싱), items=invoice_items
 */
function invoiceMail(inv, { payer = null, items = [] } = {}) {
  const number = inv.invoice_number || inv.title || "청구서";
  const artist = String(inv.project_artist || "").trim();
  const payerName = (payer && payer.name) || inv.client_name || "청구처 미지정";
  const subject = `[청구 발행] ${number} · ${artist || payerName}`;
  const url = config.baseUrl ? `${config.baseUrl}/invoices/${inv.id}` : "";
  const isPerson = payer && payer.kind === "person";

  const L = "padding:5px 14px 5px 0;color:#6E6A5F;white-space:nowrap;vertical-align:top";
  const V = "padding:5px 0;color:#262421";
  const row = (label, value) => (value ? `<tr><td style="${L}">${esc(label)}</td><td style="${V}">${esc(value)}</td></tr>` : "");

  // ① 청구처 정보 — 홈택스 '공급받는자' 입력 순서(청구 상세 카드와 동일).
  const contact = payer && payer.contacts && payer.contacts[0];
  const payerRows = [
    isPerson ? row("현금영수증", payer.cash_receipt_no) : row("사업자등록번호", payer && payer.biz_no),
    row(isPerson ? "성명" : "상호", payerName),
    isPerson ? "" : row("성명(대표자)", payer && payer.owner_name),
    row("사업장 주소", payer && payer.address),
    row("세금계산서 발행 이메일", payer && payer.email),
    contact ? row("담당자", [contact.name, contact.phone, contact.email].filter(Boolean).join(" · ")) : "",
  ].filter(Boolean).join("");

  // ② 청구 항목 + 소계·할인·VAT·총액(청구 상세와 동일 구성).
  const supply = Math.max(0, Number(inv.amount || 0) - Number(inv.tax_amount || 0));
  const itemRows = (items || [])
    .map(
      (it) =>
        `<tr><td style="padding:6px 12px 6px 0;color:#262421">${esc(it.description || it.task_type || "항목")}</td>
         <td style="padding:6px 0;text-align:right;color:#262421;white-space:nowrap">${formatKRW(it.amount)}</td></tr>`
    )
    .join("");
  const totalRow = (label, value, strong) =>
    `<tr><td style="padding:5px 12px 5px 0;color:#6E6A5F">${esc(label)}</td>
     <td style="padding:5px 0;text-align:right;white-space:nowrap;color:#262421${strong ? ";font-weight:700;font-size:15px" : ""}">${formatKRW(value)}</td></tr>`;

  const html = `<div style="font-family:-apple-system,'Apple SD Gothic Neo',sans-serif;color:#262421;line-height:1.6;max-width:560px">
  <h2 style="margin:0 0 4px;font-size:17px">${esc(number)} 청구서가 발행되었습니다</h2>
  <p style="margin:0 0 16px;font-size:13px;color:#6E6A5F">${esc([artist, inv.project_title].filter(Boolean).join(" · ") || "-")}</p>

  <h3 style="margin:20px 0 6px;font-size:13px;color:#6E6A5F">청구처 정보</h3>
  <table style="border-collapse:collapse;font-size:14px;width:100%">${payerRows || `<tr><td style="${V}">청구처 미지정</td></tr>`}</table>

  <h3 style="margin:20px 0 6px;font-size:13px;color:#6E6A5F">청구 항목</h3>
  <table style="border-collapse:collapse;font-size:14px;width:100%">
    ${itemRows}
    <tr><td colspan="2" style="border-top:1px solid #E5E1D8;padding:0"></td></tr>
    ${totalRow("소계", supply)}
    ${Number(inv.discount_amount) ? totalRow("할인", -Number(inv.discount_amount)) : ""}
    ${totalRow("VAT", inv.tax_amount || 0)}
    ${totalRow("총액", inv.amount, true)}
  </table>

  ${url ? `<p style="margin:24px 0 0"><a href="${esc(url)}" style="display:inline-block;padding:9px 16px;background:#C08457;color:#fff;border-radius:8px;text-decoration:none;font-size:14px">청구서 열기</a></p>` : ""}
  <p style="margin:20px 0 0;font-size:12px;color:#6E6A5F">OMG Studios 관리 시스템에서 자동 발송된 알림입니다. 계산서·입금 처리는 청구 화면에서 합니다.</p>
</div>`;
  return { subject, html };
}

/** 청구 발행 알림 발송(notify 디스패치에서 호출). fail-safe — 조회 실패해도 요약만으로 발송. */
async function sendInvoiceIssued(inv) {
  if (!inv) return { ok: false, skipped: "no_invoice" };
  let payer = null;
  let items = [];
  try {
    // 발행 시점 스냅샷(payer_snapshot) 우선 — 이후 클라이언트 정보가 바뀌어도 메일은 발행 당시 값(회계 정합).
    if (inv.payer_snapshot) payer = JSON.parse(inv.payer_snapshot);
    const { listInvoiceItemsForInvoice } = require("./data"); // 지연 require(순환 방지)
    const r = listInvoiceItemsForInvoice({ role: "chief" }, inv.id); // 반환 { invoice, rows }
    items = (r && r.rows) || [];
  } catch (e) {
    console.warn("[mailer] 청구 상세 조회 실패(요약만 발송):", e && e.message ? e.message : String(e));
  }
  const { subject, html } = invoiceMail(inv, { payer, items });
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
