"use strict";
const fail=message=>Object.assign(new Error(message),{statusCode:400});
function validate(rows,batch,offset){
  if(!Array.isArray(rows)||rows.length!==batch.length)throw fail('纠错结果条数不匹配，原字幕未修改');
  const map=new Map(rows.map(r=>[r?.id,r?.text]));
  if(map.size!==batch.length||batch.some((s,i)=>typeof map.get(offset+i)!=='string'||!map.get(offset+i).trim()||map.get(offset+i).length>10000))throw fail('纠错结果缺少原句或格式异常，原字幕未修改');
  // 英文、日文及翻译来源记录都描述纠错前的原文，纠错后一律清掉（与手动编辑
  // service.editSegment 一致），否则界面与 ja/ja-bilingual 导出会展示旧译文。
  return batch.map((s,i)=>({...s,originalText:s.originalText??s.text,text:map.get(offset+i).trim(),en:undefined,enJA:undefined,enSource:undefined,translation:undefined}));
}
// Bounded per-request work for the correction pass. A retry re-sends the same
// batch with the same danmaku, so an unbounded capture window would turn one
// paid retry into an unbounded cost. Counted in UTF-16 units (never bytes) so
// the limit is reproducible and never inflated by multibyte text.
const BUDGET={maxSegments:40,maxSegmentChars:10000,maxDanmaku:1200000,maxGlossary:20000,windowMs:0};
async function budgeted(batch,{danmaku,glossary}={},limit=BUDGET){
  const rows=Array.isArray(batch)?batch:[];const notes=Array.isArray(danmaku)?danmaku:[];const terms=(Array.isArray(glossary)?glossary:[]).filter(item=>item&&item.enabled!==false);
  if(rows.length>limit.maxSegments)throw fail(`单次纠错最多 ${limit.maxSegments} 条字幕，请缩小范围`);
  let chars=0;
  for(const row of rows){const text=String(row?.text??'');if(text.length>limit.maxSegmentChars)throw fail('单条字幕超出单次纠错上限，请先拆分');chars+=text.length;}
  if(notes.length>limit.maxDanmaku)throw fail(`单次纠错最多 ${limit.maxDanmaku} 条弹幕参考`);
  const glossaryChars=JSON.stringify(terms).length;
  if(glossaryChars>limit.maxGlossary)throw fail(`单次纠错词库参考超过 ${limit.maxGlossary} 字符上限，请精简词库`);
  return {segments:rows.length,chars,danmaku:notes.length,glossary:terms.length,glossaryChars,maxSegments:limit.maxSegments,maxSegmentChars:limit.maxSegmentChars,maxDanmaku:limit.maxDanmaku,maxGlossary:limit.maxGlossary,windowMs:limit.windowMs};
}
module.exports={BUDGET,budgeted,validate};