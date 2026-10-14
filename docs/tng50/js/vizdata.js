// Pure data helpers for the Phase-2b 3D viewer (design §5.1): the tng50-viz/2 manifest, WebP atlas -> raw cube
// bytes, gzip, SHA-256, u8 decoding, the LOD policy and the Lupton et al. (2004) asinh composite.
// No DOM and no three.js: everything here also runs in node (tests/js/viz_decode.mjs, lod_policy.mjs, lupton_parity.mjs).
export const SCHEMA = "tng50-viz/2";
export const VOL_KEYS = ["nH", "T", "Z", "OVI", "HI", "CIII"];
export const GAS_LEVELS = {L0: 400.0, L1: 100.0, L2: 25.0};
export const STAR_LEVELS = {S0: 400.0, S1: 100.0, S2: 25.0};
export const MU_ZERO = 36.57212566588;                 // mag arcsec^-2 of 1 L_AB0 per kpc^2 (design §2.7)
export const CM_PER_KPC = 3.0856775814913673e21;
export const LUT_NAMES = ["tng_dusk", "tng_ice", "magma", "inferno", "viridis", "cividis", "grey"];

const isNum = x => typeof x === "number" && Number.isFinite(x);
const isInt = x => Number.isInteger(x);
const isStr = x => typeof x === "string";
const isObj = x => x !== null && typeof x === "object" && !Array.isArray(x);
const isHex = (x, n) => isStr(x) && new RegExp(`^[0-9a-f]{${n}}$`).test(x);
const isVec = (x, n) => Array.isArray(x) && x.length === n && x.every(isNum);

/* final: a timeout, so a ?viz= host that accepts the connection and never answers ends in an error (and a stage message)
   instead of a 3D tab that stays blank. opts.fetchText(url, timeoutMs) -> text is the page's network helper (vizload.js
   fetchText, i.e. netFetch with its stall timer); without it, a plain fetch with an AbortController deadline (node, tests).
   The error carries .timeout or .network, so the caller can tell an unreachable host from a bad manifest. */
export async function loadManifestV2(url, {timeoutMs = 10000, fetchText = null} = {}) {
  let host = "the host"; try { host = new URL(url).host; } catch { /* keep */ }
  let txt;
  if (fetchText) {
    try { txt = await fetchText(url, timeoutMs); }
    catch (x) { const e = new Error(`viz manifest: ${x.timeout ? `no answer from ${host} within ${Math.round(timeoutMs / 1000)} s` : x.http ? `HTTP ${x.http}` : x.message}`);
      e.timeout = !!x.timeout; e.network = !!(x.timeout || x.network || x instanceof TypeError); e.http = x.http; throw e; }
  } else {
    const ac = new AbortController(), t = setTimeout(() => ac.abort(), timeoutMs);
    try { const r = await fetch(url, {cache: "no-cache", signal: ac.signal});
      if (!r.ok) throw Object.assign(new Error(`viz manifest: HTTP ${r.status}`), {http: r.status});
      txt = await r.text(); }
    catch (x) { if (ac.signal.aborted) throw Object.assign(new Error(`viz manifest: no answer from ${host} within ${Math.round(timeoutMs / 1000)} s`), {timeout: true, network: true});
      if (x instanceof TypeError) x.network = true; throw x; }
    finally { clearTimeout(t); }
  }
  let m; try { m = JSON.parse(txt); } catch { throw new Error("viz manifest: not valid JSON"); }
  validateManifestV2(m);
  return m;
}

