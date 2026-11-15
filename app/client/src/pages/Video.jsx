import React, { useCallback, useEffect, useMemo, useState } from "react";
import usePolling from "../hooks/usePolling";
import Backup115Archive, { Backup115Card, useBackup115 } from "../components/Backup115Archive";
import { useNavigate } from "react-router-dom";
import { StatusBadge } from "../components/Badge";
import SafeImage from "../components/SafeImage";
import ConfirmModal from "../components/ConfirmModal";
import CoverPicker from "../components/CoverPicker";
import { replayWorking } from "../components/ReplayRecovery";
import EmptyState from "../components/EmptyState";
import {
  IconArchive,
  IconDownload,
  IconHardDrive,
  IconLayers,
  IconPlay,
  IconRefresh,
  IconTrash,
  IconUpload,
  IconX,
} from "../components/Icons";
import ProgressBar from "../components/ProgressBar";
import { useToast } from "../components/Toast";
import VideoPlayer from "../components/VideoPlayer";
import { adminApi, errorMessage, listPayload, payload } from "../lib/api";

function formatBytes(bytes) {
  if (bytes == null || !Number.isFinite(Number(bytes)) || Number(bytes) < 0) return "—";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let value = Number(bytes);
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(unit >= 2 ? 1 : 0)} ${units[unit]}`;
}

function formatDate(value) {
  if (!value) return "—";
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? "—"
    : date.toLocaleString("zh-CN", { hour12: false });
}

const statusText = {
  recording: "录制中",
  processing: "归档中",
  waiting_merge: "等待续播",
  archive_failed: "整理失败",
  done: "已归档",
  completed: "已归档",
  archived: "已归档",
  queued: "等待上传",
  uploading: "上传中",
  waiting_credentials: "等待登录",
  paused_recording: "录制中暂停上传",
  draft: "已存草稿",
  failed: "失败",
};

const uploadStatusRank = {
  done: 5,
  draft: 5,
  uploading: 4,
  paused_recording: 4,
  queued: 3,
  waiting_credentials: 3,
  failed: 1,
  not_uploaded: 0,
};

function isUploaded(status) {
  return ["draft", "done"].includes(status);
}

function isUploadActive(status) {
  return [
    "queued",
    "waiting_credentials",
    "uploading",
    "paused_recording",
    "pending",
  ].includes(status);
}

function recordingUrl(item, action = "file") {
  return `/api/admin/recordings/${encodeURIComponent(item.id)}/${action}`;
}

function mediaType(item) {
  const value = String(item.container || item.fileName || item.filePath || "").toLowerCase();
  return value.endsWith(".mp4") || value === "mp4" ? "mp4" : "flv";
}

export default function ArchivePage() {
  const [recordings, setRecordings] = useState([]);
  const [filter, setFilter] = useState("all");
  const [busy, setBusy] = useState("");
  const [playing, setPlaying] = useState(null);
  const navigate = useNavigate();
  const playItem = item => item.mediaType === "audio" ? navigate(`/admin/archive/${item.id}`) : setPlaying(item);
  const [storage, setStorage] = useState(null);
  const [diskFiles, setDiskFiles] = useState(null);
  const [deleteTarget, setDeleteTarget] = useState(null);
  const [isDeleting, setIsDeleting] = useState(false);
  const [loading, setLoading] = useState(false);
  const [listError, setListError] = useState("");
  const [coverTarget, setCoverTarget] = useState(null);
  const [selectedIds, setSelectedIds] = useState([]);
  const [backupSelectedIds, setBackupSelectedIds] = useState([]);
  const backup115 = useBackup115();
  const backupDeleteLocked = target => backup115.loading || Boolean(backup115.error) || (target?.diskFile ? backup115.diskLocked(target) : backup115.isLocked(target?.id));
  const [coverBatch, setCoverBatch] = useState(null);
  const [repostTarget, setRepostTarget] = useState(null);
  const [isReposting, setIsReposting] = useState(false);
  const toast = useToast();

  const loadRecordings = useCallback(async () => {
    setLoading(true);
    try {
      const [recordingsResponse, queueResponse, healthResponse, diskResponse] =
        await Promise.all([
          adminApi.get("/recordings"),
          adminApi.get("/bilibili/queue"),
          adminApi.get("/health").catch(() => null),
          adminApi.get("/recordings/storage"),
        ]);
      setStorage(
        healthResponse ? payload(healthResponse, {}).storage || null : null
      );
      setDiskFiles(payload(diskResponse, null));
      const queue = listPayload(queueResponse, ["queue", "items"]);
      const queueByRecording = new Map();
      for (const item of queue) {
        const key = String(item.recordingId);
        const current = queueByRecording.get(key);
        const itemTime = Date.parse(item.addedAt || "") || 0;
        const currentTime = Date.parse(current?.addedAt || "") || 0;
        if (
          !current ||
          itemTime > currentTime ||
          (itemTime === currentTime && (uploadStatusRank[item.status] || 0) >
            (uploadStatusRank[current.status] || 0)
          )
        ) {
          queueByRecording.set(key, item);
        }
      }
      setListError("");
      setRecordings(
        listPayload(recordingsResponse, ["recordings", "items"]).map((item) => {
          const job = queueByRecording.get(String(item.id));
          const recordingRank = uploadStatusRank[item.uploadStatus] || 0;
          const jobRank = uploadStatusRank[job?.status] || 0;
          return job && (job.id === item.uploadJobId || jobRank >= recordingRank)
            ? { ...item, uploadStatus: job.status, uploadJobId: job.id }
            : item;
        })
      );
    } catch (requestError) {
      // Polling keeps the previous list visible; a repeated popup per interval
      // would only bury the rest of the page during an outage.
      setListError(errorMessage(requestError, "归档列表获取失败"));
    } finally {
      setLoading(false);
    }
  }, []);

  usePolling(loadRecordings, 10000);
  usePolling(async () => {
    try {
      setCoverBatch(payload(await adminApi.get("/recordings/cover-batch")));
    } catch {}
  }, 5000);
  useEffect(() => { if (coverBatch?.status === "done") void loadRecordings(); }, [coverBatch?.status, loadRecordings]);
  async function regenerateSelected() {
    setBusy("cover-batch");
    try {
      setCoverBatch(payload(await adminApi.post("/recordings/cover-batch", { ids: selectedIds })));
      setSelectedIds([]); toast.success("批量封面任务已开始，可以继续浏览归档");
    } catch (error) { toast.error(errorMessage(error, "批量任务启动失败")); }
    finally { setBusy(""); }
  }

  const filtered = useMemo(
    () =>
      recordings.filter((item) => {
        if (filter === "all") return true;
        if (filter === "ready") return item.status === "done";
        if (filter === "uploading") return isUploadActive(item.uploadStatus);
        if (filter === "draft") return isUploaded(item.uploadStatus);
        return true;
      }),
    [filter, recordings]
  );

  async function retryReplay(item) {
    const key = `replay:${item.id}`;
    setBusy(key);
    try {
      await adminApi.post(`/recordings/${encodeURIComponent(item.id)}/recover-replay`);
      toast.success("已重新开始官方回放核对");
      await loadRecordings();
    } catch (requestError) {
      toast.error(errorMessage(requestError, "重新核对失败"));
    } finally { setBusy(current => current === key ? "" : current); }
  }

  async function uploadDraft(item) {
    const key = `upload:${item.id}`;
    setBusy(key);
    try {
      const recoveryStatus = item.replayRecovery?.status;
      const confirmLocal = ["failed", "kept_local"].includes(recoveryStatus);
      if (confirmLocal && !window.confirm(`官方回放核对未替换本地录像（${item.replayRecovery?.message || "回放处理失败"}）。是否确认使用当前本地录像投稿到 B 站草稿箱？`)) return;
      await adminApi.post(`/recordings/${encodeURIComponent(item.id)}/upload`, {
        mode: "draft",
        ...(confirmLocal ? { confirmLocal: true } : {}),
        title: item.title || item.name || undefined,
      }, { timeout: 600000 });
      toast.success(`“${item.title || item.name || item.id}”已加入 B站草稿上传队列`);
      await loadRecordings();
    } catch (requestError) {
      const duplicate = requestError?.response?.data?.code === "ALREADY_UPLOADED";
      if (duplicate) {
        toast.info("该录像已在 B站草稿箱中，无需重复上传");
        await loadRecordings();
      } else {
        toast.error(errorMessage(requestError, "加入上传队列失败"));
      }
    } finally {
      setBusy((current) => (current === key ? "" : current));
    }
  }

  async function repostRepaired(item) {
    if (!item?.id) return;
    const name = item.title || item.name || item.id;
    setIsReposting(true);
    try {
      await adminApi.post(`/recordings/${encodeURIComponent(item.id)}/reupload`, {
        confirmed: true,
        mode: "draft",
        title: name,
      });
      toast.success(`“${name}”已重新加入 B站草稿上传队列`);
      setRepostTarget(null);
      await loadRecordings();
    } catch (requestError) {
      const duplicate = requestError?.response?.data?.code === "ALREADY_UPLOADED";
      if (duplicate) {
        toast.info("该录像已有新的 B站投稿任务，无需重复提交");
        setRepostTarget(null);
        await loadRecordings();
      } else {
        toast.error(errorMessage(requestError, "重新投稿失败"));
      }
    } finally {
      setIsReposting(false);
    }
  }

  async function changeCover(item, image) {
    setBusy(`cover:${item.id}`);
    try {
      await adminApi.post(`/recordings/${encodeURIComponent(item.id)}/cover`, image ? { image } : { next: Boolean(item.coverFile) });
      await loadRecordings();
      toast.success("封面已保存，上传时会用于 B站草稿");
    } catch (error) { toast.error(errorMessage(error, "封面生成失败")); }
    finally { setBusy(""); }
  }

  async function selectCover(item, file) {
    if (!file) return;
    if (file.size > 1400000) return toast.error("请选择小于 1.4 MB 的图片");
    const reader = new FileReader();
    reader.onload = () => changeCover(item, reader.result);
    reader.onerror = () => toast.error("图片读取失败");
    reader.readAsDataURL(file);
  }

  async function retryProcessing(item) {
    const key = `process:${item.id}`;
    setBusy(key);
    try {
      // Merging the full recording runs server-side for minutes; the default
      // 20s admin timeout would report a false failure mid-merge.
      await adminApi.post(`/recordings/${encodeURIComponent(item.id)}/process`, {}, { timeout: 600000 });
      toast.success(`“${item.title || item.id}”已重新整理为 MP4`);
      await loadRecordings();
    } catch (requestError) {
      toast.error(errorMessage(requestError, "录像整理失败，原始片段仍已保留"));
    } finally {
      setBusy((current) => (current === key ? "" : current));
    }
  }

  async function confirmDelete() {
    if (!deleteTarget) return;
    if (backupDeleteLocked(deleteTarget)) {
      toast.error("115备份任务正在使用文件或状态尚未确认，请取消备份并刷新后再删除");
      return;
    }
    const name = deleteTarget.title || deleteTarget.name || deleteTarget.id;
    setIsDeleting(true);
    try {
      const response = await adminApi.delete(deleteTarget.diskFile ? `/recordings/storage/${encodeURIComponent(deleteTarget.id)}` : `/recordings/${encodeURIComponent(deleteTarget.id)}`);
      if (playing?.id === deleteTarget.id) setPlaying(null);
      // A duplicate archive shares its replay cache with the other archive of the
      // same live; that file stays on disk and is reclaimed with its owner.
      const sharedKept = Array.isArray(response?.data?.data?.sharedFilesKept) ? response.data.data.sharedFilesKept.length : 0;
      toast.success(sharedKept
        ? `“${name}”已删除，另有 ${sharedKept} 个与其他归档共享的文件被保留`
        : `“${name}”的服务器录像文件已删除`);
      setDeleteTarget(null);
      await loadRecordings();
    } catch (requestError) {
      toast.error(errorMessage(requestError, "删除录像失败"));
    } finally {
      setIsDeleting(false);
    }
  }

  return (
    <div>
      <div className="page-header admin-page-header">
        <div>
          <h1>录像归档</h1>
        </div>
        <div className="archive-header-actions">
          <button
            type="button"
            className="btn btn-secondary btn-sm"
            onClick={loadRecordings}
            disabled={loading}
          >
            <IconRefresh size={13} className={loading ? "spinner" : ""} />
            <span>刷新归档</span>
          </button>
        </div>
      </div>

      {listError && (
        <div className="admin-alert error" role="alert">
          {listError}。页面保留上次成功加载的列表；恢复后会自动刷新。
        </div>
      )}

      {/* Summary Stat Cards */}
      <div className="grid-4" style={{ marginBottom: "24px" }}>
        <div className="stat-card">
          <span className="stat-kicker">
            <span>归档录像</span>
            <IconArchive size={16} />
          </span>
          <div className="stat-value">{recordings.length}</div>
          <div className="stat-label">磁盘实际 {diskFiles?.fileCount ?? "—"} 个文件 · {formatBytes(diskFiles?.totalBytes)}</div>
        </div>

        <div className="stat-card success">
          <span className="stat-kicker">
            <span>就绪可上传</span>
            <IconUpload size={16} color="var(--success)" />
          </span>
          <div className="stat-value">
            {
              recordings.filter(
                (item) =>
                  item.status === "done" &&
                  !isUploaded(item.uploadStatus) &&
                  !isUploadActive(item.uploadStatus)
              ).length
            }
          </div>
          <div className="stat-label">录制完成且未推送</div>
        </div>

        <div className="stat-card accent">
          <span className="stat-kicker">
            <span>草稿流程中</span>
            <IconUpload size={16} color="var(--accent-hover)" />
          </span>
          <div className="stat-value">
            {
              recordings.filter(
                (item) =>
                  isUploaded(item.uploadStatus) ||
                  isUploadActive(item.uploadStatus)
              ).length
            }
          </div>
          <div className="stat-label">已排队、上传或入草稿箱</div>
        </div>

        <div className="stat-card">
          <span className="stat-kicker">
            <span>可用磁盘</span>
            <IconHardDrive size={16} />
          </span>
          <div className="stat-value">{formatBytes(storage?.free)}</div>
          {storage && (
            <div style={{ marginTop: "4px" }}>
              <div
                role="progressbar"
                aria-label="磁盘已用空间"
                aria-valuenow={storage.usedPercent}
                style={{ width: "100%" }}
              >
                <ProgressBar
                  percent={storage.usedPercent}
                  tone={
                    storage.usedPercent > 90
                      ? "danger"
                      : storage.usedPercent > 75
                      ? "warning"
                      : "success"
                  }
                />
              </div>
              <div style={{ fontSize: "11px", color: "var(--text-dim)", marginTop: "4px" }}>
                总计 {formatBytes(storage.total)} · 已用 {storage.usedPercent}%
              </div>
            </div>
          )}
        </div>
      </div>

      {/* Online Video Player Card if selected */}
      {playing && (
        <section
          className="card archive-player-card"
          aria-labelledby="archive-player-title"
          style={{ marginBottom: "24px" }}
        >
          <div className="card-title-row archive-player-head">
            <div>
              <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
                <StatusBadge status="done">本地录像</StatusBadge>
                <h2 id="archive-player-title">
                  {playing.title || playing.name || playing.id}
                </h2>
              </div>
              <p>
                {playing.memberName || "Pocket48"} ·{" "}
                {formatDate(playing.createdAt || playing.startTime)} ·{" "}
                {formatBytes(playing.fileSize || playing.size)}
              </p>
            </div>
            <div style={{ display: "flex", gap: "8px" }}>
              <a
                className="btn btn-secondary btn-sm"
                href={recordingUrl(playing, "download")}
                target="_blank"
                rel="noreferrer"
              >
                <IconDownload size={13} />
                <span>下载文件</span>
              </a>
              <button
                type="button"
                className="btn btn-secondary btn-sm"
                onClick={() => setPlaying(null)}
              >
                <IconX size={13} />
                <span>关闭播放</span>
              </button>
            </div>
          </div>
          <div className="archive-player-media">
            <VideoPlayer
              key={playing.id}
              mode="replay"
              stream={{ type: mediaType(playing), proxyUrl: recordingUrl(playing) }}
              title={playing.title || playing.name || "本地录像"}
            />
          </div>
        </section>
      )}

      {coverTarget && <CoverPicker recording={coverTarget} onClose={() => setCoverTarget(null)} onSaved={loadRecordings} />}
      {/* Archive Table */}
      <section className="card">
        <div className="card-title-row">
          <div>
            <h2>全部归档列表</h2>
            <p>录像文件存储于私有服务目录，不会在公开页面暴露</p>
          </div>
          <div className="group-tabs-list">
            {[
              { key: "all", label: "全部" },
              { key: "ready", label: "可上传" },
              { key: "uploading", label: "上传中" },
              { key: "draft", label: "已进草稿" },
            ].map((item) => (
              <button
                key={item.key}
                type="button"
                className={`group-tab-btn ${filter === item.key ? "active" : ""}`}
                onClick={() => setFilter(item.key)}
              >
                {item.label}
              </button>
            ))}
          </div>
        </div>

        <div className="archive-pipeline-note">
          <IconLayers size={16} />
          <div>
            <strong>自动录制支持官方回放补全</strong>
            <span>断流后合并同场片段；结束时先下载官方回放，完整校验并对比后再替换和上传。失败则保留原录像，成功也保留原片备份。</span>
          </div>
        </div>
        <div className="cover-batch-toolbar"><button className="btn btn-secondary btn-sm" disabled={!selectedIds.length || !!busy || coverBatch?.status === "running"} onClick={regenerateSelected}>批量重新生成{selectedIds.length ? `（${selectedIds.length}）` : ""}</button><span className="muted">勾选未上传录像，按原封面 → 智能选帧 → 成员模板重新生成，最多 100 条。</span></div>
        {coverBatch?.status !== "idle" && coverBatch && <div className="cover-batch-status" role="status">{coverBatch.status === "running" ? "封面生成中" : "封面生成完成"} · 成功 {coverBatch.completed} / {coverBatch.total} · 跳过 {coverBatch.skipped} · 失败 {coverBatch.failed}{coverBatch.errors?.map(item => <span key={item.id}>{item.id}：{item.error}</span>)}</div>}
        {(busy.startsWith("process:") || busy.startsWith("upload:")) && (
          <div className="cover-batch-status" role="status">正在后台整理/校验，可能需要较长时间…</div>
        )}

        <Backup115Archive backup={backup115} recordings={filtered} selectedIds={backupSelectedIds} setSelectedIds={setBackupSelectedIds} disabled={isDeleting || Boolean(deleteTarget)} />

        {filtered.length > 0 ? (
          <div className="archive-list" role="list" aria-label="归档录像列表">
            <div className="archive-list-heading" aria-hidden="true">
              <span>共 {filtered.length} 条录像</span>
              <span>封面与标题 · 状态 · 文件信息 · 操作</span>
            </div>
            {filtered.map((item) => {
                  const ready = item.status === "done";
                  const uploadState = item.uploadStatus || "not_uploaded";
                  const uploaded = isUploaded(uploadState);
                  const active = isUploadActive(uploadState);
                  const uploading = busy === `upload:${item.id}`;
                  const retrying = busy === `process:${item.id}`;
                  const archiveFailed = item.status === "archive_failed";
                  const localConfirmation = ["failed", "kept_local"].includes(item.replayRecovery?.status);
                  // "重新投稿" means "the local archive was repaired after its
                  // B站 submission, so create a NEW draft and leave the old one
                  // alone". Only replay-audit repair records that history, so the
                  // button must key off replayAudit — replayRecovery alone is the
                  // ordinary replay replacement and never implies a prior upload.
                  const repairedArchive = item.replayRecovery?.status === "replaced";
                  const repostAllowed = item.replayAudit?.status === "repaired_local_published";
                  const canRepost = repostAllowed && repairedArchive && uploaded && !active;
                  const uploadDisabled =
                    !ready || replayWorking(item) || item.mediaType === "audio" || uploaded || active || uploading;
                  const deleteDisabled =
                    ["recording", "waiting_merge", "processing"].includes(item.status) ||
                    replayWorking(item) || active || backupDeleteLocked(item) ||
                    uploading;
                  const buttonText = item.mediaType === "audio" ? "音频请下载" : archiveFailed
                    ? retrying ? "整理中…" : "重试整理"
                    : uploading
                    ? mediaType(item) === "flv" ? "转MP4中…" : "加入中…"
                    : uploaded
                    ? "已在草稿箱"
                    : active
                    ? "已在队列"
                    : localConfirmation ? "使用本地录像投稿" : mediaType(item) === "flv" ? "转MP4并上传" : "送入B站草稿";

                  return (
                    <article className="archive-record-card" role="listitem" key={item.id}>
                      <div className="archive-record-select">
                        <input type="checkbox" aria-label={`选择录像 ${item.title || item.id}`} disabled={!ready || active || uploaded || !!item.draftId || coverBatch?.status === "running"} checked={selectedIds.includes(item.id)} onChange={e => setSelectedIds(ids => e.target.checked ? ids.length < 100 ? [...ids, item.id] : ids : ids.filter(id => id !== item.id))} />
                      </div>
                      <button
                        type="button"
                        className="file-mark recording-cover archive-record-cover"
                        onClick={() => playItem(item)}
                        disabled={!ready}
                        aria-label={`播放 ${item.title || item.name || item.id}`}
                        title={ready ? "在线播放录像" : "录像归档完成后可在线播放"}
                      >
                        <SafeImage src={item.coverFile ? `${recordingUrl(item, "cover")}?v=${item.coverFile}` : ""} alt="录像封面" fallback={<IconPlay size={18} />} />
                        {ready && <span className="archive-cover-play"><IconPlay size={14} /></span>}
                      </button>
                      <div className="archive-record-main">
                        <div className="archive-record-title-row">
                          <div className="archive-record-title-wrap">
                            <span className="archive-record-title">{item.title || item.name || item.id}</span>
                            <span className="source-chip">{item.source === "room_voice" ? "房间上麦" : item.source || "Pocket48"}</span>
                          </div>
                          <div className="archive-record-badges">
                            <StatusBadge status={item.status || "pending"}>{statusText[item.status] || item.status || "待处理"}</StatusBadge>
                            {uploadState === "not_uploaded" ? <span className="archive-upload-state muted">未上传</span> : <StatusBadge status={uploadState}>{statusText[uploadState] || uploadState}</StatusBadge>}
                          </div>
                        </div>
                        <div className="archive-record-meta">
                          <span>{item.segmentCount > 1 ? `MP4 · 已合并 ${item.segmentCount} 个片段` : item.duration ? `${Math.round(item.duration / 60)} 分钟` : item.fileName || (mediaType(item) === "mp4" ? "MP4 录像文件" : "FLV 原始片段")}</span>
                          <span><b>大小</b> {formatBytes(item.fileSize || item.size)}</span>
                          <span><b>录制</b> {formatDate(item.createdAt || item.startTime)}</span>
                          <span>{item.coverFile ? ({ original: "原直播封面", smart: "智能选帧", template: "成员模板", upload: "自定义上传" }[item.coverSource] || "旧版截图") : "暂无封面"}{item.coverSyncPending ? " · B站待同步" : ""}</span>
                          {ready && !active && (!uploaded || item.draftId) && <button type="button" className="btn btn-secondary btn-sm archive-cover-btn" disabled={Boolean(busy)} onClick={() => setCoverTarget(item)}>选择封面</button>}
                        </div>
                        <Backup115Card recording={item} backup={backup115} disabled={isDeleting || Boolean(deleteTarget)} selected={backupSelectedIds.includes(String(item.id))} onSelect={checked => setBackupSelectedIds(ids => checked ? ids.length < 100 ? [...new Set([...ids, String(item.id)])] : ids : ids.filter(id => id !== String(item.id)))} />
                        {item.replayRecovery && <p className={`archive-record-replay ${item.replayRecovery.status === "replaced" ? "" : "is-issue"}`} title={item.replayRecovery.message}>{item.replayRecovery.status === "replaced" ? "官方回放已替换 · 原录像备份已保留" : item.replayRecovery.message}</p>}
                      </div>
                      <div className="archive-record-actions">
                        {localConfirmation && ready && !uploaded && !active && <button type="button" className="btn btn-secondary btn-sm" disabled={Boolean(busy) || replayWorking(item)} onClick={() => retryReplay(item)}>{busy === `replay:${item.id}` ? "提交中…" : "重新核对官方回放"}</button>}
                        <div className="archive-action-row">
                          <button type="button" className="btn btn-secondary btn-sm" onClick={() => playItem(item)} disabled={!ready} title="在线播放"><IconPlay size={12} /><span>播放</span></button>
                          {ready ? <a className="btn btn-secondary btn-sm" href={recordingUrl(item, "download")} target="_blank" rel="noreferrer" title="下载到本地"><IconDownload size={12} /><span>下载</span></a> : <button type="button" className="btn btn-secondary btn-sm" disabled><IconDownload size={12} /><span>下载</span></button>}
                        </div>
                        {canRepost && <button type="button" className="btn btn-primary btn-sm archive-upload-button" onClick={() => setRepostTarget(item)} disabled={isReposting || Boolean(busy)} title="本地录像已由官方回放修复，创建新的 B站草稿，原投稿不变">
                          <IconUpload size={12} /><span>{isReposting && repostTarget?.id === item.id ? "提交中…" : "重新投稿"}</span>
                        </button>}
                        <button type="button" className={`btn ${archiveFailed ? "btn-secondary" : "btn-primary"} btn-sm archive-upload-button`} onClick={() => archiveFailed ? retryProcessing(item) : uploadDraft(item)} disabled={archiveFailed ? retrying : uploadDisabled} title={archiveFailed ? item.archiveError || "重新合并并转为 MP4" : uploaded ? "该录像已在 B站草稿箱中" : "送入 B站草稿箱"}>
                          {archiveFailed ? <IconRefresh size={12} className={retrying ? "spinner" : ""} /> : <IconUpload size={12} />}<span>{buttonText}</span>
                        </button>
                        <button type="button" className="text-button archive-delete-button" onClick={() => setDeleteTarget(item)} disabled={deleteDisabled} title="删除服务器录像文件"><IconTrash size={14} /><span>删除</span></button>
                      </div>
                    </article>
                  );
                })}
          </div>
        ) : (
          <EmptyState
            icon={IconArchive}
            title="没有符合条件的录像"
            detail="完成录制后，录像会自动进入归档列表。"
          />
        )}
      </section>

      <section className="card" style={{ marginTop: "24px" }}>
        <div className="card-title-row">
          <div>
            <h2>磁盘文件清单 · {diskFiles?.fileCount ?? "—"} 个文件</h2>
            <p>录像共占用 {formatBytes(diskFiles?.totalBytes)}，其中原始片段和遗留文件占用 {formatBytes(diskFiles?.extraBytes)}。按磁盘实际文件统计。</p>
          </div>
        </div>
        <div className="table-wrap"><table>
          <thead><tr><th>文件名称</th><th>用途</th><th className="td-num">实际大小</th><th>操作</th></tr></thead>
          <tbody>{(diskFiles?.files || []).map(file => <tr key={file.id}>
            <td style={{ overflowWrap: "anywhere" }}>{file.name}</td>
            <td>{{ main: "归档主文件", source: "保留的原始片段", residual: "已删除归档的残留", untracked: "未关联归档" }[file.kind]}</td>
            <td className="td-num">{formatBytes(file.size)}</td>
            <td>{file.kind === "main" ? <span className="muted">在归档列表中管理</span> : <button type="button" className="btn btn-secondary btn-sm" disabled={file.locked || backupDeleteLocked({ ...file, diskFile: true })} onClick={() => setDeleteTarget({ ...file, diskFile: true })}>{file.locked || backupDeleteLocked({ ...file, diskFile: true }) ? "使用中" : "清理文件"}</button>}</td>
          </tr>)}</tbody>
        </table></div>
      </section>

      <ConfirmModal
        isOpen={Boolean(repostTarget)}
        title="确认重新投稿？"
        description={repostTarget ? `“${repostTarget.title || repostTarget.name || repostTarget.id}”的本地录像已由官方回放修复。将创建一份新的 B站草稿，原有投稿保持不变。` : ""}
        confirmText="确认重新投稿"
        cancelText="取消"
        confirmType="primary"
        isLoading={isReposting}
        onConfirm={() => repostTarget && repostRepaired(repostTarget)}
        onCancel={() => !isReposting && setRepostTarget(null)}
      />

      {/* Delete Confirmation Modal */}
      <ConfirmModal
        isOpen={Boolean(deleteTarget)}
        title="确认删除录像文件？"
        description={`确定要永久删除服务器上的「${
          deleteTarget?.title || deleteTarget?.name || deleteTarget?.id
        }」${deleteTarget?.diskFile ? "文件" : "的主文件及所有保留的原始片段"}吗？此操作无法撤销，但不会删除已上传到 B站的草稿。`}
        confirmText="确认永久删除"
        cancelText="取消"
        confirmType="danger"
        isLoading={isDeleting}
        onConfirm={confirmDelete}
        onCancel={() => setDeleteTarget(null)}
      />
    </div>
  );
}
