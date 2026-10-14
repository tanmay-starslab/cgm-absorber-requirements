// JS/Python parity of the component search (design-2 §6.2): docs/tng50/js/search.js vs tngsight/search.py.
// Usage: node tests/js/search_parity.mjs [reference.json]
//   Reference lookup order: the argument, tests/search_golden.json, tests/data/search_golden.json, else
//   `$PYTHON -m tngsight.search --reference <tmp>` (U_fit's CLI). With none available the test SKIPS (exit 0, says so).
//   Accepted reference shapes: {cases:[{query|q, results|output|expected}], entries?, components?, fixture?};
//   entries/components default to tests/data/search_fixture.json ({entries, components}).
import {readFileSync, existsSync} from "node:fs";
import {execFileSync} from "node:child_process";
import {tmpdir} from "node:os";
import {join, dirname, isAbsolute} from "node:path";
import {fileURLToPath} from "node:url";
import {runQuery, rankAll, QUERY_SCHEMA} from "../../docs/tng50/js/search.js";

const HERE = dirname(fileURLToPath(import.meta.url)), ROOT = join(HERE, "..", "..");
let fails = 0; const check = (ok, msg) => { console.log(`${ok ? "ok  " : "FAIL"} ${msg}`); if (!ok) fails++; };
let ref = process.argv[2];
for (const p of [join(ROOT, "tests", "search_golden.json"), join(ROOT, "tests", "data", "search_golden.json")]) if (!ref && existsSync(p)) ref = p;
if (!ref && existsSync(join(ROOT, "tngsight", "search.py"))) {
  ref = join(tmpdir(), "tngsight_search_ref.json");
  try { execFileSync(process.env.PYTHON || "python", ["-m", "tngsight.search", "--reference", ref], {cwd: ROOT, stdio: "inherit"}); }
  catch (x) { console.log("FAIL could not run python -m tngsight.search --reference: " + x.message); process.exit(1); }
}
if (!ref) { console.log("SKIP no search reference yet (tests/search_golden.json or tngsight/search.py); parity not tested"); process.exit(0); }
const R = JSON.parse(readFileSync(ref, "utf8"));
let entries = R.entries, components = R.components;
if (!entries || !components) {
  let fx = R.fixture ? (isAbsolute(R.fixture) ? R.fixture : join(ROOT, R.fixture)) : join(ROOT, "tests", "data", "search_fixture.json");
  if (!existsSync(fx) && R.fixture) fx = join(dirname(ref), R.fixture);
  const F = typeof R.fixture === "object" ? R.fixture : JSON.parse(readFileSync(fx, "utf8"));
  entries = F.entries; components = F.components;
}
if (!Array.isArray(entries) && entries) entries = Object.values(entries);
const cases = Array.isArray(R) ? R : R.cases;
console.log(`reference ${ref}: ${cases.length} cases over ${entries.length} entries`);
if (R.query_schema) check(JSON.stringify(R.query_schema) === JSON.stringify(QUERY_SCHEMA), "QUERY_SCHEMA deep-equals tngsight.search.QUERY_SCHEMA");
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
for (const [ci, c] of cases.entries()) {
  const q = c.query ?? c.q, exp = c.results ?? c.output ?? c.expected ?? c.result, name = c.name ?? `case ${ci}`;
  const got = runQuery(q, entries, components, c.limit != null ? {limit: c.limit} : {});
  if (exp && !Array.isArray(exp) && (exp.error || c.error)) { check(!!got.error, `${name}: error expected (${exp.error || c.error}) → ${got.error}`); continue; }
  if (c.error) { check(!!got.error, `${name}: error expected (${c.error}) → ${got.error}`); continue; }
  if (got.error) { check(false, `${name}: JS error ${got.error}`); continue; }
  const ids = got.map(r => r.id), eids = exp.map(r => r.id);
  let ok = same(ids, eids), why = ok ? "" : `ids ${ids.slice(0, 6)} vs ${eids.slice(0, 6)}`;
  for (let i = 0; ok && i < got.length; i++) { const g = got[i], e = exp[i];
    if (g.n !== e.n) { ok = false; why = `${g.id} n ${g.n} vs ${e.n}`; }
    else if (e.pairs && !same(g.pairs, e.pairs)) { ok = false; why = `${g.id} pairs ${JSON.stringify(g.pairs)} vs ${JSON.stringify(e.pairs)}`; }
    else if (g.reason !== e.reason) { ok = false; why = `${g.id} reason "${g.reason}" vs "${e.reason}"`; }
    else if (!(Math.abs(g.score - e.score) <= 1e-9)) { ok = false; why = `${g.id} score ${g.score} vs ${e.score}`; }
    else if (e.components && !same(g.components.map(x => x.idx), e.components.map(x => x.idx))) { ok = false; why = `${g.id} component idx differ`; } }
  check(ok, `${name}: ${got.length} results${why ? " — " + why : ""}`);
}
for (const c of cases) if (c.n_total != null) { const all = rankAll(c.query ?? c.q, entries, components);
  if (all.length !== c.n_total) check(false, `${c.name}: n_total ${all.length} vs ${c.n_total}`); }
check(cases.every(c => c.n_total == null || rankAll(c.query ?? c.q, entries, components).length === c.n_total), "n_total (matches before the limit) equal on all cases");
for (const c of R.invalid_cases || []) { const got = runQuery(c.query, entries, components);
  check(got.error === c.error, `invalid ${JSON.stringify(c.query)} → "${got.error}" (Python "${c.error}")`); }
// speed: one query over >= 700 entries (fixture replicated)
const big = [], comps = {}; for (let r = 0; big.length < 700; r++) for (const e of entries) { const id = `${e.id}~${r}`; big.push(Object.assign({}, e, {id})); comps[id] = components[e.id]; }
const q0 = (cases[0].query ?? cases[0].q); let t = performance.now(); for (let i = 0; i < 20; i++) rankAll(q0, big, comps); t = (performance.now() - t) / 20;
check(t <= 50, `speed: ${t.toFixed(2)} ms per query over ${big.length} entries (≤ 50 ms)`);
console.log(fails ? `\n${fails} check(s) FAILED` : "\nall checks passed");
process.exit(fails ? 1 : 0);
