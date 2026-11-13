// Accessibility gate of the story v2 (DESIGN_final §4 G9; §3.2 keyboard map; P2-5 live stills; P2-10 ?lite=1 smoke).
// U_qa, §5.10. Runs today against v1 (stepper) and unchanged against v2 (window.__story).
//
//   node tests/js/story_a11y.mjs                        self-test (a11y_*.json fixtures)
//   node tests/js/story_a11y.mjs --fixture F.json       evaluate one recorded run
//   TNG_BROWSER=1 node tests/js/story_a11y.mjs [docs/tng50] [--out DIR] [--edge BIN] [--no-stills]
//   TNG_BROWSER=1 node tests/js/story_a11y.mjs --lite   ?lite=1 on SwiftShader at 960x600 must reach the last beat < 10 min
//
// Browser checks (1440x900 and 390x844, prefers-reduced-motion: reduce):
//   - keyboard path: from the focused stage, PageDown (v2) / ArrowRight (v1) visits every beat/step in order and
//     reaches the last one;
//   - audit: 0 serious or critical findings. With AXE_JS=<path to axe.min.js> axe-core runs (wcag2a, wcag2aa); without
//     it a built-in subset runs: button-name, link-name, image-alt, label, aria-required-attr (sliders), aria-valid-ref,
//     aria-hidden-focus, nested-interactive, html-has-lang, document-title, meta-viewport (pinch zoom must stay, §3.2),
//     color-contrast (text on a solid CSS background only; text over the canvas is G4, story_g11.mjs);
//   - reduced motion: no CSS animation or transition longer than 0.3 s at any visited position; v2 also: a beat jump
//     lands without a tween (p takes at most two distinct values while it settles);
//   - v2 only: after every keyboard jump the landed beat shows story text on screen (#kinetic .kt-sharp or [data-band],
//     opacity >= 0.5, within 1.5 s reduced / 4 s with motion; review2_perf_a11y H1), in the reduced-motion walks and the stills runs;
//   - v2 only: the screen-reader narrative (<ol data-narrative> or #narrative) has one item per beat; the no-WebGL2 run
//     (getContext("webgl2") returns null) and the SwiftShader run land on quality "stills" and reach the last beat.
import {existsSync, readFileSync, mkdirSync} from "node:fs";
import {join, resolve, relative} from "node:path";
import {parseArgs, checker, launch, BLOCK, sleep} from "./lib/browser.mjs";
import {REPO, STORY_REL, evalA11y, selfTest, report, writeResult, plainEdge, edgeWith, gzServe, mockServer, setViewport, detect, press, SWIFTSHADER_FLAGS, storyAssets, assetQuery, RESIDENT} from "./lib/storyqa.mjs";

const {pos, opt} = parseArgs(process.argv.slice(2));
const C = checker();
if (opt.fixture) { const fx = JSON.parse(readFileSync(resolve(opt.fixture), "utf8")); if (report(C, evalA11y(fx))) C.check(true, `${fx.name || "run"}: G9 passes`); process.exit(C.finish()); }
selfTest(C, "a11y", fx => evalA11y(fx));
if (!process.env.TNG_BROWSER) { C.note("browser part skipped (set TNG_BROWSER=1)"); process.exit(C.finish()); }

const DIR = resolve(pos[0] || join(REPO, "docs/tng50")), PAGE = join(DIR, STORY_REL, "index.html"), OUT = opt.out ? resolve(opt.out) : null;
if (!existsSync(PAGE)) { C.check(process.env.STORY_REQUIRE !== "1", `no story page at ${relative(REPO, PAGE)}`); process.exit(C.finish()); }
if (OUT) mkdirSync(OUT, {recursive: true});

