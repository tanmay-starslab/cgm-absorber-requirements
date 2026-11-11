// One-line help for the TNG50 explorer: every control that needs it carries data-tip="…" (on the control itself), and
// this module shows that line in one shared glass tooltip (#tip, styled in css/page.css as .tip).
//   mouse: after SHOW_MS of hover over the control, its <label> or its row; hides on leave, click or scroll
//   keyboard: on :focus-visible; Esc hides
//   touch (no hover): a long press (PRESS_MS, finger still) shows the tip for TOUCH_MS and does not trigger the control;
//     a normal tap acts as before
//   screen readers: each control gets aria-describedby -> a hidden span with the same line (#tips-sr), unless the line
//     only repeats the control's aria-label
// A control whose popup is open (aria-expanded="true" on a popover, menu or dialog) shows no tip, so a tip never covers
// its own popover; a disclosure such as the side-column toggle still shows its tip. On a mouse, the info icons open their
// popover on hover (app.js), and that popover is their explanation; focus and long press still show their tip.
// Text and number inputs are left out of the long press, so the phone's paste and selection menu still works there.
// placeTip and createLongPress are pure (no DOM) and node-tested in tests/js/tips_unit.mjs.

export const SHOW_MS = 400, PRESS_MS = 500, TOUCH_MS = 3000, SLOP_PX = 10, GAP = 8, MARGIN = 8;

/* what each line traces, shared by the Lines menu and the line chips (the 3D ion buttons name the drawn quantity
   instead, in viewer3d.js fieldTip; temperatures are the
   collisional-ionisation peaks; in the CGM most of these ions can also be photoionised) */
export const ION_TIPS = {HI: "Neutral hydrogen Lyman α, cool gas; saturates easily",
  MgII: "Low ion: cool, dense gas near 10⁴ K", SiII: "Low ion: cool photoionised gas near 10⁴ K",
  CII: "Low ion: cool photoionised gas near 10⁴ K", SiIII: "Intermediate ion: cool to warm photoionised gas",
  CIII: "Intermediate ion: cool to warm gas, very strong line", SiIV: "Intermediate ion: photoionised or near 10⁵ K gas",
  CIV: "High ion: photoionised or collisional gas near 10⁵ K", NV: "High ion: warm-hot gas, 2×10⁵ K if collisional",
  OVI: "High ion: warm-hot gas, 3×10⁵ K if collisional", NeVIII: "Very high ion: 6×10⁵ K if collisional, rest-frame EUV",
  OVII: "X-ray line: hot gas near 10⁶ K"};

const clamp = (x, a, b) => Math.min(b, Math.max(a, x));

/* where the tip goes: centred on the anchor, above it when there is room, else below, else on the roomier side;
   then clamped into the viewport. a = anchor rect {left, top, right, bottom}; t = tip size {w, h}; vw, vh viewport */
export function placeTip(a, t, vw, vh, gap = GAP, margin = MARGIN) {
  const cx = (a.left + a.right) / 2, left = clamp(cx - t.w / 2, margin, Math.max(margin, vw - margin - t.w));
  const roomUp = a.top - gap - margin, roomDown = vh - margin - a.bottom - gap;
  const side = t.h <= roomUp ? "top" : t.h <= roomDown ? "bottom" : roomUp >= roomDown ? "top" : "bottom";
  const top = clamp(side === "top" ? a.top - gap - t.h : a.bottom + gap, margin, Math.max(margin, vh - margin - t.h));
  return {left, top, side};
}

/* long press state: down() starts the timer, move() beyond `slop` px cancels it (a scroll or a drag), up() reports
   whether the press fired (then the click that follows must be swallowed) */
export function createLongPress({delay = PRESS_MS, slop = SLOP_PX, setTimer = setTimeout, clearTimer = clearTimeout, onLong = () => {}} = {}) {
  let timer = null, x0 = 0, y0 = 0, active = false, fired = false;
  const stop = () => { if (timer !== null) clearTimer(timer); timer = null; active = false; };
  return {
    down(x, y, target) { stop(); active = true; fired = false; x0 = x; y0 = y;
      timer = setTimer(() => { timer = null; if (active) { fired = true; onLong(target); } }, delay); },
    move(x, y) { if (active && !fired && Math.hypot(x - x0, y - y0) > slop) stop(); },
    up() { const f = fired; stop(); fired = false; return f; },
    cancel() { stop(); fired = false; },
    get pending() { return active && !fired; },
    get fired() { return fired; }
  };
}

/* the control that carries the line for an event target: the nearest [data-tip], else the control of the enclosing
   <label>, else the tipped control of the enclosing row; anchor is what the tip points at */
