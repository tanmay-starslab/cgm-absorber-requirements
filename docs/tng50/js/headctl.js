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
import {poseFromMatrix, oneEuro, orbitMap, windowMap, offAxis, tiltPose, stepToward, D2R} from "./headmath.js";
import {handController, arbiter, pickJob, decideQuick, governor} from "./handmath.js";
import {gpuLite} from "./liquidbg.js";
import {tier} from "./tier.js";

export const isTilt = () => matchMedia("(pointer: coarse)").matches && !matchMedia("(any-pointer: fine)").matches;
const reduced = () => matchMedia("(prefers-reduced-motion: reduce)").matches;
const VENDOR = new URL("../vendor/mediapipe/", import.meta.url).href;
const NO_FACE_MS = 60000, CAL_MS = 600, FACE_W = 256, HAND_W = 192;
export const PRIVACY = "Your camera video stays on your device.";
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

/* Stage slots while Hands-free is on: nothing in the page flow changes (the View card gets no new box) and no stage overlay
   moves. The pill sits at the top (top-left at 12px/48px on narrow stages under the scale bar; top-centre at 10px on wide stages
   >= 720 px where the scale bar stays at the bottom), leaving the bottom of the 3D stage (colour key, scale bar, lines key,
   ID badge) completely uncluttered. The gesture guide and the options share one panel slot right below the pill, one at a time;
   while Hands-free is on the transient stage loading message is hidden so it never collides with the top pill. */
