// Copy lint of the v2 story "How a spectrum is made" (DESIGN_final §5.7 U_copy, gate G10 copy part). No browser.
// Usage: node tests/js/story_copy_lint.mjs [docs/tng50 dir] [--story learn/how-a-spectrum-is-made] [--data <story json>]
// ROOT = <dir>/<story>. Without ROOT/copy.json the test prints "skipped" and exits 0 (STORY_REQUIRE=1 makes it a failure).
// Keys the copy needs that the data does not have yet are reported as "pending" when they are listed in
// copy.keys_contract (U_data exports them in story-data/2); they fail once the data says story-data/2, or with COPY_STRICT=1.
// Checks over every string of copy.json (and string captions/labels of beats.json and film.json when present):
//   - schema story-copy/2, every beat of beats_order has display, display_short, narrative (and beats.json ids match);
//   - words: display <= 8, display_short <= 5, sub <= 25, sub_short <= 12 (a {{template}} or digit group is one word;
//     an `extra` addendum is counted with its line); a short form exists for every long form;
//   - numbers: no literal digit (ASCII or superscript) outside {{templates}} except lint.allow patterns (scoped by section);
//     number words only inside lint.allow_words phrases (analogies come from `derive` rules, C_ux P1-4);
//   - templates: {{key}} resolves in story data, `derive` or keys_contract (pending); {{$x}} is a declared live field;
//     `ncross` and `n_cells` never appear (C_science M8), nor any N-weighted mean as a dip position (H2);
//   - every `when` names a flag in copy.flags; derive rules give the documented values;
//   - wording lint: v1 rules (adapted, see VOCAB below) plus the C_science display fixes H1, H4, M4, M6, M9, L1, L2 and
//     R_content §8/§13 bans ("too cool for O VI", "weak", "the telescope sees", "glows/emits" outside a negation,
//     "closest ... most" without "not", "hundreds of cells" making dips);
//   - no dot separators (the explorer's sepHits rule);
//   - presence: the fixes above are in place, the honest-simplification list covers DESIGN_final §3.7, credits name
//     Lucchini et al. and CREST and say vortrace is not used, the plaque prints Z in Z⊙, B12b states the pixel rule;
//   - rendering with the real story keys: no "undefined", "NaN", "–" or leftover "{{" in any string whose keys exist;
//   - self-test: seeded defect copies (literal number, ncross, 9-word line, "We fit a few clouds", unknown key, dot
//     separator, free-text analogy) must each fail, the shipped copy must pass.
// Exports (pure, reusable by the shell/narrative): words, parseNum, deriveKeys, resolveKey, render, lintCopy.
import {readFileSync, existsSync} from "node:fs";
import {join, resolve} from "node:path";
import {pathToFileURL} from "node:url";
import {ROOT as REPO, parseArgs, checker, sepHits} from "./lib/browser.mjs";

/* ---------------------------------------------------------------- pure helpers */
/** words: a {{key}} template is one word, a digit group "200 000" is one word, a token needs a letter or digit (v1 rule). */
export const words = s => String(s ?? "").replace(/\{\{[^}]*\}\}/g, "X").replace(/\*/g, "")
  .replace(/(\d)[\s  ]+(?=\d{3}\b)/g, "$1").split(/\s+/).filter(t => /[\p{L}\p{N}]/u.test(t));

const SUP = {"⁰": 0, "¹": 1, "²": 2, "³": 3, "⁴": 4, "⁵": 5, "⁶": 6, "⁷": 7, "⁸": 8, "⁹": 9};
/** parseNum: "22 723", "−69.31", "5×10⁻⁶", "1.60×10¹²", "+35" → number (NaN when not a number). */
export function parseNum(v) {
  if (typeof v === "number") return v;
  let s = String(v ?? "").trim().replace(/[−–]/g, "-").replace(/[\s  ]/g, "");
  const m = s.match(/^([+-]?\d*\.?\d+)(?:[×x]10([⁻⁺]?)([⁰¹²³⁴⁵⁶⁷⁸⁹]+))?$/);
  if (!m) return NaN;
  const e = m[3] ? (m[2] === "⁻" ? -1 : 1) * Number([...m[3]].map(c => SUP[c]).join("")) : 0;
  return Number(m[1]) * 10 ** e;
}
const group = n => String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, " ");
const sig1 = x => { if (!(x > 0)) return NaN; const p = 10 ** Math.floor(Math.log10(x)); return Math.round(x / p) * p; };
const SMALL = ["zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten", "eleven", "twelve", "thirteen",
  "fourteen", "fifteen", "sixteen", "seventeen", "eighteen", "nineteen", "twenty"];
export const RULES = {
  one_in: ([x]) => { const n = sig1(1 / parseNum(x)); return !isFinite(n) ? undefined : n <= 20 ? SMALL[n] : group(n); },
  ratio_1sf: ([a, b]) => { const n = sig1(parseNum(a) / parseNum(b)); return isFinite(n) ? group(n) : undefined; },
  fraction_words: ([pct]) => {
    const f = parseNum(pct) / 100; if (!(f > 0 && f <= 1)) return undefined;
    for (const [v, w] of [[1 / 2, "half"], [1 / 3, "a third"], [1 / 4, "a quarter"], [1 / 5, "a fifth"], [1 / 10, "a tenth"]])
      if (Math.abs(f - v) / v <= 0.10) return w;
    return `${String(pct).trim()} %`;
  },
  light_myr: ([kpc]) => { const L = parseNum(kpc); return isFinite(L) ? (L * 3261.56 / 1e6).toFixed(1) : undefined; },
};

