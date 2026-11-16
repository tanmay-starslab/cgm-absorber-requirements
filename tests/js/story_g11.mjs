// Pixel gates of the story v2 on real frames (DESIGN_final §4 G11 negative space, G4 contrast). U_qa, §5.10.
//
//   node tests/js/story_g11.mjs                           self-test on synthetic frames (PNG encode -> decode -> gate)
//   node tests/js/story_g11.mjs --png F.png [--bg B.png] [--band x,y,w,h] [--exempt]   judge one frame
//   TNG_BROWSER=1 node tests/js/story_g11.mjs [docs/tng50] [--shots DIR] [--out DIR] [--viewports 1440x900,390x844]
//        [--luma rel|srgb] [--edge BIN]
//
// G11 (frozen in notes/story2/S0.md §4 as `G11_dark_frac: 0.55`, `G11_dark_lum: 0.12`, `G11_band_p95: 0.35`): at the
//      midpoint of every flight beat except B2 and B6 (where the diffuse medium is the subject), >= 55 % of the frame's
//      pixels have luminance < 0.12, and the 95th percentile of the background luminance inside each text band is < 0.35.
//      Luminance is WCAG relative luminance, the definition S0 measured with (U_stage s0.js lumStats); a `G11_luma: srgb`
//      line in S0.md or --luma srgb switches to Rec. 709 luma of the encoded values. The self-test re-measures the S0 A100
//      frames (when the scratch shots exist) and must reproduce the S0 §4 table to 0.01.
// G4: every visible, unoccluded (elementFromPoint at each line's middle hits the text), fully opaque DOM text box has >= 4.5:1 contrast between its colour and both the 5th and the 95th
//      percentile of the background luminance under it (bound equation values included). Background frame = the same
//      frame with all text made transparent (cards, scrims and the volume stay), so the measured background is what
//      the text is read against. Text drawn inside a canvas is not covered (noted).
// Run on a GPU node for the real volume (ongpu, or story_qa.sbatch QA_SET=gpu); on SwiftShader the frames are those of
// the software path. v1: every 3rd step at the given viewports (no bands; G11 is reported, the v1 page is not dark-sky
// by design). Every frame is written to --shots for a person to look at.
//
// Tier A (R4, DESIGN_tierA §1 G14, §6.2 step 10):
//   G14 subject visibility: at each cloud-beat midpoint the lettered cloud's projected box has >= 3 % of its pixels with
//      relative luminance > 0.25 (limits from tests/gates.json). Empty case: no cloud beats, but >= 2 % of the frame's
//      pixels > 0.15 in B1/B2 (the halo must not render black). The acceptance's "saturated band" defect is read as a clipped
//      subject: a cloud box with >= 50 % of its pixels at luminance >= 0.95 is a white blob, not a cloud, and fails too.
//   TF: deriveTFBlock(story, galaxyVolWindow, {camDist, tube, step}) is the meta.tf the director writes (R3 imports it);
//      js/stage/tfstory.js applyStoryTF applies it. Calibration on the hero: see TF_HERO below.
//   node tests/js/story_g11.mjs --tf [--out DIR]          print (and write tf_<id>.json) the derived block per v3 story
//   TNG_BROWSER=1 node tests/js/story_g11.mjs --g14 --story id[,id] [docs/tng50] [--viz DIR] [--shots DIR] [--out DIR]
//        G14 frames of ?story=<id> (R7, GPU node: TNG_GPU=1); --mode empty measures B1/B2 full frames for any story. TF repair steps are written into beats.<id>.json by the
//        director (deriveTFBlock step 1/2), never by this test.
//   Imported by the director for deriveTFBlock / evalG14: the checks below run only when this file is the entry point.
import {existsSync, readFileSync, writeFileSync, mkdirSync, readdirSync} from "node:fs";
import {gunzipSync} from "node:zlib";
import {pathToFileURL} from "node:url";
import {join, resolve, relative} from "node:path";
import {parseArgs, checker, launch, BLOCK, sleep} from "./lib/browser.mjs";
import {REPO, STORY_REL, G11, evalPixels, decodePNG, encodePNG, synthImage, report, writeResult, plainEdge, edgeWith, gzServe, setViewport, detect,
  positions, goTo, snapshot, screenshot, GPU_FLAGS, lumSamples, quantile, storyAssets, assetQuery, waitResident, RESIDENT} from "./lib/storyqa.mjs";

/* ================================================================ Tier A: G14 and the per-story TF (R4) */
const GATES = JSON.parse(readFileSync(join(REPO, "tests/gates.json"), "utf8"));
const G14L = (GATES.gates.find(g => g.id === "G14") || {}).limits || {};
/** G14 limits (tests/gates.json) plus the clipped-subject reading of the "saturated band" acceptance defect */
export const G14 = {cloudPx: G14L.cloud_px_frac ?? 0.03, cloudLum: G14L.cloud_lum ?? 0.25, emptyPx: G14L.empty_halo_px_frac ?? 0.02,
  emptyLum: G14L.empty_halo_lum ?? 0.15, emptyMax: G14L.empty_halo_max_px_frac ?? 0.30, satLum: 0.95, satFrac: 0.5};
