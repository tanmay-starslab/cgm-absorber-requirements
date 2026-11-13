// Screen-reader narrative and "Read as text" (DESIGN §2.1, §9.3; DESIGN_final §3.7, §5.6).
// <ol id="narrative">: one item per beat, from copy.json[beat].narrative (templates resolved against story data; a missing
// key stays visible as {{key}} for the copy lint). aria-live="polite" announces beat changes only, debounced so a fast scrub
// says nothing until it rests. The canvas label follows the beat. "Read as text" shows the same list as an overlay that
// scrolls internally (the page itself never scrolls), followed by the honest-simplification list.
//
// Pure: narrativeItems(beats, copy, lookup). DOM: createNarrative({list, live, overlay, canvas}, hooks).

import {resolveTemplate} from "../engine.js";

const esc = s => String(s).replace(/[&<>"]/g, c => ({"&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;"}[c]));
const plain = s => String(s || "").replace(/\*([^*]+)\*/g, "$1");

/* -> [{id, p0, title, text}] ; title = display line (accent marks removed), text = narrative template or display + sub */
export function narrativeItems(beats, copy, lookup = null) {
  const R = s => (s ? (lookup ? resolveTemplate(s, lookup).text : s) : "");
  return (beats || []).map(b => {
    const c = (copy && copy[b.copyRef || b.id]) || {};
    const title = plain(R(c.display));
    const text = plain(R(c.narrative || [c.display, c.sub].filter(Boolean).join(" ")));
    return {id: b.id, p0: b.p0, title, text};
  }).filter(x => x.title || x.text);
}

export function createNarrative(els, hooks = {}) {
  const {list, live, overlay, canvas} = els;
  let items = [], cur = null, timer = 0;
  function build(beats, copy, lookup, honesty = []) {
    items = narrativeItems(beats, copy, lookup);
    list.innerHTML = items.map(it => `<li data-beat="${esc(it.id)}"><p>${esc(it.text)}</p>` +
      (hooks.jump ? `<button type="button" class="nv-go" data-p="${it.p0}" aria-label="${esc("Go to: " + (it.title || it.text).slice(0, 80))}">Go to this moment</button>` : "") + "</li>").join("") +
      (honesty.length ? `<li class="nv-honest"><p>What we simplified:</p><ul>${honesty.map(h => `<li>${esc(plain(R0(h, lookup)))}</li>`).join("")}</ul></li>` : "");
    list.querySelectorAll(".nv-go").forEach(b => b.addEventListener("click", () => { hooks.jump(+b.dataset.p); close(); }));
    tabbable(isOpen());
  }
  const R0 = (s, lookup) => (lookup ? resolveTemplate(s, lookup).text : s);
  function update(beat) {
    if (!beat || beat.id === cur) return;
    cur = beat.id;
    list.querySelectorAll("li[aria-current]").forEach(li => li.removeAttribute("aria-current"));
    const li = list.querySelector(`li[data-beat="${CSS.escape(beat.id)}"]`); if (li) li.setAttribute("aria-current", "step");
    const it = items.find(x => x.id === beat.id);
    if (canvas && it) canvas.setAttribute("aria-label", it.title || it.text);
    clearTimeout(timer);
    if (hooks.quiet && hooks.quiet()) return;           // no announcements during Watch (focus never moves either)
    timer = setTimeout(() => { if (live && it) live.textContent = it.text; }, 450);
  }
  // closed: the narrative list stays readable by screen readers (data-open, not [hidden]), but it is a plain section, not a
  // dialog, and its controls (Back, Go to) are [hidden] so they leave the tab order and the accessibility tree (review2 a11y L1)
  let lastFocus = null;
  const tabbable = on => overlay && overlay.querySelectorAll("button, a").forEach(b => { b.hidden = !on; b.removeAttribute("tabindex"); });
  const isOpen = () => !!(overlay && overlay.hasAttribute("data-open"));
  /* perf_a11y M5 (fix3): a modal keeps focus. While open, everything behind it (#stage with the HUD, rail and sheets, and
     the skip link) is inert, and Tab / Shift+Tab wrap inside the overlay */
  const BEHIND = ["stage", "skip-text"];
  const setInert = on => { for (const id of BEHIND) { const el = document.getElementById(id); if (!el) continue;
    if (on) { el.setAttribute("inert", ""); el.inert = true; } else { el.removeAttribute("inert"); el.inert = false; } } };
  const focusables = () => overlay ? [...overlay.querySelectorAll("button, a[href], [tabindex]:not([tabindex='-1'])")].filter(b => !b.hidden && !b.disabled && b.getClientRects().length > 0) : [];
  function open() { if (!overlay) return; lastFocus = document.activeElement; overlay.setAttribute("data-open", ""); tabbable(true); setInert(true);
                    overlay.setAttribute("role", "dialog"); overlay.setAttribute("aria-modal", "true"); overlay.querySelector("[data-close]")?.focus(); hooks.onOpen && hooks.onOpen(); }
  function close() { if (!isOpen()) return; overlay.removeAttribute("data-open"); overlay.removeAttribute("aria-modal"); overlay.removeAttribute("role"); tabbable(false); setInert(false);
                     hooks.onClose && hooks.onClose(); lastFocus && lastFocus.focus && lastFocus.focus(); }
  if (overlay) {
    overlay.addEventListener("keydown", e => {
      if (e.key === "Escape") { e.preventDefault(); close(); }
      else if (e.key === "Tab" && isOpen()) {
        const f = focusables(); if (f.length) {
          const i = f.indexOf(document.activeElement), n = f.length;
          if (e.shiftKey && i <= 0) { e.preventDefault(); f[n - 1].focus(); }
          else if (!e.shiftKey && (i === n - 1 || i < 0)) { e.preventDefault(); f[0].focus(); }
        }
      }
      e.stopPropagation(); });
    // focus that escapes anyway (a click into the page chrome around it, a screen reader's virtual cursor) is pulled back
    document.addEventListener("focusin", e => { if (isOpen() && !overlay.contains(e.target)) { const f = focusables(); (f[0] || overlay).focus && (f[0] || overlay).focus(); } });
    overlay.querySelector("[data-close]")?.addEventListener("click", close);
  }
  return {build, update, open, close, get isOpen() { return isOpen(); }, get items() { return items; }};
}
