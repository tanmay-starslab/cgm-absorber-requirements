// Static gate of the "How a spectrum is made" story (PLAN_final §6 story_static, §5, §7, §8 U6). No browser.
// Usage: node tests/js/story_static.mjs [docs/tng50 dir] [--story learn/how-a-spectrum-is-made]
// ROOT = <dir>/<story>. While ROOT has neither index.html nor steps.json the test prints "skipped" and exits 0;
// STORY_REQUIRE=1 turns that into a failure (use it once M1 is merged).
// Checks (all over ROOT/** except vendor/, media/, build/ and binary files):
//   - no dot separator (U+00B7, U+2022, U+2027, U+22C5, U+30FB, " . ") in HTML text and attributes, CSS, any JS string
//     literal, any string in steps.json or other ROOT JSON (sepHits, the explorer's rule);
//   - steps.json: unique ids, known chapters (§2.2) in one run each, title only on a chapter's first step, display text
//     <= 8 words, sub <= 25 words, caption = text, a voice field, dur_s a whole number of 1/30 s frames, <= 3 scrub
//     steps, <= 2 controls, layout {land, port}, film boolean, handoff layout one of state.js LAYOUTS;
//   - wording lint (sci P0, ux P1.1, R_physics avoid list), display text = text, title, caption:
//       display only: bare "line", "component", "column density", "LSF", ungrouped 5+ digit numbers (subhalo ids are
//       {{key}} templates); display and sub: "4 km/s";
//       every field but physics: "gas we cannot see", "total gas", "hold most of the gas", "hundreds of cells",
//       "hot gas" not "warm-hot gas";
//       every field: "Σ log N" / "sum of log", "unsaturated" without "mostly", "temperature" near a fit,
//       "Gaussian τ", "HM2012 sets H I", "cells = clouds", "b is temperature";
//   - scenes (ROOT/js/scenes/*.js, code with comments and strings removed): no Math.random, Date, performance.now,
//     setTimeout/setInterval, requestAnimationFrame, fitPanel (purity rules §1.1);
//   - no "gsap" anywhere in ROOT (code or strings), no three.js import, no network resource loads (script/link/import/
//     url()/@import with http(s)://; render nodes have no network);
//   - every relative import (static, dynamic, Worker/URL with import.meta.url) and every relative src/href in ROOT HTML
//     resolves to a file inside the export dir <dir>; no bare specifiers;
//   - hand-off hashes are never written by hand in ROOT/js (no "lay=", "&sn=", "R=uv:" literals) and formatHash from
//     state.js is imported by some ROOT module once any step has a handoff;
//   - galaxy-agnostic code: a literal subhalo id or sightline id (e.g. 488530, rand_b062_a062) appears in at most one
//     ROOT/js file (the default); the story must work for every galaxy of the sample;
//   - no link inside a data-tip tooltip (ux P0.6);
//   - vendored fonts: every @font-face url() is a local woff2 with OFL.txt beside it;
//   - render.html (when present, §5): data-composition-id="spectrum-story", 1920 x 1080, 30 fps, data-duration = sum of
//     dur_s of the film cut or of all steps (one frame), data-no-timeline, registerFrameSource({element ...}) and no
//     host key.
import {readFileSync, existsSync, readdirSync, statSync} from "node:fs";
import {join, resolve, dirname, relative, extname, sep as PSEP} from "node:path";
import {pathToFileURL} from "node:url";
import {ROOT as REPO, parseArgs, checker, sepHits} from "./lib/browser.mjs";
import {jsStrings, htmlParts} from "./lib/jsscan.mjs";

