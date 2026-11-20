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
import {ROOT as REPO, parseArgs, checker, serve, launch, BLOCK, READY, sleep, SEP_CHARS} from "./lib/browser.mjs";

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
  /* owner 2026-11-19: no sound effects on the explainer (music only); the explorer keeps its Sounds switch */
  check(!/uisound\.js/.test(readFileSync(join(SROOT, "js/main.js"), "utf8")) && !/gate-sfx/.test(readFileSync(GATE_F, "utf8")),
    "explainer: no sound effects (no uisound import, no Sounds switch)");
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

/* ================================================================ Tier A: the case picker (DESIGN_tierA §7.2, §10 R6)
   node (always): js/ui/picker.js pure parts. Tier A entries never become "Try another beam" rows (pickerModel equals its
   hero-index output); casesModel lists nothing unless index.picker === "cases", only gates.all entries, never in flight;
   the one showing comes first, then the story B14 offers next (§5); card text obeys §7.2 (title <= 5 words, blurb <= 12,
   no digits, no trailing full stop, no dot separators, never "ride"); caseHref; every built story (beats.<id>.json) has
   a card; the shipped index has picker "cases" (owner 2026-11-16) and lists only stories whose files exist.
   browser (TNG_BROWSER=1; --cases runs only this part): casesBrowser() below. */
const PK_F = join(SROOT, "js/ui/picker.js");
const PK = existsSync(PK_F) ? await import(pathToFileURL(PK_F).href) : null;
const CASE_IDS = ["clean", "multiphase", "damped", "empty", "hot"];
let IX1 = null; try { IX1 = JSON.parse(readFileSync(join(SROOT, "data/index.json"), "utf8")); } catch { /* no index */ }
/* a story-index/2 for the tests: the shipped one when it is /2, else built from the hero entry and the director's
   beats.<id>.json (meta.story, meta.case, refGalaxy, refRay, generator.data.file) */
