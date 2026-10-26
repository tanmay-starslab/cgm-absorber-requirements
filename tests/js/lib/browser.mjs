// Shared headless-Edge harness for the Phase-3 page tests (page_smoke.mjs, ui_budget.mjs, ui_static.mjs).
// Not a test itself: run_all.mjs only runs the *.mjs files directly in tests/js, never this lib/ folder.
// It serves the page from a directory on 127.0.0.1 (port 0 = OS-chosen unless --port is given), launches Edge
// headless with --remote-debugging-port=0 (the port is read back from DevToolsActivePort, never fixed), and drives it
// over CDP: evaluate, viewport, colour scheme, keys, mouse, screenshots. An init script installed before any page
// script records every tng:* window event and every canvas fillText/strokeText string (window.__tng).
//
// Environment:
//   TNG_EDGE            the browser binary (any Chromium: Edge, Chrome, Chromium, chrome-headless-shell). Unset: findBrowser()
//                       picks one per platform (macOS: Microsoft Edge, then Google Chrome; Linux: the first of
//                       microsoft-edge, google-chrome, chromium, chromium-browser, chrome-headless-shell on PATH).
//   TNG_EDGE_PROFILE    the parent dir of the fresh temp profile (default the OS temp dir); removed by close().
//   TNG_REDUCED_MOTION  "1" adds --force-prefers-reduced-motion (opt-in, off by default). On a machine without a GPU
//                       (e.g. a Linux cluster node) WebGL is rendered in software, and the 3D thumbnail's continuous spin
//                       then saturates the browser's GPU process and starves the page, so page tests time out. With
//                       reduced motion the page stops the spin (viewer3d.js spinning()). Do not set it for
//                       viewer_browser.mjs, which checks the spin itself (launch({reducedMotion: false}) forces it off).
//   TNG_TEST_PORT       a fixed static-server port (default 0, OS-chosen).
import {createServer, request as httpRequest} from "node:http";
import {readFileSync, existsSync, statSync, mkdirSync, rmSync, readdirSync, accessSync, constants as FS} from "node:fs";
import {spawn} from "node:child_process";
import {join, extname, resolve, dirname, delimiter} from "node:path";
import {tmpdir, homedir} from "node:os";
import {fileURLToPath} from "node:url";

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
export const sleep = ms => new Promise(r => setTimeout(r, ms));
export const RESERVED_PORTS = [8787, 8000];
/** Requests every test blocks: the owner's laptop server and the hosted backends/cubes (tests never depend on them).
 *  *.sslip.io is the public VM backend a docs/tng50 export lists, so a test of the repo page never probes it. */
export const BLOCK = ["*://127.0.0.1:8787/*", "*://localhost:8787/*", "*.hf.space/*", "*.sslip.io/*", "*://huggingface.co/*", "*://*.huggingface.co/*"];

/** argv -> {pos: [...positional], opt: {flag: value|true}} ("--flag value" or a bare "--flag"). */
export function parseArgs(argv) {
  const pos = [], opt = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) { const nx = argv[i + 1]; if (nx === undefined || nx.startsWith("--")) opt[a.slice(2)] = true; else { opt[a.slice(2)] = nx; i++; } }
    else pos.push(a);
  }
  return {pos, opt};
}

/** A check counter that prints "ok"/"FAIL" lines like the other tests in tests/js. */
export function checker() {
  const c = {fails: 0, n: 0, failed: [],
    check(ok, msg) { c.n++; console.log(`${ok ? "ok  " : "FAIL"} ${msg}`); if (!ok) { c.fails++; c.failed.push(msg); } return !!ok; },
    note(msg) { console.log("     " + msg); },
    finish() { console.log(c.fails ? `\n${c.fails} of ${c.n} check(s) FAILED` : `\nall ${c.n} checks passed`); return c.fails ? 1 : 0; }};
  return c;
}

/** The ion registry (tngsight/ions.json): the truth the page is checked against. */
export function loadRegistry() {
  const R = JSON.parse(readFileSync(join(ROOT, "tngsight/ions.json"), "utf8"));
  return {ions: R.ions.map(i => ({key: i.key, label: i.label, band: i.band, ion: i.ion})), bands: R.bands, snr: R.snr, defaults: R.defaults};
}

