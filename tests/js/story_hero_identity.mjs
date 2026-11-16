// H0, hero identity guard of Explainer v3 Tier A (DESIGN_tierA.md section 1; gate registry tests/gates.json).
// The hand-tuned hero story (488530 rand_b062_a062: beats.json, shots.json, copy.json, film.json and its story data) must
// behave byte-identically to the 8557cac snapshot in tests/fixtures/hero_v2/ while Tier A lands around it.
//
//   node tests/js/story_hero_identity.mjs                 check against tests/fixtures/hero_v2/ (run_all.mjs runs it)
//   HERO_CHANGE_NOTE="why" node tests/js/story_hero_identity.mjs --update
//                                                         rewrite the snapshot; refuses (exit 2) without HERO_CHANGE_NOTE.
//                                                         The note is appended to manifest.json notes[] with the git HEAD.
//   node tests/js/story_hero_identity.mjs --self-test     seeded defects (one per part, in a temp copy of the page) must each
//                                                         fail H0, and the untouched copy must pass
//   options: --root DIR (a story ROOT to check; default docs/tng50/learn/how-a-spectrum-is-made), --no-dom, --json FILE
//   env: H0_NO_DOM=1 skips the browser part (reported as PARTIAL, never as a pass of H0); TNG_EDGE as tests/js/lib/browser.mjs
//
// Parts (each one sha256 over a canonical JSON; on a mismatch the first differences are printed):
//   seek    hero seek(p) FrameState JSON at 500 seeded p (lcg 12345, the story_core sequence), plain story JSON as data
//   layout  layout.solve boxes (id, x, y, w, h, variant, band) and hidden ids over the G1 matrix (layoutclass.g1Matrix +
//           683x512 + 260x563) x motion/reduced x 160 p, through hud.itemsFor with the page's own lookup/flags
//           (copy/derive.js copyLookup/copyFlags + data.flags, as main.js) and the frozen size table hero_v2/sizes.json.gz
//   lines   activeLines: per beat, the text slots active under the hero flags, their copy entries with every {{key}}
//           rendered (kinetic.copyEntry + derive.render), beatSkip, and narrative.narrativeItems (the text menu)
//   eq      bound values of E2/E4 on cells 125 and 263 (bind.termValues + formatParts with each term's format)
//   vtt     story_vtt --json timeline + cues; in a temp copy: --check before --stamp (its messages), --stamp, the generated
//           media/story.{en.vtt,chapters.vtt,ffmeta} equal to the tracked files, --check after --stamp passes
//   index   picker-off resolution: engine.resolveStory for a fixed list of (galaxy, ray) requests, the v2 "Try another
//           beam" pickerModel, lineUrl of the default entry (new story entries must not change what /1 consumers see)
//   dom     picker-off DOM (headless Chromium, software WebGL, reduced motion): the page DOM at p = 0 and p = 1 at 1440x900
//           and 390x844, and the "Try another beam" dialog opened from the end actions
// Contracts (not snapshots): beats.json valid against ROOT/beats.schema.json (v3 is additive), the hero story JSON valid
// against tests/schemas/story-data/3.schema.json, tests/gates.json lists exactly the frozen ids.
//
// Consumers this guard calls (owners must keep these exports working for the hero, or bring the change to R0):
//   js/core/seek.js makeSeek/prepare; js/ui/hud.js itemsFor/activeText/beatSkip; js/ui/layout.js solve; js/ui/layoutclass.js
//   g1Matrix/layoutClass; js/ui/kinetic.js copyEntry; js/ui/narrative.js narrativeItems; js/copy/derive.js copyLookup/
//   copyFlags/render; js/eq/bind.js termValues/formatParts; js/engine.js resolveStory/lineUrl/schemaErrors; js/ui/picker.js
//   pickerModel; scripts/story_vtt.mjs --json/--check/--stamp.
import {readFileSync, writeFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, cpSync, readdirSync, symlinkSync} from "node:fs";
import {join, resolve, dirname} from "node:path";
import {fileURLToPath, pathToFileURL} from "node:url";
import {spawnSync} from "node:child_process";
import {createHash} from "node:crypto";
import {gzipSync, gunzipSync} from "node:zlib";
import {tmpdir} from "node:os";

const HERE = dirname(fileURLToPath(import.meta.url)), REPO = resolve(HERE, "../..");
const DEFAULT_ROOT = join(REPO, "docs/tng50/learn/how-a-spectrum-is-made");
const FIX = join(REPO, "tests/fixtures/hero_v2");
const STORY_REL = "learn/how-a-spectrum-is-made";
const HERO = {galaxy: 488530, ray: "rand_b062_a062", data: "data/story_488530_rand_b062_a062.json"};
const BASE_COMMIT = "8557cac";
const PARTS = ["seek", "layout", "lines", "eq", "vtt", "index", "dom"];
const FROZEN_GATES = ["H0", "G1", "G2", "G3", "G12", "G4", "G11", "G5a", "G6", "G8", "G9", "G10", "G13r", "G14", "G15", "G16", "G17", "G18", "G19", "G20", "HC"];

