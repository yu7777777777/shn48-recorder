"use strict";
const settings = require('./settings');
let running = false;
async function test(input) {
  const config = settings.connection('ai', input);
  if (!config.model || config.model.length > 120) throw new Error('请先选择模型');
  if (running) throw Object.assign(new Error('已有文本测试正在进行，请稍候'), {statusCode:409});
  running = true;
  const start = Date.now();
  const result = data => JSON.parse(JSON.stringify({model:config.model,elapsedMs:Date.now()-start,...data}).split(config.key).join('[已隐藏]'));
  try {
    let response;
    try {
      response = await fetch(`${config.url}/chat/completions`, {method:'POST',redirect:'error',signal:AbortSignal.timeout(60000),headers:{'Content-Type':'application/json',Authorization:`Bearer ${config.key}`},body:JSON.stringify({model:config.model,stream:false,messages:[{role:'user',content:'这是连接测试，请只回复：连接正常。'}]})});
    } catch { return result({status:'connection_error',message:'连接失败或 60 秒内未收到结果，请检查服务地址和网络。没有自动重试。'}); }
    if (!response.ok) {
      await response.body?.cancel();
      const code=response.status;
      const message=[401,403].includes(code)?'服务拒绝访问，请检查密钥及模型权限。':code===429?'请求受限，可能是额度不足或频率限制，请检查服务商后台。':[404,405].includes(code)?'未找到聊天接口或所选模型，请检查服务地址及模型名称。':[400,422].includes(code)?'服务拒绝了聊天请求，请确认该模型支持当前聊天接口。':`服务返回错误（HTTP ${code}），请稍后再试。`;
      return result({status:'request_rejected',httpStatus:code,message});
    }
    let data;
    try {
      const reader=response.body.getReader(),chunks=[];let size=0;
      while(true){const {value,done}=await reader.read();if(done)break;size+=value.length;if(size>200000){await reader.cancel();throw Error();}chunks.push(Buffer.from(value));}
      data=JSON.parse(Buffer.concat(chunks).toString('utf8'));
    } catch { return result({status:'invalid_response',message:'服务未返回有效 JSON，或响应超时、过大，无法确认连接可用。'}); }
    const content=data?.choices?.[0]?.message?.content;
    const text=typeof content==='string'?content.trim():'';
    if(!text) return result({status:'empty',message:'接口已响应，但没有返回文本回复，暂不能确认模型可用。'});
    return result({status:'connected',message:'模型已正常返回文本，当前聊天连接可用。此测试不代表长字幕分析或结构化输出已验证。',text:text.slice(0,2000)});
  } finally {running=false;}
}
module.exports={test};
