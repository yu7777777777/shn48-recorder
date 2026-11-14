"use strict";
const { spawn } = require("child_process");
const path = require("path");
const store = require("../../lib/store");
const MESSAGES = {
  unauthorized: "115 登录已失效，请重新扫码授权", quota: "115 空间或账号额度不足，请检查后重试",
  mismatch: "远端文件大小或 SHA1 校验未通过", source_changed: "本地文件已变化，请重新备份当前版本",
  network: "连接115失败，请稍后重试", timeout: "115操作超时，请重试或检查网络",
  unavailable: "115上传环境尚未就绪，请联系管理员", provider_error: "115操作失败，请检查连接后重试",
  account_mismatch: "115账号已更换，请取消旧任务后重新创建", cancelled: "备份任务已取消",
  invalid_path: "备份文件或目标目录不符合安全限制", conflict: "115目标已存在不同内容的同名文件，请更换目录",
};
function failure(code) { return Object.assign(new Error(MESSAGES[code] || MESSAGES.provider_error), { code: MESSAGES[code] ? code : "provider_error" }); }
function stateDir() { return path.resolve(process.env.BACKUP115_DIR || path.join(store.dataDir, "backup115")); }
function invoke(command, input = {}, options = {}) {
  return new Promise((resolve, reject) => {
    if (options.signal?.aborted) return reject(failure("cancelled"));
    const bin = process.env.BACKUP115_PYTHON || (process.platform === "win32" ? "python" : "/opt/backup115/bin/python");
    const env = { ...process.env, BACKUP115_DIR: stateDir(), BACKUP115_REMOTE_ROOT: process.env.BACKUP115_REMOTE_ROOT || options.remoteRoot || "/48tools归档", PYTHONUNBUFFERED: "1", PYTHONIOENCODING: "utf-8" };
    const child = spawn(bin, [path.join(__dirname, "worker.py")], { env, windowsHide: true, stdio: ["pipe", "pipe", "ignore"] });
    let buffer = "", result, problem, settled = false, bytes = 0;
    const timeout = setTimeout(() => { problem = failure("timeout"); child.kill("SIGKILL"); }, options.timeoutMs || (command === "upload" ? 6 * 3600000 : 45000));
    const abort = () => { problem = failure("cancelled"); child.kill("SIGKILL"); };
    options.signal?.addEventListener("abort", abort, { once: true });
    const finish = (error) => {
      if (settled) return; settled = true; clearTimeout(timeout); options.signal?.removeEventListener("abort", abort);
      if (error || problem) reject(problem || error); else if (result === undefined) reject(failure("provider_error")); else resolve(result);
    };
    const line = text => {
      if (!text.trim()) return;
      let item; try { item = JSON.parse(text); } catch { problem = failure("provider_error"); child.kill("SIGKILL"); return; }
      if (item.type === "result") result = item.data;
      else if (item.type === "error") problem = failure(item.code === "runtime_unavailable" ? "unavailable" : String(item.code));
      else if (item.type === "progress") { try { options.onProgress?.({ phase: String(item.phase || "uploading"), bytes: Number(item.bytes) || 0, total: Number(item.total) || 0 }); } catch { problem = failure("provider_error"); child.kill("SIGKILL"); } }
    };
    child.stdout.on("data", chunk => {
      bytes += chunk.length;
      if (bytes > 4000000 || buffer.length > 1000000) { problem = failure("provider_error"); child.kill("SIGKILL"); return; }
      buffer += chunk.toString("utf8"); let i;
      while ((i = buffer.indexOf("\n")) !== -1) { line(buffer.slice(0, i)); buffer = buffer.slice(i + 1); }
    });
    child.on("error", () => finish(failure("unavailable")));
    child.on("close", code => { if (buffer) line(buffer); finish(code && !problem ? failure("provider_error") : null); });
    child.stdin.on("error", () => {});
    child.stdin.end(JSON.stringify({ ...input, command }) + "\n");
  });
}
module.exports = { invoke, stateDir, failure, MESSAGES };
