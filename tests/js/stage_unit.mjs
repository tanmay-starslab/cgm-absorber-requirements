// Unit tests of the explainer's 3D stage modules (U_stage; DESIGN_final §5.2 acceptance). Node part (always):
//   governor hysteresis; software-GL classification; capsule weights (f_vol + f_splat = 1 along the ray to 1e-6, shape);
//   tube decoding and the l window; kernel CDF (monotone, 0/1 outside the chord, 1/2 at the centre, table rows normalised);
//   TF blend (same field: bytes interpolated; different fields: opacity dips through 0 at mix 0.5); volcore sliced uploads
//   (a level is bound only once every slice is uploaded; a batch per pump; budget eviction) with a stub renderer.
// Browser part (TNG_BROWSER=1; TNG_EDGE or --edge): (1) a bright ray cell behind a dense, black fog slab is dimmed by
//   exp(-tau_fog) within 5 % (two-segment composite, C_eng P0-3); (2) the software-GL probe routes SwiftShader to "stills"
//   unless forced (C_eng P1-2; run it with the CPU browser to exercise that branch).
//   node tests/js/stage_unit.mjs           TNG_BROWSER=1 node tests/js/stage_unit.mjs [--edge <binary>]
import {dirname, join, resolve, extname} from "node:path";
import {fileURLToPath, pathToFileURL} from "node:url";
import {readFileSync, existsSync} from "node:fs";
import {createServer} from "node:http";
const HERE = dirname(fileURLToPath(import.meta.url)), ROOT = resolve(HERE, "../.."), ST = join(ROOT, "docs/tng50/learn/how-a-spectrum-is-made/js/stage");
const imp = f => import(pathToFileURL(f).href);
const [{createGovernor}, {classify}, tube, rc, tfs, {createVolCore}] = await Promise.all([imp(join(ST, "governor.js")), imp(join(ST, "glcheck.js")), imp(join(ST, "tube.js")),
  imp(join(ST, "raycells.js")), imp(join(ST, "tfstory.js")), imp(join(ROOT, "docs/tng50/js/volcore.js"))]);
let fails = 0; const check = (ok, msg) => { console.log(`${ok ? "ok  " : "FAIL"} ${msg}`); if (!ok) fails++; };

/* ---- governor ---- */
{ const g = createGovernor({start: 1}); for (let i = 0; i < 4; i++) g.push(30); check(g.scale === 0.5, "governor: 4 slow frames keep the scale");
  g.push(30); check(g.scale === 0.35, "governor: the 5th slow frame drops one rung");
  for (let i = 0; i < 59; i++) g.push(5); check(g.scale === 0.35, "governor: 59 fast frames do not raise"); g.push(5); check(g.scale === 0.5, "governor: the 60th fast frame raises one rung");
  for (let i = 0; i < 10; i++) g.push(400); check(g.scale === 0.5, "governor: frames > 250 ms are ignored");
  for (let i = 0; i < 4; i++) g.push(30); g.push(14); g.push(30); check(g.scale === 0.5, "governor: a normal frame resets the slow count");
  const h = createGovernor({start: 0}); for (let i = 0; i < 20; i++) h.push(80); check(h.scale === 0.35 && h.state().drops === 0, "governor: never below the bottom rung"); }

/* ---- software GL ---- */
check(classify({webgl2: true, renderer: "ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device (Subzero)), SwiftShader driver)"}).tier === "stills", "glcheck: SwiftShader -> stills");
check(classify({webgl2: true, renderer: "llvmpipe (LLVM 15.0.7, 256 bits)"}).tier === "stills", "glcheck: llvmpipe -> stills");
check(classify({webgl2: true, renderer: "Microsoft Basic Render Driver"}).tier === "stills", "glcheck: Basic Render -> stills");
check(classify({webgl2: true, renderer: "ANGLE (NVIDIA, Vulkan 1.3 (NVIDIA A100-SXM4-80GB), NVIDIA)", benchMs: 2}).tier === "3d", "glcheck: NVIDIA A100 -> 3d");
check(classify({webgl2: true, renderer: "ANGLE (Apple, ANGLE Metal Renderer: Apple M2, Unspecified Version)", benchMs: 3}).tier === "3d", "glcheck: Apple M2 -> 3d");
check(classify({webgl2: true, renderer: "Intel Iris", benchMs: 90}).tier === "stills", "glcheck: a slow micro-benchmark -> stills");
check(classify({webgl2: true, renderer: "llvmpipe", force3d: true}).tier === "3d", "glcheck: ?force3d keeps 3D");
check(classify({webgl2: false, force3d: true}).tier === "stills", "glcheck: no WebGL2 -> stills even when forced");

