// S10 "Pixels and noise" (chapter noise; PLAN_final §3 S10): 5 pixels per resolution element at R 30 000; one fixed
// noise draw (fit.js degradeV, seed = seedFor(seed, ion, 0) exactly as the explorer's one-case panel) scaled as S/N
// rises, so the sweep never flickers (purity rule (d)). Step 2: the weakest real dip (exists in F_intrinsic, tau >=
// 0.05) can hide, and the largest noise dip where the truth is flat looks like one. Flux clipped at 0 like the explorer.
import * as K from "../plot.js";
import {rng, gauss, PIX_PER_RESEL} from "../../../../js/fit.js";

const STEPS = ["noise-1", "noise-2"];

/* v2 dock: the explorer's noisy pixels at any S/N from one cached draw. degradeV computes
   flux_i = max(0, model_i + σ z_i) with z_i = gauss(rng(seed)) in pixel order and σ = √5 / (S/N); the draw z does not
   depend on S/N, so caching z per (pixel count, seed) and the noiseless model per R gives the same bits as
   plot.observed(data, k, R, sn, seed) at a fraction of the cost (checked by story_spec). Pure (memo keyed on inputs). */
const ZCACHE = new Map();
export function noiseDraw(n, seed) {
  const key = `${n}|${seed >>> 0}`;
  if (!ZCACHE.has(key)) {
    const r = rng(seed >>> 0), z = new Float64Array(n);
    for (let i = 0; i < n; i++) z[i] = gauss(r);
    if (ZCACHE.size > 24) ZCACHE.delete(ZCACHE.keys().next().value);
    ZCACHE.set(key, z);
  }
  return ZCACHE.get(key);
}
export function observedSN(data, k, R, sn, seed) {
  const base = K.observed(data, k, R, 0, seed); if (!base) return null;
  if (!(sn > 0)) return base;
  const s = +(+sn).toFixed(4), sigma = Math.sqrt(PIX_PER_RESEL) / s, z = noiseDraw(base.v.length, seed), m = base.model;
  const flux = new Float64Array(m.length);
  for (let i = 0; i < m.length; i++) flux[i] = Math.max(0, m[i] + sigma * z[i]);
  return {v: base.v, flux, model: m, sigma};
}
const VW = 300, R = 30000, SN_LO = 2, SN_HI = 100, SN_LOOK = 5;

/* the noise dip that looks real: max 3-pixel mean of (model - flux)/sigma where the truth is flat (model > 0.99) */
export function fakeDip(data, sn = SN_LOOK, seedParam = 0) {
  const P = K.prep(data), key = `fake|${sn}|${seedParam}`;
  if (!P.memo.has(key)) {
    const o = K.observed(data, K.LEAD, R, sn, K.caseSeed(seedParam, K.LEAD, 0)); let best = null;
    if (o) for (let i = 1; i < o.v.length - 1; i++) {
      if (Math.abs(o.v[i]) > VW - 20 || o.model[i - 1] < 0.99 || o.model[i] < 0.99 || o.model[i + 1] < 0.99) continue;
      const z = ((o.model[i - 1] - o.flux[i - 1]) + (o.model[i] - o.flux[i]) + (o.model[i + 1] - o.flux[i + 1])) / (3 * o.sigma);
      if (!best || z > best.z) best = {v: o.v[i], f: (o.flux[i - 1] + o.flux[i] + o.flux[i + 1]) / 3, z};
    }
    P.memo.set(key, best);
  }
  return P.memo.get(key);
}
export const snAt = u => K.logLerp(SN_LO, SN_HI, K.clamp(u));

function ring(A, v, f, rv, o) {
  const c = A.ctx; c.save(); c.globalAlpha *= o.alpha ?? 1; c.strokeStyle = o.color || K.COL.accent; c.lineWidth = 2; if (o.dash) c.setLineDash(o.dash);
  c.beginPath(); c.ellipse(A.X(v), A.Y(f), Math.abs(A.X(v + rv) - A.X(v)), A.fs * 2.2, 0, 0, 2 * Math.PI); c.stroke(); c.restore();
}