/* ---------------------------------------------------------------- in-page probes */
const AUDIT = `(() => { const out = [], add = (id, impact, el, help) => { const k = out.find(o => o.id === id); if (k) { k.n++; if (k.nodes.length < 4) k.nodes.push(sel(el)); } else out.push({id, impact, help, n: 1, nodes: [sel(el)]}); };
  const sel = e => e ? e.tagName.toLowerCase() + (e.id ? "#" + e.id : "") + (e.dataset && e.dataset.testid ? "[" + e.dataset.testid + "]" : "") : "";
  const shown = e => { if (!e.getClientRects().length) return false; for (let a = e; a; a = a.parentElement) { const s = getComputedStyle(a); if (s.display === "none" || s.visibility === "hidden") return false; } return true; };
  const name = e => (e.getAttribute("aria-label") || "").trim() || (e.getAttribute("aria-labelledby") || "").split(/\\s+/).map(i => document.getElementById(i)?.textContent || "").join(" ").trim()
    || (e.textContent || "").trim() || (e.getAttribute("title") || "").trim() || [...e.querySelectorAll("img[alt], svg title")].map(x => x.getAttribute("alt") || x.textContent).join(" ").trim();
  if (!document.documentElement.getAttribute("lang")) add("html-has-lang", "serious", document.documentElement, "<html> needs lang");
  if (!document.title.trim()) add("document-title", "serious", document.documentElement, "page needs a title");
  const mv = document.querySelector('meta[name="viewport"]')?.content || "";
  if (/user-scalable\\s*=\\s*(no|0)/i.test(mv) || (+((mv.match(/maximum-scale\\s*=\\s*([\\d.]+)/i) || [])[1] || 10)) < 2) add("meta-viewport", "critical", document.querySelector('meta[name="viewport"]'), "zoom must not be disabled");
  for (const e of document.querySelectorAll('button, [role=button], [role=tab], [role=menuitem]')) if (shown(e) && !name(e)) add("button-name", "critical", e, "buttons need a name");
  for (const e of document.querySelectorAll("a[href]")) if (shown(e) && !name(e)) add("link-name", "serious", e, "links need a name");
  for (const e of document.querySelectorAll("img")) if (!e.hasAttribute("alt") && e.getAttribute("role") !== "presentation" && shown(e)) add("image-alt", "critical", e, "images need alt");
  for (const e of document.querySelectorAll('input:not([type=hidden]), select, textarea')) { if (!shown(e)) continue;
    const lab = (e.id && document.querySelector('label[for="' + CSS.escape(e.id) + '"]')) || e.closest("label");
    if (!lab && !e.getAttribute("aria-label") && !e.getAttribute("aria-labelledby") && !e.getAttribute("title")) add("label", "critical", e, "form controls need a label"); }
  for (const e of document.querySelectorAll('[role=slider]')) { if (!e.hasAttribute("aria-valuenow")) add("aria-required-attr", "critical", e, "sliders need aria-valuenow");
    if (!name(e)) add("aria-input-field-name", "serious", e, "sliders need a name"); }
  for (const e of document.querySelectorAll('[aria-labelledby], [aria-describedby], [aria-controls]')) for (const a of ["aria-labelledby", "aria-describedby", "aria-controls"]) for (const i of (e.getAttribute(a) || "").split(/\\s+/).filter(Boolean)) {
    const n = document.querySelectorAll("#" + CSS.escape(i)).length; if (n !== 1) add("aria-valid-ref", "serious", e, a + " refers to " + n + " elements with id " + i); }
  const FOC = 'a[href], button:not([disabled]), input:not([disabled]), select, textarea, [tabindex]:not([tabindex="-1"])';
  for (const h of document.querySelectorAll('[aria-hidden="true"]')) for (const e of [h, ...h.querySelectorAll(FOC)]) if (e.matches(FOC) && shown(e) && !e.inert && !e.closest("[inert]")) add("aria-hidden-focus", "serious", e, "focusable inside aria-hidden");
  for (const e of document.querySelectorAll("button button, button a[href], a[href] button, a[href] a[href]")) add("nested-interactive", "serious", e, "nested interactive controls");
  /* contrast on solid CSS backgrounds only */
  const rgb = s => { const m = s.match(/rgba?\\(([^)]+)\\)/); if (!m) return null; const v = m[1].split(/[ ,/]+/).filter(Boolean).map(Number); return {r: v[0], g: v[1], b: v[2], a: v.length > 3 ? v[3] : 1}; };
  const L = c => { const f = x => { x /= 255; return x <= 0.04045 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4; }; return 0.2126 * f(c.r) + 0.7152 * f(c.g) + 0.0722 * f(c.b); };
  const w = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT); const done = new Set();
  for (let n = w.nextNode(); n; n = w.nextNode()) { const e = n.parentElement; if (!e || done.has(e) || !n.nodeValue.trim() || !shown(e)) continue; done.add(e);
    let op = 1, bg = null, unsure = false;
    for (let a = e; a; a = a.parentElement) { const s = getComputedStyle(a); op *= +s.opacity;
      if (s.backgroundImage !== "none" || (s.backdropFilter && s.backdropFilter !== "none") || a.tagName === "CANVAS") { unsure = true; break; }
      const c = rgb(s.backgroundColor); if (c && c.a >= 0.99) { bg = c; break; } if (c && c.a > 0.01) { unsure = true; break; } }
    if (unsure || !bg || op < 0.99) continue;
    if (e.closest("svg")) continue;   /* a solid opaque ancestor background is what the text is painted on */
    const fg = rgb(getComputedStyle(e).color); if (!fg || fg.a < 0.99) continue;
    const l1 = L(fg), l2 = L(bg), cr = (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05), fs = parseFloat(getComputedStyle(e).fontSize), bold = +getComputedStyle(e).fontWeight >= 700;
    const need = fs >= 24 || (bold && fs >= 18.66) ? 3 : 4.5; if (cr < need - 0.01) add("color-contrast", "serious", e, "contrast " + cr.toFixed(2) + ":1 < " + need + ":1"); }
  return out; })()`;
