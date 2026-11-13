// Story v2 input gate G7 in a real browser (DESIGN_final §3.2, §4 G7; unit U_motion).
// TNG_BROWSER=1 node tests/js/story_input.mjs        (prints "skipped" without TNG_BROWSER; run_all.mjs picks it up)
//
// A harness page is written at run time (the real index.html belongs to U_shell): a pinned 100 % stage with the shell's
// CSS contract (overflow hidden, overscroll-behavior none, touch-action pinch-zoom), the real js/core clock, input layer,
// timeline and ticker, a [data-noscrub] slider and a Fly button. Events go through CDP Input.* (trusted events).
// Checks (G7): trackpad 300 px → 0.6-1.2 % p; notched mouse ≈ 120 notches ± 20 % per story; PageDown lands in the next
// beat start; Space held 10 s follows the per-beat reading-budget rate (fix1 SC-4; measured against the page's own hold time); [data-noscrub]
// never moves p (wheel, drag, keys); a desktop drag never moves p (it orbits); reduced motion steps one stop per gesture; a touch vertical swipe scrubs and never
// orbits; a horizontal swipe does nothing; ctrl-wheel is never prevented; a downward swipe at p = 0 does not reload.

import {writeFileSync, mkdirSync, rmSync} from "node:fs";
import {join} from "node:path";
import {tmpdir} from "node:os";
import {ROOT as REPO, serve, launch, sleep} from "./lib/browser.mjs";

if (!process.env.TNG_BROWSER) { console.log("skipped (set TNG_BROWSER=1 to run the story input test)"); process.exit(0); }

const DOCS = join(REPO, "docs/tng50");
const dir = join(tmpdir(), `story-input-${process.pid}`); mkdirSync(dir, {recursive: true});
const page = join(dir, "harness.html");
writeFileSync(page, `<!doctype html><html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>
  html, body {margin: 0; height: 100%; overflow: hidden; overscroll-behavior: none; background: #05070b; color: #ddd; font: 14px sans-serif}
  #stage {position: fixed; inset: 0; height: 100dvh; touch-action: pinch-zoom; overscroll-behavior: none}
  #panel {position: absolute; left: 20px; bottom: 20px; width: 260px; height: 120px; background: #223; z-index: 5}
  #panel input {width: 220px; margin: 40px 20px}
  #fly {position: absolute; right: 20px; bottom: 20px; width: 90px; height: 48px; z-index: 5}
</style></head><body>
<main id="stage" aria-label="story stage"><div id="panel" data-noscrub><input id="slider" type="range" min="0" max="100" value="50"></div>
<button id="fly">Fly</button><div data-noscrub><button id="hudbtn">Menu</button></div>
<div class="rail-track" role="slider" tabindex="0" data-noscrub style="position:absolute;left:300px;top:860px;width:600px;height:30px"></div></main>
<script type="module">
  const R = "./learn/how-a-spectrum-is-made/";
  const [CL, IN, TL, BUS, PD] = await Promise.all(["js/core/clock.js", "js/core/input.js", "js/core/timeline.js", "js/core/bus.js", "js/drivers/play.js"].map(f => import(R + f)));
  const beats = await (await fetch(R + "beats.json")).json();
  const tl = TL.createTimeline(beats), clock = CL.createClock({}), bus = BUS.createBus();
  const log = {orbit: 0, input: 0, jump: [], holdOn: null, holdMs: 0, ctrlPrevented: [], marker: Math.random()};
  bus.on("orbit", e => { if (e.phase === "move") log.orbit++; }); bus.on("input", () => log.input++); bus.on("jump", j => log.jump.push(j.to));
  bus.on("hold", h => { if (h.on) log.holdOn = performance.now(); else if (log.holdOn != null) { log.holdMs += performance.now() - log.holdOn; log.holdOn = null; } });
  window.addEventListener("wheel", e => { if (e.ctrlKey) log.ctrlPrevented.push(e.defaultPrevented); }, {passive: true});
  const input = IN.bindInput({stage: document.getElementById("stage"), clock, timeline: tl, bus});
  input.bindHold(document.getElementById("fly"));
  const tick = PD.createTicker({clock, onFrame: () => {}}); tick.start();
  // fix1 review SC-4: the hold rate follows the reading budget per beat (IN.holdRateAt); the expected target after s seconds
  const holdTo = (x0, s) => { let x = x0, rem = s; for (let g = 0; g < 64 && rem > 1e-9 && x < 1; g++) { const r = IN.holdRateAt(tl, x + 1e-12); const dt = Math.min(rem, (r.until - x) / r.rate); x += r.rate * dt; rem -= dt; } return Math.min(1, x); };
  window.__h = {clock, tl, input, log, holdTo, reset(p = 0) { clock.setRate(0); clock.jump(p); log.orbit = 0; log.input = 0; log.jump = []; log.holdMs = 0; log.holdOn = null; }};
  window.__ready = true;
</script></body></html>`);

