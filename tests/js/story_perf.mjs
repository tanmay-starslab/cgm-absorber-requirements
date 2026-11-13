// Performance gate of the story v2 (DESIGN_final §4 G5a, G5b; numbers frozen in notes/story2/S0.md). U_qa, §5.10.
//
//   node tests/js/story_perf.mjs                        self-test (perf_*.json, bench_*.json fixtures)
//   node tests/js/story_perf.mjs --fixture F.json       evaluate one recorded run
//   node tests/js/story_perf.mjs --bench F.json         G5b: the owner's laptop `?bench=1` JSON (U_stage's S0 shape or flat
//                                                       {p50, p95, scale}): p50 <= 10 ms, p95 <= 16.7 ms, governor scale >= 0.5
//                                                       ("0.5h" passes, "0.35h" fails; S0 §2)
//   TNG_BROWSER=1 TNG_GPU=1 node tests/js/story_perf.mjs [docs/tng50] [--speed 4] [--out DIR] [--allow-software]
//        [--no-vsync] [--edge BIN] [--width 1440 --height 900] [--query "?x=1"]
//        [--viz DIR|none] [--three FILE|none]: local cubes and three (default: the 488530 cubes, U_stage's three);
//        the run waits for a bound cube level and fails G5a if the volume never becomes resident
//   TNG_BROWSER=1 node tests/js/story_perf.mjs --mock   browser self-test of the collection path on the mock page (CPU)
//
// G5a (A100 proxy, 1440x900, flight quality; S0 §1 and §3):
//   frame p95 <= 7 ms (uncapped rAF interval), volume (far + near GPU timers) p50 <= 2.5 and p95 <= 3.5 ms, GPU frame (sum
//   of the stage's pass timers) p95 <= 3.3 ms (`G5a_gpu_frame_p95_ms`), all x `G5a_scale`; no long task > 50 ms
//   (`G5a_longtask_ms`) across boot and every field load, counted at the cadence S0 names (`G5a_longtask_cadence: vsync`).
// So the browser part runs two passes over the same sweep:
//   1. uncapped (--disable-gpu-vsync --disable-frame-rate-limit): frame intervals, volume and GPU timers. Its long tasks are
//      recorded as notes only (S0 §3: ANGLE's texture-update stalls when ~2000 frames/s starve its deferred cleanup);
//   2. vsync (GPU flags only, as a real browser runs): a fresh page load, the same sweep, long tasks judged (boot included,
//      PerformanceObserver buffered). --no-vsync skips it (then G5a fails on the cadence rule).
// Run it inside a GPU job (scripts/story_qa.sbatch QA_SET=gpu): a software renderer (SwiftShader, llvmpipe) fails G5a unless
// --allow-software (numbers become notes).
//
// Where the timers come from (first that exists): __story.perf() -> {volMs, gpuFrameMs}; __story.quality() object with
// volMs / gpuFrameMs; else the stage's own EXT_disjoint_timer_query arrays, `(__story.stage || __story.perf().stage).stats.gpuMs`
// = {far: [...], near: [...], splats: [...]} (stage.js), drained every 120 frames: volume = far + near, GPU frame = sum of
// every timed pass of that frame index (stage.js times far, near and splats; compose/bloom/final are untimed there, about
// 0.2 ms on the A100 per S0 §1, so this sum slightly under-reads the S0 "whole frame" GPU number).
import {existsSync, readFileSync, mkdirSync} from "node:fs";
import {join, resolve, relative} from "node:path";
import {parseArgs, checker, launch, BLOCK, sleep} from "./lib/browser.mjs";
import {REPO, STORY_REL, evalPerf, evalBench, selfTest, report, writeResult, plainEdge, edgeWith, gzServe, setViewport, detect,
  GPU_FLAGS, UNTHROTTLE_FLAGS, quantile, readS0, g5aFromS0, FIX_DIR, storyAssets, assetQuery, waitResident, RESIDENT} from "./lib/storyqa.mjs";

const {pos, opt} = parseArgs(process.argv.slice(2));
const C = checker();
const S0 = readS0(), G = g5aFromS0(S0);
if (opt.scale) G.scale = +opt.scale;

if (opt.fixture) { const fx = JSON.parse(readFileSync(resolve(opt.fixture), "utf8")); if (report(C, evalPerf(fx, G))) C.check(true, `${fx.name || "run"}: G5a passes`); process.exit(C.finish()); }
if (opt.bench) { const j = JSON.parse(readFileSync(resolve(opt.bench), "utf8")); if (report(C, evalBench(j))) C.check(true, "G5b passes"); process.exit(C.finish()); }

