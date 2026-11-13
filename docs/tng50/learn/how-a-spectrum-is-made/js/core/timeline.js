// Story timeline over p ∈ [0, 1] (DESIGN §2.3, D10; DESIGN_final §3.5). Pure: no DOM, no time.
//
// beats.json (schema story-beats/2) is the one timeline source; v1's steps.json timing (seconds per step) is replaced by
// p ranges, and v1's engine helpers are reused by import: engine.locate (binary search over contiguous items),
// engine.schemaErrors (the JSON Schema subset validator).
//
//   createTimeline(doc, {schema, shots}) -> tl
//     tl.beats                       frozen beat list
//     tl.locate(p)                   {beat, i, u}  (u ∈ [0, 1] inside the beat; p = 1 → last beat, u = 1)
//     tl.beatStarts()                sorted p0 of every beat, plus 1 (rail tick positions)
//     tl.readPoint(beat)             the beat's reading point: just inside its first line's full-opacity window
//     tl.readStarts()                reading point of every beat, plus 1 (PageDown / rail-tick and beat-chip landings)
//     tl.readAt(p)                   readPoint of the beat that starts at p (a rail tick), else p
//     tl.stops()                     reading point of every line + stop sub-ticks (B7b "stop k of n") + 1 (reduced-motion
//                                    stepping: every stop shows a sentence; review2 perf/a11y H1)
//     tl.cellStops() / setCellStops  Shift+arrow targets (set by seek.prepare from the data)
//     tl.watch                       {total, t0[], t1[], pAt(t), tAt(p)}  Watch schedule (2½ min)
//     tl.phase(u, item, beat)        kinetic phase −1..0..1 of a text / equation window (fades in p, meta.fadeP)
//     tl.validate()                  [] or a list of human-readable errors
//
// Reading-budget and one-group-per-band checks live in validate() so the node test and the page share them.

import {locate as engineLocate, schemaErrors} from "../engine.js";

const clamp01 = x => (x < 0 ? 0 : x > 1 ? 1 : x);
const smooth = x => { const t = clamp01(x); return t * t * (3 - 2 * t); };

