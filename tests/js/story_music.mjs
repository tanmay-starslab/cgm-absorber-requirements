// The story's optional music: two tracks, Day One by default, Beethoven second (js/ui/sound.js, media/music.json,
// scripts/story_music.py).
//
//   node tests/js/story_music.mjs                                  static checks (tracks, files, credits)
//   TNG_BROWSER=1 node tests/js/story_music.mjs [docs/tng50] [--shots DIR] [--edge BIN]
//
// Static: sound.js lists Day One first (the default) and Beethoven; both loop files exist; media/music.json lists both
// with their credits and the same files; Data and credits, the Read-as-text line, MUSIC_LICENSE.txt, README.md and
// THIRD_PARTY_LICENSES name both. Browser (1440x900, then 390x844; ?nogate): a fresh visit has Day One and music off and
// fetches no music; the HUD pill turns it on, Day One is fetched and decoded and plays (AudioContext running, currentTime
// advancing); the menu's "Music: Day One" entry switches to Beethoven while playing (the menu stays open, the voice
// changes, the choice is in localStorage) and Enter on the focused entry switches back and forth; after a reload the
// track is still Beethoven; the M key turns the music off.
import {readFileSync, existsSync, mkdirSync} from "node:fs";
import {join, resolve} from "node:path";
import {pathToFileURL} from "node:url";
import {parseArgs, checker, launch, BLOCK, sleep} from "./lib/browser.mjs";
import {REPO, STORY_REL, plainEdge, gzServe} from "./lib/storyqa.mjs";

const {pos, opt} = parseArgs(process.argv.slice(2));
const C = checker(), ROOT = join(REPO, "docs/tng50", STORY_REL), rd = f => readFileSync(join(REPO, f), "utf8");

/* ---------------------------------------------------------------- static */
const S = await import(pathToFileURL(join(ROOT, "js/ui/sound.js")).href);
C.check(S.TRACKS.length === 2 && S.TRACKS[0].id === "dayone" && S.DEFAULT_TRACK === "dayone" && S.TRACKS[1].id === "beethoven",
  `sound.js tracks: ${S.TRACKS.map(t => t.id).join(", ")} (Day One first, the default)`);
C.check(S.nextTrack("dayone").id === "beethoven" && S.nextTrack("beethoven").id === "dayone" && S.trackById("nope").id === "dayone", "nextTrack cycles; an unknown id falls back to Day One");
for (const t of S.TRACKS) C.check(existsSync(join(ROOT, t.src)), `${t.src} exists`);
const MJ = JSON.parse(readFileSync(join(ROOT, "media/music.json"), "utf8"));
C.check(Array.isArray(MJ.tracks) && MJ.tracks.map(t => t.id).join() === "dayone,beethoven" && MJ.tracks[0].default === true,
  "media/music.json lists dayone (default) and beethoven");
for (const t of MJ.tracks || []) C.check(S.TRACKS.some(x => x.id === t.id && x.src === "media/" + t.file) && t.work && t.loop_window_s && t.source_sha256,
  `music.json ${t.id}: file ${t.file} matches sound.js, work, window ${t.loop_window_s}, source hash`);
const {creditSections} = await import(pathToFileURL(join(ROOT, "js/ui/menu.js")).href);
const mus = (creditSections(1).find(s => s.h === "Music") || {p: []}).p.join(" ");
const both = s => /Hans Zimmer, Day One \(Interstellar, 2014\)/.test(s) && /Beethoven, Symphony No\. 7/.test(s);
C.check(both(mus), "Data and credits, Music: both tracks");
const toCr = (rd(`docs/tng50/${STORY_REL}/index.html`).match(/<p class="to-cr">([^<]*)<\/p>/) || [])[1] || "";
C.check(both(toCr), "Read-as-text credit line: both tracks");
for (const f of [`docs/tng50/${STORY_REL}/media/MUSIC_LICENSE.txt`, "README.md", "THIRD_PARTY_LICENSES"]) C.check(both(rd(f).replace(/\s+/g, " ")), `${f}: both tracks`);

