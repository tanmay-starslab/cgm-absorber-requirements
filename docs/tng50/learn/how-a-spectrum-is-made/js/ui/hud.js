// HUD and the shell composer (DESIGN_final §1.3 P1-3, P0-6, P0-7; §3.3; §4 G1, G2, G12; §5.6).
// Chrome in flight is at most four elements: act chip, menu, Play/Pause, rail. The phase-legend pill appears on TF changes
// and at stops; the first-use hint shows until p has moved more than 1 % once (localStorage).
//
// Pure (node G1 runs exactly this):
//   hudGeometry(bands, cls, type, state)       -> {act, phase, menu, hint?} page rects
//   frameItems(fs, env)                         -> solver items for one frame (HUD, rail, dock, kinetic, plaque, eqs, tags)
//   chromeCount(solved, fs)                     -> number of HUD elements visible (G12)
//   scrimRects(solved, vw, vh)                  -> <= 2 GL scrim rects (viewport fractions) under the placed text (stage.setScrims)
// DOM:
//   createShell(els, opts) -> {resize(), render(fs, ext), rects(), scrims(), layout(), models(), narrative, menu}

import {layoutClass, computeBands, typeScale, isPhone, BANDS, g1Matrix} from "./layoutclass.js";
import {solve} from "./layout.js";
import {textWidth, groupModel, kineticItems, createKinetic, copyEntry, textKey, depthCue, focusStyle} from "./kinetic.js";
import {railGeometry, railModel, createRail} from "./rail.js";
import {plaqueItem, plaqueLines, createPlaque} from "./plaque.js";
import {viewFor, keepWeight, keepPts, KEEP_MARGIN_PX, project, projectSegment} from "../core/shots.js";
import {planEquations} from "../eq/equations.js";
import {resolveTemplate} from "../engine.js";
import {createMenu, createKeyHelp, keyAction} from "./menu.js";
import {createNarrative} from "./narrative.js";
import {createPicker} from "./picker.js";

/* act chip labels (UI words, not data); copy.json[beat].chip overrides. Act titles that are z-planes on the ray: */
export const ACT_LABELS = Object.freeze({B0: "Start", B1: "The light", B2: "The halo", B5: "Cloud A", B7a: "Cloud B", B9: "Cloud C",
  B11: "Look back", B12a: "The telescope", B13: "Reading it back", B14: "Yours"});
export const ACT_TITLE_BEATS = Object.freeze(["B1", "B2", "B5", "B7a", "B9", "B11"]);

/* phase-legend swatches per story TF preset (tokens in css/story.css) */
export const TF_LEGEND = Object.freeze({
  density: {name: "Density", sw: ["#3b0f70", "#de4968", "#fcfdbf"]},           // magma (tfstory.js density)
  halo: {name: "Thin halo gas", sw: ["#3b0f70", "#de4968", "#fcfdbf"]},     // magma, wider window (B2, B6)
  phases: {name: "Gas phases", sw: ["var(--cold)", "var(--warm)", "var(--hot)", "var(--hot2)"]},
  hi: {name: "Neutral hydrogen", sw: ["var(--hi)"]},
  ovi: {name: "Oxygen VI", sw: ["var(--ovi)"]},
  ions: {name: "Ion homes", sw: ["var(--hi)", "var(--ovi)"]},
  speed: {name: "Speed toward us / away", sw: ["#3b4cc0", "#dddddd", "#b40426"]},
  metals: {name: "Metals", sw: ["#3b528b", "#21918c", "#fde725"]},             // viridis (tfstory.js metals)
  composite: {name: "Everything", sw: ["var(--cold)", "var(--warm)", "var(--hot)"]},
});
export const HINT_TEXT = {fine: "Scroll, or hold Space, to follow the light", coarse: "Swipe up to follow the light"};   // copy.ui wins

/* UI string from copy.json "ui" (U_copy) with a built-in fallback; {{$name}} templates filled from vars */
export function uiText(copy, key, fallback, vars = {}) {
  const raw = copy && copy.ui && typeof copy.ui[key] === "string" ? copy.ui[key] : fallback;
  return String(raw == null ? "" : raw).replace(/\{\{\$([\w.]+)\}\}/g, (m, k) => (vars[k] != null ? String(vars[k]) : m));
}

export function actFor(beats, i, copy = {}) {
  for (let k = Math.min(i, (beats || []).length - 1); k >= 0; k--) {
    const b = beats[k], c = copy[b.copyRef || b.id];
    if (c && c.chip) return c.chip;
    if (ACT_LABELS[b.id]) return ACT_LABELS[b.id];
  }
  return ACT_LABELS.B0;
}
export function tfLegend(tf, copy = null) {
  if (!tf) return null;
  // seek's tf.chip names the HUD label (B11-B13 "composite"); preset ids like "ion:HI" map to "hi"
  const raw = tf.chip || (tf.mix != null && tf.mix >= 0.5 ? tf.to : tf.from), full = String(raw || "").toLowerCase();
  const id = full.replace(/^ion:/, "");
  if (!id) return null;
  const names = copy && copy.ui && copy.ui.tf;
  const base = TF_LEGEND[id] || {name: String(raw).replace(/^ion:/, ""), sw: []};
  return {id, ...base, name: (names && (names[full] || names[id])) || base.name};
}
export const phaseVisible = fs => !!(fs && ((fs.tf && fs.tf.mix > 0.02 && fs.tf.mix < 0.98) || (fs.beat && fs.beat.stop)));
/* review2 three_d T4: between TF changes the pill hides (G12 keeps flight chrome at 4), so the act chip carries the current
   preset's swatches for the whole plateau: the colour key never leaves the screen while a preset is shown. On the mobile
   tier the speed preset colours cells only; the chip then also says so (copy.ui.speed_cells_only_short). */
export const restSwatches = (fs, legend) => (legend && legend.sw && legend.sw.length && !phaseVisible(fs) ? legend.sw : null);
export const restNoteText = (copy, legend, cellsOnly) => (cellsOnly && legend && legend.id === "speed" ? uiText(copy, "speed_cells_only_short", "cells only") : "");
export const actRestWidth = (sw, note) => (sw ? sw.length * 10 + 24 + (note ? Math.ceil(textWidth(note, "sans", 13)) + 10 : 0) : 0);

const CHIP_FONT = 14, CHIP_H = 44;
export const TAG_MAX_DIST = 24;   // fix3 H1/R7: a world tag (cloud chip) never sits further than this from its anchor
// chip = border 2 + padding 2×16 + dot 8 + gap 10 + label; pill = border 2 + padding 2×14 + swatches (9 + 3 gap each) + gap 10 + label
export const chipWidth = label => Math.ceil(textWidth(label, "sans5", CHIP_FONT)) + 54;
/* music pill (js/ui/sound.js): icon + the wider of "Music on" / "Music off"; icon only (44) on phones */
export const soundWidth = cls => (isPhone(cls) ? 44 : Math.ceil(textWidth("Music off", "sans5", CHIP_FONT)) + 54);
export const pillWidth = leg => Math.ceil(textWidth(leg.name, "sans", 13)) + 42 + leg.sw.length * 12;
/* fix3 ux M1: one act-chip width for both placements (top HUD row and, on compact landscape, the rail). The chip holds the
   label plus the resting colour key (T4); the key is flex:none, so a box narrower than label + key ellipsizes the label (the
   chapter name was cut to 0 px at 844x390). When label + key do not fit the room, the key is dropped before the label.
   -> {w, rest: bool}. room = the width available to the chip (Infinity when unconstrained). */
