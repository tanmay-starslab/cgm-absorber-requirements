// Zero-dependency WebAssembly (fast_viz.wasm, compiled from rust_wasm_kernel with +simd128 -C opt-level=3)
// accelerator for 3D multi-level (L0..L4) ray-marching across all 18 fields (nH, T, Z, 12 ions, vx, vy, vz),
// real-time 12-ion Faddeeva/Humlicek Voigt optical-depth tau(v) and flux exp(-tau) synthesis,
// and SIMD128 LUT dequantization for 3D volume slices.
// Includes full pure-JS fallback so every Node and browser test runs cleanly even if WASM is not yet loaded.

export const WASM_LEVEL_KEYS = Object.freeze(["L0", "L1", "L2", "L3", "L4"]);
export const WASM_LEVEL_HALF_DEFAULT = Object.freeze([400.0, 100.0, 25.0, 6.25, 1.5]);
export const WASM_ION_KEYS = Object.freeze([
  "HI", "MgII", "SiII", "CII", "SiIII", "CIII", "SiIV", "CIV", "NV", "OVI", "NeVIII", "OVII"
]);
export const WASM_FIELD_KEYS = Object.freeze([
  "nH", "T", "Z",
  ...WASM_ION_KEYS,
  "vx", "vy", "vz"
]);
export const CM_PER_KPC = 3.0856775814913673e21;

const DEFAULT_ATOMS = [
  {key: "HI",     lam0_A: 1215.670, f: 0.4160, gamma_s: 4.690e8,  mass_amu: 1.008,  b_min: 8.0},
  {key: "MgII",   lam0_A: 2796.352, f: 0.6123, gamma_s: 2.612e8,  mass_amu: 24.305, b_min: 2.0},
  {key: "SiII",   lam0_A: 1260.422, f: 1.1800, gamma_s: 2.950e9,  mass_amu: 28.085, b_min: 2.0},
  {key: "CII",    lam0_A: 1334.532, f: 0.1290, gamma_s: 2.410e8,  mass_amu: 12.011, b_min: 2.5},
  {key: "SiIII",  lam0_A: 1206.500, f: 1.6300, gamma_s: 2.480e9,  mass_amu: 28.085, b_min: 2.0},
  {key: "CIII",   lam0_A: 977.020,  f: 0.7586, gamma_s: 1.767e9,  mass_amu: 12.011, b_min: 2.5},
  {key: "SiIV",   lam0_A: 1402.770, f: 0.2550, gamma_s: 8.630e8,  mass_amu: 28.085, b_min: 2.0},
  {key: "CIV",    lam0_A: 1548.187, f: 0.1900, gamma_s: 2.650e8,  mass_amu: 12.011, b_min: 2.5},
  {key: "NV",     lam0_A: 1238.821, f: 0.1560, gamma_s: 3.400e8,  mass_amu: 14.007, b_min: 2.5},
  {key: "OVI",    lam0_A: 1031.912, f: 0.1330, gamma_s: 4.160e8,  mass_amu: 15.999, b_min: 2.5},
  {key: "NeVIII", lam0_A: 770.409,  f: 0.1020, gamma_s: 5.720e8,  mass_amu: 20.180, b_min: 2.5},
  {key: "OVII",   lam0_A: 21.602,   f: 0.6960, gamma_s: 3.300e12, mass_amu: 15.999, b_min: 2.5}
];

const nowMs = () => (globalThis.performance && performance.now ? performance.now() : Date.now());

let wasmInstance = null;
let wasmExports = null;
let wasmInitPromise = null;

// Persistent arena state: CUBE_CACHE maps a JS Uint8Array cube to its pointer in WASM linear memory
// so repeated ray-marches across small/medium cached 3D cube sets perform zero memory copies.
// Device-aware budget prevents duplicating huge (e.g. 1.4 GiB 5-level x 18-field 256^3) cube sets in WASM.
let cubeCache = new WeakMap();
let cubeSetCache = new WeakMap();
let cubeCacheBytes = 0;
let scratchBasePtr = 0;

export function getMaxCubeCacheBytes() {
  const nav = globalThis.navigator;
  const memGb = Number(nav && nav.deviceMemory);
  const isMob = !!(
    (nav && nav.userAgentData && nav.userAgentData.mobile) ||
    (typeof globalThis.matchMedia === "function" &&
      globalThis.matchMedia("(max-width: 820px), (pointer: coarse)").matches)
  );
  if (isMob || (memGb > 0 && memGb <= 4)) return 32 * 1024 * 1024; // 32 MiB on mobile / <= 4 GB RAM devices
  if (memGb > 0 && memGb <= 8) return 64 * 1024 * 1024; // 64 MiB on 8 GB devices
  return 96 * 1024 * 1024; // 96 MiB cap on desktop/Node — never duplicate 1.4 GiB cube sets in WASM
}
const MAX_CUBE_CACHE_BYTES = getMaxCubeCacheBytes();

export function wasmReady() {
  return !!wasmExports;
}

export function getWasmExports() {
  return wasmExports;
}

