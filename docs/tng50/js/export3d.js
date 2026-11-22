// 3D Save / Publication Export & Camera Deep-Link module for the TNG50 / FIRE-2 3D viewer.
// Lazily imported by viewer3d.js so app.js's static modulepreload graph stays unchanged.
// Provides:
//   - renderHighDPI(viewer, opts): 8-frame sub-pixel accumulated offscreen render at 1x, 2x (up to 2048 px), 4x (up to 4096 px)
//     with dark (#05070b) or transparent background
//   - exportPNG(viewer, opts): high-DPI render + vector-crisp 2D canvas overlays (colorbar, scale bar, sightlines key, galaxy stamp)
//   - exportSVG(viewer, opts): publication vector SVG (viewBox="0 0 680 760") embedding the 8-frame high-DPI volume PNG with
//     vector frame ticks in kpc/pc, 3D-projected vector sightlines & R200c guide circle, 64-stop vector linearGradient colorbar,
//     and <metadata> with scene JSON + ready-to-paste LaTeX \caption{...}
//   - exportPDF(viewer, opts): zero-dependency client-side single-page PDF 1.4 generator (using CompressionStream("deflate"))
//     embedding the high-DPI raster XObject and drawing native PDF vector frame ticks, scale bar, colorbar, and labels
//   - exportHTML(viewer, opts) & exportJSON(viewer, opts): self-contained offline interactive .html snapshot (with high-DPI
//     render, interactive SVG sightline hover inspector showing sightline ID, impact parameter b, and ion column densities,
//     copyable LaTeX caption, and "Open Live in Explorer" link with ?cam=...&pv=...&tf=...) or .json scene state snapshot.
import {lut} from "./colormaps.js";
import {buildTF, encodeTF, TF_W, TF_H} from "./tf.js";

const BG_HEX = "#05070b";
const BG_RGB = [5, 7, 11];
const ACC_N = 8;
const SUB = Array.from({length: ACC_N}, (_, i) =>
  i ? [((0.5 + i * 0.7548776662) % 1) - 0.5, ((0.5 + i * 0.5698402910) % 1) - 0.5] : [0, 0]
);

