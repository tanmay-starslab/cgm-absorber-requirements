// Zero-storage TEMET thermodynamic fields synthesized on-the-fly in Float32/Uint8 from already-hosted nH, T, Z,
// and (vx, vy, vz) 3D cubes (L0..L4). Kept separate from vizdata.js so the explainer first-frame shell stays lean.
import {velocityInfo} from "./vizdata.js";

export const TEMET_FIELDS = [
  {key: "Pth", label: "Pth", spoken: "thermal pressure", html: "P<sub>th</sub>", long: "thermal pressure Pth / kB = 2.3 nH T",
    units: "K cm^-3", kind: "mass_weighted", vmin: -3.0, vmax: 8.0, cmap: "inferno",
    proj: {kind: "weighted_mean", vmin: 1.0, vmax: 5.5, units: "K cm^-3"}, vol_window: [1.0, 5.5], deps: ["nH", "T"]},
  {key: "K", label: "K", spoken: "adiabatic entropy", html: "K", long: "adiabatic entropy K = kB T / (1.16 nH)^(2/3)",
    units: "keV cm^2", kind: "mass_weighted", vmin: -4.0, vmax: 5.0, cmap: "viridis",
    proj: {kind: "weighted_mean", vmin: 0.0, vmax: 3.0, units: "keV cm^2"}, vol_window: [0.0, 3.0], deps: ["nH", "T"]},
  {key: "EM", label: "EM", spoken: "emission measure", html: "EM", long: "X-ray and cooling emission measure nH^2 T^(1/2)",
    units: "cm^-6 K^1/2", kind: "density", vmin: -12.0, vmax: 6.0, cmap: "magma",
    proj: {kind: "column", vmin: 15.5, vmax: 22.5, units: "cm^-5 K^1/2"}, vol_window: [-6.0, 1.0], deps: ["nH", "T"]},
  {key: "tcool", label: "tcool", spoken: "radiative cooling time", html: "t<sub>cool</sub>", long: "radiative cooling time from Wiersma and Sutherland-Dopita cooling",
    units: "Gyr", kind: "mass_weighted", vmin: -6.0, vmax: 4.0, cmap: "cividis",
    proj: {kind: "weighted_mean", vmin: -2.0, vmax: 2.0, units: "Gyr"}, vol_window: [-2.0, 2.0], deps: ["nH", "T"], optDeps: ["Z"]},
  {key: "Mach", label: "Mach", spoken: "thermal Mach number", html: "Mach", long: "thermal Mach number |v| / cs(T)",
    units: "", kind: "mass_weighted", vmin: -2.5, vmax: 2.5, cmap: "inferno",
    proj: {kind: "weighted_mean", vmin: -1.0, vmax: 1.2, units: ""}, vol_window: [-1.0, 1.2], deps: ["T", "vx", "vy", "vz"]},
];
export const TEMET_KEYS = TEMET_FIELDS.map(x => x.key);
export const isTemetKey = k => TEMET_KEYS.includes(k);

const temetOk = (f, m) => !!m && f.deps.every(d => !!m.gas?.fields?.[d]?.cubes) && (!f.deps.includes("vx") || !!velocityInfo(m));

export function temetFieldMeta(key, manifest = null) {
  const f = TEMET_FIELDS.find(x => x.key === key);
  if (!f) return null;
  if (!temetOk(f, manifest)) return {...f, cubes: null};
  const F = manifest.gas.fields, bc = F[f.deps[0]].cubes, cubes = {};
  for (const L of Object.keys(bc)) if (f.deps.every(d => !!F[d]?.cubes?.[L])) cubes[L] = bc[L];
  return {...f, cubes: Object.keys(cubes).length ? cubes : null};
}

export function temetList(manifest) {
  const F = manifest?.gas?.fields || {};
  return TEMET_FIELDS.map(x => {
    const ok = temetOk(x, manifest);
    const reason = ok ? "" : !manifest ? "no 3D data in this build"
      : x.deps.includes("vx") && !velocityInfo(manifest) ? "the velocity cubes are not built yet"
      : `requires ${x.deps.filter(d => !F[d]?.cubes).join(" and ")} cubes`;
    return {...x, group: "temet", color: null, color_dark: null, available: ok, reason};
  });
}

