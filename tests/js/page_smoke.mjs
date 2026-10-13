// Smoke test of the TNG50 page logic in node, with a minimal DOM/canvas stub (no browser needed).
// Usage: node --experimental-eventsource tests/js/page_smoke.mjs <exported docs/tng50 dir> [backend URL]
//   Static data (catalog.json, data/s/*.bin) is read from the directory; with a backend URL (e.g. a server
//   started with TNG_GENERATOR=server.testing:FakeGenerator) it also exercises health probing, the catalogue
//   merge, POST /api/sightlines + SSE/polling job tracking and the figure download.
import {readFileSync, existsSync} from "node:fs";
import {join} from "node:path";

const [dir, api] = process.argv.slice(2);
if (!dir) { console.error("usage: page_smoke.mjs <docs/tng50 dir> [backend URL]"); process.exit(2); }
const html = readFileSync(join(dir, existsSync(join(dir, "index.html")) ? "index.html" : "_template.html"), "utf8");
const scripts = [...html.matchAll(/<script([^>]*)>([\s\S]*?)<\/script>/g)].map(m => m[2]);
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
  closest() { return null; } getContext() { return ctx; } getBoundingClientRect() { return {left: 0, top: 0}; } click() {}
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
check(opts.length >= 3, `gallery lists ${opts.length} sightlines: ${opts.join(", ")}`);
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
}
console.log(fails ? `\n${fails} check(s) FAILED` : "\nall checks passed");
process.exit(fails ? 1 : 0);
