"use strict";

require("dotenv").config();

const path = require("path");

// Render는 RENDER_EXTERNAL_URL을 자동 주입한다 → BASE_URL로 도출(플레이북1 §1).
const baseUrl =
  process.env.RENDER_EXTERNAL_URL ||
  process.env.BASE_URL ||
  `http://localhost:${process.env.PORT || 3000}`;

const config = {
  env: process.env.NODE_ENV || "development",
  port: parseInt(process.env.PORT || "3000", 10),
  baseUrl: baseUrl.replace(/\/+$/, ""),

  adminEmail: (process.env.ADMIN_EMAIL || "").trim().toLowerCase(),

  // 자료 저장 Drive는 **이 계정 하나로 영구 고정**한다(치프가 바뀌어도 무관).
  // 이 이메일로 로그인할 때만 Drive refresh token을 저장 → 항상 스튜디오 계정 Drive에 저장.
  // 기본 studio@omgworks.kr, 배포 env(STUDIO_DRIVE_EMAIL)로만 변경(앱 UI로는 못 바꿈).
  studioDriveEmail: (process.env.STUDIO_DRIVE_EMAIL || "studio@omgworks.kr").trim().toLowerCase(),

  sessionSecret: process.env.SESSION_SECRET || "dev-insecure-session-secret",
  tokenEncKey: process.env.TOKEN_ENC_KEY || "dev-insecure-token-enc-key",

  google: {
    clientId: process.env.GOOGLE_CLIENT_ID || "",
    clientSecret: process.env.GOOGLE_CLIENT_SECRET || "",
    get redirectUri() {
      return `${baseUrl.replace(/\/+$/, "")}/auth/google/callback`;
    },
  },

  dbPath: path.resolve(process.env.DB_PATH || "./data/app.db"),
  maxUploadMb: parseInt(process.env.MAX_UPLOAD_MB || "200", 10),
  // 로컬 스토리지 백엔드 디렉터리(DB와 같은 디스크에). Render는 영속 Disk(/var/data/uploads).
  uploadsDir: path.join(path.dirname(path.resolve(process.env.DB_PATH || "./data/app.db")), "uploads"),

  // 개발 전용 로그인(OAuth 자격증명 없이 로컬 검증). 프로덕션에서는 반드시 빈 값.
  devLogin: process.env.DEV_LOGIN === "1" || process.env.DEV_LOGIN === "true",

  backupToken: process.env.BACKUP_TOKEN || "",

  cookieName: "omg_session",
  sessionMaxAgeMs: 30 * 24 * 60 * 60 * 1000, // 30일
};

config.isProd = config.env === "production";
config.googleConfigured = Boolean(config.google.clientId && config.google.clientSecret);

function isWeakSecret(value, devDefault) {
  const v = String(value || "").trim();
  return !v || v === devDefault || /^change-me/i.test(v) || v.length < 32;
}

function validateConfig() {
  const errors = [];
  if (!Number.isInteger(config.port) || config.port <= 0) errors.push("PORT must be a positive integer");
  if (!Number.isInteger(config.maxUploadMb) || config.maxUploadMb <= 0) {
    errors.push("MAX_UPLOAD_MB must be a positive integer");
  }

  if (config.isProd) {
    if (config.devLogin) errors.push("DEV_LOGIN must be disabled in production");
    if (!config.adminEmail) errors.push("ADMIN_EMAIL is required in production");
    if (isWeakSecret(config.sessionSecret, "dev-insecure-session-secret")) {
      errors.push("SESSION_SECRET must be set to a strong random value in production");
    }
    if (isWeakSecret(config.tokenEncKey, "dev-insecure-token-enc-key")) {
      errors.push("TOKEN_ENC_KEY must be set to a strong random value in production");
    }
    if (!config.googleConfigured) {
      errors.push("GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET are required for production admin login");
    }
    // 백업/연체 cron 인증 토큰. 미설정 시 백업이 조용히 비활성(404)되므로 프로덕션에서 강제.
    // (다른 시크릿과 동일한 강도 가드 — render.yaml은 web·cron 양쪽에 같은 값을 sync:false로 받는다.)
    if (isWeakSecret(config.backupToken, "")) {
      errors.push("BACKUP_TOKEN must be set to a strong random value (>=32 chars) in production (백업/연체 cron 인증; 예: openssl rand -hex 32)");
    }
  }

  if (errors.length) throw new Error("Configuration error:\n- " + errors.join("\n- "));
}

