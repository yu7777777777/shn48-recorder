import React, { useCallback, useMemo, useState } from "react";
import usePolling from "../hooks/usePolling";
import { StatusBadge } from "../components/Badge";
import ConfirmModal from "../components/ConfirmModal";
import EmptyState from "../components/EmptyState";
import {
  IconPlay,
  IconRadio,
  IconRefresh,
  IconSquare,
  IconTv,
  IconX,
} from "../components/Icons";
import SafeImage from "../components/SafeImage";
import { useToast } from "../components/Toast";
import VideoPlayer from "../components/VideoPlayer";
import { adminApi, errorMessage, listPayload, payload, publicApi } from "../lib/api";

function normalizeLive(item = {}) {
  const source = item.content || item.live || item;
  const user = source.userInfo || source.member || source.user || {};
  return {
    ...source,
    liveId: String(source.liveId ?? source.id ?? source.live_id ?? item.liveId ?? ""),
    title: source.title || source.liveTitle || "正在直播",
    memberName: user.nickname || user.name || source.memberName || source.nickname || "口袋48成员",
    avatar: user.avatar || user.avatarUrl || source.avatar || "",
    cover: source.cover || source.coverUrl || source.thumb || "",
    category: source.liveTypeName || source.category || source.typeName || source.liveType || "直播",
  };
}

