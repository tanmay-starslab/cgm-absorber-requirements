// Browser smoke gate of the "How a spectrum is made" story (PLAN_final §6 story_smoke, §2.4, §7; critique_ux checks).
// Usage: TNG_BROWSER=1 node tests/js/story_smoke.mjs [docs/tng50 dir] [--story learn/how-a-spectrum-is-made]
//            [--port N] [--profile DIR] [--edge BIN] [--shots DIR]
// Without TNG_BROWSER=1 it prints "skipped"; with it and no story page it prints "skipped" too (STORY_REQUIRE=1 fails).
// The story runs without WebGL, so when TNG_EDGE is the reduced-motion wrapper (".../headless-rm") the plain sibling
// (".../headless") is used and motion is set per run through CDP media emulation (checked in-page).
//
// Page contract the test relies on (U1 engine, U4 page; stated in notes/story/U_U6_tests.md):
//   ready      window.storyApp.ready === true, else an element [data-step][aria-current="step"] exists
//   state      window.storyApp.getState() -> {step, mode: "step"|"watch"|"explore", playing, galaxy?}; without the
//              bridge: step from [data-step][aria-current="step"], playing from Play's aria-pressed, mode from
//              <html data-mode>
//   DOM        one h1; one h2 per chapter; every step is an element [data-step="<id>"] holding an h3; deep link #s=<id>
//   test ids   story-stage (focusable stage), story-play, story-physics, story-fullscreen, story-skip, story-progress
//              (390 px), story-rail (desktop), story-text (display line in a step), story-tryit (in a card),
//              story-back, story-open-spectra; the U4 page shell's ids and hooks are accepted in their place: #stage,
//              #play, #physics, #fullscreen, #to-explorer, #progress-txt, #rail, the step's h3, [data-try], [data-back],
//              a[data-handoff]; active step [data-step].is-active; mode <body data-mode>
// Checks, at 390 x 844 (mobile, touch) and 1440 x 900, dark and light:
//   - ready, then every step of steps.json reached in order with ArrowRight from the focused stage; each step has its
//     [data-step] element and an h3; no horizontal scroll; at most 1 live-region announcement per step change; no
//     visible text or control of the fixed/sticky chrome or the active card overlaps another (not nested) on any settled
//     step (e.g. the dock over a card's buttons; content scrolling under fixed chrome is not counted);
//   - one h1 and one h2 per chapter (12 for the full story); display line >= 28 px at 390 px, card paragraphs >= 16 px;
//   - 390 px: stage sticky, 58 % of the viewport height (svh), progress line shown and rail hidden, Play and Physics
//     >= 44 x 44 px; 1440 px: Skip to the explorer link shown;
//   - no dot separator in the rendered text; no uncaught exception or console error.
// Once at 1440 dark: deep link #s=<id> and the #lsf alias (rewritten to #s=lsf-1); Home, End, PageDown, PageUp; a
// number key changes nothing; Space with focus on the page body does not start Play; Space on Play starts it, during
// Play 0 step announcements (only the Play/Pause state) and focus does not move; k pauses; the Play label names its
// length ("Play 3 min"); Try it on the first step with controls opens <= 2 sliders, each with aria-valuetext in words
// (a word of 4+ letters; "14.15 cm⁻²" is not enough)
// (>= 44 px tall at 390 px), "exploring" mode, Esc returns to the step.
// Reduced motion (1440 light): every step's DOM text equals the normal run's.
import {readFileSync, existsSync} from "node:fs";
import {join, resolve, relative} from "node:path";
import {ROOT as REPO, parseArgs, checker, serve, launch, BLOCK, sepHits, sleep} from "./lib/browser.mjs";

