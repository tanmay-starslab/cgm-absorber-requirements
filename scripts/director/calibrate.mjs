// Director calibration, run once (DESIGN_tierA §6.2 steps 3-4): derives the director's templates from the hand-tuned hero.
//
//   node scripts/director/calibrate.mjs [--check]
//
// writes scripts/director/template.beats.json  per-beat template (hero beat minus timing/windows; hero cells -> roles;
//                                              plus the Tier A beats B7p, B10w, B12n, default off by cond)
//        scripts/director/template.shots.json  shot coefficients = hero tuned value / hero length scale, per hero shot;
//                                              timing fit (base_s scale kb and the w exponent alpha) on the hero
// --check: recompute and exit 1 if the files on disk differ (byte-identical reruns).
// Inputs: ROOT/beats.json, ROOT/shots.json, ROOT/copy.json, ROOT/data/story_488530_rand_b062_a062.json, and the hero's
// encounter radii from plan/1 (constants below, from `story3_w/R3/hero3`, the R1 exporter run on the hero; report only).
import {readFileSync, writeFileSync} from "fs";
import {createHash} from "crypto";
import {dirname, join} from "path";
import {fileURLToPath, pathToFileURL} from "url";
import {readSeconds, allocate, ionCells, tauSum, KIND_BASE} from "./compose.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
export const REPO = join(HERE, "..", "..");
export const ROOT = join(REPO, "docs/tng50/learn/how-a-spectrum-is-made");
const J = f => JSON.parse(readFileSync(join(ROOT, f), "utf8"));
const sha = s => createHash("sha256").update(s).digest("hex");
const r4 = x => Math.round(x * 1e4) / 1e4;

/* hero length scales (kpc). s_enc = clamp(r90, 4, 30) of the hero encounters (plan/1 on the hero: A e0 r90 10.11, B e1
   34.34, D e3 21.35); s_gap = clamp(gap/6, 4, 30) of the hero gap flights; h_cell = clamp(h, 0.5, 6) of cell 263;
   dl_pair = |l(438) − l(296)| of the B9 pair */
export const HERO = Object.freeze({R: 246.35, half: 246.35, sA: 10.11, sB: 30, sD: 21.35, h263: 3.033, dlPair: 84.558,
  gap: {B3: 27.35, B4: 54, B6: 82}});
const clamp = (x, a, b) => Math.max(a, Math.min(b, x));
export const sGap = g => clamp(g / 6, 4, 30);

/* hero cell ids -> roles (DESIGN_tierA §4.1, R2 GHOST_ALIAS) */
const CELL_ROLE = {125: "@cloudA.core", 263: "@S5", 492: "@S4a"};
const GHOST_ROLE = {T125: "T@cloudA.core", T263: "T@S5", N492: "N@S4a"};

