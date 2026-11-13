// Play (clock) driver: the non-interactive level (PLAN_final section 1.2). Starts only on an explicit play();
// any scroll, wheel, key or tap on the interrupt target pauses it into Step at the same frame. Speeds 0.75 / 1 / 1.5.
// It only ever calls engine.seek(t), so what plays here is exactly what the video renders.
//
// createPlayDriver({engine, now, raf, caf, interruptTarget, onTick, onState, onEnd})
//   now / raf / caf     injectable clock (default performance.now / requestAnimationFrame) for tests
//   interruptTarget     element or window whose user input pauses Play (wheel, touchstart, pointerdown, keydown
//                       except Space/k, which the page binds to toggle)
//   onTick(info)        after every frame: {t, duration, index, id, chapter} (the page updates caption and progress)
//   onState(playing, t) on play / pause; onEnd(t) when the cut ends (Play stops on the last frame, no loop)
// -> {play(t?), pause() -> t, toggle(), seekTo(t), setSpeed(x), get t, get playing, get speed, destroy()}

import {SPEEDS} from "../store.js";

// Play / Watch drivers.
//
// v2 (DESIGN_final §5.3, C_ux P1-9): createWatchDriver is "Watch (≈3 min)" on the SAME clock as scrolling. It moves the
// clock's target along the beats' Watch schedule (beats.json watch_s; timeline.watch), so Watch, scroll and the film all
// go through seek(p). Any user input that moves the clock pauses it (bus "input"); the page may bind Space to toggle().
// createTicker is the page's frame loop (clock.step + one callback per frame while anything moves).
// v1 (kept until the integrator retires the card page): createPlayDriver below, unchanged, drives engine.seek(t).
//
//   createWatchDriver({clock, timeline, bus, now, raf, caf, onTick, onState, onEnd, speeds})
//     -> {play(fromP?), pause() -> p, toggle(), setSpeed(x), remaining() (s), get playing, get t, get speed, destroy()}
//     onTick({t, p, total, beat})   after every frame; onState(playing, p); onEnd(p) at the end (no loop)

export function createWatchDriver(o) {
  const clock = o.clock, tl = o.timeline, W = tl.watch;
  const now = o.now || (() => performance.now());
  const raf = o.raf || (f => requestAnimationFrame(f)), caf = o.caf || (id => cancelAnimationFrame(id));
  const SPEEDS_W = o.speeds || SPEEDS;
  let playing = false, t = 0, t0 = 0, wall0 = 0, speed = 1, rafId = 0;
  const offInput = o.bus ? o.bus.on("input", () => { if (playing) d.pause(); }) : null;

  function frame() {
    if (!playing) return;
    t = Math.min(W.total, t0 + (now() - wall0) / 1000 * speed);
    const p = W.pAt(t);
    clock.setTarget(p, "watch");
    o.onTick && o.onTick({t, p, total: W.total, beat: tl.locate(p).beat.id});
    if (t >= W.total) { stop(); o.onEnd && o.onEnd(p); return; }
    rafId = raf(frame);
  }
  function stop() { playing = false; if (rafId) caf(rafId); rafId = 0; clock.setMode("cruise"); o.onState && o.onState(false, clock.target); }

  const d = {
    get playing() { return playing; }, get t() { return t; }, get speed() { return speed; },
    play(fromP) {
      const p = Number.isFinite(fromP) ? fromP : clock.target;
      t = p >= 1 - 1e-9 ? 0 : W.tAt(p);
      if (t === 0 && p >= 1 - 1e-9) clock.jump(0);
      t0 = t; wall0 = now(); playing = true; clock.setRate(0); clock.setMode("watch");
      o.onState && o.onState(true, p);
      rafId = raf(frame);
      return d;
    },
    pause() { if (playing) { t = Math.min(W.total, t0 + (now() - wall0) / 1000 * speed); stop(); } return clock.target; },
    toggle() { return playing ? d.pause() : d.play(); },
    setSpeed(x) { if (!SPEEDS_W.includes(x)) return speed; if (playing) { t0 = Math.min(W.total, t0 + (now() - wall0) / 1000 * speed); wall0 = now(); } speed = x; return speed; },
    remaining() { const tt = playing ? Math.min(W.total, t0 + (now() - wall0) / 1000 * speed) : W.tAt(clock.target); return Math.max(0, (W.total - tt) / speed); },
    destroy() { if (playing) stop(); if (offInput) offInput(); },
  };
  return d;
}

