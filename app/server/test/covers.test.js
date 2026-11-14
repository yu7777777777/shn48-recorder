const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'covers-test-'));
process.env.DATA_DIR = root;
process.env.COVERS_DIR = path.join(root, 'covers');
const calls = [];
require('../lib/cli').run = async (bin, args) => {
  calls.push(args);
  if (args.includes('-show_entries')) return { stdout: '{"format":{"duration":"100"},"streams":[{"codec_type":"video"}]}' };
  if (args[0].endsWith('cover-render.py')) {
    const job = JSON.parse(fs.readFileSync(args[1], 'utf8'));
    if (job.mode === 'analyze') return { stdout: JSON.stringify(job.images.map((item, i) => ({ ...item, acceptable: true, score: 90 - i, hash: i % 2 ? '18446744073709551615' : '0', reason: '人脸清晰' }))) };
    fs.writeFileSync(job.output, 'jpeg');
    return { stdout: JSON.stringify({ output: job.output }) };
  }
  fs.writeFileSync(args.at(-1), 'jpeg');
  return { stdout: '' };
};
const covers = require('../modules/recorder/covers');
const manager = require('../modules/recorder/manager');
test('smart candidates persist, reuse and cycle without losing a saved cover on invalid input', async () => {
  const recording = manager.addRecording({ status: 'done', filePath: path.join(root, 'video.mp4') });
  fs.writeFileSync(recording.filePath, 'video');
  await covers.generate(recording);
  assert.equal(recording.durationSeconds, 100);
  assert.equal(recording.coverSource, 'smart');
  assert.equal(recording.coverTime, 6);
  assert.equal(calls.filter(args => args.includes('-ss')).length, 24);
  assert.match(covers.url(recording), /^\/api\/admin\/recordings\//);
  const count = calls.length;
  await covers.generate(recording);
  assert.equal(calls.length, count);
  await covers.generate(recording, { next: true });
  assert.notEqual(recording.coverTime, 6);
  const saved = recording.coverFile;
  await assert.rejects(covers.generate(recording, { image: 'data:text/html;base64,AAAA' }));
  assert.equal(recording.coverFile, saved);
  assert.throws(() => covers.file('../secret.jpg'));
  await assert.rejects(covers.generate(recording, { candidateFile: '0'.repeat(32) + '.jpg' }), /没有可用封面/);
  assert.equal(recording.coverFile, saved);
});
test('original cover is preferred and audio/missing video uses a member template', async () => {
  const originalFetch = global.fetch;
  global.fetch = async () => new Response(Buffer.from('image'), { headers: { 'content-type': 'image/jpeg' } });
  try {
    const r = manager.addRecording({ status: 'done', mediaType: 'audio', liveCoverUrl: 'https://source3.48.cn/test.jpg', memberName: '成员' });
    await covers.generate(r);
    assert.equal(r.coverSource, 'original');
    assert.equal(r.coverCandidates.at(-1).source, 'template');
  } finally { global.fetch = originalFetch; }
  const audio = manager.addRecording({ status: 'done', mediaType: 'audio', memberId: 'member' });
  await covers.generate(audio);
  assert.equal(audio.coverSource, 'template');
});
test('queues block manual cover changes, internal upload can generate, unsafe image URLs are rejected', async () => {
  const r = manager.addRecording({ status: 'done', mediaType: 'audio' });
  manager.enqueueUpload({ recordingId: r.id, status: 'uploading' });
  await assert.rejects(covers.generate(r), /上传队列/);
  await covers.generate(r, { allowQueued: true });
  assert.equal(r.coverSource, 'template');
  for (const value of ['http://127.0.0.1/test.jpg', 'file:///secret', 'https://source3.48.cn.evil.com/x', 'https://user:pass@source3.48.cn/x', 'https://source3.48.cn/default.jpg']) assert.equal(covers._internals.safeAssetUrl(value), null);
  assert.ok(covers._internals.safeAssetUrl('https://source3.48.cn/live.jpg'));
});
test('member settings validate inputs and preserve state on invalid photo or theme', async () => {
  await covers.saveMember('123', { memberName: 'SNH48-成员' });
  covers.saveSettings({ theme: 'light' });
  const before = JSON.stringify(covers.settings());
  await assert.rejects(covers.saveMember('../123', { memberName: '成员' }), /ID/);
  await assert.rejects(covers.saveMember('123', { memberName: '成员', image: 'data:text/html;base64,AAAA' }));
  assert.throws(() => covers.saveSettings({ theme: 'invalid' }));
  assert.equal(JSON.stringify(covers.settings()), before);
});
test('batch work skips uploaded, queued and deleted records', async () => {
  const r = manager.addRecording({ status: 'done', mediaType: 'audio' });
  const uploaded = manager.addRecording({ status: 'done', draftId: '123' });
  const deleted = manager.addRecording({ status: 'deleted' });
  covers.startBatch([r.id, uploaded.id, deleted.id]);
  while (covers.batch.status === 'running') await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(covers.batch.completed, 1);
  assert.equal(covers.batch.skipped, 2);
  assert.equal(covers.batch.failed, 0);
});
test('cover upload sends JPEG and csrf, and rejects upstream failure', async () => {
  let response = { code: 0, data: { url: 'https://i0.hdslb.com/bfs/archive/test.jpg' } };
  let form;
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => { form = new URLSearchParams(body); res.end(JSON.stringify(response)); });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  process.env.BILI_COVER_URL = `http://127.0.0.1:${server.address().port}`;
  const input = path.join(root, 'test.jpg'); fs.writeFileSync(input, 'jpeg');
  try {
    const { uploadCover } = require('../modules/bilibili/draft');
    const options = { filePath: input, cookie: 'test', csrf: 'test-csrf' };
    assert.equal(await uploadCover(options), response.data.url);
    assert.equal(form.get('csrf'), 'test-csrf');
    assert.equal(form.get('cover'), 'data:image/jpeg;base64,anBlZw==');
    response = { code: -1, message: 'failed' };
    await assert.rejects(uploadCover(options), /封面上传失败/);
  } finally { server.close(); delete process.env.BILI_COVER_URL; }
});
