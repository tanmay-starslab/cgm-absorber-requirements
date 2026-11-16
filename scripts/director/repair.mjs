// Director step 8 and the node gates (DESIGN_tierA §6.2 steps 8, 12; §1 G1/G2/G3/G12/G15/G19/G20). Pure functions of
// (story, beats, shots); the G3 sampler and the layout composer are injected (the page's own modules), so the director
// sees exactly what the page draws. Fixed candidate order; no randomness.
//
//   geomChecks(E, beatIds)          occlusion, clearance, G19 (slab, disk share, disk behind text/dock, tableau angle), G20
//   g3Band(E, beatIds, opts)        the projected beam vs visible text/eq bands (story_core recipe), every G1 CSS size
//   layoutCheck(E, beatIds, opts)   hud.itemsFor + layout.solve: G1 overlaps/outside/dock/hidden text, G2 type floor, G3
//                                   corridor crossings, G12 chrome in flight
//   continuity(E)                   self-check: |Δpos| per 0.001 p, NaN, up vector, cuts
//   repair(E, build)                per beat, the first VARIANT that passes (logged)
import {v3, project, projectSegment, viewFor, keepWeight, keepPts, KEEP_MARGIN_PX} from "../../docs/tng50/learn/how-a-spectrum-is-made/js/core/shots.js";
import {VARIANTS} from "./styles.mjs";

const {add, sub, mul, dot, cross, len, norm} = v3;
const DEG = Math.PI / 180;
const r3 = x => Math.round(x * 1000) / 1000;
export const CHECK = Object.freeze({occlusion: 0.5, clear_r90: 1.2, clear_centre: 15, slab_z: 2, slab_r: 30, disk_frac: 0.15,
  disk_behind_frac: 0.005, tableau_deg: 60, lod_vox: 48, capsule_half: 45, tube_r: 20, samples: 24});

/* E: evaluation context {S, Sc, docs: {beats, shots}, M (modules), data, T} */
export function frames(E, beatIds, n = CHECK.samples, cls = "desktop") {
  const seek = E.M.SK.makeSeek(E.docs), out = [];
  E.docs.beats.beats.forEach((b, i) => { b = {...b, i}; if (beatIds && !beatIds.includes(b.id)) return;
    // u = 0 is the previous beat's end pose (checked with that beat), so a beat's own samples start just after it
    for (let k = b.i === 0 ? 0 : 1; k <= n; k++) { const p = b.p0 + (b.p1 - b.p0) * (k === n ? 1 - 1e-7 : k / n); out.push({b, p, f: seek(p, E.data, {cls})}); }
  });
  return out;
}

/* encounter ellipsoids: centre P(lc), semi-axis (l1 − l0)/2 along the beam (≥ 2 kpc), r90 across it. q(x) is the
   ellipsoidal radius (1 on the surface) */
