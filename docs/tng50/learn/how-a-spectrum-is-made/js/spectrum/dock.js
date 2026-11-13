// The live spectrum dock (DESIGN_final §5.4, §3.3 dock states, §3.4 "JS (seek, τ sum)", C_ux P0-2/P0-5/P0-7).
//
//   const spectrum = createSpectrum({parent, data, bus, worker?, fitWorker?, scrim?})
//   await spectrum.ready()                      τ caches built (worker when given, else synchronously)
//   spectrum.render(fs, env)                    one frame; env = {w, h, dpr, cls?, insets?, rect?, project?, hidden?}
//   spectrum.rects()                            solver items of the last frame: the dock children (ids "label:OVI", ...,
//                                               container "dock" in the shell) + exempt connector/tether ends
//   spectrum.kids()                             same, in the shell's ext.dockKids form [{id, rect, kind}]
//   spectrum.connectors()                       screen paths of the last frame [{kind, id, a, c1, c2, b, alpha}]
//   spectrum.corridors()                        the paths as solver corridors (G3)
//   spectrum.describe(fs)                       one plain sentence for the narrative / aria-live
//   spectrum.scrim(k?)                          the dock's GL scrim rect for stage.setScrims ({x0, y0, x1, y1, k}, viewport
//                                               fractions, y down); use with {scrim: false} (no canvas fallback scrim)
//   spectrum.warmed                             true once the idle warm-up has cached every B12a blur (o.warm: false skips)
//
// What it draws, by FrameState.spec:
//   intrinsic (flight B3-B11): τ(s) = Σ W_i(s) τ_i(v) at the probe's ℓ (tausum.js, stateless), F = e^−τ per ion, the probe
//     cell's share lit, the depth gained over the last few kpc as a burn shine (afterglow), a meter "gas crossed X %" (share of the ion's column behind the probe),
//     and, under an equation drag, the ghost dip (bind.js ghostCell; N above 10^18.5 widens the ghost axis to ±600 km/s
//     with a "damping wings" label). Strip: lead ion + a 3 px barcode of the other; pair: both ions stacked.
//   observed (B12a R sweep, B12b S/N sweep): the explorer's degradeV on the stored line (plot.observed), 5 pixels per
//     resolution element, one noise draw scaled by S/N, the blur bell to scale; hero with R / S/N dials in the header.
//   fit (B13): the stored page fits (no live fitting in seek), then the CREST landing (tethers by M[s, c]).
//   explore (B14): live fit of the current R / S/N through fitworker.js "story-fit" messages.
// The scene modules js/scenes/{sum,dip,saturation,lsf,noise,fit,yourturn}.js keep their v1 physics and export the dock
// modes drawn here (dockSum, dockCell, dockGhost, dockLSF, dockNoise, dockFit, dockExplore).
//
// Layout is a pure function (dockLayout) of the dock rect and the dock state; every label, readout, tick row and dial is a
// registered child box inside the dock (G1), text never below 12 CSS px (G2).
import * as K from "../plot.js";
import {tauSumFromData, tauSumFromBuffers, ionInputs} from "./tausum.js";
import {connector, tethers, corridors as linkCorridors, panelX} from "./link.js";
import {createDials, visibleFor, DIAL_SIZE, TOGGLE_W} from "./dials.js";
import {layoutClass, computeBands} from "../ui/layoutclass.js";
import {ghostCell} from "../eq/bind.js";
import {dockSum} from "../scenes/sum.js";
import {dockCell} from "../scenes/dip.js";
import {dockGhost, ghostProfile} from "../scenes/saturation.js";
import {dockLSF, observedR, quantR, warmObservedR} from "../scenes/lsf.js";
import {dockNoise, observedSN, noiseBin, noiseTop} from "../scenes/noise.js";
import {PIX_PER_RESEL} from "../../../../js/fit.js";
import {dockFit, fitPhase, FIT_PHASES, crestComps} from "../scenes/fit.js";
import {dockExplore} from "../scenes/yourturn.js";

export const DOCK_VERSION = 1;
export const STORY_IONS = Object.freeze(["OVI", "HI"]);
export const VW = 300;                 // displayed half window (km/s); the ghost axis widens to GHOST_VW
export const GHOST_VW = 600, WINGS_LOGN = 18.5;
export const GLOW_KPC = 3;             // burn shine: depth gained over the last GLOW_KPC of path
const FONT = {label: '500 13px "Space Grotesk", system-ui, sans-serif', read: '400 12px "JetBrains Mono", ui-monospace, monospace',
  tick: '400 12px "JetBrains Mono", ui-monospace, monospace'};
const PX = {label: 13, read: 12, tick: 12};
const ROW = 18, TICK_ROW = 20, GUT = 44, PAD = 10, HEADER = 52, MIN_DIAL = 150;
const clamp = (x, a = 0, b = 1) => Math.min(b, Math.max(a, x));
const lerp = (a, b, t) => a + (b - a) * t;

/* ---------------- text measure (canvas when given; else a stable estimate for node) ---------------- */
export function measurer(ctx) {
  const cache = new Map();
  return (s, font) => {
    const k = font + "\u0000" + s; if (cache.has(k)) return cache.get(k);
    let w;
    if (ctx && ctx.measureText) { ctx.save(); ctx.font = font; w = ctx.measureText(s).width; ctx.restore(); }
    else { const px = +(/(\d+)px/.exec(font) || [0, 12])[1], mono = /Mono|monospace/.test(font); w = s.length * px * (mono ? 0.62 : 0.58); }
    w = Math.ceil(w * 1.04) + 2; cache.set(k, w); return w;
  };
}

