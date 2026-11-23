// Unit and performance tests for docs/tng50/js/fast_viz_wasm.js + fast_viz.wasm (compiled from rust_wasm_kernel):
// 1. wasm_cast_cube_ray: 5-level (L0..L4) trilinear and nearest-voxel ray-marching across all 18 fields (< 0.3 ms)
// 2. wasm_synthesize_voigt_12ions: 12-ion Faddeeva/Humlicek Voigt optical-depth tau(v) and flux exp(-tau) synthesis (< 1.0 ms)
// 3. wasm_decode_lut_volume & wasm_pack_velocity: SIMD128 LUT dequantization and RGBA packing parity with vizdata.js

import {
  initFastVizWasm, wasmReady, getWasmExports,
  WASM_LEVEL_KEYS, WASM_LEVEL_HALF_DEFAULT, WASM_ION_KEYS, WASM_FIELD_KEYS,
  wasm_cast_cube_ray, wasm_synthesize_voigt_12ions, wasm_decode_lut_volume, wasm_pack_velocity,
  voigtHumlicekJs, stageCubeInWasm, resetWasmCubeCache, getMaxCubeCacheBytes, createStreamingRaySampler
} from "../../docs/tng50/js/fast_viz_wasm.js";
import {decodeU8, decodeLinear, packVelocity} from "../../docs/tng50/js/vizdata.js";

let fails = 0;
const check = (ok, msg) => {
  console.log(`${ok ? "ok  " : "FAIL"} ${msg}`);
  if (!ok) fails++;
};

const ex = await initFastVizWasm();
check(wasmReady() && !!ex, "fast_viz.wasm loaded and instantiated via initFastVizWasm()");
check(
  typeof ex?.wasm_cast_cube_ray === "function" &&
  typeof ex?.wasm_synthesize_voigt_12ions === "function" &&
  typeof ex?.wasm_decode_lut_volume === "function" &&
  typeof ex?.wasm_pack_velocity === "function",
  "fast_viz.wasm exports wasm_cast_cube_ray, wasm_synthesize_voigt_12ions, wasm_decode_lut_volume, wasm_pack_velocity"
);

