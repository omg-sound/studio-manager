"use strict";

const os = require("os");
const fs = require("fs");
const crypto = require("crypto");
const express = require("express");
const multer = require("multer");
const { db } = require("../db");
const { requireChief, requireEditor, isChief } = require("../auth");
const { COMPANY_ROLES } = require("../config");
const {
  listClients, clientKindCounts, getParty, listProjectsForParty,
  listInvoicesForParty, listPersonsForOrg,
  listClientFiles, getClientFile, upsertClientFile, deleteClientFile,
  contactOptions, addAffiliation, listContacts, resolvePersonByName, orgsWithOwnerParty,
  listArtistsForAgency, resolveCompanyByName,
  createCompany, createGroup, createPerson, updateParty, deleteParty,
  listGroupsForPicker, setPartyGroup, listGroupMembers, artistPersonOptions, groupOfParty,
  setPartyAgency, currentAgencyId,
} = require("../data");
const storage = require("../storage");
const { asyncHandler } = require("../lib/async");
const { formatBizNo } = require("../lib/forms");
const { layout, pageHeader, esc, personLabel, flashBanner, emptyState, formatKRW, errorPage, tabBar, filterChips, projectTypeBadge, listGroup, listRow, listRowLinked, explain } = require("../views");
const { invoiceRow } = require("../views.invoices");

const router = express.Router();

router.use(requireEditor); // 클라이언트 전 라우트(목록·상세·편집·첨부 서류) 편집자(치프·스태프). 매출만 별도 제한(revenue).

// 첨부 서류 업로드: 디스크 스토리지(메모리 금지 — OOM 방지, 플레이북 §3-2), 10MB 제한
const upload = multer({
  storage: multer.diskStorage({
    destination: (_req, _file, cb) => cb(null, os.tmpdir()),
    filename: (_req, _file, cb) => cb(null, "omgcf_" + crypto.randomBytes(8).toString("hex")),
  }),
  limits: { fileSize: 10 * 1024 * 1024 },
});

/** multipart 파일명 latin1 → UTF-8 복원(한글 파일명 보존). */
function decodeName(name) {
  try { return Buffer.from(String(name || ""), "latin1").toString("utf8"); } catch { return String(name || ""); }
}

/**
 * 파일 첫 4바이트 매직바이트로 실제 형식 검증(Content-Type 스푸핑 방어).
 * PNG(89 50 4E 47)·JPEG(FF D8 FF)·PDF(25 50 44 46) 만 허용.
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

/** 첨부 서류 종류 목록(화이트리스트). */
const FILE_KINDS = [
  { key: "biz_license", label: "사업자등록증" },
  // 통장사본 폐기(2026-07-01): 스튜디오가 업체에 입금할 일이 없어 불필요. 과거 업로드분은 raw 열람만 가능(업로드 UI 없음).
];

function fileKindLabel(key) {
  const f = FILE_KINDS.find((k) => k.key === key);
  return f ? f.label : key;
}

/** 폼에서 업체 역할(CSV) 추출: 체크된 유효 roles만(없으면 null → 배지 '업체' 폴백). 업체 유형에서만 호출. */
function companyRolesFrom(b) {
  const checked = [].concat(b.roles || []).filter((r) => COMPANY_ROLES.includes(r));
  return checked.length ? checked.join(",") : null;
}
/** 업체 역할 표시 라벨 — 내부값 '제작사'는 '제작사/운영사'로 표기(저장값은 '제작사' 유지, 프로젝트·마이그레이션 호환). */
function companyRoleLabel(role) { return role === "제작사" ? "제작사/운영사" : role; }
/** 업체 역할 배열(roles CSV 우선, 없으면 kind 폴백). 배지 표시용. */
function clientRoleList(c) {
  const r = String(c.roles || "").split(",").map((x) => x.trim()).filter(Boolean);
  return r; // roles CSV(겸업). 없으면 빈 배열 → 배지에서 '업체'로 폴백
}

