'use strict';
// Read-only audit probes: source reads plus VM/pure-function execution only.
// No real fetch, ffmpeg, service start, runtime store, credentials, or file writes.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const root = path.resolve(__dirname, '../..');
const source = name => fs.readFileSync(path.join(root, 'app/server', name), 'utf8');
const insights = require(path.join(root, 'app/server/modules/analysis/insights'));
const queue = require(path.join(root, 'app/server/modules/analysis/queue'));
function createSettings() {
  let saved = {
    asr: { url: 'https://old.example/v1', model: 'w', key: 'mock-asr-key' },
    ai: { url: 'https://old.example/v1', model: 'm', key: 'mock-old-key' },
  };
  const store = {
    load: (name, fallback) => name === 'analysis_settings' ? structuredClone(saved) : fallback,
    filePath: name => name, dataDir: 'unused-mock-directory',
    atomicWrite: (_name, data) => { saved = structuredClone(data); },
  };
  const module = { exports: {} };
  vm.runInNewContext(source('modules/analysis/settings.js'), {
    require: id => {
      if (id === '../../lib/store') return store;
      if (id === './glossary') return { normalize: input => ({ value: input, conflicts: [] }) };
      throw Error('Unexpected settings dependency: ' + id);
    }, module, exports: module.exports, URL, console,
  }, { filename: 'settings.js' });
  return { settings: module.exports, store };
}
function createService({ settings, store, onFetch = () => {} }) {
  const module = { exports: {} };
  const dependencies = {
    fs, path, child_process: { spawn() { throw Error('External processes forbidden'); } },
    '../recorder/manager': {}, '../recorder/archive-processor': { _internals: {} },
    '../../lib/store': store, './settings': settings,
    './queue': { createWakeup: () => ({}) },
    './queue-lease': () => ({ assertOwned() {}, isHeld: () => false }),
  };
  // Expose request only in this VM copy; no source file is changed.
  const instrumented = source('modules/analysis/service.js') +
    '\nmodule.exports.auditRequest=request; module.exports.auditController=()=>{controller=new AbortController()};';
  vm.runInNewContext(instrumented, {
    require: id => { if (!(id in dependencies)) throw Error('Unexpected service dependency: ' + id); return dependencies[id]; },
    module, exports: module.exports, process: { env: {} }, console,
    setTimeout, clearTimeout, AbortController, AbortSignal,
    fetch: async (url, options) => { onFetch(url, options); return { ok: true, text: async () => '{}' }; },
  }, { filename: 'service.js' });
  return module.exports;
}
async function main() {
  const batch = insights.chunkSegments([{ start: 0, end: 10, text: '今天吃苹果' }])[0];
  const validRow = { start: 0, end: 10, title: '吃苹果', summary: '今天吃苹果', evidenceIds: [0] };
  console.log('PROBE 1: mixed malformed candidate crashes complete valid chapters');
  for (const bad of [null, {}, 'bad']) {
    let observed;
    try { insights.validate({ summary: '概述', chapters: [validRow, bad], highlights: [] }, batch); }
    catch (error) { observed = error; }
    assert.equal(observed?.name, 'TypeError');
    console.log(JSON.stringify(bad), observed.name, observed.message);
  }
  console.log('PROBE 2: unrelated text is fabricated into evidence-backed complete summary');
  const fabricated = await insights.summarize({
    segments: batch.map(({ id, ...row }) => row),
    config: { url: 'https://mock.example/v1', model: 'mock' },
    generate: async () => ({ summary: '概述', chapters: [], highlights: ['她宣布退团并且遭遇重大事故'] }),
    saveCheckpoint: () => {},
  });
  assert.equal(fabricated.chapters[0].title, '她宣布退团并且遭遇重大事故');
  assert.deepEqual(fabricated.chapters[0].evidenceIds, [0]);
  assert.equal(fabricated.summaryCoverage.complete, true);
  console.log(JSON.stringify({ chapters: fabricated.chapters, highlights: fabricated.highlights, complete: fabricated.summaryCoverage.complete }));
  console.log('PROBE 3: saving changed endpoint bypasses credential scope protection');
  const { settings, store } = createSettings();
  assert.throws(() => settings.connection('ai', { url: 'https://new.example/v1' }), /服务地址已更改/);
  console.log('BEFORE_SAVE: connection rejects changed URL without a new key');
  const displayed = settings.publicSettings();
  assert.equal(displayed.ai.key, undefined);
  displayed.ai.url = 'https://new.example/v1';
  settings.save(displayed); // Same sanitized settings payload returned to the UI.
  console.log('AFTER_SAVE_CONNECTION', JSON.stringify(settings.connection('ai', {})));
  let request;
  const service = createService({ settings, store, onFetch: (url, options) => { request = { url, authorization: options.headers.Authorization }; } });
  service.auditController();
  await service.auditRequest(settings.get().ai, '/chat/completions', { model: 'm' }, true);
  assert.equal(request.url, 'https://new.example/v1/chat/completions');
  assert.equal(request.authorization, 'Bearer mock-old-key');
  console.log('MOCK_FETCH', JSON.stringify(request));
  console.log('PROBE 4: ASR tail tolerance persists end before start');
  const invalid = service._internals.normalizeSegments([{ start: 601, end: 602, text: 'out-of-bound' }], 0, 600);
  assert.equal(invalid.length, 1);
  assert.equal(invalid[0].start, 601);
  assert.equal(invalid[0].end, 600);
  console.log('NORMALIZED_ASR', JSON.stringify(invalid));
  assert.throws(() => insights.chunkSegments(invalid), /总结字幕格式或时间无效/);
  console.log('LATER_SUMMARIZE: rejected with 总结字幕格式或时间无效');
  console.log('DIAGNOSTIC 5 (not independently classified as a bug): retry classification');
  const cfg = { ai: { url: 'https://example.test/v1', model: 'm' }, queue: { autoRetry: true, maxRetries: 3 } };
  for (const message of ['AI 总结 schema 无效', 'AI 片段 schema 无效', 'AI 章节时间、长度或 schema 无效', 'AI 总结遗漏字幕时间窗口，缺少有效候选，未完成覆盖；请重试', 'AI 返回格式无效，请重试或更换支持 JSON 的模型']) {
    const job = { kind: 'summarize', status: 'running', configFingerprint: queue.fingerprint(cfg, 'summarize') };
    const retry = queue.retry(job, Object.assign(Error(message), { statusCode: 400 }), cfg, 0);
    console.log(JSON.stringify({ message, retry, status: job.status, nextAttemptAt: job.nextAttemptAt }));
  }
  console.log('PROBE 6 (current workspace only; concurrent source change): internal retry bypass');
  for (const httpStatus of [401, 429]) {
    const disabledConfig = { ai: { url: 'https://mock.example/v1', model: 'm' }, queue: { autoRetry: false, maxRetries: 0 } };
    let calls = 0, observed;
    try {
      await insights.summarize({
        segments: [{ start: 0, end: 10, text: '今天吃苹果' }],
        config: disabledConfig.ai,
        generate: async () => { calls++; throw Object.assign(Error('mock HTTP ' + httpStatus), { httpStatus, retryAfterMs: 600000 }); },
        saveCheckpoint: () => { throw Error('No checkpoint should be saved on HTTP failure'); },
      });
    } catch (error) { observed = error; }
    assert.equal(observed.httpStatus, httpStatus);
    assert.equal(calls, 3);
    console.log(JSON.stringify({ httpStatus, autoRetry: false, maxRetries: 0, retryAfterMs: 600000, actualImmediateGenerateCalls: calls }));
  }
  console.log('ALL EXPECTED AUDIT REPRODUCTIONS CONFIRMED (no external IO beyond source reads)');
}
main().catch(error => { console.error(error); process.exitCode = 1; });
