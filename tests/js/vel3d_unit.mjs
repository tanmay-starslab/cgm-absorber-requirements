// vel3d (3D velocity views): the pure helpers in docs/tng50/js/vizdata.js and colormaps.js, and the shader text in
// raymarch.js. Linear decoding (q = 128 is 0 km/s), the CPU packing of vx, vy, vz into one RGBA cube (empty voxels as
// q 128 with A = 0, so a trilinear blend divided by the blended A is the mean over the non-empty corners), the five derived
// quantities on hand-built vectors (v_los flips sign when the camera direction is reversed, v_phi > 0 for co-rotation,
// v_r > 0 for outflow), the ray moments (σ_los is unchanged by reversing the ray), the velocity LUTs and the texture-unit
// budget of the fragment shader. No Python, no browser.
// Usage: node tests/js/vel3d_unit.mjs
import {decodeLinear, encodeLinear, packVelocity, velQuantity, velRayMoment, VEL_VIEWS, VEL_KEYS, velocityList} from "../../docs/tng50/js/vizdata.js";
import {lut, NAMES, VEL_NAMES, VEL_STOPS} from "../../docs/tng50/js/colormaps.js";
import {FRAG, makeMaterial} from "../../docs/tng50/js/raymarch.js";

let fails = 0; const check = (ok, msg) => { console.log(`${ok ? "ok  " : "FAIL"} ${msg}`); if (!ok) fails++; };
const near = (a, b, e = 1e-6) => Math.abs(a - b) <= e;
const V = 300;

/* linear decoding (design: q = 1 + round((clip(v) + V) / 2V · 254); v = −V + (q − 1) 2V / 254) */
{ const d = decodeLinear(new Uint8Array([0, 1, 128, 255]), -V, V);
  check(Number.isNaN(d[0]) && near(d[1], -V) && near(d[2], 0) && near(d[3], V), `decodeLinear: q 0 empty, 1 → −V, 128 → 0, 255 → +V (${[...d].map(x => +x.toFixed(3)).join(", ")})`);
  const v = Float32Array.from({length: 601}, (_, i) => i - 300), q = encodeLinear(v, V), back = decodeLinear(q, -V, V);
  let m = 0; for (let i = 0; i < v.length; i++) m = Math.max(m, Math.abs(back[i] - v[i]));
  check(m <= V / 254 + 1e-4 && q.every(x => x >= 1), `encode/decode round trip within half a step (max |Δ| ${m.toFixed(3)} ≤ ${(V / 254).toFixed(3)} km/s), no q = 0 for finite v`);
  const c = encodeLinear(new Float32Array([-1e4, 1e4, NaN]), V);
  check(c[0] === 1 && c[1] === 255 && c[2] === 0, "encodeLinear clips to ±V and maps NaN to empty"); }

/* packing */
{ const qx = new Uint8Array([200, 0, 10]), qy = new Uint8Array([100, 0, 20]), qz = new Uint8Array([50, 0, 30]), p = packVelocity(qx, qy, qz);
  check(p.length === 12 && [...p.slice(0, 4)].join() === "200,100,50,255" && [...p.slice(4, 8)].join() === "128,128,128,0" && [...p.slice(8)].join() === "10,20,30,255",
    "packVelocity: RGBA = q of vx, vy, vz, A 255; empty voxel = (128, 128, 128, 0)");
  let e = null; try { packVelocity(qx, qy, new Uint8Array(2)); } catch (x) { e = x.message; }
  check(/differ/.test(e || ""), "packVelocity rejects component cubes of different sizes");
  /* the shader's blend: weights w over 2 corners, one empty: decode(Σ w q) / Σ w A = the non-empty corner's velocity */
  const vA = [120, -60, 30], qA = encodeLinear(Float32Array.from(vA), V), P = packVelocity(new Uint8Array([qA[0], 0]), new Uint8Array([qA[1], 0]), new Uint8Array([qA[2], 0]));
  for (const w of [0.9, 0.5, 0.2]) { const bl = [0, 1, 2, 3].map(c => w * P[c] + (1 - w) * P[4 + c]), a = bl[3] / 255;
    const v = [0, 1, 2].map(c => (-V + (bl[c] - 1) * 2 * V / 254) / a), dv = decodeLinear(qA, -V, V);
    check(v.every((x, i) => near(x, dv[i], 1e-3)), `trilinear blend with an empty corner (w ${w}): blend / A = (${v.map(x => x.toFixed(1)).join(", ")}) = the non-empty voxel`); } }

