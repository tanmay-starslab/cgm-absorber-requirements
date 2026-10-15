// The registry-derived chat artefacts must agree (design.md §4.3): docs/tng50/js/chat.js TOOLS deep-equals
// server/chat_tools.json, chat.js SYSTEM_PROMPT equals the trimmed text of server/chat_system_prompt.txt (what
// server/chat.py sends), and the search query schema deep-equals tngsight.search.QUERY_SCHEMA
// (tests/js/fixtures/query_schema.json, from `python -m tngsight.search --schema`) and search.js QUERY_SCHEMA.
// With $PYTHON set it also runs `python -m server.make_chat_tools --check` (generated files up to date).
// Usage: [PYTHON=/path/to/python] node tests/js/chat_tools_sync.mjs
import {readFileSync, existsSync} from "node:fs";
import {deepStrictEqual} from "node:assert";
import {spawnSync} from "node:child_process";
import {join, dirname} from "node:path";
import {fileURLToPath, pathToFileURL} from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url)), ROOT = join(HERE, "..", "..");
const C = await import(pathToFileURL(join(ROOT, "docs", "tng50", "js", "chat.js")).href);
let fails = 0;
const check = (ok, msg) => { console.log(`${ok ? "ok  " : "FAIL"} ${msg}`); if (!ok) fails++; };
const deq = (a, b) => { try { deepStrictEqual(a, b); return true; } catch { return false; } };

const server = JSON.parse(readFileSync(join(ROOT, "server", "chat_tools.json"), "utf8"));
check(deq(C.TOOLS, server), "chat.js TOOLS deep-equal server/chat_tools.json");
const prompt = readFileSync(join(ROOT, "server", "chat_system_prompt.txt"), "utf8").trim();
check(prompt === C.SYSTEM_PROMPT, "chat.js SYSTEM_PROMPT == server/chat_system_prompt.txt");
check(!/[·•‧⋅・]| \. /.test(prompt), "system prompt holds no dot separator");
const si = C.TOOLS.find(t => t.name === "set_instrument").input_schema.properties;
const ions = si.ions.items.enum;
check(ions.length === 12 && deq(C.TOOLS.find(t => t.name === "show_3d").input_schema.properties.species.enum,
  ["nH", "T", "Z", ...ions]), "set_instrument ions and show_3d species cover the 12 registry keys");
const q = C.TOOLS.find(t => t.name === "search_sightlines").input_schema.properties.query;
check(deq(q.properties.ion.enum, ions), "search_sightlines ion enum == registry keys");
const fx = join(HERE, "fixtures", "query_schema.json");
if (existsSync(fx)) check(deq(q, JSON.parse(readFileSync(fx, "utf8"))), "search_sightlines.query deep-equals tngsight.search.QUERY_SCHEMA");
else console.log("skip query schema vs tngsight.search (tests/js/fixtures/query_schema.json absent)");
const js = join(ROOT, "docs", "tng50", "js", "search.js");
if (existsSync(js)) {
  const S = await import(pathToFileURL(js).href);
  check(deq(q, S.QUERY_SCHEMA), "search_sightlines.query deep-equals search.js QUERY_SCHEMA");
  check(deq(Object.keys(S.ION_SHORT), ions), "search.js ION_SHORT keys == registry keys");
}
if (process.env.PYTHON) {
  const r = spawnSync(process.env.PYTHON, ["-m", "server.make_chat_tools", "--check"], {cwd: ROOT, encoding: "utf8"});
  check(r.status === 0, `python -m server.make_chat_tools --check (${(r.stdout + r.stderr).trim().split("\n").pop()})`);
} else console.log("skip make_chat_tools --check ($PYTHON unset)");
console.log(`${fails} failed`);
process.exit(fails ? 1 : 0);
