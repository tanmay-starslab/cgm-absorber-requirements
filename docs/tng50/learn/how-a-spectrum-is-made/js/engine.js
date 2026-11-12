// Story engine for "How a spectrum is made" (PLAN_final sections 1.1, 5, 8; frozen interface of unit U1).
//
// One source of truth: steps.json (schema story-steps/1, steps.schema.json) + pure scene modules in js/scenes/.
// The engine turns a time t (Play, video) or a step and a local time (Step, Explore) into one call of
//   scene.render(ctx, state, t, data, env)
// and nothing else. Three drivers (js/drivers/{step,play,explore}.js) decide which t; the video page
// (render.html, U5) registers   {element, ready: engine.ready, render: t => engine.seek(t)}   with HyperFrames.
//
// Scene module contract (default export, or the module namespace):
//   id          string, equals the file name and steps.json "scene"
//   defaults    authored base state of the scene (plain JSON)
//   interp      optional {key: "lerp" | "log" | "hold" | "snap"} per state key (default: numbers and equal-length
//               number arrays "lerp", everything else "snap" = takes the target value at once)
//   prepare     optional async (data, {galaxy, ray}) -> cache. Called once per scene in ready(); the result is
//               frame-independent (e.g. per-cell tau as CSR) and reaches render as env.cache
//   render      (ctx, state, t, data, env) -> void, PURE:
//               (a) state is the tween from the previous step's AUTHORED end state (never the last drawn frame);
//               (b) Explore overrides arrive already merged in state, and seek() never passes them;
//               (c) no cache keyed on the previous frame (env.cache from prepare is fine);
//               (d) noise only from env.noise(ion) = rng(seedFor(seed, ion, step id));
//               no Date, performance.now, Math.random, timers, requestAnimationFrame, DOM reads, fitPanel.
//   env = {step, index, id, scene, u, p, t, dur, width, height, dpr, cache, noise(ion), reduced, layout, mode, galaxy, ray,
//          text(str) -> template-resolved string}
//     u = t / dur (0..1 through the step in the current cut), p = eased tween progress (0..1)
//
// Pure helpers (node-testable): validateSteps, buildTimeline, authoredStates, interpState, resolveTemplate,
// templateKeys, locate, EASE. createEngine needs only a 2D context (real or recording); no DOM unless fonts are given.

import {rng, seedFor, decodeTNGS} from "../../../js/fit.js";

export const SCHEMA_ID = "story-steps/1";
export const FPS = 30;
export const TWEEN_MAX_MS = 600;
export const MAX_SCRUB = 3;
export const CHAPTERS = Object.freeze(["light", "pencil", "cells", "ions", "dip", "speed", "sum", "saturation", "lsf", "noise",
  "fit", "yourturn"]);
const SEED_CHAPTERS = new Set(["noise", "fit"]);
/* frame-state keys the engine adds for scenes (FRAME_KEYS below); authored params must not use them. "seed" is not
   reserved: a step may author its own noise seed (params.seed, e.g. S11 cycling three draws); else the page seed */
const RESERVED = new Set(["step", "chapter", "scene", "params", "p", "t", "u", "dur_s", "mode", "explore", "dpr", "layout", "physics",
  "reduced", "galaxy", "ray", "safe"]);
/* control name of a steps.json control entry: "dipB" or {param: "logN", label, min, max, step, scale, unit} */
export const controlName = c => (typeof c === "string" ? c : c && c.param);

/* ---------------- easing ---------------- */
const easeIn = x => x * x * x, easeOut = x => 1 - (1 - x) ** 3, easeInOut = x => (x < 0.5 ? 4 * x * x * x : 1 - (-2 * x + 2) ** 3 / 2);
export const EASE = Object.freeze({linear: x => x, in: easeIn, out: easeOut, inOut: easeInOut,
  inCubic: easeIn, outCubic: easeOut, inOutCubic: easeInOut});
const clamp01 = x => (x < 0 ? 0 : x > 1 ? 1 : x);

/* ---------------- {{key}} templates (eng P2-20) ---------------- */
const TPL = /\{\{\s*([A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z0-9_]+)*)\s*\}\}/g;
export function templateKeys(str) {
  const out = []; if (typeof str !== "string") return out;
  for (const m of str.matchAll(TPL)) out.push(m[1]);
  return out;
}
const pathGet = (o, path) => path.split(".").reduce((a, k) => (a != null && Object.prototype.hasOwnProperty.call(Object(a), k) ? a[k] : undefined), o);
/* numbers render with U+2212 for negatives (site style); strings verbatim. Formats (steps.json "keys" fmt):
   id (integer, no grouping), int (rounded, thousands grouped with a no-break space: 22 723), f1 f2 f3 (fixed),
   sci2 (2.87×10⁵), pct (rounded, no sign); default: shortest round-trip number, no grouping */
