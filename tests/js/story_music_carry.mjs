// A remembered "music on" on a fresh story page where the browser blocks sound until a click (Safari, Firefox; simulated,
// since headless Chrome always allows it): the switch shows on with data-wait, and the Watch click starts the music.
// Browser test: TNG_BROWSER=1 (TNG_EDGE as for the other browser tests).
import {launch, sleep} from "./lib/browser.mjs";
import {STORY_REL, gzServe, REPO, plainEdge} from "./lib/storyqa.mjs";
if (!process.env.TNG_BROWSER) { console.log("skipped (set TNG_BROWSER=1 to run the music carry-over test)"); process.exit(0); }
import {join, resolve} from "node:path";
const srv = await gzServe(resolve(join(REPO, "docs/tng50")));
const P = await launch({edge: plainEdge(), reducedMotion: true, width: 1440, height: 900});
const M = "window.__story && __story.music";
const st = () => P.eval(`JSON.stringify({state: __story.music.debug().state, on: __story.music.on(), sw: document.querySelector('[data-testid=gate-music]').getAttribute('aria-checked'), wait: document.querySelector('[data-testid=gate-music]').dataset.wait || null})`);
let bad = 0;
// Safari/Firefox rule, simulated (headless Chrome always allows sound): resume() succeeds only during a real user activation
await P.send("Page.addScriptToEvaluateOnNewDocument", {source: `(() => { const AC = window.AudioContext; if (!AC) return;
  const r = AC.prototype.resume, s0 = Object.getOwnPropertyDescriptor(BaseAudioContext.prototype, "state");
  window.__blocked = true; let gest = false;
  for (const t of ["pointerdown", "keydown"]) addEventListener(t, e => { if (e.isTrusted) gest = true; }, true);
  AC.prototype.resume = function () { if (gest) { window.__blocked = false; return r.call(this); } return new Promise(() => {}); };
  Object.defineProperty(BaseAudioContext.prototype, "state", {get() { return window.__blocked ? "suspended" : s0.get.call(this); }});
})()`});
try {
  await P.goto(srv.base + STORY_REL + "/index.html");
  await P.waitFor(`${M} && __story.ready`, 120000);
  await P.eval(`localStorage.setItem("tngStory.music", "on")`);
  await P.goto(srv.base + STORY_REL + "/index.html?story=damped");
  await P.waitFor(`${M} && __story.ready`, 120000); await sleep(2000);
  const a = JSON.parse(await st()); console.log("fresh story page:", a);
  if (!(a.on && a.sw === "true" && (a.state === "running" ? !a.wait : a.wait === "1"))) bad++;
  const watch = "[data-testid=gate-watch]";
  if (!(await P.click(watch))) { console.log("no Watch button"); bad++; } await sleep(3000);
  const b = JSON.parse(await st().catch(() => "{}")); console.log("after Watch click:", b);
  if (b.state !== "running") bad++;
} finally { console.log(bad ? `${bad} check(s) FAILED` : "all checks passed"); srv.close?.(); process.exit(bad ? 1 : 0); }