/* Frame ticker for the page loop: steps the clock by the real frame time (capped, so a background tab does not jump) and
   calls onFrame(state, dt) every frame while anything moves, plus once after it settles. now / raf / caf are injectable
   for tests. -> {start(), stop(), kick() (force one frame, e.g. after an override), get running} */
export function createTicker({clock, onFrame, now, raf, caf, maxDt = 0.25}) {
  const tNow = now || (() => performance.now());
  const req = raf || (f => requestAnimationFrame(f)), cancel = caf || (id => cancelAnimationFrame(id));
  let id = 0, last = 0, running = false, dirty = true, wasIdle = false;
  function frame() {
    if (!running) return;
    // maxDt guards the return from a background tab; while a hold flies (rate ≠ 0) a stalled frame keeps its full time
    // (up to 2 s), so Space held 10 s is 0.12 p whatever the frame pacing (the spring is exact for any dt; G7)
    const t = tNow(), el = Math.max(0, (t - last) / 1000), dt = Math.min(clock.state.rate ? Math.max(2, maxDt) : maxDt, el); last = t;
    clock.step(dt);
    const st = clock.state;
    if (!st.idle || dirty || !wasIdle) { onFrame(st, dt); dirty = false; }
    wasIdle = st.idle;
    id = req(frame);
  }
  return {
    start() { if (!running) { running = true; last = tNow(); id = req(frame); } },
    stop() { running = false; if (id) cancel(id); id = 0; },
    kick() { dirty = true; },
    get running() { return running; },
  };
}

/* ---------------------------------------------------------------- v1 Play driver (unchanged) */


const INTERRUPTS = ["wheel", "touchstart", "pointerdown", "keydown"];

export function createPlayDriver(o) {
  const engine = o.engine;
  const now = o.now || (() => performance.now());
  const raf = o.raf || (f => requestAnimationFrame(f)), caf = o.caf || (id => cancelAnimationFrame(id));
  let t = 0, playing = false, speed = 1, t0Wall = 0, t0 = 0, rafId = 0;

  function frame() {
    if (!playing) return;
    const D = engine.duration;
    t = Math.min(D, t0 + (now() - t0Wall) / 1000 * speed);
    const info = engine.seek(t);
    o.onTick && o.onTick({t, duration: D, ...(info || {})});
    if (t >= D) { stop(); o.onEnd && o.onEnd(t); return; }
    rafId = raf(frame);
  }
  function stop() { playing = false; if (rafId) caf(rafId); rafId = 0; o.onState && o.onState(false, t); }
  const onInput = e => {
    if (!playing) return;
    if (e.type === "keydown" && (e.key === " " || e.key === "k" || e.key === "K")) return;   // page toggles
    if (e.isTrusted === false) return;
    d.pause();
  };
  const tgt = o.interruptTarget || null;
  if (tgt) for (const ev of INTERRUPTS) tgt.addEventListener(ev, onInput, {passive: true, capture: true});

  const d = {
    get t() { return t; }, get playing() { return playing; }, get speed() { return speed; },
    play(from) {
      if (Number.isFinite(from)) t = Math.max(0, Math.min(engine.duration, from));
      if (t >= engine.duration) t = 0;                    // replay from the start after the end
      playing = true; t0 = t; t0Wall = now();
      o.onState && o.onState(true, t);
      rafId = raf(frame);
      return d;
    },
    pause() { if (playing) { t = Math.min(engine.duration, t0 + (now() - t0Wall) / 1000 * speed); engine.seek(t); stop(); } return t; },
    toggle() { return playing ? d.pause() : d.play(); },
    seekTo(x) { t = Math.max(0, Math.min(engine.duration, +x || 0)); if (playing) { t0 = t; t0Wall = now(); } const info = engine.seek(t); o.onTick && o.onTick({t, duration: engine.duration, ...(info || {})}); return t; },
    setSpeed(x) { if (!SPEEDS.includes(x)) return speed; if (playing) { t0 = t0 + (now() - t0Wall) / 1000 * speed; t0Wall = now(); } speed = x; return speed; },
    destroy() { if (playing) stop(); if (tgt) for (const ev of INTERRUPTS) tgt.removeEventListener(ev, onInput, {capture: true}); },
  };
  return d;
}
