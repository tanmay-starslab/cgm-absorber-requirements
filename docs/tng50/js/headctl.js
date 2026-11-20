// Head and tilt control of the 3D view, opt-in and loaded only when a visitor presses the View card's head button.
// Desktop: the vendored MediaPipe Face Landmarker (../vendor/mediapipe/, Apache-2.0) runs in a worker (headworker.js) on
// small frames from the front camera. Phones and tablets: DeviceOrientationEvent tilt, no camera. Both feed headmath.js.
// Nothing leaves the device: frames go from the camera to the worker as ImageBitmaps, are read once and closed; no frame
// is stored, uploaded or logged, and every file comes from this site.
//
// Modes: orbit (head yaw and pitch turn the view about the orbit centre, leaning zooms) and window (head-coupled
// perspective: the screen is a window onto the galaxy, an asymmetric frustum through its edges as the eye moves).
// The camera stops on Stop, Esc, leaving the 3D tab, a hidden page, a viewer dispose, or a minute with no face.
// Anything else that moves the camera (a drag, a preset, the orbit button) re-bases the control so it never fights it.
import {poseFromMatrix, oneEuro, orbitMap, windowMap, offAxis, tiltPose, D2R} from "./headmath.js";
import {gpuLite} from "./liquidbg.js";

export const isTilt = () => matchMedia("(pointer: coarse)").matches && !matchMedia("(any-pointer: fine)").matches;
const reduced = () => matchMedia("(prefers-reduced-motion: reduce)").matches;
const VENDOR = new URL("../vendor/mediapipe/", import.meta.url).href;
const NO_FACE_MS = 60000, CAL_MS = 600, CAP_W = 256;
const MSG = {unsupported: "This browser cannot run head control", denied: "Camera permission denied", nocam: "No camera found",
  noface: "No face found", lost: "Stopped: no face for a minute", load: "Head tracking failed to load", tiltDenied: "Motion permission denied",
  noTilt: "No tilt sensor found", busy: "Camera could not start", centre: "Look at the centre", tiltCentre: "Hold still"};

const CSS = `.v3c-hc{margin-top:8px;padding:9px 10px;border:1px solid var(--cg-edge,rgba(200,215,240,.16));border-radius:10px;
  background:var(--mat-thick,rgba(20,24,40,.8));box-shadow:var(--cg-hi,inset 0 1px 0 rgba(255,255,255,.08));font-size:12px}
.v3c-hc p{margin:0 0 8px;line-height:1.35}
.v3c-hc .v3c-btns{display:grid;grid-template-columns:1fr 1fr;gap:6px}
.v3c-hc .v3c-row{margin-top:6px;grid-template-columns:auto minmax(0,1fr) 30px}
.v3c-hc .v3c-row label{overflow:visible;white-space:nowrap}
.v3c-hc .hc-checks{display:flex;gap:14px;margin-top:6px}
.v3c-hc .hc-checks label{display:inline-flex;align-items:center;gap:5px;cursor:pointer}
.v3c-hc .hc-st{margin:6px 0 0;min-height:15px;color:var(--muted,#98a0b8)}
.v3c-hc .hc-st.bad{color:var(--s-bad,#ff8a8a)}
.v3c-hc .v3c-btn[aria-pressed=true]{border-color:var(--s-accent,#7db2f0)}
#v3-head[aria-pressed=true]{border-color:var(--s-accent,#7db2f0)}
.v3d-hc{position:absolute;left:10px;top:46px;z-index:3;display:flex;align-items:center;gap:6px;padding:4px;border-radius:10px;
  background:var(--s-mat,rgba(12,16,22,.74));border:1px solid var(--s-edge,rgba(200,215,240,.16));pointer-events:none}
.v3d-hc i{width:8px;height:8px;margin:0 3px;border-radius:50%;background:#5ad19a;box-shadow:0 0 6px #5ad19a}
.v3d-hc.off i{background:#d9a35a;box-shadow:none}
.v3d-hc video{width:64px;height:48px;border-radius:6px;object-fit:cover;transform:scaleX(-1);display:block}
.v3d-hc video[hidden]{display:none}
.v3d-thumb .v3d-hc{display:none}`;

let S = null;   // the one live session

/** The View card's head button was pressed: open the consent popover, or close it / the live panel. */
export function toggle(viewer, btn) {
  if (!document.getElementById("hc-css")) { const st = document.createElement("style"); st.id = "hc-css"; st.textContent = CSS; document.head.appendChild(st); }
  const box = btn.parentNode.querySelector(".v3c-hc");
  if (S) { stop(); return; }
  if (box) { box.remove(); btn.setAttribute("aria-expanded", "false"); return; }
  consent(viewer, btn);
}