const argv = process.argv.slice(2), has = f => argv.includes(f), val = f => (has(f) ? argv[argv.indexOf(f) + 1] : null);
const ROOT = resolve(val("--root") || DEFAULT_ROOT);
const NO_DOM = has("--no-dom") || process.env.H0_NO_DOM === "1";

const sha = s => createHash("sha256").update(s).digest("hex");
const lcg = seed => () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296);
const stable = v => JSON.stringify(v, (k, x) => (x && typeof x === "object" && !Array.isArray(x) ? Object.fromEntries(Object.keys(x).sort().map(n => [n, x[n]])) : x));

/* ================================================================ compute the snapshot of one ROOT */
async function compute(root, {dom = true} = {}) {
  const imp = p => import(pathToFileURL(join(root, p)).href);
  const J = p => JSON.parse(readFileSync(join(root, p), "utf8"));
  const [SK, HUD, L, LC, K, NAR, D, B, E, PK] = await Promise.all(["js/core/seek.js", "js/ui/hud.js", "js/ui/layout.js", "js/ui/layoutclass.js",
    "js/ui/kinetic.js", "js/ui/narrative.js", "js/copy/derive.js", "js/eq/bind.js", "js/engine.js", "js/ui/picker.js"].map(imp));
  const beatsDoc = J("beats.json"), shotsDoc = J("shots.json"), copy = J("copy.json"), data = J(HERO.data), EQ = J("eq/eq.json");
  const index = J("data/index.json");
  const out = {};

  /* ---- seek: 500 seeded p */
  const seek = SK.makeSeek({beats: beatsDoc, shots: shotsDoc});
  {
    const rnd = lcg(12345), ps = Array.from({length: 500}, () => rnd());
    out.seek = {ps, rows: ps.map(p => JSON.stringify(seek(p, data)))};
  }

  /* ---- layout: G1 matrix x motion/reduced x 160 p, the page's composer and solver */
  const lookup = D.copyLookup(copy, data), flags = {...D.copyFlags(copy, data), ...(data.flags || {})};
  {
    const STORY = {beats: beatsDoc.beats, copy, lookup, flags, eq: EQ};
    const PREP = SK.prepare(data, beatsDoc, shotsDoc);
    const SIZES = JSON.parse(gunzipSync(readFileSync(join(FIX, "sizes.json.gz"))).toString("utf8"));   // frozen copy of tests/js/fixtures/story_qa/sizes.json at 8557cac
    const matrix = [...LC.g1Matrix(), ...[[683, 512], [260, 563]].map(([w, h]) => ({vw: w, vh: h, zoom: 1, w, h}))];
    const ps = Array.from({length: 160}, (_, k) => (k + 0.5) / 160);
    const groups = {};
    for (const m of matrix) {
      const cls = LC.layoutClass(m.w, m.h);
      for (const reduced of [false, true]) {
        const key = `${m.vw}x${m.vh}@${m.zoom}${reduced ? " rm" : ""}`, hs = [];
        for (const p of ps) {
          const f = seek(p, data, {cls});
          const got = HUD.itemsFor(f, {w: m.w, h: m.h, reduced, story: STORY, sizes: SIZES, prep: PREP});
          const r = L.solve(got.items, got.ctx);
          const rec = {placed: r.placed.map(b => [b.id, b.x, b.y, b.w, b.h, b.variant ?? null, b.band ?? null]), hidden: (r.hidden || []).map(h => [h.id, h.reason ?? null])};
          hs.push(sha(JSON.stringify(rec)).slice(0, 16));
        }
        groups[key] = hs;
      }
    }
    out.layout = {n: Object.values(groups).reduce((s, a) => s + a.length, 0), groups};
  }

  /* ---- lines: activeLines through the consumers (kinetic copyEntry, derive.render, narrative) */
  {
    const renderDeep = v => (typeof v === "string" ? D.render(v, lookup) : Array.isArray(v) ? v.map(renderDeep)
      : v && typeof v === "object" ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, renderDeep(x)])) : v);
    const skip = HUD.beatSkip(flags), lines = [];
    for (const b of beatsDoc.beats) for (const t of HUD.activeText(b.text || [], flags))
      lines.push({beat: b.id, skip: skip(b), id: t.id, band: t.band, part: t.part || "all", u0: t.u0, u1: t.u1, entry: renderDeep(K.copyEntry(copy, t.id, flags))});
    out.lines = {flags, lines, narrative: NAR.narrativeItems(beatsDoc.beats, copy, lookup)};
  }

  /* ---- eq: E2/E4 bound values on cells 125/263 */
  {
    const rows = [];
    for (const [id, ion, idx] of [["E2", "HI", 125], ["E2", "OVI", 263], ["E4", "OVI", 263], ["E4", "HI", 125]]) {
      const Eq = EQ.eqs[id], tv = B.termValues(Eq, {data, ion, idx});
      const shown = Object.fromEntries(Object.entries(tv).map(([k, v]) => [k, Eq.terms[k] && Eq.terms[k].fmt && typeof v === "number" ? B.formatParts(v, Eq.terms[k].fmt) : null]));
      rows.push({id, ion, idx, values: tv, shown});
    }
    out.eq = {rows};
  }

  /* ---- vtt: story_vtt --json, and --check/--stamp/--check in a temp copy */
  out.vtt = vttPart(root);

  /* ---- index: picker-off resolution */
  {
    const pick = e => (e ? {galaxy: +e.galaxy, ray: e.ray, story: e.story ?? null, page_fits: e.page_fits ?? null} : null);
    const Q = [[null, null], [HERO.galaxy, null], [HERO.galaxy, HERO.ray], [488530, "rand_b050_a215"], [488530, "rand_b143_a150"],
      [488530, "rand_b045_a300_s459727623"], [488530, "rand_b092_a287_s119206912"], [488530, "rand_b139_a096"], [424288, null],
      [424288, "edge_b033_a270_s13959"], [424288, "edge_b136_a066_s45545"], [511920, null], [511920, "edge_b106_a018_s29389"], [1, "x"]];
    const resolved = Q.map(([g, r]) => ({q: [g, r], e: pick(E.resolveStory(index, g, r))}));
    const def = E.resolveStory(index, null, null);
    out.index = {default: index.default, resolved, line: def ? E.lineUrl(index, def) : null,
      picker: PK.pickerModel(index, {galaxy: HERO.galaxy, ray: HERO.ray}, ""), picker_q: PK.pickerModel(index, {galaxy: HERO.galaxy, ray: HERO.ray}, "488530")};
  }

  /* ---- dom: picker-off DOM in a browser */
  try { out.dom = dom ? await domPart(root) : {skipped: true}; } catch (e) { out.dom = {error: "browser part threw: " + (e && e.message || e)}; }

  /* ---- contracts (not part of the identity hash) */
  out.contracts = contracts(root, E, beatsDoc, data);
  return out;
}

