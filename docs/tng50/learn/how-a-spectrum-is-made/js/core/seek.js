// seek(p, data, overrides) -> FrameState (DESIGN_final §5.11, frozen interface). PURE: no DOM, no time, no Math.random.
// The same p always gives the same frame (gate G8): Watch, the film, reduced-motion stills and the tests all call it.
// Derived structures (ray frame, warps, cell lookup) are memoised per data object, which does not change the result.
//
//   configure({beats, shots, schema?})          set the timeline used by the module-level seek()
//   makeSeek({beats, shots}) -> seek            an independent seek bound to one beats/shots pair (tests, film)
//   prepare(data, beats, shots) -> ctx          the memoised derived context (ray frame, warps, cells, timeline)
//   exposeStory(win, {seek, clock, timeline, data, overrides, rects, quality})   window.__story for tests and the film
//
// FrameState (DESIGN_final §5.11; fields marked + are additions that consumers may ignore):
//   p, beat {id, i, u, kind+, stop {k, n} | null}, l (probe ℓ, kpc, time-warped),
//   cell {idx, w} | null           ray cell under the probe; w = kernel CDF weight at ℓ
//   cloud {id, letter, enter} | null
//   cam {pos, target, up, fov, near, textSide, sideFrom+, sideMix+, roll+}
//   capsule {l0, l1, r, edge}      travelling carve-out (D4)
//   quality "flight" | "stop"      (the stage's governor maps these onto mobile / stills)
//   tf {from, to, mix, focusR, darkSky, gain+}
//   fields [{name, level}]         residency hint (current beat + beats whose prefetch lead has started)
//   shells [{id, alpha, open}]
//   text [{id, band, phase, part+, anchor+, cond+, alt+}]  one kinetic group per band (alt slots replace the previous one)
//   eqs [{id, anchor {kind, ref}, hl [termIds], ghost {term, value} | null, phase+}]
//   spec {dock, dockFrom+, dockMix+, mode, ions, lead, R, sn, seed}
//   ui {freeLook, look, inset}     inset > 0 only when overrides.cls is a phone class
//
// Overrides: {R, sn, ion, tf, T125, T263, N492, iso, galaxy, ray, seed+, cls+}. The time warp and the camera never read
// them; R and S/N overrides apply from B12a on (the R slider is live from there), ion/tf everywhere. cls (the layout
// class from js/ui/layoutclass.js) is a presentation input, not a physics override: it picks shots.json classMods (a
// phone gets its own framing) and gates ui.inset.

import {createTimeline} from "./timeline.js";
import {buildWarp} from "./timewarp.js";
import {rayFrame, evalCamera, smoothstep, smootherstep, lval} from "./shots.js";

export const SEEK_VERSION = 2;
export const CAPSULE = Object.freeze({half: 45, rMin: 20, edge: 0.3});   // edge: soft-edge fraction (stage capF)
export const SHELL = Object.freeze({approach: 15, exitFade: 10, after: 0.25});
const PHONE = new Set(["phonePortrait", "phoneLandscape", "narrow"]);
const clamp01 = x => (x < 0 ? 0 : x > 1 ? 1 : x);

/* ---------------- data access (story-data/2 with v1 fallbacks) ---------------- */
/* story-data/2: positions along the ray come from geometry.cells (lc, s_in, s_out, centre, h, d; sorted by lc, same
   order as ions.*.cells); ions.*.cells.l_kpc is v1's yt l + dl/2 − half, off by up to 3.2 kpc (geometry.conventions),
   used only when there is no geometry block */
