// Layout gates of the story v2 (DESIGN_final §4: G1 overlap, G2 type floor, G3 composition, G12 chrome, G10 numbers in
// the rendered DOM). U_qa, §5.10. Runs today against v1 (the stepper) and unchanged against v2 (window.__story).
//
//   node tests/js/story_overlap.mjs                     self-test + node part
//   node tests/js/story_overlap.mjs --fixture F.json    evaluate one recorded snapshot (or an array of them)
//   TNG_BROWSER=1 node tests/js/story_overlap.mjs [docs/tng50] [--quick] [--samples 12] [--motion both|reduced|normal]
//        [--no-explorer] [--explorer-only] [--shots DIR] [--out DIR] [--edge BIN] [--max-states N]
//   TNG_BROWSER=1 node tests/js/story_overlap.mjs --capture-sizes   write tests/js/fixtures/story_qa/sizes.json (v2 page)
//
// Node part (always):
//   - self-test: every tests/js/fixtures/story_qa/overlap_*.json; clean passes, each seeded defect fails its gate;
//   - layout classes (§3.3): every point of the G1 matrix (11 viewports x 5 zooms) maps to exactly one class with the
//     reference rules in lib/storyqa.mjs, and the stated examples hold (844x390 phone landscape, 683x512 compact,
//     260x563 narrow, 768x1024 tablet, 1366x768 desktop); when ROOT/js/ui/layoutclass.js exists its class equals the
//     reference at every matrix point and on a 37 px grid;
//   - node G1 (full matrix x 160 p x motion/reduced over solver output): runs when ROOT/js/ui/layout.js exports
//     solve(items, ctx) and itemsFor(fs, ctx) -> items | {items, ctx}, ROOT/js/core/seek.js exports seek(p, data, overrides), and the browser
//     size table tests/js/fixtures/story_qa/sizes.json exists (captured by `--capture-sizes` from __story.sizeTable());
//     otherwise it prints what is missing (STORY_REQUIRE=1 makes that a failure).
// Browser part (TNG_BROWSER=1): for each viewport x zoom (CSS viewport = device / zoom, deviceScaleFactor = zoom), load
//   the story, visit 12 positions (v2: beat midpoints through __story.setTarget; v1: steps through #s=<id>), collect
//   every visible text run and control from the DOM plus v2's registered rects and paths (__story.rects()), and apply
//   the same gate functions. v2 adds: text inside the viewport, one kinetic group per band, dock state = beats.json,
//   <= 4 chrome elements in flight, digits only inside [data-key]/[data-num]. Explorer entry views at 1440/1024/390 too.
//   The first failing state of each viewport x zoom is screenshotted to --shots (at most 80).
import {existsSync, readFileSync, writeFileSync, mkdirSync, readdirSync} from "node:fs";
import {join, resolve, relative} from "node:path";
import {pathToFileURL} from "node:url";
import {parseArgs, checker, launch, BLOCK, sleep} from "./lib/browser.mjs";
import {REPO, STORY_REL, STORY_ROOT, FIX_DIR, VIEWPORTS, ZOOMS, matrix, classOf, CLASSES, evalLayout, segHitsRect, normaliseRects, selfTest, report,
  writeResult, plainEdge, gzServe, mockServer, setViewport, detect, positions, goTo, snapshot, screenshot, COLLECT} from "./lib/storyqa.mjs";

const {pos, opt} = parseArgs(process.argv.slice(2));
const C = checker(), REQ = process.env.STORY_REQUIRE === "1";
const skipOrFail = msg => (REQ ? C.check(false, msg + " (STORY_REQUIRE=1)") : C.note("skipped: " + msg));

/* ---------------------------------------------------------------- one fixture */
if (opt.fixture) {
  const fx = JSON.parse(readFileSync(resolve(opt.fixture), "utf8"));
  for (const s of Array.isArray(fx) ? fx : [fx]) { const r = evalLayout(s.boxes ? s : {...s, ...normaliseRects(s.rects)}); if (!report(C, r)) continue; C.check(true, `${s.name || "snapshot"}: G1 G2 G3 G12 G10 pass`); }
  process.exit(C.finish());
}

/* ---------------------------------------------------------------- node part */
selfTest(C, "overlap", fx => evalLayout(fx));