const ANIMS = `document.getAnimations().map(a => { const t = a.effect && a.effect.getComputedTiming ? a.effect.getComputedTiming() : {}; const it = t.iterations ?? 1;
  const ms = it === Infinity ? Infinity : (+t.duration || 0) * it + (+t.delay || 0); return {name: (a.animationName || a.transitionProperty || a.id || a.constructor.name) + " on " + (a.effect && a.effect.target ? (a.effect.target.id || a.effect.target.className || a.effect.target.tagName) : "?"), ms: it === Infinity && !(+t.duration) ? 0 : ms === Infinity ? 1e12 : ms}; })`;   // Infinity does not survive JSON: 1e12 = infinite
const STATE = kind => kind === "v2" ? `(() => { const s = __story.state(); return {id: s.beat ? s.beat.id : null, p: s.p, quality: s.quality || (typeof __story.quality === "function" ? (q => typeof q === "object" && q ? q.tier || q.name : q)(__story.quality()) : null)}; })()`
  : `({id: storyApp.getState ? storyApp.getState().step : (document.querySelector('[data-step].is-active, [data-step][aria-current="step"]') || {dataset: {}}).dataset.step, p: null, quality: null})`;
const BEATS = kind => kind === "v2" ? `(__story.beats() || []).map(b => b.id)` : `[...document.querySelectorAll("[data-step]")].map(e => e.dataset.step)`;
const FOCUS = `(() => { const e = document.querySelector('[data-testid="story-stage"], #stage, [data-stage], main') || document.body; if (!e.hasAttribute("tabindex")) e.setAttribute("tabindex", "-1"); e.focus({preventScroll: true}); return document.activeElement === e; })()`;
// review2_perf_a11y H1: after a discrete jump the beat's narration must be on screen (not only in the aria-live region).
// Visible story text = the kinetic band's sharp layer (#kinetic .kt-sharp) or any [data-band] element, at effective opacity
// >= 0.5, inside the viewport, not hidden; chrome, dock and labels do not count.
const JUMPTEXT = `(() => { const vis = e => { const r = e.getBoundingClientRect(); if (r.width < 2 || r.height < 2 || r.bottom <= 0 || r.right <= 0 || r.top >= innerHeight || r.left >= innerWidth) return false;
    let op = 1; for (let a = e; a; a = a.parentElement) { const s = getComputedStyle(a); if (s.display === "none" || s.visibility === "hidden") return false; op *= +s.opacity; } return op >= 0.5; };
  const els = [...document.querySelectorAll("#kinetic .kt-sharp, [data-band]")].filter(e => !e.closest("[data-chrome], #dock, #hud, #rail") && (e.textContent || "").trim() && vis(e));
  return els.filter(e => !els.some(o => o !== e && o.contains(e))).map(e => e.textContent.replace(/\\s+/g, " ").trim()).join(" | ").slice(0, 160); })()`;
