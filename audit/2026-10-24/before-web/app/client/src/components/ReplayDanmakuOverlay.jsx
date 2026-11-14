import React, { useEffect, useMemo, useRef, useState } from "react";
import { IconClock, IconMessageSquare } from "./Icons";
import { publicApi, payload } from "../lib/api";
import { safeLiveId } from "../lib/danmaku";
import { normalizeReplayDanmakuList, replayDanmakuAt } from "../lib/replayDanmaku";

const PANEL_MESSAGE_LIMIT = 30;

function formatTime(atMs) {
  const totalSeconds = Math.max(0, Math.floor(Number(atMs || 0) / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  return hours > 0
    ? `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`
    : `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
}

export default function ReplayDanmakuOverlay({ replayId, videoRef, available = true }) {
  const normalizedReplayId = safeLiveId(replayId);
  const [enabled, setEnabled] = useState(false);
  const [status, setStatus] = useState(available === false ? "unavailable" : "idle");
  const [records, setRecords] = useState([]);
  const [currentMs, setCurrentMs] = useState(0);
  const [offsetMs, setOffsetMs] = useState(0);
  const [density, setDensity] = useState("normal");
  const listRef = useRef(null);

  useEffect(() => {
    setEnabled(false);
    setRecords([]);
    setCurrentMs(0);
    setOffsetMs(0);
    setDensity("normal");
    setStatus(available === false ? "unavailable" : "idle");
  }, [normalizedReplayId, available]);

  useEffect(() => {
    const video = videoRef?.current;
    if (!video) return undefined;
    const syncTime = () => setCurrentMs(Math.max(0, Math.round(video.currentTime * 1000)));
    syncTime();
    video.addEventListener("loadedmetadata", syncTime);
    video.addEventListener("timeupdate", syncTime);
    video.addEventListener("seeking", syncTime);
    video.addEventListener("seeked", syncTime);
    return () => {
      video.removeEventListener("loadedmetadata", syncTime);
      video.removeEventListener("timeupdate", syncTime);
      video.removeEventListener("seeking", syncTime);
      video.removeEventListener("seeked", syncTime);
    };
  }, [videoRef, normalizedReplayId]);

  useEffect(() => {
    if (!enabled || !normalizedReplayId || available === false || status !== "idle") return undefined;
    let active = true;
    setStatus("loading");
    publicApi.get(`/replays/${encodeURIComponent(normalizedReplayId)}/danmaku`, { timeout: 20000 })
      .then(response => {
        if (!active) return;
        const body = payload(response, {});
        const nextRecords = normalizeReplayDanmakuList(body?.list);
        setRecords(nextRecords);
        setStatus(nextRecords.length ? "ready" : "empty");
      })
      .catch(error => {
        if (!active) return;
        setStatus(error?.response?.status === 404 ? "unavailable" : "error");
      });
    return () => { active = false; };
  }, [enabled, normalizedReplayId, available]);

  const visibleRecords = useMemo(() => {
    if (!enabled || status !== "ready") return [];
    const limit = density === "low" ? 10 : density === "high" ? 60 : PANEL_MESSAGE_LIMIT;
    return replayDanmakuAt(records, Math.max(0, currentMs + offsetMs), limit);
  }, [enabled, status, records, currentMs, offsetMs, density]);

  useEffect(() => {
    const list = listRef.current;
    if (!list || !visibleRecords.length) return undefined;
    const frame = window.requestAnimationFrame(() => { list.scrollTop = list.scrollHeight; });
    return () => window.cancelAnimationFrame(frame);
  }, [visibleRecords]);

  if (!normalizedReplayId) return null;
  const disabled = status === "unavailable" || status === "empty";
  const label = status === "loading" ? "加载中…" : disabled ? "暂无弹幕" : enabled ? "关闭弹幕" : "开启弹幕";
  const toggle = () => {
    if (disabled) return;
    setEnabled(current => {
      if (!current && status === "error") setStatus("idle");
      return !current;
    });
  };

  return (
    <aside className="replay-danmaku-panel" aria-label="重播弹幕">
      <header className="replay-danmaku-head">
        <div>
          <div style={{ display: "flex", alignItems: "center", gap: "6px" }}>
            <IconMessageSquare size={14} color="var(--accent-hover)" />
            <strong>时间轴弹幕</strong>
          </div>
          <span>{status === "ready" ? `共 ${records.length} 条弹幕` : "跟随播放进度同步"}</span>
        </div>
        <button
          type="button"
          className={`replay-danmaku-toggle ${enabled && status === "ready" ? "active" : ""}`}
          aria-pressed={enabled}
          disabled={disabled}
          onClick={toggle}
        >
          {label}
        </button>
      </header>
      <div className="replay-danmaku-settings">
        <label>密度
          <select value={density} onChange={event => setDensity(event.target.value)} aria-label="弹幕密度">
            <option value="low">清爽</option>
            <option value="normal">标准</option>
            <option value="high">丰富</option>
          </select>
        </label>
      </div>
      <div ref={listRef} className="replay-danmaku-list" aria-live="polite">
        {!enabled && !disabled && (
          <div className="replay-danmaku-empty">
            <IconMessageSquare size={28} color="var(--text-dim)" />
            <strong>弹幕已关闭</strong>
            <span>开启后在此查看跟随时间轴同步的弹幕</span>
          </div>
        )}
        {status === "loading" && (
          <div className="replay-danmaku-empty">
            <span className="spinner" />
            <strong>正在加载弹幕</strong>
          </div>
        )}
        {status === "error" && (
          <div className="replay-danmaku-empty error">
            <strong>弹幕加载失败</strong>
            <span>关闭后重新开启即可重试</span>
          </div>
        )}
        {disabled && (
          <div className="replay-danmaku-empty">
            <strong>该重播暂无弹幕</strong>
          </div>
        )}
        {enabled && status === "ready" && !visibleRecords.length && (
          <div className="replay-danmaku-empty">
            <strong>当前进度暂无弹幕</strong>
            <span>继续播放或拖动进度条</span>
          </div>
        )}
        {visibleRecords.map((message) => (
          <article key={message.id} className="replay-danmaku-item" role="button" tabIndex="0" onClick={() => { if (videoRef?.current) videoRef.current.currentTime = Math.max(0, Number(message.atMs || 0) / 1000 - offsetMs / 1000); }} onKeyDown={event => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); if (videoRef?.current) videoRef.current.currentTime = Math.max(0, Number(message.atMs || 0) / 1000 - offsetMs / 1000); } }}>
            <div>
              <strong>{message.nickname}</strong>
              <time>{formatTime(message.atMs)}</time>
            </div>
            <p>{message.text}</p>
          </article>
        ))}
      </div>
      <div className="replay-danmaku-offset"><label>同步偏移 <output>{(offsetMs / 1000).toFixed(1)}s</output></label><input type="range" min="-3000" max="3000" step="100" value={offsetMs} onChange={event => setOffsetMs(Number(event.target.value))} aria-label="弹幕同步偏移" /></div>
      <footer className="replay-danmaku-foot">
        <span style={{ display: "flex", alignItems: "center", gap: "4px" }}>
          <IconClock size={12} />
          <span>当前进度</span>
        </span>
        <time>{formatTime(currentMs)}</time>
      </footer>
    </aside>
  );
}