/* ---------------- dock rect (from the shell's bands, interpolated through a dock transition) ---------------- */
export function dockRects(fs, env) {
  const w = env.w, h = env.h, cls = env.cls || layoutClass(w, h), ins = env.insets;
  const sp = fs.spec || {}, to = sp.dock || "strip", from = sp.dockFrom || to, mix = sp.dockMix == null ? 1 : clamp(sp.dockMix);
  const side = (fs.cam && fs.cam.textSide) || "left";
  const rTo = env.rect || computeBands(cls, w, h, {dock: to, textSide: side, insets: ins}).dock;
  const rFrom = from === to ? rTo : computeBands(cls, w, h, {dock: from, textSide: side, insets: ins}).dock;
  if (!rTo || !rFrom) return {drawn: rTo || rFrom, kidsRect: rTo || rFrom, kidsState: to, cls};
  const drawn = mix >= 1 ? rTo : {x: lerp(rFrom.x, rTo.x, mix), y: lerp(rFrom.y, rTo.y, mix), w: lerp(rFrom.w, rTo.w, mix), h: lerp(rFrom.h, rTo.h, mix)};
  // children live inside BOTH ends (the shell registers the target rect; the drawn rect is the interpolation)
  const small = rFrom.h * rFrom.w <= rTo.h * rTo.w ? from : to;
  const x0 = Math.max(rFrom.x, rTo.x), y0 = Math.max(rFrom.y, rTo.y), x1 = Math.min(rFrom.x + rFrom.w, rTo.x + rTo.w), y1 = Math.min(rFrom.y + rFrom.h, rTo.y + rTo.h);
  const kidsRect = mix >= 1 ? rTo : {x: x0, y: y0, w: Math.max(0, x1 - x0), h: Math.max(0, y1 - y0)};
  return {drawn, kidsRect, kidsState: mix >= 1 ? to : small, cls, target: rTo};
}

/* children of a morphing dock: keep only those inside the target rect (null: all) */
export function dockKidsInside(kids, tgt) {
  if (!tgt) return kids;
  const e = 0.5;
  return kids.filter(k => k.rect.x >= tgt.x - e && k.rect.y >= tgt.y - e && k.rect.x + k.rect.w <= tgt.x + tgt.w + e && k.rect.y + k.rect.h <= tgt.y + tgt.h + e);
}

