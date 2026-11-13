// Stateless live optical depth of the story ray (DESIGN_final §3.4 "JS (seek, τ sum)", C_eng P0-5, C_science M10).
//
//   τ(s, v) = Σ_i W_i(s) τ_i(v)
//
// W_i(s) is the chord CDF of cell i's yt/Trident cubic kernel (story-data/2 geometry.kernel_cdf, evaluated exactly as the
// exporter's kcdf_eval: bilinear on the linear (q, u) grid, q = d/h clipped to [0, 1], u = (s − lc)/c clipped to [−1, 1],
// c = sqrt(h² − d²)), so the dock, the stage's bead glow and the stored spectrum use the same kernel: at the end of the
// flight τ equals the stored F (O VI ≤ 2.5e-4, H I ≤ 2e-3, the exporter's own check).
// τ_i(v) = k_tau N_i H(a_i, (v − V_i)/b_i)/b_i on the story grid (meta.grid, 1 km/s, −400..+400), with the data's own k_tau and
// per-cell a_i, through the explorer's Faddeeva function (fit.js tauVoigt; full Voigt wings, H I included).
//
// Nothing here depends on the previous frame: tauAt(s) is a pure function of s. Speed comes from a frame-independent
// cache built once per ion (in a worker, js/spectrum/tauworker.js, or synchronously): τ_i in CSR over each cell's support
// (|τ_i| ≥ 1e-13, so every dropped tail is below 1e-13 per bin) and float64 prefix sums over the cells ordered by s_out,
// stored every CKPT cells. A frame then costs one 801-bin copy, ≤ CKPT − 1 full cells and the few partial cells.
//
// Pure ES module (no DOM, no clock, no random): runs in node, a worker and the page.
import {tauVoigt, atomCoeffs} from "../../../../js/fit.js";

export const TAUSUM_VERSION = 1;
export const CKPT = 16;            // prefix-sum checkpoint stride (cells)
export const TAU_FLOOR = 1e-13;    // CSR support threshold (absolute, per bin)

/* ---------------- geometry and kernel weights (exporter's kcdf_eval, bit for bit in float64) ---------------- */
export function geometryOf(data) {
  const g = data && data.geometry && data.geometry.cells;
  if (!g || !g.lc || !g.h || !g.d) throw new Error("tausum: story-data/2 geometry.cells (lc, h, d) missing");
  const n = g.lc.length, lc = Float64Array.from(g.lc), q = new Float64Array(n), c = new Float64Array(n);
  const sIn = new Float64Array(n), sOut = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const h = +g.h[i], d = +g.d[i];
    q[i] = Math.min(1, Math.max(0, d / h));
    c[i] = Math.sqrt(Math.max(h * h - d * d, 0));
    sIn[i] = lc[i] - c[i]; sOut[i] = lc[i] + c[i];
  }
  const k = data.geometry.kernel_cdf;
  if (!k || !Array.isArray(k.table)) throw new Error("tausum: geometry.kernel_cdf.table missing");
  const nq = k.table.length, nu = k.table[0].length, tab = new Float64Array(nq * nu);
  for (let a = 0; a < nq; a++) for (let b = 0; b < nu; b++) tab[a * nu + b] = +k.table[a][b];
  let sMin = Infinity, sMax = -Infinity;
  for (let i = 0; i < n; i++) { if (sIn[i] < sMin) sMin = sIn[i]; if (sOut[i] > sMax) sMax = sOut[i]; }
  return {n, lc, q, c, sIn, sOut, tab, nq, nu, sMin, sMax, idx: g.idx ? Int32Array.from(g.idx) : null};
}

/* W_i(s): 0 before s_in, 1 after s_out, the kernel chord CDF in between (kcdf_eval) */
export function weight(G, i, s) {
  const nq = G.nq, nu = G.nu;
  const u0 = (s - G.lc[i]) / Math.max(G.c[i], 1e-12);
  const qq = G.q[i] * (nq - 1);                                    // q already clipped to [0, 1]
  const uu = (Math.min(1, Math.max(-1, u0)) + 1) * 0.5 * (nu - 1);
  const a = Math.min(Math.floor(qq), nq - 2), b = Math.min(Math.floor(uu), nu - 2);
  const tq = qq - a, tu = uu - b, T = G.tab, r0 = a * nu, r1 = r0 + nu;
  return (1 - tq) * (1 - tu) * T[r0 + b] + tq * (1 - tu) * T[r1 + b] + (1 - tq) * tu * T[r0 + b + 1] + tq * tu * T[r1 + b + 1];
}
/* all weights at s (Float64Array n) */
export function weights(G, s, out) {
  const w = out || new Float64Array(G.n);
  for (let i = 0; i < G.n; i++) w[i] = weight(G, i, s);
  return w;
}

