import React, { useCallback, useEffect, useRef, useState } from "react";
import usePolling from "../hooks/usePolling";
import { adminApi, errorMessage, payload } from "../lib/api";
import { useToast } from "./Toast";
import { replayWorking } from "./ReplayRecovery";
import "./Backup115.css";

const BASE = "/backup115";
export const backup115Active = status => ["queued", "hashing", "uploading", "verifying", "retry_wait", "waiting_credentials"].includes(status);
const labels = { queued: "等待备份", hashing: "计算哈希", uploading: "上传中", verifying: "远端核验中", retry_wait: "等待重试", waiting_credentials: "等待115授权", succeeded: "备份完成", partial: "部分失败", failed: "备份失败", cancelled: "已取消", stale_source: "源文件已变化" };
const retryable = status => ["partial", "failed", "cancelled", "stale_source"].includes(status);
const ready = item => ["done", "completed", "archived"].includes(item.status) && !replayWorking(item);
const bytes = value => {
  if (value == null || !Number.isFinite(Number(value)) || Number(value) < 0) return "—";
  let n = Number(value), i = 0;
  const units = ["B", "KB", "MB", "GB", "TB"];
  while (n >= 1024 && i < 4) { n /= 1024; i++; }
  return n.toFixed(i > 1 ? 1 : 0) + " " + units[i];
};

// One page-level poll feeds cards AND deletion guards; never read recording.backup115.
export function useBackup115() {
  const toast = useToast();
  const [jobs, setJobs] = useState([]);
  const [connection, setConnection] = useState(null);
  const [available, setAvailable] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [pending, setPending] = useState([]);
  const [errors, setErrors] = useState([]);
  const mounted = useRef(true), revision = useRef(0), request = useRef(null), mutating = useRef(false);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; request.current?.abort(); }; }, []);
  const refresh = useCallback(async () => {
    const version = revision.current;
    request.current?.abort();
    const controller = new AbortController(); request.current = controller;
    try {
      const data = payload(await adminApi.get(BASE + "/", { signal: controller.signal }), {});
      if (!mounted.current || controller.signal.aborted || version !== revision.current) return null;
      if (!Array.isArray(data?.jobs)) { setAvailable(false); return []; }
      setJobs(data.jobs); setConnection(data.connection || null); setAvailable(true); setError("");
      return data.jobs;
    } catch (e) {
      if (controller.signal.aborted || !mounted.current) return null;
      if (e?.response?.status === 404) { setAvailable(false); return []; }
      setError(errorMessage(e, "115备份状态刷新失败，暂时禁止删除，请稍后重试"));
      throw e;
    } finally { if (mounted.current && !controller.signal.aborted) setLoading(false); }
  }, []);
  usePolling(refresh, 5000);

  const merge = incoming => setJobs(previous => [...previous.filter(j => !incoming.some(n => String(n.id) === String(j.id))), ...incoming]);
  async function run(recordingIds, job, action) {
    recordingIds = recordingIds.map(String);
    if (mutating.current) return false;
    mutating.current = true; revision.current++; request.current?.abort();
    setBusy(true); setPending(recordingIds.map(String)); setErrors([]);
    try {
      if (job) {
        const result = payload(await adminApi.post(BASE + "/jobs/" + encodeURIComponent(job.id) + "/" + action), {});
        if (!result?.id) throw new Error("服务端未返回备份任务");
        if (mounted.current) merge([result]);
      } else {
        const result = payload(await adminApi.post(BASE + "/jobs", { recordingIds }), {});
        if (!Array.isArray(result?.jobs)) throw new Error("服务端未返回备份任务列表");
        if (mounted.current) { merge(result.jobs); setErrors(Array.isArray(result.errors) ? result.errors : []); }
        if (result.errors?.length) { toast.error("部分归档未能加入115备份，请查看明细"); return false; }
      }
      toast.success(action === "cancel" ? "115备份已请求取消" : "已提交115备份任务");
      return true;
    } catch (e) {
      const message = errorMessage(e, "115备份操作失败");
      if (mounted.current) setErrors([{ recordingId: recordingIds.join("、"), error: message }]);
      toast.error(message); return false;
    } finally {
      revision.current++;
      // Keep local deletion leases until GET has reconciled a possibly timed-out POST.
      if (mounted.current) {
        try { await refresh(); } catch {}
        if (mounted.current) { setBusy(false); setPending([]); }
      }
      mutating.current = false;
    }
  }
  const isLocked = id => pending.includes(String(id)) || jobs.some(j => String(j.recordingId) === String(id) && backup115Active(j.status));
  const jobFor = id => {
    const candidates = jobs.filter(j => String(j.recordingId) === String(id));
    return candidates.find(j => backup115Active(j.status)) || candidates[candidates.length - 1];
  };
  const diskLocked = file => {
    const ids = [file.recordingId, ...(Array.isArray(file.recordingIds) ? file.recordingIds : [])].filter(id => id != null);
    // Storage DTOs without an owner cannot safely identify shared files; defer cleanup while any backup holds a lease.
    return ids.length ? ids.some(isLocked) : pending.length > 0 || jobs.some(j => backup115Active(j.status));
  };
  return { jobs, connection, available, loading, error, busy, errors, refresh, isLocked, diskLocked, jobFor,
    start: ids => run(ids), retry: job => run([job.recordingId], job, "retry"), cancel: job => run([job.recordingId], job, "cancel") };
}

