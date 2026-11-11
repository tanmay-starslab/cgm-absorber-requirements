// Transfer-function volume mode: the pure TF model in docs/tng50/js/tf.js (band list -> 256×64 RGBA texture, presets
// incl. THOR Fig. 11 "Gas phases", URL encode/decode, histograms, gradient) and the TF part of the shader text and
// uniforms in raymarch.js (sampler budget, uniforms off by default, the THOR compositing line). No Python, no browser.
// (The float-exact identity of every non-TF mode against the previous shader was checked in a WebGL2 harness; this file
// pins the text-level guarantees: TF code runs only under uTFOn with uMode 1 outside velocity views.)
// Usage: node tests/js/tf_unit.mjs
import {TF_W, TF_H, MAX_BANDS, PRESETS, PRESET_LABELS, THOR, GMAX_DEFAULT, evalTF, buildTF, preset, encodeTF, decodeTF,
  histogram, histogram2D, gradAt, gradMask, tfUniforms, defaultWRef} from "../../docs/tng50/js/tf.js";
import {lut} from "../../docs/tng50/js/colormaps.js";
import {FRAG, makeMaterial} from "../../docs/tng50/js/raymarch.js";

let fails = 0; const check = (ok, msg) => { console.log(`${ok ? "ok  " : "FAIL"} ${msg}`); if (!ok) fails++; };
const near = (a, b, e = 1e-6) => Math.abs(a - b) <= e;
const px = (tex, i, j = 0) => [...tex.slice((j * TF_W + i) * 4, (j * TF_W + i) * 4 + 4)];
const ctxNH = {field: "nH", vmin: -6, vmax: 0.4, volWin: [-4.4, 0.4]}, ctxT = {field: "T", vmin: 3.9, vmax: 7.6, volWin: [6.0, 7.6]};
const L = lut("inferno");

/* texture layout and the default ramp (today's look: alpha x², colormap colour over the volume window) */
{ const st = preset("ramp", ctxNH), tex = buildTF(st, L);
  check(tex.length === 256 * 64 * 4 && TF_W === 256 && TF_H === 64, "buildTF: 256 × 64 RGBA8 bytes");
  let rowsEq = true; for (let j = 1; j < TF_H; j++) for (let i = 0; i < TF_W * 4; i++) if (tex[j * TF_W * 4 + i] !== tex[i]) rowsEq = false;
  check(rowsEq, "1D TF: all 64 gradient rows are equal");
  /* texel i = value win[0] + i/255 (win[1] − win[0]); the ramp's x on the volume window */
  let ok = true, worst = 0;
  for (let i = 0; i < TF_W; i++) { const v = -6 + i / 255 * 6.4, x = Math.min(1, Math.max(0, (v + 4.4) / 4.8)), p = px(tex, i);
    worst = Math.max(worst, Math.abs(p[3] - Math.round(255 * x * x)));
    if (x > 0 && Math.abs(p[0] - L[Math.round(x * 255) * 4]) > 0) ok = false; }
  check(worst === 0 && ok, `ramp preset: alpha = 255·x², colour = colormap(x) on the volume window (max |Δα| ${worst})`);
  check(px(tex, 0)[3] === 0 && px(tex, 255)[3] === 255, "ramp: transparent below the volume window, opaque at its top"); }

/* THOR Fig. 11 preset: peaks at 2e4, 1e5, 3e5 K, blue/orange/red, density-weighted emissivity */
{ const st = preset("thor", ctxT);
  check(st.field === "T" && st.emis === "nH" && st.gamma === 1 && st.bands.length === 3, "THOR preset: colour field T, emissivity n_H, γ = 1, three bands");
  check(near(st.bands[0].c, Math.log10(2e4)) && near(st.bands[1].c, 5) && near(st.bands[2].c, Math.log10(3e5)), "THOR peaks at log T = 4.301, 5.000, 5.477");
  const [b, o, r] = st.bands.map(x => x.rgb);
  check(b[2] > b[0] && b[2] > b[1] && o[0] > o[1] && o[1] > o[2] && r[0] > 2 * r[1], "THOR colours: blue (cold), orange (warm), red (hot)");
  for (const bd of st.bands) { const e = evalTF(st, bd.c, 0, L);
    check(near(e[3], bd.a, 2e-3) && e.slice(0, 3).every((c, i) => Math.abs(c - bd.rgb[i]) < 3), `THOR at log T ${bd.c.toFixed(3)}: alpha ${e[3].toFixed(3)} ≈ height ${bd.a}, colour = the band's`); }
  const tex = buildTF(st, L), i4 = Math.round((Math.log10(2e4) - st.win[0]) / (st.win[1] - st.win[0]) * 255), iv = Math.round((6.2 - st.win[0]) / (st.win[1] - st.win[0]) * 255);
  check(px(tex, i4)[3] > 200 && px(tex, iv)[3] === 0, "THOR texture: opaque at the cold peak, transparent at 10^6.2 K (between and above the peaks)");
  check(st.win[0] <= 4.0 && st.win[1] >= 5.8, `THOR window [${st.win}] covers the three peaks`); }