validateConfig();

// ── 도메인 상수: 옵션값은 코드가 단일 진실원천. DB CHECK 제약 금지(플레이북 §2.8) ──
// owner = OMG 대표(전체 열람 모니터링 + 청구 관리), chief = 치프 엔지니어(운영 전반),
// staff = 녹음실 엔지니어/매니저(프로젝트·항목·작업·자료 편집까지).
// 전원 Google 화이트리스트 로그인(거래처 외부 열람은 폐기).
const ROLES = ["owner", "chief", "staff"];
const ROLE_LABELS = { owner: "대표", chief: "치프 엔지니어", staff: "스태프" };

// 프로젝트 유형 2종(핵심 모티브):
//  session = 클라이언트가 방문해 담당자와 실시간으로 진행. 예약 + 실제 작업시간이 존재(세션 일정 탭 노출).
//  task    = 예약 없이 항목만 존재하는 업무흐름(세션 일정 탭 숨김, 곡·콘텐츠 중심).
const PROJECT_TYPES = [
  // label = 배지·제목용, menuLabel = '+ 새 프로젝트' 드롭다운 표기(액션형).
  { key: "session", label: "세션", menuLabel: "세션 프로젝트 만들기", hint: "클라이언트 방문 · 예약 · 실시간 작업" },
  { key: "task", label: "작업", menuLabel: "작업 프로젝트 만들기", hint: "예약 없이 항목 단위로 진행" },
];
const PROJECT_TYPE_LABELS = Object.fromEntries(PROJECT_TYPES.map((t) => [t.key, t.label]));
const PROJECT_TYPE_KEYS = PROJECT_TYPES.map((t) => t.key);

