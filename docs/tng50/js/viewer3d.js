// 3D viewer v3 for the TNG50 page (Phase-2b design §5, Phase-3 design §6.2 C13): deposited gas cubes (L0 ±400, L1 ±100,
// L2 ±25 kpc) and true-colour stellar cubes (S0-S2) ray-marched in one pass (raymarch.js). Default render = integral (a
// column map from any angle); volume mode = emission/absorption. Nested LOD with fade-in, GPU budget + LRU, on-demand
// rendering, every catalogued sightline as a line, click-to-select, presets, optional guides, HTML scale bar, fullscreen.
// three.js is imported lazily through the page's importmap, so the pure exports also run in node.
// Scene units: physical kpc, origin = galaxy centre, box axes; the cube mesh carries the disk-frame rotation.
//
// ---- Page API (Phase 3) ------------------------------------------------------------------------------------------------
// One engine per page (one WebGL context, one set of GPU cubes). It is shown either on the full square stage of the 3D tab
// or in a small square thumbnail on the Spectra tab; the same canvas moves between the two hosts, so the cubes loaded for
// one are never fetched or uploaded again for the other.
//
//   mount(root, app, opts) -> Promise<viewer>        the full stage (resolves once the first field is shown)
//       root: #v3d-root. If it sits inside the page's square #v3d-stage, the canvas fills it; otherwise the viewer builds
//             its own layout inside root (a square .v3d-sq stage beside a 300 px control column, below it under 1024 px).
//       opts.controls: element for the grouped control column (default #v3d-controls, else the built layout's column).
//             The viewer puts its cards there first (#v3-ctl: Field, View, Layers, Mode, Pick ray); a #picker-root found in
//             the column or the page moves into the Pick ray card (else one is created there) for picker.attachPicker.
//       opts.viz (default app.config.viz), opts.species (first field), opts.manifest / opts.webgl2 (tests).
//   mountThumb(host, app, opts) -> Promise<thumb>    the Spectra-tab thumbnail
//       host: a positioned, square element (e.g. button#v3d-mini, aspect-ratio 1/1). The canvas fills it. Low cost: thumb
//             frames use THUMB.spv steps per voxel, no stars or fine levels unless already resident, no refine passes; a
//             slow turn about the disk normal (opts.spin, default true; off with prefers-reduced-motion) runs at THUMB.fps
//             only while the host is on screen and the page is visible. No orbit, keys or picking in the thumbnail.
//       opts.onOpen(): called on a click of the host (e.g. () => app.showTab("3d")); omit it to handle the click yourself.
//       opts.tags (default true): the field tag and the "3D" tag at the bottom of the thumbnail; false if the page draws its own.
//       thumb = {viewer, host, get active(), setSpin(bool), dispose()}  (dispose detaches the thumbnail only)
//   Docking is automatic: the canvas goes to the full stage whenever that is on screen, else to the thumbnail when that is
//   on screen (IntersectionObserver). viewer.dock("full" | "thumb" | "auto") overrides it; viewer.docked reads it.
//   current() -> the engine promise or null. speciesList (vizdata.js) is the pure species-menu model.
//   viewer keeps the v2 surface: setSpecies(k) -> Promise<bool> (false, no exception, for a species whose cubes are not
//   built: viewer.loadError = {key, message}), setPreset, setMode, setStars, setGuides, setTransfer, setLines, select,
//   toggleFullscreen, levels, gpuBytes, bench, render, resize, dispose, hooks, stats, species, wanted, mode, message.
//   vel3d: setSpecies also takes the velocity views vlos, vr, vphi, vmag, sigmalos (vizdata VEL_VIEWS; false with a manifest
//   that has no gas.vectors). setWeight(k) picks their weight (nH or an ion with cubes; viewer.weight reads it),
//   setTransfer({W, opacity, cmap}) their window (±W km/s, 0..W for vmag and sigmalos); viewer.velocity = {V, units, frame} or null.
// ------------------------------------------------------------------------------------------------------------------------
import {lut, cssGradient, NAMES as CMAPS, VEL_NAMES} from "./colormaps.js";
import {VOL_KEYS, ION_KEYS, decodeU8, gunzipIfNeeded, loadManifestV2, viewPlan, speciesList, MU_ZERO,
  VEL_KEYS, VEL_COMP_KEYS, velocityInfo, velocityList, packVelocity} from "./vizdata.js";
import {makeMaterial} from "./raymarch.js";
import {makeLoader, HostError, fetchText} from "./vizload.js";
import {preset as tfPreset, encodeTF, decodeTF, buildTF, tfUniforms, defaultWRef, histogram2D, GMAX_DEFAULT, THOR, TF_W, TF_H} from "./tf.js";
import {createTfEditor, histCodes, histWindow} from "./tfeditor.js";
import {initTips} from "./tips.js";

export {VOL_KEYS, decodeU8, gunzipIfNeeded, speciesList, velocityList};

/* ---- ux4 pivot: the orbit centre (OrbitControls target), scene kpc. Default the galaxy centre; the user moves it by
   double-clicking the stage (densest sample of the current field along the ray), to the selected sightline (closest
   approach to the galaxy) or to typed kpc; the stage chip / key C brings it back. Kept in the URL as ?pv=x,y,z (the
   page's hash writes keep the search part). Pure helpers below run in node (tests/js/pivot_unit.mjs). ---- */
export const PIVOT = {eps: 0.5, max: 400};               // off-centre beyond eps kpc; typed / URL values clamped to ±max
const r1 = x => { const v = Math.round(x * 10) / 10; return Object.is(v, -0) ? 0 : v; };
export const offCentre = p => !!p && Math.hypot(p[0], p[1], p[2]) > PIVOT.eps;
/* "x,y,z" (kpc) -> [x, y, z] clamped to ±PIVOT.max, or null (absent, malformed, or at the centre) */
export function parsePivot(s) {
  const t = String(s ?? "").split(",").map(x => x.trim());
  if (t.length !== 3 || t.some(x => x === "")) return null;
  const p = t.map(Number); if (!p.every(Number.isFinite)) return null;
  const q = p.map(x => r1(Math.max(-PIVOT.max, Math.min(PIVOT.max, x)))); return offCentre(q) ? q : null;
}
/* [x, y, z] -> "x,y,z" to 0.1 kpc; "" at the centre */
export const formatPivot = p => (offCentre(p) ? p.map(r1).join(",") : "");
/* a sightline's pivot: its closest approach to the galaxy centre, clamped to the segment p0-p1 (the midpoint if it is
   degenerate) */
export function rayPivot(p0, p1) {
  const d = [p1[0] - p0[0], p1[1] - p0[1], p1[2] - p0[2]], L2 = d[0] * d[0] + d[1] * d[1] + d[2] * d[2];
  const s = L2 > 1e-12 ? Math.max(0, Math.min(1, -(p0[0] * d[0] + p0[1] * d[1] + p0[2] * d[2]) / L2)) : 0.5;
  return [p0[0] + s * d[0], p0[1] + s * d[1], p0[2] + s * d[2]];
}
/* point where the ray o + s d (s > 0) meets the plane through t with normal n; null when parallel or behind */
export function planePoint(o, d, t, n) {
  const dn = d[0] * n[0] + d[1] * n[1] + d[2] * n[2]; if (Math.abs(dn) < 1e-9) return null;
  const s = ((t[0] - o[0]) * n[0] + (t[1] - o[1]) * n[1] + (t[2] - o[2]) * n[2]) / dn;
  return s > 0 ? [o[0] + s * d[0], o[1] + s * d[1], o[2] + s * d[2]] : null;
}
/* densest sample along the ray o + s d (s >= 0, disk-frame kpc, d unit) through nested byte cubes
   cubes: [{data: Uint8Array m³ (x fastest), m, half}] finest first (each sample reads the finest cube containing it,
   nearest voxel, steps of half a voxel of that cube). Codes are monotonic in the field's log value, 0 = no gas.
   -> {p: [x, y, z], q} at the first maximum (nearest the camera), or null when no code reaches qmin */
export function pickAlongRay(o, d, cubes, qmin = 1) {
  const cs = (cubes || []).filter(c => c && c.data && c.m > 0 && c.half > 0); if (!cs.length) return null;
  const H = Math.max(...cs.map(c => c.half));
  let t0 = 0, t1 = Infinity;
  for (let a = 0; a < 3; a++) {
    if (Math.abs(d[a]) < 1e-12) { if (Math.abs(o[a]) > H) return null; continue; }
    let u = (-H - o[a]) / d[a], v = (H - o[a]) / d[a]; if (u > v) [u, v] = [v, u];
    t0 = Math.max(t0, u); t1 = Math.min(t1, v); }
  if (!(t1 > t0)) return null;
  let best = null, bq = qmin - 1;
  for (let t = t0, guard = 0; t <= t1 && guard < 20000; guard++) {
    const x = o[0] + t * d[0], y = o[1] + t * d[1], z = o[2] + t * d[2];
    const c = cs.find(k => Math.abs(x) <= k.half && Math.abs(y) <= k.half && Math.abs(z) <= k.half) || cs[cs.length - 1];
    const f = c.m / (2 * c.half), ix = v => Math.max(0, Math.min(c.m - 1, Math.floor((v + c.half) * f)));
    const q = c.data[ix(x) + c.m * (ix(y) + c.m * ix(z))];
    if (q > bq) { bq = q; best = {p: [x, y, z], q}; }
    t += 0.5 / f; }
  return best;
}
/* fix-ui V8: no literal underscores; COL_HTML is the colour-bar title with real subscripts (plain text elsewhere) */
const COL_HTML = {nH: "N<sub>H</sub>", T: "⟨T⟩ (n<sub>H</sub>-weighted)", Z: "⟨Z⟩ (n<sub>H</sub>-weighted)"};
const COL_TXT = {nH: "NH", T: "⟨T⟩ (nH-weighted)", Z: "⟨Z⟩ (nH-weighted)"};
const VOL_HTML = {nH: "n<sub>H</sub>"};
const isIon = k => ION_KEYS.includes(k);
/* vel3d: the five velocity views (vizdata VEL_VIEWS). Default window ±VEL_W km/s (0..VEL_W for |v| and σ_los), the
   slider from VEL_WMIN to the encoding's V; the weight is n_H unless the Weight control names an ion */
const isVel = k => VEL_KEYS.includes(k);
const VEL_W = 200, VEL_WMIN = 10;
/* Phase 3 thumbnail: steps per voxel, frame rate of the slow turn, its speed, refine frames when still */
const THUMB = {spv: 0.6, fps: 12, degPerSec: 5, acc: 2};
const GAS_L = ["L0", "L1", "L2"], STAR_L = ["S0", "S1", "S2"];
const BYTES = {gas: 256 ** 3, stars: 4 * 256 ** 3, vel: 4 * 256 ** 3};
const BG = "#05070b";
/* tune1 display defaults (integral mode), applied over the manifest's proj windows: a lower n_H floor keeps the outer
   CGM visible in wide views, and a Z floor of −2 keeps the low-metallicity inflow out of the clip (tune1.md) */
/* tune2: H I lo 16.5 (was 13.5) and O VI lo 14.0 (was 13.8), so isolated single-cell discs of the outer CGM fall into the
   soft floor instead of dominating the ion maps */
/* tune3: Z [−1.1, 0.25] (the 2–98 % range of the projected n_H-weighted mean at L0/L1; was [−2.0, 0.5]); O VI lo 13.6
   (was 14.0) so the diffuse halo is not cut into islands */
/* tune4: the ion windows follow the populated range of the projected columns (2–99.9 % at L0/L1, colpct.py): C III
   [14.0, 17.5] (was the manifest's [11.3, 18.6], 7 dex: almost uniform teal), H I [17.3, 21.5] (the disk at ≥ 20.5 now
   reaches the top of the LUT and the 17–18 halo sits low), O VI hi 15.2 (was 15.6; p99.9 of the columns is 15.2–15.3) */
const WIN_DEFAULT = {nH: {lo: 18.4}, Z: {lo: -1.1, hi: 0.25}, HI: {lo: 17.3, hi: 21.5}, OVI: {lo: 13.6, hi: 15.2}, CIII: {lo: 14.0, hi: 17.5}};
/* tune3: per-field soft floor width (dex below the window low; raymarch uFadeDex, default 1) — the ions fade out over
   more dex, so cloud edges are soft instead of a hard rim at the window low */
const FADE_DEX = {HI: 2.0, OVI: 1.5, CIII: 1.5};
const fadeDex = k => FADE_DEX[k] ?? (isIon(k) ? 1.5 : 1.0);   // Phase 3: the new ions fade like O VI / C III
/* tune3: default colour maps over the manifest's (Z: cividis was a low-contrast grey-olive on the dark stage) */
const CMAP_DEFAULT = {Z: "viridis"};
/* tune3 volume mode: kappa = VOL.k * opacity² per kpc, emitted colour × VOL.gain, default opacity VOL.opacity */
const VOL = {k: 1.6, gain: 1.8, opacity: 0.6};
/* tune3 composite (raymarch uCompMode 1): bright starlight (max channel 0.4 → 0.9) attenuates the gas layer, then the stars
   screen over it; the tune1 hue-replacement (mode 0, 0.04 → 0.45) tinted the faint envelope olive over the gas */
const STAR_COMP = {mode: 1, occ: [0.4, 0.9], floor: 0.035};   // floor: the stellar envelope fades out below it (raymarch uStarFloor)
/* tune3: thinner (was 2.5 px), and dimmed where it passes over the galaxy (see selMat) */
/* tune4: thinner and fainter again (1.25 px, α 0.6), and the fade over the galaxy is stronger and wider (to 0.15 / 0.06
   within 25 → 90 kpc of the centre), so it never outshines the disk in the default view or the presets */
const SEL_PX = 1.25, SEL_ALPHA = 0.6, SEL_GAL = {r0: 25, r1: 90, front: 0.15, back: 0.06};
/* tune2 footprint LOD (raymarch.js lodLevel): a gas level is used while its voxel spans ≥ LOD_C.gas drawing-buffer pixels,
   a star level while it spans ≥ LOD_C.stars (the star kernel floor is 1 voxel, the gas floor 2) */
/* tune3: the ions use L2 only from 4 px per voxel (was 1.5): their L1 cubes are smoothed more strongly than L2, and at
   intermediate zoom the ±25 kpc box otherwise shows as a square of finer, speckled texture inside the smoother L1 field */
/* tune4: with the lighter ion prefilter the levels carry the same texture, so the ions go back to L2 from 2 px per voxel */
/* tf3d: no gas field is prefiltered any more (SMOOTH), so the ions switch levels at the same footprint as n_H; at 2 px
   per voxel H I was drawn from the next coarser level than n_H at the same zoom, which made it look blobbier */
const LOD_C = {gas: 1.0, stars: 1.5, field: {}};
const lodField = k => (k && LOD_C.field[k]) || LOD_C.gas;
/* tune2 near fade (raymarch.js uNear), as fractions of the camera–target distance */
const NEAR = [0.35, 0.6];
/* tune2: a narrower field of view (was 40°) puts the default camera outside the r = 400 kpc data sphere at the same
   framing, so the projection is close to the orthographic column map and near cells are not magnified */
const FOV = 22;
/* tune2 star display defaults over the manifest's (Q 8, μ0 21.5): μ0 22.3 maps a 0.8 mag fainter surface brightness to
   full scale (a brighter disk), and a saturation boost of 1.3 about the channel mean */
const STAR_DEFAULT = {mu0: 22.3, sat: 1.3};
/* tune4 zoom-dependent star brightness: the effective μ0 is μ0 + dmag[0] at hVis ≤ h[0] rising to μ0 + dmag[1] at hVis ≥ h[1]
   (smoothstep), so the stellar disk reads over the bright gas core in the default ±100 kpc view and the faint thick-disk
   envelope does not swell the disk in close views; the occlusion range of the composite follows (occ → occWide) */
const STAR_ZOOM = {h: [12, 90], dmag: [-0.5, 1.5], occWide: [0.35, 0.85]};
/* fix-ui V1: in close views (hVis ≤ STAR_ZOOM.h[0]) the composite dims the gas under the stars much more (occ from a lower
   starlight level, STAR_CLOSE.occ, and the whole gas layer × STAR_CLOSE.gasW); both relax to the tune4 values in wide views */
const STAR_CLOSE = {occ: [0.06, 0.4], gasW: 0.55};
/* tune2 display prefilter of the ion cubes: [1,2,1]/4 passes per axis (σ = sqrt(passes/2) voxels), run in a worker after
   the sha256 check, so single cells with a high ion fraction read as gas rather than as separate kernel discs, and
   single star particles (young blue specks, old-star Poisson grain) as a smooth surface brightness */
/* tune3: stronger ion passes (σ ≈ 1–2.2 voxels at L1) so H I / O VI read as continuous gas rather than kernel discs, and
   one pass on the L2 n_H / T / Z cubes, which removes the trilinear creases (stair-steps) of the 0.2 kpc grid at deep zoom */
/* tune4: much lighter (the tune3 passes blurred the ion maps to 1–2 kpc mush, and the stars and the L2 gas out of focus):
   ions 1 pass per level (O VI 2/4/2: its cell-to-cell ion-fraction scatter reads as pebbles otherwise), no pass on n_H / T / Z (the half-voxel steps and the 8-frame accumulation already
   remove the L2 creases), stars 2/2/1 (S2: σ 0.7 voxel removes the single-particle grain and keeps the thin disk; S0/S1 carry only the diffuse
   envelope and halo along the line of sight, where 2 passes remove the blocky mottling of their 0.8–3 kpc voxels) */
/* tf (H I check): every gas field is drawn raw, at the deposited resolution, like n_H. The ion passes widened each sub-voxel
   cloud from the 2 Δ deposit kernel (σ 0.55 voxel) to σ 0.89 voxel, merged the H I islands of the L0 face-on map from 143
   to 81 and moved the columns by a median 0.16 dex; the 2 Δ deposit floor already keeps the footprints round, so raw shows
   no tiles. Only the star cubes keep their passes (single-particle grain) */
const SMOOTH = {stars: [2, 2, 1]};   // passes per level 0, 1, 2 (stars: S0-S2, RGB); gas fields: none
const smoothPasses = k => SMOOTH[k] || null;
let smoothW = null, smoothN = 0; const smoothP = new Map();
function smoothAsync(q, n, vmin, vmax, passes, ch = 1) {
  try { if (!smoothW) { smoothW = new Worker(new URL("./smooth_worker.js", import.meta.url), {type: "module"});
      smoothW.onmessage = ev => { const p = smoothP.get(ev.data.id); smoothP.delete(ev.data.id); if (p) ev.data.error ? p[1](new Error(ev.data.error)) : p[0](ev.data.q); };
      smoothW.onerror = () => { for (const [, p] of smoothP) p[1](new Error("smoothing worker failed")); smoothP.clear(); smoothW = null; }; }
    const id = ++smoothN; return new Promise((res, rej) => { smoothP.set(id, [res, rej]); smoothW.postMessage({id, q, n, vmin, vmax, passes, ch}, [q.buffer]); });
  } catch { return Promise.resolve(q); } }   // fix-ui FE-10: no worker -> show the cube unsmoothed rather than block the main thread for seconds

export function webgl2Available() {
  try { const c = document.createElement("canvas"); return !!(globalThis.WebGL2RenderingContext && c.getContext("webgl2")); } catch { return false; }
}

