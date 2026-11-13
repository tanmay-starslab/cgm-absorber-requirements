// Transfer-function model for the 3D viewer's TF volume mode (THOR-style volume rendering, Byrohl & Nelson 2025, §3.5.3).
// Pure module (no DOM, no three.js), shared by the editor (tfeditor.js / viewer3d.js), the shader (raymarch.js reads the
// texture it builds) and the node tests (tests/js/tf_unit.mjs).
//
// Model. A TF state is
//   {ramp: null | {lo, hi, a}, bands: [{c, w, a, rgb, g}], twoD, shade, emis, gamma, win, gmax}
// with every position in the colour field's own log10 units (dex), so a band stays on its value when the window moves:
//   ramp   today's volume look: alpha = a · clamp((v − lo) / (hi − lo))², colour = colormap at that same x
//   band   a Gaussian peak: alpha = a · exp(−½ ((v − c) / w)²), colour rgb ([r, g, b] 0..255) or null = colormap at v;
//          g = [g0, g1] (normalised gradient magnitude 0..1) limits the band to that gradient range when twoD is on
//   twoD   2D TF: rows of the texture differ by gradient magnitude (else all 64 rows are equal)
//   shade  0..1 headlight shading mix (uShade); emis '' or a field key (the uW* emissivity weight) with exponent gamma
//   win    [lo, hi] TF window (uTFWin) in dex; gmax the gradient normaliser (uGradMax) in dex per voxel
// Combination per texel: alpha = min(1, Σ αᵢ); colour = Σ αᵢ cᵢ / Σ αᵢ (the alpha-weighted mean, so overlapping bands mix;
// texels with no alpha keep the colour of the nearest contribution, so linear filtering never bleeds black).
// Texture: RGBA8, TF_W = 256 (value) × TF_H = 64 (gradient), row-major from row 0 (gradient 0). Texel i of a row is the
// value x = i / 255 of the window, row j the normalised gradient magnitude j / 63; the shader samples at
// ((x·255 + 0.5) / 256, (g·63 + 0.5) / 64), i.e. exactly on texel centres at the ends.

export const TF_W = 256, TF_H = 64, MAX_BANDS = 8;
export const PRESETS = ["ramp", "thor", "iso", "clouds"];
export const PRESET_LABELS = {ramp: "Default ramp", thor: "Gas phases (THOR)", iso: "Iso bands", clouds: "Clouds (2D)"};

/* THOR Fig. 11 / §5.5: three Gaussian peaks in log T at 2×10⁴ K (blue), 10⁵ K (orange) and 3×10⁵ K (red), brightness
   ("emissivity") weighted by gas density. The paper gives no widths or alpha heights, so they are our choice.
   Widths: σ = 0.1 dex for the warm and hot peaks; 0.2 dex for the cold peak, still centred at 2×10⁴ K: TNG's
   photo-heated, H I-bearing CGM gas sits near 10⁴ K (H I-weighted median log T 4.04), which a 0.1 dex peak at 2×10⁴ K
   all but missed (weight 0.09 per cell) while it lit the star-forming disk's effective-EOS gas (log T ≈ 4.35).
   Heights 0.8, 0.3, 0.15: the warm and hot, volume-filling phases are nearly transparent, so the cold clouds and the disk
   stay visible through the halo (with 0.9, 0.6, 0.45 the inner halo's hot gas hid the disk).
   Caveat: the T cube is the mass-weighted mean T per voxel, so a voxel mixing cold and hot gas reads as ~1e5 K; part of
   the 1e5 K and 3e5 K phases is this mixing at cloud edges (THOR_NOTE, shown as the preset's tooltip). */
export const THOR_NOTE = "THOR gas phases (Byrohl & Nelson 2025, arXiv:2507.11603): peaks at 2e4 K (blue), 1e5 K (orange) and 3e5 K (red), "
  + "brightness weighted by n_H. Voxel T is a mass-weighted mean, so the 1e5 and 3e5 K phases include mixing at cloud edges.";