function cellsOf(data, ion) {
  const ic = (data && data.ions && data.ions[ion] && data.ions[ion].cells) || (data && data.cells) || {};
  const g = data && data.geometry && data.geometry.cells;
  const n0 = (ic.tau0 || ic.l_kpc || ic.l || []).length;
  const src = g && Array.isArray(g.lc) && g.lc.length === n0
    ? {...ic, l: g.lc, l_kpc: null, s_in: g.s_in, s_out: g.s_out, idx: g.idx, h: g.h, d: g.d,
       centre: Array.isArray(g.centre) && g.centre.length === 3 * n0 && !Array.isArray(g.centre[0])
         ? Array.from({length: n0}, (_, i) => [g.centre[3 * i], g.centre[3 * i + 1], g.centre[3 * i + 2]]) : g.centre}
    : ic;
  const l = src.l_kpc || src.l || [];
  const n = l.length;
  // story-data/2 sorts cells by ℓ; v1 did not, so keep a sorted view either way
  const order = [...Array(n).keys()].sort((a, b) => l[a] - l[b]);
  const pick = arr => (arr ? order.map(i => +arr[i]) : null);
  const idx = src.idx ? order.map(i => src.idx[i]) : order.slice();
  return {
    n, order, idx, l: pick(l), tau0: pick(src.tau0) || new Array(n).fill(0), dl: pick(src.dl_kpc || src.dl),
    s_in: pick(src.s_in), s_out: pick(src.s_out), centre: src.centre ? order.map(i => src.centre[i]) : null,
    h: pick(src.h), d: pick(src.d), geo: src !== ic,
  };
}
function rayOf(data, beatsDoc) {
  // story-data/2 geometry.ray is in the disk frame (xhat, yhat, Lhat), the stage's world frame: Lhat = +z there
  const gr = data && data.geometry && data.geometry.ray;
  if (gr && gr.p0 && gr.p1) return {ray: {p0: gr.p0, p1: gr.p1, n: gr.n, zdisk: gr.zdisk || [0, 0, 1]}, fallback: false, frame: "disk"};
  const r = data && (data.ray || (data.meta && data.meta.ray && typeof data.meta.ray === "object" ? data.meta.ray : null));
  if (r && r.p0 && r.p1) return {ray: {p0: r.p0, p1: r.p1, n: r.n, zdisk: r.zdisk || (r.frame && r.frame.zdisk)}, fallback: false};
  const m = (beatsDoc && beatsDoc.meta) || {}, g = data && data.meta;
  if (m.refRayGeom && g && String(g.galaxy) === String(m.refGalaxy) && String(g.ray) === String(m.refRay))
    return {ray: m.refRayGeom, fallback: "refRayGeom"};
  const half = (g && g.half_kpc) || m.refHalf || 250, n = (g && g.n_los) || [0, 1, 0];
  const b = (g && g.b_kpc) || 0;
  // no geometry: a ray through (b, 0, 0) along n_los (honest fallback; story-lite states it)
  const off = [b, 0, 0];
  return {ray: {p0: [off[0] - n[0] * half, off[1] - n[1] * half, off[2] - n[2] * half], p1: [off[0] + n[0] * half, off[1] + n[1] * half, off[2] + n[2] * half]}, fallback: "synthetic"};
}
/* kernel CDF table {x: [...], F: [...]} on the chord fraction (story-data/2 kernel_cdf); fallback smoothstep */
/* story-data/2 geometry.kernel_cdf: W(q, u) on a linear (q, u) grid, bilinear; q = d/h, u = (ℓ − lc)/c, c = √(h² − d²) */
function kernelTable(data) {
  const k = data && data.geometry && data.geometry.kernel_cdf;
  if (!k || !Array.isArray(k.q) || !Array.isArray(k.u) || !Array.isArray(k.table) || k.table.length !== k.q.length) return null;
  const Q = k.q, U = k.u, T = k.table;
  const at = (A, x) => { const n = A.length; if (x <= A[0]) return [0, 0]; if (x >= A[n - 1]) return [n - 2, 1];
    let lo = 0, hi = n - 1; while (hi - lo > 1) { const m = (lo + hi) >> 1; if (A[m] <= x) lo = m; else hi = m; }
    return [lo, (x - A[lo]) / (A[lo + 1] - A[lo])]; };
  return (q, u) => { const [i, a] = at(Q, q), [j, b] = at(U, u);
    return (1 - a) * ((1 - b) * T[i][j] + b * T[i][j + 1]) + a * ((1 - b) * T[i + 1][j] + b * T[i + 1][j + 1]); };
}
function kernelCdf(data) {
  const k = data && data.kernel_cdf;
  if (k && k.x && k.F && k.x.length === k.F.length && k.x.length > 1) {
    const x = k.x, F = k.F, N = x.length;
    return t => { if (t <= x[0]) return 0; if (t >= x[N - 1]) return 1;
      let lo = 0, hi = N - 1; while (hi - lo > 1) { const m = (lo + hi) >> 1; if (x[m] <= t) lo = m; else hi = m; }
      return F[lo] + (F[hi] - F[lo]) * (t - x[lo]) / (x[hi] - x[lo]); };
  }
  return t => smoothstep(t);
}
/* clouds: story-data/2 {path, schema, summary: {ion: {clouds: [{id, l: [a, b], open}]}}} plus cloud_names.letters
   {A: {ion: [{id}]}}; older shapes (a list with l_in/l_out, names {A: ids}) still read */
