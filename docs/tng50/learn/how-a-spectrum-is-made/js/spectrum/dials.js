// R and S/N dials in the dock header (DESIGN_final §3.5 B12a/B12b, C_ux P0-5: "R and S/N are dials in the dock header";
// P1-4 plain words: "sharpness" and "exposure (S/N)"). DOM, opt-in: the page creates them once and calls update(fs, box).
//
//   const dials = createDials(parent, {bus, doc})   -> {el, update(fs, box), sizes(), rects(), destroy()}
//   dial values follow fs.spec.R / fs.spec.sn (which already carry a live override from B12a on, seek.js); moving a dial
//   emits bus "override" {key: "R" | "sn", value}. Every control is [data-noscrub] (input.js never scrubs on it), a native
//   range input (role slider, arrows/PageUp/Home/End, aria-valuetext) with a ≥ 44 px hit area.
// Pure helpers for node: dialSpec, toSlider, fromSlider, valueText, visibleFor(fs).

export const DIALS = Object.freeze({
  R: {key: "R", label: "sharpness", unit: "R", min: 5000, max: 150000, log: true, steps: 200,
    text: v => `resolving power ${groupInt(v)}, blur ${fmt1(299792.458 / v)} kilometres per second`},
  sn: {key: "sn", label: "exposure", unit: "S/N", min: 2, max: 100, log: true, steps: 200,
    text: v => `signal to noise ${v >= 10 ? Math.round(v) : v.toFixed(1)} per resolution element`},
});
const groupInt = v => String(Math.round(v)).replace(/\B(?=(\d{3})+(?!\d))/g, " ");
const fmt1 = v => (Math.round(v * 10) / 10).toFixed(1);
export const dialSpec = key => DIALS[key];
export function toSlider(spec, v) {
  const x = spec.log ? (Math.log(v) - Math.log(spec.min)) / (Math.log(spec.max) - Math.log(spec.min)) : (v - spec.min) / (spec.max - spec.min);
  return Math.round(Math.min(1, Math.max(0, x)) * spec.steps);
}
export function fromSlider(spec, s) {
  const x = Math.min(1, Math.max(0, s / spec.steps));
  const v = spec.log ? Math.exp(Math.log(spec.min) + x * (Math.log(spec.max) - Math.log(spec.min))) : spec.min + x * (spec.max - spec.min);
  return spec.key === "R" ? Math.round(v / 100) * 100 : v >= 10 ? Math.round(v) : Math.round(v * 10) / 10;
}
export const valueText = (key, v) => DIALS[key].text(v);
export const shortValue = (key, v) => (key === "R" ? groupInt(v) : v >= 10 ? String(Math.round(v)) : v.toFixed(1));
/* which dials a frame shows: R and S/N in the hero (observed, fit, explore); R only while B12a sweeps R */
export function visibleFor(fs) {
  const sp = fs && fs.spec; if (!sp || sp.dock !== "hero") return [];
  if (sp.mode === "observed") return fs.beat && fs.beat.id === "B12a" ? ["R"] : ["R", "sn"];
  return sp.mode === "fit" || sp.mode === "explore" ? ["R", "sn"] : [];
}
export const DIAL_SIZE = Object.freeze({w: 248, h: 44});
export const TOGGLE_W = 56;   // the R | S/N switch beside a single dial (dock.js dialGrid toggle mode)

