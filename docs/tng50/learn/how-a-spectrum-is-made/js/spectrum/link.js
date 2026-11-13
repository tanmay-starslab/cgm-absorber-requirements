// Screen-space links between the 3D stage and the spectrum dock (DESIGN_final §3.5 B9/B11/B13, C_ux P0-5/P0-7, §4 G3).
//
//   connector(fs, data, geom, project)  the probe cell -> its dip in the dock. Enters the dock FROM ABOVE: a cubic whose
//                                       last tangent is vertical, ending on the dock's top edge at X(V_cell) of the lead
//                                       ion's panel (never inside a label: the end box is "exempt" for the solver).
//   tethers(fs, data, geom, project)    B11: each lettered shell -> the dock top edge at X(V_cloud);
//                                       B13: each cloud s -> component c, alpha ∝ M[s, c] share (CREST comps of the ion).
//                                       Tethers END AT THE DOCK TOP EDGE; they never run over the dock.
//   corridors(paths, r)                 the paths as solver corridors {a, b, r} (G3: no text box may cross them)
//
// Pure: no DOM, no time. `project(p) -> {x, y, ok}` is the stage's projection (stage.project); a point behind the camera
// (ok false) gives no link. `geom` is the dock layout of dock.js: {rect, top, panels: {<ion>: {x, w, v0, v1}}}.

export const LINK_VERSION = 1;
export const LANDING_U = 0.62, CASES_U = 0.84;   // = scenes/fit.js FIT_PHASES.landing / .cases (checked by story_spec)
const clamp = (x, a, b) => Math.min(b, Math.max(a, x));

/* ray point at ℓ (story-data/2 geometry.ray: p0 at ℓ = −half, unit n) */
export function rayPoint(data, l) {
  const r = data && data.geometry && data.geometry.ray;
  if (!r) return null;
  const t = l + (+r.half || 0);
  return [r.p0[0] + t * r.n[0], r.p0[1] + t * r.n[1], r.p0[2] + t * r.n[2]];
}
/* x of speed v inside a dock panel (same map the dock draws with) */
export function panelX(panel, v) { return panel.x + (clamp(v, panel.v0, panel.v1) - panel.v0) / (panel.v1 - panel.v0) * panel.w; }

/* cubic from a to b entering b vertically from above; control points keep the bend in the open stage */
function cubicDown(a, b) {
  const dy = Math.max(24, b.y - a.y);
  return {a, c1: {x: a.x, y: a.y + dy * 0.45}, c2: {x: b.x, y: b.y - dy * 0.55}, b};
}
export function samplePath(P, n = 16) {
  const out = [];
  for (let k = 0; k <= n; k++) {
    const t = k / n, u = 1 - t;
    out.push({x: u * u * u * P.a.x + 3 * u * u * t * P.c1.x + 3 * u * t * t * P.c2.x + t * t * t * P.b.x,
      y: u * u * u * P.a.y + 3 * u * u * t * P.c1.y + 3 * u * t * t * P.c2.y + t * t * t * P.b.y});
  }
  return out;
}

/* V of a story cell for ion k (data.ions.<k>.cells.V, aligned with geometry order) */
function cellV(data, ion, idx) {
  const C = data.ions && data.ions[ion] && data.ions[ion].cells;
  return C && Number.isFinite(+C.V[idx]) ? +C.V[idx] : null;
}

/* 3D centre of story cell `idx` (geometry.cells.centre, geometry order; idx maps through geometry.cells.idx) */
const centreMaps = new WeakMap();
export function cellCentre(data, idx) {
  const C = data && data.geometry && data.geometry.cells; if (!C || !C.centre || !C.idx) return null;
  let m = centreMaps.get(C); if (!m) { m = new Map(C.idx.map((i, j) => [i, j])); centreMaps.set(C, m); }
  const j = m.get(idx); return j == null ? null : [C.centre[3 * j], C.centre[3 * j + 1], C.centre[3 * j + 2]];
}
/* review2 three_d T5: where the selected cell is drawn (its ring sits at the cell centre, off the ray). The connector and
   the plaque leave from here when it is on screen above the dock; else from the probe on the ray. */