const ROWS = ".v3c-row,.ctl,.field,.pk-in";
export function tipFor(target) {
  if (!target || !target.closest) return null;
  const own = target.closest("[data-tip]");
  if (own && own.dataset.tip) { const r = own.getBoundingClientRect();
    return {el: own, anchor: r.width * r.height > 0 ? own : own.closest("label") || own.parentElement || own}; }
  const lab = target.closest("label"), c = lab && lab.control;
  if (c && c.dataset && c.dataset.tip) return {el: c, anchor: lab};
  const row = target.closest(ROWS), rc = row && row.querySelector("[data-tip]");
  if (rc && rc.dataset.tip) return {el: rc, anchor: row};
  return null;
}

const CONTROL = "button,input,select,textarea,[tabindex],[role=button],[role=tab],summary,a[href]";
const TEXTY = "input:not([type]),input[type=text],input[type=number],input[type=search],input[type=url],input[type=email],textarea";
const POPUP_ROLES = new Set(["menu", "dialog", "listbox", "tree", "grid"]);
/* true when the control's popup is open: aria-expanded on a control whose aria-controls target is a shown popover,
   menu or dialog (or that declares aria-haspopup and has no target) */
export function popupOpen(el, doc = el.ownerDocument) {
  if (el.getAttribute("aria-expanded") !== "true") return false;
  const id = el.getAttribute("aria-controls"), t = id && doc.getElementById(id);
  if (!t) { const hp = el.getAttribute("aria-haspopup"); return !!hp && hp !== "false"; }
  return !t.hidden && (t.classList.contains("pop") || POPUP_ROLES.has(t.getAttribute("role") || ""));
}
let API = null;