const SUP = {"-": "⁻", 0: "⁰", 1: "¹", 2: "²", 3: "³", 4: "⁴", 5: "⁵", 6: "⁶", 7: "⁷", 8: "⁸", 9: "⁹"};
const neg = (v, s) => (v < 0 && !/^0(\.0*)?$/.test(s) ? "−" : "") + s;
const group = s => s.replace(/\B(?=(\d{3})+(?!\d))/g, " ");
export function fmtValue(v, fmt) {
  if (typeof v === "string" && fmt && Number.isFinite(+v) && v.trim() !== "") v = +v;
  if (typeof v !== "number") return String(v).replace(/^-(?=[\d.])/, "\u2212");
  if (!Number.isFinite(v)) return "–";
  const a = Math.abs(v);
  switch (fmt) {
    case "id": return neg(v, String(Math.round(a)));
    case "int": case "pct": return neg(v, group(String(Math.round(a))));
    case "f1": return neg(v, a.toFixed(1));
    case "f2": return neg(v, a.toFixed(2));
    case "f3": return neg(v, a.toFixed(3));
    case "sci2": {
      if (a === 0) return "0";
      let e = Math.floor(Math.log10(a)), m = +(a / 10 ** e).toFixed(2);
      if (m >= 10) { m = +(m / 10).toFixed(2); e += 1; }
      return neg(v, `${m.toFixed(2)}×10${String(e).split("").map(c => SUP[c]).join("")}`);
    }
    default: return neg(v, String(a));
  }
}
/* lookup: the story data (its pre-formatted "keys" {name: string} win, then data.vars, then dotted paths into the data)
   or function(key) -> value|undefined.
   keys (optional, steps.json "keys"): {name: {path, fmt, fallback}}; a named key reads data at path and formats it;
   the fallback is used only when the data lack the path, and is reported in `fallback`.
   -> {text, missing: [keys], fallback: [keys]}; a missing key stays visible as {{key}} so it is caught, never blank */
export function resolveTemplate(str, lookup, keys = null) {
  const missing = [], fallback = [];
  const own = (o, k) => o && typeof o === "object" && Object.prototype.hasOwnProperty.call(o, k);
  const raw = typeof lookup === "function" ? lookup
    : k => { const a = lookup && lookup.vars ? pathGet(lookup.vars, k) : undefined; return a !== undefined ? a : pathGet(lookup, k); };
  const text = String(str ?? "").replace(TPL, (m, k) => {
    const spec = keys && own(keys, k) ? keys[k] : null;
    // 1. the data's own pre-formatted keys (story data "keys", per galaxy); 2. steps.json keys path; 3. vars / dotted path
    let v = typeof lookup !== "function" && lookup && own(lookup.keys, k) ? lookup.keys[k] : undefined;
    if (v !== undefined && v !== null) return fmtValue(v, null);
    v = spec && spec.path ? raw(spec.path) : raw(k);
    if ((v === undefined || v === null) && spec && spec.fallback !== undefined) { v = spec.fallback; fallback.push(k); }
    if (v === undefined || v === null) { missing.push(k); return m; }
    return fmtValue(v, spec && spec.fmt);
  });
  return {text, missing, fallback};
}

