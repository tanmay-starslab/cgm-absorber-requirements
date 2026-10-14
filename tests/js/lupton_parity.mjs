// JS lupton() (docs/tng50/js/vizdata.js) vs tngsight.vizpack.lupton_rgb (design §4.5, §5.11 item 2): 200 fixture
// inputs, ≤ 1/255 per channel; flat-AB source is neutral, Σ = 0 is black, saturation preserves hue.
// Usage: node tests/js/lupton_parity.mjs [fixture dir]
import {readFileSync, mkdtempSync} from "node:fs";
import {execFileSync} from "node:child_process";
import {tmpdir} from "node:os";
import {join, dirname} from "node:path";
import {fileURLToPath} from "node:url";
import {lupton, MU_ZERO} from "../../docs/tng50/js/vizdata.js";

const HERE = dirname(fileURLToPath(import.meta.url));
let dir = process.argv[2];
if (!dir) { dir = mkdtempSync(join(process.env.TMPDIR || tmpdir(), "tngviz-"));
  execFileSync(process.env.PYTHON || "python", [join(HERE, "make_viz_fixture.py"), "--out", dir], {stdio: "inherit"}); }
let fails = 0; const check = (ok, msg) => { console.log(`${ok ? "ok  " : "FAIL"} ${msg}`); if (!ok) fails++; };
const E = JSON.parse(readFileSync(join(dir, "expect.json"), "utf8")), L = E.lupton;
console.log(`fixture impl: ${E.impl}`);
let worst = 0;
L.inputs.forEach(([i, r, g], k) => { const c = lupton(i, r, g, {Q: L.Q, mu0: L.mu0, balance: [1, 1, 1]});
  for (let j = 0; j < 3; j++) worst = Math.max(worst, Math.abs(c[j] * 255 - L.rgb8[k][j])); });
check(worst <= 1 + 1e-9, `${L.inputs.length} inputs: max |JS·255 − Python| = ${worst.toFixed(3)} (≤ 1)`);
const S0 = 10 ** (0.4 * (MU_ZERO - 21.5)), flat = lupton(3 * S0, 3 * S0, 3 * S0), zero = lupton(0, 0, 0), sat = lupton(1e5 * S0, 3e4 * S0, 1e4 * S0);
check(flat[0] === flat[1] && flat[1] === flat[2] && flat[0] > 0, `flat-AB source is neutral: ${flat.map(x => x.toFixed(3))}`);
check(zero.every(x => x === 0), "Σ = 0 → black");
check(Math.max(...sat) === 1 && Math.abs(sat[1] / sat[0] - 0.3) < 1e-12 && Math.abs(sat[2] / sat[0] - 0.1) < 1e-12, `saturation keeps hue: ${sat.map(x => x.toFixed(4))}`);
const med = lupton(S0, S0, S0)[0];
check(med > 0.3 && med < 0.4, `μ = mu0 → brightness ${med.toFixed(3)} (design §4.5: ≈ 0.35 for the median disk)`);
console.log(fails ? `\n${fails} check(s) FAILED` : "\nall checks passed");
process.exit(fails ? 1 : 0);