/* ---------------- pure layout ---------------- */
/* panels: {<ion>: {x, y, w, h, v0, v1, role}}; kids: [{id, kind, rect, text?, font?, align?}] (CSS px, page frame) */
export function dockLayout(rect, state, o = {}) {
  const lead = o.lead || "OVI", other = lead === "OVI" ? "HI" : "OVI", m = o.measure || measurer(null);
  const ionName = k => `${K.ionName(k)} ${o.lam ? Math.round(o.lam[k]) : ""}`.trim();
  const panels = {}, kids = [], readouts = o.readouts || {}, hidden = [];
  if (!rect || rect.w < 60 || rect.h < 24) return {rect, state, top: rect ? rect.y : 0, panels, kids, header: null, hidden: (o.dials || []).length ? [{id: "dock:dials", reason: "no-room"}] : []};
  const narrow = rect.w < 520, gut = narrow ? 34 : GUT;
  const x = rect.x + gut, w = Math.max(10, rect.w - gut - PAD);
  let ticksOn = rect.h >= 70;
  // a dock too short for two ion rows falls back to the strip arrangement (phone landscape, short or zoomed screens)
  const need = 4 + 2 * (ROW + 2) + 2 * 22 + 6 + (ticksOn ? TICK_ROW + 2 : 4);
  const dg = dialGrid(rect.w - 2 * PAD, (o.dials || []).length, rect.h - need);
  const hdrNeed = dg.rows && !dg.oneRow && !dg.toggle ? ROW + 6 + dg.h + 16 : HEADER;
  const asked = state;
  if (state === "hero" && rect.h < need + hdrNeed) state = rect.h >= need ? "pair" : "strip";
  if (state === "pair" && rect.h < need) state = "strip";
  // fix3 ux M1: a hero dock too short for two panels and its dials (tiny phones at 150 %) keeps the dials as a one-row
  // toggle above a single lead panel (the other ion a spark line), ticks dropped; only below that is a drop recorded
  let heroStrip = false;
  if (asked === "hero" && state !== "hero" && (o.dials || []).length) {
    if (rect.h >= HEADER + ROW + 2 + 30 + 8 && dialGrid(rect.w - 2 * PAD, o.dials.length, HEADER).rows) { heroStrip = true; state = "strip"; ticksOn = false; }
    else hidden.push({id: "dock:dials", reason: "no-room"});
  }
  let y = rect.y + 4, bottom = rect.y + rect.h - (ticksOn ? TICK_ROW + 2 : 4);
  let header = null;
  const row = (ion, yy, wAvail) => {
    // label left, readout right (dropped when it would collide with the label)
    const lt = ionName(ion), lw = m(lt, FONT.label);
    kids.push({id: `label:${ion}`, kind: "dockLabel", rect: {x, y: yy, w: Math.min(lw, wAvail), h: ROW}, text: lt, font: FONT.label, ion, lead: ion === lead});
    let rt = readouts[ion]; if (!rt) return;
    // review2 ux H3: when the full readouts do not fit beside the label, use their short forms before dropping any (at 390 px
    // "fit: log N" used to vanish, losing the fit-vs-truth comparison B13 exists to make)
    const fitsAll = a => a.reduce((sum, t) => sum + m(t.text, FONT.read) + 14, -14) <= wAvail - lw - 12;
    if (!fitsAll(rt) && rt.some(t => t.short)) rt = rt.map(t => ({...t, text: t.short || t.text}));
    let rx = x + wAvail;
    for (let k = rt.length - 1; k >= 0; k--) {
      const t = rt[k], tw = m(t.text, FONT.read);
      if (rx - tw < x + lw + 12) break;
      rx -= tw;
      kids.push({id: `read:${ion}:${t.id}`, kind: "dockReadout", rect: {x: rx, y: yy, w: tw, h: ROW}, text: t.text, font: FONT.read, ion, color: t.color});
      rx -= 14;
    }
  };
  if (state === "hero" || heroStrip) {
    // header: mode readouts left and the dials (DOM) right on one row when they fit with ≥ 200 px to spare; else the
    // readouts on a short row and the dials on their own full-width row below (phones), each dial ≥ MIN_DIAL px wide
    // fix3 ux M1: when two dials do not fit side by side at MIN_DIAL each (phones < ~330 px), they stack one per full-width
    // row instead of disappearing; a dock too narrow even for one dial records a "dials:no-room" drop (G1 counts it)
    const hw = rect.w - 2 * PAD, nd = (o.dials || []).length, ht = o.headerReadouts || [];
    const g = dialGrid(hw, nd, heroStrip ? HEADER : rect.h - need), fullW = g.oneRow || g.toggle ? g.w : 0, oneRow = !nd || g.oneRow || g.toggle;
    const rowH = oneRow ? DIAL_SIZE.h : ht.length ? ROW + 6 : -4;   // no readouts left (B14): the dials start at the top
    let dialRect = null;
    if (nd && (g.oneRow || g.toggle)) dialRect = {x: rect.x + PAD + hw - fullW, y: rect.y + 4, w: fullW, h: DIAL_SIZE.h, rows: 1, toggle: g.toggle};
    else if (nd && g.rows) dialRect = {x: rect.x + PAD, y: rect.y + 4 + rowH + 4, w: hw, h: g.h, rows: g.rows};
    else if (nd) hidden.push({id: "dock:dials", reason: "no-room"});
    header = {x: rect.x + PAD, y: rect.y + 4, w: hw, h: rowH + (dialRect && !oneRow ? dialRect.h + 4 : 0)};
    let hx = header.x;
    const hxMax = header.x + header.w - (dialRect && oneRow ? fullW + 12 : 0);
    for (const t of ht) {
      const tw = m(t.text, FONT.read);
      if (hx + tw > hxMax) break;
      kids.push({id: `head:${t.id}`, kind: "dockReadout", rect: {x: hx, y: header.y + (rowH - ROW) / 2, w: tw, h: ROW}, text: t.text, font: FONT.read, color: t.color});
      hx += tw + 16;
    }
    if (dialRect) { const {rows, toggle, ...r} = dialRect; kids.push({id: "dials", kind: "dockDials", rect: r, dom: true, n: nd, rows, toggle: !!toggle}); }
    y = header.y + header.h + 8;
  }
  if (state === "strip") {
    row(lead, y, w); y += ROW + 2;
    panels[lead] = {x, y: y + 4, w, h: Math.max(8, bottom - y - 4), v0: -VW, v1: VW, role: "lead"};
    panels[other] = {x, y, w, h: 3, v0: -VW, v1: VW, role: "spark"};
  } else {
    // review SC-8: a fixed panel order (O VI on top, H I below) and a fixed split, so a lead change at a beat boundary never
    // swaps the panels; the lead is marked by emphasis (label weight, the other panel dimmed), not by position or size
    const avail = bottom - y - 2 * (ROW + 2) - 6;
    const top = STORY_IONS.includes(lead) && STORY_IONS.includes(other) ? STORY_IONS[0] : lead, bot = top === lead ? other : lead;
    const ht = Math.max(10, avail * (state === "hero" ? 0.6 : 0.5)), hb = Math.max(8, avail - ht);
    row(top, y, w); y += ROW + 2;
    panels[top] = {x, y, w, h: ht, v0: -VW, v1: VW, role: top === lead ? "lead" : "other"}; y += ht + 6;
    row(bot, y, w); y += ROW + 2;
    panels[bot] = {x, y, w, h: hb, v0: -VW, v1: VW, role: bot === lead ? "lead" : "other"};
  }
  if (ticksOn) kids.push({id: "ticks", kind: "dockTicks", rect: {x: x - 14, y: rect.y + rect.h - TICK_ROW - 1, w: w + 14 + Math.min(PAD - 2, 8), h: TICK_ROW}, font: FONT.tick});
  if (state !== "strip" && gut >= 34) {
    const ps = Object.values(panels), pTop = Math.min(...ps.map(P => P.y)), pBot = Math.max(...ps.map(P => P.y + P.h));
    const y0 = Math.max(rect.y, pTop - 8), y1 = Math.min(rect.y + rect.h - (ticksOn ? TICK_ROW + 2 : 0), pBot + 8);
    if (y1 - y0 > 2 * ROW) kids.push({id: "yticks", kind: "dockTicks", rect: {x: rect.x + 2, y: y0, w: gut - 6, h: y1 - y0}, font: FONT.tick});
  }
  // ghost-axis and wings labels (B10): bottom-right inside the panel of the ghost's ion
  for (const g of o.ghostLabels || []) {
    const P = panels[g.ion]; if (!P || P.role === "spark") continue;
    const tw = m(g.text, FONT.read), id = `ghost:${g.id}`;
    // bottom right, the axis note lowest and the wings note above it (the ghost sits on the continuum there)
    const yy = g.id === "wings" ? P.y + P.h - 2 * ROW - 4 : P.y + P.h - ROW - 2;
    if (tw < P.w * 0.6 && P.h >= ROW * (g.id === "wings" ? 3 : 2) + 4) kids.push({id, kind: "dockReadout", rect: {x: P.x + P.w - tw - 4, y: yy, w: tw, h: ROW}, text: g.text, font: FONT.read, color: g.color, ion: g.ion});
  }
  // drop kids that collide (later = lower priority), so the registered set never overlaps itself
  const out = [];
  for (const k of kids) if (!out.some(q => overlap(q.rect, k.rect) > 0.5)) out.push(k);
  return {rect, state, top: rect.y, panels, kids: out, header, hidden, heroStrip};
}
/* dial arrangement for a header hw px wide with hAvail px of the dock left above the ion rows, in order of preference:
   oneRow   the nd dials (DIAL_SIZE.w each) on the header row with >= 200 px to spare for the readouts (desktop)
   below    readouts on a short row, the dials side by side on a full-width row below, each >= MIN_DIAL px
   stacked  readouts row, then one dial per full-width row (narrow phones, when the dock is tall enough)
   toggle   one dial plus an R | S/N switch on the header row, the readouts dropped (short or very narrow docks)
   rows 0 = no room even for the toggle (the caller records a "dock:dials" no-room drop) */
export const MIN_TOGGLE_DIAL = 80;   // below 110 px the value text hides (it stays in the tooltip and aria-valuetext)
export function dialGrid(hw, nd, hAvail = Infinity) {
  if (!nd) return {rows: 0, oneRow: false, w: 0, h: 0, perRow: 0};
  const fullW = nd * DIAL_SIZE.w + (nd - 1) * 8, hdr = h => ROW + 6 + h + 16;
  if (hw - fullW >= 200) return {rows: 1, oneRow: true, w: fullW, h: DIAL_SIZE.h, perRow: nd};
  if ((hw - (nd - 1) * 8) / nd >= MIN_DIAL && hAvail >= hdr(DIAL_SIZE.h)) return {rows: 1, oneRow: false, w: hw, h: DIAL_SIZE.h, perRow: nd};
  const hs = nd * DIAL_SIZE.h + (nd - 1) * 4;
  if (hw >= MIN_DIAL && hAvail >= hdr(hs)) return {rows: nd, oneRow: false, w: hw, h: hs, perRow: 1};
  if (nd > 1 && hw - TOGGLE_W - 6 >= MIN_TOGGLE_DIAL && hAvail >= HEADER) return {rows: 1, oneRow: false, toggle: true, w: hw, h: DIAL_SIZE.h, perRow: 1};
  if (nd === 1 && hw >= MIN_TOGGLE_DIAL && hAvail >= HEADER) return {rows: 1, oneRow: true, w: Math.min(hw, DIAL_SIZE.w), h: DIAL_SIZE.h, perRow: 1};
  return {rows: 0, oneRow: false, w: 0, h: 0, perRow: 0};
}
export {MIN_DIAL};
function overlap(a, b) {
  const w = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x), h = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
  return w > 0 && h > 0 ? w * h : 0;
}

