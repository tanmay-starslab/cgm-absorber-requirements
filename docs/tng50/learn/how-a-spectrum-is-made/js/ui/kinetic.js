// Kinetic type (DESIGN §8.3, DESIGN_final §1.3 P0-6, P1-6, §3.3, §5.6).
// - Act titles (B1, B2, B5, B7a, B9, B11) are z-planes on the ray: the box stays in the text band (so the solver can prove
//   zero overlap) while depth is felt through scale, blur and opacity driven by the camera's distance to the title's ℓ.
// - In-beat lines live in the fixed text band and are scrubbed by fs.text[].phase (-1 before, 0 in focus, +1 after).
// - One kinetic group per band (display + subtitle are one box); exit ends below 0.02 opacity before the next enters.
// - Focus pull = two stacked copies (one pre-blurred, one sharp) cross-faded; only opacity and transform animate.
//
// Pure part (node and browser): FONT_METRICS, textWidth, wrapText, parseAccent, groupModel, kineticItems, focusStyle.
// DOM part: createKinetic(layer).render(fs, solved, models).
// Sizes come from per-character advances measured in Chrome with the vendored fonts (tools/metrics.mjs in the U_shell
// scratch), summed without kerning: that overestimates real widths by about 1.5 %, and every line is rendered nowrap with
// the solver's breaks, so a real box never exceeds its solver box.

import {resolveTemplate} from "../engine.js";

/* advance widths in 1/1000 em, index = position in `chars`; fonts: Newsreader display 400 (serif) and italic (serifI),
   Space Grotesk 400 / 500 (sans, sans5), JetBrains Mono 400 (mono). Unknown characters use the width of "M". */
export const FONT_METRICS = {"chars":" !\"#$%&'()*+,-./0123456789:;<=>?@ABCDEFGHIJKLMNOPQRSTUVWXYZ[\\]^_`abcdefghijklmnopqrstuvwxyz{|}~–—‘’“”…−→×°  ±⅓≈","serif":"230,260,340,580,580,780,730,190,270,270,410,540,230,330,230,390,580,580,580,580,580,580,580,580,580,580,260,270,540,540,540,450,890,710,640,700,760,650,590,750,800,340,410,740,600,990,770,780,610,780,660,550,690,770,690,980,710,680,640,300,390,300,540,410,500,480,560,450,570,470,340,490,570,270,250,550,260,840,570,540,570,550,390,390,340,550,540,760,530,530,440,300,230,300,540,500,670,230,230,400,410,650,540,1000,540,380,200,230,540,750,549","serifI":"230,260,340,580,580,780,680,190,270,270,410,540,230,320,220,400,580,580,580,580,580,580,580,650,580,580,260,260,540,540,540,460,900,680,620,680,740,630,570,730,780,330,390,700,580,960,740,760,600,760,650,530,650,750,660,930,670,650,610,300,370,300,540,390,500,490,470,380,490,390,290,420,500,280,250,470,260,770,540,440,520,470,400,340,310,510,460,680,480,480,400,290,240,290,540,480,640,230,230,400,400,640,540,1000,540,380,200,230,540,750,549","sans":"260,250,430,630,610,770,600,250,380,380,520,620,250,460,250,370,640,420,600,600,630,600,610,560,620,610,250,250,620,620,620,580,1030,630,660,640,660,560,540,660,660,240,590,610,550,870,660,670,600,670,630,610,590,670,620,880,640,610,580,340,370,340,620,620,280,580,640,600,640,590,440,640,610,250,250,540,250,860,610,620,640,640,380,530,460,610,540,800,590,610,520,430,240,430,620,610,910,250,250,430,430,680,620,1000,620,380,190,260,620,750,549","sans5":"260,280,470,630,610,770,600,270,390,380,530,620,270,440,280,380,650,440,600,610,630,600,620,560,610,620,280,280,620,620,620,580,1020,630,660,640,670,560,540,660,660,250,600,620,540,870,670,670,600,670,630,610,590,670,620,890,640,620,580,350,380,350,620,620,290,580,640,590,640,580,440,640,620,260,260,550,260,860,620,620,640,640,390,530,460,610,540,790,590,610,520,450,250,450,620,600,900,270,270,470,470,740,620,1000,620,390,190,260,620,750,549","mono":"600,600,600,600,600,600,600,600,600,600,600,600,600,600,600,600,600,600,600,600,600,600,600,600,600,600,600,600,600,600,600,600,600,600,600,600,600,600,600,600,600,600,600,600,600,600,600,600,600,600,600,600,600,600,600,600,600,600,600,600,600,600,600,600,600,600,600,600,600,600,600,600,600,600,600,600,600,600,600,600,600,600,600,600,600,600,600,600,600,600,600,600,600,600,600,600,600,600,600,600,600,600,600,1000,600,600,200,600,600,750,549"};
const IDX = new Map();
if (FONT_METRICS) { [...FONT_METRICS.chars].forEach((c, i) => IDX.set(c, i)); for (const k of ["serif", "serifI", "sans", "sans5", "mono"]) FONT_METRICS[k + "A"] = FONT_METRICS[k].split(",").map(Number); }
export const SAFETY = 1.02;                               // extra width so sub-pixel rounding never wraps a line