export const RAIL_TRACK_MIN = 120;
export function actChipFit(act, restSw, restNote, room) {
  const base = chipWidth(act || ""), full = base + actRestWidth(restSw, restNote);
  if (restSw && full <= room) return {w: full, rest: true};
  return {w: Math.min(base, room), rest: false};
}
/* room for the act chip inside the rail: everything between the menu and a track of RAIL_TRACK_MIN (odometer may drop) */
export function railActRoom(band, cls, opts) {
  const probe = railGeometry(band, cls, {...opts, actInRail: false});
  const pad = Math.max(10, Math.round(band.h * 0.2));
  return Math.max(0, band.x + band.w - pad - probe.track.x - pad - RAIL_TRACK_MIN);
}

/* HUD boxes. state = {act: label, legend: {name, sw} | null, insetTop} */
export function hudGeometry(bands, cls, type, state = {}) {
  const out = {};
  const m = Math.max(10, Math.round(16 * Math.min(1, type.fpx * 1.4)));
  if (bands.hud && !bands.menuInRail) {
    const top = bands.hud.y + (state.insetTop || 0);
    const rowH = isPhone(cls) ? CHIP_H : Math.max(CHIP_H, bands.hud.h - (state.insetTop || 0));
    const y1 = top + Math.max(4, Math.round((Math.min(rowH, bands.hud.h - (state.insetTop || 0)) - CHIP_H) / 2));
    out.menu = {x: bands.hud.x + bands.hud.w - m - 44, y: y1, w: 44, h: CHIP_H};
    const sw = soundWidth(cls);
    out.sound = {x: out.menu.x - 8 - sw, y: y1, w: sw, h: CHIP_H, icon: sw === 44};
    const fit = actChipFit(state.act, state.restSw, state.restNote, out.sound.x - 8 - bands.hud.x - m);
    out.act = {x: bands.hud.x + m, y: y1, w: fit.w, h: CHIP_H, rest: fit.rest};
    if (state.legend) {
      const pw = pillWidth(state.legend);
      // phones: the pill takes the top-left of the world band while it shows (only lower-priority labels live there),
      // so the text band never loses height to it
      if (isPhone(cls)) out.phase = bands.world && bands.world.h >= 36 ? {x: bands.world.x, y: bands.world.y, w: Math.min(pw, bands.world.w), h: 36} : null;
      else out.phase = {x: out.act.x + out.act.w + 8, y: y1 + 4, w: pw, h: 36};
    }
  }
  return out;
}

/* rail geometry with the act chip sized by actChipFit (compact landscape: the chip lives in the rail); rg.actRest tells
   whether the resting key fits */
export function railFor(bands, cls, type, act, restSw, restNote, maxKpc) {
  const o = {mono: type.mono, menuInRail: bands.menuInRail, actInRail: bands.menuInRail, maxKpc};
  if (!bands.menuInRail) return {...railGeometry(bands.rail, cls, {...o, actW: chipWidth(act || "")}), actRest: false};
  const fit = actChipFit(act, restSw, restNote, railActRoom(bands.rail, cls, o));
  return {...railGeometry(bands.rail, cls, {...o, actW: fit.w}), actRest: fit.rest};
}
/* whether the act chip shows its resting key this frame (same decision as its box width) */
export function actRestShown(bands, cls, type, act, restSw, restNote, maxKpc) {
  if (!restSw) return false;
  if (bands.menuInRail) return railFor(bands, cls, type, act, restSw, restNote, maxKpc).actRest;
  const g = hudGeometry(bands, cls, type, {act, restSw, restNote});
  return !!(g.act && g.act.rest);
}

/* Solver items for one frame.
   env = {cls, bands, type, beats, copy, modelFor: t -> groupModel, legend, act, hint: bool, hintText,
          plaque: {lines, anchor} | null, eqs: [{id, size, anchor?}], dockKids: [{id, rect | size, kind}],
          tags: [{id, size, anchor, priority?}], reduced, insetTop}
   Ids: hud:act hud:phase hud:menu rail rail:fly rail:track rail:odo dock kt:<id> plaque eq:<id> hint <tag ids> */
export function frameItems(fs, env) {
  const {bands, cls, type} = env, items = [];
  const legend = phaseVisible(fs) ? env.legend : null;
  const restSw = restSwatches(fs, env.legend), restNote = restSw ? restNoteText(env.copy, env.legend, env.speedCellsOnly) : "";
  const hg = hudGeometry(bands, cls, type, {act: env.act, legend, insetTop: env.insetTop, restSw, restNote});
  // review2 beauty H1: in the title beat (B0) the chip would repeat the title on screen, so it waits for B1
  const titleBeat = actHidden(fs);
  if (hg.act && !titleBeat) items.push({id: "hud:act", kind: "hud", priority: 100, rect: hg.act});
  if (hg.menu) items.push({id: "hud:menu", kind: "hud", priority: 100, rect: hg.menu});
  if (hg.sound) items.push({id: "hud:sound", kind: "hud", priority: 100, rect: hg.sound});
  if (hg.phase) items.push({id: "hud:phase", kind: "hud", priority: 99, rect: hg.phase});

  // rail and its children
  items.push({id: "rail", kind: "rail", priority: 85, rect: bands.rail});
  const rg = railFor(bands, cls, type, env.act, restSw, restNote, env.maxKpc);
  items.push({id: "rail:fly", kind: "hud", priority: 86, rect: rg.fly, container: "rail"});
  if (rg.menu) items.push({id: "hud:menu", kind: "hud", priority: 86, rect: rg.menu, container: "rail"});
  if (rg.sound) items.push({id: "hud:sound", kind: "hud", priority: 86, rect: rg.sound, container: "rail"});
  if (rg.act && !titleBeat) items.push({id: "hud:act", kind: "hud", priority: 86, rect: rg.act, container: "rail"});
  items.push({id: "rail:track", kind: "rail", priority: 86, rect: rg.track, container: "rail"});
  if (rg.odo) items.push({id: "rail:odo", kind: "rail", priority: 86, rect: rg.odo, container: "rail"});

  // dock and its labels (U_spec registers children; they must stay inside the dock box)
  if (bands.dock) {
    items.push({id: "dock", kind: "dock", priority: 90, rect: bands.dock});
    for (const k of env.dockKids || []) items.push({...k, id: "dock:" + k.id, kind: k.kind || "dockLabel", priority: k.priority || 88, container: "dock", band: null, pad: 0});
  }

  // kinetic text: one group per band
  items.push(...kineticItems(fs.text || [], env.modelFor || (() => null), {reduced: env.reduced, bands}));

  // plaque
  if (env.plaque) { const it = plaqueItem(env.plaque.lines, env.plaque.anchor, type, {phone: isPhone(cls)}); if (it) items.push(it); }

  // equations (U_eq sizes; at most eqMax; the stepped phone chip is a single item)
  const eqMax = (BANDS[cls] || {}).eqMax || 1;
  // registered boxes carry a small pad: U_eq's reported size can trail its drawn box by a few px (phase-1 browser check:
  // up to 6 px wide, 2 px tall), and the solver box must always cover what is drawn
  const eqBandW = bands.eq ? Math.floor(bands.eq.w) : Infinity;
  const padEq = v => (v ? {...v, w: Math.max(v.w, Math.min(eqBandW, Math.ceil(v.w + Math.max(8, 0.02 * v.w)))), h: Math.ceil(v.h + 4)} : v);
  (env.eqs || []).slice(0, eqMax).forEach((e, i) => items.push({id: "eq:" + e.id, kind: "eq", priority: 50 - i * 0.1, band: "eq",
    variants: (e.variants || [e.size]).map(padEq), align: "start"}));

  // first-use hint: bottom centre of the world band
  if (env.hint && bands.world) {
    const t = env.hintText || HINT_TEXT.fine, w = Math.min(bands.world.w, Math.ceil(textWidth(t, "sans", 14)) + 36);
    items.push({id: "hint", kind: "hint", priority: 45, band: "world", anchor: {x: bands.world.x + bands.world.w / 2, y: bands.world.y + bands.world.h - 24},
      gap: 0, candidates: ["n"], fallback: "band", size: {w, h: 40, font: 14}});
  }

  // the hand-off at rest (review SC-7): Try another beam / Open in Spectra / Replay under the B14 text
  if (env.end) {
    const it = endItem(env.end, bands, type);
    if (it) items.push(it);
  }

  // world tags (cloud chips, end labels, numeric tags), lowest priority
  // fix3 H1/R7: a chip names its cloud only next to it. The band fallback stays but within TAG_MAX_DIST px of the anchor
  // (solver maxDist: nearest box point to the anchor); a chip whose slots are all taken is hidden, never parked in a legend
  // column or in empty sky. A chip is also dropped while the act chip or a visible act/display title already names the cloud.
  const named = new Set();
  if (env.act) named.add(String(env.act).toLowerCase());
  for (const t of fs.text || []) { if (!(t.band === "act" || t.part === "display")) continue; if (focusStyle(t.phase).opacity < 0.3) continue;
    const c = env.copy && env.copy[t.id]; const d = c ? String(c.display || "") : ""; if (d) named.add(d.replace(/\*/g, "").toLowerCase()); }
  const isNamed = lbl => { const l = String(lbl || "").toLowerCase(); if (!l) return false; for (const n of named) if (n.includes(l)) return true; return false; };
  for (const t of env.tags || []) { if (String(t.id || "").startsWith("chip:") && isNamed(t.label)) continue;
    items.push({kind: "tag", priority: 30, band: "world", fallback: "band", maxDist: TAG_MAX_DIST, ...t}); }
  return items;
}