function cloudsOf(data) {
  const c = data && data.clouds;
  let list = Array.isArray(c) ? c : c && Array.isArray(c.clouds) ? c.clouds : c && Array.isArray(c.list) ? c.list : [];
  if (!list.length && c && c.summary && typeof c.summary === "object")
    list = Object.values(c.summary).flatMap(s => (s && Array.isArray(s.clouds) ? s.clouds : [])).filter(x => Array.isArray(x.l))
      .map(x => ({...x, l_in: +x.l[0], l_out: +x.l[1]}));
  const nm = (data && data.cloud_names) || {};
  const names = nm.letters && typeof nm.letters === "object"
    ? Object.fromEntries(Object.entries(nm.letters).map(([k, v]) => [k, Object.values(v || {}).flat()])) : nm;
  const letterOf = id => { for (const [letter, v] of Object.entries(names)) { const ids = Array.isArray(v) ? v : v && v.ids ? v.ids : [v && v.id];
    if (ids.some(x => (x && x.id !== undefined ? x.id : x) === id)) return letter; } return null; };
  return list.filter(x => Number.isFinite(x.l_in) && Number.isFinite(x.l_out)).map(x => ({
    id: x.id, letter: x.letter || letterOf(x.id), l_in: Math.min(x.l_in, x.l_out), l_out: Math.max(x.l_in, x.l_out),
    open: !!(x.open || x.warmHot || x.warm_hot), r: +x.r_shell || +x.r || 0}));
}

/* ---------------- memoised context ---------------- */
const MEMO = new WeakMap();
export function prepare(data, beatsDoc, shotsDoc) {
  const key = data || {};
  let per = MEMO.get(key); if (!per) { per = new Map(); MEMO.set(key, per); }
  const k2 = beatsDoc; let ctx = per.get(k2);
  if (ctx && ctx.shotsDoc === shotsDoc) return ctx;
  const tl = createTimeline(beatsDoc, {shots: shotsDoc});
  const refHalf = (beatsDoc.meta && beatsDoc.meta.refHalf) || 246.35;
  const half = (data && data.geometry && data.geometry.ray && +data.geometry.ray.half) || (data && data.meta && data.meta.half_kpc) || refHalf;
  const lscale = half / refHalf;
  const {ray, fallback} = rayOf(data, beatsDoc);
  const frame = rayFrame(ray);
  const cells = {OVI: cellsOf(data, "OVI"), HI: cellsOf(data, "HI")};
  const warps = {};
  const warp = ion => (warps[ion] || (warps[ion] = buildWarp({l: cells[ion].l, tau0: cells[ion].tau0, dl: cells[ion].dl,
    s_in: cells[ion].s_in, s_out: cells[ion].s_out}, {lmin: -half - 10, lmax: half + 10})));
  const base = cells.OVI.n ? cells.OVI : cells.HI;
  const posOf = new Map(); base.idx.forEach((id, j) => posOf.set(+id, j));
  const cellPos = id => { const j = posOf.has(+id) ? posOf.get(+id) : -1;
    if (j < 0) return frame.P(0);
    return base.centre ? base.centre[j].slice(0, 3) : frame.P(base.l[j]); };
  const cellL = id => { const j = posOf.get(+id); return j === undefined ? 0 : base.l[j]; };
  const cdf = kernelCdf(data), ktab = kernelTable(data);
  const clouds = cloudsOf(data);
  const capR = Math.max(CAPSULE.rMin, ...clouds.filter(c => c.letter === "A" || c.letter === "D").map(c => c.r || 0));
  ctx = {tl, shotsDoc, beatsDoc, lscale, half, frame, rayFallback: fallback, cells, base, warp, cellPos, cellL, cdf, ktab, clouds, capR, posOf};
  ctx.cellStops = computeCellStops(ctx);
  tl.setCellStops(ctx.cellStops);
  per.set(k2, ctx);
  return ctx;
}

