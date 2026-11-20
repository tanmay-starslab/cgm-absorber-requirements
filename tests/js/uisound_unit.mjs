// UI sound effects (docs/tng50/js/uisound.js): the state logic with a fake window, storage and uisfx runtime, no browser.
// Default off (nothing loaded), persistence under tng.sfx shared by every instance, ?sfx=off, the toggle cues, the
// hidden-tab and rate-limit guards, ducking (quieter while the music plays) and the vendored runtime's exports.
// Usage: node tests/js/uisound_unit.mjs
import {createUISound, KEY, PACK, VOLUME, DUCK, GAP_MS} from "../../docs/tng50/js/uisound.js";
import {checker} from "./lib/browser.mjs";

const C = checker(), check = C.check;
const tick = () => new Promise(r => setTimeout(r, 0));

function fakeWin({search = "", stored = null} = {}) {
  const data = new Map(stored == null ? [] : [[KEY, stored]]);
  let t = 1000;
  const listeners = {};
  return {
    location: {search}, data, listeners,
    localStorage: {getItem: k => (data.has(k) ? data.get(k) : null), setItem: (k, v) => data.set(k, String(v))},
    performance: {now: () => t}, advance: ms => { t += ms; },
    addEventListener: (type, f) => { (listeners[type] = listeners[type] || []).push(f); },
    removeEventListener: (type, f) => { listeners[type] = (listeners[type] || []).filter(g => g !== f); },
    document: {hidden: false, addEventListener: () => {}},
  };
}
function fakeRuntime() {
  const log = {loads: 0, plays: [], volumes: [], packs: [], unlocks: 0, stops: 0};
  const load = async () => { log.loads++; return {createUISFX: o => { log.packs.push(o.pack);
    return {play: c => { log.plays.push(c); return {}; }, setVolume: v => log.volumes.push(v), unlock: async () => { log.unlocks++; return true; }, stopAll: () => { log.stops++; }}; }}; };
  return {log, load};
}
function fakeButton() {
  const attrs = {}, handlers = {};
  return {attrs, dataset: {}, hidden: false, setAttribute: (k, v) => { attrs[k] = v; }, addEventListener: (t, f) => { handlers[t] = f; },
    click: () => handlers.click && handlers.click({preventDefault() {}, stopPropagation() {}})};
}

check(PACK === "glass", `default pack is glass (${PACK})`);
check(VOLUME > 0 && VOLUME <= 0.5 && DUCK > 0 && DUCK < 1, `volume kept low (${VOLUME}), duck factor below 1 (${DUCK})`);

/* default off: nothing plays, nothing is loaded */
{ const w = fakeWin(), R = fakeRuntime(), s = createUISound({win: w, load: R.load});
  check(s.on() === false && s.play("select") === false, "default off: play is a no-op");
  await tick(); check(R.log.loads === 0, "default off: the runtime is not imported"); }

/* turning on: persisted, runtime loaded lazily, toggle-on cue, then cues play */
{ const w = fakeWin(), R = fakeRuntime(), s = createUISound({win: w, load: R.load}), b = fakeButton();
  s.bind(b); check(b.attrs["aria-checked"] === "false", "bound switch starts aria-checked=false");
  b.click(); await tick(); await tick();
  check(s.on() && w.data.get(KEY) === "on" && b.attrs["aria-checked"] === "true", "click turns it on, stores tng.sfx=on, paints the switch");
  check(R.log.loads === 1 && R.log.packs[0] === PACK && R.log.plays[0] === "toggle-on", `lazy import once, glass pack, toggle-on cue (${JSON.stringify(R.log)})`);
  w.advance(GAP_MS + 1); check(s.play("success") === true && R.log.plays.at(-1) === "success", "on: cues play");
  check(s.play("error") === false, "rate limit: a second cue inside GAP_MS is dropped");
  w.advance(GAP_MS + 1); w.document.hidden = true; check(s.play("select") === false, "hidden tab: nothing plays"); w.document.hidden = false;
  w.listeners.keydown[0]({isTrusted: false}); await tick(); check(R.log.unlocks === 0, "untrusted key event does not unlock");
  w.listeners.pointerdown[0]({isTrusted: true}); await tick(); check(R.log.unlocks === 1, "first trusted pointer event unlocks");
  b.click(); check(!s.on() && w.data.get(KEY) === "off" && R.log.plays.at(-1) === "toggle-off" && R.log.stops === 1, "click again: toggle-off cue, stored off, stopAll"); }

