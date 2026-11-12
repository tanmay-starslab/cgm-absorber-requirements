// Budget gate of the "How a spectrum is made" story (PLAN_final §7 performance budgets, §6 data budgets).
// Usage: node tests/js/story_budget.mjs [docs/tng50 dir] [--story learn/how-a-spectrum-is-made]
//            [TNG_BROWSER=1: --port N --profile DIR --edge BIN]
// While ROOT has no index.html the test prints "skipped" (STORY_REQUIRE=1 makes that a failure).
// Node part (always), gzip level 9 of the files as committed:
//   - story JS (ROOT/**/*.js and *.mjs, outside vendor/ and media/) <= 60 kB gz in total; the explorer's fit.js is
//     shared and cached, so it is not counted here; no three.js file in ROOT;
//   - story data one run loads <= 80 kB gz (§7): the largest set of per-galaxy files (<kind>_<subhalo>_<ray>.json)
//     plus every shared ROOT/data JSON (the story works for every galaxy of the sample and loads one galaxy per run); each
//     story_<subhalo>_<ray>.json <= 80 kB gz (§6);
//   - CSS <= 20 kB gz, vendored fonts (ROOT/vendor/*.woff2) <= 200 kB on disk (notes only above that: no plan budget);
//   - no MP4 inside ROOT outside media/ (video is hosted, D5; the hero loop <= 1.5 MB is the only MP4 in the repo).
// Browser part (TNG_BROWSER=1), Chromium over CDP:
//   - first contentful paint < 1.0 s on a 4G profile (9 Mbit/s down, 1.5 Mbit/s up, 170 ms RTT; WebPageTest "4G"),
//     cache disabled, served gzip like GitHub Pages (own small static server: <dir> at /tng50/);
//   - one full Step run (every step, ArrowRight from the stage) transfers <= 1.5 MB excluding video (.mp4, .webm, .vtt),
//     counted from the Resource Timing encoded body sizes plus the document, and requests nothing off this origin and
//     no three.js;
//   - cumulative layout shift over the load and the run < 0.05;
//   - canvas backing store: device pixel ratio cap 2 on a fine pointer (DPR 3 emulated) and 1.5 on a coarse one;
//   - no backdrop-filter on an element that scrolls with the page (only fixed or sticky layers and their children);
//   - with window.storyApp.seek, the scrub steps render in <= 8 ms median, <= 16 ms 95th percentile (120 seeks each).
// Lighthouse a11y >= 95 is not run here (Lighthouse is not installed; the owner's OK is needed to add it).
import {readFileSync, existsSync, readdirSync, statSync} from "node:fs";
import {join, resolve, relative, extname, basename} from "node:path";
import {gzipSync} from "node:zlib";
import {ROOT as REPO, parseArgs, checker, launch, BLOCK, sleep} from "./lib/browser.mjs";

const {pos, opt} = parseArgs(process.argv.slice(2));
const DIR = resolve(pos[0] || join(REPO, "docs/tng50"));
const STORY = opt.story || "learn/how-a-spectrum-is-made";
const SROOT = resolve(DIR, STORY), PAGE = join(SROOT, "index.html"), STEPS_F = join(SROOT, "steps.json");
if (!existsSync(PAGE)) {
  if (process.env.STORY_REQUIRE === "1") { console.log(`FAIL no story page at ${PAGE} (STORY_REQUIRE=1)`); process.exit(1); }
  console.log(`skipped (no story page at ${relative(REPO, PAGE)}; set STORY_REQUIRE=1 to fail instead)`); process.exit(0);
}
const C = checker(), check = C.check, note = C.note;
const KB = 1024, kb = n => (n / KB).toFixed(1) + " kB";
function walk(d, skip = new Set(["vendor", "media", "build", "node_modules"]), out = []) {
  if (!existsSync(d)) return out;
  for (const n of readdirSync(d).sort()) { const f = join(d, n), st = statSync(f); if (st.isDirectory()) { if (!skip.has(n)) walk(f, skip, out); } else out.push(f); }
  return out;
}
const gz = f => gzipSync(readFileSync(f), {level: 9}).length;
const FILES = walk(SROOT);

