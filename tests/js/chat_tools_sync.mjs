// The tool schemas embedded in docs/tng50/js/chat.js must deep-equal server/chat_tools.json (single source), the
// system prompt must equal server/chat.py SYSTEM_PROMPT, and the search query schema must deep-equal
// tngsight.search.QUERY_SCHEMA (tests/js/fixtures/query_schema.json, from `python -m tngsight.search --schema`;
// skipped with a note when the fixture is absent). Usage: node tests/js/chat_tools_sync.mjs
import {readFileSync, existsSync} from "node:fs";
import {deepStrictEqual} from "node:assert";
import {join, dirname} from "node:path";
import {fileURLToPath, pathToFileURL} from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url)), ROOT = join(HERE, "..", "..");
const C = await import(pathToFileURL(join(ROOT, "docs", "tng50", "js", "chat.js")).href);
let fails = 0;
const check = (ok, msg) => { console.log(`${ok ? "ok  " : "FAIL"} ${msg}`); if (!ok) fails++; };
const deq = (a, b) => { try { deepStrictEqual(a, b); return true; } catch { return false; } };

const server = JSON.parse(readFileSync(join(ROOT, "server", "chat_tools.json"), "utf8"));
check(deq(C.TOOLS, server), "chat.js TOOLS deep-equal server/chat_tools.json");
const py = readFileSync(join(ROOT, "server", "chat.py"), "utf8");
const m = py.match(/SYSTEM_PROMPT = \(\n([\s\S]*?)\)\n/);
const pyPrompt = m ? [...m[1].matchAll(/"((?:[^"\\]|\\.)*)"/g)].map(x => JSON.parse(`"${x[1]}"`)).join("") : null;
check(pyPrompt === C.SYSTEM_PROMPT, "chat.js SYSTEM_PROMPT == server/chat.py SYSTEM_PROMPT");
const q = C.TOOLS.find(t => t.name === "search_sightlines").input_schema.properties.query;
const fx = join(HERE, "fixtures", "query_schema.json");
if (existsSync(fx)) check(deq(q, JSON.parse(readFileSync(fx, "utf8"))), "search_sightlines.query deep-equals tngsight.search.QUERY_SCHEMA");
else console.log("skip query schema vs tngsight.search (tests/js/fixtures/query_schema.json absent)");
const js = join(ROOT, "docs", "tng50", "js", "search.js");
if (existsSync(js)) { const S = await import(pathToFileURL(js).href); check(deq(q, S.QUERY_SCHEMA), "search_sightlines.query deep-equals search.js QUERY_SCHEMA"); }
console.log(`${fails} failed`);
process.exit(fails ? 1 : 0);
