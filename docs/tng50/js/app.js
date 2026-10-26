// TNG50 explorer page (Phase 3): the orchestration module loaded by docs/tng50/_template.html. It owns the state
// (design §6.3), the catalogue, sightline loading, the sightline servers and generation jobs, the popovers, the ion
// selector, the layout, the on-the-fly fits (js/fitworker.js, design §5.5), the 3D tab and its live thumbnail
// (js/viewer3d.js), Find (js/search.js), Ask (js/chat.js) and the window.tngApp v3 bridge (§6.5).
// Rendering is in spectra.js, the instrument sliders in instrument.js, the sightline picker in gallery.js and the
// pure state (hash, slider maps, validation) in state.js.
import {makeRegistry, cloneState, casesFor, bandsOf, clampView, parseHash, formatHash, instrumentPatch, ID_RE, LAYOUTS,
  fmtR, fmtNum, minus, nf, annotateLimits, fitClass, fitLimits} from "./state.js";
import {createSpectra} from "./spectra.js";
import {createGallery, kindOf, nShow} from "./gallery.js";
import {createInstrument} from "./instrument.js";
import * as FITM from "./fit.js";
const {degradeV, decodeTNGS, seedFor, cacheKey, fitPanel, FIT_VERSION, FIT_PARAMS} = FITM;

/* ---------------- config ---------------- */
const CFG = Object.assign({
  version: 3, catalog_url: "data/catalog.json", bin_dir: "data/s/", backends: ["http://127.0.0.1:8787"],
  galaxy: {sim: "TNG50-1", snapshot: 99, redshift: 0, subhalo_id: 488530}, ions: [], bands: {}, snr: {min: 2, max: 100, default: 10, pair: [20, 5]},
  defaults: {id: "edge_b100_a090"}, viz: null, components_url: "data/components.json", three: "0.169.0", js_base: "js/",
  chat: {enabled: false}, custom: {r_max_kpc: 395, l_min_kpc: 20, l_max_kpc: 800}, fitter: {worker: "js/fitworker.js", version: "fit/1"}
}, window.TNG_DATA || {});
const reg = makeRegistry(CFG), {ION} = reg;
const STAGES = ["queued", "load", "ray", "spectra", "fit", "save"];
const C_KMS = 299792.458;

