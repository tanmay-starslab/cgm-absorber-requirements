// S11 "Reading it back" (chapter fit; PLAN_final §3 S11): precomputed fits only (seek() never fits; eng P1-8). Step 1
// cycles the explorer's noise draws 0, 1, 2 at R 30 000, S/N 10 ("this noise draw"); step 2 compares the fitted total
// log10 sum N with the truth from all cells; step 3 brings the beam back: a fitted cloud collects cells tens of kpc
// apart, a low-S/N fit gives one very broad cloud, and noise can invent a cloud too narrow to be O VI. Fits come from
// the data (page_fits, made with fit.js fitPanel at capMs = budgetMs = 1e9); the clouds are redrawn with tauVoigt +
// degradeV on the data pixels. Explore: the driver posts fitRequest() to fitworker.js and passes the result in.
import * as K from "../plot.js";
import {noiseBin, binned, drawNoisy} from "./noise.js";

const STEPS = ["fit-1", "fit-2", "fit-3"];
const VW = 300, FLAG_HOLLOW = 2 | 32 | 128;   // BOUND, NOERR, BUDGET: drawn as hollow ticks, as in the explorer

function drawFit(A, Fr, data, fit, o = {}) {
  const I = K.ion(data, K.LEAD), obs = K.observed(data, K.LEAD, fit.R, fit.snr, fit.noiseSeed), a = o.alpha ?? 1;
  if (o.panel) drawData(A, obs, o.panel, I.color, a); else K.stairs(A, obs.v, obs.flux, {color: rgbaIon(I), width: 1.2, alpha: a * 0.9});
  const comps = fit.comps || [];
  if (!comps.length) return obs;
  comps.forEach((c, i) => { const m = K.cloudModel(data, K.LEAD, comps, fit.R, VW, i);
    K.curve(A, m.v, m.model, {color: i === o.hi ? K.COL.accent : I.color, width: i === o.hi ? 2 : 1.2, dash: [4, 4], alpha: a * (o.hi == null || i === o.hi ? 0.8 : 0.35)}); });
  const m = K.cloudModel(data, K.LEAD, comps, fit.R, VW);
  K.curve(A, m.v, m.model, {color: K.COL.ink, width: 2.2, alpha: a});
  const len = Fr.fs * 0.9;
  comps.forEach((c, i) => K.tick(A, c.v, {alpha: a, color: i === o.hi ? K.COL.accent : K.COL.ink, hollow: !!((+c.flag || 0) & FLAG_HOLLOW), y: tickY(A, len), len}));
  return obs;
}
/* review2 ux H3: component ticks hang inside the panel (top 2 px below its top edge), never up into the dock's readout row */
const tickY = (A, len) => Math.max(A.Y(1.2), A.box.y + 2 + len);
/* review2 beauty M5: the same display treatment as B14 (dockExplore): pixels narrower than 2 CSS px are averaged (display
   binning only), drawn as a thin step at ~60 % alpha, and values above the continuum are soft-clipped below the panel top
   (tanh knee) so a low-S/N spectrum reads as noise around the model rather than a barcode pinned to the ceiling */
function drawData(A, obs, panel, color, a) {
  const nb = noiseBin(panel, obs), d = binned(obs.v, obs.flux, nb.f);
  drawNoisy(A, d.v, d.y, {color, alpha: a * 0.5});   // beauty H2 (fix3): points, soft-clipped at both edges
}
const rgbaIon = I => K.rgba(I.color, 0.85);

