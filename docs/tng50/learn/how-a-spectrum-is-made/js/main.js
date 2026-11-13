// The v2 story page: wires every unit into one pinned, scroll-driven 3D experience (integrator, DESIGN_final §5.11, §6 step 4).
//
// One frame = seek(p) (U_motion, pure) -> the 3D stage (U_stage) with U_motion's lens shift onto the world band -> the
// equations overlay sizes (U_eq) -> the spectrum dock (U_spec; it registers its labels and connector corridors) -> the shell's
// solver, kinetic type, HUD, rail and plaque (U_shell) -> the equations placed where the solver put them. The clock (exact
// critically damped spring) chases the input target (wheel, touch, keys, hold-to-fly, Watch); nothing here moves p itself.
//
// Query: g, ray (or the explorer's #g=&ray=&ion=&R=&sn=&t=|beat= fragment, U_entry's parseEntry), viz (cube manifest dir or
// URL; default the explorer's manifest + hosted cubes), three (local three.module.min.js; read by index.html's head script),
// force3d (3D even on a software renderer), lite (CPU smoke: mobile tier, small volume), bench (G5b JSON on window.__bench),
// nogate (no B0 gate; tests and deep links).
//
// window.__story (U_motion's frozen keys + integrator extras): seek, state(), rects(), beats(), setTarget(p, jump), quality(),
// version, clock(), stage, perf(), gpuBytes(), sizeTable(), overrides(), ready.
import {createClock} from "./core/clock.js";
import {bindInput} from "./core/input.js";
import {createTimeline} from "./core/timeline.js";
import {makeSeek, prepare, exposeStory} from "./core/seek.js";
import {viewFor, keepWeight, keepPts, KEEP_MARGIN_PX, threeViewOffset, project as projectCam} from "./core/shots.js";
import {createBus} from "./core/bus.js";
import {createPrefetcher} from "./core/prefetch.js";
import {createWatchDriver, createTicker} from "./drivers/play.js";
import {createStoryExplore} from "./drivers/explore.js";
import {createShell, beatSkip, anchorL, beamCorridor, activeText} from "./ui/hud.js";
import {createSound} from "./ui/sound.js";
import {focusStyle} from "./ui/kinetic.js";
import {computeBands, layoutClass, isPhone} from "./ui/layoutclass.js";
import {createGate, parseEntry, entryFragment} from "./ui/gate.js";
import {copyLookup, copyFlags} from "./copy/derive.js";
import {loadStoryData} from "./engine.js";
import {cellCentre} from "./spectrum/link.js";

const Q = new URLSearchParams(location.search);
const $ = id => document.getElementById(id);
const html = document.documentElement;
const mark = n => { try { performance.mark(n); } catch (e) { /* old browser */ } };
const getJSON = async u => { const r = await fetch(u); if (!r.ok) throw new Error(`${u}: HTTP ${r.status}`); return r.json(); };
const gunzip = async r => new Response(r.body.pipeThrough(new DecompressionStream("gzip"))).arrayBuffer();
const getBin = async u => { const r = await fetch(u); if (!r.ok) throw new Error(`${u}: HTTP ${r.status}`); return u.endsWith(".gz") ? gunzip(r) : r.arrayBuffer(); };
const SUP = "⁰¹²³⁴⁵⁶⁷⁸⁹";
const fmtE = x => { if (!(x > 0)) return null; const e = Math.floor(Math.log10(x)), m = x / 10 ** e;
  return `${m.toFixed(1)}×10${(e < 0 ? "⁻" : "") + String(Math.abs(e)).replace(/\d/g, d => SUP[d])}`; };
/* plain plaque numbers (review M3 beauty): 287 000 -> "287 000" (3 significant figures, the equations' rule, so a cell
   shown in the plaque and in E2 reads the same: review2 science L1); above a million "1.62 million"; share f -> "1 in 4" */
const grp = n => String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, " ");
const groupSig3 = x => { if (!(x > 0)) return "0"; if (x >= 1e6) return `${(x / 1e6).toPrecision(3).replace(/\.?0+$/, "")} million`;
  const p = 10 ** Math.max(0, Math.floor(Math.log10(x)) - 2); return grp(Math.round(x / p) * p); };
const oneIn = f => { if (!(f > 0)) return "none of the"; const n = 1 / f, p = 10 ** Math.floor(Math.log10(n)); return `1 in ${grp(Math.round(n / p) * p)}`; };
const SOFTWARE_RE = /swiftshader|llvmpipe|softpipe|basic render|software rasterizer|software adapter|lavapipe/i;

/* the film page (render.html) imports this module only to look for createScene; never boot there */
const isFilm = !!document.querySelector("[data-composition-id]");
export const ready = isFilm ? Promise.resolve(null) : boot().catch(fail);

function fail(err) {
  console.error("story: boot failed", err);
  window.__storyError = String((err && err.stack) || err);
  const d = $("stage-desc");
  if (d) { d.classList.remove("vh"); Object.assign(d.style, {position: "absolute", inset: "auto 24px 24px", maxWidth: "40em", color: "#b9b6c8", font: "400 15px/1.5 var(--sans)", zIndex: 60}); }
  return null;
}

