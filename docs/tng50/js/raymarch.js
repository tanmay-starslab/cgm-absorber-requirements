// GLSL3 ray marcher for the Phase-2b 3D viewer (design §5.5) and makeMaterial(THREE, opts).
// One fragment pass on the back faces of the L0 box (mesh local coordinates = disk-frame kpc). Each ray is cut at the
// faces of the ±100 and ±25 kpc boxes into ≤ 5 segments; each segment samples the finest RESIDENT level that
// contains it (gas and stars independently), with a step of that level's voxel / uSpv, so no sample straddles two
// levels. Exact samples decode the 8 neighbouring u8 texels to linear values and mix them trilinearly (texelFetch);
// the fast path decodes the hardware-interpolated q (a log-space blend, used only while moving).
// Integral mode: gas column (or n_H-weighted mean of T, Z) -> LUT; stars: Σ_b = Σ ℓ_b dt -> Lupton asinh composite;
// the two layers combine by a screen blend. Volume mode: front-to-back emission/absorption of the gas over uBg.
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
  bool gasOn = uGasMix > 0.0 && (uGasHave.x + uGasHave.y + uGasHave.z) > 0.0, starOn = uStarMix > 0.0 && (uStarHave.x + uStarHave.y + uStarHave.z) > 0.0;
  bool weighted = uKind == 1 && uMode == 0;
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
    int lg = gasOn ? pick(uGasHave, pm, 3) : -1, lw = weighted ? pick(uWHave, pm, 3) : -1, ls = starOn ? pick(uStarHave, pm, 3) : -1;
    float fp = uPxAng * max(length(pm - o), 1.0), mg = 1.0, mw = 1.0, ms = 1.0; int cg = -1, cw = -1, cs = -1;
    lg = lodLevel(uGasHave, pm, lg, fp, uLodC.x, cg, mg); lw = lodLevel(uWHave, pm, lw, fp, uLodC.x, cw, mw);
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
      if (lg >= 0 && !(uMode == 1 && A > 0.99)) {
        float v = gasVal(p, lg); if (cg >= 0) v = mix(gasVal(p, cg), v, mg);
        if (uMode == 0) {
          if (weighted) { float w = lw >= 0 ? wVal(p, lw) : 0.0; if (lw >= 0 && cw >= 0) w = mix(wVal(p, cw), w, mw); num += w * v * hw; den += w * hw; }
          else sumG += v * hw;
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
    if (uMode == 1) gas = min(C * uVolGain, vec3(1.0)) + (1.0 - A) * uBg;
    else {
      float lv = weighted ? (den > 0.0 && num > 0.0 ? log2(num / den) / LOG2_10 : -1e30) : (sumG > 0.0 ? log2(sumG) / LOG2_10 + LOG10_CM_PER_KPC : -1e30);
      float x = (lv - uWin.x) / span;
      /* tune1: columns below the window fade from LUT(0) into the background over uFadeDex dex (soft floor), so
         empty / masked regions (Σ = 0) leave no silhouette and sparse regions have no hard staircase edge */
      gas = mix(uBg, lutc(x), smoothstep(-max(uFadeDex, 1e-3) / span, 0.0, x));
    }
    /* tune1: a vignette at the limb of the r = uMask0 sphere (rays whose closest approach to the centre is within the
       outer 25 %; tune2: was 15 %), so wide views show no hard disc edge where the L0 mask cuts the CGM; columns are not changed */
    if (uGasHave.x > 0.0) { float bimp = length(cross(o, d)); gas = mix(uBg, gas, smoothstep(uMask0, 0.75 * uMask0, bimp)); }
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
    uVolK: u(0.25), uVolGain: u(1.0), uStarFloor: u(0.0), uGasW: u(1.0), uOccRange: u(V2(0.04, 0.45)), uCompMode: u(0)};
  const mat = new T.ShaderMaterial({glslVersion: T.GLSL3, vertexShader: VERT, fragmentShader: FRAG, uniforms,
    side: T.BackSide, transparent: true, depthWrite: false, depthTest: false,
    /* tune2: the refine frames blend into the accumulation target with weight uAccW (running mean) */
    blending: T.CustomBlending, blendEquation: T.AddEquation, blendSrc: T.SrcAlphaFactor, blendDst: T.OneMinusSrcAlphaFactor,
    blendSrcAlpha: T.OneFactor, blendDstAlpha: T.ZeroFactor});
  return {material: mat, uniforms, empty1: e1, empty4: e4, lutTex};
}
