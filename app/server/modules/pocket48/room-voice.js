"use strict";
const fs=require('fs'),path=require('path'),{spawn}=require('child_process');
const api=require('./api'),account=require('./account'),manager=require('../recorder/manager');
const store=require('../../lib/store'),{write}=require('../analysis/settings');
const active=new Map(),starting=new Set();
let watches=store.load('voice_watches',[]),timer,stopped=true,polling=false;
const fail=(m,s=400)=>Object.assign(new Error(m),{statusCode:s});
function messageKey(id){if(!/^[\w-]{1,100}$/.test(id))throw fail('无效归档 ID');return `voice_messages_${id}`;}
function messages(id){const r=manager.getRecording(id);if(!r||r.status==='deleted')throw fail('归档不存在',404);return store.load(messageKey(id),[]);}
function validStream(value){let u;try{u=new URL(value);}catch{throw fail('上麦尚未开始或未返回音频地址');}if(!['https:','http:','rtmp:','rtmps:'].includes(u.protocol)||u.username||u.password||/^(localhost|127\.|0\.|10\.|192\.168\.|169\.254\.|\[)/i.test(u.hostname))throw fail('语音流地址无效');return u.href;}
async function capture(entry){
  if(entry.fetching)return;entry.fetching=true;
  try{
    const rows=account.messages(account.content(await api.getRoomMessages(entry.roomId,0,'all')));
    for(const msg of rows){let time=Number(msg.msgTime||msg.messageTime);if(time>0&&time<1e12)time*=1000;
      if(!Number.isFinite(time)||time<entry.startedAt||time>Date.now()+5000)continue;
      const id=String(msg.msgIdClient||msg.msgidClient||msg.msgId||JSON.stringify([time,msg.bodys,msg.content]));
      if(entry.seen.has(id))continue;entry.seen.add(id);entry.messages.push({...msg,offset:(time-entry.startedAt)/1000});
    }
    entry.messages.sort((a,b)=>a.offset-b.offset); if(entry.messages.length>20000)entry.messages=entry.messages.slice(-20000);
    write(messageKey(entry.id),entry.messages);manager.updateRecording(entry.id,{messageCount:entry.messages.length,messageError:null});
  }catch{manager.updateRecording(entry.id,{messageError:'房间消息同步失败，音频继续录制'});}finally{entry.fetching=false;}
}
async function record(room){
  const roomId=account.roomId(room.roomId),ownerId=account.roomId(room.ownerId);
  if(stopped)throw fail('语音录制服务尚未启动',409);
  if(active.has(roomId))return manager.getRecording(active.get(roomId).id);
  if(starting.has(roomId))throw fail('正在连接上麦',409);
  if(active.size+starting.size>=3)throw fail('同时最多录制 3 个房间',429);
  starting.add(roomId);
  try{
    const info=account.content(await api.getRoomVoice(roomId,ownerId)),url=validStream(info.streamUrl);
    if(stopped)throw fail('服务正在停止',409);
    const dir=path.resolve(require('./recorder')._internals.recordingsDir());fs.mkdirSync(dir,{recursive:true});
    const name=String(room.ownerName||room.roomName||ownerId).slice(0,80),startedAt=Date.now();
    const r=manager.addRecording({source:'room_voice',mediaType:'audio',memberId:ownerId,memberName:name,roomId,title:`${name} · 房间上麦 · ${new Date().toISOString().slice(0,10)}`,status:'recording',startedAt:new Date(startedAt).toISOString()});
    const file=path.join(dir,`${r.id}.m4a`);manager.updateRecording(r.id,{filePath:file,container:'m4a'});
    const child=spawn(process.env.FFMPEG_BIN||'ffmpeg',['-hide_banner','-loglevel','error','-y','-rw_timeout','20000000','-i',url,'-vn','-ac','1','-c:a','aac','-b:a','96k','-movflags','frag_keyframe+empty_moov','-t','21600',file],{windowsHide:true,stdio:['pipe','ignore','ignore']});
    child.stdin.on('error',()=>{});
    let resolve;const entry={id:r.id,roomId,child,startedAt,messages:[],seen:new Set(),done:new Promise(r=>{resolve=r;}),manual:false};active.set(roomId,entry);
    entry.timer=setInterval(()=>void capture(entry),15000);void capture(entry);
    let finished=false;
    const finish=async(code)=>{if(finished)return;finished=true;clearInterval(entry.timer);clearTimeout(entry.killTimer);
      let duration=0;try{const output=await require('../analysis/service')._internals.execute(process.env.FFPROBE_BIN||'ffprobe',['-v','error','-show_format','-of','json',file],false);duration=Number(JSON.parse(output).format.duration)||0;}catch{}
      const size=fs.existsSync(file)?fs.statSync(file).size:0;
      manager.updateRecording(r.id,{status:duration>0&&size>0?'done':'failed',duration,fileSize:size,endedAt:new Date().toISOString(),manualStop:entry.manual,recordingWarning:code!==0&&!entry.manual?'语音流中断，已保留可播放部分':null,error:duration>0?null:'未收到有效音频，请确认成员正在上麦'});
      active.delete(roomId);
      if(duration>0&&size>0){try{await require('../recorder/covers').generate(manager.getRecording(r.id));}catch(error){manager.updateRecording(r.id,{coverError:error.message});}}
      resolve();
    };
    child.once('error',()=>void finish(-1));child.once('close',code=>void finish(code));return r;
  }finally{starting.delete(roomId);}
}
async function stop(roomId,manual=true){const entry=active.get(String(roomId));if(!entry)return;if(manual){const w=watches.find(w=>w.roomId===String(roomId));if(w){w.enabled=false;write('voice_watches',watches);}}entry.manual=manual;try{entry.child.stdin.write('q\n');}catch{}entry.killTimer=setTimeout(()=>entry.child.kill('SIGKILL'),8000);return entry.done;}
function status(){return {watches,active:[...active.values()].map(e=>({roomId:e.roomId,recording:manager.getRecording(e.id)}))};}
function saveWatch(input){const roomId=account.roomId(input.roomId),ownerId=account.roomId(input.ownerId);let item=watches.find(w=>w.roomId===roomId);if(!item){if(watches.length>=20)throw fail('最多监测 20 个房间');item={roomId};watches.push(item);}Object.assign(item,{ownerId,ownerName:String(input.ownerName||'').slice(0,80),enabled:input.enabled===true,error:null});write('voice_watches',watches);return status();}
function removeWatch(id){watches=watches.filter(w=>w.roomId!==id);write('voice_watches',watches);return status();}
async function poll(){if(polling||stopped)return;polling=true;try{for(const w of watches.filter(w=>w.enabled)){if(stopped)break;if(active.has(w.roomId))continue;try{await record(w);w.error=null;}catch{w.error='暂未发现可录制上麦，等待下一次检查';}w.checkedAt=new Date().toISOString();}write('voice_watches',watches);}finally{polling=false;}}
function start(){stopped=false;timer=setInterval(()=>void poll(),60000);void poll();}
async function stopAll(){stopped=true;clearInterval(timer);await Promise.allSettled([...active.keys()].map(id=>stop(id,false)));}
module.exports={record,stop,status,saveWatch,removeWatch,messages,start,stopAll,_internals:{validStream}};