/* Mirrors tngsight.vizpack.validate_manifest_v2's key/type checks (design §3.3); throws Error naming the first problem. */
export function validateManifestV2(m) {
  const bad = (where, what) => { throw new Error(`viz manifest: ${where}: ${what}`); };
  const need = (o, where, keys) => { if (!isObj(o)) bad(where, "missing or not an object"); for (const [k, t] of keys) if (!t(o[k])) bad(`${where}.${k}`, "missing or wrong type"); };
  if (!isObj(m)) bad("root", "not an object");
  if (m.schema !== SCHEMA) bad("schema", `expected "${SCHEMA}", got ${JSON.stringify(m.schema)}`);
  need(m, "root", [["created", isStr], ["generator", isObj], ["galaxy", isObj], ["frame", isObj], ["order", isStr], ["kernel", isObj],
    ["encoding", isObj], ["formats", isObj], ["levels", isObj], ["gas", isObj], ["stars", isObj]]);
  need(m.galaxy, "galaxy", [["subhalo_id", isInt], ["TNG_H", isNum], ["R200c_kpc", isNum], ["center_kpc", x => isVec(x, 3)],
    ["Lhat", x => isVec(x, 3)], ["xhat", x => isVec(x, 3)], ["yhat", x => isVec(x, 3)]]);
  need(m.frame, "frame", [["name", isStr], ["rows", x => Array.isArray(x) && x.length === 3 && x.every(r => isVec(r, 3))]]);
  need(m.encoding, "encoding", [["type", x => x === "log10-u8"], ["empty", x => x === 0], ["q_min", x => x === 1], ["q_max", x => x === 255]]);
  need(m.formats, "formats", [["webp", isObj], ["gz", isObj]]);
  need(m.formats.webp, "formats.webp", [["parts", x => x === 4], ["slices_per_part", x => x === 64], ["cols", x => x === 16], ["rows", x => x === 4]]);
  const levelKeys = Object.keys(m.levels);
  for (const L of levelKeys) {
    if (!/^[LS][012]$/.test(L)) bad(`levels.${L}`, "unknown level");
    need(m.levels[L], `levels.${L}`, [["half_kpc", isNum], ["n", x => isInt(x) && x > 0], ["voxel_kpc", isNum], ["r_mask_kpc", x => x === null || isNum(x)]]);
    const v = m.levels[L]; if (Math.abs(v.voxel_kpc - 2 * v.half_kpc / v.n) > 1e-9 * v.half_kpc) bad(`levels.${L}.voxel_kpc`, "≠ 2·half_kpc/n");
  }
  const cube = (c, where, kind, L, vmin, vmax) => {
    need(c, where, [["vmin", isNum], ["vmax", isNum], ["raw_bytes", isInt], ["raw_sha256", x => isHex(x, 64)], ["webp", isObj], ["gz", isObj], ["stats", isObj], ["deposit", isObj]]);
    if (!(c.vmax > c.vmin)) bad(where, "vmax ≤ vmin");
    if (vmin !== undefined && (c.vmin !== vmin || c.vmax !== vmax)) bad(where, "cube vmin/vmax differ from the field's");
    const n = m.levels[L]?.n; if (!n) bad(where, `level ${L} not in levels`);
    if (c.raw_bytes !== (kind === "stars" ? 4 : 1) * n * n * n) bad(`${where}.raw_bytes`, `expected ${(kind === "stars" ? "4·" : "") + n}³`);
    need(c.webp, `${where}.webp`, [["paths", x => Array.isArray(x) && x.length === 4 && x.every(isStr)], ["bytes", x => Array.isArray(x) && x.length === 4 && x.every(isInt)],
      ["sha256", x => Array.isArray(x) && x.length === 4 && x.every(s => isHex(s, 64))]]);
    need(c.gz, `${where}.gz`, [["path", isStr], ["bytes", isInt], ["sha256", x => isHex(x, 64)]]);
    const id12 = c.raw_sha256.slice(0, 12), stem = where.startsWith("gas") ? `gas/${L}/${where.split(".")[2]}` : `stars/${L}/gri`;
    c.webp.paths.forEach((p, i) => { if (p !== `${stem}.${id12}.p${i}.webp`) bad(`${where}.webp.paths[${i}]`, `expected ${stem}.${id12}.p${i}.webp`); });
    if (c.gz.path !== `${stem}.${id12}.${kind === "stars" ? "rgba" : "u8"}.gz`) bad(`${where}.gz.path`, "does not follow the §2.6 naming");
  };
  need(m.gas, "gas", [["levels", x => Array.isArray(x) && x.every(L => /^L[012]$/.test(L))], ["fields", isObj]]);
  for (const [k, f] of Object.entries(m.gas.fields)) {
    const w = `gas.fields.${k}`;
    if (!VOL_KEYS.includes(k)) bad(w, "unknown field");
    need(f, w, [["label", isStr], ["units", isStr], ["kind", x => ["density", "mass_weighted"].includes(x)], ["vmin", isNum], ["vmax", isNum],
      ["cmap", isStr], ["proj", isObj], ["vol_window", x => isVec(x, 2)], ["cubes", isObj]]);
    need(f.proj, `${w}.proj`, [["kind", x => ["column", "weighted_mean"].includes(x)], ["vmin", isNum], ["vmax", isNum]]);
    if (!(f.proj.vmax > f.proj.vmin)) bad(`${w}.proj`, "vmax ≤ vmin");
    for (const L of m.gas.levels) cube(f.cubes[L], `${w}.cubes.${L}`, "gas", L, f.vmin, f.vmax);
  }
  need(m.stars, "stars", [["levels", x => Array.isArray(x) && x.every(L => /^S[012]$/.test(L))], ["bands", x => Array.isArray(x) && x.join() === "i,r,g"],
    ["display", isObj], ["cubes", isObj]]);
  need(m.stars.display, "stars.display", [["Q", isNum], ["mu0", isNum], ["mu_zero", isNum], ["balance", x => isVec(x, 3)]]);
  for (const L of m.stars.levels) cube(m.stars.cubes[L], `stars.cubes.${L}`, "stars", L);
  if (m.luts !== undefined) need(m.luts, "luts", [["path", isStr], ["sha256", x => isHex(x, 64)], ["names", x => Array.isArray(x) && x.every(isStr)]]);
}

