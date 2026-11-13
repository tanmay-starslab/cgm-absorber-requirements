// The rail: a mini-map of the beam along the bottom edge (DESIGN_final §1.3 P1-2, P1-3, P1-9, P2; §3.3).
// Cloud bands in phase colour, beat ticks, stop sub-ticks with "stop k of n", the current position, the one-line odometer
// ("212 kpc travelled"; light-years on hover/focus) and, in Watch, the remaining time in the tooltip. The whole rail is one
// role="slider" (a 44 px tall target): a click or tap jumps to the nearest beat start, arrows/PageUp/PageDown step. Labels are
// ≥ 12 px or shown only on hover/focus (no 9 px cloud labels; C_ux F-all).
//
// Pure: railGeometry(band, cls, opts) and railModel(beats, clouds, fs, lToP). DOM: createRail(el, hooks).

import {textWidth} from "./kinetic.js";

export const KPC_TO_LY = 3261.56;
export const FLY_W = 44;

/* "212 kpc travelled". travelled = probe ℓ minus the ray start (both kpc, from story data). */
export function odometerText(travelledKpc) {
  const k = Math.max(0, Math.round(travelledKpc));
  return `${k} kpc travelled`;
}
export function lightYearsText(travelledKpc) {
  const ly = Math.max(0, travelledKpc) * KPC_TO_LY;
  return ly >= 1e6 ? `${(ly / 1e6).toFixed(2)} million light-years` : `${Math.round(ly / 1000) * 1000} light-years`;
}

/* Boxes inside the rail band: fly button (left), menu and music (phone landscape only), act chip (phone landscape only), track,
   odometer (right). All children of the rail; fixed for a given band and font size. */
export function railGeometry(band, cls, opts = {}) {
  const mono = opts.mono || 12, h = band.h, pad = Math.max(10, Math.round(h * 0.2));
  const y = band.y, cy = band.y + h / 2;
  const fly = {x: band.x + pad, y: cy - FLY_W / 2, w: FLY_W, h: FLY_W};
  let x = fly.x + fly.w + pad;
  const out = {fly};
  if (opts.menuInRail) { out.menu = {x, y: cy - 22, w: 44, h: 44}; x += 44 + pad; out.sound = {x, y: cy - 22, w: 44, h: 44}; x += 44 + pad; }
  if (opts.actInRail && opts.actW) { out.act = {x, y: cy - 22, w: opts.actW, h: 44}; x += opts.actW + pad; }
  const odoW = Math.ceil(textWidth(odometerText(opts.maxKpc || 999), "mono", mono)) + 4;
  const odo = {x: band.x + band.w - pad - odoW, y: cy - mono * 0.75, w: odoW, h: Math.ceil(mono * 1.5)};
  const track = {x, y: Math.max(y, cy - 22), w: Math.max(0, odo.x - pad - x), h: Math.min(44, h)};
  out.odo = odo; out.track = track;
  if (track.w < 80) { out.odo = null; track.w = Math.max(0, band.x + band.w - pad - x); }   // too narrow: odometer moves to focus only
  out.y = y;
  return out;
}

/* Model in p units (0..1): ticks at beat starts, cloud bands [{p0, p1, phase, label}], stop sub-ticks for the current beat. */
export function railModel(beats, clouds, fs, lToP) {
  const ticks = (beats || []).map(b => ({p: b.p0, id: b.id}));
  const bands = [];
  for (const c of clouds || []) {
    if (!(c.l_in != null && c.l_out != null) || !lToP) continue;
    const a = lToP(c.l_in), b = lToP(c.l_out);
    if (a == null || b == null) continue;
    bands.push({p0: Math.min(a, b), p1: Math.max(a, b), phase: c.phase || "warm", label: c.label || c.letter || ""});
  }
  let sub = null;
  const st = fs && fs.beat && fs.beat.stop, cur = fs && fs.beat ? (beats || [])[fs.beat.i] : null;
  if (st && cur) {
    sub = {k: st.k, n: st.n, ticks: Array.from({length: st.n}, (_, i) => cur.p0 + (cur.p1 - cur.p0) * (i + 0.5) / st.n),
           text: `stop ${st.k + 1} of ${st.n}`};
  }
  return {ticks, bands, sub, p: fs ? fs.p : 0};
}

/* nearest beat start to p (click/tap quantiser) */
export function nearestTick(ticks, p) {
  let best = null, d = Infinity;
  for (const t of ticks) { const e = Math.abs(t.p - p); if (e < d) { d = e; best = t; } }
  return best;
}

