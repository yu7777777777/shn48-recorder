import React,{useState} from 'react';
import {adminApi,payload,errorMessage} from '../lib/api';
import './AnalysisProvenance.css';

const STAGES=[['transcribe','语音识别'],['correct','纠错'],['translate','英文翻译'],['summarize','总结']];
const STATUS={recorded:'已记录',partial:'信息不全',absent:'缺少记录'};

// A batch audit covers several archives at once. Each row comes straight from the
// per-recording provenance the server already redacts; a failed archive keeps its
// own error row so a silent omission cannot pass as a clean audit.
export default function AnalysisProvenanceBatch({ids=[]}){
  const [data,setData]=useState(null),[busy,setBusy]=useState(false),[error,setError]=useState('');
  async function load(){
    setBusy(true);setError('');
    try{setData(payload(await adminApi.post('/analysis/provenance/batch',{ids})));}
    catch(e){setError(errorMessage(e));setData(null);}
    finally{setBusy(false);}
  }
  const rows=data&&Array.isArray(data.recordings)?data.recordings:[];
  return <section className="card analysis-provenance" aria-labelledby="batch-provenance">
    <div className="provenance-heading">
      <div>
        <div className="detail-eyebrow">来源核查</div>
        <h2 id="batch-provenance">整批来源清单</h2>
        <p>一次核对选中的 {ids.length} 条归档：各阶段记录了什么、缺了什么。读取失败的归档会单独列出，不会被悄悄跳过。</p>
      </div>
      <div className="provenance-actions">
        <button type="button" className="btn btn-secondary btn-sm" onClick={load} disabled={busy||!ids.length}>{busy?'正在汇总…':'生成整批来源清单'}</button>
        {data&&<button type="button" className="btn btn-secondary btn-sm" onClick={()=>{setBusy(true);setError('');adminApi.post('/analysis/provenance/batch',{ids,format:'csv'},{responseType:'blob'}).then(response=>{const url=URL.createObjectURL(response.data);const link=document.createElement('a');link.href=url;link.download='analysis-provenance-batch.csv';link.click();URL.revokeObjectURL(url);}).catch(e=>setError(errorMessage(e))).finally(()=>setBusy(false));}} disabled={busy}>下载表格（CSV）</button>}
      </div>
    </div>
    {error&&<p role="alert" className="provenance-error">{error}</p>}
    {data&&<div className="provenance-body">
      <p role="status" className="provenance-muted">已汇总 {rows.length} 条归档 · 导出时间 {data.exportedAt?new Date(data.exportedAt).toLocaleString('zh-CN'):'—'}</p>
      <table className="provenance-table" aria-label="整批来源清单">
        <thead><tr><th scope="col">归档</th><th scope="col">阶段</th><th scope="col">状态</th><th scope="col">服务</th><th scope="col">模型</th></tr></thead>
        <tbody>{rows.flatMap((entry,index)=>{
          if(entry.error)return [<tr key={`e${index}`}><th scope="row">{entry.recordingId||'未识别编号'}</th><td colSpan={4} className="provenance-muted">{entry.error}</td></tr>];
          const stages=(entry.provenance&&entry.provenance.stages)||[];
          return STAGES.map(([key,label])=>{
            const stage=stages.find(s=>s.stage===key)||{status:'absent'};
            return <tr key={`${entry.recordingId}:${key}`}><th scope="row">{entry.recordingId}</th><td>{label}</td><td>{STATUS[stage.status]||STATUS.absent}</td><td>{stage.provider||'—'}</td><td>{stage.model||(stage.fingerprint?'未记录模型':'—')}</td></tr>;
          });
        })}</tbody>
      </table>
    </div>}
  </section>;
}