// ── 목록(서브메뉴 = 업체/아티스트 우선 분리 + 업체 내 분류 · 이름 검색) ──
router.get("/", (req, res) => {
  // 당사자 모델 4분류: 업체(company) / 아티스트(개인 솔로=person·is_artist) / 그룹(밴드·아이돌 그룹=group) / 전체.
  const group = ["artist", "company", "group"].includes(req.query.group) ? req.query.group : "";
  const activeKind = ""; // 레거시 2차 필터 제거(호환용 빈값 유지)
  const q = String(req.query.q || "").trim();

  const isSoloArtist = (c) => c.is_artist && c.kind === "person";
  const allRows = listClients({});
  let rows = allRows;
  if (group === "artist") rows = allRows.filter(isSoloArtist);
  else if (group === "group") rows = allRows.filter((c) => c.kind === "group");
  else if (group === "company") rows = allRows.filter((c) => c.kind === "company");

  const artistCount = allRows.filter(isSoloArtist).length;
  const groupCount = allRows.filter((c) => c.kind === "group").length;
  const companyCount = allRows.filter((c) => c.kind === "company").length;
  const total = allRows.length;

  // 라우트 레벨 이름 필터(data.js 수정 없이)
  const ql = q.toLowerCase();
  const displayed = q ? rows.filter((c) => c.name.toLowerCase().includes(ql)) : rows;

  const qs = (params) => {
    const p = Object.entries(params).filter(([, v]) => v).map(([k, v]) => `${k}=${encodeURIComponent(v)}`);
    if (q) p.push("q=" + encodeURIComponent(q));
    return p.length ? "/clients?" + p.join("&") : "/clients";
  };
  // 1차 서브메뉴(전체/업체/아티스트) — 탭 스타일(연락처 탭과 통일)
  const groupChips = tabBar({
    tabs: [
      { key: "", label: `전체 ${total}` },
      { key: "company", label: `업체 ${companyCount}` },
      { key: "artist", label: `아티스트 ${artistCount}` },
      { key: "group", label: `그룹 ${groupCount}` },
    ],
    activeKey: group,
    hrefFn: (key) => qs({ group: key }),
  });
  const kindChips = ""; // 2차 분류 필터 폐기(당사자 모델 — 조직 겸업은 roles 배지로 표시)

  const searchBar = `
    <form method="get" action="/clients" class="mb-4 flex gap-2">
      ${group ? `<input type="hidden" name="group" value="${esc(group)}" />` : ""}
      ${activeKind ? `<input type="hidden" name="kind" value="${esc(activeKind)}" />` : ""}
      <input class="input min-w-0 flex-1" type="search" name="q" value="${esc(q)}" placeholder="이름 검색" />
      <button class="btn-primary shrink-0" type="submit">검색</button>
    </form>`;

  const clearQHref = group === "company" && activeKind ? `/clients?group=company&kind=${encodeURIComponent(activeKind)}` : group ? `/clients?group=${group}` : "/clients";
  const resultNote = q
    ? `<div class="mb-3 text-sm text-muted">"${esc(q)}" 결과 ${displayed.length}건 · <a href="${clearQHref}" class="text-primary hover:underline">전체 보기</a></div>`
    : "";

  // 상세로 넘어갈 때 현재 필터를 from으로 전달 → 상세의 '← 클라이언트' 백링크가 같은 필터로 복귀.
  const fromQ = [group ? `group=${encodeURIComponent(group)}` : "", activeKind ? `kind=${encodeURIComponent(activeKind)}` : "", q ? `q=${encodeURIComponent(q)}` : ""].filter(Boolean).join("&");
  const fromParam = fromQ ? `?from=${encodeURIComponent(fromQ)}` : "";
  const list = displayed.length
    ? listGroup({
        rows: displayed.map((c) => {
          // 우측 정보(사업자·전화·이메일)는 이름만 링크(listRowLinked)로 분리 → 드래그·복사해도 상세로 안 들어감.
          if (c.is_artist) {
            // 아티스트(개인) / 그룹(밴드·아이돌) — 배지로 구분. 오른쪽에 전화→이메일 세로 스택.
            const badges = c.kind === "group" ? `<span class="badge-info">그룹</span>` : `<span class="badge-info">아티스트</span>`;
            const right = `<div class="text-sm text-muted space-y-0.5">${c.phone ? `<div>${esc(c.phone)}</div>` : ""}<div>${esc(c.email || "이메일 없음")}</div></div>`;
            return listRowLinked({ href: `/clients/${c.id}${fromParam}`, title: esc(personLabel(c.activity_name || c.name, c.name)), badges, right });
          }
          // 업체(company): 대표는 회사명 뒤에 · 오른쪽에 사업자→전화→이메일 세로 스택
          const badges = clientRoleList(c).length ? clientRoleList(c).map((r) => `<span class="badge-neutral">${esc(companyRoleLabel(r))}</span>`).join(" ") : `<span class="badge-neutral">업체</span>`;
          const nameLine = `${esc(c.name)}${c.owner_name ? ` <span class="text-xs font-normal text-muted">· 대표 ${esc(c.owner_name)}</span>` : ""}`;
          const right = `<div class="text-sm text-muted space-y-0.5">
            ${c.biz_no ? `<div>사업자 ${esc(c.biz_no)}</div>` : ""}
            ${c.phone ? `<div>${esc(c.phone)}</div>` : ""}
            <div>${esc(c.email || "이메일 없음")}</div>
          </div>`;
          return listRowLinked({ href: `/clients/${c.id}${fromParam}`, title: nameLine, badges, right });
        }),
      })
    : q
      ? emptyState(`"${esc(q)}" 검색 결과가 없습니다.`, { card: true, icon: "clients" })
      : emptyState(group === "artist" ? "아티스트가 없습니다." : group === "group" ? "그룹이 없습니다." : group === "company" ? "업체가 없습니다." : "클라이언트가 없습니다.", {
          card: true,
          icon: "clients",
          cta: { href: "/clients/new", label: "+ 새 클라이언트" },
        });

  const body = `
    ${flashBanner(req.query)}
    ${pageHeader({ title: "클라이언트", desc: "업체(소속사/레이블·제작사/운영사) · 아티스트(개인) · 그룹(밴드·아이돌). 청구처가 될 수 있습니다.", action: `<a href="/clients/new" class="btn-primary">+ 새 클라이언트</a>` })}
    ${groupChips}
    ${kindChips}
    ${searchBar}
    ${resultNote}
    ${list}`;
  res.send(layout({ title: "클라이언트", user: req.user, current: "/clients", body }));
});

