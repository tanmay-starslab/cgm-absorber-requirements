// G18 repair coverage (DESIGN_tierA §1 G18, unit R7): the director with repair on (§6.2 step 8, full G3 sampler) over a
// stratified sample of the staged pool; reports how often G3, G19 and G20 pass after repair, and why they fail. A report,
// not a ship gate (target >= 95 %).
//   node tests/js/story_repair_cov.mjs                               self-test of sampler and report (run_all; < 1 s)
//   node tests/js/story_repair_cov.mjs --sample OUT.json --dirs D... [--per 40]
//        stratified sample: 40 per case label (case.id of each story-data/3 file), deterministic order (sha256 of
//        "<galaxy> <ray>"); a label with fewer stories gives all it has and the shortfall is filled with "generic"
//        stories (no case rule passes) re-planned declared as that case; what stays short is recorded in the sample
//   node tests/js/story_repair_cov.mjs --run SAMPLE.json [--shard i/n] [--out R.json] [--quick]
//   node tests/js/story_repair_cov.mjs --merge OUT.json R1.json R2.json ...
// Each story: scripts/story_director.mjs direct() with repair (passes 1-4, overrides off), then the director's own gate
// record: G3 (band sampler 1600 p + layout classes), G19 (disk), G20 (LOD floor); occlusion, clearance and the beats
// repair could not fix are reported beside them. Nothing is written into the repository.
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import {fileURLToPath, pathToFileURL} from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url)), REPO = path.resolve(HERE, "../..");
export const LABELS = ["clean_single", "multiphase", "damped", "empty", "hot_only"];
export const GATES = ["G3", "G19", "G20"];
const sha = s => crypto.createHash("sha256").update(s).digest("hex");

/* sample: items [{file, galaxy, ray, label, declared}] -> stratified list */
export function stratify(items, {per = 40} = {}) {
  const key = x => sha(`${x.galaxy} ${x.ray}`);
  const sorted = [...items].sort((a, b) => (key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0));
  const by = {}, fillBy = {}, used = new Set(), out = [], short = {};
  for (const x of sorted) {
    if (x.label === "generic") (fillBy[x.declared] = fillBy[x.declared] || []).push(x);
    else (by[x.label] = by[x.label] || []).push(x);
  }
  for (const L of LABELS) {
    let got = 0;
    for (const x of by[L] || []) { if (got >= per) break; const k = `${x.galaxy} ${x.ray}`; if (used.has(k)) continue; used.add(k); out.push({...x, stratum: L}); got++; }
    for (const x of fillBy[L] || []) { if (got >= per) break; const k = `${x.galaxy} ${x.ray}`; if (used.has(k)) continue; used.add(k); out.push({...x, stratum: L, fill: true}); got++; }
    if (got < per) short[L] = per - got;
  }
  return {per, n: out.length, shortfall: short, rule: `per case label: ${per} stories labelled so by the classifier (case.id), the shortfall filled with "generic" stories (no case rule passes) declared as that case; one ray at most once`,
    available: Object.fromEntries(LABELS.map(L => [L, {labelled: (by[L] || []).length, generic_declared: (fillBy[L] || []).length}])), items: out};
}
const mask = s => String(s).replace(/"[^"]*"/g, '"…"').replace(/\b[A-Z]\d+[a-z]?\b/g, "B#").replace(/-?\d+(\.\d+)?(e-?\d+)?/g, "#").slice(0, 120);
const msgOf = f => (typeof f === "string" ? f : f.msg || f.why || JSON.stringify(f));
export function summarise(results) {
  const ok = results.filter(x => !x.error);
  const pass = g => ok.filter(x => x.gates[g]).length;
  const all = ok.filter(x => GATES.every(g => x.gates[g])).length;
  const reasons = {};
  for (const x of ok) for (const g of GATES) if (!x.gates[g]) for (const m of new Set((x.fails[g] || []).map(f => `${g}: ${mask(msgOf(f))}`))) (reasons[m] = reasons[m] || []).push(`${x.galaxy} ${x.ray}`);
  const errors = {};
  for (const x of results.filter(r => r.error)) (errors[mask(x.error)] = errors[mask(x.error)] || []).push(`${x.galaxy} ${x.ray}`);
  const byStratum = {};
  for (const x of results) { const s = byStratum[x.stratum] = byStratum[x.stratum] || {n: 0, pass: 0}; s.n++; if (!x.error && GATES.every(g => x.gates[g])) s.pass++; }
  const ms = ok.map(x => x.ms).sort((a, b) => a - b);
  return {gate: "G18", schema: "story-repair-cov/1", n: results.length, directed: ok.length, all_three: all,
    rate: results.length ? all / results.length : null, target: 0.95,
    per_gate: Object.fromEntries(GATES.map(g => [g, {pass: pass(g), rate: ok.length ? pass(g) / ok.length : null}])),
    by_stratum: byStratum, unrepaired_beats: ok.filter(x => x.repair_failed.length).length,
    reasons: Object.entries(reasons).sort((a, b) => b[1].length - a[1].length).map(([cause, rays]) => ({cause, n: rays.length, examples: rays.slice(0, 4)})),
    errors: Object.entries(errors).map(([cause, rays]) => ({cause, n: rays.length, examples: rays.slice(0, 4)})),
    direct_s: ms.length ? {median: ms[ms.length >> 1] / 1000, max: ms[ms.length - 1] / 1000, total_h: ms.reduce((s, v) => s + v, 0) / 3.6e6} : null};
}

