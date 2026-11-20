// Subtle UI sound effects for the explorer and the explainer (uisfx, vendored in ../vendor/uisfx/; MIT code, CC0 sounds).
// Off by default; the choice is remembered in localStorage KEY and shared by both pages. ?sfx=off disables it for the page
// (switches hide, nothing plays). The runtime is imported only once sounds are on and unlocked on a trusted pointer or key
// event. Nothing plays while the tab is hidden; while the explainer music plays the effects play quieter (duck).
// Cues are semantic and sparse, never on hover, scroll or drags, and only echo something already visible.
//
// Pure-ish: createUISound({win, load}) -> {on(), set(v), toggle(), play(cue), bind(button), setDuck(boolOrFn), ducked(),
// level(), disabled}; uiSound() is the page singleton and sfx(cue) plays through it (a no-op outside a browser).
export const PACK = "glass";                  // one-line pack switch (any uisfx pack: minimal, soft, glass, ...)
export const KEY = "tng.sfx";
export const VOLUME = 0.3, DUCK = 0.45;       // master level, and its factor while the music plays
export const GAP_MS = 140;                    // global rate limit between cues

export function createUISound({win = globalThis.window, load = () => import("../vendor/uisfx/uisfx.js")} = {}) {
  const store = {get: () => { try { return win.localStorage.getItem(KEY); } catch { return null; } },
    set: v => { try { win.localStorage.setItem(KEY, v); } catch { /* private mode */ } }};
  let disabled = false;
  try { disabled = new URLSearchParams(win.location.search).get("sfx") === "off"; } catch { /* no location */ }
  let on = !disabled && store.get() === "on", duck = false, player = null, loading = null, unlocked = false, last = -1e9;
  const buttons = new Set(), now = () => (win.performance ? win.performance.now() : Date.now());
  const ducked = () => !!(typeof duck === "function" ? duck() : duck);
  const level = () => VOLUME * (ducked() ? DUCK : 1);

  function ensure() {
    if (player || loading || !on) return loading || Promise.resolve(player);
    loading = load().then(m => { player = m.createUISFX({pack: PACK, volume: level()}); if (unlocked) player.unlock(); return player; })
      .catch(e => { console.warn("sound effects unavailable:", e.message); return null; }).finally(() => { loading = null; });
    return loading;
  }
  // unlock once, on the first trusted gesture after the player exists (Safari wants it inside the gesture)
  const onGesture = e => { if (!e.isTrusted) return; unlocked = true;
    if (player) player.unlock().then(ok => { if (ok) { win.removeEventListener("pointerdown", onGesture, true); win.removeEventListener("keydown", onGesture, true); } }); };
  if (win.addEventListener) { win.addEventListener("pointerdown", onGesture, true); win.addEventListener("keydown", onGesture, true); }
  if (win.document && win.document.addEventListener) win.document.addEventListener("visibilitychange", () => { if (win.document.hidden && player) player.stopAll(); });

  function play(cue) {
    if (!on || disabled || (win.document && win.document.hidden)) return false;
    const t = now(); if (t - last < GAP_MS) return false; last = t;
    const go = p => { if (!p || !on) return; p.setVolume(level()); p.play(cue); };
    if (player) go(player); else ensure().then(go);
    return true;
  }
  function paint() { for (const b of buttons) { b.setAttribute("aria-checked", String(on)); b.dataset.on = on ? "1" : "0"; } }
  function set(v, {cue = true} = {}) {
    v = !!v && !disabled; if (v === on) { paint(); return; }
    if (!v && cue) { play("toggle-off"); last = -1e9; }
    on = v; store.set(on ? "on" : "off"); paint();
    if (on) { ensure(); if (cue) { last = -1e9; play("toggle-on"); } } else if (player) player.stopAll();
  }
  function bind(button) {
    if (!button) return;
    if (disabled) { button.hidden = true; return; }
    buttons.add(button); paint();
    button.addEventListener("click", e => { e.preventDefault(); e.stopPropagation(); set(!on); });
  }
  return {on: () => on, set, toggle: () => set(!on), play, bind, paint, setDuck: v => { duck = v; }, ducked, level, disabled,
    loaded: () => !!player};
}

let single = null;
export const uiSound = () => (single || (single = createUISound()));
export const sfx = cue => (typeof window !== "undefined" && window.localStorage ? uiSound().play(cue) : false);
