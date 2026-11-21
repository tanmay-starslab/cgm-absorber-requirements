// Unit checks of the head and tilt control math (docs/tng50/js/headmath.js): pose from the facial transformation matrix,
// the One Euro filter, the dead zone and sensitivity map, the off-axis projection and the tilt pose.
// Usage: node tests/js/headctl_unit.mjs
import {poseFromMatrix, matrixFromPose, oneEuro, deadGain, orbitMap, windowMap, frustum, symmetric, offAxis, tiltPose, stepToward} from "../../docs/tng50/js/headmath.js";

let n = 0, bad = 0;
const check = (ok, msg) => { n++; if (!ok) { bad++; console.log("FAIL " + msg); } else console.log("ok " + msg); };
const near = (a, b, e = 1e-6) => Math.abs(a - b) <= e;
const allNear = (A, B, e = 1e-9) => A.length === B.length && A.every((x, i) => near(x, B[i], e));

/* pose <-> matrix: round trip at several poses, with and without the model scale */
for (const p of [{yaw: 0, pitch: 0, roll: 0, x: 0, y: 0, z: 50}, {yaw: 20, pitch: -10, roll: 5, x: 3, y: -2, z: 45}, {yaw: -35, pitch: 25, roll: -12, x: -6, y: 4, z: 70}]) {
  for (const sc of [1, 1.7]) { const q = poseFromMatrix(matrixFromPose(p, sc));
    check(["yaw", "pitch", "roll", "x", "y", "z"].every(k => near(q[k], p[k], 1e-6)), `pose round trip ${JSON.stringify(p)} scale ${sc}: ${JSON.stringify(q)}`); }
}
/* the convention against MediaPipe's camera frame: a person turning to their right points the face's +z at the image's -x */
{ const yawR = 30 * Math.PI / 180, m = [Math.cos(yawR), 0, Math.sin(yawR), 0, 0, 1, 0, 0, -Math.sin(yawR), 0, Math.cos(yawR), 0, 4, 2, -55, 1];
  const p = poseFromMatrix(m);
  check(near(p.yaw, 30, 1e-6) && near(p.pitch, 0) && near(p.x, -4) && near(p.y, 2) && near(p.z, 55), `face +z toward image -x is yaw +30 (person's right); image x +4 is the person's left: ${JSON.stringify(p)}`); }
{ const a = 15 * Math.PI / 180, m = [1, 0, 0, 0, 0, Math.cos(a), -Math.sin(a), 0, 0, Math.sin(a), Math.cos(a), 0, 0, 0, -50, 1];   // face +z tipped toward +y (up)
  check(near(poseFromMatrix(m).pitch, 15, 1e-6), `face +z tipped up is pitch +15 (looking up): ${poseFromMatrix(m).pitch}`); }
check(poseFromMatrix(null) === null && poseFromMatrix([1, 2]) === null, "poseFromMatrix rejects a missing or short matrix");

/* One Euro: the first sample passes through, a constant stays constant, a step converges, jitter is reduced */
{ const f = oneEuro({minCutoff: 1, beta: 0}); check(f.filter(5, 0) === 5, "one euro: the first sample passes through");
  let y = 0; for (let i = 1; i <= 30; i++) y = f.filter(5, i / 30); check(near(y, 5, 1e-12), "one euro: a constant input stays constant");
  const g = oneEuro({minCutoff: 1, beta: 0}); g.filter(0, 0); const y1 = g.filter(1, 1 / 30); let yN = y1; for (let i = 2; i <= 150; i++) yN = g.filter(1, i / 30);
  check(y1 > 0 && y1 < 0.3 && yN > 0.99, `one euro: a step is smoothed (${y1.toFixed(3)} after one frame) and converges (${yN.toFixed(4)} after 5 s)`);
  const a = 1 / (1 + 1 / (2 * Math.PI * 1 / 30)); check(near(y1, a, 1e-12), `one euro: first-step gain equals alpha(fc, dt) = ${a.toFixed(4)}`);
  const h = oneEuro({minCutoff: 1, beta: 0}); let sIn = 0, sOut = 0; let prev = h.filter(0, 0);
  for (let i = 1; i <= 300; i++) { const x = (i % 2 ? 1 : -1); const o = h.filter(x, i / 30); sIn += x * x; sOut += o * o; prev = o; }
  check(sOut / sIn < 0.1, `one euro: 15 Hz jitter at 30 fps loses > 90 % of its power (kept ${(100 * sOut / sIn).toFixed(1)} %)`);
  const fast = oneEuro({minCutoff: 1, beta: 1}), slow = oneEuro({minCutoff: 1, beta: 0}); fast.filter(0, 0); slow.filter(0, 0);
  check(fast.filter(10, 1 / 30) > slow.filter(10, 1 / 30), "one euro: beta raises the cutoff for fast motion (less lag)");
  h.reset(); check(h.filter(7, 100) === 7, "one euro: reset forgets the state"); }