/* ℓ of beat b at fraction u */
function lOfBeat(ctx, b, u) {
  if (b.kind === "stop" && b.cell != null) return ctx.cellL(b.cell);
  const l0 = lval(b.l0, 0, ctx.lscale), l1 = lval(b.l1, 0, ctx.lscale);
  if (b.kind !== "flight") return l0;
  const lu = b.lu || [0, 1], v = clamp01((u - lu[0]) / Math.max(1e-9, lu[1] - lu[0]));
  return ctx.warp(b.ion).lOf(l0, l1, v);
}
/* Shift+arrow cell stops: in beats with cellStops, the cells holding ≥ 10 % of the beat's peak τ₀ of its lead ion */
function computeCellStops(ctx) {
  const out = [];
  for (const b of ctx.tl.beats) {
    if (!b.cellStops || b.kind !== "flight") continue;
    const c = ctx.cells[b.ion]; if (!c.n) continue;
    const l0 = lval(b.l0, 0, ctx.lscale), l1 = lval(b.l1, 0, ctx.lscale), lo = Math.min(l0, l1), hi = Math.max(l0, l1);
    let peak = 0; for (let j = 0; j < c.n; j++) if (c.l[j] >= lo && c.l[j] <= hi) peak = Math.max(peak, c.tau0[j]);
    if (!(peak > 0)) continue;
    const lu = b.lu || [0, 1];
    for (let j = 0; j < c.n; j++) if (c.l[j] >= lo && c.l[j] <= hi && c.tau0[j] >= 0.1 * peak) {
      const u = lu[0] + (lu[1] - lu[0]) * ctx.warp(b.ion).uOf(l0, l1, c.l[j]);
      out.push(+(b.p0 + (b.p1 - b.p0) * u).toFixed(6));
    }
  }
  return [...new Set(out)].sort((a, b) => a - b);
}

/* cell under the probe: among cells whose chord contains ℓ, the one that adds most to the beat ion's optical depth here
   (review M3: τ0 times the kernel's weight near the probe, (1 − d²) with d the distance from the chord centre in half
   chords), so inside a cloud the plaque shows the cool cell that makes the dip, not a large hot neighbour whose chord also
   covers the probe; without τ0 the nearest chord centre wins (v1 rule). w = kernel CDF of the chord fraction */
function cellAt(ctx, ion, l) {
  const c = ctx.cells[ion]; if (!c.n) return null;
  let best = -1, bestS = -Infinity, bestT = 0;
  for (let j = 0; j < c.n; j++) {
    const a = c.s_in ? c.s_in[j] : c.l[j] - (c.dl ? c.dl[j] / 2 : 0.5), b = c.s_out ? c.s_out[j] : c.l[j] + (c.dl ? c.dl[j] / 2 : 0.5);
    if (l < a || l > b || !(b > a)) continue;
    const d = Math.abs(l - (a + b) / 2) / ((b - a) / 2), t0 = c.tau0 ? +c.tau0[j] : NaN;
    let sc = Number.isFinite(t0) && t0 > 0 ? Math.log(t0) + Math.log(Math.max(1e-3, 1 - d * d)) : -1e9 - d;
    // review F1: with the exporter's kernel table, the score is the cell's real local contribution τ0 · dW/dℓ (the same
    // kernel the spectrum uses), so the plaque, the probe anchor and the dock connector name the cell that makes the dip
    if (ctx.ktab && c.h && c.d && Number.isFinite(t0) && t0 > 0) {
      const h = c.h[j], dd = c.d[j], cc = Math.sqrt(Math.max(1e-12, h * h - dd * dd)), x = (l - c.l[j]) / cc;
      if (Math.abs(x) < 1) { const q = Math.min(1, dd / h), x0 = Math.max(-1, x - 0.01), x1 = Math.min(1, x + 0.01);
        const dW = (ctx.ktab(q, x1) - ctx.ktab(q, x0)) / ((x1 - x0) * cc);
        sc = dW > 0 ? Math.log(t0 * dW) : -1e6 - d; }
    }
    if (sc > bestS) { bestS = sc; best = j; bestT = (l - a) / (b - a); }
  }
  if (best < 0) return null;
  if (ctx.ktab && c.h && c.d) {   // story-data/2: the exporter's own kernel weight W_i(ℓ) (same table as the spectrum)
    const h = c.h[best], d = c.d[best], cc = Math.sqrt(Math.max(1e-12, h * h - d * d));
    return {idx: c.idx[best], w: ctx.ktab(Math.min(1, Math.max(0, d / h)), Math.min(1, Math.max(-1, (l - c.l[best]) / cc)))};
  }
  return {idx: c.idx[best], w: ctx.cdf(bestT)};
}

