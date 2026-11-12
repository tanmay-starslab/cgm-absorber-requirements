// S4 "Which atoms take the light?" (chapter ions; PLAN_final §3 S4, unit U3). Step 1: the cell holding the most
// neutral hydrogen opens up: cool gas keeps some hydrogen atoms whole (x_HI, the simulation's own share). Step 2: the
// cell holding the most O VI: warm-hot gas where oxygen has lost five electrons, with f_OVI(T) drawn as a band over five
// densities (HM2012 table, dots coloured by n_H) and this cell marked on it. Step 3: each ion takes only photons that
// fit its electron step (λ = hc/ΔE). Explore (step 2): heat and density sliders move a test cell along the table.
//
// Galaxy-agnostic: the featured cells follow the data's selection rules (data.select / data.worked, else the cell with
// the largest N of the ion); wavelengths come from the data's atomic constants. Pure renderer.
import * as K from "../plot.js";
import {lut} from "../../../../js/colormaps.js";
import {stageBox} from "./light.js";
import {fmtT} from "./cells.js";

const STEPS = ["ions-1", "ions-2", "ions-3"];
const HC_EV_A = 12398.42;                     // h c in eV Å
let VIR = null;
const vir = (x, a = 1) => { if (!VIR) VIR = lut("viridis"); const k = 4 * Math.round(255 * K.clamp(x)); return `rgba(${VIR[k]},${VIR[k + 1]},${VIR[k + 2]},${a})`; };

/* the featured cell of an ion: data.worked (U0 rule) or the cell with the largest N; -> {j, T, nH, frac, Z} */
export function featured(data, ion) {
  const P = K.prep(data), I = K.ion(data, ion); if (!I) return null;
  const c = I.cells, w = (data.worked || {})[ion === "HI" ? "S4a" : "S4b"] || {};
  let j = w.cell != null && c.pos && c.pos.has(+w.cell) ? c.pos.get(+w.cell) : -1;
  if (j < 0) { j = 0; for (let i = 1; i < c.n; i++) if (c.logN[i] > c.logN[j]) j = i; }
  const frac = ion === "HI" ? +(w.xHI ?? c.fion[j]) : +(w.f_OVI ?? c.fion[j]);
  void P;
  return {j, T: +(w.T ?? c.T[j]), nH: +(w.nH ?? c.nH[j]), frac, Z: +(w.Z ?? c.Z[j]), l: c.l[j]};
}
/* f_OVI(log nH, log T) from the HM2012 grid (bilinear in log f, as Trident), 0 below the floor */
export function fOVI(fion, lognH, logT) {
  const G = fion && fion.grid; if (!G) return NaN;
  const ax = (a, v) => { const n = a.length; if (v <= a[0]) return [0, 0]; if (v >= a[n - 1]) return [n - 2, 1];
    let i = 0; while (a[i + 1] < v) i++; return [i, (v - a[i]) / (a[i + 1] - a[i])]; };
  const [i, fi] = ax(G.logNH, lognH), [j, fj] = ax(G.logT, logT), F = G.log10_f;
  const v = (1 - fi) * ((1 - fj) * F[i][j] + fj * F[i][j + 1]) + fi * ((1 - fj) * F[i + 1][j] + fj * F[i + 1][j + 1]);
  return v <= -8.99 ? 0 : 10 ** v;
}
/* sunflower positions (deterministic) of n dots in a unit disc */
function sunflower(n) { const out = [], ga = Math.PI * (3 - Math.sqrt(5)); for (let i = 0; i < n; i++) { const r = Math.sqrt((i + 0.5) / n); out.push([r * Math.cos(i * ga), r * Math.sin(i * ga)]); } return out; }
const DOTS = sunflower(64);

