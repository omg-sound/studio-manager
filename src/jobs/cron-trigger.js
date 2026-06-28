"use strict";

// Render cron 서비스가 실행하는 트리거. web 서비스의 일일 유지보수 엔드포인트를 HTTP로 호출한다.
// 의존성 없음(Node ≥20 내장 fetch만 사용) → cron 서비스는 native 빌드/패키지가 불필요하다.
//
// 환경변수:
//   BACKUP_TOKEN      web와 동일한 시크릿(필수)
//   CRON_TRIGGER_URL  명시적 트리거 URL(선택, 최우선)
//   WEB_HOSTPORT      Render fromService(property: hostport)로 주입되는 web 내부 host:port(선택)
//
// 종료코드: 성공 0, 실패 1(Render가 실패한 cron 실행으로 표시).

(async () => {
  const token = process.env.BACKUP_TOKEN || "";
  const url =
    process.env.CRON_TRIGGER_URL ||
    (process.env.WEB_HOSTPORT ? `http://${process.env.WEB_HOSTPORT}/internal/cron/daily` : "") ||
    "http://localhost:3000/internal/cron/daily";

  if (!token) {
    console.error("[cron-trigger] BACKUP_TOKEN 미설정 — 중단");
    process.exit(1);
  }

  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
    });
    const text = await res.text();
    // 응답 본문에는 연체 고객명·잔액·백업 절대경로가 들어 있다 → 로그에는 비민감 요약만 남긴다.
    let summary = "";
    try {
      const j = JSON.parse(text);
      summary = `ok=${j.ok} overdue=${j.overdue ? j.overdue.count : "?"}` + (j.backupError ? ` backupError=${j.backupError}` : "");
    } catch (_e) {
      summary = text.slice(0, 200); // JSON이 아니면(에러 페이지 등) 앞부분만
    }
    console.log(`[cron-trigger] ${res.status} ${url} ${summary}`);
    process.exit(res.ok ? 0 : 1);
  } catch (e) {
    console.error(`[cron-trigger] 요청 실패 (${url}):`, e && e.message ? e.message : e);
    process.exit(1);
  }
})();
