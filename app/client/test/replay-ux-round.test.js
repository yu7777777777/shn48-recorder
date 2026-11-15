import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

// Pins the replay UX round: the manual import form reaching old seasons through
// a pasted live id and a paginated session dropdown, import polling that
// tolerates transient status failures, the 30s public list timeout with the
// search term kept on error retry, resume-on-retry playback, and the pocket48
// watch panel speaking the new run contract. The pages themselves are exercised
// in a browser; these checks catch the regressions a rebuild could hide.
const here = path.dirname(fileURLToPath(import.meta.url));
const src = path.join(here, "..", "src");
const read = (file) => readFileSync(path.join(src, file), "utf8");

test("replay import form accepts a pasted live id without forcing roster picks", () => {
  const page = read("pages/ReplayAudit.jsx");
  assert.match(page, /直播 ID 直填/);
  assert.match(page, /可直接粘贴直播 ID 补录历史场次/);
  // Manual ids must be 6-30 digits and the guard runs before the import POST.
  assert.match(page, /\/\^\\d\{6,30\}\$\/\.test\(liveId\)/);
  assert.match(page, /直播 ID 需为 6-30 位纯数字/);
  // Submission is gated on the live id alone; the session select is no longer required.
  assert.match(page, /disabled=\{importBusy\|\|!importForm\.liveId\}/);
  assert.doesNotMatch(page, /官方直播场次<select required/);
  assert.match(page, /按成员选择近期场次，或直接粘贴直播 ID 补录更早场次/);
});

test("replay session dropdown follows the upstream next cursor with de-duplication", () => {
  const page = read("pages/ReplayAudit.jsx");
  assert.match(page, /setReplayNext\(cursor&&cursor!=="0"\?cursor:""\)/);
  assert.match(page, /\{replayNext&&!replayLoading&&<button type="button" className="text-button" onClick=\{loadMoreReplays\}>加载更多场次<\/button>\}/);
  const loadMore = page.slice(page.indexOf("async function loadMoreReplays"), page.indexOf("useEffect(()=>{const jobId="));
  assert.ok(loadMore.length > 0, "loadMoreReplays must stay in ReplayAudit.jsx");
  assert.match(loadMore, /params:\{userId:memberId,next:replayNext\}/);
  assert.match(loadMore, /new Map\(current\.map\(item=>\[String\(item\.liveId\|\|item\.replayId\),item\]\)\)/);
});