const CSS = `.v3d-stage{--hc-h:48px;--hc-b:32px;--hc-top:48px}
@media (pointer:coarse){.v3d-stage{--hc-h:48px;--hc-b:44px}}
@container (min-width:720px){.v3d-stage{--hc-top:10px}}
.v3d-stage:has(.v3d-hc) .v3d-msg[data-prog="1"],.v3d-stage:has(.v3d-hc) .v3d-msg[data-transient="1"],.v3d-stage:has(.v3d-ho:not([hidden])) .v3d-msg{visibility:hidden}
.v3d-stage:has(.v3d-hc) .v3d-msg{top:calc(var(--hc-top) + var(--hc-h) + 8px);max-width:min(340px,calc(100% - 24px))}
.v3d-stage:has(.v3d-msg:not(:empty):not([data-prog="1"]):not([data-transient="1"])) .v3d-hg{visibility:hidden}
#v3-head[aria-pressed=true]{border-color:var(--s-accent,#7db2f0)}
.v3d-hc,.v3d-hp{position:absolute;left:12px;z-index:3;box-sizing:border-box;color:var(--s-ink,#eef0f7);
  background:var(--s-mat,rgba(12,16,22,.74));box-shadow:inset 0 0 0 1px var(--s-edge,rgba(200,215,240,.16)),var(--s-hi,none),0 6px 20px rgba(0,0,0,.3);
  backdrop-filter:var(--s-blur,blur(14px) saturate(1.5));-webkit-backdrop-filter:var(--s-blur,blur(14px) saturate(1.5));border-radius:14px}
@container (min-width:720px){.v3d-hc,.v3d-hp,.v3d-stage:has(.v3d-hc) .v3d-msg{left:50%;transform:translateX(-50%)}}
@container (min-width:720px) and (max-width:1099px){.v3d-panel .v3d-hc,.v3d-panel .v3d-hp,.v3d-panel .v3d-stage:has(.v3d-hc) .v3d-msg{left:12px;transform:none}}
.v3d:fullscreen .v3d-stage:has(.v3d-hc) .v3d-lines,.v3d.v3d-fs .v3d-stage:has(.v3d-hc) .v3d-lines{top:auto;bottom:110px}
.v3d-hc{top:var(--hc-top);width:min(264px,calc(100% - 24px));height:var(--hc-h);display:flex;align-items:center;gap:7px;padding:4px;font:600 12px/15px system-ui,sans-serif}
.v3d-hc .hc-cam{flex:none;height:100%;aspect-ratio:4/3;border-radius:10px;overflow:hidden;background:rgba(255,255,255,.06)}
.v3d-hc.tilt .hc-cam{display:none}
.v3d-hc video{width:100%;height:100%;object-fit:cover;transform:scaleX(-1);display:block}
.v3d-hc video[hidden]{display:none}
.v3d-hc .hc-txt{flex:1;min-width:0;display:flex;flex-direction:column;justify-content:center;gap:1px;padding-left:3px}
.v3d-hc .hc-m{display:flex;align-items:center;gap:6px;white-space:nowrap;overflow:hidden}
.v3d-hc .hc-m i{width:8px;height:8px;border-radius:50%;background:#5ad19a;box-shadow:0 0 6px #5ad19a;flex:none}
.v3d-hc.off .hc-m i{background:#d9a35a;box-shadow:none}
.v3d-hc .hc-st{margin:0;font:500 11px/13px system-ui,sans-serif;color:var(--s-ink2,#a9b2c3);max-height:26px;overflow:hidden;overflow-wrap:anywhere}
.v3d-hc .hc-st.bad{color:var(--s-bad,#ff8a8a)}
.v3d-hc button{flex:none;width:var(--hc-b);height:var(--hc-b);padding:0;border:0;border-radius:50%;cursor:pointer;display:grid;place-items:center;
  font:600 13px/1 system-ui,sans-serif;color:inherit;background:rgba(255,255,255,.12)}
.v3d-hc button:hover{background:rgba(255,255,255,.2)}
.v3d-hc button svg{width:15px;height:15px}
.v3d-hc button[aria-expanded=true]{background:var(--s-accent,#7db2f0);color:#0c1016}
.v3d-hc button:focus-visible,.v3d-hp :focus-visible{outline:2px solid var(--s-accent,#7db2f0);outline-offset:2px}
.v3d-hc.idle button{visibility:hidden}
.v3d-hp{top:calc(var(--hc-top) + var(--hc-h) + 8px);max-width:calc(100% - 24px);max-height:calc(100% - var(--hc-top) - var(--hc-h) - 110px);overflow:auto;padding:10px 14px;font:500 12px/1.3 system-ui,sans-serif;transition:opacity .25s}
.v3d-hp[hidden]{display:block;opacity:0;visibility:hidden}
.v3d-hg{pointer-events:none}
.v3d-hg ul{display:grid;grid-template-columns:auto auto;gap:6px 18px;margin:0;padding:0;list-style:none;white-space:nowrap}
.v3d-hg li span{display:inline-block;width:1.5em}
.v3d-hg li b{font-weight:600}
.v3d-hg p{margin:8px 0 0;font-size:11px;color:var(--s-ink2,#a9b2c3);text-align:center}
.v3d-ho{width:min(284px,calc(100% - 24px))}
.v3d-ho .hc-row{display:grid;grid-template-columns:auto minmax(0,1fr) 2.6em;align-items:center;gap:10px;min-height:var(--hc-b)}
.v3d-ho label{display:inline-flex;align-items:center;gap:5px;cursor:pointer;white-space:nowrap;min-height:var(--hc-b)}
.v3d-ho input[type=range]{width:100%;margin:0;accent-color:var(--s-accent,#7db2f0)}
.v3d-ho input[type=checkbox]{margin:0;accent-color:var(--s-accent,#7db2f0)}
.v3d-ho output{font:500 11px var(--mono,ui-monospace,monospace);text-align:right}
.v3d-ho .hc-checks{display:grid;grid-template-columns:1fr 1fr;gap:0 12px}
@container (max-width:479px){.v3d-hc{width:min(256px,calc(100% - 24px))}.v3d-ho{width:min(256px,calc(100% - 24px))}.v3d-ho .hc-row,.v3d-ho label{min-height:30px}.v3d-hp{padding:6px 10px;font-size:11px}.v3d-hg ul{gap:4px 10px}.v3d-hg li span{width:1.3em}}   /* phones: two columns still fit 334 px */
@media (prefers-reduced-motion:reduce){.v3d-hp{transition:none}}
.v3d-thumb .v3d-hc,.v3d-thumb .v3d-hp{display:none}`;

