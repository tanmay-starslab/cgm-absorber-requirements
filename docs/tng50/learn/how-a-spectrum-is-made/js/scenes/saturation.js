// S8 "Black is a ceiling" (chapter saturation; PLAN_final §3 S8): one synthetic hydrogen dip whose amount rises from
// 10^12 to 10^13.5 (tau0 about 1: deeper, width hardly changes) and then to 10^20 per cm^2 (black: only wider), with
// two meters: "depth" (1 - F at the centre) and "width" (the real full width at half depth, not the area); damping
// wings appear only near 10^20. Then the real hydrogen trough of this beam (no wings label on it), and the meters read
// that trough. Physics on: the curve of growth with the current point.
import * as K from "../plot.js";

const STEPS = ["saturation-1", "saturation-2"];
const VW = 1000;
const GRID = K.vgrid(-VW, 1, 2 * VW + 1);
const N0 = 12, N1 = 13.5, N2 = 20;   // amounts (log N) at the ends of the two steps (steps.json saturation-1/2 logN)

function cog(data, b) {   // curve of growth W(logN) at this b: frame-independent, memoised on (data, b)
  const P = K.prep(data), key = `cog|${b}`;
  if (!P.memo.has(key)) {
    const at = K.ion(data, K.SAT_ION).atom, v = K.vgrid(-2000, 2, 2001), pts = [];
    for (let x = 11; x <= 21.001; x += 0.25) pts.push([x, K.eqWidthKms(K.expNeg(K.dipTau(at, 0, x, b, v)), 2)]);
    P.memo.set(key, pts);
  }
  return P.memo.get(key);
}
/* full width at half depth (km/s) of a dip sampled on v (any spacing): the width the eye sees */
export function fwhmKms(v, F) {
  let iMin = 0; for (let i = 1; i < F.length; i++) if (F[i] < F[iMin]) iMin = i;
  const half = 1 - (1 - F[iMin]) / 2; if (1 - F[iMin] < 1e-4) return 0;
  let a = iMin; while (a > 0 && F[a] < half) a--;
  let b = iMin; while (b < F.length - 1 && F[b] < half) b++;
  const xa = a < iMin ? v[a] + (v[a + 1] - v[a]) * (F[a] - half) / (F[a] - F[a + 1]) : v[a];
  const xb = b > iMin ? v[b - 1] + (v[b] - v[b - 1]) * (half - F[b - 1]) / (F[b] - F[b - 1]) : v[b];
  return Math.max(0, xb - xa);
}
function wRef(data, b) {   // meter scale: the width at log N 20.5 for this b (frame-independent, memoised)
  const P = K.prep(data), key = `satw|${b}`;
  if (!P.memo.has(key)) P.memo.set(key, fwhmKms(GRID, K.expNeg(K.dipTau(K.ion(data, K.SAT_ION).atom, 0, 20.5, b, GRID))));
  return P.memo.get(key);
}
function layout(Fr) {
  if (Fr.port) return {A: K.axesMap(K.sub(Fr, 0, 0, 1, 0.6), -VW, VW, 0, 1.1), M: K.sub(Fr, 0.04, 0.72, 0.96, 0.98)};
  return {A: K.axesMap(K.sub(Fr, 0, 0, 0.70, 1), -VW, VW, 0, 1.1), M: K.sub(Fr, 0.76, 0.08, 1, 1)};
}

