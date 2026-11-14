"use strict";
const fail = (message, statusCode = 400) => Object.assign(new Error(message), { statusCode });
const string = value => typeof value === 'string' ? value : '';
// A stage needs to name its provider, but never its URL: keep only the host, which
// distinguishes services without revealing paths, query strings or tokens.
function hostOf(value) {
  const text = string(value).trim();
  if (!text) return null;
  try {
    const url = new URL(text);
    return url.host || null;
  } catch (error) {
    // Not a URL at all: keep a short opaque label, still bounded.
    return text.length > 60 ? text.slice(0, 60) : text;
  }
}
const validTime = value => typeof value === 'number' && Number.isFinite(value) && value >= 0;
function snapshot(recordingId, data) {
  // Japanese is optional and only appears when a row carries one, so archives that
  // never used it keep exactly the old shape.
  const row = (s, id) => {
    const value = { id, start: validTime(s.start) ? s.start : null, end: validTime(s.end) ? s.end : null, text: string(s.text), en: string(s.en) };
    if (string(s.enJA).trim()) value.ja = string(s.enJA);
    return value;
  };
  const segments = (Array.isArray(data.segments) ? data.segments : []).map(row);
  const insights = rows => (Array.isArray(rows) ? rows : []).filter(r => r && validTime(r.start) && validTime(r.end) && r.end > r.start).map(r => ({
    start: r.start, end: r.end, title: string(r.title), summary: string(r.summary),
    evidenceIds: [...new Set((Array.isArray(r.evidenceIds) ? r.evidenceIds : []).filter(id => Number.isInteger(id) && id >= 0 && id < segments.length && segments[id].start !== null && segments[id].end !== null && segments[id].start < r.end && segments[id].end > r.start))]
  }));
  // Whitelist result fields: no checkpoints, job internals, provider URL or settings.
  const value = { schemaVersion: 1, recordingId: String(recordingId), summary: string(data.summary), chapters: insights(data.chapters), highlights: insights(data.highlights), segments };
  if (!value.summary.trim() && !value.chapters.length && !value.highlights.length) throw fail('还没有可导出的总结，请先生成章节与精彩片段', 409);
  return value;
}
function stamp(value) {
  const total = Math.floor(Number(value) || 0);
  return [Math.floor(total / 3600), Math.floor(total / 60) % 60, total % 60].map(n => String(n).padStart(2, '0')).join(':');
}
function escape(value) {
  return Array.from(string(value)).map(c => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127 ? ' ' : c === '&' ? '&amp;' : c === '<' ? '&lt;' : c === '>' ? '&gt;' : (c.charCodeAt(0) === 92 || '`*_{}[]()#+-.!|'.includes(c) ? '\\' + c : c)).join('');
}
function markdown(value) {
  const lines = ['# 回放内容总结', '', '> AI 生成内容，请结合原片与引用字幕核对。引用序号从 1 开始；JSON evidenceIds 从 0 开始。', '', '## 概述', '', escape(value.summary) || '暂无概述', ''];
  for (const [key, label] of [['chapters', '章节时间线'], ['highlights', '精彩片段']]) {
    lines.push('## ' + label, '');
    if (!value[key].length) lines.push('暂无', '');
    for (const item of value[key]) {
      lines.push('### ' + stamp(item.start) + ' — ' + stamp(item.end) + ' ' + escape(item.title), '', escape(item.summary), '');
      if (!item.evidenceIds.length) lines.push('未提供可验证的字幕引用（历史结果）。', '');
      for (const id of item.evidenceIds) {
        const s = value.segments[id];
        lines.push('> 字幕 ' + (id + 1) + ' · ' + stamp(s.start) + ' — ' + stamp(s.end) + '：' + escape(s.text), '');
        // Translations are quoted only when they exist; their absence is not news.
        if (s.en) lines.push('> 英文：' + escape(s.en), '');
        if (s.ja) lines.push('> 日文：' + escape(s.ja), '');
      }
    }
  }
  return lines.join('\n');
}
function render(recordingId, data, format = 'markdown') {
  if (!['markdown', 'json'].includes(format)) throw fail('导出格式无效，请选择 markdown 或 json');
  const value = snapshot(recordingId, data);
  return format === 'json' ? { type: 'application/json', extension: 'json', text: JSON.stringify(value, null, 2) + '\n' } : { type: 'text/markdown', extension: 'md', text: markdown(value) };
}
// Provenance for the whole recording, not for one artifact: which model and
// endpoint produced the text, the summary and the English, plus what is missing.
// Only identifiers are reported — never keys or provider responses.
function provenance(data, now = new Date().toISOString()) {
  const source = data && typeof data === 'object' ? data : {};
  const segments = Array.isArray(source.segments) ? source.segments : [];
  const translation = require('./translation');
  const enabled = Array.isArray(source.glossary) ? source.glossary.length : undefined;
  // One recorded identity is enough to name the provider; per-segment reuse is
  // decided separately, so this only ever reports what some row actually says.
  // A Japanese run stamps the same row, so the English stage must only look at rows
  // whose recorded identity is English; otherwise one Japanese run would be
  // reported as both languages finished.
  const isEn = (row) => row && row.translation && row.translation.model && String(row.translation.target || 'en') === 'en' && typeof row.en === 'string' && row.en.trim();
  const recorded = segments.find(isEn);
  const translated = segments.filter(isEn).length;
  const japaneseRows = segments.filter(s => s && typeof s.enJA === 'string' && s.enJA.trim());
  // Only a row stamped for Japanese counts; a bare text column is not provenance.
  const japanese = japaneseRows.find(s => s.translation && s.translation.target === 'ja' && s.translation.model);
  // Provider endpoints are infrastructure, not result data: the export names the
  // model, a host-only label and the missing fields, never the URL, path or query.
  const stage = (name, fields) => {
    const visible = fields.map(([key, value]) => (key === 'provider' ? ['provider', hostOf(value)] : [key, value]));
    const missing = visible.filter(([, value]) => !value).map(([key]) => key);
    return { stage: name, status: missing.length ? (missing.length === visible.length ? 'absent' : 'partial') : 'recorded', missing, ...Object.fromEntries(visible) };
  };
  return {
    schemaVersion: 1,
    exportedAt: now,
    recordingId: String(source.recordingId ?? source.id ?? ''),
    segments: segments.length,
    stages: [
      // Transcription identity is already stored as a fingerprint, not as a URL.
      stage('transcribe', [['fingerprint', source.fingerprint || null], ['completedAt', source.transcribedAt || null]]),
      stage('correct', [['provider', source.correctionEndpoint || null], ['model', source.correctionModel || null], ['completedAt', source.correctedAt || null]]),
      stage('translate', [['provider', recorded?.translation?.endpoint || null], ['model', recorded?.translation?.model || null], ['translatedSegments', translated || null]]),
      // Reported separately so an English run is never credited as a Japanese one.
      stage('translate-ja', [['provider', japanese?.translation?.endpoint || null], ['model', japanese?.translation?.model || null], ['translatedSegments', japaneseRows.length || null]]),
      stage('summarize', [['provider', source.summaryEndpoint || null], ['model', source.summaryModel || null], ['completedAt', source.summarizedAt || null]])
    ],
    // Chinese and English figures are only comparable when the whole recording was
    // translated under one identity; the count makes the shortfall visible.
    english: { segments: segments.length, recorded: translated },
    // Japanese is optional: null means this archive was never translated into
    // Japanese, which is different from a Japanese run that recorded nothing.
    japanese: japaneseRows.length ? { segments: segments.length, recorded: japaneseRows.length } : null,
    glossary: enabled === undefined ? null : enabled
  };
}
function renderProvenance(data, now) { return JSON.stringify(provenance(data, now), null, 2) + '\n'; }
function render(recordingId, data, format = 'markdown') {
  if (!['markdown', 'json'].includes(format)) throw fail('导出格式无效，请选择 markdown 或 json');
  const value = snapshot(recordingId, data);
  return format === 'json' ? { type: 'application/json', extension: 'json', text: JSON.stringify(value, null, 2) + '\n' } : { type: 'text/markdown', extension: 'md', text: markdown(value) };
}
// An audit often spans several recordings. This aggregates the per-recording
// records without relaxing any rule: each entry is the same provenance value, ids
// are de-duplicated and bounded, and an unreadable archive is reported as an
// entry error rather than quietly dropped.
const BATCH_LIMIT = 50;
function batchProvenance(records, now = new Date().toISOString()) {
  const list = Array.isArray(records) ? records : [];
  if (!list.length) throw fail('请提供要导出的归档列表', 400);
  if (list.length > BATCH_LIMIT) throw fail('一次最多导出 ' + BATCH_LIMIT + ' 条归档的来源清单', 400);
  const seen = new Set();
  const entries = [];
  for (const record of list) {
    if (!record || typeof record !== 'object') { entries.push({ recordingId: '', error: '无法读取这条归档' }); continue; }
    const id = String(record.recordingId ?? record.id ?? '');
    if (!id) { entries.push({ recordingId: '', error: '无法识别归档编号' }); continue; }
    if (seen.has(id)) continue;
    seen.add(id);
    entries.push({ recordingId: id, provenance: provenance(record, now) });
  }
  return JSON.stringify({ schemaVersion: 1, exportedAt: now, count: entries.length, recordings: entries }, null, 2) + '\n';
}
// A readable view of the same record: what the JSON export says, without a
// spreadsheet. Missing fields stay openly missing instead of becoming blanks.
function renderProvenanceText(data, now) {
  const value = data && typeof data === 'object' && Array.isArray(data.stages) ? data : provenance(data, now);
  const labels = { transcribe: '语音识别', correct: '纠错', translate: '英文翻译', 'translate-ja': '日文翻译', summarize: '总结' };
  const status = { recorded: '已记录', partial: '信息不全', absent: '缺少记录' };
  const lines = ['# 分析来源清单', '', '> 只记录模型、服务主机与完成时间；地址路径、查询参数与密钥一律不导出。', '', '- 归档：' + (value.recordingId || '—'), '- 导出时间：' + (value.exportedAt || '—'), '- 字幕条数：' + value.segments];
  if (value.english) lines.push('- 带英文翻译来源的字幕：' + value.english.recorded + ' / ' + value.english.segments);
  if (value.japanese) lines.push('- 带日文翻译来源的字幕：' + value.japanese.recorded + ' / ' + value.japanese.segments);
  lines.push('', '| 阶段 | 状态 | 服务 | 模型 | 完成时间 | 缺失 |', '| --- | --- | --- | --- | --- | --- |');
  for (const stage of value.stages || []) {
    const cells = [
      escape(labels[stage.stage] || stage.stage),
      escape(status[stage.status] || status.absent),
      escape(stage.provider || '—'),
      escape(stage.model || (stage.fingerprint ? '未记录模型（指纹 ' + String(stage.fingerprint).slice(0, 12) + '）' : '—')),
      escape(stage.completedAt || (stage.stage === 'translate' && stage.translatedSegments ? String(stage.translatedSegments) + ' 条译文' : '—')),
      escape((stage.missing || []).length ? stage.missing.join('、') : '—')
    ];
    lines.push('| ' + cells.join(' | ') + ' |');
  }
  lines.push('');
  return lines.join('\n');
}
// One CSV for spreadsheet auditing: a fixed column order, no formulas executed by
// the spreadsheet (a leading = + - is prefixed), and no URLs or payloads.
const CSV_COLUMNS = ['归档', '标题', '已分析', '字幕条数', '已翻译', '已译日文', '语音识别', '纠错', '翻译', '日文翻译', '总结', '纠错时间', '总结时间'];
function csvCell(value) {
  // Numbers stay numeric: stringify() would turn 0 into an empty cell.
  const text = typeof value === 'number' && Number.isFinite(value) ? String(value) : string(value);
  // Excel/LibreOffice would evaluate a leading = + - @ as a formula, which turns a
  // title into a command. Prefix an apostrophe so it is always read as text.
  const safe = /^[=+\-@\t\r]/.test(text) ? "'" + text : text;
  return /[",\r\n]/.test(safe) ? '"' + safe.replace(/"/g, '""') + '"' : safe;
}
function csvProvenance(entries) {
  const rows = [CSV_COLUMNS.join(',')];
  for (const entry of Array.isArray(entries) ? entries : []) {
    const record = entry && typeof entry === 'object' ? entry : {};
    const stages = new Map((Array.isArray(record.stages) ? record.stages : []).map(stage => [stage && stage.stage, stage || {}]));
    const status = name => {
      const stage = stages.get(name);
      if (!stage) return '缺少记录';
      if (stage.status === 'recorded') return '已记录';
      if (stage.status === 'partial') return '信息不全';
      return '缺少记录';
    };
    rows.push([
      record.recordingId, record.title, record.analyzed === false ? '否' : '是',
      // Zero is a real count, so only a non-number becomes an empty cell.
      typeof record.segments === 'number' ? record.segments : '',
      record.english && typeof record.english.recorded === 'number' ? record.english.recorded : '',
      // null (never translated into Japanese) and 0 (translated, nothing recorded)
      // are different facts, so null becomes an empty cell and 0 stays 0.
      record.japanese ? record.japanese.recorded : '',
      status('transcribe'), status('correct'), status('translate'), status('translate-ja'), status('summarize'),
      stages.get('correct') && stages.get('correct').completedAt, stages.get('summarize') && stages.get('summarize').completedAt
    ].map(csvCell).join(','));
  }
  return rows.join('\r\n') + '\r\n';
}
module.exports = { snapshot, provenance, renderProvenance, renderProvenanceText, batchProvenance, csvProvenance, CSV_COLUMNS, render, stamp };