async function runOne(D, M, TP, it, quick) {
  const t0 = Date.now(), base = {file: it.file, galaxy: it.galaxy, ray: it.ray, label: it.label, stratum: it.stratum, declared: it.declared};
  const data = JSON.parse(fs.readFileSync(it.file, "utf8"));
  const id = Object.entries(TP.cases.stories).find(([, v]) => v.case === data.case.declared);
  if (!id) return {...base, error: `no story for declared ${data.case.declared}`};
  try {
    const r = await D.direct(id[0], M, TP, {data: it.file, quick});
    const g = r.report.gates;
    return {...base, story: id[0], ms: Date.now() - t0, gates: Object.fromEntries(Object.entries(g).map(([k, v]) => [k, !!v.pass])),
      fails: Object.fromEntries(["G3", "G19", "G20", "occlusion", "clearance"].map(k => [k, (g[k].fails || []).slice(0, 8)])),
      repair_failed: (r.report.repair && r.report.repair.failed) || [], repair_passes: ((r.report.repair && r.report.repair.passes) || []).length,
      repaired_beats: new Set(((r.report.repair && r.report.repair.log) || []).filter(x => x.kept !== "calibrated").map(x => x.beat)).size};
  } catch (e) { return {...base, ms: Date.now() - t0, error: e.message.split("\n")[0].slice(0, 300)}; }
}

function selfTest() {
  let ok = 0, bad = 0;
  const t = (c, m) => { if (c) { ok++; console.log(`ok ${m}`); } else { bad++; console.log(`FAIL ${m}`); } };
  const items = [];
  for (let i = 0; i < 300; i++) items.push({file: `f${i}`, galaxy: 1000 + (i % 7), ray: `r${i}`, label: ["damped", "multiphase", "generic"][i % 3], declared: i % 3 === 2 ? "clean_single" : "x"});
  for (let i = 0; i < 5; i++) items.push({file: `h${i}`, galaxy: 2000, ray: `h${i}`, label: "hot_only", declared: "hot_only"});
  for (let i = 0; i < 50; i++) items.push({file: `g${i}`, galaxy: 1000 + (i % 7), ray: `r${3 * i + 2}`, label: "generic", declared: "hot_only"});
  const s = stratify(items), s2 = stratify([...items].reverse());
  t(JSON.stringify(s) === JSON.stringify(s2), "sampler: deterministic, independent of input order");
  t(s.items.filter(x => x.stratum === "damped").length === 40 && new Set(s.items.map(x => `${x.galaxy} ${x.ray}`)).size === s.n, "sampler: 40 per label, one ray at most once");
  t(s.items.filter(x => x.stratum === "hot_only").length === 40 && s.items.filter(x => x.stratum === "hot_only" && !x.fill).length === 5
    && s.items.filter(x => x.stratum === "clean_single").length === 40 && s.shortfall.empty === 40, "sampler: a short label is filled with generic stories declared as it; what stays short is recorded");
  const res = [{galaxy: 1, ray: "a", stratum: "damped", ms: 10, gates: {G3: true, G19: true, G20: true}, fails: {}, repair_failed: []},
    {galaxy: 1, ray: "b", stratum: "damped", ms: 10, gates: {G3: false, G19: true, G20: true}, fails: {G3: [{msg: "B7d: text band hits beam at 0.412"}]}, repair_failed: ["B7d"]},
    {galaxy: 2, ray: "c", stratum: "empty", error: "director: unresolved roles: @S5"}];
  const S = summarise(res);
  t(S.all_three === 1 && Math.abs(S.rate - 1 / 3) < 1e-12 && S.per_gate.G3.pass === 1 && S.reasons[0].cause === "G3: B#: text band hits beam at #" && S.errors.length === 1,
    "report: rate over the whole sample (errors count as failures), reasons bucketed with numbers masked");
  console.log(`${bad ? "FAIL" : "ok"} story_repair_cov: ${ok} ok, ${bad} failed`);
  return bad ? 1 : 0;
}