let fails = 0, n = 0;
const ok = (c, msg) => { n++; if (c) console.log("ok " + msg); else { fails++; console.log("FAIL " + msg); } };
const srv = await serve({dir: DOCS, page});
const P = await launch({width: 1440, height: 900, reducedMotion: false});
try {
  await P.goto(srv.base);
  if (await P.waitFor("window.__ready === true", 60000) < 0) throw new Error("harness did not load: " + P.exceptions.join(" | "));
  const T = () => P.eval("__h.clock.target"), reset = p => P.eval(`__h.reset(${p})`);
  const wheel = (dy, x = 900, y = 300, mods = 0) => P.send("Input.dispatchMouseEvent", {type: "mouseWheel", x, y, deltaX: 0, deltaY: dy, modifiers: mods});

  // trackpad: 30 small events of 10 px = 300 px
  await reset(0.2); for (let i = 0; i < 30; i++) await wheel(10);
  let d = (await T()) - 0.2; ok(d >= 0.006 && d <= 0.012, `G7 trackpad 300 px → ${(d * 100).toFixed(2)} % p (0.6-1.2 %)`);
  // notched mouse: 12 notches of 100 px ≈ 12/120 of the story
  await reset(0.2); for (let i = 0; i < 12; i++) await wheel(100);
  d = (await T()) - 0.2; const notches = 12 / d;
  ok(notches >= 96 && notches <= 144, `G7 notched mouse: ${notches.toFixed(0)} notches per story (120 ± 20 %)`);
  // PageDown / PageUp
  // review2 perf/a11y H1: the landing is the beat's reading point (its first line at full opacity), not the bare boundary
  const B = await P.eval("Object.fromEntries(__h.tl.beats.map(b => [b.id, b.p0]))"), mid = (B.B3 + B.B4) / 2;
  const RP = await P.eval("Object.fromEntries(__h.tl.beats.map(b => [b.id, __h.tl.readPoint(b)]))");
  const inB3 = (RP.B3 + B.B4) / 2;                       // inside B3, past its reading point
  await reset(inB3); await P.key("PageDown");
  ok(Math.abs((await T()) - RP.B4) < 1e-9 && RP.B4 >= B.B4 && RP.B4 < B.B5, `G7 PageDown from inside B3 lands in B4 at its reading point (${RP.B4.toFixed(4)}; beat starts ${B.B4})`);
  await P.key("PageUp"); ok(Math.abs((await T()) - RP.B3) < 1e-9, "G7 PageUp goes back to the previous beat's reading point");
  await reset(0.4); await P.eval(`__h.input.jumpTo(${B.B9}, "rail")`);
  ok(Math.abs((await T()) - RP.B9) < 1e-9, "a rail tick (beat start) lands on that beat's reading point");
  // review2 perf/a11y L5: PageDown from a focused plain button inside [data-noscrub] (Menu, Chapter) still pages
  await reset(inB3); await P.eval("document.getElementById('hudbtn').focus()"); await P.key("PageDown");
  ok(Math.abs((await T()) - RP.B4) < 1e-9, "PageDown from a focused HUD button inside [data-noscrub] pages the story");
  await P.eval("document.activeElement.blur()");
  // Space held ~10 s
  await reset(0); await P.send("Input.dispatchKeyEvent", {type: "keyDown", key: " ", code: "Space", windowsVirtualKeyCode: 32, text: " "});
  await sleep(10000);
  await P.send("Input.dispatchKeyEvent", {type: "keyUp", key: " ", code: "Space", windowsVirtualKeyCode: 32});
  await sleep(400);
  const held = await P.eval("__h.log.holdMs"), tgt = await T(), p10 = await P.eval("__h.clock.p");
  const want = await P.eval(`__h.holdTo(0, ${held / 1000})`);
  ok(Math.abs(tgt - want) < 1e-3, `G7 Space hold follows the reading budget (1.25 × each beat's Watch speed, ≤ 0.012 p/s; review SC-4): ${tgt.toFixed(4)} vs ${want.toFixed(4)} after ${(held / 1000).toFixed(2)} s`);
  ok(tgt < 0.012 * held / 1000 + 1e-6 && tgt > 0, "G7 the hold never exceeds 0.012 p/s");
  ok(Math.abs(p10 - tgt) < 1e-3, "the spring settles on the target after release");
  // Fly button hold
  await reset(0.3); await P.mouse("mouseMoved", 1375, 856); await P.mouse("mousePressed", 1375, 856); await sleep(1000);
  await P.mouse("mouseReleased", 1375, 856); await sleep(100);
  // measured against the page's own hold time (CDP press/release latency on a loaded node stretches the 1 s window)
  const heldFly = await P.eval("__h.log.holdMs");
  ok(!(await P.eval("__h.input.holding")) && (await P.eval("__h.clock.state.rate")) === 0, "releasing the Fly button ends the hold (the stage must not capture a control's pointer)");
  const wantFly = (await P.eval(`__h.holdTo(0.3, ${heldFly / 1000})`)) - 0.3;
  d = (await T()) - 0.3; ok(heldFly >= 900 && Math.abs(d - wantFly) < 1e-3,
    `hold the Fly button ≈ 1 s → +${d.toFixed(4)} p after ${(heldFly / 1000).toFixed(2)} s held (reading-budget rate: +${wantFly.toFixed(4)})`);
  // [data-noscrub]
  await reset(0.4);
  const sr = await P.eval("(() => { const r = document.getElementById('slider').getBoundingClientRect(); return {x: r.x + r.width / 2, y: r.y + r.height / 2}; })()");
  for (let i = 0; i < 10; i++) await wheel(100, sr.x, sr.y);
  await P.drag(60, 840, 230, 840);
  await P.eval("document.getElementById('slider').focus()"); await P.key("ArrowRight"); await P.key("PageDown");
  ok(Math.abs((await T()) - 0.4) < 1e-12, "G7 wheel on a slider, drag and keys inside [data-noscrub] never move p");
  // fix1 review SC-5: the vertical wheel over a [data-noscrub] area that is not a control (the dock, the rail) still scrubs
  await P.eval("document.activeElement.blur()");
  for (let i = 0; i < 3; i++) await wheel(100, 150, 872);
  await sleep(100);
  ok((await T()) > 0.4 + 1e-4, `G7 wheel over a [data-noscrub] panel outside its controls scrubs (review SC-5): ${(await T()).toFixed(4)}`);
  // review2 scrolly #6: the story rail (role=slider, .rail-track) is not a wheel dead zone
  await reset(0.4); for (let i = 0; i < 3; i++) await wheel(100, 600, 875); await sleep(100);
  ok((await T()) > 0.4 + 1e-4, `the wheel over the story rail scrubs (review2 scrolly #6): ${(await T()).toFixed(4)}`);
  // desktop drag orbits, never scrubs
  await reset(0.5); await P.eval("document.activeElement.blur()"); await P.drag(700, 300, 900, 500, 12);
  ok(Math.abs((await T()) - 0.5) < 1e-12 && (await P.eval("__h.log.orbit")) > 0, "G7 a desktop drag orbits and never moves p");
  // ctrl-wheel never prevented
  await reset(0.5); await wheel(100, 900, 300, 2); await sleep(100);
  const prev = await P.eval("__h.log.ctrlPrevented");
  ok(prev.length > 0 && prev.every(x => x === false) && Math.abs((await T()) - 0.5) < 1e-12, "G7 ctrl-wheel is never prevented and never scrubs");

  // reduced motion: a wheel gesture steps to the next stop, once per gesture; the clock has no spring
  await reset(mid); await P.eval("__h.clock.setReduced(true)");
  for (let i = 0; i < 6; i++) await wheel(40 - i * 5);
  const r1 = await T(), p1 = await P.eval("__h.clock.p"); await sleep(250); await wheel(60);
  const r2 = await T();
  // stops are the reading points of every line (review2 perf/a11y H1), so the next two stops after mid-B3
  const [s1, s2] = await P.eval(`(() => { const st = __h.tl.stops(); const i = st.findIndex(q => q > ${mid} + 1e-6); return [st[i], st[i + 1]]; })()`);
  ok(Math.abs(r1 - s1) < 1e-9 && p1 === r1 && Math.abs(r2 - s2) < 1e-9, `reduced motion: one stop per wheel gesture (mid-B3 → ${s1} → ${s2}, each a line's reading point), p = target`);
  await P.eval("__h.clock.setReduced(false)");

  // touch (phone portrait)
  await P.viewport(390, 844, true); await sleep(300);
  const touch = async (pts, steps = 10) => {
    const [x0, y0, x1, y1] = pts;
    await P.send("Input.dispatchTouchEvent", {type: "touchStart", touchPoints: [{x: x0, y: y0}]});
    for (let i = 1; i <= steps; i++) { await P.send("Input.dispatchTouchEvent", {type: "touchMove", touchPoints: [{x: x0 + (x1 - x0) * i / steps, y: y0 + (y1 - y0) * i / steps}]}); await sleep(16); }
    await P.send("Input.dispatchTouchEvent", {type: "touchEnd", touchPoints: []});
  };
  await reset(0.5); await touch([200, 600, 200, 300]); await sleep(300);
  d = (await T()) - 0.5;
  ok(d > 0.035 && (await P.eval("__h.log.orbit")) === 0, `G7 a vertical swipe scrubs forward (+${d.toFixed(4)}) and never orbits`);
  await reset(0.5); await touch([60, 400, 330, 410]); await sleep(300);
  ok(Math.abs((await T()) - 0.5) < 1e-12 && (await P.eval("__h.log.orbit")) === 0, "G7 a horizontal swipe neither scrubs nor orbits");
  await P.eval("__h.input.setLook(true)"); await reset(0.5); await touch([200, 600, 200, 300]); await sleep(200);
  ok(Math.abs((await T()) - 0.5) < 1e-12 && (await P.eval("__h.log.orbit")) > 0, "Look toggle: one-finger drag orbits instead of scrubbing");
  await P.eval("__h.input.setLook(false)");
  // pull-to-refresh guard
  const marker = await P.eval("__h.log.marker"); await reset(0);
  const navs = []; const before = P.requests.length;
  await touch([200, 150, 200, 700], 14); await sleep(1500);
  const still = await P.eval("window.__h && __h.log.marker");
  ok(still === marker && !P.requests.slice(before).some(r => /harness|\/tng50\/(\?|$)/.test(r)) && Math.abs(await T()) < 1e-12,
    "G7 a downward swipe at p = 0 does not reload the page and stays at p = 0");
  ok(P.exceptions.length === 0, `no page exceptions${P.exceptions.length ? ": " + P.exceptions.join(" | ") : ""}`);
} catch (e) { fails++; console.log("FAIL harness: " + e.message); }
finally { await P.close(); await srv.close(); rmSync(dir, {recursive: true, force: true}); }

console.log(`${fails ? "FAIL" : "PASS"} story_input: ${n} checks, ${fails} failures`);
process.exit(fails ? 1 : 0);
