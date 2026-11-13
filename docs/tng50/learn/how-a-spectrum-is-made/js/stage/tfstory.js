// Story transfer-function presets and their blend (DESIGN §5 presets, DESIGN_final §3.4, C_eng P2-9; tf.js THOR states).
// A preset names the colour field, the emissivity weight, a tf.js state and the volume look. blendTF(a, b, mix) returns what
// the stage uploads this frame: one 256×64 RGBA TF (64 kB) and the uniforms. Same field and weight: the TF bytes are mixed
// linearly. Different fields cannot be mixed inside one ray march, so the outgoing preset fades its opacity to 0 by mix 0.5
// and the incoming one fades in from 0.5 (a dip through clear sky, never a pop). Pure (no GL), node-testable.
// Dark-sky rule (C_ux P0-3): flight presets spend opacity on structure (cool clouds, the disk), keep the diffuse halo faint, and
// the stage fogs emission to black beyond `fog` (kpc from the camera). B2/B6 use `halo`, which shows the diffuse medium.
import {buildTF, preset as tfPreset, THOR, TF_W, TF_H} from "../../../../js/tf.js";
import {lut} from "../../../../js/colormaps.js";

const ION_RGB = {OVI: [251, 122, 60], HI: [146, 147, 248]};
export const PRESETS = {
  /* n_H ramp, magma: the opacity sits in the top of the window (clouds and disk); the halo below 10^-3.6 is clear */
  density: {field: "nH", weight: null, lut: "magma", look: {volK: 1.6, gain: 1.4, opacity: 0.55, knee: [0.6, 0.95]}, fog: [40, 140],
    state: () => ({...tfPreset("ramp", {vmin: -6, vmax: 0.4, volWin: [-3.6, 0.4]}), win: [-6, 0.4]})},
  /* the diffuse hot medium visible (B2, B6; G11 exempt): the ramp starts at 10^-4.6 */
  halo: {field: "nH", weight: null, lut: "magma", look: {volK: 1.6, gain: 1.8, opacity: 0.6, knee: [0.6, 0.95]}, fog: [0, 0],
    state: () => ({...tfPreset("ramp", {vmin: -6, vmax: 0.4, volWin: [-4.6, 0.0]}), win: [-6, 0.4]})},
  /* THOR gas phases: colour by T, brightness by n_H (tf.js THOR, Byrohl & Nelson 2025) */
  phases: {field: "T", weight: "nH", lut: null, look: {volK: 1.6, gain: 1.0, opacity: 0.5}, fog: [40, 140], wRef: -3.4,
    state: () => tfPreset("thor", {vmin: 3.9, vmax: 7.6})},
  "ion:OVI": {field: "OVI", weight: null, lut: null, look: {volK: 1.6, gain: 1.3, opacity: 0.5, knee: [0.55, 0.9]}, fog: [40, 140],
    state: () => ({twoD: false, shade: 0, emis: "", gamma: 1, win: [-10.6, -5.6], gmax: 0.5, ramp: null,
      bands: [{c: -8.4, w: 0.3, a: 0.08, rgb: ION_RGB.OVI}, {c: -7.5, w: 0.35, a: 0.4, rgb: ION_RGB.OVI}, {c: -6.6, w: 0.4, a: 0.8, rgb: [255, 200, 150]}]})},
  "ion:HI": {field: "HI", weight: null, lut: null, look: {volK: 1.6, gain: 1.6, opacity: 0.6, knee: [0.45, 0.8]}, fog: [40, 140],
    state: () => ({twoD: false, shade: 0, emis: "", gamma: 1, win: [-10.5, -0.6], gmax: 0.5, ramp: null,
      bands: [{c: -7.5, w: 0.8, a: 0.2, rgb: ION_RGB.HI}, {c: -5.0, w: 0.9, a: 0.6, rgb: ION_RGB.HI}, {c: -2.5, w: 1.0, a: 0.95, rgb: [210, 215, 255]}]})},
  metals: {field: "Z", weight: "nH", lut: "viridis", look: {volK: 1.6, gain: 1.8, opacity: 0.6}, fog: [40, 140], wRef: -3.92, gamma: 0.7,
    state: () => ({twoD: false, shade: 0, emis: "nH", gamma: 0.7, win: [-1.6, 0.4], gmax: 0.5, bands: [], ramp: {lo: -1.4, hi: 0.3, a: 0.7}})},
  /* vel3d volume mode: colour = v_los (tng_vel), opacity from the n_H window. Phase 1: window ±150 km/s (was ±200), so the
     story's components (−96 … +102 km/s) sit in the saturated part of the colour map instead of near its grey centre */
  /* phase 1b (review2 beauty H2: a third of B6 clipped to flat white): tng_vel is a light grey at V = 0 and the dense disk is
     nearly at rest along the beam, so at gain 1.8 it summed to white. Now gas at rest emits 15 % (rising to 100 % at |V| >= 70
     km/s, uVelRest), the gain is 1.3 and the knee rolls off from 0.45 to 0.8: the moving gas carries the colour, which is the
     beat's point ("where a dip sits means speed") */
  speed: {field: "vel", weight: "nH", vel: true, lut: "tng_vel", look: {volK: 1.6, gain: 1.3, opacity: 0.6, knee: [0.45, 0.8], velRest: [0.15, 70]}, fog: [40, 140], vwin: [-150, 150], wwin: [-3.8, 0.4]}};

