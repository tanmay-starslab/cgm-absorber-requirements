// S5 "One cell makes one dip" (chapter dip; PLAN_final §3 S5): a barcode, the Doppler shift, amount sets the shaded
// area, heat spreads it out. The featured cell is picks(data).dip (no hand-picked cell; any galaxy). Pure renderer.
import * as K from "../plot.js";

const STEPS = ["dip-1", "dip-2", "dip-3", "dip-4"];
const VW = 300;   // half window, km/s
const GRID = K.vgrid(-VW - 50, 1, 2 * VW + 101);

function cellOf(data) {
  const I = K.ion(data, K.LEAD), j = K.picks(data).dip, c = I.cells;
  return {I, V: c.V[j], logN: c.logN[j], b: c.b[j], tau0: c.tau0[j], T: c.T[j]};
}
/* the false-colour ultraviolet band: a cool violet-blue-teal ramp, never the visible rainbow */
function bandColor(u) { const h = 265 - 85 * u; return `hsl(${h},70%,${48 + 8 * Math.sin(Math.PI * u)}%)`; }

function render(ctx, state, t, data) {
  const p = K.params(scene, state), k = K.stepIndex(state, STEPS), q = p.p;
  const Fr = K.frame(ctx, state), A = K.axesMap(Fr, -VW, VW, 0, 1.12), cell = cellOf(data), atom = cell.I.atom, col = cell.I.color;
  const ex = state.mode === "explore" && state.explore ? state.explore : null;
  // beats (each later step holds the earlier end states)
  const band = k === 0 ? K.seg(q, 0, 0.25) * (1 - K.seg(q, 0.55, 1)) : 0;
  const dark = k === 0 ? K.seg(q, 0.25, 0.5) : 1;
  const plot = k === 0 ? K.seg(q, 0.55, 1) : 1;
  const lam = k === 1 ? 1 - K.seg(q, 0.6, 1) : k === 0 ? 1 : 0;           // 1: wavelength labels, 0: speed labels
  const shift = k === 1 ? K.seg(q, 0.25, 0.75) : k === 0 ? 0 : 1;
  const area = k === 2 ? K.seg(q, 0, 0.4) : k > 2 ? 1 : 0, arrow = k === 2 ? K.seg(q, 0.3, 0.7) : k > 2 ? 0.55 : 0;
  const span = k === 3 ? K.seg(q, 0, 0.4) : 0, ghost = k === 3 ? K.seg(q, 0.4, 1) : 0;
  // the dip (explore values override the featured cell)
  const el = ex && (ex.el === "H" || ex.ion === 1 || ex.ion === "HI") ? K.ion(data, K.SAT_ION) : null;
  const has = key => ex && Number.isFinite(+ex[key]);
  const V = has("V") ? +ex.V : K.lerp(0, cell.V, shift), logN = has("logN") ? +ex.logN : cell.logN, b = has("b") ? +ex.b : cell.b, at = el ? el.atom : atom;
  const tau = K.dipTau(at, V, logN, b, GRID), F = K.expNeg(tau, dark);
  const yBand = A.Y(1.0);
  // axes: y fades in with the plot; x labels morph from wavelength to speed
  K.axes(A, {xAlpha: plot * (1 - lam), yAlpha: plot});
  if (plot > 0 && lam > 0) {
    const vs = K.prep(data).meta.vSys, l0 = atom.lam0_A, lamAt = v => l0 * (1 + (v - vs) / K.C_KMS);
    const vAt = L => (L / l0 - 1) * K.C_KMS + vs, b0 = Fr.box, y0 = b0.y + b0.h;
    ctx.save(); ctx.globalAlpha = plot * lam; ctx.strokeStyle = K.COL.faint; ctx.beginPath(); ctx.moveTo(b0.x, y0 + 0.5); ctx.lineTo(b0.x + b0.w, y0 + 0.5); ctx.stroke(); ctx.restore();
    for (let L = Math.ceil(lamAt(-VW) * 2) / 2; L <= lamAt(VW); L += 0.5) {
      const x = A.X(vAt(L)); K.text(Fr, L.toFixed(1), x, y0 + Fr.fs * 1.25, {align: "center", size: 0.72, mono: true, color: K.COL.muted, alpha: plot * lam});
    }
    K.text(Fr, Fr.physics ? "λ (Å, observed)" : "wavelength (ångström)", b0.x + b0.w / 2, y0 + Fr.fs * 2.6, {align: "center", size: 0.78, color: K.COL.muted, alpha: plot * lam});
    K.vline(A, 0, 0, 1.08, {color: K.COL.faint, dash: [3, 4], alpha: plot * lam * (1 - shift * 0.6), width: 1});
  }
  // barcode band (S5a): the beam spread into colours, the shadow is a dark stripe; it folds down into the plot
  if (band > 0) {
    const h = Fr.box.h * 0.22 * band, y = K.lerp(Fr.box.y + Fr.box.h * 0.45, yBand, 1 - band) - h / 2, n = 240;
    for (let s = 0; s < n; s++) {
      const v = -VW + (s + 0.5) / n * 2 * VW, i = Math.round(v - GRID[0]), f = F[Math.max(0, Math.min(F.length - 1, i))];
      ctx.save(); ctx.globalAlpha = band; ctx.fillStyle = bandColor(s / (n - 1)); ctx.fillRect(A.X(v - VW / n), y, A.X(v + VW / n) - A.X(v - VW / n) + 0.6, h);
      ctx.fillStyle = `rgba(0,0,0,${(1 - f) * 0.92})`; ctx.fillRect(A.X(v - VW / n), y, A.X(v + VW / n) - A.X(v - VW / n) + 0.6, h); ctx.restore();
    }
    K.text(Fr, "ultraviolet: colours our eyes cannot see", Fr.box.x + Fr.box.w / 2, y - Fr.fs * 0.7, {align: "center", size: 0.8, color: K.COL.muted, alpha: band});
  }
  // the beam: flat line before the plot, the dip curve after
  if (k === 0 && plot < 1) K.curve(A, GRID, () => 1, {color: K.COL.beam, width: 2, alpha: (1 - band) * (1 - plot) * 0.9, glow: 8});
  if (plot > 0) {
    if (area > 0) K.shade(A, GRID, F, {color: K.COL.accent, alpha: 0.28 * area});
    if (ghost > 0) {
      // the same amount spread by a lighter atom at the same heat (hydrogen: b x sqrt(m/m_H)); same shaded area
      const bH = b * Math.sqrt(at.mass_amu / 1.008), tg = K.dipTau(at, V, logN, bH, GRID);
      K.curve(A, GRID, K.expNeg(tg), {color: K.ionColor(K.SAT_ION), width: 1.8, dash: [6, 5], alpha: ghost});
      K.text(Fr, "hydrogen, same heat", A.X(V + 1.6 * bH), A.Y(1 - (1 - Math.exp(-tg[Math.round(V - GRID[0])])) * 0.6), {size: 0.78, color: K.ionColor(K.SAT_ION), alpha: ghost, halo: true});
    }
    K.curve(A, GRID, F, {color: k === 0 ? K.COL.beam : col, width: 2.4, glow: 6, glowColor: col, alpha: plot});
    const Fmin = Math.exp(-tau[Math.round(V - GRID[0])] * dark);
    // speed: position tick (always once the plot exists)
    K.tick(A, V, {alpha: plot * (k >= 1 ? 1 : 0.6), color: k === 1 ? K.COL.accent : K.COL.muted});
    if (k === 1 || ex) K.text(Fr, Fr.physics ? `V = ${K.fmt(V, 0)} km/s` : `${K.fmt(V, 0)} km/s`, A.X(V), A.Y(1.06) - Fr.fs * 0.2, {align: "center", size: 0.78, mono: true, color: K.COL.accent, alpha: k === 1 ? K.seg(q, 0.3, 0.8) : 1, halo: true});
    // amount: vertical arrow from the continuum to the dip floor
    if (arrow > 0 || ex) {
      const a = ex ? 1 : arrow, x = A.X(V) + Fr.fs * 1.4;
      K.arrowV(A, x, A.Y(1), A.Y(Fmin), {alpha: a, glow: k === 2 ? 10 : 0, color: k === 2 || ex ? K.COL.accent : K.COL.muted});
      if (k === 2 || ex) K.text(Fr, "amount", x + Fr.fs * 0.5, (A.Y(1) + A.Y(Fmin)) / 2, {size: 0.8, color: K.COL.accent, alpha: a, halo: true});
      if (Fr.physics) K.text(Fr, `log N = ${K.fmt(logN, 2)}   τ₀ = ${K.fmt(tau[Math.round(V - GRID[0])], 2)}   ${Math.round(100 * Fmin)} % at centre`,
        Fr.box.x + Fr.box.w, Fr.box.y - Fr.fs * 0.4, {align: "right", size: 0.74, mono: true, color: K.COL.muted, alpha: a});
    }
    // width: horizontal span of +-b at the depth where the Doppler core is e^-1 of its centre
    if (span > 0 || ex) {
      const a = ex ? 1 : span, fy = 1 - (1 - Fmin) * 0.5;
      K.spanH(A, A.X(V - b), A.X(V + b), A.Y(fy), {alpha: a, glow: k === 3 ? 10 : 0});
      K.text(Fr, Fr.physics ? `b = ${K.fmt(b, 1)} km/s` : "width", A.X(V - b) - Fr.fs * 0.5, A.Y(fy) + Fr.fs * 0.3, {align: "right", size: 0.8, color: K.COL.accent, alpha: a, halo: true});
    }
  }
  if (ex) K.text(Fr, el ? K.ionName(K.SAT_ION) : cell.I.name, Fr.box.x + 6, Fr.box.y - Fr.fs * 0.5, {size: 0.8, color: el ? el.color : col});
}

