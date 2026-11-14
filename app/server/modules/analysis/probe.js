"use strict";
const fs = require('fs');
const path = require('path');
const settings = require('./settings');
const expectedText = '你好，这是语音识别测试。今天我们一起听音乐。';
const duration = 6.283;
let running = false;
function classify(data) {
  const segments = Array.isArray(data.segments) ? data.segments.filter(s => s && typeof s === 'object') : [];
  const text = String(data.text || segments.map(s => s.text || '').join('')).trim().slice(0, 2000);
  const timestamps = segments.length > 0 && segments.every(s => typeof s.start === 'number' && typeof s.end === 'number' && Number.isFinite(s.start) && Number.isFinite(s.end) && s.start >= 0 && s.end > s.start && s.end <= duration + 1 && typeof s.text === 'string' && s.text.trim());
  if (!text) return {status:'empty',message:'接口返回成功，但没有识别出文字，暂不能确认语音识别可用。',text,timestamps:false};
  return {status:timestamps?'compatible':'text_only',message:timestamps?'已返回转写文字和有效时间戳，符合当前字幕接口格式。请对照原文确认识别内容。':'已返回文字，但缺少有效的分句时间戳，暂不能用于当前字幕时间线。',text,timestamps,segments:segments.slice(0,20).map(s=>({start:typeof s.start==='number'?s.start:null,end:typeof s.end==='number'?s.end:null,text:String(s.text||'').slice(0,500)}))};
}
async function test(input) {
  const config = settings.connection('asr',input);
  if (!config.model || config.model.length > 120) throw new Error('请先选择模型');
  if (running) throw Object.assign(new Error('已有语音测试正在进行，请稍候'),{statusCode:409});
  running = true;
  const start = Date.now();
  const base = {model:config.model,expectedText,duration};
  try {
    const form = new FormData();
    form.set('file',new Blob([fs.readFileSync(path.join(__dirname,'../../assets/asr-test.wav'))],{type:'audio/wav'}),'asr-test.wav');
    form.set('model',config.model);form.set('response_format','verbose_json'); form.set('language','zh');form.append('timestamp_granularities[]','segment');
    let response;
    try { response = await fetch(`${config.url}/audio/transcriptions`,{method:'POST',redirect:'error',signal:AbortSignal.timeout(60000),headers:{Authorization:`Bearer ${config.key}`},body:form}); }
    catch { return {...base,status:'connection_error',message:'连接失败或 60 秒内未收到结果，请检查服务地址和网络。没有自动重试。'}; }
    if (!response.ok) {
      await response.body?.cancel();
      const code=response.status;
      const message = [401,403].includes(code)?'服务拒绝访问，请检查密钥和模型权限。':code===429?'请求受限，可能是额度不足或频率限制，请检查服务商后台。':[404,405].includes(code)?'服务未找到此转写接口或模型；请确认服务商是否提供音频转写。':[400,415,422].includes(code)?'服务拒绝转写参数，可能不支持所选模型、音频输入或带时间戳的输出格式。':`服务返回错误（HTTP ${code}），暂不能确认语音识别能力。`;
      return {...base,status:'request_rejected',httpStatus:code,message};
    }
    let data;
    try {
      const reader=response.body.getReader(),chunks=[];let size=0;
      while(true){const {done,value}=await reader.read();if(done)break;size+=value.length;if(size>200000){await reader.cancel();throw Error();}chunks.push(Buffer.from(value));}
      data=JSON.parse(Buffer.concat(chunks).toString('utf8'));if(!data||typeof data!=='object')throw Error();
    } catch { return {...base,status:'invalid_response',message:'服务未返回有效的转写 JSON，或响应过大；暂不能用于当前字幕识别。'}; }
    const result=classify(data);
    // Never expose a credential even if a broken upstream echoes it into its result.
    return JSON.parse(JSON.stringify({...base,...result,elapsedMs:Date.now()-start}).split(config.key).join('[已隐藏]'));
  } finally { running=false; }
}
module.exports={test,classify};