/* keyed value at u: a number, or [{u, v}] interpolated (log when both ends > 0 and log is set) */
function keyed(spec, u, log) {
  if (spec == null) return null;
  if (typeof spec === "number") return spec;
  if (!spec.length) return null;
  if (u <= spec[0].u) return spec[0].v;
  for (let k = 1; k < spec.length; k++) if (u <= spec[k].u) {
    const a = spec[k - 1], b = spec[k], t = smoothstep((u - a.u) / Math.max(1e-9, b.u - a.u));
    return log && a.v > 0 && b.v > 0 ? Math.exp(Math.log(a.v) + (Math.log(b.v) - Math.log(a.v)) * t) : a.v + (b.v - a.v) * t;
  }
  return spec[spec.length - 1].v;
}
function tfAt(b, u) {
  const K = b.tf; let i = 0; while (i < K.length - 1 && u >= K[i + 1].u) i++;
  const a = K[i], c = K[i + 1];
  // tf.chip (+): the HUD label id when it differs from the preset (B11-B13 "composite" = phases drawn with every cloud shell)
  if (!c || a.preset === c.preset && (a.focusR ?? null) === (c.focusR ?? null) && (a.gain ?? 1) === (c.gain ?? 1) && !!a.darkSky === !!c.darkSky && (a.chip ?? null) === (c.chip ?? null))
    return {from: a.preset, to: a.preset, mix: 1, focusR: a.focusR ?? null, darkSky: !!a.darkSky, gain: a.gain ?? 1, chip: a.chip ?? a.preset};
  const t = smoothstep((u - a.u) / Math.max(1e-9, c.u - a.u));
  const fr = a.focusR == null && c.focusR == null ? null : (a.focusR ?? c.focusR) + ((c.focusR ?? a.focusR) - (a.focusR ?? c.focusR)) * t;
  return {from: a.preset, to: c.preset, mix: t, focusR: fr, darkSky: t < 0.5 ? !!a.darkSky : !!c.darkSky, gain: (a.gain ?? 1) + ((c.gain ?? 1) - (a.gain ?? 1)) * t,
    chip: t < 0.5 ? a.chip ?? a.preset : c.chip ?? c.preset};
}
function dockAt(b, u) {
  if (!Array.isArray(b.dock)) return {dock: b.dock, dockFrom: b.dock, dockMix: 1};
  const K = b.dock;
  if (K.length === 1) return {dock: K[0].state, dockFrom: K[0].state, dockMix: 1};
  let i = 0; while (i < K.length - 1 && u >= K[i + 1].u) i++;
  if (i >= K.length - 1) return {dock: K[i].state, dockFrom: K[i].state, dockMix: 1};
  const t = smootherstep((u - K[i].u) / Math.max(1e-9, K[i + 1].u - K[i].u));
  return {dock: K[i + 1].state, dockFrom: K[i].state, dockMix: t};
}
function shellsAt(ctx, b, l) {
  if (b.shells === "none" || !ctx.clouds.length) return [];
  return ctx.clouds.map(c => {
    let alpha;
    if (b.shells === "all") alpha = 1;
    else if (l < c.l_in) alpha = smoothstep(1 - (c.l_in - l) / SHELL.approach);
    else if (l <= c.l_out) alpha = 1;
    else alpha = SHELL.after + (1 - SHELL.after) * (1 - smoothstep((l - c.l_out) / SHELL.exitFade));
    return {id: c.id, alpha, open: c.open};
  }).filter(s => s.alpha > 0);
}
function cloudAt(ctx, l) {
  let best = null;
  for (const c of ctx.clouds) {
    let enter = 0;
    if (l >= c.l_in && l <= c.l_out) enter = 1;
    else if (l < c.l_in && c.l_in - l < SHELL.approach) enter = smoothstep(1 - (c.l_in - l) / SHELL.approach);
    if (enter > 0 && (!best || enter > best.enter)) best = {id: c.id, letter: c.letter, enter};
  }
  return best;
}
function whenOk(when, data, ov) {
  if (!when || when === "default") {
    return !(whenOk("T263>hot", data, ov) || whenOk("T263<cool", data, ov));
  }
  const T = ov && Number.isFinite(ov.T263) ? ov.T263 : null;
  if (T == null) return false;
  if (when === "T263>hot") { const h = fadeT(data, "ovi_T_hot_fade"); return h != null && T > h; }
  if (when === "T263<cool") { const c = fadeT(data, "ovi_T_cool_fade"); return c != null && T < c; }
  return false;
}
/* fade temperature in K: the number in facts2 (story-data/2); keys hold the display string ("3.9×10⁵"),
   parsed only as a fallback */
const SUP = {"⁰": 0, "¹": 1, "²": 2, "³": 3, "⁴": 4, "⁵": 5, "⁶": 6, "⁷": 7, "⁸": 8, "⁹": 9};
function fadeT(data, k) {
  const f = data && data.facts2 && data.facts2[k];
  if (Number.isFinite(f)) return f;
  const s = data && data.keys && data.keys[k];
  if (Number.isFinite(+s)) return +s;
  const m = typeof s === "string" && s.match(/^([\d.]+)\s*[×x]\s*10([⁻-]?)([⁰¹²³⁴⁵⁶⁷⁸⁹]+)$/);
  if (!m) return null;
  const e = [...m[3]].reduce((a, c) => 10 * a + SUP[c], 0);
  return +m[1] * 10 ** (m[2] ? -e : e);
}
const GHOST_TERM = {T125: "T", T263: "T", N492: "N"};

