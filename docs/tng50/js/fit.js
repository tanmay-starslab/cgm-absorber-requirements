// In-browser Voigt-profile fitter for the TNG50 explorer (design-3 section 5). Pure ES module: no DOM, no I/O, and no
// module state other than the Weideman coefficients, so it runs unchanged in node >= 20, in a Web Worker and in tests.
//
// Model (shared by the displayed spectrum and the fit):
//   fine grid      V_i = u0 + i*du + vSys  (the decoded TNGS line, du = 1 km/s)
//   component      tau = k_tau * 10^logN * H(a, x) / b,  x = (V - v_c)/b,  a = a0/b,  H = Re w(x + i a)
//   flux           F = exp(-sum tau), convolved with the pixel-integrated Gaussian LSF (FWHM = c/R, edge-extend)
//   data pixels    numpy-style linear interpolation of the convolved flux at the output velocities
// The convolution is only evaluated at the fine indices that bracket an output pixel (2 dot products per pixel),
// which is identical to a full convolution followed by interpolation.

export const FIT_VERSION = "fit/1";
export const FIT_PARAMS = {maxIt: 40, maxItPrune: 20, maxTries: 8, lambda0: 1e-2, lambdaMin: 1e-7, relTol: 1e-5,
  padResel: 2, padKms: 10, mergeFrac: 0.5, bMax: 300, logNMin: 10, bicK: 3, maxPrunePasses: 30, asymU: 10,
  budgetMs: 300, capMs: 1500, cacheSize: 256, chi2nuPoor: 2.0};
export const FLAGS = {SAT: 1, BOUND: 2, POORFIT: 8, BUDGET: 128};

const C_KMS = 299792.458, FWHM_TO_SIGMA = 1 / 2.35482, PIX_PER_RESEL = 5, SIGMA0 = 0.02654008;
const SQPI = Math.sqrt(Math.PI), ISQPI = 1 / SQPI, LN10 = Math.LN10, BOUND_TOL = 1e-3, SAT_FLUX = 0.05;
const KEY_RE = /^[A-Z][a-z]?[IVX]+$/;
const now = () => (globalThis.performance && performance.now ? performance.now() : Date.now());

// ---------------------------------------------------------------------------------------------------------------
// Faddeeva function w(z), z = x + i y, y >= 0.
//   |x| <= asymU: Weideman (1994) rational approximation, N = 32, L = sqrt(N/sqrt 2); coefficients by the 2N-point
//                 DFT recipe, computed once here (the only module-level state).
//   |x| >  asymU: asymptotic series in complex z, w = (i/sqrt(pi)) (1/z)(1 + 1/(2z^2) + 3/(4z^4) + 15/(8z^6) + 105/(16z^8)).
//                 For small a its real part is the design's a/(sqrt(pi) x^2)(1 + 1.5/x^2 + 3.75/x^4); the complex
//                 form also stays accurate at a ~ 1 (the real-x form is off by a^2/x^2 there).
const WN = 32, WL = Math.sqrt(WN / Math.SQRT2);
const WA = (() => {
  const M = 2 * WN, f = new Float64Array(2 * M);
  for (let k = -M + 1; k <= M - 1; k++) { const t = WL * Math.tan(k * Math.PI / M / 2); f[k + M] = Math.exp(-t * t) * (WL * WL + t * t); }
  f[0] = 0;
  const fs = new Float64Array(2 * M); for (let j = 0; j < 2 * M; j++) fs[j] = f[(j + M) % (2 * M)];
  const a = new Float64Array(WN);
  for (let n = 1; n <= WN; n++) { let s = 0; for (let j = 0; j < 2 * M; j++) s += fs[j] * Math.cos(2 * Math.PI * j * n / (2 * M)); a[WN - n] = s / (2 * M); }
  return a;                                    // a[0] = a_N ... a[N-1] = a_1 (Horner order)
})();