function run(args, opts = {}) {
  const r = spawnSync(process.execPath, args, {cwd: REPO, encoding: "utf8", ...opts});
  return {rc: r.status, out: (r.stdout || "").trim(), err: (r.stderr || "").trim()};
}
function vttPart(root) {
  const S = join(REPO, "scripts/story_vtt.mjs");
  const j = run([S, "--root", root, "--json"]);
  const res = {json: j.rc === 0 ? JSON.parse(j.out) : {rc: j.rc, err: j.err}};
  const T = mkdtempSync(join(process.env.TMPDIR || tmpdir(), "h0vtt-"));
  try {
    for (const f of ["film.json", "beats.json", "copy.json", "render.html", "data/index.json", HERO.data, "media/story.en.vtt"]) {
      mkdirSync(dirname(join(T, f)), {recursive: true}); cpSync(join(root, f), join(T, f));
    }
    const pre = run([S, "--root", T, "--check"]);
    const st = run([S, "--root", T, "--stamp"]);
    const gen = {};
    for (const f of ["media/story.en.vtt", "media/story.chapters.vtt", "media/story.ffmeta"]) {
      const g = existsSync(join(T, f)) ? readFileSync(join(T, f), "utf8") : null, t = existsSync(join(root, f)) ? readFileSync(join(root, f), "utf8") : null;
      gen[f] = {sha256: g == null ? null : sha(g), equals_tracked: g != null && g === t};
    }
    const fc = existsSync(join(T, "build/film_copy.json")) ? sha(readFileSync(join(T, "build/film_copy.json"), "utf8")) : null;
    const stampedSame = readFileSync(join(T, "render.html"), "utf8") === readFileSync(join(root, "render.html"), "utf8");
    const post = run([S, "--root", T, "--check"]);
    Object.assign(res, {check_before_stamp: {rc: pre.rc, out: pre.out, err: pre.err}, stamp: {rc: st.rc, out: st.out}, generated: gen,
      film_copy_sha256: fc, render_html_unchanged_by_stamp: stampedSame, check_after_stamp: {rc: post.rc, out: post.out, err: post.err}});
  } finally { rmSync(T, {recursive: true, force: true}); }
  return res;
}

/* picker-off DOM: canonical outline of document.body (tags, sorted attributes without style, trimmed text; the children of
   aria-live regions are left out because announcements come and go with timing) */
const SNAP = sel => `(() => { const out = [], root = ${sel ? `document.querySelector(${JSON.stringify(sel)})` : "document.body"}; if (!root) return null;
  const walk = (e, d) => { if (e.nodeType === 3) { const t = e.textContent.replace(/\\s+/g, " ").trim(); if (t) out.push(" ".repeat(d) + "#" + t); return; }
    if (e.nodeType !== 1) return; const tag = e.tagName.toLowerCase(); if (tag === "script" || tag === "style") return;
    const at = [...e.attributes].filter(a => a.name !== "style").map(a => a.name + "=" + a.value).sort().join(" ");
    out.push(" ".repeat(d) + tag + (at ? " [" + at + "]" : ""));
    if (e.hasAttribute("aria-live")) return;   // live-region announcements are transient (timing), not layout: element only
    for (const c of e.childNodes) walk(c, d + 1); };
  walk(root, 0); return out; })()`;
