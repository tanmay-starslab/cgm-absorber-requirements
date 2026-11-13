#!/usr/bin/env node
// Posters (stills) of the space scenes S1 and S2 of "How a spectrum is made" (PLAN_final §2.3, §3, §8 unit U3).
//
// For any galaxy of the sample with a 3D pack (the explorer's deposited cubes, tng50-viz/2) and a story sightline, this
// projects the gas column (n_H) and the starlight (g, r, i; Lupton et al. 2004 asinh composite, the explorer's own
// formula from docs/tng50/js/vizdata.js) through the nested cubes along the cameras of scripts/story_posters.camera.json,
// and writes
//   <out>/<g>_<ray>/{light_core_stars, light_wide_stars, light_wide_gas, pencil_stars, pencil_gas}.webp
//   <out>/<g>_<ray>/posters.json      geometry the scenes use (beam, impact point, scale, other sightlines), sources
// and, for the v2 gate (B0) and the explorer's first-visit card (camera.json "gate", unit U_entry), one composite of gas,
// starlight and the beam per variant:
//   <gate-out>/poster_<g>_<ray>.webp (landscape), poster_<g>_<ray>_p.webp (portrait), poster_<g>_<ray>_card.webp (card)
//   <gate-out>/poster_<g>_<ray>.json  variant geometry (beam end points in px, kpc per px, centre) and sources
// The scenes (js/scenes/light.js, pencil.js) work without posters too (procedural fallback), so a galaxy without
// stills still tells the story. Everything is CPU (orthographic ray sums, trilinear, worker threads); no browser, no
// WebGL, deterministic: the same inputs give the same bytes (no timestamps written).
//
//   node scripts/story_posters.mjs --g 488530                       # default ray from ROOT/data/index.json
//   node scripts/story_posters.mjs --g 411449,505100 --out <dir>    # other galaxies (any of the 198 with a pack)
//   node scripts/story_posters.mjs --g all                          # every galaxy under --gal-root with viz/
//   node scripts/story_posters.mjs --g 488530 --shots gate          # only the gate posters (v1 stills untouched)
//   options: --ray <id>  --gal-root <dir>  --viz <dir|url>  --catalog <file|url>  --camera <json>  --workers <n>
//            --shots <name,...|gate>  --gate-out <dir> (default ROOT/img)  --max-kb <n> (gate size cap, default 150)
//            --quick (quarter-size, for checks)  --check (geometry only, no images)
//
// Inputs per galaxy g: viz = <gal-root>/<g>/viz (or --viz; an http(s) base such as the hosted <viz_base> works too),
// catalog = --catalog, else <gal-root>/<g>/library_trident/catalog.json, else <gal-root>/<g>/catalog.json, else the
// page's docs/tng50/data/catalog.json when its galaxy is g. The catalog entry's p0/p1 are box-axis kpc relative to the
// galaxy centre (scripts/export_tng50_web.py gal_endpoints); the cubes are in the disk frame (manifest frame.rows).
// Trident convention: the observer is at the ray start p0, the quasar at the end p1.

import {createRequire} from "node:module";
import {Worker, isMainThread, parentPort, workerData} from "node:worker_threads";
import {readFile, writeFile, mkdir, readdir, stat} from "node:fs/promises";
import {createHash} from "node:crypto";
import {fileURLToPath} from "node:url";
import path from "node:path";
import os from "node:os";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "..");
const ROOT = path.join(REPO, "docs/tng50/learn/how-a-spectrum-is-made");
const CM_PER_KPC = 3.0856775814913673e21, MU_ZERO = 36.57212566588;   // as docs/tng50/js/vizdata.js

/* ------------------------------------------------------------------ geometry (pure; mirrored in js/scenes/space.js) */
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const sub3 = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const scl = (a, s) => [a[0] * s, a[1] * s, a[2] * s];
const add3 = (...v) => v.reduce((a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]]);
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const norm = a => { const l = Math.hypot(...a); return l > 0 ? scl(a, 1 / l) : a; };
const toDisk = (rows, v) => [dot(rows[0], v), dot(rows[1], v), dot(rows[2], v)];

/* the sightline in the disk frame: n (p0 -> p1), u (centre -> closest point), w = u x n, b, s0/s1 (ends along n from
   the closest point) */