/* ---------------- per-cell optical depth (frame-independent; the worker's job) ---------------- */
export function gridOf(data) {
  const g = (data && data.meta && data.meta.grid) || {V0: -400, V1: 400, dV: 1};
  const v0 = +g.V0, dv = +g.dV, n = Math.round((+g.V1 - v0) / dv) + 1;
  return {v0, dv, n};
}
/* the data's per-ion inputs as plain transferable arrays (what the page posts to the worker) */
export function ionInputs(data, ion) {
  const I = data.ions && data.ions[ion];
  if (!I || !I.cells) throw new Error(`tausum: no cells for ${ion}`);
  const C = I.cells, n = C.logN.length, f = x => Float64Array.from({length: n}, (_, i) => (x[i] == null ? NaN : +x[i]));
  return {ion, atom: {lam0_A: +I.atom.lam0_A, f: +I.atom.f, gamma_s: +I.atom.gamma_s, k_tau: +I.atom.k_tau},
    logN: f(C.logN), V: f(C.V), b: f(C.b), a: f(C.a)};
}
/* CSR of τ_i(v) over each cell's support. Uses fit.js tauVoigt with an atom whose coefficients reproduce the data's own
   k_tau and the cell's own a_i exactly (a = a0/b with a0 = a_i b; kTau scaled to k_tau). Pure. */
export function buildCellTau(inp, grid) {
  const n = inp.logN.length, N = grid.n, v = new Float64Array(N);
  for (let j = 0; j < N; j++) v[j] = grid.v0 + j * grid.dv;
  const base = atomCoeffs(inp.atom), lamCm = inp.atom.lam0_A * 1e-8;
  const fScale = Number.isFinite(inp.atom.k_tau) && inp.atom.k_tau > 0 ? inp.atom.k_tau / base.kTau : 1;
  const start = new Int32Array(n), len = new Int32Array(n), ptr = new Int32Array(n + 1);
  const parts = new Array(n), tmp = new Float64Array(N);
  let off = 0;
  for (let i = 0; i < n; i++) {
    const b = inp.b[i], lN = inp.logN[i];
    if (!(b > 0) || !Number.isFinite(lN)) { parts[i] = null; start[i] = 0; len[i] = 0; continue; }
    const a = Number.isFinite(inp.a[i]) ? inp.a[i] : (inp.atom.gamma_s * lamCm / (4 * Math.PI * 1e5)) / b;
    const atom = {lam0_A: inp.atom.lam0_A, f: inp.atom.f * fScale, gamma_s: a * b * 4 * Math.PI * 1e5 / lamCm};
    tmp.fill(0); tauVoigt(atom, [[inp.V[i], lN, b]], v, tmp);
    let lo = 0, hi = N - 1;
    while (lo < N && !(Math.abs(tmp[lo]) >= TAU_FLOOR)) lo++;
    while (hi >= lo && !(Math.abs(tmp[hi]) >= TAU_FLOOR)) hi--;
    if (hi < lo) { parts[i] = null; start[i] = 0; len[i] = 0; continue; }
    parts[i] = tmp.slice(lo, hi + 1); start[i] = lo; len[i] = hi - lo + 1; off += len[i];
  }
  const vals = new Float64Array(off);
  for (let i = 0, o = 0; i < n; i++) { ptr[i] = o; if (parts[i]) { vals.set(parts[i], o); o += parts[i].length; } ptr[i + 1] = o; }
  return {ion: inp.ion, n, N, start, len, ptr, vals};
}
/* prefix sums over cells ordered by s_out, every CKPT cells: ckpt[k] = Σ_{r < k CKPT} τ_order[r] (float64, N bins) */
export function buildPrefix(G, csr) {
  const n = G.n, N = csr.N, order = new Int32Array(n);
  for (let i = 0; i < n; i++) order[i] = i;
  order.sort((x, y) => G.sOut[x] - G.sOut[y] || x - y);
  const sOutSorted = new Float64Array(n);
  for (let r = 0; r < n; r++) sOutSorted[r] = G.sOut[order[r]];
  const nk = Math.floor(n / CKPT) + 1, ckpt = new Float64Array(nk * N), acc = new Float64Array(N);
  for (let r = 0; r < n; r++) {
    if (r % CKPT === 0) ckpt.set(acc, (r / CKPT) * N);
    addCell(csr, order[r], 1, acc);
  }
  if (n % CKPT === 0) ckpt.set(acc, (n / CKPT) * N);
  return {order, sOutSorted, ckpt, nk};
}
function addCell(csr, i, w, out) {
  const s = csr.start[i], o = csr.ptr[i], L = csr.len[i], V = csr.vals;
  for (let k = 0; k < L; k++) out[s + k] += w * V[o + k];
}