export function createDials(parent, o = {}) {
  const doc = o.doc || parent.ownerDocument, bus = o.bus;
  const el = doc.createElement("div");
  el.className = "spec-dials"; el.setAttribute("data-noscrub", "");
  Object.assign(el.style, {position: "absolute", left: "0", top: "0", width: "0", height: "0", pointerEvents: "none"});
  const rows = {};
  for (const key of ["R", "sn"]) {
    const spec = DIALS[key], row = doc.createElement("label");
    row.className = "spec-dial"; row.dataset.key = key; row.setAttribute("data-noscrub", "");
    Object.assign(row.style, {position: "absolute", display: "none", boxSizing: "border-box", height: DIAL_SIZE.h + "px",
      width: DIAL_SIZE.w + "px", pointerEvents: "auto", alignItems: "center", gap: "8px", padding: "0 10px",
      font: '500 12px "Space Grotesk", system-ui, sans-serif', color: "rgba(236,240,255,0.94)",
      background: "#0b0f1ce6", border: "1px solid #ffffff1f", borderRadius: "22px"});   // S0.md §5: the solid HUD pill look, no backdrop-filter
    const name = doc.createElement("span"); name.textContent = spec.label; name.style.color = "rgba(236,240,255,0.66)";
    const input = doc.createElement("input");
    Object.assign(input, {type: "range", min: "0", max: String(spec.steps), step: "1"});
    input.setAttribute("data-noscrub", ""); input.setAttribute("aria-label", `${spec.label} (${spec.unit})`);
    Object.assign(input.style, {flex: "1 1 auto", minWidth: "0", height: "44px", margin: "0", accentColor: "#8fa8ff", cursor: "pointer"});
    const val = doc.createElement("span"); val.className = "spec-dial-val";
    Object.assign(val.style, {font: '500 12px "JetBrains Mono", ui-monospace, monospace', minWidth: "4.6em", textAlign: "right"});
    row.append(name, input, val);
    input.addEventListener("input", () => {
      const v = fromSlider(spec, +input.value);
      val.textContent = (rows[key].narrow && !rows[key].toggle ? spec.unit + " " : "") + shortValue(key, v); input.setAttribute("aria-valuetext", valueText(key, v));
      if (bus) bus.emit("override", {key, value: v});
    });
    for (const ev of ["pointerdown", "wheel", "touchstart"]) row.addEventListener(ev, e => e.stopPropagation(), {passive: true});
    el.appendChild(row); rows[key] = {row, input, val, spec};
  }
  // fix3 ux M1: on short or very narrow docks one dial shows at a time beside an R | S/N switch (a 44 px tall control)
  const tog = doc.createElement("div");
  tog.className = "spec-dial-toggle"; tog.setAttribute("role", "group"); tog.setAttribute("aria-label", "which setting the slider changes"); tog.setAttribute("data-noscrub", "");
  Object.assign(tog.style, {position: "absolute", display: "none", boxSizing: "border-box", height: DIAL_SIZE.h + "px", width: TOGGLE_W + "px",
    pointerEvents: "auto", alignItems: "stretch", padding: "3px", gap: "2px", background: "#0b0f1ce6", border: "1px solid #ffffff1f", borderRadius: "22px"});
  const togBtn = {};
  let active = "R";
  for (const key of ["R", "sn"]) {
    const b = doc.createElement("button"); b.type = "button"; b.textContent = DIALS[key].unit; b.setAttribute("data-noscrub", "");
    b.setAttribute("aria-label", `${DIALS[key].label} (${DIALS[key].unit})`);
    Object.assign(b.style, {flex: "1 1 0", minWidth: "0", padding: "0", border: "0", borderRadius: "18px", cursor: "pointer",
      font: '500 12px "Space Grotesk", system-ui, sans-serif', color: "rgba(236,240,255,0.94)", background: "transparent"});
    b.addEventListener("click", () => { active = key; if (last) api.update(...last); });
    for (const ev of ["pointerdown", "wheel", "touchstart"]) b.addEventListener(ev, e => e.stopPropagation(), {passive: true});
    tog.appendChild(b); togBtn[key] = b;
  }
  el.appendChild(tog);
  parent.appendChild(el);
  let shown = [], boxes = [], last = null;
  const api = {
    el,
    /* box: {x, y, w?} top-right anchor of the dial row and its width (CSS px, page frame); dials sit right-aligned
       leftwards from it, each min(DIAL_SIZE.w, its share of w) wide */
    update(fs, box, shown2 = {}) {
      last = [fs, box, shown2];
      shown = visibleFor(fs); boxes = [];
      let x = box ? box.x : 0;
      const toggle = !!(box && box.toggle && shown.length > 1);
      tog.style.display = toggle ? "flex" : "none";
      if (toggle) {
        if (!shown.includes(active)) active = shown[0];
        shown = [active];
        tog.style.transform = `translate(${Math.round(box.x - box.w)}px, ${Math.round(box.y)}px)`;
        boxes.push({id: "dial:toggle", kind: "dial", rect: {x: box.x - box.w, y: box.y, w: TOGGLE_W, h: DIAL_SIZE.h}});
        for (const k in togBtn) { const on = k === active; togBtn[k].setAttribute("aria-pressed", on ? "true" : "false");
          togBtn[k].style.background = on ? "#8fa8ff" : "transparent"; togBtn[k].style.color = on ? "#0b0f1c" : "rgba(236,240,255,0.94)"; }
        box = {...box, w: box.w - TOGGLE_W - 6, rows: 1};
      }
      // fix3 ux M1: box.rows > 1 stacks the dials one per full-width row (phones < ~330 px), R on top
      const n = shown.length, stack = !!(box && box.rows > 1 && n > 1);
      const dw = box && box.w ? (stack ? Math.floor(box.w) : Math.min(DIAL_SIZE.w, Math.floor((box.w - 8 * (n - 1)) / Math.max(1, n)))) : DIAL_SIZE.w;
      const order = stack ? ["R", "sn"] : ["sn", "R"];
      let yy = box ? box.y : 0;
      for (const key of order) {
        const r = rows[key], on = shown.includes(key) && !!box;
        r.row.style.display = on ? "flex" : "none";
        if (!on) continue;
        if (stack) x = box.x;
        x -= dw;
        r.row.style.width = dw + "px";
        const narrow = dw < 220;                       // phones: the track keeps its room, the unit moves into the value
        r.row.firstChild.style.display = narrow ? "none" : "";
        r.narrow = narrow; r.toggle = toggle;   // with the switch beside it the unit is already on screen
        r.val.style.minWidth = toggle ? "3.4em" : "4.6em";
        r.val.style.display = toggle && dw < 110 ? "none" : "";
        r.row.title = r.spec.text(Number.isFinite(shown2[key]) ? shown2[key] : key === "R" ? fs.spec.R : fs.spec.sn);   // beauty M4: R and S/N live in the tooltip
        r.row.style.transform = `translate(${Math.round(x)}px, ${Math.round(yy)}px)`;
        boxes.push({id: `dial:${key}`, kind: "dial", rect: {x, y: yy, w: dw, h: DIAL_SIZE.h}});
        x -= 8; if (stack) yy += DIAL_SIZE.h + 4;
        // the value the dock draws (R snapped to two significant digits in the noiseless sweep), else the frame's
        const v = Number.isFinite(shown2[key]) ? shown2[key] : key === "R" ? fs.spec.R : fs.spec.sn;
        if (Number.isFinite(v) && doc.activeElement !== r.input) {
          r.input.value = String(toSlider(r.spec, v)); r.val.textContent = (r.narrow && !r.toggle ? r.spec.unit + " " : "") + shortValue(key, v);
          r.input.setAttribute("aria-valuetext", valueText(key, v));
        }
      }
    },
    sizes: () => DIAL_SIZE,
    rects: () => boxes.slice(),
    destroy() { el.remove(); },
  };
  return api;
}
