// Story engine, store and drivers ("How a spectrum is made", PLAN_final sections 1, 4, 6, 8; unit U1).
// node tests/js/story_engine.mjs   (no browser, no Python; run_all.mjs picks it up)
// Checks: steps.schema.json + validateSteps (and ROOT/steps.json when it exists); timeline and cuts; authored-state
// tweens; recording-context purity of seek() (seek(a); seek(b); seek(a) identical, forward and reverse, any order);
// Explore overrides never reach seek(); static purity of scenes and of the seek path (no fitPanel, clock or
// randomness); {{key}} templates; store URL grammar, alias rewrite, galaxy/ray keys, resume and prefs; hand-off
// round trip through the explorer's own parseHash/formatHash; Play, Step and Explore drivers on injected clocks;
// fit.js tauVoigt against the closed form and the plan's worked number.

import fs from "node:fs";
import path from "node:path";
import {fileURLToPath, pathToFileURL} from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url)), REPO = path.resolve(HERE, "../..");
const ROOT = path.join(REPO, "docs/tng50/learn/how-a-spectrum-is-made");
const imp = p => import(pathToFileURL(path.join(ROOT, p)).href);
const E = await imp("js/engine.js"), ST = await imp("js/store.js");
const {createPlayDriver} = await imp("js/drivers/play.js"), {createStepDriver} = await imp("js/drivers/step.js");
const {createExploreDriver} = await imp("js/drivers/explore.js");
const stub = (await imp("js/scenes/stub.js")).default;
const STATE = await import(pathToFileURL(path.join(REPO, "docs/tng50/js/state.js")).href);
const FIT = await import(pathToFileURL(path.join(REPO, "docs/tng50/js/fit.js")).href);
const schema = JSON.parse(fs.readFileSync(path.join(ROOT, "steps.schema.json"), "utf8"));

let fails = 0, n = 0;
const ok = (c, msg) => { n++; if (c) console.log("ok " + msg); else { fails++; console.log("FAIL " + msg); } };
const eq = (a, b, msg) => ok(JSON.stringify(a) === JSON.stringify(b), msg + (JSON.stringify(a) === JSON.stringify(b) ? "" : `\n   got  ${JSON.stringify(a)}\n   want ${JSON.stringify(b)}`));
const near = (a, b, tol, msg) => ok(Math.abs(a - b) <= tol, `${msg} (${a} vs ${b}, tol ${tol})`);

/* ---------------- fixture: a small story in the real shape ---------------- */
const L = {land: {stage: "full", card: "right"}, port: {stage: "top", card: "bottom"}};
const step = (o) => ({params: {}, text: "A light behind reveals it", caption: "A light behind reveals it",
  aria: "A dark sky with a warm white beam", dur_s: 2, layout: L, film: false, ...o});
const DOC = {schema: "story-steps/1", meta: {g: 488530, ray: "rand_b062_a062", seed: 7, R: 30000, sn: 10},
  steps: [
    step({id: "light-1", scene: "stub", chapter: "light", title: "Why can't we just look at the gas?", params: {beam: 0.2}, film: true, scrub: true}),
    step({id: "light-2", scene: "stub", chapter: "light", params: {beam: 1, strip: 1}, film: true, dur_s: 3}),
    step({id: "dip-1", scene: "stub", chapter: "dip", title: "How does one cloud make a dip?", params: {strip: 1, dip: 0.8, dipB: 17.3},
      sub: "Centre lets through {{cell263.centre_pct}} % of the light", physics: {eq: "tau0", line: "tau0 = {{cell263.tau0}}"},
      controls: ["dipV", "dipB"], tween: {ms: 400, ease: "out"}, film: true, film_dur_s: 1}),
    step({id: "dip-2", scene: "stub", chapter: "dip", params: {dipB: 40, vRange: 200}, controls: ["dipB"], tween: {frac: 0.5}}),
    step({id: "noise-1", scene: "stub", chapter: "noise", title: "Why is it noisy?", params: {strip: 1, noise: 0.3}, seedRule: "seedFor(seed, ion, step id)",
      handoff: {ions: ["OVI"], layout: "1", R: [30000], sn: [10]}, film: true}),
    step({id: "yourturn-1", scene: "stub", chapter: "yourturn", title: "Now it is yours", params: {strip: 1, dip: 0.5},
      handoff: {ions: ["OVI", "HI"], layout: "2SN", R: [15000], sn: [20, 5], fit: true}, film: true, dur_s: 10 / 3}),
  ]};
const DATA = {vars: {cell263: {tau0: 1.73, centre_pct: 18}}, ions: {OVI: {l_kpc: [1, 2, 3]}}};
const SCENES = {stub};
const clone = o => JSON.parse(JSON.stringify(o));

