// Copy lint of the v2 story "How a spectrum is made" (DESIGN_final §5.7 U_copy, gate G10 copy part). No browser.
// Usage: node tests/js/story_copy_lint.mjs [docs/tng50 dir] [--story learn/how-a-spectrum-is-made] [--data <story json>]
//        node tests/js/story_copy_lint.mjs --migrate OUT.json   (writes the mechanical story-copy/3 migration of copy.json)
// Copy resolver (R5a): when ROOT is present the lint also checks that on-screen text (hud.activeText + kinetic.copyEntry),
// the narrative (narrativeItems) and this lint (activeStrings) make the shared resolver's choice (derive.js resolveLine /
// activeLines) under every flag preset, that the v2 consumers fail that check, and that the /3 migration resolves the same.
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
import {readFileSync, writeFileSync, existsSync, readdirSync} from "node:fs";
import {join, resolve} from "node:path";
import {pathToFileURL} from "node:url";
import {ROOT as REPO, parseArgs, checker, sepHits} from "./lib/browser.mjs";
// the one copy resolver (DESIGN_tierA §7.1, R5a): the lint, kinetic/hud, narrative and the director all call it
import {pickVariant, resolveLine, extrasOf, whenHolds, candidates, lineEntry, activeLines, beatSkip as dBeatSkip,
  activeText as dActiveText, VARIANT_TEXT, caseLines, caseChip, claimsHold, caseOf, attachCases} from "../../docs/tng50/learn/how-a-spectrum-is-made/js/copy/derive.js";
import {narrativeItems as narItems} from "../../docs/tng50/learn/how-a-spectrum-is-made/js/ui/narrative.js";

/** whenFlags: the flag names a `when` mentions (string or AND array; "!f"; "a|b"). */
export const whenFlags = when => (when == null ? [] : [].concat(when)).flatMap(el => String(el).split("|"))
  .map(t => t.replace(/^!/, "")).filter(Boolean);
/** migrateEntry: the mechanical story-copy/2 -> /3 step (DESIGN_tierA 7.1): {when: f, ...main, else: E} becomes
 *  {...E text, ...non-text keys, variants: [{when: f, ...main text}]}; else null -> base display/sub null;
 *  extra {...} -> [{...}]; then[] and states{} recurse. Pure; the resolver reads both forms the same (migrationParity). */
export function migrateEntry(e) {
  if (!e || typeof e !== "object" || Array.isArray(e)) return e;
  let out;
  if (e.when != null && "else" in e) {
    const main = {when: e.when};
    for (const f of VARIANT_TEXT) if (f in e) main[f] = e[f];
    const E = e.else && typeof e.else === "object" ? e.else : {display: null, sub: null};
    out = {};
    let placed = false;
    for (const [k, v] of Object.entries(e)) {
      if (k === "when" || k === "else") continue;
      if (VARIANT_TEXT.includes(k)) { if (!placed) { for (const f of VARIANT_TEXT) if (f in E) out[f] = E[f]; placed = true; } continue; }
      out[k] = v;
    }
    if (!placed) for (const f of VARIANT_TEXT) if (f in E) out[f] = E[f];
    out.variants = [main, ...(Array.isArray(e.variants) ? e.variants : [])];
  } else out = {...e};
  if (out.extra && !Array.isArray(out.extra)) out.extra = [out.extra];
  if (Array.isArray(out.then)) out.then = out.then.map(migrateEntry);
  if (out.states && typeof out.states === "object") out.states = Object.fromEntries(Object.entries(out.states).map(([k, v]) => [k, migrateEntry(v)]));
  return out;
}
/** migrateCopy: story-copy/2 -> /3 (beat entries in beats_order migrate; other sections are kept). /3 is returned as is.
 *  CLI: node tests/js/story_copy_lint.mjs --migrate OUT.json writes the migration of ROOT/copy.json. */
export function migrateCopy(copy) {
  if (!copy || copy.schema !== "story-copy/2") return copy;
  const order = copy.beats_order || [];
  return Object.fromEntries(Object.entries(copy).map(([k, v]) => [k, k === "schema" ? "story-copy/3" : order.includes(k) ? migrateEntry(v) : v]));
}

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
      if (["id", "when", "when_live", "u", "act_title", "beats", "case", "claims"].includes(k)) continue;
      if (section === "cases" && ["about", "story", "letters", "budget"].includes(k)) continue;   // builder notes, ids, numbers
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
/** activeStrings: the beat strings a story actually shows, through the shared copy resolver (derive.js pickVariant, the same
    choice kinetic/hud and narrative make): a beat whose beats.json `cond` is false is skipped; each line shows the first
    candidate that applies (`variants` by case, then by `when`, then the base; a /2 `when` false shows its `else`, null =
    nothing); `extra` counts only when its `when` holds; B7c `states` are alternatives chosen live, so all count.
    A missing flag is false (conservative branch). opt = {caseId}. Returns [{path, s}]. Pure. */
export function activeStrings(copy, flags, beats = null, opt = {}) {
  const out = [], fl = flags || {}, cid = opt.caseId ?? null;
  const skip = new Set(((beats && beats.beats) || []).filter(b => b && b.cond && dBeatSkip(fl)(b)).map(b => b.copyRef || b.id));
  const line = (o, path, id) => {
    const ov = caseLines(copy, cid, id);   // a case story's own lines (copy.cases, R5b) come first
    if ((!o || typeof o !== "object") && !ov) return;
    o = o && typeof o === "object" ? o : {};
    const pk = pickVariant(o, {flags: fl, caseId: cid, overlay: ov, lookup: opt.lookup, claims: opt.claims}), {tag, value} = pk;
    const at = tag === "main" || tag === "base" || tag == null ? path : `${path}.${tag}`;
    if (value) for (const f of LINE_FIELDS) if (typeof value[f] === "string") out.push({path: `${at}.${f}`, s: value[f]});
    const ex = tag && tag.startsWith("case[") ? extrasOf({extra: pk.extra}) : extrasOf(o);
    if (value) for (const [k, x] of ex.entries()) if (whenHolds(x.when, fl))
      for (const f of LINE_FIELDS) if (typeof x[f] === "string") out.push({path: `${path}.extra${Array.isArray(o.extra) ? `[${k}]` : ""}.${f}`, s: x[f]});
    if (o.states) for (const [k, st] of Object.entries(o.states)) line(st, `${path}.states.${k}`, `${id}.${k}`);
    (o.then || []).forEach((t, i) => line(t, `${path}.then[${i}]`, (t && t.id) || `${id}.${i + 1}`));
  };
  const ids = [...(copy.beats_order || []), ...(cid && caseOf(copy, cid) ? Object.keys((copy.cases && copy.cases.beats) || {}) : [])];
  const inDoc = new Set(((beats && beats.beats) || []).map(b => b.copyRef || b.id));
  for (const id of ids) if (!skip.has(id) && (!copy.beats_order.includes(id) ? !beats || inDoc.has(id) : true))
    line(copy[id] || (copy.cases && copy.cases.beats && copy.cases.beats[id]), copy[id] ? id : `cases.beats.${id}`, id);
  return out;
}
/** the line objects of a beat: entry, then[k], else blocks, states, extras (for limits and pairing). */
function lines(copy) {
  const out = [];
  for (const id of copy.beats_order || []) {
    const b = copy[id]; if (!b) continue;
    const push = (o, where) => { if (o && typeof o === "object") out.push({beat: id, where, o}); };
    const all = (o, where) => { push(o, where); if (o && typeof o === "object") { push(o.else, `${where}.else`);
      (Array.isArray(o.variants) ? o.variants : []).forEach((v, k) => push(v && {...v, extra: o.extra}, `${where}.variants[${k}]`)); } };
    all(b, id);
    (b.then || []).forEach((t, k) => all(t, t.id || `${id}.${k + 1}`));
    for (const [k, st] of Object.entries(b.states || {})) all(st, `${id}.states.${k}`);
  }
  for (const {where, o} of caseOverlays(copy)) out.push({beat: where, where, o});
  return out;
}
/** every case overlay (copy.cases, R5b): {where, id, caseId (null = common), k, o}; plus the case-only beats' base lines. */
export function caseOverlays(copy) {
  const C = copy.cases || {}, out = [];
  const add = (list, id, cid, where) => (Array.isArray(list) ? list : []).forEach((o, k) => { if (o && typeof o === "object") out.push({where: `${where}[${k}]`, id, caseId: cid, k, o}); });
  for (const [id, list] of Object.entries(C.common || {})) add(list, id, null, `cases.common.${id}`);
  for (const [cid, st] of Object.entries(C.stories || {})) for (const [id, list] of Object.entries(st.lines || {})) add(list, id, cid, `cases.stories.${cid}.lines.${id}`);
  for (const [id, o] of Object.entries(C.beats || {})) if (o && typeof o === "object") out.push({where: `cases.beats.${id}`, id, caseId: null, k: null, o, base: true});
  return out;
}

