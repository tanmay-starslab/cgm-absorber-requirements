// Optional music for "How a spectrum is made": two tracks (media/music.json, scripts/story_music.py), Hans Zimmer's Day One
// (Interstellar, 2014) by default and Beethoven's Symphony No. 7, II. Allegretto as the second choice.
//
// Off by default (owner, 2026-11-13), with the toggle highlighted until the reader has made a choice (class "invite":
// accent ring and a short glow). Nothing is downloaded until it is turned on (each track is a seamless loop of about
// 1.5 MB, fetched the first time it plays). The on/off choice and the track are remembered (localStorage); a remembered
// "on" starts at the reader's first click, tap or key, since browsers do not let a page start sound by itself. Web Audio
// (not <audio loop>) so the loop has no gap and the fades work on every browser, including iOS where an <audio> element
// ignores its volume. The sound fades out when the tab is hidden and back in when it returns. Switching track while the
// music plays crossfades (XFADE s).
//
// Pure: musicLabel(on, copy), trackById(id), nextTrack(id), trackCredit(t).
// DOM: createSound({copy, onChange, onTrack}) -> {toggle(), set(on), on(), bind(button), track(), setTrack(id), cycleTrack(),
// tracks}.

export const STORE_KEY = "tngStory.music";
export const TRACK_KEY = "tngStory.musicTrack";
export const VOLUME = 1.0;   /* full level: 0.55 was too faint over laptop speakers (owner 2026-11-16); the tracks peak at -7 (Day One) and -4 dBFS (Beethoven), so 1.0 cannot clip */
export const XFADE = 1.0;
export const TRACKS = Object.freeze([
  Object.freeze({id: "dayone", label: "Day One", src: "media/music_dayone.m4a", credit: "Hans Zimmer, Day One (Interstellar, 2014)"}),
  Object.freeze({id: "beethoven", label: "Beethoven", src: "media/music_loop.m4a", credit: "Beethoven, Symphony No. 7, II. Allegretto (orchestral recording)"}),
]);
export const DEFAULT_TRACK = TRACKS[0].id;

export const trackById = id => TRACKS.find(t => t.id === id) || TRACKS[0];
export const nextTrack = id => TRACKS[(TRACKS.indexOf(trackById(id)) + 1) % TRACKS.length];
export const trackCredit = t => `Music: ${trackById(t && t.id ? t.id : t).credit}`;
export const MUSIC_CREDIT = trackCredit(DEFAULT_TRACK);

export function musicLabel(on, copy) {
  const ui = (copy && copy.ui) || {};
  return on ? (ui.music_on || "Music on") : (ui.music_off || "Music off");
}

