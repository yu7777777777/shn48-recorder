"use strict";

const fs = require("fs");
const path = require("path");
const yaml = require("js-yaml");

const CONFIG_PATH = process.env.CONFIG_PATH || path.join(process.cwd(), "..", "config", "config.yaml");
const DEFAULT_LIVE_PRIORITY = "direct_first";
const LIVE_PRIORITIES = new Set(["direct_first", "server"]);

function normalizeLivePriority(value) {
  return LIVE_PRIORITIES.has(value) ? value : DEFAULT_LIVE_PRIORITY;
}

function readLivePriority(configPath = CONFIG_PATH) {
  try {
    if (!fs.existsSync(configPath)) return DEFAULT_LIVE_PRIORITY;
    const config = yaml.load(fs.readFileSync(configPath, "utf8")) || {};
    return normalizeLivePriority(config?.playback?.livePriority);
  } catch {
    return DEFAULT_LIVE_PRIORITY;
  }
}

function createHttpPlayback({ liveId, streamUrl, protocol, priority, forceServer = false, streamProxy }) {
  // Validation happens even for direct delivery. It prevents a compromised
  // upstream response from turning the public play endpoint into a URL oracle.
  const validatedUrl = streamProxy._internals.validateUrl(streamUrl).toString();
  if (normalizeLivePriority(priority) === "direct_first" && !forceServer) {
    return {
      liveId: String(liveId),
      protocol,
      playUrl: validatedUrl,
      fallbackAvailable: true,
    };
  }
  const issued = streamProxy.createToken(validatedUrl);
  return {
    liveId: String(liveId),
    protocol,
    playUrl: `/api/public/streams/${issued.token}`,
    expiresAt: new Date(issued.expiresAt).toISOString(),
    fallbackAvailable: false,
  };
}

module.exports = {
  CONFIG_PATH,
  DEFAULT_LIVE_PRIORITY,
  LIVE_PRIORITIES,
  normalizeLivePriority,
  readLivePriority,
  createHttpPlayback,
};