export async function initFastVizWasm(customUrl = null) {
  if (wasmExports) return wasmExports;
  if (wasmInitPromise) return wasmInitPromise;

  wasmInitPromise = (async () => {
    try {
      const url = customUrl ? new URL(customUrl, import.meta.url) : new URL("./fast_viz.wasm", import.meta.url);
      let bytes = null;
      const isNode = typeof process !== "undefined" && !!(process.versions && process.versions.node);
      if (isNode && url.protocol === "file:") {
        const [{readFileSync}, {fileURLToPath}] = await Promise.all([import("node:fs"), import("node:url")]);
        bytes = readFileSync(fileURLToPath(url));
      } else if (typeof fetch === "function") {
        const resp = await fetch(url);
        if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
        if (WebAssembly.instantiateStreaming) {
          try {
            const res = await WebAssembly.instantiateStreaming(resp, {});
            wasmInstance = res.instance;
            wasmExports = wasmInstance.exports;
            return wasmExports;
          } catch {
            // Fall back to arrayBuffer if MIME type is not application/wasm
            const r2 = await fetch(url);
            bytes = await r2.arrayBuffer();
          }
        } else {
          bytes = await resp.arrayBuffer();
        }
      }
      if (!bytes) throw new Error("Unable to load fast_viz.wasm bytes");
      const res = await WebAssembly.instantiate(bytes, {});
      wasmInstance = res.instance || res;
      wasmExports = wasmInstance.exports;
      return wasmExports;
    } catch {
      wasmExports = null;
      return null;
    }
  })();

  return wasmInitPromise;
}

// Kick off background initialization automatically in Node.js so synchronous callers get WASM right away
if (typeof process !== "undefined" && process.versions && process.versions.node) {
  initFastVizWasm().catch(() => {});
}

// Reset cached cubes in WASM linear memory (e.g. on galaxy switch)
export function resetWasmCubeCache() {
  cubeCache = new WeakMap();
  cubeSetCache = new WeakMap();
  cubeCacheBytes = 0;
  scratchBasePtr = 0;
  if (wasmExports && wasmExports.wasm_reset_arena) {
    wasmExports.wasm_reset_arena();
  }
}

// Pre-stage a loaded u8 cube into WASM linear memory when it fits within the device-aware cache budget.
// If allowReset is false (when building an atomic multi-cube pointer table), never reset the arena mid-table;
// return 0 on budget overflow so the caller can reset once or fall back to zero-duplication streaming ray sampling.
export function stageCubeInWasm(u8, {allowReset = true} = {}) {
  if (!wasmExports || !(u8 instanceof Uint8Array) || u8.length === 0) return 0;
  const maxBytes = getMaxCubeCacheBytes();
  if (u8.length > maxBytes) return 0;
  const hit = cubeCache.get(u8);
  if (hit) return hit;
  if (cubeCacheBytes + u8.length > maxBytes) {
    if (!allowReset) return 0;
    resetWasmCubeCache();
  }
  const ptr = wasmExports.wasm_alloc(u8.length);
  if (!ptr) return 0;
  new Uint8Array(wasmExports.memory.buffer, ptr, u8.length).set(u8);
  cubeCache.set(u8, ptr);
  cubeCacheBytes += u8.length;
  scratchBasePtr = 0;
  return ptr;
}