export function templateBeats(heroBeats) {
  const out = {};
  for (const b of heroBeats.beats) {
    const t = JSON.parse(JSON.stringify(b));
    for (const k of ["watch_s", "p0", "p1", "l0", "l1", "shot"]) delete t[k];
    if (t.cell != null && CELL_ROLE[t.cell]) t.cell = CELL_ROLE[t.cell];
    for (const e of t.eqs || []) {
      if (e.anchor && typeof e.anchor.ref === "number" && CELL_ROLE[e.anchor.ref]) e.anchor.ref = CELL_ROLE[e.anchor.ref];
      if (e.ghost && GHOST_ROLE[e.ghost]) e.ghost = GHOST_ROLE[e.ghost];
    }
    out[b.id] = t;
  }
  const L0 = n => n.map(name => ({name, level: "L0"}));
  out.B7p = {id: "B7p", cond: "has_phase_offset", kind: "hold", ion: "OVI", tf: [{u: 0, preset: "phases", darkSky: true}], dock: "pair",
    fields: L0(["T", "nH", "HI", "OVI"]), lead: 0.03, textBand: "text", text: [{id: "B7p", band: "text", part: "all", u0: 0.15, u1: 0.8, words: 8}],
    eqs: [], interactions: ["scrub", "freeLook"], copyRef: "B7p", spec: {mode: "intrinsic"}, shells: "all", quality: "stop"};
  out.B10w = {id: "B10w", cond: "hi_damped", kind: "hold", ion: "HI", tf: [{u: 0, preset: "ion:HI", darkSky: true}, {u: 0.3, preset: "phases", darkSky: true, chip: "composite"}], dock: "pair",
    fields: L0(["T", "nH", "HI"]), lead: 0.03, textBand: "text", text: [{id: "B10w", band: "text", part: "all", u0: 0.45, u1: 0.95, words: 5}],
    eqs: [], interactions: ["scrub", "freeLook"], copyRef: "B10w", spec: {mode: "intrinsic"}, shells: "all", quality: "stop"};
  out.B12n = {id: "B12n", cond: "empty_faint", kind: "still", ion: "OVI", tf: [{u: 0, preset: "phases", darkSky: true}],
    dock: [{u: 0, state: "pair"}, {u: 0.15, state: "hero"}], fields: L0(["T", "nH"]), lead: 0.02, textBand: "text",
    text: [{id: "B12n", band: "text", part: "all", u0: 0.15, u1: 0.8, words: 14}], eqs: [], interactions: ["R", "sn", "newNoise"],
    copyRef: "B12n", spec: {mode: "observed", R: 15000, sn: 10}, ui: {inset: 1}, shells: "all", quality: "stop"};
  return {schema: "director-template-beats/1",
    about: "Per-beat templates for scripts/story_director.mjs, made by scripts/director/calibrate.mjs from the hand-tuned hero ROOT/beats.json (timing and l-windows removed, hero cells 125/263/492 replaced by @cloudA.core/@S5/@S4a, ghosts T125/T263/N492 by T@cloudA.core/T@S5/N@S4a), plus the Tier A beats B7p, B10w and B12n (default off: each needs its cond flag). The director sets kind, l0/l1, watch_s, p0/p1, shot and fields per story.",
    beats: out};
}

/* one key -> coefficients: lengths divided by the unit scale; ray l numbers by half (anchored at start/mid/end) */
function coefKey(k, unit, anchor) {
  const c = JSON.parse(JSON.stringify(k));
  const div = x => (typeof x === "number" ? r4(x / unit) : x);
  const lDiv = l => (typeof l === "number" ? r4((anchor === "start" ? l + HERO.half : anchor === "end" ? l - HERO.half : l) / HERO.half) : l);
  const pt = p => {
    if (!p || typeof p !== "object" || Array.isArray(p)) return p;
    if (p.mix) return {mix: [pt(p.mix[0]), pt(p.mix[1]), p.mix[2]]};
    const q = {...p};
    const numL = typeof q.l === "number";
    if (numL) q.l = lDiv(q.l);
    // a point at a numeric l is scaled with half (whole-ray framing); a probe-relative point with the unit
    for (const f of ["back", "up", "side"]) if (typeof q[f] === "number") q[f] = r4(q[f] / (numL ? HERO.half : unit));
    return q;
  };
  if (c.kind === "chase") for (const f of ["back", "up", "side", "lookAhead"]) if (f in c) c[f] = div(c[f]);
  if (c.kind === "orbit") { if (typeof c.r === "number") c.r = div(c.r); if (c.center && typeof c.center === "object") c.center = pt(c.center); }
  if (c.kind === "pose") { c.at = pt(c.at); if (c.look) c.look = pt(c.look); }
  return c;
}
/* hero shot -> unit (and l anchor). Units: R (R200c), half, sA/sB/sD (s_enc of the hero letter), gap:<beat> (s_gap),
   h263 (h_cell), dlPair (Δl_pair), abs (kpc, unscaled) */
