// Hands-free control of the 3D view (head steers, hand gestures act), opt-in and loaded only when a visitor presses the View
// card's Hands-free button. One click starts it (the browser's camera prompt is the consent step); a second click or Esc stops.
// Camera: the vendored MediaPipe Face Landmarker and Gesture Recognizer (../vendor/mediapipe/, Apache-2.0) run in a worker
// (headworker.js) on small frames from the front camera, face and hands on alternate frames. Tilt (touch devices that
// cannot run the camera tracker): DeviceOrientationEvent, no camera. Head and tilt feed headmath.js, hands handmath.js.
// Nothing leaves the device: frames go from the camera to the worker as ImageBitmaps, are read once and closed; no frame
// is stored, uploaded or logged, and every file comes from this site.
//
// Head modes: orbit (head yaw and pitch turn the view about the orbit centre, leaning zooms) and window (head-coupled
// perspective: an asymmetric frustum through the screen's edges as the eye moves). Hands win: while a hand is seen it
// drives rotation and zoom and the head is ignored, until 1 s after it leaves; in window mode the head keeps the
// perspective. A glass pill on the stage says who is in control.
// Touch devices use the camera where the quick signals (tier, cores, memory, viewport, a camera) allow, else Tilt; the first
// tracker frames are timed and the rate follows them; a device that cannot keep up stops with a short message and the next
// click starts Tilt. A small guide card on the stage lists the gestures for 6 s; the pill's "?" brings it back.
// The camera stops on Stop, Esc, leaving the 3D tab, a hidden page, a viewer dispose, or a minute with nobody seen.
// Anything else that moves the camera (a drag, a preset, the orbit button) re-bases the control so it never fights it.
import {poseFromMatrix, oneEuro, orbitMap, windowMap, offAxis, tiltPose, D2R} from "./headmath.js";
import {handController, arbiter, decideQuick, governor} from "./handmath.js";
import {gpuLite} from "./liquidbg.js";
import {tier} from "./tier.js";

export const isTilt = () => matchMedia("(pointer: coarse)").matches && !matchMedia("(any-pointer: fine)").matches;
const reduced = () => matchMedia("(prefers-reduced-motion: reduce)").matches;
const VENDOR = new URL("../vendor/mediapipe/", import.meta.url).href;
const NO_FACE_MS = 60000, CAL_MS = 600, CAP_W = 256;
export const PRIVACY = "Runs on your device. No video leaves your computer.";
const GUIDE_MS = 6000;
const GUIDE = [["🙂", "Turn head", "look around"], ["✋", "Move hand", "rotate"], ["🤏", "Pinch, pull", "zoom"], ["👋", "Swipe", "next sightline"],
  ["👍", "Hold", "recentre"], ["✌️", "Hold", "volume"], ["☝️", "Hold", "orbit"], ["✊", "Fist", "pause"]];
const TILT_GUIDE = [["📱", "Tilt", "look around"]];
const MSG = {unsupported: "This browser cannot run camera control", denied: "Camera permission denied", nocam: "No camera found",
  noface: "No face found", nohand: "No hand found", lost: "Stopped: nobody seen for a minute", load: "Tracking failed to load", tiltDenied: "Motion permission denied",
  noTilt: "No tilt sensor found", busy: "Camera could not start", centre: "Look at the centre", tiltCentre: "Hold still", slow: "May be slow on this device",
  toTilt: "Camera too slow here: tap again for Tilt"};
const PILL = {rotate: "Hand ✋ rotate", zoom: "Hand 🤏 zoom", paused: "Hand ✊ paused"};
const HOLD = {thumb: "👍", victory: "✌️", point: "☝️"};

