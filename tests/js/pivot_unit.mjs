// 3D re-centring ("pivot", docs/tng50/js/viewer3d.js, spec ux4 §A): the pure helpers, no browser.
// parsePivot / formatPivot (the ?pv=x,y,z URL value: 0.1 kpc, clamped to ±400 kpc, empty at the centre), offCentre,
// rayPivot (a sightline's closest approach to the galaxy, clamped to the segment), planePoint (the empty-ray fallback of
// a double-click) and pickAlongRay (the densest sample of nested byte cubes along the clicked ray, nearest first on ties,
// finest cube where they overlap). The viewer's own checks (chip, animation, URL, double-click) are in viewer_browser.mjs.
// Usage: node tests/js/pivot_unit.mjs
import {PIVOT, parsePivot, formatPivot, parseCam, formatCam, offCentre, rayPivot, planePoint, pickAlongRay, MOVING_LADDER, pickMovingRung, createMovingGovernor} from "../../docs/tng50/js/viewer3d.js";
import * as E3D from "../../docs/tng50/js/export3d.js";
import {checker, sepHits} from "./lib/browser.mjs";

const C = checker(), check = C.check;
const near = (a, b, e = 1e-6) => !!a && !!b && a.length === b.length && a.every((x, i) => Math.abs(x - b[i]) <= e);
const J = x => JSON.stringify(x);

/* ---- URL value ---- */
check(PIVOT.eps > 0 && PIVOT.eps <= 1 && PIVOT.max === 400, `PIVOT ${J(PIVOT)}`);
check(near(parsePivot("12.34,-5,0"), [12.3, -5, 0]), `parse "12.34,-5,0" -> ${J(parsePivot("12.34,-5,0"))} (0.1 kpc)`);
check(near(parsePivot(" 1 , 2 , 3 "), [1, 2, 3]), "parse tolerates spaces");
check(near(parsePivot("900,-900,10"), [400, -400, 10]), `parse clamps to ±${PIVOT.max} kpc: ${J(parsePivot("900,-900,10"))}`);
for (const bad of [null, undefined, "", "1,2", "1,2,3,4", "a,b,c", "1,,3", "NaN,1,1", "Infinity,0,0"])
  check(parsePivot(bad) === null, `parse ${J(bad)} -> null`);
check(parsePivot("0,0,0") === null && parsePivot("0.1,0.1,0") === null, "parse at the centre (within eps) -> null");
check(formatPivot([12.34, -5.06, 0.04]) === "12.3,-5.1,0", `format -> "${formatPivot([12.34, -5.06, 0.04])}" (no -0)`);
check(formatPivot([0, 0, 0]) === "" && formatPivot([0.1, -0.2, 0.1]) === "" && formatPivot(null) === "", "format at the centre -> empty (no pv in the URL)");
{ const p = [37.25, -120.5, 8]; check(near(parsePivot(formatPivot(p)), [37.3, -120.5, 8]), "format then parse round-trips to 0.1 kpc"); }
check(offCentre([1, 0, 0]) && !offCentre([0.2, 0.2, 0.2]) && !offCentre(null), "offCentre: beyond eps only");
check(sepHits(formatPivot([1.5, 2.5, -3.5])).length === 0, "URL value has no dot separators beyond decimals");

/* ---- sightline pivot ---- */
check(near(rayPivot([-100, 50, 0], [100, 50, 0]), [0, 50, 0]), `ray along x at y = 50: closest approach ${J(rayPivot([-100, 50, 0], [100, 50, 0]))}`);
check(near(rayPivot([20, 0, 0], [120, 0, 0]), [20, 0, 0]), "segment wholly on one side: clamped to the near end");
check(near(rayPivot([-30, 10, 40], [-30, 10, 40]), [-30, 10, 40]), "degenerate segment: its point");
{ const a = [-200, -80, 30], b = [150, 60, -10], p = rayPivot(a, b), d = b.map((x, i) => x - a[i]);
  check(Math.abs(p[0] * d[0] + p[1] * d[1] + p[2] * d[2]) < 1e-6, "oblique ray: the pivot is perpendicular to the ray from the centre"); }