/* ---- capsule ---- */
{ const n = [0.3, -0.5, 0.8124], m = Math.hypot(...n), N = n.map(x => x / m), O = [10, 20, -5], cap = {l0: -30, l1: 60, r: 20, edge: 0.3};
  let worst = 0, lo = 1, hi = 0, prev = null, jump = 0;
  for (let i = 0; i <= 10000; i++) { const l = -250 + 500 * i / 10000, p = O.map((o, k) => o + l * N[k]), f = tube.capsuleF(p, cap, O, N), fv = 1 - f;
    worst = Math.max(worst, Math.abs(fv + f - 1)); lo = Math.min(lo, f); hi = Math.max(hi, f); if (prev !== null) jump = Math.max(jump, Math.abs(f - prev)); prev = f; }
  check(worst <= 1e-6, `capsule: f_vol + f_splat = 1 along the ray (max |err| ${worst.toExponential(1)})`);
  check(lo === 0 && hi === 1, "capsule: weight 1 in the core, 0 outside");
  check(jump < 0.01, `capsule: smooth along the ray (max step ${jump.toFixed(4)} per 0.05 kpc)`);
  const e1 = [N[1], -N[0], 0].map(x => x / Math.hypot(N[0], N[1]));
  const at = (l, r) => tube.capsuleF(O.map((o, k) => o + l * N[k] + r * e1[k]), cap, O, N);
  check(at(15, 0) === 1 && at(15, 13.9) === 1 && at(15, 20.01) === 0 && at(15, 17) > 0 && at(15, 17) < 1, "capsule: radial core 0.7 r, edge to r");
  check(at(-30.01, 0) === 0 && at(60.01, 0) === 0 && at(-16, 0) === 1 && at(-20, 0) > 0 && at(-20, 0) < 1, "capsule: ends at l0, l1 with a 30 % soft edge");
  check(tube.capsuleF(O, {l0: 0, l1: 0, r: 20}, O, N) === 0 && tube.capsuleF(O, {l0: -1, l1: 1, r: 0}, O, N) === 0, "capsule: an empty capsule carves nothing"); }

/* ---- tube decoding ---- */
{ const n = 5, st = 16, R = {lognH: [-7, 1], logT: [3, 8], logZ: [-3, 1], r_eq: [0, 8], vlos: [-600, 600]}, lo = [-10, -20, -30], hi = [10, 20, 30];
  const buf = new ArrayBuffer(n * st + 4 * n), dv = new DataView(buf), u8 = new Uint8Array(buf), q8 = (v, r) => Math.round(1 + (v - r[0]) / (r[1] - r[0]) * 254);
  const src = []; for (let i = 0; i < n; i++) { const p = [-10 + 4 * i, 20 - 8 * i, -30 + 13 * i], c = {p, nH: -5 + i, T: 4 + 0.5 * i, Z: -1, r: 1 + i, v: -300 + 150 * i, l: -100 + 50 * i};
    src.push(c); p.forEach((x, a) => dv.setUint16(i * st + 2 * a, Math.round((x - lo[a]) / (hi[a] - lo[a]) * 65535), true));
    u8[i * st + 6] = q8(c.nH, R.lognH); u8[i * st + 7] = q8(c.T, R.logT); u8[i * st + 8] = q8(c.Z, R.logZ); u8[i * st + 9] = q8(c.r, R.r_eq); u8[i * st + 12] = q8(c.v, R.vlos);
    dv.setFloat32(n * st + 4 * i, c.l, true); }
  const t = tube.decodeTube(buf, {n, stride: st, lo, hi, ranges: R});
  let ep = 0, ef = 0; src.forEach((c, i) => { c.p.forEach((x, a) => (ep = Math.max(ep, Math.abs(t.pos[3 * i + a] - x)))); ef = Math.max(ef, Math.abs(t.lognH[i] - c.nH), Math.abs(t.logT[i] - c.T), Math.abs(t.req[i] - c.r), Math.abs(t.vlos[i] - c.v) / 100); });
  check(ep < 1e-3 && ef < 0.03, `tube: decode round trip (pos ${ep.toExponential(1)} kpc, fields ${ef.toFixed(3)})`);
  check(tube.lowerBound(t.l, -100) === 0 && tube.lowerBound(t.l, -60) === 1 && tube.lowerBound(t.l, 1e9) === n, "tube: lowerBound on the sorted l"); }

/* ---- kernel CDF ---- */
{ const tab = rc.kernelTable(); let rows = 0; for (let ib = 0; ib < rc.NB; ib++) if (Math.abs(tab[ib * rc.NT + rc.NT - 1] - 1) < 1e-9 && tab[ib * rc.NT] === 0) rows++;
  check(rows === rc.NB, "kernel: every table row runs 0 -> 1");
  const cell = {l: 12, h: 3, d: 1.2}, c = Math.sqrt(9 - 1.44); let mono = true, prev = -1;
  for (let i = 0; i <= 400; i++) { const w = rc.kernelW(12 - 4 + 8 * i / 400, cell); if (w < prev - 1e-12) mono = false; prev = w; }
  check(mono, "kernel: W(s) monotone");
  check(rc.kernelW(12 - c - 1e-6, cell) === 0 && rc.kernelW(12 + c + 1e-6, cell) === 1, "kernel: 0 before the chord, 1 after");
  check(Math.abs(rc.kernelW(12, cell) - 0.5) < 1e-6, "kernel: 1/2 at the centre (symmetric)");
  check(rc.kernelW(12 - 0.5 * c, {l: 12, h: 3, d: 0}) < 0.5 * (1 - 0.5) + 0.2, "kernel: centrally concentrated (W at -c/2 well below linear 0.25+)"); }

