// The explainer's pinned 3D stage (explainer v2, U_stage; DESIGN_final §3.4 rendering, §5.2, §5.11 interfaces).
// One WebGL2 canvas. Per frame, in the disk frame of the galaxy (xhat, yhat, Lhat; kpc from the centre; = the explorer's
// cube mesh frame, so the volume mesh is the identity):
//   1. volcore.pump(): sliced cube uploads (never a long task)
//   2. far volume segment (capsule entry -> box exit)  -> farRT   half-res target, EMA (raymarch.js FRAG_STORY, uSeg 0)
//   3. near volume segment (camera -> capsule entry)   -> nearRT  same, uSeg 1
//   4. tube splats inside the travelling capsule       -> splatRT half-res, additive, cleared per frame
//   5. compose far + splats + background               -> sceneRT full res
//   6. ray cells (672 impostors), beam, probe, shells  -> sceneRT additive, full res
//   7. bloom from sceneRT; final: near over scene, bloom, vignette, grain, dither -> canvas
// Quality ladder (D13): flight = fast trilinear, 0.5 steps/voxel, no gradient; stop = exact samples, 1 step/voxel, the preset's
// shading; mobile = L0 only, 0.35 steps/voxel, <= 5k splats, no bloom. The governor picks the volume scale from frame times.
//
// createStage({canvas, T, manifest, base, ray: {o, n, half}, cells, tube, opts}) -> stage
//   stage.render(fs)       fs: FrameState (§5.11): uses l, cam, capsule, quality, tf, cell, shells
//   stage.pick(x, y)       CSS px -> ray-cell index or -1 (impostor cores only; tube splats are not pickable)
//   stage.project(p)       disk-frame point -> {x, y (CSS px), behind}
//   stage.quality()        {quality, scale, governor, fields}
//   stage.ready(fields)    resolves when L0 of every field is resident (L1 keeps streaming)
//   stage.setScrims(rects) text-band scrim rects from the layout solver (viewport fractions, y down); default: §3.3 desktop band
//   stage.setProfile(on)   sync timing per pass (readPixels after each pass) -> stage.stats.passMs; bench only
//   stage.resize(), stage.dispose(), stage.core (volcore), stage.renderer, stage.stats
//   stage.loadShells(cloudsJson, fetchBin)   CREST-3D shells (clouds3d/3) -> {meshes, ellipsoids, failed, compileMs}
// Phase 1b (S0.md §9, review2): createStage warms up before it resolves (opts.warm !== false): presets, compileAsync per scene,
//   one draw per path into 1x1 targets, then the full-size targets, one step per animation frame (stats.warm); bloom chain in
//   CSS px; per-preset knee and rest-dimmed speed preset (tfstory.js, raymarch.js STORY).
// Phase 1 (S0.md §2, §4; DESIGN §3.1, C_ux P0-3/P0-4):
//   - governor ladder 0.75 / 0.6 / 0.5 / 0.5h / 0.35h (h: far volume drawn every other frame, the rest at full rate);
//   - stop quality only after the camera has been still for 200 ms; amortised refine (exact samples at 0.5 steps/voxel, shading,
//     jittered, the EMA running mean converges in ~8 frames); any motion at a stop renders at flight quality;
//   - fs.tf.focusR: far-field emission beyond r from the probe fades to opts.focusDim (0.45) over r..2r (volume and splats);
//   - fs.cloud: the active cloud's tube cells brighten with fs.cloud.enter and its shell rim lifts;
//   - speed streaks from |dl/dt| (fs.streak overrides; 0 under fs.reduced or opts.streak === false);
//   - speed preset: ray cells take v_los colours; on the mobile tier the volume is not drawn for it (no velocity cubes), only
//     cells and splats (stats.speedCellsOnly, for the HUD chip);
//   - highlight ceiling under the text-band scrims (post.js uCeil, opts.ceil, default 0.28).
// storyInputs(data) -> {ray, cells, kernelTable}; loadStoryTube(data, getJSON, getBin) -> tube (story-data/2 + story-tube/1).
import {makeStoryMaterial} from "../../../../js/raymarch.js";
import {createVolCore} from "../../../../js/volcore.js";
import {blendTF, fieldsOf, PRESETS, presetBytes} from "./tfstory.js";
import {makeTube, decodeStoryTube} from "./tube.js";
import {makeRayCells, kernelTableFromCdf, setKernelTable} from "./raycells.js";
import {makeProbe} from "./probe.js";
import {makeShells} from "./shells.js";
import {makePost} from "./post.js";
import {createGovernor, RUNGS, rungOf, rungIndex, rungName} from "./governor.js";

export const QUALITY = {
  flight: {exact: 0, spv: 0.5, shade: false, levels: ["L0", "L1"], splats: Infinity, bloom: true},
  stop: {exact: 1, spv: 0.5, shade: true, levels: ["L0", "L1"], splats: Infinity, bloom: true},   /* amortised: half the samples, EMA-accumulated */
  mobile: {exact: 0, spv: 0.35, shade: false, levels: ["L0"], splats: 5000, bloom: false}};