// -----------------------------------------------------------------------------
// Zero-duplication streaming 3D multi-level ray sampler:
// Precomputes the 8-corner trilinear indices & weights once per (step, level)
// and samples each (level, field) Uint8Array cube in-place as it arrives, so
// callers never need to retain all 90 (1.41 GiB) cubes in JS or duplicate them in WASM.
// -----------------------------------------------------------------------------
export function createStreamingRaySampler({manifest = null, p0d = [0, 0, -200], p1d = [0, 0, 200], nSteps = 512, trilinear = true} = {}) {
  const t0 = nowMs();
  const numLevels = WASM_LEVEL_KEYS.length;
  const numFields = WASM_FIELD_KEYS.length;
  const dx = p1d[0] - p0d[0], dy = p1d[1] - p0d[1], dz = p1d[2] - p0d[2];
  const rayLenKpc = Math.hypot(dx, dy, dz);
  const dlKpc = rayLenKpc / nSteps;
  const dlCm = dlKpc * CM_PER_KPC;
  const nd = rayLenKpc > 1e-12 ? [dx / rayLenKpc, dy / rayLenKpc, dz / rayLenKpc] : [0, 0, 1];

  const levelN = new Uint32Array(numLevels);
  const levelHalf = new Float32Array(numLevels);
  for (let l = 0; l < numLevels; l++) {
    const L = WASM_LEVEL_KEYS[l];
    const mLvl = manifest?.levels?.[L];
    levelN[l] = mLvl?.n || 0;
    levelHalf[l] = mLvl?.half_kpc || WASM_LEVEL_HALF_DEFAULT[l];
  }

  const vminArr = new Float32Array(numFields);
  const vmaxArr = new Float32Array(numFields);
  for (let f = 0; f < numFields; f++) {
    const fKey = WASM_FIELD_KEYS[f];
    const mf = manifest?.gas?.fields?.[fKey];
    vminArr[f] = Number.isFinite(mf?.vmin) ? mf.vmin : -10.0;
    vmaxArr[f] = Number.isFinite(mf?.vmax) ? mf.vmax : 10.0;
  }

  const stepX = new Float32Array(nSteps);
  const stepY = new Float32Array(nSteps);
  const stepZ = new Float32Array(nSteps);
  const stepMaxAbs = new Float32Array(nSteps);
  for (let s = 0; s < nSteps; s++) {
    const t = (s + 0.5) / nSteps;
    const x = p0d[0] + t * dx, y = p0d[1] + t * dy, z = p0d[2] + t * dz;
    stepX[s] = x; stepY[s] = y; stepZ[s] = z;
    stepMaxAbs[s] = Math.max(Math.abs(x), Math.abs(y), Math.abs(z));
  }

  const samples = new Float32Array(nSteps * numFields);
  samples.fill(NaN);
  // Tracks the finest level index l (0..4) that produced a valid non-zero sample for (step s, field f)
  const sampleLevel = new Int8Array(nSteps * numFields);
  sampleLevel.fill(-1);

  // Cache precomputed per-level step tables Keyed by `${l}:${n}:${h}`
  const levelStepTables = new Map();
  function getLevelStepTable(l, n, h) {
    const key = `${l}:${n}:${h}`;
    let tab = levelStepTables.get(key);
    if (tab) return tab;
    const bound = l === 0 ? h : h * 0.96;
    const activeSteps = [];
    for (let s = 0; s < nSteps; s++) {
      if (stepMaxAbs[s] < bound) activeSteps.push(s);
    }
    const count = activeSteps.length;
    const steps = new Uint16Array(activeSteps);
    if (!trilinear) {
      const idx = new Uint32Array(count);
      for (let i = 0; i < count; i++) {
        const s = steps[i];
        const ix = Math.min(n - 1, Math.max(0, Math.floor((stepX[s] / h * 0.5 + 0.5) * n)));
        const iy = Math.min(n - 1, Math.max(0, Math.floor((stepY[s] / h * 0.5 + 0.5) * n)));
        const iz = Math.min(n - 1, Math.max(0, Math.floor((stepZ[s] / h * 0.5 + 0.5) * n)));
        idx[i] = ix + n * (iy + n * iz);
      }
      tab = {count, steps, idx, w: null};
    } else {
      const idx = new Uint32Array(count * 8);
      const w = new Float32Array(count * 8);
      const n2 = n * n;
      for (let i = 0; i < count; i++) {
        const s = steps[i];
        const gx = (stepX[s] / h * 0.5 + 0.5) * n - 0.5;
        const gy = (stepY[s] / h * 0.5 + 0.5) * n - 0.5;
        const gz = (stepZ[s] / h * 0.5 + 0.5) * n - 0.5;
        const ix0 = Math.floor(gx), iy0 = Math.floor(gy), iz0 = Math.floor(gz);
        const fx = Math.min(1, Math.max(0, gx - ix0));
        const fy = Math.min(1, Math.max(0, gy - iy0));
        const fz = Math.min(1, Math.max(0, gz - iz0));
        const x0 = Math.min(n - 1, Math.max(0, ix0)), x1 = Math.min(n - 1, Math.max(0, ix0 + 1));
        const y0 = Math.min(n - 1, Math.max(0, iy0)) * n, y1 = Math.min(n - 1, Math.max(0, iy0 + 1)) * n;
        const z0 = Math.min(n - 1, Math.max(0, iz0)) * n2, z1 = Math.min(n - 1, Math.max(0, iz0 + 1)) * n2;
        const wx0 = 1 - fx, wy0 = 1 - fy, wz0 = 1 - fz;
        const w00 = wx0 * wy0, w10 = fx * wy0, w01 = wx0 * fy, w11 = fx * fy;
        const o = i * 8;
        idx[o]     = x0 + y0 + z0; w[o]     = w00 * wz0;
        idx[o + 1] = x1 + y0 + z0; w[o + 1] = w10 * wz0;
        idx[o + 2] = x0 + y1 + z0; w[o + 2] = w01 * wz0;
        idx[o + 3] = x1 + y1 + z0; w[o + 3] = w11 * wz0;
        idx[o + 4] = x0 + y0 + z1; w[o + 4] = w00 * fz;
        idx[o + 5] = x1 + y0 + z1; w[o + 5] = w10 * fz;
        idx[o + 6] = x0 + y1 + z1; w[o + 6] = w01 * fz;
        idx[o + 7] = x1 + y1 + z1; w[o + 7] = w11 * fz;
      }
      tab = {count, steps, idx, w};
    }
    levelStepTables.set(key, tab);
    return tab;
  }

  function levelNeedsLoading(levelKey) {
    const l = WASM_LEVEL_KEYS.indexOf(levelKey);
    if (l < 0) return false;
    const h = levelHalf[l] || WASM_LEVEL_HALF_DEFAULT[l];
    const bound = l === 0 ? h : h * 0.96;
    for (let s = 0; s < nSteps; s++) {
      if (stepMaxAbs[s] < bound) return true;
    }
    return l === 0;
  }

  function ingestCube(levelKey, fieldKey, u8, meta = {}) {
    const l = typeof levelKey === "number" ? levelKey : WASM_LEVEL_KEYS.indexOf(levelKey);
    const f = typeof fieldKey === "number" ? fieldKey : WASM_FIELD_KEYS.indexOf(fieldKey);
    if (l < 0 || f < 0 || !(u8 instanceof Uint8Array) || u8.length === 0) return;
    const n = meta.n || levelN[l] || Math.round(Math.cbrt(u8.length));
    const h = meta.half || levelHalf[l] || WASM_LEVEL_HALF_DEFAULT[l];
    if (!n || !(h > 0)) return;
    const lo = Number.isFinite(meta.vmin) ? meta.vmin : vminArr[f];
    const hi = Number.isFinite(meta.vmax) ? meta.vmax : vmaxArr[f];
    const scale = (hi - lo) / 254.0;
    const tab = getLevelStepTable(l, n, h);
    const {count, steps, idx, w} = tab;

    if (!trilinear) {
      for (let i = 0; i < count; i++) {
        const s = steps[i];
        const slot = s * numFields + f;
        if (l <= sampleLevel[slot]) continue;
        const q = u8[idx[i]];
        if (q !== 0) {
          samples[slot] = lo + (q - 1) * scale;
          sampleLevel[slot] = l;
        }
      }
    } else {
      for (let i = 0; i < count; i++) {
        const s = steps[i];
        const slot = s * numFields + f;
        if (l <= sampleLevel[slot]) continue;
        const o = i * 8;
        let wSum = 0.0, qSum = 0.0;
        for (let k = 0; k < 8; k++) {
          const q = u8[idx[o + k]];
          if (q !== 0) {
            const wk = w[o + k];
            wSum += wk;
            qSum += wk * (q - 1);
          }
        }
        if (wSum > 1e-6) {
          samples[slot] = lo + (qSum / wSum) * scale;
          sampleLevel[slot] = l;
        }
      }
    }
  }

  function finish() {
    const vlos = new Float32Array(nSteps);
    const temp = new Float32Array(nSteps);
    for (let s = 0; s < nSteps; s++) {
      const base = s * numFields;
      const lgT = samples[base + 1];
      temp[s] = Number.isFinite(lgT) ? 10 ** lgT : 2e4;
      const vx = samples[base + 15];
      const vy = samples[base + 16];
      const vz = samples[base + 17];
      const vl = (Number.isFinite(vx) ? vx : 0) * nd[0] +
                 (Number.isFinite(vy) ? vy : 0) * nd[1] +
                 (Number.isFinite(vz) ? vz : 0) * nd[2];
      vlos[s] = Math.min(1480, Math.max(-1480, vl));
    }
    return {
      samples, vlos, temp, nSteps, rayLenKpc, dlKpc, dlCm,
      usedWasm: false, streamed: true, ms: nowMs() - t0
    };
  }

  return {ingestCube, levelNeedsLoading, finish};
}

