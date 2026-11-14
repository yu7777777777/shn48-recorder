import React,{useState} from 'react';
import {adminApi,payload,errorMessage} from '../lib/api';
import './AnalysisProvenance.css';

const STAGES=[['transcribe','语音识别'],['correct','纠错'],['translate','英文翻译'],['summarize','总结']];
const STATUS={recorded:['已记录','ok'],partial:['信息不全','warn'],absent:['缺少记录','muted']};

// Shows what each stage of the pipeline actually recorded. It never guesses: a
// stage with no recorded model is reported as missing instead of "unknown".
export default function AnalysisProvenance({id}){
  const [open,setOpen]=useState(false),[data,setData]=useState(null),[busy,setBusy]=useState(false),[error,setError]=useState('');
  async function load(){
    setBusy(true);setError('');
    try{setData(payload(await adminApi.get(`/analysis/${id}/provenance`,{headers:{Accept:'application/json'}})));}catch(e){setError(errorMessage(e));}finally{setBusy(false);}
  }
  function toggle(){const next=!open;setOpen(next);if(next&&!data)void load();}
  return <section className="card analysis-provenance" aria-labelledby={`provenance-${id}`}>
    <div className="provenance-heading">
      <div>
        <div className="detail-eyebrow">来源核查</div>
        <h2 id={`provenance-${id}`}>这段内容由谁生成</h2>
        <p>列出每个处理阶段记录的模型与完成时间。缺少记录的阶段会明确标出，不会用推测补全。</p>
      </div>
      <button type="button" className="btn btn-secondary btn-sm" onClick={toggle} aria-expanded={open}>{open?'收起':(data?'查看详情':'展开查看')}</button>
    </div>
    {open&&<div className="provenance-body">
      {busy&&!data&&<p className="provenance-muted">正在读取来源记录…</p>}
      {error&&<p role="alert" className="provenance-error">{error}<button type="button" className="btn btn-secondary btn-sm" onClick={load}>重试</button></p>}
      {data&&<>
        <table className="provenance-table">
          <caption>共 {data.segments} 条字幕，其中 {data.english?.recorded||0} 条带翻译来源记录{data.glossary!==null&&data.glossary!==undefined?`，词库 ${data.glossary} 条`:''}。</caption>
          <thead><tr><th scope="col">阶段</th><th scope="col">状态</th><th scope="col">服务</th><th scope="col">模型</th><th scope="col">完成时间</th><th scope="col">缺失</th></tr></thead>
          <tbody>{STAGES.map(([key,label])=>{
            const stage=(data.stages||[]).find(s=>s.stage===key)||{status:'absent',missing:[]};
            const [text,tone]=STATUS[stage.status]||STATUS.absent;
            return <tr key={key}><th scope="row">{label}</th><td><span className={`provenance-badge ${tone}`}>{text}</span></td><td>{stage.provider||"—"}</td><td>{stage.model||stage.fingerprint?`${stage.model||"未记录模型"}${stage.fingerprint?`（指纹 ${String(stage.fingerprint).slice(0,12)}）`:''}`:'—'}</td><td>{stage.completedAt?new Date(stage.completedAt).toLocaleString('zh-CN'):'—'}</td><td>{stage.missing?.length?stage.missing.join('、'):'—'}</td></tr>;
          })}</tbody>
        </table>
        <p className="provenance-muted">导出时间 {data.exportedAt?new Date(data.exportedAt).toLocaleString('zh-CN'):'—'} · 服务一列只显示域名，主机会暴露路径、查询参数与密钥，因此一律不导出。</p>
        <div className="provenance-actions"><a className="btn btn-secondary btn-sm" href={`/api/admin/analysis/${id}/provenance`}>下载来源清单 JSON</a><a className="btn btn-secondary btn-sm" href={`/api/admin/analysis/${id}/provenance?format=markdown`}>下载可读版 Markdown</a></div>
      </>}
    </div>}
  </section>;
}
