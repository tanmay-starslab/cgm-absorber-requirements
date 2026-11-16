// G17 engine validity fuzz (DESIGN_tierA §1 G17, unit R7): plan -> compose -> direct (repair off) on story-data/3 files.
//   node tests/js/story_engine_fuzz.mjs                      self-test (seeded defects must fail) + the shipped picks in
//                                                            ROOT/data/v3 as the hard set (run_all; about 30 s)
//   node tests/js/story_engine_fuzz.mjs --hard F... [--pool F...] [--dirs D...] [--shard i/n] [--out R.json]
//        --hard     files that must pass 100 % (picks, alternates, hero rays); exit 1 when one fails
//        --pool     files reported as a pass rate (target >= 99 %), failures bucketed by cause, never ray by ray
//        --dirs     every story_*.json in D and D/*/ joins the pool
//        --shard    i/n: this process takes every n-th pool file starting at i (SLURM array; merge with --merge)
//   node tests/js/story_engine_fuzz.mjs --merge OUT.json R1.json R2.json ...   one report from the shard reports
//   node tests/js/story_engine_fuzz.mjs --one F               prints the output hash of F (fresh-process determinism)
// The plan step is R1's planner (scripts/story_plan.py through export_story_data.py build --case); this script takes
// its story-data/3 output. Compose and direct are scripts/story_director.mjs direct() with noRepair (§6.2 step 8 off)
// and the quick sampler. Checks per story (G17 "hard" list):
//   throw     direct() returns (an unknown or position-less @role throws there, §6.2 step 9)
//   schema    the input is valid story-data/3 (tests/schemas); timeline.validate against beats.schema.json passes; every
//             beat's shot exists
//   plan      plan/1 slots ordered, cover [-half, +half] exactly, no holes or overlaps, off slots have zero length
//   beats     beats contiguous over p in [0, 1]; l-windows contiguous from lStart to +half
//   roles     every @role in beats and shots resolves to a position (repair.auditRoles)
//   copy      no visible line renders a hole ({{key}}, undefined, NaN, [object, a lone dash); dropped lines are declared
//   finite    no NaN or infinite number anywhere in beats, shots or the film plan
//   rerun     a second direct() gives byte-identical beats, shots, film and report (hard files: also in a fresh process)
// Nothing is written into the repository; --out goes wherever it is pointed.
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import {execFileSync} from "node:child_process";
import {fileURLToPath, pathToFileURL} from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url)), REPO = path.resolve(HERE, "../..");
const ROOT = path.join(REPO, "docs/tng50/learn/how-a-spectrum-is-made");
const D = await import(pathToFileURL(path.join(REPO, "scripts/story_director.mjs")).href);
const R = await import(pathToFileURL(path.join(REPO, "scripts/director/repair.mjs")).href);
const EN = await import(pathToFileURL(path.join(ROOT, "js/engine.js")).href);
const SD3 = JSON.parse(fs.readFileSync(path.join(REPO, "tests/schemas/story-data/3.schema.json"), "utf8"));
export const CHECKS = ["throw", "schema", "plan", "beats", "roles", "copy", "finite", "rerun"];
const EPS = 1.5e-3;                                  // plan l values are rounded to 3 decimals
const HOLE_BRACE = /\{\{\s*[^$}][^}]*\}\}/, HOLE = /undefined|NaN|\[object|(^|\s)–(\s|$)/;   // derive.js hasHole rule

let M = null, TP = null;
async function init() { if (!M) { M = await D.modules(); TP = D.templates(); TP.overrides = {overrides: []}; } }
/* story id of a story-data/3 file: the cases.json story whose case is the file's declared case */
export function storyIdOf(data) {
  const dec = data && data.case && data.case.declared;
  const hit = Object.entries(TP.cases.stories).find(([, v]) => v.case === dec);
  return hit ? hit[0] : null;
}
const canon = x => JSON.stringify(x, (k, v) => (typeof v === "number" && !Number.isFinite(v) ? `__nonfinite_${v}` : v));
export const outputHash = r => crypto.createHash("sha256").update(canon({beats: r.beatsDoc, shots: r.shotsDoc, film: r.film, report: r.report})).digest("hex");

/* ---------------------------------------------------------------- checks (pure: data + direct() result -> fails) */
export function checkPlan(data) {
  const f = [], p = data.plan || {}, half = p.half ?? (data.geometry && data.geometry.ray && data.geometry.ray.half);
  const slots = Object.entries(p.slots || {});
  if (!Number.isFinite(half) || half <= 0) return [`plan.half ${half}`];
  if (!slots.length) return ["plan.slots empty"];
  let cur = -half;
  for (const [k, s] of slots) {
    if (!Number.isFinite(s.l0) || !Number.isFinite(s.l1)) { f.push(`slot ${k}: l0/l1 not finite`); continue; }
    if (Math.abs(s.l0 - cur) > EPS) f.push(`slot ${k}: starts at ${s.l0}, previous ends at ${cur} (${s.l0 > cur ? "hole" : "overlap"})`);
    if (s.l1 < s.l0 - EPS) f.push(`slot ${k}: l1 ${s.l1} < l0 ${s.l0}`);
    if (s.on === false && Math.abs(s.l1 - s.l0) > EPS) f.push(`slot ${k}: off but ${(s.l1 - s.l0).toFixed(3)} kpc long`);
    cur = s.l1;
  }
  if (Math.abs(cur - half) > EPS) f.push(`slots end at ${cur}, not +half ${half}`);
  return f;
}
export function checkBeats(beatsDoc, S) {
  const f = [], b = (beatsDoc && beatsDoc.beats) || [];
  if (!b.length) return ["no beats"];
  if (b[0].p0 !== 0) f.push(`first beat starts at p ${b[0].p0}`);
  if (b[b.length - 1].p1 !== 1) f.push(`last beat ends at p ${b[b.length - 1].p1}`);
  for (let i = 1; i < b.length; i++) {
    if (Math.abs(b[i].p0 - b[i - 1].p1) > 1e-12) f.push(`${b[i].id}: p0 ${b[i].p0} != previous p1 ${b[i - 1].p1}`);
    if (!(b[i].p1 > b[i].p0)) f.push(`${b[i].id}: empty p range`);
  }
  let cur = b[0].l0;
  if (Math.abs(cur - S.lStart) > EPS) f.push(`l starts at ${cur}, not lStart ${S.lStart}`);
  for (const x of b) {
    if (!Number.isFinite(x.l0)) { f.push(`${x.id}: l0 not finite`); continue; }
    if (Math.abs(x.l0 - cur) > EPS) f.push(`${x.id}: l0 ${x.l0} != ${cur}`);
    if (x.kind === "flight") { if (!(x.l1 >= x.l0 - EPS)) f.push(`${x.id}: flight runs backwards`); cur = x.l1; }
  }
  if (Math.abs(cur - S.half) > EPS) f.push(`l ends at ${cur}, not +half ${S.half}`);
  return f;
}
export function checkSchema(r) {
  const f = [];
  if (!r.report.gates.schema.pass) f.push(...r.report.gates.schema.fails.slice(0, 5).map(x => `schema: ${typeof x === "string" ? x : JSON.stringify(x)}`));
  for (const b of r.beatsDoc.beats) if (!r.shotsDoc.shots[b.shot]) f.push(`${b.id}: shot ${b.shot} missing`);
  return f;
}
export function holesIn(lines) {
  const f = [];
  for (const ln of lines) for (const k of ["display", "display_short", "sub", "sub_short"]) {
    const s = ln.text && ln.text[k];
    if (typeof s === "string" && (HOLE_BRACE.test(s) || HOLE.test(s))) f.push(`${ln.beat}/${ln.id}.${k}: "${s.slice(0, 80)}"`);
  }
  return f;
}
export function checkCopy(r) {
  const S = r.S, drops = [];
  const lines = M.D.activeLines(S.copy, r.beatsDoc, {flags: S.copyFlags, caseId: S.caseId, lookup: S.lookup, onDrop: x => drops.push(x)});
  return {fails: holesIn(lines), lines: lines.length, drops};
}
export function nonFinite(x, where = "", out = []) {
  if (typeof x === "number") { if (!Number.isFinite(x)) out.push(where); }
  else if (Array.isArray(x)) x.forEach((v, i) => nonFinite(v, `${where}[${i}]`, out));
  else if (x && typeof x === "object") for (const k of Object.keys(x)) nonFinite(x[k], where ? `${where}.${k}` : k, out);
  return out;
}
export function checkRoles(r) {
  try { const a = R.auditRoles(r.E); return {fails: [], okFalse: a.filter(x => x.kind === "okFalse").length}; }
  catch (e) { return {fails: [e.message.slice(0, 300)], okFalse: 0}; }
}

/* one file: all checks; rerun: "proc" also hashes it in a fresh node process */
export async function fuzzOne(file, {rerun = "mem"} = {}) {
  await init();
  const out = {file, fails: [], notes: {}};
  let data;
  try { data = JSON.parse(fs.readFileSync(file, "utf8")); } catch (e) { out.fails.push({check: "throw", msg: `read: ${e.message}`}); return out; }
  Object.assign(out, {galaxy: data.meta && data.meta.galaxy, ray: data.meta && data.meta.ray, declared: data.case && data.case.declared,
    label: data.case && data.case.id, verdict: !!(data.case && data.case.verdict && data.case.verdict.ok)});
  const add = (check, msgs) => { for (const m of [].concat(msgs)) out.fails.push({check, msg: String(m)}); };
  if (!data.plan) {                        // the plan step failed: a re-plan job leaves its record in done.json beside the file
    const dj = path.join(path.dirname(file), "done.json");
    let why = "no plan (not story-data/3)";
    try { const r = JSON.parse(fs.readFileSync(dj, "utf8")).res || {}; const e = Object.values(r).find(v => v && v.ok === false); if (e) why = `planner: ${e.error.replace(/: \{.*$/, "").replace(/^(\w+: )\d+ \S+ /, "$1")}`; } catch { /* no record */ }
    add("plan", why); return out;
  }
  add("schema", EN.schemaErrors(SD3, data).slice(0, 5).map(e => `story-data/3: ${typeof e === "string" ? e : JSON.stringify(e)}`));
  const id = storyIdOf(data);
  if (!id) { add("throw", `no story for declared case ${out.declared}`); return out; }
  out.story = id;
  add("plan", checkPlan(data));
  const t0 = Date.now();
  let r;
  try { r = await D.direct(id, M, TP, {data: file, noRepair: true, quick: true}); }
  catch (e) { add("throw", e.message.split("\n")[0].slice(0, 300)); out.ms = Date.now() - t0; return out; }
  out.ms = Date.now() - t0;
  add("schema", checkSchema(r));
  add("beats", checkBeats(r.beatsDoc, r.S));
  const ro = checkRoles(r); add("roles", ro.fails); out.notes.eq_dropped_okFalse = ro.okFalse;
  const cp = checkCopy(r); add("copy", cp.fails); out.notes.lines = cp.lines; out.notes.dropped_lines = cp.drops.length;
  out.notes.template_lines_without_copy = Object.values(r.report.read || {}).reduce((s, v) => s + ((v.missing || []).length), 0);
  add("finite", nonFinite({beats: r.beatsDoc, shots: r.shotsDoc, film: r.film}).slice(0, 5).map(w => `non-finite at ${w}`));
  out.sha = outputHash(r);
  out.gates_norepair = Object.fromEntries(Object.entries(r.report.gates).map(([k, v]) => [k, !!v.pass]));
  out.beats = r.beatsDoc.beats.length;
  let r2;
  try { r2 = await D.direct(id, M, TP, {data: file, noRepair: true, quick: true}); } catch (e) { add("rerun", `second run threw: ${e.message.slice(0, 200)}`); }
  if (r2 && outputHash(r2) !== out.sha) add("rerun", "second in-process run differs");
  if (rerun === "proc") {
    try {
      const sha = execFileSync(process.execPath, [fileURLToPath(import.meta.url), "--one", file], {encoding: "utf8", stdio: ["ignore", "pipe", "pipe"]}).trim().split("\n").pop();
      if (sha !== out.sha) add("rerun", `fresh process gives ${sha.slice(0, 12)}, this one ${out.sha.slice(0, 12)}`);
    } catch (e) { add("rerun", `fresh process failed: ${String(e.stderr || e.message).slice(0, 200)}`); }
  }
  return out;
}

/* a failure's bucket: first failing check + its message with numbers, ids and quoted text masked */
export const bucketOf = res => {
  if (!res.fails.length) return null;
  const f = res.fails[0];
  return `${f.check}: ${f.msg.replace(/"[^"]*"/g, '"…"').replace(/\b[A-Z]\d+[a-z]?\b/g, "B#").replace(/-?\d+(\.\d+)?(e-?\d+)?/g, "#").slice(0, 140)}`;
};
export function summarise(results, hardSet) {
  const hard = results.filter(x => hardSet.has(x.file)), pool = results.filter(x => !hardSet.has(x.file));
  const buckets = {};
  for (const x of pool) { const b = bucketOf(x); if (b) (buckets[b] = buckets[b] || []).push(`${x.galaxy} ${x.ray}`); }
  const byCheck = Object.fromEntries(CHECKS.map(c => [c, pool.filter(x => x.fails.some(f => f.check === c)).length]));
  const ms = results.map(x => x.ms).filter(Number.isFinite).sort((a, b) => a - b);
  const byLabel = {};
  for (const x of pool) { const k = x.label || "?"; byLabel[k] = byLabel[k] || {n: 0, pass: 0}; byLabel[k].n++; if (!x.fails.length) byLabel[k].pass++; }
  return {
    gate: "G17", schema: "story-engine-fuzz/1",
    hard: {n: hard.length, pass: hard.filter(x => !x.fails.length).length, failed: hard.filter(x => x.fails.length).map(x => ({file: x.file, fails: x.fails.slice(0, 5)}))},
    pool: {n: pool.length, pass: pool.filter(x => !x.fails.length).length, rate: pool.length ? pool.filter(x => !x.fails.length).length / pool.length : null, target: 0.99,
      by_check: byCheck, by_label: byLabel,
      buckets: Object.entries(buckets).sort((a, b) => b[1].length - a[1].length).map(([cause, rays]) => ({cause, n: rays.length, examples: rays.slice(0, 5)}))},
    direct_ms: ms.length ? {median: ms[ms.length >> 1], p95: ms[Math.floor(ms.length * 0.95)], max: ms[ms.length - 1]} : null,
  };
}

/* ---------------------------------------------------------------- self-test: seeded defects must fail their check */
async function selfTest(file) {
  await init();
  let ok = 0, bad = 0;
  const t = (c, m) => { if (c) { ok++; console.log(`ok ${m}`); } else { bad++; console.log(`FAIL ${m}`); } };
  const data = JSON.parse(fs.readFileSync(file, "utf8")), id = storyIdOf(data);
  const r = await D.direct(id, M, TP, {data: file, noRepair: true, quick: true});
  t(EN.schemaErrors(SD3, data).length === 0 && checkPlan(data).length === 0 && checkBeats(r.beatsDoc, r.S).length === 0 && checkSchema(r).length === 0 && checkCopy(r).fails.length === 0
    && checkRoles(r).fails.length === 0, `self-test baseline ${id}: clean story passes every check`);
  const keys = Object.keys(data.plan.slots), on = keys.find(k => data.plan.slots[k].on && data.plan.slots[k].l1 - data.plan.slots[k].l0 > 1);
  const d1 = structuredClone(data); d1.plan.slots[on].l1 -= 0.5;
  t(checkPlan(d1).some(m => /hole/.test(m)), "seeded defect: a 0.5 kpc hole between plan slots fails plan");
  const d2 = structuredClone(data); const off = keys.find(k => !data.plan.slots[k].on);
  if (off) { d2.plan.slots[off].l1 += 1; t(checkPlan(d2).length > 0, "seeded defect: an off slot with length fails plan"); }
  const b1 = structuredClone(r.beatsDoc); b1.beats[2].p0 += 0.004;
  t(checkBeats(b1, r.S).length > 0, "seeded defect: a p gap between beats fails beats");
  const b2 = structuredClone(r.beatsDoc); const fl = b2.beats.findIndex(b => b.kind === "flight"); b2.beats[fl].l1 -= 3;
  t(checkBeats(b2, r.S).length > 0, "seeded defect: an l hole after a flight fails beats");
  const r3 = {...r, beatsDoc: structuredClone(r.beatsDoc)}; r3.beatsDoc.beats[1].shot = "no_such_shot";
  t(checkSchema(r3).some(m => /missing/.test(m)), "seeded defect: a beat whose shot does not exist fails schema");
  t(holesIn([{beat: "B5", id: "x", text: {display: "{{c1_v}} km/s", sub: null}}]).length === 1
    && holesIn([{beat: "B5", id: "x", text: {display: "one in undefined", sub: null}}]).length === 1
    && holesIn([{beat: "B5", id: "x", text: {display: "N is – here", sub: null}}]).length === 1
    && holesIn([{beat: "B5", id: "x", text: {display: "at {{$live}} km/s", sub: null}}]).length === 0, "seeded defect: rendered holes ({{key}}, undefined, lone dash) fail copy; live keys pass");
  t(nonFinite({a: [1, {b: NaN}], c: Infinity}).length === 2, "seeded defect: NaN and Infinity in shots fail finite");
  const d0 = structuredClone(data); delete d0.case.rule_version;
  t(EN.schemaErrors(SD3, d0).length > 0, "seeded defect: story-data/3 without case.rule_version fails schema");
  const tmp = path.join(os.tmpdir(), `fuzz_role_${process.pid}.json`);
  const d3 = structuredClone(data); delete d3.roles.S5; delete d3.roles["cloudA.core"]; delete d3.roles["lead.core"];
  fs.writeFileSync(tmp, JSON.stringify(d3));
  const res3 = await fuzzOne(tmp); fs.rmSync(tmp, {force: true});
  t(res3.fails.some(f => f.check === "throw" && /role/.test(f.msg)), `seeded defect: deleted roles (S5, cloudA.core, lead.core) fail throw (${(res3.fails[0] || {}).msg || "no failure"})`);
  const h1 = outputHash(r), r4 = {...r, shotsDoc: structuredClone(r.shotsDoc)}; const sk = Object.keys(r4.shotsDoc.shots)[0];
  r4.shotsDoc.shots[sk] = {...r4.shotsDoc.shots[sk], seeded: Math.random()};
  t(outputHash(r4) !== h1, "seeded defect: a changed shot changes the output hash (rerun)");
  return {ok, bad};
}

/* ---------------------------------------------------------------- CLI */
function argList(a, flag) {
  const out = []; let on = false;
  for (const x of a) { if (x === flag) { on = true; continue; } if (x.startsWith("--")) on = false; else if (on) out.push(x); }
  return out;
}
const storyFilesIn = dir => {
  const out = [];
  for (const e of fs.readdirSync(dir, {withFileTypes: true})) {
    if (e.isFile() && /^story_\d+_.+\.json$/.test(e.name)) out.push(path.join(dir, e.name));
    else if (e.isDirectory()) for (const f of fs.readdirSync(path.join(dir, e.name))) if (/^story_\d+_.+\.json$/.test(f)) out.push(path.join(dir, e.name, f));
  }
  return out.sort();
};
async function main() {
  const a = process.argv.slice(2), val = f => { const i = a.indexOf(f); return i >= 0 ? a[i + 1] : null; };
  if (a[0] === "--one") {
    await init(); const data = JSON.parse(fs.readFileSync(a[1], "utf8"));
    console.log(outputHash(await D.direct(storyIdOf(data), M, TP, {data: a[1], noRepair: true, quick: true}))); return 0;
  }
  if (a[0] === "--merge") {
    const parts = a.slice(2).map(f => JSON.parse(fs.readFileSync(f, "utf8")));
    const results = parts.flatMap(p => p.results), hardSet = new Set(parts.flatMap(p => p.hard_files || []));
    const sum = summarise(results, hardSet);
    fs.writeFileSync(a[1], JSON.stringify({...sum, hard_files: [...hardSet], results}, null, 1));
    console.log(JSON.stringify({hard: {n: sum.hard.n, pass: sum.hard.pass}, pool: {n: sum.pool.n, pass: sum.pool.pass, rate: sum.pool.rate}, direct_ms: sum.direct_ms}));
    return sum.hard.pass === sum.hard.n ? 0 : 1;
  }
  let hard = argList(a, "--hard").map(f => path.resolve(f)), pool = argList(a, "--pool").map(f => path.resolve(f));
  for (const d of argList(a, "--dirs")) pool.push(...storyFilesIn(path.resolve(d)));
  let st = {ok: 0, bad: 0};
  const v3 = path.join(ROOT, "data/v3");
  const picks = fs.existsSync(v3) ? storyFilesIn(v3).filter(f => path.dirname(f) === v3) : [];
  if (!hard.length && !pool.length) {
    if (!picks.length) { console.log("skip: no ROOT/data/v3 story-data/3 files"); return 0; }
    st = await selfTest(picks.find(f => /rand_b139_a096/.test(f)) || picks[0]);
    hard = picks;
  }
  const sh = val("--shard");
  if (sh) { const [i, n] = sh.split("/").map(Number); pool = pool.filter((_, k) => k % n === i); hard = hard.filter((_, k) => k % n === i); }
  const hardSet = new Set(hard), results = [];
  for (const f of [...hard, ...pool]) {
    const res = await fuzzOne(f, {rerun: hardSet.has(f) ? "proc" : "mem"});
    results.push(res);
    if (hardSet.has(f)) { if (res.fails.length) { st.bad++; console.log(`FAIL G17 hard ${res.story || "?"} ${res.galaxy} ${res.ray}: ${res.fails.slice(0, 3).map(x => `${x.check}: ${x.msg}`).join(" | ")}`); }
      else { st.ok++; console.log(`ok G17 hard ${res.story} ${res.galaxy} ${res.ray} (declared ${res.declared}, ${res.beats} beats, ${res.ms} ms)`); } }
  }
  const sum = summarise(results, hardSet);
  if (val("--out")) fs.writeFileSync(val("--out"), JSON.stringify({...sum, hard_files: hard, results}, null, 1));
  if (pool.length) console.log(`G17 pool: ${sum.pool.pass}/${sum.pool.n} pass (${(100 * sum.pool.rate).toFixed(2)} %, target 99 %); top causes: ${sum.pool.buckets.slice(0, 3).map(b => `${b.n}× ${b.cause}`).join("; ") || "none"}`);
  console.log(`${st.bad ? "FAIL" : "ok"} story_engine_fuzz: ${st.ok} ok, ${st.bad} failed`);
  return st.bad ? 1 : 0;
}
const isMain = process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
if (isMain) process.exitCode = await main();