export function createSound({copy = null, win = window, onChange = null, onTrack = null} = {}) {
  const buttons = new Set();
  const store = {get: k => { try { return win.localStorage.getItem(k); } catch { return null; } },
                 set: (k, v) => { try { win.localStorage.setItem(k, v); } catch { /* private mode */ } }};
  let on = false, ctx = null, gain = null, pendingGesture = null;
  let track = trackById(store.get(TRACK_KEY)).id;
  const bufs = new Map(), loading = new Map();
  let voice = null;   // {id, node, g}: the playing source and its own gain (the crossfade), into the master gain

  // a remembered "on" shows on everywhere (owner 2026-11-16: the choice carries across stories). Some browsers (Safari,
  // Firefox) block sound on a new page until the first click, so until then the switch is on but "waiting" (data-wait,
  // still bars, its own title); the click that starts the story starts the music. Chrome carries the permission over.
  function paint() {
    const waiting = on && !!pendingGesture;
    const label = musicLabel(on, copy), invite = !on && store.get(STORE_KEY) == null;
    for (const b of buttons) {
      b.classList.toggle("invite", invite);
      b.setAttribute(b.getAttribute("role") === "switch" ? "aria-checked" : "aria-pressed", String(on)); b.dataset.on = on ? "1" : "0"; b.dataset.track = track;
      if (waiting) b.dataset.wait = "1"; else delete b.dataset.wait;
      b.title = waiting ? `${label}: starts with the story (key M turns it off)\n${trackCredit(track)}` : `${label} (key M)\n${trackCredit(track)}`;
      const l = b.querySelector(".snd-l"); if (l) l.textContent = label;
      if (!l) b.setAttribute("aria-label", "Music");
    }
  }

  function context() {
    const AC = win.AudioContext || win.webkitAudioContext;
    if (!AC) throw new Error("no Web Audio");
    if (!ctx) { ctx = new AC(); gain = ctx.createGain(); gain.gain.value = 0; gain.connect(ctx.destination); }
    return ctx;
  }

  function load(id) {
    if (bufs.has(id)) return Promise.resolve(bufs.get(id));
    if (!loading.has(id)) loading.set(id, (async () => {
      context();
      const src = trackById(id).src, r = await win.fetch(src); if (!r.ok) throw new Error(src + ": HTTP " + r.status);
      const ab = await r.arrayBuffer();
      const b = await new Promise((res, rej) => { const p = ctx.decodeAudioData(ab, res, rej); if (p && p.then) p.then(res, rej); });
      bufs.set(id, b); return b;
    })().catch(e => { loading.delete(id); throw e; }));
    return loading.get(id);
  }

  function ramp(param, to, s) {
    if (!ctx) return;
    const t = ctx.currentTime;
    param.cancelScheduledValues(t); param.setValueAtTime(param.value, t); param.linearRampToValueAtTime(to, t + s);
  }

  // start the track's loop (fading in over s, 0 = at once) and fade out and stop the voice it replaces
  function play(id, s) {
    if (voice && voice.id === id) return;
    const old = voice, g = ctx.createGain(), node = ctx.createBufferSource();
    node.buffer = bufs.get(id); node.loop = true; node.connect(g); g.connect(gain);
    g.gain.value = s ? 0 : 1; node.start();
    if (s) ramp(g.gain, 1, s);
    voice = {id, node, g};
    if (old) { const f = s || 0.05; ramp(old.g.gain, 0, f);
      win.setTimeout(() => { try { old.node.stop(); old.node.disconnect(); old.g.disconnect(); } catch { /* already gone */ } }, (f + 0.1) * 1000); }
  }

  async function start() {
    // the context must be created or resumed inside the gesture's call stack on Safari, before any await
    try { context(); } catch (e) { fail(e); return; }
    if (ctx.state === "suspended") ctx.resume().catch(() => {});
    const id = track;
    try { await load(id); } catch (e) { fail(e); return; }
    if (!on || id !== track) return;   // turned off, or the track changed meanwhile (setTrack starts that one)
    play(id, voice ? XFADE : 0);
    if (ctx.state === "suspended") await ctx.resume().catch(() => {});
    ramp(gain.gain, VOLUME, 1.6);
  }
  function fail(e) { console.warn("music unavailable:", e.message); on = false; paint(); onChange && onChange(on); }

  function stop() {
    if (!ctx) return;
    ramp(gain.gain, 0, 0.6);
    win.setTimeout(() => { if (!on && ctx && ctx.state === "running") ctx.suspend().catch(() => {}); }, 700);
  }

  function clearPending() {
    if (pendingGesture) { win.removeEventListener("pointerdown", pendingGesture, true); win.removeEventListener("keydown", pendingGesture, true); pendingGesture = null; }
  }

  function set(v, {remember = true} = {}) {
    v = !!v;
    clearPending();
    if (v === on) { paint(); return; }
    on = v; paint();
    if (remember) store.set(STORE_KEY, on ? "on" : "off");
    if (on) start(); else stop();
    onChange && onChange(on);
  }
  const toggle = () => set(!on);

  // choose the track (remembered). While the music plays the new track is fetched and crossfaded in; while it is off only
  // the choice changes, and nothing is downloaded until it is turned on.
  function setTrack(id) {
    const t = trackById(id).id;
    store.set(TRACK_KEY, t);
    if (t === track) { paint(); return; }
    track = t; paint();
    onTrack && onTrack(trackById(t));
    if (on && ctx && !pendingGesture) start();
  }
  const cycleTrack = () => setTrack(nextTrack(track).id);

  function bind(button) {
    if (!button) return;
    buttons.add(button);
    button.addEventListener("click", e => { e.preventDefault(); e.stopPropagation(); toggle(); });
    paint();
  }

  // a remembered "on": start at the first gesture anywhere (the one that also starts the story). A press on a music toggle
  // or the M key is that toggle's own business, so it is not a start.
  if (store.get(STORE_KEY) === "on") {
    on = true;
    pendingGesture = e => {
      if (e.type === "keydown" && (e.key === "m" || e.key === "M" || e.repeat)) return;
      if (e.target && e.target.closest && e.target.closest("#sound-btn, [data-testid='gate-music']")) return;
      clearPending(); paint();
      if (on) start();
    };
    win.addEventListener("pointerdown", pendingGesture, true); win.addEventListener("keydown", pendingGesture, true);
    // where the browser already allows sound (e.g. a site it trusts), start at once instead of waiting
    try {
      context();
      ctx.resume().then(() => { if (ctx.state === "running" && pendingGesture && on) { clearPending(); paint(); start(); } }).catch(() => {});
    } catch { /* no Web Audio: fail() reports it on the first try */ }
  }
  win.document.addEventListener("visibilitychange", () => {
    if (!ctx || !on) return;
    if (win.document.hidden) { ramp(gain.gain, 0, 0.3); win.setTimeout(() => win.document.hidden && ctx.suspend().catch(() => {}), 350); }
    else { ctx.resume().then(() => ramp(gain.gain, VOLUME, 1.0)).catch(() => {}); }
  });

  return {toggle, set, bind, on: () => on, track: () => trackById(track), setTrack, cycleTrack, tracks: TRACKS,
          get credit() { return trackCredit(track); },
          /* for tests: the audio graph's state */
          debug: () => ({state: ctx ? ctx.state : null, time: ctx ? ctx.currentTime : null, voice: voice ? voice.id : null,
                         gain: gain ? gain.gain.value : null, loaded: [...bufs.keys()]})};
}
