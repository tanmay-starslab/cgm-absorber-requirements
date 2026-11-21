// Head, hand and tilt control of the 3D view, opt-in and loaded only when a visitor presses the View card's control button.
// Camera: the vendored MediaPipe Face Landmarker and Gesture Recognizer (../vendor/mediapipe/, Apache-2.0) run in a worker
// (headworker.js) on small frames from the front camera; Head, Hands or Head + Hands (alternate frames). Tilt:
// DeviceOrientationEvent, no camera. Head and tilt feed headmath.js, hands handmath.js.
// Nothing leaves the device: frames go from the camera to the worker as ImageBitmaps, are read once and closed; no frame
// is stored, uploaded or logged, and every file comes from this site.
//
// Head modes: orbit (head yaw and pitch turn the view about the orbit centre, leaning zooms) and window (head-coupled
// perspective: an asymmetric frustum through the screen's edges as the eye moves). Hands win: while a hand is seen it
// drives rotation and zoom and the head is ignored, until 1 s after it leaves; in window mode the head keeps the
// perspective. A glass pill on the stage says who is in control.
// Touch devices get Tilt, plus Camera where the quick signals (tier, cores, memory, viewport, a camera) allow; the first
// tracker frames are timed and the rate follows them, falling back to Tilt with a short message when the device cannot keep up.
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
const TRACK = {head: {face: true, hands: false}, hands: {face: false, hands: true}, both: {face: true, hands: true}};
const PRIVACY = "Runs on your device. No video leaves your computer.";
const MSG = {unsupported: "This browser cannot run camera control", denied: "Camera permission denied", nocam: "No camera found",
  noface: "No face found", nohand: "No hand found", lost: "Stopped: nobody seen for a minute", load: "Tracking failed to load", tiltDenied: "Motion permission denied",
  noTilt: "No tilt sensor found", busy: "Camera could not start", centre: "Look at the centre", tiltCentre: "Hold still", slow: "May be slow on this device"};
const PILL = {rotate: "Hand ✋ rotate", zoom: "Hand 🤏 zoom", paused: "Hand ✊ paused"};

const CSS = `.v3c-hc{margin-top:8px;padding:9px 10px;border:1px solid var(--cg-edge,rgba(200,215,240,.16));border-radius:10px;
  background:var(--mat-thick,rgba(20,24,40,.8));box-shadow:var(--cg-hi,inset 0 1px 0 rgba(255,255,255,.08));font-size:12px}
.v3c-hc p{margin:0 0 8px;line-height:1.35}
.v3c-hc .v3c-btns{display:grid;grid-template-columns:1fr 1fr;gap:6px}
.v3c-hc .v3c-seg:not(.two){grid-template-columns:1fr 1fr 1.6fr}
.v3c-hc .v3c-seg span{padding:0 4px;font:500 12px system-ui,sans-serif}
.v3c-hc .v3c-row{margin-top:6px;grid-template-columns:auto minmax(0,1fr) 30px}
.v3c-hc .v3c-row label{overflow:visible;white-space:nowrap}
.v3c-hc .hc-checks{display:flex;gap:14px;margin-top:6px}
.v3c-hc .hc-checks label{display:inline-flex;align-items:center;gap:5px;cursor:pointer}
.v3c-hc .hc-st{margin:6px 0 0;min-height:15px;color:var(--muted,#98a0b8)}
.v3c-hc .hc-st.bad{color:var(--s-bad,#ff8a8a)}
.v3c-hc [hidden]{display:none}
.v3c-hc .v3c-btn[aria-pressed=true]{border-color:var(--s-accent,#7db2f0)}
#v3-head[aria-pressed=true]{border-color:var(--s-accent,#7db2f0)}
.v3d-hc{position:absolute;left:50%;top:10px;transform:translateX(-50%);z-index:3;display:flex;align-items:center;gap:6px;padding:4px 10px 4px 4px;border-radius:14px;
  background:var(--s-mat,rgba(12,16,22,.74));box-shadow:inset 0 0 0 1px var(--s-edge,rgba(200,215,240,.16)),var(--s-hi,none),0 6px 20px rgba(0,0,0,.3);
  backdrop-filter:var(--s-blur,blur(14px) saturate(1.5));-webkit-backdrop-filter:var(--s-blur,blur(14px) saturate(1.5));pointer-events:none;
  color:var(--s-ink,#eef0f7);font:600 12px/1.2 system-ui,sans-serif;white-space:nowrap}
.v3d-hc i{width:8px;height:8px;margin:0 3px 0 6px;border-radius:50%;background:#5ad19a;box-shadow:0 0 6px #5ad19a;flex:none}
.v3d-hc.off i{background:#d9a35a;box-shadow:none}
.v3d-hc video{width:64px;height:48px;border-radius:10px;object-fit:cover;transform:scaleX(-1);display:block;order:-1}
.v3d-hc video[hidden]{display:none}
.v3d-hc b{position:absolute;left:50%;top:calc(100% + 6px);transform:translateX(-50%);padding:5px 10px;border-radius:999px;font-weight:600;background:inherit;box-shadow:inherit;
  backdrop-filter:inherit;-webkit-backdrop-filter:inherit;opacity:0;transition:opacity .2s}
.v3d-hc b.on{opacity:1}
@media (max-width:820px){.v3d-hc{top:48px}.v3d-hc video{width:40px;height:30px;border-radius:8px}}   /* phones: below the scale bar and orbit button */
.v3d-thumb .v3d-hc{display:none}`;

