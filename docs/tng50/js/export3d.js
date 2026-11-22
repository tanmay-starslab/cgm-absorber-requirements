// Publication-grade 3D & Spectra figure export module (docs/tng50/js/export3d.js).
// Follows the house publication-plots standard (pubplot.py / COS-GASS / M61 / SBI_CGM):
//   - Authentic Computer Modern typography (TeX cmr10, cmmi10, cmsy10, cmex10 vector glyph outlines via cm_font.js)
//   - Boxed axes on all 4 sides with inward-pointing major AND minor ticks on all 4 sides (top, bottom, left, right)
//   - Full-height vertical colorbar on the right of the 3D frame with inward ticks and rotated LaTeX math label + [units]
//   - Physical offset axes (\Delta x [kpc/pc], \Delta y [kpc/pc]), scale bar, R200c guide circle, sightline legend,
//     galaxy/simulation stamp, and wrapped Computer Modern caption block below the figure
//   - Exact 8-frame sub-pixel accumulated high-DPI render (default 400 dpi at 7.1 in double-column width)
//   - Zero-dependency vector PDF 1.4 generator (with PNG pHYs 400 dpi metadata on PNGs) + Copy LaTeX figure snippet.
import {lut} from "./colormaps.js";
import {buildTF, TF_W, TF_H} from "./tf.js";
import {CM_GLYPHS} from "./cm_font.js";

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