const CSS = `.v3c-hc{margin-top:8px;padding:9px 10px;border:1px solid var(--cg-edge,rgba(200,215,240,.16));border-radius:10px;
  background:var(--mat-thick,rgba(20,24,40,.8));box-shadow:var(--cg-hi,inset 0 1px 0 rgba(255,255,255,.08));font-size:12px}
.v3c-hc summary{cursor:pointer;color:var(--muted,#98a0b8)}
.v3c-hc details[open] summary{margin-bottom:4px}
.v3c-hc .v3c-row{margin-top:6px;grid-template-columns:auto minmax(0,1fr) 30px}
.v3c-hc .v3c-row label{overflow:visible;white-space:nowrap}
.v3c-hc .hc-checks{display:flex;gap:14px;margin-top:6px}
.v3c-hc .hc-checks label{display:inline-flex;align-items:center;gap:5px;cursor:pointer}
.v3c-hc .hc-st{margin:6px 0 0;min-height:15px;line-height:1.35;color:var(--muted,#98a0b8)}
.v3c-hc .hc-st:empty{display:none}
.v3c-hc .hc-st.bad{color:var(--s-bad,#ff8a8a)}
.v3c-hc [hidden]{display:none}
#v3-head[aria-pressed=true]{border-color:var(--s-accent,#7db2f0)}
.v3d-hc{position:absolute;left:50%;top:10px;transform:translateX(-50%);z-index:3;display:flex;align-items:center;gap:6px;padding:4px 10px 4px 4px;border-radius:14px;
  background:var(--s-mat,rgba(12,16,22,.74));box-shadow:inset 0 0 0 1px var(--s-edge,rgba(200,215,240,.16)),var(--s-hi,none),0 6px 20px rgba(0,0,0,.3);
  backdrop-filter:var(--s-blur,blur(14px) saturate(1.5));-webkit-backdrop-filter:var(--s-blur,blur(14px) saturate(1.5));pointer-events:none;
  color:var(--s-ink,#eef0f7);font:600 12px/1.2 system-ui,sans-serif;white-space:nowrap}
.v3d-hc i{width:8px;height:8px;margin:0 3px 0 6px;border-radius:50%;background:#5ad19a;box-shadow:0 0 6px #5ad19a;flex:none}
.v3d-hc.off i{background:#d9a35a;box-shadow:none}
.v3d-hc button{pointer-events:auto;width:20px;height:20px;margin-left:4px;padding:0;border:0;border-radius:50%;cursor:pointer;font:600 12px/20px system-ui,sans-serif;
  color:inherit;background:rgba(255,255,255,.12);position:relative}
.v3d-hc button::after{content:"";position:absolute;inset:-12px}
.v3d-hc button[aria-expanded=true]{background:var(--s-accent,#7db2f0);color:#0c1016}
.v3d-hc button:focus-visible{outline:2px solid var(--s-accent,#7db2f0);outline-offset:2px}
.v3d-hg{position:absolute;left:50%;top:100px;transform:translateX(-50%);z-index:3;padding:9px 12px 8px;border-radius:14px;pointer-events:none;
  background:var(--s-mat,rgba(12,16,22,.74));box-shadow:inset 0 0 0 1px var(--s-edge,rgba(200,215,240,.16)),var(--s-hi,none),0 6px 20px rgba(0,0,0,.3);
  backdrop-filter:var(--s-blur,blur(14px) saturate(1.5));-webkit-backdrop-filter:var(--s-blur,blur(14px) saturate(1.5));color:var(--s-ink,#eef0f7);
  font:500 12px/1.25 system-ui,sans-serif;transition:opacity .25s}
.v3d-hg[hidden]{display:block;opacity:0;visibility:hidden}
.v3d-hg ul{display:grid;grid-template-columns:auto auto;gap:5px 16px;margin:0;padding:0;list-style:none;white-space:nowrap}
.v3d-hg li span{display:inline-block;width:1.5em}
.v3d-hg li b{font-weight:600}
.v3d-hg p{margin:7px 0 0;font-size:11px;color:var(--s-ink2,#a9b2c3);text-align:center}
.v3d-hc video{width:64px;height:48px;border-radius:10px;object-fit:cover;transform:scaleX(-1);display:block;order:-1}
.v3d-hc video[hidden]{display:none}
.v3d-hc b{position:absolute;left:50%;top:calc(100% + 6px);transform:translateX(-50%);padding:5px 10px;border-radius:999px;font-weight:600;background:inherit;box-shadow:inherit;
  backdrop-filter:inherit;-webkit-backdrop-filter:inherit;opacity:0;transition:opacity .2s}
.v3d-hc b.on{opacity:1}
@media (max-width:820px){.v3d-hc{top:48px}.v3d-hc video{width:40px;height:30px;border-radius:8px}.v3d-hg{top:124px;max-width:calc(100% - 20px)}.v3d-hg ul{gap:5px 10px}}   /* phones: below the scale bar and orbit button */
@media (prefers-reduced-motion:reduce){.v3d-hg{transition:none}}
.v3d-thumb .v3d-hc,.v3d-thumb .v3d-hg{display:none}`;