/* ---------------- comfort (review S1 / F7) ----------------
   The view direction and the up vector are Gaussian-averaged over p (sigma COMFORT.sigma, COMFORT.n samples each side), so
   no key spacing or short blend can whip the camera round within a wheel notch: a turn is spread over about 4 sigma of p.
   The look point is the raw position plus the averaged direction at the raw distance; the camera then sits at the
   log-averaged distance from it (A1), which equals the raw position wherever no dolly is smoothed.
   Pure and deterministic: a function of p alone (seek never reads time), so G8 holds. */
export const COMFORT = Object.freeze({sigma: 0.008, n: 6, sigmaD: 0.014, nD: 7, dollyLo: 2.5, dollyHi: 4, nDback: 7});
/* review2 scrolly A1 (whip zooms): the look distance is Gaussian-averaged too, in log space with its own wider sigmaD, so a
   dolly from 22 to 321 kpc (B11) or 78 to 27 kpc (B9) is spread over about 4 sigmaD of p (≈ 7 notches) instead of one or two.
   The target stays exact (the probe, the cell or the galaxy the shot frames); the camera sits at target − f̂·d̄. */
function rawCamAt(ctx, mods, q) {
  const tl = ctx.tl, L = tl.locate(q), b = L.beat, shots = ctx.shotsDoc.shots, prevB = L.i > 0 ? tl.beats[L.i - 1] : null;
  const l = lOfBeat(ctx, b, L.u);
  return evalCamera(shots[b.shot], prevB ? shots[prevB.shot] : null, L.u, {frame: ctx.frame, l, lAt: uu => lOfBeat(ctx, b, uu), lscale: ctx.lscale, cellPos: ctx.cellPos, mods});
}
function comfortCam(cam, p, ctx, mods) {
  const {sigma, n} = COMFORT; if (!(sigma > 0)) return cam;
  const h = sigma / 2, f = [0, 0, 0], up = [0, 0, 0];
  // never average across a declared cut (shots.json cut: true): samples are clamped into the current cut segment
  let lo = 0, hi = 1; const shots = ctx.shotsDoc.shots;
  for (const bb of ctx.tl.beats) { const sh = shots[bb.shot]; if (!sh || !sh.cut) continue;
    if (bb.p0 <= p + 1e-12) lo = Math.max(lo, bb.p0); else hi = Math.min(hi, bb.p0 - 1e-9); }
  for (let k = -n; k <= n; k++) {
    const q = Math.min(hi, Math.max(lo, p + k * h)), c = k === 0 ? cam : rawCamAt(ctx, mods, q), wk = Math.exp(-0.5 * (k * h / sigma) ** 2);
    const d = [c.target[0] - c.pos[0], c.target[1] - c.pos[1], c.target[2] - c.pos[2]], dl = Math.hypot(...d) || 1;
    for (let a = 0; a < 3; a++) { f[a] += wk * d[a] / dl; up[a] += wk * c.up[a]; }
  }
  const fl = Math.hypot(...f), ul = Math.hypot(...up);
  if (!(fl > 1e-6) || !(ul > 1e-6)) return cam;
  const dist0 = Math.hypot(cam.target[0] - cam.pos[0], cam.target[1] - cam.pos[1], cam.target[2] - cam.pos[2]); let dist = dist0;
  const fn = f.map(x => x / fl);
  const sD = COMFORT.sigmaD, nD = COMFORT.nD;
  if (sD > 0 && dist > 1e-6) {
    // samples stay inside the current beat and the blend ramps in from the beat's edges (a beat boundary keeps the raw
    // camera, so continuity holds and a dolly in one beat is not anticipated in the previous beat's last line, G3)
    const Lb = ctx.tl.locate(p), bb = Lb ? Lb.beat : null, loD = Math.max(lo, bb ? bb.p0 : 0), hiD = Math.min(hi, bb ? bb.p1 : 1);
    const ss = x => { const t = Math.min(1, Math.max(0, x)); return t * t * (3 - 2 * t); };
    const edge = ss((p - loD) / (0.5 * sD)) * ss((hiD - p) / (0.5 * sD));
    const hD = sD / 2; let ws = 0, ls = 0, dmin = Infinity, dmax = 0;
    for (let k = -COMFORT.nDback; k <= nD; k++) {
      const q = Math.min(hiD, Math.max(loD, p + k * hD)), c = k === 0 ? cam : rawCamAt(ctx, mods, q), wk = Math.exp(-0.5 * (k * hD / sD) ** 2);
      const dk = Math.hypot(c.target[0] - c.pos[0], c.target[1] - c.pos[1], c.target[2] - c.pos[2]);
      if (dk > 1e-6) { ws += wk; ls += wk * Math.log(dk); dmin = Math.min(dmin, dk); dmax = Math.max(dmax, dk); }
    }
    // adaptive: only a real dolly (the raw distance changes by more than COMFORT.dollyLo..Hi× across the window) is smoothed,
    // so the slow framing moves of the stops (B7c/B7d settle before their lines enter, G3) keep their exact timing
    if (ws > 0) { const r = Math.log(dmax / dmin), a = edge * Math.min(1, Math.max(0, (r - Math.log(COMFORT.dollyLo)) / Math.log(COMFORT.dollyHi / COMFORT.dollyLo)));
      dist = Math.exp((1 - a) * Math.log(dist) + a * ls / ws); }
  }
  // up: the averaged up made orthogonal to the averaged forward
  const ud = up[0] * fn[0] + up[1] * fn[1] + up[2] * fn[2], uo = up.map((x, a) => x - ud * fn[a]), uol = Math.hypot(...uo);
  // look point as before (raw position + averaged direction × raw distance); the camera backs off from it to the averaged
  // distance (identical to the old camera wherever the distance smoothing is off)
  const tgt = cam.pos.map((x, a) => x + fn[a] * dist0);
  return {...cam, target: tgt, pos: tgt.map((x, a) => x - fn[a] * dist), up: uol > 1e-6 ? uo.map(x => x / uol) : cam.up};
}