/* ---- TF blend ---- */
{ const a = tfs.blendTF("density"), b = tfs.blendTF("halo"), m = tfs.blendTF("density", "halo", 0.25);
  let ok = true; for (let i = 0; i < a.bytes.length; i += 97) if (Math.abs(m.bytes[i] - (0.75 * a.bytes[i] + 0.25 * b.bytes[i])) > 1) ok = false;
  check(ok && m.colorField === "nH", "tf: same field -> TF bytes interpolated");
  const x = tfs.blendTF("density", "phases", 0.25), y = tfs.blendTF("density", "phases", 0.5), z = tfs.blendTF("density", "phases", 0.75);
  check(x.colorField === "nH" && Math.abs(x.alphaScale - 0.5) < 1e-9 && y.alphaScale === 0 && z.colorField === "T" && Math.abs(z.alphaScale - 0.5) < 1e-9, "tf: different fields -> fade out to 0 at 0.5, then fade in");
  let amax = 0; for (let i = 3; i < y.bytes.length; i += 4) amax = Math.max(amax, y.bytes[i]); check(amax === 0, "tf: at mix 0.5 the sky is clear");
  check(JSON.stringify(tfs.fieldsOf("phases")) === '["T","nH"]' && JSON.stringify(tfs.fieldsOf("speed")) === '["vel","nH"]', "tf: fieldsOf lists the colour and weight fields");
  check(JSON.stringify(tfs.blendTF("phases", "phases", 0, {darkSky: false}).fog) === "[0,0]" && tfs.blendTF("phases").fog[0] > 0, "tf: dark sky adds the depth fog"); }