let S = null;   // the one live session

let preferTilt = false, pending = false;   // set when the camera proved too slow on a touch device: the next click starts Tilt

/** The View card's Hands-free button was pressed: start at once, or stop. */
export function toggle(viewer, btn) {
  if (!document.getElementById("hc-css")) { const st = document.createElement("style"); st.id = "hc-css"; st.textContent = CSS; document.head.appendChild(st); }
  if (S) { stop(); return; }
  if (pending) return;   // the quick check is still running
  host(btn).parentNode.querySelector(".v3c-hc")?.remove();
  go(viewer, btn);
}

function el(html) { const t = document.createElement("template"); t.innerHTML = html.trim(); return t.content.firstChild; }
const host = btn => btn.closest(".v3c-pair") || btn;   // the Fullscreen and Hands-free buttons share a row: the panel goes under it
function panelAfter(btn, node) { host(btn).parentNode.querySelector(".v3c-hc")?.remove(); host(btn).after(node); return node; }
function flash(btn, msg) {   // a short message under the button that clears itself
  const box = panelAfter(btn, el(`<div class="v3c-hc" role="status"><p class="hc-st bad"></p></div>`)); box.querySelector("p").textContent = msg;
  setTimeout(() => { if (!S && box.isConnected) box.remove(); }, 6000); }
/** Step 1 of the capability check: no permission prompt (enumerateDevices lists kinds even without labels). */
const quick = () => (navigator.mediaDevices?.enumerateDevices ? navigator.mediaDevices.enumerateDevices().then(L => L.some(d => d.kind === "videoinput")).catch(() => null) : Promise.resolve(false))
  .then(hasCam => decideQuick({touch: isTilt(), tier: tier() || "mid", cores: navigator.hardwareConcurrency || 4, mem: navigator.deviceMemory, w: innerWidth, h: innerHeight, hasCam}));

/* touch: Tilt straight from the click when it is the known choice (iOS asks for motion permission only from a tap);
   otherwise the quick signals pick camera or Tilt */
async function go(viewer, btn) {
  const touch = isTilt();
  if (touch && preferTilt) { start(viewer, btn, true); return; }
  btn.setAttribute("aria-pressed", "true");
  pending = true; const q = await quick().finally(() => { pending = false; });
  if (S) return;
  if (!touch && q.camera === "none") { btn.setAttribute("aria-pressed", "false"); flash(btn, MSG.nocam); return; }
  start(viewer, btn, touch && q.def === "tilt", q.camera === "slow" && !(touch && q.def === "tilt"));
}

function say(box, t, bad = false) { const s = box?.querySelector(".hc-st"); if (s) { s.textContent = t; s.classList.toggle("bad", bad); } }

async function start(viewer, btn, tilt, slow = false) {
  btn.setAttribute("aria-pressed", "true");
  const box = panelAfter(btn, el(`<div class="v3c-hc" role="group" aria-label="Hands-free"><p class="hc-st" role="status" aria-live="polite"></p></div>`));
  const T = tilt ? {face: true, hands: false} : {face: true, hands: true};
  const s = {viewer, btn, box, tilt, track: tilt ? "tilt" : "both", T, slow, mode: "orbit", sens: 1, invert: false, preview: true, ref: null, cal: [], calT: 0, base: null, set: null,
    last: null, lastSeen: performance.now(), filt: ["yaw", "pitch", "x", "y", "z"].map(() => oneEuro(reduced() ? {minCutoff: 0.4, beta: 0.004} : {minCutoff: 1, beta: 0.01})),
    hc: handController(), arb: arbiter(), ctrl: T.face ? "head" : "hand", hand: "none", fps: 24, bench: null,
    stream: null, video: null, worker: null, busy: false, offs: []};
  S = s; s.starting = true; watch(s);   // watched while it loads too: leaving the tab mid-start still turns the camera off
  try { tilt ? await startTilt(s) : await startCam(s); }
  catch (x) { if (S !== s) return; S = null; if (!x?.hc) console.warn("head control:", x); release(s); btn.setAttribute("aria-pressed", "false"); flash(btn, x?.hc || MSG.unsupported); return; }
  if (S !== s) { release(s); return; }
  s.starting = false; livePanel(s);
}