async function domPart(root) {
  const BR = await import(pathToFileURL(join(REPO, "tests/js/lib/browser.mjs")).href);
  const QA = await import(pathToFileURL(join(REPO, "tests/js/lib/storyqa.mjs")).href);
  let base = QA.plainEdge();
  if (!base) { try { base = BR.findBrowser(); } catch { base = null; } }
  if (!base) return {error: "no Chromium browser found (set TNG_EDGE, or H0_NO_DOM=1 to skip the dom part explicitly)"};
  const edge = QA.edgeWith(base, QA.SWIFTSHADER_FLAGS);   // software WebGL everywhere: the same DOM on GPU and CPU nodes
  const srv = await QA.gzServe(resolve(root, "../.."));
  const res = {};
  try {
    for (const [w, h] of [[1440, 900], [390, 844]]) {
      const P = await BR.launch({edge, block: BR.BLOCK, reducedMotion: true, width: w, height: h});
      try {
        await QA.setViewport(P, {w, h, zoom: 1});
        await P.goto(srv.base + STORY_REL + "/index.html");
        const kind = await QA.detect(P, 120000);
        if (kind !== "v2") return {error: `page not ready at ${w}x${h} (${kind})`};
        await BR.sleep(1500);
        const p0 = await P.eval(SNAP(null));
        await P.eval(`(() => { const S = __story; if (typeof S.seekTo === "function") S.seekTo(1); else S.setTarget(1); })()`);
        await P.waitFor(`Math.abs((__story.state().p ?? -1) - 1) < 2e-4`, 15000, 50);
        await BR.sleep(1500);
        const p1 = await P.eval(SNAP(null));
        await P.eval(`(() => { const b = document.querySelector('[data-end="ride_another"]'); if (b) b.click(); })()`);
        await P.waitFor(`!!document.querySelector("#picker") && !document.querySelector("#picker").hidden`, 5000, 50);
        await BR.sleep(500);
        const picker = await P.eval(SNAP("#picker"));
        res[`${w}x${h}`] = {p0, p1, picker};
      } finally { await P.close(); }
    }
  } finally { await srv.close(); }
  return res;
}