const CSS = `.v3d{position:relative;width:100%;height:100%;min-width:0;
  --s-panel:#0c1016;--s-ink:#e9eef4;--s-ink2:#b3bdc9;--s-rule:#2f3844;--s-accent:#7db2f0;--s-fit:#f39a5c;--s-bad:#ff8a8a;--lib-line:#8d97a6;
  --s-mat:color-mix(in srgb,#0c1016 74%,transparent);--s-blur:blur(24px) saturate(1.5);--s-edge:rgba(200,215,240,.16);--s-hi:inset 0 1px 0 rgba(255,255,255,.10)}
.v3d-stage{position:relative;width:100%;height:100%;touch-action:none;color-scheme:dark;background:${BG};color:var(--s-ink);overflow:hidden}
.v3d-stage canvas{display:block;width:100%;height:100%;outline:none}
.v3d-stage canvas:focus-visible{outline:2px solid var(--s-accent);outline-offset:-2px}
#v3d-stage{position:relative}
#v3d-stage .v3d:not(.v3d-thumb):not(.v3d-fs){position:absolute;inset:0}
.v3d-ov{position:absolute;font-size:12.5px;color:var(--s-ink2);pointer-events:none;background:var(--s-mat);border-radius:var(--r-s,10px);
  box-shadow:inset 0 0 0 1px var(--s-edge),var(--s-hi),0 6px 20px rgba(0,0,0,.30);backdrop-filter:var(--s-blur);-webkit-backdrop-filter:var(--s-blur)}
.v3d-msg{left:12px;top:10px;max-width:min(560px,calc(100% - 24px));padding:4px 8px;overflow-wrap:anywhere;color:var(--s-ink)}
.v3d-msg:empty{display:none}.v3d-msg.bad{color:var(--s-bad);background:${BG};z-index:2}.v3d-msg small{display:block;color:var(--s-ink2);font:11px var(--mono,ui-monospace,monospace)}
.v3d-tr{position:absolute;right:10px;top:10px;display:none;gap:6px;z-index:3}
.v3d-tr button{background:linear-gradient(180deg,rgba(255,255,255,.10),rgba(255,255,255,0) 70%),var(--s-mat);color:var(--s-ink);border:1px solid var(--s-edge);border-radius:var(--r-s,10px);font-size:12.5px;padding:4px 10px;cursor:pointer;
  box-shadow:var(--s-hi),0 4px 14px rgba(0,0,0,.28);backdrop-filter:var(--s-blur);-webkit-backdrop-filter:var(--s-blur)}
.v3d-tr button:hover{background:linear-gradient(180deg,rgba(255,255,255,.16),rgba(255,255,255,.04)),var(--s-mat)}
.v3d-tr button:active{background:var(--s-mat);box-shadow:inset 0 1px 2px rgba(0,0,0,.35)}
.v3d-tr button:focus-visible{outline:2px solid var(--s-accent);outline-offset:1px}
.v3d:fullscreen .v3d-tr,.v3d.v3d-fs .v3d-tr{display:flex}
/* final: no focus ring from the viewer's own programmatic focus (entering / leaving fullscreen); Tab or a pointer brings it back */
.v3d.v3d-pf .v3d-stage canvas:focus-visible,.v3d.v3d-pf .v3d-tr button:focus-visible,.v3d.v3d-pf #v3-fs:focus-visible{outline:none}
.v3d-leg{left:12px;bottom:10px;width:min(280px,58%);font:11px var(--mono,ui-monospace,monospace);padding:5px 8px}
.v3d-leg .bar{height:10px;border-radius:2px;border:1px solid var(--s-rule)}
.v3d-leg .ticks{position:relative;height:14px}.v3d-leg .ticks span{position:absolute;transform:translateX(-50%);top:1px}
.v3d-leg .ttl{font:500 11.5px var(--sans,system-ui,sans-serif);color:var(--s-ink);margin-bottom:3px}
.v3d-leg .st{margin-top:4px;font:11px var(--sans,system-ui,sans-serif)}.v3d-leg .st i{display:inline-block;width:46px;height:8px;border-radius:2px;vertical-align:middle;margin-right:6px;background:linear-gradient(90deg,#4d6fd0,#fff4e6,#ffb347)}
.v3d-lines{right:10px;bottom:48px;display:flex;flex-direction:column;gap:2px;font-size:11.5px;padding:4px 8px}
.v3d-lines i{display:inline-block;width:20px;height:0;border-top:2px solid;vertical-align:middle;margin-right:5px}
.v3d-lines i.sel{border-top-width:5px;outline:1px dashed var(--s-ink);outline-offset:2px}
.v3d-scale{left:50%;bottom:12px;transform:translateX(-50%);font:11px var(--mono,ui-monospace,monospace);text-align:center;padding:3px 8px}
.v3d-scale i{display:block;height:6px;border:1.5px solid var(--s-ink2);border-top:0;margin:0 auto 2px}
/* vel3d: the words at the two ends of a diverging velocity bar */
.v3d-leg .ends{display:flex;justify-content:space-between;gap:8px;font:11px var(--sans,system-ui,sans-serif);color:var(--s-ink2);margin-top:1px}
.v3d-leg .ends[hidden]{display:none}
.v3d-leg .off{margin-top:4px;font:11px var(--sans,system-ui,sans-serif);color:var(--s-ink2)}
.v3d-leg .gd{margin-top:4px;font:11px var(--sans,system-ui,sans-serif);color:var(--s-ink2)}.v3d-leg .gd i{display:inline-block;width:18px;height:0;border-top:2px solid #d9c38c;vertical-align:middle;margin-right:6px}
.v3d-tt{display:none}
/* credits ID badge: bottom-right of the full stage (the bottom-right lines key moves up above it); stacked in a narrow stage */
.v3d-id{position:absolute;right:10px;bottom:10px;z-index:3;display:inline-flex;align-items:baseline;gap:8px;padding:5px 10px;cursor:pointer;
  font:500 12px/1.25 var(--sans,system-ui,sans-serif);color:var(--s-ink);border:1px solid var(--s-edge);border-radius:var(--r-s,10px);
  background:linear-gradient(180deg,rgba(255,255,255,.10),rgba(255,255,255,0) 70%),var(--s-mat);box-shadow:var(--s-hi),0 4px 14px rgba(0,0,0,.28);
  backdrop-filter:var(--s-blur);-webkit-backdrop-filter:var(--s-blur)}
.v3d-id[hidden]{display:none}
.v3d-id .s,.v3d-id .z{color:var(--s-ink2);font-weight:400}
.v3d-id .g{font-family:var(--mono,ui-monospace,monospace);font-size:11.5px}
.v3d-id:hover{background:linear-gradient(180deg,rgba(255,255,255,.16),rgba(255,255,255,.04)),var(--s-mat)}
.v3d-id:focus-visible{outline:2px solid var(--s-accent);outline-offset:2px}
.v3d-thumb .v3d-id,.v3d:fullscreen .v3d-id,.v3d.v3d-fs .v3d-id{display:none}   /* the credits dialog lives outside a fullscreen stage */
/* Phase 3 thumbnail (mountThumb): the canvas fills the host, no overlays but a field tag and a 3D tag */
.v3d.v3d-thumb{position:absolute;inset:0;border-radius:inherit;overflow:hidden}
.v3d-thumb .v3d-stage{cursor:pointer;touch-action:auto;border-radius:inherit}
.v3d-thumb .v3d-tr,.v3d-thumb .v3d-leg,.v3d-thumb .v3d-lines,.v3d-thumb .v3d-scale{display:none}
.v3d-thumb .v3d-msg{left:8px;top:8px;max-width:calc(100% - 16px);font-size:10.5px;padding:3px 6px}.v3d-thumb .v3d-msg small{display:none}
.v3d-thumb .v3d-tt{display:flex;position:absolute;left:10px;right:10px;bottom:10px;justify-content:space-between;align-items:center;pointer-events:none;font:500 10.5px var(--mono,ui-monospace,monospace)}
.v3d-tt span{background:rgba(8,10,18,.58);backdrop-filter:blur(14px) saturate(1.5);-webkit-backdrop-filter:blur(14px) saturate(1.5);padding:3px 8px;border-radius:7px;color:#f1ecff;box-shadow:inset 0 0 0 1px var(--s-edge),var(--s-hi)}
.v3d-tt span:empty{display:none}
.v3d-notags .v3d-tt{display:none!important}
/* the layout the viewer builds when the page gives no square #v3d-stage (§6.2 C13: square, a fraction of the width, centred,
   controls beside it at ≥ 1024 px and below it otherwise) */
.v3d-layout{display:flex;justify-content:center;align-items:flex-start;gap:16px;padding:12px 0;min-width:0}
.v3d-layout>.v3d-sq{position:relative;flex:none;aspect-ratio:1/1;width:min(calc(60 * var(--vw, 1vw)),calc(calc(100 * var(--vh, 1vh)) - 120px),900px);width:min(calc(60 * var(--vw, 1vw)),calc(calc(100 * var(--vh, 1vh)) - 120px),900px);border-radius:var(--r-m,16px);overflow:hidden;
  border:var(--mat-edge,1px solid var(--gline,rgba(160,175,220,.14)));background:${BG};box-shadow:var(--mat-shadow,0 18px 50px rgba(0,0,0,.4))}
.v3d-layout>.v3d-side{width:300px;flex:none;min-width:0}
@media (max-width:1023px){.v3d-layout{flex-direction:column;align-items:center}.v3d-layout>.v3d-sq{width:min(100%,calc(calc(100 * var(--vh, 1vh)) - 140px),900px);width:min(100%,calc(calc(100 * var(--vh, 1vh)) - 140px),900px)}
  .v3d-layout>.v3d-side{width:min(100%,560px)}}
/* the grouped control column (B look, A's explicit labels); page tokens with dark fallbacks */
.v3c{display:flex;flex-direction:column;gap:12px;min-width:0;font:13px/1.4 var(--sans,system-ui,sans-serif);color:var(--ink,#eef0f7)}
.v3c[hidden]{display:none}
.v3c{--cg-hi:var(--mat-highlight,inset 0 1px 0 rgba(255,255,255,.12));--cg-thin:var(--mat-thin,rgba(127,127,160,.10));--cg-edge:var(--mat-edge-c,var(--gline,rgba(160,175,220,.14)));
  --cg-sheen:var(--mat-fill,linear-gradient(180deg,rgba(255,255,255,.09),rgba(255,255,255,0) 70%));--cg-sheen-h:var(--mat-fill-hover,linear-gradient(180deg,rgba(255,255,255,.16),rgba(255,255,255,.04)));
  --cg-press:var(--mat-press,linear-gradient(180deg,rgba(0,0,0,.14),rgba(0,0,0,.06)));--cg-gloss:var(--mat-gloss,linear-gradient(180deg,rgba(255,255,255,.24),rgba(255,255,255,0) 55%));
  --cg-tint:var(--mat-tint,rgba(127,127,160,.08));--cg-well:var(--mat-well,rgba(127,127,160,.12));--cg-raised:var(--mat-raised,var(--glass2,rgba(30,36,56,.72)))}
.v3c-card{background:var(--mat-regular,var(--glass,rgba(22,27,42,.62)));border:1px solid var(--cg-edge);border-radius:var(--r-m,16px);padding:11px 12px 12px;
  box-shadow:var(--cg-hi),var(--mat-shadow-s,0 1px 2px rgba(0,0,0,.18));
  backdrop-filter:var(--mat-blur-regular,blur(24px) saturate(1.8));-webkit-backdrop-filter:var(--mat-blur-regular,blur(24px) saturate(1.8));min-width:0}
.v3c-card>h2{margin:0 0 9px;font:500 10px var(--mono,ui-monospace,monospace);letter-spacing:.14em;text-transform:uppercase;color:var(--muted,#98a0b8)}
.v3c .k{display:block;font:500 10px var(--mono,ui-monospace,monospace);color:var(--faint,#7a83a0);margin:2px 0 5px}
.v3c-seg{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));padding:3px;border-radius:var(--r-s,10px);background:var(--cg-well);box-shadow:inset 0 0 0 1px var(--cg-edge),inset 0 1px 2px rgba(0,0,0,.12);gap:2px;margin-bottom:8px}
.v3c-seg.two{grid-template-columns:1fr 1fr}
.v3c-seg label,.v3c-ions label{position:relative;cursor:pointer;min-width:0}
.v3c-seg input,.v3c-ions input{position:absolute;opacity:0;inset:0;margin:0;cursor:inherit}
.v3c-seg span{display:flex;align-items:center;justify-content:center;height:26px;padding:0 8px;font:500 11.5px var(--mono,ui-monospace,monospace);color:var(--muted,#98a0b8);border-radius:7px;white-space:nowrap}
.v3c-seg label:hover input:not(:checked):not(:disabled)+span{background:var(--cg-tint)}
.v3c-seg input:checked+span{background:var(--cg-raised);color:var(--ink,#eef0f7);box-shadow:var(--cg-hi),inset 0 0 0 1px var(--accent,#8fa8ff),0 2px 8px rgba(0,0,0,.18)}
.v3c-ions{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:4px;margin-bottom:8px}
.v3c-ion{--c:var(--icd)}
@media (prefers-color-scheme:light){:root:not([data-theme="dark"]) .v3c-ion{--c:var(--ic)}}
:root[data-theme="light"] .v3c-ion{--c:var(--ic)}
.v3d .v3c-ion{--c:var(--icd)}
.v3c-ions span{display:flex;align-items:center;gap:6px;height:28px;padding:0 7px;border:1px solid var(--cg-edge);border-radius:8px;font-size:11.5px;white-space:nowrap;overflow:hidden;background:var(--cg-tint);box-shadow:var(--cg-hi)}
.v3c-ions i{width:8px;height:8px;border-radius:50%;background:var(--c);flex:none}
.v3c-ions input:checked+span{border-color:var(--c);background:linear-gradient(var(--hl,rgba(143,168,255,.16)),var(--hl,rgba(143,168,255,.16))),var(--cg-raised)}
.v3c-ions input:disabled+span,.v3c-seg input:disabled+span{opacity:.42;cursor:not-allowed}
.v3c-ions input:disabled+span i{background:none;border:1px solid var(--c)}
.v3c-ions label:has(input:disabled),.v3c-seg label:has(input:disabled){cursor:not-allowed}
.v3c-seg input:focus-visible+span,.v3c-ions input:focus-visible+span{outline:2px solid var(--accent,#8fa8ff);outline-offset:1px}
.v3c-row[hidden]{display:none}
.v3c-seg.vel{grid-template-columns:repeat(5,minmax(0,1fr))}.v3c-seg.vel span{padding:0 2px}
.v3c-seg.vel span{display:block;text-align:center;line-height:26px}.v3c-seg.vel sub{font-size:.8em;line-height:0;vertical-align:-.3em}
.v3c-row{display:grid;grid-template-columns:62px minmax(0,1fr) 44px;align-items:center;gap:8px;min-height:26px}
.v3c-row>label,.v3c-row>.lab{font:500 11px var(--mono,ui-monospace,monospace);color:var(--muted,#98a0b8);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.v3c-row output{font:500 11px var(--mono,ui-monospace,monospace);text-align:right;color:var(--ink,#eef0f7)}
.v3c-row input[type=range]{width:100%;min-width:0;margin:0}
.v3c-row select{grid-column:2/4;min-width:0;width:100%;height:28px;border:1px solid var(--cg-edge);border-radius:8px;background-color:var(--cg-well);color:inherit;font:inherit;font-size:12px;padding:0 6px}
.v3c-row input[type=checkbox]{margin:0 6px 0 0;vertical-align:middle}
.v3c-btns{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:5px}
.v3c-btn{height:30px;border:1px solid var(--bline,var(--cg-edge));background:var(--cg-sheen),var(--cg-thin);box-shadow:var(--cg-hi),var(--mat-shadow-s,0 1px 2px rgba(0,0,0,.12));border-radius:8px;cursor:pointer;font:inherit;font-size:12px;color:var(--muted,#98a0b8);padding:0 4px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.v3c-btn:hover{background:var(--cg-sheen-h),var(--cg-thin);color:var(--ink,#eef0f7)}
.v3c-btn:active,.v3c #picker-root button:active:not(:disabled){background:var(--cg-press),var(--cg-thin);box-shadow:inset 0 1px 2px rgba(0,0,0,.18)}
.v3c-btn:focus-visible{outline:2px solid var(--accent,#8fa8ff);outline-offset:1px}
.v3c-btn[aria-pressed=true]{background:linear-gradient(var(--hl,rgba(143,168,255,.16)),var(--hl,rgba(143,168,255,.16))),var(--cg-sheen),var(--cg-thin);border-color:var(--accent,#8fa8ff);color:var(--ink,#eef0f7)}
.v3c-wide{display:flex;align-items:center;justify-content:center;gap:7px;width:100%;margin-top:6px}
.v3c-wide svg{width:14px;height:14px;flex:none}
.v3c-sw{display:flex;flex-wrap:wrap;gap:4px 14px;margin-top:6px;font-size:12px;color:var(--muted,#98a0b8)}
.v3c-sw label{display:inline-flex;align-items:center;gap:6px;cursor:pointer}.v3c-sw input{margin:0}
.v3c details{margin-top:2px}.v3c summary{cursor:pointer;font:500 11px var(--mono,ui-monospace,monospace);color:var(--muted,#98a0b8);padding:3px 0}
.v3c-lod{font:10.5px/1.45 var(--mono,ui-monospace,monospace);color:var(--muted,#98a0b8);white-space:pre-line;overflow-wrap:anywhere;padding:0 4px}
.v3c-lod:empty{display:none}
.v3tf[hidden]{display:none}.v3tf-plot{margin:2px 0 8px;min-width:0}
.v3tf-plot canvas{display:block;width:100%;height:104px;border-radius:8px;background:var(--cg-well);box-shadow:inset 0 0 0 1px var(--cg-edge);cursor:crosshair;touch-action:none}
.v3tf-plot canvas:focus-visible{outline:2px solid var(--accent,#8fa8ff);outline-offset:1px}
.v3tf-ax{display:flex;justify-content:space-between;gap:6px;margin-top:2px;font:10.5px var(--mono,ui-monospace,monospace);color:var(--faint,#7a83a0)}
.v3tf-ax .u{color:var(--muted,#98a0b8);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.v3tf-bands{display:grid;grid-template-columns:30px repeat(3,minmax(0,1fr));gap:5px;margin:6px 0 4px}
.v3tf-bands input[type=color]{width:30px;height:30px;padding:2px;border:1px solid var(--cg-edge);border-radius:8px;background:var(--cg-well);cursor:pointer}
.v3tf-bands input[type=color]:disabled,.v3tf .v3c-btn:disabled,.v3tf input[type=range]:disabled,.v3c-row input[type=range]:disabled,.v3c-row select:disabled{opacity:.42;cursor:not-allowed}
.v3tf .v3c-row>label .gam{font:italic 13px/1 Georgia,"Times New Roman",serif}
.v3tf #v3-tf-g-o{white-space:nowrap;font-size:10px}
.v3tf-g{display:grid;grid-template-columns:1fr 1fr;gap:6px;min-width:0}.v3tf-g input{width:100%;min-width:0;margin:0}
/* ux4 pivot: View card "centre" row (galaxy | ray) and the kpc expander (x y z go) */
.v3c-pvrow{margin-top:8px}.v3c-pvrow>.v3c-pvb{grid-column:2/4;grid-template-columns:1fr 1fr}
.v3c-pvxyz{grid-template-columns:repeat(3,minmax(0,1fr)) 44px;margin-top:4px}
.v3c-pvxyz input{height:28px;border:1px solid var(--cg-edge);border-radius:8px;background:var(--cg-well);color:inherit;font:12px var(--mono,ui-monospace,monospace);padding:0 6px}
.v3c-pvxyz input:focus-visible{outline:2px solid var(--accent,#8fa8ff);outline-offset:1px}
.v3c #picker-root .pk{margin:0}
.v3c #picker-root button{height:28px;border:1px solid var(--bline,var(--cg-edge));background:var(--cg-sheen),var(--cg-thin);box-shadow:var(--cg-hi),var(--mat-shadow-s,0 1px 2px rgba(0,0,0,.12));border-radius:8px;padding:0 9px;cursor:pointer;color:var(--ink,#eef0f7);font:inherit;font-size:12px}
.v3c #picker-root button:hover:not(:disabled){background:var(--cg-sheen-h),var(--cg-thin)}
.v3c #picker-root button[aria-pressed=true]{border-color:var(--accent,#8fa8ff);background:linear-gradient(var(--hl,rgba(143,168,255,.16)),var(--hl,rgba(143,168,255,.16))),var(--cg-sheen),var(--cg-thin)}
.v3c #picker-root button.primary{background:var(--cg-gloss),var(--accent,#8fa8ff);border-color:var(--accent,#8fa8ff);color:var(--accent-ink,#0a0d18);font-weight:600;
  box-shadow:inset 0 1px 0 rgba(255,255,255,.35),0 4px 14px -4px var(--accent-glow,rgba(110,140,255,.45))}
.v3c #picker-root button.primary:hover:not(:disabled){filter:brightness(1.08);background:var(--cg-gloss),var(--accent,#8fa8ff)}.v3c #picker-root button:disabled{opacity:.5;cursor:not-allowed}
.v3c #picker-root input[type=number]{height:26px;border:1px solid var(--cg-edge);background:var(--cg-well);border-radius:7px;padding:0 5px;color:inherit;font:inherit;font-size:12px}
.v3c #picker-root .row{display:flex;flex-wrap:wrap;gap:5px;margin-bottom:6px}
.v3c #picker-root .pk-xyz{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:4px}
.v3c #picker-root .pk-in{display:flex;align-items:center;gap:4px;min-width:0}.v3c #picker-root .pk-in input{width:100%;min-width:0}
.v3c #picker-root fieldset{border:0;margin:0 0 6px;padding:0;min-width:0}.v3c #picker-root legend{font:500 10px var(--mono,ui-monospace,monospace);color:var(--faint,#7a83a0);padding:0;margin-bottom:3px}
.v3c #picker-root .hint,.v3c #picker-root .msg{font-size:11.5px;color:var(--muted,#98a0b8);margin:4px 0}
/* fullscreen: the control column moves onto the stage as a closable panel (dark, whatever the page theme) */
.v3d:fullscreen{position:fixed;inset:0;z-index:1000;background:${BG};width:calc(100 * var(--vw, 1vw));height:calc(100 * var(--vh, 1vh))}
/* fix-ui FE-08: the CSS fallback (iPhone Safari has no element Fullscreen API) uses the dynamic viewport */
.v3d.v3d-fs{position:fixed;inset:0;z-index:1000;background:${BG};width:auto;height:calc(100 * var(--vh, 1vh));height:calc(100dvh / var(--uiz, 1))}
.v3d .v3c{position:absolute;top:52px;right:10px;bottom:10px;width:min(340px,calc(90 * var(--vw, 1vw)));overflow:auto;z-index:2;padding:10px;border:1px solid var(--s-edge);border-radius:var(--r-l,22px);
  background:color-mix(in srgb,#0c1016 80%,transparent);backdrop-filter:blur(40px) saturate(1.6);-webkit-backdrop-filter:blur(40px) saturate(1.6);box-shadow:var(--s-hi),0 24px 60px rgba(0,0,0,.5);
  color-scheme:dark;--ink:#eef0f7;--muted:#98a0b8;--faint:#7a83a0;--gline:rgba(160,175,220,.16);
  --glass:rgba(22,27,42,.7);--glass2:rgba(40,46,70,.9);--hl:rgba(143,168,255,.16);--accent:#8fa8ff;--accent-ink:#0a0d18;color:var(--ink);
  --bline:rgba(175,190,235,.30);--accent-glow:rgba(110,140,255,.45);--cg-thin:rgba(40,47,72,.40);--cg-edge:rgba(200,215,240,.14);--cg-hi:inset 0 1px 0 rgba(255,255,255,.08);
  --cg-sheen:linear-gradient(180deg,rgba(255,255,255,.11),rgba(255,255,255,.035));--cg-sheen-h:linear-gradient(180deg,rgba(255,255,255,.18),rgba(255,255,255,.07));
  --cg-press:linear-gradient(180deg,rgba(0,0,0,.26),rgba(0,0,0,.16));--cg-tint:rgba(255,255,255,.045);--cg-well:rgba(0,0,0,.26);--cg-raised:rgba(255,255,255,.13)}
/* nested glass inside the fullscreen panel: tint and edge only, no second backdrop blur */
.v3d .v3c-card{background:var(--cg-tint);box-shadow:var(--cg-hi);backdrop-filter:none;-webkit-backdrop-filter:none}
.v3d:fullscreen .v3d-lines,.v3d.v3d-fs .v3d-lines{right:auto;left:12px;bottom:auto;top:52px}
body.v3d-noscroll{overflow:hidden}
.v3d-sr{position:absolute;width:1px;height:1px;margin:-1px;padding:0;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap;border:0}
/* Phase 3: the stage is a square fraction of the page (614 px at a 1024 px viewport), so the narrow-stage rule keys on the
   stage width too: under 720 px of stage the scale bar leaves the bottom row it would share with the colour bar */
.v3d{container-type:inline-size}
@container (max-width:719px){.v3d-scale{left:12px;top:12px;bottom:auto;transform:none}.v3d-msg{top:48px}
  .v3d-id{flex-direction:column;align-items:flex-end;gap:0;padding:4px 8px;font-size:11px}.v3d-id .g{font-size:11px}.v3d-lines{bottom:72px}}
@container (max-width:479px){.v3d .v3d-leg{width:min(220px,calc(100% - 150px))}}   /* phones: the colour key stops 12 px short of the ID badge */
@media (max-width:720px){.v3d-lines{display:none}.v3d-msg{max-width:calc(100% - 24px);top:48px}.v3d-leg{width:min(220px,62%)}
  /* tune3: the scale bar moves to the top-left corner on narrow screens, so it never shares a row with the colour bar */
  .v3d-scale{left:12px;top:12px;bottom:auto;transform:none}
  /* fix-ui V9: in fullscreen with the settings panel open, the panel is opaque and the colour bar under it is hidden */
  .v3d.v3d-panel .v3c{background:#0c1016}.v3d.v3d-panel .v3d-leg{visibility:hidden}}
/* glass fallbacks: no backdrop blur or reduced transparency -> near-opaque fills; more contrast -> stronger edges */
@supports not ((backdrop-filter:blur(1px)) or (-webkit-backdrop-filter:blur(1px))){.v3d{--s-mat:color-mix(in srgb,#0c1016 90%,transparent)}.v3c-card{background:var(--mat-regular-o,var(--glass2,rgba(30,36,56,.94)))}.v3d .v3c{background:#0c1016}}
@media (prefers-reduced-transparency:reduce){.v3d{--s-mat:color-mix(in srgb,#0c1016 92%,transparent);--s-blur:none}.v3c-card{background:var(--mat-regular-o,var(--glass2,rgba(30,36,56,.94)));backdrop-filter:none;-webkit-backdrop-filter:none}
  .v3d .v3c{background:#0c1016;backdrop-filter:none;-webkit-backdrop-filter:none}.v3d-tt span{background:rgba(8,10,18,.9);backdrop-filter:none;-webkit-backdrop-filter:none}}
@media (prefers-contrast:more){.v3d{--s-edge:rgba(220,230,250,.5)}.v3c{--cg-edge:var(--mat-edge-hc,var(--muted,#98a0b8))}}`;