export default function AdminLivePage() {
  const [lives, setLives] = useState([]);
  const [active, setActive] = useState([]);
  const [selected, setSelected] = useState(null);
  const [stream, setStream] = useState(null);
  const [busy, setBusy] = useState("");
  const [loading, setLoading] = useState(false);
  const [listError, setListError] = useState("");
  const [stopTarget, setStopTarget] = useState(null);
  const toast = useToast();

  const loadData = useCallback(async () => {
    setLoading(true);
    const [liveResult, activeResult] = await Promise.allSettled([
      publicApi.get("/live"),
      adminApi.get("/pocket48/recordings/active"),
    ]);
    if (liveResult.status === "fulfilled") {
      setListError("");
      setLives(
        listPayload(liveResult.value, ["liveList", "lives", "items", "content"])
          .map(normalizeLive)
          .filter((item) => item.liveId)
      );
    } else {
      // 请求失败时保留上次列表并明确提示，避免误显示成"当前没有直播"。
      setListError(errorMessage(liveResult.reason, "直播列表获取失败"));
    }
    if (activeResult.status === "fulfilled") {
      setActive(listPayload(activeResult.value, ["active", "recordings", "items"]));
    }
    setLoading(false);
  }, []);

  usePolling(loadData, 8000);

  const activeByLiveId = useMemo(
    () =>
      new Map(
        active.map((item) => [
          String(item.liveId ?? item.live_id ?? item.sourceId),
          item,
        ])
      ),
    [active]
  );

  async function watch(live, serverFallback = false) {
    setSelected(live);
    setStream(null);
    setBusy(`watch:${live.liveId}`);
    try {
      const response = await publicApi.get(
        `/live/${encodeURIComponent(live.liveId)}/play`,
        serverFallback ? { params: { fallback: "server" } } : undefined
      );
      const play = payload(response, {});
      setStream({
        ...play,
        type: play.protocol || play.type,
        proxyUrl: play.playUrl || play.proxyUrl || play.url,
      });
    } catch (requestError) {
      toast.error(errorMessage(requestError, "无法连接直播流"));
    } finally {
      setBusy("");
    }
  }

  async function startRecording(live) {
    setBusy(`record:${live.liveId}`);
    try {
      await adminApi.post("/pocket48/recordings/start", { liveId: live.liveId });
      toast.success(`已开始录制「${live.memberName}」的直播`);
      await loadData();
    } catch (requestError) {
      toast.error(errorMessage(requestError, "录制启动失败"));
    } finally {
      setBusy("");
    }
  }

  async function stopRecording(recording) {
    const recordingId = recording?.recordingId || recording?.id;
    if (!recordingId) {
      setStopTarget(null);
      return toast.error("未找到录制任务 ID，无法停止");
    }
    setBusy(`stop:${recordingId}`);
    try {
      await adminApi.post(`/pocket48/recordings/${encodeURIComponent(recordingId)}/stop`);
      toast.success("已停止录制，录像已转入归档");
      setStopTarget(null);
      await loadData();
    } catch (requestError) {
      toast.error(errorMessage(requestError, "停止录制失败"));
    } finally {
      setBusy("");
    }
  }

  return (
    <div>
      <div className="page-header admin-page-header">
        <div>
          <h1>直播管理</h1>
          <p>关闭播放器不会中断录制。</p>
        </div>
        <div className="archive-header-actions">
          {active.length > 0 && (
            <span className="badge badge-recording">
              <span className="recording-indicator" />
              {active.length} 个任务录制中
            </span>
          )}
          <button
            type="button"
            className="btn btn-secondary btn-sm"
            onClick={loadData}
            disabled={loading}
          >
            <IconRefresh size={13} className={loading ? "spinner" : ""} />
            <span>刷新状态</span>
          </button>
        </div>
      </div>

      {listError && (
        <div className="admin-alert error" role="alert">
          {listError}。页面保留上次成功加载的列表；恢复后会自动刷新。
        </div>
      )}

      {selected && (
        <section className="card archive-player-card" style={{ marginBottom: "24px" }}>
          <div className="card-title-row archive-player-head">
            <div>
              <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
                <StatusBadge status="recording">直播中</StatusBadge>
                <h2>{selected.title}</h2>
              </div>
              <p>
                {selected.memberName} · {selected.category}
              </p>
            </div>
            <button
              type="button"
              className="btn btn-secondary btn-sm"
              onClick={() => {
                setSelected(null);
                setStream(null);
              }}
            >
              <IconX size={14} />
              <span>关闭播放器</span>
            </button>
          </div>
          <div className="archive-player-media">
            {stream?.proxyUrl ? (
              <VideoPlayer
                stream={stream}
                poster={selected.cover}
                title={selected.title}
                onRetry={() => watch(selected)}
                onFallback={
                  stream.fallbackAvailable ? () => watch(selected, true) : undefined
                }
              />
            ) : (
              <div className="player-placeholder">
                {busy.startsWith("watch:") ? (
                  <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
                    <span className="spinner" />
                    <span>正在连接直播流…</span>
                  </div>
                ) : (
                  "直播地址暂不可用"
                )}
              </div>
            )}
          </div>
        </section>
      )}

      <section className="card">
        <div className="card-title-row">
          <div>
            <h2>当前直播 · {lives.length} 场</h2>
          </div>
        </div>

        {lives.length > 0 ? (
          <div className="admin-live-grid">
            {lives.map((live) => {
              const recording = activeByLiveId.get(live.liveId);
              return (
                <article
                  className={`admin-live-card ${recording ? "recording-active" : ""}`}
                  key={live.liveId}
                >
                  <div className="admin-live-cover">
                    <SafeImage
                      src={live.cover}
                      fallback={
                        <div className="cover-placeholder">
                          <span>{live.memberName.slice(0, 1)}</span>
                        </div>
                      }
                    />
                    <span className="live-pill">
                      <span className="live-pill-dot" /> LIVE
                    </span>
                  </div>
                  <div className="admin-live-body">
                    <div className="admin-live-title">
                      <div className="member-avatar small">
                        <SafeImage
                          src={live.avatar}
                          fallback={<span>{live.memberName.slice(0, 1)}</span>}
                        />
                      </div>
                      <div style={{ minWidth: 0, flex: 1 }}>
                        <strong>{live.title}</strong>
                        <span>
                          {live.memberName} · {live.category}
                        </span>
                      </div>
                    </div>

                    <div className="admin-live-actions">
                      <button
                        type="button"
                        className="btn btn-secondary"
                        onClick={() => watch(live)}
                        disabled={busy === `watch:${live.liveId}`}
                      >
                        <IconPlay size={14} />
                        <span>{busy === `watch:${live.liveId}` ? "连接中…" : "观看"}</span>
                      </button>

                      {recording ? (
                        <button
                          type="button"
                          className="btn btn-danger"
                          onClick={() => setStopTarget(recording)}
                          disabled={busy === `stop:${recording.recordingId || recording.id}`}
                        >
                          <IconSquare size={14} />
                          <span>
                            {busy === `stop:${recording.recordingId || recording.id}`
                              ? "停止中…"
                              : "停止录制"}
                          </span>
                        </button>
                      ) : (
                        <button
                          type="button"
                          className="btn btn-primary"
                          onClick={() => startRecording(live)}
                          disabled={busy === `record:${live.liveId}`}
                        >
                          <IconRadio size={14} />
                          <span>
                            {busy === `record:${live.liveId}` ? "启动中…" : "开始录制"}
                          </span>
                        </button>
                      )}
                    </div>

                    {recording && (
                      <div className="recording-strip">
                        <span className="recording-indicator" />
                        <span>
                          录制中 · {recording.outputName || recording.name || "正在写入录像文件"}
                        </span>
                      </div>
                    )}
                  </div>
                </article>
              );
            })}
          </div>
        ) : (
          <EmptyState
            icon={IconTv}
            title="当前没有正在进行的直播"
            detail="系统每 8 秒自动轮询，成员开播后即可随时在此点击录制或在线观看。"
          />
        )}
      </section>

      <ConfirmModal
        isOpen={Boolean(stopTarget)}
        title="确认停止录制？"
        description="停止后本场直播剩余部分不再录制，已录片段将转入归档合并。"
        confirmText="确认停止录制"
        cancelText="取消"
        confirmType="danger"
        isLoading={busy === `stop:${stopTarget?.recordingId || stopTarget?.id}`}
        onConfirm={() => stopRecording(stopTarget)}
        onCancel={() => setStopTarget(null)}
      />
    </div>
  );
}
