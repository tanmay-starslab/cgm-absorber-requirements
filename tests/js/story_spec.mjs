// U_spec acceptance (DESIGN_final §5.4): the live spectrum dock of "How a spectrum is made" v2.
//   1. τ(s) = Σ W_i(s) τ_i equals the offline cumulative τ (scipy wofz + numpy kcdf_eval on the shipped JSON,
//      tests/js/fixtures/story_spec/tau_ref.json, generator make_tau_ref.py beside it) at 500 random s to 1e-6
//      (|Δτ| ≤ 1e-6 · max(1, τ)), on every bin of the fixture, both ions
//   2. end of flight equals the stored F (O VI ≤ 2.5e-4, H I ≤ 2e-3) and the fixture's end-of-flight τ
//   3. kernel weights: W(s_in) = 0, W(s_out) = 1, monotone; prefix path = direct sum; tauAt is pure (any order)
//   4. per-frame cost ≤ 1 ms (node bench: τ for both ions + frame model + layout, flight beats)
//   5. the worker protocol builds the same buffers as the main thread
//   6. dock layout: every registered child inside the dock (and inside both ends of a transition), no child overlap
//      > 4 px², text ≥ 12 px, over the G1 matrix of viewports × zooms × dock states, and through seek() at 160 p
//   7. connector enters the dock from above and ends on its top edge; tethers end on the dock top edge; corridors exist
//   8. H I Voigt wings in τ_i; the B10 ghost: N above 10^18.5 widens the ghost axis to ±600 km/s with "damping wings"
//   9. E7 pixel rule: observed pixels are c/R/5 wide; "blur turns narrow black dips grey" while the H I trough stays black
//  10. fit parity unchanged: fitworker "story-fit" returns fitPanel's own components; the fit dock draws every phase
//  11. dials: slider maps round-trip, visibility per beat; B13 landing threshold = scenes/fit.js FIT_PHASES
import {readFileSync, existsSync} from "node:fs";
import {join, dirname} from "node:path";
import {fileURLToPath} from "node:url";
import {decodeTNGS, fitPanel, PIX_PER_RESEL} from "../../docs/tng50/js/fit.js";
import * as K from "../../docs/tng50/learn/how-a-spectrum-is-made/js/plot.js";
import {geometryOf, weight, tauSumFromData, ionInputs, gridOf, tauSumFromBuffers} from "../../docs/tng50/learn/how-a-spectrum-is-made/js/spectrum/tausum.js";
import {handle as workerHandle} from "../../docs/tng50/learn/how-a-spectrum-is-made/js/spectrum/tauworker.js";
import {createSpectrum, frameModel, dockLayout, dockRects, tauSet, measurer, GHOST_VW, MIN_DIAL, MIN_TOGGLE_DIAL} from "../../docs/tng50/learn/how-a-spectrum-is-made/js/spectrum/dock.js";
import {connector, tethers, corridors, LANDING_U, CASES_U} from "../../docs/tng50/learn/how-a-spectrum-is-made/js/spectrum/link.js";
import {toSlider, fromSlider, DIALS, visibleFor, TOGGLE_W} from "../../docs/tng50/learn/how-a-spectrum-is-made/js/spectrum/dials.js";
import {FIT_PHASES} from "../../docs/tng50/learn/how-a-spectrum-is-made/js/scenes/fit.js";
import {makeSeek} from "../../docs/tng50/learn/how-a-spectrum-is-made/js/core/seek.js";
import {layoutClass, computeBands} from "../../docs/tng50/learn/how-a-spectrum-is-made/js/ui/layoutclass.js";

const HERE = dirname(fileURLToPath(import.meta.url)), REPO = join(HERE, "..", ".."), TNG = join(REPO, "docs", "tng50");
const ROOT = join(TNG, "learn", "how-a-spectrum-is-made"), DATA = join(ROOT, "data");
let pass = 0, fail = 0;
const check = (ok, msg) => { if (ok) pass++; else fail++; console.log(`${ok ? "ok  " : "FAIL"} ${msg}`); };
const ab = b => b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength);
const json = p => JSON.parse(readFileSync(p, "utf8"));