/* self-tests judge the fixtures with the frozen S0 rules */
selfTest(C, "perf", fx => evalPerf(fx, G));
selfTest(C, "bench", fx => evalBench(fx));
C.check(!!S0 && S0.G5a_longtask_cadence !== undefined && S0.G5a_gpu_frame_p95_ms !== undefined, `S0 freeze read (${S0 ? S0.file : "missing"})`);
C.note(`G5a: scale ${G.scale}, frame p95 <= ${G.p95Max}, volume p50 <= ${G.volP50} / p95 <= ${G.volP95}, GPU frame p95 <= ${G.gpuFrameP95} ms, long tasks <= ${G.longMax} ms at ${G.cadence} cadence`);
if (!process.env.TNG_BROWSER) { C.note("browser part skipped (set TNG_BROWSER=1; run on a GPU node)"); process.exit(C.finish()); }

const MOCK = !!opt.mock;
const DIR = MOCK ? FIX_DIR : resolve(pos[0] || join(REPO, "docs/tng50")), PAGE = MOCK ? join(FIX_DIR, "mock_story.html") : join(DIR, STORY_REL, "index.html"), OUT = opt.out ? resolve(opt.out) : null;
if (!existsSync(PAGE)) { C.check(process.env.STORY_REQUIRE !== "1", `no story page at ${relative(REPO, PAGE)}`); process.exit(C.finish()); }
if (OUT) mkdirSync(OUT, {recursive: true});
const OBS = `(() => { const Q = window.__qaPerf = {long: [], fieldMs: [], t0: performance.now()};
  try { new PerformanceObserver(l => { for (const e of l.getEntries()) Q.long.push({d: e.duration, t: e.startTime}); }).observe({type: "longtask", buffered: true}); } catch (e) { Q.noLong = String(e); }
  try { new PerformanceObserver(l => { for (const e of l.getEntries()) if (/field/i.test(e.name)) Q.fieldMs.push({n: e.name, d: e.duration}); }).observe({type: "measure", buffered: true}); } catch (e) {} })();`;
const RENDERER = `(() => { const c = document.createElement("canvas"), g = c.getContext("webgl2"); if (!g) return {webgl2: false, renderer: "none"};
  const d = g.getExtension("WEBGL_debug_renderer_info"); return {webgl2: true, renderer: d ? g.getParameter(d.UNMASKED_RENDERER_WEBGL) : g.getParameter(g.RENDERER),
    timer: !!g.getExtension("EXT_disjoint_timer_query_webgl2")}; })()`;
/* the sweep: p 0 -> 1 at speed x the Space-hold rate (0.012/s); per frame the rAF interval and the exposed timers; the
   stage's GPU pass arrays are drained every 120 frames (they keep only the last 600) */
const SWEEP = speed => `(async () => { const S = __story, fr = [], vol = [], gpu = [], passes = {};
  const st = () => (S.stage && S.stage.stats) || (typeof S.perf === "function" && S.perf() && S.perf().stage && S.perf().stage.stats) || null;
  const drain = () => { const s = st(); if (!s || !s.gpuMs) return; for (const [k, a] of Object.entries(s.gpuMs)) (passes[k] ||= []).push(...a.splice(0)); };
  S.setTarget(0); await new Promise(r => setTimeout(r, 1200)); drain(); for (const k in passes) passes[k] = [];
  let p = 0, last = performance.now(), n = 0;
  await new Promise(done => { const tick = now => { const dt = (now - last) / 1000; fr.push(now - last); last = now;
      const q = typeof S.quality === "function" ? S.quality() : null, pf = typeof S.perf === "function" ? S.perf() : null;
      const v = (q && typeof q === "object" && q.volMs) ?? (pf && pf.volMs), g = (q && typeof q === "object" && q.gpuFrameMs) ?? (pf && pf.gpuFrameMs);
      if (typeof v === "number") vol.push(v); if (typeof g === "number") gpu.push(g);
      if (++n % 120 === 0) drain();
      p = Math.min(1, p + 0.012 * ${speed} * dt); S.setTarget(p); if (p >= 1) done(); else requestAnimationFrame(tick); };
    requestAnimationFrame(tick); });
  await new Promise(r => setTimeout(r, 300)); drain();
  const fromStage = !vol.length && passes.far && passes.far.length;
  if (fromStage) { const m = Math.min(...Object.values(passes).map(a => a.length));
    for (let i = 0; i < m; i++) { vol.push(passes.far[i] + (passes.near ? passes.near[i] : 0)); gpu.push(Object.values(passes).reduce((a, x) => a + x[i], 0)); } }
  const passP95 = Object.fromEntries(Object.entries(passes).map(([k, a]) => [k, a.length ? a.slice().sort((x, y) => x - y)[Math.floor(0.95 * (a.length - 1))] : null]));
  return {fr: fr.slice(5), vol, gpu, src: fromStage ? "stage.stats.gpuMs" : vol.length ? "__story" : "none", passP95,
          q: typeof S.quality === "function" ? S.quality() : null, end: S.state().p}; })()`;

