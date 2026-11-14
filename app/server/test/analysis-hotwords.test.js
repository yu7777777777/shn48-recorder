const test = require('node:test');
const assert = require('node:assert/strict');
const hw = require('../modules/analysis/hotwords');

test('CJK terms are capped at 15 characters and ASCII terms at 7 fragments', () => {
  assert.equal(hw.validHotword('杨冰怡'), '杨冰怡');
  assert.equal(hw.validHotword('一'.repeat(15)), '一'.repeat(15));
  assert.equal(hw.validHotword('一'.repeat(16)), null);
  assert.equal(hw.validHotword('Fan Club Meeting'), 'Fan Club Meeting');
  assert.equal(hw.validHotword('a b c d e f g h'), null);
});

test('full-width and control characters are folded before admission', () => {
  assert.equal(hw.validHotword('ＦＡＮ'), 'FAN');
  assert.equal(hw.validHotword('\u0007杨冰\u0000怡'), '杨冰怡');
  assert.equal(hw.dedupeKey('ＦＡＮ'), hw.dedupeKey('fan'));
});

test('duplicates are dropped after normalisation and the reason is reported', () => {
  const { accepted, rejected } = hw.admit([
    { term: 'ＳＮＨ４８' }, { term: 'snh48' }, { term: '塞纳河' },
  ]);
  // Admission returns the NFKC-folded spelling, matching upstream's strip/normalise.
  assert.deepEqual(accepted, ['SNH48', '塞纳河']);
  assert.deepEqual(rejected, [{ term: 'snh48', reason: 'duplicate' }]);
});

test('disabled rows never reach the prompt', () => {
  const { accepted } = hw.admit([
    { term: '甲', enabled: false }, { term: '乙', enabled: true }, { term: '丙' },
  ]);
  assert.deepEqual(accepted, ['乙', '丙']);
});

test('the prompt budget never splits a surrogate pair', () => {
  const terms = ['😀😀', '😀😀'];
  assert.deepEqual(hw.fit(terms, 4), ['😀😀']);
  assert.deepEqual(hw.fit(['甲', '乙'], 3), ['甲', '乙']);
  assert.deepEqual(hw.fit(['甲', '乙'], 2), ['甲']);
});
