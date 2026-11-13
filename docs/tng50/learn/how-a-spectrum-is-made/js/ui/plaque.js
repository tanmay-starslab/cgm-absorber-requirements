// Current-cell plaque (DESIGN §0, §8.3; DESIGN_final §1.3 P0-4, P0-7, P1-4). It attaches to the cell while the probe is in
// it and slides back with it. Values are JetBrains Mono, one per line, no dot separators; each value may carry a plain
// secondary line generated from a bound key by a copy.json rule (U_copy). Candidates exclude a 24 px corridor around the
// projected beam (ctx.corridors, r = 12) so the plaque never sits on the beam (C_ux F03).
//
// Pure: plaqueLines(cell, fmt), plaqueItem(model, anchor, type). DOM: createPlaque(layer).

import {textWidth} from "./kinetic.js";

/* cell = {nH, T, v, f, ion} (cm^-3, K, km/s, ion fraction) from story data; plain = optional {nH, T, v, f} strings.
   -> [{k, v, plain}] in display order. Formatting is numeric only; words come from copy. */
export function plaqueLines(cell, plain = {}) {
  if (!cell) return [];
  const sci = x => { if (!(x > 0)) return "0"; const e = Math.floor(Math.log10(x)), m = x / 10 ** e; return `${m.toFixed(1)}×10${sup(e)}`; };
  const sup = n => String(n).replace(/-/g, "⁻").replace(/\d/g, d => "⁰¹²³⁴⁵⁶⁷⁸⁹"[d]);
  const out = [];
  if (cell.nH != null) out.push({k: "n", v: `${sci(cell.nH)} cm⁻³`, plain: plain.nH});
  if (cell.T != null) out.push({k: "T", v: `${sci(cell.T)} K`, plain: plain.T});
  if (cell.v != null) out.push({k: "v", v: `${cell.v >= 0 ? "+" : "−"}${Math.abs(cell.v).toFixed(0)} km/s`, plain: plain.v});
  if (cell.f != null) out.push({k: cell.ion ? `f(${cell.ion})` : "f", v: cell.f >= 0.01 ? cell.f.toFixed(2) : sci(cell.f), plain: plain.f});
  return out;
}

/* size of the plaque at the mono size; secondary lines in sans at max(12, mono − 1) */
export function plaqueSize(lines, mono) {
  const sp = Math.max(12, mono - 1);
  let w = 0, h = 10;
  for (const l of lines) {
    w = Math.max(w, textWidth((l.k ? l.k + "  " : "") + l.v, "mono", mono));
    h += mono * 1.4;
    if (l.plain) { w = Math.max(w, textWidth(l.plain, "sans", sp)); h += sp * 1.35; }
  }
  return {w: Math.ceil(w + 20), h: Math.ceil(h + 6), font: Math.min(mono, sp)};
}

/* solver item: anchored at the projected cell, world band; a compact variant without plain lines (hidden before shrinking
   below 12 px). fix1 r4 (review1 beauty H3): the band fallback is capped. Past the 8 offsets beside its ring the plaque may
   only take a band slot whose nearest point is within PLAQUE_MAX_DIST of the ring (the solver's maxDist, which also drops
   a stale band slot once the ring moves away); otherwise it is hidden for that frame, never parked hundreds of px away
   where a reader cannot tell which bead it describes. */
export const PLAQUE_MAX_DIST = 48;
export function plaqueItem(lines, anchor, type, opts = {}) {
  if (!lines.length || !anchor) return null;
  const full = plaqueSize(lines, type.mono), lean = plaqueSize(lines.map(l => ({...l, plain: null})), type.mono);
  const vs = opts.phone ? [lean] : [full, lean];
  return {id: "plaque", kind: "plaque", priority: 60, anchor, gap: 18, band: "world", fallback: "band", maxDist: PLAQUE_MAX_DIST, minDist: 10, variants: vs,
          candidates: ["ne", "e", "se", "nw", "w", "sw", "n", "s"]};
}

/* ---------------------------------------------------------------- DOM */
export function createPlaque(layer) {
  const el = document.createElement("div");
  el.className = "plaque"; el.setAttribute("role", "group"); el.setAttribute("aria-label", "Current cell");
  el.hidden = true; layer.appendChild(el);
  let key = "";
  function render(lines, box, opts = {}) {
    if (!box || !lines.length) { el.hidden = true; return; }
    const compact = box.variant === 1 || opts.phone;
    const k = JSON.stringify([lines, compact]);
    if (k !== key) {
      key = k;
      el.innerHTML = lines.map(l => `<div class="pl-row">${l.k ? `<span class="pl-k">${l.k}</span>` : ""}<span class="pl-v" data-key="cell.${l.key || l.k}">${l.v}</span></div>` +
        (l.plain && !compact ? `<div class="pl-plain" data-key="cell.${l.key || l.k}">${l.plain}</div>` : "")).join("");
    }
    el.hidden = false;
    el.style.transform = `translate3d(${box.x.toFixed(1)}px,${box.y.toFixed(1)}px,0)`;
    el.style.width = box.w + "px";
    el.style.opacity = opts.opacity != null ? opts.opacity.toFixed(3) : "1";
  }
  return {render, el};
}
