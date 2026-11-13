// Story input layer (DESIGN §2.2, DESIGN_final §3.2 and C_ux P0-1 / P1-1 / P1-7). There is no document scroll: every
// gesture is mapped here onto the clock's target. Pure mapping functions are exported for the node tests; bindInput()
// attaches them to the DOM.
//
// | input            | desktop                                                     | touch                                    |
// | scrub            | wheel / trackpad: clamp(Δy/30000, ±0.012); notched mouse     | one-finger vertical drag (axis lock 6 px; |
// |                  | (whole multiples of 100/120 px, or line mode) 1/120 per notch| 9 stage heights per story), flick         |
// |                  |                                                             | clamp(0.04 v, ±0.03); horizontal ignored |
// | orbit            | pointer drag on the canvas (never scrubs)                    | Look toggle on, then one-finger drag     |
// | fly              | hold Space or the Fly button: per-beat rate = 1.25 × Watch speed (≤ 0.012 p/s; review SC-4) | hold the Fly button |
// | beat jump        | PageUp/PageDown, rail ticks, Enter on a beat chip (quantised)| tap rail ticks                           |
// | fine             | ←/→/↑/↓ ±0.006; Shift = previous/next cell stop              | –                                        |
// | Home / End       | 0 / 1                                                       | –                                        |
// | zoom             | ctrl-wheel is never prevented (browser zoom)                 | pinch = browser zoom (touch-action: pinch-zoom on the stage) |
// | never scrub      | drags/swipes inside [data-noscrub]; the wheel scrubs everywhere except form controls, sliders, sheets, the gate, [data-wheel] |
//
// Reduced motion: wheel / swipe gestures and arrows step to the previous / next stop (beat starts and stop sub-ticks),
// one jump per gesture; the clock is in reduced mode (p = target).

export const INPUT_TUNE = Object.freeze({
  wheelDiv: 30000,          // trackpad: px per full story
  wheelMax: 0.012,          // per-event clamp
  notchStep: 1 / 120,       // notched mouse: ≈ 120 notches per story (2.5 × the trackpad gain at 100 px)
  lineH: 16,                // deltaMode 1 (lines) → px
  dragHeights: 9,           // touch: stage heights of vertical drag per story
  axisLock: 6,              // px before a touch drag commits to an axis
  emaA: 0.35,               // touch velocity EMA weight of the new sample
  flickGain: 0.04, flickMax: 0.03,
  fine: 0.006,
  quantGap: 150, quantRatio: 1.6,
  holdRate: 0.012,          // the ceiling of the hold rate (p/s)
  holdK: 1.25,              // review SC-4: hold plays each beat at holdK × its Watch speed (the reading budget), never above holdRate
  holdMin: 0.002,
  holdWps: 4,               // review2 scrolly #2: hold reading speed inside a caption (240 words/min)
  holdCapMin: 0.0005,       // floor of the in-caption rate (p/s), so a hold always moves
});

/* hold-to-fly rate (review SC-4): per beat, holdK × (beat width / its Watch seconds), clamped to [holdMin, holdRate], and
   slower inside a caption window (timeline.captionRate, review2 scrolly #2); constant up to the next beat or caption edge
   (`until`), so the clock's exact stepper stays exact. tl = {beats, watch: {dur}} (timeline.js). */
export function holdRateAt(tl, x, T = INPUT_TUNE) {
  const bs = tl && tl.beats, dur = tl && tl.watch && tl.watch.dur;
  if (!bs || !bs.length || !dur) return {rate: T.holdRate, until: Infinity};
  let i = bs.findIndex(b => x >= b.p0 && x < b.p1); if (i < 0) i = bs.length - 1;
  const b = bs[i], d = dur[i] > 0 ? dur[i] : 0;
  const r = d ? T.holdK * (b.p1 - b.p0) / d : T.holdRate;
  let rate = Math.min(T.holdRate, Math.max(T.holdMin, r)), until = b.p1;
  // review2 scrolly #2: inside a caption's window the hold slows so its full-opacity part lasts words / holdWps seconds
  // (never below holdCapMin); between captions it keeps the beat rate above
  if (tl.captionRate) { const c = tl.captionRate(x, T.holdWps); if (c.rate < rate) rate = Math.max(T.holdCapMin, c.rate); until = Math.min(until, c.until); }
  return {rate, until};
}

