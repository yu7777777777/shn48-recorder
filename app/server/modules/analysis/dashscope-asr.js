"use strict";
// Protocol reference: RuokeZhang/pocket48-summarizer, MIT, fixed commit
// d5f45afeef1766e16525393e1beb13d24b2452ba, clients/dashscope.py.
// No default network transport, credential lookup, background polling or sync-ASR hook.
const crypto = require('node:crypto');
const fail = (code, message, statusCode = 400) => Object.assign(new Error(message), { code, statusCode });
const skipped = () => ({ status: 'skipped', enabled: false, code: 'dashscope_disabled', message: '未启用：未注入传输层' });
const terminal = task => ['succeeded', 'failed'].includes(task.status);
function createClient() {
  let transport = null;
  const tasks = new Map(), identities = new Map(), submissions = new Map(), polls = new Map();
  const snapshot = task => JSON.parse(JSON.stringify(task));
  function setTransport(fn) {
    if (fn !== null && typeof fn !== 'function') throw new TypeError('transport 必须为函数或 null');
    transport = fn;
  }
  function requireTask(id) {
    const task = tasks.get(id);
    if (!task) throw fail('dashscope_task_not_found', '任务不存在', 404);
    return task;
  }
  function status(id) {
    if (!transport) return skipped();
    if (id !== undefined) return snapshot(requireTask(id));
    return { enabled: true, localOnly: true, tasks: [...tasks.values()].map(snapshot) };
  }
  function markFailed(task, code) {
    if (!terminal(task)) { task.status = 'failed'; task.error = { code, message: 'DashScope 任务失败，请检查服务状态或输入' }; }
  }
  function apply(task, payload) {
    if (terminal(task)) return;
    const output = payload?.output;
    const state = output?.task_status;
    if (state === 'PENDING') { if (task.status !== 'running') task.status = 'pending'; }
    else if (state === 'RUNNING') task.status = 'running';
    else if (state === 'SUCCEEDED') {
      task.status = 'succeeded';
      // Do not return raw provider payloads, signed URLs, headers or provider messages.
      task.resultAvailable = Array.isArray(output.results) && output.results.some(r => r?.subtask_status === 'SUCCEEDED');
    } else if (state === 'CANCELED' || state === 'CANCELLED') markFailed(task, 'dashscope_remote_cancelled');
    else if (state === 'FAILED') markFailed(task, 'dashscope_task_failed');
    else markFailed(task, 'dashscope_invalid_response');
  }
  function submit(input = {}) {
    if (!transport) return Promise.resolve(skipped());
    let url;
    try { url = new URL(input.audioUrl); } catch { return Promise.reject(fail('dashscope_invalid_audio', '音频地址无效')); }
    if (url.protocol !== 'https:' || url.username || url.password || url.hash || url.href.length > 8192) return Promise.reject(fail('dashscope_invalid_audio', '音频地址须为 HTTPS，不能含用户信息或片段'));
    const model = input.model ?? 'paraformer-v2', vocabularyId = input.vocabularyId ?? null;
    if (typeof model !== 'string' || !/^[a-zA-Z0-9_.-]{1,120}$/.test(model) || vocabularyId !== null && (typeof vocabularyId !== 'string' || !/^[a-zA-Z0-9_.-]{1,160}$/.test(vocabularyId))) return Promise.reject(fail('dashscope_invalid_input', '模型或热词 ID 无效'));
    const identity = crypto.createHash('sha256').update(JSON.stringify([url.href, model, vocabularyId])).digest('hex');
    if (submissions.has(identity)) return submissions.get(identity);
    if (identities.has(identity)) return Promise.resolve(snapshot(tasks.get(identities.get(identity))));
    if (tasks.size >= 500) return Promise.reject(fail('dashscope_task_limit', '本地任务记录已满，请重启或使用持久化队列适配器', 429));
    const task = { id: crypto.randomUUID(), status: 'pending', model, vocabularyId, localOnly: true, createdAt: new Date().toISOString() };
    tasks.set(task.id, task); identities.set(identity, task.id);
    const send = transport;
    const promise = Promise.resolve().then(async () => {
      try {
        if (terminal(task)) return snapshot(task);
        const parameters = { channel_id: [0], language_hints: ['zh'] };
        if (vocabularyId) parameters.vocabulary_id = vocabularyId;
        const response = await send({ operation: 'submit', method: 'POST', path: '/api/v1/services/audio/asr/transcription', headers: { 'X-DashScope-Async': 'enable' }, body: { model, input: { file_urls: [url.href] }, parameters } });
        if (!terminal(task)) {
          const remoteId = response?.output?.task_id;
          if (typeof remoteId !== 'string' || !/^[a-zA-Z0-9_-]{1,160}$/.test(remoteId)) markFailed(task, 'dashscope_submit_failed');
          else { task.remoteTaskId = remoteId; apply(task, response); }
        }
      } catch { markFailed(task, 'dashscope_request_failed'); }
      return snapshot(task);
    }).finally(() => submissions.delete(identity));
    submissions.set(identity, promise); return promise;
  }
  function poll(id) {
    if (!transport) return Promise.resolve(skipped());
    const task = requireTask(id);
    if (terminal(task) || !task.remoteTaskId) return Promise.resolve(snapshot(task));
    if (polls.has(id)) return polls.get(id);
    const send = transport;
    const promise = Promise.resolve().then(async () => {
      try {
        if (terminal(task)) return snapshot(task);
        const response = await send({ operation: 'poll', method: 'GET', path: '/api/v1/tasks/' + task.remoteTaskId, taskId: task.remoteTaskId });
        apply(task, response);
      } catch { markFailed(task, 'dashscope_request_failed'); }
      return snapshot(task);
    }).finally(() => polls.delete(id));
    polls.set(id, promise); return promise;
  }
  function cancel(id) {
    if (!transport) return skipped();
    const task = requireTask(id);
    if (!terminal(task)) {
      task.status = 'failed'; task.error = { code: 'dashscope_cancelled', message: '本地取消，不停止云端计费' };
      // Local cancellation only: 不停止云端计费. No upstream cancel API is claimed.
      task.cancelled = true; task.cancellationScope = 'local';
      task.stopsCloudBilling = false; task.cancellationNotice = '本地取消，不停止云端计费';
    }
    return snapshot(task);
  }
  return { submit, poll, cancel, status, _internals: { setTransport } };
}
module.exports = { ...createClient(), createClient };
