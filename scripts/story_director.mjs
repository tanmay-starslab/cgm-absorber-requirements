#!/usr/bin/env node
// Offline auto camera director (DESIGN_tierA §6). Nothing here ships in the browser bundle.
//
//   node scripts/story_director.mjs --story <id> [--no-repair] [--report DIR] [--data FILE] [--quick]
//   node scripts/story_director.mjs --all [...]                      the five Tier A stories
//   node scripts/story_director.mjs --hero-check [--data FILE]       report only (§6.3): the director on the hero ray
//   node scripts/story_director.mjs --story <id> --check             rerun and compare with the files on disk (byte-identical)
//
// in : ROOT/data/v3/story_<g>_<ray>.json (story-data/3; the file whose case.declared is the story's case, or --data),
//      ROOT/copy.json (resolved per story), scripts/director/{template.beats,template.shots,cases,hosted_cover,overrides}.json
// out: ROOT/beats.<id>.json, ROOT/shots.<id>.json, ROOT/films/<id>.json, <report>/director_report_<id>.json
// imports unchanged: js/core/seek.js + shots.js + timeline.js, js/ui/layout.js, js/ui/layoutclass.js, js/ui/hud.js (the
// page's composer: G1/G2/G3/G12 exactly as the page lays out), js/copy/derive.js.
// Pure and deterministic: no Date, no randomness, fixed candidate order. Every automatic change is in the report.
import {readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync} from "fs";
import {gunzipSync} from "zlib";
import {createHash} from "crypto";
import {dirname, join, resolve, relative} from "path";
import {fileURLToPath, pathToFileURL} from "url";
import {sequence, buildBeats, tfBlock, filmPlan, ionCells, colFrac, tubeSorted} from "./director/compose.mjs";
import {scales, shotFor, pairOf, b9Pair, VARIANTS} from "./director/styles.mjs";
import {geomChecks, g3Band, layoutCheck, continuity, auditRoles, repair, frames} from "./director/repair.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
export const REPO = join(HERE, "..");
export const ROOT = join(REPO, "docs/tng50/learn/how-a-spectrum-is-made");
const DIR = join(HERE, "director");
export const VERSION = "director/1";
export const STORY_IDS = ["clean", "multiphase", "damped", "empty", "hot"];
const HERO_DATA = process.env.TNG_WORK ? join(process.env.TNG_WORK, "scratch/story3_w/R3/hero3/out/488530_rand_b062_a062/story_488530_rand_b062_a062.json") : null;
const readJ = f => JSON.parse(readFileSync(f, "utf8"));
const sha = b => createHash("sha256").update(b).digest("hex");
const r3 = x => Math.round(x * 1000) / 1000;
const dump = o => JSON.stringify(o, null, 1) + "\n";

export async function modules(root = ROOT) {
  const imp = p => import(pathToFileURL(join(root, p)).href);
  const [SK, SH, LC, HUD, L, K, D, TL] = await Promise.all(["js/core/seek.js", "js/core/shots.js", "js/ui/layoutclass.js", "js/ui/hud.js",
    "js/ui/layout.js", "js/ui/kinetic.js", "js/copy/derive.js", "js/core/timeline.js"].map(imp));
  return {SK, SH, LC, HUD, L, K, D, TL};
}
export function templates() {
  return {tpl: readJ(join(DIR, "template.beats.json")), T: readJ(join(DIR, "template.shots.json")), cases: readJ(join(DIR, "cases.json")),
    hosted: readJ(join(DIR, "hosted_cover.json")), overrides: existsSync(join(DIR, "overrides.json")) ? readJ(join(DIR, "overrides.json")) : {overrides: []}};
}
/* the story-data/3 file of a story: --data, else the one ROOT/data/v3 file declaring the story's case */
export function dataFileFor(id, caseId, root = ROOT, explicit = null) {
  if (explicit) return resolve(explicit);
  const dir = join(root, "data/v3");
  const hits = readdirSync(dir).filter(f => /^story_\d+_.+\.json$/.test(f)).sort().filter(f => { try { const d = readJ(join(dir, f)); return d.case && d.case.declared === caseId; } catch { return false; } });
  if (hits.length !== 1) throw new Error(`${id}: ${hits.length} story-data/3 files declare case ${caseId} in data/v3 (${hits.join(", ")}); pass --data`);
  return join(dir, hits[0]);
}