const data = json(join(DATA, "story_488530_rand_b062_a062.json"));
data.page_fits = json(join(DATA, "page_fits_488530_rand_b062_a062.json"));
data.fion = existsSync(join(DATA, "fion_OVI_slice.json")) ? json(join(DATA, "fion_OVI_slice.json")) : null;
{ const d = decodeTNGS(ab(readFileSync(join(TNG, "data", "s", `${data.meta.ray}.bin`)))); data.lines = {vSys: d.vSys, ...d.lines}; }
const cpath = join(DATA, data.clouds.path);
if (existsSync(cpath)) data.clouds_full = json(cpath);
const ref = json(join(HERE, "fixtures", "story_spec", "tau_ref.json"));

/* ---------------- 1-3: τ against the offline reference ---------------- */
const T = tauSet(data), G = geometryOf(data);
for (const ion of ["OVI", "HI"]) {
  const S = T[ion], out = new Float64Array(S.N);
  let worst = 0, where = null;
  ref.s.forEach((s, k) => { S.tauAt(s, out); ref.bins.forEach((j, m) => { const r = ref.tau[ion][k][m], e = Math.abs(out[j] - r) / Math.max(1, Math.abs(r)); if (e > worst) { worst = e; where = [s, j]; } }); });
  check(ref.s.length === 500 && worst <= 1e-6, `${ion}: τ(s) vs offline cumulative τ at ${ref.s.length} random s × ${ref.bins.length} bins: max |Δτ|/max(1, τ) = ${worst.toExponential(2)} ≤ 1e-6${where ? ` (worst at s ${where[0]}, bin ${where[1]})` : ""}`);
  S.tauAt(G.sMax + 1, out);
  let eofRef = 0; ref.eof[ion].forEach((r, j) => { eofRef = Math.max(eofRef, Math.abs(out[j] - r) / Math.max(1, Math.abs(r))); });
  let dF = 0; const F = data.ions[ion].F_intrinsic; for (let j = 0; j < S.N; j++) dF = Math.max(dF, Math.abs(Math.exp(-out[j]) - F[j]));
  const lim = ion === "HI" ? 2e-3 : 2.5e-4;
  check(dF <= lim && eofRef <= 1e-6, `${ion}: end of flight equals the stored F: max |dF| ${dF.toExponential(2)} ≤ ${lim}; vs offline end-of-flight τ ${eofRef.toExponential(2)}`);
  // prefix path = direct sum; purity in any order
  const D = new Float64Array(S.N); let pd = 0;
  for (const s of ref.s.slice(0, 120)) { S.tauAt(s, out); S.tauDirect(s, D); for (let j = 0; j < S.N; j++) pd = Math.max(pd, Math.abs(out[j] - D[j]) / Math.max(1, Math.abs(D[j]))); }
  check(pd < 1e-12, `${ion}: prefix-sum path equals the direct Σ W_i τ_i (max rel ${pd.toExponential(1)})`);
  const a = Float64Array.from(S.tauAt(-30)), b2 = Float64Array.from(S.tauAt(120)), a2 = Float64Array.from(S.tauAt(-30));
  S.tauAt(250); const b3 = Float64Array.from(S.tauAt(120));
  check(a.every((x, j) => x === a2[j]) && b2.every((x, j) => x === b3[j]), `${ion}: tauAt is stateless (seek a, b, a and b again: identical bits)`);
  // H I damping wings in τ_i: far from the strongest cell the Lorentz wing is present (matches the reference)
  if (ion === "HI") {
    const [cid] = Object.keys(ref.cells.HI), t = S.cellTau(+cid), V = data.ions.HI.cells.V[+cid], b = data.ions.HI.cells.b[+cid];
    const jf = Math.round(V + 300 - S.grid0 > 800 ? V - 300 - S.grid0 : V + 300 - S.grid0), rv = ref.cells.HI[cid][jf];
    check(t[jf] > 0 && Math.abs(300 / b) > 8 && Math.abs(t[jf] - rv) / Math.max(1e-30, rv) < 1e-4, `HI: Voigt wing of cell ${cid} at 300 km/s (> 8 b) present: τ ${t[jf].toExponential(3)} vs reference ${rv.toExponential(3)}`);
  }
}
{ // kernel weights
  let bad = 0, mono = 0;
  for (let i = 0; i < G.n; i++) {
    if (weight(G, i, G.sIn[i] - 1e-9) !== 0 || Math.abs(weight(G, i, G.sOut[i] + 1e-9) - 1) > 1e-12) bad++;
    let prev = -1; for (let k = 0; k <= 20; k++) { const w = weight(G, i, G.sIn[i] + (G.sOut[i] - G.sIn[i]) * k / 20); if (w < prev - 1e-15) { mono++; break; } prev = w; }
  }
  let sum = 0; for (let i = 0; i < G.n; i++) sum += weight(G, i, G.sMax + 1);
  check(!bad && !mono && Math.abs(sum - G.n) < 1e-9, `kernel weights: W(s_in) = 0 and W(s_out) = 1 for all ${G.n} cells (${bad} bad), monotone (${mono} not), ΣW(∞) = n (${sum})`);
}

