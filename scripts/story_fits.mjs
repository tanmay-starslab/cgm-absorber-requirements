// Precomputed noisy fits for the Learn page "How a spectrum is made" (PLAN_final section 6, data/page_fits_*.json).
// Runs the explorer's own degradeV + fitPanel (docs/tng50/js/fit.js) on the stored sightline binary, with exactly the
// request the explorer builds (docs/tng50/js/app.js fitRequest: same atom fields, seeds, regions, panel noise seed
// seedFor(seed, ion, caseIndex)), so a hand-off to the explorer shows the same noise draw and the same fit. The only
// difference: capMs/budgetMs are lifted (1e9) so the result does not depend on the machine's speed; the page's
// live fits keep the 1.5 s cap and are flagged BUDGET when they hit it.
//
//   node scripts/story_fits.mjs [--galaxy 488530] [--ray rand_b062_a062] [--library DIR] [--work DIR] [--out DIR]
// Default library: 488530 -> $TNG_WORK/data/library_v3r, other hosts -> $TNG_WORK/data/gal/<id>/library.
// Writes <out>/page_fits_<gid>_<ray>.json (no spectra: the page recomputes degradeV from the stored seed; the
// checksums below let tests/js/story_parity.mjs prove it gets the same draw).
import {readFileSync, writeFileSync, mkdirSync, existsSync} from "node:fs";
import {dirname, join, resolve} from "node:path";
import {fileURLToPath} from "node:url";
import {gzipSync} from "node:zlib";

const HERE = dirname(fileURLToPath(import.meta.url)), REPO = resolve(HERE, "..");
const FIT = await import(join(REPO, "docs/tng50/js/fit.js"));
const {fitPanel, degradeV, decodeTNGS, seedFor, FIT_VERSION} = FIT;

const arg = (k, d) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : d; };
const GAL = +arg("--galaxy", 488530), RAY = arg("--ray", "rand_b062_a062");
const WORK = process.env.TNG_WORK || "/Volumes/cgm_work";
let LIB = arg("--library", GAL === 488530 ? (process.env.TNG_STORY_LIBRARY || join(WORK, "data/library_v3r")) : join(WORK, `data/gal/${GAL}/library`));
// a host without a library: the one-ray library export_story_data.py cells made in its --work dir
const SWORK = arg("--work", process.env.STORY_WORK || join(WORK, "scratch/story_data"));
if (!existsSync(join(LIB, "web", `${RAY}.bin`)) && existsSync(join(SWORK, `lib_${GAL}`, "web", `${RAY}.bin`))) LIB = join(SWORK, `lib_${GAL}`);
const OUT = resolve(arg("--out", join(REPO, "docs/tng50/learn/how-a-spectrum-is-made/data")));
// Tier A (DESIGN_tierA §4.4): --ions OVI,HI,MgII adds the story's extra ion; --page adds the page-default case (R 15 000,
// S/N 10, page seed 0) the case/1 claims are judged at; --noise searches the empty-case noise seed. Without these flags
// the output is exactly the v2 file (the hero and staged stories are never rebuilt with them).
const IONS = (arg("--ions", "OVI,HI")).split(",").filter(Boolean);
const PAGE = process.argv.includes("--page"), NOISE = process.argv.includes("--noise");
const NOCAP = {capMs: 1e9, budgetMs: 1e9};
const DEF_KEYS = ["v", "dv", "logN", "dlogN", "b", "db", "region", "flag", "EW"];
const KB = 1.380649e-16, AMU = 1.66053906660e-24, MASS = {H: 1.00794, O: 15.9994};
const T_INVENTED = 3e4;     // an O VI component narrower than b(3e4 K) cannot be O VI-bearing gas in this model