/** resolveKey: flat key, dotted path into keys, dotted name with "_" (U_data naming), dotted path into the story root. */
export function resolveKey(name, data) {
  const keys = data?.keys || {};
  const path = (o, p) => p.split(".").reduce((a, k) => (a != null && typeof a === "object" ? a[k] : undefined), o);
  for (const v of [keys[name], path(keys, name), keys[name.replace(/\./g, "_")], name.includes(".") ? path(data, name) : undefined])
    if (v != null && typeof v !== "object") return String(v);
  return undefined;
}
/** resolveInput: a derive input; like resolveKey, but a dotted path into the story root may also return an array
 *  (e.g. facts2.new_dips.B7d.OVI.dips). */
export function resolveInput(name, data) {
  const v = resolveKey(name, data);
  if (v != null || !name.includes(".")) return v;
  const a = name.split(".").reduce((o, k) => (o != null && typeof o === "object" ? o[k] : undefined), data);
  return Array.isArray(a) ? a : undefined;
}
/** deriveKeys: copy.derive rules evaluated on the data; a missing input leaves the name undefined. */
export function deriveKeys(copy, data) {
  const out = {};
  for (const [name, d] of Object.entries(copy.derive || {})) {
    if (!d || typeof d !== "object" || !RULES[d.rule]) continue;
    const ins = d.from.map(k => resolveInput(k, data));
    out[name] = ins.every(v => v != null) ? RULES[d.rule](ins) : undefined;
  }
  return out;
}
/** copyLookup: the lookup for the shell's engine.js resolveTemplate: story data with copy.derive values merged into its keys. */
export function copyLookup(copy, data) {
  const keys = {...(data?.keys || {})};
  for (const [k, v] of Object.entries(deriveKeys(copy, data))) if (v != null && keys[k] == null) keys[k] = v;   // data keys win
  return {...(data || {}), keys};
}
/** FLAG_FALLBACK: copy.flags rules that restate a threshold on an exported story-data/2 key. Used only when the story JSON has
 *  no `flags` entry for the name (U_data's flags win). The cell-level rules (has_cold_knot, has_ovi_skin, has_hot_stretch,
 *  richest_not_closest) need the cells and stay U_data's: missing means false, so the conservative branch shows. */
export const FLAG_FALLBACK = {
  has_first_ovi: d => isFinite(parseNum(d?.keys?.b4_first_depth)),
  hi_black: d => parseNum(d?.keys?.hi_peak_tau) > 1,
  ovi_strong: d => parseNum(d?.keys?.ovi_peak_tau) >= 0.1,
  has_pair: d => parseNum(d?.keys?.n_pairs) > 0,
  has_invented: d => isFinite(parseNum(d?.keys?.invented_b)),
  lite: d => !(d?.geometry?.cells && typeof d.geometry.cells === "object"),
};
/** copyFlags: the booleans for `when`/`cond`: story JSON flags first, then FLAG_FALLBACK; names with neither are absent (false). */
export function copyFlags(copy, data) {
  const out = {};
  for (const f of Object.keys(copy?.flags || {})) {
    if (f === "about") continue;
    const v = data?.flags?.[f];
    if (typeof v === "boolean") out[f] = v; else if (FLAG_FALLBACK[f]) out[f] = !!FLAG_FALLBACK[f](data);
  }
  return out;
}
/** render: fills {{key}} from data/derived and {{$x}} from live; unknown names stay as {{name}}. */
export function render(s, data, derived = {}, live = {}) {
  return String(s).replace(/\{\{\s*([^}]+?)\s*\}\}/g, (m, n) => {
    const v = n.startsWith("$") ? live[n.slice(1)] : resolveKey(n, data) ?? derived[n];   // data keys win over derived
    return v == null ? m : String(v);
  });
}

/* ---------------------------------------------------------------- walking the copy */
const LINE_FIELDS = ["display", "display_short", "sub", "sub_short", "narrative", "physics", "chip", "hint"];
const LIMIT = {display: 8, display_short: 5, sub: 25, sub_short: 12};
const META_SECTIONS = new Set(["schema", "meta", "flags", "derive", "keys_contract", "live", "rules", "lint", "beats_order"]);

/** every string with {path, section, field}; field = display|display_short|sub|sub_short|narrative|physics|chip|hint|ui|... */
function collect(copy) {
  const out = [];
  const walk = (v, path, section, field) => {
    if (typeof v === "string") out.push({path, section, field, s: v});
    else if (Array.isArray(v)) v.forEach((x, i) => walk(x, `${path}[${i}]`, section, field));
    else if (v && typeof v === "object") for (const [k, x] of Object.entries(v)) {
      if (["id", "when", "when_live", "u", "act_title", "beats"].includes(k)) continue;
      walk(x, `${path}.${k}`, section, LINE_FIELDS.includes(k) ? k : field);
    }
  };
  for (const [k, v] of Object.entries(copy)) {
    if (META_SECTIONS.has(k)) continue;
    const isBeat = /^B\d/.test(k);
    walk(v, k, k, isBeat ? "beat" : k === "narrative_groups" ? "chip" : k);
  }
  return out;
}
/** activeStrings: the beat strings a story actually shows, mirroring the shell (hud.js beatSkip/activeText, kinetic.js
    copyEntry): a beat whose beats.json `cond` is false is skipped; a line whose `when` is false is replaced by its `else`
    (null = nothing); `extra` counts only when its flag holds; B7c `states` are alternatives chosen live, so both count.
    A missing flag is false (conservative branch). Returns [{path, s}]. Pure. */