// -----------------------------------------------------------------------------
// Pure-JS Humlicek Voigt profile fallback matching the Rust implementation
// -----------------------------------------------------------------------------
const SIGMA0 = 0.02654008;
const SQPI = Math.sqrt(Math.PI);
const ISQPI = 1 / SQPI;

export function voigtHumlicekJs(x, a) {
  const ax = Math.abs(x);
  const s = ax + a;
  if (s >= 15.0) {
    const d = x * x + a * a;
    const invD = 1.0 / d;
    const zr = x * invD, zi = -a * invD;
    const q2r = zr * zr - zi * zi, q2i = 2.0 * zr * zi;
    const q4r = q2r * q2r - q2i * q2i, q4i = 2.0 * q2r * q2i;
    const sr = 1.0 + 0.5 * q2r + 0.75 * q4r, si = 0.5 * q2i + 0.75 * q4i;
    const pi = zr * si + zi * sr;
    return Math.max(0.0, -pi * ISQPI);
  }
  if (s >= 5.5) {
    const u = x * x;
    const tr = a, ti = -ax;
    const t2r = a * a - u, t2i = -2.0 * a * ax;
    const n1r = t2r * 0.5641896 + 1.410474, n1i = t2i * 0.5641896;
    const numr = tr * n1r - ti * n1i, numi = tr * n1i + ti * n1r;
    const t4r = t2r * t2r - t2i * t2i, t4i = 2.0 * t2r * t2i;
    const denr = t4r + 3.0 * t2r + 0.75, deni = t4i + 3.0 * t2i;
    const norm = 1.0 / (denr * denr + deni * deni);
    const res = (numr * denr + numi * deni) * norm;
    return Math.max(0.0, ax < 5.8 ? res + Math.exp(-u) : res);
  }
  const tr = a, ti = -ax;
  let pr = 0.5642236, pi = 0.0;
  for (const c of [3.778987, 11.96482, 20.20933, 16.4955]) {
    const nr = pr * tr - pi * ti + c, ni = pr * ti + pi * tr;
    pr = nr; pi = ni;
  }
  let qr = 1.0, qi = 0.0;
  for (const c of [6.699398, 21.69274, 39.27121, 38.82363, 16.4955]) {
    const nr = qr * tr - qi * ti + c, ni = qr * ti + qi * tr;
    qr = nr; qi = ni;
  }
  const qNorm = 1.0 / (qr * qr + qi * qi);
  return Math.max(0.0, (pr * qr + pi * qi) * qNorm);
}

