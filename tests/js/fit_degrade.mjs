// degradeV model parity with the Python v2 operator (fixture), LSF kernel, noise and the TNGS v1/v2 decoder of
// docs/tng50/js/fit.js (design-3 sections 2.4, 3.4, 5.1 and 8 U_fit 2).
import {readFileSync, existsSync, readdirSync} from "node:fs";
import {join, dirname} from "node:path";
import {fileURLToPath} from "node:url";
import {degradeV, lsfKernel, arange, decodeTNGS, seedFor, rng, gauss} from "../../docs/tng50/js/fit.js";

const HERE = dirname(fileURLToPath(import.meta.url)), ROOT = join(HERE, "..", ".."), FIX = join(HERE, "fixtures");
const fx = JSON.parse(readFileSync(join(FIX, "fit_cases.json"), "utf8"));
let fails = 0;
const check = (ok, msg) => { console.log(`${ok ? "ok  " : "FAIL"} ${msg}`); if (!ok) fails++; };
const f8 = s => { const b = Buffer.from(s, "base64"); return new Float64Array(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength)); };
const ab = b => b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength);
const bins = Object.fromEntries(fx.meta.ids.map(id => [id, decodeTNGS(ab(readFileSync(join(FIX, "fit_bins", `${id}.bin`))))]));

// 1. degradeV noiseless model vs the Python v2 operator, 24 cases
{ let worst = 0, worstV = 0, nOk = 0;
  for (const c of fx.degrade) {
    const d = bins[c.id], r = degradeV(d.lines[c.ion], c.R, c.snr, d.vSys, {vwin: c.vwin ?? undefined, vcenter: c.vcenter, seed: 3});
    const v = f8(c.v), m = f8(c.model), same = r.v.length === c.n;
    let dm = 0, dv = 0; if (same) for (let i = 0; i < c.n; i++) { dm = Math.max(dm, Math.abs(r.model[i] - m[i])); dv = Math.max(dv, Math.abs(r.v[i] - v[i])); }
    worst = Math.max(worst, same ? dm : Infinity); worstV = Math.max(worstV, same ? dv : Infinity);
    if (same && dm <= 1e-9 && dv <= 1e-9) nOk++; else check(false, `degrade ${c.id}/${c.ion} R=${c.R} vwin=${c.vwin}: n ${r.v.length} vs ${c.n}, max|dF| ${dm}, max|dv| ${dv}`);
  }
  check(nOk === fx.degrade.length && fx.degrade.length === 24, `degradeV model, ${nOk}/${fx.degrade.length} cases (${[...new Set(fx.degrade.map(c => c.band))].join(", ")}; R ${[...new Set(fx.degrade.map(c => c.R ?? "none"))].join(", ")}): max |dF| ${worst.toExponential(2)}, max |dv| ${worstV.toExponential(2)} (tol 1e-9; model from ${fx.meta.degrade})`); }

// 2. LSF kernel: normalised, symmetric, variance sigma_LSF^2 + 1/12 (pixel integration), h = max(1, ceil(4 sigma))
{ let ok = true, msg = [];
  for (const R of [100, 300, 5000, 30000, 150000]) { const k = lsfKernel(R, 1), h = (k.length - 1) / 2, sp = 299792.458 / R / 2.35482;
    let s = 0, v = 0, asym = 0; for (let j = -h; j <= h; j++) { s += k[j + h]; v += j * j * k[j + h]; asym = Math.max(asym, Math.abs(k[j + h] - k[h - j])); }
    const want = sp * sp + 1 / 12, rel = Math.abs(v - want) / want;
    if (Math.abs(s - 1) > 1e-14 || asym > 1e-15 || h !== Math.max(1, Math.ceil(4 * sp)) || rel > 2e-3) ok = false;
    msg.push(`R=${R}: h=${h} var ${(v).toFixed(3)} vs ${want.toFixed(3)}`); }
  check(ok, `lsfKernel normalised, symmetric, variance = sigma^2 + 1/12: ${msg.join("; ")}`);
  check(lsfKernel(null, 1).length === 1 && lsfKernel(Infinity, 1)[0] === 1 && lsfKernel(0, 1)[0] === 1, "lsfKernel: R none/0/inf -> identity"); }

