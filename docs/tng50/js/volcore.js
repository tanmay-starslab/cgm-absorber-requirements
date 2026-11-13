// Headless volume core shared by the explainer's 3D stage (explainer v2, U_stage; DESIGN_final §3.4, C_eng P1-3).
// It holds the GPU residency of the explorer's gas cubes (L0 ±400, L1 ±100, optional L2 ±25 kpc; vizload.js loader, same
// manifest, same content-hashed files and CacheStorage as the explorer) and binds them to the uniforms of raymarch.js's
// makeMaterial / makeStoryMaterial. viewer3d.js keeps its own copy of this logic (the explorer is unchanged); this module
// is what the story uses, written so the explorer could adopt it later.
//
// What it adds over viewer3d.js:
// - sliced uploads: a level is allocated with texStorage3D (three: source.dataReady = false) and filled with texSubImage3D
//   (renderer.copyTextureToTexture3D) in batches of `slices` z-slices, at most `budgetMs` per frame in pump(), so a 16.7 MB
//   field (67 MB packed velocity) never makes a long task on the main thread; a level is bound only once complete;
// - priorities and prefetch: request(field, level, prio) is idempotent; lower prio loads and uploads first;
// - the packed velocity cube comes from vizload.packVelocityOffThread (a worker), not the main thread;
// - synthetic levels for tests (setSynthetic), no DOM.
//
// API: createVolCore({T, renderer, manifest, base, fallbackBase, cache, budgetBytes, slices, budgetMs}) -> core
//   core.request(field, level, prio = 1) -> Promise<entry>       field: a manifest gas field key or "vel"
//   core.has(field, level) -> bool (resident and complete)        core.state(field, level) -> "absent"|"loading"|"uploading"|"ready"|"failed"
//   core.pump(nowMs?) -> {uploadedSlices, ms}                     call once per frame before drawing
//   core.bind(U, {color, weight, vel}) -> {color, weight}         sets uGas*/uW*/uVel*, *Have and ranges; returns the levels bound
//   core.field(key) -> manifest field meta                        core.gpuBytes(), core.stats, core.dispose()
//   core.setSynthetic(field, level, Uint8Array, {vmin, vmax})     test hook: a resident level without a network load
//   core.prewarm({r8, rgba, n, yieldFn}) -> Promise                allocate and first-touch a texture pool (behind the gate)
//   core.drop(field, level)                                        release one level (its texture returns to the pool)
import {makeLoader, packVelocityOffThread} from "./vizload.js";
import {VEL_COMP_KEYS} from "./vizdata.js";

export const LEVELS = ["L0", "L1", "L2"];
export const SLICES_DEFAULT = 16, BUDGET_MS_DEFAULT = 4;