/* ---------------------------------------------------------------- forbidden separators (brief C12, design 6.2) */
export const SEP_CHARS = ["·", "•", "‧", "⋅", "・"];
/** Every forbidden separator in s: [{what, index}]; " . " (a full stop with whitespace on each side) counts too, and so does a
 *  piece that is only a full stop plus whitespace (" .", ". "), as used by join(). */
export function sepHits(s) {
  const out = []; s = String(s);
  for (const c of SEP_CHARS) { let i = -1; while ((i = s.indexOf(c, i + 1)) >= 0) out.push({what: "U+" + c.codePointAt(0).toString(16).toUpperCase().padStart(4, "0"), index: i}); }
  const re = /\s\.\s/g; let m; while ((m = re.exec(s))) { out.push({what: '" . "', index: m.index}); re.lastIndex = m.index + 1; }
  if (s !== "." && s.trim() === "." ) out.push({what: '" . "', index: s.indexOf(".")});   // a lone " ." or ". " piece (a join separator)
  return out;
}

/* ---------------------------------------------------------------- static server */
const TYPES = {".html": "text/html; charset=utf-8", ".js": "text/javascript", ".mjs": "text/javascript", ".json": "application/json",
  ".css": "text/css", ".webp": "image/webp", ".png": "image/png", ".jpg": "image/jpeg", ".svg": "image/svg+xml",
  ".gz": "application/octet-stream", ".bin": "application/octet-stream", ".wasm": "application/wasm"};
/** Serve `page` at /tng50/ and /tng50/index.html, the files of `dir` under /tng50/ and, with `viz`, a local cube dir
 *  under /viz/. With `apiUds` (a sightline server listening on a unix socket, e.g. uvicorn --uds with the FakeGenerator)
 *  every /api/ request is proxied to it, so the backend shares this one port and origin (no second port, no CORS entry).
 *  Returns {port, base, origin, query, close}; `query` is "?viz=<local viz URL>" when viz is given, else "". */
export async function serve({dir, page, port, viz, apiUds}) {
  port = +(port || process.env.TNG_TEST_PORT) || 0;   // TNG_TEST_PORT: a fixed port when the environment assigns one
  if (RESERVED_PORTS.includes(port)) throw new Error(`port ${port} is reserved for the owner's demo`);
  dir = resolve(dir); page = resolve(page); viz = viz ? resolve(viz) : null;
  const MEM = new Map(), read = f => { const st = statSync(f); if (st.size > 4e6) return readFileSync(f);   // cache the small files only
    const k = f + "|" + st.mtimeMs; if (!MEM.has(k)) MEM.set(k, readFileSync(f)); return MEM.get(k); };
  const handler = (req, res) => {
    const p = decodeURIComponent(new URL(req.url, "http://x").pathname);
    if (apiUds && p.startsWith("/api/")) {     // streamed both ways, so SSE progress passes through unbuffered
      const up = httpRequest({socketPath: apiUds, path: req.url, method: req.method, headers: req.headers}, r => { res.writeHead(r.statusCode, r.headers); r.pipe(res); });
      up.on("error", e => { if (!res.headersSent) res.writeHead(502); res.end(String(e.message)); }); req.pipe(up); return; }
    let f = null;
    if (p === "/tng50/" || p === "/tng50/index.html") f = page;
    else if (p.startsWith("/tng50/")) f = resolve(join(dir, p.slice(7)));
    else if (viz && p.startsWith("/viz/")) f = resolve(join(viz, p.slice(5)));
    if (!f || (f !== page && !f.startsWith(dir + "/") && !(viz && f.startsWith(viz + "/"))) || !existsSync(f) || statSync(f).isDirectory()) { res.writeHead(404); res.end("not found"); return; }
    res.writeHead(200, {"Content-Type": TYPES[extname(f)] || "application/octet-stream", "Cache-Control": "no-store", "Access-Control-Allow-Origin": "*"});
    res.end(read(f));
  };
  let srv;
  for (let k = 0; ; k++) {   // a fixed port may be held by another run of these tests: wait for it (up to 15 min)
    srv = createServer(handler);
    try { await new Promise((r, j) => { srv.once("error", j); srv.listen(port, "127.0.0.1", r); }); break; }
    catch (x) { srv.close(); if (x.code !== "EADDRINUSE" || !port || k >= 450) throw x; if (k === 0) console.log(`port ${port} busy; waiting for it`); await sleep(2000); }
  }
  const got = srv.address().port;
  return {port: got, base: `http://127.0.0.1:${got}/tng50/`, origin: `http://127.0.0.1:${got}`, query: viz ? `?viz=${encodeURIComponent(`http://127.0.0.1:${got}/viz/`)}` : "",
    close: () => new Promise(r => { srv.closeAllConnections?.(); srv.close(r); })};
}