const M = matrix();
const none = M.filter(m => !m.cls);
C.check(!none.length, `layout classes: all ${M.length} matrix points map to a class${none.length ? "; none for " + none.map(m => `${m.cw}x${m.ch}`).join(", ") : ""}`);
const multi = M.filter(m => classOf(m.cw, m.ch).hits.length > 1);
if (multi.length) C.note(`first-match rule decides ${multi.length} point(s): ` + multi.map(m => `${m.cw}x${m.ch} ${classOf(m.cw, m.ch).hits.join(">")}`).join(", "));
for (const [w, h, want] of [[844, 390, "phone-landscape"], [683, 512, "compact-landscape"], [260, 563, "narrow"], [768, 1024, "tablet-portrait"], [1366, 768, "desktop"], [390, 844, "phone-portrait"]])
  C.check(classOf(w, h).cls === want, `layout class ${w}x${h} -> ${classOf(w, h).cls} (${want}, §3.3)`);
const byCls = {}; for (const m of M) (byCls[m.cls] ||= []).push(`${m.w}x${m.h}@${Math.round(m.zoom * 100)}`);
C.note("matrix classes: " + CLASSES.map(c => `${c} ${(byCls[c] || []).length}`).join(", "));

const ROOT = resolve(opt.root || STORY_ROOT);
const LC = join(ROOT, "js/ui/layoutclass.js");
if (existsSync(LC)) {
  const mod = await import(pathToFileURL(LC).href);
  const fn = mod.layoutClass || mod.classOf || mod.classify || mod.default;
  /* names may be camelCase ("phonePortrait"), snake/space separated, or short ("compact", "tablet") */
  const norm = c => String(c && typeof c === "object" ? c.cls || c.name || c.id : c).replace(/([a-z])([A-Z])/g, "$1-$2").toLowerCase().replace(/[\s_]+/g, "-")
    .replace(/^compact$/, "compact-landscape").replace(/^tablet$/, "tablet-portrait");
  if (C.check(typeof fn === "function", "js/ui/layoutclass.js exports a class function (layoutClass | classOf | classify | default)")) {
    const bad = [];
    for (const m of M) if (norm(fn(m.cw, m.ch)) !== m.cls) bad.push(`${m.cw}x${m.ch}: ${norm(fn(m.cw, m.ch))} vs ${m.cls}`);
    for (let w = 200; w <= 2600; w += 37) for (let h = 200; h <= 1600; h += 37) { const ref = classOf(w, h).cls; if (norm(fn(w, h)) !== ref) bad.push(`${w}x${h}: ${norm(fn(w, h))} vs ${ref}`); }
    C.check(!bad.length, `layoutclass.js agrees with the §3.3 reference on the matrix and a 37 px grid${bad.length ? ` (${bad.length} differ: ${bad.slice(0, 5).join("; ")})` : ""}`);
  }
} else skipOrFail(`layout class module ${relative(REPO, LC)} not built yet (U_shell)`);

/* node G1: solver output over the full matrix, judged by this file's own gate functions (independent of U_shell's
   story_layout checks). Inputs as the page builds them (U_shell U_qa note 4): U_motion's seek made from beats.json +
   shots.json and called with {cls}, seek.prepare (real camera projection: beam corridor, act anchors, plaque, chips),
   copy.json resolved against the data keys + U_copy's derived keys, the story flags, U_eq's eq.json, the browser size
   table. itemsFor(fs, ctx) returns the solver items, or {items, ctx} with bands and corridors ({a, b, r}: G3 paths). */
