// Speed of docs/tng50/js/fit.js fitPanel on 240 panels: 5 fixture sightlines x 12 ions x the 4-case R x S/N grid of
// each band (design-3 section 8 U_fit 4: median <= 60 ms, p95 <= 300 ms, max <= 1000 ms, no panel at capMs).
// Usage: node tests/js/fit_bench.mjs [--json out.json]
import {readFileSync, writeFileSync} from "node:fs";
import {join, dirname} from "node:path";
import {fileURLToPath} from "node:url";
import {fitPanel, degradeV, decodeTNGS, seedFor, FIT_PARAMS} from "../../docs/tng50/js/fit.js";

const FIX = join(dirname(fileURLToPath(import.meta.url)), "fixtures");
const fx = JSON.parse(readFileSync(join(FIX, "fit_cases.json"), "utf8"));
const bins = {}; for (const id of fx.meta.ids) { const b = readFileSync(join(FIX, "fit_bins", `${id}.bin`)); bins[id] = decodeTNGS(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength)); }
let fails = 0;
const check = (ok, msg) => { console.log(`${ok ? "ok  " : "FAIL"} ${msg}`); if (!ok) fails++; };
const cases = band => { const R = fx.bands[band].R.pair, S = [20, 5]; return [[R[0], S[0]], [R[1], S[0]], [R[0], S[1]], [R[1], S[1]]]; };

// warm-up (JIT) on one panel, not timed
{ const c = fx.fits[1], d = bins[c.id], dd = degradeV(d.lines[c.ion], 15000, 20, d.vSys, {seed: 1});
  for (let i = 0; i < 3; i++) fitPanel({id: c.id, ion: c.ion, R: 15000, snr: 20, seed: 1, paramsTag: "bench", atom: c.atom, line: d.lines[c.ion], vSys: d.vSys, data: {v: dd.v, flux: dd.flux, sigma: dd.sigma}, seeds: c.seeds, compKeys: fx.meta.comp_keys, regions: c.regions}); }
const rows = [];
for (const c of fx.fits) {
  const d = bins[c.id], line = d.lines[c.ion];
  cases(fx.ions[c.ion].band).forEach(([R, snr], ci) => {
    const seed = seedFor(0, c.ion, ci), t0 = performance.now(), dd = degradeV(line, R, snr, d.vSys, {seed}), t1 = performance.now();
    const r = fitPanel({id: c.id, ion: c.ion, R, snr, seed, paramsTag: "bench", atom: c.atom, line, vSys: d.vSys,
      data: {v: dd.v, flux: dd.flux, sigma: dd.sigma}, seeds: c.seeds, compKeys: fx.meta.comp_keys, regions: c.regions});
    rows.push({id: c.id, ion: c.ion, R, snr, ms: r.ms, degrade_ms: t1 - t0, status: r.status, nseed: c.seeds.length, ncomp: r.comps.length, nfit: r.nfit, npix: r.npix});
  });
}
const ms = rows.map(r => r.ms).sort((a, b) => a - b), q = p => ms[Math.min(ms.length - 1, Math.floor(p * ms.length))];
const dg = rows.map(r => r.degrade_ms).sort((a, b) => a - b);
console.log(`info ${rows.length} panels: fitPanel median ${q(0.5).toFixed(1)} ms, p90 ${q(0.9).toFixed(1)}, p95 ${q(0.95).toFixed(1)}, p99 ${q(0.99).toFixed(1)}, max ${ms[ms.length - 1].toFixed(1)} ms; degradeV median ${dg[dg.length >> 1].toFixed(2)} ms, max ${dg[dg.length - 1].toFixed(1)} ms`);
console.log(`info status: ${JSON.stringify(rows.reduce((a, r) => (a[r.status] = (a[r.status] || 0) + 1, a), {}))}`);
for (const r of [...rows].sort((a, b) => b.ms - a.ms).slice(0, 5)) console.log(`info slowest ${r.id}/${r.ion} R=${r.R} S/N=${r.snr}: ${r.ms.toFixed(1)} ms, seeds ${r.nseed} -> ${r.ncomp} comps, ${r.nfit} LM runs, ${r.npix} px`);
check(rows.length === 240, `${rows.length} panels (5 sightlines x 12 ions x 4 cases)`);
check(q(0.5) <= 60, `median ${q(0.5).toFixed(1)} ms <= 60 ms`);
check(q(0.95) <= FIT_PARAMS.budgetMs, `p95 ${q(0.95).toFixed(1)} ms <= ${FIT_PARAMS.budgetMs} ms`);
check(ms[ms.length - 1] <= 1000, `max ${ms[ms.length - 1].toFixed(1)} ms <= 1000 ms`);
check(rows.every(r => r.status !== "budget" && r.status !== "error"), `no panel hit capMs (${FIT_PARAMS.capMs} ms) or failed`);
const jo = process.argv.indexOf("--json"); if (jo > 0) writeFileSync(process.argv[jo + 1], JSON.stringify(rows));
console.log(`${fails ? "FAIL" : "PASS"} fit_bench: median ${q(0.5).toFixed(1)} ms, p95 ${q(0.95).toFixed(1)} ms, max ${ms[ms.length - 1].toFixed(1)} ms`);
process.exit(fails ? 1 : 0);