const REG = JSON.parse(readFileSync(join(REPO, "tngsight/ions.json"), "utf8"));
const ION = Object.fromEntries(REG.ions.map(i => [i.key, i]));
const bin = readFileSync(join(LIB, "web", `${RAY}.bin`));
const D = decodeTNGS(bin.buffer.slice(bin.byteOffset, bin.byteOffset + bin.byteLength));
const CJ = JSON.parse(readFileSync(join(LIB, "components", `${RAY}.json`), "utf8"));
const compKeys = CJ.keys || DEF_KEYS;

// Explorer cases: layout, per-band R pair, S/N pair, page seed. caseIndex follows state.js casesFor(layout).
const CASES = [
  {name: "default", layout: "1", R: [30000, 30000], sn: [10, 10], seed: 0, ci: [0]},
  {name: "grid4", layout: "4", R: [15000, 50000], sn: [20, 5], seed: 0, ci: [0, 1, 2, 3]},
  {name: "s11a_seed1", layout: "1", R: [30000, 30000], sn: [10, 10], seed: 1, ci: [0]},
  {name: "s11a_seed2", layout: "1", R: [30000, 30000], sn: [10, 10], seed: 2, ci: [0]},
];
if (PAGE) CASES.push({name: "page", layout: "1", R: [15000, 15000], sn: [10, 10], seed: 0, ci: [0]});
const CASE_RS = {"1": [[0, 0]], "4": [[0, 0], [1, 0], [0, 1], [1, 1]]};

const sum = a => { let s = 0; for (const x of a) s += x; return s; };
const r4 = x => Number.isFinite(x) ? +x.toFixed(4) : null;
const totalLogN = comps => { const iN = compKeys.indexOf("logN"); const s = sum(comps.map(c => 10 ** c[iN])); return s > 0 ? +Math.log10(s).toFixed(3) : null; };

function runFit(ion, c, ci) {
  const A = ION[ion], [iR, iS] = CASE_RS[c.layout][ci], R = c.R[iR], snr = c.sn[iS];
  const noiseSeed = seedFor(c.seed, ion, ci), L = D.lines[ion];
  const dd = degradeV(L, R, snr, D.vSys, {seed: noiseSeed});
  const seeds = CJ.components[ion] || [], regions = (CJ.aod[ion] || [])[1] || [];
  const req = {id: RAY, ion, R, snr, seed: noiseSeed, paramsTag: "story",
    atom: {lam0_A: A.lam0_A, f: A.f, gamma_s: A.gamma_s, b_min: A.fit?.b_min, logN_max: A.fit?.logN_max},
    line: {u0: L.u0, du: L.du, n: L.n, flux: L.flux}, vSys: D.vSys,
    data: {v: dd.v, flux: dd.flux, sigma: dd.sigma}, seeds, compKeys, regions, params: NOCAP};
  const r = fitPanel(req);
  const keys = r.compKeys || compKeys;
  const comps = (r.comps || []).map(row => Array.isArray(row) ? row.map(r4) : keys.map(k => r4(row[k])));
  return {case: c.name, ion, R, snr, seed: noiseSeed, seedParam: c.seed, ci, status: r.status, chi2: r4(r.chi2), dof: r.dof,
    npix: r.npix, keys, comps, total_logN: totalLogN(comps), windows: (r.windows || []).map(w => Array.isArray(w) ? w.map(r4) : w),
    degrade: {npix: dd.v.length, v0: r4(dd.v[0]), dv: r4(dd.v[1] - dd.v[0]), sigma: r4(dd.sigma), sum_flux: +sum(dd.flux).toFixed(6),
      sum_model: +sum(dd.model).toFixed(6)},
    handoff: {id: RAY, ions: [ion], layout: c.layout, R: {[A.band]: c.R.slice()}, sn: c.sn.slice(), seed: c.seed, fit: true, intr: false}};
}

