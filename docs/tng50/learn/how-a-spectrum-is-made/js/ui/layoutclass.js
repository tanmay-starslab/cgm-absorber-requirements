// Layout classes and bands for the v2 stage (DESIGN_final §3.3; DESIGN §8.2-8.3). Pure: no DOM, no time.
//
//   layoutClass(w, h)                 -> "narrow" | "phoneLandscape" | "phonePortrait" | "desktop" | "compact" | "tablet"
//   computeBands(cls, w, h, opts)     -> {hud, text, eq, world, dock, rail} as CSS px rects {x, y, w, h} (a band may be null)
//   typeScale(cls, w, h)              -> {fpx, display: [l1, l2, l3], sub, mono, eq, floor} in CSS px
//
// w, h are CSS px after browser zoom (window.innerWidth / innerHeight), so 1440×900 at 150 % arrives as 960×600.
// Rules are evaluated in the order of CLASS_ORDER and the first match wins, so every (w, h) has exactly one class.
// Fractions are of the stage box; px floors keep 44 px touch targets and the 12 px type floor at small sizes. Where the
// §3.3 table's fractions disagree with the dock's own height (desktop world "y 9-84 %" vs a strip dock that starts at 81 %),
// the band is clipped to sit above the dock with a gap: the solver may never place a non-child over the dock (G1).

export const CLASS_ORDER = Object.freeze(["narrow", "phoneLandscape", "phonePortrait", "desktop", "compact", "tablet"]);

const RULES = {
  narrow: (w) => w <= 320,
  phoneLandscape: (w, h) => h <= 480 && w / h >= 1.2,
  phonePortrait: (w, h) => w <= 480 && w / h < 0.75 && w > 320,
  desktop: (w, h) => w >= 1024 && h >= 680 && w / h >= 1.2,
  compact: (w, h) => w / h >= 1.2 && h > 480 && (h < 680 || w < 1024),
  tablet: (w, h) => (w / h >= 0.75 && w / h < 1.2) || (w / h < 0.75 && w > 480),
};

/* every rule that matches (for the exclusivity test); the class is the first one in CLASS_ORDER */
export function matchingRules(w, h) {
  return CLASS_ORDER.filter(c => RULES[c](w, h));
}
export function layoutClass(w, h) {
  if (!(w > 0) || !(h > 0)) return "desktop";
  for (const c of CLASS_ORDER) if (RULES[c](w, h)) return c;
  return "tablet";                                     // unreachable: the rules cover the plane (tested)
}
export const isPhone = cls => cls === "phonePortrait" || cls === "phoneLandscape" || cls === "narrow";

/* Band table, fractions of the stage. dock: height of strip / pair / hero measured up from the rail top.
   text.side: "column" (textSide column, desktop/compact), "full" (full width) or "left" (phone landscape). */
