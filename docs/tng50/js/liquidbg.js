// Liquid metal shader adapted from the owner-supplied LiquidMetalShader component (React/Tailwind/TS original; this is
// a plain-JS, WebGL1 port of its fragment shader). A full-screen quad draws a domain-warped fbm field (hash21 value
// noise, 4 octaves, rotation mat2(0.80,-0.60,0.60,0.80), lacunarity 2.03, two warp passes with a slow drift) and maps
// it black -> base -> metal -> highlight, with a soft reflection band, film grain and a vignette; the pointer pushes the
// field locally (eased). Here the colours are the page theme's (re-coloured live), the contrast is kept low, and a
// "calm" rectangle (the spectra panel) lowers it further so text and spectra stay legible.
//
// GPU budget (the 3D ray-marcher shares the GPU; tablets have lost the WebGL context):
//   - its own small WebGL1 context, created lazily after first paint (idle callback), never before the page is drawn;
//   - drawn at 0.5x CSS pixels (pixel ratio ignored) and upscaled by CSS; at most ~30 frames per second;
//   - paused while the browser tab is hidden, while the canvas is off screen (IntersectionObserver), when the page's
//     showWhen()/pauseWhen() say so (the explorer shows it on the 3D tab, and on Spectra only with SPECTRA_BG), and on
//     request (handle.pause / handle.destroy);
//   - one static frame under prefers-reduced-motion, html.reduced, or the constrained GPU profile (viewer3d.js
//     isMobile(): any device tier below high (js/tier.js), ?gpu=lite); on the low tier no context at all (the CSS gradient);
//   - one static frame when the page's own frames slow down (median rAF interval > 20 ms) or opts.heavy() (the explorer:
//     viewer3d's calibration put the 3D view on its fast path, i.e. its exact moving frame took > 33 ms);
//   - on webglcontextlost the canvas is removed and a static CSS gradient (class lmbg-fallback) takes its place;
//   - ?bg=off creates nothing.
// Debug: window.__liquidBg[name].state() -> {mode, running, paused, fps, frames, theme, w, h, scale}.

import {tier, tierReady} from "./tier.js";

const MAX_FPS = 30, SCALE = 0.5, SPEED = 0.72, STATIC_T = 23.0, SLOW_MS = 20;

/* Theme palettes (linear-ish sRGB 0..1). low = the "black" end, flat = the colour the contrast is pulled towards (the page
   background), amt = how much of the shaded field survives (1 = the original look), calm = amt inside the calm rect. */
const hex = h => [1, 3, 5].map(i => parseInt(h.slice(i, i + 2), 16) / 255);
export const hexRGB = hex;
export const PALETTES = {
  dark: {low: hex("#07080b"), base: hex("#0a0b0e"), metal: hex("#2a2f3a"), high: hex("#aab1bf"), flat: hex("#07090f"),
    amt: 0.62, calm: 0.32, band: 0.05, grain: 0.010, vig: 0.75},
  light: {low: hex("#dde1ea"), base: hex("#e7eaf1"), metal: hex("#cfd5e1"), high: hex("#fbfcff"), flat: hex("#eceff5"),
    amt: 0.75, calm: 0.40, band: 0.06, grain: 0.008, vig: 0.45},
};

