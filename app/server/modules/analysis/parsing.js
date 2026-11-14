"use strict";
// Parsing ports from RuokeZhang/pocket48-summarizer (MIT, commit
// d5f45afeef1766e16525393e1beb13d24b2452ba): parsing/lrc.py and parsing/transcript.py.
//
// The local recorder stores danmaku as parsed rows already, so the LRC reader is
// used for imported danmaku files and for converting stored rows back to LRC. The
// ASR normaliser matters more: the app accepts any OpenAI-compatible endpoint and
// those disagree about field names (start/end vs begin_time, seconds vs ms).

const LRC_LINE = /^\[([0-9:.]+)\](.*)$/;
const DANMAKU_SYNC_ADVANCE_MS = 3000;
// Control characters are stripped from user-facing text. The tab is NOT stripped:
// LRC splits "author<TAB>text" on tabs, so removing them first would merge the two
// fields (and it silently did, for any line that started with the separator).
const TAB = "\u0009";
function stripControl(value) { return String(value ?? "").replace(/[\u0000-\u0008\u000a-\u001f\u007f]/g, ""); }

// "mm:ss.xx" or "hh:mm:ss.xx"; anything outside a valid clock is not a timestamp.
function parseLrcTimestamp(value) {
  const parts = String(value).split(":");
  if (parts.length < 2 || parts.length > 3) return null;
  const numbers = parts.map(part => Number(part));
  if (numbers.some(number => !Number.isFinite(number))) return null;
  const [hours, minutes, seconds] = parts.length === 2 ? [0, numbers[0], numbers[1]] : numbers;
  if (hours < 0 || minutes < 0 || minutes >= 60 || seconds < 0 || seconds >= 60) return null;
  return Math.round((hours * 3600 + minutes * 60 + seconds) * 1000);
}

// Upstream pulls danmaku three seconds earlier than the file says so a message
// appears as it is spoken rather than after it.
function parseLrc(text) {
  const parsed = [];
  String(text ?? "").split(/\r?\n/).forEach((rawLine, index) => {
    const match = LRC_LINE.exec(rawLine.trim());
    if (!match) return;
    const source = parseLrcTimestamp(match[1]);
    if (source === null) return;
    const body = match[2];
    // LRC writes "author<TAB>text"; Pocket48 builds often leave the author empty, so
    // the line begins with the separator. Both sides therefore come from the index,
    // and index 0 means "empty author, text starts after the tab".
    const tab = body.indexOf(TAB);
    const author = stripControl(tab > 0 ? body.substring(0, tab) : "");
    const comment = stripControl(tab >= 0 ? body.substring(tab + 1) : body);
    if (!comment) return;
    parsed.push({ timestampMs: Math.max(0, source - DANMAKU_SYNC_ADVANCE_MS), index, author, text: comment });
  });
  parsed.sort((a, b) => a.timestampMs - b.timestampMs || a.index - b.index);
  return parsed.map((row, position) => ({ sequence: position + 1, timestampMs: row.timestampMs, author: row.author, text: row.text }));
}

function toLrc(rows) {
  return (Array.isArray(rows) ? rows : [])
    .filter(row => row && String(row.text ?? "").trim())
    .map(row => {
      const ms = Math.max(0, Number(row.timestampMs) || 0) + DANMAKU_SYNC_ADVANCE_MS;
      const minutes = Math.floor(ms / 60000);
      const seconds = ((ms % 60000) / 1000).toFixed(2).padStart(5, "0");
      const rawAuthor = stripControl(row.author || "");      const author = [...rawAuthor].map(ch => (ch === TAB || ch === "\r" || ch === "\n" ? " " : ch)).join("");
      return `[${minutes < 10 ? "0" : ""}${minutes}:${seconds}]${author ? author + TAB : TAB}${stripControl(row.text).replace(/[\r\n]/g, " ")}`;
    }).join("\n");
}