function shells(E) {
  const F = E.Sc.F;
  return (E.data.plan.encounters || []).filter(e => e.r90 > 0).map(e => {
    const c = F.P(e.lc), a = Math.max(2, (e.l1 - e.l0) / 2), r = e.r90;
    return {id: e.id, c, a, r, q: x => { const d = sub(x, c), al = dot(d, F.n), pe = len(sub(d, mul(F.n, al))); return Math.hypot(al / a, pe / r); }};
  });
}
/* disk circle (disk frame: z = 0, centre origin), radius max(2 r_half*, 10 kpc) */
function diskPoly(E, n = 48) {
  const d = E.data.galaxy.disk, rd = Math.max(2 * (d.r_half_star_kpc || d.r_kpc / 2), 10);
  return {rd, pts: Array.from({length: n}, (_, i) => { const a = 2 * Math.PI * i / n; return [rd * Math.cos(a), rd * Math.sin(a), 0]; })};
}
function polyArea(P) { let a = 0; for (let i = 0; i < P.length; i++) { const p = P[i], q = P[(i + 1) % P.length]; a += p[0] * q[1] - q[0] * p[1]; } return Math.abs(a) / 2; }
function clipPoly(P, r) {          // Sutherland–Hodgman against an axis-aligned rect {x, y, w, h}
  const edges = [[p => p[0] >= r.x, (a, b) => { const t = (r.x - a[0]) / (b[0] - a[0]); return [r.x, a[1] + t * (b[1] - a[1])]; }],
    [p => p[0] <= r.x + r.w, (a, b) => { const t = (r.x + r.w - a[0]) / (b[0] - a[0]); return [r.x + r.w, a[1] + t * (b[1] - a[1])]; }],
    [p => p[1] >= r.y, (a, b) => { const t = (r.y - a[1]) / (b[1] - a[1]); return [a[0] + t * (b[0] - a[0]), r.y]; }],
    [p => p[1] <= r.y + r.h, (a, b) => { const t = (r.y + r.h - a[1]) / (b[1] - a[1]); return [a[0] + t * (b[0] - a[0]), r.y + r.h]; }]];
  let out = P;
  for (const [inside, cut] of edges) { const inp = out; out = []; if (!inp.length) break;
    for (let i = 0; i < inp.length; i++) { const a = inp[(i + inp.length - 1) % inp.length], b = inp[i];
      if (inside(b)) { if (!inside(a)) out.push(cut(a, b)); out.push(b); } else if (inside(a)) out.push(cut(a, b)); } }
  return out;
}
/* finest hosted cube level whose box contains the point (levels: {L0: {half_kpc, voxel_kpc}, ...}) */
function levelAt(E, pt) {
  const lv = (E.S.hosted && E.S.hosted.levels) || {L0: {half_kpc: 400, voxel_kpc: 3.125}, L1: {half_kpc: 100, voxel_kpc: 0.78125}, L2: {half_kpc: 25, voxel_kpc: 0.1953125}};
  let best = null;
  for (const k of Object.keys(lv).sort()) { const L = lv[k]; if (Math.max(Math.abs(pt[0]), Math.abs(pt[1]), Math.abs(pt[2])) <= L.half_kpc && (!best || L.voxel_kpc < best.voxel_kpc)) best = {id: k, ...L}; }
  return best;
}