/* ---- plane fallback ---- */
check(near(planePoint([0, 0, 500], [0, 0, -1], [0, 0, 0], [0, 0, -1]), [0, 0, 0]), "straight down the view axis: the current centre");
check(near(planePoint([0, 0, 500], [0.6, 0, -0.8], [10, 0, 0], [0, 0, -1]), [375, 0, 0]), "oblique ray meets the plane through the centre");
check(planePoint([0, 0, 500], [1, 0, 0], [0, 0, 0], [0, 0, -1]) === null, "ray parallel to the plane -> null");
check(planePoint([0, 0, 500], [0, 0, 1], [0, 0, 0], [0, 0, -1]) === null, "plane behind the camera -> null");

/* ---- densest sample along the ray ---- */
const cube = (m, half, fill) => { const data = new Uint8Array(m * m * m); const f = m / (2 * half), ix = v => Math.max(0, Math.min(m - 1, Math.floor((v + half) * f)));
  for (const [p, q] of fill) data[ix(p[0]) + m * (ix(p[1]) + m * ix(p[2]))] = q; return {data, m, half}; };
{ const L0 = cube(32, 400, [[[0, 0, 0], 40], [[200, 0, 0], 90]]);
  const h = pickAlongRay([200, 0, 900], [0, 0, -1], [L0]);
  check(h && h.q === 90 && Math.abs(h.p[0] - 200) < 1 && Math.abs(h.p[2]) <= 25, `single cube: densest voxel on the ray (${J(h)})`);
  check(pickAlongRay([0, 300, 900], [0, 0, -1], [L0]) === null, "empty column: null (caller falls back to the plane)");
  check(pickAlongRay([0, 0, 900], [0, 0, 1], [L0]) === null, "cube behind the camera: null");
  check(pickAlongRay([0, 0, 0], [0, 0, 1], []) === null && pickAlongRay([0, 0, 0], [0, 0, 1], null) === null, "no resident cubes: null");
  check(pickAlongRay([0, 0, 900], [0, 0, -1], [L0], 50) === null, "below qmin: null"); }
{ /* two equal maxima along the ray: the one nearer the camera */
  const L0 = cube(32, 400, [[[0, 0, 300], 70], [[0, 0, -300], 70]]), h = pickAlongRay([0, 0, 900], [0, 0, -1], [L0]);
  check(h && h.p[2] > 200, `ties: the nearer sample (z ${h && h.p[2].toFixed(0)})`); }
{ /* nested: inside ±100 the finer L1 cube decides (its small dense clump), outside it the L0 cube */
  const L1 = cube(64, 100, [[[30, 30, 30], 120]]), L0 = cube(32, 400, [[[25, 25, 25], 60], [[30, 30, 350], 100]]);
  const h = pickAlongRay([30, 30, 900], [0, 0, -1], [L1, L0]);
  check(h && h.q === 120 && Math.abs(h.p[2] - 30) < 4, `nested cubes: finest level inside its box (${J(h)})`);
  const h0 = pickAlongRay([30, 30, 900], [0, 0, -1], [L0]);
  check(h0 && h0.q === 100 && h0.p[2] > 300, `L0 only: the coarse maximum (${J(h0)})`); }
{ /* camera inside the box: samples start at the camera */
  const L0 = cube(32, 400, [[[0, 0, 200], 200], [[0, 0, -100], 50]]), h = pickAlongRay([0, 0, 0], [0, 0, -1], [L0]);
  check(h && h.q === 50, `camera inside the box: only what is in front (${J(h)})`); }

/* ---- moving-frame FPS & quality governor ---- */
{ check(MOVING_LADDER.length === 5 && MOVING_LADDER[4].fps === 60 && MOVING_LADDER[4].exact === 1 && MOVING_LADDER[3].exact === 0 && MOVING_LADDER[0].fps === 24,
    `MOVING_LADDER has 5 rungs from 24fps-lite to 60fps-crisp (${MOVING_LADDER.map(r => r.name).join(" -> ")})`);
  check(pickMovingRung(5) === 4 && pickMovingRung(10) === 3 && pickMovingRung(18) === 2 && pickMovingRung(28) === 1 && pickMovingRung(45) === 0,
    "pickMovingRung maps calibrated moving_exact_ms to the right starting rung (60 -> 30 -> 24 fps)");
  check(pickMovingRung(6, {fs: true}) === 3 && pickMovingRung(5, {lowTier: true}) === 0,
    "pickMovingRung accounts for fullscreen pixel load and lowTier floor");
  const g = createMovingGovernor({start: 3, slowN: 4, fastN: 10});
  for (let i = 0; i < 4; i++) g.push(24);
  check(g.index === 2 && g.rung.name === "30fps-balanced", `governor drops 60fps-fast -> 30fps-balanced after 4 slow frames (${g.rung.name})`);
  for (let i = 0; i < 4; i++) g.push(42);
  check(g.index === 1 && g.rung.name === "30fps-fast", `governor drops 30fps-balanced -> 30fps-fast under heavy load (${g.rung.name})`);
  for (let i = 0; i < 20; i++) g.push(10);
  check(g.index === 3 && g.state().raises === 2, `governor climbs back up when frame times stay < 12 ms (${J(g.state())})`); }

