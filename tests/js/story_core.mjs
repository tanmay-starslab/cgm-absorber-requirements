// Story v2 motion core (DESIGN_final §5.3, unit U_motion): clock, input maps, time warp, timeline, shots, seek, prefetch.
// node tests/js/story_core.mjs   (no browser; run_all.mjs picks it up)
// Checks:
//   clock    exact critically damped spring: the same p(t) at 30/60/120/144 Hz to 1e-6 (targets, drag, hold ramp through
//            the settle point and the end), reduced motion p = target, Space-hold 10 s → p 0.12 ± 0.005 (G7, G8)
//   input    wheel (trackpad 300 px → 0.6-1.2 % p; notched ≈ 120 notches ± 20 % per story; line mode; ctrl-wheel and
//            horizontal swipes do nothing), touch drag (9 stage heights per story, axis lock 6 px), flick clamp,
//            gesture quantiser (150 ms gap, 1.6× rule), stop lookup (G7 maps; the DOM side is tests/js/story_input.mjs)
//   warp     monotone, invertible (u → ℓ → u to 1e-9), floor ratio 0.25, slower in clouds than in the quiet, never
//            reads overrides (P2-2)
//   timeline beats.json valid against beats.schema.json and validate() (contiguous, ℓ/tf/dock continuity, one kinetic
//            group per band with a ≥ 0.004 p gap), the B8/B9 boundary of DESIGN_final H3, stop sub-ticks, Watch 150 s,
//            reading budget (copy.json word counts when present; mouse-notch floor always), engine.locate agreement
//   shots    no NaN, unit up ⟂ view, continuity: camera offset from the probe moves ≤ 0.5 kpc + 0.3*|offset| per
//            0.001 p and up turns ≤ 5° per 1e-4 p, except declared cuts (shots.json cut: true)
//   G3       the projected beam never crosses a visible text or equation band: every G1 viewport × zoom (layout class
//            from js/ui/layoutclass.js) × 160 p; composition: the probe sits inside the world band in ≥ 75 % of
//            flight/stop frames per class
//   seek     pure (500 seeded random p twice, any order, identical JSON; no clock/random/DOM in the pure modules),
//            FrameState shape (DESIGN_final §5.11), overrides (R/S/N live from B12a, T263 text variants, ghosts, ion,
//            tf, cls → inset only on phones)
//   prefetch every field is requested ≥ lead before its beat on a monotone sweep

import fs from "node:fs";
import path from "node:path";
import {fileURLToPath, pathToFileURL} from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url)), REPO = path.resolve(HERE, "../..");
const ROOT = path.join(REPO, "docs/tng50/learn/how-a-spectrum-is-made");
const imp = p => import(pathToFileURL(path.join(ROOT, p)).href);
const J = p => JSON.parse(fs.readFileSync(path.join(ROOT, p), "utf8"));
const exists = p => fs.existsSync(path.join(ROOT, p));

const CL = await imp("js/core/clock.js"), IN = await imp("js/core/input.js"), TW = await imp("js/core/timewarp.js");
const TL = await imp("js/core/timeline.js"), SH = await imp("js/core/shots.js"), SK = await imp("js/core/seek.js");
const PF = await imp("js/core/prefetch.js"), BUS = await imp("js/core/bus.js"), E = await imp("js/engine.js");
const beats = J("beats.json"), shots = J("shots.json"), schema = J("beats.schema.json");
const DATA_FILE = "data/story_488530_rand_b062_a062.json";
const data = J(DATA_FILE);
const LC = exists("js/ui/layoutclass.js") ? await imp("js/ui/layoutclass.js") : null;

let fails = 0, n = 0;
const ok = (c, msg) => { n++; if (c) console.log("ok " + msg); else { fails++; console.log("FAIL " + msg); } };
const near = (a, b, tol, msg) => ok(Math.abs(a - b) <= tol, `${msg} (${+a.toFixed?.(8) || a} vs ${b}, tol ${tol})`);
const lcg = seed => () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296);

/* ================= clock ================= */
{
  // a scripted session: events at fixed times; stepping at 4 frame rates must agree to 1e-6
  const script = [[0.0, c => c.setTarget(0.2)], [0.35, c => c.setTarget(0.05, "drag")], [0.6, c => c.setMode("cruise")],
    [0.9, c => c.setRate(0.012)], [3.4, c => c.setRate(0)], [3.5, c => c.jump(0.96)], [3.6, c => c.setRate(0.012)],
    [9.0, c => c.setRate(0)], [9.2, c => c.setTarget(0.4)]];
  const run = hz => {
    const c = CL.createClock({}), dt = 1 / hz, out = []; let t = 0, k = 0;
    for (const T of [0.5, 1, 2, 3.45, 4, 6, 8, 9.1, 10, 12]) {
      while (t < T - 1e-12) {
        const nextEv = k < script.length ? script[k][0] : Infinity;
        const stepTo = Math.min(t + dt, T, nextEv);
        if (stepTo > t) c.step(stepTo - t);
        t = stepTo;
        while (k < script.length && script[k][0] <= t + 1e-12) { script[k][1](c); k++; }
      }
      out.push([c.state.p, c.state.v, c.target]);
    }
    return out;
  };
  const ref = run(60);
  for (const hz of [30, 120, 144]) {
    const r = run(hz); let worst = 0;
    r.forEach((x, i) => { worst = Math.max(worst, Math.abs(x[0] - ref[i][0]), Math.abs(x[2] - ref[i][2])); });
    ok(worst < 1e-6, `clock: p(t) at ${hz} Hz equals 60 Hz to 1e-6 (max |Δ| ${worst.toExponential(2)})`);
  }
  ok(ref.every(x => x[0] >= 0 && x[0] <= 1), "clock: p stays in [0, 1]");
  const c = CL.createClock({}); c.setRate(CL.CLOCK_TUNE.holdRate); for (let i = 0; i < 600; i++) c.step(1 / 60);
  near(c.p, 0.12, 0.005, "clock: Space held 10 s moves p by 0.12 ± 0.005 (G7)");
  near(c.target, 0.12, 1e-9, "clock: the hold ramp moves the target at exactly 0.012 p/s");
  const e = CL.createClock({p: 0.99}); e.setRate(0.012); e.step(5); ok(e.target === 1 && e.state.rate === 0, "clock: the hold ramp stops at p = 1");
  const s = CL.createClock({}); s.setTarget(0.98); ok(s.state.omega === CL.CLOCK_TUNE.omegaSettle, "clock: settle stiffness past B14 start");
  const rm = CL.createClock({reduced: true}); rm.setTarget(0.4); ok(rm.p === 0.4, "clock: reduced motion jumps p to the target");
  const sp = CL.createClock({}); sp.setTarget(1); let over = 0; for (let i = 0; i < 300; i++) { sp.step(1 / 60); over = Math.max(over, sp.p); }
  ok(over <= 1 && Math.abs(sp.p - 1) < 1e-4, "clock: critically damped from rest, no overshoot");
}