const pretty = u => String(u || "").replace("cm^-3", "cm⁻³").replace("cm^-2", "cm⁻²").replace("Zsun", "Z☉");
const isMobile = () => matchMedia("(max-width: 720px)").matches;
const reduced = () => matchMedia("(prefers-reduced-motion: reduce)").matches;
const median = a => { const s = [...a].sort((x, y) => x - y); return s.length ? s[s.length >> 1] : NaN; };
const mb = b => (b / 1e6).toFixed(b > 1e7 ? 0 : 1) + " MB";

function stub(msg, frame) {
  const no = () => {}, made = [];
  const note = (host, text, cls) => { const p = document.createElement("p"); p.className = cls; p.textContent = text; host.appendChild(p); made.push(p); return p; };
  const v = {webgl2: false, message: msg, frame, hooks: {}, setSpecies: async () => false, setPreset: () => false, setTransfer: no, setLines: no, select: no,
    refreshLines: no, resize: no, render: no, setMode: () => false, setStars: no, setGuides: no, toggleFullscreen: async () => false, dock: () => false, docked: null,
    levels: () => ({gas: {}, stars: {}}), gpuBytes: () => 0, stats: {},
    _attachFull(root) { const p = note(root, msg, "msg bad v3d-fallback"); p.style.padding = "18px 14px"; },
    _attachThumb(host) { const p = note(host, "3D needs WebGL2", "v3d-fallback"); p.style.cssText = "margin:0;padding:10px;font:11px var(--mono,monospace);opacity:.7";
      return {viewer: v, host, active: false, setSpin: no, dispose: () => p.remove()}; },
    _start: async () => false,
    dispose() { made.forEach(p => p.remove()); ENGINE = null; }};
  return v;
}

let ENGINE = null;   // Promise<viewer>: the one engine of this page (see the API note at the top)
export function current() { return ENGINE; }
function engine(app, opts) { if (!ENGINE) ENGINE = create(app, opts).catch(x => { ENGINE = null; throw x; }); return ENGINE; }
export async function mount(root, app, opts = {}) {
  initTips(); const v = await engine(app, opts); v._attachFull(root, opts); await v._start(opts.species); return v;
}
export async function mountThumb(host, app, opts = {}) {
  const v = await engine(app, opts), t = v._attachThumb(host, opts); v._start(opts.species).catch(() => {}); return t;
}