// Upstream counts milliseconds; OpenAI-compatible endpoints usually answer in
// seconds. The field name decides first, then the magnitude.
// The field name decides first: anything ending in `_milliseconds` is
// taken as-is, `start`/`start_time`/`begin_time` are seconds when fractional and
// milliseconds when they are integers of 1000 or more (no live reply is 1000+
// seconds long in a seconds field, and a 25-minute offset is normal in ms).
function scaled(sentence, field, value) {
  const raw = Number(value);
  if (!Number.isFinite(raw)) return null;
  if (String(field).endsWith("_milliseconds")) return Math.trunc(raw);
  const named = sentence[field];
  if (typeof named === "string" && named.includes(".")) return Math.round(raw * 1000);
  return Number.isInteger(raw) && raw >= 1000 ? raw : Math.round(raw * 1000);
}
function firstScaled(sentence, fields) {
  for (const field of fields) {
    const value = sentence?.[field];
    if (value === undefined || value === null || value === "") continue;
    const parsed = scaled(sentence, field, value);
    if (parsed !== null) return parsed;
  }
  return null;
}

function startMs(sentence) {
  return firstScaled(sentence, ["begin_time_in_milliseconds", "start_time_in_milliseconds", "begin_time", "start_time", "start"]);
}
function endMs(sentence) {
  return firstScaled(sentence, ["end_time_in_milliseconds", "end_time", "end"]);
}
function normalizeAsrResult(payload) {
  let transcripts = payload?.transcripts;
  if (transcripts === undefined && payload?.output && typeof payload.output === "object") transcripts = payload.output.transcripts;
  if (!Array.isArray(transcripts)) throw Object.assign(new Error("语音识别结果缺少 transcripts"), { code: "invalid_asr_result" });
  const sentences = [];
  for (const transcript of transcripts) {
    if (!transcript || typeof transcript !== "object") continue;
    if (Array.isArray(transcript.sentences)) sentences.push(...transcript.sentences.filter(s => s && typeof s === "object"));
  }
  if (!sentences.length) throw Object.assign(new Error("语音识别没有返回可用字幕"), { code: "empty_transcript" });
  const normalized = [];
  for (const sentence of sentences) {
    const text = stripControl(sentence.text).trim();
    if (!text) continue;
    const start = startMs(sentence);
    if (start === null) continue;
    let end = endMs(sentence);
    if (end === null || end <= start) end = start + 1;
    normalized.push({ start: Math.max(0, start), end: Math.max(1, end), speaker: sentence.speaker_id === undefined || sentence.speaker_id === null ? null : String(sentence.speaker_id), text });
  }
  normalized.sort((a, b) => a.start - b.start || a.end - b.end);
  const segments = [];
  let previousStart = 0;
  for (const row of normalized) {
    const start = Math.max(previousStart, row.start);
    const end = Math.max(start + 1, row.end);
    segments.push({ sequence: segments.length + 1, startMs: start, endMs: end, speakerId: row.speaker, text: row.text });
    previousStart = start;
  }
  if (!segments.length) throw Object.assign(new Error("语音识别没有返回可用字幕"), { code: "empty_transcript" });
  return segments;
}

function formatSrtTime(milliseconds) {
  let value = Math.max(0, Math.trunc(Number(milliseconds) || 0));
  const hours = Math.floor(value / 3600000); value -= hours * 3600000;
  const minutes = Math.floor(value / 60000); value -= minutes * 60000;
  const seconds = Math.floor(value / 1000); value -= seconds * 1000;
  const pad = (n, w = 2) => String(n).padStart(w, "0");
  return `${pad(hours)}:${pad(minutes)}:${pad(seconds)},${pad(value, 3)}`;
}

function transcriptToSrt(segments) {
  const blocks = (Array.isArray(segments) ? segments : []).map((segment, index) => {
    const text = String(segment.text ?? "").replace(/\r/g, " ").replace(/\n/g, " ").trim();
    const prefix = segment.speakerId ? `[说话人 ${segment.speakerId}] ` : "";
    return [String(index + 1), `${formatSrtTime(segment.startMs)} --> ${formatSrtTime(segment.endMs)}`, prefix + text].join("\n");
  });
  return blocks.length ? blocks.join("\n\n") + "\n" : "";
}

module.exports = {
  DANMAKU_SYNC_ADVANCE_MS,
  parseLrc, toLrc, parseLrcTimestamp,
  normalizeAsrResult, transcriptToSrt, formatSrtTime,
};