const {pos, opt} = parseArgs(process.argv.slice(2));
const DIR = resolve(pos[0] || join(REPO, "docs/tng50"));
const SROOT = resolve(DIR, opt.story || "learn/how-a-spectrum-is-made");
const STEPS_F = join(SROOT, "steps.json");
if (!existsSync(join(SROOT, "index.html")) && !existsSync(STEPS_F)) {
  if (process.env.STORY_REQUIRE === "1") { console.log(`FAIL no story at ${SROOT} (STORY_REQUIRE=1)`); process.exit(1); }
  console.log(`skipped (no story at ${relative(REPO, SROOT) || SROOT}; set STORY_REQUIRE=1 to fail instead)`); process.exit(0);
}
const C = checker(), check = C.check, note = C.note;
const rel = f => relative(REPO, f);
const read = f => readFileSync(f, "utf8");
const SKIP_DIRS = new Set(["vendor", "media", "build", "node_modules"]);
const TEXT_EXT = new Set([".html", ".js", ".mjs", ".css", ".json", ".svg", ".vtt", ".txt"]);
function walk(d, out = []) {
  if (!existsSync(d)) return out;
  for (const n of readdirSync(d).sort()) { const f = join(d, n), st = statSync(f);
    if (st.isDirectory()) { if (!SKIP_DIRS.has(n)) walk(f, out); } else out.push(f); }
  return out;
}
const FILES = walk(SROOT).filter(f => TEXT_EXT.has(extname(f)));
const JS = FILES.filter(f => /\.m?js$/.test(f)), HTML = FILES.filter(f => f.endsWith(".html")), CSS = FILES.filter(f => f.endsWith(".css"));
const JSONS = FILES.filter(f => f.endsWith(".json"));
note(`story root ${rel(SROOT)}: ${JS.length} js, ${HTML.length} html, ${CSS.length} css, ${JSONS.length} json`);

