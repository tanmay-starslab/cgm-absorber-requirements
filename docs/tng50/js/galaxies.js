// Galaxy picker of the TNG50 explorer (galaxy-sample spec, web contract): the page's galaxy index (CFG.galaxies, written
// by scripts/export_tng50_web.py --galaxies), the URL state g=<id>, where a galaxy's pack lives, and the glass popover
// #gxy-pop (search, sort by M*, SFR, M200c or id, filter centrals/satellites, tips).
//
// CFG.galaxies = {default, base, viz_base, list: [{id, label, Mstar, SFR, M200c, R200c, central, mw, m31, n, viz, base?,
//                  src?, gas_poor?}]}   (src: "sbi" | "trident", the galaxy's spectra source; gas_poor: no cold gas disk)
// or null (one galaxy: no picker). The default galaxy keeps the page's legacy data/ paths (CFG.catalog_url, bin_dir,
// components_url, viz); every other galaxy is read from <base><id>/:
//   catalog.json  s/<sid>.bin  components.json  galaxy.json  viz/manifest_v2.json   (cubes from viz_base, {id} replaced)
// The pure part (galaxyIndex, parseGalaxy, packFor, sortGalaxies, matchGalaxy, fmt*) runs in node
// (tests/js/galaxies_unit.mjs); createGalaxyPicker needs a DOM.

