#!/usr/bin/env node
// story_stills.mjs: frames of "How a spectrum is made" from ROOT/render.html in a headless browser over CDP (DESIGN_final
// §5.9 U_film). The same page HyperFrames renders; this tool drives its frame source (window.__film) directly, so it can
// use the cluster's GPU Chrome (TNG_EDGE=.../headless-gpu, ANGLE/Vulkan) where HyperFrames' own browser may fall back to
// SwiftShader. Nothing here draws: it only asks the page for frame t (or story position p) and captures the viewport.
//
//   node scripts/story_stills.mjs --stills                 AVIF stills for the no-WebGL2/software-GL path (film.json "stills"):
//                                                           ROOT/media/stills/<beat>[_<k>].avif + index.json, each <= max_bytes
//   node scripts/story_stills.mjs --frames 0,450,1200      PNGs of film frames -> --out DIR (contact sheets, smoke checks)
//   node scripts/story_stills.mjs --times 3.5,40           same, by film time in seconds
//   node scripts/story_stills.mjs --video --out F.mp4      the whole cut (or --from/--to frames) as PNGs piped to ffmpeg (x264 CRF 16)
//   options: --root DIR (story folder) --viz DIR (local cube folder with manifest_v2.json; served at /viz/) --three FILE
//            (three.module.min.js) --w/--h --K n --scale s --quality q --cut film|beams --edge BIN --sheet FILE (contact sheet
//            of the captured PNGs) --beats B5,B7b (stills: only these) --png (stills: keep the PNG too) --require-gpu (stop when the page reports a software renderer) --timeout s
// Prints one JSON line per capture and a summary (renderer, ms per frame). Exit 1 on any page error.
import {readFileSync, writeFileSync, mkdirSync, existsSync, statSync, unlinkSync} from "node:fs";
import {join, resolve, dirname, basename} from "node:path";
import {spawn} from "node:child_process";
import {fileURLToPath} from "node:url";
import {createRequire} from "node:module";
import {launch, serve, sleep} from "../tests/js/lib/browser.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
// sharp (Apache-2.0) through require, so NODE_PATH (the claude-tools env) is honoured; ESM import ignores NODE_PATH
const loadSharp = () => createRequire(import.meta.url)("sharp");
const A = {};
for (let i = 2; i < process.argv.length; i++) { const k = process.argv[i]; if (!k.startsWith("--")) continue; const n = process.argv[i + 1];
  A[k.slice(2)] = n && !n.startsWith("--") ? (i++, n) : true; }
const ROOT = resolve(A.root || join(HERE, "..", "docs/tng50/learn/how-a-spectrum-is-made"));
const DOCS = resolve(ROOT, "../../");                       // docs/tng50
const film = JSON.parse(readFileSync(join(ROOT, "film.json"), "utf8"));
const beats = JSON.parse(readFileSync(join(ROOT, "beats.json"), "utf8")).beats;
const STILLS = A.stills === true;
const W = +(A.w || (STILLS ? film.stills.width : film.width)), H = +(A.h || (STILLS ? film.stills.height : film.height));
const log = o => console.log(JSON.stringify(o));

// three.js for a node without network: --three, else the copy in ROOT/build/vendor (story_render.sbatch puts it there)
const threeFile = A.three ? resolve(A.three) : join(ROOT, "build/vendor/three.module.min.js");
const relThree = existsSync(threeFile) && threeFile.startsWith(DOCS + "/") ? threeFile.slice(DOCS.length + 1) : null;
if (A.three && !relThree) throw new Error(`--three must lie inside ${DOCS} (copy it to ROOT/build/vendor/)`);

const srv = await serve({dir: DOCS, page: join(ROOT, "render.html"), viz: A.viz || null});
const rel = ROOT.slice(DOCS.length + 1);
const q = new URLSearchParams({w: W, h: H, cut: A.cut || "film"});
if (relThree) q.set("three", srv.base + relThree);
if (A.viz) q.set("viz", `${srv.origin}/viz/manifest_v2.json`);
for (const k of ["K", "scale", "quality", "g", "ray"]) if (A[k] != null && A[k] !== true) q.set(k, A[k]);
if (STILLS) q.set("layers", "stage");
if (A["no-burn"]) q.set("burn", "0");
const url = `${srv.base}${rel}/render.html?${q}`;
const P = await launch({width: W, height: H, edge: A.edge || process.env.TNG_EDGE, profile: A.profile || join(ROOT, "build/.profile")});
await P.viewport(W, H, false);
const t0 = Date.now();
await P.goto(url);
const ok = await P.waitFor("window.__film || window.__filmError", +(A.timeout || 900) * 1000, 500);
const err = await P.eval("window.__filmError || null").catch(() => null);
if (ok < 0 || err) { console.error("render.html did not become ready:", err || "timeout", P.exceptions.slice(0, 5), P.consoleErrors.slice(0, 5)); await P.close(); await srv.close(); process.exit(1); }
const info = await P.eval("({renderer: __film.renderer, software: __film.software, frames: __film.TL.frames, fps: __film.TL.fps, stats: __film.stats()})");
log({ready_ms: Date.now() - t0, ...info});
if (A["require-gpu"] && info.software) { console.error("software GL renderer:", info.renderer); await P.close(); await srv.close(); process.exit(2); }