export const BG = [4 / 255, 5 / 255, 10 / 255];
const now = () => performance.now();
export const STILL_MS = 200;                          // stop quality only after this long without camera motion (S0.md §2)

/* story-data/2 -> the stage's inputs: ray {o (l = 0), n, half, p0, frame}, the 672 cells in l order (centre, h, d, l, s_in, s_out,
   logT, v), and the yt kernel CDF resampled for raycells (also installed with setKernelTable) */
export function storyInputs(data, {install = true} = {}) {
  const G = data.geometry, r = G.ray, ray = {o: r.p0.map((x, a) => x + r.half * r.n[a]), n: r.n, half: r.half, p0: r.p0, frame: r.frame};
  const C = G.cells, OV = data.ions?.OVI?.cells || {}, HV = data.ions?.HI?.cells || {};
  const cells = C.idx.map((i, j) => ({i, idx: i, centre: [C.centre[3 * j], C.centre[3 * j + 1], C.centre[3 * j + 2]], h: C.h[j], d: C.d[j], l: C.lc[j],
    s_in: C.s_in[j], s_out: C.s_out[j], logT: OV.T ? Math.log10(OV.T[i]) : 4, v: OV.V ? OV.V[i] : NaN,
    tauO: OV.tau0 ? +OV.tau0[i] : NaN, tauH: HV.tau0 ? +HV.tau0[i] : NaN}));   /* review F6: glow weight per ion */
  const kernelTable = G.kernel_cdf ? kernelTableFromCdf(G.kernel_cdf) : null; if (install && kernelTable) setKernelTable(kernelTable);
  return {ray, cells, kernelTable};
}
/* tube (story-tube/1): getJSON(url), getBin(url) -> ArrayBuffer (gunzipped); paths relative to the story's data/ dir */
export async function loadStoryTube(data, getJSON, getBin, dir = "data/") {
  const hdr = await getJSON(dir + data.tube.path.replace(/\.bin\.gz$/, ".json")), buf = await getBin(dir + data.tube.path);
  return decodeStoryTube(buf, hdr, {...data.geometry.ray, p0: data.geometry.ray.p0});
}
const cloudIdx = id => { const m = /^(HI|OVI)_s(\d+)$/.exec(id || ""); return m ? {ion: m[1], k: +m[2] + 1} : null; };

/* review2 scrolly SC2-5: in the instrument beats (dock mode observed / fit / explore) the 3D picture answers the dials too:
   film grain grows with the per-pixel noise (~1/(S/N)) and the bloom (the picture's softness) with the blur width c/R.
   Pure; outside those beats the S0 look (grain 0.03, bloom k 0.6) is unchanged. */