/* derived quantities (disk frame: ẑ = Lhat; d = unit camera ray direction) */
{ const p = [10, 0, 0], d = [0, 1, 0], v = [0, 150, 0];
  check(velQuantity("vlos", v, p, d) === 150 && velQuantity("vlos", v, p, d.map(x => -x)) === -150,
    "v_los = v·d: +150 moving away from the camera, −150 once the camera direction is reversed");
  check(velQuantity("vphi", [0, 200, 0], [10, 0, 0], d) === 200 && velQuantity("vphi", [-200, 0, 0], [0, 10, 0], d) === 200 && velQuantity("vphi", [0, -200, 0], [10, 0, 0], d) === -200,
    "v_phi > 0 for co-rotation about +ẑ (v = ẑ × p), < 0 for counter-rotation");
  check(near(velQuantity("vr", [30, 40, 0], [3, 4, 0], d), 50) && near(velQuantity("vr", [-30, -40, 0], [3, 4, 0], d), -50), "v_r > 0 outflow, < 0 inflow");
  check(velQuantity("vphi", [0, 0, 100], [0, 0, 5], d) === 0 && velQuantity("vr", [1, 2, 3], [0, 0, 0], d) === 0, "v_phi on the axis and v_r at the centre are 0 (no NaN)");
  check(velQuantity("vmag", [3, 4, 12], p, d) === 13, "|v| = length(v)");
  check(VEL_KEYS.join() === "vlos,vr,vphi,vmag,sigmalos" && VEL_VIEWS.map(x => x.q).join() === "1,2,3,4,5", "view keys vlos, vr, vphi, vmag, sigmalos = shader uVq 1..5");
  check(VEL_VIEWS.filter(x => x.signed).every(x => x.words?.length === 2) && VEL_VIEWS.filter(x => !x.signed).map(x => x.key).join() === "vmag,sigmalos",
    "signed views carry the two legend words; |v| and σ_los are sequential");
  check(VEL_VIEWS[0].words.join() === "toward you,away from you" && VEL_VIEWS.every(x => x.spoken && !/[|σφ]|\bv (los|r)\b/.test(x.spoken)),
    "v_los legend words are relative to you (the camera); every view has a plain spoken name (aria-label, status, announcements)");
  check(/no thermal or within-voxel motion/.test(VEL_VIEWS.find(x => x.key === "sigmalos").long), "σ_los description says thermal and within-voxel motion are left out"); }

/* ray moments: the integral mode's weighted mean (moment 1) and σ_los */
{ const d = [0, 0, 1], S = [{w: 1, v: [0, 0, 100], p: [0, 0, -5]}, {w: 1, v: [0, 0, -100], p: [0, 0, 5]}, {w: 0, v: [0, 0, 999], p: [0, 0, 0]}];
  check(near(velRayMoment("vlos", S, d), 0) && near(velRayMoment("sigmalos", S, d), 100), "two equal-weight clouds at ±100 km/s: ⟨v_los⟩ 0, σ_los 100 (zero-weight sample ignored)");
  const S2 = [{w: 3, v: [0, 0, 50], p: [0, 0, 0]}, {w: 1, v: [0, 0, -150], p: [0, 0, 0]}], m = velRayMoment("vlos", S2, d), s = velRayMoment("sigmalos", S2, d);
  check(near(m, 0) && near(s, Math.sqrt((3 * 2500 + 22500) / 4)), `weights 3:1 at +50 / −150: ⟨v_los⟩ = ${m}, σ_los = ${s.toFixed(2)}`);
  const mr = velRayMoment("vlos", [{w: 1, v: [0, 0, 80], p: [0, 0, 0]}], d.map(x => -x)), sr = velRayMoment("sigmalos", S2, d.map(x => -x));
  check(mr === -80 && near(sr, s), "reversing the ray flips ⟨v_los⟩ and keeps σ_los");
  check(Number.isNaN(velRayMoment("vlos", [], d)), "an empty ray has no moment (NaN)"); }