function contracts(root, E, beatsDoc, data) {
  const c = {};
  const bs = JSON.parse(readFileSync(join(root, "beats.schema.json"), "utf8"));
  c.beats_schema = E.schemaErrors(bs, beatsDoc).slice(0, 10);
  const sd = JSON.parse(readFileSync(join(REPO, "tests/schemas/story-data/3.schema.json"), "utf8"));
  c.story_data_schema = E.schemaErrors(sd, data).slice(0, 10);
  const si = JSON.parse(readFileSync(join(REPO, "tests/schemas/story-index/2.schema.json"), "utf8"));
  c.story_index_schema_parses = !!(si.$id === "story-index/2" && si.$defs && si.$defs.entry);
  const ix = JSON.parse(readFileSync(join(root, "data/index.json"), "utf8"));
  c.index_v2_errors = ix.schema === "story-index/2" ? E.schemaErrors(si, ix).slice(0, 10) : [];
  const g = JSON.parse(readFileSync(join(REPO, "tests/gates.json"), "utf8"));
  const ids = g.gates.map(x => x.id);
  c.gates_ids_ok = JSON.stringify(ids) === JSON.stringify(FROZEN_GATES) && new Set(ids).size === ids.length;
  c.schema_samples = schemaSamples(E, bs, sd, si, beatsDoc, ix);
  return c;
}
/* the frozen v3 schemas accept the Tier A shapes and reject broken ones (synthetic samples built from the hero files) */
function schemaSamples(E, bs, sd, si, beatsDoc, ix) {
  const bad = [], clone = o => JSON.parse(JSON.stringify(o));
  const expect = (want, errs, what) => { if ((errs.length === 0) !== want) bad.push(`${what}: ${want ? errs.slice(0, 3).join("; ") : "accepted but must be rejected"}`); };
  // beats v3: B7p with a slot, @role cell/anchors and a role ghost, meta.story/case/tf
  const b3 = clone(beatsDoc); b3.schema = "story-beats/3";
  Object.assign(b3.meta, {story: "multiphase", case: "multiphase", target_s: 190, generator: {version: "director/1"},
    tf: {vol_window: [-6, -1], ion: {"ion:OVI": [-10.6, -5.6]}, pctl: [5, 99.5], bands: [0.5, 0.8, 0.95], speed: [-300, 300], fog: [0.4, 1.4], source: "tube"}});
  const k = b3.beats.findIndex(x => x.id === "B7b"), bt = b3.beats[k];
  Object.assign(bt, {id: "B7p", slot: "B", cell: "@S5"});
  bt.eqs.forEach(e => { e.anchor = {kind: "cell", ref: "@cloudA.core"}; });
  if (bt.eqs[1]) bt.eqs[1].ghost = "T@cloudA.core";
  bt.fields = [{name: "NeVIII", level: "L2"}];
  expect(true, E.schemaErrors(bs, b3), "beats v3 sample (B7p, slot, @role, meta.tf)");
  const b3x = clone(b3); b3x.beats[k].id = "B7q"; expect(false, E.schemaErrors(bs, b3x), "beats v3: unknown beat id B7q");
  const b3y = clone(b3); b3y.beats[k].cell = "S5"; expect(false, E.schemaErrors(bs, b3y), "beats v3: role without @");
  const b3z = clone(b3); b3z.meta.tf = {pctl: [5, 99.5]}; expect(false, E.schemaErrors(bs, b3z), "beats v3: meta.tf without source");
  // story-data/3: the minimum /3 file must pass root + $defs.v3
  const d3 = {meta: {schema: "story-data/3", galaxy: 424288, ray: "edge_b033_a270_s13959", story_id: "multiphase"}, keys: {}, ions: {}, geometry: {}, worked: {},
    flags: {has_pair: false, has_phase_offset: true}, cloud_names: {rule: "letters/2", windows: {}},
    case: {id: "multiphase", declared: "multiphase", subcase: null, rule_version: "case/1", scores: {multiphase: 0.4}, fails: {clean_single: ["two encounters"]}, verdict: {ok: true, metrics: {dv: 255}}},
    claims: {two_components: {value: 2, pass: true}},
    roles: {S5: {cell: 263, ok: true, why: ""}, "cloudA.core": {cell: 12, ok: true}, pair: {cells: [296, 438], ok: true}, pairMid: {l: 24.1}, cells: {"263": {c: [1, 2, 3], h: 0.9, l: 70.2}}},
    plan: {version: "plan/1", rule: "letters/2", half: 306, encounters: [{id: "e1", l0: -20, l1: 5, lc: -8, r90: 6, V: 125, lead: "HI", share: 0.8, ions_at: ["HI", "MgII"], letter: "A"}],
      slots: {A: {on: true, l0: -25, l1: 10}, B: {on: false, l0: 10, l1: 10}}, bounds: {c: [0, 0, 0], r: 40}, vwin: [-300, 300],
      resolve: {ion: "MgII", F15: 0.2, F50: 0.5, r_contrast: 0.3, mode: "resolve"}, bridge_ion: null},
    tf_windows: {density: [-5, -1], "ion:OVI": [-11, -6], pctl: [5, 99.5], source: "tube"},
    limits: {HI: {logN_3sig: 12.3, sn: 10, R: 15000, b: 21}, OVI: {logN_3sig: 13.1, sn: 10, R: 15000, b: 31}},
    cube_cover: {end_r_kpc: 300, frac_in_L0: 1, frac_in_L1: 0.4, frac_in_L2: 0.1}, lod: {finest: {"-20": "L2"}, voxel_kpc: {L0: 3.125, L1: 0.78, L2: 0.195}},
    galaxy: {id: 424288, viz_base: "https://example.invalid/viz/", gas_poor: false, vsys: 12.5, R200c: 306, disk: {c: [0, 0, 0], n: [0, 0, 1], r_kpc: 10}, source: "trident"},
    ions_extra: ["MgII"], eligible_case: true, gates_case: {G16: true}};
  const v3 = d => [...E.schemaErrors(sd, d), ...E.schemaErrors({$ref: "#/$defs/v3", $defs: sd.$defs}, d)];
  expect(true, v3(d3), "story-data/3 sample");
  const d3a = clone(d3); delete d3a.plan; expect(false, v3(d3a), "story-data/3 without plan");
  const d3b = clone(d3); d3b.galaxy.source = "sbi"; expect(false, v3(d3b), "story-data/3 with SBI numbers");
  const d3c = clone(d3); d3c.ions_extra = ["CIV", "MgII"]; expect(false, v3(d3c), "story-data/3 with two extra ions");
  const d3d = clone(d3); d3d.case.id = "warm"; expect(false, v3(d3d), "story-data/3 unknown case id");
  // story-index/2: the hero entry plus one Tier A entry
  const hero = (ix.stories || []).find(s => +s.galaxy === HERO.galaxy && s.ray === HERO.ray) || {};
  const i2 = {schema: "story-index/2", default: {galaxy: HERO.galaxy, ray: HERO.ray}, default_story: "full", picker: "off", fion: ix.fion,
    stories: [{...hero, id: "full", case: "full", beats: "beats.json", shots: "shots.json", gates: {all: true}},
      {id: "multiphase", galaxy: 424288, ray: "edge_b033_a270_s13959", case: "multiphase", story: "story_424288_edge_b033_a270_s13959.json",
       page_fits: "page_fits_424288_edge_b033_a270_s13959.json", beats: "beats.multiphase.json", shots: "shots.multiphase.json", film: "films/multiphase.json",
       viz: {manifest_url: "https://example.invalid/manifest_v2.json", base: "https://example.invalid/"}, poster: "img/poster_multiphase.webp",
       title: "Cool gas and hot gas", blurb: "Two gases on one beam, moving apart", gates: {all: false, G16: true}}], film_beams: ix.film_beams || []};
  expect(true, E.schemaErrors(si, i2), "story-index/2 sample");
  const i2a = clone(i2); i2a.default = "full"; expect(false, E.schemaErrors(si, i2a), "story-index/2 with default as a story id (engine.js reads default.galaxy)");
  const i2b = clone(i2); i2b.picker = "on"; expect(false, E.schemaErrors(si, i2b), "story-index/2 picker value");
  return bad;
}