let S = null;   // the one live session

let preferTilt = false, pending = false;   // set when the camera proved too slow on a touch device: the next click starts Tilt

/** The View card's Hands-free button was pressed: start at once, or stop. */
export function toggle(viewer, btn) {
  if (!document.getElementById("hc-css")) { const st = document.createElement("style"); st.id = "hc-css"; st.textContent = CSS; document.head.appendChild(st); }
  if (S) { stop(); return; }
  if (pending) return;   // the quick check is still running
  clearFlash();
  go(viewer, btn);
}

function el(html) { const t = document.createElement("template"); t.innerHTML = html.trim(); return t.content.firstChild; }
const ICON_OPT = `<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" aria-hidden="true"><path d="M2 4.5h7M12 4.5h2M2 11.5h2M7 11.5h7"/><circle cx="10.5" cy="4.5" r="1.5"/><circle cx="5.5" cy="11.5" r="1.5"/></svg>`;
/* the stage pill: preview, status dot, who is in control, a status line, and the options and guide buttons */
function makePill(viewer, tilt) {
  const ind = el(`<div class="v3d-hc${tilt ? " tilt" : ""}" role="group" aria-label="Hands-free"><div class="hc-cam"></div><div class="hc-txt"><div class="hc-m"><i></i><span role="status" aria-live="polite"></span></div>
    <p class="hc-st" role="status" aria-live="polite"></p></div><button type="button" class="hc-o" aria-expanded="false" aria-label="Hands-free options" data-tip="Window view, sensitivity and preview">${ICON_OPT}</button>
    <button type="button" class="hc-q" aria-expanded="false" aria-label="Show the gestures" data-tip="Show the gestures">?</button></div>`);
  viewer.el.append(ind); return {ind, off: () => {}};
}
let flashBox = null;
function clearFlash() { if (flashBox) { flashBox.off(); flashBox.ind.remove(); flashBox = null; } }
function flash(viewer, msg) {   // a short message in the stage pill that clears itself (no session: no buttons)
  clearFlash(); if (!viewer?.el?.isConnected) return;
  const f = flashBox = makePill(viewer, true); f.ind.classList.add("idle", "off"); f.ind.querySelector(".hc-m span").textContent = "Hands-free";
  say(f.ind, msg, true); setTimeout(() => { if (flashBox === f) clearFlash(); }, 6000); }
/** Step 1 of the capability check: no permission prompt (enumerateDevices lists kinds even without labels). */
const quick = viewer => (navigator.mediaDevices?.enumerateDevices ? navigator.mediaDevices.enumerateDevices().then(L => L.some(d => d.kind === "videoinput")).catch(() => null) : Promise.resolve(false))
  .then(hasCam => decideQuick({touch: isTilt(), tier: tier() || "mid", cores: navigator.hardwareConcurrency || 4, mem: navigator.deviceMemory, w: innerWidth, h: innerHeight, hasCam,
    movingMs: viewer?.stats?.calibration?.moving_exact_ms || 0}));

/* touch: Tilt straight from the click when it is the known choice (iOS asks for motion permission only from a tap);
   otherwise the quick signals pick camera or Tilt */
async function go(viewer, btn) {
  const touch = isTilt();
  if (touch && preferTilt) { start(viewer, btn, true); return; }
  btn.setAttribute("aria-pressed", "true");
  pending = true; const q = await quick(viewer).finally(() => { pending = false; });
  if (S) return;
  if (!touch && q.camera === "none") { btn.setAttribute("aria-pressed", "false"); flash(viewer, MSG.nocam); return; }
  const tilt = touch && q.def === "tilt";
  start(viewer, btn, tilt, q.camera === "slow" && !tilt, !tilt && q.hands !== false);
}

function say(box, t, bad = false) {
  if (S?.box === box && S.toasting) { S.keep = [t, bad]; return; }   // shown once the toast ends
  const s = box?.querySelector(".hc-st"); if (s) { s.textContent = t; s.classList.toggle("bad", bad); } }

