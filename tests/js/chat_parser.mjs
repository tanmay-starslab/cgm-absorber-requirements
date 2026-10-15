// Local-model JSON tool-call protocol of docs/tng50/js/chat.js: extraction, parsing, schema-subset validation and the
// repair prompt, against adversarial model replies. Usage: node tests/js/chat_parser.mjs
import {join, dirname} from "node:path";
import {fileURLToPath, pathToFileURL} from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url)), ROOT = join(HERE, "..", "..");
const C = await import(pathToFileURL(join(ROOT, "docs", "tng50", "js", "chat.js")).href);
let fails = 0, n = 0;
const check = (ok, msg) => { n++; console.log(`${ok ? "ok  " : "FAIL"} ${msg}`); if (!ok) fails++; };
const okTool = (text, tool, args, msg) => { const p = C.parseReply(text);
  check(p.ok && p.type === "tool" && p.tool === tool && JSON.stringify(p.args) === JSON.stringify(args), `${msg} -> ${JSON.stringify(p)}`); };
const okAnswer = (text, answer, msg) => { const p = C.parseReply(text); check(p.ok && p.type === "answer" && p.answer === answer, `${msg} -> ${JSON.stringify(p)}`); };
const bad = (text, needle, msg) => { const p = C.parseReply(text);
  check(!p.ok && typeof p.error === "string" && p.error.includes(needle), `${msg} -> ${JSON.stringify(p)}`); };

// ---- accepted forms
okTool('{"tool":"show_3d","args":{"species":"OVI"}}', "show_3d", {species: "OVI"}, "1 plain tool call");
okAnswer('{"answer":"Two sightlines match."}', "Two sightlines match.", "2 plain answer");
okTool('```json\n{"tool":"select_sightline","args":{"id":"edge_b100_a090"}}\n```', "select_sightline", {id: "edge_b100_a090"}, "3 ```json fence");
okTool('```\n{"tool":"show_3d","args":{}}\n```', "show_3d", {}, "4 bare ``` fence");
okTool('Sure! I will search now.\n{"tool":"search_sightlines","args":{"query":{"ion":"OVI","n_min":2}}}\nHope this helps.',
  "search_sightlines", {query: {ion: "OVI", n_min: 2}}, "5 prose before and after the JSON");
okAnswer('{"answer":"Use {curly} braces and a \\"quote\\" and a } inside"}', 'Use {curly} braces and a "quote" and a } inside',
  "6 nested braces and escaped quotes inside a string");
okTool('{"tool":"search_sightlines","args":{"query":{"ion":"CIII","sep_kms":[50,150],"b_kpc":[0,100],"sort":"b_kpc"}}} {"answer":"x"}',
  "search_sightlines", {query: {ion: "CIII", sep_kms: [50, 150], b_kpc: [0, 100], sort: "b_kpc"}}, "7 two objects: the first balanced one wins");
okTool('{"tool":"show_3d"}', "show_3d", {}, "8 missing args treated as {}");
okTool('{"tool":"set_instrument","args":{"R":{"uv":[15000,50000],"xray":1000},"snr":10,"vhw":450}}', "set_instrument",
  {R: {uv: [15000, 50000], xray: 1000}, snr: 10, vhw: 450}, "9 anyOf: array R per band, scalar R and scalar snr");
okTool('{"tool":"set_instrument","args":{"ions":["HI","MgII","OVII"],"layout":"2SN","vc":-120.5,"fit":true,"snr":[100,2]}}', "set_instrument",
  {ions: ["HI", "MgII", "OVII"], layout: "2SN", vc: -120.5, fit: true, snr: [100, 2]}, "9b ions, layout, vc, fit and S/N at the range ends");
okTool('{"tool":"show_3d","args":{"species":"NeVIII"}}', "show_3d", {species: "NeVIII"}, "9c show_3d accepts a registry ion");
okTool('{"tool":"request_custom_ray","args":{"p0_kpc":[-100,0,0.5],"p1_kpc":[100,20.25,-395]}}', "request_custom_ray",
  {p0_kpc: [-100, 0, 0.5], p1_kpc: [100, 20.25, -395]}, "10 numeric arrays at the bounds");
okTool('{"tool":"select_sightline","args":{"id":"cust_0123456789"}}', "select_sightline", {id: "cust_0123456789"}, "11 custom id pattern");

