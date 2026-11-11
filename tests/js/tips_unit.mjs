// One-line help (docs/tng50/js/tips.js): the pure parts, no browser. placeTip (above when there is room, flip below,
// clamp into the viewport, max width respected by the caller), createLongPress (fires after the delay with the finger
// still, a tap or a drag does not, the click after a long press is to be swallowed), tipFor (control, its label, its
// row) and the shared ion copy (<= 12 words, no dot separators).
// Usage: node tests/js/tips_unit.mjs
import {placeTip, createLongPress, tipFor, popupOpen, ION_TIPS, PRESS_MS, SHOW_MS, TOUCH_MS, GAP, MARGIN} from "../../docs/tng50/js/tips.js";
import {checker, sepHits} from "./lib/browser.mjs";

const C = checker(), check = C.check;
const R = (left, top, w, h) => ({left, top, right: left + w, bottom: top + h, width: w, height: h});

/* ---- placeTip ---- */
check(PRESS_MS >= 400 && PRESS_MS <= 700 && SHOW_MS >= 300 && SHOW_MS <= 600 && TOUCH_MS >= 2000, `timings: hover ${SHOW_MS} ms, long press ${PRESS_MS} ms, touch tip ${TOUCH_MS} ms`);
{ const p = placeTip(R(500, 400, 40, 24), {w: 200, h: 30}, 1440, 900);
  check(p.side === "top" && p.top === 400 - GAP - 30 && p.left === 520 - 100, `room above: tip above, centred (${JSON.stringify(p)})`); }
{ const p = placeTip(R(500, 10, 40, 24), {w: 200, h: 30}, 1440, 900);
  check(p.side === "bottom" && p.top === 34 + GAP, `no room above (top bar): flips below (${JSON.stringify(p)})`); }
{ const p = placeTip(R(2, 300, 30, 30), {w: 260, h: 30}, 390, 844);
  check(p.left === MARGIN, `left edge: clamped to the margin (${p.left})`); }
{ const p = placeTip(R(370, 300, 18, 30), {w: 260, h: 30}, 390, 844);
  check(p.left === 390 - MARGIN - 260 && p.left + 260 <= 390 - MARGIN, `right edge on 390 px: clamped inside (${p.left})`); }
{ const p = placeTip(R(100, 60, 40, 700), {w: 200, h: 120}, 800, 820);   // tall anchor, neither side fits
  check(p.top >= MARGIN && p.top + 120 <= 820 - MARGIN, `neither side fits: roomier side, clamped on screen (${JSON.stringify(p)})`); }
{ const p = placeTip(R(100, 800, 40, 30), {w: 200, h: 40}, 800, 844);
  check(p.side === "top" && p.top + 40 <= 800 - GAP + 1e-9, `bottom control (mobile sheet): above (${JSON.stringify(p)})`); }
{ const p = placeTip(R(10, 10, 20, 20), {w: 500, h: 40}, 300, 200);   // wider than the viewport: pinned to the margin
  check(p.left === MARGIN && Number.isFinite(p.top), `tip wider than the viewport: left at the margin (${p.left})`); }
{ let ok = true;   // fuzz: always on screen when it fits
  for (let k = 0; k < 2000; k++) { const vw = 320 + Math.random() * 1600, vh = 480 + Math.random() * 900, w = 40 + Math.random() * 240, h = 18 + Math.random() * 60;
    const a = R(Math.random() * (vw - 30), Math.random() * (vh - 30), 10 + Math.random() * 60, 10 + Math.random() * 30), p = placeTip(a, {w, h}, vw, vh);
    if (p.left < MARGIN - 1e-9 || p.left + w > vw - MARGIN + 1e-9 || p.top < MARGIN - 1e-9 || p.top + h > vh - MARGIN + 1e-9) { ok = false; break; }
    if (p.side === "top" && p.top + h > a.top - GAP + 1e-9 && a.top - GAP - MARGIN >= h) { ok = false; break; } }
  check(ok, "placeTip fuzz (2000 cases): inside the viewport, never over its anchor when above fits"); }

