"use strict";

// Unified CLI runner - spawns processes with a real timeout.
//
// `child_process.spawn` does not accept a `timeout` option (that belongs to
// `exec`/`execFile`); passing one was silently ignored, so a hung ffmpeg or
// cover renderer could block its caller forever. Enforce the deadline with a
// timer and an AbortSignal that actually kills the child.
const { spawn } = require("child_process");

const DEFAULT_TIMEOUT_MS = 60000;

function buildEnv(opts) {
  return { ...process.env, HOME: opts.home || process.env.HOME || "/root" };
}

// Kill the child, and its process group where one exists. A child started
// without `detached` shares our group, so signalling `-pid` would be wrong; fall
// back to signalling the child directly.
function terminate(proc) {
  if (proc.exitCode !== null || proc.signalCode !== null) return;
  try {
    if (process.platform !== "win32" && proc.__dshDetached && proc.pid) {
      process.kill(-proc.pid, "SIGKILL");
    } else {
      proc.kill("SIGKILL");
    }
  } catch {
    try { proc.kill("SIGKILL"); } catch { /* already gone */ }
  }
}

function run(bin, args, opts = {}) {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  return new Promise((resolve, reject) => {
    const proc = spawn(bin, args, { env: buildEnv(opts), stdio: ["ignore", "pipe", "pipe"] });

    let stdout = "", stderr = "", settled = false;
    let timedOut = false;
    let timer = null;

    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      fn(value);
    };

    if (timeoutMs > 0) {
      timer = setTimeout(() => {
        timedOut = true;
        terminate(proc);
      }, timeoutMs);
    }

    proc.stdout.on("data", d => { stdout += d.toString(); });
    proc.stderr.on("data", d => { stderr += d.toString(); });

    proc.on("close", code => {
      if (timedOut) return finish(reject, new Error(`命令执行超时（${timeoutMs}ms）：${bin}`));
      if (code === 0) resolve({ stdout: stdout.trim(), stderr: stderr.trim(), code: 0 });
      else finish(reject, new Error(stderr.trim() || stdout.trim() || `Exit code ${code}`));
    });

    proc.on("error", error => {
      if (timedOut) return finish(reject, new Error(`命令执行超时（${timeoutMs}ms）：${bin}`));
      finish(reject, error);
    });
  });
}

// Long-lived child kept open by the caller. `timeoutMs` still applies; pass 0 to
// disable it for a genuinely unbounded process (a live capture, for example).
//
// The child is started detached so it can lead its own process group; that is
// what lets `terminate` take down helpers it forks as well. Callers that do not
// want their process kept alive after exit should still `unref()` the result.
function spawnProc(bin, args, opts = {}) {
  const timeoutMs = opts.timeoutMs ?? 0;
  const detached = process.platform !== "win32";
  const proc = spawn(bin, args, {
    env: buildEnv(opts),
    stdio: opts.stdio || "pipe",
    detached,
  });
  proc.__dshDetached = detached;

  if (timeoutMs > 0) {
    const timer = setTimeout(() => terminate(proc), timeoutMs);
    proc.once("close", () => clearTimeout(timer));
  }

  return proc;
}

module.exports = { run, spawnProc };