// Writes [Re w, Im w, Re dw/dz, Im dw/dz] into out (Float64Array(4)).
function wofz4(x, y, out, asymU) {
  if (Math.abs(x) > asymU) {
    const d = x * x + y * y, zr = x / d, zi = -y / d;                 // 1/z
    const q2r = zr * zr - zi * zi, q2i = 2 * zr * zi;                 // 1/z^2
    // s = 1 + q2/2 + 3 q2^2/4 + 15 q2^3/8 + 105 q2^4/16 ;  w = (i/sqrt(pi)) z^-1 s
    const q4r = q2r * q2r - q2i * q2i, q4i = 2 * q2r * q2i, q6r = q4r * q2r - q4i * q2i, q6i = q4r * q2i + q4i * q2r;
    const q8r = q4r * q4r - q4i * q4i, q8i = 2 * q4r * q4i;
    const sr = 1 + 0.5 * q2r + 0.75 * q4r + 1.875 * q6r + 6.5625 * q8r, si = 0.5 * q2i + 0.75 * q4i + 1.875 * q6i + 6.5625 * q8i;
    const pr = zr * sr - zi * si, pi = zr * si + zi * sr;
    out[0] = -pi * ISQPI; out[1] = pr * ISQPI;
    // dw/dz = (i/sqrt(pi)) (-z^-2)(1 + 3/(2z^2) + 15/(4z^4) + 105/(8z^6) + 945/(16z^8))
    const tr = 1 + 1.5 * q2r + 3.75 * q4r + 13.125 * q6r + 59.0625 * q8r, ti = 1.5 * q2i + 3.75 * q4i + 13.125 * q6i + 59.0625 * q8i;
    const er = -(q2r * tr - q2i * ti), ei = -(q2r * ti + q2i * tr);
    out[2] = -ei * ISQPI; out[3] = er * ISQPI;
    return out;
  }
  const dr = WL + y, di = -x, nr = WL - y, ni = x;                     // L - i z, L + i z
  const den = dr * dr + di * di, Zr = (nr * dr + ni * di) / den, Zi = (ni * dr - nr * di) / den;
  let pr = 0, pi = 0;
  for (let k = 0; k < WN; k++) { const tr = pr * Zr - pi * Zi + WA[k], ti = pr * Zi + pi * Zr; pr = tr; pi = ti; }
  const ir = dr / den, ii = -di / den, i2r = ir * ir - ii * ii, i2i = 2 * ir * ii;
  const wr = 2 * (pr * i2r - pi * i2i) + ir * ISQPI, wi = 2 * (pr * i2i + pi * i2r) + ii * ISQPI;
  out[0] = wr; out[1] = wi;
  out[2] = -2 * (x * wr - y * wi); out[3] = -2 * (x * wi + y * wr) + 2 * ISQPI;   // dw/dz = -2 z w + 2i/sqrt(pi)
  return out;
}

export function faddeeva(x, y) {
  const o = wofz4(x, y, new Float64Array(4), FIT_PARAMS.asymU);
  return [o[0], o[1]];
}

// ---------------------------------------------------------------------------------------------------------------
// erf to ~1e-16 absolute: positive-term series below 3, erfc continued fraction (modified Lentz) above.
function erf(x) {
  const ax = Math.abs(x);
  if (ax < 3) {
    const x2 = ax * ax; let term = ax, s = ax;
    for (let n = 1; n < 200; n++) { term *= 2 * x2 / (2 * n + 1); s += term; if (term < 1e-17 * s) break; }
    const r = 2 * ISQPI * Math.exp(-x2) * s;
    return x < 0 ? -r : r;
  }
  if (ax > 27) return x < 0 ? -1 : 1;
  // erfc(x) = exp(-x^2)/sqrt(pi) * 1/(x + (1/2)/(x + 1/(x + (3/2)/(x + 2/(x + ...)))))
  const tiny = 1e-300; let f = ax, Cc = ax, D = 0;
  for (let n = 1; n < 500; n++) {
    const an = n / 2; D = ax + an * D; D = Math.abs(D) < tiny ? tiny : D; Cc = ax + an / Cc; Cc = Math.abs(Cc) < tiny ? tiny : Cc;
    D = 1 / D; const del = Cc * D; f *= del; if (Math.abs(del - 1) < 1e-16) break;
  }
  const r = 1 - Math.exp(-ax * ax) * ISQPI / f;
  return x < 0 ? -r : r;
}

const noLSF = R => !(R > 0) || !Number.isFinite(R);

// Pixel-integrated Gaussian LSF on a grid of step du (design-3 section 3.4 step 1). R none/0/inf -> [1].
export function lsfKernel(R, du) {
  if (noLSF(R)) return Float64Array.of(1);
  const sp = (C_KMS / R) * FWHM_TO_SIGMA / du, h = Math.max(1, Math.ceil(4 * sp)), k = new Float64Array(2 * h + 1), s2 = Math.SQRT2 * sp;
  let s = 0;
  for (let j = -h; j <= h; j++) { k[j + h] = 0.5 * (erf((j + 0.5) / s2) - erf((j - 0.5) / s2)); s += k[j + h]; }
  for (let j = 0; j < k.length; j++) k[j] /= s;
  return k;
}

// numpy float arange: length ceil((hi - lo)/step), v[i] = lo + i*delta with delta = (lo + step) - lo.
export function arange(lo, hi, step) {
  const M = Math.max(0, Math.ceil((hi - lo) / step)), v = new Float64Array(M);
  if (M > 0) v[0] = lo; if (M > 1) v[1] = lo + step;
  const d = (lo + step) - lo; for (let i = 2; i < M; i++) v[i] = lo + i * d;
  return v;
}