/* ================================================================ part digests, fixtures, comparison */
function digest(snap) {
  const d = {};
  for (const k of PARTS) if (snap[k] && !snap[k].skipped && !snap[k].error) d[k] = sha(stable(snap[k]));
  return d;
}
const readFix = f => { const p = join(FIX, f); if (!existsSync(p)) return null; const b = readFileSync(p); return JSON.parse(f.endsWith(".gz") ? gunzipSync(b).toString("utf8") : b.toString("utf8")); };
const FILES = {seek: "seek.json.gz", layout: "layout.json.gz", lines: "lines.json", eq: "eq.json", vtt: "vtt.json", index: "index.json", dom: "dom.json.gz"};
function writeFixtures(snap, note) {
  mkdirSync(FIX, {recursive: true});
  for (const k of PARTS) {
    if (!snap[k] || snap[k].skipped) continue;
    const s = JSON.stringify(snap[k], null, k === "seek" || k === "layout" ? 0 : 1) + "\n";
    writeFileSync(join(FIX, FILES[k]), FILES[k].endsWith(".gz") ? gzipSync(s, {level: 9}) : s);
  }
  const old = readFix("manifest.json") || {notes: []};
  const head = spawnSync("git", ["rev-parse", "--short", "HEAD"], {cwd: REPO, encoding: "utf8"}).stdout.trim();
  const dirty = spawnSync("git", ["status", "--porcelain", "--", "docs/tng50/learn/how-a-spectrum-is-made", "scripts/story_vtt.mjs"], {cwd: REPO, encoding: "utf8"}).stdout.trim();
  const dg = digest(snap);
  const prevDom = old.parts && old.parts.dom;
  const m = {schema: "hero-identity/1", base_commit: BASE_COMMIT, hero: HERO, node: process.version,
    parts: Object.fromEntries(PARTS.map(k => [k, dg[k] || (k === "dom" && prevDom) || null])),
    notes: [...(old.notes || []), {note, head, worktree_dirty: dirty ? dirty.split("\n") : [], parts_changed: PARTS.filter(k => dg[k] && (!old.parts || old.parts[k] !== dg[k]))}]};
  writeFileSync(join(FIX, "manifest.json"), JSON.stringify(m, null, 1) + "\n");
  return m;
}

/* first differing JSON paths (small, for the report) */
function diffPaths(a, b, path = "$", out = [], max = 8) {
  if (out.length >= max) return out;
  if (JSON.stringify(a) === JSON.stringify(b)) return out;
  if (a && b && typeof a === "object" && typeof b === "object" && Array.isArray(a) === Array.isArray(b)) {
    const keys = [...new Set([...Object.keys(a), ...Object.keys(b)])];
    for (const k of keys) diffPaths(a[k], b[k], `${path}${Array.isArray(a) ? `[${k}]` : `.${k}`}`, out, max);
    return out;
  }
  const s = x => { const t = JSON.stringify(x); return t === undefined ? "undefined" : t.length > 140 ? t.slice(0, 137) + "..." : t; };
  out.push(`${path}: ${s(b)} (snapshot) -> ${s(a)} (now)`);
  return out;
}
function explain(k, now, ref) {
  if (!ref) return [`no snapshot file ${FILES[k]}`];
  if (k === "seek") {
    const bad = []; now.rows.forEach((r, i) => { if (r !== ref.rows[i] && bad.length < 3) bad.push(i); });
    return bad.map(i => `p=${ref.ps[i]} (#${i}): ` + diffPaths(JSON.parse(now.rows[i]), JSON.parse(ref.rows[i]), "fs", [], 4).join("; "));
  }
  if (k === "layout") {
    const bad = Object.keys({...now.groups, ...ref.groups}).filter(g => JSON.stringify(now.groups[g]) !== JSON.stringify(ref.groups[g]));
    return [`${bad.length} of ${Object.keys(ref.groups).length} viewport groups differ: ${bad.slice(0, 6).join(", ")}${bad.length > 6 ? ", ..." : ""}`].concat(bad.slice(0, 2).map(g => {
      const a = now.groups[g] || [], b = ref.groups[g] || []; const i = a.findIndex((x, j) => x !== b[j]); return `  ${g}: first differing p index ${i} (p = ${((i + 0.5) / 160).toFixed(5)})`; }));
  }
  return diffPaths(now, ref);
}

