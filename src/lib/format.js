"use strict";

/**
 * 값 정규화 순수 헬퍼 — 전화·사업자등록번호 하이픈 형식(의존성 0).
 * parties(연락처·업체 저장)·studio(공급자 세금정보)·db(1회 백필)가 공유한다.
 */

/**
 * 전화번호 정규화 — 공백·점 등 구분자 무관하게 숫자만 뽑아 하이픈 형식으로 저장.
 * 11자리=###-####-####(휴대폰·11자리 지역), 02+10자리=02-####-####, 02+9자리=02-###-####,
 * 그 외 10자리=0##-###-####(지역번호), 8자리=####-####(국번 없는 지역). 형식 불명(내선·해외)만 원본 보존.
 * 예: "010 3548 5638"→"010-3548-5638", "031 123 4567"→"031-123-4567", "02 123 4567"→"02-123-4567".
 */
const formatPhone = (v) => {
  const raw = String(v == null ? "" : v).trim();
  if (!raw) return null;
  const d = raw.replace(/\D/g, "");
  if (d.length === 11) return `${d.slice(0, 3)}-${d.slice(3, 7)}-${d.slice(7)}`;
  if (d.length === 10 && d.startsWith("02")) return `${d.slice(0, 2)}-${d.slice(2, 6)}-${d.slice(6)}`;
  if (d.length === 10) return `${d.slice(0, 3)}-${d.slice(3, 6)}-${d.slice(6)}`; // 0##-###-#### 지역번호(031·051 등)
  if (d.length === 9 && d.startsWith("02")) return `${d.slice(0, 2)}-${d.slice(2, 5)}-${d.slice(5)}`; // 02-###-####
  if (d.length === 8) return `${d.slice(0, 4)}-${d.slice(4)}`; // ####-#### 국번 없는 지역
  return raw; // 형식 불명(내선·해외 등)만 원본 보존
};

/**
 * 사업자등록번호 정규화 — 구분자 무관하게 숫자만 뽑아 000-00-00000 하이픈 형식(10자리만).
 * 형식 불명(자릿수 다름)은 원본 보존. 빈 값은 null. 전화(formatPhone)와 같은 철학(전 저장 경로 공통).
 */
const formatBizNo = (v) => {
  const raw = String(v == null ? "" : v).trim();
  if (!raw) return null;
  const d = raw.replace(/\D/g, "");
  if (d.length === 10) return `${d.slice(0, 3)}-${d.slice(3, 5)}-${d.slice(5)}`;
  return raw;
};

module.exports = { formatPhone, formatBizNo };
