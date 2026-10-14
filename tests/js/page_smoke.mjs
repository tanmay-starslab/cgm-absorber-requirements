// Smoke test of the TNG50 page logic in node, with a minimal DOM/canvas stub (no browser needed).
// Usage: node --experimental-eventsource tests/js/page_smoke.mjs <exported docs/tng50 dir> [backend URL]
//   Static data (catalog.json, data/s/*.bin) is read from the directory; with a backend URL (e.g. a server
//   started with TNG_GENERATOR=server.testing:FakeGenerator) it also exercises health probing, the catalogue
//   merge, POST /api/sightlines + SSE/polling job tracking and the figure download.
//   Phase 2 (design-2 §7.9): tab/panel/mount ids, the window.tngApp bridge, no Phase-2 asset on initial load, the
//   tng:select round trip, and (with a backend) a custom ray via tngApp.submitCustom: stages incl. "fit" -> done ->
//   selected + Spectra tab. A backend without /api/sightlines/custom (pre-U_ray) is reported, not failed.
import {readFileSync, existsSync} from "node:fs";
import {join} from "node:path";

const [dir, api] = process.argv.slice(2);
if (!dir) { console.error("usage: page_smoke.mjs <docs/tng50 dir> [backend URL]"); process.exit(2); }
const html = readFileSync(join(dir, existsSync(join(dir, "index.html")) ? "index.html" : "_template.html"), "utf8");
const scripts = [...html.matchAll(/<script([^>]*)>([\s\S]*?)<\/script>/g)].filter(m => !/type="importmap"/.test(m[1])).map(m => m[2]);
const ids = new Set([...html.matchAll(/\sid="([^"]+)"/g)].map(m => m[1]));
const PAGE = "http://127.0.0.1:8000/tng50/";
let fails = 0; const check = (ok, msg) => { console.log(`${ok ? "ok  " : "FAIL"} ${msg}`); if (!ok) fails++; };
const sleep = ms => new Promise(r => setTimeout(r, ms));

// ---- DOM stub ----
const ctxCalls = {stroke: 0, fill: 0, text: []};
const ctx = new Proxy({}, {get: (t, k) => k === "measureText" ? s => ({width: 7 * String(s).length}) :
  k === "fillText" ? s => ctxCalls.text.push(s) : k === "stroke" ? () => ctxCalls.stroke++ : k === "fill" ? () => ctxCalls.fill++ :
  k in t ? t[k] : () => {}, set: (t, k, v) => (t[k] = v, true)});
class El {
  constructor(tag = "div", id = "") { Object.assign(this, {tagName: tag.toUpperCase(), id, children: [], attrs: {}, style: {}, dataset: {}, handlers: {},
    _text: "", innerHTML: "", value: "", checked: false, disabled: false, hidden: false, className: "", title: "", clientWidth: 1000, width: 0, height: 0}); }
  addEventListener(t, f) { (this.handlers[t] ||= []).push(f); }
  set onclick(f) { this.addEventListener("click", f); }
  fire(t, extra = {}) { for (const f of this.handlers[t] || []) f({target: this, preventDefault() {}, ...extra}); }
  appendChild(c) { this.children.push(c); return c; } remove() {}
  get options() { return this.children; } get firstChild() { return this._fc ||= new El("i"); }
  getAttribute(k) { return this.attrs[k] ?? null; } setAttribute(k, v) { this.attrs[k] = String(v); }
  querySelectorAll(s) { return (this._qsa ||= {})[s] ||= Array.from({length: 5}, () => new El("span")); }
  closest() { return null; } getContext() { return ctx; } getBoundingClientRect() { return {left: 0, top: 0}; } click() {} focus() {}
  insertAdjacentHTML(w, h) { this.innerHTML += h; }
  toBlob(cb) { cb({size: 1}); }
  get textContent() { return this._text; } set textContent(v) { this._text = String(v); if (v === "") this.children = []; }
}
const els = {};
const elById = id => els[id] ||= Object.assign(new El(id === "cv" ? "canvas" : "div", id), id === "cv" ? {attrs: {height: "560"}} : {});
const radios = ["face-on", "edge-on", "random"].map(v => Object.assign(new El("input"), {value: v, checked: v === "edge-on", name: "orient"}));
globalThis.document = {
  querySelector(s) { if (s === 'input[name="orient"]:checked') return radios.find(r => r.checked) || null;
    if (!s.startsWith("#")) throw new Error("selector " + s); const id = s.slice(1); if (!ids.has(id)) throw new Error("no element #" + id); return elById(id); },
  querySelectorAll(s) { if (s === 'input[name="orient"]') return radios; throw new Error("selectorAll " + s); },
  createElement: t => new El(t), body: new El("body"), documentElement: Object.assign(new El("html"), {dataset: {}})};
globalThis.getComputedStyle = () => ({getPropertyValue: () => "#123456"});
globalThis.MutationObserver = class { observe() {} };
globalThis.matchMedia = () => ({matches: false, addEventListener() {}});
globalThis.requestAnimationFrame = cb => setTimeout(cb, 0);
const winH = {}; globalThis.addEventListener = (t, f) => { (winH[t] ||= []).push(f); };
globalThis.removeEventListener = (t, f) => { winH[t] = (winH[t] || []).filter(g => g !== f); };
const events = []; globalThis.dispatchEvent = ev => { events.push({type: ev.type, detail: ev.detail}); for (const f of winH[ev.type] || []) f(ev); return true; };
const PENDING = "rand_b199_a359_s1";   // a deep link to an id no catalogue has: must survive in the URL (offline run)
globalThis.location = new URL(PAGE + (api ? "?api=" + encodeURIComponent(api) : "#id=" + PENDING));
globalThis.history = {replaceState: (a, b, h) => { globalThis.location.hash = h; }};
const LS = new Map(); globalThis.localStorage = {getItem: k => LS.get(k) ?? null, setItem: (k, v) => LS.set(k, v), removeItem: k => LS.delete(k)};
globalThis.devicePixelRatio = 1; globalThis.window = globalThis;
globalThis.URL.createObjectURL = () => "blob:x"; globalThis.URL.revokeObjectURL = () => {};
const realFetch = fetch, seen = [];
globalThis.fetch = async (u, o) => { const url = new URL(u, PAGE).href; seen.push((o?.method || "GET") + " " + url);
  if (url.startsWith(PAGE)) { const p = join(dir, url.slice(PAGE.length).split("?")[0]);
    if (!existsSync(p)) return new Response("not found", {status: 404}); return new Response(readFileSync(p)); }
  if (!api) throw new TypeError("fetch failed (no backend)"); return realFetch(url, o); };
if (api && typeof EventSource === "undefined") console.log("note: run with --experimental-eventsource to test SSE (falls back to polling)");

// ---- run ----
for (const s of scripts) (0, eval)(s.replace(/^\s*const (DATA|CFG|TNG|S)\b/gm, "var $1"));
const st = () => elById("statusline").innerHTML;
await sleep(3500);
const opts = elById("gallery").children.map(o => o.value);
check(opts.length >= 3, `gallery lists ${opts.length} sightlines: ${opts.slice(0, 5).join(", ")}${opts.length > 5 ? ", …" : ""}`);
check(/\| log N/.test(st()) && /<b>[a-z]/.test(st()), "status line shows the selected sightline: " + st().replace(/<[^>]+>/g, "").slice(0, 120));
check(ctxCalls.stroke > 50, `canvas drew ${ctxCalls.stroke} strokes; titles: ${[...new Set(ctxCalls.text.filter(t => t.startsWith("R =")))].join(" / ")}`);
check(/id=\w+/.test(location.hash), "hash state " + location.hash);
if (!api) check(location.hash.includes("id=" + PENDING) && S.id !== PENDING, "unknown deep-linked id kept in the URL while the default is shown: " + location.hash);
const ticks = ctxCalls.text.filter(s => /^[−-]?\d+$/.test(String(s)) && Math.abs(parseInt(String(s).replace("−", "-"))) >= 100);
check(!ticks.some(s => s.startsWith("-")) && ticks.filter(s => s === "−400").length === ticks.filter(s => s === "400").length && ticks.includes("−400"),
  `x ticks use U+2212 and print ±vwin only at the outer edges (${[...new Set(ticks)].join(" ")})`);
const ban = elById("apibanner");
check(api && !(CFG.backends || []).map(u => u.replace(/\/+$/, "")).includes(api.replace(/\/+$/, "")) ? !ban.hidden && elById("apibanner_t").innerHTML.includes(new URL(api).host) : ban.hidden,
  `override banner ${ban.hidden ? "hidden" : "shown: " + elById("apibanner_t").innerHTML.replace(/<[^>]+>/g, "")}`);
// ---- phase 2: structure, bridge, lazy loading ----
const P2_IDS = ["tabs", "tab-spectra", "tab-3d", "panel-spectra", "panel-3d", "v3d-root", "picker-root", "find-root", "find-toggle", "find-body", "chat-root", "chat-open", "comps"];
check(P2_IDS.every(i => ids.has(i)), "tablist / panels / mount ids present: " + P2_IDS.filter(i => !ids.has(i)).map(i => "missing #" + i).join(" "));
check(/role="tablist" id="tabs"/.test(html) && /role="tab" id="tab-3d" aria-controls="panel-3d"/.test(html) && /role="tabpanel" id="panel-3d"/.test(html), "WAI-ARIA tab roles + aria-controls");
check(/<script type="importmap">\{"imports":\{"three":"https:\/\/cdn\.jsdelivr\.net\/npm\/three@0\.169\.0\/build\/three\.module\.min\.js"/.test(html) &&
  html.indexOf("importmap") < html.indexOf("<script id=\"tngsight-degrade\""), "three@0.169.0 importmap in <head> before any other script");
{ const im = JSON.parse(html.match(/<script type="importmap">([\s\S]*?)<\/script>/)[1]), I = im.integrity || {}, cdn = "https://cdn.jsdelivr.net/npm/three@0.169.0/";
  check(/^sha384-/.test(I[im.imports.three] || "") && /^sha384-/.test(I[im.imports["three/addons/"] + "controls/OrbitControls.js"] || "") &&
    Object.keys(I).every(u => u.startsWith(cdn)), "importmap integrity (SRI) for three.module.min.js and OrbitControls.js"); }
const app = globalThis.tngApp, API_FNS = ["getState", "entries", "entry", "select", "setInstrument", "submitGeometry", "submitCustom", "components", "componentsIndex", "showTab", "show3d"];
check(app && app.version === 2 && API_FNS.every(f => typeof app[f] === "function") && Object.isFrozen(app.config), "window.tngApp v2 bridge: " + API_FNS.filter(f => typeof app?.[f] !== "function").join(" "));
check(events.some(e => e.type === "tng:ready" && e.detail.version === 2) && events.some(e => e.type === "tng:catalog" && e.detail.n >= 3), "tng:ready and tng:catalog dispatched");
const p2 = seen.filter(u => /\/data\/vol\/|components\.json|cdn\.jsdelivr|\/api\/components|\/js\/(viewer3d|picker|search|chat)/.test(u));
check(p2.length === 0, `initial load fetched no Phase-2 asset (${seen.length} requests${p2.length ? "; offending: " + p2.join(", ") : ""})`);
const ents = app.entries(), withP = ents.filter(e => Array.isArray(e.p0) && Array.isArray(e.p1)).length;
console.log(`     entries ${ents.length}, with p0/p1 ${withP}, has_components ${ents.filter(e => e.has_components).length}`);
{ const st0 = app.getState(), e0 = app.entry(st0.id); check(e0 && e0.id === st0.id && app.entry("cust_0000000000") === null && st0.tab === "spectra", `getState/entry: ${st0.id}, tab ${st0.tab}`); }
{ const ids3 = elById("gallery").children.map(o => o.value), cur = app.getState().id, other = ids3.find(i => i !== cur);
  let n0 = events.length; elById("gallery").value = other; elById("gallery").fire("change"); await sleep(200);
  const ev1 = events.slice(n0).filter(e => e.type === "tng:select");
  check(ev1.length === 1 && ev1[0].detail.id === other && ev1[0].detail.source === "gallery", `gallery change → tng:select {${other}, gallery}`);
  n0 = events.length; const ok = await app.select(cur, {source: "3d"}); await sleep(200);
  const ev2 = events.slice(n0).filter(e => e.type === "tng:select");
  check(ok && ev2.length === 1 && ev2[0].detail.source === "3d" && elById("gallery").value === cur && S.id === cur, `app.select(${cur}, {source: "3d"}) → event + gallery value`);
  n0 = events.length; const again = await app.select(cur, {source: "3d"});
  check(again === true && !events.slice(n0).some(e => e.type === "tng:select"), "select(current id) is a no-op (loop guard)");
  check(await app.select("cust_ffffffffff") === false, "select(unknown id) → false");
  let thrown = null; try { app.setInstrument({R_lo: 12345}); } catch (x) { thrown = x; }
  const s2 = app.setInstrument({sn_hi: 12, vwin: 300});
  check(thrown instanceof RangeError && s2.sn_hi === 12 && s2.vwin === 300 && location.hash.includes("v=300") && events.some(e => e.type === "tng:instrument"), "setInstrument validates (RangeError) and applies + tng:instrument");
  app.setInstrument({sn_hi: 8, vwin: 400}); }
const s0 = ctxCalls.stroke; elById("vwin").value = "200"; elById("vwin").fire("input"); await sleep(50);
check(ctxCalls.stroke > s0 && location.hash.includes("v=200"), "velocity window slider redraws and updates hash");
const before = S.id, want = opts[(opts.indexOf(before) + 1) % opts.length]; elById("next").fire("click"); await sleep(400);
check(S.id === want && st().includes(`<b>${want}</b>`), `next ▶ moves selection ${before} → ${S.id} (wraps)`);
elById("filter").value = "rand"; elById("filter").fire("input");
check(elById("gallery").children.every(o => o.value.includes("rand")), `text filter 'rand' leaves ${elById("gallery").children.length}`);
elById("filter").value = ""; elById("filter").fire("input");
const other = opts.find(i => i !== S.id && /^face/.test(i)); location.hash = "#id=" + other; for (const f of winH.hashchange || []) f(); await sleep(400);
check(S.id === other, `hashchange in an open tab selects ${other}: ${S.id}`);
const pill = elById("pill").textContent;
if (!api) {
  check(/offline/.test(pill), "pill offline: " + pill);
  radios.forEach(r => r.checked = r.value === "face-on"); elById("gb").value = "50"; elById("gaz").value = "90";
  elById("geo").fire("submit"); await sleep(300);
  check(/library/.test(elById("geomsg").textContent) || /not in the library/.test(elById("geomsg").textContent), "offline submit: " + elById("geomsg").textContent);
} else {
  check(/^live · /.test(pill), "pill live: " + pill);
  radios.forEach(r => r.checked = r.value === "random"); elById("gseed").value = String(1000 + Math.floor(Math.random() * 1e6));
  elById("gb").value = "77"; elById("gaz").value = "123"; elById("geo").fire("submit");
  let msg = ""; for (let i = 0; i < 600; i++) { await sleep(500); msg = elById("geomsg").textContent; if (/Generated|failed|Rejected|Loaded/.test(msg)) break; }
  check(/Generated rand_b077_a123_s\d+/.test(msg), "submit → job → done: " + msg);
  await sleep(500);
  check(/rand_b077_a123/.test(st()) && /generated on demand/.test(st()), "generated sightline selected: " + st().replace(/<[^>]+>/g, "").slice(0, 90));
  check(seen.some(u => /\/api\/sightline\/rand_b077_a123_s\d+\.bin/.test(u)), "fetched generated .bin from the backend");
  elById("geo").fire("submit"); for (let i = 0; i < 20; i++) { await sleep(300); if (/Loaded/.test(elById("geomsg").textContent)) break; }
  check(/already computed/.test(elById("geomsg").textContent), "resubmit same geometry → ready: " + elById("geomsg").textContent);
  elById("gb").value = "999"; elById("geo").fire("submit"); await sleep(100);
  check(/between 0 and 300/.test(elById("geomsg").textContent), "client-side bound on b: " + elById("geomsg").textContent);
  elById("dlpng").fire("click"); for (let i = 0; i < 40; i++) { await sleep(500); if (/rendered|failed/.test(elById("geomsg").textContent)) break; }
  console.log("     figure: " + elById("geomsg").textContent);
  check(seen.some(u => u.startsWith("POST") && u.endsWith("/api/figure")), "figure download POSTs /api/figure");
  // ---- phase 2: custom ray through the bridge ----
  const probeCustom = await realFetch(api.replace(/\/+$/, "") + "/api/geometry/custom", {method: "POST", headers: {"Content-Type": "application/json"}, body: '{"p0_kpc":[-100,0,0],"p1_kpc":[100,0,0]}'}).catch(() => null);
  if (!probeCustom || probeCustom.status === 404 || probeCustom.status === 405) console.log("note: backend has no custom-ray API yet; custom submit not tested");
  else {
    const j0 = await probeCustom.json(); check(j0.id === "cust_35277e0469", "POST /api/geometry/custom golden id: " + j0.id);
    app.showTab("3d"); await sleep(100);
    const r6 = () => Math.round(Math.random() * 1000) / 10, p0 = [-150 - r6(), 20 + r6(), -10], p1 = [140 + r6(), -30, 25 - r6()];
    const n0 = events.length, res = await app.submitCustom({p0_kpc: p0, p1_kpc: p1});
    check(res.status === "queued" && /^cust_[0-9a-f]{10}$/.test(res.id) && res.job_id, "submitCustom → queued " + JSON.stringify(res));
    if (res.status !== "queued") { console.log(/Rate limit/.test(res.message || "") ? "note: the backend's rate limit (12/h, burst 4) is exhausted; restart it to rerun" : "note: custom flow skipped");
      console.log(`\n${fails} check(s) FAILED`); process.exit(1); }
    const second = await app.submitCustom({p0_kpc: p0, p1_kpc: [0, 0, 0]});
    check(second.status === "error" && /another sightline/.test(second.message), "second submit while busy → error: " + second.message);
    let done = null; for (let i = 0; i < 600 && !done; i++) { await sleep(500); done = events.slice(n0).find(e => e.type === "tng:done" || e.type === "tng:error"); }
    const stages = [...new Set(events.slice(n0).filter(e => e.type === "tng:job").map(e => e.detail.stage))];
    check(events.slice(n0).some(e => e.type === "tng:submitted" && e.detail.kind === "custom"), "tng:submitted kind custom");
    check(done && done.type === "tng:done" && done.detail.id === res.id, `custom job done: ${done ? done.type + " " + JSON.stringify(done.detail).slice(0, 160) : "timeout"}`);
    check(stages.includes("fit"), "progress stages incl. fit: " + stages.join(" → "));
    await sleep(600); const sel = events.slice(n0).filter(e => e.type === "tng:select").pop();
    check(S.id === res.id && sel && sel.detail.source === "job" && app.getState().tab === "spectra", `custom ray selected (source job) and Spectra tab shown: id ${S.id}, tab ${app.getState().tab}`);
    const ce = app.entry(res.id);
    check(ce && ce.orientation === "custom" && Array.isArray(ce.p0) && /^◆ new b=\S+ θ=\d+° L=\d+ /.test(elById("gallery").children.find(o => o.value === res.id)?.textContent || ""), "custom entry: orientation custom, p0/p1, ◆ gallery label: " + (elById("gallery").children.find(o => o.value === res.id)?.textContent));
    const again = await app.submitCustom({p0_kpc: p0, p1_kpc: p1});
    check(again.status === "ready" && again.id === res.id, "resubmit same endpoints → ready");
    const bad = await app.submitCustom({p0_kpc: [500, 0, 0], p1_kpc: [0, 0, 0]});
    check(bad.status === "error" && /395/.test(bad.message), "out-of-range endpoint → server 422 message: " + bad.message);
  }
}
console.log(fails ? `\n${fails} check(s) FAILED` : "\nall checks passed");
process.exit(fails ? 1 : 0);
