'use strict';
// Audit-only guard; no production source is changed.
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),net=require('node:net');
const audit=__dirname,project=path.resolve(audit,'../../..');
const root=process.env.SHN48_AUDIT_ROOT;if(!root)throw Error('SHN48_AUDIT_ROOT required');
const inside=(p,r)=>p===r||p.startsWith(r+path.sep);
const resolve=p=>typeof p==='string'||Buffer.isBuffer(p)?path.resolve(String(p)):p instanceof URL?require('node:url').fileURLToPath(p):null;
function writable(p){const full=resolve(p);if(full&&!inside(full,path.resolve(os.tmpdir()))&&!inside(full,audit))throw Error('AUDIT_WRITE_BLOCKED '+full);}
for(const key of ['writeFileSync','appendFileSync','mkdirSync','rmSync','rmdirSync','unlinkSync','truncateSync','chmodSync','utimesSync','createWriteStream']){const old=fs[key];if(old)fs[key]=function(p,...args){writable(p);return old.call(this,p,...args);};}
for(const key of ['renameSync','copyFileSync','linkSync','symlinkSync']){const old=fs[key];if(old)fs[key]=function(from,to,...args){writable(to);if(key==='renameSync')writable(from);return old.call(this,from,to,...args);};}
const forbidden=[path.join(project,'app/server/runtime'),path.join(project,'app/config')];
for(const key of ['readFileSync','createReadStream']){const old=fs[key];fs[key]=function(p,...args){const full=resolve(p);if(full&&forbidden.some(r=>inside(full,r)))throw Error('AUDIT_READ_BLOCKED '+full);return old.call(this,p,...args);};}
const connect=net.Socket.prototype.connect;
net.Socket.prototype.connect=function(...args){let o=args[0];if(Array.isArray(o))o=o[0];const host=typeof o==='object'?o.host:typeof args[1]==='string'?args[1]:'localhost';if(host&&!['localhost','127.0.0.1','::1'].includes(host))throw Error('AUDIT_NETWORK_BLOCKED '+host);return connect.apply(this,args);};
const originalFetch=global.fetch;
if(originalFetch)global.fetch=function(input,...args){const u=new URL(typeof input==='string'||input instanceof URL?input:input.url);if(!['localhost','127.0.0.1','[::1]'].includes(u.hostname))throw Error('AUDIT_NETWORK_BLOCKED '+u.hostname);return originalFetch.call(this,input,...args);};
process.env.PYTHONDONTWRITEBYTECODE='1';
process.env.HOME=path.join(root,'home');process.env.USERPROFILE=process.env.HOME;
process.env.DATA_DIR=process.env.DATA_DIR||path.join(root,'data');
process.env.RECORDINGS_DIR=process.env.RECORDINGS_DIR||path.join(root,'recordings');
process.env.CONFIG_PATH=path.join(root,'absent-config.yaml');
process.env.COOKIES_PATH=path.join(root,'absent-bili-cookies.json');
process.env.DDTALKS_DOWNLOAD_DIR=path.join(root,'ddtalks');
process.env.STREAM_RELAY_DIR=path.join(root,'relays');
delete process.env.DEBUG_ANALYSIS;
for(const p of [process.env.HOME,process.env.DATA_DIR,process.env.RECORDINGS_DIR])fs.mkdirSync(p,{recursive:true});
// Explicit non-secret fixtures; do not inherit real host values.
process.env.ADMIN_USERNAME='audit-admin';process.env.ADMIN_PASSWORD='audit-password';process.env.SESSION_SECRET='audit-session-fixture-20261029';
for(const k of ['ALIYUN_ACCESS_KEY_ID','ALIYUN_ACCESS_KEY_SECRET','OSS_ACCESS_KEY_ID','OSS_ACCESS_KEY_SECRET','P115_COOKIES','P115_COOKIES_PATH'])delete process.env[k];