export function initTips(doc = document) {
  if (API) return API;
  const win = doc.defaultView, body = doc.body;
  const tip = doc.createElement("div"); tip.id = "tip"; tip.className = "tip"; tip.setAttribute("role", "tooltip"); tip.hidden = true;
  const sr = doc.createElement("div"); sr.id = "tips-sr"; sr.hidden = true;
  body.append(tip, sr);
  let cur = null, how = "", showT = 0, hideT = 0, swallowUntil = 0, ptrAt = 0, escAt = 0, n = 0;

  function show(hit, mode) {
    if (!hit || !hit.el.isConnected) return;
    if (popupOpen(hit.el, doc)) return;
    clearTimeout(hideT); cur = hit; how = mode;
    const host = doc.fullscreenElement || body; if (tip.parentNode !== host) host.appendChild(tip);   // a fullscreen element hides the rest
    tip.textContent = hit.el.dataset.tip; tip.hidden = false; tip.classList.remove("on");
    tip.style.left = tip.style.top = "0px";   // measure unconstrained: a fixed box near the right edge would shrink-wrap
    /* the page may be scaled with CSS zoom on <html> (125 % on large screens): rects are in screen px, left/top in page px */
    const z = parseFloat(win.getComputedStyle(doc.documentElement).zoom) || 1, tr = tip.getBoundingClientRect();
    const a = hit.anchor.getBoundingClientRect(), p = placeTip(a, {w: tr.width || tip.offsetWidth * z, h: tr.height || tip.offsetHeight * z}, win.innerWidth, win.innerHeight);
    tip.style.left = p.left / z + "px"; tip.style.top = p.top / z + "px"; tip.dataset.side = p.side;
    win.requestAnimationFrame(() => tip.classList.add("on"));
    if (mode === "touch") hideT = setTimeout(hide, TOUCH_MS);
  }
  function hide() { clearTimeout(showT); clearTimeout(hideT); cur = null; how = ""; tip.classList.remove("on"); tip.hidden = true; }

  /* mouse */
  doc.addEventListener("pointerover", ev => { if (ev.pointerType === "touch") return;
    const hit = tipFor(ev.target); if (!hit) { if (how === "mouse") hide(); return; }
    if (cur && cur.el === hit.el) return;
    clearTimeout(showT); if (how === "mouse") hide();
    showT = setTimeout(() => { if (hit.anchor.matches(":hover") || hit.el.matches(":hover")) show(hit, "mouse"); }, SHOW_MS); });
  doc.addEventListener("pointerout", ev => { if (ev.pointerType === "touch") return;
    const to = ev.relatedTarget, hit = tipFor(ev.target); if (!hit) return;
    if (to && (hit.anchor.contains(to) || hit.el.contains(to))) return;
    clearTimeout(showT); if (how === "mouse" && cur && cur.el === hit.el) hide(); });
  doc.addEventListener("pointerdown", ev => { ptrAt = Date.now(); swallowUntil = 0; if (ev.pointerType !== "touch") hide(); }, true);   // a new press: the long press's click is gone

  /* keyboard */
  doc.addEventListener("focusin", ev => { const t = ev.target; let fv = false; try { fv = t.matches(":focus-visible"); } catch { fv = false; }
    // Esc refocuses the popover's opener (app.js): no tip for that focus
    if (!fv || Date.now() - ptrAt < 600 || Date.now() - escAt < 300) return; const hit = tipFor(t); if (hit) show(hit, "focus"); else if (how === "focus") hide(); });
  doc.addEventListener("focusout", () => { if (how === "focus") hide(); });
  doc.addEventListener("keydown", ev => { if (ev.key === "Escape") escAt = Date.now(); if (ev.key === "Escape" && cur) hide(); else if (how === "focus" && cur && ev.key !== "Tab" && ev.key !== "Shift") hide(); }, true);
  win.addEventListener("scroll", () => { if (cur) hide(); }, true);
  win.addEventListener("resize", () => { if (cur) hide(); });
  doc.addEventListener("fullscreenchange", () => hide());

  /* touch: long press shows the tip and swallows the click that follows */
  const lp = createLongPress({onLong: hit => { swallowUntil = Date.now() + 800; show(hit, "touch"); try { navigator.vibrate?.(8); } catch { /* not allowed */ } }});
  doc.addEventListener("pointerdown", ev => { if (ev.pointerType !== "touch") return; if (how === "touch") hide();
    const hit = tipFor(ev.target); if (hit && !ev.target.closest(TEXTY)) lp.down(ev.clientX, ev.clientY, hit); else lp.cancel(); }, true);
  doc.addEventListener("pointermove", ev => { if (ev.pointerType === "touch") lp.move(ev.clientX, ev.clientY); }, {capture: true, passive: true});
  doc.addEventListener("pointerup", ev => { if (ev.pointerType === "touch" && lp.up()) swallowUntil = Date.now() + 800; }, true);
  doc.addEventListener("pointercancel", ev => { if (ev.pointerType === "touch") lp.cancel(); }, true);
  doc.addEventListener("contextmenu", ev => { if ((lp.pending || lp.fired || Date.now() < swallowUntil) && tipFor(ev.target)) ev.preventDefault(); }, true);
  doc.addEventListener("click", ev => { if (Date.now() < swallowUntil) { swallowUntil = 0; ev.preventDefault(); ev.stopImmediatePropagation(); } }, true);

  /* screen readers: aria-describedby -> a hidden span per tipped control, kept in step with data-tip */
  function describe(el) {
    if (!el.matches(CONTROL)) return;
    const text = el.dataset.tip || "", same = text.trim().toLowerCase() === (el.getAttribute("aria-label") || "").trim().toLowerCase();
    let id = el.dataset.tipId, span = id && doc.getElementById(id);
    if (!text || same) { if (span) { el.setAttribute("aria-describedby", (el.getAttribute("aria-describedby") || "").split(/\s+/).filter(x => x && x !== id).join(" ")); span.remove(); delete el.dataset.tipId; } return; }
    if (!span) { id = "tip-d" + (++n); span = doc.createElement("span"); span.id = id; sr.appendChild(span); el.dataset.tipId = id; }
    if (span.textContent !== text) span.textContent = text;
    const ids = (el.getAttribute("aria-describedby") || "").split(/\s+/).filter(Boolean);
    if (!ids.includes(id)) el.setAttribute("aria-describedby", [...ids, id].join(" "));
  }
  const scan = root => { if (root.nodeType !== 1) return; if (root.dataset.tip !== undefined) describe(root); for (const e of root.querySelectorAll("[data-tip]")) describe(e); };
  scan(body);
  let queued = new Set(), raf = 0;
  new win.MutationObserver(ms => { let mine = true;
    for (const m of ms) { if (tip.contains(m.target) || sr.contains(m.target) || m.target === body && m.addedNodes.length && [...m.addedNodes].every(x => x === tip || x === sr)) continue;
      mine = false; if (m.type === "attributes") queued.add(m.target); else for (const x of m.addedNodes) queued.add(x); }
    if (mine) return;
    if (cur && !cur.el.isConnected) hide();
    else if (cur) { const t = cur.el.dataset.tip || ""; if (!t) hide(); else if (tip.textContent !== t) tip.textContent = t; }
    if (!raf) raf = win.requestAnimationFrame(() => { raf = 0; const q = queued; queued = new Set(); for (const x of q) if (x.isConnected) scan(x); });
  }).observe(body, {subtree: true, childList: true, attributes: true, attributeFilter: ["data-tip"]});

  API = {show: (el, mode = "focus") => show(tipFor(el), mode), hide, get current() { return cur ? cur.el : null; }, el: tip};
  win.tngTips = API;
  return API;
}