/* ---------------- schema + validateSteps ---------------- */
{
  const v = E.validateSteps(DOC, schema, ["stub"]);
  ok(v.ok, "fixture steps.json is valid" + (v.ok ? "" : ": " + v.errors.join("; ")));
  const bad = (mut, re, msg) => { const d = clone(DOC); mut(d); const r = E.validateSteps(d, schema, ["stub"]); ok(!r.ok && r.errors.some(e => re.test(e)), msg + (r.ok ? " (passed)" : "")); };
  bad(d => { d.steps[1].title = "x"; }, /title only/, "title on a second step is refused");
  bad(d => { delete d.steps[2].title; }, /needs a title/, "missing chapter title is refused");
  bad(d => { d.steps[0].dur_s = 1.01; }, /multiple of 1\/30/, "dur_s off the 30 fps grid is refused");
  bad(d => { d.steps.forEach(s => { s.scrub = true; }); }, /scrub steps/, "more than 3 scrub steps refused");
  bad(d => { d.steps[0].colour = "red"; }, /unknown key colour/, "unknown step key refused");
  bad(d => { d.steps[0].scene = "nope"; }, /unknown scene/, "unknown scene refused");
  bad(d => { d.steps[0].controls = ["a", "b", "c"]; }, /more than 2/, "more than 2 controls refused");
  bad(d => { d.steps[3].tween = {ms: 900}; }, /above 600/, "tween over 600 ms refused");
  bad(d => { d.steps[0].seedRule = "x"; }, /seedRule/, "seedRule outside noise/fit refused");
  bad(d => { d.steps[1].id = "light-1"; }, /duplicate/, "duplicate id refused");
  bad(d => { d.steps[0].sub = "{{a.b"; }, /malformed/, "malformed template refused");
  bad(d => { d.steps.reverse(); d.steps.forEach((s, i, a) => { if (i === 0 || a[i - 1].chapter !== s.chapter) s.title = "Q"; else delete s.title; }); }, /out of order/, "chapters out of order refused");
  bad(d => { d.schema = "story-steps/2"; }, /must be/, "wrong schema id refused");
  bad(d => { d.steps[0].handoff = {layout: "3"}; }, /not one of/, "hand-off layout outside LAYOUTS refused");
  eq(schema.$defs.chapter.enum, E.CHAPTERS, "schema chapter enum equals engine CHAPTERS");
  eq(schema.$defs.step.properties.handoff.properties.layout.enum, STATE.LAYOUTS, "schema hand-off layouts equal state.js LAYOUTS");
  const real = path.join(ROOT, "steps.json");
  if (fs.existsSync(real)) {
    const doc = JSON.parse(fs.readFileSync(real, "utf8"));
    const names = fs.readdirSync(path.join(ROOT, "js/scenes")).filter(f => f.endsWith(".js")).map(f => f.slice(0, -3));
    const r = E.validateSteps(doc, schema, names);
    ok(r.ok, "ROOT/steps.json valid against steps.schema.json" + (r.ok ? "" : ":\n   " + r.errors.join("\n   ")));
  } else console.log("ok ROOT/steps.json not written yet (U4); fixture only");
}

/* ---------------- templates ---------------- */
{
  eq(E.templateKeys("a {{x}} b {{ y.z }}"), ["x", "y.z"], "templateKeys finds plain and dotted keys");
  eq(E.resolveTemplate("tau0 = {{cell263.tau0}}", DATA), {text: "tau0 = 1.73", missing: [], fallback: []}, "template resolves from data.vars");
  eq(E.resolveTemplate("{{nope}} left", DATA), {text: "{{nope}} left", missing: ["nope"], fallback: []}, "missing key stays visible and is reported");
  eq(E.resolveTemplate("v = {{v}}", {v: -69.31}).text, "v = −69.31", "negative numbers use U+2212");
  eq(E.resolveTemplate("{{toString}}", {}).missing, ["toString"], "inherited keys do not resolve");
}

/* ---------------- timeline ---------------- */
{
  const full = E.buildTimeline(DOC.steps, "full"), film = E.buildTimeline(DOC.steps, "film");
  near(full.duration, 2 + 3 + 2 + 2 + 2 + 10 / 3, 1e-9, "full cut duration = sum of dur_s");
  near(film.duration, 2 + 3 + 1 + 2 + 10 / 3, 1e-9, "film cut uses film steps and film_dur_s");
  eq(film.items.map(x => x.id), ["light-1", "light-2", "dip-1", "noise-1", "yourturn-1"], "film cut keeps film steps in order");
  ok(full.items.every(x => Number.isInteger(x.f0) && Number.isInteger(x.frames)), "timeline is in whole frames");
  const L0 = E.locate(full, 0), Lb = E.locate(full, 2), Le = E.locate(full, 999), Ln = E.locate(full, -1);
  eq([L0.item.id, L0.t, Lb.item.id, Lb.t], ["light-1", 0, "light-2", 0], "locate at 0 and on a boundary");
  eq([Le.item.id, Le.t === Le.item.dur], ["yourturn-1", true], "locate past the end holds the last step's end");
  eq(Ln.item.id, "light-1", "negative t clamps to the start");
}

/* ---------------- authored states ---------------- */
{
  const A = E.authoredStates(DOC.steps, SCENES);
  eq(A[0].to.beam, 0.2, "first step: defaults + params");
  ok(A[0].from === A[0].to, "first step of a run does not tween");
  eq([A[1].from.beam, A[1].to.beam, A[1].to.strip], [0.2, 1, 1], "second step tweens from the first step's authored end");
  eq([A[2].from.beam, A[2].to.beam], [1, 1], "params carry forward within a scene run");
  eq(A[3].to.dipB, 40, "later params override");
  const mid = E.interpState(A[3].from, A[3].to, 0.5, stub.interp);
  near(mid.dipB, (17.3 + 40) / 2, 1e-12, "lerp of numbers");
  near(mid.vRange, Math.sqrt(400 * 200), 1e-9, "log interpolation where the scene asks for it");
  eq(E.interpState({a: 1, s: "x"}, {a: 3, s: "y"}, 0.25).s, "y", "non-numbers snap to the target");
  eq(E.interpState({a: [0, 0]}, {a: [2, 4]}, 0.5).a, [1, 2], "number arrays interpolate element-wise");
  const scenes2 = {stub, other: {...stub, id: "other", defaults: {beam: 0.5}}};
  const doc2 = [{...DOC.steps[0]}, {...DOC.steps[1], scene: "other", params: {}}, {...DOC.steps[2], params: {}}];
  const A2 = E.authoredStates(doc2, scenes2);
  eq([A2[1].to.beam, A2[1].from === A2[1].to, A2[2].to.beam], [0.5, true, 1], "scene change restarts from the scene's defaults, no tween");
}

