// Searchable sightline picker of the TNG50 explorer (Phase-3 design §6.1, brief C6): the popover #gal-pop with
// #gal-search, #filter, #showcase, the listbox #gal-list (li[role=option][data-id][data-kind]) and #galcount.
// Up/Down move the highlight, Enter picks, Esc closes (the page's popover handler). The page passes the sorted
// catalogue and gets the picked id back.
import {fmtNum} from "./state.js";

const MAX_ROWS = 300;
const esc = s => String(s).replace(/[&<>"']/g, c => ({"&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"}[c]));
export const kindOf = e => (e.orientation === "custom" || e.kind === "endpoints") ? "custom" : e.source === "generated" ? "generated" : "library";
export const nShow = e => +e.n_showcase_ions || 0;
const fb = x => Number.isInteger(+x) ? String(+x) : fmtNum(+x, 1);

/* one-line meta of an entry, two spaces between fields (no dot separators) */
export function entryMeta(e) {
  const k = kindOf(e);
  if (k === "custom") return `L ${Math.round(+e.length_kpc || 0)} kpc  b ${fb(e.b_kpc)} kpc`;
  /* tune1 F11: no per-row star (it marked most rows, so it said nothing); the showcase checkbox filters instead */
  return `b ${fb(e.b_kpc)} kpc  Φ ${fb(e.azimuth_deg)}°`;
}

/* els: {pop, search, filter, showcase, list, count}; opts: {entries() -> sorted entries, current() -> id, onPick(id)} */
export function createGallery(els, opts) {
  let view = [], hl = -1;
  const shown = () => view.slice(0, MAX_ROWS);
  function render() {
    const q = els.search.value.trim().toLowerCase(), f = els.filter.value, star = els.showcase.checked, all = opts.entries();
    view = all.filter(e => (!q || e.id.toLowerCase().includes(q)) && (!star || nShow(e) >= 1) &&
      (f === "all" || (f === "new" ? kindOf(e) !== "library" : e.orientation === f)));
    const cur = opts.current();
    if (hl >= shown().length) hl = shown().length - 1;
    els.list.innerHTML = shown().map((e, i) => { const k = kindOf(e);
      return `<li role="option" id="gal-opt-${i}" data-id="${esc(e.id)}" data-kind="${k}" aria-selected="${e.id === cur}"${i === hl ? ' class="hl"' : ""}>` +
        `<span class="gid">${esc(e.id)}</span><span class="gm">${esc(entryMeta(e))}</span>${k !== "library" ? '<span class="tag">new</span>' : ""}</li>`; }).join("");
    els.count.textContent = `${view.length} of ${all.length}`;
    if (hl >= 0) els.search.setAttribute("aria-activedescendant", `gal-opt-${hl}`); else els.search.removeAttribute("aria-activedescendant");
  }
  els.list.addEventListener("click", ev => { const li = ev.target.closest("li[data-id]"); if (li) opts.onPick(li.dataset.id); });
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
  return {render, onOpen() { hl = -1; render(); const sel = els.list.querySelector('li[aria-selected="true"]');
      if (sel) els.list.scrollTop = Math.max(0, sel.offsetTop - (els.list.clientHeight - sel.offsetHeight) / 2); },
    get visible() { return view; }};
}