const LAYOUT = join(ROOT, "js/ui/layout.js"), SEEK = join(ROOT, "js/core/seek.js"), SIZES = opt.sizes ? resolve(opt.sizes) : join(FIX_DIR, "sizes.json");
const missing = [LAYOUT, SEEK, SIZES].filter(f => !existsSync(f));
const readJ = f => existsSync(f) ? JSON.parse(readFileSync(f, "utf8")) : null;
if (missing.length) skipOrFail(`node G1 needs ${missing.map(f => relative(REPO, f)).join(", ")}${missing.includes(SIZES) ? " (capture it: TNG_BROWSER=1 node tests/js/story_overlap.mjs --capture-sizes)" : ""}`);
else {
  const lay = await import(pathToFileURL(LAYOUT).href), sk = await import(pathToFileURL(SEEK).href);
  const dataF = readdirSync(join(ROOT, "data")).filter(f => /^story_\d+_.*\.json$/.test(f)).sort()[0];
  if (!C.check(typeof lay.solve === "function" && typeof lay.itemsFor === "function" && typeof sk.seek === "function" && dataF,
    "node G1 contract: layout.solve, layout.itemsFor, seek.seek and a ROOT/data/story_*.json")) process.exit(C.finish());
  const data = readJ(join(ROOT, "data", dataF)), sizes = readJ(SIZES);
  const beatsDoc = readJ(join(ROOT, "beats.json")), shotsDoc = readJ(join(ROOT, "shots.json")), copy = readJ(join(ROOT, "copy.json")), eq = readJ(join(ROOT, "eq/eq.json"));
  const beats = beatsDoc && (Array.isArray(beatsDoc) ? beatsDoc : beatsDoc.beats);
  const seekFn = sk.makeSeek && beatsDoc && shotsDoc ? sk.makeSeek({beats: beatsDoc, shots: shotsDoc}) : sk.seek;
  const prep = sk.prepare && beatsDoc && shotsDoc ? sk.prepare(data, beatsDoc, shotsDoc) : undefined;
  let derived = {};
  try { const CL = await import(pathToFileURL(join(REPO, "tests/js/story_copy_lint.mjs")).href); derived = CL.deriveKeys ? CL.deriveKeys(copy, data) || {} : {}; }
  catch (e) { C.note(`deriveKeys unavailable (${e.message}); lines with derived keys measure their raw {{key}}`); }
  const story = {beats, copy, eq, flags: data.flags || {}, lookup: {keys: {...(data.keys || {}), ...Object.fromEntries(Object.entries(derived).filter(([, v]) => v != null))}}};
  C.note(`node G1 inputs: ${dataF}; seek ${sk.makeSeek ? "makeSeek(beats, shots) with {cls}" : "default"}; prepare ${prep ? "yes (real projection)" : "no"}; size table classes ${Object.keys(sizes).join(", ")}`);
  const N = +(opt.p || 160);
  let states = 0, failed = 0, nPaths = 0, dockG3 = 0; const worst = [], byGate = {}, byCls = {}, eqCov = {};
  const dockKid = b => b.parent === "dock" || b.container === "dock";
  const segAny = (pth, b) => pth.pts.some((q, k) => k > 0 && segHitsRect(pth.pts[k - 1], q, b));
  const t0 = Date.now();
  for (const m of M) for (const reduced of [false, true]) for (let i = 0; i < N; i++) {
    const p = (i + 0.5) / N, fs = seekFn(p, data, {cls: m.cls});
    const ctx = {sizes, story, prep, viewport: {w: m.cw, h: m.ch, zoom: m.zoom}, w: m.cw, h: m.ch, cls: m.cls, reduced};
    const got = lay.itemsFor(fs, ctx), items = Array.isArray(got) ? got : got.items, ctx2 = {...ctx, ...(Array.isArray(got) ? {} : got.ctx || {})};
    const placed = lay.solve(items, ctx2), n = normaliseRects({...placed, corridors: ctx2.corridors || []});
    nPaths += n.paths.length;
    /* the first-use hint is chrome until p moves > 1 % (§3.2); G12 counts from p 0.02 as U_shell's test does */
    const r = evalLayout({name: `${m.w}x${m.h}@${m.zoom} (${m.cls}) p=${p.toFixed(4)} ${fs.beat?.id || ""}${reduced ? " reduced" : ""}`, viewport: ctx.viewport, cls: m.cls, pinned: true,
      flight: p >= 0.02 && !(fs.beat && fs.beat.stop), boxes: n.boxes, paths: n.paths, dockState: fs.spec?.dock,
      beatU: fs.beat?.u, expectDock: beats ? (beats.find(b => b.id === fs.beat?.id) || {}).dock : undefined}, {g3Skip: dockKid});
    /* the dock labels here are hud.js placeholders (U_spec's real rects exist only in the page): their beam crossings are
       counted as notes; the browser run judges the real ones */
    for (const pth of n.paths) for (const b of n.boxes.filter(dockKid)) if (segAny(pth, b)) dockG3++;
    /* fix1 (review H3): equation coverage per layout class: an equation in the steady part of its window must be placed */
    /* (a beat's equations count as one slot: the phone steps one chip through a chain, so "some equation shown" is the unit) */
    const phoneish = /phone|narrow/.test(m.cls);   // review2 three_d T3: noPhone slots are off on phones by design
    if (!reduced && (fs.eqs || []).some(e => Math.abs(e.phase ?? 0) < 0.5 && !(e.noPhone && phoneish))) {
      const k = `${m.cls}|${fs.beat?.id}`, c = eqCov[k] || (eqCov[k] = {n: 0, placed: 0});
      c.n++; if ((placed.placed || []).some(b => /^eq:/.test(b.id))) c.placed++;
    }
    states++;
    if (r.fails.length) { failed++; byCls[m.cls] = (byCls[m.cls] || 0) + 1; for (const x of r.fails) byGate[x.gate] = (byGate[x.gate] || 0) + 1; if (worst.length < 20) worst.push(...r.fails.slice(0, 2)); }
  }
  C.check(!failed, `node G1/G2/G3/G12: ${states} solver states (${M.length} matrix points x ${N} p x motion/reduced), ${failed} failing` +
    (failed ? ` (by gate ${JSON.stringify(byGate)}, by class ${JSON.stringify(byCls)})` : "") + `; ${nPaths} path checks; ${((Date.now() - t0) / 1000).toFixed(0)} s`);
  for (const x of worst.slice(0, 20)) C.note(`${x.gate} ${x.msg}`);
  if (dockG3) C.note(`beam over a placeholder dock label in ${dockG3} state(s) (not judged in node; U_motion shots / U_spec rects, browser run)`);
  { const low = Object.entries(eqCov).filter(([, c]) => c.n >= 3 && c.placed / c.n < 0.8).map(([k, c]) => `${k} ${Math.round(100 * c.placed / c.n)} %`);
    C.check(!low.length, `H3 equation coverage: a beat's equation slot is filled in >= 80 % of its steady window in every layout class (${Object.keys(eqCov).length} class x beat cells)${low.length ? ": " + low.slice(0, 12).join("; ") + (low.length > 12 ? ` (+${low.length - 12})` : "") : ""}`); }
}