/* ---------------- JSON Schema subset (reads steps.schema.json; no dependency) ---------------- */
const typeOf = v => (v === null ? "null" : Array.isArray(v) ? "array" : Number.isInteger(v) ? "integer" : typeof v);
const typeOk = (want, v) => { const t = typeOf(v); return want === t || (want === "number" && t === "integer"); };
export function schemaErrors(schema, value, root = schema, path = "$", out = []) {
  if (schema === true || schema == null) return out;
  if (schema.$ref) {
    const m = /^#\/\$defs\/(.+)$/.exec(schema.$ref);
    const target = m && root.$defs && root.$defs[m[1]];
    if (!target) { out.push(`${path}: unresolved $ref ${schema.$ref}`); return out; }
    return schemaErrors(target, value, root, path, out);
  }
  if (schema.type !== undefined) {
    const types = Array.isArray(schema.type) ? schema.type : [schema.type];
    if (!types.some(t => typeOk(t, value))) { out.push(`${path}: expected ${types.join(" or ")}, got ${typeOf(value)}`); return out; }
  }
  if ("const" in schema && JSON.stringify(schema.const) !== JSON.stringify(value)) out.push(`${path}: must be ${JSON.stringify(schema.const)}`);
  if (schema.enum && !schema.enum.some(e => JSON.stringify(e) === JSON.stringify(value))) out.push(`${path}: ${JSON.stringify(value)} not one of ${schema.enum.join(", ")}`);
  if (typeof value === "string") {
    if (schema.minLength != null && value.length < schema.minLength) out.push(`${path}: shorter than ${schema.minLength}`);
    if (schema.maxLength != null && value.length > schema.maxLength) out.push(`${path}: longer than ${schema.maxLength}`);
    if (schema.pattern && !new RegExp(schema.pattern, "u").test(value)) out.push(`${path}: ${JSON.stringify(value)} does not match ${schema.pattern}`);
  }
  if (typeof value === "number") {
    if (schema.minimum != null && value < schema.minimum) out.push(`${path}: below ${schema.minimum}`);
    if (schema.maximum != null && value > schema.maximum) out.push(`${path}: above ${schema.maximum}`);
    if (schema.exclusiveMinimum != null && !(value > schema.exclusiveMinimum)) out.push(`${path}: must be > ${schema.exclusiveMinimum}`);
  }
  if (Array.isArray(value)) {
    if (schema.minItems != null && value.length < schema.minItems) out.push(`${path}: fewer than ${schema.minItems} items`);
    if (schema.maxItems != null && value.length > schema.maxItems) out.push(`${path}: more than ${schema.maxItems} items`);
    if (schema.uniqueItems && new Set(value.map(v => JSON.stringify(v))).size !== value.length) out.push(`${path}: items not unique`);
    if (schema.items) value.forEach((v, i) => schemaErrors(schema.items, v, root, `${path}[${i}]`, out));
  }
  if (value && typeof value === "object" && !Array.isArray(value)) {
    for (const k of schema.required || []) if (!(k in value)) out.push(`${path}: missing ${k}`);
    const props = schema.properties || {};
    for (const [k, v] of Object.entries(value)) {
      if (k in props) schemaErrors(props[k], v, root, `${path}.${k}`, out);
      else if (schema.additionalProperties === false) out.push(`${path}: unknown key ${k}`);
      else if (schema.additionalProperties && typeof schema.additionalProperties === "object") schemaErrors(schema.additionalProperties, v, root, `${path}.${k}`, out);
    }
  }
  return out;
}

const isFrameMultiple = d => Math.abs(d * FPS - Math.round(d * FPS)) < 1e-6;

/* doc + schema (+ optional scene names) -> {ok, errors}. Schema check, then the cross-step rules in the schema's $comment */
export function validateSteps(doc, schema, sceneNames = null) {
  const errors = schema ? schemaErrors(schema, doc) : [];
  const steps = doc && Array.isArray(doc.steps) ? doc.steps : [];
  if (!schema && (!doc || doc.schema !== SCHEMA_ID)) errors.push(`$.schema: must be ${SCHEMA_ID}`);
  const ids = new Set(), seenCh = [];
  let scrub = 0;
  steps.forEach((s, i) => {
    if (!s || typeof s !== "object") return;
    const at = `$.steps[${i}] (${s.id})`;
    if (ids.has(s.id)) errors.push(`${at}: duplicate id`); ids.add(s.id);
    if (sceneNames && !sceneNames.includes(s.scene)) errors.push(`${at}: unknown scene ${s.scene}`);
    const first = i === 0 || steps[i - 1].chapter !== s.chapter;
    if (first) {
      if (seenCh.includes(s.chapter)) errors.push(`${at}: chapter ${s.chapter} is not contiguous`);
      else if (seenCh.length && CHAPTERS.indexOf(s.chapter) < CHAPTERS.indexOf(seenCh[seenCh.length - 1])) errors.push(`${at}: chapter ${s.chapter} out of order`);
      seenCh.push(s.chapter);
      if (!s.title) errors.push(`${at}: first step of chapter ${s.chapter} needs a title`);
    } else if (s.title) errors.push(`${at}: title only on the first step of a chapter`);
    if (typeof s.dur_s === "number" && !isFrameMultiple(s.dur_s)) errors.push(`${at}: dur_s ${s.dur_s} is not a multiple of 1/${FPS} s`);
    if (typeof s.film_dur_s === "number") {
      if (!isFrameMultiple(s.film_dur_s)) errors.push(`${at}: film_dur_s not a multiple of 1/${FPS} s`);
      if (s.film_dur_s > s.dur_s) errors.push(`${at}: film_dur_s longer than dur_s`);
      if (!s.film) errors.push(`${at}: film_dur_s on a step that is not in the film`);
    }
    if (s.scrub) scrub++;
    for (const k of Object.keys(s.params || {})) if (RESERVED.has(k)) errors.push(`${at}.params: ${k} is reserved for the engine's frame state`);
    if (s.seedRule != null && !SEED_CHAPTERS.has(s.chapter)) errors.push(`${at}: seedRule only on noise and fit steps`);
    for (const f of ["text", "sub", "caption", "voice", "aria"]) {
      const v = s[f]; if (typeof v !== "string") continue;
      const bad = (v.match(/\{\{|\}\}/g) || []).length - 2 * templateKeys(v).length;
      if (bad) errors.push(`${at}.${f}: malformed {{key}} template`);
    }
    if (s.physics && typeof s.physics.line === "string" && (s.physics.line.match(/\{\{|\}\}/g) || []).length !== 2 * templateKeys(s.physics.line).length) errors.push(`${at}.physics.line: malformed {{key}} template`);
  });
  if (scrub > MAX_SCRUB) errors.push(`$.steps: ${scrub} scrub steps, at most ${MAX_SCRUB}`);
  return {ok: errors.length === 0, errors};
}

