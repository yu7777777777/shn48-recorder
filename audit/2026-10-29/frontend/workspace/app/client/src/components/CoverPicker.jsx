import React, { useEffect, useRef, useState } from "react";
import { adminApi, payload, errorMessage } from "../lib/api";
import { useToast } from "./Toast";
import { IconX, IconRefresh, IconUpload, IconCheck } from "./Icons";

export default function CoverPicker({ recording, onClose, onSaved }) {
  const [candidates, setCandidates] = useState([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [selected, setSelected] = useState("");
  const [upload, setUpload] = useState("");
  const [updated, setUpdated] = useState(null);
  const [liveType, setLiveType] = useState(recording.liveType ?? null);
  const toast = useToast();
  const mounted = useRef(true);
  const root = `/recordings/${encodeURIComponent(recording.id)}`;
  async function load(refresh = false) {
    setLoading(true); setError(""); setUpload("");
    try {
      const values = payload(await adminApi.post(`${root}/cover-candidates`, { refresh }, { timeout: 300000 }), []);
      if (!mounted.current) return;
      setCandidates(values);
      setLiveType(values.find(c => c.liveType !== undefined)?.liveType ?? recording.liveType ?? null);
      setSelected((values.find(c => c.current) || values.find(c => c.recommended) || values[0])?.file || "");
    } catch (requestError) { if (mounted.current) setError(errorMessage(requestError, "候选生成失败")); }
    finally { if (mounted.current) setLoading(false); }
  }
  useEffect(() => { mounted.current = true; void load(); return () => { mounted.current = false; }; }, [recording.id]);
  useEffect(() => {
    const handler = event => { if (event.key === "Escape" && !saving) onClose(); };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [saving, onClose]);
  function readFile(file) {
    if (!file) return;
    if (file.size > 1400000) return toast.error("请选择小于 1.4 MB 的 JPG、PNG 或 WebP");
    const reader = new FileReader();
    reader.onload = () => { if (mounted.current) { setUpload(reader.result); setSelected(""); } };
    reader.onerror = () => toast.error("图片读取失败"); reader.readAsDataURL(file);
  }
  async function save() {
    setSaving(true); setError("");
    try {
      const result = payload(await adminApi.post(`${root}/cover`, upload ? { image: upload } : { candidateFile: selected }, { timeout: 300000 }));
      setUpdated(result); await onSaved?.();
      toast.success(result.coverSyncPending ? "本地封面已保存，请同步到 B站草稿" : "封面已保存，新上传将使用此图");
      if (!result.coverSyncPending) onClose();
    } catch (requestError) { setError(errorMessage(requestError, "保存封面失败")); }
    finally { setSaving(false); }
  }
  async function sync() {
    setSaving(true); setError("");
    try {
      await adminApi.post(`${root}/cover-sync`, {}, { timeout: 90000 });
      toast.success("B站草稿封面已同步"); await onSaved?.(); onClose();
    } catch (requestError) { setError(errorMessage(requestError, "同步失败，本地封面仍保留")); }
    finally { setSaving(false); }
  }
  return <div className="modal-backdrop" onClick={() => !saving && onClose()}>
    <div className="modal-card cover-picker" role="dialog" aria-modal="true" aria-labelledby="cover-picker-title" onClick={e => e.stopPropagation()}>
      <div className="modal-header"><div><h3 id="cover-picker-title">选择封面 {Number(liveType) === 2 && <span className="cover-type-badge">电台直播</span>}</h3><p className="muted cover-recording-title">{recording.title}</p></div><button className="modal-close-btn" aria-label="关闭封面选择" disabled={saving} onClick={onClose}><IconX size={18} /></button></div>
      <div className="modal-body">
        <div className="cover-flow"><span>01 原直播封面</span><i>→</i><span>02 智能选帧</span><i>→</i><span>03 成员模板</span></div>
        <p className="muted">系统优先推荐原直播封面，无法获取时选择清晰的人物画面。所有图片完整居中，背景用同图虚化填满，也可直接选择成员照片。{Number(liveType) === 2 && "这场是电台直播，画面可能是固定占位图，智能选帧较少属于正常情况。"}</p>
        {error && <div className="cover-error" role="alert">{error}</div>}
        {loading ? <div className="state-card"><span className="spinner" /><span>正在检查原封面并筛选录像画面，首次生成需要一些时间…</span></div> : <div className="cover-candidate-grid">
          {candidates.map(c => <button key={c.file} type="button" className={`cover-candidate ${selected === c.file && !upload ? "selected" : ""}`} onClick={() => { setSelected(c.file); setUpload(""); }} disabled={saving}>
            <div className="cover-candidate-image"><img src={c.url} alt={`${c.label}${c.time != null ? ` ${c.time}秒` : ""}`} />{c.recommended && <span className="cover-recommendation">系统推荐</span>}{selected === c.file && !upload && <span className="cover-selected-mark"><IconCheck size={16} /></span>}</div>
            <strong>{c.label}{c.time != null && <small>{Math.floor(c.time / 60)}:{String(Math.floor(c.time % 60)).padStart(2, "0")}</small>}</strong><span>{c.reason}{!c.acceptable ? " · 不建议使用" : ""}</span>
          </button>)}
          {upload && <button className="cover-candidate selected" type="button"><div className="cover-candidate-image"><img src={upload} alt="自定义上传预览" /></div><strong>自定义上传</strong><span>保存时自动适配封面尺寸</span></button>}
        </div>}
        <div className="cover-picker-tools"><button className="btn btn-secondary btn-sm" disabled={loading || saving} onClick={() => load(true)}><IconRefresh size={14} />重新筛选</button><label className="btn btn-secondary btn-sm cover-upload"><IconUpload size={14} />上传图片<input type="file" accept="image/jpeg,image/png,image/webp" disabled={saving || loading} onChange={e => { readFile(e.target.files?.[0]); e.target.value = ""; }} /></label></div>
        {(updated?.coverSyncPending || recording.coverSyncPending) && <div className="cover-sync-note">本地预览与 B站草稿尚未同步。点击“同步到 B站草稿”只更新封面，保留视频和投稿信息。</div>}
      </div>
      <div className="modal-footer"><button className="btn btn-secondary" disabled={saving} onClick={onClose}>关闭</button>{(updated?.coverSyncPending || recording.coverSyncPending) && <button className="btn btn-secondary" disabled={saving} onClick={sync}>同步到 B站草稿</button>}<button className="btn btn-primary" disabled={loading || saving || (!selected && !upload)} onClick={save}>{saving ? "处理中…" : "使用此封面"}</button></div>
    </div>
  </div>;
}
