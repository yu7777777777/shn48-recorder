import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link, useParams, useSearchParams } from "react-router-dom";
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
import DanmakuPeaksBar from "../components/DanmakuPeaksBar";

const labels = { done: "已归档", clip_queued: "等待剪辑", clip_processing: "正在生成", clip_failed: "生成失败", recording: "录制中", waiting_merge: "等待续播", processing: "归档中", archive_failed: "归档失败", deleted: "已删除", failed: "录制失败" };
const uploading = ["queued", "waiting_credentials", "uploading", "paused_recording"];
export function timecode(value) {
  const seconds = Math.max(0, Math.floor(Number(value) || 0));
  return [Math.floor(seconds / 3600), Math.floor(seconds / 60) % 60, seconds % 60].map(n => String(n).padStart(2, "0")).join(":");
}

const EXPORT_PROFILES = [["landscape", "横屏 MP4"], ["portrait", "竖屏 MP4"], ["audio", "仅音频 M4A"]];
const EXPORT_JOB_LABELS = { queued: "排队中", running: "转码中", done: "已完成", failed: "失败" };

// 真实转码导出：横屏/竖屏/仅音频档位由 ffmpeg 实际编码，可选字幕烧录。
// 转码在服务端队列执行（一次一个），录制/归档任务优先。
function TranscodeExportPanel({ id, mediaType, status }) {
  const [jobs, setJobs] = useState([]);
  const [busy, setBusy] = useState("");
  const [burnSubtitle, setBurnSubtitle] = useState(false);
  const [language, setLanguage] = useState("original");
  const [error, setError] = useState("");
  const toast = useToast();
  const alive = useRef(false);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);

  const refresh = async () => {
    try {
      const rows = payload(await adminApi.get("/exports"), []);
      if (!alive.current) return;
      setJobs(Array.isArray(rows) ? rows.filter(row => row.recordingId === id) : []);
    } catch { /* 列表失败不打断页面其余部分 */ }
  };
  usePolling(refresh, 5000, [id]);

  async function enqueue(profile) {
    setBusy(profile);
    setError("");
    try {
      await adminApi.post("/exports", { recordingId: id, profile, burnSubtitle, language }, { timeout: 60000 });
      toast.success("已加入转码队列，完成后可在此下载");
      await refresh();
    } catch (err) {
      // Inline (not just a toast): the verbatim server reason must stay readable
      // next to the buttons so a refused job can be corrected and retried.
      if (alive.current) setError(errorMessage(err, "导出任务创建失败"));
    } finally {
      setBusy("");
    }
  }
  async function jobAction(key, fn, message) {
    setBusy(key);
    try {
      await fn();
      toast.success(message);
      await refresh();
    } catch (err) {
      toast.error(errorMessage(err, "操作失败"));
    } finally {
      setBusy("");
    }
  }

  return <section className="card detail-export" aria-labelledby="recording-export-title">
    <h2 id="recording-export-title">转码导出</h2>
    <p>由服务器真实转码生成新文件：横屏 1920×1080（缩放留黑边）、竖屏 1080×1920（居中裁切）、仅音频 M4A。
      {mediaType === "audio" && " 本归档是音频，仅支持仅音频档位。"}</p>
    <div className="detail-actions" style={{ flexWrap: "wrap", alignItems: "center" }}>
      {EXPORT_PROFILES.map(([profile, label]) =>
        <button key={profile} type="button" className="btn btn-secondary btn-sm" aria-label={"导出（" + label + "）"}
          disabled={Boolean(busy) || (mediaType === "audio" && profile !== "audio")}
          onClick={() => enqueue(profile)}>导出（{label}）</button>)}
    </div>
    {error && <p className="detail-error" role="alert">{error}</p>}
    {mediaType !== "audio" && <div className="detail-actions" style={{ alignItems: "center", marginTop: 8 }}>
      <label style={{ display: "flex", alignItems: "center", gap: 6 }}>
        <input type="checkbox" checked={burnSubtitle} onChange={e => setBurnSubtitle(e.target.checked)} /> 烧录字幕
      </label>
      <select className="voice-select" aria-label="烧录字幕语言" value={language} onChange={e => setLanguage(e.target.value)} disabled={!burnSubtitle}>
        <option value="original">原文</option>
        <option value="en">英文</option>
        <option value="ja">日文</option>
        <option value="bilingual">双语</option>
        <option value="ja-bilingual">中日双语</option>
      </select>
      <small style={{ color: "var(--text-dim)" }}>烧录字幕需重新完整编码视频，CPU 占用与耗时明显增加（长录像可能要数十分钟）；导出前请先确认这条归档已有字幕。</small>
    </div>}
    {Boolean(jobs.length) && <div style={{ marginTop: 12 }}>
      {jobs.map(job => <div key={job.id} style={{ display: "flex", gap: 10, alignItems: "center", padding: "6px 0", borderTop: "1px solid var(--border)", flexWrap: "wrap" }}>
        <StatusBadge status={job.status === "done" ? "healthy" : job.status === "failed" ? "failed" : "processing"}>{EXPORT_JOB_LABELS[job.status] || job.status}{job.status === "running" ? ` ${job.progress || 0}%` : ""}</StatusBadge>
        <span>{EXPORT_PROFILES.find(([profile]) => profile === job.profile)?.[1] || job.profile}{job.burnSubtitle ? " · 烧录字幕" : ""}</span>
        {job.status === "done" && <a className="btn btn-secondary btn-sm" href={`/api/admin/exports/${job.id}/download`}>下载</a>}
        {job.status === "failed" && <button type="button" className="btn btn-secondary btn-sm" disabled={Boolean(busy)} onClick={() => jobAction(`retry:${job.id}`, () => adminApi.post(`/exports/${job.id}/retry`), "已重新加入导出队列")}>重试</button>}
        {job.status !== "running" && <button type="button" className="btn btn-secondary btn-sm" disabled={Boolean(busy)} onClick={() => jobAction(`del:${job.id}`, () => adminApi.delete(`/exports/${job.id}?file=true`), "导出任务与文件已删除")}>删除</button>}
        {job.error && <small className="detail-error" role="alert">{job.error}</small>}
      </div>)}
    </div>}
  </section>;
}