/* ---- camera deep-link & export3d pure helpers ---- */
{ const c = parseCam("120.456,-250.1,300,0,0,1");
  check(c && near(c.p, [120.46, -250.1, 300]) && near(c.u, [0, 0, 1]), `parseCam parses and normalises camera pose (${J(c)})`);
  check(parseCam("1,2,3") === null && parseCam("1,2,3,0,0,0") === null && parseCam("") === null, "parseCam rejects malformed or zero-up inputs");
  check(formatCam([120.456, -250.1, 300], [0, 0, 1]) === "120.46,-250.1,300,0,0,1", `formatCam formats to 0.01 (${formatCam([120.456, -250.1, 300], [0, 0, 1])})`);
  const mockV = {
    species: "OVI", mode: "volume", frame: {R200c: 240},
    camera: {fov: 22, position: {distanceTo: () => 520}},
    controls: {target: {x: 0, y: 0, z: 0}},
    getSceneSnapshot: () => ({species: "OVI", mode: "volume", transfer: {lo: 13.6, hi: 15.2, cmap: "tng_dusk"}, camera: {position: [0, -450, 260], target: [0, 0, 0], up: [0, 0, 1]}, pivot: [10, -20, 5], selectedSightline: "edge_b100_a090"})
  };
  check(E3D.buildFilename(mockV, 2048, 2048, "png") === "tng50_galaxy_OVI_volume_2048x2048.png", `buildFilename produces expected filename (${E3D.buildFilename(mockV, 2048, 2048, "png")})`);
  const dl = E3D.buildDeepLink(mockV);
  check(dl.includes("cam=0,-450,260,0,0,1") && dl.includes("pv=10,-20,5") && dl.includes("tf=OVI"), `buildDeepLink encodes cam, pv and tf (${dl})`);
  const cap = E3D.buildLatexCaption(mockV);
  check(cap.startsWith("\\caption{") && cap.includes("O\\,VI") && cap.includes("R_{200\\mathrm{c}}"), `buildLatexCaption generates LaTeX caption`);
  const figBlk = E3D.buildLatexFigureBlock(mockV);
  check(figBlk.includes("\\begin{figure}") && figBlk.includes("\\includegraphics") && figBlk.includes("\\end{figure}"), "buildLatexFigureBlock wraps includegraphics and caption");
  const cmLayout = E3D.layoutCMText("$\\log_{10} N_{\\mathrm{O\\,VI}}\\ [\\mathrm{cm^{-2}}]$");
  check(cmLayout.glyphs.length >= 12 && cmLayout.widthEm > 4, `layoutCMText lays out Computer Modern vector glyphs (${cmLayout.glyphs.length} glyphs, ${cmLayout.widthEm.toFixed(2)} em)`);
  const legInfo = E3D.getLegendInfo(mockV);
  check(legInfo.stops.length === 128 && legInfo.ticks.length >= 2 && legInfo.minorTicks.length >= 4 && legInfo.titleMath.includes("O\\,VI"), "getLegendInfo produces 128 vertical stops, major+minor ticks, and LaTeX math title");
  const scInfo = E3D.getScaleInfo(mockV, 356, 356);
  check(scInfo.xTicks.length >= 3 && scInfo.xMinor.length >= 8 && scInfo.yTicks.length >= 3 && scInfo.yMinor.length >= 8, "getScaleInfo produces 4-sided major and minor ticks");
  const jsonRes = E3D.exportJSON(mockV, {download: false});
  check(jsonRes.filename.endsWith(".json") && JSON.parse(jsonRes.json).scene.species === "OVI", "exportJSON serialises scene snapshot"); }

process.exit(C.finish());
