"use strict";

// Mounted at /api/admin/social by server/index.js, AFTER auth.requireAdmin.
// Do not mount this router publicly. Lookup never reads/writes the account book.
const express = require("express");
const accounts = require("../modules/social/accounts");
const profiles = require("../modules/social/profile-lookup");

function createRouter({ lookup = profiles.lookup } = {}) {
  const router = express.Router();
  router.use((req, res, next) => {
    res.setHeader("Cache-Control", "no-store");
    // Same cross-site brake as the 115 backup routes.
    if (!["GET", "HEAD", "OPTIONS"].includes(req.method) && req.headers.origin) {
      try {
        if (new URL(req.headers.origin).host !== req.headers.host) return res.status(403).json({ success: false, error: "拒绝跨站操作" });
      } catch {
        return res.status(403).json({ success: false, error: "请求来源无效" });
      }
    }
    next();
  });

  const wrap = fn => async (req, res) => {
    try { res.json({ success: true, data: await fn(req) }); }
    catch (error) {
      const status = [400, 404].includes(error?.statusCode) ? error.statusCode : 500;
      if (status >= 500) console.error("[social] operation failed");
      res.status(status).json({ success: false, error: status >= 500 ? "社交账号服务暂不可用" : error.message });
    }
  };
  const repo = () => accounts.repository();

  router.get("/", wrap(() => repo().list()));
  // Share one member's directory with people who have no account of their own.
  // The plaintext code is returned once; only its hash is stored.
  const access = require("../modules/social/access");
  router.get("/access-codes", wrap(() => ({ codes: access.list() })));
  router.post("/access-codes", wrap(req => access.create(req.body?.memberName, { hours: req.body?.hours })));
  router.delete("/access-codes/:id", wrap(req => access.revoke(req.params.id)));
  // POST /api/admin/social/lookup { platform, accountId: ID | known profile URL }
  // Admin only; no persistence. 200 {success:true,data:{accountId,accountName,
  // profileUrl,recognized,message}}. Restricted/missing/timeout/busy => false,
  // empty accountName + safe message; invalid input => 400 {success:false,error}.
  // Transport and service state are injectable via createRouter/createProfileLookup
  // for deterministic tests, never through request fields.
  router.post("/lookup", wrap(req => lookup(req.body)));
  // Profile input reuses strict local parsing; ambiguous/foreign/short URLs fail.
  // Member choices reuse GET /api/admin/pocket48/members (data.list[].memberName).
  router.post("/accounts", wrap(req => repo().create(req.body)));
  router.put("/accounts/:id", wrap(req => repo().update(req.params.id, req.body)));
  router.delete("/accounts/:id", wrap(req => repo().remove(req.params.id)));
  router.post("/import", wrap(req => repo().importMembers(req.body)));
  // Express has already decoded the route parameter exactly once.
  router.put("/members/:name", wrap(req => repo().setLink(req.params.name, req.body)));
  return router;
}

module.exports = createRouter();
module.exports.createRouter = createRouter;
