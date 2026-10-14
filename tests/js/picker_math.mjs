// Picker math vs Python (design-2 §7.9): rayPlane / clampRadius / lineMetrics / canonical / customId / validate.
// Usage: node tests/js/picker_math.mjs [reference.json]   (default: runs tests/js/make_picker_reference.py with $PYTHON)
import {readFileSync} from "node:fs";
import {execFileSync} from "node:child_process";
import {tmpdir} from "node:os";
import {join, dirname} from "node:path";
import {fileURLToPath} from "node:url";
import {rayPlane, clampRadius, lineMetrics, canonical, customId, validate, roundHalfEven, tenths} from "../../docs/tng50/js/picker.js";

const HERE = dirname(fileURLToPath(import.meta.url));
let ref = process.argv[2];
if (!ref) { ref = join(tmpdir(), "tngsight_picker_ref.json");
  execFileSync(process.env.PYTHON || "python", [join(HERE, "make_picker_reference.py"), "--out", ref], {stdio: "inherit"}); }
const R = JSON.parse(readFileSync(ref, "utf8")), Lhat = R.meta.Lhat;
let fails = 0; const check = (ok, msg) => { console.log(`${ok ? "ok  " : "FAIL"} ${msg}`); if (!ok) fails++; };
const md = (a, b) => Math.max(...a.map((x, i) => Math.abs(x - b[i])));
check(roundHalfEven(2.5) === 2 && roundHalfEven(3.5) === 4 && roundHalfEven(-2.5) === -2 && Object.is(roundHalfEven(-0.4), 0) && roundHalfEven(1502.5) === 1502,
  "roundHalfEven: 2.5→2, 3.5→4, −2.5→−2, −0.4→0 (not −0), 1502.5→1502");
for (const [id, [p0, p1]] of Object.entries(R.golden)) check(await customId(p0, p1) === id, `golden ${id}`);
let nTen = 0, nId = 0, nVal = 0, dL = 0, dB = 0, dBs = 0, dA = 0, dC = 0, nM = 0;
for (const c of R.cases) {
  if (tenths([...c.p0, ...c.p1]).join() === c.tenths.join() && md(canonical(c.p0), c.q0) === 0 && md(canonical(c.p1), c.q1) === 0) nTen++;
  else console.log("  tenths mismatch", c.p0, c.p1, tenths([...c.p0, ...c.p1]), c.tenths);
  if (await customId(c.q0, c.q1) === c.id && await customId(c.p0, c.p1) === c.id) nId++; else console.log("  id mismatch", c.id);
  const v = validate(c.p0, c.p1, Lhat);
  if (v.ok === (c.error === null) && (c.error === null || v.errors[0] === c.error)) nVal++; else console.log("  validate mismatch", c.error, v.errors);
  if (c.length != null) { const m = lineMetrics(c.q0, c.q1, Lhat); nM++;
    dL = Math.max(dL, Math.abs(m.length - c.length)); dB = Math.max(dB, Math.abs(m.b - c.b)); dBs = Math.max(dBs, Math.abs(m.b_segment - c.b_segment));
    dA = Math.max(dA, Math.abs(m.angle_deg - c.angle_deg)); dC = Math.max(dC, md(m.closest, c.closest)); }
}
const N = R.cases.length;
check(N >= 200 && nTen === N, `canonical (tenths, half-even) == Python: ${nTen}/${N}`);
check(nId === N, `customId == Python custom_id: ${nId}/${N}`);
check(nVal === N, `validate ok + first message == canonicalize_endpoints (which raises on the first): ${nVal}/${N} (${R.cases.filter(c => c.error).length} rejected)`);
check(dL <= 1e-9 && dB <= 1e-9 && dBs <= 1e-9 && dC <= 1e-9, `lineMetrics vs make_endpoints (${nM}): max|ΔL| ${dL.toExponential(1)}, |Δb| ${dB.toExponential(1)}, |Δb_seg| ${dBs.toExponential(1)}, |Δclosest| ${dC.toExponential(1)} kpc (≤ 1e-9)`);
check(dA <= 1e-9, `angle to disk normal: max|Δ| ${dA.toExponential(1)}° (≤ 1e-9)`);
let dP = 0, nP = 0; for (const p of R.planes) { const h = rayPlane(p.o, p.dir, p.n, p.d);
  if ((h === null) !== (p.hit === null)) { dP = Infinity; continue; } if (h) { dP = Math.max(dP, md(h, p.hit)); nP++; } }
check(dP <= 1e-9, `rayPlane: ${R.planes.length} cases (${nP} hits), max|Δ| ${dP.toExponential(1)} kpc`);
check(rayPlane([0, 0, 10], [1, 0, 0], [0, 0, 1]) === null, "rayPlane parallel → null");
let dK = 0; for (const c of R.clamps) dK = Math.max(dK, md(clampRadius(c.p), c.out));
check(dK <= 1e-9, `clampRadius 395: ${R.clamps.length} cases, max|Δ| ${dK.toExponential(1)}`);
const bad = [[[NaN, 0, 0], [100, 0, 0]], [[0, 0], [100, 0, 0]], [[395.1, 0, 0], [0, 0, 0]], [[0, 0, 0], [19.9, 0, 0]], [[-400, 0, 0], [400.1, 0, 0]]];
const good = [[[395.0, 0, 0], [0, 0, 0]], [[0, 0, 0], [20.0, 0, 0]]];
check(bad.every(([a, b]) => !validate(a, b, Lhat).ok) && good.every(([a, b]) => validate(a, b, Lhat).ok), "bounds: 395.1 / 19.9 / non-finite / length-2 rejected; 395.0 / 20.0 accepted");
console.log(fails ? `\n${fails} check(s) FAILED` : "\nall checks passed");
process.exit(fails ? 1 : 0);