/* ---------------- frame model (pure: what to draw, numbers included) ---------------- */
const pct = x => `${Math.round(100 * x)} %`;
const kmsInt = v => `${v < 0 ? "−" : v > 0 ? "+" : ""}${Math.abs(Math.round(v))} km/s`;
const groupInt = v => String(Math.round(v)).replace(/\B(?=(\d{3})+(?!\d))/g, " ");
export function ghostOf(fs, data) {
  for (const e of fs.eqs || []) {
    if (!e.ghost || !e.anchor || e.anchor.kind !== "cell" || !Number.isFinite(+e.anchor.ref)) continue;
    const term = e.ghost.term, ion = term === "N" ? "HI" : (fs.spec && fs.spec.lead) || "OVI";
    const s = term === "T" ? Math.log10(e.ghost.value) : +e.ghost.value;
    try {
      const g = ghostCell(data, data.fion || null, {eq: e.id, term, ion, idx: +e.anchor.ref, s});
      return {...g, ion};
    } catch (_) { /* an equation without a ghost form: nothing to draw */ }
  }
  return null;
}
/* the numbers of one frame (node-testable; the readouts are computed values, never typed copy) */
export function frameModel(fs, data, T, o = {}) {
  const sp = fs.spec || {mode: "intrinsic", dock: "strip"}, lead = sp.lead || "OVI", other = lead === "OVI" ? "HI" : "OVI";
  const mode = sp.mode || "intrinsic", out = {mode, lead, other, readouts: {}, headerReadouts: [], ghostLabels: [], ions: {}, ghost: null};
  if (mode === "intrinsic") {
    for (const k of [lead, other]) {
      const S = T[k]; if (!S) continue;
      const tau = S.tauAt(fs.l, o.buf && o.buf[k]);
      const prev = S.tauAt(fs.l - GLOW_KPC, o.buf2 && o.buf2[k]);
      let cell = null;
      if (fs.cell && Number.isFinite(fs.cell.idx)) { const w = S.weight(fs.cell.idx, fs.l); if (w > 0) cell = {idx: fs.cell.idx, w}; }
      let mn = Infinity, jm = 0; const lo = Math.round(-VW - S.grid0), hi = Math.round(VW - S.grid0);
      for (let j = Math.max(0, lo); j <= Math.min(S.N - 1, hi); j++) if (tau[j] > -Infinity && Math.exp(-tau[j]) < mn) { mn = Math.exp(-tau[j]); jm = j; }
      const frac = S.fracAt(fs.l);
      out.ions[k] = {tau, prev, cell, minF: mn, minV: S.grid0 + jm, frac};
      if (Number.isFinite(frac)) out.readouts[k] = [{id: "way", text: `gas crossed ${pct(frac)}`}];   // review M6 (fix1 r4: "crossed" = share of the column already behind the probe): column behind the probe, not light blocked
    }
    const g = ghostOf(fs, data);
    if (g) {
      out.ghost = g;
      const pr = ghostProfile(data, g.ion, g.cell);
      out.ghost.profile = pr;
      out.readouts[g.ion] = [{id: "gdepth", text: `ghost depth ${pct(pr.depth)}`, color: K.ionColor(g.ion)}, {id: "gwidth", text: `width ${Math.round(pr.width)} km/s`, color: K.ionColor(g.ion)}];
      if (g.wings) { out.ghostLabels.push({id: "axis", ion: g.ion, text: `ghost axis ±${GHOST_VW} km/s`, color: K.ionColor(g.ion)});
        out.ghostLabels.push({id: "wings", ion: g.ion, text: "damping wings", color: K.ionColor(g.ion)}); }
    }
  } else if (mode === "observed") {
    const sn = Number.isFinite(sp.sn) ? sp.sn : 0, noisy = sn > 0 && sn < 500;
    const R = noisy ? (Number.isFinite(sp.R) ? sp.R : 30000) : quantR(Number.isFinite(sp.R) ? sp.R : 30000);
    const dvPix = K.C_KMS / R / PIX_PER_RESEL;
    out.R = R; out.sn = sn;
    out.headerReadouts.push({id: "R", text: `R ${groupInt(R)}`}, {id: "blur", text: `blur ${(K.C_KMS / R).toFixed(1)} km/s`});
    if (noisy) out.headerReadouts.push({id: "sn", text: `S/N ${sn >= 10 ? Math.round(sn) : sn.toFixed(1)}`}, {id: "pix", text: `pixel ${dvPix.toFixed(1)} km/s`});
    for (const k of [lead, other]) {
      const seed = K.caseSeed(Number.isFinite(sp.seed) ? sp.seed : 0, k, 0);
      const ob = noisy ? observedSN(data, k, R, sn, seed) : observedR(data, k, R);
      if (!ob) continue;
      let m = 0; for (let i = 1; i < ob.v.length; i++) if (Math.abs(ob.v[i]) < VW && ob.model[i] < ob.model[m]) m = i;
      out.ions[k] = {obs: ob, noisy, darkest: ob.model[m], darkV: ob.v[m], R, sn, dvPix};
      out.readouts[k] = [{id: "dark", text: `darkest point lets ${pct(ob.model[m])} through`, short: `darkest ${pct(ob.model[m])} light`}];
      if (noisy && k === lead) out.readouts[k].unshift({id: "sigma", text: `noise per pixel ${ob.sigma.toFixed(2)}`});
    }
  } else if (mode === "fit" || mode === "explore") {
    let R = Number.isFinite(sp.R) ? sp.R : 30000, sn = Number.isFinite(sp.sn) ? sp.sn : 10;
    // review M8: during the fit beat's "cases" phase the header shows the case's own R and S/N (the stored fit drawn), not the dials'
    if (mode === "fit" && fitPhase((fs.beat && fs.beat.u) || 0) === "cases") {
      const pk = K.picks(data), u = (fs.beat && fs.beat.u) || 0, inv = pk.invented && u >= FIT_PHASES.cases + 0.5 * (1 - FIT_PHASES.cases);
      const cf = inv ? pk.invented.fit : pk.broad ? pk.broad.fit : null;
      if (cf && Number.isFinite(+cf.R)) R = +cf.R; if (cf && Number.isFinite(+cf.snr)) sn = +cf.snr;
      out.caseOwn = !!cf;
    }
    out.headerReadouts.push({id: "R", text: `R ${groupInt(R)}`}, {id: "sn", text: `S/N ${sn >= 10 ? Math.round(sn) : sn.toFixed(1)}`});
    out.R = R; out.sn = sn;
    if (mode === "fit") {
      const ph = fitPhase((fs.beat && fs.beat.u) || 0), pk = K.picks(data), s0 = pk.seeds && pk.seeds[0];
      out.phase = ph;
      if (ph === "totals" && s0) {
        const I = K.ion(data, lead);
        out.readouts[lead] = [{id: "fitN", text: `fit: log N ${K.totalLogN(s0.comps).toFixed(2)}`, short: `fit ${K.totalLogN(s0.comps).toFixed(2)}`},
          {id: "trueN", text: `all cells: log N ${I.totals.logN.toFixed(2)}`, short: `cells ${I.totals.logN.toFixed(2)}`, color: K.ionColor(lead)}];
      } else if (ph === "draws" && pk.seeds.length) {
        const n = pk.seeds.length, i = Math.min(n - 1, Math.floor(clamp(((fs.beat && fs.beat.u) || 0) / FIT_PHASES.totals) * n));
        out.readouts[lead] = [{id: "draw", text: `noisy try ${i + 1} of ${n}`, short: `try ${i + 1}/${n}`}, {id: "ncomp", text: `${pk.seeds[i].comps.length} components`, short: `${pk.seeds[i].comps.length} comp.`}];
      } else if (ph === "landing") {
        out.readouts[lead] = [{id: "crest", text: `${crestComps(data, lead).length} noiseless components`}];
      } else if (ph === "cases") {
        const u = (fs.beat && fs.beat.u) || 0, inv = pk.invented && u >= FIT_PHASES.cases + 0.5 * (1 - FIT_PHASES.cases);
        if (inv) out.readouts[lead] = [{id: "inv", text: `width ${pk.invented.comp.b.toFixed(1)} km/s, narrower than the blur`, color: K.COL.accent}];
        else if (pk.broad) out.readouts[lead] = [{id: "broad", text: `width ${Math.round(pk.broad.comp.b)} km/s at S/N ${pk.broad.fit.snr}`, color: K.COL.accent}];
      }
    }
  }
  out.dials = visibleFor(fs);
  // beauty M4 (fix3): one vocabulary. A quantity with a dial on screen is named by the dial ("sharpness", "exposure"; R and
  // S/N in its tooltip), so the header drops its own R / S/N readout; the fit "cases" phase keeps the case's own values
  out.headerShown = out.caseOwn ? out.headerReadouts : out.headerReadouts.filter(t => !out.dials.includes(t.id));
  return out;
}

