// Explorer parity of raymarch.js after the explainer's story variant was added (U_stage; DESIGN_final §5.2 acceptance,
// C_eng P0-2). Node part (always): the explorer's VERT, FRAG and makeMaterial are byte-identical to the reference commit
// (default f27c6a6, the v1 head; override with RAYMARCH_REF=<commit>), the explorer material carries no STORY define, and
// FRAG_STORY = FRAG's helper prefix + one story main() under #ifdef STORY whose capF matches js/stage/tube.js CAPSULE_GLSL.
// Browser part (TNG_BROWSER=1): one pixel check: the reference and the current makeMaterial render the same synthetic cube
// from the same camera in one page, and the two frames are identical byte for byte.
//   node tests/js/raymarch_parity.mjs            TNG_BROWSER=1 node tests/js/raymarch_parity.mjs [--edge <binary>]
import {execFileSync} from "node:child_process";
import {mkdtempSync, writeFileSync, rmSync, readFileSync} from "node:fs";
import {join, dirname, resolve} from "node:path";
import {tmpdir} from "node:os";
import {fileURLToPath, pathToFileURL} from "node:url";
import {createServer} from "node:http";

const HERE = dirname(fileURLToPath(import.meta.url)), ROOT = resolve(HERE, "../.."), REF = process.env.RAYMARCH_REF || "f27c6a6";
let fails = 0; const check = (ok, msg) => { console.log(`${ok ? "ok  " : "FAIL"} ${msg}`); if (!ok) fails++; };
const tmp = mkdtempSync(join(tmpdir(), "rmparity-"));
let refSrc = null;
try { refSrc = execFileSync("git", ["-C", ROOT, "show", `${REF}:docs/tng50/js/raymarch.js`], {encoding: "utf8"}); }
catch (x) { console.log(`skipped: reference ${REF} not available (${x.message.split("\n")[0]})`); process.exit(0); }
writeFileSync(join(tmp, "raymarch_ref.mjs"), refSrc);
const ref = await import(pathToFileURL(join(tmp, "raymarch_ref.mjs")).href);
const cur = await import(pathToFileURL(join(ROOT, "docs/tng50/js/raymarch.js")).href);
const tube = await import(pathToFileURL(join(ROOT, "docs/tng50/learn/how-a-spectrum-is-made/js/stage/tube.js")).href);

check(cur.VERT === ref.VERT, "explorer VERT byte-identical to " + REF);
check(cur.FRAG === ref.FRAG, `explorer FRAG byte-identical to ${REF} (${cur.FRAG.length} chars)`);
check(cur.makeMaterial.toString() === ref.makeMaterial.toString(), "explorer makeMaterial source identical");
/* the material the explorer builds: a stub THREE that records the ShaderMaterial parameters */
const stubT = () => { const rec = {}; class Tex { constructor() { this.image = {data: arguments[0]}; } }
  return {rec, T: {Data3DTexture: Tex, DataTexture: Tex, RedFormat: 1, RGBAFormat: 2, UnsignedByteType: 3, LinearFilter: 4, GLSL3: "300 es", BackSide: 1, CustomBlending: 5, AddEquation: 6,
    SrcAlphaFactor: 7, OneMinusSrcAlphaFactor: 8, OneFactor: 9, ZeroFactor: 10, ConstantAlphaFactor: 11, OneMinusConstantAlphaFactor: 12,
    Vector2: class { constructor(a, b) { this.x = a; this.y = b; } }, Vector3: class { constructor(a, b, c) { this.x = a; this.y = b; this.z = c; } },
    Vector4: class { constructor(a, b, c, d) { Object.assign(this, {x: a, y: b, z: c, w: d}); } },
    ShaderMaterial: class { constructor(p) { Object.assign(this, p); rec.last = p; } dispose() {} }}}; };
{ const a = stubT(), b = stubT(); ref.makeMaterial(a.T); cur.makeMaterial(b.T);
  check(a.rec.last.fragmentShader === b.rec.last.fragmentShader && a.rec.last.vertexShader === b.rec.last.vertexShader, "explorer ShaderMaterial shader strings identical");
  check(!b.rec.last.defines, "explorer ShaderMaterial has no defines (no STORY)");
  check(JSON.stringify(Object.keys(a.rec.last.uniforms)) === JSON.stringify(Object.keys(b.rec.last.uniforms)), "explorer uniform set identical"); }