/* ---------------- seek ---------------- */
export function makeSeek(docs) {
  const beatsDoc = docs.beats, shotsDoc = docs.shots;
  return function seek(p, data, overrides = {}) {
    const ov = overrides || {};
    const ctx = prepare(data, beatsDoc, shotsDoc);
    const tl = ctx.tl;
    const L = tl.locate(p);
    const b = L.beat, u = L.u, pp = Number.isFinite(p) ? clamp01(p) : 0;
    const l = lOfBeat(ctx, b, u);
    const ion = ov.ion === "HI" || ov.ion === "OVI" ? ov.ion : b.ion;

    // camera (never reads overrides)
    const shots = shotsDoc.shots, shot = shots[b.shot], prevB = L.i > 0 ? tl.beats[L.i - 1] : null;
    const prevShot = prevB ? shots[prevB.shot] : null;
    const mods = ov.cls && shotsDoc.classMods ? shotsDoc.classMods[ov.cls] || null : null;
    const cctx = {frame: ctx.frame, l, lAt: uu => lOfBeat(ctx, b, uu), lscale: ctx.lscale, cellPos: ctx.cellPos, mods};
    const cam = comfortCam(evalCamera(shot, prevShot, u, cctx), pp, ctx, mods);
    const side = shot.textSide || "left", sideFrom = prevShot ? prevShot.textSide || "left" : side;
    const bl = shot.cut ? 0 : (shot.blendIn ?? 0.3);
    cam.textSide = side; cam.sideFrom = sideFrom;
    cam.sideMix = sideFrom === side ? 1 : bl > 0 ? smootherstep(u / bl) : 1;

    // stop sub-ticks
    const stop = b.stops && b.stops.n > 1 ? {k: Math.min(b.stops.n - 1, Math.floor(u * b.stops.n)), n: b.stops.n} : null;

    // tf
    let tf = tfAt(b, u);
    if (ov.tf) tf = {...tf, from: ov.tf, to: ov.tf, mix: 1, chip: ov.tf};

    // fields: current beat + any later beat whose prefetch window has opened
    const fields = [], seen = new Set();
    const addF = f => { const k = f.name + "@" + f.level; if (!seen.has(k)) { seen.add(k); fields.push({name: f.name, level: f.level}); } };
    b.fields.forEach(addF);
    for (let j = L.i + 1; j < tl.beats.length && j <= L.i + 3; j++) { const nb = tl.beats[j]; if (pp >= nb.p0 - nb.lead) nb.fields.forEach(addF); }

    // text (one group per band; conditional variants by override)
    const text = [];
    for (const t of b.text) {
      if (t.when && !whenOk(t.when, data, ov)) continue;
      const ph = tl.phase(u, t, b);
      if (Math.abs(ph) >= 1) continue;
      const it = {id: t.id, band: t.band, phase: ph, part: t.part};
      if (t.anchor) it.anchor = t.anchor;
      if (t.cond) it.cond = t.cond;            // copy.json flag: the shell shows the slot only when it holds
      if (t.alt) it.alt = true;                // alternative to the previous slot (same window)
      text.push(it);
    }
    // equations
    const cell = cellAt(ctx, ion, l);
    const eqs = [];
    for (const e of b.eqs) {
      const ph = tl.phase(u, e, b);
      if (Math.abs(ph) >= 1) continue;
      const anchor = {kind: e.anchor.kind, ref: e.anchor.ref ?? null};
      if (anchor.kind === "cell" && anchor.ref === "probe") { anchor.ref = cell ? cell.idx : null; anchor.probe = true; }   // probe: follows the plaque cell
      const hl = e.hl.filter(h => u >= h.u0 && u <= h.u1).map(h => h.term);
      const gk = e.ghost, gv = gk && Number.isFinite(ov[gk]) ? ov[gk] : null;
      eqs.push({id: e.id, anchor, hl, ghost: gv == null ? null : {term: GHOST_TERM[gk], value: gv}, phase: ph, ...(e.totals ? {totals: true} : {}), ...(e.noPhone ? {noPhone: true} : {}), ...(e.phoneU ? {phoneU: e.phoneU} : {})});
    }

    // spectrum dock
    const d = dockAt(b, u);
    const live = L.i >= (tl.byId("B12a") ? tl.byId("B12a").i : Infinity);
    const sp = b.spec || {mode: "intrinsic"};
    let R = keyed(sp.R, u, true), sn = keyed(sp.sn, u, true);
    if (live && Number.isFinite(ov.R)) R = ov.R;
    if (live && Number.isFinite(ov.sn)) sn = ov.sn;
    const other = ion === "OVI" ? "HI" : "OVI";
    const seed = Number.isFinite(ov.seed) ? ov.seed : (data && data.meta && Number.isFinite(data.meta.seed) ? data.meta.seed : 0);
    const spec = {dock: d.dock, dockFrom: d.dockFrom, dockMix: d.dockMix, mode: sp.mode, ions: [ion, other], lead: ion, R, sn, seed};

    const insetA = b.ui ? keyed(b.ui.inset, u, false) : 0;
    const ui = {freeLook: b.interactions.includes("freeLook"), look: false, inset: PHONE.has(ov.cls) ? clamp01(insetA || 0) : 0};

    return {
      p: pp,
      beat: {id: b.id, i: L.i, u, kind: b.kind, stop, ...(b.cond ? {cond: b.cond} : {})},
      l, cell, cloud: cloudAt(ctx, l), cam,
      capsule: {l0: l - CAPSULE.half, l1: l + CAPSULE.half, r: ctx.capR, edge: CAPSULE.edge},
      quality: b.quality || (b.kind === "stop" ? "stop" : "flight"),
      tf, fields, shells: shellsAt(ctx, b, l), text, eqs, spec, ui,
    };
  };
}

