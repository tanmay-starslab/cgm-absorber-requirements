// colormaps.lut(name) vs docs/tng50/data/luts/luts.json (design §5.2, §5.11 item 4): every entry within ±1 per channel,
// 33 stops per map, the exact NAMES list, and cssGradient output.
import {readFileSync} from "node:fs";
import {lut, cssGradient, NAMES, STOPS} from "../../docs/tng50/js/colormaps.js";
let fails = 0; const check = (ok, msg) => { console.log(`${ok ? "ok  " : "FAIL"} ${msg}`); if (!ok) fails++; };
const J = JSON.parse(readFileSync(new URL("../../docs/tng50/data/luts/luts.json", import.meta.url), "utf8"));
check(NAMES.join() === "tng_dusk,tng_ice,magma,inferno,viridis,cividis,grey" && J.version === 1 && Object.keys(J.luts).join() === NAMES.join(), "NAMES and luts.json keys are exactly the 7 design names");
for (const n of NAMES) { const L = lut(n), h = Buffer.from(J.luts[n].hex, "hex"); let d = 0;
  for (let k = 0; k < 256; k++) for (let j = 0; j < 3; j++) d = Math.max(d, Math.abs(L[4 * k + j] - h[3 * k + j]));
  check(h.length === 768 && STOPS[n].length === 33 * 8 && d <= 1 && L[3] === 255, `${n.padEnd(8)}: 33 stops, max |lut − luts.json| = ${d} (≤ 1)`); }
check(/^linear-gradient\(90deg, rgb\(\d+,\d+,\d+\) 0\.0%/.test(cssGradient("tng_dusk")), "cssGradient → CSS linear-gradient");
console.log(fails ? `\n${fails} check(s) FAILED` : "\nall checks passed");
process.exit(fails ? 1 : 0);
