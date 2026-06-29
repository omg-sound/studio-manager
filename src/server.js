"use strict";

const path = require("path");
const express = require("express");
const helmet = require("helmet");
const rateLimit = require("express-rate-limit");
const cookieParser = require("cookie-parser");

const { config } = require("./config");
const { init } = require("./db");
const { attachUser } = require("./auth");
const { errorPage } = require("./views");

const authRoutes = require("./routes/auth.routes");
const dashboardRoutes = require("./routes/dashboard.routes");
const projectRoutes = require("./routes/projects.routes");
const deliverableRoutes = require("./routes/deliverables.routes");
const invoiceRoutes = require("./routes/invoices.routes");
const sessionRoutes = require("./routes/sessions.routes");
const clientRoutes = require("./routes/clients.routes");
const workerRoutes = require("./routes/workers.routes");
const settingsRoutes = require("./routes/settings.routes");
const apiRoutes = require("./routes/api.routes");
const maintenanceRoutes = require("./routes/maintenance.routes");

init(); // 스키마/마이그레이션 보장

const app = express();
app.disable("x-powered-by");
app.set("trust proxy", 1); // Render 등 프록시 뒤에서 secure 쿠키/IP 정확히

// ── 보안 헤더(helmet + CSP). 인라인 스크립트 없음 → 엄격 CSP 가능 ──
app.use(
  helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'", "https://fonts.googleapis.com", "https://cdn.jsdelivr.net"],
        fontSrc: ["'self'", "https://fonts.gstatic.com", "https://cdn.jsdelivr.net", "data:"],
        imgSrc: ["'self'", "data:"],
        connectSrc: ["'self'"],
        formAction: ["'self'"],
        frameAncestors: ["'self'"],
        objectSrc: ["'none'"],
        baseUri: ["'self'"],
      },
    },
    crossOriginEmbedderPolicy: false,
  })
);

// ── Rate limit(쓰기/로그인 보호) ──
app.use(
  rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 600, // 1인+소수 클라이언트엔 충분
    standardHeaders: true,
    legacyHeaders: false,
  })
);

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

// 동일 출처 검사(CSRF 방어). 프로토콜(http/https) 차이는 무시하고 host(도메인:포트)로 비교한다.
// CSP upgrade-insecure-requests 등으로 브라우저가 폼 Origin을 https로 올려 보내도 같은 host면 허용.
function hostOf(urlOrHost) {
  if (!urlOrHost) return "";
  try {
    return new URL(urlOrHost.includes("://") ? urlOrHost : `http://${urlOrHost}`).host;
  } catch {
    return "";
  }
}

function sameOriginRequest(req) {
  if (SAFE_METHODS.has(req.method)) return true;

  // 1) Fetch Metadata 우선: 브라우저가 보내는 신뢰 가능한 헤더(JS로 변조 불가).
  //    동일 출처 폼 제출은 same-origin, 외부 사이트의 CSRF는 cross-site로 구분된다.
  const fetchSite = req.get("sec-fetch-site");
  if (fetchSite) {
    return fetchSite === "same-origin" || fetchSite === "same-site" || fetchSite === "none";
  }

  // 2) 폴백: Origin host(도메인:포트) 비교(프로토콜 차이는 무시).
  const origin = req.get("origin");
  if (origin) {
    const originHost = hostOf(origin);
    return originHost === hostOf(req.get("host")) || originHost === hostOf(config.baseUrl);
  }

  // 3) Origin·Sec-Fetch-Site 둘 다 없는 경우:
  //    서버-투-서버 요청(Authorization 헤더 보유) 또는 /internal/ 경로(cron 백업)는 허용.
  //    그 외는 기본 거부(CSRF 강화).
  if (req.get("authorization") || req.path.startsWith("/internal/")) return true;
  return false;
}

