"use strict";

// ── 웹훅 SSRF 방어(함정 #11) 회귀 잠금 ──
// isPrivateIp/isSsrfSafe는 알림 웹훅을 fetch하기 전 사설·링크로컬 대역을 차단하는 유일한 방어선.
// 대역 경계·IPv4-mapped IPv6 우회는 미묘해 리팩터 시 조용히 깨지기 쉬워(무테스트였음) 여기서 기계 잠금.
process.env.NODE_ENV = "test";
const test = require("node:test");
const assert = require("node:assert");
const { isPrivateIp, isSsrfSafe } = require("../src/notify");

test("isPrivateIp: 사설·루프백·링크로컬 대역은 차단(true)", () => {
  const blocked = [
    "127.0.0.1", "127.255.255.254",     // 루프백 127/8
    "10.0.0.1", "10.255.255.255",       // 사설 10/8
    "172.16.0.1", "172.31.255.255",     // 사설 172.16/12
    "192.168.0.1", "192.168.255.255",   // 사설 192.168/16
    "169.254.169.254",                  // 링크로컬(클라우드 IMDS — SSRF 단골 표적)
    "0.0.0.0",
    "::1",                              // IPv6 루프백
    "fc00::1", "fd12:3456::1",          // fc00::/7 ULA
    "fe80::1", "feab::1",               // fe80::/10 링크로컬
  ];
  for (const ip of blocked) assert.equal(isPrivateIp(ip), true, `${ip} 차단 기대`);
});

test("isPrivateIp: IPv4-mapped IPv6(::ffff:) 매핑 우회도 차단", () => {
  // ::ffff:127.0.0.1 같은 매핑을 그대로 두면 IPv4 패턴을 안 타 우회됨 → 정규화 후 재검사해야 차단.
  for (const ip of ["::ffff:127.0.0.1", "::ffff:10.0.0.1", "::ffff:192.168.1.1", "::ffff:169.254.169.254"]) {
    assert.equal(isPrivateIp(ip), true, `${ip} 매핑 우회 차단 기대`);
  }
});

test("isPrivateIp: 공인 IP·대역 경계 바깥은 허용(false)", () => {
  const allowed = [
    "8.8.8.8", "1.1.1.1", "203.0.113.1", // 공인 IPv4
    "11.0.0.1", "9.255.255.255",         // 10/8 경계 바깥
    "172.15.255.255", "172.32.0.1",      // 172.16/12 경계 바깥(오프바이원 방지)
    "192.167.255.255", "192.169.0.1",    // 192.168/16 경계 바깥
    "169.253.0.1", "169.255.0.1",        // 169.254/16 경계 바깥
    "126.255.255.255", "128.0.0.1",      // 127/8 경계 바깥
    "2001:4860:4860::8888",              // 공인 IPv6(구글 DNS)
  ];
  for (const ip of allowed) assert.equal(isPrivateIp(ip), false, `${ip} 허용 기대`);
});

test("isSsrfSafe: IP 리터럴 호스트는 DNS 없이 대역만으로 판정", async () => {
  assert.equal(await isSsrfSafe("http://127.0.0.1/hook"), false, "루프백 차단");
  assert.equal(await isSsrfSafe("http://169.254.169.254/latest/meta-data"), false, "IMDS 차단");
  assert.equal(await isSsrfSafe("http://[::1]:8080/x"), false, "IPv6 루프백 차단");
  assert.equal(await isSsrfSafe("http://8.8.8.8/hook"), true, "공인 IP 허용");
});

test("isSsrfSafe: 파싱 실패는 차단(false)", async () => {
  assert.equal(await isSsrfSafe("not a url"), false);
  assert.equal(await isSsrfSafe(""), false);
});
