// Unit tests of the cube loader docs/tng50/js/vizload.js (fix-ui FE-01..FE-04, FE-15) in node, on the 16^3 fixture of
// make_viz_fixture.py. fetch, CacheStorage, createImageBitmap and OffscreenCanvas are mocked (node decodes no WebP:
// the mock hands back the PIL-decoded <part>.rgba of the fetched bytes). Checks: a host that accepts the connection
// but never answers ends in HostError after the stall timeout, with no .gz request after the stalled parts; corrupt
// bytes / a decode failure end in a plain Error (not HostError); bytes are cached only after the sha256 check; a bad
// cached copy is deleted and refetched; cache.put does not delay load(); a fallback base that is all-404 is skipped
// afterwards; HTTP errors everywhere still give HostError. final: a prio-0 load jumps queued prio-1 parts; identical part
// errors are reported once; loadManifestV2 (with vizload.fetchText or plain fetch) times out on a host that never answers.
// Usage: PYTHON=<python with numpy + PIL> node tests/js/vizload_unit.mjs [fixture dir]
import {readFileSync, mkdtempSync, existsSync} from "node:fs";
import {execFileSync} from "node:child_process";
import {createServer} from "node:http";
import {createHash} from "node:crypto";
import {tmpdir} from "node:os";
import {join, dirname} from "node:path";
import {fileURLToPath} from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
let dir = process.argv[2];
if (!dir) { dir = mkdtempSync(join(process.env.TMPDIR || tmpdir(), "tngvizl-"));
  execFileSync(process.env.PYTHON || "python", [join(HERE, "make_viz_fixture.py"), "--out", dir], {stdio: "inherit"}); }
let fails = 0; const check = (ok, msg) => { console.log(`${ok ? "ok  " : "FAIL"} ${msg}`); if (!ok) fails++; };
const M = JSON.parse(readFileSync(join(dir, "manifest_v2.json"), "utf8")), n = M.levels.L1.n;
const sha = b => createHash("sha256").update(Buffer.from(b)).digest("hex");

/* ---- mocks ---- */
const RGBA = new Map();                 // sha256(webp bytes) -> PIL rgba
for (const c of [M.gas.fields.nH.cubes.L1, M.stars.cubes.S1]) for (const p of c.webp.paths) RGBA.set(sha(readFileSync(join(dir, p))), new Uint8ClampedArray(readFileSync(join(dir, p + ".rgba"))));
let bitmapFail = false;
globalThis.createImageBitmap = async blob => { if (bitmapFail) throw new Error("mock: cannot decode WebP");
  const d = RGBA.get(sha(await blob.arrayBuffer())); if (!d) throw new Error("mock: not a fixture WebP"); return {width: 16 * n, height: 4 * n, d, close() {}}; };
globalThis.OffscreenCanvas = class { constructor(w, h) { this.w = w; this.h = h; } getContext() { let b = null;
  return {drawImage: x => { b = x; }, getImageData: () => ({data: b.d})}; } };
const STORE = new Map(); let putDelay = 0, puts = 0;
const cacheObj = {
  async match(u) { const b = STORE.get(u); return b ? new Response(b) : undefined; },
  async put(u, r) { const b = new Uint8Array(await r.arrayBuffer()); if (putDelay) await new Promise(res => setTimeout(res, putDelay)); STORE.set(u, b); puts++; },
  async delete(u) { return STORE.delete(typeof u === "string" ? u : u.url); },
  async keys() { return [...STORE.keys()].map(url => ({url})); }};
globalThis.caches = {open: async () => cacheObj, delete: async () => { STORE.clear(); return true; }};
const realFetch = globalThis.fetch; let log = [], override = null;
globalThis.fetch = async (url, opts) => { log.push(url); if (override) { const r = await override(url, opts); if (r !== undefined) return r; }
  if (url.startsWith("http://127.0.0.1")) return realFetch(url, opts);
  const p = url.replace(/^https:\/\/h\.test\/(fb\/)?/, ""), f = join(dir, p);
  if (!existsSync(f)) return new Response("not found", {status: 404});
  return new Response(readFileSync(f), {status: 200, headers: {"Content-Type": "application/octet-stream"}}); };
const {makeLoader, HostError} = await import("../../docs/tng50/js/vizload.js");
const gc = M.gas.fields.nH.cubes.L1, B = "https://h.test/";
const reset = () => { STORE.clear(); log = []; override = null; bitmapFail = false; putDelay = 0; puts = 0; };
const flush = () => new Promise(r => setTimeout(r, 50));

