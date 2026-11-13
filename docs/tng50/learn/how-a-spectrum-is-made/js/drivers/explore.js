// v2: createStoryExplore (end of file) is the story's override layer. v1 below is kept unchanged until the card page is
// retired by the integrator.
// Explore driver: the fully interactive level, opened by "Try it" on a step with controls (PLAN_final section 1.2).
// Overrides live in their own layer: engine.show(index, t, {override}) merges them after the authored state, and
// engine.seek() (Play, video) never sees them. "Back to story" drops the layer and redraws the authored state.
// Live fits run only here, in the explorer's own fit worker (js/fitworker.js); Play, Step and the video draw the
// precomputed fits from data/page_fits.json.
//
// createExploreDriver({engine, onChange, onFit, workerUrl, Worker})
//   onChange({index, id, override})   after every set() (the page updates slider valuetext and announces the result)
//   onFit({index, reqId, result} | {index, reqId, error})
//   workerUrl                          default new URL("../../../../js/fitworker.js", import.meta.url) (ROOT/js/drivers -> docs/tng50/js)
// -> {open(index), set(key, value) | set({key: value}), result(fit), get override, get index, get open, fit(req) -> reqId, close(),
//     destroy()}

import {controlName} from "../engine.js";
import {R_RANGE, SN_RANGE} from "../store.js";

export function createExploreDriver(o) {
  const engine = o.engine;
  let index = -1, override = {}, isOpen = false, worker = null, reqId = 0, pending = new Map();

  function draw() { if (isOpen) engine.show(index, Infinity, {override}); }
  function ensureWorker() {
    if (worker) return worker;
    const W = o.Worker || (typeof Worker !== "undefined" ? Worker : null);
    if (!W) throw new Error("explore: no Worker available");
    const url = o.workerUrl || new URL("../../../../js/fitworker.js", import.meta.url);
    worker = new W(url, {type: "module"});
    worker.onmessage = e => {
      const m = e.data || {}, idx = pending.get(m.reqId);
      if (idx === undefined) return;                      // stale (story closed or a newer request superseded it)
      pending.delete(m.reqId);
      if (m.type === "result") o.onFit && o.onFit({index: idx, reqId: m.reqId, result: m.result, cached: m.cached});
      else o.onFit && o.onFit({index: idx, reqId: m.reqId, error: m.message || "fit failed"});
    };
    return worker;
  }

  const d = {
    get index() { return index; }, get override() { return {...override}; }, get open() { return isOpen; },
    open(i) {
      const s = engine.steps[i];
      if (!s || !Array.isArray(s.controls) || !s.controls.length) return false;
      index = i; override = {}; isOpen = true; draw();
      return true;
    },
    /* only the step's own controls (at most 2) are accepted; anything else is ignored */
    set(k, v) {
      if (!isOpen) return d.override;
      const patch = typeof k === "object" && k ? k : {[k]: v}, allowed = engine.steps[index].controls.map(controlName);
      let changed = false;
      for (const [key, val] of Object.entries(patch)) if (allowed.includes(key) && override[key] !== val) { override[key] = val; changed = true; }
      if (changed && "fit" in override) delete override.fit;   // a live fit belongs to the settings it was run with
      if (changed) { draw(); o.onChange && o.onChange({index, id: engine.steps[index].id, override: {...override}}); }
      return d.override;
    },
    /* req: a fit.js fitPanel request (atom, line, data, R, snr, vSys, seed, regions, seeds, ...). Supersedes earlier
       requests from this driver. */
    fit(req) {
      if (!isOpen) return null;
      const w = ensureWorker();
      w.postMessage({type: "clear"});
      pending.clear();
      const id = ++reqId; pending.set(id, index);
      w.postMessage({type: "fit", reqId: id, req});
      return id;
    },
    /* a live fit result (from onFit) joins the override as "fit"; the fit scene draws it, never seek() */
    result(res) {
      if (!isOpen) return d.override;
      override.fit = res; draw();
      o.onChange && o.onChange({index, id: engine.steps[index].id, override: {...override}});
      return d.override;
    },
    close() {
      if (!isOpen) return;
      const i = index; isOpen = false; override = {}; pending.clear();
      if (worker) worker.postMessage({type: "clear"});
      engine.show(i, Infinity);
      o.onChange && o.onChange({index: i, id: engine.steps[i].id, override: null});
    },
    destroy() { d.close(); if (worker && worker.terminate) worker.terminate(); worker = null; },
  };
  return d;
}