async function start(viewer, btn, tilt, slow = false, handsOn = !tilt) {
  btn.setAttribute("aria-pressed", "true"); clearFlash();
  const pl = makePill(viewer, tilt), box = pl.ind;
  const T = tilt ? {face: true, hands: false} : {face: true, hands: !!handsOn};
  const s = {viewer, btn, box, tilt, track: tilt ? "tilt" : T.hands ? "both" : "head", T, slow, mode: "orbit", sens: 1, invert: false, preview: true, ref: null, cal: [], calT: 0, base: null, set: null,
    last: null, lastSeen: performance.now(), filt: ["yaw", "pitch", "x", "y", "z"].map(() => oneEuro(reduced() ? {minCutoff: 0.4, beta: 0.004} : {minCutoff: 1, beta: 0.01})),
    hc: handController(), arb: arbiter(), ctrl: T.face ? "head" : "hand", hand: "none", fps: 24, bench: null,
    stream: null, video: null, worker: null, busy: false, offs: [pl.off]};
  const bg = window.__liquidBg?.explorer?.handle; if (bg) { bg.pause("handsfree"); s.offs.push(() => bg.resume("handsfree")); }
  S = s; s.starting = true; ui(s); watch(s);   // watched while it loads too: leaving the tab mid-start still turns the camera off
  try { tilt ? await startTilt(s) : await startCam(s); }
  catch (x) { if (S !== s) return; S = null; if (!x?.hc) console.warn("head control:", x); release(s); btn.setAttribute("aria-pressed", "false"); flash(viewer, x?.hc || MSG.unsupported); return; }
  if (S !== s) { release(s); return; }
  s.starting = false;
  if (s.video) { s.video.hidden = !s.preview; box.querySelector(".hc-cam").appendChild(s.video); }
  if (!s.ref && !s.slow) say(box, tilt ? MSG.tiltCentre : MSG.centre);
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
  s.fps = main ? 10 : gpuLite() ? 18 : 24; s.main = main;
  s.gov = governor({touch: isTilt(), both: s.T.face && s.T.hands, tier: tier() || "mid"});
  try { s.stream = await navigator.mediaDevices.getUserMedia({audio: false, video: {facingMode: "user", width: {ideal: 320}, height: {ideal: 240}, frameRate: {ideal: s.fps, max: 30}}}); }
  catch (x) { const n = x?.name; throw {hc: n === "NotAllowedError" || n === "SecurityError" ? MSG.denied : n === "NotFoundError" || n === "OverconstrainedError" ? MSG.nocam : MSG.busy}; }
  const v = s.video = document.createElement("video"); v.muted = true; v.playsInline = true; v.autoplay = true; v.srcObject = s.stream; v.setAttribute("aria-hidden", "true");
  await v.play().catch(() => {});
  const w = s.worker = main ? await mainTracker() : new Worker(new URL("./headworker.js", import.meta.url));
  await new Promise((res, rej) => {
    const to = setTimeout(() => rej({hc: MSG.load}), 120000);
    w.onmessage = ({data: d}) => { if (d.type === "ready") { clearTimeout(to); s.delegate = d.delegate; s.handsReady = !!s.T.hands; res(); } else if (d.type === "error") { clearTimeout(to); console.warn("head control:", d.message); rej({hc: MSG.load}); } };
    w.onerror = e => { clearTimeout(to); console.warn("head control worker:", e.message); rej({hc: MSG.load}); };
    w.postMessage({type: "init", base: VENDOR, face: s.T.face, hands: s.T.hands});
  });
  w.onmessage = ({data: d}) => { s.busy = false; if (S !== s) return;
    if (d.type === "hands-ready") { s.handsLoading = false; s.handsReady = true; return; }
    if (d.type === "hands-error" || (d.type === "error" && s.handsLoading)) { console.warn("hand control:", d.message); s.handsLoading = false; setHands(s, false); say(s.box, "Head only (hands unavailable)", true); return; }
    if (d.type === "error") { fail(s, MSG.load); return; }
    if (d.type !== "res") return;
    rate(s, d.ms);
    if ("m" in d) { const p = d.m ? poseFromMatrix(d.m) : null; p ? onPose(s, p, d.t) : idle(s); }
    if ("hand" in d && !s.fed && s.T.hands) onHand(s, d.hand, d.t); };
  w.onerror = () => fail(s, MSG.load);
  let last = 0, k = 0;
  const grab = now => { if (S !== s && s.worker !== w) return;
    if (s.busy || now - last < 1000 / s.fps - 2 || !v.videoWidth) return;
    last = now; s.busy = true;
    const job = pickJob(s.handsLoading ? {face: s.T.face, hands: false} : s.T, k++, {ctrl: s.ctrl, mode: s.mode}), cw = job.hands ? HAND_W : FACE_W;
    if (main) { w.postMessage({type: "frame", bmp: v, t: now, ...job}); return; }
    createImageBitmap(v, {resizeWidth: cw, resizeHeight: Math.round(cw * v.videoHeight / v.videoWidth), resizeQuality: "low"})
      .then(bmp => { if (s.worker) s.worker.postMessage({type: "frame", bmp, t: now, ...job}, [bmp]); else bmp.close(); }).catch(() => { s.busy = false; }); };
  if (v.requestVideoFrameCallback) { const f = now => { if (!s.stream) return; grab(now); v.requestVideoFrameCallback(f); }; v.requestVideoFrameCallback(f); }
  else { const f = now => { if (!s.stream) return; grab(now); requestAnimationFrame(f); }; requestAnimationFrame(f); }
  if (!s.slow) say(s.box, MSG.centre);
}

