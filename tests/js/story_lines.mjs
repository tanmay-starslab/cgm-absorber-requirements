// fix1 (reviews H1/F1/S1, H2/F4/S8, F2): every Tier A story's observed, fit and explore panels have a spectrum to draw,
// and every panel shows its ion's absorption.
//   1. each Tier A index entry (shipped data/index.json once it is story-index/2, else R1's draft) names `line`; the page's
//      own loader (engine.completeStoryData, through lineUrl) decodes it with no lines_error;
//   2. at every B12-B14 beat (spec.mode observed/fit/explore) both dock ions get an observed spectrum (lsf/noise);
//   3. the dock window of the lead ion (dock.dockWindow, plan.vwin_ion) holds the intrinsic absorption the story data
//      carries: the darkest intrinsic point of each detected ion lies inside its panel (the ±300 km/s v2 dock cut the hot
//      story's O VI minimum at +312 km/s);
//   4. a story whose line fails to load draws a visible "did not load" note (frameModel.linesMissing), never a silent panel;
//   5. the hero (story-data/2, no plan) keeps the v2 ±300 km/s windows.
// node tests/js/story_lines.mjs
import {readFileSync, existsSync} from "node:fs";
import path from "node:path";
import {fileURLToPath, pathToFileURL} from "node:url";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const ROOT = path.join(REPO, "docs/tng50/learn/how-a-spectrum-is-made");
const imp = p => import(pathToFileURL(path.join(ROOT, p)).href);
const E = await imp("js/engine.js"), DK = await imp("js/spectrum/dock.js"), LSF = await imp("js/scenes/lsf.js"), NZ = await imp("js/scenes/noise.js"), K = await imp("js/plot.js");
let n = 0, fails = 0;
const ok = (c, m) => { n++; if (!c) { fails++; console.log("FAIL " + m); } else console.log("ok " + m); };
const J = p => JSON.parse(readFileSync(p, "utf8"));

const shipped = J(path.join(ROOT, "data/index.json"));
const draft = path.join(process.env.TNG_WORK || "/Volumes/cgm_work", "scratch/story3_w/R1/index_v2_draft.json");
const index = shipped.schema === "story-index/2" ? shipped : (existsSync(draft) ? J(draft) : null);
if (!index) { console.log("SKIP story_lines: no story-index/2"); process.exit(0); }
const base = pathToFileURL(ROOT + "/").href;
const get = async u => { if (/\/data\/index\.json$/.test(u)) return index; return J(fileURLToPath(u)); };
const getBin = async u => { const b = readFileSync(fileURLToPath(u)); return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength); };
const num = x => Array.isArray(x) ? +x[x.length - 1].v : +x;