function render(ctx, state, t, data) {
  const p = K.params(scene, state), k = K.stepIndex(state, STEPS), q = p.p;
  const Fr = K.frame(ctx, state), A = K.axesMap(Fr, -VW, VW, -0.1, 1.3), I = K.ion(data, K.LEAD), pk = K.picks(data);
  const ex = state.mode === "explore" && state.explore ? state.explore : null;
  // page seed (state.seed: params.seed or the page's) plus "New noise" presses in Explore; panel case 0 like the explorer
  const seed = (Number.isInteger(p.seed) ? p.seed : 0) + (ex && Number.isFinite(+ex.newNoise) ? +ex.newNoise : 0);
  const snEnd = Number.isFinite(+p.sn) && +p.sn >= 30 ? +p.sn : SN_HI, snLook = k === 1 && Number.isFinite(+p.sn) ? +p.sn : SN_LOOK;
  const sn = ex && Number.isFinite(+ex.sn) ? +ex.sn : k === 0 ? K.logLerp(SN_LO, snEnd, K.seg(q, 0.15, 0.95)) : snLook;
  const truth = ex && ex.truth != null ? (ex.truth ? 1 : 0) : k === 1 ? K.seg(q, 0, 0.3) : 0;
  const o = K.observed(data, K.LEAD, R, sn, K.caseSeed(seed, K.LEAD, 0));
  K.axes(A, {yTicks: [0, 0.5, 1]});
  // pixel grid (first beat of step 1): 5 pixels per resolution element
  const pix = k === 0 && !ex ? 1 - K.seg(q, 0.12, 0.3) : 0;
  if (pix > 0) { ctx.save(); ctx.globalAlpha = 0.5 * pix; ctx.strokeStyle = K.COL.grid; const dv = o.v[1] - o.v[0];
    for (let i = 0; i < o.v.length; i++) { const x = Math.round(A.X(o.v[i] - dv / 2)) + 0.5; ctx.beginPath(); ctx.moveTo(x, A.Y(1.22)); ctx.lineTo(x, A.Y(-0.05)); ctx.stroke(); }
    ctx.restore(); K.text(Fr, Fr.physics ? `pixel ${K.fmt(dv, 1)} km/s, 5 per FWHM` : "5 pixels per blur width", Fr.box.x + 6, A.Y(1.26), {size: 0.78, color: K.COL.muted, alpha: pix}); }
  // data first, then the truth on top with a dark halo so it stays readable through low-S/N pixels (F7)
  K.stairs(A, o.v, o.flux, {color: I.color, width: 1.2, alpha: truth > 0 ? 1 - 0.4 * truth : 1});
  if (truth > 0) { K.curve(A, o.v, o.model, {color: K.COL.bg, width: 5, alpha: 0.7 * truth});
    K.curve(A, o.v, o.model, {color: K.COL.beam, width: 2.2, alpha: truth}); }
  K.text(Fr, `S/N ${sn >= 10 ? Math.round(sn) : sn.toFixed(1)}`, Fr.box.x + Fr.box.w, Fr.box.y - Fr.fs * 0.5, {align: "right", size: 0.9, mono: true, color: K.COL.ink});
  if (Fr.physics) K.text(Fr, `σ per pixel = √5 / (S/N) = ${K.fmt(o.sigma, 2)}`, Fr.box.x + Fr.box.w, Fr.box.y - Fr.fs * 1.75, {align: "right", size: 0.72, mono: true, color: K.COL.muted});
  if (truth > 0) K.text(Fr, Fr.physics ? "noiseless model" : "the truth", Fr.box.x + 6, Fr.box.y - Fr.fs * 0.5, {size: 0.8, color: K.COL.beam, alpha: truth});
  // step 2: a real dip the noise hides, and a noise dip that looks real
  if (k === 1 && !ex) {
    const a1 = K.seg(q, 0.3, 0.55), a2 = K.seg(q, 0.6, 0.85), w = pk.weak, fk = fakeDip(data, snLook, seed), rv = 3 * K.C_KMS / R;
    if (w) { const f = Math.exp(-w.tau); ring(A, w.v, f, rv, {alpha: a1});
      K.text(Fr, "real", A.X(w.v), A.Y(f) + A.fs * 3.3, {align: "center", size: 0.8, color: K.COL.accent, alpha: a1, halo: true}); }
    if (fk) { ring(A, fk.v, fk.f, rv, {alpha: a2, dash: [5, 4], color: K.COL.ink});
      K.text(Fr, "noise", A.X(fk.v), A.Y(fk.f) + A.fs * 3.3, {align: "center", size: 0.8, color: K.COL.ink, alpha: a2, halo: true}); }
  }
}
const controls = {sn: {label: "S/N", min: SN_LO, max: SN_HI, scale: "log", text: v => `signal to noise ${Math.round(v)}`},
  newNoise: {label: "New noise", kind: "button"}, truth: {label: "show the truth", kind: "toggle"}};
function exploreStart() { return {sn: 10, newNoise: 0, truth: false}; }
function announce(data, ex) { return `S/N ${Math.round(ex.sn)}, noise per pixel ${K.fmt(Math.sqrt(5) / ex.sn, 2)}`; }
function ready(data) { K.picks(data); fakeDip(data); }

/* ---- v2 dock mode "observed, S/N" (DESIGN_final §3.5 B12b): "pixels and noise" in the hero dock ----------------------
   pe.obs = {obs, sn, dvPix}: 5 pixels per resolution element (fit.js PIX_PER_RESEL; pixel = c/R/5), one fixed noise draw
   (seedFor(seed, ion, 0), the explorer's case-0 draw) scaled by S/N so the sweep never flickers; the truth stays on top
   with a dark halo. Pure. */