const fits = [];
for (const c of CASES) for (const ion of IONS) {
  if (c.name.startsWith("s11a") && ion !== "OVI") continue;
  if (!D.lines[ion]) { console.log(`no ${ion} line in ${RAY}.bin: skipped`); continue; }
  for (const ci of c.ci) { const f = runFit(ion, c, ci); fits.push(f); console.log(c.name, ion, f.R, f.snr, f.seed, f.status, f.comps.length, f.total_logN); }
}
const find = (name, ion, ci = 0) => fits.findIndex(f => f.case === name && f.ion === ion && f.ci === ci);
const iB = compKeys.indexOf("b"), iV = compKeys.indexOf("v"), iN = compKeys.indexOf("logN");
// S11c "invented" cloud: the first O VI fit (cases in order) with a component narrower than b(T_INVENTED)
const bInv = Math.sqrt(2 * KB * T_INVENTED / (MASS.O * AMU)) / 1e5;
let invented = null;
fits.forEach((f, k) => { if (invented || f.ion !== "OVI") return; const j = f.comps.findIndex(c => c[iB] < bInv);
  if (j >= 0) { const b = f.comps[j][iB]; invented = {fit: k, comp: j, b, v: f.comps[j][iV], T_implied: Math.round(MASS.O * AMU * (b * 1e5) ** 2 / (2 * KB)),
    total_logN: f.total_logN, rule: `first O VI fit (case order) with a component b < b_O(${T_INVENTED} K) = ${bInv.toFixed(2)} km/s`}; } });
// S11c broad cloud: the widest O VI single-component fit
let broad = null;
fits.forEach((f, k) => { if (f.ion === "OVI" && f.comps.length === 1 && (!broad || f.comps[0][iB] > broad.b)) broad = {fit: k, b: f.comps[0][iB], R: f.R, snr: f.snr,
  rule: "widest single-component O VI fit"}; });
const s11 = [find("default", "OVI"), find("s11a_seed1", "OVI"), find("s11a_seed2", "OVI")];
const f0 = fits[s11[0]];
const NA = "–", fx = (x, d) => Number.isFinite(x) ? x.toFixed(d) : NA;
const facts = {
  s11_R: String(f0.R), s11_sn: String(f0.snr), s11_ncomp: String(f0.comps.length), s11_total_logN: fx(f0.total_logN, 2),
  s11_v: f0.comps.map(c => Math.round(c[iV])).map(x => (x > 0 ? "+" : "") + x).join(", "),
  s11_b: f0.comps.map(c => Math.round(c[iB])).join(", "), s11_noise_seed: String(f0.seed),
  broad_b: NA, broad_R: NA, broad_sn: NA, invented_b: NA, invented_T: NA, invented_R: NA, invented_sn: NA, invented_total_logN: NA,
};
if (!f0.comps.length) { facts.s11_v = NA; facts.s11_b = NA; }
if (broad) Object.assign(facts, {broad_b: String(Math.round(broad.b)), broad_R: String(broad.R), broad_sn: String(broad.snr)});
if (invented) { const f = fits[invented.fit]; Object.assign(facts, {invented_b: invented.b.toFixed(1), invented_T: String(Math.round(invented.T_implied / 100) * 100),
  invented_R: String(f.R), invented_sn: String(f.snr), invented_total_logN: fx(invented.total_logN, 2)}); }
// the names steps.json (U4) uses for the same quantities
Object.assign(facts, {fit_logN: facts.s11_total_logN, fit_seed: facts.s11_noise_seed, inv_b: facts.invented_b, inv_T: facts.invented_T,
  inv_logN: facts.invented_total_logN});
