/* Legacy v1 degrade port (TNGS v1: OVI, HILyb, CIII), retired from docs/tng50/_template.html in Phase 3: the page now
   degrades with js/fit.js degradeV (checked by fit_degrade.mjs). Kept here, outside the page, only so degrade_parity.mjs
   keeps proving the shared numerics (astropy kernel, numpy arange/interp, noise) against tngsight.degrade. Evaluated by
   degrade_parity.mjs with new Function(src + 'return TNG;'); it defines one const, TNG, and touches no DOM. */
/* Port of tngsight.degrade (noiseless model) + web-binary decoder. No DOM: tests/js/degrade_parity.mjs evals this block.
   Model: astropy Gaussian1DKernel(sigma) ('center' mode: size ceil(8 sigma) rounded up to odd, point-sampled, normalised),
   convolve(boundary='extend', normalize_kernel=True), numpy arange + interp(left=right=1). Noise: mulberry32 + Box-Muller. */
const TNG = (() => {
  const C_KMS = 299792.458, DLAMBDA = 0.002, PIX_PER_RESEL = 5, FWHM_TO_SIGMA = 1 / 2.35482, VSYS_SIGN = +1;
  const LINE_KEYS = ["OVI", "HILyb", "CIII"];
  const noLSF = R => !(R > 0) || !Number.isFinite(R);       // R None/0/inf => no LSF (tngsight contract)
  function gaussKernel(sigma) {
    let n = Math.ceil(8 * sigma); if (n % 2 === 0) n += 1;
    const h = (n - 1) / 2, amp = 1 / (Math.sqrt(2 * Math.PI) * sigma), k = new Float64Array(n); let s = 0;
    for (let j = 0; j < n; j++) { const x = j - h; k[j] = amp * Math.exp(-0.5 * x * x / (sigma * sigma)); s += k[j]; }
    for (let j = 0; j < n; j++) k[j] /= s;
    return k;
  }
  function convolveExtend(f, k) {                            // pad with edge values, direct sum, divide by kernel sum
    const N = f.length, n = k.length, h = (n - 1) >> 1, out = new Float64Array(N); let ks = 0;
    for (let j = 0; j < n; j++) ks += k[j];
    for (let i = 0; i < N; i++) { let acc = 0;
      for (let j = 0; j < n; j++) { let q = i + h - j; q = q < 0 ? 0 : q >= N ? N - 1 : q; acc += k[j] * f[q]; }
      out[i] = acc / ks; }
    return out;
  }
  function arange(start, stop, step) {                       // numpy float arange: len ceil((stop-start)/step), start + i*delta
    const M = Math.max(0, Math.ceil((stop - start) / step)), v = new Float64Array(M);
    if (M > 0) v[0] = start; if (M > 1) v[1] = start + step;
    const d = (start + step) - start; for (let i = 2; i < M; i++) v[i] = start + i * d;
    return v;
  }
  function interp(x, xp, fp, left, right) {                  // numpy.interp, xp increasing
    const n = xp.length, out = new Float64Array(x.length), x0 = xp[0], xl = xp[n - 1];
    for (let i = 0; i < x.length; i++) { const xv = x[i];
      if (Number.isNaN(xv)) { out[i] = xv; continue; }
      if (xv > xl) { out[i] = right; continue; } if (xv < x0) { out[i] = left; continue; }
      if (xv === xl) { out[i] = fp[n - 1]; continue; }
      let lo = 0, hi = n - 1; while (hi - lo > 1) { const m = (lo + hi) >> 1; if (xp[m] <= xv) lo = m; else hi = m; }
      if (xp[lo] === xv) { out[i] = fp[lo]; continue; }
      const sl = (fp[lo + 1] - fp[lo]) / (xp[lo + 1] - xp[lo]); let r = sl * (xv - xp[lo]) + fp[lo];
      if (Number.isNaN(r)) { r = sl * (xv - xp[lo + 1]) + fp[lo + 1]; if (Number.isNaN(r) && fp[lo] === fp[lo + 1]) r = fp[lo]; }
      out[i] = r; }
    return out;
  }
  function median(a) { const s = Float64Array.from(a).sort(), n = s.length, h = n >> 1; return n % 2 ? s[h] : 0.5 * (s[h - 1] + s[h]); }
  function velocityAxis(lam, rest, vSys) { const v = new Float64Array(lam.length);
    for (let i = 0; i < lam.length; i++) v[i] = C_KMS * (lam[i] / rest - 1.0) + VSYS_SIGN * vSys; return v; }
  /* noiseless model; flux = exp(-tau) on the native grid. Returns {v, model (clipped >= 0), raw (unclipped), vHi, fLsf} */
  function degradeModel(lam, flux, rest, R, vSys, o = {}) {
    const dlam = o.dlam ?? DLAMBDA, pix = o.pix ?? PIX_PER_RESEL, vwin = o.vwin ?? null;
    let fLsf, dvResel;
    if (noLSF(R)) { fLsf = Float64Array.from(flux);
      const d = new Float64Array(lam.length - 1); for (let i = 0; i < d.length; i++) d[i] = Math.abs(C_KMS * (lam[i + 1] / rest - 1) - C_KMS * (lam[i] / rest - 1));
      dvResel = median(d) * pix;
    } else { const sig = (rest / R) * FWHM_TO_SIGMA / dlam; fLsf = convolveExtend(flux, gaussKernel(Math.max(sig, 1e-3))); dvResel = C_KMS / R; }
    const dvPix = dvResel / pix, vHi = velocityAxis(lam, rest, vSys);
    let vlo = -vwin, vhi = vwin;
    if (vwin === null) { vlo = Infinity; vhi = -Infinity; for (const x of vHi) { if (x < vlo) vlo = x; if (x > vhi) vhi = x; } }
    const v = arange(vlo, vhi + dvPix, dvPix), raw = interp(v, vHi, fLsf, 1.0, 1.0), model = raw.map(x => x < 0 ? 0 : x);
    return {v, model, raw, vHi, fLsf, dvPix};
  }
  function rng(seed) { let a = seed >>> 0; return () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ t >>> 15, t | 1); t ^= t + Math.imul(t ^ t >>> 7, t | 61); return ((t ^ t >>> 14) >>> 0) / 4294967296; }; }
  function gauss(r) { return Math.sqrt(-2 * Math.log(r() + 1e-12)) * Math.cos(2 * Math.PI * r()); }
  function addNoise(raw, snr, seed, pix = PIX_PER_RESEL) {   // per-pixel sigma = sqrt(pix)/snr, clipped at 0 from below
    const out = Float64Array.from(raw); if (!(snr > 0)) { for (let i = 0; i < out.length; i++) out[i] = Math.max(0, out[i]); return out; }
    const r = rng(seed), s = Math.sqrt(pix) / snr; for (let i = 0; i < out.length; i++) out[i] = Math.max(0, raw[i] + s * gauss(r));
    return out;
  }
  function degrade(lam, flux, rest, R, snr, vSys, o = {}) {
    const m = degradeModel(lam, flux, rest, R, vSys, o); return {v: m.v, noisy: addNoise(m.raw, snr, o.seed ?? 0, o.pix ?? PIX_PER_RESEL), model: m.model};
  }
  /* web binary (design §4): "TNGS", u8 ver, u8 nlines, u16 0, per line u32 n, f64 lam0, f64 dlam_grid, f64 rest, f64 dlam_lsf, n x u16 */
  function decodeWeb(buf, keys = LINE_KEYS) {
    const dv = new DataView(buf instanceof ArrayBuffer ? buf : buf.buffer, buf.byteOffset || 0, buf.byteLength);
    if (String.fromCharCode(dv.getUint8(0), dv.getUint8(1), dv.getUint8(2), dv.getUint8(3)) !== "TNGS") throw new Error("not a TNGS sightline binary");
    const ver = dv.getUint8(4), nl = dv.getUint8(5); if (ver !== 1) throw new Error("unsupported TNGS version " + ver);
    if (nl !== keys.length) throw new Error(`expected ${keys.length} lines, got ${nl}`);
    let o = 8; const lines = {};
    for (const k of keys) {
      const n = dv.getUint32(o, true), lam0 = dv.getFloat64(o + 4, true), dlg = dv.getFloat64(o + 12, true),
        rest = dv.getFloat64(o + 20, true), dlam = dv.getFloat64(o + 28, true); o += 36;
      if (o + 2 * n > dv.byteLength) throw new Error("truncated TNGS binary");
      const lam = new Float64Array(n), flux = new Float64Array(n);
      for (let i = 0; i < n; i++) { lam[i] = Math.fround(lam0 + i * dlg); flux[i] = dv.getUint16(o + 2 * i, true) / 65535; }   // float32 grid, as in the npz
      o += 2 * n; lines[k] = {n, lam0, dlamGrid: dlg, rest, dlam, lam, flux};
    }
    return {version: ver, lines};
  }
  return {C_KMS, DLAMBDA, PIX_PER_RESEL, FWHM_TO_SIGMA, VSYS_SIGN, LINE_KEYS, gaussKernel, convolveExtend, arange, interp, median,
    velocityAxis, degradeModel, addNoise, degrade, rng, gauss, decodeWeb};
})();
