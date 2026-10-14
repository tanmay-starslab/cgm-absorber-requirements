// levelForView (docs/tng50/js/vizdata.js, design §5.4, §5.11 item 3): desktop/mobile × hVis 20/60/200 × deviceMemory 2/8.
import {levelForView, viewPlan} from "../../docs/tng50/js/vizdata.js";
let fails = 0; const check = (ok, msg) => { console.log(`${ok ? "ok  " : "FAIL"} ${msg}`); if (!ok) fails++; };
const T = [   // mobile, hVis, deviceMemory -> gas, stars, parallel
  [false, 20, 8, "L1,L0,L2", "S1,S2", true], [false, 60, 8, "L1,L0,L2", "S1,S2", true], [false, 200, 8, "L1,L0,L2", "S1,S2,S0", true],
  [false, 20, 2, "L1,L0,L2", "S1,S2", false], [false, 60, 2, "L1,L0,L2", "S1,S2", false], [false, 200, 2, "L1,L0,L2", "S1,S2,S0", false],
  [true, 20, 8, "L1,L0,L2", "S1,S2", false], [true, 45, 8, "L1,L0,L2", "S1,S2", false], [true, 60, 8, "L1,L0", "S1", false], [true, 200, 8, "L1,L0", "S1", false],
  [true, 20, 2, "L1,L0,L2", "S1,S2", false], [true, 60, 2, "L1,L0", "S1", false], [true, 200, 2, "L1,L0", "S1", false]];
for (const [mobile, h, dm, g, s, par] of T) { const r = levelForView({hVisKpc: h, mobile, deviceMemory: dm});
  check(r.gas.join() === g && r.stars.join() === s && r.parallel === par, `${mobile ? "mobile " : "desktop"} hVis ${String(h).padStart(3)} mem ${dm}: gas ${r.gas.join()} stars ${r.stars.join()} parallel ${r.parallel}`); }
check(levelForView({hVisKpc: 151}).stars.includes("S0") && !levelForView({hVisKpc: 150}).stars.includes("S0") && levelForView({hVisKpc: 59.9, mobile: true}).gas.includes("L2") && !levelForView({hVisKpc: 60, mobile: true}).gas.includes("L2"),
  "thresholds: S0 when hVis > 150 (desktop); mobile L2/S2 when hVis < 60 (tune2; was 40)");
check(levelForView({}).gas.join() === "L1,L0,L2", "defaults (no arguments) → desktop policy");
/* final: viewPlan, the staged cold-load order (field L0 first, then L1, then the star level; L2 / S2 / S0 only when the view needs them) */
const P = o => viewPlan(o).order.map(x => x.join(":")).join(",");
const DEF = {ratio: {L1: 3.4, L2: 0.72, S1: 2.3, S2: 0.48}, hVisKpc: 101};     // the default 1440×900 view (DEF_D 520 kpc, fov 22°)
check(P({...DEF, stars: true}) === "gas:L0,gas:L1,stars:S1", `default desktop view: ${P({...DEF, stars: true})}`);
check(P({...DEF, stars: false}) === "gas:L0,gas:L1", `default view, stars off: ${P({...DEF})}`);
check(P({ratio: {L1: 14, L2: 3.5, S1: 9, S2: 2.3}, hVisKpc: 25, stars: true}) === "gas:L0,gas:L1,stars:S1,gas:L2,stars:S2", "zoomed in (hVis 25): L2 and S2 added after the base levels");
check(P({ratio: {L1: 1.0, L2: 0.25, S1: 0.7, S2: 0.17}, hVisKpc: 300, stars: true}) === "gas:L0,gas:L1,stars:S1,stars:S0", "zoomed out (hVis 300): S0 added, no L2 / S2");
check(P({ratio: {L1: 0.3, L2: 0.07, S1: 0.2, S2: 0.05}, hVisKpc: 1200, stars: true}) === "gas:L0,stars:S1,stars:S0", "very wide view: L1 skipped (under half a footprint)");
check(P({ratio: {L1: 14, L2: 3.5, S1: 9, S2: 2.3}, hVisKpc: 70, mobile: true, stars: true}) === "gas:L0,gas:L1,stars:S1", "mobile hVis 70: no L2 / S2 even when resolved");
check(P({ratio: {L1: 14, L2: 3.5, S1: 9, S2: 2.3}, hVisKpc: 40, mobile: true, stars: true}) === "gas:L0,gas:L1,stars:S1,gas:L2,stars:S2", "mobile hVis 40: L2 / S2 allowed");
check(P({ratio: {L1: 1, L2: 0.2, S1: 1, S2: 0.2}, hVisKpc: 300, mobile: true, stars: true}) === "gas:L0,gas:L1,stars:S1", "mobile never loads S0");
check(P({ratio: {L1: 3, L2: 0.999}, hVisKpc: 100}) === "gas:L0,gas:L1" && P({ratio: {L1: 3, L2: 1.0}, hVisKpc: 100}) === "gas:L0,gas:L1,gas:L2", "L2 threshold at ratio 1 (the shader's full-weight footprint)");
check(P({}) === "gas:L0,gas:L1", "no ratios → L0, L1");
console.log(fails ? `\n${fails} check(s) FAILED` : "\nall checks passed");
process.exit(fails ? 1 : 0);
