// Liquid navbar effect adapted from Nimbus UI Liquid Navbar (Waterline) by guglielmogiannattasio.it
// CSS-only port for the Spectra | 3D tab switch (no WebGL, so it never competes with the 3D ray-marcher for GPU
// memory). A single aria-hidden span behind the tabs is the drop. Its leading edge follows the stiff lead spring
// (k 210, c 25) and its trailing edge the soft tail spring (k 72, c 13, 70 ms late), both as CSS linear() curves in
// page.css, so the drop stretches towards the new tab and gathers up behind it; it squashes vertically while moving
// and leaves a faint ripple ring when it settles. The tabs' own behaviour (app.js showTab, ids, keys) is untouched:
// this module only watches aria-selected and the tab sizes.
// 2026-11: the same drop runs behind the radio segmented controls (initLiquidSeg: Layout, the 3D Field Gas and
// Velocity rows, 3D Render mode, chat Model), and initLiquidButtons gives the top bar's buttons a glossy hover that
// follows the pointer, a small squish on press and a ripple from the press point (CSS custom properties only).

/* the shared drop: `items` lists the options, `isOn` picks the selected one (none selected: the drop fades out) */
function liquify(group, items, isOn) {
  if (!group || [...group.children].some(c => c.classList.contains("ldrop"))) return null;
  const drop = document.createElement("span");
  drop.className = "ldrop"; drop.setAttribute("aria-hidden", "true");
  group.prepend(drop); group.classList.add("liquid");
  let cur = null, settleT = 0, raf = 0;   // raf: a placement is queued
  const setPos = t => {
    drop.style.setProperty("--dl", t.offsetLeft + "px");
    drop.style.setProperty("--dr", (group.clientWidth - (t.offsetLeft + t.offsetWidth)) + "px");
  };
  function jump(t) {   // move without the spring (first show, resize, re-appearing after no selection)
    const rd = group.classList.contains("ready");
    group.classList.remove("ready"); setPos(t); void drop.offsetWidth;
    if (rd) group.classList.add("ready");
    drop.classList.remove("off"); cur = t;
  }
  function place(animate) {
    const t = items().find(isOn);
    if (!t) { drop.classList.add("off"); cur = null; return; }
    if (!t.offsetWidth) return;                      // hidden: the ResizeObserver places it once shown
    if (!animate || !cur || drop.classList.contains("off")) { jump(t); return; }
    if (cur !== t) {
      group.dataset.dir = t.offsetLeft > cur.offsetLeft ? "r" : "l";
      drop.classList.remove("settle", "moving"); void drop.offsetWidth; drop.classList.add("moving");
      clearTimeout(settleT); settleT = setTimeout(() => { drop.classList.remove("moving"); drop.classList.add("settle"); }, 560);
    }
    setPos(t); cur = t;
  }
  place(false);
  requestAnimationFrame(() => requestAnimationFrame(() => group.classList.add("ready")));
  if (typeof ResizeObserver === "function") {
    const ro = new ResizeObserver(() => { const t = items().find(isOn); if (t && t.offsetWidth) jump(t); });
    ro.observe(group); items().forEach(b => ro.observe(b));
  }
  drop.addEventListener("animationend", ev => { if (ev.animationName === "ldrop-ripple") drop.classList.remove("settle"); });
  // one placement per burst of checked writes (a sync loop over all radios), in a microtask so a busy 3D frame loop cannot delay it
  const kick = () => { if (!raf) { raf = 1; queueMicrotask(() => { raf = 0; place(true); }); } };
  return {drop, place, kick};
}

export function initLiquidTabs(list) {
  const L = liquify(list, () => [...list.querySelectorAll("[role=tab]")], b => b.getAttribute("aria-selected") === "true");
  if (!L) return null;
  new MutationObserver(() => L.place(true)).observe(list, {subtree: true, attributes: true, attributeFilter: ["aria-selected"]});
  return L.drop;
}

/* Radio segmented controls (<div class="seg"><label><input type="radio"><span>...</span></label>...</div>). The user's
   picks arrive as change events (one document listener: picking a radio of the same name elsewhere, e.g. an ion in
   the 3D Field group, unchecks this row without an event of its own). The page's own syncs set input.checked, so the
   checked setter of every radio sharing a name with the row (within its radiogroup, else the document) is wrapped on
   the instance to nudge the drop. Inputs, names, ids and handlers are untouched. */