/* ---------------- 5: worker protocol ---------------- */
{
  const msgs = [];
  const inputs = ["OVI", "HI"].map(k => ionInputs(data, k));
  workerHandle({type: "build", reqId: "t", geometry: {cells: data.geometry.cells, kernel_cdf: data.geometry.kernel_cdf}, grid: data.meta.grid, ions: inputs}, m => msgs.push(m));
  const ok = msgs.length === 2 && msgs.every(m => m.type === "built");
  let same = ok;
  if (ok) for (const m of msgs) {
    const W = tauSumFromBuffers(data, m); W.grid0 = T[m.ion].grid0;
    for (const s of [-200, -35, 0, 91.3, 300]) { const x = W.tauAt(s), y = T[m.ion].tauAt(s); for (let j = 0; j < x.length; j++) if (x[j] !== y[j]) { same = false; break; } }
  }
  check(ok && same, `tauworker: "build" answers one "built" per ion; buffers reproduce the main-thread τ bit for bit (${msgs.map(m => `${m.ion} ${m.ms.toFixed(0)} ms`).join(", ")})`);
  const errs = []; workerHandle({type: "nope", reqId: 1}, m => errs.push(m));
  check(errs.length === 1 && errs[0].type === "error", "tauworker: unknown message types answer an error");
}

/* ---------------- seek over the story ---------------- */
const beats = json(join(ROOT, "beats.json")), shots = json(join(ROOT, "shots.json"));
const seek = makeSeek({beats, shots});
const P160 = Array.from({length: 160}, (_, k) => (k + 0.5) / 160);
const frames = P160.map(p => seek(p, data, {}));

/* ---------------- 4: per-frame cost ---------------- */
{
  const flight = frames.filter(f => f.spec.mode === "intrinsic");
  const meas = measurer(null), times = [];
  const bufs = {OVI: new Float64Array(T.OVI.N), HI: new Float64Array(T.HI.N)}, bufs2 = {OVI: new Float64Array(T.OVI.N), HI: new Float64Array(T.HI.N)};
  for (let rep = 0; rep < 6; rep++) for (const fs of flight) {
    const t0 = performance.now();
    const m = frameModel(fs, data, T, {buf: bufs, buf2: bufs2});
    const R = dockRects(fs, {w: 1440, h: 900});
    dockLayout(R.drawn, fs.spec.dock, {lead: m.lead, measure: meas, readouts: m.readouts, ghostLabels: m.ghostLabels});
    if (rep > 0) times.push(performance.now() - t0);
  }
  times.sort((a, b) => a - b);
  const p50 = times[Math.floor(times.length / 2)], p95 = times[Math.floor(times.length * 0.95)];
  check(p95 <= 1, `per-frame cost (τ both ions + frame model + layout, ${flight.length} flight frames × 5): p50 ${p50.toFixed(3)} ms, p95 ${p95.toFixed(3)} ms ≤ 1 ms`);
  // hero (B12a R sweep, B12b S/N sweep): a Watch-speed scrub from cold memos, 60 frames per second of beat time
  const hb = beats.beats.filter(b => b.id === "B12a" || b.id === "B12b"), ht = [];
  for (const b of hb) { const n = Math.round((b.watch_s || 8) * 60); for (let k = 0; k < n; k++) {
    const fs = seek(b.p0 + (k + 0.5) / n * (b.p1 - b.p0), data, {});
    const t0 = performance.now(); const m = frameModel(fs, data, T); const R = dockRects(fs, {w: 1440, h: 900});
    dockLayout(R.drawn, fs.spec.dock, {lead: m.lead, measure: meas, readouts: m.readouts, headerReadouts: m.headerReadouts, dials: m.dials}); ht.push(performance.now() - t0); } }
  ht.sort((a, b) => a - b);
  const q50 = ht[Math.floor(ht.length / 2)], q95 = ht[Math.floor(ht.length * 0.95)], qmax = ht[ht.length - 1];
  check(q95 <= 1 && qmax < 50, `per-frame cost in the hero sweeps (${ht.length} Watch-speed frames from cold memos): p50 ${q50.toFixed(3)} ms, p95 ${q95.toFixed(3)} ms ≤ 1 ms, max ${qmax.toFixed(1)} ms < 50 ms`);
}
{ // the cached-draw noise path gives the explorer's own pixels, bit for bit
  const {observedSN} = await import("../../docs/tng50/learn/how-a-spectrum-is-made/js/scenes/noise.js");
  let same = true;
  for (const k of ["OVI", "HI"]) for (const sn of [2, 3.7, 10, 55]) for (const seed of [0, 1]) {
    const ns = K.caseSeed(seed, k, 0), a = K.observed(data, k, 30000, sn, ns), b = observedSN(data, k, 30000, sn, ns);
    if (a.flux.length !== b.flux.length || a.sigma !== b.sigma || a.flux.some((x, i) => x !== b.flux[i])) same = false;
  }
  check(same, "noise: one cached draw scaled by S/N equals plot.observed (degradeV) bit for bit (2 ions × 4 S/N × 2 seeds)");
}

