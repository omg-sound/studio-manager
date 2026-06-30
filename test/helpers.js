"use strict";

/**
 * 테스트 공용 헬퍼.
 *
 * ⚠️ 격리 DB 규약: 이 모듈은 src/* 를 require 하지 않는다.
 * 각 *.test.js 가 **자기 파일 맨 위에서** (require 이전에)
 *   process.env.DB_PATH / NODE_ENV 를 직접 설정해야 한다(별도 프로세스마다 독립 DB).
 * 여기서는 그 경로 생성·정리만 돕는다(소스는 읽기 전용, 절대 수정 금지).
 */

const os = require("os");
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");

/** 충돌 없는 임시 DB 파일 경로(프로세스/시각/난수 조합). */
function tempDbPath() {
  const rand = crypto.randomBytes(6).toString("hex");
  return path.join(os.tmpdir(), `omg-test-${process.pid}-${Date.now()}-${rand}.db`);
}

/**
 * 임시 DB 파일 정리. WAL 모드라 -wal/-shm 사이드카까지 지운다.
 * dbHandle 이 있으면 먼저 닫아 파일 핸들을 푼다(better-sqlite3/node:sqlite 공통 close()).
 */
function cleanupDb(dbPath, dbHandle) {
  if (dbHandle && typeof dbHandle.close === "function") {
    try {
      dbHandle.close();
    } catch {
      /* 이미 닫혔으면 무시 */
    }
  }
  for (const ext of ["", "-wal", "-shm"]) {
    try {
      fs.unlinkSync(dbPath + ext);
    } catch {
      /* 없으면 무시 */
    }
  }
}

module.exports = { tempDbPath, cleanupDb };
