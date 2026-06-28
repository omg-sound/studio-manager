"use strict";

const express = require("express");
const { db } = require("../db");
const { requireAuth, requireEditor, requireInvoice } = require("../auth");
const {
  getProjectForUser,
  createTrack,
  createTask,
  listUnbilledTasksForProject,
  createInvoiceFromTasks,
} = require("../data");
const { cleanYmd } = require("../lib/forms");

const router = express.Router();

router.post("/api/projects", requireEditor, (req, res) => {
  const title = String(req.body.project_name || req.body.title || "").trim();
  if (!title) return res.status(400).json({ error: "project_name_required" });
  const info = db()
    .prepare(
      `INSERT INTO projects (title, client_id, status, memo)
       VALUES (@title, @client_id, @status, @memo)`
    )
    .run({
      title,
      client_id: req.body.client_id ? Number(req.body.client_id) : null,
      status: String(req.body.status || "Proposal").trim() || "Proposal",
      memo: String(req.body.memo || "").trim() || null,
    });
  const project = getProjectForUser(req.user, info.lastInsertRowid);
  res.status(201).json({ project });
});

router.post("/api/projects/:id/tracks", requireEditor, (req, res) => {
  try {
    const track = createTrack(req.user, Number(req.params.id), req.body);
    if (!track) return res.status(404).json({ error: "project_not_found" });
    res.status(201).json({ track });
  } catch (e) {
    if (e.message === "TRACK_TITLE_REQUIRED") return res.status(400).json({ error: "track_title_required" });
    throw e;
  }
});

router.post("/api/tracks/:id/tasks", requireEditor, (req, res) => {
  const task = createTask(req.user, Number(req.params.id), req.body);
  if (!task) return res.status(404).json({ error: "track_not_found" });
  res.status(201).json({ task });
});

router.get("/api/projects/:id/unbilled-tasks", requireAuth, (req, res) => {
  const bundle = listUnbilledTasksForProject(req.user, Number(req.params.id));
  if (!bundle) return res.status(404).json({ error: "project_not_found" });
  res.json({ project: bundle.project, tasks: bundle.rows });
});

router.post("/api/invoices", requireInvoice, (req, res) => {
  try {
    const inv = createInvoiceFromTasks(req.user, {
      projectId: Number(req.body.project_id),
      taskIds: Array.isArray(req.body.task_ids) ? req.body.task_ids : [req.body.task_id].filter(Boolean),
      title: req.body.title,
      issueDate: cleanYmd(req.body.issue_date || req.body.issued_date),
      dueDate: cleanYmd(req.body.due_date),
    });
    if (!inv) return res.status(404).json({ error: "project_not_found" });
    res.status(201).json({ invoice: inv });
  } catch (e) {
    if (e.message === "TASK_IDS_REQUIRED") return res.status(400).json({ error: "task_ids_required" });
    if (e.message === "TASK_NOT_BILLABLE") return res.status(409).json({ error: "task_not_billable" });
    throw e;
  }
});

module.exports = router;