/* ---- sources ---- */
/* the tracker on the page itself, for browsers whose workers cannot run it (no OffscreenCanvas: older iOS), at a lower rate */
async function mainTracker() {
  const add = src => new Promise((res, rej) => { const e = document.createElement("script"); e.src = src; e.onload = res; e.onerror = () => rej({hc: MSG.load}); document.head.appendChild(e); });
  if (!window.Vision) await add(VENDOR + "vision_bundle.js");
  if (!window.HeadTrack) await add(new URL("./headworker.js", import.meta.url).href);
  const w = {onmessage: null, onerror: null, dead: false, main: true,
    postMessage(d) { window.HeadTrack(d).then(r => { if (r && !w.dead) w.onmessage?.({data: r}); }); }, terminate() { w.dead = true; }};
  return w;
}
async function startCam(s) {
  const main = typeof Worker === "undefined" || typeof OffscreenCanvas === "undefined";
  if (!navigator.mediaDevices?.getUserMedia || (!main && typeof createImageBitmap === "undefined")) throw {hc: MSG.unsupported};
  say(s.box, s.slow ? MSG.slow : "Loading");
  s.fps = main ? 10 : gpuLite() ? 12 : 24; s.main = main;
  s.gov = governor({touch: isTilt(), both: s.T.face && s.T.hands, tier: tier() || "mid"});
  try { s.stream = await navigator.mediaDevices.getUserMedia({audio: false, video: {facingMode: "user", width: {ideal: 320}, height: {ideal: 240}, frameRate: {ideal: s.fps, max: 30}}}); }
  catch (x) { const n = x?.name; throw {hc: n === "NotAllowedError" || n === "SecurityError" ? MSG.denied : n === "NotFoundError" || n === "OverconstrainedError" ? MSG.nocam : MSG.busy}; }
  const v = s.video = document.createElement("video"); v.muted = true; v.playsInline = true; v.autoplay = true; v.srcObject = s.stream; v.setAttribute("aria-hidden", "true");
  await v.play().catch(() => {});
  const w = s.worker = main ? await mainTracker() : new Worker(new URL("./headworker.js", import.meta.url));
  await new Promise((res, rej) => {
    const to = setTimeout(() => rej({hc: MSG.load}), 120000);
    w.onmessage = ({data: d}) => { if (d.type === "ready") { clearTimeout(to); s.delegate = d.delegate; res(); } else if (d.type === "error") { clearTimeout(to); console.warn("head control:", d.message); rej({hc: MSG.load}); } };
    w.onerror = e => { clearTimeout(to); console.warn("head control worker:", e.message); rej({hc: MSG.load}); };
    w.postMessage({type: "init", base: VENDOR, face: s.T.face, hands: s.T.hands});
  });
  w.onmessage = ({data: d}) => { s.busy = false; if (S !== s || d.type !== "res") return;
    rate(s, d.ms);
    if ("m" in d) { const p = d.m ? poseFromMatrix(d.m) : null; p ? onPose(s, p, d.t) : idle(s); }
    if ("hand" in d && !s.fed) onHand(s, d.hand, d.t); };
  w.onerror = () => fail(s, MSG.load);
  let last = 0, k = 0;
  const grab = now => { if (S !== s && s.worker !== w) return;
    if (s.busy || now - last < 1000 / s.fps - 2 || !v.videoWidth) return;
    last = now; s.busy = true;
    const job = s.T.face && s.T.hands ? (k++ % 2 ? {hands: true} : {face: true}) : s.T;   // both: alternate frames
    if (main) { w.postMessage({type: "frame", bmp: v, t: now, ...job}); return; }
    createImageBitmap(v, {resizeWidth: CAP_W, resizeHeight: Math.round(CAP_W * v.videoHeight / v.videoWidth), resizeQuality: "low"})
      .then(bmp => { if (s.worker) s.worker.postMessage({type: "frame", bmp, t: now, ...job}, [bmp]); else bmp.close(); }).catch(() => { s.busy = false; }); };
  if (v.requestVideoFrameCallback) { const f = now => { if (!s.stream) return; grab(now); v.requestVideoFrameCallback(f); }; v.requestVideoFrameCallback(f); }
  else { const f = now => { if (!s.stream) return; grab(now); requestAnimationFrame(f); }; requestAnimationFrame(f); }
  if (!s.slow) say(s.box, MSG.centre);
}

/* step 2 of the capability check and the runtime governor: the tracker's ms per frame sets the rate; too slow on a touch
   device stops with a short message and the next click starts Tilt (iOS asks for motion permission only from a tap) */
