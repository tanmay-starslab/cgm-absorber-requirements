// Runs every Node test in tests/js (each *.mjs except this file) and exits non-zero if any fails.
// Usage (Node >= 20, from the repository root): PYTHON=<python with numpy + tngsight deps> node tests/js/run_all.mjs [name-filter]
// ($PYTHON, default "python", builds the parity references for degrade_parity, picker_math and viz_decode.)
// The Python suite (python -m pytest tests) does not run these; the JS/Python parity and the chat_tools.json sync
// checks live here. page_smoke.mjs needs docs/tng50/index.html (re-export with scripts/export_tng50_web.py first).
// Browser tests are opt-in: with TNG_BROWSER=1, page_smoke.mjs, ui_budget.mjs, the browser half of ui_static.mjs and
// viewer_browser.mjs (needs TNG_VIZ=<viz dir>) drive headless Edge one at a time; without it they skip (ui_static.mjs
// and page_smoke.mjs still run their static checks). TNG_TEST_PORT fixes their static-server port (default OS-chosen),
// TNG_EDGE_PROFILE the Edge profile parent dir, TNG_EDGE the Edge binary. tests/js/lib/ holds their shared harness.
// The in-browser fitter tests (fit_voigt, fit_degrade, fit_parity, fit_unit, fit_bench, fit_worker) read the committed
// tests/js/fixtures/fit_cases.json + fit_bins/ and need no Python; rebuild those with tests/js/make_fit_fixture.py.
import {readdirSync} from "node:fs";
import {spawnSync} from "node:child_process";
import {fileURLToPath} from "node:url";
import path from "node:path";

const dir = path.dirname(fileURLToPath(import.meta.url)), root = path.resolve(dir, "../.."), filt = process.argv[2] || "";
const files = readdirSync(dir).filter(f => f.endsWith(".mjs") && f !== "run_all.mjs" && f.includes(filt)).sort();
const ARGS = {"page_smoke.mjs": ["docs/tng50", ...(process.env.TNG_SMOKE_API ? [process.env.TNG_SMOKE_API] : [])],   // TNG_SMOKE_API: optional backend URL
  "ui_static.mjs": ["docs/tng50"], "ui_budget.mjs": ["docs/tng50"],
  ...(process.env.TNG_VIZ ? {"viewer_browser.mjs": ["--viz", process.env.TNG_VIZ]} : {})};   // TNG_VIZ: viz dir with manifest_v2.json
const bad = [];
for (const f of files) {
  const t0 = Date.now(), r = spawnSync(process.execPath, [path.join(dir, f), ...(ARGS[f] || [])], {cwd: root, encoding: "utf8"});
  const tail = (r.stdout || "").trim().split("\n").filter(Boolean).pop() || "";
  console.log(`${r.status === 0 ? "PASS" : "FAIL"}  ${f}  (${((Date.now() - t0) / 1000).toFixed(1)} s)  ${tail}`);
  if (r.status !== 0) { bad.push(f); process.stdout.write((r.stdout || "").split("\n").filter(l => !l.startsWith("ok ")).join("\n") + (r.stderr || "")); }
}
console.log(`${files.length} test files, ${bad.length} failed${bad.length ? ": " + bad.join(", ") : ""}`);
process.exit(bad.length ? 1 : 0);