export function createTimeline(doc, opts = {}) {
  const beats = Object.freeze((doc && doc.beats || []).map((b, i) => Object.freeze({...b, i})));
  const meta = (doc && doc.meta) || {};
  const items = beats.map((b, k) => ({k, index: k, id: b.id, t0: b.p0, t1: b.p1, dur: b.p1 - b.p0}));
  const tlv1 = {items};
  let cellStopList = [];

  function locate(p) {
    const x = Number.isFinite(p) ? clamp01(p) : 0;
    const r = engineLocate(tlv1, x);
    if (!r) return null;
    const b = beats[r.item.k], w = b.p1 - b.p0;
    return {beat: b, i: b.i, u: w > 0 ? clamp01(r.t / w) : 1};
  }
  // beats whose copy flag is false (beat.cond, evaluated by the shell) are skipped by PageDown and the rail
  let skip = () => false;
  const beatStarts = () => [...beats.filter(b => !(b.cond && skip(b))).map(b => b.p0), 1];
  /* reading points (review2 perf/a11y H1): a discrete jump (PageDown, rail tick, beat chip, reduced-motion step) must land
     where a sentence is on screen, not on the beat boundary where the band is still empty. A line is readable from u0 (phase
     0) to u1; the landing sits a little inside that window (≤ 0.0015 p, ≤ a quarter of it) so the cruise spring's last
     approach from below is already at full opacity. Lines with an alt or a variant are not used (they may be hidden). A line
     with its own cond is used when that cond holds for this ray (the same skip() the shell uses; fix3 SC3-3: such lines are
     on screen, so they get hold-to-play, reading points, reduced-motion stops and the detent like any other). A line whose
     cond is the beat's own is always used (the beat is skipped when it is false). */
  const plainBase = (t, b) => t && (!t.when || t.when === "default") && !t.alt && (t.band === "text" || t.band === "act");
  const shownLine = (t, b) => !t.cond || t.cond === b.cond || !skip({cond: t.cond});
  const plain = (t, b) => plainBase(t, b) && shownLine(t, b);
  const inside = (b, t) => { const w = b.p1 - b.p0, a = b.p0 + w * t.u0, c = b.p0 + w * t.u1;
    if (t.u0 <= 0 && t.fadeIn === 0) return b.p0;
    return Math.min(a + Math.min(0.0015, 0.25 * (c - a)), b.p1); };
  function readPoint(b) {
    const t = (b.text || []).filter(t => plain(t, b)).sort((x, y) => x.u0 - y.u0)[0];
    if (t) return inside(b, t);
    const e = (b.eqs || []).slice().sort((x, y) => x.u0 - y.u0)[0];
    return e ? inside(b, e) : b.p0;
  }
  const live = () => beats.filter(b => !(b.cond && skip(b)));
  const readStarts = () => [...live().map(readPoint), 1];
  const readAt = p => { const b = beats.find(x => Math.abs(x.p0 - p) < 1e-6); return b ? readPoint(b) : p; };
  function stops() {
    const s = new Set();
    for (const b of live()) {
      const lines = (b.text || []).filter(t => plain(t, b));
      s.add(+readPoint(b).toFixed(6));
      for (const t of lines) s.add(+inside(b, t).toFixed(6));
    }
    for (const b of beats) if (b.stops && b.stops.n > 1) for (let k = 1; k < b.stops.n; k++) s.add(+(b.p0 + (b.p1 - b.p0) * k / b.stops.n).toFixed(6));
    s.add(1);
    return [...s].sort((a, c) => a - c);
  }

  /* Watch schedule (review2 scrolly A2). Beat totals start from watch_s (or the p-width share of watchTotal_s). Inside a beat
     time is no longer proportional to p: every plain caption's full-opacity window gets words/3 + 1 s (overlapping windows
     are merged and their needs summed), and the travel between captions takes what is left, shared by p-width with a floor
     of WATCH_GAP_S per gap. A beat whose captions need more than its watch_s is lengthened by the shortfall (312 s -> about
     330 s for the default story). pAt/tAt are piecewise linear over these knots and exact inverses. */
  const total = meta.watchTotal_s || 150;
  const fixed = beats.reduce((a, b) => a + (b.watch_s || 0), 0), freeW = beats.reduce((a, b) => a + (b.watch_s ? 0 : b.p1 - b.p0), 0);
  const base = beats.map(b => b.watch_s || Math.max(0, total - fixed) * (b.p1 - b.p0) / (freeW || 1));
  const WATCH_WPS = 3, WATCH_PAD_S = 1, WATCH_GAP_S = 0.6;
  // full-opacity windows per beat (plain lines with a word count), merged where they overlap
  const fullWins = beats.map(b => {
    const w = b.p1 - b.p0, out = [];
    for (const t of b.text || []) {
      if (!(t.words > 0) || !plainBase(t, b)) continue;   // built once, before setSkip: a line with its own cond counts
      const a = Math.max(b.p0, b.p0 + w * t.u0), c = Math.min(b.p1, b.p0 + w * t.u1);
      if (c > a) out.push({a, c, need: t.words / WATCH_WPS + WATCH_PAD_S});
    }
    out.sort((x, y) => x.a - y.a);
    const m = [];
    for (const x of out) { const l = m[m.length - 1]; if (l && x.a <= l.c + 1e-12) { l.c = Math.max(l.c, x.c); l.need += x.need; } else m.push({...x}); }
    return m;
  });
  const gapsOf = (b, wins) => { const g = []; let x = b.p0; for (const w of wins) { g.push([x, w.a]); x = w.c; } g.push([x, b.p1]); return g.filter(([a, c]) => c - a > 1e-9); };
  const needB = beats.map((b, i) => fullWins[i].reduce((a, w) => a + w.need, 0) + WATCH_GAP_S * gapsOf(b, fullWins[i]).length);
  // a beat whose captions (plus the travel floors) need more than its watch_s is lengthened; no beat is shortened (each
  // keeps its reading budget for words outside the captions: equations, alternatives), so the total may exceed watchTotal_s
  const dur = base.map((d, i) => Math.max(d, needB[i]));
  const t0 = [], t1 = []; let acc = 0;
  for (const d of dur) { t0.push(acc); acc += d; t1.push(acc); }
  // knots (p, t) per beat
  const knots = beats.map((b, i) => {
    const wins = fullWins[i], gaps = gapsOf(b, wins), d = dur[i];
    let capT = wins.reduce((a, w) => a + w.need, 0), gapT = d - capT;
    const capScale = gapT < WATCH_GAP_S * gaps.length && capT > 0 ? Math.max(0, d - WATCH_GAP_S * gaps.length) / capT : 1;
    capT *= capScale; gapT = d - capT;
    const gw = gaps.reduce((a, [x, y]) => a + (y - x), 0), floorT = Math.min(WATCH_GAP_S, gaps.length ? gapT / gaps.length : 0);
    const extra = Math.max(0, gapT - floorT * gaps.length);
    const gapDur = ([x, y]) => floorT + (gw > 0 ? extra * (y - x) / gw : 0);
    const kp = [b.p0], kt = [t0[i]]; let x = b.p0, t = t0[i];
    const segs = [];
    for (const w of wins) { if (w.a - x > 1e-9) segs.push({a: x, c: w.a, dt: gapDur([x, w.a])}); segs.push({a: w.a, c: w.c, dt: w.need * capScale}); x = w.c; }
    if (b.p1 - x > 1e-9) segs.push({a: x, c: b.p1, dt: gapDur([x, b.p1])});
    const sum = segs.reduce((a, s) => a + s.dt, 0) || 1;
    for (const s of segs) { t += s.dt * d / sum; kp.push(s.c); kt.push(t); }
    if (kp.length === 1) { kp.push(b.p1); kt.push(t1[i]); }
    kt[kt.length - 1] = t1[i]; kp[kp.length - 1] = b.p1;
    return {kp, kt};
  });
  const interp = (xs, ys, v) => { let j = 1; while (j < xs.length - 1 && v > xs[j]) j++; const a = xs[j - 1], c = xs[j];
    return c > a ? ys[j - 1] + (ys[j] - ys[j - 1]) * clamp01((v - a) / (c - a)) : ys[j]; };
  const watch = {
    total: acc, t0, t1, dur, knots,
    pAt(t) {
      if (!(t > 0)) return 0; if (t >= acc) return 1;
      let i = 0; while (i < beats.length - 1 && t >= t1[i]) i++;
      return interp(knots[i].kt, knots[i].kp, t);
    },
    tAt(p) { const L = locate(p); if (!L) return 0; const b = beats[L.i]; return interp(knots[L.i].kp, knots[L.i].kt, b.p0 + (b.p1 - b.p0) * L.u); },
  };

  /* phase of a window [u0, u1] with fades given in p (meta.fadeP) converted to u by the beat width */
  function phase(u, item, beat) {
    const w = Math.max(1e-9, beat.p1 - beat.p0), fp = meta.fadeP ?? 0.005;
    const fi = (item.fadeIn ?? fp) / w, fo = (item.fadeOut ?? fp) / w;
    if (u < item.u0) return fi > 0 ? -(1 - smooth((u - (item.u0 - fi)) / fi)) : -1;
    if (u <= item.u1) return 0;
    return fo > 0 ? smooth((u - item.u1) / fo) : (item.fadeOut === 0 && item.u1 >= 1 ? 0 : 1);
  }
  /* p interval over which an item is at least partly visible */
  function window_(item, beat) {
    const w = beat.p1 - beat.p0, fp = meta.fadeP ?? 0.005;
    return [beat.p0 + w * item.u0 - (item.fadeIn ?? fp), beat.p0 + w * item.u1 + (item.fadeOut ?? fp)];
  }

  function validate() {
    const errs = [];
    if (opts.schema) errs.push(...schemaErrors(opts.schema, doc));
    if (!beats.length) { errs.push("no beats"); return errs; }
    if (Math.abs(beats[0].p0) > 1e-12) errs.push("first beat must start at p = 0");
    if (Math.abs(beats[beats.length - 1].p1 - 1) > 1e-12) errs.push("last beat must end at p = 1");
    const ids = new Set();
    beats.forEach((b, i) => {
      if (ids.has(b.id)) errs.push(`${b.id}: duplicate id`); ids.add(b.id);
      if (!(b.p1 > b.p0)) errs.push(`${b.id}: p1 must exceed p0`);
      if (i > 0 && Math.abs(beats[i - 1].p1 - b.p0) > 1e-12) errs.push(`${b.id}: not contiguous with ${beats[i - 1].id}`);
      if (opts.shots && !(opts.shots.shots || {})[b.shot]) errs.push(`${b.id}: unknown shot ${b.shot}`);
      const tfu = b.tf.map(k => k.u); if (tfu.some((u, j) => j && u < tfu[j - 1])) errs.push(`${b.id}: tf keys not sorted`);
      if (b.tf[0].u !== 0) errs.push(`${b.id}: first tf key must be at u = 0`);
      if (Array.isArray(b.dock) && b.dock[0].u !== 0) errs.push(`${b.id}: first dock key must be at u = 0`);
      if (b.kind === "stop" && b.l0 !== b.l1) errs.push(`${b.id}: a stop holds ℓ`);
      if (b.kind === "flight" && b.l0 === b.l1) errs.push(`${b.id}: a flight must move ℓ`);
      for (const t of b.text) {
        if (!(t.u1 >= t.u0)) errs.push(`${b.id}/${t.id}: u1 < u0`);
        const [a, c] = window_(t, b);
        if (a < b.p0 - 1e-9 || c > b.p1 + 1e-9) errs.push(`${b.id}/${t.id}.${t.part}: fades leave the beat (${a.toFixed(4)}–${c.toFixed(4)} vs ${b.p0}–${b.p1})`);
      }
      if (i > 0) {   // continuity of the visual state across the boundary
        const pb = beats[i - 1];
        const lastTf = pb.tf[pb.tf.length - 1], firstTf = b.tf[0];
        if (lastTf.preset !== firstTf.preset) errs.push(`${b.id}: tf starts at ${firstTf.preset}, ${pb.id} ends at ${lastTf.preset}`);
        const endDock = Array.isArray(pb.dock) ? pb.dock[pb.dock.length - 1].state : pb.dock;
        const startDock = Array.isArray(b.dock) ? b.dock[0].state : b.dock;
        if (endDock !== startDock) errs.push(`${b.id}: dock starts ${startDock}, ${pb.id} ends ${endDock}`);
        const lEnd = pb.kind === "flight" ? pb.l1 : pb.l0;
        if (lEnd !== b.l0) errs.push(`${b.id}: ℓ starts at ${b.l0}, ${pb.id} ends at ${lEnd}`);
      }
    });
    // one kinetic group per band at any p, with a gap ≥ meta.groupGapP between consecutive groups (conditional variants of
    // the same slot, "when", are alternatives and share a slot)
    const gap = meta.groupGapP ?? 0.004;
    for (const band of ["act", "text"]) {
      const wins = [];
      for (const b of beats) for (const t of b.text) if (t.band === band && (!t.when || t.when === "default") && !t.alt) wins.push({id: `${b.id}/${t.id}.${t.part}`, w: window_(t, b)});
      wins.sort((a, c) => a.w[0] - c.w[0]);
      for (let k = 1; k < wins.length; k++) {
        const g = wins[k].w[0] - wins[k - 1].w[1];
        if (g < gap - 1e-9) errs.push(`band ${band}: ${wins[k - 1].id} → ${wins[k].id} gap ${g.toFixed(4)} < ${gap}`);
      }
    }
    return errs;
  }

  /* reading budget (C_ux P1-1): each beat's Watch time must cover its words at `wps` words/s plus `pad` s, and each beat
     with words or interactions must span ≥ minNotches mouse notches of p (1/120 each) so a wheel cannot skip it.
     words: {beatId: count}. Returns a list of shortfalls. */
  function readingBudget(words, o = {}) {
    const wps = o.wps ?? 3, pad = o.pad ?? 1, notch = o.notch ?? 1 / 120;
    const out = [];
    beats.forEach((b, i) => {
      const n = words[b.id] || 0, need = n / wps + (n ? pad : 0);
      if (watch.dur[i] + 1e-9 < need) out.push(`${b.id}: Watch ${watch.dur[i].toFixed(1)} s < ${need.toFixed(1)} s for ${n} words`);
      const inter = b.interactions.filter(x => !["scrub", "hold", "watch", "skip", "readAsText", "orbit"].includes(x)).length;
      const minN = inter ? 3 : n ? 2 : 0;
      if ((b.p1 - b.p0) + 1e-9 < minN * notch) out.push(`${b.id}: ${((b.p1 - b.p0) / notch).toFixed(1)} notches < ${minN}`);
    });
    return out;
  }

  /* caption reading windows for hold-to-fly (review2 scrolly #2): each plain line with `words` (beats.json, generated from
     copy.json) spans [start of its fade-in, end of its full-opacity window] in p, and its full-opacity part must last
     words / wps seconds. captionRate(x) -> {rate (p/s) or Infinity outside every window, until}: piecewise constant, so
     the clock's exact stepper stays exact. Overlapping windows (an act title over a band line) take the slower rate. */
  const capWins = [];
  for (const b of beats) for (const t of b.text || []) {
    if (!(t.words > 0) || !plainBase(t, b)) continue;
    const w = b.p1 - b.p0, fp = meta.fadeP ?? 0.005, a = b.p0 + w * t.u0, c = b.p0 + w * t.u1;
    capWins.push({p0: Math.max(b.p0, a - (t.fadeIn ?? fp)), p1: c, full: c - a, words: t.words, beat: b, line: t});
  }
  const capEdges = [...new Set(capWins.flatMap(x => [x.p0, x.p1]))].sort((a, c) => a - c);
  function captionRate(x, wps = 4) {
    let rate = Infinity;
    for (const c of capWins) if (x >= c.p0 && x < c.p1 && !(c.beat.cond && skip(c.beat)) && shownLine(c.line, c.beat)) rate = Math.min(rate, Math.max(c.full, 1e-6) / (c.words / wps));
    let until = Infinity; for (const e of capEdges) if (e > x + 1e-12) { until = e; break; }
    return {rate, until};
  }

  return {
    captionRate, captions: () => capWins.filter(c => shownLine(c.line, c.beat)).map(({beat, line, ...c}) => ({...c, beat: beat.id, id: line.id})),
    beats, meta, locate, beatStarts, readPoint, readStarts, readAt, stops, watch, phase, windowOf: window_, validate, readingBudget,
    cellStops: () => cellStopList,
    setSkip(fn) { skip = typeof fn === "function" ? fn : () => false; },
    setCellStops(list) { cellStopList = [...list].filter(Number.isFinite).sort((a, b) => a - b); return cellStopList; },
    byId: id => beats.find(b => b.id === id) || null,
  };
}