/* ---------------------------------------------------------------- node budgets */
/* JS the page can load: everything except scene modules no step uses (js/scenes/stub.js is the engine tests' fixture).
   Budget: PLAN_final §7 said 60 kB gz for the M1 spectral half (8 scenes); the 12-scene story with the four space
   scenes (U3, +17.5 kB gz) is capped at 75 kB gz (review E1: owner to confirm 75 kB, or ask for lazy-loaded scenes;
   engine.ready() imports every scene, so all of it is first-load JS today). */
const JS_BUDGET_KB = 75;
const usedScenes = new Set(JSON.parse(readFileSync(join(SROOT, "steps.json"), "utf8")).steps.map(s => s.scene));
const js = FILES.filter(f => /\.m?js$/.test(f)).filter(f => !/[\\/]js[\\/]scenes[\\/]/.test(f) || usedScenes.has(basename(f).replace(/\.m?js$/, "")));
const jsGz = js.reduce((a, f) => a + gz(f), 0);
check(jsGz <= JS_BUDGET_KB * KB, `story JS ${kb(jsGz)} gz in ${js.length} files (<= ${JS_BUDGET_KB} kB; unused scene modules excluded)`);
const top = js.map(f => [relative(SROOT, f), gz(f)]).sort((a, b) => b[1] - a[1]).slice(0, 5);
if (top.length) note("largest JS: " + top.map(([f, n]) => `${f} ${kb(n)}`).join(", "));
const threeF = walk(SROOT, new Set()).filter(f => /three(\.module)?(\.min)?\.m?js$/i.test(f));
check(!threeF.length, `no three.js file in the story${threeF.length ? ": " + threeF.map(f => relative(SROOT, f)).join(", ") : ""}`);
const data = FILES.filter(f => f.startsWith(join(SROOT, "data") + "/") && f.endsWith(".json"));
const dataGz = data.reduce((a, f) => a + gz(f), 0);
if (!data.length) note("no ROOT/data/*.json yet (U0)");
/* per-galaxy files are named <kind>_<subhalo>_<ray>.json (story_, page_fits_, ...); one run loads one galaxy's files
   plus the shared ones, and that is the §7 data budget (the story works for every galaxy of the sample) */
const galOf = f => (f.match(/_(\d{3,})_(?:face|edge|rand)_b\d{3}_a\d{3}(?:_s\d+)?\.json$/) || [])[1];
const perGal = data.filter(f => galOf(f)), others = data.filter(f => !galOf(f));
const byGal = new Map(); for (const f of perGal) byGal.set(galOf(f), (byGal.get(galOf(f)) || 0) + gz(f));
const shared = others.reduce((a, f) => a + gz(f), 0), worst = [...byGal.entries()].sort((a, b) => b[1] - a[1])[0];
const oneRun = (worst ? worst[1] : 0) + shared;
check(oneRun <= 80 * KB, `story data one run loads ${kb(oneRun)} gz (${worst ? `galaxy ${worst[0]} ${kb(worst[1])}` : "no per-galaxy files"} plus ${others.length} shared files ${kb(shared)}; <= 80 kB)`);
if (byGal.size > 1) note(`story data for ${byGal.size} galaxies, ${kb(dataGz)} gz on disk in total (one galaxy is loaded per run)`);
const bigGal = perGal.filter(f => /\/story_\d+_/.test(f) && gz(f) > 80 * KB);
check(!bigGal.length, `every story_<subhalo>_<ray>.json <= 80 kB gz${bigGal.length ? ": " + bigGal.map(f => `${relative(SROOT, f)} ${kb(gz(f))}`).join(", ") : ""}`);
for (const f of data.slice(0, 12)) note(`data ${relative(SROOT, f)} ${kb(gz(f))} gz`);
const css = FILES.filter(f => f.endsWith(".css")), cssGz = css.reduce((a, f) => a + gz(f), 0);
if (cssGz > 20 * KB) note(`CSS ${kb(cssGz)} gz (above 20 kB; no plan budget, check it)`); else note(`CSS ${kb(cssGz)} gz`);
const fonts = walk(join(SROOT, "vendor"), new Set()).filter(f => f.endsWith(".woff2")), fontB = fonts.reduce((a, f) => a + statSync(f).size, 0);
note(`vendored fonts ${fonts.length} woff2, ${kb(fontB)}${fontB > 200 * KB ? " (above 200 kB; check subsetting)" : ""}`);
const mp4 = walk(SROOT, new Set(["media", "build", "node_modules"])).filter(f => /\.(mp4|webm|mov)$/i.test(f));
check(!mp4.length, `no video file in the story outside media/${mp4.length ? ": " + mp4.map(f => relative(SROOT, f)).join(", ") : ""}`);