/* ---------------- authored states and interpolation ---------------- */
const clone = o => (o === undefined ? undefined : JSON.parse(JSON.stringify(o)));
/* end state of every step: scene.defaults, then params of each earlier step of the same scene run, then its own.
   A new scene (or the same scene after another one) starts again from its defaults. -> [{from, to}] with from = the
   previous step's authored end state inside the run (= to on the first step of a run: no tween across scenes) */
export function authoredStates(steps, scenes) {
  const out = []; let prev = null;
  steps.forEach((s, i) => {
    const sc = scenes ? sceneOf(scenes, s.scene) : null;
    const sameRun = i > 0 && steps[i - 1].scene === s.scene;
    const base = sameRun ? prev : {...clone(sc && sc.defaults || {})};
    const to = Object.freeze({...clone(base), ...clone(s.params || {})});
    out.push({from: sameRun ? prev : to, to});
    prev = to;
  });
  return out;
}
const isNumArr = a => Array.isArray(a) && a.every(x => typeof x === "number");
export function interpState(from, to, p, spec = {}) {
  if (p >= 1 || from === to) return {...to};
  const out = {};
  for (const k of Object.keys(to)) {
    const a = from[k], b = to[k], mode = spec[k];
    if (mode === "hold") out[k] = p >= 1 ? b : (a === undefined ? b : a);
    else if (mode === "snap" || a === undefined) out[k] = b;
    else if (typeof a === "number" && typeof b === "number") out[k] = mode === "log" && a > 0 && b > 0 ? Math.exp(Math.log(a) + (Math.log(b) - Math.log(a)) * p) : a + (b - a) * p;
    else if (isNumArr(a) && isNumArr(b) && a.length === b.length) out[k] = a.map((x, j) => x + (b[j] - x) * p);
    else out[k] = b;
  }
  return out;
}

/* ---------------- timeline ---------------- */
/* cut "full" (every step, dur_s) or "film" (film steps, film_dur_s ?? dur_s). Times in whole frames, so
   t0 = f0 / FPS exactly. -> {cut, duration, frames, items: [{k, index, id, f0, frames, t0, t1, dur}]} */
export function buildTimeline(steps, cut = "full") {
  const items = []; let f = 0;
  steps.forEach((s, index) => {
    if (cut === "film" && !s.film) return;
    const d = cut === "film" && typeof s.film_dur_s === "number" ? s.film_dur_s : s.dur_s;
    const n = Math.max(1, Math.round(d * FPS));
    items.push({k: items.length, index, id: s.id, f0: f, frames: n, t0: f / FPS, t1: (f + n) / FPS, dur: n / FPS});
    f += n;
  });
  return {cut, duration: f / FPS, frames: f, items};
}
/* t -> {item, t (local seconds, clamped to [0, dur])}; t past the end holds the last frame's end state */
export function locate(tl, t) {
  const it = tl.items; if (!it.length) return null;
  const x = Number.isFinite(t) ? Math.max(0, t) : 0;
  let lo = 0, hi = it.length - 1;
  while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (it[mid].t0 <= x + 1e-9) lo = mid; else hi = mid - 1; }
  const item = it[lo];
  return {item, t: Math.min(item.dur, x - item.t0)};
}

