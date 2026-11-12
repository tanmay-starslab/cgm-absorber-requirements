// Story store (PLAN_final sections 1.1, 1.2, 4; frozen interface of unit U1): one state object mirrored to the URL
// fragment, resume from localStorage, and the hand-off hash into the explorer.
//
// URL grammar (one grammar, in the fragment):   #s=<step id>&mode=step|watch|explore&R=<int>&sn=<int>&seed=<int>
//   plus g=<subhalo id>&ray=<sightline id> when they differ from the story's defaults (any galaxy of the sample
//   with a story data file; the explorer uses the same g=<id> key, galaxies.js). A bare #<chapter> (e.g. #lsf) or
//   #<step id> is an alias on input and is rewritten to #s=<first step of that chapter | that step>.
// Query = page shape only: ?embed=1, ?still, ?g=<id>&ray=<id> (g also accepts "tng50-1-99-<id>"). The fragment wins
// over the query for g and ray. render.html and ?still ignore the fragment and localStorage (ignoreUrl: true).
// Resume: the last state is kept in localStorage under "story:spectrum:last"; the URL always wins.
// Prefs (not in the URL): physics toggle (D9), Play speed, film/full cut.
//
// Pure helpers (node-testable): parseStoryUrl, formatFragment, resolveStepId, parseGalaxyId, handoffState,
// handoffHash, explorerHref. createStore takes injectable location/history/storage, so it also runs in node.

import {formatHash, LAYOUTS, ID_RE} from "../../../js/state.js";

export const MODES = Object.freeze(["step", "watch", "explore"]);
export const SPEEDS = Object.freeze([0.75, 1, 1.5]);
export const STORE_KEY = "story:spectrum:last";
export const PREFS_KEY = "story:spectrum:prefs";
export const SEED_MAX = 100000;                     // explorer parseHash keeps seed % 100000
export const R_RANGE = Object.freeze({min: 5000, max: 150000});   // explorer UV band R slider
export const SN_RANGE = Object.freeze({min: 2, max: 100});
export const EXPLORER_HREF = "../../index.html";    // ROOT = docs/tng50/learn/how-a-spectrum-is-made/

const isInt = x => Number.isInteger(x);
const clampI = (x, r) => Math.min(r.max, Math.max(r.min, Math.round(x)));

/* "488530", "tng50-1-99-488530" -> 488530; anything else -> null */
export function parseGalaxyId(x) {
  if (x == null) return null;
  const m = /^(?:tng50-1-99-)?(\d{1,9})$/i.exec(String(x).trim());
  return m ? +m[1] : null;
}
/* raw step reference -> step id: exact id, chapter id (first step of the chapter), else null */
export function resolveStepId(raw, steps) {
  if (!raw) return null;
  const r = String(raw).trim();
  if (steps.some(s => s.id === r)) return r;
  const ch = steps.find(s => s.chapter === r);
  return ch ? ch.id : null;
}

/* defaults = {s, mode, R, sn, seed, g, ray}. -> {state, alias (true when the fragment used a bare alias and should be
   rewritten), embed, still} */
