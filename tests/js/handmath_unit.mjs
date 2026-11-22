// Unit checks of the hand control logic (docs/tng50/js/handmath.js): features, label hysteresis, pinch, hold/cooldown,
// swipe, palm motion -> rotation, pinch -> zoom, fist pause, the hands-win arbitration and the capability decisions.
// Usage: node tests/js/handmath_unit.mjs
import {handFeatures, labelSmoother, pinchGate, holdGate, swipeDetector, palmRotate, pinchZoom, arbiter, pickJob, handController,
  decideQuick, decideBench, governor, LABELS} from "../../docs/tng50/js/handmath.js";

let n = 0, bad = 0;
const check = (ok, msg) => { n++; if (!ok) { bad++; console.log("FAIL " + msg); } else console.log("ok " + msg); };

/* a synthetic hand: palm centre (x, y) in image coordinates, size (wrist to middle base), pinch ratio */
function hand(x, y, size = 0.2, pinch = 1) {
  const P = Array.from({length: 21}, () => ({x, y, z: 0}));
  P[0] = {x, y: y + size / 2, z: 0}; P[9] = {x, y: y - size / 2, z: 0};
  P[5] = {x: x - size / 4, y: y - size / 2, z: 0}; P[17] = {x: x + size / 4, y: y - size / 2 + 0.01, z: 0}; P[13] = {x: x + size / 8, y: y - size / 2, z: 0};
  P[4] = {x: x - size * pinch / 2, y: y - size, z: 0}; P[8] = {x: x + size * pinch / 2, y: y - size, z: 0};
  return P.flatMap(p => [p.x, p.y, p.z]);
}

/* features: the person's frame mirrors x */
{ const f = handFeatures(hand(0.3, 0.5, 0.2, 0.5));
  check(Math.abs(f.cx - 0.7) < 0.03 && Math.abs(f.size - 0.2) < 1e-9 && Math.abs(f.pinch - 0.5) < 1e-9, `features: image x 0.3 is the person's 0.7, size 0.2, pinch 0.5 (${JSON.stringify(f)})`); }

/* label hysteresis: needs 3 frames, a one-frame blip does nothing, low scores count as none */
{ const L = labelSmoother({enter: 3});
  check(L.update("palm") === "none" && L.update("palm") === "none" && L.update("palm") === "palm", "label: a new label takes 3 consecutive frames");
  check(L.update("fist") === "palm" && L.update("palm") === "palm" && L.update("fist") === "palm" && L.update("fist") === "palm", "label: one-frame and interrupted blips never switch");
  L.update("fist"); check(L.value === "fist", "label: the third consecutive fist switches");
  const M = labelSmoother({enter: 2, minScore: 0.6}); M.update("palm", 0.9); M.update("palm", 0.9); M.update("palm", 0.3); M.update("palm", 0.3);
  check(M.value === "none", "label: low-confidence frames count as none"); }

/* pinch hysteresis */
{ const P = pinchGate({on: 0.3, off: 0.45});
  check(!P.update(0.35) && P.update(0.25) && P.update(0.4) && !P.update(0.5), "pinch: on below 0.3, held until above 0.45"); }

/* hold gestures: each fires once after 500 ms, not again while held, again after release and cooldown */
for (const [g, act] of [["thumb", "recentre"], ["victory", "mode"], ["point", "orbit"]]) {
  const H = holdGate({holdMs: 500, cooldownMs: 1500}); const fired = [];
  for (let t = 0; t <= 2000; t += 50) { const a = H.update(g, t); if (a) fired.push([t, a]); }
  check(fired.length === 1 && fired[0][0] === 500 && fired[0][1] === act, `hold ${g}: fires "${act}" once at 500 ms while held 2 s (${JSON.stringify(fired)})`);
  H.update("palm", 2050); const re = []; for (let t = 2100; t <= 3000; t += 50) { const a = H.update(g, t); if (a) re.push(t); }
  check(re.length === 1 && re[0] === 2600, `hold ${g}: after a release it fires again 500 ms into the next hold (${re})`);
  const C = holdGate({holdMs: 500, cooldownMs: 1500}); let k = 0;
  for (let t = 0; t <= 600; t += 50) if (C.update(g, t)) k++;
  C.update("none", 650); for (let t = 700; t <= 1500; t += 50) if (C.update(g, t)) k++;
  check(k === 1, `hold ${g}: a second hold inside the cooldown does not fire (${k} fires)`);
  const Sh = holdGate({holdMs: 500}); let s = 0; for (let t = 0; t < 500; t += 50) if (Sh.update(g, t)) s++;
  check(s === 0, `hold ${g}: shorter than 500 ms never fires`); }
{ const H = holdGate(); let k = 0; for (let t = 0; t <= 2000; t += 50) if (H.update("palm", t) || H.update("fist", t + 1)) k++;
  check(k === 0, "hold: palm and fist are not hold gestures"); }

