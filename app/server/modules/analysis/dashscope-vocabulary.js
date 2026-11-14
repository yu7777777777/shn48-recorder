"use strict";
// Local vocabulary storage inspired by pocket48-summarizer's DashScope client.
// This module never contacts DashScope and never reads a credential.
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const hotwords = require('./hotwords');
const fail = (code, message) => Object.assign(new Error(message), { code, statusCode: 400 });
function canonical(input = {}) {
  if (!input || typeof input !== 'object') throw fail('vocabulary_invalid', '热词表格式无效');
  const rows = Array.isArray(input) ? input : input.terms ?? input.vocabulary;
  if (!Array.isArray(rows) || rows.length > 500) throw fail('vocabulary_invalid', '热词表须为最多 500 条的数组');
  const terms = [], seen = new Set();
  for (const row of rows) {
    if (row && typeof row === 'object' && row.enabled === false) continue;
    const text = hotwords.validHotword(typeof row === 'string' ? row : row?.text ?? row?.term);
    const weight = typeof row === 'object' && row !== null ? row.weight ?? 4 : 4;
    if (!text || !Number.isFinite(weight) || weight < 1 || weight > 5) throw fail('vocabulary_invalid', '热词或权重无效');
    const key = hotwords.dedupeKey(text);
    if (seen.has(key)) throw fail('vocabulary_duplicate', '热词存在重复项');
    seen.add(key); terms.push({ text, weight });
  }
  terms.sort((a, b) => a.text < b.text ? -1 : a.text > b.text ? 1 : 0);
  return { terms, version: crypto.createHash('sha256').update(JSON.stringify(terms)).digest('hex') };
}
function createStore(directory) {
  const filename = () => path.join(directory || process.env.POCKET48_DATA_DIR || process.env.DATA_DIR || path.join(os.homedir(), '.shn48-data'), 'dashscope-vocabulary.json');
  function get() {
    try {
      const saved = JSON.parse(fs.readFileSync(filename(), 'utf8'));
      const value = canonical(saved);
      if (value.version !== saved.version) throw fail('vocabulary_corrupt', '热词文件内容哈希不一致');
      return { ...value, updatedAt: saved.updatedAt || null, localOnly: true };
    } catch (error) {
      if (error.code === 'ENOENT') return { ...canonical([]), updatedAt: null, localOnly: true };
      if (error.code?.startsWith('vocabulary_')) throw error;
      throw fail('vocabulary_read_failed', '热词文件读取失败');
    }
  }
  function put(input) {
    const value = { ...canonical(input), updatedAt: new Date().toISOString() };
    const target = filename(), temporary = target + '.' + crypto.randomUUID() + '.tmp';
    fs.mkdirSync(path.dirname(target), { recursive: true });
    let fd;
    try {
      fd = fs.openSync(temporary, 'wx', 0o600);
      fs.writeFileSync(fd, JSON.stringify(value, null, 2) + String.fromCharCode(10), 'utf8');
      fs.fsyncSync(fd); fs.closeSync(fd); fd = undefined;
      fs.renameSync(temporary, target);
    } catch {
      if (fd !== undefined) try { fs.closeSync(fd); } catch {}
      try { fs.unlinkSync(temporary); } catch {}
      throw fail('vocabulary_write_failed', '热词文件原子写入失败，旧版本保留');
    }
    return { ...value, localOnly: true };
  }
  // Delete the table's content atomically rather than leaving a missing-file window.
  function remove() { return put([]); }
  return { get, put, delete: remove, remove };
}
module.exports = { ...createStore(), createStore, _internals: { canonical } };
