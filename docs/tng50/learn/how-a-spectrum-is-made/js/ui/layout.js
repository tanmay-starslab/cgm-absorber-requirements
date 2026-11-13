// One collision solver for every label on the stage (DESIGN §8.2 solver rules, DESIGN_final §3.3, §4 G1-G3, §5.6).
// Pure: no DOM reads, no time, no randomness. The browser measures sizes once per string and class; node runs the same
// function over a size table for the full G1 matrix.
//
//   solve(items, ctx) -> {placed: [Box], hidden: [{id, reason}], byId: {id: Box}}
//   overlaps(boxes, opts) -> [{a, b, area}]          (the G1 check, shared by tests and window.__story.rects())
//
// item = {
//   id, priority,                 // higher is placed first (PRIORITY below); ties keep input order
//   kind,                         // "hud" | "dock" | "rail" | "display" | "sub" | "plaque" | "eq" | "chip" | "tag" | "hint" ...
//   rect?: {x, y, w, h},          // fixed box (HUD, dock, rail): placed as is or hidden
//   size?: {w, h, font?},         // box size; or
//   variants?: [{w, h, font?, key?}],   // tried in order (e.g. display, then display_short); font < minFont is never used
//   anchor?: {x, y}, gap?,        // projected world point; tries the 8 offsets in `candidates` (default E W NE NW SE SW N S)
//   candidates?: ["e", ...],
//   band?: "text" | ... | rect | ["text", "act"],   // region the box must stay inside (name looks up ctx.bands); with a
//                                 // list, band-scan candidates come from each band in order and the last bounds the box
//   bandAlts?: [band, ...],       // band items: each variant is tried in these bands in order, each bounding its own
//                                 // candidates (end actions: eq band, then text+eq, then world); `band` is ignored
//   align?: "start" | "end",      // band items: hug the start (left) or end (right) side
//   vAlign?: "top" | "bottom",    // scan top to bottom (default) or bottom to top
//   fallback?: "band" | null,     // anchored items: after the 8 offsets, scan the band (sorted by distance to the anchor)
//   container?: id,               // child of a placed box (dock labels): must sit inside it, does not collide with it
//   group?: string,               // kinetic group; only one group per band (groupBand, else band) is visible
//   opacity?: number,             // < 0.02 counts as not visible (exits), takes no space
//   exempt?: bool,                // connector end: takes no space, never checked
//   avoid?: bool,                 // stay off ctx.corridors (default true for non-fixed items)
//   avoidBands?: ["text"],        // never intersect these bands (act titles keep the text column free for its lines);
//   avoidSoft?: bool,             // ... unless nothing else fits (a later, higher-priority-free pass)
//   pad?: number,                 // breathing room in px (default 4; 0 for fixed boxes)
// }
// ctx = {w, h, bands, corridors?: [{a: [x, y], b: [x, y], r}], minFont?: 12, prev?: {id: {x, y, cand, variant}}}
//   prev: last frame's placement (hysteresis, review SC-2); without it the solver is the same pure function as before
// Box = {id, kind, priority, x, y, w, h, band, cand, variant, container, group}

export const PRIORITY = Object.freeze({hud: 100, dock: 90, rail: 85, display: 70, sub: 65, plaque: 60, eq: 50, hint: 45,
  chip: 40, tag: 30, endLabel: 25});
export const OFFSETS = Object.freeze(["e", "w", "ne", "nw", "se", "sw", "n", "s"]);
export const VISIBLE_MIN = 0.02;

const area = (a, b) => {
  const w = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x);
  const h = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
  return w > 0 && h > 0 ? w * h : 0;
};
const inside = (r, c, eps = 0.5) => r.x >= c.x - eps && r.y >= c.y - eps && r.x + r.w <= c.x + c.w + eps && r.y + r.h <= c.y + c.h + eps;
const grow = (r, p) => ({x: r.x - p, y: r.y - p, w: r.w + 2 * p, h: r.h + 2 * p});