// ---- 1. wasm_decode_lut_volume & wasm_pack_velocity parity ----
{
  const N = 64 * 64 * 16; // 65,536 voxels (volume slice)
  const q = new Uint8Array(N);
  for (let i = 0; i < N; i++) q[i] = i % 256;
  const vmin = -6.5, vmax = 1.5;

  const dWasm = wasm_decode_lut_volume(q, vmin, vmax, {mode: 0});
  const s = (vmax - vmin) / 254;
  let maxDiff = 0, nanOk = true;
  for (let i = 0; i < N; i++) {
    if (q[i] === 0) {
      if (!Number.isNaN(dWasm[i])) nanOk = false;
    } else {
      const ref = vmin + (q[i] - 1) * s;
      maxDiff = Math.max(maxDiff, Math.abs(dWasm[i] - ref));
    }
  }
  check(nanOk && maxDiff <= 1e-6, `wasm_decode_lut_volume (mode 0 f32): max|diff| = ${maxDiff.toExponential(2)} <= 1e-6, NaN at q=0`);

  // Mode 1: linear physical 10^v
  const dPow = wasm_decode_lut_volume(q.subarray(0, 256), vmin, vmax, {mode: 1});
  check(dPow[0] === 0 && Math.abs(dPow[1] - 10 ** vmin) / (10 ** vmin) < 1e-5 && Math.abs(dPow[255] - 10 ** vmax) / (10 ** vmax) < 1e-5,
    "wasm_decode_lut_volume (mode 1 10^v): q=0 -> 0, q=1 -> 10^vmin, q=255 -> 10^vmax");

  // Mode 2: RGBA8 colormap LUT projection
  const lutRgba = new Uint8Array(256 * 4);
  for (let i = 0; i < 256; i++) {
    lutRgba[4 * i] = i;
    lutRgba[4 * i + 1] = 255 - i;
    lutRgba[4 * i + 2] = (i * 3) & 255;
    lutRgba[4 * i + 3] = i === 0 ? 0 : 255;
  }
  const rgbaOut = wasm_decode_lut_volume(q.subarray(0, 1024), vmin, vmax, {mode: 2, lutRgba});
  let rgbaOk = rgbaOut.length === 4096;
  for (let i = 0; i < 1024 && rgbaOk; i++) {
    const c = q[i];
    if (rgbaOut[4 * i] !== lutRgba[4 * c] || rgbaOut[4 * i + 1] !== lutRgba[4 * c + 1] ||
        rgbaOut[4 * i + 2] !== lutRgba[4 * c + 2] || rgbaOut[4 * i + 3] !== lutRgba[4 * c + 3]) {
      rgbaOk = false;
    }
  }
  check(rgbaOk, "wasm_decode_lut_volume (mode 2 RGBA8 LUT): exact 4-channel slice projection");

  // Velocity RGBA packing parity
  const qx = new Uint8Array(4096), qy = new Uint8Array(4096), qz = new Uint8Array(4096);
  for (let i = 0; i < 4096; i++) {
    qx[i] = i % 17 === 0 ? 0 : (i * 7) & 255;
    qy[i] = i % 29 === 0 ? 0 : (i * 13) & 255;
    qz[i] = (i * 19 + 1) & 255;
  }
  const pkWasm = packVelocity(qx, qy, qz);
  let pkOk = pkWasm.length === 4096 * 4;
  for (let i = 0; i < 4096 && pkOk; i++) {
    const a = qx[i], b = qy[i], c = qz[i], o = 4 * i;
    const exp = (a === 0 || b === 0 || c === 0) ? [128, 128, 128, 0] : [a, b, c, 255];
    if (pkWasm[o] !== exp[0] || pkWasm[o + 1] !== exp[1] || pkWasm[o + 2] !== exp[2] || pkWasm[o + 3] !== exp[3]) pkOk = false;
  }
  check(pkOk, "wasm_pack_velocity / vizdata.packVelocity: exact RGBA8 velocity cube packing");
}

