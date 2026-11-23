// Unit tests for docs/tng50/js/vizdata.js: L0..L4 and S0..S4 manifest validation, viewPlan deep ISM zoom (L3/S3 at hVis < 25,
// L4/S4 at hVis < 6.25), GAS_LEVELS / STAR_LEVELS defaults, and viewer3d.js dynamic 3-slot sliding window, sub-kpc scale bar,
// and real-time 3D dust lane attenuation toggle (#v3-dust).
import {readFileSync} from "node:fs";
import {join, dirname} from "node:path";
import {fileURLToPath} from "node:url";
import {GAS_LEVELS, STAR_LEVELS, SMOOTH, STAR_COMP, STAR_ZOOM, validateManifestV2, viewPlan, cubeRef} from "../../docs/tng50/js/vizdata.js";
import {FRAG} from "../../docs/tng50/js/raymarch.js";

const HERE = dirname(fileURLToPath(import.meta.url)), ROOT = join(HERE, "../..");
let fails = 0; const check = (ok, msg) => { console.log(`${ok ? "ok  " : "FAIL"} ${msg}`); if (!ok) fails++; };

/* ---- 1. GAS_LEVELS & STAR_LEVELS L0..L4, S0..S4 ---- */
check(GAS_LEVELS.L0 === 400 && GAS_LEVELS.L1 === 100 && GAS_LEVELS.L2 === 25 && GAS_LEVELS.L3 === 6.25 && GAS_LEVELS.L4 === 1.5,
  `GAS_LEVELS L0..L4: ${JSON.stringify(GAS_LEVELS)}`);
check(STAR_LEVELS.S0 === 400 && STAR_LEVELS.S1 === 100 && STAR_LEVELS.S2 === 25 && STAR_LEVELS.S3 === 6.25 && STAR_LEVELS.S4 === 1.5,
  `STAR_LEVELS S0..S4: ${JSON.stringify(STAR_LEVELS)}`);

/* ---- 2. validateManifestV2 with L3, L4, S3, S4 ---- */
const M = JSON.parse(readFileSync(join(ROOT, "docs/tng50/data/viz/manifest_v2.json"), "utf8"));
{ let e = null; try { validateManifestV2(M); } catch (x) { e = x.message; }
  check(e === null, "validateManifestV2 accepts committed L0..L2 manifest" + (e ? ": " + e : "")); }
{ const M4 = JSON.parse(JSON.stringify(M));
  M4.levels.L3 = {half_kpc: 6.25, n: 256, voxel_kpc: 12.5 / 256, r_mask_kpc: null};
  M4.levels.L4 = {half_kpc: 1.5, n: 256, voxel_kpc: 3.0 / 256, r_mask_kpc: null};
  M4.levels.S3 = {half_kpc: 6.25, n: 256, voxel_kpc: 12.5 / 256, r_mask_kpc: null};
  M4.levels.S4 = {half_kpc: 1.5, n: 256, voxel_kpc: 3.0 / 256, r_mask_kpc: null};
  M4.gas.levels = ["L0", "L1", "L2", "L3", "L4"];
  M4.stars.levels = ["S0", "S1", "S2", "S3", "S4"];
  for (const [k, f] of Object.entries(M4.gas.fields)) {
    for (const L of ["L3", "L4"]) f.cubes[L] = JSON.parse(JSON.stringify(f.cubes.L2).replaceAll("/L2/", `/${L}/`));
  }
  for (const S of ["S3", "S4"]) M4.stars.cubes[S] = JSON.parse(JSON.stringify(M4.stars.cubes.S2).replaceAll("/S2/", `/${S}/`));
  let e = null; try { validateManifestV2(M4); } catch (x) { e = x.message; }
  check(e === null, "validateManifestV2 accepts L0..L4 and S0..S4 manifest" + (e ? ": " + e : ""));
  check(!!cubeRef(M4, "gas", "nH", "L3") && !!cubeRef(M4, "gas", "nH", "L4") && !!cubeRef(M4, "stars", null, "S3") && !!cubeRef(M4, "stars", null, "S4"),
    "cubeRef resolves L3, L4, S3, S4 cubes");
  const Mbad = JSON.parse(JSON.stringify(M4)); Mbad.levels.L5 = {half_kpc: 0.5, n: 256, voxel_kpc: 1 / 256, r_mask_kpc: null};
  let e2 = null; try { validateManifestV2(Mbad); } catch (x) { e2 = x.message; }
  check(e2 !== null && /levels\.L5/.test(e2), `validateManifestV2 rejects unknown level L5 (${e2})`);
  const Mmask = JSON.parse(JSON.stringify(M4)); Mmask.levels.L3.r_mask_kpc = 6.25;
  let e3 = null; try { validateManifestV2(Mmask); } catch (x) { e3 = x.message; }
  check(e3 !== null && /r_mask_kpc/.test(e3), `validateManifestV2 rejects non-null r_mask_kpc on L3 (${e3})`); }

