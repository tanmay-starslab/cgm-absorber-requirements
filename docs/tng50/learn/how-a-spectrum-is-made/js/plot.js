// Shared plotting and data layer of the spectrum scenes S5 to S12 ("How a spectrum is made", PLAN_final §3, §6).
// Pure ES module: no DOM access beyond the canvas context it is handed, no clock, no random numbers, no timers. Every
// function of time is a function of its arguments; the memo tables below are keyed on the data object and on
// parameters, never on the previous frame (purity rule (c)), so seek(a), seek(b), seek(a) draws the same picture.
//
// Galaxy-agnostic: nothing here names a galaxy, a sightline or a cell. The featured cells, pairs and fits of each
// scene are picked from the data by fixed rules (picks()), and every number a scene prints comes from facts(), so
// the same scenes play for any of the TNG50 MW/M31 galaxies whose story data exist.
//
// Physics is not copied: optical depths come from fit.js tauVoigt, instrument blur, pixels and noise from fit.js
// degradeV, noise seeds from fit.js seedFor (the explorer's own functions, so S9 to S11 match the explorer).
import {tauVoigt, degradeV, seedFor, PIX_PER_RESEL} from "../../../js/fit.js";
import {ION_FALLBACK} from "../../../js/vizdata.js";
import {lut} from "../../../js/colormaps.js";
import {formatHash} from "../../../js/state.js";

export const C_KMS = 299792.458;
export const DEFAULT_GALAXY = 488530;
export const LEAD = "OVI", SAT_ION = "HI";
const K_B = 1.380649e-16, AMU = 1.66053907e-24;