export function beamFrame(p0d, p1d) {
  const d = sub3(p1d, p0d), L = Math.hypot(...d), n = scl(d, 1 / L);
  const s = -dot(p0d, n), pc = add3(p0d, scl(n, s)), b = Math.hypot(...pc);
  let u;
  if (b > 1e-6) u = scl(pc, 1 / b);
  else { const t = Math.abs(n[2]) < 0.9 ? [0, 0, 1] : [1, 0, 0]; u = norm(sub3(t, scl(n, dot(t, n)))); }
  const w = cross(u, n);
  return {n, u, w, b, L, s0: -s, s1: L - s};
}
/* camera of a shot: forward f, image right e1, image up e2 (rolled) */
export function camera(B, tiltDeg, rollDeg) {
  const t = tiltDeg * Math.PI / 180, r = rollDeg * Math.PI / 180;
  const f = norm(add3(scl(B.n, Math.cos(t)), scl(B.w, Math.sin(t))));
  const a = norm(sub3(scl(B.n, Math.sin(t)), scl(B.w, Math.cos(t)))), c = B.u;
  const e1 = add3(scl(a, Math.cos(r)), scl(c, Math.sin(r))), e2 = add3(scl(a, -Math.sin(r)), scl(c, Math.cos(r)));
  return {f, e1, e2};
}
/* analytic image position (kpc, x right, y up) of the beam point s (kpc from its closest point) */
export function beamXY(b, s, tiltDeg, rollDeg) {
  const t = tiltDeg * Math.PI / 180, r = rollDeg * Math.PI / 180, x = s * Math.sin(t), y = b;
  return [x * Math.cos(r) + y * Math.sin(r), -x * Math.sin(r) + y * Math.cos(r)];
}
export function halfWidth(spec, R200c) {
  if (spec.R200c != null && spec.kpc == null) return spec.R200c * R200c;
  let h = spec.kpc ?? 40;
  if (spec.R200c != null) h = Math.max(h, spec.R200c * R200c);
  if (spec.min_kpc != null) h = Math.max(h, spec.min_kpc);
  if (spec.max_kpc != null) h = Math.min(h, spec.max_kpc);
  return h;
}

/* ------------------------------------------------------------------ projection worker */
/* levels: [{half, n, vox, buf (SharedArrayBuffer u8), ch}], finest first; table: Float64Array(256 * ch) linear value per
   q; job: {W, H, rows [y0, y1), hw (kpc), cam, out (SharedArrayBuffer f32, ch per pixel)} */
function projectRows(job) {
  const {W, H, y0, y1, hw, cam, levels, tables, ch} = job, out = new Float32Array(job.out), hh = hw * H / W;
  const [offA, offB] = job.off || [0, 0];     // image-plane kpc of the galaxy centre from the image centre (gate framing)
  const Ls = levels.map(l => ({...l, q: new Uint8Array(l.buf), lim: l.half - l.vox}));
  const outer = Ls[Ls.length - 1].half, f = cam.f, e1 = cam.e1, e2 = cam.e2, acc = new Float64Array(ch);
  const T = tables.map(t => new Float64Array(t));
  const STEP = 0.7;
  for (let py = y0; py < y1; py++) {
    const b = hh - (py + 0.5) / H * 2 * hh - offB;
    for (let px = 0; px < W; px++) {
      const a = -hw + (px + 0.5) / W * 2 * hw - offA;
      const ox = a * e1[0] + b * e2[0], oy = a * e1[1] + b * e2[1], oz = a * e1[2] + b * e2[2];
      // slab of the outer cube
      let t0 = -Infinity, t1 = Infinity;
      for (const [o, d] of [[ox, f[0]], [oy, f[1]], [oz, f[2]]]) {
        if (Math.abs(d) < 1e-12) { if (Math.abs(o) >= outer) { t0 = 1; t1 = 0; } continue; }
        let ta = (-outer - o) / d, tb = (outer - o) / d; if (ta > tb) [ta, tb] = [tb, ta];
        if (ta > t0) t0 = ta; if (tb < t1) t1 = tb;
      }
      acc.fill(0);
      let t = t0;
      while (t < t1) {
        const x = ox + t * f[0], y = oy + t * f[1], z = oz + t * f[2], m = Math.max(Math.abs(x), Math.abs(y), Math.abs(z));
        let li = Ls.length - 1; for (let k = 0; k < Ls.length - 1; k++) if (m < Ls[k].lim) { li = k; break; }
        const L = Ls[li], dt = Math.min(L.vox * STEP, t1 - t);
        // trilinear at the midpoint of the step
        const tm = t + dt / 2, X = ox + tm * f[0], Y = oy + tm * f[1], Z = oz + tm * f[2];
        const fx = (X + L.half) / L.vox - 0.5, fy = (Y + L.half) / L.vox - 0.5, fz = (Z + L.half) / L.vox - 0.5;
        let i0 = Math.floor(fx), j0 = Math.floor(fy), k0 = Math.floor(fz);
        const wx = fx - i0, wy = fy - j0, wz = fz - k0, n = L.n, q = L.q, TT = T[li];
        for (let c = 0; c < ch; c++) {
          let v = 0;
          for (let dz = 0; dz < 2; dz++) { const kk = k0 + dz; if (kk < 0 || kk >= n) continue; const gz = dz ? wz : 1 - wz;
            for (let dy = 0; dy < 2; dy++) { const jj = j0 + dy; if (jj < 0 || jj >= n) continue; const gy = dy ? wy : 1 - wy;
              const row = n * (jj + n * kk);
              for (let dx = 0; dx < 2; dx++) { const ii = i0 + dx; if (ii < 0 || ii >= n) continue;
                const idx = ch === 1 ? row + ii : 4 * (row + ii) + c;
                v += (dx ? wx : 1 - wx) * gy * gz * TT[q[idx] + 256 * (ch === 1 ? 0 : c)]; } } }
          acc[c] += v * dt;
        }
        t += dt;
      }
      for (let c = 0; c < ch; c++) out[(py * W + px) * ch + c] = acc[c];
    }
  }
}
if (!isMainThread && workerData && workerData.kind === "story-posters") {
  parentPort.on("message", job => { projectRows({...job, levels: workerData.levels, tables: workerData.tables, ch: workerData.ch}); parentPort.postMessage(job.y0); });
}

