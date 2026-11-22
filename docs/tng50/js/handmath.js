// Pure logic for hand control of the 3D view (headctl.js): hand features from the Gesture Recognizer's 21 landmarks, label
// smoothing with hysteresis, pinch, hold-to-fire with a cooldown, swipe detection, palm motion -> rotation, pinch -> zoom,
// the hand/head arbitration, and the device-capability decisions. No DOM, no three.js: tests/js/handmath_unit.mjs runs it.
//
// Landmarks are MediaPipe's normalised image coordinates (x to the image right, y down) of the unmirrored camera frame,
// so the person's right is the image's left. Everything here works in the person's frame: ux = 1 - x, y down.
import {oneEuro, deadGain} from "./headmath.js";

/** MediaPipe's canned gesture categories -> the labels used here (anything else, "None" included, is "none"). */
export const LABELS = {Open_Palm: "palm", Closed_Fist: "fist", Thumb_Up: "thumb", Victory: "victory", Pointing_Up: "point"};
/** Hold gestures and what they do. */
export const HOLDS = {thumb: "recentre", victory: "mode", point: "orbit"};

/** {cx, cy} palm centre in the person's frame, size (wrist to middle-finger base, image widths), pinch (thumb tip to index
 *  tip over size). lm: 21 {x, y} points or 63 numbers. */
export function handFeatures(lm) {
  const P = i => (typeof lm[0] === "number" ? {x: lm[3 * i], y: lm[3 * i + 1]} : lm[i]);
  const d = (a, b) => Math.hypot(P(a).x - P(b).x, P(a).y - P(b).y);
  const palm = [0, 5, 9, 13, 17], cx = 1 - palm.reduce((t, i) => t + P(i).x, 0) / 5, cy = palm.reduce((t, i) => t + P(i).y, 0) / 5;
  const size = d(0, 9) || 1e-6;
  return {cx, cy, size, pinch: d(4, 8) / size};
}

/** Label hysteresis: a new label replaces the current one only after `enter` consecutive frames of it (score >= minScore,
 *  else the frame counts as "none"), so a one-frame misread never flickers the state. */
export function labelSmoother({enter = 3, minScore = 0.5} = {}) {
  let cur = "none", cand = null, n = 0;
  return {update(raw, score = 1) {
    const l = score >= minScore ? raw || "none" : "none";
    if (l === cur) { cand = null; n = 0; return cur; }
    if (l !== cand) { cand = l; n = 0; }
    if (++n >= enter) { cur = l; cand = null; n = 0; }
    return cur; }, reset() { cur = "none"; cand = null; n = 0; }, get value() { return cur; }};
}

/** Pinch with hysteresis: on below `on`, off above `off` (thumb-to-index distance over hand size). */
export function pinchGate({on = 0.3, off = 0.45} = {}) {
  let p = false;
  return {update(r) { p = p ? r < off : r < on; return p; }, reset() { p = false; }, get value() { return p; }};
}

/** Hold to fire: a label in HOLDS held for holdMs fires once; it fires again only after the label changes and the cooldown
 *  since the last fire has passed. t in ms. */
export function holdGate({holdMs = 500, cooldownMs = 1500} = {}) {
  let lab = null, since = 0, fired = false, last = -Infinity;
  return {update(l, t) {
    if (l !== lab) { lab = l; since = t; fired = false; }
    if (!HOLDS[l] || fired || t - since < holdMs || t - last < cooldownMs) return null;
    fired = true; last = t; return HOLDS[l]; }, reset() { lab = null; fired = false; }};
}

/** Swipe: the palm centre crossing at least dxMin image widths within windowMs, faster than vMin widths/s and mostly
 *  sideways. Returns "left" | "right" (the person's) once, then waits cooldownMs. */
export function swipeDetector({vMin = 1.2, dxMin = 0.18, windowMs = 300, cooldownMs = 900} = {}) {
  let H = [], last = -Infinity;
  return {update(x, y, t) {
    H.push({x, y, t}); while (H.length && t - H[0].t > windowMs) H.shift();
    if (t - last < cooldownMs || H.length < 3) return null;
    const a = H[0], dx = x - a.x, dy = y - a.y, dt = (t - a.t) / 1000;
    if (Math.abs(dx) < dxMin || Math.abs(dx) / dt < vMin || Math.abs(dy) > 0.6 * Math.abs(dx)) return null;
    last = t; H = []; return dx > 0 ? "right" : "left"; }, reset() { H = []; }};
}

/** Palm motion -> a drag of the view, degrees this frame: {yaw > 0 dragged right, pitch > 0 dragged up}. dx, dy: palm
 *  centre change in image widths (person's frame, y down); dt in s. Speeds under `dead` widths/s do nothing, so the view
 *  stops when the hand stops. gain: degrees per image width. */