/* swipe: fast sideways crossing fires once with the right direction; slow, short or vertical motion does not */
{ const sw = swipeDetector(); let r = null;
  for (let i = 0; i <= 6; i++) r = sw.update(0.3 + 0.06 * i, 0.5, i * 40) || r;
  check(r === "right", `swipe: 0.36 widths in 240 ms to the person's right is "right" (${r})`);
  const sl = swipeDetector(); let r2 = null; for (let i = 0; i <= 40; i++) r2 = sl.update(0.3 + 0.01 * i, 0.5, i * 50) || r2;
  check(r2 === null, "swipe: a slow drag is not a swipe");
  const lf = swipeDetector(); let r3 = null; for (let i = 0; i <= 6; i++) r3 = lf.update(0.7 - 0.06 * i, 0.5, i * 40) || r3;
  check(r3 === "left", `swipe: the same to the left is "left" (${r3})`);
  const vt = swipeDetector(); let r4 = null; for (let i = 0; i <= 6; i++) r4 = vt.update(0.5 + 0.03 * i, 0.3 + 0.06 * i, i * 40) || r4;
  check(r4 === null, "swipe: a mostly vertical flick is not a swipe");
  const cd = swipeDetector({cooldownMs: 900}); let k = 0;
  for (let i = 0; i <= 12; i++) if (cd.update(0.2 + 0.06 * i, 0.5, i * 40)) k++;
  check(k === 1, `swipe: one long flick fires once (cooldown), got ${k}`); }

/* palm motion -> rotation: direction, dead zone, proportional */
{ const r = palmRotate(0.02, 0, 1 / 12), l = palmRotate(-0.02, 0, 1 / 12), u = palmRotate(0, -0.02, 1 / 12), d = palmRotate(0, 0.02, 1 / 12);
  check(r.yaw > 0 && r.pitch === 0 && l.yaw < 0 && u.pitch > 0 && d.pitch < 0, `rotate: hand right drags right (${r.yaw.toFixed(2)}), left drags left, up drags up (${u.pitch.toFixed(2)}), down drags down`);
  const z = palmRotate(0.003, -0.003, 1 / 12); check(z.yaw === 0 && z.pitch === 0, "rotate: jitter under the dead zone (0.036 widths/s) does nothing");
  check(Math.abs(palmRotate(0.04, 0, 1 / 12).yaw / r.yaw - (0.48 - 0.06) / (0.24 - 0.06)) < 1e-9, "rotate: proportional to the speed above the dead zone");
  check(palmRotate(0.02, 0, 0).yaw === 0, "rotate: no time step, no motion"); }

/* pinch -> zoom: the hand growing (pulled toward you) zooms in, shrinking zooms out, tiny changes do nothing */
{ const zin = pinchZoom(0.2, 0.22), zout = pinchZoom(0.2, 0.18), z0 = pinchZoom(0.2, 0.2005);
  check(zin < 1 && zout > 1 && z0 === 1, `zoom: bigger hand ${zin.toFixed(3)} (< 1, in), smaller ${zout.toFixed(3)} (> 1, out), jitter ${z0}`);
  check(pinchZoom(0, 0.2) === 1, "zoom: no previous size, no zoom"); }

