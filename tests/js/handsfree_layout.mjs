// Hands-free layout test (TNG_BROWSER-gated, like layout_3d.mjs): pressing Hands-free, opening its options, the guide card
// showing and hiding, and Stop move nothing on the page, and the stage overlays never overlap.
//   TNG_BROWSER=1 node tests/js/handsfree_layout.mjs --viz <viz dir with manifest_v2.json> [--docs <dir>] [--only 1366x768,...]
//       [--themes dark,light] [--shots <dir>]
// Chrome runs with a fake camera (--use-fake-device-for-media-stream --use-fake-ui-for-media-stream: a test pattern, no face)
// and the no-GL stub of layout_3d.mjs. For each viewport and theme it records the box of every View-card control, every
// 3D card and every stage overlay, then: (1) clicks Hands-free with a real mouse event, (2) waits for the guide to hide
// itself, (3) opens the options, (4) opens the guide from "?", (5) clicks Hands-free again (Stop). After every step every
// recorded box moves by <= 1 px; no two visible stage overlays intersect; no text in the pill, the panels or the View card
// overflows its box; the Hands-free buttons are >= 32 px tall (44 px on touch); the page has no horizontal overflow. The
// guide must be visible right after the click.
import {existsSync} from "node:fs";
import {join, resolve} from "node:path";
import {launch, serve, BLOCK, parseArgs, sleep, ROOT, checker, pickPage} from "./lib/browser.mjs";

if (!process.env.TNG_BROWSER) { console.log("skipped (set TNG_BROWSER=1 and pass --viz DIR to run the Hands-free layout test)"); process.exit(0); }
const {opt} = parseArgs(process.argv.slice(2)), VIZ = resolve(opt.viz || process.env.TNG_VIZ || ""), DOCS = resolve(opt.docs || join(ROOT, "docs/tng50"));
if (!existsSync(join(VIZ, "manifest_v2.json"))) { console.error("--viz DIR (or TNG_VIZ) with a manifest_v2.json is required"); process.exit(2); }
const SHOTS = opt.shots && resolve(opt.shots), ONLY = opt.only ? String(opt.only).split(",") : null, THEMES = String(opt.themes || "dark,light").split(",");
// [name, CSS width, CSS height, device scale factor, mobile]: laptops at 100 %, 125 % and 150 % Windows scaling, wide screens, phones
const VP = [["1366x768", 1366, 768, 1], ["1536x864@1.25", 1536, 864, 1.25], ["1280x720@1.5", 1280, 720, 1.5], ["1440x900", 1440, 900, 1], ["1920x1080", 1920, 1080, 1],
  ["390x844", 390, 844, 3, true], ["360x740", 360, 740, 3, true]].filter(v => !ONLY || ONLY.includes(v[0]));
const NOGL = `for (const C of [self.WebGL2RenderingContext, self.WebGLRenderingContext]) if (C) for (const f of ["drawArrays","drawElements","drawArraysInstanced","drawElementsInstanced","drawRangeElements","clear","blitFramebuffer","texImage3D","texSubImage3D","readPixels"]) if (C.prototype[f]) C.prototype[f] = function () {};`;
const MEASURE = `(() => { const R = e => { const r = e.getBoundingClientRect(); return r.width && r.height ? {x: r.left, y: r.top, w: r.width, h: r.height} : null; };
  const vis = e => { const s = getComputedStyle(e); return s.display !== "none" && s.visibility !== "hidden" && +s.opacity > 0 && !!R(e); };
  const o = {iw: innerWidth, docW: document.documentElement.scrollWidth, fixed: {}, ov: {}, overflow: [], heights: {}};
  const view = document.querySelector('section.v3c-card[data-group="view"]');
  document.querySelectorAll("#v3-ctl section.v3c-card").forEach(c => { if (vis(c)) o.fixed["card:" + c.dataset.group] = R(c); });
  if (view && vis(view)) view.querySelectorAll("button, input, select, summary, label, .v3c-row").forEach((e, i) => { if (vis(e)) o.fixed["view:" + (e.id || e.tagName + i)] = R(e); });
  const ovs = {msg: ".v3d-msg", scale: ".v3d-scale", legend: ".v3d-leg", lines: ".v3d-lines", orbit: "#v3-orbit", fs: "#v3-fs-stage", id: "#v3-id", pivot: "#v3-pivot", pill: ".v3d-hc", guide: ".v3d-hg", options: ".v3d-ho"};
  for (const [k, s] of Object.entries(ovs)) { const e = document.querySelector("#v3d-stage " + s); if (e && vis(e)) { o.ov[k] = R(e); if (!["pill", "guide", "options", "msg"].includes(k)) o.fixed["ov:" + k] = R(e); } }
  const texts = [...document.querySelectorAll("#v3d-stage .v3d-hc .hc-m, #v3d-stage .v3d-hc .hc-st, #v3d-stage .v3d-hp label, #v3d-stage .v3d-hg li, #v3d-stage .v3d-hg p, #v3d-stage .v3d-hp")];
  if (view && vis(view)) texts.push(...view.querySelectorAll(".v3c-btn, .v3c-row > label, .v3c-row > .lab"));
  for (const e of texts) if (vis(e) && (e.scrollWidth > e.clientWidth + 1 || e.scrollHeight > e.clientHeight + 1)) o.overflow.push((e.id || e.className || e.tagName) + ":" + e.textContent.trim().slice(0, 30) + " " + e.scrollWidth + "x" + e.scrollHeight + ">" + e.clientWidth + "x" + e.clientHeight);
  for (const e of document.querySelectorAll("#v3-head, #v3-fs, #v3d-stage .v3d-hc button")) if (vis(e)) o.heights[e.id || e.className || "?"] = +R(e).h.toFixed(1);
  o.st = window.__hfState || null; return o; })()`;