// ---- rejected forms
bad("", "empty reply", "12 empty reply");
bad("I think the answer is 42.", "no JSON object", "13 prose only");
bad('{"tool":"show_3d","args":{"species":"OVI"}', "no JSON object", "14 unbalanced braces (truncated generation)");
bad("{'tool': 'show_3d'}", "invalid JSON", "15 single-quoted pseudo-JSON");
bad('{"tool":"show_3d","args":{},}', "invalid JSON", "16 trailing comma");
bad('{"tool":"delete_everything","args":{}}', "unknown tool", "17 unknown tool name");
bad('{"tool":"show_3d","args":{"species":"OVI","colour":"red"}}', 'unknown key "colour"', "18 additionalProperties:false");
bad('{"tool":"show_3d","args":{"species":"O6"}}', "must be one of", "19 enum violation");
bad('{"tool":"set_instrument","args":{"vhw":5}}', "args.vhw: must be >= 10", "20 minimum violation (half-window)");
bad('{"tool":"set_instrument","args":{"snr":101}}', "matches none of the allowed forms", "21 anyOf: out-of-range scalar matches neither branch");
bad('{"tool":"set_instrument","args":{"R":{"uv":[20000]}}}', "matches none", "22 anyOf: array too short");
bad('{"tool":"set_instrument","args":{"R":{"far":1000}}}', 'unknown key "far"', "23 R: unknown band");
bad('{"tool":"set_instrument","args":{"R":{"xray":20000}}}', "matches none", "23b R above the band range");
bad('{"tool":"set_instrument","args":{"layout":"3"}}', "must be one of", "23c layout enum");
bad('{"tool":"set_instrument","args":{"ions":["HILyb"]}}', "must be one of", "23d retired key HILyb is not an alias");
bad('{"tool":"set_instrument","args":{"ions":[]}}', "at least 1 item", "23e at least one ion");
bad('{"tool":"request_sightline","args":{"orientation":"face-on","b_kpc":301,"azimuth_deg":0}}', "args.b_kpc: must be <= 300", "24 maximum violation");
bad('{"tool":"request_sightline","args":{"orientation":"random","b_kpc":50}}', 'missing required "azimuth_deg"', "25 required missing");
bad('{"tool":"request_sightline","args":{"orientation":"random","b_kpc":50,"azimuth_deg":10,"seed":1.5}}', "expected integer", "26 integer type");
bad('{"tool":"select_sightline","args":{"id":"cust_ABCDEF0123"}}', "does not match the required pattern", "27 pattern (upper-case hex)");
bad('{"tool":"select_sightline","args":{"id":"edge_b100_a090; DROP"}}', "pattern", "28 pattern anchored at both ends");
bad('{"tool":"request_custom_ray","args":{"p0_kpc":[0,0],"p1_kpc":[1,2,3]}}', "args.p0_kpc: needs at least 3 items", "29 minItems");
bad('{"tool":"request_custom_ray","args":{"p0_kpc":[0,0,0,0],"p1_kpc":[1,2,3]}}', "at most 3 items", "30 maxItems");
bad('{"tool":"request_custom_ray","args":{"p0_kpc":[0,"1",0],"p1_kpc":[1,2,3]}}', "args.p0_kpc[1]: expected number", "31 items type with index path");
bad('{"tool":"search_sightlines","args":{"query":{"n_min":2}}}', 'args.query: missing required "ion"', "32 nested required");
bad('{"tool":"search_sightlines","args":{"query":{"ion":"OVI","logN_min":9}}}', "args.query.logN_min: must be >= 10", "33 nested minimum");
bad('{"tool":"search_sightlines","args":{"query":{"ion":"OVI","limit":"all"}}}', "expected integer", "34 nested type");
bad('{"tool":"show_3d","args":[]}', '"args" must be an object', "35 args is an array");
bad('{"tool":"show_3d","args":{},"answer":"done"}', 'unexpected key "answer"', "36 tool and answer together");
bad('{"answer":"ok","confidence":0.9}', 'unexpected key "confidence"', "37 extra key next to answer");
bad('{"answer":""}', "non-empty string", "38 empty answer");
bad('{"answer":42}', "non-empty string", "39 non-string answer");
bad(JSON.stringify({answer: "x".repeat(2001)}), "exceeds 2000", "40 answer too long");
bad('{"thought":"hmm"}', 'expected a "tool" or an "answer" key', "41 neither key");
okTool('[{"tool":"show_3d"}]', "show_3d", {}, "42 array wrapper: the first balanced {...} inside is used");
bad('{"tool":123,"args":{}}', '"tool" must be a string', "43 non-string tool");
bad('{"tool":"show_3d","args":{"species":null}}', "expected string", "44 null value");
bad('{"tool":"request_sightline","args":{"orientation":"face-on","b_kpc":1e999,"azimuth_deg":0}}', "expected number", "45 Infinity via 1e999 (non-finite)");

// ---- extraction helper and repair prompt
check(C.extractJsonObject('x {"a":"}{"} y') === '{"a":"}{"}', "46 extractJsonObject keeps braces inside strings");
check(C.extractJsonObject('{"a":"\\\\"} tail') === '{"a":"\\\\"}', "47 extractJsonObject handles an escaped backslash before the closing quote");
check(C.repairMessage("no JSON object found") ===
  'Your last reply was invalid (no JSON object found). Reply with ONLY one JSON object of the form {"tool":...,"args":{...}} or {"answer":"..."}.',
  "48 repair prompt text is exact");
check(C.validateToolCall("show_3d", {}) === null && C.validateToolCall("show_3d", {preset: "top"}).startsWith("invalid arguments: args.preset:"),
  "49 validateToolCall error prefix 'invalid arguments: <path>: <reason>'");
const sys = C.localSystemPrompt();
check(sys.startsWith(C.SYSTEM_PROMPT) && C.TOOL_NAMES.every(t => sys.includes(`- ${t}: `)) && sys.includes('{"answer":"<text>"}'),
  "50 local system prompt = §8.4 prompt + every tool + the protocol");
const cap = C.capJson({ok: true, results: Array.from({length: 200}, (_, i) => ({id: "edge_b100_a090", i}))}, 2000);
check(cap.length <= 2000 && JSON.parse(cap).truncated === true && JSON.parse(cap).results.length > 0, `51 capJson truncates lists to ≤ 2000 chars (${cap.length})`);
check(C.toolResultMessage("show_3d", {ok: true}) === 'TOOL_RESULT show_3d: {"ok":true}', "52 TOOL_RESULT message format");

console.log(`${n} checks, ${fails} failed`);
process.exit(fails ? 1 : 0);
