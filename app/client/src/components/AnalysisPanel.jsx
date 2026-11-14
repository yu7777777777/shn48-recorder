import React,{useEffect,useMemo,useRef,useState} from 'react';
import {Link} from 'react-router-dom';
import {adminApi,payload,errorMessage} from '../lib/api';
import {formatMessage} from '../lib/pocket48-message';
import usePolling from '../hooks/usePolling';
import './AnalysisPanel.css';
const stamp=t=>new Date(Math.max(0,t||0)*1000).toISOString().slice(11,19);
const emptyAnalysis=()=>({segments:[],chapters:[],highlights:[]});
const normalizeAnalysis=value=>({...emptyAnalysis(),...value,segments:Array.isArray(value?.segments)?value.segments:[],chapters:Array.isArray(value?.chapters)?value.chapters:[],highlights:Array.isArray(value?.highlights)?value.highlights:[]});
// Evidence IDs are strictly 0-based source subtitle indexes, never inferred from time or prose.
export function subtitleEvidence(item,segments) {
  if(!Number.isFinite(item?.start)||!Number.isFinite(item?.end)||item.start<0||item.end<=item.start)return [];
  return [...new Set(Array.isArray(item?.evidenceIds)?item.evidenceIds:[])]
    .filter(index=>Number.isInteger(index)&&index>=0&&index<segments.length)
    .map(index=>({index,segment:segments[index]}))
    .filter(({segment})=>segment&&typeof segment.text==='string'&&Number.isFinite(segment.start)&&Number.isFinite(segment.end)&&segment.start>=0&&segment.end>segment.start&&segment.start<item.end&&segment.end>item.start);
}
export function captionText(segment,language) {
  if(language==='en')return segment.en||segment.text;
  if(language==='bilingual')return [segment.text,segment.en].filter(Boolean).join('\n');
  if(language==='ja')return segment.enJA||'此句尚未翻译';
  if(language==='ja-bilingual')return [segment.text,segment.enJA].filter(Boolean).join('\n');
  return segment.text;
}
// Stable-value guards: identical JSON content keeps the old reference so the 4s
// poll neither re-renders the panel nor remounts the caption track.
export const sameJson=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
export const segmentTrackSignature=segments=>(Array.isArray(segments)?segments:[]).map(s=>`${s?.start}_${s?.end}_${s?.text}`).join('|');
// Queue depth hint only for a task parked in the queue (progress 0, phase mentions 排队);
// the server's queued count includes this very task, so "ahead" is that count minus one.
export function queueDepthHint(job,queued){if(job?.status!=='queued'||(job.progress||0)!==0||!String(job?.phase||'').includes('排队'))return '';const ahead=Math.max(0,(Number(queued)||0)-1);return ahead>0?` · 前面还有 ${ahead} 个任务`:'';}
// Remount the entire archive-scoped state, including requests and editing, on every ID switch.
export default function AnalysisPanel(props) {
  return <ArchiveAnalysisPanel key={JSON.stringify([props.id,Boolean(props.audio)])} {...props}/>;
}
function ArchiveAnalysisPanel({id,video,position,onRange,audio=false}) {
  const [data,setData]=useState(emptyAnalysis),[tab,setTab]=useState('subtitles'),[query,setQuery]=useState(''),[language,setLanguage]=useState('original'),[error,setError]=useState(''),[sending,setSending]=useState(false),[messages,setMessages]=useState([]),[importError,setImportError]=useState(''),[notice,setNotice]=useState(''),[showOriginal,setShowOriginal]=useState(false),[editingIndex,setEditingIndex]=useState(null),[editText,setEditText]=useState(''),[editSaving,setEditSaving]=useState(false),[queueDepth,setQueueDepth]=useState(0);
  const mounted=useRef(false);
  useEffect(()=>{mounted.current=true;return()=>{mounted.current=false;};},[]);
  // The caption track rebuilds only when segment content actually changes; job
  // progress updates replace data.segments with an equal-content copy and must
  // not reload a playing track every few seconds.
  const segmentsSignature=useMemo(()=>segmentTrackSignature(data.segments),[data.segments]);
  useEffect(()=>{
    const element=video?.current;
    if(!element||!data.segments.length||language==='off')return undefined;
    const stamp=value=>{const n=Math.max(0,Number(value)||0),h=Math.floor(n/3600),m=Math.floor((n%3600)/60),s=n%60;return `${String(h).padStart(2,'0')}:${String(m).padStart(2,'0')}:${s.toFixed(3).padStart(6,'0')}`;};
    const text=data.segments.map((segment,index)=>`${index+1}\n${stamp(segment.start)} --> ${stamp(segment.end)}\n${captionText(segment,language)}\n`).join('\n');
    const track=document.createElement('track');
    track.kind='subtitles';track.label={bilingual:'双语字幕',en:'英文字幕',ja:'日文字幕','ja-bilingual':'中日双语字幕'}[language]||'原文字幕';track.srclang={en:'en',ja:'ja','ja-bilingual':'ja'}[language]||'zh';track.default=true;
    track.src=URL.createObjectURL(new Blob([`WEBVTT\n\n${text}`],{type:'text/vtt'}));
    track.addEventListener('load',()=>{if(track.track)track.track.mode='showing';});
    element.appendChild(track);
    if(track.track)track.track.mode='showing';
    return()=>{URL.revokeObjectURL(track.src);track.remove();};
  },[video,segmentsSignature,language]);
  const refresh=async()=>{try{const value=payload(await adminApi.get(`/analysis/${id}`));if(!mounted.current)return;const next=normalizeAnalysis(value);setData(cur=>sameJson(cur,next)?cur:next);setError('');if(audio){const rows=payload(await adminApi.get(`/room-voice/${id}/messages`));if(mounted.current)setMessages(cur=>{const list=Array.isArray(rows)?rows:[];return sameJson(cur,list)?cur:list;});}}catch(e){if(mounted.current)setError(errorMessage(e));}if(!data.job)return;try{const status=payload(await adminApi.get('/analysis/queue'));if(mounted.current){const depth=Math.max(0,Number(status?.queued)||0);setQueueDepth(cur=>cur===depth?cur:depth);}}catch(e){}};
  usePolling(refresh,4000,[id,audio]);
  const active=['queued','running'].includes(data.job?.status);
  // Re-running recognition on existing subtitles (SRT import, corrections, or a
  // previous run) wipes them server-side after writing a backup snapshot, so it
  // always confirms; a first generation with no content starts right away.
  async function task(kind){if(kind==='transcribe'&&data.segments.length>0&&!window.confirm('将以当前词库与模型重新识别，现有字幕（含手动纠错）会自动备份为最近一次还原点。是否继续？'))return;if(kind==='correct'&&(data.summary||data.chapters.length||data.highlights.length||data.segments.some(s=>s.en||s.enJA||s.translation))&&!window.confirm('纠错完成后将清空现有翻译、章节和精彩片段，保留原文供恢复。是否继续？'))return;setSending(true);setError('');try{const job=payload(await adminApi.post(`/analysis/${id}`,kind==='translate'?{kind,target}:{kind}));setData(d=>({...d,job}));}catch(e){setError(errorMessage(e));}finally{setSending(false);}}
  const [target,setTarget]=useState('en');
  function beginEdit(index,segment){setEditingIndex(index);setEditText(segment.text);setError('');setNotice('');}
  async function saveEdit(index){const text=editText.trim();if(!text){setError('字幕内容不能为空');return;}setEditSaving(true);setError('');try{const result=payload(await adminApi.patch(`/analysis/${id}/segments/${index}`,{text}));setData(normalizeAnalysis(result));setEditingIndex(null);setNotice('手动纠错已保存，相关翻译和章节分析已清空。');setLanguage('original');}catch(e){setError(errorMessage(e));}finally{setEditSaving(false);}}
  async function importFile(file){
    if(!file)return;setImportError('');setNotice('');
    if(!/\.srt$/i.test(file.name)||file.size>1000000){setImportError('请选择不超过 1 MB 的 UTF-8 .srt 文件');return;}
    const replace=data.segments.length>0;
    if(replace&&!window.confirm('导入将替换当前字幕，清空原有翻译、章节和精彩片段分析。服务器会保留一份导入前备份。是否继续？'))return;
    setSending(true);
    try{const text=new TextDecoder('utf-8',{fatal:true}).decode(await file.arrayBuffer());if(!mounted.current)return;const result=payload(await adminApi.post(`/analysis/${id}/import-srt`,{text,replace}));setData(normalizeAnalysis(result));setLanguage('original');setTab('subtitles');setNotice(`已导入 ${result.segments.length} 条字幕，可以直接生成章节、精彩片段和翻译。`);}
    catch(e){setImportError(e instanceof TypeError?'字幕编码异常，请另存为 UTF-8 SRT':errorMessage(e));}
    finally{setSending(false);}
  }
  // Clearing is irreversible server-side too; it always confirms first and keeps a
  // snapshot, and it is refused while any task is pending.
  async function clearAll(){
    if(!data.segments.length)return;
    if(!window.confirm('清空这条归档的全部字幕、翻译、章节与精彩片段？服务器会保留一份清空前快照，但界面上的内容将无法恢复。'))return;
    setSending(true);setError('');setNotice('');
    try{const result=payload(await adminApi.delete(`/analysis/${id}`,{data:{confirmed:true}}));setData(normalizeAnalysis(result));setTab('subtitles');setLanguage('original');setQuery('');setNotice('已清空字幕与分析，可重新生成或导入新的字幕后重来。');}
    catch(e){setError(errorMessage(e));}
    finally{setSending(false);}
  }
  // AI 高光一键切片：把精彩片段交给服务端剪辑队列切成真实 MP4。
  // merged 合成一条合集；separate 逐段成片；带 indexes 时只切选中的段。
  async function clipHighlights(mode,indexes){
    if(!data.highlights.length)return;
    const confirmed=mode==='merged'
      ?`把全部 ${data.highlights.length} 段精彩片段按顺序合成一条合集 MP4？`
      :indexes?`把这一段精彩片段切成独立 MP4？`
      :`把 ${data.highlights.length} 段精彩片段逐段切成独立 MP4（每段一个剪辑任务）？`;
    if(!window.confirm(confirmed))return;
    setSending(true);setError('');setNotice('');
    try{
      const result=payload(await adminApi.post(`/analysis/${id}/highlights/clip`,indexes?{mode,indexes}:{mode}));
      setNotice(mode==='merged'
        ?`已把 ${result.segments} 段精彩片段合成一条合集，加入剪辑队列。`
        :`已把 ${result.queued.length} 段精彩片段加入剪辑队列${result.errors?.length?`，${result.errors.length} 段入队失败`:''}${result.skippedTooShort?`，跳过 ${result.skippedTooShort} 段不足 1 秒的片段`:''}。`);
    }
    catch(e){setError(errorMessage(e));}
    finally{setSending(false);}
  }
  const seek=t=>{if(video?.current&&Number.isFinite(t)&&t>=0)video.current.currentTime=t;};
  const hasSummary=Boolean(typeof data.summary==='string'&&data.summary.trim())||data.chapters.length>0||data.highlights.length>0;
  const canExport=hasSummary&&!(active&&data.job?.kind==='summarize');
  const selected=data.segments.find(s=>position>=s.start&&position<s.end);
  const nextRetry=data.job?.status==='queued'&&data.job.nextAttemptAt?new Date(data.job.nextAttemptAt):null;
  const nextRetryLabel=nextRetry&&Number.isFinite(nextRetry.getTime())?nextRetry.toLocaleString('zh-CN',{timeZone:'Asia/Shanghai',hour12:false}):null;
  const queuedHint=queueDepthHint(data.job,queueDepth);
  return <section className="card analysis-panel">
    <div className="analysis-heading"><div><div className="detail-eyebrow">内容整理</div><h2>听见每一句，找到精彩处</h2><p>字幕与分析按需生成，点击时间即可回到原片。</p></div><Link to="/admin/analysis-settings">服务设置与词库 ↗</Link></div>
    <div className="analysis-actions">{data.segments.length>0&&<button type="button" className="btn btn-secondary btn-sm analysis-clear" disabled={active||sending} onClick={clearAll} title="清空后可按新的字幕或设置重新生成">清空字幕与分析</button>}<label className="btn btn-secondary btn-sm">{sending?'处理中…':'导入 SRT 字幕'}<input type="file" accept=".srt" aria-label="导入 SRT 字幕" style={{display:'none'}} disabled={active||sending} onChange={e=>{const file=e.target.files?.[0];e.target.value='';void importFile(file);}}/></label><button className="btn btn-primary btn-sm" disabled={active||sending} onClick={()=>task('transcribe')}>{data.segments.length?'继续 / 重试识别':'生成字幕'}</button><button className="btn btn-secondary btn-sm" disabled={active||sending||!data.segments.length} onClick={()=>task('correct')}>AI 文字纠错</button><button className="btn btn-secondary btn-sm" disabled={active||sending||!data.segments.length} onClick={()=>task('summarize')}>生成章节与精彩片段</button><select className="voice-select" aria-label="翻译目标语言" disabled={active||sending} value={target} onChange={e=>setTarget(e.target.value)}><option value="en">英文</option><option value="ja">日文</option></select><button className="btn btn-secondary btn-sm" disabled={active||sending||!data.segments.length} onClick={()=>task('translate')}>{target==='ja'?'翻译日文':'翻译英文'}</button>{active&&<button className="btn btn-secondary btn-sm" onClick={async()=>{try{await adminApi.post(`/analysis/${id}/cancel`);}catch(e){setError(errorMessage(e));}}}>取消任务</button>}</div>
    {hasSummary&&data.job?.kind==='summarize'&&data.job.status!=='done'&&<p className="analysis-retained-summary">当前显示的是上次成功的分析；新任务尚未完成。{active?'完成后可下载。':'仍可下载已保留的结果。'}</p>}
    {canExport&&<div className="analysis-exports" aria-label="分析导出"><a className="btn btn-secondary btn-sm" href={`/api/admin/analysis/${encodeURIComponent(id)}/summary?format=markdown`} download>下载 Markdown 总结</a><a className="btn btn-secondary btn-sm" href={`/api/admin/analysis/${encodeURIComponent(id)}/summary?format=json`} download>下载 JSON 分析</a></div>}
    {notice&&<p role="status">{notice}</p>}{importError&&<p role="alert" className="detail-error">{importError}</p>}
    <p className="analysis-disclosure">导入字幕只保存到本服务器，不需要语音识别服务。离线识别音轨不外发。在线识别会发送音轨；AI 纠错、分析或翻译会发送字幕和相关词库给你配置的文本服务；可能产生服务商费用。摘要采用时间 / 字符双限分块，重试时续用已完成块（字幕或配置变化后会重新分析）。模型输出可能遗漏或误判，字幕证据也不代表事实绝对准确，请结合原片核对。</p>
    {nextRetryLabel&&<p role="status" className="analysis-retry-state">等待自动重试 · 第 {Number.isInteger(data.job.retryCount)?data.job.retryCount:0} 次重试 · 计划时间 {nextRetryLabel}（北京时间）；等待期间可以取消任务。</p>}
    {data.job?.recovered===true&&<p role="status">该任务由显式开启的中断恢复重新排队，已完成分块会按有效指纹复用；上游调用可能重复计费。</p>}
    {data.job&&<p role="status">{{queued:'排队中',running:'处理中',done:'已完成',failed:'未完成'}[data.job.status]}{queuedHint} · {data.job.progress||0}% {data.job.phase} {data.job.error}</p>}{error&&<p role="alert" className="detail-error">{error}</p>}
    {data.segments.some(s=>s.originalText!==undefined)&&<div className="analysis-actions"><label><input type="checkbox" checked={showOriginal} onChange={e=>setShowOriginal(e.target.checked)}/> 显示纠错前原文</label><button className="btn btn-secondary btn-sm" disabled={active||sending} onClick={async()=>{if(!window.confirm('恢复纠错前原文，并清空现有翻译、章节和精彩片段？'))return;setSending(true);try{setData(normalizeAnalysis(payload(await adminApi.post(`/analysis/${id}/restore-original`))));}catch(e){setImportError(errorMessage(e));}finally{setSending(false);}}}>恢复原文</button></div>}
    <div className="analysis-tabs" role="tablist" aria-label="内容整理视图">{[['subtitles','字幕'],['chapters','章节'],['highlights','精彩片段'],...(audio?[['messages','房间消息']]:[])].map(([key,label])=><button key={key} role="tab" aria-selected={tab===key} onClick={()=>setTab(key)}>{label}{key==='subtitles'&&` · ${data.segments.length}`}</button>)}</div>
    {tab==='subtitles'&&<><div className="analysis-filters"><input aria-label="搜索字幕" placeholder="搜索一句话、成员名字或关键词…" value={query} onChange={e=>setQuery(e.target.value)}/><select aria-label="字幕语言" value={language} onChange={e=>setLanguage(e.target.value)}><option value="original">原文</option><option value="en">英文</option><option value="bilingual">双语</option><option value="ja">日文</option><option value="ja-bilingual">中日双语</option><option value="off">关闭同步字幕</option></select>{data.segments.length>0&&<a className="btn btn-secondary btn-sm" href={`/api/admin/analysis/${id}/subtitles?language=${language}`}>下载 SRT</a>}</div>
      {language!=='off'&&<div className="analysis-caption" aria-live="off">{selected?(language==='en'||language==='ja'?(language==='ja'?selected.enJA:selected.en)||'此句尚未翻译':language==='ja-bilingual'?<>{selected.text}<small>{selected.enJA||'此句尚未翻译'}</small></>:language==='bilingual'?<>{selected.text}<small>{selected.en||'此句尚未翻译'}</small></>:selected.text):'播放原片，同步字幕将在这里显示'}</div>}
      <div className="analysis-scroll">{data.segments.map((s,index)=>({s,index})).filter(({s})=>`${s.text} ${s.en||''}`.toLowerCase().includes(query.toLowerCase())).map(({s,index})=>editingIndex===index?<div key={`${s.start}:${index}`} className="analysis-line-editor"><time>{stamp(s.start)}</time><div className="analysis-edit-body"><textarea aria-label={`编辑字幕 ${stamp(s.start)}`} value={editText} maxLength={10000} autoFocus onChange={e=>setEditText(e.target.value)} onKeyDown={e=>{if(e.key==='Escape')setEditingIndex(null);if(e.key==='Enter'&&(e.ctrlKey||e.metaKey)){e.preventDefault();void saveEdit(index);}}}/><div className="analysis-edit-actions"><button className="btn btn-primary btn-sm" disabled={editSaving} onClick={()=>void saveEdit(index)}>{editSaving?'保存中…':'保存纠错'}</button><button className="btn btn-secondary btn-sm" disabled={editSaving} onClick={()=>setEditingIndex(null)}>取消</button><small>Ctrl/⌘ + Enter 保存</small></div></div></div>:<div key={`${s.start}:${index}`} className={`analysis-line ${selected===s?'current':''}`}><button className="analysis-line-main" onClick={()=>seek(s.start)}><time>{stamp(s.start)}</time><span>{language==='en'?s.en||s.text:s.text}{showOriginal&&s.originalText!==undefined&&<small>原文：{s.originalText}</small>}{language==='bilingual'&&s.en&&<small>{s.en}</small>}</span></button><button className="analysis-edit-button" disabled={active||sending} onClick={()=>beginEdit(index,s)}>编辑</button></div>)}{!data.segments.length&&<p className="analysis-empty">还没有字幕。可直接导入 SRT，或配置识别服务后生成字幕。</p>}{data.segments.length>0&&query&&!data.segments.some(s=>`${s.text} ${s.en||''}`.toLowerCase().includes(query.toLowerCase()))&&<p className="analysis-empty">没有找到匹配的字幕</p>}</div></>}
    {tab==='chapters'&&data.summary&&<p className="analysis-summary">{data.summary}</p>}
    {['chapters','highlights'].includes(tab)&&<div className="analysis-scroll">{tab==='highlights'&&data.highlights.length>0&&!audio&&<div className="analysis-actions" style={{marginBottom:8}}><button className="btn btn-primary btn-sm" disabled={active||sending} onClick={()=>clipHighlights('merged')}>一键切片 · 合成合集</button><button className="btn btn-secondary btn-sm" disabled={active||sending} onClick={()=>clipHighlights('separate')}>逐段切片</button><small style={{color:'var(--text-dim)'}}>用剪辑队列把精彩片段切成真实 MP4，完成后可在下方片段库播放、下载或送入 B站草稿。</small></div>}{(data[tab]||[]).map((s,i)=><article className="analysis-insight" key={`${tab}:${i}`}><button onClick={()=>seek(s.start)}><time>{stamp(s.start)} — {stamp(s.end)}</time><strong>{s.title}</strong></button><p>{s.summary}</p><details className="analysis-evidence"><summary>查看字幕证据 · {subtitleEvidence(s,data.segments).length} 条</summary>{subtitleEvidence(s,data.segments).length? <ul>{subtitleEvidence(s,data.segments).map(({index,segment})=><li key={index}><button className="analysis-evidence-seek" onClick={()=>seek(segment.start)} aria-label={`跳转原片字幕 ${index}`}><time>{stamp(segment.start)} — {stamp(segment.end)}</time><span>跳转原片 ↗</span></button><p>{segment.text}</p>{segment.en&&<p className="analysis-evidence-translation">英文：{segment.en}</p>}{segment.enJA&&<p className="analysis-evidence-translation">日文：{segment.enJA}</p>}</li>)}</ul>:<p className="analysis-evidence-empty">暂无可核对的字幕证据（旧版分析或证据索引无效），请直接查看原片或重新分析。</p>}</details>{!audio&&onRange&&<div className="detail-actions"><button className="btn btn-secondary btn-sm" onClick={()=>{seek(s.start);onRange(s);}}>将这一段送入时间线</button>{tab==='highlights'&&<button className="btn btn-secondary btn-sm" disabled={active||sending} onClick={()=>clipHighlights('separate',[i])}>切片这一段</button>}</div>}</article>)}{!data[tab]?.length&&<p className="analysis-empty">暂无{tab==='chapters'?'章节':'精彩片段建议'}。先生成字幕，再启动章节分析。</p>}</div>}
    {tab==='messages'&&<><p>录制期间每 15 秒抓取最近消息；高频消息可能遗漏，时间相对音频起点。</p><div className="analysis-scroll">{messages.map((m,i)=>{const f=formatMessage(m);return <button className="analysis-line" key={i} onClick={()=>seek(m.offset)}><time>{stamp(m.offset)}</time><span><strong>{f.senderName}</strong> {f.text||f.label||'媒体消息'}</span></button>;})}{!messages.length&&<p className="analysis-empty">录制期间暂未获取到房间消息</p>}</div></>}
  </section>;
}