/* ------------------------------------------------------------------ main */
const isUrl = s => /^https?:\/\//.test(String(s));
async function getBytes(p) {
  if (isUrl(p)) { const r = await fetch(p); if (!r.ok) throw new Error(`${p}: HTTP ${r.status}`); return new Uint8Array(await r.arrayBuffer()); }
  return new Uint8Array(await readFile(p));
}
const getJson = async p => JSON.parse(new TextDecoder().decode(await getBytes(p)));
const join = (base, rel) => (isUrl(base) ? base.replace(/\/?$/, "/") + rel : path.join(base, rel));
const exists = async p => { if (isUrl(p)) return true; try { await stat(p); return true; } catch { return false; } };

function args(argv) {
  const o = {g: null, ray: null, galRoot: path.join(process.env.TNG_WORK || process.env.CGM_WORK || ".", "data", "gal"),   // <work>/data/gal (tngenv.sh sets TNG_WORK)
    viz: null, catalog: null,
    camera: path.join(HERE, "story_posters.camera.json"), out: path.join(ROOT, "img/posters"), workers: Math.min(16, os.cpus().length),
    quick: false, check: false, shots: null, gateOut: path.join(ROOT, "img"), maxKb: 150};
  for (let i = 2; i < argv.length; i++) {
    const k = argv[i], v = () => argv[++i];
    if (k === "--g") o.g = v(); else if (k === "--ray") o.ray = v(); else if (k === "--gal-root") o.galRoot = v();
    else if (k === "--viz") o.viz = v(); else if (k === "--catalog") o.catalog = v(); else if (k === "--camera") o.camera = v();
    else if (k === "--out") o.out = v(); else if (k === "--workers") o.workers = Math.max(1, +v() | 0);
    else if (k === "--quick") o.quick = true; else if (k === "--check") o.check = true;
    else if (k === "--shots") o.shots = v().split(",").map(x => x.trim()).filter(Boolean);
    else if (k === "--gate-out") o.gateOut = v(); else if (k === "--max-kb") o.maxKb = +v();
    else throw new Error(`unknown option ${k}`);
  }
  if (!o.g) throw new Error("--g <id[,id...]|all> is required");
  return o;
}

async function galaxyList(o) {
  if (o.g !== "all") return o.g.split(",").map(s => +s.trim().replace(/^tng50-1-99-/i, "")).filter(Number.isFinite);
  const ids = [];
  for (const d of await readdir(o.galRoot)) if (/^\d+$/.test(d) && await exists(path.join(o.galRoot, d, "viz/manifest_v2.json"))) ids.push(+d);
  return ids.sort((a, b) => a - b);
}
async function storyRay(g) {
  try {
    const idx = await getJson(path.join(ROOT, "data/index.json"));
    const e = (idx.stories || []).find(s => +s.galaxy === g); if (e) return e.ray;
    if (idx.default && idx.default.ray) return idx.default.ray;
  } catch { /* no index */ }
  return "rand_b062_a062";
}
async function findEntry(o, g, ray) {
  const tries = o.catalog ? [o.catalog] : [path.join(o.galRoot, String(g), "library_trident/catalog.json"),
    path.join(o.galRoot, String(g), "catalog.json"), path.join(REPO, "docs/tng50/data/catalog.json")];
  for (const p of tries) {
    if (!(await exists(p))) continue;
    let c; try { c = await getJson(p); } catch { continue; }
    if (c.galaxy && c.galaxy.subhalo_id != null && +c.galaxy.subhalo_id !== g) continue;
    const es = c.entries || [], e = es.find(x => x.id === ray);
    if (e && Array.isArray(e.p0) && Array.isArray(e.p1)) return {entry: e, entries: es, galaxy: c.galaxy || {}, path: p};
  }
  throw new Error(`galaxy ${g}: no catalog entry with p0/p1 for ${ray} (tried ${tries.join(", ")})`);
}