// ── 새 클라이언트 ── 먼저 유형(업체/아티스트/그룹) 선택 → 유형별 폼(서로 섞이지 않는 3개념, '기타' 폐기).
const CLIENT_TYPES = ["company", "artist", "group"];
router.get("/new", (req, res) => {
  const type = CLIENT_TYPES.includes(req.query.type) ? req.query.type : null;
  if (!type) {
    // 유형 선택 화면
    const card = (t, title, desc) => `
      <a href="/clients/new?type=${t}" class="card block transition-colors hover:border-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40">
        <div class="font-display text-lg font-semibold text-fg">${title}</div>
        <p class="mt-1 text-sm text-muted">${desc}</p>
      </a>`;
    const body = `
      ${pageHeader({ title: "새 클라이언트", desc: "먼저 유형을 선택하세요 — 서로 섞이지 않는 세 가지입니다.", back: { href: "/clients", label: "클라이언트" } })}
      <div class="grid gap-3 sm:grid-cols-3">
        ${card("company", "업체", "소속사/레이블 · 제작사/운영사. 사업자·세금계산서 정보.")}
        ${card("artist", "아티스트", "개인(솔로) 아티스트. 현금영수증 · 소속 그룹.")}
        ${card("group", "그룹", "밴드 · 아이돌 그룹. 소속 멤버 연결.")}
      </div>`;
    return res.send(layout({ title: "새 클라이언트", user: req.user, current: "/clients", body }));
  }
  const companies = listClients({}).filter((x) => x.kind === "company");
  res.send(layout({ title: "새 클라이언트", user: req.user, current: "/clients", body: clientForm({}, false, [], "", false, listContacts({}), companies, false, true, listGroupsForPicker(), type) }));
});

router.post("/", (req, res) => {
  const b = req.body;
  const type = CLIENT_TYPES.includes(b.type) ? b.type : "artist"; // 업체/아티스트/그룹(폼 hidden)
  const name = String(b.name || "").trim();
  if (!name) {
    const companies = listClients({}).filter((x) => x.kind === "company");
    return res.send(layout({ title: "새 클라이언트", user: req.user, current: "/clients", body: clientForm({ ...b, _err: "이름을 입력하세요." }, false, [], "", false, listContacts({}), companies, false, true, listGroupsForPicker(), type) }));
  }
  let id;
  if (type === "group") {
    // 그룹 아티스트(밴드·아이돌 그룹) → group party(is_artist, 사람 아님)
    id = createGroup({ name, phone: b.phone, email: b.email, memo: b.memo, cash_receipt_no: b.cash_receipt_no });
  } else if (type === "company") {
    id = createCompany({
      name, phone: b.phone, email: b.email, memo: b.memo,
      biz_no: formatBizNo(b.biz_no), owner_name: b.owner_name,
      owner_party_id: String(b.owner_name || "").trim() ? resolvePersonByName(b.owner_name) : null, // 대표자 → 사람 party 연동
      address: b.address, roles: companyRolesFrom(b),
    });
  } else {
    // 아티스트(개인·솔로) → 사람 party(활동명=이름·is_artist, 현금영수증)
    id = createPerson({
      name, phone: b.phone, email: b.email, memo: b.memo,
      activity_name: name, is_artist: 1, cash_receipt_no: b.cash_receipt_no,
    });
    if (b.group_id) setPartyGroup(id, b.group_id); // 아티스트 생성 시 소속 그룹 선택했으면 연결
  }
  if (type !== "company" && b.agency_id) setPartyAgency(id, b.agency_id); // 아티스트·그룹 소속사 연결('없음'=빈값→no-op)
  if (type === "company") linkClientContact(id, b); // 업체만 담당자 연락처 연동
  res.redirect("/clients?flash=created#c" + id);
});

// ── 수정 ──
// 이제 상세(GET /:id)가 인라인 편집 화면 — 옛 편집 경로는 상세로 리다이렉트(첨부 오류 ferr 보존, 북마크 호환).
router.get("/:id/edit", (req, res) => {
  const id = Number(req.params.id);
  const ferr = String(req.query.ferr || "").trim();
  res.redirect(`/clients/${id}${ferr ? "?ferr=" + encodeURIComponent(ferr) : ""}`);
});

router.post("/:id", (req, res) => {
  const id = Number(req.params.id);
  const c = getParty(id);
  if (!c) return res.status(404).send(errorPage({ code: 404, title: "클라이언트를 찾을 수 없습니다", message: "삭제되었거나 주소가 잘못되었습니다.", user: req.user }));
  const isFetch = req.get("X-Requested-With") === "fetch"; // 자동저장(AJAX)
  const b = req.body;
  const name = String(b.name || "").trim();
  if (!name) {
    if (isFetch) return res.status(400).json({ ok: false, error: "이름을 입력하세요." });
    const files = listClientFiles(id);
    return res.send(layout({ title: "클라이언트 수정", user: req.user, current: "/clients", body: clientForm({ ...c, ...b, _err: "이름을 입력하세요." }, true, files, "", true, listContacts({}), listClients({}).filter((x) => x.kind === "company"), false, true, listGroupsForPicker()) }));
  }
  // kind는 party 정체성이라 불변 — 폼 유형 고정, 현재 party.kind 기준으로 필드 갱신(updateParty가 분기).
  updateParty(id, {
    name, phone: b.phone, email: b.email, memo: b.memo,
    // company 필드
    biz_no: formatBizNo(b.biz_no), owner_name: b.owner_name,
    owner_party_id: String(b.owner_name || "").trim() ? resolvePersonByName(b.owner_name) : (c.owner_party_id || null),
    address: b.address, roles: c.kind === "company" ? companyRolesFrom(b) : null,
    // person 필드(활동명·is_artist는 보존, 현금영수증만 갱신)
    activity_name: c.activity_name, is_artist: c.is_artist,
    cash_receipt_no: b.cash_receipt_no,
  });
  if (b.group_id !== undefined) setPartyGroup(id, b.group_id); // 개인 아티스트의 소속 그룹 연결
  if (c.kind !== "company" && b.agency_id !== undefined) setPartyAgency(id, b.agency_id); // 아티스트·그룹 소속사 지정/해제('없음'=빈값)
  if (c.kind === "company") linkClientContact(id, b); // 업체만 담당자 연락처 연동
  if (isFetch) return res.json({ ok: true }); // 자동저장 — 페이지 유지
  res.redirect(`/clients/${id}?flash=saved`); // 수동 저장(noscript): 상세로 복귀
});

