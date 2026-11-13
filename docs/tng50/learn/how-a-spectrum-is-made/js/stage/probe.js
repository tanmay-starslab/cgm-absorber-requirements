// The beam (the sightline) and the probe (the packet of quasar light) (DESIGN §5 "Beam and probe", C_ux P0-4).
// Beam: a screen-space ribbon of `px` CSS px along the whole ray, split into 512 segments so it clips cleanly when it passes
// the camera. Behind the probe (l < s) it is lit, solid, warm white, with a short brighter trail; ahead it is an unlit dashed
// guide at 35 %. Probe: an additive glow sprite with a hot core. Everything in the disk frame (kpc).
const SEG = 512;
const BVS = `in vec3 other; in float side; in float lpos; uniform vec2 uRes; uniform float uPx;
out float vL; out float vSide;
void main() { mat4 M = projectionMatrix * viewMatrix; vec4 a = M * vec4(position, 1.0), b = M * vec4(other, 1.0); vL = lpos; vSide = side;
  if (a.w <= 1e-3 && b.w <= 1e-3) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); return; }
  if (a.w <= 1e-3) { float f = (1e-3 - a.w) / (b.w - a.w); a = mix(a, b, f); }
  if (b.w <= 1e-3) { float f = (1e-3 - b.w) / (a.w - b.w); b = mix(b, a, f); }
  vec2 sa = a.xy / a.w * uRes, sb = b.xy / b.w * uRes, d = sb - sa; d = length(d) > 1e-6 ? normalize(d) : vec2(1.0, 0.0);
  gl_Position = vec4((a.xy / a.w + vec2(-d.y, d.x) * side * uPx / uRes) * a.w, 0.0, a.w); }`;
const BFS = `in float vL; in float vSide; uniform float uS, uLit, uGuide, uDash; uniform vec3 uCol; out vec4 o;
void main() { float edge = 1.0 - smoothstep(0.35, 1.0, abs(vSide));
  float lit = step(vL, uS), trail = exp(-max(uS - vL, 0.0) / 6.0);
  float dash = step(0.5, fract(vL / uDash));
  float a = lit * (uLit + 0.9 * trail) + (1.0 - lit) * uGuide * dash;
  o = vec4(uCol * a * edge, 0.0); }`;
const PVS = `uniform vec3 uP; uniform float uSize, uFocal; out vec2 vQ;
void main() { vQ = position.xy; vec4 cv = viewMatrix * vec4(uP, 1.0); if (-cv.z <= 0.05) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); return; }
  float r = uSize / uFocal * (-cv.z); gl_Position = projectionMatrix * vec4(cv.xy + position.xy * r, cv.z, 1.0); }`;
const PFS = `in vec2 vQ; uniform vec3 uCol; uniform float uI; out vec4 o;
void main() { float q = length(vQ); if (q >= 1.0) discard; float g = exp(-9.0 * q * q) + 0.35 * exp(-2.5 * q * q) * (1.0 - q); float core = 1.0 - smoothstep(0.0, 0.12, q);
  o = vec4((uCol * g + vec3(1.0) * core * 1.5) * uI, 0.0); }`;
export function makeProbe(T, {rayO, rayN, half, px = 1.6, color = [1.0, 0.957, 0.875]} = {}) {
  const pos = new Float32Array(SEG * 4 * 3), oth = new Float32Array(SEG * 4 * 3), side = new Float32Array(SEG * 4), lp = new Float32Array(SEG * 4), idx = [];
  const P = l => [rayO[0] + l * rayN[0], rayO[1] + l * rayN[1], rayO[2] + l * rayN[2]];
  for (let i = 0; i < SEG; i++) {
    const la = -half + 2 * half * i / SEG, lb = -half + 2 * half * (i + 1) / SEG, a = P(la), b = P(lb);
    const v = [[a, b, 1, la], [a, b, -1, la], [b, a, 1, lb], [b, a, -1, lb]];   /* at b the direction is reversed, so +1 is the same side as −1 at a */
    v.forEach(([p, q, sd, l], k) => { pos.set(p, (4 * i + k) * 3); oth.set(q, (4 * i + k) * 3); side[4 * i + k] = sd; lp[4 * i + k] = l; });
    idx.push(4 * i, 4 * i + 1, 4 * i + 2, 4 * i, 4 * i + 2, 4 * i + 3);
  }
  const g = new T.BufferGeometry(); g.setAttribute("position", new T.BufferAttribute(pos, 3)); g.setAttribute("other", new T.BufferAttribute(oth, 3));
  g.setAttribute("side", new T.BufferAttribute(side, 1)); g.setAttribute("lpos", new T.BufferAttribute(lp, 1)); g.setIndex(idx);
  const add = {transparent: true, depthTest: false, depthWrite: false, blending: T.CustomBlending, blendEquation: T.AddEquation, blendSrc: T.OneFactor, blendDst: T.OneFactor,
    blendSrcAlpha: T.ZeroFactor, blendDstAlpha: T.OneFactor};
  const bu = {uRes: {value: new T.Vector2(1, 1)}, uPx: {value: px}, uS: {value: -half}, uLit: {value: 0.55}, uGuide: {value: 0.35}, uDash: {value: 3.0}, uCol: {value: new T.Vector3(...color)}};
  const beam = new T.Mesh(g, new T.ShaderMaterial({glslVersion: T.GLSL3, vertexShader: BVS, fragmentShader: BFS, uniforms: bu, ...add})); beam.frustumCulled = false;
  const qg = new T.BufferGeometry(); qg.setAttribute("position", new T.BufferAttribute(new Float32Array([-1, -1, 0, 1, -1, 0, 1, 1, 0, -1, 1, 0]), 3)); qg.setIndex([0, 1, 2, 0, 2, 3]);
  const pu = {uP: {value: new T.Vector3()}, uSize: {value: 26}, uFocal: {value: 1000}, uCol: {value: new T.Vector3(1.0, 0.85, 0.6)}, uI: {value: 1}};
  const probe = new T.Mesh(qg, new T.ShaderMaterial({glslVersion: T.GLSL3, vertexShader: PVS, fragmentShader: PFS, uniforms: pu, ...add})); probe.frustumCulled = false;
  const group = new T.Group(); group.add(beam, probe);
  return {group, beam, probe,
    /* {s, res: [w, h] (device px of the target), dpr, focal (device px), size} */
    update({s, res, dpr = 1, focal, size = 26, visible = true}) {
      group.visible = visible; bu.uS.value = s; bu.uRes.value.set(res[0] / 2, res[1] / 2); bu.uPx.value = px * dpr;
      pu.uP.value.fromArray(P(s)); pu.uFocal.value = focal; pu.uSize.value = size * dpr; },
    dispose() { g.dispose(); qg.dispose(); beam.material.dispose(); probe.material.dispose(); }};
}