/** s = {name, img, box ({x, y, w, h} CSS px, cloud mode), scale, mode: "cloud" | "empty"} -> {fails, notes, frac, sat} */
export function evalG14(s, L = G14) {
  const fails = [], notes = [], nm = s.name || "frame", f = msg => fails.push({gate: "G14", msg: `${nm}: ${msg}`});
  if (s.mode === "empty") {
    const v = lumSamples(s.img, null, {step: 1, scale: 1}), frac = v.filter(x => x > L.emptyLum).length / v.length;
    if (!(frac >= L.emptyPx)) f(`empty halo too dark: ${(100 * frac).toFixed(2)} % of pixels > ${L.emptyLum} (needs >= ${100 * L.emptyPx} %)`);
    // fix2 (review2 R2-B9): "too faint to see" must not be a saturated disc filling the frame (CPU shot: 61 %)
    else if (frac > L.emptyMax) f(`empty halo saturated: ${(100 * frac).toFixed(1)} % of pixels > ${L.emptyLum} (at most ${100 * L.emptyMax} %)`);
    else notes.push(`${nm}: halo ${(100 * frac).toFixed(1)} % of pixels > ${L.emptyLum}`);
    return {fails, notes, frac};
  }
  const b = s.box;
  if (!b || !(b.w >= 2 && b.h >= 2)) { f("lettered cloud has no on-screen box (behind the camera or off frame)"); return {fails, notes, frac: 0}; }
  const v = lumSamples(s.img, b, {step: 1, scale: s.scale || 1}), frac = v.filter(x => x > L.cloudLum).length / v.length,
    sat = v.filter(x => x >= L.satLum).length / v.length;
  if (!(frac >= L.cloudPx)) f(`cloud invisible: ${(100 * frac).toFixed(2)} % of its box > ${L.cloudLum} (needs >= ${100 * L.cloudPx} %)`);
  if (sat >= L.satFrac) f(`cloud clipped white: ${(100 * sat).toFixed(0)} % of its box >= ${L.satLum} (a saturated band, not a cloud)`);
  if (!fails.length) notes.push(`${nm}: cloud ${(100 * frac).toFixed(1)} % > ${L.cloudLum}, ${(100 * sat).toFixed(1)} % clipped`);
  return {fails, notes, frac, sat};
}

/* ---- per-story TF (DESIGN_tierA §6.2 step 10) ----
   Measured on the hero (488530 rand_b062_a062, its story-tube/1 near-field cells): the plain [p5, p99.5] percentiles land
   0.36-2.05 dex from the hand windows (H I [-10.855, -2.447] vs [-10.5, -0.6]; O VI [-12.298, -7.655] vs [-10.6, -5.6]),
   because the hand windows serve the whole cube (the disk and dense clumps far off the ray) and their tops sit above every
   tube cell. No percentile pair fits both ions (the tops lie above the tube maximum), so the one allowed refit is an offset
   per window end fitted on the hero: win = P(story) + (hand - P(hero)), clamped to +-1.5 dex of the galaxy's manifest
   vol_window. On the hero this returns the hand windows exactly (0 dex). The 50/80/95 % band percentiles miss the hand
   bands by 0.8-2.7 dex on the hero and come out unordered on the empty ray, so the lead bands keep the hand bands'
   fractional places in the window. Density: the n_H opacity floor follows the ray's n_H p5 offset from the hero, the top
   follows the galaxy manifest top. Fog = [0.4, 1.4] x the director's camera distance (hero: 100 kpc -> [40, 140]). */
export const TF_HERO = {galaxy: 488530, ray: "rand_b062_a062", pctl: [5, 99.5],
  tube: {HI: [-10.855, -2.447], OVI: [-12.298, -7.655], nH: [-4.71, -2.357]},
  hand: {"ion:HI": [-10.5, -0.6], "ion:OVI": [-10.6, -5.6]}, bands: {"ion:HI": [-7.5, -5.0, -2.5], "ion:OVI": [-8.4, -7.5, -6.6]},
  volWin: [-3.6, 0.4], nHTop: 0.4, fogK: [0.4, 1.4], camDist: 100, speed: [-150, 150]};
export const EMPTY_HALO_GAIN = 3.0;
const r3 = x => Math.round(x * 1000) / 1000, clampv = (x, a, b) => Math.max(a, Math.min(b, x));
/** story-tube/1 records (14 B little endian, gz) -> {lognH, lognHI, lognOVI, hasHI, hasOVI} (scripts/story_plan.py tube_records) */
export function decodeTube(buf) {
  const raw = gunzipSync(buf), n = raw.length / 14, o = {lognH: new Float64Array(n), lognHI: [], lognOVI: []};
  for (let i = 0; i < n; i++) { const b = 14 * i; o.lognH[i] = raw[b + 6] / 255 * 8 - 7;
    if (raw[b + 10]) o.lognHI.push(raw[b + 10] / 255 * 16 - 16); if (raw[b + 11]) o.lognOVI.push(raw[b + 11] / 255 * 16 - 16); }
  return o;
}
/** numpy-style linear percentile */
export function pctl(arr, q) { const s = Float64Array.from(arr).sort(), x = (s.length - 1) * q / 100, i = Math.floor(x);
  return i + 1 < s.length ? s[i] + (s[i + 1] - s[i]) * (x - i) : s[i]; }
/** meta.tf for one story-data/3 story. gw: the galaxy manifest vol_window ({nH, HI, OVI, ...}); tube: decodeTube output
    (needed for step > 0); step 0/1/2 = ion top percentile 99.5/99/98, fog x1/x1.2/x1.44 and the n_H opacity top 0/-0.75/-1.5 dex
    (the GPU G11/G14 repair, at most twice; the n_H part is what reaches the `halo` preset, which has no fog) */