function tierIndex(ix, {picker = "cases", all = true} = {}) {
  if (!ix) return null;
  if (ix.schema === "story-index/2") return {...ix, picker, stories: ix.stories.map(e => ({...e, gates: {...(e.gates || {}), all: e.case === "full" || all}}))};   // all: false = every Tier A entry ungated, as the /1 branch
  const hero = {...ix.stories[0], id: "full", case: "full", subcase: null, beats: "beats.json", shots: "shots.json", gates: {all: true}};
  const st = [hero];
  for (const id of CASE_IDS) {
    const f = join(SROOT, `beats.${id}.json`); if (!existsSync(f)) continue;
    const m = JSON.parse(readFileSync(f, "utf8")).meta || {}, file = String(m.generator?.data?.file || "").split("/data/").pop();
    if (!file) continue;
    let subcase = null; try { subcase = JSON.parse(readFileSync(join(SROOT, "data", file), "utf8")).case?.subcase ?? null; } catch { /* none */ }
    st.push({id, galaxy: +m.refGalaxy, ray: m.refRay, case: m.case, subcase, story: file, page_fits: file.replace(/story_/, "page_fits_"),
             beats: `beats.${id}.json`, shots: `shots.${id}.json`, label: `Subhalo ${m.refGalaxy}`, eligible: true, gates: {all}});
  }
  return {schema: "story-index/2", default: ix.default, default_story: "full", picker, ...(ix.fion ? {fion: ix.fion} : {}), stories: st, ...(ix.film_beams ? {film_beams: ix.film_beams} : {})};
}
const TIX = tierIndex(IX1);
if (check(!!PK && typeof PK.casesModel === "function" && typeof PK.caseHref === "function", `picker.js exports casesModel and caseHref (${relative(REPO, PK_F)})`) && TIX) {
  const ids = TIX.stories.map(e => e.id);
  note(`test index: ${TIX.stories.length} stories (${ids.join(", ")}) from ${IX1.schema === "story-index/2" ? "data/index.json" : "the hero entry and beats.<id>.json"}`);
  const cur = {galaxy: IX1.default.galaxy, ray: IX1.default.ray};
  /* the v2 dialog never shows a Tier A entry */
  const heroOnly = {...TIX, stories: TIX.stories.filter(e => e.case === "full")};
  check(JSON.stringify(PK.pickerModel(TIX, cur, "")) === JSON.stringify(PK.pickerModel(heroOnly, cur, "")) &&
        JSON.stringify(PK.pickerModel(TIX, cur, "488530")) === JSON.stringify(PK.pickerModel(heroOnly, cur, "488530")),
        "pickerModel: Tier A entries are never beam rows (same model as the hero-only index, with and without a query)");
  check(JSON.stringify(PK.pickerModel(IX1, cur, "")) === JSON.stringify(PK.pickerModel({...IX1, stories: IX1.stories.filter(e => !e.case || e.case === "full")}, cur, "")),
        "pickerModel on the shipped data/index.json is unchanged by the Tier A filter");
  /* off unless "cases"; in flight too (owner 2026-11-16: the menu's "Try another" list always offers the stories) */
  const off = [["story-index/1", PK.casesModel({...IX1, picker: undefined}, {current: cur, atEnd: true})], ["picker off", PK.casesModel({...TIX, picker: "off"}, {current: cur, atEnd: true})],
    ["no gates.all", PK.casesModel(tierIndex(IX1, {all: false}), {current: cur, atEnd: true})]];
  check(PK.casesModel(TIX, {current: cur, atEnd: false}).cards.some(c => c.id !== "full"), "casesModel lists the stories in flight (menu)");
  const offBad = off.filter(([, m]) => m.on && m.cards.some(c => c.id !== "full"));
  check(!offBad.length, `casesModel lists no Tier A story for the /1 index, picker "off" or without gates.all${offBad.length ? ": " + offBad.map(x => x[0]).join(", ") : ""}`);
  const on = PK.casesModel(TIX, {current: cur, atEnd: true});
  check(on.on && on.cards.length === ids.length && on.cards[0].id === "full" && on.cards[0].current && on.cards.filter(c => c.current).length === 1,
    `picker "cases" at an end: ${on.cards.length} cards, the full tour first and marked showing (${on.cards.map(c => c.id).join(" ")})`);
  const mix = tierIndex(IX1); mix.stories = mix.stories.map(e => (e.id === "hot" ? {...e, gates: {all: false}} : e));
  check(!PK.casesModel(mix, {current: cur, atEnd: true}).cards.some(c => c.id === "hot"), "an entry with gates.all false is not listed");
  /* order: showing, then B14's next (§5), then index order; current from ?story, else galaxy+ray, else default_story */
  const orderBad = [];
  for (const e of TIX.stories) {
    const m = PK.casesModel(TIX, {story: e.id, current: {galaxy: 1, ray: "x"}, atEnd: true}), nx = PK.NEXT[e.id];
    if (m.cards[0].id !== e.id || !m.cards[0].current) orderBad.push(`${e.id}: first ${m.cards[0].id}`);
    if (nx && ids.includes(nx) && m.cards[1].id !== nx) orderBad.push(`${e.id}: second ${m.cards[1].id}, want ${nx}`);
    if (e.case !== "full") { const g = PK.casesModel(TIX, {current: {galaxy: e.galaxy, ray: e.ray}, atEnd: true}); if (g.cards[0].id !== e.id) orderBad.push(`${e.id} by galaxy+ray: ${g.cards[0].id}`); }
  }
  const ds = PK.casesModel({...TIX, default_story: ids.at(-1)}, {current: {}, atEnd: true});
  if (ds.cards[0].id !== ids.at(-1)) orderBad.push(`default_story ${ids.at(-1)}: first ${ds.cards[0].id}`);
  check(!orderBad.length, `card order: the one showing, then the story B14 offers next, then index order (all ${ids.length} stories)${orderBad.length ? ": " + orderBad.join("; ") : ""}`);
  check(PK.casesModel(TIX, {current: cur, atEnd: true, query: "halo"}).cards.every(c => /halo/i.test(c.title + c.blurb)), "the search box filters cards by title and blurb");
  /* hrefs */
  const hrefs = [[PK.caseHref("full", TIX), "index.html"], [PK.caseHref("clean", TIX), "index.html?story=clean"], [PK.caseHref("full", {...TIX, default_story: "clean"}), "index.html?story=full"]];
  check(hrefs.every(([a, b]) => a === b), `caseHref: full -> index.html, clean -> index.html?story=clean, full under another default -> ?story=full (${hrefs.map(h => h[0]).join(", ")})`);
  /* card text */
  const words = s => String(s).trim().split(/\s+/).filter(Boolean).length;
  const cards = Object.entries(PK.CARDS).map(([k, [t, b]]) => ({k, t, b})).concat((IX1.stories || []).filter(e => e.title || e.blurb).map(e => ({k: "index " + e.id, t: e.title || "", b: e.blurb || ""})));
  const tb = [];
  for (const c of cards) {
    if (words(c.t) > 5 || words(c.b) > 12) tb.push(`${c.k}: ${words(c.t)}/${words(c.b)} words`);
    if (/\d/.test(c.t + c.b)) tb.push(`${c.k}: digits`);
    if (/\.\s*$/.test(c.t) || /\.\s*$/.test(c.b)) tb.push(`${c.k}: trailing full stop`);
    if (SEP_CHARS.some(ch => (c.t + c.b).includes(ch))) tb.push(`${c.k}: dot separator`);
    if (/\bride\b/i.test(c.t + c.b)) tb.push(`${c.k}: "ride"`);
  }
  check(!tb.length, `card text (${cards.length} cards): title <= 5 words, blurb <= 12, no digits, no trailing full stop, no dot separators, never "ride"${tb.length ? ": " + tb.join("; ") : ""}`);
  check(PK.casesModel({...TIX, stories: TIX.stories.map(e => (e.id === "damped" ? {...e, subcase: "lls"} : e))}, {atEnd: true}).cards.find(c => c.id === "damped")?.title === PK.CARDS.lls[0] &&
        PK.casesModel({...TIX, stories: TIX.stories.map(e => (e.id === "clean" ? {...e, title: "Own title", blurb: "Own blurb"} : e))}, {atEnd: true}).cards.find(c => c.id === "clean")?.title === "Own title",
        "a damped entry of subcase lls reads as a Lyman-limit system; an entry's own title/blurb wins");
  const noCard = CASE_IDS.filter(id => existsSync(join(SROOT, `beats.${id}.json`)) && !PK.CARDS[id]);
  check(!noCard.length && Object.values(PK.NEXT).every(n => PK.CARDS[n]), `every built story (beats.<id>.json) has a card and every B14 "next" is a known story${noCard.length ? ": " + noCard.join(", ") : ""}`);
  /* the shipped index */
  if (IX1.schema === "story-index/2") {
    check(IX1.picker === "cases", `shipped data/index.json has picker "cases" (owner flipped it 2026-11-16; OWNER_DECISIONS 10; now "${IX1.picker}")`);
    const miss = [];
    for (const e of IX1.stories.filter(x => x.gates && x.gates.all)) for (const k of ["beats", "shots"]) if (!existsSync(join(SROOT, e[k]))) miss.push(`${e.id}.${k}`);
    for (const e of IX1.stories.filter(x => x.gates && x.gates.all)) if (!existsSync(join(SROOT, "data", e.story))) miss.push(`${e.id}.story`);
    check(!miss.length, `every listed story's beats, shots and data exist${miss.length ? ": " + miss.join(", ") : ""}`);
  } else note(`shipped data/index.json is ${IX1.schema || "story-index/1"}: the case picker is off by construction`);
}