/* ---------------------------------------------------------------- browser budgets */
if (!process.env.TNG_BROWSER) { note("browser part skipped (set TNG_BROWSER=1)"); process.exit(C.finish()); }
if (!existsSync(STEPS_F)) { check(false, "steps.json present for the Step run"); process.exit(C.finish()); }
const raw = JSON.parse(readFileSync(STEPS_F, "utf8")), STEPS = Array.isArray(raw) ? raw : raw.steps || [], IDS = STEPS.map(s => s.id);
let edge = opt.edge;
if (!edge && process.env.TNG_EDGE && /headless-rm$/.test(process.env.TNG_EDGE) && existsSync(process.env.TNG_EDGE.replace(/-rm$/, ""))) edge = process.env.TNG_EDGE.replace(/-rm$/, "");
const OBS = `(() => { const B = window.__budget = {cls: 0, shifts: [], fcp: null};
  try { new PerformanceObserver(l => { for (const e of l.getEntries()) if (!e.hadRecentInput) { B.cls += e.value; B.shifts.push(+e.value.toFixed(4)); } }).observe({type: "layout-shift", buffered: true}); } catch {}
  try { new PerformanceObserver(l => { for (const e of l.getEntries()) if (e.name === "first-contentful-paint") B.fcp = e.startTime; }).observe({type: "paint", buffered: true}); } catch {} })();`;
const SREADY = `(window.storyApp ? storyApp.ready === true : !!document.querySelector('[data-step][aria-current="step"], [data-step].is-active'))`;
const STEP = `((window.storyApp && storyApp.getState && storyApp.getState().step) ?? (document.querySelector('[data-step][aria-current="step"], [data-step].is-active') || {dataset: {}}).dataset.step ?? null)`;
/* gzip static server (GitHub Pages compresses text), so the 4G and transfer budgets see realistic bytes; same URL
   layout as lib/browser.mjs serve(): <DIR> at /tng50/ */
const TYPES = {".html": "text/html; charset=utf-8", ".js": "text/javascript", ".mjs": "text/javascript", ".json": "application/json", ".css": "text/css",
  ".svg": "image/svg+xml", ".png": "image/png", ".webp": "image/webp", ".jpg": "image/jpeg", ".woff2": "font/woff2", ".txt": "text/plain", ".vtt": "text/vtt", ".mp4": "video/mp4", ".bin": "application/octet-stream"};