/* ---------------- 6: layout over the matrix ---------------- */
const area = (a, b) => { const w = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x), h = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y); return w > 0 && h > 0 ? w * h : 0; };
const inside = (r, c, e = 0.5) => r.x >= c.x - e && r.y >= c.y - e && r.x + r.w <= c.x + c.w + e && r.y + r.h <= c.y + c.h + e;
{
  const VIEWS = [[1920, 1080], [1440, 900], [1366, 768], [1280, 800], [1024, 768], [768, 1024], [390, 844], [844, 390], [2560, 1440], [683, 512], [260, 563], [320, 568], [360, 740]];
  const ZOOMS = [0.9, 1, 1.1, 1.25, 1.5];
  const meas = measurer(null);
  let n = 0, outside = 0, ov = 0, small = 0, missingLabel = 0, heroN = 0, dialsDropped = [], dialNarrow = 0;
  const readouts = {OVI: [{id: "way", text: "in the way 100 %"}], HI: [{id: "way", text: "in the way 100 %"}]};
  for (const [W, H] of VIEWS) for (const z of ZOOMS) {
    const w = Math.round(W / z), h = Math.round(H / z), cls = layoutClass(w, h);
    for (const st of ["strip", "pair", "hero"]) {
      const rect = computeBands(cls, w, h, {dock: st}).dock; if (!rect) continue;
      for (const lead of ["OVI", "HI"]) {
        const L = dockLayout(rect, st, {lead, measure: meas, readouts, headerReadouts: st === "hero" ? [{id: "R", text: "R 150 000"}, {id: "blur", text: "blur 60.0 km/s"}] : [],
          dials: st === "hero" ? ["R", "sn"] : [], ghostLabels: [{id: "axis", ion: "HI", text: `ghost axis ±${GHOST_VW} km/s`}, {id: "wings", ion: "HI", text: "damping wings"}]});
        n++;
        for (const k of L.kids) {
          if (!inside(k.rect, rect)) outside++;
          if (k.font && +(/(\d+)px/.exec(k.font) || [0, 0])[1] < 12) small++;
        }
        for (let i = 0; i < L.kids.length; i++) for (let j = i + 1; j < L.kids.length; j++) if (area(L.kids[i].rect, L.kids[j].rect) > 4) ov++;
        if (rect.h >= 60 && !L.kids.some(k => k.id === `label:${lead}`)) missingLabel++;
        // fix3 ux M1: a hero dock always keeps both dials (side by side or stacked), each >= MIN_DIAL wide
        if (st === "hero") { heroN++; const dk = L.kids.find(k => k.id === "dials");
          if (!dk || (L.hidden || []).some(h => h.id === "dock:dials")) { if (dialsDropped.length < 6) dialsDropped.push(`${w}x${h} (${W}x${H}@${z})`); }
          else if (dk.toggle ? dk.rect.w - TOGGLE_W - 6 < MIN_TOGGLE_DIAL : (dk.rows > 1 ? dk.rect.w : (dk.rect.w - 8) / 2) < MIN_DIAL) dialNarrow++; }
        for (const P of Object.values(L.panels)) if (!inside({x: P.x, y: P.y, w: P.w, h: P.h}, rect, 1)) outside++;
      }
    }
  }
  check(heroN > 50 && !dialsDropped.length && !dialNarrow, `hero dock keeps both R and S/N dials (each >= ${MIN_DIAL} px side by side or stacked, or one >= ${MIN_TOGGLE_DIAL} px beside an R | S/N switch) in ${heroN} hero layouts incl. 320x568 and 260x563: dropped ${dialsDropped.length} ${dialsDropped.join(", ")}, narrow ${dialNarrow}`);
  check(n > 300 && !outside && !ov && !small && !missingLabel, `dock layout over ${n} (viewport × zoom × state × lead) points: children/panels outside the dock ${outside}, child overlaps ${ov}, text < 12 px ${small}, lead label missing ${missingLabel}`);
}

