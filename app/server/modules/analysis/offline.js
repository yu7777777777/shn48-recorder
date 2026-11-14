"use strict";
const fs=require('fs'),path=require('path'),{spawn}=require('child_process');
const store=require('../../lib/store');
const root=()=>process.env.OFFLINE_MODELS_DIR||path.join(store.dataDir,'asr-models');
const fail=(message,statusCode=400)=>Object.assign(new Error(message),{statusCode});
// Sizes are download figures for the pinned faster-whisper revisions in offline.py.
const catalog=[{id:'tiny',label:'tiny · 轻量快速',size:'约 75 MB'},{id:'base',label:'base · 更高精度',size:'约 145 MB'},{id:'small',label:'small · 最准确但更慢',size:'约 480 MB'}];
let installation=null,installing=false,active=false;
function valid(model){if(!catalog.some(m=>m.id===model))throw fail('离线模型无效');return model;}
function ready(model){valid(model);return fs.existsSync(path.join(root(),model,'.ready'));}
// True only while a capture is genuinely in flight.
//
// The gate reads the recorder's live session list when available, because that
// registry is authoritative: it is populated by `recorder.start()` and cleared in
// `finalize()`. The persisted status row is kept as the fallback for the older
// layout, and a row that never produced a file is ignored so a crashed capture
// whose row was left behind cannot wedge the gate shut.
function recording(){
  const manager=require('../recorder/manager');
  try {
    const live=require('../pocket48/recorder');
    if(typeof live.listActive==='function'&&live.listActive().length>0)return true;
  } catch { /* recorder not loaded; fall back below */ }
  return manager.getRecordings().some(r=>r.status==='recording'&&r.filePath);
}
function status(){return {engine:'faster-whisper',version:'1.2.1',device:'CPU / INT8 / 单线程',models:catalog.map(m=>({...m,installed:ready(m.id)})),installation,active};}
// `interruptOnRecording` used to SIGKILL a job that was already running as soon
// as any capture started, which turned "wait until the capture finishes" into
// "fail the transcription". The gate is enforced before a job starts (see
// `transcribe` and `waitForRecording` in service.js); once the engine is
// working, let it finish.
function worker(request,signal,interruptOnRecording=false){
  return new Promise((resolve,reject)=>{
    if(signal?.aborted)return reject(fail('离线任务已取消'));
    if(interruptOnRecording&&recording())return reject(fail('WAIT_RECORDING',409));
    const child=spawn(process.env.OFFLINE_PYTHON||'/opt/asr-venv/bin/python',[path.join(__dirname,'offline.py')],{windowsHide:true,stdio:['pipe','pipe','ignore'],env:{...process.env,PYTHONIOENCODING:'utf-8'}});
    let output='',reason=null,finished=false;
    const kill=message=>{reason=message;child.kill('SIGKILL');};
    const abort=()=>kill('离线任务已取消');signal?.addEventListener('abort',abort,{once:true});
    const timeout=setTimeout(()=>kill('离线任务超时，请稍后重试'),request.action==='install'?1800000:600000);
    function done(error,result){if(finished)return;finished=true;clearTimeout(timeout);signal?.removeEventListener('abort',abort);error?reject(error):resolve(result);}
    child.stdin.on('error',()=>{});child.stdout.on('data',b=>{output+=b;if(output.length>2000000)kill('离线结果过大');});
    child.once('error',()=>done(fail('离线引擎未安装或无法启动')));
    child.once('close',code=>{if(reason)return done(fail(reason));if(code!==0)return done(fail(request.action==='install'?'模型下载或验证失败，请检查网络和磁盘后重试':'离线识别失败，请检查模型安装状态或服务器资源'));try{done(null,JSON.parse(output));}catch{done(fail('离线引擎返回格式异常'));}});
    child.stdin.end(JSON.stringify({...request,root:root()}));
  });
}
function install(model){valid(model);if(installing||active)throw fail('离线引擎正在工作，请稍候',409);if(recording())throw fail('录制进行中，请结束后安装模型',409);if(ready(model))return status();
  installing=true;installation={model,status:'downloading',startedAt:new Date().toISOString()};
  void worker({action:'install',model}).then(()=>{installation={...installation,status:'done'};}).catch(e=>{installation={...installation,status:'failed',error:e.message};}).finally(()=>{installing=false;});return status();
}
async function transcribe(file,model,prompt,signal){valid(model);if(!ready(model))throw fail('请先安装所选离线模型');if(recording())throw fail('WAIT_RECORDING',409);if(installing||active)throw fail('离线引擎正在工作，请稍候',409);active=true;try{return await worker({action:'transcribe',file,model,prompt},signal,true);}finally{active=false;}}
async function test(model){if(recording())throw fail('录制进行中，请结束后测试',409);const started=Date.now();const result=await transcribe(path.join(__dirname,'../../assets/asr-test.wav'),model,'',AbortSignal.timeout(60000));return {...result,elapsedMs:Date.now()-started,expected:'你好，这是语音识别测试。今天我们一起听音乐。'};}
module.exports={status,install,transcribe,ready,recording,test};
