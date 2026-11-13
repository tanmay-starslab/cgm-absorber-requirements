// Load budget gate of the story v2 (DESIGN_final §4 G6; D9 dependency rules; P1-6 backdrop-filter). U_qa, §5.10.
// Rewrite of the v1 (card-era) budget test: the 75 kB story-JS cap, "no three.js", the 80 kB data cap, the 4G first
// paint and the 1.5 MB Step run are gone (v2 loads three and volume cubes by design); the checks below are the G6 row.
//
//   node tests/js/story_budget.mjs [docs/tng50]          self-test (budget_*.json) + node part
//   node tests/js/story_budget.mjs --fixture F.json       evaluate one recorded set of numbers
//   TNG_BROWSER=1 node tests/js/story_budget.mjs [docs/tng50] [--out DIR] [--edge BIN] [--viz DIR] [--allow-origin a,b]
//
// Node part, gzip -9 of the files as committed, from the static module graph of ROOT/index.html (module and classic
// scripts, stylesheets, static and literal dynamic imports, workers, CSS @import; the explorer modules it imports count):
//   - shell JS+CSS <= 120 kB gz, excluding three (any file whose name contains "three") and fonts;
//   - fonts <= 250 kB on disk (woff2/woff/ttf/otf under ROOT/vendor and every font the graph's CSS references);
//   - no GSAP, Theatre, Remotion, pmndrs postprocessing or troika anywhere in the graph; Lenis only as a dynamic import
//     (the ?lenis=1 A/B, D9); no katex.js at runtime (KaTeX is rendered at build time, D7/U_eq);
//   - no video file inside ROOT outside media/ and build/.
// Browser part (TNG_BROWSER=1), cache disabled, gzip static server like GitHub Pages:
//   - first live frame <= 1.5 s at 20 Mbps (40 ms RTT): performance mark "story:first-live" (v2 contract), else first
//     contentful paint (v1, noted);
//   - first 3D frame <= 4 s at 50 Mbps: mark "story:first-3d" (v2 contract; noted when absent);
//   - bytes of one full run (v2: p swept 0 -> 1; v1: every step) <= 40 MB at 1440x900 and <= 12 MB at 390x844 touch,
//     from Resource Timing (encoded bodies + documents; dedicated-worker fetches are not visible there and are noted);
//   - GPU memory <= 448 / 192 MB when the stage reports it (__story.quality().gpuBytes, __story.gpuBytes(), or the stage's
//     volume pool, (__story.stage).core.gpuBytes() as volcore.js provides; S0 §1 measured 302 MB at the end of the bench);
//   - backdrop-filter area < 3 % of the screen (HUD pills only, P1-6); cumulative layout shift < 0.05; no request off
//     this origin except --allow-origin hosts (the hosted cubes).
import {existsSync, readFileSync, statSync, mkdirSync} from "node:fs";
import {join, resolve, relative, basename} from "node:path";
import {parseArgs, checker, launch, BLOCK, sleep} from "./lib/browser.mjs";
import {REPO, STORY_REL, evalBudget, selfTest, report, writeResult, plainEdge, gzServe, setViewport, detect, walk, gzSize, moduleGraph, G6, storyAssets, assetQuery, RESIDENT} from "./lib/storyqa.mjs";

const {pos, opt} = parseArgs(process.argv.slice(2));
const C = checker(), KB = 1024, MB = KB * KB, kb = n => (n / KB).toFixed(1) + " kB";
if (opt.fixture) { const fx = JSON.parse(readFileSync(resolve(opt.fixture), "utf8")); if (report(C, evalBudget(fx))) C.check(true, `${fx.name || "budget"}: G6 passes`); process.exit(C.finish()); }
selfTest(C, "budget", fx => evalBudget(fx));

const DIR = resolve(pos[0] || join(REPO, "docs/tng50")), ROOT = join(DIR, STORY_REL), PAGE = join(ROOT, "index.html"), OUT = opt.out ? resolve(opt.out) : null;
if (!existsSync(PAGE)) { C.check(process.env.STORY_REQUIRE !== "1", `no story page at ${relative(REPO, PAGE)}`); process.exit(C.finish()); }
if (OUT) mkdirSync(OUT, {recursive: true});