export function parseStoryUrl(loc, steps, defaults) {
  const hash = String((loc && loc.hash) || "").replace(/^#/, ""), search = String((loc && loc.search) || "").replace(/^\?/, "");
  const q = new URLSearchParams(search), out = {...defaults};
  let alias = false;
  const qg = parseGalaxyId(q.get("g")); if (qg != null) out.g = qg;
  if (q.get("ray") && ID_RE.test(q.get("ray"))) out.ray = q.get("ray");
  if (hash && !hash.includes("=")) {                   // bare alias: #lsf, #lsf-2
    const id = resolveStepId(decodeURIComponent(hash), steps);
    if (id) { out.s = id; alias = true; }
  } else if (hash) {
    const h = new URLSearchParams(hash);
    const id = resolveStepId(h.get("s"), steps); if (id) out.s = id;
    if (h.get("s") && id && id !== h.get("s")) alias = true;
    if (MODES.includes(h.get("mode"))) out.mode = h.get("mode");
    const R = +h.get("R"); if (h.has("R") && Number.isFinite(R)) out.R = clampI(R, R_RANGE);
    const sn = +h.get("sn"); if (h.has("sn") && Number.isFinite(sn)) out.sn = clampI(sn, SN_RANGE);
    const sd = +h.get("seed"); if (h.has("seed") && isInt(sd) && sd >= 0) out.seed = sd % SEED_MAX;
    const g = parseGalaxyId(h.get("g")); if (g != null) out.g = g;
    if (h.get("ray") && ID_RE.test(h.get("ray"))) out.ray = h.get("ray");
  }
  if (!steps.some(s => s.id === out.s)) out.s = steps.length ? steps[0].id : null;
  return {state: out, alias, embed: q.get("embed") === "1", still: q.has("still")};
}

/* state -> fragment without "#". Keys in fixed order; R, sn, seed only when set; g, ray only when not default */
export function formatFragment(S, defaults = {}) {
  const p = [`s=${S.s}`, `mode=${MODES.includes(S.mode) ? S.mode : "step"}`];
  if (S.R != null) p.push(`R=${Math.round(S.R)}`);
  if (S.sn != null) p.push(`sn=${Math.round(S.sn)}`);
  if (S.seed != null) p.push(`seed=${S.seed}`);
  if (S.g != null && S.g !== defaults.g) p.push(`g=${S.g}`);
  if (S.ray && S.ray !== defaults.ray) p.push(`ray=${S.ray}`);
  return p.join("&");
}

/* ---------------- hand-off into the explorer (built only with state.js formatHash) ---------------- */
/* step.handoff + story state -> explorer state object S for formatHash */
export function handoffState(handoff, S) {
  const h = handoff || {};
  const Rh = Array.isArray(h.R) ? h.R : h.R && typeof h.R === "object" ? h.R.uv : null;   // [R..] or explorer {uv: [R1, R2]}
  const R = Array.isArray(Rh) && Rh.length ? Rh : [S.R ?? 30000];
  const sn = Array.isArray(h.sn) && h.sn.length ? h.sn : [S.sn ?? 10];
  const layout = LAYOUTS.includes(h.layout) ? h.layout : "1";
  return {id: S.ray || "", ions: (h.ions && h.ions.length ? h.ions : ["OVI"]).slice(), layout,
    R: {uv: [clampI(R[0], R_RANGE), clampI(R[1] ?? R[0], R_RANGE)]},
    sn: [clampI(sn[0], SN_RANGE), clampI(sn[1] ?? sn[0], SN_RANGE)],
    vc: Number.isFinite(h.vc) ? h.vc : 0, vhw: isInt(h.vhw) ? h.vhw : 400,
    seed: isInt(S.seed) ? S.seed % SEED_MAX : 0, fit: h.fit !== false, intr: !!h.intr, tab: h.tab === "3d" ? "3d" : "spectra"};
}
/* -> fragment for the explorer: "g=<id>&" (only off the default galaxy, like galaxies.js galaxyHashPart) +
   formatHash(S) + "&from=story" (unknown keys are ignored by parseHash) */
export function handoffHash(handoff, S, {defaultG = null, from = true} = {}) {
  const g = S.g != null && S.g !== defaultG ? `g=${S.g}&` : "";
  return g + formatHash(handoffState(handoff, S)) + (from ? "&from=story" : "");
}
export const explorerHref = (handoff, S, o = {}) => `${o.base || EXPLORER_HREF}#${handoffHash(handoff, S, o)}`;

/* ---------------- store ---------------- */
const memStorage = () => { const m = new Map(); return {getItem: k => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: k => m.delete(k)}; };
const safe = (f, d = null) => { try { return f(); } catch { return d; } };

/* opts = {steps, defaults: {s, mode, R, sn, seed, g, ray}, location, history, storage (localStorage-like),
     ignoreUrl (render.html, ?still), writeUrl (default true unless ignoreUrl)}.
   -> {get(), set(patch, {push}), subscribe(fn) -> unsubscribe, resume() -> saved state | null, prefs(), setPrefs(patch),
       fromUrl() (re-read after hashchange), alias, embed, still, defaults} */
export function createStore(opts) {
  const steps = opts.steps, defaults = Object.freeze({mode: "step", seed: 0, ...opts.defaults, s: (opts.defaults && opts.defaults.s) || (steps[0] && steps[0].id)});
  const loc = opts.location || (typeof location !== "undefined" ? location : {hash: "", search: ""});
  const hist = opts.history || (typeof history !== "undefined" ? history : null);
  const storage = opts.storage || safe(() => (typeof localStorage !== "undefined" ? localStorage : null)) || memStorage();
  const ignoreUrl = !!opts.ignoreUrl, writeUrl = opts.writeUrl ?? !ignoreUrl;
  const subs = new Set();
  const parsed = ignoreUrl ? {state: {...defaults}, alias: false, embed: false, still: false} : parseStoryUrl(loc, steps, defaults);
  let S = parsed.state;
  const hadFragment = !ignoreUrl && !!String(loc.hash || "").replace(/^#/, "");

  function write(push) {
    if (!writeUrl || !hist) return;
    const frag = "#" + formatFragment(S, defaults);
    if (String(loc.hash || "") === frag) return;
    safe(() => (push ? hist.pushState(null, "", frag) : hist.replaceState(null, "", frag)));
  }
  function save() { if (!ignoreUrl) safe(() => storage.setItem(STORE_KEY, JSON.stringify(S))); }
  const store = {
    defaults, alias: parsed.alias, embed: parsed.embed, still: parsed.still,
    get: () => ({...S}),
    set(patch, o = {}) {
      const next = {...S, ...patch};
      if (patch.s !== undefined) next.s = resolveStepId(patch.s, steps) || S.s;
      if (patch.mode !== undefined && !MODES.includes(patch.mode)) next.mode = S.mode;
      const changed = Object.keys(next).some(k => next[k] !== S[k]);
      if (!changed) return S;
      const prev = S; S = next; write(!!o.push); save();
      for (const f of subs) f({...S}, prev);
      return S;
    },
    subscribe(f) { subs.add(f); return () => subs.delete(f); },
    /* saved state from an earlier visit, or null when the URL already named a step (URL wins), the saved step no longer
       exists, or it equals the current state */
    resume() {
      if (ignoreUrl || hadFragment) return null;
      const v = safe(() => JSON.parse(storage.getItem(STORE_KEY) || "null"));
      if (!v || !steps.some(s => s.id === v.s) || v.s === S.s) return null;
      return {...defaults, ...v, mode: "step"};
    },
    prefs: () => ({physics: false, speed: 1, cut: "full", ...(safe(() => JSON.parse(storage.getItem(PREFS_KEY) || "null")) || {})}),
    setPrefs(patch) { const p = {...store.prefs(), ...patch}; if (!SPEEDS.includes(p.speed)) p.speed = 1; safe(() => storage.setItem(PREFS_KEY, JSON.stringify(p))); return p; },
    fromUrl() { if (ignoreUrl) return S; const r = parseStoryUrl(loc, steps, defaults); store.alias = r.alias; return store.set(r.state); },
    clearSaved() { safe(() => storage.removeItem(STORE_KEY)); },
  };
  if (parsed.alias) write(false);        // rewrite #lsf -> #s=lsf-1
  return store;
}
