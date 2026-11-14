"use strict";
const router = require("express").Router();
const crypto = require("crypto");
const { service } = require("../modules/backup115/service");
const owner = req => crypto.createHash("sha256").update(String(req.headers.cookie || "") + ":" + String(req.adminSession?.username || "")).digest("hex");
router.use((req, res, next) => {
  res.setHeader("Cache-Control", "no-store");
  if (!["GET", "HEAD", "OPTIONS"].includes(req.method) && req.headers.origin) {
    try { if (new URL(req.headers.origin).host !== req.headers.host) return res.status(403).json({ success: false, error: "拒绝跨站备份操作" }); }
    catch { return res.status(403).json({ success: false, error: "请求来源无效" }); }
  }
  next();
});
const wrap = fn => async (req, res) => {
  try { res.json({ success: true, data: await fn(req) }); }
  catch (e) { res.status(e.statusCode || 503).json({ success: false, error: e.statusCode ? e.message : "115备份操作暂不可用，请检查运行环境或连接", code: e.code || undefined }); }
};
router.get("/", wrap(() => service().status()));
router.put("/settings", wrap(req => service().saveSettings(req.body)));
router.post("/auth/check", wrap(() => service().check()));
router.post("/auth/qr", wrap(req => service().qrStart(owner(req))));
router.get("/auth/qr/:id", wrap(req => service().qrPoll(req.params.id, owner(req))));
router.post("/auth/logout", wrap(() => service().logout()));
router.post("/jobs", wrap(req => service().enqueue(req.body?.recordingIds)));
router.post("/jobs/:id/retry", wrap(req => service().retry(req.params.id)));
router.post("/jobs/:id/cancel", wrap(req => service().cancel(req.params.id)));
module.exports = router;
