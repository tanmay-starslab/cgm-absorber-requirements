// Director step 4-6 (DESIGN_tierA §6.2): shots from the calibrated hero coefficients and each ray's own scales.
// Pure and deterministic. Four styles: halo orbit (gate/halo), chase (flights), cloud orbit (stops, damped core),
// side tableau (B7p, B10w, B12n, lookback/readback, empty holds), plus the hero's fixed framings scaled by half.
//
//   scales(S)                        -> story length scales {R, half, lStart, sEnc(l0, l1), sGap(l0, l1), hCell(role), ...}
//   shotFor(beat, style, S, v)       -> shot {textSide, cut?, blendIn?, keys, style, note}
//   VARIANTS                         -> the fixed repair order (§6.2 step 8)
import {rayFrame, v3} from "../../docs/tng50/learn/how-a-spectrum-is-made/js/core/shots.js";
import {tauPeak, ionCells} from "./compose.mjs";

const {add, sub, mul, dot, cross, len, norm} = v3;
const DEG = Math.PI / 180;
const clamp = (x, a, b) => Math.max(a, Math.min(b, x));
const r3 = x => Math.round(x * 1000) / 1000;

/* the fixed repair list: az0 {calibrated, ±20°, ±40°, ±60°} → side flip → el ±15°/±30° away from the disk → scale */
export const VARIANTS = (() => {
  const out = [{tag: "calibrated", rot: 0, flip: false, el: 0, scale: 1}];
  for (const a of [20, -20, 40, -40, 60, -60]) out.push({tag: `az${a > 0 ? "+" : ""}${a}`, rot: a, flip: false, el: 0, scale: 1});
  out.push({tag: "flip", rot: 0, flip: true, el: 0, scale: 1});
  for (const e of [15, 30]) out.push({tag: `el${e}`, rot: 0, flip: false, el: e, scale: 1});
  for (const s of [1.25, 0.8, 1.6]) out.push({tag: `scale${s}`, rot: 0, flip: false, el: 0, scale: s});
  // appended (R3): the beam's screen slope and the blend length. A side view's roll is re-solved by beamAngle, so a
  // rotation about the beam cannot move the projected beam line; only its slope sign and the blend from the previous
  // beat can (both left the hero's shots untouched)
  const base = {rot: 0, flip: false, el: 0, scale: 1};
  // orbits only: lift the look point above the beam by a fraction of the orbit radius, so the projected beam runs lower
  // across the frame (clears an equation band sitting just above the world band; tablet classMods fix the beam slope at
  // 26°, so no slope variant can)
  for (const lift of [0.06, 0.12, 0.2]) out.push({tag: `lift${lift}`, ...base, lift});
  // appended combinations, fixed order: beam slope {template, asc, steep 65° desc, steep 65° asc} × blend {template, 0.15,
  // 0.8} × rotation {0, ±20°, ±40°} × scale {1, 1.25}; the design list above comes first
  const beams = [{}, {beamSign: "asc"}, {beamSign: "desc", beamAngle: 65}, {beamSign: "asc", beamAngle: 65}];
  const bname = ["", "asc", "steep", "steepAsc"];
  for (let bi = 0; bi < beams.length; bi++) for (const bl of [null, 0.15, 0.8]) for (const rot of [0, 20, -20, 40, -40]) for (const sc of [1, 1.25]) {
    if (bi === 0 && bl == null && (rot === 0 || sc === 1)) continue;          // already in the design list
    const tag = [bname[bi], bl != null ? `blend${bl}` : "", rot ? `az${rot > 0 ? "+" : ""}${rot}` : "", sc !== 1 ? `scale${sc}` : ""].filter(Boolean).join("+");
    out.push({tag, ...base, rot, scale: sc, ...beams[bi], ...(bl != null ? {blend: bl} : {})});
  }
  // last resort before the style fallbacks: a declared cut into the framing (no blend; seek's comfort smoothing and the
  // continuity check both respect cuts)
  out.push({tag: "cut", ...base, cut: true}, {tag: "cut+asc", ...base, cut: true, beamSign: "asc"}, {tag: "cut+steep", ...base, cut: true, beamSign: "desc", beamAngle: 65});
  return out;
})();

