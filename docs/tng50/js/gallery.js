// Searchable sightline picker of the TNG50 explorer (Phase-3 design §6.1, brief C6): the popover #gal-pop with
// #gal-id (the current sightline's clean label, its id in data-id) and #gal-copy (copies the id), #gal-search, #filter, #showcase, the listbox #gal-list
// (li[role=option][data-id][data-kind]) and #galcount.
// Up/Down move the highlight, Enter picks, Esc closes (the page's popover handler). The page passes the sorted
// catalogue and gets the picked id back.
// ux4 B: sightlines are shown by their parameters (orientation glyph and word, b, Φ; custom rays by length and b); the
// id is secondary (row end, the bar button's tip, the copy button and the URL). sightLabel() is shared with the top-bar button.
import {fmtNum} from "./state.js";

const MAX_ROWS = 300;
const esc = s => String(s).replace(/[&<>"']/g, c => ({"&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"}[c]));
export const kindOf = e => (e.orientation === "custom" || e.kind === "endpoints") ? "custom" : e.source === "generated" ? "generated" : "library";
export const nShow = e => +e.n_showcase_ions || 0;
const fb = x => Number.isInteger(+x) ? String(+x) : fmtNum(+x, 1);
/* clean values: kpc to the integer from 10 kpc up, angles to the degree */
const kpc = x => (Math.abs(+x) >= 10 ? String(Math.round(+x)) : fb(+x || 0));
const deg = x => String(Math.round(+x || 0) % 360);

/* the orientation, drawn as the disk looks along the ray (stroke icons in a 16 px box) */
const DOT = '<circle cx="8" cy="8" r="1.3" fill="currentColor" stroke="none"/>';
const GLYPH = {
  "face-on": '<circle cx="8" cy="8" r="5.6"/>' + DOT,
  "edge-on": '<ellipse cx="8" cy="8" rx="6.4" ry="1.7"/>' + DOT,
  random: '<ellipse cx="8" cy="8" rx="6.2" ry="3.9" transform="rotate(-24 8 8)"/>' + DOT,
  custom: '<path d="M3.2 12.8 12.8 3.2"/><circle cx="3.2" cy="12.8" r="1.5" fill="currentColor" stroke="none"/><circle cx="12.8" cy="3.2" r="1.5" fill="currentColor" stroke="none"/>'};
export const orientOf = e => kindOf(e) === "custom" ? "custom" : GLYPH[e.orientation] ? e.orientation : "random";
export const glyph = o => `<svg class="og" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true">${GLYPH[o] || GLYPH.random}</svg>`;

/* the clean parameters of an entry, [[symbol, value]] (no id, no seed) */
export function sightParams(e) {
  if (kindOf(e) === "custom") return [["L", `${Math.round(+e.length_kpc || 0)} kpc`], ["b", `${kpc(e.b_kpc)} kpc`]];
  return [["b", `${kpc(e.b_kpc)} kpc`], ["Φ", `${deg(e.azimuth_deg)}°`]];
}

/* the label of an entry as {html, text}: glyph, orientation word, parameters; the text form puts two spaces between
   fields (no dot separators) */
export function sightLabel(e) {
  const o = orientOf(e), ps = sightParams(e);
  return {html: glyph(o) + `<span class="ow">${o}</span>` + ps.map(([k, v]) => `<span class="pv"><i>${esc(k)}</i>${esc(v)}</span>`).join(""),
    text: [o, ...ps.map(([k, v]) => `${k} ${v}`)].join("  ")};
}

/* the one-line tip of the top-bar sightline button: the id (and the seed of a random ray), then the action */
export function sightTip(e) {
  if (!e) return "Pick a sightline by orientation, b or Φ";
  if (e.window_truncated) return `Id ${e.id}; some gas lies beyond ±1500 km/s; click to change`;
  return e.orientation === "random" && e.seed != null ? `Seed ${e.seed}, id ${e.id}; click to pick another` : `Id ${e.id}; click to pick another sightline`;
}

/* one-line meta of an entry (two spaces between fields) */
export function entryMeta(e) { return sightParams(e).map(([k, v]) => `${k} ${v}`).join("  "); }

/* copy text to the clipboard; resolves true on success (navigator.clipboard, else a hidden textarea) */
export async function copyText(s) {
  try { await navigator.clipboard.writeText(s); return true; } catch { /* insecure context or denied: fall back */ }
  try { const t = document.createElement("textarea"); t.value = s; t.setAttribute("readonly", ""); t.style.cssText = "position:fixed;opacity:0;top:0;left:0";
    document.body.appendChild(t); t.select(); const ok = document.execCommand("copy"); t.remove(); return ok; } catch { return false; }
}

/* search (fix RC2). The query is split into terms: a symbol and the number after it ("b 62", "b62", "phi 90", "Φ 90",
   "az 90", "L 300") is one field term and matches that field's shown value exactly; a lone number matches any field
   (b, Φ, L, seed) exactly, never digits inside the id; words match the id, orientation or "yours" as substrings. Units
   ("kpc", "°") and a symbol with no number yet are ignored. */
const SYM = {b: "b", phi: "Φ", "φ": "Φ", az: "Φ", l: "L"};
const NUM = /^\d+(?:\.\d+)?$/;
export function parseQuery(q) {
  const raw = String(q || "").toLowerCase().replace(/°/g, " ").split(/\s+/).filter(t => t && t !== "kpc" && t !== "deg"), out = [];
  for (let i = 0; i < raw.length; i++) {
    const t = raw[i], glued = t.match(/^(b|phi|φ|az|l)(\d+(?:\.\d+)?)$/);
    if (glued) out.push({k: SYM[glued[1]], n: +glued[2]});
    else if (SYM[t] && NUM.test(raw[i + 1] || "")) out.push({k: SYM[t], n: +raw[++i]});
    else if (NUM.test(t)) out.push({n: +t});
    else if (SYM[t]) continue;           // a symbol still waiting for its number (mid-typing) filters nothing
    else out.push({w: t});
  }
  return out;
}
const fields = e => { const f = {}; for (const [k, v] of sightParams(e)) f[k] = parseFloat(v); if (e.seed != null) f.seed = +e.seed; return f; };
const words = e => [e.id, orientOf(e), kindOf(e) !== "library" ? "yours generated" : ""].join(" ").toLowerCase();
export function matches(e, terms) {
  if (!terms.length) return true;
  const f = fields(e), w = words(e);
  return terms.every(t => t.w != null ? w.includes(t.w) : t.k ? f[t.k] === t.n : Object.values(f).includes(t.n));
}

/* els: {pop, cur?, search, filter, showcase, list, count}; opts: {entries() -> sorted entries, current() -> id, onPick(id),
   libSource?() -> "sbi" | "trident" (the galaxy library's spectra source)} */
export function createGallery(els, opts) {
  let view = [], hl = -1;
  const shown = () => view.slice(0, MAX_ROWS);
  function row(e, i, cur) {
    const k = kindOf(e), L = sightLabel(e), n = nShow(e);
    /* a cast ray is Trident HM2012 over ±R200c; SBI_CGM galaxies' library rays are CLOUDY FG11 over ±2 R200c (review2 F2) */
    const yt = e.spectra === "trident" && opts.libSource?.() === "sbi" ? "A ray you cast with Trident HM2012; library rays use SBI_CGM" : "A ray you cast; not in the library";
    const badge = k !== "library" ? `<span class="tag" data-tip="${yt}">yours</span>`
      : n ? `<span class="gn" data-tip="${n} ${n === 1 ? "line has" : "lines have"} multi-component, unsaturated absorbers">${n}</span>` : "<span></span>";
    return `<li role="option" id="gal-opt-${i}" data-id="${esc(e.id)}" data-kind="${k}" aria-selected="${e.id === cur}" aria-label="${esc(L.text)}"${i === hl ? ' class="hl"' : ""}>` +
      `<span class="gp">${L.html}</span><span class="gid">${esc(e.id)}</span>${badge}</li>`;
  }
  function render() {
    const terms = parseQuery(els.search.value), f = els.filter.value, star = els.showcase.checked, all = opts.entries();
    view = all.filter(e => matches(e, terms) && (!star || nShow(e) >= 1) &&
      (f === "all" || (f === "new" ? kindOf(e) !== "library" : e.orientation === f)));
    const cur = opts.current();
    if (hl >= shown().length) hl = shown().length - 1;
    els.list.innerHTML = view.length ? shown().map((e, i) => row(e, i, cur)).join("")
      : all.length ? '<li class="empty" role="presentation">No match<button type="button" class="lk" data-act="clear" data-tip="Clear the search and the filters">clear</button></li>' : "";
    els.count.textContent = `${view.length} of ${all.length}`;
    /* fix F2: the header shows the current sightline's clean label; the id stays in dataset.id and the copy button */
    if (els.cur) { const ce = cur && all.find(e => e.id === cur); els.cur.innerHTML = ce ? sightLabel(ce).html : esc(cur || ""); els.cur.dataset.id = cur || ""; }
    if (hl >= 0) els.search.setAttribute("aria-activedescendant", `gal-opt-${hl}`); else els.search.removeAttribute("aria-activedescendant");
  }
  function clear() { els.search.value = ""; els.filter.value = "all"; els.showcase.checked = false; hl = -1; render(); els.search.focus(); }
  /* the clear button re-renders the list: defer it so the page's outside-click handler still sees the click inside the popover */
  els.list.addEventListener("click", ev => { if (ev.target.closest('[data-act="clear"]')) { setTimeout(clear); return; }
    const li = ev.target.closest("li[data-id]"); if (li) opts.onPick(li.dataset.id); });
  for (const el of [els.search, els.filter, els.showcase]) el.addEventListener("input", () => { hl = -1; render(); });
  els.filter.addEventListener("change", () => { hl = -1; render(); });
  els.search.addEventListener("keydown", ev => {
    const n = shown().length;
    if (ev.key === "ArrowDown" || ev.key === "ArrowUp") { ev.preventDefault(); if (!n) return;
      /* B_fix F11: the first arrow press starts from the current sightline (the row after or before it), not the list top */
      const d = ev.key === "ArrowDown" ? 1 : -1, cur = shown().findIndex(e => e.id === opts.current());
      hl = hl >= 0 ? (hl + d + n) % n : cur >= 0 ? (cur + d + n) % n : d > 0 ? 0 : n - 1; render();
      els.list.querySelector("li.hl")?.scrollIntoView({block: "nearest"}); }
    else if (ev.key === "Enter") { ev.preventDefault(); const e = shown()[hl >= 0 ? hl : 0]; if (e) opts.onPick(e.id); } });
  /* the current sightline opens in the middle of the list, not on its bottom edge */
  return {render, clear, onOpen() { hl = -1; render(); const sel = els.list.querySelector('li[aria-selected="true"]');
      if (sel) els.list.scrollTop = Math.max(0, sel.offsetTop - (els.list.clientHeight - sel.offsetHeight) / 2); },
    get visible() { return view; }};
}