/* ---------------- 6/7: through seek at 160 p, with links ---------------- */
{
  const spectrum = createSpectrum({data, ctx: recCtx(), dials: false});
  await spectrum.ready();
  const W = 1440, H = 900;
  // projection stub: a fixed camera looking at the galaxy from +z (enough to place links on screen)
  const project = p => ({x: W * 0.5 + p[0] * 2.2, y: H * 0.42 - p[1] * 1.1, ok: true});
  let bad = 0, overlap = 0, conn = 0, connBad = 0, teth = 0, tethBad = 0, corr = 0, modes = new Set(), outsideTarget = 0;
  for (const fs of frames) {
    const last = spectrum.render(fs, {w: W, h: H, dpr: 1, project});
    const R = dockRects(fs, {w: W, h: H});
    modes.add(fs.spec.mode);
    const items = spectrum.rects();
    for (const it of items) {
      if (it.exempt) continue;
      if (!inside(it.rect, last.drawn)) bad++;
      if (R.target && !inside(it.rect, R.target)) outsideTarget++;
    }
    const kids = items.filter(i => !i.exempt);
    for (let i = 0; i < kids.length; i++) for (let j = i + 1; j < kids.length; j++) if (area(kids[i].rect, kids[j].rect) > 4) overlap++;
    for (const L of spectrum.connectors()) {
      // fix1 r4 (review1 scrolly S4): the connector also starts on the stage (8 px inset), never from off-screen
      if (L.kind === "connector") { conn++; if (Math.abs(L.b.y - last.drawn.y) > 0.01 || L.c2.x !== L.b.x || !(L.c2.y < L.b.y) || L.a.y >= L.b.y || L.a.x < 8 || L.a.y < 8 || L.a.x > W - 8) connBad++; }
      else { teth++; if (Math.abs(L.b.y - last.drawn.y) > 0.01 || L.b.x < last.drawn.x || L.b.x > last.drawn.x + last.drawn.w) tethBad++; }
    }
    corr += spectrum.corridors().length;
  }
  check(!bad && !outsideTarget && !overlap, `seek at 160 p (1440×900): dock children inside the drawn dock (${bad} out) and inside the shell's target dock rect (${outsideTarget} out), no child overlap (${overlap})`);
  check(conn > 20 && !connBad, `connector: ${conn} frames with a probe link, all start on the stage, enter from above (vertical last tangent) and end on the dock top edge (${connBad} bad)`);
  check(teth > 0 && !tethBad, `tethers: ${teth} B11/B13 links end on the dock top edge inside the dock span (${tethBad} bad)`);
  check(corr > 0 && corridors([]).length === 0, `corridors exported for the solver (G3): ${corr} segments over the run`);
  check(["intrinsic", "observed", "fit", "explore"].every(m => modes.has(m)), `all four dock modes rendered through seek (${[...modes].join(", ")})`);
}

/* ---------------- 8: B10 ghost ---------------- */
{
  const b10 = beats.beats.find(b => b.id === "B10"), p = b10.p0 + 0.5 * (b10.p1 - b10.p0);
  const g19 = frameModel(seek(p, data, {N492: 19}), data, T), g18 = frameModel(seek(p, data, {N492: 18}), data, T), g0 = frameModel(seek(p, data, {}), data, T);
  const lab = m => m.ghostLabels.map(x => x.text).join(" | ");
  check(g19.ghost && g19.ghost.wings && /±600 km\/s/.test(lab(g19)) && /damping wings/.test(lab(g19)), `B10 ghost at N 10^19: ghost axis widens to ±${GHOST_VW} km/s with "damping wings" (${lab(g19)})`);
  check(g18.ghost && !g18.ghost.wings && !g18.ghostLabels.length && !g0.ghost, `B10 ghost at N 10^18: no wings label (below 10^18.5); no override: no ghost`);
  check(g19.ghost.profile.depth > 0.999 && g19.ghost.profile.width > g18.ghost.profile.width, `ghost: black core (depth ${(100 * g19.ghost.profile.depth).toFixed(1)} %) and wider at 10^19 (${g19.ghost.profile.width.toFixed(0)} km/s) than at 10^18 (${g18.ghost.profile.width.toFixed(0)} km/s)`);
  const L = dockLayout({x: 24, y: 600, w: 1392, h: 216}, "pair", {lead: "HI", readouts: g19.readouts, ghostLabels: g19.ghostLabels});
  check(L.kids.some(k => k.id === "ghost:axis") && L.kids.some(k => k.id === "ghost:wings"), "B10 ghost labels register as dock children in the pair dock");
}