// Page noise generator (moved unchanged from the v1 page): mulberry32 + Box-Muller.
export function rng(seed) { let a = seed >>> 0; return () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ t >>> 15, t | 1); t ^= t + Math.imul(t ^ t >>> 7, t | 61); return ((t ^ t >>> 14) >>> 0) / 4294967296; }; }
export function gauss(r) { return Math.sqrt(-2 * Math.log(r() + 1e-12)) * Math.cos(2 * Math.PI * r()); }
// Noise seed of one (ion, case) panel: FNV-1a 32-bit of "<seed>|<ion>|<caseIndex>" (design-3 section 5.5).
export function seedFor(seed, ion, caseIndex) {
  const s = `${seed}|${ion}|${caseIndex}`; let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
  return h >>> 0;
}

// Interpolation brackets of x on the uniform fine grid V_i = V0 + i*du (i = 0..n-1), numpy.interp semantics:
// returns j (lower index) and t (weight of j+1), or j = -1 for x outside [V_0, V_{n-1}] (value 1 = continuum).
function bracket(x, V0, du, n, Vat) {
  const last = Vat(n - 1);
  if (!(x >= Vat(0)) || x > last) return [-1, 0];
  if (x === last || n === 1) return [Math.max(0, n - 2), n === 1 ? 0 : 1];
  let j = Math.floor((x - V0) / du); j = j < 0 ? 0 : j > n - 2 ? n - 2 : j;
  while (j > 0 && Vat(j) > x) j--;
  while (j < n - 2 && Vat(j + 1) <= x) j++;
  const a = Vat(j); return [j, (x - a) / (Vat(j + 1) - a)];
}

// Sampling plan for output velocities on a fine grid V (uniform): the unique fine indices U to convolve at and,
// per output pixel, the positions of its two brackets in U and the weight t of the upper one.
function makePlan(vOut, V) {
  const m = vOut.length, nf = V.length, du = nf > 1 ? V[1] - V[0] : 1, Vat = i => V[i];
  const raw = new Int32Array(m), t = new Float64Array(m), mark = new Uint8Array(nf);
  for (let k = 0; k < m; k++) { const [j, w] = bracket(vOut[k], V[0], du, nf, Vat); raw[k] = j; t[k] = w; if (j >= 0) { mark[j] = 1; if (j + 1 < nf) mark[j + 1] = 1; } }
  let nu = 0; for (let i = 0; i < nf; i++) nu += mark[i];
  const U = new Int32Array(nu), pos = new Int32Array(nf).fill(-1);
  for (let i = 0, q = 0; i < nf; i++) if (mark[i]) { U[q] = i; pos[i] = q++; }
  const lo = new Int32Array(m), hi = new Int32Array(m);
  for (let k = 0; k < m; k++) { const j = raw[k]; lo[k] = j < 0 ? -1 : pos[j]; hi[k] = j < 0 ? -1 : pos[j + 1 < nf ? j + 1 : j]; }
  return {U, lo, hi, t, m};
}

// Convolve g (length nf, edge-extend) with kernel k at the plan's fine indices, then interpolate onto the outputs.
function convSample(g, k, plan, out, fill = 1) {
  const h = (k.length - 1) >> 1, nf = g.length, U = plan.U, c = new Float64Array(U.length);
  for (let q = 0; q < U.length; q++) {
    const i = U[q]; let s = 0;
    if (i - h >= 0 && i + h < nf) { for (let j = 0, b = i - h; j < k.length; j++) s += k[j] * g[b + j]; }
    else { for (let j = -h; j <= h; j++) { let p = i + j; p = p < 0 ? 0 : p >= nf ? nf - 1 : p; s += k[j + h] * g[p]; } }
    c[q] = s;
  }
  for (let m = 0; m < plan.m; m++) { const a = plan.lo[m]; if (a < 0) { out[m] = fill; continue; } const t = plan.t[m]; out[m] = t === 0 ? c[a] : c[a] + (c[plan.hi[m]] - c[a]) * t; }
  return out;
}