function layout(Fr, state) {
  const box = stageBox(Fr, state), pad = Fr.fs * 1.8;
  const x0 = box.x + pad + (box.card ? Fr.fs : 0), x1 = box.x + box.w - pad;
  if (Fr.port) {
    // phones: strip under the chrome, the cell with its numbers beside it, the chart below (inside the safe box)
    const top = Fr.box.y + Fr.fs * 0.8, bot = Fr.box.y + Fr.box.h, r = Math.min((x1 - x0) * 0.2, Fr.H * 0.1);
    const disc = {x: x0 + r, y: top + Fr.fs * 2.2 + r, r}, lx = disc.x + r + Fr.fs * 1.2;
    const cy = disc.y + r + Fr.fs * 3.2;
    return {box, strip: {x0, x1, y: top}, disc, lab: {x: lx, y: disc.y - r * 0.35, w: x1 - lx}, keys: {x: lx, y: disc.y + r * 0.55},
      chart: {x: x0 + Fr.fs * 2.4, y: cy, w: x1 - x0 - Fr.fs * 2.6, h: Math.max(Fr.fs * 6, bot - cy - Fr.fs * 5.2)}};
  }
  const top = Fr.H * 0.14, r = Math.min((x1 - x0) * 0.17, Fr.H * 0.24), disc = {x: x0 + r + Fr.fs * 0.5, y: Fr.H * 0.5, r};
  return {box, strip: {x0, x1, y: top}, disc, lab: {x: disc.x - r, y: disc.y + r + Fr.fs * 1.9, w: Math.max(2 * r, Fr.fs * 15)},
    keys: {x: disc.x + r + Fr.fs * 1.2, y: disc.y - r * 0.45},
    chart: {x: x0 + 2 * r + Fr.fs * 6, y: Fr.H * 0.3, w: x1 - (x0 + 2 * r + Fr.fs * 6), h: Fr.H * 0.46}};
}

/* the beam at the top with every cell faint and the featured one lit, joined by a thread to the open cell */
function beamStrip(Fr, data, L, j, color, a) {
  const P = K.prep(data), c = K.ion(data, K.LEAD).cells, half = Number.isFinite(P.meta.half) ? P.meta.half : 250, {x0, x1, y} = L.strip;
  const X = l => x0 + (l + half) / (2 * half) * (x1 - x0), ctx = Fr.ctx;
  ctx.save(); ctx.globalAlpha = a; ctx.strokeStyle = K.rgba(K.COL.beam, 0.45); ctx.lineWidth = 1; ctx.beginPath(); ctx.moveTo(x0, y); ctx.lineTo(x1, y); ctx.stroke(); ctx.restore();
  for (let i = 0; i < c.n; i += 1) K.bead(Fr, X(c.l[i]), y, K.clamp(1 + 1.6 * Math.sqrt(Math.max(c.dl[i], 0)), 1, 5), K.heatColor(c.T[i]), 0.25 * a);
  if (j == null) return null;
  const xs = X(c.l[j]);
  K.bead(Fr, xs, y, 5, color, a);
  ctx.save(); ctx.globalAlpha = a; ctx.strokeStyle = color; ctx.lineWidth = 1.5; ctx.beginPath(); ctx.arc(xs, y, Fr.fs * 0.6, 0, 2 * Math.PI); ctx.stroke(); ctx.restore();
  return xs;
}
/* the opened cell: a glass disc with n atoms; `lit` of them drawn as the ion that matters */
function cellDisc(Fr, D, grow, o) {
  const ctx = Fr.ctx, r = D.r * grow; if (r < 1) return;
  ctx.save(); ctx.globalAlpha = K.clamp(grow);
  const g = ctx.createRadialGradient(D.x, D.y, r * 0.2, D.x, D.y, r);
  g.addColorStop(0, K.heatColor(o.T, 0.20)); g.addColorStop(1, K.heatColor(o.T, 0.06));
  ctx.fillStyle = g; ctx.beginPath(); ctx.arc(D.x, D.y, r, 0, 2 * Math.PI); ctx.fill();
  ctx.strokeStyle = "rgba(236,240,255,0.18)"; ctx.lineWidth = 1; ctx.stroke(); ctx.restore();
  const n = o.n || 64, lit = Math.round(K.clamp(o.frac) * n), dotR = Math.max(2, r * 0.045);
  for (let i = 0; i < n; i++) {
    const [ux, uy] = DOTS[Math.floor(i * DOTS.length / n)], x = D.x + ux * r * 0.86, y = D.y + uy * r * 0.86;
    const appear = K.clamp(o.atoms * n - i * 0.6), on = Math.floor((i + 1) * lit / n) > Math.floor(i * lit / n);
    if (appear <= 0) continue;
    ctx.save(); ctx.globalAlpha = K.clamp(appear) * K.clamp(grow);
    if (on && o.light > 0) {
      ctx.globalCompositeOperation = "lighter"; ctx.fillStyle = K.rgba(o.color, 0.25 + 0.75 * o.light); ctx.beginPath(); ctx.arc(x, y, dotR * 1.2, 0, 2 * Math.PI); ctx.fill();
      if (o.shell) { ctx.strokeStyle = K.rgba(o.color, 0.6 * o.light); ctx.lineWidth = 1; ctx.beginPath(); ctx.arc(x, y, dotR * 2.4, 0, 2 * Math.PI); ctx.stroke(); }
    } else {
      ctx.fillStyle = "rgba(200,205,220,0.55)"; ctx.beginPath(); ctx.arc(x, y, dotR * 0.75, 0, 2 * Math.PI); ctx.fill();
    }
    ctx.restore();
  }
}
function bar(Fr, x, y, w, frac, color, a, label) {
  const ctx = Fr.ctx, h = Fr.fs * 0.5;
  ctx.save(); ctx.globalAlpha = a; ctx.fillStyle = "rgba(236,240,255,0.10)"; ctx.fillRect(x, y, w, h);
  ctx.fillStyle = color; ctx.fillRect(x, y, w * K.clamp(frac), h); ctx.restore();
  K.text(Fr, label, x, y - Fr.fs * 0.45, {size: 0.74, color: K.COL.muted, alpha: a});
  K.text(Fr, `${Math.round(100 * frac)} %`, x + w, y - Fr.fs * 0.45, {size: 0.8, mono: true, color, align: "right", alpha: a});
}

