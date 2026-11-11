// GLSL3 ray marcher for the Phase-2b 3D viewer (design §5.5) and makeMaterial(THREE, opts).
// One fragment pass on the back faces of the L0 box (mesh local coordinates = disk-frame kpc). Each ray is cut at the
// faces of the ±100 and ±25 kpc boxes into ≤ 5 segments; each segment samples the finest RESIDENT level that
// contains it (gas and stars independently), with a step of that level's voxel / uSpv, so no sample straddles two
// levels. Exact samples decode the 8 neighbouring u8 texels to linear values and mix them trilinearly (texelFetch);
// the fast path decodes the hardware-interpolated q (a log-space blend, used only while moving).
// Integral mode: gas column (or n_H-weighted mean of T, Z) -> LUT; stars: Σ_b = Σ ℓ_b dt -> Lupton asinh composite;
// the two layers combine by a screen blend. Volume mode: front-to-back emission/absorption of the gas over uBg.
// vel3d (uVq > 0): the gas layer is a velocity view derived per sample and per frame from the packed vector cube (uVel*)
// and the camera ray; integral = the weight-weighted mean along the ray (σ_los: the weighted dispersion of dot(v, d)), volume =
// opacity from the weight (uW*) with the colour of the view.
// TF mode (uTFOn = 1, volume mode, scalar fields): THOR-style volume rendering (Byrohl & Nelson 2025, §3.5.3) with the
// 256×64 transfer-function texture uTF (tf.js) over the window uTFWin, optional 2D lookup by the gradient magnitude
// (uTF2D, normalised by uGradMax dex/voxel), headlight shading (uShade) and an emissivity weight from uW* (uTFW, uGamma,
// uWRef). With uTFOn = 0 the shader computes exactly what it did before.
/* tune2: uSub shifts the whole raster by a sub-pixel offset (clip units) so the progressive refine frames average
   several sample positions per pixel (anti-aliasing of sub-pixel structure) */
export const VERT = `out vec3 vPos; uniform vec2 uSub;
void main() { vPos = position; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); gl_Position.xy += uSub * gl_Position.w; }`;