function render(ctx, state, t, data) {
  const p = K.params(scene, state), k = K.stepIndex(state, STEPS), q = p.p;
  const Fr = K.frame(ctx, state), {A, M} = layout(Fr), H = K.ion(data, K.SAT_ION), pk = K.picks(data), at = H.atom;
  const ex = state.mode === "explore" && state.explore ? state.explore : null;
  const b = ex && Number.isFinite(+ex.b) ? +ex.b : Number.isFinite(+p.b) && +p.b > 0 ? +p.b : pk.satB;
  const logN = ex && Number.isFinite(+ex.logN) ? +ex.logN : k === 0 ? K.lerp(N0, N1, K.seg(q, 0.05, 0.95)) : K.lerp(N1, N2, K.seg(q, 0, 0.6));
  const real = ex ? 0 : k === 1 ? K.seg(q, 0.68, 1) : 0;
  const tau = K.dipTau(at, 0, logN, b, GRID), F = K.expNeg(tau), W = K.eqWidthKms(F, 1);
  K.axes(A, {xStep: 500});
  // synthetic dip
  K.shade(A, GRID, F, {color: H.color, alpha: 0.14 * (1 - real)});
  K.curve(A, GRID, F, {color: H.color, width: 2.4, glow: 6, alpha: 1 - real});
  if (logN > 19.3 && real < 1) {   // wings: only where the Lorentz part shows
    const a = K.clamp((logN - 19.3) / 0.5) * (1 - real);
    let e = VW; while (e < GRID.length - 1 && F[e] < 0.5) e++;
    const ve = GRID[e] * 1.15;
    K.text(Fr, "wings", A.X(ve), A.Y(0.62), {size: 0.8, color: K.COL.muted, alpha: a, halo: true});
    K.text(Fr, "wings", A.X(-ve), A.Y(0.62), {size: 0.8, color: K.COL.muted, alpha: a, halo: true, align: "right"});
  }
  // the real trough of this beam: the stored library spectrum (no label on its wings)
  if (real > 0 && H.line) {
    const L = H.line, vs = K.prep(data).meta.vSys, v = new Float64Array(L.n); for (let i = 0; i < L.n; i++) v[i] = L.u0 + i * L.du + vs;
    K.curve(A, v, L.flux, {color: H.color, width: 2.4, glow: 6, alpha: real});
    K.text(Fr, Fr.physics ? `this beam: H I, log₁₀ ΣN = ${K.fmt(H.totals.logN, 2)}` : "this beam's hydrogen", A.box.x + 6, A.box.y - Fr.fs * 0.5, {size: 0.82, color: H.color, alpha: real});
  }
  // meters: depth and the real width (FWHM) of the test dip; once the real trough is in, they read that trough
  const mw = M.box.w, mx = M.box.x, my = M.box.y + Fr.fs * 1.4, gap = Fr.fs * 3.2;
  let depth = 1 - F[VW], width = fwhmKms(GRID, F);
  if (real > 0.5 && H.line) {
    const L = H.line, vs = K.prep(data).meta.vSys, v = new Float64Array(L.n); for (let i = 0; i < L.n; i++) v[i] = L.u0 + i * L.du + vs;
    let m = 1; for (const f of L.flux) m = Math.min(m, f); depth = 1 - m; width = fwhmKms(v, L.flux);
  }
  const wFrac = width / wRef(data, b);
  K.meter(M, mx, my, mw, "depth", depth, `${Math.round(100 * depth)} %`, {color: k === 0 ? K.COL.accent : K.COL.ink});
  K.meter(M, mx, my + gap, mw, "width", wFrac, `${K.fmt(width, 0)} km/s`, {color: k === 1 ? K.COL.accent : K.COL.ink});
  if (real <= 0.5) K.text(M, Fr.physics ? `log N = ${K.fmt(logN, 1)}` : `amount 10^${K.fmt(logN, 1)}`, mx, my + 2 * gap, {size: 0.78, mono: true, color: K.COL.muted});
  // Physics: curve of growth (log W against log N) with the current point
  if (Fr.physics && !Fr.port && real < 0.5) {
    const pts = cog(data, b), x0 = mx, y0 = my + 2.6 * gap, w = mw, h = Math.min(mw * 0.8, M.box.h - 2.6 * gap - Fr.fs * 2);
    if (h > Fr.fs * 4) {
      const X = n => x0 + (n - 11) / 10 * w, lw0 = Math.log10(pts[0][1]), lw1 = Math.log10(Wmax), Y = W_ => y0 + h - (Math.log10(Math.max(W_, 1e-3)) - lw0) / (lw1 - lw0) * h;
      ctx.save(); ctx.strokeStyle = K.COL.grid; ctx.strokeRect(x0, y0, w, h); ctx.beginPath(); pts.forEach(([n, W_], i) => i ? ctx.lineTo(X(n), Y(W_)) : ctx.moveTo(X(n), Y(W_)));
      ctx.strokeStyle = K.COL.muted; ctx.lineWidth = 1.4; ctx.stroke(); ctx.fillStyle = K.COL.accent; ctx.beginPath(); ctx.arc(X(logN), Y(W), 4, 0, 2 * Math.PI); ctx.fill(); ctx.restore();
      K.text(M, "log W  vs  log N", x0, y0 - Fr.fs * 0.4, {size: 0.7, color: K.COL.muted});
      K.text(M, `τ₀ = ${tau[VW] > 1e4 ? K.fmtInt(tau[VW]) : K.fmt(tau[VW], 2)}`, x0, y0 + h + Fr.fs * 1.2, {size: 0.7, mono: true, color: K.COL.muted});
    }
  }
}
const controls = {
  logN: {label: "amount", unit: "log N", min: 12, max: 20.5, step: 0.05, text: v => `10 to the ${v.toFixed(1)} atoms per square centimetre`},
  b: {label: "width", unit: "km/s", min: 8, max: 60, step: 0.5, text: v => `${v.toFixed(1)} kilometres per second`},
};
function exploreStart(data) { return {logN: 14, b: +K.picks(data).satB.toFixed(1)}; }
function announce(data, ex) {
  const F = K.expNeg(K.dipTau(K.ion(data, K.SAT_ION).atom, 0, ex.logN, ex.b, GRID));
  return `Depth ${Math.round(100 * (1 - F[VW]))} percent, width ${Math.round(fwhmKms(GRID, F))} km/s`;
}
function ready(data) { K.picks(data); cog(data, K.picks(data).satB); }
const scene = {id: "saturation", chapter: "saturation", steps: STEPS, defaults: {}, controls, exploreStart, announce, ready, render,
  handoff: {ions: ["HI"], layout: "1", R: [30000, 30000], sn: [10, 10], intr: true}};
export default scene;
export {render, ready};
