// Parity of the legacy v1 JS degrade port (tests/js/lib/legacy_degrade.js; it was the <script id="tngsight-degrade"> block of
// docs/tng50/_template.html until Phase 3, when the page moved to js/fit.js degradeV) with the Python model.
// Usage: node tests/js/degrade_parity.mjs [reference.json]
//   Without an argument it runs tests/js/make_reference.py ($PYTHON, default "python") into os.tmpdir().
import {readFileSync} from "node:fs";
import {execFileSync} from "node:child_process";
import {tmpdir} from "node:os";
import {join, dirname} from "node:path";
import {fileURLToPath} from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const TOL = 1e-6;
const TNG = new Function(readFileSync(join(HERE, "lib", "legacy_degrade.js"), "utf8") + "\nreturn TNG;")();

let refPath = process.argv[2];
if (!refPath) {
  refPath = join(tmpdir(), "tngsight_degrade_ref.json");
  execFileSync(process.env.PYTHON || "python", [join(HERE, "make_reference.py"), "--out", refPath], {stdio: "inherit"});
}
const ref = JSON.parse(readFileSync(refPath, "utf8"));
let fails = 0;
const check = (ok, msg) => { console.log(`${ok ? "ok  " : "FAIL"} ${msg}`); if (!ok) fails++; };
const maxAbs = (a, b) => { let d = 0; for (let i = 0; i < a.length; i++) d = Math.max(d, Math.abs(a[i] - b[i]) || (a[i] === b[i] ? 0 : Infinity)); return d; };
const b64 = s => { const b = Buffer.from(s, "base64"); return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength); };
console.log(`reference impl: ${ref.meta.impl}; numpy ${ref.meta.numpy}, astropy ${ref.meta.astropy}`);

// 1. kernel = astropy Gaussian1DKernel(sigma).array
for (const {sigma, k} of ref.kernels) { const j = TNG.gaussKernel(Math.max(sigma, 1e-3));
  check(j.length === k.length && maxAbs(j, k) < 1e-15, `kernel sigma=${sigma}: n=${j.length} (astropy ${k.length}), max|d|=${maxAbs(j, k).toExponential(2)}`); }
// 2. numpy float arange: same length, values to 1 ulp (arm64 numpy builds contract start + i*delta into an FMA; JS has none)
for (const a of ref.aranges) { const v = TNG.arange(a.start, a.stop, a.step), d = v.length === a.v.length ? maxAbs(v, a.v) : Infinity;
  check(d <= 2.3e-16 * 2 * Math.max(Math.abs(a.start), Math.abs(a.stop)), `arange(${a.start}, ${a.stop.toFixed(4)}, ${a.step}): M=${v.length} (numpy ${a.v.length}), max|d|=${d.toExponential(2)}`); }
// 3. web binary decode: float32 grid and q/65535 flux reproduced exactly
const dec = ref.payloads.map(p => TNG.decodeWeb(b64(p.bin_b64)));
ref.payloads.forEach((p, i) => { for (const k of TNG.LINE_KEYS) { const L = dec[i].lines[k], g = ref.grid[k], q = new Uint16Array(b64(p.q[k]));
  const dq = maxAbs(L.flux, Array.from(q, x => x / 65535));
  check(L.n === g.length && maxAbs(L.lam, g) === 0 && dq === 0 && L.dlam === ref.meta.DLAMBDA,
    `decode ${p.name}/${k}: n=${L.n}, lam exact=${maxAbs(L.lam, g) === 0}, flux exact=${dq === 0}, dlam_lsf=${L.dlam}`); } });
// 4. noiseless model parity
let worst = 0, worstV = 0, nCase = 0;
for (const c of ref.cases) { const L = dec[c.payload].lines[c.key], vs = ref.payloads[c.payload].v_sys;
  const r = TNG.degradeModel(L.lam, L.flux, L.rest, c.R ?? null, vs, {dlam: c.dlam, vwin: c.vwin});
  const okLen = r.v.length === c.v.length, dm = okLen ? maxAbs(r.model, c.model) : Infinity, dv = okLen ? maxAbs(r.v, c.v) : Infinity;
  worst = Math.max(worst, dm); worstV = Math.max(worstV, dv); nCase++;
  if (!(okLen && dm <= TOL && dv <= 1e-9)) check(false, `model ${ref.payloads[c.payload].name}/${c.key} R=${c.R} vwin=${c.vwin} dlam=${c.dlam}: M=${r.v.length} vs ${c.v.length}, max|dF|=${dm}, max|dv|=${dv}`); }
check(worst <= TOL && worstV <= 1e-9, `noiseless model, ${nCase} cases: max|dF| = ${worst.toExponential(2)} (tol ${TOL}), max|dv| = ${worstV.toExponential(2)} km/s`);
// 5. informational: JS on the u16 binary vs Python on the unquantized npz tau (quantization bound 1/65535)
for (const c of ref.npz_direct || []) { const L = dec[c.payload].lines[c.key];
  const r = TNG.degradeModel(L.lam, L.flux, L.rest, c.R, ref.payloads[c.payload].v_sys, {dlam: c.dlam, vwin: c.vwin}), d = maxAbs(r.model, c.model);
  check(r.v.length === c.v.length && d <= 1 / 65535, `u16 binary vs npz tau ${ref.payloads[c.payload].name}/${c.key} (R=40000): max|dF| = ${d.toExponential(2)} (bound ${(1 / 65535).toExponential(2)})`); }
// 6. noise: deterministic per seed, statistically N(0, sqrt(5)/snr), clipped at 0
{ const n = 200000, one = new Float64Array(n).fill(1), a = TNG.addNoise(one, 8, 17), b = TNG.addNoise(one, 8, 17), c = TNG.addNoise(one, 8, 18);
  let mu = 0, s2 = 0; for (const x of a) mu += x - 1; mu /= n; for (const x of a) s2 += (x - 1 - mu) ** 2; const sd = Math.sqrt(s2 / (n - 1)), want = Math.sqrt(5) / 8;
  check(maxAbs(a, b) === 0 && maxAbs(a, c) > 0, "noise deterministic per seed and seed-dependent");
  check(Math.abs(mu) < 4 * want / Math.sqrt(n) && Math.abs(sd / want - 1) < 0.01, `noise mean ${mu.toExponential(2)}, sd ${sd.toFixed(5)} (want ${want.toFixed(5)})`);
  const z = TNG.addNoise(new Float64Array(n), 2, 5); check(z.every(x => x >= 0), "noise clipped at 0 from below"); }
// 7. velocity frame: V = c(lam/lam0 - 1) + VSYS_SIGN*v_sys with VSYS_SIGN = +1
{ const v = TNG.velocityAxis([1031.912], 1031.912, -50); check(TNG.VSYS_SIGN === 1 && v[0] === -50, `velocity frame: rest wavelength maps to V = ${v[0]} for v_sys = -50`); }

console.log(fails ? `\n${fails} check(s) FAILED` : "\nall checks passed");
process.exit(fails ? 1 : 0);