async function check(root, {dom}) {
  const t0 = Date.now();
  const snap = await compute(root, {dom});
  const man = readFix("manifest.json");
  if (!man) { console.log("FAIL H0: no snapshot (tests/fixtures/hero_v2/manifest.json); create it with HERO_CHANGE_NOTE=... --update"); return {fails: 1, snap}; }
  const dg = digest(snap);
  let fails = 0, partial = [];
  for (const k of PARTS) {
    if (snap[k] && snap[k].error) { fails++; console.log(`FAIL H0 ${k}: ${snap[k].error}`); continue; }
    if (!dg[k]) { partial.push(k); console.log(`skip H0 ${k}: ${snap[k] && snap[k].why ? snap[k].why : "browser part off (H0_NO_DOM / --no-dom)"}`); continue; }
    if (!man.parts[k]) { partial.push(k); console.log(`skip H0 ${k}: not in the snapshot`); continue; }
    if (dg[k] === man.parts[k]) { console.log(`ok H0 ${k} identical (${dg[k].slice(0, 12)})`); continue; }
    fails++;
    console.log(`FAIL H0 ${k} differs from the ${man.base_commit} snapshot (${dg[k].slice(0, 12)} vs ${man.parts[k].slice(0, 12)})`);
    for (const line of explain(k, snap[k], readFix(FILES[k]))) console.log("   " + line);
  }
  const c = snap.contracts;
  const cok = (cond, msg) => { if (cond) console.log("ok " + msg); else { fails++; console.log("FAIL " + msg); } };
  cok(!c.beats_schema.length, `contract: hero beats.json valid against ROOT/beats.schema.json${c.beats_schema.length ? " " + c.beats_schema.join("; ") : ""}`);
  cok(!c.story_data_schema.length, `contract: hero story JSON valid against tests/schemas/story-data/3.schema.json${c.story_data_schema.length ? " " + c.story_data_schema.join("; ") : ""}`);
  cok(c.story_index_schema_parses && !c.index_v2_errors.length, `contract: story-index/2 schema loads; data/index.json valid when it says story-index/2${c.index_v2_errors.length ? " " + c.index_v2_errors.join("; ") : ""}`);
  cok(c.gates_ids_ok, "contract: tests/gates.json lists exactly the frozen gate ids (DESIGN_tierA section 1)");
  cok(!c.schema_samples.length, `contract: v3 schemas accept the Tier A sample shapes and reject 9 broken ones${c.schema_samples.length ? "\n   " + c.schema_samples.join("\n   ") : ""}`);
  const secs = ((Date.now() - t0) / 1000).toFixed(1);
  console.log(`\nH0 ${fails ? "FAILED" : partial.length ? "PARTIAL" : "passed"}: ${PARTS.length - partial.length - fails}/${PARTS.length} parts identical` +
    `${partial.length ? `, not checked: ${partial.join(", ")}` : ""}${fails ? `, ${fails} failure(s)` : ""} (${secs} s)`);
  return {fails, partial, snap, dg};
}