export function activeStrings(copy, flags, beats = null) {
  const on = f => !!(flags && flags[f] === true), out = [];
  const skip = new Set(((beats && beats.beats) || []).filter(b => b && b.cond && !on(b.cond)).map(b => b.copyRef || b.id));
  const line = (o, path) => {
    if (!o || typeof o !== "object") return;
    if (o.when && !on(o.when)) { if (o.else && typeof o.else === "object") line({...o.else, then: undefined}, `${path}.else`); }
    else for (const f of LINE_FIELDS) if (typeof o[f] === "string") out.push({path: `${path}.${f}`, s: o[f]});
    if (o.extra && on(o.extra.when)) for (const f of LINE_FIELDS) if (typeof o.extra[f] === "string") out.push({path: `${path}.extra.${f}`, s: o.extra[f]});
    if (o.states) for (const [k, st] of Object.entries(o.states)) line(st, `${path}.states.${k}`);
    (o.then || []).forEach((t, i) => line(t, `${path}.then[${i}]`));
  };
  for (const id of copy.beats_order || []) if (!skip.has(id)) line(copy[id], id);
  return out;
}
/** the line objects of a beat: entry, then[k], else blocks, states, extras (for limits and pairing). */
function lines(copy) {
  const out = [];
  for (const id of copy.beats_order || []) {
    const b = copy[id]; if (!b) continue;
    const push = (o, where) => { if (o && typeof o === "object") out.push({beat: id, where, o}); };
    push(b, id); push(b.else, `${id}.else`);
    (b.then || []).forEach((t, k) => { push(t, t.id || `${id}.${k + 1}`); push(t.else, `${t.id}.else`); });
    for (const [k, st] of Object.entries(b.states || {})) push(st, `${id}.states.${k}`);
  }
  return out;
}

