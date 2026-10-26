/* TNG50 explorer chat (Phase 2, §8 of the design contract). The model never acts on the page itself: it emits
   tool calls, this module validates and executes them through the page bridge (window.tngApp) and feeds the JSON
   results back. Two backends:
     local  (default) WebLLM in the browser, JSON-object protocol {"tool","args"} | {"answer"}, one repair retry;
     claude (optional) POST <api>/api/chat, a stateless server proxy with fixed model/system/tools (server/chat.py).
   Nothing is fetched until the user asks (the model only on "Load local model"); history lives in memory only.
   Pure helpers are exported for the node tests (tests/js/chat_*.mjs); mount() is the only DOM entry point.
   MIT licence (see the repository LICENSE). */
import {isLowerLimit, limitLogN} from "./state.js";

export const WEBLLM_VERSION = "0.2.85";
/* Third-party code for the local model is pinned AND hash-checked (Subresource Integrity), in the page and in the worker:
   - WebLLM: the package's own prebuilt, self-contained ES module (lib/index.js, no imports), not jsDelivr's generated
     /+esm build, whose bytes are not guaranteed stable. importVerified() fetches it with `integrity` and imports the
     verified bytes from a blob: URL, so nothing unverified runs in the explorer origin.
   - the model library (WebAssembly) at a fixed commit of mlc-ai/binary-mlc-llm-libs, and the model files at a fixed
     Hugging Face revision; WebLLM itself checks the wasm, mlc-chat-config.json and tokenizer.json against these hashes.
   Bumping any version means recomputing the hashes (openssl dgst -sha384 -binary FILE | openssl base64 -A). */
export const WEBLLM_URL = `https://cdn.jsdelivr.net/npm/@mlc-ai/web-llm@${WEBLLM_VERSION}/lib/index.js`;
export const WEBLLM_SRI = "sha384-rfElDdXnNkSgbLTTGiKHTrsetCVAYzzLZBD96/rZdD9XYvryEyShqz3ph8j+x7HH";
export const WEBLLM_MODEL = "Qwen2.5-1.5B-Instruct-q4f16_1-MLC";
export const MODEL_HF_REV = "9bd564b064631febf14deadcac492efb761d60c3";
export const MODEL_LIB_COMMIT = "025bcaf3780fa8254f5e5efd3bfea0a5397248f4";
/* WebLLM ModelRecord for WEBLLM_MODEL: the prebuilt record of 0.2.85 with every URL pinned and hashed. */
export const MODEL_RECORD = Object.freeze({
  model: `https://huggingface.co/mlc-ai/${WEBLLM_MODEL}/resolve/${MODEL_HF_REV}/`,
  model_id: WEBLLM_MODEL,
  model_lib: `https://raw.githubusercontent.com/mlc-ai/binary-mlc-llm-libs/${MODEL_LIB_COMMIT}/web-llm-models/v0_2_84/base/Qwen2-1.5B-Instruct-q4f16_1_cs1k-webgpu.wasm`,
  low_resource_required: true, vram_required_MB: 1629.75, overrides: {context_window_size: 4096},
  integrity: {
    model_lib: "sha384-FBvWNtRNIYDNCzQgX2mqvP9zNj49hM0VsGivHw5Jl+LESLn5cnajYCei4ahrC3PI",
    config: "sha384-edTpAfxnd5O5jvlUbExraVs/Bmqwpni3s8wpFZMcNPSG+5O9sr1ltJJG9zQaM/Vb",
    tokenizer: {"tokenizer.json": "sha384-l5K5CpBtbywB5lTHysuesWqCadOP0PqIM5CaLYNPn2xpBA30Q5pAgRo4L1K2EjDM"},
    onFailure: "error"}});
/* Hosts the local model downloads from (shown to the user before anything is fetched). */
export const LOCAL_HOSTS = ["cdn.jsdelivr.net", "raw.githubusercontent.com", "huggingface.co"];

/* import() of a self-contained ES module whose bytes must match `integrity` (fetch rejects on a mismatch). */
export async function importVerified(url, integrity, {fetchImpl = (...a) => fetch(...a), importer = u => import(u)} = {}) {
  const r = await fetchImpl(url, {integrity, mode: "cors", credentials: "omit", cache: "force-cache"});
  if (!r.ok) throw new Error(`${new URL(url).host}: HTTP ${r.status}`);
  const blob = new Blob([await r.arrayBuffer()], {type: "text/javascript"}), u = URL.createObjectURL(blob);
  try { return await importer(u); } finally { URL.revokeObjectURL(u); }
}
export const MAX_TOOL_CALLS = 6;
export const LOCAL_CONTEXT = 10;          // messages after the system prompt
export const LOCAL_RESULT_MAX = 2000;     // chars of a TOOL_RESULT payload (local protocol)
export const RESULT_MAX = 4000;           // chars of a serialised tool result (Claude tool_result)
export const ANSWER_MAX = 2000;

/* Generated from tngsight/ions.json by `python -m server.make_chat_tools` (identical to server/chat_tools.json;
   tests/js/chat_tools_sync.mjs enforces deep equality). Do not edit between the markers. */