/* ================================================================ self-test: seeded defects must fail */
const patchText = (f, a, b) => { const s = readFileSync(f, "utf8"); if (!s.includes(a)) throw new Error(`self-test patch target missing in ${f}: ${a}`); writeFileSync(f, s.replace(a, b)); };
const patchJson = (f, fn) => { const o = JSON.parse(readFileSync(f, "utf8")); fn(o); writeFileSync(f, JSON.stringify(o, null, 1) + "\n"); };
const DEFECTS = [
  {id: "none", expect: [], about: "untouched copy (control: the mirror must pass)"},
  {id: "seek-code", expect: ["seek"], about: "js/core/seek.js CAPSULE.half 45 -> 46", apply: r => patchText(join(r, "js/core/seek.js"), "CAPSULE = Object.freeze({half: 45,", "CAPSULE = Object.freeze({half: 46,")},
  {id: "layout-code", expect: ["layout"], about: "js/ui/layoutclass.js GAP 8 -> 9 px", apply: r => patchText(join(r, "js/ui/layoutclass.js"), "export const GAP = 8;", "export const GAP = 9;")},
  {id: "copy-word", expect: ["lines"], about: "copy.json B5 display 'A cool clump.' -> 'A cool little clump.'", apply: r => patchJson(join(r, "copy.json"), c => { c.B5.display = "A cool little clump."; })},
  {id: "data-v263", expect: ["eq"], about: "hero story data ions.OVI.cells.V[263] + 0.5 km/s", apply: r => patchJson(join(r, HERO.data), d => { d.ions.OVI.cells.V[263] += 0.5; })},
  {id: "film-chunk", expect: ["vtt"], about: "film.json chunk 'open' 16 s -> 17 s", apply: r => patchJson(join(r, "film.json"), f => { f.chunks[0].s += 1; })},
  {id: "index-listed", expect: ["index"], about: "data/index.json lists a 424288 story as a plain eligible entry (what a naive R1 manifest would do)",
   apply: r => patchJson(join(r, "data/index.json"), ix => { ix.stories.push({galaxy: 424288, ray: "edge_b033_a270_s13959", story: "story_424288_edge_b033_a270_s13959.json", page_fits: "page_fits_424288_edge_b033_a270_s13959.json", label: "Subhalo 424288", eligible: true}); })},
];
function mirror(T) {
  // T/docs/tng50/<everything symlinked> except learn/how-a-spectrum-is-made, which is a real copy (patched per defect)
  const docs = join(REPO, "docs/tng50"), md = join(T, "docs/tng50");
  mkdirSync(join(md, "learn"), {recursive: true});
  for (const e of readdirSync(docs)) if (e !== "learn") symlinkSync(join(docs, e), join(md, e));
  for (const e of readdirSync(join(docs, "learn"))) if (e !== "how-a-spectrum-is-made") symlinkSync(join(docs, "learn", e), join(md, "learn", e));
  cpSync(ROOT, join(md, STORY_REL), {recursive: true, filter: s => !s.endsWith(".m4a")});
  return join(md, STORY_REL);
}
async function selfTest({dom}) {
  let bad = 0;
  for (const d of DEFECTS) {
    const T = mkdtempSync(join(process.env.TMPDIR || tmpdir(), "h0self-"));
    try {
      const r = mirror(T); if (d.apply) d.apply(r);
      const res = run([fileURLToPath(import.meta.url), "--root", r, "--json", join(T, "res.json"), ...(dom ? [] : ["--no-dom"])], {timeout: 600000});
      const got = existsSync(join(T, "res.json")) ? JSON.parse(readFileSync(join(T, "res.json"), "utf8")) : {failed: ["(no result)"]};
      const failed = got.failed || [];
      const okCase = d.expect.length ? res.rc !== 0 && d.expect.every(k => failed.includes(k)) : res.rc === 0 && !failed.length;
      if (!okCase) bad++;
      console.log(`${okCase ? "ok" : "FAIL"} self-test ${d.id}: ${d.about} -> H0 ${res.rc === 0 ? "passed" : "failed"} (parts failing: ${failed.join(", ") || "none"}; expected ${d.expect.join(", ") || "none"})`);
      if (!okCase) console.log(res.out.split("\n").filter(l => /FAIL|skip/.test(l)).slice(0, 12).map(l => "   " + l).join("\n") + (res.err ? "\n   " + res.err.split("\n").slice(-5).join("\n   ") : ""));
    } finally { rmSync(T, {recursive: true, force: true}); }
  }
  const seeded = DEFECTS.filter(d => d.expect.length).length;
  console.log(`\nself-test: ${seeded} seeded defects + control, ${bad ? `${bad} FAILED` : "every defect fails H0 and the control passes"}`);
  return bad;
}

/* ================================================================ main */
if (has("--update")) {
  const note = (process.env.HERO_CHANGE_NOTE || "").trim();
  if (!note) { console.error("refusing --update: set HERO_CHANGE_NOTE to say why the hero is allowed to change (DESIGN_tierA section 1, H0)"); process.exit(2); }
  if (resolve(ROOT) !== resolve(DEFAULT_ROOT)) { console.error("refusing --update with --root: the snapshot is of the repository page"); process.exit(2); }
  const snap = await compute(ROOT, {dom: !NO_DOM});
  if (snap.dom.error) { console.error("refusing --update: " + snap.dom.error); process.exit(2); }
  for (const k of PARTS) if (k !== "dom" && snap[k] && snap[k].json && snap[k].json.rc) { console.error(`refusing --update: ${k} could not be computed`); process.exit(2); }
  if (snap.dom.skipped && !readFix("manifest.json")) console.log("note: dom part skipped; the snapshot has no dom digest until --update runs with a browser");
  const m = writeFixtures(snap, note);
  console.log(`wrote tests/fixtures/hero_v2 (${Object.entries(m.parts).map(([k, v]) => `${k} ${v ? v.slice(0, 12) : "-"}`).join(", ")}); note: ${note}`);
  process.exit(0);
}
if (has("--self-test")) process.exit(await selfTest({dom: !NO_DOM}) ? 1 : 0);
const r = await check(ROOT, {dom: !NO_DOM});
if (val("--json")) {
  const failed = PARTS.filter(k => r.dg && r.dg[k] && readFix("manifest.json") && readFix("manifest.json").parts[k] && r.dg[k] !== readFix("manifest.json").parts[k]);
  writeFileSync(val("--json"), JSON.stringify({failed, partial: r.partial || [], digests: r.dg || {}}) + "\n");
}
process.exit(r.fails ? 1 : 0);
