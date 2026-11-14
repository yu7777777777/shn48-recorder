import React, { useEffect, useRef, useState } from "react";
import "./TimelineEditor.css";

export function stamp(t) {
  const tenths = Math.round(Math.max(0, Number(t) || 0) * 10);
  const s = Math.floor(tenths / 10);
  return `${[Math.floor(s / 3600), Math.floor(s / 60) % 60, s % 60].map(n => String(n).padStart(2, "0")).join(":")}.${tenths % 10}`;
}
export function validSegments(segments, duration) {
  return segments.length > 0 && segments.length <= 30 && segments.every((s, i) => Number.isFinite(s.start) && Number.isFinite(s.end) && s.start >= 0 && s.end <= duration + .05 && s.end - s.start >= 1 && (!i || s.start >= segments[i - 1].end)) && segments.reduce((n, s) => n + s.end - s.start, 0) <= 7200;
}

export default function TimelineEditor({ duration, position, video, busy, onExport, defaultTitle, suggestedRange }) {
  const [segments, setSegments] = useState([]);
  const [selected, setSelected] = useState(0);
  const [zoom, setZoom] = useState(1);
  const [title, setTitle] = useState("");
  const [history, setHistory] = useState([]);
  const [previewing, setPreviewing] = useState(false);
  const [hint, setHint] = useState("");
  const [trackWidth, setTrackWidth] = useState(900);
  const timeline = useRef(null);
  const drag = useRef(null);
  const initial = useRef(false);
  const preview = useRef(null);
  const selectedRange = segments[selected];
  const total = segments.reduce((sum, s) => sum + s.end - s.start, 0);
  const valid = validSegments(segments, duration);
  const ticks = Math.max(2, Math.floor(trackWidth / 110)) * zoom;
  useEffect(() => {
    if (!suggestedRange || !validSegments([suggestedRange], duration)) return;
    commit([{start:suggestedRange.start,end:suggestedRange.end}]); setSelected(0); setTitle(suggestedRange.title || '');
    setHint('已用建议片段替换保留范围；可撤销或继续调整后导出');
    timeline.current?.scrollIntoView({behavior:'smooth',block:'center'});
  }, [suggestedRange]);
  useEffect(() => {
    const el = timeline.current?.parentElement;
    if (!el) return;
    const observer = new ResizeObserver(() => setTrackWidth(el.clientWidth));
    observer.observe(el);
    return () => observer.disconnect();
  }, []);
  useEffect(() => {
    if (duration >= 1 && !initial.current) { initial.current = true; setSegments([{ start: 0, end: Math.floor(duration * 100) / 100 }]); }
  }, [duration]);
  useEffect(() => {
    const v = video.current;
    if (!v || !duration) return;
    const update = () => {
      const p = preview.current;
      if (!p) return;
      if (v.currentTime >= p.ranges[p.index].end - .015 || v.ended) {
        if (++p.index < p.ranges.length) { v.currentTime = p.ranges[p.index].start; v.play().catch(stopPreview); }
        else { v.pause(); preview.current = null; setPreviewing(false); }
      }
    };
    const interval = setInterval(update, 40);
    v.addEventListener("ended", update);
    return () => { clearInterval(interval); v.removeEventListener("ended", update); preview.current = null; };
  }, [duration, video]);
  function stopPreview() { preview.current = null; setPreviewing(false); video.current?.pause(); }
  function seek(value) { stopPreview(); if (video.current) video.current.currentTime = Math.max(0, Math.min(duration, value)); }
  function commit(next) { stopPreview(); setHistory(h => [...h.slice(-49), segments.map(s => ({ ...s }))]); setSegments(next); setHint(""); }
  function undo() { if (!history.length) return; stopPreview(); setSegments(history.at(-1)); setHistory(h => h.slice(0, -1)); setSelected(0); }
  function updateBoundary(edge, value, remember = true) {
    if (!selectedRange || !Number.isFinite(value)) return;
    const i = selected;
    const min = edge === "start" ? (segments[i - 1]?.end || 0) : selectedRange.start + 1;
    const max = edge === "start" ? selectedRange.end - 1 : (segments[i + 1]?.start ?? duration);
    const next = segments.map((s, j) => j === i ? { ...s, [edge]: Math.round(Math.max(min, Math.min(max, value)) * 100) / 100 } : s);
    if (remember) commit(next); else setSegments(next);
  }
  function pointerTime(event) {
    const rect = timeline.current.getBoundingClientRect();
    return Math.max(0, Math.min(duration, (event.clientX - rect.left) / rect.width * duration));
  }
  function beginDrag(event, i, edge) {
    event.preventDefault(); event.stopPropagation(); stopPreview(); setSelected(i);
    drag.current = { i, edge, before: segments.map(s => ({ ...s })) };
    event.currentTarget.setPointerCapture(event.pointerId);
  }
  function moveDrag(event) {
    const d = drag.current; if (!d) return;
    const rect = timeline.current.getBoundingClientRect();
    let value = pointerTime(event);
    if (Math.abs(value - position) / duration * rect.width < 8) value = position;
    const s = d.before[d.i];
    const min = d.edge === "start" ? (d.before[d.i - 1]?.end || 0) : s.start + 1;
    const max = d.edge === "start" ? s.end - 1 : (d.before[d.i + 1]?.start ?? duration);
    setSegments(d.before.map((s, i) => i === d.i ? { ...s, [d.edge]: Math.round(Math.max(min, Math.min(max, value)) * 100) / 100 } : s));
  }
  function endDrag() { if (drag.current) { const before = drag.current.before; setHistory(h => [...h.slice(-49), before]); drag.current = null; } }
  function split() {
    const i = segments.findIndex(s => position - s.start >= 1 && s.end - position >= 1);
    if (i < 0 || segments.length >= 30) return;
    const p = Math.round(position * 100) / 100;
    commit([...segments.slice(0, i), { start: segments[i].start, end: p }, { start: p, end: segments[i].end }, ...segments.slice(i + 1)]); setSelected(i + 1);
  }
  async function play(ranges) {
    if (!ranges.length || !video.current) return;
    preview.current = { ranges: ranges.map(s => ({ ...s })), index: 0 };
    video.current.currentTime = ranges[0].start; setPreviewing(true);
    try { await video.current.play(); } catch { stopPreview(); setHint("播放失败，请先检查原片是否可以播放。"); }
  }
  const canSplit = segments.length < 30 && segments.some(s => position - s.start >= 1 && s.end - position >= 1);
  return <section className="card timeline-editor" aria-label="时间线剪辑工作区">
    <header className="timeline-header"><div><div className="detail-eyebrow">01 / 时间线剪辑</div><h2>剪出你想留下的瞬间</h2><p>点击定位，拖动边界；在标记处分割，再删除不需要的部分。</p></div><div className="timeline-zoom"><button aria-label="缩小时间线" disabled={zoom <= 1} onClick={() => setZoom(z => Math.max(1, z / 2))}>−</button><output>{zoom}×</output><button aria-label="放大时间线" disabled={zoom >= 32} onClick={() => setZoom(z => Math.min(32, z * 2))}>＋</button></div></header>
    <div className="timeline-scroll"><div ref={timeline} className="timeline-track" style={{ width: `${zoom * 100}%` }} role="group" aria-label="播放位置时间线" tabIndex={0}
      onKeyDown={e => { if (e.target !== e.currentTarget) return; if (["ArrowLeft", "ArrowRight"].includes(e.key)) { e.preventDefault(); seek(position + (e.key === "ArrowLeft" ? -1 : 1) * (e.shiftKey ? 1 : .1)); } if (e.key === " ") { e.preventDefault(); if (video.current?.paused) video.current.play().catch(() => {}); else stopPreview(); } }}
      onClick={e => { if (!duration) return; seek(pointerTime(e)); }}>
      <div className="timeline-ruler">{Array.from({ length: ticks }, (_, i) => <span key={i} style={{ left: `${i / ticks * 100}%` }}>{stamp(duration * i / ticks)}</span>)}</div>
      <div className="timeline-source" />
      {segments.map((s, i) => <div key={i} className={`timeline-region ${i === selected ? "selected" : ""}`} style={{ left: `${s.start / duration * 100}%`, width: `${(s.end - s.start) / duration * 100}%` }} onClick={e => { e.stopPropagation(); setSelected(i); seek(pointerTime(e)); }}>
        <span className="timeline-region-label">{String(i + 1).padStart(2, "0")} · 保留</span>
        {["start", "end"].map(edge => <button key={edge} className={`timeline-handle ${edge}`} aria-label={`片段 ${i + 1} ${edge === "start" ? "起点" : "终点"}`} title="拖动调整；方向键微调 0.1 秒，Shift 调整 1 秒" onClick={e => e.stopPropagation()} onPointerDown={e => beginDrag(e, i, edge)} onPointerMove={moveDrag} onPointerUp={endDrag} onPointerCancel={endDrag} onKeyDown={e => { if (!["ArrowLeft", "ArrowRight"].includes(e.key)) return; e.preventDefault(); e.stopPropagation(); if (selected !== i) { setSelected(i); return; } updateBoundary(edge, s[edge] + (e.key === "ArrowLeft" ? -1 : 1) * (e.shiftKey ? 1 : .1)); }}>Ⅱ</button>)}
      </div>)}
      <div className="timeline-playhead" style={{ left: `${duration ? position / duration * 100 : 0}%` }}><span>▼</span></div>
    </div></div>
    <div className="timeline-caption"><span>标记 {stamp(position)}</span><span>原片 {stamp(duration)}</span></div>
    <div className="timeline-tools"><button className="btn btn-secondary btn-sm" disabled={!canSplit} onClick={split}>在标记处分割</button><button className="btn btn-secondary btn-sm" disabled={!selectedRange} onClick={() => { commit(segments.filter((_, i) => i !== selected)); setSelected(Math.max(0, selected - 1)); }}>删除选中片段</button><button className="btn btn-secondary btn-sm" disabled={!history.length} onClick={undo}>撤销</button><button className="text-button" disabled={!duration} onClick={() => { commit([{ start: 0, end: Math.floor(duration * 100) / 100 }]); setSelected(0); }}>恢复整段</button></div>
    <div className="timeline-fine">{selectedRange ? <><strong>片段 {selected + 1}</strong>{["start", "end"].map(edge => <label key={edge}>{edge === "start" ? "起点" : "终点"}（秒）<input type="number" step="0.1" value={selectedRange[edge]} onChange={e => updateBoundary(edge, Number(e.target.value))} /><button className="text-button" onClick={() => updateBoundary(edge, position)}>使用标记位置</button></label>)}</> : <p>没有保留片段。可以撤销删除或恢复整段。</p>}</div>
    <div className="timeline-output-heading"><h3>成片轨道</h3><span>{segments.length} 段 · {stamp(total)}</span></div>
    <div className="timeline-output">{segments.map((s, i) => <button key={i} className={`timeline-output-item ${selected === i ? "selected" : ""}`} onClick={() => { setSelected(i); seek(s.start); }}><b>{String(i + 1).padStart(2, "0")}</b><span>{stamp(s.start)} — {stamp(s.end)}<small>保留 · {(s.end - s.start).toFixed(1)} 秒</small></span></button>)}</div>
    <div className="timeline-export"><label>成片标题<input maxLength={160} value={title} onChange={e => setTitle(e.target.value)} placeholder={`${defaultTitle} · 剪辑`} /></label><div className="detail-actions"><button className="btn btn-secondary" disabled={!selectedRange} onClick={() => play([selectedRange])}>预览选段</button><button className="btn btn-secondary" disabled={!valid} onClick={() => previewing ? stopPreview() : play(segments)}>{previewing ? "停止预览" : "预览成片"}</button><button className="btn btn-primary" disabled={!valid || busy} onClick={() => onExport({ segments, title: title.trim() || `${defaultTitle} · 剪辑` })}>{busy ? "提交中…" : "拼接导出 MP4"}</button></div></div>
    <p className="clip-hint" role="status">{hint || (!valid ? "每段至少 1 秒，最多 30 段，成片总时长不超过 2 小时。" : "按原片时间顺序拼接；删除只影响本次剪辑，原片保持不变。方向键微调 0.1 秒，Shift 调整 1 秒。")}</p>
  </section>;
}
