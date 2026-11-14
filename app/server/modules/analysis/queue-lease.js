'use strict';
// Local disk, one host and one PID namespace only. This is not a distributed lease.
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const {randomUUID} = require('node:crypto');
function namespace() { try { return fs.readlinkSync('/proc/self/ns/pid'); } catch { return 'native'; } }
const conflict = message => Object.assign(new Error(message), {statusCode:409, code:'ANALYSIS_OWNER'});
module.exports = function createLease({directory, now=Date.now, setTimer=setInterval, clearTimer=clearInterval, onLost=()=>{}, heartbeatMs=2000, ttlMs=15000}={}) {
  const directoryLock=path.join(directory,'.analysis-worker'), ownerPath=path.join(directoryLock,'owner.json'), gate=path.join(directory,'.analysis-worker-reclaim');
  const identity={host:os.hostname(), namespace:namespace(), pid:process.pid, token:randomUUID()};
  let held=false, timer;
  const read=()=>JSON.parse(fs.readFileSync(ownerPath,'utf8'));
  const same=owner=>owner.token===identity.token && owner.pid===identity.pid && owner.host===identity.host && owner.namespace===identity.namespace;
  function lose() { const was=held; held=false; if(timer)clearTimer(timer);timer=null;if(was)onLost(); }
  function assertOwned() { try {if(!held || !same(read()))throw conflict('分析 worker 所有权已丢失，已停止任务');}catch(e){lose();throw e.code==='ANALYSIS_OWNER'?e:conflict('无法确认分析 worker 所有权，已停止任务');} }
  function writeOwner() { require('../../lib/store').atomicWrite(ownerPath,{...identity,heartbeatAt:now(),expiresAt:now()+ttlMs}); }
  function create() {
    fs.mkdirSync(directoryLock);
    try {writeOwner();held=true;} catch(e) {try{fs.rmSync(directoryLock,{recursive:true,force:true});}catch{}throw e;}
  }
  function acquire() {
    if(held){assertOwned();return;}
    fs.mkdirSync(directory,{recursive:true});
    if(fs.existsSync(gate))throw conflict('分析 worker 回收门闩存在；请确认旧进程退出后人工检查本地数据目录');
    try {create();} catch(e) {
      if(e.code!=='EEXIST')throw e;
      try {fs.mkdirSync(gate);}catch{throw conflict('另一个分析 worker 正在持有或回收此数据目录');}
      try {
        let owner;try{owner=read();}catch{throw conflict('分析 worker 锁缺少有效 owner，拒绝自动删除');}
        if(owner.host!==identity.host || owner.namespace!==identity.namespace)throw conflict('分析队列仅支持同主机同 PID 命名空间；拒绝回收其他主机/容器的锁');
        if(!Number.isInteger(owner.pid)||owner.pid<=0)throw conflict('分析 worker owner 无效，拒绝自动删除');
        let alive=true;try{process.kill(owner.pid,0);}catch(err){if(err.code==='ESRCH')alive=false;}
        // Never steal from a live process, even if its heartbeat has expired.
        if(alive)throw conflict('此数据目录已有活跃分析 worker');
        fs.rmSync(directoryLock,{recursive:true});create();
      } finally {fs.rmdirSync(gate);}
    }
    timer=setTimer(()=>{try{assertOwned();writeOwner();}catch{lose();}},heartbeatMs);timer?.unref?.();
    process.once('exit',release);
  }
  function release() {
    if(timer)clearTimer(timer);timer=null;
    try{if(same(read()))fs.rmSync(directoryLock,{recursive:true,force:true});}catch{}held=false;
    process.removeListener('exit',release);
  }
  return {acquire,assertOwned,release,isHeld:()=>held,ownerPath};
};