// 3. no-LSF output step = du * 5; vwin window and numpy arange semantics
{ const d = bins[fx.meta.ids[0]], L = d.lines.OVI, r = degradeV(L, null, 0, d.vSys), r2 = degradeV(L, 30000, 10, d.vSys, {vwin: 100, vcenter: 20});
  check(Math.abs(r.v[1] - r.v[0] - 5) < 1e-12 && r.sigma === 0 && r.flux.every((x, i) => x === Math.max(0, r.model[i])), "no LSF: step du*5, S/N 0 -> noiseless");
  const a = arange(-80, 120 + 299792.458 / 30000 / 5, 299792.458 / 30000 / 5);
  check(r2.v.length === a.length && r2.v[0] === -80 && r2.v.every((x, i) => x === a[i]), `vwin 100 about vcenter 20: ${r2.v.length} pixels from ${r2.v[0]} to ${r2.v[r2.v.length - 1].toFixed(3)}`);
  check(Math.abs(r2.sigma - Math.sqrt(5) / 10) < 1e-15, `per-pixel sigma = sqrt(5)/snr = ${r2.sigma.toFixed(5)}`); }

// 4. noise: deterministic per seed, N(0, sqrt(5)/snr), clipped at 0; seedFor = FNV-1a 32-bit
{ const n = 200000, line = {n: 3001, u0: -1500, du: 1, flux: new Float64Array(3001).fill(1)};
  const a = degradeV(line, 150000, 8, 0, {seed: 17}).flux, b = degradeV(line, 150000, 8, 0, {seed: 17}).flux, c = degradeV(line, 150000, 8, 0, {seed: 18}).flux;
  check(a.length > 7000 && a.every((x, i) => x === b[i]) && a.some((x, i) => x !== c[i]), `noise deterministic per seed and seed-dependent (${a.length} px)`);
  const r = rng(5), want = Math.sqrt(5) / 8; let mu = 0, s2 = 0; const z = new Float64Array(n); for (let i = 0; i < n; i++) { z[i] = want * gauss(r); mu += z[i]; } mu /= n;
  for (const x of z) s2 += (x - mu) ** 2; const sd = Math.sqrt(s2 / (n - 1));
  check(Math.abs(mu) < 4 * want / Math.sqrt(n) && Math.abs(sd / want - 1) < 0.01, `Box-Muller noise mean ${mu.toExponential(2)}, sd ${sd.toFixed(5)} (want ${want.toFixed(5)})`);
  const zero = degradeV({...line, flux: new Float64Array(3001)}, 30000, 2, 0, {seed: 1}).flux; check(zero.every(x => x >= 0), "noisy flux clipped at 0");
  // FNV-1a reference values computed independently
  const fnv = s => { let h = 2166136261n; for (const ch of Buffer.from(s)) { h ^= BigInt(ch); h = (h * 16777619n) & 0xffffffffn; } return Number(h); };
  check(seedFor(0, "OVI", 2) === fnv("0|OVI|2") && seedFor(12345, "NeVIII", 0) === fnv("12345|NeVIII|0") && seedFor(0, "OVI", 2) !== seedFor(0, "OVI", 3), `seedFor = FNV-1a of "seed|ion|case" (${seedFor(0, "OVI", 2)})`); }