const sgn = x => (x > 0 ? 1 : x < 0 ? -1 : 0);
const clamp = (x, a) => (x > a ? a : x < -a ? -a : x);

/* deltaY in px (deltaMode 0 px, 1 lines, 2 pages) */
export function wheelPx(e, viewH = 900, T = INPUT_TUNE) {
  const d = +e.deltaY || 0;
  return e.deltaMode === 1 ? d * T.lineH : e.deltaMode === 2 ? d * viewH : d;
}
/* a notched mouse wheel: line mode, or a whole multiple of 100 / 120 px (Chrome / Edge / Safari on a wheel mouse) with no
   horizontal part. Trackpads send small, mostly fractional or irregular deltas and keep the trackpad gain. */
export function isNotched(e) {
  if (e.deltaMode === 1) return true;
  const d = Math.abs(+e.deltaY || 0);
  if (e.deltaMode !== 0 || d < 100 || Math.abs(+e.deltaX || 0) > 0) return false;
  if (!Number.isInteger(d)) return false;
  if (e.wheelDeltaY !== undefined && e.wheelDeltaY !== 0 && Math.abs(e.wheelDeltaY) === 3 * d) return false;   // trackpad tell
  return d % 120 === 0 || d % 100 === 0;
}
/* Δtarget for one wheel event (0 for ctrl-wheel: that is browser zoom; 0 for a mostly horizontal swipe) */
export function wheelDelta(e, viewH = 900, T = INPUT_TUNE) {
  if (e.ctrlKey || e.metaKey) return 0;
  if (Math.abs(+e.deltaX || 0) > Math.abs(+e.deltaY || 0)) return 0;
  if (isNotched(e)) {
    const d = e.deltaMode === 1 ? Math.max(1, Math.round(Math.abs(e.deltaY) / 3)) : Math.max(1, Math.round(Math.abs(e.deltaY) / 100));
    return clamp(sgn(e.deltaY) * d * T.notchStep, T.wheelMax);
  }
  return clamp(wheelPx(e, viewH, T) / T.wheelDiv, T.wheelMax);
}
/* touch: Δtarget for a vertical finger move of dy px (finger up = forward) */
export const dragDelta = (dy, viewH, T = INPUT_TUNE) => -dy / (Math.max(1, viewH) * T.dragHeights);
/* touch release: v in stage heights per second (finger up positive) → extra target */
export const flickDelta = (v, T = INPUT_TUNE) => clamp(T.flickGain * v, T.flickMax);
/* touch axis lock: null until the move exceeds axisLock px, then "y" or "x" */
export function axisOf(dx, dy, T = INPUT_TUNE) {
  if (Math.hypot(dx, dy) < T.axisLock) return null;
  return Math.abs(dy) >= Math.abs(dx) ? "y" : "x";
}

/* Gesture quantiser (Ramayana): one jump per gesture. A new gesture starts after a quantGap ms pause, or when an event is
   more than quantRatio × the previous one inside a stream (a new push during an inertial tail). */
export function createQuantiser(T = INPUT_TUNE) {
  let last = -Infinity, lastMag = 0;
  return {
    accept(tMs, mag = 1) {
      const m = Math.abs(mag), fresh = tMs - last > T.quantGap || m > T.quantRatio * lastMag;
      last = tMs; lastMag = m;
      return fresh;
    },
    reset() { last = -Infinity; lastMag = 0; },
  };
}

/* next / previous jump target among sorted stops (strictly beyond x by 1e-6) */
export function nextStop(stops, x, dir) {
  if (dir > 0) { for (const s of stops) if (s > x + 1e-6) return s; return stops.length ? stops[stops.length - 1] : x; }
  for (let i = stops.length - 1; i >= 0; i--) if (stops[i] < x - 1e-6) return stops[i];
  return stops.length ? stops[0] : x;
}