/* ---- 3. viewPlan for L3/S3 and L4/S4 ---- */
{ const P = o => viewPlan(o).order.map(x => x.join(":")).join(",");
  check(P({ratio: {L1: 20, L2: 5, L3: 0.4, S1: 15, S2: 3.5, S3: 0.4}, hVisKpc: 20, stars: true}) ===
    "gas:L0,gas:L1,stars:S1,gas:L2,stars:S2,gas:L3,stars:S3",
    "viewPlan schedules L3/S3 when hVisKpc < 25 and ratio.L3 >= 0.35");
  check(P({ratio: {L1: 80, L2: 20, L3: 5, L4: 0.5, S1: 60, S2: 15, S3: 3.5, S4: 0.5}, hVisKpc: 4, stars: true}) ===
    "gas:L0,gas:L1,stars:S1,gas:L2,stars:S2,gas:L3,stars:S3,gas:L4,stars:S4",
    "viewPlan schedules L4/S4 when hVisKpc < 6.25 and ratio.L4 >= 0.35");
  check(!P({ratio: {L1: 20, L2: 5, L3: 0.5, S1: 15, S2: 3.5, S3: 0.5}, hVisKpc: 30, stars: true}).includes("L3"),
    "viewPlan does not schedule L3 when hVisKpc >= 25");
  check(!P({ratio: {L1: 20, L2: 5, L3: 0.2, S1: 15, S2: 3.5, S3: 0.2}, hVisKpc: 15, stars: true}).includes("L3"),
    "viewPlan does not schedule L3 when ratio.L3 < 0.35");
  check(P({ratio: {L1: 20, L2: 5, S1: 15, S2: 3.5}, hVisKpc: 4, stars: true, hasL3: true, hasL4: true}) ===
    "gas:L0,gas:L1,stars:S1,gas:L2,stars:S2,gas:L3,stars:S3,gas:L4,stars:S4",
    "viewPlan schedules L3/S3 and L4/S4 with hasL3/hasL4 flags when zoomed in"); }

