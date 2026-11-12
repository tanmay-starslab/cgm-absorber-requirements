// S7 "Add them up" (chapter sum; PLAN_final §3 S7): per-cell optical depths (cached once per ion, CSR) stack in path
// order into the total, then the view turns from "shadows add" (tau) to "light getting through" (F = e^-tau). Step 1
// is a scrub step: scroll position = how many cells are added. Step 2 compares the trough with one cell's width.
import * as K from "../plot.js";

const STEPS = ["sum-1", "sum-2"];
const VW = 300;
const TMP = new WeakMap();   // scratch buffers per data object (overwritten every frame, never read across frames)

function visIdx(data) {
  const c = K.ion(data, K.LEAD).cells, v = [];
  for (let j = 0; j < c.n; j++) if (c.tau0[j] > 0.01) v.push(j);
  return v;
}
/* scrub progress u in [0, 1] -> cells added (fractional), evenly spaced over the cells that leave a visible dip */
export function cellsAt(data, u) {
  const v = visIdx(data), N = K.ion(data, K.LEAD).cells.n, x = K.clamp(u) * v.length, m = Math.floor(x);
  return m >= v.length ? N : v[m] + (x - m);
}

function render(ctx, state, t, data) {
  const p = K.params(scene, state), k = K.stepIndex(state, STEPS), q = p.p;
  const Fr = K.frame(ctx, state), A = K.axesMap(Fr, -VW, VW, -0.06, 1.12), I = K.ion(data, K.LEAD), c = I.cells, pk = K.picks(data);
  const ex = state.mode === "explore" && state.explore ? state.explore : null;
  const cache = K.tauCache(data, K.LEAD);
  let buf = TMP.get(data); if (!buf) { buf = new Float64Array(cache.n); TMP.set(data, buf); }
  const u = ex ? 1 : k === 0 ? K.clamp(q / 0.75) : 1, light = ex ? (ex.view === "tau" ? 0 : 1) : k === 0 ? K.seg(q, 0.78, 1) : 1;
  const kf = u >= 1 ? c.n : cellsAt(data, u), tau = K.sumTau(cache, kf, buf);
  const tauS = Math.max(1, I.totals.peakTau || 1) * 1.05;
  const depth = x => K.lerp(x / tauS, 1 - Math.exp(-x), light);
  K.axes(A, {xAlpha: 1, yAlpha: light, yTicks: [0, 0.5, 1]});
  if (light < 1) K.text(Fr, Fr.physics ? "τ  (optical depth)" : "shadows add up", Fr.box.x + 6, Fr.box.y - Fr.fs * 0.5, {size: 0.82, color: K.COL.muted, alpha: 1 - light});
  // faint per-cell curves of the cells added so far (tau view; they fade as the view turns to light)
  if (light < 1) {
    const one = new Float64Array(cache.n), whole = Math.floor(kf);
    for (const j of visIdx(data)) {
      if (j > whole) break;
      const w = j === whole ? kf - whole : 1; if (w <= 0) continue;
      one.fill(0); const s = cache.start[j], o = cache.ptr[j]; for (let i = 0; i < cache.len[j]; i++) one[s + i] = w * cache.vals[o + i];
      K.curve(A, cache.v, i => 1 - one[i] / tauS, {color: K.heatColor(c.T[j]), width: 1, alpha: 0.55 * (1 - light)});
    }
  }
  // the running total
  K.shade(A, cache.v, i => 1 - depth(tau[i]), {color: I.color, alpha: 0.10 + 0.08 * light});
  K.curve(A, cache.v, i => 1 - depth(tau[i]), {color: I.color, width: 2.5, glow: 6});
  // counter (numbers, not words): cells crossed so far
  const added = Math.min(c.n, Math.round(kf)); let nv = 0; for (const j of visIdx(data)) if (j < kf) nv++;
  if (k === 0 && !ex) K.text(Fr, `${nv} / ${pk.nVis}`, Fr.box.x + Fr.box.w, Fr.box.y - Fr.fs * 0.5, {align: "right", size: 0.86, mono: true, color: K.COL.muted});
  void added;
  // step 2: the trough is wide because the cells move; one cell is narrow
  if (k === 1 && !ex && pk.trough && Number.isFinite(pk.trough[0])) {
    const a1 = K.seg(q, 0, 0.4), a2 = K.seg(q, 0.35, 0.8), y1 = A.Y(-0.02);
    K.spanH(A, A.X(pk.trough[0]), A.X(pk.trough[1]), y1, {alpha: a1, color: I.color});
    K.text(Fr, Fr.physics ? `${K.fmt(pk.trough[0], 0)} to ${K.fmt(pk.trough[1], 0)} km/s` : "the whole dip", A.X((pk.trough[0] + pk.trough[1]) / 2), y1 - Fr.fs * 0.6,
      {align: "center", size: 0.82, color: I.color, alpha: a1, halo: true});
    const j = pk.dip, fw = 1.665 * c.b[j], yy = A.Y(1 - depth(tau[Math.round(c.V[j] - cache.v[0])]) * 0.5);
    K.spanH(A, A.X(c.V[j] - fw / 2), A.X(c.V[j] + fw / 2), yy, {alpha: a2, glow: 10});
    K.text(Fr, Fr.physics ? `one cell: FWHM ${K.fmt(fw, 0)} km/s` : "one cell", A.X(c.V[j] + fw / 2) + Fr.fs * 0.5, yy + Fr.fs * 0.3, {size: 0.82, color: K.COL.accent, alpha: a2, halo: true});
  }
  if (Fr.physics && light >= 1 && !ex) K.text(Fr, `peak τ ${K.fmt(I.totals.peakTau, 2)}   log₁₀ ΣN = ${K.fmt(I.totals.logN, 2)}`, Fr.box.x + 6, Fr.box.y - Fr.fs * 0.5, {size: 0.74, mono: true, color: K.COL.muted});
  // Explore: tap a dip, count its cells and their spread along the beam
  if (ex && Number.isFinite(ex.tapV)) {
    const i = Math.round(ex.tapV - cache.v[0]), T = tau[i] || 0, mine = [];
    if (T > 0) for (let j = 0; j < c.n; j++) { const s = cache.start[j]; if (i >= s && i < s + cache.len[j] && cache.vals[cache.ptr[j] + i - s] > 0.05 * T) mine.push(j); }
    K.vline(A, ex.tapV, -0.04, 1.08, {color: K.COL.accent, dash: [3, 4], width: 1});
    if (mine.length) { const ls = mine.map(j => c.l[j]);
      K.text(Fr, `${mine.length} cells, ${K.fmt(Math.max(...ls) - Math.min(...ls), 0)} kpc apart`, A.X(ex.tapV), A.Y(1.08) - Fr.fs * 0.3, {align: "center", size: 0.82, color: K.COL.accent, halo: true}); }
  }
}
function ready(data) { K.tauCache(data, K.LEAD); K.picks(data); }
const controls = {view: {label: "show", options: ["light", "tau"]}, tap: {label: "tap a dip", kind: "tapV"}};
const scene = {id: "sum", chapter: "sum", steps: STEPS, scrub: ["sum-1"], defaults: {}, controls, ready, render,
  handoff: {ions: ["OVI"], layout: "1", R: [30000, 30000], sn: [10, 10], intr: true}};
export default scene;
export {render, ready};