// Degrade a decoded intrinsic line to (R, S/N) (design-3 sections 3.4 and 5.2). line = {n, u0, du, flux}.
// o = {vwin, vcenter, seed, pix}. Returns {v, flux (noisy, clipped at 0), model, sigma (per pixel)}.
export function degradeV(line, R, snr, vSys, o = {}) {
  const pix = o.pix ?? PIX_PER_RESEL, n = line.n, du = line.du, u0 = line.u0;
  const V = new Float64Array(n); for (let i = 0; i < n; i++) V[i] = (u0 + i * du) + vSys;
  const k = lsfKernel(R, du), dvPix = noLSF(R) ? du * pix : (C_KMS / R) / pix;
  let lo = V[0], hi = V[n - 1];
  if (o.vwin != null) { const vc = o.vcenter ?? 0; lo = vc - o.vwin; hi = vc + o.vwin; }
  const v = arange(lo, hi + dvPix, dvPix), plan = makePlan(v, V);
  const g = line.flux instanceof Float64Array ? line.flux : Float64Array.from(line.flux);
  const model = convSample(g, k, plan, new Float64Array(v.length), 1);
  const sigma = snr > 0 ? Math.sqrt(pix) / snr : 0, flux = new Float64Array(v.length);
  if (snr > 0) { const r = rng(o.seed ?? 0); for (let i = 0; i < v.length; i++) flux[i] = Math.max(0, model[i] + sigma * gauss(r)); }
  else for (let i = 0; i < v.length; i++) flux[i] = Math.max(0, model[i]);
  return {v, flux, model, sigma};
}

// ---------------------------------------------------------------------------------------------------------------
// TNGS web binaries, v1 (OVI, HILyb, CIII on a lambda grid) and v2 (keyed lines on 1 km/s grids), design-3 2.4.
// keys: optional list of known registry keys; without it any key of registry form is accepted. Unknown keys are
// skipped and reported in `skipped`.
export function decodeTNGS(arrayBuffer, keys = null) {
  const buf = arrayBuffer instanceof ArrayBuffer ? arrayBuffer : arrayBuffer.buffer;
  const off = arrayBuffer instanceof ArrayBuffer ? 0 : arrayBuffer.byteOffset, len = arrayBuffer.byteLength;
  const dv = new DataView(buf, off, len);
  if (len < 8 || String.fromCharCode(dv.getUint8(0), dv.getUint8(1), dv.getUint8(2), dv.getUint8(3)) !== "TNGS") throw new Error("not a TNGS sightline binary");
  const ver = dv.getUint8(4), nl = dv.getUint8(5), known = k => (keys ? keys.includes(k) : KEY_RE.test(k));
  const lines = {}, skipped = [];
  if (ver === 1) {
    const V1 = ["OVI", "HILyb", "CIII"]; if (nl !== 3) throw new Error(`TNGS v1: expected 3 lines, got ${nl}`);
    let o = 8;
    for (let l = 0; l < 3; l++) {
      if (o + 36 > len) throw new Error("truncated TNGS binary");
      const n = dv.getUint32(o, true), lam0 = dv.getFloat64(o + 4, true), dlg = dv.getFloat64(o + 12, true), rest = dv.getFloat64(o + 20, true); o += 36;
      if (o + 2 * n > len) throw new Error("truncated TNGS binary");
      const k = V1[l];
      if (k === "HILyb" || !known(k)) skipped.push(k);
      else { const flux = new Float64Array(n); for (let i = 0; i < n; i++) flux[i] = dv.getUint16(o + 2 * i, true) / 65535;
        lines[k] = {n, u0: C_KMS * (lam0 / rest - 1), du: C_KMS * dlg / rest, rest, flux}; }
      o += 2 * n;
    }
    if (o !== len) throw new Error("trailing bytes in TNGS binary");
    return {version: 1, vSys: null, skipped, lines};
  }
  if (ver !== 2) throw new Error("unsupported TNGS version " + ver);
  if (len < 16) throw new Error("truncated TNGS binary");
  if (nl < 1 || nl > 12) throw new Error(`TNGS v2: nlines ${nl} outside 1..12`);
  const vSys = dv.getFloat64(8, true); let o = 16;
  for (let l = 0; l < nl; l++) {
    if (o + 40 > len) throw new Error("truncated TNGS binary");
    let k = ""; for (let i = 0; i < 8; i++) { const c = dv.getUint8(o + i); if (c) k += String.fromCharCode(c); }
    const n = dv.getUint32(o + 8, true), u0 = dv.getFloat64(o + 16, true), du = dv.getFloat64(o + 24, true), rest = dv.getFloat64(o + 32, true);
    o += 40;
    if (o + 2 * n > len) throw new Error("truncated TNGS binary");
    if (k in lines || skipped.includes(k)) throw new Error(`duplicate line key ${k} in TNGS binary`);
    if (!known(k)) skipped.push(k);
    else { const flux = new Float64Array(n); for (let i = 0; i < n; i++) flux[i] = dv.getUint16(o + 2 * i, true) / 65535; lines[k] = {n, u0, du, rest, flux}; }
    o += 2 * n;
  }
  if (o !== len) throw new Error("trailing bytes in TNGS binary");
  return {version: 2, vSys, skipped, lines};
}

