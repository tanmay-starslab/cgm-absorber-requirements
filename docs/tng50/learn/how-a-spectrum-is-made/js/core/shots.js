// Camera shots along the beam (DESIGN §4, DESIGN_final §3.5). Pure functions of (probe position, beat fraction, data):
// no DOM, no time, no random.
//
// Ray frame: n̂ = beam direction (quasar → telescope), ê₁ = n̂ × ẑ_disk (normalised), ê₂ = ê₁ × n̂. Up is ê₂ (the disk
// normal projected off the beam), with a fallback to the box ẑ, then x̂, when |n̂*ẑ_disk| > 0.95, so the view never rolls
// over. World units are physical kpc, origin = galaxy centre, box axes (the explorer's scene frame); P(ℓ) = mid + ℓ n̂.
//
// A shot (shots.json) is a list of keys over the beat fraction u. Each key is evaluated at the CURRENT probe ℓ, so a
// chase key follows the probe; consecutive keys blend with smootherstep: the camera offset from the probe in log radius +
// slerped direction (a cinematic dolly, so pull-outs of hundreds of kpc stay smooth), the look target linearly, up by
// slerp, roll and fov linearly. A beat blends in from the previous beat's end pose over `blendIn` of its u (default
// 0.3), unless the shot declares `cut: true`.
//
// Key kinds (offsets in the ray frame, kpc: back along −n̂, up along ê₂, side along ê₁; `u` is always the key's beat
// fraction, never an offset):
//   chase  {back, up, side, lookAhead, fov, roll} pos = P(ℓ) − back n̂ + up ê₂ + side ê₁, target = P(ℓ + lookAhead)
//   orbit  {center, r, el, az0, az1, fov, roll}   about a centre (see below), az driven by the key-local u
//                                                  pos = c + r (cos el cos az (−n̂) + cos el sin az ê₁ + sin el ê₂)
//   pose   {at, look, fov, roll}                  at/look are points (see below)
// Points: "origin" (galaxy centre) | "probe" | {l, back?, up?, side?} on the ray (+ offsets; l may be "probe+30") |
//         {cell: idx, back?, up?, side?} (a ray cell's 3D centre) | {mix: [pointA, pointB, w]}.
// Any key may carry beamAngle (deg): the roll is then solved so the projected beam descends toward the screen's right
// at that angle (rollForBeam), which keeps the beam out of a left text column whatever the camera does.
//
// Screen composition: viewFor(cam, w, h, bands) returns the vertical fov (portrait rule of DESIGN §4) and a lens shift
// that puts the look target at the centre of the layout's world band (js/ui/layoutclass.js computeBands). The stage
// applies the shift as an off-axis projection (three: camera.setViewOffset); project() uses the same maths, so the
// collision solver and the G3 test see exactly what the stage draws.

export const DEG = Math.PI / 180;
export const v3 = {
  add: (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]],
  sub: (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]],
  mul: (a, s) => [a[0] * s, a[1] * s, a[2] * s],
  dot: (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2],
  cross: (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]],
  len: a => Math.hypot(a[0], a[1], a[2]),
  norm: a => { const l = Math.hypot(a[0], a[1], a[2]) || 1; return [a[0] / l, a[1] / l, a[2] / l]; },
  lerp: (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t],
};
const {add, sub, mul, dot, cross, len, norm, lerp} = v3;

export const smoothstep = x => { const t = x < 0 ? 0 : x > 1 ? 1 : x; return t * t * (3 - 2 * t); };
export const smootherstep = x => { const t = x < 0 ? 0 : x > 1 ? 1 : x; return t * t * t * (t * (6 * t - 15) + 10); };