function render(ctx, state, t, data) {
  const p = K.params(scene, state), k = K.stepIndex(state, STEPS), q = p.p;
  const Fr = K.frame(ctx, state), I = K.ion(data, K.LEAD), c = I.cells, pk = K.picks(data);
  const ex = state.mode === "explore" && state.explore ? state.explore : null;
  const split = ex ? 0 : k === 2 ? K.seg(q, 0, 0.15) : 0;
  const A = K.axesMap(K.sub(Fr, 0, K.lerp(0, Fr.port ? 0.34 : 0.36, split), 1, 1), -VW, VW, -0.1, 1.28);
  K.axes(A, {yTicks: [0, 0.5, 1]});
  const seeds = pk.seeds;
  if (ex) {
    // live fit result from fitworker (the driver's onFit), passed in as override "fit" or state.fitResult
    const R = Number.isFinite(+ex.R) ? +ex.R : +p.R || 30000, sn = Number.isFinite(+ex.sn) ? +ex.sn : +p.sn || 10, res = ex.fit || p.fitResult || null;
    const fit = {R, snr: sn, noiseSeed: K.caseSeed(Number.isInteger(p.seed) ? p.seed : 0, K.LEAD, 0), comps: res && Array.isArray(res.comps) ? res.comps : []};
    drawFit(A, Fr, data, fit);
    K.text(Fr, `R ${K.fmtInt(fit.R)}   S/N ${Math.round(fit.snr)}`, Fr.box.x + Fr.box.w, Fr.box.y - Fr.fs * 0.5, {align: "right", size: 0.84, mono: true, color: K.COL.muted});
    if (!res) K.text(Fr, "fitting", Fr.box.x + 6, Fr.box.y - Fr.fs * 0.5, {size: 0.8, color: K.COL.muted});
    return;
  }
  if (!seeds.length) { K.text(Fr, "no stored fits for this beam", Fr.box.x + Fr.box.w / 2, Fr.box.y + Fr.box.h / 2, {align: "center", color: K.COL.muted}); return; }
  if (k === 0) {
    // three noise draws, each held then crossfaded (the fits differ; the total barely does)
    const n = seeds.length, u = K.clamp(q) * n, i = Math.min(n - 1, Math.floor(u)), f = i < n - 1 ? K.seg(u - i, 0.8, 1) : 0;
    drawFit(A, Fr, data, seeds[i], {alpha: 1 - f});
    if (f > 0) drawFit(A, Fr, data, seeds[i + 1], {alpha: f});
    const cur = f > 0.5 ? i + 1 : i;
    K.text(Fr, `noisy try ${cur + 1} of ${n}   ${seeds[cur].comps.length} components`, Fr.box.x + Fr.box.w, Fr.box.y - Fr.fs * 0.5, {align: "right", size: 0.84, mono: true, color: K.COL.muted});
    K.text(Fr, Fr.physics ? "R 30 000   S/N 10   Voigt fit" : "data, and the fit", Fr.box.x + 6, Fr.box.y - Fr.fs * 0.5, {size: 0.8, color: K.COL.muted});
    return;
  }
  if (k === 1) {
    drawFit(A, Fr, data, seeds[0], {alpha: 1 - 0.45 * K.seg(q, 0.1, 0.4)});
    // two bars: fitted total vs the truth from every cell (log10 of the summed column)
    const a = K.seg(q, 0.15, 0.6), fitN = K.totalLogN(seeds[0].comps), truN = I.totals.logN, lo = Math.floor(Math.min(fitN, truN) - 1), hi = Math.ceil(Math.max(fitN, truN) + 0.3);
    const bx = Fr.box.x + Fr.box.w * (Fr.port ? 0.08 : 0.56), bw = Fr.box.w * (Fr.port ? 0.84 : 0.40), by = Fr.box.y + Fr.box.h * 0.06, gap = Fr.fs * 3;
    K.glass(Fr, bx - Fr.fs, by - Fr.fs * 1.6, bw + 2 * Fr.fs, gap * 2 + Fr.fs * 1.4, {alpha: a});
    K.meter(Fr, bx, by + Fr.fs * 0.6, bw, Fr.physics ? "fit: log₁₀ Σ N" : "total O VI, from the fit", (fitN - lo) / (hi - lo), K.fmt(fitN, 2), {alpha: a, color: K.COL.ink});
    K.meter(Fr, bx, by + Fr.fs * 0.6 + gap, bw, Fr.physics ? `truth: log₁₀ Σ N over ${c.n} cells` : `total O VI, all ${c.n} cells`, (truN - lo) / (hi - lo), K.fmt(truN, 2), {alpha: a, color: I.color});
    return;
  }
  // k === 2: clouds are not cells
  const top = K.sub(Fr, 0, 0, 1, Fr.port ? 0.2 : 0.22), S = K.rayStrip(top, data, K.LEAD, {alpha: split, labels: split});
  const caseA = seeds[0], caseB = pk.broad ? pk.broad.fit : null, caseC = pk.invented ? pk.invented.fit : null;
  const wB = caseB ? K.seg(q, 0.42, 0.5) : 0, wC = caseC ? K.seg(q, 0.72, 0.8) : 0;
  const cases = [[caseA, (1 - wB) * (1 - wC)], [caseB, wB * (1 - wC)], [caseC, wC]];
  for (const [f, a] of cases) {
    if (!f || a <= 0.001) continue;
    const hi = f === caseB ? f.comps.indexOf(pk.broad.comp) : f === caseC ? f.comps.indexOf(pk.invented.comp) : null;
    drawFit(A, Fr, data, f, {alpha: a, hi: hi >= 0 ? hi : null});
    // threads: each visible cell joins the fitted cloud nearest in speed (within 2 b of its centre)
    const th = K.seg(q, 0.12, 0.35) * a;
    for (let j = 0; j < c.n; j++) {
      if (c.tau0[j] <= 0.1 || Math.abs(c.V[j]) > VW) continue;
      let best = -1, bd = Infinity; f.comps.forEach((cc, i) => { const d = Math.abs(c.V[j] - cc.v) / cc.b; if (d < bd) { bd = d; best = i; } });
      if (best < 0 || bd > 2) continue;
      if (f === caseC && best === hi) continue;   // the invented cloud gets no thread: the cells claim only a small share of it (CREST β < 0.25)
      const on = hi != null ? best === hi : best === 0;
      K.bead(top, S.X(c.l[j]), S.y, 3, K.heatColor(c.T[j]), th);
      K.thread(Fr, S.X(c.l[j]), S.y + 4, A.X(f.comps[best].v), A.Y(1.2) - Fr.fs, {alpha: th * (on ? 0.9 : 0.22), color: on ? K.COL.accent : K.COL.faint, width: on ? 1.6 : 1});
    }
    const label = f === caseB ? (Fr.physics ? `b = ${K.fmt(pk.broad.comp.b, 0)} km/s` : `width ${K.fmt(pk.broad.comp.b, 0)} km/s`)
      : f === caseC ? (Fr.physics ? `b = ${K.fmt(pk.invented.comp.b, 1)} km/s, narrower than the blur; cells explain little` : `width ${K.fmt(pk.invented.comp.b, 1)} km/s, narrower than the blur`) : null;
    if (label && hi != null && hi >= 0) K.text(Fr, label, A.X(f.comps[hi].v), A.Y(-0.06), {align: "center", size: 0.84, color: K.COL.accent, alpha: a, halo: true});
    K.text(Fr, `R ${K.fmtInt(f.R)}   S/N ${f.snr}`, Fr.box.x + Fr.box.w, A.box.y - Fr.fs * 0.5, {align: "right", size: 0.84, mono: true, color: K.COL.muted, alpha: a});
  }
}
const controls = {R: {label: "sharpness R", min: 5000, max: 150000, scale: "log", text: v => `resolving power ${K.fmtInt(v)}`},
  sn: {label: "S/N", min: 2, max: 100, scale: "log", text: v => `signal to noise ${Math.round(v)}`}};
