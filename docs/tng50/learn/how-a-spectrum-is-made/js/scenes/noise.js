// S10 "Pixels and noise" (chapter noise; PLAN_final §3 S10): 5 pixels per resolution element at R 30 000; one fixed
// noise draw (fit.js degradeV, seed = seedFor(seed, ion, 0) exactly as the explorer's one-case panel) scaled as S/N
// rises, so the sweep never flickers (purity rule (d)). Step 2: the weakest real dip (exists in F_intrinsic, tau >=
// 0.05) can hide, and the largest noise dip where the truth is flat looks like one. Flux clipped at 0 like the explorer.
import * as K from "../plot.js";

const STEPS = ["noise-1", "noise-2"];
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
const scene = {id: "noise", chapter: "noise", steps: STEPS, defaults: {}, controls, exploreStart, announce, ready, render,
  seedRule: "seed = explorer hash seed (0 unless the reader sets one); noise draw = fit.js seedFor(seed, 'OVI', 0), the explorer's case-0 draw",
  handoff: {ions: ["OVI"], layout: "1", R: [30000, 30000], sn: [5, 5], intr: true}};
export default scene;
export {render, ready};
