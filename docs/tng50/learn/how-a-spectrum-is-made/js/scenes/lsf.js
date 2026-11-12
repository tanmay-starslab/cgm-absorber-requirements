// S9 "The telescope blurs" (chapter lsf; PLAN_final §3 S9): the stored library spectrum (the explorer's own file,
// eng P1-9) blurred by fit.js degradeV with a Gaussian of FWHM c/R while R sweeps 150 000 -> 5 000; truth ticks are
// cells with tau0 > 0.1 (cells, not fitted clouds); a neutral grey bell shows the blur. Step 2 shows a black dip
// turning grey (the ion whose darkest dip lifts most at R 5 000; for any galaxy). Pure renderer.
import * as K from "../plot.js";

const STEPS = ["lsf-1", "lsf-2"];
const VW = 300, R_HI = 150000, R_LO = 5000;

/* which ion shows "black turns grey" best on this beam: darkest stored minimum < 0.1 that lifts most at R_LO */
export function greyIon(data) {
  const P = K.prep(data);
  if (!P.memo.has("greyIon")) {
    let best = K.LEAD, lift = -1;
    for (const k of [K.SAT_ION, K.LEAD]) {
      const hi = K.observed(data, k, R_HI, 0), lo = K.observed(data, k, R_LO, 0); if (!hi || !lo) continue;
      const m0 = Math.min(...hi.model), m1 = Math.min(...lo.model);
      if (m0 < 0.1 && m1 - m0 > lift) { lift = m1 - m0; best = k; }
    }
    P.memo.set("greyIon", best);
  }
  return P.memo.get("greyIon");
}
export const rAt = u => K.logLerp(R_HI, R_LO, K.clamp(u));

function render(ctx, state, t, data) {
  const p = K.params(scene, state), k = K.stepIndex(state, STEPS), q = p.p;
  const Fr = K.frame(ctx, state), A = K.axesMap(Fr, -VW, VW, 0, 1.14);
  const ex = state.mode === "explore" && state.explore ? state.explore : null;
  const g = ex && (ex.ion === K.SAT_ION || ex.ion === K.LEAD) ? ex.ion : greyIon(data), sw = g === K.LEAD ? 0 : ex ? 1 : k === 1 ? K.seg(q, 0, 0.25) : 0;
  const R = ex && Number.isFinite(+ex.R) ? +ex.R : k === 0 ? rAt(K.seg(q, 0.1, 0.95)) : rAt(K.seg(q, 0.3, 0.95));
  K.axes(A, {});
  const draw = (key, alpha) => {
    if (alpha <= 0) return;
    const I = K.ion(data, key), o = K.observed(data, key, R, 0), c = I.cells;
    if (I.F) K.curve(A, I.F.v, I.F.flux, {color: K.COL.truth, width: 1, alpha: alpha * 0.55, dash: [2, 3]});
    K.curve(A, o.v, o.model, {color: I.color, width: 2.4, glow: 6, alpha});
    for (let j = 0; j < c.n; j++) if (c.tau0[j] > 0.1 && Math.abs(c.V[j]) < VW) K.tick(A, c.V[j], {alpha: alpha * K.clamp(0.35 + 0.3 * Math.log10(c.tau0[j] / 0.1)), color: K.COL.truth, y: A.Y(1.12), len: Fr.fs * 0.7, width: 1.5});
    if (key !== K.LEAD || sw < 1) K.text(Fr, Fr.physics ? `${I.name} ${Math.round(I.atom.lam0_A)}` : I.name, Fr.box.x + 6, Fr.box.y - Fr.fs * 0.5, {size: 0.82, color: I.color, alpha});
  };
  draw(K.LEAD, 1 - sw);
  if (g !== K.LEAD) draw(g, sw);
  // step 2: the darkest point of the dip and how much light it lets through at this blur
  if (k === 1 && !ex) {
    const key = g, o = K.observed(data, key, R, 0); let m = 0; for (let i = 1; i < o.v.length; i++) if (Math.abs(o.v[i]) < VW && o.model[i] < o.model[m]) m = i;
    const a = K.seg(q, 0.2, 0.4);
    K.vline(A, o.v[m], 0, o.model[m], {color: K.COL.accent, alpha: a, width: 2});
    K.text(Fr, `darkest: ${Math.round(100 * o.model[m])} % light`, A.X(o.v[m]) + Fr.fs * 0.6, A.Y(Math.max(o.model[m], 0.04)) - Fr.fs * 0.3, {size: 0.84, color: K.COL.accent, alpha: a, halo: true});
  }
  // grey bell: FWHM = c/R, drawn to scale on the speed axis
  const fw = K.C_KMS / R, bx = VW * 0.68, base = A.Y(0.06), h = Fr.box.h * 0.22;
  K.bell(A, bx, fw, base, h);
  K.text(Fr, Fr.physics ? `FWHM = c/R = ${K.fmt(fw, 1)} km/s` : "blur", A.X(bx), base + Fr.fs * 1.1, {align: "center", size: 0.78, color: K.COL.blur, mono: Fr.physics});
  K.text(Fr, `R = ${K.fmtInt(R)}`, Fr.box.x + Fr.box.w, Fr.box.y - Fr.fs * 0.5, {align: "right", size: 0.86, mono: true, color: K.COL.muted});
  K.corner(Fr, Fr.physics ? "ticks: cells with τ₀ > 0.1" : "ticks: gas cells", true, {row: 1, size: 0.7});
}
const controls = {R: {label: "sharpness R", min: R_LO, max: R_HI, scale: "log", text: v => `resolving power ${K.fmtInt(v)}, blur ${K.fmt(K.C_KMS / v, 0)} kilometres per second`},
  ion: {label: "ion", options: [K.LEAD, K.SAT_ION]}};
function exploreStart() { return {R: 30000, ion: K.LEAD}; }
function announce(data, ex) { return `Blur ${K.fmt(K.C_KMS / ex.R, 0)} km/s at R ${K.fmtInt(ex.R)}`; }
function ready(data) { K.picks(data); greyIon(data); }
const scene = {id: "lsf", chapter: "lsf", steps: STEPS, defaults: {}, controls, exploreStart, announce, ready, render,
  handoff: {ions: ["OVI"], layout: "2R", R: [30000, 5000], sn: [10, 10], intr: true}};
export default scene;
export {render, ready};
