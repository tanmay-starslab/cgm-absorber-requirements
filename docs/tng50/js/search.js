// Deterministic sightline search over fitted Voigt components (design-2 §6). JS mirror of tngsight/search.py.
// validateQuery / runQuery / rankAll are pure (no DOM; node-testable). mountFind builds the page's Find panel and is
// the only function that touches the DOM.
// Lower limits (owner decision 2): a NOERR, or SAT but not DAMPED, component is a lower limit at col = min(logN,
// logN_lo) (state.js; the page annotates every catalogue it loads). It meets logN_min when col does, and logN_max only
// when logN_max is absent or at the ion's ceiling; score and reason use col and the reason counts the limits.
import {isLowerLimit, columnOf} from "./state.js";
/* Generated from tngsight/ions.json and tngsight.search.QUERY_SCHEMA by `python -m server.make_chat_tools`.
   Do not edit between the markers. */
/*__GEN:QUERY__*/
export const ION_SHORT = {"HI":"H I","MgII":"Mg II","SiII":"Si II","CII":"C II","SiIII":"Si III","CIII":"C III","SiIV":"Si IV","CIV":"C IV","NV":"N V","OVI":"O VI","NeVIII":"Ne VIII","OVII":"O VII"};
export const ION_LABEL = {"HI":"H I 1216","MgII":"Mg II 2796","SiII":"Si II 1260","CII":"C II 1335","SiIII":"Si III 1206","CIII":"C III 977","SiIV":"Si IV 1403","CIV":"C IV 1548","NV":"N V 1239","OVI":"O VI 1032","NeVIII":"Ne VIII 770","OVII":"O VII 21.6"};
export const ION_LOGN_MAX = {"HI":22.5,"MgII":19.0,"SiII":19.0,"CII":19.0,"SiIII":19.0,"CIII":19.0,"SiIV":19.0,"CIV":19.0,"NV":19.0,"OVI":19.0,"NeVIII":19.0,"OVII":19.0};
export const QUERY_SCHEMA = {"type":"object","additionalProperties":false,"required":["ion"],"properties":{"ion":{"type":"string","enum":["HI","MgII","SiII","CII","SiIII","CIII","SiIV","CIV","NV","OVI","NeVIII","OVII"]},"n_min":{"type":"integer","minimum":0,"maximum":30},"n_max":{"type":"integer","minimum":0,"maximum":30},"sep_kms":{"type":"array","items":{"type":"number","minimum":0,"maximum":3000},"minItems":2,"maxItems":2},"logN_min":{"type":"number","minimum":10,"maximum":22.5},"logN_max":{"type":"number","minimum":10,"maximum":22.5},"b_min":{"type":"number","minimum":0,"maximum":150},"b_max":{"type":"number","minimum":0,"maximum":150},"b_kpc":{"type":"array","items":{"type":"number","minimum":0,"maximum":400},"minItems":2,"maxItems":2},"orientation":{"type":"string","enum":["face-on","edge-on","random","custom"]},"sort":{"type":"string","enum":["score","b_kpc","n"]},"limit":{"type":"integer","minimum":1,"maximum":200}}};
/*__END__*/
export const DEFAULTS = {n_min: 1, sort: "score", limit: 50};   // n_max: unbounded

/* §2 shared number format: round half away from zero at d decimals, printed with exactly d decimals (never "-0"). */
export function roundAway(x, d) { const p = 10 ** d; return Math.sign(x) * Math.floor(Math.abs(x) * p + 0.5) / p + 0; }
export function fmt(x, d) { return roundAway(x, d).toFixed(d); }
const r6 = x => roundAway(x, 6);
const isNum = x => typeof x === "number" && Number.isFinite(x);
const numTxt = v => String(v);