/* ---------------- helpers ---------------- */
const $ = s => document.querySelector(s), $$ = s => Array.from(document.querySelectorAll(s));
const esc = s => String(s).replace(/[&<>"']/g, c => ({"&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"}[c]));
const emit = (name, detail) => dispatchEvent(new CustomEvent(name, {detail}));
const store = {get(k) { try { return localStorage.getItem(k); } catch { return null; } },
  set(k, v) { try { v == null ? localStorage.removeItem(k) : localStorage.setItem(k, v); } catch { /* storage blocked */ } }};
const clamp = (x, a, b) => Math.min(b, Math.max(a, x));
const fb = x => Number.isInteger(+x) ? String(+x) : fmtNum(+x, 1);
const isDark = () => getComputedStyle(document.documentElement).getPropertyValue("--scheme").trim() === "dark";
const ionColor = k => ION[k] ? (isDark() ? ION[k].color_dark : ION[k].color) : "#888";
const modUrl = f => new URL(CFG.js_base + f, location.href).href;
const strip = e => { const o = {}; for (const k in e) if (k[0] !== "_") o[k] = e[k]; return o; };
const debounce = (f, ms) => { let t = 0; return (...a) => { clearTimeout(t); t = setTimeout(() => f(...a), ms); }; };

/* ---------------- state ---------------- */
const S = Object.assign(cloneState(reg.DEF), {id: null});
const CAT = new Map();          // id -> catalogue entry (+ _static, _seq)
let SEQ = 0, CATV = 0, catEmitted = -1;
const SIGHT = new Map();        // id -> decoded TNGS (fit.js decodeTNGS)
let API = null, HEALTH = null, PROBES = [], pendingId = null;

/* ---------------- theme ---------------- */
const THEMES = ["auto", "light", "dark"];
let theme = THEMES.includes(store.get("tngsight.theme")) ? store.get("tngsight.theme") : "auto";
function applyTheme(t) { if (t === "auto") delete document.documentElement.dataset.theme; else document.documentElement.dataset.theme = t;
  const b = $("#theme"); b.dataset.mode = t; b.setAttribute("aria-label", "Theme: " + t); b.title = "Theme: " + t; }
applyTheme(theme);
$("#theme").addEventListener("click", () => { theme = THEMES[(THEMES.indexOf(theme) + 1) % 3]; store.set("tngsight.theme", theme); applyTheme(theme); });
function themeChanged() { buildIons(); build3dField(); spectra.schedule(); }
new MutationObserver(() => themeChanged()).observe(document.documentElement, {attributes: true, attributeFilter: ["data-theme"]});
matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => themeChanged());

/* ---------------- notes and status ---------------- */
let noteT = 0;
function note(t, cls = "") { const n = $("#note"); n.textContent = t || ""; n.className = cls; clearTimeout(noteT); if (t) noteT = setTimeout(() => { n.textContent = ""; }, 8000); }
function geomsg(t, cls = "", code = "info") { const m = $("#geomsg"); m.className = "msg " + cls; m.textContent = t; m.dataset.code = code; }

/* ---------------- catalogue ---------------- */
function upsert(e, isStatic) { if (!e || !e.id || !ID_RE.test(e.id)) return;
  const old = CAT.get(e.id), ne = Object.assign({}, old || {}, e);
  ne._static = (old && old._static) || !!isStatic; ne._seq = old ? old._seq : ++SEQ; CAT.set(e.id, ne); CATV++; }
function sorted() {
  const lib = [], gen = [];
  for (const e of CAT.values()) (e.source === "generated" ? gen : lib).push(e);
  /* tune1 F11: library sightlines in a scannable order (face-on, edge-on, random; then b, azimuth, seed); this is also the
     prev/next (j/k) order */
  const OR = {"face-on": 0, "edge-on": 1, random: 2};
  lib.sort((a, b) => (OR[a.orientation] ?? 3) - (OR[b.orientation] ?? 3) || (+a.b_kpc || 0) - (+b.b_kpc || 0) || (+a.azimuth_deg || 0) - (+b.azimuth_deg || 0) ||
    (+a.seed || 0) - (+b.seed || 0) || (a.id < b.id ? -1 : 1));
  gen.sort((a, b) => b._seq - a._seq);
  return lib.concat(gen);
}
const gallery = createGallery({pop: $("#gal-pop"), search: $("#gal-search"), filter: $("#filter"), showcase: $("#showcase"), list: $("#gal-list"), count: $("#galcount")},
  {entries: sorted, current: () => S.id, onPick: id => { closePops(); select(id, false, "gallery"); }});
function catalogChanged() { gallery.render(); if (CATV !== catEmitted) { catEmitted = CATV; emit("tng:catalog", {n: CAT.size}); } }
function step(d) { const list = gallery.visible.length ? gallery.visible : sorted(); if (!list.length) return;
  let i = list.findIndex(e => e.id === S.id); i = i < 0 ? 0 : (i + d + list.length) % list.length; select(list[i].id, false, "gallery"); }

/* ---------------- IndexedDB cache for generated sightlines ---------------- */
const IDB = (() => { let db = null, req = null, failed = false;
  function open(ms) { if (db) return Promise.resolve(db); if (failed) return Promise.resolve(null);
    if (!req) { try { req = indexedDB.open("tngsight", 1);
        req.onupgradeneeded = () => req.result.createObjectStore("bins"); req.onsuccess = () => { db = req.result; }; req.onerror = () => { failed = true; };
      } catch { failed = true; return Promise.resolve(null); } }
    return new Promise(res => { const t = setTimeout(() => res(null), ms);
      req.addEventListener("success", () => { clearTimeout(t); res(db); }); req.addEventListener("error", () => { clearTimeout(t); res(null); }); }); }
  async function tx(mode, fn, ms = 3000) { const d = await open(ms); if (!d) return null; return new Promise(res => { try { const t = d.transaction("bins", mode), st = t.objectStore("bins");
    const r = fn(st); t.oncomplete = () => res(r && "result" in r ? r.result : true); t.onerror = t.onabort = () => res(null); } catch { res(null); } }); }
  return {get: id => tx("readonly", s => s.get(id)), put: (id, v) => tx("readwrite", s => s.put(v, id), 60000), all: () => tx("readonly", s => s.getAll())};
})();

/* ---------------- sightline data ---------------- */
async function fetchBin(url, ms = 20000) { const ac = new AbortController(), t = setTimeout(() => ac.abort(), ms);
  try { const r = await fetch(url, {signal: ac.signal}); if (!r.ok) throw new Error(`HTTP ${r.status} for ${url}`); return await r.arrayBuffer(); } finally { clearTimeout(t); } }
/* B_fix R1: least-recently-used cache. A hit refreshes the entry, and the selected sightline is never evicted (a
   neighbour prefetch used to drop it, leaving every panel on "loading"); concurrent loads of one id share a promise */
const SIGHT_MAX = 30, SIGHT_LOAD = new Map(), SIGHT_FAIL = new Set();
function putSight(id, s) { SIGHT.delete(id); SIGHT.set(id, s);
  for (const k of SIGHT.keys()) { if (SIGHT.size <= SIGHT_MAX) break; if (k !== S.id && k !== id) SIGHT.delete(k); } }
function getSight(id) {
  if (SIGHT.has(id)) { const s = SIGHT.get(id); SIGHT.delete(id); SIGHT.set(id, s); return Promise.resolve(s); }
  if (SIGHT_LOAD.has(id)) return SIGHT_LOAD.get(id);
  const pr = loadSight(id).then(s => { SIGHT_FAIL.delete(id); return s; }, x => { SIGHT_FAIL.add(id); throw x; }).finally(() => SIGHT_LOAD.delete(id));
  SIGHT_LOAD.set(id, pr); return pr;
}
/* a redraw that finds the selected sightline missing from the cache reloads it instead of drawing "loading" for ever */
function ensureSight() { const id = S.id; if (!id || SIGHT.has(id) || SIGHT_LOAD.has(id) || SIGHT_FAIL.has(id) || !CAT.has(id)) return;
  getSight(id).then(() => { if (id === S.id) { clampView(S, vmax()); inst.syncV(); buildIons(); draw(); } }, () => {}); }
async function loadSight(id) {
  const e = CAT.get(id); let buf = null, err = null;
  if (e && e._static) { try { buf = await fetchBin(CFG.bin_dir + id + ".bin"); } catch (x) { err = x; } }
  if (!buf) { const c = await IDB.get(id); if (c && c.bin) buf = c.bin; }
  if (!buf && API) { try { buf = await fetchBin(`${API}/api/sightline/${id}.bin`); if (e && !e._static) IDB.put(id, {entry: strip(e), bin: buf}); } catch (x) { err = x; backendFailed(); } }
  if (!buf) throw err || new Error(`sightline ${id} is not in the static library and no server is online`);
  const s = decodeTNGS(buf, reg.KEYS.length ? reg.KEYS : null); putSight(id, s); return s;
}
const vSysOf = id => { const s = SIGHT.get(id); return s && Number.isFinite(s.vSys) ? s.vSys : +(CAT.get(id)?.v_sys) || 0; };
/* B_fix m5: the window is in the systemic frame (V = u + vSys), so the reach is measured there: all the data can be
   panned to, at the cost of a data-free strip on one side at the widest window when vSys is not zero */
function lineW(id, k) { const L = SIGHT.get(id)?.lines[k]; if (L) { const vs = vSysOf(id); return Math.max(Math.abs(L.u0 + vs), Math.abs(L.u0 + (L.n - 1) * L.du + vs)); }
  const w = CAT.get(id)?.W_kms?.[k]; return +w || 1500; }
const vmaxFor = ions => Math.max(10, ...ions.map(k => lineW(S.id, k)));
const vmax = () => vmaxFor(S.ions);
const FIG_V_CAP = +(CFG.grid && CFG.grid.damped_v_max_kms) || 10000;   // the widest line window (damped H I)

/* degraded data per panel: the full line, so cached fits never depend on the view window. C2 (code 7): least recently
   used, capped by bytes rather than entries (a damped H I line at R 150,000 holds about 1 MB per entry); the entry
   just stored always stays */
const DG = new Map(), DG_MAX_BYTES = 64 * 1024 * 1024; let dgBytes = 0;
const dgSize = d => [d.v, d.flux, d.model, d.sigma].reduce((s, a) => s + (a && a.byteLength || 0), 0);
function dgPut(key, d) {
  if (DG.has(key)) { dgBytes -= DG.get(key)._bytes; DG.delete(key); }
  d._bytes = dgSize(d); DG.set(key, d); dgBytes += d._bytes;
  for (const [k, e] of DG) { if (dgBytes <= DG_MAX_BYTES || k === key) break; DG.delete(k); dgBytes -= e._bytes; }
}
function caseRS(ion, ci) { const c = casesFor(S.layout)[ci] || [0, 0], band = ION[ion]?.band; return [S.R[band]?.[c[0]] ?? 0, S.sn[c[1]]]; }
const panelSeed = (ion, ci) => seedFor(S.seed, ion, ci);
function dataFor(ion, ci) {
  const s = SIGHT.get(S.id); const L = s && s.lines[ion]; if (!L) return null;
  const [R, sn] = caseRS(ion, ci), seed = panelSeed(ion, ci), key = `${S.id}|${ion}|${R}|${sn}|${seed}`;
  let d = DG.get(key);
  if (!d) { const vSys = vSysOf(S.id), o = degradeV(L, R, sn, vSys, {seed}); d = {v: o.v, flux: o.flux, model: o.model, sigma: o.sigma, dvp: o.v.length > 1 ? o.v[1] - o.v[0] : C_KMS / R / 5, line: L, vSys, R, sn, seed};
    dgPut(key, d); }
  else { DG.delete(key); DG.set(key, d); }
  return d;
}

/* ---------------- components (static catalogue + server) ---------------- */
const DEF_KEYS = ["v", "dv", "logN", "dlogN", "b", "db", "region", "flag", "EW"];
const COMPRAW = new Map();      // id -> {keys, rows: {k: rows}, aod: {k: [total, regions]}, tag}
let CIX = null, compMeta = {params_tag: null, fitter: null, params: null, comp_keys: DEF_KEYS};
function normComps(obj, keys = DEF_KEYS, aod = null, tag = null) {   // rows or dict form -> raw rows store
  if (!obj || typeof obj !== "object") return null;
  const rows = {}, a = Object.assign({}, aod || obj.aod || {});
  for (const [k, list] of Object.entries(obj)) { if (k === "aod" || !Array.isArray(list)) continue;
    rows[k] = list.map(r => Array.isArray(r) ? r : keys.map(q => r[q] ?? (q === "region" ? 0 : q === "flag" ? 0 : null))); }
  return {keys, rows, aod: a, tag};
}
/* C2 (owner decision 2): every catalogue a consumer sees (Find, Ask, tngApp.components) carries logN_lo on its lower
   limits (state.js annotateLimits, from the region AOD in raw.aod), so search and chat present them as log N > x.
   Memoised per raw store; tngApp.components hands out a copy. */
const DICTS = new WeakMap();
function dictsOf(raw) {
  if (!raw) return null; let d = DICTS.get(raw);
  if (!d) { d = annotateLimits(Object.fromEntries(Object.entries(raw.rows).map(([k, rows]) => [k, rows.map(r => Object.fromEntries(raw.keys.map((q, i) => [q, r[i]])))])), raw.aod);
    DICTS.set(raw, d); }
  return d;
}
function componentsIndex() {
  if (CIX) return CIX;
  CIX = (async () => { let ok = false;
    const take = (j, isStatic) => { const keys = j.comp_keys || DEF_KEYS;
      if (isStatic || !compMeta.params_tag) compMeta = {params_tag: j.params_tag || null, fitter: j.fitter || null, params: j.params || null, comp_keys: keys};
      for (const [id, c] of Object.entries(j.entries || {})) if (!COMPRAW.has(id) || isStatic) COMPRAW.set(id, normComps(c, keys, (j.aod || {})[id], j.params_tag)); };
    try { const r = await fetch(CFG.components_url); if (r.ok) { take(await r.json(), true); ok = true; } } catch { /* offline file */ }
    if (API) try { const r = await fetch(API + "/api/components"); if (r.ok) { take(await r.json(), false); ok = true; } } catch { /* server optional */ }
    if (!ok) { CIX = null; throw new Error("no components catalogue is available"); }
    return {get params() { return compMeta.params; }, get fitter() { return compMeta.fitter; }, get params_tag() { return compMeta.params_tag; }, comp_keys: compMeta.comp_keys,
      get entries() { return Object.fromEntries([...COMPRAW].map(([id, raw]) => [id, dictsOf(raw)])); },
      get aod() { return Object.fromEntries([...COMPRAW].map(([id, raw]) => [id, raw.aod])); }}; })();
  return CIX;
}
async function ensureComps(id) {
  if (COMPRAW.has(id)) return COMPRAW.get(id); const e = CAT.get(id); if (!e) return null;
  if (!e._static && API) try { const r = await fetch(`${API}/api/components/${encodeURIComponent(id)}.json`); if (r.ok) { const j = await r.json();
    const raw = normComps(j.components, j.comp_keys || DEF_KEYS, j.aod, j.params_tag); if (raw) { COMPRAW.set(id, raw); return raw; } } } catch { /* fall through */ }
  try { await componentsIndex(); } catch { return null; }
  return COMPRAW.get(id) || null;
}
async function components(id) { const d = dictsOf(await ensureComps(id)); return d ? JSON.parse(JSON.stringify(d)) : null; }

/* ---------------- fits (design §5.5) ---------------- */
const NOCOMP = new Set();       // ids whose components could not be found (B_fix R7)
const FIT = {res: new Map(), pend: new Map(), wait: new Map(), worker: null, mode: null, reqN: 0, t0: 0, last: "", queue: [], dog: 0};
/* "none" while a sightline has no components, so a later catalogue never meets a cached "no seeds" result (B_fix R7) */
const fitParamsTag = id => `${CFG.registry_tag || "reg"}:${COMPRAW.has(id) ? COMPRAW.get(id)?.tag || compMeta.params_tag || "cat" : "none"}`;
function fitIdent(ion, ci) { const [R, sn] = caseRS(ion, ci); return {id: S.id, ion, R, snr: sn, seed: panelSeed(ion, ci), paramsTag: fitParamsTag(S.id), ci}; }
function putRes(key, r) { FIT.res.delete(key); FIT.res.set(key, r); while (FIT.res.size > (FIT_PARAMS.cacheSize || 256)) FIT.res.delete(FIT.res.keys().next().value); }
function startWorker() {
  if (FIT.mode) return;
  try { const w = new Worker(modUrl("fitworker.js"), {type: "module"});
    w.onmessage = ev => onFitMsg(ev.data);
    /* B_fix R6: the moved requests stay in FIT.pend (pumpMain removes each as it finishes), so fitPump neither queues them
       twice nor loses the ability to cancel the stale ones */
    w.onerror = ev => { ev.preventDefault?.(); if (FIT.mode === "worker") { FIT.mode = "main"; FIT.worker = null; for (const [, p] of FIT.pend) FIT.queue.push(p); pumpMain(); } };
    FIT.worker = w; FIT.mode = "worker";
  } catch { FIT.mode = "main"; }
}
/* watchdog: a module worker that never answers (seen once under heavy machine load: 20 panels stuck "running") is
   replaced by the main-thread path after 20 s of silence while fits are pending */
function fitDog() { clearTimeout(FIT.dog); if (FIT.mode !== "worker" || !FIT.pend.size) return;
  FIT.dog = setTimeout(() => { if (FIT.mode !== "worker" || !FIT.pend.size) return;
    try { FIT.worker.terminate(); } catch { /* already gone */ } FIT.mode = "main"; FIT.worker = null;
    for (const [, p] of FIT.pend) FIT.queue.push(p); pumpMain(); }, 20000); }
function onFitMsg(m) { fitDog();
  const p = FIT.pend.get(m.key) || [...FIT.pend.values()].find(q => q.reqId === m.reqId);
  if (!p) { if (m.type === "result" && m.key) { putRes(m.key, m.result); spectra.schedule(); } return; }   // finished after a cancel: keep it
  FIT.pend.delete(p.key);
  const r = m.type === "result" ? m.result : {key: p.key, status: "error", message: m.message || "fit failed", comps: [], windows: [], model: null, profiles: [], ms: 0};
  finishFit(p, r);
}
function finishFit(p, r) {
  putRes(p.key, r);
  emit("tng:fit", {id: p.id, ion: p.ion, case: p.ci, R: p.R, snr: p.snr, seed: p.seed, status: r.status, ms: r.ms ?? null, n_comp: (r.comps || []).length});
  for (const f of FIT.wait.get(p.key) || []) f(r); FIT.wait.delete(p.key);
  if (p.id === S.id) spectra.schedule();
}
let mainBusy = false;
function pumpMain() { if (mainBusy || !FIT.queue.length) return; mainBusy = true;
  setTimeout(() => { const p = FIT.queue.shift(); mainBusy = false; if (p && FIT.pend.get(p.key) === p) { let r; try { r = fitPanel(p.req); } catch (x) { r = {status: "error", message: String(x.message || x), comps: [], windows: []}; }
    FIT.pend.delete(p.key); finishFit(p, r); } pumpMain(); }, 0); }
/* -> {key, req} for a panel of the selected sightline, or {key, result} when it can be answered without fitting */
function fitRequest(ion, ci) {
  const I = fitIdent(ion, ci), key = cacheKey(I), raw = COMPRAW.get(S.id), d = dataFor(ion, ci), A = ION[ion];
  if (!d || !A) return {key, I, result: {key, status: "no_seeds", message: "line not in this sightline", comps: [], windows: [], model: null, profiles: [], ms: 0}};
  const seeds = raw?.rows?.[ion] || [], regions = raw?.aod?.[ion]?.[1] || [];
  if (!raw || !seeds.length || !regions.length) return {key, I, result: {key, status: "no_seeds", comps: [], windows: [], model: null, profiles: [], ms: 0}};
  const req = {id: I.id, ion, R: I.R, snr: I.snr, seed: I.seed, paramsTag: I.paramsTag,
    atom: {lam0_A: A.lam0_A, f: A.f, gamma_s: A.gamma_s, b_min: A.fit?.b_min, logN_max: A.fit?.logN_max},
    line: {u0: d.line.u0, du: d.line.du, n: d.line.n, flux: d.line.flux}, vSys: d.vSys,
    data: {v: d.v, flux: d.flux, sigma: d.sigma}, seeds, compKeys: raw.keys, regions};
  return {key, req, I};
}
function enqueueFit(ion, ci) {
  const fr = fitRequest(ion, ci);
  if (FIT.res.has(fr.key) || FIT.pend.has(fr.key)) return fr.key;
  if (fr.result) { finishFit({key: fr.key, ...fr.I}, fr.result); return fr.key; }
  startWorker(); if (!FIT.pend.size) { FIT.t0 = performance.now(); FIT.last = ""; }
  const p = {key: fr.key, reqId: ++FIT.reqN, req: fr.req, ...fr.I}; FIT.pend.set(fr.key, p);
  if (FIT.mode === "worker") { FIT.worker.postMessage({type: "fit", reqId: p.reqId, req: fr.req}); fitDog(); } else { FIT.queue.push(p); pumpMain(); }
  return fr.key;
}
/* after each draw: queue the panels in reading order (debounced so slider drags do not flood the worker) */
const fitPump = debounce(() => {
  if (!S.fit || !S.id || !SIGHT.has(S.id)) return;
  /* B_fix R7: a sightline with no components catalogue (offline generated sightline, components.json missing) is marked,
     so its panels get "no seeds" results and the status settles instead of staying at "fits 0 of N" */
  if (!COMPRAW.has(S.id) && !NOCOMP.has(S.id)) { const id = S.id; ensureComps(id).then(r => { if (!r) NOCOMP.add(id); fitSig = ""; spectra.schedule(); }); return; }
  const n0 = FIT.reqN, want = new Set(); for (const p of spectra.geometry().panels) want.add(enqueueFit(p.ion, p.ci));
  if (FIT.reqN === n0 && !FIT.pend.size) FIT.last = "";          // everything came from the cache: no batch time to show
  /* B_fix R4: a request someone awaits (tngApp.fit) is never cancelled as stale, so its promise always settles */
  const stale = [...FIT.pend.keys()].filter(k => !want.has(k) && !FIT.wait.has(k));
  if (stale.length) { if (FIT.mode === "worker") FIT.worker.postMessage({type: "cancel", keys: stale}); else FIT.queue = FIT.queue.filter(p => !stale.includes(p.key));
    for (const k of stale) FIT.pend.delete(k); }
  fitStatus();
}, 120);
function fitResult(ion, ci) { if (!S.fit) return null; return FIT.res.get(cacheKey(fitIdent(ion, ci))) || null; }
/* C2 (owner decision 2, code 2): how a fitted component reads -> {limit, loose, hollow, tags, lo}. fit.js fitQuality(c)
   ("ok", "sat", "unconstrained" or "bound") decides when the fit module exports it; without it state.js fitClass
   applies the same flag rule. A lower limit's value lo is the smaller of the fitted log N and its share of the AOD
   column of the degraded data over its fit window (state.js fitLimits), cached on the result per data object. */
const FITQ = typeof FITM.fitQuality === "function" ? FITM.fitQuality : null;
const fitQ = c => { if (!FITQ) return null; try { return FITQ(c); } catch { return null; } };
const pm = (x, d) => (Number.isFinite(x) ? `±${fmtNum(x, d)}` : "");
function compQuality(c, ion, r, d) {
  const damped = !!ION[ion]?.damped, cls = x => fitClass(x, damped, fitQ(x)), q = cls(c);
  if (q.limit) {
    if (r && (!r._lim || r._limD !== d)) { r._lim = fitLimits(r, d, ION[ion], x => cls(x).limit); r._limD = d; }
    const lo = r && r._lim ? r._lim.get(c) : undefined; q.lo = Number.isFinite(lo) ? lo : c.logN;
  }
  return q;
}
function fitStatus() {
  const fs = $("#fitstatus");
  if (!S.fit) { fs.dataset.state = "idle"; fs.textContent = ""; return; }
  const ps = spectra.geometry().panels, rs = ps.map(p => fitResult(p.ion, p.ci)), done = rs.filter(Boolean).length;
  if (done < ps.length) { fs.dataset.state = "running"; fs.textContent = `fits ${done} of ${ps.length}`; return; }
  const st = rs.some(r => r.status === "error") ? "error" : rs.some(r => r.status === "budget") ? "budget" : "done";
  if (FIT.t0 && !FIT.pend.size) { FIT.last = `  ${((performance.now() - FIT.t0) / 1000).toFixed(1)} s`; FIT.t0 = 0; }
  fs.dataset.state = st; fs.textContent = ps.length && rs.every(r => r.status === "no_seeds") ? "no seeds" : `fits ${done} of ${ps.length}${FIT.last}`;
}

/* ---------------- spectra stage ---------------- */
let instEmit = null, fitSig = "";
const spectra = createSpectra({box: $("#spectra"), cv: $("#cv"), hitboxes: $("#hitboxes"), axis: $("#vaxis"), axisCv: $("#vaxis-cv"), more: $("#more-below")}, {
  get S() { return S; }, reg, caseRS, vmax, color: ionColor,
  data: (ion, ci) => (S.id && SIGHT.has(S.id) ? dataFor(ion, ci) : null),
  fit: fitResult, quality: compQuality,
  /* tune1 F13: each row's catalogue log N sits beside its ion box (every selected line, never truncated) */
  rowNote: ion => { const v = CAT.get(S.id)?.logN?.[ion]; return Number.isFinite(v) ? `log N ${fmtNum(v, 1)}` : ""; },
  missingText: ion => !S.id ? "" : SIGHT.has(S.id) ? `${ION[ion].label} is not in this sightline` : "loading",
  readout(p, v) { const d = S.id && SIGHT.has(S.id) ? dataFor(p.ion, p.ci) : null; const lN = CAT.get(S.id)?.logN?.[p.ion];
    let t = `${ION[p.ion].label}${Number.isFinite(lN) ? `  log N ${fmtNum(lN, 1)}` : ""}  v ${minus(Math.round(v))} km/s`;
    if (d) { const m = clamp(Math.round((v - d.v[0]) / d.dvp), 0, d.v.length - 1); t += `  F ${fmtNum(d.flux[m], 2)}`; }
    if (S.fit) { const r = fitResult(p.ion, p.ci);
      if (r && r.comps && r.comps.length) { const c = r.comps.reduce((a, b) => Math.abs(b.v - v) < Math.abs(a.v - v) ? b : a);
        /* B_fix M1, m3: with errors, or "unconstrained" when the fit does not pin the component; b keeps a decimal below 10.
           C2 (owner decision 2, code 2): a saturated or degenerate component reads as a lower limit ("log N > 14.5 sat",
           no errors), and every flag is named right after the value */
        const q = compQuality(c, p.ion, r, d), bd = c.b < 10 ? 1 : 0, tags = q.tags.length ? " " + q.tags.join(" ") : "";
        const bv = `  b ${fmtNum(c.b, bd)}`, vv = `  v ${minus(Math.round(c.v))}`;
        t += q.limit ? `  fit log N > ${fmtNum(q.lo, 1)}${tags}${bv}${vv}`
          : q.loose || !Number.isFinite(c.dlogN) ? `  fit log N ${fmtNum(c.logN, 2)}${tags}${bv}${vv}`
          : `  fit log N ${fmtNum(c.logN, 2)}${pm(c.dlogN, 2)}${tags}${bv}${pm(c.db, c.db < 10 ? 1 : 0)}${vv}${pm(c.dv, c.dv < 10 ? 1 : 0)}`; }
      else if (r && r.status === "no_seeds") t += "  no seeds"; else if (r) t += "  no components"; }
    return t; },
  onReadout(t) { const r = $("#readouts"), s = $("#statusline"); if (t) { r.textContent = t; r.hidden = false; s.hidden = true; } else { r.hidden = true; s.hidden = false; } },
  onView(v, why) {
    if (why === "dragend") { instEmit(); writeHashSoon(); return; }
    /* tune1 F16: pan and zoom keep vc on a 0.1 km/s grid, so getState() and the hash never carry float noise */
    if (v && v.reset) { S.vc = 0; S.vhw = reg.DEF.vhw; } else { S.vc = Math.round(v.vc * 10) / 10; S.vhw = v.vhw; }
    clampView(S, vmax()); inst.syncV(); spectra.schedule(); writeHashSoon(); instEmit(); },
  afterDraw() { if (S.fit) { const sig = JSON.stringify([S.id, S.ions, S.layout, S.R, S.sn, S.seed, COMPRAW.has(S.id), SIGHT.has(S.id)]); if (sig !== fitSig) { fitSig = sig; fitPump(); } } else fitSig = "";
    fitStatus(); spectra.refreshReadout(); ensureSight(); if (!thumbArmed) armThumb(); }
});
const draw = () => spectra.schedule();

/* ---------------- instrument and view controls ---------------- */
const inst = createInstrument({rsliders: $("#rsliders"), sn: [$("#sn-0"), $("#sn-1")], snOut: [$("#sn-0-out"), $("#sn-1-out")], sn1wrap: $("#sn1wrap"),
  vhw: $("#vhw"), vhwOut: $("#vhw-out")}, {get S() { return S; }, reg, vmax, onChange(kind) {
    if (kind === "vhw") { clampView(S, vmax()); $("#vhw-out").textContent = "±" + S.vhw; $("#vhw").setAttribute("aria-valuetext", `±${S.vhw} km/s`); } draw(); writeHashSoon(); instEmit(); }});
instEmit = debounce(() => emit("tng:instrument", {state: getState()}), 100);
$("#vreset").addEventListener("click", () => { S.vc = 0; S.vhw = reg.DEF.vhw; clampView(S, vmax()); inst.syncV(); draw(); writeHashSoon(); instEmit(); });
$("#intr").addEventListener("change", ev => { S.intr = ev.target.checked; draw(); writeHashSoon(); });
$("#fit").addEventListener("change", ev => setFit(ev.target.checked));
function setFit(on) { S.fit = !!on; $("#fit").checked = S.fit; if (S.fit && S.id) ensureComps(S.id).then(() => draw()); draw(); fitStatus(); writeHashSoon(); instEmit(); }
$("#reroll").addEventListener("click", () => { S.seed = (S.seed + 1) % 100000; draw(); writeHashSoon(); });
function syncLayoutUI() { for (const r of $$("input[name=layout]")) r.checked = r.value === S.layout;
  for (const s of $$(".sn1lab")) s.hidden = !(S.layout === "2SN" || S.layout === "4"); }
for (const r of $$("input[name=layout]")) r.addEventListener("change", () => { if (!r.checked) return; S.layout = r.value; syncLayoutUI(); inst.build(); draw(); writeHashSoon(); instEmit(); });

/* ---------------- lines: popover checklist and labelled removable chips ---------------- */
function presentLines() { const e = CAT.get(S.id), s = SIGHT.get(S.id); return s ? Object.keys(s.lines) : Array.isArray(e?.lines) ? e.lines : null; }
function buildIons() {
  const present = presentLines();
  $("#ion-list").innerHTML = reg.IONS.map(i => { const absent = present && !present.includes(i.key);
    return `<label class="ion-row${absent ? " absent" : ""}" style="--ic:${ionColor(i.key)}"${absent ? ' title="not in this sightline"' : ""}><input type="checkbox" data-ion="${i.key}" data-testid="ion-${i.key}"${S.ions.includes(i.key) ? " checked" : ""}>` +
      `<span class="sw"></span><span class="nm">${esc(i.label)}</span><span class="bd">${esc(reg.BANDS[i.band]?.label || i.band)}</span></label>`; }).join("");
  $("#ion-chips").innerHTML = S.ions.map(k => `<button type="button" class="chip" data-ion="${k}" style="--ic:${ionColor(k)}" title="Remove ${esc(ION[k].label)}" aria-label="Remove ${esc(ION[k].label)}"${S.ions.length < 2 ? " disabled" : ""}><span class="sw"></span>${esc(ION[k].label)}<span class="x" aria-hidden="true">×</span></button>`).join("");
  $("#ion-open .n").textContent = S.ions.length;
}
$("#ion-list").addEventListener("change", ev => { const c = ev.target.closest("input[data-ion]"); if (!c) return;
  const on = $$("#ion-list input:checked").map(x => x.dataset.ion); if (!on.length) { c.checked = true; return; } setIons(on); });
$("#ion-chips").addEventListener("click", ev => { const b = ev.target.closest("button[data-ion]"); if (b && S.ions.length > 1) setIons(S.ions.filter(k => k !== b.dataset.ion)); });
$("#ion-all").addEventListener("click", () => setIons(reg.KEYS));
$("#ion-none").addEventListener("click", () => setIons([S.ions[0]]));
$("#ion-default").addEventListener("click", () => setIons(reg.DEF.ions));
function setIons(l) { S.ions = reg.KEYS.filter(k => l.includes(k)); if (!S.ions.length) S.ions = reg.DEF.ions.slice();
  clampView(S, vmax()); buildIons(); inst.build(); draw(); writeHashSoon(); instEmit(); }

/* ---------------- popovers ---------------- */
let hoverT = 0, hoverOpen = null, lastOpener = null;
function place(btn, pop) {
  if (innerWidth < 640) { pop.classList.add("sheet"); pop.style.left = pop.style.top = ""; return; } pop.classList.remove("sheet");
  const r = btn.getBoundingClientRect(), pw = pop.offsetWidth, ph = pop.offsetHeight; let x = r.left, y = r.bottom + 6;
  if (x + pw > innerWidth - 12) x = Math.max(12, r.right - pw); if (y + ph > innerHeight - 12) y = Math.max(12, innerHeight - ph - 12);
  pop.style.left = x + "px"; pop.style.top = y + "px"; }
function openPop(btn, pop, focus = true) {
  closePops(pop); pop.hidden = false; btn.setAttribute("aria-expanded", "true"); lastOpener = btn; place(btn, pop);
  if (pop.id === "gal-pop") gallery.onOpen(); if (pop.id === "find-pop") mountFind(); if (pop.id === "geo-pop") renderBackends();
  if (focus) {
    /* B_fix F2: an info popover takes the focus itself (its links are next in the Tab order), and closes once the focus
       leaves it; the other popovers focus their first control */
    if (INFO_POPS.has(pop.id)) { pop.tabIndex = -1; setTimeout(() => pop.focus({preventScroll: true}), 0); }
    else { const f = pop.querySelector("input[type=search],input:not([type=radio]):not([disabled]),button:not([disabled]),select"); if (f) setTimeout(() => f.focus(), 0); } }
}
const INFO_POPS = new Set(["pop-read", "pop-methods", "pop-licence"]);
for (const id of INFO_POPS) { const pop = document.getElementById(id);
  pop.addEventListener("focusout", ev => { const to = ev.relatedTarget; if (!to || pop.hidden || pop.contains(to) || (lastOpener && lastOpener.contains(to))) return; closePops(); }); }
/* B_fix F9: the Save menu moves with the arrow keys, Home and End */
$("#dl-menu").addEventListener("keydown", ev => { const items = $$("#dl-menu [role=menuitem]").filter(b => !b.disabled); if (!items.length) return;
  const i = items.indexOf(document.activeElement), n = {ArrowDown: i + 1, ArrowUp: i - 1, Home: 0, End: items.length - 1}[ev.key];
  if (n == null) return; ev.preventDefault(); items[(n + items.length) % items.length].focus(); });
function closePops(except) { for (const p of $$(".pop")) if (p !== except && !p.hidden) { p.hidden = true; for (const b of $$(`[aria-controls="${p.id}"]`)) b.setAttribute("aria-expanded", "false"); if (hoverOpen === p) hoverOpen = null; } }
for (const btn of $$("[aria-controls]")) {
  const pop = document.getElementById(btn.getAttribute("aria-controls")); if (!pop || !pop.classList.contains("pop")) continue;
  btn.addEventListener("click", ev => { ev.stopPropagation(); if (pop.hidden || hoverOpen === pop) { hoverOpen = null; openPop(btn, pop); } else closePops(); });
  if (btn.classList.contains("info")) {
    btn.addEventListener("mouseenter", () => { if (!matchMedia("(hover:hover)").matches) return; clearTimeout(hoverT);
      hoverT = setTimeout(() => { if (pop.hidden) { openPop(btn, pop, false); hoverOpen = pop; } }, 300); });
    const leave = () => { clearTimeout(hoverT); if (hoverOpen === pop) hoverT = setTimeout(() => { if (hoverOpen === pop && !pop.matches(":hover") && !btn.matches(":hover")) closePops(); }, 350); };
    btn.addEventListener("mouseleave", leave); pop.addEventListener("mouseleave", leave);
    btn.addEventListener("keydown", ev => { if (ev.key === "Enter" || ev.key === " ") { ev.preventDefault(); btn.click(); } });
  }
}
document.addEventListener("click", ev => { if (!ev.target.closest(".pop") && !ev.target.closest("[aria-controls]")) closePops(); });
document.addEventListener("keydown", ev => { if (ev.key !== "Escape") return; const open = $$(".pop").find(p => !p.hidden);
  if (open) { closePops(); if (lastOpener && document.contains(lastOpener)) lastOpener.focus({preventScroll: true}); }
  else if (document.body.classList.contains("ctl-open")) toggleDrawer(false, true); });
addEventListener("resize", debounce(() => { const p = $$(".pop").find(q => !q.hidden); if (p) { const b = $(`[aria-controls="${p.id}"][aria-expanded="true"]`); if (b) place(b, p); } }, 80));

/* ---------------- select a sightline ---------------- */
let loadTok = 0;
async function select(id, auto = false, source = "gallery") {
  if (!CAT.has(id)) return; if (!auto || id === pendingId) pendingId = null; const changed = S.id !== id; S.id = id; const tok = ++loadTok; SIGHT_FAIL.delete(id);
  if (changed) emit("tng:select", {id, source});
  $("#gal-open .gid").textContent = id; status(); writeHashSoon(); syncGeom(CAT.get(id)); gallery.render();
  if (S.fit) ensureComps(id).then(() => { if (id === S.id) draw(); });
  try { await getSight(id); } catch (x) { if (tok === loadTok) { $("#statusline").innerHTML = `<span class="bad">could not load <b>${esc(id)}</b>: ${esc(x.message)}</span>`; draw(); } return; }
  if (tok !== loadTok) return;
  clampView(S, vmax()); inst.syncV(); buildIons(); draw(); status();
  const list = gallery.visible.length ? gallery.visible : sorted(), i = list.findIndex(e => e.id === id);   // prefetch neighbours
  for (const d of [1, -1]) { const n = list[(i + d + list.length) % list.length]; if (n && n._static) getSight(n.id).catch(() => {}); }
}
function status() {
  const e = CAT.get(S.id), st = $("#statusline"); st.dataset.id = S.id || "";
  if (!e) { st.textContent = S.id ? S.id : "no sightline selected"; return; }
  const geo = kindOf(e) === "custom" ? `custom ray  L ${fb(e.length_kpc)} kpc  b ${fb(e.b_kpc)} kpc` : `${esc(e.orientation)}  b ${fb(e.b_kpc)} kpc  Φ ${fb(e.azimuth_deg)}°`;
  /* tune1 F13: log N moved onto each spectrum row (spectra.js), so the line holds the id and the geometry only */
  st.innerHTML = `<b>${esc(e.id)}</b>  ${geo}${e.source === "generated" ? "  new" : ""}`;
  st.title = st.textContent;
}

/* ---------------- sightline servers ---------------- */
const normUrl = s => String(s || "").trim().replace(/\/+$/, "");
function candidates() { const out = [];
  const q = new URLSearchParams(location.search).get("api"); if (q) out.push(...q.split(","));
  const ls = store.get("tngsight.api"); if (ls) out.push(...ls.split(","));
  const loopPage = /^(localhost|127\.0\.0\.1|\[::1\])$/.test(location.hostname) || location.protocol === "file:";
  out.push(...(CFG.backends || []).filter(u => loopPage || !/^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:|\/|$)/.test(u)));
  return [...new Set(out.map(normUrl).filter(u => /^https?:\/\/[^\s/]+/.test(u)))]; }
