// v2 shell layout: layout classes, bands, the collision solver and the node G1 matrix (DESIGN_final §3.3, §4 G1/G2/G12, §5.6).
// node tests/js/story_layout.mjs [--quick]   (no browser; run_all.mjs picks it up)
//
// 1. every point of the G1 matrix (and a dense sweep) maps to exactly one layout class; the named examples hold
// 2. bands sit inside the viewport and never intersect, for every class × dock state × text side
// 3. randomized rect sets: placed boxes never overlap; a hidden item is blocked only by items of priority ≥ its own (or by
//    its band, the viewport or a corridor); variants below 12 px are never used; one kinetic group per band; children stay
//    inside their container; corridors are respected
// 4. node G1 full matrix: 9 viewports × 5 zooms (+ 683×512, 260×563) × 160 p × motion/reduced over the real frame composer
//    (hud.frameItems): 0 overlaps > 4 px², 0 boxes outside the viewport, 0 non-children over the dock, 0 text < 12 px, every
//    beat's display text placed, ≤ 4 chrome elements in flight (G12)
// Inputs: ROOT/beats.json and ROOT/copy.json when they exist (U_motion, U_copy); otherwise the fixture below, which follows the
// DESIGN §3 beat table with the DESIGN_final §3.5 amendments. Equation and dock-label sizes are representative until U_eq and
// U_spec register theirs; world anchors move along a projected line (the real camera projections arrive with U_motion's G3).

import fs from "node:fs";
import path from "node:path";
import {fileURLToPath, pathToFileURL} from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url)), REPO = path.resolve(HERE, "../..");
const ROOT = path.join(REPO, "docs/tng50/learn/how-a-spectrum-is-made");
const imp = p => import(pathToFileURL(path.join(ROOT, p)).href);
const LC = await imp("js/ui/layoutclass.js"), L = await imp("js/ui/layout.js"), K = await imp("js/ui/kinetic.js");
const HUD = await imp("js/ui/hud.js"), RAIL = await imp("js/ui/rail.js"), PL = await imp("js/ui/plaque.js");
const NAR = await imp("js/ui/narrative.js");
const QUICK = process.argv.includes("--quick");

