"use strict";

// Render cron 서비스가 실행하는 트리거 — Google→앱 연락처 역방향 동기화.
// web 서비스의 /internal/cron/contacts-sync 를 HTTP POST로 호출한다.
// 의존성 없음(Node ≥20 내장 fetch만 사용).
//
// 환경변수:
//   BACKUP_TOKEN      web와 동일한 시크릿(필수)
//   CRON_TRIGGER_URL  명시적 트리거 URL(선택, 최우선)
//   WEB_HOSTPORT      Render fromService(property: hostport)로 주입되는 web 내부 host:port(선택)

(async () => {
  const token = process.env.BACKUP_TOKEN || "";
  const url =
    process.env.CRON_TRIGGER_URL ||
    (process.env.WEB_HOSTPORT ? `http://${process.env.WEB_HOSTPORT}/internal/cron/contacts-sync` : "") ||
    "http://localhost:3000/internal/cron/contacts-sync";

  if (!token) {
    console.error("[contacts-sync-trigger] BACKUP_TOKEN 미설정 — 중단");
    process.exit(1);
  }

  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
    });
    const text = await res.text();
    let summary = "";
    try {
      const j = JSON.parse(text);
      if (j.skipped) summary = "skipped(미연동)";
      else if (j.error) summary = `error=${j.error}`;
      else summary = `created=${j.created} updated=${j.updated} deleted=${j.deleted}`;
    } catch (_e) {
      summary = text.slice(0, 200);
    }
    console.log(`[contacts-sync-trigger] ${res.status} ${url} ${summary}`);
    process.exit(res.ok ? 0 : 1);
  } catch (e) {
    console.error(`[contacts-sync-trigger] 요청 실패 (${url}):`, e && e.message ? e.message : e);
    process.exit(1);
  }
})();
