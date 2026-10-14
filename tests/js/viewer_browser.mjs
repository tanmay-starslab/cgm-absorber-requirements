// Headless-Edge browser test of the Phase-2b 3D viewer (design §5.11 items 6-8). Run manually:
//   TNG_BROWSER=1 node tests/js/viewer_browser.mjs --viz <viz dir with manifest_v2.json> [--port 8871] [--cdp 9271]
//       [--profile <edge user-data-dir>] [--shots <dir>] [--bench 60] [--edge <binary>] [--page <html served at /tng50/>]
// It starts its own static server on --port (the page at /tng50/ from docs/tng50, the viz dir at /viz/), launches
// Edge headless with remote debugging, opens /tng50/?viz=http://127.0.0.1:<port>/viz/#tab=3d at 1440×900 and checks:
// WebP decode byte-exact (sha256 = raw_sha256, no gz fallback), non-blank frames, viewer.bench() exact/moving frame
// times, the fullscreen enter/exit cycle (CDP click + Esc) restoring the layout, mobile 390×844 without horizontal
// scroll, and no page exceptions. With --shots it also writes the §10 screenshots it can make from the data present.
// Without TNG_BROWSER=1 (e.g. under run_all.mjs) it only prints "skipped".
import {createServer} from "node:http";
import {readFileSync, existsSync, statSync, mkdirSync, writeFileSync, readdirSync} from "node:fs";
import {spawn} from "node:child_process";
import {join, extname, resolve, dirname} from "node:path";
import {fileURLToPath} from "node:url";

if (!process.env.TNG_BROWSER) { console.log("skipped (set TNG_BROWSER=1 and pass --viz DIR to run the headless Edge test)"); process.exit(0); }
const HERE = dirname(fileURLToPath(import.meta.url)), ROOT = resolve(HERE, "../..");
const A = Object.fromEntries(process.argv.slice(2).reduce((acc, x, i, all) => (x.startsWith("--") ? acc.concat([[x.slice(2), all[i + 1]]]) : acc), []));
const PORT = +(A.port || 8871), CDP = +(A.cdp || 9271), VIZ = A.viz && resolve(A.viz), SHOTS = A.shots && resolve(A.shots), NB = +(A.bench || 60);
const EDGE = A.edge || "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge";
if (!VIZ || !existsSync(join(VIZ, "manifest_v2.json"))) { console.error("--viz DIR with a manifest_v2.json is required"); process.exit(2); }
if ([8787, 8000].includes(PORT)) { console.error("ports 8787 and 8000 are reserved"); process.exit(2); }
if (SHOTS) mkdirSync(SHOTS, {recursive: true});
let fails = 0; const check = (ok, msg) => { console.log(`${ok ? "ok  " : "FAIL"} ${msg}`); if (!ok) fails++; };
const sleep = ms => new Promise(r => setTimeout(r, ms));

/* ---- static server ---- */
const TYPES = {".html": "text/html; charset=utf-8", ".js": "text/javascript", ".mjs": "text/javascript", ".json": "application/json", ".webp": "image/webp",
  ".gz": "application/octet-stream", ".bin": "application/octet-stream", ".png": "image/png"};
const DOCS = join(ROOT, "docs/tng50"), ix = join(DOCS, "index.html");
const PAGE = A.page ? resolve(A.page) : existsSync(ix) && readFileSync(ix, "utf8").includes("manifest_v2") ? ix : join(DOCS, "_template.html");   // --page: another page file
let blockViz = false; const held = [], hangSeen = [];
const MEM = new Map(), readMem = f => { if (!MEM.has(f)) MEM.set(f, readFileSync(f)); return MEM.get(f); };   // the viz dir may sit on a slow disk
{ const t = Date.now(), walk = d => { for (const e of readdirSync(d, {withFileTypes: true})) { const f = join(d, e.name); if (e.isDirectory()) walk(f); else if (!/\.(gz|rgba)$/.test(f)) readMem(f); } }; walk(VIZ);
  console.log(`preloaded ${MEM.size} viz files (${([...MEM.values()].reduce((a, b) => a + b.length, 0) / 1e6).toFixed(1)} MB) in ${((Date.now() - t) / 1000).toFixed(1)} s`); }
