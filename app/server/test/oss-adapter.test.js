'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const oss = require('../modules/analysis/oss-adapter');

test('a half-configured OSS is disabled and says exactly what is missing', () => {
  const state = oss.inspect({ ALIYUN_ACCESS_KEY_ID: 'id', ALIYUN_OSS_BUCKET: 'b' });
  assert.equal(state.enabled, false);
  assert.deepEqual(state.missing, ['ALIYUN_ACCESS_KEY_SECRET', 'ALIYUN_OSS_ENDPOINT']);
});

test('endpoint, bucket and prefix must agree before the adapter turns on', () => {
  const good = oss.inspect({
    ALIYUN_ACCESS_KEY_ID: 'id', ALIYUN_ACCESS_KEY_SECRET: 'secret',
    ALIYUN_OSS_ENDPOINT: 'https://live-media.oss-cn-hangzhou.aliyuncs.com/',
    ALIYUN_OSS_BUCKET: 'live-media', ALIYUN_OSS_PREFIX: 'shn48',
  });
  assert.equal(good.enabled, true);
  assert.equal(good.endpoint, 'https://live-media.oss-cn-hangzhou.aliyuncs.com');
  const mismatch = oss.inspect({
    ALIYUN_ACCESS_KEY_ID: 'id', ALIYUN_ACCESS_KEY_SECRET: 'secret',
    ALIYUN_OSS_ENDPOINT: 'https://other.oss-cn-hangzhou.aliyuncs.com', ALIYUN_OSS_BUCKET: 'live-media',
  });
  assert.equal(mismatch.enabled, false);
  assert.match(mismatch.error, /不一致/);
});

test('network endpoints require the exact HTTPS bucket.region.aliyuncs.com boundary', () => {
  const fixture={ALIYUN_ACCESS_KEY_ID:'offline-id',ALIYUN_ACCESS_KEY_SECRET:'offline-secret',ALIYUN_OSS_BUCKET:'bucket'};
  for(const endpoint of [
    'https://bucket.oss-cn-hangzhou.attacker.com',
    'https://bucketal2yuncs.com',
    'https://bucket.oss-cn-hangzhou.aliyuncs.com.evil.com',
    'https://bucket.oss-cn-hangzhou.attackeraliyuncs.com',
    'https://bucket.oss-cn-hangzhou.extra.aliyuncs.com',
    'http://bucket.oss-cn-hangzhou.aliyuncs.com',
    'https://bucket.oss-cn-hangzhou.aliyuncs.com:443',
    'https://username:password@bucket.oss-cn-hangzhou.aliyuncs.com',
  ]) assert.equal(oss.inspect({...fixture,ALIYUN_OSS_ENDPOINT:endpoint}).enabled,false);
  assert.equal(oss.inspect({...fixture,ALIYUN_OSS_ENDPOINT:'https://bucket.oss-cn-hangzhou.aliyuncs.com'}).enabled,true);
  assert.equal(oss.inspect({...fixture,ALIYUN_OSS_ENDPOINT:'https://BUCKET.oss-cn-hangzhou.aliyuncs.com/'}).enabled,true);
  assert.equal(oss.inspect({...fixture,ALIYUN_OSS_ENDPOINT:'https://different.oss-cn-hangzhou.aliyuncs.com'}).enabled,false);
});

test('object keys are prefixed and refuse traversal or odd characters', () => {
  assert.equal(oss.objectKey('shn48/', 'clips', 'a.mp4'), 'shn48/clips/a.mp4');
  assert.equal(oss.objectKey('', '', 'a.mp4'), 'a.mp4');
  assert.throws(() => oss.objectKey('shn48', '..', 'a.mp4'), /对象键无效/);
  // A space is allowed in the key and escaped when the URL is built.
  assert.equal(oss.objectKey('shn48', 'x', 'a b.mp4'), 'shn48/x/a b.mp4');
  assert.throws(() => oss.objectKey('shn48', 'x', 'a#b.mp4'), /对象键无效/);
});

test('the V1 signature matches an independently computed HMAC-SHA1', () => {
  const args = { method: 'GET', bucket: 'live-media', key: 'shn48/a.mp4', secret: 'topsecret', expires: 900, date: 1700000000 };
  const { signature, stringToSign } = oss.sign(args);
  const expected = crypto.createHmac('sha1', 'topsecret').update(stringToSign, 'utf8').digest('base64');
  assert.equal(signature, expected);
  assert.equal(stringToSign, 'GET\n\n\n1700000000\n/live-media/shn48/a.mp4');
});

test('expiry outside one second to seven days is refused', () => {
  const base = { bucket: 'b', key: 'k', secret: 's' };
  assert.throws(() => oss.sign({ ...base, expires: 0 }), /有效期/);
  assert.throws(() => oss.sign({ ...base, expires: 7 * 86400 + 1 }), /有效期/);
  assert.ok(oss.sign({ ...base, expires: 3600 }).signature);
});

test('a signed URL keeps the path readable and never leaks the secret', () => {
  process.env.ALIYUN_ACCESS_KEY_ID = 'test-id';
  const url = oss.signedUrl({ endpoint: 'https://live-media.oss-cn-hangzhou.aliyuncs.com', bucket: 'live-media', key: 'shn48/clip a.mp4', secret: 'topsecret', expires: 600 });
  assert.match(url, /^https:\/\/live-media\.oss-cn-hangzhou\.aliyuncs\.com\/shn48\/clip%20a\.mp4\?OSSAccessKeyId=test-id&Expires=600&Signature=/);
  assert.equal(url.includes('topsecret'), false);
});
