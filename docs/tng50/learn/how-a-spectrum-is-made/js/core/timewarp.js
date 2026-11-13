// Time warp along the beam (DESIGN §2.3, DESIGN_final P2-2). Pure: no DOM, no time, no random.
//
// Inside a flight beat the probe position ℓ(u) is the inverse of the cumulative weight
//     W(ℓ) = ∫ (ε + w(ℓ')) dℓ',   w = log10(1 + g),   g = Σ τ₀ per kpc of the beat's lead ion,
// smoothed with a Gaussian of FWHM 3 kpc, and ε chosen so the emptiest kpc costs `floor` (0.25) of the busiest kpc:
//     ε / (ε + w_max) = floor  ⇒  ε = floor × w_max / (1 − floor).
// The camera therefore slows down inside clouds and zips through the quiet. W is piecewise linear on a fixed grid and
// strictly increasing (ε > 0), so ℓ(u) and u(ℓ) are exact inverses of each other (gate: timewarp monotone, invertible).
// The warp depends only on the cells (positions, widths, τ₀): it never reads user overrides (R, S/N, T, N, TF, ...).
//
//   buildWarp(cells, opts) -> warp
//     cells: {l: number[], tau0: number[], s_in?: number[], s_out?: number[], dl?: number[]}
//            each cell's τ₀ is spread uniformly over [s_in, s_out] (story-data/2) or l ± dl/2 (v1 data)
//     opts:  {lmin, lmax, dx = 0.25, fwhm = 3, floor = 0.25}
//     warp.W(l)               cumulative weight (kpc-equivalents)
//     warp.lAt(Wv)            inverse of W
//     warp.lOf(l0, l1, u)     ℓ at beat fraction u for a flight from l0 to l1 (l1 < l0 allowed)
//     warp.uOf(l0, l1, l)     inverse of lOf
//     warp.cost(l)            ε + w(ℓ) (for the rail's mini-map and the tests)
//     warp.eps, warp.wmax, warp.x, warp.Wtab

export const WARP_DEFAULTS = Object.freeze({dx: 0.25, fwhm: 3, floor: 0.25});

export function buildWarp(cells, opts = {}) {
  const o = {...WARP_DEFAULTS, ...opts};
  const l = cells.l || [], tau = cells.tau0 || [];
  const n = l.length;
  let lmin = Number.isFinite(o.lmin) ? o.lmin : Math.min(...l) - 5;
  let lmax = Number.isFinite(o.lmax) ? o.lmax : Math.max(...l) + 5;
  if (!(lmax > lmin)) { lmin = -1; lmax = 1; }
  const dx = o.dx, N = Math.max(2, Math.ceil((lmax - lmin) / dx) + 1);
  const x = new Float64Array(N);
  for (let i = 0; i < N; i++) x[i] = lmin + i * dx;

  // deposit τ₀ per kpc (bin i covers [x_i - dx/2, x_i + dx/2])
  const g = new Float64Array(N);
  for (let k = 0; k < n; k++) {
    const t = +tau[k]; if (!(t > 0)) continue;
    let a, b;
    if (cells.s_in && cells.s_out) { a = +cells.s_in[k]; b = +cells.s_out[k]; }
    else { const h = (cells.dl ? +cells.dl[k] : dx) / 2; a = +l[k] - h; b = +l[k] + h; }
    if (!(b > a)) { a = +l[k] - dx / 2; b = +l[k] + dx / 2; }
    const dens = t / (b - a);
    const i0 = Math.max(0, Math.floor((a - lmin) / dx + 0.5)), i1 = Math.min(N - 1, Math.floor((b - lmin) / dx + 0.5));
    for (let i = i0; i <= i1; i++) {
      const lo = Math.max(a, x[i] - dx / 2), hi = Math.min(b, x[i] + dx / 2);
      if (hi > lo) g[i] += dens * (hi - lo) / dx;
    }
  }
  // w = log10(1 + g), then Gaussian smoothing (FWHM o.fwhm kpc), truncated at 3σ, edge-renormalised
  const w0 = new Float64Array(N);
  for (let i = 0; i < N; i++) w0[i] = Math.log10(1 + g[i]);
  const sig = o.fwhm / 2.3548 / dx, R = Math.max(1, Math.ceil(3 * sig));
  const ker = new Float64Array(2 * R + 1);
  for (let j = -R; j <= R; j++) ker[j + R] = Math.exp(-0.5 * (j / sig) ** 2);
  const w = new Float64Array(N);
  let wmax = 0;
  for (let i = 0; i < N; i++) {
    let s = 0, ws = 0;
    for (let j = -R; j <= R; j++) { const q = i + j; if (q < 0 || q >= N) continue; s += ker[j + R] * w0[q]; ws += ker[j + R]; }
    w[i] = s / ws; if (w[i] > wmax) wmax = w[i];
  }
  const floor = Math.min(0.99, Math.max(0.01, o.floor));
  const eps = wmax > 0 ? floor * wmax / (1 - floor) : 1;
  // cumulative W (trapezoid on the grid; W[0] = 0)
  const Wt = new Float64Array(N);
  for (let i = 1; i < N; i++) Wt[i] = Wt[i - 1] + dx * (eps + 0.5 * (w[i - 1] + w[i]));

  const idx = v => { const f = (v - lmin) / dx; return f <= 0 ? 0 : f >= N - 1 ? N - 2 : Math.floor(f); };
  function W(v) {
    if (v <= lmin) return (v - lmin) * (eps + w[0]);                 // linear extension outside the grid
    if (v >= lmax) return Wt[N - 1] + (v - x[N - 1]) * (eps + w[N - 1]);
    const i = idx(v), f = (v - x[i]) / dx;
    return Wt[i] + f * (Wt[i + 1] - Wt[i]);
  }
  function lAt(Wv) {
    if (Wv <= 0) return lmin + Wv / (eps + w[0]);
    if (Wv >= Wt[N - 1]) return x[N - 1] + (Wv - Wt[N - 1]) / (eps + w[N - 1]);
    let lo = 0, hi = N - 1;
    while (hi - lo > 1) { const m = (lo + hi) >> 1; if (Wt[m] <= Wv) lo = m; else hi = m; }
    return x[lo] + dx * (Wv - Wt[lo]) / (Wt[lo + 1] - Wt[lo]);
  }
  const clampU = u => (u < 0 ? 0 : u > 1 ? 1 : u);
  function lOf(l0, l1, u) {
    if (l0 === l1) return l0;
    const a = W(l0), b = W(l1);
    return lAt(a + clampU(u) * (b - a));
  }
  function uOf(l0, l1, v) {
    if (l0 === l1) return 0;
    const a = W(l0), b = W(l1);
    return clampU((W(v) - a) / (b - a));
  }
  function cost(v) { const i = idx(v), f = Math.min(1, Math.max(0, (v - x[i]) / dx)); return eps + w[i] + f * (w[i + 1] - w[i]); }
  return {W, lAt, lOf, uOf, cost, eps, wmax, floor, x, Wtab: Wt, w, lmin, lmax, dx};
}
