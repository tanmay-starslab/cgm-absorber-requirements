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
