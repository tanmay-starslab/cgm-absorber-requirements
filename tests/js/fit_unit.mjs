// Unit tests of docs/tng50/js/fit.js fitPanel on synthetic absorbers with known (logN, b, v): recovery, pruning,
// flags, budget, statuses, determinism and module purity (design-3 sections 5.1 to 5.4).
import {readFileSync} from "node:fs";
import {join, dirname} from "node:path";
import {fileURLToPath} from "node:url";
import {fitPanel, degradeV, faddeeva, cacheKey, rowsToComps, fitQuality, LOOSE_DEX, FIT_VERSION, FLAGS} from "../../docs/tng50/js/fit.js";

const HERE = dirname(fileURLToPath(import.meta.url)), SRC = join(HERE, "..", "..", "docs", "tng50", "js", "fit.js");
const fx = JSON.parse(readFileSync(join(HERE, "fixtures", "fit_cases.json"), "utf8"));
const CK = ["v", "dv", "logN", "dlogN", "b", "db", "region", "flag", "EW"];
let fails = 0;
const check = (ok, msg) => { console.log(`${ok ? "ok  " : "FAIL"} ${msg}`); if (!ok) fails++; };
const atomOf = k => { const i = fx.ions[k]; return {lam0_A: i.lam0_A, f: i.f, gamma_s: i.gamma_s, b_min: i.b_min, logN_max: i.logN_max}; };

// intrinsic line on the 1 km/s web grid from known components (point-sampled tau, exact Voigt)
function synth(ion, comps, W = 1500) {
  const a = atomOf(ion), lam = a.lam0_A * 1e-8, kT = 0.02654008 * a.f * lam / (Math.sqrt(Math.PI) * 1e5), a0 = a.gamma_s * lam / (4 * Math.PI * 1e5);
  const n = 2 * W + 1, flux = new Float64Array(n);
  for (let i = 0; i < n; i++) { const u = -W + i; let t = 0; for (const [v, lN, b] of comps) t += kT * 10 ** lN * faddeeva((u - v) / b, a0 / b)[0] / b; flux[i] = Math.exp(-t); }
  return {n, u0: -W, du: 1, rest: a.lam0_A, flux};
}
const row = (v, logN, b, region = 0) => [v, null, logN, null, b, null, region, 0, 0];
function run(ion, truth, seeds, regions, R, snr, seed = 1, extra = {}) {
  const line = extra.line || synth(ion, truth, extra.W), dd = degradeV(line, R, snr, 0, {seed});
  const data = {v: dd.v, flux: extra.flux ? extra.flux(dd) : dd.flux, sigma: extra.sigma ?? dd.sigma};
  return fitPanel({id: "synthetic", ion, R, snr, seed, paramsTag: "u", atom: atomOf(ion), line, vSys: 0, data, seeds, compKeys: CK, regions, params: extra.params});
}
const sumN = cs => Math.log10(cs.reduce((s, c) => s + 10 ** c.logN, 0));

// A. noiseless recovery from perturbed seeds
{ const r = run("OVI", [[12, 13.8, 22]], [row(18, 13.4, 35)], [[0, -100, 120, null]], 30000, 1e5);
  const c = r.comps[0] || {};
  check(r.status === "ok" && r.comps.length === 1 && Math.abs(c.v - 12) <= 0.05 && Math.abs(c.logN - 13.8) <= 0.002 && Math.abs(c.b - 22) <= 0.05,
    `A noiseless O VI (12, 13.8, 22) from seed (18, 13.4, 35): (${c.v}, ${c.logN}, ${c.b}), ${r.nfit} LM runs`); }
// B. noisy recovery: pulls over 40 noise draws, C IV logN 13.6 b 15, R 30000, S/N 20
{ const P = {v: [], logN: [], b: []}; let n1 = 0;
  for (let s = 0; s < 40; s++) { const r = run("CIV", [[0, 13.6, 15]], [row(3, 13.3, 20)], [[0, -60, 60, null]], 30000, 20, 100 + s);
    if (r.comps.length !== 1) continue; n1++; const c = r.comps[0]; P.v.push(c.v / c.dv); P.logN.push((c.logN - 13.6) / c.dlogN); P.b.push((c.b - 15) / c.db); }
  const st = a => { const m = a.reduce((s, x) => s + x, 0) / a.length; return [m, Math.sqrt(a.reduce((s, x) => s + (x - m) ** 2, 0) / (a.length - 1))]; };
  const out = Object.entries(P).map(([k, a]) => { const [m, sd] = st(a); return {k, m, sd, w3: a.filter(x => Math.abs(x) <= 3).length / a.length}; });
  check(n1 === 40 && out.every(o => Math.abs(o.m) < 0.5 && o.sd > 0.6 && o.sd < 1.5 && o.w3 >= 0.9),
    `B noisy C IV, 40 draws (${n1} single-component fits): pulls ${out.map(o => `${o.k} mean ${o.m.toFixed(2)} sd ${o.sd.toFixed(2)} within 3 sigma ${(100 * o.w3).toFixed(0)}%`).join("; ")}`); }