const SEGS = new Set();
const CHECKED = typeof HTMLInputElement === "function" ? Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "checked") : null;
function watchChecked(i, kick) {
  if (!i.__lqKicks) {
    const ks = i.__lqKicks = new Set();
    Object.defineProperty(i, "checked", {configurable: true, enumerable: true,
      get() { return CHECKED.get.call(this); }, set(v) { CHECKED.set.call(this, v); ks.forEach(k => k()); }});
  }
  i.__lqKicks.add(kick);
}
export function initLiquidSeg(group) {
  if (!group) return null;
  const labels = () => [...group.querySelectorAll(":scope>label")];
  const L = liquify(group, labels, l => { const i = l.querySelector("input"); return !!(i && i.checked); });
  if (!L) return null;
  if (!SEGS.size) document.addEventListener("change", () => SEGS.forEach(k => k()), true);
  SEGS.add(L.kick);
  if (CHECKED) {
    const scope = group.closest("[role=radiogroup]") || group.getRootNode();
    const names = new Set([...group.querySelectorAll(":scope>label>input[type=radio]")].map(i => i.name).filter(Boolean));
    for (const i of group.querySelectorAll(":scope>label>input")) watchChecked(i, L.kick);
    for (const n of names) for (const i of scope.querySelectorAll(`input[type=radio][name="${CSS.escape(n)}"]`)) watchChecked(i, L.kick);
  }
  return L.drop;
}

/* Glossy liquid buttons: a soft specular spot follows the pointer (--lx/--ly as percentages, so page zoom does not
   matter; one rAF per frame at most), :active squishes the button (CSS), and a press leaves a ripple from the press
   point (--rx/--ry, class lq-rip). Delegated from the document, so buttons added later (share, keys) and the Ask
   button floating outside the bar on phones are covered. Reduced motion: the CSS keeps a still gloss only. */
export const LIQUID_BTN = "#top .pbtn, #top .ib, #mobslot .pbtn, #mobslot .ib, #dock .pbtn, #chat-open";   /* #mobslot: the phone drawer holds the top bar's groups */
export function initLiquidButtons(root = document) {
  if (!root || root.__liquidBtns) return; root.__liquidBtns = true;
  let hot = null, pend = null, raf = 0;
  const pct = (b, x, y) => { const r = b.getBoundingClientRect();
    return r.width && r.height ? [((x - r.left) / r.width * 100).toFixed(1) + "%", ((y - r.top) / r.height * 100).toFixed(1) + "%"] : ["50%", "0%"]; };
  const cool = () => { if (hot) hot.classList.remove("lq-hot"); hot = null; };
  const flush = () => { raf = 0; const p = pend; pend = null; if (!p || p.b !== hot) return;
    const [lx, ly] = pct(p.b, p.x, p.y); p.b.style.setProperty("--lx", lx); p.b.style.setProperty("--ly", ly); p.b.classList.add("lq-hot"); };
  const btnOf = e => (e.target && e.target.closest ? e.target.closest(LIQUID_BTN) : null);
  root.addEventListener("pointermove", e => {
    if (e.pointerType === "touch") return;
    const b = btnOf(e);
    if (b !== hot) { cool(); hot = b; }
    if (!b) return;
    pend = {b, x: e.clientX, y: e.clientY}; if (!raf) raf = requestAnimationFrame(flush);
  }, {passive: true});
  root.addEventListener("pointerout", e => { if (hot && !(e.relatedTarget && hot.contains(e.relatedTarget))) cool(); }, {passive: true});
  root.addEventListener("pointerdown", e => {
    const b = btnOf(e);
    if (!b || b.disabled) return;
    const [rx, ry] = pct(b, e.clientX, e.clientY);
    b.style.setProperty("--rx", rx); b.style.setProperty("--ry", ry);
    b.classList.remove("lq-rip"); void b.offsetWidth; b.classList.add("lq-rip");
  }, {passive: true});
  root.addEventListener("animationend", e => { if (e.animationName === "lq-ripple" && e.target.classList) e.target.classList.remove("lq-rip"); }, true);
}