function setHands(s, on) {
  on = !!on && !s.tilt; if (s.T.hands === on) return;
  s.T.hands = on; s.track = s.tilt ? "tilt" : on ? "both" : "head"; s.gov?.setBoth(on);
  const cb = s.opts?.querySelector('[data-c="hands"]'); if (cb && cb.checked !== on) cb.checked = on;
  if (on && s.worker && !s.handsReady && !s.handsLoading) { s.handsLoading = true; s.worker.postMessage({type: "hands", base: VENDOR}); }
  if (!on) { s.hc.reset(); s.arb.reset(); if (s.ctrl === "hand") { s.ctrl = "head"; if (s.mode === "orbit" && s.base && s.ref) rebase(s); } s.hand = "none"; s.sign = null; pill(s); }
}

/* step 2 of the capability check and the runtime governor: the tracker's ms per frame sets the rate; too slow on a touch
   device stops with a short message and the next click starts Tilt (iOS asks for motion permission only from a tap) */
function rate(s, ms) {
  const r = Number.isFinite(ms) && s.gov?.update(ms); if (!r) return;
  if (r.bench != null) s.bench = Math.round(r.bench);
  if (r.tilt && isTilt()) { preferTilt = true; stop(MSG.toTilt); return; }
  if (r.dropHands && s.T.hands) setHands(s, false);
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
  if (o.state === "paused" || o.state === "hold") s.handRem = null;
  else if (o.yaw || o.pitch || o.zoom !== 1) handMove(s, o);
}
/* turn the base view about the orbit centre like a drag (right: the scene follows the hand right; up: it tips up) and
   scale its distance across 60 fps interpolation frames; the head's window perspective, when on, is applied on top */
