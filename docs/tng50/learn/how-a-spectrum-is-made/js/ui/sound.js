// Optional music for "How a spectrum is made": Beethoven, Symphony No. 7, II. Allegretto, cello arrangement and recording
// by John Michel (Wikimedia Commons, CC BY-SA 3.0; media/music.json, scripts/story_music.py).
//
// On by default (owner, 2026-11-13). Browsers do not let a page start sound by itself, so "on" means: the music starts
// with the reader's first click, tap or key (the Hold to fly / Watch press on the start screen is one), and the toggle
// reads "Music on" from the first frame so it is clear what will happen and how to stop it. The loop (media/music_loop.m4a,
// about 1.4 MB, seamless, two minutes) is fetched at that first gesture, not at page load. Turning it off is remembered
// (localStorage) and wins on later visits. Web Audio (not <audio loop>) so the loop has no gap and the fades
// work on every browser, including iOS where an <audio> element ignores its volume. The sound fades out when the tab is
// hidden and back in when it returns.
//
// Pure: musicLabel(on, copy). DOM: createSound({src, buttons, onChange}) -> {toggle(), set(on), on(), bind(button)}.

export const STORE_KEY = "tngStory.music";
export const VOLUME = 0.55;
export const MUSIC_CREDIT = "Music: Beethoven, Symphony No. 7, II. Allegretto; cello arrangement and recording by John Michel (CC BY-SA 3.0)";

export function musicLabel(on, copy) {
  const ui = (copy && copy.ui) || {};
  return on ? (ui.music_on || "Music on") : (ui.music_off || "Music off");
}

export function createSound({src = "media/music_loop.m4a", copy = null, win = window, onChange = null} = {}) {
  const buttons = new Set();
  let on = false, ctx = null, gain = null, node = null, buf = null, loading = null, pendingGesture = null;
  const store = {get: () => { try { return win.localStorage.getItem(STORE_KEY); } catch { return null; } },
                 set: v => { try { win.localStorage.setItem(STORE_KEY, v); } catch { /* private mode */ } }};

  function paint() {
    const label = musicLabel(on, copy);
    for (const b of buttons) {
      b.setAttribute("aria-pressed", String(on)); b.dataset.on = on ? "1" : "0";
      b.title = `${label} (key M)\n${MUSIC_CREDIT}`;
      const l = b.querySelector(".snd-l"); if (l) l.textContent = label;
      if (!l) b.setAttribute("aria-label", "Music");
    }
  }

  async function load() {
    if (buf) return buf;
    if (!loading) loading = (async () => {
      const AC = win.AudioContext || win.webkitAudioContext;
      if (!AC) throw new Error("no Web Audio");
      ctx = ctx || new AC();
      gain = gain || Object.assign(ctx.createGain(), {}); gain.gain.value = 0; gain.connect(ctx.destination);
      const r = await win.fetch(src); if (!r.ok) throw new Error(src + ": HTTP " + r.status);
      const ab = await r.arrayBuffer();
      buf = await new Promise((res, rej) => { const p = ctx.decodeAudioData(ab, res, rej); if (p && p.then) p.then(res, rej); });
      return buf;
    })();
    return loading;
  }

  function ramp(to, s) {
    if (!ctx || !gain) return;
    const t = ctx.currentTime, g = gain.gain;
    g.cancelScheduledValues(t); g.setValueAtTime(g.value, t); g.linearRampToValueAtTime(to, t + s);
  }

  async function start() {
    // the context must be created or resumed inside the gesture's call stack on Safari, before any await
    const AC = win.AudioContext || win.webkitAudioContext;
    if (!ctx && AC) ctx = new AC();
    if (ctx && ctx.state === "suspended") ctx.resume().catch(() => {});
    try { await load(); } catch (e) { console.warn("music unavailable:", e.message); on = false; paint(); onChange && onChange(on); return; }
    if (!on) return;
    if (!node) { node = ctx.createBufferSource(); node.buffer = buf; node.loop = true; node.connect(gain); node.start(); }
    if (ctx.state === "suspended") await ctx.resume().catch(() => {});
    ramp(VOLUME, 1.6);
  }

  function stop() {
    if (!ctx) return;
    ramp(0, 0.6);
    win.setTimeout(() => { if (!on && ctx && ctx.state === "running") ctx.suspend().catch(() => {}); }, 700);
  }

  function set(v, {remember = true} = {}) {
    v = !!v;
    if (pendingGesture) { win.removeEventListener("pointerdown", pendingGesture, true); win.removeEventListener("keydown", pendingGesture, true); pendingGesture = null; }
    if (v === on) { paint(); return; }
    on = v; paint();
    if (remember) store.set(on ? "on" : "off");
    if (on) start(); else stop();
    onChange && onChange(on);
  }
  const toggle = () => set(!on);

  function bind(button) {
    if (!button) return;
    buttons.add(button);
    button.addEventListener("click", e => { e.preventDefault(); e.stopPropagation(); toggle(); });
    paint();
  }

  // on unless the reader turned it off before: start at the first gesture anywhere (the one that also starts the story).
  // A press on a music toggle or the M key is that toggle's own business (it turns the music off), so it is not a start.
  if (store.get() !== "off") {
    on = true;
    pendingGesture = e => {
      if (e.type === "keydown" && (e.key === "m" || e.key === "M" || e.repeat)) return;
      if (e.target && e.target.closest && e.target.closest("#sound-btn, [data-testid='gate-music']")) return;
      win.removeEventListener("pointerdown", pendingGesture, true); win.removeEventListener("keydown", pendingGesture, true); pendingGesture = null;
      if (on) start();
    };
    win.addEventListener("pointerdown", pendingGesture, true); win.addEventListener("keydown", pendingGesture, true);
  }
  win.document.addEventListener("visibilitychange", () => {
    if (!ctx || !on) return;
    if (win.document.hidden) { ramp(0, 0.3); win.setTimeout(() => win.document.hidden && ctx.suspend().catch(() => {}), 350); }
    else { ctx.resume().then(() => ramp(VOLUME, 1.0)).catch(() => {}); }
  });

  return {toggle, set, bind, on: () => on, credit: MUSIC_CREDIT};
}