function exploreStart() { return {R: 30000, sn: 10, seed: 0, fit: null}; }
function announce(data, ex) { return ex.fit ? `${(ex.fit.comps || []).length} clouds, total ${K.fmt(K.totalLogN(ex.fit.comps), 2)}` : "fitting"; }
function ready(data) { K.picks(data); }

/* ---- v2 dock mode "fit" (DESIGN_final §3.5 B13): "We fit a few components" -----------------------------------------
   Phases of B13 by its local u (aligned with the beat's copy windows): draws (three stored noise draws, crossfaded),
   totals (the fitted total against all cells; the numbers are the dock's readouts), landing (the noiseless CREST
   components, where the cloud tethers land by M[s, c]), cases (a very broad component at low S/N, then a component
   too narrow to be O VI that no gas cell made). Stored fits only: seek never fits. Pure. */
export const FIT_PHASES = Object.freeze({draws: 0, totals: 0.42, landing: 0.62, cases: 0.84});
export function fitPhase(u) { return u >= FIT_PHASES.cases ? "cases" : u >= FIT_PHASES.landing ? "landing" : u >= FIT_PHASES.totals ? "totals" : "draws"; }
/* CREST components of an ion (clouds.json when loaded as data.clouds_full, else the library fit) */
export function crestComps(data, k) {
  const full = data.clouds_full && data.clouds_full.ions && data.clouds_full.ions[k];
  if (full && Array.isArray(full.comps)) return full.comps.map(c => ({v: c.v, logN: c.logN, b: c.b}));
  return K.ion(data, k).lib || [];
}
export function dockFit(A, pe) {
  const data = pe.data, u = pe.u || 0, ph = fitPhase(u), pk = K.picks(data), seeds = pk.seeds || [];
  if (pe.role !== "lead") {   // the other ion: its data at the same R, S/N and draw as the lead's current fit, unfitted
    // review2 science M4: in the "cases" phase the header reads the case's R and S/N, so this panel is drawn at those too
    let s0 = seeds[0];
    if (ph === "cases") { const cB = pk.broad ? pk.broad.fit : null, cC = pk.invented ? pk.invented.fit : null;
      const inv = cC && u >= FIT_PHASES.cases + 0.5 * (1 - FIT_PHASES.cases);   // the same switch as the header (dock.js frameModel)
      s0 = (inv ? cC : cB) || cB || cC || s0; }
    const o = K.observed(data, pe.ion, s0 ? s0.R : 30000, s0 ? s0.snr : 10, K.caseSeed(s0 ? s0.seedParam : 0, pe.ion, 0));
    if (o) drawData(A, o, pe.panel, K.ionColor(pe.ion), 1);
    // fix1 r4 (review1 beauty M3): this panel is not fitted, so draw its noiseless model on top, as every other noisy
    // panel does (B12b dockNoise), instead of leaving scatter alone
    if (o && o.model) { K.curve(A, o.v, o.model, {color: K.COL.bg, width: 4.5, alpha: 0.6});
      K.curve(A, o.v, o.model, {color: K.COL.beam, width: 1.8, alpha: 0.9}); }
    return;
  }
  if (!seeds.length) return;
  if (ph === "draws") {
    const n = seeds.length, x = K.clamp(u / FIT_PHASES.totals) * n, i = Math.min(n - 1, Math.floor(x)), f = i < n - 1 ? K.seg(x - i, 0.8, 1) : 0;
    drawFit(A, A, data, seeds[i], {alpha: 1 - f, panel: pe.panel});
    if (f > 0) drawFit(A, A, data, seeds[i + 1], {alpha: f, panel: pe.panel});
  } else if (ph === "totals") {
    drawFit(A, A, data, seeds[0], {panel: pe.panel});
  } else if (ph === "landing") {
    drawFit(A, A, data, seeds[0], {alpha: 0.45, panel: pe.panel});
    const comps = crestComps(data, pe.ion);
    comps.forEach(c => { if (c.v > A.v0 && c.v < A.v1) { const L = Math.max(8, A.box.h * 0.12); K.tick(A, c.v, {color: K.COL.beam, y: tickY(A, L), len: L, width: 2.2}); }; });
  } else {
    const caseB = pk.broad ? pk.broad.fit : null, caseC = pk.invented ? pk.invented.fit : null;
    const w = caseC ? K.seg((u - FIT_PHASES.cases) / (1 - FIT_PHASES.cases), 0.45, 0.6) : 0;
    if (caseB && w < 1) drawFit(A, A, data, caseB, {alpha: 1 - w, hi: caseB.comps.indexOf(pk.broad.comp), panel: pe.panel});
    if (caseC && w > 0) drawFit(A, A, data, caseC, {alpha: w, hi: caseC.comps.indexOf(pk.invented.comp), panel: pe.panel});
    if (!caseB && !caseC) drawFit(A, A, data, seeds[0], {panel: pe.panel});
  }
}
const scene = {id: "fit", chapter: "fit", steps: STEPS, defaults: {}, controls, exploreStart, announce, ready, render, fitRequest: K.fitRequest,
  handoff: {ions: ["OVI"], layout: "1", R: [30000, 30000], sn: [10, 10], fit: true}};
export default scene;
export {render, ready};