/* Explore (Try it): drag position, amount and width, each with a slider twin; element toggle O / H */
const controls = {
  V: {label: "position", unit: "km/s", min: -250, max: 250, step: 1, text: v => `${Math.round(v)} kilometres per second`},
  logN: {label: "amount", unit: "log N", min: 12, max: 15.5, step: 0.01, text: v => `${v.toFixed(2)}, log of atoms per square centimetre`},
  b: {label: "width", unit: "km/s", min: 3, max: 80, step: 0.5, text: v => `${v.toFixed(1)} kilometres per second`},
  el: {label: "element", options: ["O", "H"]},
};
/* the Explore starting values for this data (the featured cell); kept equal-area while b changes (DOM explains) */
function exploreStart(data) { const c = cellOf(data); return {V: Math.round(c.V), logN: +c.logN.toFixed(2), b: +c.b.toFixed(1), el: "O"}; }
/* readout announced after a drag (depth and width, PLAN_final §7) */
function announce(data, ex) {
  const at = ex.el === "H" ? K.ion(data, K.SAT_ION).atom : K.ion(data, K.LEAD).atom, t = K.dipTau(at, ex.V, ex.logN, ex.b, [ex.V])[0];
  return `Dip at ${Math.round(ex.V)} km/s, ${Math.round(100 * Math.exp(-t))} percent of the light left at its centre, width ${ex.b.toFixed(0)} km/s`;
}
function ready(data) { K.prep(data); K.picks(data); }

