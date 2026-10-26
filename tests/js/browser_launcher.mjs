// Unit test of the browser choice and launch flags of tests/js/lib/browser.mjs (no browser is started).
//   node tests/js/browser_launcher.mjs
// findBrowser: TNG_EDGE wins; macOS takes Microsoft Edge, then Google Chrome (/Applications, then ~/Applications);
// Linux takes the first of microsoft-edge, google-chrome, chromium, chromium-browser, chrome-headless-shell found on PATH
// (executable files only); nothing found is an error that names TNG_EDGE. browserArgs: the default flags are exactly the
// launcher's historical list, TNG_REDUCED_MOTION=1 (or reducedMotion: true) adds --force-prefers-reduced-motion, and
// hover: true adds the desktop-mouse blink settings (HOVER_FLAG).
// launch: a TNG_EDGE that cannot be started fails at once with a message naming TNG_EDGE and leaves no profile behind.
import {mkdtempSync, mkdirSync, writeFileSync, chmodSync, existsSync, readdirSync, rmSync} from "node:fs";
import {join, delimiter} from "node:path";
import {tmpdir} from "node:os";
import {findBrowser, browserArgs, launch, BROWSERS, HOVER_FLAG, checker} from "./lib/browser.mjs";

const C = checker();
const throwsWith = (f, re) => { try { f(); return false; } catch (e) { return re.test(String(e.message)); } };
const tmp = mkdtempSync(join(tmpdir(), "tng-browser-unit-"));
const bin = (dir, name, exec = true) => { mkdirSync(dir, {recursive: true}); const f = join(dir, name);
  writeFileSync(f, "#!/bin/sh\nexit 0\n"); chmodSync(f, exec ? 0o755 : 0o644); return f; };

try {
  /* TNG_EDGE wins on every platform, even when it does not exist (the launch then reports it) */
  for (const platform of ["darwin", "linux", "win32"])
    C.check(findBrowser({env: {TNG_EDGE: "/opt/x/chrome", PATH: ""}, platform}) === "/opt/x/chrome", `TNG_EDGE is used as given on ${platform}`);

  /* Linux: name priority over PATH order; non-executable files and directories are skipped */
  const A = join(tmp, "a"), B = join(tmp, "b"), D = join(tmp, "d");
  bin(A, "chromium"); bin(A, "google-chrome", false); bin(B, "google-chrome"); mkdirSync(join(D, "microsoft-edge"), {recursive: true});
  const PATH = [D, A, B].join(delimiter);
  C.check(findBrowser({env: {PATH}, platform: "linux"}) === join(B, "google-chrome"),
    "linux: google-chrome before chromium; a non-executable file and a directory named microsoft-edge are skipped");
  bin(join(tmp, "e"), "microsoft-edge");
  C.check(findBrowser({env: {PATH: [join(tmp, "e"), PATH].join(delimiter)}, platform: "linux"}) === join(tmp, "e", "microsoft-edge"),
    "linux: microsoft-edge first");
  const H = join(tmp, "h"); bin(H, "chrome-headless-shell");
  C.check(findBrowser({env: {PATH: H}, platform: "linux"}) === join(H, "chrome-headless-shell"), "linux: chrome-headless-shell is the last candidate");
  C.check(BROWSERS.linux.join(",") === "microsoft-edge,google-chrome,chromium,chromium-browser,chrome-headless-shell", "linux candidate order");
  C.check(throwsWith(() => findBrowser({env: {PATH: join(tmp, "empty")}, platform: "linux"}), /TNG_EDGE/), "linux: none on PATH throws naming TNG_EDGE");
  C.check(throwsWith(() => findBrowser({env: {}, platform: "linux"}), /TNG_EDGE/), "linux: no PATH at all throws naming TNG_EDGE");

  /* macOS: Edge, then Chrome; /Applications before ~/Applications */
  const EDGE = "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge", CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
  const mac = have => findBrowser({env: {PATH: "/usr/bin"}, platform: "darwin", home: "/Users/u", exec: f => have.includes(f)});
  C.check(mac([EDGE, CHROME]) === EDGE, "darwin: Microsoft Edge first (the launcher's historical default)");
  C.check(mac([CHROME]) === CHROME, "darwin: Google Chrome when Edge is absent");
  C.check(mac(["/Users/u/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge", CHROME]) ===
    "/Users/u/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge", "darwin: Edge in ~/Applications before Chrome");
  C.check(throwsWith(() => mac([]), /TNG_EDGE/), "darwin: neither installed throws naming TNG_EDGE");
  C.check(throwsWith(() => findBrowser({env: {}, platform: "win32"}), /TNG_EDGE/), "other platforms need TNG_EDGE");

  /* flags: unchanged by default; reduced motion opt-in */
  const legacy = p => ["--headless=new", "--remote-debugging-port=0", `--user-data-dir=${p}`, "--no-first-run", "--no-default-browser-check",
    "--disable-component-update", "--disable-background-networking", "--no-proxy-server", "--hide-scrollbars", "--mute-audio",
    "--disable-features=msSmartScreenProtection,msEdgeEnhancedSecurityMode,msEnhancedSecurityMode", "--window-size=1440,900", "about:blank"];
  const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  C.check(same(browserArgs({profile: "/p"}, {}), legacy("/p")), "default flags are the historical list (TNG_REDUCED_MOTION unset)");
  C.check(same(browserArgs({profile: "/p"}, {TNG_REDUCED_MOTION: "0"}), legacy("/p")), "TNG_REDUCED_MOTION=0 adds nothing");
  const rm = browserArgs({profile: "/p", width: 390, height: 844}, {TNG_REDUCED_MOTION: "1"});
  C.check(rm.includes("--force-prefers-reduced-motion") && rm.includes("--window-size=390,844") && rm.length === legacy("/p").length + 1 && rm.at(-1) === "about:blank",
    "TNG_REDUCED_MOTION=1 adds --force-prefers-reduced-motion and nothing else");
  C.check(!browserArgs({profile: "/p", reducedMotion: false}, {TNG_REDUCED_MOTION: "1"}).includes("--force-prefers-reduced-motion"),
    "reducedMotion: false overrides TNG_REDUCED_MOTION=1 (viewer_browser checks the spin)");
  C.check(browserArgs({profile: "/p", reducedMotion: true}, {}).includes("--force-prefers-reduced-motion"), "reducedMotion: true without the env");
  const hv = browserArgs({profile: "/p", hover: true}, {}), hvRef = legacy("/p");
  C.check(hv.length === hvRef.length + 1 && hv.at(-2) === "--window-size=1440,900" && hv.at(-3) === HOVER_FLAG && /primaryHoverType=2/.test(HOVER_FLAG) && /primaryPointerType=4/.test(HOVER_FLAG),
    "hover: true adds the desktop-mouse blink settings and nothing else (page_smoke's hover popover check)");

  /* launch: an unstartable binary fails fast, names TNG_EDGE, removes its profile */
  const prof = join(tmp, "prof"); mkdirSync(prof);
  const t0 = Date.now(); let msg = "";
  try { await launch({edge: join(tmp, "no-such-browser"), profile: prof}); } catch (e) { msg = String(e.message); }
  C.check(/TNG_EDGE/.test(msg) && /no-such-browser/.test(msg) && Date.now() - t0 < 30000, `unstartable binary rejected at once (${Date.now() - t0} ms): ${msg.slice(0, 120)}`);
  C.check(existsSync(prof) && readdirSync(prof).length === 0, "the failed launch left no profile behind");
} finally {
  rmSync(tmp, {recursive: true, force: true});
}
process.exit(C.finish());