/* a build's own server answers CORS only for the origins in its allow-list: from any other origin the probe is an opaque
   no-cors request (reachability only), so the browser logs no CORS error; explicit ?api= and stored URLs get the full probe */
const API_ORIGINS = new Set(CFG.api_origins || ["https://tanmay-starslab.github.io", "http://localhost:8000", "http://127.0.0.1:8000"]);
function corsOk(url) { try { if (new URL(url).origin === location.origin || API_ORIGINS.has(location.origin)) return true; } catch { return false; }
  const ex = [new URLSearchParams(location.search).get("api"), store.get("tngsight.api")].filter(Boolean).flatMap(s => s.split(",")).map(normUrl);
  return ex.includes(normUrl(url)); }
async function probe(url, ms = 8000) { const ac = new AbortController(), t = setTimeout(() => ac.abort(), ms), t0 = performance.now();
  try { if (!corsOk(url)) { await fetch(url + "/api/health", {signal: ac.signal, cache: "no-store", mode: "no-cors"});
      return {url, err: `reachable, but its CORS allow-list does not include ${location.origin}`}; }
    const r = await fetch(url + "/api/health", {signal: ac.signal, cache: "no-store"}); if (!r.ok) throw new Error("HTTP " + r.status);
    const h = await r.json(); if (!h || h.status !== "ok") throw new Error("not ok"); return {url, h, ms: performance.now() - t0};
  } catch (x) { return {url, err: x.name === "AbortError" ? "timeout" : (x.message || "unreachable")}; } finally { clearTimeout(t); } }