function sceneOf(scenes, name) {
  const m = scenes instanceof Map ? scenes.get(name) : scenes[name];
  return m && m.default ? m.default : m;
}

/* tween progress inside a step: Play/video use the step's own time (frac of dur, default all of it);
   Step mode passes its own wall-clock progress through show(i, t, {p}). */
export function tweenProgress(step, t, dur) {
  const tw = step.tween;
  if (tw === null) return 1;
  const span = dur * (tw && typeof tw.frac === "number" ? tw.frac : 1);
  const e = EASE[(tw && tw.ease) || "inOut"] || EASE.inOut;
  return span > 0 ? e(clamp01(t / span)) : 1;
}

/* ---------------- engine ---------------- */
const ROOT_URL = new URL("../", import.meta.url);          // ROOT/ (docs/tng50/learn/how-a-spectrum-is-made/)
/* keys the engine adds to the state a scene receives; steps.json params must not use them (validateSteps) */
export const FRAME_KEYS = Object.freeze([...RESERVED]);
const parseG = x => { const m = x == null ? null : /^(?:tng50-1-99-)?(\d{1,9})$/i.exec(String(x).trim()); return m ? +m[1] : null; };

function contextFrom(o) {
  if (o.ctx) return o.ctx;
  const el = o.canvas || o.stage;
  if (!el) return null;
  let cv = typeof el.getContext === "function" ? el : (el.querySelector ? el.querySelector("canvas") : null);
  if (!cv && typeof document !== "undefined") {
    cv = document.createElement("canvas");
    cv.setAttribute("aria-hidden", "true");
    Object.assign(cv.style, {display: "block", width: "100%", height: "100%"});
    el.appendChild(cv);
  }
  if (!cv) return null;
  const dpr = o.dpr || 1;
  if (o.width && o.height) { cv.width = Math.round(o.width * dpr); cv.height = Math.round(o.height * dpr); }
  return cv.getContext("2d");
}
/* scene module by name, from js/scenes/<name>.js (names are checked against the schema pattern first) */
export async function importScene(name) {
  if (!/^[a-z][a-z0-9_]*$/.test(String(name))) throw new Error(`story engine: bad scene name ${JSON.stringify(name)}`);
  const m = await import(new URL(`./scenes/${name}.js`, import.meta.url).href);
  return m.default || m;
}

/* opts (all optional except doc or steps):
     doc        steps.json object ({schema, meta, keys, chapters, steps}); or steps (array) + meta + keys
     scenes     {name: module} or Map; scenes not given are imported from js/scenes/<name>.js in ready()
     ctx        CanvasRenderingContext2D (or a recording mock); else canvas, else stage (an element: its <canvas>, or a
                new one appended), sized width x height x dpr when width and height are given
     data       story data object; else loadData(async ({galaxy, ray}) => object); else fetched in ready() from
                dataUrl(galaxy, ray, meta.data_url) relative to ROOT (any galaxy of the sample that has story data)
     galaxy, ray   (or query: {g, ray}; else meta.g / meta.subhalo and meta.ray). g accepts 488530 or "tng50-1-99-488530"
     seed, cut ("full" | "film"), mode ("step" | "watch" | "render" ...), layout ("land" | "port"), physics,
     reduced (or reducedMotion), dpr, safe (plot safe-area insets, passed through to scenes)
     base, fetchJson, fetchBin   where and how ready() loads data/index.json, the story file and the stored line
                (default ROOT and window.fetch; tests pass file readers)
     schema     steps.schema.json object: ready() rejects an invalid steps.json
     fonts      [CSS font strings] for document.fonts.load; extraReady: [promises] (equation SVGs)
     onFrame    (info) => void after each render (drivers update captions; scenes never see it)
   Scenes receive state = authored (tweened) params + FRAME_KEYS: {step: id, chapter, scene, params (the same
   params object), p, t, u, dur_s, mode ("explore" while an override is shown), explore (override or null), dpr, layout,
   physics, reduced, seed (params.seed or the page seed), galaxy, ray, safe}; and env (see the header). */