/*__GEN:TOOLS__*/
export const TOOLS = [{"name":"set_instrument","description":"Set the spectrograph and view. R: resolving power per band (one value, or two for the two R cases). snr: S/N per resolution element (one value, or two for the two S/N cases). layout: 1 case, 2 cases varying R, 2 cases varying S/N, or the 2x2 grid. ions: the ions to plot. vhw: half-width of the velocity window (km/s). vc: window centre (km/s). fit: overplot on-the-fly component fits.","input_schema":{"type":"object","additionalProperties":false,"properties":{"R":{"type":"object","additionalProperties":false,"properties":{"uv":{"anyOf":[{"type":"integer","minimum":5000,"maximum":150000},{"type":"array","items":{"type":"integer","minimum":5000,"maximum":150000},"minItems":2,"maxItems":2}]},"euv":{"anyOf":[{"type":"integer","minimum":5000,"maximum":150000},{"type":"array","items":{"type":"integer","minimum":5000,"maximum":150000},"minItems":2,"maxItems":2}]},"xray":{"anyOf":[{"type":"integer","minimum":100,"maximum":5000},{"type":"array","items":{"type":"integer","minimum":100,"maximum":5000},"minItems":2,"maxItems":2}]}}},"snr":{"anyOf":[{"type":"integer","minimum":2,"maximum":100},{"type":"array","items":{"type":"integer","minimum":2,"maximum":100},"minItems":2,"maxItems":2}]},"layout":{"type":"string","enum":["1","2R","2SN","4"]},"ions":{"type":"array","items":{"type":"string","enum":["HI","MgII","SiII","CII","SiIII","CIII","SiIV","CIV","NV","OVI","NeVIII","OVII"]},"minItems":1,"maxItems":12,"uniqueItems":true},"vhw":{"type":"integer","minimum":10,"maximum":1500},"vc":{"type":"number","minimum":-1500,"maximum":1500},"fit":{"type":"boolean"}}}},{"name":"select_sightline","description":"Show an existing sightline by id (as returned by search_sightlines or request_*).","input_schema":{"type":"object","additionalProperties":false,"required":["id"],"properties":{"id":{"type":"string","pattern":"^((face|edge|rand)_b\\d{3}_a\\d{3}(_s\\d+)?|cust_[0-9a-f]{10})$"}}}},{"name":"search_sightlines","description":"Find sightlines by their fitted Voigt components. Returns ranked ids with reasons. Saturated or degenerate components are lower limits on log N, never measurements: one meets logN_min when its lower limit does, and never meets a logN_max below the ion's ceiling (22.5 for HI, 19 otherwise). Reasons count them as lower limits.","input_schema":{"type":"object","additionalProperties":false,"required":["query"],"properties":{"query":{"type":"object","additionalProperties":false,"required":["ion"],"properties":{"ion":{"type":"string","enum":["HI","MgII","SiII","CII","SiIII","CIII","SiIV","CIV","NV","OVI","NeVIII","OVII"]},"n_min":{"type":"integer","minimum":0,"maximum":30},"n_max":{"type":"integer","minimum":0,"maximum":30},"sep_kms":{"type":"array","items":{"type":"number","minimum":0,"maximum":3000},"minItems":2,"maxItems":2},"logN_min":{"type":"number","minimum":10,"maximum":22.5},"logN_max":{"type":"number","minimum":10,"maximum":22.5},"b_min":{"type":"number","minimum":0,"maximum":150},"b_max":{"type":"number","minimum":0,"maximum":150},"b_kpc":{"type":"array","items":{"type":"number","minimum":0,"maximum":400},"minItems":2,"maxItems":2},"orientation":{"type":"string","enum":["face-on","edge-on","random","custom"]},"sort":{"type":"string","enum":["score","b_kpc","n"]},"limit":{"type":"integer","minimum":1,"maximum":200}}}}}},{"name":"request_sightline","description":"Load or generate the sightline with this orientation, impact parameter b (kpc) and azimuth (deg from the projected major axis). seed is required for random orientation.","input_schema":{"type":"object","additionalProperties":false,"required":["orientation","b_kpc","azimuth_deg"],"properties":{"orientation":{"type":"string","enum":["face-on","edge-on","random"]},"b_kpc":{"type":"number","minimum":0,"maximum":300},"azimuth_deg":{"type":"number","minimum":0,"maximum":360},"seed":{"type":"integer","minimum":0,"maximum":4294967295}}}},{"name":"request_custom_ray","description":"Generate a straight ray between two points given in kpc relative to the galaxy centre (simulation box axes). |p| <= 395 kpc, length 20-800 kpc.","input_schema":{"type":"object","additionalProperties":false,"required":["p0_kpc","p1_kpc"],"properties":{"p0_kpc":{"type":"array","items":{"type":"number","minimum":-395,"maximum":395},"minItems":3,"maxItems":3},"p1_kpc":{"type":"array","items":{"type":"number","minimum":-395,"maximum":395},"minItems":3,"maxItems":3}}}},{"name":"show_3d","description":"Open the 3D tab, optionally choosing the gas field and camera preset.","input_schema":{"type":"object","additionalProperties":false,"properties":{"species":{"type":"string","enum":["nH","T","Z","HI","MgII","SiII","CII","SiIII","CIII","SiIV","CIV","NV","OVI","NeVIII","OVII"]},"preset":{"type":"string","enum":["face-on","edge-on","sightline"]}}}}];
/*__END__*/
export const TOOL_NAMES = TOOLS.map(t => t.name);
const TOOL_BY_NAME = new Map(TOOLS.map(t => [t.name, t]));

/* Generated: the text of server/chat_system_prompt.txt (server/chat.py SYSTEM_PROMPT). */
/*__GEN:PROMPT__*/
export const SYSTEM_PROMPT = "You are the assistant of the TNG50 sightline explorer, a web page showing mock quasar absorption spectra of 12 ions (H I 1216, Mg II 2796, Si II 1260, C II 1335, Si III 1206, C III 977, Si IV 1403, C IV 1548, N V 1239, O VI 1032, Ne VIII 770, O VII 21.6) through the circumgalactic medium of one simulated Milky-Way-mass galaxy (TNG50-1 subhalo 488530, z = 0). Tool arguments name the ions by key: HI, MgII, SiII, CII, SiIII, CIII, SiIV, CIV, NV, OVI, NeVIII, OVII. Ne VIII 770 is in the EUV band (rest-frame EUV, observable only as a redshifted analogue). You act only by calling the provided tools; the page executes them and returns JSON results. Every number, id or property you state must come from a tool result in this conversation or from the user; if the tools cannot answer, say so. Never invent sightline ids. Prefer search_sightlines to find sightlines, select_sightline to show one, set_instrument to set the resolving power R per band (UV 5000 to 150000, EUV 5000 to 150000, X-ray 100 to 5000), the S/N per resolution element (2 to 100), the layout, the ions shown and the velocity window, show_3d for the gas distribution, and request_sightline or request_custom_ray only when the user asks for a new sightline (generation takes one to two minutes and the page opens it when ready). Velocities are km/s relative to the galaxy's systemic velocity; column densities are log10 cm^-2; distances are kpc. A fitted component given as logN_lower (saturated, or degenerate with no errors) is a lower limit: say log N > that value, never quote it as a measured column. Keep answers short.";
/*__END__*/

const ID_SRC = "(?:face|edge|rand)_b\\d{3}_a\\d{3}(?:_s\\d+)?|cust_[0-9a-f]{10}";
export const ID_RE = new RegExp(`^(${ID_SRC})$`);

/* §2 number formatting: round half away from zero, exactly d decimals. */
export function fmt(x, d) {
  const p = 10 ** d, v = Math.sign(x) * Math.floor(Math.abs(x) * p + 0.5) / p;
  return (Object.is(v, -0) ? 0 : v).toFixed(d);
}

/* ------------------------------------------------------------------ JSON-schema subset validator
   Keywords: type, enum, minimum, maximum, multipleOf, pattern, required, additionalProperties:false, properties,
   items, minItems, maxItems, anyOf. Returns null when valid, else "<path>: <reason>". */