/* code without comments and string/template/regex contents (heuristic, own sources) */
function codeOnly(src) {
  let out = "", i = 0; const N = src.length; let last = "";
  while (i < N) {
    const c = src[i], d = src[i + 1];
    if (c === "/" && d === "/") { while (i < N && src[i] !== "\n") i++; continue; }
    if (c === "/" && d === "*") { const e = src.indexOf("*/", i + 2); const blk = src.slice(i, e < 0 ? N : e + 2); out += blk.replace(/[^\n]/g, " "); i = e < 0 ? N : e + 2; continue; }
    if (c === "'" || c === '"' || c === "`") { const q = c; out += q + q; i++;
      while (i < N && src[i] !== q) { if (src[i] === "\\") i++; else if (q === "`" && src[i] === "$" && src[i + 1] === "{") { // keep ${...} code
          let depth = 1; i += 2; let expr = ""; while (i < N && depth) { if (src[i] === "{") depth++; else if (src[i] === "}") depth--; if (depth) expr += src[i]; i++; } out += " " + codeOnly(expr) + " "; continue; }
        i++; }
      i++; last = "a"; continue; }
    if (c === "/" && (last === "" || /[(,=:[!&|?{};]/.test(last))) { i++; let cls = false; // regex literal
      while (i < N && src[i] !== "\n") { const x = src[i]; if (x === "\\") { i += 2; continue; } if (x === "[") cls = true; else if (x === "]") cls = false; else if (x === "/" && !cls) break; i++; }
      i++; while (i < N && /[a-z]/i.test(src[i])) i++; out += "/r/"; last = "a"; continue; }
    if (!/\s/.test(c)) last = c;
    out += c; i++;
  }
  return out;
}
const strip = s => String(s ?? "").replace(/<[^>]*>/g, " ");
const stripTight = s => String(s ?? "").replace(/<[^>]*>/g, "");   // separator scan: "</a>." is not " . "

/* ---------------------------------------------------------------- separators */
const sepBad = [];
const scanStr = (where, s) => { for (const h of sepHits(s)) sepBad.push(`${where} ${h.what} "${String(s).slice(Math.max(0, h.index - 20), h.index + 20)}"`); };
function scanJson(where, v, path = "") {
  if (typeof v === "string") scanStr(`${where}${path}`, v);
  else if (Array.isArray(v)) v.forEach((x, k) => scanJson(where, x, `${path}[${k}]`));
  else if (v && typeof v === "object") for (const [k, x] of Object.entries(v)) { scanStr(`${where}${path} key`, k); scanJson(where, x, `${path}.${k}`); }
}
for (const f of JS) for (const {s, line} of jsStrings(read(f))) scanStr(`${rel(f)}:${line}`, s);
for (const f of HTML) for (const p of htmlParts(read(f))) {
  if (p.kind === "js") scanStr(`${rel(f)}:${p.line} script`, p.s);
  else if (p.kind === "css") scanStr(`${rel(f)}:${p.line} style`, p.s.replace(/content:\s*/g, ""));
  else { scanStr(`${rel(f)}:${p.line} text`, stripTight(p.s)); for (const m of p.s.matchAll(/\s[\w:-]+="([^"]*)"/g)) scanStr(`${rel(f)}:${p.line} attr`, m[1]); }
}
for (const f of CSS) scanStr(rel(f), read(f).replace(/\/\*[\s\S]*?\*\//g, ""));
let STEPS = null, STEPS_RAW = null;
for (const f of JSONS) { let j; try { j = JSON.parse(read(f)); } catch (e) { check(false, `${rel(f)} parses as JSON (${e.message.slice(0, 80)})`); continue; }
  if (f === STEPS_F) STEPS_RAW = j;
  if (f.includes(`${PSEP}data${PSEP}`) && statSync(f).size > 200000) continue;   // large numeric data: keys and strings only matter in small files
  scanJson(rel(f), j); }
check(!sepBad.length, `no dot separators in ROOT html, css, js strings or json${sepBad.length ? ` (${sepBad.length}): ` + sepBad.slice(0, 6).join("; ") : ""}`);

/* ---------------------------------------------------------------- steps.json */
const CHAPTERS = ["light", "pencil", "cells", "ions", "dip", "speed", "sum", "saturation", "lsf", "noise", "fit", "yourturn"];
const LAYOUTS = await (async () => { try { return (await import(pathToFileURL(join(DIR, "js/state.js")).href)).LAYOUTS; } catch { return ["1", "2R", "2SN", "4"]; } })();
/* words: a {{key}} template is one word, a digit group "200 000" is one word, a token needs a letter or digit */
const words = s => String(s ?? "").replace(/\{\{[^}]*\}\}/g, "X").replace(/(\d)[\s  ]+(?=\d{3}\b)/g, "$1").split(/\s+/).filter(t => /[\p{L}\p{N}]/u.test(t));
if (!STEPS_RAW) check(false, `steps.json present at ${rel(STEPS_F)}`);
else {
  STEPS = Array.isArray(STEPS_RAW) ? STEPS_RAW : STEPS_RAW.steps;
  check(Array.isArray(STEPS) && STEPS.length > 0, `steps.json has a steps array (${STEPS?.length ?? 0} steps${STEPS_RAW.schema ? ", schema " + STEPS_RAW.schema : ""})`);
  STEPS = Array.isArray(STEPS) ? STEPS : [];
  const ids = STEPS.map(s => s.id), dup = ids.filter((x, k) => ids.indexOf(x) !== k);
  check(ids.every(x => typeof x === "string" && /^[a-z0-9][a-z0-9-]*$/.test(x)) && !dup.length, `step ids are unique url-safe strings${dup.length ? ": duplicates " + dup.join(", ") : ""}`);
  const chs = STEPS.map(s => s.chapter), runs = chs.filter((c, k) => k === 0 || chs[k - 1] !== c);
  check(chs.every(c => CHAPTERS.includes(c)), `every chapter is one of §2.2 (${[...new Set(chs.filter(c => !CHAPTERS.includes(c)))].join(", ") || "all known"})`);
  check(new Set(runs).size === runs.length, `each chapter is one contiguous run of steps (${runs.join(" ")})`);
  const ordered = runs.filter(c => CHAPTERS.includes(c)).map(c => CHAPTERS.indexOf(c));
  check(ordered.every((x, k) => k === 0 || x > ordered[k - 1]), "chapters keep the §2.2 order");
  note(`${STEPS.length} steps in ${runs.length} chapters${runs.length === 12 ? "" : " (the full story has 12)"}`);
  const firstOf = new Set(STEPS.filter((s, k) => k === 0 || STEPS[k - 1].chapter !== s.chapter).map(s => s.id));
  const bad = {title: [], text: [], sub: [], cap: [], voice: [], dur: [], ctl: [], lay: [], film: [], hand: []};
  for (const s of STEPS) {
    if (firstOf.has(s.id) ? !(typeof s.title === "string" && s.title.trim().endsWith("?") || s.chapter === "yourturn" && s.title) : !!s.title) bad.title.push(s.id);
    if (!(typeof s.text === "string" && words(s.text).length >= 1 && words(s.text).length <= 8)) bad.text.push(`${s.id} (${words(s.text).length})`);
    if (s.sub != null && words(s.sub).length > 25) bad.sub.push(`${s.id} (${words(s.sub).length})`);
    if (s.caption != null && s.caption !== s.text) bad.cap.push(s.id);
    if (!("voice" in s)) bad.voice.push(s.id);
    if (!(typeof s.dur_s === "number" && s.dur_s > 0 && Math.abs(s.dur_s * 30 - Math.round(s.dur_s * 30)) < 1e-6)) bad.dur.push(`${s.id} (${s.dur_s})`);
    if (s.controls != null && !(Array.isArray(s.controls) && s.controls.length <= 2)) bad.ctl.push(s.id);
    if (!(s.layout && typeof s.layout === "object" && s.layout.land && s.layout.port)) bad.lay.push(s.id);
    if (typeof s.film !== "boolean") bad.film.push(s.id);
    if (s.handoff != null && (typeof s.handoff !== "object" || (s.handoff.layout != null && !LAYOUTS.includes(String(s.handoff.layout))))) bad.hand.push(s.id);
  }
  check(!bad.title.length, `chapter title (a question) on each chapter's first step only${bad.title.length ? ": " + bad.title.join(", ") : ""}`);
  check(!bad.text.length, `display text 1 to 8 words${bad.text.length ? ": " + bad.text.join(", ") : ""}`);
  check(!bad.sub.length, `sub <= 25 words${bad.sub.length ? ": " + bad.sub.join(", ") : ""}`);
  check(!bad.cap.length, `caption equals text (one text layer in Play)${bad.cap.length ? ": " + bad.cap.join(", ") : ""}`);
  check(!bad.voice.length, `every step has a voice field (D4)${bad.voice.length ? ": missing on " + bad.voice.join(", ") : ""}`);
  check(!bad.dur.length, `dur_s is a whole number of 1/30 s frames${bad.dur.length ? ": " + bad.dur.join(", ") : ""}`);
  const scrub = STEPS.filter(s => s.scrub === true).map(s => s.id);
  check(scrub.length <= 3, `at most 3 scrub steps (${scrub.join(", ") || "none"})`);
  check(!bad.ctl.length, `controls is a list of at most 2 params${bad.ctl.length ? ": " + bad.ctl.join(", ") : ""}`);
  check(!bad.lay.length, `layout {land, port} on every step${bad.lay.length ? ": missing on " + bad.lay.join(", ") : ""}`);
  check(!bad.film.length, `film is a boolean on every step${bad.film.length ? ": " + bad.film.join(", ") : ""}`);
  check(!bad.hand.length, `handoff layouts are one of ${LAYOUTS.join(", ")}${bad.hand.length ? ": " + bad.hand.join(", ") : ""}`);
  const sum = a => a.reduce((x, s) => x + (+s.dur_s || 0), 0);
  note(`Play length ${sum(STEPS).toFixed(2)} s, film cut ${sum(STEPS.filter(s => s.film)).toFixed(2)} s`);
}

/* ---------------------------------------------------------------- wording lint */
const DISPLAY = ["text", "title", "caption"];
const RULES = [
  {re: /\bline\b/i, why: 'bare "line" (say beam or dip)', fields: "display"},
  {re: /\bcomponents?\b/i, why: '"component"', fields: "display"},
  {re: /\bcolumn densit/i, why: '"column density"', fields: "display"},
  {re: /\bLSF\b/, why: '"LSF"', fields: "display"},
  {re: /(^|[^\d.])4\s*km\/s/, why: '"4 km/s" on screen (S6)', fields: "display+sub"},
  {re: /\b\d{5,}\b/, why: "ungrouped 5+ digit number (a subhalo id must be a {{key}} template, every galaxy; other numbers group as 150 000)", fields: "display"},
  {re: /gas (we|you) (cannot|can't|can not) see/i, why: '"gas we cannot see"', fields: "nophys"},
  {re: /\btotal gas\b/i, why: '"total gas"', fields: "nophys"},
  {re: /hold(s)? most of the gas/i, why: '"hold most of the gas"', fields: "nophys"},
  {re: /hundreds of cells/i, why: '"hundreds of cells"', fields: "nophys"},
  {re: /(?<!warm-)(?<!warm )\bhot gas\b/i, why: '"hot gas" (say warm-hot)', fields: "nophys"},
  {re: /Σ\s*log\s*N|\bsum of log/i, why: '"Σ log N" (write total log N = log₁₀ Σ N)', fields: "all"},
  {re: /\bunsaturated\b/i, why: '"unsaturated" without "mostly"', fields: "all", test: s => /\bunsaturated\b/i.test(s) && !/mostly unsaturated/i.test(s)},
  {re: /\bfit\w*\b[^.]{0,80}\btemperature\b|\btemperature\b[^.]{0,80}\bfit\w*\b/i, why: '"temperature" near a fitted width', fields: "all"},
  {re: /gaussian\s*(τ|tau)\b/i, why: '"Gaussian τ"', fields: "all"},
  {re: /HM2012 sets H\s?I\b/i, why: '"HM2012 sets H I"', fields: "all"},
  {re: /\bcells?\s*(=|are)\s*clouds\b/i, why: '"cells = clouds"', fields: "all"},
  {re: /\bb\s*(=|is)\s*(the\s*)?temperature\b/i, why: '"b is temperature"', fields: "all"},
];
const lintBad = [];
function lint(where, field, s) {
  if (typeof s !== "string" || !s) return;
  const disp = DISPLAY.includes(field), sub = field === "sub", phys = field === "physics";
  for (const r of RULES) {
    const on = r.fields === "all" || (r.fields === "display" && disp) || (r.fields === "display+sub" && (disp || sub)) || (r.fields === "nophys" && !phys);
    if (on && (r.test ? r.test(s) : r.re.test(s))) lintBad.push(`${where}.${field}: ${r.why} in "${s.slice(0, 70)}"`);
  }
}
for (const s of STEPS || []) for (const [k, v] of Object.entries(s)) {
  if (typeof v === "string") lint(s.id, k, v);
  else if (v && typeof v === "object" && k === "physics") for (const x of Object.values(v)) lint(s.id, "physics", typeof x === "string" ? x : "");
}
/* page chrome only: the step cards between <!--STEPS--> and <!--/STEPS--> are generated from steps.json (linted per
   field above, where the physics line may name what it explains away) */
for (const f of HTML) for (const p of htmlParts(read(f).replace(/<!--STEPS-->[\s\S]*?<!--\/STEPS-->/g, ""))) if (p.kind === "html") lint(rel(f), "html", strip(p.s).replace(/\s+/g, " "));
check(!lintBad.length, `wording lint${lintBad.length ? ` (${lintBad.length}): ` + lintBad.slice(0, 8).join("; ") : ""}`);

/* ---------------------------------------------------------------- purity of scenes, gsap, three, network */
const SCENES = JS.filter(f => f.includes(`${PSEP}js${PSEP}scenes${PSEP}`));
const PURE = [[/\bMath\.random\b/, "Math.random"], [/\bDate\b/, "Date"], [/\bperformance\.now\b/, "performance.now"],
  [/\bset(Timeout|Interval)\b/, "timers"], [/\brequestAnimationFrame\b/, "requestAnimationFrame"], [/\bfitPanel\b/, "fitPanel"]];
const impure = [];
for (const f of SCENES) { const code = codeOnly(read(f)); for (const [re, what] of PURE) if (re.test(code)) impure.push(`${rel(f)}: ${what}`); }
check(!impure.length, `scenes are pure: no Math.random, Date, performance.now, timers, rAF or fitPanel (${SCENES.length} scene files)${impure.length ? ": " + impure.join("; ") : ""}`);
if (!SCENES.length) note("no js/scenes/*.js yet");
const allText = FILES.map(f => [f, read(f)]);
const gs = allText.filter(([, s]) => /gsap/i.test(s)).map(([f]) => rel(f));
check(!gs.length, `no gsap anywhere in the story (licence, §9)${gs.length ? ": " + gs.join(", ") : ""}`);
const three = allText.filter(([f, s]) => /\.m?js$|\.html$/.test(f) && /(from\s*|import\s*\(\s*)["'][^"']*\bthree(\.module)?(\.min)?(\.js)?["']|three\.module/.test(s)).map(([f]) => rel(f));
check(!three.length, `no three.js in the story (D17)${three.length ? ": " + three.join(", ") : ""}`);
const net = [];
for (const f of JS) { const src = read(f);
  for (const m of src.matchAll(/(?:\bfrom\s*|\bimport\s*\(\s*|\bimportScripts\s*\(\s*)["'](https?:)?\/\/[^"']+["']/g)) net.push(`${rel(f)}: ${m[0].slice(0, 80)}`); }
for (const f of HTML) { const src = read(f);
  for (const m of src.matchAll(/<(script|img|source|video|audio|iframe)\b[^>]*\bsrc="((https?:)?\/\/[^"]+)"/g)) net.push(`${rel(f)}: ${m[1]} ${m[2]}`);
  for (const m of src.matchAll(/<link\b[^>]*>/g)) if (/\brel="?(stylesheet|preload|modulepreload|icon|manifest)/.test(m[0]) && /href="(https?:)?\/\//.test(m[0])) net.push(`${rel(f)}: ${m[0].slice(0, 80)}`); }
for (const [f, src] of allText.filter(([f]) => /\.(css|html)$/.test(f))) for (const m of src.matchAll(/(@import\s+(url\()?|url\()\s*["']?(https?:)?\/\/[^)"'\s]+/g)) net.push(`${rel(f)}: ${m[0].slice(0, 80)}`);
check(!net.length, `no network resource loads (vendored fonts, no CDN)${net.length ? ": " + net.slice(0, 6).join("; ") : ""}`);

/* ---------------------------------------------------------------- relative imports resolve inside the export */
const inside = f => f === DIR || f.startsWith(DIR + PSEP);
const unres = [], bare = [];
for (const f of JS) { const src = codeOnlyKeepSpecs(read(f));
  for (const spec of src) {
    if (/^(https?:)?\/\//.test(spec) || spec.includes("${") || spec.includes("{{")) continue;
    if (!/^\.{1,2}\//.test(spec) && !spec.startsWith("/")) { bare.push(`${rel(f)}: "${spec}"`); continue; }
    const t = spec.startsWith("/") ? null : resolve(dirname(f), spec.split(/[?#]/)[0]);
    if (!t || !inside(t) || !existsSync(t)) unres.push(`${rel(f)}: "${spec}"${t && !inside(t) ? " (outside the export)" : ""}`);
  } }
for (const f of HTML) for (const m of read(f).matchAll(/<(?:script|link|img|source)\b[^>]*?\b(?:src|href)="([^"#?]+)[^"]*"/g)) {
  const spec = m[1]; if (/^(https?:|mailto:|data:|\/\/|#)/.test(spec) || spec.includes("{{")) continue;
  if (/\.mp4$|\.vtt$/.test(spec)) continue;   // media are hosted (D5) or built by U5; the export skips media/*.mp4
  const t = spec.startsWith("/") ? null : resolve(dirname(f), spec);
  if (!t || !inside(t) || !existsSync(t)) unres.push(`${rel(f)}: ${spec}`);
}
check(!unres.length, `every relative import, src and href resolves to a file inside ${rel(DIR)}${unres.length ? ` (${unres.length}): ` + unres.slice(0, 8).join("; ") : ""}`);
check(!bare.length, `no bare module specifiers (no bundler, no import map)${bare.length ? ": " + bare.slice(0, 5).join("; ") : ""}`);
/** module specifiers of one JS source: static import/export from, dynamic import(), new URL(x, import.meta.url), new Worker(x) */
function codeOnlyKeepSpecs(src) {
  const s = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`\\])\/\/[^\n]*/g, "$1"), out = [];
  for (const m of s.matchAll(/\b(?:import|export)\s+(?:[\w*{}\s,$]+?\s+from\s+)?["']([^"']+)["']/g)) out.push(m[1]);
  for (const m of s.matchAll(/\bimport\s*\(\s*["']([^"']+)["']\s*\)/g)) out.push(m[1]);
  for (const m of s.matchAll(/\bnew\s+URL\s*\(\s*["']([^"']+)["']\s*,\s*import\.meta\.url\s*\)/g)) out.push(m[1]);
  for (const m of s.matchAll(/\bnew\s+(?:Shared)?Worker\s*\(\s*["']([^"']+)["']/g)) out.push(m[1]);
  return out;
}

/* ---------------------------------------------------------------- hand-off built only with formatHash */
const handBad = [];
for (const f of JS) for (const {s, line} of jsStrings(read(f))) if (/(^|[&#])lay=|&sn=|\bR=uv:|&ions=/.test(s)) handBad.push(`${rel(f)}:${line} "${s.slice(0, 50)}"`);
check(!handBad.length, `no hand-written explorer hash in story JS (formatHash only, eng P0-2)${handBad.length ? ": " + handBad.join("; ") : ""}`);
const hasHandoff = (STEPS || []).some(s => s.handoff);
const usesFH = JS.some(f => /\bformatHash\b/.test(read(f)) && /["'][^"']*\/js\/state\.js["']/.test(read(f)));
if (hasHandoff) check(usesFH, "a story module imports formatHash from the explorer's js/state.js");
else note("no step has a handoff yet; formatHash import not required");

/* ---------------------------------------------------------------- galaxy-agnostic code */
const GAL_RE = /\b(488530|411449|505100)\b|\b(face|edge|rand)_b\d{3}_a\d{3}\b/;
const galFiles = JS.filter(f => jsStrings(read(f)).some(({s}) => GAL_RE.test(s)) || GAL_RE.test(codeOnly(read(f))));
check(galFiles.length <= 1, `a literal galaxy or sightline id sits in at most one story JS file (the default; every galaxy must work)${galFiles.length ? ": " + galFiles.map(rel).join(", ") : ""}`);
/* owner 2026-11-12: the cell data exists for all 198 galaxies, not just 488530; no reader-facing text may say that the
   story's data is ready for one galaxy only (HTML text, JS source without comments, steps.json strings) */
const ONLY_RE = /\b(data|cells?|cell-by-cell|story)\b[^.]{0,60}\b(ready|available|exists?|computed|exported)\s+for\s+(galaxy\s+|subhalo\s+)?(\$\{[^}]*\}|\{\{\w+\}\}|\d{3,})\s+only\b|\bonly\s+(for\s+)?(galaxy|subhalo)\s+(\$\{[^}]*\}|\{\{\w+\}\}|\d{3,})\b/i;
const onlyBad = [];
for (const f of JS) { const src = read(f).replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`\\])\/\/[^\n]*/g, "$1"); if (ONLY_RE.test(src)) onlyBad.push(`${rel(f)}: "${src.match(ONLY_RE)[0].slice(0, 80)}"`); }
for (const f of HTML) { const src = read(f).replace(/<!--[\s\S]*?-->/g, "").replace(/\/\*[\s\S]*?\*\//g, ""); if (ONLY_RE.test(src)) onlyBad.push(`${rel(f)}: "${src.match(ONLY_RE)[0].slice(0, 80)}"`); }
if (STEPS_RAW) { const s = JSON.stringify(STEPS_RAW); if (ONLY_RE.test(s)) onlyBad.push(`steps.json: "${s.match(ONLY_RE)[0].slice(0, 80)}"`); }
check(!onlyBad.length, `no text says the story's data is ready for one galaxy only (all 198 galaxies have cell data)${onlyBad.length ? ": " + onlyBad.join("; ") : ""}`);

/* ---------------------------------------------------------------- tooltips, fonts */
const tipLinks = [];
for (const f of [...HTML, ...JS]) { const s = read(f);
  for (const m of s.matchAll(/data-tip\s*=\s*["']([^"']*)["']|dataset\.tip\s*=\s*["'`]([^"'`]*)["'`]/g)) { const t = m[1] ?? m[2]; if (/<a\b|https?:\/\/|href=/i.test(t)) tipLinks.push(`${rel(f)}: "${t.slice(0, 60)}"`); } }
check(!tipLinks.length, `no links inside data-tip tooltips (ux P0.6)${tipLinks.length ? ": " + tipLinks.join("; ") : ""}`);
const faceBad = [];
let faces = 0;
for (const [f, src] of allText.filter(([f]) => /\.(css|html)$/.test(f))) for (const m of src.matchAll(/@font-face\s*{[^}]*}/g)) {
  faces++;
  for (const u of m[0].matchAll(/url\(\s*["']?([^)"']+)["']?\s*\)/g)) { const t = resolve(dirname(f), u[1]);
    if (!/\.woff2$/.test(u[1]) || !existsSync(t)) faceBad.push(`${rel(f)}: ${u[1]}`);
    else if (!existsSync(join(dirname(t), "OFL.txt"))) faceBad.push(`${rel(f)}: no OFL.txt beside ${u[1]}`); } }
if (faces) check(!faceBad.length, `${faces} @font-face rules load vendored woff2 with OFL.txt${faceBad.length ? ": " + faceBad.join("; ") : ""}`);
else note("no @font-face yet");

/* ---------------------------------------------------------------- render.html (§5) */
const RENDER = join(SROOT, "render.html");
if (!existsSync(RENDER)) note("no render.html yet (U5)");
else {
  const s = read(RENDER), attr = k => (s.match(new RegExp(`\\b${k}\\s*=\\s*["']?([^"'\\s>]+)`)) || [])[1];
  check(attr("data-composition-id") === "spectrum-story", `render.html data-composition-id="spectrum-story" (${attr("data-composition-id")})`);
  check(attr("data-width") === "1920" && attr("data-height") === "1080" && attr("data-fps") === "30", `render.html 1920 x 1080 at 30 fps (${attr("data-width")} x ${attr("data-height")} at ${attr("data-fps")})`);
  check(/\bdata-no-timeline\b/.test(s), "render.html has data-no-timeline");
  const dur = +attr("data-duration"), film = (STEPS || []).filter(x => x.film).reduce((a, x) => a + (+x.dur_s || 0), 0), all = (STEPS || []).reduce((a, x) => a + (+x.dur_s || 0), 0);
  check(Number.isFinite(dur) && (Math.abs(dur - film) <= 1 / 30 + 1e-9 || Math.abs(dur - all) <= 1 / 30 + 1e-9) || /\{\{|\$\{/.test(attr("data-duration") || ""),
    `render.html data-duration ${attr("data-duration")} = film cut ${film.toFixed(3)} s or full ${all.toFixed(3)} s (one frame)`);
  const rjs = [s, ...JS.filter(f => /render|video/i.test(f)).map(read)].join("\n");
  check(/registerFrameSource\s*\(\s*{[^}]*\belement\s*:/.test(rjs) && !/registerFrameSource\s*\(\s*{[^}]*\bhost\s*:/.test(rjs), "registerFrameSource({element, ready, render}), no host key (eng P0-3)");
}

process.exit(C.finish());
