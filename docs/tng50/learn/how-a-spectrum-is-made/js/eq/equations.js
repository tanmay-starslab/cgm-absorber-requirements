// Floating, bound, draggable equations of the story (DESIGN_final §3.1 D7, §5.5 U_eq; DESIGN §7; R_content §3).
//
// The HTML comes from eq/eq.json (KaTeX at build time, scripts/story_eq_build.mjs); the page ships no katex.js. This
// module decides which equations show for a FrameState, fills their bound numbers (js/eq/bind.js), and turns their
// terms into hover/tap/drag/keyboard controls whose ghost overrides go on the bus. Placement belongs to the layout
// solver (U_shell): equations(fs) reports {id, size, anchor, html}; render(fs, placed) applies the solver's boxes.
//
//   import {loadEq, createOverlay, planEquations} from "./js/eq/equations.js";
//   const eq = await loadEq();
//   const overlay = createOverlay({eq, data, fion, bus, root: document.querySelector("#eq-layer")});
//   per frame:  const items = overlay.equations(fs, {cls, live, beats});   // sizes measured once per layout signature
//               overlay.render(fs, layout.solve(items, cls) /* {id: {x, y, hidden}} */, {cls, live, beats});
//
// Bus events (bus.emit(type, payload); bus.on is not required):
//   "hover"    {term, eq, prop, ion, cellIdx} | null           term hover / tap (the bead plaque and dip handles glow)
//   "override" {key: "ghost", value: ghost | null}            ghost copy of the cell (bind.js ghostCell); never data
//   "override" {key: "T125" | "T263" | "N492", value | null}  the frozen named overrides when the ghost is one of them
//   "override" {key: "R" | "sn", value}                       E6/E7 terms set the instrument (persist; no spring back)
// Ghosts spring back on release (0.45 s, critically damped; reduced motion: instant) unless pinned (Pin button or P).

import {quantR} from "../scenes/lsf.js";
import {termValues, formatParts, sliderSpec, sliderToValue, ghostCell, namedOverride, spoken} from "./bind.js";

/* review M7: the equations bind the R the dock plots. A noiseless observed spectrum is drawn at quantR(R) (2 significant
   figures, spectrum/dock.js), so E6's R and FWHM use the same rounded value; noisy and other modes keep the raw R. */
export function plottedSpec(sp) {
  if (!sp) return {};
  const noisy = Number.isFinite(sp.sn) && sp.sn > 0 && sp.sn < 500;
  return sp.mode === "observed" && !noisy && Number.isFinite(sp.R) ? {...sp, R: quantR(sp.R)} : sp;
}

export const EQ_URL = new URL("../../eq/eq.json", import.meta.url).href;
export const KATEX_CSS = new URL("../../vendor/katex/katex.css", import.meta.url).href;
// layout classes: js/ui/layoutclass.js names (phonePortrait, ...); the spaced spellings are kept for older callers
const PHONE = new Set(["phonePortrait", "phoneLandscape", "narrow", "phone portrait", "phone landscape", "phone"]);
const ONE = new Set(["compact"]);          // classes whose eq band holds one equation (BANDS[cls].eqMax = 1)
// tablet portrait: the eq band is a 10 %-tall strip (layoutclass y 22-32 %), too short for the three-row B7b block, so the chain
// steps one row at a time there as on phones (other beats keep two equations side by side)
const STEP_CHAIN = new Set(["tablet", "tablet portrait"]);
const CHAIN = ["E1", "E2", "E3"];          // B7b: E1 -> E2 -> E3 -> dip, one connected block (the designed exception)
export const MIN_EQ_PX = 16.5;             // KaTeX scripts are 0.7 x 1.06 em: 16.5 px keeps them >= 12 CSS px (G2)
const eqIdOf = e => (typeof e === "string" ? e : e && e.id);
/** beats.json highlight names -> eq.json term ids ("@dip" = the chain's dip glyph: where the line lands in velocity). */
export const HL_ALIAS = Object.freeze({E1: {fion: "f", n_ion: "n"}, E3: {V: "@dip", lambda: "lam"}, E4: {lambda: "lam", lambda0: "lam0", v_gal: "vgal"}});
export const hlTerm = (eqId, t) => ((HL_ALIAS[eqId] || {})[t] || t);
/** Placement of one equation from whatever the caller hands render(): the solver result ({byId}), its placed list,
 *  or a plain map keyed "eq:<key>" or "<key>". */
export function placedBox(placed, key) {
  if (!placed) return null;
  if (placed.byId) return placed.byId[`eq:${key}`] || placed.byId[key] || null;
  if (Array.isArray(placed)) return placed.find(b => b && (b.id === `eq:${key}` || b.id === key)) || null;
  return placed[`eq:${key}`] || placed[key] || null;
}

/** Representative cell of a named cloud ("A".."D", data.cloud_names) for one ion: the member cell (by ℓ inside the
 *  cloud's on-ray extent) with the largest τ₀. Falls back to any ion's extent, then null. Pure. */
export function cloudCell(data, letter, ion) {
  const L = data && data.cloud_names && data.cloud_names.letters && data.cloud_names.letters[letter];
  if (!L) return null;
  for (const io of [ion, ...Object.keys(L).filter(k => k !== ion)]) {
    const segs = (L[io] || []).map(c => c.l).filter(l => Array.isArray(l) && l.length === 2);
    const c = data.ions && data.ions[io] && data.ions[io].cells; if (!segs.length || !c) continue;
    const l = c.l_kpc || c.l || [], t = c.tau0 || [];
    let best = -1;
    for (let j = 0; j < l.length; j++)
      if (segs.some(([a, b]) => l[j] >= Math.min(a, b) && l[j] <= Math.max(a, b)) && (best < 0 || +t[j] > +t[best])) best = j;
    if (best >= 0) return {idx: c.idx ? c.idx[best] : best, ion: io};
  }
  return null;
}

export async function loadEq(url = EQ_URL) {
  const r = await fetch(url); if (!r.ok) throw new Error(`eq.json: HTTP ${r.status}`);
  return r.json();
}

/* ------------------------------------------------------------------ plan (pure; node and page) */
const smooth = (a, b, x) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };
/** Which equations show for this frame, as layout items without DOM: [{key, ids, ion, idx, anchor, mode, chain,
 *  stepIdx, enter, hl, ghost}]. At most two, except the B7b chain (one block). Phones get one equation at a time,
 *  stepping with u; the narrow class gets the value line only ("chip"). enter is the reveal 0..1 as a function of p:
 *  it fades only at a beat edge where the neighbouring beat does not show the same equation (ctx.beats). */