/* story context */
export function context(id, M, TP, {root = ROOT, data: dataPath = null, hero = false} = {}) {
  const cfg = hero ? heroCfg(TP, root) : TP.cases.stories[id];
  if (!cfg) throw new Error(`unknown story ${id}`);
  const file = hero ? dataPath : dataFileFor(id, cfg.case, root, dataPath);
  if (!file || !existsSync(file)) throw new Error(`${id}: no story-data/3 file (${file})`);
  const data = readJ(file);
  if (!data.plan || !data.roles) throw new Error(`${id}: ${file} is not story-data/3 (no plan/roles)`);
  const copy = readJ(join(root, "copy.json")), EQ = readJ(join(root, "eq/eq.json"));
  if (!hero && existsSync(join(root, "copy.cases.json"))) M.D.attachCases(copy, readJ(join(root, "copy.cases.json")));   // R5b handoff: case copy (fix1 F5)
  const flags = data.flags || {}, copyFlags = {...M.D.copyFlags(copy, data), ...flags}, lookup = M.D.copyLookup(copy, data);
  const half = data.plan.half || data.geometry.ray.half;
  // B3 starts inside the L0 boundary when the ray ends beyond 390 kpc (§6.2 step 5; cube_cover.director_note)
  let lStart = -half;
  const endR = data.cube_cover && data.cube_cover.end_r_kpc;
  if (endR > 390) { const p0 = data.geometry.ray.p0, n = data.geometry.ray.n;
    for (let l = -half; l < 0; l += 0.5) { const s = l + half, q = [p0[0] + n[0] * s, p0[1] + n[1] * s, p0[2] + n[2] * s]; if (Math.hypot(...q) <= 390) { lStart = Math.round(l * 1000) / 1000; break; } } }
  const SIZES = JSON.parse(gunzipSync(readFileSync(join(REPO, "tests/fixtures/hero_v2/sizes.json.gz"))).toString("utf8"));
  const host = TP.hosted.hosts[String(data.meta.galaxy)] || null;
  return {id, cfg, caseId: hero ? "hero" : cfg.case, data, file, half, lStart, lead: hero ? "OVI" : data.plan.lead_ion, flags, copyFlags, copy, lookup, EQ, SIZES, hosted: host};
}
function heroCfg(TP, root) {
  const hb = readJ(join(root, "beats.json"));
  return {case: "hero", target_s: hb.meta.watchTotal_s, beats: hb.beats.map(b => b.id), styles: {}, override: {}, film: {target_s: 120, chunks: []}};
}

/* fix1 round 2 (review beauty F9): a line that names a dip (dip, black, grey, trough, wings) in a flight beat waits until the
   lead ion has laid down at least half of the optical depth this beat's window adds (probe position from the page's own
   time warp, js/core/seek.js prepare), so the headline never arrives before the dip it describes. A line that cannot wait
   inside the beat keeps its length and moves as late as the beat allows; every move is logged */