// ── 삭제(강제: 연결된 프로젝트·청구서·사용자의 client_id는 SET NULL으로 자동 해제) ──
// 단, 발행/입금완료 인보이스가 있으면 청구처 보존을 위해 삭제 거부
router.post("/:id/delete", (req, res) => {
  const id = Number(req.params.id);
  const active = db().prepare("SELECT 1 FROM invoices WHERE payer_id=? AND (status='발행' OR tax_status IN ('계산서 발행','입금완료')) LIMIT 1").get(id); // 청구서 발행 또는 계산서·입금 진행분이면 청구처 보존
  if (active) return res.status(409).send(errorPage({ code: 409, title: "청구처로 발행된 청구가 있어 삭제할 수 없습니다", message: "발행·입금완료된 청구의 청구처입니다. 관련 청구를 먼저 정리하세요(매출 추적 보존).", user: req.user }));
  deleteParty(id); // 하드 삭제(파티) — 역할 참조 정리·첨부 CASCADE
  res.redirect("/clients?flash=deleted");
});

// ── 그룹 멤버 연결/해제(그룹 아티스트 ↔ 개인 아티스트) ──
router.post("/:id/members", (req, res) => {
  const id = Number(req.params.id);
  const g = getParty(id);
  if (!g || g.kind !== "group") return res.status(404).send(errorPage({ code: 404, title: "그룹을 찾을 수 없습니다", message: "그룹 아티스트만 멤버를 가질 수 있습니다.", user: req.user }));
  const memberId = Number(req.body.member_id);
  if (memberId) setPartyGroup(memberId, id); // 개인 아티스트를 이 그룹 소속으로(다른 그룹이면 이동)
  res.redirect(`/clients/${id}`);
});
router.post("/:id/members/:mid/remove", (req, res) => {
  const id = Number(req.params.id);
  const mid = Number(req.params.mid);
  const m = getParty(mid);
  if (m && Number(m.group_id) === id) setPartyGroup(mid, null); // 이 그룹 소속일 때만 해제
  res.redirect(`/clients/${id}`);
});

// ── 첨부 서류 업로드(치프·스태프 — requireEditor) ──
// 보안: 디스크 multer + 매직바이트 검증(PNG·JPEG·PDF) + 인증 다운로드만(공개 링크 없음).
router.post("/:id/files/:kind", requireEditor, upload.single("file"), asyncHandler(async (req, res) => {
  const id = Number(req.params.id);
  const kind = req.params.kind;
  const c = getParty(id);
  if (!c) {
    if (req.file) fs.promises.unlink(req.file.path).catch(() => {});
    return res.status(404).send(errorPage({ code: 404, title: "클라이언트를 찾을 수 없습니다", message: "", user: req.user }));
  }
  if (!FILE_KINDS.find((k) => k.key === kind)) {
    if (req.file) fs.promises.unlink(req.file.path).catch(() => {});
    return res.redirect(`/clients/${id}?ferr=${encodeURIComponent("알 수 없는 서류 종류입니다.")}`);
  }
  if (!req.file) {
    return res.redirect(`/clients/${id}?ferr=${encodeURIComponent("파일을 선택하세요.")}`);
  }

  // 매직바이트 검증: Content-Type 헤더를 신뢰하지 않고 파일 첫 바이트로 직접 확인
  const detectedMime = detectMimeFromFile(req.file.path);
  if (!detectedMime) {
    fs.promises.unlink(req.file.path).catch(() => {});
    return res.redirect(`/clients/${id}?ferr=${encodeURIComponent("PNG, JPG, PDF 파일만 업로드할 수 있습니다.")}`);
  }

  const originalName = decodeName(req.file.originalname);
  try {
    const { backend, fileId } = await storage.put({ filePath: req.file.path, name: originalName, mimeType: detectedMime, folder: fileKindLabel(kind) }); // 사업자등록증·통장사본 하위 폴더로
    // 기존 같은 kind 파일을 교체하는 경우 이전 파일 스토리지 정리
    const old = upsertClientFile(id, kind, { storage_backend: backend, file_id: fileId, file_name: originalName, mime_type: detectedMime, file_size: req.file.size });
    if (old) await storage.remove(old.storage_backend, old.file_id);
    res.redirect(`/clients/${id}?flash=saved`);
  } catch (e) {
    console.error("[client file upload]", e);
    res.redirect(`/clients/${id}?ferr=${encodeURIComponent("업로드에 실패했습니다.")}`);
  } finally {
    if (req.file) fs.promises.unlink(req.file.path).catch(() => {});
  }
}));

// ── 첨부 서류 인증 다운로드(치프·스태프 인증 후 프록시 — 공개 URL 없음) ──
router.get("/:id/files/:kind/raw", requireEditor, asyncHandler(async (req, res) => {
  const id = Number(req.params.id);
  const kind = req.params.kind;
  if (!FILE_KINDS.find((k) => k.key === kind)) return res.status(404).send("파일을 찾을 수 없습니다.");
  const cf = getClientFile(id, kind);
  if (!cf) return res.status(404).send(errorPage({ code: 404, title: "파일이 없습니다", message: "아직 업로드된 파일이 없습니다.", user: req.user }));
  res.setHeader("Cache-Control", "private, no-store");
  res.setHeader("Content-Type", cf.mime_type || "application/octet-stream");
  // inline: 이미지·PDF를 브라우저에서 직접 표시(다운로드 강제 없음)
  res.setHeader("Content-Disposition", `inline; filename*=UTF-8''${encodeURIComponent(cf.file_name)}`);
  if (cf.file_size > 0) res.setHeader("Content-Length", cf.file_size);
  try {
    await storage.stream(cf.storage_backend, cf.file_id, res);
  } catch (e) {
    console.error("[client file stream]", e);
    if (!res.headersSent) res.status(502).send("파일을 가져오지 못했습니다.");
    else res.destroy();
  }
}));

