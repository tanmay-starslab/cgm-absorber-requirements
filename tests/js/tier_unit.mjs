// Device tier gate (perf R5): the inline head script of docs/tng50/_template.html (#tier-gate) run in a fake window.
// decide() is pure: low / mid / high from the cheap signals and the WebGL probe; then the gate itself: html[data-tier],
// the ?tier= override, the stored probe result and a context loss this session. The exported index.html carries the same script.
// Usage: node tests/js/tier_unit.mjs
import {readFileSync} from "node:fs";
import {join} from "node:path";
import vm from "node:vm";
import {ROOT, checker} from "./lib/browser.mjs";
import {probe} from "../../docs/tng50/js/tier.js";
import * as GLC from "../../docs/tng50/learn/how-a-spectrum-is-made/js/stage/glcheck.js";

const C = checker(), check = C.check;
const html = f => readFileSync(join(ROOT, "docs/tng50", f), "utf8");
const gateOf = s => (s.match(/<script id="tier-gate">([\s\S]*?)<\/script>/) || [])[1];
const SRC = gateOf(html("_template.html"));
check(!!SRC, "the template has the #tier-gate head script");
check(gateOf(html("index.html")) === SRC, "index.html carries the template's tier gate");
const head = html("_template.html").split("</head>")[0];
check(head.includes('id="tier-gate"') && head.indexOf('id="tier-gate"') > head.indexOf('<script type="importmap">') && head.indexOf('id="tier-gate"') < head.indexOf('rel="modulepreload"'),
  "the gate runs in <head> (before first paint), after the import map and before the module preloads");

function run({search = "", nav = {}, store = {}, mq = {}} = {}) {
  const data = new Map(Object.entries(store)), el = {dataset: {}};
  const w = {navigator: nav, location: {search}, URLSearchParams, JSON,
    sessionStorage: {getItem: k => (data.has(k) ? data.get(k) : null), setItem: (k, v) => data.set(k, String(v))},
    matchMedia: q => ({matches: !!mq[q]}), document: {documentElement: el}};
  w.window = w;
  vm.runInNewContext(SRC, w);
  return {T: w.tngTier, tier: el.dataset.tier, data};
}

/* decide(): pure */
const {T} = run(), D = s => T.decide(s);
const GOOD = {renderer: "ANGLE (NVIDIA, NVIDIA GeForce RTX 3060 Direct3D11)", stills: false};
check(D({mem: 8, cores: 8, gl: GOOD}) === "high", "8 GB, 8 cores, a discrete GPU: high");
check(D({mem: 8, cores: 8}) === "mid", "GPU not probed yet: mid (unknown is never low)");
check(D({}) === "mid", "nothing known: mid");
check(D({cores: 8, gl: GOOD}) === "high", "no deviceMemory (Firefox, Safari) with a good GPU: high");
for (const [s, want, why] of [
  [{mem: 8, cores: 8, gl: {renderer: "ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device (Subzero)), SwiftShader driver)", stills: true}}, "low", "software GL (the probe says stills)"],
  [{mem: 2, cores: 8, gl: GOOD}, "low", "deviceMemory 2"], [{mem: 8, cores: 2, gl: GOOD}, "low", "2 cores"],
  [{mem: 8, cores: 8, gl: GOOD, saveData: true}, "low", "Save-Data"], [{mem: 8, cores: 8, gl: GOOD, net: "3g"}, "low", "a 3g connection"],
  [{mem: 8, cores: 8, gl: GOOD, net: "slow-2g"}, "low", "a slow-2g connection"], [{mem: 8, cores: 8, gl: GOOD, lost: true}, "low", "a context loss this session"],
  [{mem: 4, cores: 8, gl: GOOD}, "mid", "deviceMemory 4"], [{mem: 8, cores: 4, gl: GOOD}, "mid", "4 cores"],
  [{mem: 8, cores: 8, gl: GOOD, mobile: true}, "mid", "a phone, tablet or touch-only device"],
  [{mem: 8, cores: 8, gl: {renderer: "Mali-G78", stills: false}}, "mid", "a weak GPU (Mali)"],
  [{mem: 8, cores: 8, gl: {renderer: "ANGLE (Intel, Intel(R) UHD Graphics 620 Direct3D11)", stills: false}}, "mid", "a weak GPU (Intel UHD)"],
  [{mem: 8, cores: 8, gl: {renderer: "ANGLE (Intel, Intel(R) Iris(R) Xe Graphics Direct3D11)", stills: false}}, "high", "Intel Iris Xe is not weak"],
  [{mem: 8, cores: 8, gl: GOOD, net: "4g"}, "high", "a 4g connection"]])
  check(D(s) === want, `${why}: ${want} (got ${D(s)})`);