// C. a resolved pair is kept at high R; an unresolved pair (20 km/s apart at FWHM 60 km/s) is pruned to one
{ const truth = [[-30, 13.5, 10], [30, 13.3, 10]], seeds = [row(-27, 13.4, 12), row(33, 13.4, 12)], reg = [[0, -90, 90, null]];
  const hi = run("CIV", truth, seeds, reg, 50000, 30, 7);
  check(hi.comps.length === 2 && Math.abs(hi.comps[0].v + 30) < 2 && Math.abs(hi.comps[1].v - 30) < 2, `C pair at R=50000 S/N=30: ${hi.comps.length} comps at ${hi.comps.map(c => c.v).join(", ")} km/s`);
  const t2 = [[-10, 13.5, 10], [10, 13.3, 10]], tot = Math.log10(10 ** 13.5 + 10 ** 13.3), vc = (-10 * 10 ** 13.5 + 10 * 10 ** 13.3) / 10 ** tot;
  const lo = run("CIV", t2, [row(-20, 13.4, 12), row(20, 13.4, 12)], reg, 5000, 50, 7), l0 = lo.comps[0] || {};
  check(lo.comps.length === 1 && Math.abs(l0.logN - tot) <= Math.max(3 * l0.dlogN, 0.05) && Math.abs(l0.v - vc) <= Math.max(3 * l0.dv, 3) && lo.nfit >= 2,
    `C unresolved pair (+-10 km/s) at R=5000 S/N=50, seeds 40 km/s apart: ${lo.comps.length} comp at ${l0.v} km/s (centroid ${vc.toFixed(1)}), logN ${l0.logN} +- ${l0.dlogN} (total ${tot.toFixed(3)}), ${lo.nfit} LM runs`); }
// D. a spurious weak seed is pruned by Delta BIC
{ const r = run("OVI", [[0, 14.0, 25]], [row(2, 13.9, 24), row(80, 12.2, 10)], [[0, -80, 110, null]], 30000, 20, 3);
  check(r.comps.length === 1 && Math.abs(r.comps[0].v) < 3, `D spurious seed at +80 km/s pruned: ${r.comps.length} comp(s) at ${r.comps.map(c => c.v).join(", ")}`); }
// E. no absorption: the last component is dropped against the no-absorber model
{ const r = run("OVI", [], [row(0, 12.3, 20)], [[0, -60, 60, null]], 30000, 10, 4);
  check(r.status === "ok" && r.comps.length === 0 && r.windows.length === 1 && r.model.every(x => x === 1) && r.profiles.length === 0, `E continuum only: ${r.comps.length} comps, model = 1, chi2 ${r.chi2.toFixed(1)}/${r.dof}`); }
// F. saturated Mg II: SAT flag
{ const r = run("MgII", [[0, 15.5, 6]], [row(1, 15.0, 8)], [[0, -40, 40, null]], 30000, 20, 5);
  check(r.comps.length >= 1 && r.comps.some(c => c.flag & FLAGS.SAT), `F saturated Mg II (15.5, 6): flags ${r.comps.map(c => c.flag).join(",")}, logN ${r.comps.map(c => c.logN).join(",")}`); }