/* ================= input maps ================= */
{
  let p = 0; for (let i = 0; i < 30; i++) p += IN.wheelDelta({deltaY: 10, deltaMode: 0}, 900);
  ok(p >= 0.006 && p <= 0.012, `input: trackpad 300 px → ${(p * 100).toFixed(2)} % p (0.6-1.2 %)`);
  p = 0; for (let i = 0; i < 12; i++) p += IN.wheelDelta({deltaY: 25.5, deltaMode: 0}, 900);
  ok(p >= 0.006 && p <= 0.012, "input: fractional trackpad deltas keep the trackpad gain");
  for (const d of [100, 120]) {
    let q = 0, k = 0; while (q < 1 && k < 1000) { q += IN.wheelDelta({deltaY: d, deltaMode: 0, deltaX: 0}, 900); k++; }
    ok(k >= 96 && k <= 144, `input: notched mouse at ${d} px/notch crosses the story in ${k} notches (120 ± 20 %)`);
  }
  let q = 0, k = 0; while (q < 1 && k < 1000) { q += IN.wheelDelta({deltaY: 3, deltaMode: 1}, 900); k++; }
  ok(k >= 96 && k <= 144, `input: line-mode mouse (3 lines/notch) crosses the story in ${k} notches`);
  ok(!IN.isNotched({deltaY: 100, deltaMode: 0, wheelDeltaY: -300}), "input: a 100 px trackpad event with the ×3 wheelDelta tell is not a notch");
  ok(IN.wheelDelta({deltaY: 100, deltaMode: 0, ctrlKey: true}, 900) === 0, "input: ctrl-wheel never scrubs (browser zoom)");
  ok(IN.wheelDelta({deltaY: 5, deltaX: 40, deltaMode: 0}, 900) === 0, "input: a mostly horizontal swipe does not scrub");
  ok(Math.abs(IN.wheelDelta({deltaY: 9000, deltaMode: 0}, 900)) <= IN.INPUT_TUNE.wheelMax, "input: per-event clamp ±0.012");
  ok(Math.abs(IN.wheelDelta({deltaY: 1, deltaMode: 2}, 900) - IN.INPUT_TUNE.wheelMax) < 1e-12, "input: page mode is clamped");
  near(9 * 844 * -1 / 844 / 9 * -1, 1, 1e-12, "input: arithmetic guard");
  near(IN.dragDelta(-844 * 9, 844), 1, 1e-12, "input: 9 stage heights of upward drag = the whole story");
  ok(IN.dragDelta(100, 844) < 0, "input: finger down moves back");
  ok(IN.flickDelta(10) === IN.INPUT_TUNE.flickMax && IN.flickDelta(-10) === -IN.INPUT_TUNE.flickMax, "input: flick clamp ±0.03");
  near(IN.flickDelta(0.5), 0.02, 1e-12, "input: flick = 0.04 v");
  ok(IN.axisOf(3, 4) === null && IN.axisOf(1, 7) === "y" && IN.axisOf(8, 2) === "x", "input: axis lock at 6 px");
  const Q = IN.createQuantiser();
  ok(Q.accept(0, 100) && !Q.accept(50, 90) && !Q.accept(120, 60) && Q.accept(300, 40) && Q.accept(320, 100),
    "input: quantiser = one jump per gesture (150 ms gap; > 1.6× magnitude starts a new push)");
  const st = [0, 0.1, 0.25, 1];
  ok(IN.nextStop(st, 0.1, 1) === 0.25 && IN.nextStop(st, 0.1, -1) === 0 && IN.nextStop(st, 1, 1) === 1 && IN.nextStop(st, 0, -1) === 0,
    "input: next / previous stop lookup clamps at the ends");
}

/* ================= timeline ================= */
const tl = TL.createTimeline(beats, {schema, shots});
{
  const errs = tl.validate();
  ok(errs.length === 0, `timeline: beats.json valid and consistent${errs.length ? "\n   " + errs.join("\n   ") : ""}`);
  const B8 = tl.byId("B8"), B9 = tl.byId("B9");
  ok(B8.p0 === 0.545 && B8.p1 === 0.580 && B8.l1 === 30 && B9.p0 === 0.580 && B9.l0 === 30 && B9.l1 === 81,
    "timeline: B8/B9 boundary at ℓ = +30 kpc, p 0.580 (DESIGN_final H3)");
  ok(tl.beats.every(b => !(b.text || []).some(t => /ncross/.test(JSON.stringify(t)))), "timeline: no ncross in text slots");
  const stops = tl.stops(), B7b = tl.byId("B7b");
  ok([1, 2, 3].every(k => stops.some(s => Math.abs(s - (B7b.p0 + (B7b.p1 - B7b.p0) * k / 4)) < 1e-6)), "timeline: B7b stop sub-ticks 1-3 of 4");
  ok(tl.beatStarts().length === tl.beats.length + 1 && tl.beatStarts()[tl.beats.length] === 1, "timeline: beat starts + end (rail ticks)");
  ok(tl.watch.total >= beats.meta.watchTotal_s - 1e-9 && tl.watch.total <= 1.12 * beats.meta.watchTotal_s,
    `timeline: Watch lasts watchTotal_s, lengthened only where captions need it (${tl.watch.total.toFixed(1)} s vs ${beats.meta.watchTotal_s} s)`);
  { // review2 scrolly A2: every caption's full-opacity window lasts ≥ words/3 + 1 s in Watch
    const shortW = tl.captions().filter(c => tl.watch.tAt(c.p1) - tl.watch.tAt(c.p1 - c.full) + 1e-6 < c.words / 3 + 1)
      .map(c => `${c.beat} ${c.words} words ${(tl.watch.tAt(c.p1) - tl.watch.tAt(c.p1 - c.full)).toFixed(1)} s`);
    ok(tl.captions().length > 20 && shortW.length === 0, `timeline: Watch holds every caption ≥ words/3 + 1 s (${tl.captions().length} captions)${shortW.length ? "\n   " + shortW.join("\n   ") : ""}`);
  }
  let worst = 0; for (let i = 0; i <= 200; i++) { const t = tl.watch.total * i / 200; worst = Math.max(worst, Math.abs(tl.watch.tAt(tl.watch.pAt(t)) - t)); }
  ok(worst < 1e-9, "timeline: Watch t ↔ p round trip");
  let agree = true;
  for (let i = 0; i <= 1000; i++) { const x = i / 1000, L = tl.locate(x), r = E.locate({items: tl.beats.map((b, k) => ({k, t0: b.p0, dur: b.p1 - b.p0}))}, x);
    if (L.i !== r.item.k) agree = false; }
  ok(agree, "timeline: locate agrees with v1 engine.locate (reused by import)");
  ok(tl.locate(1).beat.id === "B14" && tl.locate(1).u === 1 && tl.locate(0).beat.id === "B0", "timeline: ends map to B0 u 0 and B14 u 1");
  // reading budget
  let words = {}, src = "notch floor only (copy.json not present yet)";
  if (exists("copy.json")) {
    const copy = J("copy.json"); src = "copy.json";
    for (const b of tl.beats) { const c = copy[b.copyRef] || copy[b.id] || {};
      const wc = e => ["display", "sub"].map(k => String((e || {})[k] || "").replace(/\{\{[^}]*\}\}/g, "N").split(/\s+/).filter(Boolean).length).reduce((a, x) => a + x, 0);
      let prevU = null; words[b.id] = wc(c);
      for (const th of c.then || []) { const alt = th.when && prevU && JSON.stringify(th.u) === JSON.stringify(prevU); if (!alt) words[b.id] += wc(th); prevU = th.u; } }
  } else for (const b of tl.beats) words[b.id] = b.text.length ? 1 : 0;
  const short = tl.readingBudget(words);
  ok(short.length === 0, `timeline: reading budget (${src})${short.length ? "\n   " + short.join("\n   ") : ""}`);
}

