"use strict";

/**
 * User-Agent → 사람이 읽는 **기기 이름**(예: `크롬/맥`, `사파리/아이폰`).
 *
 * 왜: 2026-07-20 사용자 요청 — 감사 로그의 접속·로그인 기록에 "어느 기기로 들어왔나"를 남긴다.
 * IP(`audit_log.ip`)와 **함께** 남긴다 — 처음엔 IP를 안 남기기로 했다가 같은 날 사용자 결정으로 뒤집혔다(2026-07-20).
 * 기기 라벨은 IP만으로는 안 보이는 것을 준다: 같은 사무실 IP에서도 '내가 안 쓰는 브라우저/OS'가 드러난다.
 *
 * 원문 UA는 100자를 훌쩍 넘고 버전 숫자가 대부분이라 그대로 두면 감사 로그 한 줄을 통째로 먹는다 →
 * 브라우저·OS 두 조각으로만 요약한다. 정밀 판별이 목적이 아니라 **눈으로 구분**이 목적이라 정확도보다 짧음을 택했다.
 */

// 순서가 중요하다 — 엣지·오페라·삼성 UA에는 "Chrome"이, 크롬 UA에는 "Safari"가 들어 있어
// 넓은 쪽을 먼저 검사하면 전부 크롬/사파리로 뭉개진다. 좁은 것부터.
const BROWSERS = [
  [/Edg[A-Z]?\//, "엣지"],
  [/OPR\/|Opera/, "오페라"],
  [/SamsungBrowser/, "삼성브라우저"],
  [/Whale/, "웨일"],
  [/FxiOS|Firefox/, "파이어폭스"],
  [/CriOS|Chrome|Chromium/, "크롬"],
  [/Safari/, "사파리"],
];

// iPad는 iPadOS 13+부터 UA에 "Macintosh"를 쓰므로 맥보다 먼저 봐야 한다.
const PLATFORMS = [
  [/iPhone/, "아이폰"],
  [/iPad/, "아이패드"],
  [/Android/, "안드로이드"],
  [/Macintosh|Mac OS X/, "맥"],
  [/Windows/, "윈도우"],
  [/Linux|X11/, "리눅스"],
];

function pick(list, ua) {
  for (const [re, label] of list) if (re.test(ua)) return label;
  return "";
}

/**
 * @param {string} ua `req.get("user-agent")`
 * @returns {string} `크롬/맥` · `사파리/아이폰` · 한쪽만 알면 그 조각만 · 전혀 모르면 `""`.
 *   빈 문자열을 돌려주는 이유: 호출부가 '기기 미상' 같은 군더더기 없이 그 조각만 생략할 수 있게.
 */
function deviceLabel(ua) {
  const s = String(ua || "");
  if (!s) return "";
  const browser = pick(BROWSERS, s);
  const platform = pick(PLATFORMS, s);
  if (browser && platform) return `${browser}/${platform}`;
  return browser || platform || "";
}

module.exports = { deviceLabel };