/* ---------------------------------------------------------------- browser */
if (!process.env.TNG_BROWSER) { C.note("browser part skipped (set TNG_BROWSER=1)"); process.exit(C.finish()); }
const DIR = resolve(pos[0] || join(REPO, "docs/tng50")), SHOTS = opt.shots ? resolve(opt.shots) : null;
if (SHOTS) mkdirSync(SHOTS, {recursive: true});
const srv = await gzServe(DIR), URL0 = srv.base + STORY_REL + "/index.html?nogate";
const M = "window.__story && __story.music";
const st = P => P.eval(`(${M}) ? Object.assign(__story.music.debug(), {track: __story.music.track().id, on: __story.music.on()}) : null`);
const fetched = (P, f) => P.requests.filter(r => r.includes("/media/" + f)).length;
const item = `#menu-sheet [data-id="musicTrack"]`;
const label = P => P.eval(`(document.querySelector('${item} .mn-l') || {}).textContent || null`);
try {
  for (const [w, h, mobile] of [[1440, 900, false], [390, 844, true]]) {
    const P = await launch({edge: opt.edge || plainEdge(), block: BLOCK, reducedMotion: true, width: w, height: h});
    try {
      await P.viewport(w, h, mobile);
      await P.goto(URL0);
      if (!C.check(await P.waitFor(`${M} && __story.ready && !document.documentElement.classList.contains("gate-open")`, 120000) >= 0, `${w}x${h}: story ready (?nogate)`)) continue;
      await sleep(1500);
      let d = await st(P);
      C.check(d.track === "dayone" && !d.on && await P.eval(`document.getElementById("sound-btn").dataset.track`) === "dayone",
        `${w}: fresh visit: track ${d.track}, music ${d.on ? "on" : "off"}`);
      C.check(fetched(P, "music_") === 0, `${w}: no music fetched before it is turned on`);
      if (SHOTS) await P.shot(join(SHOTS, `music_hud_${w}.png`));

      // on: Day One is fetched, decoded and plays
      await P.click("#sound-btn");
      const tOn = await P.waitFor(`${M}.debug().voice === "dayone" && __story.music.debug().state === "running"`, 30000);
      d = await st(P); await sleep(1200); const d2 = await st(P);
      C.check(tOn >= 0 && d2.time - d.time > 0.8, `${w}: Day One plays after the pill (${tOn} ms; AudioContext ${d2.state}, currentTime ${d.time?.toFixed(2)} -> ${d2.time?.toFixed(2)}; gain ${d2.gain?.toFixed(2)})`);
      C.check(fetched(P, "music_dayone.m4a") === 1 && fetched(P, "music_loop.m4a") === 0, `${w}: fetched music_dayone.m4a only`);

      // the menu entry: "Music: Day One" -> Beethoven while playing; the menu stays open
      await P.click("#menu-btn"); await P.waitFor(`!document.getElementById("menu-sheet").hidden`, 5000);
      C.check(await label(P) === "Music: Day One" && await P.eval(`document.querySelector('${item} .mn-h').textContent`) === "switch to Beethoven",
        `${w}: menu entry "${await label(P)}" / "${await P.eval(`(document.querySelector('${item} .mn-h') || {}).textContent`)}"`);
      if (SHOTS) await P.shot(join(SHOTS, `music_menu_${w}.png`));
      await P.click(item);
      const tSw = await P.waitFor(`${M}.debug().voice === "beethoven"`, 30000);
      await sleep(1500); d = await st(P);
      C.check(tSw >= 0 && d.state === "running" && d.loaded.includes("beethoven"), `${w}: switched to Beethoven while playing (${tSw} ms, ${d.state}, loaded ${d.loaded})`);
      C.check(await P.eval(`!document.getElementById("menu-sheet").hidden`) && await label(P) === "Music: Beethoven", `${w}: menu stays open, entry now "${await label(P)}"`);
      C.check(await P.eval(`localStorage.getItem("tngStory.musicTrack")`) === "beethoven", `${w}: track remembered (localStorage tngStory.musicTrack = beethoven)`);
      if (SHOTS) await P.shot(join(SHOTS, `music_menu_beethoven_${w}.png`));
      // keyboard: Enter on the focused entry
      await P.eval(`document.querySelector('${item}').focus()`);
      const enter = async () => { for (const type of ["keyDown", "keyUp"]) await P.send("Input.dispatchKeyEvent", {type, key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, ...(type === "keyDown" ? {text: "\r"} : {})}); await sleep(300); };
      await enter(); const k1 = await label(P);
      await enter(); const k2 = await label(P);
      C.check(k1 === "Music: Day One" && k2 === "Music: Beethoven" && await P.eval(`document.activeElement && document.activeElement.dataset.id`) === "musicTrack",
        `${w}: Enter on the focused entry: "${k1}", then "${k2}", focus kept`);
      await P.key("Escape");
      await P.waitFor(`${M}.debug().voice === "beethoven"`, 10000);

      // reload: the track persists (and "on" is remembered, waiting for a gesture)
      await P.goto(URL0);
      await P.waitFor(`${M} && __story.ready`, 120000); await sleep(800);
      d = await st(P);
      C.check(d.track === "beethoven" && d.on && await P.eval(`document.getElementById("sound-btn").dataset.track`) === "beethoven", `${w}: after reload: track ${d.track}, music ${d.on ? "on" : "off"} (remembered)`);
      // a remembered "on" shows on (owner 2026-11-16: the choice carries across stories); data-wait marks it until the audio
      // runs (a browser that blocks sound on a new page); M turns it off either way
      const shown = () => P.eval(`document.getElementById("sound-btn").getAttribute("aria-checked")`);
      const waitAttr = () => P.eval(`document.getElementById("sound-btn").dataset.wait || null`);
      const running = await P.eval(`${M}.debug().state === "running"`);
      C.check((await shown()) === "true", `${w}: after reload the remembered choice shows on`);
      C.check((await waitAttr() === "1") === !running, `${w}: data-wait only while the audio waits (wait ${await waitAttr()}, running ${running})`);
      await P.eval(`document.activeElement && document.activeElement.blur && document.activeElement.blur()`);
      await P.key("m"); await sleep(400);
      C.check((await shown()) === "false", `${w}: M turns the music off`);
      if (w === 1440 && SHOTS) {   // the credits dialog's Music section
        await P.click("#menu-btn"); await sleep(200); await P.click(`#menu-sheet [data-id="credits"]`); await sleep(400);
        await P.eval(`(() => { const s = [...document.querySelectorAll("#credits h3")].find(h => h.textContent === "Music"); s && s.scrollIntoView({block: "center"}); })()`);
        await sleep(200); await P.shot(join(SHOTS, `music_credits_${w}.png`));
      }
      C.check(!P.exceptions.length, `${w}: no uncaught exception${P.exceptions.length ? ": " + P.exceptions[0] : ""}`);
    } finally { await P.close(); }
  }
} finally { await srv.close(); }
process.exit(C.finish());
