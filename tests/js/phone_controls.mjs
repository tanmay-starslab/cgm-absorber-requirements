// Phone controls (<= 820 px): the glass dock and the non-modal snap sheet on both tabs. Opt-in like the other browser tests:
//   TNG_BROWSER=1 node tests/js/phone_controls.mjs [--viz DIR] [--docs DIR] [--only 390x844] [--themes dark,light] [--shots DIR]
// TNG_VIZ may stand in for --viz (without one the 3D checks are skipped). At 390x844 and 360x740 it checks that
//   - the dock shows on both tabs, clear of the status bar and of the last spectrum scrolled to the end, with 44 px targets;
//   - a tap on the dock opens the sheet to peek (a non-modal dialog); in peek the spectra behind still scroll, every row can
//     rise above the sheet, and an S/N change redraws the plot; a tap or an upward drag of the head reaches expanded, a
//     downward drag closes it;
//   - the 3D tab opens with the sheet in peek under a square stage that stays fully in view; Done brings the dock back.
// --shots writes one PNG per state (dock, peek, mid-scroll, expanded; both tabs).
import {existsSync} from "node:fs";
import {join, resolve} from "node:path";
import {launch, serve, BLOCK, parseArgs, sleep, ROOT, checker, pickPage, READY} from "./lib/browser.mjs";

if (!process.env.TNG_BROWSER) { console.log("skipped (set TNG_BROWSER=1 to run the phone controls test)"); process.exit(0); }
const {opt} = parseArgs(process.argv.slice(2)), DOCS = resolve(opt.docs || join(ROOT, "docs/tng50"));
const VIZ = opt.viz || process.env.TNG_VIZ ? resolve(opt.viz || process.env.TNG_VIZ) : null, HAS3D = !!VIZ && existsSync(join(VIZ, "manifest_v2.json"));
const SHOTS = opt.shots && resolve(opt.shots), ONLY = opt.only ? String(opt.only).split(",") : null, THEMES = String(opt.themes || "dark").split(",");
const VP = [["390x844", 390, 844], ["360x740", 360, 740]].filter(v => !ONLY || ONLY.includes(v[0]));
const srv = await serve({dir: DOCS, page: pickPage(DOCS), viz: HAS3D ? VIZ : null});
// GL draw and upload calls are stubbed (as in layout_3d.mjs) so software WebGL never starves the page: the stage renders
// black and only the layout is checked; --gl keeps real rendering (slow without a GPU)
const NOGL = `for (const C of [self.WebGL2RenderingContext, self.WebGLRenderingContext]) if (C) for (const f of ["drawArrays","drawElements","drawArraysInstanced","drawElementsInstanced","drawRangeElements","clear","blitFramebuffer","texImage3D","texSubImage3D"]) C.prototype[f] = function () {};`;
const P = await launch({width: 390, height: 844, block: BLOCK, reducedMotion: true, inject: opt.gl ? [] : [NOGL]});
const C = checker(), check = C.check;
const R = `(s => { const e = typeof s === "string" ? document.querySelector(s) : s; if (!e) return null; const r = e.getBoundingClientRect(), st = getComputedStyle(e);
  return r.width && r.height && st.visibility !== "hidden" && st.display !== "none" ? {x: r.left, y: r.top, w: r.width, h: r.height, r: r.right, b: r.bottom} : null; })`;
const rect = s => P.eval(`${R}(${JSON.stringify(s)})`);
const state = () => P.eval(`({open: document.body.classList.contains("ctl-open"), snap: document.body.dataset.sheet || "", ih: innerHeight})`);
const frame = () => P.eval("new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)))");
const shot = async name => { if (SHOTS) await P.shot(join(SHOTS, name + ".png")); };
const cvSig = () => P.eval(`(() => { const c = document.getElementById("cv"), x = c.getContext("2d").getImageData(0, 0, c.width, Math.min(c.height, 1200)).data; let h = 0; for (let i = 0; i < x.length; i += 37) h = (h * 31 + x[i]) >>> 0; return h; })()`);
const target = async (sel, tag) => { const r = await rect(sel); check(r && r.w >= 44 && r.h >= 44, `${tag}: ${sel} is a 44 px touch target (${r ? `${r.w.toFixed(0)}x${r.h.toFixed(0)}` : "hidden"})`); };
async function tapHead(sel) { const r = await rect(sel); await P.mouse("mouseMoved", r.x + 24, r.y + r.h / 2); await P.mouse("mousePressed", r.x + 24, r.y + r.h / 2); await P.mouse("mouseReleased", r.x + 24, r.y + r.h / 2); await sleep(450); }
async function dragHead(sel, dy) { const r = await rect(sel), x = r.x + 24, y = r.y + r.h / 2; await P.drag(x, y, x, y + dy, 10); await sleep(450); }