/* ================= time warp ================= */
const ctx = SK.prepare(data, beats, shots);
{
  for (const ion of ["OVI", "HI"]) {
    const w = ctx.warp(ion);
    let mono = true; for (let i = 1; i < w.Wtab.length; i++) if (!(w.Wtab[i] > w.Wtab[i - 1])) mono = false;
    ok(mono, `warp ${ion}: W strictly increasing (monotone)`);
    let worst = 0, worstL = 0;
    for (let i = 0; i <= 1000; i++) { const u = i / 1000, l = w.lOf(-165, -124, u); worst = Math.max(worst, Math.abs(w.uOf(-165, -124, l) - u));
      worstL = Math.max(worstL, Math.abs(w.lOf(-165, -124, w.uOf(-165, -124, l)) - l)); }
    ok(worst < 1e-9 && worstL < 1e-9, `warp ${ion}: u → ℓ → u invertible (${worst.toExponential(1)})`);
    near(w.eps / (w.eps + w.wmax), 0.25, 1e-12, `warp ${ion}: the emptiest kpc costs 0.25 of the busiest`);
  }
  const w = ctx.warp("HI");
  ok(w.cost(-131.5) > 3 * w.cost(-60), "warp: cloud A (H I) costs > 3× a quiet kpc, so the camera slows there");
  const lA = SK.makeSeek({beats, shots});
  const fsA = lA(0.25, data), fsB = lA(0.25, data, {R: 5000, sn: 3, ion: "HI", tf: "speed", T263: 1e6, N492: 1e19, cls: "phonePortrait"});
  ok(fsA.l === fsB.l && fsA.beat.u === fsB.beat.u, "warp: overrides never move the probe (P2-2)");
  const camSame = JSON.stringify(lA(0.62, data).cam) === JSON.stringify(lA(0.62, data, {R: 5000, ion: "HI", tf: "speed"}).cam);
  ok(camSame, "shots: the camera never reads physics overrides");
}