/* story variant */
const pre = cur.FRAG.slice(0, cur.FRAG.indexOf("void main()"));
check(cur.FRAG_STORY.startsWith(pre), "FRAG_STORY reuses FRAG's helper prefix verbatim");
check((cur.FRAG_STORY.match(/void main\(\)/g) || []).length === 1, "FRAG_STORY has exactly one main()");
check(/#ifdef STORY[\s\S]*#endif\s*$/.test(cur.FRAG_STORY.slice(pre.length)), "story main is gated by #ifdef STORY");
check(!/starAt|starVal|lupton\(/.test(cur.FRAG_STORY.slice(pre.length)), "story main never samples stars (no star branches)");
const body = s => { const i = s.indexOf("float capF(vec3 p)"), k = s.indexOf("\n", s.indexOf("abs(l - lc)))", i)), j = k < 0 ? s.length : k; return s.slice(i, j).replace(/\s+/g, " ").trim(); };
check(body(cur.FRAG_STORY) === body(tube.CAPSULE_GLSL) && body(cur.FRAG_STORY).length > 100, "capF identical in the volume (raymarch.js) and the splats (tube.js)");
{ const s = stubT(); const m = cur.makeStoryMaterial(s.T); check(m.material.defines?.STORY === 1 && m.material.fragmentShader === cur.FRAG_STORY, "makeStoryMaterial compiles FRAG_STORY with STORY defined");
  check(["uSeg", "uRayO", "uRayN", "uCap", "uFog", "uFocus", "uFocusDim", "uVelRest", "uKnee"].every(k => k in m.uniforms) && m.uniforms.uFocus.value.w === 0 && m.uniforms.uFocusDim.value === 1
    && m.uniforms.uVelRest.value.x === 1 && m.uniforms.uKnee.value.x === 0.6 && m.uniforms.uKnee.value.y === 1 && Object.keys(stubT().T) && Object.keys(m.uniforms).length === Object.keys(s.rec.last.uniforms).length, "story uniforms = explorer uniforms + uSeg, uRayO, uRayN, uCap, uFog, uFocus, uFocusDim, uVelRest, uKnee (focus and rest-dim off by default, knee 0.6..1)"); }

/* ---- browser pixel check ---- */
if (process.env.TNG_BROWSER) {
  const {launch} = await import(pathToFileURL(join(HERE, "lib/browser.mjs")).href);
  const A = Object.fromEntries(process.argv.slice(2).reduce((acc, x, i, all) => (x.startsWith("--") ? acc.concat([[x.slice(2), all[i + 1]]]) : acc), []));
  const page = `<!doctype html><meta charset="utf-8"><canvas id="c" width="256" height="256"></canvas>
<script type="importmap">{"imports":{"three":"https://cdn.jsdelivr.net/npm/three@0.169.0/build/three.module.min.js"}}</script>
<script type="module">
import * as T from "three"; import * as R from "/ref.mjs"; import * as C from "/cur.mjs";
T.ColorManagement.enabled = false;
const r = new T.WebGLRenderer({canvas: document.getElementById("c"), antialias: false, preserveDrawingBuffer: true}); r.setPixelRatio(1); r.setSize(256, 256, false);
const n = 32, q = new Uint8Array(n * n * n); for (let z = 0; z < n; z++) for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) { const d = Math.hypot(x - 16, y - 13, z - 18); q[(z * n + y) * n + x] = d < 12 ? 1 + Math.round(253 * (1 - d / 12)) : 0; }
const tex = new T.Data3DTexture(q, n, n, n); tex.format = T.RedFormat; tex.minFilter = tex.magFilter = T.LinearFilter; tex.unpackAlignment = 1; tex.needsUpdate = true;
const lut = new Uint8Array(1024); for (let i = 0; i < 256; i++) lut.set([i, 255 - i, (i * 3) & 255, 255], 4 * i);
const cam = new T.PerspectiveCamera(30, 1, 0.1, 5000); cam.position.set(300, -700, 400); cam.lookAt(0, 0, 0); cam.updateMatrixWorld(true);
function frame(M) { const m = M.makeMaterial(T, {n}), U = m.uniforms; U.uGas0.value = tex; U.uGasHave.value.set(1, 0, 0); U.uGasRange.value.set(-3, 1); U.uN.value = n;
  U.uMode.value = 1; U.uWin.value.set(-2, 1); m.lutTex.image.data.set(lut); m.lutTex.needsUpdate = true; U.uCamDisk.value.copy(cam.position); U.uExact.value = 1; U.uSpv.value = 1;
  const s = new T.Scene(), mesh = new T.Mesh(new T.BoxGeometry(800, 800, 800), m.material); mesh.frustumCulled = false; s.add(mesh);
  r.setClearColor(0x000000, 1); r.clear(); r.render(s, cam); const px = new Uint8Array(256 * 256 * 4); const g = r.getContext(); g.readPixels(0, 0, 256, 256, g.RGBA, g.UNSIGNED_BYTE, px); return px; }
const a = frame(R), b = frame(C); let diff = 0, lit = 0; for (let i = 0; i < a.length; i++) { if (a[i] !== b[i]) diff++; if (i % 4 === 0 && a[i] + a[i + 1] + a[i + 2] > 30) lit++; }
window.__res = {diff, lit};
</script>`;
  const srv = createServer((req, res) => { const u = req.url.split("?")[0];
    const body = u === "/" ? page : u === "/ref.mjs" ? refSrc : u === "/cur.mjs" ? readFileSync(join(ROOT, "docs/tng50/js/raymarch.js"), "utf8") : null;
    if (body === null) { res.writeHead(404); res.end(); return; } res.writeHead(200, {"Content-Type": u === "/" ? "text/html" : "text/javascript"}); res.end(body); });
  await new Promise(r => srv.listen(0, "127.0.0.1", r));
  const P = await launch({width: 400, height: 400, edge: A.edge});
  await P.goto(`http://127.0.0.1:${srv.address().port}/`);
  const t = await P.waitFor("window.__res", 120000, 200), res = t >= 0 ? await P.eval("window.__res") : null;
  check(!!res && res.lit > 1000, `browser: the synthetic cube renders (${res?.lit} lit px)`);
  check(!!res && res.diff === 0, `browser: reference and current explorer frames identical (${res?.diff} differing bytes)`);
  if (P.exceptions.length) console.log("page exceptions:", P.exceptions.slice(0, 3));
  try { P.proc.kill("SIGKILL"); } catch { /* gone */ } srv.close();
}
rmSync(tmp, {recursive: true, force: true});
console.log(fails ? `${fails} FAILED` : "all passed"); process.exit(fails ? 1 : 0);
