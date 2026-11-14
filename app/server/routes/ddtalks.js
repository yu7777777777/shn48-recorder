"use strict";

const express = require("express");
const router = express.Router();
const ddtalks = require("../modules/ddtalks/recorder");

// Start DDTalks meeting recording
router.post("/start", async (req, res) => {
  try {
    const { meetingUrl, meetingName, userName, durationMinutes } = req.body;
    if (!meetingUrl) return res.status(400).json({ error: "meetingUrl is required" });

    const result = await ddtalks.startRecording({ meetingUrl, meetingName, userName, durationMinutes });
    res.json({ success: true, data: result });
  } catch (err) {
    console.error("[ddtalks] start error:", err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

// Stop an active recording
router.post("/stop", async (req, res) => {
  try {
    const { sessionId } = req.body;
    if (!sessionId) return res.status(400).json({ error: "sessionId is required" });

    const result = await ddtalks.stopRecording(sessionId);
    res.json({ success: true, data: result });
  } catch (err) {
    console.error("[ddtalks] stop error:", err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

// Get session status
router.get("/session/:sessionId", (req, res) => {
  try {
    const info = ddtalks.getSession(req.params.sessionId);
    if (!info) return res.status(404).json({ error: "Session not found" });
    res.json({ success: true, data: info });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// List all sessions
router.get("/sessions", (req, res) => {
  try {
    const list = ddtalks.listSessions();
    res.json({ success: true, data: list });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

module.exports = router;