const KILL_WEBGL = `(() => { const g = HTMLCanvasElement.prototype.getContext; HTMLCanvasElement.prototype.getContext = function (t, ...a) { return /webgl/i.test(t) ? null : g.call(this, t, ...a); };
  if (window.OffscreenCanvas) { const o = OffscreenCanvas.prototype.getContext; OffscreenCanvas.prototype.getContext = function (t, ...a) { return /webgl/i.test(t) ? null : o.call(this, t, ...a); }; } })();`;

/** Walks the story by keyboard from the start; returns {beats, path, anims, tween}. */
async function keyWalk(P, kind, {reduced = true, collect = true} = {}) {
  const beats = await P.eval(BEATS(kind)), last = beats[beats.length - 1], path = [], anims = [];
  await P.eval(FOCUS);
  const first = (await P.eval(STATE(kind))).id; if (first) path.push(first);   // v1 starts on its title (no step yet)
  const key = kind === "v2" ? "PageDown" : "ArrowRight";
  let tween = null; const jumpText = [];
  for (let k = 0; k < beats.length * 2 && path[path.length - 1] !== last; k++) {
    const before = await P.eval(STATE(kind));
    await press(P, key);
    if (kind === "v2" && reduced) { const ps = await P.eval(`new Promise(r => { const out = []; const t0 = performance.now(); const f = () => { out.push(+__story.state().p.toFixed(6)); if (performance.now() - t0 < 400) requestAnimationFrame(f); else r(out); }; f(); })`);
      const d = [...new Set(ps)]; if (d.length > 2 && !tween) tween = `${before.id}: p took ${d.length} values in 400 ms`; }
    await P.waitFor(`(${STATE(kind)}).id !== ${JSON.stringify(before.id)}`, kind === "v2" ? 4000 : 6000, 50);
    await sleep(reduced ? 150 : 700);
    if (collect) anims.push(...(await P.eval(ANIMS)));
    const now = (await P.eval(STATE(kind))).id; if (now !== path[path.length - 1]) path.push(now);
    if (kind === "v2" && now !== before.id) {   // allow the fade-in (1.5 s reduced; 4 s with motion, where the clock springs to the target)
      if (!reduced) { let q0 = null; for (let i = 0; i < 16; i++) { const q = (await P.eval(STATE(kind))).p; if (q === q0) break; q0 = q; await sleep(600); } }   // with motion: let the clock settle first (slow CPU pages update p in steps)
      await P.waitFor(`!!${JUMPTEXT}`, reduced ? 1500 : 4000, 100); const jt = {id: now, p: +(await P.eval(STATE(kind))).p.toFixed(4), text: await P.eval(JUMPTEXT)}; jumpText.push(jt);
      if (!jt.text && opt.shots) { const {screenshot} = await import("./lib/storyqa.mjs"); const {writeFileSync} = await import("node:fs"); mkdirSync(resolve(opt.shots), {recursive: true});
        const vp = await P.eval("innerWidth + 'x' + innerHeight"); writeFileSync(join(resolve(opt.shots), `jump_notext_${vp}_${reduced ? "rm" : "motion"}_${now}.png`), await screenshot(P)); } }
    if (now === before.id) { await P.eval(FOCUS); }   // a control stole focus: refocus the stage and try again
  }
  return {beats, path, anims, tween, jumpText};
}

