// S2 "One beam through the halo" (chapter pencil; PLAN_final §3 S2, unit U3). A side view of the halo: the beam passes
// at its impact distance b from the centre, from the quasar (right) toward us (left); a dashed marker shows b in light
// years. Step 2: the other catalogued sightlines of this galaxy flash faintly, each one crossing different gas.
//
// Galaxy-agnostic: geometry from the story data (b, path ends, R200c) or the stills' posters.json, which also carries
// the other sightlines projected into this view (scripts/story_posters.mjs). Pure renderer.
import * as K from "../plot.js";
import {loadPosters, geom, beamXY, stageBox, view, plate, fakeHalo, fakeGalaxy, feather, quasar, beamLine, haloRing, CAMS, VIEW} from "./light.js";

const STEPS = ["pencil-1", "pencil-2"];

async function prepare(data, where = {}) {
  const P = K.prep(data);
  return loadPosters(where.galaxy ?? P.meta.galaxy, where.ray ?? P.meta.ray);
}

/* an arrowhead at (x, y) pointing along angle a */
function arrow(ctx, x, y, a, s, color, alpha) {
  ctx.save(); ctx.globalAlpha = K.clamp(alpha); ctx.fillStyle = color; ctx.translate(x, y); ctx.rotate(a);
  ctx.beginPath(); ctx.moveTo(0, 0); ctx.lineTo(-s, -s * 0.55); ctx.lineTo(-s, s * 0.55); ctx.closePath(); ctx.fill(); ctx.restore();
}

function render(ctx, state, t, data, env = {}) {
  const p = K.params(scene, state), k = K.stepIndex(state, STEPS), q = K.clamp(p.p);
  const Fr = K.frame(ctx, state), C = env.cache || null, G = geom(data, C), box = stageBox(Fr, state), cam = CAMS.pencil;
  const drift = state.reduced ? 0 : K.clamp(state.u ?? 1);
  const hw = VIEW * G.R200c * (1 - 0.03 * drift * (k === 1 ? 1 : 0.5)), V = view(box, hw);
  const sh = C && C.rec && C.rec.shots && C.rec.shots.pencil;
  const appear = k === 0 ? K.seg(q, 0, 0.25) : 1;
  // the halo from the side
  if (!plate(ctx, C, "pencil", "gas", V, 0.62 * appear)) fakeHalo(ctx, V, G.R200c, 0.62 * appear);
  if (!plate(ctx, C, "pencil", "stars", V, appear, "lighter")) fakeGalaxy(ctx, V, appear, 0.05 * G.R200c);
  feather(ctx, Fr, V);
  haloRing(Fr, V, G.R200c, appear * 0.8, "");
  // other sightlines (step 2): faint flashes, staggered by catalogue order (deterministic in q)
  if (k === 1 && sh && Array.isArray(sh.others) && sh.others.length) {
    const kpx = sh.kpc_per_px, W0 = sh.size[0], H0 = sh.size[1], N = sh.others.length;
    ctx.save(); ctx.globalCompositeOperation = "lighter"; ctx.strokeStyle = K.COL.beam; ctx.lineWidth = 1;
    sh.others.forEach((s, i) => {
      const ph = K.clamp(q * 1.25 - 0.85 * i / N), a = Math.sin(Math.PI * K.clamp(ph / 0.35)) * 0.22 + (ph >= 0.35 ? 0.05 : 0);
      if (a <= 0.005) return;
      const x0 = V.X((s[0] - W0 / 2) * kpx), y0 = V.Y(-(s[1] - H0 / 2) * kpx), x1 = V.X((s[2] - W0 / 2) * kpx), y1 = V.Y(-(s[3] - H0 / 2) * kpx);
      ctx.globalAlpha = a; ctx.beginPath(); ctx.moveTo(x0, y0); ctx.lineTo(x1, y1); ctx.stroke();
    });
    ctx.restore();
  }
  // our beam: quasar end (right) to the observer end (left), extended toward us past the halo
  const [qx, qy] = beamXY(G.b, G.s1, cam), [ox, oy] = beamXY(G.b, G.s0, cam);
  const X1 = V.X(qx), Y1 = V.Y(qy), X0 = V.X(ox), Y0 = V.Y(oy), XL = box.x + Fr.fs * 1.5;
  const front = k === 0 ? K.seg(q, 0.15, 0.6) : 1, dim = k === 1 ? 1 - 0.35 * K.seg(q, 0, 0.3) * (1 - K.seg(q, 0.8, 1)) : 1;
  const xf = K.lerp(X1, XL, front);
  beamLine(ctx, X1, Y1, xf, K.lerp(Y1, Y0, front), dim, Math.max(1.5, Fr.fs / 9));
  quasar(ctx, X1, Y1, Math.max(2, Fr.fs / 8), appear);
  if (front > 0.98) arrow(ctx, XL, Y0, Math.PI, Fr.fs * 0.55, K.COL.beam, dim);
  K.text(Fr, "quasar", X1 - Fr.fs * 0.6, Y1 - Fr.fs * 1.1, {size: 0.72, color: K.COL.muted, align: "right", alpha: appear, halo: true});
  K.text(Fr, "to our telescope", XL, Y0 - Fr.fs * 0.9, {size: 0.72, color: K.COL.muted, alpha: K.seg(front, 0.85, 1), halo: true});
  // impact distance: dashed marker from the centre to the beam, labelled in light years (Physics: b in kpc)
  const mk = k === 0 ? K.seg(q, 0.55, 0.9) : 1 - 0.6 * K.seg(q, 0, 0.3);
  if (mk > 0) {
    const [ix, iy] = beamXY(G.b, 0, cam), xa = V.X(0), ya = V.Y(0), xb = V.X(ix), yb = K.lerp(ya, V.Y(iy), mk);
    ctx.save(); ctx.globalAlpha = mk; ctx.strokeStyle = K.COL.accent; ctx.lineWidth = 1.5; ctx.setLineDash([4, 5]);
    ctx.beginPath(); ctx.moveTo(xa, ya); ctx.lineTo(xb, yb); ctx.stroke(); ctx.setLineDash([]);
    ctx.fillStyle = K.COL.accent; ctx.beginPath(); ctx.arc(xa, ya, 2.5, 0, 2 * Math.PI); ctx.fill(); ctx.restore();
    const lab = Fr.physics ? `b = ${K.fmt(G.b, 1)} kpc` : env.text ? env.text("{{b_ly}} light-years") : `${K.fmtInt(G.b * 3261.56)} light-years`;
    K.text(Fr, lab, xa + Fr.fs * 0.6, (ya + V.Y(iy)) / 2 + Fr.fs * 0.3, {size: 0.82, color: K.COL.accent, alpha: mk, halo: true});
  }
  if (Fr.physics) K.text(Fr, `path −R200c to +R200c = ${K.fmt(G.s1 - G.s0, 0)} kpc`, box.x + box.w - Fr.fs, Fr.H - Fr.fs * 1.2, {size: 0.7, color: K.COL.muted, mono: true, align: "right", alpha: appear});
}

function hit() { return null; }
function ready(data) { K.prep(data); }
const controls = {};
const scene = {id: "pencil", chapter: "pencil", steps: STEPS, defaults: {}, controls, hit, ready, prepare, render,
  handoff: {ions: ["HI", "OVI"], layout: "1", R: [30000, 30000], sn: [10, 10]}};
export default scene;
export {render, prepare, ready, hit, controls};
export const id = scene.id, defaults = scene.defaults;