/* persistence shared across instances (explorer and explainer read the same key) */
{ const w = fakeWin({stored: "on"}), R = fakeRuntime(), s = createUISound({win: w, load: R.load});
  check(s.on() === true, "remembered on: starts on");
  check(s.play("select") === true, "remembered on: first cue loads the runtime"); await tick(); await tick();
  check(R.log.loads === 1 && R.log.plays.includes("select"), "the queued cue plays once loaded");
  const w2 = fakeWin({stored: "off"}); check(createUISound({win: w2, load: R.load}).on() === false, "remembered off: starts off"); }

/* ?sfx=off: forced off, switches hidden, set(true) ignored, nothing stored */
{ const w = fakeWin({search: "?sfx=off", stored: "on"}), R = fakeRuntime(), s = createUISound({win: w, load: R.load}), b = fakeButton();
  check(s.disabled && s.on() === false, "?sfx=off: disabled even when stored on");
  s.bind(b); check(b.hidden === true, "?sfx=off: switch hidden");
  s.set(true); await tick(); check(s.on() === false && w.data.get(KEY) === "on" && R.log.loads === 0, "?sfx=off: set(true) ignored, storage untouched, nothing loaded"); }

/* ducking: a flag or a predicate (the explainer passes () => music.on()) */
{ const w = fakeWin({stored: "on"}), R = fakeRuntime(), s = createUISound({win: w, load: R.load});
  check(s.ducked() === false && s.level() === VOLUME, "not ducked: full (low) level");
  s.setDuck(true); check(s.ducked() && Math.abs(s.level() - VOLUME * DUCK) < 1e-12, "setDuck(true): quieter level");
  let music = false; s.setDuck(() => music);
  check(!s.ducked(), "predicate false: not ducked"); music = true; check(s.ducked(), "predicate true: ducked");
  s.play("select"); await tick(); await tick();
  check(Math.abs(R.log.volumes.at(-1) - VOLUME * DUCK) < 1e-12, `ducked cue plays at VOLUME*DUCK (${R.log.volumes.at(-1)})`); }

/* the vendored runtime is a plain ES module with the API the wrapper uses */
{ const m = await import("../../docs/tng50/vendor/uisfx/uisfx.js");
  check(typeof m.createUISFX === "function" && m.packNames.includes(PACK), "vendored uisfx exports createUISFX and the glass pack");
  for (const c of ["select", "success", "error", "receive", "toggle-on", "toggle-off", "start", "play", "complete"]) check(m.cueNames.includes(c), `cue ${c} exists`);
  /* every literal cue the pages play (sfx("x"), with ternaries) is a uisfx cue name */
  const {readdirSync, readFileSync} = await import("node:fs"), dir = new URL("../../docs/tng50/js/", import.meta.url), used = new Set();
  for (const f of readdirSync(dir).filter(f => f.endsWith(".js"))) for (const call of readFileSync(new URL(f, dir), "utf8").matchAll(/\bsfx\(([^()]*)\)/g))
    for (const q of call[1].matchAll(/"([a-z-]+)"/g)) used.add(q[1]);
  const bad = [...used].filter(c => !m.cueNames.includes(c));
  check(used.size >= 15 && !bad.length, `the ${used.size} cues the explorer plays all exist${bad.length ? ": missing " + bad.join(", ") : ""}`); }

process.exit(C.finish());