let probing = null, probeGen = 0, probedOnce = false, retryN = 0, retryT = null, apiMs = null;
const RETRY_MS = [2000, 5000, 15000];
function discover(ms = 8000, fresh = false) { if (probing && !fresh) return probing; const gen = ++probeGen;
  const run = (async () => {
    const res = await Promise.all(candidates().map(u => probe(u, ms))), ok = res.filter(p => p.h);
    const pick = ok.find(p => p.h.warm) || ok[0] || null, prev = API;
    if (gen !== probeGen && !pick) return;
    PROBES = res; probedOnce = true; API = pick ? pick.url : null; HEALTH = pick ? pick.h : null; apiMs = pick ? pick.ms : null;
    pill(); renderBackends(); setGeoEnabled(); banner();
    if (API !== prev) { NOCOMP.clear(); emit("tng:backend", {api: API, warm: !!(HEALTH && HEALTH.warm)}); }
    clearTimeout(retryT); if (API) retryN = 0; else if (retryN < RETRY_MS.length) retryT = setTimeout(() => discover(), RETRY_MS[retryN++]);
    if (API && API !== prev) await mergeBackendCatalog();
  })().finally(() => { if (probing === run) probing = null; });
  probing = run; return run; }
function backendFailed() { HEALTH = null; setTimeout(discover, 0); }
function pill() { const p = $("#pill");
  if (!API && !probedOnce) { p.dataset.state = "offline"; p.textContent = "probing"; p.title = "looking for a sightline server"; }
  else if (!API) { p.dataset.state = "offline"; p.textContent = "offline"; p.title = PUBLIC ? "no sightline server answered: library sightlines only" : "this build has no public sightline server: library sightlines only"; }
  else { const warm = !!HEALTH.warm; p.dataset.state = warm ? "live" : "warming";
    p.textContent = warm ? `live ${apiMs != null ? (apiMs / 1000).toFixed(1) + " s" : ""}`.trim() : "warming";
    p.title = `${HEALTH.node || new URL(API).host}: queue ${HEALTH.queue?.queued ?? 0} queued, ${HEALTH.queue?.running ?? 0} running`; }
  $("#dlpdf").disabled = !API; }
