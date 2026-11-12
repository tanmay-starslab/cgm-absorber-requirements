// Step driver: the default, semi-interactive level (PLAN_final section 1.2). The page itself scrolls natively; an
// IntersectionObserver picks the step card that crosses the reading line, and the stage tweens into that step's
// authored state in at most 600 ms (cut short when the reader moves on). Scrub steps (scrub: true, at most 3) map
// the card's scroll progress to the step's local time instead. Never snaps, never overrides scrolling.
//
// createStepDriver({engine, cards, root, now, raf, caf, IO, line, onStep, reduced, scrollIntoView})
//   cards            the step card elements in steps.json order, each with data-step="<step id>"
//   root             scroll root for the observer (default: viewport)
//   IO               IntersectionObserver constructor (injectable for tests)
//   line             reading line as a share of the viewport height (default 0.5)
//   block            scrollIntoView alignment for go(), string or () => string (default "center"; the page uses
//                    "start" on phones, where the card sits under the sticky stage via scroll-margin-top)
//   onStep(index, id) when the active step changes (the page updates the store, rail and aria)
//   reduced          prefers-reduced-motion: no tween (the page crossfades, at most 200 ms), scrub steps discrete
// -> {go(index, {instant}), next(), prev(), refresh(), get index, setReduced(b), destroy()}
//
// It renders through engine.show(index, t, {p}) only; while Explore is open the explore driver owns the stage and
// this driver holds still (suspend()/resume()).

import {TWEEN_MAX_MS, EASE} from "../engine.js";

export function createStepDriver(o) {
  const engine = o.engine, cards = Array.from(o.cards || []);
  const now = o.now || (() => performance.now());
  const raf = o.raf || (f => requestAnimationFrame(f)), caf = o.caf || (id => cancelAnimationFrame(id));
  const IO = o.IO || (typeof IntersectionObserver !== "undefined" ? IntersectionObserver : null);
  const line = o.line ?? 0.5;
  let reduced = !!o.reduced, index = -1, rafId = 0, suspended = false, io = null, onScroll = null;
  const idxOfCard = el => engine.indexOf(el.getAttribute("data-step"));

  function render(i, t, p) { if (!suspended) engine.show(i, t, {p}); }
  function endT(i) { const st = engine.stateAt(i); return st.dur; }
  function tweenTo(i) {
    if (rafId) { caf(rafId); rafId = 0; }
    const step = engine.steps[i], tw = step.tween;
    const ms = reduced || tw === null ? 0 : Math.min(TWEEN_MAX_MS, tw && typeof tw.ms === "number" ? tw.ms : TWEEN_MAX_MS);
    const ease = EASE[(tw && tw.ease) || "inOut"] || EASE.inOut;
    if (step.scrub) { scrubRender(i); return; }
    if (!(ms > 0)) { render(i, endT(i), 1); return; }
    const start = now();
    const tick = () => {
      if (index !== i) return;                                  // cut short: another step took over
      const x = Math.min(1, (now() - start) / ms), e = ease(x);
      render(i, e * endT(i), e);
      if (x < 1) rafId = raf(tick); else rafId = 0;
    };
    tick();
  }
  /* scrub: local time = share of the card that has passed the reading line */
  function scrubProgress(i) {
    const el = cards.find(c => idxOfCard(c) === i);
    if (!el || typeof el.getBoundingClientRect !== "function") return 1;
    const r = el.getBoundingClientRect(), H = (typeof innerHeight !== "undefined" ? innerHeight : 800) * line;
    const x = r.height > 0 ? (H - r.top) / r.height : 1;
    const q = Math.min(1, Math.max(0, x));
    return reduced ? (q < 0.5 ? 0 : 1) : q;
  }
  function scrubRender(i) { const q = scrubProgress(i); render(i, q * endT(i), 1); }

  function activate(i, why) {
    if (i < 0 || i === index) return;
    index = i;
    o.onStep && o.onStep(i, engine.steps[i].id, why);
    tweenTo(i);
  }
  if (IO && cards.length) {
    io = new IO(entries => {
      // the card whose box contains the reading line wins; ties go to the later card
      let best = -1;
      for (const e of entries) if (e.isIntersecting) { const i = idxOfCard(e.target); if (i > best) best = i; }
      if (best >= 0) activate(best, "scroll");
    }, {root: o.root || null, rootMargin: `-${Math.round(line * 100)}% 0px -${Math.round((1 - line) * 100)}% 0px`, threshold: 0});
    for (const c of cards) io.observe(c);
  }
  const scrubIdx = engine.steps.map((s, i) => (s.scrub ? i : -1)).filter(i => i >= 0);
  if (scrubIdx.length && typeof addEventListener !== "undefined") {
    onScroll = () => { if (scrubIdx.includes(index) && !rafId) rafId = raf(() => { rafId = 0; scrubRender(index); }); };
    addEventListener("scroll", onScroll, {passive: true});
  }

  const d = {
    get index() { return index; },
    /* jump (keyboard, Next/Back, chapter rail): scroll the card into view; the observer then activates it. instant also
       renders now (used on load and in tests) */
    go(i, opt = {}) {
      if (i < 0 || i >= engine.steps.length) return index;
      const el = cards.find(c => idxOfCard(c) === i);
      if (el && typeof el.scrollIntoView === "function") el.scrollIntoView({block: typeof o.block === "function" ? o.block() : o.block || "center", behavior: reduced || opt.instant ? "auto" : "smooth"});
      if (opt.instant || !io) { index = -1; activate(i, "go"); }
      return i;
    },
    next() { return d.go(Math.min(engine.steps.length - 1, index + 1)); },
    prev() { return d.go(Math.max(0, index - 1)); },
    refresh() { if (index >= 0) { const s = engine.steps[index]; if (s.scrub) scrubRender(index); else render(index, endT(index), 1); } },
    setReduced(b) { reduced = !!b; d.refresh(); },
    suspend() { suspended = true; if (rafId) { caf(rafId); rafId = 0; } },
    resume() { suspended = false; d.refresh(); },
    destroy() { if (io) io.disconnect(); if (onScroll) removeEventListener("scroll", onScroll); if (rafId) caf(rafId); },
  };
  return d;
}
