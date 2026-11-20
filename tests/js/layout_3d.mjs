// Layout test of the 3D tab (ux/3d-layout): nothing the user clicks moves, the cards align with the stage, and the tab fits
// the viewport at every size and zoom. Opt-in like the other browser tests:
//   TNG_BROWSER=1 node tests/js/layout_3d.mjs --viz <viz dir with manifest_v2.json and gas.vectors> [--docs <dir>]
//       [--only 1440x900,390x844] [--themes dark,light] [--shots <dir>] [--json <file>]
// TNG_VIZ may stand in for --viz. GL draw and upload calls are stubbed (no-GL inject), so software WebGL never starves the
// page: the stage renders black, and only the layout is checked. For each viewport (11 sizes, 2 zooms) and theme:
//   (1) click Volume, then Integral, then the nH, v_los and σ_los field buttons with real mouse events: every card box seen
//       before a click, and the clicked label, moves by at most 1 px;
//   (2) the stage is square and fully in view on load with no scrolled ancestor; no page scroll from 1024 px; in the
//       side-by-side layouts the cards of a column share their left and right edges and the first card's top is the stage
//       top; at >= 1240 px Mode and the Pick ray heading are in view without scrolling; in the one-column tab layout the
//       control box spans exactly the stage width; on phones the controls open as a bottom sheet the Ask button does not cover.
// Without TNG_BROWSER=1 (e.g. under run_all.mjs) it prints "skipped".
import {existsSync, writeFileSync} from "node:fs";
import {join, resolve} from "node:path";
import {launch, serve, BLOCK, parseArgs, sleep, ROOT, checker, pickPage} from "./lib/browser.mjs";

if (!process.env.TNG_BROWSER) { console.log("skipped (set TNG_BROWSER=1 and pass --viz DIR to run the 3D layout test)"); process.exit(0); }
const {opt} = parseArgs(process.argv.slice(2)), VIZ = resolve(opt.viz || process.env.TNG_VIZ || ""), DOCS = resolve(opt.docs || join(ROOT, "docs/tng50"));
if (!existsSync(join(VIZ, "manifest_v2.json"))) { console.error("--viz DIR (or TNG_VIZ) with a manifest_v2.json is required"); process.exit(2); }
const SHOTS = opt.shots && resolve(opt.shots), ONLY = opt.only ? String(opt.only).split(",") : null, THEMES = String(opt.themes || "dark,light").split(",");
// [name, CSS width, CSS height, device scale factor, mobile]; "z150" / "z67" are a 1440x900 window at 150 % / 67 % zoom
const VP = [["1920x1080", 1920, 1080, 1], ["1512x830", 1512, 830, 2], ["1440x900", 1440, 900, 1], ["1366x768", 1366, 768, 1], ["1280x720", 1280, 720, 1],
  ["1024x768", 1024, 768, 1], ["960x1200", 960, 1200, 1], ["820x1180", 820, 1180, 2, true], ["390x844", 390, 844, 3, true], ["360x740", 360, 740, 3, true],
  ["1440z67", 2149, 1343, 0.67], ["1440z150", 960, 600, 1.5]].filter(v => !ONLY || ONLY.includes(v[0]));
const NOGL = `for (const C of [self.WebGL2RenderingContext, self.WebGLRenderingContext]) if (C) for (const f of ["drawArrays","drawElements","drawArraysInstanced","drawElementsInstanced","drawRangeElements","clear","blitFramebuffer","texImage3D","texSubImage3D","readPixels"]) if (C.prototype[f]) C.prototype[f] = function () {};`;
/* every box in viewport CSS px (getBoundingClientRect is in the zoomed frame on Chromium: divide nothing, compare like with like) */
const MEASURE = `(() => { const R = e => { if (!e) return null; const r = e.getBoundingClientRect(); if (!r.width || !r.height) return null;
    return {x: +r.left.toFixed(1), y: +r.top.toFixed(1), w: +r.width.toFixed(1), h: +r.height.toFixed(1), r: +r.right.toFixed(1), b: +r.bottom.toFixed(1)}; };
  const ctl = document.getElementById("v3-ctl"), vis = e => { if (!e) return false; const s = getComputedStyle(e); return s.display !== "none" && s.visibility !== "hidden" && !!R(e); };
  const o = {iw: innerWidth, ih: innerHeight, sy: scrollY, docH: document.documentElement.scrollHeight, docW: document.documentElement.scrollWidth,
    stage: R(document.getElementById("v3d-stage")), ctl: R(ctl), cards: {}, cols: {}, scrolled: [],
    tabs: vis(ctl && ctl.querySelector(".v3c-tabs")), sheet: document.body.classList.contains("ctl-open"),
    ask: vis(document.getElementById("chat-open")) ? R(document.getElementById("chat-open")) : null};
  for (const c of ctl ? ctl.querySelectorAll("section.v3c-card") : []) { const r = R(c); if (r && vis(c)) { o.cards[c.dataset.group] = r;
      let sc = c.parentElement; while (sc && sc !== ctl && !/auto|scroll/.test(getComputedStyle(sc).overflowY)) sc = sc.parentElement; o.cols[c.dataset.group] = R(sc || ctl); } }
  for (let n = document.getElementById("v3d-stage"); n && n !== document.documentElement; n = n.parentElement) if (n.scrollTop || n.scrollLeft) o.scrolled.push((n.id || n.tagName) + ":" + n.scrollTop);
  return o; })()`;
