'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { planExpansion, pickBest, retryBudget, buildRequest, planAssets } = require('../modules/analysis/ai-cover');

const request = { model: 'offline-model', prompt: '保留人物，扩展原始房间', referenceImageUrl: 'https://images.example/source.png?expires=123', width: 1920, height: 1080 };

test('upstream: Seedream request uses exact fields and ignores seed and extra options', () => {
  const input = Object.freeze({ ...request, seed: 42, apiKey: 'synthetic-unused', response_format: 'url', watermark: true });
  assert.deepEqual(buildRequest(input), {
    model: request.model, prompt: request.prompt, image: request.referenceImageUrl,
    size: '1920x1080', response_format: 'b64_json', watermark: false,
  });
  assert.deepEqual(buildRequest({ ...request, seed: 7 }), buildRequest({ ...request, seed: 99 }));
});

test('upstream: reference requires HTTPS, explicit path, no credentials, fragment or nonstandard port', () => {
  for (const referenceImageUrl of ['http://images.example/a.png', 'https://images.example', 'https://images.example:8443/a',
    'https://user:password@images.example/a', 'https://@images.example/a', 'https://images.example/a#fragment', 'not-a-url']) {
    assert.throws(() => buildRequest({ ...request, referenceImageUrl }), /HTTPS reference/);
  }
  assert.equal(buildRequest({ ...request, referenceImageUrl: 'https://images.example:443/a' }).image, 'https://images.example:443/a');
});

test('upstream: each unfinished orientation generates once, completed assets are skipped', () => {
  const input = Object.freeze([
    Object.freeze({ id: 'wide', orientation: 'landscape', status: 'queued' }),
    Object.freeze({ id: 'four-three', orientation: 'four_three', status: 'failed' }),
    Object.freeze({ id: 'done', orientation: 'landscape', status: 'completed' }),
  ]);
  assert.deepEqual(planAssets(input), { needsSource: true, assets: [
    { id: 'wide', orientation: 'landscape', action: 'generate' },
    { id: 'four-three', orientation: 'four_three', action: 'generate' },
  ] });
});

test('upstream: cached background resumes without another provider generation', () => {
  assert.deepEqual(planAssets([{ id: 'cached', orientation: 'landscape', status: 'failed', background_oss_object_key: 'ai/cached.png' }]), {
    needsSource: false, assets: [{ id: 'cached', orientation: 'landscape', action: 'reuse-background' }],
  });
  assert.deepEqual(planAssets([]), { needsSource: false, assets: [] });
  const mixed = planAssets([{ id: 'cached', background_oss_object_key: 'cached.png' }, { id: 'new' }]);
  assert.equal(mixed.needsSource, true);
  assert.deepEqual(mixed.assets.map(a => a.action), ['reuse-background', 'generate']);
});

test('upstream: external_retry_attempts counts total attempts, not extra retries', () => {
  assert.equal(retryBudget(1), 1);
  assert.equal(retryBudget(3), 3);
  assert.equal(retryBudget(5), 5);
  // A consumer uses attempt < budget, never budget + 1. No requests are issued.
  assert.deepEqual(Array.from({ length: retryBudget(3) }, (_, index) => index + 1), [1, 2, 3]);
});

test('local-rule: portrait source expands horizontally and landscape vertically without cropping', () => {
  assert.deepEqual(planExpansion({ sourceW: 900, sourceH: 1600, targetRatio: '16:9' }), {
    cropW: 900, cropH: 1600, padX: 972, padY: 0, outW: 2845, outH: 1600, clamped: false,
  });
  assert.deepEqual(planExpansion({ sourceW: 1600, sourceH: 900, targetRatio: '9:16' }), {
    cropW: 1600, cropH: 900, padX: 0, padY: 972, outW: 1600, outH: 2845, clamped: false,
  });
});