/* ---------------------------------------------------------------- wording rules */
const NEG = /\b(not|never|no|nor|cannot|n't|neither)\b/i;
const VOCAB = [
  // v1 (story_static) rules kept
  {re: /\bline\b/i, why: 'bare "line" (say beam or dip)', on: "display"},
  {re: /\bcolumn densit/i, why: '"column density" (say amount)', on: "display"},
  {re: /\bLSF\b/, why: '"LSF" (say blur)', on: "display"},
  {re: /(^|[^\d.])4\s*km\/s/, why: '"4 km/s" on screen', on: "display+sub"},
  {re: /gas (we|you) (cannot|can't|can not) see/i, why: '"gas we cannot see"', on: "nophys"},
  {re: /\btotal gas\b/i, why: '"total gas"', on: "nophys"},
  {re: /hold(s)? most of the gas/i, why: '"hold most of the gas"', on: "nophys"},
  {re: /Σ\s*log\s*N|\bsum of log/i, why: '"Σ log N" (write total log N = log₁₀ Σ N)', on: "all"},
  {re: /\bunsaturated\b/i, why: 'literal "unsaturated" (use the ovi_sat key)', on: "all"},
  {re: /\bfit\w*\b[^.]{0,80}\btemperature\b|\btemperature\b[^.]{0,80}\bfit\w*\b/i, why: '"temperature" near a fitted width', on: "all"},
  {re: /gaussian\s*(τ|tau)\b/i, why: '"Gaussian τ"', on: "all"},
  {re: /HM2012 sets H\s?I\b/i, why: '"HM2012 sets H I"', on: "all"},
  {re: /\bcells?\s*(=|are)\s*clouds\b/i, why: '"cells = clouds"', on: "all"},
  {re: /\bb\s*(=|is)\s*(the\s*)?temperature\b/i, why: '"b is temperature"', on: "all"},
  // v1 rules changed for v2 (DESIGN_final wins): "component" is the B13 lesson (H4); "hundreds of cells" only for touch (D5);
  // "hot gas" is right for the 10⁶ K stretch, wrong only for O VI gas
  {re: /hundreds of (gas )?cells/i, why: '"hundreds of cells" making dips or shadows (only ovi_n_visible do)', on: "all",
    test: s => /hundreds of (gas )?cells[^.]{0,60}\b(dip|shadow|absorb|merge|take)/i.test(s) || /\b(dip|shadow)s?[^.]{0,40}hundreds of (gas )?cells/i.test(s)},
  {re: /O VI[^.]{0,50}(?<!warm-)\bhot gas\b|(?<!warm-)\bhot gas\b[^.]{0,50}O VI\b(?! nor)/i, why: 'O VI gas called "hot gas" (say warm-hot)', on: "nophys",
    test: s => /O VI[^.]{0,50}(?<!warm-)\bhot gas\b/i.test(s) || (/(?<!warm-)\bhot gas\b[^.]{0,50}O VI\b/i.test(s) && !NEG.test(s))},
  // C_science display fixes
  {re: /hydrogen keeps its electron/i, why: 'H1: "hydrogen keeps its electron" (it is one atom in N)', on: "all"},
  {re: /\bfit(s|ted)?\b[^.]{0,20}\bclouds?\b/i, why: 'H4: "fit ... clouds" (we fit components)', on: "all", test: s => /\bfit(s|ted)?\b[^.]{0,20}\bclouds?\b/i.test(s) && !NEG.test(s)},
  {re: /metals?\b[^.]{0,40}patch/i, why: 'M4: metals make O VI patchy (ion share does)', on: "all", test: s => /metals?\b[^.]{0,40}patch/i.test(s) && !NEG.test(s)},
  {re: /\bblue knot\b/i, why: 'M6: "Blue knot" (it is red on the speed colours; Cold knot)', on: "all"},
  {re: /\bcold knot\b|\bknot\b/i, why: 'review3 science M2: B7e\'s HI_s1 is a cool cloud larger than cloud A, not a "cold knot"', on: "nophys"},
  {re: /blur[^.]{0,30}black dips grey/i, why: 'M9: "blur turns black dips grey" (only narrow ones)', on: "all", test: s => /blur[^.]{0,30}black dips grey/i.test(s) && !/narrow/i.test(s)},
  {re: /light-years away/i, why: 'L1: "light-years away" (the centre is to the side)', on: "all"},
  {re: /\b(a|the) telescope (at|would record)/i, why: 'L2: telescope at the packet (a perfect telescope)', on: "all", test: s => /\b(a|the) telescope (at|would record)/i.test(s) && !/perfect/i.test(s)},
  {re: /\bmean\b[^.]{0,30}\bdip\b|\bdip\b[^.]{0,30}\bmean (speed|velocity)/i, why: 'H2: a mean speed shown as a dip position', on: "all"},
  // R_content §8 / §13
  {re: /too cool for O\s?VI/i, why: '"too cool for O VI"', on: "all"},
  {re: /\bweak\b/i, why: '"weak" (say a smaller dip)', on: "nophys"},
  {re: /the telescope sees/i, why: '"the telescope sees"', on: "all"},
  {re: /\b(glow|glows|glowing|emit|emits|emitting|emission)\b/i, why: '"glows/emits" outside an M1/M2 negation', on: "all",
    test: s => /\b(glow|glows|glowing|emit|emits|emitting|emission)\b/i.test(s) && !NEG.test(s)},
  {re: /closest[^.]{0,40}\bmost\b/i, why: '"closest = most"', on: "all", test: s => /closest[^.]{0,40}\bmost\b/i.test(s) && !NEG.test(s)},
  {re: /\bfirst dip\b[^.]{0,30}\bnearest\b/i, why: '"first dip" meaning nearest', on: "all"},
  {re: /\bwid(e|er|th)\b[^.]{0,30}\d[^.]{0,10}km\/s/i, why: '"wide" with a speed needs FWHM', on: "all", test: s => /\bwid(e|er|th)\b[^.]{0,30}\d[^.]{0,10}km\/s/i.test(s) && !/FWHM/.test(s)},
  // free-text analogies (must come from derive rules)
  {re: /\b(in a (large )?room|football|stadium|olympic|grain of sand|swimming pool|bathtub)\b/i, why: "free-text analogy (generate it from a key by a derive rule)", on: "all"},
];
const NUMWORD = /\b(two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|twenty|thirty|forty|fifty|hundreds?|thousands?|millions?|billions?|dozens?|twice|half|quarter|third|fifth|sixth|tenth)\b/i;

/* ---------------------------------------------------------------- the lint */
/**
 * lintCopy(copy, {data, beats, film, strict}) → {fails: [msg], pending: [key], notes: [msg], checks: [[ok, msg]]}
 * Pure: no file access. `data` is the story JSON (story-data/1 or /2).
 */
export function lintCopy(copy, {data = null, beats = null, film = null, strict = false} = {}) {
  const checks = [], pending = new Set(), notes = [];
  const check = (ok, msg) => { checks.push([!!ok, msg]); return !!ok; };
  const is2 = /story-data\/2/.test(data?.meta?.schema || data?.schema || "");
  const strictKeys = strict || is2;

  check(copy?.schema === "story-copy/2", `schema story-copy/2 (${copy?.schema})`);
  const order = copy.beats_order || [];
  const missing = order.filter(id => !copy[id] || typeof copy[id].display !== "string" || !copy[id].display.trim()
    || !("display_short" in copy[id]) || typeof copy[id].narrative !== "string");
  check(order.length >= 14 && !missing.length, `every beat of beats_order has display, display_short and narrative (${order.length} beats${missing.length ? "; missing: " + missing.join(", ") : ""})`);
  const stray = Object.keys(copy).filter(k => /^B\d/.test(k) && !order.includes(k));
  check(!stray.length, `no beat entries outside beats_order${stray.length ? ": " + stray.join(", ") : ""}`);
  if (beats) {
    const list = Array.isArray(beats) ? beats : beats.beats || [];
    const refs = list.map(b => b.copyRef || b.id).filter(Boolean);
    const unknown = refs.filter(r => !copy[r] && !copy[String(r).split(".")[0]]);
    const unused = order.filter(id => !refs.some(r => r === id || String(r).startsWith(id + ".")));
    check(!unknown.length, `every beats.json copyRef exists in copy.json${unknown.length ? ": " + unknown.join(", ") : ""}`);
    check(!unused.length, `every copy beat is used by beats.json${unused.length ? ": unused " + unused.join(", ") : ""}`);
  }

  /* words and pairing */
  const wordBad = [], pairBad = [];
  for (const {where, o} of lines(copy)) {
    for (const [f, n] of Object.entries(LIMIT)) {
      let s = o[f]; if (typeof s !== "string") continue;
      if (f === "sub" && o.extra?.sub) s += " " + o.extra.sub;
      const w = words(s).length;
      if (w > n || w < 1) wordBad.push(`${where}.${f} (${w} > ${n})`);
    }
    if (typeof o.display === "string" && typeof o.display_short !== "string") pairBad.push(`${where}.display_short`);
    if (typeof o.sub === "string" && typeof o.sub_short !== "string") pairBad.push(`${where}.sub_short`);
  }
  check(!wordBad.length, `word limits display <= 8, display_short <= 5, sub <= 25, sub_short <= 12${wordBad.length ? ": " + wordBad.join(", ") : ""}`);
  check(!pairBad.length, `every display and sub has its phone short form${pairBad.length ? ": missing " + pairBad.join(", ") : ""}`);

  /* strings */
  const all = collect(copy);
  const extra = [];
  const grab = (src, obj) => { const walk = (v, p) => { if (Array.isArray(v)) v.forEach((x, i) => walk(x, `${p}[${i}]`));
    else if (v && typeof v === "object") for (const [k, x] of Object.entries(v)) {
      if (typeof x === "string" && /^(caption|label|title|text|display|sub|aria)$/.test(k)) extra.push({path: `${src}:${p}.${k}`, section: src, field: "display", s: x});
      else walk(x, `${p}.${k}`); } }; walk(obj, ""); };
  if (beats) grab("beats.json", beats);
  if (film) grab("film.json", film);
  const strs = [...all, ...extra];

  /* allow patterns */
  const allow = (copy.lint?.allow || []).map(a => ({re: new RegExp(a.re, "gu"), sections: a.sections || null}));
  const allowWords = (copy.lint?.allow_words || []).map(a => new RegExp(a.re, "giu"));
  const inSec = (path, secs) => !secs || secs.some(sec => path === sec || path.startsWith(sec + ".") || path.startsWith(sec + "["));

  const numBad = [], numWordBad = [], tplBad = [], banned = [], sepBad = [], vocabBad = [];
  const live = new Set((copy.live?.fields || []).map(x => x.replace(/^\$/, "")));
  const contract = new Set([...(copy.keys_contract?.design_3_6 || []), ...Object.keys(copy.keys_contract?.requested_by_copy || {})]);
  const derived = deriveKeys(copy, data);
  const derivedNames = new Set(Object.keys(copy.derive || {}).filter(k => k !== "about"));
  for (const {path, field, s} of strs) {
    for (const h of sepHits(s)) sepBad.push(`${path} (${h.what})`);
    const tpls = [...s.matchAll(/\{\{\s*([^}]*?)\s*\}\}/g)].map(m => m[1]);
    for (const t of tpls) {
      if (/^(ncross|n_cells)$/.test(t) || /(^|_)(v?mean|mean_v)(_|$)/.test(t)) { banned.push(`${path}: {{${t}}}`); continue; }
      if (t.startsWith("$")) { if (!live.has(t.slice(1))) tplBad.push(`${path}: {{${t}}} not in live.fields`); continue; }
      if (derivedNames.has(t)) { for (const k of copy.derive[t].from) if (resolveInput(k, data) == null) (contract.has(k) ? pending.add(k) : tplBad.push(`${path}: derive input ${k}`)); continue; }
      if (resolveKey(t, data) != null) continue;
      if (contract.has(t)) pending.add(t); else tplBad.push(`${path}: {{${t}}}`);
    }
    // numbers: strip templates and allowed patterns of this section
    let bare = s.replace(/\{\{[^}]*\}\}/g, " ");
    for (const a of allow) if (inSec(path, a.sections)) bare = bare.replace(a.re, " ");
    if (/[0-9⁰¹²³⁴⁵⁶⁷⁸⁹]/.test(bare)) numBad.push(`${path}: "${s.slice(0, 60)}"`);
    if (!/^(credits|meta)/.test(path)) {
      let w = s.replace(/\{\{[^}]*\}\}\s*(million|thousand)/g, " ");
      for (const a of allowWords) w = w.replace(a, " ");
      const m = w.match(NUMWORD); if (m) numWordBad.push(`${path}: "${m[0]}" in "${s.slice(0, 60)}"`);
    }
    // vocabulary
    const disp = ["display", "display_short", "chip"].includes(field), sub = ["sub", "sub_short"].includes(field), phys = field === "physics";
    for (const r of VOCAB) {
      const on = r.on === "all" || (r.on === "display" && disp) || (r.on === "display+sub" && (disp || sub)) || (r.on === "nophys" && !phys);
      if (on && (r.test ? r.test(s) : r.re.test(s))) vocabBad.push(`${path}: ${r.why} in "${s.slice(0, 70)}"`);
    }
  }
  check(!numBad.length, `no literal numbers outside {{key}} templates (${strs.length} strings)${numBad.length ? `: ${numBad.slice(0, 6).join("; ")}` : ""}`);
  check(!numWordBad.length, `number words only in reviewed phrases (lint.allow_words)${numWordBad.length ? `: ${numWordBad.slice(0, 6).join("; ")}` : ""}`);
  check(!banned.length, `ncross, n_cells and mean-velocity keys absent from copy${banned.length ? ": " + banned.join(", ") : ""}`);
  check(!tplBad.length, `every template resolves (data, derive, live, or keys_contract)${tplBad.length ? ": " + tplBad.slice(0, 8).join("; ") : ""}`);
  if (pending.size) {
    const msg = `keys from keys_contract not yet in the story data (${pending.size}): ${[...pending].join(", ")}`;
    if (strictKeys) check(false, msg); else notes.push("pending " + msg);
  } else check(true, "every contract key the copy uses exists in the story data");
  check(!sepBad.length, `no dot separators${sepBad.length ? ": " + sepBad.slice(0, 6).join("; ") : ""}`);
  check(!vocabBad.length, `wording lint (${VOCAB.length} rules)${vocabBad.length ? ` (${vocabBad.length}): ${vocabBad.slice(0, 6).join("; ")}` : ""}`);

  /* flags */
  const flags = new Set(Object.keys(copy.flags || {}).filter(k => k !== "about"));
  const whenBad = [];
  const scanWhen = (v, p) => { if (Array.isArray(v)) v.forEach((x, i) => scanWhen(x, `${p}[${i}]`));
    else if (v && typeof v === "object") for (const [k, x] of Object.entries(v)) { if (k === "when" && !flags.has(x)) whenBad.push(`${p}: ${x}`); scanWhen(x, `${p}.${k}`); } };
  for (const id of order) scanWhen(copy[id], id);
  check(!whenBad.length, `every when-flag is declared in copy.flags${whenBad.length ? ": " + whenBad.join(", ") : ""}`);
  if (data?.flags) { const nb = [...flags].filter(f => f in data.flags && typeof data.flags[f] !== "boolean");
    check(!nb.length, `story data flags are booleans${nb.length ? ": " + nb.join(", ") : ""}`); }

  /* presence of the science fixes (regressions) */
  const J = id => JSON.stringify(copy[id] ?? "");
  const has = (id, re) => re.test(J(id));
  const pres = [
    ["H1 B5 one hydrogen atom in N, with the warm-hot comparison", has("B5", /One hydrogen atom in \{\{cloudA_xHI_one_in\}\}/) && has("B5", /\{\{hot_xHI_one_in\}\}/) && has("B5", /\{\{xHI_ratio(_shown)?\}\}/)],
    ["H2 B7e positions from minima keys", has("B7e", /\{\{b7e_hi_v\}\}/) && has("B7e", /\{\{b7e_ovi_v\}\}/)],
    // review2 science M1: B9 quotes new spectral MINIMA (b9_new_minima), never the dtau-peak key b9_new_dips, and no "fast"
    ["H3 B9 claims b9_new_minima, B8 claims no new dip", has("B9", /\{\{b9_new_minima\}\}/) && !has("B9", /\{\{b9_new_dips\}\}/) && !has("B9", /away fast|moves away from us fast/) && !has("B8", /new (O VI )?dips?/i)],
    ["H3/G13 B9 minima keys are minima of the partial spectrum at the end of B9", !data?.facts2?.b9_new_minima || data.facts2.b9_new_minima.every(([v]) => (data.facts2.b9_minima_end || []).some(([u]) => u === v)) && data.facts2.b9_new_minima.every(([v]) => !(data.facts2.b9_minima_start || []).some(([u, dep]) => Math.abs(u - v) <= 10 && dep >= 0.15))],
    ["H4 B13 components, not clouds, not cells", has("B13", /We fit a few \*components/) && has("B13", /Components are not clouds/) && has("B13", /clouds are not cells/i)],
    ["H4 B9 thread is the clearest of {{n_pairs}}", has("B9", /clearest of \{\{n_pairs\}\}/)],
    ["M1 B5 E2 values bound to the core cell keys", has("B5", /\{\{cloudA_core_T\}\}/) && has("B5", /\{\{cloudA_core_bH\}\}/) && has("B5", /\{\{cloudA_core_bO\}\}/)],
    ["M2 B6 subtracts the galaxy's motion (v_gal)", has("B6", /subtract/) && has("B6", /\{\{v_gal\}\}/)],
    ["M3 B10 damping wings above the core regime", has("B10", /damping wings/) && /damping wings/.test(JSON.stringify(copy.dock || {}))],
    ["M4 film: metals an ingredient, not the switch", /ingredient, not the switch/.test(copy.film?.captions?.lookback || "")],
    ["M5 B7c both sides with fade keys and held-fixed note", has("B7c", /Too hot/) && has("B7c", /Too cool/) && has("B7c", /\{\{ovi_T_hot_fade\}\}/) && has("B7c", /\{\{ovi_T_cool_fade\}\}/) && has("B7c", /held fixed/)],
    ["M6 + review3 science M2: B7e is a second cool cloud (chip Cool cloud)", copy.B7e?.chip === "Cool cloud" && /second cool cloud/.test(copy.B7e?.sub || "") && /at its densest/.test(copy.B7e?.sub || "")],
    ["M7 B3/B4/B5 depths bound", has("B3", /\{\{b3_ovi_depth\}\}/) && has("B4", /\{\{b4_first_depth\}\}/) && has("B5", /\{\{b5_ovi_drop\}\}/) && !has("B5", /\{\{b5_ovi_depth\}\}/)],   // review2 science M3: light removed over B5, said as coming next
    ["M8 n_kernels and n_crossed in the Physics layer", /\{\{n_kernels\}\}[^"]*\{\{n_crossed\}\}/.test(JSON.stringify(copy.physics_layer || {}))],
    ["M9 B12a narrow black dips grey", has("B12a", /Blur turns \*narrow\* black dips grey/)],
    ["L1 B8 centre to the side", has("B8", /to the side/)],
    ["L2 B1 a perfect telescope", has("B1", /perfect telescope/)],
    ["L3 plaque prints Z in Z⊙", /\{\{\$cell\.Z\}\} Z⊙/.test(JSON.stringify(copy.plaque || {}))],
    ["L4 B12b pixels per resolution element", has("B12b", /\{\{pix_per_resel\}\} pixels per resolution element/)],
    ["L7 B14 story-lite honesty line", has("B14", /"when":"lite"/) && has("B14", /did not make it/)],
    ["film captions for every chunk", ["open", "outskirts", "cloudA", "too_hot", "cell263", "thread", "cloudD", "lookback", "telescope", "fit", "end"].every(k => copy.film?.captions?.[k])],
  ];
  const pBad = pres.filter(([, ok]) => !ok).map(([m]) => m);
  check(!pBad.length, `science fixes present (${pres.length})${pBad.length ? ": missing " + pBad.join("; ") : ""}`);

  const H = (copy.honesty || []).join(" ");
  const honesty = [[/snapshot/, "frozen snapshot"], [/expansion of space/, "Hubble flow"], [/heat only/, "thermal-only b"], [/Milky Way/, "no foreground"],
    [/second transition/, "O VI 1037 off axis"], [/Gaussian[^.]*COS|COS[^.]*Gaussian/, "Gaussian LSF + COS"], [/noise draw/, "one noise draw"],
    [/pixels per resolution element/, "pixel rule"], [/time-warped/, "time warp"], [/colours are our choice/, "fog colours"], [/smoothing kernels/, "beads are kernels"],
    [/cannot be picked/, "splats not pickable"], [/density level we chose/, "O VI cloud level"], [/lower limits/, "warm-hot extents"], [/motion cue/, "star streaks"]];
  const hBad = honesty.filter(([re]) => !re.test(H)).map(([, m]) => m);
  check(!hBad.length, `honest-simplification list covers DESIGN_final §3.7 (${honesty.length})${hBad.length ? ": missing " + hBad.join(", ") : ""}`);
  const C = JSON.stringify(copy.credits || {});
  check(/Lucchini/.test(C) && /CREST/.test(C) && /vortrace[^"]*not used/.test(C), "credits name Lucchini et al. and CREST and state vortrace is not used");
  check((copy.rules?.analogies || []).length > 0 && copy.rules.analogies.every(a => a.status && a.basis), "every analogy is registered with a basis and a review status");

  /* derive rules give the documented values */
  const dv = [[RULES.one_in(["0.09"]), "ten"], [RULES.one_in(["5×10⁻⁶"]), "200 000"], [RULES.ratio_1sf(["0.09", "5×10⁻⁶"]), "20 000"],
    [RULES.fraction_words(["24.7"]), "a quarter"], [RULES.fraction_words(["37"]), "37 %"], [RULES.light_myr(["493"]), "1.6"],
    [parseNum("−69.31"), -69.31], [parseNum("22 723"), 22723], [parseNum("1.60×10¹²"), 1.6e12]];
  const dBad = dv.filter(([a, b]) => (typeof b === "number" ? Math.abs(a - b) > 1e-9 * Math.abs(b) : a !== b)).map(([a, b]) => `${a} != ${b}`);
  check(!dBad.length, `derive rules and number parsing${dBad.length ? ": " + dBad.join(", ") : ""}`);

  /* render with the real keys */
  if (data) {
    const rBad = [];
    const liveDummy = Object.fromEntries([...live].map(k => [k, "7"]));
    for (const {path, s} of all) {
      const r = render(s, data, derived, liveDummy);
      if (r.includes("{{")) continue;           // pending keys: reported above
      if (/undefined|NaN|\[object|(^|\s)–(\s|$)/.test(r)) rBad.push(`${path}: "${r.slice(0, 60)}"`);
    }
    check(!rBad.length, `strings render with the story keys without holes${rBad.length ? ": " + rBad.slice(0, 6).join("; ") : ""}`);
    const sample = render(copy.B5?.then?.[0]?.display ?? "", data, derived);
    notes.push(`sample render B5.1: "${sample}"`);
  }
  return {checks, fails: checks.filter(([ok]) => !ok).map(([, m]) => m), pending: [...pending], notes};
}

/* ---------------------------------------------------------------- self-test fixtures */
export function selfTest(copy, ctx) {
  const clone = () => JSON.parse(JSON.stringify(copy));
  const cases = [
    ["literal number", c => { c.B3.sub = "The beam touches 672 gas cells."; }],
    ["ncross in copy", c => { c.B11.physics += " The beam crosses {{ncross}} cells."; }],
    ["nine-word display", c => { c.B1.display = "This light left a quasar a long time ago."; }],
    ["we fit a few clouds", c => { c.B13.display = "We fit a few clouds."; }],
    ["hydrogen keeps its electron", c => { c.B5.display = "A cool clump: hydrogen keeps its electron."; }],
    ["unknown key", c => { c.B8.sub = "Its centre is {{no_such_key}} light-years to the side."; }],
    ["dot separator", c => { c.ui.fly = "Fly · now"; }],
    ["free-text analogy", c => { c.B3.sub = "Like one atom in a large room."; }],
    ["typed number word", c => { c.B7b.sub = "This one cell holds a quarter of all the O VI on the beam."; }],
    ["missing short form", c => { delete c.B2.display_short; }],
    ["blue knot", c => { c.B7e.chip = "Blue knot"; }],
  ];
  return cases.map(([name, mut]) => { const c = clone(); mut(c); return [name, lintCopy(c, ctx).fails.length > 0]; });
}

/* ---------------------------------------------------------------- CLI */
async function main() {
  const {pos, opt} = parseArgs(process.argv.slice(2));
  const DIR = resolve(pos[0] || join(REPO, "docs/tng50"));
  const ROOTD = join(DIR, opt.story || "learn/how-a-spectrum-is-made");
  const F = join(ROOTD, "copy.json");
  const {check, note, finish} = checker();
  if (!existsSync(F)) {
    if (process.env.STORY_REQUIRE === "1") { check(false, `copy.json present at ${F}`); process.exit(finish()); }
    console.log(`skipped: no ${F}`); process.exit(0);
  }
  const rd = f => JSON.parse(readFileSync(f, "utf8"));
  let copy; try { copy = rd(F); } catch (e) { check(false, `copy.json parses (${e.message.slice(0, 80)})`); process.exit(finish()); }
  let data = null, dataFile = opt.data ? resolve(opt.data) : null;
  if (!dataFile && existsSync(join(ROOTD, "data/index.json"))) {
    const idx = rd(join(ROOTD, "data/index.json")); const d = idx.default || {};
    const st = (idx.stories || []).find(s => String(s.galaxy) === String(d.galaxy) && s.ray === d.ray) || (idx.stories || [])[0];
    if (st) dataFile = join(ROOTD, "data", st.story);
  }
  if (dataFile && existsSync(dataFile)) { data = rd(dataFile); note(`story data ${dataFile.replace(DIR + "/", "")} (${data.meta?.schema || data.schema || "?"})`); }
  else check(false, `story data found (${dataFile || "data/index.json"})`);
  const beats = existsSync(join(ROOTD, "beats.json")) ? rd(join(ROOTD, "beats.json")) : null;
  const film = existsSync(join(ROOTD, "film.json")) ? rd(join(ROOTD, "film.json")) : null;
  const ctx = {data, beats, film, strict: process.env.COPY_STRICT === "1"};
  const res = lintCopy(copy, ctx);
  for (const [ok, msg] of res.checks) check(ok, msg);
  for (const n of res.notes) note(n);
  for (const [name, caught] of selfTest(copy, ctx)) check(caught, `self-test: seeded defect "${name}" is caught`);
  // the page path: every copy string through the shell's own resolveTemplate (engine.js) with the derive lookup.
  // ROOT js/copy/derive.js (browser copy of the pure helpers above) is used when present, after a parity check.
  if (data && existsSync(join(ROOTD, "js/engine.js"))) {
    const {resolveTemplate} = await import(pathToFileURL(join(ROOTD, "js/engine.js")).href);
    let lookupOf = copyLookup;
    const DJ = join(ROOTD, "js/copy/derive.js");
    if (existsSync(DJ)) {
      const M = await import(pathToFileURL(DJ).href);
      const same = Object.keys(RULES).every(k => M.RULES?.[k]) && JSON.stringify(M.deriveKeys(copy, data)) === JSON.stringify(deriveKeys(copy, data))
        && JSON.stringify(M.copyFlags?.(copy, data)) === JSON.stringify(copyFlags(copy, data));
      check(same, "ROOT js/copy/derive.js has every rule and derives the same keys as the lint");
      lookupOf = M.copyLookup || copyLookup;
    } else note("ROOT js/copy/derive.js absent: the shell must merge copy.derive values into its lookup (see U_copy.md)");
    const lookup = lookupOf(copy, data), miss = [];
    for (const {path, s} of collect(copy)) {
      const r = resolveTemplate(s, lookup); const m = r.missing.filter(k => !k.startsWith("$")); if (m.length) miss.push(`${path}: ${m.join(",")}`);
    }
    check(!miss.length, `every copy line resolves through the shell's resolveTemplate with the derive lookup${miss.length ? ": " + miss.slice(0, 6).join("; ") : ""}`);
    const fl = copyFlags(copy, data), declared = Object.keys(copy.flags || {}).filter(k => k !== "about");
    const unset = declared.filter(f => !(f in fl));
    note(`flags for this story: ${declared.filter(f => f in fl).map(f => `${f}=${fl[f]}${typeof data.flags?.[f] === "boolean" ? "" : "*"}`).join(", ")}` +
      ` (* = copy fallback rule)${unset.length ? `; not exported, so false (conservative branch): ${unset.join(", ")}` : ""}`);
    // every story in data/index.json, with its own flags: only the lines the shell would show (activeStrings) must render
    // cleanly. Page stories (index.stories) are checks; film beams (index.film_beams, the film's beams cut) are notes
    // unless COPY_STRICT_BEAMS=1. The holes check above covers every string of the default story regardless of flags.
    const IX = join(ROOTD, "data/index.json");
    if (existsSync(IX)) {
      const idx = rd(IX);
      const runs = [...(idx.stories || []).map(s => [s, true]), ...(idx.film_beams || []).map(s => [s, process.env.COPY_STRICT_BEAMS === "1"])];
      for (const [st, hard] of runs) {
        const f = join(ROOTD, "data", st.story); if (!existsSync(f)) { (hard ? check : (_, m) => note("beam: " + m))(false, `${st.story} present`); continue; }
        const d = rd(f), fl = {...copyFlags(copy, d), ...(d.flags || {})}, lk = lookupOf(copy, d), bad = [];
        for (const {path, s} of activeStrings(copy, fl, beats)) {
          const r = resolveTemplate(s, lk), m = r.missing.filter(k => !k.startsWith("$"));
          if (m.length) bad.push(`${path}: {{${m.join(",")}}}`);
          else if (/undefined|NaN|\[object|(^|\s)–(\s|$)|\bin one keeps\b/.test(r.text)) bad.push(`${path}: "${r.text.slice(0, 70)}"`);
        }
        const msg = `${st.role ? "film beam " + st.role : "page story"} ${st.ray}: the lines its flags show render without holes${bad.length ? ` (${bad.length}): ` + bad.slice(0, 5).join("; ") : ""}`;
        if (hard) check(!bad.length, msg); else note(`${bad.length ? "WARN " : "ok   "}${msg}`);
      }
    }
  }
  process.exit(finish());
}
if (import.meta.url === pathToFileURL(process.argv[1] || "").href) await main();
