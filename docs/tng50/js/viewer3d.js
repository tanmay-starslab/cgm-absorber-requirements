// 3D gas viewer for the TNG50 page (design-2 §7.3): ray-marched log10 volumes (WebGL2 Data3DTexture), the halo frame
// (box, R200c sphere, disk normal, scale bar, axes), every catalogued sightline as a line, click-to-select.
// three.js is imported lazily inside mount() through the page's importmap, so the pure helpers (loadManifest,
// loadVolume, decodeU8, webgl2Available) also run in node. Scene units: physical kpc, origin = galaxy centre
// (center_kpc), box axes.
import {lut, cssGradient, NAMES as CMAPS} from "./colormaps.js";

export const VOL_KEYS = ["nH", "T", "Z", "OVI", "HI", "CIII"];
const SPECIES_LABEL = {nH: "n_H (hydrogen)", T: "temperature", Z: "metallicity", OVI: "O VI", HI: "H I", CIII: "C III"};

export function webgl2Available() {
  try { const c = document.createElement("canvas"); return !!(globalThis.WebGL2RenderingContext && c.getContext("webgl2")); } catch { return false; }
}
export async function loadManifest(baseUrl = "data/vol/") {
  const r = await fetch(baseUrl + "manifest.json", {cache: "no-cache"});
  if (!r.ok) throw new Error(`volume manifest: HTTP ${r.status}`);
  const m = await r.json();
  if (!m || m.version !== 1 || !m.fields || !m.grids) throw new Error("volume manifest: unexpected format");
  return m;
}
/* gzip (1f 8b) -> DecompressionStream; anything else is taken as already decoded (a server applied Content-Encoding) */
export async function gunzipIfNeeded(buf) {
  const u = new Uint8Array(buf);
  if (!(u.length >= 2 && u[0] === 0x1f && u[1] === 0x8b)) return u;
  if (typeof DecompressionStream === "undefined") throw new Error("this browser cannot decode the volumes");
  const out = await new Response(new Blob([u]).stream().pipeThrough(new DecompressionStream("gzip"))).arrayBuffer();
  return new Uint8Array(out);
}
export async function loadVolume(manifest, key, res = "128", baseUrl = "data/vol/") {
  const f = manifest.fields?.[key], g = manifest.grids?.[res];
  if (!f || !g || !f.files?.[res]) throw new Error(`no ${res}³ volume for ${key}`);
  const r = await fetch(baseUrl + f.files[res]);
  if (!r.ok) throw new Error(`${f.files[res]}: HTTP ${r.status}`);
  const data = await gunzipIfNeeded(await r.arrayBuffer()), n = g.n;
  if (data.length !== n * n * n) throw new Error(`${f.files[res]}: ${data.length} bytes after decoding, expected ${n}³ = ${n * n * n}`);
  return {key, res, n, data};
}
export function decodeU8(q, lo, hi) {
  const out = new Float32Array(q.length), s = (hi - lo) / 254;
  for (let i = 0; i < q.length; i++) out[i] = q[i] === 0 ? NaN : lo + (q[i] - 1) * s;
  return out;
}

const VERT = `out vec3 vPos;
void main() { vPos = position / 800.0; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`;
const FRAG = `precision highp float; precision highp sampler3D;
uniform sampler3D uVol; uniform sampler2D uLut; uniform vec2 uWin; uniform float uOpacity; uniform int uSteps;
uniform vec3 uCamLocal; uniform int uFrame;
in vec3 vPos; out vec4 fragColor;
vec2 slab(vec3 o, vec3 d) { vec3 inv = 1.0 / d, a = (vec3(-0.5) - o) * inv, b = (vec3(0.5) - o) * inv;
  vec3 lo = min(a, b), hi = max(a, b); return vec2(max(max(lo.x, lo.y), lo.z), min(min(hi.x, hi.y), hi.z)); }
float hash(vec2 p, float f) { p = fract(p * vec2(0.1031, 0.1030) + f * 0.61803399); p += dot(p, p.yx + 33.33); return fract((p.x + p.y) * p.x); }
void main() {
  vec3 d = normalize(vPos - uCamLocal); vec2 tb = slab(uCamLocal, d);
  float t0 = max(tb.x, 0.0), t1 = tb.y; if (t1 <= t0) discard;
  float dt = 1.732 / float(uSteps), t = t0 + dt * hash(gl_FragCoord.xy, float(uFrame)), span = max(uWin.y - uWin.x, 1e-6);
  vec3 C = vec3(0.0); float A = 0.0;
  for (int i = 0; i < 4096; i++) {
    if (i > uSteps + 2 || t > t1) break;
    float q = texture(uVol, uCamLocal + d * t + 0.5).r * 255.0;
    if (q >= 0.5) {
      float w = clamp(((q - 1.0) / 254.0 - uWin.x) / span, 0.0, 1.0);
      if (w > 0.0) {
        vec3 c = texture(uLut, vec2(w, 0.5)).rgb;
        float a = 1.0 - pow(max(1.0 - uOpacity * w * w, 0.0), dt * 256.0);
        C += (1.0 - A) * a * c; A += (1.0 - A) * a;
        if (A > 0.98) break;
      }
    }
    t += dt;
  }
  fragColor = vec4(C, A);
}`;