const DIP_WORDS = /\b(dip(s|ping|ped)?|black|grey|trough|wings)\b/i;   // fix2 (review2 R2-B3/B4/S1): "dipping at -54"
function dipDelay(S, M, beatsDoc, shotsDoc, log) {
  // copies: seek memoises its context per (data, beats doc), and the real docs still change after this (repair)
  const ctx = M.SK.prepare(S.data, structuredClone(beatsDoc), structuredClone(shotsDoc)), lead = S.lead === "HI" ? "HI" : "OVI", C = ctx.cells[lead];
  if (!C || !C.n) return;
  const ctxL = {flags: S.copyFlags, caseId: S.caseId, lookup: S.lookup};
  let Cb = C;   // fix2 (review2 R2-B3): the dip of the beat's own ion (multiphase B7a is O VI under an H I lead)
  const tauIn = (a, c) => { let s2 = 0; for (let j = 0; j < Cb.n; j++) if (Cb.l[j] >= Math.min(a, c) && Cb.l[j] <= Math.max(a, c)) s2 += Cb.tau0[j]; return s2; };
  const enc = (S.data.plan && S.data.plan.encounters) || [], l00 = -S.half;
  for (const b of beatsDoc.beats) {
    // forward flights only (a backward lookback shows dips that are already whole); B4's line is about the first cell
    if (b.kind !== "flight" || !(b.l1 > b.l0) || b.id === "B4") continue;
    const w = ctx.warp(b.ion || lead);
    Cb = (b.ion === "HI" || b.ion === "OVI") && ctx.cells[b.ion] && ctx.cells[b.ion].n ? ctx.cells[b.ion] : C;
    // the dip the line names: everything the probe has crossed by the end of this beat, or by the end of the encounter the
    // beat ends inside; its depth so far = the optical depth crossed from the start of the beam
    const end = Math.max(b.l1, ...enc.filter(e => e && e.l0 <= b.l1 && e.l1 >= b.l1).map(e => +e.l1));
    const tot = tauIn(l00, end); if (!(tauIn(b.l0, end) > 0.05 * tot) || !(tot > 0)) continue;
    const lu = b.lu || [0, 1];
    const fracAt = u => tauIn(l00, w.lOf(b.l0, b.l1, Math.min(1, Math.max(0, (u - lu[0]) / Math.max(1e-9, lu[1] - lu[0]))))) / tot;
    let u50 = 1; for (let k = 0; k <= 200; k++) if (fracAt(k / 200) >= 0.5) { u50 = k / 200; break; }
    const m = Math.min(0.45, 0.0041 / Math.max(1e-6, b.p1 - b.p0));
    for (const t of b.text || []) {
      if (!(t.words > 0) || t.u0 >= u50) continue;
      const e = M.D.resolveLine(S.copy, t.id, ctxL); if (!e) continue;
      const txt = [t.part !== "sub" ? e.display : "", t.part !== "display" ? e.sub : ""].join(" ");
      if (!DIP_WORDS.test(txt.replace(/\*/g, ""))) continue;
      // never onto the next slot of its band (timeline.validate: band gap 0.004 p plus both fades); may shrink to 60 %
      const g = (0.004 + 2 * 0.004 + 2e-4) / Math.max(1e-6, b.p1 - b.p0);
      const next = (b.text || []).filter(x => x !== t && x.band === t.band && !x.alt && x.u0 > t.u0).sort((x, y) => x.u0 - y.u0)[0];
      const maxU1 = next ? next.u0 - g : 1 - m, len = t.u1 - t.u0, was = `${t.u0}..${t.u1}`;
      const u0 = Math.min(u50, maxU1 - 0.6 * len);
      if (u0 <= t.u0 + 1e-3) { log.push(`${b.id}: ${t.id} names a dip before its half depth (u ${r3(u50)}) but cannot wait inside the beat; kept at ${was}`); continue; }
      t.u0 = r3(u0); t.u1 = Math.floor(Math.min(maxU1, u0 + len) * 1000) / 1000;
      log.push(`${b.id}: ${t.id} names a dip; waits for half the lead-ion depth (u ${r3(u50)}): ${was} -> ${t.u0}..${t.u1}`);
    }
  }
}
/* fix2 (review2 R2-B10/R2-B4): the page drops an equation anchored on an ok:false role (seek.js). The one a dragN beat
   needs (its E3, "add atoms") moves to @lead.core, the lead ion's strongest cell, when that resolves; any other is removed
   (as the page did, now visible in the file). Its ghost key (the override it feeds) stays */
function reanchor(S, M, doc, log) {
  const ok = ref => { const r = M.SK.resolveRole(S.data, ref); return !!(r && r.ok && r.cell != null); };
  for (const b of doc.beats) if (b.eqs) b.eqs = b.eqs.filter(e => {
    const ref = e.anchor && e.anchor.ref, r = M.SK.isRole(ref) ? M.SK.resolveRole(S.data, ref) : null;
    if (!r || r.ok !== false) return true;   // unknown roles still throw in auditRoles
    if (e.id === "E3" && (b.interactions || []).includes("dragN") && ok("@lead.core")) { log.push(`${b.id}/${e.id}: anchor ${ref} is ok:false; moved to @lead.core`); e.anchor = {...e.anchor, ref: "@lead.core"}; return true; }
    log.push(`${b.id}/${e.id}: anchor ${ref} is ok:false ; equation removed`); return false; });
}
/* fix1 round 2 (F3): watch_s covers what the page's Watch schedule needs for this beat's captions (no hidden stretch), on the
   half-second grid */
function fitWatch(M, beatsDoc, shotsDoc, log) {
  const tl = M.TL.createTimeline(structuredClone(beatsDoc), {shots: shotsDoc});
  beatsDoc.beats.forEach((b, i) => { const d = tl.watch.t1[i] - tl.watch.t0[i];
    if (d > b.watch_s + 1e-6) { const v = Math.ceil(d * 2 - 1e-9) / 2; log.push(`${b.id}: watch_s ${b.watch_s} -> ${v} (its captions need ${r3(d)} s)`); b.watch_s = v; } });
}

/* el variant sign: the rotation about n̂ that moves the camera away from the disk plane */
function elSignOf(Sc, shot) {
  const k = shot.keys[0]; let up, side;
  if (k.kind === "chase") { up = k.up ?? 3; side = k.side ?? 4; } else if (k.kind === "pose" && k.at && typeof k.at === "object") { up = k.at.up || 0; side = k.at.side || 0; } else return 1;
  const z = up * Sc.F.e2[2] + side * Sc.F.e1[2], dz = side * Sc.F.e2[2] - up * Sc.F.e1[2];
  return z * dz >= 0 ? 1 : -1;
}