export function cellAnchor(fs, data, geom, project) {
  if (!fs || !fs.cell || typeof project !== "function") return null;
  const c = cellCentre(data, fs.cell.idx); if (!c) return null;
  const a = project(c); if (!a || a.ok === false || !Number.isFinite(a.x) || !Number.isFinite(a.y)) return null;
  if (a.x < 8 || a.y < 8 || (geom && geom.vw > 0 && a.x > geom.vw - 8) || (geom && Number.isFinite(geom.top) && a.y >= geom.top - 12)) return null;
  return {x: a.x, y: a.y};
}

export function connector(fs, data, geom, project) {
  if (!fs || !fs.cell || !geom || !geom.panels || typeof project !== "function") return null;
  if (fs.spec && fs.spec.mode && fs.spec.mode !== "intrinsic") return null;   // the finale reads the detector, not a cell
  const ion = fs.spec && fs.spec.lead || "OVI", panel = geom.panels[ion] || Object.values(geom.panels)[0];
  if (!panel) return null;
  const V = cellV(data, ion, fs.cell.idx); if (V == null || V < panel.v0 || V > panel.v1) return null;
  let a = cellAnchor(fs, data, geom, project), from = "cell";
  if (!a) { from = "probe"; const P = rayPoint(data, fs.l); if (!P) return null;
    a = project(P); if (!a || a.ok === false || !Number.isFinite(a.x) || !Number.isFinite(a.y)) return null; }
  if (a.y >= geom.top - 4) return null;                                  // drawn over the dock: no link
  // fix1 r4 (review1 scrolly S4): a probe that projects off the stage gets no connector (no edge chip is drawn for it), so
  // no line ever leads in from the screen edge to nothing. Same 8 px inset as cellAnchor.
  if (a.x < 8 || a.y < 8 || (geom.vw > 0 && a.x > geom.vw - 8)) return null;
  const b = {x: panelX(panel, V), y: geom.top};
  const w = fs.cell.w == null ? 1 : fs.cell.w, alpha = 0.35 + 0.65 * Math.sin(Math.PI * clamp(w, 0, 1));
  return {kind: "connector", id: "connector", ion, cellIdx: fs.cell.idx, V, alpha, from, ...cubicDown({x: a.x, y: a.y}, b)};
}

/* clouds of the CREST build that the story data link to (data.clouds_full: the loaded clouds.json, optional) */
function cloudList(data, ion) {
  const full = data && data.clouds_full && data.clouds_full.ions && data.clouds_full.ions[ion];
  if (full && Array.isArray(full.clouds)) return {clouds: full.clouds, comps: full.comps || [], M: full.M || null};
  return {clouds: [], comps: [], M: null};
}
function letterOf(data, id) {
  const L = data && data.cloud_names && data.cloud_names.letters; if (!L) return null;
  for (const [letter, byIon] of Object.entries(L)) for (const arr of Object.values(byIon)) if (arr.some(x => x.id === id)) return letter;
  return null;
}

/* review M1 (three_d): a tether whose shell projects outside the viewport is not drawn (it would leave the frame) */
const offScreen = (a, geom) => a.y < 0 || a.x < 0 || (geom.vw > 0 && a.x > geom.vw);
/* review2 three_d S1/T10: a lettered shell that projects off screen or under the dock is not dropped any more; its tether
   starts at an edge marker (the shell's direction clamped into the open stage: 14 px in from the sides and top, 30 px above
   the dock) and the letter chip sits there, so every lettered cloud keeps its link to the spectrum */