const PROJECT_SERVICES = [
  { key: "recording", label: "녹음" },
  { key: "vocal_tune", label: "보컬튠" },
  { key: "mixing", label: "믹싱" },
  { key: "mastering", label: "마스터링" },
];
// 단가표(녹음 종류) 분류 — 녹음 세션 폼에서 이 분류로 묶어 보여준다.
const RECORDING_CATEGORIES = ["스튜디오 녹음", "로케이션 녹음"];
const CLIENT_KINDS = ["아티스트", "그룹", "소속사/레이블", "제작사", "기타"]; // 그룹=밴드·아이돌 그룹 등 그룹 아티스트(parties.kind='group')
const COMPANY_ROLES = ["소속사/레이블", "제작사"]; // 업체 역할 다중(겸업: 소속사가 제작도 함). CSV로 clients.roles에 저장
const DELIVERABLE_KINDS = ["녹음본", "튠본", "믹스", "스템", "마스터", "레퍼런스", "기타"];
// 청구서(bill) 발행 상태 — 계산서·입금 진행과 별개 축(2026-07-01 분리).
const INVOICE_STATUSES = ["미발행", "발행"];
const INVOICE_STATUS_LABELS = { 미발행: "청구서 미발행", 발행: "청구서 발행" };
// 계산서(세금계산서)·입금 상태 — 청구서 발행과 독립적으로 진행(자유 선택). '입금완료'는 완납 처리와 연동.
const TAX_STATUSES = ["계산서 미발행", "계산서 발행", "입금완료"];
// 청구 PDF 문서 제목 — 발행 시 골라서(내용 동일, 제목·일부 문구만 분기).
const DOC_TYPES = ["견적서", "내역서", "거래명세서"];
const TRACK_CONTENT_TYPES = ["Music", "Video_Post"];
const TRACK_CONTENT_TYPE_LABELS = {
  Music: "음악",
  Video_Post: "영상 후시/포스트",
};
// 작업 종류: DB 카탈로그(task_types)의 시드 데이터. 부팅 시 1회 시드 후로는 DB가 단일 진실원천.
// billing=기본 과금, price=기본 단가(원), quick=곡·콘텐츠 '빠른 추가' 버튼 노출.
const TASK_TYPES = [
  { key: "Vocal_Recording", label: "보컬 녹음", group: "Recording", billing: "Time_Charge", price: 0, quick: false },
  { key: "Instrument_Recording", label: "악기 녹음", group: "Recording", billing: "Time_Charge", price: 0, quick: false },
  { key: "ADR_Recording", label: "ADR/후시 녹음", group: "Recording", billing: "Time_Charge", price: 0, quick: false },
  { key: "Vocal_Tuning", label: "보컬튠", group: "Post_Production", billing: "Fixed_Per_Track", price: 0, quick: true },
  { key: "Audio_Editing", label: "오디오 편집", group: "Post_Production", billing: "Fixed_Per_Track", price: 0, quick: true },
  { key: "Mixing", label: "믹싱", group: "Mix_Master", billing: "Fixed_Per_Track", price: 0, quick: true },
  { key: "Mastering", label: "마스터링", group: "Mix_Master", billing: "Fixed_Per_Track", price: 0, quick: true },
  { key: "Audio_Dub_Mixing", label: "더빙 믹싱", group: "Video_Audio", billing: "Fixed_Per_Track", price: 0, quick: false },
  { key: "SFX_Foley", label: "SFX/Foley", group: "Video_Audio", billing: "Fixed_Per_Track", price: 0, quick: false },
];
// 작업 종류 분류(그룹) — 구조적 상수(요약·빠른버튼 그룹핑). 카탈로그 행이 이를 참조.
const TASK_GROUPS = ["Recording", "Post_Production", "Mix_Master", "Video_Audio"];
const TASK_GROUP_LABELS = { Recording: "녹음", Post_Production: "후반 작업", Mix_Master: "믹스·마스터", Video_Audio: "영상 오디오" };
const BILLING_TYPES = ["Time_Charge", "Fixed_Per_Track"];
const BILLING_TYPE_LABELS = {
  Time_Charge: "시간 과금",
  Fixed_Per_Track: "트랙/콘텐츠 고정",
};
// 세션(스튜디오 일정). 청구 시간 산정의 기반.
const SESSION_TYPES = ["녹음", "믹싱", "마스터링", "기타"];
const SESSION_STATUSES = ["예정", "완료", "취소"];
// 세션 시간 슬롯(30분 단위). 범위별 생성기.
function timeSlots(startMin, endMin, step = 30) {
  const out = [];
  for (let m = startMin; m <= endMin; m += step) {
    out.push(`${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`);
  }
  return out;
}
// 전체 운영시간(12:00~23:30) — 편집 폼 드롭다운·가용성 검사용.
const SESSION_TIME_SLOTS = timeSlots(12 * 60, 23 * 60 + 30);
// 예약 그리드 기본 노출(14:00~18:30) — 그 외 시간은 '직접입력' 버튼으로.
const SESSION_START_SLOTS = timeSlots(14 * 60, 18 * 60 + 30);
const SESSION_STATUS_BADGE = {
  예정: "bg-primary/10 text-primary",
  완료: "bg-success/10 text-success",
  취소: "bg-muted/10 text-muted",
};

// 작업 상태 = 대기/완료 2단계('진행중' 개념 폐기 — 사용자 결정 2026-07-03). 레거시 In_Progress는 normalize·마이그레이션으로 Pending 처리.
const TASK_STATUSES = ["Pending", "Completed"];
const TASK_STATUS_LABELS = {
  Pending: "대기",
  Completed: "완료",
};
const TASK_STATUS_BADGE = {
  Pending: "bg-muted/10 text-muted",
  Completed: "bg-success/10 text-success",
};