/* ---------------------------------------------------------------- init script (runs before any page script) */
export const INIT_SCRIPT = `(() => {
  if (window.__tng) return;
  const T = window.__tng = {events: [], text: [], textSet: new Set(), t0: performance.now()};
  const rec = s => { s = String(s); if (!T.textSet.has(s)) { T.textSet.add(s); if (T.text.length < 20000) T.text.push(s); } };
  T.clearText = () => { T.text.length = 0; T.textSet.clear(); };
  for (const P of [window.CanvasRenderingContext2D, window.OffscreenCanvasRenderingContext2D]) {
    if (!P) continue; const pr = P.prototype;
    for (const fn of ["fillText", "strokeText"]) { const o = pr[fn]; pr[fn] = function (s, ...a) { rec(s); return o.call(this, s, ...a); }; }
  }
  const keep = ev => { let d = null; try { d = JSON.parse(JSON.stringify(ev.detail ?? null)); } catch (e) {} T.events.push({type: ev.type, t: performance.now(), detail: d}); };
  for (const t of ["ready", "instrument", "fit", "select", "catalog", "submitted", "job", "done", "error"]) window.addEventListener("tng:" + t, keep, true);
})();`;

/* ---------------------------------------------------------------- browser binary */
/** Browser candidates per platform when TNG_EDGE is unset: absolute app paths on macOS, command names on PATH on Linux. */
export const BROWSERS = {
  darwin: ["Microsoft Edge.app/Contents/MacOS/Microsoft Edge", "Google Chrome.app/Contents/MacOS/Google Chrome"],
  linux: ["microsoft-edge", "google-chrome", "chromium", "chromium-browser", "chrome-headless-shell"],
};
const isExec = f => { try { return statSync(f).isFile() && (accessSync(f, FS.X_OK), true); } catch { return false; } };
/**
 * The browser binary: env.TNG_EDGE when set, else the first installed candidate of BROWSERS[platform] (macOS: in
 * /Applications, then ~/Applications; Linux: the first name found in a PATH directory, in the order listed). Throws an
 * Error naming TNG_EDGE when none is found. The arguments exist for tests (a fake env, platform or file check).
 */
export function findBrowser({env = process.env, platform = process.platform, exec = isExec, home = homedir()} = {}) {
  if (env.TNG_EDGE) return env.TNG_EDGE;
  let tried = [];
  if (platform === "darwin") {
    tried = BROWSERS.darwin.flatMap(app => ["/Applications", join(home, "Applications")].map(d => join(d, app)));
  } else if (platform === "linux") {
    const dirs = String(env.PATH || "").split(delimiter).filter(Boolean);
    tried = BROWSERS.linux.flatMap(name => dirs.map(d => join(d, name)));
  }
  const hit = tried.find(f => exec(f));
  if (hit) return hit;
  const want = platform === "darwin" ? "Microsoft Edge or Google Chrome in /Applications"
    : platform === "linux" ? `one of ${BROWSERS.linux.join(", ")} on PATH` : `a Chromium browser (no default for ${platform})`;
  throw new Error(`no headless browser found (looked for ${want}): set TNG_EDGE to the path of a Chromium-based browser binary`);
}