/* segment a-b (thickened by r) against rect: Liang-Barsky on the rect grown by r */
export function segmentHitsRect(a, b, r, rect) {
  const g = grow(rect, r), x0 = g.x, y0 = g.y, x1 = g.x + g.w, y1 = g.y + g.h;
  let t0 = 0, t1 = 1;
  const dx = b[0] - a[0], dy = b[1] - a[1];
  const clip = (p, q) => {
    if (p === 0) return q >= 0;
    const t = q / p;
    if (p < 0) { if (t > t1) return false; if (t > t0) t0 = t; } else { if (t < t0) return false; if (t < t1) t1 = t; }
    return true;
  };
  return clip(-dx, a[0] - x0) && clip(dx, x1 - a[0]) && clip(-dy, a[1] - y0) && clip(dy, y1 - a[1]) && t0 < t1;
}

function offsetBox(name, ax, ay, w, h, g) {
  switch (name) {
    case "e": return {x: ax + g, y: ay - h / 2};
    case "w": return {x: ax - g - w, y: ay - h / 2};
    case "ne": return {x: ax + g, y: ay - g - h};
    case "nw": return {x: ax - g - w, y: ay - g - h};
    case "se": return {x: ax + g, y: ay + g};
    case "sw": return {x: ax - g - w, y: ay + g};
    case "n": return {x: ax - w / 2, y: ay - g - h};
    case "s": return {x: ax - w / 2, y: ay + g};
    default: return null;
  }
}

/* band scan positions: start (or end) side, top to bottom (or bottom to top); then the other side; ≤ 2 × 24 positions spanning the band */
function bandScan(band, w, h, align, vAlign) {
  if (!band || w > band.w + 0.5 || h > band.h + 0.5) return [];
  const out = [], last = band.y + band.h - h, step = Math.max(8, Math.round(h / 4), Math.ceil((last - band.y) / 23));   // ≤ 24 rows cover the band
  const xs = align === "end" ? [band.x + band.w - w, band.x] : [band.x, band.x + band.w - w];
  for (const x of xs) {
    let k = 0;
    if (vAlign === "bottom") for (let y = last; y >= band.y - 0.5 && k < 24; y -= step, k++) out.push({x, y: Math.max(y, band.y), cand: "band"});
    else for (let y = band.y; y <= last + 0.5 && k < 24; y += step, k++) out.push({x, y: Math.min(y, last), cand: "band"});
    if (Math.abs(xs[0] - xs[1]) < 0.5) break;
  }
  return out;
}

/* bandScan plus three interior columns (alternative-band items: a free spot beside a diagonal beam is often mid-band) */
function denseScan(band, w, h, align, vAlign) {
  const base = bandScan(band, w, h, align, vAlign);
  if (!base.length) return base;
  const slack = band.w - w; if (slack < 16) return base;
  const ys = [...new Set(base.map(c => c.y))], out = [...base];
  for (const f of align === "end" ? [0.75, 0.5, 0.25] : [0.25, 0.5, 0.75]) for (const y of ys) out.push({x: band.x + slack * f, y, cand: "band"});
  return out;
}
function scanAll(spec, ctx, fallback, w, h, align, vAlign) {
  if (Array.isArray(spec)) { const out = []; for (const b of spec) out.push(...bandScan(resolveBand(b, ctx), w, h, align, vAlign)); return out; }
  return bandScan(fallback, w, h, align, vAlign);
}
function resolveBand(b, ctx) {
  if (!b) return null;
  if (Array.isArray(b)) return resolveBand(b[b.length - 1], ctx);   // the last (widest) band bounds the item
  if (typeof b === "string") return (ctx.bands && ctx.bands[b]) || null;
  return b;
}
const bandKey = b => (Array.isArray(b) ? b.join("+") : typeof b === "string" ? b : "_");

/* distance from a point to the nearest point of a box (0 inside) */
const boxDist = (x, y, w, h, a) => Math.hypot(Math.max(x - a.x, 0, a.x - (x + w)), Math.max(y - a.y, 0, a.y - (y + h)));