// F2. SAT as tngsight.vpfit (Phase-3 Code 1): a component whose intrinsic line-centre optical depth k_tau N H(a, 0)/b
// reaches 5 is SAT even when the LSF keeps the model above 0.05 (low R), and SAT without DAMPED carries NOERR with
// dlogN and db null; fitQuality calls it "sat". Saturated C II, Mg II and C IV at R 5000, 30000 and 150000.
{ const tau0 = (ion, c) => { const a = atomOf(ion), lam = a.lam0_A * 1e-8, kT = 0.02654008 * a.f * lam / (Math.sqrt(Math.PI) * 1e5), a0 = a.gamma_s * lam / (4 * Math.PI * 1e5);
    return kT * 10 ** c.logN * faddeeva(0, a0 / c.b)[0] / c.b; };
  let nSat = 0, nTauOnly = 0, bad = [], seen = [];
  for (const [ion, truth] of [["CII", [0, 16.5, 6]], ["MgII", [5, 15.2, 4]], ["CIV", [-10, 15.0, 8]]]) for (const R of [5000, 30000, 150000]) {
    const r = run(ion, [truth], [row(truth[0] + 1, truth[1] - 0.2, truth[2] * 1.2)], [[0, -80, 80, null]], R, 100, 21);
    const dd = degradeV(synth(ion, [truth]), R, 0, 0);
    for (const c of r.comps) {
      const t0 = tau0(ion, c), sat = !!(c.flag & FLAGS.SAT); seen.push(`${ion} R ${R}: logN ${c.logN} b ${c.b} tau0 ${t0.toPrecision(3)} flag ${c.flag}`);
      if (t0 >= 5 && !sat) bad.push(`${ion} R ${R} tau0 ${t0.toPrecision(3)} without SAT`);
      if (sat) { nSat++; if (!(c.flag & FLAGS.NOERR) || c.dlogN !== null || c.db !== null || fitQuality(c) !== "sat") bad.push(`${ion} R ${R} SAT flag ${c.flag} dlogN ${c.dlogN} db ${c.db} q ${fitQuality(c)}`);
        let mn = Infinity; for (let i = 0; i < dd.v.length; i++) if (dd.v[i] >= c.v - c.b && dd.v[i] <= c.v + c.b) mn = Math.min(mn, r.model[i]);
        if (t0 >= 5 && mn >= 0.05) nTauOnly++; }
    }
  }
  check(bad.length === 0 && nSat >= 7 && nTauOnly >= 1, `F2 SAT from tau0 >= 5 with NOERR and null errors: ${nSat} SAT components, ${nTauOnly} caught only by tau0 (model min >= 0.05)${bad.length ? "; " + bad.join("; ") : ""} [${seen.join("; ")}]`); }
// G. O VII in the X-ray band
{ const r = run("OVII", [[10, 16.0, 60]], [row(0, 15.7, 45)], [[0, -200, 220, null]], 1000, 50, 6), c = r.comps[0] || {};
  check(r.comps.length === 1 && Math.abs(c.logN - 16.0) < 0.1 && Math.abs(c.v - 10) < 25, `G O VII (10, 16.0, 60) at R=1000 S/N=50: (${c.v}, ${c.logN} +- ${c.dlogN}, ${c.b})`); }
// H. damped H I with wide wings: DAMPED (its wings pin N), so SAT keeps the errors and the column is a measurement
{ const r = run("HI", [[0, 20.3, 25]], [row(10, 20.0, 30)], [[0, -1400, 1400, null]], 15000, 20, 8, {W: 3000}), c = r.comps[0] || {};
  check(r.comps.length === 1 && Math.abs(c.logN - 20.3) < 0.02 && (c.flag & FLAGS.DAMPED) && (c.flag & FLAGS.SAT) && !(c.flag & FLAGS.NOERR) && Number.isFinite(c.dlogN) && fitQuality(c) !== "sat",
    `H damped H I (0, 20.3, 25), window +-3000: (${c.v}, ${c.logN} +- ${c.dlogN}, ${c.b}), flag ${c.flag} (DAMPED, SAT, errors kept), quality ${fitQuality(c)}, ${r.ms.toFixed(0)} ms`); }
// I. a line narrower than b_min hits the bound: BOUND flag
{ const r = run("OVI", [[0, 13.5, 1.0]], [row(0, 13.5, 3)], [[0, -30, 30, null]], 150000, 50, 9), c = r.comps[0] || {};
  check(r.comps.length === 1 && c.b === fx.ions.OVI.b_min && (c.flag & FLAGS.BOUND), `I b = 1 km/s < b_min ${fx.ions.OVI.b_min}: b ${c.b}, flag ${c.flag}`); }
// J. budget: capMs 0 stops at once, status budget, BUDGET on every component
{ const r = run("CIV", [[-30, 13.5, 10], [30, 13.3, 10]], [row(-25, 13.0, 20), row(35, 13.0, 20)], [[0, -90, 90, null]], 30000, 20, 10, {params: {capMs: 0}});
  check(r.status === "budget" && r.comps.length > 0 && r.comps.every(c => c.flag & FLAGS.BUDGET), `J capMs 0: status ${r.status}, flags ${r.comps.map(c => c.flag).join(",")}`); }