// --noise (empty case, DESIGN_tierA §4.4 item 6): the lowest page seed S in 0..999 whose noise shows exactly one 2-3 sigma
// excursion (and none >= 3 sigma) over the exported ions inside the panel window, where the noiseless model has no gas,
// at least 50 km/s inside the window edges (so the viewer sees the whole fake dip).
// The draw is the page's own: degradeV(full line, R 15 000, S/N 10, seedFor(S, ion, 0)) as plot.js does. Excursion
// significance = the matched filter of an unresolved line on the per-pixel noise: S(v) = sum w (1 - F) / (sigma sqrt(sum w^2)),
// w = the Gaussian LSF sampled on the pixels; excursions are local maxima of S at least one FWHM apart.
function noiseSearch(ions, R = 15000, snr = 10, vwin = [-300, 300]) {
  const fwhm = 299792.458 / R, sig = fwhm / 2.3548;
  const excursions = S => {
    const out = [];
    for (const ion of ions) {
      const L = D.lines[ion]; if (!L) continue;
      const d = degradeV(L, R, snr, D.vSys, {seed: seedFor(S, ion, 0)}), v = d.v, n = v.length, dv = v[1] - v[0];
      const h = Math.ceil(3 * sig / dv), w = []; for (let k = -h; k <= h; k++) w.push(Math.exp(-0.5 * (k * dv / sig) ** 2));
      const w2 = Math.sqrt(w.reduce((a, b) => a + b * b, 0));
      const Sv = new Float64Array(n).fill(-Infinity);
      for (let i = h; i < n - h; i++) { if (v[i] < vwin[0] || v[i] > vwin[1]) continue; let a = 0; for (let k = -h; k <= h; k++) a += w[k + h] * (1 - d.flux[i + k]); Sv[i] = a / (d.sigma * w2); }
      const mh = Math.max(1, Math.round(fwhm / dv));
      for (let i = 0; i < n; i++) {
        if (!(Sv[i] >= 2)) continue;
        let top = true; for (let k = Math.max(0, i - mh); k <= Math.min(n - 1, i + mh); k++) if (Sv[k] > Sv[i]) { top = false; break; }
        if (top) out.push({ion, V: +v[i].toFixed(1), sigma: +Sv[i].toFixed(3), model_depth: +(1 - d.model[i]).toFixed(5)});
      }
    }
    return out;
  };
  for (let S = 0; S <= 999; S++) {
    const ex = excursions(S);
    if (ex.length === 1 && ex[0].sigma < 3 && ex[0].model_depth < 0.01 && ex[0].V >= vwin[0] + 50 && ex[0].V <= vwin[1] - 50)
      return {seed: S, excursion_sigma: ex[0].sigma, ion: ex[0].ion, V: ex[0].V, R, sn: snr, vwin, panel_seed: seedFor(S, ex[0].ion, 0),
        rule: "lowest page seed S in 0..999 with exactly one 2-3 sigma matched-filter excursion (none >= 3) over the exported ions in vwin, noiseless depth < 0.01 there and >= 50 km/s inside the window edges; panel noise seed = seedFor(S, ion, 0) on the full line (plot.js)"};
  }
  return null;
}
const noise = NOISE ? noiseSearch(IONS) : undefined;
if (NOISE) console.log("noise seed:", JSON.stringify(noise));
const out = {schema: "story-fits/1", galaxy: GAL, ray: RAY, fit_version: FIT_VERSION, params: NOCAP, vSys: D.vSys,
  note: "fit.js degradeV + fitPanel with the explorer's request; capMs/budgetMs lifted for determinism",
  seed_rule: "seedParam = the explorer's page seed S; seed = the panel noise seed seedFor(S, ion, ci) (state.js casesFor order); S11a cycles S = 0, 1, 2 at R 30000, S/N 10",
  keys: compKeys, cases: fits, select: {s11a: s11, s11c_broad: broad, s11c_invented: invented}, facts};
if (NOISE) out.noise = noise;
mkdirSync(OUT, {recursive: true});
const txt = JSON.stringify(out), path = join(OUT, `page_fits_${GAL}_${RAY}.json`);
writeFileSync(path, txt);
console.log(`${path}: ${(txt.length / 1024).toFixed(1)} kB, gz ${(gzipSync(txt).length / 1024).toFixed(1)} kB`);
// the facts are {{key}} values too: export_story_data.py build merges them into the story file's own keys, so run
// build again after this script (scripts/story_data.sbatch does).