/* ---- createLongPress with fake timers ---- */
function clock() { let t = 0, q = [], id = 0;
  return {now: () => t, setTimer: (f, ms) => { q.push({id: ++id, at: t + ms, f}); return id; }, clearTimer: i => { q = q.filter(x => x.id !== i); },
    tick(ms) { t += ms; const due = q.filter(x => x.at <= t); q = q.filter(x => x.at > t); for (const x of due) x.f(); }, get pending() { return q.length; }}; }
{ const k = clock(), got = []; const lp = createLongPress({delay: 500, slop: 10, setTimer: k.setTimer, clearTimer: k.clearTimer, onLong: x => got.push(x)});
  lp.down(100, 100, "A"); k.tick(499); check(!got.length && lp.pending, "long press: nothing before the delay");
  k.tick(1); check(got.join() === "A" && lp.fired, "long press: fires at the delay with its target");
  check(lp.up() === true, "long press: up() after firing says swallow the click");
  check(!lp.fired && !lp.pending, "long press: state cleared after up()"); }
{ const k = clock(), got = []; const lp = createLongPress({delay: 500, setTimer: k.setTimer, clearTimer: k.clearTimer, onLong: x => got.push(x)});
  lp.down(10, 10, "B"); k.tick(150); const sw = lp.up(); k.tick(1000);
  check(sw === false && !got.length && k.pending === 0, "tap: up() before the delay does not fire, click goes through, timer cleared"); }
{ const k = clock(), got = []; const lp = createLongPress({delay: 500, slop: 10, setTimer: k.setTimer, clearTimer: k.clearTimer, onLong: x => got.push(x)});
  lp.down(10, 10, "C"); lp.move(16, 16); k.tick(600);
  check(got.join() === "C", "jitter within the slop (8.5 px) still fires");
  lp.up(); lp.down(10, 10, "D"); lp.move(10, 25); k.tick(600);
  check(got.join() === "C" && lp.up() === false, "a drag beyond the slop (scroll, slider) cancels: no tip, no swallowed click"); }
{ const k = clock(), got = []; const lp = createLongPress({delay: 500, setTimer: k.setTimer, clearTimer: k.clearTimer, onLong: x => got.push(x)});
  lp.down(0, 0, "E"); k.tick(200); lp.cancel(); k.tick(800);
  check(!got.length && lp.up() === false, "pointercancel: cancel() stops the press");
  lp.down(0, 0, "F"); k.tick(200); lp.down(5, 5, "G"); k.tick(500);
  check(got.join() === "G", "a second finger down restarts the press (one timer, latest target)"); }

/* ---- tipFor on a minimal fake DOM ---- */
class E { constructor(tag, attrs = {}, kids = [], rect = [0, 0, 10, 10]) { this.tagName = tag.toUpperCase(); this.dataset = {}; this.parentElement = null; this.kids = kids; this.attrs = attrs;
    for (const [k, v] of Object.entries(attrs)) if (k.startsWith("data-")) this.dataset[k.slice(5).replace(/-(\w)/g, (_, c) => c.toUpperCase())] = v;
    for (const c of kids) c.parentElement = this; this.r = rect; this.control = null; }
  matches(sel) { return sel.split(",").some(s => { s = s.trim(); if (s === "[data-tip]") return this.dataset.tip !== undefined;
    if (s.startsWith(".")) return (this.attrs.class || "").split(" ").includes(s.slice(1)); return s.toUpperCase() === this.tagName; }); }
  closest(sel) { let e = this; while (e) { if (e.matches(sel)) return e; e = e.parentElement; } return null; }
  querySelector(sel) { for (const c of this.kids) { if (c.matches(sel)) return c; const d = c.querySelector(sel); if (d) return d; } return null; }
  getBoundingClientRect() { const [l, t, w, h] = this.r; return R(l, t, w, h); } }
{ const inp = new E("input", {"data-tip": "Signal-to-noise per resolution element"}), span = new E("span"), lab = new E("label", {class: "ctl"}, [span, inp]); lab.control = inp;
  const h1 = tipFor(inp), h2 = tipFor(span);
  check(h1 && h1.el === inp && h1.anchor === inp, "tipFor(control): the control itself");
  check(h2 && h2.el === inp && h2.anchor === lab, "tipFor(label text): the label's control, anchored on the label"); }
{ const radio = new E("input", {"data-tip": "Two R by two S/N"}, [], [0, 0, 0, 0]), txt = new E("span"), lab = new E("label", {}, [radio, txt]); lab.control = radio;
  const h = tipFor(radio);
  check(h && h.el === radio && h.anchor === lab, "tipFor(visually hidden radio): anchored on its label"); }
{ const sel = new E("select", {"data-tip": "Colour map of the field"}), l = new E("span", {class: "lab"}), row = new E("div", {class: "v3c-row"}, [l, sel]);
  const h = tipFor(l);
  check(h && h.el === sel && h.anchor === row, "tipFor(row text without a label): the row's tipped control"); }
{ const b = new E("button", {"data-tip": ""}), wrap = new E("div", {}, [b]);
  check(tipFor(b) === null && tipFor(wrap) === null && tipFor(null) === null, "no tip: empty data-tip, untipped element, null target"); }