/* ---------------------------------------------------------------- DOM */
const SVGNS = "http://www.w3.org/2000/svg";
export function createRail(root, hooks = {}) {
  root.classList.add("rail"); root.dataset.chrome = "rail";
  root.innerHTML = `
    <button class="rail-fly hud-btn" type="button" data-noscrub data-chrome="fly" aria-label="Hold to fly" title="Hold to fly (Space)">
      <svg viewBox="0 0 20 20" aria-hidden="true"><path class="i-fly" d="M6 4l9 6-9 6z"/><path class="i-pause" d="M6 4h3v12H6zM11 4h3v12h-3z"/></svg>
    </button>
    <div class="rail-track" role="slider" tabindex="0" aria-label="Story position" aria-valuemin="0" aria-valuemax="100" data-noscrub>
      <svg class="rail-svg" preserveAspectRatio="none" aria-hidden="true"></svg>
      <span class="rail-sub" aria-hidden="true" data-num></span>
      <span class="rail-tip" role="tooltip" hidden data-num></span>
    </div>
    <span class="rail-odo" data-num></span>`;   // review2 a11y L4: not a tab stop (no role); light-years in its title and the slider's valuetext
  const fly = root.querySelector(".rail-fly"), track = root.querySelector(".rail-track"), svg = root.querySelector(".rail-svg");
  const odo = root.querySelector(".rail-odo"), sub = root.querySelector(".rail-sub"), tip = root.querySelector(".rail-tip");
  let model = {ticks: [], bands: []}, geom = null, lastKey = "";

  // fly: hold to fly, or play/pause in Watch
  const down = e => { e.preventDefault(); hooks.flyStart && hooks.flyStart(); fly.classList.add("on"); };
  const up = () => { if (fly.classList.contains("on")) { fly.classList.remove("on"); hooks.flyEnd && hooks.flyEnd(); } };
  fly.addEventListener("pointerdown", down);
  for (const ev of ["pointerup", "pointercancel", "pointerleave"]) fly.addEventListener(ev, up);
  fly.addEventListener("keydown", e => { if ((e.key === "Enter" || e.key === " ") && !e.repeat) { e.preventDefault(); e.stopPropagation(); hooks.flyToggle ? hooks.flyToggle() : down(e); } });

  const pAt = clientX => { const r = track.getBoundingClientRect(); return Math.min(1, Math.max(0, (clientX - r.left) / Math.max(1, r.width))); };
  track.addEventListener("click", e => { const t = nearestTick(model.ticks, pAt(e.clientX)); if (t && hooks.jump) hooks.jump(t.p, t.id); });
  track.addEventListener("pointermove", e => {
    if (e.pointerType !== "mouse") return;
    const p = pAt(e.clientX), t = nearestTick(model.ticks, p), band = model.bands.find(b => p >= b.p0 && p <= b.p1);
    tip.textContent = [band && band.label, hooks.tickLabel ? hooks.tickLabel(t) : (t && t.id), hooks.watchRemaining ? hooks.watchRemaining() : ""].filter(Boolean).join("  ");
    tip.hidden = !tip.textContent; tip.style.left = ((p * 100).toFixed(1)) + "%";
  });
  track.addEventListener("pointerleave", () => { tip.hidden = true; });
  track.addEventListener("keydown", e => {
    if (!hooks.key) return;
    if (["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "PageUp", "PageDown", "Home", "End"].includes(e.key)) { e.preventDefault(); e.stopPropagation(); hooks.key(e.key, e.shiftKey); }
  });

  function drawSvg() {
    const key = JSON.stringify([model.ticks.length, model.bands, model.sub && model.sub.ticks]);
    if (key === lastKey) return; lastKey = key;
    svg.setAttribute("viewBox", "0 0 1000 20");
    let s = `<rect class="rail-base" x="0" y="9.25" width="1000" height="1.5"/>`;
    for (const b of model.bands) s += `<rect class="rail-band ph-${b.phase}" x="${(b.p0 * 1000).toFixed(1)}" y="7" width="${Math.max(2, (b.p1 - b.p0) * 1000).toFixed(1)}" height="6" rx="1"/>`;
    for (const t of model.ticks) s += `<rect class="rail-tick" x="${(t.p * 1000 - 0.75).toFixed(1)}" y="5" width="1.5" height="10"/>`;
    if (model.sub) for (const q of model.sub.ticks) s += `<rect class="rail-subtick" x="${(q * 1000 - 0.6).toFixed(1)}" y="3" width="1.2" height="3"/>`;
    s += `<rect class="rail-fill" x="0" y="9" width="0" height="2"/><circle class="rail-head" cx="0" cy="10" r="0"/>`;
    svg.innerHTML = s;
  }

  /* fs, model (railModel), geom (railGeometry, page px), travelled kpc */
  function render(fs, m, g, travelled, opts = {}) {
    model = m; geom = g; drawSvg();
    const p = fs ? fs.p : 0;
    const fill = svg.querySelector(".rail-fill"); if (fill) fill.setAttribute("width", (p * 1000).toFixed(1));
    track.style.setProperty("--p", p.toFixed(5));
    track.setAttribute("aria-valuenow", (p * 100).toFixed(1));
    track.setAttribute("aria-valuetext", (opts.beatLabel || "") + (travelled != null ? ", " + odometerText(travelled) + ", " + lightYearsText(travelled) : ""));
    sub.textContent = m.sub ? m.sub.text : ""; sub.hidden = !m.sub;
    if (travelled != null) { odo.textContent = odometerText(travelled); odo.title = lightYearsText(travelled); }
    odo.hidden = !(g && g.odo);
    fly.classList.toggle("watch", !!opts.watch); fly.classList.toggle("paused", !!opts.paused);
    fly.setAttribute("aria-label", opts.watch ? (opts.paused ? "Play" : "Pause") : "Hold to fly");
    if (g) {
      const bx = opts.origin || {x: 0, y: 0};
      const place = (el, r) => { if (!r) return; el.style.left = (r.x - bx.x) + "px"; el.style.top = (r.y - bx.y) + "px"; el.style.width = r.w + "px"; el.style.height = r.h + "px"; };
      place(fly, g.fly); place(track, g.track); if (g.odo) place(odo, g.odo);
    }
  }
  return {render, el: root, fly, track};
}
