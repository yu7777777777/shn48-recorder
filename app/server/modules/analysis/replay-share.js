"use strict";
// Contract ported from RuokeZhang/pocket48-summarizer (MIT, commit
// d5f45afeef1766e16525393e1beb13d24b2452ba): security.parse_share_url accepts only a
// canonical h5.48.cn member-live share and a 6-30 digit live id. Nothing is fetched
// from the share page, and short links or bare ids are rejected on purpose.
const CANONICAL_PATH = '/2019appshare/memberLiveShare/index.html';
const SHARE_PATHS = new Set([CANONICAL_PATH, '/2019appshare/memberLiveShare', '/2019appshare/memberLiveShare/']);
const LIVE_ID = /^[0-9]{6,30}$/;
function problem(message, code, statusCode = 400) { return Object.assign(new Error(message), { code, statusCode }); }
function parseShareUrl(input) {
  const value = typeof input === 'string' ? input.trim() : '';
  if (!value || value.length > 2048) throw problem('请输入官方公开回放分享链接', 'invalid_share_url');
  let parsed;
  try { parsed = new URL(value); } catch { throw problem('分享链接格式无效', 'invalid_share_url'); }
  if (parsed.protocol !== 'https:' || parsed.hostname !== 'h5.48.cn' || parsed.port !== ''
    || parsed.username || parsed.password || !SHARE_PATHS.has(parsed.pathname) || parsed.hash) {
    throw problem('仅支持 h5.48.cn 的公开成员直播分享链接', 'unsupported_share_url');
  }
  const ids = parsed.searchParams.getAll('id');
  if (ids.length !== 1 || !LIVE_ID.test(ids[0])) throw problem('分享链接缺少有效的直播 ID', 'invalid_live_id');
  return {liveId: ids[0], canonicalUrl: `https://h5.48.cn${CANONICAL_PATH}?id=${ids[0]}`};
}
module.exports = { parseShareUrl, CANONICAL_PATH };