/* ---------------- module-level default ---------------- */
let DEFAULT = null;
export function configure(docs) { DEFAULT = makeSeek(docs); DEFAULT.docs = docs; return DEFAULT; }
export function seek(p, data, overrides = {}) {
  if (!DEFAULT) throw new Error("seek: call configure({beats, shots}) first (js/core/seek.js)");
  return DEFAULT(p, data, overrides);
}

/* window.__story (frozen keys: seek, state(), rects(), beats(), setTarget(p), quality(), version) */
export function exposeStory(win, o) {
  const api = {
    version: SEEK_VERSION,
    seek: (p, ov) => o.seek(p, o.data(), ov === undefined ? o.overrides() : ov),
    state: () => o.seek(o.clock.p, o.data(), o.overrides()),
    rects: () => (o.rects ? o.rects() : []),
    beats: () => o.timeline.beats.map(b => ({id: b.id, p0: b.p0, p1: b.p1, kind: b.kind,
      dock: Array.isArray(b.dock) ? b.dock[0].state : b.dock, stop: b.stops && b.stops.n > 1 ? {n: b.stops.n} : null,
      ...(b.cond ? {cond: b.cond} : {})})),
    setTarget: (p, jump) => (jump ? o.clock.jump(p) : o.clock.setTarget(p)),
    quality: () => (o.quality ? o.quality() : null),
    clock: () => o.clock.state,
  };
  if (win) win.__story = api;
  return api;
}