export function geomChecks(E, beatIds) {
  const fails = [], notes = [], C = CHECK, F = E.Sc.F, SH = shells(E), disk = diskPoly(E);
  const W = 1440, Hh = 900, cls = "desktop";
  const bandsFn = (side, dock) => E.M.LC.computeBands(cls, W, Hh, {textSide: side, dock});
  let g20min = Infinity;
  const tableauBeats = new Set(Object.entries(E.docs.shots.shots).filter(([, s]) => ["tableau", "pairTableau", "pullout"].includes(s.style)).map(([k]) => k));
  const chaseBeats = new Set(Object.entries(E.docs.shots.shots).filter(([, s]) => s.keys.every(k => k.kind === "chase")).map(([k]) => k));
  const seekQ = (() => { const sk = E.M.SK.makeSeek(E.docs); return q => sk(q, E.data, {cls: "desktop"}); })();
  for (const {b, p, f} of frames(E, beatIds)) {
    const cam = f.cam, tag = `${b.id}@${p.toFixed(4)}`;
    if (![...cam.pos, ...cam.target, ...cam.up, cam.fov].every(Number.isFinite)) { fails.push({gate: "self", beat: b.id, msg: `${tag} NaN camera`}); continue; }
    const shot = E.docs.shots.shots[b.shot] || {};
    const probe = F.P(f.l);
    // a blend-in (u < blendIn) is the move from the previous, already checked framing: occlusion, clearance and the tableau
    // angle are judged on the shot's own framing, after it
    const inBlend = !shot.cut && f.beat.u < (shot.blendIn ?? 0.3) && b.i > 0;
    // (1) occlusion: path camera → target inside a non-target shell for > 50 %
    // target shells: the one the camera looks into, the one the probe is in, and the one around the beam point nearest the
    // look target (seek's comfort smoothing moves the look point slightly off the shot's own target)
    const tb = F.P(dot(sub(cam.target, F.P(0)), F.n));
    const tShells = new Set(SH.filter(s => s.q(cam.target) <= 1 || s.q(probe) <= 1 || s.q(tb) <= 1).map(s => s.id));
    // the travelling capsule (seek capsule: ±45 kpc along the beam about the probe, radius capR) is carved out of the
    // volume (DESIGN_final D4), so path samples inside it are never occluded
    const capR = Math.max(C.tube_r, (f.capsule && f.capsule.r) || 0);
    const inCap = q => { const d = sub(q, probe), al = dot(d, F.n); return Math.abs(al) <= C.capsule_half && len(sub(d, mul(F.n, al))) <= capR; };
    let inside = 0; const NS = 32;
    for (let i = 1; i < NS; i++) { const q = add(cam.pos, mul(sub(cam.target, cam.pos), i / NS)); if (!inCap(q) && SH.some(s => !tShells.has(s.id) && s.q(q) <= 1)) inside++; }
    if (!inBlend && inside / (NS - 1) > C.occlusion) fails.push({gate: "occlusion", beat: b.id, msg: `${tag} ${(100 * inside / (NS - 1)).toFixed(0)} % of the view path inside a non-target shell`});
    // (2) clearance (orbits, poses, tableaux; a chase flies through its clouds by design): ≥ 1.2 r90 from non-target shells
    if (!chaseBeats.has(b.shot) && !inBlend) for (const s of SH) if (!tShells.has(s.id) && s.q(cam.pos) < C.clear_r90) { fails.push({gate: "clearance", beat: b.id, msg: `${tag} camera at ${r3(s.q(cam.pos))} shell radii from ${s.id} (< ${C.clear_r90})`}); break; }
    if (len(cam.pos) < C.clear_centre) fails.push({gate: "clearance", beat: b.id, msg: `${tag} camera ${r3(len(cam.pos))} kpc from the galaxy centre`});
    // G19 slab: never inside |z| < 2 kpc within 30 kpc
    if (Math.abs(cam.pos[2]) < C.slab_z && Math.hypot(cam.pos[0], cam.pos[1]) < C.slab_r) fails.push({gate: "G19", beat: b.id, msg: `${tag} camera inside the disk slab`});
    // G19 tableau angle: view ≥ 60° from the disk normal
    if (tableauBeats.has(b.shot) && b.kind !== "gate" && !inBlend) { const fv = norm(sub(cam.target, cam.pos)); const ang = Math.acos(Math.min(1, Math.abs(fv[2]))) / DEG;
      if (ang < C.tableau_deg - 1e-6) fails.push({gate: "G19", beat: b.id, msg: `${tag} tableau view ${r3(ang)}° from the disk normal (< 60°)`}); }
    // G19 disk share / disk behind text or dock (desktop 1440x900), outside B0/B2
    if (b.id !== "B0" && b.id !== "B2") {
      const view = viewFor(cam, W, Hh, bandsFn, {dock: f.spec.dock, dockFrom: f.spec.dockFrom, dockMix: f.spec.dockMix});
      const pr = disk.pts.map(q => project(cam, view, q));
      if (pr.some(q => !q.ok)) { if (len(cam.pos) < 3 * disk.rd) fails.push({gate: "G19", beat: b.id, msg: `${tag} disk partly behind the camera at ${r3(len(cam.pos))} kpc`}); }
      else {
        const poly = pr.map(q => [q.x, q.y]);
        const vis = clipPoly(poly, {x: 0, y: 0, w: W, h: Hh}), frac = polyArea(vis) / (W * Hh);
        if (frac > C.disk_frac) fails.push({gate: "G19", beat: b.id, msg: `${tag} disk covers ${(100 * frac).toFixed(1)} % of the frame`});
        const bands = bandsFn(f.cam.textSide || "left", f.spec.dock || "strip");
        const hasText = f.text && f.text.some(t => t.band === "text");
        for (const [nm, r] of [["text column", hasText ? bands.text : null], ["dock", bands.dock]]) if (r) { const a = polyArea(clipPoly(vis, r)); if (a > C.disk_behind_frac * W * Hh) fails.push({gate: "G19", beat: b.id, msg: `${tag} disk behind the ${nm} (${a.toFixed(0)} px²)`}); }
      }
    }
    // G20 LOD floor: frame width at the target ≥ 48 voxels of the finest level holding it, unless the target is in the
    // travelling capsule (near field: the stage draws the gas cells themselves there, not cube voxels)
    const along = dot(sub(cam.target, probe), F.n), perp = len(sub(sub(cam.target, probe), mul(F.n, along)));
    const nearField = Math.abs(along) <= C.capsule_half && perp <= C.tube_r;
    // G20 judges held framings: a frame inside a blend-in or an active dolly (camera distance changing by more than 5 % per
    // 0.001 p; the hero's B3 dive and B11 pull-out are such passages) is in transit, not a framing
    let dolly = false;
    if (!nearField && !inBlend) { const fa = seekQ(Math.max(0, p - 5e-4)), fb = seekQ(Math.min(1, p + 5e-4));
      dolly = Math.abs(Math.log(fb.cam.dist / fa.cam.dist)) > 0.05; }
    if (!nearField && !inBlend && !dolly) {
      const lv = levelAt(E, cam.target);
      if (lv) { const d = len(sub(cam.target, cam.pos)), Wf = 2 * d * Math.tan(cam.fov / 2 * DEG) * (W / Hh), need = C.lod_vox * lv.voxel_kpc;
        g20min = Math.min(g20min, Wf / need);
        if (Wf < need - 1e-6) fails.push({gate: "G20", beat: b.id, msg: `${tag} frame ${r3(Wf)} kpc < ${r3(need)} kpc (${lv.id})`}); }
    }
  }
  if (Number.isFinite(g20min)) notes.push(`G20 min frame/floor ratio ${r3(g20min)}`);
  return {fails, notes};
}

