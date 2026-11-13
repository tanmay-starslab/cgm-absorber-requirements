// Post: composite of the two volume segments and the near field, own bloom, vignette, dither and grain (DESIGN_final §3.4
// row "post"; C_eng P1-7: no pmndrs postprocessing). Passes (full-screen triangles):
//   compose(far, splat, bg) -> scene      far.rgb + splat.rgb + (1 − far.a) bg          (half-res inputs, bilinear)
//   [geometry is drawn additively into scene by the stage]
//   bloom(scene): bright-pass to 1/2 CSS px (resize base), 4 downsamples (13-tap) and tent upsamples back to 1/2
//   final(scene, near, bloom) -> canvas: near over scene (premultiplied), + bloom·k, vignette, grain, dither
/* JS mirror of the band ceiling (node test): luminance L -> rolled-off luminance under a full mask */
export function ceilLum(L, ceil = 0.28) { const kn = 0.5 * ceil; return !(ceil > 0) || L <= kn ? L : kn + (ceil - kn) * (1 - Math.exp(-(L - kn) / (ceil - kn))); }
export function makePost(T) {
  const tri = new T.BufferGeometry(); tri.setAttribute("position", new T.BufferAttribute(new Float32Array([-1, -1, 0, 3, -1, 0, -1, 3, 0]), 3));
  const cam = new T.OrthographicCamera(-1, 1, 1, -1, 0, 1), VS = `out vec2 vUv; void main() { vUv = position.xy * 0.5 + 0.5; gl_Position = vec4(position.xy, 0.0, 1.0); }`;
  const pass = (fs, uniforms) => { const m = new T.ShaderMaterial({glslVersion: T.GLSL3, vertexShader: VS, fragmentShader: fs, uniforms, depthTest: false, depthWrite: false});
    const s = new T.Scene(), mesh = new T.Mesh(tri, m); mesh.frustumCulled = false; s.add(mesh); return {scene: s, mat: m, u: uniforms}; };
  const compose = pass(`in vec2 vUv; uniform sampler2D uFar, uSplat; uniform vec3 uBg; out vec4 o;
    void main() { vec4 f = texture(uFar, vUv); vec3 s = texture(uSplat, vUv).rgb; float m = max(s.r, max(s.g, s.b));
      if (m > 0.6) s *= (0.6 + 0.4 * (1.0 - exp(-(m - 0.6) / 0.4))) / m;   /* the volume's soft knee on the summed splats */
      o = vec4(f.rgb + s + (1.0 - f.a) * uBg, 1.0); }`,
    {uFar: {value: null}, uSplat: {value: null}, uBg: {value: new T.Vector3(4 / 255, 5 / 255, 10 / 255)}});
  /* 4 bilinear taps at ±1/4 of a target texel: an exact box over the source at 2:1 (DPR 1) and at 4:1 (DPR 2, CSS-px chain),
     so small bright beads never fall between samples and flicker in the bloom */
  const bright = pass(`in vec2 vUv; uniform sampler2D uSrc; uniform float uTh, uKnee; uniform vec2 uOff; out vec4 o;
    void main() { vec3 c = 0.25 * (texture(uSrc, vUv + uOff).rgb + texture(uSrc, vUv - uOff).rgb + texture(uSrc, vUv + vec2(uOff.x, -uOff.y)).rgb + texture(uSrc, vUv + vec2(-uOff.x, uOff.y)).rgb); float m = max(c.r, max(c.g, c.b)); float s = clamp(m - uTh + uKnee, 0.0, 2.0 * uKnee); s = s * s / (4.0 * uKnee + 1e-5);
      o = vec4(c * max(s, m - uTh) / max(m, 1e-4), 1.0); }`, {uSrc: {value: null}, uTh: {value: 0.62}, uKnee: {value: 0.2}, uOff: {value: new T.Vector2()}});
  const down = pass(`in vec2 vUv; uniform sampler2D uSrc; uniform vec2 uTx; out vec4 o;
    void main() { vec2 t = uTx; vec3 a = texture(uSrc, vUv + t * vec2(-2, 2)).rgb, b = texture(uSrc, vUv + t * vec2(0, 2)).rgb, c = texture(uSrc, vUv + t * vec2(2, 2)).rgb,
      d = texture(uSrc, vUv + t * vec2(-2, 0)).rgb, e = texture(uSrc, vUv).rgb, f = texture(uSrc, vUv + t * vec2(2, 0)).rgb,
      g = texture(uSrc, vUv + t * vec2(-2, -2)).rgb, h = texture(uSrc, vUv + t * vec2(0, -2)).rgb, i = texture(uSrc, vUv + t * vec2(2, -2)).rgb,
      j = texture(uSrc, vUv + t * vec2(-1, 1)).rgb, k = texture(uSrc, vUv + t * vec2(1, 1)).rgb, l = texture(uSrc, vUv + t * vec2(-1, -1)).rgb, m = texture(uSrc, vUv + t * vec2(1, -1)).rgb;
      o = vec4(e * 0.125 + (a + c + g + i) * 0.03125 + (b + d + f + h) * 0.0625 + (j + k + l + m) * 0.125, 1.0); }`, {uSrc: {value: null}, uTx: {value: new T.Vector2()}});
  const up = pass(`in vec2 vUv; uniform sampler2D uSrc, uLow; uniform vec2 uTx; uniform float uR; out vec4 o;
    void main() { vec2 t = uTx * uR; vec3 s = texture(uLow, vUv + t * vec2(-1, 1)).rgb + 2.0 * texture(uLow, vUv + t * vec2(0, 1)).rgb + texture(uLow, vUv + t * vec2(1, 1)).rgb
      + 2.0 * texture(uLow, vUv + t * vec2(-1, 0)).rgb + 4.0 * texture(uLow, vUv).rgb + 2.0 * texture(uLow, vUv + t * vec2(1, 0)).rgb
      + texture(uLow, vUv + t * vec2(-1, -1)).rgb + 2.0 * texture(uLow, vUv + t * vec2(0, -1)).rgb + texture(uLow, vUv + t * vec2(1, -1)).rgb;
      o = vec4(texture(uSrc, vUv).rgb + s / 16.0, 1.0); }`, {uSrc: {value: null}, uLow: {value: null}, uTx: {value: new T.Vector2()}, uR: {value: 1}});
  const fin = pass(`in vec2 vUv; uniform sampler2D uScene, uNear, uBloom; uniform float uBloomK, uVig, uGrain, uFrame, uBloomOn; uniform vec2 uRes; uniform vec4 uScr[2]; uniform float uScrK[2]; uniform float uShoulder, uCeil; out vec4 o;
    float h(vec2 p) { p = fract(p * vec2(0.1031, 0.1030) + uFrame * 0.61803399); p += dot(p, p.yx + 33.33); return fract((p.x + p.y) * p.x); }
    void main() { vec3 c = texture(uScene, vUv).rgb; vec4 n = texture(uNear, vUv); c = n.rgb + (1.0 - n.a) * c;
      if (uBloomOn > 0.5) c += uBloomK * texture(uBloom, vUv).rgb;
      vec2 q = vUv - 0.5; q.x *= uRes.x / uRes.y; c *= 1.0 - uVig * smoothstep(0.35, 1.05, length(q));
      /* S0: text-band scrims (DESIGN_final §3.4 "GL scrims under the top band and the dock"): rect x0,y0,x1,y1 in uv (y up), soft 4 % edge */
      float mm = 0.0;
      /* fix3 beauty M2: a rounded, feathered mask (signed distance to a rounded rect in aspect-corrected units), not a
         separable box: full strength from 0.02 inside the rect, falling off over ~0.09 outside, corners rounded by 0.06, so
         the darkening reads as a soft pool behind the text and never as a squared card */
      vec2 asp = vec2(uRes.x / uRes.y, 1.0);
      for (int i = 0; i < 2; i++) { vec4 r = uScr[i];
        vec2 cc = 0.5 * (r.xy + r.zw) * asp, hs = max(0.5 * (r.zw - r.xy) * asp, vec2(0.0)); float rad = min(0.06, min(hs.x, hs.y));
        vec2 qd = abs(vUv * asp - cc) - hs + rad; float sd = length(max(qd, 0.0)) + min(max(qd.x, qd.y), 0.0) - rad;
        float m = 1.0 - smoothstep(-0.02, 0.07, sd);
        c *= 1.0 - uScrK[i] * m; mm = max(mm, uScrK[i] > 0.0 ? m : 0.0); }
      /* phase 1: highlight ceiling under the scrim mask (S0.md §4: "if B7a fails again, a highlight ceiling under the scrim mask,
         not a larger k"): luminance above uCeil/2 is rolled off towards uCeil inside the band, so the band's p95 stays below
         uCeil + grain whatever the composition puts behind the text; faint gas below uCeil/2 is untouched */
      if (uCeil > 0.0 && mm > 0.0) { float L = dot(c, vec3(0.2126, 0.7152, 0.0722)), kn = 0.5 * uCeil;
        if (L > kn) { float Lc = kn + (uCeil - kn) * (1.0 - exp(-(L - kn) / (uCeil - kn))); c *= mix(1.0, Lc / L, mm); } }
      /* S0: soft shoulder above uShoulder instead of a hard clip (the disk and dense filaments blew out to flat white at B7a/B9) */
      vec3 hi = uShoulder + (1.0 - uShoulder) * (1.0 - exp(-(c - uShoulder) / max(1.0 - uShoulder, 1e-3)));
      c = mix(c, hi, step(vec3(uShoulder), c)); c = min(c, vec3(1.0));
      float g = h(gl_FragCoord.xy) - 0.5; c += g * uGrain + (h(gl_FragCoord.yx + 7.0) - 0.5) / 255.0;
      o = vec4(c, 1.0); }`, {uScene: {value: null}, uNear: {value: null}, uBloom: {value: null}, uBloomK: {value: 0.6}, uVig: {value: 0.25}, uGrain: {value: 0.03}, uFrame: {value: 0},
      uBloomOn: {value: 1}, uRes: {value: new T.Vector2(1, 1)},
      uScr: {value: [new T.Vector4(0, 0, 0, 0), new T.Vector4(0, 0, 0, 0)]}, uScrK: {value: [0, 0]}, uShoulder: {value: 0.6}, uCeil: {value: 0.28}});
  const rt = (w, h, type) => new T.WebGLRenderTarget(Math.max(1, w), Math.max(1, h), {type, format: T.RGBAFormat, depthBuffer: false, stencilBuffer: false,
    minFilter: T.LinearFilter, magFilter: T.LinearFilter, generateMipmaps: false});
  let chain = [], type = T.HalfFloatType, size = [0, 0, 0]; const tmps = [];
  /* base: the bloom chain's top level as a fraction of the drawing buffer. The stage passes 0.5 / dpr (S0.md §1, §9: at DPR 2
     bloom + final were 0.34 of the 0.37 ms growth), so the chain is sized in CSS px like the volume: the same cost and the
     same blur radius in CSS px at DPR 1 and 2 (before, a DPR 2 chain was 4x the pixels and its blur half as wide) */
  function resize(w, h, t = type, base = 0.5) {
    if (w === size[0] && h === size[1] && t === type && base === size[2]) return; size = [w, h, base]; type = t; chain.forEach(r => r.dispose()); chain = [];
    let cw = Math.max(1, Math.round(w * base)), ch = Math.max(1, Math.round(h * base)); for (let i = 0; i < 5; i++) { chain.push(rt(cw, ch, type)); cw = Math.max(1, cw >> 1); ch = Math.max(1, ch >> 1); }
  }
  const draw = (r, p, target) => { r.setRenderTarget(target); r.render(p.scene, cam); };
  return {
    compose(r, far, splat, target, bg) { compose.u.uFar.value = far.texture; compose.u.uSplat.value = splat.texture; if (bg) compose.u.uBg.value.fromArray(bg); draw(r, compose, target); },
    bloom(r, scene) {
      bright.u.uSrc.value = scene.texture; bright.u.uOff.value.set(0.25 / chain[0].width, 0.25 / chain[0].height); draw(r, bright, chain[0]);
      for (let i = 1; i < chain.length; i++) { down.u.uSrc.value = chain[i - 1].texture; down.u.uTx.value.set(0.5 / chain[i - 1].width, 0.5 / chain[i - 1].height); draw(r, down, chain[i]); }
      for (let i = chain.length - 2; i >= 0; i--) { up.u.uSrc.value = chain[i].texture; up.u.uLow.value = chain[i + 1].texture; up.u.uTx.value.set(1 / chain[i + 1].width, 1 / chain[i + 1].height);
        /* chain[i] + tent(chain[i+1]) is written to a temp of the same size, which then takes chain[i]'s place */
        draw(r, up, tmp(i)); swap(i); }
      return chain[0];
    },
    final(r, scene, near, bloomRT, {bloom = true, k = 0.6, vig = 0.25, grain = 0.03, frame = 0, w, h, scrims = [], shoulder = 0.6, ceil = 0.28} = {}) {
      for (let i = 0; i < 2; i++) { const sc = scrims[i]; fin.u.uScrK.value[i] = sc ? sc.k : 0; if (sc) fin.u.uScr.value[i].set(sc.x0, sc.y0, sc.x1, sc.y1); }
      fin.u.uShoulder.value = shoulder; fin.u.uCeil.value = ceil;
      fin.u.uScene.value = scene.texture; fin.u.uNear.value = near.texture; fin.u.uBloom.value = bloomRT ? bloomRT.texture : scene.texture;
      fin.u.uBloomOn.value = bloom && bloomRT ? 1 : 0; fin.u.uBloomK.value = k; fin.u.uVig.value = vig; fin.u.uGrain.value = grain; fin.u.uFrame.value = frame % 64; fin.u.uRes.value.set(w, h);
      draw(r, fin, null); },
    scenes: () => [compose, bright, down, up, fin].map(p => p.scene), cam,
    targets: () => chain.concat(chain.map((c, i) => tmp(i)).slice(0, -1)),
    resize, dispose() { chain.forEach(c => c.dispose()); tmps.forEach(c => c && c.dispose()); tri.dispose(); [compose, bright, down, up, fin].forEach(p => p.mat.dispose()); }};
  function tmp(i) { const c = chain[i]; if (!tmps[i] || tmps[i].width !== c.width || tmps[i].height !== c.height) { tmps[i]?.dispose(); tmps[i] = rt(c.width, c.height, type); } return tmps[i]; }
  function swap(i) { const t = chain[i]; chain[i] = tmps[i]; tmps[i] = t; }
}