export const FRAG = `precision highp float; precision highp int; precision highp sampler3D;
uniform sampler3D uGas0, uGas1, uGas2, uW0, uW1, uW2, uStar0, uStar1, uStar2;
uniform vec3 uHalf; uniform float uN;
uniform vec3 uGasHave, uWHave, uStarHave;
uniform vec2 uGasRange, uWRange, uStarRange0, uStarRange1, uStarRange2;
uniform float uMask0;
uniform vec3 uCamDisk; uniform int uMode, uKind;
uniform vec2 uWin; uniform sampler2D uLut; uniform float uOpacity, uSpv; uniform int uExact, uFrame;
uniform float uGasMix, uStarMix, uStarQ, uStarS0; uniform vec3 uStarBal, uBg;
uniform float uFadeDex, uStarKnee, uStarOcc;
uniform float uPxAng, uAccW, uStarSat; uniform vec2 uLodC, uNear;
uniform float uVolK, uVolGain, uStarFloor, uGasW; uniform vec2 uOccRange; uniform int uCompMode;
uniform sampler3D uVel0, uVel1, uVel2; uniform vec3 uVelHave; uniform float uVelV; uniform int uVq; uniform vec2 uWWin;
uniform sampler2D uTF; uniform int uTFOn, uTF2D, uTFW; uniform vec2 uTFWin; uniform float uShade, uGradMax, uGamma, uWRef;
in vec3 vPos; out vec4 fragColor;
const float LOG2_10 = 3.321928094887362, LOG10_CM_PER_KPC = 21.489350545189;

float dec(float q, vec2 r) { return q < 0.5 ? 0.0 : exp2(LOG2_10 * (r.x + (q - 1.0) * (r.y - r.x) / 254.0)); }
vec3 dec3(vec3 q, vec2 r) { return vec3(dec(q.r, r), dec(q.g, r), dec(q.b, r)); }
float hl(int l) { return l == 0 ? uHalf.x : l == 1 ? uHalf.y : uHalf.z; }
float hv(vec3 v, int l) { return l == 0 ? v.x : l == 1 ? v.y : v.z; }
float linf(vec3 p) { vec3 a = abs(p); return max(a.x, max(a.y, a.z)); }

/* exact: 8 texelFetch, decode, trilinear in linear space (clamp-to-edge indices, q = 0 -> 0) */
float exact1(sampler3D s, vec3 p, float h, vec2 r) {
  vec3 g = (p / (2.0 * h) + 0.5) * uN - 0.5, i0 = floor(g), f = g - i0; ivec3 b = ivec3(i0), hi = ivec3(int(uN) - 1); float v = 0.0;
  for (int c = 0; c < 8; c++) { ivec3 o = ivec3(c & 1, (c >> 1) & 1, (c >> 2) & 1); vec3 w = mix(1.0 - f, f, vec3(o));
    v += w.x * w.y * w.z * dec(floor(texelFetch(s, clamp(b + o, ivec3(0), hi), 0).r * 255.0 + 0.5), r); }
  return v; }
vec3 exact3(sampler3D s, vec3 p, float h, vec2 r) {
  vec3 g = (p / (2.0 * h) + 0.5) * uN - 0.5, i0 = floor(g), f = g - i0; ivec3 b = ivec3(i0), hi = ivec3(int(uN) - 1); vec3 v = vec3(0.0);
  for (int c = 0; c < 8; c++) { ivec3 o = ivec3(c & 1, (c >> 1) & 1, (c >> 2) & 1); vec3 w = mix(1.0 - f, f, vec3(o));
    v += w.x * w.y * w.z * dec3(floor(texelFetch(s, clamp(b + o, ivec3(0), hi), 0).rgb * 255.0 + 0.5), r); }
  return v; }
float fast1(sampler3D s, vec3 p, float h, vec2 r) { return dec(texture(s, p / (2.0 * h) + 0.5).r * 255.0, r); }
vec3 fast3(sampler3D s, vec3 p, float h, vec2 r) { return dec3(texture(s, p / (2.0 * h) + 0.5).rgb * 255.0, r); }

float gasAt(vec3 p, int l) {
  if (l == 0 && length(p) > uMask0) return 0.0;
  float h = hl(l);
  if (uExact == 1) return l == 0 ? exact1(uGas0, p, h, uGasRange) : l == 1 ? exact1(uGas1, p, h, uGasRange) : exact1(uGas2, p, h, uGasRange);
  return l == 0 ? fast1(uGas0, p, h, uGasRange) : l == 1 ? fast1(uGas1, p, h, uGasRange) : fast1(uGas2, p, h, uGasRange); }
float wAt(vec3 p, int l) {
  if (l == 0 && length(p) > uMask0) return 0.0;
  float h = hl(l);
  if (uExact == 1) return l == 0 ? exact1(uW0, p, h, uWRange) : l == 1 ? exact1(uW1, p, h, uWRange) : exact1(uW2, p, h, uWRange);
  return l == 0 ? fast1(uW0, p, h, uWRange) : l == 1 ? fast1(uW1, p, h, uWRange) : fast1(uW2, p, h, uWRange); }
vec3 starAt(vec3 p, int l) {
  if (l == 0 && length(p) > uMask0) return vec3(0.0);
  float h = hl(l);
  if (uExact == 1) return l == 0 ? exact3(uStar0, p, h, uStarRange0) : l == 1 ? exact3(uStar1, p, h, uStarRange1) : exact3(uStar2, p, h, uStarRange2);
  return l == 0 ? fast3(uStar0, p, h, uStarRange0) : l == 1 ? fast3(uStar1, p, h, uStarRange1) : fast3(uStar2, p, h, uStarRange2); }

/* finest resident level whose box contains p (strictly coarser than \`below\`), -1 if none */
int pick(vec3 have, vec3 p, int below) {
  float m = linf(p);
  for (int l = 2; l >= 0; l--) if (l < below && hv(have, l) > 0.0 && m < hl(l)) return l;
  return -1; }
/* tune2 footprint LOD: a level is used only while its voxel is at least c pixels wide at the segment's distance
   (fp = kpc per pixel there); between 0.5 c and c it is blended with the next coarser resident level. Columns are
   conserved on every level, so this changes only the resolution, and it removes the sub-pixel sparkle (aliasing) of
   the fine levels in wide views. Returns the level and, in mix, the weight of that level (1 = no blend). */
int lodLevel(vec3 have, vec3 p, int l, float fp, float c, out int coarse, out float mixw) {
  coarse = -1; mixw = 1.0;
  if (l < 0 || c <= 0.0) return l;
  for (int i = 0; i < 3; i++) {
    int lc = pick(have, p, l);
    if (lc < 0) return l;                                     /* nothing coarser resident: keep l */
    float r = 2.0 * hl(l) / uN / (c * fp);
    if (r >= 1.0) return l;                                   /* wide enough on screen */
    if (r >= 0.5) { coarse = lc; mixw = smoothstep(0.5, 1.0, r); return l; }
    l = lc; }
  return l; }
/* fade-in: a level whose fade < 1 is mixed linearly with the next coarser resident level */
float gasVal(vec3 p, int l) { float v = gasAt(p, l), f = hv(uGasHave, l);
  if (f < 0.999) { int c = pick(uGasHave, p, l); v = mix(c >= 0 ? gasAt(p, c) : 0.0, v, f); } return v; }
float wVal(vec3 p, int l) { float v = wAt(p, l), f = hv(uWHave, l);
  if (f < 0.999) { int c = pick(uWHave, p, l); v = mix(c >= 0 ? wAt(p, c) : 0.0, v, f); } return v; }
vec3 starVal(vec3 p, int l) { vec3 v = starAt(p, l); float f = hv(uStarHave, l);
  if (f < 0.999) { int c = pick(uStarHave, p, l); v = mix(c >= 0 ? starAt(p, c) : vec3(0.0), v, f); } return v; }

/* vel3d: the packed velocity cube (vizdata.packVelocity): R, G, B = linear q of vx, vy, vz on ±uVelV, A = 1 where
   non-empty, empty voxels packed as q 128 (0 km/s). The trilinear blend of q decodes (affine) to Σ wᵢ vᵢ over the
   non-empty corners and the blended A is Σ wᵢ, so velAt returns the premultiplied pair (Σ wᵢ vᵢ, Σ wᵢ): LOD and fade
   mixes stay linear, and v = xyz / w is the mean over the non-empty corners. */
vec4 velRaw(sampler3D s, vec3 p, float h) {
  if (uExact == 1) {
    vec3 g = (p / (2.0 * h) + 0.5) * uN - 0.5, i0 = floor(g), f = g - i0; ivec3 b = ivec3(i0), hi = ivec3(int(uN) - 1); vec4 v = vec4(0.0);
    for (int c = 0; c < 8; c++) { ivec3 o = ivec3(c & 1, (c >> 1) & 1, (c >> 2) & 1); vec3 w = mix(1.0 - f, f, vec3(o));
      vec4 t = texelFetch(s, clamp(b + o, ivec3(0), hi), 0); v += w.x * w.y * w.z * vec4(floor(t.rgb * 255.0 + 0.5), t.a); }
    return v; }
  vec4 t = texture(s, p / (2.0 * h) + 0.5); return vec4(t.rgb * 255.0, t.a); }
vec4 velAt(vec3 p, int l) {
  if (l == 0 && length(p) > uMask0) return vec4(0.0);
  float h = hl(l); vec4 r = l == 0 ? velRaw(uVel0, p, h) : l == 1 ? velRaw(uVel1, p, h) : velRaw(uVel2, p, h);
  return vec4(-uVelV + (r.rgb - 1.0) * (2.0 * uVelV / 254.0), r.a); }
vec4 velVal(vec3 p, int l) { vec4 v = velAt(p, l); float f = hv(uVelHave, l);
  if (f < 0.999) { int c = pick(uVelHave, p, l); v = mix(c >= 0 ? velAt(p, c) : vec4(0.0), v, f); } return v; }
/* the view of one sample (uVq 1 v_los, 2 v_r, 3 v_phi, 4 |v|, 5 σ_los: dot(v, d) here, its moment 2 along the ray at the end).
   Disk frame: ẑ = Lhat, d = the camera ray direction, so v_los > 0 moves away from the camera (redshift) */
float velQ(vec3 v, vec3 p, vec3 d) {
  if (uVq == 1 || uVq == 5) return dot(v, d);
  if (uVq == 2) { float r = length(p); return r > 1e-4 ? dot(v, p) / r : 0.0; }
  if (uVq == 3) { vec2 t = vec2(-p.y, p.x); float r = length(t); return r > 1e-4 ? dot(v.xy, t) / r : 0.0; }
  return length(v); }

/* TF mode (THOR §3.5.3): gradient of the colour field's log value by central differences on level l, in dex per L1 voxel
   (0.78 kpc; disk-frame axes): the difference over one voxel of level l is scaled by hl(1)/hl(l), so the 2D TF rows and
   the shading classify the same gas alike on every level (no jump at the ±25/±100 kpc faces or on a LOD switch) and match
   the editor's 2D histogram, which is built on L1. It reads the hardware-interpolated q (6 fetches, LOD/fade/mask not applied): q is linear in log v,
   so the q difference is the log difference. Empty texels (q 0) blend in as low values, so the edge of the deposited
   gas reads as a steep gradient (a real boundary). */
float qAt(vec3 t, int l) { return (l == 0 ? texture(uGas0, t).r : l == 1 ? texture(uGas1, t).r : texture(uGas2, t).r) * 255.0; }
vec3 gradAt(vec3 p, int l) {
  vec3 t = p / (2.0 * hl(l)) + 0.5; float e = 1.0 / uN, s = 0.5 * (uGasRange.y - uGasRange.x) / 254.0;
  s *= hl(1) / hl(l);
  return s * vec3(qAt(t + vec3(e, 0.0, 0.0), l) - qAt(t - vec3(e, 0.0, 0.0), l), qAt(t + vec3(0.0, e, 0.0), l) - qAt(t - vec3(0.0, e, 0.0), l),
                  qAt(t + vec3(0.0, 0.0, e), l) - qAt(t - vec3(0.0, 0.0, e), l)); }
/* TF lookup at normalised value x and gradient magnitude gn (row 0 when the TF is 1D: all rows are equal) */
vec4 tfAt(float x, float gn) { return texture(uTF, vec2((clamp(x, 0.0, 1.0) * 255.0 + 0.5) / 256.0, (clamp(gn, 0.0, 1.0) * 63.0 + 0.5) / 64.0)); }
/* headlight shading: two-sided Lambert + a soft Blinn-Phong lobe (light = view = −d, so H = −d), normal = the gradient;
   ambient 0.35 keeps the far sides readable. Fades in with the gradient (no normal in flat regions). */
vec3 shadeTF(vec3 c, vec3 g, float gn, vec3 d) {
  float gl = length(g); if (gl <= 1e-6 || uShade <= 0.0) return c;
  float nd = abs(dot(g / gl, d));
  vec3 lit = c * (0.35 + 0.65 * nd) + vec3(0.25 * pow(nd, 24.0));
  return mix(c, lit, uShade * smoothstep(0.02, 0.1, gn)); }

vec2 slab(vec3 o, vec3 d, float h) { vec3 inv = 1.0 / d, a = (vec3(-h) - o) * inv, b = (vec3(h) - o) * inv;
  vec3 lo = min(a, b), hi = max(a, b); return vec2(max(max(lo.x, lo.y), lo.z), min(min(hi.x, hi.y), hi.z)); }
float hash(vec2 p, float f) { p = fract(p * vec2(0.1031, 0.1030) + f * 0.61803399); p += dot(p, p.yx + 33.33); return fract((p.x + p.y) * p.x); }
vec3 lutc(float x) { return texture(uLut, vec2((clamp(x, 0.0, 1.0) * 255.0 + 0.5) / 256.0, 0.5)).rgb; }
float asinhf(float x) { return log(x + sqrt(x * x + 1.0)); }
vec3 lupton(vec3 S) {        /* S = (Σ_i, Σ_r, Σ_g) [L_AB0 kpc^-2] -> sRGB (design §4.5) */
  vec3 c = uStarBal * S / uStarS0; float I = (c.r + c.g + c.b) / 3.0;
  if (!(I > 0.0)) return vec3(0.0);
  c *= asinhf(uStarQ * I) / (uStarQ * I);
  /* tune2: a mild saturation boost about the channel mean (uStarSat = 1 is plain Lupton) */
  float mc = (c.r + c.g + c.b) / 3.0; c = max(vec3(0.0), mc + (c - mc) * uStarSat);
  float m = max(c.r, max(c.g, c.b));
  /* tune1: a soft shoulder on the max channel instead of the hard m > 1 clip, so the bulge keeps its gradient; the
     scale is common to the 3 channels (hue kept). uStarKnee = 0 restores the plain Lupton clip. */
  if (uStarKnee > 0.0 && m > uStarKnee) { float k = uStarKnee, r = 1.0 - k; c *= (k + r * (1.0 - exp(-(m - k) / r))) / m; }
  else if (m > 1.0) c /= m;
  return c; }

void main() {
  vec3 o = uCamDisk, d = normalize(vPos - uCamDisk);
  d = mix(d, vec3(1e-7), vec3(lessThan(abs(d), vec3(1e-7))));
  vec2 tb = slab(o, d, uHalf.x); float t0 = max(tb.x, 0.0), t1 = tb.y;
  if (t1 <= t0) { fragColor = vec4(uBg, uAccW); return; }
  /* vel3d: in a velocity view (uVq > 0) the gas layer is the velocity cube with its weight (uW*: n_H or an ion); a level
     is usable where both are resident */
  bool velMode = uVq > 0;
  vec3 gHave = velMode ? min(uVelHave, uWHave) : uGasHave;
  bool gasOn = uGasMix > 0.0 && (gHave.x + gHave.y + gHave.z) > 0.0, starOn = uStarMix > 0.0 && (uStarHave.x + uStarHave.y + uStarHave.z) > 0.0;
  bool weighted = !velMode && uKind == 1 && uMode == 0;
  float num2 = 0.0, wspan = max(uWWin.y - uWWin.x, 1e-6);
  /* TF mode: volume mode of a scalar gas field with the transfer function uTF instead of the fixed ramp; tfW: the
     emissivity weight (uW*, e.g. n_H) scales the emitted colour by (w / 10^uWRef)^uGamma */
  bool tfMode = uTFOn == 1 && uMode == 1 && !velMode, tfW = tfMode && uTFW == 1 && uGamma > 0.0;
  float tspan = max(uTFWin.y - uTFWin.x, 1e-6), gdiv = 1.0 / max(uGradMax, 1e-6);
  /* segment breakpoints: entry/exit of the ±100 and ±25 boxes (nested, so already ordered) */
  vec2 s1 = slab(o, d, uHalf.y), s2 = slab(o, d, uHalf.z);
  if (s1.x >= s1.y) s1 = vec2(t1); if (s2.x >= s2.y) s2 = vec2(clamp(s1.x, t0, t1));
  float bp[6]; bp[0] = t0; bp[1] = clamp(s1.x, t0, t1); bp[2] = clamp(s2.x, bp[1], t1); bp[3] = clamp(s2.y, bp[2], t1); bp[4] = clamp(s1.y, bp[3], t1); bp[5] = t1;
  /* tune2: interleaved-gradient ray jitter (decorrelated per refine frame, averaged by the accumulation) */
  float jit = fract(52.9829189 * fract(dot(gl_FragCoord.xy + 5.588238 * float(uFrame & 63), vec2(0.06711056, 0.00583715)))), sumG = 0.0, num = 0.0, den = 0.0; vec3 sumS = vec3(0.0), C = vec3(0.0); float A = 0.0;
  /* tune3: kappa = uVolK * opacity² per kpc (was 0.25 * opacity²), so the disk and the inner CGM reach mid-to-high LUT
     brightness at the default opacity; uVolGain scales the emitted colour */
  float span = max(uWin.y - uWin.x, 1e-6), kappa = uVolK * uOpacity * uOpacity;
  int it = 0;
  for (int s = 0; s < 5; s++) {
    float ta = bp[s], tl = bp[s + 1] - ta; if (tl <= 1e-5) continue;
    vec3 pm = o + d * (ta + 0.5 * tl);
    int lg = gasOn ? pick(gHave, pm, 3) : -1, lw = (weighted || tfW) ? pick(uWHave, pm, 3) : -1, ls = starOn ? pick(uStarHave, pm, 3) : -1;
    float fp = uPxAng * max(length(pm - o), 1.0), mg = 1.0, mw = 1.0, ms = 1.0; int cg = -1, cw = -1, cs = -1;
    lg = lodLevel(gHave, pm, lg, fp, uLodC.x, cg, mg); lw = lodLevel(uWHave, pm, lw, fp, uLodC.x, cw, mw);
    ls = lodLevel(uStarHave, pm, ls, fp, uLodC.y, cs, ms);
    bool doGas = lg >= 0 && !(uMode == 1 && A > 0.99);
    if (!doGas && ls < 0) continue;
    float dv = 1e9; if (lg >= 0) dv = min(dv, hl(lg)); if (ls >= 0) dv = min(dv, hl(ls));
    float dt = 2.0 * dv / uN / uSpv; int n = max(1, int(ceil(tl / dt))); float h = tl / float(n);
    for (int k = 0; k < 4096; k++) {
      if (k >= n || it >= 4096) break; it++;
      float tk = ta + (float(k) + jit) * h; vec3 p = o + d * tk;
      /* tune2 near fade: material closer to the camera than uNear.x is left out, fading in by uNear.y, so cells right in
         front of the lens no longer swell into out-of-focus discs when the camera is inside the halo */
      float hw = h * smoothstep(uNear.x, uNear.y, tk); if (hw <= 0.0) continue;
      if (velMode && lg >= 0 && !(uMode == 1 && A > 0.99)) {
        /* vel3d: weight w (density) and the premultiplied velocity at p, mixed with the coarser level like the gas */
        float w = wVal(p, lg); vec4 m = velVal(p, lg); if (cg >= 0) { w = mix(wVal(p, cg), w, mg); m = mix(velVal(p, cg), m, mg); }
        if (w > 0.0 && m.w > 1e-3) {
          float qv = velQ(m.xyz / m.w, p, d);
          if (uMode == 0) { float ww = w * hw; num += ww * qv; num2 += ww * qv * qv; den += ww; }
          else { float xw = clamp((log2(w) / LOG2_10 - uWWin.x) / wspan, 0.0, 1.0);   /* opacity from the weight's volume window */
            if (xw > 0.0) { float a = 1.0 - exp(-kappa * xw * xw * hw); C += (1.0 - A) * a * lutc((qv - uWin.x) / span); A += (1.0 - A) * a; } }
        }
      } else if (lg >= 0 && !(uMode == 1 && A > 0.99)) {
        float v = gasVal(p, lg); if (cg >= 0) v = mix(gasVal(p, cg), v, mg);
        if (uMode == 0) {
          if (weighted) { float w = lw >= 0 ? wVal(p, lw) : 0.0; if (lw >= 0 && cw >= 0) w = mix(wVal(p, cw), w, mw); num += w * v * hw; den += w * hw; }
          else sumG += v * hw;
        } else if (tfMode) {
          /* THOR: C = ∫ c μ exp(−∫ μ) ds, front to back. Per step μ = kappa alpha_TF (kappa = uVolK opacity² per kpc,
             as the ramp's kappa x²), opacity a = 1 − exp(−μ h) (= μ h for thin steps), emission (1 − A) a c W with W the
             emissivity weight; values below the TF window are transparent, above it take the TF's top texel */
          float x = v > 0.0 ? (log2(v) / LOG2_10 - uTFWin.x) / tspan : -1.0;
          if (x >= 0.0) {
            vec3 g = vec3(0.0); float gn = 0.0;
            if (uTF2D == 1) { g = gradAt(p, lg); if (cg >= 0 && mg < 1.0) g = mix(gradAt(p, cg), g, mg); gn = length(g) * gdiv; }
            vec4 tf = tfAt(x, gn);
            if (tf.a > 0.0) {
              if (uShade > 0.0 && uTF2D != 1) { g = gradAt(p, lg); if (cg >= 0 && mg < 1.0) g = mix(gradAt(p, cg), g, mg); gn = length(g) * gdiv; }
              float a = 1.0 - exp(-kappa * tf.a * hw), W = 1.0;
              if (tfW && lw >= 0) { float w = wVal(p, lw); if (cw >= 0) w = mix(wVal(p, cw), w, mw);
                W = w > 0.0 ? exp2(uGamma * (log2(w) - LOG2_10 * uWRef)) : 0.0; }
              C += (1.0 - A) * a * W * shadeTF(tf.rgb, g, gn, d); A += (1.0 - A) * a; }
          }
        } else if (v > 0.0) {
          float x = clamp((log2(v) / LOG2_10 - uWin.x) / span, 0.0, 1.0);
          if (x > 0.0) { float a = 1.0 - exp(-kappa * x * x * hw); C += (1.0 - A) * a * lutc(x); A += (1.0 - A) * a; }
        }
      }
      if (ls >= 0) { vec3 sv = starVal(p, ls); if (cs >= 0) sv = mix(starVal(p, cs), sv, ms); sumS += sv * hw; }
    }
  }
  vec3 gas = vec3(0.0);
  if (gasOn) {
    if (uMode == 1) {
      /* emissive TF (density-weighted): soft knee instead of clipping, hue kept: linear up to 0.6 in the brightest
         channel, then 0.6 + 0.4 (1 − exp(−(m − 0.6) / 0.4)), so dense clouds and the disk stay coloured, not white */
      vec3 e = C * uVolGain; float m = max(e.r, max(e.g, e.b));
      if (tfW && m > 0.6) e *= (0.6 + 0.4 * (1.0 - exp(-(m - 0.6) / 0.4))) / m;
      gas = min(e, vec3(1.0)) + (1.0 - A) * uBg; }
    else if (velMode) {
      /* vel3d integral: the weight-weighted mean of the view along the ray (moment 1), or for σ_los the weighted dispersion
         of dot(v, d), sqrt(moment 2 − moment 1²); it fades into the background below the weight column floor uWWin.x */
      float m1 = den > 0.0 ? num / den : 0.0, qv = uVq == 5 ? (den > 0.0 ? sqrt(max(num2 / den - m1 * m1, 0.0)) : 0.0) : m1;
      float lc = den > 0.0 ? log2(den) / LOG2_10 + LOG10_CM_PER_KPC : -1e30;
      gas = mix(uBg, lutc((qv - uWin.x) / span), smoothstep(uWWin.x - max(uFadeDex, 1e-3), uWWin.x, lc));
    } else {
      float lv = weighted ? (den > 0.0 && num > 0.0 ? log2(num / den) / LOG2_10 : -1e30) : (sumG > 0.0 ? log2(sumG) / LOG2_10 + LOG10_CM_PER_KPC : -1e30);
      float x = (lv - uWin.x) / span;
      /* tune1: columns below the window fade from LUT(0) into the background over uFadeDex dex (soft floor), so
         empty / masked regions (Σ = 0) leave no silhouette and sparse regions have no hard staircase edge */
      gas = mix(uBg, lutc(x), smoothstep(-max(uFadeDex, 1e-3) / span, 0.0, x));
    }
    /* tune1: a vignette at the limb of the r = uMask0 sphere (rays whose closest approach to the centre is within the
       outer 25 %; tune2: was 15 %), so wide views show no hard disc edge where the L0 mask cuts the CGM; columns are not changed */
    if (gHave.x > 0.0) { float bimp = length(cross(o, d)); gas = mix(uBg, gas, smoothstep(uMask0, 0.75 * uMask0, bimp)); }
  } else gas = uBg;                  /* gas layer off or not resident yet: stars over the background */
  vec3 star = starOn ? uStarMix * lupton(sumS) : vec3(0.0);
  /* tune3: the faint stellar envelope fades out below a floor of its max channel (uStarFloor .. 3 uStarFloor), so it no
     longer tints the gas around the disk khaki; bright starlight is unchanged */
  if (starOn && uStarFloor > 0.0) { float s0 = max(star.r, max(star.g, star.b)); star *= smoothstep(uStarFloor, 3.0 * uStarFloor, s0); }
  float gm = gasOn ? uGasMix : 1.0;
  /* tune1: the layers screen-blend; then, where the starlight is bright (smoothstep 0.04…0.45 of its max channel,
     times uStarOcc), the result takes the stars' hue at max(star, 0.7 × blend) brightness. A bright gas disk therefore
     no longer bleaches the stellar colours (yellow bulge, blue arms), and no dark rim appears. uStarOcc = 0: plain screen */
  /* tune2: the gas layer is mixed toward the background (was: scaled toward black), so an empty column inside the
     box is exactly uBg and the box silhouette no longer shows as a darker hexagon */
  float sm = max(star.r, max(star.g, star.b)), occ = uStarOcc * smoothstep(uOccRange.x, uOccRange.y, sm);
  if (uCompMode == 1) {
    /* tune3 composite: bright starlight attenuates the gas layer toward the background (occ), then the stars screen over
       it. No hue replacement, so the faint stellar envelope adds light over the gas instead of tinting it olive, and the
       bright disk keeps the stellar colours because the gas under it is dimmed rather than bleached into white */
    /* fix-ui V1: uGasW (< 1 in close views, from the viewer) lowers the gas layer under the stars, so a near-white gas
       disk at the top of the LUT leaves the screen blend room for the stellar colours */
    vec3 g = mix(uBg, gas, gm * (starOn ? uGasW : 1.0) * (1.0 - occ));
    fragColor = vec4(1.0 - (1.0 - g) * (1.0 - star), uAccW);
  } else {
    vec3 base = 1.0 - (1.0 - mix(uBg, gas, gm)) * (1.0 - star);
    vec3 tint = star / max(sm, 1e-4) * max(sm, 0.7 * max(base.r, max(base.g, base.b)));
    /* tune2: alpha = uAccW, the running-mean weight of this refine frame (1 for a single frame) */
    fragColor = vec4(mix(base, tint, occ), uAccW);
  }
}`;