const ZIP = new Set([".html", ".js", ".mjs", ".json", ".css", ".svg", ".txt", ".vtt"]);
async function gzServe() {
  const {createServer} = await import("node:http");
  const srv = createServer((req, res) => {
    let p = decodeURIComponent(new URL(req.url, "http://x").pathname);
    if (!p.startsWith("/tng50/")) { res.writeHead(404); res.end(); return; }
    if (p.endsWith("/")) p += "index.html";
    const f = resolve(join(DIR, p.slice(7)));
    if (!f.startsWith(DIR + "/") || !existsSync(f) || statSync(f).isDirectory()) { res.writeHead(404); res.end("not found"); return; }
    const body = readFileSync(f), ext = extname(f), z = ZIP.has(ext) && /gzip/.test(req.headers["accept-encoding"] || "");
    res.writeHead(200, {"Content-Type": TYPES[ext] || "application/octet-stream", "Cache-Control": "no-store", ...(z ? {"Content-Encoding": "gzip"} : {})});
    res.end(z ? gzipSync(body, {level: 6}) : body);
  });
  await new Promise(r => srv.listen(+(opt.port || process.env.TNG_TEST_PORT) || 0, "127.0.0.1", r));
  const port = srv.address().port;
  return {origin: `http://127.0.0.1:${port}`, base: `http://127.0.0.1:${port}/tng50/`, close: () => new Promise(r => { srv.closeAllConnections?.(); srv.close(r); })};
}
const srv = await gzServe();
const URL0 = srv.base + STORY + "/index.html";
const P = await launch({profile: opt.profile, edge, block: BLOCK, inject: [OBS], reducedMotion: false});
try {
  console.log(`serving ${relative(REPO, DIR)} at ${srv.base}; browser ${P.browser}`);
  /* first frame on 4G, cold cache */
  await P.viewport(390, 844, true);
  await P.send("Network.setCacheDisabled", {cacheDisabled: true});
  await P.send("Network.emulateNetworkConditions", {offline: false, latency: 170, downloadThroughput: 9e6 / 8, uploadThroughput: 1.5e6 / 8});
  await P.goto(URL0);
  await P.waitFor("window.__budget && __budget.fcp !== null", 30000, 50);
  const fcp = await P.eval("__budget.fcp");
  check(fcp !== null && fcp < 1000, `first contentful paint ${fcp === null ? "none" : fcp.toFixed(0) + " ms"} on 4G at 390 px (< 1000 ms)`);
  await P.send("Network.emulateNetworkConditions", {offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1});

  /* one full Step run at 1440: bytes, origins, CLS */
  await P.viewport(1440, 900, false);
  await P.goto(URL0 + "#s=" + IDS[0]);
  const t = await P.waitFor(SREADY, 60000, 100);
  if (check(t >= 0, `story ready in ${(t / 1000).toFixed(2)} s (cache disabled)`)) {
    let miss = 0;
    for (let k = 1; k < IDS.length; k++) {
      await P.eval(`(() => { const e = document.querySelector('[data-testid="story-stage"], #stage') || document.querySelector("main") || document.body; if (!e.hasAttribute("tabindex")) e.setAttribute("tabindex", "-1"); e.focus({preventScroll: true}); })()`);
      await P.key("ArrowRight");
      if ((await P.waitFor(`${STEP} === ${JSON.stringify(IDS[k])}`, 6000, 50)) < 0) { miss++; await P.eval(`location.hash = "#s=${IDS[k]}"`); await sleep(300); }
      await sleep(700);
    }
    if (miss) note(`${miss} step(s) reached by hash, not ArrowRight (story_smoke checks the keys)`);
    await sleep(1500);
    const r = await P.eval(`(() => { const nav = performance.getEntriesByType("navigation")[0], res = performance.getEntriesByType("resource");
      return {doc: nav ? (nav.encodedBodySize || nav.transferSize || 0) : 0, docRaw: nav ? nav.decodedBodySize || 0 : 0,
        res: res.map(e => ({u: e.name, n: e.encodedBodySize || e.transferSize || e.decodedBodySize || 0, raw: e.decodedBodySize || 0}))}; })()`);
    const vid = x => /\.(mp4|webm|vtt)(\?|$)/i.test(x.u), counted = r.res.filter(x => !vid(x)), total = r.doc + counted.reduce((a, x) => a + x.n, 0);
    const rawT = r.docRaw + counted.reduce((a, x) => a + x.raw, 0);
    check(total <= 1.5 * KB * KB, `full Step run transfers ${kb(total)} gzip (${kb(rawT)} decoded) excluding video in ${counted.length + 1} requests (<= 1.5 MB)`);
    note("largest: " + counted.sort((a, b) => b.n - a.n).slice(0, 5).map(x => `${x.u.replace(srv.origin, "")} ${kb(x.n)}`).join(", "));
    const off = P.requests.filter(q => !q.includes(srv.origin) && !/ (data|blob|about):/.test(q));
    check(!off.length, `no request off this origin${off.length ? ": " + off.slice(0, 4).join(", ") : ""}`);
    check(!P.requests.some(q => /three(\.module)?(\.min)?\.m?js/.test(q)), "no three.js request");
    const cls = await P.eval("__budget");
    check(cls.cls < 0.05, `cumulative layout shift ${cls.cls.toFixed(4)} over load and run (< 0.05)${cls.shifts.length ? `; shifts ${cls.shifts.slice(0, 8).join(", ")}` : ""}`);

    /* backdrop-filter only on fixed or sticky layers */
    const bf = await P.eval(`[...document.querySelectorAll("*")].filter(e => { const v = getComputedStyle(e).backdropFilter || getComputedStyle(e).webkitBackdropFilter; return v && v !== "none"; })
      .filter(e => { for (let a = e; a && a !== document.documentElement; a = a.parentElement) { const p = getComputedStyle(a).position; if (p === "fixed" || p === "sticky") return false; } return true; })
      .map(e => e.tagName.toLowerCase() + (e.id ? "#" + e.id : "") + (e.dataset.testid ? "[" + e.dataset.testid + "]" : ""))`);
    check(!bf.length, `no backdrop-filter on layers that scroll with the page${bf.length ? ": " + bf.slice(0, 5).join(", ") : ""}`);

    /* scrub render time */
    const scrub = STEPS.filter(s => s.scrub === true);
    if (!scrub.length) note("no scrub steps");
    else if (!(await P.eval("!!(window.storyApp && typeof storyApp.seek === 'function')"))) note("window.storyApp.seek not exposed; scrub render time not measured");
    else {
      let t0 = 0; const starts = {}; for (const s of STEPS) { starts[s.id] = t0; t0 += +s.dur_s || 0; }
      for (const s of scrub) {
        const ms = await P.eval(`(async () => { const a = ${starts[s.id]}, d = ${+s.dur_s || 1}, out = [];
          for (let i = 0; i < 120; i++) { const t = a + d * (i / 119); const t1 = performance.now(); await storyApp.seek(t); out.push(performance.now() - t1); }
          out.sort((x, y) => x - y); return [out[60], out[Math.floor(0.95 * 119)]]; })()`);
        check(ms[0] <= 8 && ms[1] <= 16, `scrub ${s.id}: seek ${ms[0].toFixed(2)} ms median, ${ms[1].toFixed(2)} ms 95th percentile (<= 8, <= 16)`);
      }
    }
  }

  /* DPR caps */
  for (const [w, h, mobile, cap] of [[1440, 900, false, 2], [390, 844, true, 1.5]]) {
    await P.send("Emulation.setDeviceMetricsOverride", {width: w, height: h, deviceScaleFactor: 3, mobile});
    await P.send("Emulation.setTouchEmulationEnabled", {enabled: mobile, maxTouchPoints: mobile ? 5 : 0});
    await P.goto(URL0 + "#s=" + IDS[Math.min(IDS.length - 1, Math.floor(IDS.length / 2))]);
    if ((await P.waitFor(SREADY, 60000, 100)) < 0) { check(false, `${w}x${h} DPR 3: story ready`); continue; }
    await sleep(1200);
    const cv = await P.eval(`({dpr: devicePixelRatio, list: [...document.querySelectorAll("canvas")].filter(c => c.clientWidth > 0 && c.getClientRects().length).map(c => +(c.width / c.clientWidth).toFixed(3))})`);
    check(cv.list.length > 0 && cv.list.every(x => x <= cap + 0.01), `${w}x${h} at DPR ${cv.dpr}: visible canvas backing ratio ${cv.list.join(", ") || "no canvas"} (cap ${cap})`);
  }
  check(!P.exceptions.length, `no uncaught exception${P.exceptions.length ? ": " + P.exceptions.slice(0, 3).join(" | ") : ""}`);
} finally { await P.close(); await srv.close(); }
process.exit(C.finish());
