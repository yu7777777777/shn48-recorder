'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const p = require('../modules/analysis/parsing');
const T = String.fromCharCode(9);

test('LRC timestamps accept mm:ss and hh:mm:ss only inside a valid clock', () => {
  assert.equal(p.parseLrcTimestamp('01:02.50'), 62500);
  assert.equal(p.parseLrcTimestamp('1:02:03'), 3723000);
  assert.equal(p.parseLrcTimestamp('01:60.00'), null, 'sixty seconds is not a second field');
  assert.equal(p.parseLrcTimestamp('1:2:3:4'), null);
  assert.equal(p.parseLrcTimestamp('abc'), null);
});

test('danmaku lines are pulled three seconds earlier and sorted by time then file order', () => {
  const entries = p.parseLrc(['[00:10.00]' + T + '甲' + T + '第二句', '[00:05.00]无作者', '[00:05.00]' + T + '乙' + T + '并列后出现', '[bad]ignored', '[00:01.00]' + T + '早'].join('\r\n'));
  assert.deepEqual(entries.map(e => [e.timestampMs, e.author, e.text]), [
    [0, '', '早'],
    [2000, '', '无作者'],
    // A line that starts with the separator has no author: the text follows the tab.
    [2000, '', '乙' + T + '并列后出现'],
    [7000, '', '甲' + T + '第二句'],
  ]);
  assert.deepEqual(entries.map(e => e.sequence), [1, 2, 3, 4]);
});

test('toLrc writes bracketed LRC that parseLrc reads back with the offset restored', () => {
  const rows = [{ timestampMs: 2000, author: 'A', text: 'x' }, { timestampMs: 0, author: '', text: 'y' }];
  const text = p.toLrc(rows);
  assert.equal(text, ['[00:05.00]' + 'A' + T + 'x', '[00:03.00]' + T + 'y'].join('\n'));
  const back = p.parseLrc(text);
  assert.deepEqual(back.map(e => e.timestampMs), [0, 2000], 'the three-second offset is restored');
  assert.equal(back[1].author, 'A');
  assert.equal(back[1].text, 'x');
});
test('ASR results accept both milliseconds and seconds, and sentences under output', () => {
  const ms = p.normalizeAsrResult({ transcripts: [{ sentences: [{ begin_time_in_milliseconds: 1500, end_time_in_milliseconds: 3000, text: '一' }] }] });
  assert.deepEqual(ms.map(s => [s.startMs, s.endMs, s.text]), [[1500, 3000, '一']]);
  const seconds = p.normalizeAsrResult({ output: { transcripts: [{ sentences: [{ start: 1.5, end: 3.0, text: '一' }] }] } });
  const whole = p.normalizeAsrResult({ transcripts: [{ sentences: [{ start: 12, end: 14, text: '整秒' }] }] });
  assert.deepEqual(whole.map(x => [x.startMs, x.endMs]), [[12000, 14000]], 'small integers are seconds');
  assert.deepEqual(seconds.map(s => [s.startMs, s.endMs]), [[1500, 3000]]);
});

test('a missing end is given one millisecond, overlapping starts are clamped forward', () => {
  const segments = p.normalizeAsrResult({ transcripts: [{ sentences: [
    { begin_time_in_milliseconds: 5000, text: '后' }, { begin_time_in_milliseconds: 1000, text: '前' }, { begin_time_in_milliseconds: 1000, end_time_in_milliseconds: 900, text: '倒' },
  ] }] });
  assert.deepEqual(segments.map(s => [s.sequence, s.startMs, s.endMs]), [[1, 1000, 1001], [2, 1000, 1001], [3, 5000, 5001]]);
});

test('a result without transcripts or sentences is refused with a code', () => {
  assert.throws(() => p.normalizeAsrResult({}), err => err.code === 'invalid_asr_result');
  assert.throws(() => p.normalizeAsrResult({ transcripts: [{ sentences: [] }] }), err => err.code === 'empty_transcript');
});

test('SRT output keeps the speaker prefix and never breaks on a newline inside a line', () => {
  const srt = p.transcriptToSrt([{ startMs: 0, endMs: 1234, speakerId: '2', text: '你好\n世界' }, { startMs: 3661000, endMs: 3662500, speakerId: null, text: '末' }]);
  assert.equal(srt, ['1', '00:00:00,000 --> 00:00:01,234', '[说话人 2] 你好 世界', '', '2', '01:01:01,000 --> 01:01:02,500', '末', ''].join('\n'));
});
