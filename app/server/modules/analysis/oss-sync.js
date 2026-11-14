'use strict';
// Explicit, optional OSS synchronization. No startup hooks, background workers,
// retries, recording mutations, or external calls are triggered by importing it.
const oss = require('./oss-adapter');
let transport, environment, timeoutMs;
let lastErrorCode = null;
const SAFE_CODES = new Set(['oss_upload_failed','oss_delete_failed','oss_head_failed','oss_sign_failed']);
const config = () => environment === undefined ? process.env : environment;
function snapshot() { return oss.inspect(config()); }
function isEnabled() { return snapshot().enabled; }
function status() {
  const state = snapshot();
  return {enabled:state.enabled,bucket:state.bucket,endpointHost:state.enabled?new URL(state.endpoint).hostname:'',prefix:state.prefix,lastErrorCode};
}
function skipped() {return {skipped:true,reason:'OSS 未启用或配置不完整'};}
function recordingKey(recording,state) {
  if(!recording || !/^[A-Za-z0-9_-]{1,100}$/.test(String(recording.id || '')))throw Object.assign(new Error('归档编号无效，无法生成 OSS 对象键'),{code:'oss_sign_failed',statusCode:400});
  try {return oss.objectKey(state.prefix,'recordings',String(recording.id)+'.mp4');}
  catch {throw Object.assign(new Error('生成 OSS 对象键失败'),{code:'oss_sign_failed',statusCode:400});}
}
function options() {return {env:config(),...(transport?{transport}:{}),...(timeoutMs===undefined?{}:{timeoutMs})};}
async function perform(recording,deleting) {
  const state=snapshot();if(!state.enabled)return skipped();
  try {
    const key=recordingKey(recording,state);
    let result;
    if(deleting)result=await oss.remove(key,options());
    else {
      if(recording.status!=='done')throw Object.assign(new Error('请等待归档完成后再上传 OSS'),{code:'oss_upload_failed',statusCode:409});
      // Reuse the local archive boundary; never upload an arbitrary admin-supplied
      // filesystem path. This layer does not transcode audio/TS into MP4.
      let file;
      try {file=require('../recorder/archive-processor')._internals.resolveSource(recording.filePath);}
      catch {throw Object.assign(new Error('归档文件不存在或不在录像目录中'),{code:'oss_upload_failed',statusCode:400});}
      if(require('node:path').extname(file).toLowerCase()!=='.mp4')throw Object.assign(new Error('OSS 归档同步只接受已完成的 MP4 文件'),{code:'oss_upload_failed',statusCode:400});
      result=await oss.upload(file,key,options());
    }
    lastErrorCode=null;return result;
  } catch(error) {
    lastErrorCode=SAFE_CODES.has(error?.code)?error.code:(deleting?'oss_delete_failed':'oss_upload_failed');
    // Local checks and adapter errors are already constant safe messages. Any
    // unforeseen exception is replaced, never propagated with a path or secret.
    if(SAFE_CODES.has(error?.code))throw error;
    throw Object.assign(new Error(deleting?'删除 OSS 归档失败':'上传 OSS 归档失败'),{code:lastErrorCode,statusCode:502});
  }
}
module.exports={
  isEnabled,status,uploadRecording:recording=>perform(recording,false),deleteRecording:recording=>perform(recording,true),
  _internals:{
    setTransport(fn){if(fn!==undefined&&typeof fn!=='function')throw new TypeError('transport must be a function');transport=fn;},
    setEnvironment(value){environment=value;lastErrorCode=null;},
    setTimeoutMs(value){timeoutMs=value;},
  }
};
