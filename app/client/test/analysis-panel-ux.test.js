import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

// Pins the subtitle-recognition UX fixes on the analysis panel: the re-transcribe
// confirmation (with server-side before_retranscribe backup), the corrected
// confirm condition covering Japanese translations, the 4s poll no longer
// re-rendering the panel or rebuilding the caption track when nothing changed,
// the queue-depth hint, the ~500ms playhead throttle on the detail page, and the
// failure cap on the replay-import status poll. The pages themselves are
// exercised in a browser; these checks catch the regressions a rebuild could hide.
const here = path.dirname(fileURLToPath(import.meta.url));
const src = path.join(here, "..", "src");
const read = (file) => readFileSync(path.join(src, file), "utf8");

const panel = read("components/AnalysisPanel.jsx");
const helperSource = panel
  .split("\n")
  .filter(line => /^(export const (sameJson|segmentTrackSignature)|export function queueDepthHint)/.test(line))
  .join("\n")
  .replace(/^export /gm, "");
const { sameJson, segmentTrackSignature, queueDepthHint } = new Function(`${helperSource};return { sameJson, segmentTrackSignature, queueDepthHint };`)();

test("re-running recognition on existing subtitles confirms before it wipes them", () => {
  const taskSource = panel.slice(panel.indexOf("async function task"), panel.indexOf("const [target,setTarget]"));
  assert.ok(taskSource.length > 0, "task() must stay in AnalysisPanel.jsx");
  // The confirm guard fires only when subtitles already exist (SRT import,
  // manual corrections, or a previous run); a first generation starts unasked.
  assert.match(taskSource, /kind==='transcribe'&&data\.segments\.length>0&&!window\.confirm\('将以当前词库与模型重新识别，现有字幕（含手动纠错）会自动备份为最近一次还原点。是否继续？'\)/);
  // The request still goes out through the shared POST once confirmed.
  assert.match(taskSource, /adminApi\.post\(`\/analysis\/\$\{id\}`/);
});

test("the correction confirm also fires when only Japanese translations exist", () => {
  const taskSource = panel.slice(panel.indexOf("async function task"), panel.indexOf("const [target,setTarget]"));
  assert.match(taskSource, /data\.segments\.some\(s=>s\.en\|\|s\.enJA\|\|s\.translation\)/);
  assert.match(taskSource, /!window\.confirm\('纠错完成后将清空现有翻译、章节和精彩片段，保留原文供恢复。是否继续？'\)/);
});

test("the 4s poll keeps references stable when the normalized payload is unchanged", () => {
  const refreshSource = panel.slice(panel.indexOf("const refresh=async"), panel.indexOf("usePolling(refresh"));
  assert.ok(refreshSource.length > 0, "refresh must stay in AnalysisPanel.jsx");
  // Deep-compare short-circuit: identical JSON keeps the old state reference so
  // React bails out instead of re-rendering the panel and rebuilding tracks.
  assert.match(refreshSource, /setData\(cur=>sameJson\(cur,next\)\?cur:next\)/);
  assert.match(refreshSource, /sameJson\(cur,list\)\?cur:list/);
  assert.match(panel, /usePolling\(refresh,4000,\[id,audio\]\)/);
  assert.equal(sameJson({ a: 1, b: [1, 2] }, { a: 1, b: [1, 2] }), true);
  assert.equal(sameJson([1, 2], [1, 2]), true);
  assert.equal(sameJson(null, null), true);
  assert.equal(sameJson({ a: 1 }, { a: 2 }), false);
  assert.equal(sameJson({}, null), false);
});

test("the caption track depends on segment content, not on fresh array references", () => {
  assert.match(panel, /const segmentsSignature=useMemo\(\(\)=>segmentTrackSignature\(data\.segments\),\[data\.segments\]\)/);
  assert.match(panel, /\},\[video,segmentsSignature,language\]\);/);
  // Content-equal arrays (what the poll produces) share one signature; a text
  // edit, a timing change, or an appended line changes it.
  const segments = [{ start: 1.5, end: 3, text: "第一句" }, { start: 3, end: 4, text: "第二句" }];
  assert.equal(segmentTrackSignature([]), "");
  assert.equal(segmentTrackSignature("nope"), "");
  assert.equal(segmentTrackSignature(segments), "1.5_3_第一句|3_4_第二句");
  assert.equal(segmentTrackSignature(segments), segmentTrackSignature(segments.map(s => ({ ...s }))));
  assert.notEqual(segmentTrackSignature(segments), segmentTrackSignature(segments.map(s => ({ ...s, text: "改过" }))));
  assert.notEqual(segmentTrackSignature(segments), segmentTrackSignature([...segments, { start: 4, end: 5, text: "新增" }]));
});