async function shotPng() { const r = await P.send("Page.captureScreenshot", {format: "png", clip: {x: 0, y: 0, width: W, height: H, scale: 1}}); return Buffer.from(r.result.data, "base64"); }
const captured = [];
let failed = false;

if (STILLS) {
  // one still per stop sub-tick (beats.json stops.n) or per beat midpoint; the 3D only (text and dock stay live DOM on the page)
  const sharp = loadSharp();
  const outDir = join(ROOT, "media/stills"); mkdirSync(outDir, {recursive: true});
  const max = film.stills.max_bytes || 153600, list = [];
  for (const b of beats) {
    if (b.id === "B0" || (A.beats && !String(A.beats).split(",").includes(b.id))) continue;
    const n = b.stops && b.stops.n ? b.stops.n : 1;
    for (let k = 0; k < n; k++) {
      const p = b.p0 + (b.p1 - b.p0) * (n > 1 ? (k + 0.5) / n : 0.5);
      const t1 = Date.now(), r = await P.eval(`__film.renderP(${p})`, 600000);
      const png = await shotPng();
      let qv = 60, buf = null;
      for (; qv >= 20; qv -= 8) { buf = await sharp(png).avif({quality: qv, effort: 6, chromaSubsampling: "4:2:0"}).toBuffer(); if (buf.length <= max) break; }
      const name = `${b.id}${n > 1 ? "_" + (k + 1) : ""}.avif`;
      writeFileSync(join(outDir, name), buf);
      if (A.png) writeFileSync(join(outDir, name.replace(".avif", ".png")), png);
      const e = {beat: b.id, k, p: +p.toFixed(5), file: `media/stills/${name}`, bytes: buf.length, quality: qv, ms: Date.now() - t1, ok: buf.length <= max};
      if (!e.ok) failed = true;
      list.push(e); log(e); captured.push(png);
    }
  }
  writeFileSync(join(outDir, "index.json"), JSON.stringify({schema: "story-stills/1", galaxy: film.galaxy, ray: film.ray, width: W, height: H,
    renderer: info.renderer, max_bytes: max, stills: list.map(({ms, ...x}) => x)}, null, 1) + "\n");
} else if (A.video) {
  const out = resolve(A.out || join(ROOT, "build/film.raw.mp4")); mkdirSync(dirname(out), {recursive: true});
  const f0 = +(A.from || 0), f1 = Math.min(+(A.to || info.frames), info.frames);
  const ff = spawn("ffmpeg", ["-nostdin", "-v", "error", "-y", "-f", "image2pipe", "-framerate", String(info.fps), "-c:v", "png", "-i", "-",
    "-c:v", "libx264", "-preset", A.preset || "slow", "-crf", String(A.crf || 16), "-pix_fmt", "yuv420p", "-movflags", "+faststart", out], {stdio: ["pipe", "inherit", "inherit"]});
  const tStart = Date.now();
  for (let f = f0; f < f1; f++) {
    const r = await P.eval(`__film.renderFrame(${f})`, 600000);
    const png = await shotPng();
    if (!ff.stdin.write(png)) await new Promise(res => ff.stdin.once("drain", res));
    if (f % 150 === 0 || f === f1 - 1) log({frame: f, of: f1, chunk: r.chunk, beat: r.beat, ms_per_frame: Math.round((Date.now() - tStart) / (f - f0 + 1))});
    if (A.keep && (f - f0) % +(A.keep) === 0) captured.push(png);
  }
  ff.stdin.end(); const code = await new Promise(res => ff.on("close", res));
  if (code !== 0) { console.error("ffmpeg failed", code); failed = true; }
  log({video: out, frames: f1 - f0, seconds: (Date.now() - tStart) / 1000});
} else {
  const outDir = resolve(A.out || join(ROOT, "build/frames")); mkdirSync(outDir, {recursive: true});
  const frames = A.frames ? String(A.frames).split(",").map(Number) : A.times ? String(A.times).split(",").map(t => Math.round(+t * info.fps)) : [0];
  for (const f of frames) {
    const t1 = Date.now(), r = await P.eval(`__film.renderFrame(${f})`, 600000);
    const png = await shotPng(), file = join(outDir, `f${String(f).padStart(5, "0")}_${r.chunk}_${r.beat}.png`);
    writeFileSync(file, png); captured.push(png);
    log({...r, file, ms: Date.now() - t1});
  }
}
if (A.sheet && captured.length) {
  const sharp = loadSharp(), cols = Math.min(4, captured.length), tw = 480, th = Math.round(tw * H / W);
  const tiles = await Promise.all(captured.map(b => sharp(b).resize(tw, th).png().toBuffer()));
  const rows = Math.ceil(tiles.length / cols);
  await sharp({create: {width: cols * tw, height: rows * th, channels: 3, background: "#04050a"}})
    .composite(tiles.map((b, i) => ({input: b, left: (i % cols) * tw, top: Math.floor(i / cols) * th}))).png().toFile(resolve(A.sheet));
  log({sheet: resolve(A.sheet), tiles: tiles.length});
}
if (P.exceptions.length) { console.error("page exceptions:", P.exceptions.slice(0, 5)); failed = true; }
if (P.consoleErrors.length) console.error("console errors:", P.consoleErrors.slice(0, 8));
await P.close(); await srv.close();
process.exit(failed ? 1 : 0);