export function cubeRef(manifest, kind, key, level) {
  const c = kind === "stars" ? manifest?.stars?.cubes?.[level] : manifest?.gas?.fields?.[key]?.cubes?.[level];
  if (!c) throw new Error(`no ${kind === "stars" ? "star" : key} cube at ${level}`);
  return c;
}
export function cubeUrls(cube, base) { return {webp: cube.webp.paths.map(p => base + p), gz: base + cube.gz.path}; }

/* §2.4 inverse. parts: 4 RGBA image-data arrays (16n × 4n px each). Gas -> n³ bytes (R channel); stars -> 4n³ RGBA,
   A = 255 if any of R, G, B > 0. Slice k lives in part k >> 6, tile (column s % 16, row s >> 4) with s = k & 63. */
export function atlasToRaw(parts, n, kind) {
  const W = 16 * n, H = 4 * n, stars = kind === "stars", out = new Uint8Array((stars ? 4 : 1) * n * n * n);
  if (!Array.isArray(parts) || parts.length !== 4) throw new Error("atlasToRaw: expected 4 parts");
  parts.forEach((p, i) => { if (!p || p.length !== W * H * 4) throw new Error(`atlasToRaw: part ${i} has ${p?.length} bytes, expected ${W}×${H}×4`); });
  for (let k = 0; k < n; k++) {
    const P = parts[k >> 6], s = k & 63, x0 = (s & 15) * n, y0 = (s >> 4) * n;
    for (let j = 0; j < n; j++) {
      let src = ((y0 + j) * W + x0) * 4, dst = n * (j + n * k);
      if (!stars) for (let i = 0; i < n; i++, src += 4) out[dst + i] = P[src];
      else for (let i = 0, d = 4 * dst; i < n; i++, src += 4, d += 4) {
        const r = P[src], g = P[src + 1], b = P[src + 2]; out[d] = r; out[d + 1] = g; out[d + 2] = b; out[d + 3] = (r | g | b) ? 255 : 0; }
    }
  }
  return out;
}

/* gzip (1f 8b) -> DecompressionStream; anything else is taken as already decoded (a server applied Content-Encoding) */
export async function gunzipIfNeeded(buf) {
  const u = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  if (!(u.length >= 2 && u[0] === 0x1f && u[1] === 0x8b)) return u;
  if (typeof DecompressionStream === "undefined") throw new Error("this browser cannot decode the volumes");
  const out = await new Response(new Blob([u]).stream().pipeThrough(new DecompressionStream("gzip"))).arrayBuffer();
  return new Uint8Array(out);
}

/* SHA-256 hex: crypto.subtle when present (secure contexts), else a plain JS implementation (http pages). */
export async function sha256Hex(u8) {
  const s = globalThis.crypto?.subtle;
  if (s) { const d = new Uint8Array(await s.digest("SHA-256", u8)); return Array.from(d, b => b.toString(16).padStart(2, "0")).join(""); }
  return sha256Js(u8);
}
const K256 = new Uint32Array([0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5, 0xd807aa98, 0x12835b01,
  0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa,
  0x5cb0a9dc, 0x76f988da, 0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138,
  0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624,
  0xf40e3585, 0x106aa070, 0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f,
  0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2]);