/* ---------------- 9: E7 pixel rule, blur ---------------- */
{
  let ok = true; const C = 299792.458;
  for (const R of [5000, 30000, 150000]) for (const k of ["OVI", "HI"]) {
    const o = K.observed(data, k, R, 10, K.caseSeed(0, k, 0)), dv = o.v[1] - o.v[0];
    if (Math.abs(dv - C / R / PIX_PER_RESEL) > 1e-6 * dv) ok = false;
  }
  const b12b = beats.beats.find(b => b.id === "B12b"), fs = seek(b12b.p0 + 0.8 * (b12b.p1 - b12b.p0), data, {});
  const m = frameModel(fs, data, T), pix = m.headerReadouts.find(x => x.id === "pix");
  check(ok && PIX_PER_RESEL === 5 && pix && pix.text === `pixel ${(C / fs.spec.R / 5).toFixed(1)} km/s`, `E7: observed pixels are c/R/5 wide at R 5 000, 30 000, 150 000 (both ions); dock readout "${pix && pix.text}"`);
  { // B12a: the drawn R, the readout and the dial value agree (R snaps to two significant digits)
    const b = beats.beats.find(x => x.id === "B12a"), f2 = seek(b.p0 + 0.37 * (b.p1 - b.p0), data, {}), m2 = frameModel(f2, data, T);
    const rd = m2.headerReadouts.find(x => x.id === "R").text, Rq = m2.R, ob = m2.ions.OVI.obs;
    check(Rq === +String(Rq).replace(/0+$/, "").padEnd(String(Rq).length, "0") && /^\d{2}0*$/.test(String(Rq)) && rd === `R ${String(Rq).replace(/\B(?=(\d{3})+(?!\d))/g, " ")}` && Math.abs(ob.v[1] - ob.v[0] - C / Rq / 5) < 1e-6,
      `B12a: scrubbed R ${f2.spec.R.toFixed(0)} drawn as R ${Rq} (two significant digits), readout "${rd}", pixels c/R/5 of the drawn R`);
  }
  const lo = K.observed(data, "OVI", 5000, 0), hi = K.observed(data, "OVI", 150000, 0), hl = K.observed(data, "HI", 5000, 0);
  const mn = o => Math.min(...o.model.filter((_, i) => Math.abs(o.v[i]) < 300));
  check(mn(lo) - mn(hi) > 0.05 && mn(hl) < 0.02, `blur turns narrow black dips grey: O VI darkest ${(100 * mn(hi)).toFixed(1)} % → ${(100 * mn(lo)).toFixed(1)} % (R 150 000 → 5 000), H I trough stays black at R 5 000 (${(100 * mn(hl)).toFixed(2)} %)`);
}