// ---- colours (stage is always dark, PLAN_final §2.3) ----------------------------------------------------------------
export const COL = {
  bg: "#05070d", ink: "rgba(236,240,255,0.94)", muted: "rgba(236,240,255,0.58)", faint: "rgba(236,240,255,0.30)",
  grid: "rgba(236,240,255,0.10)", beam: "#fff3dc", accent: "#8fa8ff", accentSoft: "rgba(143,168,255,0.22)",
  blur: "rgba(205,210,222,0.85)", truth: "rgba(255,243,220,0.55)", data: "rgba(226,231,245,0.88)",
};
const ION_COL = Object.fromEntries(ION_FALLBACK.map(i => [i.key, i.color_dark]));
const ION_LABEL = Object.fromEntries(ION_FALLBACK.map(i => [i.key, i.ion]));
export const ionColor = k => ION_COL[k] || COL.beam;
export const ionName = k => ION_LABEL[k] || k;
export function rgba(hex, a) {
  const h = hex.replace("#", ""), n = parseInt(h.length === 3 ? h.replace(/(.)/g, "$1$1") : h, 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
}
let MAGMA = null;
/* perceptual colour for gas heat: magma on log T from 10^4 to 10^6.5 K (never a rainbow) */
export function heatColor(T, a = 1) {
  if (!MAGMA) MAGMA = lut("magma");
  const x = Math.max(0, Math.min(1, (Math.log10(Math.max(T, 1)) - 4) / 2.5)), k = 4 * Math.round(40 + x * 215);
  return `rgba(${MAGMA[k]},${MAGMA[k + 1]},${MAGMA[k + 2]},${a})`;
}

// ---- small maths ------------------------------------------------------------------------------------------------------
export const clamp = (x, a = 0, b = 1) => Math.min(b, Math.max(a, x));
export const lerp = (a, b, t) => a + (b - a) * t;
export const smooth = t => { t = clamp(t); return t * t * (3 - 2 * t); };
/* local progress of p inside [a, b], eased */
export const seg = (p, a, b) => smooth((p - a) / (b - a));
export const logLerp = (a, b, t) => Math.pow(10, lerp(Math.log10(a), Math.log10(b), t));
export const fmt = (x, d = 0) => !Number.isFinite(x) ? "–" : (x < 0 ? "−" : "") + Math.abs(x).toFixed(d);
export const fmtInt = x => !Number.isFinite(x) ? "–" : (x < 0 ? "−" : "") + String(Math.round(Math.abs(x))).replace(/\B(?=(\d{3})+(?!\d))/g, " ");
/* thermal Doppler parameter, b = sqrt(2kT/m) in km/s */
export const bThermal = (T, amu) => Math.sqrt(2 * K_B * T / (amu * AMU)) / 1e5;
export const tFromB = (b, amu) => (b * 1e5) ** 2 * amu * AMU / (2 * K_B);
export function vgrid(v0, dv, n) { const v = new Float64Array(n); for (let i = 0; i < n; i++) v[i] = v0 + i * dv; return v; }

// ---- data adapter ----------------------------------------------------------------------------------------------------
// Reads U0's story-data/1 file (scripts/export_story_data.py): shared cell columns in data.cells {l_kpc, dl_kpc, nH, T,
// Z, V}, per-ion columns in data.ions.<k> {f_ion | xHI, logN, b, tau0, a}, ions.<k>.{atom, totals, F_intrinsic (on
// meta.grid), library_fit {keys, components}, aod {logN, regions}}, data.select (feature picks by rule) and, attached by
// the engine, data.page_fits (story-fits/1) and data.lines = {vSys, <k>: {n, u0, du, rest, flux}} (the decoded explorer
// TNGS bin: S9 to S11 degrade and fit the explorer's own file, not the cell sum). Also reads row lists ([{l_kpc, V_kms,
// b_kms, ...}]) and the flat dev shape (ions.<k>.cells), so older exports still draw.
const PREP = new WeakMap();
const pickCol = (o, names) => { for (const n of names) if (o && o[n] != null) return o[n]; return null; };
const NAMES = {i: ["i", "idx", "cell"], l: ["l_kpc", "l"], dl: ["dl_kpc", "dl"], nH: ["nH", "nH_cm3", "n_H"], T: ["T", "T_K"],
  Z: ["Z", "Z_Zsun"], fion: ["f_ion", "xHI", "x_HI", "fion"], logN: ["logN"], V: ["V", "V_kms", "v"], b: ["b", "b_kms"], tau0: ["tau0"]};
function columns(cells) {
  const rows = Array.isArray(cells), n = rows ? cells.length : (pickCol(cells, NAMES.l) || pickCol(cells, NAMES.logN) || []).length, out = {n};
  for (const [k, names] of Object.entries(NAMES)) {
    const a = new Float64Array(n);
    if (rows) for (let j = 0; j < n; j++) { const v = pickCol(cells[j], names); a[j] = v == null ? NaN : +v; }
    else { const c = pickCol(cells, names); for (let j = 0; j < n; j++) a[j] = c ? +c[j] : NaN; }
    out[k] = a;
  }
  // the cell id is the row index of the export (data.select refers to it) unless the data carry their own
  if (out.i.every(x => Number.isNaN(x))) for (let j = 0; j < n; j++) out.i[j] = j;
  // path order (S7 adds cells along the beam); pos maps a cell id to its place in path order
  const ord = Array.from({length: n}, (_, j) => j).sort((a, b) => out.l[a] - out.l[b]);
  if (ord.some((v, j) => v !== j)) for (const k of Object.keys(NAMES)) out[k] = Float64Array.from(ord, j => out[k][j]);
  out.pos = new Map(); for (let j = 0; j < n; j++) out.pos.set(out.i[j], j);
  return out;
}
function fluxArr(f) {
  if (!f) return null;
  let big = false; for (let i = 0; i < f.length; i++) if (f[i] > 1.5) { big = true; break; }
  return Float64Array.from(f, x => big ? x / 65535 : +x);
}
const rowsTo = (rows, keys) => (rows || []).map(r => Array.isArray(r) && keys ? Object.fromEntries(keys.map((kk, j) => [kk, r[j]])) : r);
/* page fits of ion k: story-fits/1 ({fits: [{ion, R, snr, seed, ci, noise_seed, keys, comps}], select}), or the
   dev shape ({keys, cases: {k: [...]}}). Each fit gets idx (its place in the file), seedParam (the page seed S), ci and
   noiseSeed = seedFor(S, ion, ci): the exact noise draw of the explorer panel the fit was made on. */
function normFits(F, k) {
  if (!F) return [];
  const list = Array.isArray(F.fits) ? F.fits.map((f, idx) => ({...f, idx}))
    : F.cases ? (Array.isArray(F.cases) ? F.cases : F.cases[k] || []).map((f, idx) => ({...f, idx})) : [];
  return list.filter(f => (f.ion || k) === k).map(f => {
    const sp = Number.isInteger(f.seedParam) ? f.seedParam : Number.isInteger(f.seed) && f.noise_seed != null ? f.seed : 0, ci = Number.isInteger(f.ci) ? f.ci : 0;
    const ns = Number.isInteger(f.noise_seed) ? f.noise_seed : Number.isInteger(f.seed) && f.seed > 99999 ? f.seed : seedFor(sp, k, ci);
    return {...f, ion: k, seedParam: sp, ci, noiseSeed: ns, comps: rowsTo(f.comps || f.components, f.keys || F.keys)};
  });
}
export function prep(data) {
  if (!data) throw new Error("story scenes: no data");
  let P = PREP.get(data); if (P) return P;
  const m = data.meta || {}, lines = data.lines || {}, grid = m.grid || {};
  const vSys = Number.isFinite(+lines.vSys) ? +lines.vSys : +(m.v_sys_kms ?? m.v_sys ?? m.vSys ?? 0);
  const g = String(m.galaxy ?? m.subhalo ?? m.g ?? DEFAULT_GALAXY).replace(/^tng50-1-99-/i, "");
  P = {data, meta: {galaxy: +g || g, ray: m.ray || m.id || "", vSys, impact: +(m.b_kpc ?? m.impact_kpc ?? NaN),
    half: +(m.half_kpc ?? (m.length_kpc ? m.length_kpc / 2 : m.R200c_kpc)), length: +(m.length_kpc ?? NaN), R200c: +(m.R200c_kpc ?? NaN)},
    ions: {}, memo: new Map(), select: data.select || {}, fitSelect: (data.page_fits && data.page_fits.select) || {}};
  for (const [k, I] of Object.entries(data.ions || {})) {
    const atom = {...(I.atom || I.atomic || {})};
    atom.mass_amu = atom.mass_amu ?? atom.mass_amu_registry ?? (k === "HI" ? 1.00794 : 15.9994);
    const reg = REG_FIT[k] || {}; atom.b_min = atom.b_min ?? reg.b_min; atom.logN_max = atom.logN_max ?? reg.logN_max; atom.damped = atom.damped ?? reg.damped;
    // cell columns: the ion's own (dev shape) or the shared columns plus the ion's arrays
    let src = I.cells;
    if (!src && data.cells) { src = {...data.cells}; for (const key of ["f_ion", "xHI", "logN", "b", "tau0", "a", "V"]) if (Array.isArray(I[key])) src[key] = I[key]; }
    const Fi = I.F_intrinsic, isArr = Array.isArray(Fi) || ArrayBuffer.isView(Fi);
    const v0 = isArr ? +(grid.V0 ?? -400) : +(Fi?.v0 ?? -400), dv = isArr ? +(grid.dV ?? 1) : +(Fi?.dv ?? 1);
    const fl = fluxArr(isArr ? Fi : Fi?.flux), L = lines[k] ? {...lines[k], flux: fluxArr(lines[k].flux)} : null;
    const lib = I.library_fit || I.library || {}, libKeys = lib.keys || data.fits?.keys || COMP_KEYS;
    const A0 = I.aod || lib.aod || null, aod = A0 ? (Array.isArray(A0) ? A0 : [A0.logN, A0.regions || []]) : null;   // explorer form [total, regions]
    const tot = I.totals || {};
    P.ions[k] = {key: k, atom, color: ionColor(k), name: ionName(k), cells: columns(src || []),
      F: fl ? {v0, dv, n: fl.length, flux: fl, v: vgrid(v0, dv, fl.length)} : null, line: L,
      lib: rowsTo(lib.components || lib.comps || I.fit_library_noiseless?.components, libKeys), aod,
      totals: {logN: +(tot.logN ?? I.logN_total), ew: +(tot.EW_mA ?? tot.ew_mA ?? I.EW_mA_stored), peakTau: +(tot.peak_tau ?? I.max_tau_stored),
        nVis: +(tot.n_visible ?? tot.n_vis ?? I["n_cells_tau0_gt_0.01"]), nHalf: +(tot.n_half ?? I.n_cells_for_N_fraction?.["50pct"])},
      fits: normFits(data.page_fits || data.fits, k)};
  }
  PREP.set(data, P);
  return P;
}
export const COMP_KEYS = ["v", "dv", "logN", "dlogN", "b", "db", "region", "flag", "EW"];
/* fitter bounds of the registry (tngsight/ions.json "fit"), used only when the data's atom lacks them */
const REG_FIT = {HI: {b_min: 8, logN_max: 22.5, damped: true}, OVI: {b_min: 2.5, logN_max: 19, damped: false}};
export const ion = (data, k) => prep(data).ions[k] || null;
function memo(P, key, fn) { if (!P.memo.has(key)) { if (P.memo.size > 160) P.memo.delete(P.memo.keys().next().value); P.memo.set(key, fn()); } return P.memo.get(key); }
/* step index inside the scene from the step id ("saturation-2" -> 1) */
export function stepIndex(state, steps) {
  const id = String(state && state.step || ""), m = /-(\d+)$/.exec(id);
  if (m) return Math.max(0, +m[1] - 1);
  const i = steps ? steps.indexOf(id) : -1; return Math.max(0, i);
}

// ---- per-cell optical depth, cached once per ion (CSR over each cell's support; PLAN_final §6) ----------------------
// Support of cell j: |V - V_j| <= b_j * max(8, x_w), x_w where the Lorentz wing falls below 1e-6 in tau. Grid: the
// F_intrinsic grid (1 km/s, -400..400). sumTau adds cells [0, kf) in path order, the last one weighted by frac(kf).
export function tauCache(data, k) {
  const P = prep(data), I = P.ions[k];
  return memo(P, `tau|${k}`, () => {
    const c = I.cells, v = I.F ? I.F.v : vgrid(-400, 1, 801), n = v.length, v0 = v[0], dv = v[1] - v[0];
    const a0 = (I.atom.gamma_s || 0) * I.atom.lam0_A * 1e-8 / (4 * Math.PI * 1e5);
    const start = new Int32Array(c.n), len = new Int32Array(c.n), parts = [];
    let off = 0;
    for (let j = 0; j < c.n; j++) {
      const b = c.b[j], t0 = c.tau0[j], a = a0 / b;
      if (!(b > 0) || !Number.isFinite(c.logN[j])) { start[j] = 0; len[j] = 0; parts.push(new Float32Array(0)); continue; }
      const xw = Math.sqrt(Math.max(0, (Number.isFinite(t0) ? t0 : 1) * a / (Math.sqrt(Math.PI) * 1e-6)));
      const hw = b * Math.max(8, xw), i0 = Math.max(0, Math.floor((c.V[j] - hw - v0) / dv)), i1 = Math.min(n - 1, Math.ceil((c.V[j] + hw - v0) / dv));
      if (i1 < i0) { len[j] = 0; parts.push(new Float32Array(0)); continue; }
      const t = tauVoigt(I.atom, [[c.V[j], c.logN[j], b]], v.subarray(i0, i1 + 1));
      start[j] = i0; len[j] = t.length; parts.push(Float32Array.from(t)); off += t.length;
    }
    const vals = new Float32Array(off), ptr = new Int32Array(c.n + 1);
    for (let j = 0, o = 0; j < c.n; j++) { vals.set(parts[j], o); ptr[j] = o; o += parts[j].length; ptr[j + 1] = o; }
    return {v, n, start, len, ptr, vals};
  });
}
export function sumTau(cache, kf, out, pick = null) {
  const tau = out ? (out.fill(0), out) : new Float64Array(cache.n), K = Math.min(cache.start.length, Math.max(0, kf));
  const whole = Math.floor(K), frac = K - whole;
  const add = (j, w) => { const s = cache.start[j], o = cache.ptr[j], L = cache.len[j]; for (let i = 0; i < L; i++) tau[s + i] += w * cache.vals[o + i]; };
  for (let j = 0; j < whole; j++) if (!pick || pick(j)) add(j, 1);
  if (frac > 0 && whole < cache.start.length && (!pick || pick(whole))) add(whole, frac);
  return tau;
}
export function cellTau(cache, j) {
  const out = new Float64Array(cache.n), s = cache.start[j], o = cache.ptr[j];
  for (let i = 0; i < cache.len[j]; i++) out[s + i] = cache.vals[o + i];
  return out;
}
/* single Voigt dip on a grid (S5, S8: the only optical depth recomputed per frame) */
export function dipTau(atom, V, logN, b, v) { return tauVoigt(atom, [[V, logN, b]], v); }
export const expNeg = (tau, scale = 1) => Float64Array.from(tau, t => Math.exp(-scale * t));
/* rest-frame equivalent width in km/s of a flux array on a uniform grid */
export function eqWidthKms(F, dv) { let s = 0; for (let i = 0; i < F.length; i++) s += 1 - F[i]; return s * dv; }

// ---- instrument (S9 to S12): the explorer's degradeV on the stored library line -------------------------------------
/* the explorer's noise seed of one panel: seedFor(page seed, ion, case index) (state.js casesFor order) */
export const caseSeed = (seedParam, k, ci = 0) => seedFor(seedParam, k, ci);
/* noiseless (snr 0) or noisy spectrum of ion k at resolving power R with the given panel noise seed (the explorer's
   own operator and seed, so the story's pixels equal the explorer's panel at the same R, S/N and seed) */
export function observed(data, k, R, snr, noiseSeed = null) {
  const P = prep(data), I = P.ions[k];
  if (!I || !I.line) return null;
  const Rk = Math.round(R), sk = snr > 0 ? +(+snr).toFixed(4) : 0, ns = noiseSeed == null ? caseSeed(0, k, 0) : noiseSeed >>> 0;
  // full stored window, no vwin: the pixel grid, and so the noise sequence, is the explorer's (app.js degradeV call)
  return memo(P, `obs|${k}|${Rk}|${sk}|${ns}`, () => degradeV(I.line, Rk, sk, P.meta.vSys, {seed: ns}));
}
/* LSF-convolved model of fitted clouds, sampled on the data pixels of observed() (same operator fitPanel uses) */
export function cloudModel(data, k, comps, R, vwin = 400, only = null) {
  const P = prep(data), I = P.ions[k], L = I.line;
  const sel = only == null ? comps : [comps[only]];
  const key = `mod|${k}|${Math.round(R)}|${vwin}|${sel.map(c => `${c.v},${c.logN},${c.b}`).join(";")}`;
  return memo(P, key, () => {
    const lo = -vwin - 6 * C_KMS / R, hi = vwin + 6 * C_KMS / R, du = L.du;
    const i0 = Math.max(0, Math.floor((lo - P.meta.vSys - L.u0) / du)), i1 = Math.min(L.n - 1, Math.ceil((hi - P.meta.vSys - L.u0) / du));
    const n = i1 - i0 + 1, Vf = vgrid(L.u0 + i0 * du + P.meta.vSys, du, n);
    const tau = tauVoigt(I.atom, sel.map(c => [c.v, c.logN, c.b]), Vf);
    return degradeV({n, u0: L.u0 + i0 * du, du, flux: expNeg(tau), box: 0}, Math.round(R), 0, P.meta.vSys, {vwin, vcenter: 0});
  });
}
/* the request the Explore driver posts to fitworker.js (live fits only in Explore; seek() never fits). Same request
   as the explorer's panel: full stored line, library seeds and AOD regions, panel noise seed. */
export function fitRequest(data, k, R, snr, seedParam = 0, ci = 0) {
  const P = prep(data), I = P.ions[k], seed = caseSeed(seedParam, k, ci), o = degradeV(I.line, Math.round(R), snr, P.meta.vSys, {seed});
  return {id: P.meta.ray, ion: k, R: Math.round(R), snr, seed, paramsTag: "story",
    atom: {lam0_A: I.atom.lam0_A, f: I.atom.f, gamma_s: I.atom.gamma_s, b_min: I.atom.b_min, logN_max: I.atom.logN_max, damped: !!I.atom.damped},
    line: I.line, vSys: P.meta.vSys, data: {v: o.v, flux: o.flux, sigma: o.sigma},
    seeds: I.lib.map(c => COMP_KEYS.map(kk => c[kk] ?? null)), compKeys: COMP_KEYS, regions: I.aod ? I.aod[1] : []};
}
export const totalLogN = comps => { let s = 0; for (const c of comps || []) if (Number.isFinite(c.logN)) s += 10 ** c.logN; return s > 0 ? Math.log10(s) : NaN; };

// ---- feature picks: fixed rules, no hand-picked cells (works for any galaxy) -----------------------------------------
// data.select (U0, per galaxy and beam, rules recorded in the file) wins; the rules below are the fallback for data
// without it. Cell picks are returned as positions in path order (prep().ions.<k>.cells).
export function picks(data) {
  const P = prep(data);
  return memo(P, "picks", () => {
    const O = P.ions[LEAD], H = P.ions[SAT_ION], out = {}, sel = P.select || {}, fsel = P.fitSelect || {};
    if (O) {
      const c = O.cells, at = id => (c.pos.has(+id) ? c.pos.get(+id) : -1);
      // S5: the cell holding the most O VI among those whose own dip is clear but not black (0.3 <= tau0 <= 4)
      let best = -1, bestAny = -1;
      for (let j = 0; j < c.n; j++) {
        if (bestAny < 0 || c.logN[j] > c.logN[bestAny]) bestAny = j;
        if (c.tau0[j] >= 0.3 && c.tau0[j] <= 4 && Math.abs(c.V[j]) < 330 && (best < 0 || c.logN[j] > c.logN[best])) best = j;
      }
      out.dip = sel.S5_cell != null && at(sel.S5_cell) >= 0 ? at(sel.S5_cell) : best >= 0 ? best : bestAny;
      // S6: two cells with clear dips, >= 40 kpc apart, speeds closer than the narrower b; strongest weaker dip wins
      const sp = sel.S6_pair && Array.isArray(sel.S6_pair.cells) ? sel.S6_pair.cells.map(at) : null;
      if (sp && sp.length === 2 && sp.every(j => j >= 0)) out.pair = sp;
      else {
        let pr = null, score = -1; const vis = []; for (let j = 0; j < c.n; j++) if (c.tau0[j] > 0.1) vis.push(j);
        for (let x = 0; x < vis.length; x++) for (let y = x + 1; y < vis.length; y++) {
          const a = vis[x], b = vis[y], dl = Math.abs(c.l[a] - c.l[b]);
          if (dl < 40 || Math.abs(c.V[a] - c.V[b]) >= Math.min(c.b[a], c.b[b])) continue;
          const s = Math.min(c.tau0[a], c.tau0[b]) * (1 + dl / 200);
          if (s > score) { score = s; pr = [a, b]; }
        }
        out.pair = pr;
      }
      // S7: cells with a visible dip (tau0 > 0.01) and the trough extent (summed light below 99 %)
      let nv = 0; for (let j = 0; j < c.n; j++) if (c.tau0[j] > 0.01) nv++;
      out.nVis = nv;
      if (O.F) { let lo = NaN, hi = NaN; for (let i = 0; i < O.F.n; i++) if (O.F.flux[i] < 0.99) { if (!(lo <= O.F.v[i])) lo = O.F.v[i]; hi = O.F.v[i]; } out.trough = [lo, hi]; }
      let bmin = Infinity, bmax = 0; for (let j = 0; j < c.n; j++) if (c.tau0[j] > 0.01) { bmin = Math.min(bmin, c.b[j]); bmax = Math.max(bmax, c.b[j]); }
      out.bRange = [bmin, bmax];
      // S10: the weakest real O VI dip (local maximum of the summed tau >= 0.05 inside +-360 km/s): it exists in
      // F_intrinsic by construction, so "noise can hide dips" points at a real one
      if (sel.S10_feature && Number.isFinite(+sel.S10_feature.V_kms)) out.weak = {v: +sel.S10_feature.V_kms, tau: +sel.S10_feature.tau};
      else if (O.F) {
        const T = Array.from(O.F.flux, f => -Math.log(Math.max(f, 1e-9))); let w = -1;
        for (let i = 1; i < T.length - 1; i++) if (T[i] >= 0.05 && T[i] >= T[i - 1] && T[i] > T[i + 1] && Math.abs(O.F.v[i]) < 360 && (w < 0 || T[i] < T[w])) w = i;
        out.weak = w >= 0 ? {v: O.F.v[w], tau: T[w]} : null;
      }
      // S11: deterministic page fits (fitPanel with capMs = budgetMs = 1e9). seeds: page seeds 0, 1, 2 at R 30 000, S/N 10
      const F = O.fits || [], byIdx = i => F.find(f => f.idx === i) || null;
      out.seeds = Array.isArray(fsel.s11a) ? fsel.s11a.map(byIdx).filter(Boolean)
        : F.filter(f => f.R === 30000 && f.snr === 10 && f.ci === 0).sort((a, b) => a.seedParam - b.seedParam).slice(0, 3);
      // a very broad single cloud (low S/N) and an "invented" cloud too narrow to be O VI (b below thermal b at 10^5 K)
      out.bLow = bThermal(1e5, O.atom.mass_amu);
      const fb = fsel.s11c_broad ? byIdx(fsel.s11c_broad.fit) : null, fi = fsel.s11c_invented ? byIdx(fsel.s11c_invented.fit) : null;
      if (fb && fb.comps.length) out.broad = {fit: fb, comp: fb.comps.reduce((a, b) => (b.b > a.b ? b : a))};
      if (fi && fi.comps[fsel.s11c_invented.comp]) out.invented = {fit: fi, comp: fi.comps[fsel.s11c_invented.comp]};
      if (!fb || !fi) {
        let broad = null, inv = null;
        for (const f of F) { if (out.seeds.includes(f)) continue;
          for (const cc of f.comps || []) { if (f.comps.length === 1 && cc.b > 60 && (!broad || cc.b > broad.comp.b)) broad = {fit: f, comp: cc};
            if (cc.b < out.bLow && !inv) inv = {fit: f, comp: cc}; } }
        if (!fb) out.broad = broad; if (!fi) out.invented = inv;
      }
    }
    if (H) {
      const c = H.cells; let m = 0; for (let j = 1; j < c.n; j++) if (c.logN[j] > c.logN[m]) m = j;
      out.satCell = m; out.satB = clamp(c.b[m], 10, 40);
    }
    return out;
  });
}

// ---- {{key}} facts for the text templates (steps.json; resolved at runtime, PLAN_final §1.1) ------------------------
export function facts(data) {
  const P = prep(data);
  return memo(P, "facts", () => {
    const O = P.ions[LEAD], H = P.ions[SAT_ION], k = picks(data), f = {galaxy: String(P.meta.galaxy), ray: P.meta.ray,
      impact_kpc: fmt(P.meta.impact, 1), impact_ly: fmtInt(Math.round(P.meta.impact * 3261.56 / 1000) * 1000)};
    if (O) {
      const c = O.cells, j = k.dip;
      f.n_cells = String(c.n); f.n_vis = String(k.nVis);
      if (j >= 0) Object.assign(f, {dip_logN: fmt(c.logN[j], 2), dip_b: fmt(c.b[j], 1), dip_tau0: fmt(c.tau0[j], 2),
        dip_centre_pct: fmt(100 * Math.exp(-c.tau0[j]), 0), dip_T: fmtInt(c.T[j]), dip_V: fmt(c.V[j], 0),
        dip_bH: fmt(c.b[j] * Math.sqrt(O.atom.mass_amu / 1.008), 0), dip_bH_ratio: fmt(Math.sqrt(O.atom.mass_amu / 1.008), 0)});
      if (k.pair) { const [a, b] = k.pair; f.pair_dl_kpc = fmt(Math.abs(c.l[a] - c.l[b]), 0); f.pair_dV = fmt(Math.abs(c.V[a] - c.V[b]), 1); }
      f.peak_tau = fmt(O.totals.peakTau, 2); f.ew_mA = fmt(O.totals.ew, 0); f.total_logN = fmt(O.totals.logN, 2);
      if (k.trough) { f.trough_lo = fmt(k.trough[0], 0); f.trough_hi = fmt(k.trough[1], 0); f.trough_kms = fmt(k.trough[1] - k.trough[0], 0); }
      f.b_min = fmt(k.bRange[0], 1); f.b_max = fmt(k.bRange[1], 1);
      f.sigma_pix_sn10 = fmt(Math.sqrt(PIX_PER_RESEL) / 10, 2); f.pix_kms_R30000 = fmt(C_KMS / 30000 / PIX_PER_RESEL, 1);
      if (k.seeds[0]) { f.fit_n = String(k.seeds[0].comps.length); f.fit_total_logN = fmt(totalLogN(k.seeds[0].comps), 2); }
      if (k.broad) { f.broad_b = fmt(k.broad.comp.b, 0); f.broad_R = fmtInt(k.broad.fit.R); f.broad_sn = String(k.broad.fit.snr); }
      if (k.invented) { const x = k.invented; f.inv_b = fmt(x.comp.b, 1); f.inv_T = fmtInt(Math.round(tFromB(x.comp.b, O.atom.mass_amu) / 100) * 100);
        f.inv_R = fmtInt(x.fit.R); f.inv_sn = String(x.fit.snr); f.inv_total_logN = fmt(totalLogN(x.fit.comps), 2); }
      f.has_invented = k.invented ? "1" : "0";
    }
    if (H) { f.hi_logN = fmt(H.totals.logN, 2); f.hi_peak_tau = fmtInt(H.totals.peakTau); f.hi_lls = H.totals.logN >= 17.2 ? "1" : "0"; }
    for (const R of [150000, 30000, 15000, 5000]) f[`fwhm_${R}`] = fmt(C_KMS / R, 1);
    return f;
  });
}
export const fill = (s, data) => String(s).replace(/\{\{(\w+)\}\}/g, (m, k) => facts(data)[k] ?? m);

// ---- hand-off to the explorer: only formatHash from state.js (PLAN_final §4) -----------------------------------------
export function explorerHash(data, h = {}) {
  const P = prep(data), R = h.R || [30000, 30000], sn = h.sn || [10, 10];
  const S = {id: h.id || P.meta.ray, ions: h.ions || [LEAD], layout: h.layout || "1", R: {uv: [R[0], R[1] ?? R[0]]},
    sn: [sn[0], sn[1] ?? sn[0]], vc: 0, vhw: h.vhw || 400, seed: h.seed || 0, fit: !!h.fit, intr: !!h.intr, tab: h.tab || ""};
  const g = String(P.meta.galaxy);
  return formatHash(S) + (g && g !== String(DEFAULT_GALAXY) ? `&g=${g}` : "") + "&from=story";
}

// ---- frame and drawing --------------------------------------------------------------------------------------------------
/* Sets the device transform, clears the stage and returns the frame geometry in CSS pixels. state.safe = insets the
   page keeps free for the card and chrome ({l, t, r, b} in CSS px); state.layout "land" | "port". */
export function frame(ctx, state = {}) {
  const dpr = state.dpr || 1, W = ctx.canvas.width / dpr, H = ctx.canvas.height / dpr, port = state.layout === "port" || H > W * 1.05;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.globalAlpha = 1; ctx.globalCompositeOperation = "source-over";
  ctx.fillStyle = COL.bg; ctx.fillRect(0, 0, W, H);
  const s = state.safe || {}, fs = clamp(Math.min(W, H) * 0.028, 12, 26);
  // landscape Step/Explore on wide screens: the card sits on the left (min(0.36 W, 500) px, as the space scenes'
  // stageBox), so the plot box starts to its right with room for the y labels; Play/render use the full stage
  const card = !port && state.mode !== "watch" && state.mode !== "render" && W >= 900 ? Math.min(0.36 * W, 500) + 16 : 0;
  const L = s.l ?? Math.max((port ? 0.09 : 0.08) * W, card + 4.4 * fs, 74), T = s.t ?? (port ? 0.08 : 0.12) * H, Rr = s.r ?? (port ? 0.05 : 0.06) * W, B = s.b ?? (port ? 0.12 : 0.15) * H;
  return {ctx, W, H, dpr, port, fs, card, physics: !!state.physics, reduced: !!state.reduced, box: {x: L, y: T, w: W - L - Rr, h: H - T - B}};
}
/* a label in the margin above the plot box, left or right aligned */
export function corner(Fr, s, right, o = {}) {
  const b = Fr.box; return text(Fr, s, right ? b.x + b.w : b.x, b.y - Fr.fs * (0.5 + 1.25 * (o.row || 0)), {size: 0.8, color: COL.muted, align: right ? "right" : "left", ...o});
}
/* sub-rectangle of the plot box (fractions) */
export const sub = (Fr, x0, y0, x1, y1) => ({...Fr, box: {x: Fr.box.x + x0 * Fr.box.w, y: Fr.box.y + y0 * Fr.box.h, w: (x1 - x0) * Fr.box.w, h: (y1 - y0) * Fr.box.h}});
/* coordinate maps of a plot: x is speed (km/s) in [v0, v1], y is light getting through in [yLo, yHi] */
export function axesMap(Fr, v0, v1, yLo = 0, yHi = 1.08) {
  const b = Fr.box;
  return {...Fr, v0, v1, yLo, yHi, X: v => b.x + (v - v0) / (v1 - v0) * b.w, Y: f => b.y + (yHi - f) / (yHi - yLo) * b.h,
    V: x => v0 + (x - b.x) / b.w * (v1 - v0)};
}
export function font(Fr, scale = 1, weight = 400, mono = false) {
  return `${weight} ${Math.max(12, Math.round(Fr.fs * scale))}px ${mono ? '"JetBrains Mono", ui-monospace, monospace' : '"Space Grotesk", system-ui, sans-serif'}`;
}
export function text(Fr, s, x, y, o = {}) {
  const c = Fr.ctx; c.save();
  c.font = font(Fr, o.size || 1, o.weight || 400, !!o.mono); c.fillStyle = o.color || COL.ink; c.globalAlpha *= o.alpha ?? 1;
  c.textAlign = o.align || "left"; c.textBaseline = o.base || "alphabetic";
  if (o.halo) { c.lineWidth = 4; c.strokeStyle = COL.bg; c.lineJoin = "round"; c.strokeText(s, x, y); }
  c.fillText(s, x, y); const w = c.measureText(s).width; c.restore(); return w;
}
/* axes in plain words (PLAN_final §2.3); o.xAlpha / o.yAlpha fade labels in one at a time; Physics shows units */
export function axes(A, o = {}) {
  const c = A.ctx, b = A.box, xa = o.xAlpha ?? 1, ya = o.yAlpha ?? 1;
  c.save();
  if (ya > 0) {
    c.globalAlpha = ya; c.strokeStyle = COL.grid; c.lineWidth = 1;
    for (const f of o.yTicks || [0, 0.5, 1]) { const y = Math.round(A.Y(f)) + 0.5; c.beginPath(); c.moveTo(b.x, y); c.lineTo(b.x + b.w, y); c.stroke();
      text(A, A.physics ? fmt(f, 1) : `${Math.round(f * 100)} %`, b.x - 8, y + 4, {align: "right", size: 0.72, color: COL.muted, mono: true}); }
    c.save(); c.translate(b.x - Math.max(A.fs * 3.4, 60), b.y + b.h / 2); c.rotate(-Math.PI / 2);
    text(A, o.yLabel || (A.physics ? "F  (transmitted flux)" : "light getting through"), 0, 0, {align: "center", size: 0.78, color: COL.muted}); c.restore();
  }
  if (xa > 0) {
    c.globalAlpha = xa; const step = o.xStep ? (A.box.w < 420 ? 2 * o.xStep : o.xStep) : niceStep((A.v1 - A.v0) * (A.box.w < 420 ? 1.6 : 1)), y0 = b.y + b.h;
    c.strokeStyle = COL.faint; c.beginPath(); c.moveTo(b.x, y0 + 0.5); c.lineTo(b.x + b.w, y0 + 0.5); c.stroke();
    for (let v = Math.ceil(A.v0 / step) * step; v <= A.v1 + 1e-9; v += step) { const x = Math.round(A.X(v)) + 0.5;
      c.beginPath(); c.moveTo(x, y0); c.lineTo(x, y0 + 5); c.stroke(); text(A, fmt(v, 0), x, y0 + A.fs * 1.25, {align: "center", size: 0.72, color: COL.muted, mono: true}); }
    text(A, o.xLabel || (A.physics ? "V  (km/s, galaxy frame)" : "speed toward or away (km/s)"), b.x + b.w / 2, y0 + A.fs * 2.6, {align: "center", size: 0.78, color: COL.muted});
  }
  c.restore();
}
export function niceStep(span) { const r = span / 6, p = 10 ** Math.floor(Math.log10(r)), m = r / p; return (m < 1.5 ? 1 : m < 3.5 ? 2 : m < 7.5 ? 5 : 10) * p; }
/* polyline of y(v) through the map; ys may be a function of index */
/* clip to the plot box (data never spills into the margins where labels sit) */
function clipBox(A) { const c = A.ctx, b = A.box; c.beginPath(); c.rect(b.x - 2, b.y - 1, b.w + 4, b.h + 2); c.clip(); }
export function curve(A, v, y, o = {}) {
  const c = A.ctx, n = v.length; c.save(); if (A.Y && !o.noclip) clipBox(A);
  c.beginPath(); let on = false;
  for (let i = 0; i < n; i++) { const vi = v[i]; if (vi < A.v0 - 1e-9 || vi > A.v1 + 1e-9) { on = false; continue; }
    const X = A.X(vi), Y = A.Y(typeof y === "function" ? y(i) : y[i]); if (!on) { c.moveTo(X, Y); on = true; } else c.lineTo(X, Y); }
  c.globalAlpha *= o.alpha ?? 1; c.strokeStyle = o.color || COL.beam; c.lineWidth = o.width || 2; c.lineJoin = "round"; c.lineCap = "round";
  if (o.dash) c.setLineDash(o.dash);
  if (o.glow) { c.shadowColor = o.glowColor || o.color || COL.beam; c.shadowBlur = o.glow; }
  c.stroke(); c.restore();
}
/* shaded absorbed area between the continuum (1) and y(v) */
export function shade(A, v, y, o = {}) {
  const c = A.ctx, n = v.length; c.save(); clipBox(A); c.beginPath(); let first = -1, last = -1;
  for (let i = 0; i < n; i++) { if (v[i] < A.v0 || v[i] > A.v1) continue; const X = A.X(v[i]), Y = A.Y(typeof y === "function" ? y(i) : y[i]);
    if (first < 0) { c.moveTo(X, A.Y(1)); first = i; } c.lineTo(X, Y); last = i; }
  if (first < 0) { c.restore(); return; }
  c.lineTo(A.X(v[last]), A.Y(1)); c.closePath(); c.globalAlpha *= o.alpha ?? 1; c.fillStyle = o.color || COL.accentSoft; c.fill(); c.restore();
}
/* pixel stairs (S10, S11): data pixels as flat steps */
export function stairs(A, v, y, o = {}) {
  const c = A.ctx, n = v.length; if (n < 2) return; const h = (v[1] - v[0]) / 2; c.save(); clipBox(A); c.beginPath(); let on = false;
  for (let i = 0; i < n; i++) { if (v[i] < A.v0 || v[i] > A.v1) { on = false; continue; } const Y = A.Y(y[i]);
    if (!on) { c.moveTo(A.X(v[i] - h), Y); on = true; } else c.lineTo(A.X(v[i] - h), Y); c.lineTo(A.X(v[i] + h), Y); }
  c.globalAlpha *= o.alpha ?? 1; c.strokeStyle = o.color || COL.data; c.lineWidth = (o.width || 1.3) * Math.max(1, A.fs / 22); c.stroke(); c.restore();   // thicker on big stages (film)
}
export function vline(A, v, y0, y1, o = {}) {
  const c = A.ctx; c.save(); c.globalAlpha *= o.alpha ?? 1; c.strokeStyle = o.color || COL.accent; c.lineWidth = o.width || 1.5;
  if (o.dash) c.setLineDash(o.dash); c.beginPath(); c.moveTo(A.X(v), A.Y(y0)); c.lineTo(A.X(v), A.Y(y1)); c.stroke(); c.restore();
}
/* quantity glyphs (PLAN_final §2.3): amount = vertical arrow, width = horizontal span, speed = position tick */
export function arrowV(A, x, y0, y1, o = {}) {
  const c = A.ctx, hd = Math.max(5, A.fs * 0.45), dir = Math.sign(y1 - y0) || 1; c.save(); c.globalAlpha *= o.alpha ?? 1;
  c.strokeStyle = c.fillStyle = o.color || COL.accent; c.lineWidth = o.width || 2;
  if (o.glow) { c.shadowColor = c.strokeStyle; c.shadowBlur = o.glow; }
  c.beginPath(); c.moveTo(x, y0); c.lineTo(x, y1 - dir * hd * 0.6); c.stroke();
  c.beginPath(); c.moveTo(x, y1); c.lineTo(x - hd * 0.6, y1 - dir * hd); c.lineTo(x + hd * 0.6, y1 - dir * hd); c.closePath(); c.fill(); c.restore();
}
export function spanH(A, x0, x1, y, o = {}) {
  const c = A.ctx, t = Math.max(4, A.fs * 0.35); c.save(); c.globalAlpha *= o.alpha ?? 1; c.strokeStyle = o.color || COL.accent; c.lineWidth = o.width || 2;
  if (o.glow) { c.shadowColor = c.strokeStyle; c.shadowBlur = o.glow; }
  c.beginPath(); c.moveTo(x0, y); c.lineTo(x1, y); c.moveTo(x0, y - t); c.lineTo(x0, y + t); c.moveTo(x1, y - t); c.lineTo(x1, y + t); c.stroke(); c.restore();
}
export function tick(A, v, o = {}) {
  const c = A.ctx, y = o.y ?? A.Y(1.04), L = o.len ?? A.fs * 0.8; c.save(); c.globalAlpha *= o.alpha ?? 1;
  c.strokeStyle = c.fillStyle = o.color || COL.accent; c.lineWidth = o.width || 2;
  if (o.hollow) { c.lineWidth = 1.5; c.strokeRect(A.X(v) - 3, y - L, 6, L); } else { c.beginPath(); c.moveTo(A.X(v), y - L); c.lineTo(A.X(v), y); c.stroke(); }
  c.restore();
}
/* the instrument blur as a neutral grey bell of FWHM c/R, centred at v, height h (CSS px), base at y */
export function bell(A, v, fwhm, y, h, o = {}) {
  const c = A.ctx, s = fwhm / 2.35482; c.save(); c.globalAlpha *= o.alpha ?? 1; c.strokeStyle = COL.blur; c.lineWidth = 1.6;
  c.beginPath(); for (let k = -60; k <= 60; k++) { const dv = k / 60 * 4 * s, X = A.X(v + dv), Y = y - h * Math.exp(-0.5 * (dv / s) ** 2); k === -60 ? c.moveTo(X, Y) : c.lineTo(X, Y); }
  c.stroke(); c.globalAlpha *= 0.12; c.fillStyle = COL.blur; c.lineTo(A.X(v + 4 * s), y); c.lineTo(A.X(v - 4 * s), y); c.closePath(); c.fill(); c.restore();
}
/* horizontal meter (S8): label, bar filled to frac, value text */
export function meter(Fr, x, y, w, label, frac, value, o = {}) {
  const c = Fr.ctx, h = Math.max(6, Fr.fs * 0.5); c.save(); c.globalAlpha *= o.alpha ?? 1;
  text(Fr, label, x, y - h * 0.9, {size: 0.8, color: COL.muted});
  c.fillStyle = "rgba(236,240,255,0.10)"; roundRect(c, x, y, w, h, h / 2); c.fill();
  c.fillStyle = o.color || COL.accent; roundRect(c, x, y, Math.max(h, w * clamp(frac)), h, h / 2); c.fill();
  if (value) text(Fr, value, x + w, y - h * 0.9, {size: 0.78, align: "right", mono: true, color: COL.ink});
  c.restore();
}
export function roundRect(c, x, y, w, h, r) { c.beginPath(); c.moveTo(x + r, y); c.arcTo(x + w, y, x + w, y + h, r); c.arcTo(x + w, y + h, x, y + h, r); c.arcTo(x, y + h, x, y, r); c.arcTo(x, y, x + w, y, r); c.closePath(); }
/* glass panel in the explorer's look (S12 end card) */
export function glass(Fr, x, y, w, h, o = {}) {
  const c = Fr.ctx; c.save(); c.globalAlpha *= o.alpha ?? 1; roundRect(c, x, y, w, h, Fr.fs * 0.9);
  c.fillStyle = "rgba(20,24,38,0.72)"; c.fill(); c.strokeStyle = "rgba(236,240,255,0.14)"; c.lineWidth = 1; c.stroke(); c.restore();
}
/* bead (S6, S11c): soft disc with additive glow */
export function bead(Fr, x, y, r, color, a = 1) {
  const c = Fr.ctx; c.save(); c.globalCompositeOperation = "lighter"; c.globalAlpha *= a;
  const g = c.createRadialGradient(x, y, 0, x, y, r * 2.2); g.addColorStop(0, color); g.addColorStop(0.45, color); g.addColorStop(1, "rgba(0,0,0,0)");
  c.fillStyle = g; c.beginPath(); c.arc(x, y, r * 2.2, 0, 2 * Math.PI); c.fill(); c.restore();
}
/* thread from (x0, y0) to (x1, y1), a soft cubic */
export function thread(Fr, x0, y0, x1, y1, o = {}) {
  const c = Fr.ctx, my = (y0 + y1) / 2; c.save(); c.globalAlpha *= o.alpha ?? 1; c.strokeStyle = o.color || COL.faint; c.lineWidth = o.width || 1;
  if (o.dash) c.setLineDash(o.dash); c.beginPath(); c.moveTo(x0, y0); c.bezierCurveTo(x0, my, x1, my, x1, y1); c.stroke(); c.restore();
}
/* the scene's view of the frame state: the engine passes authored (tweened) params merged with the Explore override
   and the frame keys (step, p, u, t, dur_s, mode, explore, physics, layout, dpr, safe, seed, ...). p is the eased
   progress through the step; scenes choreograph their beats on it. Plain object; never mutated. */
export function params(scene, state = {}) {
  const base = (scene.defaults && scene.defaults[state.step]) || {}, p = {...base, ...(state.params || {}), ...state};
  if (state.mode === "explore" && state.explore) Object.assign(p, state.explore);
  if (!Number.isFinite(p.p)) p.p = Number.isFinite(state.u) ? state.u : state.dur_s > 0 && Number.isFinite(state.t) ? clamp(state.t / state.dur_s) : 1;
  return p;
}
/* the ray strip used by S6 and S11c: path position l (kpc) -> x, beads sized by path inside the cell */
export function rayStrip(Fr, data, k, o = {}) {
  const P = prep(data), I = P.ions[k], c = I.cells, b = Fr.box, half = Number.isFinite(P.meta.half) ? P.meta.half : Math.max(...c.l.map(Math.abs));
  const X = l => b.x + (l + half) / (2 * half) * b.w, y = o.y ?? b.y + b.h / 2;
  const ctx = Fr.ctx; ctx.save(); ctx.strokeStyle = rgba(COL.beam, 0.55 * (o.alpha ?? 1)); ctx.lineWidth = 1.5;
  ctx.beginPath(); ctx.moveTo(b.x, y); ctx.lineTo(b.x + b.w, y); ctx.stroke(); ctx.restore();
  if ((o.labels ?? 1) > 0) {
    const a = o.labels ?? 1;
    text(Fr, `−${fmt(half, 0)} kpc`, b.x, y + Fr.fs * 1.6, {size: 0.7, color: COL.muted, mono: true, alpha: a});
    text(Fr, `+${fmt(half, 0)} kpc`, b.x + b.w, y + Fr.fs * 1.6, {size: 0.7, color: COL.muted, mono: true, align: "right", alpha: a});
    text(Fr, o.label || "position along the beam", b.x + b.w / 2, y + Fr.fs * 1.6, {size: 0.72, color: COL.muted, align: "center", alpha: a});
  }
  return {X, y, half};
}