export function createEngine(opts) {
  const doc = opts.doc || {schema: SCHEMA_ID, meta: opts.meta || {}, keys: opts.keys || null, steps: opts.steps || []};
  const steps = doc.steps, meta = doc.meta || {}, keys = doc.keys || opts.keys || null;
  const scenes = opts.scenes instanceof Map ? new Map(opts.scenes) : new Map(Object.entries(opts.scenes || {}));
  const q = opts.query || {};
  const env0 = {galaxy: parseG(opts.galaxy ?? q.g) ?? parseG(meta.g ?? meta.subhalo), ray: opts.ray ?? q.ray ?? meta.ray ?? null,
    seed: opts.seed ?? meta.seed ?? 0, reduced: !!(opts.reduced ?? opts.reducedMotion), layout: opts.layout || "land",
    mode: opts.mode || "step", physics: !!opts.physics, dpr: opts.dpr || 1, safe: opts.safe || null};
  let authored = authoredStates(steps, Object.fromEntries(scenes));
  let tl = buildTimeline(steps, opts.cut || "full");
  let data = opts.data || null, readyP = null, ctx = contextFrom(opts), last = null, story = null;
  const caches = new Map();

  const text = s => resolveTemplate(s, data || {}, keys).text;
  const durOf = index => { const it = tl.items.find(x => x.index === index); return it ? it.dur : Math.max(1, Math.round(steps[index].dur_s * FPS)) / FPS; };
  function envFor(index, t, dur, p, seed) {
    const s = steps[index], cv = ctx && ctx.canvas;
    return {step: s, index, id: s.id, scene: s.scene, t, dur, u: dur > 0 ? clamp01(t / dur) : 1, p,
      width: cv ? cv.width : 0, height: cv ? cv.height : 0, dpr: env0.dpr, cache: caches.get(s.scene),
      noise: ion => rng(seedFor(seed, ion, s.id)), reduced: env0.reduced, layout: env0.layout, mode: env0.mode,
      physics: env0.physics, galaxy: env0.galaxy, ray: env0.ray, text};
  }
  /* authored (or override-merged) params of step `index` at local time t (default: end); o.p overrides tween progress */
  function stateAt(index, t = Infinity, o = {}) {
    const s = steps[index], dur = durOf(index);
    const tt = Math.min(Math.max(0, Number.isFinite(t) ? t : dur), dur);
    const sc = scenes.get(s.scene) || {};
    const p = o.p != null ? clamp01(o.p) : tweenProgress(s, tt, dur);
    let st = interpState(authored[index].from, authored[index].to, p, sc.interp || {});
    if (o.override) st = {...st, ...o.override};
    return {state: st, t: tt, dur, p};
  }
  function draw(index, t, o) {
    if (!ctx) throw new Error("story engine: no 2D context");
    const s = steps[index], sc = scenes.get(s.scene);
    if (!sc || typeof sc.render !== "function") throw new Error(`story engine: scene ${s.scene} has no render() (call ready() first)`);
    const {state, t: tt, dur, p} = stateAt(index, t, o);
    const seed = Number.isInteger(state.seed) ? state.seed : env0.seed;
    const env = envFor(index, tt, dur, p, seed), ov = o && o.override ? {...o.override} : null;
    const fs = {...state, params: state, step: s.id, chapter: s.chapter, scene: s.scene, p, t: tt, u: env.u, dur_s: dur,
      mode: ov ? "explore" : env0.mode, explore: ov, dpr: env0.dpr, layout: env0.layout, physics: env0.physics,
      reduced: env0.reduced, seed, galaxy: env0.galaxy, ray: env0.ray, safe: env0.safe};
    ctx.save();
    try { sc.render(ctx, fs, tt, data, env); } finally { ctx.restore(); }
    last = {index, id: s.id, t: tt, u: env.u, p, chapter: s.chapter};
    if (opts.onFrame) opts.onFrame(last);
    return last;
  }

  const engine = {
    steps, doc,
    get authored() { return authored; },
    get timeline() { return tl; },
    get duration() { return tl.duration; },
    durationOf: cut => buildTimeline(steps, cut).duration,
    get data() { return data; },
    get last() { return last; },
    get env() { return {...env0}; },
    get context() { return ctx; },
    /* the data/index.json entry actually loaded ({galaxy, ray, story, page_fits, label}); differs from the request when
       the requested galaxy or sightline has no story data (the page can say so) */
    get story() { return story; },
    /* async: schema, scene modules, data, scene caches (prepare or ready), fonts, extra assets. Same promise every call. */
    ready() {
      if (readyP) return readyP;
      readyP = (async () => {
        const used = [...new Set(steps.map(s => s.scene))];
        for (const name of used) if (!scenes.has(name)) scenes.set(name, await importScene(name));
        for (const [k, m] of scenes) if (m && m.default && typeof m.render !== "function") scenes.set(k, m.default);
        authored = authoredStates(steps, Object.fromEntries(scenes));
        if (opts.schema) { const v = validateSteps(doc, opts.schema, [...scenes.keys()]); if (!v.ok) throw new Error("steps.json invalid:\n" + v.errors.join("\n")); }
        if (!data && opts.loadData) data = await opts.loadData({galaxy: env0.galaxy, ray: env0.ray});
        if (!data && opts.fetchData !== false && (typeof fetch === "function" || opts.fetchJson)) {
          const r = await loadStoryData(opts.base || ROOT_URL, env0.galaxy, env0.ray, meta.data_url, opts.fetchJson || fetchJson, opts.fetchBin || fetchBin);
          data = r.data; story = r.entry;
          if (r.entry) { env0.galaxy = r.entry.galaxy; env0.ray = r.entry.ray; }
        } else if (data && data.meta && data.lines == null && !data.lines_error && opts.fetchData !== false && (typeof fetch === "function" || opts.fetchJson)) {
          await completeStoryData(opts.base || ROOT_URL, data, opts.fetchJson || fetchJson, opts.fetchBin || fetchBin);
        }
        for (const name of used) {
          const sc = scenes.get(name), prep = sc && (sc.prepare || sc.ready);
          if (typeof prep === "function") caches.set(name, await prep.call(sc, data, {galaxy: env0.galaxy, ray: env0.ray}));
        }
        const fonts = opts.fonts || [];
        if (fonts.length && typeof document !== "undefined" && document.fonts) await Promise.all(fonts.map(f => document.fonts.load(f)));
        if (opts.extraReady) await Promise.all(opts.extraReady);
        return engine;
      })();
      return readyP;
    },
    /* video / Play: pure function of t on the current cut; never takes Explore overrides, never fits */
    seek(t) { const L = locate(tl, t); if (!L) return null; return draw(L.item.index, L.t); },
    /* Step / Explore: step index, local time (default: end of step), {p, override} */
    show(index, t, o = {}) { return draw(index, t, o); },
    stateAt,
    locate: t => locate(tl, t),
    indexOf: id => steps.findIndex(s => s.id === id),
    /* step index -> {t0, t1} in the current cut, or null when the step is not in the cut */
    span(index) { const it = tl.items.find(x => x.index === index); return it ? {t0: it.t0, t1: it.t1} : null; },
    setCut(cut) { tl = buildTimeline(steps, cut); return tl; },
    setContext(c) { ctx = c; },
    /* page-level switches; the next show()/seek() uses them */
    setEnv(o) { for (const k of ["reduced", "layout", "mode", "physics", "dpr", "safe", "seed"]) if (k in o) env0[k] = o[k]; },
    /* canvas backing size for CSS size w x h at dpr (the page calls it on resize; render.html once) */
    resize(w, h, dpr = env0.dpr) { const cv = ctx && ctx.canvas; if (!cv) return; env0.dpr = dpr; cv.width = Math.round(w * dpr); cv.height = Math.round(h * dpr); },
    scene: name => scenes.get(name) || null,
    text,
    /* every unresolved {{key}} in display text (missingKeys) and every key that fell back to its steps.json fallback
       because the data lack it (fallbackKeys), for tests and a dev warning */
    missingKeys() { return scanKeys("missing"); },
    fallbackKeys() { return scanKeys("fallback"); },
  };
  function scanKeys(kind) {
    const out = new Set();
    const one = (id, f, str) => { for (const k of resolveTemplate(str || "", data || {}, keys)[kind]) out.add(`${id}.${f}: ${k}`); };
    for (const s of steps) {
      for (const f of ["text", "sub", "caption", "voice", "aria", "title"]) one(s.id, f, s[f]);
      if (s.physics) one(s.id, "physics", s.physics.line);
    }
    return [...out];
  }
  return engine;
}