/* ---- 4. viewer3d.js source checks: 3-slot window, sub-kpc scale bar, #v3-dust & Pei (1992) shader patch ---- */
{ const vsrc = readFileSync(join(ROOT, "docs/tng50/js/viewer3d.js"), "utf8");
  check(vsrc.includes('["L0", "L1", "L2", "L3", "L4"].filter(L => manifest?.levels?.[L])') &&
        vsrc.includes('["S0", "S1", "S2", "S3", "S4"].filter(L => manifest?.levels?.[L])'),
    "viewer3d.js filters GAS_L and STAR_L dynamically from manifest.levels with L0..L2 / S0..S2 fallback");
  check(vsrc.includes("L3: 6.25, L4: 1.5") && vsrc.includes("S3: 6.25, S4: 1.5"),
    "viewer3d.js includes L3/L4 and S3/S4 half_kpc fallbacks (6.25 and 1.5 kpc)");
  check(vsrc.includes("manifest?.levels?.L4 ? 0.4 : manifest?.levels?.L3 ? 1.5 : 15") &&
        vsrc.includes("manifest?.levels?.L3 ? 0.05 : 0.5"),
    "viewer3d.js lowers controls.minDistance and camera.near dynamically for L3/L4");
  check(vsrc.includes("winIdx === 0 ? (manifest?.levels?.L0?.r_mask_kpc ?? 400) : 1e9") &&
        vsrc.includes("U.uHalf.value.set(half(gWin[0]), half(gWin[1]), half(gWin[2]))"),
    "viewer3d.js updates 3-slot sliding window uHalf and disables uMask0 when winIdx > 0");
  check(vsrc.includes("[0.05, 0.1, 0.2, 0.5, 1, 2, 5, 10, 20, 50, 100, 200, 500]") &&
        vsrc.includes("${Math.round(best * 1000)} pc"),
    "viewer3d.js physical scale bar includes sub-kpc stops down to 0.05 kpc formatted in pc");
  check(vsrc.includes('id="v3-dust" checked data-tip="Attenuate starlight through cold dust lanes along the ray">dust lanes</label>'),
    "viewer3d.js declares #v3-dust checkbox in Layers card with <= 12-word data-tip");
  check(vsrc.indexOf('id="v3-dust"') < vsrc.indexOf("<details><summary>star brightness</summary>") &&
        vsrc.indexOf('id="v3-dust-law"') < vsrc.indexOf("<details><summary>star brightness</summary>"),
    "viewer3d.js surfaces #v3-dust and #v3-dust-law directly in the Layers card above star brightness details");
  check(vsrc.includes('id="v3-dust-law"') && vsrc.includes("DUST_LAWS") && vsrc.includes("RM.uniforms.uDust = {value: 1.0}") &&
        vsrc.includes("uDustVec") && vsrc.includes("uDustScat") && vsrc.includes("dustDiskKv") &&
        vsrc.includes("[0.58, 0.78, 1.15]") && vsrc.includes("[0.68, 0.89, 1.17]") && vsrc.includes("[0.65, 0.84, 1.19]") &&
        vsrc.includes("(-4.5 + (q - 1.0) * 6.0 / 253.0)") && vsrc.includes("exactDust") && vsrc.includes("texture(uStar0, u).a") &&
        !vsrc.includes("cos(2.0 * phi") && !vsrc.includes("sin(p.x * 6.2") && !vsrc.includes("pow(tEff,"),
    "viewer3d.js patches RM.material.fragmentShader with trilinear starDustAt, pure simulation-driven dustDiskKv (no procedural trig or post-asinh tEff hack), and filmic lupton shoulder");
  check(JSON.stringify(SMOOTH.stars) === "[0,0,0,0,0]" && STAR_COMP.core === 0.92 && STAR_COMP.halo === 0.12 &&
        JSON.stringify(STAR_ZOOM.occWide) === "[0.08,0.25]",
    "SMOOTH.stars is [0,0,0,0,0], STAR_COMP is {core:0.92, halo:0.12}, and STAR_ZOOM.occWide is [0.08,0.25]");
  // Verify the shader patch matches target strings in raymarch.js FRAG
  const patched = FRAG
    .replace("in vec3 vPos;", "uniform float uDust; in vec3 vPos;")
    .replace("vec3 starAt(vec3 p, int l) {", "float starDustAt(vec3 p, int l) { return 0.0; }\nvec3 starAt(vec3 p, int l) {")
    .replace("if (uStarKnee > 0.0 && m > uStarKnee) { float k = uStarKnee, r = 1.0 - k; c *= (k + r * (1.0 - exp(-(m - k) / r))) / m; }\n  else if (m > 1.0) c /= m;",
      "if (m > 0.0) c *= (1.0 - exp(-1.15 * m * (0.55 + 0.65 * m))) / m;")
    .replace("vec3 sumS = vec3(0.0), C = vec3(0.0);", "vec3 sumS = vec3(0.0), transS = vec3(1.0), C = vec3(0.0);")
    .replace("if (ls >= 0) { vec3 sv = starVal(p, ls); if (cs >= 0) sv = mix(starVal(p, cs), sv, ms); sumS += sv * hw; }", "/* dust patched */")
    .replace("vec3 star = starOn ? uStarMix * lupton(sumS) : vec3(0.0);", "vec3 star0 = starOn ? uStarMix * lupton(sumS0) : vec3(0.0); vec3 star = starOn ? uStarMix * lupton(sumS) : vec3(0.0);")
    .replace("float sm = max(star.r, max(star.g, star.b)), occ = uStarOcc * smoothstep(uOccRange.x, uOccRange.y, sm);", "float sm = max(star.r, max(star.g, star.b)), dustT = 1.0, occ = 0.0;")
    .replace("vec3 g = mix(uBg, gas, gm * (starOn ? uGasW : 1.0) * (1.0 - occ));", "vec3 g = mix(uBg, gas, gm * (starOn ? uGasW * dustT : 1.0) * (1.0 - occ));");
  check(patched.includes("uniform float uDust;") && patched.includes("float starDustAt") &&
        patched.includes("exp(-1.15 * m") && patched.includes("transS = vec3(1.0)") &&
        patched.includes("/* dust patched */") && patched.includes("uGasW * dustT"),
    "viewer3d.js shader patch anchors match raymarch.js FRAG cleanly without modifying raymarch.js"); }

console.log(fails ? `\n${fails} check(s) FAILED` : "\nall checks passed");
process.exit(fails ? 1 : 0);