export function sha256Js(u8) {
  const H = new Uint32Array([0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19]);
  const n = u8.length, tail = new Uint8Array(((n + 9 + 63) >> 6) * 64 - (n & ~63)), W = new Uint32Array(64);
  tail.set(u8.subarray(n & ~63)); tail[n & 63] = 0x80;
  const bits = n * 8, dv = new DataView(tail.buffer); dv.setUint32(tail.length - 8, Math.floor(bits / 2 ** 32)); dv.setUint32(tail.length - 4, bits >>> 0);
  const block = (b, o) => {
    for (let t = 0; t < 16; t++) W[t] = (b[o + 4 * t] << 24) | (b[o + 4 * t + 1] << 16) | (b[o + 4 * t + 2] << 8) | b[o + 4 * t + 3];
    for (let t = 16; t < 64; t++) { const x = W[t - 15], y = W[t - 2];
      W[t] = (((x >>> 7) | (x << 25)) ^ ((x >>> 18) | (x << 14)) ^ (x >>> 3)) + W[t - 7] + (((y >>> 17) | (y << 15)) ^ ((y >>> 19) | (y << 13)) ^ (y >>> 10)) + W[t - 16]; }
    let [a, bb, c, d, e, f, g, h] = H;
    for (let t = 0; t < 64; t++) {
      const t1 = (h + (((e >>> 6) | (e << 26)) ^ ((e >>> 11) | (e << 21)) ^ ((e >>> 25) | (e << 7))) + ((e & f) ^ (~e & g)) + K256[t] + W[t]) | 0;
      const t2 = ((((a >>> 2) | (a << 30)) ^ ((a >>> 13) | (a << 19)) ^ ((a >>> 22) | (a << 10))) + ((a & bb) ^ (a & c) ^ (bb & c))) | 0;
      h = g; g = f; f = e; e = (d + t1) | 0; d = c; c = bb; bb = a; a = (t1 + t2) | 0; }
    H[0] += a; H[1] += bb; H[2] += c; H[3] += d; H[4] += e; H[5] += f; H[6] += g; H[7] += h; };
  for (let o = 0; o + 64 <= (n & ~63); o += 64) block(u8, o);
  for (let o = 0; o < tail.length; o += 64) block(tail, o);
  return Array.from(H, x => x.toString(16).padStart(8, "0")).join("");
}

export function decodeU8(q, vmin, vmax) {
  const out = new Float32Array(q.length), s = (vmax - vmin) / 254;
  for (let i = 0; i < q.length; i++) out[i] = q[i] === 0 ? NaN : vmin + (q[i] - 1) * s;
  return out;
}

/* LOD policy (design §5.4). Returns the levels to load, in load order; `parallel` = load them at once. The caller
   loads stars only while the star layer is on. */
export function levelForView({hVisKpc, mobile = false, deviceMemory = 8} = {}) {
  const h = Number.isFinite(hVisKpc) ? hVisKpc : 153;
  /* tune2: mobile loads L2 / S2 below hVis 60 kpc (was 40), so 10-20 kpc disk views are not L1 / S1 magnified */
  if (mobile) return {gas: h < 60 ? ["L1", "L0", "L2"] : ["L1", "L0"], stars: h < 60 ? ["S1", "S2"] : ["S1"], parallel: false};
  const parallel = (deviceMemory ?? 8) >= 4;
  return {gas: ["L1", "L0", "L2"], stars: h > 150 ? ["S1", "S2", "S0"] : ["S1", "S2"], parallel};
}

/* final (cold first load): the staged load plan for the current view, in priority order. The gas field at L0 comes first
   (the viewer draws as soon as it alone is decoded), then L1, then the star level the view resolves (S1), and only then the
   levels a zoomed-in or zoomed-out view adds: L2 / S2 once their voxel is at least one LOD footprint wide on screen
   (ratio ≥ 1, the shader's lodLevel rule; mobile also needs hVis < 60 kpc), S0 when hVis > 150 kpc (desktop only).
   ratio = {L1, L2, S1, S2}: voxel size / (LOD constant × kpc per drawing-buffer pixel at the box's nearest point).
   L1 is skipped only in very wide views where its voxel is under half a footprint (ratio < 0.5). Other fields are never
   in the plan: they load when they are selected. */