export function solve(items, ctx) {
  const W = ctx.w, H = ctx.h, minFont = ctx.minFont || 12, view = {x: 0, y: 0, w: W, h: H};
  const corridors = ctx.corridors || [];
  const hidden = [], placed = [], byId = {};
  const order = items.map((it, i) => ({it, i}));

  // visibility and the one-group-per-band rule
  const live = [];
  const groupWin = {};                                   // band -> {group, op, pr}
  for (const o of order) {
    const it = o.it;
    if (it.opacity != null && it.opacity < VISIBLE_MIN) { hidden.push({id: it.id, reason: "invisible"}); continue; }
    live.push(o);
    if (it.group) {
      const bk = it.groupBand || bandKey(it.band);
      const op = it.opacity == null ? 1 : it.opacity, pr = it.priority || 0, cur = groupWin[bk];
      if (!cur || op > cur.op + 1e-9 || (Math.abs(op - cur.op) <= 1e-9 && pr > cur.pr)) groupWin[bk] = {group: it.group, op, pr};
    }
  }
  const live2 = [];
  for (const o of live) {
    const it = o.it;
    if (it.group) {
      const bk = it.groupBand || bandKey(it.band);
      if (groupWin[bk].group !== it.group) { hidden.push({id: it.id, reason: "group"}); continue; }
    }
    live2.push(o);
  }
  // a child sorts just after its container whatever its own priority (it can only be placed inside a placed box)
  const pr = {};
  for (const o of live2) pr[o.it.id] = o.it.priority || 0;
  const key = it => (it.container && pr[it.container] != null ? Math.min(it.priority || 0, pr[it.container] - 1e-6) : (it.priority || 0));
  live2.sort((a, b) => (key(b.it) - key(a.it)) || (a.i - b.i));

  let softPass = false;                                   // second pass: avoidBands lifted (it.avoidSoft)
  const fits = (box, it, pad, parent) => {
    if (!inside(box, view)) return false;
    if (parent && !inside(box, parent)) return false;
    const gb = pad ? grow(box, pad) : box;
    for (const p of placed) {
      if (p.exempt) continue;
      if (parent && p.id === it.container) continue;       // a child may sit on its container
      if (p.container && p.container === it.id) continue;
      if (area(gb, p) > 0) return false;
    }
    if (it.avoidBands && !softPass) for (const nb of it.avoidBands) { const r = resolveBand(nb, ctx); if (r && area(box, r) > 0) return false; }
    if (it.avoid !== false && !it.rect) {
      for (const c of corridors) if (segmentHitsRect(c.a, c.b, c.r || 0, box)) return false;
    }
    return true;
  };

  for (const {it} of live2) {
    const alts = it.bandAlts ? it.bandAlts.map(b => resolveBand(b, ctx)).filter(b => b && b.w > 0 && b.h > 0) : null;
    if (alts && !it.rect && !it.anchor) {                 // alternative bands (no anchor, no fixed rect): variant outer, band inner
      if (!alts.length) { hidden.push({id: it.id, reason: "no-band"}); continue; }
      const pad = it.pad != null ? it.pad : 4;
      const all = it.variants || (it.size ? [it.size] : []), keep = all.map((v, i) => i).filter(i => all[i] && (all[i].font == null || all[i].font >= minFont));
      let done = null;
      const pv = ctx.prev && ctx.prev[it.id];
      if (pv && keep.includes(pv.variant) && pv.cand && pv.cand.startsWith("alt")) {
        const bx = alts[+pv.cand.slice(3)], {w, h} = all[pv.variant], box = {x: pv.x, y: pv.y, w, h};
        if (bx && inside(box, bx) && fits(box, it.avoidSoft ? {...it, avoid: false} : it, pad, null)) done = {...box, cand: pv.cand, variant: pv.variant};
      }
      // avoidSoft here: a second pass without the corridors (controls, not text: G3 covers text and equations)
      for (const soft of it.avoidSoft ? [false, true] : [false]) {
        const it2 = soft ? {...it, avoid: false} : it;
        for (let vi = 0; vi < keep.length && !done; vi++) {
          const {w, h} = all[keep[vi]];
          for (let bi = 0; bi < alts.length && !done; bi++) for (const c of denseScan(alts[bi], w, h, it.align, it.vAlign)) {
            const box = {x: c.x, y: c.y, w, h};
            if (inside(box, alts[bi]) && fits(box, it2, pad, null)) { done = {...box, cand: "alt" + bi, variant: keep[vi], soft}; break; }
          }
        }
        if (done) break;
      }
      if (done) {
        const b = {id: it.id, kind: it.kind || "label", priority: it.priority || 0, x: done.x, y: done.y, w: done.w, h: done.h, band: "alt",
                   cand: done.cand, variant: done.variant, container: null, group: it.group || null, exempt: false, ...(done.soft ? {overBeam: true} : {}),
                   ...(it.opacity != null ? {opacity: it.opacity} : {})};
        placed.push(b); byId[it.id] = b;
      } else hidden.push({id: it.id, reason: keep.length ? "no-room" : "below-floor"});
      continue;
    }
    const band = resolveBand(it.band, ctx);
    if (it.band && !band) { hidden.push({id: it.id, reason: "no-band"}); continue; }   // a named band this layout lacks
    const parent = it.container ? byId[it.container] : null;
    if (it.container && !parent) { hidden.push({id: it.id, reason: "no-container"}); continue; }
    const pad = it.pad != null ? it.pad : (it.rect ? 0 : 4);
    const put = (x, y, w, h, cand, variant) => {
      const b = {id: it.id, kind: it.kind || "label", priority: it.priority || 0, x, y, w, h, band: it.groupBand || (it.band ? bandKey(it.band) : null),
                 cand, variant, container: it.container || null, group: it.group || null, exempt: !!it.exempt,
                 ...(it.opacity != null ? {opacity: it.opacity} : {})};
      placed.push(b); byId[it.id] = b; return b;
    };
    if (it.exempt) {                                       // connector end: drawn, never blocks, never blocked
      const r = it.rect || (it.anchor && it.size ? {x: it.anchor.x - it.size.w / 2, y: it.anchor.y - it.size.h / 2, ...it.size} : null);
      if (r) put(r.x, r.y, r.w, r.h, "exempt", 0); else hidden.push({id: it.id, reason: "no-geometry"});
      continue;
    }
    if (it.rect) {
      const r = it.rect;
      if (fits(r, it, pad, parent) && (!band || inside(r, band))) put(r.x, r.y, r.w, r.h, "fixed", 0);
      else hidden.push({id: it.id, reason: "fixed-blocked"});
      continue;
    }
    // Box.variant is the index into it.variants as given (the overlay maps it back), not into the font-filtered list
    const all = it.variants || (it.size ? [it.size] : []), keep = all.map((v, i) => i).filter(i => all[i] && (all[i].font == null || all[i].font >= minFont));
    const variants = keep.map(i => all[i]);
    if (!variants.length) { hidden.push({id: it.id, reason: it.variants || it.size ? "below-floor" : "no-size"}); continue; }
    let done = false;
    // review SC-2 hysteresis: a box that was placed last frame keeps its slot (same anchor offset, or the same band position)
    // and its variant while that slot stays feasible; only an infeasible slot makes it move or switch variant
    const pv = ctx.prev && ctx.prev[it.id];
    if (pv && keep.includes(pv.variant)) {
      const {w, h} = all[pv.variant];
      let o = it.anchor && pv.cand && pv.cand !== "band" ? offsetBox(pv.cand, it.anchor.x, it.anchor.y, w, h, it.gap != null ? it.gap : 10)
        : pv.cand === "band" || !it.anchor ? {x: pv.x, y: pv.y} : null;
      if (o && it.maxDist != null && it.anchor && boxDist(o.x, o.y, w, h, it.anchor) > it.maxDist) o = null;
      if (o && pv.cand === "band" && it.minDist != null && it.anchor && boxDist(o.x, o.y, w, h, it.anchor) < it.minDist) o = null;   // fix1 r4   // fix3: a stale band slot left behind by its anchor
      if (o) {
        const box = {x: o.x, y: o.y, w, h};
        if ((!band || inside(box, band)) && fits(box, it, pad, parent)) { put(o.x, o.y, w, h, pv.cand, pv.variant); done = true; }
      }
    }
    for (const pass of done ? [] : it.avoidBands && it.avoidSoft ? [false, true] : [false]) {
    softPass = pass;
    for (let vi = 0; vi < variants.length && !done; vi++) {
      const {w, h} = variants[vi];
      const cands = [];
      if (it.anchor) {
        const g = it.gap != null ? it.gap : 10;
        for (const n of (it.candidates || OFFSETS)) { const o = offsetBox(n, it.anchor.x, it.anchor.y, w, h, g); if (o) cands.push({...o, cand: n}); }
        if (it.fallback === "band" && band) {
          let s = scanAll(it.band, ctx, band, w, h, it.align, it.vAlign);
          if (it.maxDist != null) s = s.filter(p => boxDist(p.x, p.y, w, h, it.anchor) <= it.maxDist);
          // fix1 r4 (beauty H3): minDist keeps a band slot from covering its own anchor (the plaque drawn over its ring)
          if (it.minDist != null) s = s.filter(p => boxDist(p.x, p.y, w, h, it.anchor) >= it.minDist);
          s.sort((p, q) => Math.hypot(p.x + w / 2 - it.anchor.x, p.y + h / 2 - it.anchor.y) - Math.hypot(q.x + w / 2 - it.anchor.x, q.y + h / 2 - it.anchor.y));
          cands.push(...s);
        }
      } else if (parent && !band) {
        cands.push(...bandScan(parent, w, h, it.align, it.vAlign));
      } else {
        cands.push(...scanAll(it.band, ctx, band || view, w, h, it.align, it.vAlign));
      }
      for (const c of cands) {
        const box = {x: c.x, y: c.y, w, h};
        if (band && !inside(box, band)) continue;
        if (fits(box, it, pad, parent)) { put(c.x, c.y, w, h, c.cand, keep[vi]); done = true; break; }
      }
    }
    if (done) break;
    }
    softPass = false;
    // fallbackBand (integrator run 3, G9): band text whose own band is blocked (the beam crosses the phone's top text band)
    // tries the named band before it is hidden, so a jump never lands on a beat with its narration dropped. The box keeps
    // its group band (one kinetic group per band still holds); used only when every variant failed in the item's own band.
    if (!done && it.fallbackBand && !it.anchor && !parent) {
      const fb = resolveBand(it.fallbackBand, ctx);
      for (let vi = 0; fb && vi < variants.length && !done; vi++) {
        const {w, h} = variants[vi];
        for (const c of bandScan(fb, w, h, it.align, it.vAlign)) {
          const box = {x: c.x, y: c.y, w, h};
          if (inside(box, fb) && fits(box, it, pad, null)) { put(c.x, c.y, w, h, "fb", keep[vi]); done = true; break; }
        }
      }
    }
    if (!done) hidden.push({id: it.id, reason: "no-room"});
  }
  return {placed, hidden, byId};
}

/* G1 check: pairs of visible boxes intersecting by more than tol px² (children may overlap their container; exempt boxes
   are skipped), plus boxes leaving the viewport when ctx is given. */
export function overlaps(boxes, opts = {}) {
  const tol = opts.tol != null ? opts.tol : 4, out = [];
  const bs = boxes.filter(b => !b.exempt);
  for (let i = 0; i < bs.length; i++) for (let j = i + 1; j < bs.length; j++) {
    const a = bs[i], b = bs[j];
    if (a.container === b.id || b.container === a.id) continue;
    const s = area(a, b);
    if (s > tol) out.push({a: a.id, b: b.id, area: s});
  }
  if (opts.w && opts.h) for (const b of bs) if (!inside(b, {x: 0, y: 0, w: opts.w, h: opts.h}, 0.5)) out.push({a: b.id, b: "viewport", area: -1});
  return out;
}

/* node G1 composer (U_qa's story_overlap contract: layout.itemsFor next to layout.solve). It lives in hud.js with the frame
   composer; the import cycle is safe because neither module calls the other at load time. */
export {itemsFor} from "./hud.js";