export function scales(S) {
  const {data, half} = S, plan = data.plan, enc = plan.encounters || [];
  const R = (data.galaxy && data.galaxy.R200c) || data.meta.R200c_kpc;
  const F = rayFrame({p0: data.geometry.ray.p0, p1: data.geometry.ray.p1, n: data.geometry.ray.n, zdisk: [0, 0, 1]});
  // side axis of the tableaux: n̂ × b̂ (b̂ = closest approach direction), on the −ê₁ side like the hero's cameras
  const bhat = norm(F.P(0));
  let ax = norm(cross(F.n, bhat)); if (dot(ax, F.e1) > 0) ax = mul(ax, -1);
  const sideAxis = {side: dot(ax, F.e1), up: dot(ax, F.e2)};
  const sEnc = (l0, l1) => {
    let best = null, bo = 0;
    for (const e of enc) { const o = Math.min(l1, e.l1) - Math.max(l0, e.l0); if (o > bo && e.r90 > 0) { bo = o; best = e; } }
    return best ? clamp(best.r90, 4, 30) : clamp(Math.abs(l1 - l0) / 6, 4, 30);
  };
  const sGap = (l0, l1) => clamp(Math.abs(l1 - l0) / 6, 4, 30);
  const cellOf = role => { const r = data.roles[String(role).replace(/^@/, "")]; return r && r.cell != null ? data.roles.cells[String(r.cell)] : null; };
  const hCell = role => { const c = cellOf(role); return clamp(c && c.h ? c.h : 2, 0.5, 6); };
  const r90At = l => { let r = 0; for (const e of enc) if (l >= e.l0 - 1 && l <= e.l1 + 1) r = Math.max(r, e.r90 || 0); return r; };
  return {R, half, lStart: S.lStart, F, sideAxis, sEnc, sGap, hCell, cellOf, r90At, host: data.meta.galaxy};
}

/* ---------------------------------------------------------------- variants */
/* rotate a ray-frame offset (up, side) about n̂ by deg */
function rot2(up, side, deg) { const c = Math.cos(deg * DEG), s = Math.sin(deg * DEG); return [up * c + side * s, -up * s + side * c]; }
function applyVariantKey(k, v) {
  const q = JSON.parse(JSON.stringify(k));
  const rot = (v.rot || 0) + (v.elRot || 0);
  const tw = o => { if (!o || typeof o !== "object" || o.mix || Array.isArray(o)) return o;
    let up = o.up || 0, side = o.side || 0;
    if (rot) [up, side] = rot2(up, side, rot);
    if (v.flip) side = -side;
    if (v.scale !== 1) { up *= v.scale; side *= v.scale; if (o.back) o.back = r3(o.back * v.scale); }
    if (up || "up" in o) o.up = r3(up); if (side || "side" in o) o.side = r3(side); return o; };
  if (q.kind === "chase") {
    let up = q.up ?? 3, side = q.side ?? 4;
    if (rot) [up, side] = rot2(up, side, rot);
    if (v.flip) side = -side;
    q.up = r3(up * v.scale); q.side = r3(side * v.scale); q.back = r3((q.back ?? 10) * v.scale);
  } else if (q.kind === "orbit") {
    q.az0 = r3((q.az0 ?? 0) + rot); q.az1 = r3((q.az1 ?? q.az0 ?? 0) + rot);
    if (v.flip) { q.az0 = -q.az0; q.az1 = -q.az1; }
    q.el = r3(clamp((q.el ?? 20) + (v.el || 0), -80, 80));
    q.r = r3((q.r ?? 100) * v.scale);
    if (v.lift && q.center && typeof q.center === "object" && !q.center.mix) q.center = {...q.center, up: r3((q.center.up || 0) + v.lift * q.r)};
  } else if (q.kind === "pose") {
    // scale the camera's distance from its look point: offsets, and the l lead of `at` over `look`
    if (q.at && typeof q.at === "object" && q.look && typeof q.look === "object" && typeof q.at.l === "number" && typeof q.look.l === "number" && v.scale !== 1)
      q.at.l = r3(q.look.l + (q.at.l - q.look.l) * v.scale);
    q.at = tw(q.at);
  }
  return q;
}