function rate(s, ms) {
  const r = Number.isFinite(ms) && s.gov?.update(ms); if (!r) return;
  if (r.bench != null) s.bench = Math.round(r.bench);
  if (r.tilt && isTilt()) { preferTilt = true; stop(MSG.toTilt); return; }
  s.fps = Math.min(s.fps, r.fps); if (r.hint) say(s.box, r.hint);
}

async function startTilt(s) {
  const DOE = window.DeviceOrientationEvent;
  if (!DOE) throw {hc: MSG.noTilt};
  if (typeof DOE.requestPermission === "function") { let r = "denied"; try { r = await DOE.requestPermission(); } catch { /* not from a tap */ } if (r !== "granted") throw {hc: MSG.tiltDenied}; }
  await new Promise((res, rej) => {
    const to = setTimeout(() => { removeEventListener("deviceorientation", h); rej({hc: MSG.noTilt}); }, 2000);
    const h = ev => { if (ev.beta == null || ev.gamma == null) return;
      if (to) { clearTimeout(to); res(); }
      if (S === s) onPose(s, tiltPose(ev.beta, ev.gamma, screen.orientation?.angle ?? window.orientation ?? 0), ev.timeStamp || performance.now()); };
    addEventListener("deviceorientation", h); s.offs.push(() => removeEventListener("deviceorientation", h));
  });
  say(s.box, MSG.tiltCentre);
}

/* ---- pose -> camera ---- */
function seen(s) { s.lastSeen = performance.now(); s.dot?.classList.remove("off"); if (s.lost) { s.lost = false; say(s.box, ""); } }
function onPose(s, raw, tMs) {
  const t = tMs / 1000, keys = ["yaw", "pitch", "x", "y", "z"], p = {...raw};
  keys.forEach((k, i) => { p[k] = s.filt[i].filter(raw[k], t); });
  seen(s);
  if (!s.ref) { s.cal.push(p); s.calT ||= performance.now(); calibrate(s); return; }
  s.pose = p;
  if (s.ctrl === "hand" && s.mode === "orbit") return;   // hands win: the head only keeps its pose current for the handback
  apply(s);
}
/* calibration: the mean pose over the first CAL_MS is neutral; also run from the 1 s timer, since a still device may send
   no further orientation events */
function calibrate(s) {
  if (s.ref || !s.cal.length || performance.now() - s.calT < CAL_MS) return;
  s.ref = Object.fromEntries(["yaw", "pitch", "x", "y", "z"].map(k => [k, s.cal.reduce((a, q) => a + q[k], 0) / s.cal.length])); s.cal = [];
  rebase(s); say(s.box, "");
}
/* nothing (face or hand) seen lately: the dot dims after 1.5 s, the camera stops after a minute */
function idle(s) {
  const ago = performance.now() - s.lastSeen;
  if (ago > 1500) s.dot?.classList.add("off");
  if (ago > NO_FACE_MS) { stop(MSG.lost); return; }
  if (ago > 1500 && !s.lost) { s.lost = true; say(s.box, s.T.face ? MSG.noface : MSG.nohand); }
}

/* ---- hand -> camera ---- */
function onHand(s, hand, tMs) {
  const o = s.hc.update(hand, tMs), now = performance.now();
  if (hand) seen(s); else idle(s);
  const ctrl = s.T.face ? s.arb.update(!!hand, now) : "hand";
  if (ctrl !== s.ctrl) { s.ctrl = ctrl; if (s.mode === "orbit" && s.base && s.ref) rebase(s); }   // take over (and hand back) where the view is: no jump
  s.hand = o.state; s.sign = o.sign; pill(s);
  if (o.action) act(s, o.action);
  if (o.state !== "paused" && (o.yaw || o.pitch || o.zoom !== 1)) handMove(s, o);
}
/* turn the base view about the orbit centre like a drag (right: the scene follows the hand right; up: it tips up) and
   scale its distance; the head's window perspective, when on, is applied on top */