/* ---------------- 10: fit parity, fit dock phases ---------------- */
{
  const req = {...K.fitRequest(data, "OVI", 30000, 10, 0, 0), capMs: 1e9, budgetMs: 1e9};
  const direct = fitPanel(req);
  const posted = [];
  globalThis.self = {postMessage: m => posted.push(m)};
  await import("../../docs/tng50/js/fitworker.js");
  self.onmessage({data: {type: "story-fit", reqId: "s1", req}});
  for (let k = 0; k < 400 && !posted.length; k++) await new Promise(r => setTimeout(r, 25));
  const r = posted[0];
  const same = r && r.type === "story-result" && r.result.comps.length === direct.comps.length &&
    r.result.comps.every((c, i) => Math.abs(c.v - direct.comps[i].v) < 1e-9 && Math.abs(c.logN - direct.comps[i].logN) < 1e-9 && Math.abs(c.b - direct.comps[i].b) < 1e-9);
  check(same && r.result.model instanceof Float32Array && !("profiles" in r.result), `fitworker "story-fit": compact answer with fitPanel's own ${direct.comps.length} components (no profiles)`);
  posted.length = 0; self.onmessage({data: {type: "fit", reqId: "e1", req}});
  for (let k = 0; k < 40 && !posted.length; k++) await new Promise(r2 => setTimeout(r2, 5));
  check(posted[0] && posted[0].type === "result" && Array.isArray(posted[0].result.profiles), `fitworker explorer "fit" message unchanged (type "result" with profiles; cache hit)`);
  // stored page fit = the dock's fit phase input
  const s0 = K.picks(data).seeds[0];
  check(s0 && s0.R === 30000 && s0.snr === 10 && s0.comps.length > 0, `B13 draws the stored page fits (seed fit: ${s0 ? s0.comps.length : 0} components at R 30 000, S/N 10)`);
  const spectrum = createSpectrum({data, ctx: recCtx(), dials: false}); await spectrum.ready();
  const b13 = beats.beats.find(b => b.id === "B13"); let threw = null; const phases = new Set();
  for (const u of [0.05, 0.3, 0.5, 0.7, 0.9, 0.97]) {
    try { const fs = seek(b13.p0 + u * (b13.p1 - b13.p0), data, {}); spectrum.render(fs, {w: 1440, h: 900}); phases.add(spectrum.model().phase); } catch (e) { threw = e; }
  }
  check(!threw && ["draws", "totals", "landing", "cases"].every(x => phases.has(x)), `fit dock renders every B13 phase (${[...phases].join(", ")})${threw ? " threw " + threw.message : ""}`);
}

/* ---------------- 11: dials, thresholds ---------------- */
{
  let rt = true;
  for (const key of ["R", "sn"]) { const s = DIALS[key]; for (const v of [s.min, s.max, key === "R" ? 30000 : 10]) { const back = fromSlider(s, toSlider(s, v)); if (Math.abs(back - v) / v > 0.03) rt = false; } }
  const vis = id => { const b = beats.beats.find(x => x.id === id); return visibleFor(seek(b.p0 + 0.7 * (b.p1 - b.p0), data, {})).join("+"); };
  check(rt && vis("B12a") === "R" && vis("B12b") === "R+sn" && vis("B13") === "R+sn" && vis("B9") === "", `dials: slider maps round-trip within 3 %; shown B12a ${vis("B12a")}, B12b ${vis("B12b")}, B13 ${vis("B13")}, B9 none`);
  check(LANDING_U === FIT_PHASES.landing && CASES_U === FIT_PHASES.cases, "B13 tether landing window equals scenes/fit.js FIT_PHASES");
}

/* ---------------- phase 1 (S0 frozen): idle warm-up of the B12a blur memo; the dock's GL scrim rect ---------------- */
{
  const L = await import("../../docs/tng50/learn/how-a-spectrum-is-made/js/scenes/lsf.js");
  const {degradeV} = await import("../../docs/tng50/js/fit.js");
  const D = await import("../../docs/tng50/learn/how-a-spectrum-is-made/js/spectrum/dock.js");
  let cover = true; for (let i = 0; i <= 2000; i++) { const R = 5000 * 30 ** (i / 2000); if (!L.SWEEP_R.includes(L.quantR(R))) cover = false; }
  const d2 = JSON.parse(JSON.stringify(data)); d2.lines = data.lines;          // fresh memo (RMEMO is keyed by the data object)
  let slices = 0; while (!L.warmObservedR(d2, ["OVI", "HI"], 4, () => performance.now()) && slices < 1000) slices++;
  let same = true;
  for (const R of [L.SWEEP_R[0], 30000, 8000, 5100]) for (const k of ["OVI", "HI"]) {
    const I = K.ion(d2, k), o = L.observedR(d2, k, R), f = degradeV(I.line, R, 0, K.prep(d2).meta.vSys, {vwin: 330 + 3 * K.C_KMS / R, vcenter: 0});
    if (o.model.length !== f.model.length || o.model.some((x, j) => x !== f.model[j])) same = false;
  }
  const t = []; for (const R of L.SWEEP_R) { const t0 = performance.now(); L.observedR(d2, "OVI", R); L.observedR(d2, "HI", R); t.push(performance.now() - t0); }
  t.sort((a, b) => a - b);
  check(cover && L.SWEEP_R.length === 146 && slices < 1000 && same && t[Math.floor(t.length * 0.95)] < 0.05,
    `B12a warm-up: SWEEP_R (${L.SWEEP_R.length} R) covers every quantR in 5 000-150 000; warmObservedR fills it in ${slices + 1} slices of ≤ 4 ms; warmed blur equals degradeV bit for bit; warmed lookup p95 ${t[Math.floor(t.length * 0.95)].toFixed(4)} ms`);
  const W = 1440, H = 900, sp = createSpectrum({data, ctx: recCtx(W, H), scrim: false}); await sp.ready();
  const none = sp.scrim();
  const fs = seek(0.43, data, {}); sp.render(fs, {w: W, h: H, dpr: 1});
  const r = sp.model() && dockRects(fs, {w: W, h: H}).drawn, sc = sp.scrim(), s75 = sp.scrim(0.75);
  const ok = none === null && sc && Math.abs(sc.y0 + D.SCRIM_EDGE - r.y / H) < 2e-4 && Math.abs(sc.x0 + D.SCRIM_EDGE - r.x / W) < 2e-4 && Math.abs(sc.y1 - D.SCRIM_EDGE - (r.y + r.h) / H) < 2e-4
    && sc.k === D.DOCK_SCRIM_K && s75.k === 0.75 && D.dockScrim(null, W, H) === null;
  check(ok, `GL dock scrim (stage.setScrims form): null before the first frame; full strength from the dock's top rule (y0 ${sc && sc.y0} + ${D.SCRIM_EDGE} = ${(r.y / H).toFixed(4)}), k ${sc && sc.k} default, override honoured`);
}