export const BANDS = Object.freeze({
  desktop: {hud: [0, 0.07], hudMin: 56, text: {x: [0.05, 0.42], y: [0.09, 0.40]}, eq: {y: [0.40, 0.64], toDock: true},
    world: {x: [0.45, 0.98], y: [0.09, 0.84], yPair: 0.74}, dock: {strip: 0.14, pair: 0.24, hero: 0.42}, dockX: [0.017, 0.983],
    rail: 0.05, railMin: 44, eqMax: 4},
  compact: {hud: [0, 0.09], hudMin: 52, text: {x: [0.05, 0.46], y: [0.10, 0.34]}, eq: {y: [0.34, 0.58], toDock: true},
    world: {x: [0.48, 0.98], y: [0.10, 0.84], yPair: 0.74}, dock: {strip: 0.16, pair: 0.26, hero: 0.46}, dockX: [0.017, 0.983],
    rail: 0.06, railMin: 44, eqMax: 1, displayLines: 2},
  tablet: {hud: [0, 0.07], hudMin: 56, text: {x: [0.05, 0.95], y: [0.08, 0.22]}, eq: {y: [0.22, 0.32]},
    world: {x: [0.03, 0.97], y: [0.32, 0.80], yPair: 0.66}, dock: {strip: 0.16, pair: 0.28, hero: 0.60}, dockX: [0.02, 0.98],
    rail: 0.06, railMin: 44, eqMax: 2},
  phonePortrait: {hud: [0, 0.10], hudMin: 60, text: {x: [0.04, 0.96], y: [0.10, 0.24]}, textMin: 120, eq: {stepped: true, hFrac: 0.07, hMin: 60},
    world: {x: [0.03, 0.97], y: [0.24, 0.78], yPair: 0.66}, dock: {strip: 0.18, pair: 0.30, hero: 0.62}, dockX: [0.02, 0.98],
    rail: 0.04, railMin: 44, eqMax: 1, displayLines: 2},
  phoneLandscape: {hud: null, hudMin: 0, text: {x: [0.03, 0.40], y: [0.04, 0.46]}, eq: {x: [0.03, 0.40], y: [0.46, 0.78], toDock: true},
    world: {x: [0.42, 0.98], y: [0.04, 0.70]}, dock: {strip: 0.20, pair: 0.20, hero: 0.70}, dockX: [0.42, 0.98],
    rail: 0.08, railMin: 44, eqMax: 1, displayLines: 2, menuInRail: true},
  narrow: {hud: [0, 0.10], hudMin: 60, text: {x: [0.04, 0.96], y: [0.10, 0.26]}, textMin: 132, eq: {stepped: true, hFrac: 0.07, hMin: 48},
    world: {x: [0.03, 0.97], y: [0.26, 0.78], yPair: 0.66}, dock: {strip: 0.18, pair: 0.30, hero: 0.62}, dockX: [0.02, 0.98],
    rail: 0.04, railMin: 44, eqMax: 1, displayLines: 2, chipOnly: true},
});

export const GAP = 8;                                    // px between bands
export const MIN_BAND = 24;                              // a band thinner than this is dropped (null)
export const EQ_MIN_BAND = 64;                           // an equation band thinner than this borrows the text column's lower part
export const EQ_CHIP_BAND = 52;                          // U_eq's one-line chip/short box (48 px at 17 px) + the solver's 4 px pad
export const HERO_GIVE = 0.10;                           // the hero dock gives up at most this much stage height for an equation chip
export const HERO_GIVE_NARROW = 0.10;                   // narrow: as HERO_GIVE (0.18 would also fit 260x563, but the beam then crosses that chip band at B12a's start: story_core G3)

const R = (x0, y0, x1, y1) => ({x: x0, y: y0, w: Math.max(0, x1 - x0), h: Math.max(0, y1 - y0)});
const live = r => (r && r.w >= MIN_BAND && r.h >= MIN_BAND ? r : null);

