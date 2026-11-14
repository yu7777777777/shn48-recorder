"use strict";
function parse(text, duration) {
  if (typeof text !== 'string' || Buffer.byteLength(text,'utf8') > 1000000) throw new Error('字幕须为 UTF-8 文本，最大 1 MB');
  if (text.includes('\ufffd') || text.includes('\0')) throw new Error('字幕编码异常，请另存为 UTF-8 SRT');
  const blocks=text.replace(/^\ufeff/,'').replace(/\r\n?/g,'\n').trim().split(/\n[ \t]*\n/);
  if (!text.trim() || blocks.length>10000) throw new Error('请选择包含 1 至 10000 条字幕的 SRT 文件');
  const time=t=>{const m=/^(\d{2,3}):([0-5]\d):([0-5]\d)[,.](\d{3})$/.exec(t);if(!m)throw new Error('字幕时间格式无效');return +m[1]*3600 + +m[2]*60 + +m[3] + +m[4]/1000;};
  const segments=blocks.map((block,i)=>{
    const lines=block.split('\n');if(/^\d+$/.test(lines[0].trim()))lines.shift();
    const match=/^\s*(\S+)\s*-->\s*(\S+)\s*$/.exec(lines.shift()||'');
    if(!match)throw new Error(`第 ${i+1} 条字幕缺少有效时间范围`);
    const start=time(match[1]),end=time(match[2]),content=lines.join('\n').trim();
    if(end<=start || end>duration+.5)throw new Error(`第 ${i+1} 条字幕时间无效或超出归档时长`);
    if(!content||content.length>10000)throw new Error(`第 ${i+1} 条字幕为空或过长`);
    return {start,end:Math.min(end,duration),text:content};
  }).sort((a,b)=>a.start-b.start);
  return segments;
}
module.exports={parse};