/* combination rule: alpha adds (clamped), colour is the alpha-weighted mean; empty texels keep the nearest colour */
{ const st = {bands: [{c: 0, w: 0.2, a: 0.6, rgb: [255, 0, 0]}, {c: 0, w: 0.2, a: 0.6, rgb: [0, 0, 255]}], win: [-2, 2], twoD: false};
  const e = evalTF(st, 0); check(near(e[3], 1) && near(e[0], 127.5, 1e-6) && near(e[2], 127.5, 1e-6), "two equal bands on one value: alpha min(1, 1.2) = 1, colour the mean");
  const one = {bands: [{c: 0, w: 0.1, a: 0.5, rgb: [0, 200, 0]}], win: [-5, 5], twoD: false}, far = evalTF(one, 4.5);
  check(far[3] === 0 && far[1] === 200, "far from every band: alpha 0 but the band's colour (no black bleed under linear filtering)");
  const cm = {bands: [{c: 0, w: 0.3, a: 1, rgb: null}], win: [-1, 1], twoD: false}, ec = evalTF(cm, 0, 0, L);
  check(Math.abs(ec[0] - L[128 * 4]) <= 1, "a band with rgb null takes the colormap colour at its value"); }

/* 2D: gradient ranges give rows that differ; gradMask */
{ check(gradMask({}, 0.3) === 1 && gradMask({g: [0.5, 1]}, 0.1) === 0 && gradMask({g: [0.5, 1]}, 0.9) === 1 && gradMask({g: [0, 0.3]}, 0.9) === 0 && gradMask({g: [0, 0.3]}, 0) === 1,
    "gradMask: 1 without a range, 0 outside [g0, g1], 1 inside, open ends at 0 and 1");
  const st = preset("clouds", ctxNH), tex = buildTF(st, L);
  check(st.twoD && st.shade > 0 && st.ramp.g, "Clouds (2D) preset: 2D on, shading on, ramp limited to a gradient range");
  check(px(tex, 255, 0)[3] === 0 && px(tex, 255, 63)[3] === 255, "Clouds (2D): flat regions (row 0) transparent, steep ones (row 63) opaque");
  const iso = preset("iso", ctxNH); check(iso.bands.length === 3 && iso.bands.every(b => b.rgb === null && b.w < 0.2), "Iso bands: three narrow colormap bands");
  check(PRESETS.every(p => PRESET_LABELS[p]) && PRESET_LABELS.thor === "Gas phases (THOR)", "preset labels for the editor"); }

/* URL encode/decode */
{ for (const p of PRESETS) { const st = preset(p, ctxNH), s = encodeTF(st, ctxNH);
    check(s === "P" + p && encodeTF(decodeTF(s, ctxNH)) === encodeTF(st), `encode/decode: unchanged preset '${p}' -> '${s}'`); }
  const st = {...preset("thor", ctxT), shade: 0.4, twoD: true, gmax: 0.8}; st.bands[1] = {...st.bands[1], g: [0.2, 0.9], c: 5.05};
  st.bands.push({c: 4.7, w: 0.05, a: 0.3, rgb: null});
  const s = encodeTF(st, ctxT), d = decodeTF(s, ctxT);
  check(/^[A-Za-z0-9_.~-]+$/.test(s) && encodeURIComponent(s) === s, `edited state encodes URL-safe (${s.length} chars): ${s}`);
  check(encodeTF(d) === encodeTF(st) && d.bands.length === 4 && d.bands[1].g[0] === 0.2 && d.bands[3].rgb === null && d.twoD && d.gmax === 0.8 && d.emis === "nH" && d.field === "T",
    "edited state round-trips (bands, gradient range, colormap band, 2D, shading, emissivity, window, gmax, field)");
  check(near(d.bands[0].c, +Math.log10(2e4).toFixed(3)), "positions round to 0.001 dex");
  for (const bad of ["", "X1", "B1_2", "Bq_1_1_ffffff", "B1_1_1_zzzzzz", "W2_1", "E1x_1", "Pnope", "G-1"]) check(decodeTF(bad, ctxNH) === null, `decodeTF rejects '${bad}'`);
  const many = Array.from({length: 12}, (_, i) => `B${i}_1_1_m`).join("~"); check(decodeTF(many, ctxNH).bands.length === MAX_BANDS, `at most ${MAX_BANDS} bands`);
  const cl = decodeTF("B0_-0.5_7_ff0000~S3~E nH_1".replace(" ", ""), ctxNH);
  check(cl && cl.bands[0].w === 0.5 && cl.bands[0].a === 1 && cl.shade === 1, "decodeTF clamps alpha and shading to [0, 1], |width|"); }