export function rowsToComps(rows, compKeys) {
  return (rows || []).map(r => Object.fromEntries(compKeys.map((k, i) => [k, r[i]])));
}

export function cacheKey(req) {
  return `${FIT_VERSION}|${req.id}|${req.ion}|${req.R}|${req.snr}|${req.seed}|${req.paramsTag}`;
}

// Half away from zero, as tngsight.vpfit.fmt_round.
function rnd(x, d) { if (x == null || !Number.isFinite(x)) return null; const s = 10 ** d; return Math.sign(x) * Math.floor(Math.abs(x) * s + 0.5) / s + 0; }

// Gaussian elimination with partial pivoting; A (array of Float64Array rows) and b are not modified. null if singular.
function solve(A, b, n) {
  const M = A.map(r => Float64Array.from(r)), x = Float64Array.from(b);
  for (let i = 0; i < n; i++) {
    let p = i; for (let r = i + 1; r < n; r++) if (Math.abs(M[r][i]) > Math.abs(M[p][i])) p = r;
    if (p !== i) { const t = M[i]; M[i] = M[p]; M[p] = t; const s = x[i]; x[i] = x[p]; x[p] = s; }
    if (!(Math.abs(M[i][i]) > 1e-300)) return null;
    for (let r = i + 1; r < n; r++) { const f = M[r][i] / M[i][i]; if (f === 0) continue; for (let c = i; c < n; c++) M[r][c] -= f * M[i][c]; x[r] -= f * x[i]; }
  }
  for (let i = n - 1; i >= 0; i--) { let s = x[i]; for (let c = i + 1; c < n; c++) s -= M[i][c] * x[c]; x[i] = s / M[i][i]; }
  for (let i = 0; i < n; i++) if (!Number.isFinite(x[i])) return null;
  return x;
}

// ---------------------------------------------------------------------------------------------------------------
// One fit window: fine sub-grid, data pixels, kernel, and the model/Jacobian operator.
function makeWindow(ctx, lo, hi, dataIdx) {
  const {line, vSys, k, kTau, a0, asymU} = ctx, h = (k.length - 1) >> 1, du = line.du, n = line.n, V0 = line.u0 + vSys;
  const i0 = Math.max(0, Math.floor((lo - V0) / du) - h - 2), i1 = Math.min(n - 1, Math.ceil((hi - V0) / du) + h + 2), nf = i1 - i0 + 1;
  const Vf = new Float64Array(nf); for (let i = 0; i < nf; i++) Vf[i] = (line.u0 + (i0 + i) * du) + vSys;
  const vd = Float64Array.from(dataIdx, m => ctx.data.v[m]), d = Float64Array.from(dataIdx, m => ctx.data.flux[m]);
  const plan = makePlan(vd, Vf), N = vd.length, sig = ctx.data.sigma, w4 = new Float64Array(4);
  const tauOne = (vc, lN, b, tau, D) => {                      // adds one component's tau; D = [dv, dlogN, db] columns or null
    const A = kTau * 10 ** lN, a = a0 / b, ib = 1 / b;
    for (let i = 0; i < nf; i++) {
      const x = (Vf[i] - vc) * ib; wofz4(x, a, w4, asymU);
      const H = w4[0], t = A * H * ib; tau[i] += t;
      if (D) { const Hu = w4[2], Ha = -w4[3]; D[0][i] = -A * Hu * ib * ib; D[1][i] = t * LN10; D[2][i] = -(A * ib * ib) * (H + x * Hu + a * Ha); }
    }
  };
  const W = {lo, hi, dataIdx, vd, d, N, nf, plan,
    tauComps(P) { const out = []; for (let c = 0; c < P.length / 3; c++) { const t = new Float64Array(nf); tauOne(P[3 * c], P[3 * c + 1], P[3 * c + 2], t, null); out.push(t); } return out; },
    fluxModel(tau) { const F = new Float64Array(nf); for (let i = 0; i < nf; i++) F[i] = Math.exp(-tau[i]); return convSample(F, k, plan, new Float64Array(N)); },
    model(P, wantJ) {
      const np = P.length, tau = new Float64Array(nf), D = wantJ ? Array.from({length: np}, () => new Float64Array(nf)) : null;
      for (let c = 0; c < np / 3; c++) tauOne(P[3 * c], P[3 * c + 1], P[3 * c + 2], tau, wantJ ? [D[3 * c], D[3 * c + 1], D[3 * c + 2]] : null);
      const F = new Float64Array(nf); for (let i = 0; i < nf; i++) F[i] = Math.exp(-tau[i]);
      const M = convSample(F, k, plan, new Float64Array(N));
      if (!wantJ) return {M};
      const J = D.map(col => { for (let i = 0; i < nf; i++) col[i] = -F[i] * col[i]; return convSample(col, k, plan, new Float64Array(N), 0); });
      return {M, J};
    },
    chi2(M) { let s = 0; for (let i = 0; i < N; i++) { const r = (d[i] - M[i]) / sig; s += r * r; } return s; },
  };
  return W;
}

