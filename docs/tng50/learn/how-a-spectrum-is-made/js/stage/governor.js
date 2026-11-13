// Quality governor (DESIGN_final §3.1 D13, C_eng P2-4): picks the volume render scale from CPU frame times, with hysteresis.
// No GPU timer queries (patchy); the frame time is the rAF-to-rAF interval the caller measures. Pure and deterministic:
// createGovernor({ladder, start, targetMs, slowN, fastN}) -> {push(ms) -> scale, scale, index, reset(), state()}
//   5 consecutive frames slower than targetMs·slowF drop one rung; 60 consecutive frames faster than targetMs·fastF raise one.
//   Frames longer than 250 ms (tab switch, a long load) are ignored. A drop resets both counters.
export const LADDER = [0.35, 0.5, 0.6, 0.75];
/* S0 freeze (notes/story2/S0.md §2): the stage's ladder is 0.75 / 0.6 / 0.5 / 0.5h / 0.35h, where h = far volume at half rate
   (drawn every other frame; near segment, splats, cells, beam, post, dock and DOM stay at full rate). G5b counts 0.5h as
   passing ("chosen scale >= 0.5"); 0.35h is the Iris-Xe floor. Rungs are {scale, half}; createGovernor takes either form. */
export const RUNGS = [{scale: 0.35, half: true}, {scale: 0.5, half: true}, {scale: 0.5, half: false}, {scale: 0.6, half: false}, {scale: 0.75, half: false}];
export const rungOf = r => (typeof r === "number" ? {scale: r, half: false} : {scale: r.scale, half: !!r.half});
export const rungName = r => { const q = rungOf(r); return `${q.scale}${q.half ? "h" : ""}`; };
/* index of a rung in a ladder from a number (full rate) or a name like "0.5h" */
export function rungIndex(ladder, want) {
  const w = typeof want === "string" ? {scale: parseFloat(want), half: /h$/.test(want)} : rungOf(want);
  const i = ladder.findIndex(r => { const q = rungOf(r); return Math.abs(q.scale - w.scale) < 1e-6 && q.half === w.half; });
  return i; }
export function createGovernor({ladder = LADDER, start = 1, targetMs = 16.7, slowN = 5, fastN = 60, slowF = 1.15, fastF = 0.75, min = 0} = {}) {
  let i = Math.max(min, Math.min(ladder.length - 1, start)), slow = 0, fast = 0, drops = 0, raises = 0;
  const g = {
    push(ms) {
      if (!(ms > 0) || ms > 250) return ladder[i];
      if (ms > targetMs * slowF) { slow++; fast = 0; } else if (ms < targetMs * fastF) { fast++; slow = 0; } else { slow = 0; fast = 0; }
      if (slow >= slowN && i > min) { i--; slow = fast = 0; drops++; }
      else if (fast >= fastN && i < ladder.length - 1) { i++; slow = fast = 0; raises++; }
      return ladder[i];
    },
    get scale() { return ladder[i]; }, get index() { return i; },
    set index(k) { i = Math.max(min, Math.min(ladder.length - 1, k)); slow = fast = 0; },
    reset(k = start) { i = Math.max(min, Math.min(ladder.length - 1, k)); slow = fast = drops = raises = 0; },
    state: () => ({scale: rungOf(ladder[i]).scale, half: rungOf(ladder[i]).half, rung: rungName(ladder[i]), index: i, slow, fast, drops, raises, targetMs,
      g5b: rungOf(ladder[i]).scale >= 0.5})};
  return g;
}