/* G3 (story_core recipe): projected whole-beam segment never crosses a visible text or equation band */
function segHitsRect(a, b, r) {
  const x0 = r.x, y0 = r.y, x1 = r.x + r.w, y1 = r.y + r.h; let t0 = 0, t1 = 1; const dx = b[0] - a[0], dy = b[1] - a[1];
  const P = [-dx, dx, -dy, dy], Q = [a[0] - x0, x1 - a[0], a[1] - y0, y1 - a[1]];
  for (let i = 0; i < 4; i++) { if (P[i] === 0) { if (Q[i] < 0) return false; continue; }
    const t = Q[i] / P[i]; if (P[i] < 0) { if (t > t1) return false; if (t > t0) t0 = t; } else { if (t < t0) return false; if (t < t1) t1 = t; } }
  return t0 <= t1;
}
export function g1Sizes(M, quick = false) {
  const m = new Map();
  const list = quick ? [[1440, 900], [1024, 768], [390, 844], [683, 512], [260, 563], [844, 390]].map(([w, h]) => ({w, h})) : [...M.LC.g1Matrix(), {w: 683, h: 512}, {w: 260, h: 563}];
  for (const x of list) m.set(`${x.w}x${x.h}`, {w: x.w, h: x.h, cls: M.LC.layoutClass(x.w, x.h)});
  return [...m.values()];
}
export function g3Band(E, beatIds, {np = 160, quick = false, per = 13} = {}) {
  const {SK, SH, LC} = E.M, seek = SK.makeSeek(E.docs), ctx = SK.prepare(E.data, E.docs.beats, E.docs.shots), tl = ctx.tl;
  const hits = []; let frames = 0;
  const ps = [];
  for (let i = 0; i < np; i++) { const p = (i + 0.5) / np; const L = tl.locate(p); if (!beatIds || beatIds.includes(L.beat.id)) ps.push(p); }
  if (beatIds) for (const b of tl.beats) if (beatIds.includes(b.id)) for (let k = 0; k < per; k++) ps.push(b.p0 + (b.p1 - b.p0) * (k + 0.5) / per);
  for (const {w, h, cls} of g1Sizes(E.M, quick)) for (const p of ps) {
    const f = seek(p, E.data, {cls});
    if (f.ui.inset >= 0.5) continue;
    const bandsFn = (side, dock) => LC.computeBands(cls, w, h, {textSide: side, dock});
    const kw = keepWeight(tl.beats, f.p, f.l, ctx.half);
    const keep = kw > 0 ? {pt: ctx.frame.P(f.l), pts: keepPts(f, ctx.cellPos), marginPx: KEEP_MARGIN_PX, rect: bandsFn(f.cam.textSide || "left", f.spec.dock || "strip").world, weight: kw} : null;
    const view = viewFor(f.cam, w, h, bandsFn, {dock: f.spec.dock, dockFrom: f.spec.dockFrom, dockMix: f.spec.dockMix, keep});
    const bands = bandsFn(f.cam.textSide, f.spec.dock);
    frames++;
    const seg = projectSegment(f.cam, view, ctx.frame.P(-ctx.half), ctx.frame.P(ctx.half), 1);
    if (!seg) continue;
    const boxes = [];
    if (f.text.some(t => t.band === "text") && bands.text) boxes.push(["text", bands.text]);
    const phoneish = ["phonePortrait", "phoneLandscape", "narrow"].includes(cls);
    if (f.eqs.some(e => !(e.noPhone && phoneish)) && bands.eq) boxes.push(["eq", bands.eq]);
    for (const [k, r] of boxes) if (segHitsRect(seg[0], seg[1], r)) hits.push({gate: "G3", beat: f.beat.id, msg: `${f.beat.id}@${p.toFixed(4)} ${cls} ${w}x${h} beam crosses the ${k} band`});
  }
  return {fails: hits, frames};
}

