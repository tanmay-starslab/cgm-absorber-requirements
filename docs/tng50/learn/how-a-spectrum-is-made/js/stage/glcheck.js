// WebGL2 capability and software-GL detection for the explainer's 3D stage (C_eng P1-2, DESIGN_final §3.1 D13 "stills").
// probeGL({force3d, benchMs}) -> {webgl2, renderer, vendor, caveat, software, benchMs, tier: "3d" | "stills", reason}
//   1. a WebGL2 context with failIfMajorPerformanceCaveat (null -> retried without; caveat = true);
//   2. the unmasked renderer string: SwiftShader, llvmpipe, softpipe, Microsoft Basic Render, generic "software" -> software;
//   3. a 3-frame micro-benchmark: a 256² fragment loop (~a volume ray's worth of texture-free math), read back each frame.
//   tier is "stills" without WebGL2, with software GL, with a caveat, or when the benchmark exceeds benchMs; ?force3d keeps 3D.
export const SOFTWARE_RE = /swiftshader|llvmpipe|softpipe|basic render|software rasterizer|software adapter|lavapipe/i;
export const BENCH_MS = 40;
export function classify({webgl2, renderer = "", caveat = false, benchMs = NaN, force3d = false, limitMs = BENCH_MS}) {
  const software = SOFTWARE_RE.test(renderer || "");
  let tier = "3d", reason = "";
  if (!webgl2) { tier = "stills"; reason = "no WebGL2"; }
  else if (software) { tier = "stills"; reason = `software renderer (${renderer})`; }
  else if (caveat) { tier = "stills"; reason = "major performance caveat"; }
  else if (benchMs > limitMs) { tier = "stills"; reason = `micro-benchmark ${benchMs.toFixed(1)} ms > ${limitMs} ms`; }
  if (force3d && webgl2 && tier === "stills") { tier = "3d"; reason += " (forced 3D)"; }
  return {software, tier, reason};
}
const BENCH_FS = `#version 300 es
precision highp float; out vec4 o; uniform float uK;
void main() { vec2 p = gl_FragCoord.xy / 256.0; float a = 0.0, t = uK;
  for (int i = 0; i < 160; i++) { t += 0.013; a += sin(p.x * 13.0 + t) * cos(p.y * 7.0 - t) * exp(-0.01 * float(i)); }
  o = vec4(a * 0.01, p, 1.0); }`;
const BENCH_VS = `#version 300 es
in vec2 q; void main() { gl_Position = vec4(q, 0.0, 1.0); }`;
export function microBench(gl, frames = 3) {
  const sh = (t, s) => { const x = gl.createShader(t); gl.shaderSource(x, s); gl.compileShader(x); return x; };
  const pr = gl.createProgram(); gl.attachShader(pr, sh(gl.VERTEX_SHADER, BENCH_VS)); gl.attachShader(pr, sh(gl.FRAGMENT_SHADER, BENCH_FS)); gl.linkProgram(pr);
  if (!gl.getProgramParameter(pr, gl.LINK_STATUS)) return NaN;
  const b = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, b); gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
  gl.useProgram(pr); const loc = gl.getAttribLocation(pr, "q"); gl.enableVertexAttribArray(loc); gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
  gl.viewport(0, 0, 256, 256); const px = new Uint8Array(4), ts = [];
  for (let f = 0; f <= frames; f++) { const t0 = performance.now(); gl.uniform1f(gl.getUniformLocation(pr, "uK"), f); gl.drawArrays(gl.TRIANGLES, 0, 3);
    gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px); if (f) ts.push(performance.now() - t0); }   // frame 0: warm-up (compile)
  gl.deleteProgram(pr); gl.deleteBuffer(b);
  ts.sort((a, c) => a - c); return ts[ts.length >> 1];
}
export function probeGL({force3d = false, limitMs = BENCH_MS, doc = globalThis.document} = {}) {
  const cv = doc?.createElement?.("canvas"); if (!cv) return {webgl2: false, ...classify({webgl2: false})};
  cv.width = cv.height = 256;
  let gl = cv.getContext("webgl2", {failIfMajorPerformanceCaveat: true, antialias: false}), caveat = false;
  if (!gl) { const c2 = doc.createElement("canvas"); c2.width = c2.height = 256; gl = c2.getContext("webgl2", {antialias: false}); caveat = !!gl; }
  if (!gl) return {webgl2: false, renderer: "", vendor: "", caveat: false, benchMs: NaN, ...classify({webgl2: false, force3d})};
  const dbg = gl.getExtension("WEBGL_debug_renderer_info");
  const renderer = dbg ? gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER), vendor = dbg ? gl.getParameter(dbg.UNMASKED_VENDOR_WEBGL) : gl.getParameter(gl.VENDOR);
  const benchMs = microBench(gl);
  gl.getExtension("WEBGL_lose_context")?.loseContext();
  return {webgl2: true, renderer, vendor, caveat, benchMs, ...classify({webgl2: true, renderer, caveat, benchMs, force3d, limitMs})};
}
