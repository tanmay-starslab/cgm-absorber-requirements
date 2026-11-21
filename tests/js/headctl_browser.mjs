// Head control (Head mode) in a headless Chromium with a fake camera that shows a face (tests/js/fixtures/face_portrait.jpg, the 2012
// official White House portrait, public domain as a US government work, cropped; MediaPipe's own test image).
// Usage: TNG_BROWSER=1 node tests/js/headctl_browser.mjs [docs/tng50] [--viz DIR] [--edge BIN] [--shots DIR]
// It builds a short y4m from the fixture with ffmpeg ($FFMPEG, else ffmpeg on PATH, else ~/.conda/envs/cgm/bin/ffmpeg;
// skipped when none is found), starts Chrome with --use-fake-device-for-media-stream --use-fake-ui-for-media-stream
// --use-file-for-fake-video-capture, opens the 3D tab, presses Head control and Start, and checks:
//   - nothing of the tracker (vendor/mediapipe, headworker.js) is fetched before Start;
//   - tracking starts: the worker loads, calibration ends and poses arrive from the fake camera;
//   - Window mode installs the off-axis projection, Orbit mode turns the camera;
//   - Stop (and Esc) end every camera track, remove the preview and restore the projection;
//   - every request after Start, the worker's included (CDP auto-attach), is same-origin.
// With --shots DIR it saves the button, the popover and the active state at 1440 and 390 px.
import {existsSync, mkdirSync, rmSync} from "node:fs";
import {execFileSync} from "node:child_process";
import {join, resolve} from "node:path";
import {homedir, tmpdir} from "node:os";
import {ROOT, parseArgs, checker, serve, launch, READY, UI_LIB, BLOCK, pickPage, sleep} from "./lib/browser.mjs";

if (!process.env.TNG_BROWSER) { console.log("skipped (set TNG_BROWSER=1 to run the head control browser test)"); process.exit(0); }
const {pos, opt} = parseArgs(process.argv.slice(2));
const FF = [process.env.FFMPEG, "ffmpeg", join(homedir(), ".conda/envs/cgm/bin/ffmpeg")].filter(Boolean).find(f => { try { execFileSync(f, ["-version"], {stdio: "ignore"}); return true; } catch { return false; } });
if (!FF) { console.log("skipped (no ffmpeg to build the fake camera video; set FFMPEG)"); process.exit(0); }
const DIR = resolve(pos[0] || join(ROOT, "docs/tng50")), PAGE = pickPage(DIR, opt.page), SHOTS = opt.shots && resolve(opt.shots);
const work = join(tmpdir(), `headctl-${process.pid}`); mkdirSync(work, {recursive: true});
const Y4M = join(work, "face.y4m");
// 4 s of the portrait at 15 fps, panning sideways so the head moves in the frame
execFileSync(FF, ["-hide_banner", "-loglevel", "error", "-y", "-loop", "1", "-i", join(ROOT, "tests/js/fixtures/face_portrait.jpg"),
  "-filter_complex", "color=c=0x6a3a30:s=480x300:r=15:d=4[bg];[bg][0]overlay=x=80+60*sin(2*PI*t/4):y=17:shortest=1,scale=320:200,format=yuv420p", "-t", "4", Y4M]);