/* ================= seek ================= */
const seek = SK.makeSeek({beats, shots});
{
  const rnd = lcg(12345), ps = Array.from({length: 500}, () => rnd());
  const a = ps.map(p => JSON.stringify(seek(p, data))), b = [...ps].reverse().map(p => JSON.stringify(seek(p, data))).reverse();
  ok(a.every((x, i) => x === b[i]), "seek: 500 random p, forward and reverse order, identical (G8)");
  const pure = ["js/core/seek.js", "js/core/shots.js", "js/core/timeline.js", "js/core/timewarp.js", "js/core/prefetch.js", "js/core/clock.js"];
  const strip = s => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
  for (const f of pure) {
    const src = strip(fs.readFileSync(path.join(ROOT, f), "utf8"));
    ok(!/Math\.random|Date\.now|new Date|performance\.now|requestAnimationFrame|setTimeout|setInterval|\bdocument\b|\bwindow\b/.test(src.replace(/exposeStory[\s\S]*$/, "")),
      `${f}: no clock, randomness or DOM`);
  }
  // FrameState shape
  const keys = ["p", "beat", "l", "cell", "cloud", "cam", "capsule", "quality", "tf", "fields", "shells", "text", "eqs", "spec", "ui"];
  let shape = true, why = "";
  for (let i = 0; i <= 400; i++) {
    const f = seek(i / 400, data);
    const bad = keys.find(k => !(k in f)) || (!["flight", "stop"].includes(f.quality) && "quality") || (!["strip", "pair", "hero"].includes(f.spec.dock) && "dock")
      || (!["intrinsic", "observed", "fit", "explore"].includes(f.spec.mode) && "mode") || (!f.cam.pos.every(Number.isFinite) && "cam")
      || (!(f.capsule.l1 > f.capsule.l0) && "capsule") || (!(f.tf.mix >= 0 && f.tf.mix <= 1) && "tf.mix")
      || (f.text.some(t => !(Math.abs(t.phase) < 1)) && "text.phase") || (!Number.isFinite(f.l) && "l");
    if (bad) { shape = false; why = `p=${i / 400}: ${bad}`; break; }
  }
  ok(shape, `seek: FrameState shape on 401 p ${why}`);
  // one kinetic group per band in every frame
  let oneGroup = true; for (let i = 0; i <= 2000; i++) { const f = seek(i / 2000, data);
    for (const band of ["act", "text"]) if (f.text.filter(t => t.band === band && !t.alt && Math.abs(t.phase) < 0.98).length > 1) oneGroup = false; }
  ok(oneGroup, "seek: at most one visible kinetic group per band at any p");
  // overrides
  const pre = seek(0.5, data, {R: 7000, sn: 4}), post = seek(0.9, data, {R: 7000, sn: 4});
  ok(pre.spec.R !== 7000 && post.spec.R === 7000 && post.spec.sn === 4, "seek: R and S/N overrides apply from B12a on");
  const a12 = tl.byId("B12a"), pu = u => a12.p0 + (a12.p1 - a12.p0) * u, R = u => seek(pu(u), data).spec.R;
  ok(Math.abs(R(0.1) - 150000) < 1 && R(0.3) < R(0.12) && Math.abs(R(0.6) - 5000) < 1 && Math.abs(R(0.95) - 30000) < 1,
    "seek: B12a sweeps R 150 000 → 5 000, then settles at 30 000 for B12b-B14");
  const c7 = tl.byId("B7c"), pmid = (c7.p0 + c7.p1) / 2;
  const hasId = (f, id) => f.text.some(t => t.id === id);
  ok(hasId(seek(pmid, data), "B7c") && !hasId(seek(pmid, data), "B7c.hot"), "seek: B7c shows its default line without a T drag");
  const keysOk = Number.isFinite((data.facts2 || {}).ovi_T_hot_fade) || /10/.test(String((data.keys || {}).ovi_T_hot_fade || ""));
  if (keysOk) {
    ok(hasId(seek(pmid, data, {T263: 1e7}), "B7c.hot"), "seek: dragging T263 above the hot fade shows 'Too hot'");
    ok(hasId(seek(pmid, data, {T263: 1e5}), "B7c.cool") && !hasId(seek(pmid, data, {T263: 3e5}), "B7c.hot")
       && !hasId(seek(pmid, data, {T263: 3e5}), "B7c.cool"), "seek: B7c cool variant below the cool fade, neither between the fades");
    const kd = {...data, facts2: undefined};
    ok(hasId(seek(pmid, kd, {T263: 4.0e5}), "B7c.hot") && !hasId(seek(pmid, kd, {T263: 3.8e5}), "B7c.hot"),
       "seek: display-string fallback parses keys.ovi_T_hot_fade (3.9×10⁵)");
  }
  else console.log("skip seek: B7c.hot needs keys.ovi_T_hot_fade (story-data/2, U_data)");
  const g = seek(pmid, data, {T263: 2e5}).eqs.find(e => e.id === "E2");
  ok(g && g.ghost && g.ghost.term === "T" && g.ghost.value === 2e5, "seek: the T263 override becomes the E2 ghost");
  ok(seek(0.3, data, {ion: "HI"}).spec.lead === "HI" && seek(0.3, data, {tf: "metals"}).tf.to === "metals", "seek: ion and TF overrides");
  ok(seek(0.9, data, {cls: "desktop"}).ui.inset === 0 && seek(0.9, data, {cls: "phonePortrait"}).ui.inset === 1 && seek(0.9, data).ui.inset === 0,
    "seek: the 3D inset is a phone-only state");
  ok(seek(0.43, data).cell && seek(0.43, data).cell.idx === 263, "seek: the B7b stop sits on cell 263");
  ok(seek(0.43, data).beat.stop && seek(0.43, data).beat.stop.n === 4, "seek: B7b reports 'stop k of 4'");
  // the exported story global
  const fakeClock = CL.createClock({});
  const api = SK.exposeStory(null, {seek, clock: fakeClock, timeline: tl, data: () => data, overrides: () => ({})});
  ok(["seek", "state", "rects", "beats", "setTarget", "quality", "version"].every(k => k in api) && api.beats().length === tl.beats.length,
    "seek: window.__story exposes the frozen keys");
  const bb = api.beats(), b7b = bb.find(b => b.id === "B7b"), b7e = bb.find(b => b.id === "B7e");
  ok(bb.every(b => ["strip", "pair", "hero"].includes(b.dock) && "stop" in b) && b7b.stop && b7b.stop.n === 4 && b7e.cond === "has_cold_knot",
    "seek: __story.beats() carries dock, stop and the beat cond (U_qa contract)");
  const st = api.state();
  ok(st.p === 0 && st.beat.id === "B0" && "quality" in st && st.spec.dock, "seek: __story.state() carries p, beat, quality, spec.dock");
  // story-data/2 wiring: geometry.ray (disk frame, the stage's world), geometry.cells lc, the kernel table, clouds
  const G2 = data.geometry, Pl = l => G2.ray.p0.map((x, k) => x + (l + G2.ray.half) * G2.ray.n[k]);
  ok(ctx.rayFallback === false && Math.max(...[0, 1, 2].map(k => Math.abs(ctx.frame.P(-100)[k] - Pl(-100)[k]))) < 1e-3,
    "seek: ray from story-data/2 geometry.ray (disk frame), P(l) = p0 + (l + half) n");
  const lc263 = G2.cells.lc[263], f263 = seek(tl.byId("B7b").p0 + 1e-4, data);
  ok(Math.abs(f263.l - lc263) < 1e-9 && f263.cell && f263.cell.idx === 263 && Math.abs(f263.cell.w - 0.5) < 0.02,
    "seek: B7b stops at cell 263's lc (not v1 l_kpc), kernel weight W = 0.5 at the centre (geometry.kernel_cdf)");
  const a7 = tl.byId("B7a"), fEnd = seek(a7.p1 - 1e-6, data);
  ok(Math.abs(fEnd.l - lc263) < 0.01, "seek: B7a's flight ends on cell 263 (no ℓ jump into the stop)");
  const fq = seek(0.30, data);
  ok(fq.capsule.edge === 0.3 && fq.capsule.r >= 20 && Math.abs(fq.capsule.l1 - fq.capsule.l0 - 90) < 1e-9,
    "seek: capsule {l ± 45, r ≥ 20, edge 0.3} in the stage's units");
  const cl = [...Array(41)].map((_, k) => seek(tl.byId("B5").p0 + (tl.byId("B5").p1 - tl.byId("B5").p0) * k / 40, data).cloud).filter(Boolean);
  ok(cl.some(c => c.letter === "A" && c.enter === 1), "seek: cloud A (cloud_names.letters) entered in B5");
  ok(tl.byId("B3").l1 === tl.byId("B4").l0 && tl.byId("B4").l0 < G2.cells.s_in[43] + 0.01,
    "beats: B3 ends before the first visible O VI cell (U_data: B3 'almost nothing', B4 the first shadow)");
  // review2 perf/a11y H1: discrete jumps land on each beat's reading point, where a sentence (or, for a beat without
  // words, its equation) is at full opacity, and every reduced-motion stop shows something to read
  {
    const rs = tl.readStarts(), shown = q => { const f = seek(q, data); return {f, text: f.text.some(t => Math.abs(t.phase) < 1e-9), eq: f.eqs.some(e => Math.abs(e.phase ?? 0) < 1e-9)}; };
    ok(rs.length === tl.beats.length + 1 && rs[rs.length - 1] === 1 && rs.every((q, k) => k === 0 || q > rs[k - 1]), "timeline: one reading point per beat, sorted, plus the end");
    const bad = rs.slice(0, -1).map((q, k) => [q, tl.beats[k]]).filter(([q, b]) => { const r = shown(q); return !(q >= b.p0 && q < b.p1 && r.f.beat.id === b.id && (r.text || ((b.text || []).length === 0 && r.eq))); });
    ok(bad.length === 0, `timeline: PageDown/rail landings show the beat's first line at full opacity${bad.length ? " — " + bad.map(([q, b]) => b.id + "@" + q.toFixed(4)).join(" ") : ""}`);
    ok(Math.abs(tl.readAt(tl.byId("B5").p0) - rs[tl.byId("B5").i]) < 1e-12 && tl.readAt(0.30123) === 0.30123, "timeline: readAt maps a rail tick (beat start) to its reading point, other p unchanged");
    const st = tl.stops(), empty = st.filter(q => q < 1 && !shown(q).text && !shown(q).eq);
    ok(empty.length === 0, `timeline: every reduced-motion stop shows a line or an equation${empty.length ? " — " + empty.join(" ") : ""}`);
    const lines = tl.beats.reduce((a, b) => a + (b.text || []).filter(t => (!t.when || t.when === "default") && !t.alt && (!t.cond || t.cond === b.cond) && t.band !== "eq").length, 0);
    ok(st.length >= lines, `timeline: reduced-motion stepping visits every line (${st.length} stops ≥ ${lines} lines)`);
  }
  tl.setSkip(b => b.cond === "has_cold_knot");
  ok(!tl.beatStarts().includes(tl.byId("B7e").p0) && tl.beatStarts().includes(tl.byId("B8").p0), "timeline: a beat whose cond is false is skipped by PageDown/rail");
  ok(!tl.readStarts().includes(tl.readPoint(tl.byId("B7e"))) && !tl.stops().some(q => q >= tl.byId("B7e").p0 && q < tl.byId("B7e").p1), "timeline: … and by the reading points and reduced-motion stops");
  tl.setSkip(null);
  ok(tl.beatStarts().includes(tl.byId("B7e").p0), "timeline: setSkip(null) restores every beat");
  // cross-unit vocabulary: every TF preset is one the stage draws, and each beat's fields cover what its presets need
  let TFS = null; try { TFS = await imp("js/stage/tfstory.js"); } catch (e) { console.log("skip presets: js/stage/tfstory.js (U_stage) not loadable: " + e.message); }
  if (TFS) {
    const badP = [], badF = [];
    for (const b of tl.beats) for (const k of b.tf) {
      if (!(k.preset in TFS.PRESETS)) badP.push(`${b.id}:${k.preset}`);
      for (const f of TFS.fieldsOf(k.preset)) if (!b.fields.some(x => x.name === f)) badF.push(`${b.id}:${f}`);
    }
    const b11 = tl.byId("B11"), c11 = seek(b11.p0 + (b11.p1 - b11.p0) * 0.5, data).tf, c5 = seek(tl.byId("B5").p0 + 0.7 * (tl.byId("B5").p1 - tl.byId("B5").p0), data).tf;
    ok(c11.to === "phases" && c11.chip === "composite" && c5.to === "ion:HI" && c5.chip === "ion:HI", "seek: tf.chip labels B11's composite look; plain presets label themselves");
    ok(!badP.length, `beats: every TF preset is a js/stage/tfstory.js preset${badP.length ? " (" + badP.join(", ") + ")" : ""}`);
    ok(!badF.length, `beats: fields cover tfstory.fieldsOf of every preset the beat uses${badF.length ? " (" + badF.join(", ") + ")" : ""}`);
    const avail = new Set([...(data.geometry.fields.available || []), "vel"]);
    ok(tl.beats.every(b => b.fields.every(f => avail.has(f.name))), "beats: every field is in the story data's viz manifest list (geometry.fields.available)");
  }
  const bus = BUS.createBus(); let got = null; const off = bus.on("brush", x => { got = x; }); bus.emit("brush", {ion: "OVI", v0: -10, v1: 10}); off();
  ok(got && got.v1 === 10 && bus.emit("brush", {}) === 0, "bus: on / emit / off");
}