const moved = (a, b) => Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y), Math.abs(a.w - b.w), Math.abs(a.h - b.h));
const hit = (a, b) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
const srv = await serve({dir: DOCS, page: pickPage(DOCS), viz: VIZ});
const P = await launch({width: 1440, height: 900, block: BLOCK, reducedMotion: true, inject: [NOGL], args: ["--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream"]});
const C = checker(), check = C.check;
const HC = `import(new URL("js/headctl.js", location.href).href)`;
const frames = () => P.eval("new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)))");
async function clickSel(sel) { const c = await P.eval(`(() => { const r = document.querySelector(${JSON.stringify(sel)}).getBoundingClientRect(); return [r.left + r.width / 2, r.top + r.height / 2]; })()`);
  await P.mouse("mouseMoved", c[0], c[1]); await P.mouse("mousePressed", c[0], c[1]); await P.mouse("mouseReleased", c[0], c[1]); }
try {
  for (const theme of THEMES) for (const [name, w, h, dsf, mobile] of VP) {
    const key = `${name}-${theme}`, touch = !!mobile;
    await P.send("Emulation.setDeviceMetricsOverride", {width: w, height: h, deviceScaleFactor: dsf, mobile: touch});
    await P.send("Emulation.setTouchEmulationEnabled", {enabled: touch, maxTouchPoints: touch ? 5 : 0});
    await P.send("Browser.grantPermissions", {permissions: ["sensors"], origin: srv.origin});
    await P.send("DeviceOrientation.setDeviceOrientationOverride", {alpha: 0, beta: 30, gamma: 0});
    await P.scheme(theme === "dark");
    await P.goto(`${srv.base}${srv.query ? srv.query + "&" : "?"}tier=high#tab=3d`);
    if (!check(await P.waitFor(`window.tngViewer3d && tngViewer3d.species && document.querySelector("#v3-head")`, 240000, 250) >= 0, `${key}: viewer mounted`)) continue;
    await sleep(1500);
    if (touch) { if (!(await P.eval(`document.body.classList.contains("ctl-open")`))) { await clickSel(await P.eval(`["#controls-open", "#dock-open"].find(s => { const e = document.querySelector(s); return e && getComputedStyle(e).display !== "none" && e.getBoundingClientRect().width; })`)); await sleep(600); }
      await clickSel('input[name="v3-tab"][value="view"] + span'); await sleep(400); }
    else await P.eval(`document.querySelector("#v3-head").scrollIntoView({block: "nearest"})`);
    await frames();
    const base = await P.eval(MEASURE), shot = async n => { if (SHOTS) await P.shot(join(SHOTS, `${key}-${n}.png`)); };
    await shot("0-idle");
    const hmin = touch ? 44 : 32;
    const step = async (label, extra = "") => {
      await frames(); const m = await P.eval(MEASURE);
      const d = Object.entries(base.fixed).map(([k, b]) => [k, m.fixed[k] ? moved(b, m.fixed[k]) : 1e9]), worst = d.reduce((a, b) => (b[1] > a[1] ? b : a), ["", 0]);
      check(worst[1] <= 1, `${key} ${label}: ${d.length} boxes (View-card controls, cards, overlays) move <= 1 px (worst ${worst[0]} ${worst[1] === 1e9 ? "gone" : worst[1].toFixed(2)})`);
      const ks = Object.keys(m.ov), bad = [];
      for (let i = 0; i < ks.length; i++) for (let j = i + 1; j < ks.length; j++) if (hit(m.ov[ks[i]], m.ov[ks[j]])) bad.push(`${ks[i]}x${ks[j]}`);
      check(!bad.length, `${key} ${label}: no two stage overlays intersect (${ks.join(",")}${bad.length ? "; overlap " + bad.join(" ") : ""})`);
      check(!m.overflow.length, `${key} ${label}: no text overflows its box${m.overflow.length ? ": " + m.overflow.join(" | ") : ""}`);
      const low = Object.entries(m.heights).filter(([, v]) => v < hmin - 0.5);
      check(!low.length, `${key} ${label}: Hands-free buttons >= ${hmin} px tall (${JSON.stringify(m.heights)})`);
      check(m.docW <= m.iw + 0.5, `${key} ${label}: no horizontal page overflow (${m.docW} in ${m.iw})`);
      return m; };
    await clickSel("#v3-head");
    await P.waitFor(`document.querySelector("#v3d-stage .v3d-hc")`, 15000, 50); await sleep(500);
    const m1 = await step("start");
    check(!!m1.ov.pill && !!m1.ov.guide, `${key} start: the pill and the guide card show at once (${Object.keys(m1.ov).join(",")})`);
    await shot("1-start-guide");
    const gone = await P.waitFor(`(() => { const g = document.querySelector("#v3d-stage .v3d-hg"); return g && g.hidden; })()`, 12000, 200);
    await sleep(400); const m2 = await step("guide hidden");
    check(gone >= 0 && !m2.ov.guide, `${key}: the guide hides itself after about 6 s (${gone} ms after the check began)`);
    await shot("2-running");
    await clickSel("#v3d-stage .v3d-hc .hc-o"); await sleep(400);
    const m3 = await step("options open"); check(!!m3.ov.options && !m3.ov.guide, `${key}: options open in the panel slot`);
    const sensPc = await P.eval(`(() => { const s = document.querySelector("#hc-sens"); if (!s) return null; const p0 = s.style.getPropertyValue("--pc");
      s.value = "2.45"; s.dispatchEvent(new Event("input", {bubbles: true})); const p1 = s.style.getPropertyValue("--pc");
      s.value = "1"; s.dispatchEvent(new Event("input", {bubbles: true})); return {p0, p1}; })()`);
    check(sensPc && sensPc.p0 === "27.27%" && sensPc.p1 === "80.00%", `${key}: sensitivity slider updates --pc fill (${JSON.stringify(sensPc)})`);
    await shot("3-options");
    await clickSel("#v3d-stage .v3d-hc .hc-q"); await sleep(400);
    const m4 = await step("guide from ?"); check(!!m4.ov.guide && !m4.ov.options, `${key}: "?" swaps the options for the guide`);
    const errVis = await P.eval(`(() => { const m = document.querySelector("#v3d-stage .v3d-msg"), p = document.querySelector("#v3d-stage .v3d-hc");
      if (!m || !p) return false; m.textContent = "The 3D data host is unreachable."; m.className = "v3d-ov v3d-msg bad"; m.dataset.prog = ""; m.dataset.transient = "";
      const mr = m.getBoundingClientRect(), pr = p.getBoundingClientRect(), gr = document.querySelector("#v3d-stage .v3d-hg")?.getBoundingClientRect();
      const s = getComputedStyle(m), gs = getComputedStyle(document.querySelector("#v3d-stage .v3d-hg"));
      const hit = (a, b) => a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;
      const ok = s.visibility !== "hidden" && mr.width > 0 && mr.height > 0 && !hit(mr, pr) && (gs.visibility === "hidden" || !hit(mr, gr));
      m.textContent = ""; m.className = "v3d-ov v3d-msg"; return ok; })()`);
    check(errVis, `${key}: persistent stage error (.v3d-msg.bad) remains visible below the pill without overlap`);
    if (!touch) {
      const fsOk = await P.eval(`(async () => { await tngViewer3d.toggleFullscreen(true); document.querySelector("#v3-ctl-toggle")?.click();
        await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
        const p = document.querySelector("#v3d-stage .v3d-hc")?.getBoundingClientRect(), g = document.querySelector("#v3d-stage .v3d-hg")?.getBoundingClientRect(), c = document.querySelector(".v3d .v3c")?.getBoundingClientRect();
        const hit = (a, b) => a && b && a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;
        const ok = p && c && !hit(p, c) && (!g || !hit(g, c));
        await tngViewer3d.toggleFullscreen(false);
        document.querySelector("#v3-head")?.scrollIntoView({block: "nearest"});
        await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r))); return ok; })()`);
      check(fsOk, `${key}: in fullscreen with Controls open (.v3d-panel), pill and panel stay clear of .v3c`);
    }
    await clickSel("#v3-head"); await sleep(500);
    const m5 = await step("stop"); check(!m5.ov.pill && !m5.ov.guide && !m5.ov.options, `${key}: Stop removes the pill and the panels`);
    await shot("4-stopped");
    const st = await P.eval(`${HC}.then(H => H.state().on)`); check(st === false, `${key}: Stop ends the session`);
  }
} finally { await P.close(); srv.close(); }
check(!P.exceptions.length, `no page exceptions${P.exceptions.length ? ": " + P.exceptions.slice(0, 3).join(" | ") : ""}`);
process.exit(C.finish());