/* arbitration: hands win, the head resumes 1 s after the hand leaves */
{ const A = arbiter({handbackMs: 1000});
  check(A.update(false, 0) === "head" && A.update(true, 100) === "hand" && A.update(false, 600) === "hand" && A.update(false, 1099) === "hand" && A.update(false, 1100) === "head",
    "arbiter: head, hand while seen, hand for 1 s after it leaves, then head");
  check(A.update(true, 2000) === "hand" && A.update(false, 2500) === "hand" && A.update(true, 2900) === "hand" && A.update(false, 3800) === "hand" && A.update(false, 3900) === "head",
    "arbiter: a hand back within the second restarts the handback timer");
  const jHead = Array.from({length: 8}, (_, k) => pickJob({face: true, hands: true}, k, {ctrl: "head", mode: "orbit"}));
  check(jHead.filter(j => j.face).length === 6 && jHead.filter(j => j.hands).length === 2, "pickJob: while the head steers, 3 of 4 frames go to face and 1 of 4 probes for hands");
  const jHand = Array.from({length: 8}, (_, k) => pickJob({face: true, hands: true}, k, {ctrl: "hand", mode: "orbit"}));
  check(jHand.every(j => j.hands && !j.face), "pickJob: while a hand steers in orbit mode, every frame goes to hands");
  const jOnly = Array.from({length: 4}, (_, k) => pickJob({face: true, hands: false}, k, {ctrl: "head", mode: "orbit"}));
  check(jOnly.every(j => j.face && !j.hands), "pickJob: hands unchecked sends every frame to face"); }

/* the controller: palm drags, pinch zooms, fist pauses, swipes and holds give actions */
const run = (C, frames, t0 = 0, dt = 1000 / 12) => frames.map((f, i) => C.update(f, t0 + i * dt));
{ const C = handController(), F = [];
  for (let i = 0; i < 20; i++) F.push({lm: hand(0.6 - 0.006 * i, 0.5), g: "Open_Palm", score: 0.9});   // image left = the person's right
  const o = run(C, F), moved = o.slice(5).reduce((a, r) => a + r.yaw, 0);
  check(o.every(r => r.state === "rotate") && moved > 1 && o.every(r => !r.action), `controller: an open palm moving to the person's right drags the view right (${moved.toFixed(1)} deg), no action`);
  const still = run(C, Array.from({length: 12}, () => ({lm: hand(0.48, 0.5), g: "Open_Palm", score: 0.9})), 2000);
  check(still.slice(6).every(r => Math.abs(r.yaw) < 1e-9 && Math.abs(r.pitch) < 1e-9), "controller: the view stops when the hand stops");
  const C2 = handController(), F2 = Array.from({length: 8}, (_, i) => ({lm: hand(0.6 - 0.01 * i, 0.5 - 0.01 * i), g: i % 2 ? "None" : "Open_Palm", score: 0.9}));
  const o2 = run(C2, F2);
  check(o2[1].yaw > 0 && o2.slice(1).every(r => r.state === "rotate" && r.yaw > 0), "controller: open palm rotates from frame 2 without dropping out when MediaPipe reports None mid-move"); }
{ const C = handController(), F = [];
  for (let i = 0; i < 4; i++) F.push({lm: hand(0.5, 0.5, 0.2, 0.2), g: "None", score: 0.5});
  for (let i = 0; i < 10; i++) F.push({lm: hand(0.5, 0.5, 0.2 + 0.006 * i, 0.2), g: "None", score: 0.5});
  const o = run(C, F), z = o.slice(4).reduce((a, r) => a * r.zoom, 1);
  check(o.every(r => r.state === "zoom") && z < 0.95 && o.every(r => r.yaw === 0), `controller: pinch pulled toward you zooms in (distance x${z.toFixed(3)}), no rotation`);
  const F2 = []; for (let i = 0; i < 10; i++) F2.push({lm: hand(0.5, 0.5, 0.26 - 0.006 * i, 0.2), g: "None", score: 0.5});
  const z2 = run(C, F2, 5000).slice(1).reduce((a, r) => a * r.zoom, 1); check(z2 > 1.05, `controller: pinch pushed away zooms out (x${z2.toFixed(3)})`); }
{ const C = handController(), F = [];
  for (let i = 0; i < 30; i++) F.push({lm: hand(0.6 - 0.01 * i, 0.5), g: "Closed_Fist", score: 0.9});
  const o = run(C, F);
  check(o.slice(3).every(r => r.state === "paused" && r.yaw === 0 && r.pitch === 0 && r.zoom === 1 && !r.action), "controller: a fist pauses: no rotation, zoom or action even while it moves");
  const back = run(C, Array.from({length: 6}, (_, i) => ({lm: hand(0.3 - 0.006 * i, 0.5), g: "Open_Palm", score: 0.9})), 4000);
  check(back.at(-1).state === "rotate", "controller: opening the hand resumes"); }
{ const C = handController(), F = [];
  for (let i = 0; i < 4; i++) F.push({lm: hand(0.7, 0.5), g: "Open_Palm", score: 0.9});
  for (let i = 1; i <= 6; i++) F.push({lm: hand(0.7 - 0.07 * i, 0.5), g: "Open_Palm", score: 0.9});
  const acts = run(C, F, 0, 40).map(r => r.action).filter(Boolean);
  check(acts.length === 1 && acts[0] === "next", `controller: a quick swipe to the person's right is next sightline (${acts})`);
  const D = handController(), G = [];
  for (let i = 0; i < 4; i++) G.push({lm: hand(0.3, 0.5), g: "Open_Palm", score: 0.9});
  for (let i = 1; i <= 6; i++) G.push({lm: hand(0.3 + 0.07 * i, 0.5), g: "Open_Palm", score: 0.9});
  const a2 = run(D, G, 0, 40).map(r => r.action).filter(Boolean); check(a2.length === 1 && a2[0] === "prev", `controller: a quick swipe left is previous (${a2})`); }