export function createVolCore({T, renderer, manifest, base = "", fallbackBase = null, cache = true, budgetBytes = 448e6,
  slices = SLICES_DEFAULT, budgetMs = BUDGET_MS_DEFAULT, loader = null, pool = null, diag = false, fence = false, onQueued = null} = {}) {
  const ld = loader || (manifest ? makeLoader({manifest, base, fallbackBase, cache}) : null);
  const E = new Map();               // key "field|L" -> entry
  const stats = {loads: [], uploads: [], maxPumpMs: 0, maxSliceMs: 0};
  const key = (f, L) => `${f}|${L}`;
  const field = k => (k === "vel" ? {vmin: -(manifest?.gas?.vectors?.v?.V || 600), vmax: manifest?.gas?.vectors?.v?.V || 600}
    : manifest?.gas?.fields?.[k] || E.get(key(k, "L0"))?.meta || E.get(key(k, "L1"))?.meta || null);
  const nOf = L => manifest?.levels?.[L]?.n || 256;
  let uploadQ = [];                  // entries in state "uploading", ordered by prio then request time
  let seq = 0;

  /* texture pool (S0 finding): the first write into a freshly allocated 3D texture makes the driver zero-initialise all of it
     (ANGLE/Vulkan on an A100: up to 500 ms for a 67 MB RGBA level; SwiftShader ~35 ms for any size), a long task no slicing
     avoids. prewarm() allocates and touches the pool's textures once, behind the gate; later loads reuse a free slot (an
     evicted level's texture goes back to the pool), so no first touch happens in flight. Without a free slot a fresh texture
     is allocated (and pays the first touch). */
  const free = {r8: [], rgba: []}; let poolN = 0;
  function newTex(n, rgba) {
    const dst = new T.Data3DTexture(null, n, n, n);
    dst.format = rgba ? T.RGBAFormat : T.RedFormat; dst.type = T.UnsignedByteType; dst.minFilter = dst.magFilter = T.LinearFilter;
    dst.wrapS = dst.wrapT = dst.wrapR = T.ClampToEdgeWrapping; dst.unpackAlignment = 1; dst.generateMipmaps = false;
    dst.image = {data: null, width: n, height: n, depth: n}; dst.source.dataReady = false; dst.needsUpdate = true;
    renderer.initTexture(dst);                         // texStorage3D only (dataReady false): no upload
    return dst;
  }
  /* write slices z0..z1 of data (n³·c bytes) into tex: raw texSubImage3D on a subarray, bound through three's state tracker;
     the stub renderers of the unit tests (no properties) use copyTextureToTexture3D */
  function putSlices(tex, data, n, c, z0, z1, src) {
    const gl = renderer.getContext?.(), wt = gl && renderer.properties?.get(tex).__webglTexture;
    if (!wt) { renderer.copyTextureToTexture3D(src, tex, new T.Box3(new T.Vector3(0, 0, z0), new T.Vector3(n, n, z1)), new T.Vector3(0, 0, z0), 0); return; }
    renderer.state.bindTexture(gl.TEXTURE_3D, wt); gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    gl.texSubImage3D(gl.TEXTURE_3D, 0, 0, 0, z0, n, n, z1 - z0, c === 4 ? gl.RGBA : gl.RED, gl.UNSIGNED_BYTE, data.subarray(z0 * n * n * c, z1 * n * n * c));
    renderer.state.unbindTexture();
  }
  /* allocate + touch k R8 and m RGBA slots of size n, one per animation frame (yield) */
  async function prewarm({r8 = 0, rgba = 0, n = nOf("L0"), yieldFn = null} = {}) {
    const t0 = now(), zero = {r8: new Uint8Array(n * n), rgba: new Uint8Array(4 * n * n)};
    for (const [kind, k] of [["r8", r8], ["rgba", rgba]]) for (let i = 0; i < k; i++) {
      const tex = newTex(n, kind === "rgba"), src = new T.Data3DTexture(zero[kind], n, n, 1); src.format = tex.format; src.unpackAlignment = 1;
      putSlices(tex, zero[kind], n, kind === "rgba" ? 4 : 1, 0, 1, src); tex.userData = {pool: kind, n}; free[kind].push(tex); poolN++;
      if (yieldFn) await yieldFn(); }
    stats.prewarmMs = Math.round(now() - t0); stats.pool = {r8: free.r8.length, rgba: free.rgba.length};
  }
  function allocate(e, n, data, rgba) {
    const kind = rgba ? "rgba" : "r8", fit = t => t.userData?.pool === kind && t.userData.n === n;
    if (!free[kind].some(fit) && poolN) {            // pool exhausted: recycle the least recently used unpinned level of this kind
      const v = [...E.values()].filter(x => x.state === "ready" && x.tex && fit(x.tex) && !pinned.has(key(x.field, x.level))).sort((a, b) => a.used - b.used)[0];
      if (v) { release(v); E.delete(key(v.field, v.level)); stats.recycled = (stats.recycled || 0) + 1; } }
    const fi = free[kind].findIndex(fit);
    const dst = fi >= 0 ? free[kind].splice(fi, 1)[0] : newTex(n, rgba);
    e.pooled = fi >= 0;
    const src = new T.Data3DTexture(data, n, n, n); src.format = dst.format; src.type = dst.type; src.unpackAlignment = 1;
    Object.assign(e, {tex: dst, src, n, z: 0, bytes: data.length, state: "uploading"});
    uploadQ.push(e); uploadQ.sort((a, b) => a.prio - b.prio || a.seq - b.seq);
    // a level that finishes loading while the host's render loop is idle must wake it, or nobody pumps uploadQ (story review T1)
    if (onQueued) try { onQueued(e); } catch (x) { /* host callback optional */ }
  }

  function request(f, L, prio = 1) {
    const k = key(f, L); let e = E.get(k);
    if (e) { if (prio < e.prio) { e.prio = prio; uploadQ.sort((a, b) => a.prio - b.prio || a.seq - b.seq); } e.used = now(); return e.promise; }
    e = {field: f, level: L, prio, seq: seq++, state: "loading", used: now(), meta: null};
    E.set(k, e);
    e.promise = (async () => {
      if (!ld) throw new Error("volcore: no manifest/loader");
      const t0 = now();
      if (f === "vel") {
        const rs = await Promise.all(VEL_COMP_KEYS.map(c => ld.load("gas", c, L, {prio})));
        const t1 = now(), packed = await packVelocityOffThread(rs[0].data, rs[1].data, rs[2].data);
        stats.loads.push({key: k, ms: Math.round(now() - t0), packMs: Math.round(now() - t1), format: rs.map(r => r.format).join(",")});
        allocate(e, rs[0].n, packed, true);
      } else {
        const r = await ld.load("gas", f, L, {prio});
        stats.loads.push({key: k, ms: Math.round(r.ms), fetchMs: Math.round(r.fetchMs || 0), decodeMs: Math.round(r.decodeMs || 0), format: r.format});
        allocate(e, r.n, r.data, false);
      }
      return new Promise((res, rej) => { e.done = res; e.fail = rej; });
    })().catch(x => { e.state = "failed"; e.error = x; throw x; });
    e.promise.catch(() => {});
    return e.promise;
  }

  function setSynthetic(f, L, data, meta = {}) {
    const n = Math.round(Math.cbrt(data.length)), k = key(f, L), e = {field: f, level: L, prio: 0, seq: seq++, used: now(), meta: {vmin: 0, vmax: 1, ...meta}};
    E.set(k, e); e.promise = new Promise((res, rej) => { e.done = res; e.fail = rej; }); allocate(e, n, data, false);
    return e.promise;
  }

  /* upload slices of the queued levels, at least one batch, then until budgetMs is spent */
  /* fence gate (S0_freeze, opt-in): ANGLE/Vulkan on the A100 stalled 160-460 ms inside one texSubImage3D batch while the
     stage rendered uncapped (many frames queued). With `fence`, a batch is uploaded only once a fence placed after the
     previous batch has signalled, so the GPU queue holds at most the frames drawn since then; the wait is never on the
     CPU (clientWaitSync timeout 0). Stub renderers (unit tests) have no GL context and skip the gate. */
  let upFence = null, fenceGated = 0; const FENCE_MAX_GATED = 30;
  function fenceOpen(gl) {
    if (!fence || !gl?.fenceSync || !upFence) return true;
    const st = gl.clientWaitSync(upFence, 0, 0);
    if (st === gl.TIMEOUT_EXPIRED && ++fenceGated <= FENCE_MAX_GATED) { stats.fenceWaits = (stats.fenceWaits || 0) + 1; return false; }
    if (st === gl.TIMEOUT_EXPIRED) stats.fenceGiveUps = (stats.fenceGiveUps || 0) + 1;   // never hang: Chrome may not refresh sync status
    gl.deleteSync(upFence); upFence = null; fenceGated = 0; return true;
  }
  function pump() {
    const t0 = now(); let up = 0;
    const gl0 = fence ? renderer.getContext?.() : null;
    if (uploadQ.length && !fenceOpen(gl0)) return {uploadedSlices: 0, ms: now() - t0, pending: uploadQ.length, gated: true};
    while (uploadQ.length) {
      const e = uploadQ[0], z1 = Math.min(e.n, e.z + slices);
      let tf = 0; if (diag) { const g = renderer.getContext?.(), t = now(); g?.finish(); tf = now() - t; }   // diag: drain the GPU queue first
      const ts = now();
      putSlices(e.tex, e.src.image.data, e.n, e.bytes / e.n ** 3, e.z, z1, e.src);
      const dt = now() - ts; stats.maxSliceMs = Math.max(stats.maxSliceMs, dt);
      if (dt > 20 || tf > 20) (stats.slow ||= []).push({key: key(e.field, e.level), z: e.z, ms: Math.round(dt), finishMs: Math.round(tf), pooled: !!e.pooled, at: Math.round(ts)});
      up += z1 - e.z; e.z = z1;
      if (e.z >= e.n) {
        uploadQ.shift(); e.state = "ready"; e.src.image = null; e.src = null;
        stats.uploads.push({key: key(e.field, e.level), at: Math.round(t0)}); evict(); e.done?.(e);
      }
      if (fence && gl0?.fenceSync) break;                              // one batch per signalled fence
      if (now() - t0 >= budgetMs) break;
    }
    if (fence && gl0?.fenceSync && up > 0) { upFence = gl0.fenceSync(gl0.SYNC_GPU_COMMANDS_COMPLETE, 0); gl0.flush(); }
    const ms = now() - t0; stats.maxPumpMs = Math.max(stats.maxPumpMs, ms);
    return {uploadedSlices: up, ms, pending: uploadQ.length};
  }

  const gpuBytes = () => [...E.values()].reduce((a, e) => a + (e.tex ? e.bytes : 0), 0) + free.r8.reduce((a, t) => a + t.userData.n ** 3, 0) + free.rgba.reduce((a, t) => a + 4 * t.userData.n ** 3, 0);
  const pinned = new Set();
  function evict() {
    let total = gpuBytes(); if (total <= budgetBytes) return;
    const cand = [...E.values()].filter(e => e.state === "ready" && !pinned.has(key(e.field, e.level))).sort((a, b) => a.used - b.used);
    for (const e of cand) { if (total <= budgetBytes) break; release(e); E.delete(key(e.field, e.level)); total -= e.bytes; }
  }
  /* a pool texture goes back to its free list (its stale content is overwritten before it is bound again); others are freed */
  function release(e) { if (!e.tex) return; if (e.tex.userData?.pool) free[e.tex.userData.pool].push(e.tex); else e.tex.dispose(); e.tex = null;
  }

  const has = (f, L) => E.get(key(f, L))?.state === "ready";
  const state = (f, L) => E.get(key(f, L))?.state || "absent";

  /* bind: color = the TF colour field (or null), weight = the emissivity/velocity weight field, vel = true for the packed
     velocity cube. Every slot of a level that is not complete is bound to the empty texture with have = 0, so the shader
     falls back to the next coarser resident level (raymarch.js pick). */
  function bind(U, {color = null, weight = null, vel = false, empty1, empty4} = {}) {
    const set = (slots, haveU, f, rgba) => {
      const got = [];
      LEVELS.forEach((L, i) => {
        const e = f && E.get(key(f, L)), ok = e && e.state === "ready";
        U[slots[i]].value = ok ? e.tex : rgba ? empty4 : empty1; haveU.value.setComponent(i, ok ? 1 : 0);
        if (ok) { e.used = now(); got.push(L); }
      });
      return got;
    };
    pinned.clear();
    for (const f of [vel ? "vel" : color, weight]) if (f) for (const L of LEVELS) pinned.add(key(f, L));
    const c = vel ? set(["uVel0", "uVel1", "uVel2"], U.uVelHave, "vel", true) : set(["uGas0", "uGas1", "uGas2"], U.uGasHave, color, false);
    if (vel) set(["uGas0", "uGas1", "uGas2"], U.uGasHave, null, false); else set(["uVel0", "uVel1", "uVel2"], U.uVelHave, null, true);
    const w = set(["uW0", "uW1", "uW2"], U.uWHave, weight, false);
    const fc = color && field(color), fw = weight && field(weight);
    if (fc && !vel) U.uGasRange.value.set(fc.vmin, fc.vmax);
    if (fw) U.uWRange.value.set(fw.vmin, fw.vmax);
    if (vel) U.uVelV.value = manifest?.gas?.vectors?.v?.V || 600;
    /* every level of one manifest has the same n; a synthetic (test) level sets its own */
    const any = [...E.values()].find(e => e.state === "ready" && (e.field === (vel ? "vel" : color) || e.field === weight));
    U.uN.value = any ? any.n : nOf("L0");
    return {color: c, weight: w};
  }

  function dispose() { for (const e of E.values()) e.tex?.dispose(); for (const t of [...free.r8, ...free.rgba]) t.dispose(); E.clear(); uploadQ = []; free.r8 = []; free.rgba = []; }
  /* drop one level (tests, a galaxy switch): its texture returns to the pool */
  function drop(f, L) { const e = E.get(key(f, L)); if (!e) return; uploadQ = uploadQ.filter(x => x !== e); release(e); E.delete(key(f, L)); }
  return {request, has, state, pump, bind, field, gpuBytes, stats, setSynthetic, dispose, drop, prewarm, pool: free, entries: E, levelHalf: L => manifest?.levels?.[L]?.half_kpc ?? {L0: 400, L1: 100, L2: 25}[L]};
}
const now = () => (typeof performance !== "undefined" ? performance.now() : Date.now());
