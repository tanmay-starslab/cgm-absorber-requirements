// Hand-computed cases for docs/tng50/js/search.js (independent of the Python reference): node tests/js/search_unit.mjs
import {validateQuery, runQuery, rankAll, fmt} from "../../docs/tng50/js/search.js";
let fails = 0; const check = (ok, msg) => { console.log(`${ok ? "ok  " : "FAIL"} ${msg}`); if (!ok) fails++; };
const c = (v, logN, b, flag = 0) => ({v, dv: 0.1, logN, dlogN: 0.01, b, db: 0.2, region: 0, flag, EW: 10});
const entries = [
  {id: "edge_b100_a090", orientation: "edge-on", b_kpc: 100},
  {id: "face_b050_a000", orientation: "face-on", b_kpc: 50},
  {id: "rand_b075_a000_s12345", orientation: "random", b_kpc: 75.4},
  {id: "cust_0123456789", orientation: "custom", b_kpc: 12.6},
  {id: "edge_b200_a000", orientation: "edge-on", b_kpc: 200}];   // no components -> never matched
const comps = {
  edge_b100_a090: {OVI: [c(-40, 13.9, 23.4), c(25, 13.2, 31), c(80, 14.6, 12, 1)], HILyb: [], CIII: []},
  face_b050_a000: {OVI: [c(0, 14.0, 20)], HILyb: [c(10, 15, 30)], CIII: []},
  rand_b075_a000_s12345: {OVI: [c(-100, 12.5, 40), c(-49.5, 13.0, 9.6)], HILyb: [], CIII: []},
  cust_0123456789: {OVI: [], HILyb: [], CIII: []}};