// ── 첨부 서류 삭제 ──
router.post("/:id/files/:kind/delete", requireEditor, asyncHandler(async (req, res) => {
  const id = Number(req.params.id);
  const kind = req.params.kind;
  if (!FILE_KINDS.find((k) => k.key === kind)) return res.redirect(`/clients/${id}`);
  const old = deleteClientFile(id, kind);
  if (old) await storage.remove(old.storage_backend, old.file_id);
  res.redirect(`/clients/${id}?flash=deleted`);
}));

// ── 클라이언트 상세(프로젝트 + 청구·결제 히스토리 + 첨부 서류 링크) ──
router.get("/:id", (req, res) => {
  const c = getParty(Number(req.params.id));
  if (!c) return res.status(404).send(errorPage({ code: 404, title: "클라이언트를 찾을 수 없습니다", message: "삭제되었거나 주소가 잘못되었습니다.", user: req.user }));
  const tab = req.query.tab === "invoices" ? "invoices" : "projects";
  const projects = listProjectsForParty(c);
  const invoices = listInvoicesForParty(c);
  const files = listClientFiles(c.id);
  // 목록에서 넘어왔으면 그 필터로 복귀(?from=쿼리스트링, 안전문자만 허용).
  const from = String(req.query.from || "");
  const clientsBackHref = from && /^[\w=&%.\-]*$/.test(from) ? `/clients?${from}` : "/clients";
  const tabBarHtml = tabBar({
    tabs: [{ key: "projects", label: `프로젝트 ${projects.length}` }, { key: "invoices", label: `청구·결제 ${invoices.length}` }],
    activeKey: tab,
    hrefFn: (key) => `/clients/${c.id}?tab=${key}`,
  });

  let content;
  if (tab === "invoices") {
    if (invoices.length) {
      const total = invoices.reduce((s, i) => s + (i.amount || 0), 0);
      const paid = invoices.reduce((s, i) => s + (i.paid_amount || 0), 0);
      const due = total - paid;
      content = `<div class="card mb-3 flex flex-wrap gap-4 text-sm">
          <span>청구 합계 <b class="text-fg tabular">${formatKRW(total)}</b></span>
          <span>입금 <b class="text-success tabular">${formatKRW(paid)}</b></span>
          <span>미수 <b class="${due > 0 ? "text-danger" : "text-fg"} tabular">${formatKRW(due)}</b></span>
        </div>
        <div class="space-y-2">${invoices.map((i) => invoiceRow(i, { compact: true })).join("")}</div>`;
    } else {
      content = emptyState("이 클라이언트가 청구처인 청구 내역이 없습니다.", { card: true });
    }
  } else {
    content = projects.length
      ? `<div class="space-y-2">${projects.map((p) => clientProjectCard(p)).join("")}</div>`
      : emptyState("연결된 프로젝트가 없습니다.", { card: true });
  }

  // 그룹(group): 소속 멤버(개인 아티스트) 목록 + 추가/제거.
  const members = c.kind === "group" ? listGroupMembers(c.id) : [];
  const memberCandidates = c.kind === "group" ? artistPersonOptions().filter((a) => Number(a.group_id) !== c.id) : [];
  const memberSection = c.kind === "group"
    ? `<div class="mb-6">
        <h3 class="mb-2 font-display text-lg font-semibold text-fg">멤버 <span class="text-sm font-normal text-muted">· 그룹 소속 아티스트</span></h3>
        ${members.length
          ? listGroup({ rows: members.map((m) => listRow({
              left: `<a href="/clients/${m.id}" class="font-medium text-fg hover:text-primary hover:underline">${esc(m.display_name)}</a>`,
              right: `<form method="post" action="/clients/${c.id}/members/${m.id}/remove"><button class="btn-ghost btn-sm text-danger" type="submit">제거</button></form>`,
            })) })
          : emptyState("아직 등록된 멤버가 없습니다.", { card: true })}
        <form method="post" action="/clients/${c.id}/members" class="card mt-2 flex items-end gap-2">
          <div class="min-w-0 flex-1">
            <label class="label">멤버 추가 <span class="font-normal text-muted text-xs">(개인 아티스트를 이 그룹에 연결)</span></label>
            <select name="member_id" class="input" required>
              <option value="">— 아티스트 선택 —</option>
              ${memberCandidates.map((a) => `<option value="${a.id}">${esc(a.name)}${a.group_id ? " (다른 그룹 소속 → 이동)" : ""}</option>`).join("")}
            </select>
          </div>
          <button class="btn-primary shrink-0" type="submit">추가</button>
        </form>
        <p class="mt-1 text-xs text-muted">새 아티스트는 클라이언트 목록에서 먼저 등록한 뒤 여기서 연결하세요.</p>
      </div>`
    : "";

  // 업체(company): 소속 아티스트 목록(affiliations 기반). 아티스트: 소속 업체 링크는 소속 이력에서.
  const roster = c.kind === "company" ? listArtistsForAgency(c.id) : [];
  const rosterSection = c.kind === "company" && roster.length
    ? `<div class="mb-4">
        <h3 class="mb-2 text-sm font-medium text-muted">소속 아티스트</h3>
        ${listGroup({ rows: roster.map((a) => listRow({ href: `/clients/${a.id}`, left: `<span class="font-medium">${esc(a.name)}</span>` })) })}
      </div>`
    : "";
  const agencyLink = "";

  // 상세로 들어오면 바로 편집 — '정보 수정' 버튼 폐기, 인라인 편집 폼(dirty 저장). 첨부·삭제는 분리 배치.
  const companies = listClients({}).filter((x) => x.kind === "company");
  if (c.kind !== "company") c.agency_id = currentAgencyId(c.id); // 아티스트·그룹: 소속사 select 기본값
  const fileErr = String(req.query.ferr || "").trim(); // 첨부 업로드 오류(파일 라우트가 ?ferr= 로 복귀)
  // 폼의 대표자/담당자 datalist는 전체 연락처가 필요(상세의 contacts는 이 클라이언트 소속만이라 별도).
  const editCard = clientForm(c, true, files, fileErr, true, listContacts({}), companies, true, false, listGroupsForPicker()); // withExtras=false — 첨부·삭제 제외
  const crossRefs = [
    // 아티스트(사람) party는 연락처와 동일 레코드 — '연락처로 보기' 링크(같은 party를 연락처 화면에서).
    c.kind === "person" ? `<div><span class="text-muted">연락처로 보기</span> <a href="/contacts/${c.id}" class="text-primary hover:underline">${esc(c.name)} ↗</a></div>` : "",
    (() => { const g = c.kind === "person" && c.is_artist ? groupOfParty(c.id) : null; return g ? `<div><span class="text-muted">소속 그룹</span> <a href="/clients/${g.id}" class="text-primary hover:underline">${esc(g.activity_name || g.name)} ↗</a></div>` : ""; })(),
    (() => { const oc = c.owner_party_id ? getParty(c.owner_party_id) : null; return oc ? `<div><span class="text-muted">대표자 연락처</span> <a href="/contacts/${oc.id}" class="text-primary hover:underline">${esc(c.owner_name || oc.name)} ↗</a></div>` : ""; })(),
  ].filter(Boolean).join("");
  const crossRefBlock = crossRefs ? `<div class="mt-3 space-y-1 text-sm">${crossRefs}</div>` : "";
  const filesBlock = clientFilesBlock(c, files, fileErr); // 자체 '첨부 서류' 헤딩 포함
  const deleteForm = `
    <form method="post" action="/clients/${c.id}/delete" data-confirm="${esc(c.name || "이 클라이언트")}를 삭제할까요? 연결된 프로젝트·청구서에서는 자동으로 '미지정' 처리됩니다." class="mt-4">
      <button class="btn-ghost text-danger btn-sm" type="submit">클라이언트 삭제</button>
    </form>`;

  // 섹션 순서(사용자 지정): ① 프로젝트/청구·결제 → ② 상세 정보(편집 폼) → ③ 담당자 연락처 → ④ 첨부 서류 → 삭제
  const body = `
    ${flashBanner(req.query)}
    ${pageHeader({ title: c.is_artist ? personLabel(c.activity_name || c.name, c.name) : c.name, desc: c.is_artist ? (c.kind === "group" ? "그룹 아티스트" : "아티스트") : "업체", back: { href: clientsBackHref, label: "클라이언트" } })}
    ${tabBarHtml}
    ${content}
    ${memberSection}
    <h3 class="mb-2 mt-6 font-display text-lg font-semibold text-fg">상세 정보</h3>
    ${editCard}
    <div class="mt-3">${filesBlock}</div>
    ${crossRefBlock}
    ${agencyLink ? `<div class="mt-3">${agencyLink}</div>` : ""}
    ${rosterSection}
    ${deleteForm}`;
  res.send(layout({ title: c.name, user: req.user, current: "/clients", body }));
});

