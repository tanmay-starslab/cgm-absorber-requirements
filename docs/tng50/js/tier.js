// Device tier (perf R5). The page head (_template.html #tier-gate) sets html[data-tier] = low | mid | high from cheap
// signals before first paint; tierReady() refines it once per session, after first paint and when idle, with the
// explainer's WebGL check (learn/.../js/stage/glcheck.js: software-GL renderer regex, failIfMajorPerformanceCaveat, a
// micro-benchmark). Unlike its probeGL(), the benchmark runs only on a hardware renderer without a caveat: on software GL
// its shader alone takes seconds (31 s measured on a loaded node), and the renderer string already says "stills".
// The check runs in a worker on an OffscreenCanvas where it can (js/tier_worker.js). It is skipped when the tier is
// forced (?tier=), already low, already probed this session, or the page has no gate.
export const tier = () => document.documentElement.dataset.tier || null;
export function probe({SOFTWARE_RE, classify, microBench}, doc = document) {
  const mk = () => { const c = doc.createElement("canvas"); c.width = c.height = 256; return c; };
  let gl = mk().getContext("webgl2", {failIfMajorPerformanceCaveat: true, antialias: false}), caveat = false;
  if (!gl) { gl = mk().getContext("webgl2", {antialias: false}); caveat = !!gl; }
  if (!gl) return {stills: true, renderer: "", why: "no WebGL2"};
  const dbg = gl.getExtension("WEBGL_debug_renderer_info"), renderer = String(gl.getParameter(dbg ? dbg.UNMASKED_RENDERER_WEBGL : gl.RENDERER) || "");
  const benchMs = SOFTWARE_RE.test(renderer) || caveat ? NaN : microBench(gl);
  gl.getExtension("WEBGL_lose_context")?.loseContext();
  const c = classify({webgl2: true, renderer, caveat, benchMs});
  return {stills: c.tier === "stills", renderer, why: c.reason};
}
/* in a module worker (js/tier_worker.js) when it can make a WebGL2 context, else here; a GPU that cannot even answer the
   check within 10 s is taken as stills */
function probeOff() {
  return new Promise(res => { let w, t;
    const done = v => { clearTimeout(t); try { w && w.terminate(); } catch { /* gone */ } res(v); };
    try { w = new Worker(new URL("./tier_worker.js", import.meta.url), {type: "module"}); } catch { res({fallback: true}); return; }
    t = setTimeout(() => done({stills: true, renderer: "", why: "WebGL check over 10 s"}), 10000);
    w.onmessage = e => done(e.data); w.onerror = () => done({fallback: true}); });
}
let P = null;
export function tierReady() {
  const T = window.tngTier;
  if (!T || T.forced || T.gl || tier() === "low") return Promise.resolve(tier());
  const idle = f => (window.requestIdleCallback ? requestIdleCallback(f, {timeout: 3000}) : setTimeout(f, 200));
  return P ||= new Promise(r => requestAnimationFrame(() => idle(r))).then(probeOff)
    .then(async r => { if (r && r.fallback) r = probe(await import("../learn/how-a-spectrum-is-made/js/stage/glcheck.js"));
      return T.probed(r); })
    .catch(() => tier());
}
