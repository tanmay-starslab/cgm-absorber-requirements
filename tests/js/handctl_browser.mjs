// Hand control in a headless Chromium with a fake camera that shows an open hand (tests/js/fixtures/hand_open_palm.jpg,
// "Man in hood stretching hand" by sandeeep on Unsplash, CC0 via Wikimedia Commons, cropped and scaled).
// Usage: TNG_BROWSER=1 node tests/js/handctl_browser.mjs [docs/tng50] [--viz DIR] [--edge BIN] [--shots DIR]
// It builds a short y4m of the hand panning sideways with ffmpeg ($FFMPEG, else ffmpeg on PATH, else
// ~/.conda/envs/cgm/bin/ffmpeg; skipped when none is found). Two camera sessions (model loading is slow on a busy CPU node):
// at 1440 px (desktop), Hands-free (head and hands together, the only mode):
//   - one click on Hands-free starts it (no selector, no Start), nothing loads before the click;
//   - the real Gesture Recognizer sees the hand in the clip and the pill says so;
//   - with synthetic landmarks fed through the test hook (headctl._hand, which then mutes the tracker's own hand results):
//     the pill's rotate, zoom, paused and hold states ("👍 hold…" while a sign is held), the view turning and zooming, the fist freezing it, the swipe and hold
//     actions with their toasts, and the head resuming 1 s after the hand leaves;
//   - a second click ends every camera track and removes the pill and guide; a low-tier desktop is told it may be slow;
// at 390 px (touch, high tier): one tap starts the camera, the real tracker sees the hand, nothing goes off-origin; a slow
// tracker (frame times fed through headctl._rate) stops with a message and the camera off, and the next tap starts Tilt.
// With --shots DIR it saves the running state, the pill states and the capability messages.
import {mkdirSync, rmSync} from "node:fs";
import {execFileSync} from "node:child_process";
import {join, resolve} from "node:path";
import {homedir, tmpdir} from "node:os";
import {ROOT, parseArgs, checker, serve, launch, READY, UI_LIB, BLOCK, pickPage, sleep} from "./lib/browser.mjs";

if (!process.env.TNG_BROWSER) { console.log("skipped (set TNG_BROWSER=1 to run the hand control browser test)"); process.exit(0); }
const {pos, opt} = parseArgs(process.argv.slice(2));
const FF = [process.env.FFMPEG, "ffmpeg", join(homedir(), ".conda/envs/cgm/bin/ffmpeg")].filter(Boolean).find(f => { try { execFileSync(f, ["-version"], {stdio: "ignore"}); return true; } catch { return false; } });
if (!FF) { console.log("skipped (no ffmpeg to build the fake camera video; set FFMPEG)"); process.exit(0); }
const DIR = resolve(pos[0] || join(ROOT, "docs/tng50")), PAGE = pickPage(DIR, opt.page), SHOTS = opt.shots && resolve(opt.shots);
const work = join(tmpdir(), `handctl-${process.pid}`); mkdirSync(work, {recursive: true});
const Y4M = join(work, "hand.y4m");
execFileSync(FF, ["-hide_banner", "-loglevel", "error", "-y", "-loop", "1", "-i", join(ROOT, "tests/js/fixtures/hand_open_palm.jpg"),
  "-filter_complex", "color=c=0xc9c3bb:s=480x300:r=15:d=4[bg];[bg][0]overlay=x=120+80*sin(2*PI*t/4):y=21:shortest=1,scale=320:200,format=yuv420p", "-t", "4", Y4M]);

