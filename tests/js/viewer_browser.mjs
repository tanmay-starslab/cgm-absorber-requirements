// Headless-browser test of the 3D viewer (Phase-2b design §5.11 items 6-8; Phase-3 design §6.2 C13). Run manually:
//   TNG_BROWSER=1 node tests/js/viewer_browser.mjs --viz <viz dir with manifest_v2.json> [--port N]
//       [--profile <parent dir of the temp browser profile>] [--shots <dir>] [--bench 60] [--edge <binary>]
//       [--page <html served at /tng50/>] [--docs <dir served as /tng50/, default docs/tng50>]
// Phase 3 adds: the square stage (|w - h| <= 1, at most 60 vw) beside the grouped control column (Field, View, Layers,
// Mode, Pick ray), the 15-entry species menu (nH, T, Z + 12 ions in ladder order; species without cubes disabled with a
// tooltip, setSpecies on them false without an exception), no dot separators in the viewer's text, and, when the page
// has a #v3d-mini-host thumbnail (mountThumb), the thumbnail checks: shared cubes, square, not blank, the slow turn
// pausing off-screen, click to the 3D tab with the camera restored, and a thumbnail-first cold load (L0/L1 only).
// It starts its own static server (the page at /tng50/ from docs/tng50, the viz dir at /viz/) on --port, else
// TNG_TEST_PORT, else an OS-chosen port (8787 and 8000 are refused), launches the browser headless through
// tests/js/lib/browser.mjs like the other browser tests (binary --edge or TNG_EDGE; --remote-debugging-port=0, read back
// from DevToolsActivePort; a fresh profile under --profile, TNG_EDGE_PROFILE or the OS temp dir, never inside the viz
// dir, removed at exit; the owner's laptop server and the hosted backends blocked), opens
// /tng50/?viz=http://127.0.0.1:<port>/viz/#tab=3d at 1440×900 and checks: WebP decode byte-exact (sha256 =
// raw_sha256, no gz fallback), non-blank frames, viewer.bench() exact/moving frame times, the fullscreen enter/exit
// cycle (CDP click + Esc) restoring the layout, mobile 390×844 without horizontal scroll, and no page exceptions.
// TNG_REDUCED_MOTION is not applied here (this test checks the thumbnail's turn); when the browser binary forces
// prefers-reduced-motion anyway (a --force-prefers-reduced-motion wrapper), the thumbnail must stay still instead of
// turning, and the test says so. With --shots it also writes the §10 screenshots it can make from the data present.
// Without TNG_BROWSER=1 (e.g. under run_all.mjs) it only prints "skipped".
import {createServer} from "node:http";
import {readFileSync, existsSync, statSync, mkdirSync, writeFileSync, readdirSync, rmSync, realpathSync} from "node:fs";
import {join, extname, resolve, dirname, basename, relative, isAbsolute} from "node:path";
import {fileURLToPath} from "node:url";
import {launch, BLOCK, RESERVED_PORTS} from "./lib/browser.mjs";

if (!process.env.TNG_BROWSER) { console.log("skipped (set TNG_BROWSER=1 and pass --viz DIR to run the headless browser test)"); process.exit(0); }
const HERE = dirname(fileURLToPath(import.meta.url)), ROOT = resolve(HERE, "../..");
const A = Object.fromEntries(process.argv.slice(2).reduce((acc, x, i, all) => (x.startsWith("--") ? acc.concat([[x.slice(2), all[i + 1]]]) : acc), []));
const VIZ = A.viz && resolve(A.viz), SHOTS = A.shots && resolve(A.shots), NB = +(A.bench || 60);
let PORT = +(A.port || process.env.TNG_TEST_PORT) || 0;
if (!VIZ || !existsSync(join(VIZ, "manifest_v2.json"))) { console.error("--viz DIR with a manifest_v2.json is required"); process.exit(2); }
if (RESERVED_PORTS.includes(PORT)) { console.error(`ports ${RESERVED_PORTS.join(" and ")} are reserved for the owner's demo`); process.exit(2); }
if (A.cdp) console.log("note: --cdp is ignored (the browser picks its own debugging port)");
const PROFILE_PARENT = A.profile || process.env.TNG_EDGE_PROFILE || undefined;      // undefined: lib/browser.mjs uses the OS temp dir
{ /* symlinks resolved (a viz dir is often a link into a library): the real path of the deepest existing ancestor */
  const real = p => { let d = resolve(p), rest = ""; while (!existsSync(d) && dirname(d) !== d) { rest = join(basename(d), rest); d = dirname(d); } return join(realpathSync(d), rest); };
  const r = PROFILE_PARENT ? relative(real(VIZ), real(PROFILE_PARENT)) : "..";
  if (r === "" || (!r.startsWith("..") && !isAbsolute(r))) { console.error("--profile / TNG_EDGE_PROFILE must not be inside the viz dir"); process.exit(2); } }