const EDGE_TOP = 64;   // below the HUD row (44 px chips + margins)
function edgeAnchor(a, geom) {
  const vw = geom.vw > 0 ? geom.vw : Infinity, top = Number.isFinite(geom.top) ? geom.top : Infinity;
  if (!offScreen(a, geom) && a.y < top - 4) return {x: a.x, y: a.y, edge: false};
  return {x: clamp(a.x, 14, vw - 14), y: clamp(a.y, EDGE_TOP, Math.max(EDGE_TOP, top - 30)), edge: true};
}
export function tethers(fs, data, geom, project) {
  if (!fs || !geom || !geom.panels || typeof project !== "function") return [];
  const out = [], beat = fs.beat && fs.beat.id;
  const shellAlpha = new Map((fs.shells || []).map(s => [s.id, s.alpha]));
  if (beat === "B11") {
    for (const ion of Object.keys(geom.panels)) {
      const {clouds} = cloudList(data, ion), panel = geom.panels[ion];
      for (const c of clouds) {
        const al = shellAlpha.get(c.id); if (!(al > 0.02) || !letterOf(data, c.id) || !Number.isFinite(c.V) || !c.centre) continue;
        const a0 = project(c.centre); if (!a0 || a0.ok === false || !Number.isFinite(a0.x) || !Number.isFinite(a0.y)) continue;
        const a = edgeAnchor(a0, geom);
        out.push({kind: "tether", id: `tether:${c.id}`, ion, cloud: c.id, letter: letterOf(data, c.id), alpha: (a.edge ? 0.55 : 0.85) * al, edge: a.edge,
          ...cubicDown({x: a.x, y: a.y}, {x: panelX(panel, c.V), y: geom.top})});
      }
    }
  } else if (beat === "B9") {
    // review2 three_d T2/S2: B9's point is two cells far apart (select.S6_pair, |dl| >= 50 kpc) at the same speed sharing one
    // dip. From u 0.5 (before the "apart" caption) to 0.97 both cells are ringed and tethered to their (common) dip
    const pr = data && data.select && data.select.S6_pair, u = fs.beat.u || 0, ion = (fs.spec && fs.spec.lead) || "OVI", panel = geom.panels[ion];
    if (pr && Array.isArray(pr.cells) && pr.cells.length === 2 && panel && u > 0.5 && u < 0.97) {
      const al = clamp((u - 0.5) / 0.05, 0, 1) * clamp((0.97 - u) / 0.04, 0, 1);
      for (const idx of pr.cells) {
        const c = cellCentre(data, idx), V = cellV(data, ion, idx); if (!c || V == null) continue;
        const a0 = project(c); if (!a0 || a0.ok === false || !Number.isFinite(a0.x) || !Number.isFinite(a0.y)) continue;
        const a = edgeAnchor(a0, geom);
        out.push({kind: "tether", id: `tether:pair:${idx}`, ion, pair: true, cell: idx, edge: a.edge, alpha: 0.95 * al,
          ...cubicDown({x: a.x, y: a.y}, {x: panelX(panel, V), y: geom.top})});
      }
    }
  } else if (beat === "B13" && fs.spec && fs.spec.mode === "fit") {
    const u = fs.beat.u || 0;
    if (u < LANDING_U || u >= CASES_U) return out;                           // the landing phase of B13 only (scenes/fit.js FIT_PHASES)
    const ion = fs.spec.lead || "OVI", panel = geom.panels[ion]; if (!panel) return out;
    const {clouds, comps} = cloudList(data, ion);
    const land = clamp((u - LANDING_U) / 0.06, 0, 1);
    comps.forEach(cp => {
      for (const [s, share] of cp.clouds || []) {
        const c = clouds[s]; if (!c || !c.centre || !(share >= 0.05)) continue;
        const a0 = project(c.centre); if (!a0 || a0.ok === false || !Number.isFinite(a0.x) || !Number.isFinite(a0.y)) continue;
        const a = edgeAnchor(a0, geom);
        out.push({kind: "tether", id: `tether:${c.id}:${cp.c}`, ion, cloud: c.id, letter: letterOf(data, c.id), comp: cp.c, share, edge: a.edge,
          alpha: land * (0.25 + 0.75 * share) * (a.edge ? 0.65 : 1),
          ...cubicDown({x: a.x, y: a.y}, {x: panelX(panel, cp.v), y: geom.top})});
      }
    });
  }
  return out;
}

/* solver corridors from link paths (G3) */
export function corridors(paths, r = 10) {
  const out = [];
  for (const P of paths || []) {
    const pts = samplePath(P, 12);
    for (let k = 1; k < pts.length; k++) out.push({a: [pts[k - 1].x, pts[k - 1].y], b: [pts[k].x, pts[k].y], r, id: P.id});
  }
  return out;
}