/* ---------------------------------------------------------------- node part */
const G = moduleGraph(PAGE, DIR);
const isThree = f => /three/i.test(basename(f));
const shell = G.files.filter(f => /\.(m?js|css)$/.test(f) && !isThree(f));
const sizes = shell.map(f => [f, gzSize(f)]).sort((a, b) => b[1] - a[1]), shellGz = sizes.reduce((a, x) => a + x[1], 0);
C.note(`module graph: ${G.files.length} files (${shell.length} JS/CSS counted, ${G.files.filter(isThree).length} three file(s) excluded)`);
C.note("largest: " + sizes.slice(0, 6).map(([f, n]) => `${relative(DIR, f)} ${kb(n)}`).join(", "));
if (G.missing.length) C.check(false, `module graph: ${G.missing.length} import(s) point at missing files: ${G.missing.slice(0, 4).map(f => relative(REPO, f)).join(", ")}`);
if (G.external.length) C.note(`external or bare specifiers: ${G.external.slice(0, 6).join(", ")}`);
const fontFiles = new Set(walk(join(ROOT, "vendor")).filter(f => /\.(woff2?|ttf|otf)$/i.test(f)));
for (const css of G.files.filter(f => f.endsWith(".css"))) for (const m of readFileSync(css, "utf8").matchAll(/url\(\s*["']?([^"')]+\.(?:woff2?|ttf|otf))["']?\s*\)/gi)) {
  const f = resolve(join(css, ".."), m[1].split(/[?#]/)[0]); if (existsSync(f)) fontFiles.add(f); }
const fontsBytes = [...fontFiles].reduce((a, f) => a + statSync(f).size, 0);
C.note(`fonts: ${fontFiles.size} files, ${kb(fontsBytes)}`);
const banned = [];
for (const f of G.files.filter(f => /\.m?js$/.test(f))) {
  const src = readFileSync(f, "utf8"), rel = relative(DIR, f);
  if (/katex(\.min)?\.m?js$/i.test(f)) banned.push(`katex.js at runtime (${rel})`);
  for (const [name, re] of [["gsap", /\bfrom\s*["'][^"']*\bgsap\b|\bgsap\.(to|from|timeline)\(/], ["theatre", /@theatre\//], ["remotion", /\bremotion\b/i],
    ["postprocessing", /from\s*["'][^"']*\bpostprocessing\b/], ["troika", /troika/i], ["lenis (static import)", /\bimport\s+[^(]*from\s*["'][^"']*lenis/i]])
    if (re.test(src) || re.test(basename(f))) banned.push(`${name} (${rel})`);
}
const videos = walk(ROOT, new Set(["media", "build", "node_modules"])).filter(f => /\.(mp4|webm|mov|mkv)$/i.test(f)).map(f => relative(ROOT, f));
const dataB = walk(join(ROOT, "data")).reduce((a, f) => a + statSync(f).size, 0);
C.note(`ROOT/data on disk: ${(dataB / MB).toFixed(2)} MB (the browser run measures what one run loads)`);
const nodeNums = {name: "node", shellGz, fontsBytes, banned: [...new Set(banned)], videoOutsideMedia: videos};
if (report(C, evalBudget(nodeNums))) C.check(true, `G6 node: shell JS+CSS ${kb(shellGz)} gz (<= ${G6.shellKB} kB), fonts ${kb(fontsBytes)} (<= ${G6.fontsKB} kB), no banned dependency, no stray video`);

/* ---------------------------------------------------------------- browser part */
if (!process.env.TNG_BROWSER) { C.note("browser part skipped (set TNG_BROWSER=1)"); writeResult(OUT, "budget.json", {node: nodeNums}); process.exit(C.finish()); }
const OBS = `(() => { const B = window.__qaBudget = {cls: 0, fcp: null};
  try { new PerformanceObserver(l => { for (const e of l.getEntries()) if (!e.hadRecentInput) B.cls += e.value; }).observe({type: "layout-shift", buffered: true}); } catch {}
  try { new PerformanceObserver(l => { for (const e of l.getEntries()) if (e.name === "first-contentful-paint") B.fcp = e.startTime; }).observe({type: "paint", buffered: true}); } catch {} })();`;
const MARK = n => `((performance.getEntriesByName(${JSON.stringify(n)})[0] || {}).startTime ?? null)`;
const allow = String(opt["allow-origin"] || "").split(",").filter(Boolean);
// cubes and three served locally (storyAssets): with the hosted cubes blocked, the run bytes would leave out every cube and pass
// for the wrong reason (review2_perf_a11y M1 measured 53.5 MB on the 3D tier). The byte runs force the 3D tier (?force3d=1; on a
// CPU node the page otherwise lands on stills and loads no cubes) and fly slowly enough for the beat prefetch (--run-s, 90 s).
const AS = storyAssets(opt), srv = await gzServe(DIR, AS), AQ = assetQuery(srv, AS);
const URL0 = srv.base + STORY_REL + "/index.html" + (AQ ? "?" + AQ : ""), URL3 = URL0 + (AQ ? "&" : "?") + (opt["no-force3d"] ? "" : "force3d=1");
const RUN_S = +(opt["run-s"] || 90);
C.note(`assets: cubes ${AS.viz || "page default (hosted, blocked here)"}; three ${AS.three || "page default (CDN)"}; byte runs ${opt["no-force3d"] ? "page tier" : "forced 3D tier"}, ${RUN_S} s flight`);
const P = await launch({edge: opt.edge || plainEdge(), block: BLOCK, inject: [OBS], reducedMotion: false});
const out = {name: "browser"};
const net = (mbps, rtt) => P.send("Network.emulateNetworkConditions", {offline: false, latency: rtt, downloadThroughput: mbps * 1e6 / 8, uploadThroughput: Math.min(mbps, 10) * 1e6 / 8});
try {
  await P.send("Network.setCacheDisabled", {cacheDisabled: true});
  await P.send("Emulation.setEmulatedMedia", {features: [{name: "prefers-reduced-motion", value: "no-preference"}]});
  /* first live frame at 20 Mbps, first 3D frame at 50 Mbps */
  for (const [mbps, mark, key, limit] of [[20, "story:first-live", "liveMs", G6.liveS], [50, "story:first-3d", "first3dMs", G6.firstS]]) {
    await setViewport(P, {w: 1440, h: 900, zoom: 1, mobile: false}); await net(mbps, 40);
    await P.goto(URL0);
    const kind = await detect(P, 60000);
    await P.waitFor(`${MARK(mark)} !== null || (${key === "liveMs"} && !window.__story && window.__qaBudget && __qaBudget.fcp !== null)`, limit * 3000, 50);
    const m = await P.eval(MARK(mark));
    if (m !== null) { out[key] = m; C.note(`${mark} at ${m.toFixed(0)} ms (${mbps} Mbps)`); }
    else if (key === "liveMs") { const fcp = await P.eval("__qaBudget.fcp"); if (fcp !== null) out.liveMs = fcp; C.note(`no "${mark}" mark (${kind}); first contentful paint ${fcp === null ? "none" : fcp.toFixed(0) + " ms"} stands in`); }
    else C.note(`no "${mark}" mark (${kind || "not ready"}); first 3D frame not measured${kind === "v2" ? " (stage must mark it, see U_qa.md)" : " (v1 has no 3D)"}`);
  }
  await net(1000, 0);
  /* one full run per tier: bytes, GPU memory, backdrop area, CLS, origins */
  for (const [w, h, mobile, key, gkey] of [[1440, 900, false, "desktopBytes", "gpuDesktop"], [390, 844, true, "mobileBytes", "gpuMobile"]]) {
    // each tier starts cold: the explorer's loader keeps cubes in Cache Storage / IndexedDB, so without this the mobile run
    // re-reads the desktop run's cubes from disk and counts almost nothing (seen: 0.02 MB of cubes at 390x844)
    await P.send("Storage.clearDataForOrigin", {origin: srv.origin, storageTypes: "all"}).catch(() => {});
    await setViewport(P, {w, h, zoom: 1, mobile}); const req0 = P.requests.length, sv0 = {...srv.served};
    await P.goto(URL3);
    const kind = await detect(P, 120000);
    if (!C.check(!!kind, `${w}x${h}: story ready`)) continue;
    if (kind === "v2") { await P.eval(`new Promise(res => { const S = __story; let p = 0, t = performance.now(); const f = now => { p = Math.min(1, p + (1 / ${RUN_S}) * (now - t) / 1000); t = now; S.setTarget(p); if (p < 1) requestAnimationFrame(f); else setTimeout(res, 1500); }; requestAnimationFrame(f); })`, (RUN_S + 300) * 1000);
      // network idle: no new resource entry for 4 s (max 60 s), so late prefetches are counted
      await P.eval(`new Promise(res => { let n = -1, still = 0; const t0 = performance.now(); const k = setInterval(() => { const m = performance.getEntriesByType("resource").length; still = m === n ? still + 1 : 0; n = m; if (still >= 8 || performance.now() - t0 > 60000) { clearInterval(k); res(); } }, 500); })`, 90000);
      const rs = await P.eval(RESIDENT); C.note(`${w}x${h}: tier ${await P.eval("__story.tier || null")}, ${rs.loads} cube loads, ${rs.levels} levels bound at the end`);
      if (rs.stage && !rs.loads) C.check(false, `${w}x${h}: the 3D run loaded no cubes, so its byte count leaves them out (serve them: --viz)`); }
    else for (const id of await P.eval(`[...document.querySelectorAll("[data-step]")].map(e => e.dataset.step)`)) { await P.eval(`(() => { const e = document.querySelector('[data-step="${id}"]'); e && e.scrollIntoView({block: "center"}); })()`); await sleep(250); }
    await sleep(1500);
    const r = await P.eval(`(() => { const nav = performance.getEntriesByType("navigation")[0], res = performance.getEntriesByType("resource");
      return {doc: nav ? (nav.encodedBodySize || nav.transferSize || 0) : 0, res: res.map(e => ({u: e.name, n: e.encodedBodySize || e.transferSize || 0}))}; })()`);
    const vid = x => /\.(mp4|webm|vtt)(\?|$)/i.test(x.u), counted = r.res.filter(x => !vid(x));
    out[key] = r.doc + counted.reduce((a, x) => a + x.n, 0);
    const wire = srv.served.bytes - sv0.bytes, wireViz = srv.served.vizBytes - sv0.vizBytes;   // server-side count includes worker fetches
    C.note(`${w}x${h}: served ${(wire / MB).toFixed(2)} MB (cubes ${(wireViz / MB).toFixed(2)} MB) against ${(out[key] / MB).toFixed(2)} MB in Resource Timing`);
    out[key] = Math.max(out[key], wire);
    C.note(`${w}x${h} ${kind}: ${(out[key] / MB).toFixed(2)} MB in ${counted.length + 1} requests (video excluded); largest ${counted.sort((a, b) => b.n - a.n).slice(0, 3).map(x => `${x.u.replace(srv.origin, "")} ${kb(x.n)}`).join(", ")}`);
    const gpu = kind === "v2" ? await P.eval(`(() => { const S = __story, q = typeof S.quality === "function" ? S.quality() : null; const st = S.stage || (typeof S.perf === "function" && S.perf() && S.perf().stage);
      return (q && typeof q === "object" && q.gpuBytes) || (typeof S.gpuBytes === "function" ? S.gpuBytes() : null) || (st && st.core && typeof st.core.gpuBytes === "function" ? st.core.gpuBytes() : null); })()`) : null;
    if (gpu) out[gkey] = gpu; else C.note(`GPU memory not reported (${kind === "v2" ? "stage must expose gpuBytes, see U_qa.md" : "v1 has no WebGL"})`);
    const bf = await P.eval(`[...document.querySelectorAll("*")].filter(e => { const s = getComputedStyle(e); const v = s.backdropFilter || s.webkitBackdropFilter; return v && v !== "none" && s.visibility !== "hidden" && +s.opacity > 0.02; })
      .reduce((a, e) => { const r = e.getBoundingClientRect(); const x = Math.max(0, Math.min(innerWidth, r.right) - Math.max(0, r.left)), y = Math.max(0, Math.min(innerHeight, r.bottom) - Math.max(0, r.top)); return a + x * y; }, 0) / (innerWidth * innerHeight)`);
    out.backdropFrac = Math.max(out.backdropFrac || 0, bf);
    out.cls = Math.max(out.cls || 0, await P.eval("__qaBudget.cls"));
    const off = P.requests.slice(req0).filter(q => !q.includes(srv.origin) && !/ (data|blob|about|chrome-extension):/.test(q) && !allow.some(a => q.includes(a)));
    out.offOrigin = [...new Set([...(out.offOrigin || []), ...off])];
  }
  C.note("dedicated-worker fetches are not in the page's Resource Timing; a v2 stage that fetches cubes in a worker must report them (see U_qa.md)");
  if (report(C, evalBudget(out))) C.check(true, "G6 browser: first frames, run bytes, GPU memory, backdrop area, CLS and origins within budget");
  if (P.exceptions.length) C.note(`page exceptions: ${P.exceptions.slice(0, 3).join(" | ")}`);
} finally { await P.close(); await srv.close(); }
const f = writeResult(OUT, "budget.json", {node: nodeNums, browser: out}); if (f) C.note(`results ${relative(REPO, f)}`);
process.exit(C.finish());