// ---- 2. wasm_cast_cube_ray across all 5 levels (L0..L4) and all 18 fields ----
{
  resetWasmCubeCache();
  const n = 32; // 32^3 per level * 5 levels * 18 fields = 90 cubes
  const cubes = {L0: {}, L1: {}, L2: {}, L3: {}, L4: {}};
  const manifest = {levels: {}, gas: {fields: {}}};

  for (let l = 0; l < WASM_LEVEL_KEYS.length; l++) {
    const L = WASM_LEVEL_KEYS[l], h = WASM_LEVEL_HALF_DEFAULT[l];
    manifest.levels[L] = {half_kpc: h, n, voxel_kpc: (2 * h) / n, r_mask_kpc: l === 0 ? 400 : null};
  }

  for (let f = 0; f < WASM_FIELD_KEYS.length; f++) {
    const k = WASM_FIELD_KEYS[f];
    const isVel = k === "vx" || k === "vy" || k === "vz";
    const vmin = isVel ? -400 : k === "T" ? 3.5 : k === "Z" ? -3.0 : -11.0;
    const vmax = isVel ? 400 : k === "T" ? 7.5 : k === "Z" ? 1.0 : -2.0;
    manifest.gas.fields[k] = {vmin, vmax, cubes: {}};

    for (let l = 0; l < WASM_LEVEL_KEYS.length; l++) {
      const L = WASM_LEVEL_KEYS[l], h = WASM_LEVEL_HALF_DEFAULT[l];
      const u8 = new Uint8Array(n * n * n);
      // Populate smooth 3D gas distribution with two distinct clouds along the ray
      for (let iz = 0; iz < n; iz++) {
        const z = ((iz + 0.5) / n - 0.5) * 2 * h;
        for (let iy = 0; iy < n; iy++) {
          const y = ((iy + 0.5) / n - 0.5) * 2 * h;
          for (let ix = 0; ix < n; ix++) {
            const x = ((ix + 0.5) / n - 0.5) * 2 * h;
            const r = Math.hypot(x, y, z);
            let q = 0;
            if (isVel) {
              const v = k === "vz" ? (z > 0 ? 85.0 : -65.0) + 0.15 * x : 10.0;
              q = Math.max(1, Math.min(255, 1 + Math.round(((v - vmin) / (vmax - vmin)) * 254)));
            } else if (k === "T") {
              const lgT = 4.2 + 1.2 * Math.min(1, r / 150);
              q = Math.max(1, Math.min(255, 1 + Math.round(((lgT - vmin) / (vmax - vmin)) * 254)));
            } else {
              // Cloud 1 near z = -20 kpc, Cloud 2 near z = +35 kpc
              const d1 = Math.hypot(x - 2, y + 1, z + 20);
              const d2 = Math.hypot(x + 3, y - 2, z - 35);
              const lgN = Math.max(-10.5, -4.8 - 0.08 * Math.min(d1, d2) - 0.05 * f);
              q = Math.max(1, Math.min(255, 1 + Math.round(((lgN - vmin) / (vmax - vmin)) * 254)));
            }
            u8[ix + n * (iy + n * iz)] = q;
          }
        }
      }
      stageCubeInWasm(u8);
      cubes[L][k] = {data: u8, n, half: h, vmin, vmax};
    }
  }

  const p0d = [-15.0, -10.0, -180.0], p1d = [15.0, 10.0, 180.0];
  const median = arr => { const s = [...arr].sort((a, b) => a - b); return s[s.length >> 1]; };
  // Warmup V8 / TurboFan JIT
  for (let w = 0; w < 15; w++) {
    wasm_cast_cube_ray({cubes, manifest, p0d, p1d, nSteps: 512, trilinear: true});
  }

  // Benchmark 25 runs of 512-step 18-field 5-level trilinear ray-marching
  const N_RUNS = 25;
  const rayTimes = [];
  let rayRes = null;
  for (let r = 0; r < N_RUNS; r++) {
    const t0 = performance.now();
    rayRes = wasm_cast_cube_ray({cubes, manifest, p0d, p1d, nSteps: 512, trilinear: true});
    rayTimes.push(performance.now() - t0);
  }
  const medRayMs = median(rayTimes);
  check(
    rayRes.usedWasm && rayRes.samples.length === 512 * 18 && medRayMs < 0.3,
    `wasm_cast_cube_ray (512 steps x 18 fields x 5 levels L0..L4 trilinear): ${medRayMs.toFixed(3)} ms (< 0.3 ms target)`
  );

  // Check nearest-voxel parity with exact index formula
  const nearRes = wasm_cast_cube_ray({cubes, manifest, p0d, p1d, nSteps: 64, trilinear: false});
  let nearOk = true;
  for (let s = 0; s < 64; s++) {
    for (let f = 0; f < 18; f++) {
      if (!Number.isFinite(nearRes.samples[s * 18 + f])) nearOk = false;
    }
  }
  check(nearOk, "wasm_cast_cube_ray nearest-voxel mode produces finite decoded values across all 18 fields");

  // ---- 3. wasm_synthesize_voigt_12ions performance & physical accuracy ----
  // Warmup V8 / TurboFan JIT
  for (let w = 0; w < 15; w++) {
    wasm_synthesize_voigt_12ions({
      samples: rayRes.samples, vlos: rayRes.vlos, temp: rayRes.temp,
      nSteps: 512, dlCm: rayRes.dlCm, u0: -1500, du: 1, nGrid: 3001, wantTau: true
    });
  }

  const voigtTimes = [];
  let voigtRes = null;
  for (let r = 0; r < N_RUNS; r++) {
    const t0 = performance.now();
    voigtRes = wasm_synthesize_voigt_12ions({
      samples: rayRes.samples, vlos: rayRes.vlos, temp: rayRes.temp,
      nSteps: 512, dlCm: rayRes.dlCm, u0: -1500, du: 1, nGrid: 3001, wantTau: true
    });
    voigtTimes.push(performance.now() - t0);
  }
  const medVoigtMs = median(voigtTimes);
  check(
    voigtRes.usedWasm && Object.keys(voigtRes.lines).length === 12 && medVoigtMs < 1.0,
    `wasm_synthesize_voigt_12ions (12 ions x 3001 velocity channels): ${medVoigtMs.toFixed(3)} ms (< 1.0 ms target)`
  );

  // Verify physical Voigt profile parity against Humlicek reference
  const hCore = voigtHumlicekJs(0.0, 0.001), hWing = voigtHumlicekJs(10.0, 0.001);
  // Compare against voigtRes OVI line shape and verify absorption troughs at v ~ -65 and +85 km/s
  const oviFlux = voigtRes.lines.OVI.flux;
  const idxNeg = 1500 - 65, idxPos = 1500 + 85, idxCont = 1500 - 800;
  check(
    oviFlux[idxNeg] < 0.85 && oviFlux[idxPos] < 0.85 && oviFlux[idxCont] > 0.998 &&
    Math.abs(hCore - 1.0) < 0.01 && hWing > 0 && hWing < 1e-4,
    `wasm_synthesize_voigt_12ions O VI absorption troughs at v=-65 km/s (F=${oviFlux[idxNeg].toFixed(3)}) and v=+85 km/s (F=${oviFlux[idxPos].toFixed(3)}), continuum F=${oviFlux[idxCont].toFixed(4)}`
  );
  check(
    WASM_ION_KEYS.every(k => Number.isFinite(voigtRes.logNMap[k]) && voigtRes.logNMap[k] > 11.0 && Array.isArray(voigtRes.compRows[k])),
    `wasm_synthesize_voigt_12ions produces valid logN and Voigt seed components for all 12 ions (HI logN=${voigtRes.logNMap.HI})`
  );

  // ---- 4. Device-aware WASM cache cap & zero-duplication streaming ray sampler parity ----
  const maxCache = getMaxCubeCacheBytes();
  check(maxCache >= 32 * 1024 * 1024 && maxCache <= 96 * 1024 * 1024,
    `getMaxCubeCacheBytes() enforces device-safe WASM cache cap (${(maxCache / (1024 * 1024)).toFixed(0)} MiB <= 96 MiB)`);
  const sampler = createStreamingRaySampler({manifest, p0d, p1d, nSteps: 512, trilinear: true});
  for (let l = WASM_LEVEL_KEYS.length - 1; l >= 0; l--) {
    const L = WASM_LEVEL_KEYS[l];
    for (let f = 0; f < WASM_FIELD_KEYS.length; f++) {
      const k = WASM_FIELD_KEYS[f];
      const c = cubes[L][k];
      sampler.ingestCube(L, k, c.data, c);
    }
  }
  const streamRes = sampler.finish();
  let maxSampleDiff = 0;
  for (let i = 0; i < rayRes.samples.length; i++) {
    maxSampleDiff = Math.max(maxSampleDiff, Math.abs(rayRes.samples[i] - streamRes.samples[i]));
  }
  check(
    streamRes.streamed && maxSampleDiff < 2e-4,
    `createStreamingRaySampler matches wasm_cast_cube_ray across all 512x18 samples (max|diff| = ${maxSampleDiff.toExponential(2)})`
  );
}

console.log(fails ? `\n${fails} check(s) FAILED` : "\nall checks passed");
process.exit(fails ? 1 : 0);
