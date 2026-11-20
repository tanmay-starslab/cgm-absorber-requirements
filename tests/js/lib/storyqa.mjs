// Shared harness of the story v2 gate scripts (U_qa; DESIGN_final §4 gates, §5.10). Used by tests/js/story_overlap.mjs,
// story_perf.mjs, story_a11y.mjs, story_budget.mjs and story_g11.mjs; nothing else imports it.
//
// Three layers, so every gate can be checked without a browser:
//   1. pure gate functions over a "snapshot" (plain JSON: boxes, paths, frame times, pixels ...). The browser runs
//      only collect snapshots; the self-tests feed the same functions committed fixtures (tests/js/fixtures/story_qa/),
//      one clean and one per seeded defect, and require clean -> pass, defect -> fail with the expected gate.
//   2. a page adapter that drives either the v2 scroll story (window.__story, DESIGN_final §5.11) or the v1 stepper
//      (window.storyApp + #s=<id>), so the harness runs today against v1 and unchanged against v2.
//   3. small utilities: layout-class reference (§3.3), viewport x zoom matrix (G1), PNG codec and luminance (G4, G11),
//      gzip static server (G6), a browser wrapper with extra Chrome flags.
//
// Snapshot contract (what the v2 page should return from __story.rects(); the DOM collector below fills the same shape
// from the live DOM, so v1 and any unregistered v2 element are covered too):
//   box  {id, kind, x, y, w, h, font?, lines?, role?, band?, group?, opacity?, parent?, chain?, blk?, chrome?, text?}
//        kind: "text" | "eq" | "label" | "control" | "dock" | "chrome" | "plaque" | "shell-chip" (any string; "dock"
//        is special: boxes whose parent/chain contains the dock id are its children and may overlap it)
//   path {id, kind: "beam" | "connector" | "tether" | "thread", pts: [[x, y], ...], attach?: [boxId, ...]}
// Numbers in visible text must sit inside an element with [data-key] (bound to story data) or [data-num] (UI counters
// such as "stop 1 of 4"); G10-dom reports any other digit run (v2 only: v1 has no such contract).
import {existsSync, readFileSync, readdirSync, statSync, writeFileSync, mkdtempSync, chmodSync} from "node:fs";
import {join, resolve, extname, dirname, relative} from "node:path";
import {tmpdir} from "node:os";
import {gzipSync, inflateSync, deflateSync} from "node:zlib";
import {ROOT as REPO} from "./browser.mjs";

export const STORY_REL = "learn/how-a-spectrum-is-made";
export const STORY_ROOT = join(REPO, "docs/tng50", STORY_REL);
export const FIX_DIR = join(REPO, "tests/js/fixtures/story_qa");

/* ---------------------------------------------------------------- matrix and layout classes (§3.3, G1) */
/** G1 viewports (CSS px at 100 % zoom). 683x512 and 260x563 are reached by zoom (1024x768 and 390x844 at 150 %) and
 *  are also listed on their own, as the gate table asks. */
export const VIEWPORTS = [[1920, 1080], [1440, 900], [1366, 768], [1280, 800], [1024, 768], [768, 1024], [390, 844], [844, 390], [2560, 1440], [683, 512], [260, 563]];
export const ZOOMS = [0.9, 1, 1.1, 1.25, 1.5];
export const QUICK_VIEWPORTS = [[1440, 900], [1024, 768], [390, 844]];
export const QUICK_ZOOMS = [1, 1.5];
export const CLASSES = ["narrow", "phone-landscape", "phone-portrait", "desktop", "compact-landscape", "tablet-portrait"];
const PHONE = new Set(["phone-portrait", "narrow"]);

/** Reference layout class of a CSS viewport after zoom (§3.3, first match wins). Returns every rule that matches too,
 *  so a test can prove the order matters only where intended. */
export function classOf(w, h) {
  const r = w / h, hits = [];
  if (w <= 320) hits.push("narrow");
  if (h <= 480 && r >= 1.2) hits.push("phone-landscape");
  if (w <= 480 && r < 0.75 && w > 320) hits.push("phone-portrait");
  if (w >= 1024 && h >= 680 && r >= 1.2) hits.push("desktop");
  if (r >= 1.2 && h > 480 && (h < 680 || w < 1024)) hits.push("compact-landscape");
  if ((r >= 0.75 && r < 1.2) || (r < 0.75 && w > 480)) hits.push("tablet-portrait");
  return {cls: hits[0] || null, hits};
}
/** CSS viewport of a device viewport at a browser zoom (zoom 150 % at 1440 px wide = 960 CSS px). */
export const cssViewport = (w, h, zoom) => [Math.round(w / zoom), Math.round(h / zoom)];
export function matrix({quick = false} = {}) {
  const out = [];
  for (const [w, h] of quick ? QUICK_VIEWPORTS : VIEWPORTS) for (const z of quick ? QUICK_ZOOMS : ZOOMS) {
    const [cw, ch] = cssViewport(w, h, z); out.push({w, h, zoom: z, cw, ch, cls: classOf(cw, ch).cls});
  }
  return out;
}

/* ---------------------------------------------------------------- geometry */
export const interArea = (a, b) => Math.max(0, Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x)) * Math.max(0, Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y));
const inside = (p, r) => p[0] > r.x && p[0] < r.x + r.w && p[1] > r.y && p[1] < r.y + r.h;
function segSeg(p, q, r, s) {
  const d = (a, b, c) => (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
  const d1 = d(r, s, p), d2 = d(r, s, q), d3 = d(p, q, r), d4 = d(p, q, s);
  return ((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) && ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0));
}
/** True when segment p-q crosses the interior of rectangle r shrunk by `inset` px (a path grazing an edge is allowed). */
export function segHitsRect(p, q, r0, inset = 1) {
  const r = {x: r0.x + inset, y: r0.y + inset, w: r0.w - 2 * inset, h: r0.h - 2 * inset};
  if (r.w <= 0 || r.h <= 0) return false;
  if (inside(p, r) || inside(q, r)) return true;
  const c = [[r.x, r.y], [r.x + r.w, r.y], [r.x + r.w, r.y + r.h], [r.x, r.y + r.h]];
  for (let i = 0; i < 4; i++) if (segSeg(p, q, c[i], c[(i + 1) % 4])) return true;
  return false;
}
export const quantile = (arr, q) => { if (!arr.length) return NaN; const s = [...arr].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.max(0, Math.ceil(q * s.length) - 1))]; };

/* ---------------------------------------------------------------- normalisation of page output */
const PATH_KINDS = new Set(["beam", "connector", "tether", "thread"]);
/* every box carries text unless it is a container or a control (U_shell kinds: hud, dock, rail, display, sub, plaque, eq,
   hint, chip, tag, endLabel; DOM collector kinds: text, control, chrome) */
const NON_TEXT = new Set(["dock", "control", "rail", "canvas", "stage", "panel"]);
export const isText = b => b.text !== undefined ? !!b.text : !NON_TEXT.has(b.kind);
export const isChrome = b => !!b.chrome || b.kind === "chrome" || b.kind === "hud" || b.kind === "rail";
function rectOf(o) {
  if (Array.isArray(o.rect)) return {x: +o.rect[0], y: +o.rect[1], w: +o.rect[2], h: +o.rect[3]};
  const r = o.rect || o;
  if (r.left !== undefined) return {x: +r.left, y: +r.top, w: +(r.width ?? r.right - r.left), h: +(r.height ?? r.bottom - r.top)};
  return {x: +r.x, y: +r.y, w: +(r.w ?? r.width), h: +(r.h ?? r.height)};
}
/** __story.rects() may return an array, {boxes, paths} or the solver's {placed, hidden, corridors?}; items with pts (or a
 *  path kind) are paths; solver corridors {a, b, r} become paths too (G3 checks text against the centre line); exempt
 *  boxes (the connector end) are dropped; `container` means parent. */
export function normaliseRects(raw) {
  const list = Array.isArray(raw) ? raw : [...(raw?.boxes || raw?.placed || []), ...(raw?.paths || []),
    ...(raw?.corridors || []).map((c, i) => ({id: c.id || "corridor" + i, kind: c.kind || "beam", pts: [c.a, c.b], attach: c.attach}))];
  const boxes = [], paths = [];
  for (const o of list) {
    if (!o) continue;
    if (Array.isArray(o.pts) || PATH_KINDS.has(o.kind)) { if (Array.isArray(o.pts) && o.pts.length > 1) paths.push({id: String(o.id), kind: o.kind || "path", pts: o.pts.map(p => [+p[0], +p[1]]), attach: o.attach || []}); continue; }
    if (o.visible === false || o.hidden === true || o.exempt) continue;
    const r = rectOf(o); if (!(r.w > 0 && r.h > 0)) continue;
    boxes.push({...o, id: String(o.id), ...r, parent: o.parent ?? o.container ?? undefined, opacity: o.opacity ?? 1});
  }
  return {boxes, paths};
}

/* ---------------------------------------------------------------- layout gates G1, G2, G3, G10-dom, G12 */
/** beats.json `dock` as the set of states allowed at beat position u: a state string, or a keyframe schedule [{u, state}]
 * (seek tweens from one keyframe to the next and reports the destination, so both ends of the current interval count). */
export function dockState(d, u) {
  if (!Array.isArray(d)) return d ? [d] : undefined;
  if (u === undefined || !d.length) return undefined;   // a schedule without a position cannot be judged
  let i = 0; for (let k = 0; k < d.length; k++) if (u >= d[k].u - 1e-9) i = k;
  return i >= d.length - 1 ? [d[i].state] : [d[i].state, d[i + 1].state];
}
const related = (a, b) => (a.el !== undefined && a.el === b.el) || (a.chain || []).includes(b.el ?? b.id) || (b.chain || []).includes(a.el ?? a.id) || a.parent === b.id || b.parent === a.id;
const lineRects = b => (Array.isArray(b.lineRects) && b.lineRects.length ? b.lineRects.map(r => ({x: r[0], y: r[1], w: r[2], h: r[3]})) : [b]);
const label = b => `${b.kind}:${b.id}${b.text && typeof b.text === "string" ? ` "${b.text.slice(0, 28)}"` : ""}`;

/**
 * Layout gates on one snapshot. snap = {name, viewport: {w, h, zoom?}, cls?, pinned?, flight?, contract?, boxes, paths,
 * expectDock?, dockState?, literals?}. Returns {fails: [{gate, msg}], notes: [string]}.
 *   G1  pairwise intersections > 4 px² between visible boxes that are not nested (DOM ancestry, parent/chain) and not
 *       in the same text block (blk); dock children and paths are exempt; text fully inside the viewport (pinned stage);
 *       one kinetic group per band (boxes with band + group and opacity >= 0.02)
 *   G2  font >= 12 CSS px for every text box; in phone classes a display line wraps to <= 2 lines
 *   G3  beam/connector/tether/thread paths never cross a text box (attach list exempt)
 *   G12 <= 4 chrome boxes in flight; dock state equals beats.json (when both are given)
 *   G10-dom (contract) no digit run outside [data-key]/[data-num]
 */
