// copy/derive.js: browser-safe copy.json helpers (no DOM, no node imports). Keys and flags are a verbatim extract of the
// pure helpers in tests/js/story_copy_lint.mjs (the lint checks parity); the copy resolver below is the one every consumer uses.
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

// copy resolver (story-copy/3, DESIGN_tierA 7.1): one choice for every consumer. Contract: notes/story3/U_R5a.md
export const VARIANT_TEXT = ["display", "display_short", "sub", "sub_short", "narrative", "physics", "hint"];
const VISIBLE = VARIANT_TEXT.slice(0, 4), HOLE = /undefined|NaN|\[object|(^|\s)–(\s|$)|\bin one keeps\b/;
const on = (flags, f) => !!(flags && flags[f] === true);
export const whenHolds = (when, flags) => when == null || [].concat(when).every(el => String(el).split("|")
  .some(t => (t[0] === "!" ? !on(flags, t.slice(1)) : on(flags, t))));
export function storyCase(data) {
  const c = data && data.case, id = c && typeof c === "object" ? c.declared || c.id : typeof c === "string" ? c : null;
  return id && id !== "generic" ? id : null;
}
// case stories (R5b): copy.cases.stories[caseId].lines[id] = [overlay, ...] are tried before the shared copy; a case that
// lists a line id owns it (no overlay applies -> the line shows nothing, never a hero line). An overlay may carry `when`
// and `claims` (each must have story claims[k].pass === true, read from ctx.claims or lookup.claims) and inherits the
// entry's physics/hint unless it sets them. Beats only case stories use (B7p, B10w, B12n) live in copy.cases.beats.
/** attachCases: copy.cases.json (story-copy-cases/1) onto the shared copy, in place; only a case story loads it. */
export function attachCases(copy, file) {
  if (copy && file && typeof file === "object") copy.cases = {common: file.common || {}, stories: file.stories || {}, beats: file.beats || {}};
  return copy;
}
export const caseOf = (copy, cid) => (cid && copy && copy.cases && copy.cases.stories && copy.cases.stories[cid]) || null;
export function caseLines(copy, cid, id) {
  const c = caseOf(copy, cid), own = c && c.lines && c.lines[id], com = c && !own && copy.cases.common && copy.cases.common[id];
  return Array.isArray(own) ? own : Array.isArray(com) ? com : null;
}
export function claimsHold(claims, ctx = {}) {
  if (claims == null) return true;
  const fromData = ctx.lookup && ctx.lookup.claims;
  const g16 = ctx.lookup && ctx.lookup.gates_case && ctx.lookup.gates_case.G16;   // case_rule: the declared case passed G16
  return [].concat(claims).every(k => (ctx.claims && k in ctx.claims ? ctx.claims[k] === true
    : k === "case_rule" ? !!(g16 && g16.pass === true) : !!(fromData && fromData[k] && fromData[k].pass === true)));
}
export function lineEntry(copy, id) {
  if (!copy || id == null) return null;
  id = String(id);
  if (copy[id] && typeof copy[id] === "object") return copy[id];
  if (copy.cases && copy.cases.beats && copy.cases.beats[id]) return copy.cases.beats[id];
  const dot = id.indexOf("."), base = dot < 0 ? null : copy[id.slice(0, dot)], suf = id.slice(dot + 1);
  if (!base || typeof base !== "object") return null;
  if (suf === "0") return base;
  const t = Array.isArray(base.then) ? base.then.find(x => x && x.id === id) : null;
  if (t) return t;
  if (base.states && base.states[suf]) return base.states[suf];
  return base[suf] && typeof base[suf] === "object" && (base[suf].display || base[suf].sub) ? base[suf] : null;
}
const keep = (o, drop) => Object.fromEntries(Object.entries(o).filter(([k]) => !drop.includes(k)));
const NOT_BASE = [...VARIANT_TEXT, "variants", "when", "else"];
export function candidates(e) {
  if (!e || typeof e !== "object") return [];
  const out = (Array.isArray(e.variants) ? e.variants : []).map((v, k) => v && typeof v === "object" &&
    {tag: `variants[${k}]`, case: v.case ?? null, when: v.when ?? null, value: {...keep(e, NOT_BASE), ...keep(v, ["case", "when"])}}).filter(Boolean);
  if (e.when != null && "else" in e) out.push({tag: "main", case: null, when: e.when, value: e},
    {tag: "else", case: null, when: null, value: e.else && typeof e.else === "object" ? {...keep(e, NOT_BASE), ...e.else} : null});
  else out.push({tag: "base", case: null, when: e.when ?? null, value: e});
  return out;
}
const blank = v => !v || (v.display == null && v.sub == null && v.narrative == null && ("display" in v || "sub" in v));
export const hasHole = (v, lookup) => !!(v && lookup) && VISIBLE.some(f => typeof v[f] === "string" &&
  (r => /\{\{\s*[^$}][^}]*\}\}/.test(r) || HOLE.test(r))(render(v[f], lookup)));