/* ---------------------------------------------------------------- coefficient keys -> keys */
function scaleKey(k, unit, anchor, S, extra = {}) {
  const c = JSON.parse(JSON.stringify(k)), H = S.half;
  const lMul = l => (typeof l === "number" ? r3(anchor === "start" ? S.lStart + l * H : anchor === "end" ? H + l * H : l * H) : l);
  const pt = p => {
    if (!p || typeof p !== "object" || Array.isArray(p)) return p;
    if (p.mix) return {mix: [pt(p.mix[0]), pt(p.mix[1]), p.mix[2]]};
    const q = {...p}; const numL = typeof q.l === "number";
    if (numL) q.l = lMul(q.l);
    for (const f of ["back", "up", "side"]) if (typeof q[f] === "number") q[f] = r3(q[f] * (numL ? H : unit));
    return q;
  };
  if (c.kind === "chase") for (const f of ["back", "up", "side", "lookAhead"]) { if (f in c) c[f] = r3(c[f] * unit); }
  if (c.kind === "orbit") { if (typeof c.r === "number") c.r = r3(c.r * unit); if (c.center && typeof c.center === "object") c.center = pt(c.center); }
  if (c.kind === "pose") { c.at = pt(c.at); if (c.look) c.look = pt(c.look); }
  return Object.assign(c, extra);
}
function fromCoef(T, name, S, unit, extra) {
  const co = T.coeffs[name]; if (!co) throw new Error(`no coefficients for ${name}`);
  const keys = co.keys.map(k => {
    const absChase = (name === "thread" || name === "lookback") && k.kind === "chase";
    return scaleKey(k, absChase ? 1 : unit, co.anchor, S, extra);
  });
  const meta = {};
  for (const f of ["textSide", "cut", "blendIn"]) if (f in co) meta[f] = co[f];
  return {meta, keys};
}

/* ---------------------------------------------------------------- tableau geometry */
/* a side view of a stretch of the beam: camera on the side axis (n̂ × b̂), rotated about n̂ (in 5° steps, fixed order)
   until the view is ≥ minDeg from the disk normal; fit-to-bounds distance */
export function tableauPose(Sc, lc, rBound, opt = {}) {
  const fov = opt.fov ?? 48, fit = opt.fit ?? 1.15, minDeg = opt.minDeg ?? 60;
  const d = rBound / Math.tan(fov / 2 * DEG) * fit * (opt.scale ?? 1);
  let base = [Sc.sideAxis.up, Sc.sideAxis.side];
  if (opt.axis) base = opt.axis;
  { const m = Math.hypot(base[0], base[1]) || 1; base = [base[0] / m, base[1] / m]; }
  const c = Sc.F.P(lc), z = [0, 0, 1];
  const steps = [0]; for (let a = 5; a <= 90; a += 5) steps.push(a, -a);
  let pick = null;
  for (const a of steps) {
    const [u, s] = rot2(base[0], base[1], a + (opt.rot || 0));
    const off = add(mul(Sc.F.e2, u * d), mul(Sc.F.e1, (opt.flip ? -1 : 1) * s * d)), pos = add(c, off);
    const f = norm(sub(c, pos));
    const ang = Math.acos(Math.min(1, Math.abs(dot(f, z)))) / DEG;
    if (ang >= minDeg && Math.abs(pos[2]) >= 2) { pick = {up: u * d, side: (opt.flip ? -1 : 1) * s * d, rot: a, ang}; break; }
  }
  if (!pick) { const [u, s] = base; pick = {up: u * d, side: s * d, rot: 0, ang: null, fail: true}; }
  return {d, fov, ...pick};
}
function tableauShot(Sc, l0, l1, opt, T) {
  const g = T.generated.tableau;
  const lc = (l0 + l1) / 2, rB = Math.max(opt.rMin ?? 20, Math.abs(l1 - l0) / 2 + (opt.pad ?? 10));
  const tp = tableauPose(Sc, lc, rB, {fov: opt.fov ?? g.fov, fit: opt.fit ?? g.fit, minDeg: g.disk_view_min_deg, rot: opt.rot, flip: opt.flip, scale: opt.scale});
  const dl = (opt.dolly ?? g.dolly) * rB * (opt.dir ?? 1);
  const k0 = {u: 0, kind: "pose", at: {l: r3(lc), up: r3(tp.up), side: r3(tp.side)}, look: {l: r3(lc)}, fov: tp.fov, beamAngle: 50, beamSign: "desc"};
  const k1 = {u: 1, kind: "pose", at: {l: r3(lc + dl), up: r3(tp.up * 0.96), side: r3(tp.side * 0.96)}, look: {l: r3(lc + dl)}, fov: tp.fov, beamAngle: 50, beamSign: "desc", ease: "linear"};
  return {keys: [k0, k1], info: {lc: r3(lc), rBound: r3(rB), d: r3(tp.d), rotForDisk: tp.rot, diskViewDeg: tp.ang == null ? null : r3(tp.ang), diskFail: !!tp.fail}};
}