// Levenberg-Marquardt with box bounds, design-3 section 5.3 step 4. Deterministic. One addition to the design text:
// parameters sitting on a bound with an outward gradient are dropped from that iteration's linear solve (active
// set). Plain clipping stalls on saturated components pinned at b_min (measured: 48/53 fixture cases reached the
// scipy trf chi^2 with clipping alone, 52/53 with the active set). The Python reference does the same.
function lm(W, P0, lb, ub, maxIt, prm, clock) {
  let P = Float64Array.from(P0), lam = prm.lambda0, {M, J} = W.model(P, true), c2 = W.chi2(M);
  const np = P.length, N = W.N, d = W.d;
  for (let it = 0; it < maxIt; it++) {
    if (clock.over()) break;
    const A = Array.from({length: np}, () => new Float64Array(np)), g = new Float64Array(np), r = new Float64Array(N);
    for (let i = 0; i < N; i++) r[i] = d[i] - M[i];
    for (let a = 0; a < np; a++) { const Ja = J[a]; let s = 0; for (let i = 0; i < N; i++) s += Ja[i] * r[i]; g[a] = s;
      for (let b = 0; b <= a; b++) { const Jb = J[b]; let t = 0; for (let i = 0; i < N; i++) t += Ja[i] * Jb[i]; A[a][b] = A[b][a] = t; } }
    // active set: a parameter on a bound whose gradient points outward is held fixed for this iteration
    const free = []; for (let i = 0; i < np; i++) if (!((P[i] <= lb[i] && g[i] < 0) || (P[i] >= ub[i] && g[i] > 0))) free.push(i);
    const nfr = free.length, Af = free.map(i => Float64Array.from(free, j => A[i][j])), gf = Float64Array.from(free, i => g[i]);
    let ok = false, rel = 1;
    for (let tr = 0; tr < prm.maxTries && nfr; tr++) {
      const B = Af.map((row, i) => { const q = Float64Array.from(row); q[i] += lam * Math.max(row[i], 1e-12); return q; });
      const dxf = solve(B, gf, nfr);
      if (!dxf) { lam *= 10; continue; }
      const dx = new Float64Array(np); for (let q = 0; q < nfr; q++) dx[free[q]] = dxf[q];
      const Pn = new Float64Array(np); for (let i = 0; i < np; i++) Pn[i] = Math.min(ub[i], Math.max(lb[i], P[i] + dx[i]));
      const cn = W.chi2(W.model(Pn, false).M);
      if (cn < c2) { rel = (c2 - cn) / c2; P = Pn; c2 = cn; lam = Math.max(lam / 10, prm.lambdaMin); ({M, J} = W.model(P, true)); ok = true; break; }
      lam *= 10;
    }
    if (!ok || rel < prm.relTol) break;
  }
  return {P, c2, M};
}

function dropComp(P, c) { const Q = new Float64Array(P.length - 3); for (let i = 0, q = 0; i < P.length; i++) if (Math.floor(i / 3) !== c) Q[q++] = P[i]; return Q; }

function covDiag(J, n, sig) {                                    // diag((J^T J / sigma^2)^-1), null if singular
  const A = Array.from({length: n}, (_, a) => Float64Array.from({length: n}, (_, b) => { let s = 0; const Ja = J[a], Jb = J[b]; for (let i = 0; i < Ja.length; i++) s += Ja[i] * Jb[i]; return s / (sig * sig); }));
  const out = new Float64Array(n);
  for (let c = 0; c < n; c++) { const e = new Float64Array(n); e[c] = 1; const x = solve(A, e, n); if (!x || !(x[c] >= 0)) return null; out[c] = Math.sqrt(x[c]); }
  return out;
}

// Merge seeds closer than mergeFrac * FWHM_eff by moment matching (design-3 section 5.3 step 2).
function mergeSeeds(sd, fw, frac) {
  let merged = true;
  while (merged && sd.length > 1) {
    merged = false;
    for (let i = 0; i + 1 < sd.length; i++) {
      const p = sd[i], q = sd[i + 1], fe = Math.sqrt(fw * fw + (1.665 * 0.5 * (p.b + q.b)) ** 2);
      if (q.v - p.v < frac * fe) {
        const N = p.N + q.N, v = (p.N * p.v + q.N * q.v) / N, s2 = (p.N * (p.b * p.b / 2 + (p.v - v) ** 2) + q.N * (q.b * q.b / 2 + (q.v - v) ** 2)) / N;
        sd.splice(i, 2, {v, N, b: Math.sqrt(2 * s2)}); merged = true; break;
      }
    }
  }
  return sd;
}