/* the page's composer and solver (H0 recipe): G1, G2, G3 (corridor), G12 */
export function layoutCheck(E, beatIds, {np = 160, quick = false, reducedBoth = true} = {}) {
  const {SK, HUD, L, LC} = E.M, seek = SK.makeSeek(E.docs), PREP = SK.prepare(E.data, E.docs.beats, E.docs.shots);
  const STORY = {beats: E.docs.beats.beats, copy: E.S.copy, lookup: E.S.lookup, flags: E.S.copyFlags, eq: E.S.EQ};
  const matrix = quick ? [[1440, 900], [1024, 768], [390, 844], [683, 512], [260, 563]].map(([w, h]) => ({w, h})) : [...LC.g1Matrix(), {w: 683, h: 512}, {w: 260, h: 563}];
  const ps = [];
  for (let k = 0; k < np; k++) { const p = (k + 0.5) / np; if (!beatIds || beatIds.includes(PREP.tl.locate(p).beat.id)) ps.push(p); }
  const fails = [], cnt = {frames: 0, overlap: 0, outside: 0, overDock: 0, hidden: 0, small: 0, g3: 0, chrome: 0};
  const push = (gate, beat, msg) => { if (fails.length < 400) fails.push({gate, beat, msg}); };
  for (const m of matrix) { const cls = LC.layoutClass(m.w, m.h);
    for (const reduced of reducedBoth ? [false, true] : [false]) for (const p of ps) {
      const f = seek(p, E.data, {cls});
      const got = HUD.itemsFor(f, {w: m.w, h: m.h, reduced, story: STORY, sizes: E.S.SIZES, prep: PREP});
      const out = L.solve(got.items, got.ctx); cnt.frames++;
      const tag = `${f.beat.id}@${p.toFixed(4)} ${cls} ${m.w}x${m.h}${reduced ? " rm" : ""}`;
      const ov = L.overlaps(out.placed, {w: m.w, h: m.h, tol: 4});
      for (const o of ov) { if (o.b === "viewport") { cnt.outside++; push("G1", f.beat.id, `${tag} box outside the viewport ${o.a}`); } else { cnt.overlap++; push("G1", f.beat.id, `${tag} overlap ${o.a} / ${o.b}`); } }
      const dockB = out.byId.dock;
      if (dockB) for (const b of out.placed) if (b.id !== "dock" && b.container !== "dock" && !b.exempt) { const a = Math.max(0, Math.min(b.x + b.w, dockB.x + dockB.w) - Math.max(b.x, dockB.x)) * Math.max(0, Math.min(b.y + b.h, dockB.y + dockB.h) - Math.max(b.y, dockB.y)); if (a > 4) { cnt.overDock++; push("G1", f.beat.id, `${tag} ${b.id} over the dock`); } }
      for (const b of out.placed) { const it = got.items.find(x => x.id === b.id); const v = it && (it.variants ? it.variants[b.variant] : it.size); if (v && v.font != null && v.font < 12) { cnt.small++; push("G2", f.beat.id, `${tag} ${b.id} font ${v.font} px`); } }
      for (const c of got.ctx.corridors || []) for (const b of out.placed) if ((b.kind === "display" || b.kind === "eq") && L.segmentHitsRect(c.a, c.b, c.r || 0, b)) { cnt.g3++; push("G3", f.beat.id, `${tag} beam crosses ${b.id}`); }
      for (const kt of HUD.activeText(f.text, E.S.copyFlags)) {
        const kid = "kt:" + E.M.K.textKey(kt), it = got.items.find(x => x.id === kid), hid = out.hidden.find(h => h.id === kid);
        if (it && (it.opacity == null || it.opacity >= 0.02) && !out.byId[kid] && hid && hid.reason !== "group") { cnt.hidden++; push("G1", f.beat.id, `${tag} display hidden ${kid} (${hid.reason})`); }
      }
      if (!HUD.phaseVisible(f) && p >= 0.02 && HUD.chromeCount(out) > 4) { cnt.chrome++; push("G12", f.beat.id, `${tag} ${HUD.chromeCount(out)} chrome elements in flight`); }
    } }
  return {fails, cnt};
}