let fails = 0, n = 0;
const ok = (c, msg) => { n++; if (c) { if (!QUIET) console.log("ok " + msg); } else { fails++; console.log("FAIL " + msg); } };
let QUIET = false;
const area = (a, b) => { const w = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x), h = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y); return w > 0 && h > 0 ? w * h : 0; };
const inside = (r, c, e = 0.5) => r.x >= c.x - e && r.y >= c.y - e && r.x + r.w <= c.x + c.w + e && r.y + r.h <= c.y + c.h + e;
function rng(seed) { let s = seed >>> 0; return () => { s = (s + 0x6D2B79F5) >>> 0; let t = s; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }

/* ================================================================ 1. classes */
const EXTRA = [[683, 512], [260, 563]];
const matrix = [...LC.g1Matrix(), ...EXTRA.map(([w, h]) => ({vw: w, vh: h, zoom: 1, w, h}))];
{
  let bad = [];
  for (const m of matrix) { const r = LC.matchingRules(m.w, m.h); if (!r.length) bad.push(`${m.w}x${m.h}`); }
  ok(!bad.length, `every G1 matrix point matches a rule (${matrix.length} points)` + (bad.length ? ": " + bad.join(" ") : ""));
  let gaps = 0;
  for (let w = 200; w <= 3200; w += 7) for (let h = 200; h <= 2200; h += 7) if (!LC.matchingRules(w, h).length) gaps++;
  ok(gaps === 0, `dense sweep 200-3200 × 200-2200: no point without a class (${gaps})`);
  const ex = {"844x390": "phoneLandscape", "683x512": "compact", "260x563": "narrow", "768x1024": "tablet", "1366x768": "desktop",
              "1440x900": "desktop", "960x600": "compact", "390x844": "phonePortrait", "2560x1440": "desktop", "1024x768": "desktop",
              "1280x720": "desktop", "512x682": "tablet", "354x767": "phonePortrait"};
  for (const [k, want] of Object.entries(ex)) { const [w, h] = k.split("x").map(Number); ok(LC.layoutClass(w, h) === want, `class ${k} = ${want} (got ${LC.layoutClass(w, h)})`); }
  const seen = {};
  for (const m of matrix) seen[LC.layoutClass(m.w, m.h)] = (seen[LC.layoutClass(m.w, m.h)] || 0) + 1;
  ok(Object.keys(seen).length === 6, "the matrix exercises all six classes " + JSON.stringify(seen));
}

/* ================================================================ 2. bands */
{
  const names = ["hud", "text", "eq", "world", "dock", "rail"];        // "act" overlaps text/world by design (priority decides)
  let bad = [], cnt = 0;
  for (const m of matrix) for (const dock of ["strip", "pair", "hero"]) for (const side of ["left", "right"]) for (const ins of [null, {top: 47, bottom: 34, left: 0, right: 0}]) {
    const cls = LC.layoutClass(m.w, m.h);
    const B = LC.computeBands(cls, m.w, m.h, {dock, textSide: side, insets: ins || undefined});
    cnt++;
    for (const k of names) { const r = B[k]; if (r && !inside(r, {x: 0, y: 0, w: m.w, h: m.h})) bad.push(`${cls} ${m.w}x${m.h} ${dock} ${k} outside`); }
    for (let i = 0; i < names.length; i++) for (let j = i + 1; j < names.length; j++) {
      const a = B[names[i]], b = B[names[j]];
      if (a && b && area(a, b) > 0.5) bad.push(`${cls} ${m.w}x${m.h} ${dock}/${side}: ${names[i]} ∩ ${names[j]} = ${area(a, b).toFixed(0)}`);
    }
    if (!B.text) bad.push(`${cls} ${m.w}x${m.h} ${dock}: no text band`);
    if (B.rail.h < 44) bad.push(`${cls} ${m.w}x${m.h}: rail < 44 px (the Fly button is a 44 px target)`);
    if (ins && B.hud && B.hud.y + B.hud.h < 47 + 44) bad.push(`${cls} ${m.w}x${m.h}: HUD ignores the top inset`);
    if (ins && B.rail.y + B.rail.h > m.h - 34 + 0.5) bad.push(`${cls} ${m.w}x${m.h}: rail under the home indicator`);
  }
  ok(!bad.length, `bands inside the viewport and disjoint (${cnt} layouts)` + (bad.length ? "\n   " + bad.slice(0, 12).join("\n   ") : ""));
}

/* ================================================================ 3. solver properties */
{
  const R = rng(20261112);
  const kinds = ["display", "plaque", "eq", "chip", "tag"];
  let overl = 0, prioBad = 0, floorBad = 0, groupBad = 0, childBad = 0, corrBad = 0, trials = QUICK ? 300 : 2000, hiddenTot = 0, placedTot = 0;
  for (let t = 0; t < trials; t++) {
    const W = 300 + Math.floor(R() * 1800), Ht = 300 + Math.floor(R() * 1100);
    const bands = {text: {x: W * 0.05, y: Ht * 0.1, w: W * 0.4, h: Ht * 0.3}, world: {x: W * 0.45, y: Ht * 0.1, w: W * 0.5, h: Ht * 0.6}, eq: {x: W * 0.05, y: Ht * 0.42, w: W * 0.4, h: Ht * 0.2}};
    const items = [{id: "hud", kind: "hud", priority: 100, rect: {x: 0, y: 0, w: W, h: 50}}, {id: "dock", kind: "dock", priority: 90, rect: {x: 10, y: Ht * 0.75, w: W - 20, h: Ht * 0.2}}];
    const nk = 3 + Math.floor(R() * 25);
    for (let i = 0; i < nk; i++) {
      const kind = kinds[Math.floor(R() * kinds.length)], w = 20 + R() * 300, h = 12 + R() * 120;
      const it = {id: "i" + i, kind, priority: Math.floor(R() * 80)};
      const mode = R();
      if (mode < 0.15) { it.container = "dock"; it.size = {w: Math.min(w, W - 30), h: Math.min(h, Ht * 0.18)}; }
      else if (mode < 0.55) { it.anchor = {x: R() * W, y: R() * Ht}; it.size = {w, h}; it.band = R() < 0.5 ? "world" : null; it.fallback = "band"; }
      else { it.band = ["text", "world", "eq"][Math.floor(R() * 3)]; it.variants = [{w, h, font: 8 + Math.floor(R() * 10)}, {w: w * 0.7, h: h * 0.7, font: 12 + Math.floor(R() * 4)}]; }
      if (R() < 0.2) { it.group = "g" + Math.floor(R() * 3); it.band = "text"; it.opacity = R(); delete it.anchor; delete it.container; }
      items.push(it);
    }
    const corridors = R() < 0.5 ? [{a: [0, R() * Ht], b: [W, R() * Ht], r: 12}] : [];
    const out = L.solve(items, {w: W, h: Ht, bands, corridors});
    placedTot += out.placed.length; hiddenTot += out.hidden.length;
    overl += L.overlaps(out.placed, {w: W, h: Ht, tol: 0}).length;
    for (const b of out.placed) {
      const it = items.find(x => x.id === b.id);
      if (it.variants && it.variants[b.variant] === undefined) floorBad++;
      if (it.variants) { const usable = it.variants.filter(v => v.font >= 12); if (usable[b.variant] && usable[b.variant].font < 12) floorBad++; }
      if (it.container && !inside(b, out.byId[it.container])) childBad++;
      if (!it.rect && it.avoid !== false) for (const c of corridors) if (L.segmentHitsRect(c.a, c.b, c.r, b)) corrBad++;
    }
    const gb = {};
    for (const b of out.placed) if (b.group) { (gb[b.band] = gb[b.band] || new Set()).add(b.group); }
    for (const k in gb) if (gb[k].size > 1) groupBad++;
    // priority: re-solving with only the items of priority ≥ a hidden item's (no-room reason) must hide it too
    for (const h of out.hidden.filter(x => x.reason === "no-room").slice(0, 2)) {
      const it = items.find(x => x.id === h.id);
      if (it.group) continue;                              // group winners are a separate rule (tested below)
      // group winners are chosen over all items before placement, so every group item stays in the subset
      const sub = items.filter(x => x.group || (x.priority || 0) > (it.priority || 0) || x === it || ((x.priority || 0) === (it.priority || 0) && items.indexOf(x) < items.indexOf(it)));
      const o2 = L.solve(sub, {w: W, h: Ht, bands, corridors});
      if (o2.byId[it.id]) prioBad++;
    }
  }
  ok(overl === 0, `randomized solver: 0 overlaps in ${trials} sets (${placedTot} placed, ${hiddenTot} hidden)`);
  ok(prioBad === 0, `a hidden item is blocked only by items of equal or higher priority (${prioBad} violations)`);
  ok(floorBad === 0, `no variant below 12 px is ever used (${floorBad})`);
  ok(groupBad === 0, `one kinetic group per band (${groupBad})`);
  ok(childBad === 0, `children stay inside their container (${childBad})`);
  ok(corrBad === 0, `no placed label crosses a corridor (${corrBad})`);
}
{
  // targeted cases
  const ctx = {w: 400, h: 300, bands: {text: {x: 0, y: 0, w: 400, h: 100}}};
  const a = L.solve([{id: "a", priority: 70, band: "text", variants: [{w: 300, h: 40, font: 11}]}], ctx);
  ok(!a.byId.a && a.hidden[0].reason === "below-floor", "an item whose only variant is 11 px hides (never shrinks below 12 px)");
  const b = L.solve([{id: "a", priority: 70, band: "text", variants: [{w: 500, h: 40, font: 20}, {w: 300, h: 40, font: 14}]}], ctx);
  ok(b.byId.a && b.byId.a.variant === 1, "a too-wide variant falls back to the next one");
  const c = L.solve([{id: "x", priority: 70, band: "text", group: "g1", opacity: 0.5, size: {w: 50, h: 20}},
                     {id: "y", priority: 70, band: "text", group: "g2", opacity: 0.9, size: {w: 50, h: 20}},
                     {id: "z", priority: 70, band: "text", group: "g3", opacity: 0.01, size: {w: 50, h: 20}}], ctx);
  ok(c.byId.y && !c.byId.x && !c.byId.z && c.hidden.find(h => h.id === "z").reason === "invisible", "the most opaque group wins its band; < 0.02 opacity is invisible");
  const d = L.solve([{id: "p", priority: 60, anchor: {x: 200, y: 150}, size: {w: 80, h: 40}, gap: 10, candidates: ["e", "w"]}],
                    {w: 400, h: 300, corridors: [{a: [200, 0], b: [400, 300], r: 12}]});
  ok(d.byId.p && d.byId.p.cand === "w", "the plaque leaves the beam corridor (east blocked, west used)");
  const e = L.solve([{id: "dock", priority: 90, rect: {x: 0, y: 200, w: 400, h: 100}}, {id: "lab", priority: 88, container: "dock", size: {w: 60, h: 14}},
                     {id: "t", priority: 30, anchor: {x: 200, y: 210}, size: {w: 60, h: 20}, candidates: ["s"]}], {w: 400, h: 300});
  ok(e.byId.lab && inside(e.byId.lab, e.byId.dock) && !e.byId.t, "dock labels sit inside the dock; other labels never over it");
  ok(L.overlaps([{id: "a", x: 0, y: 0, w: 10, h: 10}, {id: "b", x: 8, y: 8, w: 10, h: 10}]).length === 0 &&
     L.overlaps([{id: "a", x: 0, y: 0, w: 10, h: 10}, {id: "b", x: 7, y: 7, w: 10, h: 10}]).length === 1, "overlaps() tolerates ≤ 4 px² and flags 9 px²");
  const nb = L.solve([{id: "e", priority: 50, band: "eq", size: {w: 10, h: 10}}], {w: 400, h: 300, bands: {eq: null}});
  ok(!nb.byId.e && nb.hidden[0].reason === "no-band", "an item whose band this layout lacks hides (never falls back to the viewport)");
  // purity: same input, same output, input untouched
  const items = [{id: "a", priority: 1, band: "text", size: {w: 10, h: 10}}];
  const snap = JSON.stringify(items), o1 = JSON.stringify(L.solve(items, ctx)), o2 = JSON.stringify(L.solve(items, ctx));
  ok(o1 === o2 && JSON.stringify(items) === snap, "solve() is deterministic and does not mutate its input");
  const src = fs.readFileSync(path.join(ROOT, "js/ui/layout.js"), "utf8") + fs.readFileSync(path.join(ROOT, "js/ui/layoutclass.js"), "utf8");
  ok(!/document\.|window\.|getBoundingClientRect|Math\.random|Date\.now|performance\./.test(src.replace(/\/\/.*$/gm, "")), "layout.js and layoutclass.js read no DOM, time or randomness");
}

/* ================================================================ text model */
{
  const t = LC.typeScale("desktop", 1440, 900);
  ok(t.display[0] === 56 && t.display[1] === 44 && t.display[2] === 34 && t.sub === 17, "type scale at 1440×900: 56/44/34, sub 17");
  const tn = LC.typeScale("narrow", 260, 563);
  ok(tn.display.every(v => v >= 22) && tn.sub >= 14 && tn.mono >= 12 && tn.wordsPerLine === 5, "narrow: display floor 22 px, sub ≥ 14, mono ≥ 12, 5 words per line");
  const m = K.groupModel({display: "Each cell leaves a *shadow.*", sub: "Atoms take a sliver of colour out of the light."}, {x: 0, y: 0, w: 520, h: 300}, t, 1);
  ok(m.variants.length > 0 && m.variants[0].hasSub && m.variants[0].dpx === 44, "groupModel: first variant is the full copy at the beat size");
  ok(/<em>shadow\.<\/em>/.test(m.variants[0].html), "accent markup becomes an italic span");
  // a variant taller than its band is never registered smaller than it is drawn (exit-scale clamp only limits growth)
  const tb = {x: 0, y: 0, w: 300, h: 50, cls: "desktop"};
  const big = K.kineticItems([{id: "x", band: "text", phase: 0.8}], () => ({variants: [{w: 200, h: 80, dpx: 30, font: 30, key: "k"}]}), {bands: {text: tb, cls: "desktop"}});
  ok(big[0].variants[0].h >= 80 && big[0].variants[0].w >= 200, "kineticItems never registers a box smaller than the drawn variant");
  ok(K.focusStyle(-1).opacity === 0 && K.focusStyle(0).opacity === 1 && K.focusStyle(0.98).opacity === 0 && Math.abs(K.focusStyle(0.97).scale - 1.06) < 1e-9,
     "focus curve: 0 before, 1 in focus, < 0.02 at exit, exit scale 1.06");
  ok(K.focusStyle(0.2, true).rise === 0 && K.focusStyle(0.7, true).opacity === 0, "reduced motion: stepped (no rise, no fade)");
  // fix1 r4 (review1 scrolly S3): the act-title depth cue is entry-only. Every readPoint lies inside its line's window
  // (tl.phase = 0 there), and from phase -0.35 on (focusStyle opacity 1) the title is crisp and full size at any depth.
  {
    const far = K.depthCue(500), ph = [-0.35, -0.2, 0, 0.3, 0.6, 0.9];
    ok(far.soft === 0.5 && K.depthCueAt(far, -1).soft === 0.5 && ph.every(x => K.depthCueAt(far, x) === null) && K.focusStyle(0).sharp === 1,
       "depth cue: full on entry, none in the full-opacity window (readPoints draw sharp 1.00 at scale 1)");
  }
  ok(RAIL.odometerText(212.4) === "212 kpc travelled" && !/[·•]/.test(RAIL.odometerText(5)), "odometer is one line, no dot separators");
  ok(PL.plaqueLines({nH: 1.2e-3, T: 1.15e4, v: -51.6, f: 0.2, ion: "O VI"}).every(l => !/[·•]/.test(l.v)), "plaque values carry no dot separators");
  // fix1 r4 (review1 beauty H3): the plaque follows its ring. One frame with a blocker beside the ring may push it to a band
  // slot, but never one covering the ring or farther than PLAQUE_MAX_DIST, and once the ring moves it returns to an offset.
  {
    const lines = PL.plaqueLines({nH: 1.2e-3, T: 2.87e5, v: 40, f: 0.12, ion: "O VI"}), world = {x: 640, y: 80, w: 760, h: 760};
    const seq = [[{x: 1165, y: 490}, {x: 800, y: 470, w: 340, h: 300}], [{x: 1250, y: 300}], [{x: 1200, y: 420}], [{x: 1165, y: 490}], [{x: 1150, y: 545}], [{x: 1100, y: 600}]];
    let prev = null, far = 0, cover = 0, band = 0;
    const bd = (b, a) => Math.hypot(Math.max(b.x - a.x, 0, a.x - (b.x + b.w)), Math.max(b.y - a.y, 0, a.y - (b.y + b.h)));
    seq.forEach(([a, blk], i) => {
      const it = PL.plaqueItem(lines, a, {mono: 14}), items = blk ? [{id: "b", priority: 90, rect: blk}, it] : [it];
      const r = L.solve(items, {w: 1440, h: 900, bands: {world}, prev}), p = r.placed.find(b => b.id === "plaque");
      if (p) { const d = bd(p, a); if (d > PL.PLAQUE_MAX_DIST) far++; if (d < 10) cover++; if (i > 0 && p.cand === "band") band++; }
      prev = Object.fromEntries(r.placed.map(b => [b.id, b]));
    });
    ok(!far && !cover && !band, `plaque stays beside its ring (${far} far, ${cover} over the ring, ${band} parked in the band after the blocker left)`);
  }
  const items = NAR.narrativeItems([{id: "B1", p0: 0.02}], {B1: {display: "This light left a *quasar* long ago.", narrative: "Story {{n_kernels}} cells."}}, {keys: {n_kernels: 672}});
  ok(items[0].text === "Story 672 cells." && items[0].title === "This light left a quasar long ago.", "narrative templates resolve against data keys; accents stripped");
}

/* ================================================================ 4. node G1 full matrix */
const FIX_BEATS_RAW = [
  ["B0", 0.000, 0.020, "strip", "left"], ["B1", 0.020, 0.045, "strip", "left"], ["B2", 0.045, 0.100, "strip", "left"],
  ["B3", 0.100, 0.165, "strip", "left"], ["B4", 0.165, 0.205, "strip", "left"], ["B5", 0.205, 0.300, "pair", "left"],
  ["B6", 0.300, 0.385, "strip", "left"], ["B7a", 0.385, 0.410, "strip", "left"], ["B7b", 0.410, 0.460, "pair", "left", 4],
  ["B7c", 0.460, 0.480, "pair", "left"], ["B7d", 0.480, 0.520, "pair", "left"], ["B7e", 0.520, 0.545, "pair", "left"],
  ["B8", 0.545, 0.580, "strip", "left"], ["B9", 0.580, 0.700, "pair", "right"], ["B10", 0.700, 0.785, "pair", "left"],
  ["B11", 0.785, 0.845, "pair", "right"], ["B12a", 0.845, 0.880, "hero", "left"], ["B12b", 0.880, 0.920, "hero", "left"],
  ["B13", 0.920, 0.975, "hero", "left"], ["B14", 0.975, 1.000, "hero", "left"],
 ].map(([id, p0, p1, dock, textSide, stops]) => ({id, p0, p1, dock, textSide, stops: stops || 0, copyRef: id,
   text: [{id, band: HUD.ACT_TITLE_BEATS.includes(id) ? "act" : "text", part: "all", u0: 0.15, u1: 0.8}]}));
const FIX_BEATS = FIX_BEATS_RAW;
const FIX_COPY = {
  B0: {display: "How a spectrum is made", display_short: "How a spectrum is made", sub: "Hold to ride the light.", sub_short: "Hold to ride."},
  B1: {display: "This light left a quasar long ago.", display_short: "Light left a quasar.", sub: "Something stood in its way.", sub_short: "Something stood in its way."},
  B2: {display: "Galaxies sit inside gas *too faint to see.*", display_short: "Gas *too faint to see.*", sub: "It shows itself only by the light it takes from things behind it.", sub_short: "It shows only by stolen light."},
  B3: {display: "Every cell has a density, heat and speed.", display_short: "Density, heat and speed.", sub: "So far, almost nothing is taken.", sub_short: "Almost nothing is taken."},
  B4: {display: "Each cell leaves a *shadow.*", display_short: "Each cell leaves a *shadow.*", sub: "Atoms take a sliver of colour out of the light, at the speed the cell moves.", sub_short: "Atoms take a sliver of colour."},
  B5: {display: "A cool clump: *one hydrogen atom in ten keeps its electron.*", display_short: "A cool clump.", sub: "One clump, and the dip is black.", sub_short: "One clump, a black dip."},
  B6: {display: "Here the gas is too hot to see.", display_short: "Too hot to see.", sub: "Where a dip sits *means speed.*", sub_short: "Where a dip sits means speed."},
  B7a: {display: "Cloud B", display_short: "Cloud B"},
  B7b: {display: "Amount sets how much light is taken.", display_short: "Amount sets the depth.", sub: "*Heat spreads it out.* This single cell holds a quarter of all the oxygen six on the beam.", sub_short: "Heat spreads it out."},
  B7c: {display: "Too hot: oxygen loses another electron.", display_short: "Too hot: oxygen ionises.", sub: "Too cool: oxygen keeps more electrons. Density and metals held fixed.", sub_short: "Too cool keeps electrons."},
  B7d: {display: "One cloud, many speeds, a wide dip.", display_short: "Many speeds, wide dip.", sub: "Optical depths add; transmissions multiply.", sub_short: "Depths add up."},
  B7e: {display: "Cold knot", display_short: "Cold knot", sub: "Same place, different gas, different speed.", sub_short: "Same place, different speed."},
  B8: {display: "Halfway.", display_short: "Halfway.", sub: "The galaxy's centre is 200 000 light-years to the side. Being closest does not mean the most gas.", sub_short: "Closest is not most gas."},
  B9: {display: "Far apart, same speed, *same dip.*", display_short: "Same speed, *same dip.*", sub: "Two pieces of gas far apart along the beam fall into one dip. The spectrum keeps speed and loses place.", sub_short: "Speed kept, place lost."},
  B10: {display: "More gas, deeper dip.", display_short: "More gas, deeper dip.", sub: "Once black, *only wider.*", sub_short: "Once black, only wider."},
  B11: {display: "This is everything *the light carried out.*", display_short: "Everything *the light carried.*", sub: "Dozens of small shadows, merged into a few dips.", sub_short: "Many shadows, few dips."},
  B12a: {display: "A blurry telescope *merges dips.*", display_short: "Blur *merges dips.*", sub: "Blur turns narrow black dips grey.", sub_short: "Narrow black dips turn grey."},
  B12b: {display: "Longer exposures beat noise.", display_short: "Exposure beats noise.", sub: "Noise can hide dips, *and invent them.*", sub_short: "Noise hides and invents dips."},
  B13: {display: "We fit a few *components.*", display_short: "We fit *components.*", sub: "Components are not clouds, and clouds are not cells.", sub_short: "Components are not clouds."},
  B14: {display: "Now it is yours.", display_short: "Now it is yours.", sub: "Same galaxy, same beam.", sub_short: "Same galaxy, same beam."},
};
const readJson = f => (fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, "utf8")) : null);
const realBeats = readJson(path.join(ROOT, "beats.json")), realCopy = readJson(path.join(ROOT, "copy.json"));
const BEATS = Array.isArray(realBeats) ? realBeats : (realBeats && realBeats.beats) || FIX_BEATS;
const COPY = realCopy && typeof realCopy === "object" ? (realCopy.beats || realCopy) : FIX_COPY;
console.log(`# G1 inputs: beats ${realBeats ? "ROOT/beats.json" : "fixture"} (${BEATS.length}), copy ${realCopy ? "ROOT/copy.json" : "fixture"}`);

