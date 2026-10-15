// Turn loops of docs/tng50/js/chat.js with scripted fake backends and a fake window.tngApp bridge (no DOM, no network):
// tool order, the 6-call cap, one repair retry, parallel tool_use -> ONE tool_result message, verbatim assistant
// content, grounding badge, refusal / max_tokens handling, tool execution results. Usage: node tests/js/chat_loop.mjs
import {join, dirname} from "node:path";
import {fileURLToPath, pathToFileURL} from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url)), ROOT = join(HERE, "..", "..");
const C = await import(pathToFileURL(join(ROOT, "docs", "tng50", "js", "chat.js")).href);
const searchUrl = pathToFileURL(join(ROOT, "docs", "tng50", "js", "search.js")).href;
let fails = 0, n = 0;
const check = (ok, msg) => { n++; console.log(`${ok ? "ok  " : "FAIL"} ${msg}`); if (!ok) fails++; };
const J = JSON.stringify;

// ---------------------------------------------------------------- fake bridge
function fakeApp() {
  const comp = (v, logN, b, flag = 0) => ({v, dv: 0.1, logN, dlogN: 0.01, b, db: 0.2, region: 0, flag, EW: 10});
  const entries = [
    {id: "edge_b100_a090", orientation: "edge-on", b_kpc: 100, azimuth_deg: 90, v_sys: 12.3456, logN: {OVI: 14.2345, HI: 15.01, CIII: 13.1}},
    {id: "face_b050_a000", orientation: "face-on", b_kpc: 50, azimuth_deg: 0, v_sys: -3.2, logN: {OVI: 13.5, HI: 14.0, CIII: 12.7}}];
  const comps = {edge_b100_a090: {OVI: [comp(-42.17, 13.912, 23.4), comp(61.5, 13.4, 30.2), comp(140, 14.6, 12, 1)], HI: [], CIII: []},
    face_b050_a000: {OVI: [comp(0, 14.0, 20)], HI: [], CIII: []}};
  const log = [];
  const state = {id: "face_b050_a000", R_lo: 20000, R_hi: 40000, sn_hi: 8, sn_lo: 5, vwin: 400, api: "http://127.0.0.1:8899"};
  const app = {
    log, state,
    getState: () => ({...state}),
    entries: () => entries.map(e => ({...e})),
    entry: id => entries.find(e => e.id === id) || null,
    async select(id, o) { log.push(["select", id, o.source]); if (!app.entry(id)) return false; state.id = id; return true; },
    setInstrument(s) { log.push(["setInstrument", s]); for (const k of ["R_lo", "R_hi"]) if (s[k] != null && ![20000, 30000, 40000, 60000, 80000, 100000].includes(s[k])) throw new RangeError("bad R");
      Object.assign(state, s); return {...state}; },
    async submitGeometry(g) { log.push(["submitGeometry", g]);
      if (g.b_kpc === 100 && g.orientation === "edge-on") return {status: "ready", id: "edge_b100_a090"};
      return {status: "queued", id: "edge_b123_a045", job_id: "j_abc", position: 2}; },
    async submitCustom(c) { log.push(["submitCustom", c]); return {status: "error", message: "another sightline is being generated"}; },
    async components(id) { return comps[id] || null; },
    async componentsIndex() { return {params: {}, entries: comps}; },
    async show3d(o) { log.push(["show3d", o]); return {ok: false, webgl2: false, message: "3D view needs WebGL2"}; },
  };
  return app;
}

