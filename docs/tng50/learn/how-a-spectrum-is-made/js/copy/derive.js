// copy/derive.js: browser-safe key evaluation for copy.json (U_copy proposal for ROOT js/copy/derive.js; the integrator places it).
// A verbatim extract of the "pure helpers" section of tests/js/story_copy_lint.mjs (the reference). When this file exists under
// ROOT, the lint checks that it derives the same keys and flags, and renders every copy line through engine.js with copyLookup().
// No DOM, no node imports.
// Shell use:  import {copyLookup, copyFlags} from "./copy/derive.js";
//             const lookup = copyLookup(copy, data);   resolveTemplate(str, lookup)   // derived names resolve like data keys
//             const flags = copyFlags(copy, data);     // story JSON flags first, then threshold fallbacks
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

