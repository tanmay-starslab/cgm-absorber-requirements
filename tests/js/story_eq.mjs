// Floating-equation gate of the story (DESIGN_final §5.5 U_eq acceptance).
// Usage: node tests/js/story_eq.mjs [--shots DIR]          node part (always)
//        TNG_BROWSER=1 node tests/js/story_eq.mjs          + browser part (fonts, proxies, keyboard, drag, spring back)
//        KATEX_DIR=<node_modules/katex> ...                 + rebuild check (eq.json and vendor/katex reproduce)
// Node checks:
//   - eq/eq.json: schema, E1-E8 + E3b, every layer has html, every term id used in the TeX has a definition, every
//     bound number is a placeholder (no number baked into the page), the html has no <script> and no caret notation
//   - every binding resolves to a key of the story data / FrameState (derived bindings: each input resolves)
//   - ghost drags never mutate data (deep-frozen data, JSON identical after every ghost)
//   - E4 on cell 263 -> -51.6 km/s (from the exporter's lam_obs; V -> lambda -> V round trip exact)
//   - E2 on cell 125: T 11 500 K, b_H 13.8, b_O 3.45 km/s, b_H/b_O = 3.98 (and = sqrt(m_O/m_H), = sqrt(2kT/m) to 0.5 %)
//   - T drag: f(O VI) table reproduced at the nodes; interpolation between the -4.0 and -3.5 slices for cell 263; both
//     fade temperatures are half-peak points; regime flags; a ghost at the cell's own T equals the data; fade keys
//     from the exporter win when present
//   - N slider 10^12 -> 10^19 for H I (B10), wings flag above 10^18.5, N492 named override
//   - runtime ships no katex.js (js/eq imports, vendor/katex contents)
//   - planner: <= 2 equations except the B7b chain (one block); phones step one equation with u; narrow = chip;
//     reveal is a pure function of p and does not fade at a beat edge the neighbour shares
// Browser checks (1440 x 900 and 390 x 844): every KaTeX face loads, no text node uses a face that is not vendored;
// draggable terms are role="slider" with aria-valuemin/max/now/valuetext and data-noscrub; value-row proxies >= 44 px
// tall; every proxy inside its box; ArrowRight steps the slider and emits a ghost; Escape clears it; a mouse drag emits
// ghosts and springs back to null on release; Pin keeps the ghost; the R term emits an R override; no katex.js request;
// no console error. Screenshots go to --shots (default: none).
import {readFileSync, existsSync, readdirSync, writeFileSync, mkdtempSync, rmSync} from "node:fs";
import {join, resolve, dirname} from "node:path";
import {tmpdir} from "node:os";
import {execFileSync} from "node:child_process";
import {fileURLToPath} from "node:url";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const ROOT = join(REPO, "docs/tng50/learn/how-a-spectrum-is-made");
const argv = process.argv.slice(2), shotsDir = argv.includes("--shots") ? resolve(argv[argv.indexOf("--shots") + 1]) : null;
let fails = 0, passes = 0;
const ok = (c, msg) => { if (c) passes++; else { fails++; console.log("FAIL " + msg); } };
const near = (a, b, tol, msg) => ok(Number.isFinite(a) && Math.abs(a - b) <= tol, `${msg}: ${a} vs ${b} (tol ${tol})`);

const B = await import(join(ROOT, "js/eq/bind.js"));
const {planEquations, itemHTML, trail} = await import(join(ROOT, "js/eq/equations.js"));
const EQ = JSON.parse(readFileSync(join(ROOT, "eq/eq.json"), "utf8"));
const data = JSON.parse(readFileSync(join(ROOT, "data/story_488530_rand_b062_a062.json"), "utf8"));
const fion = JSON.parse(readFileSync(join(ROOT, "data/fion_OVI_slice.json"), "utf8"));

/* ---------------------------------------------------------------- eq.json */
ok(EQ.schema === "story-eq/1", "schema story-eq/1");
for (const id of ["E1", "E2", "E3", "E3b", "E4", "E5", "E6", "E7", "E8"]) ok(EQ.eqs[id], `equation ${id} present`);
const fmtNames = new Set(Object.keys(B.FORMATS));
for (const E of Object.values(EQ.eqs)) {
  ok(E.title && E.beats && E.beats.length, `${E.id}: title and beats`);
  if (E.svg) ok(existsSync(join(ROOT, "eq", E.svg + ".svg")), `${E.id}: fallback svg eq/${E.svg}.svg exists`);
  for (const [vk, v] of Object.entries(E.variants)) {
    ok(v.short && v.short.values.length >= 1 && v.short.values.every(x => v.val.values.includes(x)) && v.short.box_em,
      `${E.id}.${vk}: short layer = one headline clause of the value line, measured`);
    for (const L of ["val", "sym", "short"]) {
      const h = v[L].html;
      ok(h.startsWith('<span class="katex">'), `${E.id}.${vk}.${L}: KaTeX html`);
      ok(!/<script/i.test(h), `${E.id}.${vk}.${L}: no script`);
      ok(!/\^/.test(h.replace(/<[^>]*>/g, "")), `${E.id}.${vk}.${L}: no caret notation in the rendered text`);
      for (const t of v[L].terms) ok(E.terms[t], `${E.id}.${vk}.${L}: term ${t} defined`);
      for (const val of v[L].values) {
        ok(E.terms[val] && E.terms[val].fmt && fmtNames.has(E.terms[val].fmt), `${E.id}.${vk}.${L}: value ${val} has a known format`);
        // the four parts of each bound number, holding placeholders only
        for (const part of ["m", "t", "p", "e"]) ok(h.includes(`data-v="${val}" data-part="${part}"`), `${E.id}.${vk}.${L}: ${val} part ${part}`);
      }
      const baked = [...h.matchAll(/data-part="m"><span class="enclosing eqv[^"]*"><span class="mord[^"]*">([^<]*)</g)].map(m => m[1]);
      ok(baked.every(x => x === "0.00"), `${E.id}.${vk}.${L}: only placeholders in value spans (${baked.join(",")})`);
    }
    for (const m of v.spoken.matchAll(/\{\{(\w+)\}\}/g)) ok(E.terms[m[1]], `${E.id}.${vk}: spoken {{${m[1]}}} defined`);
  }
}
ok(Array.isArray(EQ.fonts) && EQ.fonts.length >= 2 && EQ.fonts.every(f => existsSync(join(ROOT, "vendor/katex/fonts", f))), "every listed font is vendored");

/* ---------------------------------------------------------------- bindings resolve to keys */
const FS_SPEC = new Set(["R", "sn"]), LIVE = new Set(["tau_peak", "F_min", "chi2nu", "logNa"]);
function checkSource(src, field, ion, where) {
  const I = data.ions[ion];
  switch (src) {
    case "cell": return ok(Array.isArray(I.cells[field]) && I.cells[field].length === data.meta.n_cells, `${where}: cells.${field} (${ion})`);
    case "atom": return ok(typeof I.atom[field] === "number", `${where}: atom.${field} (${ion})`);
    case "totals": return ok(typeof I.totals[field] === "number", `${where}: totals.${field} (${ion})`);
    case "aod": return ok(typeof I.library.aod[field] === "number", `${where}: library.aod.${field} (${ion})`);
    case "meta": return ok(typeof data.meta[field] === "number", `${where}: meta.${field}`);
    case "spec": return ok(FS_SPEC.has(field), `${where}: FrameState.spec.${field}`);
    case "live": return ok(LIVE.has(field), `${where}: live.${field} (spectrum readout)`);
    default: return ok(false, `${where}: unknown source ${src}`);
  }
}
for (const E of Object.values(EQ.eqs)) for (const [tid, t] of Object.entries(E.terms)) {
  if (!t.bind) { ok(!t.fmt, `${E.id}.${tid}: unbound term shows no number`); continue; }
  for (const ion of ["HI", "OVI"]) {
    let b = t.bind;
    while (b) {
      if (b.src === "derived") {
        ok(B.DERIVED[b.fn] && B.DERIVED_INPUTS[b.fn], `${E.id}.${tid}: derived ${b.fn} known`);
        for (const [s, f] of B.DERIVED_INPUTS[b.fn] || []) checkSource(s, f, ion, `${E.id}.${tid} <- ${b.fn}`);
      } else checkSource(b.src, b.field, ion, `${E.id}.${tid}`);
      b = b.fallback;
    }
  }
}
// every value of every equation resolves on cell 263 (O VI), 125 (H I) with an instrument and totals anchor
for (const E of Object.values(EQ.eqs)) for (const [ion, idx] of [["OVI", 263], ["HI", 125]]) {
  const v = B.termValues(E, {data, ion, idx, spec: {R: 15000, sn: 10}, live: {chi2nu: 1.02}, anchorKind: "totals"});
  for (const [tid, t] of Object.entries(E.terms)) if (t.fmt) ok(Number.isFinite(v[tid]), `${E.id}.${tid} resolves on ${ion} cell ${idx}: ${v[tid]}`);
}

/* ---------------------------------------------------------------- ghosts never mutate data */
const deepFreeze = o => { if (o && typeof o === "object" && !Object.isFrozen(o)) { Object.freeze(o); for (const k of Object.keys(o)) deepFreeze(o[k]); } return o; };
const before = JSON.stringify(data);
const frozen = deepFreeze(JSON.parse(before)), frozenF = deepFreeze(JSON.parse(JSON.stringify(fion)));
const GH = [["E1", "dl", "OVI", 263, Math.log10(5)], ["E1", "Z", "OVI", 263, -1], ["E2", "T", "OVI", 263, 6], ["E2", "T", "HI", 125, 4.5],
  ["E3", "N", "HI", 492, 19], ["E3", "tau0", "OVI", 43, 0], ["E3b", "V", "OVI", 296, 40], ["E4", "lam", "OVI", 263, -20]];
