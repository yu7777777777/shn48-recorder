import React, { useEffect, useState } from "react";
import { adminApi, errorMessage, payload } from "../lib/api";
import { useToast } from "../components/Toast";
import { IconRefresh, IconUpload } from "../components/Icons";
import SafeImage from "../components/SafeImage";

export default function CoverSettings() {
  const [settings, setSettings] = useState(null);
  const [busy, setBusy] = useState("");
  const [search, setSearch] = useState("");
  const [name, setName] = useState("");
  const [memberId, setMemberId] = useState("");
  const toast = useToast();
  async function load() {
    try { setSettings(payload(await adminApi.get("/recordings/cover-settings"))); }
    catch (error) { toast.error(errorMessage(error, "封面设置加载失败")); }
  }
  useEffect(() => { void load(); }, []);
  async function save(member, image, clearPhoto = false) {
    setBusy(member.memberId);
    try { await adminApi.put(`/recordings/cover-members/${encodeURIComponent(member.memberId)}`, { memberName: member.memberName, image, clearPhoto }, { timeout: 300000 }); await load(); toast.success("成员模板已保存，下次生成时生效"); setName(""); setMemberId(""); }
    catch (error) { toast.error(errorMessage(error)); } finally { setBusy(""); }
  }
  function upload(member, file) {
    if (!file) return;
    if (file.size > 1400000) return toast.error("图片请小于 1.4 MB");
    const reader = new FileReader(); reader.onload = () => save(member, reader.result); reader.onerror = () => toast.error("图片读取失败"); reader.readAsDataURL(file);
  }
  return <div>
    <div className="page-header admin-page-header"><div><span className="eyebrow">COVERS</span><h1>封面设置</h1><p>照片设置一次，后续录像自动套用。原直播封面与智能选帧仍然优先。</p></div><button className="btn btn-secondary btn-sm" disabled={!!busy} onClick={load}><IconRefresh size={14} />刷新</button></div>
    <section className="card cover-settings-intro"><div><h2>自动封面顺序</h2><div className="cover-flow"><span>01 原直播封面</span><i>→</i><span>02 智能选帧</span><i>→</i><span>03 成员模板</span></div><p className="muted">从录像抽取 24 个位置，检测人脸与清晰度，优先避开黑屏、等待画面和明显遮挡。没有合适画面时使用成员照片；尚未上传照片时尝试成员头像，再使用姓名封面。</p></div><div className="cover-layout-note"><strong>图片居中 · 背景虚化</strong><p>原直播封面、智能选帧和成员照片均完整居中，背景用同一张图片虚化填满。不裁切人物，不叠加姓名、日期或标题。</p><small>统一输出 960 × 540</small></div></section>
    <section className="card"><div className="card-title-row"><div><h2>成员照片</h2><p>建议使用清晰的正面或半身照片。JPG / PNG / WebP，小于 1.4 MB。</p></div><input aria-label="搜索成员" placeholder="搜索成员姓名或 ID" value={search} onChange={e => setSearch(e.target.value)} /></div>
      {!settings ? <div className="state-card">正在加载成员…</div> : <div className="cover-members-grid">{settings.members.filter(m => `${m.memberName} ${m.memberId}`.toLowerCase().includes(search.toLowerCase())).map(member => <article className="cover-member" key={member.memberId}><div className="cover-member-photo"><SafeImage src={member.photoFile ? `/api/admin/recordings/cover-members/${encodeURIComponent(member.memberId)}/photo?v=${member.photoFile}` : ""} alt={member.memberName} fallback={<span>{member.memberName.replace(/^[A-Z0-9]+-/, "").slice(0, 1)}</span>} /></div><div><strong>{member.memberName}</strong><small>ID {member.memberId}</small><div className="cover-member-actions"><label className="btn btn-secondary btn-sm cover-upload"><IconUpload size={13} />{busy === member.memberId ? "保存中…" : member.photoFile ? "更换照片" : "上传照片"}<input type="file" accept="image/jpeg,image/png,image/webp" disabled={!!busy} onChange={e => { upload(member, e.target.files?.[0]); e.target.value = ""; }} /></label>{member.photoFile && <button className="text-button" disabled={!!busy} onClick={() => save(member, undefined, true)}>移除</button>}</div></div></article>)}</div>}
      <form className="cover-add-member" onSubmit={e => { e.preventDefault(); save({ memberId, memberName: name }); }}><h3>添加其他成员</h3><input aria-label="成员 ID" required pattern="[A-Za-z0-9_-]{1,80}" placeholder="口袋48 成员 ID" value={memberId} onChange={e => setMemberId(e.target.value)} /><input aria-label="成员姓名" required maxLength={100} placeholder="成员姓名" value={name} onChange={e => setName(e.target.value)} /><button className="btn btn-secondary" disabled={!!busy || !settings}>添加成员</button></form>
    </section>
  </div>;
}