/* unit-vector slerp (falls back to nlerp for nearly parallel vectors; picks a stable axis for opposite ones) */
export function slerp(a, b, t, axisHint) {
  const d = Math.max(-1, Math.min(1, dot(a, b)));
  if (d > 0.9995) return norm(lerp(a, b, t));
  if (d < -0.9995) {                                     // opposite: rotate about a perpendicular axis
    let ax = axisHint && Math.abs(dot(axisHint, a)) < 0.9 ? axisHint : (Math.abs(a[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0]);
    ax = norm(cross(a, ax));
    const th = Math.PI * t, c = Math.cos(th), s = Math.sin(th);
    return norm(add(mul(a, c), mul(cross(ax, a), s)));
  }
  const th = Math.acos(d), s = Math.sin(th);
  return norm(add(mul(a, Math.sin((1 - t) * th) / s), mul(b, Math.sin(t * th) / s)));
}

/* ray frame from story-data/2 `ray` {p0, p1, n?, zdisk?} (galaxy-centred kpc) */
export function rayFrame(ray) {
  const p0 = ray.p0, p1 = ray.p1;
  const n = ray.n ? norm(ray.n) : norm(sub(p1, p0));
  const mid = ray.mid || mul(add(p0, p1), 0.5);
  let z = ray.zdisk ? norm(ray.zdisk) : [0, 0, 1];
  if (Math.abs(dot(n, z)) > 0.95) z = Math.abs(n[2]) < 0.95 ? [0, 0, 1] : [1, 0, 0];
  const e1 = norm(cross(n, z)), e2 = cross(e1, n);
  return {n, e1, e2, mid, L: len(sub(p1, p0)), P: l => add(mid, mul(n, l)),
    off: (back, up, side) => add(add(mul(n, -back), mul(e2, up)), mul(e1, side))};
}

/* resolve a point spec (see header) */
export function pointOf(spec, ctx) {
  const F = ctx.frame;
  if (spec == null || spec === "probe") return F.P(ctx.l);
  if (spec === "origin") return [0, 0, 0];
  if (Array.isArray(spec)) return spec.slice(0, 3);
  if (spec.mix) { const [a, b, w] = spec.mix; return lerp(pointOf(a, ctx), pointOf(b, ctx), w * (ctx.mods && ctx.mods.mixScale != null ? ctx.mods.mixScale : 1)); }
  let base;
  if (spec.cell != null) base = ctx.cellPos(spec.cell);
  else if (spec.l != null) base = F.P(lval(spec.l, ctx.l, ctx.lscale));
  else base = F.P(ctx.l);
  return add(base, F.off(spec.back || 0, spec.up || 0, spec.side || 0));
}
/* ℓ values in shots/beats: a number (kpc on the hero ray, scaled by lscale) or "probe±x" */
export function lval(x, lprobe, lscale = 1) {
  if (typeof x === "number") return x * lscale;
  const m = /^probe\s*([+-]\s*[\d.]+)?$/.exec(String(x).trim());
  if (m) return lprobe + (m[1] ? +m[1].replace(/\s+/g, "") : 0);
  return lprobe;
}

/* pose of one key at key-local fraction s (orbit azimuth) */
export function poseOfKey(k, ctx, s = 0) {
  const F = ctx.frame;
  let pos, target;
  if (k.kind === "chase") {
    const P = F.P(ctx.l);
    pos = add(P, F.off(k.back ?? 10, k.up ?? 3, k.side ?? 4));
    target = F.P(ctx.l + (k.lookAhead ?? 60));
  } else if (k.kind === "orbit") {
    const c = pointOf(k.center ?? "origin", ctx);
    const az = ((k.az0 ?? 0) + ((k.az1 ?? k.az0 ?? 0) - (k.az0 ?? 0)) * s) * DEG, el = (k.el ?? 20) * DEG, r = k.r ?? 100;
    const dir = add(add(mul(F.n, -Math.cos(el) * Math.cos(az)), mul(F.e1, Math.cos(el) * Math.sin(az))), mul(F.e2, Math.sin(el)));
    pos = add(c, mul(dir, r));
    target = k.look ? pointOf(k.look, ctx) : c;
  } else {                                                  // pose
    pos = pointOf(k.at, ctx);
    target = pointOf(k.look ?? "probe", ctx);
  }
  return {pos, target, fov: k.fov ?? 50, ba: beamAngleOf(k, ctx, pos, target)};
}

/* Roll model. Every pose carries `ba`, the DIRECTED screen angle (deg, counter-clockwise from screen right, y up) of
   the beam direction n̂, and the roll is r = −ba − a (mod 360°), a = the unrolled camera's angle of n̂. A key with
   beamAngle θ wants the beam line at slope θ (positive = descending toward the right); a line has two directions and
   either sign of θ clears a side text column, so the key takes, among the directed angles {−θ, 180°−θ, θ, θ−180°}, the
   one that needs the least roll at its own pose (beamSign: "asc" | "desc" keeps one pair). classMods.beamAngle
   replaces a key's θ. A key without beamAngle has a fixed roll (default 0), expressed as the directed angle that roll
   gives at the key's own pose, so nothing changes for it outside blends. Blends take the short way on the 360° circle,
   so the roll is continuous wherever the beam's projection is defined (never an upside-down flip). */
export function beamAngleOf(k, ctx, pos, target) {
  const a = natAngle(ctx.frame, pos, target), m = ctx.mods || {};
  if (k.beamAngle == null) return -(k.roll ?? 0) - a;
  const th = m.beamAngle ?? k.beamAngle;
  // ties (a pure side view sees the beam exactly horizontal) go to the ascending pair, which is what chase cameras on
  // the −ê₁ side pick, so a chase → side-pose blend does not sweep the beam through horizontal
  const asc = [th, th - 180], desc = [-th, 180 - th];
  const cands = k.beamSign === "desc" || k.beamSign === "fixed" ? desc : k.beamSign === "asc" ? asc : [...asc, ...desc];
  let best = cands[0], br = Infinity;
  for (const c of cands) { const r = Math.abs(wrap360(-c - a)); if (r < br - 1e-9) { br = r; best = c; } }
  return best;
}
export const wrap360 = d => { while (d > 180) d -= 360; while (d <= -180) d += 360; return d; };
export const fold90 = r => { while (r > 90) r -= 180; while (r <= -90) r += 180; return r; };

/* the beam's screen angle (deg) for an unrolled camera (up = ê₂ orthogonalised against the view) */
export function natAngle(F, pos, target) {
  const f = norm(sub(target, pos));
  let up = F.e2;
  if (Math.abs(dot(f, up)) > 0.98) up = Math.abs(dot(f, F.n)) < 0.98 ? F.n : F.e1;
  const right = norm(cross(f, up)); up = cross(right, f);
  return Math.atan2(dot(F.n, up), dot(F.n, right)) / DEG;
}
/* roll that puts the beam at `angle`, folded into (−90°, 90°]. With up' = up cos r + right sin r a screen direction at
   angle a moves to a + r, so r = −angle − a (mod 180°). Exact when the beam passes through the look target (chase
   targets, cell orbits and side poses all look at a point on the beam). */
export function rollForBeam(F, pos, target, angle) { return fold90(-angle - natAngle(F, pos, target)); }

/* per-layout-class camera modifiers (shots.json classMods[cls]): scales for chase offsets and look-ahead; beamAngle
   replaces each key's own beamAngle (portrait screens need a flatter beam than landscape ones) */
export function modKey(k, mods) {
  if (!mods) return k;
  if (k.kind === "chase") return {...k, back: (k.back ?? 10) * (mods.backScale ?? 1), up: (k.up ?? 3) * (mods.upScale ?? 1),
    side: (k.side ?? 4) * (mods.sideScale ?? 1), lookAhead: (k.lookAhead ?? 60) * (mods.lookAheadScale ?? 1)};
  return k;
}

/* blend two poses about the probe point P: log-radius + slerped direction for the offset, linear target and fov, and
   the directed beam angle the short way on the 360° circle */
export function blendPose(a, b, t, P) {
  if (t <= 0) return a; if (t >= 1) return b;
  const oa = sub(a.pos, P), ob = sub(b.pos, P), ra = len(oa), rb = len(ob);
  let pos;
  if (ra < 1e-6 || rb < 1e-6) pos = lerp(a.pos, b.pos, t);
  else {
    const r = Math.exp(Math.log(ra) + (Math.log(rb) - Math.log(ra)) * t);
    pos = add(P, mul(slerp(mul(oa, 1 / ra), mul(ob, 1 / rb), t), r));
  }
  const ba = a.ba + wrap360(b.ba - a.ba) * t;
  return {pos, target: lerp(a.target, b.target, t), fov: a.fov + (b.fov - a.fov) * t, ba};
}

/* path of one shot at beat fraction u (keys sorted by u; before the first key the first key holds) */
export function shotPath(shot, ctx, u) {
  const keys = shot.keys;
  if (!keys || !keys.length) return null;
  let i = 0;
  while (i < keys.length - 1 && u >= keys[i + 1].u) i++;
  const k0 = keys[i], k1 = keys[i + 1];
  const segS = k1 ? (u - k0.u) / Math.max(1e-9, k1.u - k0.u) : 0;
  // an orbit key sweeps az over its own span (to the next key, or to u = 1 for the last key)
  const spanEnd = k1 ? k1.u : 1;
  const s0 = k0.kind === "orbit" ? Math.min(1, Math.max(0, (u - k0.u) / Math.max(1e-9, spanEnd - k0.u))) : 0;
  const A = poseOfKey(modKey(k0, ctx.mods), ctx, s0);
  if (!k1 || u <= k0.u) return A;
  const B = poseOfKey(modKey(k1, ctx.mods), ctx, 0);
  const ease = k1.ease === "linear" ? segS : k1.ease === "smoothstep" ? smoothstep(segS) : smootherstep(segS);
  return blendPose(A, B, ease, ctx.frame.P(ctx.l));
}

/* up vector for a view direction: ê₂ made orthogonal to the view, then rolled about it */
export function upFor(frame, pos, target, roll) {
  const f = norm(sub(target, pos));
  let up = frame.e2;
  if (Math.abs(dot(f, up)) > 0.98) up = Math.abs(dot(f, frame.n)) < 0.98 ? frame.n : frame.e1;
  const right = norm(cross(f, up));
  up = cross(right, f);
  if (roll) { const c = Math.cos(roll * DEG), s = Math.sin(roll * DEG); up = norm(add(mul(up, c), mul(right, s))); }
  return up;
}

/* camera for a beat at fraction u. ctx: {frame, l, lscale, cellPos, mods}; prev: the previous beat's shot (or null). */
export function evalCamera(shot, prev, u, ctx, prevCtx) {
  let pose = shotPath(shot, ctx, u);
  const bl = shot.cut ? 0 : (shot.blendIn ?? 0.3);
  if (prev && bl > 0 && u < bl) pose = blendPose(shotPath(prev, prevCtx || ctx, 1), pose, smootherstep(u / bl), ctx.frame.P(ctx.l));
  const F = ctx.frame;
  const roll = wrap360(-pose.ba - natAngle(F, pose.pos, pose.target));
  const up = upFor(F, pose.pos, pose.target, roll);
  const dist = len(sub(pose.target, pose.pos));
  return {pos: pose.pos, target: pose.target, up, fov: pose.fov, roll,
    near: Math.max(0.05, Math.min(5, 0.002 * len(sub(pose.pos, F.P(ctx.l))) + 0.05)), dist};
}

/* ---------------- projection (shared by the stage, the solver and the G3 test) ---------------- */

/* portrait fov rule (DESIGN §4): fov' = min(70°, 2 atan(1.25 tan(fov/2) / aspect)) when the aspect is below 1 */
export function fovFor(fov, aspect) {
  if (!(aspect < 1)) return fov;
  return Math.min(70, 2 * Math.atan(1.25 * Math.tan(fov / 2 * DEG) / aspect) / DEG);
}

/* lens shift (NDC units, +x right, +y up) that moves the image centre to the centre of a rect {x, y, w, h} in CSS px */
export function shiftFor(rect, w, h) {
  if (!rect) return [0, 0];
  const cx = (rect.x + rect.w / 2) / w, cy = (rect.y + rect.h / 2) / h;
  return [2 * cx - 1, 1 - 2 * cy];
}

/* view parameters for a camera on a w × h stage. bands: computeBands(...) for the current side/dock (or a function
   (side, dock) -> bands, so the shift can blend across a textSide flip or a dock morph). */
export function viewFor(cam, w, h, bands, mix = {}) {
  const aspect = w / h, fov = fovFor(cam.fov, aspect);
  let shift = [0, 0];
  if (typeof bands === "function") {
    // bilinear over (side, dock): S(side, dock) = centre of that layout's world band
    const sT = cam.textSide || "left", sF = cam.sideFrom || sT, dT = mix.dock || "strip", dF = mix.dockFrom || dT;
    const s = cam.sideMix ?? 1, d = mix.dockMix ?? 1;
    const S = (sd, dk) => shiftFor(bands(sd, dk).world, w, h);
    const a = S(sF, dF), b = S(sT, dF), c = S(sF, dT), e = S(sT, dT);
    const wa = (1 - s) * (1 - d), wb = s * (1 - d), wc = (1 - s) * d, we = s * d;
    shift = [wa * a[0] + wb * b[0] + wc * c[0] + we * e[0], wa * a[1] + wb * b[1] + wc * c[1] + we * e[1]];
  } else if (bands) shift = shiftFor(bands.world, w, h);
  const view = {fov, aspect, shift, w, h};
  // review F3: keep the probe inside the world band. mix.keep = {pt, rect, margin (fraction of the rect), cap (NDC)}: when the
  // point projects outside the inset rect, the lens shift moves just enough to bring it to the edge (capped, continuous in
  // p because clamping is continuous). Pure; the GL camera gets the same shift through threeViewOffset.
  // fix3 R5: K.pts (extra points, e.g. the selected cell whose ring the callouts point at) join the probe: the shift brings
  // the bounding box of all in-front points inside the inset rect (centred when it is wider than the rect). K.marginPx adds
  // a fixed inset in CSS px (the ring's radius) on top of the fractional margin.
  const K = mix.keep;
  if (K && K.pt && K.rect) {
    const r = project(cam, view, K.pt);
    if (r.ok) {
      const m = K.margin ?? 0.1, cap = K.cap ?? 1, R = K.rect, mp = K.marginPx ?? 0;
      const x0 = R.x + m * R.w + mp, x1 = R.x + R.w * (1 - m) - mp, y0 = R.y + m * R.h + mp, y1 = R.y + R.h * (1 - m) - mp;
      const fit = (a, b, lo, hi) => (a < lo ? lo - a : b > hi ? hi - b : 0);
      let dx = fit(r.x, r.x, x0, x1), dy = fit(r.y, r.y, y0, y1);
      // extra points (the selected cell): they need only stay on screen, clear of the frame edge by marginPx and above the
      // world band's bottom (the dock), not inside the world band: the probe keeps the band. The extra move is the least that
      // does this, limited to 6 % of the stage per axis (more pushed the beam into the text and equation bands), and skipped when it cannot be done together with the probe.
      if (K.pts && K.pts.length) {
        const ex0 = mp, ex1 = w - mp, ey0 = mp, ey1 = R.y + R.h - mp;
        let lo = -Infinity, hi = Infinity, loY = -Infinity, hiY = Infinity;   // allowed total shift ranges (px)
        const okR = (v, a, b) => [a - v, b - v];
        [lo, hi] = okR(r.x, x0, x1); [loY, hiY] = okR(r.y, y0, y1);
        if (r.x < x0 || r.x > x1) { lo = hi = dx; } if (r.y < y0 || r.y > y1) { loY = hiY = dy; }
        for (const q of K.pts) { if (!q) continue; const s2 = project(cam, view, q); if (!s2.ok) continue;
          lo = Math.max(lo, ex0 - s2.x); hi = Math.min(hi, ex1 - s2.x); loY = Math.max(loY, ey0 - s2.y); hiY = Math.min(hiY, ey1 - s2.y); }
        const pick = (l, h, d, L) => (l > h ? d : Math.max(d - L, Math.min(d + L, Math.max(l, Math.min(h, d)))));
        dx = pick(lo, hi, dx, 0.06 * w); dy = pick(loY, hiY, dy, 0.06 * h);
      }
      const cl = v => Math.max(-cap, Math.min(cap, v));
      const wt = K.weight ?? 1;
      view.shift = [shift[0] + wt * cl(2 * dx / w), shift[1] + wt * cl(-2 * dy / h)];
    }
  }
  return view;
}

/* fix3 R5: the extra keep-in points for a frame: the selected cell's centre (its ring) while it is selected (stop beats, or
   a flight with the probe inside the cell). cellPos = seek.prepare(...).cellPos. Shared by main.js, hud.itemsFor, story_core. */
export const KEEP_MARGIN_PX = 24;
export function keepPts(fs, cellPos) {
  if (!fs || !fs.cell || typeof cellPos !== "function" || !fs.beat) return [];
  if (!(fs.beat.kind === "stop" || (fs.beat.kind === "flight" && fs.cell.w > 0.02 && fs.cell.w < 0.98))) return [];
  const c = cellPos(fs.cell.idx); return c ? [c] : [];
}

/* weight of the probe keep-in (review F3), continuous in p: 1 inside flight/stop beats, ramped over `ramp` p at a boundary
   with any other beat kind, and faded to 0 within `park` kpc of either end of the ray (the probe parked at the start or end:
   the B3 entry, the B11 pull-out), so composed overviews are never shifted and no frame jumps. */
export function keepWeight(beats, p, l, half, ramp = 0.01, park = 1.5) {
  const live = b => b && (b.kind === "flight" || b.kind === "stop");
  let wb = 0;
  for (let i = 0; i < beats.length; i++) { const b = beats[i]; if (!live(b)) continue;
    const inL = live(beats[i - 1]) ? 1 : smoothstep((p - b.p0) / ramp), inR = live(beats[i + 1]) ? 1 : smoothstep((b.p1 - p) / ramp);
    if (p >= b.p0 - 1e-9 && p <= b.p1 + 1e-9) wb = Math.max(wb, Math.min(inL, inR)); }
  return wb * smoothstep((half - Math.abs(l)) / park);
}

/* project a world point: -> {x, y (CSS px), z (view depth, > 0 in front), ok (in front of the near plane)} */
export function project(cam, view, pt) {
  const f = norm(sub(cam.target, cam.pos)), r = norm(cross(f, cam.up)), u = cross(r, f);
  const d = sub(pt, cam.pos), z = dot(d, f);
  const t = Math.tan(view.fov / 2 * DEG);
  const nx = dot(d, r) / (z * t * view.aspect) + view.shift[0], ny = dot(d, u) / (z * t) + view.shift[1];
  return {x: (nx + 1) / 2 * view.w, y: (1 - ny) / 2 * view.h, z, ok: z > (cam.near || 0.05)};
}

/* a world segment clipped to the near plane and projected: [[x, y], ...] polyline with n samples (null if behind) */
export function projectSegment(cam, view, a, b, n = 64) {
  const f = norm(sub(cam.target, cam.pos)), near = cam.near || 0.05;
  let za = dot(sub(a, cam.pos), f), zb = dot(sub(b, cam.pos), f);
  if (za <= near && zb <= near) return null;
  if (za <= near) { a = lerp(a, b, (near - za) / (zb - za) + 1e-6); za = near; }
  if (zb <= near) { b = lerp(b, a, (near - zb) / (za - zb) + 1e-6); }
  const out = [];
  for (let i = 0; i <= n; i++) { const p = project(cam, view, lerp(a, b, i / n)); out.push([p.x, p.y]); }
  return out;
}

/* three.js arguments for camera.setViewOffset(fullW, fullH, x, y, w, h) that reproduce viewFor's lens shift: the look
   target, at the image centre of the unshifted camera, lands at NDC (shift[0], shift[1]). Verified against three 0.169
   (PerspectiveCamera with fov = view.fov, aspect = view.aspect) to 1e-9 px; see notes/story2/U_motion.md. */
export function threeViewOffset(view) {
  const {w, h, shift} = view;
  return [w, h, -shift[0] * w / 2, shift[1] * h / 2, w, h];
}
