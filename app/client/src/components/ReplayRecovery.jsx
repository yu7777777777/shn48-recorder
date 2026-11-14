import React from "react";

export const replayWorking = item => ["pending", "downloading", "verifying", "waiting_replay", "awaiting_archive"].includes(item?.replayRecovery?.status);
function duration(seconds) {
  const value = Math.max(0, Math.round(Number(seconds) || 0));
  return `${Math.floor(value / 60)} 分 ${value % 60} 秒`;
}
export default function ReplayRecovery({ recording, busy, onStart }) {
  if (recording.source !== "pocket48" || !recording.liveId || recording.mediaType === "audio" || recording.manualStop) return null;
  const state = recording.replayRecovery;
  const working = replayWorking(recording);
  const uploaded = recording.draftId || ["done", "queued", "waiting_credentials", "uploading", "paused_recording"].includes(recording.uploadStatus);
  return <section className="card replay-recovery" aria-label="官方回放补全">
    <div className="card-title-row"><div><h2>官方回放补全</h2><p>完整下载 → 离线校验 → 对比录像 → 切换归档。原录像保留备份。</p></div>
      <button className="btn btn-secondary btn-sm" disabled={busy || working || uploaded || recording.status !== "done" || state?.status === "replaced"} onClick={onStart}>
        {state?.status === "replaced" ? "已使用官方回放" : working ? "回放处理中…" : state ? "重新下载并对比" : "下载回放并对比"}
      </button></div>
    {state && <div role="status"><p>{state.message}{state.status === "downloading" && state.totalSegments ? ` · ${state.progress || 0}%` : ""}</p>
      {state.comparison && <p>原录像 {duration(state.comparison.localDuration)} · 官方回放 {duration(state.comparison.officialDuration)}{state.comparison.gainedSeconds > 0 ? ` · 多出 ${duration(state.comparison.gainedSeconds)}` : ""}</p>}
      {state.status === "replaced" && <a className="btn btn-secondary btn-sm" href={`/api/admin/recordings/${encodeURIComponent(recording.id)}/original-download`}>下载原录像备份</a>}
      {state.nextAttemptAt && <p>下次尝试：{new Date(state.nextAttemptAt).toLocaleTimeString("zh-CN", { hour12: false })}；下载失败时保留原录像。</p>}
    </div>}
    {!state && <p className="muted">新增自动录制会在结束后自动尝试补全；已上传草稿或已有字幕、剪辑的录像会保留原文件。</p>}
  </section>;
}