/* Fast analytic Wiersma (2009) / Sutherland-Dopita (1993) CIE cooling function Lambda(T, Z) [erg cm^3 s^-1]. */
export function coolingLambda(logT, Zsun = 0.3) {
  const cut = logT < 4.0 ? Math.pow(10, Math.max(-18, 6.0 * (logT - 4.0))) : 1.0;
  const g = (u, s) => { const d = (logT - u) / s; return Math.exp(-d * d); };
  const lamHHe = (1.6e-22 * g(4.22, 0.16) + 6.5e-23 * g(4.92, 0.22) + 2.2e-27 * Math.pow(10, 0.5 * logT)) * cut;
  const lamZ = (6.0e-22 * g(5.25, 0.42) + 1.4e-22 * g(6.10, 0.35)) * cut + 3.0e-24 * g(3.70, 0.70);
  return Math.max(1e-28, lamHHe + Math.max(0, Zsun) * lamZ);
}

const L23 = Math.log10(2.3);
const LK = Math.log10(8.617333262e-8) - (2 / 3) * Math.log10(1.16);
const LTC = Math.log10(3.45 * 1.380649e-16 / 3.15576e16);
const LCS = Math.log10(15.1);

export function computeTemetCube(key, rawCubes, ranges) {
  const f = TEMET_FIELDS.find(x => x.key === key);
  if (!f) throw new Error(`unknown TEMET field ${key}`);
  const t0 = performance.now(), {vmin, vmax} = f, inv = 254 / (vmax - vmin);
  const cq = q => (q < 1 ? 1 : q > 255 ? 255 : q);
  const lut1 = ([a, b]) => { const o = new Float32Array(256), s = (b - a) / 254; o[0] = NaN; for (let i = 1; i < 256; i++) o[i] = a + (i - 1) * s; return o; };
  const qT = rawCubes.T, N = qT.length, out = new Uint8Array(N), lT = lut1(ranges.T);
  if (key === "Mach") {
    const qx = rawCubes.vx, qy = rawCubes.vy, qz = rawCubes.vz, V = ranges.velV;
    const lV2 = new Float32Array(256), csO = new Float32Array(256), sv = (2 * V) / 254;
    for (let i = 1; i < 256; i++) { const vv = -V + (i - 1) * sv; lV2[i] = vv * vv; csO[i] = (LCS + 0.5 * (lT[i] - 4.0) + vmin) * inv - 1.5; }
    const f32 = new Float32Array(1), u32 = new Uint32Array(f32.buffer), k2 = 0.5 * Math.LOG10E * Math.LN2 * inv, mL = new Float32Array(1024);
    for (let m = 0; m < 1024; m++) mL[m] = Math.log2(1 + (m + 0.5) / 1024) * k2;
    for (let i = 0; i < N; i++) {
      const qt = qT[i], ax = qx[i], ay = qy[i], az = qz[i]; if (!(qt && ax && ay && az)) continue;
      const v2 = lV2[ax] + lV2[ay] + lV2[az]; if (v2 <= 1e-12) { out[i] = 1; continue; }
      f32[0] = v2; const b = u32[0];
      out[i] = cq(((((b >>> 23) & 0xff) - 127) * k2 + mL[(b >>> 13) & 1023] - csO[qt]) | 0);
    }
  } else {
    const qN = rawCubes.nH, lN = lut1(ranges.nH);
    if (key === "tcool") {
      const qZ = rawCubes.Z, zL = new Float32Array(256).fill(0.3), nO = new Float32Array(256), bTZ = new Float32Array(65536);
      if (qZ && ranges.Z) { const lZ = lut1(ranges.Z); for (let i = 1; i < 256; i++) zL[i] = 10 ** lZ[i]; }
      for (let i = 1; i < 256; i++) nO[i] = (lN[i] + vmin) * inv - 1.5;
      for (let i = 1; i < 256; i++) for (let j = 0; j < 256; j++) bTZ[(i << 8) | j] = (LTC + lT[i] - Math.log10(coolingLambda(lT[i], zL[j]))) * inv;
      for (let i = 0; i < N; i++) { const qn = qN[i], qt = qT[i]; if (qn && qt) out[i] = cq((bTZ[(qt << 8) | (qZ ? qZ[i] : 0)] - nO[qn]) | 0); }
    } else {
      const tbl = new Uint8Array(65536);
      for (let i = 1; i < 256; i++) for (let j = 1; j < 256; j++)
        tbl[(i << 8) | j] = cq(Math.round(((key === "Pth" ? L23 + lN[i] + lT[j] : key === "K" ? lT[j] - (2 / 3) * lN[i] + LK : 2 * lN[i] + 0.5 * lT[j]) - vmin) * inv) + 1);
      for (let i = 0; i < N; i++) out[i] = tbl[(qN[i] << 8) | qT[i]];
    }
  }
  return {data: out, vmin, vmax, ms: performance.now() - t0};
}
