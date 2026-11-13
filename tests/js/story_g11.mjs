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
import {existsSync, readFileSync, writeFileSync, mkdirSync} from "node:fs";
import {join, resolve, relative} from "node:path";
import {parseArgs, checker, launch, BLOCK, sleep} from "./lib/browser.mjs";
import {REPO, STORY_REL, G11, evalPixels, decodePNG, encodePNG, synthImage, report, writeResult, plainEdge, edgeWith, gzServe, setViewport, detect,
  positions, goTo, snapshot, screenshot, GPU_FLAGS, lumSamples, quantile, storyAssets, assetQuery, waitResident, RESIDENT} from "./lib/storyqa.mjs";

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