/* browser self-test: the audit, the animation probe and the keyboard walk on the mock story */
async function auditRun(P, url, w, h) {
  await P.send("Emulation.setEmulatedMedia", {features: [{name: "prefers-reduced-motion", value: "reduce"}]});
  await setViewport(P, {w, h, zoom: 1}); await P.goto(url);
  const kind = await detect(P, 120000); if (!kind) return {kind};
  await sleep(800);
  const rm = await P.eval(`matchMedia("(prefers-reduced-motion: reduce)").matches`);
  let violations;
  if (process.env.AXE_JS && existsSync(process.env.AXE_JS)) {
    await P.eval(readFileSync(process.env.AXE_JS, "utf8") + ";0");
    violations = await P.eval(`axe.run(document, {runOnly: {type: "tag", values: ["wcag2a", "wcag2aa"]}}).then(r => r.violations.map(v => ({id: v.id, impact: v.impact, n: v.nodes.length, help: v.help})))`, 120000);
  } else violations = await P.eval(AUDIT);
  const anims0 = await P.eval(ANIMS);
  /* review3 perf_a11y M5 (fix3): the "Read as text" overlay is a modal; 40 Tabs (and 10 Shift+Tabs) from its close button
     never leave #text-overlay, and Escape returns focus to the page */
  let trap = null;
  if (kind === "v2" && await P.eval(`!!(document.getElementById("text-overlay") && document.getElementById("skip-text"))`)) {
    await P.eval(`document.getElementById("skip-text").click()`); await sleep(300);
    const where = `(() => { const a = document.activeElement, o = document.getElementById("text-overlay"); return a && o && o.contains(a) ? "in" : (a ? a.tagName + (a.id ? "#" + a.id : "") : "none"); })()`;
    const out = [];
    for (let i = 0; i < 40; i++) { await press(P, "Tab"); const w0 = await P.eval(where); if (w0 !== "in") out.push(`Tab ${i + 1}: ${w0}`); }
    for (let i = 0; i < 10; i++) { await press(P, "Tab", 8); const w0 = await P.eval(where); if (w0 !== "in") out.push(`Shift+Tab ${i + 1}: ${w0}`); }
    const inert = await P.eval(`!!document.getElementById("stage").inert`);
    await press(P, "Escape"); await sleep(200);
    const after = await P.eval(`({open: document.getElementById("text-overlay").hasAttribute("data-open"), inert: !!document.getElementById("stage").inert})`);
    trap = {escaped: out, inert, closed: !after.open && !after.inert};
  }
  const walk = await keyWalk(P, kind, {reduced: rm});
  const narrative = kind === "v2" ? {items: await P.eval(`document.querySelectorAll("ol[data-narrative] > li, #narrative li").length`), beats: walk.beats.length} : null;
  if (trap) C.check(!trap.escaped.length && trap.inert && trap.closed, `${w}x${h}: text overlay keeps focus (40 Tab + 10 Shift+Tab inside, stage inert while open, Escape closes and un-inerts)${trap.escaped.length ? ": left on " + trap.escaped.slice(0, 5).join(", ") : ""}${trap.inert ? "" : "; stage not inert"}${trap.closed ? "" : "; still open/inert after Escape"}`);
  return {kind, walk, run: {name: `${w}x${h} ${kind}`, beats: walk.beats, keyPath: walk.path, violations, reduced: rm, animations: [...anims0, ...walk.anims], tween: walk.tween, narrative, jumpText: walk.jumpText}};
}
if (!opt["no-selftest"] && !opt.lite) {
  const ms = await mockServer(), P = await launch({edge: opt.edge || plainEdge(), block: BLOCK, reducedMotion: true});
  try {
    const a = await auditRun(P, ms.clean, 1440, 900), ra = a.run ? evalA11y(a.run) : {fails: [{gate: "G9", msg: "not ready"}]};
    C.check(a.kind === "v2" && !ra.fails.length, `browser self-test: mock_story.html passes G9${ra.fails.length ? ": " + ra.fails.map(x => x.msg).join("; ") : ""}`);
    const b = await auditRun(P, ms.defect, 1440, 900), rb = b.run ? evalA11y(b.run) : {fails: []}, txt = rb.fails.map(x => x.msg).join(" | ");
    const want = [["unnamed button", /button-name/], ["2 s infinite animation", /reduced motion: animation/], ["short narrative", /narrative/], ["no text after a jump", /no story text on screen/]], miss = want.filter(([, re]) => !re.test(txt)).map(([n]) => n);
    C.check(b.kind === "v2" && !miss.length, `browser self-test: mock_story.html?defect=1 fails G9 on the unnamed button, the animation, the narrative and the jump text${miss.length ? " (missed " + miss.join(", ") + ")" : ""}`);
  } finally { await P.close(); await ms.close(); }
}

