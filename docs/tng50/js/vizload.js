// Browser loader for the Phase-2b cubes (design §5.3): WebP atlas parts (createImageBitmap without colour conversion
// -> OffscreenCanvas -> getImageData -> atlasToRaw), SHA-256 against raw_sha256, the .gz fallback, a retry on the
// fallback base, and a CacheStorage cache of the immutable, content-hashed files. Needs a DOM-capable global
// (window or worker); the pure parts live in vizdata.js.
/* fix-ui: every network fetch has a stall timeout (no bytes for stallMs -> abort, slot released; FE-01); a load fails
   with HostError only when every error is a network / HTTP one, otherwise with a plain Error (FE-02); files are cached
   only after their sha256 checked out, a cached copy that fails the check is deleted and refetched once (FE-03), and
   cache.put no longer delays the first display (FE-04); the atlas decode, atlasToRaw and the hash run in a worker when
   one can be started (FE-10); a fallback base that answers 404 for everything is not tried again (FE-15) */
import {atlasToRaw, cubeRef, cubeUrls, gunzipIfNeeded, sha256Hex} from "./vizdata.js";

const CACHE = "tng50-viz-v2";
export const STALL_MS = 20000;

export class HostError extends Error {
  constructor(message, host) { super(message); this.name = "HostError"; this.host = host; }
}
const isNet = x => !!x && (x.http !== undefined || x.timeout || x.network || x instanceof TypeError);

/* tune2: at most MAX_NET network fetches at once (a cold first load used to start ~24 parts together and each part
   then took minutes); waiters are served in request order, so the first level requested is fetched first */
/* final (cold first load): waiters carry a priority (lower first; FIFO within one priority), so the cube the viewer needs
   to show its first frame is never queued behind background levels that were requested earlier */
const MAX_NET = 4; let netActive = 0; const netQueue = [];
const netSlot = (prio = 1) => new Promise(r => { if (netActive < MAX_NET) { netActive++; r(); return; }
  const w = {prio, r}, i = netQueue.findIndex(x => x.prio > prio); if (i < 0) netQueue.push(w); else netQueue.splice(i, 0, w); });
const netFree = () => { const n = netQueue.shift(); if (n) n.r(); else netActive--; };
async function readBody(r, onChunk, signal) {      // -> Blob; onChunk(bytes) per received chunk
  const type = r.headers.get("Content-Type") || "application/octet-stream";
  if (!r.body?.getReader) return r.blob();
  const rd = r.body.getReader(), chunks = [];
  const stop = () => rd.cancel().catch(() => {}); signal?.addEventListener("abort", stop, {once: true});
  try { for (;;) { const {done, value} = await rd.read(); if (done) break; chunks.push(value); onChunk(value.length); } }
  finally { signal?.removeEventListener("abort", stop); }
  return new Blob(chunks, {type});
}
/* one network fetch, holding a net slot; aborted when no byte arrives for stallMs, or when `parent` aborts */
async function netFetch(url, {onBytes, parent, stallMs = STALL_MS, prio = 1, init = {}} = {}) {
  const name = url.split("/").pop();
  await netSlot(prio);
  const ac = new AbortController(); let timer = 0, timedOut = false;
  const arm = () => { clearTimeout(timer); timer = setTimeout(() => { timedOut = true; ac.abort(); }, stallMs); };
  const onParent = () => ac.abort();
  try {
    if (parent?.aborted) throw Object.assign(new Error(`${name}: cancelled`), {cancelled: true});
    parent?.addEventListener("abort", onParent, {once: true});
    arm();
    const r = await fetch(url, {mode: "cors", credentials: "omit", ...init, signal: ac.signal});
    if (!r.ok) { const e = new Error(`${name}: HTTP ${r.status}`); e.http = r.status; throw e; }
    arm();
    return await readBody(r, n => { arm(); onBytes?.(n); }, ac.signal);
  } catch (x) {
    if (timedOut) throw Object.assign(new Error(`${name}: no data from the host for ${Math.round(stallMs / 1000)} s`), {timeout: true});
    if (parent?.aborted) throw Object.assign(new Error(`${name}: cancelled`), {cancelled: true});
    if (x?.name === "AbortError") throw Object.assign(new Error(`${name}: aborted`), {network: true});
    throw x;
  } finally { clearTimeout(timer); parent?.removeEventListener("abort", onParent); netFree(); }
}

/* final: the manifest fetch for vizdata.loadManifestV2, through netFetch: aborted when no byte arrives for timeoutMs, so a
   hanging ?viz= host ends in a message instead of a blank 3D tab */