export default function RecordingDetail() {
  const { id } = useParams();
  const [params] = useSearchParams();
  const toast = useToast();
  const [recording, setRecording] = useState(null);
  const [clips, setClips] = useState([]);
  const [messages, setMessages] = useState([]);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState("");
  const [duration, setDuration] = useState(0);
  const [position, setPosition] = useState(0);
  const [reload, setReload] = useState(0);
  const video = useRef(null);
  const [suggestedRange, setSuggestedRange] = useState(null);
  // 从字幕搜索跳转的 ?t= 只消费一次；跨录像切换时在重置副作用里重新武装。
  const seekApplied = useRef(false);

  // timeupdate fires ~4Hz and re-renders the whole detail page through the
  // position prop; throttle to ~500ms with a trailing call so a pause or seek
  // inside the window still lands on the final position (caption highlight
  // follows at the same cadence via the native track and .current line).
  const positionClock = useRef(0), positionTrail = useRef(null), latestPosition = useRef(0);
  const updatePosition = useCallback(value => {
    latestPosition.current = Number(value) || 0;
    if (positionTrail.current) return;
    const elapsed = Date.now() - positionClock.current;
    if (elapsed >= 500) {
      positionClock.current = Date.now();
      setPosition(latestPosition.current);
      return;
    }
    positionTrail.current = window.setTimeout(() => {
      positionTrail.current = null;
      positionClock.current = Date.now();
      setPosition(latestPosition.current);
    }, 500 - elapsed);
  }, []);
  useEffect(() => () => { if (positionTrail.current) window.clearTimeout(positionTrail.current); }, []);

  useEffect(() => {
    setRecording(null); setError(""); setDuration(0); setPosition(0);
    if (positionTrail.current) { window.clearTimeout(positionTrail.current); positionTrail.current = null; }
    positionClock.current = 0;
    video.current = null;
    // 从字幕搜索跳转的 ?t= 定位只对本场录像生效一次；换到下一条录像要重新武装。
    seekApplied.current = false;
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
      // 弹幕高能：录制期抓到的房间消息按 offset 分桶。仅 pocket48 来源有 roomId，
      // 失败（无消息/非口袋48来源）时静默留空。
      if (payload(result)?.source === "pocket48") {
        try {
          const rows = payload(await adminApi.get(`/room-voice/${id}/messages`), []);
          if (token === requestRef.current) setMessages(Array.isArray(rows) ? rows : []);
        } catch { if (token === requestRef.current) setMessages([]); }
      }
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

  // 从字幕搜索页跳转：?t=<秒> 在播放器就绪后定位一次。
  const seekTarget = Number(params.get("t")) || 0;
  useEffect(() => {
    if (!seekTarget || seekApplied.current) return;
    if (video.current && Number.isFinite(duration) && duration > 0) {
      seekApplied.current = true;
      try { video.current.currentTime = Math.min(seekTarget, Math.max(0, duration - 1)); } catch {}
    }
  }, [seekTarget, duration, ready]);

  // AI 生成投稿标题与简介：生成后确认回填（title/desc 是 PATCH 白名单字段）。
  async function generateSubmission() {
    if (!window.confirm("将用本场总结/章节由 AI 生成投稿标题与简介，并覆盖当前标题与简介字段。是否继续？")) return;
    await action("submission", async () => {
      const result = payload(await adminApi.post(`/analysis/${id}/submission`, {}, { timeout: 150000 }));
      await adminApi.patch(`/recordings/${id}`, { title: result.title, desc: result.desc });
      setRecording(current => current ? { ...current, title: result.title, desc: result.desc } : current);
    }, "已生成并回填投稿标题与简介");
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
      {ready && <div className="detail-actions">
        <a className="btn btn-secondary btn-sm" href={`/api/admin/recordings/${id}/download`}>下载归档文件</a>
        <button type="button" className="btn btn-secondary btn-sm" disabled={Boolean(busy) || ready === false} onClick={generateSubmission} title="AI 根据本场总结生成 B站投稿标题与简介并回填">{busy === "submission" ? "生成中…" : "AI 标题简介"}</button>
        {uploadButton(recording)}
      </div>}
    </header>
    {error && <p className="detail-error" role="alert">刷新失败：{error}</p>}
    <ReplayRecovery recording={recording} busy={Boolean(busy)} onStart={() => action("replay", async () => {
      const response = await adminApi.post(`/recordings/${id}/recover-replay`);
      setRecording(current => ({ ...current, ...payload(response) }));
    }, "已开始下载官方回放，下载与校验完成后才会替换")}/>
    <div className="detail-workspace">
      <section className="detail-preview">
        {ready && recording.mediaType === 'audio' ? <audio className="voice-audio" controls src={stream.proxyUrl} ref={video} onLoadedMetadata={e=>setDuration(e.currentTarget.duration)} onTimeUpdate={e=>updatePosition(e.currentTarget.currentTime)}/> : ready ? <VideoPlayer key={`${id}:${recording.filePath}`} stream={stream} mode="replay" title={recording.title}
          poster={recording.coverFile ? `/api/admin/recordings/${id}/cover` : undefined}
          onLoadedMetadata={event => { video.current = event.currentTarget; const d = event.currentTarget.duration; if (Number.isFinite(d)) { setDuration(d); } }}
          onTimeUpdate={event => updatePosition(event.currentTarget.currentTime)} />
          : <div className="detail-unavailable"><h2>{labels[recording.status] || "暂不可播放"}</h2><p>{recording.clipError || "文件准备完成后即可播放和剪辑。"}</p>{recording.status === "clip_failed" && <button className="btn btn-secondary" disabled={Boolean(busy)} onClick={() => action("retry", () => adminApi.post(`/recordings/${id}/retry-clip`), "已重新加入剪辑队列")}>重试剪辑</button>}</div>}
        {ready && <DanmakuPeaksBar messages={messages} duration={duration} onSeek={t => { if (video.current) { video.current.currentTime = t; video.current.play?.().catch(() => {}); } }} />}
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
    {ready && !replayWorking(recording) && <TranscodeExportPanel key={`export:${id}`} id={id} mediaType={recording.mediaType} status={recording.status} />}
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