/* ---------------------------------------------------------------- browser part */
if (!process.env.TNG_BROWSER) { C.note("browser part skipped (set TNG_BROWSER=1)"); process.exit(C.finish()); }
const DIR = resolve(pos[0] || join(REPO, "docs/tng50"));
const PAGE = join(DIR, STORY_REL, "index.html");
if (!existsSync(PAGE)) { skipOrFail(`no story page at ${relative(REPO, PAGE)}`); process.exit(C.finish()); }
const quick = !!opt.quick, SAMPLES = +(opt.samples || (quick ? 4 : 12)), SHOTS = opt.shots ? resolve(opt.shots) : null, OUT = opt.out ? resolve(opt.out) : null;
const MOTION = opt.motion || "reduced", maxStates = +(opt["max-states"] || 1e9);
if (SHOTS) mkdirSync(SHOTS, {recursive: true}); if (OUT) mkdirSync(OUT, {recursive: true});
/* --capture-sizes: the browser size table for node G1 (one representative viewport per layout class; the page measures
   every string and equation after document.fonts.ready and returns it from __story.sizeTable()) */
if (opt["capture-sizes"]) {
  const srvC = await gzServe(DIR), P = await launch({edge: opt.edge || plainEdge(), block: BLOCK, reducedMotion: true}), table = {};
  const HUDF = join(ROOT, "js/ui/hud.js"), hud = existsSync(HUDF) ? await import(pathToFileURL(HUDF).href) : {};
  const copy = JSON.parse(readFileSync(join(ROOT, "copy.json"), "utf8")), idx = JSON.parse(readFileSync(join(ROOT, "data/index.json"), "utf8"));
  const data = JSON.parse(readFileSync(join(ROOT, "data", (idx.stories.find(s => s.galaxy === idx.default?.galaxy && s.ray === idx.default?.ray) || idx.stories[0]).story), "utf8"));
  let derived = {};
  try { const CL = await import(pathToFileURL(join(REPO, "tests/js/story_copy_lint.mjs")).href); derived = Object.fromEntries(Object.entries(CL.deriveKeys(copy, data) || {}).filter(([, v]) => v != null)); }
  catch (e) { C.note(`deriveKeys unavailable: ${e.message}`); }
  try {
    /* one representative viewport per class: U_shell's choice when hud.js offers it, else the first matrix point */
    const reps = new Map();
    if (typeof hud.sizeTableViewports === "function") for (const [cls, v] of Object.entries(hud.sizeTableViewports())) reps.set(cls, {w: v.vw ?? v.w, h: v.vh ?? v.h, zoom: v.zoom || 1, cw: v.w, ch: v.h, cls});
    else for (const m of matrix()) if (!reps.has(m.cls)) reps.set(m.cls, m);
    for (const [cls, m] of reps) {
      await setViewport(P, m); await P.goto(srvC.base + STORY_REL + "/index.html?sizetable=1");
      if ((await P.waitFor(`window.__story && typeof __story.sizeTable === "function"`, 60000, 100)) < 0) { skipOrFail(`--capture-sizes needs index.html?sizetable=1 with __story.sizeTable() (${cls}): ${P.exceptions.slice(0, 2).join(" | ")}`); continue; }
      await P.eval(`window.__derivedKeys = ${JSON.stringify(derived)}; document.fonts.ready.then(() => 0)`);
      const t = await P.eval("Promise.resolve(__story.sizeTable())", 300000);
      table[cls] = t;
      const over = t && t.text ? t.text.over || [] : [];
      C.check(!over.length, `size table ${cls} (${m.cw || m.w}x${m.ch || m.h}): model box >= real DOM box for every text variant${t && t.text ? ` (${t.text.checked} checked)` : ""}${over.length ? `; ${over.length} over, e.g. ${JSON.stringify(over[0]).slice(0, 160)}` : ""}`);
    }
  } finally { await P.close(); await srvC.close(); }
  if (Object.keys(table).length) { writeFileSync(SIZES, JSON.stringify(table)); C.check(true, `size table for ${Object.keys(table).length} classes written to ${relative(REPO, SIZES)}`); }
  process.exit(C.finish());
}