async function loadCube(vizBase, cube, kind, n) {
  const require = createRequire(import.meta.url), sharp = require("sharp");
  const parts = [];
  for (const rel of cube.webp.paths) {
    const { data, info } = await sharp(Buffer.from(await getBytes(join(vizBase, rel)))).ensureAlpha().raw().toBuffer({resolveWithObject: true});
    if (info.width !== 16 * n || info.height !== 4 * n) throw new Error(`${rel}: ${info.width}x${info.height}, expected ${16 * n}x${4 * n}`);
    parts.push(new Uint8Array(data.buffer, data.byteOffset, data.length));
  }
  // atlas -> raw (docs/tng50/js/vizdata.js atlasToRaw, inlined so the buffer can be shared with the workers)
  const stars = kind === "stars", Wa = 16 * n, sab = new SharedArrayBuffer((stars ? 4 : 1) * n * n * n), out = new Uint8Array(sab);
  for (let k = 0; k < n; k++) {
    const P = parts[k >> 6], s = k & 63, x0 = (s & 15) * n, y0 = (s >> 4) * n;
    for (let j = 0; j < n; j++) {
      let src = ((y0 + j) * Wa + x0) * 4, dst = n * (j + n * k);
      if (!stars) for (let i = 0; i < n; i++, src += 4) out[dst + i] = P[src];
      else for (let i = 0, d = 4 * dst; i < n; i++, src += 4, d += 4) { out[d] = P[src]; out[d + 1] = P[src + 1]; out[d + 2] = P[src + 2]; out[d + 3] = 0; }
    }
  }
  return sab;
}
/* linear value per u8 code (log10-u8: q = 0 empty) */
function table(vmin, vmax, ch) {
  const T = new Float64Array(256 * ch), s = (vmax - vmin) / 254;
  for (let c = 0; c < ch; c++) for (let q = 1; q < 256; q++) T[256 * c + q] = 10 ** (vmin + (q - 1) * s);
  return T.buffer;
}

async function project(levels, tables, ch, W, H, hw, cam, nWorkers, off = [0, 0]) {
  const out = new SharedArrayBuffer(4 * W * H * ch), file = fileURLToPath(import.meta.url);
  const pool = Array.from({length: nWorkers}, () => new Worker(file, {workerData: {kind: "story-posters", levels, tables, ch}}));
  const band = Math.max(1, Math.ceil(H / (nWorkers * 6))), jobs = [];
  for (let y = 0; y < H; y += band) jobs.push([y, Math.min(H, y + band)]);
  await Promise.all(pool.map(w => new Promise((res, rej) => {
    const next = () => { const j = jobs.shift(); if (!j) { res(); return; } w.postMessage({W, H, y0: j[0], y1: j[1], hw, cam, out, off}); };
    w.on("message", next); w.on("error", rej); next();
  })));
  await Promise.all(pool.map(w => w.terminate()));
  return new Float32Array(out);
}

function lupton3(Si, Sr, Sg, o) {      // explorer: vizdata.js lupton + raymarch.js tune1 (knee) / tune2 (sat)
  const S0 = 10 ** (0.4 * (MU_ZERO - o.mu0)), Q = o.Q ?? 8;
  let R = Si / S0, G = Sr / S0, B = Sg / S0; const I = (R + G + B) / 3;
  if (!(I > 0)) return [0, 0, 0];
  const F = Math.asinh(Q * I) / (Q * I); R *= F; G *= F; B *= F;
  const mc = (R + G + B) / 3, sat = o.sat ?? 1; R = Math.max(0, mc + (R - mc) * sat); G = Math.max(0, mc + (G - mc) * sat); B = Math.max(0, mc + (B - mc) * sat);
  const m = Math.max(R, G, B), k = o.knee ?? 0;
  if (k > 0 && m > k) { const r = 1 - k, s = (k + r * (1 - Math.exp(-(m - k) / r))) / m; R *= s; G *= s; B *= s; }
  else if (m > 1) { R /= m; G /= m; B /= m; }
  return [R, G, B];
}

async function encode(rgb, W, H, file, enc, outW) {
  const require = createRequire(import.meta.url), sharp = require("sharp");
  let img = sharp(Buffer.from(rgb.buffer), {raw: {width: W, height: H, channels: 3}});
  if (outW && outW !== W) img = img.resize(outW, Math.round(outW * H / W), {kernel: "lanczos3"});
  const buf = await img.webp({quality: enc.quality ?? 80, effort: 6, smartSubsample: true}).toBuffer();
  await writeFile(file, buf);
  return {bytes: buf.length, sha256: createHash("sha256").update(buf).digest("hex").slice(0, 16)};
}

