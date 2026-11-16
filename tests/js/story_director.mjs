// Offline camera director (DESIGN_tierA §6, unit R3): node tests/js/story_director.mjs   (no browser; run_all picks it up)
// Checks:
//   calibrate  the templates on disk equal a fresh calibration from the hand-tuned hero (byte-identical)
//   compose    per story (no repair, fast): beats contiguous over p, l-windows contiguous from lStart to +half, every
//              lettered slot covered by its beats, Tier A beats only where their case and flag allow, watch ≤ 40 s per beat
//   roles      an unknown @role throws in the director (§6.2 step 9)
//   variants   the repair list is fixed: design order first (calibrated, az ±20/40/60, flip, el, scale), no duplicates
//   outputs    for each ROOT/beats.<id>.json on disk: timeline.validate with beats.schema.json, shots exist, roles resolve,
//              meta.tf passes tfstory.checkTFBlock, films/<id>.json chunks contiguous and 80-120 s; the empty story is
//              re-directed in full and must be byte-identical to the files on disk (determinism)
import fs from "node:fs";
import path from "node:path";
import {execFileSync} from "node:child_process";
import {fileURLToPath, pathToFileURL} from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url)), REPO = path.resolve(HERE, "../..");
const ROOT = path.join(REPO, "docs/tng50/learn/how-a-spectrum-is-made");
const D = await import(pathToFileURL(path.join(REPO, "scripts/story_director.mjs")).href);
const C = await import(pathToFileURL(path.join(REPO, "scripts/director/compose.mjs")).href);
const St = await import(pathToFileURL(path.join(REPO, "scripts/director/styles.mjs")).href);
const R = await import(pathToFileURL(path.join(REPO, "scripts/director/repair.mjs")).href);
const TF = await import(pathToFileURL(path.join(ROOT, "js/stage/tfcase.js")).href).catch(() => null);   // fix1 round 2 (M2): checkTFBlock moved
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log("ok   " + m); } else { fail++; console.log("FAIL " + m); } };
const J = f => JSON.parse(fs.readFileSync(f, "utf8"));

/* calibrate */
{
  let rc = 0; try { execFileSync(process.execPath, [path.join(REPO, "scripts/director/calibrate.mjs"), "--check"], {stdio: "pipe"}); } catch (e) { rc = e.status || 1; }
  ok(rc === 0, "calibrate: template.beats.json and template.shots.json equal a fresh calibration from the hero");
}
const M = await D.modules(), TP = D.templates();
const dataDir = path.join(ROOT, "data/v3");
const have = fs.existsSync(dataDir);
if (!have) console.log("skip: no data/v3 (R1 story-data/3 files)");

/* compose */
if (have) for (const id of D.STORY_IDS) {
  let S; try { S = D.context(id, M, TP); } catch (e) { console.log(`skip ${id}: ${e.message}`); continue; }
  const cfg = S.cfg, seq = C.sequence(S, cfg);
  const {beats} = C.buildBeats(S, cfg, TP.tpl, {D: M.D, kb: TP.T.timing.kb, alpha: TP.T.timing.alpha}, seq);
  let cont = beats[0].p0 === 0 && beats[beats.length - 1].p1 === 1;
  for (let i = 1; i < beats.length; i++) cont = cont && Math.abs(beats[i].p0 - beats[i - 1].p1) < 1e-12 && beats[i].p1 > beats[i].p0;
  ok(cont, `compose ${id}: beats contiguous over p ∈ [0, 1] (${beats.length} beats)`);
  let lc = true, cur = beats[0].l0;
  for (const b of beats) { if (Math.abs(b.l0 - cur) > 1e-3) lc = false; cur = b.kind === "flight" ? b.l1 : b.l0; }
  ok(lc && Math.abs(beats[0].l0 - S.lStart) < 1e-3 && Math.abs(cur - S.half) < 1e-3, `compose ${id}: l-windows contiguous from ${S.lStart.toFixed(1)} to +${S.half.toFixed(1)}`);
  const cover = Object.entries(seq.letters).every(([L, ids]) => { const s = S.data.plan.slots[L], bs = beats.filter(b => ids.includes(b.id) && b.kind === "flight");
    return bs.length && Math.min(...bs.map(b => b.l0)) <= s.l0 + 1e-3 && Math.max(...bs.map(b => b.l1)) >= s.l1 - 1e-3; });
  ok(cover, `compose ${id}: every lettered slot is flown by its beats (${Object.keys(seq.letters).join("") || "none"})`);
  const ids = beats.map(b => b.id);
  const allowed = {B7p: "multiphase", B10w: "damped", B12n: "empty_faint"};
  ok((!ids.includes("B7p") || S.caseId === "multiphase") && (!ids.includes("B10w") || S.caseId === "damped") && (!ids.includes("B12n") || S.caseId === "empty"),
    `compose ${id}: Tier A beats only in their case (${ids.filter(x => allowed[x]).join(",") || "none"})`);
  ok(beats.every(b => !b.cond || S.flags[b.cond] === true), `compose ${id}: every beat's cond flag holds for this ray`);
  ok(beats.every(b => b.watch_s > 0 && b.watch_s <= 40), `compose ${id}: watch_s in (0, 40] s per beat`);
  if (S.caseId === "empty") ok(!beats.some(b => b.kind === "stop") && !Object.keys(seq.letters).length, "compose empty: no stops, no letters (no cloud orbits)");
}

