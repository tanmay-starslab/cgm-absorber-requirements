// Near field: the gas cells inside the travelling capsule, drawn as additive emission splats (DESIGN_final §3.1 D4, §3.4;
// C_eng P0-4, P1-4). The tube asset holds every gas cell within R kpc of the story ray, sorted by l (U_data, story-data/2
// `tube`). The capsule (l0..l1 about the probe, radius r, soft edge fraction e) is carved out of the volume (raymarch.js
// FRAG_STORY capF) and the splats carry the complementary weight capsuleF(centre), so volume + splats = 1 everywhere.
// Splats are emission only (no absorption; the fog around them does that), coloured by the same TF texture as the volume,
// in the same units: per pixel gain · kappa · alpha_TF · W · rgb · chord, chord = 2 r sqrt(1 − q²) through a sphere of r_eq.
// Splats with a projected radius above 0.25 vh are clamped and faded; cells closer than the near fade are hidden, except
// "passing beads" within `bead` kpc of the camera, drawn as small crisp points (motion cue, C_ux P0-4).
//
// decodeTube(buf, header) -> {n, pos: Float32Array(3n), lognH, logT, logZ, req, ion, cloud, vlos, l}
//   header: {n, stride: 16, lo[3], hi[3], ranges: {lognH, logT, logZ, r_eq, vlos}} (records: u16 x,y,z | u8 lognH logT logZ
//   r_eq ion cloud vlos pad×3; then n f32 l). capsuleF(p, cap, rayO, rayN): the JS mirror of the GLSL capF.
// decodeStoryTube(buf, header, ray) -> the same object from U_data's story-tube/1 (14 B records in the ray frame, see below),
//   plus nHI, nOVI (log10 cm^-3) and the cloud byte (low nibble H I cloud index + 1, high nibble O VI cloud index + 1).
// makeTube(T, tube, opts) -> {mesh, update(ctx), window(l0, l1) -> [i0, i1], count}
//   phase 1: ion presets colour the splats from the tube's own n_HI / n_OVI (same TF and window as the ion cubes); the active
//   cloud's cells brighten (ctx.focus {hi, ovi: cloud index + 1, k}); the far-field focus dim (ctx.focusSphere, the volume's
//   focW); speed streaks (ctx.streak 0..1) stretch splats and passing beads along the projected ray (radial from the
//   vanishing point in a chase shot; a motion cue, not physics; the stage sets 0 under reduced motion).
export const CAPSULE_GLSL = `
uniform vec3 uRayO, uRayN; uniform vec4 uCap;
float capF(vec3 p) {
  if (uCap.z <= 0.0 || uCap.y <= uCap.x) return 0.0;
  vec3 q = p - uRayO; float l = dot(q, uRayN), rho = length(q - l * uRayN), e = max(uCap.w, 1e-3);
  float hl = 0.5 * (uCap.y - uCap.x), lc = 0.5 * (uCap.x + uCap.y);
  return (1.0 - smoothstep(uCap.z * (1.0 - e), uCap.z, rho)) * (1.0 - smoothstep(hl * (1.0 - e), hl, abs(l - lc))); }`;