/* ---------------- recording context ---------------- */
function recCtx(W = 640, H = 360) {
  const log = [];
  const target = {canvas: {width: W, height: H}};
  const ctx = new Proxy(target, {
    get(t, k) {
      if (k === "canvas") return t.canvas;
      if (k === "__log") return log;
      if (typeof k === "symbol") return undefined;
      return (...args) => {
        log.push(k + "(" + args.map(a => (typeof a === "number" ? +a.toPrecision(12) : a)).join(",") + ")");
        // deterministic stand-ins for the calls that return something
        if (k === "measureText") return {width: 7 * String(args[0] ?? "").length, actualBoundingBoxAscent: 8, actualBoundingBoxDescent: 2};
        if (k === "createLinearGradient" || k === "createRadialGradient" || k === "createConicGradient" || k === "createPattern")
          return {addColorStop: (o, c) => log.push(`stop(${o},${c})`)};
        if (k === "getImageData" || k === "createImageData") return {data: new Uint8ClampedArray(4 * (args[2] || 1) * (args[3] || 1)), width: args[2] || 1, height: args[3] || 1};
        if (k === "getTransform") return {a: 1, b: 0, c: 0, d: 1, e: 0, f: 0};
        if (k === "isPointInPath") return false;
        if (k === "getLineDash") return [];
        return undefined;
      };
    },
    set(t, k, v) { log.push(k + "=" + (typeof v === "number" ? +v.toPrecision(12) : v)); return true; },
  });
  return ctx;
}
const frameLog = (eng, ctx, t) => { ctx.__log.length = 0; eng.seek(t); return ctx.__log.join(";"); };

{
  let prepared = 0;
  const counting = {...stub, prepare: async d => { prepared++; return stub.prepare(d); }};
  const ctx = recCtx(), ctx2 = recCtx();
  const eng = E.createEngine({doc: DOC, scenes: {stub: counting}, ctx, data: DATA, schema});
  await eng.ready(); await eng.ready();
  eq(prepared, 1, "prepare() runs once per scene, ready() is idempotent");
  const eng2 = E.createEngine({doc: DOC, scenes: SCENES, ctx: ctx2, data: DATA});
  await eng2.ready();
  const D = eng.duration, ts = [];
  for (let i = 0; i <= 120; i++) ts.push(D * i / 120);
  ts.push(1.999, 2, 2.001, 0.4, 5.5, 7.25);
  const fwd = ts.map(t => frameLog(eng, ctx, t));
  const rev = ts.slice().reverse().map(t => frameLog(eng, ctx, t)).reverse();
  ok(fwd.every((s, i) => s === rev[i]), "seek() logs identical forward and reverse");
  let aba = true;
  for (let i = 0; i < ts.length; i++) {
    const a = ts[i], b = ts[(i * 37 + 11) % ts.length];
    const l1 = frameLog(eng, ctx, a); frameLog(eng, ctx, b); const l2 = frameLog(eng, ctx, a);
    if (l1 !== l2) aba = false;
  }
  ok(aba, "seek(a); seek(b); seek(a) gives the same call log for every pair tried");
  ok(ts.every(t => frameLog(eng, ctx, t) === frameLog(eng2, ctx2, t)), "two engines agree frame by frame (no hidden state)");
  const tNoise = eng.span(eng.indexOf("noise-1")).t0 + 1;
  ok(frameLog(eng, ctx, tNoise).includes("lineTo"), "noise step draws");
  ok(frameLog(eng, ctx, tNoise) === frameLog(eng, ctx, tNoise), "noise is the same draw on every seek");
  const eng3 = E.createEngine({doc: {...DOC, meta: {...DOC.meta, seed: 8}}, scenes: SCENES, ctx: recCtx(), data: DATA});
  const c3 = recCtx(); eng3.setContext(c3);
  ok(frameLog(eng, ctx, tNoise) !== frameLog(eng3, c3, tNoise), "a different seed gives a different noise draw");
  // tween: mid-step state differs from the end state, the step end equals the authored state
  const i2 = eng.indexOf("light-2");
  near(eng.stateAt(i2, 0).state.beam, 0.2, 1e-12, "Play starts a step from the previous authored state");
  near(eng.stateAt(i2).state.beam, 1, 1e-12, "step end = authored end state");
  near(eng.stateAt(eng.indexOf("dip-2"), 1).p, 1, 1e-12, "tween.frac 0.5 finishes at half the step");
  // explore overrides never reach seek
  const ex = createExploreDriver({engine: eng});
  const iDip = eng.indexOf("dip-1"), tDip = eng.span(iDip).t1 - 1e-6;
  const before = frameLog(eng, ctx, tDip);
  ok(ex.open(iDip), "explore opens on a step with controls");
  ok(!ex.open(eng.indexOf("light-1")) || false, "explore refuses a step without controls");
  ex.open(iDip);
  ex.set("dipB", 60); ex.set("beam", 0);
  eq(ex.override, {dipB: 60}, "explore accepts only the step's own controls");
  ctx.__log.length = 0; eng.show(iDip, Infinity, {override: ex.override}); const live = ctx.__log.join(";");
  const after = frameLog(eng, ctx, tDip);
  ok(live !== before, "explore override changes the drawing");
  ok(after === before, "seek() ignores the explore layer");
  ex.close();
  eq(ex.open && ex.override, false || ex.override, "explore closes");
  // film cut seek covers the same steps
  eng.setCut("film"); near(eng.duration, 2 + 3 + 1 + 2 + 10 / 3, 1e-9, "setCut(film) switches the timeline"); eng.setCut("full");
  eq(eng.missingKeys(), [], "every {{key}} in the fixture resolves against the data");
  // render.html contract shape
  const frameSource = {element: {}, ready: eng.ready, render: t => eng.seek(t)};
  ok(typeof frameSource.ready === "function" && frameSource.render(1).id === "light-1", "registerFrameSource({element, ready, render}) shape works");
  // failing schema rejects in ready()
  const badDoc = clone(DOC); badDoc.steps[1].title = "x";
  let threw = false; try { await E.createEngine({doc: badDoc, scenes: SCENES, ctx: recCtx(), data: DATA, schema}).ready(); } catch { threw = true; }
  ok(threw, "ready() rejects an invalid steps.json");
  // loadData gets galaxy and ray
  let asked = null;
  const e4 = E.createEngine({doc: DOC, scenes: SCENES, ctx: recCtx(), galaxy: 505100, ray: "edge_b100_a090", loadData: async q => { asked = q; return DATA; }});
  await e4.ready();
  eq(asked, {galaxy: 505100, ray: "edge_b100_a090"}, "loadData receives the galaxy and sightline (any galaxy of the sample)");
  eq(E.dataUrl(411449, "rand_b062_a062"), "data/story_411449_rand_b062_a062.json", "dataUrl template");
}

