// Pure math for head and tilt control of the 3D view (headctl.js): pose from the Face Landmarker's facial transformation
// matrix, a One Euro filter, the dead zone and sensitivity map, the off-axis (head-coupled) projection and the tilt pose.
// No DOM, no three.js, so tests/js/headctl_unit.mjs runs it in node.
//
// Pose = {yaw, pitch, roll} in degrees, yaw > 0 when the head turns to the person's right, pitch > 0 when they look up;
// {x, y, z} in cm, x to the person's right, y up, z the eye-to-camera distance. MediaPipe's face geometry space is the
// unmirrored camera frame (x to the image right, y up, z toward the viewer), so a face in front of the camera has z < 0,
// the person's right is the image's left (-x), and the face's +z axis tips toward -x when they turn right.

export const D2R = Math.PI / 180, R2D = 180 / Math.PI;

/** Pose from a 4x4 column-major matrix (16 numbers, as MediaPipe's Matrix.data). */
export function poseFromMatrix(m) {
  if (!m || m.length < 16) return null;
  const s = Math.hypot(m[0], m[1], m[2]) || 1;              // the canonical face model can carry a uniform scale
  const r = i => m[i] / s;                                   // r(col*4+row)
  const R10 = r(1), R11 = r(5), R12 = r(9), R02 = r(8), R22 = r(10);
  const pitch = -Math.asin(Math.max(-1, Math.min(1, -R12))) * R2D;   // raw R = Ry(-yaw) Rx(-pitch) Rz(roll)
  const yaw = -Math.atan2(R02, R22) * R2D, roll = Math.atan2(R10, R11) * R2D;
  return {yaw, pitch, roll, x: -m[12], y: m[13], z: -m[14]};
}

/** The matrix poseFromMatrix inverts (tests, and a check of the angle order). */
export function matrixFromPose({yaw = 0, pitch = 0, roll = 0, x = 0, y = 0, z = 50}, scale = 1) {
  const [cy, sy, cx, sx, cz, sz] = [-yaw, -yaw, -pitch, -pitch, roll, roll].map((a, i) => (i % 2 ? Math.sin : Math.cos)(a * D2R));
  const Ry = [[cy, 0, sy], [0, 1, 0], [-sy, 0, cy]], Rx = [[1, 0, 0], [0, cx, -sx], [0, sx, cx]], Rz = [[cz, -sz, 0], [sz, cz, 0], [0, 0, 1]];
  const mul = (A, B) => A.map((row, i) => B[0].map((_, j) => row.reduce((t, _, k) => t + A[i][k] * B[k][j], 0)));
  const R = mul(mul(Ry, Rx), Rz), out = new Array(16).fill(0);
  for (let c = 0; c < 3; c++) for (let rw = 0; rw < 3; rw++) out[c * 4 + rw] = R[rw][c] * scale;
  out[12] = -x; out[13] = y; out[14] = -z; out[15] = 1;
  return out;
}

/** One Euro filter (Casiez, Roussel and Vogel 2012): a low-pass whose cutoff rises with speed. t in seconds. */
export function oneEuro({minCutoff = 1, beta = 0.02, dCutoff = 1} = {}) {
  let xPrev = null, dxPrev = 0, tPrev = 0;
  const alpha = (fc, dt) => 1 / (1 + 1 / (2 * Math.PI * fc * dt));
  return {
    filter(x, t) {
      if (xPrev === null || !(t > tPrev)) { const first = xPrev === null; if (first) { xPrev = x; tPrev = t; } return xPrev; }
      const dt = t - tPrev, dx = (x - xPrev) / dt, aD = alpha(dCutoff, dt);
      dxPrev = aD * dx + (1 - aD) * dxPrev;
      const a = alpha(minCutoff + beta * Math.abs(dxPrev), dt);
      xPrev = a * x + (1 - a) * xPrev; tPrev = t; return xPrev;
    },
    reset() { xPrev = null; dxPrev = 0; tPrev = 0; },
  };
}

/** Dead zone then a linear gain: |v| <= dead gives 0, beyond it the excess times gain (continuous at the edge). */
export const deadGain = (v, dead, gain) => (Math.abs(v) <= dead ? 0 : Math.sign(v) * (Math.abs(v) - dead) * gain);
export const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

/** Orbit mode: pose relative to the neutral pose -> {yaw, pitch} view turn in degrees and a zoom factor (> 1 = farther).
 *  Position mapping: the view follows the head, so a neutral head means the start view. */