// K. statuses: no seeds, no usable window, bad input -> error without throwing
{ const a = run("OVI", [[0, 14, 20]], [], [[0, -50, 50, null]], 30000, 20), b = run("OVI", [[0, 14, 20]], [row(2000, 13, 20)], [[0, 1900, 2100, null]], 30000, 20);
  let threw = false, e; try { e = fitPanel({id: "x", ion: "OVI", R: 30000, snr: 10, seed: 0, paramsTag: "", atom: atomOf("OVI"), line: null, vSys: 0, data: null, seeds: [row(0, 13, 20)], regions: [[0, -1, 1, null]]}); } catch (_) { threw = true; }
  check(a.status === "no_seeds" && b.status === "no_seeds" && !threw && e.status === "error" && typeof e.message === "string", `K statuses: no seeds -> ${a.status}; window outside the data -> ${b.status}; bad input -> ${e && e.status} ("${e && e.message}")`); }
// L. seeds closer than mergeFrac * FWHM_eff merge by moment matching before the fit
{ const r = run("OVI", [[0, 14.0, 25]], [row(-0.5, 13.7, 25), row(0.5, 13.7, 25)], [[0, -80, 80, null]], 30000, 1e4, 11);
  check(r.comps.length === 1 && Math.abs(r.comps[0].logN - 14.0) < 0.005 && r.nfit === 1, `L two seeds 1 km/s apart -> one component, logN ${r.comps[0] && r.comps[0].logN}, ${r.nfit} LM run (no pruning needed)`); }
// M. profiles: an isolated component's profile equals the model; both are 1 outside the window
{ const r = run("OVI", [[0, 14.0, 25]], [row(0, 14.0, 25)], [[0, -80, 80, null]], 30000, 50, 12), p = r.profiles[0];
  let d = 0, out1 = true; for (let i = 0; i < p.length; i++) { d = Math.max(d, Math.abs(p[i] - r.model[i])); }
  const [lo, hi] = r.windows[0], v = degradeV(synth("OVI", [[0, 14, 25]]), 30000, 50, 0, {seed: 12}).v; v.forEach((x, i) => { if ((x < lo || x > hi) && (p[i] !== 1 || r.model[i] !== 1)) out1 = false; });
  check(r.profiles.length === 1 && p instanceof Float32Array && d === 0 && out1, `M profile = model for one component (max diff ${d}), 1 outside [${lo.toFixed(1)}, ${hi.toFixed(1)}]`); }
// N. POORFIT when the stated sigma is 5x too small
{ const r = run("OVI", [[0, 14.0, 25]], [row(0, 14.0, 25)], [[0, -80, 80, null]], 30000, 10, 13, {sigma: Math.sqrt(5) / 50});
  check(r.comps.length >= 1 && r.comps.every(c => c.flag & FLAGS.POORFIT), `N underestimated sigma: chi2/dof ${(r.chi2 / r.dof).toFixed(1)}, flags ${r.comps.map(c => c.flag).join(",")}`); }
// O. determinism, rounding, result shape
{ const A = run("SiIV", [[-20, 13.2, 12], [25, 13.0, 8]], [row(-18, 13, 15), row(22, 13, 10)], [[0, -70, 70, null]], 50000, 20, 14);
  const B = run("SiIV", [[-20, 13.2, 12], [25, 13.0, 8]], [row(-18, 13, 15), row(22, 13, 10)], [[0, -70, 70, null]], 50000, 20, 14);
  const strip = r => JSON.stringify({...r, ms: 0, model: [...r.model], profiles: r.profiles.map(p => [...p])});
  const dp = (x, d) => x == null || Math.abs(x * 10 ** d - Math.round(x * 10 ** d)) < 1e-6;
  check(strip(A) === strip(B), "O identical results on repeated calls");
  check(A.version === FIT_VERSION && A.comps.every((c, i) => dp(c.v, 2) && dp(c.dv, 2) && dp(c.logN, 3) && dp(c.dlogN, 3) && dp(c.b, 2) && dp(c.db, 2) && (i === 0 || A.comps[i - 1].v <= c.v)) &&
    ["key", "status", "version", "ms", "comps", "model", "profiles", "windows", "chi2", "dof", "npix", "bic", "nfit"].every(k => k in A), `O result shape, sorted by v, rounded as components v2 (${A.comps.length} comps)`); }