/* the act chip is hidden in the first (title) beat, where the act-band title says the same words */
export const actHidden = fs => !!(fs && fs.beat && fs.beat.i === 0);
/* end actions shown from the last beat's u 0.3 (fading in to 0.4) to p = 1 */
export function endState(fs, beats, labels, short) {
  if (!fs || !fs.beat || !beats || fs.beat.i !== beats.length - 1) return null;
  const op = Math.min(1, Math.max(0, (fs.beat.u - 0.3) / 0.1));
  return op >= 0.02 ? {labels, short: short || labels, opacity: op} : null;
}
/* end actions (review SC-7): one row of pills (or a column when the band is narrow) in the equation band, else the world band */
export const END_IDS = Object.freeze(["ride_another", "open_spectra", "replay"]);
export function endSizes(labels, font = 14, short = labels) {
  const wOf = ls => ls.map(t => Math.ceil(textWidth(t, "sans5", font)) + 34), gap = 8, h = 44, ws = wOf(labels), ss = wOf(short);
  const row = a => a.reduce((x, y) => x + y, 0) + gap * (a.length - 1);
  // wrap (review2 ux H1): the short labels two over one, for phone and zoomed compact bands too narrow for a row
  const wrap = {w: Math.max(ss[0] + gap + ss[1], ss[2]), h: 2 * h + gap, font, key: "wrap"};
  // ... and where none of those fits (zoomed compact, phone portrait, narrow), 34 px pills: one row, two over one, or a column
  // (END_TIGHT_H; WCAG 2.5.8 asks 24 px, the 44 px of every other mode stays the default)
  // tight pills: 13 px type (above the 12 px floor), 8 px padding + 1 px border each side, 4 px gaps
  const tf = END_TIGHT_FONT, tw = ls => ls.map(t => Math.ceil(textWidth(t, "sans5", tf)) + 18), ts = tw(short);
  const rowTight = {w: ts.reduce((x, y) => x + y, 0) + 4 * (ts.length - 1), h: END_TIGHT_H, font: tf, key: "rowTight"};
  const tight = {w: Math.max(ts[0] + 4 + ts[1], ts[2]), h: 2 * END_TIGHT_H + 4, font: tf, key: "wrapTight"};
  const colTight = {w: Math.max(...ts), h: ts.length * END_TIGHT_H + (ts.length - 1) * 4, font: tf, key: "colTight"};
  return [{w: row(ws), h, font, key: "row"}, {w: row(ss), h, font, key: "rowShort"},
          {w: Math.max(...ws), h: ws.length * h + (ws.length - 1) * gap, font, key: "col"}, wrap, rowTight, tight, colTight];
}
export const END_TIGHT_H = 34, END_TIGHT_FONT = 13;
export const FOLLOW_JUMP = 96;   // px: a visible box moving further than this fades across instead of gliding (SC2-1)
export const END_MODES = Object.freeze(["row", "rowShort", "col", "wrap", "rowTight", "wrapTight", "colTight"]);
/* review2 ux H1: the end actions must show in every class. Bands in order: the equation band, the text and equation bands
   together (B14's text is short), the world band, the text band alone, then the strip just above the dock (narrow has no
   eq or world band). Each variant is tried in every band before a smaller one. */
export function endBands(bands) {
  const out = [], u = (a, b) => ({x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), w: Math.max(a.x + a.w, b.x + b.w) - Math.min(a.x, b.x), h: Math.max(a.y + a.h, b.y + b.h) - Math.min(a.y, b.y)});
  if (bands.eq) out.push(bands.eq);
  if (bands.text && bands.eq && Math.abs(bands.text.x - bands.eq.x) < 2 && bands.eq.y >= bands.text.y + bands.text.h - 1) out.push(u(bands.text, bands.eq));
  if (bands.world) out.push(bands.world);
  if (bands.text) out.push(bands.text);
  return out;
}
function endItem(end, bands, type) {
  const alts = endBands(bands); if (!alts.length) return null;
  return {id: "end", kind: "end", priority: 48, bandAlts: alts, align: "start", vAlign: "bottom",
          variants: endSizes(end.labels, 14, end.short || end.labels), opacity: end.opacity, required: true,
          // keeps off the beam (G3). Narrow (<= 320 px) only: if no variant clears the beam, the opaque pills may sit over it
          // rather than leave the story with no exit (review2 ux H1; seen with the stills poster's baked beam at 260x563)
          avoidSoft: bands.cls === "narrow"};
}

/* G12: HUD elements visible in flight (act chip, menu, fly, rail; phase pill and hint count when shown). The music toggle
   (hud:sound) is always on screen at the owner's request and is not counted. */
export function chromeCount(solved) {
  const ids = new Set(solved.placed.map(b => b.id));
  return ["hud:act", "hud:menu", "rail:fly", "rail", "hud:phase", "hint"].filter(id => ids.has(id)).length;
}

/* GL scrims under the placed text (S0 §4: k frozen at 0.75 in stage.js; DESIGN_final §3.4 "GL scrims under the text band").
   Pure. Reads the solver's placed boxes of kind display (band text and act titles) and eq, clusters them into at most two
   rects (post.js has two scrim slots) by column overlap, and pads each by the shader's soft edge (0.04 uv) so the edge
   ramp falls outside the text and every glyph gets the full k. Returns viewport fractions, y down, as stage.setScrims
   expects; no k, so stage's frozen default applies. [] when no text is placed (stage then falls back to its own band). */