/* dead zone and sensitivity */
check(deadGain(2, 3, 5) === 0 && deadGain(-3, 3, 5) === 0, "dead zone: inside is zero");
check(near(deadGain(5, 3, 2), 4) && near(deadGain(-5, 3, 2), -4), "dead zone: the excess times the gain, odd in v");
check(near(deadGain(3 + 1e-9, 3, 2), 0, 1e-8), "dead zone: continuous at its edge");
{ const ref = {yaw: 2, pitch: -1, x: 0, y: 0, z: 50};
  const o0 = orbitMap({yaw: 3, pitch: 0, z: 50}, ref);
  check(o0.yaw === 0 && o0.pitch === 0 && near(o0.zoom, 1), `orbit: a pose within the dead zone of neutral does not move: ${JSON.stringify(o0)}`);
  const o1 = orbitMap({yaw: 12, pitch: -1, z: 50}, ref), o2 = orbitMap({yaw: 12, pitch: -1, z: 50}, ref, {sens: 2}), oi = orbitMap({yaw: 12, pitch: -1, z: 50}, ref, {invert: true});
  check(near(o1.yaw, (10 - 3) * 2.5) && near(o2.yaw, 2 * o1.yaw) && near(oi.yaw, -o1.yaw), `orbit: yaw ${o1.yaw}, doubled by sensitivity 2 (${o2.yaw}), negated by invert (${oi.yaw})`);
  check(orbitMap({yaw: 90, pitch: 0, z: 50}, ref, {sens: 3}).yaw === 80, "orbit: the turn is clamped to 80 degrees");
  const zin = orbitMap({yaw: 2, pitch: -1, z: 35}, ref), zout = orbitMap({yaw: 2, pitch: -1, z: 70}, ref);
  check(zin.zoom < 1 && zout.zoom > 1, `orbit: leaning in zooms in (${zin.zoom.toFixed(3)}), leaning back zooms out (${zout.zoom.toFixed(3)})`);
  const w0 = windowMap({x: 0.2, y: -0.1, z: 50}, ref), w1 = windowMap({x: 5.3, y: 0, z: 50}, ref, {halfCm: 10});
  check(w0.ex === 0 && w0.ey === 0 && w0.ez === 1, `window: a neutral head is the centred eye: ${JSON.stringify(w0)}`);
  check(near(w1.ex, 0.5) && windowMap({x: 50, y: 0, z: 50}, ref).ex === 1.5 && near(windowMap({x: 0, y: 0, z: 100}, ref).ez, 2), `window: 5.3 cm right is 0.5 half-heights (${w1.ex}), clamped at 1.5; twice as far is ez 2`); }