/* data URL of a galaxy + sightline: template with {g} and {ray} (default data/story_{g}_{ray}.json, relative to ROOT) */
export const DATA_URL = "data/story_{g}_{ray}.json";
export function dataUrl(g, ray, tpl = DATA_URL) { return String(tpl).split("{g}").join(String(g)).split("{ray}").join(String(ray)); }
/* ---------------- story index (data/index.json, schema story-index/1, written by U0) ---------------- */
/* {default: {galaxy, ray}, fion, stories: [{galaxy, ray, story, page_fits, label, eligible}]}. Galaxy-agnostic: any galaxy of
   the sample with an entry plays. -> the entry for (g, ray): exact match, else that galaxy's first sightline, else the
   index default, else the first entry; null for an empty index */
export const INDEX_URL = "data/index.json";
export function resolveStory(index, g, ray) {
  const list = index && Array.isArray(index.stories) ? index.stories : [];
  if (!list.length) return null;
  // an entry marked eligible: false (U0 story_facts: weak O VI, no black H I core, no S6 pair, no sane fits) never plays
  // as its own story; the request falls back to the default like a galaxy that is not exported
  const G = parseG(g), same = list.filter(e => +e.galaxy === G && e.eligible !== false);
  const d = index.default || {};
  return same.find(e => e.ray === ray) || same[0] || list.find(e => +e.galaxy === +d.galaxy && e.ray === d.ray) || list.find(e => +e.galaxy === +d.galaxy) || list[0];
}
/* where the explorer keeps the stored library line (TNGS binary) of a sightline, relative to ROOT: the default galaxy
   in the legacy docs/tng50/data/s/, any other galaxy in its pack docs/tng50/data/gal/<id>/s/ (explorer galaxies.js) */