// ── 헬퍼 함수 ──

/** 클라이언트 상세용 프로젝트 카드(제목·유형·메타 → 프로젝트 상세 링크). */
function clientProjectCard(p) {
  const meta = [p.artist, p.artist_company, p.production_company].filter(Boolean).join(" · ");
  return `<a href="/projects/${p.id}" class="card flex items-center justify-between gap-3 hover:opacity-80">
    <div class="min-w-0">
      <div class="flex items-center gap-2"><span class="truncate font-semibold">${esc(p.title)}</span>${projectTypeBadge(p.project_type)}</div>
      ${meta ? `<div class="mt-0.5 truncate text-xs text-muted">${esc(meta)}</div>` : ""}
    </div>
    <span class="shrink-0 text-xs text-muted">열기 ›</span>
  </a>`;
}

/** 첨부 서류 업로드·교체 UI 섹션(isEdit=true일 때만 렌더). */
function clientFileSection(c, fileMap, fileErr) {
  const rows = FILE_KINDS.map(({ key, label }) => {
    const existing = fileMap[key];
    const existingRow = existing
      ? `<div class="mb-2 flex items-center gap-3 text-sm">
            <a href="/clients/${c.id}/files/${key}/raw" target="_blank" rel="noopener" class="font-medium text-primary hover:underline">${esc(label)} 보기</a>
            <span class="max-w-[12rem] truncate text-xs text-muted">${esc(existing.file_name)}</span>
            <form method="post" action="/clients/${c.id}/files/${key}/delete" class="inline" data-confirm="${esc(label)}을 삭제할까요?">
              <button class="text-xs text-danger hover:underline" type="submit">삭제</button>
            </form>
          </div>`
      : "";
    return `
    <div>
      <label class="label">${esc(label)}</label>
      ${existingRow}
      <form enctype="multipart/form-data" method="post" action="/clients/${c.id}/files/${key}" class="flex items-center gap-2">
        <div class="flex-1" data-dropzone>
          <input type="file" name="file" accept="image/png,image/jpeg,application/pdf" class="sr-only" />
          <div class="input flex cursor-pointer select-none items-center py-2 text-sm text-muted" data-dropzone-display>
            <span data-dropzone-label>${existing ? "다른 파일로 교체" : "파일 끌어놓기 또는 클릭"}</span>
          </div>
        </div>
        <button class="btn-ghost shrink-0" type="submit">업로드</button>
      </form>
    </div>`;
  }).join("");

  return `
  <section class="card mt-3 space-y-4">
    <div>
      <h2 class="font-semibold">첨부 서류</h2>
      ${explain(`PNG · JPG · PDF · 최대 10MB. 직원 인증 열람(공개 링크 없음).`)}
    </div>
    ${fileErr ? `<p class="rounded-lg bg-danger/10 px-3 py-2 text-sm text-danger">${esc(fileErr)}</p>` : ""}
    ${rows}
  </section>`;
}