/* browser self-test: the collectors and the v2 adapter on the mock story (clean passes, ?defect=1 fails every layout gate) */
if (!opt["no-selftest"]) {
  const ms = await mockServer(), P = await launch({edge: opt.edge || plainEdge(), block: BLOCK, reducedMotion: true});
  try {
    for (const [url, clean] of [[ms.clean, true], [ms.defect, false]]) {
      await setViewport(P, {w: 1440, h: 900, zoom: 1, mobile: false}); await P.goto(url);
      const kind = await detect(P, 30000), gates = new Set(), msgs = [];
      for (const ps of kind === "v2" ? await positions(P, kind, 0) : []) {
        await goTo(P, kind, ps, {settleMs: 100});
        const r = evalLayout(await snapshot(P, kind, {name: `mock ${ps.beat}`, zoom: 1, expectDock: ps.dock}));
        for (const x of r.fails) { gates.add(x.gate); msgs.push(`${x.gate} ${x.msg}`); }
      }
      if (clean) C.check(kind === "v2" && !gates.size, `browser self-test: mock_story.html (v2 contract) passes${msgs.length ? ": " + msgs.slice(0, 4).join("; ") : ""}`);
      else { const want = ["G1", "G2", "G3", "G10", "G12"], miss = want.filter(g => !gates.has(g));
        C.check(kind === "v2" && !miss.length, `browser self-test: mock_story.html?defect=1 fails ${want.join(", ")}${miss.length ? " (missed " + miss.join(", ") + ")" : ""}`); }
    }
  } finally { await P.close(); await ms.close(); }
}
const srv = await gzServe(DIR);
const URL0 = srv.base + STORY_REL + "/index.html";
const runs = MOTION === "both" ? [true, false] : [MOTION !== "normal"];
const summary = {page: STORY_REL, kind: null, quick, samples: SAMPLES, states: 0, failing: 0, byGate: {}, failures: [], shots: []};
let nShots = 0;
try {
  for (const reduced of runs) {
    const P = await launch({edge: opt.edge || plainEdge(), block: BLOCK, reducedMotion: reduced});
    try {
      await P.send("Emulation.setEmulatedMedia", {features: [{name: "prefers-reduced-motion", value: reduced ? "reduce" : "no-preference"}]});
      console.log(`serving ${relative(REPO, DIR)} at ${srv.base}; browser ${P.browser}; motion ${reduced ? "reduced" : "normal"}`);
      for (const m of opt["explorer-only"] ? [] : matrix({quick})) {
        if (summary.states >= maxStates) break;
        await setViewport(P, m);
        await P.goto(URL0);
        const kind = await detect(P, 60000);
        if (!C.check(!!kind, `${m.w}x${m.h}@${m.zoom}: story ready`)) continue;
        summary.kind = kind;
        if (kind === "v1" && summary.states === 0) C.note("page is v1 (storyApp stepper): v2-only checks (viewport, bands, dock, chrome, keyed numbers) are notes");
        const list = await positions(P, kind, SAMPLES);
        let bad = 0;
        for (const ps of list) {
          if (!(await goTo(P, kind, ps, {settleMs: reduced ? 250 : 900, url: URL0}))) { C.check(false, `${m.w}x${m.h}@${m.zoom}: reached ${ps.beat || ps.step}`); continue; }
          const snap = await snapshot(P, kind, {name: `${m.w}x${m.h}@${Math.round(m.zoom * 100)}% ${ps.beat || ps.step}${reduced ? "" : " motion"}`, zoom: m.zoom,
            expectDock: ps.dock || undefined});
          if (snap.rectsError) C.note(`__story.rects() threw: ${snap.rectsError}`);
          const r = evalLayout(snap);
          summary.states++;
          for (const n of r.notes) if (summary.states <= 3) C.note(n);
          if (r.fails.length) {
            bad++; summary.failing++;
            for (const x of r.fails) { summary.byGate[x.gate] = (summary.byGate[x.gate] || 0) + 1; if (summary.failures.length < 400) summary.failures.push(x); }
            if (SHOTS && nShots < 80 && bad === 1) {   // first failing state of each viewport x zoom, 80 at most
              const f = join(SHOTS, `overlap_${String(++nShots).padStart(2, "0")}_${m.w}x${m.h}_${Math.round(m.zoom * 100)}_${ps.beat || ps.step}.png`);
              writeFileSync(f, await screenshot(P)); summary.shots.push(relative(REPO, f)); }
          }
        }
        C.check(!bad, `${m.w}x${m.h}@${Math.round(m.zoom * 100)}% (${m.cls}, CSS ${m.cw}x${m.ch}): ${list.length} positions, ${bad} with gate failures`);
      }
      /* explorer entry views (the CTA must not collide with the explorer's own layout) */
      if (!opt["no-explorer"] && reduced === runs[0] && existsSync(join(DIR, "index.html"))) {
        for (const [w, h] of [[1440, 900], [1024, 768], [390, 844]]) {
          await setViewport(P, {w, h, zoom: 1});
          await P.goto(srv.base + "index.html");
          const t = await P.waitFor(`document.readyState === "complete" && document.querySelector('[data-testid^="panel-"], main')`, 60000, 200);
          if (t < 0) { C.note(`explorer ${w}x${h}: not ready in 60 s`); continue; }
          await sleep(1500);
          const dom = await P.eval(COLLECT);
          /* G1 only: the 12 px floor (G2) is the story's; the explorer's dense panels keep their own type scale */
          const r0 = evalLayout({name: `explorer ${w}x${h}`, viewport: {w: dom.vw, h: dom.vh}, cls: classOf(dom.vw, dom.vh).cls, boxes: dom.boxes}, {fontFloor: 0});
          const r = {...r0, fails: r0.fails.filter(x => x.gate === "G1")};
          summary.states++;
          if (r.fails.length) { summary.failing++; for (const x of r.fails) { summary.byGate[x.gate] = (summary.byGate[x.gate] || 0) + 1; summary.failures.push(x); } }
          C.check(!r.fails.length, `explorer entry ${w}x${h}: ${r.fails.length} layout failure(s)`);
          if (r.fails.length && SHOTS && nShots < 40) writeFileSync(join(SHOTS, `overlap_explorer_${w}x${h}.png`), await screenshot(P));
        }
      }
      if (P.exceptions.length) C.note(`page exceptions: ${P.exceptions.slice(0, 3).join(" | ")}`);
    } finally { await P.close(); }
  }
} finally { await srv.close(); }
const shown = new Map(); for (const x of summary.failures) { const k = x.msg.replace(/^[^:]*: /, "").replace(/\d+ px²/, "N px²"); if (!shown.has(k)) shown.set(k, x); }
for (const x of [...shown.values()].slice(0, 30)) C.note(`${x.gate} ${x.msg}`);
C.note(`browser: ${summary.states} states (${summary.kind || "?"}), ${summary.failing} failing; by gate ${JSON.stringify(summary.byGate)}`);
const f = writeResult(OUT, "overlap.json", summary); if (f) C.note(`results ${relative(REPO, f)}`);
process.exit(C.finish());
