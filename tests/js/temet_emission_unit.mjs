// Unit tests for Zero-Storage TEMET Thermodynamic Fields (temet.js) and CLOUDY c17.03 Line Emissivity SB Mode (cloudy_emissivity.js + raymarch.js + viewer3d.js).
import {readFileSync} from "node:fs";
import {join, dirname} from "node:path";
import {fileURLToPath} from "node:url";
import {TEMET_FIELDS, TEMET_KEYS, isTemetKey, temetList, temetFieldMeta, coolingLambda, computeTemetCube} from "../../docs/tng50/js/temet.js";
import {CLOUDY_LINES, CLOUDY_DEFAULT_LINE, CLOUDY_EPS_MIN, CLOUDY_EPS_MAX, CLOUDY_EPS_REF,
  cloudyLineMeta, cloudySbOffset, setCloudyLut, sampleCloudyLogEps, computeCloudyEmissivityCube} from "../../docs/tng50/js/cloudy_emissivity.js";
import {decodeU8, encodeLinear} from "../../docs/tng50/js/vizdata.js";
import {FRAG, applyEmissionMode} from "../../docs/tng50/js/raymarch.js";

const HERE = dirname(fileURLToPath(import.meta.url)), ROOT = join(HERE, "../..");
let fails = 0; const check = (ok, msg) => { console.log(`${ok ? "ok  " : "FAIL"} ${msg}`); if (!ok) fails++; };

const encLog = (vals, lo, hi) => {
  const out = new Uint8Array(vals.length), inv = 254 / (hi - lo);
  for (let i = 0; i < vals.length; i++) {
    if (!Number.isFinite(vals[i])) { out[i] = 0; continue; }
    const q = Math.round((vals[i] - lo) * inv) + 1;
    out[i] = q < 1 ? 1 : q > 255 ? 255 : q;
  }
  return out;
};

/* ---- 1. Metadata and manifest availability ---- */
check(TEMET_KEYS.join(",") === "Pth,K,EM,tcool,Mach" && TEMET_FIELDS.length === 5, `TEMET_KEYS: ${TEMET_KEYS.join(",")}`);
check(TEMET_KEYS.every(isTemetKey) && !isTemetKey("nH") && !isTemetKey("vlos"), "isTemetKey distinguishes TEMET keys");
const M = JSON.parse(readFileSync(join(ROOT, "docs/tng50/data/viz/manifest_v2.json"), "utf8"));
{
  const listNoVel = temetList(M);
  check(listNoVel.length === 5 && listNoVel.every(x => x.group === "temet"), "temetList returns 5 entries in group temet");
  check(listNoVel.find(x => x.key === "Pth").available && listNoVel.find(x => x.key === "K").available &&
        listNoVel.find(x => x.key === "EM").available && listNoVel.find(x => x.key === "tcool").available,
    "Pth, K, EM, tcool are available when nH and T cubes exist");
  const listNull = temetList(null);
  check(listNull.every(x => !x.available && /no 3D data/.test(x.reason)), "temetList(null) disables all fields with a reason");
  const metaPth = temetFieldMeta("Pth", M);
  check(metaPth.kind === "mass_weighted" && metaPth.proj.kind === "weighted_mean" && metaPth.proj.vmin === 1.0 && metaPth.proj.vmax === 5.5 && !!metaPth.cubes?.L0,
    "temetFieldMeta(Pth) has mass_weighted kind, [1.0, 5.5] display window, and L0 cubes");
  const metaEM = temetFieldMeta("EM", M);
  check(metaEM.kind === "density" && metaEM.proj.kind === "column" && metaEM.vol_window[0] === -6.0 && metaEM.vol_window[1] === 1.0,
    "temetFieldMeta(EM) has density/column kind and [-6.0, 1.0] volume window");
}

/* ---- 2. Cooling curve Lambda(T, Z) physics ---- */
{
  const lPrim = coolingLambda(5.25, 0.0), lSolar = coolingLambda(5.25, 1.0);
  check(lSolar > 5 * lPrim && lSolar > 1e-22 && lSolar < 2e-21, `coolingLambda(10^5.25 K, Zsun=1) = ${lSolar.toExponential(2)} >> primordial ${lPrim.toExponential(2)}`);
  const l6 = coolingLambda(6.0, 0.3), l7 = coolingLambda(7.0, 0.0), l8 = coolingLambda(8.0, 0.0);
  check(l6 > 1e-23 && l6 < 1e-21, `coolingLambda(10^6 K, 0.3 Zsun) = ${l6.toExponential(2)} erg cm^3/s`);
  const ratioFF = l8 / l7;
  check(Math.abs(ratioFF - Math.sqrt(10)) < 0.25, `bremsstrahlung T^1/2 scaling at 10^7..10^8 K: ratio ${ratioFF.toFixed(2)} vs sqrt(10)=3.16`);
}