async function one(o, cam, g) {
  const ray = o.ray || await storyRay(g);
  const vizBase = o.viz ? o.viz.replace(/\{id\}/g, String(g)) : path.join(o.galRoot, String(g), "viz");
  const man = await getJson(join(vizBase, "manifest_v2.json"));
  const rows = man.frame.rows, R200c = +man.galaxy.R200c_kpc;
  const cat = await findEntry(o, g, ray);
  const p0 = toDisk(rows, cat.entry.p0), p1 = toDisk(rows, cat.entry.p1), B = beamFrame(p0, p1);
  const [W0, H0] = cam.size, div = o.quick ? 4 : 1, W = Math.round(W0 / div), H = Math.round(H0 / div);
  const dir = path.join(o.out, `${g}_${ray}`);
  const rec = {schema: "story-posters/1", galaxy: g, ray, R200c_kpc: +R200c.toFixed(3), quick: o.quick || undefined,
    beam: {b_kpc: +B.b.toFixed(3), length_kpc: +B.L.toFixed(3), s0_kpc: +B.s0.toFixed(3), s1_kpc: +B.s1.toFixed(3),
      n: B.n.map(x => +x.toFixed(6)), u: B.u.map(x => +x.toFixed(6)), w: B.w.map(x => +x.toFixed(6)),
      catalog_b_kpc: cat.entry.b_kpc ?? null, convention: "observer at p0 (ray start), quasar at p1 (ray end); s > 0 toward the quasar"},
    camera_sha256: createHash("sha256").update(JSON.stringify(cam)).digest("hex").slice(0, 16),
    sources: {manifest: man.schema, catalog: path.basename(path.dirname(cat.path)) + "/" + path.basename(cat.path),
      cubes: {}}, shots: {}};
  const shotList = Object.entries(cam.shots).filter(([n]) => !o.shots || o.shots.includes(n));
  const doGate = !!cam.gate && (!o.shots || o.shots.includes("gate"));
  const cubesNeeded = new Set();
  for (const [, s] of shotList) { if (s.layers.stars) cubesNeeded.add("stars"); if (s.layers.gas) cubesNeeded.add("gas:" + s.layers.gas.field); }
  if (doGate) { if (cam.gate.layers.stars) cubesNeeded.add("stars"); if (cam.gate.layers.gas) cubesNeeded.add("gas:" + cam.gate.layers.gas.field); }
  const loaded = {};
  if (!o.check) {
    for (const key of cubesNeeded) {
      const levels = [], tables = [];
      if (key === "stars") {
        const lv = (man.stars.levels || ["S0", "S1", "S2"]).slice();
        for (const L of lv) { const c = man.stars.cubes[L], meta = man.levels[L];
          levels.push({half: meta.half_kpc, n: meta.n, vox: meta.voxel_kpc, buf: await loadCube(vizBase, c, "stars", meta.n), ch: 4});
          tables.push(table(c.vmin, c.vmax, 3)); rec.sources.cubes[L] = c.raw_sha256.slice(0, 12); }
      } else {
        const fld = key.split(":")[1], F = man.gas.fields[fld];
        for (const L of man.gas.levels || ["L0", "L1", "L2"]) { const c = F.cubes[L], meta = man.levels[L];
          levels.push({half: meta.half_kpc, n: meta.n, vox: meta.voxel_kpc, buf: await loadCube(vizBase, c, "gas", meta.n), ch: 1});
          tables.push(table(c.vmin, c.vmax, 1)); rec.sources.cubes[fld + "_" + L] = c.raw_sha256.slice(0, 12); }
      }
      // finest first
      const ord = levels.map((l, i) => i).sort((a, b) => levels[a].half - levels[b].half);
      loaded[key] = {levels: ord.map(i => levels[i]), tables: ord.map(i => tables[i])};
    }
    if (shotList.length) await mkdir(dir, {recursive: true});
  }
  for (const [name, s] of shotList) {
    const hw = halfWidth(s.half_w, R200c), C = camera(B, s.tilt_deg, s.roll_deg), kpx = 2 * hw / W0;
    const P = q => { const pt = [dot(q, C.e1), dot(q, C.e2)]; return [+(W0 / 2 + pt[0] / kpx).toFixed(1), +(H0 / 2 - pt[1] / kpx).toFixed(1)]; };
    const shot = {scene: s.scene, size: [W0, H0], half_w_kpc: +hw.toFixed(3), kpc_per_px: +kpx.toFixed(5), tilt_deg: s.tilt_deg, roll_deg: s.roll_deg,
      center_px: [W0 / 2, H0 / 2], p0_px: P(p0), p1_px: P(p1), impact_px: P(scl(B.u, B.b)),
      check_px: (() => { const a = beamXY(B.b, B.s1, s.tilt_deg, s.roll_deg); return [+(W0 / 2 + a[0] / kpx).toFixed(1), +(H0 / 2 - a[1] / kpx).toFixed(1)]; })(),
      files: {}};
    if (s.others) {
      const segs = [];
      for (const e of cat.entries) {
        if (e.id === ray || !Array.isArray(e.p0) || !Array.isArray(e.p1)) continue;
        const a = P(toDisk(rows, e.p0)), b = P(toDisk(rows, e.p1));
        segs.push([Math.round(a[0]), Math.round(a[1]), Math.round(b[0]), Math.round(b[1]), +(e.b_kpc ?? 0).toFixed(1)]);
      }
      // deterministic subset: every k-th by catalog order, so the flash is spread over the sample
      const k = Math.max(1, Math.ceil(segs.length / (s.others.max || 160)));
      shot.others = segs.filter((x, i) => i % k === 0);
    }
    if (!o.check) {
      for (const [layer, L] of Object.entries(s.layers)) {
        const key = layer === "stars" ? "stars" : "gas:" + L.field, Lc = loaded[key];
        const t0 = Date.now();
        const ch = layer === "stars" ? 3 : 1;
        const img = await project(Lc.levels, Lc.tables, ch, W, H, hw, C, o.workers);
        const rgb = new Uint8Array(W * H * 3);
        if (layer === "stars") {
          for (let i = 0; i < W * H; i++) { const c = lupton3(img[3 * i], img[3 * i + 1], img[3 * i + 2], L);
            rgb[3 * i] = Math.round(255 * c[0]); rgb[3 * i + 1] = Math.round(255 * c[1]); rgb[3 * i + 2] = Math.round(255 * c[2]); }
        } else {
          const {lut} = await import("../docs/tng50/js/colormaps.js"), T = lut(L.lut || "tng_dusk");
          let lo = Infinity, hi = -Infinity;
          for (let i = 0; i < W * H; i++) {
            const N = img[i] * CM_PER_KPC, lg = N > 0 ? Math.log10(N) : -Infinity; if (lg > hi) hi = lg; if (lg > -Infinity && lg < lo) lo = lg;
            let x = (lg - L.vmin) / (L.vmax - L.vmin); x = x > 0 ? Math.min(1, x) ** (L.gamma ?? 1) : 0;
            const k = 4 * Math.round(255 * x), a = Math.min(1, x * 3);       // fade the darkest end to black sky
            rgb[3 * i] = Math.round(T[k] * a); rgb[3 * i + 1] = Math.round(T[k + 1] * a); rgb[3 * i + 2] = Math.round(T[k + 2] * a);
          }
          shot.gas_logN_range = [+lo.toFixed(2), +hi.toFixed(2)]; shot.gas_scale = {vmin: L.vmin, vmax: L.vmax, units: "log10 N_H (cm^-2)", lut: L.lut || "tng_dusk"};
        }
        const enc = cam.encode[layer] || {}, outW = Math.round(W * (enc.scale ?? 1));
        const file = `${name}_${layer}.webp`;
        const r = await encode(rgb, W, H, path.join(dir, file), enc, outW);
        shot.files[layer] = {file, size: [outW, Math.round(outW * H / W)], ...r};
        process.stderr.write(`  ${g} ${name} ${layer}: ${W}x${H} in ${((Date.now() - t0) / 1000).toFixed(1)} s, ${(r.bytes / 1024).toFixed(0)} kB\n`);
      }
    }
    rec.shots[name] = shot;
  }
  if (!o.check && shotList.length) await writeFile(path.join(dir, "posters.json"), JSON.stringify(rec, null, 1) + "\n");
  if (doGate) rec.gate = await gatePosters(o, cam, {g, ray, B, p0, p1, R200c, loaded, sources: rec.sources, catalogB: cat.entry.b_kpc});
  return rec;
}