/* opts: {textSide: "left" | "right", dock: "strip" | "pair" | "hero", insets: {top, right, bottom, left}} */
export function computeBands(cls, w, h, opts = {}) {
  const B = BANDS[cls] || BANDS.desktop;
  const dockState = opts.dock === "pair" || opts.dock === "hero" ? opts.dock : "strip";
  const side = opts.textSide === "right" && (cls === "desktop" || cls === "compact") ? "right" : "left";
  const ins = Object.assign({top: 0, right: 0, bottom: 0, left: 0}, opts.insets || {});
  const L = ins.left, Rt = w - ins.right, W = Rt - L;
  const X = f => L + f * W, Y = f => f * h;

  // rail at the bottom (≥ railMin px, above the home indicator)
  const railH = Math.max(B.rail * h, B.railMin);
  const rail = R(L, h - ins.bottom - railH, Rt, h - ins.bottom);

  // HUD at the top (none in phone landscape: the menu lives in the rail)
  const hud = B.hud ? R(L, 0, Rt, Math.max(B.hud[1] * h, B.hudMin) + ins.top) : null;
  const top = hud ? hud.y + hud.h + GAP : ins.top + GAP;

  // dock up from the rail top; a tall (hero) dock never squeezes the text band below its minimum (short or inset screens)
  const textMinPx = B.textMin || (cls === "phoneLandscape" ? 0 : 72);
  const fullW = B.dockX[0] < 0.1;
  let dockCap = fullW ? rail.y - (top + textMinPx + GAP) : Infinity;
  // hero (B12a R, B12b S/N, B13 fit): keep room for one equation chip above the dock as well (E6/E7/E8 explain the
  // hero); the dock gives up at most HERO_GIVE of the stage height for it, otherwise the hero keeps its size, no chip
  // narrow (chipOnly) too: U_eq's "short" variants are 44 px tall, so its 48 px stepped chip band now holds E6/E7/E8 (integrator, run 3)
  if (dockState === "hero" && fullW) {
    const eqRoom = B.eq.stepped ? Math.max(B.eq.hFrac * h, B.eq.hMin) + GAP : B.eq.toDock && !B.eq.x ? EQ_CHIP_BAND + GAP : 0;
    const cap2 = dockCap - eqRoom;
    if (eqRoom && B.dock.hero * h - cap2 <= (B.chipOnly ? HERO_GIVE_NARROW : HERO_GIVE) * h) dockCap = Math.min(dockCap, cap2);
  }
  const dockH = Math.max(0, Math.min(B.dock[dockState] * h, dockCap));
  const dock = R(X(B.dockX[0]), rail.y - dockH, X(B.dockX[1]), rail.y);
  const dockTop = dock.y;
  const fullDock = fullW;                               // spans the width: everything else sits above it
  const ceil = fullDock ? dockTop - GAP : rail.y - GAP; // lowest y for left-side bands in phone landscape

  // text column
  let tx0 = B.text.x[0], tx1 = B.text.x[1];
  if (side === "right") { tx0 = 1 - B.text.x[1]; tx1 = 1 - B.text.x[0]; }
  const ty0 = Math.max(Y(B.text.y[0]), top);
  const tyEnd = Math.max(Y(B.text.y[1]), B.textMin ? ty0 + B.textMin : 0);
  let text = R(X(tx0), ty0, X(tx1), Math.min(tyEnd, ceil));

  // equations
  let eq = null;
  if (B.eq.stepped) {                                   // phone: one chip in its own band just above the dock edge
    const eh = Math.max(B.eq.hFrac * h, B.eq.hMin);
    eq = R(X(0.04), dockTop - GAP - eh, X(0.96), dockTop - GAP);
    if (eq.y - GAP < text.y + Math.min(text.h, B.textMin || 0) - 0.5) eq = null;          // hero: the text keeps its room, no chip
    else if (eq.y - GAP < text.y + text.h) text = R(text.x, text.y, text.x + text.w, eq.y - GAP);
  } else {
    const ex0 = B.eq.x ? B.eq.x[0] : tx0, ex1 = B.eq.x ? B.eq.x[1] : tx1;
    const ey0 = Math.max(Y(B.eq.y[0]), text.y + text.h + GAP);
    // column layouts: the column below the spec band is empty (the world is the other side), so the band runs to the
    // dock; U_eq's real boxes (value + symbolic line, wrapped to the column) need it (phase 1 size table)
    const ey1 = B.eq.toDock ? (fullDock ? dockTop - GAP : rail.y - GAP) : Math.min(Y(B.eq.y[1]), ceil);
    eq = R(X(ex0), ey0, X(ex1), Math.max(ey0, ey1));
    // hero dock (B12-B14): no room under the text, so the column is shared: equations take its lower part, the text keeps
    // at least its minimum
    // the shared column runs down to the dock (the text band's spec bottom would leave a sliver nobody uses)
    if (eq.h < EQ_MIN_BAND && B.eq.toDock && !B.eq.x && ey1 > text.y + text.h) text = R(text.x, text.y, text.x + text.w, ey1);
    if (eq.h < EQ_MIN_BAND && text.h >= textMinPx + GAP + EQ_CHIP_BAND && !B.eq.x) {
      // at least one chip (EQ_CHIP_BAND), up to 42 % of the column, never below the text's minimum
      const eh = Math.max(EQ_CHIP_BAND, Math.min(Math.max(EQ_MIN_BAND, Math.round(0.42 * text.h)), text.h - textMinPx - GAP));
      const cut = Math.max(text.y + textMinPx, text.y + text.h - eh - GAP);
      eq = R(text.x, cut + GAP, text.x + text.w, text.y + text.h);
      text = R(text.x, text.y, text.x + text.w, cut);
    } else if (eq.h < EQ_MIN_BAND && eq.y < text.y + text.h) eq = null;   // no room for a chip: the text keeps the column
  }

  // world: the other side in column layouts, full width otherwise
  let wx0 = B.world.x[0], wx1 = B.world.x[1];
  if ((cls === "desktop" || cls === "compact") && side === "right") { wx0 = 1 - B.world.x[1]; wx1 = 1 - B.world.x[0]; }
  let wy1 = dockState === "pair" && B.world.yPair ? B.world.yPair : B.world.y[1];
  let worldBottom = Math.min(Y(wy1), dockTop - GAP);
  if (B.eq.stepped && eq) worldBottom = Math.min(worldBottom, eq.y - GAP);
  const wTop = (cls === "tablet" || cls === "phonePortrait" || cls === "narrow")
    ? Math.max(Y(B.world.y[0]), (eq && !B.eq.stepped ? eq.y + eq.h : text.y + text.h) + GAP)
    : Math.max(Y(B.world.y[0]), top);
  const world = R(X(wx0), wTop, X(wx1), worldBottom);

  // act titles (z-planes): anchored near their projected ℓ anywhere on the free stage above the dock (or, in phone
  // landscape, the left column), preferring the text column; the solver keeps them off everything of higher priority
  // side margin = the text column's (4 % of the width, at least GAP): a title at the band edge sat 8 px from the screen
  // edge on phones while every other line keeps 16 px (U_shell p3 screenshots, 390 B0/B2)
  const am = Math.max(GAP, Math.round(0.04 * W));
  const act = R(L + am, top, Rt - am, fullDock ? dockTop - GAP : rail.y - GAP);
  return {cls, w, h, side, dockState, hud: live(hud) || hud, text: live(text), eq: live(eq), world: live(world),
          dock: live(dock), rail, act: live(act), menuInRail: !!B.menuInRail};
}