/* hue-preserving knee (start, top) on the max channel of the volume emission; no rest dimming */
export const DEF_KNEE = [0.6, 1.0], NO_REST = [1, 60];
const cache = new Map();
export function presetBytes(id) {
  if (cache.has(id)) return cache.get(id);
  const p = PRESETS[id]; if (!p) throw new Error(`tfstory: unknown preset ${id}`);
  const out = p.vel ? {bytes: null, lut: lut(p.lut), state: null} : (() => { const st = p.state(); return {state: st, bytes: buildTF(st, p.lut ? lut(p.lut) : null), lut: lut(p.lut || "magma")}; })();
  cache.set(id, out); return out;
}
const lerp = (a, b, t) => a + (b - a) * t;
/* fields needed to draw preset id (colour + weight), for residency and prefetch */
export const fieldsOf = id => { const p = PRESETS[id]; return p ? [p.vel ? "vel" : p.field, p.weight].filter(Boolean) : []; };

/* -> {id, colorField, weightField, vel, bytes (Uint8Array TF_W·TF_H·4 or null), lut (Uint8Array 1024), uniforms, fog, alphaScale} */
export function blendTF(from, to = from, mix = 0, {darkSky = true} = {}) {
  const A = PRESETS[from], B = PRESETS[to] || A; mix = Math.max(0, Math.min(1, mix));
  const same = A === B || (!A.vel && !B.vel && A.field === B.field && A.weight === B.weight);
  const one = (id, p, aScale) => {
    const pb = presetBytes(id), st = pb.state;
    let bytes = pb.bytes;
    if (bytes && aScale < 1) { bytes = bytes.slice(); for (let i = 3; i < bytes.length; i += 4) bytes[i] = Math.round(bytes[i] * aScale); }
    const u = p.vel
      ? {uTFOn: 0, uVq: 1, uWin: p.vwin, uWWin: p.wwin}
      : {uTFOn: 1, uVq: 0, uTFWin: st.win, uTF2D: st.twoD ? 1 : 0, uShade: st.shade || 0, uGradMax: st.gmax || 0.5,
         uTFW: p.weight ? 1 : 0, uGamma: p.weight ? (p.gamma ?? st.gamma ?? 1) : 0, uWRef: p.wRef ?? 0};
    return {id, colorField: p.vel ? null : p.field, weightField: p.weight, vel: !!p.vel, bytes, lut: pb.lut, uniforms: {...u, uVolK: p.look.volK, uVolGain: p.look.gain, uKnee: p.look.knee || DEF_KNEE, uVelRest: p.look.velRest || NO_REST,
      uOpacity: p.vel ? p.look.opacity * Math.sqrt(aScale) : p.look.opacity}, fog: darkSky ? p.fog : [0, 0], alphaScale: aScale};
  };
  if (same) {
    if (mix === 0 || A === B) return one(from, A, 1);
    if (mix === 1) return one(to, B, 1);
    const a = one(from, A, 1), b = one(to, B, 1), bytes = new Uint8Array(a.bytes.length);
    for (let i = 0; i < bytes.length; i++) bytes[i] = Math.round(lerp(a.bytes[i], b.bytes[i], mix));
    const uni = {...a.uniforms}; for (const k of ["uVolK", "uVolGain", "uOpacity", "uGamma", "uWRef"]) uni[k] = lerp(a.uniforms[k], b.uniforms[k], mix);
    for (const k of ["uKnee", "uVelRest"]) uni[k] = [lerp(a.uniforms[k][0], b.uniforms[k][0], mix), lerp(a.uniforms[k][1], b.uniforms[k][1], mix)];
    uni.uTFWin = [lerp(a.uniforms.uTFWin[0], b.uniforms.uTFWin[0], mix), lerp(a.uniforms.uTFWin[1], b.uniforms.uTFWin[1], mix)];
    return {...a, id: `${from}>${to}`, bytes, uniforms: uni, fog: [lerp(a.fog[0], b.fog[0], mix), lerp(a.fog[1], b.fog[1], mix)]};
  }
  return mix < 0.5 ? one(from, A, 1 - 2 * mix) : one(to, B, 2 * mix - 1);
}
export {TF_W, TF_H, THOR};