export function palmRotate(dx, dy, dt, {gain = 220, dead = 0.06} = {}) {
  if (!(dt > 0)) return {yaw: 0, pitch: 0};
  return {yaw: deadGain(dx / dt, dead, gain) * dt, pitch: deadGain(-dy / dt, dead, gain) * dt};
}

/** Pinch push or pull -> a camera distance factor this frame: the hand growing (pulled toward you) gives < 1, zoom in. */
export function pinchZoom(prev, size, {gain = 2.2, dead = 0.006} = {}) {
  if (!(prev > 0 && size > 0)) return 1;
  return Math.exp(-deadGain(Math.log(size / prev), dead, gain));
}

/** Hands win: "hand" while a hand is seen and for handbackMs after it leaves, then "head". */
export function arbiter({handbackMs = 1000} = {}) {
  let lastHand = -Infinity;
  return {update(seen, t) { if (seen) lastHand = t; return t - lastHand < handbackMs ? "hand" : "head"; }, reset() { lastHand = -Infinity; }};
}

/** Which tracker reads camera frame k (0, 1, 2, …). With both face and hands on, an active hand in orbit mode gets every
 *  frame (hands win anyway, so full hand rate); while the head steers (or in window mode, where the head keeps the
 *  perspective), face gets 3 of every 4 frames and hands 1 of 4 as a low-cost probe. */
export function pickJob(T, k, {ctrl = "head", mode = "orbit", probe = 4} = {}) {
  if (!T.hands) return {face: true};
  if (!T.face) return {hands: true};
  if (ctrl === "hand" && mode === "orbit") return {hands: true};
  return k % probe === probe - 1 ? {hands: true} : {face: true};
}

/** The whole hand controller, one call per hand result. frame: {lm, g (MediaPipe category), score} or null (no hand).
 *  Returns {state: "none" | "rotate" | "zoom" | "paused" | "hold", yaw, pitch, zoom, action: null | "recentre" | "mode"
 *  | "orbit" | "next" | "prev", sign (the held label while state is "hold")}. A fist pauses everything; a pinch zooms; an open palm drags or swipes; holds fire actions. */
export function handController(o = {}) {
  const lab = labelSmoother(o.label), pin = pinchGate(o.pinch), hold = holdGate(o.hold), sw = swipeDetector(o.swipe);
  const fx = oneEuro({minCutoff: 2.2, beta: 0.7}), fy = oneEuro({minCutoff: 2.2, beta: 0.7}), fs = oneEuro({minCutoff: 1.8, beta: 0.4});
  let prev = null;
  const out = (state, extra = {}) => ({state, yaw: 0, pitch: 0, zoom: 1, action: null, ...extra});
  const reset = () => { lab.reset(); pin.reset(); hold.reset(); sw.reset(); fx.reset(); fy.reset(); fs.reset(); prev = null; };
  return {reset, update(frame, tMs) {
    if (!frame || !frame.lm) { reset(); return out("none"); }
    const f = handFeatures(frame.lm), rawL = (frame.score ?? 1) >= (o.label?.minScore ?? 0.5) ? LABELS[frame.g] || "none" : "none";
    const l = lab.update(LABELS[frame.g] || "none", frame.score ?? 1), t = tMs / 1000;
    const x = fx.filter(f.cx, t), y = fy.filter(f.cy, t), sz = fs.filter(f.size, t), p = prev; prev = {x, y, size: sz, t};
    if (l === "fist" || rawL === "fist") { pin.reset(); sw.reset(); hold.update(l, tMs); return out("paused"); }
    const action = hold.update(l, tMs);
    if (pin.update(f.pinch) && l !== "victory" && l !== "point") return out("zoom", {zoom: p ? pinchZoom(p.size, sz, o.zoom) : 1, action});
    if (l !== "palm" && l !== "none") { sw.reset(); return out(HOLDS[l] ? "hold" : "rotate", {action, sign: l}); }   // holding a sign: the view stays
    if (HOLDS[rawL]) { sw.reset(); return out("rotate", {action}); }
    const s = sw.update(f.cx, f.cy, tMs);   // raw positions: the filter would blunt the flick
    if (s) return out("rotate", {action: s === "right" ? "next" : "prev"});
    if (!p || (l !== "palm" && l !== "none")) return out("rotate", {action});
    const dt = t - p.t, vx = Math.abs(x - p.x) / (dt || 1), vy = Math.abs(y - p.y) / (dt || 1);
    if (vx > 0.95 * (o.swipe?.vMin ?? 1.2) && vx > 1.5 * vy) return out("rotate", {action});   // a fast horizontal flick is a swipe in the making, not a drag
    return out("rotate", {...palmRotate(x - p.x, y - p.y, dt, o.rotate), action});
  }};
}