let threw = null;
for (const [eq, term, ion, idx, s] of GH) {
  try {
    const g = B.ghostCell(frozen, frozenF, {eq, term, ion, idx, s});
    ok(g && g.cell && Number.isFinite(g.cell.b), `ghost ${eq}.${term} on ${idx}`);
    B.termValues(EQ.eqs[eq], {data: frozen, ion, idx, spec: {}, ghost: g});
  } catch (e) { threw = `${eq}.${term}: ${e.message}`; }
}
ok(!threw, `ghost computations do not write into data (${threw})`);
ok(JSON.stringify(frozen) === before, "story data unchanged after every ghost");

/* ---------------------------------------------------------------- E4, E2 */
const vgal = B.vGal(data);
near(vgal, data.facts2 && typeof data.facts2.v_gal === "number" ? data.facts2.v_gal : -data.meta.v_sys_kms, 1e-9, "v_gal from facts2 (else -v_sys)");
near(vgal, -data.meta.v_sys_kms, 0.006, "v_gal = -v_sys");
if (data.keys.v_gal != null) near(B.num(data.keys.v_gal), vgal, 0.051, "v_gal display key agrees");
const V263 = B.vOfLam(data.worked.S5.lam_obs_A, data.ions.OVI.atom.lam0_A, vgal);
ok(B.formatParts(V263, "fix1s").m === "−51.6", `E4 on cell 263 from lambda_obs: ${V263.toFixed(3)} -> -51.6 km/s`);
const l263 = B.lamOfV(data.ions.OVI.cells.V[263], data.ions.OVI.atom.lam0_A, vgal);
near(B.vOfLam(l263, data.ions.OVI.atom.lam0_A, vgal), data.ions.OVI.cells.V[263], 1e-9, "E4 V -> lambda -> V round trip");
near(l263, data.worked.S5.lam_obs_A, 0.0005, "E4 lambda of cell 263 = exporter lam_obs");
const e4 = B.termValues(EQ.eqs.E4, {data, ion: "OVI", idx: 263});
ok(B.formatParts(e4.V, "fix1s").m === "−51.6" && B.formatParts(e4.vgal, "fix1s").m === "+69.3", "E4 displays V = -51.6, v_gal = +69.3");
const e2 = B.termValues(EQ.eqs.E2, {data, ion: "HI", idx: 125});
ok(B.formatParts(e2.T, "grp").m === "11 500", `E2 cell 125 T shows 11 500 K (${B.formatParts(e2.T, "grp").m})`);
ok(B.formatParts(e2.b, "sig3").m === "13.8" && B.formatParts(e2.b_alt, "sig3").m === "3.45", "E2 cell 125 b_H 13.8, b_O 3.45 km/s");
ok((e2.b / e2.b_alt).toFixed(2) === "3.98", `E2 b_H/b_O = ${(e2.b / e2.b_alt).toFixed(4)} -> 3.98`);
near(e2.b_alt, data.ions.OVI.cells.b[125], 0.002, "E2 b_O (derived) = exporter O VI b of cell 125");
near(B.doppler(e2.T, data.ions.HI.atom.mass_amu) / e2.b, 1, 0.005, "E2 sqrt(2kT/m) reproduces the exporter's b");
if (B.fact(data, "cloudA_core_T") != null) {    // facts2 full precision when present, else the display key's precision
  const p = data.facts2 && typeof data.facts2.cloudA_core_T === "number";
  near(e2.T / B.fact(data, "cloudA_core_T"), 1, p ? 1e-9 : 0.005, "E2 T = cloudA_core_T");
  near(e2.b, B.fact(data, "cloudA_core_bH"), p ? 0.005 : 0.051, "E2 b_H = cloudA_core_bH");
  near(e2.b_alt, B.fact(data, "cloudA_core_bO"), p ? 0.002 : 0.0051, "E2 b_O = cloudA_core_bO");
  if (data.keys.cloudA_core_bH) ok(B.formatParts(e2.b, "sig3").m === data.keys.cloudA_core_bH && B.formatParts(e2.b_alt, "sig3").m === data.keys.cloudA_core_bO, "E2 displays the same digits as the cloudA_core_b keys");
} else console.log("note: cloudA_core_* keys not in this story data yet (U_data); E2 checked against cell 125 directly");

/* ---------------------------------------------------------------- f(O VI) interpolation, fades, T ghost */
for (let k = 0; k < fion.logNH_slices.length; k++) for (const i of [0, 30, 58, 60, 80, 120]) {
  const v = fion.f_slices[k][i], g = B.fionAt(fion, fion.logNH_slices[k], fion.logT[i]);
  ok(v <= 1e-9 ? g === 0 : Math.abs(g / v - 1) < 1e-9, `f(O VI) node slice ${k} logT ${fion.logT[i]}: ${g} vs ${v}`);
}
const lnH = Math.log10(data.ions.OVI.cells.nH[263]);
ok(lnH > -4.0 && lnH < -3.5, `cell 263 log n_H ${lnH.toFixed(3)} lies between the -4.0 and -3.5 slices`);
{
  const i = fion.logT.indexOf(5.5), lf = k => Math.log10(fion.f_slices[k][i]);
  const k4 = fion.logNH_slices.indexOf(-4.0), k35 = fion.logNH_slices.indexOf(-3.5), u = (lnH + 4.0) / 0.5;
  near(Math.log10(B.fionAt(fion, lnH, 5.5)), lf(k4) * (1 - u) + lf(k35) * u, 1e-12, "f(O VI) at cell 263 n_H: linear in log n_H between the -4.0 and -3.5 slices");
}
const fd = B.fadeTemps(fion, lnH);
ok(fd.cool < fd.peak && fd.peak < fd.hot, `fade temperatures bracket the peak: ${fd.cool.toFixed(0)} < ${fd.peak.toFixed(0)} < ${fd.hot.toFixed(0)} K`);
near(B.fionAt(fion, lnH, Math.log10(fd.hot)) / fd.fpeak, 0.5, 0.01, "hot fade is a half-peak point");
near(B.fionAt(fion, lnH, Math.log10(fd.cool)) / fd.fpeak, 0.5, 0.01, "cool fade is a half-peak point");
const fk = B.fadeTemps(fion, lnH, {keys: {ovi_T_cool_fade: "1.5\u00d710\u2075", ovi_T_hot_fade: "6\u00d710\u2075"}});
ok(fk.cool === 1.5e5 && fk.hot === 6e5 && fk.source === "keys", "exporter fade keys win when present");
ok(B.fadeTemps(fion, lnH - 1, {facts2: {ovi_T_fade: {lognH: lnH}, ovi_T_hot_fade: 6e5, ovi_T_cool_fade: 1.5e5}}).source === "table", "fade facts apply only at the n_H they were computed for");
ok(B.num("\u221251.6") === -51.6 && B.num("5\u00d710\u207b\u2076") === 5e-6 && B.num("1.15\u00d710\u2074") === 11500 && B.vGal({keys: {v_gal: "+69.3"}}) === 69.3, "display keys parse (minus sign, x10 superscripts)");
if (B.fact(data, "ovi_T_hot_fade") != null) {     // the exporter's half-peak points vs this module's table interpolation
  near(B.fact(data, "ovi_T_hot_fade") / fd.hot, 1, 0.003, "ovi_T_hot_fade (exporter) = table half-peak at cell 263");
  near(B.fact(data, "ovi_T_cool_fade") / fd.cool, 1, 0.003, "ovi_T_cool_fade (exporter) = table half-peak at cell 263");
  const fx = B.fadeTemps(fion, lnH, data); ok(fx.source !== "table" && fx.hot === B.fact(data, "ovi_T_hot_fade"), `T drag uses the exporter's fade facts at cell 263 (${fx.source})`);
} else console.log("note: ovi_T_*_fade keys not in this story data yet (U_data); fades checked against the table");
const T263 = data.ions.OVI.cells.T[263];
const gSame = B.ghostCell(data, fion, {eq: "E2", term: "T", ion: "OVI", idx: 263, s: Math.log10(T263)});
near(gSame.cell.logN, data.ions.OVI.cells.logN[263], 1e-9, "T ghost at the cell's own T keeps N");
near(gSame.cell.tau0, data.ions.OVI.cells.tau0[263], 1e-9, "T ghost at the cell's own T keeps tau0");
const gHot = B.ghostCell(data, fion, {eq: "E2", term: "T", ion: "OVI", idx: 263, s: Math.log10(fd.hot * 1.5)});
const gCool = B.ghostCell(data, fion, {eq: "E2", term: "T", ion: "OVI", idx: 263, s: Math.log10(fd.cool / 1.5)});
ok(gHot.regime === "hot" && gCool.regime === "cool" && gSame.regime === null, "regime flags: too hot / too cool / none");
ok(gHot.cell.logN < data.ions.OVI.cells.logN[263] && gHot.cell.b > data.ions.OVI.cells.b[263], "hotter: less O VI, wider");
near(gHot.cell.b / data.ions.OVI.cells.b[263], Math.sqrt(fd.hot * 1.5 / T263), 1e-9, "T ghost width scales as sqrt(T)");
ok(gHot.notes.includes("n_H and Z held fixed"), "T ghost note: n_H and Z held fixed");
const n263 = B.namedOverride(gHot);
ok(n263 && n263.key === "T263" && n263.value === gHot.cell.T, "T ghost on cell 263 maps to the T263 override");