function renderBackends() { $("#backends").innerHTML = PROBES.length ? PROBES.map(p => `<span>${p.url === API ? "● " : "○ "}${esc(p.url)}  ${p.h ? (p.h.warm ? "warm" : "warming") + (p.h.node ? ", " + esc(p.h.node) : "") : esc(p.err)}</span>`).join("") : "<span>no candidate URLs</span>"; }
async function mergeBackendCatalog() { if (!API) return;
  try { const r = await fetch(API + "/api/catalog"); if (!r.ok) throw new Error(); const c = await r.json();
    for (const e of c.entries || []) upsert(e, false); catalogChanged(); status();
    if (pendingId && CAT.has(pendingId)) select(pendingId, true, "hash"); } catch { backendFailed(); } }
const DEFAULTS = new Set((CFG.backends || []).map(normUrl));
const PUBLIC = [...DEFAULTS].some(u => /^https:\/\//.test(u));
function overrides() { const q = new URLSearchParams(location.search).get("api"), ls = store.get("tngsight.api");
  return [...new Set([q, ls].filter(Boolean).flatMap(s => s.split(",")).map(normUrl).filter(u => /^https?:\/\/[^\s/]+/.test(u) && !DEFAULTS.has(u)))]; }
function banner() { const o = overrides(), b = $("#apibanner"); b.hidden = !o.length; document.body.classList.toggle("has-banner", !!o.length); if (!o.length) return;
  const host = u => { try { return new URL(u).host; } catch { return u; } }, inUse = API && o.includes(API);
  $("#apibanner_t").innerHTML = `${inUse ? "Using" : "Configured to try"} a non-default sightline server: <b>${o.map(u => esc(host(u))).join(", ")}</b>; ` +
    (inUse ? "generated sightlines and their catalogue entries come from it, not from this site" : "it is probed before this site's servers"); }
$("#apireset").addEventListener("click", () => { store.set("tngsight.api", null); const u = new URL(location.href); u.searchParams.delete("api"); location.replace(u.href); });
$("#apisave").addEventListener("click", () => { const u = normUrl($("#apiurl").value); if (u && !/^https?:\/\//.test(u)) { geomsg("Server URL must start with http:// or https://", "bad", "url"); return; }
  store.set("tngsight.api", u || null); banner(); discover(8000, true); });
$("#apiclear").addEventListener("click", () => { $("#apiurl").value = ""; store.set("tngsight.api", null); banner(); discover(8000, true); });
$("#apiurl").value = store.get("tngsight.api") || "";
let idleN = 0;
(function reprobe() { setTimeout(async () => { if (!document.hidden) { await discover(); idleN = API ? 0 : idleN + 1; } reprobe(); },
  API ? 60000 : Math.min(900000, 60000 * 2 ** idleN)); })();

/* ---------------- new sightline: geometry form, submit, job tracking ---------------- */
const orient = () => (document.querySelector('input[name="orient"]:checked') || {}).value;
function seedState() { $("#gseed").disabled = orient() !== "random"; }
for (const r of $$('input[name="orient"]')) r.addEventListener("change", seedState);
let JOB = null, busy = false;
function setGeoEnabled() { $("#submit").disabled = !!JOB || busy; $("#submit").title = API ? `generate on ${API}` : "offline: only library sightlines can be loaded"; }
function syncGeom(e) { if (!e || kindOf(e) === "custom") return; for (const r of $$('input[name="orient"]')) r.checked = r.value === e.orientation;
  $("#gb").value = Math.round(+e.b_kpc); $("#gaz").value = Math.round(+e.azimuth_deg) % 360; if (e.seed != null) $("#gseed").value = e.seed; seedState(); }
class GeomError extends Error { constructor(m, code) { super(m); this.code = code; } }
function readGeom() {
  const o = orient(), b = +$("#gb").value, az = +$("#gaz").value, sd = $("#gseed").value;
  if (!o) throw new GeomError("choose an orientation", "orientation");
  if (!Number.isFinite(b) || b < 0 || b > 300) throw new GeomError("b must be between 0 and 300 kpc", "bound_b");
  if (!Number.isFinite(az) || az < 0 || az >= 360) throw new GeomError("Φ must be between 0 and 359°", "bound_az");
  let seed = null; if (o === "random") { seed = Number(sd); if (sd === "" || !Number.isInteger(seed) || seed < 0 || seed > 4294967295) throw new GeomError("random orientation needs an integer seed (0 to 4294967295)", "seed"); }
  return {orientation: o, b_kpc: b, azimuth_deg: az, seed};
}
function findLocal(g) { const az = ((Math.round(g.azimuth_deg) % 360) + 360) % 360;
  return [...CAT.values()].find(e => e.orientation === g.orientation && Math.round(+e.b_kpc) === Math.round(g.b_kpc) && (Math.round(+e.azimuth_deg) % 360) === az && (g.orientation !== "random" || +e.seed === g.seed)); }
function progress(stage, frac, extra) {
  const P = $("#prog"); P.hidden = stage == null; if (stage == null) return;
  const st = String(stage).startsWith("spectrum") ? "spectra" : stage, i = Math.max(0, STAGES.indexOf(st));
  let f = clamp(+frac || 0, 0, 1);
  if (st === "spectra" && String(stage).includes(":")) { const k = String(stage).split(":")[1], j = reg.KEYS.indexOf(k); if (j >= 0) f = (j + f) / reg.KEYS.length; }
  const pct = Math.round(100 * (i + f) / STAGES.length), sb = $("#stagebar");
  sb.setAttribute("aria-valuenow", pct); sb.setAttribute("aria-valuetext", `${st}, ${pct}%`);
  sb.querySelectorAll("span").forEach((s, j) => { s.className = j < i ? "done" : ""; s.firstChild.style.width = j === i ? (f * 100).toFixed(0) + "%" : ""; });
  $("#stagenames").querySelectorAll("span").forEach((s, j) => { s.className = j === i ? "on" : ""; s.textContent = j === 0 && extra != null ? `queued ${extra}` : STAGES[j]; });
}
async function submitJob(kind, body, fromBridge) {
  if (JOB || busy) { geomsg("Another sightline is being generated.", "bad", "busy"); return {status: "error", message: "another sightline is being generated"}; }
  busy = true; setGeoEnabled();
  try {
    if (!API) { geomsg("Contacting the sightline server", "", "contacting"); await discover(15000, true); }
    if (!API) return {status: "error", offline: true, message: "no sightline server is online"};
    geomsg("Submitting", "", "submitting");
    let r, j;
    try { r = await fetch(API + (kind === "custom" ? "/api/sightlines/custom" : "/api/sightlines"), {method: "POST", headers: {"Content-Type": "application/json"}, body: JSON.stringify(body)});
      j = await r.json().catch(() => ({})); }
    catch { geomsg("Could not reach the sightline server; retrying discovery.", "bad", "unreachable"); backendFailed(); return {status: "error", message: "could not reach the sightline server"}; }
    const d = j.detail, det = typeof d === "string" ? d : Array.isArray(d) ? d.map(x => x.msg).join("; ") : "";
    if (r.status === 429 || r.status === 503) { const ra = +r.headers.get("Retry-After");
      const m = `${r.status === 429 ? "Rate limit reached" : det ? "Server busy: " + det : "Server busy (queue full)"}${ra ? `; try again in ${ra < 120 ? ra + " s" : Math.ceil(ra / 60) + " min"}` : ""}.`;
      geomsg(m, "bad", r.status === 429 ? "rate_limit" : "server_busy"); return {status: "error", message: m}; }
    if (!r.ok) { const m = "Rejected: " + (det || `HTTP ${r.status}`); geomsg(m, "bad", "server_" + r.status); return {status: "error", message: m}; }
    if (j.status === "ready") { upsert(j.entry || {id: j.id}, false); catalogChanged(); geomsg(`Loaded ${j.id} (already computed).`, "good", "ready");
      await select(j.id, false, "job"); if (fromBridge) showTab("spectra"); return {status: "ready", id: j.id}; }
    busy = false; track(j, kind, fromBridge);
    return {status: "queued", id: j.id, job_id: j.job_id, position: j.position ?? null};
  } finally { busy = false; setGeoEnabled(); }
}
$("#geo").addEventListener("submit", async ev => {
  ev.preventDefault(); if (JOB || busy) { geomsg("Another sightline is being generated.", "bad", "busy"); return; }
  let g; try { g = readGeom(); } catch (x) { geomsg(x.message, "bad", x.code || "invalid"); return; }
  const r = await submitJob("geometry", g, false); if (!r.offline) return;
  const e = findLocal(g); if (e) { geomsg(`Loaded ${e.id} from the library (server offline).`, "good", "offline_library"); select(e.id, false, "gallery"); }
  else geomsg(PUBLIC || overrides().length ? "No sightline server is online, and this geometry is not in the library. Pick a library sightline, or try again later."
    : "This build has no public sightline server, and this geometry is not in the library. Pick a library sightline, or run the server locally (deploy/laptop).", "bad", "offline_not_in_library");
});
function track(j, kind = "geometry", fromBridge = false) {
  JOB = {job_id: j.job_id, id: j.id, kind, done: false}; setGeoEnabled(); progress("queued", 0, j.position); geomsg(`Queued ${j.id}${j.position ? " at position " + j.position : ""}.`, "", "queued");
  emit("tng:submitted", {job_id: j.job_id, id: j.id, kind}); emit("tng:job", {job_id: j.job_id, id: j.id, status: "queued", stage: "queued", frac: 0});
  const job = JOB, base = `${API}/api/jobs/${encodeURIComponent(j.job_id)}`, api = API; let es = null, pollT = null, slowT = null;
  const finish = () => { job.done = true; es && es.close(); clearTimeout(pollT); clearInterval(slowT); JOB = null; setGeoEnabled(); };
  let lastStage = null;
  const onProg = d => { const stg = d.stage || "load"; progress(stg, d.frac, null); if (d.msg && stg !== lastStage) geomsg(d.msg, "", "progress"); lastStage = stg;
    emit("tng:job", {job_id: job.job_id, id: job.id, status: "running", stage: stg, frac: +d.frac || 0}); };
  const onDone = async d => { if (job.done) return; finish(); progress("save", 1); const id = d.id || job.id;
    upsert(d.entry || {id}, false); if (d.components) { const raw = normComps(d.components, d.comp_keys || DEF_KEYS, d.components.aod || d.aod); if (raw) COMPRAW.set(id, raw); }
    catalogChanged();
    try { const buf = await fetchBin(`${api}/api/sightline/${id}.bin`); IDB.put(id, {entry: strip(CAT.get(id)), bin: buf}); putSight(id, decodeTNGS(buf, reg.KEYS)); } catch { /* loaded on select */ }
    geomsg(`Generated ${id}.`, "good", "job_done"); note(`generated ${id}`, "good"); setTimeout(() => progress(null), 1500);
    emit("tng:done", {job_id: job.job_id, id, entry: strip(CAT.get(id) || {id})});
    await select(id, false, "job"); if (kind === "custom" || fromBridge) showTab("spectra"); };
  const onErr = m => { if (job.done) return; finish(); progress(null); geomsg("Generation failed: " + (m || "unknown error"), "bad", "job_error");
    emit("tng:error", {job_id: job.job_id, id: job.id, message: m || "unknown error"}); };
  const fromJob = s => { if (s.status === "done") onDone({id: s.id, entry: s.entry, components: s.components}); else if (s.status === "error") onErr(s.error || s.msg);
    else if (s.status === "queued") progress("queued", 0, s.position); else onProg(s); };
  async function poll() { if (job.done) return;
    try { const r = await fetch(base, {cache: "no-store"}); if (r.status === 404) return onErr("job not found on the server"); if (r.ok) fromJob(await r.json()); } catch { /* retry */ }
    if (!job.done) pollT = setTimeout(poll, 2000); }
  const fallback = () => { if (job.done || pollT) return; es && es.close(); es = null; poll(); };
  try { es = new EventSource(base + "/events");
    es.addEventListener("queued", ev => { try { progress("queued", 0, JSON.parse(ev.data).position); } catch { /* ignore */ } });
    es.addEventListener("progress", ev => { try { onProg(JSON.parse(ev.data)); } catch { /* ignore */ } });
    es.addEventListener("done", ev => { try { onDone(JSON.parse(ev.data)); } catch { fallback(); } });
    es.addEventListener("error", ev => { if (ev.data) { try { onErr(JSON.parse(ev.data).message); } catch { onErr(ev.data); } } else fallback(); });
  } catch { fallback(); }
  slowT = setInterval(async () => { if (job.done || pollT) return;
    try { const r = await fetch(base, {cache: "no-store"}); if (r.ok) { const s = await r.json(); if (s.status === "done" || s.status === "error") fromJob(s); } } catch { /* ignore */ } }, 10000);
}

/* ---------------- downloads ---------------- */
function save(blob, name) { const a = document.createElement("a"); a.href = URL.createObjectURL(blob); a.download = name; document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 5000); }
/* C2 (code 3): the server figure gets the page layout ("1", "2R", "2SN" or "4", tngsight.figure.cases_for) and a
   window inside the server's caps. A server that announces them in /api/health ("figure": {layouts, v_max_kms}, the
   damped H I window) renders the page view, its renderer clamping the window to the lines' coverage as the page
   does; an older server gets its fixed 1500 km/s caps and no layout (it rendered the 2x2 grid), so it never 422s */
function figureBody(fmtx) {
  const F = HEALTH && HEALTH.figure, vm = F && +F.v_max_kms > 0 ? +F.v_max_kms : 1500;
  const vhw = clamp(Math.round(S.vhw), 10, vm), vc = clamp(Math.round(S.vc), -vm, vm);
  const b = {id: S.id, ions: S.ions.slice(0, 6), R: Object.fromEntries(bandsOf(reg, S.ions).map(k => [k, S.R[k]])), sn: S.sn,
    vhw, vc, intrinsic: S.intr, seed: S.seed, fmt: fmtx};
  if (F && Array.isArray(F.layouts) && F.layouts.includes(S.layout)) b.layout = S.layout;
  return b;
}
async function download(fmtx) {
  closePops(); if (!S.id) return; const name = `tng50_${S.id}_${S.ions.join("-")}_sn${S.sn.join("-")}`;
  if (API) { note(`rendering the ${fmtx.toUpperCase()} figure`);
    try { const r = await fetch(API + "/api/figure", {method: "POST", headers: {"Content-Type": "application/json"},
        body: JSON.stringify(figureBody(fmtx))});
      if (!r.ok) throw new Error(r.status === 429 ? "rate limit reached" : "HTTP " + r.status);
      save(await r.blob(), `${name}.${fmtx}`); note(`${fmtx.toUpperCase()} figure saved; its noise draw differs from the screen`, "good"); return;
    } catch (x) { note(`server figure failed (${x.message}); saved the screen instead`, "bad"); } }
  else if (fmtx === "pdf") { note("the publication PDF needs the sightline server; saved the screen as PNG", "bad"); }
  $("#cv").toBlob(b => b && save(b, `${name}_screen.png`), "image/png");
}
$("#dlpng").addEventListener("click", () => download("png")); $("#dlpdf").addEventListener("click", () => download("pdf"));

/* ---------------- tabs, 3D view and its live thumbnail ---------------- */
const TABS = ["spectra", "3d"];
function showTab(t, focus) { if (!TABS.includes(t)) return; const prev = S.tab; S.tab = t;
  for (const k of TABS) { const on = k === t, b = $("#tab-" + k); b.setAttribute("aria-selected", String(on)); b.tabIndex = on ? 0 : -1; $("#panel-" + k).hidden = !on; }
  document.body.dataset.tab = t; closePops(); if (focus) $("#tab-" + t).focus();
  writeHashSoon();
  if (t === "3d") open3d().catch(() => {}); else draw();
  if (prev !== t) emit("tng:tab", {tab: t}); }
for (const k of TABS) { const b = $("#tab-" + k); b.addEventListener("click", () => showTab(k));
  b.addEventListener("keydown", ev => { const i = TABS.indexOf(S.tab), n = {ArrowRight: i + 1, ArrowLeft: i - 1, Home: 0, End: TABS.length - 1}[ev.key];
    if (n == null) return; ev.preventDefault(); showTab(TABS[(n + TABS.length) % TABS.length], true); }); }
let V3P = null, V3 = null, THUMB = null;
function vizCfg() {
  if (!CFG.viz) return null;
  const q = new URLSearchParams(location.search).get("viz");
  if (q) { try { const u = new URL(q.replace(/\/?$/, "/"), location.href);
    const ok = u.origin === location.origin || u.origin === "https://huggingface.co" || /^http:\/\/(127\.0\.0\.1|localhost):\d+$/.test(u.origin);
    if (ok) return {...CFG.viz, base: u.href, fallback_base: null, manifest_override: u.href + "manifest_v2.json"}; } catch { /* bad override */ } }
  return {...CFG.viz}; }
/* one viewer3d engine per page: the full square stage (mount) on the 3D tab and the live thumbnail (mountThumb) in the side
   column; viewer3d docks the canvas where it is on screen and builds the grouped controls (#v3-ctl) in #v3d-controls */
const loadV3 = () => Promise.all([import(modUrl("viewer3d.js")), import(modUrl("picker.js"))]);
function open3d() {
  if (V3P) return V3P;
  V3P = (async () => { try { const [V, Pk] = await loadV3();
      const v = await V.mount($("#v3d-root"), window.tngApp, {viz: vizCfg(), controls: $("#v3d-controls")}); V3 = v; window.tngViewer3d = v; $("#v3d-wait").hidden = true;
      $("#v3d-status").textContent = !v.webgl2 ? "The interactive 3D view is not available here; type a ray's endpoints under Pick ray to generate it."
        : matchMedia("(pointer: coarse)").matches && !matchMedia("(any-pointer: fine)").matches ? "drag to orbit, pinch to zoom, tap a line" : "drag to orbit, scroll to zoom, click a line";
      window.tngPicker = Pk.attachPicker(v.webgl2 ? v : null, $("#picker-root"), window.tngApp);
      if (v.webgl2 && thumbOk()) openThumb();     // the engine is up: the thumbnail shares it at no cost, ready for the Spectra tab
      return v;
    } catch (x) { $("#v3d-root").innerHTML = `<p class="msg bad">The 3D view failed to load: ${esc(x.message)}</p>`;
      const w = $("#v3d-wait"); w.textContent = "The 3D view failed to load"; w.classList.add("bad"); V3P = null; throw x; } })();
  return V3P; }
function openThumb() {
  if (THUMB) return THUMB;
  /* the canvas goes into #v3d-mini-host (a positioned square inside the #v3d-mini button); the click and the keys stay on
     #v3d-mini, so no onOpen is passed and the viewer's own nH and 3D tags stay */
  THUMB = (async () => { try { const [V] = await loadV3(); const t = await V.mountThumb($("#v3d-mini-host"), window.tngApp, {viz: vizCfg()});
      window.tngThumb = t; $("#v3d-mini").classList.add("live"); return t; } catch { THUMB = null; return null; } })();
  return THUMB; }
$("#v3d-mini").addEventListener("click", () => showTab("3d"));
$("#v3d-mini").addEventListener("keydown", ev => { if (ev.key === "Enter" || ev.key === " ") { ev.preventDefault(); showTab("3d"); } });
function build3dField() { /* viewer3d draws its own field buttons (in the ion colours) */ }
/* the live thumbnail mounts once the spectra are up and the page has been idle, only where the side column shows it */
let thumbArmed = false;
const thumbOk = () => CFG.viz && !mqMobile.matches && !document.body.classList.contains("side-off") && !(navigator.connection && navigator.connection.saveData);
function armThumb() { thumbArmed = true;
  const go = () => { if (thumbOk()) openThumb(); };
  setTimeout(() => (window.requestIdleCallback ? requestIdleCallback(go, {timeout: 4000}) : go()), 1500); }

/* ---------------- Find, Ask ---------------- */
let FINDP = null;
function mountFind() { if (FINDP) return; FINDP = import(modUrl("search.js")).then(m => m.mountFind($("#find-body"), window.tngApp))
  .catch(x => { FINDP = null; $("#find-body").insertAdjacentHTML("beforeend", `<p class="msg bad">Search failed to load: ${esc(x.message)}</p>`); }); }
let CHAT = null;
$("#chat-open").hidden = !(CFG.chat && CFG.chat.enabled);
$("#chat-open").addEventListener("click", async () => { try { if (!CHAT) { const m = await import(modUrl("chat.js")), root = $("#chat-root"); root.hidden = false;
    CHAT = await m.mount(root, window.tngApp, {opener: $("#chat-open")}); } CHAT.open && CHAT.open(); } catch (x) { CHAT = null; note("the chat could not be loaded: " + x.message, "bad"); } });

/* ---------------- side column (collapsible, remembered) and the phone drawer ---------------- */
function setSide(on) { document.body.classList.toggle("side-off", !on); const b = $("#side-toggle"); b.setAttribute("aria-expanded", String(on));
  const t = on ? "Hide the side column" : "Show the side column"; b.setAttribute("aria-label", t); b.title = t; b.setAttribute("aria-pressed", String(!on));
  store.set("tngsight.side", on ? "1" : "0"); draw(); if (on && thumbArmed) armThumb(); }
$("#side-toggle").addEventListener("click", () => setSide(document.body.classList.contains("side-off")));
/* B_fix F3: opening the drawer moves the focus into it (its Done button); closing it with Esc or Done returns the focus
   to the Controls button */
function toggleDrawer(on, focus = false) { const was = document.body.classList.contains("ctl-open"), o = document.body.classList.toggle("ctl-open", on);
  $("#controls-open").setAttribute("aria-expanded", String(o));
  if (focus && o && !was) setTimeout(() => $("#side-done").focus({preventScroll: true}), 0);
  else if (focus && !o && was) $("#controls-open").focus({preventScroll: true}); }
$("#controls-open").addEventListener("click", ev => { ev.stopPropagation(); toggleDrawer(undefined, true); });
$("#side-done").addEventListener("click", () => { toggleDrawer(false); $("#controls-open").focus({preventScroll: true}); });
const mqMobile = matchMedia("(max-width:820px)");
const HOME = ["#grp-sight", "#grp-lines", "#grp-layout"].map(s => { const el = $(s); return {el, parent: el.parentNode, next: el.nextSibling}; });
const tools = document.createElement("div"); tools.className = "grp"; tools.id = "grp-tools"; tools.innerHTML = '<span class="gl">Tools</span><div class="row"></div>';
const TOOL_HOME = ["#find-toggle", "#chat-open"].map(s => { const el = $(s); return {el, parent: el.parentNode, next: el.nextSibling}; });
function placeControls() {
  if (mqMobile.matches) { const slot = $("#mobslot"); for (const h of HOME) slot.appendChild(h.el); slot.appendChild(tools); for (const h of TOOL_HOME) { h.el.classList.remove("hide-m"); tools.lastChild.appendChild(h.el); } }
  else { for (const h of HOME) h.parent.insertBefore(h.el, h.next); for (const h of TOOL_HOME) h.parent.insertBefore(h.el, h.next); TOOL_HOME[0].el.classList.add("hide-m"); tools.remove(); toggleDrawer(false); }
  draw(); }
mqMobile.addEventListener("change", placeControls);

/* ---------------- keyboard ---------------- */
addEventListener("keydown", ev => { if (ev.target.closest && ev.target.closest("input,select,textarea,[role=tab],#spectra,#v3d-root,.pop,#chat-root")) return;
  if (ev.metaKey || ev.ctrlKey || ev.altKey) return;
  if (ev.key === "j") step(1); else if (ev.key === "k") step(-1); });
$("#prev").addEventListener("click", () => step(-1)); $("#next").addEventListener("click", () => step(1));

/* ---------------- hash ---------------- */
function writeHash() { try { history.replaceState(null, "", "#" + formatHash(S, pendingId)); } catch { /* sandboxed */ } }
const writeHashSoon = debounce(writeHash, 150);
addEventListener("hashchange", () => {
  const prev = S.id, tab = S.tab, N = parseHash(location.hash, reg, S), want = N.id;
  Object.assign(S, N, {id: prev, tab}); clampView(S, vmax()); syncAll();
  if (N.tab !== tab) showTab(N.tab);
  if (want && want !== prev) { if (CAT.has(want)) { select(want, false, "hash"); return; } pendingId = want; writeHash(); }
  draw(); });
function syncAll() { $("#fit").checked = S.fit; $("#intr").checked = S.intr; syncLayoutUI(); buildIons(); inst.build(); }

/* ---------------- window.tngApp v3 bridge (design §6.5) ---------------- */
const fail = message => ({status: "error", message});
function getState() { return {id: S.id, ions: S.ions.slice(), layout: S.layout, R: Object.fromEntries(Object.entries(S.R).map(([b, r]) => [b, r.slice()])), sn: S.sn.slice(),
  vc: S.vc, vhw: S.vhw, seed: S.seed, intrinsic: S.intr, fit: S.fit, tab: S.tab, api: API, warm: !!(HEALTH && HEALTH.warm),
  job: JOB ? {job_id: JOB.job_id, id: JOB.id, kind: JOB.kind} : null}; }
function applyPatch(P) {
  for (const k of ["R", "sn", "layout", "ions", "vhw", "vc"]) if (P[k] !== undefined) S[k] = P[k];
  clampView(S, vmax()); syncAll(); if (P.fit !== undefined) setFit(P.fit); draw(); writeHash(); emit("tng:instrument", {state: getState()}); return getState(); }
window.tngApp = {
  version: 3, config: Object.freeze(JSON.parse(JSON.stringify(CFG))),
  getState, entries: () => sorted().map(strip), entry: id => (CAT.has(id) ? strip(CAT.get(id)) : null),
  async select(id, {source = "chat"} = {}) { if (!CAT.has(id)) return false; if (id !== S.id) await select(id, false, source); return true; },
  setInstrument(o = {}) { return applyPatch(instrumentPatch(o, reg, S, vmaxFor)); },
  setView(o = {}) { const P = instrumentPatch({...(o.vhw !== undefined ? {vhw: o.vhw} : {}), ...(o.vc !== undefined ? {vc: o.vc} : {})}, reg, S, vmaxFor); return applyPatch(P); },
  panels() { const L = spectra.panels(); return L.map(({p, rect, visible}) => { const [R, sn] = caseRS(p.ion, p.ci);
    return {ion: p.ion, case: p.ci, R, snr: sn, seed: panelSeed(p.ion, p.ci), testid: `panel-${p.ion}-${p.ci}`, rect, visible}; }); },
  async fit(ion, caseIndex = 0) {
    if (!ION[ion]) throw new RangeError(`ion: unknown ion ${ion}`); if (!casesFor(S.layout)[caseIndex]) throw new RangeError(`case: must be 0 to ${casesFor(S.layout).length - 1} in layout ${S.layout}`);
    if (!S.id) throw new Error("no sightline selected"); await getSight(S.id); await ensureComps(S.id);
    const key = enqueueFit(ion, caseIndex); if (FIT.res.has(key)) return FIT.res.get(key);
    return new Promise(res => { if (!FIT.wait.has(key)) FIT.wait.set(key, []); FIT.wait.get(key).push(res); }); },
  async submitGeometry(g = {}) {
    const o = {face: "face-on", "face-on": "face-on", edge: "edge-on", "edge-on": "edge-on", rand: "random", random: "random"}[String(g.orientation || "").toLowerCase()];
    const b = Number(g.b_kpc), az = Number(g.azimuth_deg), seed = g.seed == null ? null : Number(g.seed);
    if (!o) return fail("orientation must be face-on, edge-on or random");
    if (!(b >= 0 && b <= 300)) return fail("b_kpc must be between 0 and 300");
    if (!(az >= 0 && az <= 360)) return fail("azimuth_deg must be between 0 and 360");
    if (o === "random" && !(Number.isInteger(seed) && seed >= 0 && seed <= 4294967295)) return fail("random orientation needs an integer seed (0 to 4294967295)");
    const body = {orientation: o, b_kpc: b, azimuth_deg: az % 360, seed: o === "random" ? seed : null}, r = await submitJob("geometry", body, true);
    if (!r.offline) return r; const e = findLocal(body);
    if (e) { await select(e.id, false, "job"); showTab("spectra"); return {status: "ready", id: e.id}; }
    geomsg("No sightline server is online, and this geometry is not in the library.", "bad", "offline_not_in_library");
    return fail("no sightline server is online and this geometry is not in the library"); },
  async submitCustom({p0_kpc, p1_kpc} = {}) { const r = await submitJob("custom", {p0_kpc, p1_kpc}, true);
    return r.offline ? fail("generating a custom ray needs a sightline server (none is online)") : r; },
  components, componentsIndex, showTab: t => showTab(t),
  async show3d({species, preset} = {}) { showTab("3d"); let v; try { v = await open3d(); } catch (x) { return {ok: false, webgl2: false, message: x.message}; }
    if (!v.webgl2) return {ok: false, webgl2: false, species: null, preset: null, message: v.message};
    if (species && !(await v.setSpecies(species))) return {ok: false, webgl2: true, species: v.species, preset: preset || null, mode: v.mode, message: v.loadError && v.loadError.key === species ? `the ${species} volume could not be loaded: ${v.loadError.message}` : v.wanted !== species ? "superseded by a later 3D request" : `the ${species} volume is not available`};
    if (preset && !v.setPreset(preset)) return {ok: false, webgl2: true, species: v.species, preset, mode: v.mode, message: v.presetError || "select a sightline first"};
    return {ok: true, webgl2: true, species: v.species, preset: preset || null, mode: v.mode}; },
  _debug: {figureBody, get dgBytes() { return dgBytes; }, get dgSize() { return DG.size; }, dgMax: DG_MAX_BYTES,
    quality(ion, ci, v) { const r = fitResult(ion, ci), d = S.id && SIGHT.has(S.id) ? dataFor(ion, ci) : null;
      return (r && r.comps || []).filter(c => v == null || Math.abs(c.v - v) < 1e-6).map(c => ({v: c.v, logN: c.logN, flag: c.flag, ...compQuality(c, ion, r, d)})); },
    get drawMs() { return spectra.lastMs; }, get nDraw() { return spectra.nDraw; }, draw: () => spectra.draw(), fitMode: () => FIT.mode, fitCache: () => FIT.res.size}
};

/* ---------------- start ---------------- */
(async function init() {
  if (new URLSearchParams(location.search).has("debug")) document.body.classList.add("debug");   // shows the 3D LOD line (B_fix F8)
  const H = parseHash(location.hash, reg, S); const hashId = H.id; Object.assign(S, H, {id: null, tab: "spectra"});
  if (!reg.IONS.length) $("#statusline").textContent = "this page needs the exporter's configuration (scripts/export_tng50_web.py)";
  setSide(store.get("tngsight.side") !== "0"); placeControls(); seedState(); setGeoEnabled(); pill(); banner(); syncAll();
  /* B_fix R5, C2 code 6: before any sightline is decoded the boot clamp only bounds the hash (integer half-window from
     10 up to the widest line window, the centre kept with it); select() clamps again with the decoded line's own vmax
     once the sightline is in, so a deep-linked damped H I view (vw 6000 vc 2000) survives to the drawn page */
  clampView(S, clamp((+S.vhw || 0) + Math.abs(+S.vc || 0), 1500, 2 * FIG_V_CAP)); inst.syncV();
  const g = CFG.galaxy || {}; if (g.R200c_kpc) $("#about-gal").textContent = `Sightlines through the circumgalactic medium of one ${g.sim || "TNG50-1"} galaxy (subhalo ${g.subhalo_id} at z = ${g.redshift ?? 0}, R200c ${nf.format(Math.round(+g.R200c_kpc))} kpc${g.M200c_Msun ? `, M200c ${(+g.M200c_Msun / 1e12).toFixed(2)}e12 solar masses` : ""}), labelled by orientation, impact parameter b and azimuth from the projected major axis.`;
  if (H.tab === "3d") showTab("3d");
  const disc = discover();
  try { const r = await fetch(CFG.catalog_url); if (!r.ok) throw new Error("HTTP " + r.status); const c = await r.json(); for (const e of c.entries || []) upsert(e, true); }
  catch (x) { $("#galcount").textContent = `catalogue unavailable (${x.message})`; }
  const cached = await IDB.all(); if (Array.isArray(cached)) for (const c of cached) if (c && c.entry && !CAT.has(c.entry.id)) upsert(c.entry, false);
  catalogChanged();
  if (hashId && !CAT.has(hashId)) pendingId = hashId;
  const first = (hashId && CAT.has(hashId)) ? hashId : CAT.has(CFG.defaults.id) ? CFG.defaults.id : sorted()[0]?.id;
  if (first) select(first, true, hashId === first ? "hash" : "init"); else draw();
  emit("tng:ready", {version: 3});
  await disc;
  if (pendingId && CAT.has(pendingId)) select(pendingId, true, "hash");
  else if (!S.id && CAT.size) select(sorted()[0].id, true, "init");
})();