check(fmt(2.5, 0) === "3" && fmt(-2.5, 0) === "-3" && fmt(0.05, 1) === "0.1" && fmt(-0.04, 0) === "0" && fmt(13.95, 1) === "14.0", "fmt rounds half away from zero, never -0");
check(validateQuery({}).error === "ion: required", "ion required");
check(/unknown field/.test(validateQuery({ion: "OVI", foo: 1}).error), "additionalProperties false");
check(/integer/.test(validateQuery({ion: "OVI", n_min: 1.5}).error), "n_min integer");
check(/n_max/.test(validateQuery({ion: "OVI", n_min: 3, n_max: 2}).error), "n_min <= n_max");
check(/sep_kms/.test(validateQuery({ion: "OVI", sep_kms: [50, 10]}).error), "sep lo <= hi");
check(/2 items/.test(validateQuery({ion: "OVI", b_kpc: [1]}).error), "pair length");
check(/one of/.test(validateQuery({ion: "OVI", orientation: "edge"}).error), "orientation enum");
let r = runQuery({ion: "OVI"}, entries, comps);
check(r.map(x => x.id).join() === "edge_b100_a090,rand_b075_a000_s12345,face_b050_a000", "default sort by score: " + r.map(x => x.id + ":" + x.score).join(" "));
// edge: 3 comps (the SAT one, flag 1, is a lower limit at its fitted 14.6): (1+1.9/4)+(1+1.2/4)+(1+2.6/4) - 0.5 = 1.475+1.3+1.65-0.5 = 3.925
check(Math.abs(r[0].score - 3.925) < 1e-12 && r[0].reason === "3 O VI components, logN 13.2–14.6 (1 lower limit), b 12–31 km/s, 100 kpc", `edge score/reason: ${r[0].score} "${r[0].reason}"`);
check(r[1].reason === "2 O VI components, logN 12.5–13.0, b 10–40 km/s, 75 kpc", `rand reason (b 9.6 -> 10, 75.4 kpc -> 75): "${r[1].reason}"`);
r = runQuery({ion: "OVI", sep_kms: [50, 70]}, entries, comps);
// edge pairs: |-40-25|=65 ok, |25-80|=55 ok, |-40-80|=120 no; rand: 50.5 ok
check(r.length === 2 && r[0].id === "edge_b100_a090" && JSON.stringify(r[0].pairs) === "[[1,2,55],[0,1,65]]", "sep pairs sorted by dv: " + JSON.stringify(r[0]?.pairs));
check(Math.abs(r[0].score - (3.925 + 0.5)) < 1e-12 && r[0].reason === "3 O VI components, logN 13.2–14.6 (1 lower limit), b 12–31 km/s, Δv 55 km/s, 100 kpc", `sep score/reason ${r[0].score} "${r[0].reason}"`);
check(r[1].reason === "2 O VI components, logN 12.5–13.0, b 10–40 km/s, Δv 51 km/s, 75 kpc", `Δv 50.5 -> 51: "${r[1].reason}"`);
r = runQuery({ion: "OVI", n_min: 0, n_max: 0}, entries, comps);
check(r.length === 1 && r[0].id === "cust_0123456789" && r[0].reason === "0 O VI components, 13 kpc", "empty list counts as existing with n_min 0: " + JSON.stringify(r.map(x => x.reason)));
r = runQuery({ion: "OVI", logN_min: 13.5, b_max: 25}, entries, comps);
check(r.map(x => x.id).join() === "edge_b100_a090,face_b050_a000" && r[0].n === 2 && Math.abs(r[0].score - 2.625) < 1e-12, "logN/b filters inclusive: " + r.map(x => x.id + ":" + x.n + ":" + x.score).join(" "));
r = runQuery({ion: "OVI", sort: "b_kpc", b_kpc: [50, 100]}, entries, comps);
check(r.map(x => x.id).join() === "face_b050_a000,rand_b075_a000_s12345,edge_b100_a090", "b_kpc range inclusive + sort b_kpc");
r = runQuery({ion: "OVI", sort: "n", orientation: "edge-on"}, entries, comps);
check(r.length === 1 && r[0].components.map(x => x.idx).join() === "0,1,2", "orientation filter, components by v with idx");
r = runQuery({ion: "OVI", limit: 1}, entries, comps);
check(r.length === 1, "limit truncates");
check(rankAll({ion: "CIII"}, entries, comps).length === 0, "CIII: all empty -> none with default n_min 1");
// C2, owner decision 2: NOERR, or SAT without DAMPED, components are lower limits at min(logN, logN_lo)
{ const L = (v, logN, flag, lo) => Object.assign(c(v, logN, 20, flag), lo == null ? {} : {logN_lo: lo}, flag & 32 ? {dlogN: null, db: null} : {});
  const es = [{id: "edge_b010_a000", orientation: "edge-on", b_kpc: 10}];
  const cs = {edge_b010_a000: {HI: [L(-60, 17.91, 33, 15.1), L(10, 20.3, 65), L(80, 14.2, 0)], OVI: [L(0, 16.0, 1, 14.4)]}};
  let q = runQuery({ion: "HI", logN_min: 15}, es, cs);
  check(q.length === 1 && q[0].n === 2 && q[0].reason === "2 H I components, logN 15.1–20.3 (1 lower limit), b 20–20 km/s, 10 kpc",
    "a limit meets logN_min by its lower limit 15.1; the damped H I (SAT|DAMPED) is a value: " + q[0]?.reason);
  // score: limit 1 + 3.1/4 = 1.775, damped 1 + 4/4 = 2, minus 0.5 per SAT flag (both carry flag 1) = 2.775
  check(Math.abs(q[0].score - 2.775) < 1e-12, `score uses the lower limit, not the fitted 17.91: ${q[0].score}`);
  q = runQuery({ion: "HI", logN_min: 15.5}, es, cs);
  check(q.length === 1 && q[0].n === 1 && q[0].components[0].v === 10, "a 17.91 SAT|NOERR fit with logN_lo 15.1 does not meet logN_min 15.5");
  q = runQuery({ion: "HI", logN_min: 14, logN_max: 21}, es, cs);
  check(q.length === 1 && q[0].n === 2 && q[0].components.every(x => x.v !== -60), "a lower limit never meets a logN_max below the ion ceiling");
  q = runQuery({ion: "HI", logN_min: 14, logN_max: 22.5}, es, cs);
  check(q.length === 1 && q[0].n === 3, "logN_max at the H I ceiling (22.5) is unbounded and keeps the limit");
  q = runQuery({ion: "OVI", logN_max: 19}, es, cs);
  check(q.length === 1 && q[0].reason === "1 O VI component, logN 14.4–14.4 (1 lower limit), b 20–20 km/s, 10 kpc", "O VI logN_max at its ceiling 19 keeps the limit, shown at 14.4: " + q[0]?.reason);
  check(runQuery({ion: "OVI", logN_max: 18}, es, cs).length === 0, "O VI logN_max 18 drops the lower limit");
}
// state.js annotateLimits against tngsight.search.annotate_limits (the golden annotate_cases)
{ const St = await import("../../docs/tng50/js/state.js"), fs = await import("node:fs"), url = await import("node:url");
  const G = JSON.parse(fs.readFileSync(url.fileURLToPath(new URL("../search_golden.json", import.meta.url)), "utf8"));
  check(Array.isArray(G.annotate_cases) && G.annotate_cases.length >= 5, "golden carries annotate_cases");
  for (const k of G.annotate_cases || []) {
    const got = St.annotateLimits(k.components, k.aod), exp = k.expected;
    const same = JSON.stringify(Object.keys(got)) === JSON.stringify(Object.keys(exp)) && Object.keys(exp).every(ion => exp[ion].length === got[ion].length &&
      exp[ion].every((e, i) => ("logN_lo" in e) === ("logN_lo" in got[ion][i]) && (!("logN_lo" in e) || Math.abs(e.logN_lo - got[ion][i].logN_lo) < 1e-9)));
    check(same, `annotateLimits ${k.name}: ${JSON.stringify(got)}`);
  }
  // the share rule never lets a region's limits claim more than its exact column
  const two = St.annotateLimits({MgII: [{v: 0, logN: 15, region: 0, flag: 1}, {v: 9, logN: 15, region: 0, flag: 33}]}, {MgII: [14.0, [[0, -20, 20, 14.0]]]}).MgII;
  check(Math.abs(Math.log10(10 ** two[0].logN_lo + 10 ** two[1].logN_lo) - 14.0) < 2e-3, `two equal limits split the region AOD: ${two.map(x => x.logN_lo)}`);
}
console.log(fails ? `\n${fails} check(s) FAILED` : "\nall checks passed");
process.exit(fails ? 1 : 0);
