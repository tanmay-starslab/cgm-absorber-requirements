// CLOUDY c17.03 (FG11 UVB, GASS10 solar abundances) Line Emissivity Surface Brightness engine.
// Lazy-loads the 245,952-byte quantized 4D table data/cloudy_emissivity_z0.bin ONLY when Emission mode is activated
// (0 bytes added to initial first-frame load). Synthesizes a Uint8Array(N^3) 3D volume emissivity cube
// log10(epsilon [erg s^-1 cm^-3]) over [-48.0, -12.0] via exact trilinear interpolation in (log10 nH, log10 Z/Zsun, log10 T).

export const CLOUDY_LUT_URL = "data/cloudy_emissivity_z0.bin?v=20261124c";
export const CLOUDY_EPS_MIN = -48.0;
export const CLOUDY_EPS_MAX = -12.0;
// Float32 shift reference: encoding log10(eps) - (-25.0) maps [-48, -12] -> [-23, +13] so 10^(eps - ref)
// stays strictly inside normal IEEE-754 float32 range [1e-23, 1e+13] with zero underflow or overflow.
export const CLOUDY_EPS_REF = -25.0;
export const LOG10_4PI_ARCSEC2_PER_SR = 11.7280614585;
export const LOG10_CM_PER_KPC = 21.4893505383;
export const CLOUDY_DEFAULT_LINE = "Ha_6563";
export const CLOUDY_FALLBACK_LOGZ = -0.5;

export const CLOUDY_GRID = {
  nHMin: -7.0, nHMax: 4.0, nHLen: 56,
  ZMin: -3.0, ZMax: 1.0, ZLen: 6,
  TMin: 3.0, TMax: 9.0, TLen: 61,
};

export const CLOUDY_LINES = [
  {id: "Ha_6563", label: "Hα 6563 Å", short: "Hα", wave_A: 6562.81, band: "Optical", sb_range: [-21.5, -14.5], cmap: "magma"},
  {id: "Lya_1216", label: "Lyα 1216 Å", short: "Lyα", wave_A: 1215.67, band: "FUV", sb_range: [-21.0, -14.0], cmap: "magma"},
  {id: "OII_3727", label: "[O II] 3727/29 Å", short: "[O II]", wave_A: 3727.42, band: "Optical", sb_range: [-22.0, -15.0], cmap: "inferno"},
  {id: "OIII_5007", label: "[O III] 5007 Å", short: "[O III]", wave_A: 5006.84, band: "Optical", sb_range: [-22.0, -15.0], cmap: "viridis"},
  {id: "NII_6583", label: "[N II] 6583 Å", short: "[N II]", wave_A: 6583.45, band: "Optical", sb_range: [-22.5, -15.5], cmap: "magma"},
  {id: "MgII_2798", label: "Mg II 2796/03 Å", short: "Mg II", wave_A: 2798.0, band: "NUV", sb_range: [-22.5, -15.5], cmap: "inferno"},
  {id: "CIII_977", label: "C III 977 Å", short: "C III", wave_A: 977.02, band: "FUV", sb_range: [-22.5, -16.0], cmap: "viridis"},
  {id: "CIV_1548", label: "C IV 1548/51 Å", short: "C IV", wave_A: 1549.06, band: "FUV", sb_range: [-23.0, -16.5], cmap: "inferno"},
  {id: "OVI_1032", label: "O VI 1032/38 Å", short: "O VI", wave_A: 1033.82, band: "FUV", sb_range: [-23.0, -16.5], cmap: "inferno"},
  {id: "OVII_21.6", label: "O VII 21.6 Å", short: "O VII", wave_A: 21.602, band: "X-ray", sb_range: [-24.0, -17.5], cmap: "magma"},
  {id: "OVIII_18.97", label: "O VIII 18.97 Å", short: "O VIII", wave_A: 18.971, band: "X-ray", sb_range: [-24.0, -17.0], cmap: "magma"},
  {id: "FeXXV_1.85", label: "Fe XXV 1.85 Å", short: "Fe XXV", wave_A: 1.8504, band: "X-ray", sb_range: [-24.5, -16.5], cmap: "magma"},
];

export const CLOUDY_LINE_IDS = CLOUDY_LINES.map(l => l.id);
export const isCloudyLine = id => CLOUDY_LINE_IDS.includes(id);
export function cloudyLineMeta(id) {
  return CLOUDY_LINES.find(l => l.id === id) || CLOUDY_LINES[0];
}
export function cloudyLineIndex(id) {
  const idx = CLOUDY_LINES.findIndex(l => l.id === id);
  return idx >= 0 ? idx : 0;
}

// Constant additive offset in dex converting log10(integral(10^(logEps - REF) * ds_kpc))
// into log10(SB [erg s^-1 cm^-2 arcsec^-2]) at redshift z.
export function cloudySbOffset(z = 0) {
  const zp1 = Math.max(1.0, 1.0 + (Number.isFinite(+z) ? +z : 0));
  return CLOUDY_EPS_REF + LOG10_CM_PER_KPC - LOG10_4PI_ARCSEC2_PER_SR - 4.0 * Math.log10(zp1);
}