const isObj = v => v !== null && typeof v === "object" && !Array.isArray(v);
const RX = new Map();
const show = v => { const s = typeof v === "number" && !Number.isFinite(v) ? String(v) : JSON.stringify(v); return s === undefined ? String(v) : s.length > 40 ? s.slice(0, 37) + "…" : s; };
const TYPE_OK = {
  object: isObj, array: Array.isArray, string: v => typeof v === "string", boolean: v => typeof v === "boolean",
  number: v => typeof v === "number" && Number.isFinite(v), integer: v => typeof v === "number" && Number.isInteger(v),
  null: v => v === null,
};

export function validate(schema, v, path = "args") {
  if (schema.anyOf) {
    const errs = [];
    for (const s of schema.anyOf) { const e = validate(s, v, path); if (!e) return null; errs.push(e); }
    return errs.length === 1 ? errs[0] : `${path}: matches none of the allowed forms (${errs.map(e => e.slice(e.indexOf(": ") + 2)).join("; ")})`;
  }
  if (schema.type && !TYPE_OK[schema.type](v)) return `${path}: expected ${schema.type}, got ${show(v)}`;
  if (schema.enum && !schema.enum.includes(v)) return `${path}: must be one of ${schema.enum.map(show).join(", ")}`;
  if (typeof v === "number") {
    if (schema.minimum != null && v < schema.minimum) return `${path}: must be >= ${schema.minimum}`;
    if (schema.maximum != null && v > schema.maximum) return `${path}: must be <= ${schema.maximum}`;
    if (schema.multipleOf != null && Math.abs(v / schema.multipleOf - Math.round(v / schema.multipleOf)) > 1e-9)
      return `${path}: must be a multiple of ${schema.multipleOf}`;
  }
  if (typeof v === "string" && schema.pattern) {
    let rx = RX.get(schema.pattern); if (!rx) RX.set(schema.pattern, rx = new RegExp(schema.pattern));
    if (!rx.test(v)) return `${path}: ${show(v)} does not match the required pattern`;
  }
  if (Array.isArray(v)) {
    if (schema.minItems != null && v.length < schema.minItems) return `${path}: needs at least ${schema.minItems} items`;
    if (schema.maxItems != null && v.length > schema.maxItems) return `${path}: allows at most ${schema.maxItems} items`;
    if (schema.items) for (let i = 0; i < v.length; i++) { const e = validate(schema.items, v[i], `${path}[${i}]`); if (e) return e; }
  }
  if (isObj(v)) {
    const props = schema.properties || {};
    for (const k of schema.required || []) if (!Object.hasOwn(v, k)) return `${path}: missing required "${k}"`;
    if (schema.additionalProperties === false) for (const k of Object.keys(v)) if (!Object.hasOwn(props, k)) return `${path}: unknown key "${k}"`;
    for (const [k, s] of Object.entries(props)) if (Object.hasOwn(v, k)) { const e = validate(s, v[k], `${path}.${k}`); if (e) return e; }
  }
  return null;
}

/* null if `name` is a known tool and `args` valid, else "invalid arguments: …" / "unknown tool …". */
export function validateToolCall(name, args) {
  const t = TOOL_BY_NAME.get(name);
  if (!t) return `unknown tool ${show(name)}`;
  const e = validate(t.input_schema, args, "args");
  return e ? `invalid arguments: ${e}` : null;
}