/** A desktop mouse for (hover: hover) and (pointer: fine). A headless browser on a machine with no input device (a
 *  cluster node) reports hover: none and pointer: none, so hover-only page behaviour (the info popovers open on hover
 *  only when (hover: hover) matches) cannot be tested there; the Mac's headless Edge already reports a mouse. */
export const HOVER_FLAG = "--blink-settings=primaryHoverType=2,availableHoverTypes=2,primaryPointerType=4,availablePointerTypes=4";
/** The command-line flags of a headless launch (reducedMotion: TNG_REDUCED_MOTION=1 unless given; hover: true adds
 *  HOVER_FLAG). */
export function browserArgs({profile, width = 1440, height = 900, reducedMotion, hover = false} = {}, env = process.env) {
  const rm = reducedMotion ?? env.TNG_REDUCED_MOTION === "1";
  return ["--headless=new", "--remote-debugging-port=0", `--user-data-dir=${profile}`, "--no-first-run", "--no-default-browser-check",
    "--disable-component-update", "--disable-background-networking", "--no-proxy-server", "--hide-scrollbars", "--mute-audio",
    "--disable-features=msSmartScreenProtection,msEdgeEnhancedSecurityMode,msEnhancedSecurityMode",
    ...(rm ? ["--force-prefers-reduced-motion"] : []), ...(hover ? [HOVER_FLAG] : []), `--window-size=${width},${height}`, "about:blank"];
}

/* ---------------------------------------------------------------- Edge + CDP */
const KEYS = {ArrowLeft: 37, ArrowRight: 39, ArrowUp: 38, ArrowDown: 40, Home: 36, End: 35, Enter: 13, Escape: 27, Tab: 9, "+": 187, "=": 187, "-": 189};
/**
 * Launch the headless browser (opts.edge, else findBrowser(): TNG_EDGE or a per-platform default) and attach to its
 * first page. opts: {profile, edge, width, height, block: [url patterns], inject: [js source], reducedMotion, hover}.
 * Returns a page object (see the methods below); P.browser is the binary. Call close() at the end (kills only this browser).
 */