/* the director: beats, shots, film plan, report */
export async function direct(id, M, TP, opt = {}) {
  const S = context(id, M, TP, opt);
  const {cfg} = S, T = TP.T, Sc = scales(S);
  const seq = sequence(S, cfg);
  const {beats, read, log: composeLog, total} = buildBeats(S, cfg, TP.tpl, {D: M.D, kb: T.timing.kb, alpha: T.timing.alpha}, seq);
  const items = Object.fromEntries(seq.items.map(x => [x.id, x]));
  const styleOf = bid => (cfg.styles || {})[bid] || TP.cases.default_styles[bid];
  const ctxOf = b => {
    const c = {role: (cfg.role || {})[b.id], wide: (cfg.wide || []).includes(b.id)};
    if (b.id === "B7p") c.pair = pairOf(S, items.B7p);
    if (b.id === "B9") c.pair = b9Pair(S);
    if (b.id === "B10w") { const b10 = beats.find(x => x.id === "B10"); c.window = b10 ? [b10.l0, b10.l1] : null; }
    if (S.caseId === "empty" && b.kind !== "flight") c.window = [-S.half, S.half];
    return c;
  };
  // alt: a fallback style; a trailing "!" keeps a chase even where the lead ion has nothing to point at
  const build = (b, v, alt = null) => { const keep = !!alt && alt.endsWith("!"), st = alt ? alt.replace(/!$/, "") : styleOf(b.id), c = {...ctxOf(b), keepChase: keep};
    const s0 = shotFor(b, st, S, Sc, T, VARIANTS[0], c); c.elSign = elSignOf(Sc, s0);
    return v === VARIANTS[0] ? s0 : shotFor(b, st, S, Sc, T, v, c); };
  // style fallbacks after the variant list (fixed order): flights -> their own chase kept -> gap chase -> side tableau;
  // holds/stills -> tableau
  const fallbacks = b => { const st = styleOf(b.id);
    if (b.kind === "flight") return [...(st !== "tableau" ? [st + "!"] : []), "quiet!", "tableau"].filter((x, i, a) => a.indexOf(x) === i && x !== st);
    if (b.kind === "hold" || b.kind === "still") return ["tableau"].filter(x => x !== st);
    return []; };
  const shots = {};
  for (const b of beats) shots[b.shot] = build(b, VARIANTS[0]);
  const beatsDoc = {schema: "story-beats/3", meta: {}, beats};
  const shotsDoc = {schema: "story-shots/2", about: `Generated by scripts/story_director.mjs (${VERSION}) for story ${id}: shot styles from scripts/director/cases.json, coefficients from scripts/director/template.shots.json (calibrated on the hand-tuned hero), repaired by the fixed variant order. Never hand-edited; overrides only via scripts/director/overrides.json.`, shots, classMods: T.classMods};
  const E = {S, Sc, docs: {beats: beatsDoc, shots: shotsDoc}, M, data: S.data, T};
  const meta0 = metaOf(S, cfg, beats, total, seq, null, TP);
  beatsDoc.meta = meta0;
  dipDelay(S, M, beatsDoc, shotsDoc, composeLog);
  fitWatch(M, beatsDoc, shotsDoc, composeLog);
  beatsDoc.meta.watchTotal_s = beatsDoc.beats.reduce((a, b) => a + b.watch_s, 0);
  reanchor(S, M, beatsDoc, composeLog);
  // roles: an unknown role throws (§6.2 step 9)
  const roleAudit = auditRoles(E);
  // repair (§6.2 step 8)
  let rep = {log: [], failed: []};
  // pass 1 repairs every beat in story order; passes 2-4 repair only the beats the whole-story checks still flag (a later
  // beat's new shot can move an earlier beat's frames through seek's comfort smoothing)
  if (!opt.noRepair) {
    rep = repair(E, build, {layout: !opt.quick, fallbacks}); rep.passes = [{pass: 1, beats: "all", failed: rep.failed.slice()}];
    for (let pass = 2; pass <= 4; pass++) {
      const bad = flagged(E, opt);
      if (!bad.length) break;
      const r2 = repair(E, build, {layout: !opt.quick, fallbacks, beats: bad});
      rep.log.push(...r2.log.map(x => ({...x, pass})));
      rep.failed = [...new Set([...rep.failed.filter(id => !bad.includes(id)), ...r2.failed])];
      rep.passes.push({pass, beats: bad, failed: r2.failed});
    }
  }
  // overrides (logged, ≤ 2 per story; never to rescue a gate)
  const ovs = (TP.overrides.overrides || []).filter(o => o.story === id);
  if (ovs.length > 2) throw new Error(`${id}: ${ovs.length} beauty overrides (max 2)`);
  for (const o of ovs) { const s = E.docs.shots.shots[o.beat]; if (!s) throw new Error(`override for unknown beat ${o.beat}`); E.docs.shots.shots[o.beat] = {...s, ...o.shot, override: o.why || true}; }
  // TF block (camera distances from the final shots)
  const fr = frames(E, null, 8);
  const ds = fr.map(x => Math.hypot(...x.f.cam.target.map((t, k) => t - x.f.cam.pos[k]))).filter(Number.isFinite).sort((a, b) => a - b);
  const tube = await tubeSorted(opt.root || ROOT, S.file, S.data);
  E.docs.beats.meta.tf = tfBlock(S, TP.tpl, {min: ds[0] || 5, max: ds[ds.length - 1] || 500}, tube);
  // gates in node
  const gates = {};
  const val = M.TL.createTimeline(E.docs.beats, {shots: E.docs.shots, schema: readJ(join(opt.root || ROOT, "beats.schema.json"))}).validate();
  gates.schema = {pass: val.length === 0, fails: val.slice(0, 20)};
  const geo = geomChecks(E, null);
  const byGate = g => geo.fails.filter(x => x.gate === g);
  gates.G19 = {pass: !byGate("G19").length, fails: byGate("G19").slice(0, 20)};
  gates.G20 = {pass: !byGate("G20").length, fails: byGate("G20").slice(0, 20), note: geo.notes.join("; ")};
  gates.occlusion = {pass: !byGate("occlusion").length, fails: byGate("occlusion").slice(0, 10)};
  gates.clearance = {pass: !byGate("clearance").length, fails: byGate("clearance").slice(0, 10)};
  const g3b = g3Band(E, null, {np: opt.quick ? 320 : 1600, quick: !!opt.quick});
  const lay = layoutCheck(E, null, {np: 160, quick: !!opt.quick});
  const lf = g => lay.fails.filter(x => x.gate === g);
  gates.G3 = {pass: !g3b.fails.length && !lf("G3").length, fails: [...g3b.fails, ...lf("G3")].slice(0, 20), frames: g3b.frames};
  gates.G1 = {pass: !lf("G1").length, fails: lf("G1").slice(0, 20), counts: lay.cnt};
  gates.G2 = {pass: !lf("G2").length, fails: lf("G2").slice(0, 10)};
  gates.G12 = {pass: !lf("G12").length, fails: lf("G12").slice(0, 10)};
  const cont = continuity(E);
  gates.self = {pass: !cont.fails.length && !geo.fails.some(x => x.gate === "self"), fails: cont.fails.slice(0, 10), worst_of_allowance: cont.worstRel};
  gates.G13r = g13r(S, seq, E.docs.beats, roleAudit);
  gates.G15 = g15(S, seq, E.docs.beats);
  const watch = E.docs.beats.beats.reduce((s, b) => s + b.watch_s, 0);
  // fix1 round 2 (review beauty F3): the length the visitor gets is the page's Watch schedule (timeline.js stretches a beat
  // whose captions need more than its watch_s; gate.js shows that total on the Watch button), not the sum of watch_s.
  // Owner decision 5: 100-200 s per story (empty about 110 s): within [min(100, 0.8 target), min(200, 1.25 target)]
  const watchTotal = M.TL.createTimeline(E.docs.beats, {shots: E.docs.shots}).watch.total;
  const lenLo = Math.min(100, 0.8 * cfg.target_s), lenHi = Math.min(200, 1.25 * cfg.target_s);
  gates.length = opt.hero ? {pass: true, watch_s: watch, watch_total_s: r3(watchTotal), note: "hero: report only"}
    : {pass: watchTotal >= lenLo && watchTotal <= lenHi, watch_total_s: r3(watchTotal), watch_s: watch, target_s: cfg.target_s, range_s: [r3(lenLo), r3(lenHi)]};
  const film = opt.hero ? null : filmPlan(S, cfg, E.docs.beats);
  if (film) gates.film = {pass: film.duration_s >= 80 && film.duration_s <= 120, duration_s: film.duration_s};
  const hard = ["schema", "G1", "G2", "G3", "G12", "G13r", "G15", "G19", "G20", "self", "length"];
  const allPass = hard.every(k => gates[k] && gates[k].pass);
  // generator provenance (never Date-stamped)
  E.docs.beats.meta.generator = {...E.docs.beats.meta.generator, gates_node: Object.fromEntries(hard.map(k => [k, !!(gates[k] && gates[k].pass)])), eligible: allPass && !rep.failed.length};
  const report = {schema: "director-report/1", story: id, version: VERSION, data: relative(REPO, S.file), case: S.caseId, lead: S.lead,
    lStart: S.lStart, half: S.half, target_s: cfg.target_s, watch_s: watch,
    sequence: seq.items.map(x => ({id: x.id, kind: x.kind, l0: x.l0, l1: x.l1, why: x.why})), letters: seq.letters,
    log: {sequence: seq.log, compose: composeLog}, read: Object.fromEntries(Object.entries(read).map(([k, v]) => [k, {read_s: r3(v.read_s), words: v.words, lines: v.lines, missing_copy: v.missing}])),
    shots: Object.fromEntries(Object.entries(E.docs.shots.shots).map(([k, s]) => [k, {style: s.style, note: s.note || null}])),
    repair: rep, overrides: ovs, roles: roleAudit, gates, eligible: allPass && !rep.failed.length, film};
  return {S, E, report, film, beatsDoc: E.docs.beats, shotsDoc: E.docs.shots};
}

