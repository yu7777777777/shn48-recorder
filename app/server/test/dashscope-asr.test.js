'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const asr = require('../modules/analysis/dashscope-asr');
const input = { audioUrl: 'https://audio.example.test/audio.mp3?Signature=fake', vocabularyId: 'vocab-test' };
const reply = (state, extra = {}) => ({ output: { task_id: 'remote-test', task_status: state, ...extra } });
function deferred() { let resolve; const promise = new Promise(r => {resolve = r;}); return { promise, resolve }; }
test('ASR without injected transport always skips without network or credentials', async () => {
  const client = asr.createClient();
  assert.equal(typeof asr._internals.setTransport, 'function');
  for (const state of [await client.submit(), await client.poll('unknown'), client.cancel('unknown'), client.status('unknown')]) {
    assert.equal(state.status, 'skipped'); assert.equal(state.code, 'dashscope_disabled');
  }
});
test('ASR pending/running/succeeded transitions and transport protocol are explicit', async () => {
  const client = asr.createClient(), requests = [];
  client._internals.setTransport(async request => {
    requests.push(request);
    return requests.length === 1 ? reply('PENDING') : requests.length === 2 ? reply('RUNNING') : reply('SUCCEEDED', {results:[{subtask_status:'SUCCEEDED',transcription_url:'https://secret.test/?token=secret'}]});
  });
  const submitted = await client.submit(input); assert.equal(submitted.status, 'pending');
  assert.equal(requests[0].body.parameters.vocabulary_id, 'vocab-test');
  assert.equal(requests[0].headers['X-DashScope-Async'], 'enable');
  assert.equal(requests[0].headers.Authorization, undefined);
  assert.equal((await client.poll(submitted.id)).status, 'running');
  assert.equal((await client.poll(submitted.id)).status, 'succeeded');
  assert.equal(requests[1].path, '/api/v1/tasks/remote-test');
  await client.poll(submitted.id); assert.equal(requests.length, 3);
  const state = client.status(submitted.id);
  assert.equal(state.resultAvailable, true); assert.equal(JSON.stringify(state).includes('secret'), false);
  state.status = 'failed'; assert.equal(client.status(submitted.id).status, 'succeeded');
});
test('ASR concurrent duplicate submission issues exactly one external operation', async () => {
  const client = asr.createClient(), wait = deferred(); let calls = 0;
  client._internals.setTransport(async () => {calls++; return wait.promise;});
  const a = client.submit(input), b = client.submit(input);
  await Promise.resolve(); assert.equal(calls, 1);
  wait.resolve(reply('PENDING'));
  const [first, second] = await Promise.all([a,b]); assert.equal(first.id, second.id);
  assert.equal((await client.submit(input)).id, first.id); assert.equal(calls, 1);
});
test('ASR local cancellation is terminal even when an in-flight poll later succeeds', async () => {
  const client = asr.createClient(), wait = deferred(); let calls = 0;
  client._internals.setTransport(async req => {calls++; return req.operation === 'submit' ? reply('PENDING') : wait.promise;});
  const task = await client.submit(input), poll = client.poll(task.id);
  await Promise.resolve(); const cancelled = client.cancel(task.id);
  assert.equal(cancelled.status, 'failed'); assert.equal(cancelled.error.code, 'dashscope_cancelled');
  assert.equal(cancelled.stopsCloudBilling, false); assert.match(cancelled.cancellationNotice, /不停止云端计费/);
  wait.resolve(reply('SUCCEEDED')); assert.equal((await poll).error.code, 'dashscope_cancelled');
  await client.poll(task.id); assert.equal(calls, 2);
});
test('ASR local cancellation during submit cannot be overwritten by its response', async () => {
  const client = asr.createClient(), wait = deferred();
  client._internals.setTransport(() => wait.promise);
  const submitting = client.submit(input); await Promise.resolve();
  const task = client.status().tasks[0]; client.cancel(task.id);
  wait.resolve(reply('RUNNING')); assert.equal((await submitting).error.code, 'dashscope_cancelled');
});
test('ASR transport errors and invalid/failed responses have safe explicit codes', async () => {
  for (const [response, expected] of [[null,'dashscope_submit_failed'],[reply('FAILED'),'dashscope_task_failed'],[reply('UNKNOWN'),'dashscope_invalid_response'],[reply('CANCELED'),'dashscope_remote_cancelled']]) {
    const client = asr.createClient(); client._internals.setTransport(async () => response);
    const task = await client.submit(input); assert.equal(task.status, 'failed'); assert.equal(task.error.code, expected);
  }
  const client = asr.createClient(); client._internals.setTransport(async () => {throw Error('Bearer PRIVATE; https://private.test/?key=private');});
  const failed = await client.submit(input); assert.equal(failed.error.code, 'dashscope_request_failed');
  assert.equal(JSON.stringify(failed).includes('PRIVATE'), false); assert.equal(JSON.stringify(failed).includes('private.test'), false);
});
test('ASR failed polls are terminal with explicit codes and no retry', async () => {
  const client = asr.createClient(); let calls = 0;
  client._internals.setTransport(async () => {calls++; if(calls === 1)return reply('PENDING'); throw Error('private');});
  const task = await client.submit(input);
  assert.equal((await client.poll(task.id)).error.code, 'dashscope_request_failed');
  await client.poll(task.id); assert.equal(calls, 2);
});
test('ASR queued poll does not send after synchronous local cancellation', async () => {
  const client = asr.createClient(); let calls = 0;
  client._internals.setTransport(async () => {calls++; return reply('PENDING');});
  const task = await client.submit(input), pending = client.poll(task.id); client.cancel(task.id);
  assert.equal((await pending).error.code, 'dashscope_cancelled'); assert.equal(calls,1);
});
test('ASR invalid inputs are rejected before invoking a transport', async () => {
  const client = asr.createClient(); let calls = 0;
  client._internals.setTransport(() => {calls++;});
  await assert.rejects(client.submit({audioUrl:'file:///etc/passwd'}), {code:'dashscope_invalid_audio'});
  await assert.rejects(client.submit({...input,vocabularyId:'../private'}), {code:'dashscope_invalid_input'});
  assert.equal(calls,0); assert.throws(() => client.status('unknown'), {code:'dashscope_task_not_found'});
});