/* f_OVI(T): band over the n_H slices (min..max), dots per slice coloured by n_H, the featured cell, the test cell */
function fionChart(Fr, C, fion, a, mark, test) {
  if (!fion || !fion.logT || a <= 0) return;
  const ctx = Fr.ctx, T0 = 4, T1 = 7, Y1 = 0.32, X = lt => C.x + (lt - T0) / (T1 - T0) * C.w, Y = f => C.y + C.h - f / Y1 * C.h;
  const lt = fion.logT, S = fion.f_slices, ns = S.length;
  ctx.save(); ctx.globalAlpha = a;
  // axes
  ctx.strokeStyle = K.COL.grid; ctx.lineWidth = 1; ctx.beginPath(); ctx.moveTo(C.x, C.y); ctx.lineTo(C.x, C.y + C.h); ctx.lineTo(C.x + C.w, C.y + C.h); ctx.stroke();
  // band
  ctx.beginPath();
  for (let i = 0; i < lt.length; i++) { let m = -1; for (const s of S) m = Math.max(m, s[i]); i ? ctx.lineTo(X(lt[i]), Y(m)) : ctx.moveTo(X(lt[i]), Y(m)); }
  for (let i = lt.length - 1; i >= 0; i--) { let m = 9; for (const s of S) m = Math.min(m, s[i]); ctx.lineTo(X(lt[i]), Y(m)); }
  ctx.closePath(); ctx.fillStyle = K.rgba(K.ionColor("OVI"), 0.16); ctx.fill();
  ctx.restore();
  for (let s = 0; s < ns; s++) for (let i = 0; i < lt.length; i += 2) {
    ctx.save(); ctx.globalAlpha = a; ctx.fillStyle = vir(s / Math.max(1, ns - 1), 0.9); ctx.beginPath(); ctx.arc(X(lt[i]), Y(S[s][i]), Math.max(1.4, Fr.fs * 0.1), 0, 2 * Math.PI); ctx.fill(); ctx.restore();
  }
  const tick = ["10⁴", "10⁵", "10⁶", "10⁷"];
  [4, 5, 6, 7].forEach((v, i) => K.text(Fr, tick[i], X(v), C.y + C.h + Fr.fs * 1.3, {size: 0.62, color: K.COL.muted, mono: true, align: i === 0 ? "left" : i === 3 ? "right" : "center", alpha: a}));
  K.text(Fr, Fr.physics ? "T (K)" : "heat (kelvin)", C.x + C.w / 2, C.y + C.h + Fr.fs * 2.6, {size: 0.7, color: K.COL.muted, align: "center", alpha: a});
  for (const f of [0, 0.1, 0.2, 0.3]) K.text(Fr, f === 0 ? "0" : `${Math.round(f * 100)} %`, C.x - Fr.fs * 0.4, Y(f) + Fr.fs * 0.25, {size: 0.6, color: K.COL.muted, mono: true, align: "right", alpha: a});
  K.text(Fr, Fr.physics ? "f_OVI = n(O VI) / n(O)" : "share of oxygen that is O VI", C.x, C.y - Fr.fs * 0.8, {size: 0.72, color: K.COL.muted, alpha: a});
  // density key
  const kx = C.x + C.w - Fr.fs * 4.4 - (ns - 1) * Fr.fs * 1.1, ky = C.y + C.h + Fr.fs * 4.3;
  for (let s = 0; s < ns; s++) { ctx.save(); ctx.globalAlpha = a; ctx.fillStyle = vir(s / Math.max(1, ns - 1)); ctx.beginPath(); ctx.arc(kx + s * Fr.fs * 1.1, ky, Fr.fs * 0.22, 0, 2 * Math.PI); ctx.fill(); ctx.restore(); }
  K.text(Fr, "sparse", kx - Fr.fs * 0.5, ky + Fr.fs * 0.25, {size: 0.58, color: K.COL.muted, align: "right", alpha: a});
  K.text(Fr, "dense", kx + (ns - 1) * Fr.fs * 1.1 + Fr.fs * 0.5, ky + Fr.fs * 0.25, {size: 0.58, color: K.COL.muted, alpha: a});
  // too hot: shading where every density has passed its peak
  const hot = 5.75;
  ctx.save(); ctx.globalAlpha = a * mark.hot * 0.5; ctx.fillStyle = "rgba(236,240,255,0.05)"; ctx.fillRect(X(hot), C.y, X(T1) - X(hot), C.h); ctx.restore();
  K.text(Fr, "too hot: more electrons lost", C.x + C.w, Y(0.29), {size: 0.66, color: K.COL.muted, alpha: a * mark.hot, align: "right"});
  // the featured cell
  if (mark.a > 0 && Number.isFinite(mark.T)) {
    const x = X(Math.log10(mark.T)), y = Y(mark.f);
    ctx.save(); ctx.globalAlpha = a * mark.a; ctx.strokeStyle = K.ionColor("OVI"); ctx.lineWidth = 2; ctx.beginPath(); ctx.arc(x, y, Fr.fs * 0.5, 0, 2 * Math.PI); ctx.stroke(); ctx.restore();
    K.text(Fr, "this cell", x + Fr.fs * 0.8, y - Fr.fs * 0.5, {size: 0.72, color: K.ionColor("OVI"), alpha: a * mark.a, halo: true});
  }
  if (test) {
    const x = X(K.clamp(test.logT, T0, T1)), y = Y(Math.min(Y1, test.f));
    ctx.save(); ctx.globalAlpha = a; ctx.fillStyle = K.COL.accent; ctx.beginPath(); ctx.arc(x, y, Fr.fs * 0.32, 0, 2 * Math.PI); ctx.fill(); ctx.restore();
    K.text(Fr, `test cell: ${Math.round(test.f * 100)} %`, x + Fr.fs * 0.7, y + Fr.fs * 1.2, {size: 0.72, color: K.COL.accent, alpha: a, halo: true});
  }
}

