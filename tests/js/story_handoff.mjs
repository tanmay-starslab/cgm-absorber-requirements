// Hand-off gate of the "How a spectrum is made" story, both directions (v1: PLAN_final §4, §6 story_handoff, eng P0-2;
// v2: DESIGN_final §5.8 U_entry, the explorer's call to action, first-visit card and hint row, the B0 gate posters).
// Usage: node tests/js/story_handoff.mjs [docs/tng50 dir] [--story learn/how-a-spectrum-is-made] [--page <explorer html>]
//            [TNG_BROWSER=1: --port N --profile DIR --edge BIN --galaxies N --shots DIR]
// --page: the explorer page to serve (default <dir>/index.html; a scratch export of _template.html works too).
//
// v2, explorer -> story (always):
//   node: js/ui/gate.js entry grammar round-trips (parseEntry(entryFragment(x)) = x; R and S/N clamped to the explorer's
//     UV ranges; unknown ions, ids, beats dropped), watchLabel and holdProgress, posterSources; the gate posters of the
//     default galaxy exist, are within their caps (150 kB; card 60 kB) and their JSON agrees with the cameras;
//     _template.html: one CTA (#story-cta, data-story) in the spectra panel's story row, the hint and its close button,
//     the first-visit card is a .pop, the v1 footnote (#story-link) and chapter list are gone, every a[data-story] points
//     into the story.
//   browser: at 1440, 1024 and 390 px the CTA is visible, inside the viewport, not overlapping the plot bar's groups, the
//     hint or the spectra; its href parses (gate.js parseEntry) to the explorer's galaxy, sightline, lead ion, R and S/N
//     and follows instrument changes; the first-visit card opens once, never while another popover is open, stays in
//     the viewport and does not cover the CTA; the hint dismissal is remembered; a return from the story (from=story)
//     shows neither; following the CTA lands on the story page, whose gate.js reads the same entry.
// v1, story -> explorer (when ROOT has steps.json): the checks below. Without steps.json they are skipped (STORY_REQUIRE=1
// makes that a failure); their browser part runs only against the v1 page (window.storyApp).
// Node part (always), with the explorer's own js/state.js and the registry of the exported page (<dir>/index.html DATA):
//   - every step's hand-off state (its `handoff` merged over the previous steps' hand-offs and the explorer defaults)
//     is valid for the explorer: ions known, layout one of LAYOUTS, R and S/N inside the registry ranges, integer seed
//     below 100000, sightline id matching ID_RE (out-of-range values would be clamped or dropped silently);
//   - parseHash(formatHash(S)) round-trips id, ions, layout, R (bands of the selected ions), sn, seed, fit and intr for
//     every step, starting from
//     a different base state so every value comes from the hash;
//   - galaxy: for the default galaxy and every galaxy with story data (ROOT/data/<kind>_<subhalo>_<ray>.json) the
//     galaxy part of the hand-off is the explorer grammar (no part for the default galaxy, else g=<subhalo id>&), and
//     with <dir>/js/galaxies.js present parseGalaxy reads it back.
// Browser part (TNG_BROWSER=1): for each step with a handoff, its hand-off link (the active card's "Open in Spectra",
// [data-testid="story-open-spectra"] or a[data-handoff], else "Skip to the explorer", [data-testid="story-skip"] or
// #to-explorer, which follows the step) points at the explorer page with a fragment, its
// fragment parses to the step's expected state and carries the galaxy the story shows; the last such link is followed
// and the explorer's tngApp.getState() matches. Up to --galaxies (default 3) non-default galaxies with story data are
// opened as ?g=<subhalo id> and their link must carry g=<that id>.
import {readFileSync, existsSync, readdirSync} from "node:fs";
import {join, resolve, relative} from "node:path";
import {pathToFileURL} from "node:url";
import {ROOT as REPO, parseArgs, checker, serve, launch, BLOCK, READY, sleep} from "./lib/browser.mjs";