/* ---------------------------------------------------------------- wording rules */
const NEG = /\b(not|never|no|nor|cannot|n't|neither)\b/i;
const VOCAB = [
  // v1 (story_static) rules kept
  {re: /\bline\b/i, why: 'bare "line" (say sightline or dip)', on: "display"},
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
  {re: /O VI[^.]{0,50}(?<!warm-)\bhot gas\b|(?<!warm-)\bhot gas\b[^.]{0,50}O VI\b(?! nor)/i, why: 'O VI gas called "hot gas" (say warm-hot)', on: "nophys", cases: false,
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
  // Tier A (DESIGN_tierA §3 public words, §7.1 guards); cases: true = only the case lines (copy.cases)
  {re: /\bwarm-hot\b/i, why: '"warm-hot" in case copy (public words: cool gas, hot gas)', on: "nophys", cases: true},
  {re: /\bevery ion\b/i, why: '"every ion" (say every line; DESIGN_tierA 7.1)', on: "all", cases: true},
  {re: /\bno hydrogen\b|\bwithout hydrogen\b|hydrogen is (absent|missing)/i, why: '"no hydrogen" (faint is not absent)', on: "nophys"},
  {re: /\bride\b/i, why: 'the word "ride" (owner style)', on: "all"},
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

  check(copy?.schema === "story-copy/2" || copy?.schema === "story-copy/3", `schema story-copy/2 or /3 (${copy?.schema})`);
  const order = copy.beats_order || [];
  // a beat needs a full line in at least one candidate (/3: a beat whose base shows nothing carries it in a variant)
  const fullLine = v => v && typeof v.display === "string" && v.display.trim() && "display_short" in v && typeof v.narrative === "string";
  const missing = order.filter(id => !copy[id] || !candidates(copy[id]).some(c => fullLine(c.value)));
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
      if (f === "sub") for (const x of extrasOf(o)) if (x.sub) s += " " + x.sub;
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
      if (path.startsWith("cases")) continue;   // case lines render against their own story (lintCaseStory)
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
    const inCases = path.startsWith("cases");
    for (const r of VOCAB) {
      if ((r.cases === true && !inCases) || (r.cases === false && inCases)) continue;
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
    else if (v && typeof v === "object") for (const [k, x] of Object.entries(v)) { if (k === "when") for (const f of whenFlags(x)) if (!flags.has(f)) whenBad.push(`${p}: ${f}`); if (k !== "when") scanWhen(x, `${p}.${k}`); } };
  for (const id of order) scanWhen(copy[id], id);
  const caseIds = new Set([...CASE_IDS, ...Object.keys(copy.cases || {})]), caseBad = [];
  const scanCase = (o, p) => { if (!o || typeof o !== "object") return;
    (Array.isArray(o.variants) ? o.variants : []).forEach((v, k) => { for (const c of [].concat(v?.case ?? [])) if (!caseIds.has(c)) caseBad.push(`${p}.variants[${k}]: ${c}`); });
    (o.then || []).forEach((t, i) => scanCase(t, `${p}.then[${i}]`)); for (const [k, st] of Object.entries(o.states || {})) scanCase(st, `${p}.states.${k}`); };
  for (const id of order) scanCase(copy[id], id);
  check(!caseBad.length, `every variant case is a story case${caseBad.length ? ": " + caseBad.join(", ") : ""}`);
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
    ["M6 + review3 science M2: B7e is a second cool cloud (chip Cool cloud)", copy.B7e?.chip === "Cool cloud" && candidates(copy.B7e).some(c => /second cool cloud/.test(c.value?.sub || "") && /at its densest/.test(c.value?.sub || ""))],
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
      if (path.startsWith("cases")) continue;   // case lines render against their own story (lintCaseStory)
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
/* ---------------------------------------------------------------- one resolver, every consumer (DESIGN_tierA §7.1, R5a) */
export const CASE_IDS = ["clean_single", "multiphase", "damped", "empty", "hot_only"];
const J = v => JSON.stringify(v ?? null);
const plainText = s => String(s || "").replace(/\*([^*]+)\*/g, "$1");
/** every line id of the copy: top-level beats, then items, states. */
export function lineIds(copy) {
  const ids = [];
  for (const id of copy.beats_order || []) {
    const b = copy[id]; if (!b) continue; ids.push(id);
    (b.then || []).forEach(t => t && t.id && ids.push(t.id));
    for (const k of Object.keys(b.states || {})) ids.push(`${id}.${k}`);
  }
  return ids;
}
/** flagPresets: the flag sets the parity and migration checks run: the default story's flags, all false, all true, the
 *  default with each declared flag flipped, every staged story's own flags, and the default under each case id. */
export function flagPresets(copy, baseFlags, stories = []) {
  const declared = Object.keys(copy.flags || {}).filter(k => k !== "about"), out = [];
  out.push({name: "default", flags: {...baseFlags}});
  out.push({name: "all-false", flags: {}});
  out.push({name: "all-true", flags: Object.fromEntries(declared.map(f => [f, true]))});
  for (const f of declared) out.push({name: `flip ${f}`, flags: {...baseFlags, [f]: !(baseFlags[f] === true)}});
  for (const st of stories) out.push(st);
  for (const c of CASE_IDS) out.push({name: `case ${c}`, flags: {...baseFlags}, caseId: c});
  return out;
}
/** consumerParity: for each preset, the on-screen consumer (hud.activeText + kinetic.copyEntry), the narrative
 *  (narrativeItems) and the lint (activeStrings) must make the resolver's choice (derive.js activeLines / resolveLine):
 *  same slots, same entries, same skipped beats, same narrative beats and titles, and every shown string is linted.
 *  M = {K: kinetic, NAR: narrative, HUD: hud, resolveTemplate}. Returns ["preset: problem", ...]. */
export function consumerParity(copy, beatsDoc, presets, M) {
  const bad = [], beats = (beatsDoc && beatsDoc.beats) || [];
  const R = (s, lk) => (s ? (lk ? M.resolveTemplate(s, lk).text : s) : "");
  for (const P of presets) {
    const {flags, caseId = null, lookup = null} = P, ctx = {flags, caseId, lookup}, tag = m => bad.push(`${P.name}: ${m}`);
    const AL = activeLines(copy, beatsDoc, ctx), key = x => `${x.beat}|${x.id}|${x.part}|${x.band}`;
    const want = new Map(AL.map(x => [key(x), x]));
    // 1. on screen: hud slot filter + beat skip + kinetic entry
    const skipH = M.HUD.beatSkip(flags), skipD = dBeatSkip(flags), seen = new Set();
    for (const b of beats) {
      if (skipH(b) !== skipD(b)) tag(`${b.id} beat skip differs (hud ${skipH(b)})`);
      if (skipH(b)) continue;
      const slotsH = M.HUD.activeText(b.text || [], flags), slotsD = dActiveText(b.text || [], flags);
      if (J(slotsH.map(t => t.id)) !== J(slotsD.map(t => t.id))) tag(`${b.id} text slots differ`);
      for (const t of slotsH) {
        const e = M.K.copyEntry(copy, t.id, flags, {caseId, lookup}), k = `${b.id}|${t.id}|${t.part || "all"}|${t.band}`;
        if (!e) { if (want.has(k)) tag(`${t.id} kinetic drops a line the resolver shows`); continue; }
        seen.add(k);
        if (!want.has(k)) tag(`${t.id} kinetic shows a line the resolver drops`);
        else if (J(e) !== J(want.get(k).entry)) tag(`${t.id} kinetic entry differs from resolveLine`);
      }
    }
    for (const k of want.keys()) if (!seen.has(k)) tag(`${k} resolver line not on screen`);
    // 2. narrative: the beats the story plays, each with its resolved line
    const N = M.NAR.narrativeItems(beats, copy, lookup, flags, {caseId});
    const nTxt = e => plainText(R(e && (e.narrative || [e.display, e.sub].filter(Boolean).join(" ")), lookup));
    const expN = beats.filter(b => !skipD(b)).map(b => ({b, e: resolveLine(copy, b.copyRef || b.id, ctx)}))
      .map(({b, e}) => {
        let title = plainText(R(e && e.display, lookup)), text = nTxt(e);
        // fix1 (N1): an empty main line reads the beat's active sub-lines instead
        if (!title && !text && flags != null) {
          const main = b.copyRef || b.id, subs = dActiveText(b.text || [], flags).filter(t => t && t.id !== main).map(t => resolveLine(copy, t.id, ctx)).filter(Boolean);
          title = plainText(R((subs.find(x => x.display) || {}).display, lookup));
          text = subs.map(nTxt).filter(Boolean).join(" ");
        }
        return {id: b.id, title, text};
      })
      .filter(x => x.title || x.text);
    if (J(N.map(x => [x.id, x.title, x.text])) !== J(expN.map(x => [x.id, x.title, x.text]))) {
      const a = N.map(x => x.id), z = expN.map(x => x.id);
      tag(`narrative differs from the resolver (${J(a) === J(z) ? "same beats, other text" : `beats ${a.filter(i => !z.includes(i)).concat(z.filter(i => !a.includes(i))).join(",")}`})`);
    }
    // 3. lint: every string the screen shows is one the lint checks
    const linted = new Set(activeStrings(copy, flags, beatsDoc, {caseId, lookup}).map(x => x.s));
    for (const x of AL) {
      const e = lineEntry(copy, x.id), pk = pickVariant(e || {}, {...ctx, overlay: caseLines(copy, caseId, x.id)}), {value} = pk;
      const ex = pk.tag && pk.tag.startsWith("case[") ? extrasOf({extra: pk.extra}) : extrasOf(e);
      const shown = [...(value ? ["display", "display_short", "sub", "sub_short"].map(f => value[f]) : []),
        ...ex.filter(y => whenHolds(y.when, flags)).map(y => y.sub)].filter(v => typeof v === "string");
      for (const v of shown) if (!linted.has(v)) tag(`${x.id} shows a string the lint does not check: "${v.slice(0, 40)}"`);
    }
  }
  return bad;
}
/** LEGACY_CONSUMERS: the v2 shell's consumers (8557cac): kinetic ignored `when`/`else`, narrative listed every beat's
 *  main line. The parity self-test feeds them to consumerParity, which must report them. */
export const LEGACY_CONSUMERS = {
  K: {copyEntry: (copy, id, flags) => { const e = lineEntry(copy, id);
    if (!e || !e.extra || Array.isArray(e.extra) || !e.extra.sub || !(flags && flags[e.extra.when] === true)) return e;
    return {...e, sub: e.sub ? `${e.sub} ${e.extra.sub}` : e.extra.sub}; }},
  NAR: {narrativeItems: (beats, copy) => (beats || []).map(b => { const c = copy[b.copyRef || b.id] || {};
    return {id: b.id, p0: b.p0, title: plainText(c.display), text: plainText(c.narrative || [c.display, c.sub].filter(Boolean).join(" "))}; })
    .filter(x => x.title || x.text)},
};
/** migrationParity: migrateCopy(copy) must resolve every line id to the same visible text as copy under every preset,
 *  give the same activeStrings, and migrate idempotently. Returns ["preset: problem", ...]. */
export function migrationParity(copy, beatsDoc, presets) {
  const v3 = migrateCopy(copy), bad = [], vis = e => (e ? VARIANT_TEXT.map(f => e[f] ?? null) : null);
  if (copy.schema === "story-copy/2" && v3.schema !== "story-copy/3") bad.push("migrateCopy did not produce story-copy/3");
  if (J(migrateCopy(v3)) !== J(v3)) bad.push("migrateCopy is not idempotent");
  if (lineIds(v3).some(id => { const e = lineEntry(v3, id); return e && "else" in e; })) bad.push("an else block survived migration");
  for (const P of presets) {
    const ctx = {flags: P.flags, caseId: P.caseId ?? null};
    for (const id of lineIds(copy)) if (J(vis(resolveLine(copy, id, ctx))) !== J(vis(resolveLine(v3, id, ctx)))) bad.push(`${P.name}: ${id} resolves differently after migration`);
    const a = activeStrings(copy, P.flags, beatsDoc, ctx).map(x => x.s), z = activeStrings(v3, P.flags, beatsDoc, ctx).map(x => x.s);
    if (J(a) !== J(z)) bad.push(`${P.name}: activeStrings differ after migration`);
  }
  for (const id of lineIds(copy))
    if (J(vis(resolveLine(copy, id, {flags: null}))) !== J(vis(resolveLine(v3, id, {flags: null})))) bad.push(`primary: ${id} differs after migration`);
  return [...new Set(bad)];
}

/** resolverUnit: the resolver contract on hand-made entries -> [[ok, name]]. */
export function resolverUnit() {
  const F = {a: true, b: false, c: true}, d = (e, ctx) => { const r = resolveLine({X: e}, "X", ctx); return r && r.display; };
  const lk = {keys: {k: "7", dash: "–"}};
  const V3 = {display: "base", display_short: "b", variants: [{when: "b", display: "w-b"}, {when: ["a", "!b"], display: "w-ab"},
    {case: "damped", display: "case"}, {case: ["empty", "hot_only"], when: "b", display: "case-b"}]};
  return [
    [whenHolds("a", F) && !whenHolds("b", F) && !whenHolds("zz", F) && whenHolds("!zz", F), "when: string, missing flag false, !"],
    [whenHolds(["a", "c"], F) && !whenHolds(["a", "b"], F) && whenHolds(["b|c"], F) && whenHolds("b|!zz", F) && whenHolds(null, F), "when: AND list, a|b, absent holds"],
    [!whenHolds("a", {a: "true"}) && !whenHolds("a", null), "when: only === true holds"],
    [d(V3, {flags: F}) === "w-ab", "variants: first when that holds wins over the base"],
    [d(V3, {flags: F, caseId: "damped"}) === "case", "variants: a case variant comes before when variants"],
    [d(V3, {flags: F, caseId: "empty"}) === "w-ab" && d(V3, {flags: {b: true}, caseId: "hot_only"}) === "case-b", "variants: case list, case + when both needed"],
    [d(V3, {flags: {}}) === "base" && d(V3, {flags: null}) === "w-b", "base when nothing applies; flags null = first case-free candidate"],
    [resolveLine({X: {when: "b", display: "m", else: null}}, "X", {flags: F}) === null, "/2 else null shows nothing"],
    [d({when: "b", display: "m", else: {display: "e"}}, {flags: F}) === "e" && d({when: "a", display: "m", else: {display: "e"}}, {flags: F}) === "m", "/2 when/else"],
    [(e => resolveLine({X: e}, "X", {flags: F}) === e)({when: "a", display: "m", else: null}), "/2 main branch is the entry object itself (H0)"],
    [d({display: "base {{k}}", variants: [{when: "a", display: "v {{nokey}}"}]}, {flags: F, lookup: lk}) === "base {{k}}", "hole: a missing key falls back"],
    [d({display: "v {{dash}} x", variants: []}, {flags: F, lookup: lk}) == null && d({display: "v {{$live}}"}, {flags: F, lookup: lk}) === "v {{$live}}", "hole: '–' drops; live {{$x}} is not a hole"],
    [(r => r.sub === "s e1 e3")(resolveLine({X: {display: "x", sub: "s", extra: [{when: "a", sub: "e1"}, {when: "b", sub: "e2"}, {when: "!b", sub: "e3"}]}}, "X", {flags: F})), "extra list appends in order"],
    [(r => r.sub === "s")(resolveLine({X: {display: "x", sub: "s", extra: {when: "a", sub: "e"}}}, "X", {flags: null})), "flags null takes no extra"],
    [(() => { const got = []; resolveLine({X: {display: null, sub: null}}, "X", {flags: F, onDrop: x => got.push(x.id)}); return got.join() === "X"; })(), "onDrop hears a dropped line"],
    [lineEntry({B5: {then: [{id: "B5.1", display: "t"}]}, B7c: {states: {hot: {display: "h"}}}}, "B5.1").display === "t" &&
     lineEntry({B7c: {states: {hot: {display: "h"}}}}, "B7c.hot").display === "h" && lineEntry({B5: {}}, "B5.0") && !lineEntry({}, "B9"), "line ids: then, states, .0, unknown"],
    [J(migrateEntry({chip: "c", when: "a", display: "m", sub: "ms", physics: "p", else: {display: "e", sub: "es"}, then: [{id: "X.1", when: "b", display: "t", else: null}]})) ===
     J({chip: "c", display: "e", sub: "es", then: [{id: "X.1", display: null, sub: null, variants: [{when: "b", display: "t"}]}], variants: [{when: "a", display: "m", sub: "ms", physics: "p"}]}), "migration: mechanical shape"],
  ];
}

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
    ["variant names an undeclared flag", c => { c.B4.variants = [{when: ["hi_black", "!no_such_flag|lite"], display: "A line.", display_short: "A line."}]; }],
    ["variant names an unknown case", c => { c.B4.variants = [{case: "dwarf_galaxy", display: "A dwarf.", display_short: "A dwarf."}]; }],
    ["nine-word variant display", c => { c.B4.variants = [{when: "hi_black", display: "This light left a quasar a long time ago.", display_short: "Old light."}]; }],
    // Tier A case copy (R5b): visible words the owner and DESIGN_tierA ban, in a case line
    ...(copy.cases ? [
      ["warm-hot in a case line", c => { c.cases.common.B13[0].sub = "Each warm-hot component has an amount."; }],
      ["the word ride", c => { c.cases.common.B14[0].display = "Ride another beam."; }],
      ["glow in a case line", c => { c.cases.stories.empty.lines.B11[0].sub = "The halo glows faintly."; }],
      ["every ion in a case line", c => { c.cases.stories.clean_single.lines["B5.1"][0].sub = "Every ion dips at about {{c1_v}} km/s."; }],
      ["no hydrogen in a case line", c => { c.cases.stories.hot_only.lines.B11[0].sub = "There is no hydrogen here."; }],
      ["dot separator in an act chip", c => { c.cases.stories.clean_single.chips.B5 = "The cloud · A"; }],
      ["nine-word case display", c => { c.cases.common.B3[0].display = "Every single cell has a density, a heat and speed."; }],
      ["literal number in a case line", c => { c.cases.stories.empty.lines.B13[0].sub = "At most 13.5 in O VI."; }],
    ] : []),
  ];
  return cases.map(([name, mut]) => { const c = clone(); mut(c); return [name, lintCopy(c, ctx).fails.length > 0]; });
}

/* ---------------------------------------------------------------- Tier A case copy (R5b, DESIGN_tierA §3, §5, §7.1, G16) */
/** CASE_CLAIMS: the claims a case line may declare (story-data/3 claims.<k>.pass); case_rule = the declared case passed G16. */
export const CASE_CLAIMS = ["case_rule", "c1_v", "hi_black_single", "ovi_grey", "fit_dex", "cool_v", "warm_v", "has_phase_offset",
  "nothing_between", "page_fit_2comp", "narrow", "no_ovi_in_cool", "hi_black_core", "wing_frac", "hi_fit_dhi", "hi_damped",
  "resolve_saturated", "hi_encounter_80", "limits", "noise_dip", "hi_faint", "has_neviii", "ovi_hot_share", "ovi_trough_broad"];
/** TIER_FLAGS: story-data/3 flags a case line's `when` may read beyond copy.flags (R1; main.js merges data.flags). */
export const TIER_FLAGS = ["gas_poor", "bridge_ion", "hi_lls", "hi_damped", "same_galaxy_next", "has_phase_offset", "hi_faint", "empty_faint",
  "resolve_saturated", "near_disk", "hi_detected", "ovi_detected", "lowion_detected", "has_gap_AB", "has_gap_BC", "has_stop_cell"];
/** CLAIM_GUARDS (G16): words that make a claim. A case line whose text matches must declare one of `any` (or read `flag` in its
 *  when); `cases` scopes a guard to case ids; `only` = the words may appear only in those cases. */
export const CLAIM_GUARDS = [
  {re: /\balready black\b/i, any: ["hi_black_single", "hi_black_core"], why: "hydrogen is already black"},
  {re: /\bblack\b/i, any: ["hi_black_core"], cases: ["damped"], why: "damped: black"},
  {re: /\bwings?\b/i, any: ["hi_damped", "wing_frac"], why: "wings"},
  {re: /\bstill counts?\b|\bgrey\b/i, any: ["ovi_grey"], cases: ["clean_single"], why: "clean: O VI still counts / grey"},
  {re: /\bnarrow\b/i, any: ["narrow"], cases: ["multiphase"], why: "multiphase: narrow"},
  {re: /\bbroad\b/i, any: ["ovi_trough_broad"], cases: ["hot_only", "multiphase"], why: "broad"},
  {re: /nothing (sits |lies )?between/i, any: ["nothing_between"], why: "nothing between them"},
  {re: /\bfaint hydrogen\b|\bhydrogen stays faint\b|\bstays faint\b|\bfaint, not\b/i, any: ["hi_faint"], why: "faint hydrogen"},
  {re: /\bNe VIII\b/, any: ["has_neviii"], why: "Ne VIII"},
  {re: /\bupper limit\b|\bat most\b/i, any: ["limits"], why: "an upper limit"},
  {re: /\bis noise\b|\bnoise alone\b/i, any: ["noise_dip"], why: "the dip is noise"},
  {re: /\b(holds|has|with) little gas\b|\bgas-poor\b/i, flag: "gas_poor", why: "gas-poor"},
  {re: /different speeds|move apart|km\/s apart/i, any: ["has_phase_offset"], why: "two speeds"},
  {re: /\bit is right\b|\blands within\b|\blands close\b/i, any: ["fit_dex", "hi_fit_dhi"], why: "the fit is right"},
  {re: /\bnot enough\b|\btwo components\b/i, any: ["page_fit_2comp"], cases: ["multiphase"], why: "the fit needs two components"},
  {re: /\bno cool clump\b/i, any: ["case_rule"], cases: ["hot_only"], only: ["hot_only"], why: "no cool clump"},
  {re: /\balmost nothing\b/i, any: ["case_rule"], only: ["empty"], why: "almost nothing"},
  {re: /\bone (clean )?dip\b|\bevery line dips\b/i, any: ["c1_v"], cases: ["clean_single"], why: "clean: one dip at one speed"},
  {re: /\bsits in hot gas\b|\btoo hot for\b/i, any: ["ovi_hot_share", "hi_faint"], cases: ["hot_only"], why: "hot: too hot for hydrogen"},
];
/** SHARED_OK: line ids a case story may show from the full tour's copy (no overlay): wording that holds on any beam. */
export const SHARED_OK = ["B0", "B1.1", "B14.1"];
const textOf = o => ["display", "display_short", "sub", "sub_short"].map(f => (o && typeof o[f] === "string" ? o[f] : "")).join(" ").replace(/\*/g, "");
/** guardProblems(o, caseId): the guards a line breaks -> ["why", ...] (claims declared statically, not evaluated). */
export function guardProblems(o, caseId) {
  const t = textOf(o), declared = new Set([].concat(o.claims || [])), when = new Set(whenFlags(o.when)), bad = [];
  for (const g of CLAIM_GUARDS) {
    if (!g.re.test(t)) continue;
    if (g.only && !(caseId && g.only.includes(caseId))) { bad.push(`${g.why} (only in ${g.only.join("/")})`); continue; }
    if (g.cases && caseId && !g.cases.includes(caseId)) continue;
    if (g.cases && !caseId) { if (!g.any || !g.any.some(k => declared.has(k))) bad.push(`${g.why} in a common line`); continue; }
    if (g.flag && !when.has(g.flag)) bad.push(`${g.why} needs when ${g.flag}`);
    if (g.any && !g.any.some(k => declared.has(k))) bad.push(`${g.why} needs claims ${g.any.join("|")}`);
  }
  return bad;
}
/** caseStatic(copy): checks on every overlay, shown or not: claims named, when-flags declared, guards, letters, chips. */
export function caseStatic(copy) {
  const C = copy.cases || {}, checks = [], flags = new Set([...Object.keys(copy.flags || {}), ...TIER_FLAGS]);
  const check = (ok, msg) => checks.push([!!ok, msg]);
  const ov = caseOverlays(copy), claimBad = [], whenBad = [], guardBad = [], letterBad = [];
  for (const {where, caseId, o} of ov) {
    for (const k of [].concat(o.claims || [])) if (!CASE_CLAIMS.includes(k)) claimBad.push(`${where}: ${k}`);
    for (const f of whenFlags(o.when)) if (!flags.has(f)) whenBad.push(`${where}: ${f}`);
    for (const p of guardProblems(o, caseId)) guardBad.push(`${where}: ${p}`);
    if (/\bcloud [A-D]\b/i.test(textOf(o))) letterBad.push(`${where}: "${textOf(o).slice(0, 40)}"`);
  }
  check(!claimBad.length, `case lines name only known claims (${CASE_CLAIMS.length})${claimBad.length ? ": " + claimBad.join(", ") : ""}`);
  check(!whenBad.length, `case lines read only declared flags (copy.flags + story-data/3)${whenBad.length ? ": " + whenBad.join(", ") : ""}`);
  check(!guardBad.length, `G16 claim guards: every claiming word in a case line declares its claim (${ov.length} lines, ${CLAIM_GUARDS.length} guards)${guardBad.length ? ": " + guardBad.slice(0, 6).join("; ") : ""}`);
  check(!letterBad.length, `case lines name no cloud letter (letters come from the story's data)${letterBad.length ? ": " + letterBad.join("; ") : ""}`);
  const chipBad = [];
  for (const [cid, st] of Object.entries(C.stories || {})) {
    if (!CASE_IDS.includes(cid)) chipBad.push(`${cid}: not a case id`);
    for (const [b, t] of Object.entries(st.chips || {})) if (typeof t !== "string" || words(t).length > 3 || /[0-9]|\bcloud [A-D]\b/i.test(t)) chipBad.push(`${cid}.${b}: "${t}"`);
    if (!st.chips || !st.chips.B0) chipBad.push(`${cid}: no chips.B0`);
    if (!(st.budget > 0 && st.budget <= 1)) chipBad.push(`${cid}: budget ${st.budget}`);
  }
  check(!chipBad.length, `case stories: known case ids, act chips of at most three words with no digits or letters, a word budget${chipBad.length ? ": " + chipBad.join(", ") : ""}`);
  return checks;
}
const HOLE_TXT = /undefined|NaN|\[object|\{\{|(^|\s)–(\s|$)|\bin one keeps\b/;
/** storyLetters: the cloud letters a story letters (gates_case.G15_data.letters), empty for the empty case. */
export const storyLetters = data => new Set(((data && data.gates_case && data.gates_case.G15_data && data.gates_case.G15_data.letters) || []).map(l => l.letter));
/** lintCaseStory: one Tier A story through the shared resolver -> {checks, words, lines, drops}.
 *  S = {caseId, data, beats, heroWords, flags?, claims?, name?}; flags/claims override the data for matrix presets
 *  (then claims are not evaluated against data, the budget and timing checks are skipped). */
export function lintCaseStory(copy, S) {
  const checks = [], check = (ok, msg) => checks.push([!!ok, `${S.name || S.caseId}: ${msg}`]);
  const st = caseOf(copy, S.caseId) || {}, data = S.data, preset = !!(S.flags || S.claims);
  const flags = S.flags || {...copyFlags(copy, data), ...(data.flags || {})}, lookup = copyLookup(copy, data);
  const truth = S.truth ? copyLookup(copy, S.truth) : lookup;   // claims are judged on this data (self-test: a consumer fed other claims)
  const drops = [], ctx = {flags, caseId: S.caseId, lookup, claims: S.claims, onDrop: d => drops.push(d)};
  const AL = activeLines(copy, S.beats, ctx), letters = storyLetters(data), beats = (S.beats && S.beats.beats) || [];
  const leak = [], claimBad = [], guardBad = [], holes = [], letterBad = [];
  let W = 0;
  for (const x of AL) {
    const ov = caseLines(copy, S.caseId, x.id), pk = pickVariant(lineEntry(copy, x.id) || {}, {...ctx, overlay: ov});
    const k = pk.tag && pk.tag.startsWith("case[") ? +pk.tag.slice(5, -1) : -1, o = k >= 0 ? ov[k] : null;
    if (!o && !SHARED_OK.includes(x.id)) leak.push(x.id);
    if (o && !preset && !claimsHold(o.claims, {lookup: truth})) claimBad.push(`${x.id} (${[].concat(o.claims).join(",")})`);
    if (o) for (const p of guardProblems(o, S.caseId)) guardBad.push(`${x.id}: ${p}`);
    const txt = Object.values(x.text).filter(v => typeof v === "string").join(" | ");
    if (HOLE_TXT.test(txt)) holes.push(`${x.id}: "${txt.slice(0, 50)}"`);
    for (const m of txt.matchAll(/\bcloud ([A-D])\b/gi)) if (!letters.has(m[1].toUpperCase())) letterBad.push(`${x.id}: cloud ${m[1]}`);
    if (x.text.display) W += words(x.text.display).length;
    if (x.text.sub) W += words(x.text.sub).length;
  }
  check(!leak.length, `no full-tour line leaks into the case story (only ${SHARED_OK.join(", ")} are shared)${leak.length ? ": " + leak.join(", ") : ""}`);
  if (!preset) check(!claimBad.length, `G16: every shown case line's claims pass on this story's data${claimBad.length ? ": " + claimBad.join(", ") : ""}`);
  check(!guardBad.length, `G16 guards hold on the shown lines${guardBad.length ? ": " + guardBad.join("; ") : ""}`);
  check(!holes.length, `shown lines render without holes ("–", {{key}}, NaN)${holes.length ? ": " + holes.join("; ") : ""}`);
  const holeDrops = drops.filter(d => /hole/.test(d.why || ""));
  check(!holeDrops.length, `no case line is lost to a hole (a missing or "–" key)${holeDrops.length ? ": " + holeDrops.map(d => `${d.id} (${d.why})`).join(", ") : ""}`);
  // letters: shown lines and act chips name only the story's own letters (empty: none)
  const chipTxt = beats.map((b, i) => caseChip(copy, S.caseId, beats, i));
  chipTxt.forEach((c, i) => { if (!c) letterBad.push(`${beats[i].id}: no act chip`); else for (const m of c.matchAll(/\bcloud ([A-D])\b/gi)) if (!letters.has(m[1].toUpperCase())) letterBad.push(`chip ${beats[i].id}: ${c}`); });
  check(!letterBad.length, `letter guard: lines and act chips name only lettered clouds (${letters.size ? [...letters].join("") : "none"})${letterBad.length ? ": " + letterBad.join(", ") : ""}`);
  // fix1 (review perf N1): every beat that shows a line on screen has a screen-reader narrative item
  const narIds = new Set(narItems(beats, copy, lookup, flags, {caseId: S.caseId}).map(x => x.id));
  const shownBeats = [...new Set(AL.filter(x => x.text.display || x.text.sub).map(x => x.beat))];
  const narMiss = shownBeats.filter(id => !narIds.has(id));
  check(!narMiss.length, `every beat with visible text has a narrative item${narMiss.length ? ": " + narMiss.join(", ") : ""}`);
  // halfway: the full tour's "Halfway" only where the B8 window holds the nearest point (l = 0); "Past ..." only after it
  const b8 = beats.find(b => b.id === "B8"), l8 = b8 ? [Math.min(b8.l0, b8.l1), Math.max(b8.l0, b8.l1)] : null, half = [];
  for (const x of AL.filter(y => y.beat === "B8")) {
    const t = `${x.text.display || ""} ${x.text.sub || ""}`;
    if (/\bhalfway\b/i.test(t) && !(l8 && l8[0] <= 0 && l8[1] >= 0)) half.push(`"Halfway" at l ${l8 && l8.join("..")}`);
    if (/\bpast the galaxy/i.test(t) && !(l8 && l8[0] > 0)) half.push(`"Past the galaxy" at l ${l8 && l8.join("..")}`);
  }
  check(!half.length, `B8 words match where the beam is (nearest point l = 0)${half.length ? ": " + half.join(", ") : ""}`);
  if (!preset && S.heroWords) {
    const cap = Math.floor((st.budget || 1) * S.heroWords);
    check(W <= cap, `word budget ${W} <= ${Math.round((st.budget || 1) * 100)} % of the full tour (${cap} of ${S.heroWords}, display + sub)`);
  }
  // first words in time (DESIGN_tierA §5 first-60 s line): t = start of the beat + u0 of the line
  const t0 = {}; let acc = 0; for (const b of beats) { t0[b.id] = acc; acc += b.watch_s || 0; }
  const when = x => t0[x.beat] + (x.u0 || 0) * ((beats.find(b => b.id === x.beat) || {}).watch_s || 0);
  const first = re => { const x = AL.find(y => re.test(`${y.text.display || ""} ${y.text.sub || ""}`)); return x ? when(x) : Infinity; };
  // empty (copy-owned): "almost nothing" within 10 s is hard; the other first-60 s lines depend on the director's beat
  // lengths (rerun after the copy lands), so they are notes
  const FIRST = {empty: [/almost nothing/i, 10, '"almost nothing"', true], hot_only: [/hot gas/i, 60, "hot gas"], damped: [/wings/i, 60, "wings"],
    clean_single: [/one clean dip|one dip/i, 60, "one dip"], multiphase: [/hot gas/i, 60, "hot gas"]};
  const notes = [];
  if (!preset && FIRST[S.caseId]) { const [re, lim, w, hard] = FIRST[S.caseId], t = first(re);
    const msg = `the words say ${w} by ${lim} s (at ${isFinite(t) ? t.toFixed(1) : "never"} s with the current beats)`;
    if (hard) check(t <= lim, msg); else notes.push(`${t <= lim ? "ok  " : "WARN"} ${S.name || S.caseId}: ${msg}`); }
  return {checks, words: W, lines: AL.length, drops, notes};
}
/** caseMatrix: the lint matrix (DESIGN_tierA 7.1) on one story's data and beats: all-false, all-true, each pair of the
 *  when-flags the case lines read set alone; claims all false, then all true. Returns lintCaseStory checks (preset mode). */
export function caseMatrix(copy, S) {
  const W = [...new Set(caseOverlays(copy).filter(x => x.caseId == null || x.caseId === S.caseId).flatMap(x => whenFlags(x.o.when)))].sort();
  const declared = [...new Set([...Object.keys(copy.flags || {}).filter(k => k !== "about"), ...TIER_FLAGS])];
  const on = fs => Object.fromEntries(declared.map(f => [f, fs.includes(f)]));
  const sets = [["all-false", on([])], ["all-true", on(declared)]];
  for (let i = 0; i < W.length; i++) for (let j = i + 1; j < W.length; j++) sets.push([`${W[i]}+${W[j]}`, on([W[i], W[j]])]);
  const cl = v => Object.fromEntries(CASE_CLAIMS.map(k => [k, v])), out = [];
  for (const [n, f] of sets) for (const [cn, c] of [["claims-false", cl(false)], ["claims-true", cl(true)]])
    out.push(...lintCaseStory(copy, {...S, name: `${S.caseId} ${n} ${cn}`, flags: f, claims: c}).checks);
  return {checks: out, presets: sets.length * 2, flags: W};
}
/** caseSelfTest: seeded case-copy defects that must each fail (stories = {caseId: S}). */
export function caseSelfTest(copy, stories) {
  const clone = () => JSON.parse(JSON.stringify(copy)), fails = (c, cid) => {
    const S = stories[cid]; if (!S) return false;
    return [...caseStatic(c), ...lintCaseStory(c, S).checks].some(([ok]) => !ok);
  };
  const L = (d, s, extra = {}) => ({...extra, display: d, display_short: d, sub: s, sub_short: s});
  const T = [
    ["nothing between them, no claim", "multiphase", c => { c.cases.stories.multiphase.lines.B7p.unshift(L("Same beam, *different speeds.*", "Cool and hot gas, and nothing between them.", {claims: ["has_phase_offset"]})); }],
    ["a cloud letter in the empty halo", "empty", c => { c.cases.stories.empty.lines.B11[0].sub = "Cloud A took almost nothing."; }],
    ["word budget exceeded", "empty", c => { c.cases.stories.empty.budget = 0.1; }],
    // fix1 round 2: the director now drops slots a story's copy leaves empty (B5.2 on the hot beam), so the seeded leak
    // removes a shown common line instead
    ["a full-tour line leaks (the hero's noise line on the hot beam)", "hot_only", c => { delete c.cases.common["B12b.1"]; }],
    ["wings without the damped claim", "damped", c => { delete c.cases.stories.damped.lines["B5.2"][0].claims; }],
    ["broad without ovi_trough_broad", "hot_only", c => { c.cases.stories.hot_only.lines.B7a[0].display = "Hot gas, *a broad O VI dip.*"; }],
    ["Halfway where the beam is past the galaxy", "clean_single", c => { c.cases.stories.clean_single.lines.B8 = [L("Halfway. The galaxy sits beside us.", "Its centre is to the side.")]; }],
    ["a hole in the only case line", "empty", c => { c.cases.stories.empty.lines.B11 = [L("Almost *nothing taken.*", "{{no_such_key}} cells took nothing.", {claims: ["case_rule"]})]; }],
    ["a case line names an unknown claim", "hot_only", c => { c.cases.stories.hot_only.lines.B7a[0].claims = ["ovi_is_hot"]; }],
    ["almost nothing outside the empty case", "hot_only", c => { c.cases.stories.hot_only.lines.B11.unshift(L("Almost nothing here.", "Almost nothing.")); }],
  ];
  const out = T.map(([name, cid, mut]) => { const c = clone(); mut(c); return [name, fails(c, cid)]; });
  // a consumer that shows a line whose claim is false: resolve with fit_dex passing, judge on the real clean data
  const S = stories.clean_single;
  if (S) { const fake = {...S.data, claims: {...S.data.claims, fit_dex: {...(S.data.claims || {}).fit_dex, pass: true}}};
    out.push(["a line shown although its claim is false on the data", lintCaseStory(copy, {...S, data: fake, truth: S.data}).checks.some(([ok, m]) => !ok && /claims pass/.test(m))]); }
  return out;
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
  if (opt.migrate) { writeFileSync(resolve(opt.migrate), JSON.stringify(migrateCopy(copy), null, 2) + "\n"); console.log(`wrote ${opt.migrate}`); process.exit(0); }
  // Tier A case copy (R5b): copy.cases.json rides on the shared copy as copy.cases (as a case story's shell attaches it);
  // its lint.allow entries join copy.lint.allow for the cases section only
  const FC = join(ROOTD, "copy.cases.json");
  if (existsSync(FC)) {
    let cc; try { cc = rd(FC); } catch (e) { check(false, `copy.cases.json parses (${e.message.slice(0, 80)})`); process.exit(finish()); }
    check(cc.schema === "story-copy-cases/1" && cc.stories && cc.common, `copy.cases.json is story-copy-cases/1 with common and stories (${cc.schema})`);
    copy = attachCases(JSON.parse(JSON.stringify(copy)), cc);
    copy.lint = {...(copy.lint || {}), allow: [...((copy.lint && copy.lint.allow) || []), ...(((cc.lint || {}).allow) || []).map(a => ({...a, sections: a.sections || ["cases"]}))]};
  }
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
  for (const [ok, name] of resolverUnit()) check(ok, `resolver: ${name}`);
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
      if (path.startsWith("cases")) continue;   // per Tier A story below
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
      // Tier A entries (case other than "full") never render the hero copy and beats: lintCaseStory below checks them
      // with their own beats.<id>.json and copy.cases, as the page does (main.js loadTierA)
      const runs = [...(idx.stories || []).filter(s => !s.case || s.case === "full").map(s => [s, true]), ...(idx.film_beams || []).map(s => [s, process.env.COPY_STRICT_BEAMS === "1"])];
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
    // one resolver, every consumer (R5a): on screen (hud + kinetic), narrative and this lint make the same choice for
    // every flag preset; the mechanical story-copy/3 migration resolves identically; film captions are reported.
    if (beats && existsSync(join(ROOTD, "js/ui/kinetic.js"))) {
      const imp = f => import(pathToFileURL(join(ROOTD, f)).href);
      const M = {K: await imp("js/ui/kinetic.js"), NAR: await imp("js/ui/narrative.js"), HUD: await imp("js/ui/hud.js"), resolveTemplate};
      const base = {...copyFlags(copy, data), ...(data.flags || {})}, lk0 = lookupOf(copy, data), staged = [];
      if (existsSync(IX)) { const idx = rd(IX);
        for (const st of [...(idx.stories || []), ...(idx.film_beams || [])]) { const f = join(ROOTD, "data", st.story); if (!existsSync(f)) continue;
          const d = rd(f); staged.push({name: `story ${st.ray}`, flags: {...copyFlags(copy, d), ...(d.flags || {})}, lookup: lookupOf(copy, d),
                                        caseId: d.case && typeof d.case === "object" ? (d.case.declared || d.case.id) : null}); } }
      const presets = flagPresets(copy, base, staged).map(P => ({lookup: lk0, ...P}));
      const pb = consumerParity(copy, beats, presets, M);
      check(!pb.length, `one copy resolver: screen, narrative and lint agree (${presets.length} flag presets)${pb.length ? ` (${pb.length}): ` + pb.slice(0, 5).join("; ") : ""}`);
      const caught = consumerParity(copy, beats, presets, {...M, ...LEGACY_CONSUMERS});
      check(caught.length > 0, `self-test: the v2 consumers (when/else ignored, narrative unskipped) fail the parity check (${caught.length} reports)`);
      const mp = migrationParity(copy, beats, presets);
      check(!mp.length, `story-copy/3 migration resolves every line as before (${lineIds(copy).length} lines x ${presets.length + 1} presets)${mp.length ? ": " + mp.slice(0, 5).join("; ") : ""}`);
      if (copy.schema === "story-copy/2") {
        const lv3 = lintCopy(migrateCopy(copy), ctx).checks.filter(([ok]) => !ok).map(([, m]) => m.slice(0, 90));
        check(!lv3.length, `the migrated story-copy/3 passes this lint${lv3.length ? ": " + lv3.slice(0, 3).join("; ") : ""}`);
      }
      const dropped = [];
      for (const P of staged) for (const b of beats.beats || []) if (!dBeatSkip(P.flags)(b)) for (const t of dActiveText(b.text || [], P.flags))
        if (lineEntry(copy, t.id) && !resolveLine(copy, t.id, P)) dropped.push(`${P.name.slice(6, 22)} ${t.id}`);
      note(`slots the page drops on staged stories (nothing applies, or a hole with no fallback): ${dropped.length ? dropped.join(", ") : "none"}`);
      // Tier A case stories (R5b): every story with its own beats and data (hard), the lint matrix, parity, self-tests
      if (copy.cases && copy.cases.stories) {
        for (const [ok, m] of caseStatic(copy)) check(ok, m);
        const heroWords = activeLines(copy, beats, {flags: base, lookup: lk0}).reduce((w, x) => w + words(x.text.display || "").length + words(x.text.sub || "").length, 0);
        const V3 = join(ROOTD, "data/v3"), files = existsSync(V3) ? readdirSync(V3).filter(f => /^story_\d+_.+\.json$/.test(f)).sort() : [];
        const stories = {};
        for (const [cid, st] of Object.entries(copy.cases.stories)) {
          const hits = files.filter(f => { try { const d = rd(join(V3, f)); return d.case && d.case.declared === cid; } catch { return false; } });
          const bf = join(ROOTD, `beats.${st.story}.json`);
          if (hits.length !== 1 || !existsSync(bf)) { check(false, `Tier A ${cid}: one data/v3 story file (${hits.length}) and beats.${st.story}.json (${existsSync(bf)})`); continue; }
          stories[cid] = {caseId: cid, data: rd(join(V3, hits[0])), beats: rd(bf), heroWords, name: `Tier A ${st.story}`};
        }
        const tally = [];
        for (const S of Object.values(stories)) {
          const r = lintCaseStory(copy, S);
          for (const [ok, m] of r.checks) check(ok, m);
          for (const n of r.notes) note(n);
          tally.push(`${S.caseId} ${r.words} words (${Math.round(100 * r.words / heroWords)} %), ${r.lines} lines`);
          const mx = caseMatrix(copy, S), bad = mx.checks.filter(([ok]) => !ok).map(([, m]) => m);
          check(!bad.length, `lint matrix ${S.caseId}: ${mx.presets} presets (all-false, all-true, pairs of ${mx.flags.join(", ")}; claims false and true)${bad.length ? ` (${bad.length}): ` + [...new Set(bad)].slice(0, 4).join("; ") : ""}`);
          const P = {name: `Tier A ${S.caseId}`, flags: {...copyFlags(copy, S.data), ...(S.data.flags || {})}, caseId: S.caseId, lookup: lookupOf(copy, S.data)};
          const pc = consumerParity(copy, S.beats, [P], M);
          const chips = (S.beats.beats || []).every((b, i) => M.HUD.actFor(S.beats.beats, i, copy, S.caseId) === caseChip(copy, S.caseId, S.beats.beats, i));
          check(!pc.length && chips, `one copy resolver on ${S.caseId}: screen, narrative, lint and act chips agree${pc.length ? ": " + pc.slice(0, 3).join("; ") : chips ? "" : ": act chips differ"}`);
        }
        note(`Tier A words (full tour ${heroWords}): ${tally.join("; ")}`);
        for (const [name, caught] of caseSelfTest(copy, stories)) check(caught, `self-test: seeded case-copy defect "${name}" is caught`);
      }
      const vtt = existsSync(join(REPO, "scripts/story_vtt.mjs")) ? readFileSync(join(REPO, "scripts/story_vtt.mjs"), "utf8") : "";
      note(/resolveLine|activeLines/.test(vtt) ? "film captions (story_vtt.mjs) use the copy resolver"
        : "film captions (scripts/story_vtt.mjs, R8): buildCues reads entries itself and ignores variants/when/else; the hero film matches (H0 vtt), but R8 must route it through resolveLine before copy.json moves to story-copy/3");
    }
  }
  process.exit(finish());
}
if (import.meta.url === pathToFileURL(process.argv[1] || "").href) await main();
