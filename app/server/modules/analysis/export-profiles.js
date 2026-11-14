"use strict";
// Canvas reference: RuokeZhang/pocket48-summarizer media/layouts.py.
// Portrait dimensions and bitrates below are local export recommendations, not
// upstream encoding defaults. Themes, padding and overlays are not rendered here.
const profiles = Object.freeze({
  landscape: Object.freeze({profile:'landscape',width:1920,height:1080,videoBitrate:'8M',audioBitrate:'192k',container:'mp4'}),
  portrait: Object.freeze({profile:'portrait',width:1080,height:1920,videoBitrate:'8M',audioBitrate:'192k',container:'mp4'}),
  audio: Object.freeze({profile:'audio',width:null,height:null,videoBitrate:null,audioBitrate:'192k',container:'m4a'})
});
function resolve(profile) {
  // Omission means no override: never silently choose a new default format.
  if (profile === undefined) return null;
  if (typeof profile !== 'string' || !Object.hasOwn(profiles,profile)) {
    throw Object.assign(new Error('导出档位无效，请选择 landscape、portrait 或 audio'), {statusCode:400});
  }
  return {...profiles[profile]};
}
module.exports = {resolve};