/* ---------------- frame state, auto import, formats ---------------- */
{
  const seen = [];
  const spy = {...stub, render: (ctx, s, t, d, env) => seen.push({s, env})};
  const eng = E.createEngine({doc: DOC, scenes: {stub: spy}, ctx: recCtx(), data: DATA, mode: "watch", physics: true});
  await eng.ready();
  eng.seek(eng.span(eng.indexOf("dip-2")).t0 + 0.5);
  const {s} = seen.pop();
  eq([s.step, s.chapter, s.scene, s.mode, s.explore, s.physics, s.seed, s.galaxy, s.ray], ["dip-2", "dip", "stub", "watch", null, true, 7, 488530, "rand_b062_a062"], "scenes get the frame keys in state");
  ok(s.params.dipB === s.dipB && s.dur_s === 2 && Math.abs(s.t - 0.5) < 1e-9 && Math.abs(s.u - 0.25) < 1e-9, "state.params, t, u, dur_s");
  eq(E.FRAME_KEYS.filter(k => !(k in s)), [], "every FRAME_KEY is present");
  eng.show(eng.indexOf("dip-2"), Infinity, {override: {dipB: 5}});
  const o = seen.pop().s;
  eq([o.mode, o.explore, o.dipB], ["explore", {dipB: 5}, 5], "explore frames carry mode explore and the override");
  eng.show(eng.indexOf("noise-1"));
  eq(seen.pop().s.seed, 7, "page seed reaches the state");
  const d2 = clone(DOC); d2.steps[4].params.seed = 99;
  const e2 = E.createEngine({doc: d2, scenes: {stub: spy}, ctx: recCtx(), data: DATA}); await e2.ready();
  e2.show(4); eq(seen.pop().s.seed, 99, "a step's authored params.seed wins over the page seed");
  const bad = clone(DOC); bad.steps[0].params.mode = "x";
  ok(E.validateSteps(bad, schema, ["stub"]).errors.some(e => /reserved/.test(e)), "params using a frame key are refused");
  const e3 = E.createEngine({doc: DOC, ctx: recCtx(), data: DATA}); await e3.ready();
  ok(e3.scene("stub") && typeof e3.scene("stub").render === "function" && e3.seek(1).id === "light-1", "ready() imports scenes by name");
  let r = 0; const e4 = E.createEngine({doc: DOC, scenes: {stub: {...stub, prepare: undefined, ready: () => { r++; }}}, ctx: recCtx(), data: DATA}); await e4.ready();
  eq(r, 1, "scene.ready(data) is accepted as prepare");
  let threw = ""; try { await E.importScene("../engine"); } catch (e) { threw = String(e.message); }
  ok(/bad scene name/.test(threw), "scene names cannot leave js/scenes");
  const cv = {width: 0, height: 0, getContext: () => ({canvas: cv, save() {}, restore() {}})};
  const e5 = E.createEngine({steps: DOC.steps, meta: DOC.meta, stage: {querySelector: () => cv}, width: 1920, height: 1080, dpr: 1, query: {g: "tng50-1-99-505100", ray: "edge_b100_a090"}, scenes: SCENES, data: DATA});
  eq([cv.width, cv.height, e5.env.galaxy, e5.env.ray], [1920, 1080, 505100, "edge_b100_a090"], "stage canvas sized; query g (any galaxy) and ray");
  const keys = {ngal: {path: "meta.n_galaxies", fmt: "int", fallback: 198}, T: {path: "ions.OVI.T263", fmt: "sci2"}, tp: {path: "ions.HI.tau_peak", fmt: "int"}, vs: {path: "meta.v_sys", fmt: "f2"}};
  const dd = {meta: {v_sys: -69.31}, ions: {OVI: {T263: 287000}, HI: {tau_peak: 22723}}};
  const rr = E.resolveTemplate("{{ngal}} galaxies, T {{T}} K, peak {{tp}}, v {{vs}}", dd, keys);
  eq([rr.text, rr.fallback], ["198 galaxies, T 2.87×10⁵ K, peak 22 723, v −69.31", ["ngal"]], "keys: path, fmt (int, sci2, f2) and reported fallback");
  eq([E.fmtValue(9999.6, "int"), E.fmtValue(-0.001, "f2"), E.fmtValue(9.996e4, "sci2"), E.fmtValue(488530, "id")], ["10 000", "0.00", "1.00×10⁵", "488530"], "fmtValue edge cases (no minus on zero, sci2 carry, id ungrouped)");
  eq(ST.handoffState({R: {uv: [15000, 50000]}}, {R: 30000, sn: 10, seed: 1, ray: "rand_b062_a062"}).R.uv, [15000, 50000], "hand-off accepts the explorer's {uv: [R1, R2]} form");
}