test("queued jobs surface the queue depth from the shared analysis queue endpoint", () => {
  const refreshSource = panel.slice(panel.indexOf("const refresh=async"), panel.indexOf("usePolling(refresh"));
  // Fetched alongside the same 4s poll, best-effort: its own try/catch keeps a
  // queue failure silent so it never disturbs the main analysis data.
  assert.match(refreshSource, /try\{const status=payload\(await adminApi\.get\('\/analysis\/queue'\)\);[\s\S]*?\}catch\(e\)\{\}/);
  assert.match(refreshSource, /setQueueDepth/);
  assert.match(panel, /const queuedHint=queueDepthHint\(data\.job,queueDepth\)/);
  assert.match(panel, /\{queuedHint\} · \{data\.job\.progress\|\|0\}%/);
  // Only a task still parked in the queue (progress 0, phase mentions 排队) gets
  // the hint; the server's queued count includes this very task, so "ahead" is
  // that count minus one, and a lone task shows no misleading count.
  assert.equal(queueDepthHint({ status: "queued", progress: 0, phase: "排队等待识别" }, 3), " · 前面还有 2 个任务");
  assert.equal(queueDepthHint({ status: "queued", progress: 0, phase: "排队" }, 1), "");
  assert.equal(queueDepthHint({ status: "queued", progress: 0, phase: "排队" }, 0), "");
  assert.equal(queueDepthHint({ status: "queued", progress: 0, phase: "排队" }, undefined), "");
  assert.equal(queueDepthHint({ status: "queued", progress: 40, phase: "排队" }, 5), "");
  assert.equal(queueDepthHint({ status: "queued", progress: 0, phase: "提取音频" }, 5), "");
  assert.equal(queueDepthHint({ status: "running", progress: 0, phase: "排队" }, 5), "");
  assert.equal(queueDepthHint(null, 5), "");
});

test("the detail page throttles playhead position updates to about 500ms", () => {
  const detail = read("pages/RecordingDetail.jsx");
  assert.match(detail, /const updatePosition = useCallback/);
  assert.match(detail, /elapsed >= 500/);
  assert.match(detail, /window\.setTimeout/);
  // Both the audio element and the video player feed the throttled updater; no
  // handler may call setPosition straight from onTimeUpdate anymore.
  assert.match(detail, /onTimeUpdate=\{e=>updatePosition\(e\.currentTarget\.currentTime\)\}/);
  assert.match(detail, /onTimeUpdate=\{event => updatePosition\(event\.currentTarget\.currentTime\)\}/);
  assert.doesNotMatch(detail, /onTimeUpdate=\{[^}]*setPosition/);

  // The updater's exact source is lifted and executed against fake timers: a
  // leading update, at most one trailing update per 500ms window, and the final
  // position always lands (pause or seek inside the window is never lost).
  const start = detail.indexOf("const positionClock");
  const end = detail.indexOf("}, []);", start);
  assert.ok(start >= 0 && end > start, "throttled updater must stay self-contained in RecordingDetail.jsx");
  const chunk = detail.slice(start, end + "}, []);".length);
  const clock = { now: 100000, timers: new Map(), next: 0 };
  const fakeWindow = {
    setTimeout(fn, delay) { const tid = ++clock.next; clock.timers.set(tid, { fn, at: clock.now + Math.max(0, delay) }); return tid; },
    clearTimeout(tid) { clock.timers.delete(tid); },
  };
  const fakeDate = { now: () => clock.now };
  const advance = ms => { clock.now += ms; for (const [tid, timer] of [...clock.timers]) if (timer.at <= clock.now) { clock.timers.delete(tid); timer.fn(); } };
  const pending = () => clock.timers.size;
  const updates = [];
  const updatePosition = new Function("useCallback", "useRef", "setPosition", "window", "Date", `${chunk};return updatePosition;`)(
    fn => fn, value => ({ current: value }), value => updates.push(value), fakeWindow, fakeDate);

  updatePosition(1);
  assert.deepEqual(updates, [1], "the first update fires immediately");
  updatePosition(1.1);
  assert.equal(updates.length, 1);
  assert.equal(pending(), 1, "an in-window update schedules exactly one trailing call");
  updatePosition(1.2);
  updatePosition(1.3);
  assert.equal(updates.length, 1, "updates inside the same window are dropped");
  advance(500);
  assert.deepEqual(updates, [1, 1.3], "the trailing call lands the latest position");
  for (let i = 0; i < 10; i++) { advance(10); updatePosition(3 + i / 100); }
  assert.equal(updates.length, 2, "a burst of 10 timeupdate events fires only the leading update");
  advance(500);
  assert.deepEqual(updates, [1, 1.3, 3.09], "and at most one trailing update per 500ms window");
  updatePosition(9);
  advance(500);
  assert.equal(updates[updates.length - 1], 9, "the final position always lands within 500ms");
});

test("the replay-import status poll stops after five consecutive failures", () => {
  const replay = read("pages/ReplayAnalysisImport.jsx");
  const effect = replay.slice(replay.indexOf("useEffect(()=>{const id=job?.id"), replay.indexOf("async function runPreview"));
  assert.ok(effect.length > 0, "the status poll effect must stay in ReplayAnalysisImport.jsx");
  assert.match(effect, /setInterval\(poll,2000\)/);
  assert.match(effect, /failures=0,timer=null/);
  // A successful response resets the counter; the fifth consecutive failure
  // stops the timer and shows one clear message instead of erroring forever.
  assert.match(effect, /return;failures=0;setJob/);
  assert.match(effect, /failures\+=1/);
  assert.match(effect, /if\(failures>=5\)\{stop\(\);setError\("任务状态查询失败，请刷新页面重试"\);return;\}/);
  assert.match(effect, /clearInterval\(timer\)/);
});
