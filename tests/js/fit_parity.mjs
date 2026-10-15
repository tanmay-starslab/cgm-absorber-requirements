// Parity of docs/tng50/js/fit.js fitPanel with the Python reference fitter (tests/js/make_fit_fixture.py), and the
// column parity of the on-the-fly fits with the intrinsic tngsight.vpfit catalogue (design-3 sections 5.6 and 8).
// Usage: node tests/js/fit_parity.mjs [fit_cases.json]   (default: the committed tests/js/fixtures/fit_cases.json)
import {readFileSync} from "node:fs";
import {join, dirname} from "node:path";
import {fileURLToPath} from "node:url";
import {fitPanel, decodeTNGS, arange, degradeV, seedFor} from "../../docs/tng50/js/fit.js";

const HERE = dirname(fileURLToPath(import.meta.url)), FIX = join(HERE, "fixtures");
const fx = JSON.parse(readFileSync(process.argv[2] || join(FIX, "fit_cases.json"), "utf8"));
const f4 = s => { const b = Buffer.from(s, "base64"); return Float64Array.from(new Float32Array(b.buffer, b.byteOffset, b.byteLength / 4)); };
const bins = {}; for (const id of fx.meta.ids) { const b = readFileSync(join(FIX, "fit_bins", `${id}.bin`)); bins[id] = decodeTNGS(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength)); }
let fails = 0;
const check = (ok, msg) => { console.log(`${ok ? "ok  " : "FAIL"} ${msg}`); if (!ok) fails++; };

function caseReq(c) {
  const dec = bins[c.id], line = dec.lines[c.ion], [lo, hi, step] = c.v_arange;
  return {id: c.id, ion: c.ion, R: c.R, snr: c.snr, seed: c.seed, paramsTag: "fixture", atom: c.atom, line, vSys: dec.vSys,
    data: {v: arange(lo, hi, step), flux: f4(c.flux), sigma: c.sigma}, seeds: c.seeds, compKeys: fx.meta.comp_keys, regions: c.regions};
}

