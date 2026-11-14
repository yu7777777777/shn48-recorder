"use strict";

const express = require("express");
const notify = require("../modules/notify");

const router = express.Router();
const wrap = fn => async (req, res) => {
  try { res.json({ success: true, data: await fn(req, res) }); }
  catch (error) { res.status(error.statusCode || 400).json({ success: false, error: error.message }); }
};

router.get("/settings", wrap(() => notify.publicSettings()));
router.put("/settings", wrap(req => notify.save(req.body)));
router.get("/log", wrap(() => notify.deliveryLog()));
// Sends one test notification through a saved channel; empty channels are
// rejected with the missing field named.
router.post("/test", wrap(req => notify.test(String(req.body?.channel || ""))));

module.exports = router;