const AS = opt.lite ? storyAssets(opt) : {viz: null, three: null};   // --lite runs the 3D mobile tier: it needs the cubes and three
const srv = await gzServe(DIR, AS), AQ = assetQuery(srv, AS), URL0 = srv.base + STORY_REL + "/index.html";
const results = [];
try {
  if (opt.lite) {
    /* ?lite=1 smoke on SwiftShader at 960x600 (P2-10) */
    const P = await launch({edge: opt.edge || edgeWith(plainEdge(), SWIFTSHADER_FLAGS), block: BLOCK, reducedMotion: false, width: 960, height: 600});
    try {
      await setViewport(P, {w: 960, h: 600, zoom: 1, mobile: false});
      const t0 = Date.now(); await P.goto(URL0 + "?lite=1" + (AQ ? "&" + AQ : ""));
      C.note(`--lite assets: cubes ${AS.viz || "page default"}; three ${AS.three || "page default (CDN)"}`);
      const kind = await detect(P, 180000);
      if (kind !== "v2") C.note(`--lite: page is ${kind || "not ready"}; the lite smoke is a v2 check`);
      else {
        const beats = await P.eval(BEATS(kind)), last = beats[beats.length - 1];
        // beat by beat: target each beat's midpoint, wait until the page is in that beat and the stage has drawn at least one
        // new frame there (so every beat is rendered in the 3D tier, not skipped by a fast scrub); then the end (p = 1)
        const bl = await P.eval(`__story.beats().map(b => ({id: b.id, p: (b.p0 + b.p1) / 2}))`);
        const STG = `(() => { const st = window.__story.stage, s = st && st.stats; return s ? {frames: s.frames, q: s.quality || null} : null; })()`;
        const seen = {q: new Set(), levels: 0, loads: 0, beats: new Set(), drawn: new Set(), frames: 0};
        let w = -1;
        const ws = await P.waitFor(`!!(window.__story.stage && window.__story.stage.stats && window.__story.stage.stats.frames > 0)`, 180000, 250);   // the stage attaches async
        C.note(`?lite=1: stage ${ws >= 0 ? "drawing" : "not drawing"} ${((Date.now() - t0) / 1000).toFixed(1)} s after navigation`);
        for (const b of [...bl, {id: last, p: 1}]) {
          if (Date.now() - t0 > 600000) break;
          const f0 = (await P.eval(STG)) || {frames: 0};
          await P.eval(`__story.setTarget(${b.p})`);
          const tb = Date.now();
          while (Date.now() - tb < 40000 && Date.now() - t0 < 600000) {
            const st = await P.eval(STG), id = (await P.eval(STATE(kind))).id;
            if (id === b.id && st && st.frames !== f0.frames) { seen.drawn.add(b.id); if (st.q) seen.q.add(st.q); break; }
            if (id === b.id && !st) break;
            await sleep(250);
          }
          const r = await P.eval(RESIDENT), id = (await P.eval(STATE(kind))).id; seen.beats.add(id);
          seen.levels = Math.max(seen.levels, r.levels); seen.loads = Math.max(seen.loads, r.loads);
          if (b.p === 1 && id === last) w = Date.now() - t0;
        }
        seen.frames = ((await P.eval(STG)) || {frames: 0}).frames;
        const mins = ((Date.now() - t0) / 60000).toFixed(1);
        C.check(w >= 0, `?lite=1 on SwiftShader 960x600 reaches ${last} in ${mins} min (< 10 min)`);
        const und = bl.map(b => b.id).filter(id => !seen.drawn.has(id));
        C.check(!und.length, `?lite=1 draws a 3D frame in every beat (${seen.drawn.size} of ${bl.length}${und.length ? "; not drawn: " + und.join(", ") : ""})`);
        C.check(seen.q.size > 0 && [...seen.q].every(q => q === "mobile"), `?lite=1 renders on the stage's mobile tier (stage quality seen: ${[...seen.q].join(", ") || "none"})`);
        C.check(seen.levels > 0, `?lite=1 has cube data bound during the flight (${seen.loads} loads, up to ${seen.levels} levels)`);
        C.note(`?lite=1 stage frames at the end: ${seen.frames}`);
        if (opt.shots) { const {screenshot} = await import("./lib/storyqa.mjs"); const {writeFileSync} = await import("node:fs"); mkdirSync(resolve(opt.shots), {recursive: true});
          writeFileSync(join(resolve(opt.shots), "lite_end_960x600.png"), await screenshot(P)); }
        results.push({name: "lite", reached: w >= 0, ms: w, quality: [...seen.q], resident: {loads: seen.loads, levels: seen.levels}, drawn: [...seen.drawn], beats: bl.length});
      }
    } finally { await P.close(); }
  } else {
    for (const [w, h] of [[1440, 900], [390, 844]]) {
      const P = await launch({edge: opt.edge || plainEdge(), block: BLOCK, reducedMotion: true, width: w, height: h});
      try {
        const A = await auditRun(P, URL0, w, h), kind = A.kind;
        if (!C.check(!!kind, `${w}x${h}: story ready (${kind || "none"})`)) continue;
        const {walk, run} = A, violations = run.violations, rm = run.reduced;
        if (process.env.AXE_JS) C.note("audit: axe-core (AXE_JS)");
        if (kind === "v1") C.note(`v1: narrative = ${await P.eval(`document.querySelectorAll("[data-step] h3").length`)} step headings (the v2 <ol data-narrative> check applies to v2)`);
        for (const v of violations.filter(v => v.impact !== "serious" && v.impact !== "critical")) C.note(`a11y ${v.impact}: ${v.id} (${v.n})`);
        for (const v of violations.filter(v => v.impact === "serious" || v.impact === "critical")) C.note(`  ${v.id}: ${(v.nodes || []).join(", ")} ${v.help || ""}`);
        C.note(`${w}x${h}: keyboard visited ${walk.path.length} of ${walk.beats.length}; ${walk.anims.length} animation samples; reduced motion ${rm}`);
        if (report(C, evalA11y(run))) C.check(true, `${run.name}: G9 passes`);
        results.push(run);
      } finally { await P.close(); }
    }
    /* stills paths (v2): no WebGL2, SwiftShader */
    if (!opt["no-stills"]) for (const [nm, inject, flags] of [["no-webgl2", [KILL_WEBGL], []], ["swiftshader", [], SWIFTSHADER_FLAGS]]) {
      const P = await launch({edge: opt.edge || edgeWith(plainEdge(), flags), block: BLOCK, inject, reducedMotion: false});
      try {
        await setViewport(P, {w: 1440, h: 900, zoom: 1, mobile: false});
        await P.goto(URL0);
        const kind = await detect(P, 120000);
        if (kind !== "v2") { C.note(`${nm}: page is ${kind || "not ready"}; the stills path is a v2 check (v1 has no WebGL)`); continue; }
        const q = (await P.eval(STATE(kind))).quality;
        const walk = await keyWalk(P, kind, {reduced: false, collect: false});
        const run = {name: nm, jumpText: walk.jumpText, stillsRuns: [{name: nm, quality: q, reachedEnd: walk.path[walk.path.length - 1] === walk.beats[walk.beats.length - 1]}]};
        if (report(C, evalA11y(run))) C.check(true, `${nm}: lands on stills and reaches ${walk.beats[walk.beats.length - 1]}`);
        results.push(run);
      } finally { await P.close(); }
    }
  }
} finally { await srv.close(); }
const f = writeResult(OUT, opt.lite ? "a11y_lite.json" : "a11y.json", results); if (f) C.note(`results ${relative(REPO, f)}`);
process.exit(C.finish());
