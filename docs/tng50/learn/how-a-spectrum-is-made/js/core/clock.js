// Story motion clock (DESIGN §2.2, DESIGN_final §3.2, C_eng P2-3). Pure state machine: no DOM, no timers.
//
// The clock owns the story position p in [0, 1] and the input target it chases. Inputs only move the target; p follows
// it through an EXACT critically damped spring, so p(t) does not depend on the frame rate: stepping 10 s at 30, 60, 120
// or 144 Hz gives the same p to 1e-6 (gate G8). A "ramp" (hold Space / the Fly button) moves the target at a constant
// rate; the exact solution covers a linearly moving target too, and a step is split where the target hits 0 or 1 or
// crosses the settle point, so those events land at the same time at every frame rate.
//
//   createClock({p, reduced, tune}) -> clock
//     clock.step(dt)               advance dt seconds (any dt; exact)
//     clock.setTarget(x, mode?)    absolute target (clamped to [0, 1]); mode "drag" stiffens the spring (ω 26)
//     clock.nudge(dx, mode?)       target += dx
//     clock.jump(x)                p = target = x, v = 0 (URL #t=, Home/End under reduced motion, tests)
//     clock.setRate(r)             target ramp in p/s (hold: TUNE.holdRate; 0 stops it)
//     clock.setMode(m)             "cruise" | "drag" | "watch" (settle is automatic near the end)
//     clock.setReduced(b)          reduced motion: p = target, no spring
//     clock.state                  {p, target, v, mode, rate, reduced, omega, idle}
//
// Spring (y = p - target, target moving at rate r, steady lag y_ss = -2r/ω, z = y - y_ss):
//   z(t) = (z0 + (z0' + ω z0) t) e^{-ωt},  z'(t) = (z0' - ω (z0' + ω z0) t) e^{-ωt}
// ω: cruise 10 s⁻¹, drag 26 s⁻¹ (near 1:1 under a finger), settle 4 s⁻¹ once the target is past TUNE.settleFrom (the
// B14 hand-off), watch 10 s⁻¹.

export const CLOCK_TUNE = Object.freeze({
  omegaCruise: 10, omegaDrag: 26, omegaSettle: 4, omegaWatch: 10,
  settleFrom: 0.975,        // B14 start: the last settle into the hand-off pose
  holdRate: 0.012,          // p per second while holding Space / Fly (≈ 83 s for the whole story)
  idleEps: 1e-5,            // |p - target| and |v| below this: nothing to draw
});

const clamp01 = x => (x < 0 ? 0 : x > 1 ? 1 : x);

export function createClock(opts = {}) {
  const T = {...CLOCK_TUNE, ...(opts.tune || {})};
  const s = {p: clamp01(+opts.p || 0), target: clamp01(+opts.p || 0), v: 0, mode: "cruise", rate: 0, reduced: !!opts.reduced, rateFn: null};
  // review SC-4: a hold rate may follow the reading budget. setRate(fn) with fn(target) -> {rate, until}: the rate is constant
  // up to `until` (the next beat boundary), which the exact stepper treats as one more event, so p(t) stays exact
  const rateAtTarget = () => { const r = s.rateFn(s.target + 1e-12); s.rate = Number.isFinite(r.rate) ? r.rate : 0; s.until = Number.isFinite(r.until) ? r.until : Infinity; };

  const omega = () => (s.mode === "drag" ? T.omegaDrag : s.target >= T.settleFrom && s.mode !== "watch" ? T.omegaSettle
    : s.mode === "watch" ? T.omegaWatch : T.omegaCruise);

  /* exact advance over t seconds with constant ω and ramp r (no event inside the interval) */
  function advance(t) {
    if (t <= 0) return;
    const r = s.rate;
    if (s.reduced) { s.target = clamp01(s.target + r * t); s.p = s.target; s.v = 0; return; }
    const w = omega(), yss = -2 * r / w;
    const z0 = s.p - s.target - yss, dz0 = s.v - r;
    const e = Math.exp(-w * t), c = dz0 + w * z0;
    const z = (z0 + c * t) * e, dz = (dz0 - w * c * t) * e;
    s.target += r * t;
    s.p = s.target + yss + z;
    s.v = dz + r;
  }

  /* time until the ramping target reaches the next event: a bound (0 or 1) or the settle point */
  function nextEvent() {
    const r = s.rate;
    if (!r) return Infinity;
    let tE = r > 0 ? (1 - s.target) / r : s.target / -r;
    if (r > 0 && s.target < T.settleFrom) tE = Math.min(tE, (T.settleFrom - s.target) / r);
    if (r < 0 && s.target >= T.settleFrom) tE = Math.min(tE, (s.target - T.settleFrom) / -r + 1e-12);
    if (s.rateFn && r > 0 && s.until > s.target) tE = Math.min(tE, (s.until - s.target) / r);
    return Math.max(0, tE);
  }

  const clock = {
    tune: T,
    step(dt) {
      let rem = Number.isFinite(dt) && dt > 0 ? dt : 0;
      for (let guard = 0; rem > 0 && guard < 8; guard++) {
        const tE = nextEvent();
        if (tE >= rem) { advance(rem); rem = 0; break; }
        advance(tE); rem -= tE;
        if (s.target >= 1 - 1e-12 && s.rate > 0) { s.target = 1; s.rate = 0; }
        else if (s.target <= 1e-12 && s.rate < 0) { s.target = 0; s.rate = 0; }
        else if (Math.abs(s.target - T.settleFrom) < 1e-9) s.target = s.rate > 0 ? T.settleFrom : T.settleFrom - 1e-12;
        if (s.rateFn && s.rate > 0) rateAtTarget();
      }
      if (rem > 0) advance(rem);
      return clock.state;
    },
    setTarget(x, mode) { if (Number.isFinite(x)) s.target = clamp01(x); if (mode) clock.setMode(mode); if (s.reduced) s.p = s.target; return s.target; },
    nudge(dx, mode) { return clock.setTarget(s.target + (+dx || 0), mode); },
    jump(x) { s.p = s.target = clamp01(+x || 0); s.v = 0; return s.p; },
    setRate(r) { if (typeof r === "function") { s.rateFn = r; rateAtTarget(); } else { s.rateFn = null; s.rate = Number.isFinite(r) ? r : 0; } return s.rate; },
    setMode(m) { if (m === "cruise" || m === "drag" || m === "watch") s.mode = m; return s.mode; },
    setReduced(b) { s.reduced = !!b; if (s.reduced) { s.p = s.target; s.v = 0; } return s.reduced; },
    get state() {
      const p = clamp01(s.p);
      return {p, target: s.target, v: s.v, mode: s.target >= T.settleFrom && s.mode === "cruise" ? "settle" : s.mode,
        rate: s.rate, reduced: s.reduced, omega: omega(),
        idle: !s.rate && Math.abs(s.p - s.target) < T.idleEps && Math.abs(s.v) < T.idleEps};
    },
    get p() { return clamp01(s.p); },
    get target() { return s.target; },
  };
  return clock;
}

