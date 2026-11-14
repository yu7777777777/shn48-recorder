'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vocabulary = require('../modules/analysis/dashscope-vocabulary');
function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dashscope-vocabulary-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return { dir, table: vocabulary.createStore(dir) };
}
test('vocabulary CRUD persists content-hash versions and ignores order', t => {
  const { dir, table } = fixture(t), empty = table.get();
  const first = table.put({ terms: ['杨晔', 'SNH48'] });
  assert.equal(first.version.length, 64); assert.notEqual(first.version, empty.version);
  assert.equal(table.put(['SNH48', '杨晔']).version, first.version);
  assert.equal(vocabulary.createStore(dir).get().version, first.version);
  const changed = table.put([{ text: '杨晔', weight: 5 }, 'SNH48']);
  assert.notEqual(changed.version, first.version);
  assert.deepEqual(table.delete().terms, []); assert.equal(table.get().version, empty.version);
});
test('vocabulary admission rejects malformed/duplicate/oversized terms without changing data', t => {
  const { table } = fixture(t); const original = table.put(['SNH48']);
  for (const input of [null, {}, ['SNH48', 'ＳＮＨ４８'], ['这'.repeat(16)], [{text:'杨晔',weight:9}], Array(501).fill('x')]) {
    assert.throws(() => table.put(input)); assert.equal(table.get().version, original.version);
  }
});
test('vocabulary atomic rename failure preserves old JSON and cleans its temporary file', t => {
  const { dir, table } = fixture(t); const original = table.put(['杨晔']);
  const rename = fs.renameSync;
  let observed;
  fs.renameSync = (temporary, target) => {
    observed = { directory: path.dirname(temporary), target, next: JSON.parse(fs.readFileSync(temporary, 'utf8')), old: JSON.parse(fs.readFileSync(target, 'utf8')) };
    throw Error('simulated rename failure');
  };
  try { assert.throws(() => table.put(['SNH48']), {code:'vocabulary_write_failed'}); }
  finally { fs.renameSync = rename; }
  assert.equal(observed.directory, dir); assert.equal(observed.target, path.join(dir, 'dashscope-vocabulary.json'));
  assert.deepEqual(observed.next.terms, [{text:'SNH48',weight:4}]); assert.equal(observed.old.version, original.version);
  assert.equal(table.get().version, original.version);
  assert.deepEqual(fs.readdirSync(dir), ['dashscope-vocabulary.json']);
});
test('vocabulary corrupt JSON does not silently overwrite an existing table', t => {
  const { dir, table } = fixture(t);
  fs.writeFileSync(path.join(dir, 'dashscope-vocabulary.json'), '{bad', 'utf8');
  assert.throws(() => table.get(), {code:'vocabulary_read_failed'});
});