export const extrasOf = e => [].concat((e && e.extra) || []).filter(x => x && typeof x === "object");
const INHERIT = ["physics", "hint"];
/* overlay candidates; `from` = the shared line the same flags would show (its physics/hint are inherited) */
export function overlayCandidates(e, list, cid, from = null) {
  return (list || []).map((v, k) => v && typeof v === "object" && {tag: `case[${k}]`, case: cid, when: v.when ?? null, claims: v.claims ?? null,
    overlay: true, value: {...keep(e || {}, [...NOT_BASE, "extra"]), ...Object.fromEntries(INHERIT.filter(f => from && from[f] != null).map(f => [f, from[f]])),
      ...keep(v, ["case", "when", "claims", "extra"])}, extra: v.extra}).filter(Boolean);
}
export function pickVariant(e, ctx = {}) {
  const flags = ctx.flags ?? null, cid = ctx.caseId ?? null;
  const ov = flags != null && ctx.overlay ? overlayCandidates(e, ctx.overlay, cid, pickVariant(e, {...ctx, overlay: null, caseId: null}).value) : [];
  const cs = candidates(e);
  if (flags == null) { const c = cs.find(x => x.case == null); return c ? {tag: c.tag, value: c.value} : {tag: null, value: null}; }
  let why = "no candidate applies";
  if (ov.length) {
    for (const c of ov) {
      if (!whenHolds(c.when, flags) || !claimsHold(c.claims, ctx)) continue;
      if (c.value && ctx.lookup && hasHole(c.value, ctx.lookup)) { why = `${c.tag} has a hole`; continue; }
      return {tag: c.tag, value: blank(c.value) ? null : c.value, why: blank(c.value) ? "shows nothing" : null, extra: c.extra};
    }
    return {tag: null, value: null, why: `case lines: ${why}`};
  }
  for (const c of [...cs.filter(x => x.case != null), ...cs.filter(x => x.case == null)]) {
    if (c.case != null && !(cid != null && [].concat(c.case).includes(cid))) continue;
    if (!whenHolds(c.when, flags)) continue;
    if (c.value && ctx.lookup && hasHole(c.value, ctx.lookup)) { why = `${c.tag} has a hole`; continue; }
    return {tag: c.tag, value: blank(c.value) ? null : c.value, why: blank(c.value) ? "shows nothing" : null};
  }
  return {tag: null, value: null, why};
}
export function resolveEntry(e, ctx = {}) {
  const pk = pickVariant(e, ctx); let out = pk.value;
  if (out && ctx.flags != null) for (const x of (pk.tag && pk.tag.startsWith("case[") ? extrasOf({extra: pk.extra}) : extrasOf(e)))
    if (x.sub && whenHolds(x.when, ctx.flags)) out = {...out, sub: out.sub ? `${out.sub} ${x.sub}` : x.sub};
  return out || null;
}
export function resolveLine(copy, id, ctx = {}) {
  const ov = ctx.flags != null ? caseLines(copy, ctx.caseId ?? null, String(id)) : null, c2 = ov ? {...ctx, overlay: ov} : ctx;
  const e = lineEntry(copy, id), r = (e || ov) && resolveEntry(e || {}, c2);
  if ((e || ov) && !r && ctx.flags != null && ctx.onDrop) ctx.onDrop({id: String(id), why: pickVariant(e || {}, c2).why});
  return r || null;
}
/** caseChip: the act chip a case story shows at beats[i] (copy.cases.stories[caseId].chips, nearest earlier beat); null when the
 *  story has no case chips (the shared rule applies). */
export function caseChip(copy, cid, beats, i) {
  const ch = (caseOf(copy, cid) || {}).chips;
  if (!ch) return null;
  for (let k = Math.min(i, (beats || []).length - 1); k >= 0; k--) { const b = beats[k]; if (b && ch[b.id]) return ch[b.id]; }
  return ch.B0 || null;
}
export const beatSkip = flags => b => !!(b && b.cond) && !on(flags, b.cond);
export function activeText(text, flags) {
  const out = [];
  for (const t of text || []) {
    if (t.cond && !on(flags, t.cond)) continue;
    if (t.alt) for (let k = out.length - 1; k >= 0; k--) if (out[k].band === t.band) { out.splice(k, 1); break; }
    out.push(t);
  }
  return out;
}
export function activeLines(copy, beats, ctx = {}) {
  const flags = ctx.flags ?? null, skip = beatSkip(flags), out = [];
  const R = s => (typeof s === "string" ? (ctx.lookup ? render(s, ctx.lookup) : s) : null);
  for (const b of Array.isArray(beats) ? beats : (beats && beats.beats) || []) {
    const sk = skip(b);
    if (sk && !ctx.withSkipped) continue;
    for (const t of activeText(b.text || [], flags)) {
      const e = resolveLine(copy, t.id, ctx), part = t.part || "all", d = part !== "sub", u = part !== "display";
      if (e) out.push({beat: b.id, ...(ctx.withSkipped ? {skip: sk} : {}), id: t.id, band: t.band, part, u0: t.u0, u1: t.u1, entry: e,
        text: {display: d ? R(e.display) : null, display_short: d ? R(e.display_short || e.display) : null, sub: u ? R(e.sub) : null, sub_short: u ? R(e.sub_short) : null}});
    }
  }
  return out;
}
