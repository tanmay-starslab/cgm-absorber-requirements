// Story event bus (DESIGN_final §5.11). Tiny synchronous pub/sub shared by the stage, dock, equations and HUD.
//
// Event names in use (payloads):
//   "brush"    {ion, v0, v1}                         dock velocity range ↔ cells on the beam
//   "hover"    {cellIdx} | {cloudId} | {term}         one hovered thing, null clears
//   "override" {key, value}                          user changes mid-story (R, sn, ion, tf, T125, T263, N492, iso, ...)
//   "orbit"    {phase: "start" | "move" | "end", dx, dy, pointerType}   grab-to-orbit (desktop drag, touch Look mode)
//   "input"    {kind}                                any user input that moves the clock (Watch pauses on it)
//   "jump"     {to, from, kind}                      a quantised beat / stop jump
//   "hold"     {on}                                  hold-to-fly started / stopped
//   "look"     {on}                                  touch Look toggle

export function createBus() {
  const map = new Map();
  const bus = {
    on(name, fn) { if (!map.has(name)) map.set(name, new Set()); map.get(name).add(fn); return () => bus.off(name, fn); },
    off(name, fn) { const s = map.get(name); if (s) s.delete(fn); },
    once(name, fn) { const off = bus.on(name, x => { off(); fn(x); }); return off; },
    emit(name, payload) {
      const s = map.get(name); if (!s) return 0;
      let n = 0; for (const fn of [...s]) { try { fn(payload); n++; } catch (e) { if (typeof console !== "undefined") console.error(`bus ${name}:`, e); } }
      return n;
    },
    clear() { map.clear(); },
  };
  return bus;
}

/* the page-wide bus (modules that are not handed one import this) */
export const bus = createBus();