// TNG_NOGL=1: stub the page's GL draw and upload calls (as layout_3d.mjs does) so a software-GL GPU process on a loaded
// node never stalls the page; the stage renders black, the tracker (in its worker) is untouched
const NOGL = process.env.TNG_NOGL ? [`for (const C of [self.WebGL2RenderingContext, self.WebGLRenderingContext]) if (C) for (const f of ["drawArrays","drawElements","drawArraysInstanced","drawElementsInstanced","drawRangeElements","clear","blitFramebuffer","texImage3D","texSubImage3D","readPixels"]) if (C.prototype[f]) C.prototype[f] = function () {};`] : [];
const C = checker(), check = C.check, note = C.note;
const srv = await serve({dir: DIR, page: PAGE, port: opt.port, viz: opt.viz || process.env.TNG_VIZ});
const ARGS = ["--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream", `--use-file-for-fake-video-capture=${Y4M}`, "--enable-unsafe-swiftshader"];
const HC = `import(new URL("js/headctl.js", location.href).href)`;
const until = async (P, expr, ms, every = 500) => { const t = Date.now(); while (Date.now() - t < ms) { try { if (await P.eval(expr)) return Date.now() - t; } catch {} await sleep(every); } return -1; };
/* in the page: a synthetic hand (63 numbers) and a feeder that sends frames through the hook at about 25 fps */
const FEED = `window.__hand = (x, y, size = 0.2, pinch = 1) => { const P = Array.from({length: 21}, () => [x, y, 0]);
  P[0] = [x, y + size / 2, 0]; P[9] = [x, y - size / 2, 0]; P[5] = [x - size / 4, y - size / 2, 0]; P[17] = [x + size / 4, y - size / 2 + 0.01, 0]; P[13] = [x + size / 8, y - size / 2, 0];
  P[4] = [x - size * pinch / 2, y - size, 0]; P[8] = [x + size * pinch / 2, y - size, 0]; return P.flat(); };
  window.__feed = async (n, f, dt = 40) => { const H = await ${HC}; for (let i = 0; i < n; i++) { H._hand(f(i)); await new Promise(r => setTimeout(r, dt)); } return H.state(); };`;
const cam = P => P.eval(`(() => { const c = tngViewer3d.camera, t = tngViewer3d.controls.target; return {p: c.position.toArray(), d: c.position.distanceTo(t)}; })()`);
const dist = (a, b) => Math.hypot(...a.p.map((x, i) => x - b.p[i]));
const live = P => P.eval(`(window.__streams || []).flatMap(s => s.getTracks()).filter(t => t.readyState === "live").length`);

async function open(P, w, h, mobile, query) {
  if (mobile) await P.viewport(w, h, true);
  await P.send("Browser.grantPermissions", {permissions: ["sensors"], origin: srv.origin});
  await P.goto(srv.base + (srv.query ? srv.query + "&" : "?") + query + "#tab=3d");
  await P.waitFor(READY, 60000, 200); await P.eval(UI_LIB); await P.eval(FEED);
  await P.eval(`tngApp.showTab("3d")`);
  if (await P.waitFor(`document.querySelector('[data-testid="v3-head"]')`, 90000, 250) < 0) return false;
  await P.eval(`document.querySelector('[data-testid="v3-head"]').scrollIntoView({block: "center"})`);
  // the finer cubes keep streaming and hold the test server's six connections, so the model fetches would queue behind
  // them for many minutes on a busy CPU node: once the first view is up, further cube requests fail at once
  await until(P, `tngViewer3d.species`, 300000, 1000); await P.send("Network.setBlockedURLs", {urls: [...BLOCK, "*/viz/*"]});
  // software WebGL on a loaded node takes seconds per ray-marched frame and every hand frame asks for one: keep the first
  // image and stop drawing (the checks read the camera, the pill and the toasts, not pixels)
  await until(P, `!/loading/i.test(tngViewer3d.message || "")`, 60000, 1000); await P.eval(`tngViewer3d.renderer.render = () => {}`);
  for (let i = 0, idle = -1; i < 60 && idle < 0; i++) idle = await P.waitFor(`(() => { const t = performance.now(), ok = window.__qt && t - window.__qt < 60; window.__qt = t; return ok; })()`, 5000, 30);
  return true;
}
const press = async P => {
  if (P.mobile && !(await P.eval(`document.body.classList.contains("ctl-open")`))) { await P.click("#dock-open"); await sleep(600); }   // phones: the controls sheet,
  if (P.mobile) { await P.click('input[name="v3-tab"][value="view"] + span'); await sleep(300); }                                        // then its View tab
  await P.click('[data-testid="v3-head"]'); return P.waitFor(`document.querySelector(".v3d-hc")`, 15000, 100); };
async function browser(w, h) {
  const P = await launch({edge: opt.edge, block: BLOCK, width: w, height: h, args: ARGS, reducedMotion: false, inject: NOGL});
  P.on(m => { if (m.method === "Target.attachedToTarget" && m.params.targetInfo.type === "worker") { const sid = m.params.sessionId;
    P.send("Network.enable", {}, sid).then(() => P.send("Runtime.runIfWaitingForDebugger", {}, sid)); } });
  await P.send("Target.setAutoAttach", {autoAttach: true, waitForDebuggerOnStart: true, flatten: true});
  await P.send("Page.addScriptToEvaluateOnNewDocument", {source: `window.__streams = []; { const md = navigator.mediaDevices; if (md) { const g = md.getUserMedia.bind(md); md.getUserMedia = async c => { const s = await g(c); __streams.push(s); return s; }; } }`});
  return P;
}