/* ---------------- the live sum ---------------- */
/* createTauSum(G, csr, prefix?) -> {tauAt(s, out), cellTau(i, out), fracAt(s), ...}. G from geometryOf, csr from
   buildCellTau (or the worker), prefix from buildPrefix (built here when absent). */
export function createTauSum(G, csr, prefix = null, extra = {}) {
  const P = prefix || buildPrefix(G, csr), N = csr.N;
  const Ncol = extra.Ncol || null;                          // linear column per cell (fraction meters)
  let Ntot = 0; if (Ncol) for (let i = 0; i < Ncol.length; i++) Ntot += Ncol[i] > 0 ? Ncol[i] : 0;
  /* number of cells with s_out ≤ s (binary search on the s_out order) */
  const fullCount = s => { let lo = 0, hi = G.n; while (lo < hi) { const m = (lo + hi) >> 1; if (P.sOutSorted[m] <= s) lo = m + 1; else hi = m; } return lo; };
  const api = {
    ion: csr.ion, n: G.n, N, G, csr, prefix: P,
    /* τ(s) on the grid (Float64Array N); pure in s */
    tauAt(s, out) {
      const tau = out || new Float64Array(N);
      const k = fullCount(s), kb = Math.floor(k / CKPT);
      tau.set(P.ckpt.subarray(kb * N, kb * N + N));
      for (let r = kb * CKPT; r < k; r++) addCell(csr, P.order[r], 1, tau);
      // partial cells: s_in < s < s_out (W strictly inside (0, 1) up to the table's own end values)
      for (let i = 0; i < G.n; i++) if (s > G.sIn[i] && s < G.sOut[i]) { const w = weight(G, i, s); if (w !== 0) addCell(csr, i, w, tau); }
      return tau;
    },
    /* direct sum (reference path for tests): Σ_i W_i(s) τ_i, no prefix */
    tauDirect(s, out) {
      const tau = out ? (out.fill(0), out) : new Float64Array(N);
      for (let i = 0; i < G.n; i++) { const w = weight(G, i, s); if (w !== 0) addCell(csr, i, w, tau); }
      return tau;
    },
    /* one cell's full τ_i (Float64Array N) */
    cellTau(i, out) { const t = out ? (out.fill(0), out) : new Float64Array(N); addCell(csr, i, 1, t); return t; },
    /* add w τ_i into out */
    addCell(i, w, out) { addCell(csr, i, w, out); return out; },
    weight: (i, s) => weight(G, i, s),
    /* fraction of the ion's total column already behind the probe (N-weighted, the meters' "in the way") */
    fracAt(s) {
      if (!Ncol || !(Ntot > 0)) return NaN;
      let acc = 0; for (let i = 0; i < G.n; i++) if (Ncol[i] > 0) acc += weight(G, i, s) * Ncol[i];
      return acc / Ntot;
    },
    /* cells whose kernels hold ≥ minShare of τ(s) at grid bin j (brushing: dock speed range -> cells on the beam) */
    cellsAtBin(s, j0, j1 = j0, minShare = 0.05) {
      const lo = Math.max(0, Math.min(j0, j1)), hi = Math.min(N - 1, Math.max(j0, j1)), tot = new Float64Array(hi - lo + 1), per = [];
      for (let i = 0; i < G.n; i++) {
        const w = weight(G, i, s); if (!(w > 0)) continue;
        const st = csr.start[i], L = csr.len[i]; if (st > hi || st + L - 1 < lo) continue;
        let m = 0; const o = csr.ptr[i];
        for (let j = Math.max(lo, st); j <= Math.min(hi, st + L - 1); j++) { const x = w * csr.vals[o + j - st]; tot[j - lo] += x; if (x > m) m = x; }
        per.push([i, m]);
      }
      let T = 0; for (const x of tot) if (x > T) T = x;
      return per.filter(([, m]) => T > 0 && m >= minShare * T).sort((a, b) => b[1] - a[1]).map(([i, m]) => ({i, idx: G.idx ? G.idx[i] : i, share: m / T}));
    },
    fullCount,
  };
  return api;
}

/* convenience: everything synchronously from the data (node, tests, pages without workers) */
export function tauSumFromData(data, ion) {
  const G = geometryOf(data), grid = gridOf(data), inp = ionInputs(data, ion), csr = buildCellTau(inp, grid);
  const Ncol = Float64Array.from(inp.logN, x => (Number.isFinite(x) ? 10 ** x : 0));
  return createTauSum(G, csr, null, {Ncol, grid});
}
/* rebuild from the worker's transferred buffers ({csr, prefix}) */
export function tauSumFromBuffers(data, msg) {
  const G = geometryOf(data), inp = data.ions[msg.ion].cells;
  const Ncol = Float64Array.from(inp.logN, x => (x != null && Number.isFinite(+x) ? 10 ** +x : 0));
  return createTauSum(G, msg.csr, msg.prefix, {Ncol});
}