export const SCRIM_EDGE = 0.04;
export const SCRIM_K_TEXT = 0.75;                        // stage.js SCRIM_K (S0 freeze); scaled by the text's opacity (review SC-9)
export function scrimRects(solved, vw, vh, {kinds = ["display", "eq"], pad = SCRIM_EDGE, k} = {}) {
  if (!solved || !vw || !vh) return [];
  const want = new Set(kinds);
  // review SC-9: each scrim follows its text's opacity (kinetic fades), and text below 0.05 opacity gets none, so no empty dark
  // rectangle switches on before the words or stays after them
  let cl = (solved.placed || []).filter(b => want.has(b.kind) && b.w > 0 && b.h > 0 && !(b.opacity != null && b.opacity < 0.05))
    .map(b => ({x0: b.x / vw, y0: b.y / vh, x1: (b.x + b.w) / vw, y1: (b.y + b.h) / vh, op: b.opacity == null ? 1 : Math.min(1, b.opacity)}));
  const join = (a, b) => ({x0: Math.min(a.x0, b.x0), y0: Math.min(a.y0, b.y0), x1: Math.max(a.x1, b.x1), y1: Math.max(a.y1, b.y1), op: Math.max(a.op, b.op)});
  const area = r => (r.x1 - r.x0) * (r.y1 - r.y0);
  // same column (x ranges overlap by >= 30 % of the narrower one) merges; then the pair whose union adds least area merges
  // until two remain
  // ... and only when they are vertically near (a phone's text at the top and its chip above the dock stay two scrims, so
  // the world between them, where the beam runs, is not darkened)
  const sameCol = (a, b) => Math.min(a.x1, b.x1) - Math.max(a.x0, b.x0) >= 0.3 * Math.min(a.x1 - a.x0, b.x1 - b.x0) &&
    Math.max(a.y0, b.y0) - Math.min(a.y1, b.y1) <= 2 * pad;
  for (let again = true; again;) {
    again = false;
    for (let i = 0; i < cl.length && !again; i++) for (let j = i + 1; j < cl.length && !again; j++)
      if (sameCol(cl[i], cl[j])) { cl[i] = join(cl[i], cl[j]); cl.splice(j, 1); again = true; }
  }
  while (cl.length > 2) {
    let bi = 0, bj = 1, best = Infinity;
    for (let i = 0; i < cl.length; i++) for (let j = i + 1; j < cl.length; j++) {
      const c = area(join(cl[i], cl[j])) - area(cl[i]) - area(cl[j]); if (c < best) { best = c; bi = i; bj = j; } }
    cl[bi] = join(cl[bi], cl[bj]); cl.splice(bj, 1);
  }
  const c01 = v => Math.min(1, Math.max(0, v)), r4 = v => Math.round(v * 1e4) / 1e4;
  const k2 = op => Math.round((k != null ? k : SCRIM_K_TEXT) * op * 100) / 100;
  return cl.map(r => ({x0: r4(c01(r.x0 - pad)), y0: r4(c01(r.y0 - pad)), x1: r4(c01(r.x1 + pad)), y1: r4(c01(r.y1 + pad)),
                       ...(k != null || r.op < 1 ? {k: k2(r.op)} : {})}));
}

/* ---------------------------------------------------------------- DOM shell */
/* els = {root (#stage), hud, rail, kinetic, labels, sheets, menuButton, menuSheet, narrativeList, live, textOverlay, canvas,
          actChip, phasePill, hint}
   opts = {beats, copy, data, lookup, honesty, hooks: {setTarget, jump, flyStart, flyEnd, flyToggle, watch, explore, picker,
           physics, share, keys, explorerHref, key, onLayout,
                    setScrims (= stage.setScrims; text-band GL scrim rects, called only when they change)}, lToP, clouds} */