/* histograms and gradient */
{ const n = 8, vmin = -6, vmax = 0.4, cube = new Uint8Array(n * n * n);
  for (let z = 0; z < n; z++) for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) cube[(z * n + y) * n + x] = x === 0 ? 0 : 1 + 10 * x;   /* log v linear in x */
  const h = histogram(cube, vmin, vmax, [vmin, vmax], 64);
  check(h.counts.reduce((a, b) => a + b, 0) === n * n * (n - 1), "histogram: counts every non-empty voxel once (q 0 skipped)");
  check(Math.max(...h.logc) === 1 && h.logc.every(x => x >= 0), "histogram: log counts normalised to 0..1");
  const hw = histogram(cube, vmin, vmax, [-5, -4], 16); check(hw.counts.reduce((a, b) => a + b, 0) < n * n * (n - 1), "histogram over a narrower window drops values outside it");
  const g = gradAt(cube, n, vmin, vmax, 3, 3, 3), s = (vmax - vmin) / 254;
  check(near(g, 10 * s, 1e-9), `gradAt: central difference in dex per voxel (${g.toFixed(4)} = 10 q · ${s.toFixed(4)} dex)`);
  check(gradAt(cube, n, vmin, vmax, 1, 3, 3) === -1 && gradAt(cube, n, vmin, vmax, 0, 3, 3) === -1, "gradAt: -1 next to an empty voxel or at the border");
  const h2 = histogram2D(cube, n, vmin, vmax, [vmin, vmax], 1, 32, 8, 1);
  check(h2.counts.length === 32 * 8 && h2.counts.reduce((a, b) => a + b, 0) > 0 && near(h2.p99, 0.2578, 0.01), `histogram2D: value × gradient counts, p99 |∇| ${h2.p99.toFixed(3)} dex/voxel`); }

/* uniform values */
{ const u = tfUniforms(preset("thor", ctxT), {wRef: defaultWRef({vol_window: [-4.4, 0.4]})});
  check(u.uTFOn === 1 && u.uTFW === 1 && u.uGamma === 1 && near(u.uWRef, -3.92) && u.uTF2D === 0 && u.uGradMax === GMAX_DEFAULT && u.uTFWin[0] === THOR.win[0],
    "tfUniforms(THOR): TF on, emissivity on with γ 1 and w_ref = 10^-2 (middle of the n_H volume window), 1D");
  const r = tfUniforms(preset("ramp", ctxNH)); check(r.uTFW === 0 && r.uGamma === 0 && r.uShade === 0, "tfUniforms(ramp): no emissivity, no shading"); }

/* shader text and makeMaterial */
{ const samplers = [...FRAG.matchAll(/uniform\s+sampler(?:2D|3D)\s+([^;]+);/g)].flatMap(m => m[1].split(",").map(s => s.trim()));
  check(samplers.length <= 16 && samplers.includes("uTF") && samplers.includes("uLut"), `samplers ${samplers.length} ≤ 16, uTF added next to uLut`);
  check(/bool tfMode = uTFOn == 1 && uMode == 1 && !velMode/.test(FRAG), "TF mode only with uTFOn = 1, volume mode, outside velocity views");
  check(/C \+= \(1\.0 - A\) \* a \* W \* shadeTF\(tf\.rgb, g, gn, d\); A \+= \(1\.0 - A\) \* a;/.test(FRAG), "THOR front-to-back compositing: C += T a c W, A += T a");
  check(/exp2\(uGamma \* \(log2\(w\) - LOG2_10 \* uWRef\)\)/.test(FRAG), "emissivity W = (w / 10^uWRef)^uGamma");
  check(/if \(uTF2D == 1\) \{ g = gradAt\(p, lg\)/.test(FRAG) && /if \(uShade > 0\.0 && uTF2D != 1\) \{ g = gradAt/.test(FRAG), "gradient fetched only for a 2D TF or shading (and then only where alpha > 0)");
  check((FRAG.match(/qAt\(t [+-] vec3/g) || []).length === 6, "gradient: 6 extra fetches (central differences)");
  const fake = new Proxy({}, {get: (_, k) => k === "Data3DTexture" || k === "DataTexture" || k === "ShaderMaterial" || k === "Vector2" || k === "Vector3" ? function (...a) { this.a = a; this.image = {data: a[0]}; } : k});
  const RM = makeMaterial(fake, {n: 64}), U = RM.uniforms;
  check(["uTF", "uTFOn", "uTFWin", "uTF2D", "uShade", "uGradMax", "uTFW", "uGamma", "uWRef"].every(k => k in U) && U.uTFOn.value === 0 && U.uTFW.value === 0,
    "makeMaterial: TF uniforms exist, off by default");
  check(RM.tfTex && RM.tfTex.a[0].length === 256 * 64 * 4 && RM.tfTex.a[1] === 256 && RM.tfTex.a[2] === 64 && U.uTF.value === RM.tfTex, "makeMaterial: tfTex 256 × 64 RGBA bound to uTF and returned");
  const declared = new Set([...FRAG.matchAll(/uniform\s+\w+\s+([^;]+);/g)].flatMap(m => m[1].split(",").map(s => s.trim())));
  check([...declared].every(k => k in U), `every declared uniform has a value in makeMaterial (${declared.size})`); }

console.log(fails ? `\n${fails} check(s) FAILED` : "\nall checks passed");
process.exit(fails ? 1 : 0);
