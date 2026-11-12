// Hand-off gate of the "How a spectrum is made" story (PLAN_final §4, §6 story_handoff, eng P0-2).
// Usage: node tests/js/story_handoff.mjs [docs/tng50 dir] [--story learn/how-a-spectrum-is-made]
//            [TNG_BROWSER=1: --port N --profile DIR --edge BIN --galaxies N]
// While ROOT has no steps.json the test prints "skipped" (STORY_REQUIRE=1 makes that a failure).
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
const SROOT = resolve(DIR, STORY), STEPS_F = join(SROOT, "steps.json");
if (!existsSync(STEPS_F)) {
  if (process.env.STORY_REQUIRE === "1") { console.log(`FAIL no steps.json at ${STEPS_F} (STORY_REQUIRE=1)`); process.exit(1); }
  console.log(`skipped (no story steps at ${relative(REPO, STEPS_F)}; set STORY_REQUIRE=1 to fail instead)`); process.exit(0);
}
const C = checker(), check = C.check, note = C.note;
const St = await import(pathToFileURL(join(DIR, "js/state.js")).href);
const raw = JSON.parse(readFileSync(STEPS_F, "utf8")), STEPS = Array.isArray(raw) ? raw : raw.steps || [];

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
const srv = await serve({dir: DIR, page: join(DIR, "index.html"), port: opt.port});
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
  let lastHref = null, lastId = null;
  for (const s of withH) {
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
  const nG = +(opt.galaxies ?? 3), others = GALS.filter(g => g !== DEF_GAL).slice(0, nG), last = withH.at(-1);
  if (!others.length) note("no non-default galaxy has story data yet; galaxy hand-off in the browser not exercised");
  for (const G of others) if (last) {
    let form = null;
    for (const q of [`?g=${G}`, `?g=tng50-1-99-${G}`]) { if (!(await open(q, last.id))) continue; const L = await P.eval(LINK); if (!L) continue;
      const u = new URL(L.href); if (galOf(u.hash, u.search) === G) { form = q; break; } }
    check(!!form, `galaxy ${G}: the story opened with ?g= hands off to g=${G}${form ? ` (input form ${form})` : ""}`);
  }
  check(!P.exceptions.length, `no uncaught exceptions${P.exceptions.length ? ": " + P.exceptions.slice(0, 3).join(" | ") : ""}`);
} finally { await P.close(); await srv.close(); }
process.exit(C.finish());