const esc = s => String(s).replace(/[&<>"']/g, c => ({"&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"}[c]));
const ID_OK = /^\d{1,9}$/;

/* ---------------- index ---------------- */
/* -> {default, base, vizBase, list, byId} or null when the config lists fewer than two usable galaxies */
export function galaxyIndex(cfg) {
  const G = cfg && cfg.galaxies;
  if (!G || !Array.isArray(G.list)) return null;
  const list = G.list.filter(e => e && ID_OK.test(String(e.id))).map(e => ({...e, id: +e.id}));
  const byId = new Map(list.map(e => [e.id, e]));
  const def = +G.default;
  if (byId.size < 2 || !byId.has(def)) return null;
  const base = typeof G.base === "string" && G.base ? G.base.replace(/\/?$/, "/") : "data/gal/";
  return {default: def, base, vizBase: typeof G.viz_base === "string" && G.viz_base.includes("{id}") ? G.viz_base : null, list, byId};
}

/* g=<id> from the hash (wins) or the query; null when absent or malformed */
export function parseGalaxy(hash = "", search = "") {
  for (const s of [String(hash).replace(/^#/, ""), String(search).replace(/^\?/, "")]) {
    const g = new URLSearchParams(s).get("g");
    if (g != null && ID_OK.test(g.trim())) return +g.trim();
  }
  return null;
}
/* the galaxy to show: the URL's when the index has it, else the default */
export function resolveGalaxy(index, hash, search) {
  if (!index) return null;
  const g = parseGalaxy(hash, search);
  return g != null && index.byId.has(g) ? g : index.default;
}
/* the g=<id> the URL asks for when the index does not list it (a typo, a galaxy outside the sample or not published
   yet), else null: the page then says it shows the default galaxy instead (review2_ux S2) */
export function unlistedGalaxy(index, hash, search) {
  if (!index) return null;
  const g = parseGalaxy(hash, search);
  return g != null && !index.byId.has(g) ? g : null;
}
/* the hash prefix for a galaxy: "" for the default (URLs of the default galaxy are unchanged), else "g=<id>&" */
export const galaxyHashPart = (index, id) => (!index || id == null || id === index.default ? "" : `g=${id}&`);

/* where a galaxy's data lives. legacy = the page's own config for the default galaxy (catalog_url, bin_dir,
   components_url, viz). -> {id, legacy, catalog_url, bin_dir, components_url, galaxy_url, viz} */
/* entry.base: absolute https URL or relative path ending in "/" (no scheme other than https; no "..") */
export function packBase(e) {
  const v = e && typeof e.base === "string" ? e.base : "";
  if (!v || !v.endsWith("/") || v.includes("..")) return null;
  if (/^[a-z][a-z0-9+.-]*:/i.test(v) && !/^https:\/\//i.test(v)) return null;
  return v;
}

export function packFor(index, id, legacy) {
  if (!index || id === index.default || !index.byId.has(id)) {
    return {id: index ? index.default : null, legacy: true, catalog_url: legacy.catalog_url, bin_dir: legacy.bin_dir,
      components_url: legacy.components_url, galaxy_url: null, viz: legacy.viz || null};
  }
  // per-galaxy base (hosting index: packs sharded over several HF datasets) wins over the shared <base><id>/
  const e = index.byId.get(id), b = packBase(e) || index.base + id + "/";
  const viz = e.viz ? {manifest_url: b + "viz/manifest_v2.json", base: index.vizBase ? index.vizBase.split("{id}").join(String(id)) : b + "viz/",
    fallback_base: null, dataset: null} : null;
  return {id, legacy: false, catalog_url: b + "catalog.json", bin_dir: b + "s/", components_url: b + "components.json",
    galaxy_url: b + "galaxy.json", viz};
}

/* ---------------- formatting ---------------- */
export const lg = x => (Number.isFinite(+x) && +x > 0 ? (Math.log10(+x)).toFixed(2) : "–");
export const fmtSfr = x => (!Number.isFinite(+x) || x === null ? "–" : +x >= 10 ? String(Math.round(+x)) : +x >= 0.1 ? (+x).toFixed(1) : +x > 0 ? (+x).toFixed(2) : "0");
export const kindWord = e => (e.central === true ? "central" : e.central === false ? "satellite" : "");
/* the spectra source of an index entry or a catalogue's spectra_source block: "sbi" | "trident" | "" (unknown) */
export const srcOf = x => { const v = String((x && (x.src ?? x.source)) || "").toLowerCase(); return v.startsWith("sbi") ? "sbi" : v === "trident" ? "trident" : ""; };
export const SRC_WORD = {sbi: "THOR spectra", trident: "Trident spectra"};
/* the compact properties of a galaxy (an index entry) for the chat's tools and page snapshot: log masses and SFR rounded,
   the spectra source in words */
export function galaxySummary(e) {
  if (!e) return null;
  const L = x => (Number.isFinite(+x) && +x > 0 ? +Math.log10(+x).toFixed(2) : null), s = srcOf(e);
  return {id: +e.id, logMstar: L(e.Mstar), logM200c: L(e.M200c), R200c_kpc: Number.isFinite(+e.R200c) && +e.R200c > 0 ? Math.round(+e.R200c) : null,
    SFR: e.SFR == null || !Number.isFinite(+e.SFR) ? null : +(+e.SFR).toPrecision(3), central: typeof e.central === "boolean" ? e.central : null,
    gas_poor: !!e.gas_poor, spectra: s === "sbi" ? "THOR" : s === "trident" ? "Trident" : null, n_sightlines: Number.isFinite(+e.n) && e.n !== null ? +e.n : null,
    has_3d: !!e.viz};
}
/* the full description (aria-label of a row) and the short tip (12 words at most, the page's tip budget) */
export function galaxyAria(e) {
  if (!e) return "";
  const p = [`Subhalo ${e.id}`, kindWord(e), Number.isFinite(+e.Mstar) && e.Mstar ? `log M* ${lg(e.Mstar)}` : "",
    e.SFR != null ? `SFR ${fmtSfr(e.SFR)} M⊙/yr` : "", Number.isFinite(+e.M200c) && e.M200c ? `log M200c ${lg(e.M200c)}` : "",
    e.n ? `${e.n} sightlines` : "", srcOf(e) ? SRC_WORD[srcOf(e)] : "", e.gas_poor ? "gas-poor, little cold gas" : "",
    e.viz ? "" : "no 3D data"].filter(Boolean);
  return p.join(", ");
}
export function galaxyTip(e) {
  if (!e) return "Pick a galaxy of the TNG50 Milky Way and M31 sample";
  return [`Subhalo ${e.id}`, kindWord(e), e.n ? `${e.n} sightlines` : "", e.gas_poor ? "gas-poor" : "", e.viz ? "" : "no 3D data"].filter(Boolean).join(", ");
}

/* ---------------- sort and search ---------------- */
export const SORTS = {Mstar: "stellar mass", SFR: "star formation rate", M200c: "halo mass", id: "subhalo id"};
/* stable sort; missing values last in either direction */
export function sortGalaxies(list, key = "Mstar", dir = -1) {
  const v = e => (key === "id" ? +e.id : Number.isFinite(+e[key]) && e[key] !== null ? +e[key] : null);
  return list.map((e, i) => [e, i]).sort(([a, i], [b, j]) => {
    const x = v(a), y = v(b);
    if (x === null || y === null) return x === null && y === null ? i - j : x === null ? 1 : -1;
    return (x - y) * dir || i - j;
  }).map(([e]) => e);
}
/* query terms (AND): digits match the subhalo id as a prefix; "central"/"cen", "satellite"/"sat", "mw", "m31" and "3d"
   match flags; "m*>10.8", "sfr<1", "m200>12" compare (log masses, linear SFR); other words match the label */
const CMP = /^(m\*|mstar|ms|sfr|m200c?|mh)(<=|>=|<|>|=)(-?\d+(?:\.\d+)?)$/;
export function matchGalaxy(e, q) {
  const terms = String(q || "").toLowerCase().replace(/\s*(<=|>=|<|>|=)\s*/g, "$1").split(/\s+/).filter(Boolean);
  return terms.every(t => {
    if (/^\d+$/.test(t)) return String(e.id).startsWith(t);
    const m = t.match(CMP);
    if (m) {
      const k = m[1].startsWith("sfr") ? "SFR" : m[1].startsWith("m2") || m[1] === "mh" ? "M200c" : "Mstar";
      const x = k === "SFR" ? (e.SFR == null ? NaN : +e.SFR) : +lg(e[k]), y = +m[3];
      if (!Number.isFinite(x)) return false;
      return {"<": x < y, ">": x > y, "<=": x <= y, ">=": x >= y, "=": Math.abs(x - y) < 0.005}[m[2]];
    }
    if (t === "central" || t === "cen" || t === "centrals") return e.central === true;
    if (t === "satellite" || t === "sat" || t === "satellites") return e.central === false;
    if (t === "mw") return e.mw === true;
    if (t === "m31") return e.m31 === true;
    if (t === "3d") return !!e.viz;
    if (t === "gas-poor" || t === "poor") return e.gas_poor === true;
    if (t === "sbi" || t === "trident") return srcOf(e) === t;
    return String(e.label || "").toLowerCase().includes(t);
  });
}

/* ---------------- popover ---------------- */
const MAX_ROWS = 400;
const COLS = [["id", "id", "Subhalo id; click to sort"], ["Mstar", "log M*", "Stellar mass, log M⊙; click to sort, again to reverse"],
  ["SFR", "SFR", "Star formation rate, M⊙/yr; click to sort, again to reverse"], ["M200c", "log M200", "Halo mass M200c, log M⊙; click to sort, again to reverse"]];
function tags(e) {
  const t = [];
  if (e.central === false) t.push('<span class="tag" data-tip="A satellite: not the central galaxy of its halo">sat</span>');
  if (e.m31 === true) t.push('<span class="tag" data-tip="M31-like in the sample definition">M31</span>');
  else if (e.mw === true) t.push('<span class="tag" data-tip="Milky Way-like in the sample definition">MW</span>');
  if (e.gas_poor === true) t.push('<span class="tag" data-tip="Little cold gas: expect weak low-ion absorption">gas-poor</span>');
  if (!e.viz) t.push('<span class="tag dim" data-tip="No 3D data published for this galaxy yet">no 3D</span>');
  return t.join("");
}
/* the current galaxy's card: id, kind and its numbers (two spaces between fields in the text form, no dot separators) */
export function galaxyCard(e) {
  if (!e) return "";
  const kv = (k, v, tip) => `<span class="pv" data-tip="${esc(tip)}"><i>${k}</i>${esc(v)}</span>`;
  return `<span class="gxid">${esc(e.id)}</span>${kindWord(e) ? `<span class="gxk">${kindWord(e)}</span>` : ""}` +
    kv("log M*", lg(e.Mstar), "Stellar mass, log M⊙") + kv("SFR", fmtSfr(e.SFR), "Star formation rate, M⊙/yr") +
    kv("log M200c", lg(e.M200c), "Halo mass M200c, log M⊙") + (Number.isFinite(+e.R200c) && e.R200c ? kv("R200c", `${Math.round(+e.R200c)} kpc`, "Halo radius R200c") : "") +
    (e.gas_poor ? '<span class="gxk" data-tip="Little cold gas: expect weak low-ion absorption">gas-poor</span>' : "");
}

/* ---------------- sightline matching across galaxies (review2_ux S1) ---------------- */
const orientWord = e => (e && e.orientation) || "random";
/* the entry of `entries` closest to the sightline `cur` of the previous galaxy (rhoCur = its b/R200c): same orientation
   word first, then the impact parameter in units of R200c and the azimuth from the projected major axis; null without
   entries. Library rows only (no custom rays). */
export function nearestSightline(entries, cur, rhoCur, R200c) {
  const R = +R200c, lib = (entries || []).filter(e => e && e.orientation && e.orientation !== "custom" && e.source !== "generated" && Number.isFinite(+e.b_kpc));
  if (!lib.length || !cur || !(R > 0) || !Number.isFinite(+rhoCur)) return null;
  const az0 = +cur.azimuth_deg || 0, w0 = orientWord(cur);
  let best = null, bd = Infinity;
  for (const e of lib) {
    const daz = Math.abs(((+e.azimuth_deg || 0) - az0 + 540) % 360 - 180);
    const d = (orientWord(e) === w0 ? 0 : 100) + Math.abs(+e.b_kpc / R - rhoCur) / 0.05 + daz / 30;
    if (d < bd || (d === bd && String(e.id) < String(best.id))) { bd = d; best = e; }
  }
  return best;
}
/* a galaxy's opening sightline when nothing is carried over: a random-orientation ray near 0.25 R200c (mid CGM, not the
   b ~ 0 disk-centre rays that sort first), the best ranked of the closest ones */
export function defaultSightline(entries, R200c, rho = 0.25) {
  const R = +R200c, lib = (entries || []).filter(e => e && e.orientation && e.orientation !== "custom" && e.source !== "generated" && Number.isFinite(+e.b_kpc));
  if (!lib.length || !(R > 0)) return null;
  const pref = lib.filter(e => e.orientation === "random"), pool = pref.length ? pref : lib;
  const key = e => [Math.round(Math.abs(+e.b_kpc / R - rho) / 0.025), Number.isFinite(+e.rank) && e.rank !== null ? +e.rank : 1e9, String(e.id)];
  return pool.slice().sort((a, b) => { const x = key(a), y = key(b); return x[0] - y[0] || x[1] - y[1] || (x[2] < y[2] ? -1 : x[2] > y[2] ? 1 : 0); })[0];
}

/* els: {pop, cur, search, filter, head, list, count}; opts: {index, current() -> id, onPick(id)} */
export function createGalaxyPicker(els, opts) {
  let view = [], hl = -1, sort = {key: "Mstar", dir: -1};
  const shown = () => view.slice(0, MAX_ROWS);
  els.head.innerHTML = COLS.map(([k, lab, tip]) => `<button type="button" class="gxs" data-sort="${k}" data-tip="${esc(tip)}" aria-sort="none">${lab}<b aria-hidden="true"></b></button>`).join("") + "<span></span>";
  function row(e, i, cur) {
    return `<li role="option" id="gxy-opt-${i}" data-id="${e.id}" aria-selected="${e.id === cur}" aria-label="${esc(galaxyAria(e))}" data-tip="${esc(galaxyTip(e))}"${i === hl ? ' class="hl"' : ""}>` +
      `<span class="gxid">${e.id}</span><span class="num">${lg(e.Mstar)}</span><span class="num">${fmtSfr(e.SFR)}</span><span class="num">${lg(e.M200c)}</span><span class="gxt">${tags(e)}</span></li>`;
  }
  function render() {
    const f = els.filter.value, all = opts.index.list, cur = opts.current();
    view = sortGalaxies(all.filter(e => matchGalaxy(e, els.search.value) && (f === "all" || (f === "central" ? e.central === true : e.central === false))), sort.key, sort.dir);
    if (hl >= shown().length) hl = shown().length - 1;
    els.list.innerHTML = view.length ? shown().map((e, i) => row(e, i, cur)).join("")
      : '<li class="empty" role="presentation">No match<button type="button" class="lk" data-act="clear" data-tip="Clear the search and the filter">clear</button></li>';
    els.count.textContent = `${view.length} of ${all.length}`;
    for (const b of els.head.querySelectorAll("[data-sort]")) { const on = b.dataset.sort === sort.key;
      b.setAttribute("aria-sort", on ? (sort.dir > 0 ? "ascending" : "descending") : "none"); b.querySelector("b").textContent = on ? (sort.dir > 0 ? "↑" : "↓") : ""; }
    els.cur.innerHTML = galaxyCard(opts.index.byId.get(cur));
    if (hl >= 0) els.search.setAttribute("aria-activedescendant", `gxy-opt-${hl}`); else els.search.removeAttribute("aria-activedescendant");
  }
  function setSort(key) { sort = sort.key === key ? {key, dir: -sort.dir} : {key, dir: key === "id" ? 1 : -1}; hl = -1; render(); }
  function clear() { els.search.value = ""; els.filter.value = "all"; hl = -1; render(); els.search.focus(); }
  els.head.addEventListener("click", ev => { const b = ev.target.closest("[data-sort]"); if (b) setSort(b.dataset.sort); });
  els.list.addEventListener("click", ev => { if (ev.target.closest('[data-act="clear"]')) { setTimeout(clear); return; }
    const li = ev.target.closest("li[data-id]"); if (li) opts.onPick(+li.dataset.id); });
  els.search.addEventListener("input", () => { hl = -1; render(); });
  els.filter.addEventListener("change", () => { hl = -1; render(); });
  els.search.addEventListener("keydown", ev => {
    const n = shown().length;
    if (ev.key === "ArrowDown" || ev.key === "ArrowUp") { ev.preventDefault(); if (!n) return;
      const d = ev.key === "ArrowDown" ? 1 : -1, cur = shown().findIndex(e => e.id === opts.current());
      hl = hl >= 0 ? (hl + d + n) % n : cur >= 0 ? (cur + d + n) % n : d > 0 ? 0 : n - 1; render();
      els.list.querySelector("li.hl")?.scrollIntoView({block: "nearest"}); }
    else if (ev.key === "Enter") { ev.preventDefault(); const e = shown()[hl >= 0 ? hl : 0]; if (e) opts.onPick(e.id); } });
  return {render, clear, setSort, get sort() { return {...sort}; }, get visible() { return view; },
    onOpen() { hl = -1; render(); const sel = els.list.querySelector('li[aria-selected="true"]');
      if (sel) els.list.scrollTop = Math.max(0, sel.offsetTop - (els.list.clientHeight - sel.offsetHeight) / 2); }};
}