app.use((req, res, next) => {
  if (sameOriginRequest(req)) return next();
  // 쿼리스트링은 로그에서 제외(req.path) — 토큰 등 시크릿이 경고 로그에 남지 않도록.
  console.warn(`[bad-origin] ${req.method} ${req.path} sec-fetch-site=${req.get("sec-fetch-site") || "-"} origin=${req.get("origin") || "-"}`);
  if (req.accepts("html")) return res.status(403).send(errorPage({ code: 403, title: "요청 출처를 확인할 수 없습니다", message: "보안을 위해 외부 출처에서 온 요청을 차단했습니다.", user: null }));
  return res.status(403).json({ error: "bad_origin" });
});

app.use(cookieParser());
app.use(express.urlencoded({ extended: true })); // 클래식 폼 POST
app.use(express.json());

// 모든 요청에 req.user 부착(라우트 차단은 각 라우트의 미들웨어가 담당)
app.use(attachUser);

// 헬스체크(인증 불필요)
app.get("/healthz", (_req, res) => res.json({ ok: true }));

// ── 라우트 ──
// 중요(플레이북 §3-1): 인증 게이팅 라우트가 정적 서빙보다 먼저 와야 한다.
// 보호 대상 HTML은 모두 서버 렌더 라우트이며, static은 /css·/js 자산만 제공한다.
app.use("/", authRoutes); // /login, /auth/google, /logout, (/dev-login)
app.use("/", apiRoutes); // REST API blueprint (/api/...)
app.use("/", maintenanceRoutes); // /internal/cron/* (BACKUP_TOKEN 게이트, 세션 불필요)
app.use("/", dashboardRoutes); // /  (requireAuth)
app.use("/projects", projectRoutes); // requireAuth (+ client 범위 제한)
app.use("/", deliverableRoutes); // /deliverables, /projects/:pid/deliverables, 공개 /d/:token
app.use("/invoices", invoiceRoutes); // requireInvoice (치프/대표)
app.use("/", sessionRoutes); // /sessions (일정) + 세션 CRUD
app.use("/clients", clientRoutes); // requireChief
app.use("/workers", workerRoutes); // requireChief (외주 작업자 + 정산)
app.use("/settings", settingsRoutes); // requireAdmin

// 정적 자산(css/js)만 — 보호 대상 HTML은 여기 없음
app.use(
  express.static(path.join(__dirname, "..", "public"), {
    index: false,
    maxAge: config.isProd ? "1h" : 0,
  })
);

// 404
app.use((req, res) => {
  if (req.accepts("html")) return res.status(404).send(errorPage({ code: 404, title: "페이지를 찾을 수 없습니다", message: "주소를 확인해 주세요.", user: req.user }));
  res.status(404).json({ error: "not_found" });
});

// 전역 에러 핸들러(필수: listen 안정화 + 500 노출 방지)
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, _next) => {
  console.error("[error]", err && err.stack ? err.stack : err);
  if (res.headersSent) return;
  if (err && err.code === "LIMIT_FILE_SIZE") {
    const msg = `업로드 파일은 ${config.maxUploadMb}MB 이하여야 합니다.`;
    if (req.accepts("html")) return res.status(413).send(errorPage({ code: 413, title: "파일이 너무 큽니다", message: msg, user: req.user }));
    return res.status(413).json({ error: "file_too_large", maxUploadMb: config.maxUploadMb });
  }
  if (req.accepts("html")) return res.status(500).send(errorPage({ code: 500, title: "서버 오류가 발생했습니다", message: "잠시 후 다시 시도해 주세요.", user: req.user }));
  res.status(500).json({ error: "server_error" });
});

// 0.0.0.0 바인딩(플레이북 §3-5): 포트 즉시 감지로 무중단 재배포
const server = app.listen(config.port, "0.0.0.0", () => {
  console.log(`🎙️  OMG Studios Manager listening on ${config.baseUrl} (port ${config.port})`);
  if (config.devLogin) console.log("⚠️  DEV_LOGIN 활성화 — /dev-login 사용 가능(프로덕션 금지)");
  if (!config.googleConfigured) console.log("ℹ️  Google OAuth 미설정 — 관리자 OAuth 로그인 비활성(DEV_LOGIN으로 검증)");
});

process.on("unhandledRejection", (r) => console.error("[unhandledRejection]", r));
process.on("uncaughtException", (e) => console.error("[uncaughtException]", e));

module.exports = server;