export function deriveTFBlock(story, gw, {camDist = TF_HERO.camDist, tube = null, step = 0} = {}) {
  const H = TF_HERO, tw = story.tf_windows || {}, srcs = tw.sources || {}, lead = "ion:" + ((story.plan || {}).lead_ion || "HI");
  const top = [99.5, 99, 98][step];
  if (step && !tube) throw new Error("deriveTFBlock: a step needs the decoded tube");
  const ion = {}, notes = [];
  for (const [id, w] of Object.entries(tw)) {
    if (!/^ion:/.test(id) || !Array.isArray(w)) continue;
    const k = id.slice(4), start = gw[k];
    if (!start) { notes.push(`${id}: no manifest window, dropped`); continue; }
    let lo, hi;
    if (H.hand[id] && srcs[id] === "tube") {
      const P = step ? [w[0], pctl(tube["logn" + k], top)] : w;   // a step lowers the top percentile only (brighter)
      lo = clampv(P[0] + H.hand[id][0] - H.tube[k][0], start[0] - 1.5, start[0] + 1.5);
      hi = clampv(P[1] + H.hand[id][1] - H.tube[k][1], start[1] - 1.5, start[1] + 1.5);
    } else { [lo, hi] = start; notes.push(`${id}: galaxy manifest window (${srcs[id] || "no"} percentiles, no hero calibration)`); }
    if (hi - lo < 2) { const c = (lo + hi) / 2; lo = c - 1; hi = c + 1; notes.push(`${id}: widened to 2 dex`); }
    ion[id] = [r3(lo), r3(hi)];
  }
  const lw = ion[lead], hb = H.bands[lead] || H.bands["ion:OVI"], hw = H.hand[lead] || H.hand["ion:OVI"];
  const bands = lw ? hb.map(c => r3(lw[0] + (c - hw[0]) / (hw[1] - hw[0]) * (lw[1] - lw[0]))) : undefined;
  const p5 = tube ? pctl(tube.lognH, 5) : (tw.density || [H.tube.nH[0]])[0];
  const dlo = srcs.density === "tube" || tube ? clampv(p5 - H.tube.nH[0], -1.5, 1.5) : 0, dhi = gw.nH ? gw.nH[1] - H.nHTop : 0;
  const fk = [1, 1.2, 1.44][step];
  const out = {source: tw.source === "manifest" ? "manifest" : "tube", lead, pctl: [5, top],
    vol_window: [r3(H.volWin[0] + dlo), r3(H.volWin[1] + dhi - 0.75 * step)], ion, ...(bands ? {bands} : {}),
    speed: Array.isArray(tw.speed) ? tw.speed.slice() : H.speed.slice(), fog: H.fogK.map(k => r3(k * camDist * fk))};
  // empty case: the faint halo stays in magma's dark purples (relative luminance < 0.15) under any window; at gain 3 the
  // A100 B2 frame goes from 1.0 % to 11.5 % of pixels > 0.15 with the text column still dark (R4 GPU runs 1388845, 1390248)
  if ((story.case || {}).declared === "empty") out.look = {halo: {gain: EMPTY_HALO_GAIN}};
  if (step) out.steps = [1, 2].slice(0, step).map(s => ({step: s, pctl_top: [99.5, 99, 98][s], fog_k: [1, 1.2, 1.44][s], nH_top_dex: -0.75 * s, why: "GPU G11/G14 repair"}));
  Object.defineProperty(out, "notes", {value: notes, enumerable: false});
  return out;
}

const ROOT_DIR = join(REPO, "docs/tng50", STORY_REL);
const v3Stories = () => { const d = join(ROOT_DIR, "data/v3"); return existsSync(d) ? readdirSync(d).filter(f => /^story_\d+_.+\.json$/.test(f)).sort()
  .map(f => ({file: f, story: JSON.parse(readFileSync(join(d, f), "utf8"))})) : []; };
const STORY_ID = {clean_single: "clean", multiphase: "multiphase", damped: "damped", empty: "empty", hot_only: "hot"};
/** galaxy manifest vol_window: scripts/director/hosted_cover.json (R3's copy) or R1's audit, else the local cube manifest */
export function galaxyVolWindow(g) {
  for (const f of [join(REPO, "scripts/director/hosted_cover.json"), join(process.env.CGM_WORK || process.env.TNG_WORK || "/Volumes/cgm_work", "scratch/story3_w/R1/hosted_cover.json")])
    if (existsSync(f)) { const h = JSON.parse(readFileSync(f, "utf8")); const w = h.hosts && h.hosts[String(g)] && h.hosts[String(g)].vol_window; if (w) return w; }
  const m = join(process.env.CGM_WORK || process.env.TNG_WORK || "/Volumes/cgm_work", `data/gal/${g}/viz/manifest_v2.json`);
  if (existsSync(m)) { const j = JSON.parse(readFileSync(m, "utf8")); if (j.vol_window) return j.vol_window; }
  return null;
}
export const tubeOf = st => { const p = st.tube && st.tube.path; const f = p && [join(ROOT_DIR, "data", p.replace(/\.json$/, ".bin.gz")), join(ROOT_DIR, "data", p)].find(x => existsSync(x) && /\.gz$/.test(x));
  return f ? decodeTube(readFileSync(f)) : null; };