/* ---- device capability ---- */

/** Step 1, quick signals before any permission: {camera: "ok" | "slow" | "none", def: "camera" | "tilt", hands: bool}.
 *  touch: a coarse-pointer device (it also has tilt); tier: html[data-tier]; cores, mem (GB, may be undefined); hasCam:
 *  a videoinput in enumerateDevices (null while unknown); movingMs: the 3D viewer's measured moving_exact_ms (from
 *  viewer3d.js stats.calibration). On constrained devices (camera === "slow", low tier, <= 4 cores on mid tier, or a heavy
 *  3D frame time > 35 ms) hands defaults to false (Head only) so head steering stays smooth, while the options panel still
 *  lets the visitor turn hands on. */
export function decideQuick({touch = false, tier = "mid", cores = 4, mem, w = 1024, h = 768, hasCam = null, movingMs = 0} = {}) {
  if (hasCam === false) return {camera: "none", def: touch ? "tilt" : "camera", hands: false};
  const big = Math.min(w, h) >= 700;                          // a tablet or larger viewport
  const strong = tier === "high" || (tier !== "low" && cores >= 6 && (mem == null || mem >= 4));
  const ok = tier !== "low" && cores >= 4 && (mem == null || mem >= 3) && (!touch || strong || big);
  const hands = ok && !(movingMs > 35) && (tier === "high" || (cores >= 6 && (mem == null || mem >= 4)));
  return {camera: ok ? "ok" : "slow", def: !touch || ok ? "camera" : "tilt", hands};
}

/** Step 2, after a few tracker frames: the median ms per frame -> a plan. full: both trackers at full rate; reduced: a lower
 *  rate; headOnly: hands are too heavy on a mid-tier desktop/tablet so drop to head-only before dropping to 6 fps; tilt: too
 *  slow, Tilt is the better control (touch) or the lowest rate with a warning (desktop). */
export function decideBench(ms, {touch = false, both = true, tier = "mid"} = {}) {
  if (ms < 30 && tier !== "low") return {plan: "full", fps: 24, hint: "", dropHands: false};
  if (ms < 60) return {plan: "reduced", fps: 12, hint: "", dropHands: false};
  if (both && !touch && tier !== "high" && ms < 110) return {plan: "headOnly", fps: 15, hint: "Head only (hands off for speed)", dropHands: true};
  return touch ? {plan: "tilt", fps: 6, hint: "Camera control is slow here: Tilt is smoother", dropHands: false}
    : {plan: "reduced", fps: 6, hint: "Camera control may be slow on this device", dropHands: both && tier !== "high"};
}

/** Runtime governor: warm frames give the bench decision, then a running mean of ms per frame steps the rate down
 *  (24 -> 12 -> 6 fps, or drops hands on non-high-tier devices when both trackers are on and frame times stay > 80 ms)
 *  when it stays over budget, and asks for Tilt (touch) when even 6 fps cannot keep up.
 *  update(ms) -> null | {fps, hint, tilt, dropHands, bench}. */
export function governor({warm = 5, touch = false, both = true, tier = "mid"} = {}) {
  const W = []; let fps = 24, mean = 0, over = 0, done = false, hasHands = both;
  return {get fps() { return fps; }, setBoth(b) { hasHands = !!b; over = 0; }, update(ms) {
    if (!done) { W.push(ms); if (W.length < warm) return null; done = true;
      const med = W.slice().sort((a, b) => a - b)[W.length >> 1], d = decideBench(med, {touch, both: hasHands, tier}); fps = d.fps; mean = med;
      if (d.dropHands) hasHands = false;
      return {fps, hint: d.hint, tilt: d.plan === "tilt", dropHands: !!d.dropHands, bench: med}; }
    mean = 0.9 * mean + 0.1 * ms;
    over = mean > Math.min(60, 1000 / fps) ? over + 1 : 0;
    if (over < 20) return null;
    over = 0;
    if (fps > 12) { fps = 12; return {fps, hint: "", tilt: false, dropHands: false}; }
    if (hasHands && !touch && tier !== "high" && mean > 75) { hasHands = false; return {fps: 12, hint: "Head only (hands off for speed)", tilt: false, dropHands: true}; }
    if (fps > 6) { fps = 6; return {fps, hint: "", tilt: false, dropHands: false}; }
    return touch && mean > 120 ? {fps, hint: "Camera control is slow here: Tilt is smoother", tilt: true, dropHands: false} : null; }};
}