export function createShell(els, opts = {}) {
  /* review2 scrolly SC2-1: placed text and the plaque follow their solver slots in screen space. Small moves glide (first-order
     follower, k = 14/s, no overshoot); a move larger than FOLLOW_JUMP px while the box is on screen fades the box out at its
     old slot and back in at the new one instead of teleporting. Reduced motion, a layout change and the film snap. */
  const FOL = new Map(); let folT = 0;
  function follow(solved) {
    const now = performance.now(), dt = folT ? Math.min(0.1, Math.max(0, (now - folT) / 1000)) : 0; folT = now;
    const snap = S.reduced || !dt || (typeof window !== "undefined" && window.__film) || opts.follow === false;
    const byId = {...solved.byId}, seen = new Set(); let moving = false;
    for (const id of Object.keys(byId)) {
      if (!(id.startsWith("kt:") || id === "plaque")) continue;
      const b = byId[id]; if (!b) continue; seen.add(id);
      let f = FOL.get(id);
      if (!f || snap || f.key !== S.prevKey) { f = {x: b.x, y: b.y, fade: 1, out: false, key: S.prevKey}; FOL.set(id, f); byId[id] = {...b, fade: 1}; continue; }
      const d = Math.hypot(b.x - f.x, b.y - f.y);
      if (f.out || d > FOLLOW_JUMP) {
        if (!f.out) f.out = true;
        f.fade = Math.max(0, f.fade - dt / 0.12);
        if (f.fade <= 0) { f.x = b.x; f.y = b.y; f.out = false; }
        moving = true;
      } else {
        if (f.fade < 1) { f.fade = Math.min(1, f.fade + dt / 0.18); moving = true; }
        const a = 1 - Math.exp(-14 * dt); f.x += (b.x - f.x) * a; f.y += (b.y - f.y) * a;
        if (Math.abs(b.x - f.x) > 0.25 || Math.abs(b.y - f.y) > 0.25) moving = true; else { f.x = b.x; f.y = b.y; }
      }
      byId[id] = {...b, x: f.x, y: f.y, fade: f.fade};
    }
    for (const id of [...FOL.keys()]) if (!seen.has(id)) FOL.delete(id);
    if (moving && opts.hooks && typeof opts.hooks.kick === "function") opts.hooks.kick();
    return {...solved, byId};
  }
  const H = opts.hooks || {};
  const flags = opts.flags || (opts.data && opts.data.flags) || {};
  // every face the solver's metrics assume, requested now: a face that loads on first use (the italic accent) would draw
  // with fallback metrics for a frame and break the solver box (G1); onFonts re-measures nothing, it only re-renders
  if (typeof document !== "undefined" && document.fonts && document.fonts.load) {
    Promise.all(["400 40px Newsreader", "italic 400 40px Newsreader", "400 16px 'Space Grotesk'", "500 16px 'Space Grotesk'", "400 13px 'JetBrains Mono'",
                 "400 20px KaTeX_Main", "italic 400 20px KaTeX_Math", "400 20px KaTeX_Size1"]   // U_eq's boxes: a late KaTeX face widened E3 by 40 px at 2560 (phase-2 browser check)
      .map(f => document.fonts.load(f).catch(() => null))).then(() => H.onFonts && H.onFonts());
  }
  const kin = createKinetic(els.kinetic), plaque = createPlaque(els.labels);
  const rail = createRail(els.rail, {playToggle: H.watchToggle, flyStart: H.flyStart, flyEnd: H.flyEnd, flyToggle: H.flyToggle, jump: H.jump, key: H.key,
                                     tickLabel: t => (t ? actFor(opts.beats, (opts.beats || []).findIndex(b => b.id === t.id), opts.copy) : ""),
                                     watchRemaining: H.watchRemaining});
  const keyHelp = !H.keys && els.sheets ? createKeyHelp(els.sheets) : null;
  // opts.index = data/index.json, opts.current = {galaxy, ray}; H.pick({galaxy, ray}) loads the story (integrator)
  const picker = !H.picker && els.sheets && opts.index && H.pick ? createPicker(els.sheets, {onPick: H.pick, explorerHref: H.explorerHref}) : null;
  const menu = createMenu(els.menuButton, els.menuSheet, {watch: H.watch, explore: H.explore, physics: H.physics,
    picker: H.picker || (picker && (() => picker.open(opts.index, opts.current))), text: () => narrative.open(), share: H.share, keys: H.keys || (keyHelp && keyHelp.open), explorerHref: H.explorerHref,
    watchHint: H.watchHint});
  const narrative = createNarrative({list: els.narrativeList, live: els.live, overlay: els.textOverlay, canvas: els.canvas},
                                    {jump: H.jump, quiet: H.quiet});
  narrative.build(opts.beats, opts.copy, opts.lookup, opts.honesty || []);
  if (els.phasePill && H.tfPopover) els.phasePill.addEventListener("click", H.tfPopover);

  // end actions (review SC-7): DOM pills in the HUD layer, placed by the solver like every other box
  const endLabels = END_IDS.map(k => uiText(opts.copy, k, k)), endShort = END_IDS.map((k, i) => uiText(opts.copy, k + "_short", endLabels[i]));
  let endEl = null;
  if (els.hud && typeof document !== "undefined") {
    endEl = document.createElement("div"); endEl.id = "end-actions"; endEl.setAttribute("role", "group"); endEl.setAttribute("aria-label", "What next");
    endEl.dataset.noscrub = ""; endEl.hidden = true;
    endEl.innerHTML = END_IDS.map((k, i) => k === "open_spectra"
      ? `<a class="hud-pill end-a" data-end="${k}" href="#" aria-label="${endLabels[i]}"><span class="end-l">${endLabels[i]}</span><span class="end-s">${endShort[i]}</span></a>`
      : `<button class="hud-pill end-a" type="button" data-end="${k}" aria-label="${endLabels[i]}"><span class="end-l">${endLabels[i]}</span><span class="end-s">${endShort[i]}</span></button>`).join("");
    endEl.addEventListener("click", e => {
      const a = e.target.closest("[data-end]"); if (!a) return;
      const k = a.dataset.end;
      if (k === "open_spectra") { a.href = H.explorerHref ? H.explorerHref() : "../../index.html"; return; }
      e.preventDefault();
      if (k === "ride_another") (H.picker || (picker && (() => picker.open(opts.index, opts.current))) || (() => {}))();
      else if (k === "replay") (H.replay || (() => H.jump && H.jump(0)))();
    });
    els.hud.appendChild(endEl);
  }
  const S = {cls: null, bands: null, type: null, w: 0, h: 0, solved: {placed: [], hidden: [], byId: {}}, insets: {top: 0, right: 0, bottom: 0, left: 0},
             hintSeen: false, p0: null, dockState: "strip", side: "left", reduced: false, watch: false, grab: false};
  try { S.hintSeen = localStorage.getItem("story2.hintSeen") === "1"; } catch (e) {}
  const coarse = typeof matchMedia === "function" && matchMedia("(pointer: coarse)").matches;

  function readInsets() {
    const cs = getComputedStyle(els.root);
    const n = v => parseFloat(cs.getPropertyValue(v)) || 0;
    S.insets = {top: n("--sat"), right: n("--sar"), bottom: n("--sab"), left: n("--sal")};
  }
  /* text models, cached per (copy id, part, band width, level); rebuilt lazily when the class or the text band changes */
  let cache = new Map();
  function buildModels() { cache = new Map(); }
  function modelFor(t) {
    const band = S.bands && S.bands.text; if (!band) return null;
    const level = t.band === "act" ? 0 : 1, k = `${textKey(t)}|${Math.round(band.w)}|${level}|${S.cls}`;
    if (!cache.has(k)) cache.set(k, groupModel(copyEntry(opts.copy, t.id, flags), band, S.type, level, opts.lookup, t.part || "all"));
    return cache.get(k);
  }
  function relayout(dock, side) {
    S.bands = computeBands(S.cls, S.w, S.h, {dock, textSide: side, insets: S.insets});
    S.dockState = dock; S.side = side;
  }
  function resize() {
    const w = els.root.clientWidth || innerWidth, h = els.root.clientHeight || innerHeight;
    readInsets();
    const cls = layoutClass(w, h);
    S.w = w; S.h = h; S.cls = cls; S.type = typeScale(cls, w, h);
    els.root.dataset.layout = cls;
    els.root.style.setProperty("--fpx", S.type.fpx.toFixed(4));
    els.root.style.setProperty("--mono-px", S.type.mono + "px");   // --mono is the font family token
    els.root.style.setProperty("--eq-size", S.type.eq + "px");     // U_eq's equation font (>= 17 px, G2)
    relayout(S.dockState, S.side);
    buildModels();
    H.onLayout && H.onLayout({cls, bands: S.bands, type: S.type});
  }

  /* ext = {eqs, dockKids, tags, plaque: {lines, anchor}, corridors, reduced, watch, paused, travelled} */
  function render(fs, ext = {}) {
    if (!S.cls) resize();
    S.reduced = !!ext.reduced; S.watch = !!ext.watch && !ext.paused; S.grab = !!ext.grab;
    const dock = (fs.spec && fs.spec.dock) || "strip", side = (fs.cam && fs.cam.textSide) || "left";
    if (dock !== S.dockState || side !== S.side) { const textW = S.bands && S.bands.text ? S.bands.text.w : 0; relayout(dock, side); if (!S.bands.text || S.bands.text.w !== textW) buildModels(); }
    if (S.p0 == null) S.p0 = fs.p;
    if (!S.hintSeen && Math.abs(fs.p - S.p0) > 0.01) { S.hintSeen = true; try { localStorage.setItem("story2.hintSeen", "1"); } catch (e) {} }
    const act = actFor(opts.beats, fs.beat ? fs.beat.i : 0, opts.copy), legend = tfLegend(fs.tf, opts.copy);
    if (legend && legend.id === "speed" && ext.speedCellsOnly) legend.name = uiText(opts.copy, "speed_cells_only", legend.name);   // T4
    const hintText = coarse ? uiText(opts.copy, "hint_touch", HINT_TEXT.coarse) : uiText(opts.copy, "hint_desktop", HINT_TEXT.fine);
    const text = activeText(fs.text, flags).map(t => (t.band === "act" && t.anchor && ext.project ? {...t, screen: ext.project(t.anchor)} : t));
    const fs2 = {...fs, text};
    const env = {cls: S.cls, bands: S.bands, type: S.type, modelFor, act, legend, hint: !S.hintSeen,
                 hintText, plaque: ext.plaque, eqs: ext.eqs, dockKids: ext.dockKids,
                 tags: ext.tags, reduced: S.reduced, insetTop: S.insets.top, maxKpc: ext.maxKpc,
                 end: endEl ? endState(fs, opts.beats, endLabels, endShort) : null, speedCellsOnly: !!ext.speedCellsOnly, copy: opts.copy};
    const items = frameItems(fs2, env);
    // hysteresis (review SC-2): last frame's slots are tried first, so a visible box does not jump between equal candidates;
    // a resize or a layout class change drops them
    const prev = S.prevKey === `${S.cls}|${S.w}|${S.h}` && S.solved && S.solved.placed ? Object.fromEntries(S.solved.placed.filter(b => !b.exempt && b.cand !== "fixed")
      .map(b => [b.id, {x: b.x, y: b.y, cand: b.cand, variant: b.variant}])) : null;
    S.corridors = ext.corridors || [];
    S.solved = solve(items, {w: S.w, h: S.h, bands: S.bands, corridors: S.corridors, prev});
    S.prevKey = `${S.cls}|${S.w}|${S.h}`;
    const B = S.solved.byId;
    // GL scrims follow the placed text (S0 §4); handed to stage.setScrims only when they change
    const scr = scrimRects(S.solved, S.w, S.h), sk = JSON.stringify(scr);
    if (sk !== S.scrimKey) { S.scrimKey = sk; S.scrims = scr; H.setScrims && H.setScrims(scr); }

    // HUD
    const place = (el, b) => { if (!el) return; if (!b) { el.hidden = true; return; } el.hidden = false;
      el.style.transform = `translate3d(${b.x}px,${b.y}px,0)`; el.style.width = b.w + "px"; el.style.height = b.h + "px"; };
    if (els.actChip) { const lbl = els.actChip.querySelector(".act-l"); if (lbl && lbl.textContent !== act) lbl.textContent = act;
      // T4: the resting colour key inside the chip (swatches + optional cells-only note); aria names the colours
      const rsw0 = restSwatches(fs2, legend), note0 = rsw0 ? restNoteText(opts.copy, legend, env.speedCellsOnly) : "";
      const rsw = rsw0 && actRestShown(S.bands, S.cls, S.type, act, rsw0, note0, ext.maxKpc) ? rsw0 : null, note = rsw ? note0 : "";   // fix3 ux M1
      const rk = rsw ? legend.id + "|" + note : "";
      if (els.actChip.dataset.rest !== rk) {
        els.actChip.dataset.rest = rk;
        let sp = els.actChip.querySelector(".act-sw");
        if (!sp) { sp = document.createElement("span"); sp.className = "act-sw"; els.actChip.appendChild(sp); }
        sp.hidden = !rsw;
        sp.innerHTML = rsw ? rsw.map(c => `<i style="background:${c}"></i>`).join("") + (note ? `<span class="act-note">${note}</span>` : "") : "";
        sp.setAttribute("aria-label", rsw ? "Colours: " + legend.name + (note ? ", " + note : "") : "");
        sp.setAttribute("role", rsw ? "img" : "presentation");
      }
      place(els.actChip, B["hud:act"]); }
    place(els.menuButton, B["hud:menu"]);
    place(els.soundButton, B["hud:sound"]);
    if (els.soundButton && B["hud:sound"]) els.soundButton.classList.toggle("icon", B["hud:sound"].w <= 44);
    if (els.phasePill) {
      if (B["hud:phase"] && legend) {
        const key = legend.id + (env.speedCellsOnly ? "|c" : "");
        if (els.phasePill.dataset.tf !== key) {
          els.phasePill.dataset.tf = key;
          els.phasePill.innerHTML = `<span class="ph-sw">${legend.sw.map(c => `<i style="background:${c}"></i>`).join("")}</span><span class="ph-n">${legend.name}</span>`;
          els.phasePill.setAttribute("aria-label", "Colours: " + legend.name);
        }
      }
      place(els.phasePill, B["hud:phase"]);
    }
    if (els.hint) { if (els.hint.textContent !== hintText) els.hint.textContent = hintText; place(els.hint, B.hint); }
    if (endEl) { const b = B.end; place(endEl, b); if (b) { endEl.dataset.mode = END_MODES[b.variant] || "row"; endEl.style.opacity = String(env.end ? env.end.opacity : 1); } }

    // rail
    const rb = B.rail;
    els.rail.hidden = !rb;
    if (rb) {
      place(els.rail, rb);
      const rs0 = restSwatches(fs2, legend), rg = railFor(S.bands, S.cls, S.type, act, rs0, rs0 ? restNoteText(opts.copy, legend, env.speedCellsOnly) : "", ext.maxKpc);
      rail.render(fs, railModel(opts.beats, opts.clouds, fs, opts.lToP), rg, ext.travelled,
                  {origin: rb, watch: ext.watch, paused: ext.paused, beatLabel: act});
    }

    // kinetic text, plaque: drawn through the screen-space follower (review2 scrolly SC2-1), never straight from the solver
    const D = follow(S.solved);
    kin.render(fs2.text || [], D, modelFor, {reduced: S.reduced, depth: ext.depthOf ? t => depthCue(ext.depthOf(t.anchor)) : null});
    plaque.render(ext.plaque ? ext.plaque.lines : [], D.byId.plaque, {phone: isPhone(S.cls), opacity: D.byId.plaque ? D.byId.plaque.fade : 1});
    renderChips(ext.tags || [], B);
    narrative.update(fs.beat);
    return S.solved;
  }

  /* world tags (fix1, review M1 three_d / F5): cloud letter chips placed by the solver (kind "tag"), drawn in the labels layer */
  const chipEls = new Map();
  function renderChips(tags, B) {
    if (!els.labels || typeof document === "undefined") return;
    const live = new Set();
    for (const t of tags) {
      const b = B[t.id]; if (!b || !t.label) continue;
      let el = chipEls.get(t.id);
      if (!el) { el = document.createElement("div"); el.className = "cloud-chip"; el.setAttribute("aria-hidden", "true"); els.labels.appendChild(el); chipEls.set(t.id, el); }
      if (el.textContent !== t.label) el.textContent = t.label;
      el.dataset.ion = t.ion || "";
      el.hidden = false; el.style.transform = `translate3d(${b.x}px,${b.y}px,0)`; el.style.width = b.w + "px"; el.style.height = b.h + "px";
      live.add(t.id);
    }
    for (const [id, el] of chipEls) if (!live.has(id)) el.hidden = true;
  }

  /* keys the shell claims before the clock (U_motion bindInput({onKey})): returns true when the key is taken.
     ? help, F trail, T colour preset, R / N sliders, G grab, Esc release (while grabbed), Space = play/pause in Watch */
  function onKey(e) {
    const a = keyAction(e, {watch: S.watch, grab: S.grab});
    if (!a) return false;
    if (!a.action) { e.preventDefault(); return a.claim; }
    const fn = a.action === "help" ? (H.keys || (keyHelp && keyHelp.open)) : H[a.action];
    if (typeof fn !== "function") return false;
    e.preventDefault(); fn(); return a.claim;
  }

  /* window.__story.rects(): every placed box (page px), for G1/G12 and the browser overlap sampler */
  function rects() {
    return S.solved.placed.map(b => ({id: b.id, kind: b.kind, x: b.x, y: b.y, w: b.w, h: b.h, container: b.container, exempt: b.exempt}));
  }
  if (typeof addEventListener === "function") {
    let raf = 0;
    const onR = () => { cancelAnimationFrame(raf); raf = requestAnimationFrame(resize); };
    addEventListener("resize", onR);
    if (window.visualViewport) visualViewport.addEventListener("resize", onR);
  }
  return {resize, render, rects, scrims: () => S.scrims || [], onKey, keyHelp, picker, narrative, menu, rail, kinetic: kin,
          layout: () => ({cls: S.cls, bands: S.bands, type: S.type, w: S.w, h: S.h, corridors: S.corridors || []}), modelFor, solved: () => S.solved,
          sizeTable: deps => captureStorySizes({copy: opts.copy, lookup: opts.lookup, flags, layer: els.kinetic, ...deps})};
}