/** 클라이언트 담당자 연락처 콤보 — 이름 선택/입력 시 연락처에 연동(이 클라이언트 소속으로). 프로젝트 contactCombo와 동일 패턴(app.js 처리). */
function clientContactCombo(c, isEdit) {
  const opts = contactOptions();
  const cur = isEdit && c.id ? (listPersonsForOrg(c.id)[0] || null) : null;
  // 현재 담당자의 전화·소속을 서버에서 미리 채워 로드 즉시 표시(이름 뒤에 번호). app.js가 변경 시 갱신.
  const curInfo = cur
    ? [cur.phone ? `☎ ${esc(cur.phone)}` : "", `소속: ${esc(c.name)}`].filter(Boolean).join(" · ")
    : "";
  return `
    <div>
      <label class="label">담당자 연락처 <span class="font-normal text-muted text-xs">(이 클라이언트 담당자 — 연락처에 연동)</span></label>
      <div data-contact-combo>
        <input type="hidden" name="contact_id" value="${cur ? cur.id : ""}" data-contact-id />
        <input class="input" type="text" name="contact_name" list="dl-client-contacts" data-contact-search autocomplete="off"
          placeholder="이름 입력 — 목록에서 선택하거나 새 이름" value="${cur ? esc(cur.name) : ""}" aria-label="담당자 검색" />
        <datalist id="dl-client-contacts">
          ${opts.map((o) => `<option value="${esc(o.name)}" data-id="${o.id}" data-phone="${esc(o.phone || "")}" data-email="${esc(o.email || "")}" data-client="${esc(o.current_client || "")}"></option>`).join("")}
        </datalist>
        <div class="mt-1 text-sm text-muted${curInfo ? "" : " hidden"}" data-contact-info>${curInfo}</div>
        ${explain(`목록에 없는 이름을 입력하면 새 연락처로 등록되고 이 클라이언트 담당자로 연결됩니다.`)}
      </div>
    </div>`;
}

/** 클라이언트 담당자(연락처) 연동: 선택/입력된 담당자를 이 클라이언트 소속으로 연결(이미 현 소속이면 생략). */
function linkClientContact(clientId, body) {
  let contactId = body.contact_id ? Number(body.contact_id) : null;
  if (!contactId) {
    const name = String(body.contact_name || "").trim();
    if (!name) return;
    contactId = resolvePersonByName(name); // 이름으로 기존 연락처 재사용 후 없으면 생성 — 자동저장 blur마다 중복 생성되던 것 방지
  }
  if (!contactId) return;
  // 당사자 모델: 소속 이력은 affiliations(person_id, org_id). 중복(현재 소속 동일 조직)만 건너뛴다.
  const already = db()
    .prepare("SELECT 1 FROM affiliations WHERE person_id = ? AND org_id = ? AND ended_on IS NULL LIMIT 1")
    .get(contactId, Number(clientId));
  if (!already) addAffiliation(contactId, { client_id: Number(clientId), closeCurrent: false }); // 다른 소속을 끊지 않고 이 클라이언트 담당으로 추가(compat: client_id→org_id)
}