let S = null;   // the one live session

/** The View card's control button was pressed: open the consent popover, or close it / the live panel. */
export function toggle(viewer, btn) {
  if (!document.getElementById("hc-css")) { const st = document.createElement("style"); st.id = "hc-css"; st.textContent = CSS; document.head.appendChild(st); }
  const box = btn.parentNode.querySelector(".v3c-hc");
  if (S) { stop(); return; }
  if (box) { box.remove(); btn.setAttribute("aria-expanded", "false"); return; }
  consent(viewer, btn);
}

function el(html) { const t = document.createElement("template"); t.innerHTML = html.trim(); return t.content.firstChild; }
function panelAfter(btn, node) { btn.parentNode.querySelector(".v3c-hc")?.remove(); btn.after(node); btn.setAttribute("aria-expanded", "true"); return node; }
const seg = (name, opts, cur, label) => `<div class="v3c-seg${opts.length === 2 ? " two" : ""}" role="radiogroup" aria-label="${label}">${opts.map(([v, t, tip]) =>
  `<label><input type="radio" name="${name}" value="${v}"${v === cur ? " checked" : ""} data-tip="${tip}"><span>${t}</span></label>`).join("")}</div>`;
/** Step 1 of the capability check: no permission prompt (enumerateDevices lists kinds even without labels). */
const quick = () => (navigator.mediaDevices?.enumerateDevices ? navigator.mediaDevices.enumerateDevices().then(L => L.some(d => d.kind === "videoinput")).catch(() => null) : Promise.resolve(false))
  .then(hasCam => decideQuick({touch: isTilt(), tier: tier() || "mid", cores: navigator.hardwareConcurrency || 4, mem: navigator.deviceMemory, w: innerWidth, h: innerHeight, hasCam}));

/** pre: {src: "camera" | "tilt", msg} when reopened after a fallback. */
function consent(viewer, btn, pre = {}) {
  const touch = isTilt();
  let src = pre.src || (touch ? "tilt" : "camera"), q = null;
  const box = panelAfter(btn, el(`<div class="v3c-hc" role="dialog" aria-label="${touch ? "Motion control" : "Head and hand control"}">
    ${touch ? `<div class="hc-src" hidden>${seg("hc-src", [["camera", "Camera", "Head and hands, with the front camera"], ["tilt", "Tilt", "Tilt the device to look around"]], src, "Control")}</div>` : ""}
    <div class="hc-cam">${seg("hc-track", [["head", "Head", "Turn your head to steer"], ["hands", "Hands", "Steer with one hand; no face tracking"], ["both", "Head + Hands", "A visible hand takes over from the head"]], "both", "Track")}</div>
    <p class="hc-msg"></p>
    <div class="v3c-btns"><button type="button" class="v3c-btn" data-a="start" data-tip="Start">Start</button><button type="button" class="v3c-btn" data-a="cancel" data-tip="Close without starting">Cancel</button></div>
    <p class="hc-st" role="status" aria-live="polite"></p></div>`));
  const sync = () => {
    box.querySelector(".hc-cam").hidden = src !== "camera";
    box.querySelector(".hc-msg").textContent = src === "camera" ? PRIVACY : "Tilt your device to look around. Runs on your device.";
    const slow = src === "camera" && q?.camera === "slow";
    if (!box.querySelector(".hc-st.bad")) say(box, src === "camera" && q?.camera === "none" && !touch ? MSG.nocam : slow ? MSG.slow : "");
  };
  box.querySelectorAll('[name="hc-src"]').forEach(i => i.addEventListener("change", () => { src = i.value; sync(); }));
  sync(); if (pre.msg) say(box, pre.msg);
  quick().then(r => { q = r; if (!box.isConnected) return;
    if (touch && r.camera !== "none") { box.querySelector(".hc-src").hidden = false; if (!pre.src) { src = r.def; box.querySelector(`[name="hc-src"][value="${src}"]`).checked = true; } }
    if (!pre.msg) sync(); box.dataset.camera = r.camera; });
  const close = () => { box.remove(); btn.setAttribute("aria-expanded", "false"); btn.focus(); };
  box.querySelector('[data-a="cancel"]').addEventListener("click", close);
  box.addEventListener("keydown", ev => { if (ev.key === "Escape") { ev.stopPropagation(); close(); } });
  box.querySelector('[data-a="start"]').addEventListener("click", () => start(viewer, btn, box, src === "tilt", box.querySelector('[name="hc-track"]:checked')?.value || "both"));   // the tap iOS needs for requestPermission
  box.querySelector('[data-a="start"]').focus();
}