/* beats the whole-story checks flag (geometry, G3 band on the quick sizes, continuity) */
function flagged(E, opt) {
  const f = [...geomChecks(E, null).fails, ...g3Band(E, null, {np: opt.quick ? 320 : 1600, quick: !!opt.quick}).fails, ...continuity(E, 10000).fails];
  if (!opt.quick) f.push(...layoutCheck(E, null, {np: 160, quick: true, reducedBoth: false}).fails.filter(x => !/display hidden/.test(x.msg)));
  const ids = E.docs.beats.beats.map(b => b.id);
  return ids.filter(id => f.some(x => x.beat === id));
}

function metaOf(S, cfg, beats, total, seq, gen, TP) {
  const ray = S.data.geometry.ray;
  return {about: `Generated by scripts/story_director.mjs (${VERSION}) for story ${S.id} (${S.caseId}): skeleton and timing from scripts/director/cases.json and template.beats.json, l-windows from plan/1 (letters/2) via compose.sequence. Never hand-edited; rerun the director.`,
    story: S.id, case: S.caseId === "hero" ? "generic" : S.caseId, target_s: cfg.target_s,
    generator: {version: VERSION, data: {file: relative(REPO, S.file), sha256: sha(readFileSync(S.file)).slice(0, 16)},
      templates: Object.fromEntries(["template.beats.json", "template.shots.json", "cases.json", "overrides.json"].filter(f => existsSync(join(DIR, f))).map(f => [f, sha(readFileSync(join(DIR, f))).slice(0, 16)])),
      calibration: {kb: TP.T.timing.kb, alpha: TP.T.timing.alpha}, letters: seq.letters, report: `director_report_${S.id}.json`},
    refGalaxy: S.data.meta.galaxy, refRay: S.data.meta.ray, refHalf: S.half, watchTotal_s: total, fadeP: 0.004, groupGapP: 0.004, leadDefault: 0.03,
    refRayGeom: {about: "the story ray (story-data/3 geometry.ray, disk frame); the data's ray block wins", p0: ray.p0, p1: ray.p1, zdisk: [0, 0, 1]}};
}