/* review M5 (beauty): display binning so a noisy spectrum never collapses into a solid band on a phone. Pixels narrower
   than 2 CSS px are averaged in groups (a display binning only, stated in the Physics layer); returns the bin factor and the
   per-bin noise. P = panel {w, v0, v1}; obs = {v, sigma}. Pure. */
export function noiseBin(P, obs) {
  if (!P || !obs || !obs.v || obs.v.length < 2) return {f: 1, sigma: obs ? obs.sigma : 0};
  const dv = Math.abs(obs.v[1] - obs.v[0]), dx = P.w * dv / Math.max(1e-9, P.v1 - P.v0);
  let f = dx >= 2 ? 1 : Math.ceil(2 / Math.max(1e-3, dx));
  // beauty H2 (fix3): when the noise per pixel exceeds 0.2 of the continuum, the display bins to one resolution element
  // (PIX_PER_RESEL pixels; S/N is quoted per resolution element, so a bin's scatter is 1/(S/N)). Display only.
  if ((obs.sigma || 0) > NOISE_BIN_SIGMA) f = Math.max(f, PIX_PER_RESEL);
  return {f, sigma: (obs.sigma || 0) / Math.sqrt(f)};
}
export const NOISE_BIN_SIGMA = 0.2;
/* top of the y-range for a noisy panel: room for ~2.5 sigma above the continuum, between 1.2 and 1.6 */
export const noiseTop = sigma => Math.min(1.6, Math.max(1.2, 1 + 2.5 * (sigma || 0)));
export function binned(v, y, f) {
  if (f <= 1) return {v, y};
  const n = Math.floor(v.length / f), bv = new Float64Array(n), by = new Float64Array(n);
  for (let i = 0; i < n; i++) { let a = 0, b = 0; for (let j = 0; j < f; j++) { a += v[i * f + j]; b += y[i * f + j]; } bv[i] = a / f; by[i] = b / f; }
  return {v: bv, y: by};
}
/* beauty H2 (fix3): observed data as points, not a joined step. A joined step at low S/N becomes a full-height barcode;
   points at ~45 % opacity read as scatter around the model. Values beyond the panel are soft-clipped (tanh knee) into a
   thin band at the top and bottom edge instead of being cut flat. Shared by B12b (dockNoise), B13 (fit) and B14 (explore). */
export function drawNoisy(A, v, y, o = {}) {
  const c = A.ctx, n = v.length; if (!c || n < 1) return;
  const top = (A.yHi ?? 1.2) - 0.015, bot = (A.yLo ?? 0) + 0.015, kt = Math.max(0.03, Math.min(0.08, top - 1)), kb = Math.max(0.03, Math.min(0.08, 0 - bot + 0.06));
  const soft = f => (f > top - kt ? top - kt + kt * Math.tanh((f - (top - kt)) / kt) : f < bot + kb ? bot + kb - kb * Math.tanh(((bot + kb) - f) / kb) : f);
  const dx = n > 1 ? Math.abs(A.X(v[1]) - A.X(v[0])) : 4, r = Math.max(1.1, Math.min(2.2, 0.32 * dx)) * Math.max(1, (A.fs || 22) / 22);
  c.save(); c.beginPath(); c.rect(A.box.x - 2, A.box.y - 1, A.box.w + 4, A.box.h + 2); c.clip();
  c.globalAlpha *= o.alpha ?? 0.45; c.fillStyle = o.color || K.COL.data; c.beginPath();
  for (let i = 0; i < n; i++) { if (v[i] < A.v0 || v[i] > A.v1 || !Number.isFinite(y[i])) continue; const X = A.X(v[i]), Y = A.Y(soft(y[i])); c.moveTo(X + r, Y); c.arc(X, Y, r, 0, 2 * Math.PI); }
  c.fill(); c.restore();
}
export function dockNoise(A, pe) {
  const o = pe.obs; if (!o || !o.obs) return;
  const col = K.ionColor(pe.ion), nb = noiseBin(pe.panel, o.obs), d = binned(o.obs.v, o.obs.flux, nb.f);
  // data as points at ~45 % opacity, display-binned (beauty H2), the model on top
  drawNoisy(A, d.v, d.y, {color: col, alpha: 0.5});
  K.curve(A, o.obs.v, o.obs.model, {color: K.COL.bg, width: 4.5, alpha: 0.6});
  K.curve(A, o.obs.v, o.obs.model, {color: K.COL.beam, width: 1.8, alpha: 0.9});
}
const scene = {id: "noise", chapter: "noise", steps: STEPS, defaults: {}, controls, exploreStart, announce, ready, render,
  seedRule: "seed = explorer hash seed (0 unless the reader sets one); noise draw = fit.js seedFor(seed, 'OVI', 0), the explorer's case-0 draw",
  handoff: {ions: ["OVI"], layout: "1", R: [30000, 30000], sn: [5, 5], intr: true}};
export default scene;
export {render, ready};