/* ================= shots: continuity, NaN, up ================= */
{
  const cuts = new Set(tl.beats.filter(b => shots.shots[b.shot].cut).map(b => b.p0));
  for (const cls of [undefined, "phonePortrait", "tablet", "phoneLandscape", "narrow"]) {
    let prev = seek(0, data, {cls}), worstR = 0, worstUp = 0, nan = false, ortho = 0, at = "", atU = "";
    const off = f => { const P = ctx.frame.P(f.l); return f.cam.pos.map((x, k) => x - P[k]); };
    for (let i = 1; i <= 10000; i++) {
      const p = i / 10000, f = seek(p, data, {cls});
      if (![...f.cam.pos, ...f.cam.target, ...f.cam.up, f.cam.fov].every(Number.isFinite)) nan = true;
      const fwd = SH.v3.norm(SH.v3.sub(f.cam.target, f.cam.pos));
      ortho = Math.max(ortho, Math.abs(SH.v3.dot(fwd, f.cam.up)), Math.abs(SH.v3.len(f.cam.up) - 1));
      const isCut = [...cuts].some(c => p > c - 1e-9 && p - 1e-4 < c + 1e-9);
      if (!isCut) {
        const o1 = off(f), o0 = off(prev), r0 = SH.v3.len(o0);
        const rel = SH.v3.len(SH.v3.sub(o1, o0)) * 10 / (0.5 + 0.3 * r0);
        if (rel > worstR) { worstR = rel; at = `${f.beat.id}@${p}`; }
        const upd = Math.acos(Math.min(1, SH.v3.dot(f.cam.up, prev.cam.up))) / SH.DEG;
        if (upd > worstUp) { worstUp = upd; atU = `${f.beat.id}@${p}`; }
      }
      prev = f;
    }
    const c = cls || "default";
    ok(!nan, `shots ${c}: no NaN over 10 001 p`);
    ok(ortho < 1e-9, `shots ${c}: up is a unit vector ⟂ to the view`);
    ok(worstR <= 1, `shots ${c}: continuous (worst ${worstR.toFixed(2)} of the allowance at ${at})`);
    ok(worstUp <= 5, `shots ${c}: up turns ≤ 5° per 1e-4 p (worst ${worstUp.toFixed(2)}° at ${atU})`);
  }
  const f = seek(0.5, data);
  ok(SH.fovFor(50, 0.46) <= 70 && SH.fovFor(50, 0.46) > 50 && SH.fovFor(50, 1.6) === 50, "shots: portrait fov rule");
  const v = SH.viewFor(f.cam, 1440, 900, null), pr = SH.project(f.cam, v, f.cam.target);
  near(pr.x, 720, 1e-6, "shots: the look target projects to the image centre without a lens shift"); near(pr.y, 450, 1e-6, "shots: (y)");
  const rect = {x: 900, y: 100, w: 400, h: 500}, v2 = SH.viewFor(f.cam, 1440, 900, {world: rect}), pr2 = SH.project(f.cam, v2, f.cam.target);
  near(pr2.x, 1100, 1e-6, "shots: the lens shift puts the look target at the world band centre"); near(pr2.y, 350, 1e-6, "shots: (y)");
}