async function boot() {
  const t0 = performance.now();
  const entry = parseEntry(location);
  const reducedMQ = matchMedia("(prefers-reduced-motion: reduce)");
  let reduced = reducedMQ.matches;

  /* ---------------- documents and story data ---------------- */
  // everything the first live frame needs, fetched in parallel (G6: first live frame <= 1.5 s at 20 Mbps); the 3D stage
  // attaches after that frame (first 3D frame <= 4 s at 50 Mbps)
  const EQP = import("./eq/equations.js"), DOCKP = import("./spectrum/dock.js"), GLP = import("./stage/glcheck.js");
  const docsP = Promise.all([getJSON("copy.json"), getJSON("beats.json"), getJSON("shots.json"), getJSON("data/index.json")]);
  const dataP = loadStoryData(document.baseURI, entry.g, entry.ray);   // engine.resolveStory: unknown/ineligible -> the default story
  const EQM = await EQP;
  const [[copy, beatsDoc, shotsDoc, index], {data}, eq] = await Promise.all([docsP, dataP, EQM.loadEq()]);
  if (!data.meta || data.meta.schema !== "story-data/2") throw new Error("story data is not story-data/2: " + (data.meta && data.meta.schema));
  const G = data.geometry;
  // CREST shells (B11 tethers, B13 landing, the stage's isosurfaces): not needed for the first frame
  const cloudsP = !data.clouds_full && data.clouds && data.clouds.path
    ? getJSON("data/" + data.clouds.path).then(c => { data.clouds_full = c; return c; }, e => { console.warn("story: no clouds", e); return null; }) : Promise.resolve(data.clouds_full || null);
  const lookup = copyLookup(copy, data), flags = {...copyFlags(copy, data), ...(data.flags || {})};
  const beats = beatsDoc.beats;
  const seek = makeSeek({beats: beatsDoc, shots: shotsDoc});
  const prep = prepare(data, beatsDoc, shotsDoc);
  const timeline = createTimeline(beatsDoc, {shots: shotsDoc});
  const lineSkip = beatSkip(flags);
  timeline.setSkip && timeline.setSkip(lineSkip);
  const bus = createBus();
  let stage = null, input = null, watch = null, ticker = null, gate = null, scrims = null;
  let stillGeo = null;                                      // poster beam pixels on the stills tier (review M1)
  let stillsNoted = false;                                  // the fallback note is shown once (fix3 perf_a11y M6)
  let lastKey = "", lastChange = 0, eqDbg = null;
  let lastFs = null, solved = null, first3d = false, firstLive = false, hashT = 0, lastHash = "";
  const explore = createStoryExplore({bus});
  if (entry.ion) explore.set("ion", entry.ion);
  if (entry.R != null) explore.set("R", entry.R);
  if (entry.sn != null) explore.set("sn", entry.sn);
  // overrides from the dials (R, S/N) and the equations (T125, T263, N492) go through the clamped explore layer
  bus.on("override", o => { if (o && o.key && o.value !== undefined) explore.set(o.key, o.value); ticker && ticker.kick(); });
  // review perf H1: every input jump (keys, wheel, swipe, rail) kicks a frame. In reduced motion setTarget lands p at once, so the
  // ticker would see an idle clock and never redraw the stage, rail, chip or live region.
  for (const ev of ["brush", "hover", "jump", "input"]) bus.on(ev, () => kick());
  // review2 beauty H3: reading detent. Any input re-arms it; see readableNear() in frame()
  // armed only by free scrolling (wheel / touch / drag "input" events and the end of a hold); discrete jumps already land on
  // reading points (timeline.readPoint), and scripted setTarget calls (harnesses, film) never arm it
  let lastInputT = performance.now(), detentArmed = false;
  bus.on("input", e => { lastInputT = performance.now(); detentArmed = !!(e && (e.kind === "wheel" || e.kind === "drag")); });
  bus.on("hold", h => { lastInputT = performance.now(); detentArmed = !(h && h.on); });
  for (const ev of ["jump", "look", "orbit"]) bus.on(ev, () => { lastInputT = performance.now(); detentArmed = false; });
  /* fix3 R1: grab the camera. A mouse/pen drag (or a touch drag in Look mode) orbits the camera about its look target: yaw
     about the camera's up axis, pitch about its right axis, applied after seek (seek stays pure; the offset is view state,
     not story state). On release the offset springs back to the story's pose (~0.35 s), unless Look is on (G / the grab
     button), which holds it until Look is turned off. Reduced motion: no spring, the pose snaps back on release. */
  const orb = {yaw: 0, pitch: 0, held: false, t: performance.now()};
  const ORB_DEG_PX = 0.3, ORB_YAW = 150, ORB_PITCH = 70, ORB_TAU = 0.35;
  bus.on("orbit", e => { if (!e) return;
    if (e.phase === "start") orb.held = true;
    else if (e.phase === "move") { orb.yaw = Math.max(-ORB_YAW, Math.min(ORB_YAW, orb.yaw - e.dx * ORB_DEG_PX)); orb.pitch = Math.max(-ORB_PITCH, Math.min(ORB_PITCH, orb.pitch + e.dy * ORB_DEG_PX)); }
    else if (e.phase === "end") { orb.held = false; if (reduced && !(input && input.look)) { orb.yaw = 0; orb.pitch = 0; } }
    orb.t = performance.now(); kick(); });
  bus.on("look", e => { if (!(e && e.on) && reduced) { orb.yaw = 0; orb.pitch = 0; } kick(); });
  /* fix3 R2: the spectrum-to-3D link both ways. A dock brush (speed range), a dock hover (one cell) or an equation-term hover
     lights the matching cells on the beam (raycells "lit"); a tap on a ray cell pins the plaque to it (and lights it) until
     a tap on empty space or the beat changes. Brush -> cells: the dock's τ caches (tausum.cellsAtBin), cells holding >= 5 %
     of τ in the range at the probe's position. */
  const lit = {brush: null, hover: null, pin: null, pinBeat: null};
  bus.on("brush", b => { lit.brush = b && b.ion && Number.isFinite(b.v0) && Number.isFinite(b.v1) ? b : null; kick(); });
  bus.on("hover", h => { lit.hover = h && Number.isFinite(h.cellIdx) ? h.cellIdx : null; kick(); });
  bus.on("tap", e => {
    if (!stage || tier !== "3d" || !lastFs || !(lastFs.beat.kind === "flight" || lastFs.beat.kind === "stop")) return;
    const r = $("stage").getBoundingClientRect(), idx = stage.pick(e.x - r.left, e.y - r.top);
    lit.pin = idx >= 0 && idx !== lit.pin ? idx : null; lit.pinBeat = lit.pin != null ? lastFs.beat.id : null;
    say(lit.pin != null ? "Cell pinned." : "Cell unpinned."); kick(); });
  function litFor(fs) {
    const out = new Set();
    if (lit.pin != null && lit.pinBeat !== fs.beat.id) { lit.pin = null; lit.pinBeat = null; }
    if (lit.pin != null) out.add(lit.pin);
    if (lit.hover != null) out.add(lit.hover);
    const b = lit.brush, S = b && spectrum && spectrum.tau && spectrum.tau[b.ion];
    if (S && S.cellsAtBin) { const g0 = S.grid0 ?? -400;
      try { for (const c of S.cellsAtBin(fs.l, Math.round(b.v0 - g0), Math.round(b.v1 - g0), 0.05).slice(0, 32)) out.add(c.idx); } catch (e) { /* caches not built yet */ } }
    return out;
  }
  function orbitCam(cam) {
    const now = performance.now(), dt = Math.min(1, Math.max(0, (now - orb.t) / 1000)); orb.t = now;   // time-based (slow frames still settle)
    if (!orb.held && !(input && input.look) && (orb.yaw || orb.pitch)) {
      const k = Math.exp(-dt / ORB_TAU); orb.yaw *= k; orb.pitch *= k;
      if (Math.abs(orb.yaw) < 0.02 && Math.abs(orb.pitch) < 0.02) { orb.yaw = 0; orb.pitch = 0; }
    }
    if (!cam || !cam.pos || !cam.target || (!orb.yaw && !orb.pitch)) return cam;
    const sub = (a, b) => a.map((x, i) => x - b[i]), nrm = a => { const l = Math.hypot(...a) || 1; return a.map(x => x / l); };
    const crs = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]], dt3 = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
    const rot = (v, k, deg) => { const t = deg * Math.PI / 180, c = Math.cos(t), s = Math.sin(t), kv = crs(k, v), kd = dt3(k, v);
      return v.map((x, i) => x * c + kv[i] * s + k[i] * kd * (1 - c)); };
    const up0 = nrm(cam.up || [0, 0, 1]), off0 = sub(cam.pos, cam.target), right = nrm(crs(nrm(off0.map(x => -x)), up0));
    let off = rot(off0, up0, orb.yaw), up = up0;
    const right2 = rot(right, up0, orb.yaw);
    off = rot(off, right2, orb.pitch); up = rot(up, right2, orb.pitch);
    return {...cam, pos: cam.target.map((x, i) => x + off[i]), up, orbit: {yaw: orb.yaw, pitch: orb.pitch}};
  }

  const beatOf = id => beats.find(b => b.id === id);
  const deep = entry.t != null ? entry.t : entry.beat && beatOf(entry.beat) ? beatOf(entry.beat).p0 + 1e-4 : null;
  const p0 = deep != null ? deep : 0;
  const clock = createClock({p: p0, reduced});

  /* ---------------- 3D tier (U_stage glcheck: software GL lands on stills unless ?force3d / ?lite) ---------------- */
  const lite = Q.get("lite") === "1";
  const {probeGL} = await GLP;
  const gl = probeGL({force3d: Q.has("force3d") || lite});
  let tier = gl.tier === "3d" ? "3d" : "stills";
  html.classList.toggle("stills", tier !== "3d");

  /* ---------------- shell ---------------- */
  const els = {root: $("stage"), hud: $("hud"), rail: $("rail"), kinetic: $("kinetic"), labels: $("labels"), sheets: $("sheets"),
    menuButton: $("menu-btn"), menuSheet: $("menu-sheet"), narrativeList: $("narrative"), live: $("live"), textOverlay: $("text-overlay"),
    canvas: $("gl"), actChip: $("act-chip"), phasePill: $("phase-pill"), hint: $("hint"), soundButton: $("sound-btn")};
  // optional music (off by default, loaded on first use; js/ui/sound.js): the HUD pill, the gate toggle and the M key
  const music = createSound({copy});
  music.bind(els.soundButton);
  const clouds = (prep.clouds || []).filter(c => c.letter).map(c => ({l_in: c.l_in, l_out: c.l_out, phase: String(c.id).startsWith("HI") ? "cold" : "warm", label: "Cloud " + c.letter}));
  const lToP = l => { for (const b of beats) { if (b.l0 == null || b.l1 == null) continue; if (l >= Math.min(b.l0, b.l1) && l <= Math.max(b.l0, b.l1)) return b.p0 + (b.p1 - b.p0) * (l - b.l0) / ((b.l1 - b.l0) || 1); } return null; };
  const explorerHref = () => {
    const fs = lastFs, ov = explore.overrides;
    return "../../index.html#" + entryFragment({g: data.meta.galaxy, ray: data.meta.ray, R: ov.R ?? (fs && fs.spec.R), sn: ov.sn ?? (fs && fs.spec.sn)});
  };
  let trailOn = false;
  const hooks = {
    music: () => music.toggle(),
    setTarget: p => clock.setTarget(p),
    jump: p => (input ? input.jumpTo(p, "rail") : clock.setTarget(p)),
    flyStart: () => input && input.holdStart("fly"),
    flyEnd: () => input && input.holdEnd("fly"),
    flyToggle: () => { if (!input) return; if (clock.state.rate) input.holdEnd("fly"); else input.holdStart("fly"); },
    replay: () => { const p1 = (beats[1] || beats[0]).p0; clock.jump(p1); clock.setTarget(p1); kick(); },   // review SC-7 end action
    watch: () => watch && watch.toggle(),
    watchToggle: () => watch && watch.toggle(),
    watchHint: () => (watch ? Math.round(watch.remaining()) : null),
    watchRemaining: () => (watch ? watch.remaining() : null),
    explore: () => { const b = beats[beats.length - 1]; input ? input.jumpTo(b.p0 + 1e-4, "beat") : clock.setTarget(b.p0); },
    pick: s => { location.href = `index.html#${entryFragment({g: s.galaxy, ray: s.ray})}`; location.reload(); },
    physics: () => { const on = !html.classList.contains("physics"); html.classList.toggle("physics", on); try { localStorage.setItem("story.physics", on ? "1" : "0"); } catch (e) { /* none */ } kick(); },
    share: () => { const u = location.href.split("#")[0] + "#" + entryFragment({g: data.meta.galaxy, ray: data.meta.ray, t: clock.state.p});
      if (navigator.clipboard) navigator.clipboard.writeText(u).catch(() => {}); say("Link copied."); },
    explorerHref,
    tf: () => { const order = ["density", "halo", "phases", "ion:HI", "ion:OVI", "metals", "speed"], cur = explore.overrides.tf;
      const i = cur ? order.indexOf(cur) : -1; explore.set("tf", i + 1 >= order.length ? null : order[i + 1]); },
    focusR: () => focusDial("R"), focusSN: () => focusDial("sn"),
    trail: () => { trailOn = !trailOn; html.classList.toggle("trail", trailOn); kick(); },
    grab: () => input && input.setLook(true), release: () => input && input.setLook(false),
    setScrims: rs => { scrims = rs; if (stage) stage.setScrims(rs); },
    onLayout: () => kick(), onFonts: () => kick(), kick: () => kick(),
  };
  const shell = createShell(els, {beats, copy, data, lookup, flags, honesty: (copy.honesty && copy.honesty.items) || copy.honesty || [], index,
    current: {galaxy: data.meta.galaxy, ray: data.meta.ray}, clouds, lToP, hooks, follow: !Q.has("nofollow")});   // ?nofollow: A/B for the SC2-1 jump gate
  // review perf M3: the "Read the story as text" skip link opens the text overlay (the bare hash did nothing visible)
  { const sk = $("skip-text"); if (sk) sk.addEventListener("click", e => { e.preventDefault(); shell.narrative.open(); }); }
  const say = t => { const l = $("live"); if (l) { l.textContent = ""; setTimeout(() => { l.textContent = t; }, 30); } };
  const focusDial = k => { const e = document.querySelector(`#dock [data-dial="${k}"], #dock [data-key="${k}"]`); if (e) e.focus(); };

  /* ---------------- equations overlay and spectrum dock ---------------- */
  const overlay = EQM.createOverlay({eq, data, fion: data.fion, bus, root: $("labels")});
  const S = await DOCKP;
  let worker = null;
  try { worker = new Worker(new URL("./spectrum/tauworker.js", import.meta.url), {type: "module"}); } catch (e) { worker = null; }
  const spectrum = S.createSpectrum({parent: $("dock"), data, bus, dials: true, worker});
  const specReady = spectrum.ready().catch(e => { console.warn("story: tau worker failed, building on the main thread", e); worker = null; return null; });

  /* ---------------- stage (attached after the first live frame) ---------------- */
  let prefetch = null, benchStarted = false;
  async function attachStage() {
    try {
      const [T, ST, {loadManifestV2}] = await Promise.all([import("three"), import("./stage/stage.js"), import("../../../js/vizdata.js")]);
      const inp = ST.storyInputs(data), viz = vizConfig(index);
      const [tube, manifest] = await Promise.all([
        ST.loadStoryTube(data, getJSON, getBin, "data/").catch(e => { console.warn("story: no tube", e); return null; }),
        loadManifestV2(viz.manifest).catch(e => { console.warn("story: no cube manifest", e); return null; })]);
      // review perf H2/H3: phones and ?lite get the mobile tier's GPU budget (192 MB), L0-only prefetch and no velocity cubes
      const mobile = lite || isPhone(shell.layout().cls);
      const st = await ST.createStage({canvas: $("gl"), T, manifest, base: viz.base, fallbackBase: viz.fallback, ray: inp.ray, cells: inp.cells, tube,
        opts: {scale: lite ? 0.35 : 0.5, governor: !lite && !Q.has("bench"), dpr: Math.min(2, devicePixelRatio || 1), mobile, onQueued: () => kick()}});
      // review perf H3: a lost WebGL context drops to the stills tier instead of leaving a black stage
      $("gl").addEventListener("webglcontextlost", e => { e.preventDefault(); console.warn("story: WebGL context lost, using stills");
        stage = null; prefetch = null; tier = "stills"; html.classList.add("stills"); showStill(data); kick(); }, {once: true});
      if (scrims) st.setScrims(scrims);
      html.classList.toggle("software-gl", SOFTWARE_RE.test(st.stats.renderer || ""));
      if (data.clouds && data.clouds.path) {
        const cdir = "data/" + data.clouds.path.replace(/[^/]*$/, "");
        cloudsP.then(cj => cj && st.loadShells(cj, f => getBin(cdir + f))).then(() => kick(), e => console.warn("story: shells", e));
      }
      if (st.core) prefetch = createPrefetcher({beats, load: (n, L) => (mobile && (L !== "L0" || n === "vel") ? null : st.core.request(n, L, 1))});
      stage = st; if (window.__story) window.__story.stage = st;
      kick();
      // review perf H2: ?bench=1 used to test `stage` before this async attach had set it, so the bench never ran
      if (Q.has("bench") && !benchStarted) { benchStarted = true; (async () => { if (manifest) { try { await st.ready(["nH", "T"], ["L0"]); } catch (e) { /* bench runs anyway */ } }
        await runBench(window.__story || {}); })().catch(e => { window.__bench = {error: String(e)}; }); }
      if (manifest) {
        // pool sized by tier (review perf H3): mobile 6 R8 L0 slots (~101 MB at n=256, inside 192 MB), desktop 10 R8 + 2 RGBA (~302 MB)
        try { await st.core.prewarm({r8: mobile ? 6 : 10, rgba: mobile ? 0 : 2, yieldFn: () => new Promise(r => requestAnimationFrame(r))}); } catch (e) { /* pool optional */ }
        try { await st.ready(["nH", "T"], ["L0"]); } catch (e) { console.warn("story: L0 not resident", e); }
      }
      kick();
    } catch (e) { console.warn("story: 3D unavailable, using stills", e); stage = null; tier = "stills"; html.classList.add("stills"); showStill(data); kick(); }
  }
  if (tier !== "3d") showStill(data);

  /* ---------------- input, Watch, gate ---------------- */
  input = bindInput({stage: $("stage"), clock, timeline, bus, onKey: e => shell.onKey(e), isReduced: () => reduced});
  watch = createWatchDriver({clock, timeline, bus, onState: () => kick(), onEnd: () => kick()});
  reducedMQ.addEventListener && reducedMQ.addEventListener("change", e => { reduced = e.matches; clock.setReduced(reduced); html.classList.toggle("reduced", reduced); kick(); });
  const B0 = beats[0], B1 = beats[1] || B0;
  // review2 scrolly F3: the gate's first gesture lands where B1's first line is fully readable, not on B1's empty start
  const B1read = timeline.readPoint ? timeline.readPoint(B1) : B1.p0;
  if (deep == null && !Q.has("nogate") && !Q.has("still")) {
    gate = createGate($("stage"), {copy, music, vars: {galaxy: data.meta.galaxy}, g: data.meta.galaxy, ray: data.meta.ray, watchSeconds: timeline.watch.total,
      onRide: ({holding} = {}) => { closeGate(); if (holding) { input.holdStart("gate"); const end = () => { input.holdEnd("gate"); removeEventListener("pointerup", end, true); removeEventListener("keyup", end, true); };
        addEventListener("pointerup", end, true); addEventListener("keyup", end, true); } else clock.setTarget(Math.max(clock.state.target, B1read)); },
      onWatch: () => { closeGate(); watch.play(clock.state.p); },
      onSkip: () => { closeGate(); clock.jump(B1read); kick(); },
      onText: () => shell.narrative.open()});
    gate.open(); html.classList.add("gate-open");
    // G10: the gate's numbers come from data (galaxy id) or the timeline (Watch length), not typed copy
    for (const e of gate.el.querySelectorAll(".sg-s, .sg-cr")) e.dataset.key = "galaxy";
    for (const e of gate.el.querySelectorAll(".sg-l")) e.dataset.num = "watch_total";
    // a scrollytelling first screen: scrolling or swiping down on the gate starts the flight (the gate is data-noscrub, so the
    // input layer never sees these); ctrl-wheel stays the browser's zoom
    const startFlight = () => { closeGate(); clock.setTarget(Math.max(clock.state.target, B1read)); };
    gate.el.addEventListener("wheel", e => { if (e.ctrlKey || e.metaKey || !(e.deltaY > 0)) return; e.preventDefault(); startFlight(); }, {passive: false});
    let ty = null;
    gate.el.addEventListener("touchstart", e => { ty = e.touches.length === 1 ? e.touches[0].clientY : null; }, {passive: true});
    gate.el.addEventListener("touchmove", e => { if (ty != null && e.touches.length === 1 && ty - e.touches[0].clientY > 30) { ty = null; startFlight(); } }, {passive: true});
  }
  /* fix3 beauty M6: the poster stays up until the first 3D frame with gas (first3d) on the live tier, so a reader who scrolls
     at once never sees beads on black; capped at GATE_WAIT_MS after the first close request (a slow cube fetch then shows
     the empty sky rather than freezing the page behind the poster) */
  const GATE_WAIT_MS = 4000; let gateAsk = 0;
  function closeGate() { if (!gate || !gate.isOpen()) return;
    if (tier === "3d" && stage !== undefined && !first3d) { const t = performance.now(); if (!gateAsk) { gateAsk = t; setTimeout(() => { closeGate(); }, GATE_WAIT_MS + 20); }
      if (t - gateAsk < GATE_WAIT_MS) { kick(); return; } }
    gateAsk = 0; gate.close(); html.classList.remove("gate-open"); kick(); }

  /* ---------------- the frame ---------------- */
  const insetsOf = () => { const cs = getComputedStyle($("stage")), n = v => parseFloat(cs.getPropertyValue(v)) || 0; return {top: n("--sat"), right: n("--sar"), bottom: n("--sab"), left: n("--sal")}; };
  const perfMs = {frame: [], vol: []};
  function frame() {
    const tf0 = performance.now();
    if (!shell.layout().bands) shell.resize();
    const L = shell.layout(), w = L.w, h = L.h, cls = L.cls, insets = insetsOf();
    const ov = {...explore.overrides, cls};
    // any input that takes the target past the cold open (keys, rail, Watch, __story.setTarget) closes the gate
    if (gate && gate.isOpen() && clock.state.target > B0.p1 + 1e-6) closeGate();
    const fs = seek(clock.state.p, data, ov);
    fs.cam = orbitCam(fs.cam);   // fix3 R1
    fs.lit = litFor(fs);         // fix3 R2
    if (orb.yaw || orb.pitch) kick();
    fs.reduced = reduced;
    if (tier !== "3d") fs.quality = "stills";
    else if (lite || isPhone(cls)) fs.quality = fs.quality === "stills" ? "stills" : "mobile";
    lastFs = fs;
    // U_motion's lens shift: the look target lands at the centre of the world band of the current (blended) layout
    const bandsFn = (sd, dk) => computeBands(cls, w, h, {textSide: sd, dock: dk, insets});
    const Pk = l => G.ray.p0.map((x, a) => x + (l + G.ray.half) * G.ray.n[a]);
    const kw = keepWeight(beats, fs.p, fs.l, G.ray.half);
    const keep = kw > 0 ? {pt: Pk(fs.l), pts: keepPts(fs, prep.cellPos), marginPx: KEEP_MARGIN_PX, rect: bandsFn(fs.cam.textSide || "left", fs.spec.dock || "strip").world, weight: kw} : null;
    const view = viewFor(fs.cam, w, h, bandsFn, {dock: fs.spec.dock, dockFrom: fs.spec.dockFrom, dockMix: fs.spec.dockMix, keep});
    const camV = {...fs.cam, fov: view.fov};
    const scr = pt => { const r = projectCam(fs.cam, view, pt); return r && r.ok ? {x: r.x, y: r.y} : null; };
    // beam corridor (G3: text never crosses the beam): the visible stretch around the probe
    const P = l => G.ray.p0.map((x, a) => x + (l + G.ray.half) * G.ray.n[a]);
    const corridors = [];
    const live3d = tier === "3d";
    // review2 ux H2: the whole drawn beam (-half..+half, clipped at the near plane, exact under perspective), not l-40..l+60
    if (live3d) { const c = beamCorridor(fs.cam, view, P, G.ray.half, 13); if (c) corridors.push(c); }
    else if (stillGeo) {
      // review M1 (ux): the stills tier shows one poster with the beam baked in; that drawn beam is the corridor (object-fit
      // cover mapping of the poster's p0/p1 pixels), and nothing is anchored to the moving 3D camera
      const [W0, H0] = stillGeo.size, k = Math.max(w / W0, h / H0), ox = (w - W0 * k) / 2, oy = (h - H0 * k) / 2;
      const m = q => [ox + q[0] * k, oy + q[1] * k];
      corridors.push({a: m(stillGeo.p0_px), b: m(stillGeo.p1_px), r: 14, id: "poster-beam"});
    }
    // equations: natural sizes and variants for the solver
    const bands = bandsFn(fs.cam.textSide || "left", fs.spec.dock || "strip");
    let eqItems = [];
    try { eqItems = overlay.equations(fs, {cls, live: null, beats, maxW: Math.floor(bands.eq ? bands.eq.w : bands.text ? bands.text.w : w)}) || []; } catch (e) { console.warn("story: equations", e); }
    // the dock draws first: the solver needs its registered children
    let dockKids = [];
    try {
      const dl = spectrum.render(fs, {w, h, dpr: Math.min(2, devicePixelRatio || 1), cls, insets, project: live3d ? pt => { const r = projectCam(fs.cam, view, pt); return {x: r.x, y: r.y, ok: r.ok}; } : null});
      // U_stage: the ray cells fade and cap their rings above the dock's top edge (viewport fraction, y down)
      if (stage && stage.setDockTop) stage.setDockTop(dl && dl.drawn && h > 0 ? dl.drawn.y / h : null);
      dockKids = spectrum.kids() || [];
      corridors.push(...(spectrum.corridors() || []));
    } catch (e) { console.warn("story: dock", e); }
    const probeS = scr(P(fs.l));
    // review2 three_d T5: the plaque hangs off the selected cell (where its ring is drawn) when the connector leaves from it
    const con = live3d ? (spectrum.connectors() || []).find(L => L.kind === "connector" && L.from === "cell") : null, cellS = con ? {x: con.a.x, y: con.a.y} : null;
    // review M1 (three_d): world tags = cloud letter chips (clouds within ±60 kpc of the probe, and every tethered cloud)
    const tags = [];
    if (tier === "3d" && prep.clouds) {
      const seen = new Set(), tagOf = (letter, pt, ion) => { if (!pt || seen.has(letter)) return; seen.add(letter);
        const label = "Cloud " + letter; tags.push({id: "chip:" + letter, anchor: pt, label, ion, size: {w: Math.ceil(label.length * 7.4) + 26, h: 26, font: 12}}); };
      for (const L of spectrum.connectors() || []) if (L.kind === "tether" && L.letter) tagOf(L.letter, L.a, L.ion);
      if (fs.beat.kind === "flight" || fs.beat.kind === "stop") for (const c of prep.clouds) {
        if (!c.letter) continue; const mid = (c.l_in + c.l_out) / 2; if (Math.abs(mid - fs.l) > 60) continue;
        const sc = scr(prep.frame.P(mid)); if (sc && sc.x >= 0 && sc.x <= w && sc.y >= 0 && sc.y <= h) tagOf(c.letter, sc, String(c.id).startsWith("HI") ? "HI" : "OVI");
      }
    }
    try {
      // review2 scrolly A5: an act title's depth = its ℓ (anchor kind "l": the ref itself) minus the camera's ℓ on the beam
      const depthOf = live3d && fs.cam && fs.cam.pos ? a => { if (!a) return NaN; const l = a.kind === "l" ? +a.ref : anchorL(a, prep, fs); if (l == null || !isFinite(l)) return NaN;
        const F = prep.frame, c = fs.cam.pos; return l - ((c[0] - F.mid[0]) * F.n[0] + (c[1] - F.mid[1]) * F.n[1] + (c[2] - F.mid[2]) * F.n[2]); } : null;
      solved = shell.render(fs, {project: live3d ? a => { const l = anchorL(a, prep, fs); return l == null ? null : scr(prep.frame.P(l)); } : null, depthOf,
        corridors, tags, plaque: live3d ? plaqueAt(fs, cellS || probeS, scr) : null, eqs: eqItems.map(it => ({id: it.id, size: grow(it.id, it.size, "value"), variants: (it.variants || [it.size]).map(v => grow(it.id, v, v.key))})), dockKids,
        reduced, watch: !!(watch && watch.playing), paused: false, travelled: Math.max(0, fs.l + G.ray.half), maxKpc: Math.round(2 * G.ray.half),
        grab: !!(input && input.look), speedCellsOnly: !!(stage && stage.stats && stage.stats.speedCellsOnly)});
    } catch (e) { console.warn("story: shell", e); }
    if (solved) {
      const placed = {};
      for (const it of eqItems) { const b = solved.byId["eq:" + it.id]; placed["eq:" + it.id] = b ? {x: b.x, y: b.y, variant: b.variant, hidden: false} : {hidden: true}; }
      try { overlay.render(fs, placed, {cls, live: null, beats}); } catch (e) { console.warn("story: equations render", e); }
      eqDbg = {items: eqItems.map(it => ({id: it.id, size: it.size, variants: it.variants})), placed};
      // guard (integration finding for U_eq): the box U_eq reports can trail what it draws (it re-measures only when its
      // content changes, and the drawn mode can be taller); record the real box per mode and re-solve if it outgrew the solver's
      for (const it of eqItems) {
        const el = document.querySelector(`#labels .eqbox[data-eq="${it.id}"]`), b = solved.byId["eq:" + it.id];
        if (!el || el.hidden || !b) continue;
        if (!("num" in el.dataset)) el.dataset.num = "";   // G10: every number in an equation is a bind.js value from story keys, or a TeX constant
        // review H3: record under the key of the variant the solver PLACED, and only when the element really draws that variant
        // (data-mode "short"/"chip" for those, any other mode for the natural box). Keying by data-mode alone let a box drawn
        // at full size while its mode still read "short" inflate the short variant until it never fit its band again.
        const vv = (it.variants || [it.size])[b.variant || 0] || it.size, vkey = (vv && vv.key) || "value", mode = el.dataset.mode || "value";
        const small = vkey === "chip" || vkey === "short";
        if (small ? mode !== vkey : mode === "chip" || mode === "short") { kick(); continue; }
        const k = it.id + "|" + vkey, o = eqSeen.get(k) || {w: 0, h: 0}, wN = Math.ceil(Math.max(el.offsetWidth, el.scrollWidth)), hN = Math.ceil(Math.max(el.offsetHeight, el.scrollHeight));
        // a measurement far above the variant's own size is a mode mismatch mid-switch, never a real growth: not recorded
        const sane = !vv || (wN <= 1.5 * vv.w + 16 && hN <= 1.5 * vv.h + 16);
        if (sane && (wN > o.w || hN > o.h)) eqSeen.set(k, {w: Math.max(o.w, wN), h: Math.max(o.h, hN)});
        if (sane && (wN > b.w + 1 || hN > b.h + 1)) kick();
      }
    }
    // the 3D stage last: it needs this frame's scrim rects (shell.render -> hooks.setScrims), not the previous frame's
    if (stage) {
      stage.cam.setViewOffset(...threeViewOffset(view));
      if (prefetch) prefetch.update(clock.state.p);
      const st = stage.render({...fs, cam: camV});
      // G6 "first 3D frame": the first stage frame that draws gas (a cube level bound), not the empty-sky warm-up frame
      if (!first3d) { const b = (stage.stats && stage.stats.fields && stage.stats.fields.bound) || {};
        if ([...(b.color || []), ...(b.weight || [])].length) { first3d = true; mark("story:first-3d"); if (gate) { gate.liveReady(); if (gateAsk) closeGate(); } } }
      perfMs.vol.push(st && st.jsMs || 0); if (perfMs.vol.length > 600) perfMs.vol.shift();
      if (st && st.upload && st.upload.pending) kick();   // sliced cube uploads continue while the clock rests
    }
    // keep drawing for 1.5 s after the last change: the stage's EMA / stop-quality refine (S0 §2: ~8 frames after 200 ms
    // still), kinetic fades, and the equation sizes U_eq measures with a ResizeObserver (one frame late) must reach the
    // solver; then stop (no idle load). Applies on every tier.
    { const key = fs.p + "|" + JSON.stringify(explore.overrides) + "|" + w + "x" + h + "|" + html.className;
      if (key !== lastKey) { lastKey = key; lastChange = performance.now(); }
      if (performance.now() - lastChange < 1500) kick(); }
    if (!firstLive) { firstLive = true; mark("story:first-live"); }
    // review perf M4: the spectrum's text alternative (dock.describe), written once the clock rests so Watch is not chatty
    if (clock.state.idle) { try { const dk = $("dock"), t = spectrum.describe(fs);
      if (dk && t && dk.dataset.desc !== t) { dk.dataset.desc = t; dk.setAttribute("aria-description", t);
        let d = $("dock-desc"); if (!d) { d = document.createElement("p"); d.id = "dock-desc"; d.className = "sr-only"; dk.prepend(d); dk.setAttribute("aria-describedby", "dock-desc"); }
        d.textContent = t; } } catch (e) { /* describe optional */ } }
    // URL: the position, once the clock rests (shareable, survives reload)
    // review2 beauty H3: a free wheel or swipe that comes to rest mid-fade (or between two captions) eases to the nearest p
    // inside the beat where a caption is fully readable, if one is within READ_SNAP p; once per gesture, never under reduced
    // motion, Watch, a hold or the gate
    if (detentArmed && clock.state.idle && !reduced && !(watch && watch.playing) && !(input && input.holding) && !gate?.isOpen?.()
        && performance.now() - lastInputT > 650) {
      detentArmed = false;
      const tgt = readableNear(fs); if (tgt != null && Math.abs(tgt - clock.state.p) > 1e-5) { clock.setTarget(tgt); kick(); }
    }
    if (clock.state.idle && performance.now() - hashT > 400 && !gate?.isOpen?.()) {
      hashT = performance.now();
      const frag = entryFragment({g: data.meta.galaxy, ray: data.meta.ray, ion: explore.overrides.ion, R: explore.overrides.R, sn: explore.overrides.sn, t: clock.state.p});
      if (frag !== lastHash) { lastHash = frag; try { history.replaceState(null, "", "#" + frag); } catch (e) { /* sandboxed */ } }
    }
    perfMs.frame.push(performance.now() - tf0); if (perfMs.frame.length > 600) perfMs.frame.shift();
  }
  // createTicker clears its dirty flag after onFrame returns, so a kick from inside a frame is deferred to a microtask
  let inFrame = false, kickQueued = false;
  function kick() {
    if (!ticker) return;
    if (!inFrame) { ticker.kick(); return; }
    if (!kickQueued) { kickQueued = true; queueMicrotask(() => { kickQueued = false; ticker.kick(); }); }
  }
  const eqSeen = new Map();
  const grow = (id, v, key) => { if (!v) return v; const o = eqSeen.get(id + "|" + (key || "value")); return o ? {...v, w: Math.max(v.w, o.w), h: Math.max(v.h, o.h)} : v; };

  /* the plaque floats beside the cell the probe is crossing (flight and stop beats only) */
  /* fix3 beauty M1: the detent reaches 0.018 p (just over half the widest gap between captions, 0.034 at B2.1 -> B3) and looks
     into the neighbouring beats too, so a free scroll that comes to rest anywhere eases to the nearest readable sentence
     instead of ghost text or an equation alone (5-6 of 12 evenly spaced rests had no sentence) */
  const READ_SNAP = 0.018;
  function readableNear(fs) {
    if (!beats[fs.beat.i]) return null;
    const vis = (fs.text || []).filter(t => t.band === "text" || t.band === "act").map(t => focusStyle(t.phase).opacity);
    if (vis.length && Math.max(...vis) >= 0.9) return null;
    const p = fs.p; let best = null;
    for (const b of [beats[fs.beat.i - 1], beats[fs.beat.i], beats[fs.beat.i + 1]]) {
      if (!b || !Array.isArray(b.text) || (b.cond && lineSkip(b))) continue;
      const w = b.p1 - b.p0;
      for (const t of b.text) {
        if (!(t.band === "text" || t.band === "act") || t.alt || (t.when && t.when !== "default") || (t.cond && t.cond !== b.cond && lineSkip({cond: t.cond}))) continue;   // fix3 SC3-3: shown cond lines count
        const a = b.p0 + w * t.u0, c = b.p0 + w * Math.min(1, t.u1), ins = Math.min(0.0015, 0.25 * Math.max(0, c - a));
        const q = Math.min(Math.max(p, a + ins), c - ins), d = Math.abs(q - p);
        if (d <= READ_SNAP && (best == null || d < Math.abs(best - p))) best = q;
      }
    }
    return best;
  }
  /* fix3 R6/H2: the plaque must not contradict the sentence on screen. (1) While an act title is up (band "act", opacity >
     0.5), the plaque waits: "A cool clump." opened over million-kelvin cells the probe was still crossing. (2) While an
     equation bound to a fixed cell is shown (B5 E2 on cell 125, cloud A's core; B10 E3 on cell 492; B7b on 263), the plaque
     shows that cell and hangs off it, so the numbers it quotes are the ones the copy and the equation describe. (3) A
     clicked cell (lit.pin) wins over both. -> {fs for plaqueFor, cell idx or null} */
  function plaqueSubject(fs) {
    if (lit.pin != null) return lit.pin;
    let best = null, bo = 0.5;
    for (const e of fs.eqs || []) { const a = e.anchor; if (!a || a.kind !== "cell" || !Number.isFinite(+a.ref)) continue;
      const o = focusStyle(e.phase ?? 0).opacity; if (o > bo) { bo = o; best = +a.ref; } }
    return best;
  }
  const actTitleUp = fs => activeText(fs.text || [], flags).some(t => t.band === "act" && focusStyle(t.phase).opacity > 0.5);
  function plaqueAt(fs, fallbackS, scr) {
    const subj = plaqueSubject(fs);
    if (subj == null) return actTitleUp(fs) ? null : plaqueFor(fs, fallbackS);
    const c = cellCentre(data, subj), at = c && scr(c);
    return plaqueFor({...fs, cell: {idx: subj, w: 0.5}}, at || fallbackS);
  }
  function plaqueFor(fs, probeS) {
    if (!probeS || !fs.cell || !copy.plaque || !(fs.beat.kind === "flight" || fs.beat.kind === "stop")) return null;
    if (fs.beat.kind !== "stop" && !(fs.cell.w > 0.02 && fs.cell.w < 0.98)) return null;
    const i = fs.cell.idx, ion = fs.spec.lead || "OVI", Ci = data.ions[ion] && data.ions[ion].cells; if (!Ci) return null;
    const Pc = copy.plaque.physics || {}, Lw = copy.plaque.lay || {}, ionName = ion === "OVI" ? "O VI" : "H I", el = ion === "OVI" ? "oxygen" : "hydrogen";
    const vals = {nH: fmtE(Ci.nH[i]), T: fmtE(Ci.T[i]), v: (Math.round(Ci.V[i]) < 0 ? "−" : Math.round(Ci.V[i]) > 0 ? "+" : "") + Math.abs(Math.round(Ci.V[i])), f: fmtE(Ci.f_ion[i]), element: el};
    if (Object.values(vals).some(x => x == null)) return null;
    const sub = s => String(s || "").replace(/\{\{\$cell\.(\w+)\}\}/g, (m, q) => vals[q] ?? m).replace(/\{\{\$ion\}\}/g, ionName);
    const phys = html.classList.contains("physics");
    const Pl = copy.plaque.plain;
    if (!phys && Pl) {
      // review M3 (beauty): two plain rows by default, grouped digits, no exponents; symbols and powers of ten stay in Physics
      const T = Ci.T[i], V = Math.round(Ci.V[i]), f = Ci.f_ion[i];
      const pv = {...vals, Tw: groupSig3(T), va: String(Math.abs(V))};
      const subP = s => String(s || "").replace(/\{\{\$cell\.(\w+)\}\}/g, (m, q) => pv[q] ?? m).replace(/\{\{\$ion\}\}/g, ionName);
      pv.vw = subP(V > 0 ? Pl.v_away : V < 0 ? Pl.v_toward : Pl.v_rest);
      const fRow = f >= 0.75 ? Pl.f_most : f >= 0.4 ? Pl.f_half : Pl.f;
      pv.fw = oneIn(f);
      return {lines: [{k: "", key: "T", v: subP(Pl.tv)}, {k: "", key: "f", v: subP(fRow)}], anchor: probeS};
    }
    const lines = ["nH", "T", "v", "f"].map(k => { const s = sub(Pc[k] || k), j = s.indexOf(" = "), lay = sub(Lw[k]);
      return phys ? {k: j > 0 ? s.slice(0, j) : s, v: j > 0 ? s.slice(j + 3) : ""} : {k: j > 0 ? s.slice(0, j) : s, v: lay || (j > 0 ? s.slice(j + 3) : "")}; });
    return {lines, anchor: probeS};
  }

  /* no WebGL2 / software GL: the poster still behind the text and the live (2D) dock */
  function showStill(d) {
    const cv = $("gl"); if (cv) cv.hidden = true;
    const img = document.createElement("img"); img.alt = ""; img.className = "story-still"; img.setAttribute("aria-hidden", "true");
    const base = `img/poster_${d.meta.galaxy}_${d.meta.ray}`, portrait = innerHeight > innerWidth * 1.1;
    img.src = base + (portrait ? "_p.webp" : ".webp");
    img.onerror = () => { if (portrait && !img.dataset.fb) { img.dataset.fb = "1"; img.src = base + ".webp"; stillGeo = null; } else img.remove(); };
    // the sidecar gives the baked beam's pixels per orientation (review M1: registered as a corridor)
    fetch(base + ".json").then(r => (r.ok ? r.json() : null)).then(j => { const v = j && j.variants && j.variants[portrait && !img.dataset.fb ? "portrait" : "landscape"];
      if (v && v.size && v.p0_px && v.p1_px) { stillGeo = v; kick(); } }).catch(() => {});
    Object.assign(img.style, {position: "absolute", inset: "0", width: "100%", height: "100%", objectFit: "cover", opacity: "0.55", pointerEvents: "none"});
    $("stage").prepend(img);
    // review3 perf_a11y M6 (fix3): say why there is no 3D (copy.ui.no_webgl / software_gl). The note sits in the gate's own
    // flex column under the credit (so it cannot overlap anything) and goes to the live region; once, after the gate exists
    if (!stillsNoted) { stillsNoted = true; let tries = 0; const note = () => {
      if (!gate && ++tries < 6 && !Q.has("nogate") && !Q.has("still")) { setTimeout(note, 250); return; }   // the gate is built after the tier is chosen
      const ui = copy.ui || {}, txt = (gl && gl.webgl2 === false) || !gl ? ui.no_webgl : ui.software_gl || ui.no_webgl;
      if (!txt) return;
      html.dataset.stillsNote = (gl && gl.webgl2 === false) ? "no_webgl" : "software_gl";
      const col = gate && gate.el && gate.el.querySelector(".sg-cr");
      if (col && !gate.el.querySelector(".sg-note")) { const p = document.createElement("p"); p.className = "sg-cr sg-note"; p.dataset.g1 = "gate.note"; p.dataset.num = "ui." + html.dataset.stillsNote; p.textContent = txt; col.after(p); }
      setTimeout(() => say(txt), gate ? 1500 : 0);   // after the gate's own announcement, which would replace it
    }; setTimeout(note, 0); }
  }

  ticker = createTicker({clock, onFrame: () => { inFrame = true; try { frame(); } finally { inFrame = false; } }});
  // first live frame as soon as the documents are in (G6 <= 1.5 s at 20 Mbps): the dock fills in when its tau caches are built
  // (worker) and the solver re-runs when the faces load (shell onFonts); both just kick the ticker
  shell.resize();
  inFrame = true; try { frame(); } finally { inFrame = false; }
  ticker.start();
  specReady.then(() => kick());
  document.fonts.ready.then(() => { shell.resize(); kick(); });
  await Promise.race([specReady, new Promise(r => setTimeout(r, 4000))]);

  /* ---------------- window.__story ---------------- */
  const api = exposeStory(window, {
    seek: (p, d, o) => { const fs = seek(p, d, o); if (tier !== "3d") fs.quality = "stills"; return fs; },
    data: () => data, overrides: () => ({...explore.overrides, cls: shell.layout().cls}), clock: {get p() { return clock.state.p; }, jump: x => { clock.jump(x); kick(); }, setTarget: x => { clock.setTarget(x); kick(); }, get state() { return clock.state; }},
    timeline, rects: () => (gate && gate.isOpen() ? gate.rects() : shell.rects()),   // under the open gate the HUD is hidden (html.gate-open)
    quality: () => (stage ? {...stage.quality(), tier: tier, gpuBytes: stage.core && stage.core.gpuBytes ? stage.core.gpuBytes() : null} : {quality: "stills", tier: "stills", name: "stills"}),
  });
  Object.assign(api, {
    stage, ready: true, gl, tier,
    perf: () => ({stage, frameMs: perfMs.frame.slice(), jsMs: perfMs.vol.slice()}),
    gpuBytes: () => (stage && stage.core && stage.core.gpuBytes ? stage.core.gpuBytes() : null),
    sizeTable: deps => shell.sizeTable({seek, data, beats, shots: shotsDoc, overlay, ...(deps || {})}),
    overrides: () => explore.overrides, explore, bus, shell, spectrum, overlay, timeline, input, watch, gate,
    frame: () => { frame(); return lastFs; }, eqDebug: () => eqDbg,
    orbit: () => ({yaw: orb.yaw, pitch: orb.pitch, held: orb.held, look: !!(input && input.look)}), gateWaiting: () => !!gateAsk, first3d: () => first3d,
    bootMs: Math.round(performance.now() - t0),
  });
  // beats(): the dock as beats.json writes it (a state or a keyframe schedule [{u, state}]); U_qa's dockState reads both
  api.beats = () => timeline.beats.map(b => ({id: b.id, p0: b.p0, p1: b.p1, kind: b.kind, dock: b.dock,
    stop: b.stops && b.stops.n > 1 ? {n: b.stops.n} : null, ...(b.cond ? {cond: b.cond} : {})}));
  // a state() that reflects the page's tier (stills) for the a11y walk
  const st0 = api.state; api.state = () => { const s = st0(); if (tier !== "3d") s.quality = "stills"; return s; };
  if (tier === "3d") attachStage();
  if (Q.has("bench") && tier !== "3d") window.__bench = {error: "no WebGL2 3D tier; bench needs the live stage"};
  return api;
}