/* ---------------------------------------------------------------- browser */
if (!process.env.TNG_BROWSER) { note("browser part skipped (set TNG_BROWSER=1)"); process.exit(C.finish()); }
if (opt.cases) { await casesBrowser(); process.exit(C.finish()); }
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
await casesBrowser();
process.exit(C.finish());

/* ================================================================ Tier A picker in the browser (DESIGN_tierA §7.2, §10 R6)
   A temp copy of the page (docs/tng50 symlinked, the story page copied) gets a story-index/2 with picker "cases" and every
   story listed (test only; the shipped index stays "off"). Software GL, reduced motion, stills tier (no cubes needed).
   - picker off: the shipped page's dialog list equals the cases page's dialog opened in flight (no Stories group in flight,
     G12) and the v2 markup is untouched;
   - B0 (?nogate): menu -> "Try another beam" shows the Stories group, the full tour first and marked, B14's next second;
     keyboard: ArrowDown walks the cards, Enter loads ?story=<id>; Escape closes and gives focus back;
   - hand-off chain full -> clean -> ... -> hot -> full: on each story's B14 the end action opens the picker, the card of
     the story showing is marked and first; a click reloads on ?story=<id>, whose beats ids equal beats.<id>.json and whose
     story data and beats were fetched; no boot error;
   - G1/G2 on the picker states: every viewport of the G1 matrix at zoom 1 and 1.5 (open at B0, cases): the dialog inside
     the viewport, no text under 12 px, cards >= 44 px, no two options overlap, card text inside its card, titles <= 2
     lines; G9: axe-core (AXE_JS, wcag2a/aa) on the open dialog 0 serious/critical, no animation > 0.3 s;
   - B12n (empty): the "New noise" reseed control, when present, is reachable by keyboard and changes the seed.
   Screenshots to --shots DIR. */
