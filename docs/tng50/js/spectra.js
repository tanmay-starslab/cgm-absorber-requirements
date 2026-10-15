// Spectra stage of the TNG50 explorer (Phase-3 design §6.2, §6.3): one canvas of panels (rows = selected ions in
// registry order, columns = instrument cases), the noiseless model shaded in the ion colour under the degraded data,
// the optional intrinsic overlay and the on-the-fly fit (model, component profiles, ticks), pan and zoom (drag,
// arrow keys, ctrl/cmd+wheel, + and -, Home), the hover readout, and one absolutely positioned hit box per panel.
// The page (app.js) owns the state; this module only reads it through `P` (the provider) and reports view changes.
import {casesFor, minus, nf, fitLoose} from "./state.js";

const STRIP_H = 48;                                     // #vaxis height (css)
const LBL_FONT = "600 11px", HDR = 20, PAD_L = 24, PAD_R = 6, AXIS_H = 30, GAP_X = 16, GAP_Y = 12, MIN_ROW = 66, MAX_ROW = 240;
const FIT_FLAG_HOLLOW = 2 | 128;                       // BOUND | BUDGET: hollow ticks (and unconstrained ones, state.js fitLoose)

/* P: {S, reg, data(ion, ci) -> {v, flux, model, dvp, line, vSys} | null, fit(ion, ci) -> result | null,
       caseRS(ion, ci) -> [R, sn], vmax() -> km/s, color(key) -> css colour, onView({vc, vhw}, why), onReadout(text)} */