/* ------------------------------------------------------------------ local JSON protocol */
/* Strip code fences, return the first balanced {...} (string- and escape-aware), or null. */
export function extractJsonObject(text) {
  const s = String(text).replace(/```[A-Za-z0-9_-]*[ \t]*\r?\n?/g, "");
  const i = s.indexOf("{"); if (i < 0) return null;
  let depth = 0, inStr = false, escp = false;
  for (let j = i; j < s.length; j++) {
    const c = s[j];
    if (inStr) { if (escp) escp = false; else if (c === "\\") escp = true; else if (c === '"') inStr = false; continue; }
    if (c === '"') inStr = true; else if (c === "{") depth++; else if (c === "}" && --depth === 0) return s.slice(i, j + 1);
  }
  return null;
}

/* -> {ok:true, type:"tool", tool, args} | {ok:true, type:"answer", answer} | {ok:false, error} */
export function parseReply(text) {
  if (typeof text !== "string" || !text.trim()) return {ok: false, error: "empty reply"};
  const js = extractJsonObject(text);
  if (js == null) return {ok: false, error: "no JSON object found"};
  let o; try { o = JSON.parse(js); } catch (e) { return {ok: false, error: `invalid JSON (${String(e.message).slice(0, 80)})`}; }
  if (!isObj(o)) return {ok: false, error: "the reply must be a JSON object"};
  const keys = Object.keys(o);
  if (Object.hasOwn(o, "tool")) {
    const extra = keys.filter(k => k !== "tool" && k !== "args");
    if (extra.length) return {ok: false, error: `unexpected key "${extra[0]}"`};
    if (typeof o.tool !== "string") return {ok: false, error: '"tool" must be a string'};
    const args = Object.hasOwn(o, "args") ? o.args : {};
    if (!isObj(args)) return {ok: false, error: '"args" must be an object'};
    const e = validateToolCall(o.tool, args);
    return e ? {ok: false, error: e} : {ok: true, type: "tool", tool: o.tool, args};
  }
  if (Object.hasOwn(o, "answer")) {
    const extra = keys.filter(k => k !== "answer");
    if (extra.length) return {ok: false, error: `unexpected key "${extra[0]}"`};
    if (typeof o.answer !== "string" || !o.answer.trim()) return {ok: false, error: '"answer" must be a non-empty string'};
    if (o.answer.length > ANSWER_MAX) return {ok: false, error: `"answer" exceeds ${ANSWER_MAX} characters`};
    return {ok: true, type: "answer", answer: o.answer};
  }
  return {ok: false, error: 'expected a "tool" or an "answer" key'};
}

export function repairMessage(error) {
  return `Your last reply was invalid (${error}). Reply with ONLY one JSON object of the form {"tool":...,"args":{...}} or {"answer":"..."}.`;
}

/* Compact, human-readable signature of a schema for the local model's prompt. */
export function schemaSig(s) {
  if (s.anyOf) return s.anyOf.map(schemaSig).join(" or ");
  if (s.enum) return s.enum.map(v => JSON.stringify(v)).join("|");
  if (s.type === "object") {
    const req = new Set(s.required || []);
    return "{" + Object.entries(s.properties || {}).map(([k, v]) => `${k}${req.has(k) ? "" : "?"}: ${schemaSig(v)}`).join(", ") + "}";
  }
  if (s.type === "array") {
    const n = s.minItems === s.maxItems && s.minItems != null ? `${s.minItems} × ` : "";
    return `[${n}${schemaSig(s.items || {})}]`;
  }
  let t = s.type === "integer" ? "int" : s.type || "any";
  if (s.minimum != null || s.maximum != null) t += ` ${s.minimum ?? ""}..${s.maximum ?? ""}`;
  if (s.multipleOf != null) t += ` step ${s.multipleOf}`;
  if (s.pattern) t += ` matching ${s.pattern}`;
  return t;
}

export function localSystemPrompt() {
  return SYSTEM_PROMPT + "\n\nReply with exactly one JSON object and nothing else: {\"tool\":\"<name>\",\"args\":{...}} to call a tool, " +
    "or {\"answer\":\"<text>\"} for your final answer to the user. After each tool call you receive a message " +
    "TOOL_RESULT <name>: <json>. Use at most " + MAX_TOOL_CALLS + " tool calls per question. Fields marked ? are optional.\n\nTools:\n" +
    TOOLS.map(t => `- ${t.name}: ${t.description}\n  args: ${schemaSig(t.input_schema)}`).join("\n");
}

/* JSON of `obj` in at most `max` chars: drops the tail of the longest list first (marks "truncated":true). */
export function capJson(obj, max) {
  let s = JSON.stringify(obj); if (s.length <= max) return s;
  const o = JSON.parse(s);
  const lists = (x, out = []) => { if (Array.isArray(x)) { out.push(x); x.forEach(y => lists(y, out)); } else if (isObj(x)) Object.values(x).forEach(y => lists(y, out)); return out; };
  if (isObj(o)) o.truncated = true;
  for (let guard = 0; guard < 10000; guard++) {
    s = JSON.stringify(o); if (s.length <= max) return s;
    const ls = lists(o).filter(a => a.length); if (!ls.length) break;
    ls.sort((a, b) => JSON.stringify(b).length - JSON.stringify(a).length)[0].pop();
  }
  return JSON.stringify({ok: isObj(obj) ? obj.ok ?? true : true, truncated: true, error: "result too large"}).slice(0, max);
}

export function toolResultMessage(name, result) { return `TOOL_RESULT ${name}: ${capJson(result, LOCAL_RESULT_MAX)}`; }

/* ------------------------------------------------------------------ grounding check
   Every number with >= 2 significant digits in the answer must appear (as §2 fmt at 0-3 decimals, sign-insensitive)
   in this turn's tool results, the user's message or FIXED_FACTS (line wavelengths and the subhalo id the system
   prompt states). Sightline ids that the page does not know are reported too. Never blocks the answer; the UI shows an "unverified: …" badge. */
const ANS_NUM = /(?<![\w.])[-+]?(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?(?![\w])/g;
const SRC_NUM = /[-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?/g;
const ID_ANY = new RegExp(ID_SRC, "g");
export const FIXED_FACTS = "1031.912 1032 1025.722 1026 977.020 977 488530";
const norm = s => s.replace(/[−‒–]/g, "-").replace(/[  ]/g, " ");

export function groundedSet(sources) {
  const set = new Set();
  for (const src of sources) for (const m of norm(String(src)).match(SRC_NUM) || []) {
    const v = parseFloat(m); if (!Number.isFinite(v)) continue;
    for (let d = 0; d <= 3; d++) { set.add(fmt(v, d)); set.add(fmt(Math.abs(v), d)); }
  }
  return set;
}

export function groundingCheck(answer, sources, knownId = null) {
  const out = [], text = norm(String(answer || "")), set = groundedSet([...sources, FIXED_FACTS]);
  for (const id of text.match(ID_ANY) || []) if (knownId && !knownId(id) && !sources.some(s => String(s).includes(id))) out.push(id);
  const stripped = text.replace(ID_ANY, " ");
  for (const raw of stripped.match(ANS_NUM) || []) {
    const t = raw.replace(/,/g, "").replace(/^\+/, ""), digits = t.replace(/^-/, "").replace(".", "").replace(/^0+/, "");
    if (digits.length < 2) continue;
    const abs = t.replace(/^-/, "");
    if (!set.has(t) && !set.has(abs) && !out.includes(raw)) out.push(raw);
  }
  return out;
}

/* ------------------------------------------------------------------ tool execution (page bridge) */
/*__GEN:IONS__*/
const ION_KEYS = ["HI","MgII","SiII","CII","SiIII","CIII","SiIV","CIV","NV","OVI","NeVIII","OVII"];
/*__END__*/
const pick = (o, ks) => Object.fromEntries(ks.filter(k => o[k] !== undefined).map(k => [k, o[k]]));
const errMsg = e => String(e && e.message || e || "error").slice(0, 300);

export function chipLabel(name, args) {
  const parts = [];
  const walk = (o, pre) => { for (const [k, v] of Object.entries(o || {})) {
    if (isObj(v)) walk(v, ""); else parts.push(`${pre}${k}=${Array.isArray(v) ? v.join(",") : v}`); } };
  walk(args, "");
  const s = [name, ...parts].join(" ");
  return s.length > 90 ? s.slice(0, 89) + "…" : s;
}

/* `app` = window.tngApp (§7.1). `opts.loadSearch()` -> search.js module (default: dynamic import). */
export function createToolExecutor(app, opts = {}) {
  const loadSearch = opts.loadSearch || (() => import("./search.js"));
  const submitted = opts.onSubmitted || (() => {});
  const H = {
    async set_instrument(a) {
      /* the v3 arguments go straight to tngApp.setInstrument v3 (design 6.5); the schema check ignores uniqueItems, so
         the ions are deduplicated here. A RangeError from the bridge becomes {ok: false, error} via the caller. */
      const st = {};
      for (const k of ["R", "snr", "layout", "vhw", "vc", "fit"]) if (a[k] !== undefined) st[k] = a[k];
      if (Array.isArray(a.ions)) st.ions = [...new Set(a.ions)];
      const s = await app.setInstrument(st);
      return {ok: true, ...pick(s || {}, ["ions", "layout", "R", "sn", "vc", "vhw", "fit"])};
    },
    async select_sightline(a) {
      const e = app.entry(a.id);
      if (!e) return {ok: false, error: "unknown sightline id"};
      const okSel = await app.select(a.id, {source: "chat"});
      if (okSel === false) return {ok: false, error: "unknown sightline id"};
      let comps = null;
      try {
        const c = app.components ? await app.components(a.id) : null;
        /* C2 (owner decision 2): a saturated or degenerate component goes out as logN_lower (its lower limit, the page's
           min of the fit and its region's AOD share, state.js annotateLimits), never as logN */
        if (c) comps = Object.fromEntries(ION_KEYS.map(k => [k, (c[k] || []).slice(0, 8).map(x => isLowerLimit(x)
          ? {v: x.v, logN_lower: +fmt(limitLogN(x), 2), b: x.b, flag: x.flag} : pick(x, ["v", "logN", "b", "flag"]))]));
      } catch { comps = null; }
      return {ok: true, id: e.id, orientation: e.orientation, b_kpc: e.b_kpc, azimuth_deg: e.azimuth_deg,
        v_sys: e.v_sys != null ? +fmt(+e.v_sys, 2) : null,
        logN: Object.fromEntries(ION_KEYS.filter(k => e.logN && Number.isFinite(+e.logN[k])).map(k => [k, +fmt(+e.logN[k], 2)])),
        components: comps};
    },
    async search_sightlines(a) {
      const mod = await loadSearch();
      const q = a.query, bad = mod.validateQuery(q);
      if (bad && bad.error) return {ok: false, error: bad.error};
      const idx = await app.componentsIndex();
      const res = mod.runQuery(q, app.entries(), (idx && idx.entries) || {});
      if (!Array.isArray(res)) return {ok: false, error: (res && res.error) || "search failed"};
      return {ok: true, n_total: res.length,
        results: res.slice(0, 10).map(r => ({id: r.id, score: r.score, n: r.n, b_kpc: r.b_kpc, orientation: r.orientation, reason: r.reason}))};
    },
    async request_sightline(a) {
      return submitResult(await app.submitGeometry(pick(a, ["orientation", "b_kpc", "azimuth_deg", "seed"])), "geometry");
    },
    async request_custom_ray(a) {
      return submitResult(await app.submitCustom({p0_kpc: a.p0_kpc, p1_kpc: a.p1_kpc}), "custom");
    },
    async show_3d(a) {
      const r = await app.show3d(pick(a, ["species", "preset"]));
      if (!r || !r.ok) return {ok: false, error: (r && r.message) || "the 3D view is not available"};
      return {ok: true, species: r.species, preset: r.preset, webgl2: !!r.webgl2};
    },
  };
  async function submitResult(r, kind) {
    if (!r || r.status === "error") return {ok: false, error: (r && r.message) || "the sightline server is not available"};
    if (r.status === "ready") {
      if (r.id) await app.select(r.id, {source: "chat"});
      return {ok: true, status: "ready", id: r.id, note: "already computed; now shown on the page"};
    }
    submitted({job_id: r.job_id, id: r.id, kind});
    return {ok: true, status: "queued", id: r.id, job_id: r.job_id,
      note: `generation started${r.position ? ` (queue position ${r.position})` : ""}; it takes about a minute and the page opens it when ready`};
  }
  return async function exec(name, args) {
    const bad = validateToolCall(name, args);
    if (bad) return {ok: false, error: bad};
    try { return await H[name](args); } catch (e) { return {ok: false, error: errMsg(e)}; }
  };
}

/* ------------------------------------------------------------------ turn loops
   Both return {answer: string|null, calls: [{name, args, result}], unverified: string[], error?, note?}.
   `state.messages` is the backend's history (append-only); `onEvent({type, ...})` drives the UI. */
function finish(answer, calls, sources, knownId, extra = {}) {
  return {answer, calls, unverified: answer ? groundingCheck(answer, sources, knownId) : [], ...extra};
}

export async function runLocalTurn({generate, state, userText, exec, onEvent = () => {}, knownId = null}) {
  const calls = [], sources = [userText];
  state.messages.push({role: "user", content: userText});
  let repaired = false;
  for (let step = 0; step < MAX_TOOL_CALLS + 2; step++) {
    let text;
    try { text = await generate([{role: "system", content: localSystemPrompt()}, ...state.messages.slice(-LOCAL_CONTEXT)]); }
    catch (e) { return finish(null, calls, sources, knownId, {error: `local model error: ${errMsg(e)}`}); }
    const p = parseReply(text);
    if (!p.ok) {
      state.messages.push({role: "assistant", content: String(text ?? "").slice(0, ANSWER_MAX)});
      if (repaired) return finish(null, calls, sources, knownId, {error: `The local model replied in an invalid format twice (${p.error}). Try rephrasing, or use the Claude backend.`});
      repaired = true; onEvent({type: "repair", error: p.error});
      state.messages.push({role: "user", content: repairMessage(p.error)});
      continue;
    }
    if (p.type === "answer") {
      state.messages.push({role: "assistant", content: JSON.stringify({answer: p.answer})});
      return finish(p.answer, calls, sources, knownId);
    }
    state.messages.push({role: "assistant", content: JSON.stringify({tool: p.tool, args: p.args})});
    if (calls.length >= MAX_TOOL_CALLS)
      return finish(null, calls, sources, knownId, {error: `Stopped after ${MAX_TOOL_CALLS} tool calls without an answer.`});
    onEvent({type: "tool", name: p.tool, args: p.args});
    const result = await exec(p.tool, p.args);
    calls.push({name: p.tool, args: p.args, result}); onEvent({type: "result", name: p.tool, args: p.args, result});
    const msg = toolResultMessage(p.tool, result); sources.push(msg);
    state.messages.push({role: "user", content: msg});
  }
  return finish(null, calls, sources, knownId, {error: "Stopped: the local model did not produce an answer."});
}

export async function runClaudeTurn({post, state, userText, exec, onEvent = () => {}, knownId = null}) {
  const calls = [], sources = [userText], start = state.messages.length;
  state.messages.push({role: "user", content: userText});
  const closeOpen = (uses, why) => { if (uses.length) state.messages.push({role: "user", content: uses.map(b => (
    {type: "tool_result", tool_use_id: b.id, content: JSON.stringify({ok: false, error: why}), is_error: true}))}); };
  for (let req = 0; req < MAX_TOOL_CALLS + 2; req++) {
    let r;
    try { r = await post({messages: state.messages}); }
    catch (e) {
      if (req === 0) state.messages.length = start;      // nothing happened: let the user simply retry
      return finish(null, calls, sources, knownId, {error: errMsg(e)});
    }
    const content = Array.isArray(r && r.content) ? r.content : [];
    state.messages.push({role: "assistant", content: r.content});      // verbatim, never edited
    const uses = content.filter(b => b && b.type === "tool_use");
    const text = content.filter(b => b && b.type === "text").map(b => b.text).join("\n").trim() || null;
    if (r.stop_reason === "refusal") { closeOpen(uses, "refused"); return finish(null, calls, sources, knownId, {error: "The model declined this request."}); }
    if (r.stop_reason === "max_tokens") { closeOpen(uses, "reply was cut off"); return finish(text, calls, sources, knownId, {note: "The reply was cut off at the length limit."}); }
    if (!uses.length) return finish(text, calls, sources, knownId);
    if (text) onEvent({type: "text", text});
    const results = [];
    for (const b of uses) {
      let result;
      if (calls.length >= MAX_TOOL_CALLS) result = {ok: false, error: `tool-call limit (${MAX_TOOL_CALLS} per question) reached; answer with the results you have`};
      else {
        onEvent({type: "tool", name: b.name, args: b.input});
        result = await exec(b.name, b.input);
        calls.push({name: b.name, args: b.input, result}); onEvent({type: "result", name: b.name, args: b.input, result});
      }
      const s = capJson(result, RESULT_MAX); sources.push(s);
      results.push({type: "tool_result", tool_use_id: b.id, content: s, ...(result.ok === false ? {is_error: true} : {})});
    }
    state.messages.push({role: "user", content: results});        // ALL results in ONE user message
  }
  return finish(null, calls, sources, knownId, {error: "Stopped: too many model requests for one question."});
}

/* ------------------------------------------------------------------ backends */
export function createClaudePost(apiBase, fetchImpl = (...a) => fetch(...a)) {
  return async function post(body) {
    let r;
    try { r = await fetchImpl(`${apiBase}/api/chat`, {method: "POST", headers: {"Content-Type": "application/json"}, body: JSON.stringify(body)}); }
    catch { throw new Error("Could not reach the sightline server."); }
    const j = await r.json().catch(() => ({}));
    if (r.ok) return j;
    const d = typeof j.detail === "string" ? j.detail : `HTTP ${r.status}`, ra = +(r.headers.get("Retry-After") || 0);
    const wait = ra ? ` Try again in ${ra < 120 ? ra + " s" : Math.ceil(ra / 60) + " min"}.` : "";
    if (r.status === 404) throw new Error("Claude chat is disabled on this server.");
    if (r.status === 429) throw new Error(`${d === "daily chat budget exhausted" ? "The daily chat budget is used up." : "Chat rate limit reached."}${wait}`);
    if (r.status === 503 || r.status === 504) throw new Error(`The model service is busy or slow.${wait}`);
    throw new Error(`Chat request failed: ${d}`);
  };
}

/* WebGPU + shader-f16 are required for the q4f16 model. -> {ok, reason?} */
export async function webgpuStatus(nav = globalThis.navigator) {
  if (!nav || !nav.gpu) return {ok: false, reason: "This browser does not provide WebGPU, which the local model needs."};
  let ad = null; try { ad = await nav.gpu.requestAdapter(); } catch { ad = null; }
  if (!ad) return {ok: false, reason: "WebGPU is present but no GPU adapter is available."};
  if (!ad.features || !ad.features.has("shader-f16")) return {ok: false, reason: "This GPU does not support 16-bit float shaders (shader-f16), which the local model needs."};
  return {ok: true};
}

/* Loads WebLLM (pinned, hash-checked) and the model in a module worker; returns generate(messages) -> text.
   There is no main-thread engine fallback: a browser without module workers gets an error, not unverified code. */
export const APP_CONFIG = Object.freeze({model_list: [MODEL_RECORD]});
export async function createLocalGenerate(onProgress = () => {}, importer = (url, sri) => importVerified(url, sri)) {
  const webllm = await importer(WEBLLM_URL, WEBLLM_SRI);
  const cfg = {initProgressCallback: r => onProgress(r), appConfig: APP_CONFIG};
  const w = new Worker(new URL("./chat_worker.js", import.meta.url), {type: "module"});
  const failed = new Promise((_, rej) => w.addEventListener("error", ev => { ev.preventDefault?.();
    rej(new Error(`the model worker failed to start${ev.message ? " (" + ev.message + ")" : ""}`)); }, {once: true}));
  let engine;
  try { engine = await Promise.race([webllm.CreateWebWorkerMLCEngine(w, WEBLLM_MODEL, cfg), failed]); }
  catch (e) { w.terminate(); throw e; }
  return async messages => {
    const r = await engine.chat.completions.create({messages, temperature: 0, top_p: 1, seed: 0, max_tokens: 384,
      response_format: {type: "json_object"}});
    return r.choices[0].message.content;
  };
}

/* Consent text for the Claude backend, worded by who runs the server. `defaults` = this build's configured
   sightline servers (app.config.backends); anything else came from ?api= or a stored override. */
const normApi = u => String(u || "").trim().replace(/\/+$/, "");
const hostOf = u => { try { return new URL(u).host; } catch { return String(u || "?"); } };
export function isOverrideApi(api, defaults = []) { return !!api && !defaults.map(normApi).includes(normApi(api)); }
export function claudeNote(api, defaults = []) {
  if (isOverrideApi(api, defaults))
    return `Using Claude via ${hostOf(api)}, an override server that this site does not operate: your messages and the tool results ` +
      "are sent to that server, which can read and keep them, and which decides where they go next.";
  return `Using Claude via this site's sightline server (${hostOf(api)}): your messages and the tool results are sent through it to ` +
    "Anthropic. The server does not log the message text; it logs request metadata (a hashed IP address, sizes, token counts).";
}
export function claudeOptionLabel(api, defaults = []) { return isOverrideApi(api, defaults) ? `Claude (via ${hostOf(api)}, override)` : "Claude (server)"; }

/* ------------------------------------------------------------------ UI */
const STYLE = `
.chat-drawer{position:fixed;top:0;right:0;bottom:0;width:380px;max-width:100vw;z-index:60;display:flex;flex-direction:column;background:var(--panel);color:var(--ink);border-left:1px solid var(--rule);box-shadow:-8px 0 24px rgba(0,0,0,.18);font:14px/1.45 var(--body)}
.chat-head{display:flex;align-items:center;gap:8px;padding:10px 12px;border-bottom:1px solid var(--rule)}
.chat-head h2{flex:1;margin:0;font:600 16px var(--display)}
.chat-ctl{display:flex;flex-wrap:wrap;gap:6px 10px;align-items:center;padding:8px 12px;border-bottom:1px solid var(--rule);font-size:13px}
.chat-ctl label{color:var(--ink2)}
.chat-ctl select{font:13px var(--body);color:var(--ink);background:var(--panel);border:1px solid var(--rule);border-radius:6px;padding:3px 6px}
.chat-load{padding:8px 12px;border-bottom:1px solid var(--rule);font-size:13px;color:var(--ink2)}
.chat-load progress{width:100%;margin-top:6px}
.chat-log{flex:1;overflow-y:auto;padding:10px 12px;display:flex;flex-direction:column;gap:8px}
.chat-msg{padding:7px 10px;border-radius:8px;max-width:92%;white-space:pre-wrap;overflow-wrap:anywhere}
.chat-user{align-self:flex-end;background:var(--accent);color:var(--accent-ink)}
.chat-bot{align-self:flex-start;background:var(--bg);border:1px solid var(--rule)}
.chat-err{align-self:flex-start;color:var(--bad);border:1px solid var(--bad);background:transparent}
.chat-note{align-self:flex-start;color:var(--ink2);font-size:12.5px}
.chat-tool{align-self:stretch;font:12px var(--mono);color:var(--ink2);min-width:0}
.chat-tool summary{cursor:pointer;list-style:none;border:1px solid var(--rule);border-radius:999px;padding:2px 9px;display:block;width:fit-content;max-width:100%;box-sizing:border-box;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.chat-tool summary::-webkit-details-marker{display:none}
.chat-tool summary::before{content:"\\25B8 "}.chat-tool[open] summary::before{content:"\\25BE "}
.chat-tool.bad summary{border-color:var(--bad);color:var(--bad)}
.chat-tool pre{margin:4px 0 0;padding:6px 8px;background:var(--bg);border:1px solid var(--rule);border-radius:6px;white-space:pre-wrap;overflow-wrap:anywhere;max-height:180px;overflow:auto}
.chat-idbtn{font:12.5px var(--mono);padding:0 5px;border:1px solid var(--accent);border-radius:4px;background:transparent;color:var(--accent);cursor:pointer}
.chat-badge{display:block;margin-top:5px;font-size:12px;color:var(--warn)}
.chat-form{display:flex;gap:6px;padding:8px 12px;border-top:1px solid var(--rule)}
.chat-form textarea{flex:1;resize:none;min-height:40px;max-height:120px;font:14px var(--body);color:var(--ink);background:var(--bg);border:1px solid var(--rule);border-radius:6px;padding:6px 8px}
.chat-disc{margin:0;padding:0 12px 10px;font-size:11.5px;color:var(--muted)}
@media (max-width:720px){.chat-drawer{top:auto;left:0;width:auto;height:min(78vh,620px);border-left:0;border-top:1px solid var(--rule);border-radius:12px 12px 0 0;box-shadow:0 -8px 24px rgba(0,0,0,.2)}}
`;

function el(tag, props = {}, ...kids) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === "class") e.className = v; else if (k === "text") e.textContent = v;
    else if (k.startsWith("on")) e.addEventListener(k.slice(2), v); else if (v === true) e.setAttribute(k, ""); else if (v !== false && v != null) e.setAttribute(k, v);
  }
  for (const c of kids) if (c != null) e.append(c);
  return e;
}

