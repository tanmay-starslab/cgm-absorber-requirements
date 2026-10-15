// Web Worker wrapper of fit.js (design-3 section 5.5). Start it as a module worker:
//   new Worker("js/fitworker.js", {type: "module"})
// Protocol
//   in  {type: "fit", reqId, req}     -> out {type: "result", reqId, key, result, cached}
//                                         or {type: "error", reqId, key, message}
//   in  {type: "cancel", keys: [...]} drops queued (not yet running) requests with those cache keys
//   in  {type: "clear"}               empties the queue
// Requests run one at a time in FIFO order. Between two fits the worker yields to its message loop, so a cancel or
// clear sent while a fit runs takes effect before the next one starts. Finished results are kept in an LRU of
// FIT_PARAMS.cacheSize entries keyed by cacheKey(req); a repeated request is answered from it without refitting.
// Result arrays are copied before they are transferred, so the cached copy stays intact.
import {fitPanel, cacheKey, FIT_PARAMS} from "./fit.js";

const cache = new Map();                 // insertion order = LRU order (oldest first)
const queue = [];
let busy = false;

function cacheGet(key) {
  if (!cache.has(key)) return null;
  const v = cache.get(key); cache.delete(key); cache.set(key, v); return v;
}
function cachePut(key, v) {
  if (cache.has(key)) cache.delete(key);
  cache.set(key, v);
  while (cache.size > FIT_PARAMS.cacheSize) cache.delete(cache.keys().next().value);
}

function send(msg, transfer) { self.postMessage(msg, transfer || []); }

function reply(reqId, key, result, cached) {
  const model = result.model ? new Float32Array(result.model) : new Float32Array(0);
  const profiles = (result.profiles || []).map(p => new Float32Array(p));
  const modelFull = result.modelFull ? new Float32Array(result.modelFull) : null;
  const profilesFull = (result.profilesFull || []).map(p => new Float32Array(p));
  const out = {...result, comps: result.comps.map(c => ({...c})), windows: result.windows.map(w => w.slice()), model, profiles};
  if (modelFull) { out.modelFull = modelFull; out.profilesFull = profilesFull; }
  send({type: "result", reqId, key, result: out, cached}, [model.buffer, ...profiles.map(p => p.buffer), ...(modelFull ? [modelFull.buffer] : []), ...profilesFull.map(p => p.buffer)]);
}

function runOne(job) {
  let key = null;
  try {
    key = cacheKey(job.req);
    const hit = cacheGet(key);
    if (hit) return reply(job.reqId, key, hit, true);
    const result = fitPanel(job.req);
    if (result.status === "error") return send({type: "error", reqId: job.reqId, key, message: result.message || "fit failed"});
    cachePut(key, result);
    reply(job.reqId, key, result, false);
  } catch (e) {
    send({type: "error", reqId: job.reqId, key, message: String((e && e.message) || e)});
  }
}

function pump() {
  if (busy) return;
  const job = queue.shift();
  if (!job) return;
  busy = true;
  runOne(job);
  busy = false;
  if (queue.length) setTimeout(pump, 0);
}

self.onmessage = (e) => {
  const m = e.data || {};
  try {
    if (m.type === "fit") {
      let key = null;
      try { key = cacheKey(m.req || {}); } catch (_) { /* reported by runOne */ }
      const hit = key && cacheGet(key);
      if (hit) { reply(m.reqId, key, hit, true); return; }           // cache hits skip the queue
      queue.push({reqId: m.reqId, req: m.req, key});
      setTimeout(pump, 0);
    } else if (m.type === "cancel") {
      const drop = new Set(m.keys || []);
      for (let i = queue.length - 1; i >= 0; i--) if (drop.has(queue[i].key)) queue.splice(i, 1);
    } else if (m.type === "clear") {
      queue.length = 0;
    } else {
      send({type: "error", reqId: m.reqId ?? null, key: null, message: `unknown message type ${JSON.stringify(m.type)}`});
    }
  } catch (err) {
    send({type: "error", reqId: m.reqId ?? null, key: null, message: String((err && err.message) || err)});
  }
};