export const THOR = {field: "T", emis: "nH", gamma: 1, win: [3.9, 6.3],
  bands: [{c: Math.log10(2e4), w: 0.2, a: 0.8, rgb: [70, 140, 255]},
          {c: 5.0, w: 0.1, a: 0.3, rgb: [255, 160, 40]},
          {c: Math.log10(3e5), w: 0.1, a: 0.15, rgb: [235, 45, 35]}]};

const clamp01 = x => (x < 0 ? 0 : x > 1 ? 1 : x);
const sstep = (a, b, x) => { const t = clamp01((x - a) / (b - a)); return t * t * (3 - 2 * t); };
const G_SOFT = 0.04;        /* soft edge of a band's gradient range (normalised units) */

/* gradient mask of a band at normalised gradient magnitude g (1 when the band has no range) */
export function gradMask(band, g) {
  if (!band.g) return 1;
  const [g0, g1] = band.g, lo = g0 <= 0 ? 1 : sstep(g0 - G_SOFT, g0 + G_SOFT, g), hi = g1 >= 1 ? 1 : 1 - sstep(g1 - G_SOFT, g1 + G_SOFT, g);
  return lo * hi; }

/* colormap colour at x (lut: Uint8Array(256·4) from colormaps.lut, or null = grey ramp) */
function cmapAt(lut, x) { const i = Math.round(clamp01(x) * 255) * 4;
  return lut ? [lut[i], lut[i + 1], lut[i + 2]] : [255 * clamp01(x), 255 * clamp01(x), 255 * clamp01(x)]; }

/* RGBA (alpha and colour 0..1 / 0..255 floats) of the TF at log value v and normalised gradient g */
export function evalTF(state, v, g = 0, lut = null) {
  let sa = 0, r = 0, gg = 0, b = 0, wr = 0, nr = 0, ng = 0, nb = 0;
  const add = (al, wt, c) => { sa += al; r += al * c[0]; gg += al * c[1]; b += al * c[2]; wr += wt; nr += wt * c[0]; ng += wt * c[1]; nb += wt * c[2]; };
  const rp = state.ramp;
  if (rp && rp.a > 0) { const x = clamp01((v - rp.lo) / Math.max(rp.hi - rp.lo, 1e-9)), gm = state.twoD && rp.g ? gradMask(rp, g) : 1;
    add(rp.a * x * x * gm, 1e-9 + x * 1e-6, cmapAt(lut, x)); }
  for (const bd of state.bands || []) {
    /* a band narrower than ~one texel of the window would alias (or vanish) in the 256-texel bake: σ ≥ 0.6 texel */
    const z = (v - bd.c) / Math.max(bd.w, 1e-6, state.win ? 0.6 * (state.win[1] - state.win[0]) / (TF_W - 1) : 0), e = Math.exp(-0.5 * z * z), gm = state.twoD ? gradMask(bd, g) : 1;
    const c = bd.rgb || cmapAt(lut, state.win ? (v - state.win[0]) / Math.max(state.win[1] - state.win[0], 1e-9) : 0.5);
    /* fallback weight for empty texels: the band's Gaussian without its height, floored so the nearest band still wins */
    add(bd.a * e * gm, Math.max(e, 1e-300) * 1e-6 + Math.exp(-Math.min(Math.abs(z), 700)) * 1e-12, c); }
  if (sa > 1e-7) return [r / sa, gg / sa, b / sa, Math.min(1, sa)];
  if (wr > 0) return [nr / wr, ng / wr, nb / wr, 0];
  return [0, 0, 0, 0]; }

/* band list -> TF texture bytes (Uint8Array(TF_W·TF_H·4)). win defaults to state.win. A 1D state (twoD false) has
   identical rows; it is built once and copied. */
