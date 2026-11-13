// The 672 ray cells (the smoothing kernels the spectrum is built from) as impostor spheres (DESIGN §5 row "Ray cells",
// DESIGN_final §3.1 D5, C_science M10). Each cell lights up while the probe crosses its kernel chord: glow follows the
// kernel CDF W_i(s) (0 before, 1 after; the same weight the live spectrum uses), afterglow 25 % once crossed. Colour = the
// cell's THOR phase (2e4 K blue, 1e5 K orange, 3e5 K red; hotter: rose grey), or v_los in the speed beats.
// kernelW(s, cell, table) is the cumulative line integral of the kernel along the chord, interpolated in a table over
// (b/h, t = (s − l)/c); the default table is the M4 cubic spline with support h. U_data's story-data/2 `kernel_cdf` (the
// exact yt/Trident kernel) replaces it when present (setKernelTable). Picking: CPU ray-sphere test against the cores.
export const NB = 33, NT = 129;
export function cubicSpline(q) { return q < 0.5 ? 1 - 6 * q * q + 6 * q * q * q : q < 1 ? 2 * (1 - q) ** 3 : 0; }
/* table[ib * NT + it] = CDF at β = ib/(NB−1), t = −1 + 2 it/(NT−1) (fraction of the chord's column crossed) */
export function kernelTable(kernel = cubicSpline, nb = NB, nt = NT, sub = 64) {
  const tab = new Float32Array(nb * nt);
  for (let ib = 0; ib < nb; ib++) {
    const b = Math.min(ib / (nb - 1), 0.999), c = Math.sqrt(1 - b * b); let acc = 0; const col = new Float64Array(nt);
    for (let it = 1; it < nt; it++) {
      const z0 = c * (-1 + 2 * (it - 1) / (nt - 1)), z1 = c * (-1 + 2 * it / (nt - 1));
      for (let k = 0; k < sub; k++) { const z = z0 + (k + 0.5) / sub * (z1 - z0); acc += kernel(Math.sqrt(b * b + z * z)) * (z1 - z0) / sub; }
      col[it] = acc; }
    for (let it = 0; it < nt; it++) tab[ib * nt + it] = acc > 0 ? col[it] / acc : (it / (nt - 1));
  }
  return tab;
}
/* story-data/2 geometry.kernel_cdf {q: b/h grid, u: t grid on [-1, 1], table[iq][iu]} (the exact yt/Trident kernel, U_data)
   resampled bilinearly onto this module's (NB, NT) grid; rows are renormalised so W(t = 1) = 1 exactly */
