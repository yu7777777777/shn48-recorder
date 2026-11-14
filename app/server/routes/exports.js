"use strict";

const express = require("express");
const fs = require("fs");
const path = require("path");
const exports_ = require("../modules/recorder/exports");
const pocketRecorder = require("../modules/pocket48/recorder");

const router = express.Router();

const wrap = fn => async (req, res) => {
  try { res.json({ success: true, data: await fn(req, res) }); }
  catch (error) { res.status(error.statusCode || 400).json({ success: false, error: error.message }); }
};

router.get("/", wrap(() => exports_.list()));
router.post("/", wrap(req => exports_.enqueue(req.body || {})));
router.post("/:id/retry", wrap(req => exports_.retry(req.params.id)));
router.delete("/:id", wrap(req => exports_.remove(req.params.id, { deleteFile: req.query.file === "true" })));

// The encoded file lives next to the archive inside the recordings directory;
// the same containment check as the recording file routes applies.
router.get("/:id/download", (req, res) => {
  try {
    const job = exports_.get(req.params.id);
    if (!job || job.status !== "done" || !job.filePath) return res.status(404).json({ success: false, error: "导出文件不存在" });
    const root = path.resolve(pocketRecorder._internals.recordingsDir());
    const candidate = path.resolve(job.filePath);
    const relative = path.relative(root, candidate);
    if (!relative || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
      return res.status(400).json({ success: false, error: "导出文件位置无效" });
    }
    if (!fs.existsSync(candidate) || !fs.lstatSync(candidate).isFile()) return res.status(404).json({ success: false, error: "导出文件不存在" });
    res.download(candidate, job.fileName || path.basename(candidate));
  } catch (error) {
    res.status(error.statusCode || 500).json({ success: false, error: error.message });
  }
});

module.exports = router;