/* ---------------------------------------------------------------- conditional text slots */
/* beats.json text slots may carry `cond` (a copy.flags name) and `alt` (replaces the previous slot of its band in the same
   window). Flags come from the story JSON (`flags`, U_data); a missing flag counts as false (copy.flags rule), so the
   conservative branch shows. Pure. */
/* beats whose copy flag is false (beat.cond: B6 has_hot_stretch, B7e has_cold_knot) leave PageDown and the rail ticks:
   the integrator wires timeline.setSkip(beatSkip(flags)). Same rule as activeText: a missing flag counts as false. Pure. */
export const beatSkip = flags => b => !!(b && b.cond) && !(flags && flags[b.cond] === true);

export function activeText(text, flags) {
  const out = [];
  for (const t of text || []) {
    if (t.cond && !(flags && flags[t.cond] === true)) continue;
    if (t.alt) for (let k = out.length - 1; k >= 0; k--) if (out[k].band === t.band) { out.splice(k, 1); break; }
    out.push(t);
  }
  return out;
}

/* ---------------------------------------------------------------- node G1 composer (U_qa contract) */
/* U_qa's class names (lib/storyqa.mjs) for size tables captured by its harness */
export const QA_CLASS = Object.freeze({desktop: "desktop", compact: "compact-landscape", tablet: "tablet-portrait",
  phonePortrait: "phone-portrait", phoneLandscape: "phone-landscape", narrow: "narrow"});