export function kernelTableFromCdf(K, nb = NB, nt = NT) {
  const nq = K.q.length, nu = K.u.length, t = K.table, q0 = K.q[0], q1 = K.q[nq - 1], u0 = K.u[0], u1 = K.u[nu - 1];
  const at = (q, u) => { const fq = Math.max(0, Math.min(1, (q - q0) / (q1 - q0))) * (nq - 1), iq = Math.min(Math.floor(fq), nq - 2), aq = fq - iq;
    const fu = Math.max(0, Math.min(1, (u - u0) / (u1 - u0))) * (nu - 1), iu = Math.min(Math.floor(fu), nu - 2), au = fu - iu;
    return (1 - aq) * ((1 - au) * t[iq][iu] + au * t[iq][iu + 1]) + aq * ((1 - au) * t[iq + 1][iu] + au * t[iq + 1][iu + 1]); };
  const tab = new Float32Array(nb * nt);
  for (let ib = 0; ib < nb; ib++) { const b = ib / (nb - 1), lo = at(b, -1), hi = at(b, 1), d = hi - lo;
    for (let it = 0; it < nt; it++) { const u = -1 + 2 * it / (nt - 1); tab[ib * nt + it] = d > 1e-9 ? Math.max(0, Math.min(1, (at(b, u) - lo) / d)) : (it / (nt - 1)); } }
  return tab;
}
let TABLE = null;
export function setKernelTable(t) { TABLE = t; }
/* cell: {l, h, d}; returns W in [0, 1] */
export function kernelW(s, cell, table = TABLE || (TABLE = kernelTable())) {
  const c = Math.sqrt(Math.max(cell.h * cell.h - cell.d * cell.d, 0)); if (c <= 0) return s >= cell.l ? 1 : 0;
  const t = (s - cell.l) / c; if (t <= -1) return 0; if (t >= 1) return 1;
  const fb = Math.min(cell.d / cell.h, 1) * (NB - 1), ft = (t + 1) / 2 * (NT - 1), ib = Math.min(Math.floor(fb), NB - 2), it = Math.min(Math.floor(ft), NT - 2), ab = fb - ib, at = ft - it;
  const v = (i, j) => table[i * NT + j];
  return (1 - ab) * ((1 - at) * v(ib, it) + at * v(ib, it + 1)) + ab * ((1 - at) * v(ib + 1, it) + at * v(ib + 1, it + 1));
}
const lerp3 = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
/* THOR phase colour of log10 T (0..1 floats) */
export function phaseColor(logT) {
  const K = [[4.0, [0.35, 0.6, 1.0]], [4.6, [0.45, 0.7, 1.0]], [5.0, [1.0, 0.63, 0.16]], [5.48, [0.92, 0.18, 0.14]], [6.2, [0.85, 0.55, 0.6]], [7.0, [0.8, 0.75, 0.8]]];
  if (logT <= K[0][0]) return K[0][1]; for (let i = 1; i < K.length; i++) if (logT <= K[i][0]) return lerp3(K[i - 1][1], K[i][1], (logT - K[i - 1][0]) / (K[i][0] - K[i - 1][0]));
  return K[K.length - 1][1];
}
/* a cell's weight for its glow (review F6): its own peak optical depth in the lead ion, on a log scale, floor 0.12 */
export function strength(c, lead = "OVI") {
  const t = lead === "HI" ? c.tauH : c.tauO;
  if (!(t > 0)) return 0.35;
  return Math.max(0.12, Math.min(1, (Math.log10(t) + 3) / 3.5));
}
const VS = `in vec3 iC; in vec4 iP; in vec3 iCol; uniform float uFocal, uVh, uCore, uHalo, uMaxFrac, uDockY; uniform vec2 uNearPt;
out vec3 vCol; out vec2 vQ; out float vGlow, vSel;
void main() {
  vQ = position.xy; vCol = iCol; vGlow = iP.y; vSel = iP.z; gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
  vec4 cv = viewMatrix * vec4(iC, 1.0); float dist = -cv.z; if (dist <= 0.05) return;
  float near = smoothstep(uNearPt.x, uNearPt.y, dist); if (near <= 0.0) return;
  float r = iP.x * uHalo, rpx = r * uFocal / dist, mn = 2.5 / uFocal * dist;
  r = max(r, mn); r = min(r, uMaxFrac * uVh * dist / uFocal);
  /* review2 beauty M1: the selected ring is capped at 22 px radius (it was the brightest object on screen, up to 0.25 vh) and
     fades out when its centre projects into the dock band (uDockY: NDC y of the dock's top edge; -1 = no dock) */
  if (vSel > 0.5) { r = min(max(r * 1.8, 9.0 / uFocal * dist), 22.0 / uFocal * dist); vec4 cc = projectionMatrix * cv; vSel *= smoothstep(uDockY, uDockY + 0.1, cc.y / cc.w); }   /* review F6: the selected cell draws a larger bead with a clear ring */   /* beads, not spheres: the halo is capped at uMaxFrac of the viewport height */
  vGlow *= near;
  gl_Position = projectionMatrix * vec4(cv.xy + position.xy * r, cv.z, 1.0); }`;
const FS = `in vec3 vCol; in vec2 vQ; in float vGlow, vSel; uniform float uCore, uHalo; out vec4 o;
void main() { float q = length(vQ); if (q >= 1.0) discard;
  float rc = uCore / uHalo, core = 1.0 - smoothstep(rc * 0.75, rc, q), rim = smoothstep(rc * 0.55, rc, q) * (1.0 - smoothstep(rc, rc * 1.25, q));
  float halo = exp(-4.0 * q * q) * (1.0 - smoothstep(0.85, 1.0, q));
  vec3 c = vCol * (core * (0.22 + 0.78 * vGlow) + rim * 0.6 * vGlow + halo * 0.12 * vGlow) + vec3(1.0, 0.97, 0.9) * core * 0.5 * max(vGlow - 0.6, 0.0);
  float ring = smoothstep(0.62, 0.72, q) * (1.0 - smoothstep(0.80, 0.90, q));
  c += vec3(0.9, 0.95, 1.0) * (rim * 0.6 + ring * 0.8) * vSel;
  o = vec4(c, 0.0); }`;
/* v_los colour from a 256-entry RGBA LUT (tfstory speed preset, tng_vel) on win [v0, v1] km/s */
export function velColor(v, lutBytes, win = [-150, 150]) { const x = Math.max(0, Math.min(1, (v - win[0]) / (win[1] - win[0]))), i = Math.round(x * 255) * 4;
  return [lutBytes[i] / 255, lutBytes[i + 1] / 255, lutBytes[i + 2] / 255]; }