/* ---- volcore: sliced uploads with a stub renderer ---- */
{ class V3 { constructor(x = 0, y = 0, z = 0) { Object.assign(this, {x, y, z}); } setComponent(i, v) { this["xyz"[i]] = v; } set(a, b, c) { Object.assign(this, {x: a, y: b, z: c}); } }
  class Box3 { constructor(a, b) { this.min = a; this.max = b; } }
  class Tex { constructor(data, w, h, d) { this.image = {data, width: w, height: h, depth: d}; this.source = {dataReady: true}; } dispose() { this.disposed = true; } }
  const T = {Data3DTexture: Tex, Box3, Vector3: V3, RedFormat: 1, RGBAFormat: 2, UnsignedByteType: 3, LinearFilter: 4, ClampToEdgeWrapping: 5};
  const calls = []; const renderer = {initTexture: t => calls.push(["init", t.source.dataReady]), copyTextureToTexture3D: (s, d, box, pos) => calls.push(["copy", box.min.z, box.max.z, pos.z])};
  const core = createVolCore({T, renderer, manifest: null, slices: 16, budgetMs: 0, budgetBytes: 3 * 64 ** 3});
  const U = {}; for (const k of ["uGas0", "uGas1", "uGas2", "uW0", "uW1", "uW2", "uVel0", "uVel1", "uVel2"]) U[k] = {value: null};
  for (const k of ["uGasHave", "uWHave", "uVelHave"]) U[k] = {value: new V3()}; U.uGasRange = {value: new V3()}; U.uWRange = {value: new V3()}; U.uN = {value: 0}; U.uVelV = {value: 0};
  const p = core.setSynthetic("nH", "L0", new Uint8Array(64 ** 3), {vmin: -6, vmax: 0.4});
  check(calls[0][0] === "init" && calls[0][1] === false, "volcore: allocation without upload (texStorage3D only, dataReady false)");
  core.bind(U, {color: "nH", empty1: "E1", empty4: "E4"}); check(U.uGasHave.value.x === 0 && U.uGas0.value === "E1", "volcore: an incomplete level is not bound");
  const r1 = core.pump(); check(r1.uploadedSlices === 16 && calls[1][1] === 0 && calls[1][2] === 16, "volcore: one 16-slice batch per pump at a 0 ms budget");
  core.pump(); core.pump(); check(core.state("nH", "L0") === "uploading", "volcore: still uploading after 48 of 64 slices");
  core.pump(); await p; check(core.state("nH", "L0") === "ready", "volcore: ready after the last slice");
  core.bind(U, {color: "nH", empty1: "E1", empty4: "E4"}); check(U.uGasHave.value.x === 1 && U.uGas0.value instanceof Tex && U.uN.value === 64 && U.uGasRange.value.x === -6, "volcore: bound with have, n and range");
  const zs = calls.filter(c => c[0] === "copy").map(c => c[1]); check(JSON.stringify(zs) === "[0,16,32,48]", "volcore: slices cover 0..n once, in order");
  for (const L of ["L1", "L2"]) { core.setSynthetic("T", L, new Uint8Array(64 ** 3)); for (let i = 0; i < 4; i++) core.pump(); }
  core.setSynthetic("Z", "L0", new Uint8Array(64 ** 3)); for (let i = 0; i < 4; i++) core.pump();
  check(core.gpuBytes() <= 3 * 64 ** 3 && core.state("nH", "L0") === "ready", "volcore: the GPU budget evicts least recently used, unpinned levels");
  /* texture pool: prewarm allocates and touches; loads reuse slots; an exhausted pool recycles the LRU unpinned level */
  const calls2 = []; const r2 = {initTexture: () => calls2.push("init"), copyTextureToTexture3D: (s, d, box) => calls2.push(["copy", box.min.z, box.max.z])};
  const pc = createVolCore({T, renderer: r2, manifest: null, slices: 64, budgetMs: 0});
  await pc.prewarm({r8: 2, n: 32});
  check(calls2.filter(c => c === "init").length === 2 && calls2.filter(c => c[0] === "copy" && c[2] - c[1] === 1).length === 2 && pc.pool.r8.length === 2, "volcore pool: prewarm allocates and touches each slot (one slice)");
  const before = calls2.filter(c => c === "init").length;
  const qa = pc.setSynthetic("a", "L0", new Uint8Array(32 ** 3)); pc.pump(); await qa; const qb = pc.setSynthetic("b", "L0", new Uint8Array(32 ** 3)); pc.pump(); await qb;
  check(calls2.filter(c => c === "init").length === before && pc.pool.r8.length === 0, "volcore pool: loads take pool slots, no new allocation");
  pc.bind(U, {color: "b", empty1: "E1", empty4: "E4"});
  const qc = pc.setSynthetic("c", "L0", new Uint8Array(32 ** 3)); pc.pump(); await qc;
  check(calls2.filter(c => c === "init").length === before && pc.state("a", "L0") === "absent" && pc.state("b", "L0") === "ready" && (pc.stats.recycled || 0) === 1, "volcore pool: exhausted -> recycles the LRU unpinned level (a), keeps the bound one (b)");
  pc.drop("c", "L0"); check(pc.pool.r8.length === 1 && pc.state("c", "L0") === "absent", "volcore pool: drop returns the slot");
  /* fence gate (S0_freeze): one batch per signalled fence; an unsignalled fence skips the pump without waiting on the CPU */
  let sig = false; const fences = [];
  const fgl = {SYNC_GPU_COMMANDS_COMPLETE: 1, TIMEOUT_EXPIRED: 2, ALREADY_SIGNALED: 3, fenceSync: () => { const f = {id: fences.length}; fences.push(f); return f; }, flush() {},
    clientWaitSync: (f, fl, t) => { if (t !== 0) throw new Error("CPU wait"); return sig ? 3 : 2; }, deleteSync: f => { f.deleted = true; }};
  const calls3 = []; const r3 = {getContext: () => fgl, initTexture() {}, copyTextureToTexture3D: (s, d, box) => calls3.push([box.min.z, box.max.z])};
  const fc = createVolCore({T, renderer: r3, manifest: null, slices: 16, budgetMs: 1e9, fence: true});
  const qf = fc.setSynthetic("f", "L0", new Uint8Array(64 ** 3));
  const g1 = fc.pump(); check(g1.uploadedSlices === 16 && fences.length === 1, "volcore fence: first pump uploads one batch (not the whole budget) and places a fence");
  const g2 = fc.pump(); check(g2.gated === true && g2.uploadedSlices === 0 && calls3.length === 1, "volcore fence: an unsignalled fence skips the batch");
  sig = true; fc.pump(); check(calls3.length === 2 && fences[0].deleted && fences.length === 2, "volcore fence: a signalled fence releases the next batch and is deleted");
  fc.pump(); fc.pump(); await qf; check(fc.state("f", "L0") === "ready", "volcore fence: the level completes");
  sig = false; const qh = fc.setSynthetic("h", "L0", new Uint8Array(64 ** 3)); let gated = 0; for (let i = 0; i < 200 && fc.state("h", "L0") !== "ready"; i++) if (fc.pump().gated) gated++;
  await qh; check(fc.state("h", "L0") === "ready" && fc.stats.fenceGiveUps >= 1 && gated <= 4 * 30, "volcore fence: a fence that never signals cannot stall uploads (gives up after 30 gated pumps)");
  const nf = createVolCore({T, renderer: r3, manifest: null, slices: 16, budgetMs: 1e9}); fences.length = 0; nf.setSynthetic("g", "L0", new Uint8Array(64 ** 3));
  check(nf.pump().uploadedSlices === 64 && fences.length === 0, "volcore fence: off by default (no fences, budget-bound batches)"); }