function handMove(s, o) {
  const V = s.viewer, c = V.camera, T = V.THREE, controls = V.controls;
  if (!c.parent && !V.canvas.isConnected) { stop(); return; }
  if (!s.base || (s.set && camState(c).some((v, i) => Math.abs(v - s.set[i]) > 1e-6))) rebase(s);
  const B = s.base, k = s.sens * (reduced() ? 0.5 : 1), off = B.pos.clone().sub(B.target);
  off.applyAxisAngle(B.up, -o.yaw * k * D2R);
  const tip = off.clone().applyAxisAngle(new T.Vector3().crossVectors(off.clone().negate(), B.up).normalize(), o.pitch * k * D2R), a = tip.angleTo(B.up);
  if (a > 0.08 && a < Math.PI - 0.08) off.copy(tip);   // never over the pole
  off.setLength(Math.min(controls.maxDistance, Math.max(controls.minDistance, off.length() * o.zoom)));
  B.pos.copy(B.target).add(off); B.q.setFromRotationMatrix(new T.Matrix4().lookAt(B.pos, B.target, B.up));
  s.last = null; apply(s);
}
function act(s, a) {
  const V = s.viewer, orb = V.el.querySelector("#v3-orbit");
  if (a === "recentre") { V.setPreset?.("reset"); recentre(s); toast(s, "👍 Recentred"); }
  else if (a === "mode") { const m = V.mode === "volume" ? "integral" : "volume"; toast(s, V.setMode?.(m) ? `✌️ ${m === "volume" ? "Volume" : "Integral"}` : "✌️ No volume view"); }
  else if (a === "orbit") { orb?.click(); toast(s, `☝️ Orbit ${orb?.getAttribute("aria-pressed") === "true" ? "on" : "off"}`); }
  else { document.getElementById(a)?.click(); toast(s, a === "next" ? "👋 Next sightline" : "👋 Previous sightline"); }
}
function recentre(s) { restoreProj(s); s.ref = null; s.cal = []; s.calT = 0; s.base = null; s.set = null; s.pose = null; }
const pillText = s => (s.tilt ? "Tilt" : s.ctrl !== "hand" ? "Head" : s.hand === "hold" && HOLD[s.sign] ? `${HOLD[s.sign]} hold…` : PILL[s.hand] || "Hand");
function pill(s) { const t = s.pillT; if (t && t.textContent !== pillText(s)) t.textContent = pillText(s); }
function toast(s, text) {
  const b = s.toastEl; if (!b) return; b.textContent = text; b.classList.add("on"); s.lastToast = text;
  clearTimeout(s.toastT); s.toastT = setTimeout(() => b.classList.remove("on"), 1600);
}

