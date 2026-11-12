// Transfer-function editor for the 3D viewer's volume mode (THOR, Byrohl & Nelson 2025, sec. 3.5.3 and Fig. 11).
// A compact card: one canvas with the colour field's histogram (log counts, from the loaded cube) under the transfer
// function (alpha height, colour fill), Gaussian bands (centre, width, height = alpha, colour), presets, a 2D toggle
// (value x gradient magnitude; a band then has a gradient range), shading, and the emissivity field with exponent gamma.
// The model is tf.js (state in the field's own log10 units, bake, presets, URL codec); this module is DOM only, no
// three.js: it edits a state object and reports every change; the viewer bakes the state into uTF and sets uniforms.
//
// createTfEditor({onChange}) -> editor
//   onChange(state, {commit, reason, preset})  every edit; commit = true at the end of a drag and on discrete changes;
//     reason "preset" (with the chosen name) and "reset" ask the viewer for a fresh state (it knows the field)
//   editor.el                          the <section class="v3c-card v3tf" id="v3-tf"> to insert (hidden until shown)
//   editor.set(state, ctx)             show a state; ctx = {lut (colormaps.lut of the field), field (label),
//     hist: Float32Array|null (counts per bin over state.win), hist2: {logc, vbins, gbins}|null (value x gradient),
//     emis: [{value, label}] (density fields offered as emissivity weight)}
//   editor.state                       a copy of the shown state;  editor.select(i) selects band i (-1: the ramp)
// The ramp (Default ramp, Clouds) is an editable item like a band: two handles on the canvas (low end, high end at its
// opacity), the alpha and gradient rows act on it while it is selected, and remove drops it.
import {buildTF, PRESETS, PRESET_LABELS, MAX_BANDS, TF_W, TF_H, THOR_NOTE} from "./tf.js";
import {pixelRatio} from "./state.js";

const clamp = (x, a, b) => Math.min(b, Math.max(a, x));
const r3 = x => Math.round(x * 1000) / 1000;
const hex = c => "#" + c.map(x => clamp(Math.round(x), 0, 255).toString(16).padStart(2, "0")).join("");
const rgbOf = h => [1, 3, 5].map(i => parseInt(h.slice(i, i + 2), 16));
const copy = s => JSON.parse(JSON.stringify(s));

/* histogram helpers for the viewer (cheap enough at cube upload): code counts of a u8 log cube (q 0 = empty), then the
   counts over a window; one code spans (vmax - vmin) / 254 dex and its count is spread over that span, so a narrow
   window shows no comb of empty bins */
export function histCodes(q, stride = 3) { const h = new Float64Array(256); for (let i = 0; i < q.length; i += stride) h[q[i]]++; return h; }
export function histWindow(codes, vmin, vmax, lo, hi, nb = 128) {
  const out = new Float32Array(nb); if (!codes || !(hi > lo)) return out;
  const d = (vmax - vmin) / 254;
  for (let qv = 1; qv < 256; qv++) { const c = codes[qv]; if (!c) continue;
    for (let s = 0; s < 8; s++) { const v = vmin + (qv - 1) * d + ((s + 0.5) / 8 - 0.5) * d, b = Math.floor((v - lo) / (hi - lo) * nb);
      if (b >= 0 && b < nb) out[b] += c / 8; } }
  return out;
}