function say(box, t, bad = false) { const s = box?.querySelector(".hc-st"); if (s) { s.textContent = t; s.classList.toggle("bad", bad); } }

async function start(viewer, btn, box, tilt, track = "both") {
  say(box, "");
  const T = tilt ? {face: true, hands: false} : TRACK[track] || TRACK.both;
  const s = {viewer, btn, box, tilt, track: tilt ? "tilt" : track, T, mode: "orbit", sens: 1, invert: false, preview: true, ref: null, cal: [], calT: 0, base: null, set: null,
    last: null, lastSeen: performance.now(), filt: ["yaw", "pitch", "x", "y", "z"].map(() => oneEuro(reduced() ? {minCutoff: 0.4, beta: 0.004} : {minCutoff: 1, beta: 0.01})),
    hc: handController(), arb: arbiter(), ctrl: T.face ? "head" : "hand", hand: "none", fps: 24, bench: null,
    stream: null, video: null, worker: null, busy: false, offs: []};
  S = s; s.starting = true; watch(s);   // watched while it loads too: leaving the tab mid-start still turns the camera off
  try { tilt ? await startTilt(s) : await startCam(s); }
  catch (x) { if (S !== s) return; S = null; if (!x?.hc) console.warn("head control:", x); say(box, x?.hc || MSG.unsupported, true); release(s); return; }
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
  say(s.box, "Loading");
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
  say(s.box, s.T.face ? MSG.centre : "");
}

/* step 2 of the capability check and the runtime governor: the tracker's ms per frame sets the rate; too slow on a touch
   device reopens the popover on Tilt with a short message (iOS asks for motion permission only from a tap) */
