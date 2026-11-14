"use strict";

// Turn AI highlight metadata (start/end + subtitle evidence) into real clips.
// The heavy lifting (segment validation, transcode queue, concat) lives in
// recorder/clips; this module only maps highlights onto that entry point.

const manager = require("../recorder/manager");
const service = require("./service");
const clips = require("../recorder/clips");

const fail = (message, statusCode = 400) => Object.assign(new Error(message), { statusCode });

function validHighlights(rows) {
  return rows
    .map(row => ({ start: Number(row?.start), end: Number(row?.end), title: String(row?.title || "").trim() }))
    .filter(row => Number.isFinite(row.start) && Number.isFinite(row.end) && row.end > row.start);
}

// 'merged': one clip concatenating every selected highlight.
// 'separate': one clip per highlight. Returns the created clip rows (merged)
// or {queued, errors} (separate) so the UI can show partial outcomes.
function clip(id, options = {}) {
  const recording = manager.getRecording(id);
  if (!recording || recording.status === "deleted") throw fail("归档不存在", 404);
  const analysis = service.result(id);
  // `indexes` address positions in the raw analysis.highlights array — the same
  // order the settings UI displays — so a defensive filter here must not renumber
  // them. Invalid rows are simply dropped from the selection.
  const raw = Array.isArray(analysis.highlights) ? analysis.highlights : [];
  const highlights = validHighlights(raw);
  if (!highlights.length) throw fail("这条归档还没有精彩片段，请先生成章节与精彩片段分析", 409);

  let selected;
  if (options.indexes !== undefined) {
    if (!Array.isArray(options.indexes) || !options.indexes.length
      || options.indexes.some(value => !Number.isInteger(value) || value < 0 || value >= raw.length)) {
      throw fail("精彩片段序号无效");
    }
    selected = [...new Set(options.indexes)]
      .map(index => ({ ...validHighlights([raw[index]])[0], index }))
      .filter(row => Number.isFinite(row.start));
  } else {
    selected = raw.map((row, index) => ({ ...validHighlights([row])[0], index })).filter(row => Number.isFinite(row.start));
  }
  selected.sort((a, b) => a.start - b.start);
  // clips.range rejects segments shorter than 1s; drop those up front instead of
  // failing the whole batch on one stray highlight.
  const usable = selected.filter(row => row.end - row.start >= 1);
  if (!usable.length) throw fail("所选精彩片段都不足 1 秒，无法切片");

  const mode = options.mode === "separate" ? "separate" : "merged";
  const baseTitle = String(recording.title || "录像").trim().slice(0, 120);
  if (mode === "merged") {
    if (usable.length > 30) throw fail("一次最多合成 30 段，请先在参数中选择要保留的片段", 400);
    const item = clips.enqueue(id, {
      segments: usable.map(row => ({ start: row.start, end: row.end })),
      title: options.title || `${baseTitle} · 精彩合集`,
    });
    return { mode, clip: { id: item.id, title: item.title, status: item.status, duration: item.duration }, segments: usable.length };
  }
  const queued = [], errors = [];
  for (const row of usable) {
    try {
      const item = clips.enqueue(id, {
        segments: [{ start: row.start, end: row.end }],
        title: row.title ? `${row.title.slice(0, 140)} · 剪辑` : `${baseTitle} · 精彩片段 ${row.index + 1}`,
      });
      queued.push({ clipId: item.id, title: item.title, start: row.start, end: row.end, status: item.status });
    } catch (error) {
      errors.push({ start: row.start, end: row.end, error: error.statusCode ? error.message : "片段入队失败" });
      // Queue full is terminal for the rest of the batch: every following
      // segment would fail the same way, so stop instead of spamming errors.
      if (error.statusCode === 429) break;
    }
  }
  if (!queued.length && errors.length) throw fail(errors[0].error, errors[0].error.includes("队列已满") ? 429 : 400);
  return { mode, queued, errors, skippedTooShort: selected.length - usable.length };
}

module.exports = { clip, _internals: { validHighlights } };