export function buildTF(state, lut = null, win = state.win) {
  const out = new Uint8Array(TF_W * TF_H * 4), st = {...state, win}, rows = state.twoD ? TF_H : 1;
  for (let j = 0; j < rows; j++) {
    const g = j / (TF_H - 1);
    for (let i = 0; i < TF_W; i++) {
      const v = win[0] + (i / (TF_W - 1)) * (win[1] - win[0]), c = evalTF(st, v, g, lut), o = (j * TF_W + i) * 4;
      out[o] = Math.round(c[0]); out[o + 1] = Math.round(c[1]); out[o + 2] = Math.round(c[2]); out[o + 3] = Math.round(255 * c[3]); } }
  if (rows === 1) for (let j = 1; j < TF_H; j++) out.copyWithin(j * TF_W * 4, 0, TF_W * 4);
  return out; }

/* presets. ctx = {field, vmin, vmax, volWin: [lo, hi] (manifest vol_window), wRef?}; returns a fresh state.
   ramp   the current volume look (ramp over the field's volume window, colormap colours)
   thor   THOR Fig. 11 (switches the colour field to T and the emissivity weight to n_H, γ = 1)
   iso    three narrow colormap bands at ¼, ½, ¾ of the volume window, shaded (0.6) so the iso-surfaces read in 3D
   clouds the ramp restricted to the upper ¾ of the gradient range, with shading: edges of clouds and filaments */
export function preset(name, ctx) {
  const vw = ctx.volWin || [ctx.vmin, ctx.vmax], win = [ctx.vmin, ctx.vmax], base = {twoD: false, shade: 0, emis: "", gamma: 1, win, gmax: GMAX_DEFAULT, bands: [], ramp: null};
  if (name === "thor") return {...base, preset: "thor", field: THOR.field, win: THOR.win.slice(), emis: THOR.emis, gamma: THOR.gamma, bands: THOR.bands.map(b => ({...b, rgb: b.rgb.slice()}))};
  if (name === "iso") { const s = vw[1] - vw[0];
    return {...base, preset: "iso", shade: 0.6, bands: [0.25, 0.5, 0.75].map((f, i) => ({c: vw[0] + f * s, w: 0.025 * s, a: [0.5, 0.7, 0.9][i], rgb: null}))}; }
  if (name === "clouds") return {...base, preset: "clouds", twoD: true, shade: 0.6, ramp: {lo: vw[0], hi: vw[1], a: 1, g: [0.25, 1]}};
  return {...base, preset: "ramp", ramp: {lo: vw[0], hi: vw[1], a: 1}}; }
export const GMAX_DEFAULT = 0.5;      /* dex per voxel: |∇ log v| at which the gradient axis saturates */

/* ---- URL encoding (compact; '~' between tokens, '_' inside; all URL-safe) ----
   P<name>        a preset left unchanged (just the name; decoded through preset(name, ctx))
   R<lo>_<hi>_<a>[_<g0>_<g1>]   ramp
   B<c>_<w>_<a>_<hex|m>[_<g0>_<g1>]  band (m = colormap colour)
   D 2D on · S<shade> · E<field>_<gamma> · W<lo>_<hi> · G<gmax> */
const num = x => String(+(+x).toFixed(3));
const hex = c => c.map(x => Math.max(0, Math.min(255, Math.round(x))).toString(16).padStart(2, "0")).join("");
export function encodeTF(state, ctx = null) {
  if (ctx && state.preset && sameState(state, preset(state.preset, ctx))) return "P" + state.preset;
  const t = [], gr = o => (o.g ? `_${num(o.g[0])}_${num(o.g[1])}` : "");
  if (state.ramp) t.push(`R${num(state.ramp.lo)}_${num(state.ramp.hi)}_${num(state.ramp.a)}${gr(state.ramp)}`);
  for (const b of state.bands || []) t.push(`B${num(b.c)}_${num(b.w)}_${num(b.a)}_${b.rgb ? hex(b.rgb) : "m"}${gr(b)}`);
  if (state.twoD) t.push("D");
  if (state.shade) t.push("S" + num(state.shade));
  if (state.emis) t.push(`E${state.emis}_${num(state.gamma)}`);
  if (state.win) t.push(`W${num(state.win[0])}_${num(state.win[1])}`);
  if (state.gmax && state.gmax !== GMAX_DEFAULT) t.push("G" + num(state.gmax));
  if (state.field) t.push("F" + state.field);
  return t.join("~"); }