/* a FrameState stand-in at p (U_motion's seek replaces it once it lands): beat, dock keyframes, text entries from the
   beat's u-windows (fade over 0.06 u either side; fadeIn/fadeOut 0 = hard), default branch of conditional entries, a
   simulated projection for act-title anchors, the TF mix, stops */
const keyAt = (v, u, f) => (Array.isArray(v) ? v.filter(k => k.u <= u + 1e-9).slice(-1)[0]?.[f] ?? v[0][f] : v);
function frameAt(p) {
  let i = BEATS.findIndex(b => p >= b.p0 && p < b.p1); if (i < 0) i = BEATS.length - 1;
  const b = BEATS[i], u = (p - b.p0) / Math.max(1e-9, b.p1 - b.p0), e = 0.06;
  const text = [];
  for (const t of b.text || [{id: b.copyRef || b.id, band: "text", u0: 0.15, u1: 0.8}]) {
    if (t.when && t.when !== "default") continue;
    let ph = u < t.u0 ? (t.fadeIn === 0 ? -1 : Math.max(-1, (u - t.u0) / e)) : u > t.u1 ? (t.fadeOut === 0 ? 1 : Math.min(1, (u - t.u1) / e)) : 0;
    if (t.fadeIn === 0 && u >= t.u0 && u <= t.u1) ph = 0;
    if (Math.abs(ph) >= 1) continue;
    text.push({id: t.id, band: t.band || "text", part: t.part || "all", phase: ph, anchor: t.anchor || null, simU: u});
  }
  const st = b.stop || (b.stops ? {n: b.stops} : null);
  const stop = st && st.n ? {k: 1 + Math.min(st.n - 1, Math.floor(u * st.n)), n: st.n} : null;
  const tfs = Array.isArray(b.tf) ? b.tf : null;
  const tfA = tfs ? keyAt(tfs, u, "preset") : "density", nxt = tfs ? (tfs.find(k => k.u > u) || tfs[tfs.length - 1]) : null;
  const prev = tfs ? tfs.filter(k => k.u <= u).slice(-1)[0] || tfs[0] : null;
  const mix = prev && nxt && nxt.preset !== prev.preset && nxt.u > prev.u ? (u - prev.u) / (nxt.u - prev.u) : 0;
  return {p, beat: {id: b.id, i, u, stop}, l: -246 + 492 * p, spec: {dock: keyAt(b.dock || "strip", u, "state")},
          cam: {textSide: b.textSide || keyAt(b.cam && b.cam.textSide, u, "v") || "left"},
          tf: {from: prev ? prev.preset : tfA, to: nxt ? nxt.preset : tfA, mix}, text};
}