const VERT = `attribute vec2 aPos; void main(){ gl_Position = vec4(aPos, 0.0, 1.0); }`;
const FRAG = `precision mediump float;
uniform vec2 uRes; uniform float uTime; uniform vec2 uMouse; uniform float uPush;
uniform vec3 uLow, uBase, uMetal, uHigh, uFlat;
uniform float uAmt, uCalmAmt, uBand, uGrain, uVig;
uniform vec4 uCalm;            // calm rect in canvas px (x0, y0, x1, y1), y up; zero size = none
const float SCALE = 0.92, DIST = 0.6;
const mat2 ROT = mat2(0.80, -0.60, 0.60, 0.80);
float hash21(vec2 p){ p = fract(p * vec2(123.34, 456.21)); p += dot(p, p + 45.32); return fract(p.x * p.y); }
float noise(vec2 p){ vec2 i = floor(p), f = fract(p); vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash21(i), hash21(i + vec2(1.0, 0.0)), u.x), mix(hash21(i + vec2(0.0, 1.0)), hash21(i + vec2(1.0, 1.0)), u.x), u.y); }
float fbm(vec2 p){ float v = 0.0, a = 0.5; for (int i = 0; i < 4; i++){ v += a * noise(p); p = ROT * p * 2.03; a *= 0.5; } return v; }
void main(){
  float m = min(uRes.x, uRes.y);
  vec2 uv = gl_FragCoord.xy / uRes, p = (gl_FragCoord.xy - 0.5 * uRes) / m;
  vec2 d = p - (uMouse - 0.5 * uRes) / m; float fall = exp(-dot(d, d) * 7.0);
  p += d * fall * uPush * 0.35;
  float t = uTime; vec2 drift = vec2(t * 0.045, -t * 0.032);
  vec2 q = p * SCALE * 3.2;
  vec2 w1 = vec2(fbm(q + drift), fbm(q + vec2(5.2, 1.3) - drift));
  vec2 w2 = vec2(fbm(q + DIST * 4.0 * w1 + vec2(1.7, 9.2) + drift * 1.3), fbm(q + DIST * 4.0 * w1 + vec2(8.3, 2.8) - drift * 0.7));
  float f = fbm(q + DIST * 4.0 * w2);
  vec3 col = mix(uLow, uBase, smoothstep(0.18, 0.42, f));
  col = mix(col, uMetal, smoothstep(0.38, 0.64, f) * 0.88);
  col = mix(col, uHigh, smoothstep(0.60, 0.82, f) * 0.94);
  float band = exp(-pow((f - 0.51) / 0.03, 2.0));
  col += (uHigh - col) * band * uBand;
  col += (hash21(gl_FragCoord.xy + fract(t * 7.13) * 91.0) - 0.5) * uGrain;
  float vig = smoothstep(1.15, 0.25, length((uv - 0.5) * vec2(uRes.x / m, uRes.y / m) * 0.9));
  col = mix(uFlat, col, mix(1.0 - uVig, 1.0, vig));
  vec2 c0 = gl_FragCoord.xy - uCalm.xy, c1 = uCalm.zw - gl_FragCoord.xy;
  float feather = 0.06 * m, inside = smoothstep(0.0, feather, min(min(c0.x, c0.y), min(c1.x, c1.y)));
  if (uCalm.z <= uCalm.x) inside = 0.0;
  col = mix(uFlat, col, mix(uAmt, uCalmAmt, inside));
  gl_FragColor = vec4(col, 1.0);
}`;

/* the constrained GPU profile; keep in sync with viewer3d.js isMobile() (not imported: that module pulls in the 3D stack).
   With the page's device tier (html[data-tier], js/tier.js) it is every tier below high; without it the old signals */