/* ---- phase 1: story-tube/1, kernel CDF from story-data/2, shells, governor rungs, band ceiling, speed colours ---- */
{ const [G, SH, PO, STG] = await Promise.all([imp(join(ST, "governor.js")), imp(join(ST, "shells.js")), imp(join(ST, "post.js")), imp(join(ST, "stage.js"))]);
  const zlib = await import("node:zlib");
  const SD = join(ROOT, "docs/tng50/learn/how-a-spectrum-is-made/data"), dataF = join(SD, "story_488530_rand_b062_a062.json");
  /* story-tube/1 round trip on synthetic records */
  { const fr = {n: [0, 0.6, 0.8], up: [0, 0.8, -0.6], side: [1, 0, 0], p0: [5, -100, -130], half: 250}, lo = [-260, -22, -22], span = [520, 44, 44], n = 4, st = 14;
    const buf = new ArrayBuffer(n * st), dv = new DataView(buf), src = [];
    for (let i = 0; i < n; i++) { const c = {L: -200 + 120 * i, U: -10 + 6 * i, S: 15 - 9 * i, nH: -5 + i, T: 4.2 + 0.7 * i, Z: -1 + 0.3 * i, req: 0.5 + i, nHI: -9 + i, nOVI: -11 + 0.5 * i, cl: 0x21 * (i % 2), v: -96 + 60 * i};
      src.push(c); [c.L, c.U, c.S].forEach((x, a) => dv.setUint16(i * st + 2 * a, Math.round((x - lo[a]) / span[a] * 65535), true));
      const u = (o, x) => dv.setUint8(i * st + o, Math.round(x)); u(6, (c.nH + 7) / 8 * 255); u(7, (c.T - 3) / 5 * 255); u(8, (c.Z + 3) / 4 * 255); u(9, (Math.log10(c.req) + 2) / 3.5 * 255);
      u(10, (c.nHI + 16) / 16 * 255); u(11, (c.nOVI + 16) / 16 * 255); u(12, c.cl); dv.setInt8(i * st + 13, Math.round(c.v / 4)); }
    const t = tube.decodeStoryTube(buf, {n, lo, span, frame: fr});
    let ep = 0, ef = 0; src.forEach((c, i) => { const P = fr.p0.map((p, a) => p + (c.L + fr.half) * fr.n[a] + c.U * fr.up[a] + c.S * fr.side[a]);
      P.forEach((x, a) => (ep = Math.max(ep, Math.abs(t.pos[3 * i + a] - x)))); ef = Math.max(ef, Math.abs(t.lognH[i] - c.nH), Math.abs(t.logT[i] - c.T), Math.abs(t.nHI[i] - c.nHI), Math.abs(t.nOVI[i] - c.nOVI)); });
    check(ep < 0.01 && ef < 0.04 && t.hasIon && t.cloud[1] === 0x21 && Math.abs(t.vlos[0] + 96) <= 2 && Math.abs(t.l[2] - 40) < 0.01, `story-tube/1: decode round trip (pos ${ep.toExponential(1)} kpc, fields ${ef.toFixed(3)} dex)`);
    let threw = false; try { tube.decodeStoryTube(new ArrayBuffer(10), {n, lo, span, frame: fr}); } catch { threw = true; } check(threw, "story-tube/1: a short buffer is an error, not garbage"); }
  if (existsSync(dataF)) {
    const data = JSON.parse(readFileSync(dataF, "utf8"));
    /* the real tube: every record within the tube radius of the ray, sorted by l, the ion bytes present */
    const hdr = JSON.parse(readFileSync(join(SD, data.tube.path.replace(/\.bin\.gz$/, ".json")), "utf8")), raw = zlib.gunzipSync(readFileSync(join(SD, data.tube.path)));
    const tb = tube.decodeStoryTube(raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength), hdr, data.geometry.ray), R = data.geometry.ray;
    let rmax = 0, sorted = true, ion = 0; const O = R.p0.map((p, a) => p + R.half * R.n[a]);
    for (let i = 0; i < tb.n; i++) { const q = [0, 1, 2].map(a => tb.pos[3 * i + a] - O[a]), l = q[0] * R.n[0] + q[1] * R.n[1] + q[2] * R.n[2];
      rmax = Math.max(rmax, Math.hypot(q[0] - l * R.n[0], q[1] - l * R.n[1], q[2] - l * R.n[2])); if (Math.abs(l - tb.l[i]) > 0.02) sorted = false; if (i && tb.l[i] < tb.l[i - 1]) sorted = false; if (tb.nOVI[i] > -15.9) ion++; }
    check(tb.n === data.tube.n && rmax <= hdr.radius_kpc + 0.05 && sorted && ion > tb.n / 2, `story-tube/1 (real, ${tb.n} cells): within ${rmax.toFixed(2)} <= ${hdr.radius_kpc} kpc of the ray, l = position along it, sorted; O VI byte on ${ion}`);
    /* story inputs + the yt kernel CDF */
    const inp = STG.storyInputs(data, {install: false});
    check(inp.cells.length === data.geometry.n_kernels && inp.cells.every((c, i) => !i || c.l >= inp.cells[i - 1].l) && inp.ray.o.every((x, a) => Math.abs(x - (R.p0[a] + R.half * R.n[a])) < 1e-9)
      && inp.cells.filter(c => Number.isFinite(c.v)).length === inp.cells.length, `storyInputs: ${inp.cells.length} cells in l order with v_los; ray origin at l = 0`);
    const kt = inp.kernelTable; let mono = true, ends = 0;
    for (let ib = 0; ib < rc.NB; ib++) { ends = Math.max(ends, Math.abs(kt[ib * rc.NT]), Math.abs(kt[ib * rc.NT + rc.NT - 1] - 1)); for (let it = 1; it < rc.NT; it++) if (kt[ib * rc.NT + it] < kt[ib * rc.NT + it - 1] - 1e-7) mono = false; }
    const ref = rc.kernelTable(); let dk = 0; for (let i = 0; i < ref.length; i++) dk = Math.max(dk, Math.abs(ref[i] - kt[i]));
    check(mono && ends < 1e-6, "kernel CDF (yt, story-data/2): rows monotone, 0 at entry, 1 at exit");
    check(dk < 0.03, `kernel CDF: the yt table agrees with the cubic-spline fallback to ${dk.toFixed(4)} (same kernel family; the yt one is used)`);
    const K = data.geometry.kernel_cdf; let dr = 0;
    for (const [qi, ui] of [[0, 0], [5, 17], [16, 32], [32, 64], [20, 50]]) { const q = K.q[qi], u = K.u[ui], fb = q * (rc.NB - 1), ft = (u + 1) / 2 * (rc.NT - 1);
      if (Number.isInteger(fb) && Number.isInteger(ft)) dr = Math.max(dr, Math.abs(kt[fb * rc.NT + ft] - K.table[qi][ui])); }
    check(dr < 1e-6, "kernel CDF: resampled table equals story-data/2 on shared grid nodes");
    /* shells: the real meshes decode inside their cubes; mesh-less clouds get an ellipsoid */
    const CD = join(SD, data.clouds.path.replace(/clouds\.json$/, "")), cj = JSON.parse(readFileSync(join(SD, data.clouds.path), "utf8"));
    let nMesh = 0, nEll = 0, bad = [];
    for (const I of Object.values(cj.ions)) for (const c of I.clouds) {
      if (c.mesh?.nv > 0) { const b = zlib.gunzipSync(readFileSync(join(CD, c.files.mesh.file))), m = SH.meshOf(c, b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength), {smooth: 0});
        const hi = c.cube.lo.map((x, a) => x + (c.cube.shape[a] - 1) * c.cube.dx); const nvw = m.verts.length / 3; let ok = nvw <= c.mesh.nv && nvw >= c.mesh.nv / 8 && m.faces.length <= 3 * c.mesh.nf && m.faces.length >= 0.9 * 3 * c.mesh.nf && Math.max(...m.faces) < nvw;
        for (let i = 0; i < nvw && ok; i++) for (let a = 0; a < 3; a++) if (m.verts[3 * i + a] < c.cube.lo[a] - 1e-3 || m.verts[3 * i + a] > hi[a] + 1e-3) ok = false;
        if (ok) nMesh++; else bad.push(c.id); }
      else { const e = SH.ellipsoid(c); const nv = e.verts.length / 3; let mx = [0, 0, 0]; for (let i = 0; i < nv; i++) for (let a = 0; a < 3; a++) mx[a] += e.verts[3 * i + a] / nv;
        if (Math.max(...e.faces) < nv && Math.hypot(...mx.map((x, a) => x - c.centre[a])) < 1e-3) nEll++; else bad.push(c.id); } }
    check(!bad.length && nMesh >= 6 && nEll >= 1, `shells: ${nMesh} CREST-3D meshes decode (welded) inside their cubes, ${nEll} mesh-less clouds as ellipsoids${bad.length ? " (bad: " + bad + ")" : ""}`);
    /* phase 1b (review2 beauty M3): Taubin smoothing keeps each closed mesh's volume and centroid, and moves no vertex by more
       than one cube voxel */
    { let worstV = 0, worstD = 0, worstC = 0, nS = 0;
      for (const I of Object.values(cj.ions)) for (const c of I.clouds) { if (!(c.mesh?.nv > 0)) continue;
        const b = zlib.gunzipSync(readFileSync(join(CD, c.files.mesh.file))), ab = b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength);
        const raw = SH.meshOf(c, ab, {smooth: 0}), sm = SH.meshOf(c, ab); nS++;
        const V0 = Math.abs(SH.meshVolume(raw.verts, raw.faces)), V1 = Math.abs(SH.meshVolume(sm.verts, sm.faces)); worstV = Math.max(worstV, Math.abs(V1 / V0 - 1));
        const n = raw.verts.length / 3, cen = v => [0, 1, 2].map(a => { let t = 0; for (let i = 0; i < n; i++) t += v[3 * i + a]; return t / n; });
        let d = 0; for (let i = 0; i < raw.verts.length; i += 3) d = Math.max(d, Math.hypot(sm.verts[i] - raw.verts[i], sm.verts[i + 1] - raw.verts[i + 1], sm.verts[i + 2] - raw.verts[i + 2]));
        worstD = Math.max(worstD, d / c.cube.dx); worstC = Math.max(worstC, Math.hypot(...cen(sm.verts).map((x, a) => x - cen(raw.verts)[a])) / c.cube.dx); }
      { const sq = SH.subdivide(new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1]), new Uint16Array([0, 2, 1, 0, 1, 3, 0, 3, 2, 1, 2, 3]));
        check(sq.faces.length === 48 && sq.verts.length === 30 && Math.abs(SH.meshVolume(sq.verts, sq.faces) - SH.meshVolume(new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1]), new Uint16Array([0, 2, 1, 0, 1, 3, 0, 3, 2, 1, 2, 3]))) < 1e-9,
          "shells: midpoint subdivision of a tetrahedron: 16 faces, 10 vertices (shared midpoints), same volume"); }
      check(nS > 0 && worstV < 0.06 && worstD < 1.0 && worstC < 0.1, `shells: Taubin smoothing on ${nS} meshes: volume within ${(100 * worstV).toFixed(1)} % (< 6 %), max vertex move ${worstD.toFixed(2)} voxel (< 1), centroid ${worstC.toFixed(3)} voxel (< 0.1)`); }
  } else console.log("skip: story-data/2 not found");
  /* governor rungs (S0.md §2) */
  { const g = G.createGovernor({ladder: G.RUNGS, start: G.rungIndex(G.RUNGS, 0.5)});
    check(g.state().rung === "0.5" && G.rungIndex(G.RUNGS, "0.5h") === 1 && G.rungIndex(G.RUNGS, 0.75) === 4, "governor rungs: 0.35h, 0.5h, 0.5, 0.6, 0.75; start 0.5 at full rate");
    for (let i = 0; i < 5; i++) g.push(40); check(g.state().rung === "0.5h" && g.state().half && g.state().g5b, "governor rungs: the first drop from 0.5 is 0.5h (half-rate volume; still passes G5b)");
    for (let i = 0; i < 5; i++) g.push(40); check(g.state().rung === "0.35h" && !g.state().g5b, "governor rungs: the floor is 0.35h (fails G5b)");
    for (let i = 0; i < 120; i++) g.push(5); check(g.state().rung === "0.5", "governor rungs: fast frames climb back through 0.5h to 0.5"); }
  /* stage constants */
  check(STG.QUALITY.stop.spv === 0.5 && STG.QUALITY.stop.exact === 1 && STG.QUALITY.stop.shade && STG.STILL_MS === 200, "stop quality: exact + shading at 0.5 steps/voxel (amortised), only after 200 ms still");
  /* band ceiling */
  { let mono = true, mx = 0, prev = -1; for (let L = 0; L <= 4; L += 0.001) { const y = PO.ceilLum(L); if (y < prev - 1e-12) mono = false; prev = y; mx = Math.max(mx, y); }
    check(mono && mx < 0.28 && PO.ceilLum(0.1) === 0.1 && PO.ceilLum(0.14) === 0.14, "band ceiling: monotone, below 0.28 for any input, identity below 0.14"); }
  /* speed */
  { const sp = tfs.blendTF("speed"); const L = sp.lut, c0 = rc.velColor(0, L, sp.uniforms.uWin), c1 = rc.velColor(-96, L, sp.uniforms.uWin), c2 = rc.velColor(96, L, sp.uniforms.uWin);
    const sat = c => Math.max(...c) - Math.min(...c);
    check(sp.uniforms.uVelRest[0] === 0.15 && sp.uniforms.uVelRest[1] === 70 && sp.uniforms.uVolGain <= 1.3 && sp.uniforms.uKnee[1] <= 0.8, "speed: gas at rest dimmed to 15 % (full at |V| >= 70 km/s), gain 1.3, knee top 0.8 (review2 beauty H2)");
  { const h = tfs.blendTF("ion:HI"), d = tfs.blendTF("density"), m = tfs.blendTF("density", "halo", 0.5), ph = tfs.blendTF("phases", "density", 0.25);
    check(h.uniforms.uKnee[1] <= 0.8 && d.uniforms.uVelRest[0] === 1 && JSON.stringify(tfs.blendTF("phases").uniforms.uKnee) === "[0.6,1]"
      && ph.uniforms.uKnee[1] === 1 && JSON.stringify(m.uniforms.uKnee) === "[0.6,0.95]" && m.id === "density>halo", "tf knee: ion:HI capped at 0.8 (B10 blob), phases unchanged (0.6..1), a cross-field fade keeps the outgoing knee, same-field blends lerp it, rest-dim off outside speed"); }
  check(sp.uniforms.uWin[0] === -150 && sp.uniforms.uWin[1] === 150 && sat(c1) > 2 * sat(c0) && sat(c2) > 2 * sat(c0) && c1[2] > c1[0] && c2[0] > c2[2], "speed: ±150 km/s window; the story's ±96 km/s components are clearly blue / red, v = 0 grey"); }
}