if (SHOTS) mkdirSync(SHOTS, {recursive: true});
let fails = 0; const check = (ok, msg) => { console.log(`${ok ? "ok  " : "FAIL"} ${msg}`); if (!ok) fails++; };
const sleep = ms => new Promise(r => setTimeout(r, ms));

/* ---- static server ---- */
const TYPES = {".html": "text/html; charset=utf-8", ".js": "text/javascript", ".mjs": "text/javascript", ".json": "application/json", ".webp": "image/webp",
  ".gz": "application/octet-stream", ".bin": "application/octet-stream", ".png": "image/png", ".css": "text/css", ".svg": "image/svg+xml"};
const DOCS = A.docs ? resolve(A.docs) : join(ROOT, "docs/tng50"), ix = join(DOCS, "index.html");
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
await new Promise((r, j) => { srv.once("error", j); srv.listen(PORT, "127.0.0.1", r); });
PORT = srv.address().port;
console.log(`serving ${PAGE.replace(ROOT + "/", "")} and ${VIZ} on http://127.0.0.1:${PORT}`);

/* ---- browser + CDP: the shared harness (temp profile, --remote-debugging-port=0, blocked hosted backends) ---- */
/* reducedMotion false: this test checks the thumbnail's turn, so TNG_REDUCED_MOTION is not applied here */
const P = await launch({profile: PROFILE_PARENT, edge: A.edge, width: 1440, height: 900, block: BLOCK, reducedMotion: false});
console.log(`     ${P.browser || P.proc.spawnfile} up in ${(P.startMs / 1000).toFixed(1)} s, CDP port ${P.port} (OS-chosen), temp profile ${P.profile} (removed at exit)`);
/* a crash anywhere below must not leave this headless browser, or its profile, behind */
process.on("exit", () => { try { P.proc.kill("SIGKILL"); } catch {} try { rmSync(P.profile, {recursive: true, force: true}); } catch {} });
process.on("uncaughtException", e => { console.error(e); process.exit(1); });
process.on("unhandledRejection", e => { console.error(e); process.exit(1); });
for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, () => { console.error(`${sig}: closing the browser`); process.exit(130); });
/* the browser's built-in extensions are not the page, nor is their messaging error (no page code uses chrome.runtime) */
const pageExceptions = () => P.exceptions.filter(x => !/chrome-extension:\/\/|Receiving end does not exist/.test(x));
const consoleErr = P.consoleErrors, send = P.send;
const ev = async (expr, gesture = false) => { const r = await send("Runtime.evaluate", {expression: expr, awaitPromise: true, returnByValue: true, userGesture: gesture, timeout: 120000});
  if (r.result?.exceptionDetails) throw new Error(r.result.exceptionDetails.exception?.description || JSON.stringify(r.result.exceptionDetails)); return r.result?.result?.value; };
