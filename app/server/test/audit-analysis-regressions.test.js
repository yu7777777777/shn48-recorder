'use strict';
// Audit regressions use only pure functions and source VMs with in-memory stores.
// No media processes, real endpoints, credentials, worker startup or runtime data.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const insights = require('../modules/analysis/insights');
const queue = require('../modules/analysis/queue');
const config = { url: 'https://model.example/v1', model: 'mock' };
const segments = [{ start: 0, end: 10, text: '今天大家一起吃苹果' }];
const batch = insights.chunkSegments(segments)[0];
const row = () => ({ start: 0, end: 10, title: '吃苹果', summary: '大家一起吃苹果', evidenceIds: [0] });
const valid = () => ({ summary: '概述', chapters: [row()], highlights: [] });
const source = name => fs.readFileSync(path.join(__dirname, '../modules/analysis', name), 'utf8');
function isolatedSettings() {
  let saved = {
    ai: { url: 'https://old.example/v1', model: 'm', key: 'mock-old-ai-key' },
    asr: { url: 'https://old.example/v1', model: 'w', key: 'mock-old-asr-key' },
  };
  const store = { load: (_name, fallback) => structuredClone(saved || fallback), filePath: name => name,
    atomicWrite: (_name, value) => { saved = structuredClone(value); } };
  const module = { exports: {} };
  vm.runInNewContext(source('settings.js'), {
    module, exports: module.exports, URL,
    require: id => { assert.equal(id, '../../lib/store'); return store; },
  });
  return { settings: module.exports, saved: () => saved };
}
function isolatedNormalizer() {
  const module = { exports: {} };
  const dependencies = {
    fs, path, child_process: { spawn() { throw Error('No external process in audit tests'); } },
    '../recorder/manager': {}, '../recorder/archive-processor': { _internals: {} },
    '../../lib/store': { load: () => [], dataDir: 'unused' }, './settings': {},
    './queue': { createWakeup: () => ({}) }, './queue-lease': () => ({}),
    './parsing': require('../modules/analysis/parsing'),
  };
  vm.runInNewContext(source('service.js'), {
    module, exports: module.exports, process: { env: {} }, setTimeout, clearTimeout,
    require: id => { assert.ok(id in dependencies, id); return dependencies[id]; },
  });
  return module.exports._internals.normalizeSegments;
}
test('F03: saving a changed AI or ASR endpoint never transfers an omitted old key', () => {
  for (const kind of ['ai', 'asr']) {
    for (const key of [undefined, '']) {
      const { settings, saved } = isolatedSettings();
      const displayed = settings.publicSettings()[kind];
      assert.equal(displayed.key, undefined);
      settings.save({ [kind]: { ...displayed, url: 'https://new.example/v1', key } });
      assert.equal(saved()[kind].key, '');
      assert.equal(settings.publicSettings()[kind].configured, false);
      assert.throws(() => settings.connection(kind), /API 密钥/);
    }
  }
});
test('F03: same normalized endpoint preserves a key; explicit replacement and clearing work', () => {
  for (const kind of ['ai', 'asr']) {
    const { settings, saved } = isolatedSettings();
    const oldKey = saved()[kind].key;
    settings.save({ [kind]: { url: ' https://old.example/v1/ ', model: 'new-model' } });
    assert.equal(saved()[kind].key, oldKey);
    settings.save({ [kind]: { url: 'https://new.example/v1', key: 'mock-new-key' } });
    assert.equal(settings.connection(kind).key, 'mock-new-key');
    settings.save({ [kind]: { clearKey: true, key: 'mock-ignored-key' } });
    assert.equal(saved()[kind].key, '');
  }
});
test('F05: clipped ASR intervals always have positive duration and stay inside the chunk', () => {
  const normalize = isolatedNormalizer();
  const good = { start: 599, end: 602, text: 'valid tail' };
  for (const start of [600, 601, 604.99]) {
    const bad = { start, end: start + 1, text: 'outside the clip' };
    assert.throws(() => normalize([bad], 1200, 600), /无效时间戳/);
    const out = normalize([bad, good], 1200, 600);
    assert.equal(out.length, 1);
    assert.equal(out[0].start, 1799);
    assert.equal(out[0].end, 1800);
    assert.ok(out.every(s => s.start >= 1200 && s.end <= 1800 && s.end > s.start));
  }
});
test('F06: mixed null, primitive and missing-field candidates are discarded without TypeError', () => {
  for (const bad of [null, {}, 'bad', [], 42, { start: 1 }]) {
    const data = valid();
    data.chapters.push(bad);
    data.highlights = [row(), bad];
    const out = insights.validate(data, batch);
    assert.deepEqual(out.chapters, [row()]);
    assert.deepEqual(out.highlights, [row()]);
  }
});
test('F06: explicit malformed, empty, forged and duplicate citations still reject a whole batch', () => {
  for (const evidenceIds of [null, '0', [], [99], [0, 99], [0, 0], [0.5], ['0']]) {
    for (const field of ['chapters', 'highlights']) {
      const data = valid();
      data[field].push({ ...row(), evidenceIds });
      assert.throws(() => insights.validate(data, batch), /引用无效或伪造/);
    }
  }
  const extra = valid(); extra.chapters[0].unexpected = true;
  assert.throws(() => insights.validate(extra, batch), /schema/);
});
test('F07: an unmatched string never becomes a subtitle citation or completes coverage', async () => {
  const unrelated = '她宣布退团并且遭遇重大事故';
  assert.deepEqual(insights.validate({ ...valid(), highlights: [unrelated] }, batch).highlights, []);
  let calls = 0, checkpoints = 0;
  await assert.rejects(() => insights.summarize({ segments, config,
    generate: async () => { calls++; return { summary: '概述', chapters: [], highlights: [unrelated] }; },
    saveCheckpoint: () => { checkpoints++; },
  }), /遗漏字幕时间窗口/);
  assert.equal(calls, 1);
  assert.equal(checkpoints, 0);
});
test('F07: text-matched string highlights still normalize using their actual source', () => {
  const out = insights.validate({ summary: '概述', chapters: [], highlights: ['今天大家一起吃苹果'] }, batch);
  assert.deepEqual(out.highlights[0].evidenceIds, [0]);
  assert.deepEqual(out.chapters[0].evidenceIds, [0]);
});
test('F07: unsafe old-policy checkpoints are not reused as fresh validated evidence', async () => {
  let calls = 0;
  const checkpoint = { version: 1, fingerprint: insights.fingerprint(segments, config),
    completed: [{ summary: 'old', chapters: [{ ...row(), title: 'fabricated old anchor' }], highlights: [] }] };
  const out = await insights.summarize({ segments, config, checkpoint,
    generate: async () => { calls++; return valid(); }, saveCheckpoint: () => {},
  });
  assert.equal(calls, 1);
  assert.equal(out.chapters[0].title, '吃苹果');
});
test('F15: HTTP, network, schema and evidence failures leave summarize after exactly one request', async () => {
  for (const error of [
    ...[401, 403, 429, 503].map(httpStatus => Object.assign(Error('mock HTTP'), { httpStatus, retryAfterMs: 600000 })),
    Object.assign(Error('network'), { networkError: true }),
    Object.assign(Error('AI 返回格式无效'), { statusCode: 400 }),
  ]) {
    let calls = 0;
    await assert.rejects(() => insights.summarize({ segments, config,
      generate: async () => { calls++; throw error; }, saveCheckpoint: () => {},
    }), observed => observed === error);
    assert.equal(calls, 1);
  }
  let calls = 0;
  await assert.rejects(() => insights.summarize({ segments, config,
    generate: async () => { calls++; return { ...valid(), chapters: [{ ...row(), evidenceIds: [99] }] }; },
    saveCheckpoint: () => {},
  }), /引用无效或伪造/);
  assert.equal(calls, 1);
});
test('F15: only the opted-in durable queue owns budget, HTTP classification and Retry-After', () => {
  const cfg = { ai: config, queue: { autoRetry: true, maxRetries: 1 } };
  const makeJob = () => ({ kind: 'summarize', status: 'running', configFingerprint: queue.fingerprint(cfg, 'summarize') });
  for (const httpStatus of [400, 401, 403]) {
    // Message heuristics and even network flags must never override explicit HTTP.
    assert.equal(queue.retry(makeJob(), { httpStatus, message: 'AI 返回格式无效', networkError: true }, cfg, 0), false);
  }
  for (const overrides of [{ autoRetry: false }, { maxRetries: 0 }]) {
    assert.equal(queue.retry(makeJob(), { httpStatus: 429 }, { ...cfg, queue: { ...cfg.queue, ...overrides } }, 0), false);
  }
  const job = makeJob();
  assert.equal(queue.retry(job, { httpStatus: 429, retryAfterMs: 600000 }, cfg, 1000), true);
  assert.equal(job.retryCount, 1);
  assert.equal(Date.parse(job.nextAttemptAt), 601000);
  assert.equal(queue.next([job], 600999), undefined);
  assert.equal(queue.retry(job, { httpStatus: 429 }, cfg, 601000), false);
});
