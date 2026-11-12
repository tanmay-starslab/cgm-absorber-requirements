// S1 "Light from behind" (chapter light; PLAN_final §3 S1, unit U3). Step 1: the stellar still of the galaxy, then a
// pull-back to the whole halo while its gas fades in, faint, out to R200c. Step 2: a quasar far behind lights one beam
// through the halo toward us, and the thin spectrum strip at the bottom of the stage appears, flat at 100 % ("all the
// light gets through"); later scenes add the dips it earns.
//
// Galaxy-agnostic: the stills are img/posters/<g>_<ray>/ (scripts/story_posters.mjs, any galaxy with a 3D pack); the
// beam is placed from the sightline geometry alone (impact b, path ends, camera tilt/roll), so with no stills the
// scene draws a procedural halo and galaxy glow at the same places. Pure renderer: state, t, data and the prepared
// stills only; no clock, no randomness, no DOM.
//
// Also the shared helpers of the space scenes (pencil.js, cells.js, ions.js import them from here).
import * as K from "../plot.js";

const STEPS = ["light-1", "light-2"];
const POSTER_BASE = new URL("../../img/posters/", import.meta.url);
/* the cameras of scripts/story_posters.camera.json, used when a galaxy has no stills (same geometry) */
export const CAMS = {light: {tilt: 35, roll: -14}, pencil: {tilt: 90, roll: 0}};
export const CORE_KPC = g => K.clamp(Math.max(40, 0.16 * (g.R200c || 246)), 28, 70);
export const WIDE = 1.25;                       // half-size of the wide stills in R200c (camera JSON)
export const VIEW = 1.08;                       // half-size of the wide view in R200c (the stills fade out beyond)

/* ---------------- stills (frame-independent cache) ---------------- */
const POSTERS = new Map();
const gid = g => String(g ?? "").replace(/^tng50-1-99-/i, "");
/* posters.json + decoded images of (galaxy, ray), or null (node, no fetch, no stills for this galaxy) */
export function loadPosters(galaxy, ray) {
  const key = gid(galaxy) + "_" + (ray || "");
  if (POSTERS.has(key)) return POSTERS.get(key);
  const p = (async () => {
    if (typeof fetch !== "function" || typeof createImageBitmap !== "function" || !gid(galaxy) || !ray) return null;
    try {
      const dir = new URL(key + "/", POSTER_BASE), r = await fetch(new URL("posters.json", dir));
      if (!r.ok) return null;
      const rec = await r.json(), img = {};
      await Promise.all(Object.entries(rec.shots || {}).flatMap(([name, s]) => Object.entries(s.files || {}).map(async ([layer, f]) => {
        const b = await fetch(new URL(f.file, dir)); if (!b.ok) throw new Error(f.file);
        img[name + "_" + layer] = await createImageBitmap(await b.blob());
      })));
      return {rec, img};
    } catch { return null; }
  })();
  POSTERS.set(key, p);
  return p;
}

