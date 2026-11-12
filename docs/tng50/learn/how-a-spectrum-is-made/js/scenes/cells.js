// S3 "The simulation is made of cells" (chapter cells; PLAN_final §3 S3, unit U3). Canvas 2D, no WebGL. The beam
// threads every gas cell it crosses, drawn as soft beads along a ruler of the path (bead size: path inside the cell,
// colour: heat on a perceptual map). Step 1: the beads appear as the quasar's light crosses them (right to left, as in
// S2). Step 2 (scrub): a probe glides along the beam and reads one cell (density, heat, metals, speed). Step 3: the
// few cells that hold half of the O VI and half of the neutral hydrogen light up; the rest dim.
//
// Galaxy-agnostic: every cell, count and number comes from the story data; the highlighted cells follow one rule
// (largest N first until half the ion's total). Pure renderer; the per-ion rankings are a frame-independent memo.
import * as K from "../plot.js";
import {lut} from "../../../../js/colormaps.js";
import {stageBox} from "./light.js";

const STEPS = ["cells-1", "cells-2", "cells-3"];
const COLOR_BY = ["T", "nH", "Z", "V"];
let VIR = null;

/* cells holding half the ion's total N, largest first (frame-independent, memo on the data) */
const RANK = new WeakMap();
export function halfCells(data, ion) {
  let m = RANK.get(data); if (!m) { m = {}; RANK.set(data, m); }
  if (m[ion]) return m[ion];
  const I = K.ion(data, ion); if (!I) return (m[ion] = []);
  const c = I.cells, idx = Array.from({length: c.n}, (_, j) => j).filter(j => Number.isFinite(c.logN[j]));
  idx.sort((a, b) => c.logN[b] - c.logN[a] || a - b);
  let tot = 0; for (const j of idx) tot += 10 ** c.logN[j];
  const out = []; let s = 0;
  for (const j of idx) { out.push(j); s += 10 ** c.logN[j]; if (s >= 0.5 * tot) break; }
  return (m[ion] = out);
}
/* colour of a cell by quantity (heat: magma as the spectrum scenes; others: viridis) */
function cellColor(c, j, by, a = 1) {
  if (by === "T") return K.heatColor(c.T[j], a);
  if (!VIR) VIR = lut("viridis");
  let x;
  if (by === "nH") x = (Math.log10(Math.max(c.nH[j], 1e-9)) + 5.5) / 4.5;
  else if (by === "Z") x = (Math.log10(Math.max(c.Z[j], 1e-4)) + 1.5) / 2;
  else x = (c.V[j] + 250) / 500;
  const k = 4 * Math.round(255 * K.clamp(x));
  return `rgba(${VIR[k]},${VIR[k + 1]},${VIR[k + 2]},${a})`;
}
/* deterministic small vertical offset per cell (cells are 3D blobs straddling the beam) */
const jit = j => { let h = (j + 1) * 2654435761 >>> 0; h ^= h >>> 13; h = Math.imul(h, 1274126177) >>> 0; return ((h & 1023) / 1023 - 0.5); };
const sci = (x, d = 1) => {
  if (!Number.isFinite(x) || x <= 0) return "–";
  const e = Math.floor(Math.log10(x)), m = x / 10 ** e, S = {"-": "⁻", 0: "⁰", 1: "¹", 2: "²", 3: "³", 4: "⁴", 5: "⁵", 6: "⁶", 7: "⁷", 8: "⁸", 9: "⁹"};
  return `${m.toFixed(d)}×10${String(e).replace(/./g, ch => S[ch] || ch)}`;
};
/* bead radius (px) from the path inside the cell and its offset across the beam (cells are 3D blobs straddling it) */
const beadR = (dl, Fr) => K.clamp(1.1 + 2.1 * Math.sqrt(Math.max(dl, 0)), 1.1, 7) * (Fr.port ? 0.8 : 1);
const beadY = (j, y, Fr) => y + jit(j) * Fr.fs * 1.5;
/* plain soft disc (not additive: hundreds overlap on the beam) */
function disc(ctx, x, y, r, color, a) {
  if (a <= 0) return; ctx.save(); ctx.globalAlpha = K.clamp(a); ctx.fillStyle = color; ctx.beginPath(); ctx.arc(x, y, r, 0, 2 * Math.PI); ctx.fill(); ctx.restore();
}
export const fmtT = T => (T >= 1e5 ? sci(T, 1) : K.fmtInt(Math.round(T / 10) * 10)) + " K";

function geomFor(Fr, state) {
  const box = stageBox(Fr, state), pad = Fr.fs * 2.2;
  const x0 = box.x + pad + (box.card ? Fr.fs : 0), x1 = box.x + box.w - pad, y = Fr.H * (Fr.port ? 0.42 : 0.44);
  return {box, x0, x1, y};
}