const srv = createServer((req, res) => {
  const u = new URL(req.url, "http://x"), p = decodeURIComponent(u.pathname);
  let f = null;
  if (p === "/tng50/" || p === "/tng50/index.html") f = PAGE;
  else if (p.startsWith("/tng50/")) f = join(DOCS, p.slice(7));
  else if (p.startsWith("/hang/")) {      // fix-ui FE-01: the manifest answers, every cube request is accepted and never answered
    if (!p.endsWith("manifest_v2.json")) { held.push(res); hangSeen.push(p); return; } f = join(VIZ, "manifest_v2.json"); }
  else if (p.startsWith("/viz/")) { if (blockViz && !p.endsWith("manifest_v2.json")) { res.writeHead(503); res.end(); return; } f = join(VIZ, p.slice(5)); }
  if (!f || !f.startsWith(p.startsWith("/viz/") || p.startsWith("/hang/") ? VIZ : DOCS) && f !== PAGE || !existsSync(f) || statSync(f).isDirectory()) { res.writeHead(404); res.end("not found"); return; }
  res.writeHead(200, {"Content-Type": TYPES[extname(f)] || "application/octet-stream", "Access-Control-Allow-Origin": "*", "Cache-Control": "no-store"});
  res.end(f.startsWith(VIZ) ? readMem(f) : readFileSync(f));
});
await new Promise(r => srv.listen(PORT, "127.0.0.1", r));
console.log(`serving ${PAGE.replace(ROOT + "/", "")} and ${VIZ} on http://127.0.0.1:${PORT}`);

/* ---- Edge + CDP ---- */
const profile = A.profile || join(VIZ, "..", "edge-profile");
const edge = spawn(EDGE, ["--headless=new", `--remote-debugging-port=${CDP}`, `--user-data-dir=${profile}`, "--no-first-run", "--no-default-browser-check",
  "--window-size=1440,900", "about:blank"], {stdio: "ignore"});
let tabs = null; for (let i = 0; i < 300 && !tabs; i++) { await sleep(200); try { tabs = await (await fetch(`http://127.0.0.1:${CDP}/json/list`)).json(); } catch {} }
if (!tabs) { console.error(`Edge did not open CDP port ${CDP}`); edge.kill(); process.exit(1); }
const page = tabs.find(t => t.type === "page"), ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise(r => ws.addEventListener("open", r));
let id = 0; const pend = new Map(), exceptions = [], consoleErr = [];
ws.addEventListener("message", ev => { const m = JSON.parse(ev.data);
  if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); return; }
  if (m.method === "Runtime.exceptionThrown") exceptions.push(JSON.stringify(m.params.exceptionDetails).slice(0, 400));
  if (m.method === "Runtime.consoleAPICalled" && m.params.type === "error") consoleErr.push(m.params.args.map(a => a.value ?? a.description).join(" ").slice(0, 300)); });
const send = (method, params = {}) => new Promise(r => { const i = ++id; pend.set(i, r); ws.send(JSON.stringify({id: i, method, params})); });
const ev = async (expr, gesture = false) => { const r = await send("Runtime.evaluate", {expression: expr, awaitPromise: true, returnByValue: true, userGesture: gesture, timeout: 120000});
  if (r.result?.exceptionDetails) throw new Error(r.result.exceptionDetails.exception?.description || JSON.stringify(r.result.exceptionDetails)); return r.result?.result?.value; };