export const SHOT_UNITS = {
  gate: ["R"], coldopen: ["half", "start"], halo: ["R"], drop: ["gap:B3"], first: ["gap:B4"], cloudA: ["sA"], quiet: ["gap:B6"],
  cloudB: ["sB"], stop263: ["h263"], drag263: ["h263"], restB: ["sB"], coldknot: ["sB"], halfway: ["abs"], thread: ["dlPair"],
  cloudD: ["sD"], lookback: ["half"], telescope: ["half", "end"], telescopeHold: ["half", "end"], readback: ["half"], yours: ["half"]};
const unitVal = u => (u === "R" ? HERO.R : u === "half" ? HERO.half : u === "abs" ? 1 : u === "h263" ? HERO.h263 : u === "dlPair" ? HERO.dlPair
  : u.startsWith("gap:") ? sGap(HERO.gap[u.slice(4)]) : HERO[u]);

export function templateShots(heroShots) {
  const coeffs = {};
  for (const [name, [unit, anchor = "mid"]] of Object.entries(SHOT_UNITS)) {
    const s = heroShots.shots[name]; if (!s) throw new Error(`hero shot ${name} missing`);
    const keys = s.keys.map(k => {
      // thread: the side pose is in Δl_pair units, its chase keys stay absolute (probe-relative, small)
      if (name === "thread" && k.kind === "chase") return coefKey(k, 1, anchor);
      if (name === "lookback" && k.kind === "chase") return coefKey(k, 1, anchor);
      return coefKey(k, unitVal(unit), anchor);
    });
    const meta = Object.fromEntries(Object.entries(s).filter(([k]) => ["textSide", "cut", "blendIn"].includes(k)));
    coeffs[name] = {unit, anchor, unit_hero_kpc: r4(unitVal(unit)), ...meta, keys};
  }
  return {coeffs, classMods: heroShots.classMods};
}

/* timing fit on the hero: kb (base_s scale) and alpha (w exponent); compare per-beat watch_s */
export async function timingFit() {
  const D = await import(pathToFileURL(join(ROOT, "js/copy/derive.js")).href);
  const beats = J("beats.json"), copy = J("copy.json"), data = J("data/story_488530_rand_b062_a062.json");
  const flags = {...D.copyFlags(copy, data), ...(data.flags || {})}, lookup = D.copyLookup(copy, data);
  const items = beats.beats.map(b => ({id: b.id, kind: b.kind, l0: b.l0, l1: b.l1, text: b.text, cond: b.cond}));
  const read = readSeconds(beats.beats, D, copy, {flags, caseId: null, lookup});
  const C = {OVI: ionCells(data, "OVI"), HI: ionCells(data, "HI")};
  const hero = beats.beats.map(b => b.watch_s), total = hero.reduce((s, x) => s + x, 0);
  const wOf = b => { const src = beats.beats.find(x => x.id === b.id); return tauSum(C[src.ion] || C.OVI, Math.min(b.l0, b.l1), Math.max(b.l0, b.l1)); };
  let best = null;
  for (let ik = 0; ik <= 30; ik++) for (let ia = 0; ia <= 20; ia++) {
    const kb = r4(0.5 + 0.05 * ik), alpha = r4(0.05 * ia);
    const w = allocate(items, read, {target: total, kb, alpha, wOf});
    const errs = w.map((x, i) => (x - hero[i]) / hero[i]);
    const within = errs.filter(e => Math.abs(e) <= 0.25).length;
    const terr = Math.abs(w.reduce((s, x) => s + x, 0) / total - 1);
    const score = [(hero.length - within) + 10 * Math.max(0, terr - 0.05), errs.reduce((s, e) => s + e * e, 0)];
    if (!best || score[0] < best.score[0] || (score[0] === best.score[0] && score[1] < best.score[1] - 1e-12)) best = {kb, alpha, w, errs, score, within};
  }
  // alpha is not identifiable when the hero's copy leaves no flex (Σ need ≥ target): keep the design's √ (0.5)
  { const w = allocate(items, read, {target: total, kb: best.kb, alpha: 0.5, wOf});
    if (w.every((x, i) => x === best.w[i])) { best.alpha = 0.5; best.alphaNote = "not identifiable on the hero (no flex): design default 0.5"; } }
  const tot = best.w.reduce((s, x) => s + x, 0);
  return {kb: best.kb, alpha: best.alpha, base_s: KIND_BASE, wps: 3, line_pad_s: 1.5, cap_s: 40, hero_total_s: total,
    alpha_note: best.alphaNote || null,
    fit: {beats_within_25pct: `${best.within}/${hero.length}`, total_err: r4(tot / total - 1),
      per_beat: Object.fromEntries(beats.beats.map((b, i) => [b.id, {hero: hero[i], composed: best.w[i], err: r4(best.errs[i])}]))},
    note: "grid search kb 0.5-2.0 (0.05), alpha 0-1 (0.05): score = beats outside ±25 % + 10 × (|total error| − 5 %)₊, then least squares. The hero's p widths and watch_s are hand-tuned; the composed schedule is a report (HC), never shipped for the hero."};
}