async function desktop() {
  const w = 1440, tag = "1440px", P = await browser(w, 900), shot = async n => { if (SHOTS) await P.shot(join(SHOTS, `handctl_${w}_${n}.png`)); };
  try {
    if (!(await open(P, w, 900, false, "tier=high"))) { check(false, `${tag}: 3D viewer mounted`); return; }
    const lbl = await P.eval(`document.querySelector('[data-testid="v3-head"]').textContent.trim()`);
    check(lbl === "Hands-free", `${tag}: button label "${lbl}"`);
    const before = P.requests.filter(r => /mediapipe|headworker/.test(r)).length;
    check(before === 0, `${tag}: no tracker file fetched before the click`);
    const n0 = P.requests.length, t0 = Date.now();
    await press(P);
    const one = await P.eval(`document.querySelectorAll('[name="hc-track"], [name="hc-src"], .v3c-hc [data-a=start]').length`);
    check(one === 0, `${tag}: one click starts it, no mode selector or Start button (${one})`);
    const on = await until(P, `${HC}.then(H => H.state().on)`, 1800000, 1000);
    const s1 = await P.eval(`${HC}.then(H => H.state())`);
    check(on >= 0 && s1.track === "both" && s1.tracks === 1, `${tag}: Hands-free (head and hands) started from the fake camera in ${((Date.now() - t0) / 1000).toFixed(0)} s (${JSON.stringify(s1)})`);
    const seen = await until(P, `${HC}.then(H => H.state().hand !== "none" && /^Hand ✋/.test(H.state().pill))`, 120000, 250);
    const s1b = await P.eval(`${HC}.then(H => H.state())`);
    check(seen >= 0, `${tag}: the real Gesture Recognizer sees the open hand in the clip, the hand takes over and the pill says "${s1b.pill}" (ctrl ${s1b.ctrl})`);
    await shot("pill_real");
    const after = P.requests.slice(n0);
    check(after.some(r => /gesture_recognizer\.task/.test(r)) && after.some(r => /face_landmarker\.task/.test(r)) && after.some(r => /vision_wasm_internal\.wasm/.test(r)), `${tag}: both models and the WASM fetched from this site`);
    note(`${tag}: tracker ${JSON.stringify({delegate: s1b.delegate, bench: s1b.bench, fps: s1b.fps, main: s1b.main})}`);

    /* the pill, the camera and the actions with synthetic landmarks */
    const c0 = await cam(P);
    let st = await P.fn(`return __feed(30, i => ({lm: __hand(0.6 - 0.008 * i, 0.5), g: "Open_Palm", score: 0.9}));`);
    const c1 = await cam(P);
    check(st.ctrl === "hand" && st.pill === "Hand ✋ rotate" && dist(c0, c1) > 1, `${tag}: an open palm moving turns the view (pill "${st.pill}", moved ${dist(c0, c1).toFixed(1)} kpc)`);
    await shot("pill_rotate");
    st = await P.fn(`await __feed(4, i => ({lm: __hand(0.4, 0.5, 0.2, 0.2), g: "None", score: 0.5})); return __feed(14, i => ({lm: __hand(0.4, 0.5, 0.2 + 0.006 * i, 0.2), g: "None", score: 0.5}));`);
    const c2 = await cam(P);
    check(st.pill === "Hand 🤏 zoom" && c2.d < c1.d * 0.97, `${tag}: a pinch pulled toward the camera zooms in (pill "${st.pill}", distance ${c1.d.toFixed(0)} -> ${c2.d.toFixed(0)})`);
    await shot("pill_zoom");
    st = await P.fn(`return __feed(20, i => ({lm: __hand(0.6 - 0.01 * i, 0.5), g: "Closed_Fist", score: 0.9}));`);
    const c3 = await cam(P); st = await P.fn(`return __feed(10, i => ({lm: __hand(0.4 - 0.01 * i, 0.5), g: "Closed_Fist", score: 0.9}));`); const c4 = await cam(P);
    check(st.pill === "Hand ✊ paused" && dist(c3, c4) < 1e-6, `${tag}: a fist pauses: the view stays frozen while it moves (pill "${st.pill}", moved ${dist(c3, c4)})`);
    await shot("pill_paused");
    const id0 = await P.eval(`tngApp.getState().id`);
    st = await P.fn(`await __feed(5, i => ({lm: __hand(0.7, 0.5), g: "Open_Palm", score: 0.9})); return __feed(8, i => ({lm: __hand(0.62 - 0.08 * i, 0.5), g: "Open_Palm", score: 0.9}), 35);`);
    const sw = await until(P, `tngApp.getState().id !== ${JSON.stringify(id0)}`, 30000, 300);
    check(st.toast === "👋 Next sightline" && sw >= 0, `${tag}: a quick swipe to the right is next sightline (toast "${st.toast}", sightline ${id0} -> ${await P.eval(`tngApp.getState().id`)})`);
    await shot("toast_next");
    await sleep(1800);
    const m0 = await P.eval(`tngViewer3d.mode`);
    st = await P.fn(`return __feed(22, i => ({lm: __hand(0.5, 0.5), g: "Victory", score: 0.9}));`);
    const m1 = await P.eval(`tngViewer3d.mode`);
    check(m0 === "integral" && m1 === "volume" && st.toast === "✌️ Volume", `${tag}: victory held toggles Integral to Volume (${m0} -> ${m1}, toast "${st.toast}")`);
    await shot("toast_volume");
    await P.fn(`return __feed(5, i => ({lm: __hand(0.5, 0.5), g: "Open_Palm", score: 0.9}));`); await sleep(1600);
    st = await P.fn(`return __feed(22, i => ({lm: __hand(0.5, 0.5), g: "Pointing_Up", score: 0.9}));`);
    const orb = await P.eval(`document.querySelector("#v3-orbit").getAttribute("aria-pressed")`);
    check(orb === "true" && st.toast === "☝️ Orbit on", `${tag}: point up held starts the orbit (toast "${st.toast}")`);
    await shot("toast_orbit");
    await P.fn(`return __feed(5, i => ({lm: __hand(0.5, 0.5), g: "Open_Palm", score: 0.9}));`); await sleep(1600);
    st = await P.fn(`return __feed(22, i => ({lm: __hand(0.5, 0.5), g: "Pointing_Up", score: 0.9}));`);
    check(await P.eval(`document.querySelector("#v3-orbit").getAttribute("aria-pressed")`) === "false" && st.toast === "☝️ Orbit off", `${tag}: and again stops it (toast "${st.toast}")`);
    await P.fn(`return __feed(5, i => ({lm: __hand(0.5, 0.5), g: "Open_Palm", score: 0.9}));`); await sleep(1600);
    st = await P.fn(`return __feed(22, i => ({lm: __hand(0.5, 0.5), g: "Thumb_Up", score: 0.9}));`);
    check(st.toast === "👍 Recentred", `${tag}: thumbs up held recentres (toast "${st.toast}")`);
    /* while a sign is held (before and after it fires) the pill shows it, not "Hand ✋ rotate" */
    await P.fn(`return __feed(5, i => ({lm: __hand(0.5, 0.5), g: "Open_Palm", score: 0.9}));`); await sleep(1600);
    const hp = await P.fn(`const r = []; for (const g of ["Thumb_Up", "Victory", "Pointing_Up"]) { await __feed(5, i => ({lm: __hand(0.5, 0.5), g, score: 0.9})); r.push((await __feed(1, () => ({lm: __hand(0.5, 0.5), g, score: 0.9}))).pill); await __feed(4, i => ({lm: __hand(0.5, 0.5), g: "Open_Palm", score: 0.9})); } return r;`);
    check(hp.join() === "👍 hold…,✌️ hold…,☝️ hold…", `${tag}: the pill shows the held sign (${hp.join(" | ")})`);
    await P.fn(`return __feed(5, i => ({lm: __hand(0.5, 0.5), g: "Thumb_Up", score: 0.9}));`); await shot("pill_hold");
    await P.fn(`return __feed(5, i => ({lm: __hand(0.5, 0.5), g: "Open_Palm", score: 0.9}));`);   // the hand still in view for the handback below
    await shot("toast_recentred");
    const hb = await P.fn(`const H = await ${HC}; H._hand(null); await new Promise(r => setTimeout(r, 500)); const a = H.state().ctrl; await new Promise(r => setTimeout(r, 1700)); return {a, b: H.state().ctrl, pill: H.state().pill};`);
    check(hb.a === "hand" && hb.b === "head" && hb.pill === "Head", `${tag}: the head resumes about 1 s after the hand leaves (${JSON.stringify(hb)})`);
    await shot("pill_head");
    await P.click('[data-testid="v3-head"]'); await sleep(500);
    const s2 = await P.fn(`const H = await ${HC}; return {on: H.state().on, pill: !!document.querySelector(".v3d-hc, .v3d-hg"), pressed: document.querySelector('[data-testid="v3-head"]').getAttribute("aria-pressed")};`);
    const lv = await live(P);
    check(!s2.on && !s2.pill && lv === 0 && s2.pressed === "false", `${tag}: a second click ends every camera track and removes the pill and guide (${JSON.stringify(s2)}, live ${lv})`);
    check(!P.exceptions.length, `${tag}: no page exceptions${P.exceptions.length ? ": " + P.exceptions.slice(0, 3).join(" | ") : ""}`);
    /* a low tier says the camera may be slow */
    await P.eval(`document.documentElement.dataset.tier = "low"`); await press(P); await sleep(500);   // a low tier mounts no live viewer: the tier the quick check reads
    const lowMsg = await P.eval(`document.querySelector(".v3d-hc .hc-st")?.textContent || ""`);
    check(/may be slow/i.test(lowMsg), `${tag}: a low-tier desktop is told camera control may be slow ("${lowMsg}")`);
    await shot("capability_low");
    await P.click('[data-testid="v3-head"]'); await sleep(300);
  } catch (x) { check(false, `${tag}: aborted: ${x.message}`); }
  finally { await P.close(); }
}