/* ---- 3. Exact thermodynamic formulas on test voxels ---- */
{
  const rN = [-7, 2], rT = [3, 8], rZ = [-3, 1], V = 500;
  // Voxel 0: empty; Voxel 1: CGM (nH=1e-4, T=1e6, Z=0.3, v=(151,0,0)); Voxel 2: ISM (nH=1, T=1e4, Z=1, v=(0,151,0)); Voxel 3: Hot halo (nH=1e-3, T=1e7, Z=0.1, v=(300,400,0))
  const logN = [NaN, -4.0, 0.0, -3.0];
  const logT = [NaN, 6.0, 4.0, 7.0];
  const logZ = [NaN, Math.log10(0.3), 0.0, -1.0];
  const vx = [NaN, 151.0, 0.0, 300.0], vy = [NaN, 0.0, 151.0, 400.0], vz = [NaN, 0.0, 0.0, 0.0];
  const raw = {
    nH: encLog(logN, ...rN), T: encLog(logT, ...rT), Z: encLog(logZ, ...rZ),
    vx: encodeLinear(vx, V), vy: encodeLinear(vy, V), vz: encodeLinear(vz, V)
  };
  const ranges = {nH: rN, T: rT, Z: rZ, velV: V};

  // Pth = log10(2.3 * nH * T)
  const pth = computeTemetCube("Pth", raw, ranges);
  const pthD = decodeU8(pth.data, pth.vmin, pth.vmax);
  const expPth = [NaN, Math.log10(2.3) - 4 + 6, Math.log10(2.3) + 0 + 4, Math.log10(2.3) - 3 + 7];
  check(pth.data[0] === 0 && Number.isNaN(pthD[0]) &&
        [1, 2, 3].every(i => Math.abs(pthD[i] - expPth[i]) < 0.06),
    `Pth formula matches log10(2.3 nH T): got [${[1,2,3].map(i => pthD[i].toFixed(2))}] vs [${[1,2,3].map(i => expPth[i].toFixed(2))}]`);

  // K = log10(kB T[keV] / (1.16 nH)^(2/3))
  const K = computeTemetCube("K", raw, ranges);
  const KD = decodeU8(K.data, K.vmin, K.vmax);
  const expK = [1, 2, 3].map(i => Math.log10(8.617333262e-8 * 10 ** logT[i] / (1.16 * 10 ** logN[i]) ** (2 / 3)));
  check(K.data[0] === 0 && [1, 2, 3].every((i, idx) => Math.abs(KD[i] - expK[idx]) < 0.06),
    `K formula matches log10(kB T / (1.16 nH)^(2/3)): got [${[1,2,3].map(i => KD[i].toFixed(2))}] vs [${expK.map(x => x.toFixed(2))}]`);

  // EM = log10(nH^2 T^(1/2))
  const EM = computeTemetCube("EM", raw, ranges);
  const EMD = decodeU8(EM.data, EM.vmin, EM.vmax);
  const expEM = [1, 2, 3].map(i => 2 * logN[i] + 0.5 * logT[i]);
  check(EM.data[0] === 0 && [1, 2, 3].every((i, idx) => Math.abs(EMD[i] - expEM[idx]) < 0.12),
    `EM formula matches log10(nH^2 T^1/2): got [${[1,2,3].map(i => EMD[i].toFixed(2))}] vs [${expEM.map(x => x.toFixed(2))}]`);

  // tcool [Gyr]
  const tc = computeTemetCube("tcool", raw, ranges);
  const tcD = decodeU8(tc.data, tc.vmin, tc.vmax);
  const expTc = [1, 2, 3].map(i => Math.log10(3.45 * 1.380649e-16 * 10 ** logT[i] / (10 ** logN[i] * coolingLambda(logT[i], 10 ** logZ[i]) * 3.15576e16)));
  check(tc.data[0] === 0 && [1, 2, 3].every((i, idx) => Math.abs(tcD[i] - expTc[idx]) < 0.12),
    `tcool formula matches analytic Wiersma/SD93 cooling time [Gyr]: got [${[1,2,3].map(i => tcD[i].toFixed(2))}] vs [${expTc.map(x => x.toFixed(2))}]`);

  // Mach = |v| / (15.1 * sqrt(T / 1e4))
  const ma = computeTemetCube("Mach", raw, ranges);
  const maD = decodeU8(ma.data, ma.vmin, ma.vmax);
  const expMa = [1, 2, 3].map(i => Math.log10(Math.hypot(vx[i], vy[i], vz[i]) / (15.1 * Math.sqrt(10 ** logT[i] / 1e4))));
  check(ma.data[0] === 0 && [1, 2, 3].every((i, idx) => Math.abs(maD[i] - expMa[idx]) < 0.06),
    `Mach formula matches log10(|v| / cs(T)): got [${[1,2,3].map(i => maD[i].toFixed(2))}] vs [${expMa.map(x => x.toFixed(2))}]`);
}