const EXPECTED_BYTES = CLOUDY_LINES.length * CLOUDY_GRID.nHLen * CLOUDY_GRID.ZLen * CLOUDY_GRID.TLen;
let _lutCache = null;
let _lutPromise = null;

export function setCloudyLut(bytes) {
  if (!(bytes instanceof Uint8Array) || bytes.length !== EXPECTED_BYTES) {
    throw new Error(`Invalid CLOUDY LUT size: expected ${EXPECTED_BYTES}, got ${bytes?.length}`);
  }
  _lutCache = bytes;
  return _lutCache;
}

export async function loadCloudyLut(url = CLOUDY_LUT_URL) {
  if (_lutCache) return _lutCache;
  if (!_lutPromise) {
    _lutPromise = (async () => {
      const resp = await fetch(url);
      if (!resp.ok) throw new Error(`CLOUDY LUT HTTP ${resp.status}`);
      const buf = new Uint8Array(await resp.arrayBuffer());
      if (buf.length !== EXPECTED_BYTES) throw new Error(`CLOUDY LUT truncated: ${buf.length} != ${EXPECTED_BYTES}`);
      _lutCache = buf;
      return _lutCache;
    })().catch(err => { _lutPromise = null; throw err; });
  }
  return _lutPromise;
}

function axisInterp(val, min, max, len) {
  const u = (val - min) / (max - min) * (len - 1);
  if (u <= 0) return [0, 0, 0];
  if (u >= len - 1) return [len - 1, len - 1, 0];
  const i0 = u | 0;
  return [i0, i0 + 1, u - i0];
}

// Exact trilinear interpolation in (log10 nH, log10 Z/Zsun, log10 T) returning log10(epsilon [erg s^-1 cm^-3]) or -Infinity.
export function sampleCloudyLogEps(lut, lineIdOrIdx, logNH, logZ, logT) {
  const li = typeof lineIdOrIdx === "number" ? lineIdOrIdx : cloudyLineIndex(lineIdOrIdx);
  const {nHMin, nHMax, nHLen, ZMin, ZMax, ZLen, TMin, TMax, TLen} = CLOUDY_GRID;
  const [n0, n1, fn] = axisInterp(logNH, nHMin, nHMax, nHLen);
  const [z0, z1, fz] = axisInterp(logZ, ZMin, ZMax, ZLen);
  const [t0, t1, ft] = axisInterp(logT, TMin, TMax, TLen);
  const sT = 1, sZ = TLen, sN = ZLen * TLen, base = li * nHLen * sN;
  const at = (inH, iZ, iT) => lut[base + inH * sN + iZ * sZ + iT * sT];
  const c000 = at(n0, z0, t0), c001 = at(n0, z0, t1);
  const c010 = at(n0, z1, t0), c011 = at(n0, z1, t1);
  const c100 = at(n1, z0, t0), c101 = at(n1, z0, t1);
  const c110 = at(n1, z1, t0), c111 = at(n1, z1, t1);
  if ((c000 | c001 | c010 | c011 | c100 | c101 | c110 | c111) === 0) return -Infinity;
  const q =
    (1 - fn) * ((1 - fz) * ((1 - ft) * c000 + ft * c001) + fz * ((1 - ft) * c010 + ft * c011)) +
    fn * ((1 - fz) * ((1 - ft) * c100 + ft * c101) + fz * ((1 - ft) * c110 + ft * c111));
  if (q < 0.5) return -Infinity;
  return CLOUDY_EPS_MIN + (q - 1.0) * (CLOUDY_EPS_MAX - CLOUDY_EPS_MIN) / 254.0;
}

