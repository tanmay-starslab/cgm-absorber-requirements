// smoothCube (docs/tng50/js/vizdata.js, tune2 display prefilter): column sums are kept, empty stays empty far from
// matter, the star (RGBA) path smooths R/G/B independently and sets A from them, and passes = 0 round-trips the bytes.
import {smoothCube, decodeU8} from "../../docs/tng50/js/vizdata.js";
import {readFileSync} from "node:fs";
let fails = 0; const check = (ok, msg) => { console.log(`${ok ? "ok  " : "FAIL"} ${msg}`); if (!ok) fails++; };
const n = 32, N = n ** 3, vmin = -8, vmax = 2;
let seed = 7; const rnd = () => ((seed = (seed * 1103515245 + 12345) >>> 0) / 2 ** 32);
const q = new Uint8Array(N); for (let i = 0; i < N; i++) { const [x, y, z] = [i % n, (i / n | 0) % n, i / n / n | 0];
  if (x > 4 && x < 27 && y > 4 && y < 27 && z > 4 && z < 27 && rnd() < 0.4) q[i] = 1 + Math.floor(rnd() * 254); }
const lin = a => { const d = decodeU8(a, vmin, vmax); let s = 0; for (const v of d) if (v === v) s += 10 ** v; return s; };
const o = smoothCube(q, n, vmin, vmax, 2);
check(o.length === N && Math.abs(lin(o) / lin(q) - 1) < 0.01, `total kept: ratio ${(lin(o) / lin(q)).toFixed(5)}`);
check(o[0] === 0 && o[N - 1] === 0, "corners far from matter stay empty");
const id = smoothCube(q, n, vmin, vmax, 0); let same = 0; for (let i = 0; i < N; i++) same += id[i] === q[i];
check(same === N, `passes = 0 round-trips the bytes (${same}/${N})`);
const q4 = new Uint8Array(4 * N); for (let i = 0; i < N; i++) if (q[i]) { q4[4 * i] = q[i]; q4[4 * i + 2] = 200; q4[4 * i + 3] = 255; }
const o4 = smoothCube(q4, n, vmin, vmax, 2, 4); let okA = true, g0 = true;
for (let i = 0; i < N; i++) { if ((o4[4 * i + 3] === 255) !== !!(o4[4 * i] | o4[4 * i + 1] | o4[4 * i + 2])) okA = false; if (o4[4 * i + 1]) g0 = false; }
const R = new Uint8Array(N); for (let i = 0; i < N; i++) R[i] = o4[4 * i];
check(okA && g0 && R.every((v, i) => v === o[i]), "RGBA: R equals the single-channel result, empty G stays empty, A = any(RGB)");
// tf (H I check): the viewer draws every gas field raw (the owner's "original resolution"); only the star cubes keep the
// prefilter. Read the SMOOTH table and the smoothPasses rule from the viewer source (importing it needs a DOM).
const src = readFileSync(new URL("../../docs/tng50/js/viewer3d.js", import.meta.url), "utf8");
const mS = src.match(/^const SMOOTH = (\{[^;]*\});/m), mP = src.match(/^const smoothPasses = (k => [^;]*);/m);
check(!!mS && !!mP, "viewer3d.js defines SMOOTH and smoothPasses");
if (mS && mP) { const SMOOTH = Function(`return ${mS[1]}`)(), sp = Function("SMOOTH", "isIon", `return ${mP[1]}`)(SMOOTH, () => true);
  const gas = ["nH", "T", "Z", "HI", "MgII", "SiII", "CII", "SiIII", "CIII", "SiIV", "CIV", "NV", "OVI", "NeVIII", "OVII", "vx"];
  const pre = gas.filter(k => (sp(k) || []).some(p => p > 0));
  check(pre.length === 0, `no gas field is prefiltered${pre.length ? ": " + pre.join(", ") : ""}`);
  check(JSON.stringify(sp("stars")) === "[2,2,1]", `star cubes keep 2/2/1 passes (${JSON.stringify(sp("stars"))})`); }
console.log(fails ? `\n${fails} check(s) FAILED` : "\nall checks passed");
process.exit(fails ? 1 : 0);