if (!process.env.TNG_BROWSER) { console.log("skipped (set TNG_BROWSER=1 to run the story smoke test)"); process.exit(0); }
const {pos, opt} = parseArgs(process.argv.slice(2));
const DIR = resolve(pos[0] || join(REPO, "docs/tng50"));
const STORY = opt.story || "learn/how-a-spectrum-is-made";
const SROOT = resolve(DIR, STORY), PAGE = join(SROOT, "index.html"), STEPS_F = join(SROOT, "steps.json");
if (!existsSync(PAGE) || !existsSync(STEPS_F)) {
  if (process.env.STORY_REQUIRE === "1") { console.log(`FAIL no story page at ${PAGE} (STORY_REQUIRE=1)`); process.exit(1); }
  console.log(`skipped (no story page or steps.json under ${relative(REPO, SROOT)})`); process.exit(0);
}
const raw = JSON.parse(readFileSync(STEPS_F, "utf8")), STEPS = Array.isArray(raw) ? raw : raw.steps || [];
const IDS = STEPS.map(s => s.id), CHAPTERS = [...new Set(STEPS.map(s => s.chapter))];
const C = checker(), check = C.check, note = C.note;
const SHOTS = opt.shots && resolve(opt.shots);
let edge = opt.edge;
if (!edge && process.env.TNG_EDGE && /headless-rm$/.test(process.env.TNG_EDGE) && existsSync(process.env.TNG_EDGE.replace(/-rm$/, ""))) edge = process.env.TNG_EDGE.replace(/-rm$/, "");

/* live-region recorder, installed before any page script: one announcement = changes in one region within 60 ms */
const LIVE = `(() => { if (window.__live) return; const L = window.__live = {n: 0, log: []};
  const SEL = '[aria-live]:not([aria-live="off"]), [role="status"], [role="alert"], [role="log"]';
  const mo = new MutationObserver(ms => { for (const m of ms) { const t = m.target.nodeType === 3 ? m.target.parentElement : m.target;
    const r = t && t.closest && t.closest(SEL); if (!r) continue; const txt = (r.textContent || "").trim(); if (!txt) continue;
    const k = performance.now(), id = r.id || r.getAttribute("data-testid") || r.tagName, prev = L.log[L.log.length - 1];
    if (prev && prev.id === id && k - prev.t < 60) { prev.text = txt.slice(0, 80); continue; }
    L.n++; L.log.push({t: k, id, text: txt.slice(0, 80)}); } });
  const go = () => mo.observe(document.documentElement, {subtree: true, childList: true, characterData: true});
  if (document.documentElement) go(); else document.addEventListener("DOMContentLoaded", go); })();`;
const SREADY = `(window.storyApp ? storyApp.ready === true : !!document.querySelector('[data-step][aria-current="step"], [data-step].is-active'))`;
const SSTATE = `(() => { const s = (window.storyApp && storyApp.getState && storyApp.getState()) || {}, a = document.querySelector('[data-step][aria-current="step"], [data-step].is-active'),
  pb = document.querySelector('[data-testid="story-play"], #play');
  return {step: s.step ?? (a && a.dataset.step) ?? null, mode: s.mode ?? document.body.dataset.mode ?? document.documentElement.dataset.mode ?? "step",
    playing: !!(s.playing ?? (pb && pb.getAttribute("aria-pressed") === "true"))}; })()`;