/* ---- 4. Performance: 256^3 synthesis speed ---- */
{
  const N = 256 ** 3;
  const qN = new Uint8Array(N).fill(120), qT = new Uint8Array(N).fill(140), qZ = new Uint8Array(N).fill(100);
  const qx = new Uint8Array(N).fill(160), qy = new Uint8Array(N).fill(128), qz = new Uint8Array(N).fill(100);
  const ranges = {nH: [-7, 2], T: [3, 8], Z: [-3, 1], velV: 500};
  const rP = computeTemetCube("Pth", {nH: qN, T: qT}, ranges);
  const rT = computeTemetCube("tcool", {nH: qN, T: qT, Z: qZ}, ranges);
  const rM = computeTemetCube("Mach", {T: qT, vx: qx, vy: qy, vz: qz}, ranges);
  check(rP.data.length === N && rT.data.length === N && rM.data.length === N && rP.ms < 2000 && rT.ms < 2000 && rM.ms < 2000,
    `256^3 synthesis timing: Pth ${rP.ms.toFixed(1)} ms, tcool ${rT.ms.toFixed(1)} ms, Mach ${rM.ms.toFixed(1)} ms`);
}

/* ---- 5. CLOUDY c17.03 Line Emissivity LUT & Surface Brightness Physics ---- */
{
  const meta = JSON.parse(readFileSync(join(ROOT, "docs/tng50/data/cloudy_emissivity_meta.json"), "utf8"));
  const lutBuf = new Uint8Array(readFileSync(join(ROOT, "docs/tng50/data/cloudy_emissivity_z0.bin")));
  check(lutBuf.length === 245952, `cloudy_emissivity_z0.bin is exactly 245,952 bytes (${lutBuf.length})`);
  check(CLOUDY_LINES.length === 12 && CLOUDY_DEFAULT_LINE === "Ha_6563" &&
        CLOUDY_LINES.every((l, i) => l.id === meta.lines[i].id && l.label === meta.lines[i].label &&
          l.sb_range[0] === meta.lines[i].sb_range[0] && l.sb_range[1] === meta.lines[i].sb_range[1]),
    "CLOUDY_LINES matches all 12 lines and SB ranges in cloudy_emissivity_meta.json");
  setCloudyLut(lutBuf);

  // Physical checks: Hα peaks in warm 10^4 K gas; O VII peaks in hot 10^6.3 K X-ray halo gas
  const epsHaWarm = sampleCloudyLogEps(lutBuf, "Ha_6563", -2.0, 0.0, 4.0);
  const epsHaHot = sampleCloudyLogEps(lutBuf, "Ha_6563", -2.0, 0.0, 7.0);
  check(epsHaWarm > -30.5 && epsHaWarm < -27 && epsHaWarm > epsHaHot + 2.0,
    `Hα 6563 Å warm (10^4 K) eps = ${epsHaWarm.toFixed(2)} >> hot (10^7 K) ${epsHaHot.toFixed(2)}`);

  const epsO7Hot = sampleCloudyLogEps(lutBuf, "OVII_21.6", -3.0, -0.5, 6.3);
  const epsO7Warm = sampleCloudyLogEps(lutBuf, "OVII_21.6", -3.0, -0.5, 4.0);
  check(epsO7Hot > -32 && epsO7Hot < -27 && epsO7Hot > epsO7Warm + 5.0,
    `O VII 21.6 Å hot (10^6.3 K) eps = ${epsO7Hot.toFixed(2)} >> warm (10^4 K) ${epsO7Warm}`);

  // Exact SB offset & (1+z)^-4 cosmological dimming
  const off0 = cloudySbOffset(0.0), off1 = cloudySbOffset(1.0);
  const expOff0 = CLOUDY_EPS_REF + 21.4893505383 - 11.7280614585;
  check(Math.abs(off0 - expOff0) < 1e-6 && Math.abs((off1 - off0) + 4 * Math.log10(2)) < 1e-6,
    `cloudySbOffset: z=0 -> ${off0.toFixed(4)}, z=1 -> ${off1.toFixed(4)} (dimming ${(off1 - off0).toFixed(4)} dex)`);

  // Cube synthesis with Z and fallback without Z matches sampleCloudyLogEps
  const rN = [-7, 2], rT = [3, 8], rZ = [-3, 1];
  const logN = [NaN, -2.0, -3.0, -1.0], logT = [NaN, 4.0, 6.3, 5.5], logZ = [NaN, 0.0, -0.5, -0.2];
  const rawWithZ = {nH: encLog(logN, ...rN), T: encLog(logT, ...rT), Z: encLog(logZ, ...rZ)};
  const rawNoZ = {nH: encLog(logN, ...rN), T: encLog(logT, ...rT)};
  const cHa = computeCloudyEmissivityCube("Ha_6563", rawWithZ, {nH: rN, T: rT, Z: rZ}, lutBuf);
  const cHaD = decodeU8(cHa.data, CLOUDY_EPS_MIN, CLOUDY_EPS_MAX);
  const expHa1 = sampleCloudyLogEps(lutBuf, "Ha_6563", logN[1], logZ[1], logT[1]);
  check(cHa.data[0] === 0 && Math.abs(cHaD[1] - expHa1) < 0.25,
    `computeCloudyEmissivityCube(Ha_6563, with Z): got ${cHaD[1].toFixed(2)} vs ${expHa1.toFixed(2)}`);

  const cO7Fb = computeCloudyEmissivityCube("OVII_21.6", rawNoZ, {nH: rN, T: rT}, lutBuf);
  const cO7FbD = decodeU8(cO7Fb.data, CLOUDY_EPS_MIN, CLOUDY_EPS_MAX);
  check(cO7Fb.data[0] === 0 && Math.abs(cO7FbD[2] - epsO7Hot) < 0.25,
    `computeCloudyEmissivityCube(OVII_21.6, fallback Z=-0.5): got ${cO7FbD[2].toFixed(2)} vs ${epsO7Hot.toFixed(2)}`);

  // 256^3 synthesis speed
  const N = 256 ** 3;
  const qN = new Uint8Array(N).fill(120), qT = new Uint8Array(N).fill(140), qZ = new Uint8Array(N).fill(150);
  const rC = computeCloudyEmissivityCube("Ha_6563", {nH: qN, T: qT, Z: qZ}, {nH: rN, T: rT, Z: rZ}, lutBuf);
  check(rC.data.length === N && rC.ms < 2000, `256^3 CLOUDY Ha_6563 synthesis timing: ${rC.ms.toFixed(1)} ms`);
}

