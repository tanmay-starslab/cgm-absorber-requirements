// Phase-3 UI budget test in headless Edge (design 6.2, 6.6; brief C9, C11, C12, C13, C14; pick.md items 4 and 5).
// Usage: TNG_BROWSER=1 node tests/js/ui_budget.mjs [docs/tng50 dir] [--page FILE] [--port N] [--profile DIR]
//            [--viz DIR] [--inject shim.js] [--edge BIN] [--shots DIR]
// For 1440x900, 1024x768 and 390x844 (mobile), each in light and dark (prefers-color-scheme, measured in-page), on the
// default state (Spectra tab, no popover open) it checks:
//   C14 visible static prose <= 150 words (design 6.2 rule: letter-bearing tokens of the rendered text, excluding
//       #statusline, #readouts, #fitstatus, #pill, #galcount, canvas and closed popovers, so the licence and
//       disclosure popovers do not count);
//   C12 no U+00B7, U+2022, U+2027, U+22C5, U+30FB or " . " in any text node (shown or hidden), tooltip, aria label,
//       placeholder, CSS generated content, document.title or captured canvas string;
//   C11 #title font-size <= 14 px and at most 3 words; no "Interactive companion";
//   C9  #spectra >= 70 % of the viewport width and >= 60 % of its height at >= 1024 px (>= 75 % width at 1440 with
//       the side column open, pick.md 4), the top bar <= 48 px high; at 390 px #spectra spans the width minus the
//       16 px gutters, #controls-open is shown and opens the controls, and there is no horizontal scroll;
//   C13 on the 3D tab #v3d-stage is square within 1 px, never full-bleed (<= 60 vw and <= 900 px at >= 1024 px),
//       with #v3d-controls beside it (>= 280 px wide) at >= 1024 px and below it otherwise.
// Once, at 1440 light: the side-column toggle (#side-toggle, or a button with aria-controls="side") widens the
// spectra, and the separator scan is repeated with the fit overlay on and a hover readout shown.
// Without TNG_BROWSER=1 it prints "skipped".
import {join, resolve} from "node:path";
import {loadavg} from "node:os";
import {ROOT, parseArgs, checker, serve, launch, READY, UI_LIB, BLOCK, pickPage, readInjects, sleep} from "./lib/browser.mjs";

if (!process.env.TNG_BROWSER) { console.log("skipped (set TNG_BROWSER=1 to run the headless Edge UI budget test)"); process.exit(0); }
const {pos, opt} = parseArgs(process.argv.slice(2));
const DIR = resolve(pos[0] || join(ROOT, "docs/tng50")), PAGE = pickPage(DIR, opt.page), SHOTS = opt.shots && resolve(opt.shots);
const C = checker(), check = C.check, note = C.note;
const srv = await serve({dir: DIR, page: PAGE, port: opt.port, viz: opt.viz || process.env.TNG_VIZ});
const P = await launch({profile: opt.profile, edge: opt.edge, inject: readInjects(opt.inject), block: BLOCK});
const VPS = [[1440, 900, false], [1024, 768, false], [390, 844, true]];
const MEASURE = `(() => { const w = __ui.words(), sep = __ui.sepScan(), t = document.getElementById("title"), cs = t && getComputedStyle(t);
  return {iw: innerWidth, ih: innerHeight, dark: matchMedia("(prefers-color-scheme: dark)").matches, bg: getComputedStyle(document.body).backgroundColor + " " + getComputedStyle(document.body).backgroundImage.slice(0, 40),
    ink: getComputedStyle(document.body).color, words: w.n, list: w.list.join(" "), sep, titlePx: cs ? parseFloat(cs.fontSize) : null, titleText: t ? t.innerText.trim() : null,
    companion: /interactive\\s+companion/i.test(document.body.innerText), sp: __ui.rect("#spectra"), top: __ui.rect("#top"), sw: document.documentElement.scrollWidth,
    ctlOpen: __ui.vis(document.getElementById("controls-open")), state: tngApp.getState()}; })()`;
