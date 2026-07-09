"use strict";

/**
 * 첨부 업로드 공용 헬퍼(2026-07-09 감사 후속) — clients(사업자등록증)·workers(주민등록증·통장사본) 라우트에
 * 복제돼 있던 **보안 로직**(매직바이트 화이트리스트·업로드 한도·한글 파일명 복원)을 단일화.
 * 한쪽만 고쳐 정책이 갈라지는 드리프트(허용 타입·한도 불일치) 방지가 목적. 라우트 핸들러 자체는
 * 게이트(requireEditor vs requireChief)·엔티티 조회가 달라 각 파일에 유지한다.
 */

const os = require("os");
const fs = require("fs");
const crypto = require("crypto");
const multer = require("multer");

/** 첨부 공통 업로드 한도(MB) — 클라이언트·외주 동일 정책. */
const ATTACHMENT_MAX_MB = 10;

/**
 * multer 디스크 업로더(메모리 금지 — OOM 방지, 플레이북 §3-2).
 * @param {string} prefix 임시 파일명 접두(예: "omgcf_"·"omgwf_" — 디버깅 시 출처 구분용)
 */
function buildUpload(prefix) {
  return multer({
    storage: multer.diskStorage({
      destination: (_req, _file, cb) => cb(null, os.tmpdir()),
      filename: (_req, _file, cb) => cb(null, prefix + crypto.randomBytes(8).toString("hex")),
    }),
    limits: { fileSize: ATTACHMENT_MAX_MB * 1024 * 1024 },
  });
}

/** multipart 파일명 latin1 → UTF-8 복원(한글 파일명 보존, 함정 #6). */
function decodeName(name) {
  try { return Buffer.from(String(name || ""), "latin1").toString("utf8"); } catch { return String(name || ""); }
}

/**
 * 파일 첫 4바이트 매직바이트로 실제 형식 검증(Content-Type 스푸핑 방어, 함정 #12).
 * PNG(89 50 4E 47)·JPEG(FF D8 FF)·PDF(25 50 44 46)만 허용 — SVG 등 스크립트 가능 형식 차단(stored-XSS 방지).
 * 반환: 검증된 MIME 타입 문자열, 또는 null(불허).
 */
function detectMimeFromFile(filePath) {
  const buf = Buffer.alloc(4);
  let fd;
  try {
    fd = fs.openSync(filePath, "r");
    fs.readSync(fd, buf, 0, 4, 0);
  } catch { return null; } finally { if (fd !== undefined) { try { fs.closeSync(fd); } catch {} } }
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return "image/png";
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return "image/jpeg";
  if (buf[0] === 0x25 && buf[1] === 0x50 && buf[2] === 0x44 && buf[3] === 0x46) return "application/pdf";
  return null;
}

module.exports = { buildUpload, decodeName, detectMimeFromFile, ATTACHMENT_MAX_MB };