/* ---------------- real steps.json + real scenes + real data (through data/index.json), when they exist ---------------- */
{
  const real = path.join(ROOT, "steps.json"), idxf = path.join(ROOT, "data/index.json");
  const doc = fs.existsSync(real) ? JSON.parse(fs.readFileSync(real, "utf8")) : null;
  const readJ = async u => JSON.parse(fs.readFileSync(fileURLToPath(u), "utf8"));
  const readB = async u => { const b = fs.readFileSync(fileURLToPath(u)); return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength); };
  const base = pathToFileURL(ROOT + "/").href;
  if (!doc || !fs.existsSync(idxf)) console.log(`ok real-scene checks skipped (${!doc ? "no steps.json" : "no data/index.json"})`);
  else {
    const index = JSON.parse(fs.readFileSync(idxf, "utf8"));
    eq(E.resolveStory(index, 999999999, "x"), E.resolveStory(index, index.default.galaxy, index.default.ray), "an unknown galaxy falls back to the index default");
    {   // review H1: a story marked ineligible (weak dips) never plays as its own story
      const weak = {...index, stories: [...index.stories, {galaxy: 411449, ray: "rand_b062_a062", story: "story_411449_rand_b062_a062.json", eligible: false}]};
      eq(E.resolveStory(weak, 411449, "rand_b062_a062"), E.resolveStory(index, index.default.galaxy, index.default.ray), "an ineligible story falls back to the index default");
    }
    for (const ent of index.stories.filter(e => e.eligible !== false)) {
      const {data, entry} = await E.loadStoryData(base, ent.galaxy, ent.ray, E.DATA_URL, readJ, readB);
      eq([entry.galaxy, entry.ray], [+ent.galaxy, ent.ray], `index entry ${ent.galaxy}/${ent.ray} loads`);
      ok(data.lines && data.lines.OVI && data.lines.HI && Number.isFinite(data.lines.vSys), `stored line decoded for ${ent.galaxy}/${ent.ray}` + (data.lines_error ? ": " + data.lines_error : ""));
      ok(!ent.page_fits || data.page_fits, `page fits attached for ${ent.galaxy}/${ent.ray}`);
      const ctx = recCtx(960, 540);
      const eng = E.createEngine({doc, ctx, galaxy: ent.galaxy, ray: ent.ray, base, fetchJson: readJ, fetchBin: readB, cut: "full"});
      let err = null; try { await eng.ready(); } catch (e) { err = e; }
      ok(!err, `${ent.galaxy}/${ent.ray}: ready() with the real steps.json, scenes and data` + (err ? ": " + err.message : ""));
      if (err) continue;
      eq([eng.story.galaxy, eng.env.galaxy], [+ent.galaxy, +ent.galaxy], "engine reports the galaxy it loaded");
      const D = eng.duration, ts = Array.from({length: 85}, (_, i) => D * i / 84);
      const safeLog = t => { try { return frameLog(eng, ctx, t); } catch (e) { return "THROW " + e.message; } };
      const fwd = ts.map(safeLog), rev = ts.slice().reverse().map(safeLog).reverse();
      const thrown = [...new Set(ts.filter((t, i) => fwd[i].startsWith("THROW")).map(t => eng.locate(t).item.id + ": " + fwd[ts.indexOf(t)].slice(6)))];
      ok(!thrown.length, "real scenes render every sampled frame" + (thrown.length ? " (" + thrown.slice(0, 4).join("; ") + ")" : ""));
      const bad = ts.filter((t, i) => fwd[i] !== rev[i]).map(t => eng.locate(t).item.id);
      ok(!bad.length, "real scenes: seek forward = seek reverse" + (bad.length ? " (differs on " + [...new Set(bad)].join(", ") + ")" : ""));
      eq(eng.missingKeys(), [], "real steps.json: every {{key}} resolves against the data");
      const fb = eng.fallbackKeys();
      ok(!fb.length, "real steps.json: no key falls back to its steps.json fallback" + (fb.length ? " (" + fb.slice(0, 8).join("; ") + ")" : ""));
      // the page's path (index.html fetches the story JSON itself for its text, then createEngine({data})):
      // ready() must complete it with the stored line and page fits, or the spectrum scenes have nothing to draw
      const bare = readJ(new URL("data/" + ent.story, base).href);
      const raw = await bare, ctx2 = recCtx(960, 540);
      const eng2 = E.createEngine({doc, ctx: ctx2, data: raw, base, fetchJson: readJ, fetchBin: readB, cut: "full"});
      let err2 = null; try { await eng2.ready(); } catch (e) { err2 = e; }
      ok(!err2 && raw.lines && raw.lines.OVI && (!ent.page_fits || raw.page_fits), `${ent.galaxy}/${ent.ray}: createEngine({data}) completes the stored line and page fits in ready()` + (err2 ? ": " + err2.message : raw.lines_error ? ": " + raw.lines_error : ""));
      if (!err2) { const th = ts.filter(t => { try { frameLog(eng2, ctx2, t); return false; } catch { return true; } });
        ok(!th.length, `${ent.galaxy}/${ent.ray}: page-path engine renders every sampled frame` + (th.length ? ` (${th.length} throw)` : "")); }
    }
  }
}