test("replay import polling survives transient status failures up to three attempts", () => {
  const page = read("pages/ReplayAudit.jsx");
  const poll = page.slice(page.indexOf("const poll=async()=>{"), page.indexOf("async function scan("));
  assert.ok(poll.length > 0, "the import poll closure must stay in ReplayAudit.jsx");
  // A successful response resets the strike counter.
  assert.match(poll, /importPollFailures\.current=0/);
  assert.match(poll, /const failures=importPollFailures\.current\+1/);
  assert.match(poll, /状态查询失败，正在重试（\$\{failures\}\/3）/);
  // "failed" is only declared on the third consecutive strike, never on the first.
  const beforeVerdict = poll.slice(poll.indexOf("catch(e){"), poll.indexOf("if(failures>=3)"));
  assert.doesNotMatch(beforeVerdict, /status:"failed"/);
  assert.match(poll, /if\(failures>=3\)\{setImportBusy\(false\);setImportJob\(current=>\(\{\.\.\.current,status:"failed"/);
  // A fresh import starts from zero strikes.
  assert.match(page, /importPollFailures\.current=0;setImportBusy\(true\)/);
});

test("public replay list outlives the 15s default and keeps the search term on error retry", () => {
  const page = read("pages/PublicReplay.jsx");
  const listCall = page.slice(page.indexOf('publicApi.get("/replays"'), page.indexOf('publicApi.get("/replays"') + 300);
  assert.match(listCall, /params: Object\.keys\(params\)\.length \? params : undefined/);
  assert.match(listCall, /timeout: 30000/);
  // The slow hint keeps its 6s threshold; only the request timeout moved.
  assert.match(page, /slowAfterMs=\{6000\}/);
  const alert = page.slice(page.indexOf('className="public-alert"'), page.indexOf("</section>", page.indexOf('className="public-alert"')));
  assert.ok(alert.length > 0, "the list error alert must stay in PublicReplay.jsx");
  assert.match(alert, /loadReplays\(\{\s*group: groupId,\s*team: teamId,\s*memberName: searchQuery\.trim\(\),\s*\}\)/);
});

test("fetch retries resume playback from the recorded position", () => {
  const page = read("pages/PublicReplay.jsx");
  const player = read("components/VideoPlayer.jsx");
  assert.match(page, /startAt=\{pendingSeek\}/);
  assert.match(page, /onTimeUpdate=\{\(event\) => \{\s*playbackPositionRef\.current = Number\(event\?\.target\?\.currentTime\) \|\| 0;\s*\}\}/);
  assert.match(page, /setPendingSeek\(Math\.max\(0, playbackPositionRef\.current \|\| 0\)\)/);
  // Only the retry path carries a position: route changes reset it to 0.
  assert.match(page, /setPendingSeek\(0\)/);
  assert.match(player, /startAt = 0/);
  assert.match(player, /video\.currentTime = Number\(startAt\)/);
  assert.match(player, /video\.addEventListener\("loadedmetadata", handleSeekMetadata\)/);
  // Resetting the prop afterwards must not reload the stream.
  assert.doesNotMatch(player, /, startAt,\s*\n?\s*mode\]|\[stream, url, isLive, mode, startAt\]/);
});
test("replay session dropdown follows the upstream next cursor with de-duplication", () => {
  const page = read("pages/ReplayAudit.jsx");
  assert.match(page, /setReplayNext\(cursor&&cursor!=="0"\?cursor:""\)/);
  assert.match(page, /\{replayNext&&!replayLoading&&<button type="button" className="text-button" onClick=\{loadMoreReplays\}>加载更多场次<\/button>\}/);
  const loadMore = page.slice(page.indexOf("async function loadMoreReplays"), page.indexOf("useEffect(()=>{const jobId="));
  assert.ok(loadMore.length > 0, "loadMoreReplays must stay in ReplayAudit.jsx");
  assert.match(loadMore, /params:\{userId:memberId,next:replayNext\}/);
  assert.match(loadMore, /new Map\(current\.map\(item=>\[String\(item\.liveId\|\|item\.replayId\),item\]\)\)/);
});

test("replay import polling survives transient status failures up to three attempts", () => {
  const page = read("pages/ReplayAudit.jsx");
  const poll = page.slice(page.indexOf("const poll=async()=>{"), page.indexOf("async function scan("));
  assert.ok(poll.length > 0, "the import poll closure must stay in ReplayAudit.jsx");
  // A successful response resets the strike counter.
  assert.match(poll, /importPollFailures\.current=0/);
  assert.match(poll, /const failures=importPollFailures\.current\+1/);
  assert.match(poll, /状态查询失败，正在重试（\$\{failures\}\/3）/);
  // "failed" is only declared on the third consecutive strike, never on the first.
  const beforeVerdict = poll.slice(poll.indexOf("catch(e){"), poll.indexOf("if(failures>=3)"));
  assert.doesNotMatch(beforeVerdict, /status:"failed"/);
  assert.match(poll, /if\(failures>=3\)\{setImportBusy\(false\);setImportJob\(current=>\(\{\.\.\.current,status:"failed"/);
  // A fresh import starts from zero strikes.
  assert.match(page, /importPollFailures\.current=0;setImportBusy\(true\)/);
});

test("public replay list outlives the 15s default and keeps the search term on error retry", () => {
  const page = read("pages/PublicReplay.jsx");
  const listCall = page.slice(page.indexOf('publicApi.get("/replays"'), page.indexOf('publicApi.get("/replays"') + 300);
  assert.match(listCall, /params: Object\.keys\(params\)\.length \? params : undefined/);
  assert.match(listCall, /timeout: 30000/);
  // The slow hint keeps its 6s threshold; only the request timeout moved.
  assert.match(page, /slowAfterMs=\{6000\}/);
  const alert = page.slice(page.indexOf('className="public-alert"'), page.indexOf("</section>", page.indexOf('className="public-alert"')));
  assert.ok(alert.length > 0, "the list error alert must stay in PublicReplay.jsx");
  assert.match(alert, /loadReplays\(\{\s*group: groupId,\s*team: teamId,\s*memberName: searchQuery\.trim\(\),\s*\}\)/);
});

test("fetch retries resume playback from the recorded position", () => {
  const page = read("pages/PublicReplay.jsx");
  const player = read("components/VideoPlayer.jsx");
  assert.match(page, /startAt=\{pendingSeek\}/);
  assert.match(page, /onTimeUpdate=\{\(event\) => \{\s*playbackPositionRef\.current = Number\(event\?\.target\?\.currentTime\) \|\| 0;\s*\}\}/);
  assert.match(page, /setPendingSeek\(Math\.max\(0, playbackPositionRef\.current \|\| 0\)\)/);
  // Only the retry path carries a position: route changes reset it to 0.
  assert.match(page, /setPendingSeek\(0\)/);
  assert.match(player, /startAt = 0/);
  assert.match(player, /video\.currentTime = Number\(startAt\)/);
  assert.match(player, /video\.addEventListener\("loadedmetadata", handleSeekMetadata\)/);
  // Resetting the prop afterwards must not reload the stream.
  assert.doesNotMatch(player, /, startAt,\s*\n?\s*mode\]|\[stream, url, isLive, mode, startAt\]/);
});