/* ---- PNG 400 DPI pHYs chunk injector ---- */
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf, start, end) {
  let c = 0xffffffff;
  for (let i = start; i < end; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

export function injectPngDpi(pngBytes, dpi = 400) {
  const u8 = pngBytes instanceof Uint8Array ? pngBytes : new Uint8Array(pngBytes);
  // PNG signature (8 bytes) + IHDR chunk (4 len + 4 type + 13 data + 4 crc = 25 bytes) -> offset 33
  if (u8.length < 33 || u8[0] !== 0x89 || u8[1] !== 0x50 || u8[2] !== 0x4e || u8[3] !== 0x47) return u8;
  const ppm = Math.round(dpi / 0.0254); // 400 dpi = 15748 pixels per meter
  const phys = new Uint8Array(21);
  const dv = new DataView(phys.buffer);
  dv.setUint32(0, 9, false); // chunk data length = 9
  phys[4] = 0x70; phys[5] = 0x48; phys[6] = 0x59; phys[7] = 0x73; // "pHYs"
  dv.setUint32(8, ppm, false);
  dv.setUint32(12, ppm, false);
  phys[16] = 1; // unit = meter
  dv.setUint32(17, crc32(phys, 4, 17), false);

  const out = new Uint8Array(u8.length + 21);
  out.set(u8.subarray(0, 33), 0);
  out.set(phys, 33);
  out.set(u8.subarray(33), 54);
  return out;
}

/* ---- Computer Modern TeX Math & Typography Engine (cm_font.js) ---- */
const ION_TEX = {
  HI: "H\\,I", MgII: "Mg\\,II", SiII: "Si\\,II", CII: "C\\,II",
  SiIII: "Si\\,III", CIII: "C\\,III", SiIV: "Si\\,IV", CIV: "C\\,IV",
  NV: "N\\,V", OVI: "O\\,VI", NeVIII: "Ne\\,VIII", OVII: "O\\,VII"
};

function readGroup(s, i) {
  if (i >= s.length) return ["", i];
  if (s[i] === "{") {
    let depth = 1, j = i + 1;
    while (j < s.length && depth > 0) {
      if (s[j] === "{") depth++;
      else if (s[j] === "}") depth--;
      j++;
    }
    return [s.slice(i + 1, j - 1), j];
  }
  if (s[i] === "\\") {
    let j = i + 1;
    while (j < s.length && /[a-zA-Z]/.test(s[j])) j++;
    if (j === i + 1 && j < s.length) j++;
    return [s.slice(i, j), j];
  }
  return [s[i], i + 1];
}

// Parses a LaTeX-aware string into positioned Computer Modern glyphs in 1000-unit em space.
// Outside $...$, text is upright Roman (cmr10). Inside $...$, letters default to math italic (cmmi10)
// unless wrapped in \mathrm{...}. Supports _{...}, ^{...}, \, \; \quad and TeX symbols.
export function layoutCMText(str) {
  const s = String(str ?? "");
  const glyphs = [];
  let cursorX = 0;

  const lookupGlyph = (fontKey, name) => {
    const f = CM_GLYPHS[fontKey] || CM_GLYPHS.r;
    return f[name] || CM_GLYPHS.r[name] || CM_GLYPHS.r[" "] || [333.3, ""];
  };

  const emitSeq = (text, inMath, forceRoman, scale, yOff) => {
    let i = 0;
    while (i < text.length) {
      const ch = text[i];
      if (ch === "$") {
        inMath = !inMath;
        i++;
        continue;
      }
      if (ch === "{") {
        const [grp, nextI] = readGroup(text, i);
        emitSeq(grp, inMath, forceRoman, scale, yOff);
        i = nextI;
        continue;
      }
      if (ch === "_" || ch === "^") {
        if (!inMath && ch === "_") {
          const [adv] = lookupGlyph("r", "-");
          glyphs.push({d: "M40 -120L520 -120L520 -65L40 -65Z", x: cursorX, y: yOff, scale, adv: 560});
          cursorX += 560 * scale;
          i++;
          continue;
        }
        const isSub = ch === "_";
        const [grp, nextI] = readGroup(text, i + 1);
        const subScale = scale * 0.7;
        const subY = yOff + (isSub ? -180 * scale : 380 * scale);
        const savedX = cursorX;
        emitSeq(grp, inMath, forceRoman, subScale, subY);
        i = nextI;
        // Check if immediately followed by the opposite script (^ after _ or _ after ^)
        if (i < text.length && ((isSub && text[i] === "^") || (!isSub && text[i] === "_"))) {
          const afterFirstX = cursorX;
          const isSub2 = text[i] === "_";
          const [grp2, nextI2] = readGroup(text, i + 1);
          cursorX = savedX;
          emitSeq(grp2, inMath, forceRoman, subScale, yOff + (isSub2 ? -180 * scale : 380 * scale));
          cursorX = Math.max(afterFirstX, cursorX);
          i = nextI2;
        }
        continue;
      }
      if (ch === "\\") {
        if (text[i + 1] === ",") { cursorX += 167 * scale; i += 2; continue; }
        if (text[i + 1] === ";" || text[i + 1] === " ") { cursorX += 278 * scale; i += 2; continue; }
        if (text[i + 1] === "_") {
          glyphs.push({d: "M40 -120L520 -120L520 -65L40 -65Z", x: cursorX, y: yOff, scale, adv: 560});
          cursorX += 560 * scale;
          i += 2;
          continue;
        }
        let j = i + 1;
        while (j < text.length && /[a-zA-Z]/.test(text[j])) j++;
        const cmd = text.slice(i + 1, j);
        i = j;
        if (cmd === "mathrm" || cmd === "rm" || cmd === "text" || cmd === "texttt") {
          const [grp, nextI] = readGroup(text, i);
          emitSeq(grp, inMath, true, scale, yOff);
          i = nextI;
          continue;
        }
        if (cmd === "log" || cmd === "ln" || cmd === "sin" || cmd === "cos" || cmd === "tan" || cmd === "min" || cmd === "max") {
          emitSeq(cmd, false, true, scale, yOff);
          if (i < text.length && text[i] !== "_" && text[i] !== "^" && text[i] !== "(") cursorX += 120 * scale;
          continue;
        }
        const SYM_MAP = {
          Delta: ["r", "Delta"],
          sigma: ["i", "sigma"], mu: ["i", "mu"], phi: ["i", "phi"], varphi: ["i", "varphi"],
          gamma: ["i", "gamma"], alpha: ["i", "alpha"], beta: ["i", "beta"], lambda: ["i", "lambda"],
          rho: ["i", "rho"], tau: ["i", "tau"],
          odot: ["sy", "odot"], propto: ["sy", "propto"], times: ["sy", "times"], cdot: ["sy", "cdot"],
          pm: ["sy", "pm"], approx: ["sy", "approx"], circ: ["sy", "circ"],
          langle: ["ex", "langle"], rangle: ["ex", "rangle"]
        };
        if (SYM_MAP[cmd]) {
          const [fk, gk] = SYM_MAP[cmd];
          const [adv, d] = lookupGlyph(fk, gk);
          if (d) glyphs.push({d, x: cursorX, y: yOff, scale, adv});
          cursorX += adv * scale;
          continue;
        }
        continue;
      }
      // Unicode symbol shorthands
      if (ch === "Δ") { const [adv, d] = lookupGlyph("r", "Delta"); glyphs.push({d, x: cursorX, y: yOff, scale, adv}); cursorX += adv * scale; i++; continue; }
      if (ch === "σ") { const [adv, d] = lookupGlyph("i", "sigma"); glyphs.push({d, x: cursorX, y: yOff, scale, adv}); cursorX += adv * scale; i++; continue; }
      if (ch === "μ") { const [adv, d] = lookupGlyph("i", "mu"); glyphs.push({d, x: cursorX, y: yOff, scale, adv}); cursorX += adv * scale; i++; continue; }
      if (ch === "φ") { const [adv, d] = lookupGlyph("i", "phi"); glyphs.push({d, x: cursorX, y: yOff, scale, adv}); cursorX += adv * scale; i++; continue; }
      if (ch === "γ") { const [adv, d] = lookupGlyph("i", "gamma"); glyphs.push({d, x: cursorX, y: yOff, scale, adv}); cursorX += adv * scale; i++; continue; }
      if (ch === "⟨") { const [adv, d] = lookupGlyph("ex", "langle"); glyphs.push({d, x: cursorX, y: yOff, scale, adv}); cursorX += adv * scale; i++; continue; }
      if (ch === "⟩") { const [adv, d] = lookupGlyph("ex", "rangle"); glyphs.push({d, x: cursorX, y: yOff, scale, adv}); cursorX += adv * scale; i++; continue; }
      if (ch === "☉") { const [adv, d] = lookupGlyph("sy", "odot"); glyphs.push({d, x: cursorX, y: yOff, scale, adv}); cursorX += adv * scale; i++; continue; }
      if (ch === "∝") { const [adv, d] = lookupGlyph("sy", "propto"); glyphs.push({d, x: cursorX, y: yOff, scale, adv}); cursorX += adv * scale; i++; continue; }
      if (ch === "±") { const [adv, d] = lookupGlyph("sy", "pm"); glyphs.push({d, x: cursorX, y: yOff, scale, adv}); cursorX += adv * scale; i++; continue; }
      if (ch === "×") { const [adv, d] = lookupGlyph("sy", "times"); glyphs.push({d, x: cursorX, y: yOff, scale, adv}); cursorX += adv * scale; i++; continue; }
      if (ch === "°") { const [adv, d] = lookupGlyph("sy", "circ"); glyphs.push({d, x: cursorX, y: yOff + 380 * scale, scale: scale * 0.7, adv}); cursorX += adv * scale * 0.7; i++; continue; }
      if (ch === "−" || (ch === "-" && (inMath || /^[\d.]/.test(text.slice(i + 1))) && !(i > 0 && /[a-zA-Z0-9]/.test(text[i - 1]) && !inMath))) {
        const [adv, d] = lookupGlyph("sy", "minus");
        glyphs.push({d, x: cursorX, y: yOff, scale, adv});
        cursorX += adv * scale;
        i++;
        continue;
      }
      if (ch === " ") {
        cursorX += (inMath ? 220 : 333.3) * scale;
        i++;
        continue;
      }
      const useItalic = inMath && !forceRoman && /[a-zA-Z]/.test(ch);
      const fk = useItalic ? "i" : "r";
      const [adv, d] = lookupGlyph(fk, ch);
      if (d) glyphs.push({d, x: cursorX, y: yOff, scale, adv});
      cursorX += adv * scale;
      i++;
    }
  };

  emitSeq(s, false, false, 1.0, 0.0);
  return {glyphs, widthEm: cursorX / 1000};
}

export function measureCMText(str, fontSizePt) {
  return layoutCMText(str).widthEm * fontSizePt;
}

// Parse path string "M... L... Q... C... Z" into command tokens
function parseGlyphOps(d) {
  const ops = [];
  const re = /([MLQCZ])([^MLQCZ]*)/g;
  let m;
  while ((m = re.exec(d)) !== null) {
    const type = m[1];
    const nums = m[2].trim() ? m[2].trim().split(/\s+/).map(Number) : [];
    ops.push([type, nums]);
  }
  return ops;
}

// Render Computer Modern string onto a 2D Canvas context (y-down coordinates)
export function drawCMCanvas(ctx, str, x, y, fontSizePx, {align = "left", color = "#111111", rotateDeg = 0} = {}) {
  const layout = layoutCMText(str);
  const totalW = layout.widthEm * fontSizePx;
  ctx.save();
  ctx.translate(x, y);
  if (rotateDeg) ctx.rotate((rotateDeg * Math.PI) / 180);
  let x0 = 0;
  if (align === "center") x0 = -totalW / 2;
  else if (align === "right") x0 = -totalW;

  ctx.fillStyle = color;
  const unit = fontSizePx / 1000;
  for (const g of layout.glyphs) {
    if (!g.d) continue;
    const gx = x0 + g.x * unit;
    const gy = -g.y * unit;
    const gs = g.scale * unit;
    ctx.beginPath();
    for (const [type, n] of parseGlyphOps(g.d)) {
      if (type === "M") ctx.moveTo(gx + n[0] * gs, gy - n[1] * gs);
      else if (type === "L") ctx.lineTo(gx + n[0] * gs, gy - n[1] * gs);
      else if (type === "Q") ctx.quadraticCurveTo(gx + n[0] * gs, gy - n[1] * gs, gx + n[2] * gs, gy - n[3] * gs);
      else if (type === "C") ctx.bezierCurveTo(gx + n[0] * gs, gy - n[1] * gs, gx + n[2] * gs, gy - n[3] * gs, gx + n[4] * gs, gy - n[5] * gs);
      else if (type === "Z") ctx.closePath();
    }
    ctx.fill();
  }
  ctx.restore();
  return totalW;
}

// Render Computer Modern string into PDF 1.4 vector path commands (y-up coordinates!)
// Converts quadratic Beziers (Q x1 y1 x2 y2) to exact cubic Beziers (c) for PDF 1.4.
export function drawCMPdf(cmds, str, x, y, fontSizePt, {align = "left", rgb = [0.07, 0.07, 0.07], rotateDeg = 0} = {}) {
  const layout = layoutCMText(str);
  const totalW = layout.widthEm * fontSizePt;
  let x0 = 0;
  if (align === "center") x0 = -totalW / 2;
  else if (align === "right") x0 = -totalW;

  const rad = (rotateDeg * Math.PI) / 180;
  const cos = Math.cos(rad), sin = Math.sin(rad);
  const tx = (px, py) => +(x + px * cos - py * sin).toFixed(2);
  const ty = (px, py) => +(y + px * sin + py * cos).toFixed(2);

  cmds.push("q", `${rgb[0].toFixed(3)} ${rgb[1].toFixed(3)} ${rgb[2].toFixed(3)} rg`);
  const unit = fontSizePt / 1000;
  for (const g of layout.glyphs) {
    if (!g.d) continue;
    const gx = x0 + g.x * unit;
    const gy = g.y * unit;
    const gs = g.scale * unit;
    let cx = 0, cy = 0;
    for (const [type, n] of parseGlyphOps(g.d)) {
      if (type === "M") {
        cx = gx + n[0] * gs; cy = gy + n[1] * gs;
        cmds.push(`${tx(cx, cy)} ${ty(cx, cy)} m`);
      } else if (type === "L") {
        cx = gx + n[0] * gs; cy = gy + n[1] * gs;
        cmds.push(`${tx(cx, cy)} ${ty(cx, cy)} l`);
      } else if (type === "Q") {
        const qx = gx + n[0] * gs, qy = gy + n[1] * gs;
        const ex = gx + n[2] * gs, ey = gy + n[3] * gs;
        const c1x = cx + (2 / 3) * (qx - cx), c1y = cy + (2 / 3) * (qy - cy);
        const c2x = ex + (2 / 3) * (qx - ex), c2y = ey + (2 / 3) * (qy - ey);
        cmds.push(`${tx(c1x, c1y)} ${ty(c1x, c1y)} ${tx(c2x, c2y)} ${ty(c2x, c2y)} ${tx(ex, ey)} ${ty(ex, ey)} c`);
        cx = ex; cy = ey;
      } else if (type === "C") {
        const c1x = gx + n[0] * gs, c1y = gy + n[1] * gs;
        const c2x = gx + n[2] * gs, c2y = gy + n[3] * gs;
        const ex = gx + n[4] * gs, ey = gy + n[5] * gs;
        cmds.push(`${tx(c1x, c1y)} ${ty(c1x, c1y)} ${tx(c2x, c2y)} ${ty(c2x, c2y)} ${tx(ex, ey)} ${ty(ex, ey)} c`);
        cx = ex; cy = ey;
      } else if (type === "Z") {
        cmds.push("h");
      }
    }
    cmds.push("f");
  }
  cmds.push("Q");
  return totalW;
}

// Render Computer Modern string into SVG <g><path .../></g> elements (y-down coordinates)
export function drawCMSvg(str, x, y, fontSizePx, {align = "left", color = "#111111", rotateDeg = 0} = {}) {
  const layout = layoutCMText(str);
  const totalW = layout.widthEm * fontSizePx;
  let x0 = 0;
  if (align === "center") x0 = -totalW / 2;
  else if (align === "right") x0 = -totalW;

  const unit = fontSizePx / 1000;
  const paths = [];
  for (const g of layout.glyphs) {
    if (!g.d) continue;
    const gx = +(x0 + g.x * unit).toFixed(2);
    const gy = +(-g.y * unit).toFixed(2);
    const gs = +(g.scale * unit).toFixed(4);
    paths.push(`<path transform="translate(${gx},${gy}) scale(${gs},-${gs})" d="${g.d}"/>`);
  }
  const tr = rotateDeg ? `translate(${x.toFixed(2)},${y.toFixed(2)}) rotate(${rotateDeg})` : `translate(${x.toFixed(2)},${y.toFixed(2)})`;
  return `<g transform="${tr}" fill="${color}">${paths.join("")}</g>`;
}

// Word-wrap a LaTeX-aware string to a maximum width in points using Computer Modern metrics
export function wrapCMText(str, fontSizePt, maxWidthPt) {
  const words = String(str ?? "").trim().split(/\s+/);
  const lines = [];
  let cur = "";
  for (const w of words) {
    const cand = cur ? `${cur} ${w}` : w;
    if (cur && measureCMText(cand, fontSizePt) > maxWidthPt) {
      lines.push(cur);
      cur = w;
    } else {
      cur = cand;
    }
  }
  if (cur) lines.push(cur);
  return lines;
}

/* ---- Scene metadata & naming helpers ---- */
export function sceneMeta(viewer) {
  const snap = typeof viewer.getSceneSnapshot === "function" ? viewer.getSceneSnapshot() : {};
  const app = viewer.app || (typeof window !== "undefined" ? window.tngApp : null);
  const cfg = app?.config || {};
  const g = cfg.galaxy || viewer.manifest?.galaxy || {};
  const simRaw = String(g.sim || "TNG50-1");
  const isFire = /fire/i.test(simRaw);
  const prefix = isFire ? "fire2" : "tng50";
  const galId = (typeof app?.galaxy === "function" ? app.galaxy() : null) ?? g.subhalo_id ?? g.id ?? "galaxy";
  const noun = isFire ? "Halo" : "Subhalo";
  const nounLower = isFire ? "halo" : "subhalo";
  const z = g.redshift ?? 0;
  const species = viewer.species || snap.species || "nH";
  const mode = viewer.mode || snap.mode || "integral";
  const R200c = viewer.frame?.R200c || g.R200c_kpc || 246.35;
  const logMstar = g.log_Mstar ?? g.logMstar ?? null;
  const logM200c = g.log_M200c ?? (g.M200c_Msun ? +(Math.log10(+g.M200c_Msun)).toFixed(2) : null);
  return {prefix, sim: simRaw, isFire, noun, nounLower, galId, z, species, mode, R200c, logMstar, logM200c, snap, app};
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

export function getFieldTexInfo(species, mode, weight = "nH") {
  const integ = mode === "integral";
  const wTex = weight === "nH" ? "n_{\\mathrm{H}}" : `n_{\\mathrm{${ION_TEX[weight] || weight}}}`;
  if (species === "nH") {
    return integ
      ? {math: "$\\log_{10} N_{\\mathrm{H}}\\ [\\mathrm{cm^{-2}}]$", desc: "projected hydrogen column density $\\log_{10} N_{\\mathrm{H}}$", unitTex: "\\mathrm{cm^{-2}}"}
      : {math: "$\\log_{10} n_{\\mathrm{H}}\\ [\\mathrm{cm^{-3}}]$", desc: "hydrogen number density $\\log_{10} n_{\\mathrm{H}}$", unitTex: "\\mathrm{cm^{-3}}"};
  }
  if (species === "T") {
    return integ
      ? {math: "$\\log_{10} \\langle T\\rangle_{n_{\\mathrm{H}}}\\ [\\mathrm{K}]$", desc: "$n_{\\mathrm{H}}$-weighted mean temperature $\\log_{10} \\langle T\\rangle$", unitTex: "\\mathrm{K}"}
      : {math: "$\\log_{10} T\\ [\\mathrm{K}]$", desc: "gas temperature $\\log_{10} T$", unitTex: "\\mathrm{K}"};
  }
  if (species === "Z") {
    return integ
      ? {math: "$\\log_{10} \\langle Z\\rangle_{n_{\\mathrm{H}}}\\ [\\mathrm{Z}_{\\odot}]$", desc: "$n_{\\mathrm{H}}$-weighted gas metallicity $\\log_{10} \\langle Z\\rangle$", unitTex: "\\mathrm{Z}_{\\odot}"}
      : {math: "$\\log_{10} Z\\ [\\mathrm{Z}_{\\odot}]$", desc: "gas metallicity $\\log_{10} Z$", unitTex: "\\mathrm{Z}_{\\odot}"};
  }
  if (ION_TEX[species]) {
    const ion = ION_TEX[species];
    return integ
      ? {math: `$\\log_{10} N_{\\mathrm{${ion}}}\\ [\\mathrm{cm^{-2}}]$`, desc: `projected $\\mathrm{${ion}}$ column density $\\log_{10} N_{\\mathrm{${ion}}}$`, unitTex: "\\mathrm{cm^{-2}}"}
      : {math: `$\\log_{10} n_{\\mathrm{${ion}}}\\ [\\mathrm{cm^{-3}}]$`, desc: `$\\mathrm{${ion}}$ number density $\\log_{10} n_{\\mathrm{${ion}}}$`, unitTex: "\\mathrm{cm^{-3}}"};
  }
  const VEL_MAP = {
    vlos: ["v_{\\mathrm{LOS}}", "line-of-sight velocity"],
    vr: ["v_{r}", "radial velocity"],
    vphi: ["v_{\\phi}", "azimuthal rotation velocity"],
    vmag: ["|v|", "gas velocity magnitude"],
    sigmalos: ["\\sigma_{\\mathrm{LOS}}", "line-of-sight velocity dispersion"]
  };
  if (VEL_MAP[species]) {
    const [sym, name] = VEL_MAP[species];
    if (species === "sigmalos") {
      return {math: `$\\sigma_{\\mathrm{LOS}}\\ [\\mathrm{km\\,s^{-1}}]$`, desc: `${name} ($${wTex}$-weighted)`, unitTex: "\\mathrm{km\\,s^{-1}}"};
    }
    return integ
      ? {math: `$\\langle ${sym}\\rangle_{${wTex}}\\ [\\mathrm{km\\,s^{-1}}]$`, desc: `$${wTex}$-weighted mean ${name} $\\langle ${sym}\\rangle$`, unitTex: "\\mathrm{km\\,s^{-1}}"}
      : {math: `$${sym}\\ [\\mathrm{km\\,s^{-1}}]$`, desc: `${name} $${sym}$ (opacity weighted by $${wTex}$)`, unitTex: "\\mathrm{km\\,s^{-1}}"};
  }
  return {math: `$${species}$`, desc: species, unitTex: ""};
}

export function buildLatexCaption(viewer) {
  const m = sceneMeta(viewer);
  const info = getLegendInfo(viewer);
  const fTex = getFieldTexInfo(m.species, m.mode, m.snap.weight || "nH");
  const cam = m.snap.camera || {position: [0, 0, 520], target: [0, 0, 0]};
  const dist = Math.round(Math.hypot(
    (cam.position?.[0] || 0) - (cam.target?.[0] || 0),
    (cam.position?.[1] || 0) - (cam.target?.[1] || 0),
    (cam.position?.[2] || 0) - (cam.target?.[2] || 0)
  ));
  const fovKpc = +(2 * dist * Math.tan((viewer.camera?.fov || 22) * Math.PI / 360)).toFixed(1);
  const fovStr = fovKpc < 2 ? `${Math.round(fovKpc * 1000)}\\,\\mathrm{pc}` : `${Math.round(fovKpc)}\\,\\mathrm{kpc}`;
  const rangeTex = `${info.lo} \\text{ to } ${info.hi}${fTex.unitTex ? `\\,\\mathrm{dex}` : ""}`;
  const starsNote = viewer.stars ? `, composited with $g, r, i$ asinh stellar light${m.snap.layers?.dust !== false ? " and 3D Pei (1992) dust attenuation" : ""}` : "";
  const sel = m.snap.selectedSightline ? `, with sightline \\texttt{${String(m.snap.selectedSightline).replace(/_/g, "\\_")}} highlighted` : "";
  return `\\caption{Three-dimensional ${m.mode === "volume" ? "ray-marched volume rendering" : "projected integral map"} of ${fTex.desc} (${info.lo} to ${info.hi}) across the circumgalactic medium of ${m.sim} ${m.nounLower} ${m.galId} at $z = ${Number(m.z).toFixed(2)}$ ($R_{200\\mathrm{c}} = ${Math.round(m.R200c)}\\,\\mathrm{kpc}$, field of view ${fovStr}${starsNote}${sel}).}`;
}

export function buildFigureVisualCaption(viewer) {
  const m = sceneMeta(viewer);
  const info = getLegendInfo(viewer);
  const fTex = getFieldTexInfo(m.species, m.mode, m.snap.weight || "nH");
  const cam = m.snap.camera || {position: [0, 0, 520], target: [0, 0, 0]};
  const dist = Math.hypot(
    (cam.position?.[0] || 0) - (cam.target?.[0] || 0),
    (cam.position?.[1] || 0) - (cam.target?.[1] || 0),
    (cam.position?.[2] || 0) - (cam.target?.[2] || 0)
  );
  const fovKpc = 2 * dist * Math.tan((viewer.camera?.fov || 22) * Math.PI / 360);
  const fovStr = fovKpc < 2 ? `${Math.round(fovKpc * 1000)} pc` : `${Math.round(fovKpc)} kpc`;
  const starsNote = viewer.stars ? `, with g, r, i stellar composite${m.snap.layers?.dust !== false ? " and 3D dust lanes" : ""}` : "";
  const sel = m.snap.selectedSightline ? `; selected ray ${m.snap.selectedSightline}` : "";
  return `Figure: ${m.sim} ${m.nounLower} ${m.galId} ($z = ${Number(m.z).toFixed(2)}$, $R_{200\\mathrm{c}} = ${Math.round(m.R200c)}$ kpc). ${m.mode === "volume" ? "Ray-marched 3D volume render" : "Projected 3D integral map"} of ${fTex.math} over [${info.lo}, ${info.hi}] across a ${fovStr} field of view${starsNote}${sel}.`;
}

export function buildLatexFigureBlock(viewer, pdfFilename) {
  const m = sceneMeta(viewer);
  const fn = pdfFilename || buildFilename(viewer, null, null, "pdf");
  const cap = buildLatexCaption(viewer);
  const cleanGal = String(m.galId).replace(/[^a-zA-Z0-9_-]/g, "");
  return [
    "\\begin{figure}",
    "  \\centering",
    `  \\includegraphics[width=\\columnwidth]{${fn}}`,
    `  ${cap}`,
    `  \\label{fig:${m.prefix}_${cleanGal}_${m.species}_${m.mode}}`,
    "\\end{figure}"
  ].join("\n");
}

/* ---- Colorbar & physical scale calculation ---- */
export function getLegendInfo(viewer) {
  const snap = typeof viewer.getSceneSnapshot === "function" ? viewer.getSceneSnapshot() : {};
  const species = viewer.species || snap.species || "nH";
  const mode = viewer.mode || snap.mode || "integral";
  const weight = viewer.weightBound || viewer.weight || snap.weight || "nH";
  const legEl = viewer.el?.querySelector?.(".v3d-leg");
  const domTitle = legEl?.querySelector?.(".ttl")?.textContent?.trim();
  const tr = snap.transfer || {lo: 13.5, hi: 21.5, cmap: "tng_dusk"};
  let lo = Number.isFinite(+tr.lo) ? +tr.lo : 13.5;
  let hi = Number.isFinite(+tr.hi) ? +tr.hi : 21.5;
  const cmap = tr.cmap || "tng_dusk";

  // Build 128 RGB stops [r, g, b] for smooth vertical publication colorbar
  const N_STOPS = 128;
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
    for (let i = 0; i < N_STOPS; i++) {
      const idx = 4 * Math.round((i / (N_STOPS - 1)) * (TF_W - 1));
      const a = row[idx + 3] / 255;
      const mix = (c, bg) => Math.round(bg + (c - bg) * Math.min(1, 1.6 * a));
      stops.push([mix(row[idx], 5), mix(row[idx + 1], 7), mix(row[idx + 2], 11)]);
    }
  } else {
    const L = lut(cmap, N_STOPS);
    for (let i = 0; i < N_STOPS; i++) {
      stops.push([L[4 * i], L[4 * i + 1], L[4 * i + 2]]);
    }
  }

  // Generate major & minor ticks for the vertical colorbar
  const span = Math.max(1e-6, hi - lo);
  const isVel = ["vlos", "vr", "vphi", "vmag", "sigmalos"].includes(species);
  const step = isVel
    ? ([10, 20, 25, 50, 100, 200, 250, 500, 1000].find(x => span / x <= 5.5) || 500)
    : (span > 6 ? 2 : span > 2.5 ? 1 : span > 1.2 ? 0.5 : span > 0.5 ? 0.2 : 0.1);
  const minorStep = step / (step === 2 || step === 0.2 || step === 20 || step === 200 ? 4 : 5);
  const ticks = [];
  for (let v = Math.ceil(lo / step - 1e-9) * step; v <= hi + 1e-9; v += step) {
    const frac = Math.max(0, Math.min(1, (v - lo) / span));
    const label = isVel
      ? ((v < -1e-9 ? "$-$" : v > 1e-9 && lo < 0 ? "$+$" : "") + Math.round(Math.abs(v)))
      : ((v < -1e-9 ? "$-$" : "") + Math.abs(+v.toFixed(1)));
    const plainLabel = label.replace(/\$/g, "");
    ticks.push({v: +v.toFixed(2), frac, label: plainLabel, mathLabel: label});
  }
  const minorTicks = [];
  for (let v = Math.ceil(lo / minorStep - 1e-9) * minorStep; v <= hi + 1e-9; v += minorStep) {
    const frac = Math.max(0, Math.min(1, (v - lo) / span));
    minorTicks.push({v: +v.toFixed(3), frac});
  }

  const fTex = getFieldTexInfo(species, mode, weight);
  const titlePlain = domTitle || (isVel
    ? `${species} [km/s] (${mode})`
    : `log10 ${species} [${mode === "integral" ? "cm^-2" : "cm^-3"}]`);
  return {titlePlain, titleMath: fTex.math, lo: +lo.toFixed(2), hi: +hi.toFixed(2), cmap, stops, ticks, minorTicks, isVel};
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
  const minBarPx = (heightPx || 600) * 0.12;
  const candidates = [0.05, 0.1, 0.2, 0.5, 1, 2, 5, 10, 20, 50, 100, 200, 500];
  const barKpc = candidates.find(v => v * pxPerKpc >= minBarPx) || 100;
  const barPx = barKpc * pxPerKpc;
  const label = barKpc < 1 ? `${Math.round(barKpc * 1000)} pc` : `${barKpc} kpc`;

  // Compute physical frame major and minor ticks along [-fovW/2, +fovW/2] and [-fovH/2, +fovH/2]
  const tickStep = [0.05, 0.1, 0.2, 0.5, 1, 2, 5, 10, 20, 25, 50, 100, 200].find(s => fovW / s <= 6.5) || 100;
  const minorStep = tickStep / (tickStep === 2 || tickStep === 0.2 || tickStep === 20 || tickStep === 200 ? 4 : 5);
  const usePc = tickStep < 1;
  const unitLabel = usePc ? "pc" : "kpc";
  const xTicks = [], yTicks = [], xMinor = [], yMinor = [];
  const halfW = fovW / 2, halfH = fovH / 2;

  for (let v = Math.ceil(-halfW / tickStep - 1e-9) * tickStep; v <= halfW + 1e-6; v += tickStep) {
    const val = Math.abs(v) < 1e-6 ? 0 : v;
    const frac = (val + halfW) / fovW;
    if (frac >= 0.03 && frac <= 0.97) {
      const num = usePc ? Math.round(Math.abs(val) * 1000) : +Math.abs(val).toFixed(1);
      const sign = val < -1e-6 ? "-" : "";
      xTicks.push({kpc: val, frac, label: `${sign}${num}`, mathLabel: val < -1e-6 ? `$-$${num}` : `${num}`});
    }
  }
  for (let v = Math.ceil(-halfW / minorStep - 1e-9) * minorStep; v <= halfW + 1e-6; v += minorStep) {
    const frac = (v + halfW) / fovW;
    if (frac >= 0.01 && frac <= 0.99) xMinor.push({frac});
  }
  for (let v = Math.ceil(-halfH / tickStep - 1e-9) * tickStep; v <= halfH + 1e-6; v += tickStep) {
    const val = Math.abs(v) < 1e-6 ? 0 : v;
    const frac = (halfH - val) / fovH; // top = +halfH, bottom = -halfH
    if (frac >= 0.03 && frac <= 0.97) {
      const num = usePc ? Math.round(Math.abs(val) * 1000) : +Math.abs(val).toFixed(1);
      const sign = val < -1e-6 ? "-" : "";
      yTicks.push({kpc: val, frac, label: `${sign}${num}`, mathLabel: val < -1e-6 ? `$-$${num}` : `${num}`});
    }
  }
  for (let v = Math.ceil(-halfH / minorStep - 1e-9) * minorStep; v <= halfH + 1e-6; v += minorStep) {
    const frac = (halfH - v) / fovH;
    if (frac >= 0.01 && frac <= 0.99) yMinor.push({frac});
  }
  return {d, fovW, fovH, pxPerKpc, barKpc, barPx, label, tickStep, minorStep, unitLabel, xTicks, yTicks, xMinor, yMinor};
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
  out.sort((a, b) => (a.selected ? 1 : 0) - (b.selected ? 1 : 0));
  return out;
}

/* ---- Exact 8-frame Sub-Pixel Accumulated High-DPI Renderer ---- */
export async function renderHighDPI(viewer, opts = {}) {
  const scale = Number(opts.scale) || 2;
  const maxDim = scale >= 4 ? 2400 : scale >= 2 ? 1600 : 1024;
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
      const pxBlack = render8Pass([0, 0, 0]);
      const pxWhite = render8Pass([1, 1, 1]);
      outPixels = new Uint8Array(W * H * 4);
      for (let i = 0; i < pxBlack.length; i += 4) {
        const rb = pxBlack[i] / 255, gb = pxBlack[i + 1] / 255, bb = pxBlack[i + 2] / 255;
        const rw = pxWhite[i] / 255, gw = pxWhite[i + 1] / 255, bw = pxWhite[i + 2] / 255;
        const trans = Math.max(0, Math.min(1, ((rw - rb) + (gw - gb) + (bw - bb)) / 3));
        const alpha = Math.max(0, Math.min(1, 1 - trans));
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

/* ---- Publication Figure Layout Geometry (72 pt/inch base, scaled to target DPI) ----
   Follows pubplot.py (ApJ / MNRAS single/onehalf/double-column figure standards):
   - Total width: 511.2 pt (7.10 in at 72 pt/in; 2840 px at 400 dpi)
   - Square 3D plot panel: 360 x 360 pt (5.00 in) at left margin fx = 54 pt
   - Full-height vertical colorbar on the right: cbX = 428 pt, cbW = 14 pt, cbH = 360 pt
   - Boxed axes with 4-sided inward major (4.5 pt) and minor (2.2 pt) ticks on both the 3D panel and vertical colorbar
   - Physical scale bar inside bottom-right of the 3D panel, R200c dashed circle, sightline legend inside top-left,
     galaxy & simulation stamp inside top-right (or above the panel), and optional wrapped Computer Modern caption below.
*/
export function getPubLayout(viewer, opts = {}) {
  const PW = 511.2; // 7.10 inches * 72 pt/in (exact double-column width in pubplot.py)
  const fx = 54, fw = 356, fh = 356;
  const topPad = opts.stamp !== false ? 26 : 14;
  const xAxisSpace = 38;
  const capText = opts.caption === false ? "" : buildFigureVisualCaption(viewer);
  const capLines = capText ? wrapCMText(capText, 8.2, PW - fx - 20) : [];
  const capSpace = capLines.length ? (capLines.length * 11.5 + 14) : 0;
  const PH = +(topPad + fh + xAxisSpace + capSpace).toFixed(1);
  // In top-down coordinates (Canvas / SVG): frame top is fyTop = topPad
  const fyTop = topPad;
  // In bottom-up coordinates (PDF): frame bottom is fyPdf = xAxisSpace + capSpace
  const fyPdf = +(xAxisSpace + capSpace).toFixed(1);
  const cbX = fx + fw + 12, cbW = 13;
  return {PW, PH, fx, fw, fh, fyTop, fyPdf, cbX, cbW, capLines, xAxisSpace, capSpace};
}

/* ---- 1. exportPNG: 400 DPI Publication PNG Figure (or clean stage-only PNG when opts.rawStage) ---- */
export async function exportPNG(viewer, opts = {}) {
  const volRender = await renderHighDPI(viewer, opts);
  const dpi = Number(opts.dpi) || 400;
  const scaleFactor = dpi / 72; // 400 / 72 = 5.5556 px per pt
  const L = getPubLayout(viewer, opts);
  const W = Math.round(L.PW * scaleFactor);
  const H = Math.round(L.PH * scaleFactor);

  const figCanvas = document.createElement("canvas");
  figCanvas.width = W;
  figCanvas.height = H;
  const ctx = figCanvas.getContext("2d");

  const darkTheme = opts.background === "dark";
  const transparent = opts.background === "transparent";
  const pageBg = darkTheme ? BG_HEX : "#ffffff";
  const ink = darkTheme ? "#e9eef4" : "#111111";
  const muted = darkTheme ? "#b3bdc9" : "#333333";
  const spineCol = darkTheme ? "#b3bdc9" : "#111111";

  if (!transparent) {
    ctx.fillStyle = pageBg;
    ctx.fillRect(0, 0, W, H);
  }

  const s = scaleFactor;
  const fx = L.fx * s, fy = L.fyTop * s, fw = L.fw * s, fh = L.fh * s;

  // Draw the 3D stage image inside the plot box
  ctx.save();
  ctx.fillStyle = BG_HEX;
  ctx.fillRect(fx, fy, fw, fh);
  try { ctx.drawImage(volRender.canvas, fx, fy, fw, fh); } catch { /* headless fallback */ }
  ctx.restore();

  const m = sceneMeta(viewer);
  const leg = getLegendInfo(viewer);
  const sc = getScaleInfo(viewer, L.fw, L.fh);

  // R200c dashed circle inside the 3D panel when guides enabled or within view
  const r200Px = sc.pxPerKpc * m.R200c * s;
  if (opts.guides !== false && r200Px > 14 * s && r200Px < fw * 0.68) {
    ctx.save();
    ctx.beginPath();
    ctx.rect(fx, fy, fw, fh);
    ctx.clip();
    ctx.strokeStyle = "#d9c38c";
    ctx.lineWidth = 0.9 * s;
    ctx.setLineDash([4 * s, 3 * s]);
    ctx.beginPath();
    ctx.arc(fx + fw / 2, fy + fh / 2, r200Px, 0, 2 * Math.PI);
    ctx.stroke();
    ctx.setLineDash([]);
    drawCMCanvas(ctx, `$R_{200\\mathrm{c}} = ${Math.round(m.R200c)}$ kpc`, fx + fw / 2 + r200Px * 0.707 + 4 * s, fy + fh / 2 - r200Px * 0.707 - 3 * s, 7.8 * s, {color: "#d9c38c"});
    ctx.restore();
  }

  // Physical scale bar inside bottom-right of the 3D panel (clean publication rule + CM label, no UI card)
  if (opts.scaleBar !== false) {
    const bw = sc.barPx * s;
    const bx = fx + fw - 14 * s - bw, by = fy + fh - 14 * s;
    ctx.save();
    ctx.strokeStyle = "rgba(5, 7, 11, 0.75)";
    ctx.lineWidth = 3.0 * s;
    ctx.beginPath();
    ctx.moveTo(bx, by - 3.5 * s); ctx.lineTo(bx, by); ctx.lineTo(bx + bw, by); ctx.lineTo(bx + bw, by - 3.5 * s);
    ctx.stroke();
    ctx.strokeStyle = "#ffffff";
    ctx.lineWidth = 1.3 * s;
    ctx.beginPath();
    ctx.moveTo(bx, by - 3.5 * s); ctx.lineTo(bx, by); ctx.lineTo(bx + bw, by); ctx.lineTo(bx + bw, by - 3.5 * s);
    ctx.stroke();
    drawCMCanvas(ctx, sc.label, bx + bw / 2, by - 5.5 * s, 8.2 * s, {align: "center", color: "#ffffff"});
    ctx.restore();
  }

  // Sightlines legend inside top-left of the 3D panel (frameless publication legend)
  if (opts.sightlines !== false && m.snap.linesMode !== "none") {
    const items = [
      ["#e9eef4", "selected ray", 2.0],
      ["#8d97a6", "library", 1.1],
      ["#7db2f0", "generated", 1.1],
      ["#f39a5c", "custom", 1.1]
    ];
    const lx = fx + 10 * s, ly = fy + 13 * s, rowH = 11.5 * s;
    ctx.save();
    items.forEach(([col, label, lw], idx) => {
      const ry = ly + idx * rowH;
      ctx.strokeStyle = col;
      ctx.lineWidth = lw * s;
      ctx.beginPath();
      ctx.moveTo(lx, ry - 2.8 * s);
      ctx.lineTo(lx + 14 * s, ry - 2.8 * s);
      ctx.stroke();
      drawCMCanvas(ctx, label, lx + 18 * s, ry, 7.6 * s, {color: "#e9eef4"});
    });
    ctx.restore();
  }

  // Stars & dust annotation inside bottom-left of the 3D panel when star layer is active
  if (viewer.stars) {
    const stTxt = m.snap.layers?.dust !== false ? "stars: $g, r, i$ asinh + 3D dust" : "stars: $g, r, i$ asinh";
    drawCMCanvas(ctx, stTxt, fx + 10 * s, fy + fh - 10 * s, 7.6 * s, {color: "#d9c38c"});
  }

  // Boxed 4-sided spines + inward-pointing major & minor ticks on ALL FOUR SIDES (white ticks over dark 3D image per pubplot.py box_ticks)
  ctx.save();
  ctx.strokeStyle = "#ffffff";
  ctx.lineWidth = 0.8 * s;
  for (const t of sc.xTicks) {
    const tx = fx + t.frac * fw;
    ctx.beginPath();
    ctx.moveTo(tx, fy + fh); ctx.lineTo(tx, fy + fh - 4.5 * s);
    ctx.moveTo(tx, fy); ctx.lineTo(tx, fy + 4.5 * s);
    ctx.stroke();
    drawCMCanvas(ctx, t.mathLabel, tx, fy + fh + 11 * s, 8.2 * s, {align: "center", color: ink});
  }
  ctx.lineWidth = 0.6 * s;
  for (const t of sc.xMinor) {
    const tx = fx + t.frac * fw;
    ctx.beginPath();
    ctx.moveTo(tx, fy + fh); ctx.lineTo(tx, fy + fh - 2.2 * s);
    ctx.moveTo(tx, fy); ctx.lineTo(tx, fy + 2.2 * s);
    ctx.stroke();
  }
  ctx.lineWidth = 0.8 * s;
  for (const t of sc.yTicks) {
    const ty = fy + t.frac * fh;
    ctx.beginPath();
    ctx.moveTo(fx, ty); ctx.lineTo(fx + 4.5 * s, ty);
    ctx.moveTo(fx + fw, ty); ctx.lineTo(fx + fw - 4.5 * s, ty);
    ctx.stroke();
    drawCMCanvas(ctx, t.mathLabel, fx - 5 * s, ty + 2.8 * s, 8.2 * s, {align: "right", color: ink});
  }
  ctx.lineWidth = 0.6 * s;
  for (const t of sc.yMinor) {
    const ty = fy + t.frac * fh;
    ctx.beginPath();
    ctx.moveTo(fx, ty); ctx.lineTo(fx + 2.2 * s, ty);
    ctx.moveTo(fx + fw, ty); ctx.lineTo(fx + fw - 2.2 * s, ty);
    ctx.stroke();
  }
  ctx.strokeStyle = spineCol;
  ctx.lineWidth = 0.9 * s;
  ctx.strokeRect(fx, fy, fw, fh);
  ctx.restore();

  // Physical axis labels in Computer Modern with square-bracket units
  drawCMCanvas(ctx, `$\\Delta x\\ [\\mathrm{${sc.unitLabel}}]$`, fx + fw / 2, fy + fh + 25 * s, 9.2 * s, {align: "center", color: ink});
  drawCMCanvas(ctx, `$\\Delta y\\ [\\mathrm{${sc.unitLabel}}]$`, fx - 27 * s, fy + fh / 2, 9.2 * s, {align: "center", color: ink, rotateDeg: -90});

  // Header stamp above the 3D panel
  if (opts.stamp !== false) {
    const headL = `${m.sim}  ${m.noun} ${m.galId}  ($z = ${Number(m.z).toFixed(2)}$, $R_{200\\mathrm{c}} = ${Math.round(m.R200c)}$ kpc)`;
    const headR = `${m.mode} mode`;
    drawCMCanvas(ctx, headL, fx, fy - 7 * s, 9.0 * s, {align: "left", color: ink});
    drawCMCanvas(ctx, headR, fx + fw, fy - 7 * s, 8.4 * s, {align: "right", color: muted});
  }

  // Full-height Vertical Colorbar on the right of the 3D panel
  if (opts.legend !== false) {
    const cbX = L.cbX * s, cbY = fy, cbW = L.cbW * s, cbH = fh;
    const sh = cbH / leg.stops.length;
    ctx.save();
    // Draw stops bottom-to-top so index 0 (lo) is at bottom (cbY + cbH) and index N-1 (hi) is at top (cbY)
    leg.stops.forEach(([r, g, b], i) => {
      const ry = cbY + cbH - (i + 1) * sh;
      ctx.fillStyle = `rgb(${r},${g},${b})`;
      ctx.fillRect(cbX, ry - 0.3 * s, cbW, sh + 0.6 * s);
    });
    // Inward ticks on left and right sides of the vertical colorbar
    ctx.strokeStyle = "#ffffff";
    ctx.lineWidth = 0.75 * s;
    for (const tk of leg.ticks) {
      const ty = cbY + (1 - tk.frac) * cbH;
      ctx.beginPath();
      ctx.moveTo(cbX, ty); ctx.lineTo(cbX + 3.2 * s, ty);
      ctx.moveTo(cbX + cbW, ty); ctx.lineTo(cbX + cbW - 3.2 * s, ty);
      ctx.stroke();
      drawCMCanvas(ctx, tk.mathLabel, cbX + cbW + 5 * s, ty + 2.8 * s, 8.2 * s, {align: "left", color: ink});
    }
    ctx.lineWidth = 0.55 * s;
    for (const tk of leg.minorTicks) {
      const ty = cbY + (1 - tk.frac) * cbH;
      ctx.beginPath();
      ctx.moveTo(cbX, ty); ctx.lineTo(cbX + 1.8 * s, ty);
      ctx.moveTo(cbX + cbW, ty); ctx.lineTo(cbX + cbW - 1.8 * s, ty);
      ctx.stroke();
    }
    ctx.strokeStyle = spineCol;
    ctx.lineWidth = 0.85 * s;
    ctx.strokeRect(cbX, cbY, cbW, cbH);
    // Vertical rotated LaTeX label to the right of colorbar tick numbers
    drawCMCanvas(ctx, leg.titleMath, cbX + cbW + 41 * s, cbY + cbH / 2, 9.2 * s, {align: "center", color: ink, rotateDeg: -90});
    ctx.restore();
  }

  // Publication caption block below the figure
  if (L.capLines.length) {
    let cy = fy + fh + (L.xAxisSpace + 6) * s;
    for (const line of L.capLines) {
      drawCMCanvas(ctx, line, fx, cy, 8.2 * s, {align: "left", color: muted});
      cy += 11.5 * s;
    }
  }

  const filename = opts.filename || buildFilename(viewer, volRender.width, volRender.height, "png");
  const rawBlob = await new Promise(res => figCanvas.toBlob(res, "image/png"));
  let blob = rawBlob;
  if (rawBlob) {
    try {
      const arr = new Uint8Array(await rawBlob.arrayBuffer());
      const withDpi = injectPngDpi(arr, dpi);
      blob = new Blob([withDpi], {type: "image/png"});
    } catch { blob = rawBlob; }
  }
  if (opts.download !== false && blob) triggerDownload(blob, filename);
  return {blob, filename, width: volRender.width, height: volRender.height, figWidth: W, figHeight: H, dpi, dataUrl: figCanvas.toDataURL("image/png"), stageDataUrl: volRender.canvas.toDataURL("image/png")};
}

/* ---- 2. exportSVG: Publication Vector SVG with Computer Modern vector glyphs & vertical colorbar ---- */
export async function exportSVG(viewer, opts = {}) {
  const volRender = await renderHighDPI(viewer, {...opts, sceneLines: false});
  const pngDataUrl = volRender.canvas.toDataURL("image/png");
  const m = sceneMeta(viewer);
  const leg = getLegendInfo(viewer);
  const L = getPubLayout(viewer, opts);
  const sc = getScaleInfo(viewer, L.fw, L.fh);
  const lines = opts.sightlines === false ? [] : projectVisibleSightlines(viewer, L.fw, L.fh);
  const latex = buildLatexCaption(viewer);

  const darkTheme = opts.background === "dark";
  const transparent = opts.background === "transparent";
  const pageBg = darkTheme ? BG_HEX : "#ffffff";
  const ink = darkTheme ? "#e9eef4" : "#111111";
  const muted = darkTheme ? "#b3bdc9" : "#333333";
  const spineCol = darkTheme ? "#b3bdc9" : "#111111";

  const fx = L.fx, fy = L.fyTop, fw = L.fw, fh = L.fh;
  const r200Px = sc.pxPerKpc * m.R200c;

  // Vertical gradient stops: y1="100%" (bottom = lo) to y2="0%" (top = hi)
  const gradStops = leg.stops.map(([r, g, b], i) => {
    const pct = ((i / Math.max(1, leg.stops.length - 1)) * 100).toFixed(2);
    return `<stop offset="${pct}%" stop-color="rgb(${r},${g},${b})"/>`;
  }).join("");

  const xTickSvg = sc.xTicks.map(t => {
    const x = +(fx + t.frac * fw).toFixed(2);
    return `<line x1="${x}" y1="${fy + fh}" x2="${x}" y2="${fy + fh - 4.5}" stroke="#ffffff" stroke-width="0.8"/>` +
      `<line x1="${x}" y1="${fy}" x2="${x}" y2="${fy + 4.5}" stroke="#ffffff" stroke-width="0.8"/>` +
      drawCMSvg(t.mathLabel, x, fy + fh + 11, 8.2, {align: "center", color: ink});
  }).join("");

  const xMinorSvg = sc.xMinor.map(t => {
    const x = +(fx + t.frac * fw).toFixed(2);
    return `<line x1="${x}" y1="${fy + fh}" x2="${x}" y2="${fy + fh - 2.2}" stroke="#ffffff" stroke-width="0.6"/>` +
      `<line x1="${x}" y1="${fy}" x2="${x}" y2="${fy + 2.2}" stroke="#ffffff" stroke-width="0.6"/>`;
  }).join("");

  const yTickSvg = sc.yTicks.map(t => {
    const y = +(fy + t.frac * fh).toFixed(2);
    return `<line x1="${fx}" y1="${y}" x2="${fx + 4.5}" y2="${y}" stroke="#ffffff" stroke-width="0.8"/>` +
      `<line x1="${fx + fw}" y1="${y}" x2="${fx + fw - 4.5}" y2="${y}" stroke="#ffffff" stroke-width="0.8"/>` +
      drawCMSvg(t.mathLabel, fx - 5, y + 2.8, 8.2, {align: "right", color: ink});
  }).join("");

  const yMinorSvg = sc.yMinor.map(t => {
    const y = +(fy + t.frac * fh).toFixed(2);
    return `<line x1="${fx}" y1="${y}" x2="${fx + 2.2}" y2="${y}" stroke="#ffffff" stroke-width="0.6"/>` +
      `<line x1="${fx + fw}" y1="${y}" x2="${fx + fw - 2.2}" y2="${y}" stroke="#ffffff" stroke-width="0.6"/>`;
  }).join("");

  const linesSvg = lines.map(l => {
    const x1 = +(fx + l.x1).toFixed(2), y1 = +(fy + l.y1).toFixed(2);
    const x2 = +(fx + l.x2).toFixed(2), y2 = +(fy + l.y2).toFixed(2);
    const sw = l.selected ? 2.0 : 1.05;
    const op = l.selected ? 0.92 : l.kind === "custom" ? 0.65 : l.kind === "generated" ? 0.45 : 0.25;
    return `<g data-sightline="${escXml(l.id)}">` +
      `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="${l.color}" stroke-width="${sw}" stroke-opacity="${op}" stroke-linecap="round"/>` +
      (l.selected ? `<circle cx="${x1}" cy="${y1}" r="2.2" fill="${l.color}"/><circle cx="${x2}" cy="${y2}" r="3.0" fill="${l.color}"/>` : "") +
      `</g>`;
  }).join("");

  const guideSvg = (opts.guides !== false && r200Px > 14 && r200Px < fw * 0.68)
    ? `<circle cx="${fx + fw / 2}" cy="${fy + fh / 2}" r="${r200Px.toFixed(2)}" fill="none" stroke="#d9c38c" stroke-width="0.9" stroke-dasharray="4 3" stroke-opacity="0.85"/>` +
      drawCMSvg(`$R_{200\\mathrm{c}} = ${Math.round(m.R200c)}$ kpc`, fx + fw / 2 + r200Px * 0.707 + 4, fy + fh / 2 - r200Px * 0.707 - 3, 7.8, {color: "#d9c38c"})
    : "";

  const scaleBarW = +sc.barPx.toFixed(2);
  const sbX = +(fx + fw - 14 - scaleBarW).toFixed(2), sbY = fy + fh - 14;
  const scaleSvg = opts.scaleBar !== false
    ? `<g id="scale-bar">` +
      `<path d="M${sbX} ${sbY - 3.5} V${sbY} H${(sbX + scaleBarW).toFixed(2)} V${sbY - 3.5}" fill="none" stroke="#05070b" stroke-opacity="0.75" stroke-width="3.0"/>` +
      `<path d="M${sbX} ${sbY - 3.5} V${sbY} H${(sbX + scaleBarW).toFixed(2)} V${sbY - 3.5}" fill="none" stroke="#ffffff" stroke-width="1.3"/>` +
      drawCMSvg(sc.label, sbX + scaleBarW / 2, sbY - 5.5, 8.2, {align: "center", color: "#ffffff"}) +
      `</g>`
    : "";

  const stampSvg = opts.stamp !== false
    ? drawCMSvg(`${m.sim}  ${m.noun} ${m.galId}  ($z = ${Number(m.z).toFixed(2)}$, $R_{200\\mathrm{c}} = ${Math.round(m.R200c)}$ kpc)`, fx, fy - 7, 9.0, {align: "left", color: ink}) +
      drawCMSvg(`${m.mode} mode`, fx + fw, fy - 7, 8.4, {align: "right", color: muted})
    : "";

  const cbX = L.cbX, cbY = fy, cbW = L.cbW, cbH = fh;
  const cbTicks = leg.ticks.map(t => {
    const ty = +(cbY + (1 - t.frac) * cbH).toFixed(2);
    return `<line x1="${cbX}" y1="${ty}" x2="${cbX + 3.2}" y2="${ty}" stroke="#ffffff" stroke-width="0.75"/>` +
      `<line x1="${cbX + cbW}" y1="${ty}" x2="${cbX + cbW - 3.2}" y2="${ty}" stroke="#ffffff" stroke-width="0.75"/>` +
      drawCMSvg(t.mathLabel, cbX + cbW + 5, ty + 2.8, 8.2, {align: "left", color: ink});
  }).join("");

  const cbMinors = leg.minorTicks.map(t => {
    const ty = +(cbY + (1 - t.frac) * cbH).toFixed(2);
    return `<line x1="${cbX}" y1="${ty}" x2="${cbX + 1.8}" y2="${ty}" stroke="#ffffff" stroke-width="0.55"/>` +
      `<line x1="${cbX + cbW}" y1="${ty}" x2="${cbX + cbW - 1.8}" y2="${ty}" stroke="#ffffff" stroke-width="0.55"/>`;
  }).join("");

  const legendSvg = opts.legend !== false
    ? `<g id="colorbar">` +
      `<rect x="${cbX}" y="${cbY}" width="${cbW}" height="${cbH}" fill="url(#cmap-grad)" stroke="${spineCol}" stroke-width="0.85"/>` +
      cbTicks + cbMinors +
      drawCMSvg(leg.titleMath, cbX + cbW + 41, cbY + cbH / 2, 9.2, {align: "center", color: ink, rotateDeg: -90}) +
      `</g>`
    : "";

  const capSvg = L.capLines.map((line, idx) =>
    drawCMSvg(line, fx, fy + fh + L.xAxisSpace + 6 + idx * 11.5, 8.2, {align: "left", color: muted})
  ).join("");

  const metaJson = JSON.stringify({
    generator: "CGM 3D Explorer exportSVG (pubplot house style)",
    timestamp: new Date().toISOString(),
    deepLink: buildDeepLink(viewer),
    latexCaption: latex,
    scene: m.snap
  }, null, 2);

  const svg = `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${L.PW} ${L.PH}" width="${L.PW}" height="${L.PH}">
  <metadata>
    <scene-json>${escXml(metaJson)}</scene-json>
    <latex-caption>${escXml(latex)}</latex-caption>
  </metadata>
  <defs>
    <linearGradient id="cmap-grad" x1="0%" y1="100%" x2="0%" y2="0%">${gradStops}</linearGradient>
    <clipPath id="stage-clip"><rect x="${fx}" y="${fy}" width="${fw}" height="${fh}"/></clipPath>
  </defs>
  ${transparent ? "" : `<rect x="0" y="0" width="${L.PW}" height="${L.PH}" fill="${pageBg}"/>`}
  ${stampSvg}
  <g clip-path="url(#stage-clip)">
    <rect x="${fx}" y="${fy}" width="${fw}" height="${fh}" fill="${BG_HEX}"/>
    <image href="${pngDataUrl}" x="${fx}" y="${fy}" width="${fw}" height="${fh}" preserveAspectRatio="xMidYMid slice"/>
    ${guideSvg}
    ${linesSvg}
    ${scaleSvg}
  </g>
  <rect x="${fx}" y="${fy}" width="${fw}" height="${fh}" fill="none" stroke="${spineCol}" stroke-width="0.9"/>
  ${xTickSvg}
  ${xMinorSvg}
  ${yTickSvg}
  ${yMinorSvg}
  ${drawCMSvg(`$\\Delta x\\ [\\mathrm{${sc.unitLabel}}]$`, fx + fw / 2, fy + fh + 25, 9.2, {align: "center", color: ink})}
  ${drawCMSvg(`$\\Delta y\\ [\\mathrm{${sc.unitLabel}}]$`, fx - 27, fy + fh / 2, 9.2, {align: "center", color: ink, rotateDeg: -90})}
  ${legendSvg}
  ${capSvg}
</svg>`;

  const filename = opts.filename || buildFilename(viewer, volRender.width, volRender.height, "svg");
  const blob = new Blob([svg], {type: "image/svg+xml;charset=utf-8"});
  if (opts.download !== false) triggerDownload(blob, filename);
  return {blob, filename, svg, latex};
}

/* ---- 3. exportPDF: Zero-dependency single-page PDF 1.4 generator with Computer Modern vector glyphs ---- */
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
  const L = getPubLayout(viewer, opts);
  const sc = getScaleInfo(viewer, L.fw, L.fh);

  const PW = L.PW, PH = L.PH;
  const fx = L.fx, fy = L.fyPdf, fw = L.fw, fh = L.fh;
  const cmds = [];

  const darkTheme = opts.background === "dark";
  const transparent = opts.background === "transparent";
  const inkRgb = darkTheme ? [0.914, 0.933, 0.957] : [0.067, 0.067, 0.067];
  const mutedRgb = darkTheme ? [0.702, 0.741, 0.788] : [0.200, 0.200, 0.200];
  const spineRgb = darkTheme ? [0.702, 0.741, 0.788] : [0.067, 0.067, 0.067];

  if (!transparent) {
    if (darkTheme) cmds.push("0.020 0.027 0.043 rg", `0 0 ${PW} ${PH} re f`);
    else cmds.push("1 1 1 rg", `0 0 ${PW} ${PH} re f`);
  }

  // Draw embedded high-DPI 3D stage XObject
  cmds.push("q", `${fw} 0 0 ${fh} ${fx} ${fy} cm`, "/Im0 Do", "Q");

  // Dashed R200c circle inside the 3D frame when guides enabled or within view
  const r200Pt = sc.pxPerKpc * m.R200c;
  if (opts.guides !== false && r200Pt > 14 && r200Pt < fw * 0.68) {
    const cx = fx + fw / 2, cy = fy + fh / 2, r = r200Pt, k = 0.55228475 * r;
    cmds.push(
      "q", `${fx} ${fy} ${fw} ${fh} re W n`,
      "0.851 0.765 0.549 RG", "0.9 w", "[4 3] 0 d",
      `${(cx + r).toFixed(2)} ${cy.toFixed(2)} m`,
      `${(cx + r).toFixed(2)} ${(cy + k).toFixed(2)} ${(cx + k).toFixed(2)} ${(cy + r).toFixed(2)} ${cx.toFixed(2)} ${(cy + r).toFixed(2)} c`,
      `${(cx - k).toFixed(2)} ${(cy + r).toFixed(2)} ${(cx - r).toFixed(2)} ${(cy + k).toFixed(2)} ${(cx - r).toFixed(2)} ${cy.toFixed(2)} c`,
      `${(cx - r).toFixed(2)} ${(cy - k).toFixed(2)} ${(cx - k).toFixed(2)} ${(cy - r).toFixed(2)} ${cx.toFixed(2)} ${(cy - r).toFixed(2)} c`,
      `${(cx + k).toFixed(2)} ${(cy - r).toFixed(2)} ${(cx + r).toFixed(2)} ${(cy - k).toFixed(2)} ${(cx + r).toFixed(2)} ${cy.toFixed(2)} c S`,
      "[] 0 d"
    );
    drawCMPdf(cmds, `$R_{200\\mathrm{c}} = ${Math.round(m.R200c)}$ kpc`, cx + r * 0.707 + 4, cy + r * 0.707 + 3, 7.8, {rgb: [0.851, 0.765, 0.549]});
    cmds.push("Q");
  }

  // Vector physical scale bar inside bottom-right of the 3D frame
  if (opts.scaleBar !== false) {
    const bw = +sc.barPx.toFixed(2);
    const bx = +(fx + fw - 14 - bw).toFixed(2), by = fy + 14;
    cmds.push(
      "0.020 0.027 0.043 RG", "2.8 w",
      `${bx} ${by + 3.5} m ${bx} ${by} l ${(bx + bw).toFixed(2)} ${by} l ${(bx + bw).toFixed(2)} ${by + 3.5} l S`,
      "1 1 1 RG", "1.3 w",
      `${bx} ${by + 3.5} m ${bx} ${by} l ${(bx + bw).toFixed(2)} ${by} l ${(bx + bw).toFixed(2)} ${by + 3.5} l S`
    );
    drawCMPdf(cmds, sc.label, bx + bw / 2, by + 5.5, 8.2, {align: "center", rgb: [1, 1, 1]});
  }

  // Sightlines legend inside top-left of the 3D frame
  if (opts.sightlines !== false && m.snap.linesMode !== "none") {
    const items = [
      [[0.914, 0.933, 0.957], "selected ray", 2.0],
      [[0.553, 0.592, 0.651], "library", 1.1],
      [[0.490, 0.698, 0.941], "generated", 1.1],
      [[0.953, 0.604, 0.361], "custom", 1.1]
    ];
    const lx = fx + 10, ly = fy + fh - 13, rowH = 11.5;
    items.forEach(([col, label, lw], idx) => {
      const ry = ly - idx * rowH;
      cmds.push(`${col[0]} ${col[1]} ${col[2]} RG`, `${lw} w`, `${lx} ${(ry + 2.8).toFixed(2)} m ${lx + 14} ${(ry + 2.8).toFixed(2)} l S`);
      drawCMPdf(cmds, label, lx + 18, ry, 7.6, {rgb: [0.914, 0.933, 0.957]});
    });
  }

  // Stars & dust note inside bottom-left of the 3D frame when stars are active
  if (viewer.stars) {
    const stTxt = m.snap.layers?.dust !== false ? "stars: $g, r, i$ asinh + 3D dust" : "stars: $g, r, i$ asinh";
    drawCMPdf(cmds, stTxt, fx + 10, fy + 10, 7.6, {rgb: [0.851, 0.765, 0.549]});
  }

  // 4-sided inward major and minor ticks on the 3D panel (white over dark 3D image per pubplot.py box_ticks)
  cmds.push("1 1 1 RG", "0.8 w");
  for (const t of sc.xTicks) {
    const x = +(fx + t.frac * fw).toFixed(2);
    cmds.push(`${x} ${fy} m ${x} ${(fy + 4.5).toFixed(2)} l S`, `${x} ${fy + fh} m ${x} ${(fy + fh - 4.5).toFixed(2)} l S`);
    drawCMPdf(cmds, t.mathLabel, x, fy - 11, 8.2, {align: "center", rgb: inkRgb});
  }
  cmds.push("1 1 1 RG", "0.6 w");
  for (const t of sc.xMinor) {
    const x = +(fx + t.frac * fw).toFixed(2);
    cmds.push(`${x} ${fy} m ${x} ${(fy + 2.2).toFixed(2)} l S`, `${x} ${fy + fh} m ${x} ${(fy + fh - 2.2).toFixed(2)} l S`);
  }
  cmds.push("1 1 1 RG", "0.8 w");
  for (const t of sc.yTicks) {
    const y = +(fy + (1 - t.frac) * fh).toFixed(2);
    cmds.push(`${fx} ${y} m ${(fx + 4.5).toFixed(2)} ${y} l S`, `${fx + fw} ${y} m ${(fx + fw - 4.5).toFixed(2)} ${y} l S`);
    drawCMPdf(cmds, t.mathLabel, fx - 5, y - 2.8, 8.2, {align: "right", rgb: inkRgb});
  }
  cmds.push("1 1 1 RG", "0.6 w");
  for (const t of sc.yMinor) {
    const y = +(fy + (1 - t.frac) * fh).toFixed(2);
    cmds.push(`${fx} ${y} m ${(fx + 2.2).toFixed(2)} ${y} l S`, `${fx + fw} ${y} m ${(fx + fw - 2.2).toFixed(2)} ${y} l S`);
  }

  // Boxed 4-sided frame border
  cmds.push(`${spineRgb[0]} ${spineRgb[1]} ${spineRgb[2]} RG`, "0.9 w", `${fx} ${fy} ${fw} ${fh} re S`);

  // Physical axis labels in Computer Modern
  drawCMPdf(cmds, `$\\Delta x\\ [\\mathrm{${sc.unitLabel}}]$`, fx + fw / 2, fy - 25, 9.2, {align: "center", rgb: inkRgb});
  drawCMPdf(cmds, `$\\Delta y\\ [\\mathrm{${sc.unitLabel}}]$`, fx - 27, fy + fh / 2, 9.2, {align: "center", rgb: inkRgb, rotateDeg: 90});

  // Header stamp above the 3D panel
  if (opts.stamp !== false) {
    const headL = `${m.sim}  ${m.noun} ${m.galId}  ($z = ${Number(m.z).toFixed(2)}$, $R_{200\\mathrm{c}} = ${Math.round(m.R200c)}$ kpc)`;
    const headR = `${m.mode} mode`;
    drawCMPdf(cmds, headL, fx, fy + fh + 7, 9.0, {align: "left", rgb: inkRgb});
    drawCMPdf(cmds, headR, fx + fw, fy + fh + 7, 8.4, {align: "right", rgb: mutedRgb});
  }

  // Full-height Vertical Colorbar on the right of the 3D panel
  if (opts.legend !== false) {
    const cbX = L.cbX, cbY = fy, cbW = L.cbW, cbH = fh;
    const sh = cbH / leg.stops.length;
    leg.stops.forEach(([r, g, b], i) => {
      const ry = +(cbY + i * sh).toFixed(2);
      cmds.push(`${(r / 255).toFixed(3)} ${(g / 255).toFixed(3)} ${(b / 255).toFixed(3)} rg`, `${cbX} ${ry} ${cbW} ${(sh + 0.35).toFixed(2)} re f`);
    });
    // Inward ticks on both left and right spines of the vertical colorbar
    cmds.push("1 1 1 RG", "0.75 w");
    for (const tk of leg.ticks) {
      const ty = +(cbY + tk.frac * cbH).toFixed(2);
      cmds.push(
        `${cbX} ${ty} m ${(cbX + 3.2).toFixed(2)} ${ty} l S`,
        `${cbX + cbW} ${ty} m ${(cbX + cbW - 3.2).toFixed(2)} ${ty} l S`
      );
      drawCMPdf(cmds, tk.mathLabel, cbX + cbW + 5, ty - 2.8, 8.2, {align: "left", rgb: inkRgb});
    }
    cmds.push("1 1 1 RG", "0.55 w");
    for (const tk of leg.minorTicks) {
      const ty = +(cbY + tk.frac * cbH).toFixed(2);
      cmds.push(
        `${cbX} ${ty} m ${(cbX + 1.8).toFixed(2)} ${ty} l S`,
        `${cbX + cbW} ${ty} m ${(cbX + cbW - 1.8).toFixed(2)} ${ty} l S`
      );
    }
    cmds.push(`${spineRgb[0]} ${spineRgb[1]} ${spineRgb[2]} RG`, "0.85 w", `${cbX} ${cbY} ${cbW} ${cbH} re S`);
    // Rotated vertical colorbar title with LaTeX math & square-bracket units
    drawCMPdf(cmds, leg.titleMath, cbX + cbW + 41, cbY + cbH / 2, 9.2, {align: "center", rgb: inkRgb, rotateDeg: 90});
  }

  // Publication caption block below the x-axis label
  if (L.capLines.length) {
    let cy = fy - L.xAxisSpace - 6;
    for (const line of L.capLines) {
      drawCMPdf(cmds, line, fx, cy, 8.2, {align: "left", rgb: mutedRgb});
      cy -= 11.5;
    }
  }

  const contentBytes = new TextEncoder().encode(cmds.join("\n") + "\n");
  const compressedContent = await deflateBytes(contentBytes);

  // Assemble PDF 1.4 binary (pure vector paths + rasterized 3D XObject)
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
  startObj(3); pushStr(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${PW} ${PH}] /Resources << /XObject << /Im0 4 0 R >> >> /Contents 5 0 R >>`); endObj();
  startObj(4);
  pushStr(`<< /Type /XObject /Subtype /Image /Width ${W} /Height ${H} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /FlateDecode /Length ${compressedImg.length} >>\nstream\n`);
  pushBin(compressedImg);
  pushStr("\nendstream");
  endObj();
  startObj(5);
  pushStr(`<< /Filter /FlateDecode /Length ${compressedContent.length} >>\nstream\n`);
  pushBin(compressedContent);
  pushStr("\nendstream");
  endObj();

  const xrefOff = byteLen;
  pushStr("xref\n0 6\n0000000000 65535 f \n");
  for (let i = 1; i <= 5; i++) {
    pushStr(String(offsets[i]).padStart(10, "0") + " 00000 n \n");
  }
  pushStr(`trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xrefOff}\n%%EOF\n`);

  const pdfBytes = new Uint8Array(byteLen);
  let p = 0;
  for (const chunk of parts) { pdfBytes.set(chunk, p); p += chunk.length; }

  const filename = opts.filename || buildFilename(viewer, W, H, "pdf");
  const blob = new Blob([pdfBytes], {type: "application/pdf"});
  if (opts.download !== false) triggerDownload(blob, filename);
  return {blob, filename, bytes: pdfBytes, width: W, height: H, pageWidthPt: PW, pageHeightPt: PH};
}

/* ---- 4. Client-Side Publication Spectra Figure Export (PDF & 400 dpi PNG when server is offline or non-default galaxy) ---- */
export async function exportSpectraPublication(spectraCanvas, meta = {}, fmt = "pdf") {
  const PW = 511.2; // 7.10 in * 72 pt/in
  const cw = spectraCanvas.width || 800, ch = spectraCanvas.height || 600;
  const fx = 42, fw = 452, fh = +(fw * (ch / Math.max(1, cw))).toFixed(1);
  const topPad = 24, botPad = 36;
  const capText = meta.caption || `Figure: ${meta.sim || "TNG50-1"} ${meta.noun || "subhalo"} ${meta.galId || ""} (${meta.sightlineId || "sightline"}). Absorption spectra across [${meta.vLo ?? -400}, ${meta.vHi ?? 400}] km s$^{-1}$ relative to $V_{\\mathrm{sys}}$.`;
  const capLines = wrapCMText(capText, 8.2, fw);
  const capSpace = capLines.length * 11.5 + 10;
  const PH = +(topPad + fh + botPad + capSpace).toFixed(1);

  if (fmt === "png") {
    const dpi = 400, s = dpi / 72;
    const W = Math.round(PW * s), H = Math.round(PH * s);
    const cv = document.createElement("canvas");
    cv.width = W; cv.height = H;
    const ctx = cv.getContext("2d");
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, W, H);
    drawCMCanvas(ctx, `${meta.sim || "TNG50-1"}  ${meta.noun || "Subhalo"} ${meta.galId || ""}  Sightline ${meta.sightlineId || ""}`, fx * s, (topPad - 7) * s, 9.0 * s, {color: "#111111"});
    ctx.drawImage(spectraCanvas, fx * s, topPad * s, fw * s, fh * s);
    ctx.strokeStyle = "#111111";
    ctx.lineWidth = 0.9 * s;
    ctx.strokeRect(fx * s, topPad * s, fw * s, fh * s);
    drawCMCanvas(ctx, "$V_{\\mathrm{LOS}} - V_{\\mathrm{sys}}\\ [\\mathrm{km\\,s^{-1}}]$", (fx + fw / 2) * s, (topPad + fh + 22) * s, 9.2 * s, {align: "center", color: "#111111"});
    drawCMCanvas(ctx, "Normalized flux", (fx - 26) * s, (topPad + fh / 2) * s, 9.2 * s, {align: "center", color: "#111111", rotateDeg: -90});
    let cy = (topPad + fh + botPad + 2) * s;
    for (const line of capLines) {
      drawCMCanvas(ctx, line, fx * s, cy, 8.2 * s, {color: "#333333"});
      cy += 11.5 * s;
    }
    const rawBlob = await new Promise(res => cv.toBlob(res, "image/png"));
    const arr = new Uint8Array(await rawBlob.arrayBuffer());
    return new Blob([injectPngDpi(arr, 400)], {type: "image/png"});
  }

  // Vector PDF 1.4 with Computer Modern axes & caption
  const ctx = spectraCanvas.getContext("2d");
  const rgba = ctx.getImageData(0, 0, cw, ch).data;
  const rgb = new Uint8Array(cw * ch * 3);
  for (let i = 0, j = 0; i < rgba.length; i += 4, j += 3) {
    const a = rgba[i + 3] / 255;
    rgb[j] = Math.round(rgba[i] * a + 255 * (1 - a));
    rgb[j + 1] = Math.round(rgba[i + 1] * a + 255 * (1 - a));
    rgb[j + 2] = Math.round(rgba[i + 2] * a + 255 * (1 - a));
  }
  const compressedImg = await deflateBytes(rgb);
  const fy = +(botPad + capSpace).toFixed(1);
  const cmds = ["1 1 1 rg", `0 0 ${PW} ${PH} re f`];
  cmds.push("q", `${fw} 0 0 ${fh} ${fx} ${fy} cm`, "/Im0 Do", "Q");
  cmds.push("0.067 0.067 0.067 RG", "0.9 w", `${fx} ${fy} ${fw} ${fh} re S`);
  drawCMPdf(cmds, `${meta.sim || "TNG50-1"}  ${meta.noun || "Subhalo"} ${meta.galId || ""}  Sightline ${meta.sightlineId || ""}`, fx, fy + fh + 7, 9.0, {rgb: [0.07, 0.07, 0.07]});
  drawCMPdf(cmds, "$V_{\\mathrm{LOS}} - V_{\\mathrm{sys}}\\ [\\mathrm{km\\,s^{-1}}]$", fx + fw / 2, fy - 22, 9.2, {align: "center", rgb: [0.07, 0.07, 0.07]});
  drawCMPdf(cmds, "Normalized flux", fx - 26, fy + fh / 2, 9.2, {align: "center", rgb: [0.07, 0.07, 0.07], rotateDeg: 90});
  let cy = fy - botPad - 2;
  for (const line of capLines) {
    drawCMPdf(cmds, line, fx, cy, 8.2, {rgb: [0.2, 0.2, 0.2]});
    cy -= 11.5;
  }
  const contentBytes = new TextEncoder().encode(cmds.join("\n") + "\n");
  const compressedContent = await deflateBytes(contentBytes);

  const parts = [], offsets = [];
  let byteLen = 0;
  const enc = new TextEncoder();
  const pushStr = s => { const b = enc.encode(s); parts.push(b); byteLen += b.length; };
  const pushBin = b => { parts.push(b); byteLen += b.length; };
  const startObj = id => { offsets[id] = byteLen; pushStr(`${id} 0 obj\n`); };
  const endObj = () => pushStr("\nendobj\n");

  pushStr("%PDF-1.4\n%\xFF\xFF\xFF\xFF\n");
  startObj(1); pushStr("<< /Type /Catalog /Pages 2 0 R >>"); endObj();
  startObj(2); pushStr("<< /Type /Pages /Kids [3 0 R] /Count 1 >>"); endObj();
  startObj(3); pushStr(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${PW} ${PH}] /Resources << /XObject << /Im0 4 0 R >> >> /Contents 5 0 R >>`); endObj();
  startObj(4);
  pushStr(`<< /Type /XObject /Subtype /Image /Width ${cw} /Height ${ch} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /FlateDecode /Length ${compressedImg.length} >>\nstream\n`);
  pushBin(compressedImg);
  pushStr("\nendstream");
  endObj();
  startObj(5);
  pushStr(`<< /Filter /FlateDecode /Length ${compressedContent.length} >>\nstream\n`);
  pushBin(compressedContent);
  pushStr("\nendstream");
  endObj();

  const xrefOff = byteLen;
  pushStr("xref\n0 6\n0000000000 65535 f \n");
  for (let i = 1; i <= 5; i++) pushStr(String(offsets[i]).padStart(10, "0") + " 00000 n \n");
  pushStr(`trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xrefOff}\n%%EOF\n`);

  const pdfBytes = new Uint8Array(byteLen);
  let p = 0;
  for (const chunk of parts) { pdfBytes.set(chunk, p); p += chunk.length; }
  return new Blob([pdfBytes], {type: "application/pdf"});
}

/* ---- 5. exportHTML & exportJSON (Programmatic API & Self-Contained Interactive Figure Card) ---- */
export function exportJSON(viewer, opts = {}) {
  const m = sceneMeta(viewer);
  const payload = {
    version: 2,
    timestamp: new Date().toISOString(),
    deepLink: buildDeepLink(viewer),
    latexCaption: buildLatexCaption(viewer),
    latexFigure: buildLatexFigureBlock(viewer),
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
  const L = getPubLayout(viewer, opts);
  const lines = projectVisibleSightlines(viewer, L.fw, L.fh);
  const deepLink = buildDeepLink(viewer);
  const latex = buildLatexFigureBlock(viewer);
  const sceneJson = JSON.stringify(m.snap, null, 2);

  // Map sightlines into the publication figure's 3D panel coordinates (fx..fx+fw, fyTop..fyTop+fh)
  const svgLines = lines.map(l => {
    const ions = Object.entries(l.logN || {})
      .filter(([, v]) => Number.isFinite(+v) && +v > 10)
      .slice(0, 6)
      .map(([k, v]) => `${k}: ${(+v).toFixed(2)}`)
      .join(", ");
    return `<line class="sl" x1="${(L.fx + l.x1).toFixed(2)}" y1="${(L.fyTop + l.y1).toFixed(2)}" x2="${(L.fx + l.x2).toFixed(2)}" y2="${(L.fyTop + l.y2).toFixed(2)}" ` +
      `stroke="${l.color}" stroke-width="${l.selected ? 3.5 : 2}" stroke-opacity="${l.selected ? 0.95 : 0.01}" ` +
      `data-id="${escHtml(l.id)}" data-b="${escHtml(l.b_kpc ?? "n/a")}" data-orient="${escHtml(l.orientation)}" data-ions="${escHtml(ions || "none")}"/>`;
  }).join("\n        ");

  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escHtml(m.sim)} ${escHtml(m.noun)} ${escHtml(m.galId)} - Publication Figure & Sightline Inspector (${escHtml(m.species)}, ${escHtml(m.mode)})</title>
<style>
  :root { color-scheme: dark; --bg: #07090f; --card: rgba(20,25,40,0.88); --edge: rgba(190,205,255,0.16); --ink: #eef0f7; --muted: #a0a8c0; --accent: #8fa8ff; }
  * { box-sizing: border-box; }
  body { margin: 0; padding: 24px; background: radial-gradient(900px 600px at 15% -10%, rgba(96,72,222,0.28), transparent 60%), var(--bg); color: var(--ink); font: 13.5px/1.5 system-ui, -apple-system, sans-serif; display: grid; justify-content: center; }
  .wrap { max-width: 1080px; width: 100%; display: grid; grid-template-columns: minmax(340px, 720px) minmax(260px, 320px); gap: 18px; align-items: start; }
  @media (max-width: 900px) { .wrap { grid-template-columns: 1fr; } }
  .stage { position: relative; width: 100%; border-radius: 14px; overflow: hidden; border: 1px solid var(--edge); background: #ffffff; box-shadow: 0 18px 48px rgba(0,0,0,0.55); }
  .stage img { display: block; width: 100%; height: auto; }
  .stage svg { position: absolute; inset: 0; width: 100%; height: 100%; }
  .stage .sl { cursor: pointer; transition: stroke-width 0.12s, stroke-opacity 0.12s; }
  .stage .sl:hover { stroke-width: 5px; stroke-opacity: 1 !important; }
  .card { background: var(--card); border: 1px solid var(--edge); border-radius: 14px; padding: 14px; display: flex; flex-direction: column; gap: 10px; }
  h1 { margin: 0; font-size: 15px; font-weight: 600; }
  h2 { margin: 0; font-size: 11px; text-transform: uppercase; letter-spacing: 0.1em; color: var(--muted); font-family: ui-monospace, monospace; }
  .kv { font-family: ui-monospace, monospace; font-size: 12px; color: var(--muted); display: grid; gap: 4px; }
  .kv b { color: var(--ink); font-weight: 500; }
  textarea { width: 100%; min-height: 112px; background: rgba(0,0,0,0.32); color: var(--ink); border: 1px solid var(--edge); border-radius: 8px; padding: 8px; font: 11.5px/1.4 ui-monospace, monospace; resize: vertical; }
  .btn { display: inline-flex; align-items: center; justify-content: center; height: 32px; padding: 0 12px; border-radius: 9px; border: 1px solid var(--accent); background: var(--accent); color: #0a0d18; font-weight: 600; text-decoration: none; cursor: pointer; font-size: 12.5px; }
  .btn.sec { background: rgba(143,168,255,0.12); color: var(--ink); }
</style>
</head>
<body>
  <div class="wrap">
    <div class="stage">
      <img src="${pngRes.dataUrl}" alt="Publication 3D CGM figure">
      <svg viewBox="0 0 ${L.PW} ${L.PH}" aria-label="Interactive sightline overlay">
        ${svgLines}
      </svg>
    </div>
    <div class="card">
      <h1>${escHtml(m.sim)} ${escHtml(m.noun)} ${escHtml(m.galId)} (z = ${escHtml(m.z)})</h1>
      <div class="kv">
        <span>Field: <b>${escHtml(m.species)}</b> (${escHtml(m.mode)})</span>
        <span>R200c: <b>${Math.round(m.R200c)} kpc</b></span>
      </div>
      <h2>Interactive Sightline Inspector</h2>
      <div class="kv" id="sl-info">Hover or tap a sightline on the figure to inspect its ID, impact parameter b, and ion column densities.</div>
      <h2>LaTeX Figure Block</h2>
      <textarea id="latex-cap" readonly>${escHtml(latex)}</textarea>
      <button type="button" class="btn sec" id="copy-cap">Copy LaTeX figure</button>
      <a class="btn" href="${escHtml(deepLink)}" target="_blank" rel="noopener">Open Live 3D View in Explorer</a>
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