/* ---------------------------------------------------------------- v2: the story's override layer (DESIGN_final §5.3, §5.11)
   One overrides object for the whole story (mid-story drags and B14 "Yours"), read by seek(p, data, overrides) on every
   frame and never by the time warp or the camera. Keys and ranges:
     R 5000-150000 (store.js R_RANGE); sn 2-100 (SN_RANGE); ion "OVI" | "HI"; tf story preset id; T125, T263 (K, 10³-10⁸)
     N492 (cm⁻², 10¹²-10¹⁹, DESIGN_final M3); iso {ion, step}; galaxy, ray (picker); seed (B12b "new noise"); cls (layout
     class, presentation only)
   createStoryExplore({bus, onChange, workerUrl, Worker})
     -> {set(key, value) | set({...}), clear(key?), get overrides (frozen copy), fit(req) -> reqId, destroy()}
   Every accepted change is announced on the bus as "override" {key, value}; out-of-range values are clamped, unknown keys
   ignored. Live fits (B13 refit, B14) go through the explorer's fit worker, as in v1. */
const TF_IDS = new Set(["density", "halo", "phases", "ion:HI", "ion:OVI", "speed", "metals"]);   // js/stage/tfstory.js PRESETS
const clampN = (x, a, b) => (Number.isFinite(+x) ? Math.min(b, Math.max(a, +x)) : null);
export const OVERRIDE_RULES = Object.freeze({
  R: v => clampN(v, R_RANGE.min, R_RANGE.max), sn: v => clampN(v, SN_RANGE.min, SN_RANGE.max),
  ion: v => (v === "OVI" || v === "HI" ? v : null), tf: v => (TF_IDS.has(v) ? v : null),
  T125: v => clampN(v, 1e3, 1e8), T263: v => clampN(v, 1e3, 1e8), N492: v => clampN(v, 1e12, 1e19),
  iso: v => (v && (v.ion === "OVI" || v.ion === "HI") && Number.isInteger(v.step) ? {ion: v.ion, step: v.step} : null),
  galaxy: v => (Number.isInteger(+v) && +v >= 0 ? +v : null), ray: v => (typeof v === "string" && /^[A-Za-z0-9_]+$/.test(v) ? v : null),
  seed: v => (Number.isInteger(+v) ? ((+v % 100000) + 100000) % 100000 : null), cls: v => (typeof v === "string" ? v : null),
});

export function createStoryExplore(o = {}) {
  let ov = Object.freeze({}), worker = null, reqId = 0;
  const pending = new Set();
  const emit = (key, value) => { o.bus && o.bus.emit("override", {key, value}); o.onChange && o.onChange({key, value, overrides: ov}); };
  function ensureWorker() {
    if (worker) return worker;
    const W = o.Worker || (typeof Worker !== "undefined" ? Worker : null);
    if (!W) throw new Error("explore: no Worker available");
    worker = new W(o.workerUrl || new URL("../../../../js/fitworker.js", import.meta.url), {type: "module"});
    worker.onmessage = e => { const m = e.data || {}; if (!pending.has(m.reqId)) return; pending.delete(m.reqId);
      if (m.type === "result") o.onFit && o.onFit({reqId: m.reqId, result: m.result, cached: m.cached});
      else o.onFit && o.onFit({reqId: m.reqId, error: m.message || "fit failed"}); };
    return worker;
  }
  const d = {
    get overrides() { return ov; },
    set(k, v) {
      const patch = typeof k === "object" && k ? k : {[k]: v};
      for (const [key, val] of Object.entries(patch)) {
        const rule = OVERRIDE_RULES[key]; if (!rule) continue;
        const x = val === null || val === undefined ? null : rule(val);
        if (x === null) { if (key in ov) { const n = {...ov}; delete n[key]; ov = Object.freeze(n); emit(key, null); } continue; }
        if (JSON.stringify(ov[key]) === JSON.stringify(x)) continue;
        ov = Object.freeze({...ov, [key]: x}); emit(key, x);
      }
      return ov;
    },
    clear(key) { if (key === undefined) { const ks = Object.keys(ov); ov = Object.freeze({}); ks.forEach(k => emit(k, null)); } else d.set(key, null); return ov; },
    fit(req) { const w = ensureWorker(); w.postMessage({type: "clear"}); pending.clear(); const id = ++reqId; pending.add(id);
      w.postMessage({type: "fit", reqId: id, req}); return id; },
    destroy() { if (worker && worker.terminate) worker.terminate(); worker = null; pending.clear(); },
  };
  return d;
}