// R. fitQuality classes, and an unresolved weak component: Mg II b = 5 km/s at R = 20000 (FWHM 15 km/s). Many "ok" fits
// have sigma(b) > b (the page's old rule called them "unconstrained", B_retest item 3), yet their logN errors are honest:
// over 40 noise draws the logN pulls of the "ok" fits have |mean| < 0.5, sd 0.5 to 1.3 and all within 3 sigma. The
// others sit on b_min ("bound").
{ const Q = [[null, "unconstrained"], [{flag: 1}, "sat"], [{flag: 1 | 2, dlogN: null}, "sat"], [{flag: 1 | 64, logN: 20.3, dlogN: 0.02}, "ok"],
    [{flag: 2, dlogN: 0.1}, "bound"], [{flag: 128, dlogN: 0.1}, "bound"], [{flag: 32, dlogN: null}, "unconstrained"],
    [{flag: 0, dlogN: null, db: 1}, "unconstrained"], [{flag: 0, dlogN: LOOSE_DEX + 0.01, db: 1, b: 5}, "unconstrained"],
    [{flag: 0, dlogN: 0.1, db: 50, b: 5}, "ok"], [{flag: 8, dlogN: 0.1, db: 1, b: 5}, "ok"]];
  const qb = Q.filter(([c, want]) => fitQuality(c) !== want);
  check(qb.length === 0, `R fitQuality on ${Q.length} flag/error cases${qb.length ? ": wrong " + qb.map(([c, w]) => `${JSON.stringify(c)} -> ${fitQuality(c)} (want ${w})`).join("; ") : ""}`);
  const pulls = [], Qn = {}; let nLooseB = 0;
  for (let s = 0; s < 40; s++) { const r = run("MgII", [[0, 11.8, 5]], [row(1, 11.6, 7)], [[0, -40, 40, null]], 20000, 50, 300 + s);
    if (r.comps.length !== 1) { Qn.none = (Qn.none || 0) + 1; continue; } const c = r.comps[0], q = fitQuality(c); Qn[q] = (Qn[q] || 0) + 1;
    if (q === "ok") { pulls.push((c.logN - 11.8) / c.dlogN); if (c.db > Math.max(c.b, 1)) nLooseB++; } }
  const m = pulls.reduce((a, x) => a + x, 0) / pulls.length, sd = Math.sqrt(pulls.reduce((a, x) => a + (x - m) ** 2, 0) / (pulls.length - 1)), w3 = pulls.filter(x => Math.abs(x) <= 3).length / pulls.length;
  check(pulls.length >= 15 && nLooseB >= 5 && Math.abs(m) < 0.5 && sd > 0.5 && sd < 1.3 && w3 >= 0.95,
    `R unresolved Mg II (0, 11.8, 5) at R 20000 S/N 50, 40 draws: ${JSON.stringify(Qn)}; ${nLooseB} "ok" fits with sigma(b) > b; logN pulls of the "ok" fits mean ${m.toFixed(2)} sd ${sd.toFixed(2)}, within 3 sigma ${(100 * w3).toFixed(0)}%`); }
// P. cacheKey and rowsToComps
{ const k = cacheKey({id: "edge_b100_a090", ion: "OVI", R: 15000, snr: 20, seed: 42, paramsTag: "abc"});
  const c = rowsToComps([[1.5, 0.1, 13.2, 0.02, 20, 1, 0, 0, 33]], CK)[0];
  check(k === "fit/1|edge_b100_a090|OVI|15000|20|42|abc" && c.v === 1.5 && c.logN === 13.2 && c.b === 20 && c.region === 0 && rowsToComps(null, CK).length === 0, `P cacheKey "${k}", rowsToComps`); }
// Q. purity: no DOM or browser globals, and no module-level mutable state besides the Weideman table
{ const src = readFileSync(SRC, "utf8"), code = src.replace(/\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "").replace(/"(?:[^"\\]|\\.)*"|`(?:[^`\\]|\\.)*`/g, '""');
  const bad = ["document", "window", "localStorage", "sessionStorage", "fetch", "XMLHttpRequest", "self", "importScripts", "postMessage"].filter(w => new RegExp(`\\b${w}\\b`).test(code));
  const top = code.split("\n").filter(l => /^(let|var)\s/.test(l) || /^export\s+(let|var)\s/.test(l));
  check(bad.length === 0 && top.length === 0, `Q fit.js has no DOM or worker globals (${bad.join(",") || "none"}) and no top-level let/var (${top.length})`); }
console.log(`${fails ? "FAIL" : "PASS"} fit_unit: ${fails} failures`);
process.exit(fails ? 1 : 0);