const HELP = `window.__s = {
  vis: e => !!e && e.getClientRects().length > 0 && getComputedStyle(e).visibility !== "hidden" && +getComputedStyle(e).opacity > 0.01,
  rect: e => { if (typeof e === "string") e = document.querySelector(e); if (!e) return null; const r = e.getBoundingClientRect(); return {x: r.left, y: r.top, w: r.width, h: r.height}; },
  ALT: {"story-stage": "#stage", "story-play": "#play", "story-physics": "#physics", "story-fullscreen": "#fullscreen", "story-skip": "#to-explorer",
    "story-progress": "#progress-txt", "story-rail": "#rail", "story-tryit": "[data-try]", "story-back": "[data-back]", "story-open-spectra": "a[data-handoff]"},
  sel: t => '[data-testid="' + t + '"]' + (__s.ALT[t] ? ", " + __s.ALT[t] : ""),
  tid: t => [...document.querySelectorAll(__s.sel(t))].find(e => __s.vis(e)) || null,
  stage: () => document.querySelector(__s.sel("story-stage")) || document.querySelector("main") || document.body,
  focusStage: () => { const e = __s.stage(); if (!e.hasAttribute("tabindex") && !/^(A|BUTTON|INPUT)$/.test(e.tagName)) e.setAttribute("tabindex", "-1"); e.focus({preventScroll: true}); return document.activeElement === e; },
  card: id => document.querySelector('[data-step="' + id + '"]'),
  text: id => { const c = __s.card(id); return c ? (c.textContent || "").replace(/\\s+/g, " ").trim() : null; },
  /* visible text and controls in the viewport that overlap (not nested in each other), among the fixed or sticky
     chrome and the active step's card: the dock over a card's buttons, a strip label over the progress text (content
     scrolling under fixed chrome is not counted) */
  overlaps: () => {
    const own = e => [...e.childNodes].some(n => n.nodeType === 3 && n.textContent.trim());
    const els = [...document.querySelectorAll("button, a[href], input, select, label, output, h1, h2, h3, p, span, dt, dd, li, figcaption")]
      .filter(e => __s.vis(e) && (own(e) || /^(BUTTON|A|INPUT|SELECT)$/.test(e.tagName)) && !e.closest('[aria-hidden="true"] canvas'))
      .map(e => ({e, r: e.getBoundingClientRect(), fx: (() => { for (let a = e; a && a !== document.documentElement; a = a.parentElement) { const p = getComputedStyle(a).position; if (p === "fixed" || p === "sticky") return true; } return false; })(),
        act: !!e.closest('[data-step][aria-current="step"], [data-step].is-active')})).filter(({fx, act}) => fx || act).filter(({r}) => r.width > 2 && r.height > 2 && r.bottom > 0 && r.right > 0 && r.top < innerHeight && r.left < innerWidth);
    const name = e => (e.id ? "#" + e.id : e.tagName.toLowerCase() + (e.className && typeof e.className === "string" ? "." + e.className.trim().split(/\s+/)[0] : "")) + ' "' + (e.textContent || e.value || "").trim().slice(0, 18) + '"';
    const out = [];
    for (let i = 0; i < els.length; i++) for (let j = i + 1; j < els.length; j++) {
      const A = els[i], B = els[j]; if (A.e.contains(B.e) || B.e.contains(A.e)) continue;
      const w = Math.min(A.r.right, B.r.right) - Math.max(A.r.left, B.r.left), h = Math.min(A.r.bottom, B.r.bottom) - Math.max(A.r.top, B.r.top);
      if (w > 3 && h > 3) out.push(name(A.e) + " x " + name(B.e));
    }
    return out;
  },
  minPx: id => { const c = __s.card(id); if (!c) return null; let m = Infinity; for (const p of c.querySelectorAll("p")) if (__s.vis(p) && p.textContent.trim()) m = Math.min(m, parseFloat(getComputedStyle(p).fontSize)); return m === Infinity ? null : m; },
};`;
const state = P => P.eval(SSTATE);
const live = P => P.eval("window.__live ? __live.n : 0");
async function setMotion(P, dark, reduce) {
  await P.send("Emulation.setEmulatedMedia", {features: [{name: "prefers-color-scheme", value: dark ? "dark" : "light"}, {name: "prefers-reduced-motion", value: reduce ? "reduce" : "no-preference"}]});
}
async function openStory(P, url, tag) {
  await P.goto(url);
  const t = await P.waitFor(SREADY, 60000, 100);
  if (!check(t >= 0, `${tag}: story ready in ${(t / 1000).toFixed(2)} s`)) return false;
  // the canvas engine must boot (a text-only fallback passed this test once while every scene was dark)
  const eng = await P.eval(`(() => { const s = document.querySelector('#stage, [data-testid="story-stage"]'); return s ? s.dataset.engine || "off" : "none"; })()`);
  check(eng === "on", `${tag}: canvas engine booted (stage data-engine = ${eng})`);
  await P.eval(HELP); return true;
}
/** walk all steps with ArrowRight from the focused stage; returns {texts, ok} */
async function walk(P, tag, {mobile = false, perStep = null} = {}) {
  const texts = {}, miss = [], noH3 = [], hs = [], liveBad = [], small = [], overl = new Set();
  let s = await state(P);
  if (s.step !== IDS[0]) { await P.eval(`location.hash = "#s=${IDS[0]}"`); await P.waitFor(`(${SSTATE}).step === ${JSON.stringify(IDS[0])}`, 5000, 50); s = await state(P); }
  check(s.step === IDS[0], `${tag}: story starts on the first step (${s.step})`);
  for (let k = 0; k < IDS.length; k++) {
    const id = IDS[k];
    if (k > 0) {
      const n0 = await live(P);
      await P.eval("__s.focusStage()"); await P.key("ArrowRight");
      const t = await P.waitFor(`(${SSTATE}).step === ${JSON.stringify(id)}`, 6000, 50);
      if (t < 0) { miss.push(`${id} (at ${(await state(P)).step})`); await P.eval(`location.hash = "#s=${id}"`); await P.waitFor(`(${SSTATE}).step === ${JSON.stringify(id)}`, 4000, 50); }
      await sleep(700);   // the <= 600 ms enter tween ends
      const dn = (await live(P)) - n0; if (dn > 1) liveBad.push(`${id} (${dn}: ${JSON.stringify(await P.eval(`__live.log.slice(-${dn}).map(x => x.text)`))})`);
    } else await sleep(300);
    const m = await P.eval(`(() => { const c = __s.card(${JSON.stringify(id)}), d = c && ([...c.querySelectorAll('[data-testid="story-text"]')].find(__s.vis) || [...c.querySelectorAll("h3")].find(__s.vis));
      return {card: !!c, h3: !!(c && c.querySelector("h3")), text: __s.text(${JSON.stringify(id)}), sw: document.documentElement.scrollWidth, iw: innerWidth,
        disp: d ? parseFloat(getComputedStyle(d).fontSize) : null, pmin: __s.minPx(${JSON.stringify(id)}), ov: __s.overlaps()}; })()`);
    for (const o of m.ov) overl.add(o);
    if (!m.card) noH3.push(`${id} (no element)`); else if (!m.h3) noH3.push(id);
    if (m.sw > m.iw) hs.push(`${id} (${m.sw} > ${m.iw})`);
    if (mobile && m.disp !== null && m.disp < 28) small.push(`${id} display ${m.disp} px`);
    if (m.pmin !== null && m.pmin < 16) small.push(`${id} paragraph ${m.pmin} px`);
    texts[id] = m.text;
    if (perStep) await perStep(id, k);
  }
  check(!miss.length, `${tag}: ArrowRight reaches every step in order (${IDS.length})${miss.length ? "; missed " + miss.slice(0, 4).join(", ") : ""}`);
  check(!noH3.length, `${tag}: every step is a [data-step] element with an h3${noH3.length ? ": " + noH3.slice(0, 5).join(", ") : ""}`);
  check(!hs.length, `${tag}: no horizontal scroll on any step${hs.length ? ": " + hs.slice(0, 3).join(", ") : ""}`);
  check(!liveBad.length, `${tag}: at most 1 live announcement per step change${liveBad.length ? ": " + liveBad.slice(0, 3).join("; ") : ""}`);
  check(!overl.size, `${tag}: no visible text or control overlaps another on any settled step${overl.size ? ` (${overl.size}): ` + [...overl].slice(0, 4).join("; ") : ""}`);
  check(!small.length, `${tag}: display line >= 28 px${mobile ? "" : " (390 px only)"} and card text >= 16 px${small.length ? ": " + small.slice(0, 4).join(", ") : ""}`);
  return texts;
}