// ---------------------------------------------------------------- executor
{
  const app = fakeApp(), sub = [];
  const ex = C.createToolExecutor(app, {loadSearch: () => import(searchUrl), onSubmitted: j => sub.push(j)});
  // set_instrument v3 arguments validate against the registry schema; the bridge mapping onto tngApp.setInstrument
  // v3 (design.md §6.5) is part B, so only the call itself is checked here.
  let r = await ex("set_instrument", {snr: [12, 4]});
  check(r.ok === true && app.log[0][0] === "setInstrument", `set_instrument with v3 arguments reaches the bridge (${J(r)})`);
  r = await ex("set_instrument", {vhw: 5});
  check(r.ok === false && r.error.startsWith("invalid arguments: args.vhw"), "executor re-validates arguments");
  check(C.validateToolCall("set_instrument", {R: {uv: 25000, euv: [5000, 150000], xray: [100, 5000]}, snr: 100, ions: ["OVII"],
    layout: "1", vc: 30, vhw: 20, fit: true}) === null, "set_instrument schema accepts every v3 field");
  r = await ex("select_sightline", {id: "edge_b100_a090"});
  check(r.ok && r.id === "edge_b100_a090" && r.v_sys === 12.35 && r.logN.OVI === 14.23 && r.components.OVI.length === 3
    && J(Object.keys(r.components.OVI[0])) === J(["v", "logN", "b", "flag"]), `select_sightline result shape (${J(r).slice(0, 120)}…)`);
  check(app.log.some(x => x[0] === "select" && x[1] === "edge_b100_a090" && x[2] === "chat"), "select_sightline calls app.select with source chat");
  r = await ex("select_sightline", {id: "rand_b075_a000_s12345"});
  check(J(r) === J({ok: false, error: "unknown sightline id"}), "select_sightline unknown id");
  r = await ex("search_sightlines", {query: {ion: "OVI", n_min: 2}});
  check(r.ok && r.n_total === 1 && r.results[0].id === "edge_b100_a090" && typeof r.results[0].reason === "string"
    && J(Object.keys(r.results[0])) === J(["id", "score", "n", "b_kpc", "orientation", "reason"]), `search_sightlines via search.js (${J(r).slice(0, 160)})`);
  r = await ex("search_sightlines", {query: {ion: "OVI", n_min: 3, n_max: 2}});
  check(r.ok === false && /n_max/.test(r.error), `search_sightlines semantic validation error passes through (${r.error})`);
  r = await ex("request_sightline", {orientation: "edge-on", b_kpc: 123, azimuth_deg: 45});
  check(r.ok && r.status === "queued" && r.job_id === "j_abc" && /about a minute/.test(r.note) && sub[0].job_id === "j_abc", "request_sightline queued -> note, job tracked");
  r = await ex("request_sightline", {orientation: "edge-on", b_kpc: 100, azimuth_deg: 90});
  check(r.ok && r.status === "ready" && r.id === "edge_b100_a090" && app.state.id === "edge_b100_a090", "request_sightline ready -> selected");
  r = await ex("request_custom_ray", {p0_kpc: [-100, 0, 0], p1_kpc: [100, 0, 0]});
  check(J(r) === J({ok: false, error: "another sightline is being generated"}), "request_custom_ray error passes through");
  r = await ex("show_3d", {species: "OVI", preset: "face-on"});
  check(J(r) === J({ok: false, error: "3D view needs WebGL2"}), "show_3d without WebGL2");
  r = await ex("nope", {});
  check(r.ok === false && /unknown tool/.test(r.error), "unknown tool");
}