/* messages and check order identical to tngsight.search.validate_query */
function checkValue(name, x, s) {
  if (s.type === "string") { if (typeof x !== "string") throw `${name}: must be a string`;
    if (!s.enum.includes(x)) throw `${name}: must be one of ${s.enum.join(", ")}`; return x; }
  if (s.type === "array") { if (!Array.isArray(x)) throw `${name}: must be an array`;
    if (x.length !== 2) throw `${name}: must have exactly 2 items`;
    const out = x.map((v, i) => checkValue(`${name}[${i}]`, v, s.items));
    if (out[0] > out[1]) throw `${name}: lower bound exceeds upper bound`; return out; }
  if (!isNum(x)) throw s.type === "number" ? `${name}: must be a number` : `${name}: must be an integer`;
  if (s.type === "integer" && x !== Math.floor(x)) throw `${name}: must be an integer`;
  if (x < s.minimum) throw `${name}: must be >= ${numTxt(s.minimum)}`;
  if (x > s.maximum) throw `${name}: must be <= ${numTxt(s.maximum)}`;
  return x;
}
/* -> normalised query (defaults filled in) or {error: "<field>: <reason>"} */
export function validateQuery(q) {
  try {
    if (!q || typeof q !== "object" || Array.isArray(q)) throw "query: must be an object";
    const props = QUERY_SCHEMA.properties;
    for (const k of Object.keys(q).sort()) if (!(k in props)) throw `${k}: unknown field`;
    if (!("ion" in q)) throw "ion: required";
    const out = {};
    for (const [k, spec] of Object.entries(props)) if (k in q) out[k] = checkValue(k, q[k], spec);
    for (const k of ["logN_min", "logN_max"])            // per-ion logN bound (tngsight.search.LOGN_MAX)
      if (k in out && out[k] > ION_LOGN_MAX[out.ion]) throw `${k}: must be <= ${numTxt(ION_LOGN_MAX[out.ion])} for ${out.ion}`;
    for (const [lo, hi] of [["n_min", "n_max"], ["logN_min", "logN_max"], ["b_min", "b_max"]]) {
      const a = out[lo] ?? DEFAULTS[lo];
      if (a != null && hi in out && a > out[hi]) throw `${lo}: exceeds ${hi}`; }
    for (const [k, v] of Object.entries(DEFAULTS)) if (!(k in out)) out[k] = v;
    return out;
  } catch (e) { if (typeof e === "string") return {error: e}; throw e; }
}
function logNOk(c, lo, hi, cap) { return isLowerLimit(c) ? hi >= cap && columnOf(c) >= lo : lo <= c.logN && c.logN <= hi; }
function reason(ion, n, matching, pairs, sep, bKpc) {
  let s = `${n} ${ION_SHORT[ion]} component${n !== 1 ? "s" : ""}`;
  if (matching.length) {
    const lN = matching.map(columnOf), bb = matching.map(c => c.b), nl = matching.filter(isLowerLimit).length;
    s += `, logN ${fmt(Math.min(...lN), 1)}–${fmt(Math.max(...lN), 1)}${nl ? ` (${nl} lower limit${nl !== 1 ? "s" : ""})` : ""}`;
    s += `, b ${fmt(Math.min(...bb), 0)}–${fmt(Math.max(...bb), 0)} km/s`;
  }
  if (sep && pairs.length) s += `, Δv ${fmt(Math.min(...pairs.map(p => p[2])), 0)} km/s`;
  return s + (isNum(bKpc) ? `, ${fmt(bKpc, 0)} kpc` : "");
}
/* Full ranked list (no truncation) or {error}. entries: catalog entries; components: {id: {ion: [comp]}} */
export function rankAll(q, entries, components) {
  const o = validateQuery(q); if (o.error) return o;
  const ion = o.ion, lo = o.logN_min ?? -Infinity, hi = o.logN_max ?? Infinity, bl = o.b_min ?? -Infinity, bh = o.b_max ?? Infinity;
  const byId = new Map(); for (const e of entries) byId.set(e.id, e);      // duplicates: the later entry wins
  const es = [...byId.values()].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)), out = [];
  for (const e of es) {
    const list = components?.[e.id]?.[ion]; if (!Array.isArray(list)) continue;
    if (o.orientation && o.orientation !== e.orientation) continue;
    if (o.b_kpc && !(isNum(e.b_kpc) && o.b_kpc[0] <= e.b_kpc && e.b_kpc <= o.b_kpc[1])) continue;
    const cap = ION_LOGN_MAX[ion], M = [];
    list.forEach((c, idx) => { if (logNOk(c, lo, hi, cap) && bl <= c.b && c.b <= bh) M.push(Object.assign({}, c, {idx})); });
    const n = M.length; if (n < o.n_min || (o.n_max != null && n > o.n_max)) continue;
    let matching = M, P = [];
    if (o.sep_kms) {
      for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) { const dv = r6(Math.abs(M[i].v - M[j].v));
        if (o.sep_kms[0] <= dv && dv <= o.sep_kms[1]) P.push([M[i], M[j], dv]); }
      if (!P.length) continue;
      const used = new Set(); for (const [a, b] of P) { used.add(a.idx); used.add(b.idx); }
      matching = M.filter(c => used.has(c.idx));
    }
    let score = 0, sat = 0;
    for (const c of matching) { score += 1 + Math.min(4, Math.max(0, columnOf(c) - 12)) / 4; if (c.flag & 1) sat++; }
    score += -0.5 * sat + (o.sep_kms ? 0.25 * Math.min(P.length, 4) : 0);
    const pairs = P.map(([a, b, dv]) => [a.idx, b.idx, dv]).sort((x, y) => x[2] - y[2] || x[0] - y[0] || x[1] - y[1])
      .slice(0, 10).map(([i, j, dv]) => [i, j, roundAway(dv, 1)]);
    out.push({id: e.id, score: r6(score), n, b_kpc: e.b_kpc, orientation: e.orientation,
      components: [...matching].sort((a, b) => a.v - b.v || a.idx - b.idx), pairs,
      reason: reason(ion, n, matching, P, !!o.sep_kms, e.b_kpc)});
  }
  const id = (a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  const cmp = {score: (a, b) => b.score - a.score || id(a, b),
    b_kpc: (a, b) => (isNum(a.b_kpc) ? a.b_kpc : Infinity) - (isNum(b.b_kpc) ? b.b_kpc : Infinity) || b.score - a.score || id(a, b),
    n: (a, b) => b.n - a.n || b.score - a.score || id(a, b)}[o.sort];
  return out.sort(cmp);
}
export function runQuery(q, entries, components, opts = {}) {
  const r = rankAll(q, entries, components); if (r.error) return r;
  const o = validateQuery(q); return r.slice(0, opts.limit ?? o.limit);
}

