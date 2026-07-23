"use strict";

const express = require("express");
const { requireEditor } = require("../auth");
const {
  listEquipment, getEquipment, createEquipment, updateEquipment, deleteEquipment,
  equipmentLocationSuggestions, equipmentCategorySuggestions, listRooms,
} = require("../data");
const { layout, pageHeader, errorPage } = require("../views");
const { equipmentList, equipmentForm } = require("../views.equipment");
const { logAudit } = require("../lib/audit");

const router = express.Router();
router.use(requireEditor); // 전 라우트 = 대표·치프·스태프

function formOpts() {
  return { rooms: listRooms(), categories: equipmentCategorySuggestions(), locations: equipmentLocationSuggestions() };
}

// 목록
router.get("/", (req, res) => {
  const q = String(req.query.q || "").trim();
  const rows = listEquipment({ q });
  const body = `${pageHeader({ title: "장비", desc: "스튜디오 보유 장비 대장", action: `<a href="/equipment/new" class="btn-primary btn-sm">+ 새 장비</a>` })}
    ${equipmentList(rows, { q })}`;
  res.send(layout({ title: "장비", user: req.user, current: "equipment", body, wide: true }));
});

// 추가 폼
router.get("/new", (req, res) => {
  const body = `${pageHeader({ title: "새 장비", back: "/equipment" })}<div class="card">${equipmentForm(null, formOpts())}</div>`;
  res.send(layout({ title: "새 장비", user: req.user, current: "equipment", body }));
});

// 생성
router.post("/", (req, res) => {
  try {
    createEquipment(req.body);
  } catch (e) {
    if (e.message === "EQUIPMENT_NAME_REQUIRED") return res.status(400).send(errorPage({ code: 400, title: "장비명이 필요합니다", message: "장비명을 입력하세요.", user: req.user }));
    throw e;
  }
  res.redirect("/equipment?flash=created");
});

// 편집 폼
router.get("/:id/edit", (req, res) => {
  const item = getEquipment(Number(req.params.id));
  if (!item) return res.status(404).send(errorPage({ code: 404, title: "장비를 찾을 수 없습니다", message: "삭제되었거나 주소가 잘못되었습니다.", user: req.user }));
  const body = `${pageHeader({ title: item.name, back: "/equipment" })}<div class="card">${equipmentForm(item, formOpts())}</div>`;
  res.send(layout({ title: item.name, user: req.user, current: "equipment", body }));
});

// 수정
router.post("/:id", (req, res) => {
  const item = getEquipment(Number(req.params.id));
  if (!item) return res.status(404).send(errorPage({ code: 404, title: "장비를 찾을 수 없습니다", message: "삭제되었거나 주소가 잘못되었습니다.", user: req.user }));
  try {
    updateEquipment(item.id, req.body);
  } catch (e) {
    if (e.message === "EQUIPMENT_NAME_REQUIRED") return res.status(400).send(errorPage({ code: 400, title: "장비명이 필요합니다", message: "장비명을 입력하세요.", user: req.user }));
    throw e;
  }
  res.redirect("/equipment?flash=saved");
});

// 삭제(하드) — 감사 로그
router.post("/:id/delete", (req, res) => {
  const item = getEquipment(Number(req.params.id));
  if (item) {
    deleteEquipment(item.id);
    logAudit(req.user, "equipment.delete", `#${item.id} ${item.name || ""}`.trim());
  }
  res.redirect("/equipment?flash=deleted");
});

module.exports = router;