/* ---------------------------------------------------------------- sliders, N range, wings */
const sN = B.sliderSpec(EQ.eqs.E3, "N", {data, ion: "HI", idx: 492});
ok(sN && sN.min === 12 && sN.max === 19, `B10 N slider for H I: 10^${sN && sN.min} -> 10^${sN && sN.max}`);
const sT = B.sliderSpec(EQ.eqs.E2, "T", {data, ion: "OVI", idx: 263});
ok(sT && sT.step > 0 && sT.big > sT.step && Math.abs(sT.now - Math.log10(T263)) < 1e-12, "T slider: steps and current value");
ok(B.sliderSpec(EQ.eqs.E1, "Z", {data, ion: "HI", idx: 125}) === null, "Z drag offered for O VI only");
const g19 = B.ghostCell(data, fion, {eq: "E3", term: "N", ion: "HI", idx: 492, s: 18.6});
const g18 = B.ghostCell(data, fion, {eq: "E3", term: "N", ion: "HI", idx: 492, s: 18.4});
ok(g19.wings && !g18.wings, "wings flag above 10^18.5 only");
ok(B.namedOverride(g19).key === "N492" && B.namedOverride(g19).value === 18.6, "N ghost on cell 492 maps to the N492 override");
const gt = B.ghostCell(data, fion, {eq: "E3", term: "tau0", ion: "OVI", idx: 263, s: 1});
near(B.tau0Of(gt.cell.logN, data.ions.OVI.atom.f, data.ions.OVI.atom.lam0_A, data.ions.OVI.cells.b[263]), 10, 1e-9, "tau0 drag sets N so that tau0 = target");
const sR = B.sliderSpec(EQ.eqs.E6, "R", {data, ion: "OVI", idx: null, spec: {R: 15000}});
ok(sR && sR.override === "R", "E6 R term drives the R override");
{ const fw = B.termValues(EQ.eqs.E6, {data, ion: "OVI", spec: {R: 15000}}).fwhm;
  near(fw, B.C_KMS / 15000, 1e-12, "E6 FWHM = c/R"); ok(B.formatParts(fw, "sig3").m === (+parseFloat(data.keys.fwhm_15000)).toFixed(1), "E6 FWHM display = fwhm_15000 key"); }
near(B.termValues(EQ.eqs.E7, {data, ion: "OVI", spec: {sn: 10}}).sig, data.worked.S10 ? Math.sqrt(5) / 10 : Math.sqrt(5) / 10, 1e-12, "E7 sigma_pix = sqrt5/(S/N)");
{ const F = B.formatParts(B.termValues(EQ.eqs.E5, {data, ion: "HI", anchorKind: "totals"}).F, "F");
  ok(F.m === null && F.e === "\u2212" + Math.round(data.ions.HI.totals.peak_tau / Math.LN10), `E5 F of the H I trough shows 10^-(tau/ln10), black, no underflow (${F.e})`); }
ok(B.termValues(EQ.eqs.E5, {data, ion: "HI", anchorKind: "cell"}).taup === undefined, "E5 mid-flight needs the live readout (no end-of-flight number shown early)");