const near = (a, b, t = 1) => Math.abs(a - b) <= t;
const moved = (a, b) => Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y), Math.abs(a.w - b.w), Math.abs(a.h - b.h));
const srv = await serve({dir: DOCS, page: pickPage(DOCS), viz: VIZ});
const P = await launch({width: 1440, height: 900, block: BLOCK, reducedMotion: true, inject: [NOGL]});
const C = checker(), check = C.check, note = C.note, OUT = {};
const V = "window.tngViewer3d";
const settle = async k => { await P.waitFor(`${V} && ${V}.species === ${JSON.stringify(k)} && !String(${V}.message || "").startsWith("loading")`, 180000, 250);
  await sleep(400); await P.eval("new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)))"); };
/* show the card holding `sel` (tab layouts: its tab; phones: the sheet first) and return the label's centre */
async function reveal(sel) {
  const m = await P.eval(MEASURE);
  if (m.iw <= 820 && !m.sheet && await P.eval(`!!document.getElementById("controls-open") && getComputedStyle(document.getElementById("controls-open")).display !== "none"`)) { await P.click("#controls-open"); await sleep(400); }
  await P.eval(`(() => { const e = document.querySelector(${JSON.stringify(sel)}), card = e.closest("section.v3c-card"), t = card && document.querySelector('.v3c-tabs [data-tab="' + card.dataset.tab + '"]');
    if (t && getComputedStyle(t).display !== "none" && t.getAttribute("aria-selected") !== "true") t.click(); })()`);
  await sleep(250);
  return P.eval(`(() => { const e = document.querySelector(${JSON.stringify(sel)}).closest("label"); e.scrollIntoView({block: "nearest"}); const r = e.getBoundingClientRect();
    return {x: r.left + r.width / 2, y: r.top + r.height / 2, box: {x: r.left, y: r.top, w: r.width, h: r.height}}; })()`);
}
async function clickStep(name, sel, key, res) {
  const at = await reveal(sel), before = await P.eval(MEASURE);
  await P.mouse("mouseMoved", at.x, at.y); await P.mouse("mousePressed", at.x, at.y); await P.mouse("mouseReleased", at.x, at.y);
  if (key) await settle(key); else { await sleep(900); await P.eval("new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)))"); }
  const after = await P.eval(MEASURE), lab = await P.eval(`(() => { const r = document.querySelector(${JSON.stringify(sel)}).closest("label").getBoundingClientRect(); return {x: r.left, y: r.top, w: r.width, h: r.height}; })()`);
  const d = {label: +moved(at.box, lab).toFixed(1)};
  for (const [k, b] of Object.entries(before.cards)) d[k] = after.cards[k] ? +moved(b, after.cards[k]).toFixed(1) : "gone";
  const worst = Math.max(...Object.values(d).map(v => (v === "gone" ? 1e9 : v)));
  res.steps[name] = d;
  check(worst <= 1, `${res.key} ${name}: clicked label and cards move <= 1 px (${Object.entries(d).map(([k, v]) => `${k} ${v}`).join(", ")})`);
}
try {
  for (const theme of THEMES) for (const [name, w, h, dsf, mobile] of VP) {
    const key = `${name}-${theme}`, res = OUT[key] = {key, steps: {}};
    await P.send("Emulation.setDeviceMetricsOverride", {width: w, height: h, deviceScaleFactor: dsf, mobile: !!mobile});
    await P.send("Emulation.setTouchEmulationEnabled", {enabled: !!mobile, maxTouchPoints: mobile ? 5 : 0});
    await P.scheme(theme === "dark");
    await P.goto(`${srv.base}${srv.query ? srv.query + "&" : "?"}tier=high#tab=3d`);   // perf R5: the live viewer (software GL is otherwise the low tier's still)
    const t = await P.waitFor(`${V} && ${V}.species && !document.querySelector("[data-testid=v3-mode-volume]").disabled`, 240000, 250);
    if (!check(t >= 0, `${key}: viewer mounted`)) continue;
    await settle(await P.eval(`${V}.species`)); await sleep(600);
    const m = res.load = await P.eval(MEASURE), s = m.stage;
    if (SHOTS) await P.shot(join(SHOTS, `${key}-a-load.png`));
    check(s && near(s.w, s.h), `${key}: stage square ${s && s.w} x ${s && s.h}`);
    check(s && s.x >= -0.5 && s.y >= -0.5 && s.r <= m.iw + 0.5 && s.b <= m.ih + 0.5 && !m.scrolled.length && m.sy === 0,
      `${key}: stage fully in view on load (${s && `${s.x},${s.y} to ${s.r},${s.b}`} in ${m.iw}x${m.ih}; scrolled ${m.scrolled.join(" ") || "none"}, scrollY ${m.sy})`);
    if (m.iw >= 1024) check(m.docH <= m.ih + 0.5 && m.docW <= m.iw + 0.5, `${key}: no page scroll (${m.docW}x${m.docH} in ${m.iw}x${m.ih})`);
    const cards = Object.entries(m.cards);
    if (m.iw > 820 && !m.tabs) {          // side by side: columns by left edge
      const cols = {}; for (const [k, r] of cards) (cols[Math.round(r.x / 4)] ||= []).push([k, r]);
      const list = Object.values(cols), want = m.iw >= 1240 ? 2 : 1;
      check(list.length === want, `${key}: ${list.length} control column(s), want ${want} (${list.map(c => c.map(x => x[0]).join("+")).join(" | ")})`);
      for (const c of list) {
        check(c.every(([, r]) => near(r.x, c[0][1].x) && near(r.r, c[0][1].r)), `${key}: cards ${c.map(x => x[0]).join(",")} share left/right edges (${c.map(([, r]) => `${r.x}-${r.r}`).join(" ")})`);
        const first = c.reduce((a, b) => (b[1].y < a[1].y ? b : a));
        check(s && near(first[1].y, s.y), `${key}: first card ${first[0]} top ${first[1].y} = stage top ${s && s.y}`); }
      if (m.iw >= 1240) { const vis = g => m.cards[g] && m.cols[g] && m.cards[g].y >= m.cols[g].y - 0.5 && m.cards[g].y + 30 <= m.cols[g].b + 0.5;
        check(vis("mode") && vis("pick"), `${key}: Mode and Pick ray in view without scrolling (mode ${m.cards.mode?.y}, pick ${m.cards.pick?.y}, column bottom ${m.cols.pick?.b})`); }
    } else if (m.iw > 820) {              // one column with tabs
      check(m.ctl && s && near(m.ctl.x, s.x) && near(m.ctl.r, s.r), `${key}: controls span the stage width (${m.ctl?.x}-${m.ctl?.r} vs ${s?.x}-${s?.r})`);
      check(cards.length === 1 || cards.every(([, r]) => near(r.x, cards[0][1].x) && near(r.r, cards[0][1].r)), `${key}: tab cards share edges`);
    }
    /* (1) clicks */
    await clickStep("volume", "[data-testid=v3-mode-volume]", null, res);
    if (SHOTS) await P.shot(join(SHOTS, `${key}-b-volume.png`));
    await clickStep("integral", "[data-testid=v3-mode-integral]", null, res);
    for (const k of ["nH", "vlos", "sigmalos"]) await clickStep(k, `#v3-species input[value="${k}"]`, k, res);
    if (SHOTS) await P.shot(join(SHOTS, `${key}-c-sigmalos.png`));
    const e = await P.eval(MEASURE);
    if (m.iw <= 820) {
      check(e.sheet && e.ctl && e.ctl.b <= e.ih + 0.5, `${key}: controls open as a bottom sheet (${JSON.stringify(e.ctl)})`);
      check(!e.ask || !e.ctl || e.ask.b <= e.ctl.y || e.ask.y >= e.ctl.b, `${key}: the Ask button does not cover the sheet (${JSON.stringify(e.ask)})`);
    }
  }
} finally { if (opt.json) writeFileSync(resolve(opt.json), JSON.stringify(OUT, null, 1)); await P.close(); srv.close(); }
check(!P.exceptions.length, `no page exceptions${P.exceptions.length ? ": " + P.exceptions.slice(0, 3).join(" | ") : ""}`);
process.exit(C.finish());