export function textWidth(s, face, px) {
  const a = FONT_METRICS[face + "A"], M = a[IDX.get("M")];
  let w = 0;
  for (const ch of String(s)) { const i = IDX.get(ch); w += i == null ? M : a[i]; }
  return w / 1000 * px * SAFETY;
}

/* markup: *accent* -> italic accent segment. Returns [{t, em}] */
export function parseAccent(s) {
  const out = [], re = /\*([^*]+)\*/g;
  let last = 0, m;
  s = String(s || "");
  while ((m = re.exec(s))) { if (m.index > last) out.push({t: s.slice(last, m.index), em: false}); out.push({t: m[1], em: true}); last = m.index + m[0].length; }
  if (last < s.length) out.push({t: s.slice(last), em: false});
  return out;
}
const esc = s => String(s).replace(/[&<>"]/g, c => ({"&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;"}[c]));

/* Greedy word wrap of accent segments. face: base face ("serif" | "sans"); italic segments use face + "I" when it exists.
   -> {lines: [[{t, em}]], w, n} ; w = widest line in px */
export function wrapText(segs, face, px, maxW) {
  const words = [];
  for (const sg of segs) for (const part of sg.t.split(/(\s+)/)) if (part && !/^\s+$/.test(part)) words.push({t: part, em: sg.em});
  const fw = wd => textWidth(wd.t, wd.em && FONT_METRICS[face + "IA"] ? face + "I" : face, px);
  const space = textWidth(" ", face, px);
  const lines = []; let cur = [], cw = 0, widest = 0;
  for (const wd of words) {
    const w = fw(wd);
    if (cur.length && cw + space + w > maxW) { lines.push(cur); widest = Math.max(widest, cw); cur = []; cw = 0; }
    cw += (cur.length ? space : 0) + w; cur.push(wd);
  }
  if (cur.length) { lines.push(cur); widest = Math.max(widest, cw); }
  return {lines, w: widest, n: lines.length, overflow: widest > maxW + 0.5};
}

export const LEADING = {display: 1.08, sub: 1.45};
export const SUB_GAP = 0.45;                               // em of the display size between display and subtitle

/* keyOf(word) -> story key name for words that came from a resolved {{key}} and contain digits: they render inside
   <span data-key> (G10: digits in visible DOM text only inside [data-key] / [data-num]); widths do not change */
const PUNCT = /^[([“‘"']+|[)\]”’"'.,;:!?…]+$/g;
function linesHtml(lines, cls, keyOf = null) {
  const word = wd => { const k = keyOf && /\d/.test(wd.t) ? keyOf(wd.t.replace(PUNCT, "")) : null;
    const t = k ? `<span data-key="${esc(k)}">${esc(wd.t)}</span>` : esc(wd.t); return wd.em ? `<em>${t}</em>` : t; };
  return lines.map(l => `<span class="${cls}">` + l.map(word).join(" ") + "</span>").join("");
}

/* Balanced wrap (review2 beauty L1: no one-word orphan such as "How a spectrum is / made"): keep the greedy line count and
   take the narrowest width that still gives it (bisection on the same greedy breaker, so DOM and model agree). */
export function wrapBalanced(segs, face, px, maxW) {
  const g = wrapText(segs, face, px, maxW);
  if (g.n < 2 || g.overflow) return g;
  let lo = g.w / g.n, hi = g.w, best = g;
  for (let k = 0; k < 18 && hi - lo > 0.5; k++) {
    const mid = (lo + hi) / 2, r = wrapText(segs, face, px, mid);
    if (r.n === g.n && !r.overflow) { best = r; hi = mid; } else lo = mid;
  }
  return {...best, overflow: false};
}
/* One text group (display + subtitle) laid out at one size. Returns null when it breaks a rule (lines, floor, width). */
function layoutGroup(disp, sub, dpx, spx, maxW, rules) {
  let d = disp ? wrapBalanced(parseAccent(disp), "serif", dpx, maxW) : {lines: [], w: 0, n: 0};
  if (disp && rules.wordsPerLine && d.lines.some(l => l.length > rules.wordsPerLine)) d = wrapText(parseAccent(disp), "serif", dpx, maxW);
  if (d.overflow || d.n > rules.displayLines) return null;
  if (disp && rules.wordsPerLine && d.lines.some(l => l.length > rules.wordsPerLine)) return null;
  const s = sub ? wrapText(parseAccent(sub), "sans", spx, Math.min(maxW, spx * 34)) : {lines: [], w: 0, n: 0};
  if (s.overflow || s.n > rules.subLines) return null;
  const hD = d.n * dpx * LEADING.display, hS = s.n * spx * LEADING.sub, gap = d.n && s.n ? dpx * SUB_GAP : 0;
  return {w: Math.min(Math.ceil(Math.max(d.w, s.w)), Math.floor(maxW)), h: Math.ceil(hD + gap + hS), font: Math.min(d.n ? dpx : 99, s.n ? spx : 99), dpx, spx,
          dLines: d.lines, sLines: s.lines, html: (d.n ? `<span class="kt-d">${linesHtml(d.lines, "kt-l", rules.keyOf)}</span>` : "") +
          (s.n ? `<span class="kt-s">${linesHtml(s.lines, "kt-l", rules.keyOf)}</span>` : "")};
}

/* copy.json id -> entry: "B5" or "B5.0" (top level), "B5.1" (an item of B5.then), "B7c.hot" (B7c.states.hot or B7c.hot).
   flags (story JSON `flags`, U_data): an entry's `extra: {when, sub}` is appended to its sub when flags[when] holds; a
   missing flag counts as false (copy.flags rule), so the conservative line shows. Short variants never take the extra.
   Unknown ids -> null (the caller skips them; the copy lint reports). */
export function copyEntry(copy, id, flags = null) {
  if (!copy || !id) return null;
  const e = rawEntry(copy, String(id));
  if (!e || !e.extra || !e.extra.sub || !(flags && flags[e.extra.when] === true)) return e;
  return {...e, sub: e.sub ? `${e.sub} ${e.extra.sub}` : e.extra.sub};
}
function rawEntry(copy, id) {
  if (copy[id] && typeof copy[id] === "object") return copy[id];
  const dot = id.indexOf(".");
  if (dot < 0) return null;
  const base = copy[id.slice(0, dot)], suf = id.slice(dot + 1);
  if (!base || typeof base !== "object") return null;
  if (suf === "0") return base;
  const inThen = Array.isArray(base.then) ? base.then.find(x => x && x.id === id) : null;
  if (inThen) return inThen;
  if (base.states && base.states[suf]) return base.states[suf];
  if (base[suf] && typeof base[suf] === "object" && (base[suf].display || base[suf].sub)) return base[suf];
  return null;
}

/* Text model for one copy entry in one layout: variants in preference order (full copy at the level size, then smaller
   levels, then display_short / sub_short, then display alone). The solver picks the first that fits; none is below 12 px.
   copyEntry = {display, display_short, sub, sub_short}; level 0 = act title, 1 = beat line; part = "all" | "display" | "sub". */
export function groupModel(copyEntry, band, type, level = 1, lookup = null, part = "all") {
  if (!copyEntry || !band) return {variants: []};
  // a missing key stays visible as {{key}} (lint); digit-bearing words of resolved values are remembered for data-key
  const keyWords = new Map();
  const res = s => (s && lookup ? String(s).replace(/\{\{\s*([\w.$]+)\s*\}\}/g, (m, k) => {
    const v = resolveTemplate(m, lookup).text;
    if (v !== m) for (const piece of v.split(/\s+/)) if (/\d/.test(piece)) keyWords.set(piece.replace(PUNCT, ""), k);
    return v;
  }) : s);
  const wantD = part !== "sub", wantS = part !== "display";
  const D = wantD ? res(copyEntry.display) : null, Ds = wantD ? res(copyEntry.display_short || copyEntry.display) : null;
  const S = wantS ? res(copyEntry.sub) : null, Ss = wantS ? res(copyEntry.sub_short || "") : null;
  const narrow = type.wordsPerLine === 5;
  const rules = {displayLines: type.displayLines, wordsPerLine: type.wordsPerLine, subLines: narrow ? 3 : 4,
                 keyOf: w => keyWords.get(w) || null};
  const levels = [type.display[level], type.display[Math.min(2, level + 1)], type.display[2]].filter((v, i, a) => a.indexOf(v) === i);
  const subs = [type.sub, Math.max(14, type.sub - 2)];
  const combos = [];
  const dOpts = !wantD ? [null] : narrow ? [Ds] : [D, Ds];
  // a sub-only group always keeps a subtitle; a display group may drop it
  const sOpts = !wantS ? [null] : !wantD ? (narrow ? [Ss || S] : [S, Ss || null].filter(Boolean)) : narrow ? [Ss || null, null] : [S, Ss || null, null];
  for (const so of sOpts) for (const dd of dOpts) for (const lv of levels) for (const sp of subs) combos.push([dd, so, lv, sp]);
  const seen = new Set(), variants = [];
  for (const [dd, so, lv, sp] of combos) {
    if (!dd && !so) continue;
    const key = [dd, so, dd ? lv : 0, so ? sp : 0].join("|");
    if (seen.has(key)) continue; seen.add(key);
    const g = layoutGroup(dd, so, lv, sp, band.w, rules);
    if (g) variants.push({...g, key, hasSub: !!so, short: dd !== D});
    if (variants.length >= 8) break;
  }
  return {variants};
}
export const textKey = t => `${t.id}/${t.part || "all"}`;

/* scrubbed focus curve from phase (-1 before, 0 focus, +1 after). Entry: opacity 0 → 1, rise 0.3 em, blur copy → sharp copy.
   Exit: sharp → slight blur, scale 1 → 1.06, opacity → 0 (below 0.02 at phase ≥ 0.98). Pure. */
const sstep = (a, b, x) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };
export function focusStyle(phase, reduced = false) {
  if (reduced) { const on = phase > -0.5 && phase < 0.5; return {opacity: on ? 1 : 0, sharp: 1, rise: 0, scale: 1}; }
  const inT = sstep(-1, -0.35, phase), outT = sstep(0.45, 0.97, phase);
  const opacity = inT * (1 - outT);
  return {opacity: opacity < 0.02 ? 0 : opacity, sharp: sstep(-0.8, -0.2, phase) * (1 - 0.6 * outT), rise: (1 - inT) * 0.3,
          scale: 1 + 0.06 * outT};
}

/* A5 depth cue for act titles (pure). dz = title ℓ − camera ℓ along the beam (kpc; > 0 ahead). Far ahead the title is
   small and soft (0.85, half blurred), it comes into focus at full size as the camera reaches its ℓ and stays there after
   it is passed (the exit scale then takes over). D = depth range in kpc. */
export function depthCue(dz, D = 60) {
  if (!Number.isFinite(dz)) return null;
  const a = Math.max(0, Math.min(1, dz / D)), e = a * a * (3 - 2 * a);
  return {scale: 1 - 0.15 * e, soft: 0.5 * e};
}
/* fix1 r4 (review1 scrolly S3 / beauty M1): the depth cue is an ENTRY cue only. It is full while the title fades in and
   gone by the start of the title's full-opacity window (focusStyle: opacity 1 from phase -0.35), so every readPoint and
   the whole reading window draw the title crisp and at full size, however far ahead its anchor still is. */
export function depthCueAt(cue, phase) {
  if (!cue) return null;
  const w = 1 - sstep(-0.8, -0.35, phase);
  if (!(w > 0)) return null;
  return {scale: 1 - (1 - cue.scale) * w, soft: cue.soft * w};
}

/* Items for the solver. textEntries = fs.text ([{id, band, phase, part?, screen?}]); modelFor(t) -> groupModel.
   band "act" (z-plane act titles) may use the text column or, failing that, the free stage above the dock, and is placed
   near its projected anchor (t.screen) when the stage supplies one. Boxes keep the natural size (scale/rise are transforms). */
export function kineticItems(textEntries, modelFor, opts = {}) {
  const items = [], bands = opts.bands || {};
  const column = bands.cls === "desktop" || bands.cls === "compact";
  for (const t of textEntries || []) {
    const m = modelFor(t); if (!m || !m.variants.length) continue;
    const f = focusStyle(t.phase, opts.reduced);
    const band = t.band || "text", act = band === "act", bb = bands[act ? "act" : band];
    // review2 scrolly A6: the solver box is the variant's natural size for the whole life of the group. The exit scale and
    // the entry rise are drawn as a transform only (they may overflow the box by a few px while the group is faint), so the
    // box never changes size mid-fade and the solver's hysteresis keeps both the slot and the variant until it is gone.
    const fit = v => ({w: Math.ceil(v.w), h: Math.ceil(v.h)});
    // act titles are z-planes in the scene: near their projected anchor, else on the world side of a column layout,
    // else low on a full-width stage (a lower third above the dock), so they never take the text column from a line
    const it = {id: "kt:" + textKey(t), kind: "display", priority: act ? 71 : 70, band, groupBand: band,
                group: "kt:" + textKey(t), opacity: f.opacity, pad: 0,
                align: act && column ? (bands.side === "right" ? "start" : "end") : "start",
                vAlign: act && !column ? "bottom" : "top",
                variants: m.variants.map(v => ({...fit(v), font: v.font, key: v.key}))};
    if (act && bands.text) { it.avoidBands = ["text"]; it.avoidSoft = true; }
    // full-width stages (tablet, phones): when the beam crosses the top text band, the line drops into the world band
    // (the solver's fallbackBand) instead of being hidden (G9: a jump must land on narration)
    if (!act && !column && band === "text" && bands.world) { it.fallbackBand = "world"; it.vAlign = "top"; }
    if (act && t.screen && isFinite(t.screen.x) && isFinite(t.screen.y)) { it.anchor = t.screen; it.gap = 16; it.fallback = "band"; it.candidates = ["ne", "e", "nw", "w", "n", "s"]; }
    items.push(it);
  }
  return items;
}

/* ---------------------------------------------------------------- DOM */
export function createKinetic(layer) {
  const els = new Map();
  function el(id) {
    let e = els.get(id);
    if (!e) {
      e = document.createElement("div"); e.className = "kt"; e.dataset.kt = id; e.dataset.group = "kt:" + id;
      e.innerHTML = `<div class="kt-c kt-blur" aria-hidden="true"></div><div class="kt-c kt-sharp"></div>`;
      layer.appendChild(e); els.set(id, e); e._v = null;
    }
    return e;
  }
  /* entries = fs.text, solved = layout result, modelFor(t) -> groupModel, opts {reduced, acts} */
  function render(entries, solved, modelFor, opts = {}) {
    const live = new Set();
    for (const t of entries || []) {
      const k = textKey(t), box = solved.byId["kt:" + k], m = box ? modelFor(t) : null;
      if (!box || !m) continue;
      const v = m.variants[box.variant] || m.variants[0], e = el(k); live.add(k);
      if (e._v !== v.key) {
        e._v = v.key; e.style.setProperty("--dpx", v.dpx + "px"); e.style.setProperty("--spx", v.spx + "px");
        e.style.width = Math.ceil(v.w) + "px"; e.children[0].innerHTML = v.html; e.children[1].innerHTML = v.html;
        e.classList.toggle("kt-act", t.band === "act"); e.dataset.band = t.band; e.classList.toggle("kt-subonly", !v.dLines.length);
      }
      const f = focusStyle(t.phase, opts.reduced);
      // A6: scale and rise are transforms only. A5: act titles are z-planes; opts.depth(t) -> {scale, soft} from the camera's
      // ℓ-distance to the title (scale ≤ 1 so the drawn glyphs never leave the solver box; soft adds focus blur far away)
      const dz = t.band === "act" && opts.depth && !opts.reduced ? depthCueAt(opts.depth(t), t.phase) : null;
      const sc = f.scale * (dz ? dz.scale : 1), rise = v.dpx * f.rise;
      e.style.opacity = (f.opacity * (box.fade ?? 1)).toFixed(3);   // box.fade: the shell's follower crossfade (SC2-1)
      e.style.transform = `translate3d(${box.x.toFixed(1)}px,${(box.y + rise).toFixed(1)}px,0) scale(${sc.toFixed(4)})`;
      const sharp = f.sharp * (dz ? 1 - dz.soft : 1);
      e.children[0].style.opacity = (1 - sharp).toFixed(3);
      e.children[1].style.opacity = sharp.toFixed(3);
      e.hidden = false;
    }
    for (const [id, e] of els) if (!live.has(id)) e.hidden = true;
  }
  return {render, els};
}

/* Size table for the node G1 run (DESIGN_final §1.1 P1-5): real DOM boxes of every copy variant at every class, after
   document.fonts.ready. Called by index.html?sizetable=1. Returns [{id, cls, key, model: {w, h}, real: {w, h}}]. */
export async function captureSizeTable(copy, classes, layer) {
  await document.fonts.ready;
  const out = [], probe = document.createElement("div");
  probe.className = "kt kt-probe"; probe.style.cssText = "position:absolute;left:0;top:0;visibility:hidden";
  layer.appendChild(probe);
  for (const c of classes) for (const id of Object.keys(copy)) {
    const m = groupModel(copy[id], c.band, c.type, c.level ?? 1);
    for (const v of m.variants) {
      probe.style.setProperty("--dpx", v.dpx + "px"); probe.style.setProperty("--spx", v.spx + "px"); probe.style.width = "auto";
      probe.innerHTML = `<div class="kt-c kt-sharp" style="position:static">${v.html}</div>`;
      const r = probe.firstChild.getBoundingClientRect();
      out.push({id, cls: c.cls, key: v.key, model: {w: v.w, h: v.h}, real: {w: Math.ceil(r.width), h: Math.ceil(r.height)}});
    }
  }
  probe.remove();
  return out;
}
