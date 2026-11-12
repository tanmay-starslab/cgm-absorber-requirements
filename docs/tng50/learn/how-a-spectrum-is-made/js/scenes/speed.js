// S6 "The spectrum is a speed map" (chapter speed; PLAN_final §3 S6): beads on the beam (top, kpc) are joined by
// threads to the dips they make (bottom, km/s). Step 2 lights a pair of cells far apart on the beam that share one
// speed and so share one dip (picks(data).pair: |dV| < the narrower b, >= 40 kpc apart). Pure renderer.
import * as K from "../plot.js";

const STEPS = ["speed-1", "speed-2"];
const VW = 300;

function geom(Fr) {
  const top = K.sub(Fr, 0, 0, 1, Fr.port ? 0.22 : 0.26), bot = K.sub(Fr, 0, Fr.port ? 0.38 : 0.42, 1, 1);
  return {top, A: K.axesMap(bot, -VW, VW, 0, 1.1)};
}
function visible(I) { const c = I.cells, out = []; for (let j = 0; j < c.n; j++) if (c.tau0[j] > 0.1 && Math.abs(c.V[j]) < VW) out.push(j); return out; }

function render(ctx, state, t, data) {
  const p = K.params(scene, state), k = K.stepIndex(state, STEPS), q = p.p;
  const Fr = K.frame(ctx, state), {top, A} = geom(Fr), I = K.ion(data, K.LEAD), c = I.cells, pk = K.picks(data);
  const ex = state.mode === "explore" && state.explore ? state.explore : null;
  const appear = k === 0 ? K.seg(q, 0, 0.3) : 1, reveal = k === 0 ? K.seg(q, 0.3, 1) : 1, pair = k === 1 ? K.seg(q, 0, 0.5) : 0;
  const pairSet = new Set(pk.pair || []);
  // brushing (Explore): a kpc range on the beam or a speed range on the spectrum
  const inL = j => ex && ex.brushL ? c.l[j] >= Math.min(...ex.brushL) && c.l[j] <= Math.max(...ex.brushL) : false;
  const inV = j => ex && ex.brushV ? c.V[j] >= Math.min(...ex.brushV) && c.V[j] <= Math.max(...ex.brushV) : false;
  const lit = j => (ex ? inL(j) || inV(j) : pairSet.has(j));
  const anyLit = ex ? !!(ex.brushL || ex.brushV) : pair > 0;
  // top: the beam with its cells
  const S = K.rayStrip(top, data, K.LEAD, {alpha: appear, labels: appear, label: Fr.physics ? "l (kpc along the sightline)" : "position along the beam"});
  for (let j = 0; j < c.n; j++) {
    const vis = K.clamp(Math.log10(Math.max(c.tau0[j], 1e-4) / 0.01) / 2.3), r = K.clamp(1.4 + 2.4 * Math.sqrt(Math.max(c.dl[j], 0)), 1.4, 8);
    const dim = anyLit && !lit(j) ? 0.25 : 1;
    K.bead(top, S.X(c.l[j]), S.y, r, K.heatColor(c.T[j]), appear * (0.08 + 0.6 * vis) * dim);
  }
  // bottom: the O VI spectrum (cell sum drawn from the data's F_intrinsic, PLAN_final §6: S5 to S8 draw the cell sum)
  K.axes(A, {xAlpha: appear, yAlpha: appear, yTicks: [0, 0.5, 1]});
  if (I.F) K.curve(A, I.F.v, I.F.flux, {color: I.color, width: 2.2, alpha: appear, glow: 5});
  // threads: cell -> its dip position on the continuum, in path order
  const vis = visible(I), nShow = reveal * vis.length;
  vis.forEach((j, n) => {
    const a = K.clamp(nShow - n), on = lit(j), w = K.clamp(Math.log10(c.tau0[j] / 0.1) / 1.2, 0.15, 1);
    if (a <= 0) return;
    const col = on ? K.COL.accent : K.heatColor(c.T[j]);
    K.thread(Fr, S.X(c.l[j]), S.y + 4, A.X(c.V[j]), A.Y(1.04), {alpha: a * (anyLit ? (on ? 0.95 : 0.12) : 0.35 + 0.55 * w), color: col, width: on ? 2 : 1.2});
    if (on) K.tick(A, c.V[j], {alpha: a, color: K.COL.accent, len: Fr.fs * 0.9});
  });
  // the pair: bracket on the beam, one shared position on the spectrum
  if (pair > 0 && pk.pair) {
    const [a, b] = pk.pair, xa = S.X(c.l[a]), xb = S.X(c.l[b]), y = S.y - Fr.fs * 1.4;
    K.spanH(top, Math.min(xa, xb), Math.max(xa, xb), y, {alpha: pair});
    K.text(Fr, `${K.fmt(Math.abs(c.l[a] - c.l[b]), 0)} kpc apart`, (xa + xb) / 2, y - Fr.fs * 0.6, {align: "center", size: 0.82, color: K.COL.accent, alpha: pair, halo: true});
    const vm = (c.V[a] + c.V[b]) / 2;
    K.text(Fr, Fr.physics ? `ΔV = ${K.fmt(Math.abs(c.V[a] - c.V[b]), 1)} km/s` : "same speed", A.X(vm), A.Y(1.04) - Fr.fs * 1.2, {align: "center", size: 0.82, color: K.COL.accent, alpha: pair, halo: true});
  }
  if (ex && ex.brushL) { const x0 = S.X(Math.min(...ex.brushL)), x1 = S.X(Math.max(...ex.brushL)); ctx.save(); ctx.fillStyle = K.COL.accentSoft; ctx.fillRect(x0, S.y - Fr.fs, x1 - x0, 2 * Fr.fs); ctx.restore(); }
  if (ex && ex.brushV) { const x0 = A.X(Math.min(...ex.brushV)), x1 = A.X(Math.max(...ex.brushV)); ctx.save(); ctx.fillStyle = K.COL.accentSoft; ctx.fillRect(x0, A.Y(1.1), x1 - x0, A.Y(0) - A.Y(1.1)); ctx.restore(); }
}

/* pointer mapping for the Explore brush: canvas CSS x/y -> {brushL} or {brushV} (the driver keeps the range) */
function hit(ctx, state, data, x, y) {
  const Fr = K.frame({canvas: ctx.canvas, setTransform() {}, fillRect() {}}, state), {top, A} = geom(Fr), half = K.prep(data).meta.half;
  if (y < top.box.y + top.box.h + Fr.fs * 2) return {brushL: half * (2 * (x - top.box.x) / top.box.w - 1)};
  return {brushV: A.V(x)};
}
function ready(data) { K.prep(data); K.picks(data); }
const controls = {brush: {label: "brush cells or speeds", kind: "brush"}};
const scene = {id: "speed", chapter: "speed", steps: STEPS, defaults: {}, controls, hit, ready, render,
  handoff: {ions: ["OVI"], layout: "1", R: [30000, 30000], sn: [10, 10], intr: true}};
export default scene;
export {render, ready};