let N = 0;
export function createTfEditor({onChange = () => {}} = {}) {
  const uid = "v3tf" + (++N), el = document.createElement("section");
  el.className = "v3c-card v3tf"; el.dataset.group = "tf"; el.id = "v3-tf"; el.hidden = true;
  const opts = PRESETS.map(p => `<option value="${p}">${PRESET_LABELS[p]}</option>`).join("") + `<option value="custom" disabled>custom</option>`;
  el.innerHTML = `<h2 id="${uid}-h">Transfer function</h2>
    <div class="v3c-row"><label for="v3-tf-preset">preset</label><select id="v3-tf-preset" data-testid="v3-tf-preset" data-tip="Starting look: default ramp, THOR gas phases, iso bands or clouds">${opts}</select></div>
    <div class="v3tf-plot"><canvas id="v3-tf-cv" data-testid="v3-tf-canvas" tabindex="0" role="application" aria-roledescription="transfer function editor"
      aria-labelledby="${uid}-h" aria-describedby="${uid}-help" data-tip="Drag a band to move it, shift-drag for width, double-click adds"></canvas>
      <div class="v3tf-ax" aria-hidden="true"><span class="lo"></span><span class="u"></span><span class="hi"></span></div></div>
    <p class="v3d-sr" id="${uid}-help">Histogram of the field (log counts) under the transfer function: height is opacity, fill is colour. Drag a band or a ramp end to move it, shift-drag to change a band's width, double-click to add a band. Keys: left and right move the selected band or ramp, up and down change its opacity, plus and minus its width, page up and page down select another band or the ramp, Insert adds, Delete removes.</p>
    <p class="v3d-sr" id="v3-tf-live" role="status" aria-live="polite"></p>
    <div class="v3c-row" id="v3-tf-w-row"><label for="v3-tf-w">width</label><input id="v3-tf-w" data-testid="v3-tf-w" type="range" min="0.01" max="2" step="0.01" data-tip="Width of the selected band: Gaussian sigma in dex"><output for="v3-tf-w" id="v3-tf-w-o"></output></div>
    <div class="v3c-row"><label for="v3-tf-a">alpha</label><input id="v3-tf-a" data-testid="v3-tf-a" type="range" min="0" max="1" step="0.01" data-tip="Peak opacity of the selected band or ramp"><output for="v3-tf-a" id="v3-tf-a-o"></output></div>
    <div class="v3tf-bands"><input type="color" id="v3-tf-col" aria-label="band colour" data-tip="Colour of the selected band">
      <button type="button" class="v3c-btn" id="v3-tf-add" data-testid="v3-tf-add" data-tip="Add a Gaussian opacity band (Insert in the editor)">+ band</button>
      <button type="button" class="v3c-btn" id="v3-tf-del" data-testid="v3-tf-del" data-tip="Remove the selected band or ramp (Delete in the editor)">remove</button>
      <button type="button" class="v3c-btn" id="v3-tf-reset" data-testid="v3-tf-reset" data-tip="Back to this field's default transfer function">Reset</button></div>
    <div class="v3c-sw"><label><input type="checkbox" id="v3-tf-2d" data-testid="v3-tf-2d" data-tip="Opacity also follows the gradient magnitude, picking out cloud edges">2D gradient</label></div>
    <div class="v3c-row" id="v3-tf-g-row" hidden><span class="lab">gradient</span>
      <span class="v3tf-g"><input id="v3-tf-g0" type="range" min="0" max="1" step="0.01" aria-label="gradient low" data-tip="Lowest gradient the selected item covers: 0 flat, 1 steepest"><input id="v3-tf-g1" type="range" min="0" max="1" step="0.01" aria-label="gradient high" data-tip="Highest gradient the selected item covers: 0 flat, 1 steepest"></span><output id="v3-tf-g-o"></output></div>
    <div class="v3c-row"><label for="v3-tf-shade">shade</label><input id="v3-tf-shade" data-testid="v3-tf-shade" type="range" min="0" max="1" step="0.05" data-tip="Surface shading from the gradient, lit by a headlight"><output for="v3-tf-shade" id="v3-tf-shade-o"></output></div>
    <div class="v3c-row"><label for="v3-tf-emis">emit</label><select id="v3-tf-emis" data-testid="v3-tf-emis" data-tip="Density field w that scales brightness as (w / w_ref)^γ"></select></div>
    <div class="v3c-row"><label for="v3-tf-gamma" aria-label="gamma"><span class="gam">γ</span></label><input id="v3-tf-gamma" data-testid="v3-tf-gamma" type="range" min="0" max="3" step="0.1" data-tip="Emissivity exponent γ on the density weight; 0 turns it off"><output for="v3-tf-gamma" id="v3-tf-gamma-o"></output></div>`;
  const q = s => el.querySelector(s), cv = q("#v3-tf-cv"), live = q("#v3-tf-live");
  let st = {preset: "ramp", ramp: null, bands: [], twoD: false, shade: 0, emis: "", gamma: 1, win: [0, 1]}, ctx = {lut: null, hist: null, hist2: null, emis: [], field: ""}, sel = 0, baked = null;
  const ed = {el, get state() { return copy(st); }, set, select, redraw: () => draw()};
  const span = () => Math.max(1e-6, st.win[1] - st.win[0]), nx = v => (v - st.win[0]) / span(), vx = x => st.win[0] + x * span();
  const band = () => (sel >= 0 ? st.bands[sel] : null), ramp = () => (sel < 0 ? st.ramp : null), item = () => band() || ramp();
  /* selectable items: the ramp (sel -1) if any, then the bands; normSel keeps sel on an existing item */
  const items = () => [...(st.ramp ? [-1] : []), ...st.bands.map((_, i) => i)];
  function normSel() { if (sel < 0 && st.ramp) return; sel = st.bands.length ? clamp(sel, 0, st.bands.length - 1) : (st.ramp ? -1 : 0); }
  const bandCol = B => (B.rgb ? B.rgb : (() => { const L = ctx.lut, k = 4 * Math.round(clamp(nx(B.c), 0, 1) * 255); return L ? [L[k], L[k + 1], L[k + 2]] : [143, 168, 255]; })());

  function emit(commit, reason) { baked = null; onChange(copy(st), {commit, reason}); syncInputs(); draw(); }
  function custom() { st.preset = "custom"; }
  function set(s, c) { st = copy(s); if (!st.win) st.win = [0, 1]; if (c) ctx = {...ctx, ...c}; normSel(); baked = null;
    const e = q("#v3-tf-emis"), list = ctx.emis || [], k = list.map(o => o.value).join();
    if (e.dataset.k !== k) { e.textContent = ""; for (const o of [{value: "", label: "none"}, ...list]) { const x = document.createElement("option"); x.value = o.value; x.textContent = o.label; e.appendChild(x); } e.dataset.k = k; }
    syncInputs(); draw(); }
  function select(i) { const L = items(); if (!L.length) return; sel = L.includes(i) ? i : L[clamp(i, 0, L.length - 1)]; syncInputs(); draw(); say(); }
  const step = d => { const L = items(); if (!L.length) return; select(L[(L.indexOf(sel) + d + L.length) % L.length]); };
  function say() { const B = band(), R = ramp();
    live.textContent = B ? `band ${sel + 1} of ${st.bands.length}: centre ${B.c.toFixed(2)}, width ${B.w.toFixed(2)} dex, opacity ${B.a.toFixed(2)}`
      : R ? `ramp from ${R.lo.toFixed(2)} to ${R.hi.toFixed(2)}, opacity ${R.a.toFixed(2)}${st.twoD && R.g ? `, gradient ${R.g[0].toFixed(2)} to ${R.g[1].toFixed(2)}` : ""}`
      : "empty: double-click or + band to add a band"; }
  const g2 = x => String(+(+x).toFixed(2));
  function syncInputs() { const B = band(), I = item(), has = !!B, R = !B && !!I;
    const p = q("#v3-tf-preset"); p.value = PRESETS.includes(st.preset) ? st.preset : "custom";
    p.dataset.tip = st.preset === "thor" ? "THOR phases: 2×10⁴ K blue, 10⁵ K orange, 3×10⁵ K red" : "Starting look: default ramp, THOR gas phases, iso bands or clouds";
    p.setAttribute("aria-description", st.preset === "thor" ? THOR_NOTE : "");
    /* band-only controls (width, colour) are off for the ramp; with nothing selectable, everything but + band is off */
    for (const s of ["#v3-tf-w", "#v3-tf-col"]) q(s).disabled = !has;
    for (const s of ["#v3-tf-a", "#v3-tf-del", "#v3-tf-g0", "#v3-tf-g1"]) q(s).disabled = !I;
    q("#v3-tf-w-row").hidden = R;
    q("#v3-tf-add").disabled = st.bands.length >= MAX_BANDS;
    if (has) { q("#v3-tf-w").value = B.w; q("#v3-tf-col").value = hex(bandCol(B)); }
    if (I) { q("#v3-tf-a").value = I.a; q("#v3-tf-g0").value = I.g?.[0] ?? 0; q("#v3-tf-g1").value = I.g?.[1] ?? 1; }
    q("#v3-tf-w-o").textContent = has ? B.w.toFixed(2) : ""; q("#v3-tf-a-o").textContent = I ? I.a.toFixed(2) : "";
    q("#v3-tf-w").setAttribute("aria-valuetext", has ? `${B.w.toFixed(2)} dex` : "");
    q("#v3-tf-g-o").textContent = I ? `${g2(I.g?.[0] ?? 0)}–${g2(I.g?.[1] ?? 1)}` : "";
    q("#v3-tf-2d").checked = !!st.twoD; q("#v3-tf-g-row").hidden = !st.twoD;
    q("#v3-tf-shade").value = st.shade; q("#v3-tf-shade-o").textContent = (+st.shade).toFixed(2);
    q("#v3-tf-emis").value = st.emis || ""; q("#v3-tf-gamma").value = st.gamma; q("#v3-tf-gamma-o").textContent = (+st.gamma).toFixed(1); q("#v3-tf-gamma").disabled = !st.emis;
    for (const i of el.querySelectorAll("input[type=range]")) { const lo = +i.min || 0, hi = +i.max || 1; i.style.setProperty("--pc", (100 * clamp((+i.value - lo) / (hi - lo || 1), 0, 1)).toFixed(2) + "%"); }
    const ax = q(".v3tf-ax"); ax.querySelector(".lo").textContent = (+st.win[0]).toFixed(1); ax.querySelector(".hi").textContent = (+st.win[1]).toFixed(1);
    const fl = ctx.field ? `log ${ctx.field}` : ""; ax.querySelector(".u").textContent = st.twoD ? `${fl}, gradient ↑` : fl; }
  function add(c = null, a = 0.6) { if (st.bands.length >= MAX_BANDS) return; custom();
    if (c === null) { const xs = st.bands.map(b => nx(b.c)).sort((x, y) => x - y), ends = [0, ...xs, 1]; let best = 0.5, gap = -1;
      for (let i = 1; i < ends.length; i++) if (ends[i] - ends[i - 1] > gap) { gap = ends[i] - ends[i - 1]; best = (ends[i] + ends[i - 1]) / 2; } c = vx(best); }
    const B = band(); st.bands.push({c: r3(c), w: B ? B.w : r3(clamp(0.03 * span(), 0.02, 0.5)), a: r3(clamp(a, 0.02, 1)), rgb: null});
    sel = st.bands.length - 1; emit(true, "add"); say(); }
  function del() { if (!item()) return; custom(); if (band()) st.bands.splice(sel, 1); else st.ramp = null; sel = Math.max(0, sel - 1); normSel(); emit(true, "remove"); say(); }

  /* ---- canvas: x = value over the window, y = opacity (1D) or gradient magnitude (2D, 0 at the bottom) ---- */
  const PADT = 6, PADB = 1;
  const geom = () => { const r = cv.getBoundingClientRect(); return {w: r.width || 260, h: r.height || 100, l: r.left, t: r.top}; };
  const toY = (y, g) => PADT + (1 - y) * (g.h - PADT - PADB);
  const gmid = o => ((o.g?.[0] ?? 0) + (o.g?.[1] ?? 1)) / 2;
  const handle = B => [nx(B.c), st.twoD ? gmid(B) : B.a];
  /* the ramp's two handles: its low end (at zero opacity) and its high end (at its opacity); in 2D both at the middle of
     its gradient range */
  const rampH = R => [[nx(R.lo), st.twoD ? gmid(R) : 0], [nx(R.hi), st.twoD ? gmid(R) : R.a]];
  /* colours from the theme (canvas needs rgb numbers): resolve any CSS colour through the 2D context */
  const rgbCss = (c, css, dflt) => { c.fillStyle = dflt; c.fillStyle = css || dflt; const v = c.fillStyle;
    if (v[0] === "#") return rgbOf(v); const m = v.match(/[\d.]+/g); return m ? m.slice(0, 3).map(Number) : rgbOf(dflt); };
  let tmp = null;
  function draw() {
    if (el.hidden || !cv.isConnected) return;
    const g = geom(), dpr = pixelRatio(), W = Math.round(g.w * dpr), H = Math.round(g.h * dpr);
    if (!W || !H) return;
    if (cv.width !== W || cv.height !== H) { cv.width = W; cv.height = H; }
    const c = cv.getContext("2d"); if (!c) return; c.setTransform(dpr, 0, 0, dpr, 0, 0); c.clearRect(0, 0, g.w, g.h);
    const cs = getComputedStyle(el), ink = cs.getPropertyValue("--ink").trim() || "#eef0f7", acc = cs.getPropertyValue("--accent").trim() || "#8fa8ff";
    const ik = rgbCss(c, ink, "#eef0f7"), inkA = a => `rgba(${ik[0]},${ik[1]},${ik[2]},${a})`;
    baked ||= buildTF(st, ctx.lut, st.win);
    tmp ||= document.createElement("canvas");
    if (st.twoD) {
      /* 2D: the value x gradient histogram (theme ink, alpha from the log counts with a gamma stretch) under the table
         (its colour at its opacity), both over the card's well (transparent pixels), band boxes on top */
      const h2 = ctx.hist2, img = new ImageData(TF_W, TF_H);
      for (let y = 0; y < TF_H; y++) for (let x = 0; x < TF_W; x++) { const s = 4 * ((TF_H - 1 - y) * TF_W + x), o = 4 * (y * TF_W + x), a = baked[s + 3] / 255;
        const hv = h2 ? h2.logc[Math.min(h2.gbins - 1, Math.floor((TF_H - 1 - y) / TF_H * h2.gbins)) * h2.vbins + Math.min(h2.vbins - 1, Math.floor(x / TF_W * h2.vbins))] : 0;
        const ah = hv > 0 ? 0.08 + 0.5 * Math.pow(hv, 0.6) : 0, A = a + ah * (1 - a);
        for (let k = 0; k < 3; k++) img.data[o + k] = A > 0 ? (a * baked[s + k] + ah * (1 - a) * ik[k]) / A : 0;
        img.data[o + 3] = Math.round(255 * A); }
      tmp.width = TF_W; tmp.height = TF_H; tmp.getContext("2d").putImageData(img, 0, 0);
      c.imageSmoothingEnabled = true; c.drawImage(tmp, 0, PADT, g.w, g.h - PADT - PADB);
      st.bands.forEach((B, i) => { c.strokeStyle = i === sel ? acc : inkA(0.6); c.lineWidth = i === sel ? 1.5 : 1;
        const x0 = clamp(nx(B.c - 2 * B.w), 0, 1) * g.w, x1 = clamp(nx(B.c + 2 * B.w), 0, 1) * g.w, y0 = toY(B.g?.[1] ?? 1, g), y1 = toY(B.g?.[0] ?? 0, g);
        c.strokeRect(x0 + 0.5, y0 + 0.5, x1 - x0 - 1, y1 - y0 - 1); });
    } else {
      /* 1D: histogram, then the colour fill under the opacity curve (row 0 of the baked table), then the curve */
      const h = ctx.hist; if (h && h.length) { let m = 0; const L = Array.from(h, v => Math.log1p(v)); for (const v of L) m = Math.max(m, v);
        c.fillStyle = inkA(0.16); const bw = g.w / L.length;
        for (let i = 0; i < L.length; i++) if (L[i] > 0) { const y = toY(L[i] / (m || 1), g); c.fillRect(i * bw, y, Math.max(1, bw - 0.4), g.h - PADB - y); } }
      for (let i = 0; i < TF_W; i++) { const o = 4 * i, a = baked[o + 3] / 255; if (a <= 0.002) continue;
        c.fillStyle = `rgba(${baked[o]},${baked[o + 1]},${baked[o + 2]},0.78)`; c.fillRect(i / TF_W * g.w, toY(a, g), g.w / TF_W + 0.6, toY(0, g) - toY(a, g)); }
      c.strokeStyle = ink; c.lineWidth = 1.25; c.beginPath();
      for (let i = 0; i < TF_W; i++) { const x = (i + 0.5) / TF_W * g.w, y = toY(baked[4 * i + 3] / 255, g); i ? c.lineTo(x, y) : c.moveTo(x, y); } c.stroke(); }
    if (!st.bands.length && !st.ramp) { c.fillStyle = inkA(0.55); c.font = "11px ui-monospace, Menlo, monospace"; c.textAlign = "center"; c.textBaseline = "middle";
      c.fillText("double-click or + band", g.w / 2, g.h / 2); }
    if (st.ramp) rampH(st.ramp).forEach(([hx, hy], k) => { if (hx < -0.02 || hx > 1.02) return; const on = sel < 0, s = on ? 9 : 7.5;
      const x = clamp(clamp(hx, 0, 1) * g.w, s / 2 + 1, g.w - s / 2 - 1), y = clamp(toY(hy, g), s / 2 + 1, g.h - s / 2 - 1);
      c.fillStyle = k ? inkA(0.95) : inkA(0.45); c.fillRect(x - s / 2, y - s / 2, s, s);
      c.lineWidth = on ? 2 : 1.25; c.strokeStyle = on ? acc : "rgba(10,13,24,0.9)"; c.strokeRect(x - s / 2, y - s / 2, s, s);
      if (on && k && document.activeElement === cv) { c.strokeStyle = acc; c.lineWidth = 1; c.strokeRect(x - 8, y - 8, 16, 16); } });
    st.bands.forEach((B, i) => { const [hx, hy] = handle(B); if (hx < -0.02 || hx > 1.02) return; const x = clamp(hx, 0, 1) * g.w, y = toY(hy, g);
      c.beginPath(); c.arc(x, y, i === sel ? 5.5 : 4.5, 0, 2 * Math.PI); c.fillStyle = hex(bandCol(B)); c.fill();
      c.lineWidth = i === sel ? 2 : 1.25; c.strokeStyle = i === sel ? acc : "rgba(10,13,24,0.9)"; c.stroke();
      if (i === sel && document.activeElement === cv) { c.beginPath(); c.arc(x, y, 9, 0, 2 * Math.PI); c.strokeStyle = acc; c.lineWidth = 1; c.stroke(); } });
  }
  /* the item under the pointer: a band index, or -1 for the ramp (with end k 0 low / 1 high), or null */
  function hit(ev) { const g = geom(); let best = null, d0 = 12;
    const at = (hx, hy) => Math.hypot(ev.clientX - g.l - clamp(clamp(hx, 0, 1) * g.w, 5, g.w - 5), ev.clientY - g.t - clamp(toY(hy, g), 5, g.h - 5));
    if (st.ramp) rampH(st.ramp).forEach(([hx, hy], k) => { const d = at(hx, hy); if (d < d0) { d0 = d; best = {i: -1, k}; } });
    st.bands.forEach((B, i) => { const [hx, hy] = handle(B), d = at(hx, hy); if (d < d0) { d0 = d; best = {i, k: 0}; } });
    return best; }
  let drag = null;
  cv.addEventListener("pointerdown", ev => { if (ev.button !== 0) return; const h = hit(ev); if (!h) return;
    sel = h.i; const B = item(); drag = {x: ev.clientX, y: ev.clientY, k: h.k, c: B.c, w: B.w, lo: B.lo, hi: B.hi, a: B.a, g: (B.g || [0, 1]).slice(), shift: ev.shiftKey, geo: geom(), moved: false};
    try { cv.setPointerCapture(ev.pointerId); } catch { /* synthetic events */ }
    ev.preventDefault(); cv.focus({preventScroll: true}); syncInputs(); draw(); say(); });
  const gShift = (g0, d) => { const s = g0[1] - g0[0], m = clamp((g0[0] + g0[1]) / 2 + d, s / 2, 1 - s / 2); return [r3(m - s / 2), r3(m + s / 2)]; };
  cv.addEventListener("pointermove", ev => { if (!drag) { cv.style.cursor = hit(ev) ? "grab" : "crosshair"; return; }
    const B = item(), G = drag.geo, dx = (ev.clientX - drag.x) / G.w, dy = -(ev.clientY - drag.y) / (G.h - PADT - PADB); if (!B) return; custom(); drag.moved = true;
    if (ramp()) { /* ramp ends: x moves that end (kept 0.05 dex apart); y: the high end's opacity (1D) or the gradient range (2D) */
      if (drag.k) B.hi = r3(clamp(drag.hi + dx * span(), B.lo + 0.05, st.win[1] + span())); else B.lo = r3(clamp(drag.lo + dx * span(), st.win[0] - span(), B.hi - 0.05));
      if (st.twoD) { if (B.g || Math.abs(dy) > 0.01) B.g = gShift(drag.g, dy); } else if (drag.k) B.a = r3(clamp(drag.a + dy, 0, 1)); }
    else if (drag.shift) B.w = r3(clamp(drag.w * Math.exp(3 * dx), 0.01, 2));
    else { B.c = r3(clamp(drag.c + dx * span(), st.win[0], st.win[1]));
      if (st.twoD) B.g = gShift(drag.g, dy);
      else B.a = r3(clamp(drag.a + dy, 0, 1)); }
    emit(false, "drag"); });
  const end = () => { if (!drag) return; const m = drag.moved; drag = null; if (m) { emit(true, "drag"); say(); } };
  cv.addEventListener("pointerup", end); cv.addEventListener("pointercancel", end); cv.addEventListener("lostpointercapture", end);
  cv.addEventListener("dblclick", ev => { if (hit(ev)) return; const g = geom(), x = clamp((ev.clientX - g.l) / g.w, 0, 1), y = clamp(1 - (ev.clientY - g.t - PADT) / (g.h - PADT - PADB), 0, 1);
    add(vx(x), st.twoD ? 0.6 : Math.max(0.1, y)); });
  cv.addEventListener("focus", () => { draw(); say(); }); cv.addEventListener("blur", () => draw());
  cv.addEventListener("keydown", ev => {
    if (ev.ctrlKey || ev.metaKey || ev.altKey) return;
    const k = ev.key, B = item(), R = !!ramp(), dv = (ev.shiftKey ? 0.05 : 0.01) * span();
    if (k === "PageDown" || k === "]") step(1);
    else if (k === "PageUp" || k === "[") step(-1);
    else if (k === "Insert" || k === "n" || k === "N") add();
    else if (!B) { if (k === "Enter" || k === " ") add(); else return; }
    else if (k === "ArrowLeft" || k === "ArrowRight") { custom(); const d = k === "ArrowLeft" ? -dv : dv;
      if (R) { B.lo = r3(B.lo + d); B.hi = r3(B.hi + d); } else B.c = r3(clamp(B.c + d, st.win[0], st.win[1])); emit(true, "key"); say(); }
    else if (k === "ArrowUp" || k === "ArrowDown") { custom(); const d = (k === "ArrowUp" ? 1 : -1) * (ev.shiftKey ? 0.1 : 0.05);
      if (st.twoD && ev.shiftKey) B.g = gShift(B.g || [0, 1], d / 2);
      else B.a = r3(clamp(B.a + d, 0, 1)); emit(true, "key"); say(); }
    else if (k === "+" || k === "=" || k === "-" || k === "_") { custom(); const f = k === "+" || k === "=" ? 1.15 : 1 / 1.15;
      if (R) { const m = (B.lo + B.hi) / 2, h = Math.max(0.025, (B.hi - B.lo) / 2 * f); B.lo = r3(m - h); B.hi = r3(m + h); } else B.w = r3(clamp(B.w * f, 0.01, 2));
      emit(true, "key"); say(); }
    else if (k === "Delete" || k === "Backspace") del();
    else return;
    ev.preventDefault(); ev.stopPropagation(); });

  /* ---- inputs ---- */
  q("#v3-tf-preset").addEventListener("change", ev => { sel = 0; onChange(copy(st), {commit: true, reason: "preset", preset: ev.target.value}); });
  q("#v3-tf-reset").addEventListener("click", () => { sel = 0; onChange(copy(st), {commit: true, reason: "reset"}); });
  q("#v3-tf-add").addEventListener("click", () => add());
  q("#v3-tf-del").addEventListener("click", () => del());
  /* bandIn: a band-only control; itemIn: acts on the selected band or the ramp */
  const onIn = (s, get, f) => { q(s).addEventListener("input", ev => { const B = get(); if (!B) return; custom(); f(B, ev.target.value); emit(false, "input"); });
    q(s).addEventListener("change", () => { if (get()) emit(true, "input"); }); };
  const bandIn = (s, f) => onIn(s, band, f), itemIn = (s, f) => onIn(s, item, f);
  bandIn("#v3-tf-w", (B, v) => { B.w = r3(+v); });
  itemIn("#v3-tf-a", (B, v) => { B.a = r3(+v); });
  bandIn("#v3-tf-col", (B, v) => { if (/^#[0-9a-f]{6}$/i.test(v)) B.rgb = rgbOf(v); });
  itemIn("#v3-tf-g0", (B, v) => { const g = B.g || [0, 1]; B.g = [r3(Math.min(+v, g[1] - 0.02)), g[1]]; });
  itemIn("#v3-tf-g1", (B, v) => { const g = B.g || [0, 1]; B.g = [g[0], r3(Math.max(+v, g[0] + 0.02))]; });
  q("#v3-tf-2d").addEventListener("change", ev => { st.twoD = ev.target.checked; custom(); emit(true, "2d"); });
  q("#v3-tf-shade").addEventListener("input", ev => { st.shade = +ev.target.value; emit(false, "shade"); });
  q("#v3-tf-shade").addEventListener("change", () => emit(true, "shade"));
  q("#v3-tf-emis").addEventListener("change", ev => { st.emis = ev.target.value; emit(true, "emis"); });
  q("#v3-tf-gamma").addEventListener("input", ev => { st.gamma = +ev.target.value; emit(false, "gamma"); });
  q("#v3-tf-gamma").addEventListener("change", () => emit(true, "gamma"));
  if (globalThis.ResizeObserver) new ResizeObserver(() => draw()).observe(cv);
  return ed;
}