export async function fetchText(url, timeoutMs = 10000) {
  const b = await netFetch(url, {stallMs: timeoutMs, prio: 0, init: {cache: "no-cache", credentials: "same-origin"}});
  return b.text();
}

export async function imageData(blob) {
  const bmp = await createImageBitmap(blob, {colorSpaceConversion: "none", premultiplyAlpha: "none"});
  const w = bmp.width, h = bmp.height;
  const cv = typeof OffscreenCanvas !== "undefined" ? new OffscreenCanvas(w, h) : Object.assign(document.createElement("canvas"), {width: w, height: h});
  const g = cv.getContext("2d", {willReadFrequently: true});
  g.drawImage(bmp, 0, 0); bmp.close?.();
  return g.getImageData(0, 0, w, h).data;
}
/* 4 WebP part blobs -> {raw, sha} (decode + atlasToRaw + sha256), on the calling thread */
export async function decodeAtlas(blobs, n, kind) {
  const parts = await Promise.all(blobs.map(imageData));
  const raw = atlasToRaw(parts, n, kind);
  return {raw, sha: await sha256Hex(raw)};
}
/* FE-10: the same in a module worker (decode_worker.js), so the 67 MB of ImageData per cube, the atlas loop and a pure-JS
   hash do not block the main thread; any worker failure falls back to decodeAtlas on this thread */
let dW = null, dN = 0, dBroken = false; const dP = new Map();
function decodeOffThread(blobs, n, kind) {
  if (dBroken || typeof Worker === "undefined" || typeof OffscreenCanvas === "undefined" || typeof document === "undefined") return decodeAtlas(blobs, n, kind);
  try {
    if (!dW) { dW = new Worker(new URL("./decode_worker.js", import.meta.url), {type: "module"});
      dW.onmessage = ev => { const p = dP.get(ev.data.id); dP.delete(ev.data.id); if (!p) return;
        if (ev.data.error) p.reject(Object.assign(new Error(ev.data.error), {decode: true})); else p.resolve({raw: new Uint8Array(ev.data.raw), sha: ev.data.sha}); };
      dW.onerror = ev => { ev.preventDefault?.(); dBroken = true; dW = null; const ps = [...dP.values()]; dP.clear();
        for (const p of ps) decodeAtlas(p.blobs, p.n, p.kind).then(p.resolve, p.reject); }; }
    const id = ++dN;
    return new Promise((resolve, reject) => { dP.set(id, {resolve, reject, blobs, n, kind}); dW.postMessage({id, blobs, n, kind}); });
  } catch { dBroken = true; return decodeAtlas(blobs, n, kind); }
}