/* ---- 6. 3D Emission Mode (uMode == 2) shader patch & viewer3d wiring ---- */
{
  const patched = applyEmissionMode(FRAG);
  check(!FRAG.includes("uEmisOffset") && !FRAG.includes("emisMode"), "raymarch.js base FRAG remains byte-clean (parity preserved)");
  check(patched.includes("uniform int uMode, uKind; uniform float uEmisOffset;") &&
        patched.includes("bool emisMode = !velMode && uMode == 2;") &&
        patched.includes("} else if (emisMode) {\n          sumG += v * hw;") &&
        patched.includes("emisMode ? (sumG > 0.0 ? log2(sumG) / LOG2_10 + uEmisOffset : -1e30)"),
    "applyEmissionMode(FRAG) injects float32-safe uMode == 2 CLOUDY SB branch cleanly");
  const vsrc = readFileSync(join(ROOT, "docs/tng50/js/viewer3d.js"), "utf8");
  check(vsrc.includes('value="emission" data-testid="v3-mode-emission"') &&
        vsrc.includes('id="v3-emis-line" data-testid="v3-emis-line"') &&
        vsrc.includes("applyEmissionMode(RM.material.fragmentShader)") &&
        vsrc.includes("RM.uniforms.uEmisOffset = {value: cloudySbOffset(0)}") &&
        vsrc.includes("CLOUDY c17.03") &&
        vsrc.includes("log₁₀ SB [erg s⁻¹ cm⁻² arcsec⁻²]") &&
        vsrc.includes('parts.push("mode=emission")') &&
        vsrc.includes('<span class="k">TEMET</span>'),
    "viewer3d.js wires CLOUDY c17.03 emission line selector, SB colorbar, uEmisOffset, and URL sync");
}

console.log(fails ? `\n${fails} check(s) FAILED` : "\nall checks passed");
process.exit(fails ? 1 : 0);
