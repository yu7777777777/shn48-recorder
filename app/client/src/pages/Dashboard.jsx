import React, { useCallback, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { StatusBadge } from "../components/Badge";
import EmptyState from "../components/EmptyState";
import {
  IconActivity,
  IconArchive,
  IconArrowRight,
  IconClock,
  IconHardDrive,
  IconRadio,
  IconRefresh,
  IconTv,
  IconUpload,
} from "../components/Icons";
import ProgressBar from "../components/ProgressBar";
import usePolling from "../hooks/usePolling";
import { adminApi, listPayload, payload, publicApi } from "../lib/api";

// Admin pages follow the browser language the same way the public pages do.
export function languageOf(languages) {
  const first = Array.isArray(languages) ? languages[0] : languages;
  return typeof first === "string" && /^en\b/i.test(first) ? "en" : "zh";
}
const TEXT = {
  zh: {
    title: "系统总览", refresh: "刷新",
    requests: { health: "系统健康", recordings: "归档录像", active: "活动录制", lives: "公开直播", uploadQueue: "B站队列" },
    status: { pending: "同步中", failed: "数据暂不可用", warning: "部分异常", healthy: "运行正常" },
    live: { heading: "当前公开直播", empty: "口袋48直播", none: "当前无正在录制的任务", guide: "成员开播后可在「直播管理」手动录制，或配置「自动录制」监控。" },
    recording: { heading: "正在录制监视", hint: "录制任务在后台独立运行，关闭页面不会中断录制", manage: "直播管理", writing: "正在写入本地录像" },
    stats: { uploadQueue: "B站待上传队列", archived: "已归档录像", activeRecordings: "正在录制任务" },
    archive: { heading: "最近归档录像", all: "全部归档", empty: "暂无归档录像", 
      columns: { name: "录像名称", source: "来源渠道", status: "录制状态", when: "录制时间", size: "文件体积" }, statuses: { archived: "已归档", archiving: "归档中", waiting: "等待续播", failed: "整理失败", pending: "待处理" }, badge: "录制中" },
    service: { heading: "服务运行概况", uptime: "服务在线时长", used: "录像占用空间", free: "可用磁盘空间", usage: "磁盘使用率" },
    error: "暂时无法读取总览数据，请稍后刷新。",
  },
  en: {
    title: "Overview", refresh: "Refresh",
    requests: { health: "Service health", recordings: "Archived recordings", active: "Active recordings", lives: "Public lives", uploadQueue: "Bilibili queue" },
    status: { pending: "Syncing", failed: "Data unavailable", warning: "Partly degraded", healthy: "Running normally" },
    live: { heading: "Live on air", empty: "Pocket48 lives", none: "Nothing is being recorded", guide: "Start a recording from Live management once a member goes on air, or enable auto record monitoring." },
    recording: { heading: "Recording monitor", hint: "Recording runs in the background and keeps going if you close this page", manage: "Live management", writing: "Writing local video" },
    stats: { uploadQueue: "Bilibili upload queue", archived: "Archived recordings", activeRecordings: "Active recordings" },
    archive: { heading: "Recent archives", all: "All archives", empty: "No archived recordings yet", 
      columns: { name: "Recording", source: "Source", status: "Status", when: "Recorded at", size: "Size" }, statuses: { archived: "Archived", archiving: "Archiving", waiting: "Waiting to resume", failed: "Cleanup failed", pending: "Pending" }, badge: "Recording" },
    service: { heading: "Service and storage", uptime: "Uptime", used: "Recording storage used", free: "Free disk space", usage: "Disk usage" },
    error: "Could not load the overview. Try refreshing later.",
  },
};
function texts(languages) {
  if (languages !== undefined) return TEXT[languageOf(languages)];
  return TEXT[languageOf(typeof navigator === "undefined" ? "zh" : navigator.languages || navigator.language)];
}
const DASHBOARD_REQUESTS = [
  { key: "health", label: "health" },
  { key: "recordings", label: "recordings" },
  { key: "active", label: "active" },
  { key: "lives", label: "lives" },
  { key: "uploadQueue", label: "uploadQueue" },
];

export function getDashboardStatus(requestStatus, languages) {
  const t = texts(languages);
  const failedRequests = requestStatus
    ? DASHBOARD_REQUESTS.filter(({ key }) => requestStatus[key] !== "fulfilled")
    : [];
  const status = !requestStatus
    ? { badge: "pending", label: t.status.pending }
    : failedRequests.length === DASHBOARD_REQUESTS.length
    ? { badge: "failed", label: t.status.failed }
    : failedRequests.length > 0
    ? { badge: "warning", label: t.status.warning }
    : { badge: "healthy", label: t.status.healthy };
  return { ...status, failedRequests };
}

// GET /recordings reports how many rows match the filters in meta.total,
// counted before the limit truncates the list. Older backends omit meta;
// callers then fall back to counting the truncated preview list.
export function recordingsMetaTotal(response) {
  const raw = response?.data?.meta?.total;
  if (raw === undefined || raw === null || raw === "") return null;
  const total = Number(raw);
  return Number.isFinite(total) && total >= 0 ? total : null;
}

function formatBytes(bytes) {
  if (!Number.isFinite(Number(bytes)) || Number(bytes) <= 0) return "—";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let value = Number(bytes);
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(unit > 1 ? 1 : 0)} ${units[unit]}`;
}

function formatTime(value) {
  if (!value) return "—";
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? "—"
    : date.toLocaleString("zh-CN", { hour12: false });
}

export default function DashboardPage() {
  const [health, setHealth] = useState({});
  const [recordings, setRecordings] = useState([]);
  const [doneTotal, setDoneTotal] = useState(null);
  const [recordingTotal, setRecordingTotal] = useState(null);
  const [active, setActive] = useState([]);
  const [lives, setLives] = useState([]);
  const [uploadQueue, setUploadQueue] = useState([]);
  const [loading, setLoading] = useState(false);
  const [requestStatus, setRequestStatus] = useState(null);

  const loadData = useCallback(async () => {
    setLoading(true);
    // The archived count must come from a status-filtered meta.total: the
    // preview request below caps at 10 rows and its total counts every status.
    // Kept outside Promise.allSettled so the five-panel status contract of
    // getDashboardStatus stays unchanged; a failure falls back to the count.
    const doneCountRequest = adminApi
      .get("/recordings", { params: { limit: 1, status: "done" } })
      .then((response) => setDoneTotal(recordingsMetaTotal(response)))
      .catch(() => setDoneTotal(null));
    const results = await Promise.allSettled([
      adminApi.get("/health"),
      adminApi.get("/recordings", { params: { limit: 10 } }),
      adminApi.get("/pocket48/recordings/active"),
      publicApi.get("/live"),
      adminApi.get("/bilibili/queue"),
    ]);
    setRequestStatus(
      Object.fromEntries(
        DASHBOARD_REQUESTS.map(({ key }, index) => [key, results[index].status])
      )
    );
    if (results[0].status === "fulfilled") setHealth(payload(results[0].value, {}));
    if (results[1].status === "fulfilled") {
      setRecordings(listPayload(results[1].value, ["recordings", "items"]));
      setRecordingTotal(recordingsMetaTotal(results[1].value));
    }
    if (results[2].status === "fulfilled")
      setActive(listPayload(results[2].value, ["active", "recordings", "items"]));
    if (results[3].status === "fulfilled")
      setLives(listPayload(results[3].value, ["liveList", "lives", "items", "content"]));
    if (results[4].status === "fulfilled")
      setUploadQueue(listPayload(results[4].value, ["queue", "items"]));
    await doneCountRequest;
    setLoading(false);
  }, []);

  usePolling(loadData, 10000);

  // meta.total from the status:"done" probe is authoritative; without it
  // (older backend or failed request) count the ≤10 preview rows as before.
  const completed = useMemo(
    () => doneTotal ?? recordings.filter((item) => item.status === "done").length,
    [doneTotal, recordings]
  );
  const queued = useMemo(
    () =>
      uploadQueue.filter((item) => ["queued", "uploading"].includes(item.status))
        .length,
    [uploadQueue]
  );

  const storageUsedPercent = health.storage?.usedPercent || 0;
  const t = texts();
  const { failedRequests, ...dashboardStatus } = getDashboardStatus(requestStatus);

  return (
    <div>
      <div className="page-header admin-page-header">
        <div>
          <h1>{t.title}</h1>
        </div>
        <div className="archive-header-actions">
          <button
            type="button"
            className="btn btn-secondary btn-sm"
            onClick={loadData}
            disabled={loading}
          >
            <IconRefresh size={13} className={loading ? "spinner" : ""} />
            <span>{t.refresh}</span>
          </button>
        </div>
      </div>

      {/* 4 Key Stat Cards */}
      <div className="grid-4" style={{ marginBottom: "24px" }}>
        <div className="stat-card">
          <span className="stat-kicker">
            <span>{t.live.heading}</span>
            <IconTv size={16} color="var(--accent-hover)" />
          </span>
          <div className="stat-value">{lives.length}</div>
        </div>

        <div className="stat-card danger">
          <span className="stat-kicker">
            <span>{t.stats.activeRecordings}</span>
            <IconRadio size={16} color="var(--danger)" />
          </span>
          <div className={`stat-value${active.length > 0 ? " is-active" : ""}`}>
            {active.length}
          </div>
        </div>

        <div className="stat-card success">
          <span className="stat-kicker">
            <span>{t.archive.all}</span>
            <IconArchive size={16} color="var(--success)" />
          </span>
          <div className="stat-value">{completed}</div>
          <div className="stat-label">共计 {recordingTotal ?? recordings.length} 条归档记录</div>
        </div>

        <div className="stat-card accent">
          <span className="stat-kicker">
            <span>{t.stats.uploadQueue}</span>
            <IconUpload size={16} color="var(--accent-hover)" />
          </span>
          <div className="stat-value">{queued}</div>
        </div>
      </div>

      {/* Middle 2 Cards: Active Recordings & System Health */}
      <div className="grid-2" style={{ marginBottom: "24px" }}>
        <section className="card">
          <div className="card-title-row">
            <div>
              <h2>{t.recording.heading}</h2>
              <p>{t.recording.hint}</p>
            </div>
            <Link className="text-link" to="/admin/live">
              <span>直播管理</span>
              <IconArrowRight size={14} />
            </Link>
          </div>
          {active.length > 0 ? (
            active.map((item) => (
              <div
                className="activity-row"
                key={item.id || item.recordingId || item.liveId}
              >
                <span className="recording-indicator" />
                <div>
                  <strong>
                    {item.name || item.title || item.memberName || "口袋48直播"}
                  </strong>
                  <span>{formatTime(item.startedAt || item.startTime)} 开播录制</span>
                </div>
              </div>
            ))
          ) : (
            <EmptyState
              icon={IconRadio}
              title="当前无正在录制的任务"
            />
          )}
        </section>

        <section className="card">
          <div className="card-title-row">
            <div>
              <h2>{t.service.heading}</h2>
            </div>
            <StatusBadge status={dashboardStatus.badge}>
              {dashboardStatus.label}
            </StatusBadge>
          </div>
          {failedRequests.length > 0 && (
            <p
              role="status"
              style={{
                margin: "0 0 14px",
                color: dashboardStatus.badge === "failed" ? "var(--danger)" : "var(--text-muted)",
                fontSize: "12px",
              }}
            >
              {dashboardStatus.badge === "failed"
                ? "暂时无法读取总览数据，请稍后刷新。"
                : `暂时无法读取：${failedRequests.map(({ label }) => label).join("、")}`}
            </p>
          )}
          <dl className="health-list">
            <div>
              <dt style={{ display: "flex", alignItems: "center", gap: "6px" }}>
                <IconClock size={15} />
                <span>{t.service.uptime}</span>
              </dt>
              <dd>
                {health.uptime ? `${Math.floor(health.uptime / 3600)} 小时` : "—"}
              </dd>
            </div>
            <div>
              <dt style={{ display: "flex", alignItems: "center", gap: "6px" }}>
                <IconArchive size={15} />
                <span>{t.service.used}</span>
              </dt>
              <dd>{formatBytes(health.recordingsSize)}</dd>
            </div>
            <div>
              <dt style={{ display: "flex", alignItems: "center", gap: "6px" }}>
                <IconHardDrive size={15} />
                <span>{t.service.free}</span>
              </dt>
              <dd>{formatBytes(health.diskFree || health.storage?.free)}</dd>
            </div>
          </dl>
          {health.storage && (
            <div style={{ marginTop: "16px" }}>
              <div
                style={{
                  display: "flex",
                  justifyContent: "space-between",
                  fontSize: "11px",
                  color: "var(--text-muted)",
                  marginBottom: "6px",
                }}
              >
                <span>{t.service.usage}</span>
                <span>{Number(storageUsedPercent).toFixed(1)}%</span>
              </div>
              <ProgressBar
                percent={storageUsedPercent}
                tone={
                  storageUsedPercent > 90
                    ? "danger"
                    : storageUsedPercent > 75
                    ? "warning"
                    : "success"
                }
              />
            </div>
          )}
        </section>
      </div>

      {/* Recent Archive Table */}
      <section className="card">
        <div className="card-title-row">
          <div>
            <h2>{t.archive.heading}</h2>
          </div>
          <Link className="text-link" to="/admin/archive">
            <span>{t.archive.all}</span>
            <IconArrowRight size={14} />
          </Link>
        </div>
        {recordings.length > 0 ? (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>{t.archive.columns.name}</th>
                  <th>{t.archive.columns.source}</th>
                  <th>{t.archive.columns.status}</th>
                  <th>{t.archive.columns.when}</th>
                  <th>{t.archive.columns.size}</th>
                </tr>
              </thead>
              <tbody>
                {recordings.slice(0, 6).map((item) => (
                  <tr key={item.id}>
                    <td style={{ fontWeight: 600, color: "var(--text-main)" }}>
                      {item.title || item.name || item.id}
                    </td>
                    <td>
                      <span className="source-chip">{item.source || "Pocket48"}</span>
                    </td>
                    <td>
                      <StatusBadge status={item.status || "pending"}>
                        {item.status === "done"
                          ? "已归档"
                          : item.status === "processing"
                          ? "归档中"
                          : item.status === "waiting_merge"
                          ? "等待续播"
                          : item.status === "archive_failed"
                          ? "整理失败"
                          : item.status || "待处理"}
                      </StatusBadge>
                    </td>
                    <td>{formatTime(item.createdAt || item.startTime)}</td>
                    <td className="td-num">
                      {formatBytes(item.fileSize || item.size)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <EmptyState
            icon={IconArchive}
            title="暂无归档录像"
          />
        )}
      </section>
    </div>
  );
}