function handMove(s, o) {
  const V = s.viewer, c = V.camera;
  if (!c.parent && !V.canvas.isConnected) { stop(); return; }
  if (!s.base || (s.set && camState(c).some((v, i) => Math.abs(v - s.set[i]) > 1e-6))) rebase(s);
  const k = s.sens * (reduced() ? 0.5 : 1), R = s.handRem ||= {yaw: 0, pitch: 0, logZ: 0};
  R.yaw += o.yaw * k; R.pitch += o.pitch * k; R.logZ += Math.log(o.zoom || 1);
  apply(s);
}
function stepHandBase(s, dt) {
  const R = s.handRem; if (!R) return false;
  const st = stepToward({yaw: 0, pitch: 0, logZ: 0}, R, dt > 0 ? dt : 1 / 60, {tau: reduced() ? 0.015 : 0.036, snap: 0.008});
  const dy = R.yaw - st.val.yaw, dp = R.pitch - st.val.pitch, dz = R.logZ - st.val.logZ;
  R.yaw = st.val.yaw; R.pitch = st.val.pitch; R.logZ = st.val.logZ;
  if (!st.moved) s.handRem = null;
  if (!dy && !dp && !dz) return false;
  const V = s.viewer, T = V.THREE, controls = V.controls, B = s.base, off = B.pos.clone().sub(B.target);
  if (dy) off.applyAxisAngle(B.up, -dy * D2R);
  if (dp) {
    const tip = off.clone().applyAxisAngle(new T.Vector3().crossVectors(off.clone().negate(), B.up).normalize(), dp * D2R), a = tip.angleTo(B.up);
    if (a > 0.08 && a < Math.PI - 0.08) off.copy(tip);   // never over the pole
  }
  if (dz) off.setLength(Math.min(controls.maxDistance, Math.max(controls.minDistance, off.length() * Math.exp(dz))));
  B.pos.copy(B.target).add(off); B.q.setFromRotationMatrix(new T.Matrix4().lookAt(B.pos, B.target, B.up));
  s.last = null; return st.moved;
}
function act(s, a) {
  const V = s.viewer, orb = V.el.querySelector("#v3-orbit");
  if (a === "recentre") { V.setPreset?.("reset"); recentre(s); toast(s, "👍 Recentred"); }
  else if (a === "mode") { const m = V.mode === "volume" ? "integral" : "volume"; toast(s, V.setMode?.(m) ? `✌️ ${m === "volume" ? "Volume" : "Integral"}` : "✌️ No volume view"); }
  else if (a === "orbit") { orb?.click(); toast(s, `☝️ Orbit ${orb?.getAttribute("aria-pressed") === "true" ? "on" : "off"}`); }
  else { document.getElementById(a)?.click(); toast(s, a === "next" ? "👋 Next sightline" : "👋 Previous sightline"); }
}
function recentre(s) { restoreProj(s); s.ref = null; s.cal = []; s.calT = 0; s.base = null; s.set = null; s.pose = null; s.smooth = null; s.handRem = null; }
const pillText = s => (s.tilt ? "Tilt" : s.ctrl !== "hand" ? "Head" : s.hand === "hold" && HOLD[s.sign] ? `${HOLD[s.sign]} hold…` : PILL[s.hand] || "Hand");
function pill(s) { const t = s.pillT; if (t && t.textContent !== pillText(s)) t.textContent = pillText(s); }
function toast(s, text) {   // an action's confirmation in the pill's status line for 1.6 s, then the status comes back
  const st = s.box?.querySelector(".hc-st"); if (!st) return; s.lastToast = text;
  if (!s.toasting) s.keep = [st.textContent, st.classList.contains("bad")];
  s.toasting = true; st.textContent = text; st.classList.remove("bad");
  clearTimeout(s.toastT); s.toastT = setTimeout(() => { s.toasting = false; if (s.keep) say(s.box, ...s.keep); }, 1600);
}