const ss = (a, b, x) => { const t = Math.max(0, Math.min(1, (x - a) / (b - a))); return t * t * (3 - 2 * t); };
/* cap = {l0, l1, r, edge}; rayO = the ray point at l = 0; rayN unit */
export function capsuleF(p, cap, rayO, rayN) {
  if (!(cap.r > 0) || !(cap.l1 > cap.l0)) return 0;
  const q = [p[0] - rayO[0], p[1] - rayO[1], p[2] - rayO[2]], l = q[0] * rayN[0] + q[1] * rayN[1] + q[2] * rayN[2];
  const rho = Math.hypot(q[0] - l * rayN[0], q[1] - l * rayN[1], q[2] - l * rayN[2]), e = Math.max(cap.edge ?? 0.3, 1e-3);
  const hl = 0.5 * (cap.l1 - cap.l0), lc = 0.5 * (cap.l0 + cap.l1);
  return (1 - ss(cap.r * (1 - e), cap.r, rho)) * (1 - ss(hl * (1 - e), hl, Math.abs(l - lc)));
}
export function decodeTube(buf, h) {
  const n = h.n, st = h.stride || 16, u8 = new Uint8Array(buf, 0, n * st), dv = new DataView(buf), R = h.ranges;
  const pos = new Float32Array(3 * n), f = k => new Float32Array(n), lognH = f(), logT = f(), logZ = f(), req = f(), vlos = f(), ion = new Uint8Array(n), cloud = new Uint8Array(n);
  const dq = (q, r) => (q === 0 ? NaN : r[0] + (q - 1) * (r[1] - r[0]) / 254);
  for (let i = 0; i < n; i++) {
    const o = i * st;
    for (let a = 0; a < 3; a++) pos[3 * i + a] = h.lo[a] + dv.getUint16(o + 2 * a, true) / 65535 * (h.hi[a] - h.lo[a]);
    lognH[i] = dq(u8[o + 6], R.lognH); logT[i] = dq(u8[o + 7], R.logT); logZ[i] = dq(u8[o + 8], R.logZ); req[i] = dq(u8[o + 9], R.r_eq);
    ion[i] = u8[o + 10]; cloud[i] = u8[o + 11]; vlos[i] = dq(u8[o + 12], R.vlos);
  }
  const l = new Float32Array(buf.slice(n * st, n * st + 4 * n));
  return {n, pos, lognH, logT, logZ, req, ion, cloud, vlos, l};
}
/* U_data story-tube/1 (data/tube/<gid>_<ray>.json + .bin.gz): records of 14 B, little endian:
   u16 x3 ray-frame (l, up, side) = lo + q/65535 span | u8 log n_H (x/255*8 - 7) | u8 log T (x/255*5 + 3) | u8 log Z (x/255*4 - 3)
   | u8 log r_eq (x/255*3.5 - 2) | u8 log n_HI (x/255*16 - 16) | u8 log n_OVI (x/255*16 - 16) | u8 cloud ids | i8 v_los / 4 km/s.
   Disk-frame position = p0 + (l + half) n + up·e_up + side·e_side (header.frame or ray.frame). Sorted by l. */
export const STORY_TUBE_STRIDE = 14;
export function decodeStoryTube(buf, hdr, ray = {}) {
  const n = hdr.n, st = STORY_TUBE_STRIDE, lo = hdr.lo, sp = hdr.span, Fr = hdr.frame || ray.frame, p0 = Fr.p0 || ray.p0, half = Fr.half ?? ray.half;
  if (!Fr || !p0 || !(half > 0)) throw new Error("decodeStoryTube: needs the ray frame (n, up, side, p0, half)");
  if (buf.byteLength < n * st) throw new Error(`decodeStoryTube: ${buf.byteLength} B < ${n} x ${st} B`);
  const dv = new DataView(buf), f = () => new Float32Array(n), pos = new Float32Array(3 * n);
  const lognH = f(), logT = f(), logZ = f(), req = f(), vlos = f(), l = f(), nHI = f(), nOVI = f(), cloud = new Uint8Array(n), ion = new Uint8Array(n);
  for (let i = 0; i < n; i++) { const o = i * st;
    const L = lo[0] + dv.getUint16(o, true) / 65535 * sp[0], U = lo[1] + dv.getUint16(o + 2, true) / 65535 * sp[1], S = lo[2] + dv.getUint16(o + 4, true) / 65535 * sp[2];
    for (let a = 0; a < 3; a++) pos[3 * i + a] = p0[a] + (L + half) * Fr.n[a] + U * Fr.up[a] + S * Fr.side[a];
    l[i] = L; lognH[i] = dv.getUint8(o + 6) / 255 * 8 - 7; logT[i] = dv.getUint8(o + 7) / 255 * 5 + 3; logZ[i] = dv.getUint8(o + 8) / 255 * 4 - 3;
    req[i] = 10 ** (dv.getUint8(o + 9) / 255 * 3.5 - 2); nHI[i] = dv.getUint8(o + 10) / 255 * 16 - 16; nOVI[i] = dv.getUint8(o + 11) / 255 * 16 - 16;
    cloud[i] = dv.getUint8(o + 12); vlos[i] = dv.getInt8(o + 13) * 4; }
  return {n, pos, lognH, logT, logZ, req, ion, cloud, vlos, l, nHI, nOVI, hasIon: true, schema: "story-tube/1"};
}
/* first index with l >= x in a sorted Float32Array */
export function lowerBound(a, x) { let lo = 0, hi = a.length; while (lo < hi) { const m = (lo + hi) >> 1; if (a[m] < x) lo = m + 1; else hi = m; } return lo; }