// ---------------------------------------------------------------- local loop
function scripted(replies) {
  const seen = [];
  const gen = async msgs => { seen.push(msgs); if (!replies.length) throw new Error("script exhausted"); return replies.shift(); };
  return {gen, seen};
}
function recExec() {
  const calls = [];
  const exec = async (name, args) => { calls.push(name); return {ok: true, name, echo: args, n_total: 3, v: -42.17, logN: 13.912}; };
  return {exec, calls};
}
{
  const {gen, seen} = scripted([
    '{"tool":"search_sightlines","args":{"query":{"ion":"OVI","n_min":2}}}',
    '```json\n{"tool":"select_sightline","args":{"id":"edge_b100_a090"}}\n```',
    '{"answer":"edge_b100_a090 has a component at -42 km/s with logN 13.9; 3 matches in total."}']);
  const {exec, calls} = recExec(), state = {messages: []}, ev = [];
  const r = await C.runLocalTurn({generate: gen, state, userText: "two O VI components?", exec, onEvent: e => ev.push(e.type), knownId: id => id === "edge_b100_a090"});
  check(J(calls) === J(["search_sightlines", "select_sightline"]), "local: tools run sequentially in emitted order");
  check(r.answer && r.answer.startsWith("edge_b100_a090") && r.calls.length === 2 && !r.error, "local: final answer returned");
  check(r.unverified.length === 0, `local: grounded numbers (-42 from -42.17, 13.9 from 13.912) -> no badge (${J(r.unverified)})`);
  check(seen[0][0].role === "system" && seen[0][0].content === C.localSystemPrompt(), "local: system prompt first");
  check(state.messages[2].role === "user" && state.messages[2].content.startsWith("TOOL_RESULT search_sightlines: {"), "local: TOOL_RESULT fed back as a user message");
  check(J(ev) === J(["tool", "result", "tool", "result"]), "local: UI events");
}
{
  const {gen} = scripted(['{"answer":"Sightline edge_b100_a090 has logN 15.7 and b = 88 km/s."}']);
  const r = await C.runLocalTurn({generate: gen, state: {messages: []}, userText: "tell me about edge_b100_a090", exec: recExec().exec});
  check(J(r.unverified) === J(["15.7", "88"]), `grounding: invented numbers flagged (${J(r.unverified)})`);
}
{
  const {gen} = scripted(['{"answer":"Try cust_0123456789 with R 20,000 and S/N 8."}']);
  const r = await C.runLocalTurn({generate: gen, state: {messages: []}, userText: "use R=20000", exec: recExec().exec, knownId: () => false});
  check(J(r.unverified) === J(["cust_0123456789"]), `grounding: unknown id flagged; 20,000 grounded by the user; single digit ignored (${J(r.unverified)})`);
}
{
  const {gen, seen} = scripted(["I'd call show_3d now.", '{"tool":"show_3d","args":{"species":"OVI"}}', '{"answer":"Done."}']);
  const state = {messages: []}, ev = [];
  const r = await C.runLocalTurn({generate: gen, state, userText: "show O VI", exec: recExec().exec, onEvent: e => ev.push(e.type)});
  check(r.answer === "Done." && ev[0] === "repair", "local: one repair retry recovers");
  check(seen[1].at(-1).content === C.repairMessage("no JSON object found"), "local: repair prompt sent verbatim");
}
{
  const {gen, seen} = scripted(["nope", "still nope", '{"answer":"never reached"}']);
  const r = await C.runLocalTurn({generate: gen, state: {messages: []}, userText: "x", exec: recExec().exec});
  check(r.answer === null && /invalid format twice/.test(r.error) && seen.length === 2, "local: second invalid reply ends the turn (exactly 1 repair)");
}
{
  const {gen, seen} = scripted(["bad", '{"tool":"show_3d","args":{}}', "bad again", '{"answer":"x"}']);
  const r = await C.runLocalTurn({generate: gen, state: {messages: []}, userText: "x", exec: recExec().exec});
  check(r.answer === null && r.error && seen.length === 3, "local: at most one repair per turn even after a valid reply");
}
{
  const replies = Array.from({length: 20}, () => '{"tool":"show_3d","args":{}}');
  const {gen} = scripted(replies), {exec, calls} = recExec();
  const r = await C.runLocalTurn({generate: gen, state: {messages: []}, userText: "loop", exec});
  check(calls.length === 6 && r.answer === null && /6 tool calls/.test(r.error), `local: 6-call cap (${calls.length} executed)`);
}
{
  const state = {messages: Array.from({length: 30}, (_, i) => ({role: i % 2 ? "assistant" : "user", content: "m" + i}))};
  const {gen, seen} = scripted(['{"answer":"ok"}']);
  await C.runLocalTurn({generate: gen, state, userText: "latest", exec: recExec().exec});
  check(seen[0].length === 11 && seen[0][10].content === "latest", "local: context = system + last 10 messages");
}

