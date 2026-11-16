// Liquid navbar effect adapted from Nimbus UI Liquid Navbar (Waterline) by guglielmogiannattasio.it
// CSS-only port for the Spectra | 3D tab switch (no WebGL, so it never competes with the 3D ray-marcher for GPU
// memory). A single aria-hidden span behind the tabs is the drop. Its leading edge follows the stiff lead spring
// (k 210, c 25) and its trailing edge the soft tail spring (k 72, c 13, 70 ms late), both as CSS linear() curves in
// page.css, so the drop stretches towards the new tab and gathers up behind it; it squashes vertically while moving
// and leaves a faint ripple ring when it settles. The tabs' own behaviour (app.js showTab, ids, keys) is untouched:
// this module only watches aria-selected and the tab sizes.
export function initLiquidTabs(list) {
  if (!list || list.querySelector(".ldrop")) return null;
  const drop = document.createElement("span");
  drop.className = "ldrop"; drop.setAttribute("aria-hidden", "true");
  list.prepend(drop); list.classList.add("liquid");
  let cur = null, settleT = 0;
  const tabs = () => [...list.querySelectorAll("[role=tab]")];
  function place(animate) {
    const t = tabs().find(b => b.getAttribute("aria-selected") === "true"); if (!t) return;
    const W = list.clientWidth, l = t.offsetLeft, r = W - (t.offsetLeft + t.offsetWidth);
    if (animate && cur && cur !== t) {
      list.dataset.dir = t.offsetLeft > cur.offsetLeft ? "r" : "l";
      drop.classList.remove("settle", "moving"); void drop.offsetWidth; drop.classList.add("moving");
      clearTimeout(settleT); settleT = setTimeout(() => { drop.classList.remove("moving"); drop.classList.add("settle"); }, 560);
    }
    drop.style.setProperty("--dl", l + "px"); drop.style.setProperty("--dr", r + "px");
    cur = t;
  }
  place(false);
  requestAnimationFrame(() => requestAnimationFrame(() => list.classList.add("ready")));
  new MutationObserver(() => place(true)).observe(list, {subtree: true, attributes: true, attributeFilter: ["aria-selected"]});
  if (typeof ResizeObserver === "function") {
    const ro = new ResizeObserver(() => { list.classList.remove("ready"); place(false); requestAnimationFrame(() => list.classList.add("ready")); });
    ro.observe(list); tabs().forEach(b => ro.observe(b));
  }
  drop.addEventListener("animationend", ev => { if (ev.animationName === "ldrop-ripple") drop.classList.remove("settle"); });
  return drop;
}