// -----------------------------------------------------------------------------
// 1. wasm_cast_cube_ray
// Can be called with low-level numeric WASM pointers OR a high-level JS config:
//   wasm_cast_cube_ray({cubes, manifest, p0d, p1d, nSteps = 512, trilinear = true})
// where `cubes` is `{L0: {nH: {data, n, half, vmin, vmax}, ...}, L1: {...}, ...}`
// -----------------------------------------------------------------------------
export function wasm_cast_cube_ray(...args) {
  if (typeof args[0] === "number" && wasmExports) {
    return wasmExports.wasm_cast_cube_ray(...args);
  }
  const opts = args[0] || {};
  const t0 = nowMs();
  const cubes = opts.cubes || {};
  const manifest = opts.manifest || null;
  const p0d = opts.p0d || [0, 0, -200];
  const p1d = opts.p1d || [0, 0, 200];
  const nSteps = opts.nSteps || 512;
  const trilinear = opts.trilinear !== false;

  const dx = p1d[0] - p0d[0], dy = p1d[1] - p0d[1], dz = p1d[2] - p0d[2];
  const rayLenKpc = Math.hypot(dx, dy, dz);
  const dlKpc = rayLenKpc / nSteps;
  const dlCm = dlKpc * CM_PER_KPC;

  const numLevels = WASM_LEVEL_KEYS.length;
  const numFields = WASM_FIELD_KEYS.length;

  let meta = cubeSetCache.get(cubes);
  if (!meta) {
    const levelN = new Uint32Array(numLevels);
    const levelHalf = new Float32Array(numLevels);
    const vminArr = new Float32Array(numFields);
    const vmaxArr = new Float32Array(numFields);

    for (let l = 0; l < numLevels; l++) {
      const L = WASM_LEVEL_KEYS[l];
      const mLvl = manifest?.levels?.[L];
      let n = mLvl?.n || 0;
      let half = mLvl?.half_kpc || WASM_LEVEL_HALF_DEFAULT[l];
      const cLvl = cubes[L];
      if (cLvl) {
        for (const fKey of WASM_FIELD_KEYS) {
          const c = cLvl[fKey];
          if (c && c.data) {
            if (!n && c.n) n = c.n;
            if (c.half) half = c.half;
            break;
          }
        }
      }
      levelN[l] = n;
      levelHalf[l] = half;
    }

    for (let f = 0; f < numFields; f++) {
      const fKey = WASM_FIELD_KEYS[f];
      const mf = manifest?.gas?.fields?.[fKey];
      let lo = mf?.vmin, hi = mf?.vmax;
      if (!Number.isFinite(lo) || !Number.isFinite(hi)) {
        for (const L of WASM_LEVEL_KEYS) {
          const c = cubes[L]?.[fKey];
          if (c && Number.isFinite(c.vmin) && Number.isFinite(c.vmax)) {
            lo = c.vmin; hi = c.vmax; break;
          }
        }
      }
      vminArr[f] = Number.isFinite(lo) ? lo : -10.0;
      vmaxArr[f] = Number.isFinite(hi) ? hi : 10.0;
    }

    let ptrTable = null;
    if (wasmExports) {
      // Preflight total bytes required for this cube set before staging so we never reset the arena mid-set
      let totalSetBytes = 0;
      let uncachedSetBytes = 0;
      const toStage = [];
      for (let l = 0; l < numLevels; l++) {
        const L = WASM_LEVEL_KEYS[l];
        const cLvl = cubes[L];
        if (!cLvl) continue;
        for (let f = 0; f < numFields; f++) {
          const fKey = WASM_FIELD_KEYS[f];
          const c = cLvl[fKey];
          const u8 = c?.data instanceof Uint8Array ? c.data : (c instanceof Uint8Array ? c : null);
          if (u8 && u8.length > 0) {
            totalSetBytes += u8.length;
            if (!cubeCache.has(u8)) uncachedSetBytes += u8.length;
            toStage.push({slot: l * numFields + f, u8});
          }
        }
      }
      const maxBytes = getMaxCubeCacheBytes();
      if (totalSetBytes > 0 && totalSetBytes <= maxBytes) {
        if (cubeCacheBytes + uncachedSetBytes > maxBytes) {
          resetWasmCubeCache();
        }
        ptrTable = new Uint32Array(numLevels * numFields);
        for (const item of toStage) {
          const ptr = stageCubeInWasm(item.u8, {allowReset: false});
          if (!ptr) { ptrTable = null; break; }
          ptrTable[item.slot] = ptr;
        }
      }
    }
    meta = {levelN, levelHalf, vminArr, vmaxArr, ptrTable};
    if (ptrTable) cubeSetCache.set(cubes, meta);
  }

  const {levelN, levelHalf, vminArr, vmaxArr, ptrTable} = meta;

  if (wasmExports && ptrTable) {
    {
      // Allocate small scratch buffers for parameters and outputs
      const scratchBytes =
        ptrTable.byteLength +
        levelN.byteLength +
        levelHalf.byteLength +
        vminArr.byteLength +
        vmaxArr.byteLength +
        24 + // p0 + p1
        nSteps * numFields * 4 + // out_samples
        nSteps * 4 + // out_vlos
        nSteps * 4 + 256; // out_temp + alignment padding

      const base = wasmExports.wasm_alloc(scratchBytes);
      if (base) {
        try {
          let off = base;
          const align4 = x => (x + 3) & ~3;

          const ptrsP = off; off = align4(off + ptrTable.byteLength);
          const lvlNP = off; off = align4(off + levelN.byteLength);
          const lvlHP = off; off = align4(off + levelHalf.byteLength);
          const vminP = off; off = align4(off + vminArr.byteLength);
          const vmaxP = off; off = align4(off + vmaxArr.byteLength);
          const p0P = off;   off = align4(off + 12);
          const p1P = off;   off = align4(off + 12);
          const outSampP = off; off = align4(off + nSteps * numFields * 4);
          const outVlosP = off; off = align4(off + nSteps * 4);
          const outTempP = off; off = align4(off + nSteps * 4);

          const mem = wasmExports.memory.buffer;
          new Uint32Array(mem, ptrsP, ptrTable.length).set(ptrTable);
          new Uint32Array(mem, lvlNP, levelN.length).set(levelN);
          new Float32Array(mem, lvlHP, levelHalf.length).set(levelHalf);
          new Float32Array(mem, vminP, vminArr.length).set(vminArr);
          new Float32Array(mem, vmaxP, vmaxArr.length).set(vmaxArr);
          new Float32Array(mem, p0P, 3).set(p0d);
          new Float32Array(mem, p1P, 3).set(p1d);

          wasmExports.wasm_cast_cube_ray(
            ptrsP, lvlNP, lvlHP, vminP, vmaxP, p0P, p1P,
            nSteps, trilinear ? 1 : 0,
            outSampP, outVlosP, outTempP
          );

          const memAfter = wasmExports.memory.buffer;
          const samples = new Float32Array(memAfter, outSampP, nSteps * numFields).slice();
          const vlos = new Float32Array(memAfter, outVlosP, nSteps).slice();
          const temp = new Float32Array(memAfter, outTempP, nSteps).slice();
          return {
            samples, vlos, temp, nSteps, rayLenKpc, dlKpc, dlCm,
            usedWasm: true, ms: nowMs() - t0
          };
        } finally {
          wasmExports.wasm_free(base, scratchBytes);
        }
      }
    }
  }

  // Zero-duplication streaming fallback (used when WASM is unavailable OR when the cube set exceeds the device-aware WASM cache cap)
  const sampler = createStreamingRaySampler({manifest, p0d, p1d, nSteps, trilinear});
  for (let l = numLevels - 1; l >= 0; l--) {
    const L = WASM_LEVEL_KEYS[l];
    const cLvl = cubes[L];
    if (!cLvl) continue;
    for (let f = 0; f < numFields; f++) {
      const fKey = WASM_FIELD_KEYS[f];
      const c = cLvl[fKey];
      const u8 = c?.data instanceof Uint8Array ? c.data : (c instanceof Uint8Array ? c : null);
      if (u8 && u8.length > 0) {
        sampler.ingestCube(l, f, u8, {
          n: c?.n || levelN[l],
          half: c?.half || levelHalf[l],
          vmin: Number.isFinite(c?.vmin) ? c.vmin : vminArr[f],
          vmax: Number.isFinite(c?.vmax) ? c.vmax : vmaxArr[f]
        });
      }
    }
  }
  const res = sampler.finish();
  res.ms = nowMs() - t0;
  return res;
}