/* opts: {n} (cube size, default 256). Every sampler starts bound to an empty 1³ texture; the viewer binds levels. */
export function makeMaterial(T, opts = {}) {
  const e1 = new T.Data3DTexture(new Uint8Array(1), 1, 1, 1); e1.format = T.RedFormat; e1.needsUpdate = true;
  const e4 = new T.Data3DTexture(new Uint8Array(4), 1, 1, 1); e4.format = T.RGBAFormat; e4.needsUpdate = true;
  const lutTex = new T.DataTexture(new Uint8Array(256 * 4), 256, 1, T.RGBAFormat, T.UnsignedByteType);
  lutTex.minFilter = lutTex.magFilter = T.LinearFilter; lutTex.needsUpdate = true;
  /* TF texture: 256 (value) × 64 (gradient) RGBA8, tf.js buildTF bytes; write tfTex.image.data and set needsUpdate */
  const tfTex = new T.DataTexture(new Uint8Array(256 * 64 * 4), 256, 64, T.RGBAFormat, T.UnsignedByteType);
  tfTex.minFilter = tfTex.magFilter = T.LinearFilter; tfTex.needsUpdate = true;
  const u = v => ({value: v}), V2 = (a, b) => new T.Vector2(a, b), V3 = (a, b, c) => new T.Vector3(a, b, c);
  const uniforms = {
    uGas0: u(e1), uGas1: u(e1), uGas2: u(e1), uW0: u(e1), uW1: u(e1), uW2: u(e1), uStar0: u(e4), uStar1: u(e4), uStar2: u(e4),
    uHalf: u(V3(400, 100, 25)), uN: u(opts.n || 256),
    uGasHave: u(V3(0, 0, 0)), uWHave: u(V3(0, 0, 0)), uStarHave: u(V3(0, 0, 0)),
    uGasRange: u(V2(0, 1)), uWRange: u(V2(0, 1)), uStarRange0: u(V2(0, 1)), uStarRange1: u(V2(0, 1)), uStarRange2: u(V2(0, 1)),
    uMask0: u(400), uCamDisk: u(V3(0, 0, 1000)), uMode: u(0), uKind: u(0), uWin: u(V2(0, 1)), uLut: u(lutTex),
    uOpacity: u(0.5), uSpv: u(1.0), uExact: u(1), uFrame: u(0),
    uGasMix: u(1.0), uStarMix: u(0.0), uStarQ: u(8.0), uStarS0: u(10 ** (0.4 * (36.57212566588 - 21.5))), uStarBal: u(V3(1, 1, 1)),
    uBg: u(V3(5 / 255, 7 / 255, 11 / 255)),
    uFadeDex: u(1.0), uStarKnee: u(0.75), uStarOcc: u(0.9),
    uSub: u(V2(0, 0)), uPxAng: u(0), uAccW: u(1), uLodC: u(V2(0, 0)), uNear: u(V2(0, 0)), uStarSat: u(1),
    uVolK: u(0.25), uVolGain: u(1.0), uStarFloor: u(0.0), uGasW: u(1.0), uOccRange: u(V2(0.04, 0.45)), uCompMode: u(0),
    /* vel3d: packed velocity cubes (13 of the 16 texture units with the 9 cubes and the LUT), ±V of the linear encoding,
       the view (0 = none), and the weight's log window (column floor in integral mode, volume window in volume mode) */
    uVel0: u(e4), uVel1: u(e4), uVel2: u(e4), uVelHave: u(V3(0, 0, 0)), uVelV: u(1), uVq: u(0), uWWin: u(V2(0, 1)),
    /* TF volume mode (tf.js; the 14th texture unit): off by default, so every other mode is unchanged */
    uTF: u(tfTex), uTFOn: u(0), uTFWin: u(V2(0, 1)), uTF2D: u(0), uShade: u(0), uGradMax: u(0.5), uTFW: u(0), uGamma: u(0), uWRef: u(0)};
  const mat = new T.ShaderMaterial({glslVersion: T.GLSL3, vertexShader: VERT, fragmentShader: FRAG, uniforms,
    side: T.BackSide, transparent: true, depthWrite: false, depthTest: false,
    /* tune2: the refine frames blend into the accumulation target with weight uAccW (running mean) */
    blending: T.CustomBlending, blendEquation: T.AddEquation, blendSrc: T.SrcAlphaFactor, blendDst: T.OneMinusSrcAlphaFactor,
    blendSrcAlpha: T.OneFactor, blendDstAlpha: T.ZeroFactor});
  return {material: mat, uniforms, empty1: e1, empty4: e4, lutTex, tfTex};
}