const shot = async name => { if (!SHOTS) return; const r = await send("Page.captureScreenshot", {format: "png"}); writeFileSync(join(SHOTS, name), Buffer.from(r.result.data, "base64")); console.log("     shot " + name); };
const metrics = (w, h, mobile = false, dpr = 1) => send("Emulation.setDeviceMetricsOverride", {width: w, height: h, deviceScaleFactor: dpr, mobile});
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
    check(r.rb === true && r.species === "nH" && !/H I|HI|loading nH/.test(r.msg), `setSpecies("HI") then setSpecies("nH"): back on ${r.species}, no stale message ("${r.msg}")`); }
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
  /* ---- Phase 3: square stage, grouped control column, species menu, no dot separators ---- */
  { const L = JSON.parse(await ev(`(() => { const s = document.querySelector(".v3d-stage").getBoundingClientRect(), c = document.querySelector("#v3-ctl").getBoundingClientRect();
      const groups = [...document.querySelectorAll("#v3-ctl > section > h2")].map(h => h.textContent);
      return JSON.stringify({s: [s.width, s.height, s.left, s.right], c: [c.left, c.width], groups, vw: innerWidth, picker: !!document.querySelector("#v3-ctl #picker-root .pk, #v3-ctl #picker-root form")}); })()`));
    check(Math.abs(L.s[0] - L.s[1]) <= 1 && L.s[0] <= 0.6 * L.vw + 1 && L.s[0] >= 300 && L.c[0] >= L.s[3] - 1 && L.c[1] >= 280,
      `square stage ${L.s[0].toFixed(1)}×${L.s[1].toFixed(1)} (${(100 * L.s[0] / L.vw).toFixed(1)} % of ${L.vw}), control column beside it (left ${L.c[0].toFixed(0)} ≥ stage right ${L.s[3].toFixed(0)}, ${L.c[1].toFixed(0)} px wide)`);
    check(L.groups.join() === "Field,View,Layers,Mode,Pick ray" && L.picker, `control groups: ${L.groups.join(", ")}; picker inside the Pick ray card ${L.picker}`); }
  { const S = JSON.parse(await ev(`(() => { const R = [...document.querySelectorAll('#v3-species input[name="v3-species"]')], m = window.tngViewer3d.manifest;
      const sw = document.querySelector('#v3-species input[value="OVI"]')?.nextElementSibling?.querySelector("i");
      return JSON.stringify({keys: R.map(i => i.value), enabled: R.filter(i => !i.disabled).map(i => i.value), fields: Object.keys(m.gas.fields),
        tips: R.filter(i => i.disabled).map(i => i.closest("label").title), names: R.map(i => i.nextElementSibling.textContent),
        civ: sw ? getComputedStyle(sw).backgroundColor : null, dark: matchMedia("(prefers-color-scheme: dark)").matches}); })()`));
    const ladder = ["nH", "T", "Z", "HI", "MgII", "SiII", "CII", "SiIII", "CIII", "SiIV", "CIV", "NV", "OVI", "NeVIII", "OVII"];
    check(S.keys.join() === ladder.join() && S.enabled.slice().sort().join() === S.fields.filter(k => ladder.includes(k)).sort().join() && S.tips.every(t => /not built/.test(t)),
      `species menu: ${S.keys.length} entries in ladder order (${S.names.join(", ")}); enabled = manifest fields (${S.enabled.join(", ")}); ${S.tips.length} disabled with a tooltip`);
    check(!S.dark || S.civ === "rgb(251, 122, 60)", `O VI swatch in the registry colour (${S.dark ? "dark" : "light"}: ${S.civ})`);
    const miss = ladder.find(k => !S.fields.includes(k));
    if (miss) { const r = JSON.parse(await ev(`(async () => { const v = window.tngViewer3d, s0 = v.species; let ok, err = null; try { ok = await v.setSpecies(${JSON.stringify(miss)}); } catch (x) { err = x.message; }
        const b = document.querySelector('#v3-species input[value=${JSON.stringify(miss)}]'); b.closest("label").click(); await new Promise(r => setTimeout(r, 300));
        return JSON.stringify({ok, err, still: v.species === s0, le: v.loadError, checked: b.checked}); })()`));
      check(r.ok === false && !r.err && r.still && r.le?.key === miss && !r.checked, `setSpecies("${miss}") (no cubes yet): false, no exception, loadError "${r.le?.message}", still on the previous field, its button stays off`); }
    const sep = await ev(`(() => { const F = /[\\u00B7\\u2022\\u2027\\u22C5\\u30FB]| \\. /; const t = [document.querySelector("#v3-ctl").innerText, document.querySelector(".v3d-stage").innerText, document.querySelector(".v3d-stage canvas").getAttribute("aria-label"),
        ...[...document.querySelectorAll("#v3-ctl [title], .v3d [title], #v3-ctl [aria-label]")].flatMap(e => [e.title, e.getAttribute("aria-label") || ""])].join("\\n"); const m = t.match(F); return m ? m[0] + " in " + t.slice(Math.max(0, m.index - 40), m.index + 40) : ""; })()`);
    check(sep === "", `no dot separators in the viewer's text, titles and labels${sep ? ": " + sep : ""}`); }
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
  await sleep(2200);   // a native request headless Edge refuses falls back to the CSS fullscreen after 1.5 s
  const fs = JSON.parse(await ev(`JSON.stringify({native: document.fullscreenElement === document.querySelector(".v3d"), fallback: document.querySelector(".v3d").classList.contains("v3d-fs"),
    stage: [document.querySelector(".v3d-stage").clientWidth, document.querySelector(".v3d-stage").clientHeight], vw: innerWidth, vh: innerHeight,
    label: document.querySelector("#v3-fs").textContent, pressed: document.querySelector("#v3-fs").getAttribute("aria-pressed"), panel: !document.querySelector("#v3-ctl").hidden,
    onStage: document.querySelector(".v3d").contains(document.querySelector("#v3-ctl")), exitBtn: document.querySelector("#v3-fs-exit").getClientRects().length > 0,
    focus: document.activeElement === window.tngViewer3d.canvas})`));
  check((fs.native || fs.fallback) && fs.stage[0] === fs.vw && fs.stage[1] === fs.vh && fs.label === "Exit fullscreen" && fs.pressed === "true" && fs.focus && fs.onStage && !fs.panel && fs.exitBtn,
    `fullscreen (${fs.native ? "native" : fs.fallback ? "CSS fallback" : "none"}): stage ${fs.stage.join("×")} = viewport ${fs.vw}×${fs.vh}, label "${fs.label}", controls moved onto the stage ${fs.onStage} (panel ${fs.panel ? "open" : "closed"}), exit button shown ${fs.exitBtn}, focus on canvas ${fs.focus}`);
  await shot("09_fullscreen.png");
  await send("Input.dispatchKeyEvent", {type: "rawKeyDown", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27});
  await send("Input.dispatchKeyEvent", {type: "keyUp", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27});
  await sleep(800);
  let out = JSON.parse(await ev(`JSON.stringify({fs: !!document.fullscreenElement || document.querySelector(".v3d").classList.contains("v3d-fs"), w: document.querySelector(".v3d-stage").getBoundingClientRect().width, h: document.querySelector(".v3d-stage").getBoundingClientRect().height, label: document.querySelector("#v3-fs").textContent})`));
  if (out.fs) { console.log("     note: headless Esc did not leave native fullscreen; calling toggleFullscreen(false) (the Esc path is the browser's own)"); await ev(`window.tngViewer3d.toggleFullscreen(false)`); await sleep(600);
    out = JSON.parse(await ev(`JSON.stringify({fs: !!document.fullscreenElement || document.querySelector(".v3d").classList.contains("v3d-fs"), w: document.querySelector(".v3d-stage").getBoundingClientRect().width, h: document.querySelector(".v3d-stage").getBoundingClientRect().height, label: document.querySelector("#v3-fs").textContent})`)); }
  const back = await ev(`(() => { const c = document.querySelector("#v3-ctl"); return !document.querySelector(".v3d").contains(c) && !c.hidden && !!c.closest("[data-testid=v3d-controls]"); })()`);
  check(!out.fs && Math.abs(out.w - before[0]) < 1 && Math.abs(out.h - before[1]) < 1 && out.label === "Fullscreen" && back, `fullscreen exit restores the layout: stage ${out.w}×${out.h} (was ${before[0]}×${before[1]}), control column back beside the stage ${back}`);
  /* CSS fallback path: force it by hiding the API */
  await ev(`(() => { const e = document.querySelector(".v3d"); e.requestFullscreen = undefined; e.webkitRequestFullscreen = undefined; return window.tngViewer3d.toggleFullscreen(true); })()`); await sleep(500);
  const fb = JSON.parse(await ev(`JSON.stringify({on: document.querySelector(".v3d").classList.contains("v3d-fs"), body: document.body.classList.contains("v3d-noscroll"), w: document.querySelector(".v3d-stage").clientWidth, vw: innerWidth})`));
  await send("Input.dispatchKeyEvent", {type: "rawKeyDown", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27}); await send("Input.dispatchKeyEvent", {type: "keyUp", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27}); await sleep(500);
  const fb2 = JSON.parse(await ev(`JSON.stringify({on: document.querySelector(".v3d").classList.contains("v3d-fs"), body: document.body.classList.contains("v3d-noscroll"), w: document.querySelector(".v3d-stage").getBoundingClientRect().width})`));
  await ev(`(() => { const e = document.querySelector(".v3d"); delete e.requestFullscreen; delete e.webkitRequestFullscreen; })()`);
  check(fb.on && fb.body && fb.w === fb.vw && !fb2.on && !fb2.body && Math.abs(fb2.w - before[0]) < 1, `CSS fallback fullscreen: on (stage ${fb.w} = ${fb.vw}), Esc → off, layout restored (${fb2.w})`);
  /* ---- Phase 3 thumbnail (pages with a #v3d-mini-host, e.g. the scratch harness) ---- */
  const hasThumb = await ev(`!!document.querySelector("#v3d-mini-host")`);
  if (hasThumb) {
    /* the page stops the turn under prefers-reduced-motion (viewer3d.js spinning()); then the thumbnail must stay still */
    const RM = await ev(`matchMedia("(prefers-reduced-motion: reduce)").matches`);
    if (RM) console.log("     note: prefers-reduced-motion is on: checking that the thumbnail stays still (run without TNG_REDUCED_MOTION or the wrapper to check the turn)");
    const V = "window.tngViewer3d";
    await ev(`${V}.setMode("integral"); ${V}.setStars({on: true, gasMix: 0.85}); ${V}.setSpecies("nH")`); await allBound();
    for (let i = 0; i < 80 && !(await ev(`!!window.tngThumb`)); i++) await sleep(250);
    const pre = JSON.parse(await ev(`JSON.stringify({p: ${V}.camera.position.toArray(), n: (${V}.stats.loads || []).length, same: window.tngThumb?.viewer === ${V}})`));
    await ev(`tngApp.showTab("spectra")`); await sleep(1500);
    const th = JSON.parse(await ev(`(async () => { const v = ${V}, h = document.querySelector("#v3d-mini-host"), r = h.getBoundingClientRect(), p0 = v.camera.position.clone();
      await new Promise(r => setTimeout(r, 1000)); return JSON.stringify({docked: v.docked, inHost: h.contains(v.canvas), host: [r.width, r.height], n: (v.stats.loads || []).length,
        moved: v.camera.position.distanceTo(p0), frameMs: v.stats.thumbFrameMs, levels: v.levels(), tag: h.querySelector(".v3d-tt .f")?.textContent, active: window.tngThumb.active}); })()`));
    check(pre.same && th.docked === "thumb" && th.inHost && th.active && Math.abs(th.host[0] - th.host[1]) <= 1 && th.n === pre.n,
      `thumbnail: one engine (${pre.same}), docked "${th.docked}" in the square host ${th.host.map(x => x.toFixed(0)).join("×")}, tag "${th.tag}", no new cube loads (${pre.n} → ${th.n})`);
    if (RM) check(th.moved === 0, `reduced motion: the thumbnail stays still on screen (camera moved ${th.moved} kpc in 1 s)`);
    else check(th.moved > 0.5 && th.frameMs < 50, `thumbnail turns while on screen (camera moved ${th.moved.toFixed(1)} kpc in 1 s, frame ${th.frameMs?.toFixed(1)} ms submit)`);
    const tb = await nonBlank(); check(tb.frac > 0.05, `thumbnail not blank: ${(100 * tb.frac).toFixed(1)} % lit pixels`);
    await shot("16_thumb_spectra.png");
    const pz = JSON.parse(await ev(`(async () => { const v = ${V}, m = document.querySelector("#v3d-mini"); m.style.display = "none"; await new Promise(r => setTimeout(r, 700));
      const a = v.camera.position.clone(); await new Promise(r => setTimeout(r, 900)); const still = v.camera.position.distanceTo(a); m.style.display = "";
      await new Promise(r => setTimeout(r, 900)); const b = v.camera.position.clone(); await new Promise(r => setTimeout(r, 600)); return JSON.stringify({still, again: v.camera.position.distanceTo(b)}); })()`));
    if (RM) check(pz.still === 0 && pz.again === 0, `reduced motion: still while hidden (${pz.still} kpc) and after it is shown again (${pz.again} kpc)`);
    else check(pz.still === 0 && pz.again > 0.2, `thumbnail pauses off-screen (moved ${pz.still} kpc while hidden) and resumes (${pz.again.toFixed(2)} kpc)`);
    const tbench = await ev(`${V}.bench(20)`);
    console.log(`     thumbnail bench: exact ${tbench.exact_ms_median.toFixed(1)} ms at ${tbench.size.join("×")} px (spv 0.6), moving exact ${tbench.moving_exact_ms_median.toFixed(1)} ms`);
    check(tbench.exact_ms_median <= 60, `thumbnail frame ${tbench.exact_ms_median.toFixed(1)} ms ≤ 60 ms at ${tbench.size.join("×")} px`);
    const hp = JSON.parse(await ev(`(() => { const r = document.querySelector("#v3d-mini").getBoundingClientRect(); return JSON.stringify([r.x + r.width / 2, r.y + r.height / 2]); })()`));
    for (const type of ["mouseMoved", "mousePressed", "mouseReleased"]) await send("Input.dispatchMouseEvent", {type, x: hp[0], y: hp[1], button: "left", buttons: type === "mousePressed" ? 1 : 0, clickCount: 1});
    await sleep(1500);
    const bk = JSON.parse(await ev(`JSON.stringify({tab: document.body.dataset.tab, docked: ${V}.docked, d: ${V}.camera.position.distanceTo(new ${V}.THREE.Vector3(...${JSON.stringify(pre.p)})),
      inStage: document.querySelector("#v3d-stage").contains(${V}.canvas), ctl: ${V}.controls.enabled, tab3: ${V}.canvas.tabIndex})`));
    check(bk.tab === "3d" && bk.docked === "full" && bk.inStage && bk.d < 1e-3 && bk.ctl && bk.tab3 === 0, `thumbnail click opens the 3D tab: docked "${bk.docked}" on the stage, camera restored (Δ ${bk.d.toExponential(1)} kpc), orbit on`);
    /* thumbnail first, cold: only the field's L0 / L1 load for it; the full stage then reuses the engine */
    await ev(`caches.delete("tng50-viz-v2")`);
    const URLS = URL3D.replace("#tab=3d", "#tab=spectra"), tc = Date.now();
    await send("Page.navigate", {url: "about:blank"}); await sleep(300); await send("Page.navigate", {url: URLS});
    let ok = false; for (let i = 0; i < 1200 && !ok; i++) { await sleep(250); ok = await ev(`!!window.tngThumb?.viewer?.species`).catch(() => false); }
    await sleep(1500);
    const cold = JSON.parse(await ev(`JSON.stringify({docked: tngThumb.viewer.docked, levels: tngThumb.viewer.levels(), loads: (tngThumb.viewer.stats.loads || []).map(l => l.key), full: !!window.tngViewer3d})`));
    check(ok && cold.docked === "thumb" && !cold.full && cold.loads.every(k => /^gas\|nH\|L[01]$/.test(k)) && !Object.values(cold.levels.stars).includes("bound") && cold.levels.gas.L2 !== "bound",
      `thumbnail-first cold load (${((Date.now() - tc) / 1000).toFixed(1)} s): loads ${cold.loads.join(", ")}; stars ${JSON.stringify(cold.levels.stars)}; L2 ${cold.levels.gas.L2}`);
    await shot("17_thumb_cold.png");
    await ev(`tngApp.showTab("3d")`); await waitViewer();
    for (let i = 0; i < 480 && (await ev(`tngViewer3d.levels().stars.S1`)) !== "bound"; i++) await sleep(250); await allBound(); await sleep(500);
    const fu = JSON.parse(await ev(`JSON.stringify({same: window.tngViewer3d === tngThumb.viewer, docked: tngViewer3d.docked, stars: tngViewer3d.levels().stars,
      stage: [document.querySelector(".v3d-stage").clientWidth, document.querySelector(".v3d-stage").clientHeight]})`));
    check(fu.same && fu.docked === "full" && Math.abs(fu.stage[0] - fu.stage[1]) <= 1 && fu.stars.S1 === "bound", `then the 3D tab: same engine ${fu.same}, docked "${fu.docked}", square stage ${fu.stage.join("×")}, stars S1 ${fu.stars.S1}`);
    await shot("18_full_after_thumb.png");
  }
  /* mobile */
  await metrics(390, 844, true, 2); await send("Emulation.setTouchEmulationEnabled", {enabled: true, maxTouchPoints: 5});
  await send("Page.navigate", {url: "about:blank"}); await sleep(300); await send("Page.navigate", {url: URL3D}); const sm = await waitViewer();
  await allBound(); await sleep(800);
  const mob = JSON.parse(await ev(`JSON.stringify({vw: innerWidth, sw: document.documentElement.scrollWidth, stage: [document.querySelector(".v3d-stage").clientWidth, document.querySelector(".v3d-stage").clientHeight],
    stars: window.tngViewer3d.levels().stars, gas: window.tngViewer3d.levels().gas, ctl: (() => { const s = document.querySelector(".v3d-stage").getBoundingClientRect(), c = document.querySelector("#v3-ctl").getBoundingClientRect();
      return {below: c.top >= s.bottom - 1, w: Math.round(c.width)}; })()})`));
  check(sm === "ready" && mob.vw === 390 && mob.sw <= mob.vw && Math.abs(mob.stage[0] - mob.stage[1]) <= 1 && mob.stage[0] >= 0.75 * mob.vw && mob.stage[0] <= mob.vw && mob.ctl.below && !Object.values(mob.stars).includes("bound") && mob.gas.L2 !== "bound",
    `mobile 390×844: innerWidth ${mob.vw}, scrollWidth ${mob.sw}, square stage ${mob.stage.join("×")}, controls below it (${mob.ctl.w} px wide), stars off, L2 ${mob.gas.L2}`);
  await shot("11_mobile_3d.png");
  if (SHOTS) { await ev(`window.scrollTo(0, document.querySelector("#v3-ctl").getBoundingClientRect().top + scrollY - 200)`); await sleep(400); await shot("11b_mobile_controls.png"); }
  await send("Emulation.setTouchEmulationEnabled", {enabled: false}); await metrics(1280, 800);
  /* host blocked: the message, and the Spectra tab still works */
  blockViz = true; await send("Network.enable"); await send("Network.setCacheDisabled", {cacheDisabled: true});
  await ev(`caches.delete("tng50-viz-v2")`);
  await send("Page.navigate", {url: "about:blank"}); await sleep(300); await send("Page.navigate", {url: URL3D});
  for (let i = 0; i < 480; i++) { await sleep(500); if (await ev(`/unreachable|not available/.test(document.querySelector(".v3d-msg")?.textContent || "")`).catch(() => false)) break; }
  const hb = JSON.parse(await ev(`JSON.stringify({msg: document.querySelector(".v3d-msg")?.textContent || "", root: document.querySelector("#v3d-root")?.textContent.slice(0, 200)})`));
  await shot("13_host_blocked.png");
  await ev(`tngApp.showTab("spectra")`); await sleep(800);
  const sp = await ev(`(() => { const s = document.querySelector("#statusline"); return (s?.dataset.id || "") + "|" + (s?.textContent || ""); })()`);
  check(/is unreachable\. Sightlines, ray picking and the spectra still work/.test(hb.msg) && (/^[a-z]\w+\|/.test(sp) || /\|.*log N/.test(sp)), `host blocked: "${hb.msg.slice(0, 140)}"; spectra statusline data-id "${sp.split("|")[0]}" (or the v2 page's "log N" text)`);
  blockViz = false;
  /* fix-ui FE-01: a host that accepts the connection and never answers -> the unreachable message within the stall timeout */
  await ev(`caches.delete("tng50-viz-v2")`);
  const URLH = `http://127.0.0.1:${PORT}/tng50/?viz=${encodeURIComponent(`http://127.0.0.1:${PORT}/hang/`)}#tab=3d`, th = Date.now();
  await send("Page.navigate", {url: "about:blank"}); await sleep(300); await send("Page.navigate", {url: URLH});
  /* timed from the first "loading" message (the page load itself takes 5-60 s on a loaded machine); the stall timeout is 20 s */
  let hm = "", tl = 0; for (let i = 0; i < 360; i++) { await sleep(500); hm = await ev(`document.querySelector(".v3d-msg")?.textContent || ""`).catch(() => ""); if (!tl && /loading/.test(hm)) tl = Date.now(); if (/unreachable/.test(hm)) break; }
  const dth = (Date.now() - (tl || th)) / 1000;
  check(/is unreachable/.test(hm) && dth < 45 && !hangSeen.some(u => u.endsWith(".gz")), `hanging host: "${hm.slice(0, 110)}" ${dth.toFixed(1)} s after the first loading message, ${hangSeen.length} held requests, no .gz behind them`);
  await shot("15_host_hang.png");
  for (const r of held.splice(0)) r.destroy();
}
const exceptions = pageExceptions();
check(exceptions.length === 0, `no page exceptions${exceptions.length ? ": " + exceptions.join(" | ") : ""}`);
if (consoleErr.length) console.log("     console errors: " + consoleErr.slice(0, 5).join(" | "));
await P.close(); srv.closeAllConnections?.(); srv.close();
console.log(fails ? `\n${fails} check(s) FAILED` : "\nall checks passed");
process.exit(fails ? 1 : 0);
