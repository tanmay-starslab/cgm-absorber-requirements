// Story spectrum scenes (S5 to S12) against the explorer physics (PLAN_final §6, unit U2). For every galaxy and beam in
// ROOT/data/index.json (any of the TNG50 MW/M31 sample that has story data; skipped when its stored line is absent):
//  1. the cell sum through fit.js tauVoigt (plot.js tauCache) reproduces the stored F_intrinsic (H I < 2e-3, O VI < 3e-4)
//  2. plot.js observed() is the explorer's panel: degradeV of the stored line with the panel noise seed gives the
//     stored pixel count, sigma and flux sum of every page fit
//  3. fitPanel on plot.js fitRequest() with capMs = budgetMs = 1e9 returns the stored clouds (dlogN < 0.01, dV < 1 km/s)
//  4. cloud models are point-sampled (box: 0): the scenes' model of the stored clouds equals fitPanel's own model
//  5. feature picks obey their rules (S6 pair: |dV| < min b; S10 feature is a real dip, truth tau > 0.05)
//  6. every scene renders without throwing at every step, and is pure: render(a), render(b), render(a) records the
//     same canvas calls for a, forward and reverse
import {readFileSync, existsSync} from "node:fs";
import {join, dirname} from "node:path";
import {fileURLToPath} from "node:url";
import {decodeTNGS, fitPanel, degradeV, tauVoigt} from "../../docs/tng50/js/fit.js";
import * as K from "../../docs/tng50/learn/how-a-spectrum-is-made/js/plot.js";

const HERE = dirname(fileURLToPath(import.meta.url)), REPO = join(HERE, "..", ".."), TNG = join(REPO, "docs", "tng50");
const ROOT = join(TNG, "learn", "how-a-spectrum-is-made"), DATA = join(ROOT, "data");
const SCENES = ["dip", "speed", "sum", "saturation", "lsf", "noise", "fit", "yourturn"];
let fails = 0, nchk = 0;
const check = (ok, msg) => { nchk++; console.log(`${ok ? "ok  " : "FAIL"} ${msg}`); if (!ok) fails++; };
const ab = b => b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength);

if (!existsSync(join(DATA, "index.json"))) { console.log("ok   skipped: no story data index (ROOT/data/index.json)"); process.exit(0); }
const index = JSON.parse(readFileSync(join(DATA, "index.json"), "utf8"));
const defG = +(index.default && index.default.galaxy) || K.DEFAULT_GALAXY;
const steps = existsSync(join(ROOT, "steps.json")) ? JSON.parse(readFileSync(join(ROOT, "steps.json"), "utf8")).steps : [];
const scenes = {};
for (const n of SCENES) scenes[n] = (await import(join(ROOT, "js", "scenes", `${n}.js`))).default;

// recording 2D context: every call and property write, numbers rounded so float noise cannot hide in the log
function recorder(W = 960, H = 540) {
  const log = [], r = x => (typeof x === "number" ? +x.toFixed(4) : typeof x === "object" && x ? "[obj]" : x);
  const grad = {addColorStop: (...a) => log.push(["grad.stop", ...a.map(r)])};
  const target = {canvas: {width: W, height: H}, measureText: s => ({width: String(s).length * 7}),
    createRadialGradient: (...a) => (log.push(["radial", ...a.map(r)]), grad), createLinearGradient: (...a) => (log.push(["linear", ...a.map(r)]), grad)};
  const ctx = new Proxy(target, {
    get(t, k) { if (k in t) return t[k]; return (...a) => { log.push([String(k), ...a.map(r)]); }; },
    set(t, k, v) { log.push(["=" + String(k), r(v)]); return true; }});
  return {ctx, log};
}