/* availability: an old manifest (no gas.vectors) lists the views disabled with a reason */
{ const L = velocityList(null), L2 = velocityList({gas: {fields: {}}});
  check(L.length === 5 && L.every(x => !x.available && x.group === "vel" && /no 3D data/.test(x.reason)) && L2.every(x => !x.available && /not built/.test(x.reason)),
    "velocityList: 5 views, disabled with a reason without a manifest or without gas.vectors"); }

/* colour maps */
{ const D = lut("tng_vel"), c = k => [D[4 * k], D[4 * k + 1], D[4 * k + 2]], lum = ([r, g, b]) => 0.2126 * r + 0.7152 * g + 0.0722 * b;
  const mid = c(128), lo = c(0), hi = c(255);
  check(Math.max(...mid) - Math.min(...mid) <= 12, `tng_vel is near-neutral at 0 (rgb ${mid.join(",")})`);
  check(lo[2] > lo[0] + 60 && hi[0] > hi[2] + 60, `tng_vel: blue at −W (${lo.join(",")}), red at +W (${hi.join(",")})`);
  check(lum(lo) > lum(mid) && lum(hi) > lum(mid), "tng_vel: both ends lighter than the centre (neither sign fades into the dark stage)");
  const Sp = lut("tng_speed"); let mono = true; for (let k = 8; k < 256; k += 8) if (lum([Sp[4 * k], Sp[4 * k + 1], Sp[4 * k + 2]]) < lum([Sp[4 * k - 32], Sp[4 * k - 31], Sp[4 * k - 30]] ) - 1 && k >= 32) mono = false;
  check(mono, "tng_speed: luminance rises along the map (sequential)");
  check(!NAMES.includes("tng_vel") && VEL_NAMES.signed[0] === "tng_vel" && VEL_NAMES.unsigned[0] === "tng_speed" && Object.values(VEL_STOPS).every(s => s.length === 33 * 8),
    "velocity maps are separate from the field-colour list (33 stops each)"); }

/* shader: 16 texture units at most, the velocity samplers and the per-frame ray projection */
{ const samplers = [...FRAG.matchAll(/uniform\s+sampler(?:2D|3D)\s+([^;]+);/g)].flatMap(m => m[1].split(",").map(s => s.trim()));
  check(samplers.length <= 16 && ["uVel0", "uVel1", "uVel2", "uW0", "uLut"].every(s => samplers.includes(s)), `fragment shader samplers: ${samplers.length} (≤ 16), uVel0..2 present`);
  check(/if \(uVq == 1 \|\| uVq == 5\) return dot\(v, d\)/.test(FRAG) && /vec2 t = vec2\(-p\.y, p\.x\)/.test(FRAG), "velQ: v·d for v_los / σ_los, ẑ × p for v_phi");
  const fake = new Proxy({}, {get: (_, k) => k === "Data3DTexture" || k === "DataTexture" || k === "ShaderMaterial" || k === "Vector2" || k === "Vector3" ? function (...a) { this.a = a; } : k});
  const RM = makeMaterial(fake, {n: 64});
  check(["uVel0", "uVel1", "uVel2", "uVelHave", "uVelV", "uVq", "uWWin"].every(k => k in RM.uniforms) && RM.uniforms.uVq.value === 0, "makeMaterial: velocity uniforms exist, uVq = 0 (off) by default"); }

console.log(fails ? `\n${fails} check(s) FAILED` : "\nall checks passed");
process.exit(fails ? 1 : 0);