export function evalLayout(snap, {areaTol = 4, maxChrome = 4, fontFloor = 12, g3Skip = null} = {}) {
  const fails = [], notes = [], f = (gate, msg) => fails.push({gate, msg: `${snap.name || "snapshot"}: ${msg}`});
  const vis = (snap.boxes || []).filter(b => (b.opacity ?? 1) >= 0.02 && b.w > 0 && b.h > 0);
  const V = snap.viewport || {w: Infinity, h: Infinity};
  /* G1 overlaps: clip to the viewport (content off screen cannot collide on screen) */
  const view = {x: 0, y: 0, w: V.w, h: V.h};
  const onScreen = vis.filter(b => interArea(b, view) > 0);
  let nOv = 0;
  for (let i = 0; i < onScreen.length; i++) for (let j = i + 1; j < onScreen.length; j++) {
    const a = onScreen[i], b = onScreen[j];
    if (related(a, b) || (a.blk !== undefined && a.blk === b.blk)) continue;
    let A = 0; for (const ra of lineRects(a)) for (const rb of lineRects(b)) A += interArea(ra, rb);
    if (A > areaTol) { nOv++; if (nOv <= 12) f("G1", `overlap ${A.toFixed(0)} px² between ${label(a)} and ${label(b)}`); }
  }
  if (nOv > 12) f("G1", `${nOv - 12} more overlaps`);
  for (const d of snap.dropped || []) f("G1", `control dropped for lack of room: ${d.id} (${d.reason})`);   // fix3 ux M1 (dials)
  for (const c of snap.clipped || []) f("G1", `text cut by its own box (ellipsis) ${c.id} "${c.text}": ${c.cw} px shown of ${c.sw}`);
  /* text cut by the viewport edge: horizontally always (the story never scrolls sideways), vertically on the pinned
     stage; boxes entirely off screen are deliberate (skip links, parked layers) and not counted */
  for (const b of onScreen.filter(isText)) {
    const cutX = b.x < -1 || b.x + b.w > V.w + 1, cutY = snap.pinned && (b.y < -1 || b.y + b.h > V.h + 1);
    if (cutX || cutY) f("G1", `text outside the viewport ${label(b)} at [${[b.x, b.y, b.w, b.h].map(v => v.toFixed(0)).join(", ")}] in ${V.w}x${V.h}`);
  }
  const bands = new Map();
  for (const b of vis) if (b.band && b.group !== undefined) { if (!bands.has(b.band)) bands.set(b.band, new Set()); bands.get(b.band).add(String(b.group)); }
  for (const [band, g] of bands) if (g.size > 1) f("G1", `band ${band} shows ${g.size} kinetic groups at once (${[...g].join(", ")})`);
  /* G2 type floor */
  for (const b of vis.filter(isText)) if (b.font !== undefined && b.font < fontFloor - 0.01) f("G2", `text ${b.font.toFixed(1)} px < ${fontFloor} px: ${label(b)}`);
  if (PHONE.has(snap.cls)) for (const b of vis) if ((b.role === "display" || b.kind === "display") && b.lines > 2) f("G2", `phone display wraps to ${b.lines} lines (<= 2): ${label(b)}`);
  /* G3 composition. HUD chrome is exempt: the pills are solid (S0 §5, #0b0f1ce6 over the canvas), so a beam drawn in
     the GL scene never shows through them; g3Skip(box) lets a caller exempt more (node G1: placeholder dock labels) */
  const texts = vis.filter(b => isText(b) && !isChrome(b) && !(g3Skip && g3Skip(b)));
  for (const p of snap.paths || []) {
    for (const b of texts) {
      if ((p.attach || []).includes(b.id) || (p.attach || []).some(id => (b.chain || []).includes(id))) continue;
      let hit = false; for (let k = 1; k < p.pts.length && !hit; k++) for (const r of lineRects(b)) if (segHitsRect(p.pts[k - 1], p.pts[k], r)) { hit = true; break; }
      if (hit) f("G3", `${p.kind} ${p.id} crosses ${label(b)}`);
    }
  }
  /* G12 chrome */
  /* G12: rail parts (kind "rail" inside another box: track, odometer) are the rail, one element (§3.3: act chip, menu,
     Fly/pause, rail) */
  /* the phase-legend pill shows only on TF changes and at stops (§3.3) and is not counted; neither is the music toggle,
     which the owner asked to keep visible at all times (2026-11-13), nor the credits ID badge (hud:badge, a data label that
     yields its room to everything else) */
  if (snap.flight) { const ch = vis.filter(b => isChrome(b) && !(b.kind === "rail" && b.parent) && !/(^|[:#-])(phase|sound|badge|back)/.test(String(b.id))); if (ch.length > maxChrome) f("G12", `${ch.length} chrome elements in flight (<= ${maxChrome}): ${ch.map(b => b.id).join(", ")}`); }
  const want = dockState(snap.expectDock, snap.beatU);
  if (want && snap.dockState && !want.includes(snap.dockState)) f("G12", `dock is "${snap.dockState}", beats.json says "${want.join(" -> ")}"${snap.beatU !== undefined ? ` at u ${(+snap.beatU).toFixed(3)}` : ""}`);
  /* G10-dom */
  if (snap.contract) for (const L of (snap.literals || []).slice(0, 8)) f("G10", `literal number "${L.text}" in ${L.where} (not inside [data-key] or [data-num])`);
  else if ((snap.literals || []).length) notes.push(`${snap.literals.length} unkeyed number(s) (contract applies to v2 only)`);
  return {fails, notes};
}

/* ---------------------------------------------------------------- perf gate G5a / G5b */
/** G5a thresholds (DESIGN_final §4, frozen in notes/story2/S0.md §1 and §3). `readS0()` overrides them from the S0
 * file's machine-read header lines (`G5a_scale:`, `G5a_longtask_ms:`, `G5a_longtask_cadence:`, `G5a_gpu_frame_p95_ms:`). */
export const G5A = {scale: 1, volP50: 2.5, volP95: 3.5, p95Max: 7, longMax: 50, gpuFrameP95: 3.3, cadence: "vsync"};
export const S0_FILES = [join(REPO, "notes/story2/S0.md"), join(process.env.TNG_WORK || "/Volumes/cgm_work", "notes/story2/S0.md")];
/** Header values of the S0 freeze (first readable file), e.g. {G5a_scale: "1.0", G11_dark_frac: "0.55", ...}. */
export function readS0(files = S0_FILES) {
  for (const f of files) if (existsSync(f)) {
    const out = {file: f};
    for (const m of readFileSync(f, "utf8").matchAll(/^(G5a_\w+|G5b_\w+|G11_\w+|stage_\w+|laptop_\w+):\s*([^\s]+)\s*$/gm)) out[m[1]] = m[2];
    return out;
  }
  return null;
}
/** G5a options from S0 (numbers only where S0 states them). */
export function g5aFromS0(s0 = readS0()) {
  const o = {...G5A}; if (!s0) return o;
  if (s0.G5a_scale) o.scale = +s0.G5a_scale;
  if (s0.G5a_longtask_ms) o.longMax = +s0.G5a_longtask_ms;
  if (s0.G5a_gpu_frame_p95_ms) o.gpuFrameP95 = +s0.G5a_gpu_frame_p95_ms;
  if (s0.G5a_longtask_cadence) o.cadence = s0.G5a_longtask_cadence;
  return o;
}
/** One G5a run. s = {name, renderer, software, frames: [ms] (uncapped rAF intervals), volMs: [ms] (volume pass, GPU timer),
 *  gpuFrameMs: [ms] (sum of the GPU pass timers per frame), longTasks: [ms], longTaskCadence: "vsync" | "uncapped",
 *  longTasksUncapped?: [ms] (notes), requireVol?, requireGpu?}.
 *  Rules (S0 §1, §3): frame p95 <= 7 ms x scale; volume p50 <= 2.5 and p95 <= 3.5 ms x scale; GPU frame p95 <= 3.3 ms x scale;
 *  no long task > 50 ms, counted at the cadence S0 names (vsync): long tasks of an uncapped pass are an ANGLE artefact
 *  (S0 §3) and only notes, and a run without a vsync pass fails. */
export function evalPerf(s, opts = {}) {
  const o = {...G5A, ...opts}, k = o.scale;
  const fails = [], notes = [], f = (gate, msg) => fails.push({gate, msg: `${s.name || "run"}: ${msg}`});
  if (s.software) f("G5a", `software GL (${s.renderer}); G5a needs a hardware GPU`);
  const fr = s.frames || [];
  if (fr.length < 30) f("G5a", `only ${fr.length} frames measured (>= 30)`);
  else { const p50 = quantile(fr, 0.5), p95 = quantile(fr, 0.95); notes.push(`frames n=${fr.length} p50 ${p50.toFixed(2)} ms p95 ${p95.toFixed(2)} ms`);
    if (p95 > o.p95Max * k) f("G5a", `frame p95 ${p95.toFixed(2)} ms > ${(o.p95Max * k).toFixed(2)} ms`); }
  if (s.volMs?.length) { const v50 = quantile(s.volMs, 0.5), v95 = quantile(s.volMs, 0.95);
    notes.push(`volume n=${s.volMs.length} p50 ${v50.toFixed(2)} ms p95 ${v95.toFixed(2)} ms`);
    if (v50 > o.volP50 * k) f("G5a", `volume p50 ${v50.toFixed(2)} ms > ${(o.volP50 * k).toFixed(2)} ms`);
    if (v95 > o.volP95 * k) f("G5a", `volume p95 ${v95.toFixed(2)} ms > ${(o.volP95 * k).toFixed(2)} ms`); }
  else if (s.requireVol) f("G5a", "no volume timings (the stage must expose its GPU pass timers; see U_qa.md)");
  else notes.push("volume pass time not exposed");
  if (s.resident) { const r = s.resident; notes.push(`volume residency: ${r.loads} cube load(s), ${r.levels} level(s) bound${r.color ? " (" + r.color + ")" : ""}`);
    if (!(r.loads > 0 && r.levels > 0)) f("G5a", `volume never resident (${r.loads} cube loads, ${r.levels} levels bound): the run timed an empty sky (serve the cubes: --viz)`); }
  else if (s.requireResident) f("G5a", "volume residency not reported (stage.stats.fields.bound / core.stats.loads)");
  if (s.gpuFrameMs?.length) { const g95 = quantile(s.gpuFrameMs, 0.95);
    notes.push(`GPU frame (timer sum) n=${s.gpuFrameMs.length} p50 ${quantile(s.gpuFrameMs, 0.5).toFixed(2)} ms p95 ${g95.toFixed(2)} ms`);
    if (g95 > o.gpuFrameP95 * k) f("G5a", `GPU frame p95 ${g95.toFixed(2)} ms > ${(o.gpuFrameP95 * k).toFixed(2)} ms (S0 laptop proxy)`); }
  else if (s.requireGpu) f("G5a", "no GPU frame timings (EXT_disjoint_timer_query_webgl2 pass timers not exposed)");
  const cad = s.longTaskCadence || "uncapped";
  if (s.longTasksUncapped?.length) notes.push(`uncapped pass: ${s.longTasksUncapped.length} long task(s), max ${Math.max(...s.longTasksUncapped).toFixed(0)} ms (S0 §3 artefact, not judged)`);
  if (o.cadence === "vsync" && cad !== "vsync") {
    if (s.software) notes.push("long tasks not judged (software GL)");
    else f("G5a", `long tasks were measured at "${cad}" cadence; S0 counts them at vsync (run the --vsync pass)`);
  } else {
    const lt = (s.longTasks || []).filter(d => d > o.longMax);
    notes.push(`long tasks (${cad}): ${(s.longTasks || []).length}${(s.longTasks || []).length ? ", max " + Math.max(...s.longTasks).toFixed(0) + " ms" : ""}`);
    if (lt.length) f("G5a", `${lt.length} long task(s) > ${o.longMax} ms at ${cad} cadence (max ${Math.max(...lt).toFixed(0)} ms)`);
  }
  return {fails, notes};
}
/** The owner's laptop `?bench=1` JSON. Accepts a flat {p50, p95, scale | governorScale, frames?} or U_stage's S0 bench shape
 * (`C_governor.scale.scale` = the governor's chosen scale; frame work time = `A_profiled_phases_s<scale>.total`, the
 * profiled run nearest the chosen scale). A scale string with "h" (half-rate volume rung, S0 §2) passes when its number
 * is >= 0.5: "0.5h" passes, "0.35h" fails. */
export function benchSummary(j) {
  if (j.p50 !== undefined || j.frames || j.frameMs) { const fr = j.frames || j.frameMs || [];
    return {p50: j.p50 ?? quantile(fr, 0.5), p95: j.p95 ?? quantile(fr, 0.95), scale: j.scale ?? j.governorScale, src: "flat", renderer: j.renderer, longTasks: j.longTasks}; }
  const g = j.C_governor?.scale, sc = g && typeof g === "object" ? g.scale : g ?? j.governorScale;
  const prof = Object.keys(j).filter(x => /^A_profiled_phases_s\d+$/.test(x)).map(x => ({x, s: +("0." + x.replace(/^A_profiled_phases_s0?/, ""))}));
  const want = parseFloat(sc), pick = prof.sort((a, b) => Math.abs(a.s - want) - Math.abs(b.s - want))[0];
  const t = pick ? j[pick.x].total : null;
  return {p50: t?.p50, p95: t?.p95, scale: sc, src: pick ? pick.x : "none", renderer: j.gl?.renderer || j.renderer,
          longTasks: [...(j.longTasks || []), ...(j.E_loads?.longTasks || [])].map(x => typeof x === "number" ? x : x.d ?? x.duration).filter(x => x !== undefined)};
}
export function evalBench(j, {p50Max = 10, p95Max = 16.7, minScale = 0.5, longMax = 50} = {}) {
  const fails = [], f = msg => fails.push({gate: "G5b", msg}), B = benchSummary(j), sc = parseFloat(B.scale);
  if (j.software || j.gl?.software) f(`software GL (${B.renderer}); the bench must run on the laptop GPU`);
  if (!(B.p50 <= p50Max)) f(`p50 ${B.p50} ms > ${p50Max} (${B.src})`);
  if (!(B.p95 <= p95Max)) f(`p95 ${B.p95} ms > ${p95Max} (${B.src})`);
  if (!(sc >= minScale)) f(`governor scale ${B.scale} < ${minScale}`);
  const notes = [`bench p50 ${B.p50} p95 ${B.p95} at governor scale ${B.scale} (${B.src}), renderer ${B.renderer || "?"}`];
  const lt = (B.longTasks || []).filter(d => d > longMax);
  if (lt.length) notes.push(`laptop long tasks > ${longMax} ms: ${lt.length} (max ${Math.max(...lt).toFixed(0)} ms); G5a's rule, checked on the laptop (S0 §3)`);
  return {fails, notes};
}

/* ---------------------------------------------------------------- a11y gate G9 */
/** s = {beats: [ids], keyPath: [ids visited by keyboard], violations: [{id, impact, n}], animations: [{name, ms}],
 *  reduced: bool, stillsRuns: [{name, quality, reachedEnd}], narrative: {items, beats}} */
export function evalA11y(s, {maxAnimMs = 300} = {}) {
  const fails = [], notes = [], f = (gate, msg) => fails.push({gate, msg: `${s.name || "run"}: ${msg}`});
  if (s.beats?.length) {
    const seen = new Set(s.keyPath || []), miss = s.beats.filter(b => !seen.has(b));
    if (miss.length) f("G9", `keyboard path misses ${miss.length} of ${s.beats.length} beats: ${miss.slice(0, 6).join(", ")}`);
    const order = (s.keyPath || []).map(b => s.beats.indexOf(b)).filter(i => i >= 0);
    if (order.some((v, i) => i && v < order[i - 1])) f("G9", "keyboard path goes backwards");
  }
  const serious = (s.violations || []).filter(v => v.impact === "serious" || v.impact === "critical");
  for (const v of serious.slice(0, 10)) f("G9", `a11y ${v.impact}: ${v.id}${v.n ? ` (${v.n} nodes)` : ""}${v.help ? ` ${v.help}` : ""}`);
  if (s.reduced) { const long = (s.animations || []).filter(a => a.ms > maxAnimMs); for (const a of long.slice(0, 6)) f("G9", `reduced motion: animation ${a.name} ${a.ms >= 1e12 ? "infinite" : a.ms.toFixed(0) + " ms"} (> ${maxAnimMs} ms)`);
    if (s.tween) f("G9", `reduced motion: a beat jump tweens (${s.tween})`); }
  for (const r of s.stillsRuns || []) {
    if (r.quality !== "stills") f("G9", `${r.name}: quality "${r.quality}" (expected stills)`);
    if (!r.reachedEnd) f("G9", `${r.name}: did not reach the last beat`);
  }
  const mute = (s.jumpText || []).filter(j => !(j.text || "").trim());   // review2 H1: a jump must land where the narration is readable
  if (mute.length) f("G9", `no story text on screen after ${mute.length} of ${s.jumpText.length} keyboard jumps: ${mute.slice(0, 8).map(j => j.id + (j.p !== undefined ? "@" + j.p : "")).join(", ")}`);
  if (s.narrative && s.narrative.beats && s.narrative.items < s.narrative.beats) f("G9", `screen-reader narrative has ${s.narrative.items} items for ${s.narrative.beats} beats`);
  return {fails, notes};
}

/* ---------------------------------------------------------------- budget gate G6 */
// first-frame shell baseline (issue #74, 2026-11-19): the shell may grow at most shellGrowthKB over it; lower it when the
// shell shrinks, raise it only with a reason in the commit message
export const SHELL_BASE_KB = 292;
export const G6 = {shellKB: 300, shellBaseKB: SHELL_BASE_KB, shellGrowthKB: 3, fontsKB: 250, liveS: 1.5, firstS: 4, desktopMB: 40, mobileMB: 12, gpuDesktopMB: 448, gpuMobileMB: 192, pillFrac: 0.03};
/** s = {shellGz, fontsBytes, liveMs?, first3dMs?, desktopBytes?, mobileBytes?, gpuDesktop?, gpuMobile?, banned: [..],
 *  videoOutsideMedia: [..], backdropFrac?} */
export function evalBudget(s, B = G6) {
  const fails = [], notes = [], f = msg => fails.push({gate: "G6", msg: `${s.name || "budget"}: ${msg}`}), KB = 1024, MB = KB * KB;
  if (s.shellGz !== undefined && s.shellGz > B.shellKB * KB) f(`shell JS+CSS ${(s.shellGz / KB).toFixed(1)} kB gz > ${B.shellKB} kB`);
  if (s.shellGz !== undefined && B.shellBaseKB && s.shellGz > (B.shellBaseKB + B.shellGrowthKB) * KB) f(`shell JS+CSS ${(s.shellGz / KB).toFixed(1)} kB gz grew more than ${B.shellGrowthKB} kB over its ${B.shellBaseKB} kB baseline (SHELL_BASE_KB)`);
  if (s.fontsBytes !== undefined && s.fontsBytes > B.fontsKB * KB) f(`fonts ${(s.fontsBytes / KB).toFixed(1)} kB > ${B.fontsKB} kB`);
  if (s.liveMs !== undefined && s.liveMs > B.liveS * 1000) f(`first live frame ${s.liveMs.toFixed(0)} ms > ${B.liveS * 1000} ms at 20 Mbps`);
  if (s.first3dMs !== undefined && s.first3dMs > B.firstS * 1000) f(`first 3D frame ${s.first3dMs.toFixed(0)} ms > ${B.firstS * 1000} ms at 50 Mbps`);
  if (s.desktopBytes !== undefined && s.desktopBytes > B.desktopMB * MB) f(`desktop run ${(s.desktopBytes / MB).toFixed(1)} MB > ${B.desktopMB} MB`);
  if (s.mobileBytes !== undefined && s.mobileBytes > B.mobileMB * MB) f(`mobile run ${(s.mobileBytes / MB).toFixed(1)} MB > ${B.mobileMB} MB`);
  if (s.gpuDesktop !== undefined && s.gpuDesktop > B.gpuDesktopMB * MB) f(`GPU memory ${(s.gpuDesktop / MB).toFixed(0)} MB > ${B.gpuDesktopMB} MB (desktop)`);
  if (s.gpuMobile !== undefined && s.gpuMobile > B.gpuMobileMB * MB) f(`GPU memory ${(s.gpuMobile / MB).toFixed(0)} MB > ${B.gpuMobileMB} MB (mobile)`);
  for (const b of s.banned || []) f(`banned dependency ${b}`);
  for (const v of s.videoOutsideMedia || []) f(`video outside media/: ${v}`);
  if (s.backdropFrac !== undefined && s.backdropFrac > B.pillFrac) f(`backdrop-filter covers ${(100 * s.backdropFrac).toFixed(1)} % of the screen (HUD pills only, < ${100 * B.pillFrac} %)`);
  if (s.offOrigin?.length) f(`requests off this origin: ${s.offOrigin.slice(0, 3).join(", ")}`);
  if (s.cls !== undefined && s.cls >= 0.05) f(`cumulative layout shift ${s.cls.toFixed(3)} (< 0.05)`);
  return {fails, notes};
}

/* ---------------------------------------------------------------- pixels: G11 negative space, G4 contrast */
export const G11 = {darkFrac: 0.55, darkLum: 0.12, bandP95: 0.35};
const lin = c => { c /= 255; return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; };
const LIN = Float64Array.from({length: 256}, (_, i) => lin(i));
/** WCAG relative luminance of an sRGB colour (0-255 channels). */
export const relLum = (r, g, b) => 0.2126 * LIN[r] + 0.7152 * LIN[g] + 0.0722 * LIN[b];
export const contrast = (l1, l2) => (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
/** Luminance samples of an RGBA image inside rect (CSS px x scale = device px); step subsamples. mode "rel" (WCAG
 *  relative luminance, default) or "srgb" (Rec. 709 luma of the encoded values). */
export function lumSamples(img, rect = null, {scale = 1, step = 2, mode = "rel"} = {}) {
  const x0 = Math.max(0, Math.floor((rect ? rect.x : 0) * scale)), y0 = Math.max(0, Math.floor((rect ? rect.y : 0) * scale));
  const x1 = Math.min(img.width, Math.ceil(rect ? (rect.x + rect.w) * scale : img.width)), y1 = Math.min(img.height, Math.ceil(rect ? (rect.y + rect.h) * scale : img.height));
  const out = [], d = img.data;
  for (let y = y0; y < y1; y += step) for (let x = x0; x < x1; x += step) { const i = 4 * (y * img.width + x);
    out.push(mode === "srgb" ? (0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2]) / 255 : relLum(d[i], d[i + 1], d[i + 2])); }
  return out;
}
/** s = {name, img (with text), bg (text hidden), scale, exempt, bands: [rect], texts: [{id, rect, color: [r,g,b], font}]} */
export function evalPixels(s, T = G11, mode = "rel") {
  const fails = [], notes = [], f = (gate, msg) => fails.push({gate, msg: `${s.name || "frame"}: ${msg}`});
  if (s.img && !s.exempt) {
    const L = lumSamples(s.img, null, {scale: 1, step: 3, mode}), dark = L.filter(v => v < T.darkLum).length / Math.max(1, L.length);
    notes.push(`dark fraction ${(100 * dark).toFixed(1)} %`);
    if (dark < T.darkFrac) f("G11", `only ${(100 * dark).toFixed(1)} % of pixels darker than ${T.darkLum} (>= ${(100 * T.darkFrac).toFixed(0)} %)`);
  }
  const bg = s.bg || s.img;
  if (bg && !s.exempt) for (const r of s.bands || []) {
    const p = quantile(lumSamples(bg, r, {scale: s.scale || 1, mode}), 0.95);
    if (p >= T.bandP95) f("G11", `text band [${[r.x, r.y, r.w, r.h].map(v => Math.round(v)).join(", ")}] background p95 luminance ${p.toFixed(3)} (< ${T.bandP95})`);
  }
  if (bg) for (const t of s.texts || []) {
    const L = lumSamples(bg, t.rect, {scale: s.scale || 1, step: 1, mode: "rel"}); if (!L.length) continue;
    const tl = relLum(...t.color), lo = quantile(L, 0.05), hi = quantile(L, 0.95);
    const worst = Math.min(contrast(tl, lo), contrast(tl, hi)), need = t.need || 4.5;
    if (worst < need) f("G4", `text ${t.id} contrast ${worst.toFixed(2)}:1 against its background (>= ${need}:1)`);
  }
  return {fails, notes};
}

/* PNG codec: 8-bit RGB/RGBA (colour types 2 and 6) and grey (0, 4), non-interlaced; what Chrome screenshots produce. */
const CRC = (() => { const t = new Int32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c; } return t; })();
const crc32 = buf => { let c = -1; for (const b of buf) c = CRC[(c ^ b) & 255] ^ (c >>> 8); return (c ^ -1) >>> 0; };
export function decodePNG(buf) {
  if (buf.readUInt32BE(0) !== 0x89504e47) throw new Error("not a PNG");
  let off = 8, w = 0, h = 0, depth = 0, ct = 0, il = 0; const idat = [];
  while (off < buf.length) { const len = buf.readUInt32BE(off), type = buf.toString("ascii", off + 4, off + 8), body = buf.subarray(off + 8, off + 8 + len);
    if (type === "IHDR") { w = body.readUInt32BE(0); h = body.readUInt32BE(4); depth = body[8]; ct = body[9]; il = body[12]; }
    else if (type === "IDAT") idat.push(body); else if (type === "IEND") break; off += 12 + len; }
  if (depth !== 8 || il || ![0, 2, 4, 6].includes(ct)) throw new Error(`unsupported PNG (depth ${depth}, colour type ${ct}, interlace ${il})`);
  const ch = {0: 1, 2: 3, 4: 2, 6: 4}[ct], stride = w * ch, raw = inflateSync(Buffer.concat(idat)), out = new Uint8Array(w * h * 4), prev = new Uint8Array(stride), cur = new Uint8Array(stride);
  for (let y = 0; y < h; y++) { const ft = raw[y * (stride + 1)], row = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    for (let i = 0; i < stride; i++) { const a = i >= ch ? cur[i - ch] : 0, b = prev[i], c = i >= ch ? prev[i - ch] : 0; let v = row[i];
      if (ft === 1) v += a; else if (ft === 2) v += b; else if (ft === 3) v += (a + b) >> 1; else if (ft === 4) { const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c); v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c; }
      cur[i] = v & 255; }
    for (let x = 0; x < w; x++) { const o = 4 * (y * w + x), s = x * ch;
      if (ch >= 3) { out[o] = cur[s]; out[o + 1] = cur[s + 1]; out[o + 2] = cur[s + 2]; out[o + 3] = ch === 4 ? cur[s + 3] : 255; }
      else { out[o] = out[o + 1] = out[o + 2] = cur[s]; out[o + 3] = ch === 2 ? cur[s + 1] : 255; } }
    prev.set(cur); }
  return {width: w, height: h, data: out};
}
export function encodePNG({width: w, height: h, data}) {
  const raw = Buffer.alloc((w * 4 + 1) * h); for (let y = 0; y < h; y++) { raw[y * (w * 4 + 1)] = 0; Buffer.from(data.buffer, data.byteOffset + y * w * 4, w * 4).copy(raw, y * (w * 4 + 1) + 1); }
  const chunk = (type, body) => { const len = Buffer.alloc(4); len.writeUInt32BE(body.length); const tb = Buffer.concat([Buffer.from(type, "ascii"), body]); const c = Buffer.alloc(4); c.writeUInt32BE(crc32(tb)); return Buffer.concat([len, tb, c]); };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 6;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
}
/** A synthetic RGBA image filled by fn(x, y) -> [r, g, b]. */
export function synthImage(w, h, fn) { const d = new Uint8Array(w * h * 4); for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { const c = fn(x, y), o = 4 * (y * w + x); d[o] = c[0]; d[o + 1] = c[1]; d[o + 2] = c[2]; d[o + 3] = 255; } return {width: w, height: h, data: d}; }

/* ---------------------------------------------------------------- fixtures and self-test */
/** Runs every fixture <prefix>_*.json: names containing "_clean" must pass, "_defect_<gate>..." must fail with that gate
 *  among the failures (e.g. overlap_defect_G3_beam.json must fail G3). evaluate(fixtureJson) -> {fails, notes}. */
export function selfTest(C, prefix, evaluate) {
  const files = existsSync(FIX_DIR) ? readdirSync(FIX_DIR).filter(f => f.startsWith(prefix + "_") && f.endsWith(".json")).sort() : [];
  C.check(files.some(f => f.includes("_clean")) && files.some(f => f.includes("_defect_")), `self-test fixtures for ${prefix}: ${files.length} file(s) in tests/js/fixtures/story_qa`);
  for (const file of files) {
    const fx = JSON.parse(readFileSync(join(FIX_DIR, file), "utf8")), r = evaluate(fx), gates = [...new Set(r.fails.map(x => x.gate))];
    if (file.includes("_clean")) C.check(!r.fails.length, `self-test ${file}: clean fixture passes${r.fails.length ? " (got " + r.fails.map(x => x.gate + " " + x.msg).join("; ") + ")" : ""}`);
    else { const want = (file.match(/_defect_(G\d+[ab]?)/) || [])[1];
      C.check(r.fails.length > 0 && (!want || gates.includes(want)), `self-test ${file}: seeded defect fails ${want || "a gate"} (got ${gates.join(", ") || "no failure"})`); }
  }
}
export const report = (C, r) => { for (const n of r.notes) C.note(n); for (const x of r.fails) C.check(false, `${x.gate} ${x.msg}`); return !r.fails.length; };

/* ---------------------------------------------------------------- results file */
export function writeResult(outDir, name, obj) { if (!outDir) return null; const f = join(resolve(outDir), name); writeFileSync(f, JSON.stringify(obj, null, 1)); return f; }

/* ---------------------------------------------------------------- browser helpers */
/** A wrapper script that runs the browser with extra flags (launch() owns the standard flag list). */
export function edgeWith(edge, flags) {
  const d = mkdtempSync(join(tmpdir(), "storyqa-edge-")), f = join(d, "edge.sh");
  writeFileSync(f, `#!/bin/bash\nexec ${JSON.stringify(edge)} ${flags.map(x => JSON.stringify(x)).join(" ")} "$@"\n`); chmodSync(f, 0o755); return f;
}
/** The plain headless binary when TNG_EDGE is one of the cgm_work wrappers (headless-rm forces reduced motion,
 *  headless-gpu forces it too); motion is then chosen per run. */
export function plainEdge(env = process.env) {
  const e = env.TNG_EDGE || "";
  for (const suf of ["-rm", "-gpu"]) if (e.endsWith("headless" + suf) && existsSync(e.slice(0, -suf.length))) return e.slice(0, -suf.length);
  return e || undefined;
}
export const GPU_FLAGS = ["--use-angle=vulkan", "--enable-features=Vulkan", "--ignore-gpu-blocklist"];
export const SWIFTSHADER_FLAGS = ["--use-angle=swiftshader", "--enable-unsafe-swiftshader"];
export const UNTHROTTLE_FLAGS = ["--disable-gpu-vsync", "--disable-frame-rate-limit", "--disable-renderer-backgrounding", "--disable-background-timer-throttling"];
/** Set a CSS viewport by device size and zoom (deviceScaleFactor = zoom, as browser zoom does). */
export async function setViewport(P, {w, h, zoom = 1, mobile}) {
  const [cw, ch] = cssViewport(w, h, zoom), touch = mobile ?? (w <= 900 && w < h * 1.4 && Math.min(w, h) <= 500);
  Object.assign(P, {W: cw, H: ch, mobile: touch});
  await P.send("Emulation.setDeviceMetricsOverride", {width: cw, height: ch, deviceScaleFactor: zoom, mobile: touch});
  await P.send("Emulation.setTouchEmulationEnabled", {enabled: touch, maxTouchPoints: touch ? 5 : 0});
}
export const keyCode = {PageDown: 34, PageUp: 33, End: 35, Home: 36, ArrowRight: 39, ArrowLeft: 37, " ": 32, Space: 32, Enter: 13, Tab: 9, Escape: 27};
export async function press(P, key, mods = 0) {
  const k = key === "Space" ? " " : key, text = k.length === 1 ? k : undefined;
  await P.send("Input.dispatchKeyEvent", {type: text ? "keyDown" : "rawKeyDown", key: k, code: k === " " ? "Space" : k, windowsVirtualKeyCode: keyCode[key] || 0, modifiers: mods, text});
  await P.send("Input.dispatchKeyEvent", {type: "keyUp", key: k, code: k === " " ? "Space" : k, windowsVirtualKeyCode: keyCode[key] || 0, modifiers: mods});
}
export async function screenshot(P) { const r = await P.send("Page.captureScreenshot", {format: "png"}); return Buffer.from(r.result.data, "base64"); }

/* Local assets for 3D runs. The page loads its cubes from the hosted dataset (blocked in tests: BLOCK) and three from a CDN
 * (compute nodes may have no network). Without them the stage draws an empty sky: G5a then times a volume pass with no
 * data and G11 measures black frames, both passing for the wrong reason (integrator GPU job 1230037: volume p50 0.06 ms,
 * 96-98 % dark). So the 3D gates serve the 488530 cubes at /viz/ and a local three at /three.js by default, and check
 * residency (RESIDENT) before they measure. Override with --viz DIR / --three FILE or STORY_VIZ / STORY_THREE; --viz none
 * runs against the page's own sources. */
const VIZ_DEFAULTS = [join(process.env.TNG_WORK || "/Volumes/cgm_work", "data/gal/488530/viz")];
const THREE_DEFAULTS = [join(process.env.TNG_WORK || "/Volumes/cgm_work", "scratch/story2_w/U_stage/vendor/three.module.min.js")];
export function storyAssets(opt = {}) {
  const pick = (v, env, defs, isDir) => { const x = v ?? process.env[env]; if (x === "none" || x === false) return null;
    if (x) return resolve(String(x)); return defs.find(d => existsSync(d) && statSync(d).isDirectory() === isDir) || null; };
  return {viz: pick(opt.viz, "STORY_VIZ", VIZ_DEFAULTS, true), three: pick(opt.three, "STORY_THREE", THREE_DEFAULTS, false)};
}
/** Query string (no leading ?/&) that points the page at the served assets. */
export function assetQuery(srv, a) {
  return [a.three ? "three=/three.js" : "", a.viz ? "viz=" + encodeURIComponent(srv.origin + "/viz/") : ""].filter(Boolean).join("&");
}
/** In-page residency probe: {stage, loads, levels, failed} (levels = cube levels bound to the colour + weight slots). */
export const RESIDENT = `(() => { const S = window.__story, st = S && S.stage; if (!st || !st.stats) return {stage: false, loads: 0, levels: 0};
  const b = (st.stats.fields || {}).bound || {}, lv = [...(b.color || []), ...(b.weight || [])].length, cs = st.core && st.core.stats;
  return {stage: true, loads: cs && cs.loads ? cs.loads.length : 0, levels: lv, color: (st.stats.fields || {}).color || null}; })()`;
/** Waits up to ms for at least one cube level to be bound; returns the last probe. */
export async function waitResident(P, ms = 90000) { await P.waitFor(`(${RESIDENT}).levels > 0 || !(${RESIDENT}).stage`, ms, 250); return P.eval(RESIDENT); }

/* Tier A (R7_gpu, DESIGN_tierA §1/§10): with STORY_QA_STORY=<id> in the environment, every request for the story page
 * (ROOT/index.html or ROOT/) that has no story= parameter is redirected to the same URL with story=<id> first. This makes
 * the v2 gate scripts (story_overlap, story_a11y, story_perf, story_g11, story_budget) run on one Tier A story without
 * any change to them; "full" or an empty value leaves the hero page alone. Returns the redirect target or null. */
export function tierRedirect(url, id = process.env.STORY_QA_STORY) {
  if (!id || id === "full") return null;
  const u = new URL(url, "http://x"), page = "/tng50/" + STORY_REL + "/";
  if (u.pathname !== page && u.pathname !== page + "index.html") return null;
  if (u.searchParams.has("story")) return null;
  const q = u.search.replace(/^\?/, "");
  return u.pathname + "?story=" + encodeURIComponent(id) + (q ? "&" + q : "") + u.hash;
}

/* gzip static server (GitHub Pages compresses text): <dir> at /tng50/, optional extra root at /viz/, a local three at /three.js */
const TYPES = {".html": "text/html; charset=utf-8", ".js": "text/javascript", ".mjs": "text/javascript", ".json": "application/json", ".css": "text/css",
  ".svg": "image/svg+xml", ".png": "image/png", ".webp": "image/webp", ".avif": "image/avif", ".jpg": "image/jpeg", ".woff2": "font/woff2", ".woff": "font/woff",
  ".txt": "text/plain", ".vtt": "text/vtt", ".mp4": "video/mp4", ".bin": "application/octet-stream", ".wasm": "application/wasm"};
const ZIP = new Set([".html", ".js", ".mjs", ".json", ".css", ".svg", ".txt", ".vtt", ".bin"]);
export async function gzServe(dir, {port = 0, viz = null, three = null} = {}) {
  const {createServer} = await import("node:http"); dir = resolve(dir); viz = viz ? resolve(viz) : null; three = three ? resolve(three) : null;
  const served = {bytes: 0, n: 0, vizBytes: 0};   // bytes on the wire as served (worker fetches included; Resource Timing misses them)
  const srv = createServer((req, res) => {
    let p = decodeURIComponent(new URL(req.url, "http://x").pathname), f = null;
    const tier = tierRedirect(req.url);   // Tier A per-story runs (STORY_QA_STORY): the story page always opens ?story=<id>
    if (tier) { res.writeHead(302, {Location: tier, "Cache-Control": "no-store"}); res.end(); return; }
    if (p.startsWith("/tng50/")) { if (p.endsWith("/")) p += "index.html"; f = resolve(join(dir, p.slice(7))); if (!f.startsWith(dir + "/")) f = null; }
    else if (viz && p.startsWith("/viz/")) { f = resolve(join(viz, p.slice(5))); if (!f.startsWith(viz + "/")) f = null; }
    else if (three && p === "/three.js") f = three;
    if (!f || !existsSync(f) || statSync(f).isDirectory()) { res.writeHead(404); res.end("not found"); return; }
    const body = readFileSync(f), ext = extname(f), z = ZIP.has(ext) && /gzip/.test(req.headers["accept-encoding"] || "");
    res.writeHead(200, {"Content-Type": TYPES[ext] || "application/octet-stream", "Cache-Control": "no-store", "Access-Control-Allow-Origin": "*", ...(z ? {"Content-Encoding": "gzip"} : {})});
    const out = z ? gzipSync(body, {level: 6}) : body; served.bytes += out.length; served.n++; if (p.startsWith("/viz/")) served.vizBytes += out.length;
    res.end(out);
  });
  await new Promise(r => srv.listen(+port || 0, "127.0.0.1", r));
  const got = srv.address().port;
  return {origin: `http://127.0.0.1:${got}`, base: `http://127.0.0.1:${got}/tng50/`, served, close: () => new Promise(r => { srv.closeAllConnections?.(); srv.close(r); })};
}

/* ---------------------------------------------------------------- page adapter (v2 __story, v1 storyApp) */
export const DETECT = `(() => { const S = window.__story;
  if (S && typeof S.state === "function" && typeof S.beats === "function") return "v2";
  if (window.storyApp && (storyApp.ready === true || document.querySelector('[data-step]'))) return "v1";
  return null; })()`;
/** Waits for v2 or v1; returns "v2" | "v1" | null. */
export async function detect(P, ms = 60000) {
  const t = await P.waitFor(`${DETECT} !== null && (${DETECT} === "v2" || window.storyApp.ready === true || document.querySelector('[data-step].is-active, [data-step][aria-current="step"]'))`, ms, 100);
  return t < 0 ? null : P.eval(DETECT);
}
/** Story positions to visit: v2 -> [{p, beat}] (beat midpoints, then evenly spread), v1 -> [{step}] (evenly spread). */
export async function positions(P, kind, n) {
  if (kind === "v2") {
    const beats = await P.eval(`(__story.beats() || []).map(b => ({id: b.id, p0: +b.p0, p1: +b.p1, dock: b.dock || null, stop: !!(b.stop || b.kind === "stop")}))`);
    const mids = beats.map(b => ({p: (b.p0 + b.p1) / 2, beat: b.id, dock: b.dock, stop: b.stop}));
    if (!n || n >= mids.length) return mids;
    return Array.from({length: n}, (_, i) => mids[Math.round(i * (mids.length - 1) / Math.max(1, n - 1))]);
  }
  const ids = await P.eval(`[...document.querySelectorAll("[data-step]")].map(e => e.dataset.step)`);
  const sel = !n || n >= ids.length ? ids : Array.from({length: n}, (_, i) => ids[Math.round(i * (ids.length - 1) / Math.max(1, n - 1))]);
  return sel.map(step => ({step}));
}
/** Go to a position and wait until it is settled; returns false when the page never reached it. v1 has no hashchange
 *  listener, so a v1 step is a fresh load of url#s=<id> (pass {url}). */
export async function goTo(P, kind, pos, {settleMs = 500, url = null} = {}) {
  let ok;
  if (kind === "v2") {
    await P.eval(`(() => { const S = __story; if (typeof S.seekTo === "function") S.seekTo(${pos.p}); else S.setTarget(${pos.p}); })()`);
    ok = (await P.waitFor(`Math.abs((__story.state().p ?? -1) - ${pos.p}) < 2e-4`, 8000, 50)) >= 0;
  } else {
    const here = `(window.storyApp && storyApp.getState && storyApp.getState().step === ${JSON.stringify(pos.step)}) || !!document.querySelector('[data-step="${pos.step}"].is-active, [data-step="${pos.step}"][aria-current="step"]')`;
    if (url) await P.goto(url.split("#")[0] + "#s=" + pos.step); else await P.eval(`location.hash = "#s=${pos.step}"`);
    ok = (await P.waitFor(here, 30000, 50)) >= 0;
  }
  await new Promise(r => setTimeout(r, settleMs));
  return ok;
}

/** In-page collector: every visible text run and control as a box (CSS px, viewport coordinates), with DOM ancestry
 *  (chain), the nearest block container (blk), font size, effective opacity, line rects; plus unkeyed digit runs. */
export const COLLECT = `(() => {
  const ids = new WeakMap(); let next = 1; const idOf = e => { if (!ids.has(e)) ids.set(e, next++); return ids.get(e); };
  const vw = innerWidth, vh = innerHeight, boxes = [], literals = [];
  const BLOCKY = /^(block|flex|grid|table|list-item|flow-root|table-cell|inline-block|inline-flex|inline-grid)$/;
  const cache = new Map();
  function info(e) {   // effective opacity, visibility and the clip rect from overflow ancestors
    if (cache.has(e)) return cache.get(e);
    const cs = getComputedStyle(e); let r;
    const par = e.parentElement ? info(e.parentElement) : {op: 1, clip: {x: -1e9, y: -1e9, w: 2e9, h: 2e9}, hidden: false};
    let clip = par.clip;
    if (cs.overflow !== "visible" && cs.overflow !== "" && e !== document.documentElement && e !== document.body) {
      const b = e.getBoundingClientRect(); const x = Math.max(clip.x, b.left), y = Math.max(clip.y, b.top);
      clip = {x, y, w: Math.max(0, Math.min(clip.x + clip.w, b.right) - x), h: Math.max(0, Math.min(clip.y + clip.h, b.bottom) - y)};
    }
    r = {op: par.op * (+cs.opacity), clip, hidden: par.hidden || cs.display === "none" || cs.visibility === "hidden" || cs.visibility === "collapse" || e.hasAttribute("data-qa-ignore") || (cs.position === "fixed" || cs.position === "absolute") && cs.clipPath && /inset\\(50%|circle\\(0/.test(cs.clipPath), cs};
    cache.set(e, r); return r;
  }
  const blockOf = e => { for (let a = e; a; a = a.parentElement) { const d = info(a).cs.display; if (BLOCKY.test(d) || a.matches("p,li,h1,h2,h3,h4,h5,h6,figcaption,label,button,td,th,dd,dt")) return a; } return document.body; };
  const chainOf = e => { const c = []; for (let a = e.parentElement; a; a = a.parentElement) c.push(idOf(a)); return c; };
  const clipR = (r, c) => { const x = Math.max(r.x, c.x), y = Math.max(r.y, c.y); return {x, y, w: Math.max(0, Math.min(r.x + r.w, c.x + c.w) - x), h: Math.max(0, Math.min(r.y + r.h, c.y + c.h) - y)}; };
  const name = e => (e.dataset.testid || e.id || (e.className && typeof e.className === "string" ? e.tagName.toLowerCase() + "." + e.className.trim().split(/\\s+/)[0] : e.tagName.toLowerCase()));
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  const byEl = new Map();
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    /* zero-width runs (KaTeX struts: .vlist-s holds a lone U+200B at a tiny font) are not text a reader sees */
    if (!n.nodeValue.replace(/[\\s\\u200b\\u200c\\u200d\\ufeff]/g, "")) continue; const e = n.parentElement; if (e && e.closest(".vlist-s")) continue; if (!e || /^(SCRIPT|STYLE|NOSCRIPT|TEMPLATE|TITLE|OPTION)$/.test(e.tagName)) continue;
    const I = info(e); if (I.hidden || I.op < 0.02) continue;
    if (e.closest(".sr-only, .visually-hidden, [data-sr-only]")) continue;
    const rg = document.createRange(); rg.selectNodeContents(n);
    const fpx = parseFloat(I.cs.fontSize), lh = I.cs.lineHeight === "normal" ? 1.2 * fpx : parseFloat(I.cs.lineHeight) || 1.2 * fpx;
    const cropH = Math.min(lh, 1.15 * fpx);   // ink of a line: at most the line box, at most ~1.15 em (cap + descender)
    const rs = [...rg.getClientRects()].map(r => { const h = Math.min(r.height, cropH), y = r.top + (r.height - h) / 2; return clipR({x: r.left, y, w: r.width, h}, I.clip); })
      .filter(r => r.w > 0.5 && r.h > 0.5);
    if (!rs.length) continue;
    if (!byEl.has(e)) byEl.set(e, {rects: [], text: ""}); const B = byEl.get(e); B.rects.push(...rs); B.text += n.nodeValue;
    for (const m of n.nodeValue.matchAll(/[-+−]?\\d[\\d.,]*/g)) if (!e.closest("[data-key],[data-num]")) literals.push({text: m[0], where: name(e)});
  }
  for (const [e, B] of byEl) {
    const x0 = Math.min(...B.rects.map(r => r.x)), y0 = Math.min(...B.rects.map(r => r.y)), x1 = Math.max(...B.rects.map(r => r.x + r.w)), y1 = Math.max(...B.rects.map(r => r.y + r.h));
    const tops = new Set(B.rects.map(r => Math.round(r.y / 4)));
    const I = info(e), role = e.closest("[data-role=display], h1, .display") ? "display" : undefined;
    /* occluded: another element is painted over the middle of every line (e.g. text scrolled under a sticky stage) */
    const occluded = B.rects.every(r => { const cx = r.x + r.w / 2, cy = r.y + r.h / 2; if (cx < 0 || cy < 0 || cx >= vw || cy >= vh) return true;
      const hit = document.elementFromPoint(cx, cy); return !!hit && hit !== e && !e.contains(hit) && !hit.contains(e); }) || undefined;
    boxes.push({id: name(e) + "#" + idOf(e), el: idOf(e), chain: chainOf(e), blk: idOf(blockOf(e)), kind: "text", x: x0, y: y0, w: x1 - x0, h: y1 - y0,
      lineRects: B.rects.map(r => [r.x, r.y, r.w, r.h]), lines: tops.size, occluded, font: parseFloat(I.cs.fontSize), opacity: I.op, role, text: B.text.trim().slice(0, 60),
      color: I.cs.color, band: e.closest("[data-band]")?.dataset.band, group: e.closest("[data-group]")?.dataset.group});
  }
  for (const e of document.querySelectorAll('button, input, select, textarea, a[href], [role=slider], [role=button], [role=tab], [data-chrome]')) {
    const I = info(e); if (I.hidden || I.op < 0.02) continue;
    const b = e.getBoundingClientRect(); const r = clipR({x: b.left, y: b.top, w: b.width, h: b.height}, I.clip); if (r.w < 1 || r.h < 1) continue;
    boxes.push({id: name(e) + "#" + idOf(e), el: idOf(e), chain: chainOf(e), blk: idOf(e), kind: e.hasAttribute("data-chrome") ? "chrome" : "control", ...r, opacity: I.op, text: false,
      chrome: e.hasAttribute("data-chrome") || undefined});
  }
  /* fix3 ux M1: text clipped by its own box (text-overflow: ellipsis / overflow hidden) stays inside that box, so the
     overlap tests cannot see it; every visible element that ellipsizes and whose scrollWidth exceeds its clientWidth is
     reported (G1 fails on it) */
  const clipped = [];
  for (const e of document.body.querySelectorAll("*")) {
    const cs = getComputedStyle(e); if (cs.textOverflow !== "ellipsis") continue;
    const I = info(e); if (I.hidden || I.op < 0.02 || !e.textContent.trim()) continue;
    if (e.scrollWidth > e.clientWidth + 1) clipped.push({id: name(e) + "#" + idOf(e), text: e.textContent.trim().slice(0, 40), cw: e.clientWidth, sw: e.scrollWidth});
  }
  return {vw, vh, dpr: devicePixelRatio, boxes, literals, clipped};
})()`;

/** One layout snapshot of the live page (DOM collector + v2 registered rects/paths when present). */
export async function snapshot(P, kind, meta = {}) {
  const dom = await P.eval(COLLECT);
  const snap = {...meta, viewport: {w: dom.vw, h: dom.vh, zoom: meta.zoom}, cls: classOf(dom.vw, dom.vh).cls, boxes: dom.boxes, paths: [], literals: dom.literals, dpr: dom.dpr, clipped: dom.clipped || []};
  if (kind === "v2") {
    const v2 = await P.eval(`(() => { const S = __story, s = S.state(); let r = null; try { r = typeof S.rects === "function" ? S.rects() : null; } catch (e) { r = {error: String(e)}; }
      let dropped = []; try { dropped = S.spectrum && typeof S.spectrum.dropped === "function" ? S.spectrum.dropped() : []; } catch (e) { dropped = []; }
      return {rects: r, dropped, dock: s.spec ? s.spec.dock : null, beat: s.beat ? s.beat.id : null, beatU: s.beat ? s.beat.u : undefined, stop: !!(s.beat && s.beat.stop), quality: s.quality || null, p: s.p}; })()`);
    const reg = normaliseRects(v2.rects || []);
    /* registered boxes are the authority for their region: a DOM box lying >= 90 % inside a registered box is that
       box's own content and is dropped (an unregistered element fully under a registered one is therefore not seen;
       partial overlaps still count); paths come only from the page */
    const ar = b => Math.max(1e-9, b.w * b.h);
    snap.boxes = [...reg.boxes, ...dom.boxes.filter(b => !reg.boxes.some(r => interArea(b, r) >= 0.9 * ar(b)))];
    snap.paths = reg.paths; snap.pinned = true; snap.contract = true; snap.dockState = v2.dock; snap.beat = v2.beat; snap.beatU = v2.beatU; snap.flight = !v2.stop;
    if (v2.rects?.error) snap.rectsError = v2.rects.error;
    snap.dropped = v2.dropped || [];
  }
  return snap;
}

/** Browser self-test of the in-page collectors on tests/js/fixtures/story_qa/mock_story.html (clean and ?defect=1):
 *  returns {clean: srv base URL of the clean page, defect: URL} after starting a server on the fixture dir. */
export async function mockServer() { const s = await gzServe(FIX_DIR); return {...s, clean: s.base + "mock_story.html", defect: s.base + "mock_story.html?defect=1"}; }

/* ---------------------------------------------------------------- static scan helpers (G6, G10) */
/** Drops block comments and line comments (a `//` preceded by start, whitespace or ; { } ( ), so "https://..." in a
 * string survives). Good enough for import scanning, not a JS parser. */
export const stripJsComments = s => s.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/(^|[\s;{}()])\/\/[^\n]*/g, "$1");
export function walk(d, skip = new Set(["node_modules"]), out = []) {
  if (!existsSync(d)) return out;
  for (const n of readdirSync(d).sort()) { const f = join(d, n), st = statSync(f); if (st.isDirectory()) { if (!skip.has(n)) walk(f, skip, out); } else out.push(f); }
  return out;
}
export const gzSize = f => gzipSync(readFileSync(f), {level: 9}).length;
/** Static module graph from an HTML page: module scripts, stylesheets, static and dynamic imports, workers,
 *  CSS @import. Returns absolute file paths under docsDir (URLs off the site are listed in `external`). */
export function moduleGraph(page, docsDir, {dynamic = true} = {}) {   // dynamic: false = the first-frame shell (no import(), no workers)
  const seen = new Set(), external = new Set(), missing = new Set(), q = [];
  const add = (spec, from, html = false) => {
    if (!spec || /^(data|blob|mailto|#)/.test(spec)) return;
    if (/^https?:\/\//.test(spec)) { external.add(spec); return; }
    if (!html && !/^[./]/.test(spec)) { external.add(spec); return; }   // bare JS specifier (import map); HTML hrefs are relative
    const clean = spec.split(/[?#]/)[0], f = clean.startsWith("/") ? join(docsDir, "..", clean) : resolve(dirname(from), clean);
    if (!existsSync(f)) { missing.add(f); return; }
    if (!seen.has(f)) { seen.add(f); q.push(f); }
  };
  const html = readFileSync(page, "utf8");
  for (const m of html.matchAll(/<script[^>]*\bsrc=["']([^"']+)["']/g)) add(m[1], page, true);
  for (const m of html.matchAll(/<link[^>]*\brel=["'](?:stylesheet|modulepreload)["'][^>]*\bhref=["']([^"']+)["']/g)) add(m[1], page, true);
  for (const m of html.matchAll(/<link[^>]*\bhref=["']([^"']+\.css)["']/g)) add(m[1], page, true);
  const scanJs = (src0, from) => {
    /* comments are not imports (equations.js documents its own import line); a `//` after ":" (URLs in strings) stays */
    const src = stripJsComments(src0);
    for (const m of src.matchAll(/\bimport\s*(?:[\w*{}\s,$]+from\s*)?["']([^"']+)["']/g)) add(m[1], from);
    if (!dynamic) return;
    for (const m of src.matchAll(/\bimport\(\s*["'`]([^"'`$]+)["'`]\s*\)/g)) add(m[1], from);
    for (const m of src.matchAll(/\bimport\(\s*new\s+URL\(\s*["']([^"']+)["']\s*,\s*import\.meta\.url/g)) add(m[1], from);
    /* template dynamic import (`./scenes/${name}.js`): every matching file of that directory can load */
    for (const m of src.matchAll(/\bimport\(\s*(?:new\s+URL\(\s*)?`([^`]*)\$\{[^}]*\}([^`]*)`/g)) {
      const d = resolve(dirname(from), m[1].replace(/[^/]*$/, "")), pre = m[1].replace(/^.*\//, ""), suf = m[2];
      if (existsSync(d) && statSync(d).isDirectory()) for (const n of readdirSync(d)) if (n.startsWith(pre) && n.endsWith(suf)) add("./" + relative(dirname(from), join(d, n)), from);
    }
    for (const m of src.matchAll(/new\s+(?:Shared)?Worker\(\s*new\s+URL\(\s*["']([^"']+)["']/g)) add(m[1], from);
    for (const m of src.matchAll(/new\s+(?:Shared)?Worker\(\s*["']([^"']+)["']/g)) add(m[1], from);
  };
  for (const m of html.matchAll(/<script[^>]*type=["']module["'][^>]*>([\s\S]*?)<\/script>/g)) scanJs(m[1], page);
  while (q.length) { const f = q.shift(), src = readFileSync(f, "utf8");
    if (/\.m?js$/.test(f)) scanJs(src, f);
    else if (f.endsWith(".css")) for (const m of src.matchAll(/@import\s+(?:url\()?["']?([^"')]+)["']?\)?/g)) add(m[1], f); }
  return {files: [...seen], external: [...external], missing: [...missing]};
}
export {REPO};

/* ================================================================ Tier A per-story gate runner (R7_gpu, DESIGN_tierA §1, §10)
 *
 *   node tests/js/lib/storyqa.mjs --all | --story id[,id] [--sets node,h0,browser,gpu] [--out DIR] [--docs DIR]
 *        [--index FILE] [--pass N] [--quick] [--no-hero-budget]
 *
 * Builds a temp page tree (ROOT copied, everything else symlinked) whose data/index.json is a story-index/2 index listing
 * the Tier A stories (default: R1's draft, story3_w/R1/index_v2_draft.json; the shipped index stays /1 and is never
 * written), then runs the v2 gate scripts once per story with STORY_QA_STORY=<id> (gzServe redirects the page to
 * ?story=<id>) and STORY_VIZ=<CGM_WORK>/data/gal/<g>/viz (the story's own cubes):
 *   browser  story_overlap --quick (G1/G2/G3/G10/G12 in the DOM), story_a11y (G9)
 *   gpu      story_g11 --viewports (G4/G11), story_g11 --g14 (G14), story_budget --story (G6s), story_perf (G5a, heaviest
 *            story only); needs TNG_GPU=1 on an A100 node (scripts/story_qa.sbatch QA_SET=tiergpu)
 *   node     beats meta.generator.gates_node (R3: schema, G1/G2/G3/G12 node, G13r, G15, G19, G20), story data gates_case
 *            (R1: G16, G15/G13r data), the G17/G18 reports (R7_fuzz), sha256 of every file the story loads
 *   h0       tests/js/story_hero_identity.mjs on the real tree (the hero must stay byte-identical)
 * and writes <out>/gates.json (story-gates-run/1): per story {H0, G1..G4, G5a, G6s, G9..G20, sha, exemptions, notes}, the
 * record export_story_data.py manifest merges into index.json gates (R7 never writes index.json itself). A gate is true
 * (pass), false (fail), or null (not measured in this run; the reason is in notes). */
export const TIER_IDS = ["clean", "multiphase", "damped", "empty", "hot"];
const CGM = process.env.CGM_WORK || process.env.TNG_WORK || "/Volumes/cgm_work";
export const TIER_INDEX_DEFAULT = join(CGM, "scratch/story3_w/R1/index_v2_draft.json");
export const TIER_FUZZ_DEFAULT = {g17: join(CGM, "scratch/story3_w/R7_fuzz/g17_hard.json"), g18: join(CGM, "scratch/story3_w/R7_fuzz/g18/g18_report.json")};
/** story-index/2 for the test tree: the given index with gates.all forced true on the stories under test (test only; the
 *  shipped index's gates come from export_story_data.py manifest reading gates.json). */
export function tierIndex(file = TIER_INDEX_DEFAULT, ids = TIER_IDS) {
  const ix = JSON.parse(readFileSync(file, "utf8"));
  for (const e of ix.stories || []) if (ids.includes(e.id)) e.gates = {...(e.gates || {}), all: true, note: "R7 test tree: forced true to reach ?story"};
  return ix;
}
/** Temp docs/tng50 tree: ROOT copied (no media/, build/, audio), the rest symlinked; data/index.json replaced. */
export async function tierTree(docs, index, base = null) {
  const fs = await import("node:fs");
  const T = base ? (fs.mkdirSync(base, {recursive: true}), base) : mkdtempSync(join(process.env.TMPDIR || tmpdir(), "r7tier-"));
  const md = join(T, "tng50"); fs.rmSync(md, {recursive: true, force: true}); fs.mkdirSync(join(md, "learn"), {recursive: true});
  for (const e of readdirSync(docs)) if (e !== "learn") fs.symlinkSync(join(docs, e), join(md, e));
  for (const e of readdirSync(join(docs, "learn"))) if (e !== "how-a-spectrum-is-made") fs.symlinkSync(join(docs, "learn", e), join(md, "learn", e));
  const src = join(docs, STORY_REL), dst = join(md, STORY_REL);
  fs.cpSync(src, dst, {recursive: true, dereference: false, filter: f => !/\.(m4a|mp4|webm)$/.test(f) && !f.startsWith(join(src, "media")) && !f.startsWith(join(src, "build"))});
  writeFileSync(join(dst, "data/index.json"), JSON.stringify(index, null, 1));
  return md;
}
/** Files a story loads (beats, shots, story data, page fits, film plan, copy, case copy), relative to ROOT. */
export function tierFiles(entry) {
  return [entry.beats, entry.shots, "data/" + entry.story, "data/" + entry.page_fits, entry.film, "copy.json", entry.id === "full" ? null : "copy.cases.json"].filter(Boolean);
}
const sha16 = buf => createHashSync("sha256").update(buf).digest("hex").slice(0, 16);
import {createHash as createHashSync} from "node:crypto";

/** Per-story G11 exemption rule (DESIGN_tierA §1 G4/G11): v2's B2/B6 stay exempt in the script; beyond them at most one
 *  documented exemption per story. Returns {pass, exempt: [frame ids], fails: [...]}. */
export function g11Verdict(frames) {
  const bad = (frames || []).filter(f => (f.fails || []).some(x => x.gate === "G11"));
  const g4 = (frames || []).filter(f => (f.fails || []).some(x => x.gate === "G4"));
  const beats = [...new Set(bad.map(f => f.id))];
  return {G11: frames && frames.length ? beats.length <= 1 : null, G4: frames && frames.length ? !g4.length : null,
    exempt: beats.length === 1 ? beats : [], g11Beats: beats, g4Frames: g4.map(f => `${f.viewport} ${f.id}`)};
}
/** G14 verdict from story_g11 --g14 results. */
export function g14Verdict(res) {
  if (!res || !res.length) return {G14: null, fails: []};
  const fails = res.filter(r => (r.fails || []).length).map(r => `${r.beat}${r.enc ? " " + r.enc : ""}: ${r.fails.map(f => f.msg).join("; ")}`);
  return {G14: !fails.length, fails};
}
/** Per-story G6 (DESIGN_tierA §9): first-3D-frame bytes <= hero x 1.15, story files <= 1.5 MB, GPU <= 448/192 MB;
 *  the page shell growth <= 3 kB gz is a page-wide number (shellGrowth, from story_budget --story). */
export const G6S = {first3dRatio: 1.15, storyFilesMB: 1.5, shellGrowthKB: 3, gpuDesktopMB: 448, gpuMobileMB: 192};
export function g6sVerdict(b, hero) {
  const MB = 1024 * 1024, fails = [], notes = [];
  if (!b) return {G6s: null, fails: ["no budget result"], notes};
  const br = b.browser || {}, st = b.story || {};
  if (st.filesBytes != null && st.filesBytes > G6S.storyFilesMB * MB) fails.push(`story files ${(st.filesBytes / MB).toFixed(2)} MB > ${G6S.storyFilesMB} MB`);
  if (br.gpuDesktop != null && br.gpuDesktop > G6S.gpuDesktopMB * MB) fails.push(`GPU desktop ${(br.gpuDesktop / MB).toFixed(0)} MB > ${G6S.gpuDesktopMB}`);
  if (br.gpuMobile != null && br.gpuMobile > G6S.gpuMobileMB * MB) fails.push(`GPU mobile ${(br.gpuMobile / MB).toFixed(0)} MB > ${G6S.gpuMobileMB}`);
  const hb = hero && hero.browser && hero.browser.first3dBytes;
  if (br.first3dBytes == null || !hb) notes.push(`first-3D bytes not compared (story ${br.first3dBytes ?? "n/a"}, hero ${hb ?? "n/a"})`);
  else { const r = br.first3dBytes / hb; notes.push(`first-3D bytes ${(br.first3dBytes / MB).toFixed(2)} MB = hero x ${r.toFixed(3)}`);
    if (r > G6S.first3dRatio) fails.push(`first-3D bytes hero x ${r.toFixed(3)} > ${G6S.first3dRatio}`); }
  if (b.node && b.node.shellGrowth != null) { notes.push(`page shell +${(b.node.shellGrowth / 1024).toFixed(2)} kB gz over ${b.node.baseRef} (allowance ${G6S.shellGrowthKB} kB; page-wide, owner item)`); }
  const measured = br.first3dBytes != null || br.gpuDesktop != null || st.filesBytes != null;
  return {G6s: measured ? !fails.length : null, fails, notes};
}

async function tierMain(argv) {
  const {spawnSync} = await import("node:child_process");
  const fs = await import("node:fs");
  const {pos, opt} = (await import("./browser.mjs")).parseArgs(argv);
  const ids = opt.all ? TIER_IDS : String(opt.story || "").split(",").filter(Boolean);
  if (!ids.length) { console.error("usage: node tests/js/lib/storyqa.mjs --all | --story id[,id] [--sets node,h0,browser,gpu] [--out DIR]"); process.exit(2); }
  const sets = new Set(String(opt.sets || "node,h0,browser,gpu").split(","));
  const OUT = resolve(opt.out || join(CGM, "scratch/story3_w/R7_gpu/run_" + (opt.pass || "x")));
  fs.mkdirSync(OUT, {recursive: true});
  const DOCS = resolve(opt.docs || join(REPO, "docs/tng50"));
  const ixFile = resolve(opt.index || TIER_INDEX_DEFAULT), IX = tierIndex(ixFile, ids);
  const byId = Object.fromEntries((IX.stories || []).map(e => [e.id, e]));
  const T0 = Date.now(), log = m => { const s = `[${((Date.now() - T0) / 1000).toFixed(0)} s] ${m}`; console.log(s); fs.appendFileSync(join(OUT, "runner.log"), s + "\n"); };
  log(`tier run: stories ${ids.join(",")}; sets ${[...sets].join(",")}; docs ${DOCS}; index ${ixFile}; out ${OUT}`);
  const needTree = sets.has("browser") || sets.has("gpu");
  const TREE = needTree ? await tierTree(DOCS, IX, join(OUT, "tree")) : null;
  const run = (name, args, env, dir) => {
    fs.mkdirSync(dir, {recursive: true});
    const t = Date.now(), r = spawnSync(process.execPath, [join(REPO, "tests/js", name + ".mjs"), ...args], {cwd: REPO, env: {...process.env, ...env}, encoding: "utf8", maxBuffer: 256 << 20, timeout: (+opt["script-timeout"] || 1800) * 1000});
    const txt = (r.stdout || "") + (r.stderr || ""); fs.writeFileSync(join(dir, name + (args.includes("--g14") ? "_g14" : "") + ".log"), txt);
    const last = txt.trim().split("\n").filter(l => /^(PASS|FAIL|ok|not ok|\d+ passed|.*passed.*failed)/i.test(l)).slice(-1)[0] || txt.trim().split("\n").slice(-1)[0] || "";
    log(`${r.status === 0 ? "PASS" : "FAIL"} ${name}${args.includes("--g14") ? " --g14" : ""} ${dir.split("/").pop()} ${((Date.now() - t) / 1000).toFixed(0)} s  ${last.slice(0, 160)}`);
    return {status: r.status, signal: r.signal, out: txt};
  };
  const readJ = f => { try { return JSON.parse(readFileSync(f, "utf8")); } catch { return null; } };
  const vizOf = g => join(CGM, "data/gal", String(g), "viz");
  const result = {schema: "story-gates-run/1", pass: opt.pass ? +opt.pass : null, started: new Date(T0).toISOString(), index: ixFile, docs: DOCS, gpu: !!process.env.TNG_GPU, stories: {}};
  const heaviest = ids.includes("damped") ? "damped" : ids[0];

  /* H0 once, on the real tree */
  let H0 = null;
  if (sets.has("h0")) { const r = run("story_hero_identity", [], {}, join(OUT, "_hero")); H0 = r.status === 0; result.H0_log = join(OUT, "_hero/story_hero_identity.log"); }

  /* hero budget baseline (first-3D bytes) */
  let heroBudget = opt["hero-budget"] ? readJ(resolve(opt["hero-budget"])) : null;
  const skip = new Set(String(opt.skip || "").split(",").filter(Boolean));
  if (sets.has("gpu") && !opt["no-hero-budget"] && !heroBudget) {
    const d = join(OUT, "_hero");
    run("story_budget", [TREE, "--story", "full", "--out", d], {STORY_QA_STORY: "", STORY_VIZ: vizOf(488530), TNG_BROWSER: "1"}, d);
    heroBudget = readJ(join(d, "budget.json"));
  }

  /* hero baselines in the same tree (sets browser/gpu): a story failure the hand-tuned hero shares is marked "also on hero"
   * (a v2 condition, routed as such), never hidden */
  const hero = {};
  const AXE0 = process.env.AXE_JS || join(CGM, "scratch/story2_w/review3_perf_a11y/axe/package/axe.min.js");
  const henv = {STORY_QA_STORY: "", STORY_VIZ: vizOf(488530), TNG_BROWSER: "1", ...(existsSync(AXE0) ? {AXE_JS: AXE0} : {})}, HD = join(OUT, "_hero");
  if (sets.has("browser") && !opt["no-hero-base"]) {
    run("story_overlap", [TREE, "--quick", "--samples", "24", "--no-explorer", "--motion", "reduced", "--out", HD], henv, HD);
    hero.overlap = readJ(join(HD, "overlap.json"));
    hero.a11y = run("story_a11y", [TREE, "--out", HD], henv, HD).status === 0;
  }
  if (sets.has("gpu") && !opt["no-hero-base"]) {
    run("story_g11", [TREE, "--viewports", "1440x900,390x844", "--shots", join(HD, "shots_g11"), "--out", HD], henv, HD);
    hero.g11 = g11Verdict(readJ(join(HD, "g11.json")));
    if (!skip.has("perf")) { hero.g5a = run("story_perf", [TREE, "--out", HD], henv, HD).status === 0; hero.perf = readJ(join(HD, "perf.json")); }
  }
  const sig = x => { const m = String(x.msg || x), sp = m.indexOf(" "), vp = sp > 0 ? m.slice(0, sp) : "";   // viewport kept; beat, text, numbers dropped
    return (x.gate || "") + " " + vp + " " + m.slice(sp + 1).replace(/^B\d+[a-z]*:\s*/, "").replace(/"[^"]*"/g, '"~"').replace(/\[[^\]]*\]/g, "[]").replace(/\d+(\.\d+)?/g, "N").slice(0, 160); };
  const heroSigs = new Set(((hero.overlap && hero.overlap.failures) || []).map(sig));
  result.hero = {overlap: hero.overlap ? {states: hero.overlap.states, failing: hero.overlap.failing, byGate: hero.overlap.byGate} : null, a11y: hero.a11y ?? null,
    g11: hero.g11 || null, g5a: hero.g5a ?? null, budget: heroBudget ? heroBudget.browser || null : null};

  for (const id of ids) {
    const e = byId[id]; if (!e) { log(`no index entry for ${id}`); result.stories[id] = {error: "no index entry"}; continue; }
    const AXE = process.env.AXE_JS || join(CGM, "scratch/story2_w/review3_perf_a11y/axe/package/axe.min.js");
    const D = join(OUT, id), env = {STORY_QA_STORY: id, STORY_VIZ: vizOf(e.galaxy), TNG_BROWSER: "1", ...(existsSync(AXE) ? {AXE_JS: AXE} : {})};
    fs.mkdirSync(D, {recursive: true});
    const G = {H0, sha: null}, notes = [], ROOTD = join(DOCS, STORY_REL);
    /* sha of the story's files (as tested) */
    const files = tierFiles(e), shas = {};
    for (const f of files) { const p = join(ROOTD, f); shas[f] = existsSync(p) ? sha16(readFileSync(p)) : null; }
    G.sha = sha16(Buffer.from(JSON.stringify(shas))); G.files = shas;
    if (sets.has("node")) {
      const beats = readJ(join(ROOTD, e.beats)), data = readJ(join(ROOTD, "data", e.story));
      const gn = (beats && beats.meta && beats.meta.generator && beats.meta.generator.gates_node) || {};
      for (const k of ["G1", "G2", "G3", "G12", "G13r", "G15", "G19", "G20"]) G[k + "_node"] = gn[k] ?? null;
      G.schema = gn.schema ?? null;
      const gc = (data && data.gates_case) || {};
      G.G16 = gc.G16 ? !!gc.G16.pass : null;
      G.G15 = (gn.G15 ?? null) === null ? null : !!gn.G15 && (gc.G15_data ? !!gc.G15_data.pass : true);
      G.G13r = (gn.G13r ?? null) === null ? null : !!gn.G13r && (gc.G13r_data ? gc.G13r_data.pass !== false : true);
      G.G19 = gn.G19 ?? null; G.G20 = gn.G20 ?? null;
      const watch = beats && beats.meta ? beats.meta.watchTotal_s : null;
      if (watch != null) { G.watch_s = watch; notes.push(`watch ${watch} s (target ${beats.meta.target_s} s; owner window 100-200 s, OWNER_DECISIONS 5)${watch > 200 || watch < 100 ? " OUTSIDE the owner window" : ""}`); }
      const g17 = readJ(opt.g17 || TIER_FUZZ_DEFAULT.g17), g18 = readJ(opt.g18 || TIER_FUZZ_DEFAULT.g18) || readJ(join(CGM, "scratch/story3_w/R7_fuzz/g18_interim.json"));
      if (g17 && g17.hard) { const failed = (g17.hard.failed || []).map(x => typeof x === "string" ? x : JSON.stringify(x));
        const mine = g17.hard_files ? g17.hard_files.some(f => f.endsWith("/" + e.story.split("/").pop())) : true;
        G.G17 = mine ? !failed.some(f => f.includes(e.ray)) : null; if (!mine) notes.push("G17: story file not in the fuzz hard set"); }
      else { G.G17 = null; notes.push("G17 report not found"); }
      G.G18 = null; if (g18) notes.push(`G18 (report only, page-wide${g18.n < 200 ? ", interim" : ""}): ${g18.all_three ?? "?"}/${g18.n ?? "?"} = ${g18.rate != null ? (100 * g18.rate).toFixed(1) : "?"} % (target 95 %)`);
      else notes.push("G18 report not found (report only)");
    }
    if (sets.has("browser")) {
      if (!skip.has("overlap")) run("story_overlap", [TREE, "--quick", "--samples", "24", "--no-explorer", "--motion", "reduced", "--shots", join(D, "shots_overlap"), "--out", D], env, D);
      const ov = skip.has("overlap") ? null : readJ(join(D, "overlap.json"));
      if (ov && ov.states) { const bg = ov.byGate || {}; for (const k of ["G1", "G2", "G3", "G10", "G12"]) G[k + "_dom"] = !bg[k];
        notes.push(`overlap DOM: ${ov.states} states, ${ov.failing} failing ${JSON.stringify(bg)}`);
        const fl = (ov.failures || []).map(f => ({gate: f.gate, msg: f.msg, hero: heroSigs.has(sig(f))}));
        G.overlap_failures = fl.slice(0, 40); const sh = fl.filter(f => f.hero).length;
        if (fl.length) notes.push(`overlap DOM failures: ${fl.length} listed, ${sh} with the same message on the hero (also on hero)`);
        // a DOM layout failure the hand-tuned hero shows with the same message (same viewport, element and reason) is a v2
        // condition, not a Tier A regression: the gate passes with a documented "inherited_v2" exemption (DESIGN_tierA §1
        // "all-pass or a documented exemption"; treated like the v2 G6 shell item, §9). Any story-only failure still fails.
        if (heroSigs.size && fl.length === (ov.failures || []).length) for (const k of ["G1", "G2", "G3", "G10", "G12"]) {
          const mine = fl.filter(f => f.gate === k); if (!mine.length || mine.some(f => !f.hero)) continue;
          G[k + "_dom"] = true; G.exemptions = {...(G.exemptions || {}), inherited_v2: {...((G.exemptions || {}).inherited_v2 || {}), [k]: [...new Set(mine.map(sig))]}}; } }
      else notes.push("overlap DOM: no states measured");
      const a = skip.has("a11y") ? {status: null, out: ""} : run("story_a11y", [TREE, "--out", D], env, D);
      G.G9 = a.status === null ? null : a.status === 0; if (G.G9 === false) { const fl = a.out.split("\n").filter(l => /^FAIL/.test(l)).slice(0, 6); notes.push(...fl.map(l => "G9 " + l.replace(/^FAIL\s+/, "")));
        if (hero.a11y === false) notes.push("G9: the hero fails story_a11y too in this tree (see _hero/story_a11y.log)"); }
    }
    if (sets.has("gpu")) {
      run("story_g11", [TREE, "--viewports", "1440x900,390x844", "--shots", join(D, "shots_g11"), "--out", D], env, D);
      const gv = g11Verdict(readJ(join(D, "g11.json"))); G.G11 = gv.G11; G.G4 = gv.G4; if (gv.exempt.length) G.exemptions = {...(G.exemptions || {}), G11: gv.exempt};
      if (gv.g11Beats.length) notes.push(`G11 frames failing: ${gv.g11Beats.join(", ")}${gv.exempt.length ? " (one exemption allowed; must be documented)" : ""}`);
      if (gv.g4Frames.length) notes.push(`G4 frames failing: ${gv.g4Frames.join(", ")}`);
      fs.mkdirSync(join(D, "g14"), {recursive: true});
      run("story_g11", ["--g14", "--story", id, TREE, "--shots", join(D, "shots_g14"), "--out", join(D, "g14")], env, D);
      const g14 = g14Verdict(readJ(join(D, "g14/g14.json"))); G.G14 = g14.G14; for (const f of g14.fails) notes.push("G14 " + f);
      if (!skip.has("budget")) { run("story_budget", [TREE, "--story", id, "--out", D], env, D);
        const gs = g6sVerdict(readJ(join(D, "budget.json")), heroBudget); G.G6s = gs.G6s; notes.push(...gs.notes); for (const f of gs.fails) notes.push("G6s " + f); }
      if (id === heaviest && !skip.has("perf")) { const r = run("story_perf", [TREE, "--out", D], env, D); G.G5a = r.status === 0; }
    }
    /* combined layout gates: node (R3, full matrix x 1600 p) and DOM (this run) must both hold where measured */
    for (const k of ["G1", "G2", "G3", "G12"]) { const a = G[k + "_node"], b = G[k + "_dom"]; G[k] = a === false || b === false ? false : (a ?? b ?? null); }
    G.G10 = G.G10_dom ?? null;
    const gateIds = ["H0", "G1", "G2", "G3", "G4", ...(id === heaviest && sets.has("gpu") && !skip.has("perf") ? ["G5a"] : []), "G6s", "G9", "G10", "G11", "G12", "G13r", "G14", "G15", "G16", "G17", "G19", "G20"];
    const missing = gateIds.filter(k => G[k] == null), failing = gateIds.filter(k => G[k] === false);
    G.all = !failing.length && !missing.length;
    result.stories[id] = {...G, failing, missing, notes};
    log(`${id}: ${G.all ? "ALL PASS" : `failing [${failing.join(", ")}] missing [${missing.join(", ")}]`}`);
    fs.writeFileSync(join(OUT, "gates.json"), JSON.stringify(result, null, 1) + "\n");
  }
  result.finished = new Date().toISOString();
  fs.writeFileSync(join(OUT, "gates.json"), JSON.stringify(result, null, 1) + "\n");
  log(`wrote ${join(OUT, "gates.json")}`);
  /* preview (R7_gpu): the same browser/GPU gates on a scratch tree with the owners' pending handoff patches applied
   * (--preview DOCS, STORY_QA_PREVIEW, or a symlink <out>/../preview_docs_for_pass<N>). A preview never sets gates. */
  const pvLink = opt.pass ? join(dirname(OUT), "preview_docs_for_pass" + opt.pass) : null;
  const PV = opt.preview || process.env.STORY_QA_PREVIEW || (pvLink && existsSync(pvLink) ? fs.realpathSync(pvLink) : null);
  if (PV && !opt["is-preview"]) {
    log(`preview run on ${PV}`);
    const hb = join(OUT, "_hero/budget.json");
    const r = spawnSync(process.execPath, [new URL(import.meta.url).pathname, ...(opt.all ? ["--all"] : ["--story", ids.join(",")]), "--docs", PV, "--out", join(OUT, "preview"),
      "--sets", [...sets].filter(x => x !== "h0").join(","), "--is-preview", "--no-hero-base", "--skip", opt["preview-skip"] || "budget,perf,overlap,a11y", ...(existsSync(hb) ? ["--hero-budget", hb] : []), "--index", ixFile],
      {cwd: REPO, env: process.env, stdio: "inherit", timeout: 3 * 3600 * 1000});
    log(`preview finished (${r.status}); gates in ${join(OUT, "preview/gates.json")}`);
  }
  process.exit(0);
}
if (process.argv[1] && resolve(process.argv[1]) === resolve(new URL(import.meta.url).pathname)) await tierMain(process.argv.slice(2));