// 인보이스 상태 배지 색. '연체'는 코드에서 파생(별도 상태 아님).
const INVOICE_STATUS_BADGE = {
  미발행: "bg-muted/10 text-muted",
  "청구서 미발행": "bg-muted/10 text-muted",
  발행: "bg-primary/10 text-primary",
  "청구서 발행": "bg-primary/10 text-primary",
  "계산서 미발행": "bg-muted/10 text-muted",
  "계산서 발행": "bg-info/10 text-info",
  입금완료: "bg-success/10 text-success",
  연체: "bg-danger/10 text-danger",
  부분납: "bg-warning/10 text-warning",
};

/** 화이트리스트 정규화: 허용 목록에 없으면 fallback(첫 값) 반환(플레이북2 §9). */
function normalize(value, allowed, fallback) {
  const v = (value || "").trim();
  return allowed.includes(v) ? v : fallback !== undefined ? fallback : allowed[0];
}

const PROJECT_SERVICE_KEYS = PROJECT_SERVICES.map((s) => s.key);
const PROJECT_SERVICE_LABELS = Object.fromEntries(PROJECT_SERVICES.map((s) => [s.key, s.label]));

module.exports = {
  config,
  ROLES,
  ROLE_LABELS,
  normalizeRole: (v) => normalize(v, ROLES, "staff"),
  PROJECT_TYPES,
  PROJECT_TYPE_LABELS,
  PROJECT_TYPE_KEYS,
  normalizeProjectType: (v) => normalize(v, PROJECT_TYPE_KEYS, "session"),
  PROJECT_SERVICES,
  PROJECT_SERVICE_KEYS,
  PROJECT_SERVICE_LABELS,
  CLIENT_KINDS,
  COMPANY_ROLES,
  DELIVERABLE_KINDS,
  INVOICE_STATUSES,
  INVOICE_STATUS_LABELS,
  TAX_STATUSES,
  normalizeTaxStatus: (v) => normalize(v, TAX_STATUSES, "계산서 미발행"),
  DOC_TYPES,
  normalizeDocType: (v) => normalize(v, DOC_TYPES, "거래명세서"),
  INVOICE_STATUS_BADGE,
  TRACK_CONTENT_TYPES,
  TRACK_CONTENT_TYPE_LABELS,
  TASK_TYPES,
  TASK_GROUPS,
  TASK_GROUP_LABELS,
  BILLING_TYPES,
  BILLING_TYPE_LABELS,
  TASK_STATUSES,
  TASK_STATUS_LABELS,
  TASK_STATUS_BADGE,
  SESSION_TYPES,
  SESSION_STATUSES,
  SESSION_STATUS_BADGE,
  SESSION_TIME_SLOTS,
  SESSION_START_SLOTS,
  timeSlots,
  RECORDING_CATEGORIES,
  normalizeRecordingCategory: (v) => normalize(v, RECORDING_CATEGORIES),
  normalizeSessionType: (v) => normalize(v, SESSION_TYPES),
  normalizeSessionStatus: (v) => normalize(v, SESSION_STATUSES),
  normalizeClientKind: (v) => normalize(v, CLIENT_KINDS),
  normalizeDeliverableKind: (v) => normalize(v, DELIVERABLE_KINDS),
  normalizeInvoiceStatus: (v) => normalize(v, INVOICE_STATUSES),
  normalizeTrackContentType: (v) => normalize(v, TRACK_CONTENT_TYPES),
  normalizeTaskGroup: (v) => normalize(v, TASK_GROUPS),
  normalizeBillingType: (v) => normalize(v, BILLING_TYPES),
  normalizeTaskStatus: (v) => normalize(v, TASK_STATUSES),
  normalize,
};