// ---------------------------------------------------------------- Claude loop
const THINK = {type: "thinking", thinking: "", signature: "sig+/=="};
function claudeScript(responses) {
  const bodies = [];
  const post = async body => { bodies.push(JSON.parse(JSON.stringify(body))); if (!responses.length) throw new Error("exhausted"); return responses.shift(); };
  return {post, bodies};
}
{
  const resp1 = {content: [THINK, {type: "text", text: "Searching and opening 3D."},
    {type: "tool_use", id: "toolu_1", name: "search_sightlines", input: {query: {ion: "OVI"}}},
    {type: "tool_use", id: "toolu_2", name: "show_3d", input: {species: "OVI"}}], stop_reason: "tool_use", usage: {}};
  const snapshot = J(resp1.content);
  const {post, bodies} = claudeScript([resp1, {content: [{type: "text", text: "Found 3."}], stop_reason: "end_turn", usage: {}}]);
  const {exec, calls} = recExec(), state = {messages: []};
  const r = await C.runClaudeTurn({post, state, userText: "find O VI", exec});
  check(J(calls) === J(["search_sightlines", "show_3d"]), "claude: parallel tool_use executed in order");
  const tr = bodies[1].messages[2];
  check(bodies[1].messages.length === 3 && tr.role === "user" && tr.content.length === 2 && tr.content.every(b => b.type === "tool_result")
    && tr.content[0].tool_use_id === "toolu_1" && tr.content[1].tool_use_id === "toolu_2", "claude: ALL tool_results in ONE user message, in order");
  check(state.messages[1].content === resp1.content && J(state.messages[1].content) === snapshot && J(bodies[1].messages[1].content) === snapshot,
    "claude: assistant content appended verbatim (same array, thinking + signature untouched)");
  check(r.answer === "Found 3." && r.unverified.length === 0, "claude: final answer, '3' is single-digit -> no badge");
  check(J(Object.keys(bodies[0])) === J(["messages"]), "claude: request body is {messages} only");
}
{
  const many = id => ({content: [0, 1, 2, 3].map(i => ({type: "tool_use", id: `t${id}_${i}`, name: "show_3d", input: {}})), stop_reason: "tool_use", usage: {}});
  const {post, bodies} = claudeScript([many(1), many(2), {content: [{type: "text", text: "ok"}], stop_reason: "end_turn", usage: {}}]);
  const {exec, calls} = recExec(), state = {messages: []};
  const r = await C.runClaudeTurn({post, state, userText: "go", exec});
  const res2 = bodies[2].messages[4].content;
  check(calls.length === 6 && res2.length === 4 && res2.filter(b => b.is_error).length === 2 && /limit \(6 per question\)/.test(res2[3].content),
    `claude: 6-call cap, extra tool_use answered with is_error (${calls.length} executed)`);
  check(r.answer === "ok", "claude: answer after the cap");
}
{
  const {post} = claudeScript([{content: [{type: "tool_use", id: "tb", name: "set_instrument", input: {vhw: 5}}], stop_reason: "tool_use", usage: {}},
    {content: [{type: "text", text: "Sorry."}], stop_reason: "end_turn", usage: {}}]);
  const state = {messages: []}, calls = [];
  const exec = async name => { calls.push(name); return {ok: false, error: "unknown sightline id"}; };
  await C.runClaudeTurn({post, state, userText: "x", exec});
  const b = state.messages[2].content[0];
  check(calls.length === 1 && b.is_error === true && b.content === '{"ok":false,"error":"unknown sightline id"}', "claude: executor result ok:false -> is_error true");
}
{
  const ex = C.createToolExecutor(fakeApp());
  const {post} = claudeScript([{content: [{type: "tool_use", id: "tb", name: "set_instrument", input: {vhw: 5}}], stop_reason: "tool_use", usage: {}},
    {content: [{type: "text", text: "Sorry."}], stop_reason: "end_turn", usage: {}}]);
  const state = {messages: []};
  await C.runClaudeTurn({post, state, userText: "x", exec: ex});
  const b = state.messages[2].content[0];
  check(b.is_error === true && JSON.parse(b.content).error.startsWith("invalid arguments: args.vhw: must be >= 10"), "claude: schema violation -> is_error with 'invalid arguments: <path>: <reason>'");
}
{
  const {post} = claudeScript([{content: [{type: "tool_use", id: "tr", name: "show_3d", input: {}}], stop_reason: "refusal", usage: {}}]);
  const state = {messages: []}, {exec, calls} = recExec();
  const r = await C.runClaudeTurn({post, state, userText: "x", exec});
  check(r.error === "The model declined this request." && calls.length === 0 && state.messages.at(-1).content[0].tool_use_id === "tr",
    "claude: refusal ends the turn, no tools run, open tool_use closed for a valid history");
}
{
  const {post} = claudeScript([{content: [{type: "text", text: "The answer is partially 13.9"}], stop_reason: "max_tokens", usage: {}}]);
  const r = await C.runClaudeTurn({post, state: {messages: []}, userText: "x", exec: recExec().exec});
  check(r.answer === "The answer is partially 13.9" && /cut off/.test(r.note) && J(r.unverified) === J(["13.9"]), "claude: max_tokens -> partial text + note (+ badge)");
}
{
  const state = {messages: []};
  const post = async () => { throw new Error("Chat rate limit reached. Try again in 30 s."); };
  const r = await C.runClaudeTurn({post, state, userText: "x", exec: recExec().exec});
  check(state.messages.length === 0 && /rate limit/.test(r.error), "claude: failed first request leaves history unchanged");
}
{
  const fake = (status, body, headers = {}) => async () => ({ok: status === 200, status, json: async () => body, headers: {get: k => headers[k] ?? null}});
  const tryPost = async f => { try { await C.createClaudePost("http://x", f)({messages: []}); return null; } catch (e) { return e.message; } };
  check(await tryPost(fake(429, {detail: "daily chat budget exhausted"}, {"Retry-After": "7200"})) === "The daily chat budget is used up. Try again in 120 min.", "claude post: daily budget message");
  check(await tryPost(fake(404, {detail: "chat disabled"})) === "Claude chat is disabled on this server.", "claude post: 404 message");
  check(/busy/.test(await tryPost(fake(503, {detail: "x"}, {"Retry-After": "5"}))), "claude post: 503 message");
  check(await tryPost(fake(422, {detail: "messages[0]: bad"})) === "Chat request failed: messages[0]: bad", "claude post: 422 detail");
}