const pct = (a, b) => (100 * a / b).toFixed(1) + " %";
const bgs = {};
try {
  console.log(`serving ${PAGE.replace(ROOT + "/", "")} at ${srv.base}; Edge up in ${(P.startMs / 1000).toFixed(1)} s; load average ${loadavg().map(x => x.toFixed(2)).join(" ")}`);
  for (const [w, h, mobile] of VPS) for (const dark of [false, true]) {
    const tag = `${w}x${h} ${dark ? "dark" : "light"}`;
    try {
      await P.viewport(w, h, mobile); await P.scheme(dark); await P.goto(srv.base + srv.query);
      const t = await P.waitFor(READY, 180000, 250);
      if (!check(t >= 0, `${tag}: page ready in ${(t / 1000).toFixed(1)} s`)) continue;
      await P.eval(UI_LIB); await sleep(800);
      const m = await P.eval(MEASURE); bgs[tag] = m.bg + " | " + m.ink;
      check(m.iw === w && m.ih === h && m.dark === dark, `${tag}: viewport ${m.iw}x${m.ih} and colour scheme ${m.dark ? "dark" : "light"} measured in-page`);
      check(m.words <= 150, `${tag}: C14 ${m.words} visible static words (<= 150)`); note(`words: ${m.list.slice(0, 400)}`);
      check(!m.sep.length, `${tag}: C12 no dot separator in text, attributes, generated content or canvas strings${m.sep.length ? ` (${m.sep.length}): ` + m.sep.slice(0, 6).map(x => `${x.where} ${x.what} "${x.text}"`).join("; ") : ""}`);
      check(m.titlePx !== null && m.titlePx <= 14 && m.titleText.split(/\s+/).length <= 3 && !m.companion, `${tag}: C11 title ${m.titlePx} px, "${m.titleText}", no "Interactive companion"`);
      check(m.state.tab === "spectra" && m.state.layout === "1", `${tag}: default state is the Spectra tab with one case (layout ${m.state.layout})`);
      if (w >= 1024) {
        const fw = m.sp.w / w, fh = m.sp.h / h, need = w >= 1440 ? 0.75 : 0.70;
        check(fw >= need && fh >= 0.60, `${tag}: C9 #spectra ${m.sp.w.toFixed(0)}x${m.sp.h.toFixed(0)} = ${pct(m.sp.w, w)} width (>= ${need * 100} %), ${pct(m.sp.h, h)} height (>= 60 %)`);
        check(m.top && m.top.h <= 48, `${tag}: top bar ${m.top ? m.top.h.toFixed(0) : "?"} px high (<= 48)`);
        check(m.sw <= w, `${tag}: no horizontal scroll (scrollWidth ${m.sw})`);
        const chips = await P.eval(`[...document.querySelectorAll("#ion-chips > button[data-ion]")].map(b => ({k: b.dataset.ion, vis: __ui.vis(b), ...__ui.textBox(b)}))`);
        check(chips.length === m.state.ions.length && chips.every(c => c.vis && c.w > 10 && c.px >= 9 && /\d/.test(c.text)),
          `${tag}: pick.md 1 the selected lines show as labelled chips: ${chips.map(c => `"${c.text}" ${c.w.toFixed(0)} px at ${c.px} px${c.vis ? "" : " hidden"}`).join(", ") || "none"}`);
      } else {
        check(m.sp.w >= w - 32 - 8 && m.sp.right <= w && m.sp.x >= 0, `${tag}: C9 #spectra ${m.sp.w.toFixed(0)} px wide at x ${m.sp.x.toFixed(0)} (viewport minus 16 px gutters = ${w - 32}, 8 px allowed for a panel frame)`);
        check(m.sw <= w, `${tag}: no horizontal scroll (scrollWidth ${m.sw})`);
        check(m.ctlOpen, `${tag}: #controls-open is shown`);
        if (m.ctlOpen) { await P.click("#controls-open"); await sleep(500);
          const o = await P.eval(`({sn: __ui.vis(document.getElementById("sn-0")), vhw: __ui.vis(document.getElementById("vhw")), exp: document.getElementById("controls-open").getAttribute("aria-expanded"), sw: document.documentElement.scrollWidth})`);
          if (SHOTS) await P.shot(join(SHOTS, `budget_${w}_${dark ? "dark" : "light"}_controls.png`));
          check(o.sn && o.vhw && o.sw <= w, `${tag}: #controls-open shows the instrument controls (#sn-0 ${o.sn}, #vhw ${o.vhw}, aria-expanded ${o.exp}), no horizontal scroll`);
          await P.click("#controls-open"); await P.key("Escape"); await sleep(300); }
      }
      if (SHOTS) await P.shot(join(SHOTS, `budget_${w}_${dark ? "dark" : "light"}.png`));
      // C13: the 3D tab
      await P.eval(`tngApp.showTab("3d")`); await P.waitFor(`__ui.vis(document.getElementById("v3d-stage"))`, 15000);
      const tMount = await P.waitFor("!!window.tngViewer3d", 30000, 250); await sleep(1200);
      { const c = await P.eval(`(() => { const e = document.getElementById("v3d-controls"); if (!e) return null;
          const heads = [...e.querySelectorAll("h2, h3, legend, .grp-k")].filter(h => __ui.vis(h)).map(h => h.innerText.trim()).filter(Boolean);
          const ctl = [...e.querySelectorAll("button, input, select")].filter(x => __ui.vis(x)).length;
          const st = getComputedStyle(e); return {vis: __ui.vis(e), op: st.opacity, visib: st.visibility, heads, ctl}; })()`);
        check(c && c.vis && c.heads.length >= 3 && c.ctl >= 3, `${tag}: C13 #v3d-controls is shown with labelled groups and controls (${c ? `${c.heads.length} visible headings [${c.heads.slice(0, 6).join(", ")}], ${c.ctl} visible controls, opacity ${c.op}, visibility ${c.visib}` : "absent"})`);
        if (tMount < 0) note(`${tag}: the 3D viewer did not mount within 30 s (three.js from the CDN or WebGL2 unavailable here)`); }
      const s = await P.eval(`({st: __ui.rect("#v3d-stage"), ct: __ui.rect("#v3d-controls"), top: __ui.rect("#top"), sw: document.documentElement.scrollWidth, ar: getComputedStyle(document.getElementById("v3d-stage")).aspectRatio,
        sep: __ui.sepScan()})`);
      const sq = s.st && Math.abs(s.st.w - s.st.h) <= 1;
      check(sq && s.st.w > 100, `${tag}: C13 #v3d-stage ${s.st ? s.st.w.toFixed(1) + " x " + s.st.h.toFixed(1) : "absent"} is square within 1 px (aspect-ratio ${s.ar})`);
      if (w >= 1024) {
        check(s.st && s.st.w <= Math.min(0.6 * w, 900) + 1 && s.st.w < w - 32, `${tag}: C13 stage ${s.st ? s.st.w.toFixed(0) : "?"} px is not full-bleed (<= min(60 vw, 900 px), viewport ${w})`);
        check(s.ct && s.ct.x >= s.st.right - 1 && s.ct.w >= 280, `${tag}: C13 #v3d-controls beside the stage (x ${s.ct ? s.ct.x.toFixed(0) : "?"} >= ${s.st ? s.st.right.toFixed(0) : "?"}), ${s.ct ? s.ct.w.toFixed(0) : "?"} px wide (>= 280)`);
      } else check(s.ct && s.ct.y >= s.st.bottom - 1 && s.st.right <= w && s.sw <= w, `${tag}: C13 #v3d-controls below the stage, stage inside the viewport, no horizontal scroll (scrollWidth ${s.sw})`);
      { if (tMount >= 0) await P.waitFor(`!window.tngViewer3d.levels || !JSON.stringify(tngViewer3d.levels()).includes("loading")`, 60000, 500);   // the transient download note settles first
        const w3 = await P.eval(`__ui.words()`), down = await P.eval(`document.body.innerText.includes("is unreachable")`);   // B_fix F8: C14 covers the 3D tab as well
        /* a 3D data host that does not answer (a load-dependent environment failure) adds its error text twice; that is
           an error state, not the static prose budget, so it is noted instead of judged */
        if (down) note(`${tag}: C14 not judged on the 3D tab: the 3D data host did not answer (${w3.n} words with the error text)`);
        else check(w3.n <= 150, `${tag}: C14 ${w3.n} visible static words on the 3D tab (<= 150)`);
        note(`3D words: ${w3.list.join(" ").slice(0, 400)}`); }
      check(!s.sep.length, `${tag}: C12 no dot separator on the 3D tab${s.sep.length ? ": " + s.sep.slice(0, 5).map(x => `${x.where} ${x.what} "${x.text}"`).join("; ") : ""}`);
      if (SHOTS) await P.shot(join(SHOTS, `budget_${w}_${dark ? "dark" : "light"}_3d.png`));
      await P.eval(`tngApp.showTab("spectra")`); await sleep(300);
      // once: side-column toggle, and the separator scan with the fit overlay and a hover readout
      if (w === 1440 && !dark) {
        const tg = await P.eval(`(() => { const b = document.querySelector('#side-toggle, [data-testid="side-toggle"], button[aria-controls="side"]'); return b && __ui.vis(b) ? (b.id ? "#" + b.id : '[data-testid="side-toggle"]') : null; })()`);
        if (check(!!tg, `${tag}: pick.md 4 side-column toggle present (${tg || "no #side-toggle or button[aria-controls=side]"})`)) {
          const w0 = (await P.eval(`__ui.rect("#spectra")`)).w; await P.click(tg); await sleep(700); const w1 = (await P.eval(`__ui.rect("#spectra")`)).w;
          if (SHOTS) await P.shot(join(SHOTS, `budget_1440_light_side_closed.png`));
          await P.click(tg); await sleep(500); const w2 = (await P.eval(`__ui.rect("#spectra")`)).w;
          check(w1 >= 0.9 * w && w1 > w0 && Math.abs(w2 - w0) <= 2, `${tag}: closing the side column widens #spectra ${w0.toFixed(0)} -> ${w1.toFixed(0)} px (>= 90 % of ${w}), reopening restores ${w2.toFixed(0)}`);
        }
        await P.fn(`const f = document.getElementById("fit"); if (f && !f.checked) f.click();`);
        await P.waitFor(`["done", "budget", "error"].includes(document.getElementById("fitstatus")?.dataset.state)`, 120000, 200);
        const p = (await P.eval("tngApp.panels()"))[0]; await P.hover(p.rect.x + p.rect.w / 2, p.rect.y + p.rect.h / 2); await sleep(400);
        const f = await P.eval(`({sep: __ui.sepScan(), ro: document.getElementById("readouts")?.textContent || "", fs: document.getElementById("fitstatus")?.textContent || "", words: __ui.words().n})`);
        if (SHOTS) await P.shot(join(SHOTS, `budget_1440_light_fit.png`));
        check(!f.sep.length && f.ro.length > 0, `${tag}: C12 still no dot separator with the fit overlay on and a hover readout ("${f.ro}", "${f.fs}")${f.sep.length ? ": " + f.sep.slice(0, 5).map(x => `${x.where} ${x.what} "${x.text}"`).join("; ") : ""}`);
        check(f.words <= 150, `${tag}: C14 ${f.words} visible words with the fit on`);
        await P.fn(`const f = document.getElementById("fit"); if (f && f.checked) f.click();`); await P.hover(5, 5);
      }
    } catch (x) { check(false, `${tag}: aborted: ${String(x.message).split("\n")[0]}`); }
  }
  for (const [w, h] of VPS) { const a = bgs[`${w}x${h} light`], b = bgs[`${w}x${h} dark`];
    if (a && b) check(a !== b, `${w}x${h}: light and dark render differently (body ${a.split(" | ")[0].slice(0, 30)} vs ${b.split(" | ")[0].slice(0, 30)})`); }
  if (SHOTS) note("screenshots in " + SHOTS);
  check(!P.exceptions.length, `no page exceptions${P.exceptions.length ? ": " + [...new Set(P.exceptions)].slice(0, 3).join(" | ") : ""}`);
} finally { await P.close(); await srv.close(); }
process.exit(C.finish());