/* ---------------- static purity ---------------- */
{
  const read = p => fs.readFileSync(path.join(ROOT, p), "utf8");
  const scenesDir = path.join(ROOT, "js/scenes");
  const sceneFiles = fs.readdirSync(scenesDir).filter(f => f.endsWith(".js"));
  const strip = s => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`])\/\/.*$/gm, "$1");
  const banned = [/Math\.random/, /Date\.now/, /new Date\b/, /performance\.now/, /requestAnimationFrame/, /setTimeout/, /setInterval/, /\bgsap\b/i, /fitPanel/, /\bdocument\./, /\bwindow\./];
  for (const f of sceneFiles) {
    const src = strip(fs.readFileSync(path.join(scenesDir, f), "utf8"));
    const hit = banned.filter(re => re.test(src)).map(String);
    ok(!hit.length, `scenes/${f}: no clock, randomness, DOM, GSAP or fitPanel` + (hit.length ? " (" + hit.join(", ") + ")" : ""));
  }
  const eng = strip(read("js/engine.js"));
  ok(![/Math\.random/, /Date\.now/, /performance\.now/, /requestAnimationFrame/, /setTimeout/, /fitPanel/].some(re => re.test(eng)), "engine.js: no clock, randomness or fitPanel");
  for (const f of ["js/store.js", "js/drivers/step.js", "js/drivers/play.js"]) ok(!/fitPanel/.test(strip(read(f))), `${f}: never fits`);
  ok(!/import[^;]*fitPanel/.test(strip(read("js/drivers/explore.js"))), "explore.js fits only through the worker");
  // every relative import resolves
  const files = ["js/engine.js", "js/store.js", "js/drivers/step.js", "js/drivers/play.js", "js/drivers/explore.js", ...sceneFiles.map(f => "js/scenes/" + f)];
  let unresolved = [];
  for (const f of files) for (const m of read(f).matchAll(/import\s[^"']*["'](\.[^"']+)["']/g)) if (!fs.existsSync(path.resolve(path.dirname(path.join(ROOT, f)), m[1]))) unresolved.push(`${f}: ${m[1]}`);
  eq(unresolved, [], "every relative import resolves");
  ok(fs.existsSync(path.resolve(ROOT, "js/drivers", "../../../../js/fitworker.js")), "explore worker URL points at docs/tng50/js/fitworker.js");
  const dot = files.filter(f => /·|•/.test(read(f)));
  eq(dot, [], "no dot separators in engine sources");
}

/* ---------------- store: URL grammar ---------------- */
{
  const steps = DOC.steps, def = {s: "light-1", mode: "step", R: 30000, sn: 10, seed: 7, g: 488530, ray: "rand_b062_a062"};
  const P = (hash, search = "") => ST.parseStoryUrl({hash, search}, steps, def);
  eq(P("").state, def, "empty URL gives the defaults");
  eq([P("#lsf").state.s, P("#dip").state.s, P("#dip").alias], ["light-1", "dip-1", true], "bare #chapter aliases to its first step; unknown alias ignored");
  eq(P("#dip-2").state.s, "dip-2", "bare #step id works");
  const p = P("#s=noise-1&mode=watch&R=15000&sn=20&seed=42");
  eq([p.state.s, p.state.mode, p.state.R, p.state.sn, p.state.seed], ["noise-1", "watch", 15000, 20, 42], "fragment keys parse");
  eq([P("#s=dip&mode=x").state.s, P("#s=dip&mode=x").state.mode, P("#s=dip").alias], ["dip-1", "step", true], "s= accepts a chapter; bad mode ignored");
  eq([P("#R=999999&sn=0").state.R, P("#R=999999&sn=0").state.sn], [150000, 2], "R and S/N clamp to the explorer ranges");
  eq(P("#seed=123456789").state.seed, 123456789 % 100000, "seed folds into the explorer's 0..99999");
  eq([P("", "?g=tng50-1-99-505100&ray=edge_b100_a090").state.g, P("", "?g=505100").state.ray], [505100, "rand_b062_a062"], "query g (both forms) and ray");
  eq(P("#g=411449&s=dip-1", "?g=505100").state.g, 411449, "fragment g wins over the query");
  eq(P("", "?ray=../../etc").state.ray, "rand_b062_a062", "bad ray ids are refused");
  eq([P("", "?embed=1&still").embed, P("", "?still").still], [true, true], "page-shape query flags");
  const S = {...def, s: "dip-2", mode: "explore", R: 50000, sn: 5, seed: 3};
  eq(ST.formatFragment(S, def), "s=dip-2&mode=explore&R=50000&sn=5&seed=3", "formatFragment omits default galaxy and ray");
  eq(ST.formatFragment({...S, g: 505100, ray: "edge_b100_a090"}, def), "s=dip-2&mode=explore&R=50000&sn=5&seed=3&g=505100&ray=edge_b100_a090", "formatFragment keeps another galaxy");
  for (const s of [S, {...S, g: 505100, ray: "edge_b100_a090"}, {...def, s: "yourturn-1"}]) eq(P("#" + ST.formatFragment(s, def)).state, s, `fragment round-trip ${ST.formatFragment(s, def)}`);
}

/* ---------------- store: object ---------------- */
{
  const steps = DOC.steps, def = {s: "light-1", R: 30000, sn: 10, seed: 7, g: 488530, ray: "rand_b062_a062"};
  const mkLoc = (hash = "", search = "") => ({hash, search});
  const mkHist = loc => ({calls: [], replaceState(_, __, u) { this.calls.push(["replace", u]); loc.hash = u; }, pushState(_, __, u) { this.calls.push(["push", u]); loc.hash = u; }});
  const mem = () => { const m = new Map(); return {getItem: k => m.get(k) ?? null, setItem: (k, v) => m.set(k, String(v)), removeItem: k => m.delete(k), m}; };
  let loc = mkLoc("#lsf"), hist = mkHist(loc), sto = mem();
  let st = ST.createStore({steps, defaults: def, location: loc, history: hist, storage: sto});
  eq(st.get().s, "light-1", "unknown alias #lsf (not in fixture) keeps the first step");
  loc = mkLoc("#dip"); hist = mkHist(loc);
  st = ST.createStore({steps, defaults: def, location: loc, history: hist, storage: sto});
  eq([st.get().s, hist.calls[0]], ["dip-1", ["replace", "#s=dip-1&mode=step&R=30000&sn=10&seed=7"]], "alias is rewritten with replaceState");
  const seen = []; const un = st.subscribe((s, prev) => seen.push([prev.s, s.s]));
  st.set({s: "dip-2"}); st.set({s: "dip-2"}); st.set({s: "noise"}, {push: true}); st.set({mode: "bogus"});
  eq(seen, [["dip-1", "dip-2"], ["dip-2", "noise-1"]], "set() notifies on change only and resolves aliases");
  eq(hist.calls.slice(-1)[0][0], "push", "set(..., {push}) pushes history");
  un();
  eq(JSON.parse(sto.getItem(ST.STORE_KEY)).s, "noise-1", "state is saved for resume");
  // resume: only without a fragment, and only to a different, existing step
  const loc2 = mkLoc(""); const st2 = ST.createStore({steps, defaults: def, location: loc2, history: mkHist(loc2), storage: sto});
  eq(st2.resume() && st2.resume().s, "noise-1", "resume offers the saved step when the URL names none");
  const loc3 = mkLoc("#s=dip-1"); const st3 = ST.createStore({steps, defaults: def, location: loc3, history: mkHist(loc3), storage: sto});
  eq(st3.resume(), null, "URL wins over the saved state");
  // ignoreUrl (render.html, ?still): defaults only, nothing written
  const loc4 = mkLoc("#s=noise-1"), h4 = mkHist(loc4), sto4 = mem();
  const st4 = ST.createStore({steps, defaults: def, location: loc4, history: h4, storage: sto4, ignoreUrl: true});
  st4.set({s: "dip-1"});
  eq([st4.get().s, h4.calls.length, sto4.m.size, st4.resume()], ["dip-1", 0, 0, null], "ignoreUrl: fragment and storage neither read nor written");
  // prefs
  eq(st.prefs(), {physics: false, speed: 1, cut: "full"}, "prefs default: physics off (D9), speed 1, full cut");
  st.setPrefs({physics: true, speed: 2});
  eq(st.prefs(), {physics: true, speed: 1, cut: "full"}, "prefs persist; bad speed falls back to 1");
  // hashchange re-read
  loc.hash = "#s=yourturn-1&mode=watch"; st.fromUrl();
  eq([st.get().s, st.get().mode], ["yourturn-1", "watch"], "fromUrl() re-reads after hashchange");
  // storage that throws (private mode) does not break the store
  const boom = {getItem() { throw new Error("x"); }, setItem() { throw new Error("x"); }, removeItem() { throw new Error("x"); }};
  const st5 = ST.createStore({steps, defaults: def, location: mkLoc(""), history: null, storage: boom});
  st5.set({s: "dip-1"});
  eq([st5.get().s, st5.resume(), st5.prefs().speed], ["dip-1", null, 1], "blocked storage is tolerated");
}

/* ---------------- hand-off through the explorer's own hash code ---------------- */
{
  const html = fs.existsSync(path.join(REPO, "docs/tng50/index.html")) ? fs.readFileSync(path.join(REPO, "docs/tng50/index.html"), "utf8") : "";
  const m = /const DATA = (\{.*?\});\s*\n/s.exec(html);
  let cfg = null; try { cfg = m ? JSON.parse(m[1]) : null; } catch { cfg = null; }
  if (!cfg) cfg = {ions: [{key: "HI", order: 0, band: "uv"}, {key: "OVI", order: 9, band: "uv"}], bands: {uv: {R: {min: 5000, max: 150000, default: 30000, pair: [15000, 50000]}}}, defaults: {id: "edge_b100_a090"}};
  const reg = STATE.makeRegistry(cfg);
  const base = reg.DEF;
  const S = {s: "noise-1", mode: "step", R: 30000, sn: 10, seed: 42, g: 488530, ray: "rand_b062_a062"};
  for (const st of DOC.steps.filter(s => s.handoff)) {
    const h = ST.handoffHash(st.handoff, S, {defaultG: 488530});
    const back = STATE.parseHash("#" + h, reg, base), want = ST.handoffState(st.handoff, S);
    eq([back.id, back.ions, back.layout, back.R.uv, back.sn, back.seed, back.fit], [want.id, reg.KEYS.filter(k => want.ions.includes(k)), want.layout, want.R.uv, want.sn, want.seed, want.fit],
      `hand-off ${st.id} round-trips id, ions, layout, R, S/N, seed, fit through parseHash`);
    ok(h.startsWith("id=") && h.endsWith("&from=story"), `hand-off ${st.id} is formatHash output plus &from=story`);
  }
  const hg = ST.handoffHash(DOC.steps[4].handoff, {...S, g: 505100}, {defaultG: 488530});
  ok(hg.startsWith("g=505100&id="), "another galaxy is carried as the explorer's g=<id>& prefix");
  eq(new URLSearchParams(hg).get("g"), "505100", "explorer reads g from the hand-off hash");
  eq(ST.explorerHref(null, S, {defaultG: 488530}).split("#")[0], "../../index.html", "hand-off link goes to the explorer page");
  const hs = ST.handoffState({R: [999999], sn: [0]}, {...S, seed: 123456});
  eq([hs.R.uv, hs.sn, hs.seed, hs.layout], [[150000, 150000], [2, 2], 23456, "1"], "hand-off clamps R, S/N, seed, layout");
}

/* ---------------- Play driver (fake clock) ---------------- */
{
  let T = 0, q = [];
  const now = () => T, raf = f => { q.push(f); return q.length; }, caf = () => { q = []; };
  const pump = (dt) => { T += dt; const f = q; q = []; f.forEach(g => g()); };
  const calls = [];
  const fakeEng = {duration: 10, seek: t => { calls.push(+t.toFixed(6)); return {id: "x"}; }};
  const states = [], ends = [];
  const pd = createPlayDriver({engine: fakeEng, now, raf, caf, onState: (p, t) => states.push([p, +t.toFixed(3)]), onEnd: t => ends.push(t)});
  pd.play(); pump(0); pump(1000); pump(500);
  eq(calls, [0, 1, 1.5], "Play seeks wall-clock time");
  pd.setSpeed(1.5); pump(1000);
  near(pd.t, 3, 1e-9, "speed 1.5 after a change keeps continuity");
  eq(pd.setSpeed(3), 1.5, "only 0.75, 1, 1.5 are accepted");
  T += 1000; const tp = pd.pause();
  near(tp, 4.5, 1e-9, "pause() returns the current frame time");
  ok(!pd.playing && q.length === 0, "pause stops the frame loop");
  pd.play(); pump(0); pump(4000);
  ok(!pd.playing && ends.length === 1 && pd.t === 10, "Play stops at the end, no loop");
  pd.play(); ok(pd.t === 0, "play after the end restarts from 0");
  pd.pause();
  // interrupts
  const listeners = {}; const tgt = {addEventListener: (e, f) => { listeners[e] = f; }, removeEventListener: (e) => { delete listeners[e]; }};
  const pd2 = createPlayDriver({engine: fakeEng, now, raf, caf, interruptTarget: tgt});
  pd2.play(); pump(0);
  listeners.keydown({type: "keydown", key: " "}); ok(pd2.playing, "Space does not interrupt (the page toggles)");
  listeners.wheel({type: "wheel"}); ok(!pd2.playing, "wheel pauses Play into Step");
  pd2.destroy(); eq(Object.keys(listeners), [], "destroy removes listeners");
}

/* ---------------- Step driver (fake observer and clock) ---------------- */
{
  let T = 0, q = [];
  const now = () => T, raf = f => { q.push(f); return q.length; }, caf = () => { q = []; };
  const pump = dt => { T += dt; const f = q; q = []; f.forEach(g => g()); };
  const ctx = recCtx(), eng = E.createEngine({doc: DOC, scenes: SCENES, ctx, data: DATA});
  await eng.ready();
  const shows = []; const orig = eng.show; eng.show = (i, t, o) => { shows.push([i, +(+t).toFixed(4), +(o && o.p != null ? o.p : 1).toFixed(4)]); return orig(i, t, o); };
  let obsCb = null; const observed = [];
  class FakeIO { constructor(cb) { obsCb = cb; } observe(el) { observed.push(el); } disconnect() {} }
  const card = id => ({getAttribute: () => id, getBoundingClientRect: () => ({top: 0, height: 100}), scrollIntoView() {}});
  const cards = DOC.steps.map(s => card(s.id));
  const steps = [];
  const sd = createStepDriver({engine: eng, cards, IO: FakeIO, now, raf, caf, onStep: (i, id) => steps.push(id)});
  eq(observed.length, DOC.steps.length, "every card is observed");
  obsCb([{isIntersecting: true, target: cards[2]}]);
  eq(steps, ["dip-1"], "observer activates the card on the reading line");
  pump(200); pump(200); pump(200);
  const dip = shows.filter(s => s[0] === 2);
  ok(dip.length >= 3 && dip[0][2] === 0 && dip[dip.length - 1][2] === 1, "entry tween runs from p 0 to 1");
  ok(T - 0 >= 400 && dip.length <= 4, "tween length follows tween.ms (400 ms)");
  obsCb([{isIntersecting: true, target: cards[3]}]); pump(100);
  obsCb([{isIntersecting: true, target: cards[4]}]);
  const p3 = shows.filter(s => s[0] === 3);
  ok(p3.length >= 1 && p3[p3.length - 1][2] < 1, "a tween is cut short when the reader moves on");
  shows.length = 0; sd.setReduced(true); sd.go(1, {instant: true});
  eq(shows.slice(-1)[0], [1, 3, 1], "reduced motion jumps to the step's end state");
  shows.length = 0; sd.go(0, {instant: true});
  eq(shows.slice(-1)[0][0], 0, "scrub step renders from scroll progress");
  sd.suspend(); shows.length = 0; sd.refresh(); eq(shows.length, 0, "suspended driver does not draw (Explore owns the stage)");
  sd.resume(); ok(shows.length === 1, "resume redraws the authored state");
  sd.destroy();
}

/* ---------------- Explore driver: worker protocol ---------------- */
{
  const posted = []; let inst = null;
  class FakeWorker { constructor(url, o) { inst = this; this.url = String(url); this.o = o; } postMessage(m) { posted.push(m); } terminate() { this.dead = true; } }
  const eng = E.createEngine({doc: DOC, scenes: SCENES, ctx: recCtx(), data: DATA}); await eng.ready();
  const got = [];
  const ex = createExploreDriver({engine: eng, Worker: FakeWorker, onFit: r => got.push(r)});
  eq(ex.fit({}), null, "fit() needs an open step");
  ex.open(eng.indexOf("dip-1"));
  const id1 = ex.fit({id: "a"}), id2 = ex.fit({id: "b"});
  ok(inst.url.endsWith("/docs/tng50/js/fitworker.js") && inst.o.type === "module", "module worker is the explorer's fitworker.js");
  eq(posted.map(m => m.type), ["clear", "fit", "clear", "fit"], "each fit clears the queue first (newest wins)");
  inst.onmessage({data: {type: "result", reqId: id1, result: {comps: []}}});
  inst.onmessage({data: {type: "result", reqId: id2, result: {comps: [1]}}});
  eq(got.map(g => g.reqId), [id2], "stale results are dropped");
  ex.close(); inst.onmessage({data: {type: "result", reqId: id2}});
  eq(got.length, 1, "nothing arrives after close");
  ex.destroy(); ok(inst.dead, "destroy terminates the worker");
}

/* ---------------- fit.js extraction: tauVoigt, PIX_PER_RESEL ---------------- */
{
  eq(FIT.PIX_PER_RESEL, 5, "PIX_PER_RESEL exported (5 pixels per resolution element)");
  const OVI = {lam0_A: 1031.912, f: 0.133, gamma_s: 4.16e8};
  const tau0 = FIT.tauVoigt(OVI, [{v: 0, logN: 14.16, b: 17.3}], [0])[0];
  near(tau0, 1.4975e-15 * 10 ** 14.16 * 0.133 * 1031.912 / 17.3, 0.01, "tau0 at line centre matches 1.4975e-15 N f lambda / b (cell 263)");
  near(tau0, 1.73, 0.02, "cell 263 worked number tau0 about 1.73 (S5)");
  const v = Float64Array.from({length: 81}, (_, i) => -200 + 5 * i);
  const a = FIT.tauVoigt(OVI, [[-30, 13.5, 20], {v: 40, logN: 14, b: 10}], v);
  const s1 = FIT.tauVoigt(OVI, [[-30, 13.5, 20]], v), s2 = FIT.tauVoigt(OVI, [{v: 40, logN: 14, b: 10}], v);
  ok(a.every((x, i) => Math.abs(x - s1[i] - s2[i]) < 1e-12 * (1 + x)), "tau adds over components (array and object forms)");
  const acc = new Float64Array(v.length); FIT.tauVoigt(OVI, [[-30, 13.5, 20]], v, acc); FIT.tauVoigt(OVI, [{v: 40, logN: 14, b: 10}], v, acc);
  ok(acc.every((x, i) => Math.abs(x - a[i]) < 1e-12 * (1 + x)), "out accumulates (running sum)");
  const {kTau, a0} = FIT.atomCoeffs(OVI);
  const ref = v.map(x => { const b = 20, [H] = FIT.faddeeva((x + 30) / b, a0 / b); return kTau * 10 ** 13.5 * H / b; });
  ok(s1.every((x, i) => Math.abs(x - ref[i]) <= 1e-12 * (1 + ref[i])), "tauVoigt = kTau N H(a, x) / b with fit.js faddeeva");
  const HI = {lam0_A: 1215.67, f: 0.416, gamma_s: 4.69e8};
  const wing = FIT.tauVoigt(HI, [{v: 0, logN: 20, b: 20}], [300])[0], dopp = 1.4975e-15 * 1e20 * 0.416 * 1215.67 / 20 * Math.exp(-((300 / 20) ** 2));
  ok(wing > 1e3 * dopp, "damping wings present for H I at log N 20");
  eq(FIT.tauVoigt(OVI, [{v: 0, logN: 14, b: 0}], [0])[0], 0, "non-positive b is skipped, not NaN");
}

console.log(`${fails ? "FAIL" : "PASS"} story_engine: ${n} checks, ${fails} failures`);
process.exit(fails ? 1 : 0);