/* ---------------------------------------------------------------- shots per style */
export function shotFor(b, style, S, Sc, T, v = VARIANTS[0], ctx = {}) {
  const note = [];
  const vv = {...v};
  // el variant: for orbits a real elevation change; for chase/pose a rotation about n̂ away from the disk plane
  if (v.el && ctx.elSign) vv.elRot = v.el * ctx.elSign;
  let shot;
  const H = Sc.half, lo = Math.min(b.l0, b.l1), hi = Math.max(b.l0, b.l1);
  const C = ionCells(S.data, S.lead), peak = b.kind === "flight" ? tauPeak(C, lo, hi) : 0;
  let st = style;
  // nothing to point at (§6.2 step 4): a chase only when the lead-ion peak τ in the window is ≥ 0.1, otherwise a tableau
  const chaseLike = ["drop", "first", "cloudA", "quiet", "cloudB", "restB", "coldknot", "cloudD", "chaseOrbit", "wide", "thread"];
  if (b.kind === "flight" && chaseLike.includes(st) && peak < T.generated.chaseThreshold_tau && !ctx.keepChase) { note.push(`lead-ion peak τ ${r3(peak)} < ${T.generated.chaseThreshold_tau}: tableau`); st = "tableau"; }
  const wide = (ctx.wide ? T.generated.wide : 1);
  const enc = Sc.sEnc(lo, hi), gap = Sc.sGap(lo, hi);
  switch (st) {
    case "gate": case "halo": { const {meta, keys} = fromCoef(T, st, S, Sc.R); shot = {...meta, keys}; break; }
    case "coldopen": case "telescope": case "telescopeHold": case "readback": case "yours": case "lookback": {
      const {meta, keys} = fromCoef(T, st, S, H); shot = {...meta, keys}; break; }
    case "halfway": { const {meta, keys} = fromCoef(T, "halfway", S, 1); shot = {...meta, keys}; break; }
    case "drop": case "first": case "quiet": {
      const {meta, keys} = fromCoef(T, st, S, gap * wide); shot = {...meta, keys}; note.push(`s_gap ${r3(gap)}${wide !== 1 ? " ×" + wide : ""}`); break; }
    case "cloudA": case "cloudB": case "restB": case "coldknot": case "cloudD": case "wide": {
      const name = st === "wide" ? "cloudA" : st;
      const {meta, keys} = fromCoef(T, name, S, enc * wide); shot = {...meta, keys}; note.push(`s_enc ${r3(enc)}${wide !== 1 ? " ×" + wide : ""}`); break; }
    case "chaseOrbit": {
      // chase into the cloud (the hero's hold-out-then-close-in keys up to u 0.5), then one slow orbit about the role
      const {meta, keys} = fromCoef(T, "cloudA", S, enc * wide);
      const role = ctx.role || "@lead.core";
      const st2 = T.coeffs.stop263.keys[0];
      const r = clamp(st2.r * Sc.hCell(role), 0.8 * enc, 1.4 * enc);
      const k = {u: 0.6, kind: "orbit", center: beamCentre(S, role), r: r3(r), el: 12, az0: st2.az0, az1: r3(st2.az0 - 39.4), fov: 55, beamAngle: st2.beamAngle ?? 58, ease: "smoothstep"};
      k.u = 0.75;
      shot = {...meta, keys: [...keys.filter(x => x.u <= 0.4), k]}; note.push(`chase s_enc ${r3(enc)}, orbit ${role} r ${r3(r)} (c_h x h_cell clamped to [0.8, 1.4] s_enc)`); break; }
    case "orbitStop": case "orbitDrag": {
      const name = st === "orbitStop" ? "stop263" : "drag263";
      const role = b.cell || "@S5", h = Sc.hCell(role);
      const {meta, keys} = fromCoef(T, name, S, h, {center: beamCentre(S, role)});
      shot = {...meta, keys}; note.push(`orbit ${role} r = ${r3(T.coeffs[name].keys[0].r)} x h_cell(${r3(h)})`); break; }
    case "thread": {
      // the hero's B9: chase, then a side view of the same-speed pair, back to the chase
      const {meta, keys} = fromCoef(T, "thread", S, 1);
      // the side view only when the pair is where the reader is: its midpoint within the beat window ± Δl/2 (the hero's pair,
      // cells at −18 and +66 kpc, sits half behind its B9 window 30..81); otherwise a plain chase
      let pr = ctx.pair;
      if (pr && !(pr.lc >= lo - pr.dl / 2 && pr.lc <= hi + pr.dl / 2)) { note.push(`pair at l ${r3(pr.lc)} outside the window ${r3(lo)}..${r3(hi)}`); pr = null; }
      if (!pr) { const g2 = fromCoef(T, "cloudD", S, enc); shot = {...g2.meta, keys: g2.keys}; note.push("no pair in view: chase"); break; }
      const G = T.generated.pair, d = Math.max(G.min_d, Math.abs(G.side_dl) * pr.dl);
      const tp = tableauPose(Sc, pr.lc, d * Math.tan(24 * DEG) / 1.15, {fov: 50, fit: 1.15, axis: [G.up_dl, G.side_dl]});
      keys.forEach(k => { if (k.kind === "pose") { k.at = {l: r3(pr.lc), back: 0, up: r3(tp.up), side: r3(tp.side)}; k.look = {l: r3(pr.lc)}; } });
      shot = {...meta, keys}; note.push(`pair Δl ${r3(pr.dl)} at l ${r3(pr.lc)}, d ${r3(tp.d)}`); break; }
    case "pairTableau": {
      // B7p: both clouds in one frame; centre between them, side −3.31 Δl, up 0.47 Δl (the hero's thread), clamped so both
      // shells fit (fit-to-bounds on Δl/2 + r90)
      const pr = ctx.pair; if (!pr) throw new Error(`${b.id}: pairTableau needs a pair`);
      const G = T.generated.pair;
      const rB = pr.dl / 2 + pr.r90;
      const dFit = rB / Math.tan(24 * DEG) * 1.15, d = Math.max(G.min_d, Math.abs(G.side_dl) * pr.dl, dFit) * (v.scale ?? 1);
      const tp = tableauPose(Sc, pr.lc, d * Math.tan(24 * DEG) / 1.15, {fov: 48, axis: [G.up_dl, G.side_dl], rot: vv.rot || 0, flip: vv.flip});
      const k0 = {u: 0, kind: "pose", at: {l: r3(pr.lc), up: r3(tp.up), side: r3(tp.side)}, look: {l: r3(pr.lc)}, fov: 48, beamAngle: 50, beamSign: "desc"};
      const k1 = {...k0, u: 1, at: {l: r3(pr.lc + 0.05 * pr.dl), up: r3(tp.up * 0.97), side: r3(tp.side * 0.97)}, look: {l: r3(pr.lc + 0.05 * pr.dl)}, ease: "linear"};
      shot = {blendIn: 0.45, keys: [k0, k1]}; note.push(`pair ${pr.ids.join("+")} Δl ${r3(pr.dl)} centre l ${r3(pr.lc)} d ${r3(tp.d)} disk view ${tp.ang == null ? "?" : r3(tp.ang)}°`);
      return finish(shot, b, st, note, {skipVariant: true}, v);
    }
    case "pullout": {
      // fix2 (review2 R2-B8): the wide pose holds the whole beam (both ends) and so the galaxy centre beside it at l = 0
      const G = T.generated.pullout, l0 = Math.min(-H, ctx.window ? ctx.window[0] : lo), l1 = Math.max(H, ctx.window ? ctx.window[1] : hi);
      const t = tableauShot(Sc, l0, l1, {fov: G.fov, fit: G.fit, rMin: 60, pad: 40, rot: vv.rot, flip: vv.flip, scale: v.scale}, T);
      // one continuous dolly along the final view direction: from 6 kpc off the probe to the wide framing, the beam's screen
      // slope held fixed the whole way (so the projected beam never sweeps through the text column)
      const w = t.keys[0], dd = Math.hypot(w.at.up, w.at.side), k0 = 6 / dd;
      const near = {u: 0, kind: "pose", at: {l: "probe", up: r3(w.at.up * k0), side: r3(w.at.side * k0)}, look: "probe", fov: 55, beamAngle: w.beamAngle, beamSign: w.beamSign};
      // fix1 round 2 (review beauty F6): short blend from B10's close pose, the wide framing reached by mid-beat (where the
      // text and G11/G14 look), then the slow drift; a blend variant may not hold the close-up longer than 0.3 of the beat
      shot = {blendIn: 0.25, keys: [near, {...w, u: 0.5, ease: "smoothstep"}, {...t.keys[1], u: 1}]};
      note.push(`wide pull-out over ${r3(l0)}..${r3(l1)}: dolly 6 -> ${t.info.d} kpc by u 0.5, disk view ${t.info.diskViewDeg}°`);
      const out = finish(shot, b, st, note, {skipVariant: true}, v);
      if (out.blendIn != null && out.blendIn > 0.3) out.blendIn = 0.3;
      return out;
    }
    case "tableau": {
      const l0 = ctx.window ? ctx.window[0] : (b.kind === "flight" ? lo : -H), l1 = ctx.window ? ctx.window[1] : (b.kind === "flight" ? hi : H);
      const t = tableauShot(Sc, l0, l1, {rot: vv.rot, flip: vv.flip, scale: v.scale, dir: 1, rMin: ctx.rMin ?? 75}, T);
      shot = {blendIn: 0.5, keys: t.keys}; note.push(`side tableau over ${r3(l0)}..${r3(l1)}: d ${t.info.d}, disk view ${t.info.diskViewDeg}°${t.info.diskFail ? " (no rotation meets 60°)" : ""}`);
      return finish(shot, b, st, note, {skipVariant: true}, v);
    }
    default: throw new Error(`unknown style ${st}`);
  }
  shot.keys = shot.keys.map(k => applyVariantKey(k, vv));
  return finish(shot, b, st, note, {}, v);
}
function finish(shot, b, style, note, o = {}, v = null) {
  if (v && v.beamSign) shot.keys = shot.keys.map(k => ({...k, beamAngle: v.beamAngle ?? k.beamAngle ?? 45, beamSign: v.beamSign}));
  // the hero's blendIn 0 shots start where their hand-made predecessor ends; a generated predecessor differs, so every
  // generated shot blends in (≥ 0.25 of its beat) unless it is a declared cut
  if (v && v.cut) { shot.cut = true; delete shot.blendIn; }
  if (!shot.cut) shot.blendIn = Math.max(shot.blendIn ?? 0.3, 0.25);
  if (v && v.blend != null && !shot.cut) shot.blendIn = v.blend;
  const out = {textSide: shot.textSide || "left"};
  if (shot.cut) out.cut = true;
  if (shot.blendIn != null) out.blendIn = shot.blendIn;
  out.style = style;
  if (note.length) out.note = note.join("; ");
  out.keys = shot.keys;
  return out;
}