async function touch() {
  const w = 390, h = 844, tag = "390px", P = await browser(w, h), shot = async n => { if (SHOTS) await P.shot(join(SHOTS, `handctl_${w}_${n}.png`)); };
  try {
    if (!(await open(P, w, h, true, "tier=high"))) { check(false, `${tag}: 3D viewer mounted`); return; }
    check(await P.eval(`document.querySelector('[data-testid="v3-head"]').textContent.trim()`) === "Hands-free", `${tag}: button label "Hands-free"`);
    const n0 = P.requests.length;
    await press(P);
    const on = await until(P, `${HC}.then(H => H.state().on)`, 1800000, 1000);
    const seen = await until(P, `${HC}.then(H => H.state().hand !== "none")`, 120000, 250);
    const s1 = await P.eval(`${HC}.then(H => H.state())`);
    check(on >= 0 && seen >= 0 && s1.track === "both" && !s1.tilt && /^Hand/.test(s1.pill), `${tag}: one tap starts the camera on a high-tier touch device and it sees the hand (${JSON.stringify({pill: s1.pill, bench: s1.bench, fps: s1.fps})})`);
    const after = P.requests.slice(n0);
    check(after.some(r => /gesture_recognizer\.task/.test(r)) && after.some(r => /face_landmarker\.task/.test(r)), `${tag}: both models fetched from this site`);
    // the page's own backend health polls (blocked in tests) and data host are not the tracker's
    const off = after.filter(r => !r.split(" ")[1].startsWith(srv.origin + "/") && !/^\w+ (data|blob):/.test(r) && !/^\w+ https:\/\/huggingface\.co\/datasets\//.test(r) && !/\/api\/health$/.test(r));
    check(!off.length, `${tag}: nothing fetched off-origin after Start${off.length ? ": " + off.join(", ") : ""}`);
    await shot("pill");
    await P.fn(`const H = await ${HC}; for (let i = 0; i < 300; i++) H._rate(400);`); await sleep(400);
    const fb = await P.fn(`const H = await ${HC}; return {on: H.state().on, st: document.querySelector(".v3d-hc .hc-st")?.textContent};`);
    const lv = await live(P);
    check(!fb.on && lv === 0 && /Tilt/.test(fb.st || ""), `${tag}: a slow tracker stops the camera with a message pointing to Tilt (${JSON.stringify(fb)}, live ${lv})`);
    await shot("fallback");
    await P.send("DeviceOrientation.setDeviceOrientationOverride", {alpha: 0, beta: 30, gamma: 0});
    await P.click('[data-testid="v3-head"]');
    const tt = await until(P, `${HC}.then(H => H.state().on && H.state().tilt)`, 15000, 200);
    check(tt >= 0 && (await live(P)) === 0, `${tag}: the next tap starts Tilt, no camera`);
    await P.click('[data-testid="v3-head"]'); await sleep(300);
    check(!P.exceptions.length, `${tag}: no page exceptions${P.exceptions.length ? ": " + P.exceptions.slice(0, 3).join(" | ") : ""}`);
  } catch (x) { check(false, `${tag}: aborted: ${x.message}`); }
  finally { await P.close(); }
}

try { await desktop(); await touch(); }
finally { await srv.close(); rmSync(work, {recursive: true, force: true}); }
if (SHOTS) note("screenshots in " + SHOTS);
process.exit(C.finish());