export default function Backup115Archive({ backup, recordings, selectedIds, setSelectedIds, disabled = false }) {
  const eligible = recordings.filter(item => ready(item) && !backup.isLocked(item.id));
  const selectable = eligible.map(item => String(item.id));
  const selected = selectedIds.filter(id => selectable.includes(String(id)));
  return <div className="backup115-toolbar" aria-label="115批量备份">
    <div><strong>115归档备份</strong><p className="muted">独立批选，已传B站的归档也可备份；本地文件保留。</p></div>
    <div className="backup115-actions">
      <button type="button" className="btn btn-secondary btn-sm" disabled={disabled || !backup.available || backup.busy || !selectable.length} onClick={() => setSelectedIds(selectable.slice(0, 100))}>选择可备份归档</button>
      <button type="button" className="btn btn-secondary btn-sm" disabled={!selectedIds.length || backup.busy} onClick={() => setSelectedIds([])}>清空115选择</button>
      <button type="button" className="btn btn-primary btn-sm" disabled={disabled || !backup.available || backup.busy || !selected.length} onClick={async () => { if (await backup.start(selected)) setSelectedIds([]); }}>备份所选到115（{selected.length}）</button>
      <button type="button" className="btn btn-secondary btn-sm" disabled={backup.busy} onClick={() => void backup.refresh().catch(() => {})}>刷新115状态</button>
    </div>
    {!backup.available && <p className="muted" role="status">{backup.loading ? "读取115备份状态中…" : "115备份服务尚未启用"}</p>}
    {backup.available && !backup.connection?.authorized && <p className="muted">115未授权，请先到系统设置扫码，再创建备份任务。</p>}
    {backup.error && <p className="backup115-error" role="alert">{backup.error}</p>}
    {backup.errors.map((e, i) => <p className="backup115-error" role="alert" key={i}>{String(e.recordingId)}：{e.error}</p>)}
  </div>;
}

export function Backup115Card({ recording, backup, selected, onSelect, disabled = false }) {
  const job = backup.jobFor(recording.id);
  const active = backup.isLocked(recording.id);
  const selectable = ready(recording) && !active && !disabled;
  const progress = Math.max(0, Math.min(100, Number(job?.progress) || 0));
  const verified = job?.status === "succeeded" && Boolean(job?.verifiedAt);
  const fileErrors = Array.isArray(job?.files) ? job.files.filter(file => file.error) : [];
  const fileCount = Array.isArray(job?.files) ? job.files.length : 0;
  // 非活动任务把阶段/校验/目录合并成一行小字，避免卡片被明细撑高。
  const detailParts = job && !active ? [
    `阶段：${labels[job.phase] || job.phase || labels[job.status] || "—"} · ${bytes(job.uploadedBytes)} / ${bytes(job.totalBytes)}`,
    verified ? `校验时间：${new Date(job.verifiedAt).toLocaleString("zh-CN", { hour12: false })}` : "",
    job.remotePath ? `115目录：${job.remotePath}` : "",
  ].filter(Boolean) : [];
  return <div className="backup115-record" aria-label={"115备份 " + (recording.title || recording.id)}>
    <div className="backup115-record-head">
      <label className="backup115-toggle"><input type="checkbox" aria-label={"选择115备份 " + (recording.title || recording.id)} disabled={!backup.available || backup.busy || !selectable} checked={selected} onChange={e => onSelect(e.target.checked)} />115备份</label>
      <span className={verified ? "backup115-verified" : "backup115-state"} role="status">{job ? verified ? "已校验" : job.status === "succeeded" ? "上传完成 · 尚无校验证据" : labels[job.status] || job.status : "未备份"}</span>
      {/* pending 提交中 job 还未返回，active 为真而 job 为空；进度只在有任务时渲染 */}
      {active && job && <progress className="backup115-progress" aria-label="115备份进度" max="100" value={progress} />}
      {active && job && <span className="backup115-detail">{bytes(job.uploadedBytes)} / {bytes(job.totalBytes)}</span>}
      <div className="backup115-actions">
        <button type="button" className="btn btn-secondary btn-sm" disabled={!backup.available || backup.busy || !selectable} onClick={() => backup.start([recording.id])}>{job?.status === "succeeded" ? "再次备份到115" : "备份到115"}</button>
        {job && retryable(job.status) && <button type="button" className="btn btn-secondary btn-sm" disabled={disabled || backup.busy || active || !ready(recording)} onClick={() => backup.retry(job)}>重试115备份</button>}
        {job && backup115Active(job.status) && <button type="button" className="btn btn-secondary btn-sm" disabled={backup.busy} onClick={() => backup.cancel(job)}>取消115备份</button>}
      </div>
    </div>
    {detailParts.length > 0 && <div className="backup115-detail backup115-detail-line">{detailParts.join(" · ")}</div>}
    {job && <>
      {job.error && <p className="backup115-error" role="alert">{job.error}</p>}
      {fileErrors.map((file, i) => <p key={i} className="backup115-error" role="alert">{file.name || file.role}：{file.error}</p>)}
      {fileCount > 0 && <details className="backup115-files-details"><summary>备份文件明细（{fileCount}）</summary><ul className="backup115-files">{job.files.map((file, i) => <li key={i}><strong>{file.name || file.role}</strong> · {file.role} · {bytes(file.size)} · {labels[file.status] || file.status}{file.remoteFileId && <span> · 远端ID：{String(file.remoteFileId)}</span>}{file.error && <span className="backup115-error"> · {file.error}</span>}</li>)}</ul></details>}
    </>}
  </div>;
}