const {pos, opt} = parseArgs(process.argv.slice(2));
const DIR = resolve(pos[0] || join(REPO, "docs/tng50"));
const STORY = opt.story || "learn/how-a-spectrum-is-made";
const SROOT = resolve(DIR, STORY), STEPS_F = join(SROOT, "steps.json"), PAGE = resolve(opt.page || join(DIR, "index.html"));
const C = checker(), check = C.check, note = C.note;
const HAVE_V1 = existsSync(STEPS_F);
if (!HAVE_V1) {
  if (process.env.STORY_REQUIRE === "1") { console.log(`FAIL no steps.json at ${STEPS_F} (STORY_REQUIRE=1)`); process.exit(1); }
  note(`v1 checks skipped (no story steps at ${relative(REPO, STEPS_F)})`);
}
const St = await import(pathToFileURL(join(DIR, "js/state.js")).href);
const raw = HAVE_V1 ? JSON.parse(readFileSync(STEPS_F, "utf8")) : [], STEPS = Array.isArray(raw) ? raw : raw.steps || [];
// v2 keeps js/engine.js (modulepreload) but mounts js/main.js; only a page without main.js is the v1 card page
const SPAGE = existsSync(join(SROOT, "index.html")) ? readFileSync(join(SROOT, "index.html"), "utf8") : "";
const V1_PAGE = /storyApp|js\/engine\.js/.test(SPAGE) && !/js\/main\.js/.test(SPAGE);