for (const [g, act] of [["Thumb_Up", "recentre"], ["Victory", "mode"], ["Pointing_Up", "orbit"]]) {
  const C = handController(), acts = run(C, Array.from({length: 24}, () => ({lm: hand(0.5, 0.5), g, score: 0.9}))).map(r => r.action).filter(Boolean);
  check(acts.length === 1 && acts[0] === act, `controller: ${g} held 2 s fires "${act}" once (${acts})`);
  const o = run(handController(), Array.from({length: 6}, () => ({lm: hand(0.5, 0.5), g, score: 0.9}))).at(-1);
  check(o.state === "hold" && o.sign === LABELS[g] && o.yaw === 0, `controller: while ${g} is held the state is "hold" with sign "${o.sign}" (the pill shows it)`); }
{ const C = handController(); run(C, [{lm: hand(0.5, 0.5), g: "Open_Palm", score: 0.9}]); const r = C.update(null, 200);
  check(r.state === "none" && r.yaw === 0, "controller: no hand is state none"); }

/* capability decisions */
{ const q = decideQuick;
  check(q({touch: false, tier: "high", cores: 8, hasCam: true}).camera === "ok" && q({touch: false, tier: "high", cores: 8, hasCam: true}).hands === true, "quick: a strong desktop with a camera is ok and enables hands");
  check(q({touch: true, tier: "high", cores: 8, mem: 8, w: 1024, h: 1366, hasCam: true}).def === "camera", "quick: an iPad-class tablet defaults to camera");
  check(q({touch: true, tier: "high", cores: 6, mem: 6, w: 393, h: 852, hasCam: true}).def === "camera", "quick: a premium phone (high tier, 6 cores) defaults to camera");
  const low = q({touch: true, tier: "low", cores: 4, mem: 2, w: 360, h: 780, hasCam: true});
  check(low.camera === "slow" && low.def === "tilt" && !low.hands, `quick: a low-tier phone defaults to tilt, camera offered as slow (${JSON.stringify(low)})`);
  const mid = q({touch: true, tier: "mid", cores: 4, mem: 4, w: 390, h: 844, hasCam: true});
  check(mid.camera === "slow" && mid.def === "tilt" && !mid.hands, `quick: a mid 4-core phone defaults to tilt (${JSON.stringify(mid)})`);
  const midDesk = q({touch: false, tier: "mid", cores: 4, mem: 4, hasCam: true});
  check(midDesk.camera === "ok" && !midDesk.hands, `quick: a mid 4-core desktop defaults to head-only (hands false) to stay fast (${JSON.stringify(midDesk)})`);
  const heavy3d = q({touch: false, tier: "mid", cores: 8, hasCam: true, movingMs: 50});
  check(heavy3d.camera === "ok" && !heavy3d.hands, `quick: a heavy 3D moving frame (> 35 ms) on mid tier defaults to head-only (${JSON.stringify(heavy3d)})`);
  const heavyHigh = q({touch: false, tier: "high", cores: 8, hasCam: true, movingMs: 50});
  check(heavyHigh.camera === "ok" && !heavyHigh.hands, `quick: a heavy 3D moving frame (> 35 ms) on high tier also defaults to head-only (${JSON.stringify(heavyHigh)})`);
  check(q({touch: true, tier: "high", cores: 8, hasCam: false}).camera === "none" && q({touch: true, hasCam: false}).def === "tilt", "quick: no camera, no camera option");
  check(q({touch: false, tier: "low", cores: 2, hasCam: true}).camera === "slow" && q({touch: false, tier: "low", cores: 2, hasCam: true}).def === "camera" && !q({touch: false, tier: "low", cores: 2, hasCam: true}).hands, "quick: a weak desktop keeps camera (no tilt) in head-only mode and says slow"); }
{ const b = decideBench;
  check(b(18).plan === "full" && b(18).fps === 24, "bench: under 30 ms is full rate");
  check(b(45).plan === "reduced" && b(45).fps === 12 && b(45).hint === "", "bench: 30 to 60 ms reduces the rate quietly");
  check(b(90, {touch: true}).plan === "tilt" && /Tilt/.test(b(90, {touch: true}).hint), "bench: slower on touch falls back to Tilt");
  check(b(85, {touch: false, both: true}).plan === "headOnly" && b(85, {touch: false, both: true}).dropHands && /Head only/.test(b(85, {touch: false, both: true}).hint), "bench: 60 to 110 ms on desktop with both trackers drops hands to Head only");
  check(b(130, {touch: false}).plan === "reduced" && b(130).fps === 6 && /slow/.test(b(130).hint), "bench: slower on desktop runs at 6 fps and says it may be slow");
  check(b(20, {tier: "low"}).plan === "reduced", "bench: a low tier never gets full rate"); }
{ const G = governor({warm: 5, both: false}); let r = null; for (const ms of [200, 20, 22, 19, 21]) r = G.update(ms) || r;
  check(r && r.fps === 24 && r.bench === 21, `governor: the median of the warm frames ignores a slow first frame (${JSON.stringify(r)})`);
  const steps = []; for (let i = 0; i < 200; i++) { const x = G.update(80); if (x) steps.push(x.fps); }
  check(steps[0] === 12 && steps[1] === 6, `governor: frame times that climb step the rate down 24 -> 12 -> 6 (${steps})`);
  const Gh = governor({warm: 3, both: true, touch: false}); for (const ms of [20, 20, 20]) Gh.update(ms);
  let dropped = null; for (let i = 0; i < 120 && !dropped?.dropHands; i++) dropped = Gh.update(90) || dropped;
  check(dropped && dropped.dropHands && /Head only/.test(dropped.hint), `governor: when both trackers stay > 75 ms on desktop, drops hands first (${JSON.stringify(dropped)})`);
  const T = governor({warm: 3, touch: true}); for (const ms of [20, 20, 20]) T.update(ms); let tl = null;
  for (let i = 0; i < 300 && !tl?.tilt; i++) tl = T.update(150) || tl;
  check(tl && tl.tilt, "governor: on touch, still too slow at 6 fps falls back to Tilt"); }

console.log(`${n - bad}/${n} handmath checks passed`);
process.exit(bad ? 1 : 0);