/* an electron-step ladder: ground and upper level, the electron, photons arriving from the left */
function ladder(Fr, x, y0, w, h, atom, color, name, q, a) {
  const ctx = Fr.ctx, lam = atom.lam0_A || atom.lam0 || 1216, dE = HC_EV_A / lam, top = y0 - h * dE / 13.6;
  ctx.save(); ctx.globalAlpha = a; ctx.strokeStyle = "rgba(236,240,255,0.65)"; ctx.lineWidth = 2;
  ctx.beginPath(); ctx.moveTo(x, y0); ctx.lineTo(x + w, y0); ctx.moveTo(x, top); ctx.lineTo(x + w, top); ctx.stroke();
  ctx.strokeStyle = K.rgba(color, 0.5); ctx.setLineDash([3, 4]); ctx.lineWidth = 1; ctx.beginPath(); ctx.moveTo(x + w + Fr.fs * 0.6, y0); ctx.lineTo(x + w + Fr.fs * 0.6, top); ctx.stroke(); ctx.restore();
  K.text(Fr, name, x + w / 2, y0 + Fr.fs * 1.6, {size: 0.9, color, align: "center", alpha: a, weight: 500});
  K.text(Fr, Fr.physics ? `ΔE = ${K.fmt(dE, 2)} eV` : "step", x + w + Fr.fs * 1.1, (y0 + top) / 2 + Fr.fs * 0.3, {size: 0.66, color: K.COL.muted, alpha: a, mono: Fr.physics});
  // three photons: shorter, matching, longer wavelength; only the match is taken
  const photons = [{lam: lam * 0.86, t0: 0.05}, {lam, t0: 0.3}, {lam: lam * 1.16, t0: 0.55}];
  let jumped = 0;
  for (const ph of photons) {
    const u = K.clamp((q - ph.t0) / 0.32), match = ph.lam === lam;
    if (u <= 0) continue;
    const xs = x - Fr.fs * 9, xe = match ? x + w * 0.5 : x + w + Fr.fs * 6, xh = K.lerp(xs, xe, u), yy = (y0 + top) / 2;
    if (match && u >= 1) { jumped = K.clamp((q - ph.t0 - 0.32) / 0.12); continue; }
    const wl = Fr.fs * 0.9 * ph.lam / lam, amp = Fr.fs * 0.35, len = Fr.fs * 4.5;
    ctx.save(); ctx.globalAlpha = a * (match ? 1 : 0.7) * (u >= 1 ? 0 : 1); ctx.strokeStyle = match ? color : "rgba(236,240,255,0.55)"; ctx.lineWidth = 1.6;
    ctx.beginPath(); for (let s = 0; s <= 40; s++) { const xx = xh - len + len * s / 40, yv = yy + amp * Math.sin(2 * Math.PI * (xx - xh) / wl); s ? ctx.lineTo(xx, yv) : ctx.moveTo(xx, yv); } ctx.stroke(); ctx.restore();
    K.text(Fr, `${K.fmt(ph.lam, 0)} Å`, xh - len / 2, yy - Fr.fs * 0.9, {size: 0.6, color: match ? color : K.COL.muted, mono: true, align: "center", alpha: a * (u >= 1 ? 0 : 1)});
  }
  const ey = K.lerp(y0, top, jumped), ex = x + w * 0.5;
  ctx.save(); ctx.globalAlpha = a; ctx.globalCompositeOperation = "lighter"; ctx.fillStyle = jumped > 0 ? color : "rgba(236,240,255,0.9)";
  ctx.beginPath(); ctx.arc(ex, ey, Fr.fs * 0.28, 0, 2 * Math.PI); ctx.fill(); ctx.restore();
  if (jumped > 0.5) K.text(Fr, Fr.physics ? `λ = hc/ΔE = ${K.fmt(lam, 0)} Å` : `${K.fmt(lam, 0)} Å fits the step`, ex, top - Fr.fs * 0.8, {size: 0.72, color, align: "center", alpha: a * K.clamp(jumped * 2 - 1), halo: true});
}

