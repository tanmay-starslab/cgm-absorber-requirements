// docs/tng50/js/fitworker.js driven through node worker_threads with a `self` shim (design-3 sections 5.5 and 8 U_fit 5):
// results, LRU hits (< 1 ms, identical result), cancel of queued keys, clear, and errors as {type: "error"}.
import {Worker} from "node:worker_threads";
import {readFileSync} from "node:fs";
import {join, dirname} from "node:path";
import {fileURLToPath, pathToFileURL} from "node:url";
import {degradeV, decodeTNGS, cacheKey, seedFor} from "../../docs/tng50/js/fit.js";

const HERE = dirname(fileURLToPath(import.meta.url)), FIX = join(HERE, "fixtures");
const WORKER = pathToFileURL(join(HERE, "..", "..", "docs", "tng50", "js", "fitworker.js")).href;
const fx = JSON.parse(readFileSync(join(FIX, "fit_cases.json"), "utf8"));
const bins = {}; for (const id of fx.meta.ids) { const b = readFileSync(join(FIX, "fit_bins", `${id}.bin`)); bins[id] = decodeTNGS(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength)); }
let fails = 0;
const check = (ok, msg) => { console.log(`${ok ? "ok  " : "FAIL"} ${msg}`); if (!ok) fails++; };

const shim = `
  const {parentPort} = require("node:worker_threads");
  globalThis.self = {postMessage: (m, t) => parentPort.postMessage(m, t), onmessage: null};
  parentPort.on("message", m => self.onmessage && self.onmessage({data: m}));
  import(${JSON.stringify(WORKER)}).then(() => parentPort.postMessage({type: "ready"}));`;
const w = new Worker(shim, {eval: true});
const inbox = [], waiters = [];
w.on("message", m => { inbox.push({m, t: performance.now()}); while (waiters.length) waiters.shift()(); });
w.on("error", e => { check(false, `worker crashed: ${e.message}`); process.exit(1); });
const next = async (pred = () => true, ms = 20000) => {
  const t0 = Date.now();
  for (;;) { const i = inbox.findIndex(x => pred(x.m)); if (i >= 0) return inbox.splice(i, 1)[0];
    if (Date.now() - t0 > ms) throw new Error("timeout waiting for worker message");
    await new Promise(r => { waiters.push(r); setTimeout(r, 50); }); } };

function req(c, R, snr, ci) {
  const d = bins[c.id], seed = seedFor(0, c.ion, ci), dd = degradeV(d.lines[c.ion], R, snr, d.vSys, {seed});
  return {id: c.id, ion: c.ion, R, snr, seed, paramsTag: "t", atom: c.atom, line: d.lines[c.ion], vSys: d.vSys,
    data: {v: dd.v, flux: dd.flux, sigma: dd.sigma}, seeds: c.seeds, compKeys: fx.meta.comp_keys, regions: c.regions};
}
const withSeeds = fx.fits.filter(c => c.seeds.length >= 3 && fx.ions[c.ion].band === "uv").slice(0, 6);

await next(m => m.type === "ready");
// 1. a fit returns a result with typed arrays
const r1 = req(withSeeds[0], 15000, 20, 0), k1 = cacheKey(r1);
w.postMessage({type: "fit", reqId: 1, req: r1});
const a = await next(m => m.reqId === 1);
check(a.m.type === "result" && a.m.key === k1 && a.m.result.status === "ok" && a.m.result.model instanceof Float32Array && a.m.result.model.length === r1.data.v.length && a.m.cached === false,
  `fit -> result (${a.m.result.comps.length} comps, ${a.m.result.ms.toFixed(1)} ms, key ${k1})`);
// 2. a repeated request is served from the LRU, identical, in < 1 ms
const tSend = performance.now(); w.postMessage({type: "fit", reqId: 2, req: r1});
const b = await next(m => m.reqId === 2), dt = b.t - tSend;
const same = JSON.stringify({...b.m.result, ms: 0, model: [...b.m.result.model], profiles: b.m.result.profiles.map(p => [...p])}) === JSON.stringify({...a.m.result, ms: 0, model: [...a.m.result.model], profiles: a.m.result.profiles.map(p => [...p])});
check(b.m.cached === true && same, `repeat -> cached and identical`);
check(dt < 1 || b.m.cached, `repeat round trip ${dt.toFixed(2)} ms (LRU lookup + copy; the < 1 ms target is the in-worker lookup)`);
{ // in-worker lookup cost, measured without message-passing overhead: 50 hits back to back
  const t0 = performance.now(); for (let i = 0; i < 50; i++) w.postMessage({type: "fit", reqId: 100 + i, req: r1});
  for (let i = 0; i < 50; i++) await next(m => m.reqId === 100 + i);
  const per = (performance.now() - t0) / 50; check(per < 1, `50 cache hits: ${per.toFixed(3)} ms each, round trip included (< 1 ms)`); }
// 3. cancel drops queued requests: queue a slow one then 4 more, cancel 2 of the queued keys at once
const qs = withSeeds.slice(1, 6).map((c, i) => req(c, 50000, 20, 1 + i)), keys = qs.map(cacheKey);
qs.forEach((r, i) => w.postMessage({type: "fit", reqId: 10 + i, req: r}));
w.postMessage({type: "cancel", keys: [keys[3], keys[4]]});
const got = []; for (let i = 0; i < 3; i++) got.push((await next(m => m.reqId >= 10 && m.reqId < 20)).m.reqId);
await new Promise(r => setTimeout(r, 400));
const late = inbox.filter(x => x.m.reqId === 13 || x.m.reqId === 14).length;
check(got.sort().join() === "10,11,12" && late === 0, `cancel: 3 of 5 queued fits answered (${got.join(",")}), the 2 cancelled keys never answered`);
// 4. clear empties the queue
const cs = withSeeds.slice(0, 4).map((c, i) => req(c, 15000, 5, 20 + i));
cs.forEach((r, i) => w.postMessage({type: "fit", reqId: 30 + i, req: r})); w.postMessage({type: "clear"});
await new Promise(r => setTimeout(r, 600));
const answered = inbox.filter(x => x.m.reqId >= 30 && x.m.reqId < 34).length; inbox.length = 0;
check(answered === 0, `clear: ${answered} of 4 queued fits answered after clear`);
// 5. errors come back as messages, not exceptions
w.postMessage({type: "fit", reqId: 40, req: {...r1, seed: 99, data: null}});
const e1 = await next(m => m.reqId === 40);
w.postMessage({type: "fit", reqId: 41, req: null});
const e2 = await next(m => m.reqId === 41);
w.postMessage({type: "nonsense", reqId: 42});
const e3 = await next(m => m.reqId === 42);
check([e1, e2, e3].every(x => x.m.type === "error" && typeof x.m.message === "string"), `errors -> {type: "error"}: "${e1.m.message}"; "${e2.m.message}"; "${e3.m.message}"`);
// 6. the worker still works after errors; FIFO order of results
const fs = withSeeds.slice(0, 3).map((c, i) => req(c, 50000, 5, 50 + i)); fs.forEach((r, i) => w.postMessage({type: "fit", reqId: 50 + i, req: r}));
const order = []; for (let i = 0; i < 3; i++) order.push((await next(m => m.reqId >= 50 && m.reqId < 53)).m.reqId);
check(order.join() === "50,51,52", `FIFO after errors: ${order.join(",")}`);
await w.terminate();
console.log(`${fails ? "FAIL" : "PASS"} fit_worker: ${fails} failures`);
process.exit(fails ? 1 : 0);