/* G13r (director part): lettered beats sit on the plan's letter windows (so plan.slots new_dip, argmax Δτ per window,
   holds for the beats that carry it); ok:false roles drop their equations (logged) */
function g13r(S, seq, doc, roleAudit) {
  const fails = [], notes = [], slots = S.data.plan.slots;
  for (const [L, ids] of Object.entries(seq.letters)) {
    const bs = doc.beats.filter(b => ids.includes(b.id) && b.kind === "flight"); if (!bs.length) continue;
    const lo = Math.min(...bs.map(b => b.l0)), hi = Math.max(...bs.map(b => b.l1)), s = slots[L];
    const ov = Math.max(0, Math.min(hi, s.l1) - Math.max(lo, s.l0)) / Math.max(1e-9, s.l1 - s.l0);
    notes.push(`letter ${L}: beats ${ids.join("+")} cover ${r3(lo)}..${r3(hi)}, slot ${r3(s.l0)}..${r3(s.l1)} (${(100 * ov).toFixed(0)} % of the slot)`);
    if (ov < 0.999) fails.push({gate: "G13r", msg: `letter ${L} window does not cover its slot (${(100 * ov).toFixed(1)} %): plan new_dip not valid for it`});
  }
  const dropped = roleAudit.filter(a => a.kind === "okFalse").map(a => `${a.where} (${a.ref}: ${a.why})`);
  // fix2: an equation the page would drop (anchor on an ok:false role) fails; a ghost's role only names its override key
  for (const a of roleAudit) if (a.kind === "okFalse" && /\.anchor$/.test(a.where)) fails.push({gate: "G13r", msg: `${a.where}: anchor ${a.ref} is ok:false (${a.why}); the page drops this equation`});
  return {pass: !fails.length, fails, notes, dropped_equations: dropped};
}
/* G15 (director part): each lettered encounter's beat window holds ≥ 50 % of its column (lead ion of the encounter);
   its V matches the plan V within 10 km/s (galaxy frame) */