function rate(s, ms) {
  const r = Number.isFinite(ms) && s.gov?.update(ms); if (!r) return;
  if (r.bench != null) s.bench = Math.round(r.bench);
  if (r.tilt && isTilt()) { const {viewer, btn} = s; stop(); consent(viewer, btn, {src: "tilt", msg: r.hint}); return; }
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
  s.hand = o.state; pill(s);
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
const pillText = s => (s.tilt ? "Tilt" : s.ctrl === "hand" ? PILL[s.hand] || "Hand" : "Head");
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

/* ---- live panel and the stage pill ---- */
function livePanel(s) {
  const {btn} = s, tilt = s.tilt, face = s.T.face;
  btn.setAttribute("aria-pressed", "true");
  const box = s.box = panelAfter(btn, el(`<div class="v3c-hc" role="group" aria-label="${tilt ? "Tilt control" : "Camera control"} settings">
    ${face ? seg("hc-mode", [["orbit", "Orbit", `${tilt ? "Tilt" : "Turn your head"} to orbit the galaxy`], ["window", "Window", "The screen becomes a window onto the galaxy"]], "orbit", "Mode") : ""}
    <div class="v3c-row"><label for="hc-sens">sensitivity</label><input id="hc-sens" type="range" min="0.25" max="3" step="0.05" value="1" data-tip="How strongly ${tilt ? "tilt" : "motion"} moves the view"><output>1.0</output></div>
    <div class="hc-checks">${face ? '<label><input type="checkbox" data-c="invert" data-tip="Reverse the direction">invert</label>' : ""}${tilt ? "" : '<label><input type="checkbox" data-c="preview" checked data-tip="Show the small camera preview">preview</label>'}</div>
    <div class="v3c-btns" style="margin-top:6px"><button type="button" class="v3c-btn" data-a="recentre" data-tip="${face ? "Make your current pose the neutral one" : "Reset the view"}">Recentre</button><button type="button" class="v3c-btn" data-a="stop" data-tip="Turn ${tilt ? "tilt control" : "the camera"} off (Esc)">Stop</button></div>
    <p class="hc-st" role="status" aria-live="polite"></p></div>`));
  if (!s.ref && face) say(box, tilt ? MSG.tiltCentre : MSG.centre);
  box.querySelectorAll('[name="hc-mode"]').forEach(b => b.addEventListener("change", () => { if (s.mode === b.value) return;
    restoreProj(s); s.mode = b.value; s.base = null; s.set = null; s.last = null; if (s.pose) s.ref = {...s.ref, ...pick(s.pose)}; }));
  const sens = box.querySelector("#hc-sens"); sens.addEventListener("input", () => { s.sens = +sens.value; sens.nextElementSibling.textContent = s.sens.toFixed(1); s.last = null; });
  box.querySelector('[data-c="invert"]')?.addEventListener("change", ev => { s.invert = ev.target.checked; s.last = null; });
  box.querySelector('[data-c="preview"]')?.addEventListener("change", ev => { s.preview = ev.target.checked; if (s.video) s.video.hidden = !s.preview; });
  box.querySelector('[data-a="recentre"]').addEventListener("click", () => { if (!face) s.viewer.setPreset?.("reset"); recentre(s); if (face) say(box, tilt ? MSG.tiltCentre : MSG.centre); });
  box.querySelector('[data-a="stop"]').addEventListener("click", () => stop());
  const ind = s.ind = el(`<div class="v3d-hc" role="status" aria-live="polite" aria-label="${tilt ? "Tilt" : "Camera"} control on"><i></i><span></span><b></b></div>`);
  s.dot = ind; s.pillT = ind.querySelector("span"); s.toastEl = ind.querySelector("b"); pill(s);
  if (s.video) { s.video.hidden = !s.preview; ind.appendChild(s.video); }
  s.viewer.el.appendChild(ind);
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
  clearTimeout(s.toastT); s.ind?.remove();
}
function fail(s, msg) { if (S === s) stop(msg); }

/** Stop camera or tilt control: camera tracks stopped, worker ended, projection and pose restored. msg: a reason shown. */
export function stop(msg = "") {
  const s = S; if (!s) return; S = null;   // a start still loading sees S !== s and releases what it opened after this
  restoreProj(s); release(s);
  s.btn.setAttribute("aria-pressed", "false");
  if (msg && s.btn.isConnected) { const box = panelAfter(s.btn, el(`<div class="v3c-hc" role="status"><p class="hc-st bad"></p></div>`)); box.querySelector("p").textContent = msg;
    setTimeout(() => { if (!S && box.isConnected) { box.remove(); s.btn.setAttribute("aria-expanded", "false"); } }, 6000); }
  else { s.box?.remove(); s.btn.setAttribute("aria-expanded", "false"); }
  s.viewer.controls.dispatchEvent({type: "change"});
}

/** Test and debug view of the live session. */
export const state = () => (S ? {on: !S.starting, starting: !!S.starting, tilt: S.tilt, track: S.track, mode: S.mode, calibrated: !!S.ref || !S.T.face,
  tracks: S.stream ? S.stream.getTracks().filter(t => t.readyState === "live").length : 0, delegate: S.delegate || null, main: !!S.main,
  lastSeenAgoMs: Math.round(performance.now() - S.lastSeen), pose: S.pose ? pick(S.pose) : null, proj: !!S.proj,
  ctrl: S.ctrl, hand: S.hand, pill: S.pillT?.textContent || null, toast: S.lastToast || null, fps: S.fps, bench: S.bench} : {on: false});
/** Test hook: feed one hand result ({g, score, lm} or null) as if the tracker had sent it; the tracker's own hand results
 *  are ignored from then on in this session. */
export function _hand(h, t = performance.now()) { if (S && !S.starting && !S.tilt) { S.fed = true; onHand(S, h, t); } }
/** Test hook: feed one tracker frame time (ms) to the governor, as the worker's timing does. */
export function _rate(ms) { if (S && !S.starting && !S.tilt) rate(S, ms); }