const camState = c => [c.position.x, c.position.y, c.position.z, c.up.x, c.up.y, c.up.z, c.quaternion.x, c.quaternion.y, c.quaternion.z, c.quaternion.w];
function rebase(s) {
  const {camera: c, controls} = s.viewer;
  restoreProj(s, !s.set);
  s.base = {pos: c.position.clone(), up: c.up.clone(), q: c.quaternion.clone(), target: controls.target.clone()};
  s.set = null; s.last = null; if (s.pose) s.ref = {...s.ref, ...pick(s.pose)};
}
const pick = p => ({yaw: p.yaw, pitch: p.pitch, x: p.x, y: p.y, z: p.z});
function apply(s) {
  const V = s.viewer, c = V.camera, T = V.THREE, controls = V.controls;
  if (!c.parent && !V.canvas.isConnected) { stop(); return; }
  if (s.set && camState(c).some((v, i) => Math.abs(v - s.set[i]) > 1e-6)) { rebase(s); return; }   // something else moved the camera
  if (!s.base) rebase(s);
  const k = reduced() ? 0.5 : 1, opts = {sens: s.sens * k, invert: s.invert}, head = !!(s.pose && s.ref);
  const B = s.base;
  if (s.mode === "orbit") {
    const o = head && s.ctrl !== "hand" ? orbitMap(s.pose, s.ref, opts) : {yaw: 0, pitch: 0, zoom: 1};
    if (s.last && Math.abs(o.yaw - s.last.yaw) < 0.1 && Math.abs(o.pitch - s.last.pitch) < 0.1 && Math.abs(o.zoom / s.last.zoom - 1) < 0.002) return;
    s.last = o;
    const off = B.pos.clone().sub(B.target), right = new T.Vector3().crossVectors(off.clone().negate(), B.up).normalize();
    const qy = new T.Quaternion().setFromAxisAngle(B.up, o.yaw * D2R), qp = new T.Quaternion().setFromAxisAngle(right, -o.pitch * D2R), q = qy.multiply(qp);
    const d = Math.min(controls.maxDistance, Math.max(controls.minDistance, off.length() * o.zoom));
    off.applyQuaternion(q).setLength(d);
    c.position.copy(B.target).add(off); c.up.copy(B.up).applyQuaternion(q); c.lookAt(B.target);
  } else {
    const w = head ? windowMap(s.pose, s.ref, opts) : {ex: 0, ey: 0, ez: 1};
    if (s.last && Math.abs(w.ex - s.last.ex) < 0.004 && Math.abs(w.ey - s.last.ey) < 0.004 && Math.abs(w.ez - s.last.ez) < 0.003) return;
    s.last = w;
    const d = B.pos.distanceTo(B.target), h = d * Math.tan(c.fov * D2R / 2);
    const r = offAxis({...w, h, d, aspect: c.aspect, near: c.near, far: c.far});
    c.quaternion.copy(B.q); c.up.copy(B.up); c.position.copy(B.pos).add(new T.Vector3(...r.eye).applyQuaternion(B.q));
    setProj(s, r.m);
  }
  c.updateMatrixWorld(); s.set = camState(c);
  controls.dispatchEvent({type: "change"});   // the viewer's on-demand render: fast frames while it moves, then refine
}
/* window mode: the off-axis matrix replaces the symmetric one, and survives the viewer's resize (updateProjectionMatrix) */
function setProj(s, m) {
  const c = s.viewer.camera;
  if (!s.origUPM) { s.origUPM = c.updateProjectionMatrix; c.updateProjectionMatrix = function () { s.origUPM.call(this); if (s.proj) { this.projectionMatrix.fromArray(s.proj); this.projectionMatrixInverse.copy(this.projectionMatrix).invert(); } }; }
  s.proj = m; c.updateProjectionMatrix();
}
function restoreProj(s, back = true) {   // back: return the camera to the window's centre (not after a drag)
  const c = s.viewer.camera; if (!s.origUPM) return;
  if (back && s.base && s.mode === "window") { c.position.copy(s.base.pos); c.quaternion.copy(s.base.q); c.up.copy(s.base.up); }
  s.proj = null; c.updateProjectionMatrix = s.origUPM; s.origUPM = null; c.updateProjectionMatrix();
}

/* ---- options, the stage pill and the guide card ---- */
function livePanel(s) {
  const {box} = s, tilt = s.tilt;
  box.prepend(el(`<details><summary data-tip="Window view, sensitivity and preview">options</summary>
    <div class="v3c-row"><label for="hc-sens">sensitivity</label><input id="hc-sens" type="range" min="0.25" max="3" step="0.05" value="1" data-tip="How strongly ${tilt ? "tilt" : "motion"} moves the view"><output>1.0</output></div>
    <div class="hc-checks"><label><input type="checkbox" data-c="window" data-tip="The screen becomes a window onto the galaxy">window</label><label><input type="checkbox" data-c="invert" data-tip="Reverse the direction">invert</label>${tilt ? "" : '<label><input type="checkbox" data-c="preview" checked data-tip="Show the small camera preview">preview</label>'}</div></details>`));
  if (!s.ref && !s.slow) say(box, tilt ? MSG.tiltCentre : MSG.centre);
  box.querySelector('[data-c="window"]').addEventListener("change", ev => { const m = ev.target.checked ? "window" : "orbit"; if (s.mode === m) return;
    restoreProj(s); s.mode = m; s.base = null; s.set = null; s.last = null; if (s.pose) s.ref = {...s.ref, ...pick(s.pose)}; });
  const sens = box.querySelector("#hc-sens"); sens.addEventListener("input", () => { s.sens = +sens.value; sens.nextElementSibling.textContent = s.sens.toFixed(1); s.last = null; });
  box.querySelector('[data-c="invert"]').addEventListener("change", ev => { s.invert = ev.target.checked; s.last = null; });
  box.querySelector('[data-c="preview"]')?.addEventListener("change", ev => { s.preview = ev.target.checked; if (s.video) s.video.hidden = !s.preview; });
  const ind = s.ind = el(`<div class="v3d-hc"><i></i><span role="status" aria-live="polite"></span><b aria-hidden="true"></b><button type="button" aria-expanded="true" aria-label="Show the gestures" data-tip="Show the gestures">?</button></div>`);
  s.dot = ind; s.pillT = ind.querySelector("span"); s.toastEl = ind.querySelector("b"); pill(s);
  if (s.video) { s.video.hidden = !s.preview; ind.appendChild(s.video); }
  const g = s.guide = el(`<div class="v3d-hg" role="note" aria-label="Hands-free gestures"><ul>${(tilt ? TILT_GUIDE : GUIDE).map(([i, a, b]) =>
    `<li><span aria-hidden="true">${i}</span><b>${a}:</b> ${b}</li>`).join("")}</ul><p>${tilt ? "Runs on your device." : PRIVACY}</p></div>`);
  const q = ind.querySelector("button");
  const show = on => { clearTimeout(s.guideT); g.hidden = !on; q.setAttribute("aria-expanded", String(on)); };
  q.addEventListener("click", () => show(g.hidden));
  s.viewer.el.append(ind, g);
  show(true); s.guideT = setTimeout(() => show(false), GUIDE_MS);
}