/* -> state, or null if s is not a valid encoding. ctx is needed for P tokens and supplies the default window. */
export function decodeTF(s, ctx = null) {
  if (typeof s !== "string" || !s) return null;
  if (s[0] === "P") { const n = s.slice(1); return PRESETS.includes(n) && ctx ? preset(n, ctx) : null; }
  const st = {twoD: false, shade: 0, emis: "", gamma: 1, win: ctx ? [ctx.vmin, ctx.vmax] : null, gmax: GMAX_DEFAULT, bands: [], ramp: null};
  const F = x => { const v = Number(x); if (x === "" || !Number.isFinite(v)) throw 0; return v; };
  const G = (p, i) => (p.length >= i + 2 ? [clamp01(F(p[i])), clamp01(F(p[i + 1]))] : null);
  try {
    for (const tok of s.split("~")) {
      const k = tok[0], p = tok.slice(1).split("_");
      if (k === "R") { st.ramp = {lo: F(p[0]), hi: F(p[1]), a: clamp01(F(p[2]))}; const g = G(p, 3); if (g) st.ramp.g = g; }
      else if (k === "B") { if (st.bands.length >= MAX_BANDS) continue;
        if (!(p[3] === "m" || /^[0-9a-f]{6}$/i.test(p[3] || ""))) throw 0;
        const b = {c: F(p[0]), w: Math.max(1e-3, Math.abs(F(p[1]))), a: clamp01(F(p[2])), rgb: p[3] === "m" ? null : [0, 2, 4].map(i => parseInt(p[3].slice(i, i + 2), 16))};
        const g = G(p, 4); if (g) b.g = g; st.bands.push(b); }
      else if (k === "D" && tok.length === 1) st.twoD = true;
      else if (k === "S") st.shade = clamp01(F(p[0]));
      else if (k === "E") { if (!/^[A-Za-z][A-Za-z0-9]*$/.test(p[0] || "")) throw 0; st.emis = p[0]; st.gamma = Math.max(0, Math.min(4, F(p[1]))); }
      else if (k === "W") { const lo = F(p[0]), hi = F(p[1]); if (!(hi > lo)) throw 0; st.win = [lo, hi]; }
      else if (k === "G") { const g = F(p[0]); if (!(g > 0)) throw 0; st.gmax = g; }
      else if (k === "F") { if (!/^[A-Za-z][A-Za-z0-9]*$/.test(p[0] || "")) throw 0; st.field = p[0]; }
      else throw 0; }
  } catch { return null; }
  return st; }
function sameState(a, b) { return encodeTF({...a, preset: null}) === encodeTF({...b, preset: null}); }

/* ---- histograms of a loaded u8 log cube (q 0 = empty, q 1..255 -> log v = vmin + (q − 1)(vmax − vmin)/254) ----
   histogram: counts of the non-empty voxels in `bins` bins over win (values outside win are dropped), plus
   logc = log10(1 + count) / max (0..1, for drawing). stride subsamples voxels (1 = all). */
export function histogram(cube, vmin, vmax, win = [vmin, vmax], bins = 128, stride = 1) {
  const qc = new Float64Array(256);
  for (let i = 0; i < cube.length; i += stride) qc[cube[i]]++;
  const counts = new Float64Array(bins), s = (vmax - vmin) / 254, ws = win[1] - win[0];
  for (let q = 1; q < 256; q++) { if (!qc[q]) continue; const v = vmin + (q - 1) * s, x = (v - win[0]) / ws;
    if (x < 0 || x > 1) continue; counts[Math.min(bins - 1, Math.floor(x * bins))] += qc[q]; }
  return {counts, logc: normLog(counts)}; }