test('local-rule: matching ratios keep the complete source unchanged', () => {
  assert.deepEqual(planExpansion({ sourceW: 1920, sourceH: 1080, targetRatio: 16 / 9 }), {
    cropW: 1920, cropH: 1080, padX: 0, padY: 0, outW: 1920, outH: 1080, clamped: false,
  });
});

test('local-rule: extreme positive ratios clamp to 1:4 or 4:1 and report clamping', () => {
  const wide = planExpansion({ sourceW: 100, sourceH: 100, targetRatio: 1e200 });
  const tall = planExpansion({ sourceW: 100, sourceH: 100, targetRatio: 1e-200 });
  assert.deepEqual(wide, { cropW: 100, cropH: 100, padX: 150, padY: 0, outW: 400, outH: 100, clamped: true });
  assert.deepEqual(tall, { cropW: 100, cropH: 100, padX: 0, padY: 150, outW: 100, outH: 400, clamped: true });
  for (const ratio of [0.25, 4]) assert.equal(planExpansion({ sourceW: 100, sourceH: 100, targetRatio: ratio }).clamped, false);
});

test('local-rule: bad dimensions, ratios and request fields fail without IO', () => {
  for (const targetRatio of [0, -1, NaN, Infinity, '16:0', 'invalid', null]) {
    assert.throws(() => planExpansion({ sourceW: 100, sourceH: 100, targetRatio }), /targetRatio/);
  }
  for (const sourceW of [0, -1, 1.5, NaN, Number.MAX_SAFE_INTEGER]) {
    assert.throws(() => planExpansion({ sourceW, sourceH: 100, targetRatio: 0.25 }), /safe integer/);
  }
  for (const width of [0, -1, 1.5, Infinity]) assert.throws(() => buildRequest({ ...request, width }), /width/);
  assert.throws(() => buildRequest({ ...request, model: '' }), /model/);
  assert.throws(() => buildRequest({ ...request, prompt: null }), /prompt/);
});

test('local-rule: empty or invalid candidates have no winner', () => {
  assert.equal(pickBest([]), null);
  assert.equal(pickBest([null, {}, { width: 0, height: 100 }, { width: 10, height: Infinity }]), null);
});

test('local-rule: resolution precedes composition, sharpness breaks remaining ties stably', () => {
  const low = Object.freeze({ width: 100, height: 100, compositionScore: 100, sharpnessScore: 100 });
  const high = Object.freeze({ width: 200, height: 100, compositionScore: 1, sharpnessScore: 0 });
  const composition = Object.freeze({ width: 100, height: 200, compositionScore: 2, sharpnessScore: 0 });
  const sharpness = Object.freeze({ width: 200, height: 100, compositionScore: 2, sharpnessScore: 3 });
  const tie = Object.freeze({ ...sharpness });
  assert.equal(pickBest([low, high]), high);
  assert.equal(pickBest([high, composition]), composition);
  const input = Object.freeze([low, high, composition, sharpness, tie]);
  assert.equal(pickBest(input), sharpness);
  assert.equal(input[0], low);
});

test('local-rule: only first eight candidates are considered, invalid scores do not outrank finite scores', () => {
  const first = { width: 10, height: 10, compositionScore: 1, sharpnessScore: 1 };
  assert.equal(pickBest([...Array(8).fill(first), { width: 1000, height: 1000 }]), first);
  assert.equal(pickBest([{ ...first, compositionScore: NaN }, first]), first);
  assert.equal(pickBest([{ ...first, sharpnessScore: Infinity }, first]), first);
});

test('local-rule: local attempt policy defaults to three and clamps the total to one through five', () => {
  assert.equal(retryBudget(), 3);
  assert.equal(retryBudget(99), 5);
  assert.equal(retryBudget(0), 1);
  assert.equal(retryBudget(-100), 1);
  assert.equal(retryBudget(4.9), 4);
  for (const invalid of [NaN, Infinity, null, '3']) assert.throws(() => retryBudget(invalid), /attempt budget/);
});