for (const e of index.stories || []) {
  const g = +e.galaxy, ray = e.ray, tag = `${g}/${ray}`;
  const data = JSON.parse(readFileSync(join(DATA, e.story), "utf8"));
  if (e.page_fits && existsSync(join(DATA, e.page_fits))) data.page_fits = JSON.parse(readFileSync(join(DATA, e.page_fits), "utf8"));
  const bin = g === defG ? join(TNG, "data", "s", `${ray}.bin`) : join(TNG, "data", "gal", String(g), "s", `${ray}.bin`);
  if (!existsSync(bin)) { console.log(`ok   ${tag}: stored line ${bin} not in this checkout, line checks skipped`); }
  else { const d = decodeTNGS(ab(readFileSync(bin))); data.lines = {vSys: d.vSys, ...d.lines}; }
  const P = K.prep(data);

  // 1. cell sum vs F_intrinsic
  for (const [k, lim] of [["HI", 2e-3], ["OVI", 3e-4]]) {
    const I = P.ions[k]; if (!I || !I.F) { check(false, `${tag} ${k}: no cells or F_intrinsic`); continue; }
    const c = K.tauCache(data, k), tau = K.sumTau(c, c.start.length); let dF = 0;
    for (let i = 0; i < I.F.n; i++) dF = Math.max(dF, Math.abs(Math.exp(-tau[i]) - I.F.flux[i]));
    // the CSR supports must not cut anything: a full-grid tauVoigt sum gives the same answer
    const all = []; for (let j = 0; j < I.cells.n; j++) all.push([I.cells.V[j], I.cells.logN[j], I.cells.b[j]]);
    const full = tauVoigt(I.atom, all, I.F.v); let dT = 0; for (let i = 0; i < I.F.n; i++) dT = Math.max(dT, Math.abs(full[i] - tau[i]) / Math.max(1, full[i]));
    check(dF < lim && dT < 1e-5, `${tag} ${k}: tauVoigt cell sum vs F_intrinsic max|dF| ${dF.toExponential(2)} < ${lim}, CSR vs full grid ${dT.toExponential(1)}`);
  }
  if (!data.lines) continue;

  // 2, 3, 4. page fits
  const fits = ["OVI", "HI"].flatMap(k => (P.ions[k] && P.ions[k].fits) || []);
  check(fits.length > 0, `${tag}: ${fits.length} stored page fits`);
  for (const f of fits) {
    const k = f.ion, I = P.ions[k], o = K.observed(data, k, f.R, f.snr, f.noiseSeed);
    let s = 0; for (const x of o.flux) s += x;
    const dg = f.degrade || {};
    check(dg.npix == null || (o.v.length === dg.npix && Math.abs(s - dg.sum_flux) < 1e-4 && Math.abs(o.sigma - dg.sigma) < 1e-4),
      `${tag} ${k} R ${f.R} S/N ${f.snr} seed ${f.seedParam} case ${f.ci}: degradeV pixels ${o.v.length} (${dg.npix}), flux sum ${s.toFixed(4)} (${dg.sum_flux})`);
    const req = K.fitRequest(data, k, f.R, f.snr, f.seedParam, f.ci);
    check(req.seed === f.noiseSeed, `${tag} ${k} R ${f.R} S/N ${f.snr}: request noise seed ${req.seed} = stored ${f.noiseSeed}`);
    const r = fitPanel({...req, params: {capMs: 1e9, budgetMs: 1e9}});
    const a = r.comps || [], b = f.comps || [];
    let ok = r.status === "ok" && a.length === b.length, dN = 0, dV = 0;
    if (ok) a.forEach((c, i) => { dN = Math.max(dN, Math.abs(c.logN - b[i].logN)); dV = Math.max(dV, Math.abs(c.v - b[i].v)); });
    check(ok && dN < 0.01 && dV < 1, `${tag} ${k} R ${f.R} S/N ${f.snr} seed ${f.seedParam}: fitPanel ${a.length} clouds (stored ${b.length}), max dlogN ${dN.toFixed(4)}, max dV ${dV.toFixed(3)}`);
    if (ok && a.length) {
      // the scenes' cloud model (tauVoigt + degradeV with box 0) on the data pixels vs fitPanel's model
      const L = I.line, Vf = K.vgrid(L.u0 + P.meta.vSys, L.du, L.n), tau = tauVoigt(I.atom, b.map(c => [c.v, c.logN, c.b]), Vf);
      const m = degradeV({n: L.n, u0: L.u0, du: L.du, flux: K.expNeg(tau), box: 0}, f.R, 0, P.meta.vSys).model;
      let dm = 0; for (const [lo, hi] of r.windows) for (let i = 0; i < m.length; i++) if (req.data.v[i] >= lo && req.data.v[i] <= hi) dm = Math.max(dm, Math.abs(m[i] - r.model[i]));
      // the drawn model uses a truncated fine grid around +-400 km/s: same answer as the untruncated line, same pixels
      const cm = K.cloudModel(data, k, b, f.R, 400), ref = degradeV({n: L.n, u0: L.u0, du: L.du, flux: K.expNeg(tau), box: 0}, f.R, 0, P.meta.vSys, {vwin: 400, vcenter: 0});
      let dc = cm.v.length === ref.v.length ? 0 : Infinity; if (dc === 0) for (let i = 0; i < cm.v.length; i++) dc = Math.max(dc, Math.abs(cm.model[i] - ref.model[i]));
      check(dm < 2e-3 && dc < 1e-9, `${tag} ${k} R ${f.R} S/N ${f.snr}: point-sampled cloud model vs fitPanel model max|dF| ${dm.toExponential(1)} (stored clouds rounded), drawn model (truncated grid) vs full ${dc.toExponential(1)}`);
    }
  }

  // 5. picks
  const pk = K.picks(data), O = P.ions.OVI.cells;
  if (pk.pair) { const [a, b] = pk.pair, dv = Math.abs(O.V[a] - O.V[b]), mb = Math.min(O.b[a], O.b[b]);
    check(dv < mb, `${tag} S6 pair cells ${O.i[a]}, ${O.i[b]}: |dV| ${dv.toFixed(2)} < min b ${mb.toFixed(2)}, ${Math.abs(O.l[a] - O.l[b]).toFixed(1)} kpc apart`); }
  if (pk.weak) { const I = P.ions.OVI, i = Math.round((pk.weak.v - I.F.v0) / I.F.dv), t = -Math.log(I.F.flux[i]);
    check(t > 0.05, `${tag} S10 feature at ${pk.weak.v} km/s is real: truth tau ${t.toFixed(3)} > 0.05`); }
  check(pk.seeds.length >= 1 && pk.dip >= 0, `${tag} S5 cell ${O.i[pk.dip]}, S11 ${pk.seeds.length} noise draws, broad ${pk.broad ? pk.broad.comp.b : "none"}, invented ${pk.invented ? pk.invented.comp.b : "none"}`);

  // 6. render every step, purity
  for (const n of SCENES) {
    const sc = scenes[n]; await sc.ready(data);
    const ids = steps.length ? steps.filter(s => s.scene === n).map(s => [s.id, s.params || {}]) : sc.steps.map(id => [id, {}]);
    let thrown = null, pure = true;
    for (const [id, prm] of ids) {
      const st = p => ({...prm, params: prm, step: id, p, u: p, t: p * 6, dur_s: 6, dpr: 1, layout: "land", physics: false, reduced: false, seed: 0, mode: "step", explore: null});
      try {
        const A1 = recorder(), B = recorder(), A2 = recorder(), A3 = recorder();
        sc.render(A1.ctx, st(0.3), 1.8, data, {}); sc.render(B.ctx, st(0.9), 5.4, data, {}); sc.render(A2.ctx, st(0.3), 1.8, data, {});
        sc.render(B.ctx, st(0.9), 5.4, data, {}); sc.render(A3.ctx, st(0.3), 1.8, data, {});
        const s1 = JSON.stringify(A1.log); if (s1 !== JSON.stringify(A2.log) || s1 !== JSON.stringify(A3.log)) pure = false;
        sc.render(recorder(390, 844).ctx, {...st(1), layout: "port", physics: true}, 6, data, {});
      } catch (err) { thrown = `${id}: ${err.stack}`; break; }
    }
    check(!thrown && pure, `${tag} scene ${n}: ${ids.length} steps render${thrown ? " THREW " + thrown : ""}; seek(a), seek(b), seek(a) ${pure ? "identical" : "DIFFER"}`);
  }
  // Explore overrides render too (Try it on S5, S9, S10, S11)
  for (const [n, id, ov] of [["dip", "dip-3", {logN: 13, V: 40}], ["dip", "dip-4", {b: 40, ion: 1}], ["lsf", "lsf-1", {R: 8000}], ["noise", "noise-1", {sn: 7, newNoise: 2}], ["fit", "fit-1", {R: 20000, sn: 15}]]) {
    try { scenes[n].render(recorder().ctx, {step: id, p: 1, dpr: 1, layout: "land", seed: 0, mode: "explore", explore: ov, ...ov}, 6, data, {}); check(true, `${tag} explore ${id} ${JSON.stringify(ov)}`); }
    catch (err) { check(false, `${tag} explore ${id}: ${err.stack}`); }
  }
}
console.log(`${nchk} checks, ${fails} failed`);
process.exit(fails ? 1 : 0);
