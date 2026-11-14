import React, { useEffect, useMemo, useRef, useState } from "react";
import { Link, useParams } from "react-router-dom";
import VideoPlayer from "../components/VideoPlayer";
import { StatusBadge } from "../components/Badge";
import { adminApi, payload, errorMessage } from "../lib/api";
import { useToast } from "../components/Toast";
import usePolling from "../hooks/usePolling";
import "./RecordingDetail.css";
import TimelineEditor from "../components/TimelineEditor";
import AnalysisPanel from "../components/AnalysisPanel";
import ReplayRecovery, { replayWorking } from "../components/ReplayRecovery";
import AnalysisProvenance from "../components/AnalysisProvenance";

const labels = { done: "已归档", clip_queued: "等待剪辑", clip_processing: "正在生成", clip_failed: "生成失败", recording: "录制中", waiting_merge: "等待续播", processing: "归档中", archive_failed: "归档失败", deleted: "已删除", failed: "录制失败" };
const uploading = ["queued", "waiting_credentials", "uploading", "paused_recording"];
export function timecode(value) {
  const seconds = Math.max(0, Math.floor(Number(value) || 0));
  return [Math.floor(seconds / 3600), Math.floor(seconds / 60) % 60, seconds % 60].map(n => String(n).padStart(2, "0")).join(":");
}

// This API currently exports analysis text plus profile metadata, not encoded media.
function RecordingExportPanel({ id }) {
  const [state, setState] = useState({ busy: "", error: "", url: "", profile: "" });
  const request = useRef(null);
  const objectUrl = useRef("");
  const alive = useRef(false);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      request.current?.abort();
      if (objectUrl.current) URL.revokeObjectURL(objectUrl.current);
    };
  }, []);
  async function exportProfile(profile) {
    if (request.current) return;
    const controller = new AbortController();
    request.current = controller;
    if (objectUrl.current) { URL.revokeObjectURL(objectUrl.current); objectUrl.current = ""; }
    setState({ busy: profile, error: "", url: "", profile });
    try {
      const response = await adminApi.get("/analysis/" + encodeURIComponent(id) + "/summary", {
        params: { format: "markdown", profile }, signal: controller.signal,
      });
      if (!alive.current) return;
      const result = payload(response);
      if (result?.success === false || response.data?.success === false) {
        throw new Error(result?.error || response.data?.error || "导出失败");
      }
      let url = "";
      if (result && typeof result === "object") {
        const candidate = result.downloadUrl || result.url;
        if (candidate) {
          const parsed = new URL(candidate, window.location.origin);
          if (!["http:", "https:"].includes(parsed.protocol)) throw new Error("服务器返回的下载链接无效");
          url = parsed.href;
        }
      } else if (typeof result === "string") {
        url = URL.createObjectURL(new Blob([result], { type: "text/markdown;charset=utf-8" }));
        objectUrl.current = url;
      }
      setState({ busy: "", error: "", url, profile });
    } catch (err) {
      if (alive.current && !controller.signal.aborted) setState({ busy: "", error: errorMessage(err, "导出失败"), url: "", profile });
    } finally { request.current = null; }
  }
  return <section className="card detail-export" aria-labelledby="recording-export-title">
    <h2 id="recording-export-title">导出</h2>
    <p>当前导出的是分析文本与档位参数，不会生成转码后的横屏/竖屏/音频文件</p>
    <div className="detail-actions">
      {[["landscape", "横屏"], ["portrait", "竖屏"], ["audio", "仅音频"]].map(([profile, label]) =>
        <button key={profile} type="button" className="btn btn-secondary btn-sm" aria-label={"导出（" + label + "）"} disabled={Boolean(state.busy)} onClick={() => exportProfile(profile)}>导出（{label}）</button>)}
    </div>
    {state.busy && <p role="status">正在导出，请稍候…</p>}
    {state.error && <p className="detail-error" role="alert">{state.error}</p>}
    {!state.busy && !state.error && state.profile && <p role="status">导出完成（未进行媒体转码）{state.url && <> · <a href={state.url} download={"analysis-" + state.profile + ".md"}>下载导出文件</a></>}</p>}
  </section>;
}