const shot = async name => { if (!SHOTS) return; const r = await send("Page.captureScreenshot", {format: "png"}); writeFileSync(join(SHOTS, name), Buffer.from(r.result.data, "base64")); console.log("     shot " + name); };
const metrics = (w, h, mobile = false, dpr = 1) => send("Emulation.setDeviceMetricsOverride", {width: w, height: h, deviceScaleFactor: dpr, mobile});
await send("Runtime.enable"); await send("Page.enable");
await send("Emulation.setEmulatedMedia", {features: [{name: "prefers-color-scheme", value: "dark"}]});
await metrics(1440, 900);
const URL3D = `http://127.0.0.1:${PORT}/tng50/?viz=${encodeURIComponent(`http://127.0.0.1:${PORT}/viz/`)}#tab=3d`;
const waitViewer = async (ms = 300000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) {
  const s = await ev(`(() => { const v = window.tngViewer3d; return v ? (v.species ? "ready" : v.webgl2 === false ? "stub" : "mounting") : "none"; })()`).catch(() => "none");
  if (s === "ready" || s === "stub") return s; await sleep(250); } return "timeout"; };
const allBound = async (ms = 240000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) {
  const L = await ev(`JSON.stringify(window.tngViewer3d.levels())`); if (!L.includes("loading")) return JSON.parse(L); await sleep(250); } return null; };
const nonBlank = () => ev(`(() => { const v = window.tngViewer3d, c = v.canvas; v.render(); const g = document.createElement("canvas"); g.width = 160; g.height = 100;
  const x = g.getContext("2d"); if (v.drawNow) v.drawNow(); else v.renderer.render(v.scene, v.camera); x.drawImage(c, 0, 0, 160, 100); const d = x.getImageData(0, 0, 160, 100).data; let n = 0, s = 0;
  for (let i = 0; i < d.length; i += 4) { const l = d[i] + d[i + 1] + d[i + 2]; if (l > 40) n++; s += l; } return {frac: n / 16000, mean: s / 16000 / 3}; })()`);
const setView = async (expr, wait = 900) => { await ev(expr);
  for (let i = 0; i < 600; i++) { if (await ev(`(() => { const v = window.tngViewer3d; return !v.wanted || v.species === v.wanted || !!v.loadError; })()`)) break; await sleep(250); } await ev(`document.querySelector(".v3d-stage").scrollIntoView({block: "end"})`); await sleep(wait); await allBound(); await ev(`window.tngViewer3d.render()`); await sleep(350); };