/* review2 scrolly #2: under hold-to-fly every caption stays at full opacity for ≥ 80 % of words / 4 s (words from
   beats.json, generated from copy.json; the rate stays ≤ holdRate and piecewise constant) */
{
  const tlh = TL.createTimeline(beats); let x = 0, t = 0, maxR = 0; const pts = [[0, 0]];
  for (let g = 0; g < 100000 && x < 1; g++) { const r = IN.holdRateAt(tlh, x + 1e-12); maxR = Math.max(maxR, r.rate); const nx = Math.min(1, r.until); t += (nx - x) / r.rate; x = nx; pts.push([x, t]); }
  const T = q => { for (let i = 1; i < pts.length; i++) if (q <= pts[i][0]) { const [a, ta] = pts[i - 1], [b, tb] = pts[i]; return ta + (tb - ta) * (q - a) / (b - a || 1); } return t; };
  const caps = tlh.captions(), short = caps.filter(c => T(c.p1) - T(c.p1 - c.full) < 0.8 * c.words / 4);
  ok(caps.length >= 30 && short.length === 0 && maxR <= IN.INPUT_TUNE.holdRate + 1e-12,
    `hold: every caption readable at 4 words/s under hold (${caps.length} captions, ${short.length} short; story ${t.toFixed(0)} s)${short.length ? " — " + short.map(c => c.beat).join(" ") : ""}`);
}

/* review2 scrolly #7: no view-direction or up step between neighbouring 2e-5-p samples (B0 had 1-10° steps where a
   comfort-camera sample hit the old B0 → B1 cut), in the default and the phone-portrait framing */
for (const cls of [null, "phonePortrait"]) {
  const dir = c => { const d = c.target.map((x, a) => x - c.pos[a]); const l = Math.hypot(...d); return d.map(x => x / l); };
  const ang = (a, b) => Math.acos(Math.max(-1, Math.min(1, a[0] * b[0] + a[1] * b[1] + a[2] * b[2]))) / Math.PI * 180;
  const cuts = new Set(tl.beats.filter(b => shots.shots[b.shot].cut && b.p0 > 0).map(b => b.p0));
  let prev = null, worst = 0, at = 0;
  for (let i = 0; i <= 50000; i++) { const p = i / 50000, f = seek(p, data, cls ? {cls} : {}), d = dir(f.cam);
    if (prev && ![...cuts].some(c => c > p - 2e-5 && c <= p)) { const s = Math.max(ang(prev.d, d), ang(prev.u, f.cam.up)); if (s > worst) { worst = s; at = p; } }
    prev = {d, u: f.cam.up}; }
  ok(worst <= 0.5, `shots ${cls || "default"}: no camera step > 0.5° between 2e-5-p samples (worst ${worst.toFixed(3)}° at p ${at.toFixed(5)})`);
}