const CSS = `.v3d{display:flex;flex-direction:column;gap:0}
.v3d-stage{position:relative;height:min(72vh,620px);touch-action:none;color-scheme:dark;
  --panel:#0c1016;--ink:#e9eef4;--ink2:#a9b3bf;--rule:#2f3844;--accent:#6da7ec;--fit:#f39a5c;--bad:#ef6b6b;--lib-line:#7d8796;background:var(--panel);color:var(--ink)}
.v3d-stage canvas{display:block;width:100%;height:100%;outline:none}
.v3d-stage canvas:focus-visible{outline:2px solid var(--accent);outline-offset:-2px}
.v3d-msg{position:absolute;left:12px;top:10px;right:12px;font-size:13px;color:var(--ink2);pointer-events:none;overflow-wrap:anywhere}
.v3d-msg.bad{color:var(--bad)}
.v3d-leg{position:absolute;left:12px;bottom:10px;width:min(260px,60%);font:11px var(--mono);color:var(--ink2);background:color-mix(in srgb,var(--panel) 82%,transparent);border-radius:6px;padding:4px 6px;pointer-events:none}
.v3d-leg .bar{height:10px;border-radius:2px;border:1px solid var(--rule)}
.v3d-leg .ticks{position:relative;height:14px}.v3d-leg .ticks span{position:absolute;transform:translateX(-50%);top:1px}
.v3d-leg .ttl{font:500 11.5px var(--body);color:var(--ink);margin-bottom:2px}
.v3d-lines{position:absolute;right:10px;bottom:10px;display:flex;flex-direction:column;gap:2px;font-size:11.5px;color:var(--ink2);background:color-mix(in srgb,var(--panel) 82%,transparent);border-radius:6px;padding:4px 7px;pointer-events:none}
.v3d-lines i{display:inline-block;width:20px;height:0;border-top:2px solid;vertical-align:middle;margin-right:5px}
.v3d-lines i.sel{border-top-width:5px;outline:1px dashed var(--ink);outline-offset:2px}
.v3d-scale{position:absolute;right:12px;top:10px;font:11px var(--mono);color:var(--ink2);text-align:center;pointer-events:none}
.v3d-scale i{display:block;height:6px;border:1.5px solid var(--ink2);border-top:0;margin-bottom:2px}
.v3d-ctl{border-top:1px solid var(--rule);padding:10px 14px;display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:8px 16px}
.v3d-ctl .presets{display:flex;flex-wrap:wrap;gap:6px;grid-column:1/-1}
@media (max-width:720px){.v3d-stage{height:min(70vh,100vw)}.v3d-lines{display:none}}`;

/* text sprite for in-scene labels */
function textSprite(T, text, color, h = 26) {
  const c = document.createElement("canvas"), g = c.getContext("2d"), px = 48;
  g.font = `600 ${px}px IBM Plex Sans, Helvetica, Arial, sans-serif`; const w = Math.ceil(g.measureText(text).width) + 12;
  c.width = w; c.height = px + 16; g.font = `600 ${px}px IBM Plex Sans, Helvetica, Arial, sans-serif`; g.fillStyle = color; g.textBaseline = "middle"; g.fillText(text, 6, c.height / 2);
  const tex = new T.CanvasTexture(c); tex.minFilter = T.LinearFilter;
  const s = new T.Sprite(new T.SpriteMaterial({map: tex, transparent: true, depthTest: false}));
  s.scale.set(h * c.width / c.height, h, 1); s.renderOrder = 20; return s;
}
const pretty = u => String(u || "").replace("cm^-3", "cm⁻³").replace("Zsun", "Z☉");
const isMobile = () => matchMedia("(max-width: 720px)").matches;
const reduced = () => matchMedia("(prefers-reduced-motion: reduce)").matches;

function stub(root, msg, frame) {
  const p = document.createElement("p"); p.className = "msg bad v3d-fallback"; p.style.padding = "18px 14px"; p.textContent = msg; root.appendChild(p);
  const no = () => {};
  return {webgl2: false, message: msg, frame, hooks: {}, setSpecies: async () => false, setPreset: () => false, setTransfer: no, toggleDense: () => false, setLines: no, select: no,
    refreshLines: no, resize: no, render: no, dispose: () => p.remove()};
}