/* ------------------------------------------------------------------ gate posters (v2 B0 gate, explorer card) */
/* layer images (gas through the explorer LUT with a black-sky fade, starlight by the Lupton composite) are screen-blended,
   then the beam is drawn as a thin warm core with a soft glow, and a dot at the quasar end (p1) when it is in frame */
export function screen(a, b) { return 255 - Math.round((255 - a) * (255 - b) / 255); }
export function drawBeam(rgb, W, H, A, Bp, st) {
  const [r0, g0, b0] = st.color || [255, 244, 223], core = st.width_px ?? 2, glow = st.glow_px ?? 9, al = st.alpha ?? 0.8, ga = st.glow_alpha ?? 0.3;
  /* st.extend: the light goes on past the observer end A toward the telescope, drawn as a fade over extend x |AB| */
  const ext = st.extend ?? 0; if (ext > 0) A = [A[0] - (Bp[0] - A[0]) * ext, A[1] - (Bp[1] - A[1]) * ext];
  const tA = ext / (1 + ext), fi = st.fade_in ?? 0;   // tA: the observer end on the extended segment
  const dx = Bp[0] - A[0], dy = Bp[1] - A[1], L2 = dx * dx + dy * dy || 1, R = 3 * glow;
  const x0 = Math.max(0, Math.floor(Math.min(A[0], Bp[0]) - R)), x1 = Math.min(W - 1, Math.ceil(Math.max(A[0], Bp[0]) + R));
  const y0 = Math.max(0, Math.floor(Math.min(A[1], Bp[1]) - R)), y1 = Math.min(H - 1, Math.ceil(Math.max(A[1], Bp[1]) + R));
  for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
    const t = Math.max(0, Math.min(1, ((x + 0.5 - A[0]) * dx + (y + 0.5 - A[1]) * dy) / L2));
    const ex = x + 0.5 - (A[0] + t * dx), ey = y + 0.5 - (A[1] + t * dy), d2 = ex * ex + ey * ey;
    if (d2 > R * R) continue;
    let fade = t >= tA ? 0.75 + 0.25 * (t - tA) / (1 - tA || 1) : 0.75 * (t / (tA || 1)) ** 1.6;
    if (fi > 0 && t < fi) fade *= (t / fi) ** 1.3;   // st.fade_in: the line rises from nothing over this fraction from A
    const w = fade * (al * Math.exp(-d2 / (2 * (core / 2) ** 2)) + ga * Math.exp(-d2 / (2 * glow * glow)));
    if (w < 1e-3) continue;
    const i = 3 * (y * W + x), k = Math.min(1, w);
    rgb[i] = Math.round(rgb[i] + (r0 - rgb[i]) * k); rgb[i + 1] = Math.round(rgb[i + 1] + (g0 - rgb[i + 1]) * k); rgb[i + 2] = Math.round(rgb[i + 2] + (b0 - rgb[i + 2]) * k);
  }
  const q = st.quasar_r_px ?? 0;
  if (q > 0 && Bp[0] >= 0 && Bp[0] < W && Bp[1] >= 0 && Bp[1] < H) {
    const Rq = 6 * q;
    for (let y = Math.max(0, Math.floor(Bp[1] - Rq)); y <= Math.min(H - 1, Math.ceil(Bp[1] + Rq)); y++)
      for (let x = Math.max(0, Math.floor(Bp[0] - Rq)); x <= Math.min(W - 1, Math.ceil(Bp[0] + Rq)); x++) {
        const d2 = (x + 0.5 - Bp[0]) ** 2 + (y + 0.5 - Bp[1]) ** 2, k = Math.min(1, Math.exp(-d2 / (2 * q * q)) + 0.35 * Math.exp(-d2 / (2 * (3 * q) ** 2)));
        const i = 3 * (y * W + x); rgb[i] = Math.round(rgb[i] + (r0 - rgb[i]) * k); rgb[i + 1] = Math.round(rgb[i + 1] + (g0 - rgb[i + 1]) * k); rgb[i + 2] = Math.round(rgb[i + 2] + (b0 - rgb[i + 2]) * k);
      }
  }
}
async function encodeCapped(rgb, W, H, file, q0, maxBytes) {
  const require = createRequire(import.meta.url), sharp = require("sharp");
  let q = q0, buf;
  for (;;) {
    buf = await sharp(Buffer.from(rgb.buffer, rgb.byteOffset, rgb.length), {raw: {width: W, height: H, channels: 3}}).webp({quality: q, effort: 6, smartSubsample: true}).toBuffer();
    if (buf.length <= maxBytes || q <= 40) break;
    q -= 6;
  }
  if (buf.length > maxBytes) throw new Error(`${path.basename(file)}: ${(buf.length / 1024).toFixed(0)} kB at quality ${q}, over the ${maxBytes / 1024} kB cap`);
  await writeFile(file, buf);
  return {bytes: buf.length, quality: q, sha256: createHash("sha256").update(buf).digest("hex").slice(0, 16)};
}
async function gatePosters(o, cam, ctx) {
  const G = cam.gate, {g, ray, B, p0, p1, R200c, loaded} = ctx, C = camera(B, G.tilt_deg, G.roll_deg);
  const meta = {schema: "story-gate-poster/1", galaxy: g, ray, R200c_kpc: +R200c.toFixed(3), tilt_deg: G.tilt_deg, roll_deg: G.roll_deg,
    camera_sha256: createHash("sha256").update(JSON.stringify(G)).digest("hex").slice(0, 16), quick: o.quick || undefined,
    convention: "observer at p0 (ray start), quasar at p1 (ray end); the drawn line is the full sightline", sources: ctx.sources, variants: {}};
  if (!o.check) await mkdir(o.gateOut, {recursive: true});
  for (const [vname, V] of Object.entries(G.variants)) {
    const [W0, H0] = V.size, div = o.quick ? 4 : 1, W = Math.round(W0 / div), H = Math.round(H0 / div);
    const hw = halfWidth(V.half_w, R200c), hh = hw * H0 / W0, kpx = 2 * hw / W0, [cx, cy] = V.center_frac || [0.5, 0.5];
    const off = [(cx - 0.5) * 2 * hw, (0.5 - cy) * 2 * hh];
    const P = q => [+(W0 * cx + dot(q, C.e1) / kpx).toFixed(1), +(H0 * cy - dot(q, C.e2) / kpx).toFixed(1)];
    const rec = {size: [W0, H0], half_w_kpc: +hw.toFixed(3), kpc_per_px: +kpx.toFixed(5), center_px: [W0 * cx, H0 * cy], p0_px: P(p0), p1_px: P(p1),
      impact_px: P(scl(B.u, B.b)), file: `poster_${g}_${ray}${V.suffix}.webp`};
    if (!o.check) {
      const t0 = Date.now(), rgb = new Uint8Array(W * H * 3).fill(0);
      for (const [layer, L] of Object.entries(G.layers)) {
        const key = layer === "stars" ? "stars" : "gas:" + L.field, Lc = loaded[key], ch = layer === "stars" ? 3 : 1;
        const img = await project(Lc.levels, Lc.tables, ch, W, H, hw, C, o.workers, off);
        if (layer === "stars") for (let i = 0; i < W * H; i++) { const c = lupton3(img[3 * i], img[3 * i + 1], img[3 * i + 2], L);
          for (let k = 0; k < 3; k++) rgb[3 * i + k] = screen(rgb[3 * i + k], Math.round(255 * c[k])); }
        else { const {lut} = await import("../docs/tng50/js/colormaps.js"), T = lut(L.lut || "tng_dusk"), gain = L.gain ?? 1;
          for (let i = 0; i < W * H; i++) { const N = img[i] * CM_PER_KPC, lg = N > 0 ? Math.log10(N) : -Infinity;
            let x = (lg - L.vmin) / (L.vmax - L.vmin); x = x > 0 ? Math.min(1, x) ** (L.gamma ?? 1) : 0;
            const k4 = 4 * Math.round(255 * x), a = Math.min(1, x * (L.fade ?? 3)) * gain;
            for (let k = 0; k < 3; k++) rgb[3 * i + k] = screen(rgb[3 * i + k], Math.round(T[k4 + k] * a)); } }
      }
      const s = 1 / div, bm = {...G.beam, ...(V.beam || {})}, k = s * (V.beam_scale ?? 1);   // variant beam keys override the shared ones
      drawBeam(rgb, W, H, rec.p0_px.map(v => v * s), rec.p1_px.map(v => v * s), {...bm, width_px: (bm.width_px ?? 2) * k, glow_px: (bm.glow_px ?? 9) * k, quasar_r_px: (bm.quasar_r_px ?? 0) * k});
      const r = await encodeCapped(rgb, W, H, path.join(o.gateOut, rec.file), V.quality ?? 76, (V.max_kb ?? o.maxKb) * 1024);
      Object.assign(rec, r);
      process.stderr.write(`  ${g} gate ${vname}: ${W}x${H} in ${((Date.now() - t0) / 1000).toFixed(1)} s, ${(r.bytes / 1024).toFixed(0)} kB (q ${r.quality})\n`);
    }
    meta.variants[vname] = rec;
  }
  if (!o.check) await writeFile(path.join(o.gateOut, `poster_${g}_${ray}.json`), JSON.stringify(meta, null, 1) + "\n");
  return meta;
}

async function main() {
  const o = args(process.argv), cam = JSON.parse(await readFile(o.camera, "utf8"));
  const ids = await galaxyList(o), done = [], failed = [];
  for (const g of ids) {
    try { const r = await one(o, cam, g); done.push(g); if (o.check) process.stdout.write(JSON.stringify(r) + "\n"); }
    catch (e) { failed.push(g); process.stderr.write(`galaxy ${g}: ${e.message}\n`); }
  }
  process.stderr.write(`posters: ${done.length} done, ${failed.length} failed${failed.length ? " (" + failed.join(", ") + ")" : ""}\n`);
  if (failed.length && !done.length) process.exit(1);
}
if (isMainThread && process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main().catch(e => { console.error(e); process.exit(1); });