/* ---- shared ion copy ---- */
{ const words = s => s.split(/\s+/).filter(w => /[\p{L}\p{N}]/u.test(w)).length;
  const keys = ["HI", "MgII", "SiII", "CII", "SiIII", "CIII", "SiIV", "CIV", "NV", "OVI", "NeVIII", "OVII"];
  check(keys.every(k => typeof ION_TIPS[k] === "string" && ION_TIPS[k].length > 10), `ION_TIPS covers the 12 page ions (${Object.keys(ION_TIPS).length})`);
  const long = keys.filter(k => words(ION_TIPS[k]) > 9);   // the chips append "; × removes it"
  check(!long.length, `ION_TIPS <= 9 words, so a chip's "<tracer>; × removes it" stays <= 12${long.length ? ": " + long.join(" ") : ""}`);
  const sep = keys.filter(k => sepHits(ION_TIPS[k]).length);
  check(!sep.length, `ION_TIPS have no dot separators${sep.length ? ": " + sep.join(" ") : ""}`); }

/* ---- popupOpen: only an open popover, menu or dialog hides the opener's tip (not a disclosure such as #side) ---- */
{ const node = (attrs, cls = [], hidden = false) => ({hidden, classList: {contains: c => cls.includes(c)}, getAttribute: k => (k in attrs ? attrs[k] : null)});
  const els = {pop: node({}, ["pop"]), popHidden: node({}, ["pop"], true), menu: node({role: "menu"}), side: node({"aria-label": "Controls"}), grp: node({role: "group"})};
  const doc = {getElementById: id => els[id] || null};
  const btn = a => node(a);
  check(popupOpen(btn({"aria-expanded": "true", "aria-controls": "pop"}), doc) === true, "popupOpen: expanded opener of a shown .pop");
  check(popupOpen(btn({"aria-expanded": "true", "aria-controls": "menu"}), doc) === true, "popupOpen: expanded opener of a role=menu");
  check(popupOpen(btn({"aria-expanded": "false", "aria-controls": "pop"}), doc) === false, "popupOpen: collapsed opener shows its tip");
  check(popupOpen(btn({"aria-expanded": "true", "aria-controls": "side"}), doc) === false && popupOpen(btn({"aria-expanded": "true", "aria-controls": "grp"}), doc) === false,
    "popupOpen: side-column toggle and 3D Controls (disclosures) keep their tip while expanded");
  check(popupOpen(btn({"aria-expanded": "true", "aria-controls": "popHidden"}), doc) === false, "popupOpen: a hidden popover does not block the tip");
  check(popupOpen(btn({"aria-expanded": "true", "aria-haspopup": "dialog"}), doc) === true && popupOpen(btn({"aria-expanded": "true"}), doc) === false,
    "popupOpen: no target: aria-haspopup decides"); }

process.exit(C.finish());