/* Text with sightline ids as buttons (textContent only, never innerHTML). */
export function renderAnswer(node, text, app) {
  const s = String(text); let last = 0;
  for (const m of s.matchAll(ID_ANY)) {
    if (m.index > last) node.append(document.createTextNode(s.slice(last, m.index)));
    const id = m[0];
    if (app.entry && app.entry(id)) node.append(el("button", {type: "button", class: "chat-idbtn", title: `show ${id}`,
      onclick: () => app.select(id, {source: "chat"})}, id));
    else node.append(document.createTextNode(id));
    last = m.index + id.length;
  }
  if (last < s.length) node.append(document.createTextNode(s.slice(last)));
  return node;
}

/* mount(root, app, opts) -> {open(), close(), destroy()}.  `app` = window.tngApp. Opens immediately unless
   opts.open === false. opts: {opener, fetch, loadSearch, generateFactory, webgpu} (the last ones for tests). */
export async function mount(root, app, opts = {}) {
  if (!document.getElementById("chat-style")) document.head.append(el("style", {id: "chat-style"}, STYLE));
  const fetchImpl = opts.fetch || ((...a) => fetch(...a));
  const myJobs = new Set();
  const exec = createToolExecutor(app, {loadSearch: opts.loadSearch, onSubmitted: j => j.job_id && myJobs.add(j.job_id)});
  const knownId = id => !!(app.entry && app.entry(id));
  let backend = "local", generate = null, busy = false, opener = opts.opener || null, claudeOk = false;
  const hist = {messages: []};

  const sel = el("select", {id: "chat-backend"}, el("option", {value: "local"}, "Local (in-browser)"));
  const log = el("div", {class: "chat-log", role: "log", "aria-live": "polite", "aria-relevant": "additions"});
  const prog = el("progress", {max: "1", value: "0", hidden: true});
  const progText = el("div", {"aria-live": "polite"});
  const loadBtn = el("button", {type: "button", class: "btn primary"}, "Load local model (~1 GB download, cached by the browser)");
  const load = el("div", {class: "chat-load"}, loadBtn,
    el("div", {text: "Runs entirely in your browser with WebGPU; needs about 2 GB of GPU memory. Nothing is downloaded until you click. " +
      "Your questions stay in the browser. The download comes from " + LOCAL_HOSTS.join(", ") + " (WebLLM, the model library and the " +
      "Qwen2.5-1.5B-Instruct weights), each pinned to a fixed version and hash-checked where the files are code."}), prog, progText);
  const ta = el("textarea", {id: "chat-input", rows: "2", placeholder: "e.g. find edge-on sightlines with two O VI components 50–150 km/s apart"});
  const send = el("button", {type: "submit", class: "btn primary"}, "Send");
  const form = el("form", {class: "chat-form"}, el("label", {for: "chat-input", class: "sr-only", style: "position:absolute;left:-9999px"}, "Question"), ta, send);
  const closeBtn = el("button", {type: "button", class: "btn", "aria-label": "Close chat"}, "✕");
  const clearBtn = el("button", {type: "button", class: "btn"}, "Clear");
  const drawer = el("div", {class: "chat-drawer", role: "dialog", "aria-modal": "true", "aria-label": "Ask about the sightlines", tabindex: "-1"},
    el("div", {class: "chat-head"}, el("h2", {text: "Ask about the sightlines"}), clearBtn, closeBtn),
    el("div", {class: "chat-ctl"}, el("label", {for: "chat-backend"}, "Model"), sel),
    load, log, form,
    el("p", {class: "chat-disc", text: "Answers come from the page's own tools (search, selection, instrument, 3D). The local model is small and can be wrong; numbers not found in the tool results are marked unverified."}));
  root.replaceChildren(drawer);

  const add = (cls, text) => { const n = el("div", {class: "chat-msg " + cls}); if (text != null) n.textContent = text; log.append(n); log.scrollTop = log.scrollHeight; return n; };
  const toolNode = (name, args) => { const pre = el("pre"); const d = el("details", {class: "chat-tool"}, el("summary", {text: chipLabel(name, args)}), pre);
    log.append(d); log.scrollTop = log.scrollHeight; return {d, pre}; };
  const pending = [];
  const onEvent = ev => {
    if (ev.type === "tool") pending.push(toolNode(ev.name, ev.args));
    else if (ev.type === "result") { const t = pending.shift(); if (t) { t.pre.textContent = JSON.stringify(ev.result, null, 1); if (ev.result && ev.result.ok === false) t.d.classList.add("bad"); } }
    else if (ev.type === "repair") add("chat-note", "The model's reply was not valid JSON; asking it once to correct itself…");
    else if (ev.type === "text") renderAnswer(add("chat-bot"), ev.text, app);
  };
  function refresh() {
    load.hidden = backend !== "local" || !!generate;
    const ready = backend === "claude" ? claudeOk : !!generate;
    ta.disabled = send.disabled = busy || !ready;
    send.textContent = busy ? "…" : "Send";
  }
  const defaults = () => { try { return (app.config && app.config.backends) || []; } catch { return []; } };
  let claudeApi = null;          // the server the Claude backend was consented to; a different one needs a new note
  async function checkClaude() {
    let api = null; try { api = app.getState().api; } catch { api = null; }
    claudeOk = false;
    if (api) try { const r = await fetchImpl(api + "/api/health", {cache: "no-store"}); if (r.ok) { const h = await r.json(); claudeOk = !!(h.chat && h.chat.claude === true); } } catch { claudeOk = false; }
    let opt = sel.querySelector('option[value="claude"]');
    if (claudeOk && !opt) sel.append(opt = el("option", {value: "claude"}));
    if (claudeOk) opt.textContent = claudeOptionLabel(api, defaults());
    if (!claudeOk && opt) { opt.remove(); if (backend === "claude") { backend = "local"; sel.value = "local"; claudeApi = null; add("chat-note", "The Claude backend is no longer available; switched to the local model."); } }
    if (claudeOk && backend === "claude" && normApi(api) !== normApi(claudeApi)) {      // the server changed under us: say so before anything is sent
      claudeApi = api; hist.messages = []; add("chat-note", "The sightline server changed. " + claudeNote(api, defaults()));
    }
    refresh(); return claudeOk ? api : null;
  }
  sel.addEventListener("change", () => {
    if (busy) { sel.value = backend; return; }
    backend = sel.value; hist.messages = []; log.replaceChildren();
    let api = null; try { api = app.getState().api; } catch { api = null; }
    claudeApi = backend === "claude" ? api : null;
    add("chat-note", backend === "claude" ? claudeNote(api, defaults()) : "Using the local in-browser model.");
    refresh();
  });
  loadBtn.addEventListener("click", async () => {
    loadBtn.disabled = true; progText.textContent = "Checking WebGPU…";
    const st = await (opts.webgpu || webgpuStatus)();
    if (!st.ok) { progText.textContent = st.reason + (claudeOk ? " You can switch the model to Claude (server)." : ""); loadBtn.disabled = false; return; }
    prog.hidden = false; progText.textContent = "Downloading the model…";
    try {
      generate = await (opts.generateFactory || createLocalGenerate)(r => { if (r && Number.isFinite(r.progress)) prog.value = r.progress; if (r && r.text) progText.textContent = r.text; });
      add("chat-note", "Local model ready.");
    } catch (e) { progText.textContent = "Could not load the local model: " + errMsg(e); loadBtn.disabled = false; }
    refresh();
  });
  form.addEventListener("submit", async ev => {
    ev.preventDefault(); const q = ta.value.trim(); if (!q || busy) return;
    if (q.length > 2000) { add("chat-err", "Please keep questions under 2000 characters."); return; }
    ta.value = ""; add("chat-user", q); busy = true; refresh();
    let res;
    try {
      if (backend === "claude") {
        const api = app.getState().api;
        if (normApi(api) !== normApi(claudeApi)) { await checkClaude(); throw new Error("The sightline server changed; read the note above and send again."); }
        res = await runClaudeTurn({post: createClaudePost(api, fetchImpl), state: hist, userText: q, exec, onEvent, knownId});
      } else res = await runLocalTurn({generate, state: hist, userText: q, exec, onEvent, knownId});
    } catch (e) { res = {answer: null, error: errMsg(e), unverified: []}; }
    pending.length = 0;
    if (res.answer) {
      const n = renderAnswer(add("chat-bot"), res.answer, app);
      if (res.unverified.length) n.append(el("span", {class: "chat-badge", text: "unverified: " + res.unverified.join(", ")}));
    }
    if (res.note) add("chat-note", res.note);
    if (res.error) add("chat-err", res.error);
    busy = false; refresh(); log.scrollTop = log.scrollHeight; ta.focus();
  });
  ta.addEventListener("keydown", ev => { if (ev.key === "Enter" && !ev.shiftKey) { ev.preventDefault(); form.requestSubmit(); } });
  closeBtn.addEventListener("click", () => ctl.close());
  clearBtn.addEventListener("click", () => { if (busy) return; hist.messages = []; log.replaceChildren(); ta.focus(); });
  const focusables = () => [...drawer.querySelectorAll("button,select,textarea,summary,[href],input")].filter(e => !e.disabled && e.offsetParent !== null);
  drawer.addEventListener("keydown", ev => {
    if (ev.key === "Escape") { ev.preventDefault(); ctl.close(); return; }
    if (ev.key !== "Tab") return;
    const f = focusables(); if (!f.length) return;
    const first = f[0], lastF = f[f.length - 1];
    if (ev.shiftKey && document.activeElement === first) { ev.preventDefault(); lastF.focus(); }
    else if (!ev.shiftKey && document.activeElement === lastF) { ev.preventDefault(); first.focus(); }
  });
  const onDone = ev => { const d = ev.detail || {}; if (myJobs.has(d.job_id)) { myJobs.delete(d.job_id); add("chat-note", `Sightline ${d.id} is ready and shown in the Spectra tab.`); } };
  const onErr = ev => { const d = ev.detail || {}; if (myJobs.has(d.job_id)) { myJobs.delete(d.job_id); add("chat-err", `Generating ${d.id || "the sightline"} failed: ${d.message || "error"}`); } };
  const onBackend = () => { checkClaude(); };
  window.addEventListener("tng:done", onDone); window.addEventListener("tng:error", onErr); window.addEventListener("tng:backend", onBackend);

  const ctl = {
    open() {
      opener = opener || document.activeElement; root.hidden = false; checkClaude();
      refresh(); (ta.disabled ? (load.hidden ? closeBtn : loadBtn) : ta).focus();
    },
    close() { root.hidden = true; if (opener && opener.focus) opener.focus(); },
    destroy() { window.removeEventListener("tng:done", onDone); window.removeEventListener("tng:error", onErr); window.removeEventListener("tng:backend", onBackend); root.replaceChildren(); root.hidden = true; },
    get backend() { return backend; },
  };
  refresh();
  if (opts.open !== false) ctl.open();
  return ctl;
}