const camState = c => [c.position.x, c.position.y, c.position.z, c.up.x, c.up.y, c.up.z, c.quaternion.x, c.quaternion.y, c.quaternion.z, c.quaternion.w];
function rebase(s) {
  const {camera: c, controls} = s.viewer;
  restoreProj(s, !s.set);
  s.base = {pos: c.position.clone(), up: c.up.clone(), q: c.quaternion.clone(), target: controls.target.clone()};
  s.set = null; s.last = null; s.smooth = null; s.handRem = null; if (s.pose) s.ref = {...s.ref, ...pick(s.pose)};
}
const pick = p => ({yaw: p.yaw, pitch: p.pitch, x: p.x, y: p.y, z: p.z});
function drawPose(s, v) {
  const V = s.viewer, c = V.camera, T = V.THREE, controls = V.controls, B = s.base;
  if (s.mode === "orbit") {
    if (s.last && Math.abs(v.yaw - s.last.yaw) < 0.03 && Math.abs(v.pitch - s.last.pitch) < 0.03 && Math.abs(v.zoom / s.last.zoom - 1) < 0.0008) return;
    s.last = v;
    const off = B.pos.clone().sub(B.target), right = new T.Vector3().crossVectors(off.clone().negate(), B.up).normalize();
    const qy = new T.Quaternion().setFromAxisAngle(B.up, v.yaw * D2R), qp = new T.Quaternion().setFromAxisAngle(right, -v.pitch * D2R), q = qy.multiply(qp);
    const d = Math.min(controls.maxDistance, Math.max(controls.minDistance, off.length() * v.zoom));
    off.applyQuaternion(q).setLength(d);
    c.position.copy(B.target).add(off); c.up.copy(B.up).applyQuaternion(q); c.lookAt(B.target);
  } else {
    if (s.last && Math.abs(v.ex - s.last.ex) < 0.0015 && Math.abs(v.ey - s.last.ey) < 0.0015 && Math.abs(v.ez - s.last.ez) < 0.0015) return;
    s.last = v;
    const d = B.pos.distanceTo(B.target), h = d * Math.tan(c.fov * D2R / 2);
    const r = offAxis({...v, h, d, aspect: c.aspect, near: c.near, far: c.far});
    c.quaternion.copy(B.q); c.up.copy(B.up); c.position.copy(B.pos).add(new T.Vector3(...r.eye).applyQuaternion(B.q));
    setProj(s, r.m);
  }
  c.updateMatrixWorld(); s.set = camState(c);
  controls.dispatchEvent({type: "change"});   // the viewer's on-demand render: fast frames while it moves, then refine
}
function apply(s) {
  const V = s.viewer, c = V.camera;
  if (!c.parent && !V.canvas.isConnected) { stop(); return; }
  if (s.set && camState(c).some((v, i) => Math.abs(v - s.set[i]) > 1e-6)) { rebase(s); return; }   // something else moved the camera
  if (!s.base) rebase(s);
  const now = performance.now(), dt = s.smoothT ? (now - s.smoothT) / 1000 : 0; s.smoothT = now;
  const hMoved = stepHandBase(s, dt);
  const k = reduced() ? 0.5 : 1, opts = {sens: s.sens * k, invert: s.invert}, head = !!(s.pose && s.ref);
  const goal = s.mode === "orbit" ? (head && s.ctrl !== "hand" ? orbitMap(s.pose, s.ref, opts) : {yaw: 0, pitch: 0, zoom: 1})
    : (head ? windowMap(s.pose, s.ref, opts) : {ex: 0, ey: 0, ez: 1});
  const st = stepToward(s.smooth, goal, dt, {tau: reduced() ? 0.02 : 0.045, snap: s.mode === "orbit" ? 0.04 : 0.0015});
  s.smooth = st.val; drawPose(s, st.val);
  if ((st.moved || hMoved) && !s.raf && typeof requestAnimationFrame === "function") {
    const tick = () => { s.raf = 0; if (S === s && !s.starting && (s.ctrl !== "hand" || s.mode === "window" || s.handRem)) apply(s); };
    s.raf = requestAnimationFrame(tick);
  }
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

/* ---- the stage pill, the options and the guide card (built on the click, before the camera answers) ---- */
function ui(s) {
  const {box: ind, tilt} = s, V = s.viewer;
  s.dot = ind; s.pillT = ind.querySelector(".hc-m span"); pill(s); say(ind, s.slow ? MSG.slow : "Loading");
  const g = s.guide = el(`<div class="v3d-hp v3d-hg" role="note" aria-label="Hands-free gestures" hidden><ul>${(tilt ? TILT_GUIDE : GUIDE).map(([i, a, b]) =>
    `<li><span aria-hidden="true">${i}</span><b>${a}:</b> ${b}</li>`).join("")}</ul><p>${PRIVACY}</p></div>`);
  const o = s.opts = el(`<div class="v3d-hp v3d-ho" role="group" aria-label="Hands-free options" hidden>
    <div class="hc-row"><label for="hc-sens">sensitivity</label><input id="hc-sens" type="range" min="0.25" max="3" step="0.05" value="1" data-tip="How strongly ${tilt ? "tilt" : "motion"} moves the view"><output>1.0</output></div>
    <div class="hc-checks"><label><input type="checkbox" data-c="window" data-tip="The screen becomes a window onto the galaxy">window</label><label><input type="checkbox" data-c="invert" data-tip="Reverse the direction">invert</label>${tilt ? "" : `<label><input type="checkbox" data-c="hands"${s.T.hands ? " checked" : ""} data-tip="Track hand gestures too; uncheck for head only">hands</label><label><input type="checkbox" data-c="preview" checked data-tip="Show the small camera preview">preview</label>`}</div></div>`);
  o.querySelector('[data-c="window"]').addEventListener("change", ev => { const m = ev.target.checked ? "window" : "orbit"; if (s.mode === m) return;
    restoreProj(s); s.mode = m; s.base = null; s.set = null; s.last = null; s.smooth = null; if (s.pose) s.ref = {...s.ref, ...pick(s.pose)}; });
  const sens = o.querySelector("#hc-sens"), syncSens = () => { s.sens = +sens.value; sens.nextElementSibling.textContent = s.sens.toFixed(1);
    const a = +sens.min || 0, b = +sens.max || 100; sens.style.setProperty("--pc", (b > a ? Math.min(100, Math.max(0, (s.sens - a) / (b - a) * 100)) : 0).toFixed(2) + "%"); };
  syncSens(); sens.addEventListener("input", () => { syncSens(); s.last = null; });
  o.querySelector('[data-c="invert"]').addEventListener("change", ev => { s.invert = ev.target.checked; s.last = null; });
  o.querySelector('[data-c="hands"]')?.addEventListener("change", ev => setHands(s, ev.target.checked));
  o.querySelector('[data-c="preview"]')?.addEventListener("change", ev => { s.preview = ev.target.checked; if (s.video) s.video.hidden = !s.preview; });
  const qb = ind.querySelector(".hc-q"), ob = ind.querySelector(".hc-o");
  /* one panel at a time in the slot above the pill */
  const show = which => { clearTimeout(s.guideT); g.hidden = which !== "guide"; o.hidden = which !== "opts";
    qb.setAttribute("aria-expanded", String(which === "guide")); ob.setAttribute("aria-expanded", String(which === "opts")); V.el.classList.toggle("hc-panel", !!which); };
  qb.addEventListener("click", () => show(g.hidden ? "guide" : null));
  ob.addEventListener("click", () => show(o.hidden ? "opts" : null));
  V.el.append(g, o);
  show("guide"); s.guideT = setTimeout(() => { if (!g.hidden) show(null); }, GUIDE_MS);
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
  if (s.raf) { cancelAnimationFrame(s.raf); s.raf = 0; }
  if (s.stream) { for (const t of s.stream.getTracks()) t.stop(); s.stream = null; }
  if (s.video) { s.video.srcObject = null; s.video.remove(); s.video = null; }
  if (s.worker) { s.worker.terminate(); s.worker = null; }
  clearTimeout(s.toastT); clearTimeout(s.guideT); s.box?.remove(); s.guide?.remove(); s.opts?.remove(); s.viewer.el.classList.remove("hc-panel");
}
function fail(s, msg) { if (S === s) stop(msg); }

/** Stop camera or tilt control: camera tracks stopped, worker ended, projection and pose restored. msg: a reason shown. */
export function stop(msg = "") {
  const s = S; if (!s) return; S = null;   // a start still loading sees S !== s and releases what it opened after this
  restoreProj(s); release(s);
  s.btn.setAttribute("aria-pressed", "false");
  if (msg && s.btn.isConnected) flash(s.viewer, msg);
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