const gpu = !!process.env.TNG_GPU || !!opt.gpu, W = +(opt.width || 1440), H = +(opt.height || 900), speed = +(opt.speed || 4);
const AS = MOCK ? {viz: null, three: null} : storyAssets(opt);   // local cubes + three (see storyqa.storyAssets): no empty-sky runs
const srv = await gzServe(DIR, AS), AQ = assetQuery(srv, AS);
let URL0 = MOCK ? srv.base + "mock_story.html" : srv.base + STORY_REL + "/index.html" + ((AQ || opt.query) ? "?" + [AQ, (opt.query || "").replace(/^[?&]/, "")].filter(Boolean).join("&") : "");
if (!MOCK) C.note(`assets: cubes ${AS.viz || "page default (hosted, blocked here)"}; three ${AS.three || "page default (CDN)"}`);
const run = {name: `perf ${W}x${H}`, frames: [], volMs: [], gpuFrameMs: [], longTasks: [], longTaskCadence: "uncapped", fieldMs: []};

/** One pass: fresh browser, load, wait for the story, sweep. */
async function pass(label, flags) {
  const edge = opt.edge || edgeWith(plainEdge(), flags);
  const P = await launch({edge, block: BLOCK, inject: [OBS], reducedMotion: false, width: W, height: H});
  try {
    await P.send("Emulation.setEmulatedMedia", {features: [{name: "prefers-reduced-motion", value: "no-preference"}]});
    await setViewport(P, {w: W, h: H, zoom: 1, mobile: false});
    await P.goto(URL0);
    const kind = await detect(P, 120000);
    if (!C.check(!!kind, `${label}: story ready (${kind || "none"})`)) return null;
    const R = await P.eval(RENDERER);
    const res0 = kind === "v2" ? await waitResident(P, MOCK ? 3000 : 120000) : null;   // measure the volume with data in it
    if (res0 && res0.stage) C.note(`${label}: residency before the sweep: ${res0.loads} cube load(s), ${res0.levels} level(s) bound`);
    await sleep(1500);
    let sw;
    if (kind === "v2") sw = await P.eval(SWEEP(speed), 900000);
    else {
      await P.eval(`(document.querySelector('[data-testid="story-play"], #play') || {click() {}}).click()`);
      const secs = +(opt.seconds || 20);
      sw = {fr: await P.eval(`new Promise(res => { const fr = []; let last = performance.now(); const end = last + ${secs * 1000};
        const tick = now => { fr.push(now - last); last = now; if (now < end) requestAnimationFrame(tick); else res(fr.slice(5)); }; requestAnimationFrame(tick); })`, (secs + 30) * 1000),
        vol: [], gpu: [], src: "v1"};
    }
    const q = await P.eval("window.__qaPerf");
    if (q.noLong) C.note(`${label}: longtask observer unavailable: ${q.noLong}`);
    const resident = kind === "v2" ? await P.eval(RESIDENT) : null;
    return {kind, R, sw, long: q.long.map(x => x.d), fieldMs: q.fieldMs, exceptions: P.exceptions.slice(0, 3), browser: P.browser, resident};
  } finally { await P.close(); }
}

/* --mock: browser self-test of this script's own collection path on tests/js/fixtures/story_qa/mock_story.html (CPU is
   fine): the clean page must pass the timer, cadence and long-task rules, ?defect=1 (5 ms far volume, a 120 ms boot task)
   must fail them. Frame times and the software renderer are not judged here (CPU headless). */