/* ---------------- the dock ---------------- */
export function createSpectrum(o = {}) {
  const doc = o.doc || (o.parent && o.parent.ownerDocument) || (typeof document !== "undefined" ? document : null);
  const bus = o.bus || null;
  let data = o.data || null, T = {}, readyP = null, last = null, lastKids = [], lastLinks = [], lastModel = null, cv = null, ctx = o.ctx || null, hit = null, dials = null;
  const fitCache = new Map(); let fitWorker = o.fitWorker || null, reqN = 0;
  const bufs = {OVI: null, HI: null}, bufs2 = {OVI: null, HI: null};
  let brush = null, hover = null;

  if (doc && o.parent && !ctx) {
    cv = doc.createElement("canvas"); cv.className = "spec-dock"; cv.setAttribute("aria-hidden", "true");
    Object.assign(cv.style, {position: "absolute", left: "0", top: "0", width: "100%", height: "100%", pointerEvents: "none"});
    o.parent.appendChild(cv); ctx = cv.getContext("2d");
    hit = doc.createElement("div"); hit.className = "spec-hit"; hit.setAttribute("data-noscrub", "");
    Object.assign(hit.style, {position: "absolute", left: "0", top: "0", width: "0", height: "0", pointerEvents: "auto", touchAction: "pinch-zoom", cursor: "crosshair"});
    o.parent.appendChild(hit);
    if (o.dials !== false) dials = createDials(o.parent, {bus, doc});
    wirePointer();
  }
  if (bus) bus.on("brush", b => { brush = b && b.source !== "dock" ? b : brush; if (!b) brush = null; });

  function wirePointer() {
    let down = null;
    const at = e => {
      if (!last || !last.layout) return null;
      const r = hit.getBoundingClientRect(), px = e.clientX - r.left + last.drawn.x, py = e.clientY - r.top + last.drawn.y;
      for (const [ion, P] of Object.entries(last.layout.panels)) if (P.role !== "spark" && px >= P.x && px <= P.x + P.w && py >= P.y - ROW && py <= P.y + P.h + 4)
        return {ion, v: P.v0 + (px - P.x) / P.w * (P.v1 - P.v0)};
      return null;
    };
    hit.addEventListener("pointerdown", e => { const a = at(e); if (!a) return; down = a; hit.setPointerCapture && hit.setPointerCapture(e.pointerId); e.stopPropagation(); });
    hit.addEventListener("pointermove", e => {
      const a = at(e);
      if (down && a && a.ion === down.ion) { brush = {ion: a.ion, v0: Math.min(down.v, a.v), v1: Math.max(down.v, a.v), source: "dock"}; if (bus) bus.emit("brush", brush); }
      else if (!down && a && T[a.ion] && last && last.fs && last.fs.spec.mode === "intrinsic") {
        const j = Math.round(a.v - T[a.ion].grid0), c = T[a.ion].cellsAtBin(last.fs.l, j, j, 0.25)[0] || null;
        const h = c ? {cellIdx: c.idx, ion: a.ion, v: a.v} : null;
        if ((h && h.cellIdx) !== (hover && hover.cellIdx)) { hover = h; if (bus) bus.emit("hover", h); }
      }
    });
    const end = e => { if (down && brush && brush.v1 - brush.v0 < 2) { brush = null; if (bus) bus.emit("brush", null); } down = null; e.stopPropagation(); };
    hit.addEventListener("pointerup", end); hit.addEventListener("pointercancel", end);
    hit.addEventListener("pointerleave", () => { if (hover) { hover = null; if (bus) bus.emit("hover", null); } });
  }

  /* idle warm-up of the B12a blur memo (lsf.js warmObservedR): ≤ 4 ms slices, one per idle callback, after ready() */
  function warmIdle() {
    const d = data, ions = STORY_IONS.filter(k => d && d.ions && d.ions[k]);
    const idle = typeof requestIdleCallback === "function" ? f => requestIdleCallback(f, {timeout: 200}) : f => setTimeout(f, 16);
    const step = () => { if (data !== d) return; if (!warmObservedR(d, ions, 4, () => performance.now())) idle(step); else api.warmed = true; };
    idle(step);
  }
  function buildSync() { for (const k of STORY_IONS) if (data.ions && data.ions[k]) T[k] = decorate(tauSumFromData(data, k), data); }
  function decorate(S, d) { const g = (d.meta && d.meta.grid) || {V0: -400}; S.grid0 = +g.V0; return S; }

  const api = {
    get data() { return data; },
    get tau() { return T; },
    /* build the τ caches; o.worker (a Worker running tauworker.js) keeps the main thread free */
    ready() {
      if (readyP) return readyP;
      readyP = (async () => {
        if (!data) throw new Error("spectrum: no data");
        const w = o.worker;
        if (!w) { buildSync(); return api; }
        const reqId = "tau" + (++reqN);
        const ions = STORY_IONS.filter(k => data.ions && data.ions[k]).map(k => ionInputs(data, k));
        const msg = {type: "build", reqId, geometry: {cells: data.geometry.cells, kernel_cdf: data.geometry.kernel_cdf}, grid: data.meta.grid, ions};
        await new Promise((res, rej) => {
          let left = ions.length;
          const on = e => {
            const m = e.data || {}; if (m.reqId !== reqId) return;
            if (m.type === "error") { w.removeEventListener("message", on); rej(new Error(m.message)); return; }
            T[m.ion] = decorate(tauSumFromBuffers(data, m), data);
            if (--left === 0) { w.removeEventListener("message", on); res(); }
          };
          w.addEventListener("message", on);
          // a worker that fails to load (or throws outside the protocol) must not leave ready() hanging
          w.addEventListener("error", e => { w.removeEventListener("message", on); rej(new Error((e && e.message) || "tauworker error")); }, {once: true});
          w.postMessage(msg, ions.flatMap(i => [i.logN.buffer, i.V.buffer, i.b.buffer, i.a.buffer]));
        }).catch(err => { if (typeof console !== "undefined") console.warn("tauworker failed, building on the main thread:", err); buildSync(); });
        return api;
      })();
      if (doc && o.warm !== false) readyP.then(warmIdle, () => {});
      return readyP;
    },
    setData(d) { data = d; T = {}; readyP = null; fitCache.clear(); return api.ready(); },
    render(fs, env = {}) {
      if (!data || !fs) return null;
      const w = env.w || (cv ? cv.clientWidth : 0), h = env.h || (cv ? cv.clientHeight : 0), dpr = env.dpr || 1;
      if (cv) { const W = Math.round(w * dpr), H = Math.round(h * dpr); if (cv.width !== W || cv.height !== H) { cv.width = W; cv.height = H; } }
      const R = dockRects(fs, {...env, w, h});
      for (const k of STORY_IONS) if (T[k]) { if (!bufs[k]) bufs[k] = new Float64Array(T[k].N); if (!bufs2[k]) bufs2[k] = new Float64Array(T[k].N); }
      const model = frameModel(fs, data, T, {buf: bufs, buf2: bufs2});
      const lam = {OVI: data.ions.OVI ? data.ions.OVI.atom.lam0_A : 1032, HI: data.ions.HI ? data.ions.HI.atom.lam0_A : 1216};
      const meas = measurer(ctx);
      const base = {lead: model.lead, lam, measure: meas, readouts: model.readouts, headerReadouts: model.headerShown || model.headerReadouts, dials: model.dials, ghostLabels: model.ghostLabels};
      const layout = dockLayout(R.drawn, R.kidsState === (fs.spec && fs.spec.dock) ? fs.spec.dock : R.kidsState, base);
      // review H1: panels, labels and readouts all follow ONE geometry (the drawn rect), so text never lags the plot during
      // a dock morph. The children registered with the solver are exactly the drawn ones; while the box morphs, a child that
      // falls outside the target rect (the shell's dock container) is hidden until the morph ends (shrinking hero -> strip).
      const hidden = env.hidden ? new Set(env.hidden) : null;
      const kids = dockKidsInside(layout.kids, R.kidsRect === R.drawn ? null : R.target).filter(k => !hidden || !hidden.has(k.id) && !hidden.has("dock:" + k.id));
      const geom = {rect: R.drawn, top: R.drawn ? R.drawn.y : h, panels: layout.panels, vw: w, vh: h};
      const links = [];
      if (env.project) {
        const c = connector(fs, data, geom, env.project); if (c) links.push(c);
        links.push(...tethers(fs, data, geom, env.project));
      }
      last = {fs, drawn: R.drawn, layout, kids, links, model, w, h, dpr, cls: R.cls};
      lastKids = kids; lastLinks = links; lastModel = model;
      if (hit && R.drawn) Object.assign(hit.style, {transform: `translate(${Math.round(R.drawn.x)}px, ${Math.round(R.drawn.y)}px)`, width: Math.round(R.drawn.w) + "px", height: Math.round(R.drawn.h) + "px"});
      if (dials) { const dk = kids.find(k => k.id === "dials"); dials.update(fs, dk ? {x: dk.rect.x + dk.rect.w, y: dk.rect.y, w: dk.rect.w, rows: dk.rows || 1, toggle: !!dk.toggle} : null, {R: model.R, sn: model.sn}); }
      if (ctx) draw(fs, env, layout, kids, links, model, R, dpr);
      if (model.mode === "explore") requestFit(model);
      return last;
    },
    rects() {
      const out = lastKids.filter(k => !k.dom || !dials).map(k => ({id: k.id, kind: k.kind, rect: {...k.rect}}));
      if (dials) out.push(...dials.rects());
      for (const L of lastLinks) out.push({id: `${L.id}:end`, kind: "linkEnd", exempt: true, rect: {x: L.b.x - 3, y: L.b.y - 3, w: 6, h: 6}});
      return out;
    },
    kids() { return api.rects().filter(r => !r.exempt).map(r => ({id: r.id, rect: r.rect, kind: r.kind})); },
    /* fix3 ux M1: controls this frame should show but had no room for ([{id, reason}]; G1 fails on any) */
    dropped() { return last && last.layout && last.fs && visibleFor(last.fs).length ? (last.layout.hidden || []).slice() : []; },
    connectors() { return lastLinks.slice(); },
    corridors(r = 10) { return linkCorridors(lastLinks, r); },
    model: () => lastModel,
    /* the dock's GL scrim for stage.setScrims (S0: the stage's post pass darkens HDR colour before the shoulder; viewport
       fractions, y down). Pair with createSpectrum({scrim: false}) so the canvas fallback is not drawn on top. */
    scrim(k = o.scrimK ?? DOCK_SCRIM_K) { return last && last.drawn ? dockScrim(last.drawn, last.w, last.h, k) : null; },
    describe(fs) {
      const m = frameModel(fs, data, T, {});
      if (m.mode === "intrinsic") {
        const a = m.ions[m.lead]; if (!a) return "";
        return `${K.ionName(m.lead)}: ${pct(1 - a.minF)} of the light taken at its deepest point, near ${kmsInt(a.minV)}; ${Number.isFinite(a.frac) ? pct(a.frac) + " of its gas is behind the probe" : ""}.`;
      }
      if (m.mode === "observed") { const a = m.ions[m.lead]; return a ? `Resolving power ${groupInt(a.R)}${a.noisy ? `, signal to noise ${Math.round(a.sn)}` : ""}: the darkest point lets ${pct(a.darkest)} of the light through.` : ""; }
      return `Fitting the spectrum at resolving power ${groupInt(m.R)} and signal to noise ${Math.round(m.sn)}.`;
    },
    destroy() { if (cv) cv.remove(); if (hit) hit.remove(); if (dials) dials.destroy(); },
  };

  /* ---------------- live fit (B14 explore; never in seek) ---------------- */
  function requestFit(model) {
    if (!fitWorker && o.fitWorkerUrl && typeof Worker !== "undefined") {
      try { fitWorker = new Worker(o.fitWorkerUrl, {type: "module"}); fitWorker.addEventListener("message", onFit); } catch (_) { fitWorker = null; }
    } else if (fitWorker && !fitWorker.__specWired) { fitWorker.addEventListener("message", onFit); fitWorker.__specWired = true; }
    if (!fitWorker) return;
    const key = fitKey(model.lead, model.R, model.sn, last.fs.spec.seed || 0);
    if (fitCache.has(key)) return;
    fitCache.set(key, null);
    const req = K.fitRequest(data, model.lead, model.R, model.sn, last.fs.spec.seed || 0, 0);
    fitWorker.postMessage({type: "story-fit", reqId: key, req});
  }
  function onFit(e) { const m = e.data || {}; if (m.type === "story-result" && fitCache.has(m.reqId)) fitCache.set(m.reqId, m.result); }
  const fitKey = (ion, R, sn, seed) => `${ion}|${Math.round(R)}|${(+sn).toFixed(2)}|${seed}`;

  /* ---------------- drawing ---------------- */
  function panelMap(P, fsPx, yLo = 0, yHi = 1.08, v0 = P.v0, v1 = P.v1) {
    const Fr = {ctx, W: last.w, H: last.h, dpr: last.dpr, port: false, fs: fsPx, physics: false, reduced: false, box: {x: P.x, y: P.y, w: P.w, h: P.h}};
    return K.axesMap(Fr, v0, v1, yLo, yHi);
  }
  function draw(fs, env, layout, kids, links, model, R, dpr) {
    const c = ctx; c.setTransform(dpr, 0, 0, dpr, 0, 0); c.clearRect(0, 0, last.w, last.h);
    if (!R.drawn) return;
    const rect = R.drawn, fsPx = 14;
    // scrim (canvas fallback; the stage's GL scrim replaces it with scrim: false)
    if (o.scrim !== false) {
      const g = c.createLinearGradient(0, rect.y - 28, 0, rect.y + rect.h);
      g.addColorStop(0, "rgba(5,7,13,0)"); g.addColorStop(28 / (rect.h + 28), "rgba(5,7,13,0.9)"); g.addColorStop(1, "rgba(5,7,13,0.95)");
      c.fillStyle = g; c.fillRect(rect.x, rect.y - 28, rect.w, rect.h + 28);
    }
    c.strokeStyle = "rgba(236,240,255,0.14)"; c.lineWidth = 1; c.beginPath(); c.moveTo(rect.x, Math.round(rect.y) + 0.5); c.lineTo(rect.x + rect.w, Math.round(rect.y) + 0.5); c.stroke();
    // links (under the dock text, over the stage)
    for (const L of links) drawLink(L);
    const env2 = {data, fs, model, T, brush, hover, fitResult: model.mode === "explore" ? fitCache.get(fitKey(model.lead, model.R, model.sn, fs.spec.seed || 0)) : null};
    for (const [ion, P] of Object.entries(layout.panels)) {
      const yTop = panelTop(model, ion, P);
      const A = panelMap(P, fsPx, model.mode === "observed" || model.mode === "fit" || model.mode === "explore" ? -0.1 : 0, yTop);
      gridLines(A, P);
      const pe = {...env2, ion, role: P.role, panel: P};
      if (model.mode === "intrinsic") {
        dockSum(A, pe);
        if (fs.beat && fs.beat.kind === "stop" && ion === model.lead) dockCell(A, pe);
        if (model.ghost && model.ghost.ion === ion && P.role !== "spark") {
          const wide = model.ghost.wings, GA = wide ? panelMap(P, fsPx, 0, 1.08, -GHOST_VW, GHOST_VW) : A;
          dockGhost(GA, {...pe, ghost: model.ghost});
        }
      } else if (model.mode === "observed") {
        if (model.ions[ion]) (model.ions[ion].noisy ? dockNoise : dockLSF)(A, {...pe, obs: model.ions[ion]});
      } else if (model.mode === "fit") dockFit(A, {...pe, u: fs.beat.u});
      else if (model.mode === "explore") dockExplore(A, pe);
      if (brush && brush.ion === ion && P.role !== "spark") { c.save(); c.fillStyle = "rgba(143,168,255,0.14)"; c.fillRect(A.X(brush.v0), P.y, Math.max(1, A.X(brush.v1) - A.X(brush.v0)), P.h); c.restore(); }
    }
    for (const k of kids) drawKid(k, layout);
  }
  /* y-range top per panel: 1.08 intrinsic; noisy observed panels make room for their noise (review M5), else 1.2 */
  function panelTop(model, ion, P) {
    if (model.mode === "intrinsic") return 1.08;
    const o = model.ions && model.ions[ion];
    if (model.mode === "observed" && o && o.noisy && o.obs) return noiseTop(noiseBin(P, o.obs).sigma);
    if ((model.mode === "explore" || model.mode === "fit") && model.sn > 0) {
      const sig = Math.sqrt(PIX_PER_RESEL) / model.sn, dv = K.C_KMS / (model.R || 30000) / PIX_PER_RESEL;
      return noiseTop(noiseBin(P, {v: [0, dv], sigma: sig}).sigma);
    }
    return 1.2;
  }
  function gridLines(A, P) {
    if (P.role === "spark") return;
    const c = ctx; c.save(); c.strokeStyle = "rgba(236,240,255,0.08)"; c.lineWidth = 1;
    for (const f of [0, 1]) { const y = Math.round(A.Y(f)) + 0.5; c.beginPath(); c.moveTo(P.x, y); c.lineTo(P.x + P.w, y); c.stroke(); }
    c.setLineDash([2, 4]); const x0 = Math.round(A.X(0)) + 0.5; c.beginPath(); c.moveTo(x0, P.y); c.lineTo(x0, P.y + P.h); c.stroke(); c.restore();
  }
  function drawKid(k, layout) {
    const c = ctx;
    if (k.kind === "dockTicks") return drawTicks(k, layout);
    if (!k.text) return;
    c.save(); c.font = k.font; c.textBaseline = "middle"; c.textAlign = "left";
    c.fillStyle = k.kind === "dockLabel" ? K.ionColor(k.ion) : k.color || K.COL.ink;
    if (k.kind === "dockLabel" && k.lead === false) c.globalAlpha = 0.72;
    c.fillText(k.text, k.rect.x, k.rect.y + k.rect.h / 2 + 1); c.restore();
  }
  function drawTicks(k, layout) {
    const c = ctx, lead = layout.panels[last.model.lead] || Object.values(layout.panels)[0]; if (!lead) return;
    c.save(); c.font = k.font; c.fillStyle = K.COL.muted; c.textBaseline = "middle";
    if (k.id === "ticks") {
      const step = lead.w < 360 ? 200 : 100, y = k.rect.y + k.rect.h / 2 + 1;
      c.textAlign = "center";
      const unit = "km/s", uw = c.measureText(unit).width, xu = k.rect.x + k.rect.w - 2;
      for (let v = Math.ceil(lead.v0 / step) * step; v <= lead.v1; v += step) {
        if (Math.abs(v) >= Math.max(Math.abs(lead.v0), Math.abs(lead.v1))) continue;      // no labels at the panel ends
        const x = panelX(lead, v), s = v === 0 ? "0" : (v < 0 ? "−" : "+") + Math.abs(v);
        const tw = c.measureText(s).width;
        if (x - tw / 2 < k.rect.x + 16 || x + tw / 2 > xu - uw - 10) continue;
        c.fillText(s, x, y);
      }
      c.textAlign = "right"; c.fillText(unit, xu, y);
    } else {
      c.textAlign = "right";
      for (const P of Object.values(layout.panels)) {
        if (P.role === "spark" || P.h < 30) continue;
        const yHi = panelTop(last.model, Object.keys(layout.panels).find(k => layout.panels[k] === P), P), yLo = last.model.mode === "intrinsic" ? 0 : -0.1;
        for (const f of P.h >= 60 ? [0, 0.5, 1] : [0, 1]) c.fillText(f === 1 && k.rect.w >= 38 ? "100 %" : `${Math.round(f * 100)}`, k.rect.x + k.rect.w - 2, P.y + (yHi - f) / (yHi - yLo) * P.h);
      }
    }
    c.restore();
  }
  function drawLink(L) {
    const c = ctx; c.save();
    const col = L.ion ? K.ionColor(L.ion) : "rgba(236,240,255,0.9)";   // review M1: tethers in their ion's colour too
    c.globalAlpha = clamp(L.alpha) * (L.kind === "connector" ? 0.9 : 0.6); c.strokeStyle = col; c.lineWidth = L.kind === "connector" ? 1.6 : 1.1;
    c.beginPath(); c.moveTo(L.a.x, L.a.y); c.bezierCurveTo(L.c1.x, L.c1.y, L.c2.x, L.c2.y, L.b.x, L.b.y); c.stroke();
    c.fillStyle = col; c.beginPath(); c.arc(L.b.x, L.b.y, 2.5, 0, 2 * Math.PI); c.fill();
    // review2 three_d T2: the B9 pair cells get a ring where they sit in 3D (both tethers end on the one shared dip)
    if (L.pair) { c.globalAlpha = clamp(L.alpha); c.lineWidth = 1.6; c.beginPath(); c.arc(L.a.x, L.a.y, 7, 0, 2 * Math.PI); c.stroke(); }
    c.restore();
  }
  return api;
}