/* orbit centre for a role: the beam point at the role cell's l ({l}), not the cell centre, which sits up to h off the beam.
   rollForBeam is exact only when the beam passes through the look target; at an orbit radius of a few kpc a 2-3 kpc offset
   would tilt the projected beam by tens of degrees (into the text or equation band). The cell's ring stays in frame through
   seek's keep-in points. Falls back to the cell when the role has no l. */
export function beamCentre(S, role) {
  const name = String(role).replace(/^@/, ""), r = S.data.roles[name];
  const c = r && r.cell != null ? S.data.roles.cells[String(r.cell)] : null;
  const l = c && Number.isFinite(c.l) ? c.l : (r && Number.isFinite(r.l) ? r.l : null);
  return l != null ? {l: r3(l)} : {cell: role};
}

/* the multiphase pair of B7p: the two lettered encounters the sequence pinned (cool and O VI-led) */
export function pairOf(S, seqItem) {
  if (!seqItem || !seqItem.pair) return null;
  const [A, B] = seqItem.pair, enc = S.data.plan.encounters || [];
  const ea = enc.find(e => e.id === A.enc), eb = enc.find(e => e.id === B.enc);
  const la = ea ? ea.lc : (A.l0 + A.l1) / 2, lb = eb ? eb.lc : (B.l0 + B.l1) / 2;
  return {lc: (la + lb) / 2, dl: Math.abs(lb - la), r90: Math.max(ea ? ea.r90 : 10, eb ? eb.r90 : 10), ids: [A.key, B.key]};
}
/* the B9 same-speed pair (roles.pair cells) */
export function b9Pair(S) {
  const r = S.data.roles && S.data.roles.pair; if (!r || !Array.isArray(r.cells) || r.cells.length < 2) return null;
  const c = r.cells.map(id => S.data.roles.cells[String(id)]).filter(Boolean); if (c.length < 2) return null;
  return {lc: (c[0].l + c[1].l) / 2, dl: Math.abs(c[1].l - c[0].l), r90: 10, ids: r.cells.map(String)};
}