/* ================= G3: beam vs text / equation bands, every layout class ================= */
function segHitsRect(a, b, r) {
  const x0 = r.x, y0 = r.y, x1 = r.x + r.w, y1 = r.y + r.h; let t0 = 0, t1 = 1; const dx = b[0] - a[0], dy = b[1] - a[1];
  const P = [-dx, dx, -dy, dy], Q = [a[0] - x0, x1 - a[0], a[1] - y0, y1 - a[1]];
  for (let i = 0; i < 4; i++) { if (P[i] === 0) { if (Q[i] < 0) return false; continue; }
    const t = Q[i] / P[i]; if (P[i] < 0) { if (t > t1) return false; if (t > t0) t0 = t; } else { if (t < t0) return false; if (t < t1) t1 = t; } }
  return t0 <= t1;
}
if (!LC) console.log("skip G3: js/ui/layoutclass.js (U_shell) not present");
else {
  const sizes = new Map();
  for (const m of LC.g1Matrix()) sizes.set(`${m.w}x${m.h}`, {w: m.w, h: m.h, cls: LC.layoutClass(m.w, m.h)});
  let frames = 0, hits = [], comp = {};
  // G3 names 160 p; this runs 1600 p (10× denser), because a camera blend shorter than 1/160 slipped between the coarse
  // samples (U_motion phase-1 rerun: B7d and B12a crossings found only at 1600 p)
  const NP = 1600;
  for (const {w, h, cls} of sizes.values()) for (let i = 0; i < NP; i++) {
    const p = (i + 0.5) / NP, f = seek(p, data, {cls});
    const bandsFn = (side, dock) => LC.computeBands(cls, w, h, {textSide: side, dock});
    // the page's probe keep-in lens shift (review F3; main.js and hud.itemsFor use the same rule)
    const kw = SH.keepWeight ? SH.keepWeight(tl.beats, f.p, f.l, ctx.half) : 0;
    const keep = kw > 0 ? {pt: ctx.frame.P(f.l), pts: SH.keepPts ? SH.keepPts(f, ctx.cellPos) : [], marginPx: SH.KEEP_MARGIN_PX || 0, rect: bandsFn(f.cam.textSide || "left", f.spec.dock || "strip").world, weight: kw} : null;
    const view = SH.viewFor(f.cam, w, h, bandsFn, {dock: f.spec.dock, dockFrom: f.spec.dockFrom, dockMix: f.spec.dockMix, keep});
    const bands = bandsFn(f.cam.textSide, f.spec.dock);
    frames++;
    const pr = SH.project(f.cam, view, ctx.frame.P(f.l)), W = bands.world;
    if (i % 10 === 4 && ["flight", "stop"].includes(f.beat.kind) && f.ui.inset < 0.5) {   // composition at 160 p, as before
      const m = 0.04 * Math.min(w, h), c = (comp[cls] ||= {n: 0, in: 0}); c.n++;
      if (pr.ok && W && pr.x >= W.x + m && pr.x <= W.x + W.w - m && pr.y >= W.y + m && pr.y <= W.y + W.h - m) c.in++;
      // fix3 R5: the selected cell (its ring) is in the world band too, never cut by the frame edge
      const kp = SH.keepPts ? SH.keepPts(f, ctx.cellPos) : [];
      const q0 = kp.length ? SH.project(f.cam, view, kp[0]) : null;   // a cell behind the camera has no ring to cut
      if (q0 && q0.ok && kw > 0.99) { const q = q0; c.cn = (c.cn || 0) + 1;
        if (q.ok && q.x >= 12 && q.x <= w - 12 && q.y >= 12 && W && q.y <= W.y + W.h) c.cin = (c.cin || 0) + 1; else (c.cout ||= []).push(`${f.beat.id}@${p.toFixed(3)}`); }
    }
    if (f.ui.inset >= 0.5) continue;                       // phones draw the 3D as an inset in B12-B14 (solver item)
    const seg = SH.projectSegment(f.cam, view, ctx.frame.P(-ctx.half), ctx.frame.P(ctx.half), 1);
    if (!seg) continue;
    const boxes = [];
    if (f.text.some(t => t.band === "text") && bands.text) boxes.push(["text", bands.text]);
    const phoneish = ["phonePortrait", "phoneLandscape", "narrow"].includes(cls);   // eq slots with noPhone stay off phones (T3)
    if (f.eqs.some(e => !(e.noPhone && phoneish)) && bands.eq) boxes.push(["eq", bands.eq]);
    for (const [k, r] of boxes) if (segHitsRect(seg[0], seg[1], r)) hits.push(`${f.beat.id}@${p.toFixed(4)} ${cls} ${w}x${h} ${k}`);
  }
  ok(hits.length === 0, `G3: beam never crosses a visible text/equation band (${frames} frames over ${sizes.size} CSS sizes × ${NP} p)${hits.length ? "\n   " + hits.slice(0, 12).join("\n   ") : ""}`);
  { // review2 three_d T3 (owner brief item 2): some flight stretch follows the sightline, camera < 1.5 kpc off the ray
    for (const cls of ["desktop", "phonePortrait"]) { let n = 0, best = 1e9;
      for (let i = 0; i <= 2000; i++) { const f = seek(i / 2000, data, {cls}); if (f.beat.kind !== "flight") continue;
        const d = f.cam.pos.map((x, a) => x - ctx.frame.mid[a]), t = d[0] * ctx.frame.n[0] + d[1] * ctx.frame.n[1] + d[2] * ctx.frame.n[2];
        const off = Math.hypot(...d.map((x, a) => x - t * ctx.frame.n[a])); best = Math.min(best, off); if (off < 1.5) n++; }
      ok(n / 2000 >= 0.015, `T3 ${cls}: camera within 1.5 kpc of the ray over ${(n / 2000).toFixed(3)} of p (≥ 0.015; closest ${best.toFixed(2)} kpc)`); }
  }
  { // fix3 R4: B9 shows both cells of the pair (S6_pair) inside the world band while B9.1 is read (u 0.61-0.69)
    const B9 = tl.beats.find(b => b.id === "B9"), ids = data.select && data.select.S6_pair && data.select.S6_pair.cells;
    if (B9 && ids && ids.length === 2) for (const {w, h, cls} of [...sizes.values()].filter((v, i, a) => a.findIndex(x => x.cls === v.cls) === i)) {
      let n = 0, good = 0;
      for (let u = 0.61; u <= 0.69 + 1e-9; u += 0.01) { const f = seek(B9.p0 + (B9.p1 - B9.p0) * u, data, {cls}); n++;
        const bandsFn = (side, dock) => LC.computeBands(cls, w, h, {textSide: side, dock});
        const kw = SH.keepWeight ? SH.keepWeight(tl.beats, f.p, f.l, ctx.half) : 0;
        const keep = kw > 0 ? {pt: ctx.frame.P(f.l), pts: SH.keepPts ? SH.keepPts(f, ctx.cellPos) : [], marginPx: SH.KEEP_MARGIN_PX || 0, rect: bandsFn(f.cam.textSide || "left", f.spec.dock || "strip").world, weight: kw} : null;
        const view = SH.viewFor(f.cam, w, h, bandsFn, {dock: f.spec.dock, dockFrom: f.spec.dockFrom, dockMix: f.spec.dockMix, keep}), W = bandsFn(f.cam.textSide, f.spec.dock).world;
        if (ids.every(i => { const q = SH.project(f.cam, view, ctx.cellPos(i)); return q.ok && q.x >= W.x && q.x <= W.x + W.w && q.y >= W.y && q.y <= W.y + W.h; })) good++; }
      const need = cls === "narrow" ? 0.75 : 0.85;   // narrow (260-320 px): the last two samples lose the far cell at the band edge
      ok(good / n >= need, `R4 ${cls} ${w}x${h}: both B9 pair cells in the world band in ${good}/${n} frames of B9.1 (>= ${100 * need} %)`);
    }
  }
  for (const [cls, c] of Object.entries(comp)) if (c.cn) ok(c.cin / c.cn >= 0.83, `R5 ${cls}: selected cell on screen above the dock in ${(100 * c.cin / c.cn).toFixed(0)} % of frames with a selection (floor 83 %: before fix3 82-91 %; the rest are B3/B4 close chase poses)${c.cout ? "; off: " + c.cout.filter(x => !/^B[34]@/.test(x)).join(", ") : ""}`);
  for (const [cls, c] of Object.entries(comp)) ok(c.in / c.n >= 0.75, `composition ${cls}: probe in the world band in ${(100 * c.in / c.n).toFixed(0)} % of flight/stop frames (≥ 75 %)`);
  // the bright galaxy disk (disk frame z = 0, r ≤ 30 kpc) never sits under visible body text (U_stage S0: B7a's disk
  // reached the text column with the placeholder camera, G4/G11). Act titles over the overview views are by design.
  const disk = []; for (let r = 2; r <= 30; r += 2) for (let a = 0; a < 360; a += 6) disk.push([r * Math.cos(a * Math.PI / 180), r * Math.sin(a * Math.PI / 180), 0]);
  let worstDisk = 0, worstAt = "";
  for (const [w, h] of [[1440, 900], [1024, 768], [390, 844], [844, 390], [1920, 1080]]) {
    const cls = LC.layoutClass(w, h), bandsFn = (side, dock) => LC.computeBands(cls, w, h, {textSide: side, dock});
    for (const b of tl.beats) for (const u of [0.25, 0.5, 0.75]) {
      const f = seek(b.p0 + (b.p1 - b.p0) * u, data, {cls});
      if (!f.text.some(t => t.band === "text") || f.ui.inset >= 0.5) continue;
      const kw = SH.keepWeight ? SH.keepWeight(tl.beats, f.p, f.l, ctx.half) : 0;
      const keep = kw > 0 ? {pt: ctx.frame.P(f.l), pts: SH.keepPts ? SH.keepPts(f, ctx.cellPos) : [], marginPx: SH.KEEP_MARGIN_PX || 0, rect: bandsFn(f.cam.textSide || "left", f.spec.dock || "strip").world, weight: kw} : null;
      const view = SH.viewFor(f.cam, w, h, bandsFn, {dock: f.spec.dock, dockFrom: f.spec.dockFrom, dockMix: f.spec.dockMix, keep}), T = bandsFn(f.cam.textSide, f.spec.dock).text;
      let k = 0; for (const q of disk) { const s = SH.project(f.cam, view, q); if (s.ok && s.x >= T.x && s.x <= T.x + T.w && s.y >= T.y && s.y <= T.y + T.h) k++; }
      if (k / disk.length > worstDisk) { worstDisk = k / disk.length; worstAt = `${b.id}@${u} ${w}x${h}`; }
    }
  }
  ok(worstDisk <= 0.02, `composition: galaxy disk under visible body text ≤ 2 % of its area (worst ${(100 * worstDisk).toFixed(1)} %${worstAt ? " at " + worstAt : ""})`);
}