// ---------------------------------------------------------------- misc helpers
check(C.chipLabel("search_sightlines", {query: {ion: "OVI", sep_kms: [50, 150]}}) === "search_sightlines ion=OVI sep_kms=50,150", "chip label flattens the query");
check(C.fmt(2.5, 0) === "3" && C.fmt(-2.5, 0) === "-3" && C.fmt(-0.04, 0) === "0" && C.fmt(13.95, 1) === "14.0", "fmt per §2");
check((await C.webgpuStatus({})).ok === false && (await C.webgpuStatus({gpu: {requestAdapter: async () => ({features: new Set()})}})).reason.includes("shader-f16")
  && (await C.webgpuStatus({gpu: {requestAdapter: async () => ({features: new Set(["shader-f16"])})}})).ok, "WebGPU / shader-f16 check");
check(C.WEBLLM_URL === "https://cdn.jsdelivr.net/npm/@mlc-ai/web-llm@0.2.85/lib/index.js" && C.WEBLLM_MODEL === "Qwen2.5-1.5B-Instruct-q4f16_1-MLC", "WebLLM pinned to the prebuilt lib/index.js (not the generated /+esm)");
{ // Subresource Integrity on every piece of third-party code the local model runs
  const SRI = /^sha384-[A-Za-z0-9+/]{64}$/, R = C.MODEL_RECORD;
  check(SRI.test(C.WEBLLM_SRI) && SRI.test(R.integrity.model_lib) && SRI.test(R.integrity.config) && SRI.test(R.integrity.tokenizer["tokenizer.json"]) && R.integrity.onFailure === "error",
    "SRI hashes present for WebLLM, the model wasm, config and tokenizer");
  check(R.model_id === C.WEBLLM_MODEL && R.model.includes(`/resolve/${C.MODEL_HF_REV}/`) && /^[0-9a-f]{40}$/.test(C.MODEL_HF_REV) &&
    R.model_lib.includes(`/binary-mlc-llm-libs/${C.MODEL_LIB_COMMIT}/`) && /^[0-9a-f]{40}$/.test(C.MODEL_LIB_COMMIT) && !/\/main\//.test(R.model + R.model_lib),
    "model files and model library pinned to immutable revisions, not main");
  check(C.APP_CONFIG.model_list.length === 1 && C.APP_CONFIG.model_list[0] === R, "appConfig carries only the pinned record");
  const calls = [];
  const fakeFetch = async (url, init) => { calls.push({url, init}); return {ok: true, status: 200, arrayBuffer: async () => new TextEncoder().encode("export const x = 1;").buffer}; };
  const mod = await C.importVerified(C.WEBLLM_URL, C.WEBLLM_SRI, {fetchImpl: fakeFetch, importer: async u => ({u})});
  check(calls.length === 1 && calls[0].url === C.WEBLLM_URL && calls[0].init.integrity === C.WEBLLM_SRI && calls[0].init.credentials === "omit" && /^blob:/.test(mod.u),
    "importVerified fetches with the integrity hash and imports the verified bytes from a blob: URL");
  let err = null; try { await C.importVerified(C.WEBLLM_URL, C.WEBLLM_SRI, {fetchImpl: async () => { throw new TypeError("Failed to fetch (integrity)"); }, importer: async () => ({})}); } catch (e) { err = e; }
  check(err && /integrity/.test(err.message), "importVerified rejects when the fetch fails its integrity check (nothing is imported)");
  let imported = false; err = null;
  try { await C.importVerified(C.WEBLLM_URL, C.WEBLLM_SRI, {fetchImpl: async () => ({ok: false, status: 404}), importer: async () => { imported = true; }}); } catch (e) { err = e; }
  check(err && !imported && /HTTP 404/.test(err.message), "importVerified: HTTP error, no import");
  let seenUrl = null;
  await C.createLocalGenerate(() => {}, async (u, sri) => { seenUrl = [u, sri]; throw new Error("stop"); }).catch(() => {});
  check(seenUrl && seenUrl[0] === C.WEBLLM_URL && seenUrl[1] === C.WEBLLM_SRI, "createLocalGenerate loads WebLLM only through the verified importer");
  const worker = (await import("node:fs")).readFileSync(new URL("../../docs/tng50/js/chat_worker.js", import.meta.url), "utf8");
  check(/importVerified\(WEBLLM_URL, WEBLLM_SRI\)/.test(worker) && !/cdn\.jsdelivr|\+esm/.test(worker), "worker imports WebLLM through importVerified, no raw CDN import");
  const src = (await import("node:fs")).readFileSync(new URL("../../docs/tng50/js/chat.js", import.meta.url), "utf8");
  check(!/CreateMLCEngine\(/.test(src.replace(/CreateWebWorkerMLCEngine/g, "")), "no main-thread CreateMLCEngine fallback");
}
{ // consent wording by origin (security-5)
  const D = ["http://127.0.0.1:8787", "https://me-space.hf.space/"];
  check(!C.isOverrideApi("https://me-space.hf.space", D) && C.isOverrideApi("https://other.example", D) && !C.isOverrideApi(null, D), "override detection normalises trailing slashes");
  const own = C.claudeNote("https://me-space.hf.space", D), ext = C.claudeNote("https://other.example", D);
  check(/this site's sightline server \(me-space\.hf\.space\)/.test(own) && /does not log the message text/.test(own) && !/not logged\)/.test(own), "own-server note names the host and states what is logged");
  check(/other\.example, an override server that this site does not operate/.test(ext) && /can read and keep them/.test(ext) && !/Anthropic through|our server|not log/.test(ext), "override note names the host and makes no logging promise");
  check(C.claudeOptionLabel("https://other.example", D) === "Claude (via other.example, override)" && C.claudeOptionLabel(D[0], D) === "Claude (server)", "backend option label marks overrides");
}

console.log(`${n} checks, ${fails} failed`);
process.exit(fails ? 1 : 0);