/* Type scale (DESIGN §8.3): fpx = min(w/1440, h/900); display 56/44/34 fpx with a floor of 26 px (22 px in narrow),
   subtitle 17 fpx floor 14, mono 13 fpx floor 12, equations 20 fpx floor 15. Nothing goes below 12 CSS px. */
/* equation font floor: U_eq's KaTeX uses one script level (0.7 em), so 17 px keeps every glyph >= 12 CSS px (G2) */
export const EQ_MIN_PX = 17;
export function typeScale(cls, w, h) {
  const fpx = Math.min(w / 1440, h / 900);
  const floor = cls === "narrow" ? 22 : 26;
  const d = n => Math.max(floor, Math.round(n * fpx));
  return {fpx, floor, display: [d(56), d(44), d(34)], sub: Math.max(14, Math.round(17 * fpx)),
          mono: Math.max(12, Math.round(13 * fpx)), eq: Math.max(EQ_MIN_PX, Math.round(20 * fpx)), min: 12,
          displayLines: (BANDS[cls] || {}).displayLines || 3, wordsPerLine: cls === "narrow" ? 5 : 8};
}

/* the G1 viewport × zoom matrix (DESIGN_final §4) as CSS sizes */
export const G1_VIEWPORTS = Object.freeze([[1920, 1080], [1440, 900], [1366, 768], [1280, 800], [1024, 768], [768, 1024],
  [390, 844], [844, 390], [2560, 1440]]);
export const G1_ZOOMS = Object.freeze([0.9, 1, 1.1, 1.25, 1.5]);
export function g1Matrix() {
  const out = [];
  for (const [vw, vh] of G1_VIEWPORTS) for (const z of G1_ZOOMS)
    out.push({vw, vh, zoom: z, w: Math.floor(vw / z), h: Math.floor(vh / z)});
  return out;
}