const noscrub = t => !!(t && t.closest && t.closest("[data-noscrub]"));
/* review SC-5: the vertical wheel scrubs everywhere on the stage (the dock, the rail, equation terms, the hero spectrum), except
   over things that own the wheel themselves: form controls and sliders, scrollable sheets and dialogs (menu, picker, text),
   the gate (its own wheel listener starts the flight) and anything marked [data-wheel] (dials stop propagation themselves).
   [data-noscrub] still keeps drags and touch swipes off the clock. */
// the story rail is itself the story's slider: the wheel over it scrubs like anywhere else (review2 scrolly #6)
const wheelOwn = t => !!(t && t.closest && !t.closest(".rail-track, [data-story-slider]") &&
  t.closest("[data-wheel], input, select, textarea, [role=slider], [role=menu], [role=dialog], #sheets, .sg"));
/* controls never start an orbit drag: the stage capturing their pointer would steal the pointerup (a held Fly button
   then never released, measured in story_input) */
const control = t => !!(t && t.closest && t.closest("button, a[href], input, select, textarea, label, [role=slider], [role=button], [data-hold]"));
const NAV_KEYS = new Set(["PageDown", "PageUp", "Home", "End"]);
const plainButton = t => !!(t && t.closest && t.closest("button, a[href], [role=button]") &&
  !t.closest("[role=slider], [role=menu], [role=dialog], [role=listbox], input, select, textarea, [data-wheel]"));
const typing = t => !!(t && t.closest && t.closest("input, textarea, select, [contenteditable=''], [contenteditable='true']"));

/* bindInput({stage, clock, timeline, bus, win, doc, tune, now, isReduced, onKey})
     onKey(e)   optional: return true to claim a key before the clock sees it (Watch uses Space as pause)
     stage      element receiving wheel / pointer input (the pinned stage)
     timeline   {readStarts()|beatStarts(): number[], readAt(p), stops(): number[], cellStops(): number[]}  (js/core/timeline.js)
   -> {holdStart(src), holdEnd(src), bindHold(el), jumpBeat(dir), jumpTo(p, kind), setLook(b), look, destroy()} */