export function planEquations(fs, EQ, ctx = {}) {
  const cls = ctx.cls || "desktop", phone = PHONE.has(cls);
  // review2 three_d T3: an equation slot may set noPhone (beats.json) to stay off phone/narrow layouts, where the on-axis
  // camera stretch puts the beam through the middle of the one-chip band
  const list = ((fs && fs.eqs) || []).filter(e => e && EQ.eqs[e.id] && !(e.noPhone && (phone || cls === "narrow")));
  const maxN = phone || ONE.has(cls) ? 1 : Math.max(1, Math.min(2, ctx.eqMax || 2));
  const lead = (fs.spec && fs.spec.lead) || "OVI";
  const u = fs.beat ? fs.beat.u ?? 0.5 : 0.5;
  const beats = ctx.beats || null, bi = fs.beat ? fs.beat.i : null;
  const beatEqs = k => (beats && beats[k] && beats[k].eqs) || [];
  const shows = (k, id) => beatEqs(k).some(e => eqIdOf(e) === id);
  // reveal: seek's own window phase (−1..0..1, fades in p from beats.json) when present; else the beat-edge rule
  const enterOf = e => {
    if (e && Number.isFinite(e.phase)) { const v = 1 - Math.min(1, Math.abs(e.phase)); return ctx.reducedMotion ? (v > 0 ? 1 : 0) : v; }
    if (ctx.reducedMotion) return 1;
    const id = eqIdOf(e);
    const a = bi != null && shows(bi - 1, id) ? 1 : smooth(0.0, 0.06, u);
    const b = bi != null && shows(bi + 1, id) ? 1 : 1 - smooth(0.94, 1.0, u);
    return Math.min(a, b);
  };
  const mk = (e, extra = {}) => {
    const def = EQ.eqs[e.id]; if (!def) return null;
    const anchor = e.anchor || {kind: "cell", ref: null};
    let ion = def.variants[lead] ? lead : def.variants.any ? lead : Object.keys(def.variants)[0];
    let idx = fs.cell ? fs.cell.idx : null;
    if (anchor.kind === "cell" && anchor.ref != null && anchor.ref !== "probe") idx = anchor.ref;
    else if (anchor.kind === "cloud" && anchor.ref != null) {
      const cc = cloudCell(ctx.data, anchor.ref, ion);
      if (cc) { idx = cc.idx; if (cc.ion !== ion && def.variants[cc.ion]) ion = cc.ion; }
    }
    return {key: e.id, ids: [e.id], ion, variant: def.variants[ion] ? ion : "any", idx, anchor, totals: !!e.totals,
      mode: phone || cls === "narrow" ? "chip" : "value", chain: false, enter: enterOf(e), hl: (e.hl || []).map(t => hlTerm(e.id, typeof t === "string" ? t : t.term)), ghost: e.ghost || null, ...extra};
  };
  // B7b chain: whenever the beat lists all of E1, E2, E3 (or all three are on screen), the block holds all three rows from
  // the first one's entry, so its box never changes size mid-beat; rows not yet in their window sit at enter 0.
  const present = CHAIN.filter(id => list.some(e => e.id === id));
  const beatHasChain = bi != null && beats ? CHAIN.every(id => shows(bi, id)) : present.length === CHAIN.length;
  let items;
  if (present.length && beatHasChain && (present.length === CHAIN.length || list.every(e => CHAIN.includes(e.id)))) {
    const anyAnchor = list.find(e => CHAIN.includes(e.id)).anchor;
    const partOf = id => { const e = list.find(x => x.id === id); return e ? mk(e) : {...mk({id, anchor: anyAnchor}), enter: 0}; };
    if (phone || ONE.has(cls) || STEP_CHAIN.has(cls)) {                  // phone / one-equation band: one row of the chain at a time, the latest to enter
      // with seek's windows (phase present) that follows the beat's highlights; without them, step evenly with u
      const windowed = list.some(e => CHAIN.includes(e.id) && Number.isFinite(e.phase));
      // A row takes the slot once it is half in; the swap is a step, not an entry, so later rows show at full opacity.
      let k = windowed ? -1 : Math.min(CHAIN.length - 1, Math.floor(u * CHAIN.length));
      // review2 science M2: rows may carry phoneU [u0, u1) (beats.json) so the one row a phone shows is the term the visible
      // caption talks about (B7b: N under "Amount sets the bite", b ← T under "Heat spreads it out", τ₀ last)
      const byU = list.find(e => CHAIN.includes(e.id) && Array.isArray(e.phoneU) && u >= e.phoneU[0] && (u < e.phoneU[1] || e.phoneU[1] >= 1));
      if (byU && present.includes(byU.id)) k = CHAIN.indexOf(byU.id);
      if (k < 0 || !present.includes(CHAIN[k])) {
        const half = present.filter(id => enterOf(list.find(x => x.id === id)) >= 0.5);
        k = CHAIN.indexOf((half.length ? half : present)[(half.length ? half : present).length - 1]);
      }
      const first = k === CHAIN.indexOf(present[0]), row = list.find(x => x.id === CHAIN[k]);
      const stepIn = !first && !(Number.isFinite(row.phase) && row.phase > 0);   // exits still fade
      items = [mk(row, {stepIdx: k, stepN: CHAIN.length, ...(stepIn ? {enter: 1} : {})})];
    } else {
      const parts = CHAIN.map(partOf);
      items = [{...parts[0], key: "chain", ids: CHAIN.slice(), chain: true, parts, enter: Math.max(...parts.map(p => p.enter))}];
    }
  } else {
    items = list.slice(0, maxN).map(e => mk(e));
  }
  if (ctx.recalled && !items.some(i => i.ids.includes(ctx.recalled)) && EQ.eqs[ctx.recalled] && items.length < maxN)
    items.push(mk({id: ctx.recalled, anchor: {kind: "dock", ref: null}}, {recalled: true, enter: 1}));
  return items.filter(Boolean);
}
/** Equations seen before the current beat (the formula trail chips on the HUD edge): [{id, title}]. */
export function trail(fs, EQ, beats) {
  if (!beats || !fs.beat) return [];
  const now = new Set((fs.eqs || []).map(e => e.id)), seen = [];
  for (let k = 0; k < fs.beat.i; k++) for (const e of beats[k].eqs || []) {
    const id = typeof e === "string" ? e : e.id;
    if (EQ.eqs[id] && !now.has(id) && !seen.some(s => s.id === id)) seen.push({id, title: EQ.eqs[id].title});
  }
  return seen;
}