async function tierASelfTest(C) {
  // fix1 round 2 (M2): the per-story block functions moved to js/stage/tfcase.js (loaded only by a case story)
  const TFS = {...await import(pathToFileURL(join(ROOT_DIR, "js/stage/tfstory.js")).href), ...await import(pathToFileURL(join(ROOT_DIR, "js/stage/tfcase.js")).href)};
  const {schemaErrors} = await import(pathToFileURL(join(ROOT_DIR, "js/engine.js")).href);
  const schema = JSON.parse(readFileSync(join(ROOT_DIR, "beats.schema.json"), "utf8"));
  const tfSchema = {...schema.$defs.tfBlock, $defs: schema.$defs};
  /* 1. hero calibration: the constants re-measured from the hero tube, and the derived hero windows vs the hand ones */
  const heroFile = join(ROOT_DIR, "data/tube/488530_rand_b062_a062.bin.gz");
  if (existsSync(heroFile)) {
    const t = decodeTube(readFileSync(heroFile)), m = {HI: [pctl(t.lognHI, 5), pctl(t.lognHI, 99.5)], OVI: [pctl(t.lognOVI, 5), pctl(t.lognOVI, 99.5)], nH: [pctl(t.lognH, 5), pctl(t.lognH, 99.5)]};
    const d = Math.max(...Object.keys(m).flatMap(k => m[k].map((v, i) => Math.abs(v - TF_HERO.tube[k][i]))));
    C.check(d < 0.002, `TF_HERO tube percentiles re-measured from the hero tube (max diff ${d.toFixed(4)} dex)`);
    const raw = Math.max(...["HI", "OVI"].flatMap(k => m[k].map((v, i) => Math.abs(v - TF_HERO.hand["ion:" + k][i]))));
    C.note(`plain [p5, p99.5] on the hero misses the hand windows by up to ${raw.toFixed(2)} dex: refitted once as hero offsets (see TF_HERO)`);
    const hs = {plan: {lead_ion: "HI"}, tf_windows: {source: "tube", sources: {"ion:HI": "tube", "ion:OVI": "tube", density: "tube"},
      "ion:HI": m.HI.map(r3), "ion:OVI": m.OVI.map(r3), density: m.nH.map(r3), speed: [-150, 150]}};
    const hb = deriveTFBlock(hs, galaxyVolWindow(488530) || {nH: [-4.4, 0.4], HI: [-10.5, -0.6], OVI: [-10.6, -5.6]});
    const cal = Math.max(...["ion:HI", "ion:OVI"].flatMap(id => hb.ion[id].map((v, i) => Math.abs(v - TF_HERO.hand[id][i]))));
    C.check(cal <= 0.3, `TF calibration on the hero: derived windows within ${cal.toFixed(3)} dex of H I -10.5/-0.6 and O VI -10.6/-5.6 (limit 0.3)`);
    const bd = Math.max(...hb.bands.map((c, i) => Math.abs(c - TF_HERO.bands["ion:HI"][i])));
    C.check(bd <= 0.3 && Math.abs(hb.vol_window[0] + 3.6) < 0.01 && hb.fog[0] === 40 && hb.fog[1] === 140, `TF calibration on the hero: bands within ${bd.toFixed(3)} dex, density window and fog [40, 140] reproduced`);
    const s1 = deriveTFBlock(hs, galaxyVolWindow(488530) || {nH: [-4.4, 0.4], HI: [-10.5, -0.6], OVI: [-10.6, -5.6]}, {tube: t, step: 2});
    C.check(s1.ion["ion:HI"][1] < hb.ion["ion:HI"][1] && s1.fog[1] > hb.fog[1] && s1.steps.length === 2 && !TFS.checkTFBlock(s1).length,
      `TF repair step 2 (p98, fog x1.44) brightens: H I top ${hb.ion["ion:HI"][1]} -> ${s1.ion["ion:HI"][1]}, fog ${s1.fog.join("-")} kpc, logged`);
  } else C.note("hero tube missing: TF calibration skipped");
  /* 2. each v3 story: a valid, schema-clean block; the empty halo emits under its own window but not under the hero's */
  for (const {file, story} of v3Stories()) {
    const id = STORY_ID[(story.case || {}).declared] || file, g = (story.galaxy || {}).id, gw = galaxyVolWindow(g);
    if (!C.check(!!gw, `${id}: galaxy ${g} manifest vol_window found`)) continue;
    const b = deriveTFBlock(story, gw), e = TFS.checkTFBlock(b), se = schemaErrors(tfSchema, JSON.parse(JSON.stringify(b)));
    C.check(!e.length && !se.length, `${id}: meta.tf valid (${e.concat(se.map(x => x.msg || String(x))).join("; ") || "ok"}): ${JSON.stringify(b.ion)} vol ${b.vol_window.join(",")}`);
    const t = tubeOf(story);
    if (t && story.case.declared === "empty") {
      const em = lo => t.lognH.filter(v => v > lo).length / t.lognH.length;
      const heroLo = -4.6, ownLo = -4.6 + (b.vol_window[0] + 3.6);
      C.check(b.look && b.look.halo.gain === EMPTY_HALO_GAIN, `${id}: halo look gain ${EMPTY_HALO_GAIN} for the empty case`);
      C.check(em(heroLo) < 0.05 && em(ownLo) >= 0.5, `${id}: under the hero's halo ramp only ${(100 * em(heroLo)).toFixed(1)} % of the ray's tube cells emit (a black halo); under its own (from 10^${ownLo.toFixed(2)}) ${(100 * em(ownLo)).toFixed(0)} %`);
    }
    const r = TFS.applyStoryTF(b);
    C.check(r.ok && TFS.PRESETS[b.lead].state().win[0] === b.ion[b.lead][0] && TFS.presetBytes(b.lead).bytes.length === TFS.TF_W * TFS.TF_H * 4,
      `${id}: applyStoryTF retunes ${b.lead} to ${b.ion[b.lead].join("..")} and builds its TF`);
    for (const x of Object.keys(b.ion)) if (!TFS.PRESETS[x]) C.check(false, `${id}: no preset for ${x} after applyStoryTF`);
    TFS.resetStoryTF();
  }
  /* 3. hero untouched: every preset's bytes and uniforms equal before/after apply + reset; a bad block changes nothing */
  const snap = () => Object.keys(TFS.PRESETS).sort().map(id => { const p = TFS.presetBytes(id), u = TFS.blendTF(id);
    return id + ":" + (p.bytes ? Buffer.from(p.bytes).toString("base64").length + ":" + Buffer.from(p.bytes).reduce((a, x, i) => (a + x * (i % 251 + 1)) % 1e9, 0) : "vel") + JSON.stringify(u.uniforms) + JSON.stringify(u.fog); }).join("|");
  const s0 = snap(), any = v3Stories()[0];
  if (any) { TFS.applyStoryTF(deriveTFBlock(any.story, galaxyVolWindow(any.story.galaxy.id))); const s1 = snap(); TFS.resetStoryTF();
    C.check(s1 !== s0 && snap() === s0, "applyStoryTF changes the presets and resetStoryTF restores the hero's bytes exactly"); }
  /* 4. seeded defects (acceptance): invisible cloud, black empty halo, saturated band; controls pass */
  const W = 320, H = 200, box = {x: 120, y: 60, w: 80, h: 80}, inB = (x, y) => x >= box.x && x < box.x + box.w && y >= box.y && y < box.y + box.h;
  const rt = img => decodePNG(encodePNG(img));
  const cloud = rt(synthImage(W, H, (x, y) => inB(x, y) && (x - 160) ** 2 + (y - 100) ** 2 < 500 ? [150, 170, 250] : [6, 8, 14]));
  const invisible = rt(synthImage(W, H, (x, y) => inB(x, y) && (x - 160) ** 2 + (y - 100) ** 2 < 500 ? [40, 44, 70] : [6, 8, 14]));
  const clipped = rt(synthImage(W, H, (x, y) => inB(x, y) ? [255, 255, 255] : [6, 8, 14]));
  const halo = rt(synthImage(W, H, (x, y) => (x - 160) ** 2 + (y - 100) ** 2 < 4200 ? [200, 120, 90] : [6, 8, 14]));
  const black = rt(synthImage(W, H, () => [6, 8, 14]));
  for (const [nm, s, fail] of [["visible cloud (control)", {img: cloud, box}, false], ["seeded invisible cloud", {img: invisible, box}, true],
    ["seeded saturated band (clipped cloud)", {img: clipped, box}, true], ["cloud box off screen", {img: cloud, box: null}, true],
    ["glowing empty halo (control)", {img: halo, mode: "empty"}, false], ["seeded black empty halo", {img: black, mode: "empty"}, true],
    ["seeded saturated empty halo", {img: rt(synthImage(W, H, (x, y) => (x - 160) ** 2 + (y - 100) ** 2 < 40000 ? [240, 140, 230] : [6, 8, 14])), mode: "empty"}, true]]) {
    const r = evalG14({name: nm, ...s});
    C.check(fail ? r.fails.length > 0 : !r.fails.length, `G14 self-test "${nm}": ${fail ? "fails" : "passes"} (${r.fails.map(x => x.msg).join("; ") || r.notes.join("; ")})`);
  }
  const lead = {lead: "ion:HI", ion: {"ion:HI": [-12, -2]}};
  for (const [nm, tf] of [["band at the window top", {...lead, bands: [-9, -7, -2.1]}], ["band below the window", {...lead, bands: [-12.2, -7, -4]}],
    ["window narrower than 1 dex", {lead: "ion:HI", ion: {"ion:HI": [-5, -4.5]}}], ["fog reversed", {fog: [140, 40]}], ["look gain 9", {look: {halo: {gain: 9}}}]]) {
    const r = TFS.applyStoryTF(tf), same = snap() === s0;
    C.check(!r.ok && same, `seeded TF defect "${nm}" is refused and the defaults stay (${(r.errs || []).join("; ")})`);
  }
  const lk = TFS.applyStoryTF({look: {halo: {gain: 3}}});
  C.check(lk.ok && TFS.blendTF("halo").uniforms.uVolGain === 3 && TFS.blendTF("density").uniforms.uVolGain === TFS.PRESETS.density.look.gain,
    "meta.tf look: a per-preset gain override reaches only that preset's uniforms");
  TFS.resetStoryTF();
}