/* self-check (§6.2 step 12), the v2 shots rule of tests/js/story_core.mjs (the hand-tuned hero passes it): per 1e-4 p the
   camera's offset from the probe moves ≤ (0.5 kpc + 0.3 |offset|)/10 and the up vector turns ≤ 5°, except across declared
   cuts; no NaN. (The design's flat 0.5 kpc per 0.001 p of the absolute position would fail the hero's own pull-outs, which
   move 64 kpc per 0.001 p.) range: [p0, p1] sub-range (repair), sampled at the same 1e-4 p step */
export function continuity(E, N = 10000, range = null, classes = [undefined, "phonePortrait"]) {
  const seek = E.M.SK.makeSeek(E.docs), ctx = E.M.SK.prepare(E.data, E.docs.beats, E.docs.shots), fails = []; let worst = 0;
  const cuts = E.docs.beats.beats.filter(b => (E.docs.shots.shots[b.shot] || {}).cut).map(b => b.p0);
  const [p0, p1] = range || [0, 1];
  const step = range ? 1e-4 : 1 / N, i0 = Math.floor(p0 / step), i1 = Math.ceil(p1 / step);
  const off = f => { const P = ctx.frame.P(f.l); return f.cam.pos.map((x, k) => x - P[k]); };
  for (const cls of classes) {
    let prev = null;
    for (let i = i0; i <= i1; i++) {
      const p = Math.min(1, Math.max(0, i * step)), f = seek(p, E.data, {cls}), c = f.cam;
      if (![...c.pos, ...c.target, ...c.up].every(Number.isFinite)) { fails.push({gate: "self", beat: f.beat.id, msg: `p ${p.toFixed(5)} NaN camera`}); prev = null; continue; }
      if (prev) {
        const isCut = cuts.some(q => p > q - 1e-9 && prev.p < q + 1e-9);
        if (!isCut) {
          const o1 = off(f), o0 = off(prev.f), r0 = len(o0), d = len(sub(o1, o0)) * (1e-4 / step);
          const rel = d * 10 / (0.5 + 0.3 * r0); worst = Math.max(worst, rel);
          if (rel > 1) fails.push({gate: "self", beat: f.beat.id, msg: `p ${p.toFixed(5)} ${cls || "default"}: camera offset moves ${r3(d * 10)} kpc per 0.001 p (allowance ${r3(0.5 + 0.3 * r0)})`});
          const upd = Math.acos(Math.min(1, dot(c.up, prev.f.cam.up))) / DEG * (1e-4 / step);
          if (upd > 5) fails.push({gate: "self", beat: f.beat.id, msg: `p ${p.toFixed(5)} ${cls || "default"}: up turns ${r3(upd)}° per 1e-4 p`});
        }
      }
      prev = {p, f};
      if (fails.length > 60) break;
    }
  }
  return {fails, worstRel: r3(worst)};
}

/* role audit (§6.2 step 9: an unknown role throws in the director) */
export function auditRoles(E) {
  const out = [], SK = E.M.SK, add = (ref, where) => { if (SK.isRole(ref)) out.push({ref, where}); };
  for (const b of E.docs.beats.beats) {
    add(b.cell, `${b.id}.cell`);
    for (const t of b.text || []) add(t.anchor && t.anchor.ref, `${b.id}/${t.id}.anchor`);
    for (const e of b.eqs || []) { add(e.anchor && e.anchor.ref, `${b.id}/${e.id}.anchor`); const g = String(e.ghost || ""); if (g.includes("@")) add(g.slice(g.indexOf("@")), `${b.id}/${e.id}.ghost`); }
  }
  const walk = (x, w) => { if (SK.isRole(x)) add(x, w); else if (x && typeof x === "object") for (const k of Object.keys(x)) walk(x[k], `${w}.${k}`); };
  walk(E.docs.shots.shots, "shots");
  const res = [];
  for (const {ref, where} of out) {
    const r = SK.resolveRole(E.data, ref), eq = /\/E\w+\.(anchor|ghost)$/.test(where);
    if (!r) res.push({ref, where, kind: "unknown"});
    else if (r.cell == null && !r.c && !Number.isFinite(r.l)) res.push({ref, where, kind: "noPosition"});
    else if (eq && !r.ok) res.push({ref, where, kind: "okFalse", why: r.why});
  }
  const bad = res.filter(a => a.kind === "unknown" || a.kind === "noPosition");
  if (bad.length) throw new Error("director: unresolved roles: " + bad.map(a => `${a.ref} at ${a.where}`).join("; "));
  return res;
}