/* 1: a good load: WebP path, cached afterwards; a second load comes from the cache */
reset();
{ const L = makeLoader({manifest: M, base: B}); const r = await L.load("gas", "nH", "L1"); await flush();
  check(r.format === "webp" && sha(r.data) === gc.raw_sha256 && gc.webp.paths.every(p => STORE.has(B + p)), `good load: webp, sha ok, ${STORE.size} parts cached after verification`);
  log = []; const r2 = await L.load("gas", "nH", "L1");
  check(r2.format === "webp" && log.length === 0, `second load served from the cache (${log.length} fetches)`); }

/* 2 (FE-04): cache.put does not delay load() */
reset();
{ putDelay = 1500; const L = makeLoader({manifest: M, base: B}); const t0 = Date.now(); await L.load("gas", "nH", "L1"); const dt = Date.now() - t0;
  check(dt < 1000, `load() resolved in ${dt} ms although every cache.put takes ${putDelay} ms`); await new Promise(r => setTimeout(r, 1700)); }

/* 3 (FE-03): corrupt network bytes are never cached; a corrupt cached copy is deleted and refetched once */
reset();
{ override = url => url.endsWith(".webp") ? new Response(new Uint8Array(1000).fill(7), {status: 200}) : undefined;   // a proxy page instead of WebP
  const L = makeLoader({manifest: M, base: B}); const r = await L.load("gas", "nH", "L1"); await flush();
  check(r.format === "gz" && sha(r.data) === gc.raw_sha256 && !gc.webp.paths.some(p => STORE.has(B + p)) && STORE.has(B + gc.gz.path),
    `bad WebP bytes from the network: gz fallback, WebP not cached, verified gz cached (${STORE.size} entries)`); }
reset();
{ for (const p of gc.webp.paths) STORE.set(B + p, new Uint8Array(500).fill(3));          // poisoned cache entries
  const L = makeLoader({manifest: M, base: B}); const r = await L.load("gas", "nH", "L1"); await flush();
  const webpFetches = log.filter(u => u.endsWith(".webp")).length;
  check(r.format === "webp" && webpFetches === 4 && gc.webp.paths.every(p => sha(STORE.get(B + p)) === sha(readFileSync(join(dir, p)))),
    `poisoned cached WebP: deleted and refetched once (${webpFetches} part fetches), good bytes now cached`); }

/* 4 (FE-02): decode / hash failures are a plain Error, not HostError */
reset();
{ bitmapFail = true; override = url => url.endsWith(".gz") ? new Response(readFileSync(join(dir, "gas/L1/nH.bad.u8.gz")), {status: 200}) : undefined;
  const L = makeLoader({manifest: M, base: B, fallbackBase: "https://h.test/fb/"}); let e = null; try { await L.load("gas", "nH", "L1"); } catch (x) { e = x; }
  check(e && !(e instanceof HostError) && /cannot decode WebP/.test(e.message), `decode failure + bad gz → plain Error: ${e && e.name}: ${e && e.message.slice(0, 120)}`); }

/* 5: HTTP errors everywhere → HostError; an all-404 fallback is not tried on the next load (FE-15) */
reset();
{ override = url => new Response("down", {status: url.includes("/fb/") ? 404 : 503});
  const L = makeLoader({manifest: M, base: B, fallbackBase: "https://h.test/fb/"}); let e = null; try { await L.load("gas", "nH", "L1"); } catch (x) { e = x; }
  check(e instanceof HostError && e.host === "h.test" && !/fallback/.test(e.message), `503 host + 404 fallback → HostError (host ${e?.host}), fallback noise dropped: "${e?.message.slice(0, 100)}"`);
  log = []; try { await L.load("gas", "nH", "L1"); } catch (x) { e = x; }
  check(e instanceof HostError && !log.some(u => u.includes("/fb/")), `second load skips the all-404 fallback (${log.length} requests, none to it)`); }