export function orbitMap(p, ref, {sens = 1, invert = false, dead = 3, gain = 2.5, maxDeg = 80, zoomGain = 1.5, zoomDead = 0.04} = {}) {
  const s = invert ? -1 : 1;
  const yaw = clamp(s * deadGain(p.yaw - ref.yaw, dead, gain * sens), -maxDeg, maxDeg);
  const pitch = clamp(s * deadGain(p.pitch - ref.pitch, dead, gain * sens), -maxDeg, maxDeg);
  const r = ref.z > 0 && p.z > 0 ? Math.log(p.z / ref.z) : 0;      // leaning in: r < 0, zoom in
  return {yaw, pitch, zoom: Math.exp(deadGain(r, zoomDead, zoomGain * sens))};
}

/** Window mode: head offset from neutral -> eye offset in units of the screen's half-height (ex, ey) and the eye distance
 *  as a multiple of the start distance (ez). halfCm: the screen's assumed physical half-height. */
export function windowMap(p, ref, {sens = 1, invert = false, halfCm = 10, dead = 0.3, maxH = 1.5} = {}) {
  const s = invert ? -1 : 1, k = sens / halfCm;
  return {ex: clamp(s * deadGain(p.x - ref.x, dead, k), -maxH, maxH), ey: clamp(s * deadGain(p.y - ref.y, dead, k), -maxH, maxH),
    ez: ref.z > 0 && p.z > 0 ? clamp(1 + (p.z / ref.z - 1) * sens, 0.4, 2.5) : 1};
}

/** OpenGL perspective matrix for an asymmetric frustum (column-major, as glFrustum and three's makePerspective). */
export function frustum(l, r, b, t, n, f) {
  return [2 * n / (r - l), 0, 0, 0, 0, 2 * n / (t - b), 0, 0, (r + l) / (r - l), (t + b) / (t - b), -(f + n) / (f - n), -1, 0, 0, -2 * f * n / (f - n), 0];
}
/** The symmetric frustum of a vertical field of view (degrees) and aspect, as three's PerspectiveCamera. */
export function symmetric(fovDeg, aspect, n, f) { const t = n * Math.tan(fovDeg * D2R / 2), r = t * aspect; return frustum(-r, r, -t, t, n, f); }
/** Head-coupled projection: the screen is a window of half-height h (world units) at distance d in front of the start eye,
 *  centred on the view axis. The eye sits at (ex, ey) * h across and ez * d back from it; the frustum passes through the
 *  window's edges, so objects at the window plane do not move on screen and nearer or farther ones show parallax. */
export function offAxis({ex = 0, ey = 0, ez = 1, h, d, aspect, near, far}) {
  const dist = ez * d, k = near / dist, w = h * aspect, x = ex * h, y = ey * h;
  return {m: frustum((-w - x) * k, (w - x) * k, (-h - y) * k, (h - y) * k, near, far), eye: [x, y, dist - d]};
}

/** Exponential smoothing step toward a target pose or offset (60 fps render-loop interpolation between tracker frames).
 *  tau: time constant in seconds (~0.045 s = 45 ms); snap: threshold below which cur snaps to target. */
export function stepToward(cur, target, dt, {tau = 0.045, snap = 1e-3} = {}) {
  if (!target) return {val: null, moved: false};
  if (!cur || !(dt > 0) || dt > 0.5) return {val: {...target}, moved: true};
  const a = 1 - Math.exp(-dt / tau), next = {}; let moved = false;
  for (const k of Object.keys(target)) {
    const d = target[k] - cur[k];
    if (Math.abs(d) > snap) { next[k] = cur[k] + a * d; moved = true; }
    else next[k] = target[k];
  }
  return {val: next, moved};
}

/** Tilt pose from DeviceOrientationEvent beta (front-back) and gamma (left-right), rotated into screen axes by the screen
 *  orientation angle (0, 90, 180, 270). Tilting the right edge down (gamma up) turns the screen to the right, so the eye
 *  sits to its left; tilting the top toward you (beta up) leaves the eye below the screen's normal. dist: the assumed
 *  viewing distance in cm. Callers subtract the neutral pose, so only changes in tilt matter. */
export function tiltPose(beta, gamma, angle = 0, dist = 40) {
  const a = ((angle % 360) + 360) % 360, c = Math.round(Math.cos(a * D2R)), s = Math.round(Math.sin(a * D2R));
  const yaw = c * gamma + s * beta, pitch = c * beta - s * gamma, t = v => Math.tan(clamp(v, -60, 60) * D2R);
  return {yaw, pitch, roll: 0, x: -dist * t(yaw), y: -dist * t(pitch), z: dist};
}
