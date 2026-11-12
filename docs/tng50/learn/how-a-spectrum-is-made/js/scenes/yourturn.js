// S12 "Now it is yours" (chapter yourturn; PLAN_final §3 S12): end card. The real spectrum of this beam in the
// explorer's look (glass panel, R 30 000, S/N 10, the explorer's case-0 noise draw, stored fit), and a recap rail that
// maps the story's scenes to the explorer's controls. Buttons ("Open in Spectra", "See it in 3D", "Replay") are DOM
// (U4); the hand-off hash is explorerHash(data, scene.handoff). In the video (state.video) the URL is drawn instead.
import * as K from "../plot.js";

const STEPS = ["yourturn-1"];
const VW = 300;
const RECAP = [["R", "sharpness R: the telescope's blur"], ["S/N", "S/N: the noise"], ["Fit", "fit: clouds read back"], ["Ions", "ions: which atoms take light"]];

function render(ctx, state, t, data) {
  const p = K.params(scene, state), q = p.p, Fr = K.frame(ctx, state), I = K.ion(data, K.LEAD), pk = K.picks(data), P = K.prep(data);
  const a = K.seg(q, 0, 0.35), b = Fr.box;
  const pw = Fr.port ? b.w : b.w * 0.66, ph = Fr.port ? b.h * 0.56 : b.h, px = b.x, py = b.y;
  K.glass(Fr, px, py, pw, ph, {alpha: a});
  const inner = {...Fr, box: {x: px + Fr.fs * 3.6, y: py + Fr.fs * 2.6, w: pw - Fr.fs * 4.6, h: ph - Fr.fs * 6.2}};
  const A = K.axesMap(inner, -VW, VW, -0.1, 1.25);
  ctx.save(); ctx.globalAlpha = a;
  K.axes(A, {yTicks: [0, 0.5, 1]});
  const fit = pk.seeds[0] || {R: 30000, snr: 10, noiseSeed: K.caseSeed(0, K.LEAD, 0), comps: []}, o = K.observed(data, K.LEAD, fit.R, fit.snr, fit.noiseSeed);
  K.stairs(A, o.v, o.flux, {color: K.rgba(I.color, 0.9), width: 1.2});
  if (fit.comps.length) { const m = K.cloudModel(data, K.LEAD, fit.comps, fit.R, VW); K.curve(A, m.v, m.model, {color: K.COL.ink, width: 2});
    fit.comps.forEach(c => K.tick(A, c.v, {color: K.COL.ink, y: A.Y(1.18), len: Fr.fs * 0.8})); }
  K.text(Fr, `${I.name} ${Math.round(I.atom.lam0_A)}`, px + Fr.fs, py + Fr.fs * 1.5, {size: 0.86, color: I.color, weight: 500});
  K.text(Fr, `R ${K.fmtInt(fit.R)}   S/N ${fit.snr}`, px + pw - Fr.fs, py + Fr.fs * 1.5, {size: 0.8, align: "right", mono: true, color: K.COL.muted});
  ctx.restore();
  // recap rail
  const rx = Fr.port ? b.x : px + pw + Fr.fs * 2, ry0 = Fr.port ? py + ph + Fr.fs * 2.4 : py + Fr.fs * 2, gap = Fr.fs * (Fr.port ? 1.9 : 2.6);
  RECAP.forEach(([tag, s], i) => {
    const ai = K.seg(q, 0.3 + i * 0.12, 0.42 + i * 0.12), y = ry0 + i * gap;
    ctx.save(); ctx.globalAlpha = ai; ctx.fillStyle = K.COL.accent; ctx.beginPath(); ctx.arc(rx + 4, y - Fr.fs * 0.32, 3, 0, 2 * Math.PI); ctx.fill(); ctx.restore();
    K.text(Fr, s, rx + Fr.fs, y, {size: 0.84, color: K.COL.ink, alpha: ai});
  });
  if (state.video || state.mode === "render") {   // the film's end card: where to go next (no buttons in a video)
    const url = `tanmay-starslab.github.io/cgm-absorber-requirements/tng50/${String(P.meta.galaxy) !== String(K.DEFAULT_GALAXY) ? `#g=${P.meta.galaxy}` : ""}`;
    const ua = K.seg(q, 0.45, 0.75);
    const y0 = b.y + b.h + Fr.fs * 1.7;
    K.text(Fr, "Explore this beam, and all the galaxies:", Fr.W / 2, y0, {align: "center", size: 0.95, color: K.COL.muted, alpha: ua});
    K.text(Fr, url, Fr.W / 2, y0 + Fr.fs * 1.5, {align: "center", size: 1.15, mono: true, color: K.COL.ink, alpha: ua});
  }
}
function ready(data) { K.picks(data); }
const scene = {id: "yourturn", chapter: "yourturn", steps: STEPS, defaults: {}, controls: {}, ready, render,
  handoff: {ions: ["OVI", "HI"], layout: "1", R: [30000, 30000], sn: [10, 10], fit: true}};
export default scene;
export {render, ready};