/* 6 (FE-01): a host that accepts the connection but never answers → HostError after the stall timeout */
reset();
{ const held = []; let seen = [];
  const srv = createServer((req, res) => { seen.push(req.url); held.push(res); }); await new Promise(r => srv.listen(0, "127.0.0.1", r));
  const dead = createServer(() => {}); await new Promise(r => dead.listen(0, "127.0.0.1", r)); const deadPort = dead.address().port; dead.close();
  const base = `http://127.0.0.1:${srv.address().port}/`, L = makeLoader({manifest: M, base, fallbackBase: `http://127.0.0.1:${deadPort}/`, stallMs: 1500});
  const t0 = Date.now(); let e = null; try { await L.load("gas", "nH", "L1"); } catch (x) { e = x; } const dt = Date.now() - t0;
  check(e instanceof HostError && dt < 6000 && /no data from the host for 2 s|no data from the host/.test(e.message),
    `hanging host: HostError after ${(dt / 1000).toFixed(1)} s (stall 1.5 s): "${e?.message.slice(0, 110)}"`);
  check(seen.length === 4 && !seen.some(u => u.endsWith(".gz")), `hanging host: ${seen.length} requests (the 4 WebP parts), no .gz behind them`);
  /* the net slots were released: a later load against a working base still runs */
  const L2 = makeLoader({manifest: M, base: B}); const r = await Promise.race([L2.load("gas", "nH", "L1"), new Promise(res => setTimeout(() => res(null), 3000))]);
  check(r && r.format === "webp", "net slots released after the stall: the next load completes");
  for (const res of held) res.destroy(); srv.close(); }

/* final: network priority — with every net slot busy, a prio-0 load (the first frame's cube) is fetched before
   prio-1 parts that were queued earlier */
{ reset(); override = (u, o) => new Promise(res => setTimeout(() => res(undefined), 250));
  const mk = () => makeLoader({manifest: M, base: B, cache: false});
  const pA = mk().load("stars", null, "S1", {prio: 1}), pB = mk().load("stars", null, "S1", {prio: 1}); await new Promise(r => setTimeout(r, 20));
  const pC = mk().load("gas", "nH", "L1", {prio: 0}); await Promise.all([pA, pB, pC]);
  const order = log.map(u => (u.includes("/gas/") ? "g" : "s")).join("");
  check(order.slice(0, 8) === "ssssgggg", `prio 0 jumps the queue: request order ${order} (want ssssgggg then ssss)`); }

/* final: identical part errors are reported once ("Failed to fetch", not "Failed to fetch; Failed to fetch") */
{ reset(); override = () => { throw new TypeError("Failed to fetch"); };
  let e = null; try { await makeLoader({manifest: M, base: B, cache: false}).load("gas", "nH", "L1"); } catch (x) { e = x; }
  check(e instanceof HostError && !/Failed to fetch; Failed to fetch/.test(e.message) && /Failed to fetch/.test(e.message), `deduplicated error message: "${e?.message}"`); }

/* final: vizdata.loadManifestV2 through vizload.fetchText times out on a host that never answers (?viz= hang) */
{ reset(); const {fetchText} = await import("../../docs/tng50/js/vizload.js"), {loadManifestV2} = await import("../../docs/tng50/js/vizdata.js");
  override = (u, o) => new Promise((_, rej) => o.signal.addEventListener("abort", () => rej(new DOMException("aborted", "AbortError"))));
  const t0 = Date.now(); let e = null; try { await loadManifestV2("https://hang.test/manifest_v2.json", {fetchText, timeoutMs: 800}); } catch (x) { e = x; }
  const dt = Date.now() - t0;
  check(e && e.timeout && e.network && dt < 3000 && /no answer from hang\.test within 1 s/.test(e.message), `hanging manifest host: error after ${(dt / 1000).toFixed(1)} s: "${e?.message}"`);
  let e2 = null; const t1 = Date.now(); try { await loadManifestV2("https://hang.test/manifest_v2.json", {timeoutMs: 800}); } catch (x) { e2 = x; }
  check(e2 && e2.timeout && Date.now() - t1 < 3000, `plain-fetch path times out too: "${e2?.message}"`);
  override = () => new Response("nope", {status: 404}); let e3 = null; try { await loadManifestV2("https://h.test/manifest_v2.json", {fetchText}); } catch (x) { e3 = x; }
  check(e3 && !e3.network && /HTTP 404/.test(e3.message), `HTTP 404 manifest is not "unreachable": "${e3?.message}"`);
  override = null; const m = await loadManifestV2("https://h.test/manifest_v2.json", {fetchText});
  check(m.schema === "tng50-viz/2", "a good manifest still loads through fetchText"); }

console.log(fails ? `\n${fails} check(s) FAILED` : "\nall checks passed");
process.exit(fails ? 1 : 0);