export function createSpectra({box, cv, hitboxes, axis, axisCv, more}, P) {
  const ctx = cv.getContext("2d"), actx = axisCv ? axisCv.getContext("2d") : null;
  let G = null, hoverV = null, hoverP = null, raf = 0, lastMs = 0, nDraw = 0;
  const css = n => getComputedStyle(document.documentElement).getPropertyValue(n).trim();

  function geometry() {
    /* H: the stage height with the axis strip folded back in, so the rows do not change when the strip shows or hides */
    const S = P.S, W = box.clientWidth, H = box.clientHeight + (axis && !axis.hidden ? axis.offsetHeight : 0), cs = casesFor(S.layout), narrow = W < 640;
    const ncol = narrow && cs.length > 2 ? 2 : cs.length, sub = Math.ceil(cs.length / ncol), nI = S.ions.length;
    const nrows = nI * sub, gx = narrow ? 8 : GAP_X, gy = GAP_Y, blk = sub > 1 ? 10 : 0;
    const pw = Math.max(40, (W - PAD_L - PAD_R - gx * (ncol - 1)) / ncol), minH = narrow ? 64 : MIN_ROW;
    const maxH = narrow ? 170 : MAX_ROW;
    let ph = (H - 2 - AXIS_H - gy * (nrows - 1) - blk * (nI - 1)) / Math.max(1, nrows) - HDR;
    if (ph < minH && nrows > 1) {
      /* B_tune2 M3: the rows overflow. The visible height then holds a whole number of rows (an ion boundary if one is
         within reach), the last of them ending at the bottom of the stage, so no cut strip of a row shows above the
         pinned axis strip (which sits below the stage, not over it) */
      const fill = k => (H - STRIP_H - 6 - (k - 1) * gy - Math.floor((k - 1) / sub) * blk) / k - HDR;
      let k = 1; while (k + 1 < nrows && fill(k + 1) >= minH) k++;
      const kk = Math.floor(k / sub) * sub; if (kk >= 1 && kk < k && fill(kk) <= maxH) k = kk;
      ph = Math.min(maxH, Math.max(minH, fill(k)));
    } else ph = Math.min(maxH, Math.max(minH, ph));
    const panels = []; let y = 2;
    S.ions.forEach(ion => { for (let s = 0; s < sub; s++) { for (let c = 0; c < ncol; c++) { const ci = s * ncol + c; if (ci >= cs.length) continue;
      panels.push({ion, ci, col: c, first: c === 0, top: s === 0, x: PAD_L + c * (pw + gx), y: y + HDR, w: pw, h: ph, last: false}); } y += HDR + ph + gy; } y += blk; });
    const bottom = {}; for (const p of panels) if (!bottom[p.col] || p.y > bottom[p.col].y) bottom[p.col] = p;
    for (const p of Object.values(bottom)) p.last = true;
    return {W, H: Math.max(10, Math.round(y - gy - blk + AXIS_H)), panels, cs, ncol, narrow};
  }
  /* tick step: labels at least 40 px apart */
  function tickStep(pw, span) { for (let e = -1; e < 6; e++) for (const m of [1, 2, 5]) { const st = m * 10 ** e; if (st * pw / span >= 40) return st; } return 10000; }

  function draw() {
    const t0 = performance.now(), S = P.S;
    G = geometry(); const dpr = Math.min(2, window.devicePixelRatio || 1);
    cv.style.width = G.W + "px"; cv.style.height = G.H + "px";
    const bw = Math.round(G.W * dpr), bh = Math.round(G.H * dpr); if (cv.width !== bw || cv.height !== bh) { cv.width = bw; cv.height = bh; }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0); ctx.clearRect(0, 0, G.W, G.H);
    const ink = css("--ink"), muted = css("--muted"), grid = css("--grid"), dataC = css("--data"), panelBg = css("--panel"), fitInk = css("--fit") || ink;
    const mono = css("--mono") || "ui-monospace,monospace", sans = css("--sans") || "system-ui", dark = css("--scheme") === "dark";
    const v0 = S.vc - S.vhw, v1 = S.vc + S.vhw, span = v1 - v0, ylo = -0.12, yhi = 1.24;
    const step = tickStep(G.panels[0] ? G.panels[0].w : 300, span);
    /* tune1 F6, F13, B_tune2 M1: the case label always keeps its R and S/N prefixes. It reads "R 15,000  S/N 20",
       "R 15k  S/N 20" or, where space is shortest, "R 15k S/N 20", and one format serves the whole grid. Each ion's first
       header also carries its catalogue log N; that note is the first thing dropped when the header is short (the hover
       readout always has it), before the number format shortens */
    const lab = new Map(); let gLvl = 0;
    for (const p of G.panels) { const [R, sn] = P.caseRS(p.ion, p.ci); let tw = 0, nw = 0, note = "", t = "";
      if (p.first) { ctx.font = `${LBL_FONT} ${sans}`; t = P.reg.ION[p.ion].label; tw = ctx.measureText(t).width;
        note = p.top && P.rowNote ? P.rowNote(p.ion) || "" : ""; ctx.font = `10.5px ${mono}`; nw = note ? ctx.measureText(note).width + 10 : 0; }
      ctx.font = `10.5px ${mono}`;
      const fits = (lvl, withNote) => p.x + p.w - ctx.measureText(caseText(R, sn, lvl)).width >= p.x + (p.first ? tw + 20 + (withNote ? nw : 0) : 0);
      if (note && !fits(1, true)) note = "";               // no room beside the box: the hover readout still carries it
      const lvl = fits(0, !!note) ? 0 : fits(1, !!note) ? 1 : 2; if (lvl > gLvl) gLvl = lvl; lab.set(p, {t, tw, note}); }
    for (const p of G.panels) {
      const [R, sn] = P.caseRS(p.ion, p.ci), col = P.color(p.ion), d = P.data(p.ion, p.ci);
      const X = v => p.x + (v - v0) / span * p.w, Y = f => p.y + (yhi - f) / (yhi - ylo) * p.h;
      ctx.save(); ctx.beginPath(); ctx.rect(p.x, p.y, p.w, p.h); ctx.fillStyle = panelBg; ctx.fill(); ctx.clip();
      ctx.lineWidth = 1; ctx.strokeStyle = grid;
      for (let v = Math.ceil(v0 / step) * step; v <= v1; v += step) { const x = Math.round(X(v)) + .5; ctx.beginPath(); ctx.moveTo(x, p.y); ctx.lineTo(x, p.y + p.h); ctx.stroke(); }
      ctx.beginPath(); ctx.moveTo(p.x, Math.round(Y(0)) + .5); ctx.lineTo(p.x + p.w, Math.round(Y(0)) + .5); ctx.stroke();
      ctx.setLineDash([3, 3]); ctx.beginPath(); ctx.moveTo(p.x, Math.round(Y(1)) + .5); ctx.lineTo(p.x + p.w, Math.round(Y(1)) + .5); ctx.stroke();
      if (v0 < 0 && v1 > 0) { ctx.setLineDash([2, 4]); ctx.globalAlpha = .7; ctx.beginPath(); ctx.moveTo(Math.round(X(0)) + .5, p.y); ctx.lineTo(Math.round(X(0)) + .5, p.y + p.h); ctx.stroke(); ctx.globalAlpha = 1; }
      ctx.setLineDash([]);
      p.fitR = undefined;
      if (!d) { ctx.font = `11px ${sans}`; ctx.fillStyle = muted; ctx.textAlign = "center"; ctx.textBaseline = "middle";
        ctx.fillText(P.missingText(p.ion), p.x + p.w / 2, p.y + p.h / 2); ctx.textAlign = "left"; }
      else {
        const n = d.v.length, va = d.v[0], dv = d.dvp, i0 = Math.max(0, Math.floor((v0 - va) / dv) - 1), i1 = Math.min(n - 1, Math.ceil((v1 - va) / dv) + 1);
        const dens = (span / dv) / p.w;                  // data pixels per screen px
        if (i1 > i0) {
          /* noiseless model, shaded between it and the continuum */
          const ks = Math.max(1, Math.floor(dens / 2));
          ctx.beginPath(); ctx.moveTo(X(d.v[i0]), Y(1)); for (let i = i0; i <= i1; i += ks) ctx.lineTo(X(d.v[i]), Y(d.model[i])); ctx.lineTo(X(d.v[i1]), Y(d.model[i1])); ctx.lineTo(X(d.v[i1]), Y(1)); ctx.closePath();
          ctx.globalAlpha = dark ? .24 : .22; ctx.fillStyle = col; ctx.fill(); ctx.globalAlpha = 1;
          /* degraded data: step-drawn pixels, or a per-column min/max envelope when pixels are denser than the screen */
          ctx.strokeStyle = dataC; ctx.lineWidth = dens > 1.2 ? .75 : 1; ctx.globalAlpha = dens > 1.2 ? (S.fit ? .4 : .62) : (S.fit ? .6 : .95); ctx.beginPath();
          if (dens > 1.5) { let cx = null, mn = 0, mx = 0;
            for (let i = i0; i <= i1; i++) { const x = Math.floor(X(d.v[i])) + .5, y = Y(d.flux[i]);
              if (x !== cx) { if (cx !== null) { ctx.lineTo(cx, mn); ctx.lineTo(cx, mx); } else ctx.moveTo(x, y); cx = x; mn = mx = y; } else { if (y < mn) mn = y; if (y > mx) mx = y; } }
            if (cx !== null) { ctx.lineTo(cx, mn); ctx.lineTo(cx, mx); } }
          else { const hw = dv / 2 * p.w / span;
            for (let i = i0; i <= i1; i++) { const x = X(d.v[i]), y = Y(d.flux[i]); if (i === i0) ctx.moveTo(x - hw, y); else ctx.lineTo(x - hw, y); ctx.lineTo(x + hw, y); } }
          ctx.stroke(); ctx.globalAlpha = 1;
        }
        if (S.intr && d.line) { const L = d.line, a = L.u0 + d.vSys, j0 = Math.max(0, Math.floor((v0 - a) / L.du) - 1), j1 = Math.min(L.n - 1, Math.ceil((v1 - a) / L.du) + 1);
          const ks = Math.max(1, Math.floor((span / L.du) / p.w / 2)); ctx.strokeStyle = col; ctx.lineWidth = 1.2; ctx.globalAlpha = .9; ctx.setLineDash([4, 3]); ctx.beginPath();
          /* B_fix m2: dashed, so the intrinsic overlay cannot be mistaken for a fitted component profile (solid, same colour) */
          for (let j = j0; j <= j1; j += ks) { const x = X(a + j * L.du), y = Y(L.flux[j]); j === j0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y); } ctx.stroke(); ctx.setLineDash([]); ctx.globalAlpha = 1; }
        if (S.fit) { const r = P.fit(p.ion, p.ci); p.fitR = r;
          const full = !!(r && r.modelFull && r.modelFull.length === n), mod = r ? (full ? dispOf(r, d.v).model : r.model) : null;
          if (mod && mod.length === n) {
            /* tune1 F4: the model and the component profiles are drawn only where they absorb (1 − F above EPS), so no bare
               line at F = 1 starts or stops in mid-panel. B_tune2 M2: the fitter also evaluates the components over the whole
               grid (modelFull, profilesFull), so a broad wing runs on past its fit window and tapers into the continuum;
               with only the in-window model a run grows by one sample at each end inside a window */
            const ks = Math.max(1, Math.floor(dens / 2)), wins = r.windows || [], inWin = full ? () => true : x => wins.some(([lo, hi]) => x >= lo && x <= hi);
            const cut = eps => full ? .3 * eps : eps;
            const runs = (arr, eps) => { const out = []; let a = -1, e = cut(eps);
              for (let i = i0; i <= i1 + 1; i++) { const on = i <= i1 && 1 - arr[i] > e;
                if (on && a < 0) a = i; else if (!on && a >= 0) { out.push([a > 0 && inWin(d.v[a - 1]) ? a - 1 : a, i < n && inWin(d.v[i]) ? i : i - 1]); a = -1; } }
              return out; };
            /* shallow parts fade: full ink from a depression of 3 EPS, 60 % from 2 EPS, 30 % below, so a broad shallow wing or
               a window edge near the continuum tapers out instead of ending as a hard line */
            /* with the whole-grid model the run continues down to a depression of 0.3 EPS and the ink follows the square of
               the depression (full from 3 EPS, 11 % at EPS, 5 % at the end, in steps of 5 %), so the curve fades into the
               continuum rather than stopping at about 1 − EPS or running on as a visible flat line */
            const lvl = full ? (dep, eps) => Math.max(.05, Math.min(1, Math.ceil((dep / (3 * eps)) ** 2 * 20) / 20)) : (dep, eps) => dep >= 3 * eps ? 1 : dep >= 2 * eps ? .6 : .3;
            const stroke = (arr, eps, a0) => { for (const [a, b] of runs(arr, eps)) { let cur = -1;
              const idx = []; for (let i = a; i < b; i += ks) idx.push(i); idx.push(b);
              for (const i of idx) { const x = X(d.v[i]), y = Y(arr[i]), l = lvl(1 - arr[i], eps);
                if (l !== cur) { if (cur >= 0) { ctx.lineTo(x, y); ctx.stroke(); } ctx.globalAlpha = a0 * l; ctx.beginPath(); ctx.moveTo(x, y); cur = l; }
                else ctx.lineTo(x, y); }
              if (cur >= 0) ctx.stroke(); } ctx.globalAlpha = 1; };
            /* EPS is a fifth of the per-pixel noise (0.6 to 3 %); with the in-window model only, a shallower depression is not drawn */
            const sg = typeof d.sigma === "number" ? d.sigma : 0, eps = Math.min(.03, Math.max(.006, .2 * sg));
            ctx.lineJoin = "round"; ctx.strokeStyle = col; ctx.lineWidth = 1; for (const pr of (full ? dispOf(r, d.v).profiles : r.profiles) || []) stroke(pr, eps, .5);
            ctx.strokeStyle = fitInk; ctx.lineWidth = 1.5; stroke(mod, eps, 1);
            for (const c of r.comps || []) { const x = X(c.v); if (x < p.x - 4 || x > p.x + p.w + 4) continue; const yt = Y(1.05);
              ctx.strokeStyle = col; ctx.lineWidth = 1.6; ctx.beginPath();
              if ((c.flag & FIT_FLAG_HOLLOW) || fitLoose(c)) { ctx.arc(x, yt - 4, 2.8, 0, 7); ctx.stroke(); } else { ctx.moveTo(x, yt); ctx.lineTo(x, yt - 7); ctx.stroke(); } } } }
      }
      if (hoverV !== null && hoverV > v0 && hoverV < v1) { ctx.strokeStyle = muted; ctx.globalAlpha = .55; ctx.lineWidth = 1; ctx.beginPath(); const x = Math.round(X(hoverV)) + .5; ctx.moveTo(x, p.y); ctx.lineTo(x, p.y + p.h); ctx.stroke(); ctx.globalAlpha = 1; }
      ctx.restore();
      /* labels: the ion chip (first column), "R 15,000  S/N 20" at the right, y ticks, velocity ticks under the last row */
      ctx.textBaseline = "middle"; const hy = p.y - 10, L = lab.get(p);
      if (p.first) { ctx.font = `${LBL_FONT} ${sans}`; ctx.strokeStyle = col; ctx.lineWidth = 1.2; roundRect(p.x + .5, hy - 7.5, L.tw + 12, 15, 3); ctx.stroke();
        ctx.fillStyle = col; ctx.fillText(L.t, p.x + 6.5, hy + .5);
        if (L.note) { ctx.font = `10.5px ${mono}`; ctx.fillStyle = muted; ctx.fillText(L.note, p.x + L.tw + 22, hy + .5); } }
      ctx.font = `10.5px ${mono}`; ctx.fillStyle = muted; ctx.textAlign = "right";
      ctx.fillText(caseText(R, sn, gLvl), p.x + p.w, hy + .5); ctx.textAlign = "left";
      if (p.first) { ctx.font = `10px ${mono}`; ctx.fillStyle = muted; ctx.textAlign = "right"; ctx.fillText("1", p.x - 5, Y(1)); ctx.fillText("0", p.x - 5, Y(0));
        /* B_fix m4: the quantities are named on the axes: normalised flux (rotated, left of the 1 and 0 ticks) and the
           velocity relative to systemic */
        if (p.h >= 60) { ctx.save(); ctx.translate(p.x - 17, (Y(1) + Y(0)) / 2); ctx.rotate(-Math.PI / 2); ctx.textAlign = "center"; ctx.font = `9.5px ${sans}`; ctx.fillText("flux", 0, 0); ctx.restore(); }
        ctx.textAlign = "left"; }
      if (p.last) { ctx.font = `10.5px ${mono}`; ctx.fillStyle = muted; ctx.textAlign = "center"; ctx.textBaseline = "top";
        for (let v = Math.ceil(v0 / step) * step; v <= v1 + 1e-9; v += step) { const x = X(v); if (x < p.x + 10 || x > p.x + p.w - 10) continue; ctx.fillText(minus(Math.round(v)), x, p.y + p.h + 5); }
        ctx.textAlign = "right"; ctx.fillText(axV(p.w), p.x + p.w, p.y + p.h + 18); ctx.textAlign = "left"; ctx.textBaseline = "middle"; }
    }
    hitboxes.innerHTML = G.panels.map(p => { const [R, sn] = P.caseRS(p.ion, p.ci);
      return `<div class="panel" role="img" data-ion="${p.ion}" data-case="${p.ci}" data-testid="panel-${p.ion}-${p.ci}" aria-label="${P.reg.ION[p.ion].label}, R ${nf.format(R)}, S/N ${sn}" style="left:${p.x}px;top:${p.y}px;width:${p.w}px;height:${p.h}px"></div>`; }).join("");
    axisUpdate();
    lastMs = performance.now() - t0; nDraw++;
    P.afterDraw && P.afterDraw(G);
  }
  const kf = x => x >= 1000 ? (x % 1000 ? (x / 1000).toFixed(1) : x / 1000) + "k" : String(x);
  const caseText = (R, sn, lvl) => lvl === 0 ? `R ${nf.format(R)}  S/N ${sn}` : lvl === 1 ? `R ${kf(R)}  S/N ${sn}` : `R ${kf(R)} S/N ${sn}`;
  const axV = w => w >= 360 ? "v (km/s from systemic)" : "km/s";
  /* B_fix m1: inside each fit window the drawn model and profiles are the fitted window model (what was minimised); the
     whole-grid copies (modelFull, profilesFull) are used only outside every window, where they carry the wings down to
     the continuum. Computed once per result. */
  function dispOf(r, v) {
    if (r._disp) return r._disp;
    const W = r.windows || [], n = v.length, inW = new Uint8Array(n);
    for (let i = 0; i < n; i++) for (const [lo, hi] of W) if (v[i] >= lo && v[i] <= hi) { inW[i] = 1; break; }
    const mix = (win, full) => { if (!win || win.length !== n) return full; const o = new Float32Array(n); for (let i = 0; i < n; i++) o[i] = inW[i] ? win[i] : full[i]; return o; };
    const pf = r.profilesFull || [], pw = r.profiles || [];
    r._disp = {model: mix(r.model, r.modelFull), profiles: pf.map((f, k) => mix(pw[k], f))};
    return r._disp;
  }
  function roundRect(x, y, w, h, r) { ctx.beginPath(); ctx.moveTo(x + r, y); ctx.arcTo(x + w, y, x + w, y + h, r); ctx.arcTo(x + w, y + h, x, y + h, r); ctx.arcTo(x, y + h, x, y, r); ctx.arcTo(x, y, x + w, y, r); ctx.closePath(); }
  /* tune1 F3, B_tune2 M3: when the rows overflow #spectra (many lines, or a phone in 2x2) the km/s axis of the last row
     is off screen; a strip right under the stage then repeats the velocity ticks of every column, and its pill (inside
     the strip, right-aligned under the ticks) names the lines whose rows lie below (click to scroll). The strip hides
     once the real axis is scrolled into view. */
  let axisSig = "";
  function axisUpdate() {
    if (!axis || !G) return;
    const S = P.S, ch = box.clientHeight, st = box.scrollTop, below = G.H - (st + ch);
    /* overflow is judged against the stage height without the strip, or a shown strip would keep itself shown */
    const show = G.H > ch + (axis.hidden ? 0 : axis.offsetHeight) + 2 && below > AXIS_H - 6;
    if (!show) { if (!axis.hidden) { axis.hidden = true; axisSig = ""; } return; }
    const hid = [...new Set(G.panels.filter(p => p.y + p.h > st + ch + 2).map(p => p.ion))];
    const names = hid.map(k => P.reg.ION[k].ion || P.reg.ION[k].label);
    const sig = [G.W, S.vc, S.vhw, S.layout, names.join(","), css("--muted"), css("--scheme")].join("|");
    axis.hidden = false; if (sig === axisSig) return; axisSig = sig;
    if (more) { more.hidden = !names.length; more.lastChild.textContent = names.length <= 3 ? `${names.join(", ")} below` : `${names.slice(0, 2).join(", ")} and ${names.length - 2} more below`;
      more.setAttribute("aria-label", `Scroll to ${names.join(", ")}`); }
    const dpr = Math.min(2, window.devicePixelRatio || 1), W = G.W, H = 18; axisCv.style.width = W + "px"; axisCv.style.height = H + "px";
    if (axisCv.width !== Math.round(W * dpr) || axisCv.height !== Math.round(H * dpr)) { axisCv.width = Math.round(W * dpr); axisCv.height = Math.round(H * dpr); }
    actx.setTransform(dpr, 0, 0, dpr, 0, 0); actx.clearRect(0, 0, W, H);
    const v0 = S.vc - S.vhw, span = 2 * S.vhw, cols = new Map(); for (const p of G.panels) if (!cols.has(p.col)) cols.set(p.col, p);
    const step = tickStep(G.panels[0] ? G.panels[0].w : 300, span), mono = css("--mono") || "ui-monospace,monospace";
    actx.font = `10.5px ${mono}`; actx.fillStyle = css("--muted"); actx.textBaseline = "middle";
    for (const p of cols.values()) { const X = v => p.x + (v - v0) / span * p.w, lw = actx.measureText(axV(p.w)).width + 14; actx.textAlign = "center";
      for (let v = Math.ceil(v0 / step) * step; v <= v0 + span + 1e-9; v += step) { const x = X(v); if (x < p.x + 10 || x > p.x + p.w - lw) continue; actx.fillText(minus(Math.round(v)), x, H / 2); }
      actx.textAlign = "right"; actx.fillText(axV(p.w), p.x + p.w, H / 2); }
  }
  box.addEventListener("scroll", () => axisUpdate(), {passive: true});
  /* the pill scrolls so that the first row not fully shown becomes the top row */
  if (more) more.addEventListener("click", () => { const st = box.scrollTop, ch = box.clientHeight, g = G || geometry();
    const nx = g.panels.filter(p => p.first && p.y + p.h > st + ch + 2).map(p => p.y - HDR - 2).sort((a, b) => a - b)[0];
    box.scrollTo({top: nx !== undefined && nx > st ? nx : st + Math.max(60, ch * .8), behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth"}); });
  const schedule = () => { if (!raf) raf = requestAnimationFrame(() => { raf = 0; if (box.offsetParent !== null || box.getClientRects().length) draw(); }); };

  /* ---- pan and zoom (§6.3) ---- */
  const view = (vc, vhw, why) => P.onView({vc, vhw}, why);
  function panelAt(x, y) { return G && G.panels.find(p => x >= p.x && x <= p.x + p.w && y >= p.y - HDR && y <= p.y + p.h); }
  const vAt = (p, x) => P.S.vc - P.S.vhw + (x - p.x) / p.w * 2 * P.S.vhw;
  /* B_fix R3: the state keeps vhw as an integer, so a small wheel or pinch step (|deltaY| of 1 to 5) would round away on
     every event; the wheel zoom keeps its own fractional half-window while the state still matches it */
  let wheelH = null;
  function zoom(f, at, frac) { const S = P.S, base = frac && wheelH !== null && Math.round(wheelH) === S.vhw ? wheelH : S.vhw;
    const vm = Math.max(10, P.vmax ? P.vmax() : 1500), nh = Math.min(vm, Math.max(10, base * f)); wheelH = frac ? nh : null;
    let vc = S.vc; if (at !== undefined) vc = at - (at - S.vc) * nh / base; view(vc, nh, "zoom"); }
  let drag = null;
  cv.addEventListener("pointerdown", e => { if (e.button !== 0) return; const p = panelAt(e.offsetX, e.offsetY); if (!p) return;
    drag = {x: e.clientX, vc: P.S.vc, w: p.w, id: e.pointerId}; try { cv.setPointerCapture(e.pointerId); } catch { /* synthetic events */ } box.classList.add("dragging"); });
  cv.addEventListener("pointermove", e => {
    if (drag && e.pointerId === drag.id) view(drag.vc - (e.clientX - drag.x) * 2 * P.S.vhw / drag.w, P.S.vhw, "drag");
    const p = panelAt(e.offsetX, e.offsetY);
    if (p && e.offsetY >= p.y) { hoverV = vAt(p, e.offsetX); hoverP = p; P.onReadout(P.readout(p, hoverV)); schedule(); }
    else if (hoverV !== null) { hoverV = null; hoverP = null; P.onReadout(null); schedule(); } });
  const endDrag = () => { if (drag) { drag = null; box.classList.remove("dragging"); P.onView(null, "dragend"); } };
  cv.addEventListener("pointerup", endDrag); cv.addEventListener("pointercancel", endDrag);
  cv.addEventListener("pointerleave", () => { if (hoverV !== null) { hoverV = null; hoverP = null; P.onReadout(null); schedule(); } });
  cv.addEventListener("wheel", e => { if (!(e.ctrlKey || e.metaKey)) return; e.preventDefault(); const p = panelAt(e.offsetX, e.offsetY);
    zoom(Math.exp(e.deltaY * 0.004), p ? vAt(p, e.offsetX) : P.S.vc, true); }, {passive: false});
  box.addEventListener("keydown", e => { const k = e.key, S = P.S;
    if (k === "ArrowLeft" || k === "ArrowRight") view(S.vc + (k === "ArrowLeft" ? -1 : 1) * (e.shiftKey ? .5 : .1) * 2 * S.vhw, S.vhw, "key");
    else if (k === "+" || k === "=") zoom(1 / 1.25); else if (k === "-" || k === "_") zoom(1.25);
    else if (k === "Home") P.onView({reset: true}, "key"); else return;
    e.preventDefault(); e.stopPropagation(); keyReadout(); });
  /* B_fix F10: keyboard (and touch) users get the readout too: after a key pan or zoom it reads the window centre of the
     last hovered panel, or of the first panel in view; it clears when the stage loses focus */
  function keyReadout() { if (!G || !G.panels.length) return; const st = box.scrollTop, ch = box.clientHeight;
    const p = hoverP && G.panels.includes(hoverP) ? hoverP : G.panels.find(q => q.y + q.h > st && q.y < st + ch) || G.panels[0];
    hoverP = p; hoverV = P.S.vc; P.onReadout(P.readout(p, hoverV)); schedule(); }
  box.addEventListener("blur", () => { if (hoverV !== null && !box.matches(":hover")) { hoverV = null; hoverP = null; P.onReadout(null); schedule(); } });
  cv.addEventListener("pointerdown", e => { if (e.pointerType !== "touch") return; const p = panelAt(e.offsetX, e.offsetY);
    if (p && e.offsetY >= p.y) { hoverV = vAt(p, e.offsetX); hoverP = p; P.onReadout(P.readout(p, hoverV)); schedule(); } });
  new ResizeObserver(() => schedule()).observe(box);

  return {draw, schedule, geometry: () => G || geometry(), get lastMs() { return lastMs; }, get nDraw() { return nDraw; },
    refreshReadout() { if (hoverP && hoverV !== null) P.onReadout(P.readout(hoverP, hoverV)); },
    panels() { const g = G || geometry(), r = cv.getBoundingClientRect(), b = box.getBoundingClientRect();
      return g.panels.map(p => ({p, rect: {x: Math.round(r.left + p.x), y: Math.round(r.top + p.y), w: Math.round(p.w), h: Math.round(p.h)}, visible: r.top + p.y + p.h > b.top && r.top + p.y < b.bottom})); }};
}
