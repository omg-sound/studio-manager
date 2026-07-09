"use strict";

/**
 * 데이터 접근 계층 — **도메인 모듈 재export 허브**.
 * 실제 구현은 src/data/*.js 도메인 모듈에 있고, 이 파일은 그것들을 한데 모아 재export한다.
 * 소비자는 예전처럼 `require("../data")`로 모든 헬퍼를 얻는다(분리 전후 공개 API 동일).
 *
 * 내부 도구이므로 로그인한 직원(staff/chief/owner)은 모든 프로젝트를 열람한다. 쓰기 권한은 라우트
 * 미들웨어(requireEditor/requireChief/requireInvoice)가 강제하고, 통계·표시 분기는 권한 술어
 * (canInvoice/isChief, auth.js)로 판단한다(거래처 외부 열람은 폐기됨).
 *
 * 도메인 간 의존은 각 모듈이 형제 모듈을 직접 require(무순환)하거나, 상호의존(invoices↔sessions)은
 * 함수 내부 지연 require("../data")로 해소한다(로드 시 순환 회피).
 */

const studio = require("./data/studio"); // 스튜디오(공급자) 설정
const clientFiles = require("./data/client-files"); // 클라이언트 첨부 서류
const workerFiles = require("./data/worker-files"); // 외주 작업자 첨부 서류(2026-07-06)
const revenue = require("./data/revenue"); // 매출 집계
const deliverables = require("./data/deliverables"); // 자료 전달
const rooms = require("./data/rooms"); // 룸
const rateItems = require("./data/rate-items"); // 단가표
const rateCategories = require("./data/rate-categories"); // 단가표 분류(2026-07-05 — DB 기반 커스텀 분류)
const taskTypes = require("./data/task-types"); // 작업 종류 카탈로그(모듈 캐시 포함)
const parties = require("./data/parties"); // 당사자(사람·조직·그룹) 통합 마스터 — clients/contacts 대체
const projects = require("./data/projects"); // 프로젝트
const tracks = require("./data/tracks"); // 트랙/작업 CRUD
const invoicesMod = require("./data/invoices"); // 청구(금액 파생·채번·초안/생성/삭제·목록/통계)
const dashboard = require("./data/dashboard"); // 대시보드 통계
const sessions = require("./data/sessions"); // 세션(스튜디오 일정)

// 작업 종류 카탈로그: 공개 API는 아래 7함수만 재export(normalizeTaskTypeDb는 내부전용이므로 spread하지 않고 명시 나열).
const { listTaskTypes, activeTaskTypes, taskTypeLabel, taskTypeUnitPrice, createTaskType, updateTaskType, moveTaskType, deleteTaskType } = taskTypes;

module.exports = {
  ...parties, // src/data/parties.js — 당사자 통합(사람/조직/아티스트/담당자연동)
  ...rooms, // src/data/rooms.js
  ...rateItems, // src/data/rate-items.js
  ...rateCategories, // src/data/rate-categories.js
  listTaskTypes, // src/data/task-types.js (7함수, normalizeTaskTypeDb 내부전용 제외)
  activeTaskTypes,
  taskTypeLabel,
  taskTypeUnitPrice,
  createTaskType,
  updateTaskType,
  moveTaskType,
  deleteTaskType,
  ...projects, // src/data/projects.js (distinctProjectFields·listProjects·getProjectForUser·deleteProject)
  ...tracks, // src/data/tracks.js
  ...invoicesMod, // src/data/invoices.js (nextInvoiceNumber·computeInvoiceDraft 내부전용 제외)
  ...dashboard, // src/data/dashboard.js
  ...deliverables, // src/data/deliverables.js
  ...studio, // src/data/studio.js
  ...sessions, // src/data/sessions.js
  ...revenue, // src/data/revenue.js
  ...clientFiles, // src/data/client-files.js
  ...workerFiles, // src/data/worker-files.js
};