/* projection: frustum() is the OpenGL glFrustum matrix; offAxis with a centred head is the symmetric frustum */
{ const [l, r, b, t, nn, f] = [-1.2, 0.8, -0.5, 0.9, 0.5, 2000], m = frustum(l, r, b, t, nn, f);
  const ref = [2 * nn / (r - l), 0, 0, 0, 0, 2 * nn / (t - b), 0, 0, (r + l) / (r - l), (t + b) / (t - b), -(f + nn) / (f - nn), -1, 0, 0, -2 * f * nn / (f - nn), 0];
  check(allNear(m, ref), "frustum matches the glFrustum formula (column-major)");
  /* a point on the near plane at (r, t) maps to clip (1, 1) */
  const P = [r, t, -nn, 1], clip = [0, 1, 2, 3].map(i => m[i] * P[0] + m[4 + i] * P[1] + m[8 + i] * P[2] + m[12 + i] * P[3]);
  check(near(clip[0] / clip[3], 1) && near(clip[1] / clip[3], 1) && near(clip[2] / clip[3], -1), "frustum: the near plane's top-right corner maps to NDC (1, 1, -1)"); }
{ const fov = 22, aspect = 1.3, d = 800, h = d * Math.tan(fov * Math.PI / 360), o = offAxis({ex: 0, ey: 0, ez: 1, h, d, aspect, near: 0.5, far: 20000});
  check(allNear(o.m, symmetric(fov, aspect, 0.5, 20000), 1e-12) && allNear(o.eye, [0, 0, 0]), "off-axis with a centred head equals the symmetric frustum, eye unmoved");
  /* the window's edges stay fixed: eye moved right, the window plane's right edge (world x = w, z = -d from the start eye) still maps to x = 1 */
  const s = offAxis({ex: 0.4, ey: -0.3, ez: 0.8, h, d, aspect, near: 0.5, far: 20000}), [ex, ey, ez] = s.eye, w = h * aspect;
  const toNdc = (X, Y) => { const p = [X - ex, Y - ey, -d - ez, 1], c = [0, 1, 3].map(i => s.m[i] * p[0] + s.m[4 + i] * p[1] + s.m[8 + i] * p[2] + s.m[12 + i] * p[3]); return [c[0] / c[2], c[1] / c[2]]; };
  const tr = toNdc(w, h), bl = toNdc(-w, -h);
  check(near(tr[0], 1, 1e-9) && near(tr[1], 1, 1e-9) && near(bl[0], -1, 1e-9) && near(bl[1], -1, 1e-9), `off-axis: the window's corners stay at the screen corners when the eye moves (${tr.map(x => x.toFixed(6))}, ${bl.map(x => x.toFixed(6))})`);
  check(near(s.eye[0], 0.4 * h) && near(s.eye[1], -0.3 * h) && near(s.eye[2], 0.8 * d - d), `off-axis: eye at (${s.eye.map(x => x.toFixed(2))})`);
  /* parallax: a point behind the window shifts with the eye, a point in front shifts against it */
  const far0 = toNdc(0, 0), fx = (() => { const p = [0 - ex, 0 - ey, -2 * d - ez, 1], c = [0, 1, 3].map(i => s.m[i] * p[0] + s.m[4 + i] * p[1] + s.m[8 + i] * p[2] + s.m[12 + i] * p[3]); return c[0] / c[2]; })();
  check(fx > far0[0], `off-axis parallax: with the eye to the right, a point behind the window appears to the right of the window-plane point (${fx.toFixed(4)} > ${far0[0].toFixed(4)})`); }

/* tilt */
{ const p0 = tiltPose(0, 0), p1 = tiltPose(0, 20), p2 = tiltPose(20, 0), p3 = tiltPose(0, 20, 90), p4 = tiltPose(20, 0, 270);
  check(p0.yaw === 0 && p0.pitch === 0 && near(p0.x, 0) && near(p0.y, 0) && p0.z === 40, "tilt: flat is the zero pose at 40 cm");
  check(p1.yaw === 20 && p1.pitch === 0 && p1.x < 0, `tilt: gamma 20 (right edge down) is yaw 20 and the eye to the left (x ${p1.x.toFixed(2)})`);
  check(p2.pitch === 20 && p2.yaw === 0 && p2.y < 0, `tilt: beta 20 is pitch 20 and the eye below (y ${p2.y.toFixed(2)})`);
  check(near(p3.yaw, 0) && near(p3.pitch, -20) && near(tiltPose(20, 0, 90).yaw, 20), `tilt: landscape (90) swaps the axes: gamma 20 is pitch ${p3.pitch}, beta 20 is yaw ${tiltPose(20, 0, 90).yaw}`);
  check(near(p4.yaw, -20), `tilt: landscape the other way (270) flips the sign: yaw ${p4.yaw}`);
  check(Number.isFinite(tiltPose(0, 89).x) && Math.abs(tiltPose(0, 89).x) <= 40 * Math.tan(Math.PI / 3) + 1e-9, "tilt: extreme tilt is clamped to 60 degrees");
  const ref = tiltPose(30, -10), o = orbitMap(tiltPose(30, -10), ref);
  check(o.yaw === 0 && o.pitch === 0, "tilt: the current tilt as neutral gives no motion"); }

/* 60 fps interpolation stepToward */
{ const s0 = stepToward(null, {yaw: 20, pitch: -10, zoom: 1}, 1 / 60);
  check(s0.moved && s0.val.yaw === 20, "stepToward: first sample adopts the target at once");
  let cur = {yaw: 0, pitch: 0, zoom: 1}, steps = 0;
  for (let i = 0; i < 60; i++) { const r = stepToward(cur, {yaw: 20, pitch: 0, zoom: 1}, 1 / 60, {tau: 0.045, snap: 0.04}); cur = r.val; if (r.moved) steps++; }
  check(steps >= 8 && near(cur.yaw, 20, 0.05), `stepToward: smoothly interpolates across ${steps} 60-fps frames and snaps cleanly to target (${cur.yaw.toFixed(3)})`); }

console.log(bad ? `${bad} of ${n} checks failed` : `all ${n} checks passed`);
process.exit(bad ? 1 : 0);