/* ---------------------------------------------------------------- no katex.js at runtime */
for (const f of readdirSync(join(ROOT, "js/eq"))) {
  const s = readFileSync(join(ROOT, "js/eq", f), "utf8");
  ok(!/(import\s*\(|from\s|src\s*=|fetch\s*\()[^\n;]*katex[^\n;]*\.m?js/.test(s), `js/eq/${f} loads no KaTeX JavaScript`);
}
const vk = readdirSync(join(ROOT, "vendor/katex"));
ok(vk.every(f => ["katex.css", "fonts", "LICENSE", "README.md"].includes(f)), `vendor/katex holds css, fonts, licence only: ${vk.join(", ")}`);
ok(readdirSync(join(ROOT, "vendor/katex/fonts")).every(f => f.endsWith(".woff2")), "vendor/katex/fonts: woff2 only");
const css = readFileSync(join(ROOT, "vendor/katex/katex.css"), "utf8");
ok([...css.matchAll(/url\(fonts\/([^)]+)\)/g)].every(m => EQ.fonts.includes(m[1])), "katex.css references only vendored fonts");

/* ---------------------------------------------------------------- planner */
const fs0 = (eqs, u, cls, i = 7) => planEquations({eqs, beat: {i, u}, spec: {lead: "OVI"}, cell: {idx: 263}}, EQ, {cls, beats: BEATS});
const BEATS = []; for (let k = 0; k < 16; k++) BEATS.push({eqs: []});
BEATS[2].eqs = ["E1"]; BEATS[3].eqs = ["E1", "E3"]; BEATS[7].eqs = ["E1", "E2", "E3"];
const chain = fs0([{id: "E1"}, {id: "E2"}, {id: "E3"}], 0.5, "desktop");
ok(chain.length === 1 && chain[0].chain && chain[0].ids.join() === "E1,E2,E3", "B7b chain is one block on desktop");
ok(itemHTML(chain[0], EQ).split("eq-arrow").length - 1 === 2 && itemHTML(chain[0], EQ).includes("eq-dip"), "chain has SVG arrows (into tau0 and the dip) and the dip");
{ // review2_science M2: N and T are independent inputs; no arrow from the N row to the T row, compact rows say b <- T, tau0 ∝ N f λ / b
  const h = itemHTML(chain[0], EQ), iE1 = h.indexOf('data-eqid="E1"'), iE2 = h.indexOf('data-eqid="E2"'), iE3 = h.indexOf('data-eqid="E3"');
  ok(iE1 < iE2 && iE2 < iE3 && !h.slice(iE1, iE2).includes("eq-arrow") && h.slice(iE1, iE2).includes("eq-sep"), "chain: E1 -> E2 is a divider, not an arrow (M2)");
  ok(h.slice(iE2, iE3).includes("eq-arrow"), "chain: an arrow leads into the tau0 row");
  for (const [vk, V] of Object.entries(EQ.eqs.E2.variants)) {
    ok(V.shortc && V.shortc.terms.includes("b") && V.shortc.terms.includes("T") && V.shortc.tex.indexOf("@t{b}") < V.shortc.tex.indexOf("@t{T}"), `E2.${vk} compact row shows b <- T`);
  }
  const s3 = EQ.eqs.E3.variants.any.shortc;
  ok(s3 && ["tau0", "N", "b"].every(t => s3.terms.includes(t)) && /propto/.test(s3.tex), "E3 compact row: tau0 ∝ N f λ / b");
  const st = fs0([{id: "E1"}, {id: "E2"}, {id: "E3"}], 0.4, "phone portrait")[0];
  const sh = itemHTML(st, EQ);
  ok(st.key === "E2" && sh.includes("eq-shortc") && sh.includes("eq-short") && sh.includes("step 2 of 3"), "phone chain step: b <- T row, T fallback, counter 'step 2 of 3'");
  // every symbolic clause is braced (wraps only between clauses, review1_ux_overlap L2): no top-level "=" outside a group
  for (const [id, E] of Object.entries(EQ.eqs)) for (const [vk, V] of Object.entries(E.variants)) {
    let d = 0, top = 0; const t = V.sym.tex;
    for (let i = 0; i < t.length; i++) { const ch = t[i]; if (ch === "\\") { i++; continue; } if (ch === "{") d++; else if (ch === "}") d--; else if (ch === "=" && d === 0) top++; }
    ok(top === 0, `${id}.${vk} symbolic clauses braced`);
  }
}
const steps = [0.1, 0.4, 0.8].map(u => fs0([{id: "E1"}, {id: "E2"}, {id: "E3"}], u, "phone portrait"));
ok(steps.every(s => s.length === 1) && steps.map(s => s[0].key).join() === "E1,E2,E3", "phone: one chain equation at a time, stepping with u");
ok(fs0([{id: "E2"}], 0.5, "narrow")[0].mode === "chip", "narrow class: value-line chip");
ok(fs0([{id: "E5"}, {id: "E6"}, {id: "E7"}], 0.5, "desktop").length === 2, "at most two equations outside the chain");
ok(JSON.stringify(fs0([{id: "E2"}], 0.03, "desktop")) === JSON.stringify(fs0([{id: "E2"}], 0.03, "desktop")), "plan is deterministic in p");
const e1in = planEquations({eqs: [{id: "E1"}], beat: {i: 3, u: 0.0}, spec: {lead: "OVI"}, cell: {idx: 40}}, EQ, {cls: "desktop", beats: BEATS})[0];
const e3in = planEquations({eqs: [{id: "E3"}], beat: {i: 3, u: 0.0}, spec: {lead: "OVI"}, cell: {idx: 40}}, EQ, {cls: "desktop", beats: BEATS})[0];
ok(e1in.enter === 1 && e3in.enter === 0, "E1 carried from the previous beat does not re-fade; E3 entering fades in");
ok(planEquations({eqs: [{id: "E2"}], beat: {i: 9, u: 0.99}, spec: {lead: "OVI"}}, EQ, {cls: "desktop", beats: BEATS})[0].enter < 0.5, "an equation the next beat lacks fades out at the edge");
ok(trail({eqs: [{id: "E2"}], beat: {i: 8}}, EQ, BEATS).map(t => t.id).join() === "E1,E3", "formula trail lists earlier equations not on screen");

/* ---------------------------------------------------------------- integration: real beats.json + seek (U_motion) */
{
  const {makeSeek} = await import(join(ROOT, "js/core/seek.js"));
  const {createOverlay, placedBox, cloudCell, MIN_EQ_PX, hlTerm} = await import(join(ROOT, "js/eq/equations.js"));
  const beatsDoc = JSON.parse(readFileSync(join(ROOT, "beats.json"), "utf8"));
  const shotsDoc = JSON.parse(readFileSync(join(ROOT, "shots.json"), "utf8"));
  const seek = makeSeek({beats: beatsDoc, shots: shotsDoc});
  const beats = beatsDoc.beats;
  const LIVE_ONLY = new Set(["E5", "E8"]);               // need the dock's live readout (or totals) before numbers show
  const ov = createOverlay({eq: EQ, data, fion, fontPx: 15});   // no DOM: sizes from box_em
  const frozen = JSON.stringify(data);
  let nEqBeats = 0;
  for (const [bi, b] of beats.entries()) for (const e of b.eqs || []) {
    nEqBeats++;
    ok(EQ.eqs[e.id], `${b.id}: beats.json names a known equation ${e.id}`);
    for (const h of e.hl || []) { const t = hlTerm(e.id, h.term); ok(EQ.eqs[e.id] && (EQ.eqs[e.id].terms[t] || t === "@dip" && e.id === "E3" && b.id === "B7b"), `${b.id} ${e.id}: highlighted term ${h.term} -> ${t} exists`); }
    if (e.ghost) ok(["T125", "T263", "N492"].includes(e.ghost), `${b.id} ${e.id}: ghost key ${e.ghost} is a frozen override`);
    const p = b.p0 + (b.p1 - b.p0) * (e.u0 + Math.min(e.u1, 1)) / 2;
    for (const cls of ["desktop", "compact", "tablet", "phonePortrait", "phoneLandscape", "narrow"]) {
      const fs = seek(p, data, {cls});
      ok(fs.beat.id === b.id && fs.eqs.some(x => x.id === e.id), `${b.id} ${cls}: seek(${p.toFixed(4)}) shows ${e.id}`);
      const plan = planEquations(fs, EQ, {cls, beats, data});
      const max = ["desktop", "tablet"].includes(cls) ? 2 : 1;
      const off = e.noPhone && ["phonePortrait", "phoneLandscape", "narrow"].includes(cls);   // review2 three_d T3: noPhone slots
      ok(off ? plan.every(x => x.key !== e.id) : plan.length >= 1 && plan.length <= max, `${b.id} ${cls}: ${plan.length} equation item(s) (${off ? "noPhone: " + e.id + " off" : "max " + max})`);
      for (const it of plan) for (const part of it.chain ? it.parts : [it]) {
        ok(Number.isInteger(part.idx) && part.idx >= 0, `${b.id} ${cls} ${part.key}: bound to a cell (${part.idx})`);
        const def = EQ.eqs[part.key], V = def.variants[part.variant] || def.variants.any;
        const vals = B.termValues(def, {data, ion: part.ion, idx: part.idx, spec: fs.spec, live: null,
          anchorKind: part.totals ? "totals" : part.anchor.kind, ghost: null});
        const missing = V.val.values.filter(id => !B.formatParts(vals[id], def.terms[id].fmt));
        ok(!missing.length || LIVE_ONLY.has(part.key) && !part.totals, `${b.id} ${cls} ${part.key}: every value term resolves (${missing})`);
        ok(part.enter >= 0 && part.enter <= 1, `${b.id} ${cls} ${part.key}: reveal in 0..1`);
      }
      const items = ov.equations(fs, {cls, beats});
      ok(items.every(i => !i.id.startsWith("eq:") && i.rid === `eq:${i.id}`), `${b.id} ${cls}: ids are bare keys, rid = eq:<key> (hud.js prefixes)`);
      ok(items.every(i => i.size.w > 0 && i.size.h > 0 && i.size.font >= 12 && i.variants.length >= 1), `${b.id} ${cls}: sizes with glyph floor >= 12 px`);
    }
  }
  // tight bands: the shell's phone/compact eq band (js/ui/layoutclass.js) holds at least the last variant of every item
  {
    const {computeBands, typeScale} = await import(join(ROOT, "js/ui/layoutclass.js"));
    const noBand = new Set(), it0 = fs => (fs.eqs || []).map(e => e.id).join("+");
    for (const [cls, W, H] of [["phonePortrait", 390, 844], ["phonePortrait", 360, 640], ["narrow", 320, 568], ["narrow", 260, 563], ["phoneLandscape", 844, 390], ["phoneLandscape", 667, 375], ["compact", 1024, 600], ["compact", 683, 512], ["tablet", 768, 1024], ["desktop", 1440, 900], ["desktop", 1280, 800], ["desktop", 2560, 1440]]) {
      let bands = null; try { bands = computeBands(cls, W, H, {dock: "strip", textSide: "left", insets: {top: 0, right: 0, bottom: 0, left: 0}}); } catch (e) { bands = null; }
      if (!bands || !bands.eq) { ok(cls.startsWith("phoneL"), `${cls} ${W}x${H}: eq band exists (${bands && JSON.stringify(Object.keys(bands))})`); continue; }
      const px = typeScale(cls, W, H).eq, ovc = createOverlay({eq: EQ, data, fion, fontPx: px});
      for (const b of beats) for (const e of b.eqs || []) {
        const fs = seek(b.p0 + (b.p1 - b.p0) * (e.u0 + Math.min(e.u1, 1)) / 2, data, {cls});
        // the band of this frame (its dock state and text side), as the shell computes it
        const fb = computeBands(cls, W, H, {dock: (fs.spec && fs.spec.dock) || "strip", textSide: (fs.cam && fs.cam.textSide) || "left", insets: {top: 0, right: 0, bottom: 0, left: 0}});
        // the shell gives phones and small compact screens no eq band while the dock is the hero (B12a-B13): the equations
        // there (E6 R, E7 S/N, E8) are not drawn; the R and S/N dials sit in the dock header. Reported, not a U_eq defect.
        if (!fb.eq) { noBand.add(`${cls} ${W}x${H} ${b.id} ${it0(fs)}`); continue; }
        for (const it of ovc.equations(fs, {cls, beats})) {
          const last = it.variants[it.variants.length - 1];
          ok(last.w <= fb.eq.w + 0.5 && last.h + 4 <= fb.eq.h + 0.5, `${cls} ${W}x${H} ${b.id} ${it.id}: smallest variant ${last.key} ${last.w}x${last.h} fits the eq band ${Math.round(fb.eq.w)}x${Math.round(fb.eq.h)} (dock ${fs.spec && fs.spec.dock})`);
        }
      }
    }
    if (noBand.size) console.log(`# no eq band (hero dock, shell layout; equations not drawn): ${[...noBand].join(", ")}`);
  }
  ok(nEqBeats >= 12, `beats.json carries the story's equation windows (${nEqBeats})`);
  ok(JSON.stringify(data) === frozen, "seek + planning never mutate the data");

  // B6: E4 anchored to cloud A resolves to the O VI member cell with the largest tau0 inside cloud A's extent
  const b6 = beats.find(b => b.id === "B6"), e4 = b6.eqs.find(e => e.id === "E4");
  const cA = cloudCell(data, "A", "OVI");
  const segA = data.cloud_names.letters.A.OVI.map(c => c.l);
  ok(cA && cA.ion === "OVI" && segA.some(([a, z]) => data.ions.OVI.cells.l_kpc[cA.idx] >= a && data.ions.OVI.cells.l_kpc[cA.idx] <= z), `cloud A (O VI) -> cell ${cA && cA.idx} inside its extent`);
  const fs6 = seek(b6.p0 + (b6.p1 - b6.p0) * (e4.u0 + e4.u1) / 2, data, {cls: "desktop"});
  const it6 = planEquations(fs6, EQ, {cls: "desktop", beats, data}).find(i => i.key === "E4");
  ok(it6 && it6.idx === cA.idx, `B6 E4 bound to cloud A's cell (${it6 && it6.idx} vs ${cA && cA.idx})`);
  const v6 = B.termValues(EQ.eqs.E4, {data, ion: "OVI", idx: cA.idx, spec: fs6.spec, ghost: null});
  near(v6.V, data.ions.OVI.cells.V[cA.idx], 0.05, "B6 E4 V equals the cell's own v_los");

  // B7b: one chain block from the first row's entry, constant size; rows enter on their own windows; phone shows the latest
  const b7 = beats.find(b => b.id === "B7b"), at7 = u => seek(b7.p0 + (b7.p1 - b7.p0) * u, data, {cls: "desktop"});
  const early = planEquations(at7(0.26), EQ, {cls: "desktop", beats, data}), late = planEquations(at7(0.9), EQ, {cls: "desktop", beats, data});
  ok(early.length === 1 && early[0].chain && late.length === 1 && late[0].chain, "B7b: chain block from E1's entry to the end");
  ok(early[0] && early[0].parts[0].enter > 0.99 && early[0].parts[2].enter === 0, "B7b early: E1 shown, E3 row reserved at enter 0");
  ok(late[0] && late[0].parts.every(p => p.idx === 263), "B7b chain bound to cell 263");
  const sz = f => ov.equations(f, {cls: "desktop", beats})[0].size;
  ok(JSON.stringify(sz(at7(0.26))) === JSON.stringify(sz(at7(0.9))), "B7b: chain box size does not change mid-beat");
  { // review2 science M2: the phone row follows the caption (phoneU): N under "Amount sets the bite", b ← T under "Heat spreads it out"
    const row = u => planEquations(seek(b7.p0 + (b7.p1 - b7.p0) * u, data, {cls: "phonePortrait"}), EQ, {cls: "phonePortrait", beats, data})[0].key;
    const capAt = (u, id) => { const t = b7.text.find(x => x.id === id && x.band === "text"); return t && u >= t.u0 && u <= t.u1; };
    ok(capAt(0.3, "B7b") && row(0.3) === "E1" && capAt(0.75, "B7b.1") && row(0.75) === "E2" && row(0.95) === "E3",
      `B7b phone: the row matches the caption (u 0.3 ${row(0.3)}, u 0.75 ${row(0.75)}, u 0.95 ${row(0.95)})`);
  }
  {
    const ph = [{id: "E1", phase: 0}, {id: "E2", phase: -0.3}, {id: "E3", phase: -0.9}];
    const pp = planEquations({eqs: ph, beat: {i: 9, u: 0.5}, spec: {lead: "OVI"}, cell: {idx: 263}}, EQ, {cls: "phonePortrait"});
    ok(pp.length === 1 && pp[0].key === "E2" && pp[0].enter === 1, `phone chain: a row takes the slot once half in, as a step at full opacity (${pp[0] && pp[0].key} ${pp[0] && pp[0].enter})`);
  }

  // named overrides flow seek -> FrameState ghost -> plan item
  const b7c = beats.find(b => (b.eqs || []).some(e => e.ghost === "T263"));
  const fsT = seek(b7c.p0 + (b7c.p1 - b7c.p0) * 0.5, data, {cls: "desktop", T263: 3.0e5});
  const itT = planEquations(fsT, EQ, {cls: "desktop", beats, data})[0];
  ok(itT && itT.ghost && itT.ghost.term === "T" && itT.ghost.value === 3.0e5 && itT.idx === 263, `${b7c.id}: T263 override reaches E2 as a T ghost on cell 263`);
  const gT = B.ghostCell(data, fion, {eq: "E2", term: "T", ion: "OVI", idx: 263, s: Math.log10(3.0e5), spec: fsT.spec});
  near(gT.cell.T, 3.0e5, 1e-6 * 3e5, "ghost cell carries the override temperature");
  ok(JSON.stringify(data) === frozen, "override ghost never mutates the data");

  // E5 with totals: true (B11) reads the stored totals; mid-flight E5 without live stays symbolic
  const b11 = beats.find(b => (b.eqs || []).some(e => e.totals));
  const it11 = planEquations(seek(b11.p0 + (b11.p1 - b11.p0) * 0.8, data, {cls: "desktop"}), EQ, {cls: "desktop", beats, data}).find(i => i.key === "E5");
  ok(it11 && it11.totals, `${b11.id}: E5 carries totals`);

  // placement lookup accepts the solver result, its list, or plain maps
  const box = {id: "eq:E2", x: 3, y: 4};
  ok(placedBox({byId: {"eq:E2": box}}, "E2") === box && placedBox([box], "E2") === box && placedBox({"eq:E2": box}, "E2") === box && placedBox({E2: box}, "E2") === box,
    "placedBox reads solver byId, placed list and plain maps");
  ok(MIN_EQ_PX * 0.7 * 1.06 >= 12, `MIN_EQ_PX ${MIN_EQ_PX}: one script level stays >= 12 px`);
}

/* ---------------------------------------------------------------- rebuild reproduces */
if (process.env.KATEX_DIR) {
  try { execFileSync(process.execPath, [join(REPO, "scripts/story_eq_build.mjs"), "--check", "--katex", process.env.KATEX_DIR], {stdio: "pipe"}); ok(true, ""); }
  catch (e) { ok(false, "story_eq_build --check: " + String(e.stderr || e.message).trim()); }
} else console.log("note: KATEX_DIR not set; rebuild check skipped");

/* ---------------------------------------------------------------- browser */
if (process.env.TNG_BROWSER) await browser();
else console.log("browser part skipped (set TNG_BROWSER=1)");

console.log(`story_eq: ${passes} passed, ${fails} failed`);
process.exit(fails ? 1 : 0);

async function browser() {
  const {serve, launch, sleep} = await import("./lib/browser.mjs");
  const tmp = mkdtempSync(join(tmpdir(), "story-eq-")), page = join(tmp, "index.html");
  const base = "/tng50/learn/how-a-spectrum-is-made";
  writeFileSync(page, `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<link rel="stylesheet" href="${base}/css/story.css"><style>html,body{margin:0;height:100%;background:#04050a;overflow:hidden}#stage{position:fixed;inset:0}</style></head>
<body><div id="stage"></div><script type="module">
import {loadEq, createOverlay} from "${base}/js/eq/equations.js";
const [eq, data, fion] = await Promise.all([loadEq(), fetch("${base}/data/story_488530_rand_b062_a062.json").then(r => r.json()), fetch("${base}/data/fion_OVI_slice.json").then(r => r.json())]);
const events = []; const bus = {emit: (t, p) => events.push({t, p: p && JSON.parse(JSON.stringify(p))})};
const ov = createOverlay({eq, data, fion, bus, root: document.getElementById("stage"), reducedMotion: false, fontPx: 22});
let spec = {lead: "OVI", R: 15000, sn: 10};
document.documentElement.style.setProperty("--eq-size", innerWidth < 500 ? "18px" : "22px");
function show(eqs, cls, u = 0.5, lead = "OVI", live = null) {
  spec = {...spec, lead};
  const fs = {p: 0.5, beat: {id: "T", i: 1, u}, cell: {idx: 263}, eqs, spec};
  const items = ov.equations(fs, {cls, live});
  const placed = {}; let y = 24; const W = innerWidth;
  for (const it of items) { placed[it.id] = {x: Math.max(8, Math.min(40, W - it.size.w - 8)), y}; y += it.size.h + 16; }
  ov.render(fs, placed, {cls, live}); return items;
}
// solver stand-in: the first variant that fits the band (js/ui/layout.js tries variants in order), placed at its corner
function fit(eqs, cls, band, lead = "OVI", u = 0.5) {
  spec = {...spec, lead};
  const fs = {p: 0.5, beat: {id: "T", i: 1, u}, cell: {idx: 263}, eqs, spec};
  const items = ov.equations(fs, {cls, band});
  const placed = {}, picks = []; let y = band.y;
  for (const it of items) {
    const vi = it.variants.findIndex(v => v.w <= band.w && v.h + 4 <= band.y + band.h - y);   // + 4: the shell registers eq boxes 4 px taller (hud.js padEq)
    picks.push({id: it.id, vi, keys: it.variants.map(v => v.key + ":" + v.w + "x" + v.h)});
    if (vi < 0) { placed["eq:" + it.id] = {hidden: true}; continue; }
    placed["eq:" + it.id] = {x: band.x, y, variant: vi}; y += it.variants[vi].h + 8;
  }
  ov.render(fs, placed, {cls, band});
  return picks;
}
window.__eqt = {ov, events, show, fit, setSpec: s => { spec = {...spec, ...s}; }, ready: true};
</script></body></html>`);
  const srv = await serve({dir: join(REPO, "docs/tng50"), page});
  for (const [W, H, cls] of [[1440, 900, "desktop"], [390, 844, "phone portrait"], [320, 568, "narrow"]]) {
    const P = await launch({width: W, height: H, reducedMotion: false});
    try {
      await P.viewport(W, H, W < 500);
      await P.goto(srv.base);
      ok(await P.waitFor("window.__eqt && window.__eqt.ready", 30000) >= 0, `${W}: test page ready`);
      const frames = [
        ["E2-B5", [{id: "E2", anchor: {kind: "cell", ref: 125}}], "HI"],
        ["E1+E3", [{id: "E1"}, {id: "E3"}], "OVI"],
        ["chain", [{id: "E1"}, {id: "E2"}, {id: "E3"}], "OVI"],
        ["chain-entering", [{id: "E1", phase: 0}, {id: "E2", phase: -0.5}, {id: "E3", phase: -0.99}], "OVI"],
        ["E3b+E4", [{id: "E3b"}, {id: "E4"}], "OVI"],
        ["E5+E6", [{id: "E5", anchor: {kind: "totals"}}, {id: "E6"}], "HI"],
        ["E7+E8", [{id: "E7"}, {id: "E8"}], "OVI", {chi2nu: 1.04}],
        ["E5-nolive+E8-nofit", [{id: "E5"}, {id: "E8"}], "OVI"],
      ];
      for (const [name, eqs, lead, live] of frames) {
        await P.eval(`(window.__eqt.show(${JSON.stringify(eqs)}, ${JSON.stringify(cls)}, 0.5, ${JSON.stringify(lead)}, ${JSON.stringify(live || null)}), 1)`);
        await P.eval("document.fonts.ready.then(() => 1)"); await sleep(150);
        // the page calls equations() + solve every frame; a box first measured before the KaTeX faces load is re-placed on
        // the next frame (wrapped boxes now shrink to their content, so their width depends on the faces)
        await P.eval(`(window.__eqt.show(${JSON.stringify(eqs)}, ${JSON.stringify(cls)}, 0.5, ${JSON.stringify(lead)}, ${JSON.stringify(live || null)}), 1)`);
        await sleep(60);
        const r = await P.fn(`
          const declared = new Set([...document.fonts].map(f => f.family.replace(/"/g, "") + "|" + (f.weight === "700" || f.weight === "bold" ? "bold" : "normal") + "|" + f.style));
          const bad = [], boxes = [...document.querySelectorAll(".eqbox:not([hidden])")];
          for (const b of boxes) for (const w = document.createTreeWalker(b, NodeFilter.SHOW_TEXT); w.nextNode();) {
            const n = w.currentNode; if (!n.textContent.trim() || n.parentElement.closest(".eq-pin,.eq-step")) continue;
            const cs = getComputedStyle(n.parentElement), fam = cs.fontFamily.split(",")[0].replace(/"/g, "").trim();
            if (!fam.startsWith("KaTeX")) { if (n.parentElement.closest(".katex")) bad.push(fam + ":" + n.textContent); continue; }
            const k = fam + "|" + (+cs.fontWeight >= 600 ? "bold" : "normal") + "|" + cs.fontStyle;
            if (!declared.has(k)) bad.push(k + ":" + n.textContent);
          }
          const failed = [...document.fonts].filter(f => f.status === "error").map(f => f.family);
          const prox = [...document.querySelectorAll(".eqbox:not([hidden]) .eq-proxy")].map(p => { const r = p.getBoundingClientRect(), b = p.closest(".eqbox").getBoundingClientRect();
            const row = p.dataset.term && p.closest(".eqbox").querySelector('.eq-val [data-term="' + p.dataset.term + '"]');
            return {geo: [r.left, r.right, r.top, r.bottom, b.left, b.right, b.top, b.bottom].map(x => x.toFixed(1)).join(",") + " style " + p.style.top + "/" + p.style.height + " box " + p.closest(".eqbox").offsetHeight + " " + p.closest(".eqbox").dataset.mode, term: p.dataset.term, eq: p.dataset.eq, role: p.getAttribute("role"), h: r.height, w: r.width, inside: r.left >= b.left - 0.5 && r.right <= b.right + 0.5 && r.top >= b.top - 0.5 && r.bottom <= b.bottom + 0.5,
              valRow: !!row, noscrub: p.hasAttribute("data-noscrub"), aria: ["aria-valuemin", "aria-valuemax", "aria-valuenow", "aria-valuetext"].every(a => p.hasAttribute(a)),
              name: (p.getAttribute("aria-label") || "").trim()}; });
          const values = [...document.querySelectorAll(".eqbox:not([hidden]) .eq-val:not([hidden]) [data-part=m]")].filter(n => n.style.display !== "none").map(n => n.textContent);
          const over = []; for (let i = 0; i < boxes.length; i++) for (let j = i + 1; j < boxes.length; j++) { const a = boxes[i].getBoundingClientRect(), c = boxes[j].getBoundingClientRect();
            if (a.left < c.right && c.left < a.right && a.top < c.bottom && c.top < a.bottom) over.push(i + "-" + j); }
          const outside = boxes.filter(b => { const r = b.getBoundingClientRect(); return r.right > innerWidth + 0.5 || r.left < -0.5; }).map(b => { const r = b.getBoundingClientRect(); return b.dataset.eq + ":" + b.dataset.mode + " x " + r.left.toFixed(1) + "-" + r.right.toFixed(1) + " w " + b.style.width + "/" + b.offsetWidth; }).join(" ; ");
          const modes = boxes.map(b => b.dataset.eq + ":" + b.dataset.mode);
          const small = [];
          for (const b of boxes) for (const w = document.createTreeWalker(b, NodeFilter.SHOW_TEXT); w.nextNode();) {
            // KaTeX's .vlist-s struts hold a zero-width space at 1 px: not text anyone reads (U_qa's G2 should skip them too)
            const el = w.currentNode.parentElement; if (!/[^\s\u200b]/.test(w.currentNode.textContent) || !el.getClientRects().length) continue;
            const fsz = parseFloat(getComputedStyle(el).fontSize); if (fsz < 12) small.push(fsz.toFixed(1) + ":" + w.currentNode.textContent);
          }
          return {small: small.slice(0, 6), modes, bad: bad.slice(0, 5), failed, prox, values, n: boxes.length, labels: boxes.map(b => b.getAttribute("aria-label")), over, outside};`);
        ok(!r.failed.length, `${W} ${name}: fonts load (${r.failed.join(",")})`);
        ok(!r.bad.length, `${W} ${name}: every glyph uses a vendored KaTeX face (${r.bad.join(" ; ")})`);
        ok(r.n >= 1, `${W} ${name}: equation boxes shown (${r.n})`);
        ok(!r.values.includes("0.00") && !r.values.includes("…"), `${W} ${name}: every bound number filled (${r.values.join(" ")})`);
        ok(r.labels.every(l => l && l.length > 40 && !/\{\{/.test(l)), `${W} ${name}: spoken aria-label filled`);
        ok(!r.small.length, `${W} ${name}: no visible equation text below 12 CSS px (${r.small.join(" ; ")})`);
        if (name.includes("nolive")) ok(r.modes.slice().sort().join() === (W < 500 ? "E5:symbolic" : "E5:symbolic,E8:symbolic"), `${W} ${name}: no live readout -> symbolic form, no placeholder (${r.modes})`);
        else ok(r.modes.every(m => m.endsWith(W < 500 ? ":chip" : ":value")), `${W} ${name}: ${W < 500 ? "phone chip" : "value-first"} view (${r.modes})`);
        for (const p of r.prox) {
          ok(p.inside, `${W} ${name}: proxy ${p.eq}.${p.term} inside its box (proxy l,r,t,b / box l,r,t,b: ${p.geo})`);
          ok(p.noscrub, `${W} ${name}: proxy ${p.eq}.${p.term} is data-noscrub`);
          ok(p.h >= 24 && p.w >= 20, `${W} ${name}: proxy ${p.eq}.${p.term} hit area ${p.w.toFixed(0)}x${p.h.toFixed(0)}`);
          ok(p.name.length > 0, `${W} ${name}: proxy ${p.eq}.${p.term} has an accessible name (axe aria-input-field-name)`);
          if (p.role === "slider") { ok(p.aria, `${W} ${name}: slider ${p.eq}.${p.term} has aria-valuemin/max/now/text`); if (p.valRow) ok(p.h >= 44, `${W} ${name}: value-row slider ${p.eq}.${p.term} >= 44 px tall (${p.h.toFixed(1)})`); }
        }
        ok(!r.over.length && !r.outside, `${W} ${name}: test placement has no overlap and nothing off screen (${r.over} ${r.outside})`);
        { // review1_beauty M4: a wrapped box is as wide as its widest line (no empty scrim beside the content)
          const sl = await P.fn(`return [...document.querySelectorAll(".eqbox.wrap:not([hidden])")].map(b => { const q = b.getBoundingClientRect(); let right = 0;
            for (const n of b.querySelectorAll(".katex .base, .eq-pin, .eq-link svg")) { const r = n.getBoundingClientRect(); if (r.width && r.height) right = Math.max(right, r.right); }
            return {eq: b.dataset.eq, slack: q.right - right - parseFloat(getComputedStyle(b).paddingRight)}; }).filter(o => o.slack > 4).map(o => o.eq + " " + o.slack.toFixed(1));`);
          ok(!sl.length, `${W} ${name}: wrapped boxes shrink to their content (slack <= 4 px) (${sl.join(", ")})`);
        }
        if (shotsDir) await P.shot(join(shotsDir, `eq_${W}_${name}.png`));
      }
      // G2 at the shell's smallest equation size (layoutclass typeScale floor 15 px): the box clamps to MIN_EQ_PX, so no
      // glyph (scripts included) drops below 12 px; then the solver's value-line-only variant (variants[1]) switches to chip
      {
        const g2 = await P.fn(`document.documentElement.style.setProperty("--eq-size", "15px");
          const items = window.__eqt.show([{id: "E2", anchor: {kind: "cell", ref: 125}}, {id: "E3"}], ${JSON.stringify(W < 500 ? cls : "desktop")}, 0.5, "HI");
          await document.fonts.ready; await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
          const small = [];
          for (const b of document.querySelectorAll(".eqbox:not([hidden])")) for (const w = document.createTreeWalker(b, NodeFilter.SHOW_TEXT); w.nextNode();) {
            const el = w.currentNode.parentElement; if (!/[^\\s\\u200b]/.test(w.currentNode.textContent) || !el.getClientRects().length) continue;
            const f = parseFloat(getComputedStyle(el).fontSize); if (f < 12) small.push(f.toFixed(1) + ":" + w.currentNode.textContent);
          }
          const box = document.querySelector(".eqbox:not([hidden])");
          return {small: small.slice(0, 5), px: parseFloat(getComputedStyle(box).fontSize), fonts: items.map(i => i.size.font), variants: items.map(i => i.variants.length)};`);
        if (shotsDir) await P.shot(join(shotsDir, `eq_${W}_size15.png`));
        ok(!g2.small.length, `${W}: --eq-size 15px: no equation glyph below 12 px (${g2.small.join(" ; ")})`);
        ok(g2.px >= 16.5 - 1e-6, `${W}: equation box clamps to >= 16.5 px (${g2.px})`);
        ok(g2.fonts.every(f => f >= 12), `${W}: reported smallest glyph >= 12 px (${g2.fonts})`);
        if (W >= 500) {
          ok(g2.variants.every(n => n >= 2), `${W}: value-first boxes offer smaller variants (value line, headline) (${g2.variants})`);
          const cv = await P.fn(`const items = window.__eqt.ov.equations({p: .5, beat: {i: 1, u: .5}, cell: {idx: 125}, eqs: [{id: "E2", anchor: {kind: "cell", ref: 125}}], spec: {lead: "HI", R: 15000, sn: 10}}, {cls: "desktop"});
            const it = items[0];
            window.__eqt.ov.render({p: .5, beat: {i: 1, u: .5}, cell: {idx: 125}, eqs: [{id: "E2", anchor: {kind: "cell", ref: 125}}], spec: {lead: "HI", R: 15000, sn: 10}}, {byId: {"eq:E2": {id: "eq:E2", x: 30, y: 30, variant: 1}}}, {cls: "desktop"});
            await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
            const el = document.querySelector('.eqbox[data-eq="E2"]');
            const after = window.__eqt.ov.equations({p: .5, beat: {i: 1, u: .5}, cell: {idx: 125}, eqs: [{id: "E2", anchor: {kind: "cell", ref: 125}}], spec: {lead: "HI", R: 15000, sn: 10}}, {cls: "desktop"})[0];
            const r = el.getBoundingClientRect();
            return {mode: el.dataset.mode, h: r.height, w: r.width, v1: it.variants[1], nat: after.size, natBefore: it.size};`);
          if (shotsDir) await P.shot(join(shotsDir, `eq_${W}_chipvariant.png`));
          ok(cv.mode === "chip", `${W}: solver variant 1 switches the box to the value line (${cv.mode})`);
          ok(cv.v1 && Math.abs(cv.h - cv.v1.h) <= 1.5 && cv.w <= cv.v1.w + 1.5, `${W}: chip box matches variants[1] (${cv.w.toFixed(1)}x${cv.h.toFixed(1)} vs ${cv.v1 && cv.v1.w}x${cv.v1 && cv.v1.h})`);
          ok(JSON.stringify(cv.nat) === JSON.stringify(cv.natBefore), `${W}: the natural size stays reported while the chip variant is shown`);
        }
        await P.eval(`document.documentElement.style.setProperty("--eq-size", innerWidth < 500 ? "18px" : "22px"), 1`);
      }
      // the shell's real eq band (js/ui/layoutclass.js computeBands at this viewport): every frame lands inside it with a
      // variant the solver would pick, keeps the 12 px floor, and shows the bound numbers
      {
        const {computeBands, typeScale} = await import(join(ROOT, "js/ui/layoutclass.js"));
        const lc = W <= 320 ? "narrow" : W < 500 ? "phonePortrait" : "desktop";
        const band = computeBands(lc, W, H, {dock: "strip", textSide: "left", insets: {top: 0, right: 0, bottom: 0, left: 0}}).eq;
        const px = typeScale(lc, W, H).eq;
        await P.eval(`document.documentElement.style.setProperty("--eq-size", "${px}px"), 1`);
        const bandFrames = [["E2-B5", [{id: "E2", anchor: {kind: "cell", ref: 125}}], "HI"], ["E3-B10", [{id: "E3", anchor: {kind: "cell", ref: 492}}], "HI"],
          ["E4-B6", [{id: "E4"}], "OVI"], ["chain-B7b", [{id: "E1", phase: 0}, {id: "E2", phase: 0}, {id: "E3", phase: 0}], "OVI"], ["E6+E7", [{id: "E6"}, {id: "E7"}], "OVI"],
          ...(W < 500 ? [["E8-nofit-B13", [{id: "E8"}], "OVI"], ["chain-E2-step", [{id: "E1", phase: 0.9}, {id: "E2", phase: 0}, {id: "E3", phase: -0.9}], "OVI"]] : [])];
        for (const [name, eqs, lead] of bandFrames) {
          const picks = await P.eval(`window.__eqt.fit(${JSON.stringify(eqs)}, ${JSON.stringify(lc)}, ${JSON.stringify(band)}, ${JSON.stringify(lead)})`);
          await P.eval("document.fonts.ready.then(() => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r))))"); await sleep(120);
          const r = await P.fn(`const band = ${JSON.stringify(band)}; const out = [], small = [];
            for (const b of document.querySelectorAll(".eqbox:not([hidden])")) { const q = b.getBoundingClientRect();
              out.push({eq: b.dataset.eq, mode: b.dataset.mode, x: q.left, y: q.top, w: q.width, h: q.height,
                inside: q.left >= band.x - 0.5 && q.top >= band.y - 0.5 && q.right <= band.x + band.w + 0.5 && q.bottom <= band.y + band.h + 0.5,
                prox: [...b.querySelectorAll(".eq-proxy")].map(x => { const pr = x.getBoundingClientRect(); return {t: x.dataset.term, role: x.getAttribute("role"), ok: pr.width >= 20 && pr.height >= 24 && pr.left >= q.left - 0.5 && pr.right <= q.right + 0.5 && pr.top >= q.top - 0.5 && pr.bottom <= q.bottom + 0.5}; }),
                nums: [...b.querySelectorAll("[data-part=m],[data-part=e]")].filter(n => n.getClientRects().length && n.style.display !== "none").map(n => n.textContent)});
              for (const w = document.createTreeWalker(b, NodeFilter.SHOW_TEXT); w.nextNode();) { const el = w.currentNode.parentElement;
                if (!/[^\s\u200b]/.test(w.currentNode.textContent) || !el.getClientRects().length) continue;
                const f = parseFloat(getComputedStyle(el).fontSize); if (f < 12) small.push(f.toFixed(1)); } }
            return {out, small};`);
          ok(picks.every(p => p.vi >= 0), `${W} band ${name}: every item has a variant that fits the eq band ${Math.round(band.w)}x${Math.round(band.h)} (${JSON.stringify(picks)})`);
          ok(r.out.length >= 1 && r.out.every(o => o.inside), `${W} band ${name}: boxes inside the band (${r.out.map(o => o.eq + ":" + o.mode + " " + o.w.toFixed(0) + "x" + o.h.toFixed(0)).join(", ")})`);
          ok(r.out.every(o => o.nums.length >= 1 && !o.nums.includes("0.00")), `${W} band ${name}: bound numbers shown (${r.out.map(o => o.nums.join(" ")).join(" | ")})`);
          ok(!r.small.length, `${W} band ${name}: no glyph below 12 px (${r.small.slice(0, 4)})`);
          ok(r.out.every(o => o.prox.length >= 1 && o.prox.every(x => x.ok)), `${W} band ${name}: term controls present, inside their box, >= 20x24 (${r.out.map(o => o.prox.map(x => x.t + (x.ok ? "" : "!")).join(",")).join(" | ")})`);
          if (name === "E2-B5") ok(r.out[0].prox.some(x => x.t === "T" && x.role === "slider"), `${W} band E2: the T slider survives the variant (${r.out[0].prox.map(x => x.t + ":" + x.role)})`);
          // review2_ux_overlap M1: before the fit reports chi2, E8 is symbolic; where the symbolic form does not fit, the N_a
          // headline (AOD fallback) shows instead of hiding the equation
          if (name === "E8-nofit-B13" && W < 500) ok(r.out.length === 1 && r.out[0].mode === "short" && r.out[0].nums.length >= 1, `${W} band E8 without a fit: N_a short form (${r.out.map(o => o.mode + " " + o.nums.join(" "))})`);
          if (name === "chain-E2-step") ok(picks.length === 1 && picks[0].id === "E2" && picks.some(p => p.keys.some(k => /^shortc:/.test(k))), `${W} band chain: the E2 step offers the b <- T row (${JSON.stringify(picks)})`);
          if (shotsDir) await P.shot(join(shotsDir, `eq_${W}_band_${name}.png`));
        }
        await P.eval(`document.documentElement.style.setProperty("--eq-size", innerWidth < 500 ? "18px" : "22px"), 1`);
      }
      // keyboard on E2 T (cell 263, O VI): ArrowRight -> ghost with T * 10^0.025; Escape -> null
      await P.eval(`(window.__eqt.show([{id: "E2", anchor: {kind: "cell", ref: 263}}], ${JSON.stringify(cls)}, 0.5, "OVI"), window.__eqt.events.length = 0, 1)`);
      await sleep(100);
      const kb = await P.fn(`const p = document.querySelector('.eqbox:not([hidden]) .eq-proxy[data-term="T"]'); if (!p) return null; p.focus();
        const v0 = +p.getAttribute("aria-valuenow");
        p.dispatchEvent(new KeyboardEvent("keydown", {key: "ArrowRight", bubbles: true}));
        const v1 = +p.getAttribute("aria-valuenow"); const g = window.__eqt.events.filter(e => e.t === "override" && e.p.key === "ghost").pop();
        const named = window.__eqt.events.filter(e => e.t === "override" && e.p.key === "T263").pop();
        const hover = window.__eqt.events.find(e => e.t === "hover" && e.p && e.p.term === "T");
        const shown = [...document.querySelectorAll('.eqbox:not([hidden]) [data-v="T"][data-part="m"]')].map(n => n.textContent);
        p.dispatchEvent(new KeyboardEvent("keydown", {key: "Escape", bubbles: true}));
        const g2 = window.__eqt.events.filter(e => e.t === "override" && e.p.key === "ghost").pop();
        return {role: p.getAttribute("role"), v0, v1, gT: g && g.p.value && g.p.value.cell.T, named: named && named.p.value, hover: !!hover, cleared: g2 && g2.p.value === null, shown, h: p.getBoundingClientRect().height};`);
      ok(kb && kb.role === "slider", `${W}: E2 T term is role=slider`);
      if (kb) {
        near(kb.v1 - kb.v0, 0.025, 1e-6, `${W}: ArrowRight steps log T by 0.025`);
        near(kb.gT / T263, 10 ** 0.025, 1e-6, `${W}: ArrowRight emits a ghost with T x 10^0.025`);
        ok(kb.named && Math.abs(kb.named / kb.gT - 1) < 1e-9, `${W}: the T263 named override follows the ghost`);
        ok(kb.hover, `${W}: focusing a term emits hover {term: T}`);
        ok(kb.cleared, `${W}: Escape clears the ghost`);
        ok(kb.h >= 44, `${W}: E2 T hit area >= 44 px (${kb.h.toFixed(1)})`);
      }
      // mouse drag on E3 N (cell 492, H I): ghosts while dragging, spring back to null after release; Pin keeps it
      await P.eval(`(window.__eqt.show([{id: "E3", anchor: {kind: "cell", ref: 492}}], ${JSON.stringify(cls)}, 0.5, "HI"), window.__eqt.events.length = 0, 1)`);
      await sleep(150);
      const c = await P.fn(`const p = document.querySelector('.eqbox:not([hidden]) .eq-proxy[data-term="N"]'); const r = p.getBoundingClientRect(); return {x: r.left + r.width / 2, y: r.top + r.height / 2};`);
      await P.drag(c.x, c.y, c.x + 120, c.y, 10);
      const mid = await P.fn(`const g = window.__eqt.events.filter(e => e.t === "override" && e.p.key === "ghost"); return {n: g.length, maxN: Math.max(...g.filter(e => e.p.value).map(e => e.p.value.cell.logN)), n492: window.__eqt.events.some(e => e.t === "override" && e.p.key === "N492")};`);
      ok(mid.n >= 3 && mid.maxN > data.ions.HI.cells.logN[492] + 0.5, `${W}: dragging N emits ghosts (n ${mid.n}, max log N ${mid.maxN.toFixed(2)})`);
      ok(mid.n492, `${W}: dragging N on cell 492 emits the N492 override`);
      await sleep(1500);
      const end = await P.fn(`const g = window.__eqt.events.filter(e => e.t === "override" && e.p.key === "ghost"); return {last: g[g.length - 1].p.value, state: window.__eqt.ov.state().ghost};`);
      ok(end.last === null && end.state === null, `${W}: ghost springs back to null after release`);
      await P.drag(c.x, c.y, c.x + 80, c.y, 6);
      await P.fn(`document.querySelector('.eqbox:not([hidden]) .eq-pin').click(); return 1;`);
      await sleep(1200);
      const pin = await P.fn(`return {ghost: !!window.__eqt.ov.state().ghost, pinned: window.__eqt.ov.state().pinned, btn: document.querySelector('.eqbox:not([hidden]) .eq-pin').getAttribute("aria-pressed")};`);
      ok(pin.ghost && pin.pinned && pin.btn === "true", `${W}: Pin keeps the ghost`);
      if (shotsDir) await P.shot(join(shotsDir, `eq_${W}_ghost_pinned.png`));
      await P.fn(`document.querySelector('.eqbox:not([hidden]) .eq-pin').click(); return 1;`);
      await sleep(1200);
      ok(await P.eval("window.__eqt.ov.state().ghost === null"), `${W}: unpinning springs the ghost back`);
      // R term (E6): drag emits an R override and no ghost
      await P.eval(`(window.__eqt.show([{id: "E6"}], ${JSON.stringify(cls)}, 0.5, "OVI"), window.__eqt.events.length = 0, 1)`);
      await sleep(150);
      const rr = await P.fn(`const p = document.querySelector('.eqbox:not([hidden]) .eq-proxy[data-term="R"]'); if (!p) return null; p.focus();
        p.dispatchEvent(new KeyboardEvent("keydown", {key: "PageDown", bubbles: true}));
        const o = window.__eqt.events.filter(e => e.t === "override"); return {keys: o.map(e => e.p.key), R: o.length ? o[o.length - 1].p.value : null, role: p.getAttribute("role")};`);
      ok(rr && rr.role === "slider" && rr.keys.every(k => k === "R") && Math.abs(rr.R / (15000 * 10 ** -0.25) - 1) < 1e-6, `${W}: E6 R term emits the R override (${rr && rr.keys} ${rr && rr.R})`);
      // G4 (S0 freeze): bound values must hold >= 4.5:1 (text) and >= 3:1 (value underlines, dip glyph) whatever volume is
      // behind the box. Worst case: a pure white page under the box scrim. Contrast is computed from computed styles
      // (colour x ancestor opacity, composited over the box background over white), for every visible text leaf.
      await P.fn(`document.body.style.background = "#ffffff"; const s = document.createElement("style"); s.id = "g4-nt";
        s.textContent = ".eqbox .eqt{transition:none!important}"; document.head.appendChild(s); return 1;`);   // read end states, not mid-transition
      const g4frames = [["chain", [{id: "E1"}, {id: "E2"}, {id: "E3"}], "OVI"], ["E2-B5", [{id: "E2", anchor: {kind: "cell", ref: 125}}], "HI"],
                        ["E5+E6", [{id: "E5", anchor: {kind: "totals"}}, {id: "E6"}], "HI"], ["E7+E8", [{id: "E7"}, {id: "E8"}], "OVI", {chi2nu: 1.04}]];
      let g4worst = {text: 99, gfx: 99, where: ""}, g4n = 0;
      for (const [name, eqs, lead, live] of g4frames) {
        await P.eval(`(window.__eqt.show(${JSON.stringify(eqs)}, ${JSON.stringify(cls)}, 0.5, ${JSON.stringify(lead)}, ${JSON.stringify(live || null)}), 1)`);
        await sleep(700);
        const r = await P.fn(`
          const rgba = s => { const m = s.match(/rgba?\\(([^)]+)\\)/); if (!m) return null; const v = m[1].split(/[ ,\\/]+/).filter(Boolean).map(Number); return [v[0], v[1], v[2], v[3] == null ? 1 : v[3]]; };
          const lin = c => { c /= 255; return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; };
          const L = c => 0.2126 * lin(c[0]) + 0.7152 * lin(c[1]) + 0.0722 * lin(c[2]);
          const over = (f, b, a) => [0, 1, 2].map(i => f[i] * a + b[i] * (1 - a));
          const cr = (a, b) => { const x = L(a), y = L(b); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05); };
          const out = {text: 99, gfx: 99, where: "", n: 0};
          for (const dimPass of [false, true]) for (const box of document.querySelectorAll(".eqbox:not([hidden])")) {
            box.classList.toggle("dim", dimPass);        // pass 2: the hover/focus dim state (other terms fade)
            box.querySelectorAll(".eqt").forEach((e, i) => { e.classList.toggle("hl", dimPass ? i % 2 === 0 : false); e.classList.toggle("hover", dimPass && i % 2 === 1); });
            const bs = getComputedStyle(box), bb = rgba(bs.backgroundColor), page = [255, 255, 255];
            const bg = over(bb, page, bb[3] * (+bs.opacity || 1));
            const opa = el => { let o = 1; for (let e = el; e && e !== box.parentNode; e = e.parentElement) o *= +getComputedStyle(e).opacity; return o; };
            const walker = document.createTreeWalker(box, NodeFilter.SHOW_TEXT);
            for (let t = walker.nextNode(); t; t = walker.nextNode()) {
              const el = t.parentElement; if (!t.textContent.trim() || el.closest(".eq-sr,.eq-pin,[hidden]")) continue;
              const r = el.getBoundingClientRect(); if (!r.width || !r.height || getComputedStyle(el).visibility === "hidden") continue;
              if (el.closest(".eq-dipline")) continue;                 // graphic (dip glyph), checked below at 3:1
              const chain = []; for (let e = el; e && e !== box; e = e.parentElement) chain.unshift(e);
              let lbg = bg; for (const e of chain) { const b = rgba(getComputedStyle(e).backgroundColor); if (b && b[3] > 0) lbg = over(b, lbg, b[3]); }   // hl / hover tints
              const c = rgba(getComputedStyle(el).color), a = c[3] * opa(el), col = over(c, lbg, a), k = cr(col, lbg); out.n++;
              if (k < out.text) { out.text = k; out.where = ((box.querySelector("[data-eqid]") || box).dataset.eqid || "?") + ":" + getComputedStyle(el).color + "@" + a.toFixed(2) + ":" + JSON.stringify(bg.map(Math.round)) + ":" + (el.className || el.tagName) + ":" + t.textContent.trim().slice(0, 12); }
            }
            for (const el of box.querySelectorAll(".eqv, [data-part=p].pow, .eq-dipline")) {
              const r = el.getBoundingClientRect(); if (!r.width || !r.height) continue;
              const cs = getComputedStyle(el), sh = cs.boxShadow.match(/rgba?\\([^)]+\\)/), src = el.classList.contains("eq-dipline") ? cs.color : sh && sh[0];
              if (!src || cs.boxShadow === "none" && !el.classList.contains("eq-dipline")) continue;
              const c = rgba(src); if (!c) continue;
              const k = cr(over(c, bg, c[3] * opa(el)), bg); if (k < out.gfx) out.gfx = k;
            }
          }
          for (const box of document.querySelectorAll(".eqbox")) box.classList.remove("dim");
          return out;`);
        g4n += r.n;
        if (r.text < g4worst.text) g4worst = {...g4worst, text: r.text, where: name + " " + r.where};
        if (r.gfx < g4worst.gfx) g4worst.gfx = r.gfx;
        if (shotsDir && name === "chain") await P.shot(join(shotsDir, `eq_${W}_g4_white_${name}.png`));
      }
      ok(g4n > 20 && g4worst.text >= 4.5, `${W}: G4 every equation text leaf >= 4.5:1 over a white volume (worst ${g4worst.text.toFixed(2)} at ${g4worst.where}; ${g4n} leaves)`);
      ok(g4worst.gfx >= 3, `${W}: G4 value underlines and dip glyph >= 3:1 over a white volume (worst ${g4worst.gfx.toFixed(2)})`);
      await P.fn(`document.body.style.background = ""; document.getElementById("g4-nt").remove(); document.querySelectorAll(".eqbox .eqt").forEach(e => e.classList.remove("hl", "hover")); return 1;`);
      // per-frame cost (S0: DOM layer <= 1.5 ms, U_eq's share well under it): equations() + render() over a scrub through the
      // chain beat (rows entering, term reveal) and a two-equation beat, after the boxes exist (steady state, as in flight)
      const perf = await P.fn(`const T = [], s = window.__eqt.show;
        const fr = [[[{id: "E1"}, {id: "E2"}, {id: "E3"}], "OVI"], [[{id: "E2", anchor: {kind: "cell", ref: 125}}, {id: "E3"}], "HI"]];
        for (const [e, lead] of fr) for (let i = 0; i < 20; i++) s(e, ${JSON.stringify(cls)}, i / 20, lead);
        for (const [e, lead] of fr) for (let i = 0; i < 150; i++) { const t0 = performance.now(); s(e.map(x => ({...x, phase: -1 + (i % 50) / 25})), ${JSON.stringify(cls)}, (i % 50) / 50, lead); T.push(performance.now() - t0); }
        T.sort((a, b) => a - b); return {p50: T[T.length >> 1], p95: T[Math.floor(T.length * 0.95)]};`);
      ok(perf.p95 < 1.0, `${W}: equations()+render() per frame p50 ${perf.p50.toFixed(3)} ms, p95 ${perf.p95.toFixed(3)} ms (< 1 ms)`);
      console.log(`# ${W} eq frame cost p50 ${perf.p50.toFixed(3)} ms p95 ${perf.p95.toFixed(3)} ms`);
      ok(!P.requests.some(u => /katex(\.min)?\.m?js/.test(u)), `${W}: no KaTeX JavaScript requested`);
      ok(!P.exceptions.length && !P.consoleErrors.length, `${W}: no exception or console error (${[...P.exceptions, ...P.consoleErrors].join(" | ").slice(0, 300)})`);
    } finally { await P.close(); }
  }
  await srv.close(); rmSync(tmp, {recursive: true, force: true});
}