/* ---- browser ---- */
if (process.env.TNG_BROWSER) {
  const {launch} = await imp(join(HERE, "lib/browser.mjs"));
  const A = Object.fromEntries(process.argv.slice(2).reduce((acc, x, i, all) => (x.startsWith("--") ? acc.concat([[x.slice(2), all[i + 1]]]) : acc), []));
  const page = `<!doctype html><meta charset="utf-8"><style>html,body{margin:0;background:#000}canvas{width:128px;height:96px;display:block}</style><canvas id="c"></canvas>
<script type="importmap">{"imports":{"three":"https://cdn.jsdelivr.net/npm/three@0.169.0/build/three.module.min.js"}}</script>
<script type="module">
import * as T from "three";
const ST = "/tng50/learn/how-a-spectrum-is-made/js/stage/";
const [{createStage, QUALITY}, tfs, {probeGL}] = await Promise.all([import(ST + "stage.js"), import(ST + "tfstory.js"), import(ST + "glcheck.js")]);
window.__gl = probeGL({});
QUALITY.stop.spv = 4;
tfs.PRESETS["test:slab"] = {field: "nH", weight: null, lut: null, look: {volK: 1, gain: 1, opacity: 1}, fog: [0, 0],
  state: () => ({twoD: false, shade: 0, emis: "", gamma: 1, win: [-6, 0.4], gmax: 0.5, ramp: null, bands: [{c: -3, w: 40, a: 0.0035, rgb: [0, 0, 0]}]})};
const ray = {o: [0, 0, 0], n: [1, 0, 0], half: 380};
const cells = [{centre: [100, 0, 0], h: 2, d: 0, l: 100, s_in: 98, s_out: 102, logT: 4.3, tauO: 1e3}];   /* tauO: full glow strength (U_fix1 F6 scales glow by log tau0; a cell without it draws at 0.35) */
const st = await createStage({canvas: document.getElementById("c"), T, manifest: null, ray, cells, tube: null, opts: {dpr: 1, scale: 1, governor: false, bloom: false, noEma: true}});
const n = 128, vox = 800 / n, slab = new Uint8Array(n ** 3), i0 = 16, i1 = 47;      // x voxels 16..47: centres -296.9 .. -96.9 kpc
for (let z = 0; z < n; z++) for (let y = 0; y < n; y++) for (let x = i0; x <= i1; x++) slab[(z * n + y) * n + x] = 200;
const fs = {l: 110, cam: {pos: [-370, 0, 0], target: [100, 0, 0], up: [0, 0, 1], fov: 20, near: 0.05}, capsule: {l0: 60, l1: 140, r: 20, edge: 0.3}, quality: "stop",
  tf: {from: "test:slab", to: "test:slab", mix: 0}, probe: false, reduced: true};
const g = st.renderer.getContext();
function centre() { const w = g.drawingBufferWidth, h = g.drawingBufferHeight, px = new Uint8Array(4 * 9); let s = 0; g.readPixels((w >> 1) - 1, (h >> 1) - 1, 3, 3, g.RGBA, g.UNSIGNED_BYTE, px); for (let i = 0; i < 9; i++) s += px[4 * i + 2]; return s / 9; }
const p1 = st.core.setSynthetic("nH", "L0", new Uint8Array(n ** 3), {vmin: -6, vmax: 0.4});
for (let k = 0; k < 12; k++) st.core.pump(); await p1;
for (let k = 0; k < 2; k++) st.render(fs);
const clear = centre();
st.core.entries.delete("nH|L0"); const p2 = st.core.setSynthetic("nH", "L0", slab, {vmin: -6, vmax: 0.4}); for (let k = 0; k < 12; k++) st.core.pump(); await p2;
const acc = []; for (let k = 0; k < 6; k++) { st.render(fs); acc.push(centre()); }
const fogged = acc.reduce((a, b) => a + b, 0) / acc.length;
/* expected: alpha from the TF texel the slab value falls on; kappa = volK opacity^2 = 1; L_eff = (i1 - i0 + 2) voxels (exact samples, the
   interpolated edge voxels stay inside the window) minus the two q < 1 slivers */
const tf = tfs.blendTF("test:slab"), lv = -6 + 199 * 6.4 / 254, x = (lv + 6) / 6.4, ai = Math.round(x * 255), alpha = tf.bytes[4 * ai + 3] / 255;
const L = (i1 - i0 + 2) * vox - 2 * vox / 200, expect = Math.exp(-alpha * L);
window.__res = {clear, fogged, ratio: fogged / clear, expect, alpha, L};
</script>`;
  const TYPES = {".js": "text/javascript", ".mjs": "text/javascript", ".json": "application/json"};
  const srv = createServer((req, res) => { const u = decodeURIComponent(req.url.split("?")[0]);
    if (u === "/") { res.writeHead(200, {"Content-Type": "text/html"}); res.end(page); return; }
    const f = u.startsWith("/tng50/") ? join(ROOT, "docs/tng50", u.slice(7)) : null;
    if (!f || !f.startsWith(join(ROOT, "docs/tng50")) || !existsSync(f)) { res.writeHead(404); res.end(); return; }
    res.writeHead(200, {"Content-Type": TYPES[extname(f)] || "application/octet-stream"}); res.end(readFileSync(f)); });
  await new Promise(r => srv.listen(0, "127.0.0.1", r));
  const P = await launch({width: 400, height: 300, edge: A.edge});
  await P.goto(`http://127.0.0.1:${srv.address().port}/`);
  const t = await P.waitFor("window.__res", 240000, 250), r = t >= 0 ? await P.eval("window.__res") : null, gl = await P.eval("window.__gl").catch(() => null);
  if (P.exceptions.length) console.log("page exceptions:", P.exceptions.slice(0, 3));
  check(!!r && r.clear > 40, `browser: the ray cell is visible without fog (blue ${r?.clear?.toFixed(1)})`);
  check(!!r && Math.abs(r.ratio / r.expect - 1) <= 0.05, `browser: behind the fog slab it dims by exp(-tau): ${r?.ratio?.toFixed(4)} vs ${r?.expect?.toFixed(4)} (tau ${(r?.alpha * r?.L)?.toFixed(3)})`);
  if (gl) check(gl.software ? gl.tier === "stills" : gl.tier === "3d", `browser: GL probe "${gl.renderer}" -> ${gl.tier}${gl.reason ? ` (${gl.reason})` : ""}`);
  try { P.proc.kill("SIGKILL"); } catch { /* gone */ } srv.close();
}
console.log(fails ? `${fails} FAILED` : "all passed"); process.exit(fails ? 1 : 0);