function render(ctx, state, t, data, env = {}) {
  const p = K.params(scene, state), k = K.stepIndex(state, STEPS), q = K.clamp(p.p);
  const Fr = K.frame(ctx, state), P = K.prep(data), O = K.ion(data, K.LEAD), H = K.ion(data, K.SAT_ION), c = O.cells;
  const half = Number.isFinite(P.meta.half) ? P.meta.half : 250, Gm = geomFor(Fr, state), {x0, x1, y} = Gm;
  const X = l => x0 + (l + half) / (2 * half) * (x1 - x0), Lx = x => -half + (x - x0) / (x1 - x0) * 2 * half;
  const by = COLOR_BY.includes(p.colorBy) ? p.colorBy : "T";
  // the beam and its ruler
  ctx.save(); ctx.strokeStyle = K.rgba(K.COL.beam, 0.5); ctx.lineWidth = 1.5; ctx.beginPath(); ctx.moveTo(x0, y); ctx.lineTo(x1, y); ctx.stroke(); ctx.restore();
  const ry = y + Fr.fs * (Fr.port ? 4.2 : 4.8);
  ctx.save(); ctx.strokeStyle = K.COL.faint; ctx.lineWidth = 1; ctx.beginPath(); ctx.moveTo(x0, ry); ctx.lineTo(x1, ry);
  for (const l of [-half, -half / 2, 0, half / 2, half]) { ctx.moveTo(X(l), ry - 4); ctx.lineTo(X(l), ry + 4); }
  ctx.stroke(); ctx.restore();
  K.text(Fr, `${K.fmt(2 * half, 0)} kpc of path`, (x0 + x1) / 2, ry + Fr.fs * 1.5, {size: 0.72, color: K.COL.muted, align: "center"});
  K.text(Fr, "quasar side", x1, y - Fr.fs * 2.6, {size: 0.66, color: K.COL.faint, align: "right"});
  K.text(Fr, "our side", x0, y - Fr.fs * 2.6, {size: 0.66, color: K.COL.faint});
  // beads (step 1: revealed right to left as the light crosses them)
  const front = k === 0 ? K.lerp(half * 1.02, -half * 1.02, K.seg(q, 0.05, 0.85)) : -Infinity;
  const hiO = k === 2 ? new Set(halfCells(data, K.LEAD)) : null, hiH = k === 2 && H ? new Set(halfCells(data, K.SAT_ION)) : null;
  const dimA = k === 2 ? 1 - 0.75 * K.seg(q, 0.1, 0.5) : 1;
  let shown = 0;
  for (let j = 0; j < c.n; j++) {
    if (c.l[j] < front) continue;
    shown++;
    const r = beadR(c.dl[j], Fr);
    const lit = k === 0 ? K.seg((c.l[j] - front) / (0.05 * half), 0, 1) : 1;
    disc(ctx, X(c.l[j]), beadY(j, y, Fr), r, cellColor(c, j, by), (0.45 + 0.4 * lit) * dimA);
  }
  if (k === 0) {
    const fx = X(Math.max(front, -half));
    K.text(Fr, `${K.fmtInt(shown)} cells`, x1, ry + Fr.fs * 3.1, {size: 0.8, mono: true, color: K.COL.ink, align: "right", alpha: K.seg(q, 0.05, 0.2)});
    if (front > -half) { ctx.save(); ctx.globalCompositeOperation = "lighter"; const g = ctx.createRadialGradient(fx, y, 0, fx, y, Fr.fs * 2.5);
      g.addColorStop(0, "rgba(255,244,224,0.55)"); g.addColorStop(1, "rgba(255,244,224,0)"); ctx.fillStyle = g; ctx.fillRect(fx - Fr.fs * 2.5, y - Fr.fs * 2.5, Fr.fs * 5, Fr.fs * 5); ctx.restore(); }
  }
  // step 2: the probe reads one cell (explore: a pinned position)
  if (k === 1) {
    const lp = Number.isFinite(+p.probe) ? K.clamp(+p.probe, -half, half) : K.lerp(-0.9 * half, 0.9 * half, q);
    // the nearest cell with a real path through it
    let jb = -1, db = Infinity;
    for (let j = 0; j < c.n; j++) { const d = Math.abs(c.l[j] - lp) / Math.max(0.15, Math.sqrt(c.dl[j])); if (d < db) { db = d; jb = j; } }
    if (jb >= 0) {
      const xp = X(c.l[jb]), yp = beadY(jb, y, Fr);
      ctx.save(); ctx.strokeStyle = K.COL.accent; ctx.lineWidth = 1.5; ctx.beginPath(); ctx.arc(xp, yp, Fr.fs * 0.75, 0, 2 * Math.PI); ctx.stroke();
      ctx.setLineDash([2, 4]); ctx.beginPath(); ctx.moveTo(xp, yp + Fr.fs * 0.75); ctx.lineTo(xp, ry); ctx.stroke(); ctx.restore();
      const rows = Fr.physics
        ? [["n_H", `${sci(c.nH[jb], 1)} cm⁻³`], ["T", fmtT(c.T[jb])], ["Z", `${K.fmt(c.Z[jb], 2)} Z☉`], ["v", `${K.fmt(c.V[jb], 0)} km/s`], ["dl", `${K.fmt(c.dl[jb], 2)} kpc`]]
        : [["density", `${sci(c.nH[jb], 1)} atoms per cm³`], ["heat", fmtT(c.T[jb])], ["metals", `${K.fmt(c.Z[jb], 2)} × the Sun's`], ["speed", `${K.fmt(c.V[jb], 0)} km/s`]];
      const w = Fr.fs * (Fr.port ? 15 : 17), h = Fr.fs * (1.0 + 1.25 * rows.length), gx = K.clamp(xp - w / 2, x0, x1 - w);
      const gy = ry + Fr.fs * 2.6;
      K.glass(Fr, gx, gy, w, h);
      rows.forEach(([a, b], i) => {
        K.text(Fr, a, gx + Fr.fs * 0.8, gy + Fr.fs * (1.45 + 1.25 * i), {size: 0.74, color: K.COL.muted});
        K.text(Fr, b, gx + w - Fr.fs * 0.8, gy + Fr.fs * (1.45 + 1.25 * i), {size: 0.78, mono: true, align: "right"});
      });
    }
  }
  // step 3: the few cells that hold half of each ion
  if (k === 2) {
    const ring = K.seg(q, 0.3, 0.75);
    const mark = (set, I, label, dy) => {
      if (!set || !set.size || !I) return;
      let first = null;
      for (const j of set) {
        const r = beadR(c.dl[j], Fr), xx = X(c.l[j]), yy = beadY(j, y, Fr);
        K.bead(Fr, xx, yy, r * 1.3, I.color, ring);
        ctx.save(); ctx.globalAlpha = ring; ctx.strokeStyle = I.color; ctx.lineWidth = 1.5; ctx.beginPath(); ctx.arc(xx, yy + dy * 0.0, Fr.fs * (0.55 + 0.25 * (1 - ring)) + r, 0, 2 * Math.PI); ctx.stroke(); ctx.restore();
        if (!first || xx < first[0]) first = [xx, yy];
      }
      const n = set.size;
      K.text(Fr, Fr.physics ? `${label}: ${n} cells hold 50 % of N` : `${label}: ${n} cells hold half`, first[0], y + dy, {size: 0.78, color: I.color, alpha: K.seg(q, 0.5, 0.85), halo: true, align: first[0] > (x0 + x1) / 2 ? "right" : "left"});
    };
    mark(hiO, O, "O VI", -Fr.fs * 2.6);
    mark(hiH, H, "H I", Fr.fs * 3.3);
  }
  // colour key (explore) or heat key
  if (k === 1 || (state.mode === "explore")) {
    const kw = Fr.fs * 9, kx = x0, ky = ry + Fr.fs * (k === 1 ? 10.5 : 3.6);
    for (let i = 0; i < 40; i++) {
      const fake = {T: [10 ** (4 + 2.5 * i / 39)], nH: [10 ** (-5.5 + 4.5 * i / 39)], Z: [10 ** (-1.5 + 2 * i / 39)], V: [-250 + 500 * i / 39]};
      ctx.save(); ctx.fillStyle = cellColor(fake, 0, by); ctx.fillRect(kx + kw * i / 40, ky, kw / 40 + 0.5, Fr.fs * 0.35); ctx.restore();
    }
    const lab = {T: ["10⁴ K", "heat", "3×10⁶ K"], nH: ["sparse", "density", "dense"], Z: ["0.03", "metals (× Sun)", "3"], V: ["−250", "speed (km/s)", "+250"]}[by];
    K.text(Fr, lab[0], kx, ky + Fr.fs * 1.2, {size: 0.6, color: K.COL.muted, mono: true});
    K.text(Fr, lab[1], kx + kw / 2, ky - Fr.fs * 0.35, {size: 0.62, color: K.COL.muted, align: "center"});
    K.text(Fr, lab[2], kx + kw, ky + Fr.fs * 1.2, {size: 0.6, color: K.COL.muted, mono: true, align: "right"});
  }
  void Lx;
}

/* Explore: pin the probe by pointer (canvas CSS px) */
function hit(ctx, state, data, x) {
  const Fr = K.frame({canvas: ctx.canvas, setTransform() {}, fillRect() {}}, state), P = K.prep(data), half = Number.isFinite(P.meta.half) ? P.meta.half : 250;
  const {x0, x1} = geomFor(Fr, state);
  return {probe: K.clamp(-half + (x - x0) / (x1 - x0) * 2 * half, -half, half)};
}
function ready(data) { K.prep(data); halfCells(data, K.LEAD); halfCells(data, K.SAT_ION); }
const controls = {probe: {label: "probe position", kind: "range"}, colorBy: {label: "colour by", kind: "enum", values: COLOR_BY}};
const scene = {id: "cells", chapter: "cells", steps: STEPS, defaults: {}, interp: {colorBy: "snap"}, controls, hit, ready, render,
  handoff: {ions: ["HI", "OVI"], layout: "1", R: [30000, 30000], sn: [10, 10]}};
export default scene;
export {render, ready, hit, controls};
export const id = scene.id, defaults = scene.defaults, interp = scene.interp;