function el(html) { const t = document.createElement("template"); t.innerHTML = html.trim(); return t.content.firstChild; }
function panelAfter(btn, node) { btn.parentNode.querySelector(".v3c-hc")?.remove(); btn.after(node); btn.setAttribute("aria-expanded", "true"); return node; }

function consent(viewer, btn) {
  const tilt = isTilt();
  const box = panelAfter(btn, el(`<div class="v3c-hc" role="dialog" aria-label="${tilt ? "Tilt control" : "Head control"}">
    <p>${tilt ? "Tilt your device to look around. Runs on your device." : "Runs on your device. No video leaves your computer."}</p>
    <div class="v3c-btns"><button type="button" class="v3c-btn" data-a="start" data-tip="Start ${tilt ? "tilt" : "head"} control">Start</button><button type="button" class="v3c-btn" data-a="cancel" data-tip="Close without starting">Cancel</button></div>
    <p class="hc-st" role="status" aria-live="polite"></p></div>`));
  const close = () => { box.remove(); btn.setAttribute("aria-expanded", "false"); btn.focus(); };
  box.querySelector('[data-a="cancel"]').addEventListener("click", close);
  box.addEventListener("keydown", ev => { if (ev.key === "Escape") { ev.stopPropagation(); close(); } });
  box.querySelector('[data-a="start"]').addEventListener("click", () => start(viewer, btn, box, tilt));   // the tap iOS needs for requestPermission
  box.querySelector('[data-a="start"]').focus();
}

function say(box, t, bad = false) { const s = box?.querySelector(".hc-st"); if (s) { s.textContent = t; s.classList.toggle("bad", bad); } }

async function start(viewer, btn, box, tilt) {
  say(box, "");
  const s = {viewer, btn, box, tilt, mode: "orbit", sens: 1, invert: false, preview: true, ref: null, cal: [], calT: 0, base: null, set: null,
    last: null, lastFace: performance.now(), filt: ["yaw", "pitch", "x", "y", "z"].map(() => oneEuro(reduced() ? {minCutoff: 0.4, beta: 0.004} : {minCutoff: 1, beta: 0.01})),
    stream: null, video: null, worker: null, busy: false, offs: []};
  S = s; s.starting = true; watch(s);   // watched while it loads too: leaving the tab mid-start still turns the camera off
  try { tilt ? await startTilt(s) : await startHead(s); }
  catch (x) { if (S !== s) return; S = null; if (!x?.hc) console.warn("head control:", x); say(box, x?.hc || MSG.unsupported, true); release(s); return; }
  if (S !== s) { release(s); return; }
  s.starting = false; livePanel(s);
}