const tier = index.stories.filter(e => e.case && e.case !== "full");
ok(tier.length >= 5, `story_lines: ${tier.length} Tier A entries in the ${index === shipped ? "shipped" : "draft"} index`);
for (const e of tier) {
  ok(typeof e.line === "string" && existsSync(path.join(ROOT, "data", e.line)), `${e.id}: index entry names a shipped line (${e.line})`);
  ok(E.lineUrl(index, e) === "data/" + e.line, `${e.id}: lineUrl resolves to the same-origin line`);
  const data = await E.completeStoryData(base, J(path.join(ROOT, "data", e.story)), get, getBin);
  ok(data.lines && data.lines.OVI && data.lines.HI && !data.lines_error, `${e.id}: completeStoryData decodes the line (${data.lines_error || "ok"})`);
  const beats = J(path.join(ROOT, e.beats)).beats;
  const T = DK.tauSet(data);
  for (const b of beats) {
    const sp = b.spec || {}; if (!["observed", "fit", "explore"].includes(sp.mode)) continue;
    const R = num(sp.R) || 30000, sn = num(sp.sn) || 0, lead = b.ion || "OVI", other = lead === "OVI" ? "HI" : "OVI";
    const got = [lead, other].map(k => { const W = DK.dockWindow(data, k), vw = Math.max(-W[0], W[1]);
      const o = sn > 0 && sn < 500 ? NZ.observedSN(data, k, R, sn, K.caseSeed(0, k, 0)) : LSF.observedR(data, k, R, vw === DK.VW ? undefined : vw + 30);
      return !!(o && o.v && o.v.length > 10 && o.model.some(Number.isFinite)); });
    ok(got.every(Boolean), `${e.id} ${b.id} (${sp.mode}, R ${R}, S/N ${sn}): both dock ions have a spectrum`);
  }
  // 3: the darkest intrinsic point of each detected ion (end of the flight, all cells crossed) is inside its panel
  for (const k of ["OVI", "HI"]) {
    const I = data.ions[k]; if (!(I.totals.logN >= 13)) continue;
    const S = T[k], tau = S.tauAt(1e9), W = DK.dockWindow(data, k);
    let jm = 0; for (let j = 1; j < S.N; j++) if (tau[j] > tau[jm]) jm = j;
    const vmin = S.grid0 + jm;
    ok(vmin >= W[0] && vmin <= W[1], `${e.id}: ${k} deepest intrinsic point ${vmin} km/s inside its panel [${W}]`);
  }
  // 4: a failed line shows the note
  const m = DK.frameModel({spec: {mode: "observed", lead: "OVI", R: 30000, sn: 0}, beat: {u: 0.5}, l: 0}, {...data, lines: null, lines_error: "HTTP 404"}, T, {});
  ok(m.linesMissing === true, `${e.id}: a missing line is flagged for the visible note`);
  // fix1 round 2 (review perf M1): the page's parallel loader (index in hand) builds the same story object
  const par = await E.loadEntryData(base, index, e, get, getBin).dataP;
  ok(JSON.stringify(Object.keys(par)) === JSON.stringify(Object.keys(data)) && JSON.stringify(par.page_fits) === JSON.stringify(data.page_fits) &&
     JSON.stringify(par.fion) === JSON.stringify(data.fion) && par.lines && par.lines.OVI.flux.length === data.lines.OVI.flux.length && !par.lines_error,
     `${e.id}: loadEntryData (parallel) equals completeStoryData (keys, page fits, f_ion, line)`);
  // fix1 round 2 (review beauty F7): far from the probe a generated story's capsule fades out; near it, it is whole
  const SK = await imp("js/core/seek.js"), shotsDoc = J(path.join(ROOT, e.shots)), beatsDoc = J(path.join(ROOT, e.beats));
  const sk = SK.makeSeek({beats: beatsDoc, shots: shotsDoc});
  let far = 0, farZero = 0, near = 0, nearFull = 0;
  for (let k = 0; k <= 400; k++) { const f = sk(k / 400, data), P = f.cam && f.cam.pos, ray = data.geometry.ray, t = f.l + ray.half;
    const q = [ray.p0[0] + t * ray.n[0], ray.p0[1] + t * ray.n[1], ray.p0[2] + t * ray.n[2]], d = Math.hypot(P[0] - q[0], P[1] - q[1], P[2] - q[2]);
    if (d >= SK.CAPSULE_FADE.far) { far++; if (f.capsule.r === 0) farZero++; } if (d <= SK.CAPSULE_FADE.near) { near++; if (f.capsule.r > 0 && f.capsule.r >= SK.CAPSULE.rMin) nearFull++; } }
  ok(farZero === far && nearFull === near, `${e.id}: capsule off in all ${far} frames >= ${SK.CAPSULE_FADE.far} kpc from the probe, whole in all ${near} frames within ${SK.CAPSULE_FADE.near} kpc`);
}
/* fix1 round 2 (review beauty F4): multiphase B7p tethers the cool cloud to its H I dip and the hot cloud to its O VI dip */
{
  const LK = await imp("js/spectrum/link.js"), e = tier.find(x => x.id === "multiphase");
  if (e) {
    const data = J(path.join(ROOT, "data", e.story)), cl = path.join(ROOT, "data", data.clouds.path);
    if (existsSync(cl)) data.clouds_full = J(cl);
    const geom = {top: 600, vw: 1440, panels: {OVI: {x: 100, w: 600, v0: -300, v1: 300}, HI: {x: 760, w: 600, v0: -300, v1: 300}}};
    const project = p => ({x: 700 + 0.5 * p[0], y: 300 + 0.5 * p[1], ok: true});
    const fs = {beat: {id: "B7p", u: 0.5}, spec: {lead: "HI", mode: "intrinsic"}, cell: {idx: 0, w: 1}, l: 0, shells: []};
    const T = LK.tethers(fs, data, geom, project), byIon = Object.fromEntries(T.map(t => [t.ion, t]));
    const cv = data.claims.cool_v.value, wv = data.claims.warm_v.value;
    ok(T.length === 2 && byIon.HI && byIon.OVI && byIon.HI.ring && byIon.OVI.ring, `multiphase B7p: two ringed tethers, cool -> H I and hot -> O VI (${T.map(t => t.id + ":" + t.ion).join(", ")})`);
    ok(byIon.HI && Math.abs(byIon.HI.b.x - LK.panelX(geom.panels.HI, cv)) < 8 && byIon.OVI && Math.abs(byIon.OVI.b.x - LK.panelX(geom.panels.OVI, wv)) < 8,
       `multiphase B7p: tethers land on the H I dip near ${cv} km/s and the O VI dip near ${wv} km/s`);
    ok(LK.connector(fs, data, geom, project) === null, "multiphase B7p: the single probe connector gives way to the pair");
    ok(LK.tethers({...fs, beat: {id: "B7p", u: 0.05}}, data, geom, project).length === 0, "multiphase B7p: no tethers during the blend-in");
  }
}
const hero = J(path.join(ROOT, "data/story_488530_rand_b062_a062.json"));
ok(JSON.stringify(DK.dockWindows(hero)) === JSON.stringify({OVI: [-300, 300], HI: [-300, 300]}), "hero: dock windows stay ±300 km/s (no plan)");
console.log(`${fails ? "FAIL" : "PASS"} story_lines: ${n} checks, ${fails} failures`);
process.exit(fails ? 1 : 0);