function g15(S, seq, doc) {
  const fails = [], notes = [], enc = S.data.plan.encounters || [];
  for (const [L, ids] of Object.entries(seq.letters)) {
    const s = S.data.plan.slots[L], e = enc.find(x => x.id === s.enc); if (!e) continue;
    const C = ionCells(S.data, e.lead === "HI" || e.lead === "OVI" ? e.lead : "OVI");
    const bs = doc.beats.filter(b => ids.includes(b.id) && b.kind === "flight");
    // column of the encounter: its cells (kernel centres in [l0, l1]); share inside the union of its beats' windows
    let tot = 0, inw = 0;
    for (let j = 0; j < C.n; j++) { if (C.l[j] < e.l0 || C.l[j] > e.l1 || !(C.N[j] > 0)) continue; tot += C.N[j]; if (bs.some(b => C.l[j] >= b.l0 && C.l[j] <= b.l1)) inw += C.N[j]; }
    const f = tot > 0 ? inw / tot : 0;
    notes.push(`letter ${L} (${e.id}, ${e.lead}): ${(100 * f).toFixed(1)} % of its column inside ${ids.join("+")}`);
    if (f < 0.5) fails.push({gate: "G15", msg: `letter ${L}: only ${(100 * f).toFixed(1)} % of ${e.id}'s column inside its beats`});
    const nd = s.new_dip && s.new_dip[e.lead]; if (nd && Math.abs(nd.V - e.V) > 10) fails.push({gate: "G15", msg: `letter ${L}: encounter V ${e.V} vs the window's new dip V ${nd.V}`});
  }
  return {pass: !fails.length, fails, notes};
}

/* hero check (§6.3, report only): the director on the hero ray vs the hand-tuned hero */
export async function heroCheck(M, TP, opt = {}) {
  const dataPath = opt.data || HERO_DATA;
  if (!dataPath || !existsSync(dataPath)) throw new Error(`hero check needs the hero's story-data/3 (--data); ${dataPath} missing`);
  const res = await direct("hero", M, TP, {...opt, data: dataPath, hero: true});
  const hb = readJ(join(opt.root || ROOT, "beats.json")).beats;
  const hand = {A: ["B5"], B: ["B7a", "B7b", "B7c", "B7d", "B7e"], C: ["B9"], D: ["B10"]};
  const win = (bs, ids) => { const x = bs.filter(b => ids.includes(b.id) && b.l1 !== b.l0); return x.length ? [Math.min(...x.map(b => b.l0)), Math.max(...x.map(b => b.l1))] : null; };
  const overlap = {};
  for (const [L, ids] of Object.entries(hand)) {
    const h = win(hb, ids), g = win(res.beatsDoc.beats, ids);
    if (!h || !g) { overlap[L] = {hand: h, generated: g, frac: 0}; continue; }
    const o = Math.max(0, Math.min(h[1], g[1]) - Math.max(h[0], g[0]));
    overlap[L] = {hand: h.map(r3), generated: g.map(r3), frac: r3(o / (h[1] - h[0])), pass: o / (h[1] - h[0]) >= 0.6};
  }
  const timing = {};
  for (const b of res.beatsDoc.beats) { const h = hb.find(x => x.id === b.id); if (h) timing[b.id] = {hand: h.watch_s, composed: b.watch_s, err: r3(b.watch_s / h.watch_s - 1), pass: Math.abs(b.watch_s / h.watch_s - 1) <= 0.25}; }
  const tH = hb.reduce((s, b) => s + b.watch_s, 0), tG = res.beatsDoc.beats.reduce((s, b) => s + b.watch_s, 0);
  const tw = (res.beatsDoc.meta.tf && res.beatsDoc.meta.tf.ion) || {};
  const tfc = {HI: {got: tw["ion:HI"], want: [-10.5, -0.6]}, OVI: {got: tw["ion:OVI"], want: [-10.6, -5.6]}};
  for (const v of Object.values(tfc)) v.pass = !!v.got && Math.abs(v.got[0] - v.want[0]) <= 0.3 && Math.abs(v.got[1] - v.want[1]) <= 0.3;
  res.report.hero_check = {about: "DESIGN_tierA §6.3 HC: report only; the hand-tuned hero ships, the generated hero never does",
    G1: res.report.gates.G1.pass, G3: res.report.gates.G3.pass, G12: res.report.gates.G12.pass,
    letter_overlap: overlap, letters_pass: Object.values(overlap).every(x => x.pass),
    timing: {per_beat: timing, beats_within_25pct: `${Object.values(timing).filter(x => x.pass).length}/${Object.keys(timing).length}`, total_hand: tH, total_composed: tG, total_err: r3(tG / tH - 1), total_pass: Math.abs(tG / tH - 1) <= 0.05},
    tf: tfc, tf_pass: Object.values(tfc).every(x => x.pass)};
  return res;
}