// 5. decodeTNGS v2: header, keys, sizes, grid; error paths
{ const id = fx.meta.ids[0], raw = readFileSync(join(FIX, "fit_bins", `${id}.bin`)), d = decodeTNGS(ab(raw));
  const keys = Object.keys(d.lines);
  check(d.version === 2 && keys.length === 12 && keys.join() === Object.keys(fx.ions).join() && d.skipped.length === 0 && Number.isFinite(d.vSys), `v2 ${id}: 12 lines in registry order, vSys ${d.vSys.toFixed(3)}`);
  check(Object.values(d.lines).every(L => L.du === 1 && L.u0 === -(L.n - 1) / 2 && L.flux.every(x => x >= 0 && x <= 1)), "v2 lines: du = 1, u0 = -W, flux in [0, 1]");
  check(decodeTNGS(new Uint8Array(raw)).lines.OVI.n === d.lines.OVI.n, "decodeTNGS accepts a typed-array view");
  const throws = (buf, re) => { try { decodeTNGS(buf); return false; } catch (e) { return re.test(e.message); } };
  const cut = ab(raw).slice(0, raw.length - 2), extra = new Uint8Array(raw.length + 3); extra.set(raw);
  check(throws(cut, /truncated/) && throws(extra.buffer, /trailing/), "truncated and trailing-byte blobs are refused");
  const bad = new Uint8Array(raw); bad[4] = 7; check(throws(bad.buffer, /version/), "unknown version refused");
  const mag = new Uint8Array(raw); mag[0] = 88; check(throws(mag.buffer, /not a TNGS/), "bad magic refused");
  // duplicate key: rename line 2 to line 1's key
  const L0 = 40 + 2 * d.lines.HI.n, dup = new Uint8Array(raw); dup.set(raw.subarray(16, 24), 16 + L0); check(throws(dup.buffer, /duplicate/), "duplicate line keys refused");
  // unknown key: skipped and reported
  const unk = new Uint8Array(raw); unk.set(Buffer.from("FeXVII\0\0"), 16); const du = decodeTNGS(unk.buffer, Object.keys(fx.ions));
  check(du.skipped.join() === "FeXVII" && !("HI" in du.lines) && Object.keys(du.lines).length === 11, "unknown key skipped and listed in `skipped`"); }

// 6. decodeTNGS v1 against the v1 page decoder (docs/tng50/_template.html), when v1 data are present
{ const dir = join(ROOT, "docs", "tng50", "data", "s"), tpl = join(ROOT, "docs", "tng50", "_template.html");
  const m = existsSync(tpl) ? readFileSync(tpl, "utf8").match(/<script id="tngsight-degrade">([\s\S]*?)<\/script>/) : null;
  const files = existsSync(dir) ? readdirSync(dir).filter(f => f.endsWith(".bin")).sort() : [];
  const v1 = files.map(f => readFileSync(join(dir, f))).filter(b => b[4] === 1).slice(0, 3);
  if (!m || !v1.length) console.log("skip v1 decoder check (no v1 binaries or v1 template decoder)");
  else { const TNG = new Function(m[1] + "\nreturn TNG;")(); let ok = true;
    for (const b of v1) { const a = decodeTNGS(ab(b)), o = TNG.decodeWeb(ab(b));
      ok = ok && a.version === 1 && a.vSys === null && a.skipped.join() === "HILyb" && Object.keys(a.lines).join() === "OVI,CIII";
      for (const k of ["OVI", "CIII"]) { const A = a.lines[k], O = o.lines[k]; ok = ok && A.n === O.n && A.flux.every((x, i) => x === O.flux[i]);
        const u0 = 299792.458 * (O.lam0 / O.rest - 1), du = 299792.458 * O.dlamGrid / O.rest; ok = ok && A.u0 === u0 && A.du === du; } }
    check(ok, `v1 binaries (${v1.length}): OVI and CIII flux identical to the v1 decoder, HILyb skipped, vSys null`); } }

console.log(`${fails ? "FAIL" : "PASS"} fit_degrade: ${fx.degrade.length} degrade cases, ${fails} failures`);
process.exit(fails ? 1 : 0);
