"use strict";
// Optional object-storage adapter ported from
// RuokeZhang/pocket48-summarizer (MIT, commit d5f45afeef1766e16525393e1beb13d24b2452ba,
// clients/oss_store.py). Optional configuration, object keys, V1 signing and
// explicit PUT/DELETE/HEAD operations. Tests inject transport; no automatic sync,
// retry, real credential lookup or external request is performed by importing it.
const crypto = require("crypto");
const fs = require("node:fs");
const path = require("node:path");
const { finished } = require("node:stream/promises");

const ENDPOINT = /^https:\/\/([a-z0-9-]+)\.([a-z0-9-]+)\.aliyuncs\.com\/?$/i;
const BUCKET = /^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/;
const KEY = /^[A-Za-z0-9!_.*'()\/\- ]{1,1023}$/;

function problem(message, code, statusCode = 400) { return Object.assign(new Error(message), { code, statusCode }); }

// Missing any one of the four values disables the adapter instead of failing later.
function inspect(env = process.env) {
  const id = String(env.ALIYUN_ACCESS_KEY_ID || "").trim();
  const secret = String(env.ALIYUN_ACCESS_KEY_SECRET || "").trim();
  const endpoint = String(env.ALIYUN_OSS_ENDPOINT || "").trim();
  const bucket = String(env.ALIYUN_OSS_BUCKET || "").trim();
  const missing = [];
  if (!id) missing.push("ALIYUN_ACCESS_KEY_ID");
  if (!secret) missing.push("ALIYUN_ACCESS_KEY_SECRET");
  if (!endpoint) missing.push("ALIYUN_OSS_ENDPOINT");
  if (!bucket) missing.push("ALIYUN_OSS_BUCKET");
  const state = { enabled: false, missing, endpoint: "", bucket: "", prefix: "", error: "" };
  if (missing.length) return state;
  const match = ENDPOINT.exec(endpoint);
  if (!match) { state.error = "OSS Endpoint 必须是 https://<bucket>.<region>.aliyuncs.com 形式"; return state; }
  if (!BUCKET.test(bucket)) { state.error = "OSS Bucket 名称无效"; return state; }
  if (match[1].toLowerCase() !== bucket.toLowerCase()) { state.error = "OSS Endpoint 与 Bucket 不一致"; return state; }
  return { enabled: true, missing: [], endpoint: endpoint.replace(/\/$/, ""), bucket, prefix: String(env.ALIYUN_OSS_PREFIX || ""), error: "" };
}

// Upstream keeps every object under a configurable prefix and refuses traversal.
function objectKey(prefix, name, value) {
  const parts = [String(prefix || "").replace(/^\/+|\/+$/g, ""), String(name || "").replace(/^\/+|\/+$/g, ""), String(value || "").replace(/^\/+/, "")]
    .filter(Boolean);
  const key = parts.join("/");
  if (!KEY.test(key) || key.split("/").some(segment => segment === "..")) throw problem("对象键无效", "invalid_object_key");
  return key;
}

// OSS V1 signing: base64(HMAC-SHA1(secret, VERB\nMD5\nTYPE\nDATE\nCanonicalizedOSSHeaders + CanonicalizedResource)).
// Slash-safe escaping keeps "/" readable in the query string, matching oss2 sign_url.
function sign({ method = "GET", bucket, key, secret, expires = 900, date, contentMD5 = "", contentType = "" }) {
  const expiresSeconds = Math.trunc(Number(expires));
  if (!Number.isFinite(expiresSeconds) || expiresSeconds <= 0 || expiresSeconds > 7 * 86400) {
    throw problem("签名有效期必须在 1 秒到 7 天之间", "invalid_expires");
  }
  if (!KEY.test(String(key))) throw problem("对象键无效", "invalid_object_key");
  const nonce = Math.trunc(expiresSeconds);
  const resource = `/${bucket}/${key}`;
  const stringToSign = [String(method).toUpperCase(), String(contentMD5), String(contentType), String(date || nonce), resource].join("\n");
  const signature = crypto.createHmac("sha1", String(secret)).update(stringToSign, "utf8").digest("base64");
  return { signature, nonce, resource, stringToSign };
}

function signedUrl({ endpoint, bucket, key, secret, expires = 900, method = "GET" }) {
  const { signature, nonce } = sign({ method, bucket, key, secret, expires });
  const base = String(endpoint).replace(/\/$/, "");
  const query = `OSSAccessKeyId=${encodeURIComponent(String(process.env.ALIYUN_ACCESS_KEY_ID || ""))}`
    + `&Expires=${nonce}&Signature=${encodeURIComponent(signature)}`;
  return `${base}/${String(key).split("/").map(encodeURIComponent).join("/")}?${query}`;
}

const DEFAULT_TIMEOUT_MS = 60000;
const CONTENT_TYPES = { '.mp4':'video/mp4', '.mp3':'audio/mpeg', '.m4a':'audio/mp4', '.wav':'audio/wav', '.png':'image/png', '.jpg':'image/jpeg', '.jpeg':'image/jpeg', '.json':'application/json' };

// Never attach a provider exception, response text, signed URL, or credentials to
// an error: callers may expose its message through the admin API or logs.
function operationError(method, timedOut = false, httpStatus) {
  const code = method === 'DELETE' ? 'oss_delete_failed' : method === 'HEAD' ? 'oss_head_failed' : 'oss_upload_failed';
  const action = method === 'DELETE' ? '删除 OSS 对象' : method === 'HEAD' ? '读取 OSS 对象状态' : '上传文件到 OSS';
  const error = problem(action + (timedOut ? '超时' : '失败') + (Number.isInteger(httpStatus) ? '（HTTP ' + httpStatus + '）' : ''), code, timedOut ? 504 : 502);
  if (Number.isInteger(httpStatus)) error.httpStatus = httpStatus;
  return error;
}

function createClient({ env = process.env, transport = (...args) => fetch(...args), timeoutMs = DEFAULT_TIMEOUT_MS, now = () => new Date(), setTimer = setTimeout, clearTimer = clearTimeout } = {}) {
  const state = inspect(env);
  const budget = Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : DEFAULT_TIMEOUT_MS;

  function authorization(method, key, contentMD5, contentType) {
    try {
      const id = String(env.ALIYUN_ACCESS_KEY_ID || '').trim();
      const secret = String(env.ALIYUN_ACCESS_KEY_SECRET || '').trim();
      if (!state.enabled || !/^[A-Za-z0-9_-]{1,256}$/.test(id) || !secret || !KEY.test(String(key)) || String(key).startsWith('/') || String(key).split('/').some(part => part === '.' || part === '..')) throw Error('invalid configuration');
      const date = now().toUTCString();
      const { signature } = sign({method,bucket:state.bucket,key,secret,date,contentMD5,contentType});
      return { url:state.endpoint + '/' + String(key).split('/').map(encodeURIComponent).join('/'), headers:{Date:date,Authorization:'OSS ' + id + ':' + signature} };
    } catch { throw problem('生成 OSS 请求签名失败', 'oss_sign_failed'); }
  }

  async function request(method, key, localPath) {
    let timer, body, bodyFinished, originalStat, controller = new AbortController(), timedOut = false, fileModified = false;
    const checkFile = async () => {
      let current;try {current=await fs.promises.stat(localPath);} catch {fileModified=true;throw operationError(method);}
      if(current.size!==originalStat.size || current.mtimeMs!==originalStat.mtimeMs || current.ctimeMs!==originalStat.ctimeMs || current.ino!==originalStat.ino || current.dev!==originalStat.dev){fileModified=true;throw operationError(method);}
    };
    const timeout = new Promise((_, reject) => {
      timer = setTimer(() => {timedOut = true;controller.abort();reject(operationError(method,true));}, budget);
    });
    const perform = async () => {
      // Validate before touching local media; a bad key cannot trigger a request.
      let contentMD5 = '', contentType = '', size;
      authorization(method,key,'','');
      if (method === 'PUT') {
        originalStat = await fs.promises.stat(localPath);
        if (!originalStat.isFile()) throw operationError(method);
        size = 0;
        contentType = CONTENT_TYPES[path.extname(String(localPath)).toLowerCase()] || 'application/octet-stream';
        const hash = crypto.createHash('md5');
        for await (const chunk of fs.createReadStream(localPath,{signal:controller.signal})) {hash.update(chunk);size+=chunk.length;}
        controller.signal.throwIfAborted();
        await checkFile();
        if(size!==originalStat.size){fileModified=true;throw operationError(method);}
        contentMD5 = hash.digest('base64');
      }
      const {url,headers} = authorization(method,key,contentMD5,contentType);
      if(method==='PUT')await checkFile();
      const options = {method,headers,signal:controller.signal,redirect:'manual'};
      let bodyError;
      if (method === 'PUT') {
        headers['Content-Type'] = contentType;
        headers['Content-MD5'] = contentMD5;
        headers['Content-Length'] = String(size);
        body = fs.createReadStream(localPath,{signal:controller.signal});
        bodyError = new Promise((_,reject) => body.once('error',reject));bodyError.catch(()=>{});
        bodyFinished = finished(body,{cleanup:true});bodyFinished.catch(()=>{});
        options.body = body;
        options.duplex = 'half';
      }
      controller.signal.throwIfAborted();
      const pending = Promise.resolve().then(() => transport(url,options));
      const response = await (bodyError ? Promise.race([pending,bodyError]) : pending);
      controller.signal.throwIfAborted();
      const status = response?.status;
      // No provider response body is needed. Cancel it rather than reading or
      // logging XML error payloads (which can echo signatures and access keys).
      try {await response?.body?.cancel?.();} catch {}
      if (status === 404 && method === 'DELETE') return {deleted:true,missing:true,key};
      if (status === 404 && method === 'HEAD') return {exists:false,key};
      if (!Number.isInteger(status) || status < 200 || status >= 300) throw operationError(method,false,Number.isInteger(status)?status:undefined);
      if(method==='PUT'){await bodyFinished;await checkFile();controller.signal.throwIfAborted();}
      if (method === 'HEAD') {
        const length = response.headers?.get?.('content-length');
        return {exists:true,key,size:length !== null && length !== undefined && Number.isSafeInteger(Number(length)) && Number(length) >= 0 ? Number(length) : null};
      }
      return method === 'DELETE' ? {deleted:true,missing:false,key} : {uploaded:true,key};
    };
    try { return await Promise.race([perform(),timeout]); }
    catch (error) {
      if (error?.code === 'oss_sign_failed') throw problem('生成 OSS 请求签名失败','oss_sign_failed');
      if(fileModified)throw problem('文件在上传期间被修改，OSS 上传已中止','oss_upload_failed',409);
      throw operationError(method,timedOut,error?.httpStatus);
    } finally {clearTimer(timer);controller.abort();body?.destroy();}
  }
  return {upload:(localPath,key)=>request('PUT',key,localPath),remove:key=>request('DELETE',key),head:key=>request('HEAD',key)};
}

module.exports = {
  inspect, objectKey, sign, signedUrl,
  upload:(localPath,key,options)=>createClient(options).upload(localPath,key),
  remove:(key,options)=>createClient(options).remove(key),
  head:(key,options)=>createClient(options).head(key),
  _internals: { ENDPOINT, BUCKET, KEY, DEFAULT_TIMEOUT_MS, createClient }
};