export default function RecordingDetail() {
  const { id } = useParams();
  const toast = useToast();
  const [recording, setRecording] = useState(null);
  const [clips, setClips] = useState([]);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState("");
  const [duration, setDuration] = useState(0);
  const [position, setPosition] = useState(0);
  const [reload, setReload] = useState(0);
  const video = useRef(null);
  const [suggestedRange, setSuggestedRange] = useState(null);


  useEffect(() => {
    setRecording(null); setError(""); setDuration(0); setPosition(0);
    video.current = null;
  }, [id, reload]);
  const requestRef = useRef(0);
  const refresh = async () => {
    const token = ++requestRef.current;
    try {
      const [result, children, queue] = await Promise.all([adminApi.get(`/recordings/${id}`), adminApi.get(`/recordings/${id}/clips`), adminApi.get("/bilibili/queue")]);
      if (token !== requestRef.current) return;
      const jobs = payload(queue, []);
      const withUpload = item => {
        const job = [...jobs].reverse().find(j => j.recordingId === item.id);
        return job ? { ...item, uploadStatus: job.status } : item;
      };
      setRecording(withUpload(payload(result))); setClips(payload(children, []).map(withUpload)); setError("");
    } catch (err) { if (token === requestRef.current) setError(errorMessage(err, "录像信息读取失败")); }
  };
  usePolling(refresh, 5000, [id, reload]);

  const stream = useMemo(() => ({ proxyUrl: `/api/admin/recordings/${encodeURIComponent(id)}/file`,
    protocol: String(recording?.filePath || "").toLowerCase().endsWith(".mp4") ? "mp4" : "flv" }), [id, recording?.filePath]);
  const ready = recording?.status === "done";
  async function action(key, fn, message) {
    setBusy(key);
    try { await fn(); toast.success(message); }
    catch (err) { toast.error(errorMessage(err)); }
    finally { setBusy(""); }
  }
  function upload(item) {
    const recoveryStatus = item.replayRecovery?.status;
    const confirmLocal = ["failed", "kept_local"].includes(recoveryStatus);
    if (confirmLocal && !window.confirm(`官方回放核对未替换本地录像（${item.replayRecovery?.message || "回放处理失败"}）。是否确认使用当前本地录像投稿到 B 站草稿箱？`)) return;

    void action(`upload:${item.id}`, async () => {
      await adminApi.post(`/recordings/${item.id}/upload`, { mode: "draft", ...(confirmLocal ? { confirmLocal: true } : {}) });
      const update = rec => rec.id === item.id ? { ...rec, uploadStatus: "queued" } : rec;
      setClips(current => current.map(update)); setRecording(update);
    }, "已加入 B站草稿队列");
  }
  function uploadButton(item) {
    if (item.mediaType === 'audio') return null;
    const done = item.uploadStatus === "done" || Boolean(item.draftId);
    const active = uploading.includes(item.uploadStatus);
    return <button className="btn btn-primary btn-sm" disabled={Boolean(busy) || replayWorking(item) || item.status !== "done" || done || active} onClick={() => upload(item)}>
      {done ? "已存 B站草稿" : active ? "已在上传队列" : busy === `upload:${item.id}` ? "加入中…" : ["failed", "kept_local"].includes(item.replayRecovery?.status) ? "使用本地录像投稿" : "送入 B站草稿"}</button>;
  }
  if (!recording) return <div className="page recording-detail"><Link to="/admin/archive">← 返回录像归档</Link><p role={error ? "alert" : "status"}>{error || "正在读取录像…"}</p>{error && <button className="btn btn-secondary" onClick={() => setReload(n => n + 1)}>重试</button>}</div>;
  return <div className="page recording-detail">
    <Link className="detail-back" to="/admin/archive">← 录像归档</Link>
    <header className="detail-heading">
      <div><div className="detail-eyebrow">{recording.source === "clip" ? "精彩片段" : "录像工作台"} · {recording.memberName || "48tools"}</div><h1>{recording.title || "未命名录像"}</h1>
        <p>{new Date(recording.createdAt).toLocaleString("zh-CN", { hour12: false })} · <StatusBadge status={recording.status}>{labels[recording.status] || recording.status}</StatusBadge></p>
        {recording.parentRecordingId && <Link to={`/admin/archive/${recording.parentRecordingId}`}>查看来源录像 · {timecode(recording.clipStart)} — {timecode(recording.clipEnd)}</Link>}
      </div>
      {ready && <div className="detail-actions"><a className="btn btn-secondary btn-sm" href={`/api/admin/recordings/${id}/download`}>下载归档文件</a>{uploadButton(recording)}</div>}
    </header>
    {error && <p className="detail-error" role="alert">刷新失败：{error}</p>}
    <ReplayRecovery recording={recording} busy={Boolean(busy)} onStart={() => action("replay", async () => {
      const response = await adminApi.post(`/recordings/${id}/recover-replay`);
      setRecording(current => ({ ...current, ...payload(response) }));
    }, "已开始下载官方回放，下载与校验完成后才会替换")}/>
    <div className="detail-workspace">
      <section className="detail-preview">
        {ready && recording.mediaType === 'audio' ? <audio className="voice-audio" controls src={stream.proxyUrl} ref={video} onLoadedMetadata={e=>setDuration(e.currentTarget.duration)} onTimeUpdate={e=>setPosition(e.currentTarget.currentTime)}/> : ready ? <VideoPlayer key={`${id}:${recording.filePath}`} stream={stream} mode="replay" title={recording.title}
          poster={recording.coverFile ? `/api/admin/recordings/${id}/cover` : undefined}
          onLoadedMetadata={event => { video.current = event.currentTarget; const d = event.currentTarget.duration; if (Number.isFinite(d)) { setDuration(d); } }}
          onTimeUpdate={event => setPosition(event.currentTarget.currentTime)} />
          : <div className="detail-unavailable"><h2>{labels[recording.status] || "暂不可播放"}</h2><p>{recording.clipError || "文件准备完成后即可播放和剪辑。"}</p>{recording.status === "clip_failed" && <button className="btn btn-secondary" disabled={Boolean(busy)} onClick={() => action("retry", () => adminApi.post(`/recordings/${id}/retry-clip`), "已重新加入剪辑队列")}>重试剪辑</button>}</div>}
        <div className="detail-playhead"><span>当前播放 <b>{timecode(position)}</b></span><span>总时长 {duration ? timecode(duration) : "—"}</span></div>
        {recording.mediaType !== "audio" && <div className="detail-note"><strong>留下值得重看的这一段</strong><p>播放到想保留的位置，标记起点与终点。预览满意后生成独立片段，即可下载或送入 B站草稿。</p></div>}
      </section>

    </div>
    {ready && !replayWorking(recording) && <AnalysisPanel key={`analysis:${id}:${recording.filePath}`} id={id} video={video} position={position} audio={recording.mediaType === 'audio'} onRange={r=>action(`chapter:${r.start}`, async () => {
      const result = payload(await adminApi.post(`/recordings/${id}/clips`, {
        segments: [{ start: r.start, end: r.end }],
        title: r.title ? `${r.title} · 剪辑` : `${recording.title || "录像"} · 剪辑`,
      }));
      setClips(current => [result, ...current.filter(c => c.id !== result.id)]);
    }, "章节已加入剪辑队列")}/>} 
    {ready && !replayWorking(recording) && <RecordingExportPanel key={`export:${id}`} id={id} />}
    {ready && !replayWorking(recording) && <AnalysisProvenance key={`provenance:${id}`} id={id} />}
    {ready && !replayWorking(recording) && recording.mediaType !== 'audio' && <TimelineEditor key={`${id}:${recording.filePath}`} suggestedRange={suggestedRange} duration={duration} position={position} video={video} busy={busy === "create"} defaultTitle={recording.title} onExport={options => action("create", async () => {
      const result = payload(await adminApi.post(`/recordings/${id}/clips`, options));
      setClips(current => [result, ...current.filter(c => c.id !== result.id)]);
    }, "成片已加入剪辑队列")} />}
    {recording.mediaType !== "audio" && <section className="card detail-clips" aria-labelledby="clips-title"><div className="detail-eyebrow">02 / 片段库</div><h2 id="clips-title">从这条录像创建的片段 <span>{clips.length}</span></h2>
      {!clips.length ? <p className="clip-empty">还没有片段。选好时间范围，让第一个精彩瞬间留在这里。</p> : <div className="clip-list">{clips.map(item => <article key={item.id} className="clip-item">
        <div className="clip-item-info"><Link to={`/admin/archive/${item.id}`}>{item.title}</Link><p>{timecode(item.clipStart)} — {timecode(item.clipEnd)} · {item.segments?.length || 1} 段 · {(item.duration || 0).toFixed(1)} 秒</p><StatusBadge status={item.status}>{labels[item.status] || item.status}{item.status === "clip_processing" ? ` ${item.clipProgress || 0}%` : ""}</StatusBadge>{item.clipError && <p role="alert" className="detail-error">{item.clipError}</p>}</div>
        <div className="detail-actions">{item.status === "done" && <><Link className="btn btn-secondary btn-sm" to={`/admin/archive/${item.id}`}>播放</Link><a className="btn btn-secondary btn-sm" href={`/api/admin/recordings/${item.id}/download`}>下载</a>{uploadButton(item)}</>}{item.status === "clip_failed" && <button className="btn btn-secondary btn-sm" disabled={Boolean(busy)} onClick={() => action(`retry:${item.id}`, async () => { await adminApi.post(`/recordings/${item.id}/retry-clip`); setClips(current => current.map(c => c.id === item.id ? { ...c, status: "clip_queued", clipError: null } : c)); }, "已重新加入剪辑队列")}>重试</button>}</div>
      </article>)}</div>}
    </section>}
  </div>;
}