export async function launch(opts = {}) {
  const EDGE = opts.edge || findBrowser();
  const profile = resolve(opts.profile || process.env.TNG_EDGE_PROFILE || join(tmpdir(), `tng-edge-${process.pid}`)) + `/edge-${process.pid}-${Date.now()}`;
  mkdirSync(profile, {recursive: true});
  const W = opts.width || 1440, H = opts.height || 900;
  const proc = spawn(EDGE, browserArgs({profile, width: W, height: H, reducedMotion: opts.reducedMotion, hover: !!opts.hover}), {stdio: "ignore"});
  let spawnErr = null; proc.on("error", e => { spawnErr = e; });     // e.g. ENOENT: report it instead of crashing the test
  let port = null; const tStart = Date.now();
  for (let i = 0; i < 1200 && !port && !spawnErr; i++) { await sleep(150); try { port = +readFileSync(join(profile, "DevToolsActivePort"), "utf8").split("\n")[0] || null; } catch {} }
  if (spawnErr) { try { rmSync(profile, {recursive: true, force: true}); } catch {}
    throw new Error(`could not start the browser ${EDGE}: ${spawnErr.message} (set TNG_EDGE to a Chromium-based browser binary)`); }
  if (!port) { proc.kill("SIGKILL"); throw new Error(`the browser (${EDGE}) did not write DevToolsActivePort within 180 s`); }
  let tabs = null; for (let i = 0; i < 200 && !tabs; i++) { try { tabs = (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()).filter(t => t.type === "page"); if (!tabs.length) tabs = null; } catch {} if (!tabs) await sleep(150); }
  if (!tabs) { proc.kill("SIGKILL"); throw new Error("no CDP page target"); }
  const ws = new WebSocket(tabs[0].webSocketDebuggerUrl); await new Promise((r, j) => { ws.addEventListener("open", r); ws.addEventListener("error", j); });
  let id = 0; const pend = new Map(), listeners = [];
  const P = {proc, port, profile, browser: EDGE, startMs: Date.now() - tStart, exceptions: [], consoleErrors: [], requests: [], W, H, mobile: false};
  ws.addEventListener("message", ev => { const m = JSON.parse(ev.data);
    if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); return; }
    if (m.method === "Runtime.exceptionThrown") P.exceptions.push((m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text || "").slice(0, 400));
    if (m.method === "Runtime.consoleAPICalled" && m.params.type === "error") P.consoleErrors.push(m.params.args.map(a => a.value ?? a.description).join(" ").slice(0, 300));
    if (m.method === "Network.requestWillBeSent") P.requests.push((m.params.request.method || "GET") + " " + m.params.request.url);
    for (const f of listeners) f(m); });
  P.send = (method, params = {}) => new Promise(r => { const i = ++id; pend.set(i, r); ws.send(JSON.stringify({id: i, method, params})); });
  await P.send("Runtime.enable"); await P.send("Page.enable"); await P.send("Network.enable");
  if (opts.block?.length) await P.send("Network.setBlockedURLs", {urls: opts.block});
  await P.send("Page.addScriptToEvaluateOnNewDocument", {source: INIT_SCRIPT});
  for (const src of opts.inject || []) await P.send("Page.addScriptToEvaluateOnNewDocument", {source: src});
  /** Evaluate an expression (awaited, returned by value). Throws with the page's message on an exception. */
  P.eval = async (expr, timeout = 60000) => {
    const r = await P.send("Runtime.evaluate", {expression: expr, awaitPromise: true, returnByValue: true, timeout, userGesture: true});
    if (r.error) throw new Error("CDP: " + r.error.message);
    if (r.result.exceptionDetails) throw new Error("page: " + (r.result.exceptionDetails.exception?.description || r.result.exceptionDetails.text).split("\n")[0]);
    return r.result.result.value;
  };
  /** Evaluate an async function body: P.fn("return 1") -> 1. */
  P.fn = (body, timeout) => P.eval(`(async () => { ${body} })()`, timeout);
  /** Poll a boolean expression until true; returns the elapsed ms, or -1 on timeout. */
  P.waitFor = async (expr, ms = 30000, every = 100) => { const t = Date.now(); while (Date.now() - t < ms) { try { if (await P.eval(`!!(${expr})`)) return Date.now() - t; } catch {} await sleep(every); } return -1; };
  P.viewport = async (w, h, mobile = false) => { Object.assign(P, {W: w, H: h, mobile});
    await P.send("Emulation.setDeviceMetricsOverride", {width: w, height: h, deviceScaleFactor: 1, mobile});
    await P.send("Emulation.setTouchEmulationEnabled", {enabled: mobile, maxTouchPoints: mobile ? 5 : 0}); };
  P.scheme = dark => P.send("Emulation.setEmulatedMedia", {features: [{name: "prefers-color-scheme", value: dark ? "dark" : "light"}]});
  P.goto = async url => { await P.send("Page.navigate", {url: "about:blank"}); await sleep(100); await P.send("Page.navigate", {url}); };
  P.key = async (key, {shift = false, ctrl = false} = {}) => { const modifiers = (shift ? 8 : 0) | (ctrl ? 2 : 0), code = KEYS[key] || key.toUpperCase().charCodeAt(0);
    const text = key.length === 1 ? key : undefined;
    await P.send("Input.dispatchKeyEvent", {type: text ? "keyDown" : "rawKeyDown", key, code: key.length === 1 ? undefined : key, windowsVirtualKeyCode: code, modifiers, text});
    await P.send("Input.dispatchKeyEvent", {type: "keyUp", key, code: key.length === 1 ? undefined : key, windowsVirtualKeyCode: code, modifiers}); };
  P.mouse = (type, x, y, extra = {}) => P.send("Input.dispatchMouseEvent", {type, x, y, button: "left", buttons: type === "mousePressed" || extra.held ? 1 : 0, clickCount: 1, ...extra});
  P.hover = (x, y) => P.mouse("mouseMoved", x, y);
  P.drag = async (x0, y0, x1, y1, steps = 8) => { await P.mouse("mouseMoved", x0, y0); await P.mouse("mousePressed", x0, y0);
    for (let i = 1; i <= steps; i++) { await P.mouse("mouseMoved", x0 + (x1 - x0) * i / steps, y0 + (y1 - y0) * i / steps, {held: true}); await sleep(16); }
    await P.mouse("mouseReleased", x1, y1); };
  P.wheel = (x, y, deltaY, ctrl = true) => P.send("Input.dispatchMouseEvent", {type: "mouseWheel", x, y, deltaX: 0, deltaY, modifiers: ctrl ? 2 : 0});
  /** Click the centre of the element matched by a CSS selector with a real (CDP) mouse event; returns false if not visible. */
  P.click = async sel => { const c = await P.eval(`(() => { const e = document.querySelector(${JSON.stringify(sel)}); if (!e) return null; e.scrollIntoView({block: "nearest", inline: "nearest"});
      const r = e.getBoundingClientRect(); return r.width && r.height ? [r.left + r.width / 2, r.top + r.height / 2] : null; })()`);
    if (!c) return false; await P.mouse("mouseMoved", c[0], c[1]); await P.mouse("mousePressed", c[0], c[1]); await P.mouse("mouseReleased", c[0], c[1]); return true; };
  P.shot = async file => { mkdirSync(dirname(file), {recursive: true}); const r = await P.send("Page.captureScreenshot", {format: "png"});
    const {writeFileSync} = await import("node:fs"); writeFileSync(file, Buffer.from(r.result.data, "base64")); return file; };
  P.events = (type, since = 0) => P.eval(`(window.__tng ? __tng.events : []).filter(e => e.t >= ${+since}${type ? ` && e.type === ${JSON.stringify(type)}` : ""})`);
  P.now = () => P.eval("performance.now()");
  P.close = async () => { try { ws.close(); } catch {} try { proc.kill("SIGTERM"); } catch {} await sleep(800); try { proc.kill("SIGKILL"); } catch {}
    try { rmSync(profile, {recursive: true, force: true}); } catch {} };
  return P;
}