async function create(app, opts = {}) {
  if (!document.getElementById("v3d-css")) { const st = document.createElement("style"); st.id = "v3d-css"; st.textContent = CSS; document.head.appendChild(st); }
  const cfg = app.config || {}, G = cfg.galaxy || {}, F0 = cfg.frame || {};
  const viz = opts.viz === undefined ? (cfg.viz ?? null) : opts.viz;
  const frame = {Lhat: F0.Lhat || G.Lhat, xhat: F0.xhat || G.xhat, yhat: F0.yhat || G.yhat, R200c: F0.R200c_kpc || G.R200c_kpc || 246.35};
  if (!(opts.webgl2 ?? webgl2Available()))
    return stub("3D view needs WebGL2, which this browser does not provide. The Spectra tab and the numeric ray form still work.", frame);
  let T, OrbitControls;
  try { T = await import("three"); ({OrbitControls} = await import("three/addons/controls/OrbitControls.js")); }
  catch (x) { return stub(`Could not load three.js ${cfg.three || ""} from cdn.jsdelivr.net (${x.message}). The Spectra tab and the numeric ray form still work.`, frame); }
  /* final: the manifest fetch has a timeout (vizload fetchText); a ?viz= override host that times out or refuses is reported
     as unreachable at once, instead of falling through to the committed manifest and then stalling on every cube */
  let manifest = opts.manifest || null, manErr = null, hostDown = null;
  if (viz && !manifest) {
    for (const u of [viz.manifest_override, viz.manifest_url].filter(Boolean)) {
      try { manifest = await loadManifestV2(new URL(u, location.href).href, {fetchText, timeoutMs: opts.manifestTimeoutMs ?? 10000}); manErr = null; break; }
      catch (x) { manErr ||= x.message;
        if (u === viz.manifest_override && x.network) { try { hostDown = new URL(u, location.href).host; } catch { hostDown = "the data host"; } break; } } } }
  if (manifest?.galaxy) { for (const k of ["Lhat", "xhat", "yhat"]) if (manifest.galaxy[k]) frame[k] = manifest.galaxy[k]; if (manifest.galaxy.R200c_kpc) frame.R200c = manifest.galaxy.R200c_kpc; }
  frame.Lhat ||= [0, 0, 1]; frame.xhat ||= [1, 0, 0]; frame.yhat ||= [0, 1, 0];
  const V3 = a => new T.Vector3(a[0], a[1], a[2]);
  const Lv = V3(frame.Lhat).normalize(), Xv = V3(frame.xhat).normalize(), Yv = V3(frame.yhat).normalize();
  T.ColorManagement.enabled = false;                       // LUT and CSS colours are sRGB values: pass them straight through
  const mobile = isMobile(), deviceMemory = navigator.deviceMemory ?? 8;

  /* ---- DOM: the stage (el, moved between the full host and the thumbnail) and the control column (ctlBox) ---- */
  const SPEC = [...speciesList(cfg.ions, manifest), ...velocityList(manifest)], specOf = k => SPEC.find(x => x.key === k);
  const VELI = velocityInfo(manifest);   // vel3d: null with an old manifest (the Velocity buttons are then disabled)
  { const vc = document.getElementById("methods-vcap"); if (vc && VELI?.V) vc.textContent = `±${Math.round(VELI.V)} km/s`; }   // the methods text names the clip from the manifest
  const el = document.createElement("div"); el.className = "v3d";
  el.innerHTML = `<div class="v3d-stage"><canvas tabindex="0" role="img" aria-label="3D view"></canvas>
    <div class="v3d-ov v3d-msg"></div><div class="v3d-sr" id="v3-live" role="status" aria-live="polite"></div>
    <button type="button" class="v3d-orb" id="v3-orbit" aria-pressed="false" aria-label="Orbit" data-tip="Slowly turn the view about the disk axis (O)"><svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" aria-hidden="true"><path d="M13.5 8A5.5 5.5 0 1 1 8 2.5"/><path d="M8 .8 10.2 2.5 8 4.2"/></svg><span>orbit</span></button>
    <button type="button" class="v3d-pv" id="v3-pivot" hidden aria-label="Re-centre on the galaxy" data-tip="Orbit centre moved; return to the galaxy (C)"><svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true"><circle cx="8" cy="8" r="2.2"/><path d="M8 1.5v3M8 11.5v3M1.5 8h3M11.5 8h3"/></svg><span>re-centre</span></button>
    <div class="v3d-tr"><button type="button" id="v3-ctl-toggle" aria-expanded="true" aria-controls="v3-ctl" data-tip="Show or hide the 3D settings">Controls</button><button type="button" id="v3-fs-exit" data-tip="Back to the page (Esc)">Exit fullscreen</button></div>
    <div class="v3d-ov v3d-scale" aria-hidden="true"><i></i><span>100 kpc</span></div>
    <div class="v3d-ov v3d-leg" hidden><div class="ttl"></div><div class="bar"></div><div class="ticks"></div><div class="ends" hidden><span></span><span></span></div><div class="st" hidden><i></i><span></span></div><div class="off" hidden>stars off (Layers)</div><div class="gd" hidden></div></div>
    <div class="v3d-ov v3d-lines" aria-hidden="true"><span><i style="border-color:var(--lib-line)"></i>library</span><span><i style="border-color:var(--s-accent)"></i>generated</span><span><i style="border-color:var(--s-fit)"></i>custom</span><span><i class="sel" style="border-color:var(--s-ink)"></i>selected</span></div>
    <div class="v3d-tt" aria-hidden="true"><span class="f"></span><span>3D</span></div>
    <button type="button" class="v3d-id" id="v3-id" data-testid="v3d-id" aria-controls="pop-licence" aria-expanded="false" aria-haspopup="dialog" data-tip="Data and credits" hidden><span class="s"></span><span class="g"></span><span class="z"></span></button></div>`;
  const escH = t => String(t).replace(/[&<>"]/g, c => ({"&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;"})[c]);
  /* tips: one line per field button; speciesUnits() adds what is drawn and its unit, a disabled button gives the reason */
  const GAS_TIP = {nH: "Hydrogen number density nH", T: "Gas temperature, nH-weighted", Z: "Gas metallicity, nH-weighted"};
  const GAS_COL = {nH: "Hydrogen column density N_H", T: "nH-weighted mean temperature along each ray", Z: "nH-weighted mean metallicity along each ray"};
  const VEL_TIP = {vlos: "Velocity along the camera ray; positive recedes from you",
    vr: "Radial velocity about the galaxy centre; positive is outflow",
    vphi: "Rotation about the disk normal; positive co-rotates with the disk",
    vmag: "Speed of the mean gas velocity in each voxel",
    sigmalos: "Velocity spread between voxels along the ray, no thermal motion"};
  const fieldTip = (x, m, u) => { if (!x.available) return x.reason || "not available";
    if (x.group === "vel") return VEL_TIP[x.key] || x.long;
    const gas = x.group === "gas";
    if (!u) return gas ? GAS_TIP[x.key] || x.long : `${x.label} ions`;
    const name = m === "integral" ? (gas ? GAS_COL[x.key] || x.long : `${x.label} column density`) : (gas ? GAS_TIP[x.key] || x.long : `${x.label} number density`);
    return `${name}, ${pretty(u)}`; };
  const radio = (x, name) => `<label${x.group === "ion" ? ` class="v3c-ion" style="--ic:${x.color};--icd:${x.color_dark}"` : ""}>` +
    `<input type="radio" name="${name}" value="${x.key}" data-testid="v3-species-${x.key}"${x.available ? "" : " disabled"} aria-label="${escH(x.spoken || x.label)}" data-tip="${escH(fieldTip(x))}">` +
    `<span>${x.group === "ion" ? "<i></i>" : ""}${x.group === "vel" ? x.html : escH(x.label)}</span></label>`;   // vel html: our own constant (vizdata VEL_VIEWS)
  const ctlBox = document.createElement("div"); ctlBox.className = "v3c"; ctlBox.id = "v3-ctl"; ctlBox.setAttribute("role", "group"); ctlBox.setAttribute("aria-label", "3D view settings");
  ctlBox.innerHTML = `<section class="v3c-card" data-group="field"><h2>Field</h2>
      <div id="v3-species" role="radiogroup" aria-label="Field"><span class="k">Gas</span><div class="v3c-seg">${SPEC.filter(x => x.group === "gas").map(x => radio(x, "v3-species")).join("")}</div>
        <span class="k">Ions</span><div class="v3c-ions">${SPEC.filter(x => x.group === "ion").map(x => radio(x, "v3-species")).join("")}</div>
        <span class="k">Velocity</span><div class="v3c-seg vel">${SPEC.filter(x => x.group === "vel").map(x => radio(x, "v3-species")).join("")}</div></div>
      <div class="v3c-row" id="v3-lo-row"><label for="v3-lo">low</label><input id="v3-lo" type="range" step="0.1" data-tip="Bottom of the colour scale, log10 of the field"><output id="v3-lo-o" for="v3-lo"></output></div>
      <div class="v3c-row" id="v3-hi-row"><label for="v3-hi">high</label><input id="v3-hi" type="range" step="0.1" data-tip="Top of the colour scale, log10 of the field"><output id="v3-hi-o" for="v3-hi"></output></div>
      <div class="v3c-row" id="v3-vw-row" hidden><label for="v3-vw">window</label><input id="v3-vw" type="range" step="10" data-tip="Velocity range of the colour scale, km/s; beyond it colours saturate"><output id="v3-vw-o" for="v3-vw"></output></div>
      <div class="v3c-row" id="v3-weight-row" hidden><label for="v3-weight">weight</label><select id="v3-weight" data-tip="Density that weights the velocities: all gas or one ion"></select></div>
      <div class="v3c-row" id="v3-cmap-row"><label for="v3-cmap">colours</label><select id="v3-cmap" data-tip="Colour map of the field"></select></div></section>
    <section class="v3c-card" data-group="view"><h2>View</h2>
      <div class="v3c-btns presets"><button type="button" class="v3c-btn" data-p="face-on" data-tip="Look down the disk normal (F)">Face-on</button><button type="button" class="v3c-btn" data-p="edge-on" data-tip="Look at the disk from its side (E)">Edge-on</button>
        <button type="button" class="v3c-btn" data-p="sightline" data-tip="Look along the selected sightline, as its spectrum sees it (A)">Along ray</button><button type="button" class="v3c-btn" data-p="reset" data-tip="Default camera view (R)">Reset</button></div>
      <button type="button" class="v3c-btn v3c-wide" id="v3-fs" aria-pressed="false" data-tip="Fill the screen with the 3D view (Shift+F)"><svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true"><path d="M2 6V2h4M10 2h4v4M14 10v4h-4M6 14H2v-4"/></svg><span>Fullscreen</span></button>
      <div class="v3c-row v3c-pvrow" id="v3-pv-row"><span class="lab">centre</span><div class="v3c-btns v3c-pvb"><button type="button" class="v3c-btn" id="v3-pv-gal" aria-pressed="true" data-tip="Orbit about the galaxy centre (C); double-click elsewhere to move">galaxy</button><button type="button" class="v3c-btn" id="v3-pv-ray" aria-pressed="false" data-tip="Orbit about the selected sightline's closest point">ray</button></div></div>
      <details id="v3-pv-more"><summary data-tip="Type an orbit centre in kpc, galaxy box axes">kpc</summary><form class="v3tf-g v3c-pvxyz" id="v3-pv-form"><input id="v3-pv-x" type="number" step="1" min="-400" max="400" aria-label="centre x, kpc" placeholder="x" data-tip="x in kpc from the galaxy centre"><input id="v3-pv-y" type="number" step="1" min="-400" max="400" aria-label="centre y, kpc" placeholder="y" data-tip="y in kpc from the galaxy centre"><input id="v3-pv-z" type="number" step="1" min="-400" max="400" aria-label="centre z, kpc" placeholder="z" data-tip="z in kpc from the galaxy centre"><button type="submit" class="v3c-btn" data-tip="Move the orbit centre there">go</button></form></details></section>
    <section class="v3c-card" data-group="layers"><h2>Layers</h2>
      <div class="v3c-row"><label for="v3-gasmix">gas</label><input id="v3-gasmix" type="range" min="0" max="1" step="0.05" data-tip="Strength of the gas layer; 0 hides it"><output id="v3-gasmix-o" for="v3-gasmix"></output></div>
      <div class="v3c-row"><label class="lab"><input type="checkbox" id="v3-stars" data-tip="Starlight as a g, r, i colour composite, asinh stretched">stars</label><input id="v3-starmix" type="range" min="0" max="1" step="0.05" aria-label="star layer" data-tip="Strength of the star layer"><output id="v3-starmix-o" for="v3-starmix"></output></div>
      <details><summary>star brightness</summary><div class="v3c-row"><label for="v3-mu0">μ₀ base</label><input id="v3-mu0" type="range" min="17" max="26" step="0.1" data-tip="Asinh stretch level, mag/arcsec²; higher shows fainter starlight"><output id="v3-mu0-o" for="v3-mu0"></output></div></details>
      <div class="v3c-row"><label for="v3-lines">lines</label><select id="v3-lines" data-tip="Draw sightlines: selected, rich absorbers plus yours, all, none"><option value="selected">selected only</option><option value="showcase">rich absorbers + yours</option><option value="all">all</option><option value="none">none</option></select></div>
      <div class="v3c-sw"><label><input type="checkbox" id="v3-guides" data-tip="Draw the R200c ring and the disk normal">guides</label><label><input type="checkbox" id="v3-scale" checked data-tip="Show a length scale in kpc">scale bar</label></div></section>
    <section class="v3c-card" data-group="mode"><h2>Mode</h2>
      <div id="v3-mode" class="v3c-seg two" role="radiogroup" aria-label="Render mode"><label><input type="radio" name="v3-mode" value="integral" data-testid="v3-mode-integral" data-tip="Projected map: column or weighted mean along each ray"><span>integral</span></label>
        <label><input type="radio" name="v3-mode" value="volume" data-testid="v3-mode-volume" data-tip="Ray-marched emission and absorption through a transfer function"><span>volume</span></label></div>
      <div class="v3c-row"><label for="v3-op">opacity</label><input id="v3-op" type="range" min="0" max="1" step="0.01" data-tip="Overall opacity of the volume rendering; volume mode only"><output id="v3-op-o" for="v3-op"></output></div></section>
    <section class="v3c-card" data-group="pick"><h2>Pick ray</h2><div class="v3c-pick"></div></section>
    <div class="v3c-lod" id="v3-lod" aria-hidden="true"></div>`;
  const q = s => el.querySelector(s) || ctlBox.querySelector(s), canvas = q("canvas"), stage = q(".v3d-stage"), msgEl = q(".v3d-msg");
  /* tune1 F1: the page's range style fills the track up to --pc; keep it at each slider's value (set from code and on input) */
  const fillRanges = () => { for (const i of ctlBox.querySelectorAll('input[type=range]')) { const a = i.min === "" ? 0 : +i.min, b = i.max === "" ? 100 : +i.max;
    i.style.setProperty("--pc", (b > a ? Math.min(100, Math.max(0, (+i.value - a) / (b - a) * 100)) : 0).toFixed(2) + "%"); } };
  ctlBox.addEventListener("input", ev => { if (ev.target.type === "range") fillRanges(); });
  const markSpecies = k => { for (const i of ctlBox.querySelectorAll('input[name="v3-species"]')) i.checked = i.value === k; };
  const markMode = m => { for (const i of ctlBox.querySelectorAll('input[name="v3-mode"]')) i.checked = i.value === m; };
  /* tf3d: the Transfer function card (tfeditor.js) follows the Mode card; shown in volume mode for the scalar fields */
  const tfEd = createTfEditor({onChange: (st, info) => onTfEdit(st, info)});
  ctlBox.querySelector('[data-group="mode"]').after(tfEd.el);
  let docked = null, spinRaf = 0, fullHost = null, thumbHost = null;   // Phase 3 docking state (see "docking" below)
  /* stage message; `transient` ones (a hint about the current selection or preset) are cleared by the next selection or preset */
  /* fix-ui FE-11: the stage message is not a live region (download progress rewrites it 5× a second); state changes are
     announced through #v3-live instead, deduplicated and at most one every 2 s. FE-05: progress messages are tagged
     (data-prog) so a superseded load can clear its own "loading …" text */
  const liveEl = q("#v3-live"); let liveT = 0, liveNext = null, liveAt = 0;
  function announce(t) { if (!t || t === liveEl.textContent && !liveNext) return; liveNext = t; if (liveT) return;
    const go = () => { liveT = 0; if (liveNext && liveNext !== liveEl.textContent) liveEl.textContent = liveNext; liveNext = null; liveAt = performance.now(); };
    const wait = Math.max(0, 2000 - (performance.now() - liveAt)); if (wait) liveT = setTimeout(go, wait); else go(); }
  const say = (t, bad, transient = false, small = "", prog = false) => { msgEl.textContent = t || ""; if (small) { const s = document.createElement("small"); s.textContent = small; msgEl.appendChild(s); }
    msgEl.className = "v3d-ov v3d-msg" + (bad ? " bad" : ""); msgEl.dataset.transient = t && transient ? "1" : ""; msgEl.dataset.prog = t && prog ? "1" : "";
    if (t && !prog) announce(t);
    /* final: while an error stands on a stage with no gas data, the sightlines are not drawn (they crossed the message) */
    const nd = !!(t && bad && !species); if (nd !== noDataMsg) { noDataMsg = nd; try { refreshLines(); } catch { /* lines not set up yet */ } } };
  let noDataMsg = false;
  const clearProg = () => { if (msgEl.dataset.prog) say(""); };
  const clearTransient = () => { if (msgEl.dataset.transient) say(""); };
  const NO_ENDPOINTS = id => `${id} has no stored endpoints, so it cannot be drawn in 3D.`;

  /* ---- renderer, camera, controls ---- */
  /* fix-ui FE-09: MSAA only on low-DPR screens (the volume is drawn into accRT and blitted, so MSAA helps only the lines,
     and on a DPR ≥ 1.5 screen its multisampled backbuffer is large while the aliasing is hardly visible); the pixel ratio
     is re-read on resize / DPR change, and exact frames drop to exactPR when they measure slower than EXACT_MS */
  const AA = (devicePixelRatio || 1) < 1.5;
  const renderer = new T.WebGLRenderer({canvas, antialias: AA, alpha: false, powerPreference: "high-performance"});
  renderer.outputColorSpace = T.LinearSRGBColorSpace; renderer.setClearColor(new T.Color(BG), 1);
  /* the page's CSS zoom on <html> (112 % on large screens) stretches the canvas: render that many more pixels so the 3D view
     stays sharp; the per-device cap (1.0 phones, 1.5 desktop) still bounds the cost */
  const cssZoom = () => parseFloat(getComputedStyle(document.documentElement).zoom) || 1;
  const calcPR = () => Math.min(devicePixelRatio || 1, mobile ? 1.0 : 1.5) * cssZoom();
  let PR = calcPR(), exactPR = PR, accMax = 8;
  const EXACT_MS = 100;
  renderer.setPixelRatio(PR);
  const scene = new T.Scene(), volScene = new T.Scene(), camera = new T.PerspectiveCamera(FOV, 1, 0.5, 20000);
  const controls = new OrbitControls(camera, canvas); controls.enableDamping = false; controls.minDistance = 15; controls.maxDistance = 5600;
  controls.zoomSpeed = 1.2; controls.keys = {};

  /* ---- the cube mesh (local = disk frame) ---- */
  const nCube = manifest ? (manifest.levels.L1?.n || manifest.levels.L0?.n || 256) : 256;
  const RM = makeMaterial(T, {n: nCube}), U = RM.uniforms;
  const half = lv => manifest?.levels?.[lv]?.half_kpc ?? {L0: 400, L1: 100, L2: 25, S0: 400, S1: 100, S2: 25}[lv];
  U.uHalf.value.set(half("L0"), half("L1"), half("L2")); U.uMask0.value = manifest?.levels?.L0?.r_mask_kpc ?? 400;
  U.uBg.value.set(5 / 255, 7 / 255, 11 / 255);
  const volMesh = new T.Mesh(new T.BoxGeometry(2 * half("L0"), 2 * half("L0"), 2 * half("L0")), RM.material);
  volMesh.matrixAutoUpdate = false; volMesh.matrix.makeBasis(Xv, Yv, Lv); volMesh.updateMatrixWorld(true); volMesh.renderOrder = 0; volMesh.frustumCulled = false;
  volMesh.visible = !!manifest; volScene.add(volMesh);
  /* tune2: progressive refine. The exact frame is drawn into an accumulation target; while the view is still, up to
     ACC_N more frames with a sub-pixel raster offset and a new ray jitter are blended in as a running mean, then the
     target is copied to the canvas and the lines are drawn over it. Moving frames still go straight to the canvas. */
  const accType = renderer.extensions.has("EXT_color_buffer_float") || renderer.extensions.has("EXT_color_buffer_half_float") ? T.HalfFloatType : T.UnsignedByteType;
  const accRT = new T.WebGLRenderTarget(1, 1, {type: accType, format: T.RGBAFormat, depthBuffer: false, stencilBuffer: false,
    minFilter: T.NearestFilter, magFilter: T.NearestFilter, generateMipmaps: false});
  const blitScene = new T.Scene(), blitCam = new T.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  const blitMat = new T.ShaderMaterial({uniforms: {uTex: {value: accRT.texture}}, depthTest: false, depthWrite: false,
    vertexShader: `out vec2 vUv; void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }`,
    fragmentShader: `uniform sampler2D uTex; in vec2 vUv; out vec4 o; void main() { o = vec4(texture(uTex, vUv).rgb, 1.0); }`, glslVersion: T.GLSL3});
  blitScene.add(new T.Mesh(new T.PlaneGeometry(2, 2), blitMat));
  const ACC_N = 8, SUB = Array.from({length: ACC_N}, (_, i) => i ? [((0.5 + i * 0.7548776662) % 1) - 0.5, ((0.5 + i * 0.5698402910) % 1) - 0.5] : [0, 0]);   // R2 sequence, px

  /* ---- guides: camera-facing R200c ring + L arrow (default off) ---- */
  const guides = new T.Group(); guides.visible = false; scene.add(guides);
  const ringPts = []; for (let i = 0; i <= 128; i++) { const t = i / 128 * 2 * Math.PI; ringPts.push(new T.Vector3(frame.R200c * Math.cos(t), frame.R200c * Math.sin(t), 0)); }
  /* fix-ui V5: one neutral guide colour (sand; no sightline category uses it), the ring drops to a round radius that fits
     when R200c is off-screen (the legend says which), and the arrow is shortened so its head stays in view */
  const GUIDE = 0xd9c38c;
  const ring = new T.Line(new T.BufferGeometry().setFromPoints(ringPts), new T.LineBasicMaterial({color: GUIDE, transparent: true, opacity: 0.5, depthTest: false}));
  const arrow = new T.ArrowHelper(Lv, new T.Vector3(), 150, GUIDE, 22, 11);
  arrow.children.forEach(c => { c.material.transparent = true; c.material.opacity = 0.6; c.material.depthTest = false; });
  guides.add(ring, arrow); [ring, ...arrow.children].forEach(o => (o.renderOrder = 2));

  /* ---- sightlines: one LineSegments with per-vertex alpha ---- */
  const lineMat = new T.LineBasicMaterial({vertexColors: true, transparent: true, depthTest: false, depthWrite: false});
  const lines = new T.LineSegments(new T.BufferGeometry(), lineMat); lines.renderOrder = 3; scene.add(lines);
  let LINE_IDS = [], LINE_P = [], linesMode = "selected", selId = null, nNoEnds = 0;
  const selGroup = new T.Group(); scene.add(selGroup);
  /* tune1: the selected sightline is a fixed-width screen-space ribbon (SEL_PX CSS px) plus round end dots, not a
     world-space tube, so it never swells into a bar when it passes near the camera or through the view centre */
  /* tune3: the ribbon keeps its world position (perspective-correct varying) so each fragment knows how close its view ray
     passes to the galaxy centre (b) and whether it lies in front of or behind the centre; over the galaxy (b < r1 kpc)
     it fades to SEL_GAL.front (in front) or SEL_GAL.back (behind), so the line no longer hides the disk and bulge */
  const selU = {uRes: {value: new T.Vector2(1, 1)}, uPx: {value: SEL_PX}, uDot: {value: 7}, uCol: {value: new T.Color(0xe9eef4)}, uA: {value: SEL_ALPHA},
    uGal: {value: new T.Vector4(SEL_GAL.r0, SEL_GAL.r1, SEL_GAL.front, SEL_GAL.back)}};
  const GALF = `uniform vec4 uGal; float galFade(vec3 w) { vec3 r = w - cameraPosition; float L = length(r); if (L < 1e-6) return 1.0; vec3 d = r / L;
      float t = dot(-cameraPosition, d), b = length(cross(-cameraPosition, d)); float f = L > t ? uGal.w : uGal.z;
      return mix(f, 1.0, smoothstep(uGal.x, uGal.y, b)); }`;
  const selMat = new T.ShaderMaterial({uniforms: selU, transparent: true, depthTest: false, depthWrite: false,
    vertexShader: `attribute vec3 other; attribute float side; uniform vec2 uRes; uniform float uPx; out vec3 vW;
      void main() { mat4 M = projectionMatrix * modelViewMatrix; vec4 a = M * vec4(position, 1.0), b = M * vec4(other, 1.0);
        if (a.w <= 1e-3 && b.w <= 1e-3) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); vW = position; return; }
        vec3 wa = (modelMatrix * vec4(position, 1.0)).xyz, wb = (modelMatrix * vec4(other, 1.0)).xyz;
        if (a.w <= 1e-3) { float f = (1e-3 - a.w) / (b.w - a.w); a = mix(a, b, f); wa = mix(wa, wb, f); }
        if (b.w <= 1e-3) { float f = (1e-3 - b.w) / (a.w - b.w); b = mix(b, a, f); }
        vec2 sa = a.xy / a.w * uRes, sb = b.xy / b.w * uRes, d = sb - sa; d = length(d) > 1e-6 ? normalize(d) : vec2(1.0, 0.0);
        vec2 off = vec2(-d.y, d.x) * side * uPx / uRes; vW = wa;
        gl_Position = vec4((a.xy / a.w + off) * a.w, 0.0, a.w); }`,
    fragmentShader: `uniform vec3 uCol; uniform float uA; in vec3 vW; ${GALF} out vec4 o; void main() { o = vec4(uCol, uA * galFade(vW)); }`, glslVersion: T.GLSL3});
  const dotMat = new T.ShaderMaterial({uniforms: selU, transparent: true, depthTest: false, depthWrite: false,
    vertexShader: `attribute float size; uniform float uDot; out float vF; ${GALF}
      void main() { vF = galFade((modelMatrix * vec4(position, 1.0)).xyz); gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); gl_PointSize = uDot * size; }`,
    fragmentShader: `uniform vec3 uCol; uniform float uA; in float vF; out vec4 o; void main() { vec2 p = gl_PointCoord * 2.0 - 1.0; float r = dot(p, p); if (r > 1.0) discard;
      o = vec4(uCol, uA * vF * (1.0 - smoothstep(0.7, 1.0, r))); }`, glslVersion: T.GLSL3});
  function selGeometry(a, b) {         // one quad: 4 vertices, each with its own end, the other end and a side (±1)
    const g = new T.BufferGeometry(), P = [a, a, b, b], O = [b, b, a, a];
    g.setAttribute("position", new T.BufferAttribute(new Float32Array(P.flatMap(v => [v.x, v.y, v.z])), 3));
    g.setAttribute("other", new T.BufferAttribute(new Float32Array(O.flatMap(v => [v.x, v.y, v.z])), 3));
    g.setAttribute("side", new T.BufferAttribute(new Float32Array([1, -1, -1, 1]), 1));   // b's side flips: its "other" is a
    g.setIndex([0, 1, 2, 1, 3, 2]); return g;
  }
  function selUniforms() { const v = new T.Vector2(); renderer.getDrawingBufferSize(v); const pr = renderer.getPixelRatio();
    selU.uRes.value.set(v.x / 2, v.y / 2); selU.uPx.value = SEL_PX * pr / 2; selU.uDot.value = 7 * pr; }
  const OPA = {lib: 0.14, gen: 0.35, cust: 0.55};
  const hasEnds = e => !!e && Array.isArray(e.p0) && Array.isArray(e.p1) && e.p0.length === 3 && e.p1.length === 3;
  function refreshLines() {
    const all = app.entries(); nNoEnds = all.filter(e => !hasEnds(e)).length;
    const es = all.filter(hasEnds).filter(e => linesMode === "all" || (linesMode === "showcase" && (e.star || +e.n_showcase_ions >= 1 || e.source === "generated"))
      || (linesMode === "selected" && e.id === selId));
    const pos = new Float32Array(es.length * 6), col = new Float32Array(es.length * 8);
    const C = {lib: new T.Color(0x8d97a6), gen: new T.Color(0x7db2f0), cust: new T.Color(0xf39a5c)};
    LINE_IDS = []; LINE_P = [];
    es.forEach((e, i) => { pos.set(e.p0, 6 * i); pos.set(e.p1, 6 * i + 3);
      const k = e.orientation === "custom" || e.kind === "endpoints" ? "cust" : e.source === "generated" ? "gen" : "lib", c = C[k];
      for (const v of [0, 4]) col.set([c.r, c.g, c.b, OPA[k]], 8 * i + v);
      LINE_IDS.push(e.id); LINE_P.push([e.p0, e.p1]); });
    lines.geometry.dispose(); const g = new T.BufferGeometry();
    g.setAttribute("position", new T.BufferAttribute(pos, 3)); g.setAttribute("color", new T.BufferAttribute(col, 4)); lines.geometry = g;
    lines.visible = linesMode !== "none" && es.length > 0 && !noDataMsg; select(selId, true); render();
  }
  function select(id, force) {
    if (id === selId && !force) return; const changed = (id || null) !== selId; selId = id || null;
    for (const c of [...selGroup.children]) { selGroup.remove(c); c.geometry.dispose(); }
    const e = selId && app.entry(selId);
    if (changed) { clearTransient(); if (e && !hasEnds(e)) say(NO_ENDPOINTS(e.id), false, true); }
    if (hasEnds(e)) { const a = V3(e.p0), b = V3(e.p1);
      const rib = new T.Mesh(selGeometry(a, b), selMat); rib.frustumCulled = false;
      const dg = new T.BufferGeometry(); dg.setAttribute("position", new T.BufferAttribute(new Float32Array([a.x, a.y, a.z, b.x, b.y, b.z]), 3));
      dg.setAttribute("size", new T.BufferAttribute(new Float32Array([0.8, 1.3]), 1));      // start dot smaller than the end dot
      const dots = new T.Points(dg, dotMat); dots.frustumCulled = false; selGroup.add(rib, dots); }
    selGroup.visible = linesMode !== "none" && !noDataMsg;
    if (changed && linesMode === "selected") { refreshLines(); return; }
    selGroup.children.forEach(c => (c.renderOrder = 4)); aria(); render();
  }

  /* ---- state ---- */
  let species = null, wanted = null, mode = "integral", loadTok = 0;
  const layer = {stars: !mobile && !!manifest?.stars, gasMix: 0.85, starMix: 0.9, Q: manifest?.stars?.display?.Q ?? 8, mu0: STAR_DEFAULT.mu0, sat: STAR_DEFAULT.sat,
    balance: manifest?.stars?.display?.balance ?? [1, 1, 1]};
  const tf = {integral: {}, volume: {}};   // per mode, per species: {lo, hi, opacity, cmap}
  /* tf3d: transfer-function (TF) volume mode, THOR (Byrohl & Nelson 2025) sec. 3.5.3: per field a tf.js state; a field
     with no state, or one equal to the "ramp" preset, draws the fixed ramp exactly as before (uTFOn = 0) */
  const tfs = {};
  const stats = {};
  const fld = k => manifest?.gas?.fields?.[k], lab = k => specOf(k)?.spoken || specOf(k)?.label || k;   // vel3d: velocity views by their spoken names
  const weighted = k => fld(k)?.kind === "mass_weighted" || fld(k)?.proj?.kind === "weighted_mean";
  /* vel3d: a velocity view is shown when the vector is in the manifest; velW = the weight field (a density: nH or an ion
     with cubes), shared by the five views; the velocity window per view and mode lives in tf like any field's */
  const velView = k => specOf(k)?.group === "vel" ? specOf(k) : null;
  const canShow = k => !!fld(k) && fld(k).kind !== "velocity" || (isVel(k) && !!VELI);
  const WEIGHTS = ["nH", ...ION_KEYS].filter(k => fld(k)?.cubes && fld(k).kind === "density");
  let velW = WEIGHTS[0] || "nH";
  /* boundW = the weight whose cubes are bound and drawn (uW*, uWRange, uWWin, legend); velW = the one requested. A Weight
     change loads velW while boundW stays drawn, then switches both at once, without a fade, once the new weight is resident
     at every level the old one is drawn at (setWeight), so the view does not drop levels (unless a new level fails) or
     draw new-weight cubes under the old weight's window */
  let boundW = velW;
  /* the gas-field key whose cubes a view draws with: the view's own (nH, T, ..., ions) or, for a velocity view, its weight */
  const wKey = k => (isVel(k) ? boundW : emisKey(k) || (weighted(k) ? "nH" : null));   // tf3d: the TF emissivity weight when set
  function velTf(k, m = mode) { const v = velView(k), V = VELI?.V || 1000, W = Math.min(VEL_W, V);
    return tf[m][k] ||= {W, lo: v.signed ? -W : 0, hi: W, opacity: m === "volume" ? VOL.opacity : 0.5, cmap: v.signed ? VEL_NAMES.signed[0] : VEL_NAMES.unsigned[0]}; }
  /* σ_los is a property of the whole ray (its moment 2), so it has no volume rendering: integral only */
  const modeOk = (k, m) => !(k === "sigmalos" && m === "volume");
  function fieldTf(k, m = mode) { if (isVel(k)) return velTf(k, m);
    const f = fld(k), d = m === "integral" ? WIN_DEFAULT[k] || {} : {},
      w = m === "integral" ? [d.lo ?? f.proj.vmin, d.hi ?? f.proj.vmax] : f.vol_window;
    const cm = CMAP_DEFAULT[k] || f.cmap;
    return tf[m][k] ||= {lo: w[0], hi: w[1], opacity: m === "volume" ? VOL.opacity : 0.5, cmap: CMAPS.includes(cm) ? cm : "tng_dusk"}; }
  function winRange(k, m = mode) { const f = fld(k); if (m === "volume") return [f.vmin, f.vmax];
    return [Math.floor(Math.min(f.proj.vmin, f.vmin + (weighted(k) ? 0 : 19)) - 2), Math.ceil(f.proj.vmax + 1.5)]; }
  /* tf3d: the preset context of a field (its encoding range and current volume window), its state (default: the ramp
     preset over that window), whether TF mode is on for it, and the emissivity weight field (a density with cubes) */
  const tfCtx = k => { const f = fld(k), s = fieldTf(k, "volume"); return {field: k, vmin: f.vmin, vmax: f.vmax, volWin: [s.lo, s.hi]}; };
  const tfState = k => (tfs[k] ||= tfPreset("ramp", tfCtx(k)));
  const tfOk = k => !!k && !isVel(k) && !!fld(k) && fld(k).kind !== "velocity";
  const tfOn = (k = species) => mode === "volume" && tfOk(k) && !!tfs[k] && encodeTF(tfs[k], tfCtx(k)) !== "Pramp";
  const emisKey = (k = species) => { const e = tfOn(k) && tfs[k].emis; return e && WEIGHTS.includes(e) && tfs[k].gamma > 0 ? e : null; };

  /* ---- textures, LOD, GPU budget ---- */
  const loader = manifest ? makeLoader({manifest, base: viz.base, fallbackBase: viz.fallback_base, cache: viz.cache !== false}) : null;
  const TEX = new Map(), PEND = new Map(), FADE = new Map(), PROG = new Map();   // PROG: key -> {got, total} bytes (tune2)   // key "gas|nH|L1" / "stars||S1" -> {tex, bytes, used}
  const BUDGET = (mobile ? 192 : 448) * 1e6;
  let hostErr = null, useMovingExact = true, calibrated = "";
  const keyOf = (kind, k, L) => `${kind}|${k || ""}|${L}`;
  const hVis = () => camera.position.distanceTo(controls.target) * Math.tan(camera.fov * Math.PI / 360);
  /* final: footprint ratios of L1/L2/S1/S2 for viewPlan, as the shader's lodLevel computes them (voxel / (C * kpc per
     drawing-buffer pixel)), at the point of each level's box nearest the camera */
  function ratios(k) {
    const bufH = Math.max(1, (stage.clientHeight || 400) * exactPR), pxAng = 2 * Math.tan(camera.fov * Math.PI / 360) / bufH;
    const c = camera.position, cd = [c.dot(Xv), c.dot(Yv), c.dot(Lv)], cg = lodField(k), out = {};
    for (const [L, C] of [["L1", cg], ["L2", cg], ["S1", LOD_C.stars], ["S2", LOD_C.stars]]) {
      const hh = half(L), n = manifest?.levels?.[L]?.n || 256, d = Math.max(1, Math.hypot(...cd.map(x => x - Math.max(-hh, Math.min(hh, x)))));
      out[L] = (2 * hh / n) / (C * pxAng * d); }
    return out; }
  /* final (cold first load): the keys the current view uses, in load priority (vizdata.viewPlan): field L0 (+ nH weights for
     T / Z), L1, the star level, then L2 / S2 / S0 only when the view resolves them; other fields only once selected */
  function needed(k = wanted || species) {
    const plan = viewPlan({ratio: ratios(k), hVisKpc: hVis(), mobile, stars: layer.stars && !!manifest.stars}), keys = [];
    for (const [kind, L] of plan.order) {
      if (kind === "gas") { if (!k) continue;
        /* vel3d: a velocity view needs the packed velocity cube of the level ("vel||L") and its weight field */
        if (isVel(k)) { keys.push(keyOf("vel", "", L), keyOf("gas", velW, L)); continue; }
        keys.push(keyOf("gas", k, L)); if (weighted(k) && mode === "integral") keys.push(keyOf("gas", "nH", L));
        const ek = emisKey(k); if (ek && ek !== k) keys.push(keyOf("gas", ek, L)); }
      else if (manifest.stars?.cubes?.[L]) keys.push(keyOf("stars", "", L)); }
    let ks = keys.filter(x => { const [kind, kk, L] = x.split("|"); return kind === "stars" || (kind === "vel" ? VEL_COMP_KEYS.every(c => fld(c)?.cubes?.[L]) : fld(kk)?.cubes?.[L]); });
    /* Phase 3 thumbnail: only L0 / L1 of the field (and nH weights) are fetched for it; stars and finer levels are used only
       when the full stage already loaded them */
    if (docked === "thumb") ks = ks.filter(x => TEX.has(x) || /^(gas|vel)\|.*\|L[01]$/.test(x));
    /* fix-ui FE-06: the needed set itself must fit the GPU budget (with the render targets): drop S0, then S2, then the L2
       field (with its weights), then S1, until it does; evict() can only free what is not needed */
    const over = () => ks.reduce((a, x) => a + keyBytes(x), 0) + rtBytes() > BUDGET, dropped = [];
    const l2 = isVel(k) ? [keyOf("vel", "", "L2"), keyOf("gas", velW, "L2")] : [keyOf("gas", k, "L2"), keyOf("gas", "nH", "L2"), keyOf("gas", emisKey(k) || "nH", "L2")];
    for (const grp of [[keyOf("stars", "", "S0")], [keyOf("stars", "", "S2")], l2, [keyOf("stars", "", "S1")]]) {
      if (!over()) break;
      const hit = ks.filter(x => grp.includes(x)); if (hit.length) { ks = ks.filter(x => !grp.includes(x)); dropped.push(...hit.map(x => x.split("|")[2])); } }
    budgetDropped = [...new Set(dropped)];
    return {keys: ks};
  }
  let budgetDropped = [];
  function keyBytes(key) { const [kind, kk, L] = key.split("|");
    if (kind === "vel") { const n = manifest.levels?.[L]?.n; return n ? 4 * n ** 3 : BYTES.vel; }
    const c = kind === "stars" ? manifest.stars?.cubes?.[L] : fld(kk)?.cubes?.[L]; return c?.raw_bytes ?? BYTES[kind]; }
  /* vel3d: the download size of a key (the three component cubes for "vel||L") */
  const dlBytes = key => { const [kind, kk, L] = key.split("|"), sum = c => c?.webp?.bytes?.reduce((a, b) => a + b, 0) ?? 0;
    return kind === "vel" ? VEL_COMP_KEYS.reduce((a, c) => a + sum(fld(c)?.cubes?.[L]), 0) : sum(kind === "stars" ? manifest.stars?.cubes?.[L] : fld(kk)?.cubes?.[L]); };
  function rtBytes() { const v = new T.Vector2(); renderer.getDrawingBufferSize(v); return v.x * v.y * ((accType === T.HalfFloatType ? 8 : 4) + (AA ? 4 : 1) * 8); }
  function half2(a, n) { const m = n >> 1, o = new Uint8Array(m * m * m); let j = 0;
    for (let z = 0; z < m; z++) for (let y = 0; y < m; y++) { const b = (2 * z * n + 2 * y) * n; for (let x = 0; x < m; x++) o[j++] = a[b + 2 * x]; }
    return o; }
  function makeTex(r) {
    const n = r.n, tex = new T.Data3DTexture(r.data, n, n, n);
    tex.format = r.kind === "stars" || r.kind === "vel" ? T.RGBAFormat : T.RedFormat; tex.type = T.UnsignedByteType; tex.minFilter = tex.magFilter = T.LinearFilter;
    tex.wrapS = tex.wrapT = tex.wrapR = T.ClampToEdgeWrapping; tex.unpackAlignment = 1; tex.generateMipmaps = false; tex.needsUpdate = true;
    return tex;
  }
  function getTex(key, prio = 1) {
    if (TEX.has(key)) { TEX.get(key).used = performance.now(); return Promise.resolve(TEX.get(key)); }
    if (!PEND.has(key)) { const pend = (async () => { const [kind, k, L] = key.split("|");
      if (kind === "vel") return velTex(key, L, prio);
      const c = kind === "stars" ? manifest.stars.cubes[L] : fld(k).cubes[L], pr = {got: 0, total: c.webp.bytes.reduce((a, b) => a + b, 0)}; PROG.set(key, pr);
      const r = await loader.load(kind, k || null, L, {prio, onBytes: b => { pr.got += b; progressSoon(); }}).finally(() => { PROG.delete(key); progressSoon(); });
      const sk = kind === "stars" ? "stars" : k, np = smoothPasses(sk) ? smoothPasses(sk)[+L[1]] || 0 : 0;
      if (np) { const rg = kind === "stars" ? c : fld(k), q0 = r.data;
        try { r.data = await smoothAsync(q0.slice(), r.n, rg.vmin, rg.vmax, np, kind === "stars" ? 4 : 1); r.smoothed = np; } catch { r.data = q0; } }
      const tex = makeTex(r);
      renderer.initTexture?.(tex);                           // upload now, then drop the byte array
      const it = {tex, bytes: r.data.length, used: performance.now(), format: r.format, ms: r.ms, fetchMs: r.fetchMs, decodeMs: r.decodeMs, base: r.base};
      /* tf3d: the TF editor's histograms come from the loaded cube (its bytes are dropped next): code counts of every level,
         and a half-resolution copy of L0 / L1 for the value x gradient histogram of the 2D editor (2 MB each) */
      if (kind === "gas") { try { it.codes = histCodes(r.data, 3); if (L !== "L2") it.sub = half2(r.data, r.n); } catch { /* histogram only */ } }
      if (!ctxLost) tex.image.data = null;                   // during a context loss keep it: three re-uploads it on restore
      TEX.set(key, it); stats.loads = (stats.loads || []).concat([{key, format: r.format, ms: Math.round(r.ms), decodeMs: Math.round(r.decodeMs || 0), webpError: r.webpError, smoothed: r.smoothed || 0}]);
      evict(); return it; })().finally(() => { if (PEND.get(key) === pend) PEND.delete(key); }); PEND.set(key, pend); }
    return PEND.get(key);
  }
  /* vel3d: the three component cubes of level L (fetched and hash-checked like any gas cube, never smoothed: a velocity
     prefilter would mix unweighted means) are packed on the CPU into one RGBA cube (vizdata.packVelocity) and uploaded
     as one texture; the component bytes are dropped once packed */
  async function velTex(key, L, prio) {
    const pr = {got: 0, total: dlBytes(key)}; PROG.set(key, pr);
    let rs;
    try { rs = await Promise.all(VEL_COMP_KEYS.map(c => loader.load("gas", c, L, {prio, onBytes: b => { pr.got += b; progressSoon(); }}))); }
    finally { PROG.delete(key); progressSoon(); }
    /* the user left the velocity views while this level downloaded: do not upload it (freeVel already ran). A velocity
       view still shown while another field loads keeps it (the user may come back) */
    if (!isVel(wanted) && !isVel(species)) throw Object.assign(new Error("velocity view left"), {cancelled: true});
    const r = {n: rs[0].n, kind: "vel", data: packVelocity(rs[0].data, rs[1].data, rs[2].data)};
    const tex = makeTex(r); renderer.initTexture?.(tex);
    const it = {tex, bytes: r.data.length, used: performance.now(), format: rs.map(x => x.format).join(","), ms: Math.max(...rs.map(x => x.ms))};
    if (!ctxLost) tex.image.data = null;
    TEX.set(key, it); stats.loads = (stats.loads || []).concat([{key, format: it.format, ms: Math.round(it.ms), decodeMs: 0, smoothed: 0}]);
    evict(); return it;
  }
  /* vel3d: leaving the velocity views frees their packed cubes (4 bytes per voxel, the largest gas textures) */
  function freeVel() { for (const [key, it] of [...TEX]) if (key.startsWith("vel|") && !isBound(key)) { it.tex.dispose(); TEX.delete(key); } }
  function evict() {
    let total = gpuBytes(); if (total <= BUDGET) return;
    const need = new Set(needed().keys), hv = hVis();
    const rank = key => { const [kind, k, L] = key.split("|");
      if (kind === "gas" && k !== species && k !== wKey(species)) return 0;   // other fields first
      if (kind === "vel" && !isVel(species)) return 0;
      if ((L === "L2" || L === "S2") && hv > 150) return 1; if (L === "S0" && hv < 60) return 1; return 2; };
    const cand = [...TEX.keys()].filter(k => !need.has(k) && !isBound(k)).sort((a, b) => rank(a) - rank(b) || TEX.get(a).used - TEX.get(b).used);
    for (const k of cand) { if (total <= BUDGET) break; const it = TEX.get(k); it.tex.dispose(); TEX.delete(k); total -= it.bytes; }
  }
  const gpuBytes = () => [...TEX.values()].reduce((a, it) => a + it.bytes, 0);
  const SLOT = {gas: ["uGas0", "uGas1", "uGas2"], w: ["uW0", "uW1", "uW2"], stars: ["uStar0", "uStar1", "uStar2"], vel: ["uVel0", "uVel1", "uVel2"]};
  const haveOf = slot => (slot === SLOT.gas ? U.uGasHave.value : slot === SLOT.w ? U.uWHave.value : slot === SLOT.vel ? U.uVelHave.value : U.uStarHave.value);
  const isBound = key => { const [kind, k, L] = key.split("|"), i = +L[1];
    if (kind === "stars") return U[SLOT.stars[i]].value === TEX.get(key)?.tex;
    if (kind === "vel") return U[SLOT.vel[i]].value === TEX.get(key)?.tex;
    return U[SLOT.gas[i]].value === TEX.get(key)?.tex || U[SLOT.w[i]].value === TEX.get(key)?.tex; };
  /* bind every resident level of the current field (and weights, stars); new bindings fade in over 300 ms, except the
     weights of a Weight switch (wInstant): those replace a drawn weight level for level, so they appear at once */
  function bindAll(wInstant = false) {
    if (!manifest) return;
    const now = performance.now(), fade = (slot, i, tex, ok) => { const cur = U[slot[i]].value;
      const haveVec = haveOf(slot), comp = ["x", "y", "z"][i];
      if (!ok) { U[slot[i]].value = slot === SLOT.stars || slot === SLOT.vel ? RM.empty4 : RM.empty1; haveVec[comp] = 0; FADE.delete(slot[i]); return; }
      if (cur !== tex) { U[slot[i]].value = tex; if (reduced() || !FADE.has("init:" + slot[0]) || wInstant && slot === SLOT.w) { haveVec[comp] = 1; FADE.delete(slot[i]); } else { haveVec[comp] = 0.001; FADE.set(slot[i], now); } } };
    const vel = isVel(species), wk = wKey(species);
    for (let i = 0; i < 3; i++) {
      const g = species && !vel && TEX.get(keyOf("gas", species, GAS_L[i])); fade(SLOT.gas, i, g?.tex, !!g);
      const w = species && wk && TEX.get(keyOf("gas", wk, GAS_L[i])); fade(SLOT.w, i, w?.tex, !!w);
      const v = vel && TEX.get(keyOf("vel", "", GAS_L[i])); fade(SLOT.vel, i, v?.tex, !!v);
      const s = layer.stars && TEX.get(keyOf("stars", "", STAR_L[i])); fade(SLOT.stars, i, s?.tex, !!s);
    }
    for (const s of [SLOT.gas, SLOT.w, SLOT.vel, SLOT.stars]) FADE.set("init:" + s[0], 1);   // the first binding of a slot set is instant
    if (species && !vel) { const f = fld(species); U.uGasRange.value.set(f.vmin, f.vmax); }
    if (vel) U.uVelV.value = VELI.V;
    if (fld(wk || "nH")) U.uWRange.value.set(fld(wk || "nH").vmin, fld(wk || "nH").vmax);
    STAR_L.forEach((S, i) => { const c = manifest.stars?.cubes?.[S]; if (c) U["uStarRange" + i].value.set(c.vmin, c.vmax); });
    applyTfMode(); syncTfCard(true); lodStatus(); aria(); render();
  }
  function stepFades(now) {
    let active = false;
    for (const [slot, t0] of FADE) { if (slot.startsWith("init:")) continue;
      const ss = [SLOT.gas, SLOT.w, SLOT.vel, SLOT.stars].find(s => s.includes(slot)), set = [ss, haveOf(ss)];
      const f = Math.min(1, (now - t0) / 300), comp = ["x", "y", "z"][set[0].indexOf(slot)]; set[1][comp] = Math.max(f, 0.001);
      if (f >= 1) FADE.delete(slot); else active = true; }
    return active;
  }
  /* vel3d: a velocity level is bound when both the packed cube and its weight are */
  const velSt = (st, L) => { const a = st("vel", "", L), b = st("gas", boundW, L); return a === "bound" && b === "bound" ? "bound" : a === "loading" || b === "loading" ? "loading" : "absent"; };
  function levels() {
    const st = (kind, k, L) => { const key = keyOf(kind, k, L); return TEX.has(key) && isBound(key) ? "bound" : PEND.has(key) ? "loading" : "absent"; };
    return {gas: Object.fromEntries(GAS_L.map(L => [L, !species ? "absent" : isVel(species) ? velSt(st, L) : st("gas", species, L)])), stars: Object.fromEntries(STAR_L.map(S => [S, st("stars", "", S)]))};
  }
  /* tune2 download progress: the stage message while the first field level loads, the LOD line for the rest */
  let progT = 0, progMsg = null;
  function progressSoon() { if (!progT) progT = setTimeout(() => { progT = 0; lodStatus(); if (progMsg) progMsg(); }, 200); }
  const progOf = keys => keys.reduce((a, k) => { const p = PROG.get(k); return p ? [a[0] + p.got, a[1] + p.total] : a; }, [0, 0]);
  let lastLod = "";
  function lodStatus() {
    const lv = levels(), mark = s => (s === "bound" ? "✓" : s === "loading" ? "…" : "–");
    /* Phase 3 (C12): one fact per line, no dot separators */
    let t = species ? `gas ${lab(species)}  ${GAS_L.map(L => `${L} ${mark(lv.gas[L])}`).join("  ")}` + (layer.stars ? `\nstars  ${STAR_L.map(S => `${S} ${mark(lv.stars[S])}`).join("  ")}` : "\nstars off") +
      `\nGPU ${mb(gpuBytes())}` + (docked === "thumb" ? "  thumbnail" : "") : "";
    const [g, tot] = progOf([...PROG.keys()]); if (t && budgetDropped.length) t += `\nGPU budget: ${budgetDropped.join(", ")} skipped`; if (t && tot) t += `\ndownloading ${mb(g)} of ${mb(tot)}`;
    if (t !== lastLod) { q("#v3-lod").textContent = lastLod = t; }
    /* final: once the field is shown, a small progress note while the finer levels of the current view stream in */
    if (species && (!wanted || wanted === species)) {
      const rest = plan.filter(x => !TEX.has(x) && !failed.has(x));
      if (rest.length && (!msgEl.textContent || msgEl.dataset.prog)) {
        const tot2 = rest.reduce((a, x) => a + (PROG.get(x)?.total ?? dlBytes(x)), 0), got2 = rest.reduce((a, x) => a + (PROG.get(x)?.got ?? 0), 0);
        const lvls = [...new Set(rest.map(x => x.split("|")[2]))].join(", ");
        say(`${lab(species)} shown, loading ${lvls} for this view, ${mb(got2)} of ${mb(tot2)}`, false, false, "", true); }
      else if (!rest.length) clearProg(); }
  }
  const cubeOf = key => { const [kind, kk, L] = key.split("|"); return kind === "stars" ? manifest?.stars?.cubes?.[L] : manifest?.gas?.fields?.[kk]?.cubes?.[L]; };
  /* final (cold first load): one staged queue. `plan` = the keys the current view uses, in priority order; at most LOAD_PAR
     cubes download at once (the first-frame keys always start at once, with network priority 0), each finished cube is bound
     and drawn, and keys a newer plan no longer names are not started. ensure() resolves when the wanted field's first level
     (L0, plus its nH weights for T / Z) is bound. */
  const LOAD_PAR = mobile || deviceMemory < 4 ? 1 : 2;
  let plan = [], planFirst = new Set(), active = 0;
  const failed = new Map(), waiters = new Map(), tries = new Map();
  function settle(key, err) { const ws = waiters.get(key); if (!ws) return; waiters.delete(key); for (const [res, rej] of ws) err ? rej(err) : res(); }
  function waitKey(key) { if (TEX.has(key)) return Promise.resolve(); if (failed.has(key)) return Promise.reject(failed.get(key));
    return new Promise((res, rej) => { if (!waiters.has(key)) waiters.set(key, []); waiters.get(key).push([res, rej]); }); }
  function pump() {
    for (const key of plan) {
      if (TEX.has(key) || PEND.has(key) || failed.has(key)) continue;
      const first = planFirst.has(key); if (!first && active >= LOAD_PAR) break;
      active++;
      getTex(key, first ? 0 : 1).then(() => { (stats.boundAt ||= {})[key] ??= Math.round(performance.now()); settle(key, null); },
        x => { if (x instanceof HostError) hostErr = x; failed.set(key, x); settle(key, x);
          /* a background level that stalled or failed is retried twice (3 s, 6 s later) while the view still wants it */
          const n = (tries.get(key) || 0) + 1; tries.set(key, n);
          if (!first && n <= 2) setTimeout(() => { if (failed.get(key) === x) { failed.delete(key); pump(); } }, 3000 * n); })
        .finally(() => { active--; bindAll(); pump(); });
    }
  }
  async function ensure() {
    if (!manifest) return false;
    const k = wanted || species, {keys} = needed(k), first = keys.find(x => x.startsWith(isVel(k) ? "vel||" : `gas|${k}|`));
    const wk = isVel(k) ? velW : weighted(k) && mode === "integral" ? "nH" : emisKey(k);
    const firstKeys = first ? [first, ...(wk ? [keyOf("gas", wk, first.split("|")[2])] : [])].filter(x => keys.includes(x)) : [];
    for (const [key, ws] of [...waiters]) if (!keys.includes(key)) { waiters.delete(key); for (const w of ws) w[1](Object.assign(new Error("superseded by a newer view"), {cancelled: true})); }
    plan = keys; planFirst = new Set(firstKeys); failed.clear(); lodStatus(); pump();
    await Promise.all(firstKeys.map(waitKey));
    return true;
  }
  /* fix-ui FE-06: WebGL context loss. three.js rebuilds its GL state on restore and re-uploads every texture that still
     has its bytes; the cubes dropped theirs after upload, so they are dropped here and requested again (from CacheStorage) */
  let ctxLost = false;
  canvas.addEventListener("webglcontextlost", ev => { ev.preventDefault(); ctxLost = true;
    say("The graphics context was lost (GPU reset or memory pressure). Restoring the 3D view…", true); });
  canvas.addEventListener("webglcontextrestored", () => { ctxLost = false;
    for (const [key, it] of [...TEX]) if (!it.tex.image?.data) TEX.delete(key);
    for (const sl of [...SLOT.gas, ...SLOT.w]) U[sl].value = RM.empty1; for (const sl of [...SLOT.stars, ...SLOT.vel]) U[sl].value = RM.empty4;
    U.uGasHave.value.set(0, 0, 0); U.uWHave.value.set(0, 0, 0); U.uStarHave.value.set(0, 0, 0); U.uVelHave.value.set(0, 0, 0); FADE.clear();
    lastCmap = null; calibrated = ""; accK = 0;
    if (!manifest || !species) { say(""); render(); return; }
    bindAll(); applyTf();
    ensure().then(() => { bindAll(); say(""); }).catch(x => { if (x instanceof HostError) hostMessage(x); else say(`Could not restore the 3D view: ${x.message}`, true); }); });
  function hostMessage(x) {
    const host = x.host || "the data host";
    say(`The 3D data host (${host}) is unreachable. Sightlines, ray picking and the spectra still work.`, true, false, x.message.slice(0, 300));
  }
  async function setSpecies(k) {
    if (!manifest) { say(viz ? `3D data not available${manErr ? ` (${manErr})` : ""}. Sightlines, ray picking and the spectra still work.` : "3D data not published for this build. Sightlines, ray picking and the spectra still work.", false); return false; }
    if (!canShow(k)) { const x = specOf(k);   // Phase 3: an ion whose cubes are not built yet (or an unknown key): no exception
      viewer.loadError = {key: k, message: x ? x.reason || "not available" : `unknown field ${k}`};
      if (x) say(`${x.reason.charAt(0).toUpperCase()}${x.reason.slice(1)}.`, false, true); markSpecies(species); return false; }
    const vel = isVel(k), firstKey = L => (vel ? keyOf("vel", "", L) : keyOf("gas", k, L));
    /* back to the field still shown: re-plan its levels (another field's plan may have replaced them); a velocity view
       whose Weight changed meanwhile takes the full path, so the new weights load and are switched in */
    if (species === k && (TEX.has(firstKey("L0")) || TEX.has(firstKey("L1"))) && (!vel || boundW === velW)) {
      if (wanted !== k) { loadTok++; wanted = k; progMsg = null; clearProg(); ensure().catch(() => {}); } markSpecies(k); thumbLabel(); return true; }
    const tok = ++loadTok; wanted = k; markSpecies(k); viewer.loadError = null;
    /* σ_los has no volume rendering: choosing it switches to integral mode, said in the loading and shown messages */
    const toInteg = !modeOk(k, mode) && setMode("integral"), modeNote = toInteg ? ", integral mode: the dispersion has no volume view" : "";
    /* final: the first frame waits for L0 alone (the coarse, whole-halo level); L1 and the rest follow (ensure / pump) */
    const cubes = fld(vel ? "vx" : k).cubes, L1st = cubes.L0 ? "L0" : "L1";
    const k1 = firstKey(L1st), tot1 = dlBytes(k1);
    say(`loading ${lab(k)} (${L1st}, ${mb(tot1)})${modeNote}…`, false, false, "", true); announce(`loading ${lab(k)}${modeNote}`);
    progMsg = () => { if (tok !== loadTok || species === k) { progMsg = null; return; } const p = PROG.get(k1);
      if (p) say(`loading ${lab(k)} (${L1st}), ${mb(p.got)} of ${mb(p.total)}…`, false, false, "", true); else if (TEX.has(k1) || PEND.has(k1)) say(`preparing ${lab(k)}…`, false, false, "", true); };
    try {
      const t0 = performance.now(); stats.speciesAt ??= Math.round(t0);
      /* a Weight change while this view loads re-plans without a new token and cancels this wait (its old weight key left
         the plan): wait again for the current plan rather than report a false failure */
      for (;;) { try { await ensure(); break; } catch (x) { if (!(x?.cancelled && tok === loadTok)) throw x; } }
      if (tok !== loadTok) return false;
      species = k; if (vel) boundW = velW; bindAll(); if (!vel) freeVel(); syncTfInputs(); applyTf(); tfUrl();
      const gl = renderer.getContext(), t1 = performance.now(); draw(true); gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array(4));
      stats.firstFrameMs = performance.now() - t1; stats.firstBindMs = t1 - t0; stats.firstFrameAt ??= Math.round(performance.now());
      if (toInteg) { const m = `${lab(k)} shown${modeNote}.`; say(m, false, true); setTimeout(() => { if (msgEl.textContent === m) say(""); }, 5000); } else say(""); announce(`${lab(k)} shown${modeNote}`); hostErr = null; lodStatus(); thumbLabel(); spinKick();
      setTimeout(() => { ensure().catch(() => {}); calibrate(); }, 0);
      return true;
    } catch (x) {
      if (tok !== loadTok) return false;
      progMsg = null; viewer.loadError = {key: k, message: x.message}; wanted = species; markSpecies(species || null);
      if (x instanceof HostError) hostMessage(x);
      else say(`Could not load ${lab(k)}: ${String(x.message).replace(/\.?$/, ".")}` + (species ? ` Still showing ${lab(species)}.` : ""), true);
      return false;
    }
  }
  /* fix-ui V8: the gas-field options carry the unit of what is drawn (a column in integral mode, a density in volume mode) */
  /* fix-ui V8 / Phase 3: each field button's tooltip names what is drawn and its unit (a column in integral mode) */
  function speciesUnits() { for (const i of ctlBox.querySelectorAll('input[name="v3-species"]')) { const f = fld(i.value), x = specOf(i.value); if (!f || !x) continue;
    const u = mode === "integral" && !weighted(i.value) ? (f.proj?.units || "cm^-2") : f.units;
    i.dataset.tip = fieldTip(x, mode, u); } }
  function setMode(m) { if (!["integral", "volume"].includes(m)) return false; if (m === mode) return true;
    if (!modeOk(wanted || species, m)) { markMode(mode); say("The line-of-sight dispersion is a property of the whole ray, so it has no volume view.", false, true); return false; }
    mode = m; markMode(m); speciesUnits();
    if (species) { syncTfInputs(); applyTf(); ensure().catch(() => {}); bindAll(); } else { aria(); render(); } tfUrl(); return true; }
  function setStars(o = {}) {
    if (o.on !== undefined) layer.stars = !!o.on && !!manifest?.stars;
    if (Number.isFinite(+o.mix) && o.mix !== null && o.mix !== undefined) layer.starMix = Math.min(1, Math.max(0, +o.mix));
    if (Number.isFinite(+o.Q) && o.Q) layer.Q = Math.min(40, Math.max(0.5, +o.Q));
    if (Number.isFinite(+o.sat) && o.sat !== null && o.sat !== undefined) layer.sat = Math.min(3, Math.max(0, +o.sat));
    if (Number.isFinite(+o.mu0) && o.mu0) layer.mu0 = Math.min(28, Math.max(14, +o.mu0));
    if (Number.isFinite(+o.gasMix) && o.gasMix !== null && o.gasMix !== undefined) layer.gasMix = Math.min(1, Math.max(0, +o.gasMix));
    q("#v3-stars").checked = layer.stars; q("#v3-starmix").value = layer.starMix; q("#v3-starmix-o").textContent = layer.starMix.toFixed(2);
    q("#v3-mu0").value = layer.mu0; q("#v3-mu0-o").textContent = layer.mu0.toFixed(1); q("#v3-gasmix").value = layer.gasMix; q("#v3-gasmix-o").textContent = layer.gasMix.toFixed(2); fillRanges();
    /* tune2: no star request before the first gas field is wanted, so a cold first load fetches the gas L1 cube first */
    if (manifest && (species || wanted)) { ensure().catch(x => { if (x instanceof HostError) hostMessage(x); }); bindAll(); }
    legend(); aria(); render(); viewer?.hooks?.starsChanged?.(layer.stars);
    return {...layer};
  }
  function setGuides(o = {}) { if (o.ring !== undefined) guides.visible = !!o.ring; if (o.scale !== undefined) scaleOn = !!o.scale;
    q(".v3d-leg .gd").hidden = !guides.visible; if (guides.visible) { ringR = 0; guideFit(); }
    q("#v3-guides").checked = guides.visible; q("#v3-scale").checked = scaleOn; render(); return {ring: guides.visible, scale: scaleOn}; }
  let scaleOn = true;

  /* vel3d: the Field card's rows follow the view: low / high (log windows) for the gas and ion fields; the ±W window and
     the Weight control for the velocity views; the colour list offers the diverging map for signed views */
  let cmapSet = "";
  function syncVelUi() { const v = velView(species), vs = !!v;
    q("#v3-lo-row").hidden = q("#v3-hi-row").hidden = vs; q("#v3-vw-row").hidden = q("#v3-weight-row").hidden = !vs;
    const want = !vs ? "field" : v.signed ? "signed" : "unsigned", names = want === "field" ? CMAPS : VEL_NAMES[want];
    if (cmapSet !== want) { const sel = q("#v3-cmap"); sel.textContent = ""; for (const c of names) { const o = document.createElement("option"); o.value = c; o.textContent = c; sel.appendChild(o); } cmapSet = want; }
    q("#v3-cmap").disabled = !manifest || names.length < 2; q("#v3-cmap-row").hidden = !!manifest && names.length < 2;   // a one-map list (signed views) is no choice: row hidden
    for (const i of ctlBox.querySelectorAll('input[name="v3-mode"]')) { const off = !manifest || !modeOk(species, i.value); i.disabled = off;
      i.dataset.tip = off && manifest ? "Integral only: the dispersion belongs to the whole ray"
        : i.value === "integral" ? (vs ? `Weighted ${species === "sigmalos" ? "spread" : "mean"} velocity along each ray` : "Projected map: column or weighted mean along each ray")
        : vs ? "Colour from the velocity, opacity from the weight density" : "Ray-marched emission and absorption through a transfer function"; }
    if (!vs) return;
    const s = fieldTf(species), r = q("#v3-vw"); r.min = VEL_WMIN; r.max = Math.max(VEL_WMIN, Math.round(VELI.V)); r.value = s.W;
    q("#v3-vw-o").textContent = v.signed ? `±${Math.round(s.W)}` : `${Math.round(s.W)}`; r.setAttribute("aria-valuetext", `${v.signed ? "plus or minus " : "0 to "}${Math.round(s.W)} km/s`);
    const ws = q("#v3-weight"); if (ws.options.length !== WEIGHTS.length) { ws.textContent = "";
      for (const k of WEIGHTS) { const o = document.createElement("option"); o.value = k; o.textContent = k === "nH" ? "nH (all gas)" : lab(k); ws.appendChild(o); } }
    ws.value = velW; }
  function syncTfInputs() { if (!manifest || !species) return; syncVelUi();
    if (isVel(species)) { const s = fieldTf(species); q("#v3-cmap").value = s.cmap; q("#v3-op").value = s.opacity; q("#v3-op-o").textContent = (+s.opacity).toFixed(2);
      q("#v3-op").disabled = mode !== "volume"; fillRanges(); syncTfCard(); return; }
    const s = fieldTf(species), [a, b] = winRange(species);
    for (const id of ["#v3-lo", "#v3-hi"]) { const i = q(id); i.min = a; i.max = b; }
    q("#v3-lo").value = s.lo; q("#v3-hi").value = s.hi; q("#v3-op").value = s.opacity; q("#v3-cmap").value = s.cmap;
    q("#v3-lo-o").textContent = (+s.lo).toFixed(1); q("#v3-hi-o").textContent = (+s.hi).toFixed(1); q("#v3-op-o").textContent = (+s.opacity).toFixed(2);
    q("#v3-op").disabled = mode !== "volume"; fillRanges(); syncTfCard(); }
  let lastCmap = null;
  function applyTf() { if (!manifest || !species) return; const s = fieldTf(species);
    U.uWin.value.set(s.lo, s.hi); U.uOpacity.value = +s.opacity; U.uMode.value = mode === "volume" ? 1 : 0; U.uKind.value = weighted(species) ? 1 : 0;
    U.uFadeDex.value = fadeDex(species); U.uVolK.value = VOL.k; U.uVolGain.value = VOL.gain;
    /* vel3d: the view, and the weight's log window: its column floor (the field's own integral low) in integral mode, its
       volume window in volume mode; the soft floor fades like the weight field's own map */
    const v = velView(species); U.uVq.value = v ? v.q : 0;
    if (v) { const f = fld(boundW); U.uKind.value = 0; U.uFadeDex.value = fadeDex(boundW); U.uVolGain.value = 1;   // gain 1: the velocity LUT is already light; 1.8 clipped its hues toward white
      if (mode === "volume") U.uWWin.value.set(...f.vol_window); else { const lo = WIN_DEFAULT[boundW]?.lo ?? f.proj.vmin; U.uWWin.value.set(lo, Math.max(lo + 1, WIN_DEFAULT[boundW]?.hi ?? f.proj.vmax)); } }
    if (s.cmap !== lastCmap) { RM.lutTex.image.data.set(lut(s.cmap)); RM.lutTex.needsUpdate = true; lastCmap = s.cmap; }
    applyTfMode(); legend(); aria(); render(); }
  /* ---- tf3d: transfer-function volume mode ----
     uTF = tf.js buildTF(state, colour map, state.win) (256 values x 64 gradient rows); the other uniforms from tfUniforms.
     Emission (raymarch.js): colour c and opacity from uTF at the colour field's log value (and gradient magnitude in 2D),
     times (w / w_ref)^gamma with w the emissivity field (bound as uW*) and log10 w_ref = a tenth of the way up its volume window
     (tf.js defaultWRef); uTFW stays 0 until a level of that field is bound, so the view never draws unweighted bands */
  const tfTex = RM.tfTex || (() => { const t = new T.DataTexture(new Uint8Array(TF_W * TF_H * 4), TF_W, TF_H, T.RGBAFormat, T.UnsignedByteType);
    t.minFilter = t.magFilter = T.LinearFilter; t.wrapS = t.wrapT = T.ClampToEdgeWrapping; t.needsUpdate = true; if (U.uTF) U.uTF.value = t; return t; })();
  let tfBaked = "", tfRow = null;
  function applyTfMode() { const on = !!manifest && tfOn();
    if (U.uTFOn) U.uTFOn.value = on ? 1 : 0; if (!on) return;
    const st = tfs[species], f = fld(species), cm = fieldTf(species, "volume").cmap, key = encodeTF(st) + "|" + cm;
    if (key !== tfBaked) { const b = buildTF(st, lut(cm), st.win); tfTex.image.data.set(b); tfTex.needsUpdate = true; tfBaked = key;
      /* the legend row: row 0, or in 2D per value the gradient row of highest opacity (row 0 of a gradient-limited band is empty) */
      tfRow = b.slice(0, TF_W * 4); if (st.twoD) for (let i = 0; i < TF_W; i++) for (let j = 1; j < TF_H; j++) { const o = 4 * (j * TF_W + i); if (b[o + 3] > tfRow[4 * i + 3]) tfRow.set(b.subarray(o, o + 4), 4 * i); } }
    const ek = emisKey(), u = tfUniforms(st, {vmin: f.vmin, vmax: f.vmax, wRef: ek ? defaultWRef(fld(ek)) : 0});
    if (!ek || !GAS_L.some(L => isBound(keyOf("gas", ek, L)))) { u.uTFW = 0; u.uGamma = 0; }
    for (const [k, v] of Object.entries(u)) if (U[k]) { if (Array.isArray(v)) U[k].value.set(...v); else U[k].value = v; } }
  /* the card: shown in volume mode for a scalar field; histogram of the finest of L1 / L0 loaded (L1 = the inner
     +-100 kpc), recomputed only when the field, window or gradient scale changes (soft = from bindAll: skip if unchanged) */
  let tfCardKey = "", tfH2 = {key: "", h: null};
  const tfLevel = k => TEX.get(keyOf("gas", k, "L1"))?.codes ? TEX.get(keyOf("gas", k, "L1")) : TEX.get(keyOf("gas", k, "L0"));
  function tfHist2(k, st) { const it = tfLevel(k), n = it?.sub ? Math.round(Math.cbrt(it.sub.length)) : 0; if (!n) return null;
    const l0 = it === TEX.get(keyOf("gas", k, "L0")) && !TEX.get(keyOf("gas", k, "L1"))?.codes;
    const f = fld(k), gm = st.gmax || GMAX_DEFAULT, key = `${k}|${n}|${l0}|${st.win}|${gm}`;
    /* the shader's gradient is in dex per L1 voxel (raymarch.js gradAt). The copy has half the resolution: its central
       differences span two voxels, so gmax doubles on L1; an L0 voxel is 4 L1 voxels wide, so on L0 it is 8 gmax */
    if (tfH2.key !== key) tfH2 = {key, h: histogram2D(it.sub, n, f.vmin, f.vmax, st.win, (l0 ? 8 : 2) * gm, 128, 32, 1)};
    return tfH2.h; }
  /* fix UX3: while the TF is on and has no ramp (Iso, THOR, custom bands) the Field card's low / high edit the TF window
     (st.win: the editor's x axis and uTFWin, a zoom); the colours select is off when every band has its own colour */
  const tfWinMode = () => !!species && tfOn() && !tfs[species].ramp;
  function tfWinUi() { if (!manifest || !species) return;
    if (isVel(species)) { q("#v3-cmap").disabled = false; q("#v3-cmap").dataset.tip = "Colour map of the velocity"; return; }
    const tw = tfWinMode(), ts = tfs[species], s = fieldTf(species), lo = tw ? ts.win[0] : s.lo, hi = tw ? ts.win[1] : s.hi;
    q("#v3-lo").value = lo; q("#v3-hi").value = hi; q("#v3-lo-o").textContent = (+lo).toFixed(1); q("#v3-hi-o").textContent = (+hi).toFixed(1);
    q("#v3-lo").dataset.tip = tw ? "Low edge of the transfer-function window, log10" : "Bottom of the colour scale, log10 of the field";
    q("#v3-hi").dataset.tip = tw ? "High edge of the transfer-function window, log10" : "Top of the colour scale, log10 of the field";
    const fixed = tfOn() && !ts.ramp && ts.bands.length > 0 && ts.bands.every(b => b.rgb), c = q("#v3-cmap");
    c.disabled = !manifest || fixed; c.dataset.tip = fixed ? "Set by the transfer function: each band has its colour" : "Colour map of the field";
    fillRanges(); }
  function setTfWin(lo, hi) { const ts = tfs[species], f = fld(species); let [a, b] = ts.win;
    if (lo !== null) a = Math.max(f.vmin, Math.min(lo, b - 0.1)); if (hi !== null) b = Math.min(f.vmax, Math.max(hi, a + 0.1));
    ts.win = [+a.toFixed(3), +b.toFixed(3)]; ts.preset = "custom"; tfCardKey = "";
    syncTfCard(); applyTfMode(); legend(); aria(); render(); tfUrl(); }
  function syncTfCard(soft = false) { tfWinUi();
    const show = !!manifest && !!species && mode === "volume" && tfOk(species);
    tfEd.el.hidden = !show; if (!show) { tfCardKey = ""; return; }
    const st = tfState(species), f = fld(species), cm = fieldTf(species, "volume").cmap, it = tfLevel(species);
    const key = `${species}|${encodeTF(st)}|${cm}|${it ? (it.sub ? "s" : "c") + it.bytes : ""}|${WEIGHTS.join()}`;
    if (soft && key === tfCardKey) return; tfCardKey = key;
    tfEd.set(st, {lut: lut(cm), field: lab(species), hist: it?.codes ? histWindow(it.codes, f.vmin, f.vmax, st.win[0], st.win[1], 128) : null,
      hist2: st.twoD ? tfHist2(species, st) : null, emis: WEIGHTS.map(k => ({value: k, label: k === "nH" ? "nH" : lab(k)}))}); }
  function onTfEdit(st, info) { if (!tfOk(species)) return;
    if (info.reason === "preset" || info.reason === "reset") { tfApplyPreset(info.reason === "reset" ? "ramp" : info.preset); return; }
    const was = emisKey(); tfs[species] = st; tfCardKey = "";
    /* the ramp's ends are the Field card's low / high (setTransfer moves the ramp from them): keep the two in step */
    if (st.ramp) { const s = fieldTf(species, "volume"), f = fld(species); s.lo = Math.max(f.vmin, Math.min(st.ramp.lo, f.vmax)); s.hi = Math.max(s.lo, Math.min(st.ramp.hi, f.vmax)); U.uWin.value.set(s.lo, s.hi); }
    tfWinUi();
    if (st.twoD) { const h2 = tfHist2(species, st); if (h2) tfEd.set(st, {hist2: h2}); }
    applyTfMode(); legend(); aria(); render();
    if (emisKey() !== was) { ensure().catch(() => {}); bindAll(); }
    if (info.commit) { tfUrl(); announce(tfWords()); } }
  const tfWords = () => { const st = tfs[species]; if (!tfOn()) return "transfer function: default ramp";
    return `transfer function: ${st.preset && st.preset !== "custom" ? st.preset : "custom"}, ${st.bands.length} band${st.bands.length === 1 ? "" : "s"}${st.twoD ? ", 2D" : ""}${st.shade ? `, shading ${st.shade.toFixed(2)}` : ""}${emisKey() ? `, emission weighted by ${wName(emisKey())} to the power ${st.gamma}` : ""}`; };
  /* a preset for the current field; THOR's "Gas phases" is a T preset with n_H emissivity: it switches the field to T */
  function tfApplyPreset(name) {
    if (name === "thor" && species !== THOR.field) { if (!tfOk(THOR.field)) return false;
      tfs[THOR.field] = tfPreset("thor", tfCtx(THOR.field));
      setSpecies(THOR.field).then(ok => { if (ok) { syncTfCard(); tfUrl(); announce(tfWords()); } }); return true; }
    if (!tfOk(species)) return false;
    const was = emisKey(); tfs[species] = tfPreset(name, tfCtx(species)); tfCardKey = "";
    syncTfCard(); applyTfMode(); legend(); aria(); render(); if (emisKey() !== was) { ensure().catch(() => {}); bindAll(); }
    tfUrl(); announce(tfWords()); return true; }
  /* URL: ?tf=<field>~<tf.js encodeTF> while volume mode is on (the search part: the page's own hash writes keep it) */
  function tfUrl() { try {
    const on = !!species && mode === "volume" && (tfOk(species) || isVel(species)), val = on ? species + "~" + (tfOk(species) ? encodeTF(tfState(species), tfCtx(species)) : "") : "";
    const parts = location.search.replace(/^\?/, "").split("&").filter(x => x && !x.startsWith("tf="));
    if (val) parts.push("tf=" + val.replace(/~$/, ""));
    const search = parts.length ? "?" + parts.join("&") : "";
    if (search !== location.search) history.replaceState(history.state, "", location.pathname + search + location.hash); } catch { /* sandboxed */ } }
  const tfBoot = (() => { try { const raw = location.search.replace(/^\?/, "").split("&").find(x => x.startsWith("tf="));
    if (!raw) return null; const v = decodeURIComponent(raw.slice(3)), i = v.indexOf("~");
    return {k: i > 0 ? v.slice(0, i) : v, enc: i > 0 ? v.slice(i + 1) : ""}; } catch { return null; } })();
  function setTransfer(o = {}) { if (!species) return;
    if (isVel(species)) {   // vel3d: {W} (km/s, the symmetric window ±W, or 0..W), opacity, cmap from the view's list
      const v = velView(species), s = fieldTf(species), names = v.signed ? VEL_NAMES.signed : VEL_NAMES.unsigned;
      if (o.W !== undefined && o.W !== null && Number.isFinite(+o.W)) s.W = Math.min(Math.max(+o.W, VEL_WMIN), Math.max(VEL_WMIN, VELI.V));
      if (o.opacity !== undefined && o.opacity !== null && Number.isFinite(+o.opacity)) s.opacity = Math.min(Math.max(+o.opacity, 0), 1);
      if (o.cmap && names.includes(o.cmap)) s.cmap = o.cmap;
      s.lo = v.signed ? -s.W : 0; s.hi = s.W; syncTfInputs(); applyTf(); return; }
    const s = fieldTf(species), [a, b] = winRange(species);
    for (const k of ["lo", "hi", "opacity"]) if (o[k] !== undefined && o[k] !== null && Number.isFinite(+o[k])) s[k] = +o[k];
    s.lo = Math.min(Math.max(s.lo, a), b); s.hi = Math.min(Math.max(s.hi, a), b); s.opacity = Math.min(Math.max(s.opacity, 0), 1);
    if (o.cmap && CMAPS.includes(o.cmap)) s.cmap = o.cmap; if (s.lo > s.hi) [s.lo, s.hi] = [s.hi, s.lo];
    /* tf3d: in volume mode the low / high window also moves the TF ramp (Default ramp, Clouds), so they keep working */
    const ts = mode === "volume" && tfs[species]; if (ts?.ramp) { const was = tfOn(); ts.ramp.lo = s.lo; ts.ramp.hi = s.hi; if (!was && ts.preset !== "ramp") ts.preset = "custom"; }
    syncTfInputs(); applyTf(); }
  /* vel3d: the weight field in words (legend, aria, Weight options) */
  const wName = (k, html) => (k === "nH" ? (html ? "n<sub>H</sub>" : "nH") : lab(k));
  function velLegend(L) { const v = velView(species), s = fieldTf(species), integ = mode === "integral";
    const what = species === "sigmalos" ? "dispersion along your view" : `⟨${v.html}⟩`;
    L.querySelector(".ttl").innerHTML = integ ? `${what}, ${wName(boundW, true)}-weighted [km/s]` : `${v.html} [km/s], volume, opacity ${wName(boundW, true)}`;
    L.querySelector(".bar").style.background = cssGradient(s.cmap);
    const tk = L.querySelector(".ticks"); tk.textContent = ""; const span = s.hi - s.lo || 1;
    const st = [10, 20, 25, 50, 100, 200, 250, 500, 1000].find(x => span / x <= 4.01) || 1000;
    for (let x = Math.ceil(s.lo / st - 1e-9) * st; x <= s.hi + 1e-9; x += st) { const sp = document.createElement("span");
      sp.style.left = Math.min(96, Math.max(4, 100 * (x - s.lo) / span)) + "%"; sp.textContent = (x < -1e-9 ? "−" : x > 1e-9 && v.signed ? "+" : "") + Math.round(Math.abs(x)); tk.appendChild(sp); }
    const ends = L.querySelector(".ends"); ends.hidden = !v.words;
    if (v.words) { ends.children[0].textContent = v.words[0]; ends.children[1].textContent = v.words[1]; } }
  /* vel3d: the Weight control: n_H (all gas) or an ion density; its cubes load like a field's, the view redraws once bound */
  function setWeight(k) { if (!WEIGHTS.includes(k)) return false; if (k === velW) return true; velW = k;
    if (species && isVel(species) && isVel(wanted || species)) { syncTfInputs(); const tok = loadTok;   // the old weights (boundW) stay bound and drawn until the new first level is
      say(`loading the ${wName(k)} weights…`, false, false, "", true);
      ensure().then(() => { if (tok !== loadTok || velW !== k) return;
          /* also wait for the new weight at every finer level the old one is drawn at (when the plan names it), so the
             switch keeps the view's levels; a level that fails or leaves the plan is not waited for */
          const more = GAS_L.filter(L => isBound(keyOf("gas", boundW, L)) && plan.includes(keyOf("gas", k, L))).map(L => waitKey(keyOf("gas", k, L)).catch(() => {}));
          return Promise.all(more).then(() => { if (tok !== loadTok || velW !== k) return;
            boundW = k; bindAll(true); clearProg(); applyTf(); announce(`weighted by ${wName(k)}`); }); })
        .catch(x => { if (x.cancelled || velW !== k) return;
          velW = boundW; syncTfInputs(); ensure().catch(() => {});   // keep drawing the old weight
          if (x instanceof HostError) hostMessage(x); else say(`Could not load the ${wName(k)} weights: ${x.message}`, true); }); }
    else { if (!isVel(species)) boundW = k;   // a velocity view still shown while another field loads keeps boundW until setSpecies switches it
      if (q("#v3-weight")) q("#v3-weight").value = k; }
    return true; }
  function legend() { const L = q(".v3d-leg"); if (!manifest || !species) { L.hidden = true; return; }
    if (isVel(species)) { L.hidden = false; velLegend(L); legendTail(L); return; }
    L.querySelector(".ends").hidden = true;
    const f = fld(species), s = fieldTf(species); L.hidden = false;
    const integ = mode === "integral", units = integ ? (weighted(species) ? f.units : (f.proj.units || "cm^-2")) : f.units;
    const esc = t => String(t).replace(/[&<>]/g, c => ({"&": "&amp;", "<": "&lt;", ">": "&gt;"})[c]);
    L.querySelector(".ttl").innerHTML = integ ? `log₁₀ ${COL_HTML[species] || esc(COL_TXT[species] || `N(${lab(species)})`)} [${esc(pretty(units))}]` : `log₁₀ ${VOL_HTML[species] || esc(isIon(species) ? `n(${lab(species)})` : lab(species))} [${esc(pretty(units))}], volume`;
    L.querySelector(".bar").style.background = cssGradient(s.cmap);
    /* tf3d: in TF mode the bar is the transfer function itself (colour at its opacity over the stage) over the TF window */
    let lo = s.lo, hi = s.hi;
    if (tfOn() && tfRow) { const w = tfs[species].win; lo = w[0]; hi = w[1]; const e = emisKey();
      L.querySelector(".ttl").innerHTML += `, transfer function${e ? `, emission ∝ ${wName(e, true)}${+tfs[species].gamma.toFixed(1) === 1 ? "" : `<sup>${+tfs[species].gamma.toFixed(1)}</sup>`}` : ""}`;
      const stops = []; for (let i = 0; i <= 32; i++) { const o = 4 * Math.round(i / 32 * (TF_W - 1)), a = tfRow[o + 3] / 255, mix = (c, b) => Math.round(b + (c - b) * Math.min(1, 1.6 * a));
        stops.push(`rgb(${mix(tfRow[o], 5)},${mix(tfRow[o + 1], 7)},${mix(tfRow[o + 2], 11)}) ${(100 * i / 32).toFixed(1)}%`); }
      L.querySelector(".bar").style.background = `linear-gradient(90deg,${stops.join(",")})`; }
    const tk = L.querySelector(".ticks"); tk.textContent = ""; const span = hi - lo || 1, st = span > 6 ? 2 : span > 2.5 ? 1 : span > 1.2 ? 0.5 : span > 0.5 ? 0.2 : 0.1;
    for (let v = Math.ceil(lo / st) * st; v <= hi + 1e-9; v += st) { const sp = document.createElement("span");
      sp.style.left = Math.min(96, Math.max(4, 100 * (v - lo) / span)) + "%"; sp.textContent = (v < -1e-9 ? "−" : "") + Math.abs(+v.toFixed(1)); tk.appendChild(sp); }
    legendTail(L); }
  function legendTail(L) {
    const stl = L.querySelector(".st"); stl.hidden = !layer.stars; L.querySelector(".off").hidden = layer.stars || !manifest.stars; lastMuTxt = ""; starLegend();
    /* final: with the gas layer at 0 the gas colour bar describes nothing on screen: hide it (and the legend, if stars are off too) */
    const gasOn = layer.gasMix > 0; for (const s2 of [".ttl", ".bar", ".ticks"]) L.querySelector(s2).hidden = !gasOn;
    if (!gasOn) { L.querySelector(".ends").hidden = true; L.querySelector(".off").hidden = true; if (!layer.stars) L.hidden = true; } }
  function aria() { const f = manifest && species ? fld(species) : null, s = f || (species && isVel(species)) ? fieldTf(species) : null, lv = levels();
    const fin = GAS_L.filter(L => lv.gas[L] === "bound").pop(), sfin = STAR_L.filter(S => lv.stars[S] === "bound").pop();
    const v = manifest && species ? velView(species) : null;
    const what = v ? `: ${v.long}, ${wName(boundW)}-weighted, window ${Math.round(s.lo)} to ${Math.round(s.hi)} km/s${v.words ? ` (${v.words[0]} to ${v.words[1]})` : ""}`
      : f ? `: ${lab(species)}, window ${s.lo.toFixed(1)} to ${s.hi.toFixed(1)} log ${pretty(mode === "integral" && !weighted(species) ? "cm^-2" : f.units)}${tfOn() ? `; ${tfWords()}` : ""}` : "";
    const al = `3D view, ${mode} mode${what}` +
      `; stars ${layer.stars ? "on" : "off"}; finest level ${fin || "none"}${layer.stars ? `, stars ${sfin || "none"}` : ""}` +
      `; ${LINE_IDS.length} sightlines drawn${nNoEnds ? ` (${nNoEnds} more have no stored endpoints)` : ""}${selId ? `; selected ${selId}${hasEnds(app.entry(selId)) ? "" : " (not drawn: no stored endpoints)"}` : ""}.` +
      ` Arrow keys rotate, + and − zoom, F face-on, E edge-on, A along the selected sightline, R reset, C re-centre on the galaxy, double-click to orbit there, P pick a ray, M mode, S stars, G guides, Shift+F fullscreen.` +
      (offCentre(pivotArr()) ? ` Orbit centre ${pivotArr().map(fmtKpc).join(", ")} kpc.` : "");
    if (canvas.getAttribute("aria-label") !== al) canvas.setAttribute("aria-label", al); }

  /* ---- render on demand: moving frames (spv 0.5, half resolution) then one exact refine frame ---- */
  let rq = false, moving = false, quietT = null, frameNo = 0, curPR = PR, accK = 0, accT = 0;
  function render() { accK = 0; if (accT) { cancelAnimationFrame(accT); accT = 0; } if (rq) return; rq = true;
    requestAnimationFrame(now => { rq = false; draw(!moving); if (stepFades(now)) render(); else if (!moving) refineLater(); }); }
  /* tune2: progressive refine frames while the view is still (each blends 1/(k+1) into the accumulation target) */
  function refineLater() { if (accT) return; accT = requestAnimationFrame(() => { accT = 0;
    if (moving || rq || accK === 0 || accK >= Math.min(ACC_N, docked === "thumb" ? THUMB.acc : accMax) || spinRaf || document.hidden || ctxLost) return; draw(true, true); refineLater(); }); }
  function setPR(pr) { if (Math.abs(pr - curPR) < 1e-6) return; curPR = pr; renderer.setPixelRatio(pr); renderer.setSize(stage.clientWidth || 600, stage.clientHeight || 400, false); }
  function motion() { moving = true; clearTimeout(quietT); quietT = setTimeout(() => { moving = false; render(); }, 150); render(); }
  const accSize = new T.Vector2();
  function draw(exact = true, acc = false) {
    const th = docked === "thumb"; setPR(th ? PR : exact ? exactPR : Math.min(PR * 0.5, exactPR));
    if (!acc) accK = 0;
    /* tune3: half-voxel steps for exact frames in close views (L2), so the finest grid shows no step banding */
    U.uSpv.value = th ? THUMB.spv : exact ? (hVis() < 30 ? 2.0 : 1.0) : 0.5; U.uStarFloor.value = STAR_COMP.floor; U.uCompMode.value = STAR_COMP.mode; U.uOccRange.value.set(...[0, 1].map(i => STAR_CLOSE.occ[i] + (STAR_ZOOM.occWide[i] - STAR_CLOSE.occ[i]) * zoomW())); U.uGasW.value = STAR_CLOSE.gasW + (1 - STAR_CLOSE.gasW) * zoomW(); U.uExact.value = exact || useMovingExact ? 1 : 0;
    const c = camera.position; U.uCamDisk.value.set(c.dot(Xv), c.dot(Yv), c.dot(Lv)); U.uFrame.value = (++frameNo) % 1024;
    U.uGasMix.value = species ? layer.gasMix : 0; U.uStarMix.value = layer.stars ? layer.starMix : 0;
    U.uStarQ.value = layer.Q; U.uStarSat.value = layer.sat; U.uStarS0.value = 10 ** (0.4 * (MU_ZERO - mu0Eff())); U.uStarBal.value.set(...layer.balance);
    if (guides.visible) guideFit();
    selUniforms();
    renderer.getDrawingBufferSize(accSize); U.uPxAng.value = 2 * Math.tan(camera.fov * Math.PI / 360) / Math.max(accSize.y, 1);
    U.uLodC.value.set(species ? lodField(species) : LOD_C.gas, LOD_C.stars);
    const dT = camera.position.distanceTo(controls.target); U.uNear.value.set(NEAR[0] * dT, NEAR[1] * dT);
    if (exact) {
      if (accRT.width !== accSize.x || accRT.height !== accSize.y) { accRT.setSize(accSize.x, accSize.y); accK = 0; }
      const k = accK, [sx, sy] = SUB[k % ACC_N]; U.uSub.value.set(2 * sx / accSize.x, 2 * sy / accSize.y); U.uAccW.value = 1 / (k + 1);
      renderer.setRenderTarget(accRT); if (k === 0) renderer.clear(true, false, false);
      renderer.autoClear = false; renderer.render(volScene, camera); renderer.setRenderTarget(null);
      renderer.autoClear = true; renderer.render(blitScene, blitCam); accK = k + 1;
    } else { U.uSub.value.set(0, 0); U.uAccW.value = 1; renderer.autoClear = true; renderer.render(volScene, camera); }
    renderer.autoClear = false; renderer.render(scene, camera); renderer.autoClear = true; scale();
  }
  let ringR = 0;
  function guideFit() {
    ring.quaternion.copy(camera.quaternion);
    const hv = hVis(), hh = hv * Math.min(camera.aspect || 1, 1);       // the smaller half-extent of the view at the target
    const r = frame.R200c <= 0.92 * hh ? frame.R200c : [200, 100, 50, 20, 10, 5, 2, 1].find(v => v <= 0.8 * hh) || 1;
    ring.scale.setScalar(r / frame.R200c);
    const len = Math.min(150, 0.7 * hv); arrow.setLength(len, 0.16 * len, 0.08 * len);
    if (r !== ringR) { ringR = r; const g = q(".v3d-leg .gd");
      g.innerHTML = r === frame.R200c ? `<i></i>guides: ring R<sub>200c</sub> = ${Math.round(r)} kpc<br><i></i>arrow: disk normal`
        : `<i></i>guides: ring ${r} kpc (R<sub>200c</sub> = ${Math.round(frame.R200c)} kpc is off-screen)<br><i></i>arrow: disk normal`; } }
  /* tune4: 0 in close views → 1 in wide views (STAR_ZOOM) */
  function zoomW() { const t = Math.min(1, Math.max(0, (hVis() - STAR_ZOOM.h[0]) / (STAR_ZOOM.h[1] - STAR_ZOOM.h[0]))); return t * t * (3 - 2 * t); }
  function mu0Eff() { return layer.mu0 + STAR_ZOOM.dmag[0] + (STAR_ZOOM.dmag[1] - STAR_ZOOM.dmag[0]) * zoomW(); }
  var lastMuTxt = "";   // var: legend() may run before this line is reached
  function starLegend() { const t = `stars: g, r, i asinh (Q ${layer.Q}, μ₀,eff ${mu0Eff().toFixed(1)} mag/″²)`;
    if (t !== lastMuTxt) { q(".v3d-leg .st span").textContent = lastMuTxt = t; } }
  function scale() {   // a round length at the orbit target's distance, in CSS px
    const sc = q(".v3d-scale"), d = camera.position.distanceTo(controls.target), pxPerKpc = stage.clientHeight / (2 * d * Math.tan(camera.fov * Math.PI / 360));
    let L = [1, 2, 5, 10, 20, 50, 100, 200, 500].find(v => v * pxPerKpc >= 60) || 500;
    starLegend(); sc.hidden = !scaleOn; sc.querySelector("i").style.width = (L * pxPerKpc).toFixed(1) + "px"; sc.querySelector("span").textContent = `${L} kpc`; }
  function resize() { const p = calcPR(); if (Math.abs(p - PR) > 1e-6) { PR = exactPR = p; calibrated = ""; }
    const w = stage.clientWidth || 600, h = stage.clientHeight || 400; renderer.setSize(w, h, false); camera.aspect = w / h; camera.updateProjectionMatrix(); render(); }
  let dprMq = null; const onDpr = () => { watchDpr(); resize(); };
  function watchDpr() { try { dprMq?.removeEventListener("change", onDpr); dprMq = matchMedia(`(resolution: ${devicePixelRatio || 1}dppx)`); dprMq.addEventListener("change", onDpr); } catch { dprMq = null; } }
  watchDpr();
  const ro = new ResizeObserver(resize); ro.observe(stage);
  controls.addEventListener("change", motion);
  let lastH = 0;
  controls.addEventListener("end", () => { const h = hVis(); if (Math.abs(h - lastH) / Math.max(h, 1) > 0.02) { lastH = h;
    if (selId) select(selId, true); if (manifest && species) ensure().catch(() => {}); } });

  /* moving-frame path (design §5.5): exact samples while moving if they reach 30 fps, else the hardware path */
  function timeFrames(n, exact, movingExact) {
    const gl = renderer.getContext(), px = new Uint8Array(4), ts = [], keep = useMovingExact; useMovingExact = movingExact;
    for (let i = 0; i < n; i++) { const off = camera.position.clone().sub(controls.target).applyAxisAngle(camera.up, 2 * Math.PI / Math.max(n, 12));
      camera.position.copy(controls.target).add(off); camera.lookAt(controls.target);
      const t0 = performance.now(); draw(exact); gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px); ts.push(performance.now() - t0); }
    useMovingExact = keep; return ts;
  }
  function calibrate() {
    if (docked !== "full") return;     // Phase 3: calibrated on the full stage only (dock() calls it)
    const sig = JSON.stringify(levels()); if (!species || sig === calibrated) return; calibrated = sig;
    const p0 = camera.position.clone(); const t = median(timeFrames(5, false, true)); camera.position.copy(p0); camera.lookAt(controls.target); controls.update();
    useMovingExact = t <= 1000 / 30; stats.calibration = {moving_exact_ms: t, moving_path: useMovingExact ? "exact" : "fast"};
    /* fix-ui FE-09: on drawing buffers larger than the benchmarked 1366×702 (fullscreen, high DPR) time two exact frames and
       scale the exact-frame pixel ratio so one costs about EXACT_MS; slow exact frames also get fewer refine frames */
    const bufPx = stage.clientWidth * stage.clientHeight * PR * PR;
    if (bufPx > 1.3e6) { const te = median(timeFrames(2, true, true)); camera.position.copy(p0); camera.lookAt(controls.target); controls.update();
      const pr0 = exactPR; if (te > EXACT_MS) exactPR = Math.max(Math.min(PR, 0.75), Math.min(PR, pr0 * Math.sqrt(EXACT_MS / te)));
      accMax = te * (exactPR / pr0) ** 2 > 1.5 * EXACT_MS ? 3 : ACC_N; Object.assign(stats.calibration, {exact_ms: te, exact_pr: exactPR, refine_frames: accMax}); }
    else { exactPR = PR; accMax = ACC_N; }
    draw(true);
  }
  async function bench(n = 60) {
    const p0 = camera.position.clone(), r = {size: [canvas.width, canvas.height], pixelRatio: PR};
    const ex = timeFrames(Math.max(5, Math.round(n / 4)), true, true);
    const mvE = timeFrames(n, false, true), mvF = timeFrames(n, false, false);
    camera.position.copy(p0); camera.lookAt(controls.target); controls.update();
    Object.assign(r, {exact_ms_median: median(ex), moving_exact_ms_median: median(mvE), moving_fast_ms_median: median(mvF),
      moving_px: [Math.round(canvas.width * 0.5), Math.round(canvas.height * 0.5)], levels: levels(), gpu_bytes: gpuBytes()});
    useMovingExact = r.moving_exact_ms_median <= 1000 / 30; r.moving_path = useMovingExact ? "exact" : "fast";
    r.ms_per_frame = r.moving_exact_ms_median; r.fps = 1000 / (useMovingExact ? r.moving_exact_ms_median : r.moving_fast_ms_median);
    setPR(PR); draw(true); stats.bench = r; return r;
  }

  /* ---- presets ---- */
  let anim = 0;
  const DEF_D = 520;            // tune2: was 420 at 40°; at 22° the field spans about ±100 kpc (the L1 box) vertically
  /* tune4: the default camera keeps 60° from the disk normal but sits at azimuth 60° from xhat (was 0°): the page's default
     sightline (edge_b100_a090, along xhat 100 kpc above the disk) then projects about 83 kpc from the centre instead of
     straight through the disk, and the disk is seen from the same inclination */
  const DEF_AZ = 60 * Math.PI / 180;
  const DEF_DIR = Lv.clone().multiplyScalar(0.5).addScaledVector(Xv, 0.866 * Math.cos(DEF_AZ)).addScaledVector(Yv, 0.866 * Math.sin(DEF_AZ)).normalize();
  const upFor = dir => { const u = Lv.clone().addScaledVector(dir, -Lv.dot(dir)); return u.length() > 1e-6 ? u.normalize() : Yv.clone(); };
  function goTo(pos, target, up) {
    const id = ++anim, p0 = camera.position.clone(), t0 = controls.target.clone(), u0 = camera.up.clone(), start = performance.now(), dur = reduced() ? 0 : 550;
    const step = now => { if (id !== anim) return; const f = dur ? Math.min(1, (now - start) / dur) : 1, e = f < 0.5 ? 2 * f * f : 1 - (-2 * f + 2) ** 2 / 2;
      camera.position.lerpVectors(p0, pos, e); controls.target.lerpVectors(t0, target, e); camera.up.lerpVectors(u0, up, e).normalize();
      camera.lookAt(controls.target); controls.update(); if (f < 1) requestAnimationFrame(step);
      else { if (selId) select(selId, true); if (manifest && species) ensure().catch(() => {}); syncPivot(true); } };
    requestAnimationFrame(step);
  }
  function setPreset(p) {
    /* ux4 pivot: face-on and edge-on turn about the current orbit centre; Reset also brings it back to the galaxy */
    const o = new T.Vector3(), c0 = controls.target.clone(), D = Math.min(4700, Math.max(110, camera.position.distanceTo(controls.target))); clearTransient(); viewer.presetError = null;
    if (p === "face-on") goTo(c0.clone().addScaledVector(Lv, D), c0, Yv.clone());
    else if (p === "edge-on") goTo(c0.clone().addScaledVector(Xv, D), c0, Lv.clone());
    else if (p === "sightline") { const e = selId && app.entry(selId);
      if (!hasEnds(e)) { viewer.presetError = e ? NO_ENDPOINTS(e.id) : "select a sightline first"; say(viewer.presetError, true, true); return false; }
      const a = V3(e.p0), b = V3(e.p1), n = b.clone().sub(a).normalize(), c = a.clone().addScaledVector(n, -a.dot(n));
      let side = c.length() > 1 ? c.clone().normalize() : Lv.clone().sub(n.clone().multiplyScalar(Lv.dot(n)));
      if (side.length() < 1e-6) side = new T.Vector3(1, 0, 0).cross(n); side.normalize();
      let up = Lv.clone().sub(side.clone().multiplyScalar(Lv.dot(side))); if (up.length() < 1e-6) up = n.clone(); up.normalize();
      goTo(c.clone().addScaledVector(side, Math.max(D, 1100)), c, up); }
    else goTo(DEF_DIR.clone().multiplyScalar(DEF_D), o, upFor(DEF_DIR));
    return true;
  }
  camera.position.copy(DEF_DIR.clone().multiplyScalar(DEF_D)); camera.up.copy(upFor(DEF_DIR)); camera.lookAt(0, 0, 0); controls.update(); lastH = hVis();

  /* ---- ux4 pivot (see PIVOT above): the orbit centre is controls.target. pivotTo slides camera and target together
     (same direction and distance), animated like the presets (instant under reduced motion). Right-drag panning and
     "Along ray" move it too; the chip and the View card follow whatever the target is. ---- */
  const toDisk = v => [v.dot(Xv), v.dot(Yv), v.dot(Lv)];
  const fromDisk = a => Xv.clone().multiplyScalar(a[0]).addScaledVector(Yv, a[1]).addScaledVector(Lv, a[2]);
  function pivotArr() { return [controls.target.x, controls.target.y, controls.target.z]; }   // declarations: aria() reads them
  function fmtKpc(x) { return (x < 0 && Math.round(x) !== 0 ? "−" : "") + Math.abs(Math.round(x)); }
  function pivotTo(p, why = "") {
    const t = Array.isArray(p) ? V3(p) : p.clone ? p.clone() : new T.Vector3();
    if (t.length() > PIVOT.max * Math.sqrt(3)) t.setLength(PIVOT.max * Math.sqrt(3));
    const off = camera.position.clone().sub(controls.target); clearTransient();
    goTo(t.clone().add(off), t, camera.up.clone()); pivotWhy = why; return true;
  }
  const recentre = () => pivotTo([0, 0, 0], "galaxy");
  let pivotWhy = "", pivotShown = null, pivotUrlLast = null;
  /* chip, View-card state, kpc fields; url: also write ?pv= (on settle, not on every pan frame) */
  function syncPivot(url = false) {
    const p = pivotArr(), off = offCentre(p), chip = q("#v3-pivot");
    if (off !== pivotShown) { pivotShown = off; chip.hidden = !off || docked !== "full"; q("#v3-pv-gal").setAttribute("aria-pressed", String(!off)); aria(); }
    else if (chip.hidden !== (!off || docked !== "full")) chip.hidden = !off || docked !== "full";
    const e = selId && app.entry(selId), onRay = off && hasEnds(e) && V3(rayPivot(e.p0, e.p1)).distanceTo(controls.target) < 1;
    q("#v3-pv-ray").setAttribute("aria-pressed", String(!!onRay)); q("#v3-pv-ray").disabled = !hasEnds(e);
    if (!url) return;
    for (const [i, a] of ["x", "y", "z"].entries()) { const inp = q("#v3-pv-" + a); if (document.activeElement !== inp) inp.value = off ? String(Math.round(p[i])) : ""; }
    const val = formatPivot(p);
    if (val !== pivotUrlLast) { pivotUrlLast = val;
      if (pivotWhy) announce(off ? `Orbit centre ${p.map(x => fmtKpc(x)).join(", ")} kpc${pivotWhy === "ray" ? ", on the sightline" : ""}` : "Orbit centre back on the galaxy");
      try { const parts = location.search.replace(/^\?/, "").split("&").filter(x => x && !x.startsWith("pv="));
        if (val) parts.push("pv=" + val);
        const search = parts.length ? "?" + parts.join("&") : "";
        if (search !== location.search) history.replaceState(history.state, "", location.pathname + search + location.hash); } catch { /* sandboxed */ } }
    pivotWhy = "";
  }
  /* double-click: the densest sample of the shown field along the clicked ray (half-resolution L1 / L0 copies kept for
     the TF histograms; a velocity view reads its weight field), else the point on the plane through the current centre
     facing the camera */
  function pickPivot(cx, cy) {
    const r = canvas.getBoundingClientRect(), ndc = new T.Vector3((cx / r.width) * 2 - 1, 1 - (cy / r.height) * 2, 0.5);
    const o = camera.position.clone(), d = ndc.unproject(camera).sub(o).normalize();
    const fk = species && (isVel(species) ? wKey(species) || "nH" : species);
    const cubes = fk ? ["L1", "L0"].map(L => { const it = TEX.get(keyOf("gas", fk, L)), m = (manifest?.levels?.[L]?.n || 256) >> 1;
      return it?.sub && it.sub.length === m * m * m ? {data: it.sub, m, half: half(L)} : null; }).filter(Boolean) : [];
    const hit = U.uGasMix.value > 0 ? pickAlongRay(toDisk(o), toDisk(d), cubes, 2) : null;
    if (hit) return fromDisk(hit.p);
    const n = camera.getWorldDirection(new T.Vector3()), pp = planePoint(o.toArray(), d.toArray(), pivotArr(), n.toArray());
    return pp ? V3(pp) : null;
  }
  function pivotToRay() { const e = selId && app.entry(selId);
    if (!hasEnds(e)) { say(e ? NO_ENDPOINTS(e.id) : "select a sightline first", true, true); return false; }
    return pivotTo(rayPivot(e.p0, e.p1), "ray"); }
  { const boot = (() => { try { const raw = location.search.replace(/^\?/, "").split("&").find(x => x.startsWith("pv="));
      return raw ? parsePivot(decodeURIComponent(raw.slice(3))) : null; } catch { return null; } })();
    if (boot) { const t = V3(boot); camera.position.copy(t).addScaledVector(DEF_DIR, DEF_D); controls.target.copy(t); camera.lookAt(t); controls.update(); pivotUrlLast = formatPivot(boot); } }

  /* ---- picking a line: nearest within 8 px in screen space ---- */
  const viewer = {webgl2: true, THREE: T, camera, scene, renderer, controls, frame, canvas, el: stage, hooks: {}, picking: false, stats,
    lod: LOD_C, uniforms: U,
    presetError: null, loadError: null, get manifest() { return manifest; }, get species() { return species; },
    get res() { const lv = levels(); return GAS_L.filter(L => lv.gas[L] === "bound").pop() || null; }, get wanted() { return wanted; },
    get mode() { return mode; }, get weight() { return velW; }, get weightBound() { return boundW; }, get velocity() { return VELI; }, get message() { return msgEl.textContent; }, get fullscreen() { return isFs(); }, get stars() { return layer.stars; },
    tune: {SMOOTH, WIN_DEFAULT, FADE_DEX, VOL, SEL_GAL, CMAP_DEFAULT, STAR_COMP, STAR_ZOOM, STAR_CLOSE, LOD_C}};
  function nearestLine(x, y, maxPx = 8) {
    const r = canvas.getBoundingClientRect(), v = new T.Vector3(); let best = null, bd = maxPx;
    const toS = p => { v.set(p[0], p[1], p[2]).applyMatrix4(camera.matrixWorldInverse); if (v.z > -camera.near) return null;
      v.applyMatrix4(camera.projectionMatrix); return [(v.x + 1) / 2 * r.width, (1 - v.y) / 2 * r.height]; };
    if (!lines.visible) return null;
    LINE_P.forEach(([p0, p1], i) => { const a = toS(p0), b = toS(p1); if (!a || !b) return;
      const dx = b[0] - a[0], dy = b[1] - a[1], L2 = dx * dx + dy * dy, t = L2 ? Math.max(0, Math.min(1, ((x - a[0]) * dx + (y - a[1]) * dy) / L2)) : 0;
      const d = Math.hypot(x - a[0] - t * dx, y - a[1] - t * dy); if (d < bd) { bd = d; best = LINE_IDS[i]; } });
    return best;
  }
  let down = null;
  canvas.addEventListener("pointerdown", ev => { down = {x: ev.clientX, y: ev.clientY, t: performance.now()}; });
  canvas.addEventListener("pointerup", ev => { if (!down || viewer.picking || docked !== "full") { down = null; return; }
    const moved = Math.hypot(ev.clientX - down.x, ev.clientY - down.y), dt = performance.now() - down.t; down = null;
    if (moved >= (ev.pointerType === "touch" ? 6 : 5) || dt >= 400) return;
    const r = canvas.getBoundingClientRect(), id = nearestLine(ev.clientX - r.left, ev.clientY - r.top, ev.pointerType === "touch" ? 14 : 8);
    if (id) app.select(id, {source: "3d"}); });

  /* ---- fullscreen: Fullscreen API on .v3d (stage + controls), CSS fallback with its own Esc ---- */
  const fsEl = () => document.fullscreenElement || document.webkitFullscreenElement || null;
  let fallbackFs = false, fsExitAt = 0, fsScroll = null;   // fsScroll: page scroll saved on entering fullscreen (tune2)
  const isFs = () => fsEl() === el || fallbackFs;
  function fsChanged() {
    if (fallbackFs && fsEl() === el) { fallbackFs = false; el.classList.remove("v3d-fs"); document.body.classList.remove("v3d-noscroll"); removeEventListener("keydown", onFsKey, true); setInert(false); }
    const on = isFs(); if (!on) fsExitAt = performance.now();
    if (!on && fsScroll) { const [x, y] = fsScroll; fsScroll = null;   // back to where the page was (after the layout settles)
      requestAnimationFrame(() => requestAnimationFrame(() => scrollTo({left: x, top: y, behavior: "instant"}))); }
    q("#v3-fs span").textContent = on ? "Exit fullscreen" : "Fullscreen"; q("#v3-fs").setAttribute("aria-pressed", String(on));
    /* Phase 3: the control column lives beside the stage; in fullscreen it moves onto it as the closable panel, and back */
    if (on && ctlBox.parentNode !== el) { ctlHome = [ctlBox.parentNode, ctlBox.nextSibling]; el.appendChild(ctlBox); }
    else if (!on && ctlBox.parentNode === el) { const [pa, nx] = ctlHome || []; if (pa) pa.insertBefore(ctlBox, nx && nx.parentNode === pa ? nx : null); else ctlBox.remove(); ctlHome = null; }
    /* tune4: fullscreen opens with the settings panel collapsed (the Controls button shows it), and on exit the focus moves
       from the canvas to the Fullscreen button without a focus ring, so no outline is left around the stage */
    setPanel(on ? false : true); resize(); el.classList.add("v3d-pf");
    if (on) canvas.focus({preventScroll: true, focusVisible: false});   // keyboard ready, but no ring around the whole screen
    else if (document.activeElement === canvas || el.contains(document.activeElement)) { try { q("#v3-fs").focus({preventScroll: true, focusVisible: false}); } catch { canvas.blur(); } } }
  let ctlHome = null;
  function setPanel(open) { const c = ctlBox; c.hidden = isFs() ? !open : false; q("#v3-ctl-toggle").setAttribute("aria-expanded", String(!c.hidden));
    el.classList.toggle("v3d-panel", isFs() && !c.hidden); }
  /* fix-ui FE-08: while the CSS fallback covers the page, everything behind it is inert, so Tab stays inside the viewer */
  let inertEls = [];
  function setInert(on) {
    for (const e of inertEls) e.inert = false; inertEls = [];
    if (on) for (let n = el; n && n.parentElement && n !== document.body; n = n.parentElement)
      for (const sib of n.parentElement.children) if (sib !== n && !sib.inert && !["SCRIPT", "STYLE", "LINK"].includes(sib.tagName)) { sib.inert = true; inertEls.push(sib); } }
  const onFsKey = ev => { if (fallbackFs && ev.key === "Escape") { ev.preventDefault(); ev.stopPropagation(); toggleFullscreen(false); } };
  async function toggleFullscreen(force) {
    const on = force === undefined ? !isFs() : !!force;
    if (on === isFs()) return on;
    if (on && docked !== "full") return false;          // Phase 3: never from the thumbnail
    if (on) {
      fsScroll = [scrollX, scrollY];
      // a requestFullscreen promise that never settles (seen in headless Edge) must not leave the button dead:
      // after 1.5 s without native fullscreen, use the CSS fallback (fsChanged drops it if native arrives later)
      try { if (el.requestFullscreen) { const ok = await Promise.race([el.requestFullscreen({navigationUI: "hide"}).then(() => true),
          new Promise(r => setTimeout(() => r(fsEl() === el), 1500))]); if (ok || fsEl() === el) return true; }
        if (el.webkitRequestFullscreen) { el.webkitRequestFullscreen(); await new Promise(r => setTimeout(r, 150)); if (fsEl() === el) return true; } } catch { /* no permission: fall back */ }
      fallbackFs = true; el.classList.add("v3d-fs"); document.body.classList.add("v3d-noscroll"); addEventListener("keydown", onFsKey, true); setInert(true); fsChanged(); return true;
    }
    if (fallbackFs) { fallbackFs = false; el.classList.remove("v3d-fs"); document.body.classList.remove("v3d-noscroll"); removeEventListener("keydown", onFsKey, true); setInert(false); fsChanged(); return false; }
    try { if (document.exitFullscreen) await document.exitFullscreen(); else document.webkitExitFullscreen?.(); } catch { /* already out */ }
    return false;
  }
  el.addEventListener("keydown", ev => { if (ev.key === "Tab") el.classList.remove("v3d-pf"); }, true);
  el.addEventListener("pointerdown", () => el.classList.remove("v3d-pf"), true);
  document.addEventListener("fullscreenchange", fsChanged); document.addEventListener("webkitfullscreenchange", fsChanged);
  q("#v3-fs").addEventListener("click", () => toggleFullscreen());
  q("#v3-fs-exit").addEventListener("click", () => toggleFullscreen(false));
  q("#v3-ctl-toggle").addEventListener("click", () => setPanel(ctlBox.hidden));

  /* ---- keyboard on the canvas ---- */
  canvas.addEventListener("keydown", ev => {
    if (ev.ctrlKey || ev.metaKey || ev.altKey || ev.isComposing || docked !== "full") return;     // fix-ui FE-07: Cmd/Ctrl/Alt shortcuts stay the browser's
    const k = ev.key, tgt = controls.target, off = camera.position.clone().sub(tgt), rot = (axis, deg) => { off.applyAxisAngle(axis, deg * Math.PI / 180); camera.position.copy(tgt).add(off); camera.lookAt(tgt); controls.update(); };
    const right = new T.Vector3().crossVectors(off, camera.up).normalize();
    if (k === "ArrowLeft") rot(camera.up, -5); else if (k === "ArrowRight") rot(camera.up, 5);
    else if (k === "ArrowUp") { rot(right, -5); } else if (k === "ArrowDown") rot(right, 5);
    else if (k === "+" || k === "=") { camera.position.copy(tgt).add(off.multiplyScalar(0.87)); controls.update(); }
    else if (k === "-" || k === "_") { camera.position.copy(tgt).add(off.multiplyScalar(1.15)); controls.update(); }
    else if ((k === "F" || k === "f") && ev.shiftKey) toggleFullscreen();
    else if (k === "f" || k === "F") setPreset("face-on"); else if (k === "e" || k === "E") setPreset("edge-on");
    else if (k === "r" || k === "R") setPreset("reset"); else if (k === "a" || k === "A") setPreset("sightline");
    else if (k === "m" || k === "M") setMode(mode === "integral" ? "volume" : "integral");
    else if (k === "s" || k === "S") setStars({on: !layer.stars});
    else if (k === "g" || k === "G") setGuides({ring: !guides.visible});
    else if (k === "p" || k === "P") viewer.hooks.togglePick?.();
    else if ((k === "c" || k === "C") && !ev.shiftKey) recentre();
    else if ((k === "o" || k === "O") && !ev.shiftKey) setOrbit(!fullOrbit);
    else if (k === "Escape") { if (fsEl() || performance.now() - fsExitAt < 400) return; viewer.hooks.exitPick?.(); }   // Esc that leaves fullscreen does not also leave pick mode
    else return;
    ev.preventDefault(); ev.stopPropagation(); render(); });

  /* ---- controls ---- */
  speciesUnits();
  for (const c of CMAPS) { const o = document.createElement("option"); o.value = c; o.textContent = c; q("#v3-cmap").appendChild(o); }
  for (const i of ctlBox.querySelectorAll('input[name="v3-mode"]')) i.disabled = !manifest;
  for (const id of ["#v3-lo", "#v3-hi", "#v3-op", "#v3-cmap", "#v3-gasmix", "#v3-starmix", "#v3-mu0", "#v3-stars", "#v3-vw", "#v3-weight"]) q(id).disabled = !manifest;
  if (!manifest?.stars) for (const id of ["#v3-stars", "#v3-starmix", "#v3-mu0"]) q(id).disabled = true;
  q("#v3-species").addEventListener("change", ev => { if (ev.target.name === "v3-species" && ev.target.checked) setSpecies(ev.target.value); });
  q("#v3-mode").addEventListener("change", ev => { if (ev.target.name === "v3-mode" && ev.target.checked) setMode(ev.target.value); });
  q("#v3-lo").addEventListener("input", ev => tfWinMode() ? setTfWin(+ev.target.value, null) : setTransfer({lo: Math.min(+ev.target.value, fieldTf(species).hi - 0.1)}));
  q("#v3-hi").addEventListener("input", ev => tfWinMode() ? setTfWin(null, +ev.target.value) : setTransfer({hi: Math.max(+ev.target.value, fieldTf(species).lo + 0.1)}));
  q("#v3-op").addEventListener("input", ev => setTransfer({opacity: +ev.target.value}));
  q("#v3-cmap").addEventListener("change", ev => setTransfer({cmap: ev.target.value}));
  q("#v3-vw").addEventListener("input", ev => setTransfer({W: +ev.target.value}));
  q("#v3-weight").addEventListener("change", ev => setWeight(ev.target.value));
  q("#v3-gasmix").addEventListener("input", ev => setStars({gasMix: +ev.target.value}));
  q("#v3-starmix").addEventListener("input", ev => setStars({mix: +ev.target.value}));
  q("#v3-mu0").addEventListener("input", ev => setStars({mu0: +ev.target.value}));
  q("#v3-stars").addEventListener("change", ev => setStars({on: ev.target.checked}));
  q("#v3-guides").addEventListener("change", ev => setGuides({ring: ev.target.checked}));
  q("#v3-scale").addEventListener("change", ev => setGuides({scale: ev.target.checked}));
  q("#v3-lines").addEventListener("change", ev => setLines(ev.target.value));
  ctlBox.querySelectorAll(".presets [data-p]").forEach(b => b.addEventListener("click", () => setPreset(b.dataset.p)));
  /* ux4 pivot controls: stage chip, View card galaxy | ray, kpc form, double-click on the stage */
  q("#v3-pivot").addEventListener("click", () => { recentre(); canvas.focus({preventScroll: true}); });
  q("#v3-orbit").addEventListener("click", () => setOrbit(!fullOrbit));
  controls.addEventListener("start", () => { if (fullOrbit) setOrbit(false); });   // grabbing the view stops the orbit
  q("#v3-pv-gal").addEventListener("click", recentre);
  q("#v3-pv-ray").addEventListener("click", pivotToRay);
  q("#v3-pv-form").addEventListener("submit", ev => { ev.preventDefault();
    const v = ["x", "y", "z"].map(a => { const x = parseFloat(q("#v3-pv-" + a).value); return Number.isFinite(x) ? x : 0; });
    const p = parsePivot(v.join(",")); pivotTo(p || [0, 0, 0], p ? "typed" : "galaxy"); });
  canvas.addEventListener("dblclick", ev => { if (viewer.picking || docked !== "full") return; ev.preventDefault();
    const r = canvas.getBoundingClientRect(), p = pickPivot(ev.clientX - r.left, ev.clientY - r.top); if (p) pivotTo(p, "pick"); });
  controls.addEventListener("change", () => syncPivot());
  controls.addEventListener("end", () => syncPivot(true));
  function setLines(m) { if (!["selected", "showcase", "all", "none"].includes(m)) return; linesMode = m; q("#v3-lines").value = m; refreshLines(); }

  const onSel = ev => { select(ev.detail?.id); syncPivot(); }, onCat = () => refreshLines();
  addEventListener("tng:select", onSel); addEventListener("tng:catalog", onCat);
  /* credits (2026-11): the stage's ID badge names the simulation, the subhalo and the redshift (separate spans, no separator
     characters); a click or Enter opens the page's Data and credits dialog (app.openCredits). The engine is rebuilt per galaxy,
     and tng:galaxy refreshes it too */
  const idEl = q("#v3-id");
  function idBadge() { if (!idEl) return; const g = app.config?.galaxy || G, id = (typeof app.galaxy === "function" ? app.galaxy() : null) ?? g.subhalo_id;
    idEl.hidden = id == null || typeof app.openCredits !== "function"; if (id == null) return;
    const sim = g.sim || "TNG50-1", z = g.redshift ?? 0;
    idEl.querySelector(".s").textContent = sim; idEl.querySelector(".g").textContent = `Subhalo ${id}`; idEl.querySelector(".z").textContent = `z = ${z}`;
    idEl.setAttribute("aria-label", `${sim} subhalo ${id} at redshift ${z}, data credits`); }
  idEl?.addEventListener("click", ev => { ev.stopPropagation(); app.openCredits?.(idEl); });
  idEl?.addEventListener("pointerdown", ev => ev.stopPropagation());
  const onGal = () => idBadge(); addEventListener("tng:galaxy", onGal); idBadge();
  /* tf3d API: setTf("ramp" | "thor" | "iso" | "clouds" | state) for the current field; tfState() a copy; tfOn() */
  function setTf(x) { if (typeof x === "string") return tfApplyPreset(x); if (!x || !tfOk(species)) return false;
    onTfEdit({...tfState(species), ...x, preset: x.preset || "custom"}, {commit: true, reason: "api"}); syncTfCard(); return true; }
  Object.assign(viewer, {setTf, tfState: () => (species && tfs[species] ? JSON.parse(JSON.stringify(tfs[species])) : null), tfOn: () => tfOn(), tfEditor: tfEd});
  /* ux4 pivot API: viewer.pivot -> [x, y, z] kpc; setPivot([x, y, z] | "galaxy" | "ray") -> bool; pickPivot(x, y) -> Vector3 | null
     (CSS px in the canvas, no move) */
  Object.defineProperty(viewer, "pivot", {get: () => pivotArr().map(r1), enumerable: true});
  Object.assign(viewer, {setPivot: p => (p === "galaxy" ? recentre() : p === "ray" ? pivotToRay() : Array.isArray(p) && p.length === 3 && p.every(Number.isFinite) ? pivotTo(p, "api") : false),
    recentre, pickPivot: (x, y) => pickPivot(x, y)});
  Object.assign(viewer, {drawNow: () => draw(true), volScene, setSpecies, setPreset, setTransfer, setWeight, setLines, select: id => select(id), refreshLines, resize, render, bench, nearestLine,
    setMode, setStars, setGuides, toggleFullscreen, levels, gpuBytes, texKeys: () => [...TEX.keys()],
    dispose() { loadTok++; anim++; progMsg = null; ENGINE = null; io?.disconnect(); if (spinRaf) cancelAnimationFrame(spinRaf); spinRaf = 0;
      document.removeEventListener("visibilitychange", spinKick); if (thumbHost && thumbClick) thumbHost.removeEventListener("click", thumbClick); ctlBox.remove(); clearTimeout(quietT); clearTimeout(progT); clearTimeout(liveT); if (accT) cancelAnimationFrame(accT); accT = 0;
      if (fallbackFs) toggleFullscreen(false); else if (fsEl() === el) document.exitFullscreen?.().catch(() => {});
      try { dprMq?.removeEventListener("change", onDpr); } catch { /* ignore */ }
      if (smoothW) { smoothW.terminate(); smoothW = null; for (const [, p] of smoothP) p[1](new Error("viewer disposed")); smoothP.clear(); }
      ro.disconnect(); removeEventListener("tng:select", onSel); removeEventListener("tng:catalog", onCat); removeEventListener("tng:galaxy", onGal);
      document.removeEventListener("fullscreenchange", fsChanged); document.removeEventListener("webkitfullscreenchange", fsChanged); removeEventListener("keydown", onFsKey, true);
      for (const o of TEX.values()) o.tex.dispose(); RM.lutTex.dispose(); RM.material.dispose(); accRT.dispose(); blitMat.dispose(); controls.dispose(); renderer.dispose(); el.remove(); }});
  if (loader) loader.prune().catch(() => {});
  setStars({}); setGuides({ring: false, scale: true}); markMode(mode);
  stats.mountAt = Math.round(performance.now());

  /* ---- Phase 3 docking: one canvas, shown on the full stage or in the Spectra-tab thumbnail ---- */
  const vis = {full: false, thumb: false};
  let dockMode = "auto", savedPose = null, thumbSpin = true, thumbClick = null, spinLast = 0;
  const shown = h => !!h && h.isConnected && h.getClientRects().length > 0;
  const io = typeof IntersectionObserver !== "undefined" ? new IntersectionObserver(es => {
    for (const e of es) { if (e.target === fullHost) vis.full = e.isIntersecting; if (e.target === thumbHost) vis.thumb = e.isIntersecting; }
    autoDock(); spinKick(); }) : null;
  const onScreen = w => (w === "full" ? fullHost : thumbHost) && (io ? vis[w] : shown(w === "full" ? fullHost : thumbHost));
  function autoDock() { if (dockMode !== "auto" || isFs()) return;
    if (onScreen("full")) dock("full"); else if (onScreen("thumb")) dock("thumb"); }
  const pose = () => ({p: camera.position.clone(), t: controls.target.clone(), u: camera.up.clone()});
  function setPoseTo(o) { anim++; camera.position.copy(o.p); controls.target.copy(o.t); camera.up.copy(o.u); camera.lookAt(o.t); controls.update(); }
  function dock(where) {
    if (where === "auto") { dockMode = "auto"; autoDock(); return docked; }
    if (!["full", "thumb"].includes(where)) return docked;
    const host = where === "thumb" ? thumbHost : fullHost; if (!host || where === docked || isFs()) return docked;
    const was = docked;
    if (where === "thumb") { viewer.hooks.exitPick?.(); anim++; if (was !== "thumb") savedPose = pose(); }
    host.appendChild(el); docked = where; el.classList.toggle("v3d-thumb", where === "thumb");
    controls.enabled = where === "full";
    if (where === "full") { canvas.tabIndex = 0; canvas.removeAttribute("aria-hidden"); if (savedPose && was === "thumb") setPoseTo(savedPose); savedPose = null; }
    else { canvas.removeAttribute("tabindex"); canvas.setAttribute("aria-hidden", "true"); }
    resize(); lodStatus(); thumbLabel(); syncPivot(true);
    if (manifest && (species || wanted)) ensure().catch(x => { if (x instanceof HostError) hostMessage(x); });
    if (where === "full" && species) setTimeout(calibrate, 0);
    spinKick(); render(); viewer.hooks.docked?.(where);
    return docked;
  }
  function thumbLabel() { const t = q(".v3d-tt .f"); if (t) t.textContent = species ? lab(species) : ""; }
  /* the thumbnail's slow turn about the disk normal: only while it is docked, on screen, the page visible, motion allowed */
  let fullOrbit = false;   // the full stage's orbit button (O): the same slow turn as the thumbnail, started by the user
  const spinning = () => !!species && !document.hidden && !ctxLost && (docked === "thumb" ? thumbSpin && !reduced() && (io ? vis.thumb : true) : fullOrbit);
  function setOrbit(on) { fullOrbit = !!on; const b = q("#v3-orbit"); if (b) { b.setAttribute("aria-pressed", String(fullOrbit)); b.querySelector("span").textContent = fullOrbit ? "stop" : "orbit"; }
    spinKick(); }
  function spinKick() {
    if (spinning()) { if (!spinRaf) { spinLast = 0; spinRaf = requestAnimationFrame(spinTick); } }
    else if (spinRaf) { cancelAnimationFrame(spinRaf); spinRaf = 0; render(); } }
  function spinTick(now) {
    spinRaf = 0; if (!spinning()) { render(); return; }
    if (!spinLast) spinLast = now - 1000 / THUMB.fps;
    const dt = now - spinLast;
    if (dt >= 1000 / THUMB.fps - 2) { spinLast = now;
      const off = camera.position.clone().sub(controls.target).applyAxisAngle(Lv, THUMB.degPerSec * Math.min(dt, 250) / 1000 * Math.PI / 180);
      camera.position.copy(controls.target).add(off); camera.lookAt(controls.target);
      const t0 = performance.now(); accK = 0; draw(true); stats.thumbFrameMs = performance.now() - t0; }
    spinRaf = requestAnimationFrame(spinTick); }
  document.addEventListener("visibilitychange", spinKick);
  /* the full stage: the page's square #v3d-stage, or the layout built here */
  function _attachFull(root, o = {}) {
    if (!root) throw new Error("mount: no root element");
    let stageHost = root, colHost = o.controls || null;
    if (!root.closest("#v3d-stage")) {
      root.textContent = "";
      const lay = document.createElement("div"); lay.className = "v3d-layout";
      const sq = document.createElement("div"); sq.className = "v3d-sq"; sq.dataset.testid = "v3d-stage"; if (!document.getElementById("v3d-stage")) sq.id = "v3d-stage";
      const side = document.createElement("div"); side.className = "v3d-side"; side.dataset.testid = "v3d-controls"; if (!document.getElementById("v3d-controls")) side.id = "v3d-controls";
      lay.append(sq, side); root.appendChild(lay); stageHost = sq; colHost ||= side;
    } else {
      colHost ||= document.getElementById("v3d-controls");
      if (!colHost) { colHost = document.createElement("div"); colHost.id = "v3d-controls"; colHost.dataset.testid = "v3d-controls"; root.closest("#v3d-stage").after(colHost); }
      for (const c of [...root.childNodes]) if (c !== el) c.remove();       // the page's "loading the 3D view" note
    }
    if (fullHost && io) io.unobserve(fullHost);
    fullHost = stageHost; io?.observe(fullHost);
    if (ctlBox.parentNode !== colHost && !isFs()) colHost.insertBefore(ctlBox, colHost.firstChild);
    const pr = colHost.querySelector("#picker-root") || document.getElementById("picker-root"), slot = ctlBox.querySelector(".v3c-pick");
    if (pr && !ctlBox.contains(pr)) slot.appendChild(pr);
    else if (!pr) { const d = document.createElement("div"); d.id = "picker-root"; slot.appendChild(d); }
    if (o.dock) dockMode = o.dock === "auto" ? "auto" : "manual";
    if (shown(fullHost) || !docked) { if (o.dock && o.dock !== "auto") dock(o.dock); else if (shown(fullHost) || !thumbHost) dock("full"); }
    return viewer;
  }
  function _attachThumb(host, o = {}) {
    if (!host) throw new Error("mountThumb: no host element");
    if (thumbHost && thumbHost !== host) { if (thumbClick) thumbHost.removeEventListener("click", thumbClick); io?.unobserve(thumbHost); if (docked === "thumb") { docked = null; el.remove(); } }
    thumbHost = host; thumbSpin = o.spin !== false; io?.observe(host); el.classList.toggle("v3d-notags", o.tags === false);
    if (typeof o.onOpen === "function") { thumbClick = ev => { ev.preventDefault(); o.onOpen(); }; host.addEventListener("click", thumbClick); }
    if (!docked || (docked === "full" && !onScreen("full") && shown(host))) dock("thumb");
    const t = {viewer, host, get active() { return docked === "thumb" && thumbHost === host; }, setSpin(on) { thumbSpin = !!on; spinKick(); return thumbSpin; },
      dispose() { if (thumbHost !== host) return; if (thumbClick) host.removeEventListener("click", thumbClick); thumbClick = null; io?.unobserve(host);
        thumbHost = null; if (docked === "thumb") { docked = null; el.remove(); spinKick(); if (fullHost) dock("full"); } }};
    return t;
  }
  let started = null;
  function _start(k) {
    return started ||= (async () => {
      if (!manifest && hostDown) { hostMessage(new HostError(manErr || "no answer", hostDown)); return false; }
      if (!manifest) { say(viz ? `3D data not available${manErr ? ` (${manErr})` : ""}. Sightlines, ray picking and the spectra still work.` : "3D data not published for this build. Sightlines, ray picking and the spectra still work."); return false; }
      /* tf3d: ?tf=<field>~<state> restores volume mode with that field's transfer function */
      if (tfBoot && canShow(tfBoot.k) && modeOk(tfBoot.k, "volume")) { k = tfBoot.k; mode = "volume"; markMode("volume"); speciesUnits();
        if (tfOk(k) && tfBoot.enc) { const st = decodeTF(tfBoot.enc, tfCtx(k)); if (st) tfs[k] = {...st, preset: st.preset || "custom"}; } }
      return setSpecies(k && canShow(k) ? k : fld("nH") ? "nH" : Object.keys(manifest.gas.fields)[0]);
    })();
  }
  Object.assign(viewer, {dock, _attachFull, _attachThumb, _start});
  Object.defineProperty(viewer, "docked", {get: () => docked, enumerable: true});
  resize(); selId = null; refreshLines(); select(app.getState().id, true);
  return viewer;
}