function argList(a, flag) { const out = []; let on = false; for (const x of a) { if (x === flag) { on = true; continue; } if (x.startsWith("--")) on = false; else if (on) out.push(x); } return out; }
async function main() {
  const a = process.argv.slice(2), val = f => { const i = a.indexOf(f); return i >= 0 ? a[i + 1] : null; };
  if (!a.length) return selfTest();
  if (val("--sample")) {
    const items = [];
    for (const d of argList(a, "--dirs")) for (const sub of fs.readdirSync(d)) {
      const dir = path.join(d, sub); if (!fs.statSync(dir).isDirectory()) continue;
      for (const f of fs.readdirSync(dir).filter(n => /^story_\d+_.+\.json$/.test(n))) {
        try { const x = JSON.parse(fs.readFileSync(path.join(dir, f), "utf8")); if (x.plan && x.case) items.push({file: path.join(dir, f), galaxy: x.meta.galaxy, ray: x.meta.ray, label: x.case.id, declared: x.case.declared}); } catch { /* not /3 */ }
      }
    }
    const s = stratify(items, {per: Number(val("--per") || 40)});
    fs.writeFileSync(val("--sample"), JSON.stringify({...s, pool_n: items.length}, null, 1));
    console.log(JSON.stringify({pool_n: items.length, n: s.n, available: s.available, shortfall: s.shortfall}));
    return 0;
  }
  if (a[0] === "--merge") {
    const results = a.slice(2).flatMap(f => JSON.parse(fs.readFileSync(f, "utf8")).results);
    const S = summarise(results);
    fs.writeFileSync(a[1], JSON.stringify({...S, results}, null, 1));
    console.log(JSON.stringify({n: S.n, all_three: S.all_three, rate: S.rate, per_gate: S.per_gate, top: S.reasons.slice(0, 5).map(r => `${r.n}x ${r.cause}`)}));
    return 0;
  }
  if (val("--run")) {
    const D = await import(pathToFileURL(path.join(REPO, "scripts/story_director.mjs")).href);
    const M = await D.modules(), TP = D.templates(); TP.overrides = {overrides: []};
    let items = JSON.parse(fs.readFileSync(val("--run"), "utf8")).items;
    if (val("--shard")) { const [i, n] = val("--shard").split("/").map(Number); items = items.filter((_, k) => k % n === i); }
    const results = [];                    // resumes: stories already in --out are kept, not re-directed
    if (val("--out") && fs.existsSync(val("--out"))) results.push(...JSON.parse(fs.readFileSync(val("--out"), "utf8")).results);
    const done = new Set(results.map(r => r.file));
    for (const it of items) {
      if (done.has(it.file)) continue;
      const r = await runOne(D, M, TP, it, a.includes("--quick"));
      results.push(r);
      console.log(`${r.error ? "ERR" : GATES.every(g => r.gates[g]) ? "pass" : "fail"} ${it.stratum} ${it.galaxy} ${it.ray} ${r.error || GATES.map(g => `${g}:${r.gates[g] ? 1 : 0}`).join(" ")} ${((r.ms || 0) / 1000).toFixed(0)} s`);
      if (val("--out")) fs.writeFileSync(val("--out"), JSON.stringify({...summarise(results), results}, null, 1));
    }
    return 0;
  }
  console.log("usage: see header"); return 2;
}
const isMain = process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
if (isMain) process.exitCode = await main();