const escXml = s => String(s ?? "").replace(/[&<>"']/g, c => ({"&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;"})[c]);
const escHtml = s => String(s ?? "").replace(/[&<>"']/g, c => ({"&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"})[c]);
const r2 = x => { const v = Math.round((+x || 0) * 100) / 100; return Object.is(v, -0) ? 0 : v; };

function triggerDownload(blob, filename) {
  if (typeof document === "undefined") return;
  const a = document.createElement("a");
  const url = URL.createObjectURL(blob);
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

/* ---- Scene metadata & naming helpers ---- */
export function sceneMeta(viewer) {
  const snap = typeof viewer.getSceneSnapshot === "function" ? viewer.getSceneSnapshot() : {};
  const app = viewer.app || (typeof window !== "undefined" ? window.tngApp : null);
  const cfg = app?.config || {};
  const g = cfg.galaxy || viewer.manifest?.galaxy || {};
  const simRaw = String(g.sim || "TNG50-1");
  const prefix = /fire/i.test(simRaw) ? "fire2" : "tng50";
  const galId = (typeof app?.galaxy === "function" ? app.galaxy() : null) ?? g.subhalo_id ?? g.id ?? "galaxy";
  const z = g.redshift ?? 0;
  const species = viewer.species || snap.species || "nH";
  const mode = viewer.mode || snap.mode || "integral";
  const R200c = viewer.frame?.R200c || g.R200c_kpc || 246.35;
  return {prefix, sim: simRaw, galId, z, species, mode, R200c, snap, app};
}

export function buildFilename(viewer, W, H, ext) {
  const {prefix, galId, species, mode} = sceneMeta(viewer);
  const cleanGal = String(galId).replace(/[^a-zA-Z0-9_-]/g, "");
  const cleanSp = String(species).replace(/[^a-zA-Z0-9_-]/g, "");
  const cleanMd = String(mode).replace(/[^a-zA-Z0-9_-]/g, "");
  if (W && H) return `${prefix}_${cleanGal}_${cleanSp}_${cleanMd}_${W}x${H}.${ext}`;
  return `${prefix}_${cleanGal}_${cleanSp}_${cleanMd}.${ext}`;
}

export function buildDeepLink(viewer) {
  if (typeof viewer.getDeepLink === "function") return viewer.getDeepLink();
  const snap = typeof viewer.getSceneSnapshot === "function" ? viewer.getSceneSnapshot() : {};
  const loc = typeof location !== "undefined" ? location : {origin: "https://galaxies.tanmaysingh.uk", pathname: "/tng50/", search: "", hash: ""};
  const parts = String(loc.search || "").replace(/^\?/, "").split("&").filter(x => x && !/^(cam|pv|tf)=/.test(x));
  if (snap.camera) {
    const c = snap.camera.position || [0, 0, 520], u = snap.camera.up || [0, 1, 0];
    parts.push("cam=" + [...c, ...u].map(r2).join(","));
  }
  if (snap.pivot && Math.hypot(snap.pivot[0], snap.pivot[1], snap.pivot[2]) > 0.5) {
    parts.push("pv=" + snap.pivot.map(x => Math.round(x * 10) / 10).join(","));
  }
  if (snap.mode === "volume" && snap.species) {
    parts.push("tf=" + (snap.tfEncoded ? `${snap.species}~${snap.tfEncoded}` : snap.species));
  }
  const q = parts.join("&");
  const hash = loc.hash || "#tab=3d";
  return `${loc.origin || ""}${loc.pathname || "/tng50/"}${q ? "?" + q : ""}${hash.includes("tab=3d") ? hash : (hash ? hash + "&tab=3d" : "#tab=3d")}`;
}

export function buildLatexCaption(viewer) {
  const m = sceneMeta(viewer);
  const info = getLegendInfo(viewer);
  const cam = m.snap.camera || {position: [0, 0, 520], target: [0, 0, 0]};
  const dist = Math.round(Math.hypot(
    (cam.position?.[0] || 0) - (cam.target?.[0] || 0),
    (cam.position?.[1] || 0) - (cam.target?.[1] || 0),
    (cam.position?.[2] || 0) - (cam.target?.[2] || 0)
  ));
  const fovKpc = Math.round(2 * dist * Math.tan((viewer.camera?.fov || 22) * Math.PI / 360));
  const fieldTex = info.titlePlain.replace(/log₁₀/g, "\\log_{10}").replace(/cm⁻²/g, "\\mathrm{cm}^{-2}").replace(/cm⁻³/g, "\\mathrm{cm}^{-3}").replace(/Z☉/g, "\\mathrm{Z}_{\\odot}");
  const rangeTex = `${info.lo} \\text{ to } ${info.hi}`;
  const sel = m.snap.selectedSightline ? `, with sightline \\texttt{${String(m.snap.selectedSightline).replace(/_/g, "\\_")}} highlighted` : "";
  return `\\caption{Three-dimensional ${m.mode === "volume" ? "ray-marched volume rendering" : "projected column map"} of ${fieldTex} (${rangeTex}) across the circumgalactic medium of ${m.sim} subhalo ${m.galId} at $z = ${m.z}$ ($R_{200\\mathrm{c}} = ${Math.round(m.R200c)}\\,\\mathrm{kpc}$, field of view $\\approx ${fovKpc}\\,\\mathrm{kpc}$${sel}).}`;
}

/* ---- Colorbar & physical scale calculation ---- */
export function getLegendInfo(viewer) {
  const snap = typeof viewer.getSceneSnapshot === "function" ? viewer.getSceneSnapshot() : {};
  const species = viewer.species || snap.species || "nH";
  const mode = viewer.mode || snap.mode || "integral";
  const legEl = viewer.el?.querySelector?.(".v3d-leg");
  const domTitle = legEl?.querySelector?.(".ttl")?.textContent?.trim();
  const tr = snap.transfer || {lo: 13.5, hi: 21.5, cmap: "tng_dusk"};
  let lo = Number.isFinite(+tr.lo) ? +tr.lo : 13.5;
  let hi = Number.isFinite(+tr.hi) ? +tr.hi : 21.5;
  const cmap = tr.cmap || "tng_dusk";

  // Build 64 RGB stops [r, g, b]
  const stops = [];
  const tfOn = typeof viewer.tfOn === "function" && viewer.tfOn();
  const tfSt = tfOn && typeof viewer.tfState === "function" ? viewer.tfState() : null;
  if (tfSt && Array.isArray(tfSt.win) && tfSt.win.length === 2) {
    lo = +tfSt.win[0];
    hi = +tfSt.win[1];
    const b = buildTF(tfSt, lut(cmap), tfSt.win);
    const row = b.slice(0, TF_W * 4);
    if (tfSt.twoD) {
      for (let i = 0; i < TF_W; i++) {
        for (let j = 1; j < TF_H; j++) {
          const o = 4 * (j * TF_W + i);
          if (b[o + 3] > row[4 * i + 3]) row.set(b.subarray(o, o + 4), 4 * i);
        }
      }
    }
    for (let i = 0; i < 64; i++) {
      const idx = 4 * Math.round((i / 63) * (TF_W - 1));
      const a = row[idx + 3] / 255;
      const mix = (c, bg) => Math.round(bg + (c - bg) * Math.min(1, 1.6 * a));
      stops.push([mix(row[idx], 5), mix(row[idx + 1], 7), mix(row[idx + 2], 11)]);
    }
  } else {
    const L = lut(cmap, 64);
    for (let i = 0; i < 64; i++) {
      stops.push([L[4 * i], L[4 * i + 1], L[4 * i + 2]]);
    }
  }

  // Generate ticks
  const span = Math.max(1e-6, hi - lo);
  const isVel = ["vlos", "vr", "vphi", "vmag", "sigmalos"].includes(species);
  const step = isVel
    ? ([10, 20, 25, 50, 100, 200, 250, 500, 1000].find(x => span / x <= 4.01) || 500)
    : (span > 6 ? 2 : span > 2.5 ? 1 : span > 1.2 ? 0.5 : span > 0.5 ? 0.2 : 0.1);
  const ticks = [];
  for (let v = Math.ceil(lo / step - 1e-9) * step; v <= hi + 1e-9; v += step) {
    const frac = Math.max(0, Math.min(1, (v - lo) / span));
    const label = isVel
      ? ((v < -1e-9 ? "-" : v > 1e-9 && lo < 0 ? "+" : "") + Math.round(Math.abs(v)))
      : ((v < -1e-9 ? "-" : "") + Math.abs(+v.toFixed(1)));
    ticks.push({v: +v.toFixed(2), frac, label});
  }

  const titlePlain = domTitle || (isVel
    ? `${species} [km/s] (${mode})`
    : `log10 ${species} [${mode === "integral" ? "cm^-2" : "cm^-3"}]`);
  return {titlePlain, lo: +lo.toFixed(2), hi: +hi.toFixed(2), cmap, stops, ticks, isVel};
}

export function getScaleInfo(viewer, widthPx, heightPx) {
  const cam = viewer.camera;
  const tgt = viewer.controls?.target || {x: 0, y: 0, z: 0};
  const d = cam?.position ? cam.position.distanceTo(tgt) : 520;
  const fovDeg = cam?.fov || 22;
  const fovH = 2 * d * Math.tan((fovDeg * Math.PI) / 360);
  const aspect = (widthPx || 600) / Math.max(1, heightPx || 600);
  const fovW = fovH * aspect;
  const pxPerKpc = (heightPx || 600) / Math.max(1e-3, fovH);
  const minBarPx = (heightPx || 600) * 0.11;
  const candidates = [0.05, 0.1, 0.2, 0.5, 1, 2, 5, 10, 20, 50, 100, 200, 500];
  const barKpc = candidates.find(v => v * pxPerKpc >= minBarPx) || 100;
  const barPx = barKpc * pxPerKpc;
  const label = barKpc < 1 ? `${Math.round(barKpc * 1000)} pc` : `${barKpc} kpc`;

  // Compute physical frame ticks along [-fovW/2, +fovW/2] and [-fovH/2, +fovH/2]
  const tickStep = [0.1, 0.2, 0.5, 1, 2, 5, 10, 20, 25, 50, 100, 200].find(s => fovW / s <= 9) || 100;
  const usePc = tickStep < 1;
  const unitLabel = usePc ? "pc" : "kpc";
  const xTicks = [], yTicks = [];
  const halfW = fovW / 2, halfH = fovH / 2;
  for (let v = Math.ceil(-halfW / tickStep) * tickStep; v <= halfW + 1e-6; v += tickStep) {
    const val = Math.abs(v) < 1e-6 ? 0 : v;
    const frac = (val + halfW) / fovW;
    if (frac >= 0.04 && frac <= 0.96) {
      xTicks.push({kpc: val, frac, label: String(usePc ? Math.round(val * 1000) : +val.toFixed(1))});
    }
  }
  for (let v = Math.ceil(-halfH / tickStep) * tickStep; v <= halfH + 1e-6; v += tickStep) {
    const val = Math.abs(v) < 1e-6 ? 0 : v;
    const frac = (halfH - val) / fovH; // top = +halfH, bottom = -halfH
    if (frac >= 0.04 && frac <= 0.96) {
      yTicks.push({kpc: val, frac, label: String(usePc ? Math.round(val * 1000) : +val.toFixed(1))});
    }
  }
  return {d, fovW, fovH, pxPerKpc, barKpc, barPx, label, tickStep, unitLabel, xTicks, yTicks};
}

/* ---- 3D -> 2D projection helper for SVG / PDF / HTML overlays ---- */
export function projectVisibleSightlines(viewer, width, height) {
  const T = viewer.THREE;
  const cam = viewer.camera;
  const app = viewer.app || (typeof window !== "undefined" ? window.tngApp : null);
  if (!T || !cam || !app || typeof app.entries !== "function") return [];
  cam.updateMatrixWorld(true);
  cam.updateProjectionMatrix();

  const snap = typeof viewer.getSceneSnapshot === "function" ? viewer.getSceneSnapshot() : {};
  const linesMode = snap.linesMode || "selected";
  const selId = snap.selectedSightline || app.getState?.()?.id || null;
  if (linesMode === "none") return [];

  const all = app.entries() || [];
  const hasEnds = e => !!e && Array.isArray(e.p0) && Array.isArray(e.p1) && e.p0.length === 3 && e.p1.length === 3;
  const filtered = all.filter(hasEnds).filter(e =>
    linesMode === "all" ||
    (linesMode === "showcase" && (e.star || +e.n_showcase_ions >= 1 || e.source === "generated")) ||
    (linesMode === "selected" && e.id === selId)
  );

  const v = new T.Vector3();
  const projectPt = pt => {
    v.set(pt[0], pt[1], pt[2]).applyMatrix4(cam.matrixWorldInverse);
    if (v.z > -cam.near) return null;
    v.applyMatrix4(cam.projectionMatrix);
    return [((v.x + 1) / 2) * width, ((1 - v.y) / 2) * height];
  };

  const out = [];
  for (const e of filtered) {
    const a = projectPt(e.p0), b = projectPt(e.p1);
    if (!a || !b) continue;
    const kind = e.orientation === "custom" || e.kind === "endpoints" ? "custom" : e.source === "generated" ? "generated" : "library";
    const color = e.id === selId ? "#e9eef4" : kind === "custom" ? "#f39a5c" : kind === "generated" ? "#7db2f0" : "#8d97a6";
    out.push({
      id: e.id,
      selected: e.id === selId,
      kind,
      color,
      x1: +a[0].toFixed(2),
      y1: +a[1].toFixed(2),
      x2: +b[0].toFixed(2),
      y2: +b[1].toFixed(2),
      b_kpc: e.b_kpc ?? null,
      orientation: e.orientation || kind,
      azimuth_deg: e.azimuth_deg ?? null,
      logN: e.logN || {}
    });
  }
  // Draw selected sightline last so it sits on top
  out.sort((a, b) => (a.selected ? 1 : 0) - (b.selected ? 1 : 0));
  return out;
}

/* ---- Exact 8-frame Sub-Pixel Accumulated High-DPI Renderer ---- */
export async function renderHighDPI(viewer, opts = {}) {
  const scale = Number(opts.scale) || 2;
  const maxDim = scale >= 4 ? 4096 : scale >= 2 ? 2048 : 1024;
  const baseW = viewer.el?.clientWidth || viewer.canvas?.clientWidth || 680;
  const baseH = viewer.el?.clientHeight || viewer.canvas?.clientHeight || 680;
  const aspect = baseW / Math.max(1, baseH);
  let W = Math.round(baseW * scale);
  let H = Math.round(baseH * scale);
  if (Math.max(W, H) > maxDim) {
    if (W >= H) { W = maxDim; H = Math.max(1, Math.round(maxDim / aspect)); }
    else { H = maxDim; W = Math.max(1, Math.round(maxDim * aspect)); }
  }

  const transparent = opts.background === "transparent";
  const includeSceneLines = opts.sceneLines !== false;

  // Fallback for stub / headless mock without full WebGLRenderTarget
  const T = viewer.THREE;
  const renderer = viewer.renderer;
  const U = viewer.uniforms;
  if (!T || !renderer || !U || !viewer.volScene || !viewer.camera) {
    const cv = document.createElement("canvas");
    cv.width = W; cv.height = H;
    const ctx = cv.getContext("2d");
    if (!transparent) { ctx.fillStyle = BG_HEX; ctx.fillRect(0, 0, W, H); }
    if (viewer.canvas) { try { ctx.drawImage(viewer.canvas, 0, 0, W, H); } catch { /* ignore */ } }
    return {canvas: cv, width: W, height: H, scale};
  }

  // Ensure uniforms match current exact state before offscreen pass
  if (typeof viewer.drawNow === "function") viewer.drawNow();

  const cam = viewer.camera;
  const oldAspect = cam.aspect;
  const oldPxAng = U.uPxAng.value;
  const oldSpv = U.uSpv.value;
  const oldExact = U.uExact.value;
  const oldSubX = U.uSub.value.x, oldSubY = U.uSub.value.y;
  const oldAccW = U.uAccW.value;
  const oldBg = U.uBg.value.clone();
  const prevTarget = renderer.getRenderTarget();
  const prevAutoClear = renderer.autoClear;

  const accType = renderer.extensions?.has?.("EXT_color_buffer_float") || renderer.extensions?.has?.("EXT_color_buffer_half_float")
    ? T.HalfFloatType : T.UnsignedByteType;
  const rtOpts = {type: accType, format: T.RGBAFormat, depthBuffer: false, stencilBuffer: false, minFilter: T.NearestFilter, magFilter: T.NearestFilter, generateMipmaps: false};

  const render8Pass = bgVec => {
    const rt = new T.WebGLRenderTarget(W, H, rtOpts);
    U.uBg.value.set(bgVec[0], bgVec[1], bgVec[2]);
    U.uExact.value = 1;
    const dT = cam.position.distanceTo(viewer.controls?.target || new T.Vector3());
    const hVis = dT * Math.tan((cam.fov * Math.PI) / 360);
    U.uSpv.value = hVis < 30 ? 2.0 : 1.0;
    U.uPxAng.value = (2 * Math.tan((cam.fov * Math.PI) / 360)) / Math.max(H, 1);

    renderer.setRenderTarget(rt);
    renderer.setClearColor(new T.Color(bgVec[0], bgVec[1], bgVec[2]), 1);
    renderer.clear(true, false, false);
    renderer.autoClear = false;
    for (let k = 0; k < ACC_N; k++) {
      const [sx, sy] = SUB[k];
      U.uSub.value.set((2 * sx) / W, (2 * sy) / H);
      U.uAccW.value = 1 / (k + 1);
      U.uFrame.value = (k + 1) % 1024;
      renderer.render(viewer.volScene, cam);
    }
    if (includeSceneLines && viewer.scene) {
      const guidesWas = viewer.scene.children[0]?.visible;
      const linesWas = viewer.scene.children[1]?.visible;
      const selWas = viewer.scene.children[2]?.visible;
      if (opts.guides === false && viewer.scene.children[0]) viewer.scene.children[0].visible = false;
      if (opts.sightlines === false) {
        if (viewer.scene.children[1]) viewer.scene.children[1].visible = false;
        if (viewer.scene.children[2]) viewer.scene.children[2].visible = false;
      }
      renderer.render(viewer.scene, cam);
      if (viewer.scene.children[0] && guidesWas !== undefined) viewer.scene.children[0].visible = guidesWas;
      if (viewer.scene.children[1] && linesWas !== undefined) viewer.scene.children[1].visible = linesWas;
      if (viewer.scene.children[2] && selWas !== undefined) viewer.scene.children[2].visible = selWas;
    }

    // Read back via an UnsignedByte readback target so HalfFloat targets decode cleanly across all WebGL2 drivers
    const readRT = new T.WebGLRenderTarget(W, H, {type: T.UnsignedByteType, format: T.RGBAFormat, depthBuffer: false, stencilBuffer: false});
    const blitSc = new T.Scene(), blitCm = new T.OrthographicCamera(-1, 1, 1, -1, 0, 1);
    const blitMt = new T.ShaderMaterial({
      uniforms: {uTex: {value: rt.texture}},
      depthTest: false, depthWrite: false,
      vertexShader: `out vec2 vUv; void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }`,
      fragmentShader: `uniform sampler2D uTex; in vec2 vUv; out vec4 o; void main() { o = vec4(texture(uTex, vUv).rgb, 1.0); }`,
      glslVersion: T.GLSL3
    });
    const quad = new T.Mesh(new T.PlaneGeometry(2, 2), blitMt);
    blitSc.add(quad);
    renderer.setRenderTarget(readRT);
    renderer.autoClear = true;
    renderer.render(blitSc, blitCm);

    const pixels = new Uint8Array(W * H * 4);
    renderer.readRenderTargetPixels(readRT, 0, 0, W, H, pixels);

    quad.geometry.dispose();
    blitMt.dispose();
    readRT.dispose();
    rt.dispose();
    return pixels;
  };

  let outPixels;
  try {
    cam.aspect = W / H;
    cam.updateProjectionMatrix();

    if (!transparent) {
      outPixels = render8Pass([BG_RGB[0] / 255, BG_RGB[1] / 255, BG_RGB[2] / 255]);
    } else {
      // Exact dual-background alpha mattes: render against black (0,0,0) and white (1,1,1) to extract exact transmission & premultiplied emission
      const pxBlack = render8Pass([0, 0, 0]);
      const pxWhite = render8Pass([1, 1, 1]);
      outPixels = new Uint8Array(W * H * 4);
      for (let i = 0; i < pxBlack.length; i += 4) {
        const rb = pxBlack[i] / 255, gb = pxBlack[i + 1] / 255, bb = pxBlack[i + 2] / 255;
        const rw = pxWhite[i] / 255, gw = pxWhite[i + 1] / 255, bw = pxWhite[i + 2] / 255;
        // C_white - C_black = (1 - A) * (1 - 0) = 1 - A
        const trans = Math.max(0, Math.min(1, ((rw - rb) + (gw - gb) + (bw - bb)) / 3));
        const alpha = Math.max(0, Math.min(1, 1 - trans));
        // Boost subtle emission luminance into alpha when additive screen blend leaves trans near 1
        const lum = Math.max(rb, gb, bb);
        const aFinal = Math.max(alpha, lum);
        if (aFinal <= 1e-3) {
          outPixels[i] = outPixels[i + 1] = outPixels[i + 2] = outPixels[i + 3] = 0;
        } else {
          outPixels[i] = Math.min(255, Math.round((rb / aFinal) * 255));
          outPixels[i + 1] = Math.min(255, Math.round((gb / aFinal) * 255));
          outPixels[i + 2] = Math.min(255, Math.round((bb / aFinal) * 255));
          outPixels[i + 3] = Math.min(255, Math.round(aFinal * 255));
        }
      }
    }
  } finally {
    cam.aspect = oldAspect;
    cam.updateProjectionMatrix();
    U.uPxAng.value = oldPxAng;
    U.uSpv.value = oldSpv;
    U.uExact.value = oldExact;
    U.uSub.value.set(oldSubX, oldSubY);
    U.uAccW.value = oldAccW;
    U.uBg.value.copy(oldBg);
    renderer.setRenderTarget(prevTarget);
    renderer.autoClear = prevAutoClear;
    renderer.setClearColor(new T.Color(BG_HEX), 1);
    if (typeof viewer.drawNow === "function") viewer.drawNow();
  }

  // Flip Y from WebGL bottom-up coordinates to Canvas 2D top-down
  const cv = document.createElement("canvas");
  cv.width = W;
  cv.height = H;
  const ctx = cv.getContext("2d");
  const imgData = ctx.createImageData(W, H);
  const dst = imgData.data;
  const rowBytes = W * 4;
  for (let y = 0; y < H; y++) {
    const srcOff = (H - 1 - y) * rowBytes;
    const dstOff = y * rowBytes;
    dst.set(outPixels.subarray(srcOff, srcOff + rowBytes), dstOff);
  }
  ctx.putImageData(imgData, 0, 0);
  return {canvas: cv, width: W, height: H, scale};
}

/* ---- Vector-crisp 2D Canvas Overlays for PNG Export ---- */
function drawCanvasOverlays(ctx, viewer, W, H, opts = {}) {
  const s = W / 680;
  const pad = Math.round(16 * s);
  const fontSans = `${Math.round(12 * s)}px "Space Grotesk", system-ui, -apple-system, sans-serif`;
  const fontMono = `${Math.round(11.5 * s)}px "JetBrains Mono", ui-monospace, monospace`;

  const roundCard = (x, y, w, h, r = 10 * s) => {
    ctx.save();
    ctx.fillStyle = "rgba(12, 16, 22, 0.82)";
    ctx.strokeStyle = "rgba(200, 215, 240, 0.22)";
    ctx.lineWidth = Math.max(1, 1 * s);
    ctx.beginPath();
    if (ctx.roundRect) ctx.roundRect(x, y, w, h, r);
    else ctx.rect(x, y, w, h);
    ctx.fill();
    ctx.stroke();
    ctx.restore();
  };

  // 1. Colorbar & Legend (bottom-left)
  if (opts.legend !== false) {
    const leg = getLegendInfo(viewer);
    const hasStars = !!viewer.stars;
    const cardW = Math.round(270 * s);
    const cardH = Math.round((hasStars ? 74 : 56) * s);
    const cx = pad, cy = H - pad - cardH;
    roundCard(cx, cy, cardW, cardH);

    ctx.save();
    ctx.font = `500 ${fontSans}`;
    ctx.fillStyle = "#e9eef4";
    ctx.textBaseline = "top";
    ctx.fillText(leg.titlePlain, cx + 10 * s, cy + 7 * s);

    const barX = cx + 10 * s, barY = cy + 25 * s, barW = cardW - 20 * s, barH = Math.round(10 * s);
    const grad = ctx.createLinearGradient(barX, 0, barX + barW, 0);
    leg.stops.forEach(([r, g, b], i) => {
      grad.addColorStop(i / Math.max(1, leg.stops.length - 1), `rgb(${r},${g},${b})`);
    });
    ctx.fillStyle = grad;
    ctx.fillRect(barX, barY, barW, barH);
    ctx.strokeStyle = "#2f3844";
    ctx.lineWidth = Math.max(1, 1 * s);
    ctx.strokeRect(barX, barY, barW, barH);

    ctx.font = fontMono;
    ctx.fillStyle = "#b3bdc9";
    ctx.textAlign = "center";
    for (const tk of leg.ticks) {
      const tx = barX + Math.min(0.95, Math.max(0.05, tk.frac)) * barW;
      ctx.fillText(tk.label, tx, barY + barH + 3 * s);
    }

    if (hasStars) {
      const sy = barY + barH + 19 * s;
      const sg = ctx.createLinearGradient(barX, 0, barX + 42 * s, 0);
      sg.addColorStop(0, "#4d6fd0");
      sg.addColorStop(0.5, "#fff4e6");
      sg.addColorStop(1, "#ffb347");
      ctx.fillStyle = sg;
      ctx.fillRect(barX, sy + 2 * s, 42 * s, 7 * s);
      ctx.textAlign = "left";
      ctx.font = `${Math.round(10.5 * s)}px "Space Grotesk", system-ui, sans-serif`;
      ctx.fillStyle = "#b3bdc9";
      ctx.fillText("stars: g, r, i asinh composite", barX + 48 * s, sy);
    }
    ctx.restore();
  }

  // 2. Physical kpc/pc Scale Bar (bottom-center)
  if (opts.scaleBar !== false) {
    const sc = getScaleInfo(viewer, W, H);
    const bw = Math.round(sc.barPx);
    const cardW = Math.max(bw + Math.round(24 * s), Math.round(84 * s));
    const cardH = Math.round(32 * s);
    const cx = Math.round((W - cardW) / 2), cy = H - pad - cardH;
    roundCard(cx, cy, cardW, cardH);

    ctx.save();
    const bx = Math.round(cx + (cardW - bw) / 2), by = Math.round(cy + 7 * s), bh = Math.round(6 * s);
    ctx.strokeStyle = "#e9eef4";
    ctx.lineWidth = Math.max(1.5, 1.5 * s);
    ctx.beginPath();
    ctx.moveTo(bx, by);
    ctx.lineTo(bx, by + bh);
    ctx.lineTo(bx + bw, by + bh);
    ctx.lineTo(bx + bw, by);
    ctx.stroke();

    ctx.font = fontMono;
    ctx.fillStyle = "#e9eef4";
    ctx.textAlign = "center";
    ctx.textBaseline = "top";
    ctx.fillText(sc.label, cx + cardW / 2, by + bh + 3 * s);
    ctx.restore();
  }

  // 3. Galaxy & Redshift Stamp (bottom-right)
  let stampH = 0;
  if (opts.stamp !== false) {
    const m = sceneMeta(viewer);
    const text = `${m.sim}   Subhalo ${m.galId}   z = ${m.z}`;
    ctx.save();
    ctx.font = `500 ${fontMono}`;
    const tw = ctx.measureText(text).width;
    const cardW = Math.round(tw + 22 * s);
    const cardH = Math.round(28 * s);
    stampH = cardH + Math.round(8 * s);
    const cx = W - pad - cardW, cy = H - pad - cardH;
    roundCard(cx, cy, cardW, cardH);
    ctx.fillStyle = "#e9eef4";
    ctx.textBaseline = "middle";
    ctx.fillText(text, cx + 11 * s, cy + cardH / 2);
    ctx.restore();
  }

  // 4. Sightlines Key (bottom-right above stamp)
  if (opts.sightlines !== false) {
    const items = [
      ["#8d97a6", "library", false],
      ["#7db2f0", "generated", false],
      ["#f39a5c", "custom", false],
      ["#e9eef4", "selected", true]
    ];
    const cardW = Math.round(108 * s);
    const rowH = Math.round(15 * s);
    const cardH = Math.round(12 * s) + items.length * rowH;
    const cx = W - pad - cardW, cy = H - pad - stampH - cardH;
    roundCard(cx, cy, cardW, cardH);

    ctx.save();
    ctx.font = `${Math.round(11 * s)}px "Space Grotesk", system-ui, sans-serif`;
    ctx.textBaseline = "middle";
    items.forEach(([col, label, isSel], idx) => {
      const ry = cy + 12 * s + idx * rowH;
      ctx.strokeStyle = col;
      ctx.lineWidth = (isSel ? 3.2 : 1.8) * s;
      ctx.beginPath();
      ctx.moveTo(cx + 9 * s, ry);
      ctx.lineTo(cx + 27 * s, ry);
      ctx.stroke();
      ctx.fillStyle = "#b3bdc9";
      ctx.fillText(label, cx + 33 * s, ry);
    });
    ctx.restore();
  }
}

/* ---- 1. exportPNG ---- */
export async function exportPNG(viewer, opts = {}) {
  const {canvas, width, height} = await renderHighDPI(viewer, opts);
  const ctx = canvas.getContext("2d");
  drawCanvasOverlays(ctx, viewer, width, height, opts);
  const filename = opts.filename || buildFilename(viewer, width, height, "png");
  const blob = await new Promise(res => canvas.toBlob(res, "image/png"));
  if (opts.download !== false && blob) triggerDownload(blob, filename);
  return {blob, filename, width, height, dataUrl: canvas.toDataURL("image/png")};
}

/* ---- 2. exportSVG ---- */
export async function exportSVG(viewer, opts = {}) {
  // Render volume without 3D line meshes so sightlines & R200c ring are pure crisp SVG vectors on top
  const volRender = await renderHighDPI(viewer, {...opts, sceneLines: false});
  const pngDataUrl = volRender.canvas.toDataURL("image/png");
  const m = sceneMeta(viewer);
  const leg = getLegendInfo(viewer);
  const sc = getScaleInfo(viewer, 560, 560);
  const lines = opts.sightlines === false ? [] : projectVisibleSightlines(viewer, 560, 560);
  const latex = buildLatexCaption(viewer);
  const transparent = opts.background === "transparent";

  // Frame box inside 680x760 SVG viewBox: x=68..628 (560 px), y=44..604 (560 px)
  const fx = 68, fy = 44, fw = 560, fh = 560;
  const r200Px = sc.pxPerKpc * m.R200c;

  const gradStops = leg.stops.map(([r, g, b], i) => {
    const pct = ((i / Math.max(1, leg.stops.length - 1)) * 100).toFixed(2);
    return `<stop offset="${pct}%" stop-color="rgb(${r},${g},${b})"/>`;
  }).join("");

  const xTickSvg = sc.xTicks.map(t => {
    const x = +(fx + t.frac * fw).toFixed(2);
    return `<line x1="${x}" y1="${fy + fh}" x2="${x}" y2="${fy + fh + 5}" stroke="#b3bdc9" stroke-width="1"/>` +
      `<line x1="${x}" y1="${fy}" x2="${x}" y2="${fy + 4}" stroke="#b3bdc9" stroke-width="1" opacity="0.6"/>` +
      `<text x="${x}" y="${fy + fh + 17}" text-anchor="middle" fill="#b3bdc9" font-family="JetBrains Mono, monospace" font-size="10.5">${escXml(t.label)}</text>`;
  }).join("");

  const yTickSvg = sc.yTicks.map(t => {
    const y = +(fy + t.frac * fh).toFixed(2);
    return `<line x1="${fx - 5}" y1="${y}" x2="${fx}" y2="${y}" stroke="#b3bdc9" stroke-width="1"/>` +
      `<line x1="${fx + fw - 4}" y1="${y}" x2="${fx + fw}" y2="${y}" stroke="#b3bdc9" stroke-width="1" opacity="0.6"/>` +
      `<text x="${fx - 9}" y="${y + 3.5}" text-anchor="end" fill="#b3bdc9" font-family="JetBrains Mono, monospace" font-size="10.5">${escXml(t.label)}</text>`;
  }).join("");

  const linesSvg = lines.map(l => {
    const x1 = +(fx + l.x1).toFixed(2), y1 = +(fy + l.y1).toFixed(2);
    const x2 = +(fx + l.x2).toFixed(2), y2 = +(fy + l.y2).toFixed(2);
    const sw = l.selected ? 2.2 : 1.15;
    const op = l.selected ? 0.92 : l.kind === "custom" ? 0.65 : l.kind === "generated" ? 0.45 : 0.25;
    return `<g data-sightline="${escXml(l.id)}">` +
      `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="${l.color}" stroke-width="${sw}" stroke-opacity="${op}" stroke-linecap="round"/>` +
      (l.selected ? `<circle cx="${x1}" cy="${y1}" r="2.6" fill="${l.color}"/><circle cx="${x2}" cy="${y2}" r="3.6" fill="${l.color}"/>` : "") +
      `</g>`;
  }).join("");

  const guideSvg = (opts.guides !== false && r200Px > 12 && r200Px < fw * 0.7)
    ? `<circle cx="${fx + fw / 2}" cy="${fy + fh / 2}" r="${r200Px.toFixed(2)}" fill="none" stroke="#d9c38c" stroke-width="1.2" stroke-dasharray="5 4" stroke-opacity="0.72"/>` +
      `<text x="${(fx + fw / 2 + r200Px * 0.707 + 5).toFixed(1)}" y="${(fy + fh / 2 - r200Px * 0.707 - 4).toFixed(1)}" fill="#d9c38c" font-family="JetBrains Mono, monospace" font-size="10">R200c = ${Math.round(m.R200c)} kpc</text>`
    : "";

  const scaleBarW = +sc.barPx.toFixed(2);
  const sbX = +(fx + fw - 20 - scaleBarW).toFixed(2), sbY = fy + fh - 22;
  const scaleSvg = opts.scaleBar !== false
    ? `<g id="scale-bar">` +
      `<rect x="${sbX - 8}" y="${sbY - 15}" width="${scaleBarW + 16}" height="28" rx="6" fill="#0c1016" fill-opacity="0.78" stroke="#2f3844" stroke-width="0.8"/>` +
      `<path d="M${sbX} ${sbY - 5} V${sbY} H${(sbX + scaleBarW).toFixed(2)} V${sbY - 5}" fill="none" stroke="#e9eef4" stroke-width="1.5"/>` +
      `<text x="${(sbX + scaleBarW / 2).toFixed(2)}" y="${sbY + 10}" text-anchor="middle" fill="#e9eef4" font-family="JetBrains Mono, monospace" font-size="10.5">${escXml(sc.label)}</text>` +
      `</g>`
    : "";

  const stampSvg = opts.stamp !== false
    ? `<text x="${fx}" y="28" fill="#e9eef4" font-family="Space Grotesk, system-ui, sans-serif" font-size="13" font-weight="600">${escXml(m.sim)}   Subhalo ${escXml(m.galId)}   z = ${escXml(m.z)}</text>` +
      `<text x="${fx + fw}" y="28" text-anchor="end" fill="#b3bdc9" font-family="JetBrains Mono, monospace" font-size="11">${escXml(m.species)} (${escXml(m.mode)})</text>`
    : "";

  // Colorbar at bottom y=664..678
  const cbX = fx, cbY = 668, cbW = 360, cbH = 12;
  const cbTicks = leg.ticks.map(t => {
    const tx = +(cbX + t.frac * cbW).toFixed(2);
    return `<line x1="${tx}" y1="${cbY + cbH}" x2="${tx}" y2="${cbY + cbH + 4}" stroke="#b3bdc9" stroke-width="1"/>` +
      `<text x="${tx}" y="${cbY + cbH + 15}" text-anchor="middle" fill="#b3bdc9" font-family="JetBrains Mono, monospace" font-size="10.5">${escXml(t.label)}</text>`;
  }).join("");

  const legendSvg = opts.legend !== false
    ? `<g id="colorbar">` +
      `<text x="${cbX}" y="${cbY - 7}" fill="#e9eef4" font-family="Space Grotesk, system-ui, sans-serif" font-size="11.5" font-weight="500">${escXml(leg.titlePlain)}</text>` +
      `<rect x="${cbX}" y="${cbY}" width="${cbW}" height="${cbH}" rx="2" fill="url(#cmap-grad)" stroke="#2f3844" stroke-width="1"/>` +
      cbTicks +
      `</g>`
    : "";

  const keySvg = opts.sightlines !== false
    ? `<g id="sightlines-key" transform="translate(${fx + 400}, ${cbY - 4})">` +
      `<line x1="0" y1="6" x2="18" y2="6" stroke="#8d97a6" stroke-width="1.6"/><text x="24" y="9.5" fill="#b3bdc9" font-family="Space Grotesk, sans-serif" font-size="10.5">library</text>` +
      `<line x1="78" y1="6" x2="96" y2="6" stroke="#7db2f0" stroke-width="1.6"/><text x="102" y="9.5" fill="#b3bdc9" font-family="Space Grotesk, sans-serif" font-size="10.5">generated</text>` +
      `<line x1="0" y1="22" x2="18" y2="22" stroke="#f39a5c" stroke-width="1.6"/><text x="24" y="25.5" fill="#b3bdc9" font-family="Space Grotesk, sans-serif" font-size="10.5">custom</text>` +
      `<line x1="78" y1="22" x2="96" y2="22" stroke="#e9eef4" stroke-width="2.6"/><text x="102" y="25.5" fill="#e9eef4" font-family="Space Grotesk, sans-serif" font-size="10.5">selected</text>` +
      `</g>`
    : "";

  const metaJson = JSON.stringify({
    generator: "CGM 3D Explorer exportSVG",
    timestamp: new Date().toISOString(),
    deepLink: buildDeepLink(viewer),
    latexCaption: latex,
    scene: m.snap
  }, null, 2);

  const svg = `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 680 760" width="680" height="760">
  <metadata>
    <scene-json>${escXml(metaJson)}</scene-json>
    <latex-caption>${escXml(latex)}</latex-caption>
  </metadata>
  <defs>
    <linearGradient id="cmap-grad" x1="0%" y1="0%" x2="100%" y2="0%">${gradStops}</linearGradient>
    <clipPath id="stage-clip"><rect x="${fx}" y="${fy}" width="${fw}" height="${fh}"/></clipPath>
  </defs>
  ${transparent ? "" : `<rect x="0" y="0" width="680" height="760" fill="${BG_HEX}"/>`}
  ${stampSvg}
  <g clip-path="url(#stage-clip)">
    ${transparent ? "" : `<rect x="${fx}" y="${fy}" width="${fw}" height="${fh}" fill="${BG_HEX}"/>`}
    <image href="${pngDataUrl}" x="${fx}" y="${fy}" width="${fw}" height="${fh}" preserveAspectRatio="xMidYMid slice"/>
    ${guideSvg}
    ${linesSvg}
    ${scaleSvg}
  </g>
  <rect x="${fx}" y="${fy}" width="${fw}" height="${fh}" fill="none" stroke="#3c4657" stroke-width="1.1"/>
  ${xTickSvg}
  ${yTickSvg}
  <text x="${fx + fw / 2}" y="${fy + fh + 34}" text-anchor="middle" fill="#b3bdc9" font-family="Space Grotesk, system-ui, sans-serif" font-size="11.5">Δx [${escXml(sc.unitLabel)}]</text>
  <text x="18" y="${fy + fh / 2}" text-anchor="middle" fill="#b3bdc9" font-family="Space Grotesk, system-ui, sans-serif" font-size="11.5" transform="rotate(-90 18 ${fy + fh / 2})">Δy [${escXml(sc.unitLabel)}]</text>
  ${legendSvg}
  ${keySvg}
</svg>`;

  const filename = opts.filename || buildFilename(viewer, volRender.width, volRender.height, "svg");
  const blob = new Blob([svg], {type: "image/svg+xml;charset=utf-8"});
  if (opts.download !== false) triggerDownload(blob, filename);
  return {blob, filename, svg, latex};
}

/* ---- 3. exportPDF: Zero-dependency single-page PDF 1.4 generator with CompressionStream("deflate") ---- */
async function deflateBytes(uint8) {
  if (typeof CompressionStream !== "undefined") {
    try {
      const cs = new CompressionStream("deflate");
      const writer = cs.writable.getWriter();
      writer.write(uint8);
      writer.close();
      const buf = await new Response(cs.readable).arrayBuffer();
      return new Uint8Array(buf);
    } catch { /* fallback to uncompressed zlib wrapper */ }
  }
  // Uncompressed zlib store blocks fallback if CompressionStream unavailable
  const chunks = [];
  let adlerA = 1, adlerB = 0;
  for (let i = 0; i < uint8.length; i++) {
    adlerA = (adlerA + uint8[i]) % 65521;
    adlerB = (adlerB + adlerA) % 65521;
  }
  chunks.push(new Uint8Array([0x78, 0x01]));
  let pos = 0;
  while (pos < uint8.length) {
    const len = Math.min(65535, uint8.length - pos);
    const last = pos + len >= uint8.length ? 1 : 0;
    const hdr = new Uint8Array(5);
    hdr[0] = last;
    hdr[1] = len & 0xff; hdr[2] = (len >> 8) & 0xff;
    const nlen = (~len) & 0xffff;
    hdr[3] = nlen & 0xff; hdr[4] = (nlen >> 8) & 0xff;
    chunks.push(hdr, uint8.subarray(pos, pos + len));
    pos += len;
  }
  const adler = new Uint8Array([(adlerB >> 8) & 0xff, adlerB & 0xff, (adlerA >> 8) & 0xff, adlerA & 0xff]);
  chunks.push(adler);
  const total = chunks.reduce((a, c) => a + c.length, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) { out.set(c, off); off += c.length; }
  return out;
}

const pdfEsc = s => String(s ?? "")
  .replace(/log₁₀/g, "log10")
  .replace(/cm⁻²/g, "cm^-2")
  .replace(/cm⁻³/g, "cm^-3")
  .replace(/Z☉/g, "Zsun")
  .replace(/[⟨⟩]/g, "")
  .replace(/−/g, "-")
  .replace(/[^\x20-\x7e]/g, " ")
  .replace(/([()\\])/g, "\\$1");

export async function exportPDF(viewer, opts = {}) {
  const {canvas, width: W, height: H} = await renderHighDPI(viewer, opts);
  const ctx = canvas.getContext("2d");
  const rgba = ctx.getImageData(0, 0, W, H).data;
  const rgb = new Uint8Array(W * H * 3);
  for (let i = 0, j = 0; i < rgba.length; i += 4, j += 3) {
    const a = rgba[i + 3] / 255;
    rgb[j] = Math.round(rgba[i] * a + BG_RGB[0] * (1 - a));
    rgb[j + 1] = Math.round(rgba[i + 1] * a + BG_RGB[1] * (1 - a));
    rgb[j + 2] = Math.round(rgba[i + 2] * a + BG_RGB[2] * (1 - a));
  }
  const compressedImg = await deflateBytes(rgb);

  const m = sceneMeta(viewer);
  const leg = getLegendInfo(viewer);
  const sc = getScaleInfo(viewer, 480, 480);

  // Page size: 612 x 692 pt (PDF coordinates: y=0 at bottom, y=692 at top)
  const PW = 612, PH = 692;
  const fx = 66, fy = 156, fw = 480, fh = 480;
  const cmds = [];

  // Dark page background
  if (opts.background !== "transparent") {
    cmds.push("0.02 0.027 0.043 rg", `0 0 ${PW} ${PH} re f`);
  }

  // Draw embedded high-DPI volume XObject
  cmds.push("q", `${fw} 0 0 ${fh} ${fx} ${fy} cm`, "/Im0 Do", "Q");

  // Vector frame border
  cmds.push("0.32 0.37 0.45 RG", "1 w", `${fx} ${fy} ${fw} ${fh} re S`);

  // Header stamp
  if (opts.stamp !== false) {
    const headL = pdfEsc(`${m.sim}   Subhalo ${m.galId}   z = ${m.z}`);
    const headR = pdfEsc(`${m.species} (${m.mode})`);
    cmds.push(
      "BT", "/F1 12 Tf", "0.91 0.93 0.96 rg", `${fx} ${fy + fh + 16} Td`, `(${headL}) Tj`, "ET",
      "BT", "/F2 10 Tf", "0.70 0.74 0.79 rg", `${fx + fw - headR.length * 6} ${fy + fh + 16} Td`, `(${headR}) Tj`, "ET"
    );
  }

  // Vector frame ticks in kpc/pc
  cmds.push("0.70 0.74 0.79 RG", "0.8 w", "0.70 0.74 0.79 rg");
  for (const t of sc.xTicks) {
    const x = +(fx + t.frac * fw).toFixed(2);
    cmds.push(`${x} ${fy} m ${x} ${fy - 5} l S`, `${x} ${fy + fh} m ${x} ${fy + fh - 4} l S`);
    const lbl = pdfEsc(t.label);
    cmds.push("BT", "/F2 9 Tf", `${(x - lbl.length * 2.6).toFixed(2)} ${fy - 15} Td`, `(${lbl}) Tj`, "ET");
  }
  for (const t of sc.yTicks) {
    // t.frac is top-down; convert to PDF bottom-up
    const y = +(fy + (1 - t.frac) * fh).toFixed(2);
    cmds.push(`${fx} ${y} m ${fx - 5} ${y} l S`, `${fx + fw} ${y} m ${fx + fw - 4} ${y} l S`);
    const lbl = pdfEsc(t.label);
    cmds.push("BT", "/F2 9 Tf", `${(fx - 8 - lbl.length * 5.2).toFixed(2)} ${(y - 3).toFixed(2)} Td`, `(${lbl}) Tj`, "ET");
  }
  cmds.push(
    "BT", "/F1 10 Tf", `${(fx + fw / 2 - 22).toFixed(1)} ${fy - 29} Td`, `(dx [${pdfEsc(sc.unitLabel)}]) Tj`, "ET",
    "BT", "/F1 10 Tf", `18 ${(fy + fh / 2).toFixed(1)} Td`, `(dy [${pdfEsc(sc.unitLabel)}]) Tj`, "ET"
  );

  // Vector physical scale bar inside bottom-right of frame
  if (opts.scaleBar !== false) {
    const bw = +sc.barPx.toFixed(2);
    const bx = +(fx + fw - 18 - bw).toFixed(2), by = fy + 20;
    cmds.push(
      "0.05 0.06 0.09 rg", `${(bx - 6).toFixed(2)} ${by - 12} ${(bw + 12).toFixed(2)} 24 re f`,
      "0.91 0.93 0.96 RG", "1.3 w",
      `${bx} ${by + 5} m ${bx} ${by} l ${(bx + bw).toFixed(2)} ${by} l ${(bx + bw).toFixed(2)} ${by + 5} l S`,
      "0.91 0.93 0.96 rg",
      "BT", "/F2 9.5 Tf", `${(bx + bw / 2 - sc.label.length * 2.7).toFixed(2)} ${by - 9} Td`, `(${pdfEsc(sc.label)}) Tj`, "ET"
    );
  }

  // Vector 64-stop colorbar below frame
  if (opts.legend !== false) {
    const cbX = fx, cbY = 74, cbW = 340, cbH = 11;
    const sw = cbW / leg.stops.length;
    cmds.push("BT", "/F1 10.5 Tf", "0.91 0.93 0.96 rg", `${cbX} ${cbY + cbH + 7} Td`, `(${pdfEsc(leg.titlePlain)}) Tj`, "ET");
    leg.stops.forEach(([r, g, b], i) => {
      const rx = +(cbX + i * sw).toFixed(2);
      cmds.push(`${(r / 255).toFixed(3)} ${(g / 255).toFixed(3)} ${(b / 255).toFixed(3)} rg`, `${rx} ${cbY} ${(sw + 0.4).toFixed(2)} ${cbH} re f`);
    });
    cmds.push("0.25 0.30 0.38 RG", "0.8 w", `${cbX} ${cbY} ${cbW} ${cbH} re S`, "0.70 0.74 0.79 RG", "0.70 0.74 0.79 rg");
    for (const t of leg.ticks) {
      const tx = +(cbX + t.frac * cbW).toFixed(2);
      const lbl = pdfEsc(t.label);
      cmds.push(`${tx} ${cbY} m ${tx} ${cbY - 4} l S`, "BT", "/F2 9 Tf", `${(tx - lbl.length * 2.5).toFixed(2)} ${cbY - 14} Td`, `(${lbl}) Tj`, "ET");
    }
  }

  const contentBytes = new TextEncoder().encode(cmds.join("\n") + "\n");
  const compressedContent = await deflateBytes(contentBytes);

  // Assemble PDF 1.4 binary
  const parts = [];
  const offsets = [];
  let byteLen = 0;
  const enc = new TextEncoder();
  const pushStr = s => { const b = enc.encode(s); parts.push(b); byteLen += b.length; };
  const pushBin = b => { parts.push(b); byteLen += b.length; };
  const startObj = id => { offsets[id] = byteLen; pushStr(`${id} 0 obj\n`); };
  const endObj = () => pushStr("\nendobj\n");

  pushStr("%PDF-1.4\n%\xFF\xFF\xFF\xFF\n");
  startObj(1); pushStr("<< /Type /Catalog /Pages 2 0 R >>"); endObj();
  startObj(2); pushStr("<< /Type /Pages /Kids [3 0 R] /Count 1 >>"); endObj();
  startObj(3); pushStr(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${PW} ${PH}] /Resources << /Font << /F1 4 0 R /F2 5 0 R >> /XObject << /Im0 6 0 R >> >> /Contents 7 0 R >>`); endObj();
  startObj(4); pushStr("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>"); endObj();
  startObj(5); pushStr("<< /Type /Font /Subtype /Type1 /BaseFont /Courier >>"); endObj();
  startObj(6);
  pushStr(`<< /Type /XObject /Subtype /Image /Width ${W} /Height ${H} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /FlateDecode /Length ${compressedImg.length} >>\nstream\n`);
  pushBin(compressedImg);
  pushStr("\nendstream");
  endObj();
  startObj(7);
  pushStr(`<< /Filter /FlateDecode /Length ${compressedContent.length} >>\nstream\n`);
  pushBin(compressedContent);
  pushStr("\nendstream");
  endObj();

  const xrefOff = byteLen;
  pushStr("xref\n0 8\n0000000000 65535 f \n");
  for (let i = 1; i <= 7; i++) {
    pushStr(String(offsets[i]).padStart(10, "0") + " 00000 n \n");
  }
  pushStr(`trailer\n<< /Size 8 /Root 1 0 R >>\nstartxref\n${xrefOff}\n%%EOF\n`);

  const pdfBytes = new Uint8Array(byteLen);
  let p = 0;
  for (const chunk of parts) { pdfBytes.set(chunk, p); p += chunk.length; }

  const filename = opts.filename || buildFilename(viewer, W, H, "pdf");
  const blob = new Blob([pdfBytes], {type: "application/pdf"});
  if (opts.download !== false) triggerDownload(blob, filename);
  return {blob, filename, bytes: pdfBytes, width: W, height: H};
}

/* ---- 4. exportHTML & exportJSON ---- */
export function exportJSON(viewer, opts = {}) {
  const m = sceneMeta(viewer);
  const payload = {
    version: 1,
    timestamp: new Date().toISOString(),
    deepLink: buildDeepLink(viewer),
    latexCaption: buildLatexCaption(viewer),
    scene: m.snap
  };
  const json = JSON.stringify(payload, null, 2);
  const filename = opts.filename || buildFilename(viewer, null, null, "json");
  const blob = new Blob([json], {type: "application/json;charset=utf-8"});
  if (opts.download !== false) triggerDownload(blob, filename);
  return {blob, filename, json, snapshot: m.snap};
}

export async function exportHTML(viewer, opts = {}) {
  const pngRes = await exportPNG(viewer, {...opts, download: false});
  const m = sceneMeta(viewer);
  const lines = projectVisibleSightlines(viewer, 640, 640);
  const deepLink = buildDeepLink(viewer);
  const latex = buildLatexCaption(viewer);
  const sceneJson = JSON.stringify(m.snap, null, 2);

  const svgLines = lines.map(l => {
    const ions = Object.entries(l.logN || {})
      .filter(([, v]) => Number.isFinite(+v) && +v > 10)
      .slice(0, 6)
      .map(([k, v]) => `${k}: ${(+v).toFixed(2)}`)
      .join(", ");
    return `<line class="sl" x1="${l.x1}" y1="${l.y1}" x2="${l.x2}" y2="${l.y2}" ` +
      `stroke="${l.color}" stroke-width="${l.selected ? 3.5 : 2}" stroke-opacity="${l.selected ? 0.95 : 0.45}" ` +
      `data-id="${escHtml(l.id)}" data-b="${escHtml(l.b_kpc ?? "n/a")}" data-orient="${escHtml(l.orientation)}" data-ions="${escHtml(ions || "none")}"/>`;
  }).join("\n        ");

  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escHtml(m.sim)} Subhalo ${escHtml(m.galId)} - 3D Snapshot (${escHtml(m.species)}, ${escHtml(m.mode)})</title>
<style>
  :root { color-scheme: dark; --bg: #07090f; --card: rgba(20,25,40,0.86); --edge: rgba(190,205,255,0.16); --ink: #eef0f7; --muted: #a0a8c0; --accent: #8fa8ff; }
  * { box-sizing: border-box; }
  body { margin: 0; padding: 24px; background: radial-gradient(900px 600px at 15% -10%, rgba(96,72,222,0.28), transparent 60%), var(--bg); color: var(--ink); font: 13.5px/1.5 system-ui, -apple-system, sans-serif; display: grid; justify-content: center; }
  .wrap { max-width: 960px; width: 100%; display: grid; grid-template-columns: minmax(320px, 640px) minmax(240px, 300px); gap: 18px; align-items: start; }
  @media (max-width: 860px) { .wrap { grid-template-columns: 1fr; } }
  .stage { position: relative; width: 100%; aspect-ratio: 1/1; border-radius: 16px; overflow: hidden; border: 1px solid var(--edge); background: #05070b; box-shadow: 0 18px 48px rgba(0,0,0,0.55); }
  .stage img { display: block; width: 100%; height: 100%; object-fit: contain; }
  .stage svg { position: absolute; inset: 0; width: 100%; height: 100%; }
  .stage .sl { cursor: pointer; transition: stroke-width 0.12s, stroke-opacity 0.12s; }
  .stage .sl:hover { stroke-width: 5px; stroke-opacity: 1; }
  .card { background: var(--card); border: 1px solid var(--edge); border-radius: 14px; padding: 14px; display: flex; flex-direction: column; gap: 10px; }
  h1 { margin: 0; font-size: 15px; font-weight: 600; }
  h2 { margin: 0; font-size: 11px; text-transform: uppercase; letter-spacing: 0.1em; color: var(--muted); font-family: ui-monospace, monospace; }
  .kv { font-family: ui-monospace, monospace; font-size: 12px; color: var(--muted); display: grid; gap: 4px; }
  .kv b { color: var(--ink); font-weight: 500; }
  textarea { width: 100%; min-height: 84px; background: rgba(0,0,0,0.32); color: var(--ink); border: 1px solid var(--edge); border-radius: 8px; padding: 8px; font: 11.5px/1.4 ui-monospace, monospace; resize: vertical; }
  .btn { display: inline-flex; align-items: center; justify-content: center; height: 32px; padding: 0 12px; border-radius: 9px; border: 1px solid var(--accent); background: var(--accent); color: #0a0d18; font-weight: 600; text-decoration: none; cursor: pointer; font-size: 12.5px; }
  .btn.sec { background: rgba(143,168,255,0.12); color: var(--ink); }
</style>
</head>
<body>
  <div class="wrap">
    <div class="stage">
      <img src="${pngRes.dataUrl}" alt="3D CGM volume snapshot">
      <svg viewBox="0 0 640 640" aria-label="Interactive sightline overlay">
        ${svgLines}
      </svg>
    </div>
    <div class="card">
      <h1>${escHtml(m.sim)} Subhalo ${escHtml(m.galId)} (z = ${escHtml(m.z)})</h1>
      <div class="kv">
        <span>Field: <b>${escHtml(m.species)}</b> (${escHtml(m.mode)})</span>
        <span>R200c: <b>${Math.round(m.R200c)} kpc</b></span>
      </div>
      <h2>Sightline Inspector</h2>
      <div class="kv" id="sl-info">Hover or tap a sightline on the figure to inspect its ID, impact parameter b, and ion column densities.</div>
      <h2>LaTeX Caption</h2>
      <textarea id="latex-cap" readonly>${escHtml(latex)}</textarea>
      <button type="button" class="btn sec" id="copy-cap">Copy LaTeX caption</button>
      <a class="btn" href="${escHtml(deepLink)}" target="_blank" rel="noopener">Open Live in Explorer</a>
    </div>
  </div>
  <script id="scene-state" type="application/json">${sceneJson.replace(/<\//g, "<\\/")}</script>
  <script>
    const info = document.getElementById("sl-info");
    document.querySelectorAll(".sl").forEach(el => {
      const show = () => {
        info.innerHTML = "ID: <b>" + el.dataset.id + "</b><br>Orientation: <b>" + el.dataset.orient + "</b><br>Impact parameter b: <b>" + el.dataset.b + " kpc</b><br>log10 N [cm^-2]: <b>" + el.dataset.ions + "</b>";
      };
      el.addEventListener("mouseenter", show);
      el.addEventListener("click", show);
    });
    document.getElementById("copy-cap").addEventListener("click", async () => {
      const t = document.getElementById("latex-cap");
      t.select();
      try { await navigator.clipboard.writeText(t.value); } catch { document.execCommand("copy"); }
    });
  </script>
</body>
</html>`;

  const filename = opts.filename || buildFilename(viewer, pngRes.width, pngRes.height, "html");
  const blob = new Blob([html], {type: "text/html;charset=utf-8"});
  if (opts.download !== false) triggerDownload(blob, filename);
  return {blob, filename, html, deepLink, latex};
}