export async function mount(root, app, opts = {}) {
  if (!document.getElementById("v3d-css")) { const st = document.createElement("style"); st.id = "v3d-css"; st.textContent = CSS; document.head.appendChild(st); }
  const cfg = app.config || {}, G = cfg.galaxy || {}, F0 = cfg.frame || {};
  let manifest = opts.manifest || null, volErr = null;
  const volBase = opts.volBase === undefined ? (cfg.vol_url || "data/vol/") : opts.volBase;
  const frame = {Lhat: F0.Lhat || G.Lhat, xhat: F0.xhat || G.xhat, yhat: F0.yhat || G.yhat, R200c: F0.R200c_kpc || G.R200c_kpc || 246.35};
  if (!(opts.webgl2 ?? webgl2Available()))
    return stub(root, "3D view needs WebGL2, which this browser does not provide. The Spectra tab and the numeric ray form below still work.", frame);
  let T, OrbitControls;
  try { T = await import("three"); ({OrbitControls} = await import("three/addons/controls/OrbitControls.js")); }
  catch (x) { return stub(root, `Could not load three.js ${cfg.three || ""} from cdn.jsdelivr.net (${x.message}). The Spectra tab and the numeric ray form below still work.`, frame); }
  if (volBase && !manifest) { try { manifest = await loadManifest(volBase); } catch (x) { volErr = x.message; } }
  if (manifest?.galaxy) for (const k of ["Lhat", "xhat", "yhat"]) if (manifest.galaxy[k]) frame[k] = manifest.galaxy[k];
  if (manifest?.galaxy?.R200c_kpc) frame.R200c = manifest.galaxy.R200c_kpc;
  frame.Lhat ||= [0, 0, 1]; frame.xhat ||= [1, 0, 0]; frame.yhat ||= [0, 1, 0];
  const V3 = a => new T.Vector3(a[0], a[1], a[2]);
  let stageEl = null;   // the stage keeps a dark backdrop in both page themes (volumes read best on dark); colours come from its tokens
  const css = n => getComputedStyle(stageEl || document.documentElement).getPropertyValue(n).trim() || "#888";
  T.ColorManagement.enabled = false;                       // LUT and CSS colours are sRGB values: pass them straight through

  /* ---- DOM ---- */
  const el = document.createElement("div"); el.className = "v3d";
  el.innerHTML = `<div class="v3d-stage"><canvas tabindex="0" role="img" aria-label="3D view"></canvas><div class="v3d-msg" aria-live="polite"></div><div class="v3d-scale" aria-hidden="true"><i></i><span>100 kpc</span></div>
    <div class="v3d-leg" hidden><div class="ttl"></div><div class="bar"></div><div class="ticks"></div></div>
    <div class="v3d-lines" aria-hidden="true"><span><i style="border-color:var(--lib-line)"></i>library</span><span><i style="border-color:var(--accent)"></i>generated</span><span><i style="border-color:var(--fit)"></i>custom</span><span><i class="sel" style="border-color:var(--ink)"></i>selected (thick)</span></div></div>
    <div class="v3d-ctl" role="group" aria-label="3D view settings">
      <div class="ctl"><label for="v3-species">gas field</label><select id="v3-species"></select></div>
      <div class="ctl"><div class="row"><label for="v3-lo">window low</label><output id="v3-lo-o" for="v3-lo"></output></div><input id="v3-lo" type="range" step="0.1"></div>
      <div class="ctl"><div class="row"><label for="v3-hi">window high</label><output id="v3-hi-o" for="v3-hi"></output></div><input id="v3-hi" type="range" step="0.1"></div>
      <div class="ctl"><div class="row"><label for="v3-op">opacity</label><output id="v3-op-o" for="v3-op"></output></div><input id="v3-op" type="range" min="0" max="1" step="0.005"></div>
      <div class="ctl"><label for="v3-cmap">colour map</label><select id="v3-cmap"></select></div>
      <div class="ctl"><label for="v3-lines">sightlines</label><select id="v3-lines"><option value="all">all</option><option value="showcase">showcase ★/☆ + new</option><option value="none">none</option></select></div>
      <div class="presets"><button type="button" class="btn" data-p="face-on">Face-on</button><button type="button" class="btn" data-p="edge-on">Edge-on</button>
        <button type="button" class="btn" data-p="sightline">Along selected</button><button type="button" class="btn" data-p="reset">Reset</button>
        <button type="button" class="btn" id="v3-dense" aria-pressed="false" title="Show only the densest/highest values of this field (the top 1 dex), more opaque: brings out the disc">Dense gas</button>
        <button type="button" class="btn" id="v3-hd" aria-pressed="false" title="256³ volumes (larger download)">HD 256³</button>
        <label class="hint"><input type="checkbox" id="v3-r200" checked> R<sub>200c</sub> sphere</label></div>
    </div>`;
  root.appendChild(el);
  const q = s => el.querySelector(s), canvas = q("canvas"), stage = q(".v3d-stage"), msgEl = q(".v3d-msg"); stageEl = stage;
  /* stage message; `transient` ones (a hint about the current selection or preset) are cleared by the next selection or preset */
  const say = (t, bad, transient = false) => { msgEl.textContent = t || ""; msgEl.className = "v3d-msg" + (bad ? " bad" : ""); msgEl.dataset.transient = t && transient ? "1" : ""; };
  const clearTransient = () => { if (msgEl.dataset.transient) say(""); };
  const NO_ENDPOINTS = id => `${id} has no stored endpoints, so it cannot be drawn in 3D.`;

  /* ---- renderer, camera, controls ---- */
  const renderer = new T.WebGLRenderer({canvas, antialias: true, alpha: false, powerPreference: "high-performance"});
  renderer.outputColorSpace = T.LinearSRGBColorSpace;
  renderer.setPixelRatio(Math.min(devicePixelRatio || 1, 1.5));
  const scene = new T.Scene(), camera = new T.PerspectiveCamera(40, 1, 1, 10000);
  const controls = new OrbitControls(camera, canvas); controls.enableDamping = false; controls.minDistance = 40; controls.maxDistance = 5000;
  controls.zoomSpeed = 1.2; controls.keys = {};

  /* ---- volume mesh ---- */
  const empty = new T.Data3DTexture(new Uint8Array(1), 1, 1, 1); empty.format = T.RedFormat; empty.needsUpdate = true;
  const lutTex = new T.DataTexture(lut("viridis"), 256, 1, T.RGBAFormat, T.UnsignedByteType);
  lutTex.minFilter = lutTex.magFilter = T.LinearFilter; lutTex.needsUpdate = true;
  const steps = opts.steps || (isMobile() ? 192 : 384);
  const mat = new T.ShaderMaterial({glslVersion: T.GLSL3, vertexShader: VERT, fragmentShader: FRAG, side: T.BackSide, transparent: true, depthWrite: false,
    blending: T.CustomBlending, blendSrc: T.OneFactor, blendDst: T.OneMinusSrcAlphaFactor, blendSrcAlpha: T.OneFactor, blendDstAlpha: T.OneMinusSrcAlphaFactor,
    uniforms: {uVol: {value: empty}, uLut: {value: lutTex}, uWin: {value: new T.Vector2(0, 1)}, uOpacity: {value: 0.3}, uSteps: {value: steps},
      uCamLocal: {value: new T.Vector3()}, uFrame: {value: 0}}});
  const volMesh = new T.Mesh(new T.BoxGeometry(800, 800, 800), mat); volMesh.visible = false; volMesh.renderOrder = 1; scene.add(volMesh);

  /* ---- frame helpers ---- */
  const deco = new T.Group(); scene.add(deco);
  const lm = (c, o = 0.6) => new T.LineBasicMaterial({color: c, transparent: true, opacity: o});
  const boxLines = new T.LineSegments(new T.EdgesGeometry(new T.BoxGeometry(800, 800, 800)), lm(0x888888, 0.5)); deco.add(boxLines);
  const Lv = V3(frame.Lhat).normalize(), Xv = V3(frame.xhat).normalize(), Yv = V3(frame.yhat).normalize();
  const sph = []; const R2 = frame.R200c;
  for (let k = 0; k < 6; k++) { const ph = k / 6 * Math.PI; for (let i = 0; i < 64; i++) for (const j of [i, i + 1]) { const t = j / 64 * 2 * Math.PI;   // meridians
    sph.push(new T.Vector3().addScaledVector(Lv, R2 * Math.cos(t)).addScaledVector(Xv, R2 * Math.sin(t) * Math.cos(ph)).addScaledVector(Yv, R2 * Math.sin(t) * Math.sin(ph))); } }
  for (const lat of [-60, -30, 0, 30, 60]) { const z = Math.sin(lat * Math.PI / 180), rr = Math.cos(lat * Math.PI / 180);
    for (let i = 0; i < 64; i++) for (const j of [i, i + 1]) { const t = j / 64 * 2 * Math.PI;
      sph.push(new T.Vector3().addScaledVector(Lv, R2 * z).addScaledVector(Xv, R2 * rr * Math.cos(t)).addScaledVector(Yv, R2 * rr * Math.sin(t))); } }
  const sphere = new T.LineSegments(new T.BufferGeometry().setFromPoints(sph), lm(0x888888, 0.4)); deco.add(sphere);
  const disk = []; for (let i = 0; i < 96; i++) for (const j of [i, i + 1]) { const t = j / 96 * 2 * Math.PI; disk.push(new T.Vector3().addScaledVector(Xv, 30 * Math.cos(t)).addScaledVector(Yv, 30 * Math.sin(t))); }
  const diskRing = new T.LineSegments(new T.BufferGeometry().setFromPoints(disk), lm(0x888888, 0.7)); deco.add(diskRing);
  const arrow = new T.ArrowHelper(Lv, new T.Vector3(), 150, 0xd4572a, 22, 11); deco.add(arrow);
  const triad = new T.Group(); triad.position.set(-400, -400, -400); deco.add(triad);
  const axCols = [0xc0392b, 0x2e8b57, 0x2c6fbb];
  ["x", "y", "z"].forEach((a, i) => { const d = [0, 0, 0]; d[i] = 90; triad.add(new T.LineSegments(new T.BufferGeometry().setFromPoints([V3([0, 0, 0]), V3(d)]), lm(axCols[i], 0.95))); });
  let labels = [];
  for (const o of [boxLines, sphere, diskRing, ...triad.children, ...arrow.children]) o.renderOrder = 2;   // frame drawn over the gas
  function makeLabels() {
    for (const s of labels) { deco.remove(s); triad.remove(s); s.material.map.dispose(); s.material.dispose(); }
    const ink = css("--ink"), ink2 = css("--ink2"), fit = css("--fit"); labels = [];
    const add = (s, parent, p) => { s.position.copy(p); parent.add(s); labels.push(s); };
    add(textSprite(T, "L", fit, 30), deco, Lv.clone().multiplyScalar(178));
    add(textSprite(T, "R200c", ink2, 20), deco, Xv.clone().multiplyScalar(R2 * 0.72).addScaledVector(Lv, R2 * 0.72));
    ["x", "y", "z"].forEach((a, i) => { const d = [0, 0, 0]; d[i] = 110; add(textSprite(T, a, ink, 24), triad, V3(d)); });
  }

  /* ---- sightlines ---- */
  const lineMat = new T.LineBasicMaterial({vertexColors: true, transparent: true, opacity: 0.28});
  const lines = new T.LineSegments(new T.BufferGeometry(), lineMat); lines.renderOrder = 3; scene.add(lines);
  let LINE_IDS = [], LINE_P = [], linesMode = "all", selId = null, nNoEnds = 0;
  const selGroup = new T.Group(); selGroup.renderOrder = 4; scene.add(selGroup);
  const selMat = new T.MeshBasicMaterial({color: 0x000000, depthTest: false, transparent: true, opacity: 0.95});
  function colorsFor() { return {lib: new T.Color(css("--lib-line")), gen: new T.Color(css("--accent")), cust: new T.Color(css("--fit"))}; }
  const hasEnds = e => !!e && Array.isArray(e.p0) && Array.isArray(e.p1) && e.p0.length === 3 && e.p1.length === 3;
  function refreshLines() {
    const all = app.entries(); nNoEnds = all.filter(e => !hasEnds(e)).length;
    const es = all.filter(hasEnds)
      .filter(e => linesMode === "all" || (linesMode === "showcase" && (e.star || +e.n_showcase_ions >= 1 || e.source === "generated")));
    const pos = new Float32Array(es.length * 6), col = new Float32Array(es.length * 6), C = colorsFor();
    LINE_IDS = []; LINE_P = [];
    es.forEach((e, i) => { pos.set(e.p0, 6 * i); pos.set(e.p1, 6 * i + 3);
      const c = e.orientation === "custom" || e.kind === "endpoints" ? C.cust : e.source === "generated" ? C.gen : C.lib;
      for (const k of [0, 3]) { col[6 * i + k] = c.r; col[6 * i + k + 1] = c.g; col[6 * i + k + 2] = c.b; }
      LINE_IDS.push(e.id); LINE_P.push([e.p0, e.p1]); });
    lines.geometry.dispose(); const g = new T.BufferGeometry();
    g.setAttribute("position", new T.BufferAttribute(pos, 3)); g.setAttribute("color", new T.BufferAttribute(col, 3)); lines.geometry = g;
    lines.visible = linesMode !== "none"; select(selId, true); render();
  }
  function select(id, force) {
    if (id === selId && !force) return; const changed = (id || null) !== selId; selId = id || null;
    for (const c of [...selGroup.children]) { selGroup.remove(c); c.geometry.dispose(); }
    const e = selId && app.entry(selId);
    if (changed) { clearTransient(); if (e && !hasEnds(e)) say(NO_ENDPOINTS(e.id), false, true); }
    if (hasEnds(e)) { const a = V3(e.p0), b = V3(e.p1);
      selGroup.add(new T.Mesh(new T.TubeGeometry(new T.LineCurve3(a, b), 1, 2.5, 12, false), selMat));
      const m0 = new T.Mesh(new T.SphereGeometry(7, 16, 12), selMat), m1 = new T.Mesh(new T.ConeGeometry(7, 20, 16), selMat);
      m0.position.copy(a); const d = b.clone().sub(a).normalize(); m1.position.copy(b); m1.quaternion.setFromUnitVectors(new T.Vector3(0, 1, 0), d);
      selGroup.add(m0, m1); }
    selGroup.children.forEach(c => (c.renderOrder = 4)); aria(); render();
  }

  /* ---- volumes, LRU of 2 textures ---- */
  /* `species`/`res` describe the volume that is bound to the shader (assigned only once its texture is bound); `wanted` is the
     species last asked for, which may still be loading. Legend, window and colour map always follow `species`. */
  const TEX = new Map(); let species = null, res = null, loadTok = 0, wanted = null;
  const hdAuto = !isMobile() && (navigator.deviceMemory ?? 8) >= 4;
  let hd = hdAuto; q("#v3-hd").setAttribute("aria-pressed", String(hd));
  const tf = {};   // per species: {lo, hi, opacity, cmap}
  const stats = {};
  function fieldTf(k) { const f = manifest.fields[k], dw = f.default_window || [f.lo, f.hi];
    return tf[k] ||= {lo: dw[0], hi: dw[1], opacity: 0.05, cmap: f.cmap || "viridis"}; }
  const PEND = new Map();
  function getTex(k, r) {     // one download per volume, even when several callers ask at once
    const key = k + "|" + r; if (TEX.has(key)) { const t = TEX.get(key); TEX.delete(key); TEX.set(key, t); return Promise.resolve(t); }
    if (!PEND.has(key)) PEND.set(key, fetchTex(k, r, key).finally(() => PEND.delete(key)));
    return PEND.get(key);
  }
  async function fetchTex(k, r, key) {
    const t0 = performance.now(), v = await loadVolume(manifest, k, r, volBase);
    const tex = new T.Data3DTexture(v.data, v.n, v.n, v.n);
    tex.format = T.RedFormat; tex.type = T.UnsignedByteType; tex.minFilter = tex.magFilter = T.LinearFilter;
    tex.wrapS = tex.wrapT = tex.wrapR = T.ClampToEdgeWrapping; tex.unpackAlignment = 1; tex.needsUpdate = true;
    const item = {tex, n: v.n, ms: performance.now() - t0}; TEX.set(key, item);
    while (TEX.size > 2) { const [old, o] = TEX.entries().next().value; TEX.delete(old); if (o.tex !== mat.uniforms.uVol.value) o.tex.dispose(); }
    return item;
  }
  const mb = b => (b / 1e6).toFixed(b > 1e7 ? 0 : 1) + " MB";
  const bound = () => (mat.uniforms.uVol.value !== empty && volMesh.visible && species && res ? species + "|" + res : null);
  async function show(k, r) {
    const tok = ++loadTok, f = manifest.fields[k];
    say(`loading ${f.label || k} ${manifest.grids[r].n}³${f.bytes?.[r] ? " · " + mb(f.bytes[r]) : ""}…`);
    let it;
    try { it = await getTex(k, r); }
    catch (x) { if (tok !== loadTok) return false; throw x; }
    if (tok !== loadTok) return false;
    const prev = mat.uniforms.uVol.value; mat.uniforms.uVol.value = it.tex; species = k; res = r; volMesh.visible = true;
    if (prev !== empty && ![...TEX.values()].some(o => o.tex === prev)) prev.dispose();
    q("#v3-species").value = k; syncTfInputs();
    applyTf(); const t0 = performance.now(), gl = renderer.getContext(); draw(); gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array(4));
    stats.firstFrameMs = performance.now() - t0; stats.loadMs = it.ms; stats.res = r; stats.n = it.n;
    say(""); return true;
  }
  async function setSpecies(k) {
    if (!manifest) { say(volErr ? `volumes not published (${volErr})` : "volumes not published", false); return false; }
    if (!manifest.fields[k]) return false;
    if (bound() && species === k) {                      // already shown: cancel any other pending load and say so
      if (wanted !== k) { loadTok++; wanted = k; say(""); } q("#v3-species").value = k; return true; }
    wanted = k; q("#v3-species").value = k; viewer.loadError = null;              // the select shows the request; legend and window stay on `species`
    try { if (!await show(k, "128")) return false; }
    catch (x) { if (wanted === k) { viewer.loadError = {key: k, message: x.message}; wanted = species; q("#v3-species").value = species || k; say(`Could not load ${manifest.fields[k].label || k}: ${String(x.message).replace(/\.?$/, ".")}` +
      (species ? ` Still showing ${manifest.fields[species].label || species}.` : ""), true); } return false; }
    if (hd && manifest.grids["256"] && manifest.fields[k].files?.["256"])          // upgrade in the background
      viewer.upgrading = show(k, "256").catch(x => { say(x.message, true); return false; });
    return true;
  }
  function syncTfInputs() { if (!manifest || !species) return; const f = manifest.fields[species], s = fieldTf(species);
    for (const id of ["#v3-lo", "#v3-hi"]) { const i = q(id); i.min = f.lo; i.max = f.hi; }
    q("#v3-lo").value = s.lo; q("#v3-hi").value = s.hi; q("#v3-op").value = s.opacity; q("#v3-cmap").value = s.cmap;
    q("#v3-lo-o").textContent = (+s.lo).toFixed(1); q("#v3-hi-o").textContent = (+s.hi).toFixed(1); q("#v3-op-o").textContent = (+s.opacity).toFixed(3);
    q("#v3-dense").setAttribute("aria-pressed", String(isDense())); }
  let lastCmap = "viridis";
  function applyTf() { if (!manifest || !species) return; const f = manifest.fields[species], s = fieldTf(species), span = f.hi - f.lo;
    mat.uniforms.uWin.value.set((s.lo - f.lo) / span, (s.hi - f.lo) / span); mat.uniforms.uOpacity.value = +s.opacity;
    if (s.cmap !== lastCmap) { lutTex.image.data.set(lut(s.cmap)); lutTex.needsUpdate = true; lastCmap = s.cmap; }
    legend(); aria(); render(); }
  function setTransfer(o = {}) { if (!species) return; const s = fieldTf(species), f = manifest.fields[species];
    for (const k of ["lo", "hi", "opacity"]) if (Number.isFinite(+o[k]) && o[k] !== undefined && o[k] !== null) s[k] = +o[k];
    s.lo = Math.min(Math.max(s.lo, f.lo), f.hi); s.hi = Math.min(Math.max(s.hi, f.lo), f.hi); s.opacity = Math.min(Math.max(s.opacity, 0), 1);
    if (o.cmap && CMAPS.includes(o.cmap)) s.cmap = o.cmap; if (s.lo > s.hi) [s.lo, s.hi] = [s.hi, s.lo];
    syncTfInputs(); applyTf(); }
  /* "Dense gas": the top DENSE_DEX of the field's range, opaque, so the disc stands out of the CGM (the default window,
     [p50−1, p99], saturates everything denser than p99 to the same colour); pressing it again restores the default. */
  const DENSE_DEX = 1.0, DENSE_OPACITY = 0.5;
  const denseTf = k => { const f = manifest.fields[k]; return {lo: Math.max(f.lo, +(f.hi - DENSE_DEX).toFixed(1)), hi: f.hi, opacity: DENSE_OPACITY}; };
  const isDense = () => { if (!species) return false; const s = fieldTf(species), d = denseTf(species);
    return Math.abs(s.lo - d.lo) < 1e-6 && Math.abs(s.hi - d.hi) < 1e-6 && Math.abs(s.opacity - d.opacity) < 1e-6; };
  function toggleDense(on = !isDense()) { if (!species) return false; const f = manifest.fields[species], dw = f.default_window || [f.lo, f.hi];
    setTransfer(on ? denseTf(species) : {lo: dw[0], hi: dw[1], opacity: 0.05}); return isDense(); }
  function legend() { const L = q(".v3d-leg"); if (!manifest || !species) { L.hidden = true; return; }
    const f = manifest.fields[species], s = fieldTf(species); L.hidden = false;
    L.querySelector(".ttl").textContent = `log₁₀ ${f.label || species} [${pretty(f.units)}]`;
    L.querySelector(".bar").style.background = cssGradient(s.cmap);
    const tk = L.querySelector(".ticks"); tk.textContent = ""; const span = s.hi - s.lo || 1, st = span > 6 ? 2 : span > 2.5 ? 1 : 0.5;
    for (let v = Math.ceil(s.lo / st) * st; v <= s.hi + 1e-9; v += st) { const sp = document.createElement("span");
      sp.style.left = (100 * (v - s.lo) / span) + "%"; sp.textContent = (v < 0 ? "−" : "") + Math.abs(+v.toFixed(1)); tk.appendChild(sp); } }
  function aria() { const f = manifest && species ? manifest.fields[species] : null, s = f ? fieldTf(species) : null;
    canvas.setAttribute("aria-label", `3D view of the halo gas${f ? `: ${f.label || species}, window ${s.lo.toFixed(1)} to ${s.hi.toFixed(1)} log ${pretty(f.units)}` : ""}` +
      `; ${LINE_IDS.length} sightlines drawn${nNoEnds ? ` (${nNoEnds} more have no stored endpoints)` : ""}${selId ? `; selected ${selId}${hasEnds(app.entry(selId)) ? "" : " (not drawn: no stored endpoints)"}` : ""}. Arrow keys rotate, + and − zoom, F face-on, E edge-on, R reset, P pick a ray.`); }

  /* ---- render on demand ---- */
  let rq = false;
  function render() { if (rq) return; rq = true; requestAnimationFrame(() => { rq = false; draw(); }); }
  function draw() { mat.uniforms.uCamLocal.value.copy(camera.position).divideScalar(800); mat.uniforms.uFrame.value = (mat.uniforms.uFrame.value + 1) % 1024;
    renderer.render(scene, camera); scale(); }
  function scale() {   // 100 kpc at the orbit target's distance, in CSS px
    const d = camera.position.distanceTo(controls.target), px = 100 * stage.clientHeight / (2 * d * Math.tan(camera.fov * Math.PI / 360));
    const sc = q(".v3d-scale"); sc.hidden = !(px > 8 && px < stage.clientWidth * 0.6); sc.querySelector("i").style.width = px.toFixed(1) + "px"; }
  function resize() { const w = stage.clientWidth || 600, h = stage.clientHeight || 400; renderer.setSize(w, h, false); camera.aspect = w / h; camera.updateProjectionMatrix(); render(); }
  const ro = new ResizeObserver(resize); ro.observe(stage);
  controls.addEventListener("change", render);
  function theme() { renderer.setClearColor(new T.Color(css("--panel")), 1); const rule = new T.Color(css("--ink2"));
    for (const o of [boxLines, sphere, diskRing]) o.material.color.copy(rule); arrow.setColor(new T.Color(css("--fit")));
    selMat.color.set(css("--ink")); makeLabels(); refreshLines(); }
  const mo = new MutationObserver(theme); mo.observe(document.documentElement, {attributes: true, attributeFilter: ["data-theme"]});
  const mq = matchMedia("(prefers-color-scheme: dark)"); mq.addEventListener("change", theme);

  /* ---- presets ---- */
  let anim = 0;
  function goTo(pos, target, up) {
    const id = ++anim, p0 = camera.position.clone(), t0 = controls.target.clone(), u0 = camera.up.clone(), start = performance.now(), dur = reduced() ? 0 : 550;
    const step = now => { if (id !== anim) return; const f = dur ? Math.min(1, (now - start) / dur) : 1, e = f < 0.5 ? 2 * f * f : 1 - (-2 * f + 2) ** 2 / 2;
      camera.position.lerpVectors(p0, pos, e); controls.target.lerpVectors(t0, target, e); camera.up.lerpVectors(u0, up, e).normalize();
      camera.lookAt(controls.target); controls.update(); draw(); if (f < 1) requestAnimationFrame(step); };
    requestAnimationFrame(step);
  }
  function setPreset(p) {
    const D = 1400, o = new T.Vector3(); clearTransient(); viewer.presetError = null;
    if (p === "face-on") goTo(Lv.clone().multiplyScalar(D), o, Yv.clone());
    else if (p === "edge-on") goTo(Xv.clone().multiplyScalar(D), o, Lv.clone());
    else if (p === "sightline") { const e = selId && app.entry(selId);
      if (!hasEnds(e)) { viewer.presetError = e ? NO_ENDPOINTS(e.id) : "select a sightline first"; say(viewer.presetError, true, true); return false; }
      const a = V3(e.p0), b = V3(e.p1), n = b.clone().sub(a).normalize(), c = a.clone().addScaledVector(n, -a.dot(n));
      let side = c.length() > 1 ? c.clone().normalize() : Lv.clone().sub(n.clone().multiplyScalar(Lv.dot(n)));
      if (side.length() < 1e-6) side = new T.Vector3(1, 0, 0).cross(n); side.normalize();
      let up = Lv.clone().sub(side.clone().multiplyScalar(Lv.dot(side))); if (up.length() < 1e-6) up = n.clone(); up.normalize();
      goTo(c.clone().addScaledVector(side, D), c, up); }
    else goTo(new T.Vector3(1, 0.8, 0.6).normalize().multiplyScalar(D), o, new T.Vector3(0, 0, 1));
    return true;
  }
  camera.position.copy(new T.Vector3(1, 0.8, 0.6).normalize().multiplyScalar(1400)); camera.up.set(0, 0, 1); camera.lookAt(0, 0, 0); controls.update();

  /* ---- picking a line: nearest within 8 px in screen space ---- */
  const viewer = {webgl2: true, THREE: T, camera, scene, renderer, controls, frame, canvas, el: stage, hooks: {}, picking: false, stats,
    presetError: null, loadError: null, get manifest() { return manifest; }, get species() { return species; }, get res() { return res; }, get wanted() { return wanted; },
    get message() { return msgEl.textContent; }};
  function nearestLine(x, y, maxPx = 8) {
    const r = canvas.getBoundingClientRect(), v = new T.Vector3(); let best = null, bd = maxPx;
    const toS = p => { v.set(p[0], p[1], p[2]).applyMatrix4(camera.matrixWorldInverse); if (v.z > -camera.near) return null;
      v.applyMatrix4(camera.projectionMatrix); return [(v.x + 1) / 2 * r.width, (1 - v.y) / 2 * r.height]; };
    if (!lines.visible) return null;
    LINE_P.forEach(([p0, p1], i) => { const a = toS(p0), b = toS(p1); if (!a || !b) return;
      const dx = b[0] - a[0], dy = b[1] - a[1], L2 = dx * dx + dy * dy, t = L2 ? Math.max(0, Math.min(1, ((x - a[0]) * dx + (y - a[1]) * dy) / L2)) : 0;
      const d = Math.hypot(x - a[0] - t * dx, y - a[1] - t * dy); if (d < bd) { bd = d; best = LINE_IDS[i]; } });
    return best;
  }
  let down = null;
  canvas.addEventListener("pointerdown", ev => { down = {x: ev.clientX, y: ev.clientY, t: performance.now()}; });
  canvas.addEventListener("pointerup", ev => { if (!down || viewer.picking) { down = null; return; }
    const moved = Math.hypot(ev.clientX - down.x, ev.clientY - down.y), dt = performance.now() - down.t; down = null;
    if (moved >= (ev.pointerType === "touch" ? 6 : 5) || dt >= 400) return;
    const r = canvas.getBoundingClientRect(), id = nearestLine(ev.clientX - r.left, ev.clientY - r.top, ev.pointerType === "touch" ? 14 : 8);
    if (id) app.select(id, {source: "3d"}); });

  /* ---- keyboard on the canvas ---- */
  canvas.addEventListener("keydown", ev => {
    const k = ev.key, tgt = controls.target, off = camera.position.clone().sub(tgt), rot = (axis, deg) => { off.applyAxisAngle(axis, deg * Math.PI / 180); camera.position.copy(tgt).add(off); camera.lookAt(tgt); controls.update(); };
    const right = new T.Vector3().crossVectors(off, camera.up).normalize();
    if (k === "ArrowLeft") rot(camera.up, -5); else if (k === "ArrowRight") rot(camera.up, 5);
    else if (k === "ArrowUp") { rot(right, -5); } else if (k === "ArrowDown") rot(right, 5);
    else if (k === "+" || k === "=") { camera.position.copy(tgt).add(off.multiplyScalar(0.87)); controls.update(); }
    else if (k === "-" || k === "_") { camera.position.copy(tgt).add(off.multiplyScalar(1.15)); controls.update(); }
    else if (k === "f" || k === "F") setPreset("face-on"); else if (k === "e" || k === "E") setPreset("edge-on");
    else if (k === "r" || k === "R") setPreset("reset"); else if (k === "a" || k === "A") setPreset("sightline");
    else if (k === "p" || k === "P") viewer.hooks.togglePick?.(); else if (k === "Escape") viewer.hooks.exitPick?.();
    else return;
    ev.preventDefault(); ev.stopPropagation(); render(); });

  /* ---- controls ---- */
  const sp = q("#v3-species");
  for (const k of VOL_KEYS) { const f = manifest?.fields?.[k]; const o = document.createElement("option"); o.value = k;
    o.textContent = f ? `${SPECIES_LABEL[k] || k} · ${pretty(f.units)}` : SPECIES_LABEL[k] || k; o.disabled = !f; sp.appendChild(o); }
  sp.disabled = !manifest; q("#v3-hd").disabled = q("#v3-dense").disabled = !manifest; for (const id of ["#v3-lo", "#v3-hi", "#v3-op", "#v3-cmap"]) q(id).disabled = !manifest;
  for (const c of CMAPS) { const o = document.createElement("option"); o.value = c; o.textContent = c; q("#v3-cmap").appendChild(o); }
  sp.addEventListener("change", () => setSpecies(sp.value));
  q("#v3-lo").addEventListener("input", ev => setTransfer({lo: Math.min(+ev.target.value, fieldTf(species).hi - 0.1)}));
  q("#v3-hi").addEventListener("input", ev => setTransfer({hi: Math.max(+ev.target.value, fieldTf(species).lo + 0.1)}));
  q("#v3-op").addEventListener("input", ev => setTransfer({opacity: +ev.target.value}));
  q("#v3-cmap").addEventListener("change", ev => setTransfer({cmap: ev.target.value}));
  q("#v3-lines").addEventListener("change", ev => setLines(ev.target.value));
  q("#v3-r200").addEventListener("change", ev => { sphere.visible = ev.target.checked; labels[2] && (labels[2].visible = ev.target.checked); render(); });
  q("#v3-dense").addEventListener("click", () => toggleDense());
  q("#v3-hd").addEventListener("click", () => { hd = !hd; q("#v3-hd").setAttribute("aria-pressed", String(hd)); wanted = species;
    if (species) q("#v3-species").value = species;
    if (species) show(species, hd ? "256" : "128").catch(x => say(x.message, true)); });
  el.querySelectorAll(".presets [data-p]").forEach(b => b.addEventListener("click", () => setPreset(b.dataset.p)));
  function setLines(m) { if (!["all", "showcase", "none"].includes(m)) return; linesMode = m; q("#v3-lines").value = m; refreshLines(); }

  const onSel = ev => select(ev.detail?.id), onCat = () => refreshLines();
  addEventListener("tng:select", onSel); addEventListener("tng:catalog", onCat);
  /* benchmark (informational): n frames orbiting, each forced to complete */
  async function bench(n = 60) { const gl = renderer.getContext(), px = new Uint8Array(4), t0 = performance.now();
    for (let i = 0; i < n; i++) { const off = camera.position.clone().sub(controls.target).applyAxisAngle(camera.up, 2 * Math.PI / n);
      camera.position.copy(controls.target).add(off); camera.lookAt(controls.target); draw(); gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px); }
    const ms = (performance.now() - t0) / n; return {ms_per_frame: ms, fps: 1000 / ms, steps, size: [canvas.width, canvas.height]}; }

  Object.assign(viewer, {setSpecies, setPreset, setTransfer, toggleDense, setLines, select: id => select(id), refreshLines, resize, render, bench, nearestLine,
    dispose() { ro.disconnect(); mo.disconnect(); mq.removeEventListener("change", theme); removeEventListener("tng:select", onSel); removeEventListener("tng:catalog", onCat);
      for (const o of TEX.values()) o.tex.dispose(); lutTex.dispose(); controls.dispose(); renderer.dispose(); el.remove(); }});
  theme(); resize(); selId = null; select(app.getState().id, true);
  if (!manifest) say(volErr && !/HTTP 404/.test(volErr) ? `volumes unavailable: ${volErr}` : "Gas volumes are not published for this build: sightlines and ray picking still work.");
  else await setSpecies(opts.species && manifest.fields[opts.species] ? opts.species : manifest.fields.nH ? "nH" : Object.keys(manifest.fields)[0]);
  return viewer;
}