export function bindInput(o) {
  const T = {...INPUT_TUNE, ...(o.tune || {})};
  const win = o.win || window, doc = o.doc || document, stage = o.stage, clock = o.clock, bus = o.bus, tl = o.timeline;
  const now = o.now || (() => performance.now());
  const reduced = () => (o.isReduced ? o.isReduced() : clock.state.reduced);
  const viewH = () => stage.clientHeight || win.innerHeight || 900;
  const emit = (n, p) => bus && bus.emit(n, p);
  const quant = createQuantiser(T), wheelQuant = createQuantiser(T);
  const holds = new Set();
  let look = false;

  const input = kind => emit("input", {kind});
  /* a rail tick or beat chip hands over a beat start; land on that beat's reading point instead (review2 perf/a11y H1) */
  function jumpTo(p, kind) {
    if ((kind === "rail" || kind === "beat") && tl && tl.readAt) p = tl.readAt(p);
    const from = clock.target; clock.setTarget(p, "cruise"); emit("jump", {to: clock.target, from, kind});
  }
  function jumpBeat(dir) { jumpTo(nextStop(tl.readStarts ? tl.readStarts() : tl.beatStarts(), clock.target, dir), "beat"); }
  function stepStop(dir) { jumpTo(nextStop(tl.stops(), clock.target, dir), "stop"); }
  function holdStart(src) { if (!holds.size) { clock.setMode("cruise"); clock.setRate(tl && tl.beats && tl.watch ? x => holdRateAt(tl, x, T) : T.holdRate); emit("hold", {on: true}); } holds.add(src); input("hold"); }
  function holdEnd(src) { holds.delete(src); if (!holds.size) { clock.setRate(0); emit("hold", {on: false}); } }

  /* ---- wheel ---- */
  function onWheel(e) {
    if (e.ctrlKey || e.metaKey) return;                         // browser zoom: never prevented
    if (wheelOwn(e.target)) return;
    e.preventDefault();
    const d = wheelDelta(e, viewH(), T);
    if (!d) return;
    input("wheel");
    if (reduced()) { if (wheelQuant.accept(now(), Math.abs(e.deltaY))) stepStop(sgn(d)); return; }
    clock.setMode("cruise");
    clock.nudge(d);
  }

  /* ---- pointer: mouse/pen drag orbits; touch scrubs vertically (or orbits in Look mode) ---- */
  const touches = new Map();
  let drag = null;                                              // {id, type, x0, y0, x, y, t, axis, v}
  function onDown(e) {
    if (e.defaultPrevented || noscrub(e.target) || control(e.target) || e.button > 0) return;
    if (e.pointerType === "touch") { touches.set(e.pointerId, true); if (touches.size > 1) { endDrag(e, true); return; } }
    drag = {id: e.pointerId, type: e.pointerType || "mouse", x0: e.clientX, y0: e.clientY, x: e.clientX, y: e.clientY, t: now(), t0: now(), axis: null, v: 0, orbit: false};
    if (drag.type !== "touch" || look) { drag.orbit = true; drag.axis = "xy"; emit("orbit", {phase: "start", dx: 0, dy: 0, pointerType: drag.type}); }
    try { stage.setPointerCapture && stage.setPointerCapture(e.pointerId); } catch {}
  }
  function onMove(e) {
    if (!drag || e.pointerId !== drag.id) return;
    const dx = e.clientX - drag.x, dy = e.clientY - drag.y, t = now(), dt = Math.max(1, t - drag.t) / 1000;
    if (drag.orbit) { emit("orbit", {phase: "move", dx, dy, pointerType: drag.type}); drag.x = e.clientX; drag.y = e.clientY; drag.t = t; return; }
    if (!drag.axis) { drag.axis = axisOf(e.clientX - drag.x0, e.clientY - drag.y0, T); if (!drag.axis) return;
      if (drag.axis === "y") { clock.setMode("drag"); input("drag"); } }
    if (drag.axis === "y") {
      clock.nudge(dragDelta(dy, viewH(), T), "drag");
      const vNow = -dy / viewH() / dt;
      drag.v = T.emaA * vNow + (1 - T.emaA) * drag.v;
      if (e.cancelable) e.preventDefault();
    }
    drag.x = e.clientX; drag.y = e.clientY; drag.t = t;
  }
  function endDrag(e, cancel) {
    if (!drag) return;
    const d = drag; drag = null;
    // fix3 R2: a press that barely moved is a tap: the page picks the ray cell under it (click-to-pin)
    if (!cancel && e && Math.hypot(e.clientX - d.x0, e.clientY - d.y0) < 5 && now() - d.t0 < 450) emit("tap", {x: e.clientX, y: e.clientY, pointerType: d.type});
    if (d.orbit) { emit("orbit", {phase: "end", dx: 0, dy: 0, pointerType: d.type}); return; }
    if (d.axis === "y") {
      clock.setMode("cruise");
      const stale = now() - d.t > 100;                          // finger rested before lifting: no flick
      if (!cancel && !stale) {
        if (reduced()) stepStop(sgn(d.v) || 1); else clock.nudge(flickDelta(d.v, T));
      }
    }
  }
  function onUp(e) { if (e.pointerType === "touch") touches.delete(e.pointerId); if (drag && e.pointerId === drag.id) endDrag(e, e.type === "pointercancel"); }

  /* ---- keys ---- */
  function onKey(e) {
    // keys inside [data-noscrub] stay with that widget, except beat navigation from a plain button (Menu, Chapter, Fly):
    // a keyboard user who tabbed to the HUD still pages through the story (review2 perf/a11y L5)
    if (e.defaultPrevented || typing(e.target)) return;
    if (noscrub(e.target) && !(NAV_KEYS.has(e.key) && plainButton(e.target))) return;
    if (o.onKey && o.onKey(e) === true) return;                   // the page claims the key (e.g. Space = pause in Watch)
    if (e.altKey || e.ctrlKey || e.metaKey) return;
    const k = e.key;
    if (k === " " || k === "Spacebar") {
      e.preventDefault();
      if (!e.repeat) { if (reduced()) { input("key"); stepStop(1); } else holdStart("space"); }
      return;
    }
    const fine = (dir) => { e.preventDefault(); input("key");
      if (e.shiftKey) { jumpTo(nextStop(tl.cellStops(), clock.target, dir), "cell"); return; }
      if (reduced()) { if (!e.repeat || quant.accept(now(), 1)) stepStop(dir); return; }
      clock.setMode("cruise"); clock.nudge(dir * T.fine); };
    switch (k) {
      case "ArrowDown": case "ArrowRight": fine(1); break;
      case "ArrowUp": case "ArrowLeft": fine(-1); break;
      case "PageDown": case "PageUp": {
        e.preventDefault(); input("key");
        if (quant.accept(now(), 1) || !e.repeat) jumpBeat(k === "PageDown" ? 1 : -1);
        break; }
      case "Home": e.preventDefault(); input("key"); jumpTo(0, "home"); break;
      case "End": e.preventDefault(); input("key"); jumpTo(1, "end"); break;
      default: break;
    }
  }
  function onKeyUp(e) { if (e.key === " " || e.key === "Spacebar") holdEnd("space"); }
  function onBlur() { for (const s of [...holds]) holdEnd(s); if (drag) endDrag(null, true); }

  const opt = {passive: false};
  stage.addEventListener("wheel", onWheel, opt);
  stage.addEventListener("pointerdown", onDown);
  stage.addEventListener("pointermove", onMove, opt);
  stage.addEventListener("pointerup", onUp);
  stage.addEventListener("pointercancel", onUp);
  win.addEventListener("keydown", onKey);
  win.addEventListener("keyup", onKeyUp);
  win.addEventListener("blur", onBlur);

  const holdEls = [];
  const api = {
    holdStart, holdEnd, jumpBeat, jumpTo, stepStop,
    /* Fly button: pointer hold (and Enter/Space hold on the focused button) flies */
    bindHold(el, src = "fly") {
      if (el.dataset) el.dataset.hold = src;
      const down = e => { if (e.button > 0) return; e.preventDefault(); holdStart(src); try { el.setPointerCapture(e.pointerId); } catch {} };
      const up = () => holdEnd(src);
      const kd = e => { if ((e.key === "Enter" || e.key === " ") && !e.repeat) { e.preventDefault(); e.stopPropagation(); holdStart(src); } };
      const ku = e => { if (e.key === "Enter" || e.key === " ") { e.stopPropagation(); holdEnd(src); } };
      el.addEventListener("pointerdown", down); el.addEventListener("pointerup", up); el.addEventListener("pointercancel", up);
      el.addEventListener("lostpointercapture", up); el.addEventListener("keydown", kd); el.addEventListener("keyup", ku);
      holdEls.push(() => { el.removeEventListener("pointerdown", down); el.removeEventListener("pointerup", up);
        el.removeEventListener("pointercancel", up); el.removeEventListener("lostpointercapture", up);
        el.removeEventListener("keydown", kd); el.removeEventListener("keyup", ku); });
    },
    setLook(b) { look = !!b; emit("look", {on: look}); return look; },
    get look() { return look; },
    get holding() { return holds.size > 0; },
    destroy() {
      stage.removeEventListener("wheel", onWheel, opt); stage.removeEventListener("pointerdown", onDown);
      stage.removeEventListener("pointermove", onMove, opt); stage.removeEventListener("pointerup", onUp);
      stage.removeEventListener("pointercancel", onUp);
      win.removeEventListener("keydown", onKey); win.removeEventListener("keyup", onKeyUp); win.removeEventListener("blur", onBlur);
      for (const f of holdEls) f(); holdEls.length = 0;
    },
  };
  return api;
}