const srv = await serve({dir: DIR, page: join(DIR, "index.html"), port: opt.port});
const URL0 = srv.base + STORY + "/index.html";
let normalTexts = null;
const sessions = [];
try {
  console.log(`serving ${relative(REPO, DIR)} at ${srv.base}; ${STEPS.length} steps in ${CHAPTERS.length} chapters`);
  /* ---------------------------------------------------------------- normal motion, 4 views */
  const P = await launch({profile: opt.profile, edge, block: BLOCK, inject: [LIVE], reducedMotion: false}); sessions.push(P);
  console.log(`browser ${P.browser}`);
  for (const [w, h, mobile] of [[390, 844, true], [1440, 900, false]]) for (const dark of [true, false]) {
    const tag = `${w}x${h} ${dark ? "dark" : "light"}`;
    await P.viewport(w, h, mobile); await setMotion(P, dark, false);
    if (!await openStory(P, URL0 + "#s=" + IDS[0], tag)) continue;
    const mm = await P.eval(`({dark: matchMedia("(prefers-color-scheme: dark)").matches, rm: matchMedia("(prefers-reduced-motion: reduce)").matches, iw: innerWidth, ih: innerHeight})`);
    check(mm.dark === dark && !mm.rm && mm.iw === w && mm.ih === h, `${tag}: viewport, scheme and full motion measured in-page (${mm.iw}x${mm.ih}, dark ${mm.dark}, reduced ${mm.rm})`);
    const hd = await P.eval(`({h1: document.querySelectorAll("h1").length, h2: document.querySelectorAll("h2").length})`);
    check(hd.h1 === 1 && hd.h2 === CHAPTERS.length, `${tag}: one h1 and one h2 per chapter (h1 ${hd.h1}, h2 ${hd.h2}, chapters ${CHAPTERS.length})`);
    if (CHAPTERS.length !== 12) note(`steps.json has ${CHAPTERS.length} chapters; the full story has 12 h2`);
    const ch = await P.eval(`(() => { const st = __s.stage(), cs = getComputedStyle(st), r = __s.rect(st), pl = __s.tid("story-play"), ph = __s.tid("story-physics");
      return {pos: cs.position, sh: r ? r.h : 0, prog: !!__s.tid("story-progress"), rail: !!__s.tid("story-rail"), skip: !!__s.tid("story-skip"),
        play: pl && __s.rect(pl), phys: ph && __s.rect(ph), fs: !!document.querySelector(__s.sel("story-fullscreen"))}; })()`);
    check(!!ch.play, `${tag}: Play button shown`);
    check(ch.fs, `${tag}: fullscreen button present`);
    if (mobile) {
      check(ch.pos === "sticky" && Math.abs(ch.sh - 0.58 * h) <= 0.02 * h, `${tag}: stage sticky at 58 % of the height (${ch.pos}, ${ch.sh.toFixed(0)} px, want ${(0.58 * h).toFixed(0)})`);
      check(ch.prog && !ch.rail, `${tag}: progress line in place of the chapter rail (progress ${ch.prog}, rail ${ch.rail})`);
      const big = r => r && r.w >= 44 && r.h >= 44;
      check(big(ch.play) && big(ch.phys), `${tag}: Play and Physics >= 44 x 44 px (${ch.play ? ch.play.w.toFixed(0) + "x" + ch.play.h.toFixed(0) : "none"}, ${ch.phys ? ch.phys.w.toFixed(0) + "x" + ch.phys.h.toFixed(0) : "none"})`);
    } else {
      check(ch.skip, `${tag}: "Skip to the explorer" link shown`);
      if (!ch.rail) note(`${tag}: no visible story-rail`);
    }
    const shotAt = SHOTS ? new Set([0, Math.floor(IDS.length / 2), IDS.length - 1]) : new Set();
    const texts = await walk(P, tag, {mobile, perStep: async (id, k) => { if (shotAt.has(k)) await P.shot(join(SHOTS, `story_${w}x${h}_${dark ? "dark" : "light"}_${id}.png`)); }});
    if (w === 1440 && !dark) normalTexts = texts;
    const sep = await P.eval(`document.body.innerText`);
    const sh = sepHits(sep);
    check(!sh.length, `${tag}: no dot separator in the rendered text${sh.length ? `: ${sh.map(x => x.what).join(", ")}` : ""}`);
  }

  /* ---------------------------------------------------------------- once at 1440 dark: links, keys, Play, Try it */
  {
    const tag = "1440 dark";
    await P.viewport(1440, 900, false); await setMotion(P, true, false);
    const mid = IDS[Math.floor(IDS.length / 2)];
    if (await openStory(P, URL0 + "#s=" + mid, tag + " deep link")) {
      check((await P.waitFor(`(${SSTATE}).step === ${JSON.stringify(mid)}`, 5000, 50)) >= 0, `${tag}: #s=${mid} opens that step (${(await state(P)).step})`);
    }
    if (IDS.includes("lsf-1") && await openStory(P, URL0 + "#lsf", tag + " alias")) {
      const t = await P.waitFor(`(${SSTATE}).step === "lsf-1" && location.hash === "#s=lsf-1"`, 5000, 50);
      check(t >= 0, `${tag}: #lsf alias opens lsf-1 and is rewritten to #s=lsf-1 (step ${(await state(P)).step}, hash ${await P.eval("location.hash")})`);
    } else if (!IDS.includes("lsf-1")) note("no lsf-1 step; #lsf alias not checked");
    if (await openStory(P, URL0 + "#s=" + IDS[1], tag + " keys")) {
      await P.waitFor(`(${SSTATE}).step === ${JSON.stringify(IDS[1])}`, 5000, 50);
      /* a key is judged on the settled page: smooth scrolling ends, then the active step must be the target (the
         IntersectionObserver must not leave an intermediate step active after a jump) */
      const settle = async () => { let y = -1; for (let i = 0; i < 60; i++) { const y2 = await P.eval("scrollY"); if (y2 === y) break; y = y2; await sleep(150); } await sleep(300); };
      const press = async (k, want) => { await P.eval("__s.focusStage()"); await P.key(k);
        await P.waitFor(`(${SSTATE}).step === ${JSON.stringify(want)}`, 6000, 50); await settle();
        const got = (await state(P)).step; if (got !== want) note(`${k}: settled on ${got}, want ${want}`); return got === want; };
      check(await press("End", IDS.at(-1)), `${tag}: End goes to the last step`);
      check(await press("Home", IDS[0]), `${tag}: Home goes to the first step`);
      if (IDS.length > 2) { check(await press("PageDown", IDS[1]), `${tag}: PageDown goes to the next step`);
        check(await press("PageUp", IDS[0]), `${tag}: PageUp goes to the previous step`); }
      check(await press("ArrowRight", IDS[1]), `${tag}: ArrowRight goes to the next step`);
      check(await press("ArrowLeft", IDS[0]), `${tag}: ArrowLeft goes back`);
      await P.eval("__s.focusStage()"); await P.key("3"); await sleep(800); await settle();
      check((await state(P)).step === IDS[0], `${tag}: number key 3 changes nothing (step ${(await state(P)).step})`);
      /* Space on the body scrolls natively and does not play */
      await P.eval("document.activeElement && document.activeElement.blur(); window.scrollTo(0, 0)"); await sleep(200);
      await P.key(" "); await sleep(800);
      check(!(await state(P)).playing, `${tag}: Space with focus on the page body does not start Play`);
      /* Play label, Space on Play, no narration, no focus move, k pauses */
      const pl = await P.eval(`(() => { const b = __s.tid("story-play"); return b ? ((b.getAttribute("aria-label") || "") + " " + b.textContent).replace(/\\s+/g, " ").trim() : null; })()`);
      check(!!pl && /\bplay\b/i.test(pl) && /\d+\s*min/.test(pl), `${tag}: Play is labelled with its length ("${pl}")`);
      await P.eval(`(__s.tid("story-play") || {focus() {}}).focus()`);
      const n0 = await live(P), f0 = await P.eval("document.activeElement && (document.activeElement.dataset.testid || document.activeElement.id)");
      await P.key(" ");
      const tp = await P.waitFor(`(${SSTATE}).playing`, 3000, 50);
      check(tp >= 0, `${tag}: Space on Play starts Play`);
      if (tp >= 0) {
        await sleep(4000);
        const dn = (await live(P)) - n0, log = await P.eval(`__live.log.slice(-${Math.max(1, (await live(P)) - n0)}).map(x => x.text)`);
        check(dn <= 1, `${tag}: during Play at most the Play state is announced (${dn}: ${JSON.stringify(log)})`);
        check((await P.eval("document.activeElement && (document.activeElement.dataset.testid || document.activeElement.id)")) === f0, `${tag}: focus does not move during Play`);
        await P.key("k");
        check((await P.waitFor(`!(${SSTATE}).playing`, 3000, 50)) >= 0, `${tag}: k on Play pauses`);
      }
    }
    /* Try it */
    const tryStep = STEPS.find(s => Array.isArray(s.controls) && s.controls.length);
    if (!tryStep) note("no step has controls; Try it not checked");
    else for (const [w, h, mobile] of [[1440, 900, false], [390, 844, true]]) {
      const tg = `${w}x${h} Try it on ${tryStep.id}`;
      await P.viewport(w, h, mobile); await setMotion(P, true, false);
      if (!await openStory(P, URL0 + "#s=" + tryStep.id, tg)) continue;
      await P.waitFor(`(${SSTATE}).step === ${JSON.stringify(tryStep.id)}`, 5000, 50); await sleep(700);
      const clicked = await P.eval(`(() => { const b = [...(__s.card(${JSON.stringify(tryStep.id)}) || document).querySelectorAll(__s.sel("story-tryit"))].find(__s.vis); if (!b) return false; b.click(); return true; })()`);
      if (!check(clicked, `${tg}: Try it button in the card`)) continue;
      const te = await P.waitFor(`(${SSTATE}).mode === "explore"`, 3000, 50);
      check(te >= 0, `${tg}: mode becomes explore`);
      const sl = await P.eval(`[...document.querySelectorAll('input[type="range"], [role="slider"]')].filter(__s.vis).map(e => { const r = e.getBoundingClientRect(), l = e.closest("label, [data-testid=story-control]"), lr = l ? l.getBoundingClientRect() : r;
        return {vt: e.getAttribute("aria-valuetext") || "", h: Math.max(r.height, lr.height), w: r.width}; })`);
      check(sl.length >= 1 && sl.length <= 2, `${tg}: 1 or 2 sliders shown (${sl.length})`);
      check(sl.every(x => /\p{L}{4,}/u.test(x.vt)), `${tg}: every slider has aria-valuetext in words, not just a number and unit symbol (a word of 4+ letters, e.g. "amount", "per square centimetre") (${sl.map(x => `"${x.vt}"`).join(", ")})`);
      if (mobile) check(sl.every(x => x.h >= 44), `${tg}: slider targets >= 44 px tall (${sl.map(x => x.h.toFixed(0)).join(", ")})`);
      await P.eval("__s.focusStage()"); await P.key("Escape");
      check((await P.waitFor(`(${SSTATE}).mode === "step"`, 3000, 50)) >= 0, `${tg}: Esc leaves Explore back to the step`);
    }
    check(!P.exceptions.length && !P.consoleErrors.length, `normal-motion session: no uncaught exception or console error${P.exceptions.length + P.consoleErrors.length ? ": " + [...P.exceptions, ...P.consoleErrors].slice(0, 3).join(" | ") : ""}`);
  }

  /* ---------------------------------------------------------------- reduced motion: same DOM text */
  {
    const Q = await launch({profile: opt.profile, edge, block: BLOCK, inject: [LIVE], reducedMotion: true}); sessions.push(Q);
    const tag = "1440x900 light reduced motion";
    await Q.viewport(1440, 900, false); await setMotion(Q, false, true);
    if (await openStory(Q, URL0 + "#s=" + IDS[0], tag)) {
      check(await Q.eval(`matchMedia("(prefers-reduced-motion: reduce)").matches`), `${tag}: reduced motion measured in-page`);
      const texts = await walk(Q, tag, {});
      const diff = IDS.filter(id => normalTexts && texts[id] !== normalTexts[id]);
      check(!!normalTexts && !diff.length, `${tag}: DOM text of every step equals the normal run${diff.length ? ": differs on " + diff.slice(0, 4).join(", ") : ""}`);
    }
    check(!Q.exceptions.length && !Q.consoleErrors.length, `reduced-motion session: no uncaught exception or console error${Q.exceptions.length + Q.consoleErrors.length ? ": " + [...Q.exceptions, ...Q.consoleErrors].slice(0, 3).join(" | ") : ""}`);
  }
} finally { for (const s of sessions) await s.close(); await srv.close(); }
process.exit(C.finish());