function addCols(r, c) {   // column parity with the intrinsic vpfit catalogue, per fitted window
  const iN = fx.meta.comp_keys.indexOf("logN"), iF = fx.meta.comp_keys.indexOf("flag"), iv = fx.meta.comp_keys.indexOf("v");
  for (const [lo, hi] of r.windows) {
    const qs = r.comps.filter(q => q.v >= lo && q.v <= hi), seeds = c.seeds.filter(s => s[iv] >= lo && s[iv] <= hi);
    if (!seeds.length || !qs.length || qs.some(q => q.flag) || seeds.some(s => s[iF] & (1 | 8 | 64))) continue;
    const lj = Math.log10(qs.reduce((s, q) => s + 10 ** q.logN, 0)), lp = Math.log10(seeds.reduce((s, x) => s + 10 ** x[iN], 0));
    colRows.push({id: c.id, ion: c.ion, snr: r.snr ?? c.snr, R: c.R, d: lj - lp, err: Math.sqrt(qs.reduce((s, q) => s + (q.dlogN == null ? 0 : (q.dlogN * 10 ** q.logN) ** 2), 0)) / 10 ** lj});
  }
}
let sameN = 0, nCmp = 0, worst = {v: 0, logN: 0, b: 0}, badComp = [], relChi = 0, chiOk = 0, chiN = 0, flagsSame = 0, flagsN = 0;
const colRows = [];
for (const c of fx.fits) {
  const req = caseReq(c), r = fitPanel(req), e = c.expected;
  if (r.status !== e.status) check(false, `${c.id}/${c.ion}: status ${r.status} vs ${e.status} ${r.message || ""}`);
  if (r.comps.length === e.comps.length) {
    sameN++;
    r.comps.forEach((q, i) => { const p = e.comps[i], dv = Math.abs(q.v - p.v), dn = Math.abs(q.logN - p.logN), db = Math.abs(q.b - p.b); nCmp++;
      worst.v = Math.max(worst.v, dv); worst.logN = Math.max(worst.logN, dn); worst.b = Math.max(worst.b, db);
      flagsN++; if (q.flag === p.flag) flagsSame++;
      if (dv > 0.2 || dn > 0.01 || db > 0.2) badComp.push(`${c.id}/${c.ion}#${i} dv=${dv.toFixed(3)} dlogN=${dn.toFixed(4)} db=${db.toFixed(3)}`); });
  } else console.log(`note ${c.id}/${c.ion} R=${c.R} S/N=${c.snr}: n_comp js ${r.comps.length} vs py ${e.comps.length}`);
  if (e.chi2 > 0) { const d = Math.abs(r.chi2 - e.chi2) / e.chi2; relChi = Math.max(relChi, d); chiN++; if (r.chi2 <= 1.001 * e.chi2_scipy + 0.5) chiOk++; }
  addCols(r, c);
}
const n = fx.fits.length;
check(sameN / n >= 0.98, `same n_comp as the Python reference in ${sameN}/${n} cases (need >= 98%)`);
check(badComp.length === 0, `matched components (${nCmp}): max |dv| ${worst.v.toFixed(3)} km/s, |dlogN| ${worst.logN.toFixed(4)}, |db| ${worst.b.toFixed(3)} km/s (tol 0.2, 0.01, 0.2)${badComp.length ? "; " + badComp.slice(0, 5).join("; ") : ""}`);
check(relChi <= 1e-3, `max |dchi2|/chi2 = ${relChi.toExponential(2)} (tol 1e-3)`);
check(chiOk / chiN >= 0.95, `chi2_js <= 1.001 chi2_scipy + 0.5 in ${chiOk}/${chiN} cases (need >= 95%)`);
console.log(`info flags identical on ${flagsSame}/${flagsN} matched components`);
// sum-N parity with vpfit: the on-the-fly fit of the degraded noisy spectrum recovers the intrinsic column of each
// clean window (no flag on the fit or the vpfit components) within max(3 sigma, 0.05 dex)
function colCheck(rows, label, need) {
  const ad = rows.map(x => Math.abs(x.d)).sort((a, b) => a - b), q = p => ad[Math.min(ad.length - 1, Math.floor(p * ad.length))];
  const okN = rows.filter(x => Math.abs(x.d) <= Math.max(3 * x.err, 0.05)).length;
  check(rows.length >= 10 && okN / rows.length >= need, `sum-N parity with vpfit, ${label}: ${okN}/${rows.length} clean windows within max(3 sigma, 0.05 dex) (need ${need * 100}%); median |dlogN| ${q(0.5).toFixed(3)}, p90 ${q(0.9).toFixed(3)} dex`);
  for (const x of rows.filter(x => Math.abs(x.d) > Math.max(3 * x.err, 0.05))) console.log(`note sum-N ${x.id}/${x.ion} R=${x.R} S/N=${x.snr}: dlogN ${x.d.toFixed(3)} (sigma ${x.err.toFixed(3)})`);
}
colCheck(colRows, "fixture cases (S/N 5 and 20)", 0.9);
// the same at S/N 100 (the UI maximum) and the high R of each band's pair, JS noise
{ const hi = [];
  for (const c of fx.fits) {
    const R = fx.bands[fx.ions[c.ion].band].R.pair[1], req = caseReq(c), dec = bins[c.id];
    const dd = degradeV(dec.lines[c.ion], R, 100, dec.vSys, {seed: seedFor(0, c.ion, 1)});
    const r = fitPanel({...req, R, snr: 100, data: {v: dd.v, flux: dd.flux, sigma: dd.sigma}});
    colRows.length = 0; addCols(r, c); hi.push(...colRows);
  }
  colCheck(hi, "S/N 100 at R = band pair[1]", 0.9); }
console.log(`${fails ? "FAIL" : "PASS"} fit_parity: ${n} cases, ${fails} failures`);
process.exit(fails ? 1 : 0);