try {
  for (const theme of THEMES) for (const [name, w, h] of VP) {
    const key = `${name}-${theme}`;
    await P.send("Emulation.setDeviceMetricsOverride", {width: w, height: h, deviceScaleFactor: 2, mobile: true});
    await P.send("Emulation.setTouchEmulationEnabled", {enabled: true, maxTouchPoints: 5});
    await P.scheme(theme === "dark");
    await P.goto(`${srv.base}${srv.query ? srv.query + "&" : "?"}tier=high&bg=off`);
    if (!check(await P.waitFor(READY, 120000, 250) >= 0, `${key}: page ready`)) continue;
    await P.eval(`localStorage.removeItem("tngsight.dock.seen"); localStorage.setItem("tngsight.story.seen", "1")`);
    await P.goto(`${srv.base}${srv.query ? srv.query + "&" : "?"}tier=high&bg=off`); await P.waitFor(READY, 120000, 250); await sleep(1500); await frame();
    /* Spectra: the dock */
    let d = await rect("#dock"), bar = await rect("#bar"), box = await rect("#spectra");
    check(d && d.x >= 0 && d.r <= w && d.b <= h, `${key}: the dock is in view on the Spectra tab (${JSON.stringify(d)})`);
    check(d && bar && bar.b <= d.y + 0.5, `${key}: the dock is clear of the status bar (bar bottom ${bar?.b}, dock top ${d?.y})`);
    await P.eval(`(b => { b.scrollTop = b.scrollHeight; })(document.getElementById("spectra"))`); await frame();
    const cv = await rect("#cv"); box = await rect("#spectra");
    check(cv && d && Math.min(cv.b, box.b) <= d.y + 0.5, `${key}: the last spectrum scrolled to the end ends above the dock (${Math.min(cv?.b, box?.b).toFixed(1)} <= ${d?.y})`);
    await P.eval(`document.getElementById("spectra").scrollTop = 0`);
    check(await P.eval(`document.getElementById("dock").classList.contains("hint") && !!document.querySelector("#dock #chat-open, #dock")`), `${key}: first visit: the dock carries the one-time hint`);
    await target("#dock-open", key); if (await rect("#chat-open")) await target("#chat-open", key);
    const askIn = await P.eval(`!!document.querySelector("#dock #chat-open") || document.getElementById("chat-open").hidden`);
    check(askIn, `${key}: Ask sits in the dock (no floating button over the content)`);
    await shot(`${key}-spectra-1-dock`);
    /* peek */
    await P.click("#dock-open"); await sleep(500);
    let s = await state(), sh = await rect("#side");
    check(s.open && s.snap === "peek" && sh && Math.abs(sh.h - h * 0.4) <= 3 && Math.abs(sh.b - h) <= 1, `${key}: a tap on the dock opens the sheet to peek (${s.snap}, ${sh?.h.toFixed(0)} px of ${h})`);
    check(await P.eval(`(e => e.getAttribute("role") === "dialog" && e.getAttribute("aria-modal") === "false")(document.getElementById("side"))`), `${key}: the sheet is a non-modal dialog`);
    check(await P.eval(`!!document.activeElement && document.activeElement.id === "side-done"`), `${key}: focus moves into the sheet (Done)`);
    check(!await P.eval(`document.getElementById("dock").classList.contains("hint")`), `${key}: the hint is gone once the sheet was opened`);
    check(!!await rect("#sn-0"), `${key}: the peek sheet shows the S/N slider without scrolling the sheet`);
    await target("#side-done", key);
    await shot(`${key}-spectra-2-peek`);
    box = await rect("#spectra");
    const st0 = await P.eval(`document.getElementById("spectra").scrollTop`);
    await P.wheel(w / 2, box.y + 80, 240, false); await sleep(500);
    const st1 = await P.eval(`document.getElementById("spectra").scrollTop`);
    check(st1 > st0, `${key}: in peek the spectra behind still scroll (scrollTop ${st0} -> ${st1})`);
    await shot(`${key}-spectra-3-peek-midscroll`);
    await P.eval(`(b => { b.scrollTop = b.scrollHeight; })(document.getElementById("spectra"))`); await frame();
    const cv2 = await rect("#cv"); sh = await rect("#side");
    check(cv2 && sh && cv2.b <= sh.y + 1, `${key}: scrolled to the end, the last spectrum rises above the peek sheet (${cv2?.b.toFixed(1)} <= ${sh?.y.toFixed(1)})`);
    await P.eval(`document.getElementById("spectra").scrollTop = 0`); await frame();
    const sig0 = await cvSig(), sn0 = await P.eval(`tngApp.getState().sn[0]`);
    await P.eval(`document.getElementById("sn-0").focus()`); for (let i = 0; i < 4; i++) await P.key("ArrowLeft");
    await sleep(700); await frame();
    const sig1 = await cvSig(), sn1 = await P.eval(`tngApp.getState().sn[0]`);
    check(sn1 !== sn0 && sig1 !== sig0, `${key}: an S/N change in peek redraws the plot behind the sheet (S/N ${sn0} -> ${sn1})`);
    /* expanded: tap the head, then back; drag up; drag down closes */
    await tapHead("#side-head"); s = await state(); sh = await rect("#side");
    check(s.snap === "full" && sh && Math.abs(sh.h - h * 0.85) <= 3, `${key}: a tap on the head expands the sheet (${s.snap}, ${sh?.h.toFixed(0)} px)`);
    await shot(`${key}-spectra-4-expanded`);
    await tapHead("#side-head"); s = await state();
    check(s.snap === "peek", `${key}: a second tap returns to peek (${s.snap})`);
    await dragHead("#side-head", -Math.round(h * 0.35)); s = await state();
    check(s.snap === "full", `${key}: dragging the head up reaches expanded (${s.snap})`);
    await dragHead("#side-head", Math.round(h * 0.75)); s = await state();
    check(!s.open, `${key}: dragging the head down closes the sheet (open ${s.open})`);
    await sleep(300); d = await rect("#dock");
    check(!!d, `${key}: the dock is back after the sheet closes`);
    await P.click("#dock-open"); await sleep(400); await P.key("Escape"); await sleep(400); s = await state();
    check(!s.open && await P.eval(`document.activeElement && document.activeElement.id === "dock-open"`), `${key}: Esc closes the sheet and focus returns to the dock`);
    if (!HAS3D) continue;
    /* 3D: peek by default under a square stage */
    await P.eval(`tngApp.showTab("3d")`);
    const t = await P.waitFor(`window.tngViewer3d && tngViewer3d.species && document.getElementById("v3-ctl") && document.body.classList.contains("ctl-open")`, 240000, 250);
    if (!check(t >= 0, `${key}: 3D viewer mounted and its sheet opened`)) continue;
    await P.waitFor(`!String(tngViewer3d.message || "").startsWith("loading")`, 180000, 500); await sleep(1500); await frame();
    s = await state(); const stg = await rect("#v3d-stage"), ctl = await rect("#v3-ctl");
    check(s.open && s.snap === "peek" && ctl && ctl.h >= h * 0.28 - 2 && ctl.h <= h * 0.5 + 2, `${key}: the 3D tab opens with the sheet in peek (${ctl?.h.toFixed(0)} px of ${h})`);
    check(stg && Math.abs(stg.w - stg.h) <= 1 && stg.x >= 0 && stg.y >= 0 && stg.r <= w && ctl && stg.b <= ctl.y + 0.5, `${key}: the stage is square and fully in view above the peek sheet (${stg && `${stg.w.toFixed(1)}x${stg.h.toFixed(1)}, bottom ${stg.b.toFixed(1)}`}, sheet top ${ctl?.y.toFixed(1)})`);
    await target("#v3-ctl .v3c-head .grab", key); await target("#v3-ctl .v3c-done", key);
    await shot(`${key}-3d-1-peek`);
    await tapHead("#v3-ctl .v3c-head"); s = await state(); const ctl2 = await rect("#v3-ctl"), stg2 = await rect("#v3d-stage");
    check(s.snap === "full" && ctl2 && Math.abs(ctl2.h - h * 0.85) <= 3, `${key}: a tap on the 3D head expands the sheet (${ctl2?.h.toFixed(0)} px)`);
    check(stg2 && Math.abs(stg2.w - stg.w) <= 0.5 && Math.abs(stg2.y - stg.y) <= 0.5, `${key}: expanding does not move or resize the stage`);
    await shot(`${key}-3d-2-expanded`);
    await P.click("#v3-ctl .v3c-done"); await sleep(500); s = await state(); d = await rect("#dock");
    const stg3 = await rect("#v3d-stage"), stat = await rect("#v3d-status");
    check(!s.open && d && stg3 && stg3.b <= d.y && (!stat || stat.b <= d.y + 0.5), `${key}: Done closes the 3D sheet and the dock shows clear of the stage and status`);
    check(stg3 && Math.abs(stg3.w - stg.w) <= 0.5, `${key}: closing does not resize the stage (${stg3?.w} vs ${stg.w})`);
    const rd = await P.eval(`document.getElementById("dock-read").textContent`);
    check(/field/i.test(rd) && /(integral|volume)/i.test(rd), `${key}: the 3D dock reads the field and the mode (${rd})`);
    await shot(`${key}-3d-3-dock`);
    await P.eval(`tngApp.showTab("spectra")`); await sleep(300);
    await P.eval(`tngApp.showTab("3d")`); await sleep(500);
    check(!(await state()).open, `${key}: after the user closed it, the 3D sheet stays closed on coming back`);
  }
} finally { await P.close(); srv.close(); }
check(!P.exceptions.length, `no page exceptions${P.exceptions.length ? ": " + P.exceptions.slice(0, 3).join(" | ") : ""}`);
process.exit(C.finish());