export function lineUrl(index, entry) {
  if (entry.line) return "data/" + entry.line;
  const d = (index && index.default) || {};
  const tpl = (index && index.line_url) || (+entry.galaxy === +d.galaxy ? "../../data/s/{ray}.bin" : "../../data/gal/{g}/s/{ray}.bin");
  return dataUrl(+entry.galaxy, entry.ray, tpl);
}
/* fetch the story data of (g, ray): through data/index.json when it exists (also attaches page_fits, fion and the
   decoded stored line as data.lines = {vSys, OVI: {n, u0, du, rest, flux}, HI: ...} when the story file does not carry
   them; a missing line is recorded in data.lines_error, not thrown), else straight from dataUrl(g, ray, tpl).
   -> {data, entry} */
export async function loadStoryData(base, g, ray, tpl = DATA_URL, get = fetchJson, getBin = fetchBin) {
  const u = p => new URL(p, base).href;
  let index = null;
  try { index = await get(u(INDEX_URL)); } catch { index = null; }
  const entry = index ? resolveStory(index, g, ray) : null;
  if (!entry) {
    if (parseG(g) == null || !ray) throw new Error("story engine: no data/index.json and no galaxy + sightline to load");
    return {data: await get(u(dataUrl(parseG(g), ray, tpl || DATA_URL))), entry: null};
  }
  const data = await get(u("data/" + entry.story));
  await attachExtras(u, index, entry, data, get, getBin);
  return {data, entry: {...entry, galaxy: +entry.galaxy}};
}
async function attachExtras(u, index, entry, data, get, getBin) {
  if (entry.page_fits && data.page_fits == null) { try { data.page_fits = await get(u("data/" + entry.page_fits)); } catch { /* S11 numbers fall back */ } }
  if (index && index.fion && data.fion == null) { try { data.fion = await get(u("data/" + index.fion)); } catch { /* S4 only */ } }
  if (data.lines == null) {
    try { const dec = decodeTNGS(await getBin(u(lineUrl(index, entry)))); data.lines = {vSys: dec.vSys, ...dec.lines}; }
    catch (err) { data.lines_error = String((err && err.message) || err); }
  }
  return data;
}
/* a page that fetched the story JSON itself (index.html, for its {{key}} text before the engine loads) hands it to
   createEngine({data}); ready() completes it here with what loadStoryData would have attached (page fits, f_ion
   slice, decoded stored line), for any galaxy of the sample: the index entry when listed, else the default paths */
export async function completeStoryData(base, data, get = fetchJson, getBin = fetchBin) {
  if (!data || !data.meta) return data;
  const u = p => new URL(p, base).href;
  let index = null;
  try { index = await get(u(INDEX_URL)); } catch { index = null; }
  const g = +data.meta.galaxy, ray = data.meta.ray;
  const listed = index && Array.isArray(index.stories) ? index.stories.find(e => +e.galaxy === g && e.ray === ray) : null;
  const entry = listed || {galaxy: g, ray, page_fits: `page_fits_${g}_${ray}.json`};
  return attachExtras(u, index, entry, data, get, getBin);
}

export async function fetchBin(url) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`${url}: HTTP ${r.status}`);
  return r.arrayBuffer();
}
/* browser loader: fetch JSON (rejects on HTTP errors) */
export async function fetchJson(url) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`${url}: HTTP ${r.status}`);
  return r.json();
}