function clientForm(c = {}, isEdit = false, files = [], fileErr = "", canFiles = false, contacts = [], companies = [], embedded = false, withExtras = true, groups = [], formType = null) {
  const e = c._err || "";
  const action = isEdit ? `/clients/${c.id}` : "/clients";
  // 유형: 편집=party.kind 매핑, 생성=formType 인자(company/artist/group). 서로 섞이지 않는 3개념 — '기타' 없음.
  const type = formType || (c.kind === "company" ? "company" : c.kind === "group" ? "group" : "artist");
  const typeLabel = type === "company" ? "업체" : type === "group" ? "그룹" : "아티스트";
  const nameLabel = type === "company" ? "상호(업체명)" : type === "group" ? "그룹명" : "이름 · 활동명";
  const desc = type === "company" ? "업체 · 소속사/레이블 · 제작사/운영사" : type === "group" ? "그룹 · 밴드·아이돌 그룹" : "아티스트 · 개인(솔로)";
  const fileMap = {};
  files.forEach((f) => { fileMap[f.kind] = f; });

  // embedded=상세 페이지에 인라인으로 넣을 때 — 폼 자체 pageHeader 생략(상단 이름 헤더가 이미 있음).
  return `
    ${embedded ? "" : pageHeader({ title: isEdit ? "클라이언트 수정" : `새 ${typeLabel}`, desc, back: isEdit && c.id ? { href: `/clients/${c.id}`, label: "클라이언트 상세" } : { href: "/clients/new", label: "유형 선택" } })}
    <form method="post" action="${action}" class="card space-y-4"${isEdit ? " data-dirty-form" : ""}>
      ${e ? `<p class="rounded-lg bg-danger/10 px-3 py-2 text-sm text-danger">${esc(e)}</p>` : ""}
      <input type="hidden" name="type" value="${type}" />
      <div class="flex items-center gap-2"><span class="badge ${type === "company" ? "badge-neutral" : "badge-info"}">${typeLabel}</span>${isEdit ? `<span class="text-xs text-muted">유형은 변경할 수 없습니다</span>` : ""}</div>
      <div><label class="label">${nameLabel}</label><input class="input" name="name" value="${esc(c.name || "")}" required /></div>
      ${type === "company" ? `
      <div class="space-y-4">
        <div>
          <label class="label">역할 <span class="font-normal text-muted text-xs">(겸업 가능 — 복수 선택)</span></label>
          <div class="flex flex-wrap gap-4">
            ${COMPANY_ROLES.map((r) => `<label class="flex items-center gap-1.5 text-sm"><input type="checkbox" name="roles" value="${esc(r)}" ${clientRoleList(c).includes(r) ? "checked" : ""} /> ${esc(companyRoleLabel(r))}</label>`).join("")}
          </div>
        </div>
        <div class="grid gap-3 sm:grid-cols-2">
          <div><label class="label">사업자등록번호</label><input class="input" name="biz_no" value="${esc(c.biz_no || "")}" placeholder="000-00-00000" /></div>
          <div><label class="label">대표자 <span class="font-normal text-muted text-xs">(연락처 연동)</span></label>
            <input class="input" name="owner_name" value="${esc(c.owner_name || "")}" list="client-owner-contacts" autocomplete="off" placeholder="이름 — 목록에서 선택하거나 새 이름" />
            <datalist id="client-owner-contacts">${contacts.map((ct) => `<option value="${esc(ct.name)}"></option>`).join("")}</datalist>
          </div>
        </div>
        <div><label class="label">사업장 주소</label><input class="input" name="address" value="${esc(c.address || "")}" /></div>
      </div>` : ""}
      ${type !== "company" ? `
      <div>
        <label class="label">현금영수증 정보 <span class="font-normal text-muted text-xs">(사업자등록증 없는 경우)</span></label>
        <input class="input" name="cash_receipt_no" value="${esc(c.cash_receipt_no || "")}" placeholder="휴대폰 번호(010-0000-0000) 또는 현금영수증 카드번호" />
      </div>
      <div>
        <label class="label">소속사 <span class="font-normal text-muted text-xs">(소속 회사 · 없으면 '없음')</span></label>
        <select name="agency_id" class="input">
          <option value="">없음</option>
          ${companies.map((co) => `<option value="${co.id}"${Number(c.agency_id) === co.id ? " selected" : ""}>${esc(co.name)}</option>`).join("")}
        </select>
      </div>` : ""}
      ${type === "artist" ? `
      <div>
        <label class="label">소속 그룹 <span class="font-normal text-muted text-xs">(밴드·아이돌 그룹 멤버일 때)</span></label>
        <select name="group_id" class="input">
          <option value="">— 소속 그룹 없음 —</option>
          ${groups.map((g) => `<option value="${g.id}"${Number(c.group_id) === g.id ? " selected" : ""}>${esc(g.name)}</option>`).join("")}
        </select>
      </div>` : ""}
      ${type === "group" && isEdit ? `<p class="text-xs text-muted">멤버는 아래 <span class="text-fg">멤버</span> 섹션에서 연결·관리합니다.</p>` : ""}
      <div class="grid gap-3 sm:grid-cols-2">
        <div><label class="label">${type === "company" ? "세금계산서 발행 이메일" : "이메일"}</label><input class="input" type="email" name="email" value="${esc(c.email || "")}" placeholder="${type === "company" ? "계산서 받을 이메일" : ""}" /></div>
        <div><label class="label">전화</label><input class="input" name="phone" autocomplete="off" value="${esc(c.phone || "")}" /></div>
      </div>
      ${type === "company" ? clientContactCombo(c, isEdit) : ""}
      <div><label class="label">메모</label><textarea class="input" name="memo" rows="2">${esc(c.memo || "")}</textarea></div>
      <div class="flex items-center gap-2">
        ${isEdit
          ? `<button class="btn-primary transition" type="submit" data-dirty-save>저장</button><a href="/clients/${c.id}" class="btn-ghost">← 돌아가기</a><span class="ml-1 text-xs text-warning" data-dirty-hint hidden>저장되지 않은 변경사항</span>`
          : `<button class="btn-primary" type="submit">추가</button><a href="/clients/new" class="btn-ghost">취소</a>`}
      </div>
    </form>
    ${withExtras && isEdit && canFiles && type === "company" ? `<div>${clientFileSection(c, fileMap, fileErr)}</div>` : ""}
    ${withExtras && isEdit ? `
    <form method="post" action="/clients/${c.id}/delete" data-confirm="${esc(c.name || "이 클라이언트")}를 삭제할까요? 연결된 프로젝트·청구서에서는 자동으로 '미지정' 처리됩니다." class="mt-3">
      <button class="btn-ghost text-danger" type="submit">클라이언트 삭제</button>
    </form>` : ""}`;
}

/** 첨부 서류 카드(상세에서 분리 배치용). 업체(company)만 표시(아티스트·그룹은 첨부 없음). */
function clientFilesBlock(c, files, fileErr) {
  if (c.kind !== "company") return "";
  const fileMap = {};
  files.forEach((f) => { fileMap[f.kind] = f; });
  return `<div>${clientFileSection(c, fileMap, fileErr)}</div>`;
}

module.exports = router;
