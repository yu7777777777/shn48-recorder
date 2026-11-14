'use strict';
// Offline port of pocket48-summarizer clients/seedream.py and media/ai_covers.py
// (MIT; see pocket48-summarizer.LICENSE.txt and the offline reference snapshot
// docs/pocket48-summarizer-upstream-ref.json).
// Upstream: Seedream body/HTTPS validation, total-attempt retry semantics,
// one generate per unfinished asset and reuse of its cached background.
// 本地策略，非上游规则 (LOCAL SUPPLEMENT, NOT UPSTREAM): ratio clamp [1/4,4],
// full-window centered padding, first 8 candidates ordered by area/composition/
// sharpness, and default 3 total attempts clamped to [1,5].
// No image inspection, IO or paid calls.

function dimension(value, name) {
  if (!Number.isSafeInteger(value) || value <= 0) throw new RangeError(name + ' must be a positive safe integer');
  return value;
}

// external_retry_attempts counts TOTAL attempts, not retries in addition to one
// initial attempt. LOCAL policy supplies the default and clamps the configured
// total; this helper does not run a loop, sleep or issue IO.
function retryBudget(n = 3) {
  if (typeof n !== 'number' || !Number.isFinite(n)) throw new RangeError('Invalid attempt budget');
  return Math.max(1, Math.min(5, Math.trunc(n)));
}

function referenceImage(value) {
  if (typeof value !== 'string' || /[\s\\]/.test(value)) throw new TypeError('Invalid HTTPS reference image URL');
  let url;
  try { url = new URL(value); } catch { throw new TypeError('Invalid HTTPS reference image URL'); }
  const authority = value.match(/^https:\/\/([^/?#]+)(\/[^#]*)?(?:#.*)?$/);
  if (!authority || !authority[2] || url.protocol !== 'https:' || !url.hostname ||
      (url.port && url.port !== '443') || authority[1].includes('@') || url.hash || value.endsWith('#')) {
    throw new TypeError('Invalid HTTPS reference image URL');
  }
  return value;
}

// Seedream deliberately ignores seed. Explicit allowlisting prevents credentials
// or unrelated options from becoming part of the provider request body.
function buildRequest({ model, prompt, referenceImageUrl, width, height } = {}) {
  if (typeof model !== 'string' || !model.trim()) throw new TypeError('model is required');
  if (typeof prompt !== 'string') throw new TypeError('prompt is required');
  return {
    model, prompt, image: referenceImage(referenceImageUrl),
    size: dimension(width, 'width') + 'x' + dimension(height, 'height'),
    response_format: 'b64_json', watermark: false,
  };
}

// Pure counterpart of _run_generation/_generate_asset: no candidate rounds or
// automatic quality retries exist upstream. A completed asset needs no work;
// an unfinished asset with a background resumes without another generation.
// Each pending record appears once, preserving the upstream per-asset semantics.
function planAssets(assets) {
  if (!Array.isArray(assets)) throw new TypeError('assets must be an array');
  const planned = assets.filter(asset => asset.status !== 'completed').map(asset => ({
    id: asset.id, orientation: asset.orientation,
    action: asset.background_oss_object_key ? 'reuse-background' : 'generate',
  }));
  return { needsSource: planned.some(asset => asset.action === 'generate'), assets: planned };
}

// LOCAL RULE: preserve the entire source window (no face/person crop). Grow only
// the missing axis to a centered integer-pixel canvas; rounding can add <1 pixel
// per side. padX/padY are the left/top offsets; the right/bottom absorb odd pixels.
// The effective ratio is clamped to [1/4, 4]; no provider size guarantee is made.
function planExpansion({ sourceW, sourceH, targetRatio } = {}) {
  dimension(sourceW, 'sourceW'); dimension(sourceH, 'sourceH');
  let ratio = targetRatio;
  if (typeof ratio === 'string') {
    const match = ratio.match(/^(\d+(?:\.\d+)?):(\d+(?:\.\d+)?)$/);
    if (!match || Number(match[2]) <= 0) throw new RangeError('Invalid targetRatio');
    ratio = Number(match[1]) / Number(match[2]);
  }
  if (typeof ratio !== 'number' || !Number.isFinite(ratio) || ratio <= 0) throw new RangeError('Invalid targetRatio');
  const bounded = Math.max(1 / 4, Math.min(4, ratio));
  const outW = Math.max(sourceW, Math.ceil(sourceH * bounded));
  const outH = Math.max(sourceH, Math.ceil(sourceW / bounded));
  dimension(outW, 'outW'); dimension(outH, 'outH');
  return { cropW: sourceW, cropH: sourceH, padX: Math.floor((outW - sourceW) / 2),
    padY: Math.floor((outH - sourceH) / 2), outW, outH, clamped: bounded !== ratio };
}

// LOCAL RULE: inspect at most the first 8 candidates. Valid pixel area first,
// then compositionScore, sharpnessScore, then earliest arrival. No weighted score.
// Returns the original candidate without modifying input; no valid image => null.
function pickBest(candidates) {
  if (!Array.isArray(candidates)) throw new TypeError('candidates must be an array');
  let best = null, bestArea = -1, bestComposition = -Infinity, bestSharpness = -Infinity;
  const score = value => typeof value === 'number' && Number.isFinite(value) ? value : -Infinity;
  for (const candidate of candidates.slice(0, 8)) {
    if (!candidate || !Number.isSafeInteger(candidate.width) || candidate.width <= 0 ||
        !Number.isSafeInteger(candidate.height) || candidate.height <= 0) continue;
    const area = candidate.width * candidate.height;
    if (!Number.isSafeInteger(area)) continue;
    const composition = score(candidate.compositionScore), sharpness = score(candidate.sharpnessScore);
    if (area > bestArea || (area === bestArea && (composition > bestComposition ||
        (composition === bestComposition && sharpness > bestSharpness)))) {
      best = candidate; bestArea = area; bestComposition = composition; bestSharpness = sharpness;
    }
  }
  return best;
}

module.exports = { planExpansion, pickBest, retryBudget, buildRequest, planAssets };