export async function calibrate() {
  const beats = J("beats.json"), shots = J("shots.json");
  const tb = templateBeats(beats);
  const ts = templateShots(shots);
  const timing = await timingFit();
  const prov = {inputs: Object.fromEntries(["beats.json", "shots.json", "copy.json", "data/story_488530_rand_b062_a062.json"].map(f => [f, sha(readFileSync(join(ROOT, f))).slice(0, 16)])),
    hero_scales: HERO, run: "node scripts/director/calibrate.mjs"};
  tb.provenance = prov;
  const shotsDoc = {schema: "director-template-shots/1",
    about: "Shot coefficients for scripts/story_director.mjs (DESIGN_tierA §6.2 step 4): each hero shot's keys with every length divided by the hero length scale named in `unit` (R = R200c, half = half the ray, sA/sB/sD = s_enc = clamp(r90, 4, 30) of the hero letters, gap:<beat> = s_gap = clamp(gap/6, 4, 30), h263 = h_cell of the hero stop cell, dlPair = Δl of the B9 pair, abs = unscaled kpc). A point at a numeric ray l stores l/half (anchor start: (l + half)/half, end: (l − half)/half) and its offsets in half. Made once by calibrate.mjs from the hand-tuned hero; never hand-edited.",
    provenance: prov, coeffs: ts.coeffs, classMods: ts.classMods, timing,
    generated: {tableau: {fit: 1.15, dolly: 0.07, fov: 48, disk_view_min_deg: 60},
      pair: {side_dl: -3.3114, up_dl: 0.473, min_d: 120}, wide: 1.6, pullout: {fov: 60, fit: 1.3},
      chaseThreshold_tau: 0.1, lod_voxels: 48}};
  return {tb, shotsDoc};
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) {
  const {tb, shotsDoc} = await calibrate();
  const files = {"template.beats.json": tb, "template.shots.json": shotsDoc};
  let bad = 0;
  for (const [f, obj] of Object.entries(files)) {
    const s = JSON.stringify(obj, null, 1) + "\n", p = join(HERE, f);
    if (process.argv.includes("--check")) { let cur = ""; try { cur = readFileSync(p, "utf8"); } catch {} if (cur !== s) { bad++; console.log(`differs: ${f}`); } }
    else { writeFileSync(p, s); console.log(`wrote scripts/director/${f} (${s.length} B)`); }
  }
  const t = shotsDoc.timing; console.log(`timing fit: kb ${t.kb}, alpha ${t.alpha}, ${t.fit.beats_within_25pct} beats within ±25 %, total ${(t.fit.total_err * 100).toFixed(1)} %`);
  process.exit(bad ? 1 : 0);
}
