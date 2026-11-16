// Tier A per-story TF block (DESIGN_tierA §6.2 step 10; R4), split out of tfstory.js (fix1 round 2, review perf M2) so the
// hero's page shell never downloads it: main.js imports this module only for a ?story= case story, before the stage warms up.
import {TF_CACHE as cache, STORY_PRESETS as PRESETS} from "./tfstory.js";
import {preset as tfPreset} from "../../../../js/tf.js";

/* applyStoryTF(beats.meta.tf) retunes the presets in place before the stage warms up (DESIGN_tierA §6.2 step 10;
   fields in beats.schema.json tfBlock; derivation in tests/js/story_g11.mjs deriveTFBlock). The hero never calls it. */
const BASE = {...PRESETS}, EXTRA_RGB = {CIV: [229, 195, 58], MgII: [110, 168, 254], NeVIII: [242, 99, 99]};
const fin = w => Array.isArray(w) && w.length === 2 && w.every(Number.isFinite) && w[0] < w[1];
export function checkTFBlock(tf) {
  const e = [];
  if (!tf || typeof tf !== "object") return ["no tf block"];
  for (const k of ["vol_window", "speed", "fog"]) if (tf[k] != null && !fin(tf[k])) e.push(`${k} not an increasing pair`);
  if (tf.fog && tf.fog[0] < 0) e.push("fog < 0");
  for (const [id, w] of Object.entries(tf.ion || {})) if (!fin(w) || w[1] - w[0] < 1) e.push(`${id} window narrower than 1 dex`);
  for (const [id, lk] of Object.entries(tf.look || {})) for (const v of Object.values(lk)) if (!(v > 0 && v <= 4)) e.push(`look ${id} outside (0, 4]`);
  const lw = (tf.ion || {})[tf.lead];
  if (tf.bands) { if (!lw) e.push("bands without a lead window");
    else tf.bands.forEach((c, i) => { const f = (c - lw[0]) / (lw[1] - lw[0]);
      if (!(f >= 0.05 && f <= 0.9)) e.push(`band ${i} at ${(f * 100).toFixed(0)} % of the window (saturated or lost)`);
      if (i && !(c > tf.bands[i - 1])) e.push("bands not increasing"); }); }
  return e;
}
export function resetStoryTF() { for (const k of Object.keys(PRESETS)) if (!(k in BASE)) delete PRESETS[k]; Object.assign(PRESETS, BASE); cache.clear(); }
export function applyStoryTF(tf) {
  resetStoryTF();
  const errs = checkTFBlock(tf);
  if (errs.length) return {ok: false, errs};
  const set = (id, st, extra = {}) => { const b = PRESETS[id]; PRESETS[id] = {...b, ...extra, state: () => st(b.state())}; };
  if (tf.vol_window) for (const id of ["density", "halo"]) {
    const d = [tf.vol_window[0] + 3.6, tf.vol_window[1] - 0.4];
    set(id, s => { const v = [s.ramp.lo + d[0], s.ramp.hi + d[1]], lo = Math.min(-6, v[0] - 0.5);
      return {...tfPreset("ramp", {vmin: lo, vmax: 0.4, volWin: v}), win: [lo, 0.4]}; });
  }
  for (const [id, w] of Object.entries(tf.ion || {})) {
    if (!PRESETS[id]) { const ion = id.slice(4), rgb = EXTRA_RGB[ion]; if (!rgb) continue;
      PRESETS[id] = {...BASE["ion:OVI"], field: ion, state: () => ({...BASE["ion:OVI"].state(), bands: BASE["ion:OVI"].state().bands.map((b, i) => ({...b, rgb: i < 2 ? rgb : rgb.map(c => Math.round(c + (255 - c) * 0.45))}))})}; }
    set(id, s => { const k = (w[1] - w[0]) / (s.win[1] - s.win[0]), kw = Math.max(0.6, Math.min(1.6, k));
      return {...s, win: w.slice(), bands: s.bands.map((b, i) => ({...b, w: b.w * kw, c: id === tf.lead && tf.bands ? tf.bands[i] : w[0] + (b.c - s.win[0]) * k}))}; });
  }
  for (const [id, lk] of Object.entries(tf.look || {})) if (PRESETS[id]) PRESETS[id] = {...PRESETS[id], look: {...PRESETS[id].look, ...lk}};
  if (tf.speed) PRESETS.speed = {...PRESETS.speed, vwin: tf.speed.slice()};
  if (tf.fog) for (const id of Object.keys(PRESETS)) if (PRESETS[id].fog[1] > 0) PRESETS[id] = {...PRESETS[id], fog: tf.fog.slice()};
  cache.clear();
  return {ok: true, errs};
}