/* real inputs when they exist: U_motion's seek + prepare (camera projection, beam corridor, act anchors), the story data
   (keys, flags), copy.json's derived keys (U_copy's deriveKeys), U_eq's plan (eq.json) and U_qa's browser size table */
const shotsDoc = readJson(path.join(ROOT, "shots.json")), EQ = readJson(path.join(ROOT, "eq/eq.json"));
const dataF = fs.existsSync(path.join(ROOT, "data")) ? fs.readdirSync(path.join(ROOT, "data")).filter(f => /^story_\d+_.*\.json$/.test(f)).sort()[0] : null;
const DATA = dataF ? readJson(path.join(ROOT, "data", dataF)) : null;
const SIZES = readJson(process.env.STORY_SIZES || path.join(REPO, "tests/js/fixtures/story_qa/sizes.json"));
let realSeek = null, PREP = null, LOOKUP = null;
if (realBeats && shotsDoc && DATA && fs.existsSync(path.join(ROOT, "js/core/seek.js"))) {
  const SK = await imp("js/core/seek.js");
  realSeek = SK.makeSeek({beats: realBeats, shots: shotsDoc}); PREP = SK.prepare(DATA, realBeats, shotsDoc);
}
if (DATA && realCopy) {
  let derived = {};
  try { const CL = await import(pathToFileURL(path.join(REPO, "tests/js/story_copy_lint.mjs")).href); derived = CL.deriveKeys(realCopy, DATA) || {}; } catch (e) { console.log("# deriveKeys unavailable: " + e.message); }
  LOOKUP = {keys: {...(DATA.keys || {}), ...Object.fromEntries(Object.entries(derived).filter(([, v]) => v != null))}};
}
const FLAGS = (DATA && DATA.flags) || {};
const STORY = {beats: BEATS, copy: COPY, lookup: LOOKUP, flags: FLAGS, eq: EQ};
console.log(`# G1 frames: ${realSeek ? "U_motion seek + real camera projection" : "stand-in frames"}; copy resolved ${LOOKUP ? "against data keys + derived keys" : "unresolved"}; ` +
  `flags ${DATA && DATA.flags ? JSON.stringify(FLAGS) : "absent (all false)"}; eq ${EQ ? "U_eq plan" : "fixture"}; sizes ${SIZES ? "browser table" : "representative"}`);