// -----------------------------------------------------------------------------
// 2. wasm_synthesize_voigt_12ions
// Real-time 12-ion Faddeeva/Humlicek Voigt optical-depth tau(v) and flux exp(-tau)
// synthesis directly from the ray-marched sightline cells in < 1.0 ms.
// -----------------------------------------------------------------------------
export function wasm_synthesize_voigt_12ions(...args) {
  if (typeof args[0] === "number" && wasmExports) {
    return wasmExports.wasm_synthesize_voigt_12ions(...args);
  }
  const opts = args[0] || {};
  const t0 = nowMs();
  const samples = opts.samples;
  const vlos = opts.vlos;
  const temp = opts.temp;
  const nSteps = opts.nSteps || (vlos ? vlos.length : 512);
  const dlCm = opts.dlCm || CM_PER_KPC;
  const u0 = opts.u0 ?? -1500;
  const du = opts.du ?? 1;
  const nGrid = opts.nGrid ?? 3001;
  const ionDict = opts.ions || null;
  const regKeys = opts.regKeys || WASM_ION_KEYS;
  const wantTau = !!opts.wantTau;

  const numIons = WASM_ION_KEYS.length;
  const atomArr = new Float32Array(numIons * 5);
  for (let i = 0; i < numIons; i++) {
    const k = WASM_ION_KEYS[i];
    const d = DEFAULT_ATOMS[i];
    const custom = ionDict && ionDict[k];
    atomArr[i * 5]     = custom?.lam0_A ?? d.lam0_A;
    atomArr[i * 5 + 1] = custom?.f ?? d.f;
    atomArr[i * 5 + 2] = custom?.gamma_s ?? d.gamma_s;
    atomArr[i * 5 + 3] = custom?.mass_amu ?? d.mass_amu;
    atomArr[i * 5 + 4] = custom?.fit?.b_min ?? custom?.b_min ?? d.b_min;
  }

  if (wasmExports && samples && vlos && temp) {
    const totalFloats =
      samples.length +
      vlos.length +
      temp.length +
      atomArr.length +
      (wantTau ? numIons * nGrid : 0) +
      numIons * nGrid + // flux
      numIons + // logN
      numIons * 15 + // comps
      numIons; // ncomps
    const totalBytes = totalFloats * 4 + 256;
    const base = wasmExports.wasm_alloc(totalBytes);
    if (base) {
      try {
        let off = base;
        const align4 = x => (x + 3) & ~3;
        const sampP = off; off = align4(off + samples.byteLength);
        const vlosP = off; off = align4(off + vlos.byteLength);
        const tempP = off; off = align4(off + temp.byteLength);
        const atomP = off; off = align4(off + atomArr.byteLength);
        const tauP  = wantTau ? off : 0;
        if (wantTau) off = align4(off + numIons * nGrid * 4);
        const fluxP = off; off = align4(off + numIons * nGrid * 4);
        const lognP = off; off = align4(off + numIons * 4);
        const compP = off; off = align4(off + numIons * 15 * 4);
        const ncmpP = off; off = align4(off + numIons * 4);

        const mem = wasmExports.memory.buffer;
        new Float32Array(mem, sampP, samples.length).set(samples);
        new Float32Array(mem, vlosP, vlos.length).set(vlos);
        new Float32Array(mem, tempP, temp.length).set(temp);
        new Float32Array(mem, atomP, atomArr.length).set(atomArr);

        wasmExports.wasm_synthesize_voigt_12ions(
          sampP, vlosP, tempP, nSteps, dlCm, atomP,
          u0, du, nGrid,
          tauP, fluxP, lognP, compP, ncmpP
        );

        const memAfter = wasmExports.memory.buffer;
        const fluxAll = new Float32Array(memAfter, fluxP, numIons * nGrid);
        const tauAll = wantTau ? new Float32Array(memAfter, tauP, numIons * nGrid) : null;
        const lognAll = new Float32Array(memAfter, lognP, numIons);
        const compAll = new Float32Array(memAfter, compP, numIons * 15);
        const ncmpAll = new Uint32Array(memAfter, ncmpP, numIons);

        const lines = {}, logNMap = {}, compRows = {}, aodMap = {}, tauByIon = {};
        for (let i = 0; i < numIons; i++) {
          const k = WASM_ION_KEYS[i];
          if (!regKeys.includes(k)) continue;
          const rest = atomArr[i * 5];
          const flux32 = new Float32Array(fluxAll.subarray(i * nGrid, (i + 1) * nGrid));
          lines[k] = {n: nGrid, u0, du, rest, flux: flux32};
          if (tauAll) {
            tauByIon[k] = new Float32Array(tauAll.subarray(i * nGrid, (i + 1) * nGrid));
          }
          const logN = Math.round(lognAll[i] * 100) / 100;
          logNMap[k] = logN;
          const nc = ncmpAll[i];
          const seeds = [];
          for (let s = 0; s < nc; s++) {
            const sv = compAll[i * 15 + s * 3];
            const sl = compAll[i * 15 + s * 3 + 1];
            const sb = compAll[i * 15 + s * 3 + 2];
            seeds.push([sv, sl, sb]);
          }
          compRows[k] = seeds.map(s => [
            Math.round(s[0] * 10) / 10, 1.0,
            Math.round(s[1] * 100) / 100, 0.08,
            Math.round(s[2] * 10) / 10, 1.5,
            0, 0, null
          ]);
          if (seeds.length) {
            const vlo = Math.max(-1480, Math.floor(Math.min(...seeds.map(s => s[0] - 2.5 * s[2])) - 15));
            const vhi = Math.min(1480, Math.ceil(Math.max(...seeds.map(s => s[0] + 2.5 * s[2])) + 15));
            aodMap[k] = [logN, [[0, vlo, vhi, logN, 0]]];
          } else {
            aodMap[k] = [null, []];
          }
        }
        return {lines, logNMap, compRows, aodMap, tauByIon, usedWasm: true, ms: nowMs() - t0};
      } finally {
        wasmExports.wasm_free(base, totalBytes);
      }
    }
  }

  // Pure-JS fallback using voigtHumlicekJs
  const lines = {}, logNMap = {}, compRows = {}, aodMap = {}, tauByIon = {};
  const numFields = WASM_FIELD_KEYS.length;
  for (let i = 0; i < numIons; i++) {
    const k = WASM_ION_KEYS[i];
    if (!regKeys.includes(k)) continue;
    const lam0 = atomArr[i * 5], fOsc = atomArr[i * 5 + 1], gamma = atomArr[i * 5 + 2];
    const mass = atomArr[i * 5 + 3], bMin = atomArr[i * 5 + 4];
    const byV = new Map();
    let totN = 0;
    const fieldIdx = 3 + i;
    for (let s = 0; s < nSteps; s++) {
      const lgN = samples[s * numFields + fieldIdx];
      if (!Number.isFinite(lgN)) continue;
      const dN = (10 ** lgN) * dlCm;
      if (!(dN > 0)) continue;
      totN += dN;
      const b2 = Math.max(bMin * bMin, 0.016629 * temp[s] / mass + 64);
      const vb = Math.round(vlos[s] / 2) * 2;
      const cur = byV.get(vb);
      if (cur) { cur.vN += vlos[s] * dN; cur.b2N += b2 * dN; cur.N += dN; }
      else byV.set(vb, {vN: vlos[s] * dN, b2N: b2 * dN, N: dN});
    }
    const vComps = [];
    for (const c of byV.values()) {
      if (c.N > 1e8) vComps.push([c.vN / c.N, Math.log10(c.N), Math.min(180, Math.sqrt(c.b2N / c.N)), c.N]);
    }
    const lamCm = lam0 * 1e-8;
    const kTau = SIGMA0 * fOsc * lamCm / (SQPI * 1e5);
    const a0 = gamma * lamCm / (4 * Math.PI * 1e5);
    const tau = new Float32Array(nGrid);
    for (const c of vComps) {
      const vc = c[0], b = c[2], Nc = c[3];
      const ib = 1 / b, ampIb = kTau * Nc * ib, a = a0 * ib;
      const wingC = ampIb * a * ISQPI;
      const xWing = wingC > 1e-8 * 225 ? Math.min(10000, Math.sqrt(wingC * 1e8)) : 15;
      const i0 = Math.max(0, Math.floor((vc - xWing * b - u0) / du));
      const i1 = Math.min(nGrid - 1, Math.ceil((vc + xWing * b - u0) / du));
      for (let j = i0; j <= i1; j++) {
        const v = u0 + j * du;
        tau[j] += ampIb * voigtHumlicekJs((v - vc) * ib, a);
      }
    }
    const flux = new Float64Array(nGrid);
    for (let j = 0; j < nGrid; j++) flux[j] = Math.exp(-tau[j]);
    if (wantTau) tauByIon[k] = tau;
    lines[k] = {n: nGrid, u0, du, rest: lam0, flux};
    const logN = totN > 0 ? Math.round(Math.log10(totN) * 100) / 100 : 10.0;
    logNMap[k] = logN;
    const sortedC = [...vComps].sort((a, b) => b[1] - a[1]);
    const seeds = [];
    for (const c of sortedC) {
      if (c[1] < 11.2) continue;
      const hit = seeds.find(s => Math.abs(s[0] - c[0]) < Math.max(18, 1.2 * s[2]));
      if (hit) {
        const n1 = 10 ** hit[1], n2 = 10 ** c[1], ns = n1 + n2;
        hit[0] = (hit[0] * n1 + c[0] * n2) / ns;
        hit[1] = Math.log10(ns);
        hit[2] = Math.min(180, Math.sqrt((hit[2] * hit[2] * n1 + c[2] * c[2] * n2) / ns));
      } else if (seeds.length < 5) seeds.push([c[0], c[1], c[2]]);
    }
    seeds.sort((a, b) => a[0] - b[0]);
    compRows[k] = seeds.map(s => [
      Math.round(s[0] * 10) / 10, 1.0,
      Math.round(s[1] * 100) / 100, 0.08,
      Math.round(s[2] * 10) / 10, 1.5,
      0, 0, null
    ]);
    if (seeds.length) {
      const vlo = Math.max(-1480, Math.floor(Math.min(...seeds.map(s => s[0] - 2.5 * s[2])) - 15));
      const vhi = Math.min(1480, Math.ceil(Math.max(...seeds.map(s => s[0] + 2.5 * s[2])) + 15));
      aodMap[k] = [logN, [[0, vlo, vhi, logN, 0]]];
    } else aodMap[k] = [null, []];
  }
  return {lines, logNMap, compRows, aodMap, tauByIon, usedWasm: false, ms: nowMs() - t0};
}