const t0 = Date.now();
await send("Page.navigate", {url: URL3D});
const st = await waitViewer();
check(st === "ready", `viewer mounted and the first field bound (${st}, ${((Date.now() - t0) / 1000).toFixed(1)} s)`);
if (st !== "ready") { console.log(await ev(`document.querySelector(".v3d-msg")?.textContent || document.querySelector("#v3d-root")?.textContent`)); }
else {
  const lv = await allBound();
  /* fix-ui FE-05: switching to another field and straight back leaves no stale "loading …" message */
  { const r = JSON.parse(await ev(`(async () => { const v = window.tngViewer3d, a = v.setSpecies("HI"), b = v.setSpecies("nH"); const rb = await b; await a.catch(() => {});
      await new Promise(r => setTimeout(r, 600)); return JSON.stringify({rb, species: v.species, msg: v.message}); })()`));
    check(r.rb === true && r.species === "nH" && r.msg === "", `setSpecies("HI") then setSpecies("nH"): back on ${r.species}, stage message "${r.msg}"`); }
  /* fix-ui FE-07: Cmd/Ctrl/Alt + key on the canvas is left to the browser */
  { const r = JSON.parse(await ev(`(() => { const v = window.tngViewer3d, c = v.canvas, p0 = v.camera.position.clone(), s0 = v.stars, out = {};
      for (const [key, mod] of [["r", "metaKey"], ["s", "ctrlKey"], ["f", "metaKey"], ["=", "ctrlKey"], ["g", "altKey"]]) {
        const e = new KeyboardEvent("keydown", {key, [mod]: true, bubbles: true, cancelable: true}); c.dispatchEvent(e); out[mod + "+" + key] = e.defaultPrevented; }
      const plain = new KeyboardEvent("keydown", {key: "=", bubbles: true, cancelable: true}); c.dispatchEvent(plain);
      return JSON.stringify({prevented: out, moved: v.camera.position.distanceTo(p0) > 1e-6, starsSame: v.stars === s0, plain: plain.defaultPrevented}); })()`));
    check(!Object.values(r.prevented).some(Boolean) && r.starsSame && r.plain, `modifier shortcuts not swallowed (${JSON.stringify(r.prevented)}), plain "=" still zooms (${r.plain})`); }
  const info = JSON.parse(await ev(`JSON.stringify({vw: innerWidth, vh: innerHeight, scheme: matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light", dpr: devicePixelRatio,
    stage: [document.querySelector(".v3d-stage").clientWidth, document.querySelector(".v3d-stage").clientHeight], loads: window.tngViewer3d.stats.loads, first: window.tngViewer3d.stats.firstFrameMs,
    gpu: window.tngViewer3d.gpuBytes(), levels: window.tngViewer3d.levels(), cal: window.tngViewer3d.stats.calibration})`));
  console.log(`     viewport ${info.vw}×${info.vh} ${info.scheme} dpr ${info.dpr}, stage ${info.stage.join("×")}, first exact frame ${info.first?.toFixed(0)} ms, GPU ${(info.gpu / 1e6).toFixed(1)} MB`);
  console.log(`     levels ${JSON.stringify(lv || info.levels)}; calibration ${JSON.stringify(info.cal)}`);
  for (const l of info.loads || []) console.log(`     load ${l.key}: ${l.format}, ${l.ms} ms (decode ${l.decodeMs} ms)${l.webpError ? " webp error: " + l.webpError : ""}`);
  check(info.vw === 1440 && info.vh === 900, `viewport measured in-page: ${info.vw}×${info.vh}`);
  check((info.loads || []).length > 0 && info.loads.every(l => l.format === "webp"), `WebP decode in Edge is byte-exact (sha256 = raw_sha256) for all ${info.loads?.length} cubes, no gz fallback`);
  check(info.gpu <= 448e6, `GPU bytes ${(info.gpu / 1e6).toFixed(1)} MB ≤ 448 MB`);
  const nb = await nonBlank();
  check(nb.frac > 0.05, `default view not blank: ${(100 * nb.frac).toFixed(1)} % lit pixels, mean ${nb.mean.toFixed(1)}`);
  await shot("07_default_composite.png");
  const B = await ev(`window.tngViewer3d.bench(${NB})`);
  console.log(`     bench: exact ${B.exact_ms_median.toFixed(1)} ms, moving exact ${B.moving_exact_ms_median.toFixed(1)} ms, moving fast ${B.moving_fast_ms_median.toFixed(1)} ms → moving path ${B.moving_path}; canvas ${B.size.join("×")} px`);
  check(B.exact_ms_median <= 300, `exact refine frame ${B.exact_ms_median.toFixed(1)} ms ≤ 300 ms`);
  check(Math.min(B.moving_exact_ms_median, B.moving_fast_ms_median) <= 33.4, `moving frame ${Math.min(B.moving_exact_ms_median, B.moving_fast_ms_median).toFixed(1)} ms ≤ 33 ms (path ${B.moving_path})`);
  if (SHOTS) {
    const V = "window.tngViewer3d";
    await setView(`${V}.setStars({on: false}); ${V}.setSpecies("nH").then(() => ${V}.setPreset("face-on")); ${V}.camera.position.setLength(165); ${V}.controls.update();`, 1200);
    await ev(`(() => { const v = ${V}; const d = v.camera.position.clone().sub(v.controls.target).setLength(165); v.camera.position.copy(v.controls.target).add(d); v.controls.update(); v.render(); })()`); await sleep(800); await allBound();
    await shot("01_nH_faceon.png");
    await setView(`${V}.setPreset("edge-on")`, 1200); await shot("02_nH_edgeon.png");
    await setView(`(() => { const v = ${V}; const d = v.camera.position.clone().sub(v.controls.target).setLength(41); v.camera.position.copy(v.controls.target).add(d); v.controls.update(); })()`, 1200);
    await shot("03a_L2_edgeon_nH.png");
    await setView(`${V}.setSpecies("HI")`, 800); await shot("03b_L2_edgeon_HI.png");
    await setView(`${V}.setSpecies("OVI").then(() => ${V}.setPreset("face-on")); (() => { const v = ${V}; const d = v.camera.position.clone().sub(v.controls.target).setLength(1236); v.camera.position.copy(v.controls.target).add(d); v.controls.update(); })()`, 1400);
    await shot("04_OVI_L0.png");
    await setView(`${V}.setSpecies("nH").then(() => { ${V}.setStars({on: true, gasMix: 0}); ${V}.setPreset("face-on"); }); (() => { const v = ${V}; const d = v.camera.position.clone().sub(v.controls.target).setLength(110); v.camera.position.copy(v.controls.target).add(d); v.controls.update(); })()`, 1500);
    await shot("05_stars_faceon.png");
    await setView(`${V}.setPreset("edge-on")`, 1200); await shot("06_stars_edgeon.png");
    await setView(`${V}.setStars({on: true, gasMix: 1}); ${V}.setSpecies("T").then(() => { ${V}.setMode("volume"); ${V}.setPreset("face-on"); })`, 1500);
    await shot("08_T_volume_faceon.png");
    await setView(`${V}.setMode("integral"); ${V}.setSpecies("nH").then(() => ${V}.setPreset("reset"))`, 1500);
    const sel = await ev(`(() => { const e = tngApp.entries().find(e => e.p0 && /^edge_b100/.test(e.id)) || tngApp.entries().find(e => e.p0); tngApp.select(e.id, {source: "3d"}); return e.id; })()`);
    await sleep(800); await ev(`window.tngPicker && document.querySelector("#v3d-root") && ${V}.hooks.togglePick && ${V}.hooks.togglePick()`); await sleep(500);
    await shot("14_selected_pick.png"); await ev(`${V}.hooks.exitPick && ${V}.hooks.exitPick()`); console.log("     selected " + sel);
    await ev(`window.scrollTo(0, 0)`); await sleep(300);
    const r = await send("Page.captureScreenshot", {format: "png", captureBeyondViewport: true}); writeFileSync(join(SHOTS, "10_page_layout_full.png"), Buffer.from(r.result.data, "base64"));
  }
  /* fullscreen enter (real click = user activation) / Esc exit */
  const before = JSON.parse(await ev(`JSON.stringify([document.querySelector(".v3d-stage").getBoundingClientRect().width, document.querySelector(".v3d-stage").getBoundingClientRect().height, scrollY])`));
  const bp = JSON.parse(await ev(`(() => { const r = document.querySelector("#v3-fs").getBoundingClientRect(); return JSON.stringify([r.x + r.width / 2, r.y + r.height / 2]); })()`));
  for (const type of ["mouseMoved", "mousePressed", "mouseReleased"]) await send("Input.dispatchMouseEvent", {type, x: bp[0], y: bp[1], button: "left", buttons: type === "mousePressed" ? 1 : 0, clickCount: 1});
  await sleep(1200);
  const fs = JSON.parse(await ev(`JSON.stringify({native: document.fullscreenElement === document.querySelector(".v3d"), fallback: document.querySelector(".v3d").classList.contains("v3d-fs"),
    stage: [document.querySelector(".v3d-stage").clientWidth, document.querySelector(".v3d-stage").clientHeight], vw: innerWidth, vh: innerHeight,
    label: document.querySelector("#v3-fs").textContent, pressed: document.querySelector("#v3-fs").getAttribute("aria-pressed"), panel: !document.querySelector("#v3-ctl").hidden,
    focus: document.activeElement === window.tngViewer3d.canvas})`));
  check((fs.native || fs.fallback) && fs.stage[0] === fs.vw && fs.stage[1] === fs.vh && fs.label === "Exit fullscreen" && fs.pressed === "true" && fs.focus,
    `fullscreen (${fs.native ? "native" : fs.fallback ? "CSS fallback" : "none"}): stage ${fs.stage.join("×")} = viewport ${fs.vw}×${fs.vh}, label "${fs.label}", controls panel ${fs.panel ? "open" : "closed"}, focus on canvas ${fs.focus}`);
  await shot("09_fullscreen.png");
  await send("Input.dispatchKeyEvent", {type: "rawKeyDown", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27});
  await send("Input.dispatchKeyEvent", {type: "keyUp", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27});
  await sleep(800);
  let out = JSON.parse(await ev(`JSON.stringify({fs: !!document.fullscreenElement || document.querySelector(".v3d").classList.contains("v3d-fs"), w: document.querySelector(".v3d-stage").getBoundingClientRect().width, h: document.querySelector(".v3d-stage").getBoundingClientRect().height, label: document.querySelector("#v3-fs").textContent})`));
  if (out.fs) { console.log("     note: headless Esc did not leave native fullscreen; calling toggleFullscreen(false) (the Esc path is the browser's own)"); await ev(`window.tngViewer3d.toggleFullscreen(false)`); await sleep(600);
    out = JSON.parse(await ev(`JSON.stringify({fs: !!document.fullscreenElement || document.querySelector(".v3d").classList.contains("v3d-fs"), w: document.querySelector(".v3d-stage").getBoundingClientRect().width, h: document.querySelector(".v3d-stage").getBoundingClientRect().height, label: document.querySelector("#v3-fs").textContent})`)); }
  check(!out.fs && Math.abs(out.w - before[0]) < 1 && Math.abs(out.h - before[1]) < 1 && out.label === "Fullscreen", `fullscreen exit restores the layout: stage ${out.w}×${out.h} (was ${before[0]}×${before[1]})`);
  /* CSS fallback path: force it by hiding the API */
  await ev(`(() => { const e = document.querySelector(".v3d"); e.requestFullscreen = undefined; e.webkitRequestFullscreen = undefined; return window.tngViewer3d.toggleFullscreen(true); })()`); await sleep(500);
  const fb = JSON.parse(await ev(`JSON.stringify({on: document.querySelector(".v3d").classList.contains("v3d-fs"), body: document.body.classList.contains("v3d-noscroll"), w: document.querySelector(".v3d-stage").clientWidth, vw: innerWidth})`));
  await send("Input.dispatchKeyEvent", {type: "rawKeyDown", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27}); await send("Input.dispatchKeyEvent", {type: "keyUp", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27}); await sleep(500);
  const fb2 = JSON.parse(await ev(`JSON.stringify({on: document.querySelector(".v3d").classList.contains("v3d-fs"), body: document.body.classList.contains("v3d-noscroll"), w: document.querySelector(".v3d-stage").getBoundingClientRect().width})`));
  await ev(`(() => { const e = document.querySelector(".v3d"); delete e.requestFullscreen; delete e.webkitRequestFullscreen; })()`);
  check(fb.on && fb.body && fb.w === fb.vw && !fb2.on && !fb2.body && Math.abs(fb2.w - before[0]) < 1, `CSS fallback fullscreen: on (stage ${fb.w} = ${fb.vw}), Esc → off, layout restored (${fb2.w})`);
  /* mobile */
  await metrics(390, 844, true, 2); await send("Emulation.setTouchEmulationEnabled", {enabled: true, maxTouchPoints: 5});
  await send("Page.navigate", {url: "about:blank"}); await sleep(300); await send("Page.navigate", {url: URL3D}); const sm = await waitViewer();
  await allBound(); await sleep(800);
  const mob = JSON.parse(await ev(`JSON.stringify({vw: innerWidth, sw: document.documentElement.scrollWidth, stage: [document.querySelector(".v3d-stage").clientWidth, document.querySelector(".v3d-stage").clientHeight],
    stars: window.tngViewer3d.levels().stars, gas: window.tngViewer3d.levels().gas, cols: getComputedStyle(document.querySelector(".v3d-ctl")).gridTemplateColumns})`));
  check(sm === "ready" && mob.vw === 390 && mob.sw <= mob.vw && Math.abs(mob.stage[1] - Math.min(0.78 * 844, 1.3 * 390)) <= 2 && !Object.values(mob.stars).includes("bound") && mob.gas.L2 !== "bound",
    `mobile 390×844: innerWidth ${mob.vw}, scrollWidth ${mob.sw}, stage ${mob.stage.join("×")} (min(78svh,130vw) = ${Math.min(0.78 * 844, 1.3 * 390).toFixed(0)}), stars off, L2 ${mob.gas.L2}, controls "${mob.cols}"`);
  await shot("11_mobile_3d.png");
  if (SHOTS) { await ev(`window.scrollTo(0, document.querySelector(".v3d-ctl").getBoundingClientRect().top + scrollY - 200)`); await sleep(400); await shot("11b_mobile_controls.png"); }
  await send("Emulation.setTouchEmulationEnabled", {enabled: false}); await metrics(1280, 800);
  /* host blocked: the message, and the Spectra tab still works */
  blockViz = true; await send("Network.enable"); await send("Network.setCacheDisabled", {cacheDisabled: true});
  await ev(`caches.delete("tng50-viz-v2")`);
  await send("Page.navigate", {url: "about:blank"}); await sleep(300); await send("Page.navigate", {url: URL3D});
  for (let i = 0; i < 480; i++) { await sleep(500); if (await ev(`/unreachable|not available/.test(document.querySelector(".v3d-msg")?.textContent || "")`).catch(() => false)) break; }
  const hb = JSON.parse(await ev(`JSON.stringify({msg: document.querySelector(".v3d-msg")?.textContent || "", root: document.querySelector("#v3d-root")?.textContent.slice(0, 200)})`));
  await shot("13_host_blocked.png");
  await ev(`tngApp.showTab("spectra")`); await sleep(800);
  const sp = await ev(`document.querySelector("#statusline").textContent`);
  check(/is unreachable\. Sightlines, ray picking and the spectra still work/.test(hb.msg) && /log N/.test(sp), `host blocked: "${hb.msg.slice(0, 140)}"; spectra: "${sp.slice(0, 60)}"`);
  blockViz = false;
  /* fix-ui FE-01: a host that accepts the connection and never answers -> the unreachable message within the stall timeout */
  await ev(`caches.delete("tng50-viz-v2")`);
  const URLH = `http://127.0.0.1:${PORT}/tng50/?viz=${encodeURIComponent(`http://127.0.0.1:${PORT}/hang/`)}#tab=3d`, th = Date.now();
  await send("Page.navigate", {url: "about:blank"}); await sleep(300); await send("Page.navigate", {url: URLH});
  let hm = ""; for (let i = 0; i < 120; i++) { await sleep(500); hm = await ev(`document.querySelector(".v3d-msg")?.textContent || ""`).catch(() => ""); if (/unreachable/.test(hm)) break; }
  const dth = (Date.now() - th) / 1000;
  check(/is unreachable/.test(hm) && dth < 45 && !hangSeen.some(u => u.endsWith(".gz")), `hanging host: "${hm.slice(0, 110)}" after ${dth.toFixed(1)} s, ${hangSeen.length} held requests, no .gz behind them`);
  await shot("15_host_hang.png");
  for (const r of held.splice(0)) r.destroy();
}
check(exceptions.length === 0, `no page exceptions${exceptions.length ? ": " + exceptions.join(" | ") : ""}`);
if (consoleErr.length) console.log("     console errors: " + consoleErr.slice(0, 5).join(" | "));
ws.close(); edge.kill(); srv.close();
console.log(fails ? `\n${fails} check(s) FAILED` : "\nall checks passed");
process.exit(fails ? 1 : 0);