/* per beat, in story order, the first variant that passes the beat's checks (§6.2 step 8). build(beat, variant) -> shot.
   Checks: geometry (occlusion, clearance, G19, G20), the G3 band sampler on the quick sizes, the page layout (quick).
   Returns {shots, log, failed: [beatId]} */
export function repair(E, build, {layout = true, beats = null, fallbacks = null} = {}) {
  const log = [], failed = [];
  for (const b of E.docs.beats.beats) {
    if (beats && !beats.includes(b.id)) continue;
    const tried = [];
    let kept = null;
    const styles = [null, ...(fallbacks ? fallbacks(b) : [])];
    // the beat and its neighbours (seek's comfort smoothing reaches ±0.024 p into them; the next beat blends from this
    // end): a candidate must clear the beat itself and must not add failures to the previous beat ("do no harm")
    const all = E.docs.beats.beats, bi = all.findIndex(x => x.id === b.id);
    const ids = all.slice(Math.max(0, bi - 1), bi + 2).map(x => x.id);
    const lo = all[Math.max(0, bi - 1)].p0, hi = all[Math.min(all.length - 1, bi + 1)].p1;
    // cheapest checks first; a later (costlier) check runs only when the earlier ones leave this beat clean
    const evalFails = () => {
      const fs = [...geomChecks(E, ids).fails];
      const own = () => fs.some(x => x.beat === b.id);
      if (!own()) fs.push(...continuity(E, 0, [lo, hi], [undefined, "phonePortrait"]).fails);
      if (!own()) fs.push(...g3Band(E, ids, {np: 1600, quick: false, per: 0}).fails);   // every G1 CSS size, the final check's own 1600 p grid
      if (!own() && layout) fs.push(...layoutCheck(E, ids, {np: 320, quick: true, reducedBoth: false}).fails.filter(x => x.gate !== "G1" || !/display hidden/.test(x.msg)));
      return fs;
    };
    // harm is counted on the previous beat only (already repaired); the next beat is repaired after this one
    const prevId = bi > 0 ? all[bi - 1].id : null;
    const baseN = evalFails().filter(x => x.beat === prevId).length;
    const seen = new Set();
    outer: for (const alt of styles) for (const v of VARIANTS) {
      // a flight cuts only in its last fallback style (a cut mid-flight is the least wanted repair)
      if (v.cut && b.kind === "flight" && alt !== styles[styles.length - 1]) continue;
      const shot = build(b, v, alt);
      if (shot == null) break;
      const key = JSON.stringify(shot.keys) + (shot.cut ? "c" : "") + shot.blendIn;
      if (seen.has(key)) continue; seen.add(key);
      const prevShot = E.docs.shots.shots[b.shot];
      E.docs = {beats: E.docs.beats, shots: {...E.docs.shots, shots: {...E.docs.shots.shots, [b.shot]: shot}}};
      const fsAll = evalFails(), own = fsAll.filter(x => x.beat === b.id), nb = fsAll.filter(x => x.beat === prevId);
      const fs = [...own, ...(nb.length > baseN ? nb : [])];
      tried.push({variant: (alt ? alt + ":" : "") + v.tag, fails: fs.length, first: fs.slice(0, 2).map(x => `${x.gate} ${x.msg}`)});
      if (!fs.length) { kept = (alt ? `style ${alt}, ` : "") + v.tag; break outer; }
      E.docs = {beats: E.docs.beats, shots: {...E.docs.shots, shots: {...E.docs.shots.shots, [b.shot]: prevShot}}};
    }
    if (!kept) {
      // nothing passed: keep the calibrated shot, mark the beat (the story is not eligible for its case; §6.2 step 8)
      const shot = build(b, VARIANTS[0]);
      E.docs = {beats: E.docs.beats, shots: {...E.docs.shots, shots: {...E.docs.shots.shots, [b.shot]: shot}}};
      failed.push(b.id);
    }
    log.push({beat: b.id, kept: kept || "none (calibrated kept, beat failing)", tried: tried.length > 1 || !kept ? tried : undefined});
  }
  return {log, failed};
}
