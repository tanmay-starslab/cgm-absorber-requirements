// Faddeeva/Voigt accuracy of docs/tng50/js/fit.js against scipy.special.wofz (fixture points; design-3 section 8 U_fit 1).
import {readFileSync} from "node:fs";
import {join, dirname} from "node:path";
import {fileURLToPath} from "node:url";
import {faddeeva, FIT_PARAMS} from "../../docs/tng50/js/fit.js";

const fx = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), "fixtures", "fit_cases.json"), "utf8"));
let fails = 0;
const check = (ok, msg) => { console.log(`${ok ? "ok  " : "FAIL"} ${msg}`); if (!ok) fails++; };
let core = 0, coreIm = 0, wing = 0, wingIm = 0, nc = 0, nw = 0;
for (const [u, a, re, im] of fx.voigt) {
  const [r, i] = faddeeva(u, a);
  if (Math.abs(u) <= FIT_PARAMS.asymU) { core = Math.max(core, Math.abs(r - re)); coreIm = Math.max(coreIm, Math.abs(i - im)); nc++; }
  else { wing = Math.max(wing, Math.abs(r - re) / Math.abs(re)); wingIm = Math.max(wingIm, Math.abs(i - im) / Math.abs(im)); nw++; }
  const [rm] = faddeeva(-u, a); if (Math.abs(rm - r) > 1e-15 * Math.max(1, Math.abs(r))) check(false, `H(a, u) even in u at u=${u}, a=${a}`);
}
check(nc + nw === 120, `${nc + nw} fixture points (a in [1e-7, 1], u in [0, 1e5])`);
check(core <= 1e-10, `|u| <= ${FIT_PARAMS.asymU}: max |Re w - Re wofz| = ${core.toExponential(2)} (tol 1e-10), max |d Im w| = ${coreIm.toExponential(2)} (${nc} points)`);
check(wing <= 2e-5, `|u| > ${FIT_PARAMS.asymU}: max relative |d Re w| = ${wing.toExponential(2)} (tol 2e-5), relative |d Im w| = ${wingIm.toExponential(2)} (${nw} points)`);
// continuity across the switch to the asymptotic series
{ let worst = 0; for (const a of [1e-7, 1e-3, 0.05, 0.2, 1]) { const lo = faddeeva(FIT_PARAMS.asymU, a)[0], hi = faddeeva(FIT_PARAMS.asymU * (1 + 1e-12), a)[0]; worst = Math.max(worst, Math.abs(hi - lo) / lo); }
  check(worst <= 2e-5, `H continuous at |u| = ${FIT_PARAMS.asymU}: max relative jump ${worst.toExponential(2)}`); }
// H(0, 0) = 1 and the Dawson-type value at a = 0 is the Gaussian
{ const [h0] = faddeeva(0, 0), [h1] = faddeeva(1.5, 0); check(Math.abs(h0 - 1) < 1e-13 && Math.abs(h1 - Math.exp(-2.25)) < 1e-13, `H(0,0) = ${h0}, H(0,1.5) = exp(-2.25) to ${Math.abs(h1 - Math.exp(-2.25)).toExponential(1)}`); }
console.log(`${fails ? "FAIL" : "PASS"} fit_voigt: ${fx.voigt.length} points, ${fails} failures`);
process.exit(fails ? 1 : 0);