const VS = `${CAPSULE_GLSL}
in vec3 iPos; in vec4 iP; in float iV; in vec3 iI;
uniform sampler2D uTF; uniform vec2 uTFWin; uniform int uField, uTFW, uVel; uniform float uGamma, uWRef, uKappa, uGain, uVh, uFocal, uBead, uRScale, uMaxFrac;
uniform vec2 uNearPt, uFog; uniform vec3 uCamPos; uniform sampler2D uLut; uniform vec2 uVWin, uWWin; uniform float uAlpha;
uniform vec3 uFocusC; uniform vec4 uFocusS; uniform float uFocusDim, uStreak; uniform vec3 uRayV;
out vec3 vCol; out vec2 vQ; out float vBead; out float vTau;
const float LOG2_10 = 3.321928094887362;
void main() {
  vCol = vec3(0.0); vQ = position.xy; vBead = 0.0; vTau = 0.0; gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
  float f = capF(iPos); if (f <= 1e-3) return;
  vec4 cv = viewMatrix * vec4(iPos, 1.0); float dist = -cv.z; if (dist <= 0.05) return;
  float fog = uFog.y > uFog.x ? 1.0 - smoothstep(uFog.x, uFog.y, length(iPos - uCamPos)) : 1.0;
  float val = uField == 0 ? iP.x : uField == 1 ? iP.y : uField == 2 ? iP.z : uField == 3 ? iI.x : iI.y;
  /* focus: the far-field dim of the volume (focW, same sphere) and the active cloud's own cells brightened (uFocusC: H I, O VI index + 1, k) */
  if (uFocusS.w > 0.0) fog *= mix(uFocusDim, 1.0, 1.0 - smoothstep(uFocusS.w, 2.0 * uFocusS.w, length(iPos - uFocusS.xyz)));
  float cb = iI.z, chi = mod(cb, 16.0), cov = floor(cb / 16.0);
  if (uFocusC.z > 0.0 && ((uFocusC.x > 0.0 && abs(chi - uFocusC.x) < 0.5) || (uFocusC.y > 0.0 && abs(cov - uFocusC.y) < 0.5))) fog *= 1.0 + 1.5 * uFocusC.z;
  vec3 c; float al;
  if (uVel == 1) { float xw = clamp((iP.x - uWWin.x) / max(uWWin.y - uWWin.x, 1e-6), 0.0, 1.0); al = xw * xw;
    c = texture(uLut, vec2((clamp((iV - uVWin.x) / max(uVWin.y - uVWin.x, 1e-6), 0.0, 1.0) * 255.0 + 0.5) / 256.0, 0.5)).rgb; }
  else { float x = (val - uTFWin.x) / max(uTFWin.y - uTFWin.x, 1e-6); if (x < 0.0) return;
    vec4 tf = texture(uTF, vec2((clamp(x, 0.0, 1.0) * 255.0 + 0.5) / 256.0, 0.5 / 64.0)); c = tf.rgb; al = tf.a; }
  float W = (uTFW == 1 && uVel == 0) ? exp2(uGamma * LOG2_10 * (iP.x - uWRef)) : 1.0;
  float r = iP.w * uRScale, rpx = r * uFocal / dist, cap = uMaxFrac * uVh, k = rpx > cap ? cap / rpx : 1.0;
  float near = smoothstep(uNearPt.x, uNearPt.y, dist);
  /* emission per pixel: gain × (1 − exp(−κ α chord)) × W × rgb, the volume's C = Σ (1 − exp(−κ α h)) W rgb for one cell;
     chord = 2 r × prof(q) (fragment shader); f = the capsule weight, so splats + carved volume = the uncarved volume */
  vec3 e = uGain * W * c * f * fog * uAlpha; vTau = uKappa * al * 2.0 * r;
  /* streak axis: the ray direction projected at this point (radial from the vanishing point in a chase shot) */
  vec3 rv = (viewMatrix * vec4(uRayV, 0.0)).xyz; vec2 ax = rv.xy * dist + cv.xy * rv.z;   /* d/dt of cv.xy / dist along the ray */
  ax = dot(ax, ax) > 1e-8 ? normalize(ax) : vec2(0.0, 1.0); vec2 px = vec2(-ax.y, ax.x);
  if (dist < uBead) {                                   /* passing bead: a crisp point, a motion cue */
    vBead = 1.0 - smoothstep(0.5 * uBead, uBead, dist); float bp = 3.0 / uFocal * dist;
    vCol = min(c * 0.9 + 0.1, vec3(1.0)) * vBead * 0.8 * fog / (1.0 + 4.0 * uStreak);
    vec2 off = position.x * px * bp + position.y * ax * bp * (1.0 + 10.0 * uStreak);
    gl_Position = projectionMatrix * vec4(cv.xy + off, cv.z, 1.0); return; }
  if (near <= 0.0) return;
  vCol = e * near;                                      /* a clamped splat keeps its per-pixel light: its total fades by k² */
  float sk = 1.0 + 2.0 * uStreak; vCol /= sk;            /* a streaked splat keeps its total light */
  vec2 off = (position.x * px + position.y * ax * sk) * r * k;
  gl_Position = projectionMatrix * vec4(cv.xy + off, cv.z, 1.0);
}`;
const FS = `in vec3 vCol; in vec2 vQ; in float vBead; in float vTau; out vec4 o;
void main() { float q2 = dot(vQ, vQ); if (q2 >= 1.0) discard;
  if (vBead > 0.0) { o = vec4(vCol * (1.0 - smoothstep(0.35, 1.0, sqrt(q2))), 0.0); return; }
  float prof = (1.0 - q2) * (1.0 - q2);                 /* soft kernel-like chord profile, 1 at the centre */
  o = vec4(vCol * (1.0 - exp(-vTau * prof)), 0.0); }`;

