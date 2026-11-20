// Device tier (perf R5). The page head (_template.html #tier-gate) sets html[data-tier] = low | mid | high from cheap
// signals before first paint; tierReady() refines it once per session, after first paint, with the explainer's WebGL
// probe (learn/.../js/stage/glcheck.js probeGL: software GL, failIfMajorPerformanceCaveat, a micro-benchmark). The probe
// is skipped when the tier is forced (?tier=), already low, already probed this session, or the page has no head gate.
export const tier = () => document.documentElement.dataset.tier || null;
let P = null;
export function tierReady() {
  const T = window.tngTier;
  if (!T || T.forced || T.gl || tier() === "low") return Promise.resolve(tier());
  return P ||= new Promise(r => requestAnimationFrame(() => setTimeout(r, 0)))
    .then(() => import("../learn/how-a-spectrum-is-made/js/stage/glcheck.js"))
    .then(({probeGL}) => { const p = probeGL(); return T.probed({stills: p.tier === "stills", renderer: p.renderer || "", why: p.reason || ""}); }, () => tier());
}