/* ---- v2 dock mode "cell" (DESIGN_final §5.4; B7b stops): "one cell makes one dip" on the live panel ------------------
   At a stop the cell under the probe gets its own full dip (dashed, e^−τ_i), the amount glyph (vertical arrow from the
   continuum to its floor) and the width glyph (±b at half depth): the v1 S5 glyphs, now on the cell the camera sits in.
   pe = {data, fs, ion, T}. Glyphs only; the dock's registered readouts carry the words. Pure. */
export function dockCell(A, pe) {
  const fs = pe.fs, S = pe.T && pe.T[pe.ion]; if (!fs || !fs.cell || !S) return;
  const C = pe.data.ions[pe.ion].cells, i = fs.cell.idx, V = +C.V[i], b = +C.b[i];
  if (!Number.isFinite(V) || !(b > 0) || V < A.v0 || V > A.v1) return;
  const t = S.cellTau(i), v = Float64Array.from({length: S.N}, (_, j) => S.grid0 + j), F = j => Math.exp(-t[j]);
  K.curve(A, v, F, {color: K.ionColor(pe.ion), width: 1.6, dash: [5, 4], alpha: 0.85});
  const j0 = Math.round(V - S.grid0), Fmin = Math.exp(-t[Math.max(0, Math.min(S.N - 1, j0))]);
  const x = A.X(V) + Math.max(10, A.fs * 0.9);
  if (A.Y(Fmin) - A.Y(1) > 10) K.arrowV(A, x, A.Y(1), A.Y(Fmin), {color: K.COL.accent});
  const fy = 1 - (1 - Fmin) * 0.5;
  if (A.X(V + b) - A.X(V - b) > 6) K.spanH(A, A.X(V - b), A.X(V + b), A.Y(fy), {color: K.COL.accent});
}

const scene = {id: "dip", chapter: "dip", steps: STEPS, defaults: {}, controls, exploreStart, announce, ready, render,
  handoff: {ions: ["OVI"], layout: "1", R: [30000, 30000], sn: [10, 10], intr: true}};
export default scene;
export {render, ready};