/* cells: [{centre[3], h, d, l, logT, v?}] in l order; returns {mesh, update({s, sel, focal, vh, speed?: {lut, win}}), pick(o, d) -> idx|-1}
   speed: colour = v_los through the LUT (the speed beats, and the mobile speed preset where the volume has no velocity cube) */
export function makeRayCells(T, cells, {core = 0.12, halo = 0.35} = {}) {
  const n = cells.length, g = new T.InstancedBufferGeometry();
  g.setAttribute("position", new T.BufferAttribute(new Float32Array([-1, -1, 0, 1, -1, 0, 1, 1, 0, -1, 1, 0]), 3)); g.setIndex([0, 1, 2, 0, 2, 3]);
  const C = new Float32Array(3 * n), P = new Float32Array(4 * n), COL = new Float32Array(3 * n);
  cells.forEach((c, i) => { C.set(c.centre, 3 * i); P[4 * i] = c.h; COL.set(phaseColor(c.logT), 3 * i); });
  const aP = new T.InstancedBufferAttribute(P, 4); aP.setUsage(T.DynamicDrawUsage); const aCol = new T.InstancedBufferAttribute(COL, 3);
  g.setAttribute("iC", new T.InstancedBufferAttribute(C, 3)); g.setAttribute("iP", aP); g.setAttribute("iCol", aCol); g.instanceCount = n;
  const uniforms = {uFocal: {value: 1000}, uVh: {value: 900}, uCore: {value: core}, uHalo: {value: halo}, uNearPt: {value: new T.Vector2(0.25, 1.2)}, uMaxFrac: {value: 0.035}, uDockY: {value: -1}};
  const mat = new T.ShaderMaterial({glslVersion: T.GLSL3, vertexShader: VS, fragmentShader: FS, uniforms, transparent: true, depthTest: false, depthWrite: false,
    blending: T.CustomBlending, blendEquation: T.AddEquation, blendSrc: T.OneFactor, blendDst: T.OneFactor, blendSrcAlpha: T.ZeroFactor, blendDstAlpha: T.OneFactor});
  const mesh = new T.Mesh(g, mat); mesh.frustumCulled = false;
  const W = new Float32Array(n); let colKey = "T";
  return {mesh, uniforms, W,
    /* review F6: glow ramps continuously with the kernel weight (no 0 -> 0.55 jump on entry) and scales with the cell's share
       of the lead ion (log tau0: ~1e-3 dim, >= ~3 full); strong cells keep a brighter afterglow so cells with visible
       shadows stay marked. lead: "OVI" | "HI" */
    /* fix3 R2: lit = Set of cell idx brushed or hovered in the dock / an equation term, or pinned by a click: drawn with the
       selected bead's ring at 0.9 strength and at least 0.9 glow, wherever the probe is */
    update({s, sel = -1, focal, vh, speed = null, lead = "OVI", dockY = -1, lit = null}) {
      uniforms.uDockY.value = dockY;
      const key = speed ? `v|${speed.win}` : "T";
      if (key !== colKey) { colKey = key; cells.forEach((c, i) => COL.set(speed && Number.isFinite(c.v) ? velColor(c.v, speed.lut, speed.win) : phaseColor(c.logT), 3 * i)); aCol.needsUpdate = true; }
      for (let i = 0; i < n; i++) {
        const w = kernelW(s, cells[i]); W[i] = w;
        const st = strength(cells[i], lead);
        const glow = w <= 0 ? 0.0 : w < 1 ? st * (1.05 * Math.sin(Math.PI * w) + (0.15 + 0.25 * st) * w) : st * (0.15 + 0.25 * st);
        const id = cells[i].idx ?? i, on = !!(lit && lit.has(id));
        P[4 * i + 1] = on ? Math.max(glow, 0.9) : glow; P[4 * i + 2] = id === sel ? 1 : on ? 0.9 : 0; }
      aP.needsUpdate = true; uniforms.uFocal.value = focal; uniforms.uVh.value = vh;
    },
    /* ray o + t d (disk frame) against the cores (radius core·h): nearest hit index or -1 */
    pick(o, d) { let best = -1, bt = Infinity;
      for (let i = 0; i < n; i++) { const c = cells[i].centre, r = core * cells[i].h, q = [c[0] - o[0], c[1] - o[1], c[2] - o[2]], t = q[0] * d[0] + q[1] * d[1] + q[2] * d[2];
        if (t <= 0) continue; const d2 = q[0] * q[0] + q[1] * q[1] + q[2] * q[2] - t * t; if (d2 <= r * r && t < bt) { bt = t; best = i; } }
      return best; },
    dispose() { g.dispose(); mat.dispose(); }};
}