export function makeTube(T, tube, {rScale = 1.0, maxFrac = 0.25, bead = 3.0, maxCount = Infinity} = {}) {
  const g = new T.InstancedBufferGeometry();
  g.setAttribute("position", new T.BufferAttribute(new Float32Array([-1, -1, 0, 1, -1, 0, 1, 1, 0, -1, 1, 0]), 3));
  g.setIndex([0, 1, 2, 0, 2, 3]);
  const P = new Float32Array(4 * tube.n); for (let i = 0; i < tube.n; i++) { P[4 * i] = tube.lognH[i]; P[4 * i + 1] = tube.logT[i]; P[4 * i + 2] = tube.logZ[i]; P[4 * i + 3] = tube.req[i]; }
  g.setAttribute("iPos", new T.InstancedBufferAttribute(tube.pos, 3)); g.setAttribute("iP", new T.InstancedBufferAttribute(P, 4));
  g.setAttribute("iV", new T.InstancedBufferAttribute(tube.vlos, 1));
  const I = new Float32Array(3 * tube.n); for (let i = 0; i < tube.n; i++) { I[3 * i] = tube.nHI ? tube.nHI[i] : -16; I[3 * i + 1] = tube.nOVI ? tube.nOVI[i] : -16; I[3 * i + 2] = tube.cloud ? tube.cloud[i] : 0; }
  g.setAttribute("iI", new T.InstancedBufferAttribute(I, 3));
  g.instanceCount = 0;
  const V2 = (a, b) => new T.Vector2(a, b), V3 = () => new T.Vector3();
  const uniforms = {uRayO: {value: V3()}, uRayN: {value: new T.Vector3(0, 0, 1)}, uCap: {value: new T.Vector4()}, uTF: {value: null}, uTFWin: {value: V2(0, 1)},
    uField: {value: 0}, uTFW: {value: 0}, uVel: {value: 0}, uGamma: {value: 0}, uWRef: {value: 0}, uKappa: {value: 1}, uGain: {value: 1}, uVh: {value: 900}, uFocal: {value: 1000},
    uBead: {value: bead}, uRScale: {value: rScale}, uMaxFrac: {value: maxFrac}, uNearPt: {value: V2(0.6, 2.0)}, uFog: {value: V2(0, 0)}, uCamPos: {value: V3()},
    uLut: {value: null}, uVWin: {value: V2(-200, 200)}, uWWin: {value: V2(-3.8, 0.4)}, uAlpha: {value: 1},
    uFocusC: {value: V3()}, uFocusS: {value: new T.Vector4(0, 0, 0, 0)}, uFocusDim: {value: 1}, uStreak: {value: 0}, uRayV: {value: new T.Vector3(0, 0, 1)}};
  const mat = new T.ShaderMaterial({glslVersion: T.GLSL3, vertexShader: VS, fragmentShader: FS, uniforms, transparent: true, depthTest: false, depthWrite: false,
    blending: T.CustomBlending, blendEquation: T.AddEquation, blendSrc: T.OneFactor, blendDst: T.OneFactor, blendSrcAlpha: T.ZeroFactor, blendDstAlpha: T.OneFactor});
  const mesh = new T.Mesh(g, mat); mesh.frustumCulled = false;
  let last = [0, 0];
  const FIELD = {nH: 0, T: 1, Z: 2}, ION = {HI: 3, OVI: 4};
  return {
    mesh, uniforms, count: () => g.instanceCount - last[0],
    window(l0, l1) { return [lowerBound(tube.l, l0 - 10), lowerBound(tube.l, l1 + 10)]; },
    /* ctx: {cap: {l0, l1, r, edge}, rayO, rayN, tf (tfstory blendTF result), tfTex, lutTex, camPos, vh, focal, near: [a, b]} */
    update(ctx) {
      const [i0, i1] = this.window(ctx.cap.l0, ctx.cap.l1), n = Math.min(i1, i0 + maxCount);
      last = [i0, n];
      /* instances before i0 are culled in the vertex shader by capF = 0 (outside the capsule); after n they are not drawn */
      g.instanceCount = n; mesh.visible = n > i0 && ctx.cap.r > 0;
      uniforms.uRayO.value.fromArray(ctx.rayO); uniforms.uRayN.value.fromArray(ctx.rayN);
      uniforms.uCap.value.set(ctx.cap.l0, ctx.cap.l1, ctx.cap.r, ctx.cap.edge ?? 0.3);
      const u = ctx.tf.uniforms;
      uniforms.uTF.value = ctx.tfTex; uniforms.uLut.value = ctx.lutTex; uniforms.uVel.value = ctx.tf.vel ? 1 : 0;
      uniforms.uField.value = FIELD[ctx.tf.colorField] ?? (tube.hasIon ? ION[ctx.tf.colorField] : undefined) ?? 0;
      if (u.uTFWin) uniforms.uTFWin.value.set(...u.uTFWin);
      uniforms.uTFW.value = u.uTFW || 0; uniforms.uGamma.value = u.uGamma || 0; uniforms.uWRef.value = u.uWRef || 0;
      uniforms.uKappa.value = u.uVolK * u.uOpacity * u.uOpacity; uniforms.uGain.value = u.uVolGain;
      if (u.uWin) uniforms.uVWin.value.set(...u.uWin); if (u.uWWin) uniforms.uWWin.value.set(...u.uWWin);
      uniforms.uFog.value.set(...ctx.tf.fog); uniforms.uCamPos.value.fromArray(ctx.camPos);
      uniforms.uVh.value = ctx.vh; uniforms.uFocal.value = ctx.focal; uniforms.uNearPt.value.set(...(ctx.near || [3.0, 8.0]));
      /* ion presets need the tube's per-cell ion share (story-data/2); until it is there the splats stay off for them */
      const ionLess = !ctx.tf.vel && FIELD[ctx.tf.colorField] === undefined && !(tube.hasIon && ION[ctx.tf.colorField] !== undefined);
      const fc = ctx.focus || {}; uniforms.uFocusC.value.set(fc.hi || 0, fc.ovi || 0, fc.k || 0);
      const fsph = ctx.focusSphere; if (fsph && fsph.r > 0) { uniforms.uFocusS.value.set(fsph.c[0], fsph.c[1], fsph.c[2], fsph.r); uniforms.uFocusDim.value = fsph.dim; } else uniforms.uFocusS.value.w = 0;
      uniforms.uStreak.value = Math.max(0, Math.min(1, ctx.streak || 0)); uniforms.uRayV.value.fromArray(ctx.rayN);
      uniforms.uAlpha.value = ionLess ? 0 : (ctx.tf.alphaScale ?? 1);
    },
    dispose() { g.dispose(); mat.dispose(); }};
}