/* {manifest, base, fallbackBase, cache=true, stallMs} -> {load(kind, key, level) -> {data, n, bytes, format, base, ms, decodeMs}, prune()} */
export function makeLoader({manifest, base, fallbackBase = null, cache = true, stallMs = STALL_MS}) {
  const useCache = cache && typeof globalThis.caches !== "undefined";
  let fallbackDead = false;      // FE-15: the fallback base answered 404 for every file once: not deployed, skip it
  const cacheOpen = () => caches.open(CACHE);
  async function cacheGet(url) { if (!useCache) return null; try { const hit = await (await cacheOpen()).match(url); return hit ? await hit.blob() : null; } catch { return null; } }
  function cachePut(url, blob) {   // FE-04: not awaited, never on the first-display path
    if (!useCache) return; cacheOpen().then(c => c.put(url, new Response(blob, {headers: {"Content-Type": blob.type || "application/octet-stream"}}))).catch(() => { /* quota: ignore */ }); }
  async function cacheDel(urls) { if (!useCache) return; try { const c = await cacheOpen(); await Promise.all(urls.map(u => c.delete(u))); } catch { /* ignore */ } }
  async function get(url, readCache, opts) {
    if (readCache) { const b = await cacheGet(url); if (b) return {blob: b, cached: true}; }
    return {blob: await netFetch(url, {...opts, stallMs}), cached: false};
  }
  async function webpOnce(cube, U, n, kind, readCache, onBytes, prio) {
    const ac = new AbortController(), t0 = performance.now();
    const got = await Promise.all(U.webp.map(u => get(u, readCache, {onBytes, parent: ac.signal, prio}).catch(x => { ac.abort(); throw x; })));
    const t1 = performance.now(), cached = got.some(g => g.cached);
    let r;
    try { r = await decodeOffThread(got.map(g => g.blob), n, kind); } catch (x) { throw Object.assign(x, {cached}); }
    if (r.sha !== cube.raw_sha256)
      throw Object.assign(new Error(`WebP decode is not byte-exact (sha256 ${r.sha.slice(0, 12)} ≠ ${cube.raw_sha256.slice(0, 12)})`), {cached});
    got.forEach((g, i) => { if (!g.cached) cachePut(U.webp[i], g.blob); });       // FE-03: cache only verified bytes
    return {data: r.raw, format: "webp", fetchMs: t1 - t0, decodeMs: performance.now() - t1, bytes: cube.webp.bytes.reduce((a, x) => a + x, 0)};
  }
  async function gzOnce(cube, U, readCache, prio) {
    const t0 = performance.now(), g = await get(U.gz, readCache, {prio}), name = U.gz.split("/").pop();
    const raw = await gunzipIfNeeded(await g.blob.arrayBuffer());
    if (raw.length !== cube.raw_bytes) throw Object.assign(new Error(`${name}: ${raw.length} bytes after decoding, expected ${cube.raw_bytes}`), {cached: g.cached});
    const h = await sha256Hex(raw);
    if (h !== cube.raw_sha256) throw Object.assign(new Error(`${name}: sha256 mismatch`), {cached: g.cached});
    if (!g.cached) cachePut(U.gz, g.blob);
    return {data: raw, format: "gz", fetchMs: performance.now() - t0, decodeMs: 0, bytes: cube.gz.bytes};
  }
  /* run once from the cache (if any); a cached copy that fails decoding or the hash is deleted and refetched once */
  async function verified(fn, urls) {
    try { return await fn(useCache); }
    catch (x) { if (!x.cached) throw x; await cacheDel(urls); return await fn(false); }
  }
  async function fromBase(cube, n, kind, b, onBytes, prio) {
    const U = cubeUrls(cube, b), errs = [];
    try { return await verified(rc => webpOnce(cube, U, n, kind, rc, onBytes, prio), U.webp); }     // 1-2: WebP parts, decode, verify
    catch (x) { errs.push(x); }
    if (!errs[0].timeout) {                                  // 3: the gzip fallback (not after a stall: same host, it would stall too)
      try { const r = await verified(rc => gzOnce(cube, U, rc, prio), [U.gz]); r.webpError = errs[0].message; return r; } catch (x) { errs.push(x); } }
    const e = new Error([...new Set(errs.map(x => x.message))].join("; "));      // final: no "Failed to fetch; Failed to fetch"
    e.network = errs.every(isNet); e.all404 = errs.every(x => x.http === 404); throw e;
  }
  /* opts.onBytes(n): called with each chunk's size while parts download (not for cache hits); opts.prio: network priority
     (0 = the cube the first frame waits for, 1 = background levels) */
  async function load(kind, key, level, opts = {}) {
    const cube = cubeRef(manifest, kind, key, level), n = manifest.levels[level].n, t0 = performance.now();
    let r = null, err = null;
    try { r = await fromBase(cube, n, kind, base, opts.onBytes, opts.prio ?? 1); r.base = base; }
    catch (x) {                                              // 4: retry once on the fallback base
      err = x;
      if (fallbackBase && fallbackBase !== base && !fallbackDead) {
        try { r = await fromBase(cube, n, kind, fallbackBase, undefined, opts.prio ?? 1); r.base = fallbackBase; }
        catch (y) { if (y.all404) fallbackDead = true;
          else { const m = Object.assign(new Error(x.message === y.message ? x.message : `${x.message} | fallback: ${y.message}`), {network: x.network && y.network}); err = m; } }
      }
    }
    if (!r) {
      if (!err.network) throw err;                           // FE-02: decode / hash / capability errors are not "unreachable"
      let host = "the data host"; try { host = new URL(base, globalThis.location?.href).host; } catch { /* keep */ }
      throw new HostError(err.message, host);
    }
    return {...r, n, kind, key, level, ms: performance.now() - t0};
  }
  async function prune() {                                   // drop cached files the manifest no longer names
    if (!useCache) return 0;
    const keep = new Set();
    const add = c => { for (const b of [base, fallbackBase].filter(Boolean)) { const U = cubeUrls(c, b); U.webp.forEach(u => keep.add(new URL(u, location.href).href)); keep.add(new URL(U.gz, location.href).href); } };
    for (const f of Object.values(manifest.gas?.fields || {})) for (const c of Object.values(f.cubes || {})) add(c);
    for (const c of Object.values(manifest.stars?.cubes || {})) add(c);
    let n = 0;
    try { const cache = await caches.open(CACHE); for (const req of await cache.keys()) if (!keep.has(req.url)) { await cache.delete(req); n++; } } catch { /* ignore */ }
    return n;
  }
  return {load, prune};
}