function watch(s) {
  const off = () => { if (document.hidden || document.body.dataset.tab !== "3d" || !s.viewer.canvas.isConnected || s.viewer.docked === "thumb") stop(); };
  document.addEventListener("visibilitychange", off); s.offs.push(() => document.removeEventListener("visibilitychange", off));
  const mo = new MutationObserver(off); mo.observe(document.body, {attributes: true, attributeFilter: ["data-tab"]}); s.offs.push(() => mo.disconnect());
  const key = ev => { if (ev.key === "Escape") stop(); };
  document.addEventListener("keydown", key, true); s.offs.push(() => document.removeEventListener("keydown", key, true));   // capture: the canvas keeps its own Esc
  const iv = setInterval(() => { off(); if (S !== s || s.starting) return; calibrate(s); if (!s.tilt) idle(s);
    if (s.T.hands && s.T.face && s.ctrl === "hand" && s.arb.update(false, performance.now()) === "head") onHand(s, null, performance.now()); }, 1000);   // hand back even if hand frames stop
  s.offs.push(() => clearInterval(iv));
  const orb = s.viewer.el.querySelector("#v3-orbit"); if (orb?.getAttribute("aria-pressed") === "true") orb.click();   // no automatic motion underneath
}

function release(s) {
  for (const f of s.offs) f(); s.offs = [];
  if (s.stream) { for (const t of s.stream.getTracks()) t.stop(); s.stream = null; }
  if (s.video) { s.video.srcObject = null; s.video.remove(); s.video = null; }
  if (s.worker) { s.worker.terminate(); s.worker = null; }
  clearTimeout(s.toastT); clearTimeout(s.guideT); s.ind?.remove(); s.guide?.remove();
}
function fail(s, msg) { if (S === s) stop(msg); }

/** Stop camera or tilt control: camera tracks stopped, worker ended, projection and pose restored. msg: a reason shown. */
export function stop(msg = "") {
  const s = S; if (!s) return; S = null;   // a start still loading sees S !== s and releases what it opened after this
  restoreProj(s); release(s);
  s.btn.setAttribute("aria-pressed", "false");
  if (msg && s.btn.isConnected) flash(s.btn, msg); else s.box?.remove();
  s.viewer.controls.dispatchEvent({type: "change"});
}

/** Test and debug view of the live session. */
export const state = () => (S ? {on: !S.starting, starting: !!S.starting, tilt: S.tilt, track: S.track, mode: S.mode, calibrated: !!S.ref || !S.T.face,
  tracks: S.stream ? S.stream.getTracks().filter(t => t.readyState === "live").length : 0, delegate: S.delegate || null, main: !!S.main,
  lastSeenAgoMs: Math.round(performance.now() - S.lastSeen), pose: S.pose ? pick(S.pose) : null, proj: !!S.proj,
  ctrl: S.ctrl, hand: S.hand, pill: S.pillT?.textContent || null, guide: S.guide ? !S.guide.hidden : null, toast: S.lastToast || null, fps: S.fps, bench: S.bench} : {on: false});
/** Test hook: feed one hand result ({g, score, lm} or null) as if the tracker had sent it; the tracker's own hand results
 *  are ignored from then on in this session. */
export function _hand(h, t = performance.now()) { if (S && !S.starting && !S.tilt) { S.fed = true; onHand(S, h, t); } }
/** Test hook: feed one tracker frame time (ms) to the governor, as the worker's timing does. */
export function _rate(ms) { if (S && !S.starting && !S.tilt) rate(S, ms); }