/* ---------------- Find panel (DOM) ---------------- */
export function mountFind(root, app, opts = {}) {
  const doc = root.ownerDocument || document, h = (tag, attrs = {}, ...kids) => { const el = doc.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) if (k === "text") el.textContent = v; else el.setAttribute(k, v);
    for (const c of kids) el.appendChild(c); return el; };
  const num = (id, lab, a) => h("div", {class: "field"}, h("label", {for: id, text: lab}), h("input", Object.assign({id, type: "number", inputmode: "decimal"}, a)));
  const pair = (id, lab, a) => h("div", {class: "field"}, h("span", {class: "lab", text: lab}), h("div", {class: "row", style: "gap:4px;flex-wrap:nowrap"},
    h("input", Object.assign({id: id + "_lo", type: "number", "aria-label": lab + " minimum", placeholder: "min"}, a)),
    h("input", Object.assign({id: id + "_hi", type: "number", "aria-label": lab + " maximum", placeholder: "max"}, a))));
  const sel = (id, lab, opts) => { const s = h("select", {id}); for (const [v, t] of opts) s.appendChild(h("option", {value: v, text: t}));
    return h("div", {class: "field"}, h("label", {for: id, text: lab}), s); };
  const form = h("form", {id: "find-form", novalidate: ""},
    sel("fq_ion", "ion", Object.keys(ION_SHORT).map(k => [k, ION_LABEL[k]])),
    pair("fq_n", "components", {min: "0", max: "30", step: "1"}),
    pair("fq_sep", "pair Δv [km/s]", {min: "0", max: "3000", step: "1"}),
    pair("fq_logN", "log N", {min: "10", max: "19", step: "0.1"}),
    pair("fq_b", "b [km/s]", {min: "0", max: "150", step: "1"}),
    pair("fq_bkpc", "impact b [kpc]", {min: "0", max: "400", step: "1"}),
    sel("fq_orient", "orientation", [["", "any"], ["face-on", "face-on"], ["edge-on", "edge-on"], ["random", "random"], ["custom", "custom"]]),
    sel("fq_sort", "sort", [["score", "score"], ["b_kpc", "impact b"], ["n", "components"]]),
    h("div", {class: "row", style: "margin-top:6px"}, h("button", {type: "submit", class: "btn primary", text: "Search"}), h("button", {type: "reset", class: "btn", text: "Reset"})));
  const msg = h("p", {class: "msg", "aria-live": "polite", id: "find-msg", text: "loading components…"});
  const list = h("ol", {class: "findres", id: "find-results", "aria-label": "Search results"});
  root.append(form, msg, list);
  const $ = id => root.querySelector("#" + id), val = id => { const v = $(id).value.trim(); return v === "" ? undefined : Number(v); };
  let IX = null;
  const coverage = () => { const es = app.entries(), n = es.filter(e => IX && IX.entries && IX.entries[e.id]).length;
    return `${n} of ${es.length} sightlines have fitted components`; };
  const ready = app.componentsIndex().then(ix => { IX = ix; msg.textContent = coverage() + "."; }).catch(x => { msg.textContent = "components unavailable: " + x.message; msg.className = "msg bad"; });
  function query() { const q = {ion: $("fq_ion").value, sort: $("fq_sort").value};
    const set = (k, v) => { if (v !== undefined) q[k] = v; };
    set("n_min", val("fq_n_lo")); set("n_max", val("fq_n_hi")); set("logN_min", val("fq_logN_lo")); set("logN_max", val("fq_logN_hi"));
    set("b_min", val("fq_b_lo")); set("b_max", val("fq_b_hi"));
    for (const [k, id] of [["sep_kms", "fq_sep"], ["b_kpc", "fq_bkpc"]]) { const a = val(id + "_lo"), b = val(id + "_hi");
      if (a !== undefined || b !== undefined) q[k] = [a ?? 0, b ?? (k === "sep_kms" ? 3000 : 400)]; }
    if ($("fq_orient").value) q.orientation = $("fq_orient").value; return q; }
  function render(res, q) { list.textContent = "";
    if (res.error) { msg.textContent = "Invalid query: " + res.error; msg.className = "msg bad"; return; }
    const shown = res.slice(0, 50); msg.className = "msg";
    msg.textContent = (res.length ? `showing ${shown.length} of ${res.length} matching sightlines` : "no sightline matches this query") + ` (${coverage()})`;
    for (const r of shown) { const b = h("button", {type: "button", class: "btn", "data-id": r.id});
      b.textContent = `${r.id}  ${r.reason}  score ${r.score.toFixed(2)}`; b.addEventListener("click", () => app.select(r.id, {source: "find"}));
      list.appendChild(h("li", {}, b)); } mark(); }
  form.addEventListener("submit", async ev => { ev.preventDefault(); await ready; if (!IX) return;
    const q = query(); render(rankAll(q, app.entries(), IX.entries || {}), q); });
  form.addEventListener("reset", () => setTimeout(() => { list.textContent = ""; msg.className = "msg"; msg.textContent = IX ? "form reset" : msg.textContent; }, 0));
  list.addEventListener("keydown", ev => { const bs = [...list.querySelectorAll("button")], i = bs.indexOf(doc.activeElement); if (i < 0) return;
    const j = ev.key === "ArrowDown" ? i + 1 : ev.key === "ArrowUp" ? i - 1 : ev.key === "Home" ? 0 : ev.key === "End" ? bs.length - 1 : null;
    if (j == null) return; ev.preventDefault(); bs[Math.max(0, Math.min(bs.length - 1, j))].focus(); });
  const mark = () => { const id = app.getState().id; for (const b of list.querySelectorAll("button")) b.setAttribute("aria-current", String(b.dataset.id === id)); };
  form.addEventListener("submit", () => setTimeout(mark, 0)); addEventListener("tng:select", mark);
  return {ready, query, run: q => ready.then(() => IX ? rankAll(q, app.entries(), IX.entries || {}) : {error: "components unavailable"})};
}