async function casesBrowser() {
  const {mkdtempSync, mkdirSync, cpSync, readdirSync, symlinkSync, writeFileSync, rmSync} = await import("node:fs");
  const os = await import("node:os");
  const QA = await import("./lib/storyqa.mjs");
  if (!TIX || !PK) { check(false, "cases browser: no test index or picker module"); return; }
  const SHOTS = opt.shots ? resolve(opt.shots) : null; if (SHOTS) mkdirSync(SHOTS, {recursive: true});
  const T = mkdtempSync(join(process.env.TMPDIR || os.tmpdir(), "r6pick-")), docs = DIR, md = join(T, "tng50");
  mkdirSync(join(md, "learn"), {recursive: true});
  for (const e of readdirSync(docs)) if (e !== "learn") symlinkSync(join(docs, e), join(md, e));
  for (const e of readdirSync(join(docs, "learn"))) if (e !== "how-a-spectrum-is-made") symlinkSync(join(docs, "learn", e), join(md, "learn", e));
  const PR = join(md, STORY);
  cpSync(SROOT, PR, {recursive: true, filter: f => !f.endsWith(".m4a") && !f.includes("/media/") && !f.includes("/build/")});
  writeFileSync(join(PR, "data/index.json"), JSON.stringify(TIX));
  const ix0 = join(md, "learn/off"); mkdirSync(ix0, {recursive: true});
  const srv = await QA.gzServe(md), PAGE_C = srv.base + STORY + "/index.html";
  const srvOff = await QA.gzServe(DIR), PAGE_OFF = srvOff.base + STORY + "/index.html";
  const AXE = process.env.AXE_JS || join(process.env.TNG_WORK || "/Volumes/cgm_work", "scratch/story2_w/review3_perf_a11y/axe/package/axe.min.js");
  let base = QA.plainEdge(); if (!base) { try { const {findBrowser} = await import("./lib/browser.mjs"); base = findBrowser(); } catch { base = null; } }
  const P = await launch({edge: base ? QA.edgeWith(base, QA.SWIFTSHADER_FLAGS) : undefined, block: BLOCK, reducedMotion: true, width: 1440, height: 900});
  const ids = TIX.stories.map(e => e.id), byId = Object.fromEntries(TIX.stories.map(e => [e.id, e]));
  const BOOT = `!!(window.__story && __story.ready) || !!window.__storyError`;
  const boot = async (url, ms = 150000) => { await P.goto(url); const t = await P.waitFor(BOOT, ms, 200); const err = await P.eval("window.__storyError || null").catch(() => "eval failed");
    return t >= 0 && !err ? {ok: true, ms: t} : {ok: false, err: err || "timeout"}; };
  const PROBE = `(() => { const pk = document.getElementById("picker"); if (!pk || pk.hidden) return {open: false};
    const R = e => { const r = e.getBoundingClientRect(); return {x: r.left, y: r.top, w: r.width, h: r.height}; }, W = innerWidth, H = innerHeight;
    const vis = e => e.getClientRects().length > 0;
    const groups = [...pk.querySelectorAll(".pk-g")].map(g => g.getAttribute("aria-label"));
    const cards = [...pk.querySelectorAll(".pk-c")].map(o => ({id: o.dataset.story, cur: o.getAttribute("aria-selected") === "true", title: o.querySelector(".pk-l").textContent,
      blurb: (o.querySelector(".pk-b") || {}).textContent || "", tag: (o.querySelector(".pk-t") || {}).textContent || ""}));
    const opts = [...pk.querySelectorAll(".pk-o")].filter(vis), texts = [...pk.querySelectorAll("h2,.pk-gl,.pk-l,.pk-b,.pk-t,.pk-foot,.pk-none,input")].filter(vis);
    const fonts = texts.map(e => parseFloat(getComputedStyle(e).fontSize)), small = texts.filter((e, i) => fonts[i] < 12).map(e => e.className || e.tagName);
    const ob = opts.map(R), over = [];
    for (let i = 0; i < ob.length; i++) for (let j = i + 1; j < ob.length; j++) { const a = ob[i], b = ob[j];
      const ar = Math.max(0, Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x)) * Math.max(0, Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y)); if (ar > 4) over.push(i + "x" + j); }
    const outside = [], lines = [];
    for (const o of opts) { const r = R(o); for (const t of o.querySelectorAll(".pk-l,.pk-b,.pk-t")) { const q = R(t); if (q.x < r.x - 0.5 || q.x + q.w > r.x + r.w + 0.5 || q.y < r.y - 0.5 || q.y + q.h > r.y + r.h + 0.5) outside.push(o.dataset.story || o.dataset.ray);
      if (o.classList.contains("pk-c") && t.classList.contains("pk-l")) lines.push(Math.round(q.h / parseFloat(getComputedStyle(t).lineHeight))); }
      for (const t of o.querySelectorAll(".pk-l,.pk-t")) { const q = R(t); for (const u of o.querySelectorAll(".pk-t")) { if (u === t) continue; const s = R(u);
        const ar = Math.max(0, Math.min(q.x + q.w, s.x + s.w) - Math.max(q.x, s.x)) * Math.max(0, Math.min(q.y + q.h, s.y + s.h) - Math.max(q.y, s.y)); if (ar > 4) outside.push((o.dataset.story || "") + " tag overlap"); } } }
    const b = R(pk), list = pk.querySelector(".pk-list"), lr = R(list), first = opts[0] ? R(opts[0]) : null;
    const anims = document.getAnimations().filter(a => pk.contains(a.effect && a.effect.target)).map(a => +(a.effect.getComputedTiming().duration) || 0);
    return {open: true, W, H, box: b, inside: b.x >= -0.5 && b.y >= -0.5 && b.x + b.w <= W + 0.5 && b.y + b.h <= H + 0.5, groups, cards, beams: pk.querySelectorAll(".pk-o:not(.pk-c)").length,
      minFont: Math.min(...fonts), small, over, outside, minH: Math.min(...ob.filter((r, i) => opts[i].classList.contains("pk-c")).map(r => r.h)), maxTitleLines: Math.max(0, ...lines),
      firstVisible: !!first && first.y >= Math.max(lr.y, b.y) - 0.5 && first.y + first.h <= Math.min(lr.y + lr.h, b.y + b.h) + 0.5, listHTML: list.innerHTML, anims,
      focus: document.activeElement ? (document.activeElement.dataset.story || document.activeElement.dataset.ray || document.activeElement.tagName.toLowerCase()) : null}; })()`;
  const openMenu = async () => { await P.eval(`document.getElementById("menu-btn").click()`); await P.waitFor(`!document.getElementById("menu-sheet").hidden`, 4000, 50);
    await P.eval(`document.querySelector('#menu-sheet .mn-i[data-id="picker"]').click()`); await P.waitFor(`document.getElementById("picker") && !document.getElementById("picker").hidden`, 4000, 50); await sleep(250); return P.eval(PROBE); };
  const closePicker = async () => { await P.eval(`(() => { const p = document.getElementById("picker"); if (p && !p.hidden) p.querySelector(".pk-x").click(); })()`); await sleep(150); };
  const jumpTo = async p => { await P.eval(`__story.setTarget(${p}, true)`); await P.waitFor(`Math.abs(__story.state().p - ${p}) < 2e-4`, 8000, 50); await sleep(400); };
  const openEnd = async (k = "another_story") => { await jumpTo(1); await P.waitFor(`(() => { const e = document.getElementById("end-actions"); return e && !e.hidden && e.getClientRects().length; })()`, 8000, 100);
    await P.eval(`document.querySelector('#end-actions [data-end="${k}"]').click()`); await P.waitFor(`document.getElementById("picker") && !document.getElementById("picker").hidden`, 4000, 50); await sleep(250); return P.eval(PROBE); };
  const fetched = async () => P.eval(`performance.getEntriesByType("resource").map(e => e.name.split("/how-a-spectrum-is-made/").pop())`);
  const beatIds = id => JSON.parse(readFileSync(join(SROOT, byId[id].beats), "utf8")).beats.map(b => b.id);
  try {
    console.log(`cases browser: temp page ${T}; ${ids.length} stories listed; browser ${P.browser}`);
    await QA.setViewport(P, {w: 1440, h: 900, zoom: 1});
    /* picker off: the shipped page, end of the story */
    let r = await boot(PAGE_OFF + "?nogate=1");
    let offHTML = null;
    if (check(r.ok, `picker off: shipped page boots (${r.ok ? r.ms + " ms" : r.err})`)) {
      const o = await openEnd("ride_another"); offHTML = o.listHTML;
      check(o.open && !o.cards.length && !o.groups.includes("Stories"), `picker off: the end action opens the v2 dialog with no Stories group (${o.groups.join(", ")})`);
      if (SHOTS) await P.shot(join(SHOTS, "pick_off_b14_1440.png"));
      if (existsSync(AXE)) { await P.eval(readFileSync(AXE, "utf8") + ";0");
        const v = await P.eval(`axe.run(document.getElementById("picker"), {runOnly: {type: "tag", values: ["wcag2a", "wcag2aa"]}}).then(r => r.violations.filter(v => v.impact === "serious" || v.impact === "critical").map(v => v.id + " x" + v.nodes.length + " at " + v.nodes.slice(0, 3).map(n => n.target.join(" ")).join("; ")))`, 120000);
        check(!v.length, `G9 picker off (v2 dialog, B14): axe-core wcag2a/aa 0 serious or critical${v.length ? ": " + v.join(", ") : ""}`); }
      await closePicker();
    }
    /* cases page at B0 (no gate) */
    r = await boot(PAGE_C + "?nogate=1");
    if (!check(r.ok, `cases page boots with the test index (${r.ok ? r.ms + " ms" : r.err})`)) return;
    let o = await openMenu();
    const want = PK.casesModel(TIX, {current: {galaxy: TIX.default.galaxy, ray: TIX.default.ray}, atEnd: true}).cards.map(c => c.id);
    check(o.open && o.groups[0] === "Stories" && JSON.stringify(o.cards.map(c => c.id)) === JSON.stringify(want) && o.cards[0].cur && o.cards[0].tag === "showing now",
      `B0: menu -> Try another beam leads with the Stories group, ${o.cards.length} cards in order ${o.cards.map(c => c.id).join(" ")}, the full tour marked showing`);
    check(o.cards.every(c => c.title === (PK.CARDS[byId[c.id].subcase === "lls" ? "lls" : c.id] || [])[0] || c.title === byId[c.id].title), "B0: each card shows its §7.2 title and blurb");
    if (SHOTS) await P.shot(join(SHOTS, "pick_cases_b0_1440.png"));
    /* G9: axe on the open dialog; reduced-motion animations */
    if (existsSync(AXE)) {
      await P.eval(readFileSync(AXE, "utf8") + ";0");
      const v = await P.eval(`axe.run(document.getElementById("picker"), {runOnly: {type: "tag", values: ["wcag2a", "wcag2aa"]}}).then(r => r.violations.map(v => ({id: v.id, impact: v.impact, n: v.nodes.length, at: v.nodes.slice(0, 3).map(n => n.target.join(" ") + (n.any && n.any[0] && n.any[0].data && n.any[0].data.contrastRatio ? " " + n.any[0].data.contrastRatio : "")).join("; ")})))`, 120000);
      const bad = v.filter(x => x.impact === "serious" || x.impact === "critical");
      check(!bad.length, `G9 picker (cases, B0): axe-core wcag2a/aa on the dialog, 0 serious or critical${v.length ? " (" + v.map(x => `${x.id} ${x.impact} x${x.n} at ${x.at}`).join(", ") + ")" : ""}`);
    } else note(`G9 picker: axe-core not found (${AXE}); set AXE_JS`);
    check(o.anims.every(d => d <= 300), `G9 picker: no animation over 0.3 s in the dialog (${o.anims.join(", ") || "none"})`);
    /* keyboard: ArrowDown from the search box walks the cards; Escape closes and focus returns to the menu button */
    await QA.press(P, "ArrowDown"); const f1 = (await P.eval(PROBE)).focus; await QA.press(P, "ArrowDown"); const f2 = (await P.eval(PROBE)).focus;
    check(f1 === want[0] && f2 === want[1], `G9 picker: ArrowDown walks the cards in order (${f1}, ${f2})`);
    await QA.press(P, "Escape"); await sleep(200);
    const fx = await P.eval(`({open: !document.getElementById("picker").hidden, focus: document.activeElement && (document.activeElement.id || document.activeElement.className)})`);
    check(!fx.open && fx.focus !== "" && fx.focus !== null && !/^BODY$/i.test(fx.focus), `G9 picker: Escape closes the dialog and gives focus back (${fx.focus})`);
    /* G1/G2 over the matrix (picker open, cases, B0) */
    const g1 = [];
    o = await openMenu();
    for (const [w, h] of QA.VIEWPORTS) for (const z of [1, 1.5]) {
      await QA.setViewport(P, {w, h, zoom: z}); await sleep(250);
      const s = await P.eval(PROBE), tag = `${w}x${h}@${z}`;
      if (!s.open) { g1.push(`${tag}: dialog closed`); o = await openMenu(); continue; }
      if (!s.inside) g1.push(`${tag}: dialog outside the viewport`);
      if (s.minFont < 12) g1.push(`${tag}: text ${s.minFont} px (${s.small.slice(0, 3).join(",")})`);
      if (s.over.length) g1.push(`${tag}: options overlap ${s.over.slice(0, 3).join(",")}`);
      if (s.outside.length) g1.push(`${tag}: card text outside its card ${[...new Set(s.outside)].slice(0, 3).join(",")}`);
      if (s.minH < 44) g1.push(`${tag}: card ${s.minH.toFixed(0)} px tall`);
      if (s.maxTitleLines > 2) g1.push(`${tag}: a title wraps to ${s.maxTitleLines} lines`);
      if (!s.firstVisible) g1.push(`${tag}: first card not visible in the list`);
      if (SHOTS && ((w === 390 && z === 1) || (w === 260 && z === 1.5) || (w === 844 && z === 1) || (w === 1920 && z === 1))) await P.shot(join(SHOTS, `pick_cases_b0_${w}x${h}_z${z}.png`));
    }
    check(!g1.length, `G1/G2 picker states: ${QA.VIEWPORTS.length * 2} viewport x zoom cases, dialog in view, text >= 12 px, cards >= 44 px, no overlaps, titles <= 2 lines${g1.length ? ": " + g1.slice(0, 8).join("; ") : ""}`);
    await QA.setViewport(P, {w: 1440, h: 900, zoom: 1}); await closePicker();
    /* in flight: no Stories group; the list equals the picker-off dialog's */
    const bs = await P.eval(`__story.beats()`), mid = bs[Math.floor(bs.length / 2)];
    await jumpTo((mid.p0 + mid.p1) / 2);
    o = await openMenu();
    check(o.open && o.cards.length > 0 && o.groups.includes("Stories"), `in flight (${mid.id}): the dialog lists the Stories group (owner 2026-11-16)`);
    if (SHOTS) await P.shot(join(SHOTS, `pick_cases_flight_${mid.id}_1440.png`));
    await closePicker();
    /* keyboard pick at B0: Enter on the next story's card loads it */
    await jumpTo(0); o = await openMenu();
    await QA.press(P, "ArrowDown"); await QA.press(P, "ArrowDown"); const kTarget = (await P.eval(PROBE)).focus;
    await QA.press(P, "Enter");
    const tk = await P.waitFor(`location.search.includes("story=${kTarget}") && (${BOOT})`, 150000, 250);
    check(tk >= 0 && !(await P.eval("window.__storyError || null")), `keyboard: Enter on the ${kTarget} card reloads on ?story=${kTarget} and the story boots`);
    /* the hand-off chain through every story's B14 */
    const chain = [...ids.filter(i => i !== "full"), "full"];
    let here = kTarget, seen = new Set([kTarget]);
    const order = [kTarget, ...chain.filter(i => i !== kTarget)];
    if (order[order.length - 1] !== "full") order.push("full");
    for (let i = 0; i + 1 < order.length; i++) {
      const from = order[i], to = order[i + 1];
      if (from !== "full") {
        const got = await P.eval(`__story.beats().map(b => b.id)`), files = await fetched(), e = byId[from];
        check(JSON.stringify(got) === JSON.stringify(beatIds(from)) && files.some(f => f.startsWith(e.beats)) && files.some(f => f.startsWith("data/" + e.story)),
          `${from}: ?story=${from} plays ${e.beats} (${got.length} beats) on data/${e.story}`);
      }
      o = await openEnd();
      check(o.open && o.cards[0] && o.cards[0].id === from && o.cards[0].cur && (!PK.NEXT[from] || !ids.includes(PK.NEXT[from]) || o.cards[1].id === PK.NEXT[from]),
        `${from} B14: the end action opens the picker, ${from} first and marked, then ${o.cards[1] && o.cards[1].id}${o.cards[0] ? "" : " (no cards)"}`);
      if (SHOTS && i < 2) await P.shot(join(SHOTS, `pick_cases_b14_${from}_1440.png`));
      if (from === "empty" || (i === 0 && from !== "empty")) {}
      await P.eval(`document.querySelector('#picker .pk-c[data-story="${to}"]').click()`);
      const t = await P.waitFor(`(${to === "full" ? `!location.search.includes("story=")` : `location.search.includes("story=${to}")`}) && (${BOOT})`, 150000, 250);
      const err = await P.eval("window.__storyError || null").catch(() => "eval failed");
      check(t >= 0 && !err, `${from} -> ${to}: the card reloads on ${PK.caseHref(to, TIX)} and the story boots${err ? ": " + String(err).slice(0, 200) : ""}`);
      seen.add(to); here = to;
    }
    check(ids.every(i => seen.has(i)), `hand-off chain visited every listed story (${[...seen].join(" -> ")})`);
    /* B12n reseed control (empty story) */
    if (byId.empty) {
      r = await boot(PAGE_C + "?story=empty&nogate=1");
      const b12 = (await P.eval(`__story.beats()`)).find(b => b.id === "B12n");
      if (r.ok && b12) {
        await jumpTo((b12.p0 + b12.p1) / 2);
        const c = await P.eval(`(() => { const e = [...document.querySelectorAll('[data-dial="seed"], [data-key="newNoise"], [data-key="seed"], #dock button')].find(x => /new noise/i.test(x.textContent + " " + (x.getAttribute("aria-label") || "")) || x.dataset.key === "newNoise" || x.dataset.dial === "seed");
          return e ? {tag: e.tagName, tab: e.tabIndex, vis: e.getClientRects().length > 0, name: e.getAttribute("aria-label") || e.textContent.trim()} : null; })()`);
        if (SHOTS) await P.shot(join(SHOTS, "empty_b12n_1440.png"));
        if (!c) {
          if (process.env.STORY_REQUIRE_RESEED === "1") check(false, "B12n: no \"New noise\" reseed control on the page (STORY_REQUIRE_RESEED=1)");
          else note("PENDING B12n: no \"New noise\" reseed control exists on the page (beats ask interactions newNoise; js/spectrum is outside R6). Not counted.");
        } else {
          const s0 = await P.eval(`__story.state().spec.seed`);
          await P.eval(`(() => { const e = [...document.querySelectorAll('[data-dial="seed"], [data-key="newNoise"], [data-key="seed"], #dock button')].find(x => /new noise/i.test(x.textContent + " " + (x.getAttribute("aria-label") || "")) || x.dataset.key === "newNoise" || x.dataset.dial === "seed"); e.focus(); })()`);
          await QA.press(P, "Enter"); await sleep(300);
          const s1 = await P.eval(`__story.state().spec.seed`);
          check(c.vis && c.tab >= 0 && !!c.name && s1 !== s0, `B12n: the reseed control "${c.name}" is visible, in the tab order and Enter reseeds (${s0} -> ${s1})`);
        }
      } else check(false, `B12n: ?story=empty boots and has B12n (${r.ok ? "no B12n" : r.err})`);
    }
    check(!P.exceptions.length, `cases browser: no uncaught exceptions${P.exceptions.length ? ": " + P.exceptions.slice(0, 3).join(" | ") : ""}`);
  } finally { await P.close(); await srv.close(); await srvOff.close(); try { rmSync(T, {recursive: true, force: true}); } catch { /* temp */ } }
}
