'use strict';
const {createHash} = require('node:crypto');
const BACKOFF=[5,15,60].map(minutes=>minutes*60000);
function policy(config) {const q=config.queue||{};return {autoRetry:q.autoRetry===true,resumeInterrupted:q.resumeInterrupted===true,maxRetries:Number.isInteger(q.maxRetries)&&q.maxRetries>=0&&q.maxRetries<=3?q.maxRetries:3};}
function fingerprint(config,kind) {const c=config[kind==='transcribe'?'asr':'ai']||{};return createHash('sha256').update(JSON.stringify([c.url,c.model,kind==='transcribe'?config.offline:null])).digest('hex');}
function counters(job) {job.retryCount=Number.isInteger(job.retryCount)&&job.retryCount>=0?job.retryCount:0;job.attempts=Number.isInteger(job.attempts)&&job.attempts>=0?job.attempts:job.status==='running'?1:0;job.attempt=job.attempts;}
// 模型这一次少写了一小段（覆盖校验报"遗漏"），下一次重新生成大概率能补齐。
// 这类失败以前不算可重试，于是一旦模型手滑整段任务就失败了。
function retryable(error) {
  const status=Number(error.httpStatus);
  if(status===408||status===429||(status>=500&&status<=599)||error.networkError===true) return true;
  const message=String(error&&error.message||'');
  return /遗漏字幕时间窗口|返回格式无效|章节时间、长度或 schema 无效/.test(message);
}
function retry(job,error,config,now) {
  counters(job);const p=policy(config);
  if(!p.autoRetry||job.retryCount>=p.maxRetries||!retryable(error)||job.cancelled||job.configFingerprint!==fingerprint(config,job.kind))return false;
  const hint=Number(error.retryAfterMs);const delay=Math.max(BACKOFF[job.retryCount],Math.min(86400000,Number.isFinite(hint)?Math.max(0,hint):0));
  job.retryCount++;job.status='queued';job.nextAttemptAt=new Date(now+delay).toISOString();job.retryMode='automatic';job.phase='等待自动重试';delete job.endedAt;return true;
}
function recover(jobs,config,now) {
  for(const job of jobs){counters(job);if(job.status!=='running')continue;
    const p=policy(config);job.recovery={interruptedAt:new Date(now).toISOString(),resumed:false};
    if(!job.cancelled&&p.resumeInterrupted&&job.retryCount<p.maxRetries&&(!job.configFingerprint||job.configFingerprint===fingerprint(config,job.kind))){
      job.retryCount++;job.status='queued';job.recovered=true;job.recovery.resumed=true;job.retryMode='recovery';job.configFingerprint=fingerprint(config,job.kind);delete job.nextAttemptAt;delete job.endedAt;
    }else {job.status='failed';job.error='服务重启中断任务，请手动重试；已完成字幕与摘要断点保留';job.endedAt=new Date(now).toISOString();delete job.nextAttemptAt;}
  }
}
function allowed(job,config) {const p=policy(config);return !job.retryMode||((job.retryMode==='automatic'?p.autoRetry:p.resumeInterrupted)&&job.retryCount<=p.maxRetries&&job.configFingerprint===fingerprint(config,job.kind));}
function next(jobs,now) {return jobs.find(j=>j.status==='queued'&&!j.retryMode)||jobs.find(j=>j.status==='queued'&&(!j.nextAttemptAt||Date.parse(j.nextAttemptAt)<=now));}
// Cap history, never durable work. Filtering in place-order preserves FIFO.
function compact(jobs,historyLimit=300) {
  let remaining=historyLimit;
  const keep=new Set();
  for(let i=jobs.length-1;i>=0;i--){const job=jobs[i];if(job.status==='queued'||job.status==='running'||remaining-- > 0)keep.add(i);}
  return jobs.filter((_,index)=>keep.has(index));
}
// Glossary edits (order, disabled rows, unused aliases) used to invalidate the ASR
// checkpoint even though the online request carries no hotwords. Identity is now
// a stable hash of enabled rows only, so those no-op edits rebuild nothing.
function glossaryFingerprint(glossary, kind) {
  if (kind !== 'transcribe' || !Array.isArray(glossary)) return null;
  const rows = glossary.filter(row => row && (row.enabled === undefined || row.enabled === null || row.enabled === true || row.enabled === 'true') && String(row.term || '').trim())
    .map(row => [String(row.term).trim(), String(row.aliases || '').trim()]);
  const seen = new Set();
  const unique = rows.filter(([term, aliases]) => { const key = `${term}\u0000${aliases}`; if (seen.has(key)) return false; seen.add(key); return true; });
  unique.sort((a, b) => a[0].localeCompare(b[0]) || a[1].localeCompare(b[1]));
  return createHash('sha256').update(JSON.stringify(unique)).digest('hex');
}
function wakeAt(jobs) {return Math.min(...jobs.filter(j=>j.status==='queued'&&j.nextAttemptAt).map(j=>Date.parse(j.nextAttemptAt)).filter(Number.isFinite));}
function createWakeup({now=Date.now,setTimer=setTimeout,clearTimer=clearTimeout,wake}) {let timer;return {clear(){if(timer)clearTimer(timer);timer=null;},arm(at){this.clear();if(Number.isFinite(at)){timer=setTimer(()=>{timer=null;wake();},Math.max(0,at-now()));timer?.unref?.();}}};}
// A read-only health view for the administrator: how much work is stuck behind a
// closed switch, how much is dormant, and what recovery did on the last start.
// Counts only — no payloads, credentials, hosts or file paths.
function health(jobs,config,now=Date.now()) {
  const rows=Array.isArray(jobs)?jobs.filter(j=>j&&typeof j==='object'):[];
  const p=policy(config);
  const count=(fn)=>rows.filter(fn).length;
  const dormant=rows.filter(j=>j.status==='queued'&&j.nextAttemptAt&&Date.parse(j.nextAttemptAt)>now);
  return {
    localOnly:true,
    policy:{autoRetry:p.autoRetry,resumeInterrupted:p.resumeInterrupted,maxRetries:p.maxRetries},
    queued:count(j=>j.status==='queued'),
    running:count(j=>j.status==='running'),
    done:count(j=>j.status==='done'),
    failed:count(j=>j.status==='failed'),
    // Work waiting on a switch the administrator turned off would otherwise look
    // like an unexplained queue that never moves.
    blockedByDisallowedPolicy:count(j=>j.status==='queued'&&!allowed(j,config)),
    dormantRetries:dormant.length,
    nextWakeAt:dormant.length?new Date(Math.min(...dormant.map(j=>Date.parse(j.nextAttemptAt)))).toISOString():null,
    recoveredLastStart:count(j=>Boolean(j.recovery&&j.recovery.resumed===true)),
    interruptedLastStart:count(j=>Boolean(j.recovery&&j.recovery.interruptedAt&&j.recovery.resumed!==true))
  };
}
module.exports={BACKOFF,policy,fingerprint,glossaryFingerprint,counters,retryable,retry,recover,allowed,next,compact,health,wakeAt,createWakeup};