/* the τ sums of the story ions, synchronously (node, tests, pages without workers) */
export function tauSet(data) {
  const T = {}, g = (data.meta && data.meta.grid) || {V0: -400};
  for (const k of STORY_IONS) if (data.ions && data.ions[k]) { T[k] = tauSumFromData(data, k); T[k].grid0 = +g.V0; }
  return T;
}

/* GL scrim rect for the dock (stage.setScrims form). post.js feathers every scrim edge over ±4 % of the viewport,
   centred on the edge, so the rect is grown by that margin: full strength starts exactly at the dock's top rule and
   covers the panel ends; the top feather (the dock's 28 px canvas gradient in the fallback) sits above it. k: S0 froze
   stage_scrimK = 0.75 for the text band; the dock measured on A100 frames (U_spec.md §3) uses DOCK_SCRIM_K. */
export const SCRIM_EDGE = 0.04;
export const DOCK_SCRIM_K = 0.9;
export function dockScrim(rect, w, h, k = DOCK_SCRIM_K) {
  if (!rect || !(w > 0) || !(h > 0)) return null;
  const e = SCRIM_EDGE, f = x => Math.round(x * 1e4) / 1e4;
  return {x0: f(rect.x / w - e), x1: f((rect.x + rect.w) / w + e), y0: f(rect.y / h - e), y1: f((rect.y + rect.h) / h + e), k};
}

/* the fixed list of dock kinds the shell may see (tests, U_qa) */
export const KID_KINDS = Object.freeze(["dockLabel", "dockReadout", "dockTicks", "dockDials", "dial", "linkEnd"]);