function render(ctx, state, t, data, env = {}) {
  const p = K.params(scene, state), k = K.stepIndex(state, STEPS), q = K.clamp(p.p);
  const Fr = K.frame(ctx, state), L = layout(Fr, state), fion = data.fion || null;
  const H = K.ion(data, K.SAT_ION), O = K.ion(data, K.LEAD), ex = state.mode === "explore" && state.explore ? state.explore : null;
  if (k === 0 || k === 1) {
    const ion = k === 0 ? K.SAT_ION : K.LEAD, I = k === 0 ? H : O, F = featured(data, ion);
    if (!F || !I) return;
    const xs = beamStrip(Fr, data, L, F.j, I.color, 1);
    const grow = K.seg(q, 0.05, 0.4), atoms = K.seg(q, 0.25, 0.65), light = K.seg(q, 0.55, 0.9);
    if (xs != null) K.thread(Fr, xs, L.strip.y + Fr.fs * 0.6, L.disc.x, L.disc.y - L.disc.r * grow, {color: K.rgba(I.color, 0.6), alpha: grow});
    cellDisc(Fr, L.disc, grow, {T: F.T, frac: F.frac, n: 64, atoms, light, color: I.color, shell: k === 0});
    const lx = L.lab.x, ly = L.lab.y;
    K.text(Fr, Fr.physics ? `T = ${fmtT(F.T)}` : `heat ${fmtT(F.T)}`, lx, ly, {size: 0.8, mono: true, alpha: grow});
    if (k === 0) {
      bar(Fr, lx, ly + Fr.fs * 2.2, L.lab.w, F.frac, I.color, light, Fr.physics ? "x_HI = n(H I) / n_H" : "hydrogen atoms still whole");
      K.text(Fr, Fr.physics ? "grey: ionised, H II" : "grey: atoms that lost their electron", L.keys.x, L.keys.y + Fr.fs * (Fr.port ? 3.4 : 0) + L.disc.r * (Fr.port ? 0 : 1), {size: 0.74, color: K.COL.muted, alpha: light});
      K.text(Fr, Fr.physics ? "ringed: neutral, H I" : "ringed: whole atoms, they take the light", L.keys.x, L.keys.y + Fr.fs * (Fr.port ? 2.2 : 0), {size: 0.74, color: I.color, alpha: light});
    } else {
      bar(Fr, lx, ly + Fr.fs * 2.2, L.lab.w, F.frac, I.color, light, Fr.physics ? "f_OVI" : "oxygen as O VI");
      const test = ex && (Number.isFinite(+ex.logT) || Number.isFinite(+ex.lognH)) ? (() => {
        const lt = Number.isFinite(+ex.logT) ? +ex.logT : Math.log10(F.T), ln = Number.isFinite(+ex.lognH) ? +ex.lognH : Math.log10(F.nH);
        return {logT: lt, lognH: ln, f: fOVI(fion, ln, lt)}; })() : null;
      fionChart(Fr, L.chart, fion, K.seg(q, 0.3, 0.7), {T: F.T, f: F.frac, a: K.seg(q, 0.6, 0.9), hot: K.seg(q, 0.75, 1)}, test);
      if (test) {
        const peak = (() => { let best = 4, bf = -1; for (let lt = 4; lt <= 7; lt += 0.05) { const f = fOVI(fion, test.lognH, lt); if (f > bf) { bf = f; best = lt; } } return best; })();
        if (test.logT > Math.max(5.6, peak + 0.15)) K.text(Fr, "Too hot and it loses more electrons", L.chart.x + L.chart.w, L.chart.y + L.chart.h + Fr.fs * 4.2, {size: 0.8, color: K.COL.accent, align: "right", halo: true});
      }
    }
  } else {
    // step 3: electron steps of the two ions
    const w = Fr.fs * 6, h = Fr.H * (Fr.port ? 0.22 : 0.42), y0 = Fr.H * (Fr.port ? 0.62 : 0.78);
    const xa = L.box.x + L.box.w * (Fr.port ? 0.28 : 0.36), xb = L.box.x + L.box.w * (Fr.port ? 0.7 : 0.72);
    const a = K.seg(q, 0, 0.12);
    if (H) ladder(Fr, xa - w / 2, y0, w, h, H.atom, H.color, "H I", K.seg(q, 0.08, 1), a);
    if (O) ladder(Fr, xb - w / 2, y0, w, h, O.atom, O.color, "O VI", K.seg(q, 0.08, 1), a);
    K.text(Fr, Fr.physics ? "f: how strong the jump; Γ: how long the upper level lives" : "energy", L.box.x + Fr.fs * 2 + (L.box.card ? Fr.fs : 0), Fr.H * 0.18, {size: 0.66, color: K.COL.faint, alpha: a});
  }
}

function hit() { return null; }
function ready(data) { K.prep(data); }
const controls = {logT: {label: "heat (log T)", kind: "range"}, lognH: {label: "density (log n_H)", kind: "range"}};
const scene = {id: "ions", chapter: "ions", steps: STEPS, defaults: {}, controls, hit, ready, render,
  handoff: {ions: ["HI", "OVI"], layout: "1", R: [30000, 30000], sn: [10, 10]}};
export default scene;
export {render, ready, hit, controls};
export const id = scene.id, defaults = scene.defaults;
