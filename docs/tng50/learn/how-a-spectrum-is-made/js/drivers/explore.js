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