function tfReport(C, out) {
  const all = {};
  for (const {file, story} of v3Stories()) {
    const id = STORY_ID[story.case.declared] || file, g = story.galaxy.id, b = deriveTFBlock(story, galaxyVolWindow(g));
    all[id] = {galaxy: g, ray: story.meta && story.meta.ray, block: b, notes: b.notes};
    C.note(`${id} (${g}): ${JSON.stringify(b)}${b.notes.length ? "  [" + b.notes.join("; ") + "]" : ""}`);
    if (out) writeFileSync(join(out, `tf_${id}.json`), JSON.stringify(b, null, 1) + "\n");
  }
  if (out) writeFileSync(join(out, "tf_all.json"), JSON.stringify(all, null, 1) + "\n");
  C.check(Object.keys(all).length > 0, `derived meta.tf for ${Object.keys(all).length} stories`);
}

/* frames of ?story=<id>: cloud beats (the probe inside a lettered encounter) or, for the empty case, B1/B2 */
const PROJ = `async (p, ray, encs) => {
  const S = window.__story, fs = S.seek(p), L = S.shell.layout();
  const [SH, LC] = await Promise.all([import("./js/core/shots.js"), import("./js/ui/layoutclass.js")]);
  const cs = getComputedStyle(document.getElementById("stage")), n = v => parseFloat(cs.getPropertyValue(v)) || 0;
  const insets = {top: n("--sat"), right: n("--sar"), bottom: n("--sab"), left: n("--sal")};
  const bandsFn = (sd, dk) => LC.computeBands(L.cls, L.w, L.h, {textSide: sd, dock: dk, insets});
  const view = S.view ? S.view() : SH.viewFor(fs.cam, L.w, L.h, bandsFn, {dock: fs.spec.dock, dockFrom: fs.spec.dockFrom, dockMix: fs.spec.dockMix, keep: null});
  const P = l => ray.p0.map((x, a) => x + (l + ray.half) * ray.n[a]);
  const e = encs.find(e => fs.l >= e.l0 - 2 && fs.l <= e.l1 + 2);
  if (!e) return {beat: fs.beat.id, l: fs.l, enc: null, approx: !S.view};
  const r = Math.max(4, Math.min(30, e.r90 || 4)), pts = [];
  for (let k = 0; k <= 4; k++) { const c = P(e.l0 + (e.l1 - e.l0) * k / 4); for (const a of [0, 1, 2]) for (const s of [-r, r]) { const q = c.slice(); q[a] += s; pts.push(q); } }
  const xy = pts.map(q => SH.project(fs.cam, view, q)).filter(q => q.ok);
  if (!xy.length) return {beat: fs.beat.id, l: fs.l, enc: e.letter, box: null, approx: !S.view};
  const x0 = Math.max(0, Math.min(...xy.map(q => q.x))), x1 = Math.min(L.w, Math.max(...xy.map(q => q.x)));
  const y0 = Math.max(0, Math.min(...xy.map(q => q.y))), y1 = Math.min(L.h, Math.max(...xy.map(q => q.y)));
  return {beat: fs.beat.id, l: fs.l, enc: e.letter, box: x1 > x0 && y1 > y0 ? {x: x0, y: y0, w: x1 - x0, h: y1 - y0} : null, approx: !S.view};
}`;
async function g14Browser(C, pos, opt) {
  const DIR = resolve(pos[0] || join(REPO, "docs/tng50")), ids = String(opt.story || "").split(",").filter(Boolean);
  if (!C.check(ids.length > 0, "--g14 needs --story id[,id]")) return;
  const SHOTS = opt.shots ? resolve(opt.shots) : null, OUT = opt.out ? resolve(opt.out) : null;
  if (SHOTS) mkdirSync(SHOTS, {recursive: true}); if (OUT) mkdirSync(OUT, {recursive: true});
  const [w, h] = String(opt.viewport || "1440x900").split("x").map(Number), gpu = !!process.env.TNG_GPU || !!opt.gpu;
  const AS = storyAssets(opt), srv = await gzServe(DIR, AS), AQ = assetQuery(srv, AS);
  const P = await launch({edge: opt.edge || edgeWith(plainEdge(), gpu ? GPU_FLAGS : []), block: BLOCK, reducedMotion: false});
  const res = [];
  try {
    await setViewport(P, {w, h, zoom: 1});
    for (const id of ids) {
      const url = srv.base + STORY_REL + "/index.html?story=" + id + "&nogate=1" + (gpu && !opt.force3d ? "" : "&force3d=1") + (AQ ? "&" + AQ : "");   // software GL: force the 3D tier
      await P.goto(url);
      const kind = await detect(P, 120000);
      if (!C.check(kind === "v2", `${id}: story ready (${kind || "none"})`)) continue;
      await P.waitFor("!!(window.__story && window.__story.stage)", 120000, 250);   // RESIDENT says "no stage" before attach
      const r0 = await waitResident(P, 120000);
      C.note(`${id}: renderer ${await P.eval(`(__story.stage && __story.stage.stats && __story.stage.stats.renderer) || "?"`)}`);
      if (!C.check(r0 && r0.levels > 0, `${id}: volume resident (${r0 && r0.levels} levels)`)) continue;
      const ixf = join(DIR, STORY_REL, "data/index.json"), ent = JSON.parse(readFileSync(ixf, "utf8")).stories.find(e => e.id === id);
      const d = JSON.parse(readFileSync(join(DIR, STORY_REL, "data", ent.story || `story_${ent.galaxy}_${ent.ray}.json`), "utf8")), G = d.geometry.ray;
      const ray = {p0: G.p0, n: G.n, half: G.half};
      // the hero has no plan: its hand letter windows (DESIGN_tierA §4.2), so the gate can be calibrated on the hand-tuned story
      const encs = d.plan ? (d.plan.encounters || []).filter(e => e.letter && !e.synthetic)
        : [["A", -165, -124], ["B", -42, -18], ["C", 30, 81], ["D", 81, 122]].map(([letter, l0, l1]) => ({letter, l0, l1, r90: 10}));
      const info = {empty: opt.mode === "empty" || (d.case || {}).declared === "empty", beats: await P.eval(`__story.beats().map(b => [b.id, b.p0, b.p1])`)};
      const want = info.beats.map(([b, p0, p1]) => ({b, p: (p0 + p1) / 2})).filter(x => !info.empty || x.b === "B1" || x.b === "B2");
      let bad = 0, n = 0;
      for (const x of want) {
        const pr = info.empty ? {beat: x.b} : await P.fn(`return (${PROJ})(${x.p}, ${JSON.stringify(ray)}, ${JSON.stringify(encs)});`);
        if (!info.empty && !pr.enc) continue;
        await P.eval(`__story.setTarget(${x.p}, true)`); await sleep(1500);
        await P.waitFor(`(${RESIDENT}).levels > 0`, 20000, 200);
        const buf = await screenshot(P); n++;
        if (SHOTS) writeFileSync(join(SHOTS, `g14_${id}_${x.b}.png`), buf);
        const img = decodePNG(buf), scale = img.width / w;
        const r = evalG14({name: `${id} ${x.b}${pr.enc ? " cloud " + pr.enc : ""}`, img, box: pr.box, scale, mode: info.empty ? "empty" : "cloud"});
        if (pr.approx) r.notes.push("box from viewFor without the keep term (page exposes no __story.view)");
        res.push({story: id, beat: x.b, p: x.p, enc: pr.enc || null, box: pr.box || null, frac: r.frac, sat: r.sat ?? null, fails: r.fails});
        if (r.fails.length) { bad++; for (const f of r.fails) C.note(`G14 ${f.msg}`); } else for (const t of r.notes) C.note(t);
      }
      C.check(n > 0 && !bad, `${id}: ${n} G14 frames, ${bad} failing`);
    }
  } finally { await P.close(); await srv.close(); }
  const f = writeResult(OUT, "g14.json", res); if (f) C.note(`results ${relative(REPO, f)}`);
}