/* the gate in a page */
const desk = {deviceMemory: 8, hardwareConcurrency: 8, userAgent: "Mozilla/5.0 (X11; Linux x86_64) Chrome/156", connection: {effectiveType: "4g"}};
let r = run({nav: desk});
check(r.tier === "mid" && !r.T.forced && r.T.gl === null, `a desktop before the probe: html[data-tier=mid] (got ${r.tier})`);
check(r.T.probed(GOOD) === "high" && r.data.get("tng50.tier") === JSON.stringify(GOOD), "probed(good GPU) -> high, stored in sessionStorage");
r = run({nav: desk, store: {"tng50.tier": JSON.stringify(GOOD)}});
check(r.tier === "high" && !!r.T.gl, "a stored probe is reused on the next page of the session: high at once");
r = run({nav: desk, store: {"tng50.tier": JSON.stringify(GOOD), "tng50.gpuLite": "1"}});
check(r.tier === "low", "a context loss earlier in the session (tng50.gpuLite) wins over the stored probe: low");
r = run({nav: desk, search: "?tier=high&gpu=lite", store: {"tng50.gpuLite": "1"}});
check(r.tier === "high" && r.T.forced, "?tier=high overrides everything (and ?gpu= is left to the 3D view)");
r = run({nav: desk, search: "?tier=bogus"});
check(r.tier === "mid" && !r.T.forced, "an invalid ?tier= is ignored");
r = run({nav: {...desk, userAgent: "Mozilla/5.0 (Linux; Android 14; Pixel 8) Mobile"}, store: {"tng50.tier": JSON.stringify(GOOD)}});
check(r.tier === "mid", "an Android phone with a good GPU: mid");
r = run({nav: {hardwareConcurrency: 8}, mq: {"(pointer: coarse)": true}, store: {"tng50.tier": JSON.stringify(GOOD)}});
check(r.tier === "mid", "a touch-only device: mid");
r = run({nav: {...desk, connection: {effectiveType: "4g", saveData: true}}});
check(r.tier === "low", "Save-Data before any probe: low");
r = run({nav: {}, store: {"tng50.tier": "{not json"}});
check(r.tier === "mid" && r.T.gl === null, "a corrupt stored probe is ignored: mid");

/* probe(): the WebGL check of js/tier.js with a fake context; the micro-benchmark runs only on hardware without a caveat */
function fakeDoc({renderer, caveat = false, none = false, benchMs = 5}) {
  let benched = 0;
  const gl = {getExtension: n => (n === "WEBGL_debug_renderer_info" ? {UNMASKED_RENDERER_WEBGL: 1} : n === "WEBGL_lose_context" ? {loseContext() {}} : null), getParameter: () => renderer, RENDERER: 2};
  return {doc: {createElement: () => ({getContext: (k, o) => (none ? null : caveat && o.failIfMajorPerformanceCaveat ? null : gl)})},
    glc: {...GLC, microBench: () => { benched++; return benchMs; }}, benched: () => benched};
}
for (const [o, stills, bench, why] of [
  [{renderer: "ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device (Subzero)), SwiftShader driver)"}, true, 0, "SwiftShader: stills, no benchmark"],
  [{renderer: "llvmpipe (LLVM 15.0.7, 256 bits)"}, true, 0, "llvmpipe: stills, no benchmark"],
  [{renderer: "ANGLE (NVIDIA GeForce RTX 3060)", caveat: true}, true, 0, "a major performance caveat: stills, no benchmark"],
  [{renderer: "", none: true}, true, 0, "no WebGL2: stills"],
  [{renderer: "ANGLE (NVIDIA GeForce RTX 3060)"}, false, 1, "a hardware GPU: benchmarked, 3D"],
  [{renderer: "ANGLE (NVIDIA GeForce RTX 3060)", benchMs: 90}, true, 1, "a hardware GPU over the benchmark limit: stills"]]) {
  const f = fakeDoc(o), r = probe(f.glc, f.doc);
  check(r.stills === stills && f.benched() === bench, `probe: ${why} (stills ${r.stills}, ${f.benched()} benchmark runs; ${r.why})`);
}

process.exit(C.finish());