// Fit one displayed panel (design-3 sections 5.3 and 5.4). Synchronous. req.params may override FIT_PARAMS (tests).
export function fitPanel(req) {
  const t0 = now(), key = cacheKey(req);
  const base = {key, version: FIT_VERSION, comps: [], windows: [], chi2: 0, dof: 0, npix: 0, bic: 0, nfit: 0};
  try {
    const prm = {...FIT_PARAMS, ...(req.params || {})}, atom = req.atom, line = req.line, data = req.data;
    const nOut = data.v.length, model = new Float32Array(nOut).fill(1);
    const lamCm = atom.lam0_A * 1e-8, kTau = SIGMA0 * atom.f * lamCm / (SQPI * 1e5), a0 = atom.gamma_s * lamCm / (4 * Math.PI * 1e5);
    const lineF = {...line, flux: line.flux};
    const k = lsfKernel(req.R, line.du), fw = noLSF(req.R) ? 0 : C_KMS / req.R;
    const ctx = {line: lineF, vSys: req.vSys, k, kTau, a0, asymU: prm.asymU, data};
    const ck = req.compKeys || ["v", "dv", "logN", "dlogN", "b", "db", "region", "flag", "EW"];
    const iv = ck.indexOf("v"), iN = ck.indexOf("logN"), ib = ck.indexOf("b"), ir = ck.indexOf("region");
    const logNMax = atom.logN_max ?? 19, bMin = atom.b_min ?? 2;
    let budgetHit = false;
    const clock = {over: () => { if (!budgetHit && now() - t0 > prm.capMs) budgetHit = true; return budgetHit; }};
    // 1. windows from the aod regions that have seeds; overlapping windows merge with their seeds
    const pad = prm.padResel * fw + prm.padKms, byReg = new Map();
    for (const r of req.seeds || []) { const g = r[ir]; if (!byReg.has(g)) byReg.set(g, []); byReg.get(g).push(r); }
    let wins = [];
    for (const [g, vlo, vhi] of req.regions || []) if (byReg.has(g)) wins.push({lo: vlo - pad, hi: vhi + pad, region: g, rows: byReg.get(g).slice()});
    wins.sort((a, b) => a.lo - b.lo || a.region - b.region);
    const mw = [];
    for (const w of wins) { const last = mw[mw.length - 1]; if (last && w.lo <= last.hi) { last.hi = Math.max(last.hi, w.hi); last.region = Math.min(last.region, w.region); last.rows.push(...w.rows); } else mw.push(w); }
    wins = mw;
    const profiles = [], comps = [];
    let anyFit = false;
    for (const w of wins) {
      const idx = []; for (let m = 0; m < nOut; m++) { const x = data.v[m]; if (x >= w.lo && x <= w.hi) idx.push(m); }
      if (idx.length < 4) continue;
      const W = makeWindow(ctx, w.lo, w.hi, idx);
      // 2. seeds
      let sd = w.rows.map(r => ({v: r[iv], N: 10 ** Math.min(Math.max(r[iN], prm.logNMin), logNMax), b: Math.min(Math.max(r[ib], bMin), prm.bMax)})).sort((a, b) => a.v - b.v);
      sd = mergeSeeds(sd, fw, prm.mergeFrac);
      const P0 = [], lbF = [], ubF = [];
      for (const s of sd) {
        P0.push(Math.min(Math.max(s.v, w.lo), w.hi), Math.min(Math.max(Math.log10(s.N), prm.logNMin), logNMax), Math.min(Math.max(s.b, bMin), prm.bMax));
        lbF.push(w.lo, prm.logNMin, bMin); ubF.push(w.hi, logNMax, prm.bMax);
      }
      anyFit = true;
      // 4. LM
      let cur = lm(W, P0, lbF, ubF, prm.maxIt, prm, clock); base.nfit++;
      const lnN = Math.log(W.N), K = prm.bicK;
      // 5. pruning by delta BIC
      for (let pass = 0; pass < prm.maxPrunePasses && cur.P.length >= 6 && !clock.over(); pass++) {
        const nc = cur.P.length / 3, taus = W.tauComps(cur.P), tot = new Float64Array(W.nf);
        for (const t of taus) for (let i = 0; i < W.nf; i++) tot[i] += t[i];
        let bc = -1, bd = Infinity;
        for (let c = 0; c < nc; c++) { const t = new Float64Array(W.nf), tc = taus[c]; for (let i = 0; i < W.nf; i++) t[i] = tot[i] - tc[i];
          const dc = W.chi2(W.fluxModel(t)) - cur.c2; if (dc < bd) { bd = dc; bc = c; } }
        const Q = dropComp(cur.P, bc), g = lm(W, Q, lbF.slice(0, Q.length), ubF.slice(0, Q.length), prm.maxItPrune, prm, clock); base.nfit++;
        if (g.c2 + K * (nc - 1) * lnN <= cur.c2 + K * nc * lnN) cur = g; else break;
      }
      if (cur.P.length === 3 && !budgetHit) {
        let c0 = 0; for (let i = 0; i < W.N; i++) { const r = (W.d[i] - 1) / data.sigma; c0 += r * r; }
        if (c0 <= cur.c2 + K * lnN) { const one = new Float64Array(W.N).fill(1); cur = {P: new Float64Array(0), c2: c0, M: one}; }
      }
      const P = cur.P, nc = P.length / 3, M = nc ? W.model(P, false).M : new Float64Array(W.N).fill(1), c2 = W.chi2(M);
      for (let q = 0; q < W.N; q++) model[idx[q]] = M[q];
      const dof = W.N - 3 * nc;
      base.windows.push([w.lo, w.hi]); base.chi2 += c2; base.dof += dof; base.npix += W.N; base.bic += c2 + K * nc * lnN;
      if (!nc) continue;
      // 6. errors, 7. flags
      const err = covDiag(W.model(P, true).J, P.length, data.sigma), poor = c2 / Math.max(dof, 1) > prm.chi2nuPoor;
      const taus = W.tauComps(P);
      for (let c = 0; c < nc; c++) {
        const vc = P[3 * c], lN = P[3 * c + 1], b = P[3 * c + 2];
        let flag = 0, mn = Infinity;
        for (let q = 0; q < W.N; q++) if (W.vd[q] >= vc - b && W.vd[q] <= vc + b && M[q] < mn) mn = M[q];
        if (mn < SAT_FLUX) flag |= FLAGS.SAT;
        if (Math.min(vc - w.lo, w.hi - vc) < BOUND_TOL || Math.min(lN - prm.logNMin, logNMax - lN) < BOUND_TOL || Math.min(b - bMin, prm.bMax - b) < BOUND_TOL) flag |= FLAGS.BOUND;
        if (poor) flag |= FLAGS.POORFIT;
        const prof = new Float32Array(nOut).fill(1), Mc = W.fluxModel(taus[c]); for (let q = 0; q < W.N; q++) prof[idx[q]] = Mc[q];
        comps.push({c: {v: vc, dv: err ? err[3 * c] : null, logN: lN, dlogN: err ? err[3 * c + 1] : null, b, db: err ? err[3 * c + 2] : null, flag, region: w.region}, prof, P: [vc, lN, b]});
      }
    }
    if (!anyFit) return {...base, status: "no_seeds", ms: now() - t0, model, profiles: []};
    comps.sort((a, b) => a.c.v - b.c.v);
    // Display copies on the whole data grid (B_tune2 M2): `model` and `profiles` stay 1 outside the fit windows (the
    // fit's own operator, parity with tngsight.vpfit); `modelFull` and `profilesFull` evaluate every fitted component
    // over all pixels, so a broad component's wings run down to the continuum instead of stopping at a window edge.
    let modelFull = model, profilesFull = comps.map(x => x.prof);
    if (comps.length && nOut >= 2) {
      const all = Array.from({length: nOut}, (_, m) => m), WF = makeWindow(ctx, data.v[0], data.v[nOut - 1], all);
      const taus = WF.tauComps(Float64Array.from(comps.flatMap(x => x.P))), tot = new Float64Array(WF.nf);
      for (const t of taus) for (let i = 0; i < WF.nf; i++) tot[i] += t[i];
      modelFull = Float32Array.from(WF.fluxModel(tot)); profilesFull = taus.map(t => Float32Array.from(WF.fluxModel(t)));
    }
    for (const {c} of comps) { if (budgetHit) c.flag |= FLAGS.BUDGET;
      c.v = rnd(c.v, 2); c.dv = rnd(c.dv, 2); c.logN = rnd(c.logN, 3); c.dlogN = rnd(c.dlogN, 3); c.b = rnd(c.b, 2); c.db = rnd(c.db, 2); }
    return {...base, status: budgetHit ? "budget" : "ok", ms: now() - t0, comps: comps.map(x => x.c), model, profiles: comps.map(x => x.prof), modelFull, profilesFull};
  } catch (e) {
    return {...base, status: "error", message: String(e && e.message || e), ms: now() - t0, model: new Float32Array(0), profiles: []};
  }
}