/* ================= drivers: Watch, ticker, override layer (injected clocks) ================= */
{
  const PD = await imp("js/drivers/play.js"), XD = await imp("js/drivers/explore.js");
  let tNow = 0; const q = []; const raf = f => { q.push(f); return q.length; }, caf = () => {};
  const flush = (ms) => { tNow += ms; const fs = q.splice(0); fs.forEach(f => f()); };
  const clock = CL.createClock({}), bus = BUS.createBus(); let ended = null;
  const w = PD.createWatchDriver({clock, timeline: tl, bus, now: () => tNow, raf, caf, onEnd: p => { ended = p; }});
  w.play(0);
  for (let i = 0; i < 600; i++) flush(100);                          // 60 s of Watch
  near(clock.target, tl.watch.pAt(60), 1e-9, "watch: target follows the beats' Watch schedule");
  ok(clock.state.mode === "watch" && w.playing, "watch: clock in watch mode while playing");
  near(w.remaining(), tl.watch.total - 60, 1e-6, "watch: remaining time for the rail tooltip");
  bus.emit("input", {kind: "wheel"}); ok(!w.playing && clock.state.mode === "cruise", "watch: any user input pauses it (C_ux P1-9)");
  w.play(); for (let i = 0; i < 3000; i++) flush(100);
  ok(ended !== null && Math.abs(clock.target - 1) < 1e-9 && !w.playing, "watch: stops at the end (no loop)");
  w.play(); near(clock.target, 0, 1e-12, "watch: play after the end replays from the start"); w.destroy();
  // ticker
  const c2 = CL.createClock({}); let frames = 0; tNow = 0; q.length = 0;
  const tk = PD.createTicker({clock: c2, onFrame: () => { frames++; }, now: () => tNow, raf, caf});
  tk.start(); flush(16); c2.setTarget(0.5); for (let i = 0; i < 200; i++) flush(16);
  const moving = frames; for (let i = 0; i < 100; i++) flush(16);
  ok(moving > 50 && frames - moving <= 1, `ticker: frames while moving (${moving}), none once settled (${frames - moving})`);
  tk.kick(); flush(16); ok(frames - moving >= 1, "ticker: kick() forces one frame (override changed while idle)");
  // a stalled frame during a hold keeps its time (the flaky browser G7 Space run lost ~0.45 s to one long frame)
  c2.jump(0.2); c2.setRate(0.012); flush(16); const t0 = c2.target; flush(600); flush(16);
  near(c2.target - t0, 0.012 * 0.616, 1e-9, "ticker: a 0.6 s stalled frame while flying still advances 0.6 s of hold");
  c2.setRate(0); const tg = c2.target; c2.setTarget(0.9); flush(5000);
  ok(c2.p < 0.9 && c2.p > tg, "ticker: without a hold, a long gap is still capped (maxDt, background tab)"); tk.stop();
  // override layer
  const b2 = BUS.createBus(), seen = []; b2.on("override", x => seen.push(x));
  const xo = XD.createStoryExplore({bus: b2});
  xo.set({R: 1e6, sn: 1, ion: "XX", T263: 5e5, N492: 1e22, junk: 3, tf: "speed"});
  ok(xo.overrides.R === 150000 && xo.overrides.sn === 2 && !("ion" in xo.overrides) && xo.overrides.N492 === 1e19 && !("junk" in xo.overrides),
    "explore: overrides clamped to the explorer's ranges; unknown keys and bad ions ignored");
  ok(Object.isFrozen(xo.overrides) && seen.length === 5, "explore: frozen layer; every accepted change on the bus");
  xo.set("R", 150000); ok(seen.length === 5, "explore: unchanged value is not re-announced");
  xo.clear(); ok(Object.keys(xo.overrides).length === 0, "explore: clear()");
}

/* ================= prefetch ================= */
{
  const issuedAt = new Map(), P = PF.createPrefetcher({beats: tl.beats, load: (n, l) => { issuedAt.set(`${n}@${l}`, issuedAt.get(`${n}@${l}`) ?? null); }});
  const first = new Map();
  for (let i = 0; i <= 1000; i++) { const p = i / 1000; for (const it of P.update(p)) first.set(it.key, p); }
  let late = [];
  for (const b of tl.beats) for (const fl of b.fields) {
    const k = PF.fieldKey(fl), t = first.get(k);
    if (t === undefined || t > Math.max(0, b.p0 - b.lead) + 1e-3 + 1e-9) late.push(`${b.id} ${k} at ${t} > ${Math.max(0, b.p0 - b.lead)}`);
  }
  ok(late.length === 0, `prefetch: every field requested ≥ lead before its beat${late.length ? "\n   " + late.join("\n   ") : ""}`);
  ok(P.update(0.5).length === 0, "prefetch: a field is requested once");
  const f = seek(0.098, data); ok(f.fields.some(x => x.name === "T"), "seek: fields hint includes the next beat's field inside its lead");
}

console.log(`${fails ? "FAIL" : "PASS"} story_core: ${n} checks, ${fails} failures`);
process.exit(fails ? 1 : 0);