/* ---------------- 12 (fix1, review H1): through every dock morph the drawn labels and readouts sit on the same geometry as
   the plot, so no dock text intersects a panel's data band, and every drawn child stays inside the dock container ---------------- */
{
  const beatsJ = json(join(ROOT, "beats.json")), shotsJ = json(join(ROOT, "shots.json")), seek2 = makeSeek({beats: beatsJ, shots: shotsJ});
  const sp = createSpectrum({data, ctx: recCtx(), dials: false}); await sp.ready();
  const inter = (a, b) => Math.max(0, Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x)) * Math.max(0, Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y));
  let bad = [], n = 0;
  for (const [W, H] of [[1440, 900], [390, 844], [768, 1024], [1280, 800]]) {
    for (let k = 0; k <= 4000; k++) {
      const p = k / 4000, fs = seek2(p, data, {cls: layoutClass(W, H)});
      if (!(fs.spec && fs.spec.dockMix != null && fs.spec.dockMix < 1)) continue;
      const L = sp.render(fs, {w: W, h: H}); if (!L || !L.layout) continue; n++;
      const tgt = computeBands(layoutClass(W, H), W, H, {dock: fs.spec.dock, textSide: (fs.cam && fs.cam.textSide) || "left"}).dock;
      for (const kid of L.kids) {
        if (kid.kind !== "dockLabel" && kid.kind !== "dockReadout" || kid.id.startsWith("ghost:")) continue;
        for (const P of Object.values(L.layout.panels)) if (P.role !== "spark" && inter(kid.rect, P) > 4) bad.push(`${W}x${H} p ${p.toFixed(4)} ${kid.id} in panel`);
        const g = tgt && {x: tgt.x - 0.5, y: tgt.y - 0.5, w: tgt.w + 1, h: tgt.h + 1};   // the solver's container rule (layout.js inside, eps 0.5)
        if (g && inter(kid.rect, g) < kid.rect.w * kid.rect.h - 1e-6) bad.push(`${W}x${H} p ${p.toFixed(4)} ${kid.id} outside the dock container`);
      }
    }
  }
  check(n > 0 && !bad.length, `H1: dock text never inside the plot or outside the dock during ${n} morph frames${bad.length ? ": " + bad.slice(0, 4).join("; ") : ""}`);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

/* recording 2D context (no canvas in node): every call is accepted; measureText is a stable stand-in */
function recCtx(W = 1440, H = 900) {
  const target = {canvas: {width: W, height: H, clientWidth: W, clientHeight: H}};
  return new Proxy(target, {
    get(t, k) {
      if (k === "canvas") return t.canvas;
      if (typeof k === "symbol") return undefined;
      return (...args) => {
        if (k === "measureText") return {width: 7 * String(args[0] ?? "").length};
        if (k === "createLinearGradient" || k === "createRadialGradient") return {addColorStop: () => {}};
        return undefined;
      };
    },
    set() { return true; },
  });
}