export function viewPlan({ratio = {}, hVisKpc, mobile = false, stars = false} = {}) {
  const h = Number.isFinite(hVisKpc) ? hVisKpc : 153, r = k => (Number.isFinite(ratio[k]) ? ratio[k] : 0);
  const fine = !mobile || h < 60;
  const gas = ["L0"], st = [];
  if (!Number.isFinite(ratio.L1) || r("L1") >= 0.5) gas.push("L1");
  if (stars) st.push("S1");
  const order = [...gas.map(L => ["gas", L]), ...st.map(S => ["stars", S])];
  if (fine && r("L2") >= 1) order.push(["gas", "L2"]);
  if (stars && fine && r("S2") >= 1) order.push(["stars", "S2"]);
  if (stars && !mobile && h > 150) order.push(["stars", "S0"]);
  return {order, gas: order.filter(o => o[0] === "gas").map(o => o[1]), stars: order.filter(o => o[0] === "stars").map(o => o[1])};
}

/* Lupton et al. (2004) asinh composite, design §4.5: surface brightnesses S_b [L_AB0 kpc^-2] -> sRGB values 0..1. */
export function lupton(Si, Sr, Sg, {Q = 8.0, mu0 = 21.5, balance = [1, 1, 1]} = {}) {
  const S0 = 10 ** (0.4 * (MU_ZERO - mu0));
  let R = balance[0] * Si / S0, G = balance[1] * Sr / S0, B = balance[2] * Sg / S0;
  const I = (R + G + B) / 3, F = I > 0 ? Math.asinh(Q * I) / (Q * I) : 0;
  R *= F; G *= F; B *= F;
  const m = Math.max(R, G, B); if (m > 1) { R /= m; G /= m; B /= m; }
  return [R, G, B];
}

/* tune2 display prefilter (viewer only; the hosted bytes and their sha256 are unchanged). Decodes a log10-u8 cube to
   linear values, applies `passes` separable [1, 2, 1]/4 passes along x, y and z (σ = sqrt(passes / 2) voxels; mirrored
   edges, so the sum is kept) and re-encodes with the same vmin/vmax; values below half the vmin value become empty
   (q = 0). ch = 1: a gas cube (n³ bytes); ch = 4: a star cube (RGBA, n³·4 bytes, R/G/B smoothed independently,
   A = 255 where any of them is > 0). Returns a new Uint8Array. */
export function smoothCube(q, n, vmin, vmax, passes = 2, ch = 1) {
  const N = n * n * n, span = vmax - vmin, dec = new Float32Array(256);
  for (let i = 1; i < 256; i++) dec[i] = 10 ** ((i - 1) * span / 254 - span);   // normalised to 10^vmax
  const f = new Float32Array(N), line = new Float32Array(n), out = new Uint8Array(N * ch), lo = 0.5 * dec[1], k = 254 / span, LN10 = Math.LN10;
  for (let c = 0; c < Math.min(ch, 3); c++) {
    for (let i = 0; i < N; i++) f[i] = dec[q[i * ch + c]];
    for (let p = 0; p < passes; p++) for (const st of [1, n, n * n]) {
      for (let a = 0; a < n; a++) for (let b = 0; b < n; b++) {
        const base = st === 1 ? n * (a + n * b) : st === n ? a + n * n * b : a + n * b;
        for (let i = 0; i < n; i++) line[i] = f[base + i * st];
        for (let i = 0; i < n; i++) { const l = line[i > 0 ? i - 1 : 1], r = line[i < n - 1 ? i + 1 : n - 2]; f[base + i * st] = 0.25 * (l + r) + 0.5 * line[i]; }
      }
    }
    for (let i = 0; i < N; i++) { const v = f[i]; if (!(v >= lo)) continue;
      const x = Math.round((Math.log(v) / LN10 + span) * k) + 1; out[i * ch + c] = x < 1 ? 1 : x > 255 ? 255 : x; }
  }
  if (ch === 4) for (let i = 0; i < N; i++) out[4 * i + 3] = (out[4 * i] | out[4 * i + 1] | out[4 * i + 2]) ? 255 : 0;
  return out;
}
