// Instrument and velocity controls of the TNG50 explorer (Phase-3 design §6.1, §6.3, brief C1, C2, C4): one log R
// slider per band present in the selected ions (#R-<band>-0, and #R-<band>-1 in the 2 R and 2x2 layouts), the S/N
// sliders #sn-0 and #sn-1 (log, integers 2 to 100) and the half-window #vhw (log, 10 km/s to vmax).
import {bandsOf, twoR, twoSN, rToT, tToR, snStops, snToT, vToT, tToV, SLIDER_MAX, fmtR} from "./state.js";

/* els: {rsliders, sn: [input, input], snOut: [out, out], sn1wrap, vhw, vhwOut}; ctx: {S, reg, vmax(), onChange(kind)} */
export function createInstrument(els, ctx) {
  const {reg} = ctx, STOPS = snStops(reg.SNR.min, reg.SNR.max);
  const fill = inp => inp.style.setProperty("--pc", ((inp.value - inp.min) / (inp.max - inp.min || 1) * 100) + "%");
  let built = "";
  function build() {
    const S = ctx.S, bands = bandsOf(reg, S.ions), two = twoR(S.layout), sig = bands.join(",") + "|" + two;
    if (sig !== built) {
      built = sig;
      els.rsliders.innerHTML = bands.map(b => [0, 1].filter(i => i === 0 || two).map(i => { const B = reg.BANDS[b];
        return `<label class="ctl"${B.note ? ` title="${B.note}"` : ""}><span class="k">R${two ? `<sub>${i + 1}</sub>` : ""} <em>${B.label}</em></span>` +
          `<input type="range" id="R-${b}-${i}" data-testid="R-${b}-${i}" min="0" max="${SLIDER_MAX}" step="1" aria-label="R ${B.label}${two ? " " + (i + 1) : ""}">` +
          `<output id="R-${b}-${i}-out" for="R-${b}-${i}"></output></label>`; }).join("")).join("");
      for (const inp of els.rsliders.querySelectorAll("input")) inp.addEventListener("input", () => {
        const [, b, i] = inp.id.split("-"); ctx.S.R[b][+i] = tToR(reg.BANDS[b].R, +inp.value); syncR(inp); ctx.onChange("R"); });
    }
    els.sn1wrap.hidden = !twoSN(S.layout);
    sync();
  }
  /* B_fix F4: each slider announces its value (aria-valuetext), not the slider index */
  const vt = (inp, t) => inp.setAttribute("aria-valuetext", t);
  function syncR(inp) { const [, b, i] = inp.id.split("-"), t = fmtR(ctx.S.R[b][+i]); document.getElementById(`${inp.id}-out`).textContent = t; vt(inp, `R ${t}`); fill(inp); }
  function sync() {
    const S = ctx.S;
    for (const inp of els.rsliders.querySelectorAll("input")) { const [, b, i] = inp.id.split("-"); inp.value = rToT(reg.BANDS[b].R, S.R[b][+i]); syncR(inp); }
    els.sn.forEach((inp, i) => { inp.value = snToT(STOPS, S.sn[i]); els.snOut[i].textContent = S.sn[i]; vt(inp, `S/N ${S.sn[i]}`); fill(inp); });
    syncV();
  }
  function syncV() { const vm = ctx.vmax(); els.vhw.value = vToT(ctx.S.vhw, vm); els.vhwOut.textContent = "±" + ctx.S.vhw; vt(els.vhw, `±${ctx.S.vhw} km/s`); fill(els.vhw); }
  els.sn.forEach((inp, i) => { inp.min = 0; inp.max = STOPS.length - 1; inp.step = 1;
    inp.addEventListener("input", () => { ctx.S.sn[i] = STOPS[+inp.value]; els.snOut[i].textContent = ctx.S.sn[i]; vt(inp, `S/N ${ctx.S.sn[i]}`); fill(inp); ctx.onChange("sn"); }); });
  els.vhw.min = 0; els.vhw.max = SLIDER_MAX; els.vhw.step = 1;
  els.vhw.addEventListener("input", () => { ctx.S.vhw = tToV(+els.vhw.value, ctx.vmax()); ctx.onChange("vhw"); });
  return {build, sync, syncV, fill, STOPS};
}