/* sightline geometry in kpc: b (impact), s0/s1 (path ends from the closest point; s1 = quasar end), R200c */
export function geom(data, cache) {
  const P = K.prep(data), m = P.meta, B = cache && cache.rec && cache.rec.beam;
  const R200c = Number.isFinite(m.R200c) ? m.R200c : (cache && cache.rec ? cache.rec.R200c_kpc : 246);
  const half = Number.isFinite(m.half) ? m.half : R200c;
  return {b: B ? B.b_kpc : (Number.isFinite(m.impact) ? m.impact : 0.25 * R200c), s0: B ? B.s0_kpc : -half, s1: B ? B.s1_kpc : half, R200c};
}
/* image position (kpc, x right, y up) of beam point s, camera {tilt, roll}: as scripts/story_posters.mjs beamXY */
export function beamXY(b, s, cam) {
  const t = cam.tilt * Math.PI / 180, r = cam.roll * Math.PI / 180, x = s * Math.sin(t), y = b;
  return [x * Math.cos(r) + y * Math.sin(r), -x * Math.sin(r) + y * Math.cos(r)];
}
/* free stage area: the step card sits over the left of the stage in Step and Explore on wide screens */
export function stageBox(Fr, state) {
  const card = !Fr.port && state.mode !== "watch" && state.mode !== "render" && Fr.W >= 900 ? Math.min(0.36 * Fr.W, 500) : 0;
  return {x: card, y: 0, w: Fr.W - card, h: Fr.H, card};
}
/* view of a field of half-size hw kpc centred in the box: hw spans FIT of half the box's short side; kpc -> px maps */
const FIT = 0.85;
export function view(box, hw, o = {}) {
  const k = FIT * Math.min(box.w, box.h) / (2 * hw), cx = box.x + box.w / 2 + (o.dx || 0), cy = box.y + box.h * (o.cy ?? 0.5);
  return {k, cx, cy, hw, X: x => cx + x * k, Y: y => cy - y * k};
}
/* draw still `name_layer` (its own half-width hwShot) into view V */
export function plate(ctx, cache, name, layer, V, alpha = 1, blend = "screen") {
  const im = cache && cache.img && cache.img[name + "_" + layer], s = cache && cache.rec && cache.rec.shots[name];
  if (!im || !s || alpha <= 0) return false;
  const w = 2 * s.half_w_kpc * V.k, h = w * s.size[1] / s.size[0];
  ctx.save(); ctx.globalAlpha = K.clamp(alpha); ctx.globalCompositeOperation = blend;
  ctx.imageSmoothingEnabled = true; if ("imageSmoothingQuality" in ctx) ctx.imageSmoothingQuality = "high";
  ctx.drawImage(im, V.cx - w / 2, V.cy - h / 2, w, h); ctx.restore();
  return true;
}
/* procedural stand-ins (no stills): a soft halo out to R200c and a small warm galaxy glow */
export function fakeHalo(ctx, V, R200c, a) {
  if (a <= 0) return;
  const r = R200c * V.k, g = ctx.createRadialGradient(V.cx, V.cy, 0, V.cx, V.cy, r * 1.15);
  g.addColorStop(0, "rgba(189,58,105,0.55)"); g.addColorStop(0.18, "rgba(120,40,120,0.35)"); g.addColorStop(0.6, "rgba(67,31,114,0.18)"); g.addColorStop(1, "rgba(1,4,31,0)");
  ctx.save(); ctx.globalAlpha = a; ctx.globalCompositeOperation = "screen"; ctx.fillStyle = g; ctx.beginPath(); ctx.arc(V.cx, V.cy, r * 1.15, 0, 2 * Math.PI); ctx.fill(); ctx.restore();
}
export function fakeGalaxy(ctx, V, a, rKpc = 14) {
  if (a <= 0) return;
  const r = Math.max(2, rKpc * V.k);
  ctx.save(); ctx.globalAlpha = a; ctx.globalCompositeOperation = "lighter"; ctx.translate(V.cx, V.cy); ctx.rotate(-0.6); ctx.scale(1, 0.38);
  const g = ctx.createRadialGradient(0, 0, 0, 0, 0, r);
  g.addColorStop(0, "rgba(255,236,200,0.95)"); g.addColorStop(0.25, "rgba(255,200,140,0.55)"); g.addColorStop(1, "rgba(120,140,255,0)");
  ctx.fillStyle = g; ctx.beginPath(); ctx.arc(0, 0, r, 0, 2 * Math.PI); ctx.fill(); ctx.restore();
}
/* black feather: a radial fade around the still (its square edges never show) plus a soft stage vignette */
export function feather(ctx, Fr, V) {
  const r = V.hw * V.k, R = Math.hypot(Fr.W, Fr.H);
  ctx.save();
  const g = ctx.createRadialGradient(V.cx, V.cy, r * 0.82, V.cx, V.cy, r * 1.0);
  g.addColorStop(0, "rgba(5,7,13,0)"); g.addColorStop(1, "rgba(5,7,13,1)");
  ctx.fillStyle = g; ctx.beginPath(); ctx.rect(0, 0, Fr.W, Fr.H); ctx.arc(V.cx, V.cy, r * 0.82, 0, 2 * Math.PI, true); ctx.fill();
  const v = ctx.createRadialGradient(Fr.W / 2, Fr.H / 2, R * 0.3, Fr.W / 2, Fr.H / 2, R * 0.6);
  v.addColorStop(0, "rgba(5,7,13,0)"); v.addColorStop(1, "rgba(5,7,13,0.6)");
  ctx.fillStyle = v; ctx.fillRect(0, 0, Fr.W, Fr.H); ctx.restore();
}
/* the quasar: a warm point with a soft glow */
export function quasar(ctx, x, y, r, a) {
  if (a <= 0) return;
  ctx.save(); ctx.globalCompositeOperation = "lighter"; ctx.globalAlpha = K.clamp(a);
  const g = ctx.createRadialGradient(x, y, 0, x, y, r * 6);
  g.addColorStop(0, "rgba(255,250,240,1)"); g.addColorStop(0.12, "rgba(255,240,215,0.9)"); g.addColorStop(0.4, "rgba(255,220,170,0.25)"); g.addColorStop(1, "rgba(255,220,170,0)");
  ctx.fillStyle = g; ctx.beginPath(); ctx.arc(x, y, r * 6, 0, 2 * Math.PI); ctx.fill();
  ctx.strokeStyle = "rgba(255,244,224,0.35)"; ctx.lineWidth = 1;
  ctx.beginPath(); ctx.moveTo(x - r * 9, y); ctx.lineTo(x + r * 9, y); ctx.moveTo(x, y - r * 9); ctx.lineTo(x, y + r * 9); ctx.stroke();
  ctx.restore();
}
/* the beam: warm white line (x0, y0) -> (x1, y1) with a soft glow */
export function beamLine(ctx, x0, y0, x1, y1, a, w = 2) {
  if (a <= 0) return;
  ctx.save(); ctx.lineCap = "round"; ctx.globalCompositeOperation = "lighter";
  for (const [lw, al] of [[w * 7, 0.07], [w * 3, 0.16], [w, 0.95]]) {
    ctx.globalAlpha = K.clamp(a) * al; ctx.strokeStyle = K.COL.beam; ctx.lineWidth = lw;
    ctx.beginPath(); ctx.moveTo(x0, y0); ctx.lineTo(x1, y1); ctx.stroke();
  }
  ctx.restore();
}
/* the thin spectrum strip at the bottom of the stage (as the stub and S5 start): flat at 100 % */
export function strip(Fr, a, box = {x: 0, w: Fr.W}) {
  if (a <= 0) return;
  const ctx = Fr.ctx, x0 = box.x + box.w * 0.08, x1 = box.x + box.w * 0.92, yTop = Fr.H * (Fr.port ? 0.86 : 0.84), yBot = Fr.H * (Fr.port ? 0.95 : 0.94);
  ctx.save(); ctx.globalAlpha = K.clamp(a);
  ctx.strokeStyle = K.COL.grid; ctx.lineWidth = 1; ctx.beginPath(); ctx.moveTo(x0, yBot); ctx.lineTo(x1, yBot); ctx.stroke();
  ctx.strokeStyle = "rgba(255,244,224,0.9)"; ctx.lineWidth = Math.max(1.5, Fr.H / 600);
  ctx.beginPath(); ctx.moveTo(x0, yTop); ctx.lineTo(x1, yTop); ctx.stroke(); ctx.restore();
  K.text(Fr, "100 %", x0 - Fr.fs * 0.4, yTop + Fr.fs * 0.3, {size: 0.62, color: K.COL.muted, mono: true, align: "right", alpha: a});
  K.text(Fr, Fr.physics ? "F = 1 at every wavelength" : "all the light gets through", x1, yTop - Fr.fs * 0.55, {size: 0.72, color: K.COL.muted, align: "right", alpha: a});
}
/* a dashed circle (the halo edge, R200c) with a small label */
export function haloRing(Fr, V, R200c, a, label) {
  if (a <= 0) return;
  const ctx = Fr.ctx, r = R200c * V.k;
  ctx.save(); ctx.globalAlpha = K.clamp(a) * 0.55; ctx.strokeStyle = K.COL.ink; ctx.lineWidth = 1; ctx.setLineDash([3, 6]);
  ctx.beginPath(); ctx.arc(V.cx, V.cy, r, 0, 2 * Math.PI); ctx.stroke(); ctx.restore();
  if (label) K.text(Fr, label, V.cx + r * Math.cos(-0.78), V.cy + r * Math.sin(-0.78) - Fr.fs * 0.4, {size: 0.7, color: K.COL.muted, alpha: a, halo: true});
}