function normLog(c) { let m = 0; const o = new Float64Array(c.length);
  for (let i = 0; i < c.length; i++) { o[i] = Math.log10(1 + c[i]); if (o[i] > m) m = o[i]; }
  if (m > 0) for (let i = 0; i < o.length; i++) o[i] /= m; return o; }
/* |∇ log v| by central differences in dex per voxel at voxel (x, y, z) of an n³ cube, or -1 where it or a neighbour
   is empty or at the border (the shader's definition, on the voxel grid) */
export function gradAt(cube, n, vmin, vmax, x, y, z) {
  if (x < 1 || y < 1 || z < 1 || x >= n - 1 || y >= n - 1 || z >= n - 1) return -1;
  const i = (z * n + y) * n + x, nb = [i + 1, i - 1, i + n, i - n, i + n * n, i - n * n];
  if (!cube[i]) return -1; for (const j of nb) if (!cube[j]) return -1;
  const s = (vmax - vmin) / 254 / 2, gx = (cube[nb[0]] - cube[nb[1]]) * s, gy = (cube[nb[2]] - cube[nb[3]]) * s, gz = (cube[nb[4]] - cube[nb[5]]) * s;
  return Math.hypot(gx, gy, gz); }
/* 2D histogram (value × normalised gradient) for the 2D editor: counts[gb][vb] over win × [0, gmax], logc as above;
   p99 = the 99th percentile of |∇ log v| (a suggested gmax). stride subsamples along each axis. */
export function histogram2D(cube, n, vmin, vmax, win = [vmin, vmax], gmax = GMAX_DEFAULT, vbins = 128, gbins = 32, stride = 2) {
  const counts = new Float64Array(vbins * gbins), s = (vmax - vmin) / 254, ws = win[1] - win[0], gh = new Float64Array(1024);
  let ng = 0;
  for (let z = 1; z < n - 1; z += stride) for (let y = 1; y < n - 1; y += stride) for (let x = 1; x < n - 1; x += stride) {
    const g = gradAt(cube, n, vmin, vmax, x, y, z); if (g < 0) continue;
    gh[Math.min(1023, Math.floor(g / 4 * 1024))]++; ng++;          /* percentile table over 0..4 dex/voxel */
    const v = vmin + (cube[(z * n + y) * n + x] - 1) * s, xv = (v - win[0]) / ws; if (xv < 0 || xv > 1) continue;
    const vb = Math.min(vbins - 1, Math.floor(xv * vbins)), gb = Math.min(gbins - 1, Math.floor(Math.min(g / gmax, 1) * gbins));
    counts[gb * vbins + vb]++; }
  let p99 = 0, acc = 0; for (let i = 0; i < 1024; i++) { acc += gh[i]; if (acc >= 0.99 * ng) { p99 = (i + 1) / 1024 * 4; break; } }
  return {counts, logc: normLog(counts), vbins, gbins, p99}; }

/* plain uniform values for the shader (the viewer copies them into raymarch.js's uniforms; see makeMaterial):
   ctx.wRef = log10 of the emissivity reference w_ref (default: defaultWRef, low in the weight field's volume window). */
export function tfUniforms(state, ctx = {}) {
  return {uTFOn: 1, uTFWin: state.win || [ctx.vmin, ctx.vmax], uTF2D: state.twoD ? 1 : 0, uShade: state.shade || 0,
    uGradMax: state.gmax || GMAX_DEFAULT, uTFW: state.emis ? 1 : 0, uGamma: state.emis ? state.gamma : 0, uWRef: ctx.wRef ?? 0}; }
/* default log10 w_ref of an emissivity field: a tenth of the way up its volume window (n_H: −3.92 for [−4.4, 0.4]), so
   the faint, volume-filling CGM (n_H ~ 1e−5 … 1e−3.5) has W ~ 0.1 … 3 and the dense clouds and the disk are brighter
   (the shader's soft knee keeps them from clipping). The middle of the window (n_H: −2.0) left the CGM 100x too dark. */
export const defaultWRef = f => (f && f.vol_window ? f.vol_window[0] + 0.1 * (f.vol_window[1] - f.vol_window[0]) : 0);