/* ================================================================ v2 node: entry grammar, gate helpers, posters, markup */
const GATE_F = join(SROOT, "js/ui/gate.js");
const Gt = existsSync(GATE_F) ? await import(pathToFileURL(GATE_F).href) : null;
check(!!Gt, `v2 gate module ${relative(REPO, GATE_F)} imports in node`);
if (Gt) {
  const L = h => ({hash: h, search: ""});
  const cases = [{g: 488530, ray: "rand_b062_a062", ion: "OVI", R: 15000, sn: 20, from: "explorer"},
    {g: 411449, ray: "edge_b100_a090", ion: "HI", R: 150000, sn: 2}, {g: 7, ray: "face_b010_a000", ion: null, R: 5000, sn: 100, t: 0.5, beat: "B7b"}];
  const keys = ["g", "ray", "ion", "R", "sn", "t", "beat", "from"], norm = o => JSON.stringify(keys.map(k => o[k] ?? null));
  const bad = cases.filter(c => norm(Gt.parseEntry(L("#" + Gt.entryFragment(c)))) !== norm(c));
  check(!bad.length, `gate.js parseEntry(entryFragment(x)) round-trips ${cases.length} entries${bad.length ? ": " + bad.map(norm).join("; ") : ""}`);
  const e1 = Gt.parseEntry(L("#g=tng50-1-99-488530&ray=../x&ion=CIV&R=999999&sn=0&t=3&beat=zz"));
  check(e1.g === 488530 && e1.ray === null && e1.ion === null && e1.R === Gt.R_RANGE.max && e1.sn === Gt.SN_RANGE.min && e1.t === 1 && e1.beat === null,
    `parseEntry clamps R and S/N, drops unknown ions, unsafe ids and bad beats (${JSON.stringify(e1)})`);
  const e2 = Gt.parseEntry({hash: "#R=30000", search: "?g=411449&ray=rand_b050_a010"});
  check(e2.g === 411449 && e2.ray === "rand_b050_a010" && e2.R === 30000, "parseEntry reads g and ray from the query too (store.js grammar)");
  const wl = [[150, "2½ min"], [312, "5 min"], [60, "60 s"], [0, null], [95, "1½ min"]].filter(([s, w]) => Gt.watchLabel(s) !== w);
  check(!wl.length, `watchLabel: 150 s -> 2½ min, 312 s -> 5 min, 60 s -> 60 s${wl.length ? ": " + wl.map(([s]) => `${s} -> ${Gt.watchLabel(s)}`).join(", ") : ""}`);
  check(Gt.holdProgress(0) === 0 && Gt.holdProgress(Gt.HOLD_MS / 2) === 0.5 && Gt.holdProgress(10 * Gt.HOLD_MS) === 1 && Gt.HOLD_MS === 450, "holdProgress is linear over HOLD_MS = 450 ms and clamps");
  check(Gt.fill("galaxy {{galaxy}}, {{$watch_len}}", {galaxy: 1, watch_len: "5 min"}) === "galaxy 1, 5 min", "fill() fills {{key}} and {{$key}}");
  /* S0 §5 (notes/story2/S0.md): no backdrop-filter anywhere on the stage; the gate's choices are solid like the HUD pills */
  const gcss = readFileSync(GATE_F, "utf8");
  check(!/backdrop-filter/.test(gcss) && /\.sg-b\{[^}]*background:#0b0f1ce6/.test(gcss), "gate CSS: no backdrop-filter, Hold/Watch solid (#0b0f1ce6, S0 §5)");
  /* review2 perf_a11y L3: close() hands focus to the stage (or opts.focusAfter) instead of dropping it to <body> */
  check(/close\([^)]*\)\s*\{[\s\S]{0,900}?el\.contains\(act\)[\s\S]{0,400}?focusAfter[\s\S]{0,400}?\.focus\(\{preventScroll: true\}\)/.test(gcss), "gate close(): focus moves to the stage (or focusAfter), not <body>");
}
/* posters of the default story (data/index.json) */
let DEF_STORY = null;
try { DEF_STORY = JSON.parse(readFileSync(join(SROOT, "data/index.json"), "utf8")).default; } catch { /* no index */ }
if (Gt && DEF_STORY) {
  const ps = Gt.posterSources(DEF_STORY.galaxy, DEF_STORY.ray), caps = {landscape: 150, portrait: 150, card: 60};
  for (const [k, cap] of Object.entries(caps)) { const f = join(SROOT, ps[k]); const ok = existsSync(f), kb = ok ? readFileSync(f).length / 1024 : 0;
    check(ok && kb <= cap, `gate poster ${ps[k]} exists and is ${kb.toFixed(0)} kB (cap ${cap} kB)`); }
  const mf = join(SROOT, ps.meta);
  if (check(existsSync(mf), `gate poster geometry ${ps.meta}`)) {
    const M = JSON.parse(readFileSync(mf, "utf8")), cam = JSON.parse(readFileSync(join(REPO, "scripts/story_posters.camera.json"), "utf8")).gate;
    const errs = [];
    if (M.schema !== "story-gate-poster/1" || M.galaxy !== DEF_STORY.galaxy || M.ray !== DEF_STORY.ray) errs.push("schema/galaxy/ray");
    for (const [k, V] of Object.entries(cam.variants)) { const m = M.variants[k]; if (!m) { errs.push(`${k} missing`); continue; }
      if (JSON.stringify(m.size) !== JSON.stringify(V.size)) errs.push(`${k} size`);
      const [x, y] = m.p1_px; if (!(x >= 0 && x <= m.size[0] && y >= 0 && y <= m.size[1])) errs.push(`${k}: quasar end outside the frame`);
      if (m.file !== ps[k].split("/").pop()) errs.push(`${k} file ${m.file}`); }
    check(!errs.length, `poster geometry agrees with story_posters.camera.json (sizes, files, quasar end in frame)${errs.length ? ": " + errs.join(", ") : ""}`);
  }
}
/* explorer template markup */
{
  const T = readFileSync(join(DIR, "_template.html"), "utf8");
  const ids = id => (T.match(new RegExp(`\\sid="${id}"`, "g")) || []).length;   // not data-testid="..."
  check(ids("story-cta") === 1 && /<div id="story-row"[^>]*>\s*<a id="story-cta"[^>]*data-story/.test(T), "template: one CTA (#story-cta, data-story) leading the story row of the spectra panel");
  check(T.indexOf('id="story-row"') > T.indexOf('id="plotbar"') && T.indexOf('id="story-row"') < T.indexOf('id="spectra"'), "template: the story row sits between the plot bar and the first spectrum");
  check(ids("story-hint") === 1 && /class="sh-x"[^>]*aria-label="[^"]+"/.test(T), "template: the hint and a labelled close button");
  check(/<div class="pop" id="pop-story" role="dialog"/.test(T), "template: the first-visit card is a .pop dialog (explorer popover rules; phones)");
  check(/id="story-cta"[\s\S]*?<\/a><img class="sh-art"[^>]*alt=""[^>]*hidden>/.test(T), "template: inline first-visit still in the story row, after the CTA, hidden until used (review2 M4)");
  check(!ids("story-link") && !/class="story-ch"/.test(T), "template: the v1 footnote (#story-link) and the chapter list are gone");
  const hrefs = [...T.matchAll(/<a [^>]*data-story="[^"]*"[^>]*href="([^"]*)"/g)].map(m => m[1]);
  check(hrefs.length >= 3 && hrefs.every(h => h.startsWith(STORY + "/")), `template: all ${hrefs.length} a[data-story] point into ${STORY}/`);
}

/* the exported page's config (const DATA = {...}; one line), else a minimal one */
function pageConfig() {
  for (const f of ["index.html", "_template.html"]) { const p = join(DIR, f); if (!existsSync(p)) continue;
    const s = readFileSync(p, "utf8"), i = s.indexOf("const DATA = "); if (i < 0) continue;
    const j = s.indexOf("\n", i); try { return JSON.parse(s.slice(i + 13, j).trim().replace(/;$/, "")); } catch {} }
  return null;
}
const CFG = pageConfig();
if (!CFG) note("no exported page config found; using a minimal registry (UV band, H I and O VI)");
const cfg = CFG || {ions: [{key: "HI", order: 0, band: "uv"}, {key: "OVI", order: 9, band: "uv"}], bands: {uv: {R: {min: 5000, max: 150000, default: 30000, pair: [15000, 50000]}}},
  snr: {min: 2, max: 100, default: 10, pair: [20, 5]}, defaults: {id: "rand_b062_a062", ions: ["HI", "OVI"]}, galaxy: {subhalo_id: 488530}};
const reg = St.makeRegistry(cfg);
const DEF_GAL = +(cfg.galaxy?.subhalo_id ?? 0) || null;
const S0 = Object.assign(St.cloneState(reg.DEF), {id: reg.DEF.id || cfg.defaults?.id});
const merge = (S, h) => { const o = St.cloneState(S); if (!h) return o;
  for (const [k, v] of Object.entries(h)) { if (k === "R" && v && typeof v === "object" && !Array.isArray(v)) o.R = {...o.R, ...v};
    else if (k === "R" && Array.isArray(v)) o.R = {...o.R, uv: v}; else if (k === "snr") o.sn = v; else o[k] = v; }
  if (typeof o.sn === "number") o.sn = [o.sn, o.sn];
  if (Array.isArray(o.ions)) o.ions = reg.KEYS.filter(k => o.ions.includes(k)).concat(o.ions.filter(k => !reg.ION[k]));   // the explorer keeps registry order
  for (const b of Object.keys(o.R)) if (typeof o.R[b] === "number") o.R[b] = [o.R[b], o.R[b]];
  return o; };

/* ---------------------------------------------------------------- node: validity and round trip */
const withH = STEPS.filter(s => s.handoff);
note(`${STEPS.length} steps, ${withH.length} with a handoff (${withH.map(s => s.id).join(", ") || "none"})`);
check(withH.length >= 1 || !STEPS.some(s => s.chapter === "yourturn"), "the last chapter (yourturn) carries a handoff state");
const valid = S => {
  const e = [];
  if (!St.ID_RE.test(String(S.id))) e.push(`id ${S.id}`);
  if (!Array.isArray(S.ions) || !S.ions.length || S.ions.some(k => !reg.ION[k])) e.push(`ions ${S.ions}`);
  if (!St.LAYOUTS.includes(S.layout)) e.push(`layout ${S.layout}`);
  for (const [b, r] of Object.entries(S.R)) { const B = reg.BANDS[b]; if (!B) { e.push(`band ${b}`); continue; }
    if (!(Array.isArray(r) && r.every(x => Number.isInteger(x) && x >= B.R.min && x <= B.R.max))) e.push(`R ${b} ${r}`); }
  if (!(Array.isArray(S.sn) && S.sn.every(x => Number.isInteger(x) && x >= reg.SNR.min && x <= reg.SNR.max))) e.push(`sn ${S.sn}`);
  if (!(Number.isInteger(S.seed) && S.seed >= 0 && S.seed < 100000)) e.push(`seed ${S.seed}`);
  return e;
};
/* compared fields; R only for the bands of the selected ions (the explorer keeps its own R for unused bands) */
const usedR = S => Object.fromEntries(Object.entries(S.R || {}).filter(([b]) => (S.ions || []).some(k => reg.ION[k]?.band === b)));
const pickO = S => ({id: S.id, ions: S.ions, layout: S.layout, R: usedR(S), sn: S.sn, seed: S.seed, fit: !!S.fit, intr: !!S.intr});
const pick = S => JSON.stringify(pickO(S));
const diff = (want, got) => { const a = pickO(want), b = pickO(got); return Object.keys(a).filter(k => JSON.stringify(a[k]) !== JSON.stringify(b[k])).map(k => `${k} want ${JSON.stringify(a[k])} got ${JSON.stringify(b[k])}`).join(", "); };
const other = Object.assign(St.cloneState(S0), {id: "edge_b100_a090", ions: [reg.KEYS[0]], layout: "4", seed: 77, fit: !S0.fit, intr: !S0.intr,
  sn: [reg.SNR.max, reg.SNR.min], R: Object.fromEntries(Object.entries(S0.R).map(([b]) => [b, [reg.BANDS[b].R.max, reg.BANDS[b].R.min]]))});
const EXPECT = new Map();
let cur = S0; const invalid = [], trip = [];
for (const s of STEPS) {
  if (s.handoff) cur = merge(cur, s.handoff);
  EXPECT.set(s.id, cur);
  const e = valid(cur); if (e.length) invalid.push(`${s.id}: ${e.join(", ")}`);
  const back = St.parseHash("#" + St.formatHash(cur), reg, other);
  if (pick(back) !== pick(cur)) trip.push(`${s.id}: ${diff(cur, back)}`);
}
check(!invalid.length, `every step's hand-off state is valid for the explorer${invalid.length ? ": " + invalid.slice(0, 5).join("; ") : ""}`);
check(!trip.length, `parseHash(formatHash(S)) round-trips id, ions, layout, R, sn, seed, fit, intr for all ${STEPS.length} steps${trip.length ? ": " + trip.slice(0, 3).join("; ") : ""}`);

/* ---------------------------------------------------------------- node: galaxy part */
const DATA_DIR = join(SROOT, "data");
const GALS = [...new Set((existsSync(DATA_DIR) ? readdirSync(DATA_DIR) : []).map(f => (f.match(/^[a-z_]+?_(\d{3,})_(?:face|edge|rand)_b\d{3}_a\d{3}(?:_s\d+)?\.json$/) || [])[1]).filter(Boolean).map(Number))];
note(`story data for ${GALS.length} galaxies${GALS.length ? ": " + GALS.slice(0, 8).join(", ") + (GALS.length > 8 ? ", ..." : "") : ""}; explorer default galaxy ${DEF_GAL}`);
const galPart = (G, D) => (G == null || G === D ? "" : `g=${G}&`);   // the explorer grammar (js/galaxies.js galaxyHashPart)
const galOf = (hash, search) => { for (const s of [String(hash).replace(/^#/, ""), String(search).replace(/^\?/, "")]) {
  const g = new URLSearchParams(s).get("g"); if (g != null) { const m = g.trim().match(/(\d+)$/); if (m) return +m[1]; } } return null; };
let GX = null;
if (existsSync(join(DIR, "js/galaxies.js"))) { try { GX = await import(pathToFileURL(join(DIR, "js/galaxies.js")).href); } catch (e) { note("js/galaxies.js does not import in node: " + e.message.slice(0, 80)); } }
const galBad = [];
for (const G of [DEF_GAL, ...GALS.filter(g => g !== DEF_GAL)]) {
  const h = galPart(G, DEF_GAL) + St.formatHash(EXPECT.get(STEPS.at(-1)?.id) || S0);
  const got = galOf(h, "") ?? DEF_GAL;
  if (got !== G) galBad.push(`${G} read back as ${got}`);
  if (GX?.parseGalaxy) { const p = GX.parseGalaxy("#" + h, "") ?? DEF_GAL; if (p !== G) galBad.push(`${G}: galaxies.js parseGalaxy gives ${p}`); }
  if (St.parseHash("#" + h, reg, other).id !== (EXPECT.get(STEPS.at(-1)?.id) || S0).id) galBad.push(`${G}: the g= part breaks parseHash`);
}
check(!galBad.length, `galaxy part of the hand-off reads back for the default and ${GALS.filter(g => g !== DEF_GAL).length} other galaxies${galBad.length ? ": " + galBad.slice(0, 4).join("; ") : ""}${GX ? " (with js/galaxies.js)" : ""}`);

/* ---------------------------------------------------------------- browser */
if (!process.env.TNG_BROWSER) { note("browser part skipped (set TNG_BROWSER=1)"); process.exit(C.finish()); }
const edge = opt.edge;   // reduced motion on: the explorer's 3D thumbnail stops spinning on GPU-less nodes
const srv = await serve({dir: DIR, page: PAGE, port: opt.port});
const P = await launch({profile: opt.profile, edge, block: BLOCK, reducedMotion: true});
const URL0 = srv.base + STORY + "/index.html";
const SREADY = `(window.storyApp ? storyApp.ready === true : !!document.querySelector('[data-step][aria-current="step"], [data-step].is-active'))`;
const SSTATE = `(() => { const s = (window.storyApp && storyApp.getState && storyApp.getState()) || {}, a = document.querySelector('[data-step][aria-current="step"], [data-step].is-active');
  return {step: s.step ?? (a && a.dataset.step) ?? null, galaxy: s.galaxy ?? null}; })()`;
const LINK = `(() => { const vis = e => !!e && e.getClientRects().length > 0 && getComputedStyle(e).visibility !== "hidden";
  const act = document.querySelector('[data-step][aria-current="step"], [data-step].is-active') || document;
  let a = [...act.querySelectorAll('[data-testid="story-open-spectra"], a[data-handoff]')].find(vis) || [...document.querySelectorAll('[data-testid="story-open-spectra"]')].find(vis);
  if (!a) a = [...act.querySelectorAll('a[href*="id="]')].find(vis);
  if (!a) a = document.querySelector('[data-testid="story-skip"], #to-explorer');   /* "Skip to the explorer" carries the step's hand-off */
  return a ? {href: a.href, raw: a.getAttribute("href"), what: a.dataset.testid || a.id || (a.dataset.handoff != null ? "a[data-handoff]" : a.tagName.toLowerCase())} : null; })()`;
try {
  console.log(`serving ${relative(REPO, DIR)} at ${srv.base}; browser ${P.browser}`);
  await P.viewport(1440, 900);
  const open = async (search, id) => { await P.goto(URL0 + search + "#s=" + id); const t = await P.waitFor(SREADY, 60000, 100);
    const ok = t >= 0 && (await P.waitFor(`(${SSTATE}).step === ${JSON.stringify(id)}`, 10000, 100)) >= 0; return ok; };
  /* ============================================================ v2 browser: explorer entry */
  const SHOTS = opt.shots ? resolve(opt.shots) : null;
  const CTA = `(() => { const box = e => { if (!e || !e.getClientRects().length || getComputedStyle(e).visibility === "hidden") return null; const r = e.getBoundingClientRect(); return {x: r.left, y: r.top, w: r.width, h: r.height}; };
    const a = document.querySelector("#story-cta"), others = [...document.querySelectorAll("#plotbar > .grp, #ion-chips > *, #story-hint, #story-row .sh-x, #story-row .sh-art, #spectra")].map(e => ({id: e.id || e.className, b: box(e)})).filter(o => o.b);
    const card = document.querySelector("#pop-story"), pops = [...document.querySelectorAll(".pop")].filter(p => !p.hidden && p !== card).map(p => ({id: p.id, b: box(p)}));
    return {cta: box(a), fs: a ? parseFloat(getComputedStyle(a).fontSize) : 0, clip: a ? a.scrollWidth > a.clientWidth + 1 : true, href: a && a.getAttribute("href"), others,
      card: card.hidden ? null : box(card), sheet: card.classList.contains("sheet"), intro: document.querySelector("#story-row").classList.contains("intro"), art: box(document.querySelector("#story-row .sh-art")), pops, hint: !!box(document.querySelector("#story-hint")), W: innerWidth, H: innerHeight}; })()`;
  const inter = (a, b) => Math.max(0, Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x)) * Math.max(0, Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y));
  const inside = (b, W, H) => b.x >= -0.5 && b.y >= -0.5 && b.x + b.w <= W + 0.5 && b.y + b.h <= H + 0.5;
  const entryOf = href => Gt.parseEntry(new URL(href, srv.base));
  const expectEntry = s => { const ion = ["OVI", "HI"].find(k => s.ions.includes(k)) || s.ions[0]; const band = cfg.ions.find(i => i.key === ion)?.band || "uv";
    return {g: (galOf(location0.hash, "") ?? DEF_GAL), ray: s.id, ion: Gt.STORY_IONS.includes(ion) ? ion : null, R: (s.R[band] || s.R.uv)[0], sn: s.sn[0]}; };
  const location0 = {hash: ""};
  const same = (e, w) => ["g", "ray", "ion", "R", "sn"].every(k => (e[k] ?? null) === (w[k] ?? null));
  const fresh = async () => { await P.send("Storage.clearDataForOrigin", {origin: srv.origin, storageTypes: "local_storage"}); };
  if (Gt) {
    for (const [w, h] of [[1440, 900], [1024, 768], [390, 844]]) {
      await P.viewport(w, h, w < 600); await fresh(); await P.goto(srv.base + "index.html");
      if (!check((await P.waitFor(READY, 180000, 250)) >= 0, `${w}: explorer ready`)) continue;
      await P.waitFor(`!document.querySelector("#pop-story").hidden || document.querySelector("#story-row.intro .sh-art.on") || (innerWidth <= 820 && document.querySelector("#story-row.intro"))`, 14000, 100);
      await sleep(700);   // the still fades in over 0.6 s
      const r = await P.eval(CTA), st = await P.eval("tngApp.getState()");
      if (SHOTS) await P.shot(join(SHOTS, `explorer_entry_${w}.png`));
      check(!!r.cta && inside(r.cta, r.W, r.H) && r.fs >= 12 && !r.clip, `${w}: CTA visible, in the viewport, ${r.fs} px, not clipped`);
      const hits = r.cta ? r.others.filter(o => inter(r.cta, o.b) > 4).map(o => o.id) : [];
      check(!hits.length, `${w}: CTA overlaps none of the plot bar groups, chips, hint or spectra${hits.length ? ": " + hits.join(", ") : ""}`);
      const hb = r.others.filter(o => /story-hint|sh-x|sh-art/.test(o.id)), hh = [];
      for (const a of hb) for (const o of r.others) if (o !== a && !/story-hint|sh-x|sh-art/.test(o.id) && inter(a.b, o.b) > 4) hh.push(`${a.id} x ${o.id}`);
      check(!hh.length, `${w}: hint row overlaps nothing${hh.length ? ": " + hh.join(", ") : ""}`);
      const E = entryOf(r.href), want = expectEntry(st);
      check(same(E, want), `${w}: CTA href carries g, ray, ion, R, sn of the view (${r.href})${same(E, want) ? "" : " want " + JSON.stringify(want)}`);
      if (w >= 640) {   // review2 beauty M4: inline first visit, no card over the spectra
        check(r.intro && !r.card, `${w}: first visit is inline (story row intro), no card over the spectra`);
        const artOk = w > 820 ? !!r.art && inside(r.art, r.W, r.H) && !inter(r.art, r.cta) : !r.art;
        check(artOk, `${w}: first-visit still ${w > 820 ? "shown in the story row, in the viewport, beside the CTA" : "hidden (narrow row)"}`);
      } else check(!!r.card && r.sheet && inside(r.card, r.W, r.H) && !inter(r.card, r.cta), `${w}: first-visit card opened as a bottom sheet, inside the viewport, not covering the CTA`);
      check(r.hint === (w > 600), `${w}: hint text ${w > 600 ? "shown" : "hidden on phones"}`);
    }
    /* href follows the instrument and the lines */
    await P.viewport(1440, 900); await P.eval(`document.querySelector('[data-testid="story-card-later"]')?.click()`);
    await P.eval(`tngApp.setInstrument({R: {uv: 50000}, snr: 7, ions: ["HI", "CIV"]})`); await sleep(400);
    let r = await P.eval(CTA), st = await P.eval("tngApp.getState()"), E = entryOf(r.href);
    check(E.R === 50000 && E.sn === 7 && E.ion === "HI" && same(E, expectEntry(st)), `href follows setInstrument (R 50000, S/N 7, lead ion H I): ${r.href}`);
    await P.eval(`tngApp.setInstrument({ions: ["CIV"]})`); await sleep(300); r = await P.eval(CTA); E = entryOf(r.href);
    check(E.ion === null && /ion=CIV/.test(r.href), `a line the story does not have is passed on and dropped by the story (${r.href})`);
    /* reload: card not again; dismissed hint stays dismissed */
    await P.goto(srv.base + "index.html"); await P.waitFor(READY, 180000, 250); await sleep(3800);
    r = await P.eval(CTA); check(!r.card && !r.intro, "second visit: the first-visit intro (or card) does not show again");
    await P.click("#story-row .sh-x"); await sleep(150); await P.goto(srv.base + "index.html"); await P.waitFor(READY, 180000, 250); await sleep(400);
    r = await P.eval(CTA); check(!r.hint && !!r.cta, "the hint dismissal is remembered; the CTA stays");
    /* never over another popover: open the line picker right away on a fresh visit; the card must not show while it is open */
    await fresh(); await P.goto(srv.base + "index.html"); await P.waitFor(READY, 180000, 250); await P.click("#ion-open");
    let both = false; for (let i = 0; i < 25; i++) { const x = await P.eval(CTA); if ((x.card || x.intro) && x.pops.length) both = true; await sleep(200); }
    const stillOpen = (await P.eval(CTA)).pops.some(p => p.id === "ion-pop");
    check(!both && stillOpen, `the first-visit intro never starts while another popover is open (line picker open for 5 s${stillOpen ? "" : ", but it closed"})`);
    await P.key("Escape"); const t2 = await P.waitFor(`!!document.querySelector("#story-row.intro") && document.querySelector("#pop-story").hidden`, 9000, 100);
    check(t2 >= 0, "once the other popover closes, the inline intro starts (it waited) and no card opens at 1440");
    /* back from the story: no card, no hint */
    await fresh(); await P.goto(srv.base + "index.html#id=rand_b062_a062&from=story"); await P.waitFor(READY, 180000, 250); await sleep(3800);
    r = await P.eval(CTA); check(!r.card && !r.intro && !r.hint, "returning from the story (from=story): no card, no intro, no hint");
    /* follow the CTA: the story page reads the same entry */
    const href = new URL(r.href, srv.base).href; await P.goto(href); await sleep(1500);
    const got = await P.eval(`import("./js/ui/gate.js").then(m => m.parseEntry(location))`);
    check(new URL(href).pathname.endsWith(`/${STORY}/`) && same(got, entryOf(href)), `following the CTA opens ${STORY}/ and its gate.js reads the entry (${JSON.stringify(got)})`);
  }

  let lastHref = null, lastId = null;
  if (HAVE_V1 && !V1_PAGE) note("v1 browser hand-off skipped: the story page is the v2 stage (no window.storyApp)");
  for (const s of V1_PAGE ? withH : []) {
    if (!check(await open("", s.id), `${s.id}: story opens on #s=${s.id}`)) continue;
    await P.waitFor(`(() => { const L = ${LINK}; return L && new URL(L.href).hash.length > 1; })()`, 5000, 50);   // hand-off hrefs are set once state.js is imported
    const L = await P.eval(LINK), st = await P.eval(SSTATE);
    if (!check(!!L, `${s.id}: a hand-off link (Open in Spectra in the card, else Skip to the explorer)`)) continue;
    const href = L.href, u = new URL(href), E = EXPECT.get(s.id);
    note(`${s.id}: ${L.what} href="${L.raw.slice(0, 160)}"`);
    check(u.origin === srv.origin && /\/tng50\/(index\.html)?$/.test(u.pathname) && u.hash.length > 1, `${s.id}: link points at the explorer page with a fragment (${u.pathname}, hash ${u.hash ? u.hash.length + " chars" : "none"})`);
    const got = St.parseHash(u.hash, reg, other);
    check(pick(got) === pick(E), `${s.id}: link fragment parses to the step's state${pick(got) === pick(E) ? "" : ": " + diff(E, got)}`);
    const G = st.galaxy != null ? +String(st.galaxy).match(/(\d+)$/)?.[1] : DEF_GAL, g = galOf(u.hash, u.search) ?? DEF_GAL;
    check(g === G, `${s.id}: link carries the story's galaxy (${G}; link ${g})`);
    lastHref = href; lastId = s.id;
  }
  if (lastHref) {
    await P.goto(lastHref);
    const t = await P.waitFor(READY, 180000, 250);
    if (check(t >= 0, `following ${lastId}'s link: explorer ready in ${(t / 1000).toFixed(1)} s`)) {
      const ex = await P.eval("tngApp.getState()"), E = EXPECT.get(lastId);
      check(pick(ex) === pick(E), `explorer state equals ${lastId}'s hand-off${pick(ex) === pick(E) ? "" : ": " + diff(E, ex)}`);
    }
  }
  const nG = +(opt.galaxies ?? 3), others = V1_PAGE ? GALS.filter(g => g !== DEF_GAL).slice(0, nG) : [], last = withH.at(-1);
  if (V1_PAGE && !others.length) note("no non-default galaxy has story data yet; galaxy hand-off in the browser not exercised");
  for (const G of others) if (last) {
    let form = null;
    for (const q of [`?g=${G}`, `?g=tng50-1-99-${G}`]) { if (!(await open(q, last.id))) continue; const L = await P.eval(LINK); if (!L) continue;
      const u = new URL(L.href); if (galOf(u.hash, u.search) === G) { form = q; break; } }
    check(!!form, `galaxy ${G}: the story opened with ?g= hands off to g=${G}${form ? ` (input form ${form})` : ""}`);
  }
  check(!P.exceptions.length, `no uncaught exceptions${P.exceptions.length ? ": " + P.exceptions.slice(0, 3).join(" | ") : ""}`);
} finally { await P.close(); await srv.close(); }
process.exit(C.finish());