// Synthesize a Uint8Array(N^3) 3D volume emissivity cube quantized over [CLOUDY_EPS_MIN, CLOUDY_EPS_MAX].
// Separates 3D trilinear interpolation into a precomputed 6 x 256 x 256 bilinear (nH, T) table per Z grid node,
// followed by a single linear Z interpolation per voxel (exact to trilinear, ~30-50 ms for 256^3).
export function computeCloudyEmissivityCube(lineId, rawCubes, ranges, lut = _lutCache) {
  if (!lut) throw new Error("CLOUDY LUT not loaded; call loadCloudyLut() first");
  const t0 = performance.now();
  const li = cloudyLineIndex(lineId);
  const {nHMin, nHMax, nHLen, ZMin, ZMax, ZLen, TMin, TMax, TLen} = CLOUDY_GRID;
  const sZ = TLen, sN = ZLen * TLen, base = li * nHLen * sN;

  const qN = rawCubes.nH, qT = rawCubes.T, qZ = rawCubes.Z || null;
  const N = qN.length, out = new Uint8Array(N);

  const nI0 = new Uint16Array(256), nI1 = new Uint16Array(256), nF = new Float32Array(256);
  const tI0 = new Uint16Array(256), tI1 = new Uint16Array(256), tF = new Float32Array(256);
  const [nLo, nHi] = ranges.nH, [tLo, tHi] = ranges.T;
  const nStep = (nHi - nLo) / 254.0, tStep = (tHi - tLo) / 254.0;
  for (let i = 1; i < 256; i++) {
    const [a0, a1, fa] = axisInterp(nLo + (i - 1) * nStep, nHMin, nHMax, nHLen);
    nI0[i] = a0; nI1[i] = a1; nF[i] = fa;
    const [b0, b1, fb] = axisInterp(tLo + (i - 1) * tStep, TMin, TMax, TLen);
    tI0[i] = b0; tI1[i] = b1; tF[i] = fb;
  }

  // Fallback solar-relative metallicity log10(Z/Zsun) = -0.5 when Z cube is absent or voxel has qZ == 0
  const [fbZ0, fbZ1, fbFz] = axisInterp(CLOUDY_FALLBACK_LOGZ, ZMin, ZMax, ZLen);

  if (!qZ || !ranges.Z) {
    const tbl = new Uint8Array(65536);
    for (let iq = 1; iq < 256; iq++) {
      const a0 = nI0[iq] * sN, a1 = nI1[iq] * sN, fa = nF[iq], fa1 = 1 - fa;
      for (let jq = 1; jq < 256; jq++) {
        const b0 = tI0[jq], b1 = tI1[jq], fb = tF[jq], fb1 = 1 - fb;
        const c000 = lut[base + a0 + fbZ0 * sZ + b0], c001 = lut[base + a0 + fbZ0 * sZ + b1];
        const c010 = lut[base + a0 + fbZ1 * sZ + b0], c011 = lut[base + a0 + fbZ1 * sZ + b1];
        const c100 = lut[base + a1 + fbZ0 * sZ + b0], c101 = lut[base + a1 + fbZ0 * sZ + b1];
        const c110 = lut[base + a1 + fbZ1 * sZ + b0], c111 = lut[base + a1 + fbZ1 * sZ + b1];
        if ((c000 | c001 | c010 | c011 | c100 | c101 | c110 | c111) === 0) continue;
        const v0 = fa1 * (fb1 * c000 + fb * c001) + fa * (fb1 * c100 + fb * c101);
        const v1 = fa1 * (fb1 * c010 + fb * c011) + fa * (fb1 * c110 + fb * c111);
        const q = v0 + fbFz * (v1 - v0);
        tbl[(iq << 8) | jq] = q < 0.5 ? 0 : q > 255 ? 255 : Math.round(q);
      }
    }
    for (let i = 0; i < N; i++) out[i] = tbl[(qN[i] << 8) | qT[i]];
    return {data: out, vmin: CLOUDY_EPS_MIN, vmax: CLOUDY_EPS_MAX, ms: performance.now() - t0};
  }

  // Z cube present: precompute 6 bilinear (nH, T) slices, one per Z grid point
  const sliceZ = new Float32Array(ZLen * 65536);
  for (let iz = 0; iz < ZLen; iz++) {
    const zOff = base + iz * sZ, sOff = iz * 65536;
    for (let iq = 1; iq < 256; iq++) {
      const a0 = zOff + nI0[iq] * sN, a1 = zOff + nI1[iq] * sN, fa = nF[iq], fa1 = 1 - fa;
      const row = sOff + (iq << 8);
      for (let jq = 1; jq < 256; jq++) {
        const b0 = tI0[jq], b1 = tI1[jq], fb = tF[jq], fb1 = 1 - fb;
        sliceZ[row | jq] =
          fa1 * (fb1 * lut[a0 + b0] + fb * lut[a0 + b1]) +
          fa * (fb1 * lut[a1 + b0] + fb * lut[a1 + b1]);
      }
    }
  }

  const zJ0 = new Int32Array(256), zJ1 = new Int32Array(256), zF = new Float32Array(256);
  zJ0[0] = fbZ0 * 65536; zJ1[0] = fbZ1 * 65536; zF[0] = fbFz;
  const [zLo, zHi] = ranges.Z, zStep = (zHi - zLo) / 254.0;
  for (let i = 1; i < 256; i++) {
    const [j0, j1, fz] = axisInterp(zLo + (i - 1) * zStep, ZMin, ZMax, ZLen);
    zJ0[i] = j0 * 65536; zJ1[i] = j1 * 65536; zF[i] = fz;
  }

  for (let i = 0; i < N; i++) {
    const qn = qN[i], qt = qT[i];
    if (!(qn && qt)) continue;
    const idx = (qn << 8) | qt, qz = qZ[i];
    const v0 = sliceZ[zJ0[qz] + idx];
    const v1 = sliceZ[zJ1[qz] + idx];
    const q = v0 + zF[qz] * (v1 - v0);
    if (q >= 0.5) out[i] = q > 255 ? 255 : (q + 0.5) | 0;
  }
  return {data: out, vmin: CLOUDY_EPS_MIN, vmax: CLOUDY_EPS_MAX, ms: performance.now() - t0};
}