async function main() {
const {pos, opt} = parseArgs(process.argv.slice(2));
const s0 = [join(REPO, "notes/story2/S0.md"), join(process.env.TNG_WORK || "/Volumes/cgm_work", "notes/story2/S0.md")].filter(existsSync).map(f => readFileSync(f, "utf8"))[0] || "";
const C = checker(), MODE = (opt.luma || (s0.match(/^G11_luma:\s*(\w+)/m) || [])[1]) === "srgb" ? "srgb" : "rel";
const num = (k, d) => { const m = s0.match(new RegExp(k + ":\\s*([\\d.]+)")); return m ? +m[1] : d; };
const T = {darkFrac: num("G11_dark_frac", G11.darkFrac), darkLum: num("G11_dark_lum", G11.darkLum), bandP95: num("G11_band_p95", G11.bandP95)};
const EXEMPT = new Set(["B2", "B6"]);

if (opt.png) {
  const img = decodePNG(readFileSync(resolve(opt.png))), bg = opt.bg ? decodePNG(readFileSync(resolve(opt.bg))) : null;
  const bands = opt.band ? [opt.band.split(",").map(Number)].map(([x, y, w, h]) => ({x, y, w, h})) : [];
  if (report(C, evalPixels({name: opt.png, img, bg, bands, exempt: !!opt.exempt}, T, MODE))) C.check(true, `${opt.png}: G11 passes`);
  process.exit(C.finish());
}
if (opt.tf) { const o = opt.out ? resolve(opt.out) : null; if (o) mkdirSync(o, {recursive: true}); tfReport(C, o); process.exit(C.finish()); }
if (opt.g14) { if (process.env.TNG_BROWSER) await g14Browser(C, pos, opt); else C.check(false, "--g14 needs TNG_BROWSER=1"); process.exit(C.finish()); }

/* ---------------------------------------------------------------- self-test on synthetic frames */
{
  const W = 400, H = 250, band = {x: 20, y: 20, w: 160, h: 60}, inB = (x, y) => x >= band.x && x < band.x + band.w && y >= band.y && y < band.y + band.h;
  const round = img => decodePNG(encodePNG(img));   // through the codec, as screenshots are
  const clean = round(synthImage(W, H, (x, y) => inB(x, y) ? [20, 24, 40] : (x - 300) ** 2 + (y - 120) ** 2 < 900 ? [200, 160, 120] : [8, 10, 16]));
  const fog = round(synthImage(W, H, () => [120, 120, 130]));
  const brightBand = round(synthImage(W, H, (x, y) => inB(x, y) ? [170, 170, 180] : [8, 10, 16]));
  const text = [{id: "display", rect: {x: 30, y: 30, w: 120, h: 30}, color: [232, 236, 244]}];
  const cases = [["clean", {img: clean, bands: [band], texts: text}, null], ["fog over the whole frame", {img: fog, bands: [band]}, "G11"],
    ["bright volume behind the text band", {img: brightBand, bands: [band]}, "G11"], ["grey text on the band", {img: clean, bands: [band], texts: [{...text[0], color: [90, 90, 100]}]}, "G4"],
    ["fog in an exempt beat (B2)", {img: fog, bands: [], exempt: true}, null]];
  for (const [nm, s, want] of cases) { const r = evalPixels({name: nm, ...s}, T, "rel"), g = [...new Set(r.fails.map(x => x.gate))];
    C.check(want ? g.includes(want) : !r.fails.length, `self-test synthetic frame "${nm}": ${want ? "fails " + want : "passes"} (got ${g.join(", ") || "pass"})`); }
  const px = decodePNG(encodePNG(synthImage(3, 2, (x, y) => [x * 100, y * 200, 7])));
  C.check(px.data[4 * 4] === 100 && px.data[4 * 4 + 1] === 200 && px.data[4 * 4 + 2] === 7, "PNG codec round trip");
  /* calibration against S0 §4: the same A100 frames (U_stage shots, 1440x900, desktop band x 5-42 %, y 9-40 %) */
  const SH = opt["s0-shots"] || join(process.env.TNG_WORK || "/Volumes/cgm_work", "scratch/story2_w/U_stage/shots");
  const S0T = [["B1", 0.996, 0.002], ["B4", 0.892, 0.044], ["B5", 0.879, 0.001], ["B7a", 0.585, 0.403], ["B8", 0.996, 0.002], ["B9", 0.940, 0.144], ["B10", 0.624, 0.002]];
  const have = S0T.filter(([b]) => existsSync(join(SH, `a100_1440_${b}.png`)));
  if (have.length) {
    const L = (img, r) => lumSamples(img, r, {step: 1, mode: "rel"});
    for (const [b, d0, p0] of have) { const img = decodePNG(readFileSync(join(SH, `a100_1440_${b}.png`))), W = img.width, H = img.height;
      const all = L(img, null), dark = all.filter(v => v < T.darkLum).length / all.length, p95 = quantile(L(img, {x: 0.05 * W, y: 0.09 * H, w: 0.37 * W, h: 0.31 * H}), 0.95);
      C.check(Math.abs(dark - d0) <= 0.012 && Math.abs(p95 - p0) <= 0.01, `calibration ${b}: dark ${dark.toFixed(3)} (S0 ${d0}), band p95 ${p95.toFixed(3)} (S0 ${p0})`); }
    const r = evalPixels({name: "S0 B7a k 0.6", img: decodePNG(readFileSync(join(SH, "a100_1440_B7a.png"))), bands: [{x: 72, y: 81, w: 533, h: 279}]}, T, MODE);
    C.check(r.fails.some(x => x.gate === "G11"), "calibration: the S0 B7a frame at scrim k 0.6 fails G11 (band p95 0.40, S0 §4)");
  } else C.note(`S0 calibration frames not found under ${SH} (skipped)`);
  C.note(`thresholds: dark fraction >= ${T.darkFrac} below luminance ${T.darkLum}, band p95 < ${T.bandP95} (${s0 ? "S0.md read" : "provisional, S0 not frozen"}; luma ${MODE})`);
}
await tierASelfTest(C);
if (!process.env.TNG_BROWSER) { C.note("browser part skipped (set TNG_BROWSER=1; GPU node for the real volume)"); process.exit(C.finish()); }

/* ---------------------------------------------------------------- frames of the live page */
const DIR = resolve(pos[0] || join(REPO, "docs/tng50")), PAGE = join(DIR, STORY_REL, "index.html");
if (!existsSync(PAGE)) { C.check(process.env.STORY_REQUIRE !== "1", `no story page at ${relative(REPO, PAGE)}`); process.exit(C.finish()); }
const SHOTS = opt.shots ? resolve(opt.shots) : null, OUT = opt.out ? resolve(opt.out) : null;
if (SHOTS) mkdirSync(SHOTS, {recursive: true}); if (OUT) mkdirSync(OUT, {recursive: true});
const VPS = String(opt.viewports || "1440x900").split(",").map(s => s.split("x").map(Number));
const HIDE = `(() => { const s = document.createElement("style"); s.id = "__qa_hide_text"; s.textContent = "*, *::before, *::after { color: transparent !important; text-shadow: none !important; -webkit-text-stroke: 0 !important; caret-color: transparent !important; } svg text, svg tspan { fill: transparent !important; stroke: none !important; }"; document.head.appendChild(s); })()`;
const SHOW = `document.getElementById("__qa_hide_text")?.remove()`;
const rgb = s => (s.match(/rgba?\(([^)]+)\)/) || [, ""])[1].split(/[ ,/]+/).filter(Boolean).map(Number);
const gpu = !!process.env.TNG_GPU || !!opt.gpu;
const AS = storyAssets(opt), srv = await gzServe(DIR, AS), AQ = assetQuery(srv, AS), URL0 = srv.base + STORY_REL + "/index.html" + (AQ ? "?" + AQ : "");
C.note(`assets: cubes ${AS.viz || "page default (hosted, blocked here)"}; three ${AS.three || "page default (CDN)"}`);
const P = await launch({edge: opt.edge || edgeWith(plainEdge(), gpu ? GPU_FLAGS : []), block: BLOCK, reducedMotion: false});
const frames = [];
try {
  await P.send("Emulation.setEmulatedMedia", {features: [{name: "prefers-reduced-motion", value: "no-preference"}]});
  for (const [w, h] of VPS) {
    await setViewport(P, {w, h, zoom: 1});
    await P.goto(URL0);
    const kind = await detect(P, 120000);
    if (!C.check(!!kind, `${w}x${h}: story ready (${kind || "none"})`)) continue;
    const R = await P.eval(`(() => { const g = document.createElement("canvas").getContext("webgl2"); const d = g && g.getExtension("WEBGL_debug_renderer_info"); return g ? (d ? g.getParameter(d.UNMASKED_RENDERER_WEBGL) : "webgl2") : "none"; })()`);
    C.note(`${w}x${h}: page ${kind}, renderer ${R}`);
    // a 3D page must have cube data bound before its frames count: an empty sky passes G11 for the wrong reason (job 1230037)
    const r0 = kind === "v2" ? await waitResident(P, 120000) : null;
    if (r0 && r0.stage) C.check(r0.levels > 0, `${w}x${h}: volume resident before the frames (${r0.loads} cube loads, ${r0.levels} levels bound)`);
    else if (r0) C.note(`${w}x${h}: no 3D stage (stills tier); frames are the posters`);
    let list = await positions(P, kind, 0);
    if (kind === "v2") list = list.filter(p => !p.stop); else list = list.filter((_, i) => i % 3 === 0);
    let bad = 0;
    for (const ps of list) {
      const id = ps.beat || ps.step;
      if (!(await goTo(P, kind, ps, {settleMs: 1500, url: URL0}))) { C.check(false, `${w}x${h}: reached ${id}`); continue; }
      let res = null;
      if (r0 && r0.stage) { await P.waitFor(`(${RESIDENT}).levels > 0`, 20000, 200); res = await P.eval(RESIDENT); }
      const snap = await snapshot(P, kind, {name: id, zoom: 1});
      const imgBuf = await screenshot(P); await P.eval(HIDE); await sleep(120); const bgBuf = await screenshot(P); await P.eval(SHOW);
      if (SHOTS) { writeFileSync(join(SHOTS, `g11_${w}x${h}_${id}.png`), imgBuf); writeFileSync(join(SHOTS, `g11_${w}x${h}_${id}_bg.png`), bgBuf); }
      const texts = snap.boxes.filter(b => b.kind === "text" && b.color && !b.occluded && (b.opacity ?? 1) >= 0.99 && b.w * b.h > 20)
        .map(b => ({id: b.id, rect: b, color: rgb(b.color).slice(0, 3), alpha: rgb(b.color)[3] ?? 1})).filter(t => t.color.length === 3 && t.alpha >= 0.99);
      const bandMap = new Map(); for (const b of snap.boxes.filter(b => b.band)) { const u = bandMap.get(b.band);
        bandMap.set(b.band, u ? {x: Math.min(u.x, b.x), y: Math.min(u.y, b.y), w: Math.max(u.x + u.w, b.x + b.w) - Math.min(u.x, b.x), h: Math.max(u.y + u.h, b.y + b.h) - Math.min(u.y, b.y)} : {x: b.x, y: b.y, w: b.w, h: b.h}); }
      const s = {name: `${w}x${h} ${id}`, img: decodePNG(imgBuf), bg: decodePNG(bgBuf), scale: snap.dpr || 1, exempt: kind === "v2" && EXEMPT.has(id), bands: [...bandMap.values()], texts};
      const r = evalPixels(s, T, MODE);
      if (res && !(res.levels > 0)) r.fails.push({gate: "G11", msg: `${s.name}: no cube level bound when the frame was taken (an empty sky is not a measurement)`});
      frames.push({id, viewport: `${w}x${h}`, notes: r.notes, fails: r.fails});
      if (r.fails.length) { bad++; for (const x of r.fails.slice(0, 4)) C.note(`${x.gate} ${x.msg}`); }
      else C.note(`${s.name}: ${r.notes.join("; ")}`);
    }
    if (kind === "v1") C.note("v1 has no text bands and is not built to the dark-sky rule; its G11 numbers are a baseline");
    C.check(!bad, `${w}x${h}: ${list.length} frames, ${bad} failing G11/G4`);
  }
  C.note("text drawn inside canvases (plot labels, world tags in GL) is not covered by G4 here");
} finally { await P.close(); await srv.close(); }
const f = writeResult(OUT, "g11.json", frames); if (f) C.note(`results ${relative(REPO, f)}`);
process.exit(C.finish());
}

const MAIN = !!process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (MAIN) await main();
