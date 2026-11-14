import React, { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { IconMessageSquare } from "./Icons";
import { normalizeDanmakuMessage, safeLiveId } from "../lib/danmaku";

const MAX_VISIBLE_MESSAGES = 36;

export default function DanmakuOverlay({ liveId, stage }) {
  const normalizedLiveId = safeLiveId(liveId);
  const [enabled, setEnabled] = useState(false);
  const [status, setStatus] = useState("idle");
  const [messages, setMessages] = useState([]);
  const [history, setHistory] = useState([]);
  const listRef = useRef(null);
  const followRef = useRef(true);
  useEffect(() => {
    if (followRef.current && listRef.current) listRef.current.scrollTop = listRef.current.scrollHeight;
  }, [history]);
  const sequenceRef = useRef(0);
  const seenRef = useRef(new Set());

  useEffect(() => {
    if (!enabled || !normalizedLiveId) return undefined;
    let active = true;
    const source = new EventSource(`/api/public/live/${encodeURIComponent(normalizedLiveId)}/danmaku`);
    setStatus("connecting");

    function handleStatus(event) {
      try {
        const next = JSON.parse(event.data);
        if (active && ["connecting", "connected", "error"].includes(next?.status)) {
          setStatus(next.status);
        }
      } catch {}
    }

    function handleMessage(event) {
      if (!active) return;
      try {
        const message = normalizeDanmakuMessage(JSON.parse(event.data));
        if (!message || seenRef.current.has(message.id)) return;
        seenRef.current.add(message.id);
        if (seenRef.current.size > 500) {
          seenRef.current.delete(seenRef.current.values().next().value);
        }
        setHistory(current => [...current, message].slice(-300));
        const sequence = sequenceRef.current++;
        const visible = {
          ...message,
          sequence,
          lane: sequence % 7,
          duration: Math.min(13, 8 + message.text.length / 18),
        };
        setMessages((current) => [...current, visible].slice(-MAX_VISIBLE_MESSAGES));
      } catch {}
    }

    source.addEventListener("status", handleStatus);
    source.addEventListener("danmaku", handleMessage);
    source.onerror = () => {
      if (active) setStatus(source.readyState === EventSource.CLOSED ? "error" : "connecting");
    };
    return () => {
      active = false;
      source.close();
      setStatus("idle");
      setMessages([]);

    };
  }, [enabled, normalizedLiveId]);

  if (!normalizedLiveId) return null;
  const label =
    status === "connecting"
      ? "连接弹幕中…"
      : enabled
      ? "弹幕已开启"
      : "开启弹幕";

  return (
    <>
      <aside className="replay-danmaku-panel" aria-label="直播弹幕">
        <header className="replay-danmaku-head"><strong>实时弹幕</strong><span>{history.length} 条</span></header>
        <div className="replay-danmaku-list" ref={listRef} onScroll={event => { const el = event.currentTarget; followRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 48; }}>
          {!history.length && <div className="replay-danmaku-empty"><strong>{!enabled ? "弹幕已关闭" : status === "error" ? "弹幕连接失败" : status === "connecting" ? "正在连接弹幕…" : "暂未收到弹幕"}</strong><span>{!enabled ? "点击视频右上角开启弹幕" : "收到的新弹幕会在此显示"}</span></div>}
          {history.map(message => <article key={message.id} className="replay-danmaku-item"><div><strong>{message.nickname}{message.member ? " · 成员" : ""}</strong></div><p>{message.text}</p></article>)}
        </div>
        <footer className="replay-danmaku-foot" role="status">{!enabled ? "已暂停接收" : status === "error" ? "连接失败，请关闭后重新开启" : status === "connecting" ? "正在连接…" : "已连接，等待实时弹幕"} · 保留最近 300 条</footer>
      </aside>
      {stage && createPortal(<>
      <div className="danmaku-control">
        <button
          type="button"
          className={`danmaku-toggle ${enabled ? "active" : ""}`}
          aria-pressed={enabled}
          onClick={() => setEnabled((value) => !value)}
        >
          <IconMessageSquare size={13} />
          <span>{label}</span>
        </button>
        {status === "error" && (
          <span className="badge badge-failed" role="status">
            弹幕服务离线
          </span>
        )}
      </div>
      {enabled && (
        <div className="danmaku-layer" aria-hidden="true">
          {messages.map((message) => (
            <span
              key={`${message.id}:${message.sequence}`}
              className={`danmaku-message ${message.member ? "member" : ""}`}
              style={{
                "--danmaku-lane": message.lane,
                "--danmaku-duration": `${message.duration}s`,
              }}
            >
              <b>{message.nickname}</b>：{message.text}
            </span>
          ))}
        </div>
      )}
      </>, stage)}
    </>
  );
}
