"use strict";
const store = require('../../lib/store');
function write(name, data) {
  store.atomicWrite(store.filePath(name), data);
}
const queueDefaults = { autoRetry: false, maxRetries: 3, resumeInterrupted: false };
const defaults = { asr: { url: '', model: 'whisper-1', key: '' }, ai: { url: '', model: '', key: '' }, typesafe: { key: '' }, glossary: [], offline: { enabled: false, model: 'tiny' }, queue: queueDefaults,
  // Off by default: a summary is only shown on a public replay page after an
  // administrator turns this on. Chapter and highlight titles are part of it.
  publish: { summary: false, chapters: true, highlights: true },
  // How much of an AI-generated summary a visitor sees; 'full' keeps the text,
  // 'chapters' shows titles/times only. Either way no subtitle or provenance goes out.
  publicDetail: { mode: 'full' } };
function normalizedQueue(input) {
  return { autoRetry: input?.autoRetry === true, maxRetries: Number.isInteger(input?.maxRetries) && input.maxRetries >= 0 && input.maxRetries <= 3 ? input.maxRetries : 3, resumeInterrupted: input?.resumeInterrupted === true };
}
function get() { const saved = store.load('analysis_settings', {}); return { ...defaults, ...saved, queue: normalizedQueue(saved.queue), publish: { ...defaults.publish, ...(saved.publish && typeof saved.publish === 'object' ? saved.publish : {}) }, publicDetail: { mode: ['full', 'chapters'].includes(saved.publicDetail?.mode) ? saved.publicDetail.mode : defaults.publicDetail.mode } }; }
function publicSettings() {
  const value = get();
  return { ...value, ...Object.fromEntries(['asr','ai'].map(k => [k, { url: value[k].url, model: value[k].model, configured: Boolean(value[k].url && value[k].model && value[k].key) }])), typesafe: { configured: Boolean(value.typesafe?.key) } };
}
function save(input) {
  const value = get();
  for (const kind of ['asr','ai']) if (input[kind]) {
    const item = input[kind];
    const url = String(item.url ?? value[kind].url).trim().replace(/\/+$/, '');
    if (url) {
      let parsed; try { parsed = new URL(url); } catch { throw new Error('服务地址无效'); }
      if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password || parsed.search || parsed.hash) throw new Error('服务地址须为 HTTP 或 HTTPS 基础地址，不能包含密钥或查询参数');
    }
    // A saved credential belongs to the endpoint where it was supplied. Saving
    // another URL without a new key must not silently move the old Bearer there.
    const previousUrl = String(value[kind].url || '').trim().replace(/\/+$/, '');
    const key = item.clearKey ? '' : String(item.key || (url === previousUrl ? value[kind].key : '') || '');
    if (key.length > 4096 || /[\r\n]/.test(key)) throw new Error('密钥格式无效');
    value[kind] = { url, key, model: String(item.model ?? value[kind].model).trim().slice(0, 120) };
  }
  if (input.queue !== undefined) {
    const queue = input.queue;
    if (!queue || typeof queue !== 'object' || Array.isArray(queue) || Object.keys(queue).some(k => !Object.hasOwn(queueDefaults, k))) throw new Error('分析队列配置无效');
    for (const name of ['autoRetry', 'resumeInterrupted']) if (queue[name] !== undefined && typeof queue[name] !== 'boolean') throw new Error('队列开关必须为布尔值');
    if (queue.maxRetries !== undefined && (!Number.isInteger(queue.maxRetries) || queue.maxRetries < 0 || queue.maxRetries > 3)) throw new Error('自动重试次数须为 0 到 3 的整数');
    value.queue = { ...value.queue, ...queue };
  }
  if (input.glossary !== undefined) {
    // Normalisation lives in one module so saved rows, the ASR fingerprint and the
    // offline hotword prompt all read the same spellings.
    const glossary = require('./glossary').normalize(input.glossary);
    value.glossary = glossary.value;
    value.glossaryConflicts = glossary.conflicts;
  }
  if (input.publicDetail !== undefined) {
    const detail = input.publicDetail;
    if (!detail || typeof detail !== 'object' || Array.isArray(detail) || Object.keys(detail).some(k => k !== 'mode')) throw new Error('公开详略设置无效');
    if (detail.mode !== undefined && !['full', 'chapters'].includes(detail.mode)) throw new Error('公开详略只能选择完整或仅分级');
    value.publicDetail = { mode: detail.mode ?? (value.publicDetail?.mode || 'full') };
  }
  if (input.publish !== undefined) {
    const publish = input.publish;
    if (!publish || typeof publish !== 'object' || Array.isArray(publish) || Object.keys(publish).some(k => !Object.hasOwn(defaults.publish, k))) throw new Error('公开设置无效');
    for (const name of Object.keys(defaults.publish)) if (publish[name] !== undefined && typeof publish[name] !== 'boolean') throw new Error('公开开关必须为布尔值');
    value.publish = { ...(value.publish || defaults.publish), ...publish };
  }
  if(input.offline){
    if(!['tiny','base','small'].includes(input.offline.model))throw new Error('请选择有效离线模型');
    value.offline={enabled:input.offline.enabled===true,model:input.offline.model};
  }
  if (input.typesafe) {
    const key = input.typesafe.clearKey ? '' : String(input.typesafe.key || value.typesafe?.key || '');
    if (key.length > 4096 || /[\r\n]/.test(key)) throw new Error('TypeSafe 密钥格式无效');
    value.typesafe = { key };
  }
  write('analysis_settings', value); return publicSettings();
}
function connection(kind, input = {}) {
  if (!['asr', 'ai'].includes(kind)) throw new Error('服务类型无效');
  const saved = get()[kind];
  const url = String(input.url ?? saved.url).trim().replace(/\/+$/, '');
  let parsed; try { parsed = new URL(url); } catch { throw new Error('请先填写有效的服务地址'); }
  if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password || parsed.search || parsed.hash) throw new Error('请使用不含密钥或查询参数的 HTTP 或 HTTPS 服务地址');
  // A saved credential belongs only to the endpoint where it was configured.
  if (!input.key && url !== saved.url) throw new Error('服务地址已更改，请填写新服务的密钥后拉取');
  const key = input.clearKey ? '' : String(input.key || saved.key || '');
  if (!key || key.length > 4096 || /[\r\n]/.test(key)) throw new Error('请先填写 API 密钥');
  return { url, key, model: String(input.model ?? saved.model).trim() };
}
async function models(kind, input = {}) {
  const {url,key} = connection(kind,input);
  let response;
  try { response = await fetch(`${url}/models`, { headers: { Authorization: `Bearer ${key}` }, redirect: 'error', signal: AbortSignal.timeout(12000) }); }
  catch { throw new Error('模型列表连接失败，请检查服务地址或稍后重试'); }
  if (!response.ok) throw new Error(`拉取模型失败（HTTP ${response.status}），请检查密钥及服务是否支持模型列表`);
  let data;
  try {
    const reader = response.body.getReader(); let bytes = 0; const chunks = [];
    while (true) { const { value, done } = await reader.read(); if (done) break; bytes += value.length; if (bytes > 2000000) { await reader.cancel(); throw new Error(); } chunks.push(Buffer.from(value)); }
    data = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch { throw new Error('服务返回的模型列表格式无效或过大'); }
  if (!Array.isArray(data.data)) throw new Error('服务未返回兼容的模型列表');
  const ids = [...new Set(data.data.map(m => m?.id).filter(id => typeof id === 'string' && id.trim() && id.length <= 120))].sort();
  if (!ids.length) throw new Error('该服务未返回可选模型，请检查账号权限');
  return ids;
}
module.exports = { get, publicSettings, save, write, models, connection };