/** The expression a page is "ready" by: the v3 bridge exists and a panel hit box is laid out (or the 3D tab is shown). */
export const READY = `window.tngApp && tngApp.version >= 3 && typeof tngApp.getState === "function" && tngApp.getState().id && (document.querySelector('[data-testid^="panel-"]') || tngApp.getState().tab === "3d")`;

/** The page file to test in a docs/tng50-like dir: --page, else an exported Phase-3 index.html, else _template.html. */
export function pickPage(dir, explicit) {
  if (explicit) return resolve(explicit);
  const ix = join(dir, "index.html");
  if (existsSync(ix) && /data-testid="spectra"/.test(readFileSync(ix, "utf8"))) return ix;
  if (existsSync(ix)) console.log("note: index.html is not a Phase-3 page (re-export it); testing _template.html");
  return join(dir, "_template.html");
}

/** Read every file of a JS source shim (e.g. --inject a.js,b.js). */
export const readInjects = list => (list ? String(list).split(",").filter(Boolean).map(f => readFileSync(resolve(f), "utf8")) : []);
export const listFiles = (d, re) => (existsSync(d) ? readdirSync(d).filter(f => re.test(f)).sort().map(f => join(d, f)) : []);

/* ---------------------------------------------------------------- in-page measurement library (installed by evaluate) */
/**
 * window.__ui after `await page.eval(UI_LIB)`:
 *   vis(el)       rendered (checkVisibility with CSS visibility and opacity) and with a non-empty box
 *   words()       design 6.2 C14: letter-bearing tokens of the visible text, excluding #statusline, #readouts,
 *                 #fitstatus, #pill, #galcount, canvas and every closed popover -> {n, list}
 *   sepScan()     C12 over every text node (visible or not), UI attributes, document.title and the captured canvas
 *                 strings -> [{where, what, text}]
 *   rect(sel)     {x, y, w, h, right, bottom} or null
 *   label(el)     the visible label text of a control (its <label>, aria-labelledby, or aria-label)
 *   textBox(el)   {w, px, text}: rendered width of el's text and its smallest font size (0 px = text hidden by CSS)
 */