// -----------------------------------------------------------------------------
// 3. wasm_decode_lut_volume
// Fast SIMD128 LUT dequantization for 3D volume slices.
// Supports:
// - Raw pointer invocation: wasm_decode_lut_volume(qPtr, len, vmin, vmax, mode, lutRgbaPtr, outPtr)
// - High-level TypedArray invocation: wasm_decode_lut_volume(q, vmin, vmax, {mode = 0, lutRgba = null})
// -----------------------------------------------------------------------------
export function wasm_decode_lut_volume(...args) {
  if (typeof args[0] === "number" && wasmExports) {
    return wasmExports.wasm_decode_lut_volume(...args);
  }
  const [q, vmin = 0, vmax = 1, opts = {}] = args;
  if (!(q instanceof Uint8Array)) throw new Error("wasm_decode_lut_volume: expected Uint8Array");
  const len = q.length;
  const mode = opts.mode ?? 0;
  const lutRgba = opts.lutRgba || null;

  if (len === 0) {
    return mode === 2 ? new Uint8Array(0) : new Float32Array(0);
  }

  if (wasmExports) {
    const lutBytes = mode === 2 && lutRgba ? 1024 : 0;
    const totalBytes = len + lutBytes + len * 4 + 64;
    const base = wasmExports.wasm_alloc(totalBytes);
    if (base) {
      try {
        const align4 = x => (x + 3) & ~3;
        let off = base;
        const qP = off; off = align4(off + len);
        const lutP = lutBytes ? off : 0;
        if (lutBytes) off = align4(off + lutBytes);
        const outP = off;

        const mem = wasmExports.memory.buffer;
        new Uint8Array(mem, qP, len).set(q);
        if (lutBytes) {
          new Uint8Array(mem, lutP, 1024).set(
            lutRgba instanceof Uint8Array ? lutRgba.subarray(0, 1024) : new Uint8Array(lutRgba.buffer, lutRgba.byteOffset, 1024)
          );
        }

        wasmExports.wasm_decode_lut_volume(qP, len, vmin, vmax, mode, lutP, outP);
        const memAfter = wasmExports.memory.buffer;
        if (mode === 2) {
          return new Uint8Array(memAfter, outP, len * 4).slice();
        }
        return new Float32Array(memAfter, outP, len).slice();
      } finally {
        wasmExports.wasm_free(base, totalBytes);
      }
    }
  }

  // Pure-JS LUT fallback
  if (mode === 2 && lutRgba) {
    const src32 = new Uint32Array(lutRgba.buffer, lutRgba.byteOffset, 256);
    const out8 = new Uint8Array(len * 4);
    const out32 = new Uint32Array(out8.buffer);
    for (let i = 0; i < len; i++) out32[i] = src32[q[i]];
    return out8;
  }
  const lut = new Float32Array(256);
  const s = (vmax - vmin) / 254.0;
  if (mode === 1) {
    lut[0] = 0.0;
    for (let i = 1; i < 256; i++) lut[i] = 10 ** (vmin + (i - 1) * s);
  } else {
    lut[0] = NaN;
    for (let i = 1; i < 256; i++) lut[i] = vmin + (i - 1) * s;
  }
  const out = new Float32Array(len);
  for (let i = 0; i < len; i++) out[i] = lut[q[i]];
  return out;
}