const C = checker(), check = C.check, note = C.note;
const srv = await serve({dir: DIR, page: PAGE, port: opt.port, viz: opt.viz || process.env.TNG_VIZ});
const ARGS = ["--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream", `--use-file-for-fake-video-capture=${Y4M}`, "--enable-unsafe-swiftshader"];
const HC = `import(new URL("js/headctl.js", location.href).href)`;
/* P.waitFor wraps its expression in !!(...), so a promise would count as true at once: poll the awaited value instead */
const until = async (P, expr, ms, every = 500) => { const t = Date.now(); while (Date.now() - t < ms) { try { if (await P.eval(expr)) return Date.now() - t; } catch {} await sleep(every); } return -1; };
async function run(w, h, mobileTag) {
  const P = await launch({edge: opt.edge, block: BLOCK, width: w, height: h, args: ARGS, reducedMotion: false});
  try {
    if (mobileTag) await P.viewport(w, h, true);
    await P.send("Browser.grantPermissions", {permissions: ["sensors"], origin: srv.origin});   // touch-only: the button reads Tilt control
    /* the worker's requests: auto-attach to workers, enable Network there before they run */
    P.on(m => { if (m.method === "Target.attachedToTarget" && m.params.targetInfo.type === "worker") { const sid = m.params.sessionId;
      P.send("Network.enable", {}, sid).then(() => P.send("Runtime.runIfWaitingForDebugger", {}, sid)); } });
    await P.send("Target.setAutoAttach", {autoAttach: true, waitForDebuggerOnStart: true, flatten: true});
    await P.send("Page.addScriptToEvaluateOnNewDocument", {source: `window.__streams = []; { const md = navigator.mediaDevices; if (md) { const g = md.getUserMedia.bind(md); md.getUserMedia = async c => { const s = await g(c); __streams.push(s); return s; }; } }`});
    await P.goto(srv.base + (srv.query ? srv.query + "&" : "?") + "tier=high#tab=3d");   // perf R5: the live viewer (software GL is otherwise the low tier's still)
    await P.waitFor(READY, 60000, 200); await P.eval(UI_LIB);
    await P.eval(`tngApp.showTab("3d")`);
    if (await P.waitFor(`document.querySelector('[data-testid="v3-head"]')`, 90000, 250) < 0) { check(false, `${w}px: 3D viewer mounted with the head control button`); return; }
    const tag = `${w}px`, shot = async n => { if (SHOTS) await P.shot(join(SHOTS, `headctl_${w}_${n}.png`)); };
    await P.eval(`document.querySelector('[data-testid="v3-head"]').scrollIntoView({block: "center"})`);
    /* software WebGL keeps the main thread busy while the cubes load and refine: start once frames are under 60 ms apart */
    const tq = Date.now(); let idle = -1; for (let i = 0; i < 60 && idle < 0; i++) idle = await P.waitFor(`(() => { const t = performance.now(), ok = window.__qt && t - window.__qt < 60; window.__qt = t; return ok; })()`, 5000, 30);
    note(`${tag}: page idle after ${((Date.now() - tq) / 1000).toFixed(0)} s`);
    const lbl = await P.eval(`document.querySelector('[data-testid="v3-head"]').textContent.trim()`);
    check(lbl === (mobileTag ? "Motion control" : "Head and hands"), `${tag}: button label "${lbl}"`);
    await shot("button");
    if (mobileTag) {   // touch: first no sensor (an error state), then CDP's device-orientation override as the sensor
      await P.click('[data-testid="v3-head"]'); await P.waitFor(`document.querySelector(".v3c-hc [data-a=start]")`, 15000, 100); await shot("popover");
      await P.waitFor(`document.querySelector(".v3c-hc")?.dataset.camera`, 10000, 100);   // the quick check shows Camera and Tilt
      await P.click('.v3c-hc input[value="tilt"] + span'); await P.click(".v3c-hc [data-a=start]"); await sleep(2600);
      const st = await P.eval(`document.querySelector(".v3c-hc .hc-st")?.textContent`);
      check(/tilt sensor|permission/i.test(st || ""), `${tag}: tilt without a sensor shows a clear error: "${st}"`); await shot("error");
      await P.send("DeviceOrientation.setDeviceOrientationOverride", {alpha: 0, beta: 30, gamma: 0});
      await P.click('.v3c-hc input[value="tilt"] + span'); await P.click(".v3c-hc [data-a=start]");
      const tt = await until(P, `${HC}.then(H => H.state().on && H.state().tilt && H.state().calibrated)`, 15000, 200);
      const c0 = await P.eval(`tngViewer3d.camera.position.toArray()`);
      for (let g = 2; g <= 20; g += 2) { await P.send("DeviceOrientation.setDeviceOrientationOverride", {alpha: 0, beta: 30, gamma: g}); await sleep(80); }
      await sleep(1200); const c1 = await P.eval(`tngViewer3d.camera.position.toArray()`), mv = Math.hypot(...c0.map((x, i) => x - c1[i]));
      check(tt >= 0 && mv > 1, `${tag}: tilt control calibrates on the current tilt and a 20 degree tilt orbits the view (moved ${mv.toFixed(1)} kpc)`);
      await shot("active");
      await P.click('.v3c-hc [data-a="stop"]'); await sleep(300);
      check(!(await P.eval(`${HC}.then(H => H.state().on)`)), `${tag}: Stop ends tilt control`);
      return;
    }
    const before = P.requests.filter(r => /mediapipe|headworker/.test(r)).length;
    await P.click('[data-testid="v3-head"]'); await P.waitFor(`document.querySelector(".v3c-hc [data-a=start]")`, 15000, 100); await shot("popover");
    check(before === 0 && P.requests.filter(r => /mediapipe|headworker/.test(r)).length === 0, `${tag}: no tracker file fetched before Start`);
    const n0 = P.requests.length, t0 = Date.now();
    await P.click('.v3c-hc input[value="head"] + span'); await P.click(".v3c-hc [data-a=start]");
    const tc = await until(P, `${HC}.then(H => H.state().calibrated && !!H.state().pose)`, 240000, 500);
    const s1 = await P.eval(`${HC}.then(H => H.state())`);
    check(tc >= 0 && s1.on && s1.tracks === 1, `${tag}: tracking started from the fake camera in ${((Date.now() - t0) / 1000).toFixed(1)} s (${JSON.stringify(s1)})`);
    const after = P.requests.slice(n0);
    note(`${tag}: requests after Start: ${after.filter(r => !/huggingface\.co\/datasets/.test(r)).map(r => r.replace(srv.origin, "")).join(", ")}`);
    check(after.some(r => /face_landmarker\.task/.test(r)) && after.some(r => /vision_wasm_internal\.wasm/.test(r)) && !after.some(r => /gesture_recognizer/.test(r)), `${tag}: face model and WASM fetched from this site (worker requests seen), no hand model in Head mode`);
    // the 3D cubes the page streams from its data host (huggingface.co, blocked in tests) are the viewer's, not head control's
    const off = after.filter(r => !r.split(" ")[1].startsWith(srv.origin + "/") && !/^\w+ (data|blob):/.test(r) && !/^\w+ https:\/\/huggingface\.co\/datasets\//.test(r));
    check(!off.length, `${tag}: nothing fetched off-origin after Start${off.length ? ": " + off.join(", ") : ""}`);
    /* orbit: the pose moves the camera (the face pans in the fake video) */
    const c0 = await P.eval(`tngViewer3d.camera.position.toArray()`); await sleep(3000); const c1 = await P.eval(`tngViewer3d.camera.position.toArray()`);
    note(`${tag}: orbit camera moved ${Math.hypot(...c0.map((x, i) => x - c1[i])).toFixed(1)} kpc over 3 s (pose ${JSON.stringify((await P.eval(`${HC}.then(H => H.state().pose)`)))})`);
    await shot("active");
    await P.click('.v3c-hc input[value="window"] + span');
    // the face pans about 6 cm either way in the fake video: wait for the frustum to go off-axis
    const tw = await until(P, `Math.abs(tngViewer3d.camera.projectionMatrix.elements[8]) > 1e-3`, 60000);
    const sw = await P.eval(`${HC}.then(H => ({s: H.state(), m: tngViewer3d.camera.projectionMatrix.elements.slice()}))`);
    check(sw.s.mode === "window" && sw.s.proj && tw >= 0, `${tag}: Window mode on (${JSON.stringify(sw.s)}; projection m[8] ${sw.m[8].toFixed(4)}, m[9] ${sw.m[9].toFixed(4)})`);
    await shot("window");
    await P.click('.v3c-hc [data-a="stop"]'); await sleep(500);
    const s2 = await P.fn(`const H = await ${HC}; const tr = __streams.flatMap(s => s.getTracks()); const m = tngViewer3d.camera.projectionMatrix.elements;
      return {st: H.state(), n: tr.length, live: tr.filter(t => t.readyState === "live").length, vids: document.querySelectorAll(".v3d-hc, .v3d video").length, sym: Math.abs(m[8]) < 1e-9 && Math.abs(m[9]) < 1e-9, pressed: document.querySelector('[data-testid="v3-head"]').getAttribute("aria-pressed")};`);
    check(!s2.st.on && s2.n >= 1 && s2.live === 0 && s2.vids === 0 && s2.sym && s2.pressed === "false", `${tag}: Stop ends every camera track, removes the preview and restores the projection (${JSON.stringify(s2)})`);
    /* Esc and leaving the tab also stop it */
    await P.click('[data-testid="v3-head"]'); await P.waitFor(`document.querySelector(".v3c-hc [data-a=start]")`, 15000, 100); await P.click(".v3c-hc [data-a=start]");
    await until(P, `${HC}.then(H => H.state().tracks === 1)`, 60000, 250); await P.key("Escape"); await sleep(400);
    const s3 = await P.fn(`const H = await ${HC}; return {on: H.state().on, live: __streams.flatMap(s => s.getTracks()).filter(t => t.readyState === "live").length};`);
    check(!s3.on && s3.live === 0, `${tag}: Esc stops it and the camera (${JSON.stringify(s3)})`);
    await P.click('[data-testid="v3-head"]'); await P.waitFor(`document.querySelector(".v3c-hc [data-a=start]")`, 15000, 100); await P.click(".v3c-hc [data-a=start]");
    await until(P, `${HC}.then(H => H.state().tracks === 1)`, 60000, 250); await P.eval(`tngApp.showTab("spectra")`); await sleep(400);
    const s4 = await P.fn(`const H = await ${HC}; return {on: H.state().on, live: __streams.flatMap(s => s.getTracks()).filter(t => t.readyState === "live").length};`);
    check(!s4.on && s4.live === 0, `${tag}: leaving the 3D tab stops it and the camera (${JSON.stringify(s4)})`);
    check(!P.exceptions.length, `${tag}: no page exceptions${P.exceptions.length ? ": " + P.exceptions.slice(0, 3).join(" | ") : ""}`);
  } catch (x) { check(false, `${w}px: aborted: ${x.message}`); }
  finally { await P.close(); }
}
try {
  await run(1440, 900, false);
  await run(390, 844, true);
} finally { await srv.close(); rmSync(work, {recursive: true, force: true}); }
if (SHOTS) note("screenshots in " + SHOTS);
process.exit(C.finish());