/* cubes: ?viz=<dir or manifest URL> (local server, tests, cluster) else the explorer's manifest and hosted cubes */
function vizConfig(index) {
  const q = Q.get("viz");
  if (q) {
    const u = new URL(q, location.href), man = /\.json$/.test(u.pathname) ? u.href : u.href.replace(/\/?$/, "/") + "manifest_v2.json";
    return {manifest: man, base: new URL(".", man).href, fallback: null};
  }
  const v = (index && index.viz) || {};
  return {manifest: new URL(v.manifest_url || "../../data/viz/manifest_v2.json", document.baseURI).href,
          base: v.base || "https://huggingface.co/datasets/tanmay-starslab/tng50-sub488530-viz/resolve/main/", fallback: v.fallback_base || null};
}

/* ?bench=1: G5b laptop bench (owner-run): a scripted flight B3..B11 at the governor's choice, JSON on window.__bench */
async function runBench(api) {
  const raf = () => new Promise(r => requestAnimationFrame(r));
  for (let i = 0; i < 120; i++) await raf();
  const st = api.stage; st.setGovernor && st.setGovernor(true);
  const dts = []; let last = 0; const N = 900;
  for (let i = 0; i < N; i++) { const t = await raf(); if (last) dts.push(t - last); last = t; api.clock().p; window.__story.setTarget(0.125 + (0.78 - 0.125) * i / (N - 1), true); }
  const s = [...dts].sort((a, b) => a - b), pct = q => +s[Math.min(s.length - 1, Math.floor(q * s.length))].toFixed(2);
  window.__bench = {done: true, renderer: st.stats.renderer, viewport: [innerWidth, innerHeight, devicePixelRatio], p50: pct(0.5), p95: pct(0.95), rung: st.quality().rung, scale: st.quality().scale};
}