/* ------------------------------------------------------------------ static HTML (no values yet) */
const esc = s => String(s).replace(/[&<>"]/g, c => ({"&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;"}[c]));
const ARROW = `<svg class="eq-arrow" viewBox="0 0 24 28" width="1.1em" height="1.3em" aria-hidden="true"><path d="M12 2v20m-6-6 6 7 6-7" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
const SEP = `<svg class="eq-sepline" viewBox="0 0 48 8" width="2.4em" height=".5em" aria-hidden="true"><path d="M4 4h40" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-dasharray="2 4"/></svg>`;
const DIP = `<svg class="eq-dip" viewBox="0 0 64 24" width="3.2em" height="1.2em" aria-hidden="true"><path d="M2 5h18c5 0 7 15 12 15s7-15 12-15h18" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>`;
/* review3 beauty M3 (fix3): sighted readers get the term names too, not only screen readers. A single-equation box in value
   mode carries one muted line under the symbolic row naming its terms in one to three plain words (symbol, then word).
   Terms the story never talks about (the damping parameter a, the other atom's width) are left out; chain boxes (B7b) and
   chip / short modes (phones) do not show it. Words are UI text, not data (no digits: G10). */
export const TERM_WORDS = Object.freeze({
  E1: [["N", "amount"], ["n", "ion density"], ["Δl", "path length"], ["f", "ion share"]],
  E2: [["b", "width"], ["T", "temperature"], ["m", "atom mass"]],
  E3: [["τ₀", "depth at centre"], ["N", "amount"], ["f", "line strength"], ["λ", "wavelength"], ["b", "width"]],
  E3b: [["τ₀", "depth at centre"], ["V", "speed"], ["b", "width"]],
  E4: [["V", "speed"], ["λ", "seen wavelength"], ["λ₀", "rest wavelength"]],
  E5: [["τᵢ", "each cell's depth"], ["F", "light let through"]],
  E6: [["R", "sharpness"], ["FWHM", "blur width"], ["⊗", "blurred by"]],
  E7: [["S/N", "exposure"], ["σ", "noise per pixel"]],
  E8: [["χ²", "fit quality"]],
});
const wordsHTML = id => { const w = TERM_WORDS[id]; return w ? `<div class="eq-words" aria-hidden="true">${w.map(([sy, wd]) => `<span class="eq-w"><i>${esc(sy)}</i> ${esc(wd)}</span>`).join("")}</div>` : ""; };
/** HTML of one item (exported for the size-table capture page and the film). Draggable terms get proxies at mount. */
export function itemHTML(item, EQ) {
  let pinDone = false;
  const ghostable = id => Object.values(EQ.eqs[id].terms).some(t => t.drag && !t.override);
  const one = (id, variant, mode) => {
    const v = EQ.eqs[id].variants[variant] || EQ.eqs[id].variants.any;
    const sym = `<div class="eq-sym">${v.sym.html}</div>`;              // chip mode hides it in CSS
    // Pin sits inside the box (end of the value row, space reserved) so the solver's box covers it
    const pin = !pinDone && ghostable(id) ? (pinDone = true, `<button type="button" class="eq-pin" data-noscrub aria-pressed="false" tabindex="-1" style="visibility:hidden">Pin</button>`) : "";
    // short: the headline clause alone (build's "short" layer), shown only when the solver picks that variant
    // chain block: each row's compact form (shortc, else short). Phone chain step: the compact row first ("shortc" mode,
    // e.g. E2 "b <- T", review2_science M2), the headline clause as the last fallback ("short" mode)
    const sv = item.chain ? v.shortc || v.short : v.short;
    const short = (item.stepN && v.shortc ? `<div class="eq-shortc">${v.shortc.html}</div>` : "") + (sv ? `<div class="eq-short">${sv.html}</div>` : "");
    return `<div class="eq-one" data-eqid="${id}"><div class="eq-val">${v.val.html}${pin}</div>${sym}${item.chain ? "" : wordsHTML(id)}${short}</div>`;
  };
  if (item.chain) {
    // review2_science M2: N and T are independent inputs, so the first two rows are joined by a divider, not an arrow
    // (an arrow N -> T read as "the amount sets the temperature"); only the link into the last row (tau0) is an arrow
    const n = item.parts.length;
    const rows = item.parts.map((p, k) => one(p.key, p.variant, item.mode) +
      (k < n - 2 ? `<div class="eq-link eq-sep" aria-hidden="true">${SEP}</div>` : k === n - 2 ? `<div class="eq-link">${ARROW}</div>` : ""));
    return `${rows.join("")}<div class="eq-link eq-link-end">${ARROW}</div><div class="eq-dipline">${DIP}</div>`;
  }
  const step = item.stepN ? `<div class="eq-step" aria-hidden="true">step ${item.stepIdx + 1} of ${item.stepN}</div>` : "";
  // review M4 (science): a box bound to a fixed cell or cloud says so, since the plaque beside the probe shows another cell
  const a = item.anchor || {}, tag = a.kind === "cell" && !a.probe && a.ref != null && a.ref !== "probe" && Number.isFinite(+a.ref) ? `cell ${+a.ref}`
    : a.kind === "cloud" && a.ref ? `cloud ${esc(a.ref)}` : "";
  return (tag ? `<div class="eq-tag" data-num>${tag}</div>` : "") + one(item.key, item.variant, item.mode) + step;
}

/* ------------------------------------------------------------------ styles (injected once; no CSS file of its own) */
/* G4 (S0): the box scrim is 0.75, the frozen stage scrim strength (S0 stage_scrimK). Composited over a pure white volume it
   keeps --sky-ink at 8.7:1 (6.4:1 dimmed) and --sky-muted at 5.0:1 (muted rows never dim), the O VI / H I value underlines
   at >= 3.6:1 (tests/js/story_eq.mjs G4). review3 beauty M5 (fix3): the feather is the same 0.75 with a 1 em spread and a
   1.4 em blur, so the darkening is ~0.69 at the box edge and fades out beyond it (no visible rectangle edge over bright gas;
   it used to step from 0.75 to ~0.35 at the border). */
const STYLE = `
.eqlayer{position:absolute;inset:0;pointer-events:none;contain:layout style}
.eqbox{position:absolute;left:0;top:0;box-sizing:border-box;padding:.28em .5em .32em;border-radius:.45em;white-space:nowrap;
 color:var(--sky-ink,#f4f1ea);background:var(--eq-scrim,rgba(4,5,10,.75));box-shadow:0 0 1.4em 1em var(--eq-feather,rgba(4,5,10,.75));font-size:max(var(--eq-size,22px),${MIN_EQ_PX}px);line-height:1.15;
 will-change:transform,opacity;pointer-events:none}
.eqbox[hidden],.eqbox .eq-val[hidden]{display:none}
.eqbox[data-mode=chip] .eq-sym{display:none}
.eqbox[data-mode=chip] .eq-words,.eqbox[data-mode=short] .eq-words,.eqbox[data-mode=shortc] .eq-words{display:none}
.eqbox .eq-words{display:flex;flex-wrap:wrap;gap:0 1.1em;width:0;min-width:100%;margin-top:.25em;font:400 max(12.5px,.56em)/1.35 var(--sans,"Space Grotesk",system-ui,sans-serif);color:var(--sky-muted,#b9b6c8)}
.eqbox .eq-w{white-space:nowrap}
.eqbox .eq-words i{font-style:italic;font-family:var(--serif,"Times New Roman",serif);color:var(--sky-ink,#f4f1ea);margin-right:.2em}
.eqbox .eq-short,.eqbox .eq-shortc{display:none;min-height:2.2em;align-items:center;white-space:nowrap}
.eqbox[data-mode=short] .eq-short,.eqbox[data-mode=shortc] .eq-shortc{display:flex}
.eqbox[data-mode=short] .eq-val,.eqbox[data-mode=short] .eq-sym,.eqbox[data-mode=short] .eq-step,
.eqbox[data-mode=shortc] .eq-val,.eqbox[data-mode=shortc] .eq-sym,.eqbox[data-mode=shortc] .eq-step{display:none}
.eqbox[data-mode=short] .katex,.eqbox.wrap[data-mode=short] .katex,.eqbox[data-mode=shortc] .katex,.eqbox.wrap[data-mode=shortc] .katex{white-space:nowrap;line-height:1.2}
/* single-line short box: one 44 px touch row, no vertical padding, so it fits the phones' 48 px stepped band with the shell's
   4 px registration pad (narrow 320x568 measured 54 px before, from the 2.4 wrapped-line height) */
.eqbox[data-mode=short]:not([data-eq=chain]),.eqbox[data-mode=shortc]{padding:0 .4em}   /* .4em sides: 3 px back on the 260 px band */
.eqbox[data-mode=short]:not([data-eq=chain]) .eq-short,.eqbox[data-mode=shortc] .eq-shortc{min-height:max(2.2em,44px)}
.eqbox[data-mode=short] .eq-link-end,.eqbox[data-mode=short] .eq-dipline{display:none}
.eqbox .eq-tag{font:500 max(.62em,12px)/1.3 var(--sans,system-ui,sans-serif);letter-spacing:.04em;text-transform:uppercase;color:var(--sky-muted,#b9b6c8)}
.eqbox[data-mode=short] .eq-tag,.eqbox[data-mode=shortc] .eq-tag,.eqbox[data-mode=chip] .eq-tag{display:none}
.eqbox .katex{font-size:1.06em}
.eqbox .eq-val{min-height:2.2em;display:flex;align-items:center}
.eqbox .eq-sym{font-size:max(.8em,${MIN_EQ_PX}px);color:var(--sky-muted,#b9b6c8);margin-top:.1em}
.eqbox[data-mode=symbolic] .eq-val{font-size:max(.8em,${MIN_EQ_PX}px);min-height:0;color:var(--sky-muted,#b9b6c8)}
.eqbox.wrap{white-space:normal;max-width:var(--eq-maxw,calc(100vw - 24px))}
.eqbox.wrap .katex{white-space:normal;line-height:1.7}
.eqbox.wrap.touch .katex{line-height:2.4}   /* phones: wrapped lines, >= 44 px touch rows */
.eqbox.wrap .eq-val{flex-wrap:wrap}
.eqbox[data-mode=symbolic] .eq-sym{font-size:1em;color:var(--sky-ink,#f4f1ea)}
.eqbox .eqv{box-shadow:inset 0 -.09em 0 var(--eq-ion,var(--ovi,#FB7A3C))}
.eqbox [data-part=e] .eqv{box-shadow:none}
.eqbox [data-part=p].pow{box-shadow:inset 0 -.09em 0 var(--eq-ion,var(--ovi,#FB7A3C))}
.eqbox [data-part=p]:not(.pow){box-shadow:none}
.eqbox .eqt{border-radius:.12em;transition:background-color .15s,opacity .15s}
.eqbox .eqt.hl{background:rgba(255,244,223,.13)}
.eqbox .eqt.hover{background:rgba(255,244,223,.22)}
.eqbox:not([data-mode=symbolic]) .eq-sym .eqt:is(.hl,.hover),.eqbox[data-mode=symbolic] .eq-val .eqt:is(.hl,.hover){color:var(--sky-ink,#f4f1ea)}  /* G4 */
.eqbox.dim .eqt:not(.hover){opacity:.8}
.eqbox.dim:not([data-mode=symbolic]) .eq-sym .eqt,.eqbox.dim[data-mode=symbolic] .eq-val .eqt{opacity:1}  /* muted rows never dim (G4) */
.eqbox .ghosted .eqv,.eqbox .ghosted[data-part=p].pow{box-shadow:none;border-bottom:.08em dashed var(--eq-ion,var(--ovi,#FB7A3C))}
.eqbox .ghosted[data-part=e] .eqv{border-bottom:0}
.eqbox .eq-link{display:flex;justify-content:center;color:var(--sky-muted,#b9b6c8);font-size:.7em;margin:.05em 0}
.eqbox .eq-dipline{display:flex;justify-content:center;color:var(--eq-ion,var(--ovi,#FB7A3C))}
.eq-dipline.hl{background:rgba(255,244,223,.13);border-radius:.3em}
.eqbox .eq-step{font:500 12px/1 var(--mono,monospace);color:var(--sky-muted,#b9b6c8);margin-top:.3em}
.eqbox .eq-proxy{position:absolute;pointer-events:auto;border-radius:6px;outline:none;touch-action:pinch-zoom;cursor:help;background:transparent}
.eqbox .eq-proxy[role=slider]{cursor:ew-resize}
.eqbox .eq-proxy:focus-visible{box-shadow:0 0 0 2px var(--beam,#fff4df)}
.eqbox .eq-pin{pointer-events:auto;position:relative;z-index:1;margin-left:.6em;flex:none;font:500 12px/1 var(--sans,system-ui);min-height:28px;
 padding:7px 10px;border-radius:999px;border:1px solid rgba(244,241,234,.35);background:rgba(4,5,10,.75);color:var(--sky-ink,#f4f1ea);cursor:pointer}
.eqbox .eq-pin[aria-pressed=true]{background:var(--sky-ink,#f4f1ea);color:#04050a}
.eq-sr{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap}
@media (prefers-reduced-motion:reduce){.eqbox .eqt{transition:none}}
`;
export function ensureCss(doc = document) {
  if (!doc.querySelector(`link[data-katex-css]`)) {
    const l = doc.createElement("link"); l.rel = "stylesheet"; l.href = KATEX_CSS; l.dataset.katexCss = ""; doc.head.appendChild(l);
  }
  if (!doc.getElementById("eq-style")) { const s = doc.createElement("style"); s.id = "eq-style"; s.textContent = STYLE; doc.head.appendChild(s); }
}

/* ------------------------------------------------------------------ the overlay */
export function createOverlay({eq: EQ, data, fion = null, bus = null, root = null, doc = (typeof document !== "undefined" ? document : null),
  reducedMotion = null, fontPx = 22} = {}) {
  const emit = (t, p) => { try { (bus && (bus.emit || bus.publish || bus.send))?.call(bus, t, p); } catch (e) { console.error(e); } };
  const RM = () => (reducedMotion != null ? reducedMotion : !!(doc && doc.defaultView && doc.defaultView.matchMedia &&
    doc.defaultView.matchMedia("(prefers-reduced-motion: reduce)").matches));
  const els = new Map();            // key -> {el, item, sig, size, proxies, last}
  let layer = null, recalled = null, ghost = null, pinned = false, spring = null, lastFs = null, lastCtx = {};
  if (doc && root) {
    ensureCss(doc);
    layer = doc.createElement("div"); layer.className = "eqlayer"; root.appendChild(layer);
  }
  const ctxOf = (item, fs, c, part) => ({data, ion: (part || item).ion, idx: (part || item).idx, spec: plottedSpec(fs.spec), live: c.live || null,
    anchorKind: (part || item).totals ? "totals" : ((part || item).anchor || {}).kind, ghost: ghost && ghost.eq === (part || item).key && ghost.idx === (part || item).idx ? ghost : fsGhost(fs, part || item)});
  // a ghost carried in the FrameState (e.g. seek applied a T263 override) shows like a local drag
  function fsGhost(fs, it) {
    if (!it.ghost || it.ghost.value == null || !fion && it.key === "E2") return null;
    try {
      const def = EQ.eqs[it.key], t = def.terms[it.ghost.term]; if (!t || !t.drag) return null;
      const s = t.drag.scale === "log" ? Math.log10(it.ghost.value) : it.ghost.value;
      return ghostCell(data, fion, {eq: it.key, term: it.ghost.term, ion: it.ion, idx: it.idx, s});
    } catch { return null; }
  }

  function fill(rec, fs, c) {
    const parts = rec.item.chain ? rec.item.parts : [rec.item];
    let changed = false, missing = false, shortMissing = false;
    const labels = [];
    for (const p of parts) {
      const def = EQ.eqs[p.key], ctx = ctxOf(rec.item, fs, c, p), vals = termValues(def, ctx);
      const scope = rec.el.querySelector(`.eq-one[data-eqid="${p.key}"]`) || rec.el;
      // values a ghost changed (the dragged term and everything derived from it) get the dashed keyline
      const vals0 = ctx.ghost ? termValues(def, {...ctx, ghost: null}) : null;
      for (const n of scope.querySelectorAll("[data-v]")) {
        const id = n.dataset.v, t = def.terms[id];
        const g = !!(vals0 && t && t.fmt && JSON.stringify(formatParts(vals[id], t.fmt)) !== JSON.stringify(formatParts(vals0[id], t.fmt)));
        if (n.classList.contains("ghosted") !== g) n.classList.toggle("ghosted", g);
      }
      for (const [id, v] of Object.entries(vals)) {
        const t = def.terms[id]; if (!t.fmt) continue;
        const f = formatParts(v, t.fmt), keyStr = f ? `${f.m}|${f.e}` : "none";
        const vv = def.variants[p.variant] || def.variants.any;
        if (!f && vv.val.values.includes(id)) missing = true;
        if (!f && (vv.short ? vv.short.values : vv.val.values).includes(id)) shortMissing = true;
        const lk = `${p.key}.${id}`; if (rec.last[lk] === keyStr) continue;
        rec.last[lk] = keyStr; changed = true;
        for (const n of scope.querySelectorAll(`[data-v="${id}"]`)) {
          const part = n.dataset.part, inner = n.querySelector(".eqv") || n;
          if (part === "m") { n.style.display = f && f.m != null ? "" : "none"; if (f && f.m != null) inner.textContent = f.m; }
          else if (part === "e") { if (f && f.e != null) inner.textContent = f.e; }
          else if (part === "t") n.style.display = f && f.m != null && f.e != null ? "" : "none";
          else if (part === "p") { n.style.display = f && f.e != null ? "" : "none"; n.classList.toggle("pow", !!(f && f.m == null)); }
          if (!f && part === "m") { n.style.display = ""; inner.textContent = "…"; }
        }
      }
      const v = def.variants[p.variant] || def.variants.any;
      labels.push(`${def.title}: ${spoken(v.spoken, def, vals)}`);
      for (const n of scope.querySelectorAll(".eqt")) {
        const id = n.dataset.term || (n.parentElement && n.parentElement.dataset.term);
        n.classList.toggle("hl", (p.hl || []).includes(id));
        n.classList.toggle("ghost", !!(ctx.ghost && ctx.ghost.term === id));
      }
      for (const px of rec.proxies) if (px.eq === p.key) updateProxyAria(px, def, ctx, vals);
    }
    rec.el.setAttribute("aria-label", labels.join(" "));
    // no number to show (e.g. E5 before the dock reports tau_peak, E8 before the fit): symbolic form only, never a placeholder
    // ...except when the solver picked the short variant and the headline clause has its number (E8: N_a from the AOD
    // fallback before the fit reports chi2; review2_ux_overlap M1, E8 hidden on bands narrower than its symbolic form)
    rec.shortOk = !shortMissing && !rec.item.chain;
    const mode = missing ? (rec.forceMode === "short" && rec.shortOk ? "short" : "symbolic") : rec.forceMode || (rec.item.mode === "chip" ? "chip" : "value");
    if (rec.el.dataset.mode !== mode) { rec.el.dataset.mode = mode; changed = true; }
    for (const n of rec.el.querySelectorAll(".eq-val")) n.hidden = missing;
    return changed;
  }

  function updateProxyAria(px, def, ctx, vals) {
    const t = def.terms[px.term];
    const fmtv = v => { const f = formatParts(v, t.fmt || "sig3"); if (!f) return ""; return (f.m != null ? f.m.replace(/ /g, "") : "") + (f.e != null ? (f.m != null ? " × 10^" : "10^") + f.e : ""); };
    const txt = `${fmtv(vals[px.term])} ${t.unit || ""}`.trim();
    if (px.kind === "slider") {
      const sp = sliderSpec(def, px.term, {...ctx, ghost: null}); if (!sp) return;
      const now = ctx.ghost && ctx.ghost.term === px.term ? ctx.ghost.s : sp.now;
      px.spec = sp; px.ctx = ctx;
      px.el.setAttribute("aria-valuemin", sp.min.toFixed(3)); px.el.setAttribute("aria-valuemax", sp.max.toFixed(3));
      px.el.setAttribute("aria-valuenow", now.toFixed(3));
      px.el.setAttribute("aria-valuetext", `${t.label}: ${txt}`);
      px.el.setAttribute("aria-label", t.label);   // aria-valuetext is not a name (axe aria-input-field-name)
    } else px.el.setAttribute("aria-label", `${t.label}: ${txt}`);
  }

  /* proxies: one per term and equation (first occurrence; value line first). Rows of terms get vertical bands split at
     the midpoints between rows and extended to the box edges (the value row is >= 44 px, C_ux P1-2); within a row the
     hit areas split at the midpoints between neighbours. Every proxy stays inside its box, so the solver's box covers it. */
  function buildProxies(rec) {
    // existing proxies are moved, not recreated, so a drag in progress keeps its pointer capture
    const old = new Map(rec.proxies.map(p => [`${p.eq}.${p.term}`, p]));
    rec.proxies = [];
    const parts = rec.item.chain ? rec.item.parts : [rec.item];
    const box = rec.el.getBoundingClientRect();
    const zoom = rec.el.offsetWidth ? box.width / rec.el.offsetWidth : 1;    // the solver may scale the box
    const W = box.width / zoom, H = box.height / zoom, list = [];      // fractional: integer offsetHeight overshoots
    rec.builtH = box.height;
    for (const p of parts) {
      const def = EQ.eqs[p.key], scope = rec.el.querySelector(`.eq-one[data-eqid="${p.key}"]`);
      if (!scope) continue;
      const seen = new Set();
      for (const n of scope.querySelectorAll("[data-term]")) {
        const id = n.dataset.term; if (seen.has(id) || !def.terms[id]) continue;
        const t = def.terms[id]; if (!t.bind && !t.toggle) continue;
        const r = n.getBoundingClientRect(); if (!r.width) continue;
        seen.add(id);
        const ctx = {data, ion: p.ion, idx: p.idx, spec: plottedSpec(lastFs && lastFs.spec), ghost: null};
        const kind = t.toggle ? "switch" : sliderSpec(def, id, ctx) ? "slider" : "button";
        list.push({eq: p.key, term: id, kind, r: {x: (r.left - box.left) / zoom, y: (r.top - box.top) / zoom, w: r.width / zoom, h: r.height / zoom}});
      }
    }
    const rows = [];
    for (const a of list.sort((x, y) => (x.r.y + x.r.h / 2) - (y.r.y + y.r.h / 2))) {
      const cy = a.r.y + a.r.h / 2, row = rows.find(R => Math.abs(R.cy - cy) < 8);
      if (row) { row.items.push(a); row.t = Math.min(row.t, a.r.y); row.b = Math.max(row.b, a.r.y + a.r.h); }
      else rows.push({cy, t: a.r.y, b: a.r.y + a.r.h, items: [a]});
    }
    const cut = k => Math.max((rows[k].cy + rows[k + 1].cy) / 2, Math.min((rows[k].b + rows[k + 1].t) / 2, rows[k + 1].cy - 12));
    rows.forEach((R, k) => {
      const top = k === 0 ? 0 : cut(k - 1), bot = k === rows.length - 1 ? H : cut(k);
      const it = R.items.sort((x, y) => x.r.x - y.r.x);
      it.forEach((a, i) => {
        const L = i > 0 ? (it[i - 1].r.x + it[i - 1].r.w + a.r.x) / 2 : Math.max(0, a.r.x - 12);
        const Rr = i < it.length - 1 ? (a.r.x + a.r.w + it[i + 1].r.x) / 2 : Math.min(W, a.r.x + a.r.w + 12);
        const g = {x: L, y: top, w: Rr - L, h: bot - top}, k = `${a.eq}.${a.term}`, px = old.get(k);
        if (px && px.kind === a.kind) {
          Object.assign(px.el.style, {left: `${g.x}px`, top: `${g.y}px`, width: `${g.w}px`, height: `${g.h}px`});
          rec.proxies.push(px); old.delete(k);
        } else mountProxy(rec, a, g);
      });
    });
    for (const p of old.values()) p.el.remove();
    if (lastFs) for (const p of parts) {          // new proxies need their slider spec and ARIA values now, not next frame
      const def = EQ.eqs[p.key], ctx = ctxOf(rec.item, lastFs, lastCtx, p), vals = termValues(def, ctx);
      for (const px of rec.proxies) if (px.eq === p.key) updateProxyAria(px, def, ctx, vals);
    }
  }
  function mountProxy(rec, a, g) {
    const def = EQ.eqs[a.eq], t = def.terms[a.term];
    const el = doc.createElement("span");
    el.className = "eq-proxy"; el.tabIndex = 0; el.dataset.noscrub = ""; el.dataset.term = a.term; el.dataset.eq = a.eq;
    Object.assign(el.style, {left: `${g.x}px`, top: `${g.y}px`, width: `${g.w}px`, height: `${g.h}px`});
    if (a.kind === "slider") { el.setAttribute("role", "slider"); el.setAttribute("aria-orientation", "horizontal"); el.setAttribute("aria-label", t.label); }
    else if (a.kind === "switch") { el.setAttribute("role", "switch"); el.setAttribute("aria-checked", "false"); el.setAttribute("aria-label", `${t.label}: show the other atom`); }
    else { el.setAttribute("role", "button"); el.setAttribute("aria-pressed", "false"); }
    const px = {el, eq: a.eq, term: a.term, kind: a.kind, spec: null, ctx: null};
    rec.proxies.push(px);
    rec.el.appendChild(el);
    wire(rec, px);
  }

  /* hover / tap / drag / keys */
  function setHover(rec, px, on) {
    const def = EQ.eqs[px.eq], t = def.terms[px.term];
    for (const n of rec.el.querySelectorAll(`.eq-one[data-eqid="${px.eq}"] .eqt-${px.term}`)) n.classList.toggle("hover", on);
    rec.el.classList.toggle("dim", on);
    const part = rec.item.chain ? rec.item.parts.find(p => p.key === px.eq) : rec.item;
    emit("hover", on ? {term: px.term, eq: px.eq, prop: t.prop || null, ion: part.ion, cellIdx: part.idx} : null);
  }
  function setGhostFrom(rec, px, s) {
    const part = rec.item.chain ? rec.item.parts.find(p => p.key === px.eq) : rec.item;
    const t = EQ.eqs[px.eq].terms[px.term];
    if (t.override) {                         // E6 R, E7 S/N: the instrument itself (persists)
      emit("override", {key: t.override, value: sliderToValue(px.spec, s, px.ctx)});
      return;
    }
    const prevNamed = namedOverride(ghost);
    ghost = s == null ? null : ghostCell(data, fion, {eq: px.eq, term: px.term, ion: part.ion, idx: part.idx, s});
    emit("override", {key: "ghost", value: ghost});
    const named = namedOverride(ghost);
    if (named) emit("override", named); else if (prevNamed) emit("override", {key: prevNamed.key, value: null});
    const pinBtn = rec.el.querySelector(".eq-pin");
    if (pinBtn) { pinBtn.style.visibility = ghost || pinned ? "visible" : "hidden"; pinBtn.tabIndex = ghost || pinned ? 0 : -1; }
    if (lastFs) fill(rec, lastFs, lastCtx);
  }
  function release(rec, px) {
    if (pinned || !ghost || !px.spec) return;
    const target = px.spec.now, s0 = ghost.s;
    if (RM() || s0 === target) { setGhostFrom(rec, px, null); return; }
    const t0 = performance.now(), w = 12;                     // critically damped, settles in ~0.45 s
    cancelAnimationFrame(spring);
    const step = () => {
      if (pinned) return;                                       // Pin during the spring keeps the ghost where it is
      const t = (performance.now() - t0) / 1000, x = (s0 - target) * (1 + w * t) * Math.exp(-w * t);
      if (Math.abs(x) < 1e-3 * Math.max(1, Math.abs(px.spec.max - px.spec.min)) || t > 1.2) { setGhostFrom(rec, px, null); return; }
      setGhostFrom(rec, px, target + x); spring = requestAnimationFrame(step);
    };
    spring = requestAnimationFrame(step);
  }
  function wire(rec, px) {
    const el = px.el;
    let down = null, sticky = false;
    el.addEventListener("pointerenter", e => { if (e.pointerType === "mouse") setHover(rec, px, true); });
    el.addEventListener("pointerleave", e => { if (e.pointerType === "mouse" && !down && !sticky) setHover(rec, px, false); });
    el.addEventListener("focus", () => setHover(rec, px, true));
    el.addEventListener("blur", () => { if (!sticky) setHover(rec, px, false); });
    el.addEventListener("pointerdown", e => {
      e.stopPropagation(); cancelAnimationFrame(spring);
      down = {x: e.clientX, s: px.kind === "slider" && px.spec ? (ghost && ghost.term === px.term ? ghost.s : px.spec.now) : null, moved: false};
      el.setPointerCapture?.(e.pointerId);
    });
    el.addEventListener("pointermove", e => {
      if (!down || px.kind !== "slider" || !px.spec) return;
      const dx = e.clientX - down.x; if (Math.abs(dx) > 4) down.moved = true; if (!down.moved) return;
      const sp = px.spec, s = Math.min(sp.max, Math.max(sp.min, down.s + dx / 300 * (sp.max - sp.min)));
      setGhostFrom(rec, px, s); e.preventDefault();
    });
    const up = e => {
      if (!down) return; const moved = down.moved; down = null;
      if (moved) { release(rec, px); return; }
      if (px.kind === "switch") { toggleAtom(rec, px); return; }
      sticky = !sticky; el.setAttribute("aria-pressed", String(sticky)); setHover(rec, px, sticky || e.pointerType === "mouse");   // tap = show, tap again = release
    };
    el.addEventListener("pointerup", up); el.addEventListener("pointercancel", up);
    el.addEventListener("keydown", e => {
      if (px.kind === "switch" && (e.key === "Enter" || e.key === " ")) { toggleAtom(rec, px); e.preventDefault(); return; }
      if (px.kind === "button" && (e.key === "Enter" || e.key === " ")) { sticky = !sticky; el.setAttribute("aria-pressed", String(sticky)); setHover(rec, px, sticky); e.preventDefault(); return; }
      if ((e.key === "p" || e.key === "P") && ghost) { setPin(rec, !pinned); e.preventDefault(); return; }
      if (e.key === "Escape" && ghost) { pinned = false; setGhostFrom(rec, px, null); e.preventDefault(); return; }
      if (px.kind !== "slider" || !px.spec) return;
      const sp = px.spec, cur = ghost && ghost.term === px.term ? ghost.s : sp.now;
      const d = {ArrowRight: sp.step, ArrowUp: sp.step, ArrowLeft: -sp.step, ArrowDown: -sp.step, PageUp: sp.big, PageDown: -sp.big}[e.key];
      let s = null;
      if (d != null) s = cur + d; else if (e.key === "Home") s = sp.min; else if (e.key === "End") s = sp.max; else return;
      e.preventDefault(); e.stopPropagation();
      s = Math.min(sp.max, Math.max(sp.min, s));
      setGhostFrom(rec, px, s);
      el.setAttribute("aria-valuenow", s.toFixed(3));
    });
  }
  function toggleAtom(rec, px) {                // E2 m: swap which atom's width leads (H <-> O)
    const on = px.el.getAttribute("aria-checked") !== "true";
    px.el.setAttribute("aria-checked", String(on));
    for (const n of rec.el.querySelectorAll(`.eq-one[data-eqid="${px.eq}"] .eqt-m`)) n.classList.toggle("hover", on);
    const part = rec.item.chain ? rec.item.parts.find(p => p.key === px.eq) : rec.item;
    emit("hover", on ? {term: "m", eq: px.eq, prop: "b", ion: part.ion === "HI" ? "OVI" : "HI", cellIdx: part.idx} : null);
  }
  function setPin(rec, on) {
    pinned = on; const b = rec.el.querySelector(".eq-pin"); if (b) b.setAttribute("aria-pressed", String(on));
    if (on) cancelAnimationFrame(spring);
    if (!on && ghost) { const px = rec.proxies.find(p => p.term === ghost.term && p.eq === ghost.eq); if (px) release(rec, px); }
  }

  /* mount / measure */
  const sigOf = (item, c) => `${item.key}|${item.anchor ? item.anchor.kind + ":" + (item.anchor.probe ? "probe" : item.anchor.ref) : ""}|${item.ids.join(",")}|${item.variant}|${item.mode}|${item.stepIdx ?? ""}|${c.cls || ""}|${c.maxW || ""}`;
  function ensure(item, fs, c) {
    const sig = sigOf(item, c);
    let rec = els.get(item.key);
    const ionColour = item.ion === "HI" ? "var(--hi,#9293F8)" : "var(--ovi,#FB7A3C)";
    if (rec && rec.sig === sig) { rec.item = item; if (rec.el && rec.ion !== item.ion) { rec.el.style.setProperty("--eq-ion", ionColour); rec.ion = item.ion; } return rec; }
    if (!layer) { rec = {el: null, item, sig, size: null, proxies: [], last: {}}; els.set(item.key, rec); return rec; }
    if (rec) { rec.ro?.disconnect(); rec.el.remove(); }
    const el = doc.createElement("div");
    // wrap: phone chips always; other classes when the caller gives the band width (c.maxW / c.band.w)
    el.className = item.mode === "chip" ? "eqbox wrap touch" : c.maxW ? "eqbox wrap" : "eqbox"; el.dataset.eq = item.key; el.dataset.mode = item.mode; el.setAttribute("role", "group");
    el.style.setProperty("--eq-ion", ionColour);
    if (c.maxW) el.style.setProperty("--eq-maxw", `${c.maxW}px`);
    el.innerHTML = itemHTML(item, EQ);
    el.style.visibility = "hidden"; layer.appendChild(el);
    rec = {el, item, sig, size: null, proxies: [], last: {}, ion: item.ion};
    els.set(item.key, rec);
    el.querySelector(".eq-pin")?.addEventListener("click", e => { e.stopPropagation(); setPin(rec, !pinned); });
    fill(rec, fs, c);
    measure(rec);
    buildProxies(rec);
    el.style.visibility = "";
    // any later size change (wrapping, fonts, mode switch) re-measures the box and rebuilds its hit areas
    const RO = doc.defaultView && doc.defaultView.ResizeObserver;
    if (RO) {
      rec.ro = new RO(() => { if (rec.el.hidden) return; const o = rec.size; measure(rec);
        const r = rec.el.getBoundingClientRect(); if (!o || o.w !== rec.size.w || o.h !== rec.size.h || Math.abs(r.height - (rec.builtH || 0)) > 0.25) buildProxies(rec); });
      rec.ro.observe(el);
    }
    return rec;
  }
  /* rec.size = the natural box; rec.variants = [natural, value-line-only "chip"] for the solver (tried in order). The chip
     variant is measured by flipping data-mode for one synchronous layout read (no paint, no ResizeObserver change). */
  function measure(rec) {
    if (!rec.el) return;
    const el = rec.el, cur = el.dataset.mode, nat = cur === "symbolic" || el.querySelector(".eq-val[hidden]") ? "symbolic" : rec.item.mode;
    const px = parseFloat(doc.defaultView.getComputedStyle(el).fontSize) || fontPx;
    const font = +(px * 0.7 * 1.06).toFixed(2);         // smallest glyph: one script level inside .katex (1.06 em)
    const box = () => { const w = shrinkW(el); return {w, h: Math.ceil(el.offsetHeight)}; };
    if (cur !== nat) el.dataset.mode = nat;
    rec.size = {...box(), font};
    rec.variants = [{...rec.size, key: nat}];
    if (nat === "value") {
      el.dataset.mode = "chip"; const ch = box();
      if (ch.h < rec.size.h - 2) rec.variants.push({...ch, font, key: "chip"});
    }
    for (const [k, sel] of [["shortc", ".eq-shortc"], ["short", ".eq-short"]]) {
      if (!el.querySelector(sel) || nat === "symbolic" && (k !== "short" || !rec.shortOk)) continue;
      el.dataset.mode = k; const sh = box(), last = rec.variants[rec.variants.length - 1];
      if (sh.w < last.w - 2 || sh.h < last.h - 2) rec.variants.push({...sh, font, key: k});
    }
    if (el.dataset.mode !== cur) el.dataset.mode = cur;
    shrinkW(el);                                     // the drawn mode keeps its content width
  }
  /* review1_beauty M4 / U_fix1: a wrapped box (max-width) keeps its full max-width once any line wraps, which drew an empty
     scrim beside the content. Shrink it to its widest line: the right edge of the KaTeX line pieces (.base), the Pin, the
     arrows and the tag/step text, plus the right padding. Lines never re-wrap (each already fits the narrower width). */
  function shrinkW(el) {
    el.style.width = "";
    const w0 = el.offsetWidth;
    if (!el.classList.contains("wrap")) return Math.ceil(w0);
    const r0 = el.getBoundingClientRect(); if (!r0.width) return Math.ceil(w0);
    const sx = r0.width / w0 || 1;                   // transform scale (solver's P.scale)
    let right = 0;
    const take = r => { if (r.width > 0 && r.height > 0) right = Math.max(right, r.right); };
    for (const n of el.querySelectorAll(".katex .base, .eq-pin, .eq-link svg, .eq-dipline svg")) if (n.offsetParent !== null || n.getClientRects().length) take(n.getBoundingClientRect());
    for (const n of el.querySelectorAll(".eq-tag, .eq-step")) if (n.firstChild && n.getClientRects().length) {
      const rg = doc.createRange(); rg.selectNodeContents(n); take(rg.getBoundingClientRect());
    }
    if (!right) return Math.ceil(w0);
    const padR = parseFloat(doc.defaultView.getComputedStyle(el).paddingRight) || 0;
    const w = Math.ceil((right - r0.left) / sx + padR + 1);
    if (w < w0 - 2) { el.style.width = `${w}px`; return w; }
    return Math.ceil(w0);
  }
  function boxFromJson(item) {         // node / no-DOM: box_em from the build's --measure step, scaled to fontPx
    const em = ids => ids.map(id => { const v = EQ.eqs[id].variants[item.variant] || EQ.eqs[id].variants.any;
      const a = v.val.box_em || {w: 10, h: 1.4}, b = item.mode === "chip" ? {w: 0, h: 0} : (v.sym.box_em || {w: 12, h: 1.6});
      return {w: Math.max(a.w * 1.06, b.w * 0.6 * 1.06) + 1, h: Math.max(a.h * 1.06, 2.2) + b.h * 0.6 * 1.06 + 0.7}; });
    const parts = em(item.ids);
    const w = Math.max(...parts.map(p => p.w)), h = parts.reduce((s, p) => s + p.h, 0) + (item.chain ? 1.3 * item.ids.length + 1.2 : 0);
    const px = Math.max(fontPx, MIN_EQ_PX);
    return {w: Math.ceil(w * px), h: Math.ceil(h * px), font: +(px * 0.7 * 1.06).toFixed(2)};
  }
  function variantsFromJson(item, size) {   // no-DOM variants: natural, then the headline clause alone
    const px = Math.max(fontPx, MIN_EQ_PX), out = [{...size, key: item.mode}];
    if (item.chain) {                        // rows of headline clauses joined by arrows; no end arrow, no dip glyph
      const bs = item.parts.map(p => { const v = EQ.eqs[p.key].variants[p.variant] || EQ.eqs[p.key].variants.any; return (v.shortc || v.short || v.val).box_em || {w: 10, h: 1.5}; });
      out.push({w: Math.ceil((Math.max(...bs.map(b => b.w)) * 1.06 + 1) * px),
        h: Math.ceil((bs.reduce((s, b) => s + Math.max(b.h * 1.06, 2.2), 0) + 1.3 * (bs.length - 1) + 0.6) * px), font: size.font, key: "short"});
      return out;
    }
    const v = EQ.eqs[item.key].variants[item.variant] || EQ.eqs[item.key].variants.any;
    const one = (L, key) => { const b = L && L.box_em;
      if (b) out.push({w: Math.ceil((b.w * 1.06 + 0.8) * px), h: Math.ceil(Math.max(Math.max(b.h * 1.06 * 1.2, 2.2) * px, 44)), font: size.font, key}); };
    if (item.stepN && v.shortc) one(v.shortc, "shortc");
    one(v.short, "short");
    return out;
  }

  return {
    /** Layout items for the solver: [{id: "<key>", rid: "eq:<key>", size: {w, h, font}, variants: [{w, h, font, key}],
     *  anchor, html, priority, chain, ion, enter}]. id is the bare key ("E2", "chain"): js/ui/hud.js registers it as
     *  "eq:" + id, the id rects() and render() use. variants[1] (when present) is the value line alone ("chip"). */
    equations(fs, c0 = {}) {
      const c = c0.maxW || !(c0.band && c0.band.w) ? c0 : {...c0, maxW: Math.floor(c0.band.w)};
      lastFs = fs; lastCtx = c;
      const items = planEquations(fs, EQ, {data, ...c, recalled, reducedMotion: RM()});
      const out = [];
      for (const it of items) {
        const rec = layer ? ensure(it, fs, c) : null;
        if (rec && rec.el.hidden) { rec.el.hidden = false; rec.size = null; }   // a box hidden earlier measures 0: re-measure
        if (rec && (fill(rec, fs, c) || !rec.size)) { const old = rec.size; measure(rec); if (!old || old.w !== rec.size.w || old.h !== rec.size.h || !rec.proxies.length) buildProxies(rec); }
        const size = rec ? rec.size : boxFromJson(it);
        out.push({id: it.key, rid: `eq:${it.key}`, size, variants: rec && rec.variants ? rec.variants.slice() : variantsFromJson(it, size),
          anchor: it.anchor, cellIdx: it.idx, html: rec ? null : itemHTML(it, EQ),
          priority: it.recalled ? 1 : 2, chain: it.chain, ion: it.ion, enter: it.enter});
      }
      for (const [k, rec] of els) if (!items.some(i => i.key === k) && rec.el) rec.el.hidden = true;
      return out;
    },
    /** Apply the solver's placement {"eq:<key>": {x, y, hidden, scale}} and the reveal (opacity/transform only). */
    render(fs, placed = {}, c = lastCtx) {
      const items = planEquations(fs, EQ, {data, ...c, recalled, reducedMotion: RM()});
      for (const it of items) {
        const rec = els.get(it.key); if (!rec || !rec.el) continue;
        const P = placedBox(placed, it.key);
        if (!P || P.hidden) { rec.el.hidden = true; continue; }
        // the ResizeObserver skips hidden boxes, so a size change while hidden (late KaTeX face, rows) is caught here
        if (rec.el.hidden) { rec.el.hidden = false; measure(rec); }
        // solver picked a smaller variant (key "chip": value line alone; "short": headline clause alone) because the
        // natural box did not fit its band
        const vk = P.variant && rec.variants && rec.variants[P.variant] ? rec.variants[P.variant].key : null;
        const fm = vk === "chip" || vk === "short" || vk === "shortc" ? vk : null;
        const sym = rec.el.dataset.mode === "symbolic" || !!rec.el.querySelector(".eq-val[hidden]");   // numbers missing
        if (fm !== (rec.forceMode || null)) {
          rec.forceMode = fm;
          if (!sym) rec.el.dataset.mode = fm || (rec.item.mode === "chip" ? "chip" : "value");
          else rec.el.dataset.mode = fm === "short" && rec.shortOk ? "short" : "symbolic";
          shrinkW(rec.el);
        }
        const e = it.enter, rm = RM();
        rec.el.style.transform = `translate3d(${P.x}px, ${P.y + (rm ? 0 : (1 - e) * 10)}px, 0)${P.scale && P.scale !== 1 ? ` scale(${P.scale})` : ""}`;
        rec.el.style.opacity = String(rm ? (e > 0.5 ? 1 : 0) : e);
        // left-to-right term reveal while entering (opacity only); chain rows reveal on their own windows
        const reveal = (scope, ee) => {
          const terms = scope.querySelectorAll(".eq-val .eqt, .eq-sym .eqt"), n = terms.length;
          terms.forEach((t, i) => { t.style.opacity = rm || ee >= 1 ? "" : String(Math.min(1, Math.max(0, ee * (n + 2) - i) / 2)); });
        };
        if (it.chain) {
          it.parts.forEach((p, k) => {
            const row = rec.el.querySelector(`.eq-one[data-eqid="${p.key}"]`); if (!row) return;
            const pe = rm ? (p.enter > 0 ? 1 : 0) : p.enter;
            row.style.opacity = pe >= 1 ? "" : String(pe);
            const link = row.nextElementSibling;            // the arrow below a row shows once the row below it enters
            const next = it.parts[k + 1];
            if (link && link.classList.contains("eq-link")) link.style.opacity = String(next ? (rm ? (next.enter > 0 ? 1 : 0) : next.enter) : pe);
            reveal(row, pe);
          });
          const dip = rec.el.querySelector(".eq-dipline");
          if (dip) dip.classList.toggle("hl", it.parts.some(p => p.hl.includes("@dip")));
          if (dip) dip.style.opacity = String(it.parts[2].enter >= 1 || rm && it.parts[2].enter > 0 ? 1 : it.parts[2].enter);
        } else reveal(rec.el, e);
      }
    },
    trail: (fs, beats) => trail(fs, EQ, beats),
    recall(id) { recalled = id && EQ.eqs[id] ? id : null; },
    /** Rects of every mounted, visible box and its proxies (for __story.rects() and the overlap gate). */
    rects() {
      const out = [];
      for (const [k, rec] of els) if (rec.el && !rec.el.hidden) {
        const r = rec.el.getBoundingClientRect(); out.push({id: `eq:${k}`, x: r.left, y: r.top, w: r.width, h: r.height});
      }
      return out;
    },
    state: () => ({ghost, pinned, recalled, keys: [...els.keys()]}),
    destroy() { cancelAnimationFrame(spring); for (const r of els.values()) { r.ro?.disconnect(); r.el && r.el.remove(); } els.clear(); layer && layer.remove(); },
  };
}
