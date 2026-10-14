// Runs every Node test in tests/js (each *.mjs except this file) and exits non-zero if any fails.
// Usage (Node >= 20, from the repository root): PYTHON=<python with numpy + tngsight deps> node tests/js/run_all.mjs [name-filter]
// ($PYTHON, default "python", builds the parity references for degrade_parity, picker_math and viz_decode.)
// The Python suite (python -m pytest tests) does not run these; the JS/Python parity and the chat_tools.json sync
// checks live here. page_smoke.mjs needs docs/tng50/index.html (re-export with scripts/export_tng50_web.py first).
import {readdirSync} from "node:fs";
import {spawnSync} from "node:child_process";
import {fileURLToPath} from "node:url";
import path from "node:path";

const dir = path.dirname(fileURLToPath(import.meta.url)), root = path.resolve(dir, "../.."), filt = process.argv[2] || "";
const files = readdirSync(dir).filter(f => f.endsWith(".mjs") && f !== "run_all.mjs" && f.includes(filt)).sort();
const ARGS = {"page_smoke.mjs": ["docs/tng50", ...(process.env.TNG_SMOKE_API ? [process.env.TNG_SMOKE_API] : [])]};   // TNG_SMOKE_API: optional backend URL
const bad = [];
for (const f of files) {
  const t0 = Date.now(), r = spawnSync(process.execPath, [path.join(dir, f), ...(ARGS[f] || [])], {cwd: root, encoding: "utf8"});
  const tail = (r.stdout || "").trim().split("\n").filter(Boolean).pop() || "";
  console.log(`${r.status === 0 ? "PASS" : "FAIL"}  ${f}  (${((Date.now() - t0) / 1000).toFixed(1)} s)  ${tail}`);
  if (r.status !== 0) { bad.push(f); process.stdout.write((r.stdout || "").split("\n").filter(l => !l.startsWith("ok ")).join("\n") + (r.stderr || "")); }
}
console.log(`${files.length} test files, ${bad.length} failed${bad.length ? ": " + bad.join(", ") : ""}`);
process.exit(bad.length ? 1 : 0);