const tableFor = (sizes, cls) => (sizes ? sizes[cls] || sizes[QA_CLASS[cls]] || null : null);

/* where a world anchor sits on the ray (kpc), from seek.prepare's context: {kind: "cloud", ref: letter} (the lead ion's
   shell first), {kind: "cell", ref: idx}, {kind: "probe"} */
export function anchorL(anchor, prep, fs) {
  if (!anchor || !prep) return null;
  if (anchor.kind === "probe") return fs.l;
  if (anchor.kind === "cell" && anchor.ref != null && prep.cellL) return prep.cellL(anchor.ref);
  if (anchor.kind === "cloud" && prep.clouds) {
    const lead = (fs.spec && fs.spec.lead) || "";
    const hits = prep.clouds.filter(c => c.letter === anchor.ref || c.id === anchor.ref);
    const c = hits.find(x => String(x.id).startsWith(lead + "_")) || hits[0];
    return c ? (c.l_in + c.l_out) / 2 : null;
  }
  return null;
}

/* equation boxes for one frame: U_eq's plan (at most two, the B7b chain, phones one at a time) with sizes from the
   browser size table (em of --eq-size, the largest box seen for that id in the class); without a table a representative
   box (13 × 2.6 em; chain 3 rows). */
export function eqItemsFor(fs, {cls, type, bands, story, table, reduced}) {
  const eqMax = (BANDS[cls] || {}).eqMax || 1;
  let plan;
  if (story && story.eq) plan = planEquations(fs, story.eq, {cls, beats: story.beats, reducedMotion: reduced}).map(e => ({id: e.key, mode: e.mode, chain: !!e.chain}));
  else plan = (fs.eqs || []).slice(0, eqMax).map(e => ({id: e.id, mode: isPhone(cls) ? "chip" : "value", chain: false}));
  const px = type.eq, maxW = Math.floor(bands.eq ? bands.eq.w : bands.text ? bands.text.w : 320);
  return plan.slice(0, Math.max(eqMax, 1)).map(e => {
    const t = table && table.eqs && (table.eqs[e.id] || table.eqs["eq:" + e.id]);
    const fit = (w, h, font) => {
      if (w > maxW) { const rows = Math.ceil(w / maxW); w = maxW; h = Math.max(h, rows * Math.max(44, px * 1.3) + px * 0.6); }
      return {w: Math.min(maxW, Math.ceil(w)), h: Math.ceil(h), font};
    };
    const size = fit(t ? t.w * px : px * 13, t ? t.h * px : px * (e.chain ? 8.4 : 2.6), px);
    // the measured fallbacks (U_eq: natural, value-line "chip", headline "short"), same order as overlay.equations, so the
    // solver's Box.variant index means the same box in node and in the page
    const vs = t && t.variants && t.variants.length ? t.variants.map(v => ({...fit(v.w * px, v.h * px, v.font || px), key: v.key})) : null;
    return vs ? {id: e.id, size, variants: vs} : {id: e.id, size};
  });
}

/* The whole drawn beam as one solver corridor (review2 ux H2, beauty L5): the stage draws the lit tube and the dashed guide
   from -half to +half, so the corridor is that full line, clipped to the near plane (a straight line stays straight under
   perspective, so one segment is exact). The page must use this too (main.js still registered only l-40..l+60, and dropped
   the corridor whenever an end projected behind the camera). P(l) -> world point; returns {id, a, b, r} or null. */
export function beamCorridor(cam, view, P, half, r = 12) {
  const seg = projectSegment(cam, view, P(-half), P(half), 1);
  return seg ? {id: "beam", a: seg[0], b: seg[1], r} : null;
}

/* itemsFor(fs, ctx) -> {items, ctx: {w, h, cls, bands, corridors}}: the same frame composer the page runs (frameItems),
   for node G1 (story_layout.mjs, U_qa's story_overlap.mjs). Pure.
   ctx = {w, h | viewport: {w, h}, reduced, insets?, hint?,
          story?: {beats, copy, lookup?, flags?, eq?}   (or sizes[cls].story from the browser size table),
          sizes?: {[cls]: table}                          (index.html?sizetable=1 / __story.sizeTable()),
          prep?: seek.prepare(data, beats, shots)          (real camera projection: beam corridor, act anchors, plaque, tags),
          dockKids?: bands -> [{id, rect, kind?}], cell?: {nH, T, v, f, ion} (plaque values)} */
export function itemsFor(fs, ctx = {}) {
  const w = ctx.w || (ctx.viewport && ctx.viewport.w), h = ctx.h || (ctx.viewport && ctx.viewport.h);
  const cls = layoutClass(w, h), type = typeScale(cls, w, h), table = tableFor(ctx.sizes, cls);
  const story = ctx.story || (table && table.story) || {}, flags = story.flags || {};
  const dock = (fs.spec && fs.spec.dock) || "strip", side = (fs.cam && fs.cam.textSide) || "left";
  const bandsFn = (sd, dk) => computeBands(cls, w, h, {textSide: sd, dock: dk, insets: ctx.insets});
  const bands = bandsFn(side, dock);
  const corridors = [];
  let screenOf = () => null, probe = null;
  const prep = ctx.prep;
  if (prep && prep.frame && fs.cam) {
    const P = l => prep.frame.P(l);
    // same probe keep-in as main.js (review F3)
    const kw = story.beats && prep.half != null && isFinite(fs.l) ? keepWeight(story.beats, fs.p, fs.l, prep.half) : 0;
    const keep = kw > 0 ? {pt: P(fs.l), pts: keepPts(fs, prep.cellPos), marginPx: KEEP_MARGIN_PX, rect: bands.world, weight: kw} : null;
    const view = viewFor(fs.cam, w, h, bandsFn, {dock, dockFrom: fs.spec && fs.spec.dockFrom, dockMix: fs.spec && fs.spec.dockMix, keep});
    screenOf = l => { if (l == null || !isFinite(l)) return null; const r = project(fs.cam, view, P(l)); return r && r.ok && r.x >= 0 && r.y >= 0 && r.x <= w && r.y <= h ? {x: r.x, y: r.y} : null; };
    if (!(fs.ui && fs.ui.inset >= 0.5)) {           // phones draw the 3D as an inset in B12-B14
      const c = beamCorridor(fs.cam, view, P, prep.half); if (c) corridors.push(c);
    }
    probe = screenOf(fs.l);
  }
  const text = activeText(fs.text, flags).map(t => {
    if (t.band !== "act" || !t.anchor) return t;
    const sc = screenOf(anchorL(t.anchor, prep, fs));
    return sc ? {...t, screen: sc} : t;
  });
  const models = new Map();
  const modelFor = t => {
    const level = t.band === "act" ? 0 : 1, k = `${textKey(t)}|${level}`;
    if (!models.has(k)) models.set(k, groupModel(copyEntry(story.copy, t.id, flags), bands.text, type, level, story.lookup || null, t.part || "all"));
    return models.get(k);
  };
  const dk = bands.dock;
  const dockKids = ctx.dockKids ? ctx.dockKids(bands) : dk ? [{id: "ion", rect: {x: dk.x + 8, y: dk.y + 6, w: Math.min(60, dk.w - 16), h: 16}},
    {id: "axis", rect: {x: dk.x + Math.max(8, dk.w - 140), y: dk.y + dk.h - 20, w: Math.min(132, dk.w - 16), h: 16}}] : [];
  const tags = [];
  if (prep && prep.clouds) for (const c of prep.clouds) {
    if (!c.letter || tags.some(t => t.id === "chip:" + c.letter)) continue;
    const mid = (c.l_in + c.l_out) / 2;
    if (Math.abs(mid - fs.l) > 60) continue;
    const sc = screenOf(mid); if (!sc) continue;
    const label = "Cloud " + c.letter;
    tags.push({id: "chip:" + c.letter, anchor: sc, size: {w: Math.ceil(textWidth(label, "sans", 12)) + 24, h: 26, font: 12}});
  }
  const cell = ctx.cell || {nH: 1.23e-3, T: 1.15e4, v: -151.6, f: 0.234, ion: (fs.spec && fs.spec.lead) === "HI" ? "H I" : "O VI"};
  const env = {cls, bands, type, modelFor, act: actFor(story.beats, fs.beat ? fs.beat.i : 0, story.copy || {}),
               legend: tfLegend(fs.tf, story.copy || null), hint: ctx.hint != null ? !!ctx.hint : fs.p < 0.02,
               hintText: HINT_TEXT.fine, plaque: probe && fs.cell && !ctx.reduced ? {lines: plaqueLines(cell), anchor: probe} : null,
               eqs: eqItemsFor(fs, {cls, type, bands, story, table, reduced: ctx.reduced}), dockKids, tags, reduced: !!ctx.reduced,
               insetTop: (ctx.insets && ctx.insets.top) || 0, maxKpc: prep ? Math.round(2 * prep.half) : 493,
               // the end actions, exactly as the page composes them (review2 ux H1: node G1 never saw them)
               end: endState(fs, story.beats, END_IDS.map(k => uiText(story.copy, k, k)), END_IDS.map(k => uiText(story.copy, k + "_short", uiText(story.copy, k, k))))};
  const items = frameItems({...fs, text}, env);
  return {items, ctx: {w, h, cls, bands, corridors}};
}