/* ---- sources ---- */
async function startHead(s) {
  if (!navigator.mediaDevices?.getUserMedia || typeof Worker === "undefined" || typeof createImageBitmap === "undefined") throw {hc: MSG.unsupported};
  say(s.box, "Loading");
  const fps = gpuLite() ? 12 : 24;
  try { s.stream = await navigator.mediaDevices.getUserMedia({audio: false, video: {facingMode: "user", width: {ideal: 320}, height: {ideal: 240}, frameRate: {ideal: fps, max: 30}}}); }
  catch (x) { const n = x?.name; throw {hc: n === "NotAllowedError" || n === "SecurityError" ? MSG.denied : n === "NotFoundError" || n === "OverconstrainedError" ? MSG.nocam : MSG.busy}; }
  const v = s.video = document.createElement("video"); v.muted = true; v.playsInline = true; v.autoplay = true; v.srcObject = s.stream; v.setAttribute("aria-hidden", "true");
  await v.play().catch(() => {});
  const w = s.worker = new Worker(new URL("./headworker.js", import.meta.url));
  await new Promise((res, rej) => {
    const to = setTimeout(() => rej({hc: MSG.load}), 120000);
    w.onmessage = ({data: d}) => { if (d.type === "ready") { clearTimeout(to); s.delegate = d.delegate; res(); } else if (d.type === "error") { clearTimeout(to); console.warn("head control:", d.message); rej({hc: MSG.load}); } };
    w.onerror = e => { clearTimeout(to); console.warn("head control worker:", e.message); rej({hc: MSG.load}); };
    w.postMessage({type: "init", base: VENDOR, model: VENDOR + "face_landmarker.task"});
  });
  w.onmessage = ({data: d}) => { if (d.type !== "pose") return; s.busy = false; if (S !== s) return;
    const p = d.m ? poseFromMatrix(d.m) : null; p ? onPose(s, p, d.t) : noFace(s); };
  w.onerror = () => fail(s, MSG.load);
  let last = 0;
  const grab = now => { if (S !== s && s.worker !== w) return;
    if (s.busy || now - last < 1000 / fps - 2 || !v.videoWidth) return;
    last = now; s.busy = true;
    createImageBitmap(v, {resizeWidth: CAP_W, resizeHeight: Math.round(CAP_W * v.videoHeight / v.videoWidth), resizeQuality: "low"})
      .then(bmp => { if (s.worker) s.worker.postMessage({type: "frame", bmp, t: now}, [bmp]); else bmp.close(); }).catch(() => { s.busy = false; }); };
  if (v.requestVideoFrameCallback) { const f = now => { if (!s.stream) return; grab(now); v.requestVideoFrameCallback(f); }; v.requestVideoFrameCallback(f); }
  else { const f = now => { if (!s.stream) return; grab(now); requestAnimationFrame(f); }; requestAnimationFrame(f); }
  say(s.box, MSG.centre);
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
function onPose(s, raw, tMs) {
  const t = tMs / 1000, keys = ["yaw", "pitch", "x", "y", "z"], p = {...raw};
  keys.forEach((k, i) => { p[k] = s.filt[i].filter(raw[k], t); });
  s.lastFace = performance.now(); s.dot?.classList.remove("off"); if (s.lost) { s.lost = false; say(s.box, ""); }
  if (!s.ref) { s.cal.push(p); s.calT ||= performance.now(); calibrate(s); return; }
  s.pose = p; apply(s);
}
/* calibration: the mean pose over the first CAL_MS is neutral; also run from the 1 s timer, since a still device may send
   no further orientation events */
function calibrate(s) {
  if (s.ref || !s.cal.length || performance.now() - s.calT < CAL_MS) return;
  s.ref = Object.fromEntries(["yaw", "pitch", "x", "y", "z"].map(k => [k, s.cal.reduce((a, q) => a + q[k], 0) / s.cal.length])); s.cal = [];
  rebase(s); say(s.box, "");
}
function noFace(s) {
  s.dot?.classList.add("off");
  if (performance.now() - s.lastFace > NO_FACE_MS) { stop(MSG.lost); return; }
  if (performance.now() - s.lastFace > 1500 && !s.lost) { s.lost = true; say(s.box, MSG.noface); }
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
  const k = reduced() ? 0.5 : 1, opts = {sens: s.sens * k, invert: s.invert};
  const B = s.base;
  if (s.mode === "orbit") {
    const o = orbitMap(s.pose, s.ref, opts);
    if (s.last && Math.abs(o.yaw - s.last.yaw) < 0.1 && Math.abs(o.pitch - s.last.pitch) < 0.1 && Math.abs(o.zoom / s.last.zoom - 1) < 0.002) return;
    s.last = o;
    const off = B.pos.clone().sub(B.target), right = new T.Vector3().crossVectors(off.clone().negate(), B.up).normalize();
    const qy = new T.Quaternion().setFromAxisAngle(B.up, o.yaw * D2R), qp = new T.Quaternion().setFromAxisAngle(right, -o.pitch * D2R), q = qy.multiply(qp);
    const d = Math.min(controls.maxDistance, Math.max(controls.minDistance, off.length() * o.zoom));
    off.applyQuaternion(q).setLength(d);
    c.position.copy(B.target).add(off); c.up.copy(B.up).applyQuaternion(q); c.lookAt(B.target);
  } else {
    const w = windowMap(s.pose, s.ref, opts);
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

/* ---- live panel and indicator ---- */
function livePanel(s) {
  const {btn} = s, tilt = s.tilt;
  btn.setAttribute("aria-pressed", "true");
  const box = s.box = panelAfter(btn, el(`<div class="v3c-hc" role="group" aria-label="${tilt ? "Tilt control" : "Head control"} settings">
    <div class="v3c-btns" role="group" aria-label="Mode"><button type="button" class="v3c-btn" data-m="orbit" aria-pressed="true" data-tip="${tilt ? "Tilt" : "Turn your head"} to orbit the galaxy">Orbit</button><button type="button" class="v3c-btn" data-m="window" aria-pressed="false" data-tip="The screen becomes a window onto the galaxy">Window</button></div>
    <div class="v3c-row"><label for="hc-sens">sensitivity</label><input id="hc-sens" type="range" min="0.25" max="3" step="0.05" value="1" data-tip="How strongly ${tilt ? "tilt" : "head motion"} moves the view"><output>1.0</output></div>
    <div class="hc-checks"><label><input type="checkbox" data-c="invert" data-tip="Reverse the direction">invert</label>${tilt ? "" : '<label><input type="checkbox" data-c="preview" checked data-tip="Show the small camera preview">preview</label>'}</div>
    <div class="v3c-btns" style="margin-top:6px"><button type="button" class="v3c-btn" data-a="recentre" data-tip="Make your current pose the neutral one">Recentre</button><button type="button" class="v3c-btn" data-a="stop" data-tip="Turn ${tilt ? "tilt control" : "the camera"} off (Esc)">Stop</button></div>
    <p class="hc-st" role="status" aria-live="polite"></p></div>`));
  if (!s.ref) say(box, tilt ? MSG.tiltCentre : MSG.centre);
  box.querySelectorAll("[data-m]").forEach(b => b.addEventListener("click", () => { if (s.mode === b.dataset.m) return;
    restoreProj(s); s.mode = b.dataset.m; s.base = null; s.set = null; s.last = null; if (s.pose) s.ref = {...s.ref, ...pick(s.pose)};
    box.querySelectorAll("[data-m]").forEach(x => x.setAttribute("aria-pressed", String(x === b))); }));
  const sens = box.querySelector("#hc-sens"); sens.addEventListener("input", () => { s.sens = +sens.value; sens.nextElementSibling.textContent = s.sens.toFixed(1); s.last = null; });
  box.querySelector('[data-c="invert"]').addEventListener("change", ev => { s.invert = ev.target.checked; s.last = null; });
  box.querySelector('[data-c="preview"]')?.addEventListener("change", ev => { s.preview = ev.target.checked; if (s.video) s.video.hidden = !s.preview; });
  box.querySelector('[data-a="recentre"]').addEventListener("click", () => { restoreProj(s); s.ref = null; s.cal = []; s.calT = 0; s.base = null; s.set = null; s.pose = null; say(box, tilt ? MSG.tiltCentre : MSG.centre); });
  box.querySelector('[data-a="stop"]').addEventListener("click", () => stop());
  const ind = s.ind = el(`<div class="v3d-hc" role="img" aria-label="${tilt ? "Tilt" : "Camera"} control on"><i></i></div>`);
  s.dot = ind; if (s.video) { s.video.hidden = !s.preview; ind.appendChild(s.video); }
  s.viewer.el.appendChild(ind);
}

function watch(s) {
  const off = () => { if (document.hidden || document.body.dataset.tab !== "3d" || !s.viewer.canvas.isConnected || s.viewer.docked === "thumb") stop(); };
  document.addEventListener("visibilitychange", off); s.offs.push(() => document.removeEventListener("visibilitychange", off));
  const mo = new MutationObserver(off); mo.observe(document.body, {attributes: true, attributeFilter: ["data-tab"]}); s.offs.push(() => mo.disconnect());
  const key = ev => { if (ev.key === "Escape") stop(); };
  document.addEventListener("keydown", key, true); s.offs.push(() => document.removeEventListener("keydown", key, true));   // capture: the canvas keeps its own Esc
  const iv = setInterval(() => { off(); if (S !== s || s.starting) return; calibrate(s); if (!s.tilt) noFace(s); }, 1000); s.offs.push(() => clearInterval(iv));
  const orb = s.viewer.el.querySelector("#v3-orbit"); if (orb?.getAttribute("aria-pressed") === "true") orb.click();   // no automatic motion underneath
}

function release(s) {
  for (const f of s.offs) f(); s.offs = [];
  if (s.stream) { for (const t of s.stream.getTracks()) t.stop(); s.stream = null; }
  if (s.video) { s.video.srcObject = null; s.video.remove(); s.video = null; }
  if (s.worker) { s.worker.terminate(); s.worker = null; }
  s.ind?.remove();
}
function fail(s, msg) { if (S === s) stop(msg); }

/** Stop head or tilt control: camera tracks stopped, worker ended, projection and pose restored. msg: a reason shown. */
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
export const state = () => (S ? {on: !S.starting, starting: !!S.starting, tilt: S.tilt, mode: S.mode, calibrated: !!S.ref, tracks: S.stream ? S.stream.getTracks().filter(t => t.readyState === "live").length : 0,
  delegate: S.delegate || null, lastFaceAgoMs: Math.round(performance.now() - S.lastFace), pose: S.pose ? pick(S.pose) : null, proj: !!S.proj} : {on: false});