/* ---------------------------------------------------------------- CLI */
async function main() {
  const a = process.argv.slice(2), has = f => a.includes(f), val = f => { const i = a.indexOf(f); return i >= 0 ? a[i + 1] : null; };
  const report = resolve(val("--report") || (process.env.TNG_WORK ? join(process.env.TNG_WORK, "scratch/story3_w/R3") : join(REPO, "build/director")));
  mkdirSync(report, {recursive: true});
  const M = await modules(), TP = templates();
  const opt = {noRepair: has("--no-repair"), quick: has("--quick"), data: val("--data")};
  let rc = 0;
  if (has("--hero-check")) {
    const res = await heroCheck(M, TP, opt);
    writeFileSync(join(report, "director_report_hero.json"), dump(res.report));
    writeFileSync(join(report, "beats.hero_generated.json"), dump(res.beatsDoc));
    writeFileSync(join(report, "shots.hero_generated.json"), dump(res.shotsDoc));
    const h = res.report.hero_check;
    console.log(`hero check: G1 ${h.G1} G3 ${h.G3} G12 ${h.G12}; letters ${JSON.stringify(Object.fromEntries(Object.entries(h.letter_overlap).map(([k, v]) => [k, v.frac])))}; timing ${h.timing.beats_within_25pct} beats ±25 %, total ${(h.timing.total_err * 100).toFixed(1)} %; TF ${h.tf_pass}`);
    return 0;
  }
  const ids = has("--all") ? STORY_IDS : [val("--story")].filter(Boolean);
  if (!ids.length) { console.log("usage: node scripts/story_director.mjs --story <id> | --all | --hero-check [--no-repair] [--check] [--report DIR] [--data FILE]"); return 2; }
  for (const id of ids) {
    const t0 = process.hrtime.bigint();
    const res = await direct(id, M, TP, {...opt, data: ids.length === 1 ? opt.data : null});
    const files = {[join(ROOT, `beats.${id}.json`)]: dump(res.beatsDoc), [join(ROOT, `shots.${id}.json`)]: dump(res.shotsDoc), [join(ROOT, `films/${id}.json`)]: dump(res.film)};
    if (has("--check")) {
      for (const [f, s] of Object.entries(files)) { const cur = existsSync(f) ? readFileSync(f, "utf8") : ""; if (cur !== s) { console.log(`${id}: ${relative(REPO, f)} differs from a rerun`); rc = 1; } }
    } else {
      mkdirSync(join(ROOT, "films"), {recursive: true});
      for (const [f, s] of Object.entries(files)) writeFileSync(f, s);
      writeFileSync(join(report, `director_report_${id}.json`), dump(res.report));
    }
    const g = res.report.gates, sec = Number(process.hrtime.bigint() - t0) / 1e9;
    console.log(`${id}: ${res.beatsDoc.beats.length} beats, ${res.report.watch_s} s, film ${res.film.duration_s} s; ` +
      Object.entries(g).map(([k, v]) => `${k} ${v.pass ? "ok" : "FAIL"}`).join(" ") + `; eligible ${res.report.eligible}; repair failed [${res.report.repair.failed.join(",")}] (${sec.toFixed(0)} s)`);
    if (!res.report.eligible) rc = rc || 3;
  }
  return rc;
}
const isMain = process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1]);
if (isMain) main().then(rc => process.exit(rc), e => { console.error(e.stack || e); process.exit(1); });