/* ---------------- the scene ---------------- */
async function prepare(data, where = {}) {
  const P = K.prep(data);
  return loadPosters(where.galaxy ?? P.meta.galaxy, where.ray ?? P.meta.ray);
}

function render(ctx, state, t, data, env = {}) {
  const p = K.params(scene, state), k = K.stepIndex(state, STEPS), q = K.clamp(p.p);
  const Fr = K.frame(ctx, state), C = env.cache || null, G = geom(data, C), box = stageBox(Fr, state);
  const halo = p.halo === false ? 0 : p.halo === true || p.halo == null ? 1 : K.clamp(+p.halo || 0);   // Try it: 0 (off) .. 1
  const drift = state.reduced ? 0 : K.clamp(state.u ?? 1);
  // camera: step 1 pulls back from the stellar still to the whole halo; step 2 holds the wide view with a slow push
  const core = (C && C.rec && C.rec.shots.light_core ? C.rec.shots.light_core.half_w_kpc : CORE_KPC(G)) * 0.9, wide = VIEW * G.R200c;
  const pull = k === 0 ? K.seg(q, 0.12, 0.82) : 1;
  const hw = K.logLerp(core, wide, pull) * (k === 1 ? 1 - 0.035 * drift : 1);
  const V = view(box, hw);
  const cam = CAMS.light;
  // stars: the sharp core still crossfades into the wide still as we pull back
  const coreA = 1 - K.seg(Math.log(hw / core), Math.log(1.6), Math.log(4.5));
  const starsIn = k === 0 ? K.seg(q, 0, 0.14) : 1;
  const gasA = halo * (k === 0 ? 0.62 * K.seg(q, 0.45, 0.95) : 0.62);
  const hasWide = plate(ctx, C, "light_wide", "gas", V, gasA);
  if (!hasWide) fakeHalo(ctx, V, G.R200c, gasA);
  const okS = plate(ctx, C, "light_wide", "stars", V, starsIn * (1 - coreA * 0.999), "lighter");
  const okC = plate(ctx, C, "light_core", "stars", V, starsIn * coreA, "lighter");
  if (!okS && !okC) fakeGalaxy(ctx, V, starsIn, 0.05 * G.R200c);
  feather(ctx, Fr, V);
  haloRing(Fr, V, G.R200c, halo * (k === 0 ? K.seg(q, 0.7, 1) : 1) * 0.9, Fr.physics ? `R200c = ${K.fmt(G.R200c, 0)} kpc` : "edge of the halo");
  // the quasar at the far end of the sightline, then its beam toward us (step 2)
  const [qx, qy] = beamXY(G.b, G.s1, cam), [ox, oy] = beamXY(G.b, G.s0 - 2.4 * G.R200c, cam);
  const qA = k === 0 ? K.seg(q, 0.62, 0.92) : 1;
  const X1 = V.X(qx), Y1 = V.Y(qy), X0 = V.X(ox), Y0 = V.Y(oy);
  const front = k === 1 ? K.seg(q, 0.05, 0.75) : 0;
  beamLine(ctx, X1, Y1, K.lerp(X1, X0, front), K.lerp(Y1, Y0, front), front > 0 ? 1 : 0, Math.max(1.5, Fr.fs / 9));
  quasar(ctx, X1, Y1, Math.max(2, Fr.fs / 7), qA * (0.75 + 0.25 * (k === 1 ? 1 : K.seg(q, 0.8, 1))));
  K.text(Fr, "quasar, far behind", X1 + Fr.fs * 0.9, Y1 - Fr.fs * 0.8, {size: 0.74, color: K.COL.muted, alpha: qA, halo: true});
  if (k === 1) K.text(Fr, "toward us", K.lerp(X1, X0, 0.55), K.lerp(Y1, Y0, 0.55) + Fr.fs * 1.4, {size: 0.72, color: K.COL.muted, alpha: K.seg(q, 0.6, 0.85), halo: true, align: "center"});
  strip(Fr, k === 1 ? K.seg(q, 0.55, 0.95) : 0, box);
}

function hit() { return null; }
function ready(data) { K.prep(data); }
const controls = {halo: {label: "halo gas", kind: "range"}};
const scene = {id: "light", chapter: "light", steps: STEPS, defaults: {}, controls, hit, ready, prepare, render,
  handoff: {ions: ["HI", "OVI"], layout: "1", R: [30000, 30000], sn: [10, 10]}};
export default scene;
export {render, prepare, ready, hit, controls};
export const id = scene.id, defaults = scene.defaults;