/* roles */
if (have) {
  const S = D.context("damped", M, TP), Sc = St.scales(S);
  const beats = {schema: "story-beats/3", meta: {}, beats: [{id: "B0", p0: 0, p1: 1, kind: "gate", l0: -S.half, l1: -S.half, ion: "OVI", shot: "x", tf: [{u: 0, preset: "density"}], dock: "strip", text: [], eqs: []}]};
  const shots = {shots: {x: {keys: [{u: 0, kind: "orbit", center: {cell: "@nope"}, r: 10}]}}};
  let threw = false; try { R.auditRoles({S, Sc, docs: {beats, shots}, M, data: S.data}); } catch (e) { threw = /@nope/.test(e.message); }
  ok(threw, "roles: an unknown @role throws in the director");
}

/* variants */
{
  const tags = St.VARIANTS.map(v => v.tag);
  ok(tags.slice(0, 13).join() === "calibrated,az+20,az-20,az+40,az-40,az+60,az-60,flip,el15,el30,scale1.25,scale0.8,scale1.6", "variants: the design's repair order comes first");
  ok(new Set(tags).size === tags.length, `variants: ${tags.length} distinct tags, fixed order`);
}

/* outputs */
const schema = J(path.join(ROOT, "beats.schema.json"));
for (const id of D.STORY_IDS) {
  const bf = path.join(ROOT, `beats.${id}.json`), sf = path.join(ROOT, `shots.${id}.json`), ff = path.join(ROOT, `films/${id}.json`);
  if (!fs.existsSync(bf)) { console.log(`skip outputs ${id}: no beats.${id}.json`); continue; }
  const b = J(bf), s = J(sf), film = J(ff);
  const v = M.TL.createTimeline(b, {shots: s, schema}).validate();
  ok(v.length === 0, `outputs ${id}: beats.${id}.json valid (schema story-beats/3, registry, continuity)${v.length ? ": " + v.slice(0, 3).join("; ") : ""}`);
  let S = null; try { S = D.context(id, M, TP); } catch {}
  if (S) { let e = null; try { R.auditRoles({S, docs: {beats: b, shots: s}, M, data: S.data}); } catch (x) { e = x.message; } ok(!e, `outputs ${id}: every role resolves${e ? ": " + e : ""}`); }
  if (TF) { const errs = TF.checkTFBlock(b.meta.tf); ok(!errs.length, `outputs ${id}: meta.tf usable by tfstory (${errs.join("; ") || "ok"})`); }
  const ids = b.beats.map(x => x.id); let fc = true, last = -1;
  for (const c of film.chunks) { const i0 = ids.indexOf(c.beats[0]); fc = fc && i0 > last && c.beats.every((x, k) => ids[i0 + k] === x); last = ids.indexOf(c.beats[c.beats.length - 1]); }
  ok(fc && film.duration_s >= 80 && film.duration_s <= 120 && film.chunks.every(c => Number.isInteger(c.s * 30)), `outputs ${id}: film plan ${film.duration_s} s, ${film.chunks.length} chunks in story order`);
  // R8: an unfaded edge stays put, as on the hero (Watch must end on the closing line, not on an empty card)
  const bad = b.beats.flatMap(x => (x.text || []).filter(t => (x.id === "B0" && t.fadeIn === 0 && t.u0 !== 0) || (x.p1 === 1 && t.fadeOut === 0 && t.u1 !== 1)).map(t => `${x.id}/${t.id} ${t.u0}..${t.u1}`));
  ok(!bad.length, `outputs ${id}: B0 opens at u0 0 and the last beat's unfaded line stays to p = 1${bad.length ? ": " + bad.join(", ") : ""}`);
}
if (have && fs.existsSync(path.join(ROOT, "beats.empty.json"))) {
  const res = await D.direct("empty", M, TP, {});
  const dump = o => JSON.stringify(o, null, 1) + "\n";
  ok(dump(res.beatsDoc) === fs.readFileSync(path.join(ROOT, "beats.empty.json"), "utf8") && dump(res.shotsDoc) === fs.readFileSync(path.join(ROOT, "shots.empty.json"), "utf8") &&
     dump(res.film) === fs.readFileSync(path.join(ROOT, "films/empty.json"), "utf8"), "determinism: re-directing the empty story reproduces its three files byte for byte");
}
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