/* ---------------------------------------------------------------- browser size table (node G1 input) */
/* Measures, after document.fonts.ready, at the current viewport (one representative per layout class):
   - every text slot of beats.json resolved against the data keys and flags, every variant at every band width the class
     produces (dock strip / pair / hero × text side), model box vs real DOM box (the solver's boxes must never be smaller);
   - every equation id through U_eq's real overlay (values filled), over 160 seek frames: the largest box, in em of
     --eq-size.
   deps = {copy, lookup, flags, layer, beats (U_motion beats), seek: (p, overrides) -> fs, overlay (U_eq createOverlay on a
   hidden layer), eq (eq.json), w, h}. Returns {schema, cls, w, h, eqPx, story, eqs, text}. */
export async function captureStorySizes(d) {
  if (typeof document !== "undefined" && document.fonts) await document.fonts.ready;
  const w = d.w || innerWidth, h = d.h || innerHeight, cls = layoutClass(w, h), type = typeScale(cls, w, h);
  const flags = d.flags || {}, beats = d.beats || [];
  const res = s => (s == null ? s : d.lookup ? resolveTemplate(s, d.lookup).text : s);
  const copy = {ui: d.copy && d.copy.ui};
  for (const b of beats) {
    const base = d.copy[b.copyRef || b.id] || {};
    copy[b.copyRef || b.id] = {...(copy[b.copyRef || b.id] || {}), chip: base.chip};
    for (const t of b.text || []) {
      const e = copyEntry(d.copy, t.id, flags); if (!e) continue;
      copy[t.id] = {...(copy[t.id] || {}), display: res(e.display), display_short: res(e.display_short), sub: res(e.sub), sub_short: res(e.sub_short)};
      if (t.id === (b.copyRef || b.id)) copy[t.id].chip = base.chip;
    }
  }
  const eqLite = d.eq ? {eqs: Object.fromEntries(Object.entries(d.eq.eqs).map(([k, v]) => [k, {title: v.title, variants: v.variants}]))} : null;
  const story = {beats: beats.map(b => ({id: b.id, copyRef: b.copyRef, eqs: (b.eqs || []).map(e => (typeof e === "string" ? e : e.id))})),
                 copy, flags, eq: eqLite};
  // text: model vs real
  const widths = new Map();
  for (const dock of ["strip", "pair", "hero"]) for (const side of ["left", "right"]) {
    const bd = computeBands(cls, w, h, {dock, textSide: side}); if (bd.text) widths.set(Math.round(bd.text.w), bd.text);
  }
  const probe = document.createElement("div");
  probe.className = "kt kt-probe"; probe.style.cssText = "position:absolute;left:0;top:0;visibility:hidden";
  d.layer.appendChild(probe);
  const over = []; let checked = 0, worstW = 0, worstH = 0;
  for (const b of beats) for (const t of b.text || []) for (const band of widths.values()) {
    const m = groupModel(copy[t.id], band, type, t.band === "act" ? 0 : 1, null, t.part || "all");
    for (const v of m.variants) {
      probe.style.setProperty("--dpx", v.dpx + "px"); probe.style.setProperty("--spx", v.spx + "px"); probe.style.width = "auto";
      probe.innerHTML = `<div class="kt-c kt-sharp" style="position:static">${v.html}</div>`;
      const r = probe.firstChild.getBoundingClientRect(); checked++;
      const dw = r.width - v.w, dh = r.height - v.h; worstW = Math.max(worstW, dw); worstH = Math.max(worstH, dh);
      if (dw > 0.5 || dh > 0.5) over.push({id: t.id, part: t.part, key: v.key, model: [v.w, v.h], real: [Math.ceil(r.width), Math.ceil(r.height)]});
    }
  }
  probe.remove();
  // equations: real overlay boxes
  const eqs = {};
  if (d.overlay && d.seek) {
    const host = (d.layer.closest && d.layer.closest("#stage")) || document.documentElement;
    host.style.setProperty("--eq-size", type.eq + "px");          // the shell sets this in resize(); the capture page has no shell
    const bandsAt = fs => computeBands(cls, w, h, {dock: (fs.spec && fs.spec.dock) || "strip", textSide: (fs.cam && fs.cam.textSide) || "left"});
    for (let i = 0; i < 160; i++) {
      const fs = d.seek((i + 0.5) / 160, {cls}), bd = bandsAt(fs);
      const items = d.overlay.equations(fs, {cls, live: null, beats, maxW: bd.eq ? bd.eq.w : bd.text ? bd.text.w : w});
      for (const it of items || []) if (it.size) {
        const e = eqs[it.id] || (eqs[it.id] = {w: 0, h: 0, variants: []});
        e.w = Math.max(e.w, it.size.w / type.eq); e.h = Math.max(e.h, it.size.h / type.eq);
        // U_eq's fallbacks in solver order (natural, "chip", "short"): the worst box per key over every frame
        for (const v of it.variants || []) {
          let r = e.variants.find(x => x.key === v.key); if (!r) e.variants.push(r = {key: v.key, w: 0, h: 0, font: v.font});
          r.w = Math.max(r.w, v.w / type.eq); r.h = Math.max(r.h, v.h / type.eq); r.font = Math.min(r.font, v.font);
        }
      }
    }
  }
  return {schema: "story-sizes/1", cls, w, h, eqPx: type.eq, story, eqs,
          text: {checked, widths: [...widths.keys()], worstOverW: +worstW.toFixed(2), worstOverH: +worstH.toFixed(2), over: over.slice(0, 40)}};
}

/* the classes one representative viewport each (for the capture loop) */
export function sizeTableViewports() {
  const reps = new Map();
  for (const m of g1Matrix()) { const c = layoutClass(m.w, m.h); if (!reps.has(c)) reps.set(c, {w: m.w, h: m.h, vw: m.vw, vh: m.vh, zoom: m.zoom}); }
  for (const [w, h] of [[683, 512], [260, 563]]) { const c = layoutClass(w, h); if (!reps.has(c)) reps.set(c, {w, h, vw: w, vh: h, zoom: 1}); }
  return Object.fromEntries(reps);
}

