"use strict";

const express = require("express");
const updateChecker = require("../modules/update-checker");

const router = express.Router();
const wrap = fn => async (req, res) => {
  try { res.json({ success: true, data: await fn(req, res) }); }
  catch (error) { res.status(error.statusCode || 400).json({ success: false, error: error.message }); }
};

router.get("/settings", wrap(() => ({ ...updateChecker.publicSettings(), state: updateChecker.state() })));
router.put("/settings", wrap(req => updateChecker.save(req.body)));
// Manual "check now": runs regardless of the schedule switch, so the user can
// verify the token and repo before enabling periodic checks.
router.post("/check", wrap(() => updateChecker.checkNow()));

module.exports = router;