export function instrumentLook(fs) {
  const sp = fs && fs.spec, m = sp && sp.mode;
  if (!(m === "observed" || m === "fit" || m === "explore")) return {grain: 0.03, k: 0.6};
  const sn = Number.isFinite(+sp.sn) && +sp.sn > 0 ? +sp.sn : null, R = Number.isFinite(+sp.R) && +sp.R > 0 ? +sp.R : null;
  const grain = sn ? Math.min(0.15, 0.03 + 0.5 / sn) : 0.03;
  const k = R ? 0.6 + 0.6 * Math.min(1, (299792.458 / R) / 40) : 0.6;
  return {grain, k};
}
export async function createStage({canvas, T, manifest, base = "", fallbackBase = null, ray, cells, tube, opts = {}}) {
  const dpr = Math.min(opts.dpr ?? globalThis.devicePixelRatio ?? 1, opts.maxDpr ?? 2);
  T.ColorManagement.enabled = false;
  const renderer = new T.WebGLRenderer({canvas, antialias: false, alpha: false, depth: false, stencil: false, powerPreference: "high-performance",
    preserveDrawingBuffer: !!opts.preserve});
  renderer.setPixelRatio(dpr); renderer.autoClear = false; renderer.outputColorSpace = T.LinearSRGBColorSpace;
  const gl = renderer.getContext();
  const half = T.HalfFloatType, rtType = renderer.extensions.has("EXT_color_buffer_float") || renderer.extensions.has("EXT_color_buffer_half_float") ? half : T.UnsignedByteType;
  const core = opts.core || createVolCore({T, renderer, manifest, base, fallbackBase, cache: opts.cache !== false, budgetBytes: opts.gpuBudget ?? (opts.mobile ? 192e6 : 448e6),
    slices: opts.slices ?? 16, budgetMs: opts.uploadMs ?? 4, diag: !!opts.diag, fence: !!opts.fence,
    onQueued: () => { if (typeof opts.onQueued === "function") opts.onQueued(); }});
  /* ---- volume ---- */
  const RM = makeStoryMaterial(T, {n: manifest?.levels?.L0?.n || 256}), U = RM.uniforms;
  const H = L => core.levelHalf(L);
  U.uHalf.value.set(H("L0"), H("L1"), H("L2")); U.uMask0.value = manifest?.levels?.L0?.r_mask_kpc ?? 400;
  U.uBg.value.set(0, 0, 0); U.uMode.value = 1; U.uGasMix.value = 1; U.uStarMix.value = 0; U.uLodC.value.set(1.0, 0); U.uNear.value.set(0.35, 0.6);
  const volScene = new T.Scene(), volMesh = new T.Mesh(new T.BoxGeometry(2 * H("L0"), 2 * H("L0"), 2 * H("L0")), RM.material);
  volMesh.frustumCulled = false; volScene.add(volMesh);
  U.uRayO.value.fromArray(ray.o); U.uRayN.value.fromArray(ray.n);
  /* ---- near field and geometry ---- */
  const layers = opts.layers || {vol: true, splats: true, cells: true, beam: true};
  const tubeR = tube && layers.splats !== false ? makeTube(T, tube, {bead: opts.bead ?? 3}) : null, splatScene = new T.Scene(); if (tubeR) splatScene.add(tubeR.mesh);
  const rc = cells?.length && layers.cells !== false ? makeRayCells(T, cells) : null, probe = makeProbe(T, {rayO: ray.o, rayN: ray.n, half: ray.half}), shells = makeShells(T);
  const geoScene = new T.Scene(); if (rc) geoScene.add(rc.mesh); geoScene.add(shells.group, probe.group);
  const post = makePost(T);
  const cam = new T.PerspectiveCamera(50, 1, 0.05, 5000);
  const rt = (w, h, type = rtType) => new T.WebGLRenderTarget(Math.max(1, w), Math.max(1, h), {type, format: T.RGBAFormat, depthBuffer: false, stencilBuffer: false,
    minFilter: T.LinearFilter, magFilter: T.LinearFilter, generateMipmaps: false});
  let W = 1, Hh = 1, scale = opts.scale ?? 0.5, farRT = rt(1, 1), nearRT = rt(1, 1), splatRT = rt(1, 1), sceneRT = rt(1, 1);
  const ladder = opts.ladder || RUNGS;
  let halfRate = !!opts.half;
  const gov = createGovernor({ladder, start: Math.max(0, rungIndex(ladder, {scale, half: halfRate})), targetMs: opts.targetMs ?? 16.7});
  let lastT0 = 0, govOn = opts.governor !== false, accK = 0, lastCam = null, frame = 0, lastT = 0, tfKey = "", profile = false, lastMoveT = -1e9, lastQ = "", lastL = null, vEma = 0, farFresh = false;
  const stats = {frames: 0, passMs: {}, gpuMs: {}, jsMs: 0, frameMs: [], ema: 1, splats: 0, scale, renderer: "", fields: {}};
  try { const d = gl.getExtension("WEBGL_debug_renderer_info"); stats.renderer = d ? gl.getParameter(d.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER); } catch { /* keep */ }

  /* the volume and splat targets are sized in CSS px (§3.4 "0.5 CSS px target"): vs = scale / dpr of the drawing buffer, so a
     DPR 2 laptop pays the same volume cost as DPR 1 (S0_freeze: sizing by device px made it 4x) */
  const vsOf = () => scale / Math.max(1, renderer.getPixelRatio());
  /* bloom chain in CSS px too (S0.md §9: "bloom at half resolution as the first DPR >= 2 rung"); always on, since at DPR 2 a
     half-CSS-px bloom is what DPR 1 already draws (opts.bloomBase overrides) */
  const bloomBase = () => opts.bloomBase ?? 0.5 / Math.max(1, renderer.getPixelRatio());
  function alloc() {
    const vs = vsOf(), vw = Math.max(1, Math.round(W * vs)), vh = Math.max(1, Math.round(Hh * vs));
    for (const r of [farRT, nearRT, splatRT]) r.setSize(vw, vh);
    sceneRT.setSize(W, Hh); post.resize(W, Hh, rtType, bloomBase()); accK = 0; farFresh = false;
  }
  function resize() {
    const r = canvas.getBoundingClientRect(), cw = Math.max(1, Math.round(r.width)), ch = Math.max(1, Math.round(r.height));
    renderer.setSize(cw, ch, false); const v = new T.Vector2(); renderer.getDrawingBufferSize(v); W = v.x; Hh = v.y; alloc();
  }
  /* boot (S0.md §9): with the warm-up on, the targets stay 1x1 until every program is compiled and has drawn once; the full-size
     HDR targets (2880x1800 at DPR 2) are allocated in their own frame after that */
  if (opts.warm === false) resize(); else alloc();
  /* s: a number (full rate) or a rung {scale, half} */
  function setScale(s) { const r = rungOf(s); halfRate = r.half; stats.half = halfRate; if (Math.abs(r.scale - scale) < 1e-6) return; scale = r.scale; stats.scale = scale; alloc(); farFresh = false; }

  /* ---- GPU timer queries (optional, non-blocking): one query per pass, read 3 frames later ---- */
  const tq = gl.getExtension("EXT_disjoint_timer_query_webgl2"); const qPend = [];
  let qCur = null;
  const qBegin = name => { if (!tq || profile) return; const q = gl.createQuery(); gl.beginQuery(tq.TIME_ELAPSED_EXT, q); qCur = {name, q}; };
  const qEnd = () => { if (!qCur) return; gl.endQuery(tq.TIME_ELAPSED_EXT); qPend.push({...qCur, f: frame}); qCur = null; };
  function qPoll() {
    if (!tq) return; const dis = gl.getParameter(tq.GPU_DISJOINT_EXT);
    while (qPend.length && frame - qPend[0].f >= 2) { const p = qPend[0];
      if (!gl.getQueryParameter(p.q, gl.QUERY_RESULT_AVAILABLE)) break; qPend.shift();
      if (!dis) { const ms = gl.getQueryParameter(p.q, gl.QUERY_RESULT) / 1e6; (stats.gpuMs[p.name] ||= []).push(ms); if (stats.gpuMs[p.name].length > 600) stats.gpuMs[p.name].shift(); }
      gl.deleteQuery(p.q); }
  }
  /* ---- sync profiling: readPixels forces the pass to finish (bench only) ---- */
  const px = new Uint8Array(4), pxf = new Uint16Array(4);
  function sync(target) { if (target) { renderer.readRenderTargetPixels(target, 0, 0, 1, 1, target.texture.type === T.UnsignedByteType ? px : pxf); } else gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px); }
  let tP = 0; const mark = (name, target) => { if (!profile) return; sync(target); const t = now(); (stats.passMs[name] ||= []).push(t - tP); tP = t; };

  const tfTex = RM.tfTex, lutTex = RM.lutTex;
  function applyTF(tf) {
    const key = `${tf.id}|${tf.alphaScale}|${tf.bytes ? tf.bytes[3] + tf.bytes[777] + tf.bytes.length : 0}`;
    if (tf.bytes && (key !== tfKey || tf.id.includes(">"))) { tfTex.image.data.set(tf.bytes); tfTex.needsUpdate = true; }
    if (key !== tfKey) { lutTex.image.data.set(tf.lut); lutTex.needsUpdate = true; tfKey = key; }
    for (const [k, v] of Object.entries(tf.uniforms)) { if (!U[k]) continue; if (Array.isArray(v)) U[k].value.set(...v); else U[k].value = v; }
    U.uFog.value.set(...tf.fog);
  }
  const fieldsWanted = new Set();
  function want(tf, Q) {
    for (const f of [tf.vel ? "vel" : tf.colorField, tf.weightField].filter(Boolean)) {
      fieldsWanted.add(f); for (const L of Q.levels) core.request(f, L, L === "L0" ? 0 : 1);
    }
  }

  /* upto (warm-up only): stop after pass k (1 far, 2 near, 3 splats, 4 compose, 5 geometry, 6 bloom, 7 final), so each
     program's first draw (where ANGLE/Vulkan builds the pipeline and SwiftShader JITs) lands in its own animation frame */
  function render(fs, upto = 99) {
    const t0 = now(); tP = t0;
    if (lastT) { const dt = t0 - lastT; stats.frameMs.push(dt); if (stats.frameMs.length > 2000) stats.frameMs.shift(); if (govOn) setScale(gov.push(dt)); }
    lastT = t0; frame++; qPoll();
    /* camera motion first: it decides whether a stop may refine */
    const c = fs.cam, pose = [...c.pos, ...c.target], dist = Math.max(1, Math.hypot(c.pos[0] - c.target[0], c.pos[1] - c.target[1], c.pos[2] - c.target[2]));
    let m = 1; if (lastCam) m = Math.hypot(pose[0] - lastCam[0], pose[1] - lastCam[1], pose[2] - lastCam[2]) / dist + Math.hypot(pose[3] - lastCam[3], pose[4] - lastCam[4], pose[5] - lastCam[5]) / dist;
    const firstPose = !lastCam; lastCam = pose; if (m > 1e-5) lastMoveT = t0;
    const asked = fs.quality === "stills" ? "flight" : fs.quality || "flight";
    const still = fs.still === true || (t0 - lastMoveT >= (opts.stillMs ?? STILL_MS));
    const qn = asked === "stop" && !still ? "flight" : asked, Q = QUALITY[qn] || QUALITY.flight;
    stats.quality = qn; if (qn !== lastQ) { accK = 0; lastQ = qn; }
    const up = core.pump(); stats.upload = up;
    /* transfer function */
    const tf = blendTF(fs.tf?.from || "density", fs.tf?.to || fs.tf?.from || "density", fs.tf?.mix || 0, {darkSky: fs.tf?.darkSky !== false});
    /* mobile tier + speed: no velocity cubes; the cells and splats carry the colour (DESIGN_final §3.4, §7) */
    const cellsOnly = qn === "mobile" && tf.vel; stats.speedCellsOnly = cellsOnly;
    if (!cellsOnly && !warming) want(tf, Q);
    if (!warming && fs.tf?.to && fs.tf.to !== tf.id) for (const f of fieldsOf(fs.tf.to)) if (!(qn === "mobile" && f === "vel")) for (const L of Q.levels) core.request(f, L, 1);
    // review M5 (three_d): the beat's tf gain (beats.json tf keys, blended by seek) scales the volume emission
    if (Number.isFinite(fs.tf?.gain) && fs.tf.gain !== 1 && tf.uniforms) tf.uniforms = {...tf.uniforms, uVolGain: tf.uniforms.uVolGain * fs.tf.gain};
    applyTF(tf);
    const bound = core.bind(U, {color: tf.colorField, weight: tf.weightField, vel: tf.vel, empty1: RM.empty1, empty4: RM.empty4});
    if (!Q.levels.includes("L1")) { U.uGasHave.value.y = 0; U.uWHave.value.y = 0; U.uVelHave.value.y = 0; }
    U.uGasHave.value.z = 0; U.uWHave.value.z = 0; U.uVelHave.value.z = 0;          // the story ray never enters L2 (61.9 > 25 kpc)
    stats.fields = {color: tf.colorField || (tf.vel ? "vel" : null), weight: tf.weightField, bound};
    /* camera */
    cam.position.fromArray(c.pos); cam.up.fromArray(c.up || [0, 0, 1]); cam.fov = c.fov || 50; cam.aspect = W / Hh;
    cam.near = c.near || 0.05; cam.lookAt(new T.Vector3().fromArray(c.target)); cam.updateProjectionMatrix(); cam.updateMatrixWorld(true);
    // review2 three_d T2: dark-sky fog is in kpc from the camera; a pose standing far off the ray (B9's thread view, ~100 kpc)
    // fogged the gas it looks at to black. The window now starts behind the look target: shifted by (distance - 30 kpc).
    if (tf.fog && tf.fog[1] > 0) { const dT = Math.hypot(c.pos[0] - c.target[0], c.pos[1] - c.target[1], c.pos[2] - c.target[2]), sh = Math.max(0, dT - 30);
      U.uFog.value.set(tf.fog[0] + sh, tf.fog[1] + sh); }
    const focal = Hh / (2 * Math.tan(cam.fov * Math.PI / 360));
    U.uCamDisk.value.copy(cam.position); U.uPxAng.value = 2 * Math.tan(cam.fov * Math.PI / 360) / Math.max(1, Hh * vsOf());
    U.uExact.value = Q.exact; U.uSpv.value = Q.spv;
    if (!Q.shade) { U.uShade.value = 0; U.uTF2D.value = 0; }
    /* capsule */
    const cp = fs.capsule || {l0: 0, l1: 0, r: 0, edge: 0.3}; U.uCap.value.set(cp.l0, cp.l1, cp.r, cp.edge ?? 0.3);
    /* focus radius about the probe (fs.tf.focusR, kpc): far-field gain beyond r fades to focusDim over r..2r */
    const sL = fs.l ?? 0, probeP = ray.o.map((o, a) => o + sL * ray.n[a]), fR = fs.tf?.focusR > 0 && opts.focus !== false ? fs.tf.focusR : 0, fDim = opts.focusDim ?? 0.45;
    U.uFocus.value.set(probeP[0], probeP[1], probeP[2], fR); U.uFocusDim.value = fDim;
    /* EMA weight from the camera motion: still -> running mean (1/(k+1), floor 1/16); moving -> 0.35 .. 1 */
    if (m > 1e-5 || tf.id.includes(">") || up.uploadedSlices) accK = 0;
    const alpha = accK === 0 ? (m > 0.05 || firstPose ? 1 : Math.min(1, 0.35 + 6 * m)) : Math.max(1 / (accK + 1), 1 / 16);
    if (opts.noEma) accK = 0;
    const a = opts.noEma ? 1 : alpha; accK++; stats.ema = a;
    U.uFrame.value = frame; RM.material.blendAlpha = a;
    mark("setup");
    /* active cloud (fs.cloud {id, enter}) and speed streaks */
    const ci = cloudIdx(fs.cloud?.id), fk = Math.max(0, Math.min(1, fs.cloud?.enter ?? 0)) * (opts.cloudFocus ?? 1);
    const cloudFocus = ci ? {hi: ci.ion === "HI" ? ci.k : 0, ovi: ci.ion === "OVI" ? ci.k : 0, k: fk} : null;
    if (lastL !== null && lastT0 > 0) { const dt = Math.max(1e-3, (t0 - lastT0) / 1000), v = Math.abs(sL - lastL) / dt; vEma += (Math.min(v, 400) - vEma) * Math.min(1, dt * 6); }
    lastL = sL; lastT0 = t0;
    const streak = fs.reduced || opts.streak === false ? 0 : fs.streak ?? Math.max(0, Math.min(1, (vEma - (opts.streakV0 ?? 12)) / (opts.streakV1 ?? 60)));
    stats.streak = streak; stats.vKpcS = vEma;
    /* 2-3: volume segments */
    const volOn = layers.vol !== false && !cellsOnly;
    /* half-rate rung: the far segment is drawn on even frames only (held in farRT between them); never skipped while the target is stale */
    const skipFar = halfRate && volOn && farFresh && (frame & 1) === 1 && !opts.film; stats.farSkipped = skipFar;
    if (!skipFar) { qBegin("far"); U.uSeg.value = 0; renderer.setRenderTarget(farRT); if (a >= 1 || !volOn) renderer.clear(); if (volOn) renderer.render(volScene, cam); qEnd(); farFresh = true; }
    mark("far", farRT); if (upto <= 1) return stats;
    qBegin("near"); U.uSeg.value = 1; renderer.setRenderTarget(nearRT); if (a >= 1 || !volOn) renderer.clear(); if (volOn) renderer.render(volScene, cam); qEnd(); mark("near", nearRT); if (upto <= 2) return stats;
    /* 4: splats */
    qBegin("splats"); renderer.setRenderTarget(splatRT); renderer.setClearColor(0x000000, 0); renderer.clear();
    if (tubeR) { tubeR.mesh.material.uniforms.uMaxFrac.value = 0.25;
      tubeR.update({cap: cp, rayO: ray.o, rayN: ray.n, tf, tfTex, lutTex, camPos: c.pos, vh: Hh * vsOf(), focal: focal * vsOf(), near: opts.splatNear || [3.0, 8.0],
        focus: cloudFocus, focusSphere: fR > 0 ? {c: probeP, r: fR, dim: fDim} : null, streak});
      if (Q.splats < Infinity) tubeR.mesh.geometry.instanceCount = Math.min(tubeR.mesh.geometry.instanceCount, tubeR.window(cp.l0, cp.l1)[0] + Q.splats);
      stats.splats = tubeR.count(); renderer.render(splatScene, cam); }
    qEnd(); mark("splats", splatRT); if (upto <= 3) return stats;
    /* 5: compose */
    qBegin("compose"); post.compose(renderer, farRT, splatRT, sceneRT, opts.bg || BG); qEnd(); mark("compose", sceneRT); if (upto <= 4) return stats;
    /* 6: geometry */
    qBegin("geometry"); const s = fs.l ?? 0;
    rc?.update({s, sel: fs.cell?.idx ?? -1, lit: fs.lit && fs.lit.size ? fs.lit : null, dockY: dockTop == null ? -1 : 1 - 2 * dockTop, lead: fs.spec?.lead || "OVI", focal, vh: Hh, speed: tf.vel ? {lut: tf.lut, win: tf.uniforms.uWin || [-150, 150]} : null});
    probe.update({s, res: [W, Hh], dpr: renderer.getPixelRatio(), focal, visible: fs.probe !== false && layers.beam !== false});
    shells.update(fs.shells || [], {focus: fs.cloud?.id ?? null, focusK: fk, hiK: fs.tf ? (fs.tf.to === "ion:HI" ? fs.tf.mix : 0) + (fs.tf.from === "ion:HI" ? 1 - fs.tf.mix : 0) : 0, rayO: ray.o, rayN: ray.n, camPos: c.pos, focusSphere: fR > 0 ? {c: probeP, r: fR, dim: fDim} : null});
    renderer.setRenderTarget(sceneRT); renderer.render(geoScene, cam); qEnd(); mark("geometry", sceneRT); if (upto <= 5) return stats;
    /* 7: post */
    qBegin("bloom"); const bl = Q.bloom && opts.bloom !== false ? post.bloom(renderer, sceneRT) : null; qEnd(); mark("bloom", bl); if (upto <= 6) return stats;
    qBegin("final"); post.final(renderer, sceneRT, nearRT, bl, {bloom: !!bl, frame, w: W, h: Hh, grain: fs.reduced ? 0 : instrumentLook(fs).grain, k: instrumentLook(fs).k, scrims: scrimsFor(fs), shoulder: opts.shoulder ?? 0.6, ceil: opts.ceil ?? 0.28}); qEnd(); mark("final", null);
    stats.jsMs = now() - t0; stats.frames++;
    return stats;
  }

  /* S0: GL scrims under the text band (DESIGN_final §3.4). The layout solver (U_shell) may hand the real band rects via
     setScrims([{x0, y0, x1, y1, k}]) in viewport fractions (y down, like CSS); until then the desktop band of §3.3 on
     fs.cam.textSide (x 5-42 % or 58-95 %, y 9-64 %) is used. k = darkening at the core (0..1). fs.scrim === false disables. */
  let scrimRects = null, dockTop = null;             // dockTop: viewport fraction (y down) of the dock's top edge, from the shell
  const SCRIM_K = opts.scrimK ?? 0.75;                 // S0 freeze: 0.6 left B7a band p95 at 0.40 (GPU); 0.75 gives 0.18 (CPU, calibrated)
  function scrimsFor(fs) {
    if (fs.scrim === false || opts.scrim === false) return [];
    const rs = scrimRects || [fs.cam?.textSide === "right" ? {x0: 0.58, x1: 0.95, y0: 0.09, y1: 0.64, k: SCRIM_K} : {x0: 0.05, x1: 0.42, y0: 0.09, y1: 0.64, k: SCRIM_K}];
    return rs.slice(0, 2).map(r => ({x0: r.x0, x1: r.x1, y0: 1 - r.y1, y1: 1 - r.y0, k: r.k ?? SCRIM_K}));   // uv: y up
  }
  const v3 = new T.Vector3();
  function project(p) { v3.fromArray(p).project(cam); const r = canvas.getBoundingClientRect();
    return {x: (v3.x * 0.5 + 0.5) * r.width, y: (-v3.y * 0.5 + 0.5) * r.height, behind: v3.z > 1 || v3.z < -1}; }
  /* fix3 R2: screen-space pick (the impostor cores are a few px across, too small to hit): the cell whose projected centre is
     nearest to (x, y) CSS px (canvas-relative) within max(16 px, its drawn radius); nearer cells win ties. -> cell idx or -1 */
  function pick(x, y) { if (!rc || !cells || !cells.length) return -1; const r = canvas.getBoundingClientRect(); let best = -1, bd = Infinity;
    const fpx = r.height / (2 * Math.tan(cam.fov * Math.PI / 360));
    for (let i = 0; i < cells.length; i++) { const c = cells[i]; v3.fromArray(c.centre).project(cam); if (v3.z > 1 || v3.z < -1) continue;
      const sx = (v3.x * 0.5 + 0.5) * r.width, sy = (-v3.y * 0.5 + 0.5) * r.height, dist = cam.position.distanceTo(new T.Vector3().fromArray(c.centre));
      const rad = Math.max(16, Math.min(40, 0.35 * (c.h || 1) * fpx / Math.max(1e-3, dist))), d = Math.hypot(sx - x, sy - y);
      if (d <= rad && d + 0.01 * dist < bd) { bd = d + 0.01 * dist; best = c.idx ?? i; } }
    return best; }
  /* resolves when the levels are resident; pumps the sliced uploads itself (one batch per animation frame) while waiting */
  async function ready(fields, levels = ["L0"]) {
    let done = false, err = null; const all = Promise.all(fields.flatMap(f => levels.map(L => core.request(f, L, 0)))).then(() => { done = true; }, x => { err = x; done = true; });
    const tick = () => new Promise(r => (globalThis.requestAnimationFrame ? requestAnimationFrame(r) : setTimeout(r, 16)));
    while (!done) { core.pump(); await tick(); }
    await all; if (err) throw err; }
  function dispose() { core.dispose(); RM.material.dispose(); volMesh.geometry.dispose(); tubeR?.dispose(); rc?.dispose(); probe.dispose(); shells.dispose(); post.dispose();
    [farRT, nearRT, splatRT, sceneRT].forEach(r => r.dispose()); renderer.dispose(); }
  /* ---- boot warm-up (S0.md §9: 72-231 ms boot long tasks at vsync = synchronous compile/link and first use). Spread over
     animation frames: (1) the TF presets' byte tables, one per frame; (2) every program, one scene per frame, through
     renderer.compileAsync (KHR_parallel_shader_compile: the driver compiles off-thread and three polls COMPLETION_STATUS_KHR, so
     no main-thread wait); (3) one draw of the whole frame into the 1x1 targets (first use: uniform locations, the TF/LUT/kernel
     textures, the instance buffers); (4) the full-size targets in their own frame. stats.warm = {steps: [[name, ms]], ms}. ---- */
  /* rAF, or a 40 ms timer when rAF does not fire (hidden tab, the film's frame-stepped capture): the warm-up never hangs */
  const yieldF = opts.yieldFn || (() => new Promise(r => { let done = false; const go = () => { if (!done) { done = true; r(); } };
    if (globalThis.requestAnimationFrame) requestAnimationFrame(go); setTimeout(go, 40); }));
  let warming = false;                                  // warm-up draws request no fields (no velocity cubes at boot, none on mobile)
  async function warm() {
    warming = true; const t00 = now(), steps = [], step = (name, t) => steps.push([name, +(now() - t).toFixed(2)]);
    for (const id of Object.keys(PRESETS)) { const t = now(); presetBytes(id); step("tf:" + id, t); await yieldF(); }
    cam.position.set(ray.o[0] - 40 * ray.n[0], ray.o[1] - 40 * ray.n[1], ray.o[2] - 40 * ray.n[2] + 10); cam.lookAt(new T.Vector3(...ray.o)); cam.updateMatrixWorld(true);
    const scenes = [["volume", volScene], ["splats", splatScene], ["geometry", geoScene], ...post.scenes().map((sc, i) => ["post" + i, sc])];
    for (const [name, sc] of scenes) { const t = now(); if (renderer.compileAsync) await renderer.compileAsync(sc, cam); else renderer.compile(sc, cam); step("compile:" + name, t); await yieldF(); }
    const pW = [ray.o[0] - 40 * ray.n[0], ray.o[1] - 40 * ray.n[1], ray.o[2] - 40 * ray.n[2] + 10];
    const fsW = {l: 0, cam: {pos: pW, target: ray.o, up: [0, 0, 1], fov: 50}, capsule: {l0: -10, l1: 10, r: 20, edge: 0.3}, quality: "flight",
      tf: {from: "density", to: "density", mix: 0}, shells: [], probe: true, scrim: false, still: false};
    for (const [k, name] of ["far", "near", "splats", "compose", "geometry", "bloom", "final"].entries()) { const t = now(); render(fsW, k + 1); step("draw:" + name, t); await yieldF(); }
    { const t = now(); render({...fsW, tf: {from: "speed", to: "speed", mix: 0}}); step("draw:speed", t); await yieldF(); }
    { const t = now(); render({...fsW, quality: "stop", still: true, tf: {from: "phases", to: "phases", mix: 0}}); step("draw:stop", t); await yieldF(); }
    /* full-size targets: set the size, then allocate the GL storage in later frames (three allocates lazily at first bind) */
    { const t = now(); resize(); step("targets:size", t); await yieldF(); }
    { const t = now(); for (const r of [farRT, nearRT, splatRT, sceneRT]) renderer.initRenderTarget?.(r); step("targets:stage", t); await yieldF(); }
    { const t = now(); for (const r of post.targets()) renderer.initRenderTarget?.(r); step("targets:bloom", t); await yieldF(); }
    /* forget the warm-up frames: no governor sample, no EMA history, first real pose counts as a cut */
    warming = false; lastT = 0; lastT0 = 0; lastCam = null; lastL = null; vEma = 0; accK = 0; lastQ = ""; tfKey = ""; stats.frames = 0; stats.frameMs.length = 0; stats.passMs = {}; stats.gpuMs = {};
    stats.warm = {steps, ms: +(now() - t00).toFixed(1), parallel: !!renderer.extensions.get("KHR_parallel_shader_compile")};
  }
  /* shells arrive after the first frame: compile their program off-thread too before they can be drawn */
  async function loadShells(cj, fetchBin) {
    const out = await shells.load(cj, fetchBin);
    try { const t = now(); if (renderer.compileAsync) await renderer.compileAsync(shells.group, cam); out.compileMs = +(now() - t).toFixed(1); } catch (e) { /* drawn on first use */ }
    return out;
  }
  if (opts.warm !== false) await warm();
  return {render, project, pick, ready, resize, dispose, core, renderer, stats, cam, shells, rayCells: rc, tube: tubeR, uniforms: U,
    quality: () => ({quality: stats.quality || null, scale, half: halfRate, rung: rungName({scale, half: halfRate}), governor: gov.state(), fields: stats.fields, renderer: stats.renderer,
      speedCellsOnly: !!stats.speedCellsOnly}),
    loadShells,
    /* s: number (full rate), {scale, half} or a name like "0.5h" */
    setProfile(on) { profile = !!on; stats.passMs = {}; },
    setGovernor(on, s) { govOn = !!on; if (s != null) { const i = rungIndex(ladder, s), r = i >= 0 ? ladder[i] : (typeof s === "string" ? {scale: parseFloat(s), half: /h$/.test(s)} : s); setScale(r); if (i >= 0) gov.index = i; } },
    /* the dock's top edge (viewport fraction, y down; null = no dock): the selected-cell ring fades out below it (review2 beauty M1) */
    setDockTop(y) { dockTop = Number.isFinite(y) ? y : null; },
    setScrims(rs) { scrimRects = Array.isArray(rs) ? rs : null; },   // review SC-9: [] = no text, no scrim (null = never set: default band)
    setScale, get scale() { return scale; }, targets: () => ({farRT, nearRT, splatRT, sceneRT})};
}