export function gpuLite() {
  try { const q = new URLSearchParams(location.search).get("gpu"); if (q === "full") return false; if (q === "lite") return true; } catch { /* no URL */ }
  const t = tier(); if (t) return t !== "high";
  try { if (sessionStorage.getItem("tng50.gpuLite") === "1") return true; } catch { /* private mode */ }
  if (matchMedia("(max-width: 720px)").matches) return true;
  if (matchMedia("(pointer: coarse)").matches && !matchMedia("(any-pointer: fine)").matches) return true;
  if (navigator.userAgentData?.mobile) return true;
  if (/Android|iPhone|iPad|iPod|Mobile|Silk|Kindle/i.test(navigator.userAgent || "")) return true;
  if (/Macintosh/.test(navigator.userAgent || "") && (navigator.maxTouchPoints || 0) > 1) return true;
  if ((navigator.deviceMemory ?? 8) <= 4) return true;
  return false;
}
export const bgOff = () => { try { return new URLSearchParams(location.search).get("bg") === "off"; } catch { return false; } };
const prefersReduced = () => matchMedia("(prefers-reduced-motion: reduce)").matches || document.documentElement.classList.contains("reduced");
const pageTheme = () => { const t = document.documentElement.dataset.theme; return t === "light" || t === "dark" ? t : (matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light"); };

/**
 * Mount the background. opts: {host (element the canvas goes into; default document.body, fixed full screen behind the
 * page), name ("explorer"), theme ("auto" follows the page, or "dark"/"light"), calm (() => Element|null: the region to
 * keep calm), showWhen (() => bool: false hides and stops it), pauseWhen (() => bool: true keeps the frame but stops),
 * both re-checked on every frame, on body[data-tab] and html class/data-theme changes and on kick(); observe (elements
 * whose resizes re-place the calm rect), heavy (() => bool: true holds a static frame), palette (fields overriding the theme's PALETTES entry), before (a child of host to insert the canvas before), className}. Returns a handle
 * {pause(reason), resume(reason), destroy(), state()} or null when switched off.
 */
export function initLiquidBg(opts = {}) {
  if (bgOff()) return null;
  const host = opts.host || document.body, name = opts.name || "explorer", fixed = !opts.host;
  let lite = gpuLite();   // re-read once the device tier is final (start)
  const cv = document.createElement("canvas");
  cv.className = "lmbg" + (opts.className ? " " + opts.className : ""); cv.setAttribute("aria-hidden", "true"); cv.dataset.testid = "liquid-bg";
  if (fixed) Object.assign(cv.style, {position: "fixed", inset: "0", width: "100%", height: "100%", zIndex: "-1"});
  else Object.assign(cv.style, {position: "absolute", inset: "0", width: "100%", height: "100%"});
  Object.assign(cv.style, {pointerEvents: "none", display: "block", opacity: "0", transition: prefersReduced() ? "none" : "opacity .9s ease"});
  const S = {mode: "init", running: false, visible: true, slow: false, slowMs: 0, paused: new Set(), fps: 0, frames: 0, theme: null, w: 0, h: 0, scale: SCALE, lite, lost: false, destroyed: false};
  let gl = null, prog = null, U = {}, raf = 0, last = 0, lastRaf = 0, t = 0, fpsT = 0, fpsN = 0;
  const mouse = {x: 0, y: 0, tx: 0, ty: 0, push: 0, tpush: 0};
  const reg = (window.__liquidBg = window.__liquidBg || {}); reg[name] = {state: () => ({...S, paused: [...S.paused]}), handle: null};

  function fallback() { S.mode = "fallback"; S.running = false; cancelAnimationFrame(raf);
    (fixed ? document.documentElement : host).classList.add("lmbg-fallback"); cv.remove(); }

  function setup() {
    try { gl = cv.getContext("webgl", {alpha: false, antialias: false, depth: false, stencil: false, premultipliedAlpha: false, preserveDrawingBuffer: false, powerPreference: "low-power"}); } catch { gl = null; }
    if (!gl) { fallback(); return false; }
    const sh = (type, src) => { const s = gl.createShader(type); gl.shaderSource(s, src); gl.compileShader(s); if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s)); return s; };
    try { prog = gl.createProgram(); gl.attachShader(prog, sh(gl.VERTEX_SHADER, VERT)); gl.attachShader(prog, sh(gl.FRAGMENT_SHADER, FRAG)); gl.linkProgram(prog);
      if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(prog)); }
    catch (x) { if (!gl.isContextLost()) console.warn("liquid background disabled:", x.message); fallback(); return false; }
    gl.useProgram(prog);
    const b = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, b); gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
    const a = gl.getAttribLocation(prog, "aPos"); gl.enableVertexAttribArray(a); gl.vertexAttribPointer(a, 2, gl.FLOAT, false, 0, 0);
    for (const k of ["uRes", "uTime", "uMouse", "uPush", "uLow", "uBase", "uMetal", "uHigh", "uFlat", "uAmt", "uCalmAmt", "uBand", "uGrain", "uVig", "uCalm"]) U[k] = gl.getUniformLocation(prog, k);
    S.theme = null; applyTheme(); size();
    return true;
  }
  function applyTheme() { const th = opts.theme && opts.theme !== "auto" ? opts.theme : pageTheme(); if (th === S.theme && S.mode !== "init") return; S.theme = th;
    if (!gl) return; const P = {...(PALETTES[th] || PALETTES.dark), ...(opts.palette || {})};
    gl.uniform3fv(U.uLow, P.low); gl.uniform3fv(U.uBase, P.base); gl.uniform3fv(U.uMetal, P.metal); gl.uniform3fv(U.uHigh, P.high); gl.uniform3fv(U.uFlat, P.flat);
    gl.uniform1f(U.uAmt, P.amt); gl.uniform1f(U.uCalmAmt, P.calm); gl.uniform1f(U.uBand, P.band); gl.uniform1f(U.uGrain, P.grain); gl.uniform1f(U.uVig, P.vig); }
  let rect = null;
  function size() { const r = rect = cv.getBoundingClientRect(), w = Math.max(1, Math.round(r.width * SCALE)), h = Math.max(1, Math.round(r.height * SCALE));
    if (w !== cv.width || h !== cv.height) { cv.width = w; cv.height = h; } S.w = w; S.h = h; if (gl) { gl.viewport(0, 0, w, h); gl.uniform2f(U.uRes, w, h); calm(); } }
  function calm() { if (!gl) return; const el = opts.calm && opts.calm(), cr = rect = cv.getBoundingClientRect();
    if (!el || !el.getClientRects().length) { gl.uniform4f(U.uCalm, 0, 0, 0, 0); return; }
    const r = el.getBoundingClientRect(), k = SCALE;
    gl.uniform4f(U.uCalm, (r.left - cr.left) * k, (cr.bottom - r.bottom) * k, (r.right - cr.left) * k, (cr.bottom - r.top) * k); }
  function draw() { if (!gl || gl.isContextLost()) return;
    mouse.x += (mouse.tx - mouse.x) * 0.08; mouse.y += (mouse.ty - mouse.y) * 0.08; mouse.push += (mouse.tpush - mouse.push) * 0.06; mouse.tpush *= 0.96;
    gl.uniform1f(U.uTime, t); gl.uniform2f(U.uMouse, mouse.x, mouse.y); gl.uniform1f(U.uPush, mouse.push);
    gl.drawArrays(gl.TRIANGLES, 0, 3); S.frames++; if (cv.style.opacity !== "1") cv.style.opacity = "1"; }
  /* frame budget: if the page's own frames slow down (median rAF interval over the last 40 frames > SLOW_MS: the 3D
     ray-marcher or anything else is busy) or the host reports a heavy view (opts.heavy(): the explorer passes the 3D
     view's measured frame time), the background drops to a static frame, so it never competes. Re-armed on a tab change. */
  const iv = [];
  const animated = () => !lite && !prefersReduced() && !S.slow && !(opts.heavy && opts.heavy());
  const shown = () => !opts.showWhen || !!opts.showWhen();
  const shouldPause = () => { if (document.hidden) S.paused.add("hidden"); else S.paused.delete("hidden");
    if ((opts.pauseWhen && opts.pauseWhen()) || !shown()) S.paused.add("host"); else S.paused.delete("host");
    return S.paused.size > 0; };
  function vis() { const on = shown(); S.visible = on; cv.style.visibility = on ? "visible" : "hidden"; if (on) calm(); return on; }
  function loop(now) { raf = 0; if (S.destroyed || S.mode !== "anim") return;
    if (shouldPause()) { S.running = false; S.fps = 0; return; }
    if (lastRaf) { iv.push(now - lastRaf); if (iv.length > 40) iv.shift();
      if (iv.length === 40) { const med = [...iv].sort((a, b) => a - b)[20]; if (med > SLOW_MS) { S.slow = true; S.slowMs = Math.round(med); } } }
    lastRaf = now;
    if (!animated()) { kick(); return; }
    raf = requestAnimationFrame(loop);
    if (now - last < 1000 / MAX_FPS - 1.5) return;
    const dt = last ? Math.min(0.1, (now - last) / 1000) : 0; last = now; t += dt * SPEED;
    draw(); fpsN++; if (now - fpsT >= 1000) { S.fps = Math.round(fpsN * 1000 / (now - fpsT)); fpsN = 0; fpsT = now; } }
  function kick() { if (S.destroyed || S.lost || !gl) return;
    if (!vis()) { cancelAnimationFrame(raf); raf = 0; S.running = false; S.fps = 0; shouldPause(); return; }
    const want = animated() ? "anim" : "static";
    if (want === "static") { cancelAnimationFrame(raf); raf = 0; S.mode = "static"; S.running = false; S.fps = 0; t = STATIC_T; mouse.push = mouse.tpush = 0; draw(); return; }
    if (S.mode === "static") t = Math.max(t, STATIC_T);
    S.mode = "anim"; if (shouldPause()) { S.running = false; S.fps = 0; return; }
    if (!raf) { last = 0; lastRaf = 0; iv.length = 0; fpsT = performance.now(); fpsN = 0; S.running = true; raf = requestAnimationFrame(loop); } }
  const redraw = () => { if (S.mode === "static") draw(); else kick(); };

  /* listeners (all removed by destroy) */
  const offs = [];
  const on = (tgt, ev, f, o) => { tgt.addEventListener(ev, f, o); offs.push(() => tgt.removeEventListener(ev, f, o)); };
  const mo = (tgt, f, o) => { const m = new MutationObserver(f); m.observe(tgt, o); offs.push(() => m.disconnect()); };
  function listen() {
    on(document, "visibilitychange", kick);
    on(cv, "webglcontextlost", e => { e.preventDefault(); S.lost = true; fallback(); });
    on(window, "scroll", () => { rect = null; }, {passive: true});
    on(window, "pointermove", e => { if (S.mode !== "anim") return; const r = rect || (rect = cv.getBoundingClientRect());
      mouse.tx = (e.clientX - r.left) * SCALE; mouse.ty = (r.bottom - e.clientY) * SCALE; mouse.tpush = 1; if (!mouse.seen) { mouse.x = mouse.tx; mouse.y = mouse.ty; mouse.seen = true; } }, {passive: true});
    const rmq = matchMedia("(prefers-reduced-motion: reduce)"), dmq = matchMedia("(prefers-color-scheme: dark)");
    on(rmq, "change", kick); on(dmq, "change", () => { applyTheme(); redraw(); });
    mo(document.documentElement, () => { applyTheme(); kick(); redraw(); }, {attributes: true, attributeFilter: ["data-theme", "class"]});
    mo(document.body, () => { S.slow = false; kick(); }, {attributes: true, attributeFilter: ["data-tab"]});
    if (typeof ResizeObserver === "function") { const ro = new ResizeObserver(() => { size(); redraw(); }); ro.observe(cv); const c = opts.calm && opts.calm(); if (c) ro.observe(c);
      for (const el of opts.observe || []) ro.observe(el); offs.push(() => ro.disconnect()); }
    else on(window, "resize", () => { size(); redraw(); });
    if (typeof IntersectionObserver === "function") { const io = new IntersectionObserver(es => { for (const e of es) { if (e.isIntersecting) S.paused.delete("offscreen"); else S.paused.add("offscreen"); } kick(); });
      io.observe(cv); offs.push(() => io.disconnect()); }
  }
  /* "hidden" and "host" are recomputed on every check; "offscreen" (the observer) and pause() reasons persist */
  const H = {
    pause(reason = "api") { S.paused.add(reason); },
    resume(reason = "api") { S.paused.delete(reason); kick(); },
    destroy() { if (S.destroyed) return; S.destroyed = true; S.running = false; S.mode = "off"; cancelAnimationFrame(raf); for (const f of offs) f();
      try { gl && gl.getExtension("WEBGL_lose_context")?.loseContext(); } catch { /* already gone */ } cv.remove(); delete reg[name]; },
    state: () => ({...S, paused: [...S.paused]}),
    kick: () => kick(),
    canvas: cv,
  };
  reg[name].handle = H;

  /* create lazily, after first paint, when the browser is idle */
  /* not shown yet (the explorer's Spectra tab with SPECTRA_BG off): no context at all until it is wanted */
  const start = () => { if (S.destroyed) return;
    if (tier() === "low") { fallback(); return; }   // perf R5: the low tier keeps the static CSS gradient, no WebGL context
    S.lite = lite = gpuLite();
    if (!shown()) { S.visible = false; const m = new MutationObserver(() => { if (shown()) { m.disconnect(); start(); } });
      m.observe(document.body, {attributes: true, attributeFilter: ["data-tab"]}); offs.push(() => m.disconnect()); return; }
    if (opts.before && opts.before.parentNode === host) host.insertBefore(cv, opts.before); else host.appendChild(cv); if (!setup()) return; listen(); kick(); };
  const idle = window.requestIdleCallback ? f => requestIdleCallback(f, {timeout: 1200}) : f => setTimeout(f, 200);
  const afterPaint = () => requestAnimationFrame(() => setTimeout(() => idle(start), 0));
  const ready = () => tierReady().then(afterPaint, afterPaint);
  if (document.readyState === "complete") ready(); else addEventListener("load", ready, {once: true});
  return H;
}