export const UI_LIB = `(() => {
  const SEP = ${JSON.stringify(SEP_CHARS)};
  const hits = s => { s = String(s ?? ""); const out = []; for (const c of SEP) if (s.includes(c)) out.push("U+" + c.codePointAt(0).toString(16).toUpperCase().padStart(4, "0"));
    if (/\\s\\.\\s/.test(s) || (s !== "." && s.trim() === ".")) out.push('" . "'); return out; };
  const vis = el => !!el && el.isConnected && (el.checkVisibility ? el.checkVisibility({checkOpacity: true, checkVisibilityCSS: true}) : el.offsetParent !== null)
    && (() => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; })();
  const EXCL = "#statusline, #readouts, #fitstatus, #pill, #galcount, canvas, script, style, noscript, template";
  const isClosedPop = el => !!el.closest("[popover]:not(:popover-open), .pop[hidden], [role=dialog][hidden], [role=menu][hidden]");
  function words() {
    const w = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT); const list = []; let n;
    while ((n = w.nextNode())) { const el = n.parentElement; if (!el || el.closest(EXCL) || isClosedPop(el) || !vis(el)) continue;
      for (const t of n.textContent.split(/\\s+/)) if (/\\p{L}/u.test(t)) list.push(t); }
    return {n: list.length, list}; }
  const ATTRS = ["title", "aria-label", "aria-valuetext", "aria-description", "aria-roledescription", "placeholder", "alt", "data-tip", "data-tooltip", "data-title", "label"];
  function sepScan() {
    const out = [], add = (where, s) => { for (const what of hits(s)) out.push({where, what, text: String(s).slice(0, 120)}); };
    add("document.title", document.title);
    const w = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT); let n;
    while ((n = w.nextNode())) { const el = n.parentElement; if (!el || el.closest("script, style, noscript, template")) continue;
      add("text " + (el.id ? "#" + el.id : el.tagName.toLowerCase() + (el.className && typeof el.className === "string" ? "." + el.className.split(" ")[0] : "")), n.textContent); }
    for (const el of document.querySelectorAll("*")) { for (const a of ATTRS) if (el.hasAttribute(a)) add(a + " on " + (el.id ? "#" + el.id : el.tagName.toLowerCase()), el.getAttribute(a));
      if ((el.tagName === "INPUT" && /^(button|submit|reset)$/.test(el.type)) || el.tagName === "OPTION") add("value on " + (el.id || el.tagName.toLowerCase()), el.value);
      for (const ps of ["::before", "::after"]) { const c = getComputedStyle(el, ps).content; if (c && c !== "none" && c !== "normal") add("css " + ps + " on " + (el.id ? "#" + el.id : el.tagName.toLowerCase()), c.replace(/^"|"$/g, "")); } }
    for (const s of (window.__tng ? __tng.text : [])) add("canvas text", s);
    add("body innerText", document.body.innerText.replace(/\\s+/g, " "));
    return out; }
  const rect = sel => { const e = typeof sel === "string" ? document.querySelector(sel) : sel; if (!e) return null; const r = e.getBoundingClientRect();
    return {x: r.left, y: r.top, w: r.width, h: r.height, right: r.right, bottom: r.bottom}; };
  function label(el) { if (!el) return ""; const ids = (el.getAttribute("aria-labelledby") || "").split(/\\s+/).filter(Boolean);
    if (ids.length) return ids.map(i => document.getElementById(i)?.innerText || "").join(" ").trim();
    const L = el.labels && el.labels[0] || el.closest("label"); if (L && vis(L)) return L.innerText.replace(/\\s+/g, " ").trim();
    return (el.getAttribute("aria-label") || "").trim(); }
  function textBox(el) { let w = 0, px = Infinity; const tw = document.createTreeWalker(el, NodeFilter.SHOW_TEXT); let n;
    while ((n = tw.nextNode())) { if (!n.textContent.trim()) continue; const r = document.createRange(); r.selectNodeContents(n); w += r.getBoundingClientRect().width;
      px = Math.min(px, parseFloat(getComputedStyle(n.parentElement).fontSize)); }
    return {w, px: px === Infinity ? 0 : px, text: el.innerText.replace(/\s+/g, " ").trim()}; }
  window.__ui = {vis, words, sepScan, rect, label, hits, textBox};
  return true;
})()`;