/* ---------------------------------------------------------------- phase 1 units */
{
  const T = [{id: "B13", band: "text"}, {id: "B13.3", band: "text"}, {id: "B13.4", band: "text", cond: "has_invented", alt: true}, {id: "B4", band: "text", cond: "has_first_ovi"}];
  ok(HUD.activeText(T, {has_invented: true}).map(t => t.id).join() === "B13,B13.4", "activeText: an alt slot replaces the previous slot of its band when its flag holds; a cond slot without its flag hides");
  ok(HUD.activeText(T, {}).map(t => t.id).join() === "B13,B13.3", "activeText: missing flags count as false (conservative branch)");
  const C = {B5: {display: "A cool clump.", then: [{id: "B5.2", display: "One clump.", sub: "Black.", sub_short: "Black.", extra: {when: "has_ovi_skin", sub: "Skin adds O VI."}}]}};
  ok(K.copyEntry(C, "B5.0") === C.B5, "copyEntry: B5.0 is the beat's entry line");
  ok(K.copyEntry(C, "B5.2", {has_ovi_skin: true}).sub === "Black. Skin adds O VI." && K.copyEntry(C, "B5.2", {}).sub === "Black.", "copyEntry: extra is appended to sub only when its flag holds");
  ok(K.copyEntry(C, "B5.2", {has_ovi_skin: true}).sub_short === "Black.", "copyEntry: short variants never take the extra");
  let eqMin = Infinity; for (const m of matrix) eqMin = Math.min(eqMin, LC.typeScale(LC.layoutClass(m.w, m.h), m.w, m.h).eq);
  ok(eqMin >= 17, `typeScale: equation font ≥ 17 px everywhere (U_eq: no KaTeX glyph < 12 px) (min ${eqMin})`);
  const css = ["css/story2.css", "css/story.css"].map(f => fs.readFileSync(path.join(ROOT, f), "utf8")).join("\n").replace(/\/\*[\s\S]*?\*\//g, "");
  ok(!/backdrop-filter\s*:/.test(css), "S0: no backdrop-filter in the shell CSS (HUD pills solid)");
  const html = fs.readFileSync(path.join(ROOT, "index.html"), "utf8");
  ok(/<ol[^>]*id="narrative"[^>]*data-narrative|<ol[^>]*data-narrative[^>]*id="narrative"/.test(html), "index.html: the narrative list carries data-narrative (U_qa)");
  const MN = await imp("js/ui/menu.js");
  const kd = (key, o = {}) => ({key, target: {tagName: "DIV"}, ...o});
  ok(MN.keyAction(kd(" "), {watch: true}).action === "watchToggle" && MN.keyAction(kd(" "), {watch: false}) === null, "keys: Space is play/pause only while Watch runs; otherwise the clock's fly key");
  ok(["?", "f", "T", "r", "n", "g"].map(k => MN.keyAction(kd(k)).action).join() === "help,trail,tf,focusR,focusSN,grab", "keys: ? F T R N G map to help, trail, TF, R, S/N, grab (DESIGN §9.3)");
  ok(MN.keyAction(kd("Escape"), {grab: true}).action === "release" && MN.keyAction(kd("Escape"), {}) === null, "keys: Esc releases the camera only while grabbed (menus keep their own Esc)");
  ok(MN.keyAction(kd("f", {ctrlKey: true})) === null && MN.keyAction(kd("f", {target: {tagName: "INPUT"}})) === null && MN.keyAction(kd("ArrowRight")) === null,
    "keys: modified keys, typing in a field and the clock's own keys are not claimed");
  const gm = K.groupModel({display: "One in {{n}} keeps it.", sub: "About {{r}} times fewer."}, {x: 0, y: 0, w: 600, h: 300}, LC.typeScale("desktop", 1440, 900), 1, {keys: {n: "200 000", r: "20"}});
  ok(gm.variants[0].html.includes('<span data-key="n">200</span>') && gm.variants[0].html.includes('<span data-key="n">000</span>') && gm.variants[0].html.includes('<span data-key="r">20</span>'),
    "kinetic: digits from resolved keys render inside [data-key] (G10 DOM rule)");
  const PK = await imp("js/ui/picker.js");
  const IDX = {stories: [{galaxy: 488530, ray: "rand_b062_a062", label: "Subhalo 488530", eligible: true}, {galaxy: 411449, ray: "rand_b040_a120", eligible: false, reason: "no visible O VI cell on this beam"},
                         {galaxy: 488530, ray: "rand_b031_a334", eligible: true}]};
  const pm = PK.pickerModel(IDX, {galaxy: 488530, ray: "rand_b062_a062"});
  ok(pm.groups[0].galaxy === 488530 && pm.groups[0].rays[0].current && pm.groups[0].rays.length === 2 && pm.shown === 3, "picker: current galaxy first, current beam first, grouped by galaxy");
  ok(pm.groups[1].rays[0].eligible === false && /O VI/.test(pm.groups[1].rays[0].reason), "picker: ineligible beams are listed disabled with the data's reason");
  ok(PK.pickerModel(IDX, {}, "4114").shown === 1 && PK.pickerModel(IDX, {}, "zzz").groups.length === 0, "picker: search filters by galaxy id / label / ray");
  ok(PK.rayLabel("rand_b062_a062") === "impact 62 kpc, azimuth 62°" && PK.storyHref(488530, "rand_b062_a062") === "?g=488530&ray=rand_b062_a062", "picker: ray labels and story links (store.js grammar)");
  // phase-legend pill names: seek's tf.chip wins; "ion:HI" maps to the hi legend; halo has its own swatches
  {
    const cp = {ui: {tf: {hi: "H I", composite: "Phases and clouds"}}};
    const a = HUD.tfLegend({from: "ion:HI", to: "ion:HI", mix: 1, chip: "ion:HI"}, cp), b = HUD.tfLegend({from: "phases", to: "phases", mix: 1, chip: "composite"}, cp);
    const c = HUD.tfLegend({from: "density", to: "halo", mix: 0.7, chip: "halo"}, cp), d = HUD.tfLegend({from: "phases", to: "ion:OVI", mix: 0.6}, null);
    ok(a.id === "hi" && a.name === "H I" && b.name === "Phases and clouds" && c.id === "halo" && c.sw.length === 3 && d.id === "ovi" && !/ion:/.test(d.name),
       "phase legend: tf.chip first, ion: prefix stripped, halo legend exists (U_motion contract)");
  }
  {
    const sk = HUD.beatSkip({has_cold_knot: false, has_hot_stretch: true});
    ok(sk({id: "B7e", cond: "has_cold_knot"}) && !sk({id: "B6", cond: "has_hot_stretch"}) && !sk({id: "B5"}) && HUD.beatSkip({})({cond: "x"}),
       "beatSkip: false or missing flag skips a conditional beat (timeline.setSkip, U_motion contract)");
  }
  // S0 scrims (pure): column clustering, <= 2 rects, padded by the shader edge, clamped to the viewport
  {
    const P = (id, kind, x, y, w, h) => ({id, kind, x, y, w, h});
    const s1 = HUD.scrimRects({placed: [P("a", "display", 72, 81, 533, 200), P("b", "eq", 72, 320, 500, 200), P("r", "rail", 0, 860, 1440, 40)]}, 1440, 900);
    ok(s1.length === 1 && s1[0].x0 === +(72 / 1440 - 0.04).toFixed(4) && s1[0].y1 === +(520 / 900 + 0.04).toFixed(4) && s1[0].k === undefined,
       "scrims: text and equation in one column -> one padded rect, no k (stage's frozen 0.75 applies)");
    const sp = HUD.scrimRects({placed: [P("t", "display", 16, 92, 359, 100), P("c", "eq", 16, 500, 200, 53)]}, 390, 844);
    ok(sp.length === 2, "scrims: phone text at the top and its chip above the dock stay two rects (the beam between is not darkened)");
    const s2 = HUD.scrimRects({placed: [P("a", "display", 0, 0, 300, 100), P("b", "display", 1000, 0, 300, 100), P("c", "eq", 500, 600, 200, 100)]}, 1440, 900);
    ok(s2.length === 2 && s2[0].x0 === 0 && s2[0].y0 === 0, "scrims: three columns merge to two (least added area), clamped at 0");
    ok(HUD.scrimRects({placed: [P("d", "dock", 0, 700, 1440, 200)]}, 1440, 900).length === 0 && HUD.scrimRects(null, 1, 1).length === 0,
       "scrims: no text placed -> [] (stage falls back to its default band)");
    ok(HUD.scrimRects({placed: [P("a", "display", 10, 10, 10, 10)]}, 100, 100, {k: 0.6})[0].k === 0.6, "scrims: optional k override passes through");
  }
  // U_qa contract: itemsFor works with only fs + viewport (+ optional size table), returns solver items and ctx
  const fsMin = {p: 0.3, beat: {id: "B5", i: 5, u: 0.5}, l: -130, cam: null, spec: {dock: "pair"}, text: [], eqs: [{id: "E2", anchor: {kind: "cell", ref: 125}}], tf: null};
  const got = L.itemsFor(fsMin, {viewport: {w: 1440, h: 900, zoom: 1}, cls: "desktop", reduced: false});
  ok(Array.isArray(got.items) && got.items.length > 5 && got.ctx.bands && got.ctx.bands.text, "layout.itemsFor(fs, {viewport}) returns {items, ctx: {bands, corridors}} without story inputs (U_qa node G1)");
  const solved = L.solve(got.items, got.ctx);
  ok(L.overlaps(solved.placed, {w: 1440, h: 900, tol: 4}).length === 0 && solved.byId["eq:E2"], "itemsFor output solves without overlap; the equation is placed");
}

const MIN_FONT = 12;
let g1 = {pts: 0, overl: 0, outside: 0, overDock: 0, small: 0, dispHidden: 0, chrome: 0, groups: 0, chromeMissing: 0, g3: 0, corr: 0, actInTitle: 0}, examples = [];
const eqHidden = {}, eqSeen = {};
const ps = Array.from({length: 160}, (_, k) => (k + 0.5) / 160);
const hiddenByCls = {}, missingCopy = new Set();
const t0 = Date.now();
for (const m of matrix) {
  const cls = LC.layoutClass(m.w, m.h), type = LC.typeScale(cls, m.w, m.h);
  for (const reduced of [false, true]) for (const p of (QUICK ? ps.filter((_, k) => k % 4 === 0) : ps)) {
    const f = realSeek ? realSeek(p, DATA, {cls}) : frameAt(p);
    if (realSeek) {
      const got = HUD.itemsFor(f, {w: m.w, h: m.h, reduced, story: STORY, sizes: SIZES, prep: PREP});
      checkFrame(m, cls, p, f, got.items, got.ctx, reduced);
      continue;
    }
    const modelCache = {};
    const bands = LC.computeBands(cls, m.w, m.h, {dock: f.spec.dock, textSide: f.cam.textSide});
    const modelFor = t => { const k = `${K.textKey(t)}|${Math.round(bands.text.w)}`; if (!(k in modelCache)) modelCache[k] = K.groupModel(K.copyEntry(COPY, t.id), bands.text, type, t.band === "act" ? 0 : 1, null, t.part || "all"); return modelCache[k]; };
    // world anchor: the probe's projected cell walks across the world band; act anchors drift through the stage
    const wb = bands.world;
    for (const t of f.text) if (t.band === "act" && t.anchor && wb) t.screen = {x: wb.x + wb.w * (0.9 - 0.7 * t.simU), y: wb.y + wb.h * 0.3};
    const anchor = wb ? {x: wb.x + wb.w * (0.2 + 0.6 * ((p * 7) % 1)), y: wb.y + wb.h * (0.35 + 0.3 * ((p * 3) % 1))} : null;
    const beamY = wb ? wb.y + wb.h * 0.5 : m.h / 2;
    const corridors = wb ? [{a: [wb.x, beamY + 30], b: [wb.x + wb.w, beamY - 30], r: 12}] : [];   // shots keep the beam out of the text column (G3)
    const eqPx = type.eq, eqs = f.beat.id.startsWith("B7b") ? [1, 2, 3].map(k => ({id: "E" + k, size: {w: Math.round(eqPx * 13), h: Math.round(eqPx * 2.6), font: eqPx}}))
      : ["B3", "B4", "B5", "B6", "B10", "B12a", "B12b", "B13"].includes(f.beat.id) ? [{id: "E", size: {w: Math.round(eqPx * 11), h: Math.round(eqPx * 2.4), font: eqPx}}] : [];
    const dk = bands.dock, dockKids = dk ? [{id: "ion", rect: {x: dk.x + 8, y: dk.y + 6, w: 60, h: 16}}, {id: "axis", rect: {x: dk.x + dk.w - 140, y: dk.y + dk.h - 20, w: 132, h: 16}}] : [];
    const tags = wb ? [{id: "chip:A", anchor: {x: wb.x + wb.w * 0.3, y: wb.y + wb.h * 0.6}, size: {w: 70, h: 26, font: 12}}] : [];
    const env = {cls, bands, type, modelFor, act: HUD.actFor(BEATS, f.beat.i, COPY), legend: HUD.tfLegend(f.tf, COPY), hint: p < 0.02,
                 plaque: anchor && !reduced ? {lines: PL.plaqueLines({nH: 1.2e-3, T: 1.15e4, v: -51.6, f: 0.2, ion: "O VI"}), anchor} : null,
                 eqs, dockKids, tags, reduced, maxKpc: 493};
    const items = HUD.frameItems(f, env);
    checkFrame(m, cls, p, f, items, {w: m.w, h: m.h, bands, corridors}, reduced);
  }
}
function checkFrame(m, cls, p, f, items, sctx, reduced) {
  {
    const out = L.solve(items, sctx), bands = sctx.bands;
    g1.pts++;
    const ov = L.overlaps(out.placed, {w: m.w, h: m.h, tol: 4});
    const outsideN = ov.filter(o => o.b === "viewport").length;
    g1.outside += outsideN; g1.overl += ov.length - outsideN;
    if (ov.length && examples.length < 6) examples.push(`${m.w}x${m.h} ${cls} p=${p.toFixed(4)} ${JSON.stringify(ov.slice(0, 2))}`);
    const dockB = out.byId.dock;
    if (dockB) for (const b of out.placed) if (b.id !== "dock" && b.container !== "dock" && !b.exempt && area(b, dockB) > 4) g1.overDock++;
    for (const b of out.placed) { const it = items.find(x => x.id === b.id); const v = it.variants ? it.variants[b.variant] : it.size; if (v && v.font != null && v.font < MIN_FONT) g1.small++; }
    for (const it of items) if (it.kind === "eq") { const k = `${cls} ${it.id}`; eqSeen[k] = (eqSeen[k] || 0) + 1; if (!out.byId[it.id]) eqHidden[k] = (eqHidden[k] || 0) + 1; }
    for (const c of sctx.corridors || []) { g1.corr++; for (const b of out.placed) if ((b.kind === "display" || b.kind === "eq") && L.segmentHitsRect(c.a, c.b, c.r || 0, b)) {
      g1.g3++; if (examples.length < 14) examples.push(`G3: beam crosses ${b.id} ${m.w}x${m.h} ${cls} p=${p.toFixed(4)}`); } }
    for (const kt of HUD.activeText(f.text, FLAGS)) {
      const kid = "kt:" + K.textKey(kt), ktItem = items.find(x => x.id === kid), hid = out.hidden.find(h => h.id === kid);
      const ce = K.copyEntry(COPY, kt.id, FLAGS), hasPart = ce && ((kt.part === "sub") ? ce.sub : (kt.part === "display") ? ce.display : (ce.display || ce.sub));
      if (!ktItem) { if (hasPart) { g1.dispHidden++; hiddenByCls[cls] = (hiddenByCls[cls] || 0) + 1; if (examples.length < 14) examples.push(`no variant fits: ${m.w}x${m.h} ${cls} ${kid}`); } else missingCopy.add(kt.id + (ce ? "/" + kt.part : "")); continue; }
      if ((ktItem.opacity == null || ktItem.opacity >= 0.02) && !out.byId[kid] && hid && hid.reason !== "group") {
        g1.dispHidden++; hiddenByCls[cls] = (hiddenByCls[cls] || 0) + 1;
        if (examples.length < 14) examples.push(`display hidden: ${m.w}x${m.h} ${cls} ${kid} p=${p.toFixed(4)} reason=${hid.reason} variants=${ktItem.variants.length}` +
          (process.env.LAYOUT_DEBUG ? `\n     want ${JSON.stringify(ktItem.variants[0])} band ${JSON.stringify(bands[ktItem.band] || ktItem.band)}\n     placed ${out.placed.map(b => b.id + "[" + [b.x, b.y, b.w, b.h].map(Math.round) + "]").join(" ")}` : ""));
      }
    }
    // review2 ux H1: required items (the end actions) are placed whenever they are visible
    for (const it of items) if (it.required && (it.opacity == null || it.opacity >= 0.02)) { g1.reqN = (g1.reqN || 0) + 1;
      if (!out.byId[it.id]) { g1.reqMiss = (g1.reqMiss || 0) + 1; if (examples.length < 14) examples.push(`required ${it.id} hidden ${m.w}x${m.h} ${cls} p=${p.toFixed(4)} ${(out.hidden.find(h => h.id === it.id) || {}).reason}`); }
      else if (out.byId[it.id].overBeam) g1.reqOverBeam = (g1.reqOverBeam || 0) + 1; }
    for (const id of ["hud:act", "hud:menu", "rail", "rail:fly", "rail:track", "dock"]) if (!out.byId[id] && !(id === "hud:act" && HUD.actHidden(f))) { g1.chromeMissing++; if (examples.length < 14) examples.push(`chrome missing: ${id} ${m.w}x${m.h} ${cls} p=${p.toFixed(3)} ${(out.hidden.find(h => h.id === id) || {}).reason}`); }
    if (HUD.actHidden(f) && out.byId["hud:act"]) g1.actInTitle++;
    const inFlight = !HUD.phaseVisible(f);
    if (inFlight && p >= 0.02 && HUD.chromeCount(out) > 4) g1.chrome++;
  // S0 §4: the GL scrim (k 0.75) must sit under every placed text/equation box with the shader's full soft edge inside
  {
    const sr = HUD.scrimRects(out, m.w, m.h), E = HUD.SCRIM_EDGE - 1e-4;
    g1.scrimN = (g1.scrimN || 0) + 1;
    if (sr.length > 2) g1.scrimBad = (g1.scrimBad || 0) + 1;
    for (const b of out.placed) {
      if (b.kind !== "display" && b.kind !== "eq") continue;
      const x0 = b.x / m.w, y0 = b.y / m.h, x1 = (b.x + b.w) / m.w, y1 = (b.y + b.h) / m.h;
      const cov = sr.some(r => (r.x0 <= x0 - E || r.x0 === 0) && (r.y0 <= y0 - E || r.y0 === 0) && (r.x1 >= x1 + E || r.x1 === 1) && (r.y1 >= y1 + E || r.y1 === 1));
      if (!cov) { g1.scrimBad = (g1.scrimBad || 0) + 1; if (examples.length < 14) examples.push(`scrim misses ${b.id} ${m.w}x${m.h} ${cls} p=${p.toFixed(4)}`); }
    }
    const a = sr.reduce((s, r) => s + (r.x1 - r.x0) * (r.y1 - r.y0), 0);
    g1.scrimArea = Math.max(g1.scrimArea || 0, a); g1.scrimAreaSum = (g1.scrimAreaSum || 0) + a;
  }
    const gb = {};
    for (const b of out.placed) if (b.group) (gb[b.band] = gb[b.band] || new Set()).add(b.group);
    for (const k in gb) if (gb[k].size > 1) g1.groups++;
  }
}
console.log(`# G1 matrix: ${g1.pts} layouts in ${((Date.now() - t0) / 1000).toFixed(1)} s`);
ok(g1.overl === 0, `G1: 0 overlaps > 4 px² (${g1.overl})`);
ok(g1.outside === 0, `G1: 0 boxes outside the viewport (${g1.outside})`);
ok(g1.overDock === 0, `G1: 0 non-children over the dock (${g1.overDock})`);
ok(g1.small === 0, `G2: 0 text below 12 px (${g1.small})`);
ok(g1.groups === 0, `G1: one kinetic group per band (${g1.groups})`);
ok(g1.dispHidden === 0, `G1: every beat's display text is placed (${g1.dispHidden} hidden; by class ${JSON.stringify(hiddenByCls)})`);
ok(g1.chrome === 0, `G12: ≤ 4 chrome elements in flight (${g1.chrome} frames over)`);
ok(!realSeek || g1.corr > 0, `G3 inputs: the projected beam is a solver corridor (${g1.corr} corridor-frames)`);
ok(g1.g3 === 0, `G3: the beam never crosses a placed text or equation box (${g1.g3})`);
ok(!realSeek || (g1.reqN > 0 && !g1.reqMiss), `end actions placed in every class whenever visible (${g1.reqN || 0} frames, ${g1.reqMiss || 0} hidden; ${g1.reqOverBeam || 0} over the beam corridor)`);
ok(g1.actInTitle === 0, `the act chip is never placed in the title beat B0, where it would repeat the title (${g1.actInTitle})`);
ok(g1.chromeMissing === 0, `act chip (after B0), menu, rail, Fly button, rail track and dock are always placed (${g1.chromeMissing} misses)`);
ok(!g1.scrimBad, `S0 scrims: <= 2 rects, every placed text/equation box under a scrim with the full soft edge (${g1.scrimBad || 0} misses; ` +
   `mean scrim area ${(100 * (g1.scrimAreaSum || 0) / Math.max(1, g1.scrimN || 0)).toFixed(1)} %, max ${(100 * (g1.scrimArea || 0)).toFixed(1)} % of the viewport)`);
if (examples.length) console.log("   " + examples.join("\n   "));
const eqH = Object.entries(eqHidden).map(([k, n]) => `${k} ${n}/${eqSeen[k]}`);
console.log(`# equations hidden by the solver (no room in their band; they never shrink): ${eqH.length ? eqH.join(", ") : "none"}`);
if (missingCopy.size) console.log("# note: beats reference copy ids or parts that copy.json does not have (U_copy/U_motion contract): " + [...missingCopy].join(" "));

console.log(`\n${n - fails}/${n} passed` + (fails ? `, ${fails} FAILED` : ""));
process.exit(fails ? 1 : 0);