if (MOCK) {
  try {
    for (const [q, clean] of [["", true], ["?defect=1", false]]) {
      URL0 = srv.base + "mock_story.html" + q;
      const A = await pass(`mock${q} uncapped`, UNTHROTTLE_FLAGS), B = A && await pass(`mock${q} vsync`, []);
      if (!A || !B) continue;
      const res = evalPerf({name: `mock${q}`, frames: A.sw.fr, volMs: A.sw.vol, gpuFrameMs: A.sw.gpu, longTasksUncapped: A.long, longTasks: B.long, longTaskCadence: "vsync",
        requireVol: true, requireGpu: true, software: false, requireResident: true, resident: A.resident}, G);
      const judged = res.fails.filter(x => !/^[^:]*: frame p95/.test(x.msg));   // the uncapped CPU frame time is not judged here
      C.note(`mock${q}: timers from ${A.sw.src}, ${A.sw.vol.length} volume / ${A.sw.gpu.length} GPU samples, vsync long tasks ${B.long.map(d => d.toFixed(0)).join(", ") || "none"}`);
      if (clean) C.check(A.sw.src === "stage.stats.gpuMs" && A.sw.vol.length > 30 && !judged.length, `browser self-test: mock page passes the G5a timer and long-task rules${judged.length ? " (got " + judged.map(x => x.msg).join("; ") + ")" : ""}`);
      else { const has = re => judged.some(x => re.test(x.msg));
        C.check(has(/volume p50/) && has(/GPU frame p95/) && has(/long task/) && has(/never resident/), `browser self-test: mock ?defect=1 fails volume, GPU frame, long-task and residency rules (got ${judged.map(x => x.msg.replace(/^[^:]*: /, "")).join("; ") || "nothing"})`); }
    }
  } catch (e) { C.check(false, `perf mock run: ${e.message}`); }
  finally { await srv.close(); }
  process.exit(C.finish());
}

try {
  const A = await pass("uncapped", [...(gpu ? GPU_FLAGS : []), ...UNTHROTTLE_FLAGS]);
  if (A) {
    run.renderer = A.R.renderer; run.timerExt = A.R.timer;
    run.software = /swiftshader|llvmpipe|softpipe|software/i.test(A.R.renderer || "") || !A.R.webgl2;
    C.note(`renderer: ${A.R.renderer}${run.software ? " (software)" : ""}; timer query ${A.R.timer ? "yes" : "no"}; page ${A.kind}; browser ${A.browser}`);
    run.frames = A.sw.fr; run.volMs = A.sw.vol; run.gpuFrameMs = A.sw.gpu; run.timerSource = A.sw.src; run.passP95 = A.sw.passP95; run.quality = A.sw.q;
    run.longTasksUncapped = A.long; run.fieldMs = A.fieldMs;
    run.requireVol = run.requireGpu = run.requireResident = A.kind === "v2" && !run.software; if (A.resident && A.resident.stage) run.resident = A.resident;
    if (A.kind !== "v2") C.note("v1 baseline: 2D canvas stepper in Play (no volume pass); G5a is defined for the v2 3D stage");
    C.note(`uncapped: frames ${run.frames.length}, p50 ${quantile(run.frames, 0.5).toFixed(2)} ms, p95 ${quantile(run.frames, 0.95).toFixed(2)} ms; timers from ${run.timerSource}` +
      (run.passP95 && Object.keys(run.passP95).length ? `; pass p95 ${Object.entries(run.passP95).map(([k, v]) => `${k} ${v == null ? "-" : v.toFixed(2)}`).join(", ")}` : ""));
    if (run.fieldMs.length) C.note(`field measures: ${run.fieldMs.length}, max ${Math.max(...run.fieldMs.map(x => x.d)).toFixed(1)} ms`);
    if (A.exceptions.length) C.note(`page exceptions: ${A.exceptions.join(" | ")}`);
    if (!opt["no-vsync"] && G.cadence === "vsync") {
      const B = await pass("vsync", gpu ? GPU_FLAGS : []);
      if (B) { run.longTasks = B.long; run.longTaskCadence = "vsync"; run.vsyncFrames = {n: B.sw.fr.length, p50: quantile(B.sw.fr, 0.5), p95: quantile(B.sw.fr, 0.95)};
        C.note(`vsync: frames ${B.sw.fr.length}, p50 ${run.vsyncFrames.p50.toFixed(2)} ms, p95 ${run.vsyncFrames.p95.toFixed(2)} ms; long tasks ${B.long.length}${B.long.length ? " (max " + Math.max(...B.long).toFixed(0) + " ms)" : ""}`); }
    } else run.longTasks = A.long;
    const lenient = run.software && opt["allow-software"];
    const res = evalPerf(lenient ? {...run, software: false, requireVol: false, requireGpu: false, requireResident: false} : run, G);
    if (lenient) { C.note("--allow-software: numbers below are notes, G5a not judged"); for (const n of res.notes) C.note(n); for (const x of res.fails) C.note(`(software, not judged) ${x.gate} ${x.msg}`); }
    else if (report(C, res)) C.check(true, `G5a passes on ${run.renderer}`);
  }
} catch (e) { C.check(false, `perf run: ${e.message}`); }
finally { await srv.close(); }
const f = writeResult(OUT, "perf.json", run); if (f) C.note(`results ${relative(REPO, f) || f}`);
process.exit(C.finish());