// Fast SIMD velocity packer wrapper (qx, qy, qz -> 4*N RGBA8 Uint8Array)
export function wasm_pack_velocity(qx, qy, qz) {
  const N = qx.length;
  if (qy.length !== N || qz.length !== N) {
    throw new Error("packVelocity: the component cubes differ in size");
  }
  if (wasmExports && N > 0) {
    const totalBytes = N * 7 + 64;
    const base = wasmExports.wasm_alloc(totalBytes);
    if (base) {
      try {
        const align4 = x => (x + 3) & ~3;
        let off = base;
        const px = off; off = align4(off + N);
        const py = off; off = align4(off + N);
        const pz = off; off = align4(off + N);
        const po = off;
        const mem = wasmExports.memory.buffer;
        new Uint8Array(mem, px, N).set(qx);
        new Uint8Array(mem, py, N).set(qy);
        new Uint8Array(mem, pz, N).set(qz);
        wasmExports.wasm_pack_velocity(px, py, pz, N, po);
        return new Uint8Array(wasmExports.memory.buffer, po, 4 * N).slice();
      } finally {
        wasmExports.wasm_free(base, totalBytes);
      }
    }
  }
  const out = new Uint8Array(4 * N);
  for (let i = 0, o = 0; i < N; i++, o += 4) {
    const a = qx[i], b = qy[i], c = qz[i];
    if (a === 0 || b === 0 || c === 0) {
      out[o] = out[o + 1] = out[o + 2] = 128;
      out[o + 3] = 0;
    } else {
      out[o] = a;
      out[o + 1] = b;
      out[o + 2] = c;
      out[o + 3] = 255;
    }
  }
  return out;
}
